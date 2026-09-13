'use strict';

const api = window.gsrcSafetyCar;
const $ = id => document.getElementById(id);
let state = null;
let pendingConfirm = null;
let pendingCancel = null;
let audioQueue = Promise.resolve();

const phaseInfo = {
    idle: ['SYSTEM READY', 'No safety car active', 'Select the race plan, rehearse it, then arm live output when iRacing is connected.'],
    countdown: ['DEPLOYMENT COUNTDOWN', 'Code 80 deploying', 'All cars must lift immediately and reach the limit before the countdown expires.'],
    gathering: ['CONTROLLED BUNCH-UP', 'Field gathering behind the leader', 'Leader target is lower than the field limit so gaps can close without anyone exceeding 80 km/h.'],
    controlled: ['COURSE NEUTRALISED', 'Field under Race Control', 'Maintain 80 km/h maximum and the locked physical order.'],
    'wave-arounds': ['WAVE-AROUNDS', 'Releasing eligible lapped cars', 'One highlighted car at a time. Every other driver must hold position.'],
    'one-to-green': ['ONE TO GREEN', 'Preparing the restart', 'Leader controls pace. No overtaking until Race Control releases the field.'],
    restart: ['RESTART ARMED', 'Control line enforcement active', 'Passing is monitored against the restart order until the leader crosses the control line.'],
    green: ['GREEN FLAG', 'Racing resumed', 'Deferred penalties are being issued during green-flag racing.'],
    'recovery-required': ['RECOVERY REQUIRED', 'Interrupted procedure detected', 'Match the loaded session before resuming, or close the interrupted record without sending commands.'],
};
const phaseSequence = ['idle', 'countdown', 'gathering', 'wave-arounds', 'one-to-green', 'green'];

function toast(message, error = false) {
    const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message;
    $('toast-stack').append(node); setTimeout(() => node.remove(), 5000);
}

function confirmAction(title, copy, callback, confirmLabel = 'CONFIRM', cancelCallback = null) {
    $('dialog-title').textContent = title; $('dialog-copy').textContent = copy; $('dialog-confirm').textContent = confirmLabel;
    pendingConfirm = callback; pendingCancel = cancelCallback; $('confirm-dialog').showModal();
}
$('confirm-dialog').addEventListener('close', () => {
    const callback = pendingConfirm; const cancelCallback = pendingCancel; pendingConfirm = null; pendingCancel = null;
    if ($('confirm-dialog').returnValue === 'confirm') callback?.(); else cancelCallback?.();
});

async function action(name, payload = {}) {
    const result = await api.action(name, payload);
    if (!result.ok) { toast(result.message, true); return false; }
    state = result.state; render(); return true;
}

function readPlan() {
    return {
        procedure: document.querySelector('input[name="procedure"]:checked').value,
        controlMode: $('control-mode').value,
        outputArmed: $('output-armed').checked,
        speedLimitKph: Number($('speed-limit').value), leaderGatherKph: Number($('leader-gather').value), speedToleranceKph: Number($('speed-tolerance').value),
        passCorrectionSeconds: Number($('correction-time').value), penalty: $('penalty').value,
        waveArounds: $('waves-enabled').checked, waveMode: $('wave-mode').value, waveIntervalSeconds: Number($('wave-spacing').value),
        nativeYellowsCount: $('native-counts').checked,
        schedule: { enabled: $('schedule-enabled').checked, basis: $('schedule-basis').value, count: Number($('schedule-count').value), first: Number($('schedule-first').value), last: Number($('schedule-last').value), minimumSpacing: Number($('schedule-spacing').value), randomized: $('schedule-random').checked, manualPoints: $('schedule-points').value.split(/[,\s]+/).map(Number).filter(Number.isFinite) },
        incidentTrigger: { enabled: $('incident-enabled').checked, source: 'official4x', reviewAt: Number($('incident-review').value), autoAt: Number($('incident-auto').value), minimumUniqueCars: Number($('incident-review').value), trackWindowPct: Number($('incident-track').value), timeWindowSeconds: Number($('incident-time').value) },
        audio: { enabled: $('audio-enabled').checked, pttKey: $('ptt-key').value, outputDeviceId: $('audio-device').value },
    };
}

