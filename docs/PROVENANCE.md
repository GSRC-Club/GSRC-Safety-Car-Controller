# Standalone source provenance

Extracted on 13 September 2026 from the private repository `GSRC-Club/Centralised-Racing-League-System`, commit `e223b12530db399b829eb28b1c7053be117f9fff`.

This repository begins with a tracked-source snapshot, not a rewrite of the monorepo's history. Original history remains there:

- `36d2235` (30 August): initial controller 0.1.0 implementation.
- `7dcc4a5` (30 August): signed 0.2.0 and operational-safety hardening.
- Original handoffs are retained in [history/](history/); their build paths, versions and test counts describe those historical builds.

## Included materials

- `gsrc-safety-car-controller/` becomes this repository root.
- Five adapter files from `gsrc-broadcast-relay/src/` become `shared/`: `broadcast-cmd.js`, `command-dispatch.js`, `irsdk-reader.js`, `session-info-parser.js`, and `incident-synth.js`. These are exact copies from the extraction commit, including relay fixes since 30 August. Future changes are owned here and reviewed independently; there is no runtime or build dependency on either relay.
- `images/GSRCWhiteTrans.png` becomes `assets/GSRCWhiteTrans.png`.
- Root `LICENSE.md` is preserved unchanged, including authorship and private-use terms.
- Public signing certificate and voice assets are retained. No private keys, credentials, databases, dependencies or generated installers were imported.

Version 0.2.1 identifies the independent package and Bathurst default-outline change. Existing application identity and user-data location are preserved. The old monorepo application folder is retained as a historical copy with a forwarding notice; future controller development belongs here.

## Historical installer

The signed 0.2.0 installer remains at `Y:\GSRC-Racing-System-builds\gsrc-safety-car-controller-0.2.0`. Its recorded SHA-256 is `865C9BC18796FDD09306F93C7DA083FEAC60D309C2314569049631670FF6797D`.

Public-trust signing validation and private hosted-session speed/penalty calibration remain open. Local test success and a signed development build do not constitute live-race acceptance.
