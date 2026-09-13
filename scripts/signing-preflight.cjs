'use strict';

const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SUBJECT = 'CN=GSRC Safety Car Controller';
const THUMBPRINT = 'CC29EA571212019725076F18358828C817C0254F';
const FINGERPRINT256 = 'AC7FAF430D0361B1AE4F2F137E12846AA9BBED04C6397909632DA05D663EE055';
const root = path.resolve(__dirname, '..');

function inspectPublicCertificate() {
    const file = path.join(root, 'certs', 'GSRC-Safety-Car-Controller-Trust.cer');
    if (!fs.existsSync(file)) throw new Error(`Missing pinned public certificate: ${file}`);
    const certificate = new X509Certificate(fs.readFileSync(file));
    const fingerprint = certificate.fingerprint256.replaceAll(':', '');
    if (certificate.subject !== SUBJECT || fingerprint !== FINGERPRINT256) {
        throw new Error(`Pinned public certificate mismatch: ${certificate.subject} / ${fingerprint}`);
    }
    if (Date.parse(certificate.validTo) - Date.now() < 30 * 24 * 60 * 60 * 1000) {
        throw new Error(`Signing certificate expires too soon: ${certificate.validTo}`);
    }
    return certificate;
}

function inspectPrivateCertificate() {
    if (process.platform !== 'win32') throw new Error('GSRC Windows releases must be signed on Windows.');
    const script = [
        `$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My','CurrentUser')`,
        `$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)`,
        `$certificate = @($store.Certificates | Where-Object Thumbprint -EQ '${THUMBPRINT}')[0]`,
        `$store.Close()`,
        `if (-not $certificate) { throw 'Pinned GSRC Safety Car signing certificate is not installed.' }`,
        `if (-not $certificate.HasPrivateKey) { throw 'Pinned signing certificate has no private key.' }`,
        `if ($certificate.Subject -ne '${SUBJECT}') { throw 'Signing certificate subject mismatch.' }`,
        `if ($certificate.NotAfter -lt (Get-Date).AddDays(30)) { throw 'Signing certificate expires within 30 days.' }`,
        `$ekuExtension = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })[0]`,
        `$eku = @($ekuExtension.EnhancedKeyUsages | ForEach-Object Value)`,
        `if ($eku -notcontains '1.3.6.1.5.5.7.3.3') { throw 'Certificate is not valid for code signing.' }`,
    ].join('; ');
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe', windowsHide: true });
}

async function signingPreflight() {
    inspectPublicCertificate();
    inspectPrivateCertificate();
    console.log(`[signing] ready: ${SUBJECT} / ${THUMBPRINT}`);
}

module.exports = signingPreflight;
module.exports.policy = { SUBJECT, THUMBPRINT, FINGERPRINT256 };

if (require.main === module) {
    signingPreflight().catch(error => { console.error(`[signing] BLOCKED: ${error.message}`); process.exitCode = 1; });
}
