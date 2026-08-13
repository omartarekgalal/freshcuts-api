/* ═══════════════════════════════════════════════════════════════════════════
   SCORECARD — لوحة الأهداف. الحكم على التسويق بنتيجة المطعم، مش بكلام المنصات.

   ── ليه الملف ده موجود ────────────────────────────────────────────────────
   المالك قال الجملة دي بالحرف: «انت تتبعك للطلبات غير حقيقي لأن العمليات
   كلها بتتم أوفلاين». وهو محق، والداتا بتثبته: في آخر ٣٠ يوم عندنا ٩٤٤ طلب،
   ٧٤٧ منهم معاهم رقم جوال، وتمنية بس من الأرقام دي ظهرت في فنل الموقع.
   وميتا بتستقبل الشرا اللي بيتقفل على الكاشير كـ action_source=physical_store،
   وأنواع التحويل الأوفلاين اتشالت من v20 — يعني عمود «الشرا» عندها هيفضل
   صفر للأبد. مش عطل: ده الوصف الصح لمطعم بيبيع على الدرج.

   فالنتيجة: **لوحة الأهداف دي هي الكشف، وأرقام المنصات هامش على الصفحة.**
   كل رقم هنا مصدره ts_orders / ts_customers / order_sources / ts_order_items
   (كلها من TabSense وموصل FeedUs) — ولا رقم واحد جاي من منصة إعلانات إلا
   الصرف نفسه، وهو الحاجة الوحيدة اللي المنصة بتعرفها أكتر مننا.

   ── القواعد ───────────────────────────────────────────────────────────────
   ١) مفيش رقم مخترع ولا مصنفر. أي حاجة مش قادرين نحسبها بترجع «غير متاح»
      ومعاها السبب في `unavailable`. صفر معناه قِسنا ولقينا لا شيء.
   ٢) التعريفات مش بتتكتب هنا تاني. «عميل جديد»، «يوم المطعم»، «ده طلب تطبيق
      توصيل» — كلها بتتستورد من analytics.js. نسخة تانية من أي تعريف منهم =
      شاشتين بيختلفوا على نفس اليوم.
   ٣) حدود اليوم مكتوبة على كل رقم بيخلط صرف بمبيعات: المبيعات على يوم
      المطعم (٤ الفجر بجدة)، وصرف ميتا على America/Los_Angeles (بيلف ١٠
      صباحاً بجدة).

   ENDPOINTS
     GET  /api/scorecard/day?date=YYYY-MM-DD
     GET  /api/scorecard/range?from=&to=
     GET  /api/scorecard/targets
     PUT  /api/scorecard/targets      { goalDailySales, categoryTargets, levers, openWindow }
═══════════════════════════════════════════════════════════════════════════ */

import {
  FIRST_ORDER_DAY_CTE, SALES_ONLY, IDENT_SQL, deliverySql, channelSql,
  LOCAL_HOUR, chLabel, BIZ_DAY_START_HOUR,
} from "./analytics.js";

/* ── أدوات رقمية صغيرة ───────────────────────────────────────────────────── */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(num(v) * 100) / 100;
const r2 = (v) => Math.round(num(v) * 100) / 100;
const rate = (v) => (v == null ? null : Math.round(num(v) * 10000) / 10000);
// نسبة بجواب «مش معروف» صريح. رجوع null (مش صفر ولا Infinity) هو المقصود:
// الواجهة لازم تعرف تكتب «—» بدل ما تخترع ٠٪.
const ratio = (a, b) => (num(b) === 0 ? null : rate(num(a) / num(b)));
const delta = (cur, base) => (base == null || num(base) === 0 ? null : rate((num(cur) - num(base)) / num(base)));
const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => typeof v === "string" && DAY_RE.test(v);
const shiftDay = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);
// اليوم الحالي بقاعدة يوم المطعم. الرياض = UTC+3 ثابت، مفيش توقيت صيفي.
const bizToday = () =>
  new Date(Date.now() + 3 * 3600_000 - BIZ_DAY_START_HOUR * 3600_000).toISOString().slice(0, 10);
const DOW_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const dowOf = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();

/* ═══════════════════════════════════════════════════════════════════════════
   ١) تصنيف الأصناف — «لازم نتعامل مع كل فئة بتفاصيلها»

   المالك عدّ سبع فئات بالاسم: بيتزا · باستا · كريب · مشاوي · حواوشي · برجر ·
   مقبلات. الفئات دي مش مخترعة هنا — دي صفحات المنيو الحقيقية زي ما نقطة البيع
   مسجّلاها في cw_pos_products.category_ar:

     بيتزا→بيتزا · باستا→باستا · كريبات→كريب · وجبات→مشاوي ·
     سندوتشات→حواوشي (التلات أصناف اللي في الصفحة دي كلها حواوشي) ·
     برجر→برجر · مقبلات→مقبلات

   وفاضل تلات صفحات مالهاش هدف من المالك بس لازم تتعدّ عشان المجموع يقفل:
   طاسات، مشروبات، العروض. وبعدين الحاجات اللي مش أكل أصلاً: رسوم التوصيل،
   الإضافات، وسطور المودِفاير (حشو الأطراف) اللي بتتسجّل كسطر بقيمة صفر.

   ── ليه مش مجرد JOIN على اسم المنتج ──────────────────────────────────────
   لأن الاسم اللي بيتسجّل على الطلب مش هو الاسم اللي في الكتالوج:
     «بيتزا تشيكن رانش - وسط»            → مقاس متلزق في الآخر
     «بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري» → سطر مودفاير بقيمة صفر
     «مشكل مخصوص بالوزن - نصف كيلو»       → وزن
     «Chicken Ranch Pizza - M»            → نفس الصنف بالإنجليزي
     «مياة» / «مياه»                      → غلطة إملائية في الكاشير
   فالتصنيف بيمرّ بتلات مراحل: قواعد قبلية (مودفاير/رسوم/إضافات)، ثم مطابقة
   بالاسم المطبّع مع كتالوج نقطة البيع، ثم قواعد كلمات مفتاحية للذيل. وأي
   اسم ما اتصنّفش بيتحط في «غير مصنّف» بقيمته — مش بيتوزّع ولا بيتخفي.
═══════════════════════════════════════════════════════════════════════════ */

