// Runs INSIDE the real Windows MeshAgent (MeshService64.exe e2e/agent-windows.js,
// cwd = the repository root, expect.json from e2e/agent-duktape-expect.js):
// the helper delivery exactly as in the field, with this script playing the
// server.
//  1. start with only the helper's identity (protocol 3): no local copy, so
//     the agent asks for it ('need'), verifies the bytes, drops them into its
//     folder and starts the helper through MeshAgent's child_process;
//  2. start again: the local copy is found ("up to date"), nothing downloaded;
//  3. a corrupted download is refused (helper_corrupt).
// With EXPECT_AUDIO (a Windows runner with a virtual sound card playing a
// tone) step 1 must deliver audio chunks; under Wine (no loopback capture)
// the helper must end with its WASAPI error instead.
var fs = require('fs');
var fails = 0;
// Timers whose exceptions end the test visibly (an exception in a plain
// MeshAgent timer callback is swallowed and the process just stays up). NB:
// MeshAgent garbage-collects - and so cancels - a timer nobody references,
// hence the TIMERS array.
var TIMERS = [];
function later(fn, ms) {
    TIMERS.push(setTimeout(function () {
        try { fn(); } catch (e) {
            if (String(e).indexOf('Process.exit') >= 0) throw e;      // process.exit() itself
            console.log('EXCEPTION ' + e + (e && e.stack ? '\n' + e.stack : '')); process.exit(2);
        }
    }, ms));
}
later(function () { console.log('TIMEOUT'); process.exit(3); }, 60000);
function check(cond, what) { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; }
// The Windows MeshAgent runs scripts from its own folder: files are found via
// DESKAUDIO_ROOT (the repository root) when it is set.
var ROOT = process.env['DESKAUDIO_ROOT'] ? process.env['DESKAUDIO_ROOT'].replace(/[\\\/]+$/, '') + '/' : '';
var module = { exports: {} };
eval(fs.readFileSync(ROOT + 'modules_meshcore/deskaudio.js').toString());
var ag = module.exports;
var exp = JSON.parse(fs.readFileSync(ROOT + 'expect.json').toString());

var dir = process.execPath.substring(0, process.execPath.lastIndexOf('\\'));
var names = ['deskaudio-helper.exe', 'deskaudio-helper-b.exe'];
function clean() {
    for (var i = 0; i < names.length; i++) {
        var p = dir + '\\' + names[i];
        try { fs.unlinkSync(p); } catch (e) { }
        var still = false; try { fs.readFileSync(p); still = true; } catch (e) { }
        if (still) console.log('  note: could not delete ' + p);
    }
}
var arch = (process.env['PROCESSOR_ARCHITEW6432'] || process.env['PROCESSOR_ARCHITECTURE']) == 'AMD64' ? 'x64' : 'x86';
var bytes = fs.readFileSync(ROOT + exp.helper[arch].file);

var sent = [], corrupt = false;
var parent = { SendCommand: function (o) {
    var m = JSON.parse(JSON.stringify(o));
    sent.push(m);
    if (m.pluginaction === 'need') {        // play the server: answer with the helper
        var data = bytes;
        // (a copy via base64: MeshAgent's Buffer.from(<Buffer>) returns an EMPTY buffer)
        if (corrupt) { data = Buffer.from(bytes.toString('base64'), 'base64'); data[100] ^= 0xFF; }
        later(function () { ag.consoleaction({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'helper', sid: m.sid, arch: m.arch, data: data.toString('base64') }, 0, 0, parent); }, 50);
    }
} };
function start(sid) {
    ag.consoleaction({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'start', sid: sid, rate: 16000, compress: false, silence: false,
                       helper: { x64: exp.helper.x64, x86: exp.helper.x86 } }, 0, 0, parent);
}
function stop(sid) { ag.consoleaction({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'stop', sid: sid }, 0, 0, parent); }
function of(sid, f) { return sent.filter(function (m) { return m.sid === sid && f(m); }); }
function logs(sid) { return of(sid, function (m) { return m.pluginaction === 'log'; }).map(function (m) { return m.msg; }); }

clean();
start(1);
later(function () {
    console.log('  agent log: ' + logs(1).join(' | '));
    check(of(1, function (m) { return m.pluginaction === 'need'; }).length === 1 && of(1, function (m) { return m.pluginaction === 'need'; })[0].arch === arch,
          'no local copy: the ' + arch + ' helper was requested once');
    check(logs(1).some(function (l) { return /downloaded/.test(l); }), 'the download was verified and the helper started');
    var errs = of(1, function (m) { return m.state === 'error'; });
    if (exp.expectAudio) {
        var chunks = of(1, function (m) { return m.pluginaction === 'chunk' && !m.pause; });
        check(chunks.length > 20, chunks.length + ' audio chunks from the real capture');
        check(errs.length === 0, 'no error' + (errs.length ? ': ' + JSON.stringify(errs[0]) : ''));
    } else {
        check(errs.length === 1 && errs[0].code === 'helper_failed' && /audio device unavailable/.test(errs[0].msg),
              'no loopback device here: the helper ended with its WASAPI error (' + (errs[0] ? errs[0].msg.replace(/\s+$/, '') : 'none') + ')');
    }
    check(of(1, function (m) { return m.code === 'helper_corrupt'; }).length === 0, 'the hash check accepted the genuine helper');
    stop(1);
    later(function () {
        start(2);
        later(function () {
            console.log('  agent log: ' + logs(2).join(' | '));
            check(of(2, function (m) { return m.pluginaction === 'need'; }).length === 0, 'second start: nothing downloaded');
            check(logs(2).some(function (l) { return /up to date/.test(l); }), 'second start: the local copy was used');
            stop(2);
            later(function () {
                clean(); corrupt = true;
                start(3);
                later(function () {
                    console.log('  agent log: ' + logs(3).join(' | '));
                    var bad = of(3, function (m) { return m.code === 'helper_corrupt'; });
                    check(bad.length === 1, 'a corrupted download is refused (' + (bad[0] ? bad[0].msg : 'none') + ')');
                    check(of(3, function (m) { return m.state === 'started'; }).length === 0, 'and nothing is started from it');
                    clean();
                    console.log(fails ? fails + ' FAILURE(S)' : 'ALL OK');
                    process.exit(fails ? 1 : 0);
                }, 1500);
            }, 1500);
        }, exp.expectAudio ? 3000 : 6000);
    }, 1500);
}, exp.expectAudio ? 4000 : 6000);
