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
        atob: global.atob, document: global.document, pluginHandler: global.pluginHandler
    };
    global.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
    global.document = { getElementById() { return null; } };
    global.pluginHandler = { deskaudio: obj };
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
