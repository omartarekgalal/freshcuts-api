/* ═══════════════════════════════════════════════════════════════════════════
   💬 رسايل واتساب للعميل — دوال صافية (مرحلة ٠ لترقية الرسايل، ٢٦/٩)

   قرار عمر: الرسايل رايحة لعملاء سعوديين في جدة ⇒ نص العميل لازم يبقى
   سعودي/محايد («أمس/اليوم/قبل شهرين/قبل 3 أسابيع/وغيرها»)، مش مصري
   («امبارح/النهاردة/تانية/شهور»). نص اللوحة نفسها يفضل مصري زي ما هو.

   هنا:
   • agoSa           — «من امتى» بالسعودي لنص الرسالة
   • cleanItemName   — اسم سطر نقطة البيع → اسم يتقري («كفتة مشوية بالوزن - ثلث كيلو» → «كفتة مشوية ثلث كيلو»)
   • isDishName      — طبق حقيقي؟ (مش مية/بيبسي/رز/بطاطس/إضافة/توصيل)
   • favDish         — الطبق المفضّل (عدد × حداثة) + مجموعته (smsrules.foodGroup)
   • isOptOutText    — رد العميل «إيقاف» على واتساب
   • creditOrders    — كل طلب بيتحسب مرة واحدة لآخر رسالة واتساب قبله (خلال ٧ أيام)
   • summarizeResults— المُرسل مقابل المحجوز (holdout) + الطلبات الزيادة
═══════════════════════════════════════════════════════════════════════════ */
import { foodGroup, foodGroupOf } from "./smsrules.js";

const DAY = 86400000;
const nz = (v) => (v == null ? "" : String(v));

/* ── «من امتى» بالسعودي ─────────────────────────────────────────────────── */
export function agoSa(iso, now = Date.now()) {
  const t = iso instanceof Date ? iso.getTime() : Date.parse(nz(iso));
  if (!Number.isFinite(t)) return "";
  const d = Math.floor((now - t) / DAY);
  if (d <= 0) return "اليوم";
  if (d === 1) return "أمس";
  if (d === 2) return "قبل يومين";
  if (d < 7) return `قبل ${d} أيام`;
  if (d < 14) return "قبل أسبوع";
  if (d < 21) return "قبل أسبوعين";
  if (d < 31) return `قبل ${Math.min(4, Math.round(d / 7))} أسابيع`;
  if (d < 60) return "قبل شهر";
  if (d < 90) return "قبل شهرين";
  const m = Math.round(d / 30);
  if (m <= 10) return `قبل ${m} أشهر`;
  if (d < 540) return "قبل سنة تقريباً";
  return "من فترة طويلة";
}

/* ── أسماء نقطة البيع الإنجليزي (طلبات كيتا غالباً) → الاسم العربي في المنيو.
   بس الأسماء اللي متأكدين من مقابلها (موجودة جنب بعض في ts_order_items).
   اسم إنجليزي مش هنا = مابيدخلش نص الرسالة (مانكتبش «Kofta Meal» لعميل). */
const EN_AR = {
  "mix grill meal": "وجبة ميكس جريل", "half charcoal chicken meal": "وجبة نصف دجاجة على الفحم",
  "whole charcoal chicken meal": "وجبة دجاجة كاملة على الفحم", "kofta meal": "وجبة كفتة",
  "kofta and tarb meal": "وجبة كفتة وطرب", "tarb meal": "وجبة طرب", "shish tawook meal": "وجبة شيش طاووق",
  "grilled chicken breast meal": "وجبة صدور مشوية", "alexandrian liver meal": "طبق كبدة اسكندراني",
  "penne chicken casserole": "بنا تشيكن كازرول", "penne beef casserole": "بنا بيف كازرول",
  "seafood casserole pasta": "سي فود كازرول", "pasta béchamel": "باستا بشاميل", "pasta bechamel": "باستا بشاميل",
  "seafood alfredo": "سي فود الفريدو", "mac and cheese": "ماك اند تشيز", "negresco": "نجرسكو",
  "zinger supreme crepe": "كريب زنجر سوبريم", "super crunchy crepe": "كريب سوبر كرانشي",
  "mixed chicken crepe": "كريب ميكس دجاج", "mixed meat crepe": "كريب ميكس لحوم",
  "chicken fajita crepe": "كريب فاهيتا دجاج", "shish tawook crepe": "كريب شيش طاووق",
  "chicken strips crepe": "كريب ستربس", "hot dog crepe": "كريب هوت دوج", "potato crepe": "كريب بطاطس",
  "plain hawawshi": "حواوشي سادة", "mozzarella hawawshi": "حواوشي موتزريلا", "kiri pastrami hawawshi": "حواوشي كيري بسطرمة",
  "chicken ranch pizza": "بيتزا تشيكن رانش", "margherita pizza": "بيتزا مارجريتا", "quattro cheese pizza": "بيتزا كواترو تشيز",
  "super supreme pizza": "بيتزا سوبر سوبريم", "chicken patcino pizza": "بيتزا تشيكن الباتشينو",
  "super crunchy pizza": "بيتزا سوبر كرانشي", "vegetable pizza": "بيتزا خضروات", "chicken bbq pizza": "بيتزا تشيكن باربكيو",
  "pepperoni pizza": "بيتزا بيبروني", "tuna pizza": "بيتزا تونة", "chicken dynamite pizza": "بيتزا تشيكن ديناميت",
  "classic beef burger": "برجر لحم كلاسيك", "mushroom bacon burger": "مشروم بيف بيكون برجر",
  "grilled chicken sandwich burger": "جريلد تشيكن ساندوتش",
  "crunchy skillet": "طاسة كرانشي", "burger skillet": "طاسة برجر", "grilled chicken breast skillet": "طاسة صدور مشوية",
};
const LATIN = /[A-Za-z]/;
const ARABIC = /[؀-ۿ]/;

