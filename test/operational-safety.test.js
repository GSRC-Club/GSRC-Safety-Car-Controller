'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SafetyCarController } = require('../src/controller');
const { OperationLedger } = require('../src/operation-ledger');
const { TelemetryTraceRecorder, RecordedTraceRunner } = require('../src/telemetry-trace');

function liveContext(patch = {}) {
    return {
        connected: true, simulated: false, stale: false, isRace: true, sessionState: 4,
        replayLive: true, sessionIdentity: '88001:1', trackLengthM: 5000, leaderLap: 10,
        sessionTime: 600, paceCarLapDistPct: .83,
        drivers: [
            { carIdx: 1, carNumber: '1', name: 'Leader', lapCompleted: 10, lapDistPct: .8, speedKph: 72, inWorld: true },
            { carIdx: 2, carNumber: '23', name: 'Second', lapCompleted: 10, lapDistPct: .79, speedKph: 78, inWorld: true },
            { carIdx: 3, carNumber: '007', name: 'Lapped', lapCompleted: 9, lapDistPct: .78, speedKph: 78, inWorld: true },
        ],
        ...patch,
    };
}

function tempLedger(t, now = () => Date.now()) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsrc-safety-ledger-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return new OperationLedger({ directory, now });
}

test('continuous authority loss disarms and freezes autonomous actions until acknowledged', () => {
    let now = 1000; const commands = [];
    const controller = new SafetyCarController({ outputArmed: true, countdownSeconds: 0, waveMode: 'automatic', packStableHoldSeconds: 1 }, { now: () => now });
    controller.on('command', command => commands.push(command));
    controller.updateContext(liveContext()); controller.deploy('code80-bunch');
    now += 1; controller.updateContext(liveContext());
    const before = commands.length;
    now += 5000; controller.updateContext(liveContext({ stale: true }));
    assert.equal(controller.config.outputArmed, false);
    assert.match(controller.interlock.reason, /stale/);
    assert.equal(controller.phase, 'gathering');
    assert.equal(commands.length, before);
    assert.throws(() => controller.acknowledgeInterlock(), /stale/);
    controller.updateContext(liveContext());
    controller.acknowledgeInterlock();
    assert.equal(controller.interlock, null);
    assert.equal(controller.config.outputArmed, false);
});

test('session replacement cannot acknowledge or resume a bound live procedure', () => {
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => 1000 });
    controller.updateContext(liveContext()); controller.deploy('manual-driver');
    controller.updateContext(liveContext({ sessionIdentity: '99002:1' }));
    assert.match(controller.interlock.reason, /changed/);
    assert.throws(() => controller.acknowledgeInterlock(), /changed/);
});

test('rehearsal commands are structurally incapable of becoming armed', () => {
    const commands = [];
    const context = liveContext({ simulated: true, sessionIdentity: 'rehearsal:0' });
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => 1000 });
    controller.on('command', command => commands.push(command));
    controller.updateContext(context); controller.deploy('native');
    assert(commands.length > 0);
    assert.equal(commands.some(command => command.armed), false);
    assert.throws(() => controller.setOutputArmed(true), /rehearsal mode/);
});

test('failed live wave command returns the car to eligibility and permits one deliberate retry', () => {
    const commands = [];
    let now = 1000;
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => now });
    controller.on('command', command => commands.push(command));
    controller.updateContext(liveContext({ sessionFlags: 0x4000 })); controller.deploy('native'); controller.markPackReady();
    controller.issueWave(3);
    const first = commands.find(command => command.text.startsWith('!waveby'));
    assert(first?.armed);
    assert.equal(commands.some(command => command.text.includes('WAVE-AROUND AUTHORIZED')), false);
    assert.equal(controller.snapshot().waveQueue.some(driver => driver.carIdx === 3), false);
    controller.recordCommandResult(first.id, { sent: false, reason: 'clipboard unavailable' });
    assert.equal(commands.some(command => command.text.includes('WAVE-AROUND AUTHORIZED')), false);
    assert.equal(controller.snapshot().waveQueue.some(driver => driver.carIdx === 3), true);
    now += 5000; controller.issueWave(3);
    assert.equal(commands.filter(command => command.text.startsWith('!waveby')).length, 2);
});

test('live wave announcement is released only after the administrator wave command succeeds', () => {
    const commands = [];
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => 1000 });
    controller.on('command', command => commands.push(command));
    controller.updateContext(liveContext({ sessionFlags: 0x4000 })); controller.deploy('native'); controller.markPackReady();
    controller.issueWave(3);
    const wave = commands.find(command => command.text.startsWith('!waveby'));
    assert.equal(commands.some(command => command.text.includes('WAVE-AROUND AUTHORIZED')), false);
    controller.recordCommandResult(wave.id, { sent: true });
    assert.equal(commands.some(command => command.text.includes('WAVE-AROUND AUTHORIZED')), true);
    assert.equal(controller.snapshot().waveQueue.some(driver => driver.carIdx === 3), false);
});

test('green remains recoverable until every deferred penalty command has a result', async () => {
    const commands = [];
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => 1000 });
    controller.on('command', command => commands.push(command));
    controller.updateContext(liveContext()); controller.deploy('manual-driver');
    controller.penalties.push({ carIdx: 2, carNumber: '23', name: 'Second', reason: 'illegal-pass', penalty: 'D', queuedAt: 1000, status: 'deferred-until-green' });
    controller.forceGreen();
    const penaltyCommand = commands.find(command => command.text === '!black #23 D');
    assert.equal(controller.phase, 'green');
    assert.equal(controller.penalties[0].status, 'send-pending');
    for (const command of commands.filter(item => item.armed && controller.pendingCommands.has(item.id))) controller.recordCommandResult(command.id, { sent: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.phase, 'idle');
    assert.equal(controller.penalties[0].status, 'issued-local-path');
});

