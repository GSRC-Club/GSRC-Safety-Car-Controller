'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { physicalOrder, lockOrder, detectIllegalPasses, waveCandidates, generateSchedule, IncidentCluster } = require('../src/rules');

const car = (carIdx, lapCompleted, lapDistPct, extra = {}) => ({ carIdx, carNumber: String(carIdx), name: `Car ${carIdx}`, lapCompleted, lapDistPct, inWorld: true, ...extra });

test('locks physical order and detects a gained place', () => {
    const before = [car(1, 10, .8), car(2, 10, .7), car(3, 10, .6)];
    const lock = lockOrder(before, 1);
    const after = [car(1, 10, .8), car(2, 10, .55), car(3, 10, .65)];
    const passes = detectIllegalPasses(lock, after);
    assert.equal(passes.length, 1);
    assert.equal(passes[0].carIdx, 3);
    assert.deepEqual(passes[0].passedCarIdxs, [2]);
});

test('physical order retains a legitimate CarIdx zero competitor', () => {
    const order = physicalOrder([
        { carIdx: 0, lapCompleted: 5, lapDistPct: .7, inWorld: true },
        { carIdx: 1, lapCompleted: 5, lapDistPct: .6, inWorld: true },
    ]);
    assert.deepEqual(order.map(car => car.carIdx), [0, 1]);
});

test('orders lapped wave candidates from the reference point', () => {
    const drivers = [car(1, 12, .5), car(2, 10, .7), car(3, 10, .55), car(4, 12, .3)];
    assert.deepEqual(waveCandidates(drivers, 1, { referencePct: .6 }).map(d => d.carIdx), [3, 2]);
});

test('random schedule honors bounds and minimum spacing', () => {
    const values = [.1, .4, .8]; let i = 0;
    const points = generateSchedule({ count: 3, first: 10, last: 50, minimumSpacing: 8, randomized: true }, () => values[i++]);
    assert.equal(points.length, 3);
    assert.ok(points[0] >= 10 && points[2] <= 50);
    assert.ok(points[1] - points[0] >= 8 && points[2] - points[1] >= 8);
});

test('incident cluster wraps around start finish and escalates', () => {
    const cluster = new IncidentCluster({ timeWindowSeconds: 5, trackWindowPct: 10, reviewAt: 3, autoAt: 4 });
    assert.equal(cluster.add({ carIdx: 1, lapDistPct: .98, at: 1000 }).action, 'none');
    assert.equal(cluster.add({ carIdx: 2, lapDistPct: .02, at: 1100 }).action, 'none');
    assert.equal(cluster.add({ carIdx: 3, lapDistPct: .01, at: 1200 }).action, 'review');
    assert.equal(cluster.add({ carIdx: 4, lapDistPct: .99, at: 1300 }).action, 'deploy');
});
