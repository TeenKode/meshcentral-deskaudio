// Tests for the playback core (obj._playerCore): the exact code the
// AudioWorklet runs (it is injected into the worklet via toString). Covers the
// jitter buffer, underrun handling, backlog skipping, clock-drift control and
// rate conversion.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./helpers");

const Player = loadPlugin().obj._playerCore();

function tone(n, rate, freq, start) {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = 0.5 * Math.sin(2 * Math.PI * freq * (start + i) / rate);
    return f;
}
function render(p, n) { const out = new Float32Array(n); p.render(out); return out; }
function rms(f) { let s = 0; for (const v of f) s += v * v; return Math.sqrt(s / f.length); }

test("nothing plays until the jitter buffer is full", () => {
    const p = new Player(16000);
    p.setJitter(0.1);                                  // 1600 samples
    p.push(new Float32Array(1000).fill(0.3), 16000);
    assert.strictEqual(rms(render(p, 128)), 0, "still buffering");
    p.push(new Float32Array(1000).fill(0.3), 16000);
    const out = render(p, 128);
    assert.ok(Math.abs(out[0] - 0.3) < 1e-6 && Math.abs(out[127] - 0.3) < 1e-6, "plays once 0.1 s is queued");
});

test("samples come out in order at equal rates", () => {
    const p = new Player(16000);
    p.setJitter(0.01);
    const f = new Float32Array(400); for (let i = 0; i < f.length; i++) f[i] = i / 1000;
    p.push(f, 16000);
    const out = render(p, 128);
    // (drift control may already read up to 0.005% fast: allow a hair of interpolation)
    for (let i = 0; i < 128; i++) assert.ok(Math.abs(out[i] - i / 1000) < 1e-5, "sample " + i);
});

test("an underrun fades to silence instead of holding the last sample, then rebuffers", () => {
    const p = new Player(16000);
    p.setJitter(0.01);                                 // 160 samples
    p.push(new Float32Array(200).fill(0.5), 16000);
    const out = render(p, 512);                        // only ~200 available
    assert.ok(Math.abs(out[100] - 0.5) < 1e-6);
    assert.ok(Math.abs(out[511]) < 1e-3, "faded to ~0, not a held DC value: " + out[511]);
    for (let i = 201; i < 512; i++) assert.ok(Math.abs(out[i]) <= Math.abs(out[i - 1]) + 1e-9, "monotonic fade");
    assert.strictEqual(p.underruns, 1);
    p.push(new Float32Array(100).fill(0.5), 16000);   // below the jitter target again
    assert.ok(rms(render(p, 64)) < 1e-3, "waits for the buffer to refill");
});

test("a backlog beyond the cap is skipped back to the target latency", () => {
    const p = new Player(16000);
    p.setJitter(0.1);                                  // cap = (0.2 + 0.45) s = 10400 samples
    for (let i = 0; i < 20; i++) p.push(new Float32Array(1600), 16000);   // 2 s arrive at once
    assert.ok(p.skips >= 1);
    assert.ok(Math.abs(p.fill() - 1600) <= 1600, "latency back near the target, fill=" + p.fill());
});

test("clock drift: a producer 0.3% fast is absorbed without skips or underruns", () => {
    const rate = 48000, block = 128;
    const p = new Player(rate);
    p.setJitter(0.15);
    let produced = 0, acc = 0;
    const per = block * 1.003;                         // the agent's clock runs 0.3% fast
    for (let b = 0; b < rate * 60 / block; b++) {      // one minute of audio
        acc += per;
        while (acc >= 960) { p.push(tone(960, rate, 440, produced), rate); produced += 960; acc -= 960; }
        render(p, block);
    }
    assert.strictEqual(p.skips, 0, "no backlog jumps");
    assert.strictEqual(p.underruns, 0, "no gaps");
    assert.ok(Math.abs(p.fill() / rate - 0.15) < 0.08, "latency held near the target: " + (p.fill() / rate).toFixed(3) + " s");
});

test("clock drift: a producer 0.3% slow is absorbed without underruns", () => {
    const rate = 48000, block = 128;
    const p = new Player(rate);
    p.setJitter(0.15);
    let produced = 0, acc = 0;
    for (let b = 0; b < rate * 60 / block; b++) {
        acc += block * 0.997;
        while (acc >= 960) { p.push(tone(960, rate, 440, produced), rate); produced += 960; acc -= 960; }
        render(p, block);
    }
    assert.strictEqual(p.underruns, 0, "no gaps");
});

test("input at another rate is resampled to the context rate", () => {
    const p = new Player(48000);                       // browser refused a 16 kHz context
    p.setJitter(0.05);
    let produced = 0;
    for (let i = 0; i < 10; i++) { p.push(tone(1600, 16000, 1000, produced), 16000); produced += 1600; }
    const out = render(p, 4800);                       // 0.1 s at 48 kHz
    let zc = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) zc++;
    assert.ok(zc >= 190 && zc <= 210, "1 kHz stays 1 kHz (~200 zero crossings in 0.1 s), got " + zc);
});

test("a rate change restarts the buffer", () => {
    const p = new Player(48000);
    p.setJitter(0.01);
    p.push(new Float32Array(1000).fill(0.1), 16000);
    p.push(new Float32Array(100).fill(0.2), 48000);
    assert.strictEqual(p.fill(), 100);
});

test("the player source is self-contained (it runs inside the AudioWorklet)", () => {
    const { obj } = loadPlugin();
    const vm = require("node:vm");
    const Isolated = vm.runInNewContext("(" + obj._playerCore.toString() + ")()", { Float32Array, Math });
    const p = new Isolated(48000);
    p.setJitter(0.01);
    p.push(new Float32Array(1000).fill(0.25), 48000);
    const out = new Float32Array(16);
    p.render(out);
    assert.ok(Math.abs(out[0] - 0.25) < 1e-6);
});
