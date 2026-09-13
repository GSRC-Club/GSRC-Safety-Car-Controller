'use strict';

const YAML = require('yaml');
const { shared } = require('./shared');
const { SafetyCarController } = require('./controller');
const { deriveSpeeds, physicalOrder } = require('./rules');
const { RaceSimulator } = require('./simulator');
const { OperationLedger } = require('./operation-ledger');
const { evaluateLiveAuthority } = require('./live-authority');
const { TelemetryTraceRecorder } = require('./telemetry-trace');

const { IrsdkReader } = shared('irsdk-reader');
const { parseSessionInfo } = shared('session-info-parser');
const { makeDispatcher } = shared('command-dispatch');

const TELEMETRY = [
    'CarIdxPosition', 'CarIdxLap', 'CarIdxLapCompleted', 'CarIdxLapDistPct',
    'CarIdxOnPitRoad', 'CarIdxTrackSurface', 'CarIdxSessionFlags',
    'SessionFlags', 'SessionTime', 'SessionTimeRemain', 'SessionLapsRemainEx',
    'SessionNum', 'SessionState', 'ReplayFrameNum', 'ReplayFrameNumEnd', 'ReplayPlaySpeed',
];
const CAUTION_FLAGS = 0x00004000 | 0x00008000;

class ControllerService {
    constructor({ clipboard, config, log = console, ledger = null, dataDirectory = null, dispatcher = null, traceRecorder = null, traceDirectory = null } = {}) {
        this.log = log;
        this.reader = new IrsdkReader();
        this.dispatcher = dispatcher || makeDispatcher({ serializeCommands: true }, log, { clipboard });
        this.ledger = ledger || (dataDirectory ? new OperationLedger({ directory: dataDirectory }) : null);
        this.controller = new SafetyCarController(config, { ledger: this.ledger });
        this.traceRecorder = traceRecorder || (traceDirectory ? new TelemetryTraceRecorder({ directory: traceDirectory }) : null);
        this.simulator = new RaceSimulator();
        this.simulation = false;
        this.session = null;
        this.telemetry = {};
        this.previousDrivers = new Map();
        this.lastFrameAt = 0;
        this.lastTick = -1;
        this.lastSessionRead = 0;
        this.lastContextAt = 0;
        this.incidentTotals = new Map();
        this.cautionActive = null;
        this.paceCarIdx = null;
        this.paceYaml = null;
        this.lastSessionIdentity = null;
        this.timer = null;
        this.dispatching = new Set();
        this.commandQueue = Promise.resolve();
        this.controller.on('command', command => this._dispatch(command));
    }
    start() { if (!this.timer) this.timer = setInterval(() => this._poll(), 200); }
    stop() { clearInterval(this.timer); this.timer = null; this.simulator.stop(); try { this.reader.close(); } catch (_) {} }
    setSimulation(active) {
        if (this.controller.snapshot().active || this.controller.recoveryRequired) throw new Error('End or resolve the active procedure before changing rehearsal mode.');
        this.controller.setOutputArmed(false);
        this.simulation = !!active;
        if (this.simulation) { this.simulator.start(); try { this.reader.close(); } catch (_) {} }
        else this.simulator.stop();
        this._poll();
    }
    simulate(action, carIdx) {
        if (!this.simulation) throw new Error('Enable Simulator mode first.');
        if (action === 'pass') this.simulator.createIllegalPass(carIdx);
        if (action === 'speed') this.simulator.createSpeeding(carIdx);
        if (action === 'lap-down') this.simulator.addLapDown(carIdx);
        if (action === 'incident') {
            const event = this.simulator.incident(carIdx);
            if (event) this.controller.addIncident(event);
        }
        this._poll();
    }
    _poll() {
        if (this.simulation) {
            const context = this.simulator.tick(0.2);
            this.simulator.setCode80(this.controller.snapshot().active && !['native'].includes(this.controller.procedure));
            this.controller.updateContext(context);
            return;
        }
        try {
            if (!this.reader.view && !this.reader.open()) return this._publishDisconnected();
            const frame = this.reader.readFrame(TELEMETRY, this.lastTick);
            if (frame) {
                this.lastTick = frame.tick; this.lastFrameAt = Date.now(); this.telemetry = frame.values;
                this.dispatcher.updateTelemetry(frame.values);
                this._observeSessionFlags(frame.values.SessionFlags);
            }
            if (Date.now() - this.lastSessionRead >= 1000) {
                this.lastSessionRead = Date.now(); this.reader.lastSessionInfoUpdate = -1;
                const yaml = this.reader.readSessionInfoIfChanged();
                if (yaml) {
                    const parsed = parseSessionInfo(yaml, this.log);
                    if (!parsed.error) {
                        this.session = parsed; this.dispatcher.updateSession(parsed); this._resetSessionScopedStateIfChanged(sessionIdentity(parsed, this.telemetry.SessionNum)); this._readIncidents(parsed);
                        if (yaml !== this.paceYaml) { this.paceYaml = yaml; this.paceCarIdx = paceCarIdxFromYaml(yaml); }
                    }
                }
            }
            if (frame || Date.now() - this.lastContextAt > 1000) { this.lastContextAt = Date.now(); const context = this._context(); this.traceRecorder?.record(context); this.controller.updateContext(context); }
        } catch (error) {
            this.log.warn?.(`iRacing poll: ${error.message}`);
            try { this.reader.close(); } catch (_) {}
            this._publishDisconnected();
        }
    }
    _context() {
        const roster = this.session?.driverInfo?.drivers || [];
        const t = this.telemetry;
        const rawDrivers = roster.map(d => {
            const idx = d.carIdx;
            return {
                carIdx: idx, carNumber: d.carNumber, name: d.userName, carClassID: d.carClassID,
                position: t.CarIdxPosition?.[idx] || null,
                lap: t.CarIdxLap?.[idx] || 0,
                lapCompleted: t.CarIdxLapCompleted?.[idx] || 0,
                lapDistPct: t.CarIdxLapDistPct?.[idx],
                onPitRoad: !!t.CarIdxOnPitRoad?.[idx],
                surface: t.CarIdxTrackSurface?.[idx],
                inWorld: Number(t.CarIdxTrackSurface?.[idx]) >= 0,
            };
        });
        const now = Date.now();
        const dt = this.lastDriverAt ? (now - this.lastDriverAt) / 1000 : null;
        const speeds = deriveSpeeds(this.previousDrivers, rawDrivers, this.session?.weekendInfo?.trackLengthM, dt);
        const drivers = rawDrivers.map(d => ({ ...d, speedKph: speeds.get(d.carIdx) ?? this.previousDrivers.get(d.carIdx)?.speedKph ?? null }));
        this.previousDrivers = new Map(drivers.map(d => [d.carIdx, d])); this.lastDriverAt = now;
        const leader = physicalOrder(drivers)[0];
        const currentSession = currentSessionFromTelemetry(this.session, t.SessionNum);
        const identity = sessionIdentity(this.session, t.SessionNum);
        this._resetSessionScopedStateIfChanged(identity);
        return {
            connected: !!this.reader.view, simulated: false,
            stale: !this.lastFrameAt || now - this.lastFrameAt > 1500,
            isRace: /race/i.test(currentSession?.type || ''),
            sessionName: [this.session?.weekendInfo?.seriesName || 'iRacing session', currentSession?.name || currentSession?.type].filter(Boolean).join(' — '),
            trackName: [this.session?.weekendInfo?.trackDisplayName, this.session?.weekendInfo?.trackConfigName].filter(Boolean).join(' — '),
            trackLengthM: this.session?.weekendInfo?.trackLengthM,
            sessionTime: Number(t.SessionTime) || 0,
            leaderLap: leader?.lapCompleted || 0,
            sessionState: t.SessionState,
            sessionFlags: t.SessionFlags,
            telemetryTick: this.lastTick,
            frameAt: this.lastFrameAt || null,
            sessionIdentity: identity,
            replayLive: replayIsLive(t.ReplayFrameNum, t.ReplayFrameNumEnd),
            replayFrameGap: replayFrameGap(t.ReplayFrameNum, t.ReplayFrameNumEnd),
            paceCarLapDistPct: Number.isInteger(this.paceCarIdx) ? t.CarIdxLapDistPct?.[this.paceCarIdx] : null,
            drivers,
        };
    }
    _readIncidents(parsed) {
        for (const driver of parsed.driverInfo?.drivers || []) {
            const current = Math.max(Number(driver.teamIncidentCount) || 0, Number(driver.curDriverIncidentCount) || 0);
            const prior = this.incidentTotals.get(driver.carIdx);
            this.incidentTotals.set(driver.carIdx, current);
            if (prior == null || current <= prior) continue;
            const delta = current - prior;
            if (delta >= 4) this.controller.addIncident({ carIdx: driver.carIdx, points: 4, lapDistPct: this.telemetry.CarIdxLapDistPct?.[driver.carIdx], at: Date.now() });
        }
    }
    _resetSessionScopedStateIfChanged(identity) {
        if (!identity || identity === this.lastSessionIdentity) return;
        this.lastSessionIdentity = identity;
        this.incidentTotals.clear();
        this.cautionActive = null;
        this.previousDrivers.clear();
        this.lastDriverAt = null;
    }
    _observeSessionFlags(flags) {
        const cautionActive = (Number(flags) & CAUTION_FLAGS) !== 0;
        if (this.cautionActive === false && cautionActive) this.controller.noteNativeYellow();
        this.cautionActive = cautionActive;
    }
    _publishDisconnected() { this.controller.updateContext({ connected: false, simulated: false, stale: true, isRace: false, drivers: [] }); }
    _dispatch(command) {
        this.commandQueue = this.commandQueue.then(() => this._dispatchNow(command)).catch(error => {
            this.log.error?.(`Safety command queue: ${error.message}`);
        });
        return this.commandQueue;
    }
    async _dispatchNow(command) {
        if (!command.armed) return;
        if (this.simulation || this.controller.context.simulated) {
            this.controller.recordCommandResult(command.id, { sent: false, reason: 'Live command blocked in rehearsal mode.' });
            return;
        }
        const authority = evaluateLiveAuthority(this.controller.context, this.controller.boundSessionIdentity);
        if (!authority.ok) {
            const reason = authority.reason;
            this.controller.tripLiveInterlock(reason);
            this.controller.recordCommandResult(command.id, { sent: false, reason });
            this.controller.emit('attention', { type: 'command-blocked', result: { uniqueCars: 0, blockedReason: reason } });
            return;
        }
        if (!this.controller.config.outputArmed || this.controller.interlock) {
            const reason = 'Live output was disarmed before this queued command could be sent.';
            this.controller.recordCommandResult(command.id, { sent: false, reason });
            return;
        }
        if (this.dispatching.has(command.id)) return;
        const prior = this.ledger?.commandResult(command.id);
        if (prior?.sent === true) {
            this.controller.recordCommandResult(command.id, { sent: false, duplicateBlocked: true, reason: 'Command already completed in the durable ledger.' });
            return;
        }
        this.dispatching.add(command.id);
        try {
            const result = await this.dispatcher.handle({ type: 'command', command: { type: 'sim-chat', value: { text: command.text } } });
            if (result?.sent !== true) this.controller.tripLiveInterlock(`iRacing command path failed: ${result?.reason || 'no successful local send result'}`);
            this.controller.recordCommandResult(command.id, result);
        } catch (error) {
            this.controller.tripLiveInterlock(`iRacing command path failed: ${error.message}`);
            this.controller.recordCommandResult(command.id, { sent: false, reason: error.message });
            this.controller.emit('attention', { type: 'command-failed', result: { uniqueCars: 0, blockedReason: `iRacing command failed: ${error.message}` } });
        } finally {
            this.dispatching.delete(command.id);
        }
    }
}

