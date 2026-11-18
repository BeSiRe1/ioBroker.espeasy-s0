'use strict';

/**
 * Pure counting logic (no ioBroker dependency, fully unit-tested).
 *
 * The ESPEasy "Total" value is NOT trusted as meter reading: it can restart at 0
 * (power loss, re-flash, manual reset) and it can jump (noise). The adapter therefore
 * only adds the *differences* between two readings to its own pulse counter that is
 * persisted inside ioBroker.
 */

/** Energy of one pulse in Ws (J) = 3.6e6 / impulsesPerKWh. Power [W] = 3.6e9 / (imp * ms). */
const WS_PER_KWH_MS = 3.6e9;

/**
 * @returns {CounterState} a fresh counter state
 */
function createState() {
    return {
        rawTotal: null, // last "Total" value seen on the ESP
        uptimeMs: null, // last ESP uptime (to detect reboots)
        pollTs: null, // timestamp of last successful reading
        pulses: 0, // pulses counted since the reference reading
        referenceKWh: 0, // meter reading (kWh) at the time pulses was 0
        lastPulseTs: null, // timestamp of the last pulse (MQTT) or of the poll that saw it
        lastIntervalMs: null, // last measured/estimated time between two pulses
        appliedConfigReading: null, // meter reading from the instance settings already applied
        powerW: 0,
        rebootCount: 0,
        counterResetCount: 0,
        rejectedCount: 0,
    };
}

/**
 * @param {number} value value
 * @param {number} decimals decimals
 */
function round(value, decimals) {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
}

/**
 * Process one reading from the ESP.
 *
 * @param {CounterState} prev previous state (not modified)
 * @param {{total: number, timeMs?: number|null, uptimeMs?: number|null}} reading values from the ESP
 * @param {{impulsesPerKWh: number, maxPowerKW: number, zeroPowerAfter: number}} cfg configuration
 * @param {number} now current timestamp (ms)
 * @param {{externalTime?: boolean}} [opts] externalTime: power is fed by applyPulseInterval()
 */
function processReading(prev, reading, cfg, now, opts = {}) {
    const s = { ...prev };
    const result = {
        state: s,
        deltaPulses: 0,
        baseline: false,
        reboot: false,
        counterReset: false,
        rejected: false,
        timeRejected: false,
        reason: '',
    };

    const total = Number(reading.total);
    if (!Number.isFinite(total) || total < 0) {
        s.rejectedCount++;
        result.rejected = true;
        result.reason = `invalid total value "${reading.total}"`;
        return result;
    }
    const rawTotal = Math.round(total);
    const uptimeMs = Number.isFinite(reading.uptimeMs) ? Number(reading.uptimeMs) : null;

    // First reading ever: only remember the baseline, nothing to add yet.
    if (s.rawTotal === null || s.pollTs === null) {
        s.rawTotal = rawTotal;
        s.uptimeMs = uptimeMs;
        s.pollTs = now;
        result.baseline = true;
        return result;
    }

    result.reboot = uptimeMs !== null && s.uptimeMs !== null && uptimeMs < s.uptimeMs;
    if (result.reboot) {
        s.rebootCount++;
    }

    let delta;
    if (rawTotal < s.rawTotal) {
        // ESP counter started again from 0 -> everything it shows now is new
        result.counterReset = true;
        s.counterResetCount++;
        delta = rawTotal;
    } else {
        // also covers a soft reboot where ESPEasy kept the total in RTC memory
        delta = rawTotal - s.rawTotal;
    }

    const elapsedMs = Math.max(now - s.pollTs, 1000);
    const maxPulses = Math.ceil((cfg.maxPowerKW * cfg.impulsesPerKWh * elapsedMs) / 3.6e6) + 2;

    if (delta > maxPulses) {
        // implausible jump: skip it, but take the new value as baseline
        s.rejectedCount++;
        result.rejected = true;
        result.reason = `implausible jump of ${delta} pulses in ${Math.round(elapsedMs / 1000)} s (max ${maxPulses} at ${cfg.maxPowerKW} kW)`;
        delta = 0;
    }

    s.pulses += delta;
    result.deltaPulses = delta;

    // Power: with an external (MQTT) "Time" source every pulse interval arrives via
    // applyPulseInterval(); the poll then only lets the value decay.
    if (delta > 0 && !opts.externalTime) {
        const interval = validInterval(reading.timeMs, cfg);
        if (interval !== null) {
            setPulse(s, interval, now, cfg);
        } else {
            if (Number(reading.timeMs) > 0) {
                result.timeRejected = true;
            }
            // Fallback ("Time" was missed - it is only shown for one ESP task interval):
            // - several pulses in this poll: average over the poll interval
            // - a single pulse at low load: average since the previous pulse, otherwise one
            //   pulse that happens to fall into a 10 s poll would show a far too high power
            let windowMs = elapsedMs;
            if (delta === 1 && s.lastPulseTs !== null) {
                windowMs = Math.max(now - s.lastPulseTs, elapsedMs);
            }
            setPulse(s, windowMs / delta, now, cfg);
        }
    }
    s.powerW = decayedPower(s, cfg, now);

    s.rawTotal = rawTotal;
    s.uptimeMs = uptimeMs;
    s.pollTs = now;
    return result;
}

