'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SafetyCarController, speakCarNumber } = require('../src/controller');

function context() {
    return { connected: true, simulated: true, stale: false, isRace: true, trackLengthM: 5000, leaderLap: 10, sessionTime: 600, drivers: [
        { carIdx: 1, carNumber: '1', name: 'Leader', lapCompleted: 10, lapDistPct: .8, speedKph: 72, inWorld: true },
        { carIdx: 2, carNumber: '23', name: 'Second', lapCompleted: 10, lapDistPct: .7, speedKph: 78, inWorld: true },
        { carIdx: 3, carNumber: '007', name: 'Lapped', lapCompleted: 9, lapDistPct: .75, speedKph: 78, inWorld: true },
    ] };
}

test('Code 80 countdown locks order and reaches gathering', () => {
    let now = 1000; const commands = [];
    const controller = new SafetyCarController({ countdownSeconds: 10 }, { now: () => now });
    controller.on('command', command => commands.push(command));
    controller.updateContext(context()); controller.deploy('code80-bunch', 'test');
    assert.equal(controller.phase, 'countdown');
    now = 11001; controller.updateContext(context());
    assert.equal(controller.phase, 'gathering');
    assert.equal(controller.orderLock.entries.length, 3);
    assert.ok(commands.some(command => command.text.includes('CODE 80 ACTIVE')));
});

test('uncorrected pass queues penalty and green issues it', () => {
    let now = 1000; const commands = [];
    const controller = new SafetyCarController({ countdownSeconds: 0, passCorrectionSeconds: 30, outputArmed: true }, { now: () => now });
    controller.on('command', command => commands.push(command));
    controller.updateContext(context()); controller.deploy('code80-bunch');
    now = 11001; controller.updateContext(context());
    const passed = context(); passed.drivers[1].lapDistPct = .82;
    controller.updateContext(passed);
    now += 1000; controller.updateContext(passed);
    assert.ok(controller.snapshot().violations.some(v => v.type === 'illegal-pass'));
    now += 31000; controller.updateContext(passed);
    assert.equal(controller.penalties[0].status, 'deferred-until-green');
    controller.forceGreen();
    assert.ok(commands.some(command => command.text === '!black #23 D'));
});

test('wave-around requires eligibility and speaks leading zero number naturally', () => {
    const controller = new SafetyCarController({}, { now: () => 1000 }); const commands = [];
    controller.on('command', command => commands.push(command)); controller.updateContext(context()); controller.deploy('manual-driver'); controller.markPackReady(); controller.issueWave(3);
    assert.ok(commands.some(command => command.text.startsWith('!waveby #007')));
    assert.ok(commands.some(command => command.speechText?.includes('zero zero seven')));
    assert.equal(speakCarNumber('123'), 'one two three');
});

test('wave-around cannot be issued before the pack is stable', () => {
    const controller = new SafetyCarController({}, { now: () => 1000 });
    controller.updateContext(context());
    assert.throws(() => controller.issueWave(3), /only after the field is marked stable/);
});

test('leader gather target is enforced separately from the field limit', () => {
    let now = 1000;
    const controller = new SafetyCarController({ countdownSeconds: 0, leaderGatherKph: 72, speedToleranceKph: 4 }, { now: () => now });
    controller.updateContext(context()); controller.deploy('code80-bunch');
    now += 1; controller.updateContext(context());
    const fastLeader = context(); fastLeader.drivers[0].speedKph = 80;
    controller.updateContext(fastLeader);
    now += 2000; controller.updateContext(fastLeader);
    const warning = controller.snapshot().violations.find(v => v.type === 'leader-pace');
    assert.equal(warning.carIdx, 1);
    assert.equal(warning.targetKph, 72);
});

test('strict Code 80 never opens a wave-around phase', () => {
    let now = 1000;
    const controller = new SafetyCarController({ countdownSeconds: 0, waveArounds: true }, { now: () => now });
    controller.updateContext(context()); controller.deploy('code80-strict');
    now += 1; controller.updateContext(context()); controller.markPackReady();
    assert.equal(controller.phase, 'controlled');
    assert.deepEqual(controller.snapshot().waveQueue, []);
});

