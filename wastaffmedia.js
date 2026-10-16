/* ═══════════════════════════════════════════════════════════════════════════
   الموظف بيبعت صورة / ملف / رسالة صوتية في محادثة واتساب — من اللوحة ومن البورتال (wastaffmedia.js) — MD3، ١٦/١٠/٢٠٢٦

   عمر (١٦/١٠): «عايز الموظفين لما يستلموا المحادثة يقدروا يبعتوا صور ومرفقات ويبعتوا برده صوت».

   نفس قواعد الرد النصي بالظبط (wastaff.reply): نفس الصلاحيات، نفس الأقفال (sendStateFor: القناة، مفتاح المالك، «إيقاف»،
   وضع التجربة)، **وجوّه نافذة الـ٢٤ ساعة بس** — النافذة مقفولة ⇒ رسالة عربي واضحة ومفيش حاجة بتترفع ولا بتتبعت.
   الترتيب: الفحص (النوع + الحجم + أول بايتات الملف) ⇒ الأقفال ⇒ (تحويل الصوت) ⇒ الرفع لميتا (wa.uploadMedia — مش إرسال) ⇒
   الإرسال من الباب الوحيد wa.sendFreeform ⇒ guardSend ⇒ deliver (الحارس بيعيد كل الفحوص بنفسه).

   حدود ميتا، متطبّقة هنا على السيرفر (الشاشة بتقولها قبل الرفع بس السيرفر هو الحكم):
     • صورة: jpeg / png لحد ٥ ميجا (ميتا: ٥).
     • ملف: pdf / word / excel / powerpoint / txt لحد ١٦ ميجا (ميتا بتقبل ١٠٠ — قصّيناها: ده رد على عميل، مش أرشيف).
     • صوت: ogg (opus) / mp4 (m4a, aac) / mpeg (mp3) / aac / amr لحد ١٦ ميجا (ميتا: ١٦).
   الصوت من المتصفح: كروم بيسجّل webm/opus وميتا بترفضه ⇒ ffmpeg (موجود في صورة السيرفر من MD1) بيحوّله ogg/opus
   (libopus، ولو مش موجود: نقل الصوت زي ما هو من webm لـogg من غير إعادة ترميز — كروم بيسجّل opus أصلاً).
   سفاري (الآيفون) بيسجّل mp4/aac ⇒ بنحاول نحوّله ogg/opus برضه (يوصل للعميل «رسالة صوتية» زي اللي من الموبايل)،
   ولو التحويل فشل بيتبعت mp4 زي ما هو (ميتا بتقبله كملف صوت). webm/wav من غير تحويل ⇒ رفض بسبب عربي، مفيش إرسال.

   السجل: الرسالة بتتسجّل في wa_messages بمصدر echo (إشارة «الموظف رد» للبوت — نفس أثر الرد النصي) ومعاها بيانات الملف
   (media: النوع ورقم ميتا والنوع والاسم) ⇒ بتظهر في المحادثة وملف العميل، والملف نفسه بيتخزن في wa_media_cache الخاص
   (wamedia.put) فبيتفتح على طول. مين بعت ومنين في wa_staff_replies (kind = image|document|audio).
═══════════════════════════════════════════════════════════════════════════ */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MB = 1024 * 1024;
export const LIMITS = Object.freeze({ image: 5 * MB, document: 16 * MB, audio: 16 * MB });
export const UPLOAD_MAX = 16 * MB + 512 * 1024;      // أكبر طلب بنقراه أصلاً (أكبر ملف + هامش الـmultipart)
export const CAPTION_MAX = 1024;                     // حد ميتا لتعليق الصورة/الملف
export const IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png"]);
export const DOC_TYPES = Object.freeze({
  "application/pdf": "pdf", "text/plain": "txt", "application/msword": "doc", "application/vnd.ms-excel": "xls", "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
});
export const AUDIO_DIRECT = Object.freeze(["audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/amr"]);      // ميتا بتقبلها زي ما هي
export const AUDIO_CONVERT = Object.freeze(["audio/webm", "audio/wav"]);                                              // لازم تتحوّل ogg/opus
const ALIAS = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/mp3": "audio/mpeg", "audio/opus": "audio/ogg",
  "audio/aacp": "audio/aac", "audio/x-aac": "audio/aac", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "video/webm": "audio/webm", "application/ogg": "audio/ogg" };
const EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heic", pdf: "application/pdf", txt: "text/plain",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", amr: "audio/amr", webm: "audio/webm", wav: "audio/wav" };
const mbAr = (n) => `${Math.round(n / MB)} ميجا`;
const KIND_AR = { image: "الصورة", document: "الملف", audio: "التسجيل" };

export const AR = Object.freeze({
  no_file: "مفيش ملف في الطلب — اختار صورة أو ملف أو سجّل صوت",
  empty_file: "الملف فاضي",
  bad_type: "النوع ده مش مسموح على واتساب — صور jpg/png، ملفات pdf/word/excel/powerpoint/txt، أو صوت",
  heic: "صورة الآيفون بصيغة HEIC — اختارها تاني من الشاشة (بتتحوّل JPG لوحدها) أو ابعتها كـscreenshot",
  mismatch: "محتوى الملف مش زي امتداده — اتأكد إنه ملف سليم",
  caption_too_long: `التعليق أطول من ${CAPTION_MAX} حرف`,
  too_large_body: `الملف أكبر من ${mbAr(16 * MB)}`,
  convert_failed: "التسجيل ده محتاج تحويل والسيرفر ماقدرش يحوّله — سجّل من الآيفون أو ابعت ملف صوت mp3/m4a",
  upload_failed: "واتساب مارضاش ياخد الملف — جرّب تاني بعد شوية",
  bad_phone: "رقم العميل مش سليم",
  bad_body: "الطلب مش مفهوم — حدّث الصفحة وجرّب تاني",
});
export const tooLargeAr = (kind) => `${KIND_AR[kind] || "الملف"} أكبر من ${mbAr(LIMITS[kind] || 16 * MB)} — ${kind === "image" ? "صغّرها أو ابعتها كملف" : "ابعت ملف أصغر"}`;

const baseMime = (m) => { const b = String(m || "").split(";")[0].trim().toLowerCase(); return ALIAS[b] || b; };
const extOf = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };

/* أول بايتات الملف ⇒ نوعه الحقيقي (تقريبي). null = مش عارفين. */
export function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const h = (i, ...b) => b.every((x, k) => buf[i + k] === x);
  const ascii = (i, s) => buf.length >= i + s.length && buf.toString("latin1", i, i + s.length) === s;
  if (h(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (h(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (ascii(0, "%PDF")) return "application/pdf";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (h(0, 0x1a, 0x45, 0xdf, 0xa3)) return "audio/webm";
  if (ascii(4, "ftyp")) { const brand = buf.toString("latin1", 8, 12); return /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand) ? "image/heic" : "audio/mp4"; }
  if (ascii(0, "#!AMR")) return "audio/amr";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0)) return "audio/mpeg";
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return "audio/aac";
  if (h(0, 0x50, 0x4b, 0x03, 0x04)) return "zip";
  if (h(0, 0xd0, 0xcf, 0x11, 0xe0)) return "ole";
  return null;
}
const looksText = (buf) => !buf.subarray(0, 4096).includes(0);

/* الملف مسموح؟ ⇒ {ok, kind, mime, convert, ext} أو {ok:false, error, message}. voice = اتسجّل من الشاشة. */
export function classify({ mime, name, buf, voice = false } = {}) {
  const bad = (error, message) => ({ ok: false, error, message: message || AR[error] });
  if (!Buffer.isBuffer(buf)) return bad("no_file");
  if (!buf.length) return bad("empty_file");
  let m = baseMime(mime);
  if (!m || m === "application/octet-stream") m = EXT[extOf(name)] || "";
  const sn = sniff(buf);
  if (m === "image/heic" || m === "image/heif" || sn === "image/heic") return bad("heic");
  let kind = null, convert = false;
  if (IMAGE_TYPES.includes(m)) kind = "image";
  else if (DOC_TYPES[m]) kind = "document";
  else if (AUDIO_DIRECT.includes(m)) kind = "audio";
  else if (AUDIO_CONVERT.includes(m)) { kind = "audio"; convert = true; }
  else if (/^video\/mp4$/.test(m) && voice) { kind = "audio"; m = "audio/mp4"; }      // سفاري ساعات بيسمّي تسجيل الصوت video/mp4
  if (!kind) return bad("bad_type");
  if (voice && kind !== "audio") return bad("bad_type");
  if (buf.length > LIMITS[kind]) return { ok: false, error: "too_large", message: tooLargeAr(kind) };
  /* المحتوى لازم يطابق النوع اللي اتقال (ملف متنكّر ⇒ مرفوض) */
  if (kind === "image" && sn !== m) return bad("mismatch");
  if (kind === "audio") {
    if (!sn || !sn.startsWith("audio/")) return bad("mismatch");
    if (sn !== m) { m = sn; convert = AUDIO_CONVERT.includes(m); }      // الامتداد غلط بس المحتوى صوت سليم ⇒ بنمشي بالمحتوى
  }
  if (kind === "document") {
    const ext = DOC_TYPES[m];
    const want = ext === "pdf" ? "application/pdf" : ["docx", "xlsx", "pptx"].includes(ext) ? "zip" : ["doc", "xls", "ppt"].includes(ext) ? "ole" : null;
    if (want ? sn !== want : !looksText(buf)) return bad("mismatch");
  }
  return { ok: true, kind, mime: m, convert, ext: DOC_TYPES[m] || extOf(name) || null };
}