/* اسم سطر → اسم يتقري في رسالة.
   «كفتة مشوية بالوزن - ثلث كيلو» → «كفتة مشوية ثلث كيلو»
   «بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري» → «بيتزا تشيكن رانش»
   «Kofta Meal» → «وجبة كفتة»، «Fire Bird Chicken Burger» → "" (مش معروف) */
export function cleanItemName(raw, { withSize = true } = {}) {
  let s = nz(raw).replace(/\s+/g, " ").trim();
  if (!s) return "";
  // لاحقة خيارات نقطة البيع: « 1.0 حشو اطراف كيري» / « 1.0 Add» / « 1.0 مشروب + بطاطس»
  s = s.replace(/\s+\d+(?:\.\d+)?(?:\s.*)?$/, "").trim();
  if (LATIN.test(s) && !ARABIC.test(s)) {
    const k = s.replace(/\s*-\s*(m|l|s|medium|large|small)$/i, "").trim().toLowerCase();
    return EN_AR[k] || "";
  }
  // الوزن: «بالوزن - ثلث كيلو» → « ثلث كيلو»
  const w = s.match(/\s*-\s*((?:ثلث|نصف|نص|ربع)?\s*كيلو)\s*$/);
  s = s.replace(/\s*-\s*.*$/, "");                 // أي « - وسط/كان/M» بعد كده
  s = s.replace(/\s*بالوزن(?=\s|$)/g, "").replace(/\s+/g, " ").trim();
  if (withSize && w) s = `${s} ${w[1].replace(/\s+/g, " ").trim()}`;
  return s.trim();
}

const DRINK_RE = /مياه|مياة|^ماء|water|مشروب|بيبسي|pepsi|كولا|cola|soft ?drink|عصير|juice|سفن|seven|ميرندا|mirinda|شاي|tea\b|قهو|coffee|كان$/i;
const ADDON_RE = /إضاف|اضاف|أضاف|\badd\b|كومبو|كمبو|combo|توصيل|رسوم|خدمه|خدمة|فرق كاش|تامين|تأمين|حشو اطراف/i;
const SIDE_RE = /بطاطس|فرايز|fries|أرز|ارز|^رز|عيش|خبز|سلط|كلوسلو|coleslaw|طحين|صوص|ثومي|مخلل|حلقات بصل|onion|دوريتوس|موتزريلا|جبن|شوربه|شوربة|ملوخي/i;

/* طبق حقيقي؟ المجموعة (كريب/بيتزا/مشاوي…) بتكسب — «كريب بطاطس» كريب مش بطاطس */
export function isDishName(raw) {
  const n = nz(raw).trim();
  if (!n) return false;
  if (DRINK_RE.test(n) || ADDON_RE.test(n)) return false;
  if (foodGroup(n)) return true;
  return !SIDE_RE.test(n);
}

/* أصناف الطلب في جملة: صنفين بالكتير وبعدين «وغيرها». الأطباق الأول؛
   لو الطلب كله مشروبات/جوانب بنكتبها زي ما هي. */
export function itemsPhraseSa(names, max = 2) {
  const raw = (names || []).map((x) => nz(x).trim()).filter(Boolean);
  const dish = raw.filter(isDishName);
  const base = (dish.length ? dish : raw.filter((x) => !ADDON_RE.test(x)));
  const list = [];
  for (const x of base) {
    const c = cleanItemName(x);
    if (c && !list.includes(c)) list.push(c);
  }
  if (!list.length) return "";
  if (list.length <= max) return list.join(" و");
  return `${list.slice(0, max).join(" و")} وغيرها`;
}

