'use strict';

const { EventEmitter } = require('events');
const { cloneDefaults } = require('./defaults');
const {
    lockOrder, detectIllegalPasses, waveCandidates, generateSchedule,
    IncidentCluster, physicalOrder,
} = require('./rules');
const { evaluateLiveAuthority } = require('./live-authority');
const { TrackContinuity } = require('./track-continuity');

const ACTIVE_PHASES = new Set(['countdown', 'gathering', 'controlled', 'wave-arounds', 'one-to-green', 'restart', 'green']);

class SafetyCarController extends EventEmitter {
    constructor(config = {}, { now = () => Date.now(), random = Math.random, ledger = null } = {}) {
        super();
        this.now = now;
        this.random = random;
        this.config = mergeConfig(cloneDefaults(), config);
        this.phase = 'idle';
        this.procedure = this.config.procedure;
        this.countdownEndsAt = null;
        this.orderLock = null;
        this.restartLock = null;
        this.violations = new Map();
        this.speedCandidates = new Map();
        this.passCandidates = new Map();
        this.penalties = [];
        this.waveQueue = [];
        this.waved = new Set();
        this.pendingWaves = new Map();
        this.lastWaveAt = 0;
        this.lastReminderAt = 0;
        this.lastLeaderPct = null;
        this.packStableSince = null;
        this.packReady = false;
        this.context = emptyContext();
        this.audit = [];
        this.schedule = generateSchedule(this.config.schedule, this.random);
        this.scheduleCalled = new Set();
        this.nativeYellowCount = 0;
        this.pendingScheduledNativeYellow = false;
        this.incidents = new IncidentCluster(this.config.incidentTrigger);
        this.ledger = ledger;
        this.procedureId = null;
        this.boundSessionIdentity = null;
        this.commandSequence = 0;
        this.emittedCommandIds = new Set();
        this.pendingCommands = new Map();
        this.interlock = null;
        this.recoveryRequired = false;
        this.recoveryState = null;
        this._loadRecovery();
        this.continuity = new TrackContinuity(this.config);
    }

    configure(patch) {
        if (ACTIVE_PHASES.has(this.phase) || this.recoveryRequired) throw new Error('End or resolve the active safety-car procedure before changing its rules.');
        const nextConfig = mergeConfig(this.config, patch || {});
        const scheduleChanged = JSON.stringify(this.config.schedule) !== JSON.stringify(nextConfig.schedule);
        this.config = nextConfig;
        this.procedure = this.config.procedure;
        this.incidents = new IncidentCluster(this.config.incidentTrigger);
        if (scheduleChanged) {
            this.schedule = generateSchedule(this.config.schedule, this.random);
            this.scheduleCalled.clear();
        }
        this.pendingScheduledNativeYellow = false;
        this._record('configuration-updated', { config: this.config, schedule: this.schedule });
        this._publish();
        return this.snapshot();
    }

    updateContext(context) {
        this.context = { ...this.context, ...(context || {}) };
        this.continuity.update(this.context.drivers, this.now());
        this._tick();
        return this.snapshot();
    }

    deploy(procedure = this.config.procedure, reason = 'Race Control') {
        if (ACTIVE_PHASES.has(this.phase) || this.recoveryRequired) throw new Error('A safety-car procedure is already active or requires recovery.');
        this._requireRaceContext();
        this.procedure = procedure;
        this.procedureId = `${this.context.sessionIdentity || 'rehearsal'}:${this.now()}`;
        this.boundSessionIdentity = this.context.sessionIdentity || null;
        this.commandSequence = 0;
        this.emittedCommandIds.clear();
        this.interlock = null;
        const label = procedureLabel(procedure);
        if (procedure === 'native') {
            this.phase = 'controlled';
            this.orderLock = lockOrder(this.context.drivers, this.now());
            this._command('chat', '!yellow GSRC SAFETY CAR DEPLOYED');
            this._command('chat', '!pitclose');
            this._announce(`SAFETY CAR DEPLOYED — ${reason}. PITS CLOSED. FOLLOW iRACING PACE INSTRUCTIONS.`, 'deploy-native');
        } else if (procedure === 'manual-driver') {
            this.phase = 'gathering';
            this.orderLock = lockOrder(this.context.drivers, this.now());
            this._command('chat', '!pitclose');
            this._announce(`GSRC SAFETY CAR DEPLOYED — ${reason}. SAFETY CAR DRIVER: LEAVE PIT LANE. FIELD: 80 KM/H, NO OVERTAKING.`, 'deploy-manual');
        } else {
            this.phase = 'countdown';
            this.countdownEndsAt = this.now() + this.config.countdownSeconds * 1000;
            this._command('chat', '!pitclose');
            const strict = procedure === 'code80-strict';
            this._announce(`${strict ? 'STRICT CODE 80' : 'GSRC CODE 80 SAFETY CAR'} DEPLOYING IN ${this.config.countdownSeconds} SECONDS — LIFT NOW — LIMIT 80 KM/H — NO OVERTAKING.`, 'deploy-code80');
        }
        this._record('deployed', { procedure, reason, label });
        this._publish();
        return this.snapshot();
    }

