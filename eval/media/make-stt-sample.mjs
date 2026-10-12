// Turns the synthesized phrase (eval/media/stt-sample-raw.wav, made with Windows' ar-SA voice «Naayf» saying «السلام عليكم ورحمة الله»)
// into the small sample bundled with the API: mono 16-bit PCM at half the rate, silence trimmed → ../../wasttsample.js
//   node eval/media/make-stt-sample.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const b = fs.readFileSync(path.join(HERE, "stt-sample-raw.wav"));
if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") throw new Error("not a wav file");
let off = 12, fmt = null, data = null;
while (off + 8 <= b.length) { const id = b.toString("latin1", off, off + 4), size = b.readUInt32LE(off + 4); if (id === "fmt ") fmt = { ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22), tag: b.readUInt16LE(off + 8) }; if (id === "data") { data = b.subarray(off + 8, Math.min(b.length, off + 8 + size)); break; } off += 8 + size + (size % 2); }
if (!fmt || !data || fmt.tag !== 1 || fmt.bits !== 16) throw new Error("expected 16-bit PCM: " + JSON.stringify(fmt));
const n = Math.floor(data.length / 2 / fmt.ch), mono = new Int16Array(n);
for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2); mono[i] = Math.round(s / fmt.ch); }
const step = fmt.rate >= 22000 ? 2 : 1, rate = fmt.rate / step;
let out = new Int16Array(Math.floor(n / step));
for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < step; k++) s += mono[i * step + k]; out[i] = Math.round(s / step); }
const loud = (v) => Math.abs(v) > 300, pad = Math.round(rate * 0.12);
let a = 0, z = out.length - 1; while (a < z && !loud(out[a])) a++; while (z > a && !loud(out[z])) z--;
out = out.subarray(Math.max(0, a - pad), Math.min(out.length, z + pad));
const pcm = Buffer.alloc(out.length * 2); for (let i = 0; i < out.length; i++) pcm.writeInt16LE(out[i], i * 2);
const h = Buffer.alloc(44); h.write("RIFF", 0, "latin1"); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8, "latin1"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36, "latin1"); h.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([h, pcm]), sec = Math.round((out.length / rate) * 100) / 100;
const b64 = wav.toString("base64").replace(/(.{120})/g, "$1\n");
const NL = String.fromCharCode(10);
fs.writeFileSync(path.join(HERE, "..", "..", "wasttsample.js"), [
  "/* عيّنة اختبار مفتاح تحويل الصوت لنص: «السلام عليكم ورحمة الله» بصوت ويندوز العربي (ar-SA)، wav أحادي 16-bit.",
  "   متولّدة بـ eval/media/make-stt-sample.mjs — ماتتعدّلش بالإيد. */",
  `export const STT_SAMPLE = Object.freeze({ text: "السلام عليكم ورحمة الله", expect: "سلام", mime: "audio/wav", seconds: ${sec}, rate: ${rate}, bytes: ${wav.length} });`,
  "export const STT_SAMPLE_B64 = `", b64.trimEnd(), "`.split(String.fromCharCode(10)).join(\"\");",
  "export const sttSampleBuffer = () => Buffer.from(STT_SAMPLE_B64, \"base64\");", ""].join(NL));
console.log(JSON.stringify({ in: fmt, rate, seconds: sec, bytes: wav.length }));
