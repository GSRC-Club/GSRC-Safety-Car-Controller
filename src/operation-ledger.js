'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class OperationLedger {
    constructor({ directory, now = () => Date.now() } = {}) {
        if (!directory) throw new Error('OperationLedger requires a storage directory.');
        this.directory = directory;
        this.now = now;
        this.eventsPath = path.join(directory, 'events.jsonl');
        this.statePath = path.join(directory, 'active-procedure.json');
        this.sequence = 0;
        this.previousHash = '0'.repeat(64);
        this.commandResults = new Map();
        fs.mkdirSync(directory, { recursive: true });
        this._index();
        const integrity = this.verify();
        if (!integrity.ok) throw new Error('The local operation ledger failed its integrity check.');
    }

    append(type, data = {}) {
        const payload = { schemaVersion: 1, sequence: ++this.sequence, at: this.now(), type, data, previousHash: this.previousHash };
        const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const entry = { ...payload, hash };
        fs.appendFileSync(this.eventsPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flush: true });
        this.previousHash = hash;
        if (type === 'command-result' && data.commandId) this._rememberCommandResult(data.commandId, data.result);
        return entry;
    }

    saveActiveState(value) {
        const payload = JSON.stringify(value);
        atomicJson(this.statePath, { schemaVersion: 1, payload: value, sha256: crypto.createHash('sha256').update(payload).digest('hex') });
    }
    loadActiveState() {
        try {
            const envelope = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            const actual = crypto.createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex');
            if (!envelope.payload || envelope.sha256 !== actual) throw new Error('The active procedure recovery state failed its integrity check.');
            return envelope.payload;
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }
    clearActiveState() { try { fs.rmSync(this.statePath, { force: true }); } catch (_) {} }
    commandResult(commandId) { return this.commandResults.get(commandId) || null; }

    verify() {
        let previousHash = '0'.repeat(64); let expectedSequence = 1; let count = 0;
        for (const entry of readEntries(this.eventsPath)) {
            const { hash, ...payload } = entry;
            const expectedHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            if (entry.sequence !== expectedSequence || entry.previousHash !== previousHash || hash !== expectedHash) {
                return { ok: false, count, expectedSequence, actualSequence: entry.sequence };
            }
            previousHash = hash; expectedSequence += 1; count += 1;
        }
        return { ok: true, count, finalHash: previousHash };
    }

    exportBundle(file, snapshot) {
        const integrity = this.verify();
        if (!integrity.ok) throw new Error('The local operation ledger failed its integrity check.');
        atomicJson(file, {
            schemaVersion: 1,
            exportedAt: new Date(this.now()).toISOString(),
            integrity,
            snapshot,
            events: readEntries(this.eventsPath),
        });
        return integrity;
    }

    _index() {
        for (const entry of readEntries(this.eventsPath)) {
            this.sequence = Math.max(this.sequence, Number(entry.sequence) || 0);
            this.previousHash = entry.hash || this.previousHash;
            if (entry.type === 'command-result' && entry.data?.commandId) this._rememberCommandResult(entry.data.commandId, entry.data.result);
        }
    }
    _rememberCommandResult(commandId, result) {
        const previous = this.commandResults.get(commandId);
        if (previous?.sent === true) return;
        this.commandResults.set(commandId, result);
    }
}

function readEntries(file) {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flush: true });
    fs.renameSync(temp, file);
}

module.exports = { OperationLedger, readEntries };
