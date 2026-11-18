'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
            });
        });
    },
});
