'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SafetyCarController } = require('../src/controller');
const { ControllerService, sessionIdentity, replayIsLive } = require('../src/service');
const { parseSessionInfo } = require('../shared/session-info-parser');
const { makeDispatcher } = require('../shared/command-dispatch');
const { deriveSpeeds, waveCandidates, lockOrder, detectIllegalPasses } = require('../src/rules');

function context(extra = {}) {
    return { connected: true, simulated: true, isRace: true, stale: false, sessionState: 4, replayLive: true, sessionIdentity: 'test:1', trackLengthM: 5000, leaderLap: 10, drivers: [
        { carIdx: 0, carNumber: '001', name: 'Leader', lapCompleted: 10, lapDistPct: .8, speedKph: 72, inWorld: true },
        { carIdx: 2, carNumber: '23', name: 'Second', lapCompleted: 10, lapDistPct: .79, speedKph: 80, inWorld: true },
        { carIdx: 3, carNumber: '007', name: 'Lapped', lapCompleted: 9, lapDistPct: .78, speedKph: 80, inWorld: true },
    ], ...extra };
}
function harness(config = {}, extra = {}) {
    let now = 1000; const commands = [];
    const c = new SafetyCarController({ countdownSeconds: 0, ...config }, { now: () => now });
    c.on('command', command => commands.push(command));
    c.updateContext(context(extra));
    return { c, commands, tick: (data = context(extra), ms = 200) => { now += ms; c.updateContext(data); } };
}

