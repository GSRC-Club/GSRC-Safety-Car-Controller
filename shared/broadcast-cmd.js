// src/broadcast-cmd.js
// The relay's ONLY write path to iRacing: "broadcast messages" for camera and
// replay control. Telemetry is read-only shared memory; this module asks the sim
// to switch cameras / seek the replay — never anything destructive.
//
// iRacing registers a Windows message "IRSDK_BROADCASTMSG"; any process can post
// it to ALL top-level windows (HWND_BROADCAST) and the sim self-selects and acts
// on it — no focus/foreground required. Packing matches the iRacing SDK
// (irsdk_defines.h / pyirsdk / IRSDKSharper), CONFIRMED against primary sources:
//     wParam = MAKELONG(broadcastType, var1)   // var1 is a SIGNED 16-bit word
//     lParam = MAKELONG(var2, var3)            // 3-var camera form
//     lParam = var2 (full 32-bit int)          // 2-var replay form (frame #, sessionTimeMS)
//
// ⚠ The packing is verified against the SDK headers, but landing it on the sim is
// UNVERIFIED from the build machine — run the Phase-0 checklist on the race PC.
// Wrong packing is a no-op or a wrong-camera, never destructive.

const HWND_BROADCAST = 0xffff;

// irsdk_BroadcastMsg
const MSG = {
    CamSwitchPos: 0,
    CamSwitchNum: 1,
    CamSetState: 2,
    ReplaySetPlaySpeed: 3,
    ReplaySetPlayPosition: 4,
    ReplaySearch: 5,
    ReplaySetState: 6,
    ReloadTextures: 7,
    ChatCommand: 8,
    PitCommand: 9,
    TelemCommand: 10,
    FFBCommand: 11,
    ReplaySearchSessionTime: 12,
    VideoCapture: 13,
};

// irsdk_csMode — camera focus codes (pass in the var1/position slot; SIGNED).
const CAM_FOCUS = { Incident: -3, Leader: -2, Exiting: -1, Driver: 0 };
// irsdk_RpyPosMode
const RPY_POS = { Begin: 0, Current: 1, End: 2 };
// irsdk_RpySrchMode
const RPY_SRCH = {
    ToStart: 0, ToEnd: 1, PrevSession: 2, NextSession: 3, PrevLap: 4,
    NextLap: 5, PrevFrame: 6, NextFrame: 7, PrevIncident: 8, NextIncident: 9,
};
// irsdk_RpyStateMode
const RPY_STATE = { EraseTape: 0 };
// irsdk_CameraState (bitfield — OR together for CamSetState).
const CAM_STATE = {
    IsSessionScreen: 0x0001, IsScenicActive: 0x0002, CamToolActive: 0x0004,
    UIHidden: 0x0008, UseAutoShotSelection: 0x0010, UseTemporaryEdits: 0x0020,
    UseKeyAcceleration: 0x0040, UseKey10xAcceleration: 0x0080, UseMouseAimMode: 0x0100,
};

// MAKELONG with 16-bit masking on BOTH halves so a negative var1/var2 (focus
// codes, negative replay speed) does not sign-extend into the high word. >>>0
// keeps it an unsigned 32-bit value.
function makeLong(lo, hi) {
    return (((lo & 0xffff) | ((hi & 0xffff) << 16)) >>> 0);
}

// iRacing car-number encoding for CamSwitchNum. Leading zeros are SIGNIFICANT
// (#01 != #1). pyirsdk _pad_car_num, ported verbatim: "71"->71, "071"->3071,
// "02"->2002, "07"->2007, "01"->2001. If you already have DriverInfo's
// CarNumberRaw (the pre-encoded int) use THAT directly and pass carNumberRaw=true.
function padCarNum(numStr) {
    const s = String(numStr);
    let zero = s.length - s.replace(/^0+/, '').length;     // count leading zeros
    if (zero > 0 && s.length === zero) zero -= 1;          // all-zeros guard ("00")
    const n = parseInt(s, 10) || 0;
    if (zero) {
        const place = n > 99 ? 3 : n > 9 ? 2 : 1;
        return n + 1000 * (place + zero);
    }
    return n;
}

let _state = { ready: false, msgId: 0, send: null };

// Test seam: when set, raw() routes through this instead of the real FFI send,
// and reports ready=true so the EXACT packed wParam/lParam can be asserted off
// Windows with no koffi. Production never touches this (it's only set by tests
// via __setTestSender). Each call receives the already-packed { broadcastType,
// var1, var2, var3, fullLParam, wParam, lParam } so a test can verify the bytes.
let _testSender = null;

