// Regression test for the browser serialization contract: MeshCentral runs
// every function from obj.exports through toString() in the browser VM, where
// ONLY pluginHandler and browser globals exist - no module closures. This
// suite reproduces that exactly with node:vm: if an exported function
// references a closure helper (the "probeCodecs is not defined" bug), the
// ReferenceError fires here, not on a user's machine.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { loadPlugin } = require("./helpers");

// Serialize `obj` the way MeshCentral's pluginHandler does: each export
// becomes a source string evaluated in a fresh context that has pluginHandler
// and browser stubs. Returns the "browser-side" object.
function serializeToBrowser(obj, browserGlobals) {
    const ctxObj = {};
    const sandbox = Object.assign({
        pluginHandler: { deskaudio: ctxObj },
        console,
        setTimeout: () => 0,
        clearTimeout: () => { },
        localStorage: { getItem: () => null, setItem: () => { } },
        atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
        document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() { } }) },
    }, browserGlobals);
    const ctx = vm.createContext(sandbox);
    for (const name of obj.exports) {
        vm.runInContext(`pluginHandler.deskaudio.${name} = ${obj[name].toString()};`, ctx);
    }
    return ctxObj;
}

// Browser stubs sufficient for start()/onChunk()/onStatus() to run end to end.
// NB: AudioContext must be a CONSTRUCTOR (new-able), and the sampleRate mock
// makes _ensureCtx's rate check pass on the first try.
function browserStubs() {
    function AudioCtx(opts) {
        this.ctorOpts = opts;
        this.sampleRate = (opts && opts.sampleRate) || 48000;
        this.currentTime = 0;
        this.destination = {};
        this.resume = () => { };
        this.close = () => { };
        this.createGain = () => ({ gain: { value: 1 }, connect() { } });
        this.createBuffer = (ch, len, rate) => ({ numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, copyToChannel() { } });
        this.createBufferSource = () => ({ buffer: null, connect() { }, start() { } });
    }
    function WorkletNode() {
        this.port = { messages: [], onmessage: null, postMessage(m, tr) { this.messages.push(m); } };
        this.connect = () => { };
    }
    return {
        window: { AudioContext: AudioCtx },
        AudioContext: AudioCtx,
        AudioWorkletNode: WorkletNode,
        Float32Array, Uint8Array, Blob: class { }, URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => { } },
    };
}

test("serialized exports survive a full click-to-audio cycle", () => {
    const { obj } = loadPlugin();
    const br = serializeToBrowser(obj, browserStubs());

    // The UI wiring MeshCentral provides:
    const sent = [];
    const meshserver = { send: (m) => sent.push(m) };
    const QH = () => { };

    // 1) onDeviceRefreshEnd builds the tab (needs QH, document, pluginHandler)
    vm.createContext({});   // (sanity: not needed here)

    // 2) start() - the exact path that used to throw "probeCodecs is not defined"
    br._s = { };
    const savedS = br._s;
    // start() reads globals: currentNode, meshserver, localStorage, document, window...
    // In the real browser these exist; emulate by evaluating in the same context.
    // Simplest: call through with the sandbox present - we expose them via _s hacking
    // is wrong; instead run start inside a context that has them.
    // (serializeToBrowser already gave the ctx those globals through sandbox;
    //  we re-run the serialized function with this-scope via call())
    const ctxGlobals = { meshserver, currentNode: { _id: "node//pc1" } };
    Object.assign(br._s, {});
    // brute: temporarily attach needed globals to the sandbox object we kept
    // The functions were compiled in `ctx`, so they see the sandbox. We need
    // meshserver/currentNode IN the sandbox. Rebuild:
    const stubs = browserStubs();
    const ctxObj = {};
    const sandbox = Object.assign({
        pluginHandler: { deskaudio: ctxObj },
        console,
        setTimeout: () => 0,
        clearTimeout: () => { },
        localStorage: { getItem: () => null, setItem: () => { } },
        atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
        document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() { } }) },
        meshserver: { send: (m) => sent.push(m) },
        currentNode: { _id: "node//pc1" },
    }, stubs);
    const ctx = vm.createContext(sandbox);
    for (const name of obj.exports) {
        vm.runInContext(`pluginHandler.deskaudio.${name} = ${obj[name].toString()};`, ctx);
    }
    // set AudioWorkletNode inside sandbox too (already in stubs)

    // The click:
    ctxObj.start();
    assert.strictEqual(sent.length, 1, "start message went out");
    assert.ok(sent[0].codecs && sent[0].codecs.indexOf("adpcm") >= 0, "codec list attached");

    // 3) onStatus(started)
    ctxObj.onStatus({ nodeid: "node//pc1", state: "started", rate: 16000, codec: "adpcm" });
    assert.strictEqual(ctxObj._s.statusText.indexOf("Идёт передача") === 0, true, "status text shown");

    // 4) onChunk (ADPCM path) - must reach the worklet/scheduler without closures
    const pcm = Buffer.alloc(64);
    pcm.writeInt16LE(1000, 0);
    let threw = null;
    try {
        ctxObj.onChunk({ nodeid: "node//pc1", rate: 16000, d: pcm.toString("base64") });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, "onChunk ran without a ReferenceError: " + (threw && threw.message));
    assert.strictEqual(ctxObj._s.gotAudio, true, "audio was decoded and accepted");

    // 5) stop()
    ctxObj.stop();
    assert.strictEqual(sent.length, 2, "stop message went out");
    assert.strictEqual(ctxObj._s.active, false);
});

test("no exported function references a bare module-level helper", () => {
    // Static check: every name used in exported bodies must resolve inside
    // the sandbox. We approximate by scanning for the known helper names that
    // must be called via pluginHandler.deskaudio.X.
    const { obj } = loadPlugin();
    const stripComments = (code) => code
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
    const forbidden = ["probeCodecs(", "_ensureCtx(", "_ensureOpusDecoder(", "_pushDecoded(", "_opusChunk(", "WORKLET_SRC", "ringPull("];
    for (const name of obj.exports) {
        const body = stripComments(obj[name].toString());
        // calls written as " foo(" not preceded by "deskaudio." or "function foo"
        for (const helper of forbidden) {
            const bare = new RegExp("(^|[^.\\w])" + helper.replace("(", ""), "g");
            // find occurrences not part of "deskaudio.helper"
            let m;
            while ((m = bare.exec(body)) !== null) {
                const before = body.slice(Math.max(0, m.index - 12), m.index).replace(/\s+/g, " ");
                assert.ok(/deskaudio\.$/.test(before.trim()) === false || /deskaudio\.$/.test(before.trim()),
                    `${name} references bare ${helper} at ...${before}`);
                if (!/deskaudio\.?\s*$/.test(before.trim())) {
                    assert.fail(`${name}: bare reference to ${helper} (context: "...${before}") - closures do not exist in the browser VM`);
                }
            }
        }
    }
});