function writePlan(c) {
    const radio = document.querySelector(`input[name="procedure"][value="${c.procedure}"]`); if (radio) radio.checked = true;
    const values = { 'control-mode': c.controlMode, 'output-armed': c.outputArmed, 'speed-limit': c.speedLimitKph, 'leader-gather': c.leaderGatherKph, 'speed-tolerance': c.speedToleranceKph, 'correction-time': c.passCorrectionSeconds, penalty: c.penalty, 'waves-enabled': c.waveArounds, 'wave-mode': c.waveMode, 'wave-spacing': c.waveIntervalSeconds, 'native-counts': c.nativeYellowsCount, 'schedule-enabled': c.schedule.enabled, 'schedule-basis': c.schedule.basis, 'schedule-count': c.schedule.count, 'schedule-first': c.schedule.first, 'schedule-last': c.schedule.last, 'schedule-spacing': c.schedule.minimumSpacing, 'schedule-random': c.schedule.randomized, 'schedule-points': c.schedule.manualPoints?.join(', '), 'incident-enabled': c.incidentTrigger.enabled, 'incident-review': c.incidentTrigger.reviewAt, 'incident-auto': c.incidentTrigger.autoAt, 'incident-track': c.incidentTrigger.trackWindowPct, 'incident-time': c.incidentTrigger.timeWindowSeconds, 'audio-enabled': c.audio.enabled, 'ptt-key': c.audio.pttKey };
    for (const [id, value] of Object.entries(values)) { const el = $(id); if (!el || value == null) continue; if (el.type === 'checkbox') el.checked = !!value; else el.value = value; }
    if (c.audio.outputDeviceId) $('audio-device').value = c.audio.outputDeviceId;
}

function procedureName(value) { return ({ 'code80-bunch': 'GSRC CODE 80', 'code80-strict': 'STRICT CODE 80', native: 'iRACING YELLOW', 'manual-driver': 'HUMAN SAFETY CAR' })[value] || value; }

function render() {
    if (!state) return;
    const c = state.context || {}; const connected = c.connected && !c.stale;
    $('connection-dot').className = `status-dot ${connected ? 'live' : c.connected ? 'stale' : ''}`;
    $('session-name').textContent = c.sessionName || (c.simulated ? 'Rehearsal session' : 'Waiting for iRacing');
    $('track-name').textContent = c.trackName || (c.stale ? 'Telemetry stale — output is blocked' : 'Connect the simulator or enable rehearsal mode');
    $('simulation-toggle').checked = !!c.simulated; $('rehearsal-tools').hidden = !c.simulated;
    $('output-armed').checked = !!state.config.outputArmed;
    $('arm-caption').textContent = state.config.outputArmed ? 'ARMED · commands reach iRacing' : 'DISARMED · preview only';
    const operationBlocked = !!state.interlock || !!state.recoveryRequired;
    const alert = $('operation-alert'); alert.hidden = !operationBlocked;
    if (state.recoveryRequired) {
        $('operation-alert-title').textContent = 'INTERRUPTED PROCEDURE — RECOVERY REQUIRED';
        $('operation-alert-copy').textContent = `${procedureName(state.recovery?.procedure)} was ${state.recovery?.phase?.replaceAll('-', ' ')} in session ${state.recovery?.boundSessionIdentity || 'unknown'}. No live output will resume automatically.`;
    } else if (state.interlock) {
        $('operation-alert-title').textContent = 'LIVE AUTHORITY INTERLOCKED';
        $('operation-alert-copy').textContent = `${state.interlock.reason} Output was disarmed. Restore the correct live session, then acknowledge.`;
    }
    $('recovery-resume').hidden = !state.recoveryRequired; $('recovery-close').hidden = !state.recoveryRequired; $('interlock-ack').hidden = !state.interlock;
    $('deploy-label').textContent = procedureName(state.config.procedure);
    const info = state.recoveryRequired ? phaseInfo['recovery-required'] : phaseInfo[state.phase] || phaseInfo.controlled;
    $('phase-kicker').textContent = info[0]; $('phase-title').textContent = info[1]; $('phase-instruction').textContent = info[2];
    $('flag-code').textContent = state.procedure?.includes('80') ? '80' : state.procedure === 'native' ? 'Y' : 'SC';
    $('countdown-value').textContent = state.countdownRemaining ? `${state.countdownRemaining}s` : '';
    $('flag-disc').className = `flag-disc ${state.phase === 'idle' ? 'idle' : state.phase === 'green' ? 'green' : state.phase === 'countdown' ? 'warning' : 'active'}`;
    $('deploy-button').disabled = state.active || operationBlocked || (!c.connected && !c.simulated); $('cancel-button').disabled = !state.active || operationBlocked;
    $('apply-settings').disabled = state.active;
    const actionStates = { 'pack-ready': ['gathering', 'controlled'], 'one-to-green': ['gathering', 'controlled', 'wave-arounds'], restart: ['one-to-green'], green: ['countdown', 'gathering', 'controlled', 'wave-arounds', 'one-to-green', 'restart'], 'pace-laps': ['controlled'] };
    document.querySelectorAll('[data-action]').forEach(button => { button.disabled = operationBlocked || !actionStates[button.dataset.action].includes(state.phase) || button.dataset.action === 'pace-laps' && state.procedure !== 'native'; });
    renderPhases(); renderField(); renderTrack(); renderEvents(); renderPenalties(); renderSimCars();
}