// One-time guard so the "init failed — reinstall" guidance is shouted ONCE, not
// on every dropped command (handle() calls init() on each command).
let _initFailShouted = false;

// Lazily wire user32 via Koffi (same FFI approach as the SDK reader). Returns
// false off-Windows or if registration fails — callers degrade to a logged no-op.
//
// DIAGNOSTICS (Task 2): on the FIRST failure this logs a LOUD, single-line,
// actionable error naming exactly what to reinstall, so an operator watching the
// relay log can tell "commands are dropped because the broadcast channel never
// came up" apart from "commands arrive but the sim ignores them (in-car)".
function init(log) {
    if (_state.ready) return true;
    if (_testSender) {            // test mode: pretend the channel is up
        _state = { ready: true, msgId: 0xBEEF, send: _testSender };
        return true;
    }
    if (process.platform !== 'win32') {
        if (!_initFailShouted) {
            _initFailShouted = true;
            if (log && log.warn) log.warn('Camera/replay write-path DISABLED: not running on Windows. The relay must run on the broadcaster\'s iRacing PC for camera control to work.');
        }
        return false;
    }
    try {
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');

        // W-variant + str16 → exact parity with iRacing's own RegisterWindowMessage
        // atom (A/W return the same atom, but staying in one charset family avoids
        // any ambiguity).
        const RegisterWindowMessageW = user32.func(
            'uint32 __stdcall RegisterWindowMessageW(str16 lpString)'
        );
        // BOOL SendNotifyMessageW(HWND, UINT, WPARAM, LPARAM). Koffi rejects
        // coercing the HWND_BROADCAST constant through void*, so pass it as a
        // pointer-sized integer. WPARAM=uintptr_t, LPARAM=intptr_t (signed →
        // negative speed/frame clean).
        const SendNotifyMessageW = user32.func(
            'bool __stdcall SendNotifyMessageW(uintptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)'
        );
        // IRSDKSharper / iRacing-TV path — non-blocking fallback.
        const PostMessageW = user32.func(
            'bool __stdcall PostMessageW(uintptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)'
        );

        const msgId = RegisterWindowMessageW('IRSDK_BROADCASTMSG');
        if (!msgId) {
            if (!_initFailShouted) {
                _initFailShouted = true;
                if (log && log.error) log.error('Camera/replay write-path DISABLED: RegisterWindowMessageW("IRSDK_BROADCASTMSG") returned 0 (Win32 error). Camera control will not work until this succeeds — restart the relay; if it persists, reboot Windows.');
            }
            return false;
        }

        const hwnd = HWND_BROADCAST; // (HWND)0xffff
        _state = {
            ready: true,
            msgId,
            send: (wParam, lParam) => {
                const ok = SendNotifyMessageW(hwnd, msgId, wParam >>> 0, lParam | 0);
                if (!ok) PostMessageW(hwnd, msgId, wParam >>> 0, lParam | 0); // belt-and-braces
                return ok;
            },
        };
        _initFailShouted = false; // recovered — allow a future failure to shout again
        if (log && log.info) log.info(`iRacing broadcast-message channel ready (msgId=${msgId}) — camera/replay control ENABLED.`);
        return true;
    } catch (e) {
        if (!_initFailShouted) {
            _initFailShouted = true;
            // The overwhelmingly common cause in a packaged build is a missing/locked
            // koffi native binary. Name it explicitly + the fix (reinstall the .exe).
            if (log && log.error) log.error(`Camera/replay write-path DISABLED: could not load the koffi/user32 FFI bridge (${e.message}). Camera control is dead. FIX: reinstall the GSRC Broadcast Relay (download the latest GSRC-Broadcast-Relay-*.exe and run it) — an older or partially-extracted build is missing koffi's native module.`);
        }
        return false;
    }
}

// Core send. fullLParam (when a number) overrides var2/var3 and is sent as the
// full 32-bit lParam (the 2-var replay form: frame #, sessionTimeMS).
function raw(broadcastType, var1 = 0, var2 = 0, var3 = 0, fullLParam) {
    if (!_state.ready) return false;
    const wParam = makeLong(broadcastType, var1);
    const lParam = (typeof fullLParam === 'number') ? (fullLParam | 0) : makeLong(var2 || 0, var3 || 0);
    try {
        // In test mode the sender receives the fully-decoded packing so a unit test
        // can assert the EXACT wParam/lParam integers vs the pyirsdk formula.
        if (_testSender) return _testSender({ broadcastType, var1, var2, var3, fullLParam, wParam, lParam });
        return _state.send(wParam >>> 0, lParam | 0);
    } catch (e) { return false; }
}

