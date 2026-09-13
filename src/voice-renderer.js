'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

class VoiceRenderer {
    constructor({ cacheDir, scriptPath, log = console } = {}) {
        this.cacheDir = cacheDir;
        this.scriptPath = scriptPath;
        this.log = log;
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    render(text) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 450);
        if (!clean) return Promise.reject(new Error('Speech text is empty.'));
        const name = crypto.createHash('sha256').update(`v1|rate=1|${clean}`).digest('hex').slice(0, 20) + '.wav';
        const output = path.join(this.cacheDir, name);
        if (fs.existsSync(output) && fs.statSync(output).size > 44) return Promise.resolve(output);
        return new Promise((resolve, reject) => {
            execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Text', clean, '-OutputPath', output, '-Rate', '1', '-Volume', '100'], { windowsHide: true, timeout: 30000 }, error => {
                if (error) { try { fs.rmSync(output, { force: true }); } catch (_) {} reject(error); }
                else resolve(output);
            });
        });
    }
}

module.exports = { VoiceRenderer };
