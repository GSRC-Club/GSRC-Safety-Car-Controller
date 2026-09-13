'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('gsrcSafetyCar', {
    state: () => ipcRenderer.invoke('controller:state'),
    action: (name, payload) => ipcRenderer.invoke('controller:action', name, payload),
    logo: () => ipcRenderer.invoke('brand:logo'),
    ptt: (active, key) => ipcRenderer.invoke('audio:ptt', active, key),
    exportAudit: () => ipcRenderer.invoke('audit:export'),
    onState: callback => on('controller:state', callback),
    onCommand: callback => on('controller:command', callback),
    onAttention: callback => on('controller:attention', callback),
    onAudio: callback => on('audio:play', callback),
    onAudioError: callback => on('audio:error', callback),
});