test('SDK end-of-tape distance zero is live, not an absolute frame endpoint', () => {
    assert.equal(replayIsLive(100000, 0), true);
    assert.equal(replayIsLive(100000, 180), true);
    assert.equal(replayIsLive(100000, 181), false);
    assert.equal(replayIsLive(100000, null), false);
});
test('AI identity requires observed AI roster and a connection-specific token', () => {
    const s = parseSessionInfo('WeekendInfo:\n  SubSessionID: 0\n  SimMode: full\nDriverInfo:\n  Drivers:\n    - CarIdx: 2\n      CarIsAI: 1\n      CarNumber: "007"\n');
    assert.equal(s.driverInfo.drivers[0].isAI, true);
    assert.equal(sessionIdentity(s, 1, 'connection-a'), 'ai:connection-a:1');
    assert.equal(sessionIdentity(s, 1), null);
    assert.notEqual(sessionIdentity(s, 1, 'connection-a'), sessionIdentity(s, 1, 'connection-b'));
});
test('announcements preserve /all and leader car index zero gets a private DM', () => {
    const { c, commands, tick } = harness(); c.deploy(); tick();
    assert.ok(commands.some(x => x.text.startsWith('/all CODE 80 ACTIVE')));
    assert.ok(commands.some(x => x.text.startsWith('/001 ') && x.text.includes('72')));
});
test('AI field rejects chat-only procedures with actionable native-yellow guidance', () => {
    const { c } = harness({}, { simulated: false, hasAI: true });
    assert.throws(() => c.deploy('code80-bunch'), /AI.*iRacing Yellow/);
    c.deploy('native'); assert.equal(c.procedure, 'native');
});
test('native release requests pace laps and waits for telemetry before declaring green', () => {
    const { c, commands, tick } = harness({}, { sessionFlags: 0x4000 });
    c.deploy('native'); tick(context({ sessionFlags: 0x4000 })); c.forceGreen();
    assert.notEqual(c.phase, 'green');
    assert.ok(commands.some(x => x.text === '!pacelaps 1'));
    tick(context({ sessionFlags: 4 })); assert.equal(c.phase, 'green');
});
test('Code80 wave is a private instruction, never a native scoring adjustment', () => {
    const { c, commands, tick } = harness(); c.deploy(); tick(); c.markPackReady(); c.issueWave(3);
    assert.ok(commands.some(x => x.text.startsWith('/007 ') && x.text.includes('WAVE')));
    assert.equal(commands.some(x => x.text.startsWith('!waveby')), false);
    const fast = context(); fast.drivers[2].speedKph = 160;
    tick(fast, 3000); tick(fast, 3000);
    assert.equal(c.snapshot().violations.some(x => x.carIdx === 3), false);
    assert.throws(() => c.oneToGreen(), /wave/i);
    c.completeWaves(); c.oneToGreen(); c.beginRestart();
    assert.equal(c.waved.size, 0);
});
test('Code80 lap adjustment tracks leader laps and calls one-to-green without releasing early', () => {
    const { c, commands, tick } = harness({ code80Laps: 3, waveArounds: false });
    c.deploy(); tick(); c.markPackReady(); c.adjustPaceLaps(-1);
    assert.equal(c.snapshot().code80LapsRemaining, 2);
    tick(context({ leaderLap: 11 })); assert.equal(c.phase, 'one-to-green');
    assert.equal(commands.some(x => x.text.startsWith('!pacelaps')), false);
});
test('failed paste or enter never reports successful chat delivery', async () => {
    const d = makeDispatcher({}, { warn() {}, info() {} }, { cmd: { init: () => true, chatCommand: () => true }, clipboard: { writeText() {} }, keySender: combo => combo !== 'enter', stepMs: 1 });
    const result = await d.handle({ type: 'command', command: { type: 'sim-chat', value: { text: '!yellow' } } });
    assert.equal(result.sent, false);
});
test('invalid position samples and pit-lane cars cannot create speeds or waves', () => {
    const cars = context().drivers; cars[2].onPitRoad = true;
    assert.equal(waveCandidates(cars, 0).length, 0);
    assert.equal(deriveSpeeds(new Map([[0, { lapDistPct: -1 }]]), cars, 5000, .2).size, 0);
});
test('frozen order catches a lapped car passing a lead-lap car on the road', () => {
    const cars = context().drivers; const lock = lockOrder(cars);
    cars[2].lapDistPct = .795;
    const violations = detectIllegalPasses(lock, cars);
    assert.equal(violations[0]?.carIdx, 3);
    assert.deepEqual(violations[0]?.passedCarIdxs, [2]);
});
test('a disappearing car cannot create a false pass between remaining cars', () => {
    const cars = context().drivers; cars[2].lapCompleted = 10;
    const lock = lockOrder(cars);
    cars[0].inWorld = false;
    assert.deepEqual(detectIllegalPasses(lock, cars), []);
});
test('AI YAML and SDK frames reach native yellow through the actual service queue', async t => {
    const sent = [];
    const service = new ControllerService({ dispatcher: { updateSession() {}, updateTelemetry() {}, async handle(request) { sent.push(request.command.value.text); return { sent: true }; } } });
    t.after(() => service.stop());
    const yaml = 'WeekendInfo:\n  SubSessionID: 0\n  SimMode: full\n  TrackLength: 6.213 km\nSessionInfo:\n  Sessions:\n    - SessionNum: 0\n      SessionType: Race\nDriverInfo:\n  Drivers:\n    - CarIdx: 0\n      CarNumber: "001"\n      CarIsAI: 0\n    - CarIdx: 2\n      CarNumber: "22"\n      CarIsAI: 1\n';
    let tick = 1;
    const values = { SessionNum: 0, SessionTime: 100, SessionState: 4, SessionFlags: 0, ReplayFrameNum: 6000, ReplayFrameNumEnd: 0, CarIdxTrackSurface: [3, -1, 3], CarIdxLapCompleted: [3, 0, 3], CarIdxLapDistPct: [.8, -1, .79] };
    service.reader = { view: {}, isConnected: () => true, readFrame: () => ({ tick: tick++, values: { ...values } }), readSessionInfoIfChanged: () => yaml, close() {} };
    service._poll();
    assert.equal(service.controller.snapshot().authority.ok, true);
    assert.equal(service.controller.context.hasAI, true);
    service.controller.setOutputArmed(true); service.controller.deploy('native');
    await service.commandQueue;
    assert.equal(sent[0], '!yellow GSRC SAFETY CAR DEPLOYED');
    values.SessionFlags = 0x4000; values.SessionTime += .2; service._poll();
    assert.equal(service.controller.nativeYellowSeen, true);
    service.controller.adjustPaceLaps(-1); await service.commandQueue;
    assert.ok(sent.includes('!pacelaps -1'));
    const identity = service.controller.boundSessionIdentity;
    service._publishDisconnected(); service._poll();
    assert.notEqual(service.controller.context.sessionIdentity, identity);
    assert.equal(service.controller.config.outputArmed, false);
    assert.throws(() => service.controller.acknowledgeInterlock(), /changed/);
});
test('native yellow not acknowledged by telemetry freezes with useful diagnostics', () => {
    const { c, tick } = harness({ outputArmed: true }, { simulated: false, sessionFlags: 0 });
    c.deploy('native'); tick(context({ simulated: false, sessionFlags: 0 }), 16000);
    assert.equal(c.config.outputArmed, false);
    assert.match(c.interlock.reason, /not confirmed.*15 seconds/);
});
test('authority loss between paste and enter aborts a chat command', async () => {
    let calls = 0; const keys = [];
    const d = makeDispatcher({}, { warn() {}, info() {} }, { cmd: { init: () => true, chatCommand: () => true }, clipboard: { writeText() {} }, keySender: key => { keys.push(key); return true; }, sleep: async () => {}, canSendChat: () => ++calls < 3 });
    assert.equal((await d.handle({ type: 'command', command: { type: 'sim-chat', value: { text: '!yellow' } } })).sent, false);
    assert.equal(keys.includes('enter'), false); assert.ok(keys.includes('escape'));
});
test('configuration cannot bypass arming authority while disconnected', () => {
    const c = new SafetyCarController();
    assert.throws(() => c.configure({ outputArmed: true }), /disconnected/);
    assert.equal(c.config.outputArmed, false);
});
test('one-lap Code80 reduction waits for pack readiness and explicit restart', () => {
    const { c, tick } = harness({ code80Laps: 3, waveArounds: false });
    c.deploy(); tick(); c.adjustPaceLaps(-10); tick();
    assert.equal(c.phase, 'gathering');
    c.markPackReady(); tick(); assert.equal(c.phase, 'one-to-green');
    tick(context({ leaderLap: 15 })); assert.equal(c.phase, 'one-to-green');
});
test('replay files and unidentified non-AI sessions never gain fallback authority', () => {
    assert.equal(sessionIdentity({ weekendInfo: { simMode: 'replay' }, driverInfo: { drivers: [{ isAI: true }] } }, 0, 'connection'), null);
    assert.equal(sessionIdentity({ weekendInfo: { simMode: 'full' }, driverInfo: { drivers: [{ isAI: false }] } }, 0, 'connection'), null);
});
test('planned Code80 restart cannot silently skip the waiting wave queue', () => {
    const { c, tick } = harness({ code80Laps: 1 });
    c.deploy(); tick(); c.markPackReady(); tick();
    assert.equal(c.phase, 'wave-arounds');
    assert.equal(c.snapshot().waveQueue.length, 1);
    c.completeWaves(); tick(); assert.equal(c.phase, 'one-to-green');
});
