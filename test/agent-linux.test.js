// Linux-side agent tests. These run only on Linux (the agent's Linux path
// execs /bin/sh and uses message-box/toaster); in CI they run on the ubuntu
// runner, and a Windows dev box skips them (the Windows suite covers the
// win32 path on the windows runner).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const EventEmitter = require("node:events");
const Module = require("node:module");
const cp = require("node:child_process");

const AGENT = path.join(__dirname, "..", "modules_meshcore", "deskaudio.js");
const SCRIPT = Buffer.from("echo capture").toString("base64");

const isLinux = process.platform === "linux";
const { describe } = require("node:test");

describe("agent (Linux)", { skip: !isLinux ? "linux-only: runs on the ubuntu CI runner" : false }, () => {

    function fakeChild() {
        const c = new EventEmitter();
        c.stdout = new EventEmitter();
        c.stderr = new EventEmitter();
        c.killed = false;
        c.kill = () => { c.killed = true; };
        return c;
    }

    // Run `fn` with execFile, setInterval and optional extra modules mocked;
    // fresh agent module per call so closure state does not leak.
    function withAgent(opts, fn) {
        const calls = [];
        const realExec = cp.execFile, realLoad = Module._load, realSI = global.setInterval;
        cp.execFile = (file, args) => { const c = fakeChild(); calls.push({ file, args, child: c }); return c; };
        global.setInterval = () => 1;
        Module._load = function (req) {
            if (opts.modules && Object.prototype.hasOwnProperty.call(opts.modules, req)) return opts.modules[req];
            return realLoad.apply(this, arguments);
        };
        delete require.cache[require.resolve(AGENT)];
        const ag = require(AGENT);
        const sent = [];
        const parent = { SendCommand(o) { sent.push(JSON.parse(JSON.stringify(o))); } };
        const act = (args) => ag.consoleaction(args, 0, 0, parent);
        const restore = () => { cp.execFile = realExec; Module._load = realLoad; global.setInterval = realSI; };
        let r;
        try { r = fn({ ag, act, sent, calls }); }
        catch (e) { restore(); throw e; }
        if (r && typeof r.then === "function") return r.finally(restore);
        restore();
        return r;
    }

    test("the capture script runs inline via sh -c, never from /tmp", () => {
        withAgent({}, ({ act, sent, calls }) => {
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
        withAgent({}, ({ act, sent, calls }) => {
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
        await withAgent({ modules: { "message-box": box } }, async ({ act, sent, calls }) => {
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
        await withAgent({ modules: { "message-box": box } }, async ({ act, sent, calls }) => {
            act({ pluginaction: "start", sid: 1, rate: 16000, script: SCRIPT, consent: { prompt: true, msg: "?" } });
            reject(new Error("denied"));
            await new Promise((r) => setImmediate(r));
            assert.strictEqual(calls.length, 0);
            assert.strictEqual(sent.pop().code, "consent_denied");
        });
    });

    test("consent: without an interactive session, autoAcceptNoUser decides", () => {
        const box = { create: () => { throw new Error("no session"); } };
        withAgent({ modules: { "message-box": box } }, ({ act, sent, calls }) => {
            act({ pluginaction: "start", sid: 1, rate: 16000, script: SCRIPT, consent: { prompt: true, msg: "?" } });
            assert.strictEqual(calls.length, 0);
            assert.strictEqual(sent.pop().code, "consent_denied");
            act({ pluginaction: "start", sid: 2, rate: 16000, script: SCRIPT, consent: { prompt: true, msg: "?", autoAcceptNoUser: true } });
            assert.strictEqual(calls.length, 1);
        });
    });
});
