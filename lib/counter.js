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
        lastPulseTs: null, // timestamp of the last poll that contained new pulses
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
 */
function processReading(prev, reading, cfg, now) {
    const s = { ...prev };
    const result = {
        state: s,
        deltaPulses: 0,
        baseline: false,
        reboot: false,
        counterReset: false,
        rejected: false,
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
    s.powerW = calcPower(s, delta, reading.timeMs, elapsedMs, cfg, now);
    if (delta > 0) {
        s.lastPulseTs = now;
    }

    s.rawTotal = rawTotal;
    s.uptimeMs = uptimeMs;
    s.pollTs = now;
    return result;
}

/**
 * @param {CounterState} s state (lastPulseTs / powerW of previous poll)
 * @param {number} delta new pulses in this poll
 * @param {number|null|undefined} timeMs ESPEasy "Time" (ms between the last two pulses)
 * @param {number} elapsedMs time since last poll
 * @param {{impulsesPerKWh: number, maxPowerKW: number, zeroPowerAfter: number}} cfg configuration
 * @param {number} now current timestamp
 */
function calcPower(s, delta, timeMs, elapsedMs, cfg, now) {
    const imp = cfg.impulsesPerKWh;
    const maxW = cfg.maxPowerKW * 1000 * 1.5;

    if (delta > 0) {
        if (Number.isFinite(timeMs) && timeMs > 0) {
            const p = WS_PER_KWH_MS / (imp * timeMs);
            if (p <= maxW) {
                return round(p, 1);
            }
        }
        // Fallback (ESPEasy "Time" is often 0 because it is reset every task interval):
        // - several pulses in this poll: average over the poll interval
        // - a single pulse at low load: average since the previous pulse, otherwise one
        //   pulse that happens to fall into a 10 s poll would show a far too high power
        let windowMs = elapsedMs;
        if (delta === 1 && s.lastPulseTs !== null) {
            windowMs = Math.max(now - s.lastPulseTs, elapsedMs);
        }
        return round(Math.min((delta * WS_PER_KWH_MS) / (imp * windowMs), maxW), 1);
    }

    // no new pulse: power can be at most "one pulse since the last pulse"
    if (s.lastPulseTs === null) {
        return 0;
    }
    const since = now - s.lastPulseTs;
    if (since >= cfg.zeroPowerAfter * 1000) {
        return 0;
    }
    const upperBound = WS_PER_KWH_MS / (imp * Math.max(since, 1));
    return round(Math.min(s.powerW, upperBound), 1);
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

module.exports = { createState, processReading, totalKWh, applyReading, round };
