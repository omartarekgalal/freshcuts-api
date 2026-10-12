/* ═══════════════════════════════════════════════════════════════════════════
   صور وصوت وفيديو وملفات محادثات واتساب (wamedia.js) — MD1، ١٣/١٠/٢٠٢٦

   عمر: «الصوت والصور مش بيفتحوا في المحادثات». السبب: الويب هوك كان بيسجّل «[صورة]» / «[رسالة صوتية]» بس، ورقم
   الملف عند ميتا ماكانش بيتحفظ. من الشريحة دي whatsapp.js بيحفظ بيانات الملف (wa_messages.media) لكل رسالة جديدة،
   والملف ده بيجيبه من ميتا **بتوكن السيرفر** (wa.fetchMedia — التوكن مابيطلعش من whatsapp.js) وبيخزّنه عندنا.

   • التخزين خاص: جدول wa_media_cache (مش مخزن الوسائط العام /api/content/media اللي روابطه مفتوحة لأي حد) —
     دي صور وتسجيلات عملاء. الملف بيتقدّم بس من مسار عليه صلاحية المحادثات (لوحة: أدوار الصندوق · بورتال: كاشير ومدير)،
     ولازم الرسالة تكون في نفس المحادثة اللي مفتاحها في الرابط.
   • المتصفح مابياخدش رقم ملف ميتا ولا رابطه ولا التوكن: المرجع = رقم صف الرسالة عندنا.
   • الرسايل الصوتية ogg/opus: سفاري على الآيفون قبل iOS 18.4 مابيشغّلهاش. ‎?as=mp3‎ بيحوّلها بـffmpeg (لو موجود في
     صورة السيرفر) وبيخزّن النسخة؛ من غيره ⇒ 501 transcode_unavailable والشاشة تعرض تحميل الملف.
   • الأنواع المسموحة ثابتة (مفيش HTML ولا SVG بيتقدّم كصفحة): الملفات بتنزل كـattachment بنوع octet-stream.
   • رسايل ما قبل الشريحة مالهاش بيانات ملف ⇒ مابتتفتحش (media = null)، والشاشة بتقول كده.
═══════════════════════════════════════════════════════════════════════════ */
import { spawn } from "node:child_process";

export const MAX_BYTES = 25 * 1024 * 1024;
export const KEEP = Object.freeze({ def: 30, min: 1, max: 180 });
const SAFE = {
  image: ["image/jpeg", "image/png", "image/webp"],
  sticker: ["image/webp"],
  audio: ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "audio/opus"],
  video: ["video/mp4", "video/3gpp"],
};
const baseMime = (m) => String(m || "").split(";")[0].trim().toLowerCase();

export function keepDays(settings) {
  const v = Number(settings && settings.waInbox && settings.waInbox.mediaKeepDays);
  return Number.isFinite(v) ? Math.min(KEEP.max, Math.max(KEEP.min, Math.round(v))) : KEEP.def;
}
/* اللي الشاشة بتشوفه عن ملف الرسالة — من غير رقم ميتا. row = صف wa_messages (id, media). */
export function publicMedia(row) {
  const m = row && row.media && typeof row.media === "object" ? row.media : null;
  if (!m || !m.id || !SAFE_KIND(m.kind)) return null;
  return { ref: String(row.id), kind: m.kind, mime: baseMime(m.mime) || null, voice: m.voice === true, filename: m.filename ? String(m.filename).slice(0, 120) : null,
    caption: m.caption ? String(m.caption).slice(0, 1000) : null };
}
const SAFE_KIND = (k) => ["image", "sticker", "audio", "video", "document"].includes(k);
/* نوع المحتوى اللي بيتقدّم + طريقة العرض. أي نوع بره القايمة ⇒ تحميل كملف خام. */
export function servedType(kind, mime) {
  const b = baseMime(mime);
  if (SAFE[kind] && SAFE[kind].includes(b)) return { type: b, inline: true };
  return { type: "application/octet-stream", inline: false };
}
export const needsTranscode = (mime) => /^audio\/(ogg|opus|amr)$/.test(baseMime(mime));
const safeName = (s, fallback) => (String(s || "").replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 80) || fallback);

/* ogg/opus ⇒ mp3 بـffmpeg من stdin لـstdout. بيرجّع Buffer أو null لو ffmpeg مش موجود/فشل. */
export function ffmpegMp3(buf, { bin = "ffmpeg", timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let done = false; const out = [];
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try { p = spawn(bin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] }); }
    catch { return end(null); }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* خلص */ } end(null); }, timeoutMs);
    p.on("error", () => { clearTimeout(t); end(null); });
    p.stdout.on("data", (d) => out.push(d));
    p.on("close", (code) => { clearTimeout(t); const b = Buffer.concat(out); end(code === 0 && b.length > 200 ? b : null); });
    p.stdin.on("error", () => { /* ffmpeg قفل بدري */ });
    p.stdin.end(buf);
  });
}

const DDL = `CREATE TABLE IF NOT EXISTS wa_media_cache (
  msg_id BIGINT NOT NULL, variant TEXT NOT NULL DEFAULT 'orig', mime TEXT, size INT NOT NULL, bytes BYTEA NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (msg_id, variant));
CREATE INDEX IF NOT EXISTS wa_media_cache_at ON wa_media_cache (fetched_at)`;

