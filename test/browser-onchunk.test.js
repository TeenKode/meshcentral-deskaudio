// Tests for the browser-side PCM decoder (obj.onChunk). This function runs in
// the MeshCentral web UI; here we grab it off the plugin instance and feed it a
// crafted base64 s16le payload with a mock Web Audio context, to pin down the
// little-endian signed conversion and the jitter/drop logic.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./helpers");

// Build a base64 string of signed 16-bit little-endian samples.
function pcmBase64(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
    return buf.toString("base64");
}

// A Web Audio context mock that records the buffer and source it produces.
function makeCtx() {
    const ctx = {
        currentTime: 0,
        lastBuffer: null,
        lastSource: null,
        createGain() { return { gain: { value: 1 }, connect() {} }; },
        resume() {},
        close() {},
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

// Install the browser globals the exported handlers expect, run `fn`, restore.
function withBrowser(obj, state, fn) {
    const saved = {
        atob: global.atob, document: global.document, pluginHandler: global.pluginHandler,
        window: global.window, AudioContext: global.AudioContext, AudioWorkletNode: global.AudioWorkletNode
    };
    global.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
    global.document = { getElementById() { return null; } };
    global.pluginHandler = { deskaudio: obj };
    // _ensureCtx reads window.AudioContext; default: a constructor that hands
    // out the state's ctx. Individual tests override state.AC or state.ctx.
    global.window = { AudioContext: null };
    if (state.AC) global.window.AudioContext = state.AC;
    else if (state.ctx) global.window.AudioContext = function (opts) { state.ctx.ctorOpts = opts; return state.ctx; };
    // Node has Blob/URL: the worklet branch runs against the mocked
    // ctx.audioWorklet (each test's mock) exactly as in the browser.
    obj._s = state;
    try { return fn(); } finally { Object.assign(global, saved); }
}

test("decodes little-endian signed PCM into normalized floats", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    const samples = [0, 32767, -32768, 16384, -16384];
    withBrowser(obj, { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0 }, () => {
        obj.onChunk({ nodeid: "node//pc1", rate: 16000, d: pcmBase64(samples) });
    });

    assert.ok(ctx.lastBuffer, "a buffer was produced");
    assert.strictEqual(ctx.lastBuffer.length, samples.length);
    assert.strictEqual(ctx.lastBuffer.sampleRate, 16000);
    const out = ctx.lastBuffer.data;
    const expected = samples.map((v) => v / 32768);
    for (let i = 0; i < samples.length; i++) {
        assert.ok(Math.abs(out[i] - expected[i]) < 1e-6, `sample ${i}: ${out[i]} vs ${expected[i]}`);
    }
    assert.notStrictEqual(ctx.lastSource.startedAt, null, "playback was scheduled");
});

test("a chunk that is too far behind real time is dropped", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    ctx.currentTime = 0;
    // next is 1.0s ahead of now (>0.6s), so this chunk should be discarded.
    withBrowser(obj, { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 1.0 }, () => {
        obj.onChunk({ nodeid: "node//pc1", rate: 16000, d: pcmBase64([1, 2, 3, 4]) });
    });
    assert.strictEqual(ctx.lastBuffer, null, "no buffer created for a late chunk");
});

test("an empty payload produces no buffer", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    withBrowser(obj, { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0 }, () => {
        obj.onChunk({ nodeid: "node//pc1", rate: 16000, d: "" });
    });
    assert.strictEqual(ctx.lastBuffer, null);
});

test("a chunk for a different node is ignored", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    withBrowser(obj, { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0 }, () => {
        obj.onChunk({ nodeid: "node//other", rate: 16000, d: pcmBase64([1, 2, 3, 4]) });
    });
    assert.strictEqual(ctx.lastBuffer, null);
});

test("chunks are ignored while inactive", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    withBrowser(obj, { active: false, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0 }, () => {
        obj.onChunk({ nodeid: "node//pc1", rate: 16000, d: pcmBase64([1, 2, 3, 4]) });
    });
    assert.strictEqual(ctx.lastBuffer, null);
});

test("the playback cursor advances by the buffer duration", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    const state = { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0 };
    const samples = new Array(1600).fill(0);     // 0.1 s at 16 kHz
    withBrowser(obj, state, () => {
        obj.onChunk({ nodeid: "node//pc1", rate: 16000, d: pcmBase64(samples) });
    });
    // First chunk primes a ~150 ms jitter buffer, then adds the clip duration.
    assert.ok(Math.abs(state.next - (0.15 + 0.1)) < 1e-6, "next cursor = jitter + duration, got " + state.next);
});

