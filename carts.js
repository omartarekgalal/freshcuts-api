/* ═══════════════════════════════════════════════════════════════════════════
   CARTS — السلات المتروكة: نلتقطها، نقيسها، ونستردها.

   طلب عمر (2026-08-16): «نراقب السلات المتروكة بشكل واضح ونعملها خطة».

   الفكرة: المتجر بيبعت لقطة من السلة عند كل خطوة مهمة (اتضاف صنف، فتح
   الشيك أوت، اتحدد العنوان، اتفتحت شاشة الدفع). اللقطة بتتخزن على مفتاح
   الجهاز (device id في localStorage) وبتترقّى لرقم الجوال أول ما نعرفه —
   عشان نقدر نكلّم العميل فعلاً، مش نتفرج على رقم مجهول.

   الحقيقة اللي بتحكم التصميم: **معظم السلات المتروكة مجهولة الهوية**
   (العميل ما وصلش لخطوة الجوال). فالقياس بيفصل بين:
     • reachable   → عندنا جوال (push/SMS/WhatsApp ممكنة)
     • anonymous   → للقياس بس (تحسين المنتج، مش استرداد)

   المراحل (stage): cart → checkout → address → payment → ordered
   السلة بتتقفل (recovered) لحظة ما يتعمل طلب مدفوع بنفس الجوال/الجهاز.

   الاسترداد (recovery ladder) بيشتغل من الحارس كل ٥ دقايق:
     بعد ٤٥ دقيقة  → إشعار متصفح: «سلتك لسه مستنياك 🛒»
     بعد ٤ ساعات   → SMS/واتساب (لو مفعّلين) + كوبون اختياري
     مرة واحدة لكل سلة، وبس في ساعات مسموحة (مش ٣ الفجر).
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import * as smsRules from "./smsrules.js";
import { renderTemplate } from "./smstemplates.js";
import * as cartPresets from "./cartpresets.js";
import { couponQueries, firstEligibility } from "./couponrules.js";
const sendAdSms = (pn, body, meta) => smsRules.sendAdSms(pn, body, meta);
import { holdUntil as journeyHoldUntil } from "./wajourney.js";      // CJ1a (١٧/١٠): SMS السلة مابتيجيش ورا رسالة تانية للعميل بدقايق
/* CR3 (١٨/١٠): واتساب قبل الـSMS — قوالب السلة المعتمدة من الكتالوج، بوابة مواعيد المطعم، سعر الرسالة، و131049 */
import { TEMPLATES as WA_CATALOG, bindTemplate } from "./watemplates.js";
import { isRestaurantOpenAt } from "./sendhours.js";
import { waRatesOf } from "./waaicost.js";
import { qualityCfg, META_CAPPED_CODE } from "./waquality.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const STAGES = ["cart", "checkout", "address", "payment", "ordered"];
const rank = (s) => Math.max(0, STAGES.indexOf(String(s || "cart")));

/* ── إعدادات الاسترداد (settings.abandonedCarts) — بتتعدّل من اللوحة ── */
export const CART_DEFAULTS = {
  enabled: true,             // المحرك كله
  pushEnabled: true,         // خطوة ١ بإشعار لو العميل مشترك (ببلاش)
  smsEnabled: false,         // SMS من المُرسل التسويقي — قرار المالك
  sms1AfterMinutes: 35,      // السلة «متروكة» بعد ٣٠ دقيقة من غير طلب؛ الرسالة بعد ٣٥
  sms1WindowMinutes: 120,    // فاتت النافذة (ساعات هدوء/مقفولين) ⇒ مفيش خطوة ١
  sms2Enabled: true,
  sms2Hour: 17,              // تاني يوم من الساعة دي (الرياض)
  sms2MinSubtotal: 60,       // خطوة ٢ للسلة اللي تستاهل بس
  cooldownDays: 7,           // CR4: طول نافذة السقف بالأيام (كان: فلو واحد لكل جوال)
  /* CR4 (عمر ١٩/١٠: «خلي السلات تاخد رسالتين ف الاسبوع ولو اشترى ميجلوش رسالة تاني غير لو عمل سلة في جلسة جديدة»):
     أقصى رسايل سلة (واتساب + SMS بس — الإشعار ببلاش ومش محسوب) للجوال الواحد في آخر cooldownDays يوم، قبل خطوة ١ وقبل خطوة ٢. */
  maxPerWeek: 2,
  minSubtotal: 0,
  autoFirst: true,           // FIRST (توصيل مجاني) لو مالوش طلب أونلاين مدفوع
  requireVerifiedPhone: true,// جوال اتأكد بـOTP أو عنده حساب — مش رقم مكتوب غلط
  respectOpenHours: true,    // مطبخ مقفول = سكوت
  /* CR3 (١٨/١٠ — عمر: «ابعتلهم واتساب يكملوا سلتهم»، والقاعدة الثابتة «واتساب قبل SMS»):
     الترتيب: إشعار (خطوة ١ لو مشترك) ← واتساب ← SMS بس لو واتساب مش ممكن. */
  waEnabled: true,           // واتساب للسلة المتروكة
  waInWindowText: true,      // نافذة الـ٢٤ ساعة مفتوحة ⇒ رسالة حرة ببلاش بدل القالب
  waTemplate1: "fc_cart_1h",         // خطوة ١ بره النافذة
  waTemplate2: "fc_cart_24h",        // خطوة ٢ بره النافذة (عميل قديم)
  waTemplate2First: "fc_cart_24h_first", // خطوة ٢ بره النافذة (أول طلب — بكود FIRST وحدّه الأدنى)
  waText1: "",               // نص الرسالة الحرة خطوة ١ (فاضي = الافتراضي) — الرابط بيتحط آخره لوحده
  waText2: "",               // نص الرسالة الحرة خطوة ٢
  smsFallback: true,         // SMS لما واتساب مايقدرش يوصل (ومفتاح «رسايل SMS» لازم يكون شغّال)
};

/* CR3: القوالب اللي تنفع للسلة = قوالب الكتالوج التسويقية اللي زرها رابط /c/<code>، ومتغيراتها (لو فيه) من كوبون أول طلب بس */
const CART_VAR_PATHS = new Set(["coupon.code", "coupon.min_total"]);
export const CART_WA_TEMPLATES = Object.freeze([...new Set((WA_CATALOG || [])
  .filter((t) => t && t.category === "MARKETING" && (t.language || "ar") === "ar"
    && ((t.meta || {}).buttonVars || []).some((b) => b.path === "cart.code")
    && ((t.meta || {}).vars || []).every((v) => CART_VAR_PATHS.has(v.path)))
  .map((t) => t.name))]);
/* حالات ميتا اللي الإرسال بيها أكيد هيفشل (نفس whatsapp.js TEMPLATE_BLOCKING_STATUSES) */
export const CART_TEMPLATE_BLOCKING = Object.freeze(["REJECTED", "NOT_SUBMITTED", "DISABLED", "PENDING_DELETION", "DELETED"]);
const waTplOk = (v, d) => (typeof v === "string" && CART_WA_TEMPLATES.includes(v) ? v : d);
const waTextOk = (v) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, 300) : "");

