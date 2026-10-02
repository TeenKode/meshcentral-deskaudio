// Tests for the browser-side Opus decode path (WebCodecs AudioDecoder mocked):
// frame parsing ([dur:2 LE][opus packet]), decoder lifecycle, and the
// decoded-PCM handoff into the worklet ring buffer.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./helpers");

// Local mini-mocks (same shape as browser-onchunk.test.js, kept private per
// test file so suites stay independent).
function makeCtx() {
    const ctx = {
        currentTime: 0,
        lastBuffer: null,
        lastSource: null,
        createGain() { return { gain: { value: 1 }, connect() {} }; },
        resume() {}, close() {},
        createBuffer(channels, length, rate) {
            const b = { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, data: null,
                copyToChannel(f) { this.data = Float32Array.from(f); } };
            ctx.lastBuffer = b;
            return b;
        },
        createBufferSource() {
            const s = { buffer: null, startedAt: null, connect() {}, start(t) { this.startedAt = t; } };
            ctx.lastSource = s;
            return s;
        }
    };
    return ctx;
}

function withBrowser(obj, state, fn) {
    const saved = {
        atob: global.atob, document: global.document, pluginHandler: global.pluginHandler,
        window: global.window, AudioContext: global.AudioContext, AudioWorkletNode: global.AudioWorkletNode
    };
    global.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
    global.document = { getElementById() { return null; } };
    global.pluginHandler = { deskaudio: obj };
    global.window = { AudioContext: null };
    if (state.ctx) global.window.AudioContext = function (opts) { state.ctx.ctorOpts = opts; return state.ctx; };
    obj._s = state;
    try { return fn(); } finally { Object.assign(global, saved); }
}

test("an opus chunk is parsed, decoded, and pushed into the worklet", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    ctx.sampleRate = 48000;

    // Mock WebCodecs: AudioDecoder collects chunks; the first decode()
    // synchronously emits one 960-sample f32 plane.
    const decoded = [];
    global.AudioDecoder = function (handlers) {
        const dec = {
            closed: false,
            state: "unconfigured",
            configure(cfg) { dec.cfg = cfg; dec.state = "configured"; },
            decode(chunk) {
                decoded.push({ ts: chunk.timestamp, bytes: Array.from(new Uint8Array(chunk.data instanceof ArrayBuffer ? new Uint8Array(chunk.data) : chunk.data)) });
                // simulate the decoder producing output: 960-sample f32 plane
                const plane = new Float32Array(960);
                for (let i = 0; i < plane.length; i++) plane[i] = (i % 7) / 7 - 0.5;
                // Per the WebCodecs spec allocationSize() is in BYTES; the
                // sample count is numberOfFrames.
                handlers.output({ numberOfFrames: plane.length, numberOfChannels: 1, sampleRate: 48000,
                                  allocationSize: () => plane.length * 4,
                                  copyTo: (dst) => { if (dst.length < plane.length) throw new RangeError("too small"); dst.set(plane); },
                                  close: () => {} });
            },
            close() { dec.closed = true; },
            flush() { return Promise.resolve(); }
        };
        return dec;
    };
    global.EncodedAudioChunk = function (init) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration;
        this.data = init.data.buffer ? init.data.buffer : init.data;
    };

    const node = { port: { messages: [], onmessage: null, postMessage(m, tr) { this.messages.push(m); } }, connect() {} };
    try {
        const state = { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0,
                        node, workletReady: true, ctxSet: true };
        withBrowser(obj, state, () => {
            // payload: dur=960 (LE) + opus packet bytes 01 02 03
            const payload = Buffer.from([0xC0, 0x03, 0x01, 0x02, 0x03]);   // dur=960 LE + packet
            obj.onChunk({ nodeid: "node//pc1", rate: 16000, codec: "opus", d: payload.toString("base64") });
        });
        assert.strictEqual(decoded.length, 1, "one packet was decoded");
        assert.deepStrictEqual(decoded[0].bytes, [1, 2, 3], "opus packet bytes forwarded");
        assert.strictEqual(decoded[0].ts, 0, "first chunk timestamps at 0");
        assert.strictEqual(node.port.messages.length, 1, "decoded PCM pushed to the ring");
        assert.strictEqual(node.port.messages[0].s.length, 960, "exactly one 20 ms frame - no zero padding");
        assert.strictEqual(node.port.messages[0].rate, 48000);
    } finally {
        delete global.AudioDecoder;
        delete global.AudioData;
    }
});

test("a too-short opus chunk is ignored without touching the decoder", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    let constructed = 0;
    global.AudioDecoder = function (handlers) {
        constructed++;
        return { configure() {}, decode() { throw new Error("should not be called"); }, close() {} };
    };
    try {
        const state = { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0, workletReady: false };
        withBrowser(obj, state, () => {
            obj.onChunk({ nodeid: "node//pc1", rate: 16000, codec: "opus", d: Buffer.from([0x80]).toString("base64") });   // 1 byte: no dur
        });
        assert.strictEqual(constructed, 1, "decoder was created (ensure path) but not fed");
    } finally { delete global.AudioDecoder; }
});

