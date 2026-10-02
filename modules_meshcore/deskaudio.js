/**
 * Desktop Audio plugin — agent side (runs inside the MeshAgent core, Duktape / ES5).
 * Captures desktop audio with a helper process and streams raw PCM chunks to the server.
 *
 *  Linux:   helpers/linux-capture.sh   (parec from PulseAudio/PipeWire, run as the logged-in user)
 *  Windows: helpers/deskaudio-x64.exe / deskaudio-x86.exe  (prebuilt native WASAPI loopback,
 *           no .NET needed).
 *
 * Every capture carries the server's session id (`sid`); the agent echoes it in
 * every status and chunk so the server can ignore messages from an earlier one.
 */
var PLUGIN = 'deskaudio';
var SPAWN_AS_USER = false;   // Windows: set true to launch the helper inside the logged-in user's session
var KEEPALIVE_TIMEOUT_MS = 60000;

var mesh = null;
var child = null;
var curRate = 16000;
var curCompress = true;   // ADPCM on by default; false = raw PCM (higher quality, more traffic)
var curSilence = true;    // suppress pure digital silence; false = always send
var curCodec = null;      // 'opus' when the server negotiated Opus with the browser
var curBitrate = 32;      // Opus bitrate in kbps (24/32/48)
var curSid = null;        // server session id of the current capture
var pending = null;       // consent prompt waiting for the local user
var errBuf = '';
var lastKeep = 0;
var watchdog = null;

var PROTO = 3;            // 2 = understands sid and consent; 3 = fetches the helper on demand
var pendingWin = null;    // start args waiting for the helper bytes ('need' sent)

function send(o) {
    o.action = 'plugin';
    o.plugin = PLUGIN;
    try { ((mesh && mesh.SendCommand) ? mesh : require('MeshAgent')).SendCommand(o); } catch (e) { }
}

// A line for the plugin's log window in the browser. At most LOG_MAX lines per
// minute, so a misbehaving helper cannot flood the control channel.
var LOG_MAX = 30, logCount = 0, logWindow = 0;
function log(text, sid) {
    var now = Date.now();
    if (now - logWindow > 60000) { logWindow = now; logCount = 0; }
    if (++logCount > LOG_MAX) return;
    send({ pluginaction: 'log', sid: (sid === undefined) ? curSid : sid, msg: String(text).substring(0, 300) });
}

function fail(msg, code, sid) {
    send({ pluginaction: 'status', sid: (sid === undefined) ? curSid : sid, state: 'error', code: code || 'helper_failed', msg: String(msg) });
}

// True only if a buffer of s16le PCM is pure digital silence, so the agent can
// skip streaming it while nothing plays (Windows WASAPI fills silence with exact
// zeros). A non-zero threshold would eat quiet real audio, so keep it at 0.
var SILENCE_THRESHOLD = 0;
function isSilent(buf) {
    if (!buf || !buf.length) return true;
    for (var i = 0; i + 1 < buf.length; i += 2) {
        var v = buf[i] | (buf[i + 1] << 8);
        if (v & 0x8000) v -= 0x10000;
        if (v > SILENCE_THRESHOLD || v < -SILENCE_THRESHOLD) return false;
    }
    return true;
}

// IMA ADPCM: ~4:1 compression (16-bit PCM -> 4-bit), no external library. Each
// chunk is a self-contained block (4-byte header: predictor int16 LE + step
// index + reserved, then 4-bit nibbles), so a dropped chunk never desyncs the
// stream. The browser side (_adpcmDecode) mirrors this exactly.
var IMA_STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
var IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

