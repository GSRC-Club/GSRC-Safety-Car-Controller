'use strict';

const VK = { f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b };

class PushToTalk {
    constructor(log = console) { this.log = log; this.key = null; this.state = null; }
    _init() {
        if (this.state) return true;
        if (process.platform !== 'win32') return false;
        try {
            const koffi = require('koffi');
            const user32 = koffi.load('user32.dll');
            this.state = {
                keybd: user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo);'),
                find: user32.func('void* __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
                focus: user32.func('bool __stdcall SetForegroundWindow(void* hWnd)'),
            };
            return true;
        } catch (error) { this.log.warn?.(`Audio PTT unavailable: ${error.message}`); return false; }
    }
    down(keyName = 'f9') {
        const key = VK[String(keyName).toLowerCase()];
        if (!key || !this._init() || this.key) return false;
        const hwnd = this.state.find('SimWinClass', null) || this.state.find(null, 'iRacing.com Simulator');
        if (!hwnd) { this.log.warn?.('Audio PTT blocked: iRacing simulator window not found.'); return false; }
        if (!this.state.focus(hwnd)) { this.log.warn?.('Audio PTT blocked: iRacing could not receive keyboard focus.'); return false; }
        this.state.keybd(key, 0, 0, 0); this.key = key; return true;
    }
    up() {
        if (!this.key || !this.state) return false;
        this.state.keybd(this.key, 0, 0x0002, 0); this.key = null; return true;
    }
}

module.exports = { PushToTalk };