/* deps: { pool, wa: { fetchMedia(id, {maxBytes}) }, getSettingsData, transcode?(buf) ⇒ Buffer|null, log?, noTimer? } */
export function create(deps) {
  const { pool, wa, getSettingsData } = deps;
  const log = deps.log || console;
  const transcode = deps.transcode || ((buf) => ffmpegMp3(buf));
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-media] schema:", e.message); return false; });
  const fail = (status, error, message) => ({ ok: false, status, error, message });
  const AR = { not_found: "الملف مش موجود في المحادثة دي", expired: "الملف مابقاش متاح عند واتساب (بيتمسح بعد مدة)", too_large: "الملف أكبر من ٢٥ ميجا — افتحه من موبايل المطعم",
    unavailable: "تعذر جلب الملف من واتساب — جرّب تاني", transcode_unavailable: "تحويل الصوت مش متاح على السيرفر — حمّل الملف" };

  async function cached(id, variant) {
    const r = await pool.query("SELECT mime, size, bytes FROM wa_media_cache WHERE msg_id=$1 AND variant=$2", [id, variant]);
    return r.rows[0] || null;
  }
  const store = (id, variant, mime, buf) => pool.query(
    `INSERT INTO wa_media_cache(msg_id, variant, mime, size, bytes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (msg_id, variant) DO UPDATE SET mime=$3, size=$4, bytes=$5, fetched_at=NOW()`,
    [id, variant, mime, buf.length, buf]).catch((e) => log.error("[wa-media] store:", e.message));

  /* الملف نفسه: {ok, buf, type, inline, filename} أو {ok:false, status, error, message}. phoneNorm = صاحب المحادثة اللي في الرابط. */
  async function get({ phoneNorm, ref, as = null }) {
    const id = Number(ref);
    if (!Number.isSafeInteger(id) || id <= 0 || !/^5\d{8}$/.test(String(phoneNorm || ""))) return fail(404, "not_found", AR.not_found);
    await ready;
    const row = (await pool.query("SELECT id, phone_norm, media FROM wa_messages WHERE id=$1", [id])).rows[0];
    const m = row && row.phone_norm === phoneNorm && row.media && typeof row.media === "object" ? row.media : null;
    if (!m || !m.id || !SAFE_KIND(m.kind)) return fail(404, "not_found", AR.not_found);
    const name = safeName(m.filename, `${m.kind}-${id}`);
    let orig = await cached(id, "orig");
    if (!orig) {
      if (!wa || typeof wa.fetchMedia !== "function") return fail(503, "unavailable", AR.unavailable);
      let r; try { r = await wa.fetchMedia(String(m.id), { maxBytes: MAX_BYTES }); } catch (e) { log.error("[wa-media] fetch:", e.message); r = { ok: false, error: "unavailable" }; }
      if (!r || !r.ok) {
        const err = r && ["expired", "too_large"].includes(r.error) ? r.error : "unavailable";
        return fail(err === "expired" ? 410 : err === "too_large" ? 413 : 502, err, AR[err]);
      }
      orig = { mime: baseMime(r.mime || m.mime), size: r.buf.length, bytes: r.buf };
      await store(id, "orig", orig.mime, r.buf);
    }
    if (as === "mp3") {
      if (m.kind !== "audio") return fail(400, "not_audio", "التحويل للرسايل الصوتية بس");
      if (!needsTranscode(orig.mime)) return { ok: true, buf: orig.bytes, type: servedType("audio", orig.mime).type, inline: true, filename: name };
      let mp3 = await cached(id, "mp3");
      if (!mp3) {
        let b = null; try { b = await transcode(Buffer.from(orig.bytes)); } catch (e) { log.error("[wa-media] transcode:", e.message); }
        if (!b) return fail(501, "transcode_unavailable", AR.transcode_unavailable);
        mp3 = { mime: "audio/mpeg", size: b.length, bytes: b };
        await store(id, "mp3", "audio/mpeg", b);
      }
      return { ok: true, buf: mp3.bytes, type: "audio/mpeg", inline: true, filename: `${name}.mp3` };
    }
    const st = servedType(m.kind, orig.mime);
    return { ok: true, buf: orig.bytes, type: st.type, inline: st.inline, filename: name };
  }
  /* رد HTTP جاهز لمسار Hono */
  async function serve(c, { phoneNorm, ref, as = null }) {
    let r; try { r = await get({ phoneNorm, ref, as }); } catch (e) { log.error("[wa-media] serve:", e.message); r = fail(500, "unavailable", AR.unavailable); }
    if (!r.ok) return c.json({ ok: false, error: r.error, message: r.message }, r.status);
    return c.body(r.buf, 200, { "Content-Type": r.type, "Content-Length": String(r.buf.length), "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff", "Content-Disposition": `${r.inline ? "inline" : "attachment"}; filename="${r.filename}"` });
  }
  /* بيمسح النسخ الأقدم من مدة الاحتفاظ (settings.waInbox.mediaKeepDays). الملف يتجاب تاني من ميتا لو لسه عندهم. */
  async function cleanup() {
    try { await ready; const d = keepDays(await getSettingsData().catch(() => ({}))); const r = await pool.query("DELETE FROM wa_media_cache WHERE fetched_at < NOW() - make_interval(days => $1::int)", [d]); return r.rowCount || 0; }
    catch (e) { log.error("[wa-media] cleanup:", e.message); return 0; }
  }
  let timer = null;
  if (!deps.noTimer) { timer = setInterval(() => { cleanup().catch(() => {}); }, 6 * 3600_000); if (timer.unref) timer.unref(); }
  return { ready, get, serve, cleanup, stop: () => { if (timer) clearInterval(timer); } };
}
