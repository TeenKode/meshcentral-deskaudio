/**
 * Desktop Audio plugin — agent side (runs inside the MeshAgent core, Duktape / ES5).
 * Captures desktop audio with a helper process and streams raw PCM chunks to the server.
 *
 *  Linux:   helpers/linux-capture.sh   (parec from PulseAudio/PipeWire, run as the logged-in user)
 *  Windows: helpers/deskaudio-x64.exe / deskaudio-x86.exe  (prebuilt native WASAPI loopback,
 *           no .NET needed), with helpers/win-loopback.cs compiled by csc.exe as a fallback.
 */
var PLUGIN = 'deskaudio';
var SPAWN_AS_USER = false;   // Windows: set true to launch the helper inside the logged-in user's session
var KEEPALIVE_TIMEOUT_MS = 60000;

var mesh = null;
var child = null;
var curRate = 16000;
var errBuf = '';
var lastKeep = 0;
var watchdog = null;

function send(o) {
    o.action = 'plugin';
    o.plugin = PLUGIN;
    try { ((mesh && mesh.SendCommand) ? mesh : require('MeshAgent')).SendCommand(o); } catch (e) { }
}

function fail(msg) { send({ pluginaction: 'status', state: 'error', msg: String(msg) }); }

// True if a buffer of s16le PCM is (near-)silence, so the agent can skip
// streaming it and save bandwidth while nothing plays on the remote machine.
var SILENCE_THRESHOLD = 48;   // ~ -56 dBFS
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

function run(path, args) {
    var c = spawn(path, args);
    child = c;
    c.stderr.on('data', function (x) {
        errBuf += x.toString();
        if (errBuf.length > 2000) errBuf = errBuf.slice(-2000);
    });
    c.stdout.on('data', function (x) {
        if (child !== c) return;
        if (isSilent(x)) return;   // don't stream pure silence
        send({ pluginaction: 'chunk', rate: curRate, codec: 'adpcm', d: adpcmEncode(x).toString('base64') });
    });
    c.on('exit', function (code) {
        if (child !== c) return;
        child = null;
        stopWatch();
        send({ pluginaction: 'status', state: (code == 0 ? 'stopped' : 'error'), code: code, msg: errBuf });
    });
    send({ pluginaction: 'status', state: 'started', rate: curRate });
    startWatch();
}

