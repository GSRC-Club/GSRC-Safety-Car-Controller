'use strict';

class RaceSimulator {
    constructor({ cars = 18, trackLengthM = 5200 } = {}) {
        this.trackLengthM = trackLengthM;
        this.sessionTime = 0;
        this.running = false;
        this.code80 = false;
        this.drivers = Array.from({ length: cars }, (_, i) => ({
            carIdx: i + 1,
            carNumber: String(i + 1),
            name: ['Alex Morgan', 'Sam Rivera', 'Jordan Lee', 'Casey Smith', 'Riley Jones', 'Taylor Brown'][i % 6] + (i >= 6 ? ` ${Math.floor(i / 6) + 1}` : ''),
            lapCompleted: Math.max(7, 12 - Math.floor(i / 8)),
            lapDistPct: (0.78 - i * 0.032 + 1) % 1,
            speedKph: 145 - (i % 4) * 3,
            onPitRoad: false,
            inWorld: true,
            position: i + 1,
            incidentCount: 0,
        }));
    }
    start() { this.running = true; }
    stop() { this.running = false; }
    setCode80(active) { this.code80 = !!active; }
    createIllegalPass(carIdx) {
        const car = this.drivers.find(d => d.carIdx === Number(carIdx));
        const ahead = this.drivers.find(d => d.position === car?.position - 1);
        if (!car || !ahead) return;
        const tmp = car.lapDistPct; car.lapDistPct = (ahead.lapDistPct + 0.002) % 1; ahead.lapDistPct = tmp;
    }
    createSpeeding(carIdx, speed = 103) { const car = this.drivers.find(d => d.carIdx === Number(carIdx)); if (car) car.speedKph = speed; }
    addLapDown(carIdx) { const car = this.drivers.find(d => d.carIdx === Number(carIdx)); if (car) car.lapCompleted -= 1; }
    incident(carIdx) { const car = this.drivers.find(d => d.carIdx === Number(carIdx)); if (!car) return null; car.incidentCount += 4; return { carIdx: car.carIdx, points: 4, lapDistPct: car.lapDistPct, at: Date.now() }; }
    tick(dt = 0.2) {
        if (!this.running) return this.context();
        this.sessionTime += dt;
        for (const car of this.drivers) {
            const target = this.code80 ? (car.position === 1 ? 72 : 78) : 145 - (car.carIdx % 4) * 3;
            car.speedKph += (target - car.speedKph) * Math.min(1, dt * 1.8);
            const delta = (car.speedKph / 3.6 * dt) / this.trackLengthM;
            const next = car.lapDistPct + delta;
            if (next >= 1) car.lapCompleted += 1;
            car.lapDistPct = next % 1;
        }
        const order = [...this.drivers].sort((a, b) => (b.lapCompleted + b.lapDistPct) - (a.lapCompleted + a.lapDistPct));
        order.forEach((car, index) => { car.position = index + 1; });
        return this.context();
    }
    context() {
        const leader = [...this.drivers].sort((a, b) => b.lapCompleted + b.lapDistPct - (a.lapCompleted + a.lapDistPct))[0];
        return { connected: true, simulated: true, stale: false, isRace: true, sessionState: 4, replayLive: true, sessionIdentity: 'rehearsal:0', sessionName: 'Simulator — GSRC Test Race', trackName: 'Mount Panorama (simulated)', trackLengthM: this.trackLengthM, sessionTime: this.sessionTime, leaderLap: leader?.lapCompleted || 0, paceCarLapDistPct: leader ? (leader.lapDistPct + 0.025) % 1 : null, drivers: this.drivers.map(d => ({ ...d })) };
    }
}

module.exports = { RaceSimulator };