/* CR3: تسميات اللوحة (نفس مسار GET/PUT /api/carts/recovery) */
export const CART_FIELDS = Object.freeze({
  waEnabled: { ar: "رسايل واتساب للسلة المتروكة", hint: "قبل الـSMS — جوّه النافذة ببلاش، وبرّه بقالب تسويقي معتمد (~٠٫٢٢ ر.س)", type: "bool" },
  waInWindowText: { ar: "رسالة حرة لو العميل كلّمنا آخر ٢٤ ساعة", hint: "ببلاش ومن غير قالب؛ مقفول = القالب دايماً", type: "bool" },
  waTemplate1: { ar: "قالب الخطوة الأولى", hint: "بعد مدة الرسالة الأولى، بره النافذة", type: "template" },
  waTemplate2: { ar: "قالب الخطوة التانية (عميل قديم)", hint: "تاني يوم من ساعة الخطوة التانية", type: "template" },
  waTemplate2First: { ar: "قالب الخطوة التانية (أول طلب)", hint: "فيه كود FIRST وحدّه الأدنى من الكوبونات", type: "template" },
  waText1: { ar: "نص الرسالة الحرة — الخطوة الأولى", hint: "فاضي = النص الافتراضي؛ رابط السلة بيتحط آخره لوحده", type: "text", max: 300 },
  waText2: { ar: "نص الرسالة الحرة — الخطوة التانية", hint: "فاضي = النص الافتراضي؛ رابط السلة بيتحط آخره لوحده", type: "text", max: 300 },
  maxPerWeek: { ar: "أقصى رسايل للعميل في الأسبوع", hint: "رسايل السلة (واتساب + SMS) للجوال الواحد في آخر «مدة السقف» يوم — الإشعار ببلاش ومش محسوب. اشترى ⇒ مفيش رسايل تانية للسلة دي", type: "int", min: 1, max: 10 },
  cooldownDays: { ar: "مدة سقف الرسايل (يوم)", hint: "النافذة اللي بيتعدّ فيها «أقصى رسايل للعميل» — ٧ = أسبوع", type: "int", min: 1, max: 60 },
  smsFallback: { ar: "SMS بديل لو واتساب ماينفعش", hint: "مش على واتساب / القالب مش معتمد / سقف ميتا — ومحتاج مفتاح «رسايل SMS» شغّال", type: "bool" },
});
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function cartCfg(settings) {
  const x = { ...CART_DEFAULTS, ...(((settings || {}).abandonedCarts) || {}) };
  const bool = (k) => (typeof x[k] === "boolean" ? x[k] : CART_DEFAULTS[k]);
  return {
    enabled: bool("enabled"), pushEnabled: bool("pushEnabled"), smsEnabled: x.smsEnabled === true,
    sms1AfterMinutes: clampN(x.sms1AfterMinutes, 30, 240, 35),
    sms1WindowMinutes: clampN(x.sms1WindowMinutes, 15, 600, 120),
    sms2Enabled: bool("sms2Enabled"), sms2Hour: Math.round(clampN(x.sms2Hour, 12, 21, 17)),
    sms2MinSubtotal: clampN(x.sms2MinSubtotal, 0, 10000, 60),
    cooldownDays: Math.round(clampN(x.cooldownDays, 1, 60, 7)),
    maxPerWeek: Math.round(clampN(x.maxPerWeek, 1, 10, 2)),
    minSubtotal: clampN(x.minSubtotal, 0, 10000, 0),
    autoFirst: bool("autoFirst"), requireVerifiedPhone: bool("requireVerifiedPhone"), respectOpenHours: bool("respectOpenHours"),
    waEnabled: bool("waEnabled"), waInWindowText: bool("waInWindowText"),
    waTemplate1: waTplOk(x.waTemplate1, CART_DEFAULTS.waTemplate1), waTemplate2: waTplOk(x.waTemplate2, CART_DEFAULTS.waTemplate2),
    waTemplate2First: waTplOk(x.waTemplate2First, CART_DEFAULTS.waTemplate2First),
    waText1: waTextOk(x.waText1), waText2: waTextOk(x.waText2), smsFallback: bool("smsFallback"),
  };
}

/* النصوص بلهجة سعودية بيضا. الـSMS جزئين بالكتير بسطر الإيقاف (اختبار بيتأكد). */
export const cartMessages = {
  push1: (n, first) => ({
    title: "سلتك محفوظة 🛒",
    body: first ? `${n} صنف بانتظارك، والتوصيل مجاني لأول طلب. كمّل طلبك بضغطة` : `${n} صنف بانتظارك في فريش كاتس، كمّل طلبك بضغطة`,
  }),
  sms1: (first) => first ? "فريش كاتس: سلتك محفوظة والتوصيل مجاني لأول طلب، كمّل طلبك بضغطة" : "فريش كاتس: سلتك للحين محفوظة، كمّل طلبك بضغطة",
  sms2: (first) => first ? "طلبك من فريش كاتس للحين في السلة، والتوصيل مجاني لأول طلب" : "طلبك من فريش كاتس للحين في السلة، تقدر تكمّله الحين",
  /* CR3: الرسالة الحرة جوّه نافذة واتساب — نفس روح قوالب fc_cart_* (لهجة بيضا)، والرابط /c/<code> آخر سطر */
  wa1: (first) => first ? "سلتك في فريش كاتس محفوظة 🛒\nوالتوصيل مجاني لأول طلب، كمّل طلبك بضغطة من الرابط:"
    : "سلتك في فريش كاتس محفوظة 🛒\nكمّل طلبك بضغطة من الرابط، ولو عندك سؤال ردّ علينا هنا:",
  wa2: (first) => first ? "لسا طلبك ينتظرك في سلة فريش كاتس 😋\nوبما إنه أول طلب لك، التوصيل مجاني. كمّل الحين من الرابط:"
    : "لسا طلبك ينتظرك في سلة فريش كاتس 😋\nكمّل الحين من الرابط ونبدأ نجهّزه لك طازج:",
};
/* CR3: نص الرسالة الحرة (نص المالك من اللوحة لو موجود) + الرابط */
export const cartWaText = (step, first, url, cfg = {}) => {
  const own = step === 2 ? cfg.waText2 : cfg.waText1;
  const head = own && String(own).trim() ? String(own).trim() : (step === 2 ? cartMessages.wa2(first) : cartMessages.wa1(first));
  return `${head}\n${url}`;
};
/* CR3: اسم القالب بره النافذة — خطوة ٢ لأول طلب بالقالب اللي فيه الكود لو الكوبون وحدّه معروفين، وإلا القالب العادي */
export function cartWaTemplate(step, cfg, firstCoupon) {
  const c = cfg || {};
  if (step !== 2) return { name: c.waTemplate1 || CART_DEFAULTS.waTemplate1, data: {} };
  if (firstCoupon && firstCoupon.code && Number(firstCoupon.min_total) > 0) {
    return { name: c.waTemplate2First || CART_DEFAULTS.waTemplate2First, data: { coupon: { code: firstCoupon.code, min_total: firstCoupon.min_total } } };
  }
  return { name: c.waTemplate2 || CART_DEFAULTS.waTemplate2, data: {} };
}
/* CR3: متغيّرات القالب {body[], button[]} من الكتالوج نفسه (نفس bindTemplate اللي السجل بيستخدمه) */
export function cartWaParams(name, code, data = {}) {
  const t = (WA_CATALOG || []).find((x) => x.name === name && (x.language || "ar") === "ar");
  if (!t) return { body: [], button: [], missing: ["template"] };
  const r = bindTemplate(t, { ...data, cart: { code } });
  return { body: r.body || [], button: (r.buttons || []).map((b) => b.text), missing: r.missing || [] };
}
/* CR3: نتيجة واتساب ⇒ ينفع SMS بدلها؟ إيقاف / تأجيل الهدوء ⇒ لأ. 131049 (ميتا حدّت تسويق العميل) ⇒ بس لو waCloud.cappedFallbackSms. */
export function smsAfterWa(res, settings) {
  const r = res || {};
  if (r.ok) return false;
  if (r.skipped === "opted_out" || r.skipped === "burst_hold") return false;
  if (Number(r.code) === META_CAPPED_CODE) return qualityCfg(((settings || {}).waCloud) || {}).cappedFallbackSms === true;
  return true;
}
/* سطر الإيقاف واحد لكل الرسايل التسويقية (smsrules.optoutLine) — من ٢١/٩
   الافتراضي كلمة مش رابط، عشان رابط استرداد السلة يفضل هو الوحيد اللي
   يتضغط. `optout` = سطر جاهز، أو {cfg, code, host, sender} وإحنا نبنيه. */
