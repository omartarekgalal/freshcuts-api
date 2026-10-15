/* ═══════════════════════════════════════════════════════════════════════════
   ⭐ مين يشوف ويسمع التقييمات الواطية في البورتال (RV1 — عمر ١٥/١٠/٢٠٢٦: «التقييمات لازم تظهر ف البورتال عند المدير»)

   قاعدة واحدة لكل الطرق اللي التقييم الواطي بيوصل بيها للبورتال:
     • شاشة «⭐ التقييمات» ومساراتها (portalreviews.js access).
     • البث الحي (portal.js broadcast): review_low / review_update، وتنبيه واتساب «تقييم واطي» (wa_handover / wa_handover_escalated
       اللي reason بتاعه review_low)، وقفل التنبيه ده من شاشة التقييمات (opts.scope = "reviews").
     • إشعارات Web Push وقايمة تحويلات واتساب في البورتال (wahandover.js) — والرنّة المتكررة (RG1) مابتشتغلش عليه خالص: الرنّة الهادية
       بتاعة شاشة التقييمات هي الرنّة الوحيدة.
     • تنبيهات الفريق على واتساب (waflow / wateam): للمدير، مش للكاشير.
   الجمهور: المدير (والمالك بمفتاح اللوحة = مدير في البورتال) دايماً · الكاشير بس لو waBot.reviewFlow.portalCashier مفتوح
   («الكاشير كمان يشوف التقييمات الواطية في البورتال» — مقفول افتراضياً) · المطبخ أبداً.
   من غير imports عشان portal.js و wahandover.js و waflow.js يستخدموه من غير ما يسحبوا البوت كله.
═══════════════════════════════════════════════════════════════════════════ */

/* أسباب تحويل واتساب اللي هي «تقييم واطي» (wareviews.starReply ⇒ handoff review_low) */
export const REVIEW_HANDOVER_REASONS = Object.freeze(["review_low"]);
/* أحداث شاشة التقييمات نفسها */
export const REVIEW_EVENTS = Object.freeze(["review_low", "review_update"]);

export const isReviewHandover = (reason) => REVIEW_HANDOVER_REASONS.includes(String(reason || ""));

/* الإعداد «الكاشير كمان يشوف التقييمات الواطية في البورتال» — نفس wareviews.reviewFlowConfig: مفتوح بس لو اتفتح صراحةً */
export function portalCashierOn(settings) {
  const f = settings && typeof settings === "object" && settings.waBot && typeof settings.waBot === "object" ? settings.waBot.reviewFlow : null;
  return Boolean(f && typeof f === "object" && f.portalCashier === true);
}

/* الدور ده يشوف التقييمات الواطية؟ */
export function reviewPortalRole(role, settings) {
  const r = String(role || "");
  return r === "manager" || (r === "cashier" && portalCashierOn(settings));
}

/* الحدث ده بتاع التقييمات؟ (البث بيفلتره بالدور) */
export function reviewScoped(event, data, opts = null) {
  if (opts && typeof opts === "object" && opts.scope === "reviews") return true;
  const ev = String(event || "");
  if (REVIEW_EVENTS.includes(ev)) return true;
  return /^wa_handover/.test(ev) && Boolean(data && typeof data === "object" && isReviewHandover(data.reason));
}

/* أدوار أجهزة الإشعارات (portal_push_subs.role) اللي توصلها نسخة تنبيه «تقييم واطي» */
export const reviewPushRoles = (settings) => (portalCashierOn(settings) ? ["manager", "cashier"] : ["manager"]);
