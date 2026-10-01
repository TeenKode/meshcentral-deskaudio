/**
 * Desktop Audio plugin — agent side (runs inside the MeshAgent core, Duktape / ES5).
 * Captures desktop audio with a helper process and streams raw PCM chunks to the server.
 *
 *  Linux:   helpers/linux-capture.sh  (parec from PulseAudio/PipeWire, run as the logged-in user)
 *  Windows: helpers/win-loopback.cs   (compiled once with .NET Framework csc.exe, WASAPI loopback)
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
        send({ pluginaction: 'chunk', rate: curRate, d: x.toString('base64') });
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

function startWin(a) {
    var fs = require('fs');
    var tmp = process.env['TEMP'] || process.env['TMP'] || ((process.env['windir'] || 'C:\\Windows') + '\\Temp');
    var exe = tmp + '\\deskaudio_' + a.ver + '.exe';
    if (fs.existsSync(exe)) return run(exe, ['deskaudio.exe', String(curRate)]);

    var src = tmp + '\\deskaudio_' + a.ver + '.cs';
    try { fs.writeFileSync(src, Buffer.from(a.source, 'base64')); } catch (e) { return fail('Не удалось записать исходник: ' + e); }
    // Find any csc.exe shipped with the .NET Framework. Try newest first (v4 on
    // Win8/10/11), then fall back to v3.5 / v2.0 which are built into Windows 7
    // by default. Each machine compiles with its own compiler and runs the result
    // on the matching CLR, so no single version has to be present everywhere.
    var win = process.env['windir'] || 'C:\\Windows';
    var vers = ['v4.0.30319', 'v3.5', 'v2.0.50727'];
    var dirs = ['Framework64', 'Framework'];
    var csc = null;
    for (var vi = 0; vi < vers.length && !csc; vi++) {
        for (var di = 0; di < dirs.length; di++) {
            var cand = win + '\\Microsoft.NET\\' + dirs[di] + '\\' + vers[vi] + '\\csc.exe';
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

module.exports = { consoleaction: consoleaction };
