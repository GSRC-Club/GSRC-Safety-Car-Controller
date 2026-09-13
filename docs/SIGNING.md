# GSRC Safety Car Controller signing

## Current release identity

- Subject: `CN=GSRC Safety Car Controller`
- SHA-1 thumbprint: `CC29EA571212019725076F18358828C817C0254F`
- Public certificate SHA-256: `AC7FAF430D0361B1AE4F2F137E12846AA9BBED04C6397909632DA05D663EE055`
- Expiry: 30 August 2031

Only the public `.cer` is committed. The exportable PFX and its DPAPI-protected random password are stored outside Git under `C:\Users\gibil\.gsrc-secrets\safety-car-signing`. Do not upload, copy into a worktree, print or commit either private file.

## Every release

Run:

```powershell
npm run release
```

The release interface is intentionally fail-closed:

1. `signing-preflight.cjs` requires the exact private certificate, code-signing EKU and at least 30 days remaining validity.
2. Electron Builder signs the application executable, installer helpers and NSIS installer with SHA-256 and an external timestamp.
3. `verify-release.cjs` requires the exact signer and timestamp. An altered, unsigned, expired or differently signed executable stops the build.
4. `release-manifest.json` records byte sizes, SHA-256 hashes, signer identity and local trust status.
5. The public trust certificate is copied beside the installer and embedded into the installer. Certificate installation failure aborts installation.

The same preflight and verification modules are Electron Builder hooks. Running `npx electron-builder` directly does not bypass signing.

## Internal trust limitation

This is an internally issued Authenticode identity. It prevents unsigned or wrong-key GSRC releases and provides trusted status after the public certificate is installed on a GSRC-controlled PC. It is not a public certificate authority and cannot provide first-download SmartScreen reputation on an unmanaged member computer.

For a new race-control PC, distribute the `.cer` and installer together. Verify the displayed SHA-256 out of band, import the certificate into the current user's Trusted Root Certification Authorities store, then verify the installer signer before running it. The installer also performs that trust installation and aborts if it fails, but Windows evaluates the installer before its embedded certificate can be trusted.

## Public-trust migration

Microsoft recommends Azure Artifact Signing for non-Store Windows distribution. Public Trust is available to Australian organisations, including an incorporated association, but identity validation must be completed by an authorised GSRC officer in the Azure portal. Microsoft states that validation can take 1–20 business days and requires a paid Azure subscription.

After GSRC approval and validation:

1. Create a Public Trust certificate profile for the verified legal entity.
2. Grant a GitHub OIDC identity the **Artifact Signing Certificate Profile Signer** role.
3. Replace the local `signtoolOptions` adapter with Electron Builder's Azure signing adapter.
4. Keep `verify-release.cjs` fail-closed, but pin the validated legal subject and trust chain instead of this internal thumbprint.
5. Run both adapters against an internal test artifact, rotate the pinned policy in one reviewed commit, and retire the internal private key only after installed and fresh-machine verification.

Official references: [Microsoft Windows code-signing options](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options), [Artifact Signing quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart), and [Azure Artifact Signing GitHub Action](https://github.com/Azure/artifact-signing-action).
