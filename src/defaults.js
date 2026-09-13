'use strict';

const DEFAULTS = Object.freeze({
    procedure: 'code80-bunch',
    controlMode: 'manual',
    outputArmed: false,
    speedLimitKph: 80,
    leaderGatherKph: 72,
    speedToleranceKph: 4,
    speedGraceSeconds: 2,
    passObservationSeconds: 1,
    rejoinGraceSeconds: 10,
    pitExitGraceSeconds: 5,
    passCorrectionSeconds: 30,
    penalty: 'D',
    countdownSeconds: 10,
    pitPolicy: 'close-deploy-open-stable',
    waveArounds: true,
    waveMode: 'manual',
    waveIntervalSeconds: 5,
    packGapSeconds: 4,
    packStableHoldSeconds: 3,
    restartControl: true,
    restartLine: 0,
    restartPassPenalty: 'D',
    announceNoPassingSeconds: 30,
    nativeYellowsCount: true,
    schedule: {
        enabled: false,
        basis: 'laps',
        count: 2,
        first: 10,
        last: 45,
        minimumSpacing: 8,
        randomized: true,
        manualPoints: [18, 36],
    },
    incidentTrigger: {
        enabled: false,
        source: 'official4x',
        trackWindowPct: 10,
        timeWindowSeconds: 3,
        reviewAt: 3,
        autoAt: 5,
        minimumUniqueCars: 3,
    },
    audio: {
        enabled: false,
        pttKey: 'f9',
        outputDeviceId: '',
    },
});

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }

module.exports = { DEFAULTS, cloneDefaults };
