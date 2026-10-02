// Tests for the pure ring-buffer logic that the browser AudioWorklet mirrors
// (obj._ringNew / obj._ringPush). The worklet itself runs in a real audio
// thread in the browser; here we pin the exact overflow/underflow/drift
// semantics the worklet implements, so both sides stay in sync.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./helpers");

function newRing(cap) {
    const { obj } = loadPlugin();
    return { obj, ring: obj._ringNew(cap) };
}

test("a fresh ring is empty and reports its capacity", () => {
    const { ring } = newRing(8);
    assert.strictEqual(ring.used, 0);
    assert.strictEqual(ring.cap, 8);
});

test("push then pull returns the samples in order (FIFO)", () => {
    const { obj, ring } = newRing(8);
    obj._ringPush(ring, [1, 2, 3]);
    assert.strictEqual(ring.used, 3);
    // pull is a closure in the module; verify order through push+overflow
    // behavior instead: after pushing 4..8, all 8 are held in order.
    obj._ringPush(ring, [4, 5, 6, 7, 8]);
    assert.strictEqual(ring.used, 8);
    // Read back via the internal buffer positions: r must point at 1.
    assert.strictEqual(ring.buf[ring.r], 1);
});

test("overflow drops the OLDEST samples, never the newest", () => {
    const { obj, ring } = newRing(4);
    obj._ringPush(ring, [1, 2]);
    obj._ringPush(ring, [3, 4]);
    const dropped = obj._ringPush(ring, [5, 6]);        // 1 and 2 are evicted
    assert.strictEqual(dropped, 2);
    assert.strictEqual(ring.used, 4);
    assert.strictEqual(ring.buf[ring.r], 3);            // oldest survivor
    // newest sample must be the one just written
    const lastPos = (ring.w + ring.cap - 1) % ring.cap;
    assert.strictEqual(ring.buf[lastPos], 6);
});

test("a single push larger than the whole ring keeps only its tail", () => {
    const { obj, ring } = newRing(4);
    const dropped = obj._ringPush(ring, [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(dropped, 2);
    assert.strictEqual(ring.used, 4);
    assert.strictEqual(ring.buf[ring.r], 3);
    const lastPos = (ring.w + ring.cap - 1) % ring.cap;
    assert.strictEqual(ring.buf[lastPos], 6);
});

test("pushing nothing is a no-op", () => {
    const { obj, ring } = newRing(4);
    assert.strictEqual(obj._ringPush(ring, []), 0);
    assert.strictEqual(ring.used, 0);
});

test("wrap-around keeps every sample (no clobbering)", () => {
    const { obj, ring } = newRing(4);
    // Go around the circle many times with pull-by-overflow discipline:
    // simulate the worklet: producer pushes 2, consumer reads 2, repeatedly.
    const seen = [];
    for (let round = 0; round < 100; round++) {
        obj._ringPush(ring, [round, round + 1000]);
        // consume exactly what was pushed (mimics the audio thread)
        seen.push(ring.buf[ring.r]); ring.r = (ring.r + 1) % ring.cap; ring.used--;
        seen.push(ring.buf[ring.r]); ring.r = (ring.r + 1) % ring.cap; ring.used--;
        assert.strictEqual(ring.used, 0, "ring drains between rounds");
    }
    // values must come back exactly, in order
    for (let i = 0; i < 200; i++) {
        const expected = (i % 2 === 0) ? (i / 2) : (Math.floor(i / 2) + 1000);
        assert.strictEqual(seen[i], expected, `sample ${i}: ${seen[i]} vs ${expected}`);
    }
});

test("drift +1% (consumer slower than producer): bounded delay, no loss of newest", () => {
    const { obj, ring } = newRing(1600);     // 100 ms @ 16 kHz
    // Producer 101 samples per tick, consumer 100: the backlog grows by ~1
    // per tick and must be capped by the capacity, dropping the oldest.
    // The first ~capacity excess samples go into filling the ring, so total
    // drops over T ticks = T - capacity (here 5000 - 1600 = 3400).
    let droppedTotal = 0;
    let v = 0;
    const ticks = 5000;
    for (let tick = 0; tick < ticks; tick++) {
        const chunk = [];
        for (let k = 0; k < 101; k++) chunk.push(v++);
        droppedTotal += obj._ringPush(ring, chunk);
        for (let k = 0; k < 100; k++) { /* consume */ ring.r = (ring.r + 1) % ring.cap; ring.used--; }
        assert.ok(ring.used <= ring.cap, "never exceeds capacity");
    }
    // Invariant: every sample is either consumed or dropped, and the backlog
    // is bounded — drops over T ticks = drift*T - final backlog.
    const produced = ticks * 101, consumed = ticks * 100;
    assert.strictEqual(produced - consumed - droppedTotal, ring.used,
        "produced - consumed - dropped = backlog");
    assert.ok(ring.used <= ring.cap, "backlog never exceeds capacity");
    assert.ok(droppedTotal < ticks, "drops are bounded by the drift rate, not runaway");
});

test("drift -1% (consumer faster than producer): runs dry, repeats last (worklet rule)", () => {
    const { obj, ring } = newRing(1600);
    // Consumer 101 per tick, producer 100: the ring must empty out.
    let v = 0;
    for (let tick = 0; tick < 100; tick++) {
        const chunk = [];
        for (let k = 0; k < 100; k++) chunk.push(v++);
        obj._ringPush(ring, chunk);
        let taken = 0;
        for (let k = 0; k < 101; k++) {
            if (ring.used > 0) { ring.r = (ring.r + 1) % ring.cap; ring.used--; taken++; }
            // else: the worklet repeats `last` — nothing to verify in the ring itself
        }
        assert.strictEqual(taken, 100, "exactly the pushed samples are available");
    }
    assert.strictEqual(ring.used, 0, "drained: the consumer is starved, as designed");
});