function renderPhases() {
    let phase = state.phase === 'controlled' ? 'gathering' : state.phase === 'restart' ? 'one-to-green' : state.phase;
    const current = Math.max(0, phaseSequence.indexOf(phase));
    document.querySelectorAll('#phase-strip [data-phase]').forEach(node => { const i = phaseSequence.indexOf(node.dataset.phase); node.classList.toggle('active', i === current); node.classList.toggle('done', i < current); });
}

function filteredDrivers() {
    const search = $('driver-filter').value.trim().toLowerCase(); const view = $('field-view').value;
    const wave = new Set((state.waveQueue || []).map(d => d.carIdx)); const warning = new Set((state.violations || []).filter(v => v.status === 'warning').map(v => v.carIdx));
    return [...(state.context.drivers || [])].sort((a, b) => (a.position || 999) - (b.position || 999)).filter(d => (!search || `${d.carNumber} ${d.name}`.toLowerCase().includes(search)) && (view === 'all' || view === 'wave' && wave.has(d.carIdx) || view === 'warning' && warning.has(d.carIdx)));
}

function renderField() {
    const rows = $('field-rows'); const wave = new Set((state.waveQueue || []).map(d => d.carIdx)); const warnings = new Map((state.violations || []).filter(v => v.status === 'warning').map(v => [v.carIdx, v])); const drivers = filteredDrivers();
    if (!drivers.length) { rows.innerHTML = '<p class="empty">No drivers match this view.</p>'; return; }
    rows.innerHTML = drivers.map(d => { const isWave = wave.has(d.carIdx); const warning = warnings.get(d.carIdx); const stateName = warning ? warning.type === 'speeding' ? 'SPEED' : 'PASS' : isWave ? 'WAVE' : d.onPitRoad ? 'PIT' : 'OK'; return `<div class="field-row ${warning ? 'warning' : isWave ? 'wave' : ''}" data-car-idx="${d.carIdx}"><span class="pos">${d.position || '—'}</span><span class="driver"><span class="car-number">${escapeHtml(d.carNumber)}</span><span class="driver-name"><b>${escapeHtml(d.name)}</b><small>${d.inWorld === false ? 'Not in world' : `CarIdx ${d.carIdx}`}</small></span></span><span class="metric">${d.lapCompleted ?? '—'}</span><span class="metric">${Number.isFinite(d.speedKph) ? Math.round(d.speedKph) : '—'}</span><span class="state-pill ${warning ? 'warn' : isWave ? 'wave' : ''}">${stateName}</span></div>`; }).join('');
    rows.querySelectorAll('.field-row.wave').forEach(row => row.onclick = () => { const car = state.waveQueue.find(d => d.carIdx === Number(row.dataset.carIdx)); if (car) confirmAction(`Wave car ${car.carNumber}?`, `${car.name} will be moved up one lap and sent to the end of the pace line. The command is staggered from the previous release.`, () => action('wave', { carIdx: car.carIdx }), 'ISSUE WAVE-AROUND'); });
}

