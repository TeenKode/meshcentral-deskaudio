// Shared helpers for the capture checks: the test tone, the native helper's
// frame format, and a tone/gap analysis of captured audio.
"use strict";

const fs = require("fs");

// The test signal: 440 Hz + 1000 Hz, each at amplitude AMP, stereo 48 kHz.
const TONES = [440, 1000];
const AMP = 0.3;
// Frequencies that must stay quiet (between and around the tones, and where
// aliasing of a broken resampler would land).
const OFF = [700, 1700, 2600, 3500, 5200];

function writeToneWav(file, seconds) {
    const rate = 48000, ch = 2, n = Math.round(seconds * rate);
    const data = Buffer.alloc(n * ch * 2);
    for (let i = 0; i < n; i++) {
        let v = 0;
        for (const f of TONES) v += AMP * Math.sin(2 * Math.PI * f * i / rate);
        const s = Math.round(v * 32767);
        for (let c = 0; c < ch; c++) data.writeInt16LE(s, (i * ch + c) * 2);
    }
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([h, data]));
}

// Split the helper's stdout into frames: [len:2 LE][flags:1][payload].
function parseFrames(buf) {
    const frames = [];
    let p = 0;
    while (p + 3 <= buf.length) {
        const len = buf.readUInt16LE(p), flags = buf[p + 2];
        if (p + 3 + len > buf.length) break;               // cut off at the end of the capture
        frames.push({ flags, payload: buf.subarray(p + 3, p + 3 + len) });
        p += 3 + len;
    }
    return frames;
}

// Amplitude of frequency f in x (Goertzel over the whole block).
function amplitude(x, rate, f) {
    const w = 2 * Math.PI * f / rate, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
        const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (x.length - 1));     // Hann
        const s0 = x[i] * win + c * s1 - s2; s2 = s1; s1 = s0;
    }
    const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
    return 4 * Math.sqrt(re * re + im * im) / x.length;   // Hann coherent gain 0.5
}

// Analyse a float signal that should carry the test tone throughout.
// Skips the first `skip` seconds (start-up), returns the measurements and a
// list of failures (empty = pass).
function checkTone(x, rate, label, opts) {
    opts = opts || {};
    const skip = Math.round((opts.skip !== undefined ? opts.skip : 0.3) * rate);
    const y = x.subarray ? x.subarray(skip) : x.slice(skip);
    const fails = [];
    if (y.length < rate) {
        fails.push(label + ": only " + (y.length / rate).toFixed(2) + " s of audio");
        return { fails };
    }
    // Amplitudes averaged over 0.1 s blocks, each the best of three probes at
    // -0.5% / 0 / +0.5%: the browser player's clock-drift control plays up to
    // 0.5% fast or slow (1000 Hz -> 995..1005 Hz), which must not move a tone
    // out of the measurement.
    const blockAmp = (f) => {
        const B = Math.round(rate * 0.1);
        let sum = 0, n = 0;
        for (let p = 0; p + B <= y.length; p += B) {
            const blk = y.subarray ? y.subarray(p, p + B) : y.slice(p, p + B);
            sum += Math.max(amplitude(blk, rate, f * 0.995), amplitude(blk, rate, f), amplitude(blk, rate, f * 1.005));
            n++;
        }
        return n ? sum / n : amplitude(y, rate, f);
    };
    const tones = TONES.map(blockAmp);
    const offs = OFF.filter((f) => f < rate / 2 - 200).map(blockAmp);
    const off = Math.max.apply(null, offs);
    // Gaps: 5 ms windows far below the steady level. The reference is the
    // 90th percentile, not the median: in a signal that is mostly gaps (e.g.
    // 20 ms of sound per 80 ms) the median is itself a gap.
    const w = Math.round(rate * 0.005), lv = [];
    for (let p = 0; p + w <= y.length; p += w) {
        let s = 0; for (let j = p; j < p + w; j++) s += y[j] * y[j];
        lv.push(Math.sqrt(s / w));
    }
    const ref = lv.slice().sort((a, b) => a - b)[Math.floor(lv.length * 0.9)];
    const gaps = lv.filter((v) => v < ref * 0.2).length;

    const res = { tones, off, ref, gaps, windows: lv.length };
    for (let i = 0; i < TONES.length; i++) {
        if (tones[i] < 0.02) fails.push(label + ": " + TONES[i] + " Hz missing (amplitude " + tones[i].toFixed(4) + ")");
        else if (tones[i] < off * 30) fails.push(label + ": " + TONES[i] + " Hz only " + (20 * Math.log10(tones[i] / off)).toFixed(1) + " dB above noise/aliasing");
    }
    if (Math.abs(tones[0] / tones[1] - 1) > 0.5) fails.push(label + ": tone balance off (" + tones.map((t) => t.toFixed(3)).join(" / ") + ")");
    if (gaps > Math.max(2, lv.length * 0.01)) fails.push(label + ": " + gaps + " of " + lv.length + " 5 ms windows are gaps");
    res.fails = fails;
    res.summary = label + ": 440 Hz " + tones[0].toFixed(3) + ", 1000 Hz " + tones[1].toFixed(3) +
        ", worst off-tone " + off.toExponential(1) + " (" + (20 * Math.log10(Math.min(tones[0], tones[1]) / off)).toFixed(0) + " dB below), gaps " + gaps + "/" + lv.length;
    return res;
}

function s16ToFloat(buf) {
    const n = buf.length >> 1, f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768;
    return f;
}

module.exports = { TONES, AMP, writeToneWav, parseFrames, amplitude, checkTone, s16ToFloat };
