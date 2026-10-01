// Tests for pure helpers in the agent-side module (modules_meshcore/deskaudio.js).
// The module only require()s MeshAgent/child_process inside functions, so it loads
// fine under plain Node for unit testing.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const agent = require(path.join(__dirname, "..", "modules_meshcore", "deskaudio.js"));

test("_isSilent detects silence vs. sound in s16le PCM", () => {
    assert.strictEqual(typeof agent._isSilent, "function");

    assert.strictEqual(agent._isSilent(Buffer.alloc(0)), true, "empty buffer is silent");
    assert.strictEqual(agent._isSilent(Buffer.alloc(640)), true, "all-zero buffer is silent");

    // Only pure digital silence is suppressed now: any non-zero sample is audio,
    // so quiet real audio is never dropped.
    const quiet = Buffer.alloc(640);
    quiet.writeInt16LE(3, 10);
    assert.strictEqual(agent._isSilent(quiet), false, "a tiny non-zero sample is not silence");

    // A single loud sample makes the whole buffer non-silent.
    const loud = Buffer.alloc(640);
    loud.writeInt16LE(5000, 200);
    assert.strictEqual(agent._isSilent(loud), false, "a loud sample is not silent");

    // Negative samples are handled too.
    const neg = Buffer.alloc(640);
    neg.writeInt16LE(-3000, 100);
    assert.strictEqual(agent._isSilent(neg), false, "a loud negative sample is not silent");
});

test("IMA ADPCM roundtrip: encode (agent) -> decode (browser) reconstructs audio", () => {
    assert.strictEqual(typeof agent._adpcmEncode, "function");
    const srv = require(path.join(__dirname, "..", "deskaudio.js")).deskaudio({ parent: { webserver: {} } });
    assert.strictEqual(typeof srv._adpcmDecode, "function");

    const N = 320;                      // ~20 ms at 16 kHz
    const pcm = Buffer.alloc(N * 2);
    for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * i / 32)), i * 2);

    const enc = agent._adpcmEncode(pcm);
    assert.strictEqual(enc.length, 4 + (N >> 1), "compressed size is header + nibbles (~4:1)");
    assert.ok(enc.length * 4 <= pcm.length + 16, "about 4x smaller than PCM");

    let bin = "";
    for (const byte of enc) bin += String.fromCharCode(byte);
    const f = srv._adpcmDecode(bin);

    assert.strictEqual(f.length, N, "decoded sample count matches");
    assert.strictEqual(Math.round(f[0] * 32768), 0, "first sample is exact (header predictor)");

    let err = 0, sig = 0;
    for (let i = 0; i < N; i++) {
        const orig = pcm.readInt16LE(i * 2);
        err += Math.abs(f[i] * 32768 - orig);
        sig += Math.abs(orig);
    }
    err /= N; sig /= N;
    assert.ok(err > 0, "codec is lossy (not a passthrough)");
    assert.ok(err < sig * 0.1, "mean error is well under 10% of the signal (" + err.toFixed(0) + " vs " + sig.toFixed(0) + ")");
});

// ---------- capture lifecycle (child_process / message-box mocked) ----------

const EventEmitter = require("node:events");
const Module = require("node:module");
const cp = require("node:child_process");

function fakeChild() {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; };
    return c;
}

// Run `fn` with execFile, setInterval and optional extra modules mocked; fresh
// agent module per call so its closure state does not leak between tests.
//
// opts.platform pins process.platform for the duration of the test. The agent
// branches on it to pick a capture backend, which would otherwise make the Linux
// tests pass in CI (Ubuntu) and fail on a Windows dev box. When we shadow it we
// keep process.execPath reachable, because agentDir() derives the helper folder
// from it and a shadowed object would hide that property.
function withAgent(opts, fn) {
    const calls = [];
    const realExec = cp.execFile, realLoad = Module._load, realSI = global.setInterval;
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const realExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
    const pinPlatform = !!opts.platform;
    if (pinPlatform) {
        Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });
        if (realExecPath) Object.defineProperty(process, "execPath", { value: realExecPath.value, configurable: true });
    }
    cp.execFile = (file, args) => { const c = fakeChild(); calls.push({ file, args, child: c }); return c; };
    global.setInterval = () => 1;
    Module._load = function (req) {
        if (opts.modules && Object.prototype.hasOwnProperty.call(opts.modules, req)) return opts.modules[req];
        return realLoad.apply(this, arguments);
    };
    const modPath = path.join(__dirname, "..", "modules_meshcore", "deskaudio.js");
    delete require.cache[require.resolve(modPath)];
    const ag = require(modPath);
    const sent = [];
    const parent = { SendCommand(o) { sent.push(JSON.parse(JSON.stringify(o))); } };
    const act = (args) => ag.consoleaction(args, 0, 0, parent);
    const restore = () => {
        cp.execFile = realExec; Module._load = realLoad; global.setInterval = realSI;
        if (pinPlatform) {
            Object.defineProperty(process, "platform", realPlatform);
            if (realExecPath) Object.defineProperty(process, "execPath", realExecPath);
        }
    };
    let r;
    try { r = fn({ ag, act, sent, calls }); }
    catch (e) { restore(); throw e; }
    if (r && typeof r.then === "function") return r.finally(restore);
    restore();
    return r;
}

