'use strict';

/**
 * Backup of the counter state outside the adapter instance (file in 0_userdata.0),
 * so meter reading and consumption survive deleting / re-installing the instance.
 */

const BACKUP_META_ID = '0_userdata.0';
const BACKUP_DIR = 'espeasy-s0';
const FORMAT_VERSION = 1;

/**
 * @param {string} deviceId device id (object id below the instance)
 */
function backupPath(deviceId) {
    return `${BACKUP_DIR}/${deviceId}.json`;
}

/**
 * @param {{name: string, host: string, impulsesPerKWh: number}} cfg device config
 * @param {object} state counter state
 * @param {object} periods periods
 * @param {string} namespace adapter namespace, e.g. espeasy-s0.0
 * @param {number} now timestamp
 */
function serialize(cfg, state, periods, namespace, now) {
    return JSON.stringify(
        {
            format: FORMAT_VERSION,
            savedAt: new Date(now).toISOString(),
            instance: namespace,
            device: { name: cfg.name, host: cfg.host, impulsesPerKWh: cfg.impulsesPerKWh },
            state,
            periods,
        },
        null,
        2,
    );
}

/**
 * @param {string | Buffer} data file content
 * @returns {{state: object, periods: object, savedAt: string, instance: string} | null} parsed backup or null if invalid
 */
function parse(data) {
    try {
        const json = JSON.parse(String(data));
        if (
            !json ||
            json.format !== FORMAT_VERSION ||
            !json.state ||
            typeof json.state !== 'object' ||
            typeof json.state.pulses !== 'number' ||
            typeof json.state.referenceKWh !== 'number'
        ) {
            return null;
        }
        return {
            state: json.state,
            periods: json.periods && typeof json.periods === 'object' ? json.periods : {},
            savedAt: String(json.savedAt || ''),
            instance: String(json.instance || ''),
        };
    } catch {
        return null;
    }
}

module.exports = { BACKUP_META_ID, BACKUP_DIR, backupPath, serialize, parse };