    cancel(reason = 'Cancelled by Race Control') {
        if (this.phase === 'idle') return this.snapshot();
        this._announce(`SAFETY CAR PROCEDURE CANCELLED — ${reason}. REMAIN UNDER RACE CONTROL INSTRUCTIONS.`, 'cancel');
        this._record('cancelled', { reason });
        this._resetProcedure();
        this._publish();
        return this.snapshot();
    }

    markPackReady() {
        this._requireActiveAuthority();
        if (!['gathering', 'controlled'].includes(this.phase)) throw new Error('The field is not in a gathering phase.');
        this.packReady = true;
        this.phase = this.config.waveArounds && this.procedure !== 'code80-strict' ? 'wave-arounds' : 'controlled';
        if (this.phase === 'wave-arounds' && !this._refreshWaveQueue().length) this.phase = 'controlled';
        if (this.phase === 'wave-arounds' && this.config.waveMode === 'automatic' && !this.lastWaveAt) {
            this.lastWaveAt = this.now() - this.config.waveIntervalSeconds * 1000;
        }
        if (this.config.pitPolicy === 'close-deploy-open-stable') this._command('chat', '!pitopen');
        this._announce(this.phase === 'wave-arounds'
            ? `FIELD STABLE — WAVE-AROUNDS MAY BEGIN. NO OVERTAKING UNLESS DIRECTED.`
            : `FIELD STABLE — HOLD 80 KM/H AND MAINTAIN ORDER.`, 'pack-ready');
        this._record('pack-ready', { waveCandidates: this.waveQueue.map(d => d.carIdx) });
        this._publish();
        return this.snapshot();
    }

    issueWave(carIdx) {
        this._requireActiveAuthority();
        if (!this.config.waveArounds) throw new Error('Wave-arounds are disabled.');
        if (this.phase !== 'wave-arounds') throw new Error('Wave-arounds can begin only after the field is marked stable.');
        const candidate = this._refreshWaveQueue().find(d => d.carIdx === Number(carIdx));
        if (!candidate) throw new Error('That car is not currently eligible for a wave-around.');
        this.lastWaveAt = this.now();
        const announcement = {
            text: `CAR ${candidate.carNumber}, ${candidate.name}: WAVE-AROUND AUTHORIZED. PASS SAFELY. ALL OTHER CARS HOLD POSITION.`,
            audioCue: 'wave-around', carIdx: candidate.carIdx,
            speechText: `You are waved around number ${speakCarNumber(candidate.carNumber)}. Pass safely and rejoin at the end of the line.`,
        };
        const waveCommand = this._command('chat', `!waveby #${candidate.carNumber} GSRC WAVE-AROUND — PASS SAFELY AND REJOIN AT END OF LINE`, { commandKey: `wave:${candidate.carIdx}`, targetCarIdx: candidate.carIdx });
        if (waveCommand?.armed) this.pendingWaves.set(waveCommand.id, { carIdx: candidate.carIdx, announcement, candidate: { carIdx: candidate.carIdx, carNumber: candidate.carNumber, name: candidate.name } });
        else {
            this.waved.add(candidate.carIdx);
            this._announce(announcement.text, announcement.audioCue, announcement.carIdx, announcement.speechText);
            this._record('wave-around', { carIdx: candidate.carIdx, carNumber: candidate.carNumber, name: candidate.name, preview: true });
        }
        this._record('wave-around-requested', { carIdx: candidate.carIdx, carNumber: candidate.carNumber, name: candidate.name, commandId: waveCommand?.id || null });
        this._publish();
        return this.snapshot();
    }

    oneToGreen() {
        this._requireActiveAuthority();
        if (!['controlled', 'wave-arounds', 'gathering'].includes(this.phase)) throw new Error('One-to-green is not available in the current phase.');
        this.phase = 'one-to-green';
        this._command('chat', '!pitopen');
        this._announce(`ONE TO GREEN — LEADER CONTROLS PACE. HOLD ORDER. NO OVERTAKING UNTIL THE CONTROL LINE.`, 'one-to-green');
        this._record('one-to-green');
        this._publish();
        return this.snapshot();
    }