/* الطبق المفضّل: كل سطر طبق في آخر الطلبات بوزن الحداثة (١ ÷ (١ + الأيام/٣٠)).
   hist = [{at, names:"a|b|c"}] من الأحدث للأقدم. الاسم من غير الحجم
   («كفتة مشوية» مش «كفتة مشوية ثلث كيلو») عشان الأحجام تتجمّع. */
export function favDish(hist, now = Date.now()) {
  const score = new Map();
  const groups = {};
  for (const o of hist || []) {
    const t = Date.parse(nz(o.at));
    const age = Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : 90;
    const w = 1 / (1 + age / 30);
    for (const n of nz(o.names).split("|")) {
      if (!isDishName(n)) continue;
      const c = cleanItemName(n, { withSize: false });
      if (!c) continue;
      score.set(c, (score.get(c) || 0) + w);
      const g = foodGroup(c) || foodGroup(n);
      if (g) groups[g] = (groups[g] || 0) + w;
    }
  }
  let dish = "", best = 0;
  for (const [k, v] of score) if (v > best + 1e-9) { dish = k; best = v; }
  let group = null, gb = 0;
  for (const [k, v] of Object.entries(groups)) if (v > gb + 1e-9) { group = k; gb = v; }
  return { dish, group, groupLabel: group ? (foodGroupOf(group)?.label || "") : "" };
}

/* ── المتغيرات المتاحة في نص حملة واتساب ─────────────────────────────── */
export const TEMPLATE_VARS = Object.freeze([
  { key: "name", label: "اسم العميل", example: "محمد العتيبي" },
  { key: "first_name", label: "الاسم الأول", example: "محمد" },
  { key: "last_items", label: "أصناف آخر طلب", example: "كفتة مشوية ثلث كيلو وكريب زنجر سوبريم" },
  { key: "last_when", label: "امتى آخر طلب", example: "قبل 3 أسابيع" },
  { key: "fav_dish", label: "طبقه المفضّل", example: "كريب زنجر سوبريم" },
  { key: "fav_group", label: "نوع أكله", example: "كريب" },
  { key: "link", label: "رابط الحملة (متتبّع لكل عميل)", example: "freshcuts.sa/l/w12-a1b2c3" },
  { key: "coupon", label: "الكوبون", example: "W12K7Q2M" },
  { key: "coupon_days", label: "صلاحية الكوبون بالأيام", example: "7" },
  { key: "site", label: "الموقع", example: "freshcuts.sa" },
]);
export const renderTemplate = (tpl, vars) =>
  nz(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : ""))
    .replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").trim();
export function templateProblem(tpl) {
  const t = nz(tpl).trim();
  if (!t) return null;                                   // فاضي = القالب العام
  if (!/\{(name|first_name)\}/.test(t)) return "name_required";
  if (t.length > 1200) return "too_long";
  const known = new Set(TEMPLATE_VARS.map((v) => v.key));
  const bad = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !known.has(k));
  return bad.length ? `unknown_var:${bad[0]}` : null;
}

/* ── رد «إيقاف» على واتساب ─────────────────────────────────────────────
   نفس كلمات whatsapp.js (STOP_RE) — الرسالة كلها لازم تبقى الكلمة، بعد ما
   نشيل التشكيل والرموز. «ممكن ايقاف الطلب؟» مش إيقاف رسايل. وجمل صريحة
   قليلة زي «لا ترسلوا لي رسائل». */
const STOP_WORDS = /^(stop|unsubscribe|ايقاف|ايقاف العروض|ايقاف الرسائل|ايقاف الرسايل|الغاء|الغاء الاشتراك|وقف|وقف الرسائل|وقف الرسايل|قف)$/i;
const STOP_PHRASES = [
  /^(لا|ما)\s*(ترسل|ترسلو|ترسلوا|ترسلون|ترسلي|ترسلني|ترسلوني|تراسلني|تراسلوني)\s*(لي|علي)?\s*(رسائل|رسايل|رساله|عروض|شي)?$/,
  /^(لا|ما)\s*(ابي|ابغى|ابغا|ودي)\s*(رسائل|رسايل|رسايلكم|رسائلكم|عروض|عروضكم)$/,
];
export function isOptOutText(text) {
  const t = nz(text)
    .replace(/[ً-ْـ]/g, "")                 // تشكيل وتطويل
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")                       // رموز وإيموجي
    .replace(/\s+/g, " ").trim();
  if (!t || t.length > 40) return false;
  return STOP_WORDS.test(t) || STOP_PHRASES.some((re) => re.test(t));
}

