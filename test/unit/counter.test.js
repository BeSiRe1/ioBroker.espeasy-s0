'use strict';

const assert = require('node:assert/strict');
const {
    createState,
    processReading,
    applyPulseInterval,
    decay,
    totalKWh,
    applyReading,
    shouldApplyConfigReading,
} = require('../../lib/counter');

const cfg = { impulsesPerKWh: 800, maxPowerKW: 50, zeroPowerAfter: 300 };
const T0 = 1_700_000_000_000;

/** feed a sequence of readings, 10 s apart */
function run(readings, state = createState(), start = T0, step = 10_000) {
    const results = [];
    readings.forEach((r, i) => {
        const res = processReading(state, r, cfg, start + i * step);
        state = res.state;
        results.push(res);
    });
    return { state, results };
}

describe('counter', () => {
    it('first reading only sets the baseline', () => {
        const { state, results } = run([{ total: 745227, uptimeMs: 1000 }]);
        assert.equal(results[0].baseline, true);
        assert.equal(state.pulses, 0);
        assert.equal(state.rawTotal, 745227);
    });

    it('adds differences between readings', () => {
        const { state } = run([
            { total: 100, uptimeMs: 1000 },
            { total: 110, uptimeMs: 11000 },
            { total: 125, uptimeMs: 21000 },
        ]);
        assert.equal(state.pulses, 25);
    });

    it('keeps counting when the ESP restarts at 0 (counter reset)', () => {
        const { state, results } = run([
            { total: 5000, uptimeMs: 999_000 },
            { total: 5010, uptimeMs: 1_009_000 },
            { total: 3, uptimeMs: 5000 }, // power loss -> 3 pulses since boot
            { total: 8, uptimeMs: 15000 },
        ]);
        assert.equal(results[2].counterReset, true);
        assert.equal(results[2].reboot, true);
        assert.equal(state.pulses, 10 + 3 + 5);
        assert.equal(state.rebootCount, 1);
        assert.equal(state.counterResetCount, 1);
    });

    it('handles soft reboot where ESPEasy kept the total (RTC)', () => {
        const { state, results } = run([
            { total: 5000, uptimeMs: 999_000 },
            { total: 5004, uptimeMs: 2000 },
        ]);
        assert.equal(results[1].reboot, true);
        assert.equal(results[1].counterReset, false);
        assert.equal(state.pulses, 4);
    });

    it('rejects implausible jumps and re-bases', () => {
        // 50 kW * 800 imp/kWh over 10 s = ~111 pulses max
        const { state, results } = run([
            { total: 100, uptimeMs: 1000 },
            { total: 100100, uptimeMs: 11000 },
            { total: 100105, uptimeMs: 21000 },
        ]);
        assert.equal(results[1].rejected, true);
        assert.equal(state.rejectedCount, 1);
        assert.equal(state.pulses, 5);
    });

    it('accepts pulses accumulated while the adapter was stopped', () => {
        let { state } = run([{ total: 100, uptimeMs: 1000 }]);
        // adapter offline for 1 hour, 4 kW -> 3200 pulses
        const res = processReading(state, { total: 3300, uptimeMs: 3_601_000 }, cfg, T0 + 3_600_000);
        assert.equal(res.rejected, false);
        assert.equal(res.state.pulses, 3200);
    });

    it('rejects invalid values', () => {
        const res = processReading(createState(), { total: NaN }, cfg, T0);
        assert.equal(res.rejected, true);
    });

    it('calculates power from ESPEasy Time', () => {
        // 450 ms between pulses at 800 imp/kWh = 10 kW
        const { state } = run([
            { total: 0, uptimeMs: 1000 },
            { total: 22, uptimeMs: 11000, timeMs: 450 },
        ]);
        assert.equal(state.powerW, 10000);
    });

    it('falls back to interval average without Time', () => {
        // 20 pulses in 10 s at 800 imp/kWh = 0.025 kWh in 10 s = 9 kW
        const { state } = run([
            { total: 0, uptimeMs: 1000 },
            { total: 20, uptimeMs: 11000 },
        ]);
        assert.equal(state.powerW, 9000);
    });

    it('uses the time since the previous pulse for sparse single pulses', () => {
        // low load: one pulse every 4 minutes at 800 imp/kWh = 18.75 W
        let { state } = run([
            { total: 0, uptimeMs: 1000 },
            { total: 1, uptimeMs: 11000, timeMs: 0 },
        ]);
        const res = processReading(state, { total: 2, uptimeMs: 251000, timeMs: 0 }, cfg, T0 + 250_000);
        assert.equal(res.state.powerW, 18.8);
    });

    it('keeps the power until the next pulse is overdue', () => {
        // 7686 ms between pulses = 585.4 W; 5 s later (not overdue) still 585.4 W
        let { state } = run([
            { total: 0, uptimeMs: 1000 },
            { total: 1, uptimeMs: 11000, timeMs: 7686 },
        ]);
        let res = processReading(state, { total: 1, uptimeMs: 16000, timeMs: 0 }, cfg, T0 + 15_000);
        assert.equal(res.state.powerW, 585.5);
        // 15.4 s after the pulse (overdue): at most one pulse in 15.4 s
        res = processReading(res.state, { total: 1, uptimeMs: 26000, timeMs: 0 }, cfg, T0 + 25_400);
        assert.equal(res.state.powerW, 292.2);
    });

    it('ignores spurious pulse intervals (contact bounce)', () => {
        // 34 ms would be 132 kW > 50 kW max
        const { state, results } = run([
            { total: 0, uptimeMs: 1000 },
            { total: 2, uptimeMs: 11000, timeMs: 34 },
        ]);
        assert.equal(results[1].timeRejected, true);
        assert.ok(state.powerW < 2000, `power ${state.powerW}`);
    });

    describe('external pulse intervals (MQTT)', () => {
        it('sets the exact power from every interval', () => {
            const res = applyPulseInterval(createState(), 7686, T0, cfg);
            assert.equal(res.accepted, true);
            assert.equal(res.state.powerW, 585.5);
            assert.equal(res.state.lastPulseTs, T0);
        });

        it('rejects bounce intervals', () => {
            const res = applyPulseInterval(createState(), 34, T0, cfg);
            assert.equal(res.accepted, false);
            assert.equal(res.state.powerW, 0);
        });

        it('polling does not overwrite the MQTT power, only counts', () => {
            let { state } = run([{ total: 0, uptimeMs: 1000 }]);
            state = applyPulseInterval(state, 7686, T0 + 8000, cfg).state;
            const res = processReading(state, { total: 1, uptimeMs: 11000, timeMs: 0 }, cfg, T0 + 10_000, {
                externalTime: true,
            });
            assert.equal(res.state.pulses, 1);
            assert.equal(res.state.powerW, 585.5);
            assert.equal(res.state.lastPulseTs, T0 + 8000);
        });

        it('decay() lowers the power once the next pulse is overdue', () => {
            const state = applyPulseInterval(createState(), 7686, T0, cfg).state;
            assert.equal(decay(state, cfg, T0 + 5000).powerW, 585.5);
            assert.equal(decay(state, cfg, T0 + 30_000).powerW, 150);
            assert.equal(decay(state, cfg, T0 + 301_000).powerW, 0);
        });
    });

    it('applies the meter reading from the settings only once per value', () => {
        let state = createState();
        assert.equal(shouldApplyConfigReading(state, null), false); // empty field
        assert.equal(shouldApplyConfigReading(state, 70002), true); // first time
        state = applyReading({ ...state, appliedConfigReading: 70002 }, 70002);
        state = applyReading(state, 70010); // later corrected via setReading
        assert.equal(shouldApplyConfigReading(state, 70002), false); // restart, unchanged
        assert.equal(totalKWh(state, 800), 70010);
        assert.equal(shouldApplyConfigReading(state, 70020), true); // changed in settings
    });

    it('decays power when pulses stop and drops to 0 after timeout', () => {
        let { state } = run([
            { total: 0, uptimeMs: 1000 },
            { total: 22, uptimeMs: 11000, timeMs: 450 },
        ]);
        // 60 s without pulse -> at most one pulse per 60 s = 75 W
        let res = processReading(state, { total: 22, uptimeMs: 71000, timeMs: 450 }, cfg, T0 + 70_000);
        assert.equal(res.state.powerW, 75);
        res = processReading(res.state, { total: 22, uptimeMs: 400_000, timeMs: 450 }, cfg, T0 + 400_000);
        assert.equal(res.state.powerW, 0);
    });

    it('meter reading = reference + pulses / imp, set reading resets pulses', () => {
        let { state } = run([
            { total: 0, uptimeMs: 1000 },
            { total: 400, uptimeMs: 3_601_000 },
        ], createState(), T0, 3_600_000);
        assert.equal(totalKWh(state, 800), 0.5);
        state = applyReading(state, 70002);
        assert.equal(totalKWh(state, 800), 70002);
        const res = processReading(state, { total: 408, uptimeMs: 3_611_000 }, cfg, T0 + 3_610_000);
        assert.equal(totalKWh(res.state, 800), 70002.01);
    });
});