    beginRestart() {
        this._requireActiveAuthority();
        if (this.phase !== 'one-to-green') throw new Error('Call one-to-green before starting the restart.');
        this.phase = 'restart';
        this.restartLock = lockOrder(this.context.drivers, this.now());
        const leader = physicalOrder(this.context.drivers)[0];
        this.lastLeaderPct = leader?.lapDistPct ?? null;
        this._announce(`RESTART ARMED — LEADER MAY ACCELERATE IN THE RESTART ZONE. NO OVERTAKING BEFORE THE CONTROL LINE.`, 'restart-armed');
        this._record('restart-armed', { leaderCarIdx: leader?.carIdx || null });
        this._publish();
        return this.snapshot();
    }

    forceGreen() {
        if (!ACTIVE_PHASES.has(this.phase) || this.phase === 'green') throw new Error('No releasable safety-car procedure is active.');
        this._requireActiveAuthority();
        this._goGreen('operator');
        return this.snapshot();
    }

    adjustPaceLaps(delta) {
        this._requireActiveAuthority();
        if (!ACTIVE_PHASES.has(this.phase) || this.procedure !== 'native') throw new Error('Pace laps can be adjusted only during an active iRacing yellow.');
        const amount = Math.trunc(Number(delta));
        if (!amount || Math.abs(amount) > 10) throw new Error('Pace-lap adjustment must be between -10 and +10.');
        const signed = amount > 0 ? `+${amount}` : String(amount);
        this._command('chat', `!pacelaps ${signed}`);
        this._record('pace-laps-adjusted', { delta: amount });
        this._publish();
        return this.snapshot();
    }

    noteNativeYellow() {
        this.nativeYellowCount += 1;
        const scheduleAlreadyAccounted = this.pendingScheduledNativeYellow;
        this.pendingScheduledNativeYellow = false;
        if (this.config.nativeYellowsCount && !scheduleAlreadyAccounted) this._consumeNextSchedule('native-yellow');
        this._record('native-yellow-seen', { count: this.nativeYellowCount, scheduleAlreadyAccounted });
        this._publish();
    }

    addIncident(event) {
        if (!this.config.incidentTrigger.enabled || Number(event.points) !== 4) return { action: 'none' };
        const result = this.incidents.add({ ...event, at: event.at || this.now() });
        if (result.action === 'review') {
            this._record('incident-cluster-review', result);
            this.emit('attention', { type: 'incident-cluster', result });
        } else if (result.action === 'deploy' && this.config.controlMode === 'automatic' && this.phase === 'idle') {
            try {
                this._record('incident-cluster-auto-deploy', result);
                this.deploy(this.config.procedure, `${result.uniqueCars}-car 4x cluster`);
            } catch (error) {
                const blocked = { ...result, action: 'review', blockedReason: error.message };
                this._record('incident-cluster-auto-blocked', blocked);
                this.emit('attention', { type: 'incident-cluster-blocked', result: blocked });
                return blocked;
            }
        }
        return result;
    }

    scheduleStatus() {
        return this.schedule.map((point, index) => ({ index, point, called: this.scheduleCalled.has(index) }));
    }

    snapshot() {
        const authority = evaluateLiveAuthority(this.context, ACTIVE_PHASES.has(this.phase) ? this.boundSessionIdentity : null);
        return {
            phase: this.phase,
            procedure: this.procedure,
            active: ACTIVE_PHASES.has(this.phase),
            procedureId: this.procedureId,
            boundSessionIdentity: this.boundSessionIdentity,
            authority,
            interlock: this.interlock,
            recoveryRequired: this.recoveryRequired,
            recovery: this.recoveryRequired ? recoverySummary(this.recoveryState) : null,
            countdownRemaining: this.countdownEndsAt ? Math.max(0, Math.ceil((this.countdownEndsAt - this.now()) / 1000)) : 0,
            config: this.config,
            context: this.context,
            orderLock: this.orderLock,
            violations: [...this.violations.values()],
            penalties: this.penalties,
            waveQueue: this._refreshWaveQueue(),
            schedule: this.scheduleStatus(),
            audit: this.audit.slice(-150),
        };
    }

