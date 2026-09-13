# GSRC Safety Car Controller — design and evidence

Research checked on 30 August 2026. This is product engineering evidence, not legal advice.

## The critical procedure distinction

A conventional Code 60 or full-course speed restriction freezes the running order and broadly preserves gaps. It is not a bunch-up procedure. The 2026 iRTES Code 60 rules explicitly removed stopping, queues and wave-bys; cars remain moving and generally hold their order. Other motorsport descriptions of an 80 km/h FCY likewise say that gaps are not reset.

GSRC asked for a leader-controlled bunch-up, wave-arounds and a restart. The product therefore exposes two different presets instead of silently mixing incompatible rules:

| Preset | Speed | Gaps | Wave-arounds | Restart |
| --- | ---: | --- | --- | --- |
| Strict Code 80 | 80 km/h max | Preserved | None | Immediate release procedure |
| GSRC Code 80 Safety Car | Field max 80; leader gather target 72 | Deliberately closed | Staggered one car at a time | Leader-controlled control-line restart |

The second preset is functionally a virtual safety car using an 80 km/h field limit. The lower leader gather target solves the otherwise impossible requirement that cars capped at the same speed should close a pre-existing gap.

Sources: [iRTES 2026 Sporting Regulations](https://cmsracing.com/irtes/sporting-regulations/), [Sportscar365 FCY description](https://sportscar365.com/lemans/wec/full-course-yellow-procedure-set-to-change-next-year/), [iRacing 2026 Official Sporting Code](https://ir-core-sites.iracing.com/members/pdfs/20260310-official_sporting_code_dated_Mar_10_2026.pdf).

## iRacing control surface

iRacing does not provide a general SDK function that applies arbitrary race penalties or speaks audio. Administrator actions are chat commands entered while the sim is loaded. The controller uses the supported commands:

- `!yellow` to throw the native caution;
- `!waveby #number` to move a car up one lap and send it to the end of the pace line;
- `!black #number D` for a drive-through;
- `!pacelaps`, `!pitclose`, `!pitopen`, `!restart single|double` for procedure control;
- `/all` for text that reaches the field.

The official documentation notes that the sender must be the host or a promoted administrator. Command posting is not proof that the server accepted the sporting outcome, so the audit distinguishes local send-path success from telemetry-observed state.

Native caution observation uses the SDK `SessionFlags` bitfield and edge-detects `irsdk_caution` (`0x00004000`) or `irsdk_cautionWaving` (`0x00008000`). An app-scheduled native caution is marked as already accounting for its schedule slot before the echoed flag arrives, preventing an accidental double consumption. Source: [iRacing SDK definitions](https://raw.githubusercontent.com/w1nterl0ng/irsdk/main/irsdk_defines.h).

Source: [iRacing Session Admin Chat Commands](https://support.iracing.com/support/solutions/articles/31000133518-session-admin-chat-commands).

The current 2026 Sporting Code says the pole car controls a rolling field after the pace car leaves; Start Zone restarts are leader-controlled; road-course drivers stay in their pace lines until green; drivers may not time a high-speed run at the green; and pit entry/exit can be closed by Race Control. The GSRC ruleset can be stricter by prohibiting passing until its published control line, but that must be a clearly published league supplementary rule.

## Enforcement model

The controller never treats a single noisy telemetry sample as a penalty. It uses:

1. exact session and race-state checks;
2. a physical-order snapshot based on completed laps plus lap-distance percentage;
3. derived per-car speed from lap-distance delta, track length and elapsed time;
4. configurable tolerance and persistence gates;
5. one explicit driver warning;
6. a 30-second correction window;
7. a deferred penalty queue that is serviced only after green;
8. a complete audit record of the evidence, command and result.

Release 0.2 adds a continuous LiveAuthority interlock. The active procedure is bound to `{SubSessionID}:{SessionNum}` and requires fresh frames, the Racing session state, the live replay edge and a coherent roster before any autonomous output can continue. A failed condition disarms and freezes the procedure until an operator acknowledges it. Rehearsal uses a recording adapter and cannot reach iRacing even if malformed UI state claims it is armed.

Active procedure state, deterministic command IDs and local command results are persisted in a hash-chained operation ledger. A crash or power loss therefore starts in recovery-required mode instead of guessing whether pit closure, a wave or a black flag succeeded. Name-redacted telemetry frames are retained in a bounded local trace and replayed through the same controller interface in regression tests.

The current race gate follows telemetry `SessionNum` into the SessionInfo directory; it does not assume the weekend's future Race entry is the session presently running. Native iRacing yellows deliberately skip GSRC's 80 km/h/order penalty loop and defer to the simulator's pace instructions. The stricter GSRC restart lock begins only when Race Control arms the control-line restart.

Wave candidates are lapped cars ordered backwards from the actual pace-car position when iRacing exposes it, otherwise from the leader. Automatic mode requires a continuously stable pack, releases the nearest eligible car immediately, then staggers each remaining car by five seconds. Manual mode makes only eligible rows clickable and requires a named confirmation. In both cases, the exact `!waveby` command and field announcement are logged.

Known limit: public iRacing telemetry does not expose rich per-car longitudinal acceleration or an authoritative all-car speed channel. Speed is derived. It is suitable for warnings and sustained-limit enforcement with tolerances, but live calibration evidence should be collected before GSRC enables unattended penalties.

## Incident-triggered deployment

The public binary telemetry does not expose a reliable instantaneous incident object for every car. GSRC's existing relay work established a guarded path from SessionInfo `TeamIncidentCount`/`CurDriverIncidentCount` totals. This controller permits auto-deploy only from confirmed 4x deltas clustered by unique cars, time and wrapped track position. Physics-derived crash estimates may raise a review alert but cannot directly deploy or penalise.

Defaults:

- review at three unique confirmed 4x cars;
- automatic call at five unique confirmed 4x cars;
- three-second time window;
- ten-percent wrapped track window.

All values are configurable and automatic mode is opt-in.

## Canned and dynamic audio

iRacing exposes voice channels and an assignable Push-to-Talk control, but not an SDK “broadcast this audio file” call. The workable local route is:

`pre-rendered/cached WAV → virtual playback device → paired virtual microphone → iRacing @RACECONTROL voice channel`

The app verifies and focuses the iRacing window, holds a configured F-key before playback, uses a short radio-open lead, and releases it only after a short tail. Calls are serialized in command order so a later reminder cannot cut off a wave instruction. Common calls ship as compact pre-generated assets. Dynamic calls are synthesized as one complete sentence, normalized for whitespace and cached by a content hash. Car number `123` becomes “one two three” inside that complete utterance, producing natural inter-digit timing. Individual digit assets are retained only as an offline recovery building block.

VB-Audio permits certain VB-CABLE distribution under its donationware conditions but requires clear attribution and has separate professional/volume terms. The safer release choice is not to bundle the driver: link operators to the vendor installer and let GSRC obtain any professional licence it needs.

Sources: [iRacing radio/spotter functionality](https://support.iracing.com/support/solutions/articles/31000133437-spotter-functionality-radio), [iRacing hot-key customization](https://support.iracing.com/support/solutions/articles/31000133517-customizing-sim-hot-key-combinations), [VB-Audio licensing and distribution](https://vb-audio.com/Services/licensing.htm).

## Clean-room and third-party licensing

The GitHub repository containing iCASControl reports no detected licence and has no root licence grant. Publicly visible source is not automatically reusable source. This application therefore copies no iCAS code, CSS, maps or audio; it implements GSRC requirements from official interfaces and independently written state machines.

The surveyed `simracingtools/racecontrol-server` repository reports GPL-3.0. Its code is likewise not copied into this private GSRC codebase. `cadfan/ira` reports a nonstandard/undetected licence. Repository metadata was checked through the GitHub API on 30 August 2026.

Reference pages: [iCASControl repository](https://github.com/halvar20000/iracing-overlays/tree/main/racecontrol), [simracingtools/racecontrol-server](https://github.com/simracingtools/racecontrol-server), [cadfan/ira](https://github.com/cadfan/ira).

GSRC branding is GSRC-owned content already present in the private GSRC Racing System. The controller follows the repository's private licence in `../LICENSE.md`.

## Why the design goes beyond the surveyed public projects

Public tools surveyed offered combinations of live timing, incident logs, manual commands and simulation. This controller's differentiating safety system is the combination of:

- strict and bunch-up procedures kept semantically separate;
- explicit state transitions with operator-visible prerequisites;
- warning → correction → deferred penalty lifecycle;
- staggered, identity-confirmed wave-arounds;
- control-line restart order capture and enforcement;
- confirmed-4x-only unattended deployment;
- preview/disarmed operation and full offline rehearsal;
- complete-sentence dynamic speech with virtual-audio PTT;
- exact outbound-command previews and an exportable audit trail.
- continuous session/replay/freshness authority with manual recovery;
- durable crash recovery, command deduplication and hash-chain verification;
- send-success-gated wave announcements and queue-wide failure interlocks;
- redacted, globally storage-capped recorded-frame regression replay;
- fail-closed, timestamped Authenticode packaging.

That is a stronger procedural design than the public feature sets found in this research. It does not claim that live reliability is proven until GSRC completes private-session and race-day calibration testing.
