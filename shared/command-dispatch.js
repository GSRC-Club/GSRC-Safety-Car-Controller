// src/command-dispatch.js
// Translates server→relay { type:'command', command } messages (sent by the GSRC
// Broadcaster Panel / Auto-Director via POST /api/broadcast/command →
// telemetryIngest.sendCommand) into iRacing broadcast messages (broadcast-cmd.js).
//
// Command shapes (see docs/broadcast-relay-protocol.md):
//   { type:'camera-target', carNumber | carIdx }             → point active cam at car, keep group
//   { type:'camera', group }                                 → switch camera group, KEEP current car
//   { type:'next-camera', group }                            → arm: next camera change uses this group
//   { type:'replay', action:'play'|'pause'|'rewind'|'live'|'jump'|'marker', seconds? }
//   { type:'replay-incident', carNumber|carIdx, value:{ replayFrame, sessionTime, sessionNum } }
//
// To target the right car / group the dispatcher needs live state the relay reads
// each tick: updateSession(parsed) gives it the driver map + per-track camera-group
// name→number map; updateTelemetry(values) gives it CamCarIdx / CamGroupNumber /
// ReplayFrameNum etc. Both degrade gracefully when absent.
//
// ⚠ UNVERIFIED on iRacing from the build machine — confirm live on the race PC
// (Phase-0 checklist in AUTODIRECTOR-writepath-relay-spec.md).

const defaultCmd = require('./broadcast-cmd');

