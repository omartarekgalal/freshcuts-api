/* ═══════════════════════════════════════════════════════════════════════════
   🧬 تصنيف العملاء التلقائي — «ملف العميل المصنّف» (CP1، ١٥/١٠/٢٠٢٦)

   عمر (١٥/١٠): «نحتاج دايماً العملاء تتصنّف تلقائي في ملفاتها، عشان بعد كده الاستهداف برسالة مخصّصة
   يكون سهل بالقيم من الملف، وتتحدّث لوحدها».

   ── الشكل ──────────────────────────────────────────────────────────────────
   • جدول cust_profile: صف لكل جوال (identity.js — الجوال بعد التطبيع)، أعمدة بأنواعها (رقم/نص/منطقي/تاريخ)
     مش JSON، عشان الاستهداف والتقارير تقرا منها مباشرة. كل صف عليه computed_at + trigger + orders_through
     (أحدث طلب اتحسب)، وكل حقل مكتوب مصدره وإمتى بيتحدّث في PROFILE_FIELDS.
   • بيتحسب لوحده: كل ليلة للكل (nightlyHour، الافتراضي ٠٥:٠٠ الرياض — بعد قفل اليوم التشغيلي ٠٤:٠٠)،
     وبعد كل طلب مدفوع (حدث order_paid من shop.js + مسح كل ٥ دقايق للي اتحدّث في نقطة البيع/الموقع/جوال الكاشير —
     الحدث ممكن يروح للحاوية القديمة وقت النشر)، ولو حد فتح ملف أقدم من ٢٤ ساعة.
   • المصادر = نفس قواعد ملف العميل (customer360): طلبات نقطة البيع (من غير الملغي ومن غير مرايا طلبات الموقع
     source='website') + طلبات الموقع المدفوعة، والطلب اللي اتسجّل في الاتنين بيتعدّ مرة (matchWebToPos).
     الساعات بتوقيت الرياض دايماً (ts_orders بالـUTC)، والأيام بيوم العمل (بيقلب ٤ الفجر).
   • كل الحدود من اللوحة (settings.cms.customerProfile) — الكود فيه الافتراضي بس.

   ── الاستهداف (wasender.js) ────────────────────────────────────────────────
   • فلتر «ملف العميل» فوق أي شريحة حملة واتساب (filters.profile) + شريحة «كل العملاء» (profile_all).
   • قيم لكل مستلم في خانات قوالب الكتالوج: {first_name} {fav_dish} {fav_dish_weight} {fav_category} {fav_box}
     {fee_line} {loyalty_line}. اللي قيمة ناقصة عنده بيطلع من الحملة (عمره ما بيوصله نص عام بدل قيمته)، واللي
     ممكن يتغيّر بعد التجهيز (البوكس، FIRST، رصيد الولاء) بيتراجع تاني وقت الإرسال (recheckRow).
   • سطر التوصيل {fee_line} من غير أي رقم رسوم: الرسم الحقيقي محتاج تسعيرة لعنوان العميل لحظة الإرسال
     (ده شغل FD1 — wafavpick)؛ هنا جمل صحيحة دايماً بنفس صياغة FD1 (deliveryLine).
   • ٨ شرايح مشتقّة (SEG_DEFS) — بتظهر كمان في كل حملات اللوحة (SMS/الأتمتة/واتساب) كـ«p_<id>» (cms.js).

   الجزء الأول دوال صافية (custprofile.test.mjs)، والتشغيل في register().
═══════════════════════════════════════════════════════════════════════════ */
import { shopPaidSql, appOnlyPhonesSql, BIZ_DAY_START_HOUR } from "./identity.js";
import { matchWebToPos, posChannel, itemCategory, CATEGORY_LABELS } from "./customer360.js";
import { favDish, isDishName } from "./wamsg.js";
import { foodGroup, foodGroupOf, FOOD_GROUPS, itemFamily, leanOf, teamPhoneSet } from "./smsrules.js";
import { rankDishes, cleanKey, normW, showW, deliveryLine, FAV_RULES, FAV_SQL, buildLive, inBox, boxLive, latinDigits } from "./wafavpick.js";
import { loyaltyCfgOf, LOYALTY_COUNTED_SQL } from "./loyalty.js";
import { ORDER_BUTTON, MENU_BUTTON } from "./watemplates.js";
import { plausibleName } from "./posnames.js";
import { pausedOffersOf } from "./soldout.js";
import { subscribe } from "./order-events.js";

export const PROFILE_VERSION = 1;
export const PROFILE_ALL = "profile_all";
const DAY = 86400_000;
const PHONE_RE = "^5[0-9]{8}$";
const DOWS = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
export const DOW_AR = Object.freeze({ sat: "السبت", sun: "الأحد", mon: "الاتنين", tue: "التلات", wed: "الأربع", thu: "الخميس", fri: "الجمعة" });
const nz = (v) => (v == null ? "" : String(v));
const tms = (v) => (v instanceof Date ? v.getTime() : Date.parse(nz(v)));
const iso = (v) => { const t = tms(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/* ═══ ⚙️ الإعدادات (settings.cms.customerProfile — من اللوحة) ═════════════ */
export const PROFILE_DEFAULTS = Object.freeze({
  tierA: 10, tierB: 30, tierC: 60,                 // أعلى X٪ إنفاق (تراكمي) — الباقي D
  activeDays: 21, riskDays: 45, dormantDays: 90,   // نفس حدود شرايح اللوحة (loyal ≤٢١، at_risk ٢٢–٤٥، dormant لحد ٩٠)
  freqRegular: 3, freqFrequent: 6,                 // طلبات آخر ٩٠ يوم
  bigBillSar: 150,                                 // ≈ أعلى ١٠٪ متوسط طلب (قياس ١٥/١٠: P90 = ١٣٩)
  groupOrderSar: FAV_RULES.bigOrder, groupTwiceSar: FAV_RULES.bigTwice, groupKilos: FAV_RULES.bigKilos,   // نفس «طلبات جمعات» بتاعة FD1
  lunchStart: 11, lunchEnd: 16, lateStart: 22, lateEnd: 4,
  weekendDays: Object.freeze(["thu", "fri"]),     // أعلى يومين طلبات (قياس ١٥/١٠) — يوم العمل
  priceHighPct: 80, feeLowSar: 10,
  lateLeanPct: 50, lunchLeanPct: 50, weekendLeanPct: 50,
  firstReadyDays: 45, risingDays: 60,
  nightlyHour: 5,
});
export const PROFILE_SETTING_GROUPS = Object.freeze({
  value: "💎 القيمة", recency: "⏱ الحداثة والتكرار", basket: "🧾 الفاتورة والجمعات", timing: "🕙 المواعيد",
  price: "🏷 الأسعار والتوصيل", segments: "🎯 الشرايح المشتقّة", run: "🔄 التحديث",
});
export const PROFILE_SCHEMA = Object.freeze([
  { key: "tierA", group: "value", ar: "شريحة A = أعلى كام ٪ في الإنفاق", unit: "٪", min: 1, max: 50, help: "الإنفاق الكلي من كل القنوات من غير تكرار، مقارنة بكل العملاء اللي صرفوا" },
  { key: "tierB", group: "value", ar: "A + B مع بعض = أعلى كام ٪", unit: "٪", min: 2, max: 80 },
  { key: "tierC", group: "value", ar: "A + B + C = أعلى كام ٪ (والباقي D)", unit: "٪", min: 3, max: 95 },
  { key: "activeDays", group: "recency", ar: "«نشط» لحد كام يوم من آخر طلب", unit: "يوم", min: 3, max: 60, help: "نفس حد «متوقف» في الشرايح" },
  { key: "riskDays", group: "recency", ar: "«في خطر» لحد كام يوم", unit: "يوم", min: 7, max: 120 },
  { key: "dormantDays", group: "recency", ar: "«نايم» لحد كام يوم (وبعدها «ضايع»)", unit: "يوم", min: 14, max: 365 },
  { key: "freqRegular", group: "recency", ar: "«منتظم» من كام طلب في آخر ٩٠ يوم", unit: "طلب", min: 2, max: 30 },
  { key: "freqFrequent", group: "recency", ar: "«كتير» من كام طلب في آخر ٩٠ يوم", unit: "طلب", min: 3, max: 60 },
  { key: "bigBillSar", group: "basket", ar: "«فاتورة كبيرة»: متوسط طلبه من", unit: "ر.س", min: 30, max: 2000 },
  { key: "groupOrderSar", group: "basket", ar: "«طلبات جمعات»: طلب واحد من", unit: "ر.س", min: 50, max: 5000 },
  { key: "groupTwiceSar", group: "basket", ar: "…أو طلبين كل واحد من", unit: "ر.س", min: 50, max: 5000 },
  { key: "groupKilos", group: "basket", ar: "…أو مشاوي بالوزن في طلب واحد من", unit: "كيلو", min: 1, max: 20 },
  { key: "lunchStart", group: "timing", ar: "الغدا من الساعة", unit: "ساعة", min: 6, max: 18 },
  { key: "lunchEnd", group: "timing", ar: "الغدا لحد الساعة (وبعدها العشا)", unit: "ساعة", min: 8, max: 20 },
  { key: "lateStart", group: "timing", ar: "آخر الليل من الساعة", unit: "ساعة", min: 18, max: 23 },
  { key: "lateEnd", group: "timing", ar: "آخر الليل لحد الساعة (بعد نص الليل)", unit: "ساعة", min: 0, max: 8 },
  { key: "weekendDays", group: "timing", type: "days", ar: "أيام الويكند", help: "بيوم العمل (طلب ١ الفجر بيتحسب لليوم اللي قبله)" },
  { key: "priceHighPct", group: "price", ar: "حساسية سعر «عالية»: نسبة طلباته بخصم من", unit: "٪", min: 30, max: 100, help: "الخصم = كوبون أو خصم في نقطة البيع/التطبيق (أغلبه عروض عامة)؛ أو كوبونين اختارهم بنفسه" },
  { key: "feeLowSar", group: "price", ar: "رسوم توصيل «قليلة» لحد", unit: "ر.س", min: 1, max: 50 },
  { key: "lateLeanPct", group: "segments", ar: "«عملاء آخر الليل»: نسبة طلباتهم بالليل من", unit: "٪", min: 20, max: 100 },
  { key: "lunchLeanPct", group: "segments", ar: "«زباين الغدا»: نسبة طلباتهم وقت الغدا من", unit: "٪", min: 20, max: 100 },
  { key: "weekendLeanPct", group: "segments", ar: "«زباين الويكند»: نسبة طلباتهم في الويكند من", unit: "٪", min: 20, max: 100 },
  { key: "firstReadyDays", group: "segments", ar: "«جاهزين لأول طلب من الموقع»: آخر طلب خلال", unit: "يوم", min: 7, max: 180 },
  { key: "risingDays", group: "segments", ar: "«صاعدين»: أول طلب خلال", unit: "يوم", min: 14, max: 180 },
  { key: "nightlyHour", group: "run", ar: "ساعة الحساب الليلي للكل (الرياض)", unit: "ساعة", min: 4, max: 10, help: "بعد قفل اليوم التشغيلي (٤ الفجر) وقبل الفتح" },
].map((x) => ({ type: "number", ...x, default: PROFILE_DEFAULTS[x.key] })));

const clampN = (v, lo, hi, d) => { const n = Number(v); return v === null || v === "" || v === undefined || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, Math.round(n))); };
const cleanDays = (v) => { if (!Array.isArray(v)) return null; const s = new Set(v.map((x) => String(x).toLowerCase())); const d = DOWS.filter((k) => s.has(k)); return d.length && d.length < 7 ? d : null; };
/* ترتيب الحدود: لو اتكسر (مثلاً B أصغر من A) المجموعة كلها بترجع للافتراضي — مفيش تصنيف مقلوب */
export function profileOrderProblems(c) {
  const out = [];
  if (!(c.tierA < c.tierB && c.tierB < c.tierC)) out.push(["tiers", "شرايح القيمة لازم تكبر: A أقل من A+B أقل من A+B+C"]);
  if (!(c.activeDays < c.riskDays && c.riskDays < c.dormantDays)) out.push(["recency", "أيام الحداثة لازم تكبر: نشط < في خطر < نايم"]);
  if (!(c.freqRegular < c.freqFrequent)) out.push(["freq", "«كتير» لازم يبقى أكبر من «منتظم»"]);
  if (!(c.lunchStart < c.lunchEnd && c.lunchEnd <= c.lateStart && c.lateEnd <= c.lunchStart)) out.push(["hours", "المواعيد لازم تمشي: آخر الليل يخلص قبل الغدا، والغدا قبل العشا، والعشا قبل آخر الليل"]);
  if (!(c.groupTwiceSar <= c.groupOrderSar)) out.push(["group", "«طلبين كل واحد من» لازم يبقى أقل من أو يساوي «طلب واحد من»"]);
  return out;
}
const GROUP_KEYS = { tiers: ["tierA", "tierB", "tierC"], recency: ["activeDays", "riskDays", "dormantDays"], freq: ["freqRegular", "freqFrequent"], hours: ["lunchStart", "lunchEnd", "lateStart", "lateEnd"], group: ["groupOrderSar", "groupTwiceSar"] };
export function profileCfg(settings) {
  const raw = (((settings || {}).cms || {}).customerProfile);
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const c = {};
  for (const x of PROFILE_SCHEMA) c[x.key] = x.type === "days" ? (cleanDays(src[x.key]) || [...PROFILE_DEFAULTS[x.key]]) : clampN(src[x.key], x.min, x.max, PROFILE_DEFAULTS[x.key]);
  for (const [g] of profileOrderProblems(c)) for (const k of GROUP_KEYS[g]) c[k] = PROFILE_DEFAULTS[k];
  return c;
}
/* حفظ من اللوحة: مفاتيح معروفة بس، أرقام جوّه الحدود (من غير تقريب في صمت)، وترتيب سليم ⇒ {ok, cfg} أو {ok:false, errors} */
export function cleanProfileSettings(body, prevSettings) {
  const errors = [];
  const cur = profileCfg(prevSettings);
  const next = { ...cur };
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  for (const [k, v] of Object.entries(b)) {
    const x = PROFILE_SCHEMA.find((s) => s.key === k);
    if (!x) { errors.push([k, `إعداد مش معروف: ${k}`]); continue; }
    if (x.type === "days") { const d = cleanDays(v); if (!d) errors.push([k, "اختار يوم واحد على الأقل وأقل من ٧"]); else next[k] = d; continue; }
    const n = Number(v);
    if (v === "" || v === null || !Number.isFinite(n)) { errors.push([k, `«${x.ar}»: اكتب رقم`]); continue; }
    if (n < x.min || n > x.max) { errors.push([k, `«${x.ar}»: المسموح من ${x.min} لـ${x.max}`]); continue; }
    next[k] = Math.round(n);
  }
  for (const [g, m] of profileOrderProblems(next)) errors.push([g, m]);
  return errors.length ? { ok: false, errors } : { ok: true, cfg: next };
}
export const schemaView = (settings) => { const c = profileCfg(settings); return PROFILE_SCHEMA.map((x) => ({ ...x, value: c[x.key] })); };

