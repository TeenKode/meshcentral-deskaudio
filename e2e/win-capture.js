// Real WASAPI loopback capture on a Windows CI runner with a virtual sound card
// (VB-CABLE): a test tone is played to the default output, the prebuilt helpers
// capture it, and the result is checked for the tone, gaps and real-time pace.
// Opus output is saved for decoding in a Linux job (libopus):
//   node e2e/win-capture.js <outdir>
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { writeToneWav, parseFrames, checkTone, s16ToFloat } = require("./tone");

const ROOT = path.join(__dirname, "..");
const OUT = path.resolve(process.argv[2] || "capture-out");
const CAPTURE_S = 3;
fs.mkdirSync(OUT, { recursive: true });

// The browser's ADPCM decoder, exactly as shipped.
const plugin = require(path.join(ROOT, "deskaudio.js")).deskaudio({ parent: { webserver: {} } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run the helper for `seconds`, collecting stdout with arrival times.
function capture(exe, args, seconds) {
    return new Promise((resolve) => {
        const c = spawn(path.join(ROOT, "helpers", exe), args, { windowsHide: true });
        const chunks = [], err = [];
        let first = 0, last = 0;
        c.stdout.on("data", (d) => { const t = Date.now(); if (!first) first = t; last = t; chunks.push(d); });
        c.stderr.on("data", (d) => err.push(d));
        let exited = null;
        c.on("exit", (code) => { exited = code; });
        setTimeout(() => {
            if (exited === null) c.kill();
            setTimeout(() => resolve({ out: Buffer.concat(chunks), stderr: Buffer.concat(err).toString().trim(), first, last, exited }), 300);
        }, seconds * 1000);
    });
}

const failures = [];
function fail(msg) { failures.push(msg); console.log("  FAIL " + msg); }

function pcmCase(label, r, rate) {
    const frames = parseFrames(r.out).filter((f) => f.flags === 0x00);
    const pcm = Buffer.concat(frames.map((f) => f.payload));
    const x = s16ToFloat(pcm);
    // Real-time pace: samples delivered vs. wall time between first and last
    // output (plus one 40 ms frame). Catches a wrong rate or dropped audio.
    const wall = (r.last - r.first) / 1000 + 0.04;
    const pace = x.length / rate / wall;
    const res = checkTone(x, rate, label);
    console.log("  " + (res.summary || label) + ", pace " + pace.toFixed(3) + "x");
    res.fails.forEach(fail);
    if (Math.abs(pace - 1) > 0.1) fail(label + ": pace " + pace.toFixed(3) + "x real time (" + x.length + " samples in " + wall.toFixed(2) + " s)");
}

async function main() {
    const wav = path.join(OUT, "tone.wav");
    writeToneWav(wav, 120);
    console.log("playing the test tone (440 Hz + 1000 Hz) to the default output");
    const player = spawn("powershell", ["-NoProfile", "-Command",
        "$p = New-Object System.Media.SoundPlayer '" + wav + "'; $p.PlayLooping(); Start-Sleep -Seconds 600"], { windowsHide: true });
    await sleep(2000);

    const cases = [
        { exe: "deskaudio-x64.exe", args: ["16000", "pcm"], kind: "pcm", rate: 16000 },
        { exe: "deskaudio-x64.exe", args: ["24000", "pcm"], kind: "pcm", rate: 24000 },
        { exe: "deskaudio-x64.exe", args: ["8000", "pcm"], kind: "pcm", rate: 8000 },
        { exe: "deskaudio-x86.exe", args: ["16000", "pcm"], kind: "pcm", rate: 16000 },
        { exe: "deskaudio-x64.exe", args: ["16000", "adpcm", "silence"], kind: "adpcm", rate: 16000 },
        { exe: "deskaudio-x64.exe", args: ["16000", "opus", "kbps=32", "silence"], kind: "opus", save: "capture-opus-x64.bin" },
        { exe: "deskaudio-x86.exe", args: ["16000", "opus", "kbps=48"], kind: "opus", save: "capture-opus-x86.bin" }
    ];
    for (const k of cases) {
        const label = k.exe.replace(".exe", "") + " " + k.args.join(" ");
        console.log("\n" + label);
        const r = await capture(k.exe, k.args, CAPTURE_S);
        if (r.stderr) console.log("  helper: " + r.stderr.split("\n").join("\n  helper: "));
        if (r.exited !== null) { fail(label + ": helper exited early with code " + r.exited); continue; }
        if (!r.out.length) { fail(label + ": no output"); continue; }
        if (k.kind === "pcm") pcmCase(label, r, k.rate);
        else if (k.kind === "adpcm") {
            const frames = parseFrames(r.out).filter((f) => f.flags === 0x02);
            const parts = frames.map((f) => plugin._adpcmDecode(f.payload.toString("binary")));
            const n = parts.reduce((a, p) => a + p.length, 0), x = new Float32Array(n);
            let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
            const res = checkTone(x, k.rate, label);
            console.log("  " + (res.summary || label) + ", " + frames.length + " ADPCM frames");
            res.fails.forEach(fail);
        } else {
            // Opus: structure here, content decoded with libopus in the Linux job.
            fs.writeFileSync(path.join(OUT, k.save), r.out);
            const frames = parseFrames(r.out).filter((f) => f.flags === 0x08);
            let packets = 0, bad = 0, bytes = 0;
            for (const f of frames) {
                let p = 0, n = 0;
                while (p + 4 <= f.payload.length) {
                    const dur = f.payload.readUInt16LE(p), len = f.payload.readUInt16LE(p + 2);
                    if (dur !== 960 || len === 0 || p + 4 + len > f.payload.length) { bad++; break; }
                    p += 4 + len; n++; bytes += len;
                }
                if (n !== 2) bad++;
                packets += n;
            }
            const secs = (r.last - r.first) / 1000 + 0.04;
            console.log("  " + frames.length + " frames, " + packets + " packets (" + (packets / secs).toFixed(1) + "/s, expected 50), " +
                Math.round(bytes * 8 / secs / 1000) + " kbit/s payload");
            if (!frames.length) fail(label + ": no multi-packet Opus frames");
            if (bad) fail(label + ": " + bad + " malformed Opus frames");
            if (Math.abs(packets / secs - 50) > 6) fail(label + ": " + (packets / secs).toFixed(1) + " packets/s, expected 50");
        }
    }

    // Silence suppression: with nothing playing, no audio frames are sent.
    player.kill();
    spawn("taskkill", ["/F", "/T", "/PID", String(player.pid)]);
    await sleep(1500);
    console.log("\nsilence (player stopped): deskaudio-x64 16000 adpcm silence");
    const r = await capture("deskaudio-x64.exe", ["16000", "adpcm", "silence"], 2);
    const frames = parseFrames(r.out);
    const audio = frames.filter((f) => f.flags !== 0x01).length;
    console.log("  " + frames.length + " frames, " + audio + " carrying audio");
    if (audio > 2) fail("silence: " + audio + " audio frames sent while nothing played");

    console.log("\n" + (failures.length ? failures.length + " failure(s)" : "all capture checks passed"));
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
