'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { shared, asset } = require('../src/shared');

const root = path.resolve(__dirname, '..');

test('standalone checkout resolves its adapters and branding without a sibling relay', () => {
    for (const name of ['irsdk-reader', 'session-info-parser', 'command-dispatch', 'broadcast-cmd', 'incident-synth']) {
        assert.equal(shared(name), require(path.join(root, 'shared', name)));
    }
    assert.ok(fs.existsSync(asset('GSRCWhiteTrans.png')));
    assert.ok(fs.existsSync(asset('tracks/bathurst.svg')));
    assert.throws(() => shared('../gsrc-broadcast-relay/src/irsdk-reader'), /Invalid shared module/);
});

test('packaging inputs stay inside the standalone repository and all exist', () => {
    const pkg = require('../package.json');
    assert.ok(pkg.build.files.includes('shared/**/*'));
    assert.ok(pkg.build.files.includes('assets/voice/**/*'));
    assert.ok(pkg.build.files.includes('assets/tracks/**/*'));
    for (const value of [...pkg.build.files, ...pkg.build.extraResources.map(item => item.from), pkg.build.win.icon]) {
        assert.equal(typeof value, 'string');
        const prefix = value.split('*')[0];
        const resolved = path.resolve(root, prefix);
        const relative = path.relative(root, resolved);
        assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `External packaging input: ${value}`);
        assert.ok(fs.existsSync(resolved), `Missing packaging input: ${value}`);
    }
});
