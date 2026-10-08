// Windows-side agent tests. These run only on Windows: the agent's win32
// path drops the helper into the agent folder (agentDir() derives a real
// path from process.execPath) and launches it with codec arguments. In CI
// they run on the windows runner; a Linux dev box skips them.
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const EventEmitter = require("node:events");
const Module = require("node:module");
const cp = require("node:child_process");

const AGENT = path.join(__dirname, "..", "modules_meshcore", "deskaudio.js");

const isWin = process.platform === "win32";

describe("agent (Windows)", { skip: !isWin ? "windows-only: runs on the windows CI runner" : false }, () => {

    function fakeChild() {
        const c = new EventEmitter();
        c.stdout = new EventEmitter();
        c.stderr = new EventEmitter();
        c.killed = false;
        c.kill = () => { c.killed = true; };
        return c;
    }

    // Fresh agent module with execFile/setInterval/fs mocked. The fs mock is a
    // writable in-memory tree, so dropFile() succeeds and the helper "launches".
    function withWinAgent(fn) {
        const calls = [];
        const sent = [];
        const files = {};
        const realExec = cp.execFile, realLoad = Module._load, realSI = global.setInterval;
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
        const restore = () => { cp.execFile = realExec; Module._load = realLoad; global.setInterval = realSI; };
        try { return fn({ ag, calls, sent, files, parent }); } finally { restore(); }
    }

    const startAct = (ag, parent, opts) => ag.consoleaction(Object.assign({
        pluginaction: "start", sid: 1, rate: 16000, compress: true, silence: false,
        exe64: Buffer.from("MZ fake helper").toString("base64")
    }, opts), 0, 0, parent);

    test("the helper is dropped into the agent folder and launched with codec args", () => {
        withWinAgent(({ ag, calls, sent, files, parent }) => {
            startAct(ag, parent, {});
            assert.strictEqual(calls.length, 1, "helper launched; statuses="
                + JSON.stringify(sent.filter((m) => m.pluginaction === "status")));
            const dir = calls[0].file.replace(/\\[^\\]*$/, "");
            assert.ok(/deskaudio-helper(-b)?\.exe$/i.test(calls[0].file), "runs from the agent folder: " + calls[0].file);
            assert.deepStrictEqual(calls[0].args, ["deskaudio.exe", "16000", "adpcm"], "codec passed");
            // the helper bytes actually landed in the mocked folder
            const dropped = Object.keys(files).filter((p) => /deskaudio-helper/.test(p));
            assert.ok(dropped.length >= 1, "helper written to disk");
        });
    });

    test("pcm codec and silence flag are forwarded to the helper", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            startAct(ag, parent, { compress: false, silence: true });
            assert.strictEqual(calls.length, 1, "helper launched");
            assert.deepStrictEqual(calls[0].args, ["deskaudio.exe", "16000", "pcm", "silence"]);
        });
    });

    test("x86 helper is used when only exe32 is offered", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            ag.consoleaction({
                pluginaction: "start", sid: 4, rate: 16000, compress: true, silence: false,
                exe32: Buffer.from("MZ fake x86 helper").toString("base64")
            }, 0, 0, parent);
            assert.strictEqual(calls.length, 1, "helper launched (exe32 path)");
            assert.deepStrictEqual(calls[0].args, ["deskaudio.exe", "16000", "adpcm"]);
        });
    });

    // ---- framed stream protocol (the native helper's stdout format) ----

    function frame(payload, flags) {
        const h = Buffer.alloc(3);
        h.writeUInt16LE(payload.length, 0);
        h[2] = flags || 0;
        return Buffer.concat([h, payload]);
    }

    test("framed stream: chunks relay with codec flag; silence frames skipped", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            startAct(ag, parent, { silence: true });
            assert.strictEqual(calls.length, 1, "helper launched; statuses="
                + JSON.stringify(sent.filter((m) => m.pluginaction === "status")));
            const child = calls[0].child;
            const adpcmPayload = Buffer.from([0x11, 0x22, 0x33]);
            const pcmPayload = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
            const stream = Buffer.concat([
                frame(adpcmPayload, 0x02),
                frame(Buffer.alloc(0), 0x01),          // silence: skipped
                frame(pcmPayload, 0x00)                 // raw PCM: no codec field
            ]);
            // Feed byte by byte: the harshest possible split.
            for (let i = 0; i < stream.length; i++) child.stdout.emit("data", stream.slice(i, i + 1));

            const chunks = sent.filter((m) => m.pluginaction === "chunk" && !m.pause);
            assert.strictEqual(chunks.length, 2, "two payloads relayed, silence skipped");
            assert.strictEqual(sent.filter((m) => m.pause).length, 1, "the silence was announced once");
            assert.strictEqual(chunks[0].codec, "adpcm");
            assert.strictEqual(Buffer.from(chunks[0].d, "base64").toString("hex"), adpcmPayload.toString("hex"));
            assert.strictEqual(chunks[1].codec, undefined);
            assert.strictEqual(Buffer.from(chunks[1].d, "base64").toString("hex"), pcmPayload.toString("hex"));
            assert.strictEqual(chunks[0].sid, 1);
        });
    });

    test("framed stream: random chunk sizes give identical results", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            startAct(ag, parent, { rate: 24000 });
            const child = calls[0].child;

            let seed = 12345;
            const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
            const frames = [];
            let stream = Buffer.alloc(0);
            for (let k = 0; k < 20; k++) {
                const len = 1 + (rnd() % 300);
                const payload = Buffer.alloc(len);
                for (let i = 0; i < len; i++) payload[i] = rnd() & 0xFF;
                stream = Buffer.concat([stream, frame(payload, 0x02)]);
                frames.push(payload);
            }
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
        });
    });

    test("a trailing partial frame is not relayed until more data arrives", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            startAct(ag, parent, { silence: false });
            const child = calls[0].child;
            const payload = Buffer.from([1, 2, 3, 4, 5]);
            const full = frame(payload, 0x02);
            child.stdout.emit("data", full.slice(0, 2));    // header part 1
            child.stdout.emit("data", full.slice(2, 3));    // header part 2
            assert.strictEqual(sent.filter((m) => m.pluginaction === "chunk").length, 0, "nothing yet");
            child.stdout.emit("data", full.slice(3, 5));    // payload part 1
            assert.strictEqual(sent.filter((m) => m.pluginaction === "chunk").length, 0, "still nothing");
            child.stdout.emit("data", full.slice(5));       // payload part 2
            const chunks = sent.filter((m) => m.pluginaction === "chunk");
            assert.strictEqual(chunks.length, 1, "frame completed and relayed");
            assert.strictEqual(Buffer.from(chunks[0].d, "base64").toString("hex"), payload.toString("hex"));
        });
    });

    test("multi-packet Opus frames (flag 0x08) are relayed as opus2, split anywhere", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            startAct(ag, parent, { codec: "opus", bitrate: 32 });
            assert.ok(calls[0].args.includes("opus") && calls[0].args.includes("kbps=32"), "helper told to encode opus");
            const pkt = (len) => Buffer.concat([Buffer.from([0xC0, 0x03, len, 0]), Buffer.alloc(len, 9)]);
            const payload = Buffer.concat([pkt(3), pkt(4)]);
            const frame = Buffer.concat([Buffer.from([payload.length, 0, 0x08]), payload]);
            const silence = Buffer.from([0, 0, 0x01]);
            const stream = Buffer.concat([frame, silence, frame]);
            for (let i = 0; i < stream.length; i += 2) calls[0].child.stdout.emit("data", stream.subarray(i, i + 2));
            const chunks = sent.filter((m) => m.pluginaction === "chunk" && !m.pause);
            assert.strictEqual(chunks.length, 2, "two frames, the silent one skipped");
            for (const c of chunks) {
                assert.strictEqual(c.codec, "opus2");
                assert.deepStrictEqual(Buffer.from(c.d, "base64"), payload);
            }
        });
    });

    test("helper stderr lines reach the browser log, rate-limited", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            startAct(ag, parent, {});
            calls[0].child.stderr.emit("data", Buffer.from("capture: 48000 Hz, 2 ch, float32 -> 16000 Hz adpcm\n"));
            const logs = sent.filter((m) => m.pluginaction === "log");
            assert.ok(logs.some((m) => /helper .*deskaudio-helper\.exe/.test(m.msg)), "helper launch is logged");
            assert.ok(logs.some((m) => m.msg === "capture: 48000 Hz, 2 ch, float32 -> 16000 Hz adpcm"), "stderr line forwarded");
            for (let i = 0; i < 100; i++) calls[0].child.stderr.emit("data", Buffer.from("spam " + i + "\n"));
            assert.ok(sent.filter((m) => m.pluginaction === "log").length <= 30, "at most 30 log lines a minute");
        });
    });

    const sha = (b) => require("crypto").createHash("sha384").update(b).digest("hex");

    test("on-demand helper: a missing copy is requested once, verified, dropped and run", () => {
        withWinAgent(({ ag, calls, sent, files, parent }) => {
            const exe = Buffer.from("MZ new helper build");
            ag.consoleaction({ pluginaction: "start", sid: 4, rate: 16000,
                helper: { x64: { sha: sha(exe), size: exe.length }, x86: { sha: "00", size: 1 } } }, 0, 0, parent);
            assert.strictEqual(calls.length, 0, "nothing to run yet");
            const need = sent.find((m) => m.pluginaction === "need");
            assert.ok(need && need.arch === "x64" && need.sid === 4 && need.proto === 3);

            ag.consoleaction({ pluginaction: "helper", sid: 3, arch: "x64", data: exe.toString("base64") }, 0, 0, parent);
            assert.strictEqual(calls.length, 0, "answer for another session ignored");
            ag.consoleaction({ pluginaction: "helper", sid: 4, arch: "x64", data: exe.toString("base64") }, 0, 0, parent);
            assert.strictEqual(calls.length, 1, "helper launched after download");
            assert.ok(Object.values(files).some((f) => f.equals(exe)), "helper written to the agent folder");
        });
    });

    test("on-demand helper: a matching local copy starts without any download", () => {
        withWinAgent(({ ag, calls, sent, files, parent }) => {
            const exe = Buffer.from("MZ current helper");
            const dir = require("path").dirname(process.execPath);
            const p = (process.execPath.lastIndexOf("\\") >= 0 ? process.execPath.substring(0, process.execPath.lastIndexOf("\\")) : dir) + "\\deskaudio-helper.exe";
            files[p] = exe;
            ag.consoleaction({ pluginaction: "start", sid: 5, rate: 16000,
                helper: { x64: { sha: sha(exe), size: exe.length }, x86: { sha: sha(exe), size: exe.length } } }, 0, 0, parent);
            assert.ok(!sent.some((m) => m.pluginaction === "need"), "no download");
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].file, p);
        });
    });

    test("on-demand helper: a corrupted download is refused", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            const exe = Buffer.from("MZ good");
            ag.consoleaction({ pluginaction: "start", sid: 6, rate: 16000,
                helper: { x64: { sha: sha(exe), size: exe.length }, x86: { sha: sha(exe), size: exe.length } } }, 0, 0, parent);
            ag.consoleaction({ pluginaction: "helper", sid: 6, arch: "x64", data: Buffer.from("MZ evil").toString("base64") }, 0, 0, parent);
            assert.strictEqual(calls.length, 0);
            assert.strictEqual(sent.filter((m) => m.pluginaction === "status").pop().state, "error");
        });
    });

    test("spawnAsUser from the server launches the helper in the user's session", () => {
        withWinAgent(({ ag, calls, parent }) => {
            const real = cp.SpawnTypes;
            cp.SpawnTypes = { USER: 2 };
            const realExec = cp.execFile;
            let opts = null;
            cp.execFile = (file, args, o) => { opts = o; return realExec(file, args); };
            try {
                startAct(ag, parent, { spawnAsUser: true });
                assert.deepStrictEqual(opts, { type: 2 });
                cp.execFile = (file, args, o) => { opts = o; return realExec(file, args); };
                startAct(ag, parent, { sid: 2 });
                assert.strictEqual(opts, undefined, "default: the agent's own session");
            } finally { cp.SpawnTypes = real; cp.execFile = realExec; }
        });
    });

    test("silence frames announce one pause per quiet stretch", () => {
        withWinAgent(({ ag, calls, sent, parent }) => {
            startAct(ag, parent, { silence: true });
            const audio = Buffer.concat([Buffer.from([4, 0, 0x02]), Buffer.from([1, 2, 3, 4])]);
            const quiet = Buffer.from([0, 0, 0x01]);
            calls[0].child.stdout.emit("data", Buffer.concat([audio, quiet, quiet, quiet, audio, quiet, quiet]));
            const seq = sent.filter((m) => m.pluginaction === "chunk").map((m) => (m.pause ? "pause" : "audio"));
            assert.deepStrictEqual(seq, ["audio", "pause", "audio", "pause"], "one pause per quiet stretch, not per frame");
        });
    });

    // ---- dropFile itself is platform-independent; keep it here so the
    // Windows runner exercises the exact helper-drop code path. ----
    test("dropFile writes the helper, reuses an identical file, replaces a planted one", () => {
        const agent = require(AGENT);
        const files = {};
        const fsMock = {
            readFileSync(p) { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
            writeFileSync(p, d) { if (fsMock.locked) throw new Error("EBUSY"); files[p] = Buffer.from(d); fsMock.writes++; },
            writes: 0, locked: false
        };
        const data = Buffer.from("MZ real helper");
        const p = agent._dropFile(fsMock, "C:\\Agent", "h.exe", data);
        assert.strictEqual(p, "C:\\Agent\\h.exe");
        assert.strictEqual(fsMock.writes, 1);

        assert.strictEqual(agent._dropFile(fsMock, "C:\\Agent", "h.exe", data), p);
        assert.strictEqual(fsMock.writes, 1, "identical file is not rewritten");

        files[p] = Buffer.from("MZ planted!!!!");     // same length, different bytes
        assert.strictEqual(agent._dropFile(fsMock, "C:\\Agent", "h.exe", data), p);
        assert.ok(files[p].equals(data), "planted file replaced");

        files[p] = Buffer.from("MZ planted");
        fsMock.locked = true;
        assert.strictEqual(agent._dropFile(fsMock, "C:\\Agent", "h.exe", data), null, "unwritable mismatching file is never used");
    });
});

