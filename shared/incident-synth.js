// src/incident-synth.js
// Loop-wiring glue (shared by src/main.js and gui/relay-runner.js) for the
// YAML-sourced per-car incident route (research §3 + CONTRACT-INC).
//
// The iRacing binary telemetry has NO per-car incident count — only the followed
// car's own count. The all-car total lives in the SessionInfo YAML as
// DriverInfo:Drivers[].TeamIncidentCount, which the parser now exposes per driver
// (session-info-parser.js → drivers[].teamIncidentCount). The backend incident
// register already turns a cumulative `telemetry.CarIdxIncidentCount[]` into
// per-frame deltas → severity (shape (a)), so the relay's job is simply to
// SYNTHESIZE that array (indexed by carIdx, pace car at 0) from the YAML counts.
//
// ⚠ UNVERIFIED ON-SIM: whether TeamIncidentCount actually ticks live for ALL cars
// mid-session is flagged MEDIUM-HIGH in the research (§3) and must be confirmed on a
// rig/replay. Until then we GUARD: only emit the synthesized array when the YAML
// actually provides non-baseline counts (at least one finite, with at least one > 0),
// and keep the existing off-track surface proxy (incident-derive.js) as the fallback.
// The whole synth is gated by config.synthIncidentCounts (default true).

// Per-car cumulative incident value from the parsed YAML. Prefer TeamIncidentCount
// (the car's running total), but FALL BACK to CurDriverIncidentCount when the team
// field is absent/null — in team/endurance sessions iRacing may tick only the
// current-driver field while TeamIncidentCount stays at baseline. We take the MAX of
// the two finite values so the series stays monotonic (the backend diffs it per frame;
// a non-monotonic source would emit spurious deltas / be dropped on negatives).
// TeamIncidentCount ≥ CurDriverIncidentCount normally, so max == team when team ticks.
// Returns null when neither field is finite. In single-driver sessions both fields
// equal the driver's own count → identical behaviour to before (no regression).
function incidentValueOf(d) {
    const t = Number(d && d.teamIncidentCount);
    const c = Number(d && d.curDriverIncidentCount);
    const tf = Number.isFinite(t);
    const cf = Number.isFinite(c);
    if (tf && cf) return Math.max(t, c);
    if (tf) return t;
    if (cf) return c;
    return null;
}

// PERF memo (the synth's only input is the driver list, which only changes on a
// SessionInfo update, but BOTH loop callers invoke this EVERY telemetry tick —
// main.js / gui/relay-runner.js call it inside the per-frame `if (frame)` block,
// NOT gated on the SessionInfo change). Re-deriving the array + double-looping the
// (up to 60-car) roster every tick is pure waste: the result is identical until the
// roster reference changes. We cache keyed on the driver-list REFERENCE — both
// callers pass the SAME `_lastDrivers` array object until they reassign it on the
// next SessionInfo parse, so identity is the exact "did the source change?" signal.
// The cached result is never mutated by the callers (they assign array onto the
// frame and ship it), so handing back the same reference is safe + byte-identical.
let _memoKey = null;     // last drivers array reference
let _memoVal = null;     // last { array, hasData } returned for it

// Build a cumulative CarIdxIncidentCount[] from the parsed YAML driver list.
//
// drivers: parsed session driverInfo.drivers (each may carry teamIncidentCount and/or
//   curDriverIncidentCount, int|null).
// Returns { array, hasData }:
//   - array: number[] sized to (maxCarIdx+1), index = carIdx, [0]=pace=0, gaps→0.
//            Drivers with no finite incident value contribute 0 at their slot.
//   - hasData: true only when at least one driver reported a finite incident value
//            AND at least one of those is > 0 (i.e. the YAML route looks alive — not all
//            baseline zeros / nulls). When false the caller should OMIT the array and
//            rely on the off-track proxy (per CONTRACT-INC + research §3 caveat).
function synthCarIdxIncidentCount(drivers) {
    // Reference-identity memo: same roster object → return the prior result. Only
    // hits when the caller passes the very same array (its `_lastDrivers`) again,
    // which is exactly the per-tick repeat case we want to skip.
    if (drivers != null && drivers === _memoKey) return _memoVal;
    const list = Array.isArray(drivers) ? drivers : [];
    let maxIdx = 0;
    let anyFinite = false;
    let anyPositive = false;
    for (const d of list) {
        const idx = Number(d && d.carIdx);
        if (Number.isFinite(idx) && idx > maxIdx) maxIdx = idx;
        const v = incidentValueOf(d);
        if (v !== null) {
            anyFinite = true;
            if (v > 0) anyPositive = true;
        }
    }
    const array = new Array(maxIdx + 1).fill(0); // [0] = pace car = 0
    for (const d of list) {
        const idx = Number(d && d.carIdx);
        if (!Number.isFinite(idx) || idx <= 0 || idx > maxIdx) continue;
        const v = incidentValueOf(d);
        array[idx] = (v !== null && v > 0) ? v : 0;
    }
    const result = { array, hasData: anyFinite && anyPositive };
    // Cache against the input reference for the next (per-tick) call. Only a non-null
    // input is memoized — null/undefined falls through to a fresh compute each time
    // (cheap, and avoids caching a transient empty result against a null key).
    if (drivers != null) { _memoKey = drivers; _memoVal = result; }
    return result;
}

module.exports = { synthCarIdxIncidentCount, incidentValueOf };
