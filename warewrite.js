/* 💸 UT2 (عمر ١٩/١٠: «متوقفش اي حاجة دلوقتي زي ما احنا بس ادخل قدم صيغة خدمية وناخد موافقة ع القالب ونتابع ميتا ونغيره»)
   خريطة «القديم ← الجديد» للقوالب الخدمية اللي ميتا صنّفتها تسويق، والقرار الصافي: المُرسل يستخدم أنهي واحد دلوقتي.
   ملف لوحده من غير أي import (whatsapp.js / wacloud.js / wautility-cfg.js بيقروه).

   القاعدة (pickRewrite):
     • المُرسل بيفضل على القديم لحد ما الجديد يبقى **APPROVED** عند ميتا **وفئته الحيّة UTILITY** (نفس اللغة بالظبط) **والمفتاح بتاع الخريطة مفتوح**.
     • الجديد اترفض / اتصنّف تسويق / اتوقف ⇒ القديم يفضل، والحالة بتتسجّل (wa_rewrite_log) — مفيش إعادة تقديم لوحدها.
     • مانعرفش (ميتا مش مقروءة / مش متقدّم) ⇒ القديم. مفيش حالة بتخلّي الجديد يتبعت من غير ما ميتا تقول APPROVED + UTILITY.
     • wired=false = المُرسل القديم مش واتساب أصلاً (SMS / إشعار) ⇒ الخريطة بتتابع الحالة بس، ومفيش تبديل لحد ما المالك يقرر الربط. */
export const UTILITY_REWRITES = Object.freeze([
  Object.freeze({ key: "reviewStars", old: "fc_review_stars", new: "fc_review_order_v3", lang: "ar", audience: "customer", wired: true,
    sender: "wabotrun.reviewAsk (قالب النجوم بره النافذة — الموقع والكاشير وكيتا)",
    why: "ميتا صنّفت fc_review_stars تسويق ١٦/١٠ ({{1}} حر «زيارتك للمطعم» + «تشكرك 🌟» + 👇). الجديد: رقم الطلب + تاريخه، من غير إيموجي، نفس الأزرار." }),
  Object.freeze({ key: "inboxSummary", old: "fc_staff_inbox_summary", new: "fc_staff_inbox_alert", lang: "ar", audience: "staff", wired: true,
    sender: "wateam (الملخص اليومي / ملخص الغريب / تنبيه من غير عميل / زر التجربة)",
    why: "ميتا اعتمدت fc_staff_inbox_summary العربي MARKETING (والإنجليزي UTILITY لنفس المعنى) ١٩/١٠. الجديد «تنبيه» بعدد الحاجات المستنية بدل «ملخص»." }),
  Object.freeze({ key: "taskNotice", old: "fc_staff_task_notice", new: "fc_staff_task_alert", lang: "en", audience: "staff", wired: true,
    sender: "wateam (رسالة المالك لموظف — النسخة الإنجليزي؛ wateam بيبعت العربي دلوقتي)",
    why: "ميتا اعتمدت fc_staff_task_notice الإنجليزي MARKETING (والعربي UTILITY) ١٩/١٠." }),
  Object.freeze({ key: "checkoutWatchdog", old: "fc_staff_checkout_watchdog", new: "fc_staff_payment_notice", lang: "ar", audience: "staff", wired: false,
    sender: "مش مربوط — حارس الشيك أوت بيبعت SMS (staffalerts.js)",
    why: "ميتا صنّفت العربي MARKETING («جرّب الموقع الحين»)؛ الإنجليزي رجع UTILITY بعد المراجعة." }),
  Object.freeze({ key: "waitlistOpen", old: "fc_waitlist_open", new: "fc_open_request_update", lang: "ar", audience: "customer", wired: false,
    sender: "مش مربوط — «نبّهني لما تفتحوا» بيروح SMS + إشعار (openwait.js)",
    why: "fc_waitlist_open تسويق بطبيعته (سلة + رابط). الجديد تحديث حالة طلب التنبيه نفسه، من غير زر." }),
]);
export const REWRITE_KEYS = Object.freeze(UTILITY_REWRITES.map((m) => m.key));
/* مفتاح المالك لكل خريطة في settings.waBot.utilityFirst (مجموعة «الخدمي أولاً» في «كل إعدادات البوت») */
export const rewriteSwitchOf = (key) => `rewrite${key.charAt(0).toUpperCase()}${key.slice(1)}`;
export const REWRITE_SWITCHES = Object.freeze(REWRITE_KEYS.map(rewriteSwitchOf));
export const rewriteByOld = (name, lang) => UTILITY_REWRITES.find((m) => m.old === name && m.lang === String(lang || "ar").slice(0, 2)) || null;
export const rewriteByKey = (key) => UTILITY_REWRITES.find((m) => m.key === key) || null;

/* القرار الصافي ⇒ { use: "old"|"new", name, state, record } — record=true = حالة تستاهل تتسجّل (اترفض / اتصنّف تسويق / اتوقف / اتبدّل).
   state: switch_off | unknown | not_submitted | pending | rejected | reclassified | paused | in_use | ready_not_wired */
export function pickRewrite({ map, switchOn = true, status = null, category = null }) {
  const old = { use: "old", name: map.old };
  const st = status ? String(status).toUpperCase() : null, cat = category ? String(category).toUpperCase() : null;
  if (!st) return { ...old, state: "unknown", record: false };
  if (st === "NOT_SUBMITTED") return { ...old, state: "not_submitted", record: false };
  if (st === "PENDING" || st === "IN_APPEAL" || st === "PENDING_DELETION") return { ...old, state: "pending", record: false };
  if (st === "REJECTED") return { ...old, state: "rejected", record: true };
  if (st !== "APPROVED") return { ...old, state: "paused", record: true };      // PAUSED / DISABLED / LIMIT_EXCEEDED
  if (cat !== "UTILITY") return { ...old, state: cat ? "reclassified" : "unknown", record: Boolean(cat) };
  if (!map.wired) return { ...old, state: "ready_not_wired", record: true };
  if (!switchOn) return { ...old, state: "switch_off", record: false };
  return { use: "new", name: map.new, state: "in_use", record: true };
}

/* نص الحالة بالعربي للتقرير */
export const REWRITE_STATE_AR = Object.freeze({
  switch_off: "المفتاح مقفول — القديم شغّال",
  unknown: "ماقدرناش نقرا ميتا — القديم شغّال",
  not_submitted: "الجديد مااتقدّمش لميتا",
  pending: "ميتا بتراجع الجديد — القديم شغّال",
  rejected: "ميتا رفضت الجديد — القديم شغّال",
  reclassified: "ميتا صنّفت الجديد تسويق — القديم شغّال",
  paused: "الجديد موقوف عند ميتا — القديم شغّال",
  in_use: "الجديد شغّال (معتمد وخدمي)",
  ready_not_wired: "الجديد معتمد خدمي — المُرسل مش واتساب، مستني قرار الربط",
});