function adpcmEncode(buf) {
    var nSamp = buf.length >> 1;
    var alloc = (typeof Buffer.alloc === 'function');
    if (nSamp === 0) return alloc ? Buffer.alloc(0) : new Buffer(0);
    function rd(i) { var v = buf[2 * i] | (buf[2 * i + 1] << 8); if (v & 0x8000) v -= 0x10000; return v; }
    var predictor = rd(0), index = 0;
    // Start the step size matched to the block's dynamics (stored in the header),
    // so the first samples aren't slew-limited — that per-block "catch-up" is what
    // causes periodic distortion/noise at every chunk boundary.
    if (nSamp > 1) {
        var accd = 0, prev = predictor;
        for (var k = 1; k < nSamp; k++) { var sk = rd(k), d = sk - prev; if (d < 0) d = -d; accd += d; prev = sk; }
        var avgd = accd / (nSamp - 1);
        while (index < 88 && IMA_STEP[index] < avgd) index++;
    }
    var size = 4 + (nSamp >> 1);
    var out = alloc ? Buffer.alloc(size) : new Buffer(size);
    out[0] = predictor & 0xFF; out[1] = (predictor >> 8) & 0xFF; out[2] = index & 0xFF; out[3] = 0;
    var pos = 4, cur = 0, hi = false;
    for (var i = 1; i < nSamp; i++) {
        var sample = rd(i), step = IMA_STEP[index], diff = sample - predictor, code = 0;
        if (diff < 0) { code = 8; diff = -diff; }
        var vpdiff = step >> 3;
        if (diff >= step) { code |= 4; diff -= step; vpdiff += step; }
        step >>= 1;
        if (diff >= step) { code |= 2; diff -= step; vpdiff += step; }
        step >>= 1;
        if (diff >= step) { code |= 1; vpdiff += step; }
        if (code & 8) predictor -= vpdiff; else predictor += vpdiff;
        if (predictor > 32767) predictor = 32767; else if (predictor < -32768) predictor = -32768;
        index += IMA_INDEX[code];
        if (index < 0) index = 0; else if (index > 88) index = 88;
        if (!hi) { cur = code & 0x0F; hi = true; } else { out[pos++] = cur | ((code & 0x0F) << 4); hi = false; }
    }
    out[3] = hi ? 1 : 0;   // 1 => the last byte carries a padding (unused) high nibble
    if (hi) { out[pos++] = cur; }
    return out;
}

function spawn(path, args) {
    var cpm = require('child_process');
    if (process.platform == 'win32' && SPAWN_AS_USER) return cpm.execFile(path, args, { type: cpm.SpawnTypes.USER });
    return cpm.execFile(path, args);       // NB: args[0] must be the program name
}

function startWatch() {
    stopWatch();
    watchdog = setInterval(function () {
        if (Date.now() - lastKeep > KEEPALIVE_TIMEOUT_MS) stopCapture(false);
    }, 10000);
}
function stopWatch() { if (watchdog != null) { clearInterval(watchdog); watchdog = null; } }

// Native helper protocol: stdout carries [len:2 LE][flags:1][payload] frames.
// flags bit0 = silence (empty payload — skip it), bit1 = ADPCM payload,
// bit2 = one Opus packet, bit3 = several Opus packets ('opus2'). The
// agent only re-frames and base64-encodes: no DSP in Duktape anymore.
// Stream chunks can split frames at arbitrary byte offsets, so a partial
// frame is carried over between 'data' events.
var FRAME_HDR = 3;
var frameRem = null;   // { hdr: bytes(3), need, got, flags, buf }

function feedFramed(x, sid) {
    var i = 0;
    while (i < x.length) {
        if (frameRem === null) {
            // need 3 header bytes to start a frame
            if (i + FRAME_HDR > x.length) { frameRem = { hdr: x.slice(i), need: 0, got: 0, flags: 0, buf: null, partialHdr: true }; return; }
            var len = x[i] | (x[i + 1] << 8);
            var flags = x[i + 2];
            i += FRAME_HDR;
            if ((flags & 0x01) !== 0 || len === 0) continue;   // silent/empty frame: nothing to relay
            frameRem = { need: len, got: 0, flags: flags, buf: Buffer.alloc ? Buffer.alloc(len) : new Buffer(len) };
            continue;
        }
        if (frameRem.partialHdr) {
            // finish a split header
            while (frameRem.hdr.length < FRAME_HDR && i < x.length) frameRem.hdr = Buffer.concat([frameRem.hdr, x.slice(i, i + 1)]), i++;
            if (frameRem.hdr.length < FRAME_HDR) return;
            var len2 = frameRem.hdr[0] | (frameRem.hdr[1] << 8);
            var flags2 = frameRem.hdr[2];
            frameRem = null;
            if ((flags2 & 0x01) !== 0 || len2 === 0) continue;
            frameRem = { need: len2, got: 0, flags: flags2, buf: Buffer.alloc ? Buffer.alloc(len2) : new Buffer(len2) };
            continue;
        }
        var take = Math.min(frameRem.need - frameRem.got, x.length - i);
        x.copy(frameRem.buf, frameRem.got, i, i + take);
        frameRem.got += take; i += take;
        if (frameRem.got === frameRem.need) {
            var f = frameRem; frameRem = null;
            var msg = { pluginaction: 'chunk', sid: sid, rate: curRate, d: f.buf.toString('base64') };
            if ((f.flags & 0x08) !== 0) msg.codec = 'opus2';       // several 48 kHz packets
            else if ((f.flags & 0x04) !== 0) msg.codec = 'opus';   // 48 kHz packet; rate says the capture rate
            else if ((f.flags & 0x02) !== 0) msg.codec = 'adpcm';  // the browser picks its decoder by this
            send(msg);
        }
    }
}

