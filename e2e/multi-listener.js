// Two "computers" under ONE account listen to the same device at once, over a
// simulated network. Real plugin server code, real browser code in two
// separate Chromium contexts (separate storage, like two PCs), a fake agent
// that streams real Opus packets in real time.
//
// Timeline: A starts, B joins 0.5 s later; A stops at 6 s and starts again at
// 8 s (rejoining B's stream); the run ends at 12 s. Both record what reaches
// their speakers; every period in which a listener is listening must be free
// of gaps, the agent must have been started once and never stopped while
// someone listened.
//
//   node e2e/multi-listener.js <packets.bin> [clean|jitter|stalls]
// packets.bin: 440 + 1000 Hz, e.g. `opus-packets 20 1000` (e2e/opus-packets.c).
// Needs the playwright package and its chromium.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");
const { checkTone } = require("./tone");

const NODE = "node//pc1";
// The policy MeshCentral (webserver.js) sends with its web UI, trimmed to the
// directives that matter here.
const MESHCENTRAL_CSP = "default-src 'none'; font-src 'self' data:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
    "connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; media-src 'self'";
const MODE = process.argv[3] || "stalls";
const RUN_S = 12;

// ---------- packets: [dur:2][len:2][packet] records -> opus2 chunk payloads
const pk = fs.readFileSync(process.argv[2]);
const packets = [];
for (let p = 0; p < pk.length;) { const len = pk.readUInt16LE(p + 2); packets.push(pk.subarray(p, p + 4 + len)); p += 4 + len; }

// ---------- network model for agent -> server -> browser audio
// clean: steady small jitter. jitter: up to 120 ms. stalls: like jitter plus a
// 400 ms stall every 3 s (the agent uplink busy with the desktop stream, a
// Wi-Fi hiccup): everything sent meanwhile arrives in one burst.
function networkDelay(tSend) {
    let d = 20 + Math.random() * (MODE === "clean" ? 10 : 120);
    if (MODE === "stalls") {
        const phase = tSend % 3000;
        if (phase >= 1500 && phase < 1900) d = Math.max(d, 1900 - phase + 20);
    }
    return d;
}

// ---------- MeshCentral server mocks around the real plugin
const events = [];
const meshServer = {
    config: { domains: {}, settings: {} }, webserver: { wsagents: {} },
    debug() {}, DispatchEvent(ids, src, ev) { events.push(ev); }
};
const plugin = require(path.join(__dirname, "..", "deskaudio.js")).deskaudio({ parent: meshServer });
const web = {
    GetNodeWithRights(domain, user, nodeid, cb) {
        setImmediate(() => cb({ _id: NODE, meshid: "mesh//m1", domain: "" }, 0xFFFFFFFF));
    }
};

// ---------- fake agent: one capture, streaming opus2 chunks in real time
const agentLog = [];
let stream = null;        // { sid, timer, i, t0, lastDelivery }
const agent = {
    dbNodeKey: NODE,
    send(json) {
        const m = JSON.parse(json);
        agentLog.push({ t: Date.now(), a: m.pluginaction, sid: m.sid });
        if (m.pluginaction === "start") {
            if (m.codec !== "opus") { console.log("FAIL agent asked for codec " + m.codec + ", expected opus"); process.exitCode = 1; }
            if (stream) clearInterval(stream.timer);
            const sid = m.sid;
            setTimeout(() => plugin.serveraction({ action: "plugin", plugin: "deskaudio", pluginaction: "status", sid, state: "started", proto: 3, rate: m.rate, codec: "opus" }, agent), 30);
            stream = { sid, i: 0, t0: Date.now() + 40, lastDelivery: 0 };
            const s = stream;
            const tick = () => {
                // emit every 40 ms block that is due (keeps real-time pace)
                while (s === stream && Date.now() >= s.t0 + s.i * 40) {
                    const a = packets[(2 * s.i) % packets.length], b = packets[(2 * s.i + 1) % packets.length];
                    const msg = { action: "plugin", plugin: "deskaudio", pluginaction: "chunk", sid, rate: 16000, codec: "opus2", d: Buffer.concat([a, b]).toString("base64") };
                    const due = Math.max(Date.now() + networkDelay(Date.now() - T0), s.lastDelivery);
                    s.lastDelivery = due;
                    setTimeout(() => plugin.serveraction(msg, agent), due - Date.now());
                    s.i++;
                }
            };
            s.timer = setInterval(tick, 5);
        } else if (m.pluginaction === "stop" && stream && (m.sid == null || m.sid === stream.sid)) {
            clearInterval(stream.timer); stream = null;
        }
    }
};
meshServer.webserver.wsagents[NODE] = agent;