export const CATEGORIES = [
  { id: "pizza", label: "بيتزا", pos: "بيتزا", owner: true },
  { id: "pasta", label: "باستا", pos: "باستا", owner: true },
  { id: "crepe", label: "كريب", pos: "كريبات", owner: true },
  { id: "grill", label: "مشاوي", pos: "وجبات", owner: true },
  { id: "hawawshi", label: "حواوشي", pos: "سندوتشات", owner: true },
  { id: "burger", label: "برجر", pos: "برجر", owner: true },
  { id: "appetizers", label: "مقبلات", pos: "مقبلات", owner: true },
  { id: "skillet", label: "طاسات", pos: "طاسات", owner: false },
  { id: "drinks", label: "مشروبات", pos: "مشروبات", owner: false },
  { id: "offers", label: "عروض", pos: "العروض", owner: false },
  { id: "extras", label: "إضافات وأطباق جانبية", pos: null, owner: false },
  { id: "other", label: "غير مصنّف", pos: null, owner: false },
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
export const OWNER_CATEGORIES = CATEGORIES.filter((c) => c.owner).map((c) => c.id);
// سطور مش أكل: بتتشال من حصص الفئات وبتتعدّ لوحدها.
export const NON_FOOD = new Set(["fee", "modifier"]);
const POS_TO_CAT = Object.fromEntries(CATEGORIES.filter((c) => c.pos).map((c) => [c.pos, c.id]));

const AR_MARKS = /[ً-ٰٓـ]/g;
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** تطبيع اسم صنف: بيشيل التشكيل، بيوحّد الألف والياء والتاء المربوطة، بيحوّل
 *  الأرقام العربية، وبيشيل أي علامة ترقيم. النتيجة مفتاح مقارنة، مش اسم عرض. */
export function normItemName(raw) {
  let s = String(raw ?? "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .toLowerCase()
    .replace(AR_MARKS, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** الاسم من غير المقاس/الوزن/المودفاير — «بيتزا تشيكن رانش - وسط» → «بيتزا
 *  تشيكن رانش». بيتقص على « - » الأولى وعلى أول رقم منفصل. */
export function baseItemName(raw) {
  let s = String(raw ?? "");
  const dash = s.indexOf(" - ");
  if (dash > 0) s = s.slice(0, dash);
  s = s.replace(/\s+\d+(\.\d+)?(\s.*)?$/, "");
  return normItemName(s);
}

/** كتالوج نقطة البيع كخريطة اسم مطبّع → فئة. بيتبني مرة كل طلب. */
export function buildPosMap(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const cat = POS_TO_CAT[String(r.category_ar || "").trim()];
    if (!cat) continue;
    for (const n of [r.name_ar, r.name_en]) {
      if (!n) continue;
      const full = normItemName(n), base = baseItemName(n);
      if (full && !m.has(full)) m.set(full, cat);
      if (base && !m.has(base)) m.set(base, cat);
    }
  }
  return m;
}

/* قواعد الكلمات المفتاحية للذيل — الترتيب مقصود. «كريب كفته» كريب مش مشاوي،
   و«بيتزا برجر» بيتزا مش برجر، عشان كده الأخص بيتفحص الأول. */
const KEYWORD_RULES = [
  ["pizza", /بيتزا|pizza/],
  ["crepe", /كريب|crepe/],
  ["hawawshi", /حواوشي|hawawshi/],
  ["pasta", /باستا|pasta|الفريدو|alfredo|كازرول|casserole|نجرسكو|negresco|ماك اند تشيز|mac and cheese|بنا |penne|فتوتشيني|fettu|سباجيتي|spaghetti|لازانيا|lasagn/],
  // «طاسة برجر» طاسة، فالطاسة لازم تتفحص قبل البرجر.
  ["skillet", /طاسه|skillet/],
  ["burger", /برجر|burger|سندوتش|sandwich/],
  ["appetizers", /بطاطس|فرايز|fries|كلوسلو|coleslaw|دوريتوس|dorito|حلقات بصل|onion ring|فرايد|fried|موتزريلا|mozzarella|سلطه|salad|ناجتس|nugget/],
  ["drinks", /مياه|water|بيبسي|pepsi|مشروب|soft drink|كولا|cola|عصير|juice|شاي\b|قهوه|coffee/],
  ["offers", /صينيه|offer/],
  ["grill", /وجبه|meal|مشوي|مشويه|grill|فحم|charcoal|كفته|kofta|طرب|tarb|كباب|kabab|كبده|liver|شيش|tawook|ريش|rib|سجق|sausage|مشكل|mix|دجاجه|chicken|ملوخيه/],
  // الأرز والخبز أطباق جانبية بتتطلب مع المشاوي — بتتحسب مقبلات زي ما
  // menuplan.js بيصنّفها، عشان نسبة الاقتران تقرا واحدة على الشاشتين.
  ["appetizers", /ارز|rice|خبز|bread/],
  ["extras", /صوص|sauce/],
];

/** فئة سطر واحد. بيرجّع id فئة، أو "modifier" لسطور الحشو/بدون الحشو، أو
 *  "fee" لرسوم التوصيل، أو "other" لو محدش عرفه. */
export function classifyItem(raw, posMap) {
  const full = normItemName(raw);
  const base = baseItemName(raw);
  if (!full) return "other";

  // (أ) قواعد قبلية — لازم تسبق الكتالوج. «إضافة كومبو» مسجّلة في نقطة البيع
  //     تحت صفحة «كريبات»، فلو سألنا الكتالوج الأول كانت الإضافة هتتحسب كريب
  //     وتضخّم عدد طلبات الكريب.
  if (/حشو اطراف|بدون حشو/.test(full)) return "modifier";
  // «إضافة كومبو» = بطاطس ومشروب متسجّلين كسطر واحد، فبتتحسب مقبلات — نفس
  // اللي بيعمله menuplan.js عشان الشاشتين ما يختلفوش على نسبة الاقتران.
  if (/كومبو|combo/.test(full)) return "appetizers";
  if (/^اضاف/.test(base)) return "extras";
  if (/^توصيل$/.test(base) || /delivery fee/.test(full)) return "fee";

  // (ب) كتالوج نقطة البيع — المصدر الرسمي.
  const hit = posMap.get(base) || posMap.get(full);
  if (hit) return hit;

  // (ج) الذيل.
  for (const [cat, re] of KEYWORD_RULES) if (re.test(full)) return cat;
  return "other";
}

/* ═══════════════════════════════════════════════════════════════════════════
   ٢) القنوات — «صالة · سفري · توصيل المطعم · تطبيقات التوصيل»

   القاعدة اللي في analytics.js بتفرز «تطبيق توصيل» عن «داخل المطعم» بس.
   المالك عايز الجوّاني متفصّل، والفرز الجوّاني الوحيد المتاح هو
   ts_orders.order_option — وده حقل موجود فعلاً وبقيم واضحة:
   'Dine in' / 'Take away' / 'توصيل Delivery'.

   ── بس بصراحة عن حدوده ────────────────────────────────────────────────────
   • على طلبات التطبيقات الحقل ده **بيكذب**: في يوليو كل طلبات External
     كانت متسجّلة 'Dine in'، وفي أغسطس بقت 'Take away'. عشان كده بنقراه
     لطلبات المطعم بس، وطلب التطبيق بياخد اسم تطبيقه من قاعدة القنوات
     الأصلية ولا بنبص لـ order_option عنده خالص.
   • حتى جوّه المطعم فيه تضارب مقاس: في طلبات نوعها 'Table' (يعني اتفتحت على
     ترابيزة) و order_option بتاعها 'Take away'. بنقيس النسبة دي كل مرة
     وبنرجّعها في `reliability` — لو عدّت الربع يبقى الفرز نفسه محتاج ضبط
     على الكاشير، وبنقولها على الشاشة بدل ما نسكت.
═══════════════════════════════════════════════════════════════════════════ */

export const LANES = {
  dinein: { label: "صالة", group: "inhouse", order: 1 },
  takeaway: { label: "سفري", group: "inhouse", order: 2 },
  own_delivery: { label: "توصيل المطعم", group: "inhouse", order: 3 },
  inhouse_unknown: { label: "داخل المطعم — نوع غير مسجّل", group: "inhouse", order: 4 },
};
const laneLabel = (id) => LANES[id]?.label || chLabel(id);
const laneGroup = (id) => LANES[id]?.group || "delivery_app";

// الفرز الجوّاني. بيشتغل على طلبات المطعم بس (NOT is_delivery) — شوف الملاحظة فوق.
const LANE_SQL = `
  CASE WHEN NOT sc.is_delivery THEN
    CASE WHEN sc.order_option ILIKE '%deliver%' OR sc.order_option LIKE '%توصيل%' THEN 'own_delivery'
         WHEN sc.order_option ILIKE '%dine%' THEN 'dinein'
         WHEN sc.order_option ILIKE '%take%' THEN 'takeaway'
         ELSE 'inhouse_unknown' END
  ELSE sc.ch END`;

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const analytics = deps.analytics || null;
  const attribution = deps.attribution || null;
  const adsApi = deps.ads || null;
  const autopilot = deps.autopilot || null;

  /* لو موديول وقع، الكشف بيكمّل والقسم بتاعه بيتكتب «غير متاح» بالسبب. */
  const soft = async (label, fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, label, error: String(e?.message || e) }; }
  };

  async function deliveryApps() {
    if (analytics?.deliveryApps) return analytics.deliveryApps();
    return ["ninja", "feedus", "keeta", "hungerstation", "jahez", "toyou", "mrsool", "careem"];
  }

  /* ── الأهداف: بتتخزن في settings.data.scorecard ─────────────────────────
     الكتابة بـ jsonb_set على المفتاح ده بس — مش استبدال الـ data كلها —
     عشان أي موديول تاني بيكتب في نفس الصف ما يتمسحش. */
  const TARGET_DEFAULTS = {
    goalDailySales: 10000,
    categoryTargets: {},                       // { pizza: 800, ... } ر.س/يوم
    levers: { ordersPerDay: null, avgTicket: null, newCustomersPerDay: null, repeatRatePct: null },
    openWindow: { open: 12, close: 2, lateDows: [4, 5], lateClose: 3 },
    // الصرف الإعلاني بيتنسب لأي مجموعة قنوات. إعلاناتنا بتودّي على المطعم
    // وعلى order.o2m8.me — مش على صفحة المطعم جوّه كيتا — فنسبته لمجموعة
    // «داخل المطعم» هي الفرضية المعقولة، ومكتوبة عشان تتغيّر لو غلط.
    adSpendAssignedTo: "inhouse",
  };

  async function readTargets() {
    const s = await getSettingsData();
    const t = s?.scorecard || {};
    return {
      ...TARGET_DEFAULTS,
      ...t,
      // هدف المطعم اليومي ممكن يكون متسجّل في إعدادات الطيار من زمان —
      // نفس الرقم لازم يقرا واحد في كل الشاشات.
      goalDailySales: num(t.goalDailySales) || num(s?.goalDailySales) || TARGET_DEFAULTS.goalDailySales,
      categoryTargets: { ...(t.categoryTargets || {}) },
      levers: { ...TARGET_DEFAULTS.levers, ...(t.levers || {}) },
      openWindow: { ...TARGET_DEFAULTS.openWindow, ...(t.openWindow || {}) },
      adsSharePct: num(s?.adsShareOfSalesPct) || 20,
    };
  }

  app.get("/api/scorecard/targets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, targets: await readTargets(), categories: CATEGORIES });
  });

  app.put("/api/scorecard/targets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const cur = await readTargets();
    const cats = {};
    for (const [k, v] of Object.entries(b.categoryTargets || cur.categoryTargets || {})) {
      if (!CATEGORY_LABEL[k]) continue;                 // مفتاح مش فئة = بيتتشال
      const n = Number(v);
      cats[k] = Number.isFinite(n) && n > 0 ? r2(n) : null;
    }
    const lev = {};
    for (const k of Object.keys(TARGET_DEFAULTS.levers)) {
      const v = b.levers?.[k] ?? cur.levers?.[k];
      const n = Number(v);
      lev[k] = Number.isFinite(n) && n > 0 ? r2(n) : null;
    }
    const ow = { ...cur.openWindow, ...(b.openWindow || {}) };
    const next = {
      goalDailySales: Math.max(1, num(b.goalDailySales) || cur.goalDailySales),
      categoryTargets: cats,
      levers: lev,
      openWindow: {
        open: Math.min(23, Math.max(0, num(ow.open))),
        close: Math.min(23, Math.max(0, num(ow.close))),
        lateDows: Array.isArray(ow.lateDows) ? ow.lateDows.map(num).filter((d) => d >= 0 && d <= 6) : [],
        lateClose: Math.min(23, Math.max(0, num(ow.lateClose))),
      },
      adSpendAssignedTo: ["inhouse", "all"].includes(b.adSpendAssignedTo) ? b.adSpendAssignedTo : cur.adSpendAssignedTo,
    };
    await pool.query(
      "UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{scorecard}', $1::jsonb, true), updated_at=NOW() WHERE id=1",
      [jb ? jb(next) : JSON.stringify(next)]
    );
    return c.json({ ok: true, targets: { ...cur, ...next } });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     البناء
  ═══════════════════════════════════════════════════════════════════════ */
  async function buildScorecard(from, to) {
    const days = spanDays(from, to);
    const apps = await deliveryApps();
    const targets = await readTargets();
    const unavailable = [];
    const today = bizToday();
    const partial = to >= today;

    // الفترة اللي قبلها بنفس الطول — كل «الاتجاه» على الصفحة بيتقاس عليها.
    const prevTo = shiftDay(from, -1);
    const prevFrom = shiftDay(prevTo, -(days - 1));

    /* ── (١) المبيعات اليومية + المجاميع ─────────────────────────────── */
    const dayQ = async (f, t) => (await pool.query(
      `SELECT o.calendar_day AS day, count(*)::int AS orders,
              COALESCE(sum(o.total),0) AS revenue,
              COALESCE(sum(o.discount_incl),0) AS discount
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY 1`, [f, t])).rows;

    const [curDays, prevDays] = await Promise.all([dayQ(from, to), dayQ(prevFrom, prevTo)]);
    const sumOf = (rows, k) => rows.reduce((a, r) => a + num(r[k]), 0);
    const revenue = money(sumOf(curDays, "revenue"));
    const orders = sumOf(curDays, "orders");
    const prevRevenue = money(sumOf(prevDays, "revenue"));
    const prevOrders = sumOf(prevDays, "orders");
    const avgTicket = orders > 0 ? money(revenue / orders) : null;
    const prevAvgTicket = prevOrders > 0 ? money(prevRevenue / prevOrders) : null;
    const daily = curDays.map((r) => ({
      day: isoDay(r.day), dow: DOW_AR[dowOf(isoDay(r.day))],
      orders: num(r.orders), revenue: money(r.revenue), discount: money(r.discount),
    }));

    /* ── (٢) خط الأساس: نفس يوم الأسبوع ──────────────────────────────────
       مقارنة الجمعة بالأربعاء بتكذب في مطعم. خط الأساس هنا = متوسط نفس يوم
       الأسبوع على الـ ٢٨ يوم اللي قبل الفترة، مجموع على أيام الفترة نفسها.
       بيرجع null لو مفيش أيام تشغيل نقارن بيها — مش صفر. */
    const dowRows = (await pool.query(
      `SELECT extract(dow from o.calendar_day)::int AS dow,
              count(DISTINCT o.calendar_day)::int AS days,
              COALESCE(sum(o.total),0) AS revenue, count(*)::int AS orders
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date - 28 AND $1::date - 1 AND ${SALES_ONLY}
        GROUP BY 1`, [from])).rows;
    const dowMap = new Map(dowRows.map((r) => [num(r.dow), r]));
    let baseRev = 0, baseOrd = 0, baseDaysCovered = 0;
    for (let i = 0; i < days; i++) {
      const d = shiftDay(from, i);
      const b = dowMap.get(dowOf(d));
      if (!b || num(b.days) === 0) continue;
      baseRev += num(b.revenue) / num(b.days);
      baseOrd += num(b.orders) / num(b.days);
      baseDaysCovered++;
    }
    const sameWeekdayBaseline = baseDaysCovered === days && baseDaysCovered > 0
      ? { revenue: money(baseRev), orders: Math.round(baseOrd), daysMatched: baseDaysCovered }
      : null;
    if (!sameWeekdayBaseline) {
      unavailable.push({
        what: "خط أساس «نفس يوم الأسبوع»",
        why: `عايزين ٢٨ يوم تشغيل قبل ${from} فيهم كل أيام الأسبوع اللي في الفترة. المتاح غطّى ${baseDaysCovered} يوم من ${days} — الباقي المطعم ما اشتغلش فيه أو مفيش عنه داتا.`,
      });
    }

    /* ── (٣) القنوات: إيراد وطلبات ومتوسط فاتورة وعملاء لكل قناة ─────── */
    const laneQ = async (f, t) => (await pool.query(
      `WITH scoped AS (
         SELECT o.order_id, o.calendar_day, o.total, o.order_option, o.order_type,
                ${deliverySql("$3::text[]")} AS is_delivery,
                ${channelSql("$3::text[]")} AS ch,
                ${IDENT_SQL} AS ident
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
       ),
       lanes AS (SELECT sc.*, ${LANE_SQL} AS lane FROM scoped sc),
       ${FIRST_ORDER_DAY_CTE}
       SELECT l.lane,
              count(*)::int AS orders,
              COALESCE(sum(l.total),0) AS revenue,
              count(*) FILTER (WHERE l.ident IS NOT NULL)::int AS identified_orders,
              count(DISTINCT l.ident)::int AS customers,
              count(DISTINCT l.ident) FILTER (
                WHERE f.first_day BETWEEN $1::date AND $2::date)::int AS new_customers,
              count(DISTINCT l.ident) FILTER (WHERE f.first_day < $1::date)::int AS returning_customers,
              count(*) FILTER (WHERE l.ident IS NOT NULL AND f.first_day < l.calendar_day)::int AS returning_orders
         FROM lanes l LEFT JOIN firsts f ON f.pn = l.ident
        GROUP BY 1`, [f, t, apps])).rows;

    const [laneCur, lanePrev] = await Promise.all([laneQ(from, to), laneQ(prevFrom, prevTo)]);
    const prevLane = new Map(lanePrev.map((r) => [r.lane, r]));
    const channels = laneCur.map((r) => {
      const p = prevLane.get(r.lane) || {};
      const o = num(r.orders), rev = money(r.revenue), ident = num(r.identified_orders);
      return {
        id: r.lane,
        label: laneLabel(r.lane),
        group: laneGroup(r.lane),
        isDeliveryApp: laneGroup(r.lane) === "delivery_app",
        orders: o,
        revenue: rev,
        revenuePerDay: money(rev / days),
        avgTicket: o > 0 ? money(rev / o) : null,
        share: ratio(rev, revenue),
        customers: num(r.customers),
        newCustomers: num(r.new_customers),
        returningCustomers: num(r.returning_customers),
        // نسبة الطلبات اللي جات من حد طلب قبل كده — على الطلبات اللي عرفنا
        // صاحبها بس. الطلب اللي مفيش معاه رقم مش بيتحسب جديد ولا راجع.
        repeatOrderRate: ratio(r.returning_orders, ident),
        identifiedOrders: ident,
        identifiedCoverage: ratio(ident, o),
        delta: {
          revenue: delta(r.revenue, p.revenue),
          orders: delta(r.orders, p.orders),
          newCustomers: delta(r.new_customers, p.new_customers),
        },
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const groupOf = (g) => {
      const rows = channels.filter((c) => c.group === g);
      const rev = rows.reduce((a, c) => a + c.revenue, 0);
      const o = rows.reduce((a, c) => a + c.orders, 0);
      return {
        revenue: money(rev), orders: o,
        avgTicket: o > 0 ? money(rev / o) : null,
        share: ratio(rev, revenue),
        newCustomers: rows.reduce((a, c) => a + c.newCustomers, 0),
      };
    };

    /* دقّة الفرز صالة/سفري — بتتقاس، مش بتتفترض. */
    const rel = (await pool.query(
      `WITH scoped AS (
         SELECT o.order_option, o.order_type, ${deliverySql("$3::text[]")} AS is_delivery
           FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
       )
       SELECT count(*) FILTER (WHERE NOT is_delivery)::int AS inhouse_orders,
              count(*) FILTER (WHERE NOT is_delivery AND COALESCE(order_option,'') = '')::int AS no_option,
              count(*) FILTER (WHERE NOT is_delivery AND order_type ILIKE 'table')::int AS table_orders,
              count(*) FILTER (WHERE NOT is_delivery AND order_type ILIKE 'table'
                                 AND order_option ILIKE '%take%')::int AS table_but_takeaway,
              count(*) FILTER (WHERE is_delivery AND order_option ILIKE '%dine%')::int AS app_marked_dinein,
              count(*) FILTER (WHERE is_delivery)::int AS app_orders
         FROM scoped`, [from, to, apps])).rows[0];
    const contradiction = ratio(rel.table_but_takeaway, rel.table_orders);
    const reliability = {
      inhouseOrders: num(rel.inhouse_orders),
      ordersWithoutOption: num(rel.no_option),
      tableOrders: num(rel.table_orders),
      tableButTakeaway: num(rel.table_but_takeaway),
      contradictionRate: contradiction,
      appOrders: num(rel.app_orders),
      appMarkedDineIn: num(rel.app_marked_dinein),
      verdict: num(rel.inhouse_orders) === 0 ? "مفيش طلبات مطعم في الفترة"
        : num(rel.no_option) > 0 ? "فيه طلبات من غير نوع مسجّل"
        : contradiction == null ? "مفيش طلبات ترابيزة نقيس عليها"
        : contradiction >= 0.25 ? "الفرز فيه تضارب كبير — محتاج ضبط على الكاشير"
        : contradiction > 0 ? "الفرز شغّال، وفيه تضارب محدود"
        : "الفرز متسق",
      note:
        "الفرق بين الصالة والسفري متسجّل فعلاً في نقطة البيع (order_option) — مش تخمين. "
        + "بس هو مسجّل صح لطلبات المطعم بس: طلبات التطبيقات نفس الحقل عندها بيكذب "
        + `(${num(rel.app_marked_dinein)} من ${num(rel.app_orders)} طلب تطبيق في الفترة دي مكتوب عليه «صالة»)، `
        + "فاحنا بنقراه لطلبات المطعم بس وبناخد اسم التطبيق من قاعدة القنوات الأصلية. "
        + (contradiction == null ? "" :
          `وجوّه المطعم نفسه فيه تضارب مقاس: ${num(rel.table_but_takeaway)} من ${num(rel.table_orders)} طلب اتفتح على ترابيزة `
          + `ومكتوب عليه «سفري» (${Math.round(num(contradiction) * 100)}٪) — يعني رقم الصالة أرضية مش رقم مضبوط.`),
    };

    /* ── (٤) العملاء: جديد مقابل راجع على مستوى الفترة كلها ─────────── */
    const cust = (await pool.query(
      `WITH scoped AS (
         SELECT o.order_id, o.calendar_day, o.total, ${IDENT_SQL} AS ident
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
       ),
       ${FIRST_ORDER_DAY_CTE}
       SELECT count(*)::int AS orders,
              count(*) FILTER (WHERE sc.ident IS NOT NULL)::int AS identified_orders,
              count(DISTINCT sc.ident)::int AS customers,
              count(DISTINCT sc.ident) FILTER (
                WHERE f.first_day BETWEEN $1::date AND $2::date)::int AS new_customers,
              count(DISTINCT sc.ident) FILTER (WHERE f.first_day < $1::date)::int AS returning_customers,
              count(*) FILTER (WHERE sc.ident IS NOT NULL AND f.first_day < sc.calendar_day)::int AS returning_orders,
              COALESCE(sum(sc.total) FILTER (
                WHERE sc.ident IS NOT NULL AND f.first_day < sc.calendar_day),0) AS returning_revenue,
              COALESCE(sum(sc.total) FILTER (
                WHERE sc.ident IS NOT NULL AND f.first_day >= sc.calendar_day),0) AS new_revenue
         FROM scoped sc LEFT JOIN firsts f ON f.pn = sc.ident`, [from, to])).rows[0];

    const newPerDay = num(cust.new_customers) / days;
    const customers = {
      customers: num(cust.customers),
      newCustomers: num(cust.new_customers),
      returningCustomers: num(cust.returning_customers),
      newPerDay: r2(newPerDay),
      repeatOrderRate: ratio(cust.returning_orders, cust.identified_orders),
      newRevenue: money(cust.new_revenue),
      returningRevenue: money(cust.returning_revenue),
      returningRevenuePerDay: money(num(cust.returning_revenue) / days),
      identifiedOrders: num(cust.identified_orders),
      identifiedCoverage: ratio(cust.identified_orders, cust.orders),
      coverageNote:
        `${num(cust.identified_orders)} من ${num(cust.orders)} طلب في الفترة عرفنا صاحبه برقم جوال `
        + `(${Math.round((num(cust.identified_orders) / Math.max(1, num(cust.orders))) * 100)}٪). `
        + "الباقي كاش من غير تسجيل — يعني عدد العملاء الحقيقي أعلى من اللي مكتوب، والأرقام دي أرضية.",
      note: "«عميل جديد» = طلب داخل الفترة وعمره ما طلب قبلها. نفس التعريف المستعمل في كل شاشات النظام. "
        + "مجموع العملاء الجدد على القنوات ممكن يزيد عن الرقم الكلي: العميل اللي أول أسبوع له طلب من الصالة ومن كيتا بيتعدّ جديد في الاتنين وواحد في المجموع.",
    };

    /* ── (٥) كيتا بالتحديد — «ممكن نستغل حصولنا على بيانات عملاء كيتا» ──
       فيدأس بيدينا جوال عميل كيتا، فكيتا هي التطبيق الوحيد اللي نقدر نقيس
       عليه عملاء جدد وretention حقيقي. هنقرستيشن ونينجا بيوصلوا من غير
       جوال خالص، فأرقامهم دي بترجع «غير متاح» بالسبب مش صفر. */
    const KN_CTE = `
      kn AS (
        SELECT ${IDENT_SQL} AS ident, o.calendar_day, o.total,
               ${channelSql("$1::text[]")} AS ch
          FROM ts_orders o
          LEFT JOIN order_sources s ON s.order_id = o.order_id
          LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         WHERE ${SALES_ONLY} AND ${IDENT_SQL} IS NOT NULL
      )`;
    /* نسبة الرجوع محسوبة على العملاء اللي **عدّى على أول طلبهم المدة دي
       فعلاً** — مش على الفوج كله. عميل أول طلب ليه من ٥ أيام مالوش نسبة
       رجوع ٣٠ يوم؛ لو حطّيناه في المقام كنا هنقول عنه إنه ما رجعش، وهو لسه
       عنده ٢٥ يوم. المقام اسمه `eligible` وبيتشحن مع الرقم عشان يبان. */
    const keetaCohorts = (await pool.query(
      `WITH ${KN_CTE},
       kfirst AS (SELECT ident, min(calendar_day) AS fk FROM kn WHERE ch = 'keeta' GROUP BY 1)
       SELECT to_char(k.fk,'YYYY-MM') AS cohort, count(*)::int AS customers,
              count(*) FILTER (WHERE k.fk + 30 <= $2::date)::int AS eligible30,
              count(*) FILTER (WHERE k.fk + 60 <= $2::date)::int AS eligible60,
              count(*) FILTER (WHERE k.fk + 30 <= $2::date AND EXISTS (SELECT 1 FROM kn x WHERE x.ident = k.ident
                AND x.calendar_day > k.fk AND x.calendar_day <= k.fk + 30))::int AS any30,
              count(*) FILTER (WHERE k.fk + 30 <= $2::date AND EXISTS (SELECT 1 FROM kn x WHERE x.ident = k.ident AND x.ch = 'keeta'
                AND x.calendar_day > k.fk AND x.calendar_day <= k.fk + 30))::int AS keeta30,
              count(*) FILTER (WHERE k.fk + 60 <= $2::date AND EXISTS (SELECT 1 FROM kn x WHERE x.ident = k.ident
                AND x.calendar_day > k.fk AND x.calendar_day <= k.fk + 60))::int AS any60,
              count(*) FILTER (WHERE k.fk + 60 <= $2::date AND EXISTS (SELECT 1 FROM kn x WHERE x.ident = k.ident AND x.ch = 'keeta'
                AND x.calendar_day > k.fk AND x.calendar_day <= k.fk + 60))::int AS keeta60
         FROM kfirst k GROUP BY 1 ORDER BY 1`, [apps, today])).rows;

    const keetaCohortRows = keetaCohorts.map((r) => ({
      cohort: r.cohort,
      customers: num(r.customers),
      eligible30: num(r.eligible30),
      eligible60: num(r.eligible60),
      backAnywhere30: num(r.any30),
      backOnKeeta30: num(r.keeta30),
      rateAnywhere30: ratio(r.any30, r.eligible30),
      rateKeeta30: ratio(r.keeta30, r.eligible30),
      rateAnywhere60: ratio(r.any60, r.eligible60),
      rateKeeta60: ratio(r.keeta60, r.eligible60),
      immature: num(r.eligible30) === 0,
    }));

    // عملاء كيتا الجدد داخل الفترة، ومنهم كام كان أصلاً عميل للمطعم.
    const keetaWin = (await pool.query(
      `WITH ${KN_CTE},
       kfirst AS (SELECT ident, min(calendar_day) AS fk FROM kn WHERE ch = 'keeta' GROUP BY 1),
       ${FIRST_ORDER_DAY_CTE}
       SELECT count(*)::int AS new_on_keeta,
              count(*) FILTER (WHERE f.first_day IS NOT NULL AND f.first_day < k.fk)::int AS already_ours
         FROM kfirst k LEFT JOIN firsts f ON f.pn = k.ident
        WHERE k.fk BETWEEN $2::date AND $3::date`, [apps, from, to])).rows[0];

    const keetaLane = channels.find((c) => c.id === "keeta") || null;
    const keeta = {
      available: true,
      orders: keetaLane?.orders ?? 0,
      revenue: keetaLane?.revenue ?? 0,
      newOnKeeta: num(keetaWin.new_on_keeta),
      newOnKeetaButAlreadyOurs: num(keetaWin.already_ours),
      trulyNewToRestaurant: Math.max(0, num(keetaWin.new_on_keeta) - num(keetaWin.already_ours)),
      cohorts: keetaCohortRows,
      note: "فيدأس بيسلّمنا رقم جوال عميل كيتا مع الطلب، فكيتا هي تطبيق التوصيل الوحيد اللي نقدر "
        + "نعدّ عليه عملاء جدد ونقيس رجوعهم. «جديد على كيتا» غير «جديد على المطعم»: اللي كان بيطلب "
        + "من المطعم وجرّب كيتا لأول مرة مش عميل جديد — ده عميل قديم غيّر قناته.",
      cohortNote: "نسبة الرجوع لكل فوج محسوبة على العملاء اللي عدّى على أول طلبهم المدة كاملة "
        + "(العمود «مؤهّل») — اللي أول طلب ليه من أسبوع مش داخل في مقام الـ ٣٠ يوم، عشان ما نحسبهوش "
        + "«ما رجعش» وهو لسه عنده وقت. «رجع لكيتا» أضيق من «رجع للمطعم»: التاني بيشمل اللي رجع "
        + "يطلب من المطعم مباشرة — وده أحسن، لأنه بيوفّر علينا عمولة التطبيق.",
    };

    // التطبيقات اللي مالهاش جوال — بيتقال بالاسم بدل ما نسيب خانة فاضية.
    const blindApps = channels
      .filter((c) => c.isDeliveryApp && c.id !== "keeta" && c.orders > 0 && num(c.identifiedOrders) === 0);
    for (const b of blindApps) {
      unavailable.push({
        what: `عملاء ${b.label} الجدد ونسبة رجوعهم`,
        why: `${b.label} بيوصلنا من غير رقم جوال على أي طلب (${b.orders} طلب في الفترة، صفر منهم معاه رقم). `
          + "من غير الرقم مفيش طريقة نعرف إذا كان العميل ده أول مرة ولا رجع — ودي مش صفر، دي عمى قياس.",
      });
    }

    /* ── (٦) الإشغال بالساعة — «لازم نستغل المطبخ وساعات العمل كلها» ─── */
    const hourRows = (await pool.query(
      `WITH scoped AS (
         SELECT o.order_id, o.total, ${LOCAL_HOUR} AS hour,
                ${deliverySql("$3::text[]")} AS is_delivery
           FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
       )
       SELECT hour, count(*)::int AS orders, COALESCE(sum(total),0) AS revenue,
              count(*) FILTER (WHERE NOT is_delivery)::int AS inhouse_orders,
              COALESCE(sum(total) FILTER (WHERE NOT is_delivery),0) AS inhouse_revenue
         FROM scoped GROUP BY 1`, [from, to, apps])).rows;
    const hourMap = new Map(hourRows.map((r) => [num(r.hour), r]));

    const ow = targets.openWindow;
    // ساعات الخدمة بالترتيب اللي المطعم بيعيشه: من الفتح لحد القفل بعد نص الليل.
    const serviceHours = [];
    const lastClose = Math.max(ow.close, ow.lateClose ?? ow.close);
    for (let h = ow.open; ; h = (h + 1) % 24) {
      serviceHours.push(h);
      if (h === lastClose) break;
      if (serviceHours.length > 24) break;
    }
    const hourly = serviceHours.map((h) => {
      const r = hourMap.get(h) || {};
      return {
        hour: h,
        label: `${String(h).padStart(2, "0")}:00`,
        orders: num(r.orders),
        revenue: money(r.revenue),
        revenuePerDay: money(num(r.revenue) / days),
        inhouseOrders: num(r.inhouse_orders),
        inhouseRevenue: money(r.inhouse_revenue),
        // الساعات اللي بين القفل العادي والقفل المتأخر بتشتغل يومين في الأسبوع
        // بس (الخميس والجمعة) — فبيعها الأقل مش ركود، ده يومين مش سبعة.
        lateOnly: num(ow.lateClose) > num(ow.close) && h > num(ow.close) && h <= num(ow.lateClose),
      };
    });
    // ساعات خارج نافذة الخدمة لكن فيها بيع — دي واقعة تستاهل تتقال.
    const outsideWindow = [...hourMap.entries()]
      .filter(([h]) => !serviceHours.includes(h))
      .map(([h, r]) => ({ hour: h, label: `${String(h).padStart(2, "0")}:00`, orders: num(r.orders), revenue: money(r.revenue) }))
      .filter((x) => x.orders > 0)
      .sort((a, b) => a.hour - b.hour);

    const peakHour = hourly.reduce((m, x) => (m == null || x.revenue > m.revenue ? x : m), null);
    // الساعات المتأخرة (الخميس/الجمعة بس) مستبعدة من عدّ الركود: بيعها الأقل
    // سببه إنها شغّالة يومين في الأسبوع مش سبعة، مش إن حد مش بيطلب فيها.
    const idleHours = hourly.filter(
      (x) => !x.lateOnly && peakHour && peakHour.revenue > 0 && x.revenue < peakHour.revenue * 0.25);
    const occupancy = {
      hours: hourly,
      outsideWindow,
      peak: peakHour ? { hour: peakHour.hour, label: peakHour.label, revenue: peakHour.revenue, orders: peakHour.orders } : null,
      idle: idleHours.map((x) => ({ hour: x.hour, label: x.label, revenue: x.revenue, orders: x.orders })),
      openWindow: ow,
      serviceHourCount: serviceHours.length,
      // سقف نظري صريح: لو كل ساعة خدمة قرأت زي ساعة الذروة. مش توقّع ولا هدف —
      // ده الحد الأقصى اللي نافذة العمل الحالية تسمح بيه من غير ما نمدّها.
      ceilingIfEveryHourWasPeak: peakHour
        ? money((peakHour.revenue / days) * serviceHours.length) : null,
      note: "الساعة بتوقيت جدة على يوم المطعم — فوردية الجمعة بتتقري ١٢ ظهراً لحد ٣ الفجر تحت يوم الجمعة نفسه، "
        + "مش مقسومة على يومين عند نص الليل. «ساعة راكدة» = بيعها أقل من ربع ساعة الذروة.",
    };

    /* ── (٧) الأصناف والفئات + تحليل السلة ───────────────────────────── */
    // كتالوج نقطة البيع هو مصدر الفئات. لو الجدول لسه ما اتعبّاش، التصنيف
    // بيكمّل بقواعد الكلمات لوحدها — وبنقول ده صراحة بدل ما نطلع فئات فاضية.
    const posR = await soft("كتالوج نقطة البيع", async () =>
      (await pool.query("SELECT name_ar, name_en, category_ar FROM cw_pos_products")).rows);
    const posRows = posR.value || [];
    if (!posR.ok || posRows.length === 0) {
      unavailable.push({
        what: "ربط الأصناف بصفحات المنيو من كتالوج نقطة البيع",
        why: posR.ok
          ? "جدول كتالوج نقطة البيع فاضي — التصنيف اتعمل بقواعد كلمات على اسم الصنف بس، فدقّته أقل."
          : `مقدرناش نقرا كتالوج نقطة البيع: ${posR.error}. التصنيف اتعمل بقواعد كلمات بس.`,
      });
    }
    const posMap = buildPosMap(posRows);

    const itemRows = (await pool.query(
      `SELECT i.order_id, i.name, i.qty, i.amount
         FROM ts_order_items i JOIN ts_orders o ON o.order_id = i.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`, [from, to])).rows;
    const coverage = (await pool.query(
      `SELECT count(*)::int AS orders_total,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM ts_order_items i WHERE i.order_id = o.order_id))::int AS with_items
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`, [from, to])).rows[0];

    const catAgg = new Map();     // cat → { revenue, qty, orders:Set }
    const perOrderCats = new Map();  // order_id → Set(cat)
    const perOrderItems = new Map(); // order_id → [{name, cat, qty, amount}]
    const unmapped = new Map();
    let modifierRows = 0, feeRevenue = 0;

    for (const row of itemRows) {
      const cat = classifyItem(row.name, posMap);
      const amount = num(row.amount), q = num(row.qty);
      if (cat === "modifier") { modifierRows++; continue; }
      if (cat === "fee") { feeRevenue += amount; continue; }
      if (cat === "other") {
        const u = unmapped.get(row.name) || { name: row.name, qty: 0, revenue: 0 };
        u.qty += q; u.revenue += amount; unmapped.set(row.name, u);
      }
      let a = catAgg.get(cat);
      if (!a) { a = { revenue: 0, qty: 0, orders: new Set() }; catAgg.set(cat, a); }
      a.revenue += amount; a.qty += q; a.orders.add(row.order_id);

      let cs = perOrderCats.get(row.order_id);
      if (!cs) { cs = new Set(); perOrderCats.set(row.order_id, cs); }
      cs.add(cat);

      let list = perOrderItems.get(row.order_id);
      if (!list) { list = []; perOrderItems.set(row.order_id, list); }
      list.push({ name: row.name, cat, qty: q, amount });
    }

    const foodRevenue = [...catAgg.values()].reduce((a, x) => a + x.revenue, 0);
    const ordersWithItems = num(coverage.with_items);
    const categories = CATEGORIES.map((c) => {
      const a = catAgg.get(c.id) || { revenue: 0, qty: 0, orders: new Set() };
      const rev = money(a.revenue), n = a.orders.size;
      const target = targets.categoryTargets?.[c.id];
      const share = ratio(a.revenue, foodRevenue);
      // هدف «مقترح» = حصة الصنف الحالية من هدف الـ ١٠ آلاف. ده مش هدف المالك —
      // ده نقطة بداية مكتوب عليها إنها مقترح لحد ما يحطّ رقمه.
      const suggested = share == null ? null : money(num(share) * targets.goalDailySales);
      return {
        id: c.id,
        label: c.label,
        owner: c.owner,
        posPage: c.pos,
        revenue: rev,
        revenuePerDay: money(rev / days),
        qty: Math.round(a.qty * 100) / 100,
        orders: n,
        share,
        // متوسط قيمة السطر الواحد داخل الفئة — «كام ريال بيدخل من كل صنف مبيع».
        avgLineValue: a.qty > 0 ? money(a.revenue / a.qty) : null,
        // نسبة الطلبات اللي فيها صنف من الفئة دي.
        attachRate: ratio(n, ordersWithItems),
        targetPerDay: target == null ? null : money(target),
        suggestedTargetPerDay: suggested,
        progress: target > 0 ? rate((rev / days) / target) : null,
        gapPerDay: target > 0 ? money(target - rev / days) : null,
      };
    }).filter((c) => c.revenue > 0 || c.owner);

    const itemsRevenue = money(foodRevenue + feeRevenue);
    const categoryNote =
      `مجموع سطور الفئات ${Math.round(itemsRevenue)} ر.س مقابل ${Math.round(revenue)} ر.س مبيعات الفترة. `
      + "الفرق طبيعي ومش خطأ: سطر الصنف بيتسجّل بسعر المنيو، والخصم بيتحسب على الفاتورة كلها بعدين — "
      + "فمجموع الفئات دايماً أعلى شوية من صافي المبيعات. الحصص تحت محسوبة على مجموع الفئات نفسه عشان تقفل على ١٠٠٪.";

    if (ordersWithItems < num(coverage.orders_total)) {
      unavailable.push({
        what: "تفصيل الأصناف لكل الطلبات",
        why: `${num(coverage.orders_total) - ordersWithItems} طلب من ${num(coverage.orders_total)} لسه مالوش سطور أصناف في الكاش. `
          + "أرقام الفئات وتحليل السلة محسوبة على الطلبات اللي معاها سطور بس — يعني هي أرضية مش المجموع الكامل. "
          + "الباقي بيتسحب من TabSense طلب طلب عن طريق /api/analytics/backfill-items.",
      });
    }

    /* تحليل السلة — «إيه اللي بيتباع مع إيه» */
    let itemsSum = 0, ordersCounted = 0;
    const pairCount = new Map(), catPairCount = new Map();
    for (const [oid, items] of perOrderItems) {
      ordersCounted++;
      itemsSum += items.reduce((a, x) => a + x.qty, 0);
      const names = [...new Set(items.map((x) => x.name))].sort();
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const k = `${names[i]} ${names[j]}`;
          pairCount.set(k, (pairCount.get(k) || 0) + 1);
        }
      }
      const cats = [...(perOrderCats.get(oid) || [])].sort();
      for (let i = 0; i < cats.length; i++) {
        for (let j = i + 1; j < cats.length; j++) {
          const k = `${cats[i]} ${cats[j]}`;
          catPairCount.set(k, (catPairCount.get(k) || 0) + 1);
        }
      }
    }
    const topPairs = [...pairCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([k, n]) => ({ a: k.split(" ")[0], b: k.split(" ")[1], orders: n, share: ratio(n, ordersCounted) }));
    const topCategoryPairs = [...catPairCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, n]) => {
        const [x, y] = k.split(" ");
        return { a: CATEGORY_LABEL[x] || x, b: CATEGORY_LABEL[y] || y, orders: n, share: ratio(n, ordersCounted) };
      });

    const appetizerOrders = [...perOrderCats.values()].filter((s) => s.has("appetizers")).length;
    const comboOrders = [...perOrderItems.values()]
      .filter((items) => items.some((x) => /كومبو|combo/.test(normItemName(x.name)))).length;
    const basket = {
      ordersAnalysed: ordersCounted,
      avgItemsPerOrder: ordersCounted > 0 ? r2(itemsSum / ordersCounted) : null,
      pairs: topPairs,
      categoryPairs: topCategoryPairs,
      appetizerAttach: {
        orders: appetizerOrders,
        rate: ratio(appetizerOrders, ordersCounted),
        comboOrders,
        note: "نسبة الطلبات اللي فيها صنف واحد على الأقل من صفحة «مقبلات» في نقطة البيع "
          + "(بطاطس، تشيز فرايز، كلوسلو، حلقات بصل، دوريتوس، فرايد تشيكن/موتزريلا) أو أرز أو «إضافة كومبو». "
          + (comboOrders > 0
            ? `منهم ${comboOrders} طلب دخلوا عن طريق «إضافة كومبو» — الكومبو بيتسجّل كسطر واحد مش كأصنافه، `
              + "فمحسوب مقبلات لأنه أصلاً بطاطس ومشروب."
            : "سطور المودفاير (زي حشو الأطراف) مستبعدة من العدّ لأنها بتتسجّل بقيمة صفر."),
      },
      note: "«بيتباع مع» محسوب على الطلب نفسه: صنفين في نفس الفاتورة. الرقم بيعدّ الطلبات، مش الكميات.",
    };

    const itemsBlock = {
      coverage: {
        ordersWithItems, ordersTotal: num(coverage.orders_total),
        pct: ratio(ordersWithItems, coverage.orders_total),
      },
      modifierRows,
      deliveryFeeRevenue: money(feeRevenue),
      unmapped: [...unmapped.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 15)
        .map((u) => ({ ...u, revenue: money(u.revenue), qty: Math.round(u.qty * 100) / 100 })),
      unmappedRevenue: money([...unmapped.values()].reduce((a, u) => a + u.revenue, 0)),
    };

    /* ── (٨) الإعلانات — بنظرة الشغل، مش بنظرة المنصة ─────────────────── */
    const [attR, scoreR, econR] = await Promise.all([
      soft("الإسناد", () => {
        if (!attribution?.overviewData) throw new Error("موديول الإسناد مش مربوط في هذه النسخة");
        return attribution.overviewData(from, to);
      }),
      soft("كشف المنصات", () => {
        if (!adsApi?.scorecardData) throw new Error("موديول الإعلانات مش مربوط في هذه النسخة");
        return adsApi.scorecardData(from, to);
      }),
      soft("اقتصاديات العميل", () => {
        if (!autopilot?.economicsData) throw new Error("موديول الطيار مش مربوط في هذه النسخة");
        return autopilot.economicsData(from, to);
      }),
    ]);
    for (const r of [attR, scoreR, econR]) if (!r.ok) unavailable.push({ what: r.label, why: r.error });
    const att = attR.value || null, score = scoreR.value || null, econ = econR.value || null;
    for (const [pid, why] of Object.entries({ ...(score?.reasons || {}), ...(att?.reasons || {}) })) {
      unavailable.push({ what: `أرقام ${pid === "tiktok" ? "تيك توك" : pid === "google" ? "جوجل" : pid}`, why });
    }

    const spend = num(score?.totals?.spend ?? att?.totals?.paid?.spend);
    const rulePct = targets.adsSharePct;
    const shareOfSalesPct = revenue > 0 ? r2((spend / revenue) * 100) : null;
    const inhouseGroup = groupOf("inhouse");
    const assignTo = targets.adSpendAssignedTo;
    const assignedRevenue = assignTo === "inhouse" ? inhouseGroup.revenue : revenue;
    const assignedNew = assignTo === "inhouse" ? inhouseGroup.newCustomers : num(cust.new_customers);

    const ads = {
      spend: money(spend),
      spendPerDay: money(spend / days),
      shareOfSalesPct,
      rulePct,
      withinRule: shareOfSalesPct == null ? null : shareOfSalesPct <= rulePct,
      allowedSpendPerDay: money((revenue / days) * (rulePct / 100)),
      // الرقم اللي المالك بيسأل عنه: الصرف على العملاء الجدد الحقيقيين اللي
      // دخلوا المطعم، مش على اللي المنصة نسبتهم لنفسها.
      spendPerRealNewCustomer: spend > 0 && num(cust.new_customers) > 0
        ? money(spend / num(cust.new_customers)) : null,
      spendPerAttributedNewCustomer: spend > 0 && num(att?.totals?.paid?.newCustomers) > 0
        ? money(spend / num(att.totals.paid.newCustomers)) : null,
      attributedNewCustomers: att?.totals?.paid?.newCustomers ?? null,
      realNewCustomers: num(cust.new_customers),
      allowedCac: econ?.economics?.allowedCac ?? null,
      assigned: {
        to: assignTo,
        label: assignTo === "inhouse" ? "داخل المطعم (صالة + سفري + توصيل المطعم)" : "كل القنوات",
        revenue: assignedRevenue,
        newCustomers: assignedNew,
        shareOfSalesPct: assignedRevenue > 0 ? r2((spend / assignedRevenue) * 100) : null,
        spendPerNewCustomer: spend > 0 && assignedNew > 0 ? money(spend / assignedNew) : null,
        assumption: "إعلاناتنا بتودّي على المطعم وعلى متجرنا — مش على صفحتنا جوّه كيتا أو هنقرستيشن. "
          + "فالصرف منسوب لمجموعة «داخل المطعم». الفرضية دي مكتوبة عشان تتغيّر من الإعدادات لو بقت غلط.",
      },
      perChannel: {
        available: false,
        why: "الصرف مش قابل للتوزيع على «صالة» و«سفري» و«توصيل المطعم» كل على حدة: المنصة مش شايفة "
          + "الطلب اللي بيتقفل على الكاشير أصلاً، فمفيش أي إشارة تربط ريال إعلان بنوع الطلب. "
          + "أقصى حاجة صادقة نقولها هي التوزيع على المجموعة كلها، وهو اللي فوق.",
      },
      platformFootnote:
        "أرقام المنصات دي هامش على الصفحة، مش الكشف. الشرا اللي بيتقفل على الكاشير بيتبعت لميتا بـ "
        + "action_source = physical_store، وأنواع التحويل الأوفلاين اتشالت من النسخة ٢٠ من الـ API — "
        + "يعني عمود «الشرا» عند المنصة هيفضل صفر مهما بعنا. ده وصف صحيح لمطعم بيبيع على الدرج، مش عطل. "
        + "الحكم الحقيقي هو الأرقام اللي فوق: مبيعات اليوم، العملاء الجدد، ونسبة الرجوع.",
      paid: att?.totals?.paid ? {
        spend: att.totals.paid.spend ?? 0,
        revenue: att.totals.paid.revenue ?? 0,
        orders: att.totals.paid.orders ?? 0,
        newCustomers: att.totals.paid.newCustomers ?? 0,
        roas: att.totals.paid.roas ?? null,
        cpa: att.totals.paid.cpa ?? null,
        label: "عائد الإعلانات المؤكد — أرضية مش سقف: البيع الكاش بلا رقم جوال مش داخل فيه.",
      } : null,
      confidenceTiers: [
        { id: "مؤكد", meaning: "مطابقة رقم جوال أو تصنيف النظام نفسه (زي طلب تطبيق توصيل)." },
        { id: "مرجّح", meaning: "الكاشير صنّف الطلب بإيده — معتمد على ذاكرة العميل." },
        { id: "تقديري", meaning: "محسوب بالاستبعاد. مفيش دليل، ده أحسن تخمين." },
      ],
      platforms: (score?.rows || []).map((r) => ({
        id: r.platform, label: r.label, spend: r.spend,
        impressions: r.impressions, clicks: r.clicks,
        platformConversions: r.platformConversions ?? null,
        confirmedConversions: r.confirmedConversions ?? null,
        confidence: r.confidence,
      })),
      boundaryNote: days === 1
        ? "⚠️ الصرف ده مقصوص على يوم حساب ميتا (America/Los_Angeles، بيلف ١٠ صباحاً بجدة) والمبيعات مقصوصة "
          + "على يوم المطعم (٤ الفجر بجدة). الفرق ٦ ساعات، وعلى يوم واحد ممكن ينقل صرف من يوم للتاني — "
          + "فنسبة الصرف من المبيعات هنا تقريبية."
        : "الصرف على يوم حساب ميتا (America/Los_Angeles) والمبيعات على يوم المطعم (٤ الفجر بجدة). "
          + "على مدى الفترة دي فرق الـ ٦ ساعات بيتلاشى، فالنسبة سليمة.",
    };

    /* ── (٩) تفكيك هدف الـ ١٠ آلاف بألفاظ المالك ─────────────────────── */
    const goal = targets.goalDailySales;
    const revPerDay = revenue / days;
    const ordersPerDay = orders / days;
    const e = econ?.economics || null;
    const gapPerDay = goal - revPerDay;

    const lever = (id, label, current, required, unit, sentence, extra = {}) => ({
      id, label, unit,
      current: current == null ? null : r2(current),
      required: required == null ? null : r2(required),
      gap: current == null || required == null ? null : r2(required - current),
      progress: required > 0 && current != null ? rate(current / required) : null,
      sentence,
      ...extra,
    });

    const ordersNeeded = avgTicket > 0 ? goal / avgTicket : null;
    const ticketNeeded = ordersPerDay > 0 ? goal / ordersPerDay : null;
    const ltv = e?.ltv ?? null;
    const aov = e?.aov ?? null;
    const opc = e?.ordersPerCustomer ?? null;
    const newNeeded = e?.neededPerDaySteady ?? null;
    const opcNeeded = newPerDay > 0 && aov > 0 ? (goal / newPerDay) / aov : null;

    const levers = [
      lever("orders", "عدد الطلبات في اليوم", ordersPerDay, ordersNeeded, "طلب/يوم",
        avgTicket > 0
          ? `بمتوسط فاتورة ${Math.round(avgTicket)} ر.س زي دلوقتي، الـ ${goal.toLocaleString("ar-EG")} ر.س محتاجة `
            + `${Math.ceil(ordersNeeded)} طلب في اليوم. بنعمل ${r2(ordersPerDay)}.`
          : "مفيش طلبات في الفترة نحسب عليها."),
      lever("ticket", "متوسط الفاتورة", avgTicket, ticketNeeded, "ر.س",
        ordersPerDay > 0
          ? `بـ ${r2(ordersPerDay)} طلب في اليوم زي دلوقتي، الهدف محتاج متوسط فاتورة ${Math.round(ticketNeeded)} ر.س. `
            + `متوسطنا ${Math.round(avgTicket || 0)} ر.س.`
          : "مفيش طلبات في الفترة نحسب عليها."),
      lever("newCustomers", "عملاء جدد في اليوم", newPerDay, newNeeded, "عميل/يوم",
        ltv > 0 && newNeeded
          ? `عند الاستقرار إيراد اليوم = عملاء جدد × قيمة العميل. بقيمة عميل ${Math.round(ltv)} ر.س، `
            + `الهدف محتاج ${newNeeded} عميل جديد كل يوم. بنجيب ${r2(newPerDay)} — والرقم ده أرضية لأن `
            + "الكاش بلا رقم مش محسوب."
          : "محتاجين قيمة عميل محسوبة عشان نقول العدد المطلوب.",
        { note: e ? "قيمة العميل محسوبة على كل تاريخ العميل، مش على الفترة المختارة." : null }),
      lever("retention", "طلبات العميل الواحد", opc, opcNeeded, "طلب/عميل",
        opc && opcNeeded && aov
          ? `لو عدد العملاء الجدد فضل زي ما هو (${r2(newPerDay)} في اليوم)، كل عميل لازم يطلب `
            + `${r2(opcNeeded)} مرة على عمره بدل ${r2(opc)} عشان نوصل الهدف — ده الفرق اللي الـ retention بيقفله.`
          : "محتاجين قيمة عميل ومتوسط فاتورة عشان نحسب الرافعة دي.",
        { repeatOrderRate: customers.repeatOrderRate, lifetimeRepeatRatePct: e?.repeatRate ?? null }),
      lever("occupancy", "إيراد ساعة الخدمة", peakHour ? revPerDay / Math.max(1, serviceHours.length) : null,
        goal / Math.max(1, serviceHours.length), "ر.س/ساعة",
        peakHour
          ? `نافذة الخدمة ${serviceHours.length} ساعة. الهدف موزّع عليها = `
            + `${Math.round(goal / serviceHours.length)} ر.س في الساعة. بنعمل `
            + `${Math.round(revPerDay / serviceHours.length)} ر.س. أقوى ساعة (${peakHour.label}) بتجيب `
            + `${Math.round(peakHour.revenue / days)} ر.س في اليوم — يعني الفرق مش في السقف، في الساعات الراكدة.`
          : "مفيش بيع في نافذة الخدمة نحسب عليه.",
        { idleHours: idleHours.length, ceilingIfEveryHourWasPeak: occupancy.ceilingIfEveryHourWasPeak }),
    ];

    const decomposition = {
      goalDailySales: goal,
      actualPerDay: money(revPerDay),
      gapPerDay: money(gapPerDay),
      progress: ratio(revPerDay, goal),
      daysAtOrAboveGoal: daily.filter((d) => d.revenue >= goal).length,
      bestDay: daily.length ? daily.reduce((m, x) => (x.revenue > m.revenue ? x : m)) : null,
      worstDay: daily.length ? daily.reduce((m, x) => (x.revenue < m.revenue ? x : m)) : null,
      levers,
      note: "كل رافعة محسوبة وكل الباقي ثابت. مفيش رافعة منهم هتقفل الفجوة لوحدها في الواقع — "
        + "الجدول ده بيقول حجم الحركة المطلوبة من كل واحدة، عشان تختار توزّع المجهود إزاي.",
    };

    /* ── التجميع ─────────────────────────────────────────────────────── */
    return {
      generatedAt: new Date().toISOString(),
      range: {
        from, to, days, partial,
        label: days === 1 ? `${DOW_AR[dowOf(from)]} ${from}` : `${from} → ${to}`,
        compareFrom: prevFrom, compareTo: prevTo,
        compareLabel: days === 1 ? "اليوم اللي قبله" : `الـ ${days} يوم اللي قبلها`,
      },
      goal: {
        target: goal,
        targetForPeriod: money(goal * days),
        revenue,
        revenuePerDay: money(revPerDay),
        gapPerDay: money(gapPerDay),
        gapForPeriod: money(goal * days - revenue),
        progress: ratio(revPerDay, goal),
        daysAtOrAboveGoal: decomposition.daysAtOrAboveGoal,
        vsPrevious: delta(revenue, prevRevenue),
        previousRevenue: prevRevenue,
        vsSameWeekday: sameWeekdayBaseline ? delta(revenue, sameWeekdayBaseline.revenue) : null,
        sameWeekdayBaseline,
      },
      pace: {
        orders, ordersPerDay: r2(ordersPerDay),
        ordersDelta: delta(orders, prevOrders),
        previousOrders: prevOrders,
        avgTicket,
        avgTicketDelta: delta(avgTicket, prevAvgTicket),
        previousAvgTicket: prevAvgTicket,
        ordersVsSameWeekday: sameWeekdayBaseline ? delta(orders, sameWeekdayBaseline.orders) : null,
      },
      daily,
      channels,
      groups: { inhouse: groupOf("inhouse"), deliveryApps: groupOf("delivery_app") },
      reliability,
      customers,
      keeta,
      occupancy,
      categories,
      categoryNote,
      items: itemsBlock,
      basket,
      ads,
      decomposition,
      targets,
      unavailable,
      boundaries: {
        sales: `كل أرقام المبيعات والعملاء على يوم المطعم في TabSense — بيلف الساعة ${BIZ_DAY_START_HOUR}:00 صباحاً `
          + "بتوقيت جدة، فطلب الساعة ١:٣٠ بالليل محسوب على اليوم اللي قبله.",
        ads: ads.boundaryNote,
      },
      notes: [
        "كل مبلغ شامل الضريبة — نفس الرقم اللي على الفاتورة.",
        "الطلبات الملغية والمرتجعة مستبعدة من كل رقم.",
        "ولا رقم في الكشف ده جاي من منصة إعلانات ما عدا الصرف نفسه — الباقي كله من نقطة البيع وموصل فيدأس.",
        "«عميل جديد» = طلب داخل الفترة وعمره ما طلب قبلها. نفس التعريف في كل شاشات النظام.",
      ],
    };
  }

  /* ═══ ROUTES ═══════════════════════════════════════════════════════════ */
  app.get("/api/scorecard/day", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const date = isDay(c.req.query("date")) ? c.req.query("date") : bizToday();
    try {
      return c.json({ ok: true, ...(await buildScorecard(date, date)) });
    } catch (ex) {
      console.error("[scorecard] day failed:", ex.message);
      return c.json({ ok: false, error: String(ex.message || ex) }, 500);
    }
  });

  app.get("/api/scorecard/range", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let from = isDay(c.req.query("from")) ? c.req.query("from") : shiftDay(bizToday(), -6);
    let to = isDay(c.req.query("to")) ? c.req.query("to") : bizToday();
    if (from > to) { const t = from; from = to; to = t; }
    // سقف عشان استعلام السلة ما يسحبش نص الجدول في الذاكرة.
    if (spanDays(from, to) > 366) from = shiftDay(to, -365);
    try {
      return c.json({ ok: true, ...(await buildScorecard(from, to)) });
    } catch (ex) {
      console.error("[scorecard] range failed:", ex.message);
      return c.json({ ok: false, error: String(ex.message || ex) }, 500);
    }
  });

  console.log("[scorecard] routes ready");
  return { buildScorecard };
}

export default { register };