function run(path, args, framed) {
    var sid = curSid;
    var c;
    try { c = spawn(path, args); } catch (e) { return fail('Не удалось запустить хелпер: ' + e); }
    child = c;
    frameRem = null;
    c.stderr.on('data', function (x) {
        var t = x.toString();
        errBuf += t;
        if (errBuf.length > 2000) errBuf = errBuf.slice(-2000);
        // Helper diagnostics go to the plugin's log in the browser (rate-limited).
        var lines = t.split('\n');
        for (var i = 0; i < lines.length; i++) if (lines[i].trim()) log(lines[i].trim(), sid);
    });
    c.stdout.on('data', function (x) {
        if (child !== c) return;
        if (framed) { feedFramed(x, sid); return; }
        // Linux (parec raw PCM): the agent still encodes here — there is no
        // native helper on that platform yet.
        if (curSilence && isSilent(x)) return;   // don't stream pure silence
        if (curCompress) send({ pluginaction: 'chunk', sid: sid, rate: curRate, codec: 'adpcm', d: adpcmEncode(x).toString('base64') });
        else send({ pluginaction: 'chunk', sid: sid, rate: curRate, d: x.toString('base64') });
    });
    c.on('exit', function (code) {
        if (child !== c) return;
        child = null;
        frameRem = null;
        stopWatch();
        send({ pluginaction: 'status', sid: sid, state: (code == 0 ? 'stopped' : 'error'), code: (code == 0 ? 'helper_exit' : 'helper_failed'), exitcode: code, msg: errBuf });
    });
    send({ pluginaction: 'status', sid: sid, state: 'started', proto: PROTO, rate: curRate,
           codec: (curCodec === 'opus') ? 'opus' : (curCompress ? 'adpcm' : 'pcm') });
    startWatch();
}

// The script is passed inline (sh -c) rather than written to a file: a fixed
// path in world-writable /tmp could be pre-created or swapped by a local user and
// then executed as root.
function startLinux(a) {
    if (!a.script) return fail('Нет скрипта захвата для Linux');
    // Linux captures are raw PCM from parec encoded in JS (ADPCM); there is
    // no native Opus helper on Linux yet, so an opus request degrades.
    if (curCodec === 'opus') { curCodec = null; curCompress = true; }
    var script = Buffer.from(a.script, 'base64').toString();
    log('linux capture via parec, ' + curRate + ' Hz, ' + (curCompress ? 'adpcm' : 'pcm') + (a.codec === 'opus' ? ' (opus is not available on Linux)' : ''));
    run('/bin/sh', ['sh', '-c', script, 'deskaudio', String(curRate)]);
}

// Directory of the running MeshAgent (e.g. C:\Program Files\Mesh Agent). This
// folder is normally already in the antivirus exclusions (Dr.Web and others
// whitelist the agent by path), so running the helper from here keeps it out of
// the scanner's way and gives a single, stable path an admin can exclude once.
function agentDir() {
    try {
        var p = process.execPath;
        if (p) {
            var i = p.lastIndexOf('\\'); if (i < 0) i = p.lastIndexOf('/');
            if (i > 0) return p.substring(0, i);
        }
    } catch (e) { }
    return null;
}