    _tick() {
        const now = this.now();
        if (ACTIVE_PHASES.has(this.phase) && !this.context.simulated) {
            const authority = evaluateLiveAuthority(this.context, this.boundSessionIdentity);
            if (!authority.ok) {
                this._tripInterlock(authority.reason);
                this._publish();
                return;
            }
            if (this.interlock) { this._publish(); return; }
        }
        if (this.phase === 'countdown' && now >= this.countdownEndsAt) {
            this.countdownEndsAt = null;
            this.orderLock = lockOrder(this.context.drivers, now);
            this.phase = this.procedure === 'code80-strict' ? 'controlled' : 'gathering';
            this._announce(`${this.procedure === 'code80-strict' ? 'STRICT CODE 80' : 'CODE 80'} ACTIVE — 80 KM/H MAXIMUM — NO OVERTAKING.`, 'code80-active');
            if (this.procedure === 'code80-bunch') {
                const leader = physicalOrder(this.context.drivers)[0];
                this._announce(`LEADER CAR ${leader?.carNumber || ''}: TARGET ${this.config.leaderGatherKph} KM/H UNTIL THE PACK IS STABLE. FIELD MAY RUN UP TO ${this.config.speedLimitKph} KM/H TO CLOSE GAPS.`, 'leader-gather', leader?.carIdx || null);
            }
            this._record('code80-active', { lockedCars: this.orderLock.entries.length });
        }
        const autoPackEligible = !this.packReady && this.config.waveArounds && this.config.waveMode === 'automatic' && (
            this.phase === 'gathering' && ['code80-bunch', 'manual-driver'].includes(this.procedure) ||
            this.phase === 'controlled' && this.procedure === 'native'
        );
        if (autoPackEligible) {
            if (this._packIsStable(this.procedure === 'code80-bunch')) {
                this.packStableSince ??= now;
                if (now - this.packStableSince >= this.config.packStableHoldSeconds * 1000) this.markPackReady();
            } else this.packStableSince = null;
        }
        if (['gathering', 'controlled', 'wave-arounds', 'one-to-green'].includes(this.phase)) {
            if (this.procedure !== 'native') this._enforceSpeedAndOrder(now, this.orderLock);
            if (now - this.lastReminderAt >= this.config.announceNoPassingSeconds * 1000) {
                this.lastReminderAt = now;
                this._announce(this.procedure === 'native'
                    ? 'REMINDER — FOLLOW iRACING PACE INSTRUCTIONS. NO OVERTAKING EXCEPT WHEN DIRECTED.'
                    : 'REMINDER — NO OVERTAKING. MAINTAIN THE LOCKED ORDER UNLESS RACE CONTROL DIRECTS YOU.', 'no-passing');
            }
            if (this.phase === 'wave-arounds' && this.config.waveMode === 'automatic' && now - this.lastWaveAt >= this.config.waveIntervalSeconds * 1000) {
                const next = this._refreshWaveQueue()[0];
                if (next) this.issueWave(next.carIdx);
            }
        }
        if (this.phase === 'restart') {
            this._enforceSpeedAndOrder(now, this.restartLock, true);
            const leaderIdx = this.restartLock?.entries?.[0]?.carIdx;
            const leader = (this.context.drivers || []).find(d => d.carIdx === leaderIdx);
            if (leader && Number.isFinite(this.lastLeaderPct) && this.lastLeaderPct > 0.8 && leader.lapDistPct < 0.2) this._goGreen('control-line');
            this.lastLeaderPct = leader?.lapDistPct ?? this.lastLeaderPct;
        }
        this._checkSchedule();
        this._publish();
    }

    _enforceSpeedAndOrder(now, lock, restartOnly = false) {
        const drivers = this.context.drivers || [];
        const exempt = new Set([...this.waved, ...this.continuity.exemptions(now), ...drivers.filter(driver => driver.onPitRoad).map(driver => driver.carIdx)]);
        const observedPasses = detectIllegalPasses(lock, drivers, exempt);
        const passes = restartOnly ? observedPasses : observedPasses.filter(pass => {
            const key = `${pass.type}:${pass.carIdx}`;
            const firstSeenAt = this.passCandidates.get(key) ?? now;
            this.passCandidates.set(key, firstSeenAt);
            return now - firstSeenAt >= this.config.passObservationSeconds * 1000;
        });
        const observedPassKeys = new Set(observedPasses.map(pass => `${pass.type}:${pass.carIdx}`));
        for (const key of this.passCandidates.keys()) if (!observedPassKeys.has(key)) this.passCandidates.delete(key);
        for (const pass of passes) {
            this._touchViolation(pass, now, restartOnly ? this.config.restartPassPenalty : this.config.penalty, restartOnly);
        }
        const speedViolations = [];
        if (!restartOnly) {
            const leaderCarIdx = lock?.entries?.[0]?.carIdx;
            for (const driver of drivers) {
                if (driver.onPitRoad || driver.inWorld === false) continue;
                let details = null;
                if (driver.speedKph > this.config.speedLimitKph + this.config.speedToleranceKph) {
                    details = { type: 'speeding', carIdx: driver.carIdx, carNumber: driver.carNumber, name: driver.name, speedKph: driver.speedKph, targetKph: this.config.speedLimitKph };
                } else if (this.phase === 'gathering' && this.procedure === 'code80-bunch' && driver.carIdx === leaderCarIdx && driver.speedKph > this.config.leaderGatherKph + this.config.speedToleranceKph) {
                    details = { type: 'leader-pace', carIdx: driver.carIdx, carNumber: driver.carNumber, name: driver.name, speedKph: driver.speedKph, targetKph: this.config.leaderGatherKph };
                }
                if (details) {
                    speedViolations.push(details);
                    const key = `${details.type}:${details.carIdx}`;
                    const firstSeenAt = this.speedCandidates.get(key) ?? now;
                    this.speedCandidates.set(key, firstSeenAt);
                    if (now - firstSeenAt >= this.config.speedGraceSeconds * 1000) this._touchViolation(details, now, this.config.penalty);
                }
            }
        }
        const activeKeys = new Set([
            ...passes.map(v => `${v.type}:${v.carIdx}`),
            ...speedViolations.map(v => `${v.type}:${v.carIdx}`),
        ]);
        for (const [key, violation] of this.violations) {
            if (activeKeys.has(key) || violation.status === 'penalty-queued') continue;
            violation.status = 'corrected'; violation.correctedAt = now;
        }
        for (const key of this.speedCandidates.keys()) if (!activeKeys.has(key)) this.speedCandidates.delete(key);
    }