test('interrupted active state reopens as recovery-required and resumes only in the exact session', t => {
    let now = 1000; const ledger = tempLedger(t, () => now);
    const first = new SafetyCarController({ outputArmed: true }, { now: () => now, ledger });
    first.updateContext(liveContext()); first.deploy('manual-driver'); first.markPackReady();
    const restored = new SafetyCarController({}, { now: () => ++now, ledger });
    assert.equal(restored.recoveryRequired, true);
    assert.equal(restored.config.outputArmed, false);
    restored.updateContext(liveContext({ sessionIdentity: 'different:1' }));
    assert.throws(() => restored.resolveRecovery('resume'), /changed/);
    restored.updateContext(liveContext());
    restored.resolveRecovery('resume');
    assert.equal(restored.recoveryRequired, false);
    assert.equal(restored.phase, 'wave-arounds');
    assert.equal(restored.config.outputArmed, false);
});

test('operation ledger detects tampering and exports only a verified hash chain', t => {
    const ledger = tempLedger(t, () => 1234);
    ledger.append('first', { value: 1 }); ledger.append('second', { value: 2 });
    assert.deepEqual(ledger.verify().ok, true);
    const exportPath = path.join(ledger.directory, 'export.json');
    ledger.exportBundle(exportPath, { phase: 'idle' });
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    assert.equal(exported.integrity.ok, true);
    const lines = fs.readFileSync(ledger.eventsPath, 'utf8').trim().split(/\r?\n/);
    const changed = JSON.parse(lines[0]); changed.data.value = 99; lines[0] = JSON.stringify(changed);
    fs.writeFileSync(ledger.eventsPath, `${lines.join('\n')}\n`);
    assert.equal(ledger.verify().ok, false);
    assert.throws(() => new OperationLedger({ directory: ledger.directory }), /integrity check/);
});

test('active procedure recovery state is checksummed before it can be trusted', t => {
    const ledger = tempLedger(t, () => 1234);
    ledger.saveActiveState({ active: true, phase: 'gathering', procedureId: 'test' });
    const envelope = JSON.parse(fs.readFileSync(ledger.statePath, 'utf8'));
    envelope.payload.phase = 'green';
    fs.writeFileSync(ledger.statePath, JSON.stringify(envelope));
    assert.throws(() => ledger.loadActiveState(), /integrity check/);
});

test('disconnect and pit-exit grace suppress transient running-order penalties', () => {
    let now = 1000;
    const controller = new SafetyCarController({ countdownSeconds: 0, rejoinGraceSeconds: 10, pitExitGraceSeconds: 5 }, { now: () => now });
    controller.updateContext(liveContext()); controller.deploy('code80-bunch'); now += 1; controller.updateContext(liveContext());
    const absent = liveContext(); absent.drivers[1].inWorld = false; controller.updateContext(absent);
    const rejoinedAhead = liveContext(); rejoinedAhead.drivers[1].lapDistPct = .81;
    now += 100; controller.updateContext(rejoinedAhead);
    assert.equal(controller.snapshot().violations.some(item => item.carIdx === 2), false);
    now += 10001; controller.updateContext(rejoinedAhead);
    now += 1000; controller.updateContext(rejoinedAhead);
    assert.equal(controller.snapshot().violations.some(item => item.carIdx === 2 && item.type === 'illegal-pass'), true);
});

test('recorded telemetry is redacted and replays adverse frames through the real controller interface', t => {
    let now = 1000;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsrc-safety-trace-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const recorder = new TelemetryTraceRecorder({ directory, now: () => now, intervalMs: 0 });
    recorder.record(liveContext()); now += 500;
    recorder.record(liveContext({ stale: true }));
    const raw = fs.readFileSync(recorder.status().file, 'utf8');
    assert.doesNotMatch(raw, /Leader|Second|Lapped/);
    const commands = []; let replayNow = 0;
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => replayNow });
    controller.on('command', command => commands.push(command));
    const frames = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
    replayNow = frames[0].at; controller.updateContext(frames[0].context); controller.deploy('manual-driver');
    const tail = path.join(directory, 'tail.jsonl'); fs.writeFileSync(tail, `${JSON.stringify(frames[1])}\n`);
    new RecordedTraceRunner({ controller, setNow: value => { replayNow = value; } }).run(tail);
    assert.match(controller.interlock.reason, /stale/);
    assert.equal(controller.config.outputArmed, false);
});

test('telemetry trace storage stops at a global cap instead of growing across sessions forever', t => {
    let now = 1000;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsrc-safety-trace-cap-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const recorder = new TelemetryTraceRecorder({ directory, now: () => now, intervalMs: 0, maxBytes: 10000, maxTotalBytes: 2500 });
    assert.equal(recorder.record(liveContext()), true);
    now += 500;
    recorder.record(liveContext({ sessionIdentity: '88002:1' }));
    while (!recorder.status().full) { now += 500; recorder.record(liveContext({ sessionIdentity: '88002:1' })); }
    const atCap = recorder.status().totalBytes;
    now += 500;
    assert.equal(recorder.record(liveContext({ sessionIdentity: '88003:1' })), false);
    assert.equal(recorder.status().totalBytes, atCap);
});

test('idle operation banner remains visually hidden until an interlock or recovery exists', () => {
    const css = fs.readFileSync(path.join(rootDirectory(), 'gui', 'operations.css'), 'utf8');
    assert.match(css, /\.operation-alert\[hidden\]\s*\{\s*display:\s*none/);
});

function rootDirectory() { return path.resolve(__dirname, '..'); }
