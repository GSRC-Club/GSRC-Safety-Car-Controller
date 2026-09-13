// src/irsdk-reader.js
// iRacing SDK shared-memory reader using Koffi (no native compile step).
//
// iRacing exposes telemetry via a Windows file mapping named
// "Local\IRSDKMemMapFileName". Layout (all little-endian):
//
//   irsdk_header (offset 0):
//     int ver, status, tickRate
//     int sessionInfoUpdate, sessionInfoLen, sessionInfoOffset
//     int numVars, varHeaderOffset
//     int numBuf, bufLen
//     int pad[2]
//     irsdk_varBuf varBuf[4]  →  { int tickCount; int bufOffset; int pad[2] }
//
//   irsdk_varHeader[numVars] at varHeaderOffset (144 bytes each):
//     int type; int offset; int count; bool countAsTime; char pad[3]
//     char name[32]; char desc[64]; char unit[32]
//
//   SessionInfo YAML string at sessionInfoOffset (sessionInfoLen bytes)
//   Telemetry buffers at varBuf[i].bufOffset (bufLen bytes each)
//
// Var types: 0 char, 1 bool, 2 int, 3 bitfield, 4 float, 5 double.
//
// Torn-read protection: read the chosen varBuf tickCount, copy the buffer,
// re-read tickCount — if it changed mid-copy, discard and retry next poll.

const HEADER_SIZE = 48 + 4 * 16; // base header + 4 varBufs
const VAR_HEADER_SIZE = 144;
const MAX_MAP_SIZE = 4 * 1024 * 1024; // map a generous window; actual data is smaller
const FILE_MAP_READ = 0x0004;

const VAR_TYPE = { CHAR: 0, BOOL: 1, INT: 2, BITFIELD: 3, FLOAT: 4, DOUBLE: 5 };
const VAR_TYPE_SIZE = [1, 1, 4, 4, 4, 8];

class IrsdkReader {
    constructor() {
        this.koffi = null;
        this.view = null;        // mapped pointer
        this.varHeaders = null;  // parsed var header list
        this.lastSessionInfoUpdate = -1;
        // PERF: koffi.array(type, len, 'Typed') is the HINTED overload, which in koffi's
        // native code is NOT interned/deduped — every call permanently appends a new
        // anonymous TypeInfo to koffi's global type table (+ a name string allocation).
        // _bytes() runs ~3-4x per poll tick, mostly at the SAME few fixed lengths, so a
        // naive call-per-read leaks native memory unbounded over a long race (invisible to
        // the JS heap; forces Windows to swap → "must restart"). Cache the array type per
        // length so each distinct size builds its koffi type exactly once and reuses it,
        // capping the native type table at a handful of entries for the whole run.
        this._arrayTypeCache = new Map(); // length -> koffi array type
        // PERF: the requested-var Set is rebuilt every frame in readFrame though varNames
        // is constant; cache it keyed on the array identity so it only rebuilds on change.
        this._wantedVarNames = null;
        this._wantedSet = null;
        // PERF: the pre-filtered varHeader subset (just the wanted vars). readFrame used to
        // scan ALL varHeaders + do a Set lookup per var EVERY tick to pick out the ~44
        // requested ones; build that subset once instead and iterate only it. Rebuilt only
        // when the wanted set OR the parsed varHeaders change.
        this._wantedHeaders = null;
        this._wantedHeadersSrc = null; // the this.varHeaders array the subset was built from
    }

    // Return (and cache) the koffi 'uint8_t[len]' Typed array type for this length.
    _arrayType(length) {
        let t = this._arrayTypeCache.get(length);
        if (t === undefined) {
            t = this.koffi.array('uint8_t', length, 'Typed');
            this._arrayTypeCache.set(length, t);
        }
        return t;
    }

    // Returns true if iRacing shared memory is available.
    open() {
        if (process.platform !== 'win32') {
            throw new Error('iRacing SDK shared memory is Windows-only');
        }
        const koffi = require('koffi');
        this.koffi = koffi;
        const kernel32 = koffi.load('kernel32.dll');
        this._OpenFileMappingA = kernel32.func('void* __stdcall OpenFileMappingA(uint32 dwDesiredAccess, bool bInheritHandle, const char* lpName)');
        this._MapViewOfFile = kernel32.func('void* __stdcall MapViewOfFile(void* hFileMappingObject, uint32 dwDesiredAccess, uint32 dwFileOffsetHigh, uint32 dwFileOffsetLow, size_t dwNumberOfBytesToMap)');
        this._CloseHandle = kernel32.func('bool __stdcall CloseHandle(void* hObject)');

        this.mapHandle = this._OpenFileMappingA(FILE_MAP_READ, false, 'Local\\IRSDKMemMapFileName');
        if (!this.mapHandle || koffi.address(this.mapHandle) === 0n) {
            return false; // iRacing not running
        }
        this.view = this._MapViewOfFile(this.mapHandle, FILE_MAP_READ, 0, 0, 0);
        if (!this.view || koffi.address(this.view) === 0n) {
            this._CloseHandle(this.mapHandle);
            this.mapHandle = null;
            return false;
        }
        return true;
    }

    close() {
        if (this.mapHandle && this._CloseHandle) {
            try { this._CloseHandle(this.mapHandle); } catch (e) { /* ignore */ }
        }
        this.mapHandle = null;
        this.view = null;
        this.varHeaders = null;
    }

    _bytes(offset, length) {
        // koffi.decode with an explicit byte offset into the mapped view.
        // Reuse a cached array type per length (see _arrayType) — building it inline on
        // every call leaks an anonymous koffi type each time (native, unbounded).
        const arr = this.koffi.decode(this.view, offset, this._arrayType(length));
        return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    }

