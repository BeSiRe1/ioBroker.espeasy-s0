'use strict';

const assert = require('node:assert/strict');
const { createState, processReading, totalKWh, applyReading } = require('../../lib/counter');

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
