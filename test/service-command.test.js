'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OperationLedger } = require('../src/operation-ledger');
const { ControllerService } = require('../src/service');

function liveContext() {
    return { connected: true, simulated: false, stale: false, isRace: true, sessionState: 4, replayLive: true, sessionIdentity: '88001:1', drivers: [
        { carIdx: 1, inWorld: true }, { carIdx: 2, inWorld: true },
    ] };
}

function harness(t, dispatcher) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsrc-safety-service-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const ledger = new OperationLedger({ directory });
    const service = new ControllerService({ dispatcher, ledger, config: { outputArmed: true } });
    service.controller.context = liveContext(); service.controller.boundSessionIdentity = '88001:1';
    t.after(() => service.stop());
    return { service, ledger };
}

test('serial command queue rechecks authority and cancels queued output after emergency disarm', async t => {
    let releaseFirst; let startedFirst;
    const firstStarted = new Promise(resolve => { startedFirst = resolve; });
    const waitFirst = new Promise(resolve => { releaseFirst = resolve; });
    const calls = [];
    const { service, ledger } = harness(t, { handle: async request => {
        calls.push(request.command.value.text);
        if (calls.length === 1) { startedFirst(); await waitFirst; }
        return { sent: true };
    } });
    const first = service._dispatch({ id: 'procedure:1', armed: true, text: '/all first' });
    const second = service._dispatch({ id: 'procedure:2', armed: true, text: '/all second' });
    await firstStarted;
    service.controller.setOutputArmed(false);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ['/all first']);
    assert.equal(ledger.commandResult('procedure:1').sent, true);
    assert.match(ledger.commandResult('procedure:2').reason, /disarmed/);
});

test('durable successful command result blocks duplicate replay across retries', async t => {
    let calls = 0;
    const { service, ledger } = harness(t, { handle: async () => { calls += 1; return { sent: true }; } });
    const command = { id: 'procedure:wave:7', armed: true, text: '!waveby #7' };
    await service._dispatch(command);
    await service._dispatch(command);
    assert.equal(calls, 1);
    assert.equal(ledger.commandResult(command.id).sent, true);
});

test('rehearsal state blocks even a malformed armed command before the live adapter', async t => {
    let calls = 0;
    const { service, ledger } = harness(t, { handle: async () => { calls += 1; return { sent: true }; } });
    service.simulation = true; service.controller.context = { ...liveContext(), simulated: true };
    await service._dispatch({ id: 'bad-rehearsal-command', armed: true, text: '!yellow' });
    assert.equal(calls, 0);
    assert.match(ledger.commandResult('bad-rehearsal-command').reason, /rehearsal/);
});

test('failed local send disarms and interlocks later live output', async t => {
    let calls = 0;
    const { service, ledger } = harness(t, { handle: async () => { calls += 1; return { sent: false, reason: 'enter key injection failed' }; } });
    await service._dispatch({ id: 'procedure:failed', armed: true, text: '!pitclose' });
    assert.equal(calls, 1);
    assert.equal(service.controller.config.outputArmed, false);
    assert.match(service.controller.interlock.reason, /enter key injection failed/);
    assert.equal(ledger.commandResult('procedure:failed').sent, false);
});