function makeDispatcher(config = {}, log = console, deps = {}) {
    const cmd = deps.cmd || defaultCmd;
    // OBS WebSocket client (optional). Injected from relay-runner; null when OBS is
    // disabled or not yet connected. The 'obs' case below returns a soft
    // { sent:false, reason:'obs disabled' } when this is missing.
    const obs = deps.obs || null;
    // Replay tick rate for relative seconds→frames maths (iRacing ≈ 60). Tunable.
    const frameRate = Number(config.replayFrameRate) || 60;
    // Inter-step gap (ms) in the replay-incident sequence so the seek lands before
    // the camera switch + pause. Configurable; 0 in tests for determinism.
    const stepMs = deps.stepMs != null ? deps.stepMs
        : (Number.isFinite(Number(config.incidentStepMs)) ? Number(config.incidentStepMs) : 90);
    const verifyReplayIncidents = config.verifyReplayIncidents === true;
    const serializeCommands = config.serializeCommands === true;
    const replayVerifyPollMs = Math.max(1, Number(config.replayVerifyPollMs) || 50);
    const replaySeekTimeoutMs = Math.max(1, Number(config.replaySeekTimeoutMs) || 1400);
    const replayCameraTimeoutMs = Math.max(1, Number(config.replayCameraTimeoutMs) || 750);
    const replayPlaybackTimeoutMs = Math.max(1, Number(config.replayPlaybackTimeoutMs) || 750);
    const replayRetryDelayMs = Math.max(0, Number(config.replayRetryDelayMs) || 350);
    const replaySessionTimeTolerance = Math.max(0.1, Number(config.replaySessionTimeTolerance) || 2.5);
    const trace = typeof deps.trace === 'function' ? deps.trace : null;
    function emitTrace(event, command, payload = {}) {
        if (!trace) return;
        try {
            trace(event, {
                traceId: command?.diagnosticId || null,
                commandType: command?.type || null,
                diagnosticContext: command?.diagnosticContext || null,
                ...payload,
            });
        } catch (_) { /* diagnostics must never affect command delivery */ }
    }

    // Static operator map from relay-config.json (fallback), merged UNDER the live
    // per-track map parsed from CameraInfo.Groups each SessionInfo update.
    const staticGroupMap = (config && config.cameraGroups) || {};
    let trackGroupMap = {};
    let driverByIdx = new Map();   // carIdx → { carNumber, carNumberRaw, custId }
    let currentSubSessionId = null;
    let availableSessionNums = new Set();
    let tele = {};                 // latest raw telemetry values
    let telemetrySeq = 0;          // increments for every fresh SDK frame
    let armedGroupNum = 0;         // "next camera change goes to this group"
    let commandQueue = Promise.resolve();

    // Frame to restore when the operator hits "Go Live". Captured the FIRST time a
    // replay excursion leaves the current spot (scrub-back / jump-back / incident
    // jump) so "live" returns play to where the broadcast WAS before the replay —
    // not the tape's end (ToEnd), which on a recorded-replay broadcast is the race
    // FINISH. null → fall back to ToEnd (the live edge of a genuinely live session).
    let replayResumeFrame = null;
    function captureResumeFrame() {
        if (replayResumeFrame != null) return;             // keep the FIRST entry's spot
        const f = Number(tele.ReplayFrameNum);
        if (Number.isFinite(f)) replayResumeFrame = f;
    }

    // ── sim-key (raw OS keystroke injection) ──────────────────────────────────
    // Independent of the broadcast-message channel (cmd.init): keystrokes go to the
    // iRacing window via user32, not the IRSDK_BROADCASTMSG protocol. Injectable so
    // tests assert the parsed combo without touching user32. Defaults to cmd.sendKeys.
    const keySender = deps.keySender || (cmd.sendKeys ? (combo) => cmd.sendKeys(combo, log) : null);
    const UIHIDDEN_BIT = (cmd.CAM_STATE && cmd.CAM_STATE.UIHidden) || 0x0008;
    let uiHidden = false;          // tracked toggle so repeated SPACE flips like the bar

    // ── live-state feeds (called from main.js) ────────────────────────────────
    function updateSession(parsed) {
        if (!parsed || typeof parsed !== 'object') return;
        if (parsed.cameraGroups && typeof parsed.cameraGroups === 'object') trackGroupMap = parsed.cameraGroups;
        const subSessionId = Number(parsed.weekendInfo && parsed.weekendInfo.subSessionId);
        currentSubSessionId = Number.isSafeInteger(subSessionId) && subSessionId > 0 ? subSessionId : null;
        const sessions = (parsed.sessionInfo && parsed.sessionInfo.sessions) || [];
        availableSessionNums = new Set(sessions.map(s => Number(s && s.sessionNum)).filter(Number.isInteger));
        const drivers = (parsed.driverInfo && parsed.driverInfo.drivers) || [];
        const m = new Map();
        for (const d of drivers) {
            const idx = Number(d && d.carIdx);
            if (Number.isFinite(idx)) m.set(idx | 0, { carNumber: d.carNumber, carNumberRaw: d.carNumberRaw, custId: d.userID });
        }
        driverByIdx = m;
    }
    function replayIncidentIdentityError(c) {
        const value = c && c.value && typeof c.value === 'object' ? c.value : {};
        const sessionNum = value.sessionNum == null ? null : Number(value.sessionNum);
        if (currentSubSessionId != null) {
            const requested = Number(value.subSessionId);
            if (!Number.isSafeInteger(requested) || requested !== currentSubSessionId) return 'replay incident does not match the loaded iRacing SubSessionID';
            if (!Number.isInteger(sessionNum)) return 'replay incident requires a SessionNum from the loaded SubSession';
        }
        if (sessionNum != null && (!Number.isInteger(sessionNum) || (availableSessionNums.size && !availableSessionNums.has(sessionNum)))) return 'replay incident SessionNum is not present in the loaded SubSession';
        if (c.carIdx != null) {
            const car = driverByIdx.get(Number(c.carIdx) | 0);
            if (!car) return 'replay incident CarIdx is not present in the loaded SubSession';
            if (c.carNumber != null && String(car.carNumber) !== String(c.carNumber)) return 'replay incident car identity does not match the loaded CarIdx';
            if (value.custId != null && Number(car.custId) !== Number(value.custId)) return 'replay incident driver identity does not match the loaded CarIdx';
        }
        return null;
    }
    function updateTelemetry(values) {
        if (values && typeof values === 'object') {
            tele = values;
            telemetrySeq += 1;
        }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    function waitForFreshTelemetry(afterSeq, predicate, timeoutMs) {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            let timer = null;
            const finish = (value) => {
                if (timer) clearTimeout(timer);
                resolve(value);
            };
            const check = () => {
                if (telemetrySeq > afterSeq) {
                    try {
                        if (predicate(tele)) return finish({ ok: true, values: tele, seq: telemetrySeq });
                    } catch (_) { /* keep polling until timeout */ }
                }
                if (Date.now() >= deadline) return finish({ ok: false, values: tele, seq: telemetrySeq });
                timer = setTimeout(check, Math.min(replayVerifyPollMs, Math.max(1, deadline - Date.now())));
            };
            check();
        });
    }

    // ── resolution helpers ────────────────────────────────────────────────────
    function resolveGroup(group) {
        if (group == null || group === '') return 0;
        if (typeof group === 'number') return group | 0;
        if (/^\d+$/.test(String(group))) return parseInt(group, 10);
        const live = trackGroupMap[group];
        if (Number.isFinite(live)) return live | 0;           // live per-track map wins
        const stat = staticGroupMap[group];
        return Number.isFinite(stat) ? (stat | 0) : 0;        // 0 = keep current group
    }
    function currentGroupNum() {
        const g = Number(tele.CamGroupNumber);
        return Number.isFinite(g) ? (g | 0) : 0;
    }
    function currentCar() {
        const idx = Number(tele.CamCarIdx);
        if (!Number.isFinite(idx)) return null;
        return driverByIdx.get(idx | 0) || null;
    }
    // ── scenic-cam lock guard (VERIFIED ON-SIM 2026-06-17) ────────────────────
    // When iRacing parks on the SCENIC camera / session screen, CamCameraState has
    // the IsScenicActive bit (0x02) set, and CamSwitchNum group switches are SILENTLY
    // IGNORED for the group (the car still moves, the group sticks on Scenic=10). A
    // CamSetState that clears the scenic bit unsticks it. We only do this when the
    // relay actually feeds CamCameraState (it's optional in telemetryVars) — when
    // absent, tele.CamCameraState is undefined and this is a no-op, so behaviour is
    // unchanged for existing configs. Add "CamCameraState" to telemetryVars to enable.
    const SCENIC_BIT = (cmd.CAM_STATE && cmd.CAM_STATE.IsScenicActive) || 0x0002;
    function inScenic() {
        const s = Number(tele.CamCameraState);
        return Number.isFinite(s) && (s & SCENIC_BIT) !== 0;
    }
    // Clear scenic if we can SEE we're in it, so the imminent group switch lands.
    // Preserves every other state bit (UIHidden / clean-feed) — only drops scenic.
    function leaveScenicIfStuck() {
        if (!inScenic()) return false;
        const s = Number(tele.CamCameraState) | 0;
        C.camSetState(s & ~SCENIC_BIT);
        log.info && log.info('camera was on the Scenic cam (group switches blocked) — cleared scenic so the switch lands');
        return true;
    }
    // ── per-command send tap (Task 2 diagnostics) ────────────────────────────
    // `C` proxies the broadcast verbs the dispatcher uses, recording the boolean
    // SendNotifyMessage return of each call — the ONLY signal an operator has that
    // a command actually POSTED to the sim. (false = the OS rejected the send;
    // note a no-op-on-sim, e.g. you're in-car, still returns true.) Behaviour is
    // identical to calling cmd.* directly: same args, same return value.
    let _sends = [];   // [{ verb, ok }] for the command currently being handled
    const C = {};
    for (const verb of ['camSwitchNum', 'camSwitchPos', 'camFocusLeader', 'camFocusIncident',
                        'camSetState', 'replaySetPlayPositionFrame', 'replaySearchSessionTime',
                        'replaySetPlaySpeed', 'replaySearch', 'replaySetState']) {
        C[verb] = (...args) => {
            let ok = false;
            try { ok = cmd[verb](...args); } finally { _sends.push({ verb, ok }); }
            return ok;
        };
    }
    // Summarise what posted for the command just handled, e.g. "posted 1/1 (camSwitchNum=true)".
    function sendSummary() {
        if (!_sends.length) return 'no broadcast posted';
        const okN = _sends.filter(s => s.ok === true).length;
        const detail = _sends.map(s => `${s.verb}=${s.ok}`).join(', ');
        return `posted ${okN}/${_sends.length} (${detail})`;
    }

    // Switch to a { carNumber, carNumberRaw } car — prefer the pre-encoded raw number.
    function targetCar(car, groupNum) {
        if (car && car.carNumberRaw != null) return C.camSwitchNum(car.carNumberRaw, groupNum, 0, true);
        if (car && car.carNumber != null) return C.camSwitchNum(car.carNumber, groupNum, 0);
        return false;
    }

    // ── sim-key handler ───────────────────────────────────────────────────────
    // { type:'sim-key', value:{ keys:'<combo>' } } → inject a keystroke into iRacing.
    // Runs WITHOUT the broadcast channel (cmd.init): keystrokes are pure user32, so
    // this works even when the IRSDK_BROADCASTMSG path is down. For keys==='space' we
    // ALSO toggle the SDK UIHidden state via CamSetState (no focus steal, more reliable
    // than the raw bar for hiding the dashboard) IN ADDITION to the keystroke — the
    // frontend contract stays keys:'space'. For everything else (ctrl+r, …) only raw
    // key injection can do it. Never throws.
    function handleSimKey(c) {
        const v = (c && c.value) || {};
        const keys = typeof v.keys === 'string' ? v.keys.trim().toLowerCase() : '';
        if (!keys) {
            log.warn && log.warn('sim-key: missing/empty value.keys — ignored (no-op)');
            return;
        }
        try {
            // SPACE → toggle the in-sim UI via the SDK (reliable, focus-free) when the
            // broadcast channel is up, as well as sending the raw bar as a backstop.
            if (keys === 'space' && cmd.init && cmd.init(log)) {
                uiHidden = !uiHidden;
                _sends = [];
                const base = Number(tele.CamCameraState);
                const cur = Number.isFinite(base) ? (base | 0) : 0;
                const next = uiHidden ? (cur | UIHIDDEN_BIT) : (cur & ~UIHIDDEN_BIT);
                C.camSetState(next);
                log.info && log.info(`sim-key space → UIHidden ${uiHidden ? 'ON' : 'OFF'} (CamSetState ${next}) — ${sendSummary()}`);
            }
            const sent = keySender ? keySender(keys) : false;
            if (!keySender) {
                log.warn && log.warn('sim-key: no key-injection path available (not on Windows / koffi unavailable) — keystroke skipped');
            } else {
                log.info && log.info(`sim-key → "${keys}" ${sent ? 'injected' : 'no-op (unknown/empty combo or dead channel)'}`);
            }
        } catch (e) {
            log.warn && log.warn(`sim-key dispatch error: ${e.message}`);
        }
    }

    // ── sim-chat handler ──────────────────────────────────────────────────────
    // { type:'sim-chat', value:{ text:'/all message…' } } → send arbitrary TEXT to
    // iRacing chat. The broadcast channel can't carry text, so: clipboard ← text,
    // open the chat box via the SDK (ChatComand/BeginChat — falls back to the 't'
    // chat key), then ctrl+v + enter via key injection. deps.clipboard is Electron's
    // clipboard from relay-runner; absent on a headless relay → skipped, never throws.
    const clip = deps.clipboard || null;
    const wait = deps.sleep || sleep;
    async function handleSimChat(c) {
        const text = String((((c && c.value) || {}).text) || '').trim();
        if (!text) { log.warn && log.warn('sim-chat: missing/empty value.text — ignored (no-op)'); return false; }
        if (!clip || typeof clip.writeText !== 'function') {
            log.warn && log.warn('sim-chat: no clipboard available (headless relay?) — chat send skipped');
            return false;
        }
        if (!keySender) {
            log.warn && log.warn('sim-chat: no key-injection path (not on Windows / koffi unavailable) — chat send skipped');
            return false;
        }
        try {
            if (deps.canSendChat && !deps.canSendChat(c)) return false;
            clip.writeText(text);
            if (cmd.init && cmd.init(log) && typeof cmd.chatCommand === 'function') {
                if (cmd.chatCommand(1) !== true) return false;
            } else {
                if (keySender('t') !== true) return false;
            }
            const gap = stepMs > 0 ? stepMs : 90;
            await wait(gap * 3);    // let the chat box open before pasting
            if (deps.canSendChat && !deps.canSendChat(c)) { keySender('escape'); return false; }
            if (keySender('ctrl+a') !== true || keySender('ctrl+v') !== true) return false;
            await wait(gap);
            if (deps.canSendChat && !deps.canSendChat(c)) { keySender('escape'); return false; }
            const sent = keySender('enter');
            log.info && log.info(`sim-chat → pasted + sent ${text.length} chars to iRacing chat${sent ? '' : ' (enter no-op — check key injection)'}`);
            return sent === true;
        } catch (e) {
            log.warn && log.warn(`sim-chat dispatch error: ${e.message}`);
            return false;
        }
    }

    // Rich-result shape every command path resolves to (Task: relay command acks).
    //   { sent: bool, reason: string|null, target: 'obs'|'iracing'|'relay', response: object|null }
    // Back-compat: consumers that destructure { sent, reason } still work — those
    // two keys are always present. `target` tells the backend whether the command
    // was CONFIRMED by OBS (round-tripped) or merely POSTED at iRacing (fire-and-
    // forget broadcast messages, no readback). `response` carries OBS reply data
    // (scene lists, current scene, …) so the panel can reflect real OBS state.
    const result = (sent, reason, target, response) => ({
        sent: sent !== false,
        reason: reason != null ? reason : null,
        target: target || 'relay',
        response: response != null ? response : null,
    });

    function replaySnapshot() {
        return {
            telemetrySeq,
            sdkSessionNum: Number.isFinite(Number(tele.SessionNum)) ? Number(tele.SessionNum) : null,
            sdkSessionTime: Number.isFinite(Number(tele.SessionTime)) ? Number(tele.SessionTime) : null,
            sessionNum: Number.isFinite(Number(tele.ReplaySessionNum)) ? Number(tele.ReplaySessionNum) : null,
            sessionTime: Number.isFinite(Number(tele.ReplaySessionTime)) ? Number(tele.ReplaySessionTime) : null,
            frame: Number.isFinite(Number(tele.ReplayFrameNum)) ? Number(tele.ReplayFrameNum) : null,
            frameFromEnd: Number.isFinite(Number(tele.ReplayFrameNumEnd)) ? Number(tele.ReplayFrameNumEnd) : null,
            playSpeed: Number.isFinite(Number(tele.ReplayPlaySpeed)) ? Number(tele.ReplayPlaySpeed) : null,
            camCarIdx: Number.isFinite(Number(tele.CamCarIdx)) ? Number(tele.CamCarIdx) : null,
            camGroup: Number.isFinite(Number(tele.CamGroupNumber)) ? Number(tele.CamGroupNumber) : null,
            camState: Number.isFinite(Number(tele.CamCameraState)) ? Number(tele.CamCameraState) : null,
            isReplayPlaying: tele.IsReplayPlaying == null ? null : Boolean(tele.IsReplayPlaying),
            isOnTrack: tele.IsOnTrack == null ? null : Boolean(tele.IsOnTrack),
            isInGarage: tele.IsInGarage == null ? null : Boolean(tele.IsInGarage),
        };
    }

    async function verifyPlaybackSpeed(speed) {
        const afterSeq = telemetrySeq;
        if (C.replaySetPlaySpeed(speed) !== true) return false;
        const verified = await waitForFreshTelemetry(
            afterSeq,
            (values) => Number(values.ReplayPlaySpeed) === speed && Number(values.ReplaySessionNum) >= 0,
            replayPlaybackTimeoutMs,
        );
        return verified.ok;
    }

    async function handleVerifiedReplayIncident(c) {
        const identityError = replayIncidentIdentityError(c);
        if (identityError) return result(false, identityError, 'iracing', null);
        const startedAt = Date.now();
        const v = c.value || {};
        const targetFrame = v.replayFrame == null ? null : Number(v.replayFrame);
        const targetSessionNum = v.sessionNum == null ? null : Number(v.sessionNum);
        const targetSessionTime = v.sessionTime == null ? null : Number(v.sessionTime);
        const finalPlayback = v.finalPlayback === 'pause' ? 'pause' : 'play';
        const expectedCarIdx = c.carIdx != null && Number.isInteger(Number(c.carIdx))
            ? Number(c.carIdx)
            : [...driverByIdx.entries()].find(([, car]) => String(car.carNumber) === String(c.carNumber))?.[0];
        const car = expectedCarIdx != null
            ? (driverByIdx.get(expectedCarIdx) || (c.carNumber != null ? { carNumber: c.carNumber } : null))
            : (c.carNumber != null ? { carNumber: c.carNumber } : null);
        const target = {
            replayFrame: Number.isFinite(targetFrame) ? targetFrame : null,
            sessionNum: Number.isInteger(targetSessionNum) ? targetSessionNum : null,
            sessionTime: Number.isFinite(targetSessionTime) ? targetSessionTime : null,
            finalPlayback,
            requestedCarIdx: c.carIdx == null ? null : Number(c.carIdx),
            requestedCarNumber: c.carNumber == null ? null : String(c.carNumber),
            resolvedCarIdx: expectedCarIdx == null ? null : expectedCarIdx,
            resolvedCar: car || null,
        };
        const traceStage = (stage, payload = {}) => emitTrace(`replay-incident.${stage}`, c, {
            elapsedMs: Date.now() - startedAt,
            target,
            ...payload,
        });
        const failed = (stage, reason, extra = {}) => {
            const response = {
                verified: false,
                stage,
                ...extra,
            };
            if (!response.telemetry) response.telemetry = replaySnapshot();
            traceStage('failed', { reason, response, sends: _sends.slice() });
            return result(false, reason, 'iracing', response);
        };

        traceStage('started', { telemetry: replaySnapshot() });

        if (!Number.isFinite(targetFrame) && (!Number.isInteger(targetSessionNum) || !Number.isFinite(targetSessionTime))) {
            return failed('validate', 'incident replay target is missing a valid session/frame');
        }
        if (!car) {
            return failed('validate', 'incident replay camera target is unavailable');
        }
        if (tele.IsOnTrack === true || Number(tele.IsOnTrack) === 1 || tele.IsInGarage === true || Number(tele.IsInGarage) === 1) {
            return failed('operator-state', 'leave the car before controlling replay or cameras');
        }

        captureResumeFrame();
        const pausedBeforeSeek = await verifyPlaybackSpeed(0);
        traceStage('pause-before-seek', {
            ok: pausedBeforeSeek,
            telemetry: replaySnapshot(),
            send: _sends.at(-1) || null,
        });
        if (!pausedBeforeSeek) {
            return failed('pause-before-seek', 'iRacing did not confirm replay pause before seek');
        }

        let seekAttempts = 0;
        let fallback = null;
        const seekOnce = async () => {
            seekAttempts += 1;
            const afterSeq = telemetrySeq;
            const before = replaySnapshot();
            const posted = Number.isFinite(targetFrame)
                ? C.replaySetPlayPositionFrame(targetFrame, cmd.RPY_POS.Begin)
                : C.replaySearchSessionTime(targetSessionNum, Math.round(targetSessionTime * 1000));
            if (posted !== true) {
                traceStage('seek-attempt', {
                    attempt: seekAttempts,
                    posted: false,
                    before,
                    after: replaySnapshot(),
                    send: _sends.at(-1) || null,
                });
                return false;
            }
            const landed = await waitForFreshTelemetry(afterSeq, (values) => {
                const replaySessionNum = Number(values.ReplaySessionNum);
                if (!Number.isInteger(replaySessionNum) || replaySessionNum < 0) return false;
                if (Number.isFinite(targetFrame)) {
                    return Math.abs(Number(values.ReplayFrameNum) - targetFrame) <= 120;
                }
                return replaySessionNum === targetSessionNum &&
                    Math.abs(Number(values.ReplaySessionTime) - targetSessionTime) <= replaySessionTimeTolerance;
            }, replaySeekTimeoutMs);
            traceStage('seek-attempt', {
                attempt: seekAttempts,
                posted: true,
                verified: landed.ok,
                before,
                after: replaySnapshot(),
                send: _sends.at(-1) || null,
            });
            return landed.ok;
        };

        let sought = await seekOnce();
        if (!sought) {
            if (replayRetryDelayMs) await sleep(replayRetryDelayMs);
            sought = await seekOnce();
        }
        if (!sought) {
            fallback = 'lap-resync';
            const beforeFrame = Number(tele.ReplayFrameNum);
            const beforeTime = Number(tele.ReplaySessionTime);
            const nudge = Number.isFinite(targetSessionTime) && Number.isFinite(beforeTime) && beforeTime > targetSessionTime
                ? cmd.RPY_SRCH.PrevLap
                : cmd.RPY_SRCH.NextLap;
            const afterSeq = telemetrySeq;
            const posted = C.replaySearch(nudge);
            const moved = posted === true && (await waitForFreshTelemetry(afterSeq, (values) => {
                const nextFrame = Number(values.ReplayFrameNum);
                const nextTime = Number(values.ReplaySessionTime);
                return Number(values.ReplaySessionNum) >= 0 &&
                    ((Number.isFinite(nextFrame) && nextFrame !== beforeFrame) ||
                     (Number.isFinite(nextTime) && nextTime !== beforeTime));
            }, replaySeekTimeoutMs)).ok;
            traceStage('lap-resync', {
                posted,
                moved,
                direction: nudge === cmd.RPY_SRCH.PrevLap ? 'previous' : 'next',
                before: { frame: beforeFrame, sessionTime: beforeTime },
                after: replaySnapshot(),
                send: _sends.at(-1) || null,
            });
            if (moved) {
                if (replayRetryDelayMs) await sleep(replayRetryDelayMs);
                sought = await seekOnce();
            }
        }
        if (!sought) {
            log.warn && log.warn(`replay incident seek not verified after ${seekAttempts} attempts (${JSON.stringify(replaySnapshot())})`);
            return failed('seek', 'iRacing did not confirm the incident replay seek', {
                seekAttempts,
                fallback,
            });
        }
        traceStage('seek-verified', { seekAttempts, fallback, telemetry: replaySnapshot() });

        if (inScenic()) {
            const afterSeq = telemetrySeq;
            leaveScenicIfStuck();
            const cleared = await waitForFreshTelemetry(
                afterSeq,
                (values) => (Number(values.CamCameraState) & SCENIC_BIT) === 0,
                replayCameraTimeoutMs,
            );
            if (!cleared.ok) {
                return failed('camera-state', 'iRacing did not leave the Scenic camera state');
            }
            traceStage('camera-state-cleared', { telemetry: replaySnapshot() });
        }

        const replayGroup = armedGroupNum || currentGroupNum();
        if (armedGroupNum) {
            log.info && log.info(`replay-incident using ARMED camera group ${armedGroupNum}`);
            armedGroupNum = 0;
        }
        const afterFocusSeq = telemetrySeq;
        if (targetCar(car, replayGroup) !== true) {
            return failed('camera', 'iRacing rejected the incident camera command');
        }
        const focused = await waitForFreshTelemetry(
            afterFocusSeq,
            (values) => expectedCarIdx == null
                ? Number.isInteger(Number(values.CamCarIdx))
                : Number(values.CamCarIdx) === expectedCarIdx,
            replayCameraTimeoutMs,
        );
        traceStage('camera', {
            verified: focused.ok,
            requestedGroup: replayGroup,
            telemetry: replaySnapshot(),
            send: _sends.at(-1) || null,
        });
        if (!focused.ok) {
            return failed('camera', 'iRacing did not confirm the incident camera target');
        }

        const finalSpeed = finalPlayback === 'pause' ? 0 : 1;
        const playbackVerified = await verifyPlaybackSpeed(finalSpeed);
        traceStage('playback', {
            verified: playbackVerified,
            requestedSpeed: finalSpeed,
            telemetry: replaySnapshot(),
            send: _sends.at(-1) || null,
        });
        if (!playbackVerified) {
            return failed('playback', `iRacing did not confirm replay ${finalPlayback}`);
        }

        const response = {
            verified: true,
            seekAttempts,
            fallback,
            finalPlayback,
            elapsedMs: Date.now() - startedAt,
            telemetry: replaySnapshot(),
        };
        traceStage('completed', { response, sends: _sends.slice() });
        log.info && log.info(`replay incident verified in ${response.elapsedMs}ms after ${seekAttempts} seek attempt(s)${fallback ? ` via ${fallback}` : ''}`);
        return result(true, null, 'iracing', response);
    }

    function handleNow(msg) {
        if (!msg || msg.type !== 'command' || !msg.command) {
            return result(false, 'not a command message', 'relay', null);
        }
        const c = msg.command;
        // sim-key is independent of the broadcast-message channel — handle it BEFORE
        // the cmd.init() gate so keystrokes still fire when camera/replay is down.
        if (c.type === 'sim-key') { handleSimKey(c); return result(true, null, 'iracing', null); }
        // sim-chat opens the box via the SDK when up, but degrades to pure key
        // injection — handle before the init gate too. Async (paste timing gaps).
        if (c.type === 'sim-chat') {
            return handleSimChat(c).then((ok) => result(ok, ok ? null : 'sim-chat unavailable', 'iracing', null));
        }
        // init() is one-shot-cheap after success; on failure it shouts a LOUD,
        // actionable reinstall/-reboot line ONCE (see broadcast-cmd.init). Here we
        // add the per-command context so the operator knows WHICH command was lost.
        if (!cmd.init(log)) {
            log.warn && log.warn(`Camera/replay command DROPPED (${c.type}${c.action ? '/' + c.action : ''}) — broadcast channel is not up. See the LOUD init error above (reinstall the relay / run on the iRacing PC).`);
            // OBS commands do NOT depend on the iRacing broadcast channel — fall
            // through so scene cuts still work when the sim channel is down.
            if (c.type !== 'obs') {
                return result(false, 'broadcast channel not up', 'iracing', null);
            }
        }
        _sends = [];
        try {
            switch (c.type) {
                case 'camera-target': {
                    const g = armedGroupNum || currentGroupNum();
                    leaveScenicIfStuck();                                    // scenic blocks the switch (no-op if not stuck/unknown)
                    if (c.carNumber != null) {
                        C.camSwitchNum(c.carNumber, g, 0);                   // padCarNum applied inside
                    } else if (c.carIdx != null) {
                        const car = driverByIdx.get((c.carIdx | 0));         // carIdx → car NUMBER (not position!)
                        if (car) targetCar(car, g);
                        else log.warn && log.warn(`camera-target carIdx ${c.carIdx} not in driver map yet`);
                    }
                    armedGroupNum = 0;
                    log.info && log.info(`cam → car ${c.carNumber ?? ('idx ' + c.carIdx)}${g ? ' group ' + g : ''} — ${sendSummary()}`);
                    return result(true, null, 'iracing', null);
                }
                case 'camera': {
                    const g = resolveGroup(c.group ?? c.value);
                    if (!g) {
                        log.warn && log.warn(`camera group "${c.group}" unknown — add it to cameraGroups in relay-config.json`);
                        return result(false, `unknown camera group "${c.group}"`, 'iracing', null);
                    }
                    // Keep the CURRENT car, change only the group (never snap to P1).
                    leaveScenicIfStuck();                                    // scenic blocks group switches (no-op if not stuck/unknown)
                    const car = currentCar();
                    if (car) targetCar(car, g);
                    else C.camFocusLeader(g);                                // safe fallback, not camSwitchPos(1,g)
                    log.info && log.info(`cam group → ${c.group} (${g}) keeping ${car ? 'car #' + car.carNumber : 'leader'} — ${sendSummary()}`);
                    return result(true, null, 'iracing', null);
                }
                case 'next-camera': {
                    armedGroupNum = resolveGroup(c.group ?? c.value);
                    log.info && log.info(`armed next camera → ${c.group} (${armedGroupNum || 'unknown'})`);
                    return result(true, null, 'iracing', null);
                }
                case 'replay': {
                    let replayOk = true;
                    let replayReason = null;
                    switch (c.action) {
                        case 'play': C.replaySetPlaySpeed(1); break;
                        case 'pause': C.replaySetPlaySpeed(0); break;
                        case 'rewind':
                            captureResumeFrame();                          // remember where we left live
                            C.replaySetPlaySpeed(-4); break;               // continuous rewind
                        case 'live': {
                            // Return to where the broadcast was before the replay excursion.
                            // ToEnd jumps to the tape's end (= the race finish on a recorded
                            // replay), so prefer the captured resume frame; fall back to ToEnd
                            // only when we never captured one (a genuinely live session). Resume
                            // play AFTER the seek lands — firing the seek and the speed change in
                            // the same instant races (the seek's residual state clobbers the
                            // speed), the exact bug the replay-incident sequence staggers around.
                            if (Number.isFinite(replayResumeFrame)) {
                                C.replaySetPlayPositionFrame(replayResumeFrame, cmd.RPY_POS.Begin);
                            } else {
                                C.replaySearch(cmd.RPY_SRCH.ToEnd);
                            }
                            replayResumeFrame = null;
                            const resumePlay = () => C.replaySetPlaySpeed(1);
                            if (stepMs > 0) setTimeout(resumePlay, stepMs); else resumePlay();
                            break;
                        }
                        case 'jump': {
                            // Relative seconds (negative = back). Precise via an absolute
                            // frame seek when ReplayFrameNum is known; coarse lap-search else.
                            const secs = Number(c.seconds) || 0;
                            if (secs < 0) captureResumeFrame();            // jump-back = leaving live
                            const curFrame = Number(tele.ReplayFrameNum);
                            if (Number.isFinite(curFrame)) {
                                const target = Math.max(0, Math.round(curFrame + secs * frameRate));
                                C.replaySetPlayPositionFrame(target, cmd.RPY_POS.Begin);
                            } else if (secs < 0) {
                                C.replaySearch(cmd.RPY_SRCH.PrevLap);
                            } else {
                                C.replaySearch(cmd.RPY_SRCH.NextLap);
                            }
                            break;
                        }
                        case 'marker':
                            log.warn && log.warn('replay marker not supported by the iRacing broadcast API');
                            replayOk = false;
                            replayReason = 'replay marker not supported';
                            break;
                        default:
                            log.warn && log.warn(`unknown replay action: ${c.action}`);
                            replayOk = false;
                            replayReason = `unknown replay action: ${c.action}`;
                    }
                    if (c.action && c.action !== 'marker') log.info && log.info(`replay ${c.action} — ${sendSummary()}`);
                    return result(replayOk, replayReason, 'iracing', null);
                }
                case 'obs': {
                    // OBS WebSocket passthrough. Pull command.request (e.g. 'SetCurrentProgramScene')
                    // + command.requestData (object) and forward to the injected obs-client.
                    // When obs is disabled (deps.obs missing), short-circuit with a soft result
                    // so callers can surface "obs disabled" rather than retrying. obs.send
                    // returns a Promise; we return it directly so handle()'s caller can await
                    // the {sent, reason} shape without making handle itself async.
                    log.info && log.info(`obs command type=${c.type} request=${c.request}`);
                    if (!obs) return result(false, 'obs disabled', 'obs', null);
                    return Promise.resolve(obs.send(c.request, c.requestData))
                        .then((r) => result(!!r.ok, r.error, 'obs', r.ok ? (r.data != null ? r.data : {}) : null))
                        .catch((e) => result(false, e && e.message ? e.message : String(e), 'obs', null));
                }
                case 'replay-incident': {
                    const identityError = replayIncidentIdentityError(c);
                    if (identityError) return result(false, identityError, 'iracing', null);
                    if (verifyReplayIncidents) return handleVerifiedReplayIncident(c);
                    const v = c.value || {};
                    captureResumeFrame();                                   // remember the pre-incident spot so "live" returns here

                    // The frontend seeks a PRE-ROLL point BEFORE the incident (replayFrame /
                    // sessionTime already rolled back), so the clip should ROLL FORWARD into
                    // the incident — jump back AND PLAY. The sequence therefore ENDS on play
                    // (replaySetPlaySpeed(1)) as its final replay verb; there is no trailing
                    // pause to re-stop it (the old pause caused the ~0.5s-then-stop bug —
                    // the seek's residual playback played briefly, then this re-paused it).
                    // 1) seek (most precise first)
                    if (v.replayFrame != null) {
                        C.replaySetPlayPositionFrame(v.replayFrame, cmd.RPY_POS.Begin);
                    } else if (v.sessionTime != null) {
                        C.replaySearchSessionTime(Number(v.sessionNum) || 0, Math.round(Number(v.sessionTime) * 1000));
                    } else {
                        C.replaySearch(cmd.RPY_SRCH.PrevIncident);          // native fallback
                    }
                    // 2) focus the car (after a gap so the seek lands first). An ARMED
                    //    next-camera group is CONSUMED here — spooling a replay IS the next
                    //    camera change, so the replay opens on the armed camera (falling
                    //    back to the current group when nothing is armed).
                    const car = c.carNumber != null
                        ? { carNumber: c.carNumber }
                        : (c.carIdx != null ? driverByIdx.get(c.carIdx | 0) : null);
                    const replayGroup = armedGroupNum || currentGroupNum();
                    if (car && armedGroupNum) {
                        log.info && log.info(`replay-incident using ARMED camera group ${armedGroupNum}`);
                        armedGroupNum = 0;
                    }
                    const focus = () => { if (car) { leaveScenicIfStuck(); targetCar(car, replayGroup); } };
                    // 3) PLAY — final verb, leaves the replay rolling from the pre-roll point.
                    //    The relay alone leaves it playing (no dependence on a separate
                    //    frontend play command), and it survives a frontend play arriving
                    //    before or after (idempotent: speed 1 either way).
                    const play = () => C.replaySetPlaySpeed(1);
                    if (stepMs > 0) { setTimeout(focus, stepMs); setTimeout(play, stepMs * 2); }
                    else { focus(); play(); }
                    log.info && log.info(`replay → incident car ${c.carNumber ?? ('idx ' + c.carIdx)} frame ${v.replayFrame ?? ('t=' + v.sessionTime)} (jump-back & play) — ${sendSummary()}`);
                    return result(true, null, 'iracing', null);
                }
                default:
                    log.warn && log.warn(`unknown command type: ${c.type}`);
                    return result(false, `unknown command type: ${c.type}`, 'relay', null);
            }
        } catch (e) {
            log.warn && log.warn(`command dispatch error: ${e.message}`);
            return result(false, e && e.message ? e.message : String(e), 'relay', null);
        }
    }

    function handle(msg) {
        const command = msg?.command;
        const queuedAt = Date.now();
        emitTrace('command.queued', command, {
            serialized: serializeCommands,
            telemetry: replaySnapshot(),
        });
        const started = () => emitTrace('command.started', command, {
            queueWaitMs: Date.now() - queuedAt,
            telemetry: replaySnapshot(),
        });
        if (!serializeCommands) {
            started();
            return handleNow(msg);
        }
        const run = () => {
            started();
            return Promise.resolve(handleNow(msg));
        };
        const pending = commandQueue.then(run, run);
        commandQueue = pending.catch(() => undefined);
        return pending;
    }

    return { handle, updateSession, updateTelemetry };
}

