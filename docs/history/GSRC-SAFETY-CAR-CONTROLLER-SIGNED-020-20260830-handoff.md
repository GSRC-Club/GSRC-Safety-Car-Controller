# GSRC Safety Car Controller 0.2.0 signing and operational-safety handoff

## Goal

Make every distributable controller build signed automatically and close the highest-risk gaps between a polished prototype and a dependable live race-control tool.

## Current state

Version 0.2.0 is implemented, tested, packaged and signed with the dedicated internal identity `CN=GSRC Safety Car Controller`. The release path fails before packaging when the exact private certificate is unavailable and fails after packaging when the signer, timestamp or signature integrity differs. The preserved installer is under `Y:\GSRC-Racing-System-builds\gsrc-safety-car-controller-0.2.0`; it is not production-deployed. Public-CA enrolment and a private hosted iRacing acceptance drill remain external gates.

## Decisions

- Dedicated Safety Car identity instead of reusing RC Relay's certificate — narrows key scope and makes wrong-product signing detectable.
- Pinned signer plus timestamp and artifact manifest — a successful packager process is not accepted as proof that the distributable is signed correctly.
- Internal signing now, Microsoft Artifact Signing migration later — Australia is eligible, but an authorised GSRC officer must complete paid Azure legal-entity validation; code cannot legitimately automate that identity proof.
- Continuous Live Authority — active output requires fresh Race telemetry, Racing session state, live replay position, a coherent roster and the exact bound `SubSessionID:SessionNum`.
- Durable recovery and command idempotency — a restart resumes only disarmed in the exact session, and an already successful administrator command cannot be replayed accidentally.
- Evidence without driver identity — bounded telemetry traces omit names and chat while retaining the facts needed to replay controller decisions.

## Files changed

- `gsrc-safety-car-controller/scripts/`, `installer.nsh`, `certs/`, `docs/SIGNING.md`, `package.json` — pinned signing preflight, signing hooks, post-build verification, trust bootstrap and release policy.
- `gsrc-safety-car-controller/src/live-authority.js`, `operation-ledger.js`, `telemetry-trace.js`, `track-continuity.js` — authority, crash recovery evidence, trace replay and transient-car grace.
- `gsrc-safety-car-controller/src/controller.js`, `service.js`, `simulator.js` — procedure binding, interlocks, serial command gate, deduplication and rehearsal isolation.
- `gsrc-safety-car-controller/gui/` — recovery/interlock controls, high-consequence confirmation and corrected hidden-banner presentation.
- `gsrc-safety-car-controller/test/` — live authority, recovery, ledger tamper, trace, continuity, command queue and signing policy regressions.
- `README.md`, `CONTEXT.md`, `progress.md` — durable product, terminology and release record.

## Verification

- `npm test` — 49/49 pass.
- `node --test --experimental-test-coverage test/*.test.js` — controller 99.09% line coverage; new authority/trace/continuity modules 100%; ledger 98.13%.
- `npm run dist` — dedicated GSRC signer preflight, NSIS build, exact signer and timestamp verification all pass.
- Authenticode inspection — installer, app executable and elevation helper use thumbprint `CC29EA571212019725076F18358828C817C0254F` with a DigiCert timestamp.
- One-byte installer mutation — signature changes from pinned/timestamped to rejected (`NotSigned`).
- Strict trust mode — correctly blocks on the build host because the self-signed root is not installed; the normal internal-release policy accepts only that exact untrusted-root condition.
- Packaged UI — `qa-0.2.0-main.png` visually reviewed after correcting and regression-testing the hidden interlock banner.
- `npm run check:arch` — 6/6 pass after installing its lockfile-declared browser helper; the absent local port-9000 service sent navigation through the checker’s connection-refused recovery path.
- Installer — 101,213,064 bytes; SHA-256 `865C9BC18796FDD09306F93C7DA083FEAC60D309C2314569049631670FF6797D`.

## Risks or blockers

- A private GSRC certificate makes the artifact signed and tamper-evident, but a fresh unmanaged PC can still show Unknown Publisher/SmartScreen before that certificate is trusted. Warning-free first install requires public-trust signing and reputation.
- The all-car speed derived from iRacing telemetry and every administrator-command behavior still need calibration/acceptance in a private hosted race before unattended penalties are authorised.
- Command delivery has local adapter acknowledgement, not an iRacing server-side transaction receipt; the ledger deliberately labels it as local send-path evidence.

## Next action

Have an authorised GSRC officer create and validate an Azure Artifact Signing Public Trust account, while Race Control runs the preserved 0.2.0 build through a complete private hosted-session drill and reviews the exported ledger/trace against driver dashboards.