/* settings (اختياري): لو المالك عدّل النص من «📱 رسايل SMS» بياخده */
const cartHead = (step, first, settings) => {
  const id = `cart.sms${step === 2 ? 2 : 1}${first ? "_first" : ""}`;
  const r = settings ? renderTemplate(settings, id, {}) : null;
  return r && r.custom && r.text ? r.text : (step === 2 ? cartMessages.sms2(first) : cartMessages.sms1(first));
};
export const cartSmsBody = (step, first, link, optout, settings) =>
  `${cartHead(step, first, settings)} ${link}\n${
    typeof optout === "string" ? optout : smsRules.optoutLine((optout || {}).cfg, optout || {})}`;
const storeHost = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "").replace(/^https?:\/\//, "");
const PAID_SQL = "status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')";

/* المطعم مفتوح دلوقتي؟ نسخة سيرفر من نفس منطق الواجهة (بيراعي ما بعد
   منتصف الليل). رسالة «كمّل طلبك» ومطبخنا مقفول أسوأ من السكوت. */
export function isOpenNow(hours, now = new Date()) {
  if (!hours || hours.enabled === false || !hours.days) return true; // مش معرّف = ما نمنعش
  const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  now = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  const mins = now.getHours() * 60 + now.getMinutes();
  const hhmm = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  /* ٢٤/٩ — الوردية بتتنسب لليوم اللي **بدأت** فيه، مش لليوم اللي فيه الصبح.
     الغلط اللي كان: `mm >= o || mm < c` كانت بتتحسب على صف النهاردة كمان،
     فذيل الفجر كان بياخد ساعة قفل النهاردة بدل امبارح. عمر أكّد (٢٤/٩) إن
     الخميس والجمعة بيقفلوا ٣ الفجر والباقي ٢، يعني وردية الأربع بتنتهي
     ٢:٠٠ الخميس الفجر — ومع ده الموقع كان بيقول «مفتوح» لحد ٣:٠٠ لأنه
     قرا قفلة الخميس. كده ٣ أيام في الأسبوع كان بياخد طلبات والمطبخ ماشي. */
  const eveningPart = (d, mm) => {                 // من الفتح لحد نص الليل (أو القفل)
    if (!d || d.closed || !d.open || !d.close) return false;
    const o = hhmm(d.open), c = hhmm(d.close);
    return c > o ? (mm >= o && mm < c) : (mm >= o);
  };
  const morningTail = (d, mm) => {                 // ذيل وردية امبارح بعد نص الليل
    if (!d || d.closed || !d.open || !d.close) return false;
    const o = hhmm(d.open), c = hhmm(d.close);
    return c < o && mm < c;
  };
  const today = DAYS[now.getDay()], yest = DAYS[(now.getDay() + 6) % 7];
  return eveningPart(hours.days[today], mins) || morningTail(hours.days[yest], mins);
}

const rl = new Map();
function rateLimited(ip, max = 240) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

/* السلة الخام من المتجر (state.cart) — عشان رابط الاسترداد يرجّع نفس السطور
   بالظبط (الأوزان والباقات واختياراتها والملاحظات). بنقصّها ٤٠KB. */
export function rawCart(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).slice(0, 60);
  if (!keys.length) return null;
  const out = {};
  for (const k of keys) { const v = raw[k]; if (v && typeof v === "object") out[String(k).slice(0, 200)] = v; }
  const txt = JSON.stringify(out);
  return txt.length <= 40000 ? txt : null;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  const notify = deps.notify || null;
  /* CR3: واتساب (index.js بيدّي () => waApi). مفيش ⇒ السلة بتمشي زي الأول (إشعار ثم SMS). */
  const waOf = () => { try { return typeof deps.wa === "function" ? deps.wa() : (deps.wa || null); } catch { return null; } };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_carts (
        device_id TEXT PRIMARY KEY,
        phone_norm TEXT,
        stage TEXT NOT NULL DEFAULT 'cart',
        max_stage TEXT NOT NULL DEFAULT 'cart',
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        item_count INT NOT NULL DEFAULT 0,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        option TEXT,
        has_location BOOLEAN NOT NULL DEFAULT FALSE,
        installed BOOLEAN,
        push_ready BOOLEAN,
        ua TEXT,
        recovered_order TEXT,
        recovered_at TIMESTAMPTZ,
        nudges JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE shop_carts ADD COLUMN IF NOT EXISTS in_webview TEXT;
      ALTER TABLE shop_carts ADD COLUMN IF NOT EXISTS cart_raw JSONB;
      ALTER TABLE shop_carts ADD COLUMN IF NOT EXISTS rec_step INT NOT NULL DEFAULT 0;
      ALTER TABLE shop_carts ADD COLUMN IF NOT EXISTS rec_note TEXT;
      ALTER TABLE shop_carts ADD COLUMN IF NOT EXISTS rec_flow INT;
      -- فلو استرداد واحد = رسالة/إشعار لجوال، برابط /c/<code> بيرجّع السلة
      CREATE TABLE IF NOT EXISTS cart_recovery (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        phone_norm TEXT NOT NULL,
        device_id TEXT,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        item_count INT NOT NULL DEFAULT 0,
        items JSONB,
        cart_raw JSONB,
        option TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        step1_channel TEXT, step1_at TIMESTAMPTZ, step1_msg_id TEXT, step1_cost NUMERIC,
        step2_channel TEXT, step2_at TIMESTAMPTZ, step2_msg_id TEXT, step2_cost NUMERIC,
        opened_at TIMESTAMPTZ, open_count INT NOT NULL DEFAULT 0,
        order_no TEXT, order_total NUMERIC, recovered_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS cart_recovery_phone_idx ON cart_recovery(phone_norm, started_at DESC);
      -- الباج القديم كبّر nudges لمئات النسخ من sms1_skipped — تنضيف مرة واحدة
      UPDATE shop_carts SET nudges = '[]'::jsonb WHERE jsonb_array_length(nudges) > 5;
      CREATE INDEX IF NOT EXISTS shop_carts_phone_idx ON shop_carts(phone_norm) WHERE phone_norm IS NOT NULL;
      CREATE INDEX IF NOT EXISTS shop_carts_open_idx ON shop_carts(updated_at DESC) WHERE recovered_order IS NULL;
      -- 🛍 سلات جاهزة للإعلانات (cartpresets.js) — نفس رابط /c/<code>
      ${cartPresets.PRESETS_DDL}
    `);
  }
  ensureSchema()
    .then(() => console.log("[carts] schema ready"))
    .catch((e) => console.error("[carts] schema failed:", e.message));

  /* 🛍 السلات الجاهزة (cartpresets.js): مسارات اللوحة + اللي مساري الاسترداد
     العامّين تحت بينده عليه لما الكود مايبقاش رابط استرداد. */
  const presets = cartPresets.register(app, ctx, { rawCart, menuIds: deps.presetMenuIds });

  /* ── PUBLIC: لقطة السلة من المتجر ─────────────────────────────────────
     بتتنده عند كل تغيير مهم (debounced في الواجهة). مفيش أسرار هنا —
     أسوأ استغلال ممكن هو تلويث إحصائية، والحد الأدنى من الحماية كفاية. */
  app.post("/api/carts/snapshot", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const device = String(b.deviceId || "").slice(0, 64);
    if (!/^[a-z0-9_-]{8,64}$/i.test(device)) return c.json({ ok: false, error: "bad device" }, 400);
    const phone = b.phone ? normPhone(b.phone) : null;
    const items = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
    const stage = STAGES.includes(String(b.stage)) ? String(b.stage) : "cart";

    await pool.query(
      `INSERT INTO shop_carts(device_id, phone_norm, stage, max_stage, items, item_count, subtotal,
                              option, has_location, installed, push_ready, ua, in_webview, cart_raw)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,$14)
       ON CONFLICT (device_id) DO UPDATE SET
         phone_norm = COALESCE(EXCLUDED.phone_norm, shop_carts.phone_norm),
         stage = EXCLUDED.stage,
         -- max_stage بيفضل أبعد نقطة وصلها العميل (مش آخر خطوة رجع منها)
         max_stage = CASE WHEN $12::int > (CASE shop_carts.max_stage
             WHEN 'cart' THEN 0 WHEN 'checkout' THEN 1 WHEN 'address' THEN 2
             WHEN 'payment' THEN 3 WHEN 'ordered' THEN 4 ELSE 0 END)
           THEN EXCLUDED.stage ELSE shop_carts.max_stage END,
         items = EXCLUDED.items, item_count = EXCLUDED.item_count, subtotal = EXCLUDED.subtotal,
         option = EXCLUDED.option, has_location = EXCLUDED.has_location,
         installed = COALESCE(EXCLUDED.installed, shop_carts.installed),
         push_ready = COALESCE(EXCLUDED.push_ready, shop_carts.push_ready),
         ua = EXCLUDED.ua,
         in_webview = COALESCE(EXCLUDED.in_webview, shop_carts.in_webview),
         cart_raw = COALESCE(EXCLUDED.cart_raw, shop_carts.cart_raw),
         rec_step = CASE WHEN EXCLUDED.stage <> 'ordered' AND shop_carts.recovered_order IS NOT NULL
                         THEN 0 ELSE shop_carts.rec_step END,
         rec_flow = CASE WHEN EXCLUDED.stage <> 'ordered' AND shop_carts.recovered_order IS NOT NULL
                         THEN NULL ELSE shop_carts.rec_flow END,
         -- سلة اتفتحت من جديد بعد ما اتسجلت مستردة: تبقى سلة جديدة
         recovered_order = CASE WHEN EXCLUDED.stage <> 'ordered' AND shop_carts.recovered_order IS NOT NULL
                                THEN NULL ELSE shop_carts.recovered_order END,
         nudges = CASE WHEN EXCLUDED.stage <> 'ordered' AND shop_carts.recovered_order IS NOT NULL
                       THEN '[]'::jsonb ELSE shop_carts.nudges END,
         updated_at = NOW()`,
      [device, /^5\d{8}$/.test(phone || "") ? phone : null, stage,
       jb(items.map((it) => ({ id: it.id, n: String(it.name || "").slice(0, 60), q: Number(it.qty) || 1, p: Number(it.price) || 0 }))),
       items.reduce((s, it) => s + (Number(it.qty) || 1), 0),
       Number(b.subtotal) || 0, b.option ? String(b.option).slice(0, 12) : null,
       Boolean(b.hasLocation), typeof b.installed === "boolean" ? b.installed : null,
       typeof b.pushReady === "boolean" ? b.pushReady : null,
       String(c.req.header("user-agent") || "").slice(0, 200), rank(stage),
       b.inWebview ? String(b.inWebview).slice(0, 16) : null,
       rawCart(b.raw)]
    );
    return c.json({ ok: true });
  });

  /* سلة تُقفل عند الطلب — shop.js بينده دي لحظة الدفع الناجح */
  async function markOrdered({ phoneNorm, deviceId, orderNo }) {
    await pool.query(
      `UPDATE shop_carts SET stage='ordered', max_stage='ordered',
              recovered_order=$3, recovered_at=NOW(), updated_at=NOW()
        WHERE (device_id = $2 OR (phone_norm IS NOT NULL AND phone_norm = $1))
          AND recovered_order IS NULL`,
      [phoneNorm || null, deviceId || "", String(orderNo)]
    ).catch((e) => console.error("[carts] markOrdered failed:", e.message));
    // استرداد: أي فلو اتبعت للجوال ده خلال ٧٢ ساعة ولسه مالوش طلب = الطلب ده رجع بيه
    if (phoneNorm) {
      await pool.query(
        `UPDATE cart_recovery f SET order_no=$2, recovered_at=NOW(),
                order_total=(SELECT total FROM shop_orders WHERE order_no=$2)
          WHERE f.id = (SELECT id FROM cart_recovery WHERE phone_norm=$1 AND order_no IS NULL
                         AND COALESCE(step2_at, step1_at) > NOW() - INTERVAL '72 hours'
                        ORDER BY started_at DESC LIMIT 1)`, [phoneNorm, String(orderNo)]
      ).catch((e) => console.error("[carts] recovery attribution failed:", e.message));
    }
  }

  /* ── الحارس: استرداد السلة المتروكة (إعادة بناء ١٧ سبتمبر ٢٠٢٦) ─────────
     طلب عمر: «عايزين نشوف حل كويس للسلات المتروكة».

     السلة «متروكة» = جوال موثّق (OTP/حساب) + أصناف + مفيش طلب مدفوع خلال ٣٠ دقيقة.
       خطوة ١ (~٣٥ دقيقة): إشعار لو مشترك، وإلا SMS «سلتك محفوظة» برابط /c/<code>
                         بيرجّع نفس السلة بالظبط + FIRST لو أول طلب أونلاين.
       خطوة ٢ (تاني يوم ١٧:٠٠): SMS بس لو السلة ≥ ٦٠ ر.س ولسه ماطلبش.
     ممنوع في ساعات الهدوء (٢٢–١٢) — خطوة ١ اللي فاتها ميعادها بتتنط لخطوة ٢.
     CR4 (١٩/١٠): بدل «فلو واحد لكل جوال كل ٧ أيام» ⇒ سقف رسايل للجوال (maxPerWeek=٢ واتساب/SMS في آخر cooldownDays يوم)
     بيتشيّك قبل خطوة ١ وقبل خطوة ٢. بيقف فوراً لو طلب (markOrdered + orderedSince)، والإيقاف /u/ محترم.
     كل الأرقام من settings.abandonedCarts (بتتعدّل من اللوحة).

     الباج القديم: السطر بتاع «sms1_skipped» كان بيتضاف كل ٥ دقايق لنفس الصف
     (الاستعلام مابيستبعدوش) لحد ٨٤٠ نسخة. دلوقتي الحالة في عمود rec_step
     بيتحدّث في نفس الدورة مهما كانت النتيجة، والنوافذ الزمنية بتقفل الباقي. */
  let running = false;
  async function runRecovery(now = new Date()) {
    if (running) return { skipped: "running" };
    running = true;
    try { return await recoveryTick(now); } finally { running = false; }
  }

  /* FIRST للسلة المتروكة: نفس قاعدة الشيك أوت (couponrules.js، ٥/١٠) — مفيش
     طلب توصيل من الموقع قبل كده ومااستخدمش FIRST. طلب استلام/طاولة مايمنعش. */
  const couponQ = couponQueries(pool);
  async function firstEligible(pn) {
    const r = await pool.query("SELECT code, percent, active, expires_at, free_delivery FROM shop_coupons WHERE upper(code)='FIRST' LIMIT 1");
    return (await firstEligibility(r.rows[0] || null, pn, couponQ)).eligible;
  }
  async function optout(pn) {
    await pool.query(
      `INSERT INTO cms_contacts(phone_norm, optout_code)
       VALUES ($1, substr(md5(random()::text || $1 || clock_timestamp()::text), 1, 10))
       ON CONFLICT (phone_norm) DO NOTHING`, [pn]);
    return (await pool.query("SELECT optout_code, opted_out_at FROM cms_contacts WHERE phone_norm=$1", [pn])).rows[0];
  }
  const newCode = () => crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "").toLowerCase().slice(0, 8).padEnd(8, "x");

  async function orderedSince(pn, since) {
    const r = await pool.query(
      `SELECT order_no, total FROM shop_orders WHERE phone_norm=$1 AND ${PAID_SQL} AND created_at > $2
        ORDER BY created_at LIMIT 1`, [pn, since]);
    return r.rows[0] || null;
  }

  async function smsRoomToday(parts, cfgCms) {
    const cap = Number(((cfgCms || {}).campaigns || {}).dailySmsCap) || 1000;
    const r = await pool.query("SELECT n FROM cms_sms_daily WHERE day = CURRENT_DATE").catch(() => ({ rows: [] }));
    return (r.rows[0]?.n || 0) + parts <= cap;
  }

  /* CR3: كوبون FIRST وحدّه الأدنى (لقالب خطوة ٢ لأول طلب) */
  async function firstCoupon() {
    const r = await pool.query("SELECT code, min_total FROM shop_coupons WHERE upper(code)='FIRST' AND active IS NOT FALSE LIMIT 1").catch(() => ({ rows: [] }));
    const c = r.rows[0];
    return c && Number(c.min_total) > 0 ? { code: String(c.code).toUpperCase(), min_total: Number(c.min_total) } : null;
  }
  /* CR3: العميل موقِّف التسويق؟ (رابط /u/، «إيقاف» في واتساب، أو إيقاف كل الرسايل) — قراءة بس.
     القالب الحارس بيتأكد بنفسه؛ ده للرسالة الحرة (الحارس مابيشوفش الإيقاف في الرد الحر لأنه عادةً رد على كلام العميل). */
  async function marketingStopped(pn) {
    try {
      const r = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM cms_contacts WHERE phone_norm=$1 AND opted_out_at IS NOT NULL)
             OR EXISTS (SELECT 1 FROM wa_optins WHERE phone_norm=$1 AND (stopped_at IS NOT NULL OR marketing_off_at IS NOT NULL)) AS stopped`, [pn]);
      return Boolean(r.rows[0] && r.rows[0].stopped);
    } catch { return true; }      // ماقدرناش نقرا ⇒ مانبعتش
  }

  /* CR3: خطوة واتساب. بيرجّع {ok, wamid, cost, kind} أو {ok:false, skipped|error, code?} */
  async function sendWa(row, step, cfg, s, flow, eligibleFirst) {
    const wa = waOf();
    if (!wa || typeof wa.sendTemplate !== "function") return { ok: false, skipped: "wa_unavailable" };
    const pn = row.phone_norm;
    if (await marketingStopped(pn)) return { ok: false, skipped: "opted_out" };
    /* جوّه النافذة: رسالة حرة ببلاش (الحارس بيرفضها window_closed لو النافذة مقفولة ⇒ القالب) */
    if (cfg.waInWindowText !== false && typeof wa.sendFreeform === "function") {
      const url = `https://${storeHost()}/c/${flow.code}?s=wa`;
      const body = cartWaText(step, eligibleFirst, url, cfg);
      const r = await wa.sendFreeform({ phoneNorm: pn, payload: { type: "text", text: { body, preview_url: true } },
        source: "cart_recovery", preview: body, proactive: true }).catch((e) => ({ ok: false, error: String(e.message || e) }));
      if (r && r.ok) return { ok: true, wamid: r.wamid || null, cost: 0, kind: "text" };
      if (r && r.skipped === "burst_hold") return r;
    }
    const pick = cartWaTemplate(step, cfg, step === 2 && eligibleFirst ? await firstCoupon() : null);
    let name = pick.name, params = cartWaParams(name, flow.code, pick.data);
    if (params.missing.length && step === 2 && name !== cfg.waTemplate2) {      // قالب أول طلب ناقصه متغيّر ⇒ القالب العادي
      name = cfg.waTemplate2; params = cartWaParams(name, flow.code, {});
    }
    if (params.missing.length) return { ok: false, skipped: "missing_param", detail: params.missing.join(","), template: name };
    /* حالة القالب عند ميتا لو نقدر نقراها: مش معتمد أكيد ⇒ من غير نداء (SMS البديل). مانعرفش ⇒ ميتا بتقرر. */
    if (typeof wa.templateStatusOf === "function") {
      const st = await wa.templateStatusOf(name, "ar").catch(() => null);
      if (st && CART_TEMPLATE_BLOCKING.includes(st)) return { ok: false, skipped: "template_not_approved", status: st, template: name };
    }
    const r = await wa.sendTemplate({ phoneNorm: pn, template: name, params: { body: params.body, button: params.button },
      source: "cart_recovery", proactive: true }).catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (r && r.ok) {
      const rate = Number(waRatesOf((((s || {}).waBot) || {}).waRates).marketing) || 0;
      return { ok: true, wamid: r.wamid || null, cost: rate, kind: "template", template: name };
    }
    return { ...(r || { ok: false, error: "send_failed" }), template: name };
  }

  /* ctx (CR3): { smsQuiet, waTime } من recoveryTick — الـSMS ليها ساعات الهدوء، وواتساب بمواعيد المطعم (sendhours.js) */
  async function sendStep(row, step, cfg, s, flow, ctx = {}) {
    const pn = row.phone_norm;
    // ٢٦/٩: أرقام الفريق (إنذارات/طلبات جديدة/استبعاد الحملات) مالهاش رسالة تسويق — ولا حتى إشعار
    if (smsRules.staffPhoneSet(s).has(pn)) return { channel: null, reason: "staff" };
    const eligibleFirst = cfg.autoFirst !== false && (await firstEligible(pn));
    const link = `${storeHost()}/c/${flow.code}`;
    // خطوة ١: الإشعار ببلاش — لو مشترك ناخده بدل واتساب والـSMS
    if (step === 1 && cfg.pushEnabled !== false && notify) {
      const m = cartMessages.push1(row.item_count, eligibleFirst);
      const ok = await notify.sendToAudience({ phoneNorm: pn, deviceId: row.device_id, ...m, url: `https://${link}?s=push`, stage: "cart_recovery" }).catch(() => false);
      if (ok) return { channel: "push" };
    }
    /* CR4: الإشعار فوق ببلاش ومش محسوب؛ واتساب والـSMS محسوبين ⇒ السقف مليان = سكوت (نهائي للسلة دي) */
    if (ctx.capReached) return { channel: null, reason: "weekly_cap" };
    /* CR3: واتساب قبل الـSMS. الـSMS بعده بس لو واتساب مايقدرش يوصل (smsAfterWa) ومفتاح البديل شغّال. */
    let waNote = null;
    if (cfg.waEnabled !== false && waOf()) {
      /* آخر نص ساعة قبل القفل (stopBeforeCloseMin): سكوت مش SMS — «كمّل طلبك» والمطبخ بيقفل أسوأ من السكوت. السلة بتستنى جوّه نافذتها. */
      if (ctx.waTime === false) return { channel: null, reason: "wa_closed_hours", retry: true };
      const w = await sendWa(row, step, cfg, s, flow, eligibleFirst);
      if (w.ok) return { channel: "whatsapp", messageId: w.wamid, cost: w.cost, waKind: w.kind, template: w.template || null };
      if (w.skipped === "burst_hold") return { channel: null, reason: "burst_hold", retry: true };
      waNote = `wa_${w.skipped || w.error || "failed"}${w.code ? ":" + w.code : ""}`.slice(0, 80);
      if (!smsAfterWa(w, s)) return { channel: null, reason: waNote };
      if (cfg.smsFallback === false) return { channel: null, reason: `${waNote}|sms_fallback_off` };
    }
    const why = (r) => (waNote ? `${waNote}|${r}` : r);
    if (cfg.smsEnabled !== true) return { channel: null, reason: why("sms_disabled") };
    /* الـSMS في ساعات الهدوء مابتطلعش (الدورة شغّالة دلوقتي عشان واتساب). واتساب ماتجرّبش ⇒ السلة تستنى الدورة الجاية؛
       واتساب اتجرّب وفشل ⇒ نهائي (مانعيدش محاولة واتساب فاشلة كل ٥ دقايق). */
    if (ctx.smsQuiet) return { channel: null, reason: why("sms_quiet"), retry: !waNote };
    const oc = await optout(pn);
    if (oc.opted_out_at) return { channel: null, reason: why("opted_out") };
    /* حاجب الإعلانات عند المشغّل: FreshCut-AD مابيوصلوش أصلاً (smsblock.js) —
       بنتحاسب على رسالة ماتوصلش. الإشعار فوق عدّى عادي. */
    const blocked = await pool.query("SELECT 1 FROM sms_ad_blocked WHERE phone_norm=$1", [pn]).then((r) => r.rowCount > 0).catch(() => false);
    if (blocked) return { channel: null, reason: why("ad_blocked") };
    /* CJ1a: العميل واصلته رسالة (واتساب أو SMS، من أي نظام) من أقل من waBot.burstHoldMin ⇒ مش دلوقتي. مفيش صف بيتحرق:
       recoveryTick بيمسح صف cart_recovery لما مفيش قناة اتبعتت، والسلة بتتعاد في الدورة الجاية طول ما هي جوّه نافذتها (CR3: retry). */
    const hold = await journeyHoldUntil((sql, p) => pool.query(sql, p).then((r) => r.rows), { phone: pn, cfg: (s || {}).waBot });
    if (hold) return { channel: null, reason: "burst_hold", retry: true };
    const body = cartSmsBody(step, eligibleFirst, link,
      { cfg: (s.cms || {}).campaigns, code: oc.optout_code, host: storeHost(), sender: process.env.TAQNYAT_SENDER_AD }, s);
    const parts = smsRules.smsParts(body);
    if (parts > 2) return { channel: null, reason: why("too_long") };
    if (!(await smsRoomToday(parts, s.cms))) return { channel: null, reason: why("daily_cap") };
    try {
      const info = await sendAdSms(pn, body, { kind: "cart_recovery", ref: `${flow.code}:${step}` });
      pool.query(`INSERT INTO cms_sms_daily(day, n) VALUES (CURRENT_DATE, $1)
                  ON CONFLICT (day) DO UPDATE SET n = cms_sms_daily.n + $1`, [parts]).catch(() => {});
      return { channel: "sms", ...info, ...(waNote ? { waNote } : {}) };
    } catch (e) {
      return { channel: null, reason: why("sms_failed: " + String(e.message).slice(0, 120)) };
    }
  }

  async function recoveryTick(now) {
    const s = await getSettingsData();
    const cfg = cartCfg(s);
    if (!cfg.enabled) return { skipped: "disabled" };
    if (cfg.respectOpenHours && !isOpenNow(s.hours, now)) return { skipped: "closed" };
    /* CR3: الـSMS والإشعار ليهم ساعات الهدوء (smsrules)؛ واتساب الآلي بمواعيد المطعم (sendhours.js، عمر ١٨/١٠) —
       الإعداد مقفول أو المواعيد مش متعرّفة ⇒ واتساب بساعات الهدوء القديمة زي الـSMS. */
    const smsQuiet = smsRules.inQuietFor(s, now);
    const openGate = isRestaurantOpenAt(now, s);
    const waTime = cfg.waEnabled ? (openGate === null ? !smsQuiet : openGate) : false;
    if (smsQuiet && !waTime) return { skipped: "quiet_hours" };
    const ctx = { smsQuiet, waTime };
    // في ساعات الهدوء الإشعار مابيطلعش (زي الأول لما الدورة كلها كانت بتقف) — الدورة شغّالة عشان واتساب بس
    const cfgNow = smsQuiet ? { ...cfg, pushEnabled: false } : cfg;
    const out = { step1: 0, step2: 0, skipped: 0 };
    const verified = cfg.requireVerifiedPhone
      ? `AND (EXISTS (SELECT 1 FROM acct_customers a WHERE a.phone_norm = c.phone_norm)
              OR EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm = c.phone_norm AND o.phone_verified_at IS NOT NULL))`
      : "";
    const mark = (device, step, reason, flowId) => pool.query(
      "UPDATE shop_carts SET rec_step=$2, rec_note=$3, rec_flow=COALESCE($4, rec_flow) WHERE device_id=$1",
      [device, step, reason || null, flowId || null]);

    /* خطوة ١ — السلة سكتت من sms1AfterMinutes ولسه جوّه نافذتها */
    const s1 = (await pool.query(
      `SELECT c.* FROM shop_carts c
        WHERE c.recovered_order IS NULL AND c.item_count > 0 AND c.phone_norm IS NOT NULL
          AND c.rec_step = 0 AND c.subtotal >= $1
          AND c.updated_at < $2::timestamptz - ($3 || ' minutes')::interval
          AND c.updated_at > $2::timestamptz - INTERVAL '3 days'
          ${verified}
        ORDER BY c.updated_at LIMIT 40`,
      [cfg.minSubtotal, now.toISOString(), String(cfg.sms1AfterMinutes)])).rows;
    for (const row of s1) {
      const ageMin = (now - new Date(row.updated_at)) / 60000;
      const paid = await orderedSince(row.phone_norm, new Date(new Date(row.updated_at).getTime() - 30 * 60000));
      if (paid) { await mark(row.device_id, 9, "ordered"); out.skipped++; continue; }
      if (ageMin > cfg.sms1AfterMinutes + cfg.sms1WindowMinutes) {
        await mark(row.device_id, -2, "step1_window_missed"); out.skipped++; continue; // خطوة ٢ ممكن تلحقه
      }
      /* CR4: السقف مليان والإشعار مش ممكن ⇒ من غير فلو. -1 = خلصت (مفيش خطوة ٢ للسلة دي) */
      const capReached = (await capUsed(row.phone_norm, cfg.cooldownDays, now)) >= cfg.maxPerWeek;
      if (capReached && !(cfgNow.pushEnabled !== false && notify)) { await mark(row.device_id, -1, "weekly_cap"); out.skipped++; continue; }
      const flow = await createFlow(row);
      const res = await sendStep(row, 1, cfgNow, s, flow, { ...ctx, capReached });
      if (!res.channel) {
        await pool.query("DELETE FROM cart_recovery WHERE id=$1", [flow.id]); // مااتبعتش حاجة = مايستهلكش الـ٧ أيام
        // CR3: سبب مؤقت (هدوء العميل / ساعات الـSMS) ⇒ السلة تفضل rec_step=0 وتتعاد الدورة الجاية لحد ما نافذتها تقفل
        if (res.retry) { await pool.query("UPDATE shop_carts SET rec_note=$2 WHERE device_id=$1", [row.device_id, res.reason]); out.skipped++; continue; }
        await mark(row.device_id, res.reason === "weekly_cap" ? -1 : -2, res.reason); out.skipped++; continue;
      }
      await pool.query(
        `UPDATE cart_recovery SET step1_channel=$2, step1_at=NOW(), step1_msg_id=$3, step1_cost=$4 WHERE id=$1`,
        [flow.id, res.channel, res.messageId || null, res.cost || 0]);
      await mark(row.device_id, 1, res.channel, flow.id);
      out.step1++;
    }

    /* خطوة ٢ — تاني يوم (بتوقيت الرياض) من sms2Hour، واتساب ثم SMS (CR3)، السلة ≥ sms2MinSubtotal */
    const rp = smsRules.riyadhParts(now);
    if (cfg.sms2Enabled && rp.hour >= cfg.sms2Hour) {
      const s2 = (await pool.query(
        `SELECT c.*, f.code AS flow_code, f.started_at AS flow_started FROM shop_carts c
           LEFT JOIN cart_recovery f ON f.id = c.rec_flow
          WHERE c.recovered_order IS NULL AND c.item_count > 0 AND c.phone_norm IS NOT NULL
            AND c.rec_step IN (1, -2) AND c.subtotal >= $1
            AND ((c.updated_at AT TIME ZONE 'Asia/Riyadh')::date + 1) = $2::date
            ${verified}
          ORDER BY c.updated_at LIMIT 40`, [cfg.sms2MinSubtotal, rp.day])).rows;
      for (const row of s2) {
        const paid = await orderedSince(row.phone_norm, new Date(new Date(row.updated_at).getTime() - 30 * 60000));
        if (paid) { await mark(row.device_id, 9, "ordered"); out.skipped++; continue; }
        /* CR4: خطوة ٢ كانت بتكمّل الفلو من غير أي تشييك — دلوقتي نفس السقف (واتساب/SMS للجوال في آخر cooldownDays يوم) */
        if ((await capUsed(row.phone_norm, cfg.cooldownDays, now)) >= cfg.maxPerWeek) { await mark(row.device_id, -3, "weekly_cap"); out.skipped++; continue; }
        let flow = row.rec_flow && row.flow_code ? { id: row.rec_flow, code: row.flow_code } : null;
        if (!flow) flow = await createFlow(row);
        const res = await sendStep(row, 2, cfgNow, s, flow, ctx);
        if (!res.channel) {
          if (!row.rec_flow) await pool.query("DELETE FROM cart_recovery WHERE id=$1", [flow.id]);
          if (res.retry) { await pool.query("UPDATE shop_carts SET rec_note=$2 WHERE device_id=$1", [row.device_id, res.reason]); out.skipped++; continue; }
          await mark(row.device_id, -3, res.reason); out.skipped++; continue;
        }
        await pool.query(
          `UPDATE cart_recovery SET step2_channel=$2, step2_at=NOW(), step2_msg_id=$3, step2_cost=$4 WHERE id=$1`,
          [flow.id, res.channel, res.messageId || null, res.cost || 0]);
        await mark(row.device_id, 2, res.channel, flow.id);
        out.step2++;
      }
    }
    if (out.step1 || out.step2) console.log(`[carts] recovery → step1 ${out.step1}, step2 ${out.step2}, skipped ${out.skipped}`);
    return out;
  }

  /* CR4: كام رسالة سلة (واتساب أو SMS — الإشعار مش محسوب) وصلت الجوال ده في آخر days يوم، من الخطوتين.
     روابط «نبّهني لما تفتحوا» (createRestoreFlow) مالهاش step channel ⇒ مش محسوبة. */
  async function capUsed(pn, days, now) {
    const r = await pool.query(
      `/*cr4:cap*/ SELECT (count(*) FILTER (WHERE step1_channel IN ('whatsapp','sms') AND step1_at > $2::timestamptz - ($3 || ' days')::interval)
            + count(*) FILTER (WHERE step2_channel IN ('whatsapp','sms') AND step2_at > $2::timestamptz - ($3 || ' days')::interval))::int AS n
         FROM cart_recovery WHERE phone_norm=$1 AND started_at > $2::timestamptz - ($3 || ' days')::interval - INTERVAL '3 days'`,
      [pn, now.toISOString(), String(days)]);
    return Number(r.rows && r.rows[0] && r.rows[0].n) || 0;
  }
  async function createFlow(row) {
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      // كود سلة جاهزة (المالك بيختاره) عمره ما يتاخد لرابط استرداد
      if (await presets.codeTaken(code).catch(() => false)) continue;
      const r = await pool.query(
        `INSERT INTO cart_recovery(code, phone_norm, device_id, subtotal, item_count, items, cart_raw, option)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO NOTHING RETURNING id, code`,
        [code, row.phone_norm, row.device_id, row.subtotal, row.item_count, jb(row.items || []), row.cart_raw ? jb(row.cart_raw) : null, row.option]);
      if (r.rowCount) return r.rows[0];
    }
    throw new Error("code collision");
  }

  const RECOVERY_MIN = Number(env("CART_RECOVERY_MINUTES", "5"));
  if (RECOVERY_MIN > 0) {
    setInterval(() => runRecovery().catch((e) => console.error("[carts] recovery failed:", e.message)),
      RECOVERY_MIN * 60_000);
  }

  /* ── رابط الاسترداد: freshcuts.sa/c/<code> ──
     البروكسي بينادي open (بيعدّ + بيبني رابط الهبوط)، والمتجر بينادي GET عشان
     يرجّع السلة بالظبط. الكود ٨ حروف عشوائية، صالح ٧ أيام، ومابيرجّعش الجوال. */
  const codeOk = (x) => /^[a-z0-9]{6,16}$/.test(String(x || ""));
  app.post("/api/carts/restore/:code/open", async (c) => {
    const code = String(c.req.param("code") || "").toLowerCase();
    if (!codeOk(code)) return c.json({ ok: false }, 404);
    let b = {};
    try { b = await c.req.json(); } catch {}
    const r = await pool.query(
      `UPDATE cart_recovery SET open_count = open_count + 1, opened_at = COALESCE(opened_at, NOW())
        WHERE code=$1 AND started_at > NOW() - INTERVAL '7 days'
        RETURNING phone_norm, step1_channel, step2_channel, step2_at`, [code]);
    const f = r.rows[0];
    if (!f) {
      /* مش رابط استرداد ⇒ يمكن سلة جاهزة: بتتفتح للأبد، والكوبون بيتحط دايماً
         (الأهلية بتتراجع في المتجر/الدفع). موقوفة أو مش موجودة = نفس الـ404. */
      let url = await presets.openPreset(code).catch(() => null);
      /* مش سلة إعلان ⇒ يمكن سلة جهّزها بوت واتساب للعميل («نفس طلبك الأخير») — wabotcart.js */
      if (!url && typeof deps.botCarts === "function") { const bc = deps.botCarts(); url = bc ? await bc.open(code).catch(() => null) : null; }
      return url ? c.json({ ok: true, url }) : c.json({ ok: false }, 404);
    }
    const cfg = cartCfg(await getSettingsData());
    const q = new URLSearchParams();
    q.set("cart", code);
    // CR3: زر القالب مايقدرش يشيل ?s= (متغيّر الزر حروف رابط بس) ⇒ القناة من الفلو نفسه
    const lastCh = f.step2_at ? f.step2_channel : f.step1_channel;
    q.set("utm_source", b.s === "push" ? "push" : (b.s === "wa" || lastCh === "whatsapp") ? "whatsapp" : "sms");
    q.set("utm_medium", "crm");
    q.set("utm_campaign", "cart_recovery");
    q.set("utm_content", f.step2_at ? "step2" : "step1");
    q.set("fc_link", "cart-recovery");
    if (cfg.autoFirst !== false && (await firstEligible(f.phone_norm))) q.set("c", "FIRST");
    return c.json({ ok: true, url: "/?" + q.toString() });
  });

  app.get("/api/carts/restore/:code", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited("restore:" + ip, 120)) return c.json({ ok: false, error: "rate_limited" }, 429);
    const code = String(c.req.param("code") || "").toLowerCase();
    if (!codeOk(code)) return c.json({ ok: false }, 404);
    const f = (await pool.query(
      `SELECT items, cart_raw, option, subtotal, order_no FROM cart_recovery
        WHERE code=$1 AND started_at > NOW() - INTERVAL '7 days'`, [code])).rows[0];
    if (!f) {
      let preset = await presets.restorePreset(code).catch(() => null);
      if (!preset && typeof deps.botCarts === "function") { const bc = deps.botCarts(); preset = bc ? await bc.restore(code).catch(() => null) : null; }
      return preset ? c.json(preset) : c.json({ ok: false, error: "expired" }, 404);
    }
    return c.json({ ok: true, items: f.items || [], raw: f.cart_raw || null, option: f.option,
      subtotal: Number(f.subtotal) || 0, ordered: Boolean(f.order_no) });
  });

  /* ── اللوحة: إعدادات + أرقام «السلات المتروكة» ── */
  app.get("/api/carts/recovery", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = cartCfg(await getSettingsData());
    const win = (col, days) => `${col} > (date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh') - INTERVAL '${days} days'`;
    const one = async (days) => {
      const [ab, fl] = await Promise.all([
        pool.query(
          `SELECT count(*)::int AS n, COALESCE(sum(subtotal),0)::float AS value FROM shop_carts
            WHERE phone_norm IS NOT NULL AND item_count > 0 AND ${win("updated_at", days)}
              AND updated_at < NOW() - INTERVAL '30 minutes'
              AND (recovered_order IS NULL OR recovered_at > updated_at + INTERVAL '30 minutes')`),
        pool.query(
          `SELECT count(*)::int AS flows,
                  count(*) FILTER (WHERE step1_channel='sms')::int + count(*) FILTER (WHERE step2_channel='sms')::int AS sms,
                  count(*) FILTER (WHERE step1_channel='push')::int AS push,
                  count(*) FILTER (WHERE step1_channel='whatsapp')::int + count(*) FILTER (WHERE step2_channel='whatsapp')::int AS wa,
                  count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
                  count(*) FILTER (WHERE order_no IS NOT NULL)::int AS recovered,
                  COALESCE(sum(order_total) FILTER (WHERE order_no IS NOT NULL),0)::float AS revenue,
                  COALESCE(sum(COALESCE(step1_cost,0) + COALESCE(step2_cost,0)),0)::float AS cost
             FROM cart_recovery WHERE ${win("started_at", days)}`),
      ]);
      return { abandoned: ab.rows[0].n, abandonedValue: Math.round(ab.rows[0].value), ...fl.rows[0] };
    };
    const [today, d7] = await Promise.all([one(0), one(6)]);
    return c.json({ ok: true, config: cfg, defaults: CART_DEFAULTS, today, d7, fields: CART_FIELDS, waTemplates: CART_WA_TEMPLATES });
  });

  app.put("/api/carts/recovery", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ ok: false, error: "bad body" }, 400);
    /* دمج مش استبدال (٢٩/٩): جسم ناقص كان بيرجّع باقي المفاتيح للافتراضي.
       بنتحقق على (المحفوظ + الجديد)، وبنكتب المفاتيح اللي اتبعتت بس فوق
       المحفوظ بـ|| جوّه jsonb_set — أي مفتاح تاني في abandonedCarts بيفضل مكانه. */
    const saved = ((await getSettingsData()) || {}).abandonedCarts || {};
    const val = cartCfg({ abandonedCarts: { ...saved, ...b } });
    const sent = Object.fromEntries(Object.keys(b).filter((k) => k in CART_DEFAULTS).map((k) => [k, val[k]]));
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{abandonedCarts}',
         COALESCE(data->'abandonedCarts','{}'::jsonb) || $1::jsonb, true) WHERE id=1`, [jb(sent)]);
    return c.json({ ok: true, config: val });
  });

  /* ── ADMIN: الأرقام اللي بتتقال في اللوحة ─────────────────────────── */
  app.get("/api/carts/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
    const r = (await pool.query(
      `WITH w AS (SELECT * FROM shop_carts WHERE updated_at > NOW() - ($1 || ' days')::interval)
       SELECT
         count(*)::int AS carts,
         count(*) FILTER (WHERE recovered_order IS NOT NULL)::int AS ordered,
         count(*) FILTER (WHERE recovered_order IS NULL AND item_count > 0)::int AS open_carts,
         count(*) FILTER (WHERE recovered_order IS NULL AND phone_norm IS NOT NULL)::int AS reachable,
         COALESCE(sum(subtotal) FILTER (WHERE recovered_order IS NULL AND item_count > 0),0)::numeric AS open_value,
         count(*) FILTER (WHERE max_stage='cart')::int AS s_cart,
         count(*) FILTER (WHERE max_stage='checkout')::int AS s_checkout,
         count(*) FILTER (WHERE max_stage='address')::int AS s_address,
         count(*) FILTER (WHERE max_stage='payment')::int AS s_payment,
         count(*) FILTER (WHERE max_stage='ordered')::int AS s_ordered,
         count(*) FILTER (WHERE in_webview IS NOT NULL)::int AS in_webview,
         count(*) FILTER (WHERE in_webview IS NOT NULL AND recovered_order IS NOT NULL)::int AS wv_ordered,
         count(*) FILTER (WHERE in_webview IS NULL AND recovered_order IS NOT NULL)::int AS br_ordered,
         count(*) FILTER (WHERE installed IS TRUE AND recovered_order IS NOT NULL)::int AS inst_ordered,
         count(*) FILTER (WHERE installed IS TRUE)::int AS installed,
         count(*) FILTER (WHERE push_ready IS TRUE)::int AS push_ready,
         count(*) FILTER (WHERE nudges @> '["push1"]'::jsonb)::int AS nudged_push,
         count(*) FILTER (WHERE nudges @> '["sms1"]'::jsonb)::int AS nudged_sms,
         count(*) FILTER (WHERE nudges <> '[]'::jsonb AND recovered_order IS NOT NULL)::int AS recovered_after_nudge
       FROM w`, [String(days)])).rows[0];
    const n = (v) => Number(v) || 0;
    const carts = n(r.carts), ordered = n(r.ordered);
    return c.json({
      ok: true, days,
      carts, ordered,
      conversionRate: carts ? ordered / carts : null,
      abandonRate: carts ? (carts - ordered) / carts : null,
      openCarts: n(r.open_carts), openValue: n(r.open_value), reachable: n(r.reachable),
      funnel: { cart: n(r.s_cart), checkout: n(r.s_checkout), address: n(r.s_address), payment: n(r.s_payment), ordered: n(r.s_ordered) },
      installed: n(r.installed), pushReady: n(r.push_ready),
      // الرقمين دول هما اللي بيبرروا (أو يلغوا) شغل التثبيت والهروب من
      // متصفح التطبيق: لو المثبّتين ما بيحوّلوش أحسن، نبطّل ندفعهم يثبتوا.
      inWebview: n(r.in_webview),
      webviewConv: n(r.in_webview) ? n(r.wv_ordered) / n(r.in_webview) : null,
      browserConv: (carts - n(r.in_webview)) ? n(r.br_ordered) / (carts - n(r.in_webview)) : null,
      installedConv: n(r.installed) ? n(r.inst_ordered) / n(r.installed) : null,
      nudgedPush: n(r.nudged_push), nudgedSms: n(r.nudged_sms), recoveredAfterNudge: n(r.recovered_after_nudge),
    });
  });

  /* السلة بتلحق الجهاز لما يخرج من متصفح إنستقرام للمتصفح الكامل (بيوصل
     بـ ?d=<deviceId>). من غير ده «افتح في المتصفح» بتبدأ من سلة فاضية —
     وساعتها الحركة بتخسر أكتر ما بتكسب. */
  app.get("/api/carts/mine", async (c) => {
    const device = String(c.req.query("deviceId") || "").slice(0, 64);
    if (!/^[a-z0-9_-]{8,64}$/i.test(device)) return c.json({ ok: false }, 400);
    const r = await pool.query(
      `SELECT items, option, subtotal FROM shop_carts
        WHERE device_id=$1 AND recovered_order IS NULL AND item_count > 0
          AND updated_at > NOW() - INTERVAL '2 days'`, [device]);
    return c.json({ ok: true, cart: r.rows[0] || null });
  });

  app.get("/api/carts/list", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT device_id, phone_norm, stage, max_stage, item_count, subtotal, option, has_location,
              installed, push_ready, in_webview, nudges, recovered_order, created_at, updated_at, items
         FROM shop_carts
        WHERE recovered_order IS NULL AND item_count > 0
        ORDER BY subtotal DESC, updated_at DESC LIMIT 100`)).rows;
    return c.json({ ok: true, carts: rows });
  });

  /* رابط استرداد لأي موديول تاني (openwait.js: «نبّهني لما تفتحوا»).
     نفس جدول cart_recovery ونفس صفحة /c/<code> — مفيش نسخة تانية من
     منطق «رجّع السلة زي ما هي». */
  async function createRestoreFlow({ phoneNorm, deviceId, subtotal, itemCount, items, raw, option }) {
    if (!/^5\d{8}$/.test(String(phoneNorm || ""))) throw new Error("bad_phone");
    // rawCart بترجّع نص JSON (زي اللقطة)؛ createFlow بتعمل jb() فبنرجّعه كائن
    const rawTxt = rawCart(raw);
    let rawObj = null;
    try { rawObj = rawTxt ? JSON.parse(rawTxt) : null; } catch { rawObj = null; }
    return createFlow({
      phone_norm: phoneNorm, device_id: deviceId || null,
      subtotal: Number(subtotal) || 0, item_count: Number(itemCount) || 0,
      items: Array.isArray(items) ? items.slice(0, 60) : [],
      cart_raw: rawObj, option: option ? String(option).slice(0, 12) : null,
    });
  }

  return { markOrdered, runRecovery, createRestoreFlow };
}