// Dispatch a server→relay { type:'command', commandId?, command } message and, when
// a commandId is present, send a { type:'command_ack', … } readback over the publisher.
// Shared by src/main.js (CLI) and gui/relay-runner.js so both paths ack identically.
//
//   ack = { type:'command_ack', commandId,
//           ok:      result.sent !== false,
//           target:  result.target || 'relay',
//           status:  target==='obs' ? (ok?'confirmed':'failed')   // OBS round-trips → confirmed
//                                    : (ok?'posted':'failed'),      // iRacing = fire-and-forget → posted
//           response: result.response || null,
//           error:    result.reason  || null }
//
// Backward compatible: with NO commandId, no ack is sent (behaviour unchanged). Never
// throws — a dispatcher exception (sync or async) is turned into an ok:false ack.
function dispatchWithAck(msg, dispatcher, publisher, log) {
    // Not a command, or nothing to ack to → just dispatch (keeps status/session_linked
    // handling upstream untouched) and return.
    if (!msg || msg.type !== 'command') {
        try { if (dispatcher) return dispatcher.handle(msg); } catch (e) { /* swallow */ }
        return;
    }
    const commandId = msg.commandId;
    const sendAck = (result) => {
        if (commandId == null) return;             // back-compat: no id → no ack
        const ok = !!(result && result.sent !== false);
        const target = (result && result.target) || 'relay';
        const status = target === 'obs'
            ? (ok ? 'confirmed' : 'failed')
            : (ok ? 'posted' : 'failed');
        const ack = {
            type: 'command_ack',
            commandId,
            ok,
            target,
            status,
            response: (result && result.response) || null,
            error: (result && result.reason) || null,
        };
        try {
            if (publisher && typeof publisher.sendJson === 'function') publisher.sendJson(ack);
        } catch (e) {
            log && log.warn && log.warn(`command_ack send failed: ${e.message}`);
        }
    };

    let result;
    try {
        result = dispatcher.handle(msg);
    } catch (e) {
        log && log.warn && log.warn(`command handler threw: ${e.message}`);
        sendAck({ sent: false, reason: e && e.message ? e.message : String(e), target: 'relay', response: null });
        return;
    }
    // handle() may return a value (camera/replay/sim-key) or a Promise (obs).
    if (result && typeof result.then === 'function') {
        result
            .then((r) => sendAck(r))
            .catch((e) => sendAck({ sent: false, reason: e && e.message ? e.message : String(e), target: 'relay', response: null }));
    } else {
        sendAck(result);
    }
}

module.exports = { makeDispatcher, dispatchWithAck };
