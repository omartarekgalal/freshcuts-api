/* ═══════════════════════════════════════════════════════════════════════════
   ☁️ واتساب Cloud API — Coexistence (نفس الرقم على تطبيق واتساب بزنس + الـAPI)
   ٢٨/٩

   ليه: الرقم +966 54 671 5683 شغّال على تطبيق واتساب بزنس في المطعم، وعمر
   عايز يفضل كده (الكاشير يرد من الموبايل) وفي نفس الوقت نبعت قوالب معتمدة
   من السيرفر (حملات بصورة وزرار، تحديثات الطلب). ميتا بتسمح بده من غير ما
   الرقم يسيب التطبيق: Embedded Signup بنوع «whatsapp_business_app_onboarding»
   (مسح QR من التطبيق).

   الملف ده:
   ١) دوال صافية (متجرّبة): إعدادات قناة الـCloud وحدودها (cloudCfg/cloudPacing)،
      تصنيف أكواد أخطاء ميتا (classifyError)، باراميترات قالب الحملة لكل عميل
      (campaignParams)، والتحقق من حملة Cloud (cloudJobProblem).
   ٢) مساعد ما بعد الربط (POST /api/cms/wa-cloud/onboard) — مقفول بـ
      WHATSAPP_ONBOARD_WRITE=1: تبديل الكود بتوكن بزنس (احتياطي)، اشتراك
      التطبيق في الـWABA ‏(subscribed_apps)، وبعدين مزامنة جهات الاتصال
      والتاريخ (smb_app_data) — ميتا بتطلب الاتنين خلال ٢٤ ساعة من الربط.
      الإرسال بعد كده بتوكن مستخدم النظام الدائم (META_CAPI_TOKEN)؛ توكن
      البزنس (٦٠ يوم) بيتستخدم بس لو توكن النظام اترفض في خطوة.
   ٣) حالة للقراية بس (GET /api/cms/wa-cloud/status): حالة الرقم، is_on_biz_app،
      المنصة، الجودة، الحد، السرعة، التطبيقات المشتركة، عدد القوالب، صحة
      الويب هوك (آخر حدث)، ومفاتيح الـenv.
   كل ردود التشخيص HTTP 200 مع ok:false (Cloudflare بيبلع الـ5xx).
═══════════════════════════════════════════════════════════════════════════ */
import { GRAPH_VERSION, TEMPLATES, STAGE_TEMPLATES, renderTemplateText, registerTemplates } from "./whatsapp.js";
import { waStagesOf, waReplacesSms, stageRows, stagesProblem, checklistView, MANDATORY_SMS_STAGES } from "./waswitches.js";
import * as CAT from "./watemplates.js";
import { qualityCfg, QUALITY_KEYS, QUALITY_DEFAULTS, WARMUP_DEFAULTS, migrateQuality } from "./waquality.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
export const APP_ID = "1073414588466040";
export const DEFAULT_CONFIG_ID = "1100099832721217";   // Facebook Login for Business — WA Embedded Signup (٢٨/٩)
export const KNOWN_PHONE_ID = "1102069402989468";       // +966 54 671 5683
export const KNOWN_WABA_ID = "2047231412843417";
export const KNOWN_NUMBER = "966546715683";              // الرقم المعروض (display_phone_number) بالأرقام بس

/* ── W5 (١٢/١٠): دوال صافية لمسار الربط على حساب/رقم جديد ────────────────────
   pickPhoneId: من رد GET /{waba}/phone_numbers نختار رقمنا (بالرقم المعروض)، وإلا الرقم الوحيد، وإلا null. */
export function pickPhoneId(list, ourNumber = KNOWN_NUMBER) {
  const rows = (Array.isArray(list) ? list : []).filter((x) => x && x.id);
  const d = (v) => String(v ?? "").replace(/\D/g, "");
  const mine = rows.find((x) => d(x.display_phone_number) === d(ourNumber));
  if (mine) return { id: String(mine.id), by: "number", count: rows.length };
  if (rows.length === 1) return { id: String(rows[0].id), by: "only", count: 1 };
  return { id: null, by: rows.length ? "ambiguous" : "empty", count: rows.length };
}
/* الأرقام الفعّالة = آخر ربط ناجح (اشتراك التطبيق تم + الرقمين موجودين). rec = صف wa_onboarding. */
export function activeFromRecord(rec) {
  if (!rec || !rec.waba_id || !rec.phone_id) return null;
  const s = rec.steps || {};
  if (!(s.subscribe && s.subscribe.ok)) return null;
  return { wabaId: String(rec.waba_id), phoneId: String(rec.phone_id), onboardingId: Number(rec.id) || null,
    at: rec.created_at ? new Date(rec.created_at).toISOString() : null };
}
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };

/* ── إعدادات قناة الـCloud (settings.waCloud) ────────────────────────────
   tierLimit: البزنس مش موثّق ⇒ ميتا بتسمح بـ٢٥٠ عميل مختلف في ٢٤ ساعة
   (رسايل بتبدأ منّا = قوالب). reserveUtility: بنسيب جزء لتحديثات الطلبات
   عشان الحملة ماتاكلش الحد وطلب عميل مايوصلوش تحديث. */
export const CLOUD_DEFAULTS = {
  enabled: false, dailyCap: 200, hourCap: 60, perTick: 5, tierLimit: 250, reserveUtility: 50,
  /* حملات واتساب (١٣/١٠ — قرار عمر): سقف صرف يومي، وفرامل آلية على نسبة الفشل ونسبة «إيقاف» بعد أول N رسالة من الحملة */
  /* QP1 (١٣/١٠ — مراجعة الخبير M7): الإيقاف ٥٪ ⇒ ٢٪ وبعد ٣٠ رسالة بدل ٢٠ */
  spendDaySar: 50, brakeMinSends: 30, brakeStopPct: 2, brakeFailPct: 10,
  ...QUALITY_DEFAULTS, warmup: { steps: WARMUP_DEFAULTS.steps.map((x) => ({ ...x })), stepUpStopPct: WARMUP_DEFAULTS.stepUpStopPct, minStepSends: WARMUP_DEFAULTS.minStepSends },
  /* SX2 (١٥/١٠): إعادة تلقائية مرة واحدة للفشل المؤقت من ميتا (بعد retryDelayMin، ولو ماتبعتتش خلال retryMaxHours من ميعادها بتتلغي)،
     والبدء المجدول: لو السيرفر كان واقف وقت البدء، الحملة تبدأ لوحدها لو التأخير أقل من startLateMaxMin وإلا تستنى المالك */
  retryTransient: true, retryDelayMin: 10, retryMaxHours: 3, startLateMaxMin: 120,
  configId: DEFAULT_CONFIG_ID,
};
export const CLOUD_KEYS = Object.freeze(["enabled", "dailyCap", "hourCap", "perTick", "tierLimit", "reserveUtility", "spendDaySar", "brakeMinSends", "brakeStopPct", "brakeFailPct", ...QUALITY_KEYS,
  "retryTransient", "retryDelayMin", "retryMaxHours", "startLateMaxMin"]);
/* مفاتيح «رفع السقف» = للمالك بس؛ تقليلها أو قفل القناة مسموح لأي دور يدخل الشاشة */
export const CLOUD_CEILINGS = Object.freeze(["dailyCap", "hourCap", "perTick", "tierLimit", "spendDaySar", "brakeStopPct", "brakeFailPct",
  "brakeWarnPct", "lowReadMinDelivered", "lowReadHours", "lowReadPct", "cappedFallbackSms", "allowUnknownQuality", "qualityMaxAgeMin", "custCap7d", "custCap30d", "warmup",
  "retryTransient", "retryMaxHours", "startLateMaxMin"]);
const clampF = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : d; };
export function cloudCfg(settings) {
  const x = { ...CLOUD_DEFAULTS, ...(((settings || {}).waCloud) || {}) };
  const tier = clampN(x.tierLimit, 1, 100000, 250);
  const stopPct = clampF(x.brakeStopPct, 0.5, 100, 2);
  return {
    ...qualityCfg(x, stopPct),
    ...(Number(x.rev) >= 2 ? { rev: 2 } : {}),      // علامة ترحيل QP1 (migrateQuality) — لازم تفضل مع كل حفظ
    enabled: x.enabled === true,
    dailyCap: clampN(x.dailyCap, 1, 100000, 200),
    spendDaySar: clampF(x.spendDaySar, 0, 100000, 50),          // صفر = مفيش إرسال حملات
    brakeMinSends: clampN(x.brakeMinSends, 5, 1000, 30),
    brakeStopPct: stopPct,
    brakeFailPct: clampF(x.brakeFailPct, 1, 100, 10),
    hourCap: clampN(x.hourCap, 1, 10000, 60),
    perTick: clampN(x.perTick, 1, 50, 5),
    tierLimit: tier,
    reserveUtility: clampN(x.reserveUtility, 0, tier, 50),
    retryTransient: x.retryTransient !== false,                  // SX2: مفتوحة افتراضياً — false صريح بس اللي بيقفلها
    retryDelayMin: clampN(x.retryDelayMin, 2, 180, 10),
    retryMaxHours: clampN(x.retryMaxHours, 1, 24, 3),
    startLateMaxMin: clampN(x.startLateMaxMin, 5, 1440, 120),
    configId: /^\d{6,25}$/.test(String(x.configId || "")) ? String(x.configId) : DEFAULT_CONFIG_ID,
  };
}

/* كام رسالة نبعت في الدورة دي؟ (دالة صافية)
   st = { today, lastHour, uniq24h, stoppedReason }
   inHours = ساعات/أيام الإرسال (wasender.inWindow — نفس مواعيد واتساب ويب) */
export function cloudPacing(cc, st, inHours) {
  if (!cc.enabled) return { allow: 0, reason: "disabled" };
  if (st.stoppedReason) return { allow: 0, reason: "stopped", detail: st.stoppedReason };
  if (!inHours) return { allow: 0, reason: "outside_hours" };
  /* QP1: سقف سلّم التسخين (st.warmCap) تحت السقف اليومي — عمره ما بيرفعه */
  const warm = st.warmCap != null && Number.isFinite(Number(st.warmCap)) ? Math.max(0, Number(st.warmCap)) : null;
  const cap = warm != null ? Math.min(cc.dailyCap, warm) : cc.dailyCap;
  const day = cap - (st.today || 0);
  if (day <= 0) return { allow: 0, reason: cap < cc.dailyCap ? "warmup_cap" : "daily_cap" };
  const hour = cc.hourCap - (st.lastHour || 0);
  if (hour <= 0) return { allow: 0, reason: "hour_cap" };
  const tier = cc.tierLimit - cc.reserveUtility - (st.uniq24h || 0);
  if (tier <= 0) return { allow: 0, reason: "tier_limit" };
  /* سقف الصرف اليومي: رسايل النهارده × سعر الرسالة التسويقية (من بطاقة الأسعار المخزّنة — st.rateSar). من غير سعر معروف مفيش سقف صرف. */
  let money = Infinity;
  if (Number.isFinite(Number(cc.spendDaySar)) && Number(st.rateSar) > 0) {
    money = Math.floor((Number(cc.spendDaySar) - (st.today || 0) * Number(st.rateSar)) / Number(st.rateSar) + 1e-9);
    if (money <= 0) return { allow: 0, reason: "spend_cap" };
  }
  /* QP1: حملة في منطقة التحذير (st.halve) ⇒ نص عدد الدورة */
  const perTick = st.halve ? Math.max(1, Math.floor(cc.perTick / 2)) : cc.perTick;
  return { allow: Math.max(0, Math.min(perTick, day, hour, tier, money)), reason: null };
}