// ---------- AudioWorklet path (mocked) ----------

// A context whose audioWorklet.addModule resolves and hands back a node.
function makeWorkletCtx(rate) {
    const ctx = makeCtx();
    ctx.sampleRate = rate || 16000;
    ctx.audioWorklet = {
        addModule(url) {
            ctx.moduleUrl = url;
            return Promise.resolve();
        }
    };
    ctx.createdNodes = [];
    ctx.currentTime = 0;
    return ctx;
}

test("the AudioContext is created at the agent's rate on the first chunk", () => {
    const { obj } = loadPlugin();
    const ctx = makeWorkletCtx(24000);   // honors the requested rate
    const AC = function (opts) { ctx.ctorOpts = opts; return ctx; };
    // NB: the AudioWorkletNode constructor must exist for the async module
    // load callback, even though this test does not await it.
    global.AudioWorkletNode = function () { return { port: { postMessage() {} }, connect() {} }; };
    try {
        withBrowser(obj, { active: true, AC, gain: { connect() {} }, nodeid: "node//pc1", next: 0 }, () => {
            obj.onChunk({ nodeid: "node//pc1", rate: 24000, d: pcmBase64([1, 2, 3, 4]) });
        });
    } finally { delete global.AudioWorkletNode; }
    assert.deepStrictEqual(ctx.ctorOpts, { sampleRate: 24000 });
});

test("a rate the context cannot honor falls back to the default context", () => {
    const { obj } = loadPlugin();
    const ctx = makeWorkletCtx(48000);       // hardware clamps: we get 48k back
    let asked = 0, fallback = 0;
    const AC = function (opts) {
        if (opts && opts.sampleRate === 24000) { asked++; return ctx; }
        if (!opts) { fallback++; return ctx; }   // the fallback constructor
        throw new Error("unexpected");
    };
    withBrowser(obj, { active: true, AC, gain: { connect() {} }, nodeid: "node//pc1", next: 0 }, () => {
        obj.onChunk({ nodeid: "node//pc1", rate: 24000, d: pcmBase64([1, 2, 3, 4]) });
    });
    assert.strictEqual(asked, 1, "the preferred rate was requested first");
    assert.strictEqual(fallback, 1, "the default context was used as the fallback");
});

test("audio decoded while the worklet module loads is flushed into it", async () => {
    const { obj } = loadPlugin();
    const ctx = makeWorkletCtx(16000);
    let node = null;
    global.AudioWorkletNode = function (c, name) {
        node = {
            name, port: { messages: [], onmessage: null, postMessage(m, tr) { this.messages.push(m); } }, connect() {}
        };
        return node;
    };
    try {
        const state = { active: true, AC: function (opts) { return ctx; }, gain: { connect() {} }, nodeid: "node//pc1", next: 0 };
        withBrowser(obj, state, () => {
            obj.onChunk({ nodeid: "node//pc1", rate: 16000, d: pcmBase64([10, 20, 30]) });
        });
        assert.ok(state.pending, "a pending list exists while the module loads");
        const held = state.pending ? state.pending.length : 1;
        await new Promise((r) => setImmediate(r));    // addModule resolved
        assert.ok(node, "the worklet node was created");
        assert.strictEqual(node.name, "deskaudio-processor");
        assert.strictEqual(node.port.messages.length, 1, "the held chunk was flushed");
        assert.deepStrictEqual(Array.from(node.port.messages[0].s), [10 / 32768, 20 / 32768, 30 / 32768]);
    } finally {
        delete global.AudioWorkletNode;
    }
});

test("with the worklet ready, chunks go to the ring buffer, not the scheduler", () => {
    const { obj } = loadPlugin();
    const ctx = makeCtx();
    const node = { port: { messages: [], onmessage: null, postMessage(m, tr) { this.messages.push(m); } }, connect() {} };
    const state = { active: true, ctx, gain: { connect() {} }, nodeid: "node//pc1", next: 0,
                    node, workletReady: true };
    withBrowser(obj, state, () => {
        obj.onChunk({ nodeid: "node//pc1", rate: 16000, d: pcmBase64([1, 2, 3, 4]) });
    });
    assert.strictEqual(node.port.messages.length, 1, "pushed into the worklet ring");
    assert.strictEqual(ctx.lastBuffer, null, "no per-chunk BufferSource was scheduled");
    assert.deepStrictEqual(Array.from(node.port.messages[0].s), [1 / 32768, 2 / 32768, 3 / 32768, 4 / 32768]);
});