function startLinux(a) {
    var fs = require('fs');
    var p = '/tmp/.deskaudio-capture.sh';
    try { fs.writeFileSync(p, Buffer.from(a.script, 'base64')); } catch (e) { return fail('Не удалось записать скрипт: ' + e); }
    run('/bin/sh', ['sh', p, String(curRate)]);
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

// Candidate directories for the helper, most-excluded first: the agent folder,
// then %TEMP% as a fallback if that folder is not writable.
function winHelperDirs() {
    var tmp = process.env['TEMP'] || process.env['TMP'] || ((process.env['windir'] || 'C:\\Windows') + '\\Temp');
    var dirs = [];
    var ad = agentDir();
    if (ad) dirs.push(ad);
    dirs.push(tmp);
    return dirs;
}

// Write `data` to <dir>\<name> under a fixed name so the path is stable across
// plugin versions. A sidecar "<name>.ver" records the content version; the file
// is rewritten only when that version changes. Returns the path or null.
function dropFile(fs, dir, name, ver, data) {
    try {
        var p = dir + '\\' + name;
        var vp = p + '.ver';
        var cur = null;
        try { cur = fs.readFileSync(vp).toString(); } catch (e) { }
        if (cur !== ver || !fs.existsSync(p)) {
            fs.writeFileSync(p, data);
            try { fs.writeFileSync(vp, Buffer.from(ver)); } catch (e) { }
        }
        return fs.existsSync(p) ? p : null;
    } catch (e) { return null; }
}

function startWin(a) {
    var fs = require('fs');
    var hdirs = winHelperDirs();

    // 1) Preferred: a prebuilt native helper — no .NET or compiler on the target.
    //    Use the 64-bit build on a 64-bit OS, the 32-bit build otherwise; the
    //    32-bit build also runs on 64-bit Windows (WOW64) as a safe default.
    var os64 = (process.env['PROCESSOR_ARCHITECTURE'] == 'AMD64' ||
                process.env['PROCESSOR_ARCHITECTURE'] == 'ARM64' ||
                process.env['PROCESSOR_ARCHITEW6432'] != null);
    var exeB64 = os64 ? a.exe64 : a.exe32;
    var exeVer = os64 ? a.ver64 : a.ver32;
    if (!exeB64) { exeB64 = a.exe32; exeVer = a.ver32; }
    if (exeB64 && exeVer) {
        var data = Buffer.from(exeB64, 'base64');
        for (var i = 0; i < hdirs.length; i++) {
            var p = dropFile(fs, hdirs[i], 'deskaudio-helper.exe', exeVer, data);
            if (p) return run(p, ['deskaudio.exe', String(curRate)]);
        }
    }

    // 2) Fallback: compile the C# helper with any csc.exe from the .NET Framework.
    if (!a.source || !a.ver) return fail('Нет хелпера для Windows');
    var dir = hdirs[0];
    var exe = dir + '\\deskaudio-helper-cs.exe';
    if (fs.existsSync(exe)) return run(exe, ['deskaudio.exe', String(curRate)]);

    var src = dir + '\\deskaudio-helper.cs';
    try { fs.writeFileSync(src, Buffer.from(a.source, 'base64')); } catch (e) { return fail('Не удалось записать исходник: ' + e); }
    // Find any csc.exe shipped with the .NET Framework. Try newest first (v4 on
    // Win8/10/11), then fall back to v3.5 / v2.0 which are built into Windows 7
    // by default. Each machine compiles with its own compiler and runs the result
    // on the matching CLR, so no single version has to be present everywhere.
    var win = process.env['windir'] || 'C:\\Windows';
    var vers = ['v4.0.30319', 'v3.5', 'v2.0.50727'];
    var fdirs = ['Framework64', 'Framework'];
    var csc = null;
    for (var vi = 0; vi < vers.length && !csc; vi++) {
        for (var di = 0; di < fdirs.length; di++) {
            var cand = win + '\\Microsoft.NET\\' + fdirs[di] + '\\' + vers[vi] + '\\csc.exe';
            if (fs.existsSync(cand)) { csc = cand; break; }
        }
    }
    if (!csc) return fail('Не найден csc.exe (.NET Framework 2.0/3.5/4)');

    var out = '';
    var c = require('child_process').execFile(csc, ['csc.exe', '/nologo', '/optimize+', '/out:' + exe, src]);
    c.stdout.on('data', function (x) { out += x.toString(); });
    c.stderr.on('data', function (x) { out += x.toString(); });
    c.on('exit', function () {
        if (fs.existsSync(exe)) run(exe, ['deskaudio.exe', String(curRate)]);
        else fail('Не удалось собрать хелпер: ' + out.substring(0, 400));
    });
}

function startCapture(a) {
    stopCapture(true);
    curRate = (a.rate == 8000 || a.rate == 16000 || a.rate == 24000) ? a.rate : 16000;
    errBuf = '';
    lastKeep = Date.now();
    if (process.platform == 'linux') return startLinux(a);
    if (process.platform == 'win32') return startWin(a);
    fail('Платформа не поддерживается: ' + process.platform);
}

function stopCapture(silent) {
    stopWatch();
    var c = child;
    child = null;
    if (c) {
        try { c.kill(); } catch (e) { }
        if (process.platform == 'linux') {
            // the shell wrapper may leave parec behind
            try { require('child_process').execFile('/usr/bin/pkill', ['pkill', '-f', 'client-name=deskaudio']); } catch (e) { }
        }
        if (!silent) send({ pluginaction: 'status', state: 'stopped' });
    }
}

function consoleaction(args, rights, sessionid, parent) {
    if (parent && parent.SendCommand) mesh = parent;
    switch (args.pluginaction) {
        case 'start': startCapture(args); break;
        case 'stop': stopCapture(false); break;
        case 'keepalive': lastKeep = Date.now(); break;
    }
}

module.exports = { consoleaction: consoleaction, _isSilent: isSilent, _adpcmEncode: adpcmEncode };