/* تعليق الصورة/الملف: مقصوص، ١٠٢٤ حرف بالكتير. الصوت مالوش تعليق عند ميتا. */
export function cleanCaption(raw) {
  const t = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (t.length > CAPTION_MAX) return { ok: false, error: "caption_too_long" };
  return { ok: true, text: t };
}
/* اسم الملف اللي العميل هيشوفه: من غير مسارات ولا رموز تحكّم، بامتداده الصح */
export function safeFileName(name, ext) {
  let n = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|*?:]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!n || n.startsWith(".")) n = `ملف${n}`;
  if (ext && extOf(n) !== ext) n = `${n.replace(/\.[a-z0-9]{1,5}$/i, "")}.${ext}`;
  return n;
}

/* ffmpeg من غير shell: الملف بيتكتب في ملف مؤقت (mp4 من سفاري ساعات فهرسه في الآخر فمايتقريش من pipe)، والناتج على stdout */
function runFfmpeg(bin, args, input, timeoutMs) {
  return new Promise((resolve) => {
    let done = false; const out = [];
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try { p = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] }); } catch { return end(null); }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* خلص */ } end(null); }, timeoutMs);
    p.on("error", () => { clearTimeout(t); end(null); });
    p.stdout.on("data", (d) => out.push(d));
    p.on("close", (code) => { clearTimeout(t); const b = Buffer.concat(out); end(code === 0 ? b : null); });
    void input;
  });
}
/* أي صوت ⇒ ogg/opus مونو (زي رسالة واتساب الصوتية). بيرجّع {buf, mime:"audio/ogg", how} أو null. */
export async function toOggOpus(buf, mime, { bin = "ffmpeg", timeoutMs = 30_000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wamd3-")).catch(() => null);
  if (!dir) return null;
  const inFile = path.join(dir, `in-${crypto.randomBytes(4).toString("hex")}`);
  try {
    await fs.writeFile(inFile, buf);
    const base = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", inFile, "-vn", "-map_metadata", "-1"];
    const ok = (b) => Buffer.isBuffer(b) && b.length > 100 && b.toString("latin1", 0, 4) === "OggS";
    let b = await runFfmpeg(bin, [...base, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1"], null, timeoutMs);
    if (ok(b)) return { buf: b, mime: "audio/ogg", how: "libopus" };
    if (baseMime(mime) === "audio/webm") {      // من غير libopus: كروم بيسجّل opus أصلاً ⇒ ننقله لـogg من غير إعادة ترميز
      b = await runFfmpeg(bin, [...base, "-c:a", "copy", "-f", "ogg", "pipe:1"], null, timeoutMs);
      if (ok(b)) return { buf: b, mime: "audio/ogg", how: "remux" };
    }
    return null;
  } catch { return null; }
  finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
/* السيرفر عنده ffmpeg؟ وفيه libopus؟ — مرة واحدة لكل تشغيل (الشاشة بتسأل عشان تعرف تسجّل webm ولا لأ) */
let capsP = null;
export function ffmpegCaps({ bin = "ffmpeg", fresh = false } = {}) {
  if (capsP && !fresh) return capsP;
  capsP = new Promise((resolve) => {
    let out = ""; let p;
    try { p = spawn(bin, ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return resolve({ ffmpeg: false, opus: false }); }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* خلص */ } resolve({ ffmpeg: false, opus: false }); }, 10_000);
    p.on("error", () => { clearTimeout(t); resolve({ ffmpeg: false, opus: false }); });
    p.stdout.on("data", (d) => { out += d.toString("latin1"); });
    p.on("close", (code) => { clearTimeout(t); resolve({ ffmpeg: code === 0, opus: code === 0 && /\blibopus\b/.test(out) }); });
  });
  return capsP;
}
/* اللي الشاشة محتاجاه قبل ما تفتح زرار الملفات والمايك */
export async function capsView(caps) {
  const c = await caps().catch(() => ({ ffmpeg: false, opus: false }));
  return { ok: true, limits: { ...LIMITS }, captionMax: CAPTION_MAX, image: [...IMAGE_TYPES], document: Object.values(DOC_TYPES), audio: [...AUDIO_DIRECT],
    voice: { ffmpeg: c.ffmpeg === true, opus: c.opus === true, webm: c.ffmpeg === true, mp4: true, ogg: true } };
}

/* الطلب (multipart: file + caption + voice) ⇒ {ok, file:{buf, mime, name}, caption, voice} أو {ok:false, status, error, message}.
   الحجم بيتشاف من الهيدر قبل ما نقرا الجسم (مانحملش ١٠٠ ميجا في الذاكرة عشان نرفضها). */
export async function readUpload(c, { max = UPLOAD_MAX } = {}) {
  const len = Number(c.req.header("content-length") || 0);
  if (len > max) return { ok: false, status: 413, error: "too_large", message: AR.too_large_body };
  let body;
  try { body = await c.req.parseBody(); } catch { return { ok: false, status: 400, error: "bad_body", message: AR.bad_body }; }
  const f = body && body.file;
  if (!f || typeof f !== "object" || typeof f.arrayBuffer !== "function") return { ok: false, status: 400, error: "no_file", message: AR.no_file };
  if (Number(f.size) > max) return { ok: false, status: 413, error: "too_large", message: AR.too_large_body };
  const buf = Buffer.from(await f.arrayBuffer());
  return { ok: true, file: { buf, mime: String(f.type || ""), name: String(f.name || "") }, caption: typeof body.caption === "string" ? body.caption : "", voice: body.voice === "1" || body.voice === "true" };
}

const PLACE = { image: "[صورة]", audio: "[رسالة صوتية]" };
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const normPhone = (raw) => { const d = String(raw || "").replace(/\D/g, "").replace(/^(00966|966)/, "").replace(/^0/, ""); return /^5\d{8}$/.test(d) ? d : ""; };

/* deps: { pool, wa: {uploadMedia, sendFreeform}, staff: {ready, sendStateFor, owner, media}, gates: [..], gateAr: {..}, convert?, caps?, log? } */
export function create(deps) {
  const { pool, wa } = deps;
  const log = deps.log || console;
  const staff = deps.staff || {};
  const gates = deps.gates || [];
  const gateAr = deps.gateAr || {};
  const convert = deps.convert || toOggOpus;
  const caps = deps.caps || (() => ffmpegCaps());
  const ready = Promise.resolve(staff.ready).then(() => pool.query("ALTER TABLE wa_staff_replies ADD COLUMN IF NOT EXISTS kind TEXT")).then(() => true)
    .catch((e) => { log.error("[wa-staff-media] schema:", e.message); return false; });

  /* بيرجّع {ok, wamid, test, kind, converted} أو {ok:false, status, error, gate, message} — من غير أي استثناء */
  async function send({ phoneNorm, file, caption = "", voice = false, by = null, role = null, via = "dashboard" }) {
    const no = (status, error, message, gate = null) => ({ ok: false, status, error, gate, message: message || AR[error] || undefined });
    const pn = normPhone(phoneNorm);
    if (!pn) return no(400, "bad_phone");
    if (!wa || typeof wa.uploadMedia !== "function" || typeof wa.sendFreeform !== "function") return no(409, "disabled", gateAr.disabled, "disabled");
    const cls = classify({ mime: file && file.mime, name: file && file.name, buf: file && file.buf, voice });
    if (!cls.ok) return no(cls.error === "too_large" ? 413 : 400, cls.error, cls.message);
    const cap = cls.kind === "audio" ? { ok: true, text: "" } : cleanCaption(caption);
    if (!cap.ok) return no(400, cap.error);
    /* الأقفال الأول: النافذة مقفولة / القناة مقفولة / «إيقاف» ⇒ ولا رفع ولا إرسال */
    let st;
    try { st = await staff.sendStateFor(pn); } catch (e) { log.error("[wa-staff-media] state:", e.message); st = { ok: false, gate: "settings_unreadable" }; }
    if (!st || !st.ok) return no(409, st && st.gate ? st.gate : "disabled", gateAr[st && st.gate] || undefined, st && st.gate ? st.gate : "disabled");
    let buf = file.buf, mime = cls.mime, converted = null;
    if (cls.kind === "audio" && mime !== "audio/ogg") {
      let c = null; try { c = await convert(buf, mime); } catch (e) { log.error("[wa-staff-media] convert:", e.message); c = null; }
      if (c && Buffer.isBuffer(c.buf) && c.buf.length) { buf = c.buf; mime = "audio/ogg"; converted = c.how || "ffmpeg"; }
      else if (cls.convert) return no(422, "convert_failed");
      if (buf.length > LIMITS.audio) return no(413, "too_large", tooLargeAr("audio"));
    }
    const filename = cls.kind === "document" ? safeFileName(file.name, cls.ext) : null;
    const up = await wa.uploadMedia({ buf, mime, filename: filename || `${cls.kind}.${mime === "audio/ogg" ? "ogg" : (cls.ext || "bin")}` });
    if (!up || !up.ok) {
      if (up && ["disabled", "unconfigured"].includes(up.error)) return no(409, up.error, gateAr[up.error], up.error);
      log.error("[wa-staff-media] upload:", up && up.code, up && up.message);
      return no(502, "upload_failed", up && up.code ? `${AR.upload_failed} (${up.code})` : AR.upload_failed);
    }
    const obj = { id: up.id, ...(cap.text ? { caption: cap.text } : {}), ...(filename ? { filename } : {}) };
    const body = cap.text || (cls.kind === "document" ? `[ملف: ${filename}]` : PLACE[cls.kind]);
    const meta = { kind: cls.kind, id: up.id, mime, ...(cls.kind === "audio" ? { voice: mime === "audio/ogg" } : {}), ...(filename ? { filename } : {}) };
    /* source:"echo" = «الموظف رد» عند البوت (نفس الرد النصي). الحارس بيعيد كل الفحوص قبل ما يدّي التذكرة. */
    const r = await wa.sendFreeform({ phoneNorm: pn, payload: { type: cls.kind, [cls.kind]: obj }, source: "echo", test: st.test === true, preview: body, media: meta });
    if (!r || !r.ok) {
      const gate = r && r.skipped && gates.includes(r.skipped) ? r.skipped : null;
      return no(409, (r && (r.skipped || r.error)) || "send_failed", (gate && gateAr[gate]) || (r && r.message) || "الرسالة ماتبعتتش", gate);
    }
    await ready;
    try {
      await pool.query("INSERT INTO wa_staff_replies(phone_norm, wamid, by_name, role, via, test, chars, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (wamid) DO NOTHING",
        [pn, r.wamid || null, clip(by, 60), clip(role, 20), clip(via, 20), st.test === true, cap.text.length, cls.kind]);
      await pool.query("UPDATE wa_threads SET unread=0, read_at=NOW(), read_by=$2, updated_at=NOW() WHERE phone_norm=$1", [pn, clip(by || role, 60)]);
    } catch (e) { log.error("[wa-staff-media] log:", e.message); }
    try { if (staff.owner && typeof staff.owner.touch === "function") await staff.owner.touch(pn); } catch (e) { log.error("[wa-staff-media] owner:", e.message); }
    /* الملف اللي رفعناه بيتخزن نسخة خاصة على طول ⇒ المحادثة تفتحه من غير ما نجيبه من ميتا */
    try {
      if (r.wamid && staff.media && typeof staff.media.put === "function") {
        const row = (await pool.query("SELECT id FROM wa_messages WHERE wamid=$1 LIMIT 1", [r.wamid])).rows[0];
        if (row && row.id) await staff.media.put(row.id, mime, buf);
      }
    } catch (e) { log.error("[wa-staff-media] cache:", e.message); }
    return { ok: true, wamid: r.wamid || null, test: st.test === true, kind: cls.kind, converted };
  }

  return { ready, send, caps: () => capsView(caps) };
}