// ---- camera verbs ----------------------------------------------------------
// Point the active camera at a car NUMBER. A negative carNumber is treated as a
// CAM_FOCUS.* code. carNumberRaw=true means the value is already CarNumberRaw
// (pre-encoded by iRacing) — used directly, skipping padCarNum.
function camSwitchNum(carNumber, camGroupNum = 0, camera = 0, carNumberRaw = false) {
    let v1;
    if (typeof carNumber === 'number' && carNumber < 0) v1 = carNumber | 0;       // focus code
    else if (carNumberRaw) v1 = parseInt(carNumber, 10) | 0;                       // already encoded
    else v1 = padCarNum(carNumber);                                               // encode leading zeros
    return raw(MSG.CamSwitchNum, v1, camGroupNum | 0, camera | 0);
}
// Point the active camera at a finishing POSITION (1 = leader). Negative = focus code.
function camSwitchPos(position, camGroupNum = 0, camera = 0) {
    return raw(MSG.CamSwitchPos, position | 0, camGroupNum | 0, camera | 0);
}
// Keep the camera following the leader / current incident, changing only the group.
function camFocusLeader(group = 0)   { return raw(MSG.CamSwitchPos, CAM_FOCUS.Leader, group | 0, 0); }
function camFocusIncident(group = 0) { return raw(MSG.CamSwitchPos, CAM_FOCUS.Incident, group | 0, 0); }
// Set the camera state bitfield (CAM_STATE.* OR'd) — e.g. auto-shot off + clean feed.
function camSetState(stateBits) { return raw(MSG.CamSetState, stateBits | 0); }

// ---- replay verbs ----------------------------------------------------------
// Seek the replay to an absolute frame number (frames from session start).
function replaySetPlayPositionFrame(frame, mode = RPY_POS.Begin) {
    return raw(MSG.ReplaySetPlayPosition, mode | 0, 0, 0, frame | 0); // lParam = frame (full 32-bit)
}
// Seek the replay to a session time. sessionNum + time in MILLISECONDS.
function replaySearchSessionTime(sessionNum, timeMs) {
    return raw(MSG.ReplaySearchSessionTime, sessionNum | 0, 0, 0, timeMs | 0); // lParam = ms (full 32-bit)
}
// Replay transport speed: 0 = pause, 1 = play, N = N× fast-fwd, -N = N× rewind. slowMotion 0/1.
function replaySetPlaySpeed(speed, slowMotion = 0) {
    return raw(MSG.ReplaySetPlaySpeed, speed | 0, slowMotion ? 1 : 0, 0);
}
// Built-in replay search shortcuts (incl. native prev/next incident).
function replaySearch(mode) { return raw(MSG.ReplaySearch, mode | 0, 0, 0); }
function replaySetState(mode = RPY_STATE.EraseTape) { return raw(MSG.ReplaySetState, mode | 0); }

// ---- chat verbs ------------------------------------------------------------
// irsdk_BroadcastChatComand modes: 0 = fire macro 0-14 (var2), 1 = BeginChat
// (open the chat box), 2 = Reply, 3 = Cancel. Arbitrary TEXT can't ride the
// broadcast channel — the sim-chat dispatch opens the box here, then pastes via
// key injection (clipboard + ctrl+v + enter).
function chatCommand(mode = 1, arg = 0) { return raw(MSG.ChatCommand, mode | 0, arg | 0); }

// ════════════════════════════════════════════════════════════════════════════
// KEY INJECTION (sim-key command) — raw OS keystrokes into the iRacing window.
//
// The broadcast-message channel above is iRacing's OWN protocol and is the right
// tool for camera/replay. But some director actions have NO broadcast-message
// equivalent — e.g. CTRL+R (toggle relative/standings black box) or SPACE (hide
// the in-sim dashboard). For those we synthesise real keyboard input.
//
// iRacing reads the keyboard through DirectInput, so PostMessage(WM_KEYDOWN) to
// the window is IGNORED. The reliable path is: find iRacing's window, bring it to
// the foreground, then SendInput() a hardware-style key sequence
// (modifiers-down → key-down → key-up → modifiers-up). SendInput injects into the
// system input stream, which DirectInput honours.
//
// ⚠ This STEALS FOREGROUND for an instant (SetForegroundWindow). On a single-PC
// broadcast that's the sim itself, so it's fine; on a multi-window setup the
// operator should keep iRacing focusable. UNVERIFIED on a real sim from the build
// machine — see the Phase-0 checklist.
// ════════════════════════════════════════════════════════════════════════════