/* ═══ 📋 الحقول: الاسم والمصدر وإمتى بيتحدّث (اللوحة بتعرضها من هنا) ══════ */
const SRC = {
  orders: "طلبات نقطة البيع + الموقع + التطبيقات (من غير الملغي، والطلب اللي في الاتنين بيتعدّ مرة)",
  value: "إنفاقه الكلي مقارنة بكل العملاء اللي صرفوا (الحدود بتتحسب كل ليلة)",
  hours: "وقت كل طلب بتوقيت الرياض (نقطة البيع بتسجّل UTC)",
  days: "يوم العمل (بيقلب ٤ الفجر)",
  items: "أصناف طلباته (نقطة البيع + الموقع) بوزن الحداثة",
  pos: "نوع الطلب في نقطة البيع (صالة/استلام/توصيل) + الموقع",
  web: "طلبات الموقع المدفوعة",
  first: "كوبون FIRST شغّال + مااستخدموش على توصيل + مالوش طلب توصيل من الموقع",
  loyalty: "طلبات الموقع من أول ما الولاء اتفعّل + مكافآت cms_loyalty الصالحة",
  delivery: "آخر طلب توصيل من الموقع: الحي والرسم المحسوب لعنوانه قبل أي كوبون",
  lang: "لغة رسايله لينا على واتساب (البوت) — من غير رسايل = عربي",
  wa: "إيقاف واتساب + إيقاف رسايل التسويق + أرقام واتساب رفضتها + رقم من تطبيق توصيل بس",
  chat: "رسايله الواردة على واتساب",
  mkt: "آخر رسالة من حملة واتساب أو حملة/أتمتة SMS اتبعتت له، ورده عليها (طلب = أي طلب خلال ٧ أيام بعدها)",
  names: "حساب الموقع ← نقطة البيع ← الكاشير/الطلب",
  derived: "قواعد على الحقول اللي فوق بحدود الإعدادات",
};
export const FIELD_GROUPS = Object.freeze({
  value: "💎 القيمة", recency: "⏱ الحداثة والتكرار", channels: "🛵 القنوات", taste: "🍖 بيحب إيه", timing: "🕙 بيطلب إمتى",
  basket: "🧾 الفاتورة", price: "🏷 الأسعار", loyalty: "🎁 الولاء", delivery: "📍 التوصيل", contact: "💬 التواصل",
  marketing: "📣 آخر رسالة تسويقية", segments: "🎯 الشرايح",
});
const F = (key, group, ar, type, src, refresh = "order") => ({ key, group, ar, type, src: SRC[src] || src, refresh });
export const REFRESH_AR = Object.freeze({ order: "بعد كل طلب مدفوع + كل ليلة", nightly: "كل ليلة + بعد كل طلب + لما الملف يتفتح وهو أقدم من يوم" });
export const PROFILE_FIELDS = Object.freeze([
  F("value_tier", "value", "شريحة القيمة", "enum", "value"), F("spend", "value", "إجمالي الإنفاق", "money", "orders"), F("orders", "value", "عدد الطلبات", "int", "orders"),
  F("aov", "value", "متوسط الطلب", "money", "orders"), F("max_ticket", "value", "أكبر طلب", "money", "orders"), F("spend_pct", "value", "أعلى من كام ٪ من العملاء في الإنفاق", "pct", "value"),
  F("recency_band", "recency", "الحداثة", "enum", "orders"), F("days_since", "recency", "من آخر طلب", "days", "orders"), F("last_order_at", "recency", "آخر طلب", "date", "orders"),
  F("first_order_at", "recency", "أول طلب", "date", "orders"), F("freq_band", "recency", "التكرار (آخر ٩٠ يوم)", "enum", "orders"), F("orders_90d", "recency", "طلبات آخر ٩٠ يوم", "int", "orders"),
  F("avg_gap_days", "recency", "بيطلب كل", "days", "orders"),
  F("main_channel", "channels", "القناة الأساسية", "enum", "orders"), F("pos_orders", "channels", "طلبات المطعم", "int", "orders"), F("web_orders", "channels", "طلبات الموقع", "int", "orders"),
  F("app_orders", "channels", "طلبات التطبيقات", "int", "orders"), F("app_names", "channels", "التطبيقات", "text", "orders"), F("service_pref", "channels", "بيفضّل", "enum", "pos"),
  F("fav_category", "taste", "نوع أكله المفضّل", "enum", "items"), F("fav_subcat", "taste", "بالتفصيل", "enum", "items"), F("fav_dish", "taste", "طبقه المفضّل", "text", "items"),
  F("fav_weight", "taste", "وزنه المعتاد", "weight", "items"), F("lean", "taste", "الميل", "enum", "items"), F("cat_shares", "taste", "توزيع أكله", "shares", "items"),
  F("daypart", "timing", "بيطلب غالباً", "enum", "hours"), F("late_night_share", "timing", "نسبة طلبات آخر الليل", "share", "hours"), F("lunch_share", "timing", "نسبة الغدا", "share", "hours"),
  F("dinner_share", "timing", "نسبة العشا", "share", "hours"), F("day_pref", "timing", "الأيام", "enum", "days"), F("weekend_share", "timing", "نسبة الويكند", "share", "days"),
  F("big_bill", "basket", "فاتورة كبيرة", "bool", "orders"), F("group_order", "basket", "طلبات جمعات", "bool", "orders"),
  F("price_sensitivity", "price", "حساسية السعر", "enum", "orders"), F("discount_share", "price", "نسبة طلباته بخصم", "share", "orders"), F("coupon_orders", "price", "كوبونات اختارها (غير FIRST والمكافآت)", "int", "web"),
  F("used_first", "price", "استخدم FIRST", "bool", "web"), F("first_eligible", "price", "FIRST متاح له", "bool", "first"),
  F("loyalty_orders", "loyalty", "طلبات الموقع في الولاء", "int", "loyalty"), F("loyalty_left", "loyalty", "باقي على المكافأة", "int", "loyalty"), F("reward_code", "loyalty", "مكافأة صالحة", "text", "loyalty"),
  F("reward_expires", "loyalty", "المكافأة لحد", "date", "loyalty"),
  F("district", "delivery", "الحي", "text", "delivery"), F("fee_band", "delivery", "رسوم التوصيل المعتادة", "enum", "delivery"), F("last_fee", "delivery", "آخر رسم محسوب", "money", "delivery"),
  F("last_km", "delivery", "المسافة", "km", "delivery"), F("delivery_orders", "delivery", "طلبات توصيل من الموقع", "int", "web"),
  F("lang", "contact", "اللغة", "enum", "lang", "nightly"), F("wa_reach", "contact", "واتساب التسويق", "enum", "wa", "nightly"), F("wa_optin", "contact", "وافق على العروض صراحةً", "bool", "wa", "nightly"),
  F("wa_chat", "contact", "كلّمنا على واتساب", "bool", "chat", "nightly"), F("wa_last_in_at", "contact", "آخر رسالة منه", "date", "chat", "nightly"),
  F("mkt_last_at", "marketing", "آخر رسالة", "date", "mkt", "nightly"), F("mkt_last_channel", "marketing", "القناة", "enum", "mkt", "nightly"), F("mkt_last_label", "marketing", "الحملة", "text", "mkt", "nightly"),
  F("mkt_last_result", "marketing", "النتيجة", "enum", "mkt", "nightly"), F("mkt_30d", "marketing", "رسايل تسويق آخر ٣٠ يوم", "int", "mkt", "nightly"),
  F("segments", "segments", "الشرايح", "segments", "derived"),
]);
export const ENUM_AR = Object.freeze({
  value_tier: { A: "A", B: "B", C: "C", D: "D", none: "من غير إنفاق" },
  recency_band: { active: "نشط", at_risk: "في خطر", dormant: "نايم", lost: "ضايع", none: "ماطلبش" },
  freq_band: { frequent: "كتير", regular: "منتظم", occasional: "أحياناً (طلبين)", once: "طلب واحد", none: "مفيش في آخر ٩٠ يوم" },
  main_channel: { pos: "المطعم", web: "الموقع", apps: "التطبيقات" },
  service_pref: { delivery: "توصيل", takeaway: "استلام", dine_in: "صالة" },
  fav_category: Object.fromEntries(FOOD_GROUPS.map((g) => [g.id, g.label])),
  fav_subcat: Object.fromEntries(Object.entries(CATEGORY_LABELS).filter(([k]) => !["drinks", "sides", "other"].includes(k))),
  lean: { grill: "بيميل للمشاوي والوجبات", box: "بيميل لبيتزا/كريب/باستا/حواوشي", mixed: "مشكّل" },
  daypart: { lunch: "غدا", dinner: "عشا", late: "آخر الليل", morning: "الصبح" },
  day_pref: { weekend: "الويكند", weekday: "وسط الأسبوع", mixed: "مختلط" },
  price_sensitivity: { high: "عالية", medium: "متوسطة", low: "قليلة", unknown: "مش معروفة" },
  fee_band: { free: "مجاني", low: "قليل", high: "عالي", far: "منطقة بعيدة", none: "ماطلبش توصيل من الموقع" },
  lang: { ar: "عربي", en: "إنجليزي" },
  wa_reach: { reachable: "توصله", stopped: "وقّف العروض على واتساب", opted_out: "وقّف رسايل التسويق", invalid: "مش على واتساب", app_only: "رقم من تطبيق توصيل بس", staff: "فريق/تجربة" },
  mkt_last_channel: { whatsapp: "واتساب", sms: "SMS" },
  mkt_last_result: { ordered: "طلب بعدها", tapped: "ضغط", replied: "رد", read: "قراها", delivered: "وصلت", sent: "اتبعتت", failed: "فشلت" },
});

