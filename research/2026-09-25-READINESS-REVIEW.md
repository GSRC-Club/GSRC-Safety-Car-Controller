# Safety controller readiness review — 25 September 2026

## Findings reproduced in this repository

The tester's original failure has not been reproduced in a running simulator. Synthetic regression cases did reproduce the following defects in 0.2.1:

- ReplayFrameNumEnd was treated as an absolute endpoint and subtracted from ReplayFrameNum. It is already a distance from the end of tape; a live value of zero was rejected.
- A local AI roster with no positive SubSessionID had no identity. 0.2.2 retains CarIsAI and binds such sessions to an ephemeral connection token and SessionNum. Disconnect, stale reconnect, time rollback or app restart cannot silently reuse that identity. Saved replay mode remains blocked.
- Announcement metadata overwrote the outbound `/all` prefix. Targeted announcements carried a CarIdx but never addressed a private recipient. Both are corrected; private messages are text-only, and valid CarIdx zero/leading-zero car numbers survive.
- The chat adapter returned success even when Enter failed. It now checks each send, checks authority during paste delays, targets only the actual simulator window, and checks the Windows SendInput result. Server acceptance still requires observation.
- Native green was only an internal transition. Native restart now requests pace laps and follows actual caution telemetry. A missing initial yellow confirmation interlocks after 15 seconds.
- Virtual waves used a native scoring command; waved drivers could receive speed warnings and keep restart exemptions indefinitely. Virtual waves now instruct physical circulation, exclude pit-lane/invalid candidates, enforce spacing, and require operator rejoin confirmation before relocking/restarting.
- Scored race-distance ordering missed overtakes between drivers on different laps. The lock now stores road order and subsequent physical progress.
- Code 80 had no lap-duration controls. It now has a configurable target and +/- controls, with pack/rejoin gates and explicit restart release. Derived speed uses simulation time, rejects invalid/implausible samples and does not retain stale speed indefinitely.

## Public GitHub comparison

Search window: **25 July–25 September 2026**. GitHub repository search was supplemented with direct repository metadata and path-specific commit history. Recent repository activity does not establish that its live safety-car implementation works. No external implementation or audio was copied.

| Project | Verified activity | Relevant evidence and consequence |
| --- | --- | --- |
| [Better Caution Bot](https://github.com/TylerAgostino/caution_bot) | [19 August leader restart-zone reminder](https://github.com/TylerAgostino/caution_bot/commit/eac75e11d33be1f1b146607a47e6c271238c3bd2); also 18 August distance fixes | Its custom Code 69 procedure distinguishes chat-directed pacing from native caution. It documents private leader guidance, wave/class handling and a pit-entry caution edge case. This supports checking recipient routing, pacing distance, restart instructions and waves separately. GPL-3.0: behavior comparison only. Its richer class separation is not claimed as a GSRC feature. |
| [iCASControl in iracing-overlays](https://github.com/halvar20000/iracing-overlays/tree/main/racecontrol) | Racecontrol included in [12 August commit](https://github.com/halvar20000/iracing-overlays/commit/68e200ba046b0c8b75e175f559057a53eb5dca81); repository pushed 18 September | Its README explicitly distinguishes simulator/replay functionality from live iRacing and says live admin commands are shown for manual entry. It recommends full-field telemetry and matching Windows privilege levels. Useful setup/acceptance guidance, not proof of live delivery. No repository licence grant detected. |
| [iRacingSafetyCarGenerator](https://github.com/joshjaysalazar/iRacingSafetyCarGenerator), [racecontrol-server](https://github.com/simracingtools/racecontrol-server), [ira](https://github.com/cadfan/ira) | Repository push dates: 16 February 2026, 24 December 2022, 2 March 2026 respectively | Outside the requested two-month window; not presented as recent implementations. |

## Interface evidence

- [iRacing admin-command documentation](https://support.iracing.com/support/solutions/articles/31000133518-session-admin-chat-commands) defines native yellow, wave-by scoring and absolute/relative pace-lap commands. Pit open/close commands concern manual pit control during green; native pit instructions should come from iRacing.
- [iRacing chat documentation](https://support.iracing.com/support/solutions/articles/31000170165-pit-macros-chat-commands) specifies `/carNumber` private routing. A broadcast announcement naming one car is not a DM.
- [SDK telemetry dump from iRacing TV Controller](https://github.com/mherbold/iRacing-TV-Controller/blob/main/Notes/irsdk-data-telemetry.txt) records ReplayFrameNumEnd's SDK description as distance from the end of tape. [SDK session schema examples](https://github.com/mherbold/iRacing-TV-Controller/blob/main/Notes/irsdk-data-session.yaml) include CarIsAI. These are interface evidence, not proof of the tester's exact session values.

## Acceptance boundary

Automated tests exercise the real parser, controller, service serialization and chat-adapter seams with synthetic inputs; Electron UI verification uses isolated rehearsal profiles. No race simulator was running, so bot reaction, server-side admin acceptance, derived-speed calibration and Windows focus behavior during driving remain live acceptance gates. See the [test-session checklist](../docs/TEST-SESSION-0.2.2.md). The original report could involve configuration as well as these defects; obtain the exported audit if it persists.