    _touchViolation(details, now, penalty, immediate = false) {
        const key = `${details.type}:${details.carIdx}`;
        let item = this.violations.get(key);
        if (!item) {
            const correctionSeconds = immediate ? 0 : this.config.passCorrectionSeconds;
            item = { ...details, key, firstSeenAt: now, lastSeenAt: now, deadlineAt: now + correctionSeconds * 1000, status: 'warning', penalty };
            this.violations.set(key, item);
            const instruction = details.type === 'illegal-pass'
                ? immediate ? 'RETURN THE POSITION IMMEDIATELY' : `RETURN THE POSITION WITHIN ${this.config.passCorrectionSeconds} SECONDS`
                : `SLOW TO ${details.targetKph} KM/H NOW`;
            const violationLabel = details.type === 'illegal-pass' ? 'ILLEGAL OVERTAKE'
                : details.type === 'leader-pace' ? `LEADER GATHER PACE ${Math.round(details.speedKph)} KM/H`
                    : `SPEED ${Math.round(details.speedKph)} KM/H`;
            this._announce(`WARNING CAR ${details.carNumber}, ${details.name}: ${violationLabel}. ${instruction}.`, 'violation-warning', details.carIdx);
            this._record('violation-warning', item);
        } else {
            Object.assign(item, details, { lastSeenAt: now });
            if (item.status === 'corrected') { item.status = 'warning'; item.deadlineAt = now + this.config.passCorrectionSeconds * 1000; }
        }
        if (item.status === 'warning' && now >= item.deadlineAt) {
            item.status = 'penalty-queued';
            this.penalties.push({ carIdx: item.carIdx, carNumber: item.carNumber, name: item.name, reason: item.type, penalty, queuedAt: now, status: 'deferred-until-green' });
            const reason = item.type === 'illegal-pass' ? 'POSITION NOT RETURNED' : item.type === 'leader-pace' ? 'LEADER GATHER TARGET NOT OBEYED' : 'CODE 80 SPEED NOT OBEYED';
            this._announce(`CAR ${item.carNumber}: ${reason}. ${penaltyLabel(penalty).toUpperCase()} QUEUED FOR GREEN-FLAG RACING.`, 'penalty-queued', item.carIdx);
            this._record('penalty-queued', item);
        }
    }

    _goGreen(trigger) {
        this.phase = 'green';
        this._announce('GREEN FLAG — RACING RESUMED. DEFERRED PENALTIES ARE NOW ACTIVE.', 'green');
        for (const penalty of this.penalties.filter(p => p.status === 'deferred-until-green')) {
            const command = this._command('chat', `!black #${penalty.carNumber} ${penalty.penalty}`, { commandKey: `penalty:${penalty.carIdx}:${penalty.reason}`, penaltyCarIdx: penalty.carIdx, penaltyReason: penalty.reason });
            penalty.commandId = command?.id || null;
            penalty.status = command?.armed ? 'send-pending' : 'preview-not-issued';
        }
        this._record('green', { trigger, penaltyCommandsQueued: this.penalties.filter(p => p.status === 'send-pending').length });
        this._maybeFinalizeGreen();
    }

    _checkSchedule() {
        if (!this.config.schedule.enabled || this.config.controlMode !== 'automatic' || this.phase !== 'idle') return;
        const value = this.config.schedule.basis === 'minutes' ? Number(this.context.sessionTime || 0) / 60 : Number(this.context.leaderLap || 0);
        const due = this.scheduleStatus().find(item => !item.called && value >= item.point);
        if (due) {
            this.scheduleCalled.add(due.index);
            this.pendingScheduledNativeYellow = this.config.procedure === 'native';
            this.deploy(this.config.procedure, `scheduled ${this.config.schedule.basis === 'minutes' ? 'minute' : 'lap'} ${due.point}`);
        }
    }