/* ═══ 🎯 الشرايح المشتقّة ══════════════════════════════════════════════════ */
export const SEG_DEFS = Object.freeze([
  { id: "late_night", icon: "🌙", label: "عملاء آخر الليل", hint: (c) => `طلبين أو أكتر و${c.lateLeanPct}٪+ من طلباتهم من ${c.lateStart}:00 لـ${c.lateEnd}:00`,
    test: (r, c) => r.orders >= 2 && Number(r.late_night_share) >= c.lateLeanPct / 100 },
  { id: "lunch_regulars", icon: "☀️", label: "زباين الغدا", hint: (c) => `طلبين أو أكتر و${c.lunchLeanPct}٪+ من طلباتهم من ${c.lunchStart}:00 لـ${c.lunchEnd}:00`,
    test: (r, c) => r.orders >= 2 && Number(r.lunch_share) >= c.lunchLeanPct / 100 },
  { id: "weekend_regulars", icon: "📅", label: "زباين الويكند", hint: (c) => `طلبين أو أكتر و${c.weekendLeanPct}٪+ من طلباتهم يوم ${c.weekendDays.map((d) => DOW_AR[d]).join(" أو ")}`,
    test: (r, c) => r.orders >= 2 && Number(r.weekend_share) >= c.weekendLeanPct / 100 },
  { id: "gatherings", icon: "👨‍👩‍👧‍👦", label: "طلبات جمعات", hint: (c) => `طلب ${c.groupOrderSar}+ ر.س، أو طلبين ${c.groupTwiceSar}+، أو ${c.groupKilos} كيلو مشاوي في طلب`,
    test: (r) => r.group_order === true },
  { id: "big_lapsed", icon: "💤", label: "كبار غايبين", hint: (c) => `شريحة A أو B وآخر طلب من ${c.activeDays + 1} لـ${c.dormantDays} يوم`,
    test: (r) => ["A", "B"].includes(r.value_tier) && ["at_risk", "dormant"].includes(r.recency_band) },
  { id: "deal_seekers", icon: "🏷", label: "بيحبوا العروض", hint: (c) => `كوبونين اختارهم بنفسه، أو ${c.priceHighPct}٪+ من طلباته (٣ أو أكتر) بخصم`,
    test: (r) => r.price_sensitivity === "high" },
  { id: "first_ready", icon: "🎯", label: "جاهزين لأول طلب من الموقع", hint: (c) => `طلبين أو أكتر (صالة/تطبيقات)، آخر طلب خلال ${c.firstReadyDays} يوم، وFIRST لسه متاح له`,
    test: (r, c) => r.first_eligible === true && r.orders >= 2 && r.days_since != null && r.days_since <= c.firstReadyDays },
  { id: "rising", icon: "📈", label: "صاعدين", hint: (c) => `أول طلب خلال ${c.risingDays} يوم ورجع طلب تاني`,
    test: (r, c, now) => r.orders >= 2 && Boolean(r.first_order_at) && (now - tms(r.first_order_at)) / DAY <= c.risingDays },
]);
export const SEG_IDS = Object.freeze(SEG_DEFS.map((s) => s.id));
export const segmentsView = (cfg) => SEG_DEFS.map((s) => ({ id: s.id, icon: s.icon, label: s.label, hint: s.hint(cfg) }));
/* شرايح اللوحة (cms.js SEGMENTS): «p_<id>» — العضوية من cust_profile.segments اللي customerRows بيحطها في c.psegs. cfgOf() = حدود الإعدادات للشرح */
export function profileCmsSegments(cfgOf = () => profileCfg({})) {
  return SEG_DEFS.map((d) => ({ id: `p_${d.id}`, icon: d.icon, label: `${d.label} (ملف العميل)`,
    get hint() { let c; try { c = cfgOf() || profileCfg({}); } catch { c = profileCfg({}); } return `من ملف العميل المصنّف: ${d.hint(c)}`; },
    test: (c) => Boolean(c) && Array.isArray(c.psegs) && c.psegs.includes(d.id) }));
}
export function deriveSegments(row, cfg, now = Date.now()) {
  if (!row || row.is_staff) return [];
  return SEG_DEFS.filter((s) => { try { return Boolean(s.test(row, cfg, now)); } catch { return false; } }).map((s) => s.id);
}

/* ═══ 🧮 الحساب (صافي) ═════════════════════════════════════════════════════ */
/* الساعة بتوقيت الرياض (UTC+3 من غير توقيت صيفي) + يوم العمل (بيقلب BIZ_DAY_START_HOUR الفجر) */
export function riyadhClock(ts) {
  const t = tms(ts);
  if (!Number.isFinite(t)) return null;
  const r = new Date(t + 3 * 3600_000);
  const b = new Date(t + (3 - BIZ_DAY_START_HOUR) * 3600_000);
  return { hour: r.getUTCHours(), bizDow: DOWS[b.getUTCDay()], bizDay: b.toISOString().slice(0, 10) };
}
export function daypartOf(hour, cfg) {
  const h = Number(hour);
  if (h >= cfg.lateStart || h < cfg.lateEnd) return "late";
  if (h >= cfg.lunchStart && h < cfg.lunchEnd) return "lunch";
  if (h >= cfg.lunchEnd && h < cfg.lateStart) return "dinner";
  return "morning";
}
const KG = { "ربع": 0.25, "ثلث": 1 / 3, "نص": 0.5, "نصف": 0.5 };
/* كيلوهات المشاوي بالوزن في طلب: «… بالوزن - نص كيلو» × الكمية */
export function kilosOf(items) {
  let kg = 0;
  for (const it of items || []) {
    const m = nz(it && it.name).match(/بالوزن\s*-\s*(?:(ربع|ثلث|نصف|نص)\s*)?كيلو/);
    if (m) kg += (m[1] ? KG[m[1]] : 1) * Math.max(1, Number(it.qty) || 1);
  }
  return Math.round(kg * 100) / 100;
}
/* الاسم الأول — «عبد الله» / «أبو فهد» كلمتين */
export function firstNameOf(name) {
  const w = nz(name).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!w.length) return null;
  if (w.length > 1 && /^(عبد|ابو|أبو|بو)$/.test(w[0])) return `${w[0]} ${w[1]}`;
  return w[0];
}
/* أفضل اسم: حساب الموقع ← نقطة البيع ← الأطول من الكاشير/الطلب/الدليل — المقبول بس (posnames.plausibleName) */
export function pickName(names) {
  const ok = (names || []).filter((x) => x && plausibleName(x.name)).map((x) => ({ src: x.src, name: nz(x.name).replace(/\s+/g, " ").trim() }));
  const by = (s) => ok.filter((x) => x.src === s).sort((a, b) => b.name.length - a.name.length)[0];
  const hit = by("acct") || by("ts") || ok.filter((x) => !["acct", "ts"].includes(x.src)).sort((a, b) => b.name.length - a.name.length)[0];
  return hit ? hit.name : null;
}
const argmax = (counts, order) => { let best = null, bv = 0; for (const k of order) { const v = Number(counts[k]) || 0; if (v > bv) { best = k; bv = v; } } return best; };

/* ملف عميل واحد من بياناته المجمّعة (gather). القيمة (spend_pct/value_tier) والشرايح بتتحط بعدين (applyTier / deriveSegments)
   x = { pn, orders:[{at,total,channel:'pos'|'web'|'apps',app,service,items:[{name,qty}],discount,coupon,reward,fee,km,far,district}],
         names, staff, wa:{stopped,marketingOff,optedOut,invalid,appOnly,optin,inbound,lastIn,ar,en}, mkt, mkt30,
         loyaltyCount, reward:{code,expires}, firstUsed, webDeliv }
   ctx = { cfg, now, trigger, firstLive, loyalty (loyaltyCfgOf) } */