/* ── أكواد أخطاء ميتا → قرار ──────────────────────────────────────────────
   reason  اللي بيتكتب على صف الطابور (اللوحة بتترجمه)
   stop    غلطة إعداد/حساب ⇒ نوقّف الإرسال كله لحد ما حد يبص (مش هتتصلّح لوحدها)
   retry   مؤقتة ⇒ الصف يرجع للطابور
   invalid الرقم مش على واتساب ⇒ مايدخلش حملات تانية
   optout  العميل وقّف التسويق من واتساب نفسه ⇒ إيقاف عندنا كمان
   fallback تنفع قناة بديلة (sms = بس؛ both = واتساب ويب أو SMS)
   transient (SX2 ١٥/١٠) غلطة مؤقتة عند ميتا أو في تنزيل الوسيط — مش في العميل ولا في الحساب ⇒ الصف بيتعاد مرة واحدة لوحده بعد
           retryDelayMin (retryDecision). حادثة ١٥/١٠: ٧٦ رسالة فشلت بـ131000 لأن الـAPI اتعمل له ريستارت وميتا بتنزّل صورة الهيدر
           (الصورة على سيرفرنا). 131053 = ميتا ماقدرتش تنزّل/ترفع الوسيط (كانت بتوقّف القناة كلها؛ دلوقتي إعادة + فحص الوسيط). */
export const META_ERRORS = {
  131026: { reason: "undeliverable", invalid: true, fallback: "sms" },
  /* QP1: ميتا نفسها حدّت رسايل التسويق للعميل ده — مش فشل عندنا: بيتعدّ لوحده (meta_capped) وبره نسبة الفشل، ومن غير SMS بديل افتراضياً */
  131049: { reason: "meta_marketing_limit", fallback: "both", capped: true },
  130472: { reason: "meta_experiment", fallback: "both" },
  131050: { reason: "user_stopped_marketing", optout: true },
  131047: { reason: "window_closed" },
  131056: { reason: "pair_rate_limit", retry: true },
  130429: { reason: "rate_limited", retry: true },
  80007: { reason: "rate_limited", retry: true },
  4: { reason: "rate_limited", retry: true },
  131016: { reason: "meta_unavailable", retry: true, transient: true },
  131000: { reason: "meta_error", transient: true },
  133004: { reason: "meta_server_down", transient: true },
  2: { reason: "meta_api_temporary", transient: true },
  131021: { reason: "recipient_is_sender", invalid: true },
  131048: { reason: "spam_rate_limit", stop: true },
  131042: { reason: "payment_issue", stop: true },
  131031: { reason: "account_locked", stop: true },
  368: { reason: "policy_block", stop: true },
  131045: { reason: "phone_not_registered", stop: true },
  133010: { reason: "phone_not_registered", stop: true },
  132000: { reason: "template_params", stop: true },
  132001: { reason: "template_missing", stop: true },
  132005: { reason: "template_too_long", stop: true },
  132007: { reason: "template_policy", stop: true },
  132012: { reason: "template_params", stop: true },
  132015: { reason: "template_paused", stop: true },
  132016: { reason: "template_disabled", stop: true },
  132018: { reason: "template_params", stop: true },
  131053: { reason: "media_error", transient: true, media: true },
  131008: { reason: "template_params", stop: true },
  131009: { reason: "template_params", stop: true },
  100: { reason: "bad_request", stop: true },
  190: { reason: "token_invalid", stop: true },
  10: { reason: "permission_denied", stop: true },
  200: { reason: "permission_denied", stop: true },
};
export function classifyError(code) {
  const n = Number(code);
  const m = META_ERRORS[n];
  if (m) return { code: n, stop: false, retry: false, invalid: false, optout: false, capped: false, fallback: null, transient: false, media: false, ...m };
  return { code: Number.isFinite(n) ? n : null, reason: Number.isFinite(n) && n ? `meta_${n}` : "send_failed",
    stop: false, retry: false, invalid: false, optout: false, capped: false, fallback: null, transient: false, media: false };
}
/* SX2: الصف ده يتعاد لوحده؟ (دالة صافية) — مرة واحدة بس، للغلطات المؤقتة بس، والمفتاح شغّال، والرسالة الأولى ماوصلتش فعلاً.
   مش بتتعاد أبداً: 131049 (ميتا حدّت تسويق العميل)، 131026 (مش على واتساب)، 130472 (تجربة ميتا)، وأي غلطة مش مؤقتة.
   فشل الإرسال من غير كود من ميتا (شبكة/مهلة) مش «مؤقت» هنا: ممكن ميتا تكون استلمته — مانخاطرش برسالة مكررة. */
export function retryDecision({ cls, row = null, cc = null, jobStatus = null } = {}) {
  if (!cls || cls.transient !== true) return { retry: false, why: "not_transient" };
  if (!cc || cc.retryTransient !== true) return { retry: false, why: "retry_off" };
  if (row && row.retried_at) return { retry: false, why: "already_retried" };
  if (row && ["delivered", "read"].includes(String(row.cloud_status || ""))) return { retry: false, why: "delivered" };
  if (jobStatus === "cancelled") return { retry: false, why: "job_cancelled" };
  return { retry: true, delayMin: cc.retryDelayMin };
}

/* ── SX2 (d): أسباب الفشل والتخطّي بالعربي — للنتايج وقايمة المستلمين (اللوحة بتعرضها زي ما هي) ── */
export const REASON_AR = Object.freeze({
  /* من ميتا */
  undeliverable: "الرقم مش على واتساب",
  meta_marketing_limit: "ميتا مابتوصّلش رسايل تسويق كتير للعميل ده",
  meta_experiment: "العميل في تجربة عند ميتا مابتوصّلش له رسايل تسويق",
  user_stopped_marketing: "العميل وقّف رسايل التسويق من واتساب نفسه",
  window_closed: "نافذة الـ٢٤ ساعة مقفولة",
  pair_rate_limit: "اتبعت للعميل ده كتير ورا بعض — ميتا قالت استنّى",
  rate_limited: "ميتا طلبت نبطّأ الإرسال",
  meta_unavailable: "خدمة ميتا كانت مضغوطة لحظتها (مؤقت)",
  meta_error: "غلطة مؤقتة عند ميتا (131000)",
  meta_server_down: "سيرفر ميتا كان واقف مؤقتاً",
  meta_api_temporary: "خدمة ميتا كانت واقفة مؤقتاً",
  media_error: "ميتا ماقدرتش تنزّل الصورة/الفيديو بتاع الرسالة",
  recipient_is_sender: "ده رقم المطعم نفسه",
  spam_rate_limit: "ميتا حدّت رقمنا بسبب بلاغات إزعاج",
  payment_issue: "مشكلة في الدفع عند ميتا",
  account_locked: "حساب واتساب مقفول عند ميتا",
  policy_block: "ميتا رفضت بسبب مخالفة سياسة",
  phone_not_registered: "رقم المطعم مش متسجّل على واتساب API",
  template_params: "متغيّرات القالب غلط",
  template_missing: "القالب مش موجود عند ميتا",
  template_too_long: "نص القالب طويل بعد ما اتملى",
  template_policy: "القالب مخالف لسياسة ميتا",
  template_paused: "ميتا وقّفت القالب مؤقتاً",
  template_disabled: "ميتا عطّلت القالب",
  bad_request: "طلب الإرسال غلط",
  token_invalid: "توكن واتساب مش صالح",
  permission_denied: "صلاحية واتساب ناقصة",
  send_failed: "الإرسال فشل من غير رد واضح من ميتا",
  /* اتخطّى عندنا قبل الإرسال */
  opted_out: "طلب إيقاف الرسايل",
  staff: "رقم من الفريق",
  invalid_number: "الرقم مش على واتساب أو مكتوب غلط",
  gap_7d: "وصلته رسالة واتساب في آخر ٧ أيام",
  gap_3d: "وصلته رسالة واتساب في آخر ٣ أيام",
  gap_sms: "وصله SMS تسويقي قريب",
  ordered_online: "طلب من الموقع قريب",
  open_order: "عنده طلب مفتوح دلوقتي",
  no_optin: "مش موافق على الرسايل",
  missing_param: "قيمة ناقصة في رسالته (زي الاسم أو الطبق)",
  marketing_cap_7d: "وصله قالب تسويقي في آخر ٧ أيام (حد العميل)",
  marketing_cap_30d: "وصله ٣ قوالب تسويقية في آخر ٣٠ يوم (حد العميل)",
  removed_by_owner: "اتشال من الطابور يدوي",
  cancelled: "الحملة اتلغت قبل ما يوصله الدور",
  holdout: "مجموعة المقارنة — مابيستلمش عن قصد",
  bad_template: "القالب مش معروف",
  stuck: "الإرسال علق ومارجعش رد",
  ordered_since: "طلب من وقت ما الحملة اتجهّزت",
  offer_missing: "العرض بتاعه ناقص",
  offer_changed: "العرض اتغيّر من وقت المعاينة",
  offer_unverified: "ماقدرناش نتأكد من العرض لحظة الإرسال",
  offer_check_failed: "فحص العرض وقع لحظة الإرسال",
  offer_ending: "العرض بيخلص النهارده",
  profile_box_gone: "البوكس اللي في رسالته اتوقف",
  profile_first_changed: "كوبون أول طلب اتغيّر حاله",
  profile_loyalty_changed: "رصيد الولاء اتغيّر",
  profile_unverified: "ماقدرناش نتأكد من قيم ملفه لحظة الإرسال",
});
export function reasonText(reason) {
  const s = String(reason || "");
  if (!s) return "من غير سبب متسجّل";
  if (REASON_AR[s]) return REASON_AR[s];
  if (s.startsWith("offer_gone")) return "العرض بتاعه خلص أو اتشال";
  const m = /^meta_(\d+)$/.exec(s);
  if (m) return `ميتا رفضت بكود ${m[1]}`;
  return `سبب تاني (${s})`;
}
/* صفوف الطابور ⇒ [{status, reason, n, text}] للفاشل والمتخطّى (الأكتر الأول). الفاشل المستني إعادة مش منهم (بيتعدّ في retryStats). */
export function reasonRows(rows) {
  const m = new Map();
  for (const x of rows || []) {
    const failed = x.status === "failed" && !x.retry_at;
    if (!failed && x.status !== "skipped") continue;
    const k = `${x.status}|${x.reason || ""}`;
    const cur = m.get(k) || { status: x.status, reason: x.reason || null, n: 0, text: reasonText(x.reason) };
    cur.n++; m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.status.localeCompare(b.status) || String(a.reason || "").localeCompare(String(b.reason || "")));
}
/* عدّادات الإعادة: مستنية · اتعادت · نجحت (ميتا قبلتها ومافشلتش بعدها) · وصلت · فشلت تاني · وصلت متأخر (الأولى طلعت واصلة ⇒ مااتعادتش) */
export function retryStats(rows) {
  const r = { waiting: 0, retried: 0, ok: 0, delivered: 0, failedAgain: 0, deliveredLate: 0, expired: 0 };
  for (const x of rows || []) {
    if (x.status === "failed" && x.retry_at) r.waiting++;
    if (x.note === "delivered_after_failure") r.deliveredLate++;
    if (x.note === "retry_expired" || x.note === "retry_off") r.expired++;
    if (!x.retried_at) continue;
    r.retried++;
    if (x.status === "sent" && x.cloud_status !== "failed") { r.ok++; if (["delivered", "read"].includes(x.cloud_status)) r.delivered++; }
    else if (x.status === "failed") r.failedAgain++;
  }
  return r;
}
/* القناة البديلة المسموحة للصف ده: job.fallback × نوع الغلطة */
export function fallbackFor(cls, jobFallback, { cappedSms = false } = {}) {
  if (!cls?.fallback || !jobFallback || jobFallback === "none") return null;
  if (jobFallback === "sms") return cls.capped && !cappedSms ? null : "sms";      // QP1: 131049 من غير SMS بديل إلا لو المالك فعّله
  /* QP1 (قرار المنسّق ١٣/١٠): عميل ميتا حدّت تسويقه (131049) مايتوصلّوش من واتساب ويب كمان — مفيش مفتاح بيفتح ده */
  if (jobFallback === "wa_web") return cls.fallback === "both" && !cls.capped ? "wa_web" : null;
  return null;
}