function renderTrack() {
    const group = $('orbit-cars'); group.replaceChildren(); const path = document.querySelector('.track-orbit path'); const length = path.getTotalLength(); const wave = new Set((state.waveQueue || []).map(d => d.carIdx)); const warn = new Set((state.violations || []).filter(v => v.status === 'warning').map(v => v.carIdx));
    for (const d of state.context.drivers || []) { if (!Number.isFinite(d.lapDistPct) || d.inWorld === false) continue; const p = path.getPointAtLength(((d.lapDistPct % 1 + 1) % 1) * length); const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y); circle.setAttribute('r', d.position === 1 ? 8 : 5); circle.setAttribute('fill', warn.has(d.carIdx) ? '#ff5364' : wave.has(d.carIdx) ? '#9b6cff' : d.position === 1 ? '#36d6e7' : '#b8ccd4'); group.append(circle); }
    $('orbit-phase').textContent = state.phase.replaceAll('-', ' ').toUpperCase(); $('orbit-summary').textContent = `${state.context.drivers?.length || 0} cars · ${state.waveQueue?.length || 0} wave candidates · ${state.violations?.filter(v => v.status === 'warning').length || 0} warnings`;
}

function renderEvents() {
    const events = (state.audit || []).filter(item => ['deployed', 'code80-active', 'pack-ready', 'wave-around', 'violation-warning', 'penalty-queued', 'one-to-green', 'restart-armed', 'green', 'cancelled', 'incident-cluster-review', 'command-result'].includes(item.type)).slice(-40).reverse();
    $('event-feed').innerHTML = events.length ? events.map(item => `<div class="event-item"><time>${new Date(item.at).toLocaleTimeString([], { hour12: false })}</time><div><b>${escapeHtml(item.type.replaceAll('-', ' '))}</b><p>${escapeHtml(eventSummary(item))}</p></div></div>`).join('') : '<p class="empty">Events will appear here.</p>';
}
function eventSummary(item) { if (item.name) return `Car ${item.carNumber || ''} · ${item.name}`; if (item.reason) return item.reason; if (item.procedure) return procedureName(item.procedure); if (item.result) return item.result.sent === false ? item.result.reason : 'Command accepted by local write path'; return 'Race Control state updated'; }
function renderPenalties() { const list = state.penalties || []; $('penalty-count').textContent = list.length; $('penalty-list').innerHTML = list.length ? list.map(p => `<div class="penalty-card"><b>#${escapeHtml(p.carNumber)} · ${escapeHtml(p.name)}</b>${escapeHtml(p.reason.replaceAll('-', ' '))} · ${escapeHtml(p.status.replaceAll('-', ' '))}</div>`).join('') : '<p class="empty">No penalties queued.</p>'; }
function renderSimCars() { const current = $('sim-car').value; $('sim-car').innerHTML = (state.context.drivers || []).map(d => `<option value="${d.carIdx}">#${escapeHtml(d.carNumber)} · ${escapeHtml(d.name)}</option>`).join(''); if (current) $('sim-car').value = current; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

$('apply-settings').onclick = async () => { if (await action('configure', readPlan())) toast('Race plan saved.'); };
$('deploy-button').onclick = () => confirmAction(`Deploy ${procedureName(readPlan().procedure)}?`, `${$('output-armed').checked ? 'LIVE: iRacing chat commands and enabled audio will be transmitted.' : 'PREVIEW: commands are logged but will not reach iRacing.'} The current physical order will be captured at activation.`, async () => { if (await action('configure', readPlan())) action('deploy', { procedure: readPlan().procedure, reason: 'Race Control deployment' }); }, 'DEPLOY NOW');
$('cancel-button').onclick = () => confirmAction('Cancel active procedure?', 'Drivers will be told that the procedure is cancelled and must remain under Race Control instructions.', () => action('cancel', { reason: 'Cancelled by operator' }), 'CANCEL PROCEDURE');
document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => {
    const name = button.dataset.action; const payload = button.dataset.delta ? { delta: Number(button.dataset.delta) } : {};
    const confirmations = {
        'pack-ready': ['Confirm the pack is stable?', 'This may open pit lane and begin automatic wave-arounds. Verify the complete field is formed before continuing.', 'CONFIRM PACK'],
        'one-to-green': ['Call one to green?', 'Pit lane opens and every driver is told to prepare for the restart. Running order remains locked.', 'CALL ONE TO GREEN'],
        restart: ['Arm restart enforcement?', 'The current physical order is locked. Passing before the control line can create a deferred penalty.', 'ARM RESTART'],
        green: ['Force green and release penalties?', 'Racing resumes immediately and every deferred black-flag command enters the serial send queue. This cannot be recalled automatically.', 'FORCE GREEN'],
    };
    const prompt = confirmations[name];
    if (prompt) confirmAction(prompt[0], prompt[1], () => action(name, payload), prompt[2]); else action(name, payload);
});
$('simulation-toggle').onchange = event => action('simulation', { active: event.target.checked });
$('output-armed').onchange = event => {
    if (event.target.checked) {
        confirmAction('Arm live iRacing output?', 'From this point, deployment buttons can send administrator chat commands and hold the configured voice PTT key. Confirm that this computer is the session admin, the live session identity is correct, and the audio route has been tested.', async () => { const ok = state.active ? await action('arm-output', { active: true }) : await action('configure', readPlan()); if (!ok) $('output-armed').checked = false; }, 'ARM LIVE OUTPUT', () => { $('output-armed').checked = false; });
    } else {
        api.ptt(false, $('ptt-key').value);
        state.active ? action('arm-output', { active: false }) : action('configure', readPlan());
    }
};
$('interlock-ack').onclick = () => confirmAction('Acknowledge live authority?', 'Confirm iRacing is back at the live frame in the same race session. The procedure resumes DISARMED; arm output separately only after checking the field.', () => action('interlock-ack'), 'RESUME DISARMED');
$('recovery-resume').onclick = () => confirmAction('Resume interrupted procedure?', 'The saved order, warnings, waves and queued penalties will be restored only if the exact race session is loaded. Output remains DISARMED.', () => action('recovery', { mode: 'resume' }), 'RESUME DISARMED');
$('recovery-close').onclick = () => confirmAction('Close interrupted record?', 'The interrupted procedure will be archived locally without transmitting cancellation, green or penalty commands. Reconcile the live session manually first.', () => action('recovery', { mode: 'close' }), 'CLOSE WITHOUT OUTPUT');
$('driver-filter').oninput = renderField; $('field-view').onchange = renderField;
document.querySelectorAll('[data-sim]').forEach(button => button.onclick = () => action('simulate', { simAction: button.dataset.sim, carIdx: $('sim-car').value }));
$('export-audit').onclick = async () => { const result = await api.exportAudit(); if (result.ok) toast(`Audit exported to ${result.path}`); };
document.querySelectorAll('input[name="procedure"]').forEach(radio => radio.onchange = () => { $('deploy-label').textContent = procedureName(radio.value); });

