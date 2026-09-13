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
    return {
        capturedAt: now,
        entries: physicalOrder(drivers).map((d, index) => ({
            carIdx: d.carIdx,
            carNumber: String(d.carNumber || ''),
            name: d.name || d.userName || `Car ${d.carIdx}`,
            position: index,
            distance: raceDistance(d),
            lapCompleted: Number(d.lapCompleted || 0),
        })),
    };
}

function orderIndex(lock) {
    return new Map((lock?.entries || []).map((entry, index) => [entry.carIdx, index]));
}

function detectIllegalPasses(lock, drivers, exemptions = new Set()) {
    if (!lock?.entries?.length) return [];
    const original = orderIndex(lock);
    const current = physicalOrder(drivers).filter(d => original.has(d.carIdx));
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
        let delta = wrappedForward(was.lapDistPct, driver.lapDistPct);
        if (delta > 0.15) continue;
        out.set(driver.carIdx, (delta * trackLengthM / dtSeconds) * 3.6);
    }
    return out;
}

function waveCandidates(drivers, leaderCarIdx, options = {}) {
    const order = physicalOrder(drivers);
    const leader = order.find(d => d.carIdx === leaderCarIdx) || order[0];
    if (!leader) return [];
    const leaderLap = Number(leader.lapCompleted || 0);
    const referencePct = Number.isFinite(options.referencePct) ? options.referencePct : leader.lapDistPct;
    return order
        .filter(d => d.carIdx !== leader.carIdx && leaderLap - Number(d.lapCompleted || 0) >= 1)
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
