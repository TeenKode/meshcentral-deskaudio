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