function paceCarIdxFromYaml(yaml) {
    try {
        const driverInfo = YAML.parse(yaml)?.DriverInfo;
        const arrayIndex = Number(driverInfo?.PaceCarIdx);
        const carIdx = Number(driverInfo?.Drivers?.[arrayIndex]?.CarIdx);
        return Number.isInteger(carIdx) && carIdx >= 0 ? carIdx : null;
    } catch (_) { return null; }
}

function currentSessionFromTelemetry(session, sessionNum) {
    const target = Number(sessionNum);
    if (!Number.isInteger(target)) return null;
    return session?.sessionInfo?.sessions?.find(item => Number(item.num) === target) || null;
}

function sessionIdentity(session, sessionNum) {
    const subSessionId = Number(session?.weekendInfo?.subSessionId);
    const number = Number(sessionNum);
    return Number.isInteger(subSessionId) && subSessionId > 0 && Number.isInteger(number) && number >= 0 ? `${subSessionId}:${number}` : null;
}

function replayFrameGap(frame, end) {
    const current = Number(frame); const latest = Number(end);
    return Number.isFinite(current) && Number.isFinite(latest) && latest >= current ? latest - current : null;
}

function replayIsLive(frame, end, toleranceFrames = 180) {
    const gap = replayFrameGap(frame, end);
    return gap != null && gap <= toleranceFrames;
}

module.exports = { ControllerService, TELEMETRY, CAUTION_FLAGS, paceCarIdxFromYaml, currentSessionFromTelemetry, sessionIdentity, replayFrameGap, replayIsLive };
