'use strict';

/*
 * ioBroker.espeasy-s0
 * Reliable S0 pulse meter reading from ESPEasy "Generic - Pulse counter" tasks.
 */

const utils = require('@iobroker/adapter-core');
const counter = require('./lib/counter');
const periods = require('./lib/periods');
const espeasy = require('./lib/espeasy');

/**
 * Parse a numeric config value.
 *
 * @param {unknown} v value
 * @param {number} def default
 * @param {number} min minimum
 */
function num(v, def, min) {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : def;
}

class EspeasyS0 extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] options */
    constructor(options = {}) {
        super({ ...options, name: 'espeasy-s0' });
        this.devices = new Map();
        this.pollTimer = undefined;
        this.stopping = false;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);

        this.settings = {
            pollInterval: num(this.config.pollInterval, 10, 2),
            requestTimeout: num(this.config.requestTimeout, 5000, 500),
            offlineAfterFailures: Math.round(num(this.config.offlineAfterFailures, 3, 1)),
            maxPowerKW: num(this.config.maxPowerKW, 50, 0.1),
            zeroPowerAfter: num(this.config.zeroPowerAfter, 300, 10),
        };

        const list = Array.isArray(this.config.devices) ? this.config.devices : [];
        for (const d of list) {
            if (!d || d.enabled === false || d.enabled === 'false') {
                continue;
            }
            const host = String(d.host || '').trim();
            const name = String(d.name || host).trim();
            if (!host) {
                this.log.warn(`Device "${name}" has no IP/host configured - skipped`);
                continue;
            }
            const id = this.makeId(name);
            if (!id || this.devices.has(id)) {
                this.log.warn(`Device name "${name}" is empty or used twice - skipped`);
                continue;
            }
            const cfg = {
                name,
                host,
                taskName: String(d.taskName || '').trim(),
                valueTotal: String(d.valueTotal || 'Total').trim(),
                valueTime: String(d.valueTime || 'Time').trim(),
                impulsesPerKWh: num(d.impulsesPerKWh, 1000, 1),
                timeStateId: String(d.timeStateId || '').trim(),
                startReading:
                    d.startReading === '' || d.startReading === null || d.startReading === undefined
                        ? null
                        : num(d.startReading, null, 0),
                maxPowerKW: this.settings.maxPowerKW,
                zeroPowerAfter: this.settings.zeroPowerAfter,
            };
            await this.createDeviceObjects(id, cfg);
            const saved = await this.loadInternal(id);
            this.devices.set(id, {
                id,
                cfg,
                state: saved.state,
                periods: saved.periods,
                failures: 0,
                online: null,
                lastError: '',
                timeLastTs: 0, // last message from the external "Time" state
                powerSource: '',
            });
            await this.applyConfigReading(this.devices.get(id));
            this.log.info(
                `Device "${name}" (${host}, task "${cfg.taskName || 'auto'}", ${cfg.impulsesPerKWh} imp/kWh): ` +
                    `meter reading ${counter.totalKWh(this.devices.get(id).state, cfg.impulsesPerKWh)} kWh`,
            );
        }

        if (this.devices.size === 0) {
            this.log.warn('No devices configured. Please add your ESPEasy device(s) in the instance settings.');
            return;
        }

        await this.subscribeStatesAsync('*.meter.setReading');

        /** external "Time" state -> device */
        this.timeSources = new Map();
        for (const ctx of this.devices.values()) {
            const sid = ctx.cfg.timeStateId;
            if (!sid) {
                continue;
            }
            const obj = await this.getForeignObjectAsync(sid);
            if (!obj) {
                this.log.warn(`${ctx.cfg.name}: Time state "${sid}" does not exist - using polling only`);
                continue;
            }
            this.timeSources.set(sid, ctx);
            await this.subscribeForeignStatesAsync(sid);
            this.log.info(`${ctx.cfg.name}: power from pulse intervals of "${sid}"`);
        }

        await this.pollAll();
    }

    /** @param {string} name name */
    makeId(name) {
        return name
            .replace(this.FORBIDDEN_CHARS, '_')
            .replace(/[.\s]+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    /**
     * @param {string} id device id
     * @param {DeviceConfig} cfg config
     */
    async createDeviceObjects(id, cfg) {
        const defs = [
            [id, { name: cfg.name }, 'device'],
            [`${id}.meter`, { name: { en: 'Meter', de: 'Zähler' } }, 'channel'],
            [
                `${id}.meter.total_kWh`,
                st('number', 'value.energy.consumed', { en: 'Meter reading', de: 'Zählerstand' }, 'kWh'),
                'state',
            ],
            [
                `${id}.meter.power_W`,
                st('number', 'value.power', { en: 'Current power', de: 'Aktuelle Leistung' }, 'W'),
                'state',
            ],
            [
                `${id}.meter.setReading`,
                {
                    ...st(
                        'number',
                        'level',
                        {
                            en: 'Set meter reading (enter value of physical meter)',
                            de: 'Zählerstand setzen (Wert vom Zähler eintragen)',
                        },
                        'kWh',
                    ),
                    write: true,
                    min: 0,
                },
                'state',
            ],
            [`${id}.consumption`, { name: { en: 'Consumption', de: 'Verbrauch' } }, 'channel'],
            [`${id}.consumption.today_kWh`, st('number', 'value.energy', { en: 'Today', de: 'Heute' }, 'kWh'), 'state'],
            [
                `${id}.consumption.yesterday_kWh`,
                st('number', 'value.energy', { en: 'Yesterday', de: 'Gestern' }, 'kWh'),
                'state',
            ],
            [
                `${id}.consumption.month_kWh`,
                st('number', 'value.energy', { en: 'This month', de: 'Dieser Monat' }, 'kWh'),
                'state',
            ],
            [
                `${id}.consumption.lastMonth_kWh`,
                st('number', 'value.energy', { en: 'Last month', de: 'Letzter Monat' }, 'kWh'),
                'state',
            ],
            [
                `${id}.consumption.year_kWh`,
                st('number', 'value.energy', { en: 'This year', de: 'Dieses Jahr' }, 'kWh'),
                'state',
            ],
            [
                `${id}.consumption.lastYear_kWh`,
                st('number', 'value.energy', { en: 'Last year', de: 'Letztes Jahr' }, 'kWh'),
                'state',
            ],
            [`${id}.info`, { name: 'Information' }, 'channel'],
            [
                `${id}.info.online`,
                st('boolean', 'indicator.reachable', { en: 'ESP reachable', de: 'ESP erreichbar' }),
                'state',
            ],
            [
                `${id}.info.lastUpdate`,
                st('number', 'date', { en: 'Last successful reading', de: 'Letzte erfolgreiche Abfrage' }),
                'state',
            ],
            [`${id}.info.lastPulse`, st('number', 'date', { en: 'Last pulse', de: 'Letzter Impuls' }), 'state'],
            [`${id}.info.lastError`, st('string', 'text', { en: 'Last error', de: 'Letzter Fehler' }), 'state'],
            [
                `${id}.info.espTotal`,
                st('number', 'value', { en: 'Raw total on ESP', de: 'Rohwert Total auf dem ESP' }, 'pulses'),
                'state',
            ],
            [
                `${id}.info.espUptime`,
                st('number', 'value.interval', { en: 'ESP uptime', de: 'ESP-Laufzeit' }, 'min'),
                'state',
            ],
            [
                `${id}.info.rebootCount`,
                st('number', 'value', { en: 'Detected ESP reboots', de: 'Erkannte ESP-Neustarts' }),
                'state',
            ],
            [
                `${id}.info.powerSource`,
                {
                    ...st('string', 'text', {
                        en: 'Source of power value (mqtt = exact pulse interval, poll = estimated)',
                        de: 'Quelle der Leistung (mqtt = exakter Impulsabstand, poll = geschätzt)',
                    }),
                    states: { mqtt: 'mqtt', poll: 'poll' },
                },
                'state',
            ],
            [
                `${id}.info.counterResetCount`,
                st('number', 'value', { en: 'Detected counter resets', de: 'Erkannte Zähler-Resets' }),
                'state',
            ],
            [
                `${id}.info.rejectedCount`,
                st('number', 'value', { en: 'Rejected implausible readings', de: 'Verworfene unplausible Werte' }),
                'state',
            ],
            [`${id}.internal`, { name: { en: 'Internal', de: 'Intern' } }, 'channel'],
            [
                `${id}.internal.state`,
                {
                    ...st('string', 'json', {
                        en: 'Persisted counter state (do not edit)',
                        de: 'Gespeicherter Zählerzustand (nicht ändern)',
                    }),
                    expert: true,
                },
                'state',
            ],
        ];
        for (const [oid, common, type] of defs) {
            // @ts-expect-error common type depends on object type
            await this.extendObject(oid, { type, common, native: {} });
        }
    }

    /** @param {string} id device id */
    async loadInternal(id) {
        let state = counter.createState();
        let per = periods.createPeriods();
        const s = await this.getStateAsync(`${id}.internal.state`);
        if (s && typeof s.val === 'string' && s.val) {
            try {
                const parsed = JSON.parse(s.val);
                state = { ...state, ...parsed.state };
                per = { ...per, ...parsed.periods };
            } catch (e) {
                this.log.error(`${id}: cannot parse saved counter state (${e.message}) - starting with 0`);
            }
        }
        return { state, periods: per };
    }

    /** @param {DeviceContext} ctx device */
    async saveInternal(ctx) {
        await this.setState(
            `${ctx.id}.internal.state`,
            JSON.stringify({ state: ctx.state, periods: ctx.periods }),
            true,
        );
    }

    async pollAll() {
        this.pollTimer = undefined;
        await Promise.all([...this.devices.values()].map(ctx => this.pollDevice(ctx)));
        const allOnline = [...this.devices.values()].every(ctx => ctx.online === true);
        await this.setStateChangedAsync('info.connection', allOnline, true);
        if (!this.stopping) {
            this.pollTimer = this.setTimeout(() => this.pollAll(), this.settings.pollInterval * 1000);
        }
    }

    /** @param {DeviceContext} ctx device */
    async pollDevice(ctx) {
        const { id, cfg } = ctx;
        let reading;
        try {
            const json = await espeasy.fetchJson(cfg.host, this.settings.requestTimeout);
            reading = espeasy.extractReading(json, cfg);
        } catch (e) {
            ctx.failures++;
            const msg = e.name === 'TimeoutError' ? 'timeout' : e.message;
            if (ctx.failures === this.settings.offlineAfterFailures) {
                this.log.warn(`${cfg.name}: ESP not reachable (${msg}) - marked offline`);
            } else {
                this.log.debug(`${cfg.name}: reading failed (${msg}), attempt ${ctx.failures}`);
            }
            if (ctx.failures >= this.settings.offlineAfterFailures && ctx.online !== false) {
                ctx.online = false;
                await this.setStateChangedAsync(`${id}.info.online`, false, true);
            }
            if (msg !== ctx.lastError) {
                ctx.lastError = msg;
                await this.setState(`${id}.info.lastError`, msg, true);
            }
            return;
        }

        if (ctx.online !== true) {
            if (ctx.online === false) {
                this.log.info(`${cfg.name}: ESP reachable again`);
            }
            ctx.online = true;
            await this.setStateChangedAsync(`${id}.info.online`, true, true);
        }
        ctx.failures = 0;

        const now = Date.now();
        const externalTime = this.isTimeSourceAlive(ctx, now);
        const res = counter.processReading(ctx.state, reading, cfg, now, { externalTime });
        ctx.state = res.state;
        await this.setPowerSource(ctx, externalTime ? 'mqtt' : 'poll');
        if (res.timeRejected) {
            this.log.info(`${cfg.name}: implausible pulse interval ${reading.timeMs} ms ignored (contact bounce?)`);
        }

        if (res.baseline) {
            this.log.info(`${cfg.name}: baseline set (ESP total ${ctx.state.rawTotal})`);
        }
        if (res.reboot) {
            this.log.info(`${cfg.name}: ESP reboot detected, counting continues`);
        }
        if (res.counterReset) {
            this.log.warn(
                `${cfg.name}: ESP counter was reset (now ${reading.total}) - ${res.deltaPulses} pulses since reset added`,
            );
        }
        if (res.rejected) {
            this.log.warn(`${cfg.name}: reading rejected: ${res.reason}`);
        }

        const total = counter.totalKWh(ctx.state, cfg.impulsesPerKWh);
        ctx.periods = periods.updatePeriods(ctx.periods, total, new Date(now));
        await this.writeValues(ctx, total, reading);
        await this.saveInternal(ctx);
    }

    /**
     * @param {DeviceContext} ctx device
     * @param {number} total meter reading
     * @param {{total: number, uptimeMs: number|null}} [reading] raw reading
     */
    async writeValues(ctx, total, reading) {
        const { id, state } = ctx;
        const c = periods.consumption(ctx.periods, total);
        const values = {
            'meter.total_kWh': total,
            'meter.power_W': state.powerW,
            'consumption.today_kWh': c.today,
            'consumption.yesterday_kWh': c.yesterday,
            'consumption.month_kWh': c.month,
            'consumption.lastMonth_kWh': c.lastMonth,
            'consumption.year_kWh': c.year,
            'consumption.lastYear_kWh': c.lastYear,
            'info.lastPulse': state.lastPulseTs,
            'info.rebootCount': state.rebootCount,
            'info.counterResetCount': state.counterResetCount,
            'info.rejectedCount': state.rejectedCount,
            'info.espTotal': state.rawTotal,
        };
        if (reading) {
            values['info.lastUpdate'] = state.pollTs;
            values['info.espUptime'] = reading.uptimeMs === null ? null : Math.floor(reading.uptimeMs / 60000);
        }
        for (const [key, val] of Object.entries(values)) {
            await this.setStateChangedAsync(`${id}.${key}`, val === undefined ? null : val, true);
        }
    }

    /**
     * @param {string} fullId state id
     * @param {ioBroker.State | null | undefined} state state
     */
    async onStateChange(fullId, state) {
        if (!state) {
            return;
        }
        const timeCtx = this.timeSources && this.timeSources.get(fullId);
        if (timeCtx) {
            await this.onPulseInterval(timeCtx, state);
            return;
        }
        if (state.ack) {
            return;
        }
        const m = fullId.match(/^[^.]+\.\d+\.(.+)\.meter\.setReading$/);
        const ctx = m && this.devices.get(m[1]);
        if (!ctx) {
            return;
        }
        const val = Number(state.val);
        if (!Number.isFinite(val) || val < 0) {
            this.log.warn(`${ctx.cfg.name}: invalid meter reading "${state.val}" ignored`);
            return;
        }
        await this.applyMeterReading(ctx, val, 'state setReading');
        await this.setState(fullId, val, true);
    }

    /**
     * @param {DeviceContext} ctx device
     * @param {number} val new meter reading (kWh)
     * @param {string} source for the log
     */
    async applyMeterReading(ctx, val, source) {
        const old = counter.totalKWh(ctx.state, ctx.cfg.impulsesPerKWh);
        ctx.state = counter.applyReading(ctx.state, val);
        ctx.periods = periods.shiftPeriods(ctx.periods, val - old);
        const total = counter.totalKWh(ctx.state, ctx.cfg.impulsesPerKWh);
        this.log.info(`${ctx.cfg.name}: meter reading set from ${old} to ${total} kWh (${source})`);
        await this.saveInternal(ctx);
        await this.writeValues(ctx, total);
    }

    /**
     * Meter reading from the instance settings: applied only once per entered value,
     * so saving the settings later (adapter restart) does not reset the meter.
     *
     * @param {DeviceContext} ctx device
     */
    async applyConfigReading(ctx) {
        const val = ctx.cfg.startReading;
        if (!counter.shouldApplyConfigReading(ctx.state, val)) {
            return;
        }
        ctx.state = { ...ctx.state, appliedConfigReading: val };
        await this.applyMeterReading(ctx, val, 'instance settings');
    }

    /**
     * The external "Time" state is fresh if the ESP published it recently
     * (ESPEasy publishes every task interval, also with Time = 0).
     *
     * @param {DeviceContext} ctx device
     * @param {number} now timestamp
     */
    isTimeSourceAlive(ctx, now) {
        const maxAge = Math.max(15000, 3 * this.settings.pollInterval * 1000);
        return !!ctx.cfg.timeStateId && ctx.timeLastTs > 0 && now - ctx.timeLastTs <= maxAge;
    }

    /**
     * @param {DeviceContext} ctx device
     * @param {string} source 'mqtt' or 'poll'
     */
    async setPowerSource(ctx, source) {
        if (ctx.powerSource !== source) {
            ctx.powerSource = source;
            await this.setState(`${ctx.id}.info.powerSource`, source, true);
        }
    }

    /**
     * Every message of the external "Time" state (e.g. from the MQTT adapter).
     *
     * @param {DeviceContext} ctx device
     * @param {ioBroker.State} state state
     */
    async onPulseInterval(ctx, state) {
        if (state.q || state.ts < ctx.timeLastTs) {
            return;
        }
        ctx.timeLastTs = state.ts;
        const timeMs = Number(state.val);
        if (!Number.isFinite(timeMs) || timeMs <= 0) {
            return; // no pulse in this ESP task interval
        }
        const res = counter.applyPulseInterval(ctx.state, timeMs, state.ts, ctx.cfg);
        if (!res.accepted) {
            this.log.info(`${ctx.cfg.name}: implausible pulse interval ${timeMs} ms ignored (contact bounce?)`);
            return;
        }
        ctx.state = res.state;
        await this.setPowerSource(ctx, 'mqtt');
        await this.setState(`${ctx.id}.meter.power_W`, ctx.state.powerW, true);
    }

    /** @param {() => void} callback callback */
    onUnload(callback) {
        try {
            this.stopping = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
            }
            callback();
        } catch {
            callback();
        }
    }
}

/**
 * @param {ioBroker.CommonType} type type
 * @param {string} role role
 * @param {ioBroker.StringOrTranslated} name name
 * @param {string} [unit] unit
 * @returns {ioBroker.StateCommon} common
 */
function st(type, role, name, unit) {
    const common = { type, role, name, read: true, write: false };
    if (unit) {
        common.unit = unit;
    }
    return common;
}

if (require.main !== module) {
    /** @param {Partial<utils.AdapterOptions>} [options] options */
    module.exports = options => new EspeasyS0(options);
} else {
    new EspeasyS0();
}
