'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calls a callback-style method of the harness objects client as a promise
 *
 * @param {any} objects harness.objects
 * @param {string} method e.g. 'readFile'
 * @param {...any} args arguments without callback
 */
const call = (objects, method, ...args) =>
    new Promise((resolve, reject) =>
        objects[method](...args, (/** @type {any} */ err, /** @type {any} */ res) => (err ? reject(err) : resolve(res))),
    );

// Starts the adapter in a temporary js-controller instance
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('meter reading from the instance settings', getHarness => {
            /** @type {any} */
            let harness;
            before(() => {
                harness = getHarness();
            });

            /** @param {number|null} startReading reading in the settings */
            async function start(startReading) {
                // remove a backup left over from a previous test run
                try {
                    await call(harness.objects, 'unlink', '0_userdata.0', 'espeasy-s0/Test.json');
                } catch {
                    // not there
                }
                await harness.changeAdapterConfig('espeasy-s0', {
                    native: {
                        pollInterval: 60,
                        requestTimeout: 500,
                        devices: [
                            { enabled: true, name: 'Test', host: '127.0.0.1:1', impulsesPerKWh: 800, startReading },
                        ],
                    },
                });
                await harness.startAdapterAndWait();
                await wait(1500);
            }

            async function total() {
                const s = await harness.states.getStateAsync('espeasy-s0.0.Test.meter.total_kWh');
                return s && s.val;
            }

            // (the harness cannot restart an adapter; "applied only once" is covered by unit tests)
            it('is applied on start and can be corrected via setReading', async function () {
                this.timeout(60000);
                await start(70002);
                assert.equal(await total(), 70002);

                await harness.states.setStateAsync('espeasy-s0.0.Test.meter.setReading', { val: 70010, ack: false });
                await wait(1000);
                assert.equal(await total(), 70010);

                const internal = await harness.states.getStateAsync('espeasy-s0.0.Test.internal.state');
                assert.equal(JSON.parse(internal.val).state.appliedConfigReading, 70002);

                // backup file written to 0_userdata.0
                const file = await call(harness.objects, 'readFile', '0_userdata.0', 'espeasy-s0/Test.json');
                const saved = JSON.parse(String(file));
                assert.equal(saved.state.referenceKWh, 70010);
            });
        });

        suite('restore from backup in 0_userdata.0', getHarness => {
            it('a new instance without own state restores reading and consumption', async function () {
                this.timeout(60000);
                const harness = getHarness();
                const content = JSON.stringify({
                    format: 1,
                    savedAt: '2026-11-18T05:00:00.000Z',
                    instance: 'espeasy-s0.0',
                    state: { pulses: 800, referenceKWh: 70002, rawTotal: 747456, pollTs: Date.now() - 60000 },
                    periods: {},
                });
                const meta = await harness.objects.getObjectAsync('0_userdata.0');
                if (!meta) {
                    await harness.objects.setObjectAsync('0_userdata.0', {
                        type: 'meta',
                        common: { name: 'User files', type: 'meta.user' },
                        native: {},
                    });
                }
                await call(harness.objects, 'writeFile', '0_userdata.0', 'espeasy-s0/Restored.json', content);
                await harness.changeAdapterConfig('espeasy-s0', {
                    native: {
                        pollInterval: 60,
                        requestTimeout: 500,
                        devices: [{ enabled: true, name: 'Restored', host: '127.0.0.1:1', impulsesPerKWh: 800 }],
                    },
                });
                await harness.startAdapterAndWait();
                await wait(1500);
                const s = await harness.states.getStateAsync('espeasy-s0.0.Restored.meter.total_kWh');
                assert.equal(s && s.val, 70003); // 70002 + 800 pulses / 800
            });
        });
    },
});