// ---------- browser pages
let browserJs = "window.pluginHandler = { deskaudio: {}, registerPluginTab() {} };\n";
for (const n of plugin.exports) browserJs += "pluginHandler.deskaudio." + n + " = " + plugin[n].toString() + ";\n";
const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><div id="pluginDeskAudio"></div><script>${browserJs}
window.currentNode = { _id: "${NODE}", name: "PC-1" };
window.meshserver = { send: (m) => window.__toServer(m) };
window.QH = (id, h) => { document.getElementById(id).innerHTML = h; };
window.__rec = [];
(function () {
  const P = pluginHandler.deskaudio, orig = P._ensureCtx;
  P._ensureCtx = function (s, rate) {
    const had = !!s.ctx; orig(s, rate);
    if (!had && s.ctx) {
      const sp = s.ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => window.__rec.push([Date.now(), s.ctx ? s.ctx.sampleRate : 48000, Array.from(e.inputBuffer.getChannelData(0))]);
      s.gain.connect(sp); sp.connect(s.ctx.destination);
    }
  };
})();
pluginHandler.deskaudio.onDeviceRefreshEnd();
</script></body></html>`;

let T0 = Date.now();

async function makeListener(browser, name) {
    const ctx = await browser.newContext();          // own storage: a separate computer
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { console.log(name + " PAGE ERROR: " + e.message); process.exitCode = 1; });
    const closeCbs = [];
    let chain = Promise.resolve();
    const sess = {
        user: { _id: "user//admin", name: "admin", domain: "" },   // the SAME account on both
        domain: { id: "" },
        ws: {
            readyState: 1, bufferedAmount: 0,
            on(ev, cb) { if (ev === "close") closeCbs.push(cb); },
            send(str) {
                const m = JSON.parse(str);
                chain = chain.then(() => page.evaluate((mm) => {
                    const f = pluginHandler.deskaudio[mm.method];
                    if (typeof f === "function") f(null, mm);
                }, m)).catch(() => {});
            }
        }
    };
    await page.exposeFunction("__toServer", (cmd) => plugin.serveraction(cmd, sess, web));
    await page.goto(pageUrl);          // 127.0.0.1: a secure context (AudioWorklet, WebCodecs)
    return { name, page, sess, closeCbs };
}

const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, T0 + t * 1000 - Date.now())));

let pageUrl = "";
(async () => {
    // Served like MeshCentral does: its Content-Security-Policy on the page
    // (worklet scripts only from 'self'), and pluginadmin.ashx answered by
    // the plugin's own handleAdminReq.
    const srv = http.createServer((q, r) => {
        const u = new URL(q.url, "http://x");
        if (u.pathname === "/pluginadmin.ashx") {
            const query = Object.fromEntries(u.searchParams);
            const res = {
                set(h) { for (const k in h) r.setHeader(k, h[k]); },
                send(b) { r.writeHead(200); r.end(b); },
                sendStatus(c) { r.writeHead(c); r.end(); }
            };
            if (query.pin !== "deskaudio") return res.sendStatus(401);
            return plugin.handleAdminReq({ query }, res, { _id: "user//admin" });
        }
        r.writeHead(200, { "content-type": "text/html; charset=utf-8",
            "content-security-policy": process.env.NO_CSP ? "" : MESHCENTRAL_CSP });
        r.end(PAGE);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    pageUrl = "http://127.0.0.1:" + srv.address().port + "/";
    const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const A = await makeListener(browser, "A"), B = await makeListener(browser, "B");
    T0 = Date.now();
    await A.page.evaluate(() => pluginHandler.deskaudio.start());
    await sleepUntil(0.5); await B.page.evaluate(() => pluginHandler.deskaudio.start());
    await sleepUntil(6); await A.page.evaluate(() => pluginHandler.deskaudio.stop());
    await sleepUntil(8); await A.page.evaluate(() => pluginHandler.deskaudio.start());
    await sleepUntil(RUN_S);

    // Listening periods to check (seconds from T0), past the start-up buffering.
    // With stalls, the first stall of a fresh browser (no learned buffer yet)
    // breaks up once while the buffer adapts; everything after it - including
    // A's second session, which starts with the learned buffer - must not.
    for (const L of [A, B]) {
        const log = await L.page.evaluate(() => (pluginHandler.deskaudio._log || []).filter((l) => /плеер|player/.test(l)));
        console.log(L.name + ": " + log.join(" | ").replace(/^\S+\s+/, ""));
        if (!log.length || !log.every((l) => /AudioWorklet \(/.test(l))) { console.log("FAIL " + L.name + " did not get the AudioWorklet player"); process.exitCode = 1; }
    }
    const periods = MODE === "stalls"
        ? { A: [[4.0, 6.0], [8.8, RUN_S]], B: [[4.0, RUN_S]] }
        : { A: [[1.0, 6.0], [8.8, RUN_S]], B: [[1.5, RUN_S]] };
    let fails = 0;
    for (const L of [A, B]) {
        const r = await L.page.evaluate((t0) => ({
            rec: window.__rec.map(([t, sr, d]) => [t - t0, sr, d]),
            log: (pluginHandler.deskaudio._log || []).slice(-40),
            player: (pluginHandler.deskaudio._s || {}).player
        }), T0);
        const rate = r.rec.length ? r.rec[0][1] : 48000;
        if (process.env.DUMP) fs.writeFileSync(process.env.DUMP + "-" + L.name + ".json", JSON.stringify(r.rec.map(([t, sr, d]) => [t, d.length])) );
        if (process.env.DUMP) fs.writeFileSync(process.env.DUMP + "-" + L.name + ".f32", Buffer.from(Float32Array.from([].concat(...r.rec.map((x) => x[2]))).buffer));
        for (const [a, b] of periods[L.name]) {
            // buffers whose capture time lies in the period (a ScriptProcessor
            // buffer is delivered ~2048 samples after it played: shift back)
            const lag = 2048 / rate * 1000;
            const parts = r.rec.filter(([t]) => t - lag >= a * 1000 && t - lag <= b * 1000).map((x) => x[2]);
            const x = Float32Array.from([].concat(...parts));
            const res = checkTone(x, rate, L.name + " " + a + "-" + b + " s", { skip: 0 });
            console.log((res.fails.length ? "FAIL " : "ok   ") + (res.summary || res.fails[0]));
            if (res.fails.length) { fails++; res.fails.forEach((f) => console.log("     " + f)); }
        }
        console.log("     player: " + JSON.stringify(r.player));
        if (process.env.SHOW_LOG) console.log(r.log.join("\n"));
    }
    if (process.env.SHOW_LOG) console.log(agentLog.map((x) => ((x.t - T0) / 1000).toFixed(2) + " " + x.a + " sid=" + x.sid).filter((l) => !/keepalive/.test(l)).join("\n"));
    const starts = agentLog.filter((x) => x.a === "start").length;
    const stopsWhileListening = agentLog.filter((x) => x.a === "stop" && x.t - T0 < RUN_S * 1000 - 100).length;
    console.log("agent: " + starts + " start(s), " + stopsWhileListening + " stop(s) while someone listened");
    if (starts !== 1) { fails++; console.log("FAIL the capture was (re)started " + starts + " times; joins must reuse it"); }
    if (stopsWhileListening) { fails++; console.log("FAIL the capture was stopped while B was listening"); }

    await browser.close();
    srv.close();
    console.log(MODE + ": " + (fails ? fails + " failure(s)" : "all listeners heard gapless audio"));
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
