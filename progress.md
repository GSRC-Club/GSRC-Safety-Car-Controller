# GSRC Safety Car Controller progress

## 2026-09-25 — AI race readiness and Code 80 corrections (0.2.2)

- [x] Reproduce and fix live-replay authority, local AI identity, private chat routing and false local-send success. Detect AI rosters and explain the required native-yellow procedure.
- [x] Follow native caution/green telemetry with a missing-yellow timeout; preserve session interlocks, serialized output, replay blocking, recovery and disarmed defaults.
- [x] Correct virtual/native wave separation, spacing, rejoin confirmation, physical order across lap classes, and waved-car speed/restart exemptions. Add Code 80 duration and +/- lap controls, private leader/restart/correction instructions, and current-text audio with authority checks.
- [x] Compare public projects with verified July 25–September 25 activity; document recent Better Caution Bot and iCASControl evidence and licence boundaries in the [review](research/2026-09-25-READINESS-REVIEW.md).
- [x] Build the signed 0.2.2 Windows installer and write the [test-session checklist](docs/TEST-SESSION-0.2.2.md).
- Verification: clean `npm ci` (zero audit vulnerabilities), 69/69 tests (18 new cases), syntax checks on 30 JavaScript files, `git diff --check`, pinned/timestamped NSIS build. Electron source rehearsal at 1720×980 and source/packaged-ASAR workflow at 1440×900 verified countdown, leader DM, virtual wave DM, blocked premature restart, confirmed rejoin, +/- laps and restart with output disarmed. Screenshots reviewed.
- Build/evidence: `Y:\GSRC-Safety-Car-Controller-builds\0.2.2`. Installer SHA-256 `AA4F9D4099DA20A17A461A65C502417E22574D0FCF308C3EA212A5A67C7D0B7A`.
- Environment: Windows development, synthetic SDK frames and isolated Electron rehearsal profiles. No running iRacing simulator was available; real AI response, admin acceptance, full-field speed calibration, voice routing and driver receipt remain acceptance gates. No NUC/NAS application or production deployment; installer prepared locally for the requested test.

## 2026-09-13 — Independent repository and Bathurst default (0.2.1)

- [x] Locate the existing 0.2.0 controller, original handoffs and preserved signed installer.
- [x] Extract tracked source, voice pack, public certificate, private licence and branding into a self-contained package. Own the five local iRacing adapters independently of both relays.
- [x] Replace the placeholder circuit with an attributed Bathurst / Mount Panorama SVG. Preserve lap-progress car markers and identify the outline as a default schematic.
- [x] Add Windows CI tests, standalone packaging checks, repository instructions and source provenance.
- Verification: clean `npm ci`; 51/51 tests; syntax checks on 29 JavaScript files; pinned and timestamped Windows NSIS build; source and packaged-ASAR Electron rehearsal checks at 1720×980 and packaged 1440×900, with 18 finite car markers, local logo and live output disarmed. Screenshots reviewed.
- Build/evidence location: `Y:\GSRC-Safety-Car-Controller-builds\0.2.1`. Installer SHA-256: `CE2AB334CF429EBBED6F4576729C096DDF2FD784EAAF8DFDB58CF90A64B2B61D`.
- Published as the public GitHub pre-release [v0.2.1](https://github.com/GSRC-Club/GSRC-Safety-Car-Controller/releases/tag/v0.2.1) with the signed installer, updater blockmap, public trust certificate and release manifest. A download-back check matched the local installer byte size and SHA-256.
- Repository-publication audit: no committed credentials, private signing keys, databases or runtime driver data; public visibility does not change the private software licence.
- Environment: local Windows development and isolated rehearsal profiles, followed by public GitHub repository and release publication. No NUC/NAS application or production deployment.

## Remaining acceptance and development

- [ ] Private hosted iRacing session: calibrate derived all-car speed, administrator-command behavior, restart enforcement and deferred penalties before unattended official-race use.
- [ ] Validate public-trust signing on a fresh unmanaged Windows PC. Existing signing remains GSRC internal trust.
- [ ] Add per-session track geometry loading and calibrated map positioning. Current UI uses the Bathurst default; it has no automatic track-layout loader.

See [README](README.md), [provenance](docs/PROVENANCE.md), [signing policy](docs/SIGNING.md) and [original handoffs](docs/history/).
