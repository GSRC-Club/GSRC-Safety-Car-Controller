# 0.2.2 test session

This build fixes reproducible controller defects. Automated checks use synthetic SDK data and rehearsal; they do not certify a real iRacing race. No live simulator was running on the build machine on 25 September 2026.

## AI race: test native iRacing Yellow

1. Run the controller on the iRacing PC, at the same Windows privilege level as iRacing. Configure the AI race to allow full-course cautions. Start the actual Race and wait until racing has begun. Show the whole field in the SDK (Max Cars).
2. Turn Rehearsal OFF. Choose **iRacing Yellow**, **Manual call**, and initially disable scheduled calls, incident triggering, waves and audio. Apply the plan. Confirm the displayed track and session.
3. Arm Live Output, then Deploy. Expect `!yellow` in iRacing chat, its admin response, a yellow flag and the bots following the pace car. The controller should show **iRacing caution confirmed**. A local send result alone does not prove server acceptance.
4. If no yellow is confirmed within 15 seconds, output disarms. Read the in-sim chat response and check admin rights, caution settings, window focus and matching Windows privilege levels. Do not keep clicking Deploy. If necessary close the interrupted record/cancel the controller state and reconcile the simulator first.
5. Test **PACE LAP −1 / +1**. These send native relative adjustments. **REQUEST ONE TO GREEN** sends `!pacelaps 1`; it does not instantly force a green flag. The controller waits for caution telemetry to clear before declaring green.
6. Test a second caution with one lapped AI car and manual waves enabled. Confirm pack stable, request one wave, and verify the native pace instruction/scoring in iRacing. The local sender cannot verify individual wave-by acceptance.

AI drivers cannot obey private Code 80 chat instructions. This build detects AI in the roster and rejects chat-only Code 80/human safety-car deployment in a live AI race with an explanation. The app does not control bot throttle. Native yellow is the supported AI test path; Code 80 needs human drivers.

## Human test: GSRC Code 80

Use a private hosted session with a cooperative leader, a following driver and one genuinely lapped driver. Verify chat is visible to each recipient.

1. Set field limit 80, leader gather 72, correction 30 seconds, manual waves and 2 Code 80 laps. Deploy after arming. The field gets `/all` instructions; after countdown the leader gets a private `/carNumber` instruction to hold 72. Check leading-zero car numbers too.
2. Compare displayed speed against the driver's dash at steady 72/80 km/h. All-car speed is derived from lap progress and simulator time. Deliberately exceed the target briefly, then long enough to trigger a warning. Correct within the window and verify no penalty. Uncorrected violations remain deferred until green.
3. Have a driver pass another car, including a lapped-car/lead-lap pairing. Confirm the private warning identifies which car to let back through. Return the position and check correction. Test a pit stop/disconnect without penalising the remaining cars for a disappearing competitor.
4. Confirm **PACK STABLE**. The leader receives the field-speed target. Release the eligible lapped car. Code 80 sends a private instruction to physically pass, complete one lap and rejoin the back; it does not send `!waveby` or alter scoring. Observe the minimum release spacing.
5. Waved cars are exempt while completing that instruction. Visually verify all are back, then click **WAVES REJOINED**. This ends further waves and captures the new order. Restart is blocked until pending releases/rejoins are resolved.
6. Test **PACE LAP −1 / +1**. Code 80 counts leader lap crossings; reducing the target never releases the field by itself. Once the pack is ready and the target is one crossing away, it calls one-to-green. **ARM RESTART** allows leader acceleration. Passing remains prohibited until the control line (start/finish by default). Verify green and deferred penalties there. **FORCE GREEN** remains an explicit operator override.
7. Repeat with Strict Code 80: no bunch-up/waves. Confirm its gap-preserving instructions and manual release. Human Safety Car also needs a real nominated driver; the controller does not drive a car.
8. Disarm, move replay away from live, disconnect and restart the app during an active procedure. Verify blocking/recovery and no automatic rearming. Local AI identity deliberately cannot be resumed across a disconnect or app restart.

## Capture an unsuccessful test

Export the Race Control audit and note build version, procedure, session type, caution setting, arming state, displayed error and iRacing's chat response. Local name-redacted traces are under the app's user-data `telemetry-traces` directory. Audit exports contain driver names/chat; keep them private.

Automatic incident calls rely on published incident totals. Missing totals, especially for bots, cannot reliably trigger them. A total increase of four is also not a server receipt proving one collision; test manually first. Multiclass class-leader wave eligibility, automatic confirmation of a completed virtual wave and automatic restart-zone calibration are not implemented.
