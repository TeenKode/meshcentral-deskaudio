// Check a raw s16le mono file for the test tone (see e2e/tone.js):
//   node e2e/check-pcm.js <file.raw> <rate> <label>
"use strict";
const fs = require("fs");
const { checkTone, s16ToFloat } = require("./tone");

const [file, rate, label] = [process.argv[2], parseInt(process.argv[3], 10), process.argv[4] || process.argv[2]];
const res = checkTone(s16ToFloat(fs.readFileSync(file)), rate, label);
console.log(res.summary || label);
res.fails.forEach((f) => console.log("FAIL " + f));
process.exit(res.fails.length ? 1 : 0);
