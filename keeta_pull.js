/* ═══════════════════════════════════════════════════════════════════════════
   KA2 — بعد طلب كيتا: التقييم الأول، وبعدين «اطلب مباشرة من موقعنا» بشرط (عمر ١٨/١٠/٢٠٢٦)

   المواصفة: docs/designs-2026-10/ka2-spec-2026-10-18.md + قرارات المالك ١٨/١٠ (الأخيرة):
     • أول رسالة بعد طلب كيتا في نقطة البيع بـ٥٠ دقيقة = **طلب تقييم** لطلب كيتا ده — نفس مسار التقييم على واتساب (reviews.js ⇐ wabotrun.reviewAsk):
       جوّه النافذة قايمة النجوم، بره النافذة قالب fc_review_stars المعتمد. الدعوة نفسها «pos:<رقم طلب كيتا>» في review_invites (ka2 = true) ⇒ التقييم
       بيتسجّل على الطلب، والوارد والبورتال والإحصائيات زي أي تقييم.
     • رسالة «اطلب مباشرة + توصيل مجاني أول طلب بكود FIRST» (قالب fc_try_website المعتمد، الرابط freshcuts.sa/l/keeta-first-<كود شخصي> — cms_links 606)
       **بس** لو العميل قيّم ٤–٥ نجوم، أو قيّم واطي والشكوى اتقفلت «اتحلت» (portalreviews.closeReview — نفس صف reviews: resolved + outcome).
       تقييم واطي مفتوح، أو مفيش تقييم ⇒ مفيش رسالة أبداً. ⇒ KA2 = رسالتين بالكتير في عمر الرقم.
     • ٢٠ في اليوم من أول يوم (مفيش تدرّج). عملاء كيتا الجداد بيتعالجوا أول بأول (كل دورة الـ٥ دقايق بعد ما فيدأس يجيب الجوال) — مفيش دفعات.
     • مفيش نافذة ساعات خاصة بـKA2: بتتبعت والمطعم مفتوح (sendhours.js — نفس بوابة كل واتساب الآلي).
     • نسبة «إيقاف»/حظر بتتحسب لرسايل KA2 لوحدها وبتظهر في شاشة كيتا وإحصائيات التقييمات؛ فرملة آلية ≥ ٣٪ بعد ٥٠ رسالة (إعداد).
     • مفيش تسجيل/تحذير امتثال في اللوحة (المالك: «كيتا هي اللي بتبعتلنا الرقم، موافقين») ⇒ مصدر موافقة keeta_order لطلب التقييم بس (waconsent.js).
     • المفتاح keeta.pull.enabled مقفول افتراضياً؛ الإعدادات كلها في settings.keeta.pull بتسميات عربي (المالك بس يغيّر)، و«keeta» في SERVER_OWNED_PATHS؛
       أول تشغيل بيسجّل enabledAt ⇒ الطلبات اللي بعده بس (مفيش دفعة على طلبات قديمة).
   الجوالات ٩ أرقام 5xxxxxxxx في كل الجداول (order_sources / shop_orders / wa_messages / ts_customers) ⇒ الربط مباشر.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { shopPaidSql, maskPhone } from "./identity.js";
import { inHoldout, staffPhoneSet } from "./smsrules.js";
import { classifyError, cloudCfg } from "./wacloud.js";
import { parseRecipientSlug } from "./wamsg.js";
import { isRestaurantOpenAt, hoursKnown } from "./sendhours.js";
import { isOpenNow } from "./carts.js";
import { isPlaceholderPhone } from "./phonecheck.js";
import { bizDayStart } from "./wafollow.js";
import { recordKa2ReviewConsent } from "./waconsent.js";
import { reviewSkipPhones } from "./reviews.js";

export const KA2_SOURCE = "ka2";
export const LINK_SLUG = "keeta-first";
export const COUPON_CODE = "FIRST";
export const TEMPLATES = Object.freeze(["fc_try_website"]);
export const MARKETING_SAR = 0.22;      // تكلفة رسالة تسويق تقريبية (قراءة ميتا ١٧/١٠) — للكارت بس
const CODE_RE = /^[a-z0-9]{6}$/;

/* ═══ الإعدادات (settings.keeta.pull) ═════════════════════════════════════ */
export const DEFAULT_PULL = Object.freeze({
  enabled: false, enabledAt: null, paused: false, pauseReason: null, pausedAt: null,      // enabledAt / paused*: السيرفر بيكتبهم (المالك يفكّ الإيقاف بس)
  reviewDelayMin: 50,          // قرار المالك ١٨/١٠: طلب التقييم «بعد ٥٠ دقيقة من تسليم الطلب للمندوب» (KA2c) — من المرجع اللي تحت
  reviewAnchor: "handoff",     // KA2c: handoff = من تسليم الطلب لمندوب كيتا (نقطة البيع) · order = من وقت الطلب (السلوك القديم)
  handoffWaitMin: 90,          // KA2c: التسليم ماظهرش خلال المدة دي من الطلب ⇒ الميعاد = الطلب + fallbackDelayMin (handoff_unknown)
  fallbackDelayMin: 80,        // KA2c: الاحتياطي من وقت الطلب (≈ تحضير + ٥٠)
  handoffMinAfterOrderMin: 5,  // KA2c: إشارة «اتسلّم» قبل المدة دي من الطلب مش تسليم حقيقي (قفل بالغلط) ⇒ بتتجاهل
  pullDelayMin: 10,            // رسالة السحب بعد التقييم العالي / قفل الشكوى بالمدة دي (والهدوء بعد آخر رسالة CJ1a فوقها)
  ratingWaitHours: 24,         // مفيش تقييم خلال المدة دي من طلب التقييم ⇒ مفيش سحب
  lowResolveDays: 3,           // تقييم واطي: لازم يتقفل «اتحلت» خلال المدة دي وإلا مفيش سحب
  lowCloseRule: "resolved",    // resolved = «اتحلت ✅» بس · any_close = أي قفل (اتحلت / اتقفلت من غير إجراء) — «مش عميل / رقم غلط» عمره ما بيعدّي
  maxLateHours: 20,            // رسالة السحب ماطلعتش خلال المدة دي من استحقاقها ⇒ تتلغي (late)
  dailyCap: 20, hourCap: 8,    // قرار المالك ١٨/١٠: ٢٠ في اليوم من أول يوم (يوم العمل من ٤ الفجر)
  campaignGapDays: 7,          // ماتتبعتش لو وصلته رسالة تسويقية في آخر … يوم (دفتر الحملات recentMap) — التخطّي نهائي
  firstWithinDays: 0,          // «عميل كيتا جديد» = مفيش طلب كيتا قبله في آخر … يوم (٠ = في حياته)
  skipDirectCustomers: true,   // استبعاد اللي بياكلوا من المحل (صالة/سفري)
  holdoutPct: 10,              // محجوزين للقياس (اللي استحقوا رسالة السحب بس)
  template: "fc_try_website",
  autoPauseOptoutPct: 3, autoPauseMinSends: 50,
});
const NUM = Object.freeze({
  reviewDelayMin: [10, 180], handoffWaitMin: [30, 240], fallbackDelayMin: [10, 240], handoffMinAfterOrderMin: [0, 60], pullDelayMin: [0, 240], ratingWaitHours: [1, 72], lowResolveDays: [0, 14], maxLateHours: [1, 48],
  dailyCap: [1, 100], hourCap: [1, 50], campaignGapDays: [3, 30], firstWithinDays: [0, 365], holdoutPct: [0, 50],
  autoPauseOptoutPct: [0, 20], autoPauseMinSends: [20, 500],
});
const ENUM = Object.freeze({ lowCloseRule: ["resolved", "any_close"], template: TEMPLATES, reviewAnchor: ["handoff", "order"] });
const BOOLS = Object.freeze(["enabled", "skipDirectCustomers", "paused"]);
const isoOrNull = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

export function pullCfg(settingsOrPull) {
  const s = settingsOrPull && typeof settingsOrPull === "object" ? settingsOrPull : {};
  const x = s.keeta && typeof s.keeta === "object" ? (s.keeta.pull || {}) : ("reviewDelayMin" in s || "enabled" in s ? s : {});
  const out = {
    enabled: x.enabled === true, enabledAt: isoOrNull(x.enabledAt),
    paused: x.paused === true, pauseReason: x.paused === true && x.pauseReason ? String(x.pauseReason).slice(0, 120) : null, pausedAt: x.paused === true ? isoOrNull(x.pausedAt) : null,
    skipDirectCustomers: x.skipDirectCustomers !== false,
  };
  for (const [k, [lo, hi]] of Object.entries(NUM)) {
    const n = Number(x[k]);
    out[k] = x[k] !== "" && x[k] !== null && x[k] !== undefined && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : DEFAULT_PULL[k];
  }
  for (const [k, opts] of Object.entries(ENUM)) out[k] = opts.includes(x[k]) ? x[k] : DEFAULT_PULL[k];
  return out;
}
/* جسم اللوحة ⇒ { ok, value } | { ok:false, errors } — enabledAt والـpause reason السيرفر بيكتبهم */
export function pullFromBody(b, prev, now = new Date()) {
  const errors = [];
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, errors: ["keeta.pull: كائن"] };
  const cur = pullCfg({ keeta: { pull: prev || {} } });
  const out = { ...cur };
  for (const [k, v] of Object.entries(b)) {
    if (BOOLS.includes(k)) { if (typeof v === "boolean") out[k] = v; else errors.push(`${k}: مفتوح/مقفول`); }
    else if (NUM[k]) { const n = Number(v); if (v === "" || v === null || !Number.isFinite(n) || n < NUM[k][0] || n > NUM[k][1]) errors.push(`${k}: ${NUM[k][0]}–${NUM[k][1]}`); else out[k] = Math.round(n); }
    else if (ENUM[k]) { if (ENUM[k].includes(v)) out[k] = v; else errors.push(`${k}: ${ENUM[k].join(" أو ")}`); }
    else errors.push(`${k}: إعداد مش معروف`);
  }
  if (errors.length) return { ok: false, errors };
  if (out.enabled && !cur.enabled) out.enabledAt = new Date(now).toISOString();      // أول تشغيل (أو بعد قفل): الطلبات اللي بعد اللحظة دي بس
  if (!out.paused) { out.pauseReason = null; out.pausedAt = null; }
  else if (!cur.paused) { out.pauseReason = "owner"; out.pausedAt = new Date(now).toISOString(); }
  return { ok: true, value: out };
}