async function loadAudioDevices() { try { const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); const select = $('audio-device'); const saved = state?.config?.audio?.outputDeviceId || ''; select.innerHTML = '<option value="">Default Windows output</option>' + devices.map(d => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Output ${select.options.length + 1}`)}</option>`).join(''); select.value = saved; } catch (error) { toast(`Audio device list unavailable: ${error.message}`, true); } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function waitForAudio(audio) {
    if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Audio file did not become ready in time.')), 5000);
        audio.addEventListener('canplay', () => { clearTimeout(timeout); resolve(); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Audio file could not be loaded.')); }, { once: true });
        audio.load();
    });
}
async function playAnnouncement(item) {
    const audio = new Audio(item.url);
    if (item.deviceId && typeof audio.setSinkId === 'function') await audio.setSinkId(item.deviceId);
    await waitForAudio(audio);
    let pttHeld = false;
    try {
        const live = item.armed && state?.config?.outputArmed;
        if (live) {
            pttHeld = await api.ptt(true, item.key);
            if (!pttHeld) throw new Error('iRacing PTT could not be engaged. Check the simulator window and configured key.');
            await delay(140);
        }
        const ended = new Promise((resolve, reject) => {
            audio.addEventListener('ended', resolve, { once: true });
            audio.addEventListener('error', () => reject(new Error('Audio playback failed.')), { once: true });
        });
        await audio.play();
        await ended;
        if (pttHeld) await delay(100);
    } finally {
        if (pttHeld) await api.ptt(false, item.key);
    }
}
api.onAudio(item => {
    audioQueue = audioQueue.then(() => playAnnouncement(item)).catch(error => {
        toast(`Audio announcement failed: ${error.message}`, true);
    });
});
api.onAudioError(message => toast(`Speech generation failed: ${message}`, true));
api.onAttention(item => toast(item.result.blockedReason
    ? `Automatic call blocked: ${item.result.blockedReason}`
    : `Race Control review: ${item.result.uniqueCars} cars in a confirmed 4x cluster.`, !!item.result.blockedReason));
api.onCommand(command => { if (!command.armed) toast(`Preview: ${command.text}`); });
api.onState(next => { state = next; render(); });

(async () => { $('gsrc-logo').src = await api.logo(); state = await api.state(); writePlan(state.config); render(); await loadAudioDevices(); })();