// Win32 virtual-key codes (subset we expose to the director). Single letters/digits
// map to their ASCII upper-case code (VK == ASCII for 'A'..'Z' and '0'..'9').
const VK = {
    ctrl: 0x11,   // VK_CONTROL
    control: 0x11,
    alt: 0x12,    // VK_MENU
    shift: 0x10,  // VK_SHIFT
    space: 0x20,  // VK_SPACE
    enter: 0x0D,  // VK_RETURN
    return: 0x0D,
    esc: 0x1B,    // VK_ESCAPE
    escape: 0x1B,
    tab: 0x09,    // VK_TAB
    backspace: 0x08,
    delete: 0x2E,
    up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
    f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
};
const MODIFIER_TOKENS = new Set(['ctrl', 'control', 'alt', 'shift']);

// Resolve a single combo token to a Win32 virtual-key code, or null if unknown.
function vkForToken(tok) {
    if (!tok) return null;
    const t = String(tok).toLowerCase().trim();
    if (t in VK) return VK[t];
    if (t.length === 1) {
        const ch = t.toUpperCase().charCodeAt(0);
        if ((ch >= 0x41 && ch <= 0x5A) || (ch >= 0x30 && ch <= 0x39)) return ch; // A-Z / 0-9
    }
    return null;
}

// Parse a lowercase '+'-joined combo ('ctrl+r', 'space', 'ctrl+shift+f') into
// { modifiers:[vk,...], key:vk, raw }. Unknown/empty → { key:null } (caller no-ops).
// Defensive: never throws; trims tokens; ignores unknown tokens but still resolves
// the rest so 'ctrl+typo+r' degrades to ctrl+r rather than failing wholesale.
function parseKeyCombo(combo) {
    const out = { modifiers: [], key: null, raw: String(combo == null ? '' : combo) };
    if (!combo || typeof combo !== 'string') return out;
    const tokens = combo.split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const tok of tokens) {
        if (MODIFIER_TOKENS.has(tok)) {
            const vk = VK[tok];
            if (vk && !out.modifiers.includes(vk)) out.modifiers.push(vk);
            continue;
        }
        const vk = vkForToken(tok);
        if (vk == null) continue;            // unknown non-modifier token → ignore it
        out.key = vk;                        // last non-modifier wins as the main key
    }
    return out;
}

// Lazily-wired user32 functions for key injection (separate from the broadcast
// send path so a koffi failure there doesn't kill keys and vice-versa).
let _keyState = { ready: false, fns: null };
let _keyInitFailShouted = false;
// Test seam — when set, sendKeys() routes the PARSED combo here instead of touching
// user32, so a unit test can assert modifiers+key without Windows.
let _testKeySender = null;

