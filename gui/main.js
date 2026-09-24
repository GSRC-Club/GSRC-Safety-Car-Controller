'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ControllerService } = require('../src/service');
const { VoiceRenderer } = require('../src/voice-renderer');
const { PushToTalk } = require('../src/audio-ptt');
const { asset } = require('../src/shared');
const { OperationLedger } = require('../src/operation-ledger');

let window = null;
let service = null;
let voice = null;
let voiceQueue = Promise.resolve();
const ptt = new PushToTalk(console);
const unpacked = value => value.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

const settingsPath = () => path.join(app.getPath('userData'), 'controller-settings.json');
function readSettings() {
    try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (_) { return {}; }
}
function saveSettings(value) {
    const file = settingsPath(); fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file);
}
function isMainSender(event) { return !!window && BrowserWindow.fromWebContents(event.sender) === window; }

function createWindow() {
    window = new BrowserWindow({
        width: 1720, height: 980, minWidth: 1180, minHeight: 720,
        title: 'GSRC Safety Car Controller', backgroundColor: '#071017', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: true, spellcheck: false },
    });
    window.loadFile(path.join(__dirname, 'controller.html'));
    if (process.env.GSRC_SAFETY_CAPTURE) {
        window.webContents.once('did-finish-load', () => setTimeout(async () => {
            try {
                const image = await window.capturePage();
                fs.writeFileSync(process.env.GSRC_SAFETY_CAPTURE, image.toPNG());
            } finally { app.quit(); }
        }, 1600));
    }
    window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    window.on('closed', () => { window = null; });
}

function perform(action, payload = {}) {
    const controller = service.controller;
    switch (action) {
        case 'configure': {
            const state = controller.configure(payload);
            saveSettings(state.config);
            return state;
        }
        case 'deploy': return controller.deploy(payload.procedure, payload.reason);
        case 'cancel': return controller.cancel(payload.reason);
        case 'pack-ready': return controller.markPackReady();
        case 'wave': return controller.issueWave(Number(payload.carIdx));
        case 'waves-complete': return controller.completeWaves();
        case 'one-to-green': return controller.oneToGreen();
        case 'restart': return controller.beginRestart();
        case 'pace-laps': return controller.adjustPaceLaps(payload.delta);
        case 'green': return controller.forceGreen();
        case 'arm-output': return controller.setOutputArmed(!!payload.active);
        case 'interlock-ack': return controller.acknowledgeInterlock();
        case 'recovery': return controller.resolveRecovery(payload.mode);
        case 'simulation': service.setSimulation(!!payload.active); return controller.snapshot();
        case 'simulate': service.simulate(payload.simAction, Number(payload.carIdx)); return controller.snapshot();
        default: throw new Error(`Unknown controller action: ${action}`);
    }
}

ipcMain.handle('controller:state', event => isMainSender(event) ? service.controller.snapshot() : null);
ipcMain.handle('controller:action', (event, action, payload) => {
    if (!isMainSender(event)) return { ok: false, message: 'Untrusted controller request.' };
    try { return { ok: true, state: perform(action, payload || {}) }; }
    catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('brand:logo', event => isMainSender(event) ? pathToFileURL(asset('GSRCWhiteTrans.png')).href : null);
ipcMain.handle('audio:ptt', (event, active, key) => {
    if (!isMainSender(event)) return false;
    if (!active) return ptt.up();
    const state = service.controller.snapshot();
    return state.config.outputArmed && state.authority.outputAllowed && !state.interlock && ptt.down(key);
});
ipcMain.handle('audit:export', async event => {
    if (!isMainSender(event)) return { ok: false };
    const choice = await dialog.showSaveDialog(window, { title: 'Export safety-car audit log', defaultPath: `GSRC-Safety-Car-Audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true };
    const integrity = service.ledger.exportBundle(choice.filePath, service.controller.snapshot());
    return { ok: true, path: choice.filePath, integrity };
});

app.whenReady().then(() => {
    const settings = { ...readSettings(), outputArmed: false };
    const ledger = new OperationLedger({ directory: path.join(app.getPath('userData'), 'operation-ledger') });
    service = new ControllerService({ clipboard, config: settings, log: console, ledger, traceDirectory: path.join(app.getPath('userData'), 'telemetry-traces') });
    voice = new VoiceRenderer({ cacheDir: path.join(app.getPath('userData'), 'voice-cache'), scriptPath: unpacked(path.join(__dirname, '..', 'scripts', 'synth-speech.ps1')) });
    service.controller.on('state', state => {
        if (!state.config.outputArmed || !state.authority.outputAllowed || state.interlock) ptt.up();
        window?.webContents.send('controller:state', state);
    });
    service.controller.on('attention', item => window?.webContents.send('controller:attention', item));
    service.controller.on('command', command => {
        window?.webContents.send('controller:command', command);
        if (!service.controller.config.audio.enabled || !command.audioCue) return;
        voiceQueue = voiceQueue.then(async () => {
            const file = await voice.render(command.speechText || command.text);
            const stillArmed = command.armed && (!command.procedureId || command.procedureId === service.controller.procedureId) && service.controller.config.outputArmed && !service.controller.interlock && service.controller.snapshot().authority.outputAllowed;
            window?.webContents.send('audio:play', { url: pathToFileURL(file).href, armed: stillArmed, procedureId: command.procedureId, key: service.controller.config.audio.pttKey, deviceId: service.controller.config.audio.outputDeviceId, speechText: command.speechText });
        }).catch(error => { window?.webContents.send('audio:error', error.message); });
    });
    if (process.env.GSRC_SAFETY_CAPTURE) service.setSimulation(true);
    createWindow(); service.start();
}).catch(error => { console.error(error); app.quit(); });

app.on('before-quit', () => { ptt.up(); service?.stop(); });
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!window) createWindow(); });