export function computeProfile(x, ctx = {}) {
  const cfg = ctx.cfg || profileCfg({});
  const now = Number(ctx.now) || Date.now();
  const orders = (x.orders || []).filter((o) => o && Number.isFinite(tms(o.at))).sort((a, b) => tms(b.at) - tms(a.at));
  const n = orders.length;
  const last = orders[0] || null, first = orders[n - 1] || null;
  const spend = r2(orders.reduce((s, o) => s + (Number(o.total) || 0), 0));
  const maxT = n ? Math.max(...orders.map((o) => Number(o.total) || 0)) : null;
  const name = pickName(x.names);
  const row = {
    phone_norm: x.pn, v: PROFILE_VERSION, computed_at: new Date(now).toISOString(), trigger: ctx.trigger || null, orders_through: last ? iso(last.at) : null,
    name, first_name: firstNameOf(name), is_staff: Boolean(x.staff),
    orders: n, spend, aov: n ? r2(spend / n) : null, max_ticket: n ? r2(maxT) : null, spend_pct: null, value_tier: null,
  };
  /* الحداثة والتكرار */
  row.first_order_at = first ? iso(first.at) : null;
  row.last_order_at = last ? iso(last.at) : null;
  row.days_since = last ? Math.max(0, Math.floor((now - tms(last.at)) / DAY)) : null;
  row.recency_band = !n ? "none" : row.days_since <= cfg.activeDays ? "active" : row.days_since <= cfg.riskDays ? "at_risk" : row.days_since <= cfg.dormantDays ? "dormant" : "lost";
  row.orders_90d = orders.filter((o) => now - tms(o.at) <= 90 * DAY).length;
  row.avg_gap_days = n >= 2 ? Math.round(((tms(last.at) - tms(first.at)) / DAY / (n - 1)) * 10) / 10 : null;
  row.freq_band = !n ? null : row.orders_90d >= cfg.freqFrequent ? "frequent" : row.orders_90d >= cfg.freqRegular ? "regular" : row.orders_90d >= 2 ? "occasional" : row.orders_90d === 1 ? "once" : "none";
  /* القنوات */
  const ch = { pos: 0, web: 0, apps: 0 }, svc = { delivery: 0, takeaway: 0, dine_in: 0 }, apps = new Set();
  for (const o of orders) {
    if (ch[o.channel] != null) ch[o.channel]++;
    if (o.channel === "apps" && o.app) apps.add(String(o.app));
    if (svc[o.service] != null) svc[o.service]++;
  }
  row.pos_orders = ch.pos; row.web_orders = ch.web; row.app_orders = ch.apps;
  row.main_channel = n ? argmax(ch, ["web", "pos", "apps"]) : null;
  row.app_names = apps.size ? [...apps].sort().join(",") : null;
  row.service_pref = argmax(svc, ["delivery", "takeaway", "dine_in"]);
  /* الذوق */
  const H = orders.map((o) => ({ at: o.at, total: o.total, names: (o.items || []).map((i) => nz(i && i.name).trim()).filter(Boolean).join("|") }));
  const fav = favDish(H, now);
  row.fav_dish = fav.dish || null;
  row.fav_weight = null;
  if (row.fav_dish) {
    const key = cleanKey(row.fav_dish);
    let best = null, bn = 0;
    for (const [k, c] of rankDishes(H, now).weights) { const i = k.lastIndexOf("|"); if (k.slice(0, i) === key && c > bn) { best = k.slice(i + 1); bn = c; } }
    row.fav_weight = best ? normW(best) : null;
  }
  const gScore = {}, gQty = {}, sub = {}, fam = { grill: 0, box: 0 };
  let dishQty = 0;
  for (const o of orders) {
    const w = 1 / (1 + Math.max(0, (now - tms(o.at)) / DAY) / 30);
    for (const it of o.items || []) {
      const nm = nz(it && it.name).trim(), q = Math.max(1, Number(it && it.qty) || 1);
      if (!nm || !isDishName(nm)) continue;
      const g = foodGroup(nm);
      if (g) { gScore[g] = (gScore[g] || 0) + w * q; gQty[g] = (gQty[g] || 0) + q; dishQty += q; }
      const sc = itemCategory(nm);
      if (!["drinks", "sides", "other"].includes(sc)) sub[sc] = (sub[sc] || 0) + q;
      const f = itemFamily(nm);
      if (f === "grill" || f === "box") fam[f] += q;
    }
  }
  row.fav_category = argmax(gScore, FOOD_GROUPS.map((g) => g.id));
  row.fav_subcat = argmax(sub, Object.keys(ENUM_AR.fav_subcat));
  row.lean = fam.grill + fam.box > 0 ? leanOf(fam.grill, fam.box) : null;
  row.cat_shares = dishQty ? Object.fromEntries(Object.entries(gQty).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, q]) => [g, r2(q / dishQty)])) : null;
  /* المواعيد */
  const dp = { lunch: 0, dinner: 0, late: 0, morning: 0 };
  let we = 0;
  for (const o of orders) {
    const c = riyadhClock(o.at);
    dp[daypartOf(c.hour, cfg)]++;
    if (cfg.weekendDays.includes(c.bizDow)) we++;
  }
  row.late_night_share = n ? r3(dp.late / n) : null;
  row.lunch_share = n ? r3(dp.lunch / n) : null;
  row.dinner_share = n ? r3(dp.dinner / n) : null;
  row.daypart = n ? argmax(dp, ["dinner", "late", "lunch", "morning"]) : null;
  row.weekend_share = n ? r3(we / n) : null;
  row.day_pref = !n ? null : n === 1 ? (we ? "weekend" : "weekday") : row.weekend_share >= cfg.weekendLeanPct / 100 ? "weekend" : we === 0 ? "weekday" : "mixed";
  /* الفاتورة */
  row.big_bill = n ? Number(row.aov) >= cfg.bigBillSar : false;
  row.group_order = n ? (maxT >= cfg.groupOrderSar || orders.filter((o) => Number(o.total) >= cfg.groupTwiceSar).length >= 2 || orders.some((o) => kilosOf(o.items) >= cfg.groupKilos)) : false;
  /* الأسعار */
  const disc = orders.filter((o) => o.discount).length;
  row.coupon_orders = orders.filter((o) => o.coupon && o.coupon !== "FIRST" && !o.reward).length;
  row.used_first = orders.some((o) => o.coupon === "FIRST");
  row.discount_share = n ? r3(disc / n) : null;
  row.price_sensitivity = !n ? null
    : row.coupon_orders >= 2 || (n >= 3 && row.discount_share >= cfg.priceHighPct / 100) ? "high"
    : row.coupon_orders >= 1 || row.used_first || row.discount_share >= 0.5 ? "medium"
    : n >= 2 ? "low" : "unknown";
  row.first_eligible = Boolean(ctx.firstLive) && !x.firstUsed && !(Number(x.webDeliv) > 0);
  /* الولاء */
  const lc = ctx.loyalty || null;
  if (lc && lc.enabled && lc.startedAt) {
    const every = Math.max(2, Number(lc.every) || 5), k = Math.max(0, Number(x.loyaltyCount) || 0), m = k % every;
    row.loyalty_orders = k; row.loyalty_left = m === 0 ? every : every - m;
  } else { row.loyalty_orders = null; row.loyalty_left = null; }
  row.reward_code = x.reward && x.reward.code ? String(x.reward.code) : null;
  row.reward_expires = x.reward && x.reward.expires ? nz(iso(x.reward.expires) || x.reward.expires).slice(0, 10) : null;
  /* التوصيل */
  const dl = orders.filter((o) => o.channel === "web" && o.service === "delivery");
  const ld = dl[0] || null;
  row.delivery_orders = dl.length;
  row.district = ld && ld.district ? nz(ld.district).trim().slice(0, 80) : null;
  row.last_fee = ld ? numOrNull(ld.fee) : null;
  row.last_km = ld && numOrNull(ld.km) != null ? r2(ld.km) : null;
  row.fee_band = !ld ? "none" : ld.far ? "far" : row.last_fee == null ? null : row.last_fee === 0 ? "free" : row.last_fee <= cfg.feeLowSar ? "low" : "high";
  /* التواصل */
  const wa = x.wa || {};
  const en = Number(wa.en) || 0, ar = Number(wa.ar) || 0;
  row.lang = en > ar ? "en" : "ar";
  row.lang_src = en + ar > 0 ? "wa_chat" : "default";
  row.wa_reach = row.is_staff ? "staff" : wa.optedOut ? "opted_out" : (wa.stopped || wa.marketingOff) ? "stopped" : wa.invalid ? "invalid" : wa.appOnly ? "app_only" : "reachable";
  row.wa_optin = Boolean(wa.optin);
  row.wa_chat = Number(wa.inbound) > 0;
  row.wa_last_in_at = wa.lastIn ? iso(wa.lastIn) : null;
  /* آخر رسالة تسويقية */
  const mk = x.mkt || null;
  row.mkt_last_at = mk ? iso(mk.at) : null;
  row.mkt_last_channel = mk ? (mk.channel === "whatsapp" ? "whatsapp" : "sms") : null;
  row.mkt_last_ref = mk ? nz(mk.ref).slice(0, 40) || null : null;
  row.mkt_last_label = mk && mk.label ? nz(mk.label).slice(0, 80) : null;
  row.mkt_last_result = mk ? mktResultOf(mk, orders) : null;
  row.mkt_30d = Number(x.mkt30) || 0;
  row.segments = [];
  return row;
}
/* نتيجة الرسالة: فشلت ⇐ طلب خلال ٧ أيام ⇐ ضغط (رابطه أو زر «أبغى أطلب/ورّني المنيو») ⇐ رد ⇐ قراها ⇐ وصلت ⇐ اتبعتت */
export function mktResultOf(mk, orders) {
  const at = tms(mk && mk.at);
  if (!Number.isFinite(at)) return null;
  if (mk.cloudStatus === "failed") return "failed";
  if ((orders || []).some((o) => { const t = tms(o.at); return t > at && t <= at + 7 * DAY; })) return "ordered";
  if (Number(mk.clicks) > 0 || mk.tapped) return "tapped";
  if (mk.replied) return "replied";
  if (mk.cloudStatus === "read") return "read";
  if (mk.cloudStatus === "delivered") return "delivered";
  return "sent";
}

/* حدود شرايح القيمة من الإنفاق (اللي صرفوا بس): ١٠١ نقطة مئوية + حد A/B/C */
export function tierCuts(spends, cfg) {
  const s = (spends || []).map(Number).filter((v) => v > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = Array.from({ length: 101 }, (_, p) => r2(s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]));
  const at = (pct) => q[Math.max(0, Math.min(100, 100 - pct))];
  return { n: s.length, q, a: at(cfg.tierA), b: at(cfg.tierB), c: at(cfg.tierC), tiers: { A: cfg.tierA, B: cfg.tierB, C: cfg.tierC } };
}
export function pctFromQ(x, q) {
  if (!Array.isArray(q) || q.length !== 101) return null;
  let k = 0;
  for (let p = 0; p <= 100; p++) if (q[p] <= x) k = p + 1;
  return Math.max(0, Math.min(100, k - 1));
}
export function applyTier(row, cuts) {
  if (!row.orders || !(Number(row.spend) > 0)) { row.spend_pct = null; row.value_tier = "none"; return row; }
  if (!cuts) { row.spend_pct = null; row.value_tier = null; return row; }
  row.spend_pct = pctFromQ(Number(row.spend), cuts.q);
  const sp = Number(row.spend);
  row.value_tier = sp >= cuts.a ? "A" : sp >= cuts.b ? "B" : sp >= cuts.c ? "C" : "D";
  return row;
}
export function finalizeProfile(row, { cuts, cfg, now = Date.now() }) {
  applyTier(row, cuts);
  row.segments = deriveSegments(row, cfg, now);
  return row;
}

/* ═══ 🔎 فلتر الاستهداف (صافي) ═════════════════════════════════════════════
   {value_tier:["A","B"], fav_category:["grill"], big_bill:true, late_night_share:{min:0.5}, segments:["late_night"], district:["الروضة"]}
   الاختصار late_night_share_min / _max مقبول. النسب كسور (٠–١). */
export const ENUM_FILTERS = Object.freeze(["value_tier", "recency_band", "freq_band", "main_channel", "service_pref", "fav_category", "fav_subcat", "lean", "daypart", "day_pref",
  "price_sensitivity", "fee_band", "lang", "wa_reach", "mkt_last_result", "mkt_last_channel"]);
export const BOOL_FILTERS = Object.freeze(["big_bill", "group_order", "first_eligible", "used_first", "wa_chat", "wa_optin", "has_reward"]);
export const RANGE_FILTERS = Object.freeze({ orders: [0, 100000], spend: [0, 10000000], aov: [0, 1000000], days_since: [0, 100000], orders_90d: [0, 10000],
  late_night_share: [0, 1], lunch_share: [0, 1], weekend_share: [0, 1], discount_share: [0, 1], loyalty_left: [0, 100], mkt_days: [0, 100000] });
const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => nz(x).trim()).filter(Boolean);
export function normalizeProfileFilter(f) {
  if (f == null || f === "") return { ok: true, filter: {} };
  if (typeof f !== "object" || Array.isArray(f)) return { ok: false, error: ["bad_profile_filter", "فلتر ملف العميل لازم يبقى كائن"] };
  const out = {};
  const bad = (k, why) => ({ ok: false, error: ["bad_profile_filter", `فلتر ملف العميل «${k}»: ${why}`] });
  for (const [k0, v] of Object.entries(f)) {
    const m = /^(.*)_(min|max)$/.exec(k0);
    const k = m && RANGE_FILTERS[m[1]] ? m[1] : k0;
    if (ENUM_FILTERS.includes(k)) {
      const list = [...new Set(asList(v))];
      const allowed = Object.keys(ENUM_AR[k] || {});
      const wrong = list.find((x) => !allowed.includes(x));
      if (wrong) return bad(k, `قيمة مش معروفة «${wrong}»`);
      if (list.length) out[k] = list;
      continue;
    }
    if (BOOL_FILTERS.includes(k)) {
      if (v === true || v === false) out[k] = v; else if (v != null && v !== "") return bad(k, "لازم true أو false");
      continue;
    }
    if (RANGE_FILTERS[k]) {
      const [lo, hi] = RANGE_FILTERS[k];
      const cur = { ...(out[k] || {}) };
      const parts = m && RANGE_FILTERS[m[1]] ? { [m[2]]: v } : v && typeof v === "object" ? { min: v.min, max: v.max } : null;
      if (!parts) return bad(k, "اكتب {min, max}");
      for (const [p, val] of Object.entries(parts)) {
        if (val === null || val === undefined || val === "") continue;
        const x = Number(val);
        if (!Number.isFinite(x) || x < lo || x > hi) return bad(k, `${p === "min" ? "من" : "لحد"} لازم رقم من ${lo} لـ${hi}`);
        cur[p] = x;
      }
      if (cur.min != null && cur.max != null && cur.min > cur.max) return bad(k, "«من» أكبر من «لحد»");
      if (cur.min != null || cur.max != null) out[k] = cur;
      continue;
    }
    if (k === "segments") {
      const list = [...new Set(asList(v))];
      const wrong = list.find((x) => !SEG_IDS.includes(x));
      if (wrong) return bad(k, `شريحة مش معروفة «${wrong}»`);
      if (list.length) out.segments = list;
      continue;
    }
    if (k === "district") {
      const list = [...new Set(asList(v).map((x) => x.slice(0, 80)))].slice(0, 40);
      if (list.length) out.district = list;
      continue;
    }
    return bad(k0, "فلتر مش معروف");
  }
  return { ok: true, filter: out };
}
export function matchProfile(row, filter, now = Date.now()) {
  if (!row) return false;
  for (const [k, v] of Object.entries(filter || {})) {
    if (ENUM_FILTERS.includes(k)) { if (!v.includes(row[k])) return false; continue; }
    if (BOOL_FILTERS.includes(k)) { const val = k === "has_reward" ? Boolean(row.reward_code) : row[k] === true; if (val !== v) return false; continue; }
    if (RANGE_FILTERS[k]) {
      let x;
      if (k === "mkt_days") x = row.mkt_last_at ? Math.floor((now - tms(row.mkt_last_at)) / DAY) : Infinity;      // ماتبعتلوش = بقاله كتير
      else x = row[k] == null || row[k] === "" ? NaN : Number(row[k]);
      if (Number.isNaN(x)) return false;
      if (v.min != null && !(x >= v.min)) return false;
      if (v.max != null && !(x <= v.max)) return false;
      continue;
    }
    if (k === "segments") { if (!(Array.isArray(row.segments) && row.segments.some((s) => v.includes(s)))) return false; continue; }
    if (k === "district") { if (!v.includes(nz(row.district).trim())) return false; continue; }
    return false;
  }
  return true;
}

