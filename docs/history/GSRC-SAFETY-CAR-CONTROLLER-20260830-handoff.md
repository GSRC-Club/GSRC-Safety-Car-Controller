# GSRC Safety Car Controller handoff

## Goal

Deliver the strongest practical clean-room iRacing Code 80/safety-car controller, with dynamic audio, enforcement, wave-arounds, scheduling, rehearsal and a launchable Windows installer.

## Current state

Version 0.1.0 is complete, tested and packaged under `gsrc-safety-car-controller/`. The generated installer is intentionally ignored by Git and not production-deployed. Live private-session calibration remains an operational acceptance gate, not unfinished implementation.

## Decisions

- Separate **Strict Code 80** from **GSRC Code 80 Safety Car** — a true Code 80 preserves gaps, while GSRC's requested bunch-up/waves/restart is a virtual safety-car procedure.
- Clean-room implementation — iCASControl has no detected licence grant; no source, map, CSS or audio was copied. Other surveyed GPL/nonstandard projects were research only.
- Whole-sentence cached speech — dynamic number calls use one utterance (`123` → `one two three`) for natural cadence; digit WAVs remain recovery assets rather than being concatenated live.
- Fail closed — live output is disarmed by default; stale/non-race telemetry blocks deployment; only confirmed 4x deltas can auto-deploy; warnings precede penalties; penalty commands wait for green.
- No bundled virtual audio driver — operators install VB-CABLE from its vendor and route the selected controller output into iRacing's voice mic.

## Files changed

- `gsrc-safety-car-controller/src/` — state machine, telemetry service, rules, simulator, PTT and speech cache.
- `gsrc-safety-car-controller/gui/` — Electron security boundary and race-control console.
- `gsrc-safety-car-controller/assets/voice/` — 18 generated 16 kHz mono WAV assets.
- `gsrc-safety-car-controller/test/` — 28 controller/rules/service regressions.
- `gsrc-safety-car-controller/research/DESIGN-AND-EVIDENCE.md` — sourced GitHub, rules, SDK, audio and licensing research.
- `README.md`, `progress.md`, `.gitignore` — product map, completion evidence and release-output exclusion.

## Verification

- `npm test` — 28/28 pass.
- `node --check` across `src`, `gui` and `test` — pass.
- `npm install --package-lock-only --ignore-scripts` — 0 vulnerabilities.
- `npm run dist` — NSIS x64 installer built successfully with GSRC icon/resources.
- Packaged runtime — branded UI capture passed; 18 voice assets, synthesis script, GSRC logo and private licence present.
- Packaged speech probe — exact no-gap dynamic wave-around sentence produced a valid 178,826-byte RIFF/WAV.
- Installer — 101,176,591 bytes; SHA-256 `462F702448885540E80479A93DD7F769F3B2F97FD716DDEBE561A3CE93C63811`; Authenticode `NotSigned`.
- Repository-wide `npm run check:arch` — infrastructure gate did not start any module because `agent-browser` startup timed out (`spawnSync ... ETIMEDOUT`) even after dependency/browser installation; no controller assertion failed.

## Risks or blockers

- Derived all-car speed needs private-session calibration before unattended race-day penalties are enabled.
- iRacing chat command posting is not authoritative acceptance readback; the exported audit distinguishes local send-path results from telemetry-observed state.
- Windows SmartScreen may warn until GSRC signs the installer with its production certificate.

## Next action

Install 0.1.0 on the intended Race Control PC, route VB-CABLE in a private hosted race, and rehearse deployment → gather → waves → one-to-green → control-line green while comparing derived speeds with driver dashboards.
