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
            decode(ad) {
                decoded.push({ ts: ad.timestamp, frames: ad.numberOfFrames, data: Array.from(ad.data) });
                // simulate the decoder producing output
                const plane = new Float32Array(ad.numberOfFrames);
                for (let i = 0; i < plane.length; i++) plane[i] = (i % 7) / 7 - 0.5;
                handlers.output({ allocationSize: () => plane.length,   // samples, per WebCodecs spec
                                  copyTo: (dst) => { dst.set(plane); },
                                  close: () => {} });
            },
            close() { dec.closed = true; },
            flush() { return Promise.resolve(); }
        };
        return dec;
    };
    global.AudioData = function (init) {
        this.format = init.format;
        this.sampleRate = init.sampleRate;
        this.numberOfFrames = init.numberOfFrames;
        this.numberOfChannels = init.numberOfChannels;
        this.timestamp = init.timestamp;
        this.data = init.data;
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
        assert.strictEqual(decoded[0].frames, 960, "duration parsed from the frame header");
        assert.deepStrictEqual(decoded[0].data, [1, 2, 3], "opus packet bytes forwarded");
        assert.strictEqual(node.port.messages.length, 1, "decoded PCM pushed to the ring");
        assert.strictEqual(node.port.messages[0].s.length, 960);
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