const S = (type, ar, help, extra = {}) => Object.freeze({ type, ar, help, ...extra });
const N = (k, ar, help, unit) => S("number", ar, help, { min: NUM[k][0], max: NUM[k][1], unit });
export const PULL_SCHEMA = Object.freeze({
  enabled: S("boolean", "تشغيل رسايل ما بعد طلب كيتا", "عميل كيتا الجديد: بعد ما طلبه يتسلّم للمندوب بالمدة اللي تحت بيوصله طلب تقييم على واتساب. لو قيّم ٤–٥ نجوم (أو قيّم واطي والشكوى اتقفلت «اتحلت») بتوصله رسالة واحدة «اطلب مباشرة من موقعنا + توصيل مجاني أول طلب بكود FIRST». رسالتين بالكتير في عمر الرقم. مقفول = ولا رسالة."),
  paused: S("boolean", "متوقّفة (الفرملة)", "بتتقفل لوحدها لو نسبة «إيقاف» عدّت الحد اللي تحت، أو ميتا رجّعت خطأ بيوقف الإرسال. اقفلها هنا عشان ترجع تشتغل."),
  reviewAnchor: S("enum", "طلب التقييم بيتحسب من", "قرار المالك ١٨/١٠: «بعد ٥٠ دقيقة من تسليم الطلب للمندوب». التسليم = نقطة البيع قالت إن الطلب اتسلّم/اتقفل (نفس إشارة «سلّمته للمندوب» لطلبات الموقع).", { options: ENUM.reviewAnchor, optionsAr: { handoff: "تسليم الطلب لمندوب كيتا (المقترح)", order: "وقت الطلب نفسه" } }),
  reviewDelayMin: N("reviewDelayMin", "طلب التقييم بعدها بـ", "قرار المالك ١٨/١٠: ٥٠ دقيقة من التسليم للمندوب. والمطعم لازم يكون مفتوح وقت الإرسال.", "دقيقة"),
  handoffWaitMin: N("handoffWaitMin", "لو التسليم ماظهرش في نقطة البيع خلال", "من وقت الطلب. بعدها الميعاد بيتحسب من وقت الطلب (السطر اللي تحت) — ولو التسليم ظهر بعدها والرسالة لسه ماطلعتش، الميعاد بيرجع يتحسب منه.", "دقيقة"),
  fallbackDelayMin: N("fallbackDelayMin", "…يبقى طلب التقييم بعد الطلب بـ", "الاحتياطي لما وقت التسليم مش معروف (≈ تحضير + ٥٠).", "دقيقة"),
  handoffMinAfterOrderMin: N("handoffMinAfterOrderMin", "إشارة «اتسلّم» قبل الدقايق دي من الطلب = غلط", "الكاشير قفل الطلب بالغلط أول ما نزل — مانحسبهاش تسليم.", "دقيقة"),
  pullDelayMin: N("pullDelayMin", "رسالة «اطلب من موقعنا» بعد التقييم بـ", "بعد التقييم العالي أو قفل الشكوى. وكمان بتستنى الهدوء بعد آخر رسالة للعميل (١٠ دقايق).", "دقيقة"),
  ratingWaitHours: N("ratingWaitHours", "لو ماقيّمش خلال", "مفيش تقييم = مفيش رسالة «اطلب من موقعنا».", "ساعة"),
  lowResolveDays: N("lowResolveDays", "التقييم الواطي لازم يتقفل «اتحلت» خلال", "الشكوى اتقفلت بعد المدة دي أو لسه مفتوحة = مفيش رسالة.", "يوم"),
  lowCloseRule: S("enum", "التقييم الواطي: أنهي قفل يسمح بالرسالة؟", "«اتحلت ✅» بس (المقترح)، أو أي قفل (اتحلت / اتقفلت من غير إجراء). «مش عميل / رقم غلط» عمره ما بيسمح.", { options: ENUM.lowCloseRule, optionsAr: { resolved: "«اتحلت ✅» بس", any_close: "أي قفل" } }),
  maxLateHours: N("maxLateHours", "رسالة «اطلب من موقعنا» تتلغي لو اتأخّرت أكتر من", "مثلاً المطعم مقفول أو السقف خلص — بعد المدة دي مالهاش معنى.", "ساعة"),
  dailyCap: N("dailyCap", "أقصى رسايل «اطلب من موقعنا» في اليوم", "قرار المالك ١٨/١٠: ٢٠ من أول يوم. ونفس العدد لعملاء كيتا الجداد اللي بيدخلوا في اليوم. يوم العمل من ٤ الفجر.", "رسالة"),
  hourCap: N("hourCap", "…وفي الساعة", "", "رسالة"),
  campaignGapDays: N("campaignGapDays", "ماتتبعتش لو وصلته رسالة تسويقية في آخر", "نفس دفتر الحملات. والرسالة دي بتتحسب «رسالة الأسبوع» فالحملات تتخطّاه بعدها. التخطّي نهائي.", "يوم"),
  firstWithinDays: N("firstWithinDays", "«عميل كيتا جديد» = مفيش طلب كيتا قبله في آخر", "صفر = أول طلب كيتا في حياته.", "يوم"),
  skipDirectCustomers: S("boolean", "استبعاد اللي بياكلوا من المحل (صالة/سفري)", "التوصيل المجاني ممكن يحوّل طلب من غير مندوب لطلب بمندوب."),
  holdoutPct: N("holdoutPct", "محجوزين للقياس", "من اللي استحقوا الرسالة: نفس الناس من غير رسالة — عشان نعرف الرسالة عملت فرق ولا لأ.", "٪"),
  template: S("enum", "القالب", "fc_try_website (معتمد من ميتا).", { options: ENUM.template, optionsAr: { fc_try_website: "fc_try_website — جرّب الموقع" } }),
  autoPauseOptoutPct: N("autoPauseOptoutPct", "فرملة: وقف تلقائي لو «إيقاف» وصل", "إيقاف = العميل وقّف رسايلنا (كلمة «إيقاف» أو الزرار أو الحظر/131050) خلال ٤٨ ساعة من رسالة KA2 — محسوبة لرسايل KA2 لوحدها.", "٪"),
  autoPauseMinSends: N("autoPauseMinSends", "…بعد أول", "النسبة بتتحسب على آخر العدد ده من عملاء KA2 اللي وصلتهم رسالة.", "عميل"),
});
export function pullSchemaRows(cfg) {
  const c = pullCfg({ keeta: { pull: cfg || {} } });
  return Object.entries(PULL_SCHEMA).map(([key, s]) => ({ key, ...s, default: DEFAULT_PULL[key], value: c[key] }));
}

/* أسباب الحالة بالعربي (للكارت) — كل سبب الموديول بيكتبه لازم يكون هنا (اختبار) */
export const KA2_REASON_AR = Object.freeze({
  staff: "رقم فريق / تنبيهات", handoff_unknown: "وقت التسليم للمندوب ماظهرش — طلب التقييم من وقت الطلب", invalid: "رقم مش صالح / مش على واتساب", opted_out: "موقّف رسايلنا", web_customer: "عنده طلب موقع مدفوع",
  pending_checkout: "بيدفع على الموقع دلوقتي", direct: "عميل مباشر (صالة/سفري)", test_contact: "رقم تجربة", cap: "السقف اليومي خلص",
  disabled: "اتقفلت من اللوحة", review_missing: "دعوة التقييم مش موجودة", no_rating: "ماقيّمش", low_open: "تقييم واطي والشكوى ماتقفلتش",
  low_closed: "تقييم واطي واتقفل من غير حل", holdout: "محجوز للقياس", gap: "وصلته رسالة تسويقية قريب", late: "فات الميعاد",
  ordered: "طلب من الموقع قبل الرسالة", marketing_cap: "حد رسايل التسويق للعميل", meta_marketing_limit: "سقف ميتا للمستخدم (131049)",
  undeliverable: "مش على واتساب (131026)", user_stopped: "وقّف التسويق من واتساب (131050)", burst_hold: "مستني الهدوء بعد آخر رسالة",
  paused: "الفرملة وقّفت KA2", send_failed: "الإرسال فشل", review: "طلب التقييم ماطلعش",
});
export const reasonAr = (r) => {
  const s = String(r || ""); if (!s) return null;
  if (KA2_REASON_AR[s]) return KA2_REASON_AR[s];
  if (/^review:/.test(s)) return `طلب التقييم ماطلعش (${s.slice(7)})`;
  if (/^meta_\d+/.test(s)) return `خطأ ميتا ${s.slice(5)}`;
  return s;
};

