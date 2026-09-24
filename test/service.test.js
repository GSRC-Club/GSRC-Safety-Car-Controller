'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ControllerService, CAUTION_FLAGS, paceCarIdxFromYaml, currentSessionFromTelemetry, sessionIdentity, replayFrameGap, replayIsLive } = require('../src/service');

test('native caution telemetry is edge-triggered and uses official SDK bits', () => {
    const service = new ControllerService();
    let calls = 0;
    service.controller.noteNativeYellow = () => { calls += 1; };
    assert.equal(CAUTION_FLAGS, 0x0000c000);
    service._observeSessionFlags(0x00004000);
    service._observeSessionFlags(0x00008000);
    assert.equal(calls, 0);
    service._observeSessionFlags(0);
    service._observeSessionFlags(0x00004000);
    service._observeSessionFlags(0x0000c000);
    assert.equal(calls, 1);
    service.stop();
});

test('pace-car array index resolves to its telemetry CarIdx', () => {
    const yaml = `DriverInfo:\n  PaceCarIdx: 1\n  Drivers:\n    - CarIdx: 0\n      CarIsPaceCar: 0\n    - CarIdx: 27\n      CarIsPaceCar: 1\n`;
    assert.equal(paceCarIdxFromYaml(yaml), 27);
    assert.equal(paceCarIdxFromYaml('not: [valid'), null);
});

test('current session identity follows telemetry SessionNum rather than a future Race entry', () => {
    const session = { sessionInfo: { sessions: [
        { num: 0, type: 'Practice', name: 'Open Practice' },
        { num: 1, type: 'Race', name: 'Race' },
    ] } };
    assert.equal(currentSessionFromTelemetry(session, 0).type, 'Practice');
    assert.equal(currentSessionFromTelemetry(session, 1).type, 'Race');
    assert.equal(currentSessionFromTelemetry(session, 9), null);
});

test('live authority session identity binds SubSessionID and telemetry SessionNum', () => {
    const session = { weekendInfo: { subSessionId: 55123 } };
    assert.equal(sessionIdentity(session, 0), '55123:0');
    assert.equal(sessionIdentity(session, 2), '55123:2');
    assert.equal(sessionIdentity({ weekendInfo: {} }, 1), null);
});

test('replay authority accepts only a bounded distance from the live frame', () => {
    assert.equal(replayFrameGap(1000, 120), 120);
    assert.equal(replayIsLive(1000, 180), true);
    assert.equal(replayIsLive(1000, 181), false);
    assert.equal(replayIsLive(undefined, 1180), false);
});
