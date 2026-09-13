'use strict';

const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('release build is pinned to the dedicated GSRC Safety Car signing identity', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.dist, /signing-preflight/);
    assert.match(pkg.scripts.dist, /verify-release/);
    assert.equal(pkg.build.beforePack, 'scripts/signing-preflight.cjs');
    assert.equal(pkg.build.afterAllArtifactBuild, 'scripts/verify-release.cjs');
    assert.equal(pkg.build.win.verifyUpdateCodeSignature, true);
    assert.equal(pkg.build.win.signtoolOptions.certificateSubjectName, 'GSRC Safety Car Controller');
    assert.equal(pkg.build.win.signtoolOptions.certificateSha1, 'CC29EA571212019725076F18358828C817C0254F');
    assert.equal(pkg.build.win.signtoolOptions.publisherName, 'GSRC Safety Car Controller');
    assert.deepEqual(pkg.build.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
});

test('installer embeds and fail-closed installs the pinned public trust certificate', () => {
    const certificate = new X509Certificate(fs.readFileSync(path.join(root, 'certs', 'GSRC-Safety-Car-Controller-Trust.cer')));
    assert.equal(certificate.subject, 'CN=GSRC Safety Car Controller');
    assert.equal(certificate.fingerprint256.replaceAll(':', ''), 'AC7FAF430D0361B1AE4F2F137E12846AA9BBED04C6397909632DA05D663EE055');
    const installer = fs.readFileSync(path.join(root, 'installer.nsh'), 'utf8');
    assert.match(installer, /GSRC-Safety-Car-Controller-Trust\.cer/);
    assert.match(installer, /CC29EA571212019725076F18358828C817C0254F/);
    assert.match(installer, /-user -f -addstore Root/);
    assert.match(installer, /Abort/);
});