const SCRIPT = Buffer.from("echo capture").toString("base64");

test("Linux: the capture script runs inline via sh -c, never from /tmp", () => {
    withAgent({ platform: "linux" }, ({ act, sent, calls }) => {
        act({ pluginaction: "start", sid: 7, rate: 24000, script: SCRIPT });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].file, "/bin/sh");
        assert.deepStrictEqual(calls[0].args, ["sh", "-c", "echo capture", "deskaudio", "24000"]);
        const st = sent.find((m) => m.pluginaction === "status");
        assert.strictEqual(st.state, "started");
        assert.strictEqual(st.sid, 7);
        assert.strictEqual(st.proto, 2);
    });
});

test("chunks carry the session id; a stop for another session is ignored", () => {
    withAgent({ platform: "linux" }, ({ act, sent, calls }) => {
        act({ pluginaction: "start", sid: 3, rate: 16000, compress: false, script: SCRIPT });
        const pcm = Buffer.alloc(64); pcm.writeInt16LE(1000, 0);
        calls[0].child.stdout.emit("data", pcm);
        const chunk = sent.find((m) => m.pluginaction === "chunk");
        assert.strictEqual(chunk.sid, 3);

        act({ pluginaction: "stop", sid: 2 });
        assert.strictEqual(calls[0].child.killed, false, "stale stop ignored");
        act({ pluginaction: "stop", sid: 3 });
        assert.strictEqual(calls[0].child.killed, true, "matching stop ends the capture");
        const st = sent.filter((m) => m.pluginaction === "status").pop();
        assert.strictEqual(st.state, "stopped");
        assert.strictEqual(st.sid, 3);
    });
});

test("consent: capture starts only after the local user accepts", async () => {
    let resolve;
    const box = { create: () => new Promise((res) => { resolve = res; }) };
    await withAgent({ platform: "linux", modules: { "message-box": box } }, async ({ act, sent, calls }) => {
        act({ pluginaction: "start", sid: 1, rate: 16000, script: SCRIPT, consent: { prompt: true, msg: "?", timeout: 20 } });
        assert.strictEqual(calls.length, 0, "nothing captured while waiting");
        const w = sent.find((m) => m.state === "waiting");
        assert.ok(w && w.timeout === 20 && w.sid === 1);
        resolve();
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(calls.length, 1, "capture started after consent");
    });
});

test("consent: a refusal reports consent_denied and captures nothing", async () => {
    let reject;
    const box = { create: () => new Promise((res, rej) => { reject = rej; }) };
    await withAgent({ platform: "linux", modules: { "message-box": box } }, async ({ act, sent, calls }) => {
        act({ pluginaction: "start", sid: 1, rate: 16000, script: SCRIPT, consent: { prompt: true, msg: "?" } });
        reject(new Error("denied"));
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(sent.pop().code, "consent_denied");
    });
});

test("consent: without an interactive session, autoAcceptNoUser decides", () => {
    const box = { create: () => { throw new Error("no session"); } };
    withAgent({ platform: "linux", modules: { "message-box": box } }, ({ act, sent, calls }) => {
        act({ pluginaction: "start", sid: 1, rate: 16000, script: SCRIPT, consent: { prompt: true, msg: "?" } });
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(sent.pop().code, "consent_denied");
        act({ pluginaction: "start", sid: 2, rate: 16000, script: SCRIPT, consent: { prompt: true, msg: "?", autoAcceptNoUser: true } });
        assert.strictEqual(calls.length, 1);
    });
});

test("dropFile writes the helper, reuses an identical file, replaces a planted one", () => {
    const files = {};
    const fsMock = {
        readFileSync(p) { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
        writeFileSync(p, d) { if (fsMock.locked) throw new Error("EBUSY"); files[p] = Buffer.from(d); fsMock.writes++; },
        writes: 0, locked: false
    };
    const data = Buffer.from("MZ real helper");
    const p = agent._dropFile(fsMock, "C:\\Agent", "h.exe", data);
    assert.strictEqual(p, "C:\\Agent\\h.exe");
    assert.strictEqual(fsMock.writes, 1);

    assert.strictEqual(agent._dropFile(fsMock, "C:\\Agent", "h.exe", data), p);
    assert.strictEqual(fsMock.writes, 1, "identical file is not rewritten");

    files[p] = Buffer.from("MZ planted!!!!");     // same length, different bytes
    assert.strictEqual(agent._dropFile(fsMock, "C:\\Agent", "h.exe", data), p);
    assert.ok(files[p].equals(data), "planted file replaced");

    files[p] = Buffer.from("MZ planted");
    fsMock.locked = true;
    assert.strictEqual(agent._dropFile(fsMock, "C:\\Agent", "h.exe", data), null, "unwritable mismatching file is never used");
});