/* ── روابط لكل عميل: /l/<slug>-<code> ─────────────────────────────────── */
export const LINK_CODE_RE = /^[a-z0-9]{6}$/;
export function parseRecipientSlug(slug) {
  const m = /^([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)-([a-z0-9]{6})$/.exec(nz(slug).toLowerCase());
  return m ? { base: m[1], code: m[2] } : null;
}
export const recipientLink = (host, slug, code) =>
  `${nz(host).replace(/^https?:\/\//, "").replace(/\/+$/, "")}/l/${slug}${code ? `-${code}` : ""}`;

/* ── التجميع التدريجي (اختياري، مقفول افتراضياً) ──────────────────────
   الخط مستقر ومشغول، فالسقف الحالي (٤٠/يوم) هو الافتراضي. لو اتفعّل:
   السقف = من (from) + خطوة × الأيام من بداية التجميع، ومايعدّيش dailyCap. */
export function effectiveDailyCap(cfg, now = Date.now()) {
  const cap = Number(cfg?.dailyCap) || 40;
  const w = cfg?.warmup;
  if (!w || w.enabled !== true || !w.startedAt) return cap;
  const t = Date.parse(w.startedAt);
  if (!Number.isFinite(t)) return cap;
  const days = Math.max(0, Math.floor((now - t) / DAY));
  return Math.max(1, Math.min(cap, (Number(w.from) || 10) + (Number(w.step) || 5) * days));
}

/* ── النسب: كل طلب لآخر رسالة واتساب قبله ──────────────────────────────
   sends  = [{pn, at, jobId}] كل رسايل الواتساب (كل الحملات + اليدوي jobId=null)
   orders = [{pn, at, key, total, channel}]
   ⇒ Map(order.key → send) لآخر رسالة at ≤ order.at وفي خلال windowDays. */
export function creditOrders(sends, orders, windowDays = 7) {
  const byPn = new Map();
  for (const s of sends || []) {
    const t = Date.parse(s.at instanceof Date ? s.at.toISOString() : s.at);
    if (!Number.isFinite(t)) continue;
    if (!byPn.has(s.pn)) byPn.set(s.pn, []);
    byPn.get(s.pn).push({ ...s, t });
  }
  for (const l of byPn.values()) l.sort((a, b) => a.t - b.t);
  const out = new Map();
  const W = windowDays * DAY;
  for (const o of orders || []) {
    const t = Date.parse(o.at instanceof Date ? o.at.toISOString() : o.at);
    const l = byPn.get(o.pn);
    if (!l || !Number.isFinite(t)) continue;
    let hit = null;
    for (const s of l) { if (s.t <= t) hit = s; else break; }
    if (hit && t - hit.t <= W) out.set(o.key, hit);
  }
  return out;
}

/* طلبات نقطة البيع اللي هي نفسها طلب موقع (نفس الجوال، الإجمالي ±1.5،
   من ساعة قبل لـ٦ ساعات بعد) — نفس قاعدة customer360 عشان مانعدّش مرتين. */
export function dropPosMirrors(posOrders, webOrders) {
  const web = (webOrders || []).map((w) => ({ pn: w.pn, t: Date.parse(w.at instanceof Date ? w.at.toISOString() : w.at), total: Number(w.total) || 0 }));
  return (posOrders || []).filter((p) => {
    const t = Date.parse(p.at instanceof Date ? p.at.toISOString() : p.at);
    return !web.some((w) => w.pn === p.pn && Math.abs(w.total - (Number(p.total) || 0)) < 1.5
      && t >= w.t - 3600e3 && t <= w.t + 6 * 3600e3);
  });
}

/* sentN/holdN = عدد الناس، orders = طلبات الناس دول (بعد النسب) */
export function summarizeResults({ sentN, holdN, sentOrders, holdOrders }) {
  const conv = (orders, n) => {
    const people = new Set(orders.map((o) => o.pn)).size;
    return { people, orders: orders.length, revenue: Math.round(orders.reduce((s, o) => s + (Number(o.total) || 0), 0)),
      rate: n ? Math.round((people / n) * 1000) / 10 : null };
  };
  const s = conv(sentOrders, sentN), h = conv(holdOrders, holdN);
  const perS = sentN ? sentOrders.length / sentN : 0;
  const perH = holdN ? holdOrders.length / holdN : null;
  const incremental = perH == null ? null : Math.round((perS - perH) * sentN * 10) / 10;
  return { sent: s, holdout: h, liftPts: h.rate == null || s.rate == null ? null : Math.round((s.rate - h.rate) * 10) / 10, incremental };
}
