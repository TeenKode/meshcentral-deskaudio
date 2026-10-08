// End-to-end playback check in a real Chromium: real WebCodecs AudioDecoder,
// real AudioWorklet. Serializes the plugin's browser exports exactly like
// MeshCentral, feeds Opus chunks the way the agent sends them (two 20 ms
// packets every 40 ms), records what reaches the speakers and fails on gaps
// or a wrong level. Mocks cannot catch this class of bug (e.g. reading
// AudioData.allocationSize() as samples instead of bytes).
//
//   cc -O2 -o /tmp/opus-packets e2e/opus-packets.c -lopus -lm
//   /tmp/opus-packets > /tmp/packets.bin
//   node e2e/opus-playback.js /tmp/packets.bin opus2
// (needs the playwright package and its chromium)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const pluginPath = path.join(__dirname, "..", "deskaudio.js");
const packetsPath = process.argv[2];
const mode = process.argv[3] || "opus2";
const obj = require(pluginPath).deskaudio({ parent: { webserver: {} } });
let js = "window.pluginHandler = { deskaudio: {} };\n";
for (const n of obj.exports) js += "pluginHandler.deskaudio." + n + " = " + obj[n].toString() + ";\n";

const pk = fs.readFileSync(packetsPath);
const packets = [];
for (let p = 0; p < pk.length;) { const len = pk.readUInt16LE(p + 2); packets.push(pk.subarray(p, p + 4 + len)); p += 4 + len; }
const chunks = [];
for (let i = 0; i + 1 < packets.length; i += 2) {
    if (mode === "opus2") chunks.push({ codec: "opus2", d: Buffer.concat([packets[i], packets[i + 1]]).toString("base64") });
    else for (const p of [packets[i], packets[i + 1]])     // legacy: [dur][packet], one per message
        chunks.push({ codec: "opus", d: Buffer.concat([p.subarray(0, 2), p.subarray(4)]).toString("base64"), pair: true });
}

const page = `<!doctype html><html><body><div id="da_bar"></div><script>${js}
window.currentNode = { _id: "node//pc1" };
window.meshserver = { send() {} };
window.run = async function (chunks, perTick) {
  const P = pluginHandler.deskaudio;
  P._s = { active: true, nodeid: "node//pc1", jitter: 0.15, vol: 1, gotAudio: false };
  const rec = [];
  const orig = P._ensureCtx;
  P._ensureCtx = function (s, rate) {
    const had = !!s.ctx; orig(s, rate);
    if (!had && s.ctx) {
      const sp = s.ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => rec.push(Array.from(e.inputBuffer.getChannelData(0)));
      s.gain.connect(sp); sp.connect(s.ctx.destination);
    }
  };
  let i = 0;
  await new Promise((done) => {
    const t = setInterval(() => {
      for (let k = 0; k < perTick && i < chunks.length; k++, i++) P.onChunk({ nodeid: "node//pc1", rate: 16000, codec: chunks[i].codec, d: chunks[i].d });
      if (i >= chunks.length) { clearInterval(t); setTimeout(done, 600); }
    }, 40);
  });
  return { rate: P._s.ctx.sampleRate, samples: [].concat(...rec) };
};
</script></body></html>`;

const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(page); });
server.listen(0, "127.0.0.1", async () => {
    const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const pg = await browser.newPage();
    pg.on("pageerror", (e) => { console.log("PAGE ERROR:", e.message); process.exitCode = 1; });
    await pg.goto("http://127.0.0.1:" + server.address().port + "/");
    const perTick = mode === "opus2" ? 1 : 2;
    const res = await pg.evaluate((a) => window.run(a.c, a.n), { c: chunks, n: perTick });
    await browser.close(); server.close();
    const x = res.samples, sr = res.rate;
    // steady state: 0.5 s .. 3.5 s after the first sound (the stream is 4 s)
    let first = x.findIndex((v) => Math.abs(v) > 0.01);
    const start = first + Math.round(0.5 * sr), end = Math.min(x.length, first + Math.round(3.5 * sr));
    const w = Math.round(0.005 * sr); let gaps = 0, wins = 0, sumsq = 0;
    for (let p = start; p + w <= end; p += w) {
        let s = 0; for (let j = p; j < p + w; j++) s += x[j] * x[j];
        const r = Math.sqrt(s / w); wins++; sumsq += s / w;
        if (r < 0.05) gaps++;
    }
    const level = Math.sqrt(sumsq / wins);
    console.log(`${mode}: context ${sr} Hz, ${(x.length / sr).toFixed(2)} s recorded, first sound at ${(first / sr).toFixed(2)} s, ` +
        `steady RMS ${level.toFixed(3)} (signal: 0.193), near-silent 5 ms windows: ${gaps}/${wins}`);
    // The encoded signal is continuous: any silent window is a playback gap.
    const ok = first >= 0 && gaps === 0 && level > 0.16 && level < 0.23;
    if (!ok) { console.log("FAIL: playback has gaps or a wrong level"); process.exitCode = 1; }
});