/**
 * @param {number|null|undefined} timeMs ms between two pulses
 * @param {{impulsesPerKWh: number, maxPowerKW: number}} cfg configuration
 * @returns {number|null} the interval if it is plausible, otherwise null
 */
function validInterval(timeMs, cfg) {
    const t = Number(timeMs);
    if (!Number.isFinite(t) || t <= 0) {
        return null;
    }
    // shorter than possible at max power -> spurious edge (e.g. contact bounce)
    return WS_PER_KWH_MS / (cfg.impulsesPerKWh * t) <= cfg.maxPowerKW * 1000 ? t : null;
}

/**
 * @param {CounterState} s state (modified)
 * @param {number} intervalMs ms between the last two pulses
 * @param {number} ts timestamp of the pulse
 * @param {{impulsesPerKWh: number, maxPowerKW: number}} cfg configuration
 */
function setPulse(s, intervalMs, ts, cfg) {
    const p = WS_PER_KWH_MS / (cfg.impulsesPerKWh * Math.max(intervalMs, 1));
    s.powerW = round(Math.min(p, cfg.maxPowerKW * 1000), 1);
    s.lastIntervalMs = intervalMs;
    s.lastPulseTs = ts;
}

/**
 * Between two pulses the power is not known. As long as the next pulse is not yet
 * overdue the last value is kept; afterwards the power can be at most
 * "one pulse since the last pulse", so it decays smoothly towards 0.
 *
 * @param {CounterState} s state
 * @param {{impulsesPerKWh: number, zeroPowerAfter: number}} cfg configuration
 * @param {number} now current timestamp
 */
function decayedPower(s, cfg, now) {
    if (s.lastPulseTs === null) {
        return 0;
    }
    const since = now - s.lastPulseTs;
    if (since >= cfg.zeroPowerAfter * 1000) {
        return 0;
    }
    if (since <= (s.lastIntervalMs || 0)) {
        return s.powerW;
    }
    const upperBound = WS_PER_KWH_MS / (cfg.impulsesPerKWh * Math.max(since, 1));
    return round(Math.min(s.powerW, upperBound), 1);
}

/**
 * A pulse interval reported directly by the ESP (e.g. MQTT state "Time"), the most
 * precise source for the current power.
 *
 * @param {CounterState} prev state (not modified)
 * @param {number} timeMs ms between the last two pulses
 * @param {number} ts timestamp of the report
 * @param {{impulsesPerKWh: number, maxPowerKW: number}} cfg configuration
 */
function applyPulseInterval(prev, timeMs, ts, cfg) {
    const s = { ...prev };
    const interval = validInterval(timeMs, cfg);
    if (interval === null) {
        return { state: s, accepted: false };
    }
    setPulse(s, interval, ts, cfg);
    return { state: s, accepted: true };
}

/**
 * @param {CounterState} prev state (not modified)
 * @param {{impulsesPerKWh: number, zeroPowerAfter: number}} cfg configuration
 * @param {number} now current timestamp
 */
function decay(prev, cfg, now) {
    return { ...prev, powerW: decayedPower(prev, cfg, now) };
}

/**
 * @param {CounterState} s state
 * @param {number} impulsesPerKWh impulses per kWh
 * @returns {number} meter reading in kWh
 */
function totalKWh(s, impulsesPerKWh) {
    return round(s.referenceKWh + s.pulses / impulsesPerKWh, 5);
}

/**
 * Set the meter reading (e.g. value shown on the physical meter).
 *
 * @param {CounterState} s state
 * @param {number} kWh new reading
 */
function applyReading(s, kWh) {
    return { ...s, referenceKWh: kWh, pulses: 0 };
}

/**
 * Meter reading from the instance settings: apply only if it was entered or changed,
 * not on every adapter restart.
 *
 * @param {CounterState} s state
 * @param {number|null} val value from the settings (null = empty)
 */
function shouldApplyConfigReading(s, val) {
    return val !== null && val !== s.appliedConfigReading;
}

module.exports = {
    shouldApplyConfigReading,
    createState,
    processReading,
    applyPulseInterval,
    decay,
    totalKWh,
    applyReading,
    round,
};
