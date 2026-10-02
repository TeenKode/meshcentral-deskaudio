// Cross-checks the native ADPCM encoder (helpers/adpcm-enc.h, C) against the
// agent's JS encoder (modules_meshcore/deskaudio.js, adpcmEncode): the C port
// must produce byte-identical blocks, because the browser decodes both with
// the same _adpcmDecode.
//
// The expected bytes live in test/fixtures/native-adpcm.hex, one hex line per
// 40 ms block. The CI job 'adpcm' compiles helpers/adpcm-test.c, runs it, and
// requires its stdout to equal the fixture; this test then verifies that the
// JS encoder produces the same bytes. Run locally without the fixture: the
// test fails loudly so nobody silently loses the cross-check.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const agent = require(path.join(__dirname, "..", "modules_meshcore", "deskaudio.js"));
const FIXTURE = path.join(__dirname, "fixtures", "native-adpcm.hex");

// The same deterministic signal as helpers/adpcm-test.c (LCG + tones).
function makeSignal() {
    let seed = 12345;
    const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    const N = 2000, BLOCK = 640;
    const blocks = [];
    let cur = [];
    for (let i = 0; i < N; i++) {
        const t = i;
        let v = 12000 * Math.sin(2 * Math.PI * t / 32)
              + 4000 * Math.sin(2 * Math.PI * t / 7)
              + ((lcg() % 400) - 200);
        if (v > 32767) v = 32767; if (v < -32768) v = -32768;
        cur.push(Math.round(v));
        if (cur.length === BLOCK && blocks.length * BLOCK + BLOCK <= N) { blocks.push(cur); cur = []; }
    }
    return blocks;
}

test("the JS encoder and the native encoder fixture agree byte for byte", () => {
    const hexLines = fs.readFileSync(FIXTURE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    assert.ok(hexLines.length >= 3, "fixture holds at least a few blocks: " + hexLines.length);
    const blocks = makeSignal();
    assert.strictEqual(hexLines.length, blocks.length, "fixture block count matches the signal");

    for (let b = 0; b < blocks.length; b++) {
        const pcm = Buffer.alloc(blocks[b].length * 2);
        for (let i = 0; i < blocks[b].length; i++) pcm.writeInt16LE(blocks[b][i], i * 2);
        const jsEnc = agent._adpcmEncode(pcm);
        const expected = Buffer.from(hexLines[b], "hex");
        assert.strictEqual(jsEnc.length, expected.length, "block " + b + " length");
        assert.ok(jsEnc.equals(expected), "block " + b + " bytes match the native encoder");
    }
});