// Platform-independent: the hash helpers the Windows helper delivery relies on.
const agentMod = require(AGENT);
test("helper hashes compare regardless of hex case (MeshAgent prints UPPER-case hex)", () => {
    const crypto = require("node:crypto");
    const data = Buffer.from("MZ helper bytes");
    const lower = crypto.createHash("sha384").update(data).digest("hex");
    assert.strictEqual(agentMod._sha384(data), lower, "always lower-case");
    assert.ok(agentMod._sameSha(lower.toUpperCase(), lower), "UPPER vs lower: same hash");
    assert.ok(!agentMod._sameSha(lower, lower.replace(/^./, "0") === lower ? lower.replace(/^./, "1") : lower.replace(/^./, "0")));
    const files = { "C:\\Agent\\deskaudio-helper-b.exe": data };
    const fsMock = { readFileSync(p) { if (!(p in files)) throw new Error("ENOENT"); return files[p]; } };
    assert.strictEqual(agentMod._localHelper(fsMock, "C:\\Agent", { sha: lower.toUpperCase(), size: data.length }), "C:\\Agent\\deskaudio-helper-b.exe");
    assert.strictEqual(agentMod._localHelper(fsMock, "C:\\Agent", { sha: lower, size: data.length + 1 }), null, "size must match");
});