    readHeader() {
        const buf = this._bytes(0, HEADER_SIZE);
        const header = {
            ver: buf.readInt32LE(0),
            status: buf.readInt32LE(4),
            tickRate: buf.readInt32LE(8),
            sessionInfoUpdate: buf.readInt32LE(12),
            sessionInfoLen: buf.readInt32LE(16),
            sessionInfoOffset: buf.readInt32LE(20),
            numVars: buf.readInt32LE(24),
            varHeaderOffset: buf.readInt32LE(28),
            numBuf: buf.readInt32LE(32),
            bufLen: buf.readInt32LE(36),
            varBufs: [],
        };
        for (let i = 0; i < 4; i++) {
            const off = 48 + i * 16;
            header.varBufs.push({
                tickCount: buf.readInt32LE(off),
                bufOffset: buf.readInt32LE(off + 4),
            });
        }
        return header;
    }

    isConnected() {
        if (!this.view) return false;
        const header = this.readHeader();
        return (header.status & 1) === 1; // irsdk_stConnected
    }

    readVarHeaders(header) {
        const buf = this._bytes(header.varHeaderOffset, header.numVars * VAR_HEADER_SIZE);
        const headers = [];
        for (let i = 0; i < header.numVars; i++) {
            const o = i * VAR_HEADER_SIZE;
            const name = buf.toString('ascii', o + 16, o + 48).replace(/\0.*$/, '');
            headers.push({
                type: buf.readInt32LE(o),
                offset: buf.readInt32LE(o + 4),
                count: buf.readInt32LE(o + 8),
                name,
            });
        }
        this.varHeaders = headers;
        return headers;
    }

    readSessionInfo(header) {
        const buf = this._bytes(header.sessionInfoOffset, header.sessionInfoLen);
        const end = buf.indexOf(0);
        return buf.toString('utf8', 0, end === -1 ? buf.length : end);
    }

    // Read one consistent telemetry frame for the requested var names.
    // Returns { tick, tickRate, values } or null (no new tick / torn read).
    readFrame(varNames, lastTick = -1) {
        const header = this.readHeader();
        if ((header.status & 1) !== 1) return null;
        if (!this.varHeaders) this.readVarHeaders(header);

        // Newest buffer by tickCount
        let best = header.varBufs[0];
        for (const vb of header.varBufs) {
            if (vb.tickCount > best.tickCount) best = vb;
        }
        if (best.tickCount <= lastTick) return null;

        const before = best.tickCount;
        const data = this._bytes(best.bufOffset, header.bufLen);
        // Torn-read check: re-read header, confirm that buffer's tick unchanged
        const after = this.readHeader().varBufs.find(vb => vb.bufOffset === best.bufOffset);
        if (!after || after.tickCount !== before) return null;

        const values = {};
        for (const vh of this._selectWantedHeaders(varNames)) {
            values[vh.name] = this._decodeVar(data, vh);
        }
        return { tick: before, tickRate: header.tickRate, sessionInfoUpdate: header.sessionInfoUpdate, values };
    }

    // Return (and cache) the filtered varHeader subset for the requested names — only the
    // ~44 vars the caller wants, not all ~250 the SDK exposes. PERF: readFrame used to scan
    // EVERY varHeader and do a Set lookup per var every tick; this builds the subset once
    // and rebuilds it only when the wanted-name list OR the parsed varHeaders change (the
    // latter is replaced with a NEW array on reconnect via readVarHeaders, so an identity
    // compare invalidates the subset then too). Pulled out of readFrame so the caching /
    // invalidation logic is unit-testable without the shared-memory map.
    _selectWantedHeaders(varNames) {
        if (this._wantedVarNames !== varNames) {
            this._wantedSet = new Set(varNames);
            this._wantedVarNames = varNames;
            this._wantedHeaders = null; // wanted set changed → rebuild the header subset
        }
        if (this._wantedHeaders === null || this._wantedHeadersSrc !== this.varHeaders) {
            this._wantedHeaders = (this.varHeaders || []).filter((vh) => this._wantedSet.has(vh.name));
            this._wantedHeadersSrc = this.varHeaders;
        }
        return this._wantedHeaders;
    }

    _decodeVar(data, vh) {
        const size = VAR_TYPE_SIZE[vh.type] || 4;
        const read = (off) => {
            switch (vh.type) {
                case VAR_TYPE.CHAR: return data.readInt8(off);
                case VAR_TYPE.BOOL: return data.readUInt8(off) !== 0;
                case VAR_TYPE.INT: return data.readInt32LE(off);
                case VAR_TYPE.BITFIELD: return data.readUInt32LE(off);
                case VAR_TYPE.FLOAT: return round3(data.readFloatLE(off));
                case VAR_TYPE.DOUBLE: return round3(data.readDoubleLE(off));
                default: return null;
            }
        };
        if (vh.count <= 1) return read(vh.offset);
        const out = new Array(vh.count);
        for (let i = 0; i < vh.count; i++) out[i] = read(vh.offset + i * size);
        return out;
    }

    // SessionInfo YAML, only when the update counter changed since last call.
    readSessionInfoIfChanged() {
        const header = this.readHeader();
        if (header.sessionInfoUpdate === this.lastSessionInfoUpdate) return null;
        this.lastSessionInfoUpdate = header.sessionInfoUpdate;
        return this.readSessionInfo(header);
    }
}

function round3(v) {
    return Math.round(v * 1000) / 1000;
}

module.exports = { IrsdkReader, VAR_TYPE };