test('automatic waves wait for a stable pack and stagger releases', () => {
    let now = 1000; const commands = [];
    const packed = context();
    packed.drivers[1].lapDistPct = .795;
    packed.drivers[2].lapDistPct = .79;
    packed.drivers.push({ carIdx: 4, carNumber: '44', name: 'Lapped Two', lapCompleted: 9, lapDistPct: .785, speedKph: 78, inWorld: true });
    const controller = new SafetyCarController({ countdownSeconds: 0, waveMode: 'automatic', waveIntervalSeconds: 5, packGapSeconds: 4, packStableHoldSeconds: 3 }, { now: () => now });
    controller.on('command', command => commands.push(command));
    controller.updateContext(packed); controller.deploy('code80-bunch');
    now += 1; controller.updateContext(packed);
    now += 3001; controller.updateContext(packed);
    assert.equal(controller.phase, 'wave-arounds');
    assert.equal(commands.filter(command => command.text.startsWith('!waveby')).length, 1);
    now += 4999; controller.updateContext(packed);
    assert.equal(commands.filter(command => command.text.startsWith('!waveby')).length, 1);
    now += 1; controller.updateContext(packed);
    assert.equal(commands.filter(command => command.text.startsWith('!waveby')).length, 2);
});

test('native yellow automatic waves can recognise a stable pack without Code 80 pace', () => {
    let now = 1000; const commands = [];
    const packed = context();
    packed.drivers[0].speedKph = 110; packed.drivers[1].lapDistPct = .795; packed.drivers[2].lapDistPct = .79;
    const controller = new SafetyCarController({ waveMode: 'automatic', packGapSeconds: 4, packStableHoldSeconds: 3 }, { now: () => now });
    controller.on('command', command => commands.push(command));
    controller.updateContext(packed); controller.deploy('native');
    now += 1; controller.updateContext(packed); now += 3001; controller.updateContext(packed);
    assert.equal(controller.phase, 'wave-arounds');
    assert.ok(commands.some(command => command.text.startsWith('!waveby #007')));
});

test('a corrected pass does not become a penalty', () => {
    let now = 1000;
    const controller = new SafetyCarController({ countdownSeconds: 0, passCorrectionSeconds: 30 }, { now: () => now });
    controller.updateContext(context()); controller.deploy('code80-bunch'); now += 1; controller.updateContext(context());
    const passed = context(); passed.drivers[1].lapDistPct = .82; controller.updateContext(passed);
    now += 1000; controller.updateContext(passed);
    now += 15000; controller.updateContext(context());
    now += 20000; controller.updateContext(context());
    assert.equal(controller.penalties.length, 0);
    assert.equal(controller.snapshot().violations.find(v => v.carIdx === 2).status, 'corrected');
});

test('passing a car that entered pit road is not an illegal overtake', () => {
    let now = 1000;
    const controller = new SafetyCarController({ countdownSeconds: 0 }, { now: () => now });
    controller.updateContext(context()); controller.deploy('code80-bunch'); now += 1; controller.updateContext(context());
    const pitting = context();
    pitting.drivers[1].onPitRoad = true; pitting.drivers[1].lapDistPct = .65;
    pitting.drivers[2].lapDistPct = .72;
    controller.updateContext(pitting);
    assert.equal(controller.snapshot().violations.some(v => v.type === 'illegal-pass'), false);
});

test('native yellow exposes exact pace-lap commands', () => {
    const commands = [];
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => 1000 });
    controller.on('command', command => commands.push(command));
    controller.updateContext(context()); controller.deploy('native');
    controller.adjustPaceLaps(-1); controller.adjustPaceLaps(2);
    assert.ok(commands.some(command => command.text === '!pacelaps -1'));
    assert.ok(commands.some(command => command.text === '!pacelaps +2'));
    controller.cancel(); controller.deploy('code80-bunch');
    assert.throws(() => controller.adjustPaceLaps(1), /only during an active iRacing yellow/);
});

test('native yellow defers pace and order enforcement to iRacing', () => {
    const controller = new SafetyCarController({ speedLimitKph: 80 }, { now: () => 1000 });
    const fast = context(); fast.drivers.forEach(driver => { driver.speedKph = 120; });
    controller.updateContext(fast); controller.deploy('native'); controller.updateContext(fast);
    assert.deepEqual(controller.snapshot().violations, []);
    assert.deepEqual(controller.penalties, []);
});

test('saved schedule is generated at controller startup and reconfiguration resets calls', () => {
    const controller = new SafetyCarController({ schedule: { enabled: true, randomized: false, count: 2, first: 10, last: 20, manualPoints: [10, 20] } });
    assert.deepEqual(controller.schedule, [10, 20]);
    controller.noteNativeYellow();
    assert.equal(controller.scheduleStatus()[0].called, true);
    controller.configure({ outputArmed: true });
    assert.equal(controller.scheduleStatus()[0].called, true);
    controller.configure({ schedule: { manualPoints: [12, 18] } });
    assert.deepEqual(controller.scheduleStatus(), [{ index: 0, point: 12, called: false }, { index: 1, point: 18, called: false }]);
});

