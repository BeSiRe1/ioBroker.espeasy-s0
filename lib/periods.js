'use strict';

const { round } = require('./counter');

/**
 * Daily / monthly / yearly consumption based on the meter reading.
 * Period boundaries use the local time of the ioBroker host.
 */

/**
 * @param {Date} d date
 */
function keys(d) {
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return { day: `${y}-${m}-${day}`, month: `${y}-${m}`, year: y };
}

/**
 * @returns {Periods} empty periods
 */
function createPeriods() {
    return {
        dayKey: null,
        dayStart: null,
        monthKey: null,
        monthStart: null,
        yearKey: null,
        yearStart: null,
        yesterday: null,
        lastMonth: null,
        lastYear: null,
    };
}

/**
 * @param {Periods} prev previous periods (not modified)
 * @param {number} total current meter reading (kWh)
 * @param {Date} date current date
 */
function updatePeriods(prev, total, date) {
    const p = { ...prev };
    const k = keys(date);

    for (const [name, key, last] of [
        ['day', k.day, 'yesterday'],
        ['month', k.month, 'lastMonth'],
        ['year', k.year, 'lastYear'],
    ]) {
        if (p[`${name}Key`] === null || p[`${name}Start`] === null) {
            p[`${name}Key`] = key;
            p[`${name}Start`] = total;
        } else if (p[`${name}Key`] !== key) {
            p[last] = round(total - p[`${name}Start`], 5);
            p[`${name}Key`] = key;
            p[`${name}Start`] = total;
        }
    }
    return p;
}

/**
 * When the meter reading is corrected, move the period start values by the same amount
 * so the consumption of the running periods is not affected.
 *
 * @param {Periods} prev periods
 * @param {number} diff difference new - old reading (kWh)
 */
function shiftPeriods(prev, diff) {
    const p = { ...prev };
    for (const name of ['dayStart', 'monthStart', 'yearStart']) {
        if (p[name] !== null) {
            p[name] = round(p[name] + diff, 5);
        }
    }
    return p;
}

/**
 * @param {Periods} p periods
 * @param {number} total current meter reading
 */
function consumption(p, total) {
    const since = start => (start === null ? 0 : round(Math.max(total - start, 0), 5));
    return {
        today: since(p.dayStart),
        month: since(p.monthStart),
        year: since(p.yearStart),
        yesterday: p.yesterday,
        lastMonth: p.lastMonth,
        lastYear: p.lastYear,
    };
}

module.exports = { keys, createPeriods, updatePeriods, shiftPeriods, consumption };
