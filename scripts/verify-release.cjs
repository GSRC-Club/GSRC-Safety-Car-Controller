'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { policy } = require('./signing-preflight.cjs');

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function signature(file) {
    const escaped = file.replaceAll("'", "''");
    const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Message=$s.StatusMessage;Subject=$s.SignerCertificate.Subject;Thumbprint=$s.SignerCertificate.Thumbprint;TimestampSubject=$s.TimeStamperCertificate.Subject} | ConvertTo-Json -Compress`;
    return JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim());
}

function assertPinnedSignature(file, { trustedRequired = process.env.GSRC_REQUIRE_TRUSTED_SIGNATURE === '1' } = {}) {
    if (!fs.existsSync(file)) throw new Error(`Missing release executable: ${file}`);
    const result = signature(file);
    if (result.Thumbprint !== policy.THUMBPRINT || result.Subject !== policy.SUBJECT) {
        throw new Error(`Wrong or missing signer on ${path.basename(file)}: ${result.Subject || 'none'} / ${result.Thumbprint || 'none'}`);
    }
    if (!result.TimestampSubject) throw new Error(`Missing RFC3161 timestamp on ${path.basename(file)}.`);
    const locallyTrusted = result.Status === 'Valid';
    const pinnedButUntrusted = result.Status === 'UnknownError' && /root certificate which is not trusted/i.test(result.Message || '');
    if (!locallyTrusted && !(pinnedButUntrusted && !trustedRequired)) {
        throw new Error(`Invalid Authenticode status on ${path.basename(file)}: ${result.Status} — ${result.Message}`);
    }
    return { ...result, locallyTrusted };
}

async function verifyRelease(context = {}) {
    const version = require(path.join(root, 'package.json')).version;
    const installer = path.join(release, `GSRC-Safety-Car-Controller-Setup-${version}.exe`);
    const application = path.join(release, 'win-unpacked', 'GSRC Safety Car Controller.exe');
    const artifacts = context.artifactPaths?.length ? context.artifactPaths.filter(file => file.endsWith('.exe')) : [installer];
    const required = [...new Set([application, installer, ...artifacts])];
    const verified = required.map(file => ({
        file: path.relative(release, file).replaceAll('\\', '/'),
        bytes: fs.statSync(file).size,
        sha256: sha256(file),
        signature: assertPinnedSignature(file),
    }));
    const manifest = {
        schemaVersion: 1,
        product: 'GSRC Safety Car Controller',
        version,
        createdAt: new Date().toISOString(),
        signer: { subject: policy.SUBJECT, thumbprint: policy.THUMBPRINT, publicCertificateSha256: policy.FINGERPRINT256 },
        artifacts: verified,
    };
    fs.copyFileSync(path.join(root, 'certs', 'GSRC-Safety-Car-Controller-Trust.cer'), path.join(release, 'GSRC-Safety-Car-Controller-Trust.cer'));
    fs.writeFileSync(path.join(release, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[signing] verified ${verified.length} pinned, timestamped executable(s); release manifest written.`);
    return context.artifactPaths ? [] : required;
}

module.exports = verifyRelease;
module.exports.assertPinnedSignature = assertPinnedSignature;

if (require.main === module) {
    verifyRelease().catch(error => { console.error(`[signing] VERIFICATION FAILED: ${error.message}`); process.exitCode = 1; });
}
