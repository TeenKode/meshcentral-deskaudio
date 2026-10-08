// Runs INSIDE the real MeshAgent (Duktape, its own Buffer, fs, crypto and
// child_process), not Node:
//   meshagent e2e/agent-duktape.js            (cwd = the repository root)
// expects expect.json (from e2e/agent-duktape-expect.js) in the cwd.
// Checks the agent module behaves as under Node - e.g. MeshAgent prints hashes
// in UPPER-case hex, which once made every helper copy look stale - and runs a
// real capture through MeshAgent's child_process with a fake capture script.
var fs = require('fs');
var fails = 0;
function check(cond, what) { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; }

// The Windows MeshAgent runs scripts from its own folder: files are found via
// DESKAUDIO_ROOT (the repository root) when it is set.
var ROOT = process.env['DESKAUDIO_ROOT'] ? process.env['DESKAUDIO_ROOT'].replace(/[\\\/]+$/, '') + '/' : '';
var module = { exports: {} };
eval(fs.readFileSync(ROOT + 'modules_meshcore/deskaudio.js').toString());
var ag = module.exports;
var exp = JSON.parse(fs.readFileSync(ROOT + 'expect.json').toString());

function signal(n, seed) {
    var b = Buffer.alloc(n * 2), x = seed;
    for (var i = 0; i < n; i++) {
        // 32-bit LCG without Math.imul (not in Duktape's ES5): split the multiply
        var hi = ((x >>> 16) * 1103515245) & 0xFFFF, lo = (x & 0xFFFF) * 1103515245;
        x = ((((hi << 16) >>> 0) + lo + 12345) % 4294967296) >>> 0;
        var v = Math.round(8000 * Math.sin(i / 7) + ((x >>> 16) % 2001) - 1000);
        b.writeInt16LE(v, i * 2);
    }
    return b;
}

// 1) parity with Node
check(ag._sha384(Buffer.from('abc')) === exp.sha.abc, 'sha384 is lower-case hex and matches Node');
check(ag._sha384(signal(640, 1)) === exp.sha.sig, 'sha384 of a buffer matches Node (signal generator agrees too)');
check(ag._sameSha(exp.sha.abc.toUpperCase(), exp.sha.abc), 'hash comparison ignores hex case');
for (var k = 0; k < exp.adpcm.length; k++) {
    var e = exp.adpcm[k];
    check(ag._adpcmEncode(signal(e.n, e.seed)).toString('hex').toLowerCase() === e.hex, 'ADPCM encoding of ' + e.n + ' samples matches Node');
}
check(ag._isSilent(Buffer.alloc(640)) === exp.silentZero && ag._isSilent(signal(640, 1)) === exp.silentSig, 'silence detection matches Node');

// 2) helper files with MeshAgent's fs (Windows-style names are plain names here)
var dir = '/tmp/deskaudio-duktape-' + Date.now();
fs.mkdirSync(dir);
var data = Buffer.from('MZ' + new Array(5000).join('helper'));
var p = ag._dropFile(fs, dir, 'deskaudio-helper.exe', data);
check(p === dir + '\\deskaudio-helper.exe', 'dropFile writes the helper');
check(ag._localHelper(fs, dir, { sha: ag._sha384(data).toUpperCase(), size: data.length }) === p, 'a matching local copy is found (hash in either case)');
check(ag._localHelper(fs, dir, { sha: exp.sha.abc, size: data.length }) === null, 'a different hash is not taken for the helper');

// 3) a real capture through MeshAgent's child_process (Linux path): the fake
//    script emits audio, then silence, then exits.
var sent = [];
var parent = { SendCommand: function (o) { sent.push(JSON.parse(JSON.stringify(o))); } };
var script = 'head -c 3200 /dev/urandom; head -c 6400 /dev/zero; sleep 0.3';
ag.consoleaction({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'start', sid: 9, rate: 16000,
                   compress: true, silence: true, script: Buffer.from(script).toString('base64') }, 0, 0, parent);
// (kept in a variable: MeshAgent cancels timers nobody references)
var finish = setTimeout(function () {
    var started = sent.filter(function (m) { return m.state === 'started'; })[0];
    var chunks = sent.filter(function (m) { return m.pluginaction === 'chunk' && !m.pause; });
    var pauses = sent.filter(function (m) { return m.pause; });
    var end = sent.filter(function (m) { return m.state === 'stopped' || m.state === 'error'; })[0];
    check(started && started.proto === 3 && started.sid === 9, 'the capture started (proto 3, sid 9)');
    check(chunks.length >= 1 && chunks.every(function (c) { return c.sid === 9 && c.codec === 'adpcm' && c.d.length > 0; }), chunks.length + ' ADPCM chunk(s) with the session id');
    check(pauses.length === 1, 'the silence was announced once (' + pauses.length + ')');
    check(end && end.state === 'stopped' && end.sid === 9, 'the helper exit was reported as stopped');
    try { fs.unlinkSync(dir + '\\deskaudio-helper.exe'); fs.rmdirSync(dir); } catch (e) { }
    console.log(fails ? fails + ' FAILURE(S)' : 'ALL OK');
    process.exit(fails ? 1 : 0);
}, 2500);