    _consumeNextSchedule(reason) {
        const next = this.scheduleStatus().find(item => !item.called);
        if (next) { this.scheduleCalled.add(next.index); this._record('schedule-consumed', { index: next.index, point: next.point, reason }); }
    }

    _packIsStable(requireLeaderTarget = true) {
        const trackLengthM = Number(this.context.trackLengthM);
        if (!(trackLengthM > 0)) return false;
        const order = physicalOrder(this.context.drivers).filter(d => !d.onPitRoad && Number.isFinite(d.lapDistPct));
        if (order.length < 2) return false;
        const leader = order[0];
        if (requireLeaderTarget && Number.isFinite(leader.speedKph) && leader.speedKph > this.config.leaderGatherKph + this.config.speedToleranceKph) return false;
        const offsets = order.map(d => ((Number(leader.lapDistPct) - Number(d.lapDistPct)) + 1) % 1).sort((a, b) => a - b);
        const secondsPerLapAtLimit = trackLengthM / (this.config.speedLimitKph / 3.6);
        for (let i = 1; i < offsets.length; i += 1) {
            if ((offsets[i] - offsets[i - 1]) * secondsPerLapAtLimit > this.config.packGapSeconds) return false;
        }
        return true;
    }

    _refreshWaveQueue() {
        if (!this.config.waveArounds || !['wave-arounds'].includes(this.phase)) {
            this.waveQueue = [];
            return this.waveQueue;
        }
        const leaderCarIdx = this.orderLock?.entries?.[0]?.carIdx || physicalOrder(this.context.drivers)[0]?.carIdx;
        const pendingCars = new Set([...this.pendingWaves.values()].map(value => typeof value === 'object' ? value.carIdx : value));
        this.waveQueue = waveCandidates(this.context.drivers, leaderCarIdx, { referencePct: this.context.paceCarLapDistPct })
            .filter(d => !this.waved.has(d.carIdx) && !pendingCars.has(d.carIdx));
        return this.waveQueue;
    }

    acknowledgeInterlock() {
        if (!this.interlock) return this.snapshot();
        const authority = evaluateLiveAuthority(this.context, this.boundSessionIdentity);
        if (!authority.ok) throw new Error(authority.reason);
        const previous = this.interlock;
        this.interlock = null;
        this._record('authority-interlock-acknowledged', { previous, outputArmed: false });
        this._publish();
        return this.snapshot();
    }

    tripLiveInterlock(reason) {
        if (this.context.simulated) return this.snapshot();
        this._tripInterlock(reason || 'The local iRacing command path failed.');
        this._publish();
        return this.snapshot();
    }

    setOutputArmed(active) {
        const armed = !!active;
        if (armed) {
            if (this.context.simulated) throw new Error('Live output cannot be armed in rehearsal mode.');
            const authority = evaluateLiveAuthority(this.context, ACTIVE_PHASES.has(this.phase) ? this.boundSessionIdentity : null);
            if (!authority.ok) throw new Error(authority.reason);
            if (this.interlock || this.recoveryRequired) throw new Error('Resolve the live-operation interlock before arming output.');
        }
        this.config = { ...this.config, outputArmed: armed };
        this._record(armed ? 'live-output-armed' : 'live-output-disarmed', { sessionIdentity: this.context.sessionIdentity || null });
        this._publish();
        return this.snapshot();
    }

    resolveRecovery(mode) {
        if (!this.recoveryRequired || !this.recoveryState) throw new Error('No interrupted procedure requires recovery.');
        if (mode === 'close') {
            this._record('recovery-closed', { procedureId: this.recoveryState.procedureId });
            this.recoveryRequired = false; this.recoveryState = null; this._resetProcedure(); this._publish();
            return this.snapshot();
        }
        if (mode !== 'resume') throw new Error('Recovery mode must be resume or close.');
        const authority = evaluateLiveAuthority(this.context, this.recoveryState.boundSessionIdentity);
        if (!authority.ok) throw new Error(authority.reason);
        this._restoreActiveState(this.recoveryState);
        this.config = { ...this.config, outputArmed: false };
        this.recoveryRequired = false; this.recoveryState = null; this.interlock = null;
        this._record('recovery-resumed-disarmed', { procedureId: this.procedureId, sessionIdentity: this.boundSessionIdentity });
        this._publish();
        return this.snapshot();
    }