/* ── قالب الحملة لكل عميل ──────────────────────────────────────────────────
   row: صف wa_send_queue (vars, link_code, coupon)  ·  job: wa_send_jobs
   زرار الرابط = /l/<slug>-<code> نفس روابط الحملة المتتبّعة (cms.js). */
export const CAMPAIGN_TEMPLATES = () => Object.entries(TEMPLATES).filter(([, t]) => t.campaign && t.category === "MARKETING").map(([n]) => n);

/* قالب الفيديو (١٣/١٠): نفس fc_offer_img بهيدر فيديو. بيتسجّل في السجل عشان يتقدّم لميتا ويتبعت — **مايتبعتش قبل ما ميتا تعتمده**.
   مش في CAMPAIGN_TEMPLATES القديمة (قايمتها ثابتة باختبار)، وبيظهر في campaignTemplateNames(). */
export const VIDEO_TEMPLATE = "fc_offer_video";
/* بيتنادى وقت الإقلاع (register تحت) ومن الاختبارات — مش وقت الاستيراد، عشان عدّ القوالب المبنية في الاختبارات القديمة مايتغيّرش */
export function registerCampaignTemplates() {
  if (TEMPLATES[VIDEO_TEMPLATE]) return false;
  registerTemplates({ [VIDEO_TEMPLATE]: {
  category: "MARKETING", campaignVideo: { label: "عرض بفيديو" },
  components: [
    { type: "HEADER", format: "VIDEO", example: { header_handle: ["<upload handle — بيتجاب وقت التقديم>"] } },
    { type: "BODY", text: "أهلاً {{1}} 👋\n{{2}}\nاطلبه من موقع فريش كاتس للتوصيل أو الاستلام 🔥", example: { body_text: [["محمد", "بوكس التشكيلة من فريش كاتس بـ105 ريال"]] } },
    { type: "FOOTER", text: "للإيقاف ردّ: إيقاف" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "اطلب الآن", url: "https://freshcuts.sa/l/{{1}}", example: ["w12-a1b2c3"] }, { type: "QUICK_REPLY", text: "إيقاف" }] },
  ],
  bind: (x) => ({ header: x.videoUrl ? { video: x.videoUrl } : null, body: [x.name || "عميلنا", x.offer || ""], button: [x.linkSuffix || ""] }),
  } });
  return true;
}

/* حدود ميتا للوسائط في رسالة قالب (Cloud API): صورة JPEG/PNG لحد ٥ ميجا؛ فيديو MP4/3GP (H.264 + AAC) لحد ١٦ ميجا. */
export const MEDIA_LIMITS = Object.freeze({
  image: { maxBytes: 5 * 1024 * 1024, mimes: ["image/jpeg", "image/png"], label: "صورة JPG أو PNG لحد ٥ ميجا" },
  video: { maxBytes: 16 * 1024 * 1024, mimes: ["video/mp4", "video/3gpp"], label: "فيديو MP4 (H.264 + صوت AAC) لحد ١٦ ميجا" },
});
/* {mime, bytes} (من رد HEAD على الرابط) ⇒ null لو تمام، أو [كود، رسالة] */
export function mediaProblem(kind, { mime, bytes } = {}) {
  const L = MEDIA_LIMITS[kind];
  if (!L) return ["bad_media_kind", "نوع الوسيط مش معروف"];
  const m = String(mime || "").split(";")[0].trim().toLowerCase();
  if (!L.mimes.includes(m)) return ["media_type", `${kind === "video" ? "الفيديو" : "الصورة"} لازم: ${L.label} (الملف نوعه ${m || "مش معروف"})`];
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return ["media_size_unknown", "ماقدرناش نعرف حجم الملف — ارفعه على مخزن الوسائط بتاعنا تاني"];
  if (n > L.maxBytes) return ["media_too_big", `الملف ${(n / 1048576).toFixed(1)} ميجا — ميتا بتقبل ${L.label}`];
  return null;
}

/* وصف قالب للحملة: الهيدر، الزر، والخانات اللي الحملة لازم تملاها. null = القالب ماينفعش لحملة.
   المتغيّرات «التلقائية»: الاسم الأول للعميل، كوبونه (لو الحملة بكوبون)، ورابطه المتتبّع ‎/l/<slug>-<code>. */
const AUTO_VARS = { "customer.name": "name", "coupon.code": "coupon" };
export function campaignSpec(name) {
  const t = TEMPLATES[name];
  if (!t || t.category !== "MARKETING") return null;
  const comps = t.components || [];
  const hdr = comps.find((c) => c.type === "HEADER");
  const header = hdr && hdr.format === "IMAGE" ? "image" : hdr && hdr.format === "VIDEO" ? "video" : null;
  const body = comps.find((c) => c.type === "BODY")?.text || "";
  const footer = comps.find((c) => c.type === "FOOTER")?.text || "";
  const urlBtn = (comps.find((c) => c.type === "BUTTONS")?.buttons || []).find((b) => b.type === "URL") || null;
  const base = { name, header, body, footer, buttonText: urlBtn ? urlBtn.text : null };
  if (t.campaign || t.campaignVideo) {
    const needs = t.campaign ? (t.campaign.needs || []) : ["video"];
    const offerLine = name === "fc_offer_img" || name === VIDEO_TEMPLATE;
    return { ...base, kind: "legacy", label: (t.campaign || t.campaignVideo).label, needsCoupon: needs.includes("coupon"), button: "link",
      fields: offerLine ? [{ key: "offer", label: "سطر العرض", example: "بوكس التشكيلة من فريش كاتس بـ105 ريال", max: 200 }] : [], auto: ["name"] };
  }
  if (!t.catalog) return null;
  const c = CAT.findTemplate(name, t.language || "ar");
  if (!c || !c.meta) return null;
  /* قوالب الكتالوج اللي إرسالها «يدوي» بس (عرض، صنف جديد، مناسبة…): قيمها واحدة لكل المستلمين. القوالب الآلية
     (ولاء، استرجاع، كوبون شخصي…) قيمها بتيجي من بيانات كل عميل ومكانها الأتمتة، مش حملة بقيم مكتوبة بالإيد. */
  if (c.meta.send !== "manual") return null;
  const bv = (c.meta.buttonVars || [])[0] || null;
  let button = urlBtn ? "static" : null;
  if (bv) { if (bv.path === "link.suffix") button = "link"; else if (bv.path === "coupon.code") button = "coupon"; else return null; }   // زر سلة/طلب: مش حملة
  const fields = [], auto = [];
  for (const v of c.meta.vars || []) {
    if (AUTO_VARS[v.path]) { auto.push(AUTO_VARS[v.path]); continue; }
    fields.push({ key: v.path, label: v.label || v.path, example: v.example || "", max: 200 });
  }
  return { ...base, kind: "catalog", label: c.meta.purpose || name, needsCoupon: auto.includes("coupon") || button === "coupon", button, fields, auto,
    held: Boolean(CAT.HOLD && CAT.HOLD[name]) };
}
export const campaignTemplateNames = () => Object.keys(TEMPLATES).filter((n) => campaignSpec(n)).sort();

const setPath = (obj, path, val) => { const ks = String(path).split("."); let o = obj; ks.forEach((k, i) => { if (i === ks.length - 1) o[k] = val; else o = o[k] = (o[k] && typeof o[k] === "object" ? o[k] : {}); }); };
export const campaignValues = (cloudVars) => { const v = (cloudVars && cloudVars.values && typeof cloudVars.values === "object") ? cloudVars.values : {}; return { ...v, ...(cloudVars && cloudVars.offer ? { offer: cloudVars.offer } : {}) }; };
/* CP1 (١٥/١٠): خانة فيها قيمة من ملف العميل ({fav_dish} …) — custprofile.js بيبدّلها لكل مستلم وقت التجهيز */
export const PROFILE_TOKEN_RE = /\{[a-z_]+\}/;

