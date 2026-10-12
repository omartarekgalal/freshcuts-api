/* ═══════════════════════════════════════════════════════════════════════════
   waecho.js — «صدى» من موبايل المطعم: رد آلي ولا موظف؟ (مراجعة الخبير ١٢/١٠، M1)

   تطبيق واتساب بزنس بيرد لوحده على أول رسالة وعلى أسئلة الإعلان الجاهزة (ترحيب، «كيف أطلب من الموقع؟»، «وش عرض أول طلب؟»).
   الردود دي بتوصلنا «صدى» زي رسالة الكاشير بالظبط، وكانت بتتحسب «موظف بيرد» ⇒ البوت يسكت ٣٠ دقيقة مع كل عميل إعلان.

   القاعدة (التوقيت هو الحكم): الصدى «آلي» لو وصل خلال maxSec ثانية من آخر رسالة للعميل **و** نصه ٢٥ حرف أو أكتر.
   نفس النص بعدها بدقايق = رد سريع ضغطه إنسان ⇒ «موظف». ونص في قايمة المالك (autoEchoTexts) بالحرف = آلي لحد ٦٠ ثانية.
   التنازل المعروف: كاشير ضغط رد سريع خلال الثواني دي هيتحسب آلي، فالبوت ممكن يرد هو كمان. رد زيادة أرخص من سكوت.
   ═══════════════════════════════════════════════════════════════════════════ */
export const ECHO = Object.freeze({ maxSecDefault: 8, maxSecLimit: 30, minChars: 25, listMaxSec: 60, earlySec: 5, maxTexts: 30 });
/* شرط SQL لكل قارئ لـ«الموظف رد»: الصدى الآلي مش موظف. صف قديم من غير تصنيف (NULL) = موظف زي ما كان. */
export const STAFF_ECHO_SQL = "COALESCE(echo_kind,'staff') <> 'auto'";
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/* settings (كل الإعدادات) ⇒ { maxSec, texts } — maxSec = 0 يقفل التصنيف (كل صدى = موظف). */
export function echoSettings(settings) {
  const b = (settings && settings.waBot) || {};
  const n = Number(b.autoEchoMaxSec);
  const maxSec = Number.isFinite(n) && b.autoEchoMaxSec !== "" && b.autoEchoMaxSec !== null && b.autoEchoMaxSec !== undefined ? Math.min(ECHO.maxSecLimit, Math.max(0, Math.round(n))) : ECHO.maxSecDefault;
  const texts = (Array.isArray(b.autoEchoTexts) ? b.autoEchoTexts : []).map(norm).filter(Boolean).slice(0, ECHO.maxTexts);
  return { maxSec, texts };
}
/* deltaSec = وقت الصدى − وقت آخر رسالة للعميل (بالثواني؛ null = مفيش رسالة عميل قبله). سالب بسيط مسموح: وقت الصدى من ميتا بالثانية،
   ورسالة العميل بتتسجّل عندنا لحظة ما الويب هوك يوصل. ⇒ "auto" | "staff" */
export function echoKind({ text, deltaSec, maxSec = ECHO.maxSecDefault, texts = [] } = {}) {
  const t = norm(text), d = Number(deltaSec);
  if (!t || deltaSec === null || deltaSec === undefined || !Number.isFinite(d) || d < -ECHO.earlySec) return "staff";
  if (texts.includes(t) && d <= ECHO.listMaxSec) return "auto";
  if (maxSec > 0 && d <= maxSec && [...t].length >= ECHO.minChars) return "auto";
  return "staff";
}
