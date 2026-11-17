'use strict';

const assert = require('node:assert/strict');
const { createPeriods, updatePeriods, shiftPeriods, consumption } = require('../../lib/periods');

describe('periods', () => {
    it('initialises all periods with the current reading', () => {
        const p = updatePeriods(createPeriods(), 100, new Date(2026, 10, 17, 12, 0));
        assert.deepEqual(consumption(p, 105), {
            today: 5,
            month: 5,
            year: 5,
            yesterday: null,
            lastMonth: null,
            lastYear: null,
        });
    });

    it('rolls over day, month and year', () => {
        let p = updatePeriods(createPeriods(), 100, new Date(2026, 11, 31, 10, 0));
        p = updatePeriods(p, 112, new Date(2026, 11, 31, 23, 59));
        p = updatePeriods(p, 113, new Date(2027, 0, 1, 0, 0, 10));
        const c = consumption(p, 115);
        assert.equal(c.yesterday, 13);
        assert.equal(c.lastMonth, 13);
        assert.equal(c.lastYear, 13);
        assert.equal(c.today, 2);
        assert.equal(c.month, 2);
        assert.equal(c.year, 2);
    });

    it('setting the meter reading does not change running consumption', () => {
        let p = updatePeriods(createPeriods(), 0.5, new Date(2026, 10, 17, 8, 0));
        // today 1.5 kWh consumed so far (reading 2.0), then user sets 70002
        p = shiftPeriods(p, 70002 - 2.0);
        assert.equal(consumption(p, 70002).today, 1.5);
    });
});