export function campaignParams(template, row, job) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown template ${template}`);
  const v = row.vars || {};
  const first = String(v.first_name || "").trim() || String(v.name || row.name || "").trim().split(/\s+/)[0] || "";
  const slug = job.link_slug || "";
  const linkSuffix = slug && row.link_code ? `${slug}-${row.link_code}` : slug;
  const spec = campaignSpec(template);
  if (spec && spec.kind === "catalog") {
    /* قالب كتالوج: كائن البيانات بمسارات المتغيّرات — قيم الحملة + الاسم + الكوبون + الرابط المتتبّع، وbind بتاع الكتالوج يرتّبها ويطلّع الناقص */
    const data = {};
    /* CP1 (١٥/١٠): حملة بقيم من ملف العميل (cloud_vars.profileVars): الخانة اللي فيها {token} قيمتها من صف المستلم بس (vars.cloud.values —
       اتحسبت وقت التجهيز). صف من غير قيمته = متغيّر ناقص ⇒ الحارس مابيبعتش (missing_param) — النص الخام بالأقواس عمره ما يوصل لعميل. */
    const profVars = Boolean(job.cloud_vars && job.cloud_vars.profileVars === true);
    for (const [k, val] of Object.entries(campaignValues(job.cloud_vars))) if (k !== "offer" && !(profVars && PROFILE_TOKEN_RE.test(String(val)))) setPath(data, k, val);
    /* FD1 (١٤/١٠): حملة قيمها لكل مستلم (perRecipient — «طبقك المفضل»): قيم الصف نفسه (vars.cloud) هي اللي بتتبعت. الحملة مالهاش
       قيم أصلاً، فصف من غير قيمه = متغيّر ناقص ⇒ الحارس مابيبعتش (missing_param) — عمره ما بيطلع بقيمة عامة. */
    if (job.cloud_vars && (job.cloud_vars.perRecipient === true || profVars)) for (const [k, val] of Object.entries(campaignValues(v.cloud))) if (k !== "offer") setPath(data, k, val);
    setPath(data, "customer.name", first || "عميلنا");
    if (row.coupon) setPath(data, "coupon.code", row.coupon);
    setPath(data, "link.suffix", linkSuffix);
    const b = t.bind(data);
    const params = { ...b, header: spec.header === "image" && job.image_url ? { image: job.image_url } : spec.header === "video" && job.video_url ? { video: job.video_url } : null };
    return { params, text: renderTemplateText(template, params) };
  }
  const params = t.bind({
    name: first || "عميلنا",
    offer: (job.cloud_vars && job.cloud_vars.offer) || "",
    imageUrl: job.image_url || null,
    videoUrl: job.video_url || null,
    linkSuffix,
    dish: String(v.fav_dish || v.last_items || "").trim(),
    coupon: row.coupon || "",
  });
  return { params, text: renderTemplateText(template, params) };
}

/* حملة على قناة Cloud: القالب لازم يبقى قالب حملة، وكل اللي محتاجه موجود. */
export function cloudJobProblem({ cloudTemplate, cloudVars, imageUrl, videoUrl, offer, link }) {
  const spec = campaignSpec(cloudTemplate);
  if (!spec) return ["bad_template", "اختار قالب واتساب تسويقي ينفع لحملة"];
  if (spec.header === "image" && !imageUrl) return ["image_required", "القالب ده بصورة — اختار صورة العرض"];
  if (spec.header === "video" && !videoUrl) return ["video_required", "القالب ده بفيديو — ارفع الفيديو واختاره"];
  if (spec.needsCoupon && !(offer && offer.oneTime) && !(link && link.coupon)) {
    return ["coupon_required", "القالب ده فيه كود — فعّل «كوبون مرة واحدة لكل عميل» أو حط كوبون ثابت"];
  }
  const vals = campaignValues(cloudVars);
  /* FD1: القيم لكل مستلم (vars.cloud لكل صف) — مفيش قيم على مستوى الحملة تتراجع هنا؛ كل صف بيتراجع وقت الإرسال (bindTemplate) */
  if (cloudVars && cloudVars.perRecipient === true) return null;
  for (const f of spec.fields) {
    const o = String(vals[f.key] ?? "").trim();
    const what = f.key === "offer" ? "سطر العرض" : `«${f.label}»`;
    if (!o) return [f.key === "offer" ? "offer_line_required" : "value_required", f.key === "offer" ? "اكتب سطر العرض اللي هيظهر في الرسالة" : `اكتب ${what}`];
    if (o.length > f.max) return [f.key === "offer" ? "offer_line_long" : "value_long", `${what} طويل (أقصى ${f.max} حرف)`];
    if (/[\n\t]/.test(o)) return [f.key === "offer" ? "offer_line_newline" : "value_newline", `${what} لازم يبقى سطر واحد`];
  }
  return null;
}

/* فرامل الحملة (زي فرامل الـ٥٪ بتاعة SMS): بعد أول brakeMinSends محاولة، لو نسبة الفشل أو نسبة «إيقاف» عدّت الحد ⇒ الحملة تقف.
   n = { sent, failed, stopped } لنفس الحملة. بترجع null أو { reason:"fail_rate"|"stop_rate", pct, limit }.
   QP1: failed هنا من غير اللي ميتا حدّته (131049) — المنادي بيعدّه لوحده في n.capped ومابيدخلش في النسبة. */
export function brakeCheck(n, cc) {
  const sent = Number(n?.sent) || 0, failed = Number(n?.failed) || 0, stopped = Number(n?.stopped) || 0;
  const tried = sent + failed;
  if (tried < cc.brakeMinSends) return null;
  const failPct = (failed / tried) * 100, stopPct = sent ? (stopped / sent) * 100 : 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  if (failPct >= cc.brakeFailPct) return { reason: "fail_rate", pct: r1(failPct), limit: cc.brakeFailPct };
  if (stopPct >= cc.brakeStopPct) return { reason: "stop_rate", pct: r1(stopPct), limit: cc.brakeStopPct };
  return null;
}
/* TS1 (١٤/١٠): القالب عندنا (الكتالوج) زي النسخة اللي عند ميتا؟ — دالة صافية.
   لما الكتالوج يتغيّر (مثلاً زر اتشال) النسخة المعتمدة عند ميتا بتفضل القديمة لحد ما التعديل يتراجع. بنقارن اللي العميل بيشوفه
   واللي الإرسال بيعتمد عليه: نوع الهيدر، نص الجسم، الفوتر، والأزرار (النوع + النص + الرابط) بالترتيب. بترجع قايمة الفروق (فاضية = متطابق). */
export function templateDiff(ours, theirs) {
  const norm = (v) => String(v ?? "").replace(/\r\n/g, "\n").trim();
  const part = (comps, type) => (Array.isArray(comps) ? comps : []).find((c) => String(c && c.type).toUpperCase() === type) || null;
  const btns = (comps) => ((part(comps, "BUTTONS") || {}).buttons || []).map((b) => [String(b.type || "").toUpperCase(), norm(b.text), norm(b.url)].join("|"));
  const out = [];
  const ha = part(ours, "HEADER"), hb = part(theirs, "HEADER");
  if (String((ha && ha.format) || "") !== String((hb && hb.format) || "")) out.push("header");
  if (ha && hb && ha.format === "TEXT" && norm(ha.text) !== norm(hb.text)) out.push("header_text");
  if (norm((part(ours, "BODY") || {}).text) !== norm((part(theirs, "BODY") || {}).text)) out.push("body");
  if (norm((part(ours, "FOOTER") || {}).text) !== norm((part(theirs, "FOOTER") || {}).text)) out.push("footer");
  const a = btns(ours), b = btns(theirs);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) out.push("buttons");
  return out;
}
export const campaignCost = (messages, rateSar) => (Number(rateSar) > 0 ? Math.round((Number(messages) || 0) * Number(rateSar) * 100) / 100 : null);

/* القناة الافتراضية لحملة جديدة: Cloud لو كله جاهز، وإلا واتساب ويب */
export function defaultChannel({ gate, phoneStatus }) {
  return !gate && String(phoneStatus || "").toUpperCase() === "CONNECTED" ? "wa_cloud" : "wa_web";
}

/* ═══════════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  registerCampaignTemplates();
  const doFetch = deps.fetch || globalThis.fetch;
  const wa = deps.wa || null;                 // الراجع من whatsapp.js
  const now = deps.now || (() => Date.now());
  const J = (v) => JSON.stringify(v);

  const sysToken = () => (wa?.token ? wa.token() : (env("WHATSAPP_TOKEN") || env("META_CAPI_TOKEN")));
  // W5: الأرقام الفعّالة من whatsapp.js (آخر ربط ناجح، وإلا الـenv) — نفس المصدر للإرسال والقوالب والحالة
  const phoneId = () => (wa?.phoneId ? wa.phoneId() : env("WHATSAPP_PHONE_ID"));
  const wabaId = () => (wa?.wabaId ? wa.wabaId() : env("WHATSAPP_WABA_ID"));
  const envPhoneId = () => env("WHATSAPP_PHONE_ID");
  const envWabaId = () => env("WHATSAPP_WABA_ID");
  const appSecret = () => env("WHATSAPP_APP_SECRET") || env("META_APP_SECRET");
  const onboardWrite = () => env("WHATSAPP_ONBOARD_WRITE") === "1";

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_onboarding (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT,
        event TEXT,                 -- FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING | CANCEL | ERROR | code
        waba_id TEXT, phone_id TEXT, business_id TEXT,
        same_phone BOOLEAN, same_waba BOOLEAN,
        biz_token TEXT,             -- توكن البزنس (٦٠ يوم) — احتياطي، عمره ما بيطلع من السيرفر
        biz_token_at TIMESTAMPTZ,
        steps JSONB NOT NULL DEFAULT '{}'::jsonb,
        info JSONB,
        status TEXT                 -- recorded | running | done | partial | failed | write_disabled
      );
    `);
  }
  const ready = ensureSchema().catch((e) => console.error("[wa-cloud] schema:", e.message));
  /* QP1: ترحيل حدود الفرامل المخزّنة (٥٪/٢٠ ⇒ ٢٪/٣٠) مرة واحدة — شوف migrateQuality. فشل القراءة/الكتابة = نجرّب الإقلاع الجاي. */
  const qualityMigrated = ready.then(async () => {
    const m = migrateQuality(((await getSettingsData()) || {}).waCloud);
    if (!m.changed) return false;
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waCloud}', $1::jsonb, true) WHERE id=1`, [J(cloudCfg({ waCloud: m.next }))]);
    console.log(`[wa-cloud] QP1 brake limits migrated (stop ${m.from.brakeStopPct}→${m.next.brakeStopPct ?? "default"}, after ${m.from.brakeMinSends}→${m.next.brakeMinSends ?? "default"})`);
    return true;
  }).catch((e) => { console.error("[wa-cloud] QP1 migrate:", e.message); return false; });

  const who = async (c) => {
    try {
      const t = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
      const u = t.startsWith("cms:") && deps.sessionUser ? await deps.sessionUser(t) : null;
      return { name: (u && (u.name || u.username)) || "المالك", owner: !u || u.role === "owner" };
    } catch { return { name: "المالك", owner: false }; }
  };
  const ownerOnly = async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const w = await who(c);
    if (!w.owner) return c.json({ ok: false, error: "owner_only", message: "المالك بس" }, 403);
    return null;
  };

  async function graph(method, path, { token = sysToken(), body = null, query = null } = {}) {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    const resp = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}${qs}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      const e = new Error(data.error?.message || `HTTP ${resp.status}`);
      e.code = data.error?.code ?? resp.status; e.sub = data.error?.error_subcode ?? null;
      throw e;
    }
    return data;
  }
  const errJ = (e) => ({ ok: false, code: e.code ?? null, sub: e.sub ?? null, error: String(e.message || e).slice(0, 300) });
  // غلطة صلاحية/توكن ⇒ نجرّب توكن البزنس
  const authish = (e) => [10, 100, 190, 200, 3, 33].includes(Number(e.code)) || /permission|access token|not authorized/i.test(String(e.message));

  /* W5 (١٢/١٠) — ترتيب التوكن: لو عندنا توكن البزنس (من تبديل كود النافذة) بنستعمله **الأول**، ولو فشل بنجرّب توكن
     النظام. قبل كده كان العكس، والرجوع لتوكن البزنس بس على أكواد الصلاحية (10/100/190/200/3/33) — والرفض اللي
     بييجي فعلاً من المزامنة 131000/10 مش منهم، فالمزامنة كانت بتتجرّب بالتوكن الغلط ومابتتعادش.
     كل خطوة بتسجّل: via (business|system)، tried (الترتيب)، الرد الكامل data، وخطأ كل توكن فشل. */
  async function step(fn, bizToken) {
    const order = bizToken ? [["business", bizToken], ["system", sysToken()]] : [["system", sysToken()]];
    const tried = [], errors = {};
    for (const [name, tok] of order) {
      if (!tok) { errors[name] = { ok: false, error: "no_token" }; tried.push(name); continue; }
      tried.push(name);
      try {
        const data = await fn(tok);
        return { ok: true, via: name, tried, at: new Date(now()).toISOString(), data,
          ...(errors.business ? { businessError: errors.business } : {}), ...(errors.system ? { systemError: errors.system } : {}) };
      } catch (e) { errors[name] = errJ(e); }
    }
    const last = tried[tried.length - 1];
    return { ...errors[last], via: last, tried, at: new Date(now()).toISOString(),
      ...(errors.business ? { businessError: errors.business } : {}), ...(errors.system ? { systemError: errors.system } : {}) };
  }

  /* W5 — G3: رسالة FINISH ممكن تيجي بـwaba_id بس. بنسأل ميتا عن أرقام الحساب (بتوكن البزنس الأول) وناخد رقمنا
     ونحفظه على الصف، وبعدها المزامنة تمشي. */
  async function lookupPhone(rec) {
    if (rec.phone_id || !rec.waba_id) return null;
    const r = await step((tok) => graph("GET", `${rec.waba_id}/phone_numbers`, { token: tok,
      query: { fields: "id,display_phone_number,verified_name,status,platform_type,is_on_biz_app", limit: "50" } }), rec.biz_token);
    if (!r.ok) return { ...r, step: "lookup_phone" };
    const pick = pickPhoneId(r.data?.data, env("WHATSAPP_DISPLAY_NUMBER", KNOWN_NUMBER));
    const out = { ok: Boolean(pick.id), via: r.via, tried: r.tried, at: r.at, by: pick.by, count: pick.count, phoneId: pick.id,
      numbers: (r.data?.data || []).map((x) => ({ id: String(x.id), number: x.display_phone_number || null, status: x.status || null })).slice(0, 10),
      ...(pick.id ? {} : { error: pick.by === "empty" ? "no_numbers_on_waba" : "number_not_found_on_waba" }) };
    if (pick.id) {
      rec.phone_id = pick.id;
      rec.same_phone = pick.id === (envPhoneId() || KNOWN_PHONE_ID);
      await pool.query("UPDATE wa_onboarding SET phone_id=$2, same_phone=$3 WHERE id=$1", [rec.id, pick.id, rec.same_phone]);
    }
    return out;
  }

  /* W5 — G4: بعد ربط ناجح (اشتراك التطبيق تم) الأرقام الفعّالة = أرقام الربط؛ بتتحفظ في settings.waCloudActive
     وبتتحط في whatsapp.js (wa.setActiveIds). «رجوع للـenv» = مسح المفتاح (POST /active {use:"env"}). */
  async function saveActive(a, by) {
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waCloudActive}', $1::jsonb, true) WHERE id=1`,
      [J(a ? { ...a, setAt: new Date(now()).toISOString(), setBy: by || null } : null)]);
    if (wa?.setActiveIds) wa.setActiveIds(a ? { phoneId: a.phoneId, wabaId: a.wabaId, source: "onboarding" } : null);
    acceptCache = { at: 0, data: null };
    phoneCache = { at: 0, data: null }; tplCache = { at: 0, data: null };
  }
  async function loadActive() {
    try {
      const a = ((await getSettingsData()) || {}).waCloudActive;
      if (a && (a.phoneId || a.wabaId) && wa?.setActiveIds) wa.setActiveIds({ phoneId: a.phoneId, wabaId: a.wabaId, source: "onboarding" });
      return a || null;
    } catch { return null; }
  }
  /* W5 — G1: الأرقام اللي الويب هوك يقبلها زيادة على الـenv: phone_id بتاع آخر صفوف الربط (running/done/partial)
     + رقمنا المعروض. كاش دقيقة؛ بيتصفّر مع كل ربط. */
  let acceptCache = { at: 0, data: null };
  async function webhookAccept() {
    if (acceptCache.data && now() - acceptCache.at < 60e3) return acceptCache.data;
    let ids = [];
    try {
      ids = (await pool.query(`SELECT DISTINCT phone_id FROM (SELECT phone_id FROM wa_onboarding
        WHERE event='onboard' AND phone_id IS NOT NULL AND status IN ('running','done','partial') ORDER BY id DESC LIMIT 5) t`)).rows.map((r) => String(r.phone_id));
    } catch { /* الجدول لسه */ }
    const data = { phoneIds: ids, ownNumbers: [env("WHATSAPP_DISPLAY_NUMBER", KNOWN_NUMBER)] };
    acceptCache = { at: now(), data };
    return data;
  }
  if (wa?.setWebhookAccept) wa.setWebhookAccept(webhookAccept);
  // وقت الإقلاع: الأرقام الفعّالة من settings.waCloudActive (لو فيه ربط ناجح اتحفظ) — وإلا الـenv زي ما هو
  const activeReady = ready.then(() => loadActive()).catch(() => null);
  // حدث الحساب (PARTNER_ADDED…) بيتسجّل صف في wa_onboarding كمان — أثر دائم بالأرقام اللي ميتا بعتتها
  if (wa?.on) wa.on("account", async (a) => {
    await pool.query("INSERT INTO wa_onboarding(created_by, event, waba_id, business_id, info, status) VALUES ('webhook',$1,$2,$3,$4,'recorded')",
      [`account_update:${String(a.event || "").slice(0, 40)}`, a.wabaId || a.entryId || null, a.ownerBusinessId || null, J(a)]).catch(() => {});
  });

  const STEPS = {
    subscribe: (waba) => (tok) => graph("POST", `${waba}/subscribed_apps`, { token: tok }),
    sync_contacts: (phone) => (tok) => graph("POST", `${phone}/smb_app_data`, { token: tok, body: { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" } }),
    sync_history: (phone) => (tok) => graph("POST", `${phone}/smb_app_data`, { token: tok, body: { messaging_product: "whatsapp", sync_type: "history" } }),
  };

  async function runSteps(rec, names) {
    const steps = { ...(rec.steps || {}) };
    for (const n of names) {
      // G3: المزامنة محتاجة phone_id — لو ناقص بنجيبه من الحساب الأول (مرة واحدة لكل تشغيل)
      if (n !== "subscribe" && !rec.phone_id && rec.waba_id && !steps._lookedUp) {
        steps._lookedUp = true;
        try { const lk = await lookupPhone(rec); if (lk) steps.lookup_phone = lk; } catch (e) { steps.lookup_phone = { ...errJ(e), at: new Date(now()).toISOString() }; }
      }
      const target = n === "subscribe" ? rec.waba_id : rec.phone_id;
      if (!target) { steps[n] = { ok: false, error: "missing_id", at: new Date(now()).toISOString() }; continue; }
      steps[n] = await step(STEPS[n](target), rec.biz_token);
      // المزامنة التانية بعد الأولى — ميتا: جهات الاتصال الأول وبعدين التاريخ
    }
    delete steps._lookedUp;
    const all = ["subscribe", "sync_contacts", "sync_history"].map((k) => steps[k]).filter(Boolean);
    const status = all.length === 3 && all.every((s) => s.ok) ? "done" : all.some((s) => s.ok) ? "partial" : "failed";
    await pool.query("UPDATE wa_onboarding SET steps=$2, status=$3 WHERE id=$1", [rec.id, J(steps), status]);
    acceptCache = { at: 0, data: null };
    // G4: ربط ناجح ⇒ أرقامه هي الفعّالة (لو اتغيّرت)
    let active = null;
    try {
      active = activeFromRecord({ ...rec, steps });
      if (active && (active.phoneId !== phoneId() || active.wabaId !== wabaId())) await saveActive(active, rec.created_by);
    } catch (e) { console.error("[wa-cloud] active ids:", e.message); }
    return { steps, status, active };
  }

  const pubRec = (r) => (r ? { id: Number(r.id), at: r.created_at, by: r.created_by, event: r.event, wabaId: r.waba_id,
    phoneId: r.phone_id, businessId: r.business_id, samePhone: r.same_phone, sameWaba: r.same_waba,
    hasBusinessToken: Boolean(r.biz_token), businessTokenAt: r.biz_token_at, steps: r.steps || {}, status: r.status,
    syncDeadline: r.created_at ? new Date(new Date(r.created_at).getTime() + 24 * 3600e3).toISOString() : null } : null);
  const idsNow = () => (wa?.idsInUse ? wa.idsInUse() : { phoneId: phoneId() || null, wabaId: wabaId() || null, phoneSource: "env", wabaSource: "env", envPhoneId: envPhoneId() || null, envWabaId: envWabaId() || null });
  const lastRec = async () => (await pool.query("SELECT * FROM wa_onboarding WHERE waba_id IS NOT NULL OR phone_id IS NOT NULL ORDER BY id DESC LIMIT 1")).rows[0] || null;

  // ── الإعدادات اللي صفحة الربط محتاجاها (من غير أسرار) ───────────────────
  app.get("/api/cms/wa-cloud/config", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const cc = cloudCfg(await getSettingsData());
    return c.json({ ok: true, appId: env("WHATSAPP_APP_ID", APP_ID), configId: env("WHATSAPP_ES_CONFIG_ID") || cc.configId,
      graphVersion: GRAPH_VERSION, onboardWrite: onboardWrite(), appSecret: Boolean(appSecret()),
      phoneId: phoneId() || null, wabaId: wabaId() || null, knownPhoneId: KNOWN_PHONE_ID, knownWabaId: KNOWN_WABA_ID,
      last: pubRec(await lastRec()) });
  });

  // أحداث الـpopup (إلغاء/غلط/خلص) — تسجيل بس، مفيش أي طلب لميتا
  app.post("/api/cms/wa-cloud/signup-event", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const b = await c.req.json().catch(() => ({}));
    const ev = String(b.event || "").slice(0, 60);
    if (!ev) return c.json({ ok: false, error: "no_event" });
    const w = await who(c);
    await pool.query("INSERT INTO wa_onboarding(created_by, event, waba_id, phone_id, business_id, info, status) VALUES ($1,$2,$3,$4,$5,$6,'recorded')",
      [w.name, ev, b.waba_id ? String(b.waba_id).slice(0, 30) : null, b.phone_number_id ? String(b.phone_number_id).slice(0, 30) : null,
        b.business_id ? String(b.business_id).slice(0, 30) : null, J({ data: b.data || null, ua: String(c.req.header("user-agent") || "").slice(0, 160) })]);
    return c.json({ ok: true });
  });

  /* ── مساعد ما بعد الربط ─────────────────────────────────────────────────
     {code, waba_id, phone_number_id, business_id?} من Embedded Signup.
     مقفول بـ WHATSAPP_ONBOARD_WRITE=1 — من غيره بنسجّل الأرقام بس (الكود
     بيبوظ بعد دقايق، فلازم المفتاح يتفتح **قبل** مسح الـQR). */
  app.post("/api/cms/wa-cloud/onboard", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const b = await c.req.json().catch(() => ({}));
    const waba = String(b.waba_id || "").replace(/\D/g, "").slice(0, 30) || null;
    const phone = String(b.phone_number_id || "").replace(/\D/g, "").slice(0, 30) || null;
    const biz = String(b.business_id || "").replace(/\D/g, "").slice(0, 30) || null;
    if (!waba && !phone) return c.json({ ok: false, error: "missing_ids", message: "مفيش waba_id ولا phone_number_id" });
    const samePhone = phone ? phone === (envPhoneId() || KNOWN_PHONE_ID) : null;
    const sameWaba = waba ? waba === (envWabaId() || KNOWN_WABA_ID) : null;
    const w = await who(c);
    const rec = (await pool.query(
      `INSERT INTO wa_onboarding(created_by, event, waba_id, phone_id, business_id, same_phone, same_waba, status)
       VALUES ($1,'onboard',$2,$3,$4,$5,$6,$7) RETURNING *`,
      [w.name, waba, phone, biz, samePhone, sameWaba, onboardWrite() ? "running" : "write_disabled"])).rows[0];
    const envHint = { WHATSAPP_PHONE_ID: phone, WHATSAPP_WABA_ID: waba,
      changePhone: phone && envPhoneId() !== phone, changeWaba: waba && envWabaId() !== waba };
    if (!onboardWrite()) {
      return c.json({ ok: false, error: "onboard_write_disabled", recorded: pubRec(rec), envHint,
        message: "الأرقام اتسجّلت، بس المزامنة مااشتغلتش — WHATSAPP_ONBOARD_WRITE مقفول" });
    }
    // ١) تبديل الكود بتوكن بزنس — احتياطي (الإرسال بتوكن النظام)
    const steps = {};
    if (b.code && appSecret()) {
      try {
        const d = await graph("GET", "oauth/access_token", { token: null,
          query: { client_id: env("WHATSAPP_APP_ID", APP_ID), client_secret: appSecret(), code: String(b.code).slice(0, 2000) } });
        if (d.access_token) {
          await pool.query("UPDATE wa_onboarding SET biz_token=$2, biz_token_at=NOW() WHERE id=$1", [rec.id, d.access_token]);
          rec.biz_token = d.access_token;
        }
        steps.exchange = { ok: Boolean(d.access_token), at: new Date(now()).toISOString() };
      } catch (e) { steps.exchange = { ...errJ(e), at: new Date(now()).toISOString() }; }
    } else {
      steps.exchange = { ok: false, skipped: b.code ? "no_app_secret" : "no_code", at: new Date(now()).toISOString() };
    }
    rec.steps = steps;
    const r = await runSteps(rec, ["subscribe", "sync_contacts", "sync_history"]);
    // G3: لو الرقم اتجاب من الحساب، التلميح بتاع الـenv بيتحدّث بيه
    if (rec.phone_id && !phone) { envHint.WHATSAPP_PHONE_ID = rec.phone_id; envHint.changePhone = envPhoneId() !== rec.phone_id; }
    return c.json({ ok: r.status === "done", status: r.status, onboarding: pubRec({ ...rec, steps: r.steps, status: r.status }), envHint,
      ids: idsNow(), active: r.active || null });
  });

  // إعادة خطوة (مثلاً المزامنة فشلت) — نفس المفتاح، وعلى آخر ربط
  app.post("/api/cms/wa-cloud/onboard/retry", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    if (!onboardWrite()) return c.json({ ok: false, error: "onboard_write_disabled" });
    const b = await c.req.json().catch(() => ({}));
    const names = (Array.isArray(b.steps) ? b.steps : [b.step]).filter((s) => STEPS[s]);
    if (!names.length) return c.json({ ok: false, error: "bad_step" });
    const rec = (await pool.query("SELECT * FROM wa_onboarding WHERE event='onboard' ORDER BY id DESC LIMIT 1")).rows[0];
    if (!rec) return c.json({ ok: false, error: "no_onboarding" });
    const late = now() - new Date(rec.created_at).getTime() > 24 * 3600e3;
    const r = await runSteps(rec, names);
    return c.json({ ok: names.every((n) => r.steps[n]?.ok), status: r.status, late, onboarding: pubRec({ ...rec, steps: r.steps, status: r.status }),
      ids: idsNow(), usedBusinessToken: Boolean(rec.biz_token) });
  });

  /* W5 — المالك يختار مصدر الأرقام الفعّالة: {use:"env"} يرجع لأرقام الـenv (يمسح settings.waCloudActive)،
     {use:"onboarding"} يرجع لآخر ربط ناجح. مابيبعتش حاجة لميتا ومالوش علاقة بالإرسال. */
  app.post("/api/cms/wa-cloud/active", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const b = await c.req.json().catch(() => ({}));
    const w = await who(c);
    if (b.use === "env") { await saveActive(null, w.name); return c.json({ ok: true, ids: idsNow() }); }
    if (b.use !== "onboarding") return c.json({ ok: false, error: "bad_use", message: "use = env أو onboarding" }, 400);
    const rows = (await pool.query("SELECT * FROM wa_onboarding WHERE event='onboard' ORDER BY id DESC LIMIT 10")).rows;
    const a = rows.map(activeFromRecord).find(Boolean);
    if (!a) return c.json({ ok: false, error: "no_successful_onboarding", message: "مفيش ربط ناجح (اشتراك + رقمين) نرجع له" });
    await saveActive(a, w.name);
    return c.json({ ok: true, ids: idsNow(), active: a });
  });

  /* ── الحالة (قراية بس) ──────────────────────────────────────────────────
     حالة الرقم متخزّنة ١٠ دقايق عشان wasender يعرف القناة الافتراضية من غير
     ما يسأل ميتا كل شوية. */
  let phoneCache = { at: 0, data: null };
  const PHONE_FIELDS = "display_phone_number,verified_name,status,quality_rating,platform_type,throughput,messaging_limit_tier,code_verification_status,name_status,is_on_biz_app,health_status";
  const PHONE_FIELDS_MIN = "display_phone_number,verified_name,status,quality_rating,platform_type,throughput,messaging_limit_tier,code_verification_status";
  async function phoneInfo({ fresh = false } = {}) {
    const pid = phoneId() || KNOWN_PHONE_ID;
    /* QP1: قراءة فاشلة بتتخزّن دقيقة بس (كانت ١٠) — بوابة الجودة بتوقف التسويق طول ما القراءة فاشلة، فمانستناش ١٠ دقايق بعد ما ميتا ترجع */
    if (!fresh && phoneCache.data && now() - phoneCache.at < (phoneCache.data.ok ? 10 * 60e3 : 60e3) && phoneCache.data.id === pid) return phoneCache.data;
    if (!sysToken()) return { ok: false, error: "no_token", id: pid };
    let d;
    try { d = await graph("GET", pid, { query: { fields: PHONE_FIELDS } }); }
    catch (e) {
      if (Number(e.code) !== 100) { const x = { ...errJ(e), id: pid }; phoneCache = { at: now(), data: x }; return x; }
      try { d = await graph("GET", pid, { query: { fields: PHONE_FIELDS_MIN } }); }
      catch (e2) { const x = { ...errJ(e2), id: pid }; phoneCache = { at: now(), data: x }; return x; }
    }
    /* TL1 (١٣/١٠): ميتا بقت تحسب الحد على مستوى المحفظة (كل أرقام البزنس). الحقل على حساب واتساب نفسه؛ قراءة بس،
       ولو الحقل مش متاح للتوكن ده بنرجّع السبب بدل ما نخمّن. حد الرقم (tier) بيفضل زي ما هو. */
    let portfolio = null;
    try {
      const w = await graph("GET", wabaId() || KNOWN_WABA_ID, { query: { fields: "whatsapp_business_manager_messaging_limit" } });
      portfolio = { ok: true, limit: w.whatsapp_business_manager_messaging_limit ?? null };
    } catch (e) { portfolio = { ok: false, error: String(e.message || e).slice(0, 160) }; }
    const x = { ok: true, id: pid, number: d.display_phone_number || null, name: d.verified_name || null, portfolio,
      status: d.status || null, quality: d.quality_rating || null, platform: d.platform_type || null,
      throughput: d.throughput?.level || null, tier: d.messaging_limit_tier || null,
      verification: d.code_verification_status || null, nameStatus: d.name_status || null,
      isOnBizApp: d.is_on_biz_app ?? null, health: d.health_status?.can_send_message || null,
      checkedAt: new Date(now()).toISOString() };      // QP1: بوابة الجودة بترفض قراءة أقدم من qualityMaxAgeMin
    phoneCache = { at: now(), data: x };
    return x;
  }

  let tplCache = { at: 0, data: null };
  let tplComps = null;      // TS1: Map("name:lang" ⇒ مكوّنات القالب عند ميتا) من آخر قراءة ناجحة، أو null لو مااتقرتش
  /* TS1: حالة قالب كتالوج قصاد نسخة ميتا للغة دي:
       same      نفس النص والأزرار                        differs  مختلف (diffs = إيه اللي مختلف) ⇒ مايتبعتش في حملة
       missing   مش موجود عند ميتا باللغة دي              unknown  ماقدرناش نقرا ميتا / المكوّنات */
  async function templateSync(name, lang = "ar", { fresh = false } = {}) {
    const t = TEMPLATES[name];
    if (!t) return { state: "unknown", status: null, diffs: [], why: "unknown_template" };
    let info = null; try { info = await templateInfo({ fresh }); } catch { info = null; }
    if (!info || info.ok !== true || !tplComps) return { state: "unknown", status: null, diffs: [], why: info && info.ok === true ? "components_not_read" : "meta_not_read" };
    const row = (info.list || []).find((x) => x.name === name && String(x.language || "").slice(0, 2) === lang);
    const theirs = tplComps.get(`${name}:${lang}`);
    if (!row || !theirs) return { state: "missing", status: row ? row.status : "NOT_SUBMITTED", diffs: [] };
    const diffs = templateDiff((t.variants && t.variants[lang]) || t.components, theirs);
    return { state: diffs.length ? "differs" : "same", status: row.status || null, diffs };
  }
  async function templateInfo({ fresh = false } = {}) {
    const waba = wabaId() || KNOWN_WABA_ID;
    if (!fresh && tplCache.data && now() - tplCache.at < (tplCache.data.ok ? 10 * 60e3 : 60e3)) return tplCache.data;      // QP1: الفشل بيتخزّن دقيقة بس
    if (!sysToken()) return { ok: false, error: "no_token" };
    try {
      /* QP1: بنطلب جودة كل قالب (quality_score). لو ميتا رفضت الحقل، بنرجع للحقول القديمة عشان شاشات القوالب ماتقعش — وبنعلّم
         qualityRead=false: بوابة الجودة ساعتها بتوقف التسويق («ماقدرناش نقرا جودة القوالب») بدل ما تفترض إنها تمام. */
      let d, qualityRead = true;
      /* TS1: + components — عشان نقارن النسخة اللي عند ميتا بالكتالوج (templateSync). لو الطلب الكامل اترفض بنرجع لأبسط شكل والمقارنة تبقى «مش معروف». */
      let compsRead = true;
      try { d = await graph("GET", `${waba}/message_templates`, { query: { fields: "name,status,category,language,quality_score,components", limit: "200" } }); }
      catch {
        compsRead = false;
        try { d = await graph("GET", `${waba}/message_templates`, { query: { fields: "name,status,category,language,quality_score", limit: "200" } }); }
        catch { d = await graph("GET", `${waba}/message_templates`, { query: { fields: "name,status,category,language", limit: "200" } }); qualityRead = false; }
      }
      /* مكوّنات ميتا بتتخزّن جنب الكاش (مش في الرد: حجمها كبير ومالهاش لازمة في الشاشات) */
      tplComps = compsRead ? new Map((d.data || []).filter((t) => Array.isArray(t.components)).map((t) => [`${t.name}:${String(t.language || "").slice(0, 2)}`, t.components])) : null;
      const list = (d.data || []).map((t) => ({ name: t.name, status: t.status, category: t.category, language: t.language, quality: (t.quality_score && t.quality_score.score) || null }));
      const byStatus = {};
      for (const t of list) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      const x = { ok: true, qualityRead, checkedAt: new Date(now()).toISOString(), total: list.length, byStatus, list,
        // «ours» = القوالب القديمة بس — زرار «قدّم N قالب» في اللوحة بيقدّمها كلها، فالكتالوج مايدخلش فيه
        ours: Object.keys(TEMPLATES).filter((n) => !TEMPLATES[n].catalog).map((n) => ({ name: n, category: TEMPLATES[n].category,
          campaign: Boolean(TEMPLATES[n].campaign), label: TEMPLATES[n].campaign?.label || null,
          status: list.find((t) => t.name === n)?.status || "NOT_SUBMITTED" })),
        // قوالب الكتالوج (watemplates.js): كل واحد يتقدّم لوحده بزراره — حالة كل لغة من ميتا
        catalog: Object.keys(TEMPLATES).filter((n) => TEMPLATES[n].catalog).map((n) => {
          const t = TEMPLATES[n];
          const langs = Object.keys(t.variants || { [t.language || "ar"]: 1 });
          const st = langs.map((l) => list.find((x) => x.name === n && String(x.language || "").slice(0, 2) === l)?.status || "NOT_SUBMITTED");
          return { name: n, category: t.category, group: t.group || null, purpose: t.purpose || null, languages: langs,
            needsImage: (t.components || []).some((c) => c.type === "HEADER" && c.format === "IMAGE"),
            body: (t.components.find((c) => c.type === "BODY") || {}).text || "",
            statuses: Object.fromEntries(langs.map((l, i) => [l, st[i]])),
            /* TS1: الكتالوج زي نسخة ميتا؟ لكل لغة: same | differs | missing | unknown */
            sync: Object.fromEntries(langs.map((l) => { const th = tplComps && tplComps.get(`${n}:${l}`);
              return [l, !tplComps ? "unknown" : !th ? "missing" : templateDiff((t.variants && t.variants[l]) || t.components, th).length ? "differs" : "same"]; })),
            status: st.every((x) => x === st[0]) ? st[0] : st.includes("REJECTED") ? "REJECTED" : st.includes("NOT_SUBMITTED") ? "NOT_SUBMITTED" : "PENDING" };
        }) };
      tplCache = { at: now(), data: x };
      return x;
    } catch (e) { const x = errJ(e); tplCache = { at: now(), data: x }; return x; }
  }

  app.get("/api/cms/wa-cloud/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const fresh = c.req.query("fresh") === "1";
    const waba = wabaId() || KNOWN_WABA_ID;
    const [phone, tpl, subs, hooks, hist, last, gate] = await Promise.all([
      phoneInfo({ fresh }),
      templateInfo({ fresh }),
      sysToken() ? graph("GET", `${waba}/subscribed_apps`).then((d) => ({ ok: true,
        apps: (d.data || []).map((a) => ({ id: a.whatsapp_business_api_data?.id || a.id || null, name: a.whatsapp_business_api_data?.name || a.name || null })) }))
        .catch(errJ) : Promise.resolve({ ok: false, error: "no_token" }),
      pool.query("SELECT field, last_at, n, last_note FROM wa_webhook_health ORDER BY last_at DESC").then((r) => r.rows).catch(() => []),
      pool.query("SELECT imported, skipped, chunks, last_meta, errors, updated_at FROM wa_history_state WHERE id=1").then((r) => r.rows[0] || null).catch(() => null),
      lastRec().catch(() => null),
      wa ? wa.gate() : Promise.resolve("disabled"),
    ]);
    const lastEvent = hooks.filter((h) => !String(h.field).startsWith("_")).map((h) => h.last_at).sort().pop() || null;
    const ourApp = subs.ok ? subs.apps.some((a) => String(a.id) === env("WHATSAPP_APP_ID", APP_ID)) : null;
    return c.json({ ok: true, phone, templates: tpl, subscribedApps: { ...subs, ours: ourApp },
      webhook: { lastEventAt: lastEvent, fields: hooks, callback: "/api/wa/webhook" }, history: hist,
      onboarding: pubRec(last), gate: gate || null,
      // W5: الأرقام المستعملة فعلاً ومصدرها (آخر ربط ناجح ولا الـenv)، والتوكن اللي السيرفر بيستعمله
      ids: idsNow(),
      tokens: { sending: env("WHATSAPP_TOKEN") ? "WHATSAPP_TOKEN" : env("META_CAPI_TOKEN") ? "META_CAPI_TOKEN" : null, sendingKind: "system",
        business: last ? { stored: Boolean(last.biz_token), at: last.biz_token_at || null, onboardingId: Number(last.id),
          expiresAbout: last.biz_token_at ? new Date(new Date(last.biz_token_at).getTime() + 60 * 86400e3).toISOString() : null } : { stored: false },
        syncOrder: last && last.biz_token ? ["business", "system"] : ["system"] },
      env: { WHATSAPP_ENABLED: env("WHATSAPP_ENABLED") === "1", WHATSAPP_PHONE_ID: envPhoneId() || null, WHATSAPP_WABA_ID: envWabaId() || null,
        token: env("WHATSAPP_TOKEN") ? "WHATSAPP_TOKEN" : env("META_CAPI_TOKEN") ? "META_CAPI_TOKEN" : null,
        WHATSAPP_APP_SECRET: Boolean(env("WHATSAPP_APP_SECRET")), WHATSAPP_VERIFY_TOKEN: Boolean(env("WHATSAPP_VERIFY_TOKEN")),
        WHATSAPP_ONBOARD_WRITE: onboardWrite(), WHATSAPP_TEMPLATES_WRITE: env("WHATSAPP_TEMPLATES_WRITE") === "1" },
      defaultChannel: defaultChannel({ gate, phoneStatus: phone?.status }) });
  });

  /* 🎬 عرض مراجعة التطبيق (App Review) — ٢٩/٩
     ميتا بتطلب فيديوهين عشان تدّي Advanced Access (شرط الـEmbedded Signup):
     ١) whatsapp_business_messaging: التطبيق بيبعت رسالة وبتوصل على واتساب.
     ٢) whatsapp_business_management: التطبيق بيعمل قالب رسالة.
     الإرسال من رقم ميتا التجريبي (بيبعت بس للأرقام المسجّلة في قايمة المستلمين)
     أو من رقمنا لما يتربط. إنشاء القالب على الـWABA الحقيقي — مقفول بـ
     WHATSAPP_TEMPLATES_WRITE=1 زي تقديم القوالب. */
  const TEST_PHONE_ID = () => env("WHATSAPP_TEST_PHONE_ID", "1376437515542744");
  // الـWABA الحقيقي (رقم المطعم) مربوط بتطبيق الموبايل بس لحد الـCoexistence، وميتا بترفض
  // إنشاء قوالب عليه (sub 2494160 «This WABA is not allowed to create or update templates»)
  // ⇒ العرض بيعمل القالب على حساب ميتا التجريبي، اللي بعت منه الرسالة في الفيديو الأول.
  const TEST_WABA_ID = () => env("WHATSAPP_TEST_WABA_ID", "1375373441250188");
  app.post("/api/cms/wa-cloud/demo/send", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const to = String(b.to || "").replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(to)) return c.json({ ok: false, error: "bad_to", message: "Enter the full number with country code" });
    const from = b.sender === "live" ? (phoneId() || KNOWN_PHONE_ID) : TEST_PHONE_ID();
    const template = /^[a-z0-9_]{1,512}$/.test(String(b.template || "")) ? String(b.template) : "hello_world";
    const language = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(b.language || "")) ? String(b.language) : "en_US";
    /* SEC (١٢/١٠): كان بيبعت لأي رقم من غير أي قفل. دلوقتي إرسال تجربة عن طريق الحارس المركزي:
       لأرقام التجربة اللي في اللوحة بس (رقم سعودي)، والإرسال نفسه من wa.deliver (المكان الوحيد لـ/messages). */
    if (!wa || typeof wa.guardSend !== "function") return c.json({ ok: false, error: "whatsapp_unavailable", message: "WhatsApp module is not loaded" });
    const pn = /^9665\d{8}$/.test(to) ? to.slice(3) : "";
    const g = await wa.guardSend({ phoneNorm: pn, kind: "template", template, source: "test", test: true, fromId: from });
    if (!g.ok) {
      return c.json({ ok: false, error: g.reason, message: g.reason === "not_in_allow_list" || g.reason === "invalid_phone"
        ? "Add this number to the test numbers list in the dashboard first (Saudi mobile, 9665XXXXXXXX)" : `Blocked: ${g.reason}` }, 403);
    }
    try {
      const d = await wa.deliver(g.ticket, { messaging_product: "whatsapp", to, type: "template",
        template: { name: template, language: { code: language } } });
      return c.json({ ok: true, from, to, template, messageId: d.messages?.[0]?.id || null, status: d.messages?.[0]?.message_status || "accepted" });
    } catch (e) { return c.json(errJ(e)); }
  });
  /* 🔒 مفتاح واتساب الرئيسي (المالك بس) — settings.waMaster. الإرسال للعملاء محتاج المفتاح ده **و** مفتاح الخادم
     (WHATSAPP_ENABLED) مع بعض؛ مفتاح الخادم قفل صلب فوقه. التشغيل لازم ييجي ومعاه confirm:true (الخطوة التانية في اللوحة).
     القراية لأي أدمن (عشان الشاشات تعرض الحالة)، الكتابة للمالك بس. */
  const masterView = async () => {
    const s = await getSettingsData();
    const m = (s.waMaster && typeof s.waMaster === "object") ? s.waMaster : {};
    const blockedBy = wa && wa.gate ? await wa.gate() : "disabled";
    const sessionBlockedBy = wa && wa.gate ? await wa.gate("session") : "disabled";      // SW1: الرد الحر (بوت + موظف) له أقفاله
    return { enabled: m.enabled === true, by: m.by || null, at: m.at || null, log: Array.isArray(m.log) ? m.log.slice(-20) : [],
      envState: wa && wa.envState ? wa.envState() : "unset", blockedBy: blockedBy || null, sending: !blockedBy,
      sessionBlockedBy: sessionBlockedBy || null, sessionSending: !sessionBlockedBy,
      testPhones: wa && wa.testPhones ? (await wa.testPhones()).length : 0 };
  };
  app.get("/api/cms/wa-cloud/master", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, master: await masterView() });
  });
  app.post("/api/cms/wa-cloud/master", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    if (typeof b.enabled !== "boolean") return c.json({ ok: false, error: "bad_enabled", message: "enabled لازم true أو false" }, 400);
    if (b.enabled && b.confirm !== true) return c.json({ ok: false, error: "confirm_required", message: "التشغيل محتاج تأكيد" }, 400);
    const s = await getSettingsData();
    const cur = (s.waMaster && typeof s.waMaster === "object") ? s.waMaster : {};
    const entry = { enabled: b.enabled, by: (await who(c)).name, at: new Date().toISOString() };
    const next = { ...entry, log: [...(Array.isArray(cur.log) ? cur.log : []), entry].slice(-20) };
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waMaster}', $1::jsonb, true), updated_at=NOW() WHERE id=1",
      [JSON.stringify(next)]);
    return c.json({ ok: true, master: await masterView() });
  });

  /* ══ SW1 (١٣/١٠ — M6): مفاتيح مستقلة ══════════════════════════════════════════════════════════════════
     GET  /api/cms/wa-cloud/checklist   (أي أدمن — قراءة): الأقفال الأربعة، حالة مفتاح الخادم، قفل كل مسار (رد حر / قوالب)،
                                         المراحل وحالة قالب كل مرحلة عند ميتا، وإيه اللي هيبدأ يتبعت لو المفتاح الرئيسي اتفتح.
     POST /api/cms/wa-cloud/stages      (المالك): {stages:[…], replacesSms:[…]} — مراحل تحديثات الطلب على واتساب و«يغني عن الـSMS» لكل مرحلة.
                                         إضافة مرحلة محتاجة قالبها معتمد وخدمي عند ميتا (قراءة جديدة)؛ الشيل مسموح دايماً. */
  async function stagesNow(s, { fresh = false } = {}) {
    let tpl = null; try { tpl = await templateInfo({ fresh }); } catch { tpl = null; }
    return { tpl, rows: stageRows({ stageTemplates: STAGE_TEMPLATES, notifications: (s && s.notifications) || {}, metaList: (tpl && tpl.list) || [], metaOk: Boolean(tpl && tpl.ok === true), mandatorySms: MANDATORY_SMS_STAGES }) };
  }
  /* رسايل حملات Cloud اللي في الطابور (شغّالة / موقوفة) وسبب وقوف القناة — null لو الجداول مش مقروءة */
  async function queuedCloud() {
    try {
      const r = (await pool.query(
        `SELECT count(*) FILTER (WHERE j.status='running')::int AS rm, count(DISTINCT q.job_id) FILTER (WHERE j.status='running')::int AS rj,
                count(*) FILTER (WHERE j.status='paused')::int AS pm, count(DISTINCT q.job_id) FILTER (WHERE j.status='paused')::int AS pj
           FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id
          WHERE q.status IN ('pending','sending') AND j.status IN ('running','paused') AND COALESCE(q.channel, j.channel) = 'wa_cloud'`)).rows[0] || {};
      return { runningJobs: r.rj || 0, runningMessages: r.rm || 0, pausedJobs: r.pj || 0, pausedMessages: r.pm || 0 };
    } catch { return null; }
  }
  const cloudStopped = async () => { try { return (await pool.query("SELECT stopped_reason FROM wa_sender_state WHERE id=2")).rows[0]?.stopped_reason || null; } catch { return null; } };
  app.get("/api/cms/wa-cloud/checklist", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    let s = null; try { s = (await getSettingsData()) || {}; } catch { s = null; }
    const st = s || {}, m = (st.waMaster && typeof st.waMaster === "object") ? st.waMaster : {}, bot = (st.waBot && typeof st.waBot === "object") ? st.waBot : {};
    const blockOf = async (kind) => { try { return wa && wa.gate ? await wa.gate(kind) : "disabled"; } catch { return "settings_unreadable"; } };
    const { rows } = await stagesNow(st, { fresh: c.req.query("fresh") === "1" });
    return c.json({ ok: true, ...checklistView({
      envState: wa && wa.envState ? wa.envState() : "unset", configured: Boolean(wa && wa.configured && wa.configured()), settingsReadable: Boolean(s),
      master: { enabled: m.enabled === true, by: m.by || null, at: m.at || null }, notifications: st.notifications || {},
      waBot: { mode: bot.mode, liveScope: bot.liveScope, assist: { mode: bot.assist && bot.assist.mode } }, waCloud: { enabled: Boolean(st.waCloud && st.waCloud.enabled === true) },
      stages: rows, sessionBlock: (await blockOf("session")) || null, templateBlock: (await blockOf("template")) || null,
      queued: await queuedCloud(), stoppedReason: await cloudStopped(), testPhones: wa && wa.testPhones ? (await wa.testPhones().catch(() => [])).length : 0 }) });
  });
  app.post("/api/cms/wa-cloud/stages", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    await ready;
    const b = await c.req.json().catch(() => ({}));
    const s = (await getSettingsData()) || {};
    const n = (s.notifications && typeof s.notifications === "object") ? s.notifications : {};
    const current = waStagesOf(n);
    const { tpl } = await stagesNow(s, { fresh: true });
    const p = stagesProblem({ want: b.stages, replaces: b.replacesSms, stageTemplates: STAGE_TEMPLATES, current, metaList: (tpl && tpl.list) || [], metaOk: Boolean(tpl && tpl.ok === true) });
    if (p) return c.json({ ok: false, ...p }, ["meta_unreadable", "template_not_approved", "template_not_utility"].includes(p.error) ? 409 : 400);
    const want = [...new Set(b.stages.map(String))];
    /* «يغني عن الـSMS» لو مااتبعتش: اللي كان متعلّم يفضل (للمراحل اللي لسه مشغّلة) — والمفتاح القديم العام بيتحوّل لقايمة بنفس المعنى */
    const replaces = Array.isArray(b.replacesSms) ? [...new Set(b.replacesSms.map(String))] : want.filter((x) => waReplacesSms(n, x));
    await pool.query(
      `UPDATE settings SET data = jsonb_set(jsonb_set(jsonb_set(COALESCE(data,'{}'::jsonb), '{notifications}', COALESCE(data->'notifications','{}'::jsonb), true),
                                                      '{notifications,whatsappStages}', $1::jsonb, true), '{notifications,whatsappReplacesSmsStages}', $2::jsonb, true), updated_at=NOW() WHERE id=1`,
      [J(want), J(replaces)]);
    const next = { ...s, notifications: { ...n, whatsappStages: want, whatsappReplacesSmsStages: replaces } };
    return c.json({ ok: true, by: (await who(c)).name, stages: (await stagesNow(next)).rows, enabled: want, replacesSms: replaces,
      orderUpdatesSwitch: n.whatsappEnabled === true });
  });

  app.post("/api/cms/wa-cloud/demo/template", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    if (env("WHATSAPP_TEMPLATES_WRITE") !== "1") return c.json({ ok: false, error: "templates_write_disabled", message: "Set WHATSAPP_TEMPLATES_WRITE=1" });
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name || "").trim().toLowerCase();
    const text = String(b.body || "").trim();
    const category = ["UTILITY", "MARKETING"].includes(b.category) ? b.category : "UTILITY";
    const language = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(b.language || "")) ? String(b.language) : "en_US";
    if (!/^[a-z0-9_]{1,512}$/.test(name)) return c.json({ ok: false, error: "bad_name", message: "Use lowercase letters, numbers and _" });
    if (!text || text.length > 1024) return c.json({ ok: false, error: "bad_body", message: "Body is required (max 1024)" });
    // ميتا بترفض ({code:100, sub:2494160}) أي قالب فيه {{n}} من غير أمثلة للقيم
    const nVars = [...new Set((text.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map((m) => Number(m.replace(/\D/g, ""))))].length;
    const SAMPLES = ["Ahmed", "10245", "Fresh Cuts", "25 SAR", "7:30 PM"];
    const bodyComp = { type: "BODY", text,
      ...(nVars ? { example: { body_text: [Array.from({ length: nVars }, (_, i) => SAMPLES[i] || `value${i + 1}`)] } } : {}) };
    try {
      const target = b.waba === "live" ? (wabaId() || KNOWN_WABA_ID) : TEST_WABA_ID();
      const d = await graph("POST", `${target}/message_templates`, { body: { name, language, category,
        components: [bodyComp] } });
      tplCache = { at: 0, data: null };
      return c.json({ ok: true, id: d.id || null, status: d.status || null, category: d.category || category, name, waba: target });
    } catch (e) { return c.json(errJ(e)); }
  });

  // إعدادات قناة الـCloud + config_id (المالك)
  app.post("/api/cms/wa-cloud/settings", async (c) => {
    const err = await ownerOnly(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const s = await getSettingsData();
    const cur = (s.waCloud && typeof s.waCloud === "object") ? s.waCloud : {};
    const next = { ...cur };
    for (const k of [...CLOUD_KEYS, "configId"]) if (b[k] !== undefined) next[k] = b[k];
    if (cur.rev) next.rev = cur.rev;
    const clean = cloudCfg({ waCloud: next });
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waCloud}', $1::jsonb, true) WHERE id=1`, [J(clean)]);
    // التشغيل من تاني بيمسح «اتوقف» (المالك بص وقرر)
    if (b.enabled === true) await pool.query("UPDATE wa_sender_state SET stopped_reason=NULL, fail_streak=0 WHERE id=2").catch(() => {});
    return c.json({ ok: true, cfg: clean });
  });

  return { templateSync, phoneInfo, templateInfo, ready, cloudCfg, activeReady, webhookAccept, idsNow, qualityMigrated };
}