/* ═══ 🧩 قيم الرسالة لكل مستلم (صافي) ══════════════════════════════════════ */
export const PROFILE_TOKENS = Object.freeze([
  { key: "first_name", label: "الاسم الأول («عميلنا» لو مفيش اسم)", example: "محمد" },
  { key: "fav_dish", label: "طبقه المفضّل", example: "كريب زنجر سوبريم" },
  { key: "fav_dish_weight", label: "طبقه المفضّل بوزنه المعتاد", example: "كباب مشوي نص كيلو" },
  { key: "fav_category", label: "نوع أكله", example: "مشاوي" },
  { key: "fav_box", label: "بوكس فيه طبقه (من البوكسات الشغّالة وقت الحملة)", example: "بوكس الكريب الفردي" },
  { key: "fee_line", label: "سطر التوصيل (من غير أرقام رسوم)", example: "ونوصله لك أو تستلمه من فرعنا، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من 60 ر.س" },
  { key: "loyalty_line", label: "رصيد ولاء الموقع", example: "باقي لك طلب واحد من الموقع وتكسب توصيل مجاني" },
]);
export const PROFILE_TOKEN_KEYS = Object.freeze(PROFILE_TOKENS.map((t) => t.key));
export const tokensOf = (s) => [...nz(s).matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
export function profileTokensIn(values) {
  const all = new Set();
  for (const v of Object.values(values && typeof values === "object" ? values : {})) for (const t of tokensOf(v)) all.add(t);
  return [...all];
}
/* بوكس شغّال (مش باقة جمعات) فيه طبقه — الفردي قبل اللي لشخصين قبل المشاركة، والمميّز، والأرخص */
export function favBoxFor(dish, live) {
  if (!dish || !live || !live.byClean || !live.boxes) return null;
  const it = live.byClean.get(cleanKey(dish));
  if (!it || it.soldOut) return null;
  const rank = { solo: 0, duo: 1, share: 2 };
  const cand = [];
  for (const b of live.boxes.values()) if (b.tier !== "group" && inBox(b, it.id) && boxLive(b, live)) cand.push(b);
  cand.sort((a, b) => (rank[a.tier] ?? 9) - (rank[b.tier] ?? 9) || (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || a.price - b.price || (a.slug < b.slug ? -1 : 1));
  return cand[0] || null;
}
/* سطر التوصيل من غير رقم رسوم — نفس صياغة FD1 (wafavpick.deliveryLine من غير عنوان مؤكد) */
export function feeLineOf(row, tctx = {}) {
  if (row && row.first_eligible === true && tctx.firstLive) {
    const min = Math.max(0, Number(tctx.firstMin) || 0);
    return { text: deliveryLine({ price: Math.max(0, min - 1), located: false, firstElig: true, firstMin: min, webOrders: Number(row.web_orders) || 0 }).text, firstHint: true };
  }
  return { text: deliveryLine({ price: 0, located: false }).text, firstHint: false };
}
export function loyaltyLineOf(left, lc) {
  const n = Math.max(1, Math.round(Number(left) || 0));
  const prize = lc && lc.reward === "percent" ? `خصم ${Number(lc.percent) || 10}٪` : "توصيل مجاني";
  const min = lc && Number(lc.minTotal) > 0 ? ` للطلبات من ${Number(lc.minTotal)} ر.س` : "";
  const count = n === 1 ? "طلب واحد" : n === 2 ? "طلبين" : n <= 10 ? `${n} طلبات` : `${n} طلب`;
  return `باقي لك ${count} من الموقع وتكسب ${prize}${min}`;
}
export function tokenValue(t, row, tctx = {}) {
  const no = (why) => ({ ok: false, why });
  if (!row) return no("no_profile");
  switch (t) {
    case "first_name": return { ok: true, value: row.first_name || "عميلنا" };
    case "fav_dish": return row.fav_dish ? { ok: true, value: row.fav_dish } : no("no_fav_dish");
    case "fav_dish_weight": return row.fav_dish ? { ok: true, value: row.fav_weight ? `${row.fav_dish} ${showW(row.fav_weight)}` : row.fav_dish } : no("no_fav_dish");
    case "fav_category": { const g = foodGroupOf(row.fav_category); return g ? { ok: true, value: g.label } : no("no_category"); }
    case "fav_box": {
      if (!tctx.live) return no("catalog_unavailable");
      const b = favBoxFor(row.fav_dish, tctx.live);
      return b ? { ok: true, value: latinDigits(b.name), uses: { box: b.slug } } : no("no_box");
    }
    case "fee_line": { const f = feeLineOf(row, tctx); return { ok: true, value: f.text, uses: f.firstHint ? { firstHint: true } : {} }; }
    case "loyalty_line": {
      const lc = tctx.loyalty;
      if (!(lc && lc.enabled && lc.startedAt) || row.loyalty_left == null || !(Number(row.loyalty_orders) > 0)) return no("no_loyalty");
      return { ok: true, value: loyaltyLineOf(row.loyalty_left, lc), uses: { loy: Number(row.loyalty_left) } };
    }
    default: return no("unknown_token");
  }
}
/* values = {مسار الخانة: نص فيه {token}} ⇒ {ok, values:{المسار: النص بقيم العميل}, uses} أو {ok:false, why}
   الخانات من غير token مابتترجعش (قيمة الحملة نفسها بتتبعت). */
export function resolveProfileValues(values, row, tctx = {}) {
  const out = {}, uses = {};
  for (const [path, tpl] of Object.entries(values && typeof values === "object" ? values : {})) {
    const toks = tokensOf(tpl);
    if (!toks.length) continue;
    let text = nz(tpl);
    for (const t of [...new Set(toks)]) {
      const r = tokenValue(t, row, tctx);
      if (!r.ok) return { ok: false, why: `${t}:${r.why}` };
      if (r.uses) Object.assign(uses, r.uses);
      text = text.split(`{${t}}`).join(r.value);
    }
    text = text.replace(/[ \t]{2,}/g, " ").trim();
    const max = (tctx.fieldMax && Number(tctx.fieldMax[path])) || 200;
    if (!text) return { ok: false, why: `${path}:empty` };
    if ([...text].length > max) return { ok: false, why: `${path}:too_long` };
    if (/[\n\t]/.test(text) || /\{[a-z_]+\}/.test(text)) return { ok: false, why: `${path}:bad_text` };
    out[path] = text;
  }
  return { ok: true, values: out, uses };
}
/* إرسال تجربة: نفس الخانات بقيم المثال (رقم تجربة بس) */
export function exampleProfileValues(values) {
  const ex = Object.fromEntries(PROFILE_TOKENS.map((t) => [t.key, t.example]));
  const out = {};
  for (const [path, tpl] of Object.entries(values && typeof values === "object" ? values : {})) {
    if (!tokensOf(tpl).length) continue;
    out[path] = nz(tpl).replace(/\{([a-z_]+)\}/g, (m0, k) => (ex[k] != null ? ex[k] : m0)).replace(/[ \t]{2,}/g, " ").trim();
  }
  return out;
}

/* ═══ 🗄 الجدول ════════════════════════════════════════════════════════════ */
/* [العمود، النوع في Postgres، شكله في JS] — نفس الترتيب في الجدول؛ عمود جديد = سطر هنا (ALTER … ADD COLUMN IF NOT EXISTS) */
export const PROFILE_COLS = Object.freeze([
  ["phone_norm", "TEXT", "text"], ["v", "SMALLINT", "int"], ["computed_at", "TIMESTAMPTZ", "ts"], ["trigger", "TEXT", "text"], ["orders_through", "TIMESTAMPTZ", "ts"],
  ["name", "TEXT", "text"], ["first_name", "TEXT", "text"], ["is_staff", "BOOLEAN", "bool"],
  ["orders", "INT", "int"], ["spend", "NUMERIC(12,2)", "num"], ["aov", "NUMERIC(10,2)", "num"], ["max_ticket", "NUMERIC(10,2)", "num"], ["spend_pct", "SMALLINT", "int"], ["value_tier", "TEXT", "text"],
  ["first_order_at", "TIMESTAMPTZ", "ts"], ["last_order_at", "TIMESTAMPTZ", "ts"], ["days_since", "INT", "int"], ["recency_band", "TEXT", "text"],
  ["orders_90d", "INT", "int"], ["avg_gap_days", "NUMERIC(7,1)", "num"], ["freq_band", "TEXT", "text"],
  ["pos_orders", "INT", "int"], ["web_orders", "INT", "int"], ["app_orders", "INT", "int"], ["main_channel", "TEXT", "text"], ["app_names", "TEXT", "text"], ["service_pref", "TEXT", "text"],
  ["fav_category", "TEXT", "text"], ["fav_subcat", "TEXT", "text"], ["fav_dish", "TEXT", "text"], ["fav_weight", "TEXT", "text"], ["lean", "TEXT", "text"], ["cat_shares", "JSONB", "json"],
  ["late_night_share", "NUMERIC(4,3)", "num"], ["lunch_share", "NUMERIC(4,3)", "num"], ["dinner_share", "NUMERIC(4,3)", "num"], ["daypart", "TEXT", "text"],
  ["weekend_share", "NUMERIC(4,3)", "num"], ["day_pref", "TEXT", "text"],
  ["big_bill", "BOOLEAN", "bool"], ["group_order", "BOOLEAN", "bool"],
  ["coupon_orders", "INT", "int"], ["discount_share", "NUMERIC(4,3)", "num"], ["used_first", "BOOLEAN", "bool"], ["price_sensitivity", "TEXT", "text"], ["first_eligible", "BOOLEAN", "bool"],
  ["loyalty_orders", "INT", "int"], ["loyalty_left", "INT", "int"], ["reward_code", "TEXT", "text"], ["reward_expires", "DATE", "date"],
  ["delivery_orders", "INT", "int"], ["district", "TEXT", "text"], ["last_fee", "NUMERIC(8,2)", "num"], ["last_km", "NUMERIC(7,2)", "num"], ["fee_band", "TEXT", "text"],
  ["lang", "TEXT", "text"], ["lang_src", "TEXT", "text"], ["wa_reach", "TEXT", "text"], ["wa_optin", "BOOLEAN", "bool"], ["wa_chat", "BOOLEAN", "bool"], ["wa_last_in_at", "TIMESTAMPTZ", "ts"],
  ["mkt_last_at", "TIMESTAMPTZ", "ts"], ["mkt_last_channel", "TEXT", "text"], ["mkt_last_ref", "TEXT", "text"], ["mkt_last_label", "TEXT", "text"], ["mkt_last_result", "TEXT", "text"], ["mkt_30d", "INT", "int"],
  ["segments", "TEXT[]", "arr"],
]);
export const PROFILE_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS cust_profile (phone_norm TEXT PRIMARY KEY)",
  ...PROFILE_COLS.slice(1).map(([c, t]) => `ALTER TABLE cust_profile ADD COLUMN IF NOT EXISTS ${c} ${t}`),
  `CREATE TABLE IF NOT EXISTS cust_profile_state (id INT PRIMARY KEY DEFAULT 1, ts_cursor TIMESTAMPTZ, src_cursor TIMESTAMPTZ, shop_cursor TIMESTAMPTZ,
     cuts JSONB, full_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  "INSERT INTO cust_profile_state(id) VALUES (1) ON CONFLICT DO NOTHING",
  `CREATE TABLE IF NOT EXISTS cust_profile_runs (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), trigger TEXT NOT NULL,
     phones INT NOT NULL DEFAULT 0, ms INT, ok BOOLEAN NOT NULL DEFAULT TRUE, error TEXT, counts JSONB)`,
  "CREATE INDEX IF NOT EXISTS cust_profile_runs_at_idx ON cust_profile_runs(at DESC)",
]);
export const PROFILE_UPSERT_SQL = `INSERT INTO cust_profile SELECT * FROM jsonb_populate_recordset(NULL::cust_profile, $1::jsonb)
  ON CONFLICT (phone_norm) DO UPDATE SET ${PROFILE_COLS.slice(1).map(([c]) => `${c} = EXCLUDED.${c}`).join(", ")}`;
const KIND = Object.fromEntries(PROFILE_COLS.map(([c, , k]) => [c, k]));
/* صف من Postgres ⇒ JS (NUMERIC بيرجع نص، والتواريخ Date) */
export function fromDb(r) {
  if (!r) return null;
  const out = {};
  for (const [c, v] of Object.entries(r)) {
    const k = KIND[c];
    if (v == null) { out[c] = k === "arr" ? [] : null; continue; }
    out[c] = k === "num" || k === "int" ? Number(v) : k === "ts" ? iso(v) : k === "date" ? (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : nz(v).slice(0, 10)) : v;
  }
  return out;
}
/* صف للعرض في اللوحة: القيم + التسميات */
export function profileView(row, cfg) {
  if (!row) return null;
  const segs = new Set(row.segments || []);
  return { fields: Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, row[f.key] ?? null])),
    segments: segmentsView(cfg).filter((s) => segs.has(s.id)),
    computedAt: row.computed_at, trigger: row.trigger, ordersThrough: row.orders_through, version: row.v, isStaff: Boolean(row.is_staff) };
}

/* ═══ 🔧 التشغيل ═══════════════════════════════════════════════════════════ */
const NOT_VOID = "(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))";
const POS_PN = "COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,''))";
export const GATHER_SQL = Object.freeze({
  /* $1 = الجوالات (أو من غير فلتر للكل). مرايا طلبات الموقع (order_sources.source='website') بره — طلب الموقع نفسه في shop_orders */
  pos: (all) => `SELECT ${POS_PN} AS pn, o.order_id, o.order_date AS at, o.total, o.discount_incl, o.order_type, o.order_option, o.payments, s.source, s.source_note,
      COALESCE((SELECT json_agg(json_build_object('name', i.name, 'qty', i.qty) ORDER BY i.idx) FROM ts_order_items i WHERE i.order_id = o.order_id), '[]'::json) AS items
    FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
   WHERE ${all ? `${POS_PN} ~ '${PHONE_RE}'` : "(s.phone_norm = ANY($1::text[]) OR tc.phone_norm = ANY($1::text[]))"} AND ${NOT_VOID} AND COALESCE(s.source, '') <> 'website'`,
  web: (all) => `SELECT so.phone_norm AS pn, so.order_no, so.created_at AS at, so.total, so.discount_amount, so.coupon, so.option, so.items, so.pos_order_id,
      COALESCE(so.table_no, 0) AS table_no,
      CASE WHEN jsonb_typeof(so.delivery_quote) = 'object' THEN so.delivery_quote->>'fee' END AS q_fee,
      CASE WHEN jsonb_typeof(so.delivery_quote) = 'object' THEN so.delivery_quote->>'routeKm' END AS q_km,
      COALESCE(jsonb_typeof(so.delivery_quote) = 'object' AND jsonb_typeof(so.delivery_quote->'farZone') = 'object', false) AS q_far,
      CASE WHEN jsonb_typeof(so.address) = 'object' THEN NULLIF(btrim(COALESCE(so.address->>'district', so.address->>'area', '')), '') END AS district
    FROM shop_orders so WHERE ${shopPaidSql("so")} AND ${all ? `so.phone_norm ~ '${PHONE_RE}'` : "so.phone_norm = ANY($1::text[])"}`,
  universe: `SELECT phone_norm AS pn FROM cms_contacts WHERE phone_norm ~ '${PHONE_RE}' UNION SELECT phone_norm FROM acct_customers WHERE phone_norm ~ '${PHONE_RE}'`,
  names: `SELECT pn, src, name FROM (
      SELECT phone_norm pn, 'acct' src, name FROM acct_customers WHERE phone_norm = ANY($1::text[])
      UNION ALL SELECT phone_norm, 'ts', name FROM ts_customers WHERE phone_norm = ANY($1::text[])
      UNION ALL SELECT phone_norm, 'cashier', customer_name FROM order_sources WHERE phone_norm = ANY($1::text[])
      UNION ALL SELECT phone_norm, 'web', customer->>'name' FROM shop_orders WHERE phone_norm = ANY($1::text[])
      UNION ALL SELECT phone_norm, 'contact', name FROM cms_contacts WHERE phone_norm = ANY($1::text[])
    ) x WHERE COALESCE(btrim(name), '') <> ''`,
  optins: "SELECT phone_norm pn, stopped_at, marketing_off_at, marketing FROM wa_optins WHERE phone_norm = ANY($1::text[])",
  contacts: "SELECT phone_norm pn, opted_out_at, is_staff, is_test FROM cms_contacts WHERE phone_norm = ANY($1::text[])",
  invalid: "SELECT phone_norm pn FROM wa_invalid_numbers WHERE phone_norm = ANY($1::text[])",
  inbound: `SELECT phone_norm pn, count(*)::int n, max(created_at) last_in FROM wa_messages
     WHERE direction = 'in' AND COALESCE(source, 'api') <> 'history' AND phone_norm = ANY($1::text[]) GROUP BY 1`,
  langs: `SELECT phone_norm pn, count(*) FILTER (WHERE lang = 'en')::int en, count(*) FILTER (WHERE lang = 'ar')::int ar FROM wa_bot_log
     WHERE phone_norm = ANY($1::text[]) AND lang IS NOT NULL GROUP BY 1`,
  /* آخر رسالة تسويقية لكل رقم: حملات واتساب + حملات وأتمتة SMS. $2/$3 = نص زرَّي الرد «أبغى أطلب» / «ورّني المنيو» */
  mkt: `WITH m AS (
      SELECT q.phone_norm pn, q.sent_at at, 'whatsapp' ch, 'wa:' || q.job_id ref, j.name label, q.cloud_status cs, (q.replied_at IS NOT NULL) replied,
             COALESCE(q.clicks, 0) clicks, EXISTS (SELECT 1 FROM wa_replies r WHERE r.queue_id = q.id AND btrim(r.text) IN ($2, $3)) tapped
        FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id
       WHERE q.status = 'sent' AND q.sent_at IS NOT NULL AND q.phone_norm = ANY($1::text[])
      UNION ALL
      SELECT cs.phone_norm, cs.created_at, 'sms', 'sms:' || cs.campaign_id, cm.name, NULL, false, 0, false
        FROM cms_campaign_sends cs LEFT JOIN cms_campaigns cm ON cm.id = cs.campaign_id WHERE cs.status = 'sent' AND cs.phone_norm = ANY($1::text[])
      UNION ALL
      SELECT f.phone_norm, f.created_at, 'sms', 'flow:' || f.flow_id, fl.name, NULL, false, COALESCE(f.clicks, 0), false
        FROM cms_flow_sends f LEFT JOIN cms_flows fl ON fl.id = f.flow_id WHERE f.status = 'sent' AND f.phone_norm = ANY($1::text[])
    )
    , n AS (SELECT pn, count(*)::int n30 FROM m WHERE at > NOW() - interval '30 days' GROUP BY pn)
    SELECT DISTINCT ON (m.pn) m.pn, m.at, m.ch, m.ref, m.label, m.cs, m.replied, m.clicks, m.tapped, COALESCE(n.n30, 0) AS n30
      FROM m LEFT JOIN n ON n.pn = m.pn ORDER BY m.pn, m.at DESC`,
  loyaltyCount: `SELECT phone_norm pn, count(*)::int n FROM shop_orders WHERE ${LOYALTY_COUNTED_SQL} AND phone_norm = ANY($1::text[]) AND created_at >= $2::timestamptz GROUP BY 1`,
  rewardCodes: "SELECT phone_norm pn, upper(coupon) code FROM cms_loyalty WHERE phone_norm = ANY($1::text[])",
  /* مكافأة ولاء لسه صالحة (نفس شروط FAV_SQL.rewards / waassist.rewardsOf) — الأقرب انتهاءً */
  rewards: `SELECT DISTINCT ON (l.phone_norm) l.phone_norm pn, s.code, to_char(s.expires_at, 'YYYY-MM-DD') AS expires
      FROM cms_loyalty l JOIN shop_coupons s ON s.code = l.coupon
     WHERE l.phone_norm = ANY($1::text[]) AND s.active AND s.used_count < COALESCE(s.max_uses, 1) AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND (s.phone_norm IS NULL OR s.phone_norm = l.phone_norm)
       AND NOT EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm = l.phone_norm AND o.coupon = s.code AND o.status NOT IN ('pending_payment','expired'))
     ORDER BY l.phone_norm, s.expires_at NULLS LAST`,
});
/* اتجميع لكل رقم من صفوف الاستعلامات (صافي — للاختبار) */
export function assemble({ pns, pos = [], web = [], names = [], optins = [], contacts = [], invalid = [], appOnly = [], inbound = [], langs = [], mkt = [],
  loyalty = [], rewards = [], rewardCodes = [], firstUsed = [], webAgg = [], staffSet = new Set() }) {
  const want = new Set(pns);
  const by = (rows) => { const m = new Map(); for (const r of rows || []) { if (!want.has(r.pn)) continue; if (!m.has(r.pn)) m.set(r.pn, []); m.get(r.pn).push(r); } return m; };
  const one = (rows) => { const m = new Map(); for (const r of rows || []) if (want.has(r.pn) && !m.has(r.pn)) m.set(r.pn, r); return m; };
  const set = (rows) => new Set((rows || []).map((r) => r.pn));
  const P = by(pos), W = by(web), N = by(names), O = one(optins), C = one(contacts), I = set(invalid), A = set(appOnly), IN = one(inbound), L = one(langs), M = one(mkt),
    LC = one(loyalty), RW = one(rewards), FU = set(firstUsed), WA = one(webAgg), RC = by(rewardCodes);
  const out = new Map();
  for (const pn of want) {
    const codes = new Set((RC.get(pn) || []).map((r) => nz(r.code).toUpperCase()));
    const posO = (P.get(pn) || []).map((o) => {
      const raw = posChannel(o);
      const channel = raw === "inhouse" ? "pos" : raw === "website" ? "web" : "apps";
      const opt = nz(o.order_option).toLowerCase();
      const service = channel === "apps" ? "delivery" : /deliver|توصيل/.test(opt) ? "delivery" : /dine|صالة/.test(opt) ? "dine_in" : /take|away|استلام|سفري/.test(opt) ? "takeaway" : null;
      return { id: String(o.order_id), at: o.at, total: Number(o.total) || 0, rawChannel: raw, channel, app: channel === "apps" ? raw : null, service,
        items: (Array.isArray(o.items) ? o.items : []).map((i) => ({ name: nz(i && i.name), qty: Number(i && i.qty) || 1 })), discount: Number(o.discount_incl) > 0, coupon: null, reward: false };
    });
    const webO = (W.get(pn) || []).map((o) => {
      const cpn = nz(o.coupon).trim().toUpperCase() || null;
      const items = (Array.isArray(o.items) ? o.items : []).filter((i) => i && typeof i === "object").map((i) => {
        const base = nz(i.name || i.product_name).trim(), vr = nz(i.variant_name || i.variant).trim();
        return { name: vr ? `${base} - ${vr}` : base, qty: Number(i.quantity ?? i.qty) || 1 };
      });
      return { orderNo: o.order_no, posOrderId: o.pos_order_id, at: o.at, total: Number(o.total) || 0, channel: "web", app: null,
        service: Number(o.table_no) > 0 ? "dine_in" : o.option === "delivery" ? "delivery" : o.option === "pickup" ? "takeaway" : null,
        items, discount: Boolean(cpn) || Number(o.discount_amount) > 0, coupon: cpn, reward: Boolean(cpn) && (codes.has(cpn) || /^FC[0-9A-F]{8}$/.test(cpn)),
        fee: numOrNull(o.q_fee), km: numOrNull(o.q_km), far: o.q_far === true, district: o.district || null };
    });
    /* طلب الموقع اللي نزل نقطة البيع كـExternal/QR بيتعدّ مرة (نفس قاعدة ملف العميل) */
    const dup = matchWebToPos(webO, posO.map((p) => ({ id: p.id, at: p.at, total: p.total, channel: p.rawChannel, void: false })));
    const orders = [...webO, ...posO.filter((p) => !dup.has(p.id))];
    const o = O.get(pn) || {}, c = C.get(pn) || {}, ib = IN.get(pn) || {}, lg = L.get(pn) || {}, mk = M.get(pn) || null, rw = RW.get(pn) || null, wa = WA.get(pn) || {};
    out.set(pn, {
      pn, orders, names: N.get(pn) || [],
      staff: staffSet.has(pn) || c.is_staff === true || c.is_test === true,
      wa: { stopped: Boolean(o.stopped_at), marketingOff: Boolean(o.marketing_off_at), optin: o.marketing === true, optedOut: Boolean(c.opted_out_at),
        invalid: I.has(pn), appOnly: A.has(pn), inbound: Number(ib.n) || 0, lastIn: ib.last_in || null, ar: Number(lg.ar) || 0, en: Number(lg.en) || 0 },
      mkt: mk ? { at: mk.at, channel: mk.ch, ref: mk.ref, label: mk.label, cloudStatus: mk.cs, replied: mk.replied === true, clicks: Number(mk.clicks) || 0, tapped: mk.tapped === true } : null,
      mkt30: mk ? Number(mk.n30) || 0 : 0,
      loyaltyCount: Number((LC.get(pn) || {}).n) || 0,
      reward: rw ? { code: rw.code, expires: rw.expires || null } : null,
      firstUsed: FU.has(pn), webDeliv: Number(wa.deliv) || 0,
    });
  }
  return out;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;
  const now = deps.now || (() => Date.now());
  const whoami = deps.whoami || (async () => null);
  const c360 = () => { try { return (typeof deps.c360 === "function" ? deps.c360() : deps.c360) || null; } catch { return null; } };
  const liveSrc = () => { try { return (typeof deps.live === "function" ? deps.live() : deps.live) || null; } catch { return null; } };
  const settingsNow = async () => { try { return (await getSettingsData()) || {}; } catch { return {}; } };
  const bad = (c, error, message, status = 400, extra = {}) => c.json({ ok: false, error, message, ...extra }, status);

  const ready = (async () => { for (const sql of PROFILE_DDL) await pool.query(sql); })()
    .then(() => log.log?.("[custprofile] ready"))
    .catch((e) => { log.error?.(`[custprofile] schema: ${e.message}`); });

  /* جدول مش موجود (قاعدة جديدة/اختبار) = مفيش صفوف منه؛ أي غلطة تانية = الحساب يفشل (مفيش ملف ناقص يتكتب) */
  const rows = async (sql, params = []) => {
    try { return (await pool.query(sql, params)).rows || []; }
    catch (e) { if (e && e.code === "42P01") return []; throw e; }
  };

  async function gather(pnsIn) {
    const all = !pnsIn;
    const P = all ? [] : [pnsIn];
    const [pos, web] = await Promise.all([rows(GATHER_SQL.pos(all), P), rows(GATHER_SQL.web(all), P)]);
    let pns = pnsIn ? [...new Set(pnsIn)] : null;
    if (all) pns = [...new Set([...pos.map((r) => r.pn), ...web.map((r) => r.pn), ...(await rows(GATHER_SQL.universe)).map((r) => r.pn)])];
    pns = (pns || []).filter((p) => /^5\d{8}$/.test(nz(p)));
    if (!pns.length) return new Map();
    const s = await settingsNow();
    const lc = loyaltyCfgOf(s);
    const L = [pns];
    const [names, optins, contacts, invalid, appOnly, inbound, langs, mkt, loyalty, rewards, rewardCodes, firstUsed, webAgg] = await Promise.all([
      rows(GATHER_SQL.names, L), rows(GATHER_SQL.optins, L), rows(GATHER_SQL.contacts, L), rows(GATHER_SQL.invalid, L), rows(appOnlyPhonesSql("$1"), L),
      rows(GATHER_SQL.inbound, L), rows(GATHER_SQL.langs, L), rows(GATHER_SQL.mkt, [pns, ORDER_BUTTON, MENU_BUTTON]),
      lc.enabled && lc.startedAt ? rows(GATHER_SQL.loyaltyCount, [pns, lc.startedAt]) : [],
      rows(GATHER_SQL.rewards, L), rows(GATHER_SQL.rewardCodes, L), rows(FAV_SQL.firstUsed, L), rows(FAV_SQL.web, L),
    ]);
    const staffSet = new Set([...teamPhoneSet(s), ...((s.waBot || {}).testPhones || []).map((t) => nz(t && typeof t === "object" ? t.phone : t).replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""))]);
    return assemble({ pns, pos, web, names, optins, contacts, invalid, appOnly, inbound, langs, mkt, loyalty, rewards, rewardCodes, firstUsed, webAgg, staffSet });
  }
  async function firstState() {
    const f = (await rows(FAV_SQL.first))[0] || null;
    const t = now();
    const live = Boolean(f && f.active && f.free_delivery && !(Number(f.percent) > 0) && !(f.expires_at && new Date(f.expires_at).getTime() < new Date(new Date(t).toDateString()).getTime()));
    return { firstLive: live, firstMin: f ? Number(f.min_total) || 0 : 0 };
  }
  async function stateRow() { await ready; return (await rows("SELECT * FROM cust_profile_state WHERE id=1"))[0] || {}; }
  async function cutsNow(cfg) {
    const st = await stateRow();
    if (st.cuts && Array.isArray(st.cuts.q)) return st.cuts;
    const sp = (await rows("SELECT spend FROM cust_profile WHERE spend > 0")).map((r) => Number(r.spend));
    return tierCuts(sp, cfg);
  }
  async function upsert(list) {
    for (let i = 0; i < list.length; i += 400) await pool.query(PROFILE_UPSERT_SQL, [JSON.stringify(list.slice(i, i + 400))]);
  }
  async function logRun(trigger, { phones = 0, ms = null, ok = true, error = null, counts = null } = {}) {
    await pool.query("INSERT INTO cust_profile_runs(trigger, phones, ms, ok, error, counts) VALUES ($1,$2,$3,$4,$5,$6)",
      [trigger, phones, ms, ok, error ? String(error).slice(0, 300) : null, counts ? JSON.stringify(counts) : null]).catch(() => {});
    if (Math.random() < 0.05) pool.query("DELETE FROM cust_profile_runs WHERE at < NOW() - interval '30 days'").catch(() => {});
  }

  /* الحساب: pns = null ⇒ الكل (والحدود بتتحسب من جديد). بيرجّع {phones, ms} */
  async function rebuild(pns = null, trigger = "manual") {
    await ready;
    const t0 = Date.now();
    try {
      const s = await settingsNow();
      const cfg = profileCfg(s);
      const [byPn, fs] = await Promise.all([gather(pns), firstState()]);
      const T = now();
      const ctxP = { cfg, now: T, trigger, firstLive: fs.firstLive, loyalty: loyaltyCfgOf(s) };
      const list = [...byPn.values()].map((x) => computeProfile(x, ctxP));
      const cuts = !pns ? tierCuts(list.map((r) => r.spend), cfg) : await cutsNow(cfg);
      for (const r of list) finalizeProfile(r, { cuts, cfg, now: T });
      if (list.length) await upsert(list);
      /* الحدود الجديدة + «آخر حساب كامل» بعد ما الصفوف اتكتبت بس — لو الكتابة وقعت، الليلي بيعيد في نفس الساعة */
      if (!pns) await pool.query("UPDATE cust_profile_state SET cuts=$1, full_at=NOW(), updated_at=NOW() WHERE id=1", [cuts ? JSON.stringify(cuts) : null]);
      const ms = Date.now() - t0;
      if (!pns || list.length) {
        const counts = !pns ? { tiers: countBy(list, "value_tier"), recency: countBy(list, "recency_band"), reach: countBy(list, "wa_reach"),
          segments: Object.fromEntries(SEG_IDS.map((id) => [id, list.filter((r) => r.segments.includes(id)).length])) } : null;
        await logRun(trigger, { phones: list.length, ms, counts });
      }
      if (!pns) log.log?.(`[custprofile] ${trigger}: ${list.length} ملف في ${ms} ms`);
      return { ok: true, phones: list.length, ms };
    } catch (e) {
      log.error?.(`[custprofile] ${trigger} failed: ${e.message}`);
      await logRun(trigger, { phones: 0, ms: Date.now() - t0, ok: false, error: e.message });
      return { ok: false, error: e.message };
    }
  }
  const countBy = (list, k) => { const o = {}; for (const r of list) { const v = r[k] == null ? "—" : r[k]; o[v] = (o[v] || 0) + 1; } return o; };
  /* واحد بس في المرة جوّه الحاوية؛ والحساب الكامل كمان بقفل Postgres (حاويتين وقت النشر) */
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  async function fullLocked(trigger) {
    if (typeof pool.connect !== "function") return rebuild(null, trigger);
    const cl = await pool.connect();
    try {
      const got = (await cl.query("SELECT pg_try_advisory_lock(hashtext('cust_profile_full')) AS ok")).rows[0];
      if (!got || !got.ok) return { ok: false, skipped: "locked" };
      try { return await rebuild(null, trigger); }
      finally { await cl.query("SELECT pg_advisory_unlock(hashtext('cust_profile_full'))").catch(() => {}); }
    } finally { cl.release(); }
  }
  const full = (trigger) => serial(() => fullLocked(trigger));
  const some = (pns, trigger) => serial(() => rebuild(pns, trigger));

  /* بعد كل طلب مدفوع: الحدث (order_paid) + تأخير ٢٠ ث يجمّع الطلبات اللي ورا بعض */
  const pending = new Set();
  let pendTimer = null;
  function schedule(pn, delayMs = 20_000) {
    if (!/^5\d{8}$/.test(nz(pn))) return;
    pending.add(pn);
    if (pendTimer) return;
    pendTimer = setTimeout(() => {
      pendTimer = null;
      const list = [...pending]; pending.clear();
      some(list, "order").catch(() => {});
    }, delayMs);
    pendTimer.unref?.();
  }
  /* المسح الاحتياطي: اللي اتحدّث في نقطة البيع (طلب/جوال الكاشير) أو الموقع من آخر مسح */
  async function sweep() {
    await ready;
    const st = await stateRow();
    if (!st.ts_cursor || !st.src_cursor || !st.shop_cursor) {
      await pool.query("UPDATE cust_profile_state SET ts_cursor = COALESCE(ts_cursor, NOW()), src_cursor = COALESCE(src_cursor, NOW()), shop_cursor = COALESCE(shop_cursor, NOW()), updated_at = NOW() WHERE id=1");
      return { phones: 0, init: true };
    }
    const [a, b, d] = await Promise.all([
      rows(`SELECT COALESCE(array_agg(DISTINCT x.pn) FILTER (WHERE x.pn ~ '${PHONE_RE}'), '{}') AS pns, max(x.at) AS mx FROM (
              SELECT ${POS_PN} pn, o.updated_at at FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
               WHERE o.updated_at > $1) x`, [st.ts_cursor]),
      rows(`SELECT COALESCE(array_agg(DISTINCT phone_norm) FILTER (WHERE phone_norm ~ '${PHONE_RE}'), '{}') AS pns, max(filled_at) AS mx FROM order_sources WHERE filled_at > $1`, [st.src_cursor]),
      rows(`SELECT COALESCE(array_agg(DISTINCT phone_norm) FILTER (WHERE phone_norm ~ '${PHONE_RE}'), '{}') AS pns, max(updated_at) AS mx FROM shop_orders WHERE updated_at > $1`, [st.shop_cursor]),
    ]);
    const pns = [...new Set([...(a[0]?.pns || []), ...(b[0]?.pns || []), ...(d[0]?.pns || [])])];
    if (pns.length) {
      const r = await some(pns, "sweep");
      if (!r || !r.ok) return { phones: 0, error: (r && r.error) || "rebuild_failed" };      // المؤشر مايتقدّمش ⇒ المسح الجاي بيعيدهم
    }
    await pool.query(`UPDATE cust_profile_state SET ts_cursor = GREATEST(ts_cursor, COALESCE($1::timestamptz, ts_cursor)), src_cursor = GREATEST(src_cursor, COALESCE($2::timestamptz, src_cursor)),
        shop_cursor = GREATEST(shop_cursor, COALESCE($3::timestamptz, shop_cursor)), updated_at = NOW() WHERE id=1`, [a[0]?.mx || null, b[0]?.mx || null, d[0]?.mx || null]);
    return { phones: pns.length };
  }

  /* ── القراية للموديولات التانية (wasender / customer360) ── */
  async function profilesFor(pns) {
    await ready;
    const list = [...new Set((pns || []).filter((p) => /^5\d{8}$/.test(nz(p))))];
    if (!list.length) return new Map();
    return new Map((await rows("SELECT * FROM cust_profile WHERE phone_norm = ANY($1::text[])", [list])).map((r) => [r.phone_norm, fromDb(r)]));
  }
  async function phones() { await ready; return (await rows("SELECT phone_norm FROM cust_profile WHERE orders > 0")).map((r) => r.phone_norm); }
  /* ملف واحد: لو مش موجود أو أقدم من maxAgeMs بيتحسب الحين */
  async function forPhone(pn, { maxAgeMs = DAY } = {}) {
    let row = (await profilesFor([pn])).get(pn) || null;
    if (!row || !(now() - tms(row.computed_at) < maxAgeMs)) {
      await some([pn], "view");
      row = (await profilesFor([pn])).get(pn) || row;
    }
    return row;
  }
  /* سياق قيم الرسالة: FIRST الحي + إعداد الولاء + (لو {fav_box} مطلوب) المنيو والبوكسات الشغّالة بنفس كاش البوت */
  async function tokenContext({ needBox = false, fieldMax = null } = {}) {
    const s = await settingsNow();
    const fs = await firstState();
    let live = null;
    if (needBox) {
      const L = liveSrc();
      if (L && typeof L.menu === "function" && typeof L.bundles === "function") {
        try {
          const o = { strict: true };
          const [menu, bundles, offers] = await Promise.all([L.menu(o), L.bundles(o), typeof L.offers === "function" ? L.offers(o) : null]);
          if (menu && Array.isArray(menu.items) && menu.items.length && Array.isArray(bundles) && bundles.length) live = buildLive({ menu, bundles, offers, paused: pausedOffersOf(s, now()), now: now() });
        } catch { live = null; }
      }
    }
    return { ...fs, loyalty: loyaltyCfgOf(s), live, fieldMax };
  }
  /* وقت الإرسال: القيم اللي ممكن تتغيّر لسه صح؟ null = ابعت. q.vars.prof = {box, firstHint, loy} من وقت التجهيز */
  async function recheckRow(q) {
    const u = (q && q.vars && q.vars.prof) || null;
    if (!u || (!u.box && !u.firstHint && u.loy == null)) return null;
    try {
      const tctx = await tokenContext({ needBox: Boolean(u.box) });
      if (u.box) {
        const b = tctx.live ? tctx.live.boxes.get(String(u.box)) : null;
        if (!tctx.live) return "profile_unverified";
        if (!b || !boxLive(b, tctx.live)) return "profile_box_gone";
      }
      const L = [[String(q.phone_norm)]];
      if (u.firstHint) {
        const [used, w] = await Promise.all([rows(FAV_SQL.firstUsed, L), rows(FAV_SQL.web, L)]);
        if (!(tctx.firstLive && !used.length && !(Number((w[0] || {}).deliv) > 0))) return "profile_first_changed";
      }
      if (u.loy != null) {
        const lc = tctx.loyalty;
        if (!(lc && lc.enabled && lc.startedAt)) return "profile_loyalty_changed";
        const k = Number(((await rows(GATHER_SQL.loyaltyCount, [L[0], lc.startedAt]))[0] || {}).n) || 0;
        const every = Math.max(2, Number(lc.every) || 5), m = k % every;
        if ((m === 0 ? every : every - m) !== Number(u.loy)) return "profile_loyalty_changed";
      }
      return null;
    } catch (e) { log.error?.(`[custprofile] recheck: ${e.message}`); return "profile_unverified"; }
  }

  /* ── الجدولة: الليلي + المسح + حدث الطلب المدفوع ── */
  if (ctx.startJobs !== false && deps.jobs !== false && !process.env.NODE_TEST_CONTEXT) {
    const boot = setTimeout(async () => {
      try {
        const st = await stateRow();
        if (!st.full_at || now() - tms(st.full_at) > 26 * 3600_000) await full("boot");
        await sweep();
      } catch (e) { log.error?.(`[custprofile] boot: ${e.message}`); }
    }, 90_000);
    boot.unref?.();
    const t = setInterval(async () => {
      try {
        const cfg = profileCfg(await settingsNow());
        const st = await stateRow();
        const hour = riyadhClock(now()).hour;
        if (hour === cfg.nightlyHour && !(st.full_at && now() - tms(st.full_at) < 20 * 3600_000)) await full("nightly");
        else await sweep();
      } catch (e) { log.error?.(`[custprofile] tick: ${e.message}`); }
    }, 5 * 60_000);
    t.unref?.();
    subscribe(async (evt) => {
      const no = evt && evt.orderNo;
      if (!no) return;
      const r = await rows("SELECT phone_norm FROM shop_orders WHERE order_no=$1", [String(no)]);
      if (r[0]) schedule(r[0].phone_norm);
    }, "order_paid");
  }

  async function isOwner(c) { try { const u = await whoami(c); return Boolean(u && u.role === "owner"); } catch { return false; } }
  async function pnOfRef(ref) {
    const api = c360();
    if (api && typeof api.pnOfRef === "function") return api.pnOfRef(ref);
    if (!/^c[0-9a-f]{15}$/.test(nz(ref))) return null;
    return (await rows("SELECT phone_norm FROM c360_refs WHERE ref=$1", [ref]))[0]?.phone_norm || null;
  }
  async function statusView() {
    const st = await stateRow();
    const [cnt, runs] = await Promise.all([
      rows("SELECT count(*)::int n, count(*) FILTER (WHERE orders > 0)::int buyers, max(computed_at) last FROM cust_profile"),
      rows("SELECT id, at, trigger, phones, ms, ok, error, counts FROM cust_profile_runs ORDER BY at DESC LIMIT 8"),
    ]);
    const lastFull = runs.find((r) => ["nightly", "boot", "manual", "settings"].includes(r.trigger) && r.ok) || null;
    return { profiles: cnt[0]?.n || 0, buyers: cnt[0]?.buyers || 0, lastComputedAt: iso(cnt[0]?.last), fullAt: iso(st.full_at),
      cuts: st.cuts ? { a: st.cuts.a, b: st.cuts.b, c: st.cuts.c, n: st.cuts.n, tiers: st.cuts.tiers } : null,
      lastFull: lastFull ? { at: iso(lastFull.at), phones: lastFull.phones, ms: lastFull.ms, counts: lastFull.counts } : null,
      runs: runs.map((r) => ({ at: iso(r.at), trigger: r.trigger, phones: r.phones, ms: r.ms, ok: r.ok, error: r.error })) };
  }

  /* ═══ المسارات (قسم «العملاء») ═══ */
  app.get("/api/cms/customers/profile-fields", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = profileCfg(await settingsNow());
    return c.json({ ok: true, version: PROFILE_VERSION, groups: FIELD_GROUPS, fields: PROFILE_FIELDS, enums: ENUM_AR, refresh: REFRESH_AR,
      segments: segmentsView(cfg), tokens: PROFILE_TOKENS, filters: { enums: ENUM_FILTERS, bools: BOOL_FILTERS, ranges: RANGE_FILTERS },
      cfg, status: await statusView().catch(() => null) });
  });

  app.get("/api/cms/customers/profile/:ref", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const pn = await pnOfRef(c.req.param("ref"));
    if (!pn) return bad(c, "not_found", "العميل مش موجود", 404);
    try {
      const row = await forPhone(pn);
      if (!row) return c.json({ ok: true, profile: null });
      const cfg = profileCfg(await settingsNow());
      const tctx = await tokenContext({ needBox: true });
      const tokens = Object.fromEntries(PROFILE_TOKENS.map((t) => { const r = tokenValue(t.key, row, tctx); return [t.key, r.ok ? r.value : null]; }));
      return c.json({ ok: true, profile: profileView(row, cfg), tokens, cfg: { tierA: cfg.tierA, tierB: cfg.tierB, tierC: cfg.tierC } });
    } catch (e) {
      log.error?.(`[custprofile] profile: ${e.message}`);
      return c.json({ ok: false, error: "profile_failed", message: String(e.message).slice(0, 200) }, 200);
    }
  });

  /* بنّاء الجمهور: GET عشان دور «عرض» يقدر يعدّ (الفلتر في ?f= — مفيش بيانات عملاء في الرابط) */
  app.get("/api/cms/customers/profiles/count", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let f = {};
    try { f = JSON.parse(c.req.query("f") || "{}"); } catch { return bad(c, "bad_json", "الفلتر مش JSON"); }
    const nf = normalizeProfileFilter(f);
    if (!nf.ok) return bad(c, nf.error[0], nf.error[1], 422);
    await ready;
    const all = (await rows("SELECT * FROM cust_profile WHERE orders > 0")).map(fromDb);
    const T = now();
    const hit = all.filter((r) => !r.is_staff && matchProfile(r, nf.filter, T));
    const by = (k) => countBy(hit, k);
    hit.sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0));
    const sample = hit.slice(0, 12);
    const api = c360();
    if (api && typeof api.remember === "function") await api.remember(sample.map((r) => r.phone_norm)).catch(() => {});
    const refOf = api && typeof api.refOf === "function" ? api.refOf : () => null;
    const st = await stateRow();
    return c.json({ ok: true, filter: nf.filter, total: all.filter((r) => !r.is_staff).length, matched: hit.length,
      reachable: hit.filter((r) => r.wa_reach === "reachable").length, byTier: by("value_tier"), byRecency: by("recency_band"), byReach: by("wa_reach"),
      sample: sample.map((r) => ({ ref: refOf(r.phone_norm), name: r.name, tier: r.value_tier, recency: r.recency_band, favDish: r.fav_dish, orders: r.orders,
        spend: r.spend, lastOrderAt: r.last_order_at, reach: r.wa_reach })),
      asOf: iso(st.full_at) });
  });

  app.get("/api/cms/customers/profile-settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await settingsNow();
    return c.json({ ok: true, settings: schemaView(s), groups: PROFILE_SETTING_GROUPS, days: DOW_AR, canEdit: await isOwner(c), status: await statusView().catch(() => null) });
  });
  app.post("/api/cms/customers/profile-settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return bad(c, "owner_only", "إعدادات التصنيف للمالك بس", 403);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const s = await settingsNow();
    const r = cleanProfileSettings(b, s);
    if (!r.ok) return c.json({ ok: false, error: "invalid", errors: r.errors, message: r.errors[0][1] }, 422);
    await pool.query(`UPDATE settings SET data = jsonb_set(jsonb_set(COALESCE(data,'{}'::jsonb), '{cms}', COALESCE(data->'cms','{}'::jsonb), true),
      '{cms,customerProfile}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(r.cfg)]);
    ctx.auditNote?.(c, `customerProfile: ${Object.keys(b).join(", ")}`)?.catch?.(() => {});
    full("settings").catch(() => {});      // الحدود اتغيّرت ⇒ إعادة تصنيف الكل في الخلفية
    return c.json({ ok: true, cfg: r.cfg, rebuilding: true });
  });
  app.post("/api/cms/customers/profiles/rebuild", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return bad(c, "owner_only", "إعادة الحساب للمالك بس", 403);
    const r = await full("manual");
    return c.json({ ok: Boolean(r && r.ok), ...r, status: await statusView().catch(() => null) });
  });

  log.log?.("[custprofile] routes registered");
  return { ready, rebuild: (pns, trigger = "manual") => (pns ? some(pns, trigger) : full(trigger)), sweep, schedule, profilesFor, phones, forPhone, tokenContext, recheckRow,
    normalizeFilter: normalizeProfileFilter, match: matchProfile, resolveValues: resolveProfileValues, tokens: PROFILE_TOKENS, tokenKeys: PROFILE_TOKEN_KEYS,
    segments: async () => segmentsView(profileCfg(await settingsNow())), cfg: async () => profileCfg(await settingsNow()) };
}