/* ═══ قواعد صافية ═══════════════════════════════════════════════════════════ */
export const linkCodeOf = (rnd = crypto.randomBytes) => { const b = rnd(8); let s = ""; for (let i = 0; s.length < 6 && i < b.length; i++) s += "abcdefghijkmnpqrstuvwxyz23456789"[b[i] % 32]; return s.padEnd(6, "x"); };
export const linkSuffix = (code) => { if (!CODE_RE.test(String(code || ""))) throw new Error("ka2_link_code"); return `${LINK_SLUG}-${code}`; };
const moneyTxt = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : ""; };
/* متغيّرات fc_try_website: {{1}} كود أول طلب، {{2}} الحد الأدنى (من shop_coupons وقت الإرسال)، زرار الرابط /l/keeta-first-<كود> */
export function pullParams(template, coupon, code) {
  if (!TEMPLATES.includes(template)) throw new Error("ka2_template");
  const c = String((coupon && coupon.code) || "").trim(), min = moneyTxt(coupon && coupon.min_total);
  if (!c || !min) throw new Error("ka2_coupon");
  return { body: [c, min], button: [linkSuffix(code)] };
}
/* ميعاد طلب التقييم بمرجع «وقت الطلب»: وقت طلب كيتا + reviewDelayMin (البوابة وقت الإرسال في reviews.js بتأجّل لو المطعم مقفول) */
export const reviewDueOf = (orderAt, cfg) => new Date(Date.parse(orderAt) + (cfg.reviewDelayMin || DEFAULT_PULL.reviewDelayMin) * 60_000);

/* ═══ KA2c — وقت تسليم طلب كيتا للمندوب (عمر ١٨/١٠: «بعد ٥٠ دقيقة من تسليم الطلب للمندوب») ═══
   المصدر: tsp_webhooks — تاب سينس بيبعت order-updated لكل طلبات الفرع ومنها الخارجي اللي فيدأس بينزّله (Keeta/Hungerstation)، بيوصل خلال ~١٠ ث
   (قياس KDS ١٩/٩). الطلب الخارجي اتعرّف بـresource.order.tenant_order_id = «freshcuts-<ts_orders.order_id>» (نفس ربط RT1/RC1).
   «اتسلّم» = أول إشارة من دول: approval فيها picked / delivered / completed / on_the_way / dispatch (نفس اللي شاشة المطبخ بتعتبره «خلص» للخارجي)،
   أو order_status = completed (الكاشير قفل الطلب = «تم التوصيل» على نقطة البيع — نفس handed_at/handed_source='pos' لطلبات الموقع في shop.js).
   «جاهز» (pickup_ready / ready) مش تسليم. إشارة قبل handoffMinAfterOrderMin من الطلب بتتجاهل (قفل بالغلط). */
const tms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const HANDOFF_APPROVAL_RE = /picked|delivered|delivering|complete|on_the_way|out_for|dispatch/;
const DEAD_APPROVAL_RE = /reject|cancel|refund|void/;
export function handoffOf(rows, { orderAt = null, cfg = DEFAULT_PULL } = {}) {
  const floor = orderAt ? tms(orderAt) + (Number(cfg.handoffMinAfterOrderMin) || 0) * 60_000 : -Infinity;
  const list = (Array.isArray(rows) ? rows : []).map((w) => ({
    t: w && w.received_at ? new Date(w.received_at).getTime() : NaN,
    a: String((w && w.approval) || "").toLowerCase(), o: String((w && w.order_status) || "").toLowerCase(),
  })).filter((w) => Number.isFinite(w.t)).sort((x, y) => x.t - y.t);
  for (const w of list) {
    if (w.t < floor) continue;
    if (w.a && !DEAD_APPROVAL_RE.test(w.a) && HANDOFF_APPROVAL_RE.test(w.a)) return { at: new Date(w.t).toISOString(), basis: "pos_approval" };
    if (w.o === "completed") return { at: new Date(w.t).toISOString(), basis: "pos_closed" };
  }
  return null;
}
/* ويبهوكات طلبات كيتا ($1 = أرقام ts_orders.order_id، $2 = من إمتى) — نافذة received_at (فيها فهرس) */
export const HANDOFF_SQL = `
  SELECT (regexp_match(w.payload->'resource'->'order'->>'tenant_order_id', '([0-9]+)[[:space:]]*$'))[1] AS tid,
         w.payload->'resource'->'order'->>'id' AS pid, w.received_at,
         w.payload->'resource'->'statuses_slugs'->>'approval_status' AS approval,
         w.payload->'resource'->'statuses_slugs'->>'order_status' AS order_status
    FROM tsp_webhooks w
   WHERE w.received_at > $2::timestamptz
     AND ((regexp_match(w.payload->'resource'->'order'->>'tenant_order_id', '([0-9]+)[[:space:]]*$'))[1] = ANY($1::text[])
          OR w.payload->'resource'->'order'->>'id' = ANY($1::text[]))
   ORDER BY w.received_at`;
