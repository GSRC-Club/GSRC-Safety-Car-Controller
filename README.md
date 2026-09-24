# GSRC Safety Car Controller

A separate Windows race-control application for GSRC iRacing hosted races. It provides four explicit procedures:

> **Licence:** This public repository makes the source and release downloads visible; it does not make the software open source. No permission to reuse, redistribute, sell or publish derivative works is granted beyond the terms in [LICENSE.md](LICENSE.md). GSRC operational use remains covered by that licence.

- **GSRC Code 80 Safety Car** — controlled bunch-up, lapped-car wave-arounds, restart control and deferred enforcement.
- **Strict Code 80** — a true gap-preserving full-course speed restriction with no field bunching.
- **iRacing Full-Course Yellow** — native `!yellow`, pit and pace-lap administration.
- **Human Safety Car** — operator instructions for a nominated safety-car driver.

The field map defaults to a bundled Bathurst / Mount Panorama SVG, including the Chase. It is labelled as a default schematic: this version does not yet load per-session circuit geometry, and car markers show relative lap progress rather than calibrated geographic positions. [Track artwork credit](docs/THIRD-PARTY-NOTICES.md).

The application is a clean-room GSRC implementation. It does not copy iCASControl source code.

## 0.2.2 test build

For an **AI race with bots, choose iRacing Yellow**. Bots do not follow Code 80 chat instructions or private messages. Native deployment waits for caution telemetry; native restart requests `!pacelaps 1` and waits for iRacing's green. Local AI sessions without online session IDs are supported while the same connection remains active.

Human Code 80 now sends private leader, correction and wave instructions. Set **Code 80 laps**, use **PACE LAP −1 / +1** to adjust the planned duration, and confirm **WAVES REJOINED** before restarting. These lap controls never automatically force green. Full procedure details and remaining real-session checks are in the [0.2.2 test checklist](docs/TEST-SESSION-0.2.2.md); the [readiness review](research/2026-09-25-READINESS-REVIEW.md) records reproduced defects and recent GitHub comparisons.

## Independent development

This is the canonical standalone repository, extracted from the GSRC monorepo on 13 September 2026. Node.js 22.12 or newer is required. The iRacing adapters, branding and licence are included locally; neither relay nor the central server is required to install, test or package it. See [source provenance](docs/PROVENANCE.md) and [current work](progress.md).

## Run

```powershell
git clone https://github.com/GSRC-Club/GSRC-Safety-Car-Controller.git
cd GSRC-Safety-Car-Controller
npm ci
npm start
```

Use **Rehearsal** first. The built-in field simulator can inject illegal passes, speeding, lapped cars and confirmed 4x incidents without an iRacing session.

Scheduled calls can use randomized points inside an earliest/latest window or an exact comma-separated lap/minute plan. A telemetry-observed native iRacing caution can count against the remaining schedule without double-counting a native yellow the controller just called itself.

## Live safety model

Live output starts disarmed. When disarmed, every command and announcement is previewed and audited but not sent to iRacing. An operator must explicitly arm output. Deployment is also confirmed in a modal.

Live authority is checked continuously, not only at deployment. Telemetry staleness, a changed SubSession/session, leaving the Racing state, moving away from the live replay frame, or losing the live roster immediately disarms output and freezes autonomous actions. Restoring telemetry does not silently resume control: the operator must acknowledge the interlock and arm output again.

Every active procedure is persisted to a local recovery record. If the app or PC stops during a caution, the next launch opens **Recovery required** and restores nothing automatically. The exact saved session can be resumed disarmed, or the record can be closed without transmitting a cancellation, green flag or penalty. Outbound commands are serialized and deduplicated by deterministic procedure IDs; emergency disarm cancels commands that have not reached the adapter.

The app reads iRacing's local shared-memory SDK and writes administrator commands through iRacing text chat. iRacing must be running on the same Windows PC and the logged-in user must be the host or a promoted administrator.

Automatic penalties are deliberately fail-closed:

- physical road order is locked relative to the leader, including lapped cars;
- speed uses consecutive lap-distance samples and the reported track length;
- the leader's lower bunch-up target is enforced separately from the field's 80 km/h maximum;
- a driver gets a warning and correction window first;
- penalties are queued during the neutralised period and issued after green;
- telemetry disconnects or stale frames block a new deployment;
- disconnect/rejoin and pit-exit grace suppress transient order changes;
- native waves use `!waveby`; virtual Code 80 waves privately instruct physical circulation and require rejoin confirmation;
- a failed local send disarms and freezes every later queued command;
- automatic incident triggers require available per-car incident totals; missing bot totals cannot trigger a reliable automatic call.

The local operation ledger is append-only and hash-chained. It records decisions, commands and local send results before export, and its recovery snapshot is separately checksummed before use. A name-redacted telemetry trace is captured at 2 Hz for deterministic regression replay; it never records chat text, credentials or driver names, stops at 50 MB per session and stops globally at 250 MB rather than silently consuming the disk.

## Audio

Public announcements are rendered from their current text with Windows speech synthesis and cached. Private driver instructions stay in text chat so radio output does not broadcast a private warning to the whole field. The historical pre-rendered voice pack remains bundled but is not used for configurable instructions.

To broadcast audio through iRacing:

1. Install VB-CABLE directly from [VB-Audio](https://vb-audio.com/Cable/index.htm).
2. Select **CABLE Input** as the controller's output.
3. Select **CABLE Output** as iRacing's Voice Chat Mic Device.
4. Assign the controller's configured F-key as iRacing Voice Push-to-Talk.
5. Test in a private rehearsal session before arming live output.

VB-CABLE is not bundled. Text chat is always the authoritative fallback.

## Signed verification and packaging

```powershell
npm test
npm run dist
```

`npm run dist` is fail-closed. The builder checks for the pinned `CN=GSRC Safety Car Controller` private key before packaging, signs the application and installer, requires a timestamped matching Authenticode signature, and writes `release/release-manifest.json`. Direct `electron-builder` invocation runs the same pre/post hooks, so it cannot silently create an unsigned release. The public trust certificate is staged beside the installer and embedded into the one-click installer.

The current certificate is GSRC internal trust, appropriate for GSRC-controlled race-control computers. It proves the artifact was signed by the pinned GSRC key, but the first machine must trust the public certificate before Windows can report a complete trusted chain. See [docs/SIGNING.md](docs/SIGNING.md) for rotation, build-host recovery and the planned Microsoft public-trust migration.

The installer is written to `release/`. Installer binaries and generated release output are intentionally not committed.

See [research/DESIGN-AND-EVIDENCE.md](research/DESIGN-AND-EVIDENCE.md) for the procedure, legal and technical research behind the implementation.
