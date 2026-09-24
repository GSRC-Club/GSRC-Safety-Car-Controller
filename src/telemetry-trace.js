'use strict';

const fs = require('node:fs');
const path = require('node:path');

class TelemetryTraceRecorder {
    constructor({ directory, now = () => Date.now(), intervalMs = 500, maxBytes = 50 * 1024 * 1024, maxTotalBytes = 250 * 1024 * 1024 } = {}) {
        if (!directory) throw new Error('TelemetryTraceRecorder requires a storage directory.');
        this.directory = directory; this.now = now; this.intervalMs = intervalMs; this.maxBytes = maxBytes; this.maxTotalBytes = maxTotalBytes;
        this.lastAt = 0; this.file = null; this.identity = null; this.bytes = 0; this.full = false;
        fs.mkdirSync(directory, { recursive: true });
        this.totalBytes = directoryBytes(directory);
    }

    record(context) {
        const now = this.now();
        if (!context?.connected || context.simulated || now - this.lastAt < this.intervalMs) return false;
        const identity = context.sessionIdentity || 'unverified';
        if (identity !== this.identity) this._open(identity, now);
        if (this.full || !this.file) return false;
        const frame = redactFrame(context, now);
        const line = `${JSON.stringify(frame)}\n`; const bytes = Buffer.byteLength(line);
        if (this.bytes + bytes > this.maxBytes || this.totalBytes + bytes > this.maxTotalBytes) { this.full = true; return false; }
        fs.appendFileSync(this.file, line, { encoding: 'utf8', flush: true });
        this.bytes += bytes; this.totalBytes += bytes; this.lastAt = now; return true;
    }

    status() { return { file: this.file, identity: this.identity, bytes: this.bytes, totalBytes: this.totalBytes, full: this.full, intervalMs: this.intervalMs, maxBytes: this.maxBytes, maxTotalBytes: this.maxTotalBytes }; }

    _open(identity, now) {
        const safe = String(identity).replace(/[^a-z0-9_.-]+/gi, '-');
        this.identity = identity; this.lastAt = 0; this.full = this.totalBytes >= this.maxTotalBytes;
        this.file = path.join(this.directory, `trace-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${safe}.jsonl`);
        this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    }
}

class RecordedTraceRunner {
    constructor({ controller, setNow = () => {} } = {}) { this.controller = controller; this.setNow = setNow; }
    run(file) {
        const frames = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        for (const frame of frames) { this.setNow(frame.at); this.controller.updateContext(frame.context); }
        return { frames: frames.length, snapshot: this.controller.snapshot() };
    }
}

function redactFrame(context, at) {
    return { schemaVersion: 1, at, context: {
        connected: !!context.connected, simulated: false, stale: !!context.stale, isRace: !!context.isRace,
        sessionState: context.sessionState, sessionFlags: context.sessionFlags, hasAI: !!context.hasAI, replayLive: context.replayLive, replayFrameGap: context.replayFrameGap,
        sessionIdentity: context.sessionIdentity || null, trackLengthM: context.trackLengthM,
        sessionTime: context.sessionTime, leaderLap: context.leaderLap, paceCarLapDistPct: context.paceCarLapDistPct,
        drivers: (context.drivers || []).map(driver => ({
            carIdx: driver.carIdx, carNumber: driver.carNumber, isAI: !!driver.isAI, lap: driver.lap, lapCompleted: driver.lapCompleted,
            lapDistPct: driver.lapDistPct, speedKph: driver.speedKph, onPitRoad: !!driver.onPitRoad,
            surface: driver.surface, inWorld: driver.inWorld !== false,
        })),
    } };
}

function directoryBytes(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .reduce((total, entry) => total + fs.statSync(path.join(directory, entry.name)).size, 0);
}

module.exports = { TelemetryTraceRecorder, RecordedTraceRunner, redactFrame, directoryBytes };