    recordCommandResult(commandId, result) {
        const sent = result?.sent === true;
        this.pendingCommands.delete(commandId);
        const pendingWave = this.pendingWaves.get(commandId);
        if (pendingWave != null) {
            this.pendingWaves.delete(commandId);
            const waveCarIdx = typeof pendingWave === 'object' ? pendingWave.carIdx : pendingWave;
            if (sent) {
                this.waved.add(waveCarIdx);
                if (pendingWave.announcement) this._announce(pendingWave.announcement.text, pendingWave.announcement.audioCue, pendingWave.announcement.carIdx, pendingWave.announcement.speechText);
                this._record('wave-around', { ...(pendingWave.candidate || { carIdx: waveCarIdx }), commandId, preview: false });
            } else {
                this.emittedCommandIds.delete(commandId);
                this._record('wave-around-send-failed', { carIdx: waveCarIdx, commandId, reason: result?.reason || 'No successful local send result.' });
            }
        }
        const penalty = this.penalties.find(item => item.commandId === commandId);
        if (penalty) {
            penalty.status = sent ? 'issued-local-path' : 'send-failed';
            if (sent) penalty.issuedAt = this.now();
            else this.emittedCommandIds.delete(commandId);
        }
        if (!sent) this.emittedCommandIds.delete(commandId);
        this._record('command-result', { commandId, result });
        this._maybeFinalizeGreen();
        this._publish();
    }

    _maybeFinalizeGreen() {
        if (this.phase !== 'green' || this.interlock || this.pendingCommands.size || this.penalties.some(item => item.status === 'send-pending')) return;
        setImmediate(() => {
            if (this.phase !== 'green' || this.interlock || this.pendingCommands.size || this.penalties.some(item => item.status === 'send-pending')) return;
            this._record('green-command-queue-complete', { issued: this.penalties.filter(item => item.status === 'issued-local-path').length, failed: this.penalties.filter(item => item.status === 'send-failed').length });
            this._resetProcedure(true);
            this._publish();
        });
    }

    _announce(text, audioCue, carIdx = null, speechText = null) { this._command('announce', `/all ${text}`, { text, speechText: speechText || text, audioCue, carIdx }); }
    _command(kind, text, extra = {}) {
        const suffix = extra.commandKey || `sequence:${++this.commandSequence}`;
        const id = `${this.procedureId || 'idle'}:${suffix}`;
        if (this.emittedCommandIds.has(id)) { this._record('command-duplicate-blocked', { commandId: id, kind, text }); return null; }
        this.emittedCommandIds.add(id);
        const command = { id, at: this.now(), kind, text, armed: !!this.config.outputArmed && !this.context.simulated && !this.interlock, ...extra };
        if (command.armed) this.pendingCommands.set(id, { kind, text, at: command.at });
        this.emit('command', command);
        this._record('command', command);
        this._persistRecovery();
        return command;
    }
    _record(type, data = {}) {
        this.audit.push({ at: this.now(), type, ...data });
        if (this.audit.length > 1000) this.audit.splice(0, this.audit.length - 1000);
        this.ledger?.append(type, data);
    }
    _publish() { this._persistRecovery(); this.emit('state', this.snapshot()); }
    _requireRaceContext() {
        const authority = evaluateLiveAuthority(this.context);
        if (!authority.ok) throw new Error(authority.reason);
    }
    _requireActiveAuthority() {
        const authority = evaluateLiveAuthority(this.context, this.boundSessionIdentity);
        if (!authority.ok) { this._tripInterlock(authority.reason); throw new Error(authority.reason); }
        if (this.interlock) throw new Error(`Live operation paused: ${this.interlock.reason}`);
    }
    _tripInterlock(reason) {
        if (this.interlock?.reason === reason) return;
        this.config = { ...this.config, outputArmed: false };
        this.interlock = { at: this.now(), reason };
        this._record('authority-interlock-tripped', this.interlock);
        this.emit('attention', { type: 'authority-interlock', result: { uniqueCars: 0, blockedReason: reason } });
    }
    _resetProcedure(keepGreen = false) {
        this.phase = keepGreen ? 'idle' : 'idle';
        this.countdownEndsAt = null;
        this.orderLock = null;
        this.restartLock = null;
        this.waveQueue = [];
        this.waved.clear();
        this.pendingWaves.clear();
        this.lastWaveAt = 0;
        this.lastReminderAt = 0;
        this.lastLeaderPct = null;
        this.packStableSince = null;
        this.packReady = false;
        this.violations.clear();
        this.speedCandidates.clear();
        this.passCandidates.clear();
        this.incidents.reset();
        this.pendingScheduledNativeYellow = false;
        this.procedureId = null;
        this.boundSessionIdentity = null;
        this.commandSequence = 0;
        this.emittedCommandIds.clear();
        this.pendingCommands.clear();
        this.interlock = null;
        this.continuity.reset();
        this.ledger?.clearActiveState();
    }
    _persistRecovery() {
        if (!this.ledger) return;
        if (!ACTIVE_PHASES.has(this.phase)) { if (!this.recoveryRequired) this.ledger.clearActiveState(); return; }
        this.ledger.saveActiveState(this._serializeActiveState());
    }
    _serializeActiveState() {
        return {
            schemaVersion: 1, active: true, savedAt: this.now(), procedureId: this.procedureId,
            boundSessionIdentity: this.boundSessionIdentity, phase: this.phase, procedure: this.procedure,
            countdownEndsAt: this.countdownEndsAt, orderLock: this.orderLock, restartLock: this.restartLock,
            violations: [...this.violations.entries()], speedCandidates: [...this.speedCandidates.entries()], passCandidates: [...this.passCandidates.entries()], penalties: this.penalties, waved: [...this.waved], pendingWaves: [...this.pendingWaves.entries()], continuity: this.continuity.serialize(),
            lastWaveAt: this.lastWaveAt, lastReminderAt: this.lastReminderAt, lastLeaderPct: this.lastLeaderPct,
            packStableSince: this.packStableSince, packReady: this.packReady, schedule: this.schedule,
            scheduleCalled: [...this.scheduleCalled], nativeYellowCount: this.nativeYellowCount,
            pendingScheduledNativeYellow: this.pendingScheduledNativeYellow, commandSequence: this.commandSequence,
            emittedCommandIds: [...this.emittedCommandIds], pendingCommands: [...this.pendingCommands.entries()], config: { ...this.config, outputArmed: false },
        };
    }
    _loadRecovery() {
        const saved = this.ledger?.loadActiveState();
        if (!saved?.active || !ACTIVE_PHASES.has(saved.phase)) return;
        this.recoveryRequired = true; this.recoveryState = saved; this.config.outputArmed = false;
        this._record('recovery-required', { procedureId: saved.procedureId, phase: saved.phase, boundSessionIdentity: saved.boundSessionIdentity });
    }
    _restoreActiveState(saved) {
        this.phase = saved.phase; this.procedure = saved.procedure; this.procedureId = saved.procedureId;
        this.boundSessionIdentity = saved.boundSessionIdentity; this.countdownEndsAt = saved.countdownEndsAt;
        this.orderLock = saved.orderLock; this.restartLock = saved.restartLock;
        this.violations = new Map(saved.violations || []); this.speedCandidates = new Map(saved.speedCandidates || []); this.passCandidates = new Map(saved.passCandidates || []); this.penalties = saved.penalties || [];
        this.waved = new Set(saved.waved || []); this.pendingWaves = new Map(saved.pendingWaves || []); this.lastWaveAt = saved.lastWaveAt || 0;
        this.lastReminderAt = saved.lastReminderAt || 0; this.lastLeaderPct = saved.lastLeaderPct ?? null;
        this.packStableSince = saved.packStableSince ?? null; this.packReady = !!saved.packReady;
        this.schedule = saved.schedule || this.schedule; this.scheduleCalled = new Set(saved.scheduleCalled || []);
        this.nativeYellowCount = saved.nativeYellowCount || 0; this.pendingScheduledNativeYellow = !!saved.pendingScheduledNativeYellow;
        this.commandSequence = saved.commandSequence || 0; this.emittedCommandIds = new Set(saved.emittedCommandIds || []);
        this.pendingCommands = new Map(saved.pendingCommands || []);
        this.config = mergeConfig(this.config, { ...(saved.config || {}), outputArmed: false });
        this.continuity = new TrackContinuity(this.config); this.continuity.restore(saved.continuity || []);
    }
}