test('scheduled native-yellow echo does not consume the following slot', () => {
    const initial = context(); initial.leaderLap = 9;
    const controller = new SafetyCarController({}, { now: () => 1000 });
    controller.configure({ procedure: 'native', controlMode: 'automatic', schedule: { enabled: true, randomized: false, count: 2, first: 10, last: 20, manualPoints: [10, 20] } });
    controller.updateContext(initial);
    const due = context(); due.leaderLap = 10; controller.updateContext(due);
    assert.deepEqual(controller.scheduleStatus().map(item => item.called), [true, false]);
    controller.noteNativeYellow();
    assert.deepEqual(controller.scheduleStatus().map(item => item.called), [true, false]);
});

test('external native yellow consumes one remaining scheduled call', () => {
    const controller = new SafetyCarController({}, { now: () => 1000 });
    controller.configure({ schedule: { enabled: true, randomized: false, count: 2, first: 10, last: 20, manualPoints: [10, 20] } });
    controller.noteNativeYellow();
    assert.deepEqual(controller.scheduleStatus().map(item => item.called), [true, false]);
});

test('automatic confirmed 4x cluster deploys only at configured threshold', () => {
    const controller = new SafetyCarController({ controlMode: 'automatic', countdownSeconds: 10, incidentTrigger: { enabled: true, reviewAt: 3, autoAt: 5, trackWindowPct: 10, timeWindowSeconds: 3 } }, { now: () => 1000 });
    controller.updateContext(context());
    for (let carIdx = 10; carIdx < 14; carIdx += 1) controller.addIncident({ carIdx, points: 4, lapDistPct: .98, at: 1000 + carIdx });
    assert.equal(controller.phase, 'idle');
    controller.addIncident({ carIdx: 14, points: 4, lapDistPct: .02, at: 1014 });
    assert.equal(controller.phase, 'countdown');
});

test('automatic incident trigger degrades to review outside a race without throwing', () => {
    const controller = new SafetyCarController({ controlMode: 'automatic', incidentTrigger: { enabled: true, reviewAt: 3, autoAt: 5, trackWindowPct: 10, timeWindowSeconds: 3 } }, { now: () => 1000 });
    controller.updateContext({ connected: true, stale: false, isRace: false, drivers: [] });
    let result;
    for (let carIdx = 10; carIdx < 15; carIdx += 1) result = controller.addIncident({ carIdx, points: 4, lapDistPct: .5, at: 1000 + carIdx });
    assert.equal(result.action, 'review');
    assert.match(result.blockedReason, /not a Race session/);
    assert.equal(controller.phase, 'idle');
});

test('deployment is blocked outside a live race context', () => {
    const controller = new SafetyCarController();
    controller.updateContext({ connected: true, stale: false, isRace: false, drivers: [] });
    assert.throws(() => controller.deploy('native'), /not a Race session/);
});

test('live output can always be disarmed during an active procedure', () => {
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => 1000 });
    controller.updateContext(context()); controller.deploy('manual-driver');
    controller.setOutputArmed(false);
    assert.equal(controller.config.outputArmed, false);
    assert.equal(controller.config.speedLimitKph, 80);
    assert.throws(() => controller.configure({ speedLimitKph: 200 }), /End or resolve the active safety-car procedure/);
    assert.throws(() => controller.setOutputArmed(true), /rehearsal mode/);
});

test('restart-line overtake queues immediately and is issued at green', () => {
    let now = 1000; const commands = [];
    const controller = new SafetyCarController({ outputArmed: true }, { now: () => now });
    controller.on('command', command => commands.push(command));
    controller.updateContext(context()); controller.deploy('manual-driver'); controller.oneToGreen(); controller.beginRestart();
    const passed = context(); passed.drivers[1].lapDistPct = .82; passed.drivers[0].lapDistPct = .81;
    now += 1; controller.updateContext(passed);
    assert.equal(controller.penalties[0].status, 'deferred-until-green');
    const crossed = context(); crossed.drivers[0].lapDistPct = .05; crossed.drivers[0].lapCompleted = 11;
    crossed.drivers[1].lapDistPct = .04; crossed.drivers[1].lapCompleted = 11;
    now += 1; controller.updateContext(crossed);
    assert.ok(commands.some(command => command.text === '!black #23 D'));
});
