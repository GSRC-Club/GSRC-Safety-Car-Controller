'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SafetyCarController } = require('../src/controller');

function offline() {
    return { connected: true, simulated: false, stale: false, isRace: true, sessionState: 4,
        replayLive: true, sessionIdentity: 'ai:connection-token:0', hasAI: true, leaderLap: 10,
        drivers: [
            { carIdx: 0, carNumber: '1', inWorld: true, lapCompleted: 10, lapDistPct: .8 },
            { carIdx: 1, carNumber: '2', inWorld: true, isAI: true, lapCompleted: 10, lapDistPct: .7 },
        ] };
}
test('offline AI Deploy falls back to native yellow without changing the saved Code80 plan', () => {
    const c = new SafetyCarController(); const commands = [];
    c.on('command', command => commands.push(command));
    c.updateContext(offline()); c.setOutputArmed(true); c.deploy('code80-bunch');
    assert.equal(c.procedure, 'native');
    assert.equal(c.config.procedure, 'code80-bunch');
    assert.ok(commands.some(command => command.armed && command.text.startsWith('!yellow')));
    assert.ok(c.audit.some(item => item.type === 'offline-native-fallback'));
});
test('scheduled offline AI Code80 calls use native yellow and account for its echo once', () => {
    const c = new SafetyCarController({ controlMode: 'automatic', schedule: { enabled: true, randomized: false, count: 2, first: 10, last: 20, manualPoints: [10, 20] } });
    c.updateContext(offline());
    assert.equal(c.procedure, 'native');
    assert.equal(c.phase, 'controlled');
    c.noteNativeYellow();
    assert.deepEqual(c.scheduleStatus().map(item => item.called), [true, false]);
});
