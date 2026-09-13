// src/session-info-parser.js
// Parses the iRacing SessionInfo YAML into the compact JSON shape the GSRC
// backend expects. Uses a real YAML parser — the blob is multiline, contains
// colons in values, and must never be regexed.

const YAML = require('yaml');

// 1-entry exact-text memo. The loop callers only invoke this when the reader's
// sessionInfoUpdate counter changed (irsdk-reader.readSessionInfoIfChanged gates it),
// so in steady state each call sees DIFFERENT YAML text and this never hits. But it
// makes a redundant re-parse of byte-identical text free — a cheap guard against
// iRacing bumping the update counter without a meaningful text change, or any caller
// double-parsing the same blob. A full YAML.parse of a 60-car endurance SessionInfo is
// the single heaviest synchronous op on the relay's SessionInfo path; skipping it when
// the text is unchanged is a pure win with byte-identical output. We key on the exact
// string; the parsed result is never mutated by callers (they read/copy out of it).
let _lastYamlText = null;
let _lastParsed = null;

function parseWeekendOption(value) {
    if (value == null || String(value).trim() === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : String(value).trim();
}

function incidentLimitLabel(limit, warningInitial, warningSubsequent) {
    const initial = Number(warningInitial);
    const subsequent = Number(warningSubsequent);
    if (Number.isFinite(initial) && initial > 0) {
        return Number.isFinite(subsequent) && subsequent > 0
            ? `${initial}x/${subsequent}x`
            : `${initial}x`;
    }
    const numericLimit = Number(limit);
    if (Number.isFinite(numericLimit)) return `${numericLimit}x`;
    const text = String(limit ?? '').trim();
    return text.toLowerCase() === 'unlimited' ? 'Unlimited' : text;
}

function parseSessionInfo(yamlText, log) {
    if (typeof yamlText === 'string' && yamlText === _lastYamlText && _lastParsed) {
        return _lastParsed;
    }
    let doc;
    try {
        doc = YAML.parse(yamlText, { uniqueKeys: false });
    } catch (err) {
        return { error: `SessionInfo YAML parse failed: ${err.message}` };
    }
    if (!doc || typeof doc !== 'object') return { error: 'SessionInfo empty' };

    const weekend = doc.WeekendInfo || {};
    const weekendOptions = weekend.WeekendOptions || {};
    const sessions = (doc.SessionInfo && doc.SessionInfo.Sessions) || [];
    // Current/last session entry — prefer the RACE session if present
    const race = sessions.find(s => String(s.SessionType || '').toUpperCase().includes('RACE'));
    const current = race || sessions[sessions.length - 1] || {};

    // Full per-simsession directory (SessionNum → { type, name }). The incident
    // register groups its feed by simsession (Practice / Qualify / Race / Race 1…),
    // and the per-incident telemetry SessionNum is just an index — the human label
    // lives only here in SessionInfo.Sessions[]. Keep SessionNum exactly as iRacing
    // reports it (it IS the telemetry SessionNum); a legit 0 must survive.
    const sessionList = sessions
        .map((s, i) => {
            const numVal = Number(s && s.SessionNum);
            return {
                num: Number.isFinite(numVal) ? (numVal | 0) : i,
                type: (s && s.SessionType) ? String(s.SessionType) : '',
                name: (s && s.SessionName) ? String(s.SessionName) : '',
            };
        });

    // Camera groups (track-dependent: { GroupNum, GroupName }) → a name→number map.
    // iRacing-TV Controller/IRSDKSharper send GroupNum directly in CamSwitchNum,
    // so keep the value exactly as reported by SessionInfo.
    const groupsRaw = (doc.CameraInfo && doc.CameraInfo.Groups) || [];
    const cameraGroups = {};
    for (const g of groupsRaw) {
        const name = String(g.GroupName || '').trim();
        const numVal = Number(g.GroupNum);
        if (name && Number.isFinite(numVal)) cameraGroups[name] = numVal | 0;
    }

    // Numeric iRacing track id — matches the /data API track_id, used by the backend
    // to resolve the track-map SVG layers for the 2D map overlay. A legitimate id of 0
    // must survive (don't coerce it to null via `|| null`), so use an isFinite guard.
    const trackIdNum = Number(weekend.TrackID);
    const trackId = Number.isFinite(trackIdNum) ? trackIdNum : null;
    if (trackId === null && log && typeof log.warn === 'function') {
        log.warn('SessionInfo parsed with a missing/non-numeric WeekendInfo.TrackID — track-map overlay will be disabled for this session.');
    }

    // Track length in METERS — the incident categorizer (incident-derive.js) needs it to
    // derive each car's speed from CarIdxLapDistPct deltas (research §4: there is no per-car
    // speed channel). iRacing's WeekendInfo.TrackLength is a STRING, conventionally in km
    // (e.g. "5.89 km" / "3.860 km", occasionally a bare number). Parse the leading float and
    // convert km→m. A non-finite/non-positive value → null (categorizer treats speed as unknown).
    const tl = parseFloat(String(weekend.TrackLength));
    const trackLengthM = Number.isFinite(tl) && tl > 0 ? Math.round(tl * 1000) : null;
    const incidentLimit = parseWeekendOption(weekendOptions.IncidentLimit);
    const incidentWarningInitialLimit = parseWeekendOption(weekendOptions.IncidentWarningInitialLimit);
    const incidentWarningSubsequentLimit = parseWeekendOption(weekendOptions.IncidentWarningSubsequentLimit);
    const incidentLimitDisplay = incidentLimitLabel(
        incidentLimit,
        incidentWarningInitialLimit,
        incidentWarningSubsequentLimit,
    );

    // DriverCarIdx — the local broadcaster's own car index. Trading Paints' team
    // endpoint wants it as the `user=` param (mirrors TPDownloader's mislabelled
    // "DriverUserId"); harmless/unused in individual sessions.
    const driverCarIdx = Number((doc.DriverInfo && doc.DriverInfo.DriverCarIdx));

    const driversRaw = (doc.DriverInfo && doc.DriverInfo.Drivers) || [];
    const resultCarIdxs = new Set(sessions.flatMap(s =>
        (Array.isArray(s && s.ResultsPositions) ? s.ResultsPositions : [])
            .map(result => Number(result && result.CarIdx))
            .filter(Number.isFinite)));
    const drivers = driversRaw
        .filter(d => {
            const carIdx = Number(d.CarIdx);
            const hasPaceFlag = d.CarIsPaceCar !== undefined && d.CarIsPaceCar !== null;
            const isPaceCar = Number(d.CarIsPaceCar) === 1 ||
                (!hasPaceFlag && !resultCarIdxs.has(carIdx) &&
                    String(d.UserName || '').trim().toLowerCase() === 'pace car');
            return Number.isInteger(carIdx) && carIdx >= 0 && !isPaceCar &&
                (!Number(d.IsSpectator) || resultCarIdxs.has(carIdx));
        })
        .map(d => ({
            carIdx: Number(d.CarIdx),
            userName: d.UserName || '',
            userID: Number(d.UserID) || 0,
            carNumber: String(d.CarNumber || '').replace(/"/g, ''),
            // CarNumberRaw is the pre-encoded integer iRacing wants in CamSwitchNum
            // (it already accounts for significant leading zeros). When present the
            // dispatcher uses it directly and skips padCarNum.
            carNumberRaw: Number.isFinite(Number(d.CarNumberRaw)) ? Number(d.CarNumberRaw) : null,
            carScreenName: d.CarScreenName || '',
            carClassID: Number(d.CarClassID) || 0,
            // CarPath (the local paint folder name, e.g. "bmwm8gte") + CarID let the
            // relay locate each driver's custom paint .tga (car_<custId>.tga) under
            // <Documents>/iRacing/paint/<carPath>/ for the live-livery feed.
            carPath: d.CarPath || '',
            carID: Number(d.CarID) || 0,
            // Official iRacing paint-shop design. The local pk_car renderer needs
            // these when no custom TGA exists; without them every car is stock black.
            carDesignStr: d.CarDesignStr || '',
            carNumberDesignStr: d.CarNumberDesignStr || '',
            clubID: Number(d.ClubID) || 0,
            carSponsor1: Number(d.CarSponsor_1) || 0,
            carSponsor2: Number(d.CarSponsor_2) || 0,
            irating: Number(d.IRating) || null,
            licenseLevel: Number(d.LicLevel) || null,
            teamName: d.TeamName || null,
            // TeamID — non-zero ONLY in team/endurance sessions. The car wears the TEAM
            // livery (stored locally as car_team_<teamID>.tga), NOT the current driver's
            // personal car_<custId>.tga, so the livery feed needs this to locate the right
            // .tga. 0 / absent in single-driver sessions (→ cust paint only). Kept signed
            // (iRacing TeamID can be negative); the candidate builder hedges the sign.
            teamID: Number.isFinite(Number(d.TeamID)) && Number(d.TeamID) !== 0 ? Number(d.TeamID) : 0,
            // Per-car running incident totals from the YAML (research §3 — the all-car
            // incident source the binary telemetry lacks). TeamIncidentCount ≈ this car's
            // total; CurDriverIncidentCount ≈ the current driver's total (team/endurance
            // swaps). isFinite-guarded so a legit 0 survives as 0 (not coerced to null).
            teamIncidentCount: Number.isFinite(Number(d.TeamIncidentCount)) ? Number(d.TeamIncidentCount) : null,
            curDriverIncidentCount: Number.isFinite(Number(d.CurDriverIncidentCount)) ? Number(d.CurDriverIncidentCount) : null,
        }));

    const parsed = {
        weekendInfo: {
            simMode: String(weekend.SimMode || '').trim().toLowerCase(),
            trackName: weekend.TrackName || '',
            trackDisplayName: weekend.TrackDisplayName || weekend.TrackName || '',
            trackConfigName: weekend.TrackConfigName || '',
            // Numeric iRacing track id — see the isFinite-guarded resolution above
            // (a legit id of 0 must survive; only a missing/non-numeric id → null).
            trackId,
            // Track length in meters (km×1000) for the incident categorizer's derived
            // speed — see the parse above. null when TrackLength is missing/unparseable.
            trackLengthM,
            seriesName: weekend.LeagueName || weekend.SeriesName || '',
            sessionId: Number(weekend.SessionID) || null,
            subSessionId: Number(weekend.SubSessionID) || null,
            leagueId: Number(weekend.LeagueID) || null,
            // Series id + team-racing flag — used by the built-in Trading Paints
            // downloader to pick its individual vs team fetch path (see trading-paints.js).
            seriesId: Number(weekend.SeriesID) || null,
            teamRacing: Number(weekend.TeamRacing) === 1,
            numCarClasses: Number(weekend.NumCarClasses) || 1,
            incidentLimit,
            incidentWarningInitialLimit,
            incidentWarningSubsequentLimit,
            incidentLimitDisplay,
        },
        sessionInfo: {
            sessionType: current.SessionType || '',
            sessionTime: current.SessionTime || '',
            sessionLaps: current.SessionLaps || '',
            // Full simsession directory for incident-register grouping (see above).
            sessions: sessionList,
        },
        driverInfo: { drivers, driverCarIdx: Number.isFinite(driverCarIdx) ? driverCarIdx : null },
        // name → GroupNum for the director's group-by-name camera switches.
        cameraGroups,
    };
    // Cache the successful parse against its exact source text for the (rare) repeat call.
    if (typeof yamlText === 'string') { _lastYamlText = yamlText; _lastParsed = parsed; }
    return parsed;
}

module.exports = { parseSessionInfo };
