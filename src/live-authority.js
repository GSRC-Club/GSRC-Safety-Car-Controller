'use strict';

const RACING_SESSION_STATE = 4;

function evaluateLiveAuthority(context = {}, boundSessionIdentity = null) {
    if (context.simulated) return { ok: true, rehearsal: true, outputAllowed: false, reason: null };
    if (!context.connected) return blocked('iRacing telemetry is disconnected.');
    if (context.stale || context.frameAt != null && Date.now() - context.frameAt > 1500) return blocked('iRacing telemetry is stale.');
    if (!context.isRace) return blocked('The active iRacing session is not a Race session.');
    if (Number(context.sessionState) !== RACING_SESSION_STATE) return blocked('The Race session is not in the Racing state.');
    if (context.replayLive !== true) return blocked('iRacing is not at the live replay frame.');
    if (!context.sessionIdentity) return blocked('The loaded iRacing session has no verifiable identity.');
    if (boundSessionIdentity && context.sessionIdentity !== boundSessionIdentity) {
        return blocked(`The loaded session changed from ${boundSessionIdentity} to ${context.sessionIdentity}.`);
    }
    const drivers = (context.drivers || []).filter(driver => driver?.inWorld !== false && Number.isInteger(Number(driver?.carIdx)));
    if (drivers.length < 2) return blocked('The live driver roster is incomplete.');
    if (new Set(drivers.map(driver => Number(driver.carIdx))).size !== drivers.length) return blocked('The live driver roster contains duplicate CarIdx values.');
    return { ok: true, rehearsal: false, outputAllowed: true, reason: null };
}

function blocked(reason) { return { ok: false, rehearsal: false, outputAllowed: false, reason }; }

module.exports = { evaluateLiveAuthority, RACING_SESSION_STATE };
