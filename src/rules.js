'use strict';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const wrappedForward = (from, to) => ((Number(to) - Number(from)) + 1) % 1;
const wrappedBackward = (from, to) => ((Number(from) - Number(to)) + 1) % 1;

function raceDistance(driver) {
    const lap = Number(driver.lapCompleted ?? driver.lap ?? 0);
    const pct = clamp(driver.lapDistPct, 0, 0.999999);
    return lap + pct;
}

function physicalOrder(drivers) {
    return [...(drivers || [])]
        .filter(d => d && Number.isInteger(Number(d.carIdx)) && Number(d.carIdx) >= 0 && d.inWorld !== false)
        .sort((a, b) => raceDistance(b) - raceDistance(a) || a.carIdx - b.carIdx);
}

function lockOrder(drivers, now = Date.now()) {
    const order = physicalOrder(drivers).filter(d => !d.onPitRoad && Number.isFinite(d.lapDistPct) && d.lapDistPct >= 0);
    const leader = order[0];
    if (leader) order.sort((a, b) => wrappedBackward(leader.lapDistPct, a.lapDistPct) - wrappedBackward(leader.lapDistPct, b.lapDistPct));
    return {
        capturedAt: now,
        entries: order.map((d, index) => ({
            carIdx: d.carIdx,
            carNumber: String(d.carNumber || ''),
            name: d.name || d.userName || `Car ${d.carIdx}`,
            position: index,
            distance: raceDistance(d),
            orderDistance: raceDistance(leader) - wrappedBackward(leader.lapDistPct, d.lapDistPct),
            lapCompleted: Number(d.lapCompleted || 0),
        })),
    };
}

function detectIllegalPasses(lock, drivers, exemptions = new Set()) {
    if (!lock?.entries?.length) return [];
    const captured = new Map(lock.entries.map(entry => [entry.carIdx, entry]));
    const active = physicalOrder(drivers).filter(d => captured.has(d.carIdx) && !exemptions.has(d.carIdx));
    const activeIds = new Set(active.map(d => d.carIdx));
    const original = new Map(lock.entries.filter(e => activeIds.has(e.carIdx)).map((e, index) => [e.carIdx, index]));
    const distance = d => { const entry = captured.get(d.carIdx); return raceDistance(d) - entry.distance + (entry.orderDistance ?? entry.distance); };
    const current = active.sort((a, b) => distance(b) - distance(a) || original.get(a.carIdx) - original.get(b.carIdx));
    const currentIndex = new Map(current.map((d, index) => [d.carIdx, index]));
    const violations = [];
    for (const car of current) {
        if (exemptions.has(car.carIdx)) continue;
        const before = original.get(car.carIdx);
        const now = currentIndex.get(car.carIdx);
        if (now >= before) continue;
        const displaced = current.slice(now + 1, before + 1)
            .filter(other => original.get(other.carIdx) < before && !exemptions.has(other.carIdx));
        if (displaced.length) violations.push({
            type: 'illegal-pass',
            carIdx: car.carIdx,
            carNumber: car.carNumber,
            name: car.name,
            gained: before - now,
            passedCarIdxs: displaced.map(d => d.carIdx),
        });
    }
    return violations;
}

function deriveSpeeds(previous, drivers, trackLengthM, dtSeconds) {
    const out = new Map();
    if (!(trackLengthM > 0) || !(dtSeconds > 0) || dtSeconds > 2) return out;
    for (const driver of drivers || []) {
        const was = previous.get(driver.carIdx);
        if (!was || !Number.isFinite(was.lapDistPct) || !Number.isFinite(driver.lapDistPct)) continue;
        if (was.inWorld === false || driver.inWorld === false || was.lapDistPct < 0 || was.lapDistPct >= 1 || driver.lapDistPct < 0 || driver.lapDistPct >= 1) continue;
        let delta = wrappedForward(was.lapDistPct, driver.lapDistPct);
        if (delta > 0.15) continue;
        const speed = (delta * trackLengthM / dtSeconds) * 3.6;
        if (speed <= 450) out.set(driver.carIdx, speed);
    }
    return out;
}

function waveCandidates(drivers, leaderCarIdx, options = {}) {
    const order = physicalOrder(drivers);
    const leader = order.find(d => d.carIdx === leaderCarIdx) || order[0];
    if (!leader) return [];
    const referencePct = Number.isFinite(options.referencePct) ? options.referencePct : leader.lapDistPct;
    return order
        .filter(d => !d.onPitRoad && Number.isFinite(d.lapDistPct) && d.lapDistPct >= 0 && d.carIdx !== leader.carIdx && raceDistance(leader) - raceDistance(d) >= 1)
        .map(d => ({ ...d, distanceFromReference: wrappedBackward(referencePct, d.lapDistPct) }))
        .sort((a, b) => a.distanceFromReference - b.distanceFromReference || a.carIdx - b.carIdx);
}

function generateSchedule(input, random = Math.random) {
    const count = clamp(Math.round(input.count), 0, 20);
    const first = Number(input.first);
    const last = Number(input.last);
    const spacing = Math.max(0, Number(input.minimumSpacing) || 0);
    if (!count || !Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
    if (!input.randomized) {
        return (input.manualPoints || []).map(Number).filter(Number.isFinite).filter(n => n >= first && n <= last).slice(0, count).sort((a, b) => a - b);
    }
    const available = last - first;
    if (count > 1 && spacing * (count - 1) > available) return [];
    const slack = available - spacing * Math.max(0, count - 1);
    const cuts = Array.from({ length: count }, () => random()).sort((a, b) => a - b);
    return cuts.map((cut, index) => Math.round(first + cut * slack + index * spacing));
}

class IncidentCluster {
    constructor(config = {}) { this.config = config; this.events = []; }
    add(event) {
        const now = Number(event.at) || Date.now();
        const windowMs = (Number(this.config.timeWindowSeconds) || 3) * 1000;
        this.events.push({ ...event, at: now });
        this.events = this.events.filter(item => now - item.at <= windowMs);
        const pctWindow = (Number(this.config.trackWindowPct) || 10) / 100;
        const nearby = this.events.filter(item => {
            const a = Number(item.lapDistPct); const b = Number(event.lapDistPct);
            if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
            const gap = Math.abs(a - b); return Math.min(gap, 1 - gap) <= pctWindow;
        });
        const unique = new Set(nearby.map(item => item.carIdx));
        return {
            count: nearby.length,
            uniqueCars: unique.size,
            action: unique.size >= Number(this.config.autoAt || 5) ? 'deploy'
                : unique.size >= Number(this.config.reviewAt || 3) ? 'review' : 'none',
            events: nearby,
        };
    }
    reset() { this.events = []; }
}

module.exports = {
    raceDistance, physicalOrder, lockOrder, detectIllegalPasses, deriveSpeeds,
    waveCandidates, generateSchedule, IncidentCluster, wrappedForward, wrappedBackward,
};
