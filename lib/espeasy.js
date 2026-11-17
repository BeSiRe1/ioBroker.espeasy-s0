'use strict';

/**
 * Access to the ESPEasy JSON API (http://<ip>/json).
 */

/**
 * @param {string} host IP, hostname or URL (optionally with port)
 */
function buildUrl(host) {
    let h = String(host || '').trim();
    if (!h) {
        throw new Error('no host configured');
    }
    if (!/^https?:\/\//i.test(h)) {
        h = `http://${h}`;
    }
    const url = new URL(h);
    url.pathname = '/json';
    url.search = '';
    return url.toString();
}

/**
 * Some ESPEasy builds emit "nan"/"inf" which is not valid JSON.
 *
 * @param {string} text raw response
 */
function parseJson(text) {
    const cleaned = text.replace(/:\s*-?(nan|inf)\b/gi, ':null');
    return JSON.parse(cleaned);
}

/**
 * @param {string} host host
 * @param {number} timeoutMs timeout
 */
async function fetchJson(host, timeoutMs) {
    const res = await fetch(buildUrl(host), {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return parseJson(await res.text());
}

/**
 * @param {Array<{Name: string, Value: unknown}>} values task values
 * @param {string} name value name
 */
function findValue(values, name) {
    if (!name) {
        return undefined;
    }
    const wanted = name.toLowerCase();
    const v = values.find(tv => String(tv.Name).toLowerCase() === wanted);
    return v === undefined ? undefined : Number(v.Value);
}

/**
 * Extract the pulse counter values from the ESPEasy JSON.
 *
 * @param {Record<string, any>} json parsed /json response
 * @param {{taskName?: string, valueTotal?: string, valueTime?: string}} cfg which task/values to use
 */
function extractReading(json, cfg) {
    const sensors = Array.isArray(json && json.Sensors) ? json.Sensors : [];
    let task;
    if (cfg.taskName) {
        const wanted = cfg.taskName.toLowerCase();
        task = sensors.find(s => String(s.TaskName).toLowerCase() === wanted);
        if (!task) {
            const names = sensors.map(s => s.TaskName).join(', ');
            throw new Error(`task "${cfg.taskName}" not found on ESP (available: ${names || 'none'})`);
        }
    } else {
        task = sensors.find(s => /pulse counter/i.test(String(s.Type)));
        if (!task) {
            throw new Error('no "Generic - Pulse counter" task found on ESP');
        }
    }
    if (String(task.TaskEnabled) === 'false') {
        throw new Error(`task "${task.TaskName}" is disabled on the ESP`);
    }

    const values = Array.isArray(task.TaskValues) ? task.TaskValues : [];
    const valueTotal = cfg.valueTotal || 'Total';
    const total = findValue(values, valueTotal);
    if (total === undefined) {
        throw new Error(`value "${valueTotal}" not found in task "${task.TaskName}"`);
    }
    const timeMs = findValue(values, cfg.valueTime || 'Time');

    const sys = (json && json.System) || {};
    let uptimeMs = null;
    if (Number.isFinite(Number(sys['Uptime (ms)']))) {
        uptimeMs = Number(sys['Uptime (ms)']);
    } else if (Number.isFinite(Number(sys.Uptime))) {
        uptimeMs = Number(sys.Uptime) * 60000; // minutes
    }

    return {
        total,
        timeMs: Number.isFinite(timeMs) ? timeMs : null,
        uptimeMs,
        unitName: sys['Unit Name'] || '',
        taskName: task.TaskName,
    };
}

module.exports = { buildUrl, parseJson, fetchJson, extractReading };