export function groupHandoffRows(rows, ids) {
  const want = new Set((ids || []).map(String)), out = new Map();
  for (const r of rows || []) {
    const k = want.has(String(r.tid || "")) ? String(r.tid) : want.has(String(r.pid || "")) ? String(r.pid) : null;
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}
/* الخطة: ميعاد دعوة التقييم + المرجع.
     order            ⇒ الطلب + reviewDelayMin (نهائي)
     handoff          ⇒ max(التسليم، الطلب) + reviewDelayMin (نهائي)
     handoff_unknown  ⇒ التسليم ماظهرش بعد handoffWaitMin ⇒ الطلب + fallbackDelayMin (بيتراجع لو التسليم ظهر والدعوة لسه ماطلعتش)
     pending          ⇒ مستنيين التسليم: الميعاد «حجز» = الطلب + handoffWaitMin + reviewDelayMin — ده أبعد من أي «تسليم + reviewDelayMin» ممكن
                        جوّه مدة الانتظار ⇒ عمر الدعوة ما تطلع قبل التسليم + المدة حتى لو دورتنا اتأخّرت. */
export function reviewPlanOf({ orderAt, handoff = null, cfg, now = new Date() }) {
  const M = 60_000, o = tms(orderAt), t = tms(now);
  const iso = (x) => new Date(x).toISOString();
  if (cfg.reviewAnchor !== "handoff") return { anchor: "order", final: true, dueAt: iso(o + cfg.reviewDelayMin * M), handoffAt: null, basis: null, reason: null };
  const h = handoff && handoff.at ? tms(handoff.at) : NaN;
  if (Number.isFinite(h)) return { anchor: "handoff", final: true, dueAt: iso(Math.max(h, o) + cfg.reviewDelayMin * M), handoffAt: iso(h), basis: handoff.basis || null, reason: null };
  if (t >= o + cfg.handoffWaitMin * M) return { anchor: "handoff_unknown", final: true, dueAt: iso(o + cfg.fallbackDelayMin * M), handoffAt: null, basis: null, reason: "handoff_unknown" };
  return { anchor: "pending", final: false, dueAt: iso(o + (cfg.handoffWaitMin + cfg.reviewDelayMin) * M), handoffAt: null, basis: null, reason: null };
}
/* التغطية (قراءة بس، للوحة والـverify): طلبات كيتا في آخر N يوم — كام واحد ليه إشارة تسليم ووسيط الدقايق من الطلب */
export const HANDOFF_COVERAGE_SQL = `
  WITH k AS (
    SELECT o.order_id, o.order_date FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
     WHERE s.source = 'delivery_app' AND lower(btrim(COALESCE(s.source_note,''))) = 'keeta'
       AND o.order_date > NOW() - make_interval(days => $1::int)
       AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%')))
  SELECT k.order_id, k.order_date, w.received_at,
         w.payload->'resource'->'statuses_slugs'->>'approval_status' AS approval,
         w.payload->'resource'->'statuses_slugs'->>'order_status' AS order_status
    FROM k LEFT JOIN tsp_webhooks w
      ON w.received_at BETWEEN k.order_date - INTERVAL '15 minutes' AND k.order_date + INTERVAL '6 hours'
     AND (regexp_match(w.payload->'resource'->'order'->>'tenant_order_id', '([0-9]+)[[:space:]]*$'))[1] = k.order_id
   ORDER BY k.order_id, w.received_at`;
export function handoffCoverage(rows, cfg = DEFAULT_PULL) {
  const by = new Map();
  for (const r of rows || []) {
    const id = String(r.order_id);
    if (!by.has(id)) by.set(id, { orderAt: r.order_date, rows: [] });
    if (r.received_at) by.get(id).rows.push(r);
  }
  const mins = [], basis = {};
  let withWebhooks = 0;
  for (const { orderAt, rows: rs } of by.values()) {
    if (rs.length) withWebhooks++;
    const h = handoffOf(rs, { orderAt, cfg });
    if (h) { mins.push((tms(h.at) - tms(orderAt)) / 60_000); basis[h.basis] = (basis[h.basis] || 0) + 1; }
  }
  mins.sort((a, b) => a - b);
  const pct = (p) => (mins.length ? Math.round(mins[Math.min(mins.length - 1, Math.floor(p * mins.length))]) : null);
  const n = by.size;
  return { orders: n, withWebhooks, withHandoff: mins.length, pct: n ? Math.round((mins.length * 1000) / n) / 10 : null,
    minutesFromOrder: { p50: pct(0.5), p80: pct(0.8), max: mins.length ? Math.round(mins[mins.length - 1]) : null }, basis,
    within: n ? mins.filter((m) => m <= cfg.handoffWaitMin).length : 0 };
}
/* التقييم ⇒ القرار: eligible (السحب مسموح) | wait | skip:<سبب>. rv = صف reviews (rating, rating_exact, resolved, outcome, resolved_at, created_at) */
export function verdictOf({ invite, rv, cfg, now = new Date() }) {
  const t = new Date(now).getTime();
  if (!invite) return { act: "skip", reason: "review_missing" };
  if (invite.skip_reason) return { act: "skip", reason: `review:${String(invite.skip_reason).slice(0, 50)}` };
  if (!invite.sent_at) return { act: "wait" };
  if (invite.rating == null && !rv) {
    return t - Date.parse(invite.sent_at) > cfg.ratingWaitHours * 3600_000 ? { act: "skip", reason: "no_rating" } : { act: "wait" };
  }
  const rating = rv ? Number(rv.rating) : Number(invite.rating);
  const exact = rv ? rv.rating_exact !== false : true;
  const ratedAt = (rv && rv.created_at) || invite.wa_answered_at || invite.sent_at;
  if (exact && rating >= 4) return { act: "eligible", at: new Date(ratedAt).toISOString(), high: true };
  if (!rv) return { act: "wait" };      // التقييم الواطي من غير صف (نادر) — نستنى الصف
  if (rv.resolved) {
    const ok = rv.outcome === "resolved" || !rv.outcome || (cfg.lowCloseRule === "any_close" && rv.outcome === "closed");
    if (!ok) return { act: "skip", reason: "low_closed" };
    const at = rv.resolved_at || now;
    if (Date.parse(at) - Date.parse(ratedAt) > cfg.lowResolveDays * 86400_000) return { act: "skip", reason: "low_open" };
    return { act: "eligible", at: new Date(at).toISOString(), high: false };
  }
  return t - Date.parse(ratedAt) > cfg.lowResolveDays * 86400_000 ? { act: "skip", reason: "low_open" } : { act: "wait" };
}
/* فشل الإرسال ⇒ القرار (جدول §٢-د): final بسبب، retry (≤٣)، pause (وقف KA2 كلها)، wait (البوابة: الهدوء / الدفع / القناة) */
const WAIT_SKIPS = new Set(["burst_hold", "pay_hold", "disabled", "unconfigured", "settings_unreadable", "master_off", "settings_off", "marketing_cap_unreadable"]);
export function failureOf(r) {
  if (!r || r.ok) return null;
  if (r.skipped) {
    const s = String(r.skipped);
    if (WAIT_SKIPS.has(s)) return { act: "wait", reason: s, until: r.until || null };
    if (s === "opted_out") return { act: "final", reason: "opted_out" };
    if (/^marketing_cap/.test(s)) return { act: "final", reason: "marketing_cap" };
    if (s === "invalid_phone") return { act: "final", reason: "invalid" };
    return { act: "final", reason: s.slice(0, 40) };
  }
  const cls = classifyError(r.code);
  if (cls.code === 131049) return { act: "final", reason: "meta_marketing_limit", cls };
  if (cls.code === 131026 || cls.invalid) return { act: "final", reason: "undeliverable", invalid: true, cls };
  if (cls.code === 131050 || cls.optout) return { act: "final", reason: "user_stopped", optout: true, cls };
  if (cls.stop) return { act: "pause", reason: cls.code ? `meta_${cls.code}` : "send_failed", cls };
  if (cls.retry || cls.transient) return { act: "retry", reason: cls.reason, cls };
  return { act: "final", reason: cls.code ? `meta_${cls.code}` : "send_failed", cls };
}
/* الفرملة: على آخر N عميل وصلته رسالة KA2 ⇒ نسبة اللي وقّف خلال ٤٨ ساعة */
export function brakeOf(rows, cfg) {
  const last = (rows || []).slice(0, cfg.autoPauseMinSends);
  const n = last.length, bad = last.filter((r) => r.opted_out === true).length;
  const pct = n ? Math.round((bad * 1000) / n) / 10 : 0;
  return { n, bad, pct, trip: cfg.autoPauseOptoutPct > 0 && n >= cfg.autoPauseMinSends && (bad * 100) / n >= cfg.autoPauseOptoutPct };
}

/* ═══ SQL ════════════════════════════════════════════════════════════════════ */
export const KA2_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ka2_sends (
     id BIGSERIAL PRIMARY KEY,
     phone_norm TEXT NOT NULL UNIQUE,              -- مرة واحدة في العمر: أي حالة بتحجز الرقم
     keeta_order_id TEXT NOT NULL UNIQUE,          -- ts_orders.order_id
     order_at TIMESTAMPTZ NOT NULL,
     status TEXT NOT NULL,                         -- review_wait | queued | sent | failed | skipped | holdout
     reason TEXT,
     review_order_no TEXT, review_due_at TIMESTAMPTZ,
     rating INT, rating_exact BOOLEAN, review_id BIGINT, rated_at TIMESTAMPTZ, high BOOLEAN,
     eligible_at TIMESTAMPTZ, due_at TIMESTAMPTZ,
     holdout BOOLEAN NOT NULL DEFAULT FALSE,
     template TEXT, coupon TEXT, link_code TEXT UNIQUE,
     wamid TEXT, attempts INT NOT NULL DEFAULT 0,
     sent_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, clicks INT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  "CREATE INDEX IF NOT EXISTS ka2_sends_status_idx ON ka2_sends(status, due_at)",
  "CREATE INDEX IF NOT EXISTS ka2_sends_sent_idx ON ka2_sends(sent_at DESC)",
  "CREATE INDEX IF NOT EXISTS ka2_sends_created_idx ON ka2_sends(created_at DESC)",
  `CREATE TABLE IF NOT EXISTS ka2_tests (
     id BIGSERIAL PRIMARY KEY, phone_norm TEXT NOT NULL, link_code TEXT UNIQUE, ok BOOLEAN, result TEXT, by_name TEXT,
     clicks INT NOT NULL DEFAULT 0, clicked_at TIMESTAMPTZ, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  "ALTER TABLE review_invites ADD COLUMN IF NOT EXISTS ka2 BOOLEAN NOT NULL DEFAULT FALSE",
  /* KA2c: مرجع ميعاد طلب التقييم — order | handoff | handoff_unknown | pending (NULL = صف قبل KA2c، ميعاده نهائي من وقت الطلب) */
  "ALTER TABLE ka2_sends ADD COLUMN IF NOT EXISTS review_anchor TEXT",
  "ALTER TABLE ka2_sends ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ",
  "ALTER TABLE ka2_sends ADD COLUMN IF NOT EXISTS handoff_basis TEXT",
]);
/* KA2c مرة واحدة: الحل المؤقت كان reviewDelayMin = 80 من وقت الطلب (≈ تحضير + ٥٠). أول إقلاع بالمرجع الجديد: لو لسه 80 ومفيش reviewAnchor
   متسجّل ⇒ 50 من التسليم. أي قيمة تانية (أو reviewAnchor متسجّل) ⇒ مانلمسش حاجة. */
export const ANCHOR_MIGRATION_SQL = `
  UPDATE settings SET data = jsonb_set(jsonb_set(data, '{keeta,pull,reviewDelayMin}', '50'::jsonb, true), '{keeta,pull,reviewAnchor}', '"handoff"'::jsonb, true)
   WHERE id = 1 AND jsonb_typeof(data->'keeta'->'pull') = 'object'
     AND data #>> '{keeta,pull,reviewDelayMin}' = '80' AND NOT ((data->'keeta'->'pull') ? 'reviewAnchor')
  RETURNING id`;
const KEETA_ROW_SQL = "s.source = 'delivery_app' AND lower(btrim(COALESCE(s.source_note,''))) = 'keeta'";
const LIVE_ORDER_SQL = (a) => `(${a}.order_type IS NULL OR (${a}.order_type NOT ILIKE '%void%' AND ${a}.order_type NOT ILIKE '%refund%'))`;
/* المرشّحين: طلب كيتا بجوال، بعد enabledAt (حماية أول تشغيل) وجوّه maxLateHours، الرقم ماحجزش KA2 قبل كده، أول طلب كيتا ليه، ومفيش طلب موقع مدفوع. */
export const CANDIDATES_SQL = `
  WITH cand AS (
    SELECT s.order_id, s.phone_norm AS pn, o.order_date
      FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
     WHERE ${KEETA_ROW_SQL} AND s.phone_norm ~ '^5[0-9]{8}$'
       AND o.order_date > GREATEST($1::timestamptz, NOW() - make_interval(hours => $2::int))
       AND ${LIVE_ORDER_SQL("o")})
  SELECT c.order_id, c.pn, c.order_date,
         EXISTS (SELECT 1 FROM shop_orders so WHERE so.phone_norm = c.pn AND ${shopPaidSql("so")}) AS web_paid,
         EXISTS (SELECT 1 FROM shop_orders so WHERE so.phone_norm = c.pn AND so.status = 'pending_payment' AND so.created_at > NOW() - INTERVAL '2 hours') AS pending_checkout,
         cc.opted_out_at IS NOT NULL AS opted_out, COALESCE(cc.is_staff, false) AS is_staff, COALESCE(cc.is_test, false) AS is_test,
         COALESCE(cc.orders, 0) > COALESCE(cc.app_orders, 0) AS direct,
         EXISTS (SELECT 1 FROM wa_invalid_numbers w WHERE w.phone_norm = c.pn) AS invalid
    FROM cand c LEFT JOIN cms_contacts cc ON cc.phone_norm = c.pn
   WHERE NOT EXISTS (SELECT 1 FROM ka2_sends k WHERE k.phone_norm = c.pn OR k.keeta_order_id = c.order_id)
     AND NOT EXISTS (SELECT 1 FROM order_sources s2 JOIN ts_orders o2 ON o2.order_id = s2.order_id
                      WHERE s2.phone_norm = c.pn AND s2.source = 'delivery_app' AND lower(btrim(COALESCE(s2.source_note,''))) = 'keeta'
                        AND s2.order_id <> c.order_id AND o2.order_date < c.order_date
                        AND ($3::int = 0 OR o2.order_date > c.order_date - make_interval(days => $3::int)))
   ORDER BY c.order_date LIMIT 50`;
/* تصنيف المرشّح (صافي): سبب تخطّي نهائي أو null */
export function candidateSkip(c, { cfg, staff }) {
  const pn = String(c.pn || "");
  if (staff.has(pn) || c.is_staff) return "staff";
  if (c.is_test) return "test_contact";
  if (isPlaceholderPhone(pn) || c.invalid) return "invalid";
  if (c.opted_out) return "opted_out";
  if (c.web_paid) return "web_customer";
  if (c.pending_checkout) return "pending_checkout";
  if (cfg.skipDirectCustomers && c.direct) return "direct";
  return null;
}

/* نتايج الكارت (q = استعلام بيرجّع الصفوف أو null) — نافذة days (null = من البداية) */
export async function ka2Results(q, { days = null } = {}) {
  const win = days ? "k.created_at > NOW() - make_interval(days => $1::int)" : "TRUE";
  const P = days ? [days] : [];
  const rows = await q(`
    SELECT count(*)::int AS candidates,
           count(*) FILTER (WHERE k.review_order_no IS NOT NULL)::int AS enrolled,
           count(*) FILTER (WHERE iv.sent_at IS NOT NULL)::int AS review_sent,
           count(*) FILTER (WHERE k.rating IS NOT NULL OR iv.rating IS NOT NULL)::int AS rated,
           count(*) FILTER (WHERE k.high)::int AS high,
           count(*) FILTER (WHERE k.high IS FALSE)::int AS low_resolved,
           count(*) FILTER (WHERE k.eligible_at IS NOT NULL)::int AS eligible,
           count(*) FILTER (WHERE k.holdout)::int AS holdout,
           count(*) FILTER (WHERE k.status = 'queued')::int AS queued,
           count(*) FILTER (WHERE k.sent_at IS NOT NULL)::int AS sent,
           count(*) FILTER (WHERE m.status IN ('delivered','read'))::int AS delivered,
           count(*) FILTER (WHERE m.status = 'read')::int AS read,
           count(*) FILTER (WHERE k.clicked_at IS NOT NULL)::int AS clicked,
           count(*) FILTER (WHERE k.sent_at IS NOT NULL AND cv.order_no IS NOT NULL)::int AS converted,
           COALESCE(sum(cv.total) FILTER (WHERE k.sent_at IS NOT NULL), 0)::float AS revenue,
           count(*) FILTER (WHERE k.sent_at IS NOT NULL AND upper(COALESCE(cv.coupon,'')) = '${COUPON_CODE}')::int AS with_first,
           count(*) FILTER (WHERE k.holdout AND cv.order_no IS NOT NULL)::int AS holdout_converted,
           count(*) FILTER (WHERE COALESCE(k.sent_at, iv.sent_at) IS NOT NULL)::int AS messaged,
           count(*) FILTER (WHERE oo.opted)::int AS optouts,
           count(*) FILTER (WHERE k.sent_at IS NOT NULL AND oo.after_pull)::int AS pull_optouts,
           count(*) FILTER (WHERE iv.sent_at IS NOT NULL AND oo.after_review)::int AS review_optouts
      FROM ka2_sends k
      LEFT JOIN review_invites iv ON iv.order_no = k.review_order_no
      LEFT JOIN wa_messages m ON m.wamid = k.wamid AND k.wamid IS NOT NULL
      LEFT JOIN LATERAL (SELECT so.order_no, so.total, so.coupon FROM shop_orders so
                          WHERE so.phone_norm = k.phone_norm AND ${shopPaidSql("so")}
                            AND so.created_at > COALESCE(k.sent_at, k.eligible_at) AND so.created_at < COALESCE(k.sent_at, k.eligible_at) + INTERVAL '14 days'
                            AND (k.sent_at IS NOT NULL OR k.holdout)
                          ORDER BY so.created_at LIMIT 1) cv ON TRUE
      LEFT JOIN LATERAL (SELECT
             bool_or(t.at BETWEEN COALESCE(iv.sent_at, k.sent_at) AND COALESCE(k.sent_at, iv.sent_at) + INTERVAL '48 hours') AS opted,
             bool_or(k.sent_at IS NOT NULL AND t.at BETWEEN k.sent_at AND k.sent_at + INTERVAL '48 hours') AS after_pull,
             bool_or(iv.sent_at IS NOT NULL AND t.at BETWEEN iv.sent_at AND iv.sent_at + INTERVAL '48 hours') AS after_review
             FROM (SELECT cc.opted_out_at AS at FROM cms_contacts cc WHERE cc.phone_norm = k.phone_norm AND cc.opted_out_at IS NOT NULL
                   UNION ALL SELECT wo.stopped_at FROM wa_optins wo WHERE wo.phone_norm = k.phone_norm AND wo.stopped_at IS NOT NULL
                   UNION ALL SELECT wo.marketing_off_at FROM wa_optins wo WHERE wo.phone_norm = k.phone_norm AND wo.marketing_off_at IS NOT NULL
                   UNION ALL SELECT k.updated_at WHERE k.reason = 'user_stopped') t) oo ON TRUE
     WHERE ${win}`, P);
  if (rows === null) return null;
  const r = rows[0] || {};
  const n = (k) => Number(r[k]) || 0;
  const rate = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : null);
  const sent = n("sent"), hold = n("holdout");
  const convPct = rate(n("converted"), sent), holdPct = rate(n("holdout_converted"), hold);
  return {
    candidates: n("candidates"), enrolled: n("enrolled"), reviewSent: n("review_sent"), rated: n("rated"), high: n("high"), lowResolved: n("low_resolved"),
    eligible: n("eligible"), holdout: hold, queued: n("queued"), sent, delivered: n("delivered"), read: n("read"), clicked: n("clicked"),
    converted: n("converted"), revenue: Math.round(Number(r.revenue || 0) * 100) / 100, withFirst: n("with_first"), holdoutConverted: n("holdout_converted"),
    convPct, holdoutConvPct: holdPct, liftPts: convPct != null && holdPct != null ? Math.round((convPct - holdPct) * 10) / 10 : null, early: sent < 50,
    costSar: Math.round(sent * MARKETING_SAR * 100) / 100,
    optout: { messaged: n("messaged"), optouts: n("optouts"), pct: rate(n("optouts"), n("messaged")),
      pull: { sent, optouts: n("pull_optouts"), pct: rate(n("pull_optouts"), sent) }, review: { sent: n("review_sent"), optouts: n("review_optouts"), pct: rate(n("review_optouts"), n("review_sent")) } },
  };
}
/* سطر صغير لإحصائيات التقييمات (reviews.js /api/cms/reviews/stats): طلبات التقييم بعد كيتا + نسبة الإيقاف لرسايل KA2 */
export async function ka2ReviewSummary(q, { days = 30 } = {}) {
  const has = await q("SELECT to_regclass('ka2_sends') IS NOT NULL AS ok", []);
  if (!has || !has[0] || !has[0].ok) return null;
  const r = await ka2Results(q, { days });
  return r ? { days, reviewSent: r.reviewSent, rated: r.rated, high: r.high, pullSent: r.sent, optout: r.optout } : null;
}

/* ═══ الموديول ═══════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, isOwner, auditNote } = ctx;
  const wa = () => (typeof deps.wa === "function" ? deps.wa() : deps.wa || null);
  const sender = () => (typeof deps.sender === "function" ? deps.sender() : deps.sender || null);
  const clock = () => (typeof deps.now === "function" ? deps.now() : new Date());
  const q = async (sql, p = []) => { try { return (await pool.query(sql, p)).rows; } catch (e) { console.error("[ka2] q:", e.message); return null; } };
  const ready = (async () => {
    for (const ddl of KA2_DDL) await pool.query(ddl);
    const m = await pool.query(ANCHOR_MIGRATION_SQL).catch((e) => { console.error("[ka2] anchor migration:", e.message); return null; });
    if (m && m.rows && m.rows.length) console.log("[ka2] KA2c: reviewDelayMin 80 (من الطلب) ⇒ 50 من التسليم للمندوب (reviewAnchor = handoff)");
    return true;
  })()
    .catch((e) => { console.error("[ka2] schema:", e.message); return false; });

  async function savePull(next) {
    await pool.query(`UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'keeta' THEN data ELSE jsonb_set(data, '{keeta}', '{}'::jsonb, true) END,
         '{keeta,pull}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(next)]);
  }
  async function pause(reason, cur) {
    const next = { ...pullCfg({ keeta: { pull: cur } }), paused: true, pauseReason: String(reason).slice(0, 120), pausedAt: clock().toISOString() };
    await savePull(next);
    console.warn(`[ka2] paused: ${reason}`);
    return next;
  }
  const staffOf = (s) => { const set = new Set(reviewSkipPhones(s)); for (const p of staffPhoneSet(s)) set.add(p); return set; };
  const sentToday = async (now) => {
    const r = await q("SELECT count(*) FILTER (WHERE sent_at >= $1::timestamptz)::int AS today, count(*) FILTER (WHERE sent_at > $2::timestamptz)::int AS hour FROM ka2_sends WHERE sent_at > $3::timestamptz",
      [bizDayStart(now).toISOString(), new Date(now.getTime() - 3600_000).toISOString(), new Date(now.getTime() - 26 * 3600_000).toISOString()]);
    return r && r[0] ? { today: Number(r[0].today) || 0, hour: Number(r[0].hour) || 0 } : null;
  };
  const enrolledToday = async (now) => {
    const r = await q("SELECT count(*)::int AS n FROM ka2_sends WHERE created_at >= $1::timestamptz AND review_order_no IS NOT NULL", [bizDayStart(now).toISOString()]);
    return r && r[0] ? Number(r[0].n) || 0 : null;
  };
  async function couponRow() {
    const r = await q("SELECT code, min_total, active FROM shop_coupons WHERE upper(code)=upper($1) LIMIT 1", [COUPON_CODE]);
    return r && r[0] ? r[0] : null;
  }
  async function linkRow() {
    const r = await q("SELECT slug, active, coupon FROM cms_links WHERE slug=$1 LIMIT 1", [LINK_SLUG]);
    return r && r[0] ? r[0] : null;
  }
  async function optOut(pn, reason) {
    const sx = sender();
    if (sx && typeof sx.optOut === "function") return sx.optOut(pn, "whatsapp_meta", reason, "ميتا").catch(() => false);
    return false;
  }

  /* KA2c: إشارات التسليم لطلبات كيتا (Map رقم الطلب ⇒ {at, basis}). القاعدة وقعت ⇒ Map فاضية (الطلب يفضل pending لحد handoffWaitMin) */
  async function handoffsFor(list, cfg) {
    const out = new Map();
    if (cfg.reviewAnchor !== "handoff" || !list.length) return out;
    const ids = [...new Set(list.map((x) => String(x.order_id)))];
    const since = new Date(Math.min(...list.map((x) => tms(x.order_at))) - 15 * 60_000).toISOString();
    const rows = await q(HANDOFF_SQL, [ids, since]);
    const byId = groupHandoffRows(rows || [], ids);
    for (const x of list) { const h = handoffOf(byId.get(String(x.order_id)) || [], { orderAt: x.order_at, cfg }); if (h) out.set(String(x.order_id), h); }
    return out;
  }

  /* ── ١) دخول عملاء كيتا الجداد (كل دورة؛ dry = خطة من غير كتابة) ── */
  async function enroll(s, cfg, now, { dry = false } = {}) {
    const plan = { enroll: [], skip: [] };
    if (!cfg.enabled || !cfg.enabledAt) return plan;
    const rows = await q(CANDIDATES_SQL, [cfg.enabledAt, cfg.maxLateHours, cfg.firstWithinDays]);
    if (!rows || !rows.length) return plan;
    const staff = staffOf(s);
    const hand = await handoffsFor(rows.map((c) => ({ order_id: c.order_id, order_at: c.order_date })), cfg);
    let used = dry ? 0 : await enrolledToday(now);
    if (used === null) return plan;
    for (const c of rows) {
      let why = candidateSkip(c, { cfg, staff });
      if (!why && used >= cfg.dailyCap) why = "cap";
      const rp = reviewPlanOf({ orderAt: c.order_date, handoff: hand.get(String(c.order_id)) || null, cfg, now });
      const due = new Date(rp.dueAt);
      if (why) { plan.skip.push({ pn: c.pn, order: c.order_id, reason: why }); }
      else { plan.enroll.push({ pn: c.pn, order: c.order_id, reviewDue: due.toISOString(), anchor: rp.anchor, handoffAt: rp.handoffAt }); used++; }
      if (dry) continue;
      if (why) {
        await q(`INSERT INTO ka2_sends(phone_norm, keeta_order_id, order_at, status, reason) VALUES ($1,$2,$3,'skipped',$4) ON CONFLICT DO NOTHING`, [c.pn, String(c.order_id), c.order_date, why]);
        continue;
      }
      const ord = `pos:${c.order_id}`;
      const ins = await q(`INSERT INTO ka2_sends(phone_norm, keeta_order_id, order_at, status, review_order_no, review_due_at, review_anchor, handoff_at, handoff_basis)
                           VALUES ($1,$2,$3,'review_wait',$4,$5,$6,$7,$8)
                           ON CONFLICT DO NOTHING RETURNING id`, [c.pn, String(c.order_id), c.order_date, ord, due.toISOString(), rp.anchor, rp.handoffAt, rp.basis]);
      if (!ins || !ins.length) { used--; continue; }
      if (rp.reason) console.log(`[ka2] ${rp.reason}: طلب ${c.order_id} — طلب التقييم من وقت الطلب + ${cfg.fallbackDelayMin} د`);
      /* دعوة التقييم: نفس صف reviews.js (pos:<رقم الطلب>) — لو اتعملت قبلنا (appsMin) بنعلّمها ka2 وميعادها بقى ميعاد KA2 طول ما مااتبعتتش
         ومااتقفلتش (KA2c: الميعاد ممكن يتأخّر لحد التسليم + المدة — LEAST القديمة كانت ممكن تطلّعها قبل التسليم) */
      const code = crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "").toLowerCase().slice(0, 8).padEnd(8, "x");
      await q(`INSERT INTO review_invites(order_no, code, phone_norm, option, due_at, kind, order_at, ref, ka2) VALUES ($1,$2,$3,'app',$4,'app',$5,NULL,TRUE)
               ON CONFLICT (order_no) DO UPDATE SET ka2 = TRUE, due_at = EXCLUDED.due_at
                WHERE review_invites.sent_at IS NULL AND review_invites.skip_reason IS NULL`, [ord, code, c.pn, due.toISOString(), c.order_date]);
      await recordKa2ReviewConsent(pool, { phoneNorm: c.pn, orderNo: ord, at: c.order_date }).catch((e) => console.error("[ka2] consent:", e.message));
    }
    return plan;
  }

  /* ── ١ب) KA2c: ميعاد طلب التقييم بيتحدّث أول ما التسليم للمندوب يظهر (أو الاحتياطي بعد handoffWaitMin) — طول ما الدعوة ماطلعتش.
         صفوف قبل KA2c (review_anchor NULL) ميعادها نهائي من وقت الطلب ومش بتتلمس. */
  async function anchorStep(cfg, now) {
    const rows = await q(`SELECT k.id, k.keeta_order_id, k.order_at, k.review_order_no, k.review_anchor, k.review_due_at, k.handoff_at
                            FROM ka2_sends k JOIN review_invites iv ON iv.order_no = k.review_order_no
                           WHERE k.status = 'review_wait' AND k.review_anchor IN ('pending','handoff_unknown')
                             AND iv.sent_at IS NULL AND iv.skip_reason IS NULL
                           ORDER BY k.id LIMIT 200`, []);
    if (!rows || !rows.length) return 0;
    const hand = await handoffsFor(rows.map((x) => ({ order_id: x.keeta_order_id, order_at: x.order_at })), cfg);
    let n = 0;
    for (const x of rows) {
      const rp = reviewPlanOf({ orderAt: x.order_at, handoff: hand.get(String(x.keeta_order_id)) || null, cfg, now });
      const same = rp.anchor === x.review_anchor && x.review_due_at && tms(x.review_due_at) === tms(rp.dueAt);
      if (same) continue;
      const u = await q(`UPDATE ka2_sends SET review_anchor=$2, review_due_at=$3, handoff_at=$4, handoff_basis=$5, updated_at=NOW()
                          WHERE id=$1 AND status='review_wait' RETURNING id`, [x.id, rp.anchor, rp.dueAt, rp.handoffAt, rp.basis]);
      if (!u || !u.length) continue;
      await q("UPDATE review_invites SET due_at=$2 WHERE order_no=$1 AND ka2 AND sent_at IS NULL AND skip_reason IS NULL", [x.review_order_no, rp.dueAt]);
      if (rp.reason && x.review_anchor !== rp.anchor) console.log(`[ka2] ${rp.reason}: طلب ${x.keeta_order_id} — التسليم ماظهرش خلال ${cfg.handoffWaitMin} د ⇒ طلب التقييم من وقت الطلب + ${cfg.fallbackDelayMin} د`);
      n++;
    }
    return n;
  }

  /* ── ٢) التقييم ⇒ القرار (review_wait ⇒ queued / holdout / skipped) ── */
  async function advance(cfg, now) {
    const rows = await q(`SELECT k.id, k.phone_norm, k.review_order_no, iv.order_no AS iv_no,
                                 iv.sent_at, iv.skip_reason, iv.rating AS iv_rating, iv.wa_answered_at, iv.review_id,
                                 r.rating, r.rating_exact, r.resolved, r.outcome, r.resolved_at, r.created_at AS rated_at
                            FROM ka2_sends k
                            LEFT JOIN review_invites iv ON iv.order_no = k.review_order_no
                            LEFT JOIN reviews r ON r.id = iv.review_id
                           WHERE k.status = 'review_wait' ORDER BY k.id LIMIT 200`, []);
    let n = 0;
    for (const x of rows || []) {
      const invite = x.iv_no ? { sent_at: x.sent_at, skip_reason: x.skip_reason, rating: x.iv_rating, wa_answered_at: x.wa_answered_at } : null;
      const rv = x.rating != null ? { rating: x.rating, rating_exact: x.rating_exact, resolved: x.resolved, outcome: x.outcome, resolved_at: x.resolved_at, created_at: x.rated_at } : null;
      const v = verdictOf({ invite, rv, cfg, now });
      const rating = rv ? Number(rv.rating) : x.iv_rating != null ? Number(x.iv_rating) : null;
      if (v.act === "wait") continue;
      if (v.act === "skip") {
        await q("UPDATE ka2_sends SET status='skipped', reason=$2, rating=$3, rating_exact=$4, review_id=$5, rated_at=$6, updated_at=NOW() WHERE id=$1 AND status='review_wait'",
          [x.id, v.reason, rating, rv ? rv.rating_exact !== false : null, x.review_id || null, rv ? rv.created_at : null]);
        n++; continue;
      }
      const hold = inHoldout(KA2_SOURCE, x.phone_norm, cfg.holdoutPct);
      const due = new Date(Math.max(Date.parse(v.at) + cfg.pullDelayMin * 60_000, now.getTime()));
      await q(`UPDATE ka2_sends SET status=$2, reason=$3, holdout=$4, rating=$5, rating_exact=$6, review_id=$7, rated_at=$8, high=$9, eligible_at=$10, due_at=$11, updated_at=NOW()
                WHERE id=$1 AND status='review_wait'`,
        [x.id, hold ? "holdout" : "queued", hold ? "holdout" : null, hold, rating, rv ? rv.rating_exact !== false : true, x.review_id || null, rv ? rv.created_at : null, v.high, v.at, due.toISOString()]);
      n++;
    }
    return n;
  }

  /* ── ٣) إرسال «اطلب مباشرة من موقعنا» ── */
  async function sendDue(s, cfg, now) {
    const out = { sent: 0, skipped: 0, waited: null };
    const late = await q(`UPDATE ka2_sends SET status='skipped', reason='late', updated_at=NOW()
                           WHERE status='queued' AND eligible_at < $1::timestamptz - make_interval(hours => $2::int) RETURNING id`, [now.toISOString(), cfg.maxLateHours]);
    out.skipped += (late || []).length;
    if (cfg.paused) { out.waited = "paused"; return out; }
    /* البوابة: المطعم مفتوح (sendhours.js). الإعداد العام مقفول ⇒ المطعم مفتوح من غير هامش (لو المواعيد متعرّفة) */
    const gate = isRestaurantOpenAt(now, s);
    if (gate === false || (gate === null && hoursKnown(s.hours) && !isOpenNow(s.hours, now))) { out.waited = "closed"; return out; }
    if (!cloudCfg(s).enabled) { out.waited = "wa_off"; return out; }
    const due = await q("SELECT id, phone_norm, eligible_at, attempts, link_code FROM ka2_sends WHERE status='queued' AND due_at <= $1::timestamptz ORDER BY due_at LIMIT 20", [now.toISOString()]);
    if (!due || !due.length) return out;
    const caps = await sentToday(now);
    if (!caps) { out.waited = "cap_check_failed"; return out; }
    const coupon = await couponRow(), link = await linkRow();
    if (!coupon || coupon.active === false) { out.waited = "coupon_inactive"; return out; }
    if (!link || link.active === false) { out.waited = "link_inactive"; return out; }
    const w = wa();
    if (!w || typeof w.sendTemplate !== "function") { out.waited = "wa_not_wired"; return out; }
    const sx = sender();
    for (const row of due) {
      if (caps.today >= cfg.dailyCap) { out.waited = "daily_cap"; break; }
      if (caps.hour >= cfg.hourCap) { out.waited = "hour_cap"; break; }
      const pn = String(row.phone_norm);
      const fin = async (status, reason, extra = "") => { await q(`UPDATE ka2_sends SET status=$2, reason=$3, updated_at=NOW()${extra} WHERE id=$1`, [row.id, status, reason]); out.skipped++; };
      /* فحوص رخيصة تاني (وقّف من ساعتها؟ طلب من الموقع من ساعتها؟ مش على واتساب؟) ⇒ تخطّي نهائي */
      const chk = await q(`SELECT (SELECT opted_out_at FROM cms_contacts WHERE phone_norm=$1) AS oo,
                                  (SELECT stopped_at FROM wa_optins WHERE phone_norm=$1) AS st, (SELECT marketing_off_at FROM wa_optins WHERE phone_norm=$1) AS mo,
                                  EXISTS (SELECT 1 FROM shop_orders so WHERE so.phone_norm=$1 AND ${shopPaidSql("so")}) AS paid,
                                  EXISTS (SELECT 1 FROM wa_invalid_numbers w WHERE w.phone_norm=$1) AS invalid`, [pn]);
      if (!chk || !chk[0]) { out.waited = "check_failed"; break; }
      const c0 = chk[0];
      if (c0.oo || c0.st || c0.mo) { await fin("skipped", "opted_out"); continue; }
      if (c0.paid) { await fin("skipped", "ordered"); continue; }
      if (c0.invalid) { await fin("skipped", "invalid"); continue; }
      /* «رسالة الأسبوع»: وصله تسويق في آخر campaignGapDays من أي قناة (نفس دفتر الحملات) ⇒ تخطّي نهائي (التوقيت راح) */
      if (sx && typeof sx.recentMap === "function") {
        let rec = null; try { rec = await sx.recentMap([pn], cfg.campaignGapDays); } catch { rec = null; }
        if (rec === null) { out.waited = "gap_check_failed"; break; }
        if (rec.size) { await fin("skipped", "gap"); continue; }
      }
      const code = CODE_RE.test(String(row.link_code || "")) ? row.link_code : linkCodeOf();
      let params; try { params = pullParams(cfg.template, coupon, code); } catch (e) { out.waited = String(e.message); break; }
      if (code !== row.link_code) await q("UPDATE ka2_sends SET link_code=$2, template=$3, coupon=$4 WHERE id=$1", [row.id, code, cfg.template, String(coupon.code)]);
      let r = null;
      try { r = await w.sendTemplate({ phoneNorm: pn, template: cfg.template, params, source: KA2_SOURCE, proactive: true }); } catch (e) { r = { ok: false, error: "send_failed", message: String(e.message || e) }; }
      if (r && r.ok) {
        await q("UPDATE ka2_sends SET status='sent', reason=NULL, wamid=$2, sent_at=NOW(), attempts=attempts+1, updated_at=NOW() WHERE id=$1", [row.id, r.wamid || null]);
        await q("INSERT INTO wa_contact_log(phone_norm, channel, by) VALUES ($1,'auto','ka2')", [pn]);      // «رسالة الأسبوع» ⇒ الحملات (recentMap) تتخطّاه
        out.sent++; caps.today++; caps.hour++;
        continue;
      }
      const f = failureOf(r) || { act: "final", reason: "send_failed" };
      if (f.act === "wait") { out.waited = f.reason; if (f.reason === "burst_hold") continue; break; }
      if (f.act === "retry") {
        if ((Number(row.attempts) || 0) + 1 >= 3) { await fin("failed", f.reason, ", attempts=attempts+1"); }
        else await q("UPDATE ka2_sends SET attempts=attempts+1, due_at=$2, reason=$3, updated_at=NOW() WHERE id=$1", [row.id, new Date(now.getTime() + 10 * 60_000).toISOString(), f.reason]);
        continue;
      }
      if (f.act === "pause") { await fin("failed", f.reason, ", attempts=attempts+1"); await pause(f.reason, s.keeta && s.keeta.pull); out.waited = "paused"; break; }
      await fin("failed", f.reason, ", attempts=attempts+1");
      if (f.invalid) await q(`INSERT INTO wa_invalid_numbers(phone_norm) VALUES ($1) ON CONFLICT (phone_norm) DO UPDATE SET hits = wa_invalid_numbers.hits + 1, at = NOW()`, [pn]);
      if (f.optout) await optOut(pn, "وقّف رسايل التسويق من واتساب نفسه (131050) — رسالة KA2");
    }
    return out;
  }

  /* ── ٠) الفشل اللي بيوصل بعدين من الويب هوك (wa_messages.status = failed «131049:…») ── */
  async function reconcile() {
    const rows = await q(`SELECT k.id, k.phone_norm, m.error FROM ka2_sends k JOIN wa_messages m ON m.wamid = k.wamid
                           WHERE k.status='sent' AND m.status='failed' AND k.sent_at > NOW() - INTERVAL '3 days'`, []);
    for (const x of rows || []) {
      const code = Number(String(x.error || "").split(":")[0]) || null;
      const f = failureOf({ ok: false, code }) || { reason: "send_failed" };
      await q("UPDATE ka2_sends SET status='failed', reason=$2, updated_at=NOW() WHERE id=$1 AND status='sent'", [x.id, f.reason]);
      await q("DELETE FROM wa_contact_log WHERE phone_norm=$1 AND by='ka2'", [x.phone_norm]);      // ماوصلتش ⇒ مش «رسالة الأسبوع» (زي cloudFailed)
      if (f.invalid) await q(`INSERT INTO wa_invalid_numbers(phone_norm) VALUES ($1) ON CONFLICT (phone_norm) DO UPDATE SET hits = wa_invalid_numbers.hits + 1, at = NOW()`, [x.phone_norm]);
    }
    return (rows || []).length;
  }

  async function brakeRows(cfg) {
    return (await q(`SELECT k.id,
                            EXISTS (SELECT 1 FROM (SELECT cc.opted_out_at AS at FROM cms_contacts cc WHERE cc.phone_norm = k.phone_norm
                                                   UNION ALL SELECT wo.stopped_at FROM wa_optins wo WHERE wo.phone_norm = k.phone_norm
                                                   UNION ALL SELECT wo.marketing_off_at FROM wa_optins wo WHERE wo.phone_norm = k.phone_norm) t
                                     WHERE t.at BETWEEN COALESCE(iv.sent_at, k.sent_at) AND COALESCE(k.sent_at, iv.sent_at) + INTERVAL '48 hours')
                              OR k.reason = 'user_stopped' AS opted_out
                       FROM ka2_sends k LEFT JOIN review_invites iv ON iv.order_no = k.review_order_no
                      WHERE COALESCE(k.sent_at, iv.sent_at) IS NOT NULL
                      ORDER BY COALESCE(k.sent_at, iv.sent_at) DESC LIMIT $1`, [cfg.autoPauseMinSends])) || null;
  }

  let busy = false;
  async function tick({ now = clock() } = {}) {
    if (busy) return { skipped: "busy" };
    busy = true;
    try {
      if (!(await ready)) return { skipped: "schema" };
      const s = (await getSettingsData()) || {};
      const cfg = pullCfg(s);
      if (!cfg.enabled) {
        /* اتقفلت من اللوحة ⇒ اللي في الطابور بيتلغي (طلب التقييم نفسه بيكمّل زي أي طلب تقييم عادي) */
        const d = await q("UPDATE ka2_sends SET status='skipped', reason='disabled', updated_at=NOW() WHERE status IN ('review_wait','queued') RETURNING id", []);
        if (d && d.length) await q("UPDATE review_invites SET ka2=FALSE WHERE ka2 AND sent_at IS NULL AND skip_reason IS NULL", []);
        return { skipped: "disabled", cancelled: (d || []).length };
      }
      const out = { reconciled: await reconcile() };
      let c = cfg;
      if (!c.paused) {
        const br = brakeOf(await brakeRows(c) || [], c);
        if (br.trip) { c = await pause(`optout_${br.pct}pct_of_${br.n}`, s.keeta && s.keeta.pull); out.paused = c.pauseReason; }
      }
      if (!c.paused) out.enroll = (await enroll(s, c, now)).enroll.length;
      out.anchored = await anchorStep(c, now);
      out.advanced = await advance(c, now);
      out.send = await sendDue(s, c, now);
      if (out.enroll || out.send.sent) console.log(`[ka2] enrolled ${out.enroll || 0}, advanced ${out.advanced}, sent ${out.send.sent}${out.send.waited ? ` (wait: ${out.send.waited})` : ""}`);
      return out;
    } finally { busy = false; }
  }

  /* ═══ اللوحة ═══ */
  const guardOwner = async (c) => { const err = await requireAdmin(c); if (err) return err; if (!(await isOwner(c))) return c.json({ ok: false, error: "المالك بس" }, 403); return null; };

  app.get("/api/keeta/pull", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const s = (await getSettingsData()) || {};
    const cfg = pullCfg(s), now = clock();
    const [all, d7, d14, reasons, recent, coupon, link, caps, waiting, tpl] = await Promise.all([
      ka2Results(q, {}), ka2Results(q, { days: 7 }), ka2Results(q, { days: 14 }),
      q("SELECT reason, count(*)::int AS n FROM ka2_sends WHERE reason IS NOT NULL GROUP BY 1 ORDER BY 2 DESC", []),
      q(`SELECT k.phone_norm, k.order_at, k.review_due_at, k.review_anchor, k.handoff_at, k.status, k.reason, k.rating, k.rating_exact, k.high, k.holdout, k.due_at, k.sent_at, k.clicked_at,
                iv.sent_at AS review_sent_at, m.status AS wa_status,
                (SELECT so.order_no FROM shop_orders so WHERE so.phone_norm = k.phone_norm AND ${shopPaidSql("so")} AND so.created_at > COALESCE(k.sent_at, k.eligible_at, k.created_at)
                  ORDER BY so.created_at LIMIT 1) AS web_order
           FROM ka2_sends k LEFT JOIN review_invites iv ON iv.order_no = k.review_order_no LEFT JOIN wa_messages m ON m.wamid = k.wamid AND k.wamid IS NOT NULL
          ORDER BY k.created_at DESC LIMIT 50`, []),
      couponRow(), linkRow(), sentToday(now),
      q(`SELECT count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='review_wait')::int AS review_wait,
                count(*) FILTER (WHERE status='review_wait' AND review_anchor='pending')::int AS handoff_pending FROM ka2_sends`, []),
      q("SELECT DISTINCT ON (name) name, event AS status FROM wa_template_events WHERE name = ANY($1::text[]) ORDER BY name, at DESC, id DESC", [TEMPLATES]),      // آخر حدث من ميتا (APPROVED / REJECTED …)
    ]);
    const gate = isRestaurantOpenAt(now, s);
    return c.json({
      ok: true, settings: cfg, schema: pullSchemaRows(s.keeta && s.keeta.pull), reasonsAr: KA2_REASON_AR,
      state: {
        enabled: cfg.enabled, paused: cfg.paused, pauseReason: cfg.pauseReason, pausedAt: cfg.pausedAt, enabledAt: cfg.enabledAt,
        queued: waiting && waiting[0] ? waiting[0].queued : null, reviewWait: waiting && waiting[0] ? waiting[0].review_wait : null,
        handoffPending: waiting && waiting[0] ? waiting[0].handoff_pending : null, reviewAnchor: cfg.reviewAnchor,
        sentToday: caps ? caps.today : null, dailyCap: cfg.dailyCap, restaurantOpen: gate, waCloud: cloudCfg(s).enabled,
        coupon: coupon ? { code: coupon.code, minTotal: Number(coupon.min_total), active: coupon.active !== false } : null,
        link: link ? { slug: link.slug, active: link.active !== false, coupon: link.coupon || null } : null,
        templates: (tpl || []).map((t) => ({ name: t.name, status: t.status })), lifetimeOne: true,
      },
      results: { d7, d14, all },
      reasons: (reasons || []).map((r) => ({ reason: r.reason, n: r.n, ar: reasonAr(r.reason) })),
      recent: (recent || []).map((r) => ({ phone: maskPhone(r.phone_norm), orderAt: r.order_at, reviewDueAt: r.review_due_at, reviewAnchor: r.review_anchor || "order", handoffAt: r.handoff_at || null,
        reviewSentAt: r.review_sent_at, status: r.status,
        reason: r.reason, reasonAr: reasonAr(r.reason), rating: r.rating, exact: r.rating_exact, high: r.high, holdout: r.holdout, dueAt: r.due_at, sentAt: r.sent_at,
        waStatus: r.wa_status || null, clicked: Boolean(r.clicked_at), webOrder: r.web_order || null })),
      note: "الطلبات على كيتا بعد الرسالة (نقلناهم ولا زوّدناهم؟) — شوف «العملاء» ← lifetimeOrders (/api/keeta-reports/customers)",
    });
  });

  app.put("/api/keeta/pull/settings", async (c) => {
    const g = await guardOwner(c); if (g) return g;
    const b = await c.req.json().catch(() => null);
    const s = (await getSettingsData()) || {};
    const r = pullFromBody(b, s.keeta && s.keeta.pull, clock());
    if (!r.ok) return c.json({ ok: false, error: r.errors.join(" · ") }, 400);
    await savePull(r.value);
    await auditNote?.(c, `كيتا: رسايل ما بعد الطلب (KA2) ${JSON.stringify(b)}`);
    return c.json({ ok: true, settings: r.value });
  });

  /* رسالة «اطلب من موقعنا» تجربة لرقم فريق (المالك): نفس القالب والمتغيّرات والرابط الشخصي، صف في ka2_tests (مش بيدخل الأرقام ولا بيحجز الرقم) */
  app.post("/api/keeta/pull/test-send", async (c) => {
    const g = await guardOwner(c); if (g) return g;
    await ready;
    const b = await c.req.json().catch(() => ({}));
    const pn = String(b && b.phone ? b.phone : "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
    const s = (await getSettingsData()) || {};
    const testers = new Set([...staffOf(s), ...(Array.isArray(s.waBot && s.waBot.testPhones) ? s.waBot.testPhones : []).map((x) => String(x).replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""))]);
    if (!/^5\d{8}$/.test(pn) || !testers.has(pn)) return c.json({ ok: false, error: "الرقم لازم يكون من أرقام الفريق أو التجربة" }, 400);
    const cfg = pullCfg(s), coupon = await couponRow();
    const code = linkCodeOf();
    let params; try { params = pullParams(cfg.template, coupon, code); } catch (e) { return c.json({ ok: false, error: e.message === "ka2_coupon" ? "كوبون FIRST مش موجود" : e.message }, 400); }
    const w = wa();
    if (!w) return c.json({ ok: false, error: "واتساب مش متوصّل" });
    let r = null;
    const isTester = (Array.isArray(s.waBot && s.waBot.testPhones) ? s.waBot.testPhones : []).some((x) => String(x).replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") === pn);
    try { r = await w.sendTemplate({ phoneNorm: pn, template: cfg.template, params, source: KA2_SOURCE, ...(isTester ? { test: true } : { proactive: true }) }); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    await q("INSERT INTO ka2_tests(phone_norm, link_code, ok, result) VALUES ($1,$2,$3,$4)", [pn, code, Boolean(r && r.ok), JSON.stringify(r || {}).slice(0, 300)]);
    return c.json({ ok: Boolean(r && r.ok), result: r, link: `freshcuts.sa/l/${linkSuffix(code)}`, params });
  });

  /* KA2c (قراءة بس): طلبات كيتا في آخر N يوم — كام واحد نقطة البيع قالت إنه اتسلّم، ووسيط الدقايق من الطلب. قبل ما تعتمد على المرجع «التسليم». */
  app.get("/api/keeta/pull/handoff-coverage", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const days = Math.min(30, Math.max(1, Math.round(Number(c.req.query("days")) || 7)));
    const s = (await getSettingsData()) || {};
    const cfg = pullCfg(s);
    const rows = await q(HANDOFF_COVERAGE_SQL, [days]);
    if (rows === null) return c.json({ ok: false, error: "القراءة فشلت" }, 500);
    return c.json({ ok: true, days, reviewAnchor: cfg.reviewAnchor, handoffWaitMin: cfg.handoffWaitMin, ...handoffCoverage(rows, cfg) });
  });

  /* خطة من غير كتابة: مين هيدخل دلوقتي ومين هيتخطّى وليه */
  app.post("/api/keeta/pull/dry-run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const s = (await getSettingsData()) || {};
    const cfg = pullCfg(s);
    const plan = await enroll(s, { ...cfg, enabled: true, enabledAt: cfg.enabledAt || new Date(clock().getTime() - cfg.maxLateHours * 3600_000).toISOString() }, clock(), { dry: true });
    return c.json({ ok: true, enabled: cfg.enabled, enroll: plan.enroll.map((x) => ({ ...x, pn: maskPhone(x.pn) })), skip: plan.skip.map((x) => ({ ...x, pn: maskPhone(x.pn), ar: reasonAr(x.reason) })) });
  });

  console.log("[ka2] routes ready");
  return { tick, ready, enroll, anchorStep, advance, sendDue, reconcile };
}

/* محلّل الرابط (cms.js POST /api/cms/links/resolve/:slug): /l/keeta-first-<code> ⇒ صف المستلم (أو صف تجربة) ⇒ { table, id, coupon } أو null */
export async function resolveKa2Link(pool, slug) {
  const p = parseRecipientSlug(slug);
  if (!p || p.base !== LINK_SLUG || !CODE_RE.test(p.code)) return null;
  const r = await pool.query("SELECT id, coupon FROM ka2_sends WHERE link_code=$1 LIMIT 1", [p.code]).catch(() => ({ rows: [] }));
  if (r.rows && r.rows[0]) return { table: "ka2_sends", id: r.rows[0].id, coupon: r.rows[0].coupon || COUPON_CODE, base: p.base };
  const t = await pool.query("SELECT id FROM ka2_tests WHERE link_code=$1 LIMIT 1", [p.code]).catch(() => ({ rows: [] }));
  if (t.rows && t.rows[0]) return { table: "ka2_tests", id: t.rows[0].id, coupon: COUPON_CODE, base: p.base };
  return null;
}
