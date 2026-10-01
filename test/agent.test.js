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

    // Low-level noise under the threshold still counts as silence.
    const quiet = Buffer.alloc(640);
    for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(10, i);
    assert.strictEqual(agent._isSilent(quiet), true, "sub-threshold noise is silent");

    // A single loud sample makes the whole buffer non-silent.
    const loud = Buffer.alloc(640);
    loud.writeInt16LE(5000, 200);
    assert.strictEqual(agent._isSilent(loud), false, "a loud sample is not silent");

    // Negative samples are handled too.
    const neg = Buffer.alloc(640);
    neg.writeInt16LE(-3000, 100);
    assert.strictEqual(agent._isSilent(neg), false, "a loud negative sample is not silent");
});
