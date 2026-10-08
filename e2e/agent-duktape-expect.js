// Reference values for e2e/agent-duktape.js, computed by running the agent
// module under Node: the same functions must give the same results inside the
// real MeshAgent (Duktape, its own Buffer/fs/crypto).
//   node e2e/agent-duktape-expect.js > expect.json
"use strict";
const path = require("path");
const ag = require(path.join(__dirname, "..", "modules_meshcore", "deskaudio.js"));

function signal(n, seed) {          // deterministic s16le test signal
    const b = Buffer.alloc(n * 2);
    let x = seed;
    for (let i = 0; i < n; i++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        const v = Math.round(8000 * Math.sin(i / 7) + ((x >>> 16) % 2001) - 1000);
        b.writeInt16LE(v, i * 2);
    }
    return b;
}
const out = { adpcm: [], sha: {} };
for (const [n, seed] of [[640, 1], [960, 7], [321, 3]]) {
    out.adpcm.push({ n, seed, hex: ag._adpcmEncode(signal(n, seed)).toString("hex") });
}
out.sha.abc = ag._sha384(Buffer.from("abc"));
out.sha.sig = ag._sha384(signal(640, 1));
// The Windows helpers as the server announces them (lower-case hex, as Node prints).
const fs = require("fs");
out.helper = {};
for (const [arch, file] of [["x64", "deskaudio-x64.exe"], ["x86", "deskaudio-x86.exe"]]) {
    const b = fs.readFileSync(path.join(__dirname, "..", "helpers", file));
    out.helper[arch] = { sha: require("crypto").createHash("sha384").update(b).digest("hex"), size: b.length, file: "helpers/" + file };
}
out.expectAudio = process.env.EXPECT_AUDIO === "1";
out.silentZero = ag._isSilent(Buffer.alloc(640));
out.silentSig = ag._isSilent(signal(640, 1));
process.stdout.write(JSON.stringify(out));