test("start advertises codecs from the saved preference", () => {
    const { obj } = loadPlugin();
    // Advertise probe: no AudioDecoder global -> adpcm/pcm only.
    const sent = [];
    const saved = { pluginHandler: global.pluginHandler, meshserver: global.meshserver,
                    document: global.document, localStorage: global.localStorage,
                    currentNode: global.currentNode, setTimeout: global.setTimeout };
    global.pluginHandler = { deskaudio: obj };
    global.meshserver = { send: (m) => sent.push(m) };
    global.document = { getElementById: (id) => (id === "da_vol" ? { value: 80 } : null) };
    global.localStorage = { getItem: (k) => (k === "deskaudio_codec" ? "adpcm" : null), setItem() {} };
    global.currentNode = { _id: "node//pc1" };
    global.setTimeout = (cb) => { return 0; };
    const AC = function () { return makeCtx(); };
    const savedAC = global.AudioContext, savedWindow = global.window;
    global.AudioContext = AC;
    global.window = { AudioContext: AC };
    try {
        obj.start();
        assert.strictEqual(sent.length, 1, "one start message");
        assert.deepStrictEqual(sent[0].codecs, ["adpcm"], "forced adpcm from the preference");
    } finally {
        global.pluginHandler = saved.pluginHandler; global.meshserver = saved.meshserver;
        global.document = saved.document; global.localStorage = saved.localStorage;
        global.currentNode = saved.currentNode; global.setTimeout = saved.setTimeout;
        global.AudioContext = savedAC; global.window = savedWindow;
    }
});

function withStartGlobals(storage, extra, fn) {
    const names = ["pluginHandler", "meshserver", "document", "localStorage", "currentNode", "setTimeout", "window", "AudioDecoder", "EncodedAudioChunk"];
    const saved = {}; names.forEach((n) => { saved[n] = global[n]; });
    const sent = [];
    global.meshserver = { send: (m) => sent.push(m) };
    global.document = { getElementById: () => null };
    global.localStorage = { getItem: (k) => (k in storage ? storage[k] : null), setItem() {} };
    global.currentNode = { _id: "node//pc1" };
    global.setTimeout = () => 0;
    const ctxs = [];
    global.window = { AudioContext: function (opts) { const c = makeCtx(); c.opts = opts; ctxs.push(c); return c; } };
    Object.assign(global, extra);
    const restore = () => names.forEach((n) => { if (saved[n] === undefined) delete global[n]; else global[n] = saved[n]; });
    let r;
    try { r = fn(sent, ctxs); } catch (e) { restore(); throw e; }
    if (r && typeof r.then === "function") return r.finally(restore);
    restore();
    return r;
}

test("choosing PCM sends compress=false and creates the context inside the click", () => {
    const { obj } = loadPlugin();
    global.pluginHandler = { deskaudio: obj };
    withStartGlobals({ deskaudio_codec: "pcm", deskaudio_rate: "24000" }, {}, (sent, ctxs) => {
        global.pluginHandler = { deskaudio: obj };
        obj.render = () => {};
        obj.start();
        assert.deepStrictEqual(sent[0].codecs, ["pcm"]);
        assert.strictEqual(sent[0].compress, false);
        assert.strictEqual(ctxs.length, 1, "AudioContext created synchronously (Safari user-gesture rule)");
        assert.deepStrictEqual(ctxs[0].opts, { sampleRate: 24000 });
    });
});

test("forcing Opus in a browser without WebCodecs fails fast, nothing is started", () => {
    const { obj } = loadPlugin();
    withStartGlobals({ deskaudio_codec: "opus" }, {}, (sent) => {
        global.pluginHandler = { deskaudio: obj };
        obj.render = () => {};
        delete global.AudioDecoder; delete global.EncodedAudioChunk;
        obj.start();
        assert.strictEqual(sent.length, 0);
        assert.match(obj._s.statusText, /Opus/);
        assert.ok(!obj._s.active);
    });
});

test("auto mode waits for the Opus probe and then advertises opus", async () => {
    const { obj } = loadPlugin();
    let resolveProbe;
    const AD = function () {};
    AD.isConfigSupported = () => new Promise((r) => { resolveProbe = r; });
    await withStartGlobals({}, { AudioDecoder: AD, EncodedAudioChunk: function () {} }, async (sent, ctxs) => {
        global.pluginHandler = { deskaudio: obj };
        obj.render = () => {};
        obj.start();
        assert.strictEqual(sent.length, 0, "start waits for the probe");
        assert.deepStrictEqual(ctxs[0].opts, { sampleRate: 48000 }, "context opened for Opus");
        resolveProbe({ supported: true });
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(sent[0].codecs, ["opus", "adpcm", "pcm"]);
    });
});

test("an opus2 chunk carries several packets", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    const decoded = [];
    global.AudioDecoder = function (h) {
        return { state: "configured", configure() {}, close() {},
                 decode(c) { decoded.push({ ts: c.timestamp, n: c.data.byteLength || c.data.length }); } };
    };
    global.EncodedAudioChunk = function (init) { this.timestamp = init.timestamp; this.data = init.data; };
    try {
        const state = { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0 };
        withBrowser(obj, state, () => {
            const rec = (len) => Buffer.concat([Buffer.from([0xC0, 0x03, len, 0]), Buffer.alloc(len, 7)]);
            obj.onChunk({ nodeid: "node//pc1", rate: 16000, codec: "opus2", d: Buffer.concat([rec(3), rec(5)]).toString("base64") });
        });
        assert.deepStrictEqual(decoded, [{ ts: 0, n: 3 }, { ts: 20000, n: 5 }], "two packets, 20 ms apart");
    } finally { delete global.AudioDecoder; delete global.EncodedAudioChunk; }
});