function initKeys(log) {
    if (_testKeySender) { _keyState = { ready: true, fns: null }; return true; }
    if (_keyState.ready) return true;
    if (process.platform !== 'win32') {
        if (!_keyInitFailShouted) {
            _keyInitFailShouted = true;
            if (log && log.warn) log.warn('sim-key DISABLED: not running on Windows. The relay must run on the broadcaster\'s iRacing PC for keystroke injection to work.');
        }
        return false;
    }
    try {
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');

        // Find iRacing's main window. iRacing's render window class is "SimWinClass"
        // (window title "iRacing.com Simulator"). Never inject into another app.
        const FindWindowW = user32.func('void* __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)');
        const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void* hWnd)');
        const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
        // UINT SendInput(UINT cInputs, LPINPUT pInputs, int cbSize). INPUT is a tagged
        // union; for keyboard the layout is { DWORD type; KEYBDINPUT ki; } and on x64
        // the struct is 40 bytes (type+pad 8, then KEYBDINPUT 24, + tail pad). We build
        // the byte buffer by hand to avoid a fragile koffi struct definition.
        const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, void* pInputs, int cbSize)');
        const KEYEVENTF_KEYUP = 0x0002;

        _keyState = {
            ready: true,
            fns: {
                focusSim() {
                    // Re-find each time and verify focus before sending any input.
                    let h = FindWindowW('SimWinClass', null) || FindWindowW(null, 'iRacing.com Simulator');
                    if (h) { try { SetForegroundWindow(h); } catch (_) {} }
                    const foreground = GetForegroundWindow();
                    return !!h && !!foreground && koffi.address(h) === koffi.address(foreground);
                },
                // Press a parsed combo via SendInput: modifiers down → key down →
                // key up → modifiers up (reverse order on the way up).
                press(modifiers, key) {
                    const events = [...modifiers.map(vk => [vk, 0]), [key, 0], [key, KEYEVENTF_KEYUP], ...[...modifiers].reverse().map(vk => [vk, KEYEVENTF_KEYUP])];
                    const size = process.arch === 'ia32' ? 28 : 40;
                    const offset = process.arch === 'ia32' ? 4 : 8;
                    const buffer = Buffer.alloc(size * events.length);
                    events.forEach(([vk, flags], index) => {
                        const start = index * size;
                        buffer.writeUInt32LE(1, start); // INPUT_KEYBOARD
                        buffer.writeUInt16LE(vk, start + offset);
                        buffer.writeUInt32LE(flags, start + offset + 4);
                    });
                    return SendInput(events.length, buffer, size) === events.length;
                },
            },
        };
        _keyInitFailShouted = false;
        if (log && log.info) log.info('sim-key keyboard-injection path ready (user32 SendInput, verified simulator focus).');
        return true;
    } catch (e) {
        if (!_keyInitFailShouted) {
            _keyInitFailShouted = true;
            if (log && log.error) log.error(`sim-key DISABLED: could not load the koffi/user32 bridge for keystroke injection (${e.message}). FIX: reinstall the latest GSRC Broadcast Relay .exe.`);
        }
        return false;
    }
}

// Inject a key combo into iRacing. combo is a lowercase '+'-joined string. Returns
// true if a (non-empty) keystroke was sent, false on unknown/empty combo or a dead
// channel. NEVER throws — a bad combo logs + no-ops.
function sendKeys(combo, log) {
    const parsed = parseKeyCombo(combo);
    if (parsed.key == null) {
        if (log && log.warn) log.warn(`sim-key: no usable key in combo "${parsed.raw}" — ignored (no-op)`);
        return false;
    }
    if (_testKeySender) {                 // test mode: report the parsed combo, no FFI
        try { _testKeySender(parsed); } catch (_) {}
        return true;
    }
    if (!initKeys(log)) return false;
    try {
        if (!_keyState.fns.focusSim()) return false;
        return _keyState.fns.press(parsed.modifiers, parsed.key);
    } catch (e) {
        if (log && log.warn) log.warn(`sim-key send error for "${parsed.raw}": ${e.message}`);
        return false;
    }
}

// Test seam for key injection — install a sink that receives the PARSED combo
// ({ modifiers, key, raw }); pass null to restore the real FFI path.
function __setTestKeySender(fn) {
    const prev = _testKeySender;
    _testKeySender = (typeof fn === 'function') ? fn : null;
    _keyState = { ready: false, fns: null };
    _keyInitFailShouted = false;
    return prev;
}

// ── test seam ────────────────────────────────────────────────────────────────
// Install a capture sink so a unit test can drive the REAL verbs and assert the
// exact packed integers without koffi/Windows. Pass a function to enable, null to
// restore the production FFI path. Returns the previous sender so tests can nest.
function __setTestSender(fn) {
    const prev = _testSender;
    _testSender = (typeof fn === 'function') ? fn : null;
    // Reset readiness so the next init() re-evaluates against the new mode.
    _state = { ready: false, msgId: 0, send: null };
    _initFailShouted = false;
    return prev;
}
// True once init() has wired a live (or test) send channel.
function isReady() { return !!_state.ready; }

module.exports = {
    init, raw, makeLong, padCarNum, isReady, __setTestSender,
    camSwitchNum, camSwitchPos, camFocusLeader, camFocusIncident, camSetState,
    replaySetPlayPositionFrame, replaySearchSessionTime, replaySetPlaySpeed,
    replaySearch, replaySetState, chatCommand,
    // sim-key (raw OS keystroke injection)
    sendKeys, parseKeyCombo, initKeys, __setTestKeySender, VK,
    MSG, CAM_FOCUS, RPY_POS, RPY_SRCH, RPY_STATE, CAM_STATE,
};
