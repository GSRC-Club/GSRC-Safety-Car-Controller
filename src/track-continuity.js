'use strict';

class TrackContinuity {
    constructor({ rejoinGraceSeconds = 10, pitExitGraceSeconds = 5 } = {}) {
        this.rejoinGraceMs = Math.max(0, Number(rejoinGraceSeconds) || 0) * 1000;
        this.pitExitGraceMs = Math.max(0, Number(pitExitGraceSeconds) || 0) * 1000;
        this.cars = new Map();
    }

    update(drivers, now) {
        const seen = new Set();
        for (const driver of drivers || []) {
            const carIdx = Number(driver?.carIdx);
            if (!Number.isInteger(carIdx) || carIdx < 0) continue;
            seen.add(carIdx);
            const inWorld = driver.inWorld !== false;
            const onPitRoad = !!driver.onPitRoad;
            const previous = this.cars.get(carIdx);
            let graceUntil = previous?.graceUntil || 0;
            if (previous && !previous.inWorld && inWorld) graceUntil = Math.max(graceUntil, now + this.rejoinGraceMs);
            if (previous && previous.onPitRoad && !onPitRoad && inWorld) graceUntil = Math.max(graceUntil, now + this.pitExitGraceMs);
            this.cars.set(carIdx, { inWorld, onPitRoad, graceUntil, lastSeenAt: now });
        }
        for (const [carIdx, state] of this.cars) {
            if (!seen.has(carIdx) && state.inWorld) this.cars.set(carIdx, { ...state, inWorld: false, lastSeenAt: now });
        }
    }

    exemptions(now) {
        return new Set([...this.cars].filter(([, state]) => state.graceUntil > now).map(([carIdx]) => carIdx));
    }

    serialize() { return [...this.cars.entries()]; }
    restore(entries) { this.cars = new Map(entries || []); }
    reset() { this.cars.clear(); }
}

module.exports = { TrackContinuity };
