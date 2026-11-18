'use strict';

const assert = require('node:assert/strict');
const { backupPath, serialize, parse } = require('../../lib/backup');
const { createState, applyReading } = require('../../lib/counter');
const { createPeriods, updatePeriods } = require('../../lib/periods');

describe('backup', () => {
    const cfg = { name: 'Heizung', host: '10.0.50.147', impulsesPerKWh: 800 };

    it('uses one file per device', () => {
        assert.equal(backupPath('Heizung'), 'espeasy-s0/Heizung.json');
    });

    it('round-trips state and periods', () => {
        const state = { ...applyReading(createState(), 70002), pulses: 123, rawTotal: 747456 };
        const per = updatePeriods(createPeriods(), 70002.15, new Date(2026, 10, 18, 6, 0));
        const text = serialize(cfg, state, per, 'espeasy-s0.0', Date.UTC(2026, 10, 18, 5, 0));
        const back = parse(text);
        assert.deepEqual(back.state, state);
        assert.deepEqual(back.periods, per);
        assert.equal(back.instance, 'espeasy-s0.0');
        assert.equal(back.savedAt, '2026-11-18T05:00:00.000Z');
    });

    it('rejects invalid files', () => {
        assert.equal(parse('not json'), null);
        assert.equal(parse('{}'), null);
        assert.equal(parse('{"format":1,"state":{"pulses":"x","referenceKWh":1}}'), null);
        assert.equal(parse(Buffer.from('{"format":2,"state":{"pulses":1,"referenceKWh":1}}')), null);
    });
});
