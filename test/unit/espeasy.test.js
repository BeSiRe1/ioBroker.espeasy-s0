'use strict';

const assert = require('node:assert/strict');
const { buildUrl, parseJson, extractReading } = require('../../lib/espeasy');

// trimmed real response of ESP Easy Mega 20210802 (build 20114)
const sample = `{"System":{"Build":20114,"Unit Name":"WD1_Stromzähler_Heizung","Uptime":228259,
"Uptime (ms)":13695563454},
"Sensors":[
{"TaskValues":[{"ValueNumber":1,"Name":"Count","NrDecimals":2,"Value":0.00},
{"ValueNumber":2,"Name":"Total","NrDecimals":2,"Value":745227.00},
{"ValueNumber":3,"Name":"Time","NrDecimals":2,"Value":450.00}],
"TaskInterval":2,"Type":"Generic - Pulse counter","TaskName":"Stromzaehler_Heizung","TaskEnabled":"true","TaskNumber":1},
{"TaskValues":[{"ValueNumber":1,"Name":"State","NrDecimals":0,"Value":1}],
"Type":"Switch input - Switch","TaskName":"Phasenwächter","TaskEnabled":"true","TaskNumber":2}
],"TTL":2000}`;

describe('espeasy', () => {
    it('builds the /json url', () => {
        assert.equal(buildUrl('10.0.50.147'), 'http://10.0.50.147/json');
        assert.equal(buildUrl('http://esp.local:8080/'), 'http://esp.local:8080/json');
        assert.throws(() => buildUrl(''));
    });

    it('tolerates nan in json', () => {
        assert.deepEqual(parseJson('{"a":nan,"b":-inf,"c":1}'), { a: null, b: null, c: 1 });
    });

    it('extracts values by task name (case-insensitive)', () => {
        const r = extractReading(JSON.parse(sample), { taskName: 'stromzaehler_heizung' });
        assert.equal(r.total, 745227);
        assert.equal(r.timeMs, 450);
        assert.equal(r.uptimeMs, 13695563454);
        assert.equal(r.unitName, 'WD1_Stromzähler_Heizung');
    });

    it('auto-detects the first pulse counter task', () => {
        const r = extractReading(JSON.parse(sample), {});
        assert.equal(r.taskName, 'Stromzaehler_Heizung');
    });

    it('falls back to Uptime in minutes', () => {
        const json = JSON.parse(sample);
        delete json.System['Uptime (ms)'];
        assert.equal(extractReading(json, {}).uptimeMs, 228259 * 60000);
    });

    it('reports a missing task with the available names', () => {
        assert.throws(() => extractReading(JSON.parse(sample), { taskName: 'xyz' }), /Phasenwächter/);
    });
});