function procedureLabel(value) {
    return ({ native: 'iRacing Full-Course Yellow', 'manual-driver': 'Human Safety Car', 'code80-strict': 'Strict Code 80', 'code80-bunch': 'GSRC Code 80 Safety Car' })[value] || value;
}
function speakCarNumber(value) {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    return String(value || '').split('').map(char => words[Number(char)] ?? char).join(' ');
}
function penaltyLabel(value) {
    if (String(value).toUpperCase() === 'D') return 'drive-through';
    if (String(value) === '0') return 'stop-and-go';
    return `${Number(value) || 0}-second stop-and-hold`;
}
function emptyContext() { return { connected: false, simulated: false, stale: true, isRace: false, replayLive: false, sessionIdentity: null, drivers: [], sessionTime: 0, leaderLap: 0, trackLengthM: null, paceCarLapDistPct: null }; }
function recoverySummary(saved) { return saved ? { procedureId: saved.procedureId, phase: saved.phase, procedure: saved.procedure, savedAt: saved.savedAt, boundSessionIdentity: saved.boundSessionIdentity, queuedPenalties: (saved.penalties || []).filter(item => item.status === 'deferred-until-green').length } : null; }
function mergeConfig(base, patch) {
    return { ...base, ...patch, schedule: { ...base.schedule, ...(patch.schedule || {}) }, incidentTrigger: { ...base.incidentTrigger, ...(patch.incidentTrigger || {}) }, audio: { ...base.audio, ...(patch.audio || {}) } };
}

module.exports = { SafetyCarController, procedureLabel, ACTIVE_PHASES, mergeConfig, speakCarNumber };
