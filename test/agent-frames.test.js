// Tests for the agent's frame assembly (feedFramed): [len:2][flags:1][payload]
// frames arriving as arbitrary stream chunks. The encoder side (C++) is
// verified in CI by helpers/adpcm-test.c, which must produce byte-identical
// output to the JS encoder here.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const EventEmitter = require("node:events");
const Module = require("node:module");
const cp = require("node:child_process");

const AGENT = path.join(__dirname, "..", "modules_meshcore", "deskaudio.js");

function fakeChild() {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; };
    return c;
}

// Frame builder mirroring the native helper's output.
function frame(payload, flags) {
    const h = Buffer.alloc(3);
    h.writeUInt16LE(payload.length, 0);
    h[2] = flags || 0;
    return Buffer.concat([h, payload]);
}

test("framed stream: chunks relay with codec flag; silence frames skipped", () => {
    // Drive the agent directly: pin win32, mock fs so dropFile succeeds, then
    // feed stdout with frames cut at every possible offset.
    const calls = [];
    const sent = [];
    const realExec = cp.execFile, realLoad = Module._load, realSI = global.setInterval;
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const files = {};
    cp.execFile = (file, args) => { const c = fakeChild(); calls.push({ file, args, child: c }); return c; };
    global.setInterval = () => 1;
    Module._load = function (req) {
        if (req === "fs") return {
            readFileSync(p) { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
            writeFileSync(p, d) { files[p] = Buffer.from(d); }
        };
        return realLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(AGENT)];
    const ag = require(AGENT);
    const parent = { SendCommand(o) { sent.push(JSON.parse(JSON.stringify(o))); } };
    try {
        const data = Buffer.from("MZ fake helper for frames");
        ag.consoleaction({
            pluginaction: "start", sid: 1, rate: 16000, compress: true, silence: true,
            exe64: data.toString("base64")
        }, 0, 0, parent);
        assert.strictEqual(calls.length, 1, "helper launched");
        assert.deepStrictEqual(calls[0].args, ["deskaudio.exe", "16000", "adpcm", "silence"],
            "codec and silence are passed to the helper");

        const child = calls[0].child;
        // Two ADPCM frames, one silence frame, one PCM frame.
        const adpcmPayload = Buffer.from([0x11, 0x22, 0x33]);
        const pcmPayload = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
        const stream = Buffer.concat([
            frame(adpcmPayload, 0x02),
            frame(Buffer.alloc(0), 0x01),          // silence: skipped
            frame(pcmPayload, 0x00)                 // raw PCM: no codec field
        ]);
        // Feed byte by byte: the harshest possible split.
        for (let i = 0; i < stream.length; i++) child.stdout.emit("data", stream.slice(i, i + 1));

        const chunks = sent.filter((m) => m.pluginaction === "chunk");
        assert.strictEqual(chunks.length, 2, "two payloads relayed, silence skipped");
        assert.strictEqual(chunks[0].codec, "adpcm");
        assert.strictEqual(Buffer.from(chunks[0].d, "base64").toString("hex"), adpcmPayload.toString("hex"));
        assert.strictEqual(chunks[1].codec, undefined);
        assert.strictEqual(Buffer.from(chunks[1].d, "base64").toString("hex"), pcmPayload.toString("hex"));
        assert.strictEqual(chunks[0].sid, 1);
    } finally {
        cp.execFile = realExec; Module._load = realLoad; global.setInterval = realSI;
        Object.defineProperty(process, "platform", realPlatform);
    }
});

test("framed stream: random chunk sizes give identical results", () => {
    const calls = [];
    const sent = [];
    const realExec = cp.execFile, realLoad = Module._load, realSI = global.setInterval;
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const files = {};
    cp.execFile = (file, args) => { const c = fakeChild(); calls.push({ file, args, child: c }); return c; };
    global.setInterval = () => 1;
    Module._load = function (req) {
        if (req === "fs") return {
            readFileSync(p) { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
            writeFileSync(p, d) { files[p] = Buffer.from(d); }
        };
        return realLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(AGENT)];
    const ag = require(AGENT);
    const parent = { SendCommand(o) { sent.push(JSON.parse(JSON.stringify(o))); } };
    try {
        ag.consoleaction({
            pluginaction: "start", sid: 2, rate: 24000, compress: true, silence: false,
            exe64: Buffer.from("MZ x").toString("base64")
        }, 0, 0, parent);
        const child = calls[0].child;

        // A deterministic pseudo-random payload cut into pseudo-random pieces.
        const frames = [];
        let stream = Buffer.alloc(0);
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
        for (let k = 0; k < 20; k++) {
            const len = 1 + (rnd() % 300);
            const payload = Buffer.alloc(len);
            for (let i = 0; i < len; i++) payload[i] = rnd() & 0xFF;
            const fl = 0x02;
            stream = Buffer.concat([stream, frame(payload, fl)]);
            frames.push(payload);
        }
        // Cut at random offsets.
        let i = 0;
        while (i < stream.length) {
            const take = 1 + (rnd() % 64);
            child.stdout.emit("data", stream.slice(i, Math.min(i + take, stream.length)));
            i += take;
        }
        const chunks = sent.filter((m) => m.pluginaction === "chunk");
        assert.strictEqual(chunks.length, frames.length, "every frame relayed exactly once");
        for (let k = 0; k < frames.length; k++) {
            assert.strictEqual(Buffer.from(chunks[k].d, "base64").toString("hex"), frames[k].toString("hex"),
                "frame " + k + " payload intact");
            assert.strictEqual(chunks[k].codec, "adpcm");
            assert.strictEqual(chunks[k].rate, 24000);
        }
    } finally {
        cp.execFile = realExec; Module._load = realLoad; global.setInterval = realSI;
        Object.defineProperty(process, "platform", realPlatform);
    }
});

test("a trailing partial frame is not relayed until more data arrives", () => {
    const calls = [];
    const sent = [];
    const realExec = cp.execFile, realLoad = Module._load, realSI = global.setInterval;
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const files = {};
    cp.execFile = (file, args) => { const c = fakeChild(); calls.push({ file, args, child: c }); return c; };
    global.setInterval = () => 1;
    Module._load = function (req) {
        if (req === "fs") return {
            readFileSync(p) { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
            writeFileSync(p, d) { files[p] = Buffer.from(d); }
        };
        return realLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(AGENT)];
    const ag = require(AGENT);
    const parent = { SendCommand(o) { sent.push(JSON.parse(JSON.stringify(o))); } };
    try {
        ag.consoleaction({
            pluginaction: "start", sid: 3, rate: 16000, compress: true, silence: false,
            exe64: Buffer.from("MZ y").toString("base64")
        }, 0, 0, parent);
        const child = calls[0].child;

        const payload = Buffer.from([1, 2, 3, 4, 5]);
        const full = frame(payload, 0x02);
        // header split across two events + partial payload
        child.stdout.emit("data", full.slice(0, 2));    // header part 1
        child.stdout.emit("data", full.slice(2, 3));    // header part 2
        assert.strictEqual(sent.filter((m) => m.pluginaction === "chunk").length, 0, "nothing yet");
        child.stdout.emit("data", full.slice(3, 5));    // payload part 1
        assert.strictEqual(sent.filter((m) => m.pluginaction === "chunk").length, 0, "still nothing");
        child.stdout.emit("data", full.slice(5));       // payload part 2
        const chunks = sent.filter((m) => m.pluginaction === "chunk");
        assert.strictEqual(chunks.length, 1, "frame completed and relayed");
        assert.strictEqual(Buffer.from(chunks[0].d, "base64").toString("hex"), payload.toString("hex"));
    } finally {
        cp.execFile = realExec; Module._load = realLoad; global.setInterval = realSI;
        Object.defineProperty(process, "platform", realPlatform);
    }
});