function sameBytes(x, y) {
    if (!x || !y || x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

// Write `data` to <dir>\<name> unless the file already holds exactly these
// bytes. The existing file is compared byte for byte (never trusted by name or a
// version sidecar), so a planted or stale file is always replaced. Returns the
// path, or null if the file could not be written (e.g. it is still running).
function dropFile(fs, dir, name, data) {
    var p = dir + '\\' + name;
    try {
        var cur = null;
        try { cur = fs.readFileSync(p); } catch (e) { }
        if (sameBytes(cur, data)) return p;
        fs.writeFileSync(p, data);
        return sameBytes(fs.readFileSync(p), data) ? p : null;
    } catch (e) { return null; }
}

// The helper runs only from the agent's own folder (writable by administrators
// only, and normally already excluded by antivirus). There is deliberately no
// fallback to %TEMP%: C:\Windows\Temp is writable by ordinary users.
function sha384(buf) {
    try { return require('SHA384Stream').create().syncHash(buf).toString('hex'); }      // MeshAgent
    catch (e) { return require('crypto').createHash('sha384').update(buf).digest('hex'); } // Node (tests)
}

function helperArgs() {
    var hargs = ['deskaudio.exe', String(curRate)];
    if (curCodec === 'opus') {
        hargs.push('opus');
        hargs.push('kbps=' + (curBitrate || 32));
    } else {
        hargs.push(curCompress ? 'adpcm' : 'pcm');
    }
    if (curSilence) hargs.push('silence');
    return hargs;
}

// 64-bit build on x64 Windows; the 32-bit build everywhere else. On ARM64 the
// x86 build runs under emulation on both Windows 10 and 11 (x64 emulation
// exists only on Windows 11).
function winArch() {
    var arch = process.env['PROCESSOR_ARCHITEW6432'] || process.env['PROCESSOR_ARCHITECTURE'];
    return (arch == 'AMD64') ? 'x64' : 'x86';
}

// A second name is used if the first is locked (e.g. a previous capture is
// still exiting while a new helper version is dropped).
var HELPER_NAMES = ['deskaudio-helper.exe', 'deskaudio-helper-b.exe'];

// Start the helper from bytes we hold (sent with 'start' by older servers,
// or fetched with 'need').
function startWinWith(dir, data, how) {
    var fs = require('fs');
    var hargs = helperArgs();
    for (var i = 0; i < HELPER_NAMES.length; i++) {
        var p = dropFile(fs, dir, HELPER_NAMES[i], data);
        if (p) {
            log('helper ' + p + ' (' + winArch() + ', ' + data.length + ' bytes, ' + how + ') ' + hargs.slice(1).join(' '));
            return run(p, hargs, true);
        }
    }
    fail('Не удалось записать хелпер в папку агента: ' + dir, 'helper_write');
}

function startWin(a) {
    var fs = require('fs');
    var dir = agentDir();
    if (!dir) return fail('Не удалось определить папку агента', 'helper_failed');
    var want = winArch();

    // Old server: the bytes came with the start message.
    var exeB64 = (want == 'x64') ? a.exe64 : a.exe32;
    if (!exeB64) exeB64 = a.exe32 || a.exe64;
    if (exeB64) return startWinWith(dir, Buffer.from(exeB64, 'base64'), 'received');

    // New server: only the identity of the helper. Reuse our copy if it matches.
    var meta = a.helper && a.helper[want];
    if (!meta || !meta.sha) return fail('Нет хелпера для Windows', 'no_helpers');
    for (var i = 0; i < HELPER_NAMES.length; i++) {
        var p = dir + '\\' + HELPER_NAMES[i], cur = null;
        try { cur = fs.readFileSync(p); } catch (e) { }
        if (cur && cur.length === meta.size && sha384(cur) === meta.sha) {
            var hargs = helperArgs();
            log('helper ' + p + ' (' + want + ', up to date) ' + hargs.slice(1).join(' '));
            return run(p, hargs, true);
        }
    }
    // Missing or stale: ask the server for this build once.
    pendingWin = { sid: curSid, dir: dir, sha: meta.sha };
    log('helper missing or outdated: downloading the ' + want + ' build (' + meta.size + ' bytes)');
    send({ pluginaction: 'need', sid: curSid, proto: PROTO, arch: want });
}

// The server's answer to 'need'.
function onHelper(args) {
    var pw = pendingWin;
    if (!pw || args.sid !== pw.sid || curSid !== pw.sid || typeof args.data !== 'string') return;
    pendingWin = null;
    var data = Buffer.from(args.data, 'base64');
    if (sha384(data) !== pw.sha) return fail('Хелпер повреждён при передаче', 'helper_failed');
    startWinWith(pw.dir, data, 'downloaded');
}

// Ask the local user for consent. Resolves `cb(true)` on "yes", `cb(false)` on
// "no" or timeout. Uses MeshAgent's own message-box module, as the desktop does.
function askConsent(c, cb) {
    var pr;
    try { pr = require('message-box').create(c.title || 'MeshCentral', c.msg, c.timeout || 30); }
    catch (e) { cb(c.autoAcceptNoUser === true); return null; }   // no interactive session to ask
    pr.then(function () { cb(true); }, function () { cb(false); });
    return pr;
}

function notifyUser(c) {
    try { require('toaster').Toast(c.title || 'MeshCentral', c.notifyMsg); } catch (e) { }
}

function begin(a) {
    if (process.platform == 'linux') return startLinux(a);
    if (process.platform == 'win32') return startWin(a);
    fail('Платформа не поддерживается: ' + process.platform, 'unsupported');
}

function startCapture(a) {
    stopCapture(true);
    curSid = (typeof a.sid == 'number') ? a.sid : null;
    curRate = (a.rate == 8000 || a.rate == 16000 || a.rate == 24000) ? a.rate : 16000;
    curCompress = (a.compress !== false);
    curSilence = (a.silence !== false);
    curCodec = (a.codec === 'opus') ? 'opus' : null;
    curBitrate = (a.bitrate == 24 || a.bitrate == 32 || a.bitrate == 48) ? a.bitrate : 32;
    errBuf = '';
    lastKeep = Date.now();
    var c = a.consent || {};
    if (!c.prompt) {
        begin(a);
        if (c.notify) notifyUser(c);
        return;
    }
    var sid = curSid;
    send({ pluginaction: 'status', sid: sid, state: 'waiting', code: 'consent_wait', timeout: c.timeout || 30 });
    pending = askConsent(c, function (ok) {
        pending = null;
        if (curSid !== sid) return;                 // stopped or restarted meanwhile
        if (!ok) return send({ pluginaction: 'status', sid: sid, state: 'error', code: 'consent_denied', msg: 'Пользователь не разрешил прослушивание' });
        lastKeep = Date.now();
        begin(a);
        if (c.notify) notifyUser(c);
    });
}

function stopCapture(silent) {
    stopWatch();
    pendingWin = null;
    if (pending) { try { if (pending.close) pending.close(); } catch (e) { } pending = null; }
    var c = child, sid = curSid;
    child = null;
    curSid = null;
    if (c) {
        try { c.kill(); } catch (e) { }
        if (process.platform == 'linux') {
            // the shell wrapper may leave parec behind
            try { require('child_process').execFile('/usr/bin/pkill', ['pkill', '-f', 'client-name=deskaudio']); } catch (e) { }
        }
        if (!silent) send({ pluginaction: 'status', sid: sid, state: 'stopped', code: 'stopped' });
    }
}

// A stop (or keepalive) for a specific capture only applies to that capture.
function forCurrent(args) { return (typeof args.sid != 'number') || args.sid === curSid; }

function consoleaction(args, rights, sessionid, parent) {
    if (parent && parent.SendCommand) mesh = parent;
    switch (args.pluginaction) {
        case 'start': startCapture(args); break;
        case 'stop': if (forCurrent(args)) stopCapture(false); break;
        case 'keepalive': if (forCurrent(args)) lastKeep = Date.now(); break;
        case 'consent':
            // A further listener joins a running capture: ask the user again.
            if (!forCurrent(args) || !args.consent) break;
            var reqid = args.reqid, sid = curSid;
            askConsent(args.consent, function (ok) {
                send({ pluginaction: 'consentresult', sid: sid, reqid: reqid, ok: !!ok });
                if (ok && args.consent.notify) notifyUser(args.consent);
            });
            break;
        case 'notify': if (forCurrent(args) && args.consent) notifyUser(args.consent); break;
        case 'helper': onHelper(args); break;
    }
}

module.exports = { consoleaction: consoleaction, _isSilent: isSilent, _adpcmEncode: adpcmEncode, _dropFile: dropFile };
