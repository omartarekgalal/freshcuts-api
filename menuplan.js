/* ═══════════════════════════════════════════════════════════════════════════
   MENUPLAN — «لازم نرفع متوسط الفواتير»

   نصف خطة الـ١٠٬٠٠٠ ريال اللي الإعلانات ما تقدرش توصّله. الإعلانات بتجيب
   طلبات؛ الملف ده بيكبّر الطلب نفسه. مفيش صرف إعلاني هنا خالص.

   ── ليه موديول لوحده ولا نحطه في analytics.js ─────────────────────────────
   analytics.js بيقرا `ts_order_items.name` زي ما هو. والاسم ده في الواقع
   ست حاجات مختلفة لنفس الطبق:

       وجبة ميكس جريل  ·  Mix Grill Meal  ·  مياه / مياة / Water / water
       بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري  ·  مشروبات غازية - can

   يعني «أكثر صنف مبيعاً» في أي تقرير بيقرا الاسم الخام هو في الحقيقة صنف
   واحد متقسّم على أربع صفوف. الملف ده بيوحّدهم الأول، وبعدين بيصنّفهم على
   الفئات اللي المالك بيشتغل بيها فعلاً: بيتزا · باستا · كريب · مشاوي ·
   حواوشي · برجر · طاسات · مقبلات · مشروبات.

   ── من فين بتيجي الفئة ────────────────────────────────────────────────────
   من المنيو الحية نفسها (order.o2m8.me/api/menu) — صفحة المنيو هي الفئة.
   يعني لو المالك نقل صنف من صفحة لصفحة في TabSense، التصنيف هنا بيمشي
   وراه من غير ما حد يعدّل كود. الأصناف اللي في الكاشير بس ومش على المنيو
   الخارجي (أرز، ثلث كيلو، كمبو، رسوم توصيل) بتتمسك بجدول كلمات مفتاحية
   في الآخر — وأي اسم لسه ما اتعرفش بيرجع في `unresolved` بالاسم والعدد،
   مش بيتحط في «أخرى» بالسكوت.

   ── حدود البيانات، مقولة بصوت عالي ────────────────────────────────────────
   1) `ts_order_items` مش مغطّي كل الطلبات. كل رد فيه `coverage`.
   2) ٤٪ من السطور الـ POS كاتب فيها amount = 0 (البيتزا اللي معاها مقاسات
      وحشو أطراف). دي بتتسعّر بسعر المنيو المعلن وبيتقال عددها وقيمتها في
      `imputed`. من غير كده إيراد البيتزا بيطلع أقل من الحقيقة.
   3) تحليل «عملاء كل فئة» بيشتغل على الطلبات المربوطة بعميل بس — تقريباً
      نص الطلبات. النسب مقولة على القاعدة دي مش على كل الطلبات، والعدد
      راجع في `basis`.

   ── الراوتس ──────────────────────────────────────────────────────────────
   GET  /api/menuplan/categories   جدول الفئات: إيراد، اختراق، عملاء، تكرار
   GET  /api/menuplan/pairs        قواعد الاقتران الحقيقية (support/conf/lift)
   GET  /api/menuplan/attach       نسبة إرفاق المقبلات والمشروبات + فرق الفاتورة
   GET  /api/menuplan/suggest      عام — الاقتراحات لسلة معيّنة (المتجر بيناديه)
   POST /api/menuplan/event        عام — قياس: اتعرض / اتقبل / اترفض
   GET  /api/menuplan/uplift       هل الاقتراح رفع الفاتورة فعلاً؟
   GET  /api/menuplan/targets      أهداف الإيراد اليومي لكل فئة
   PUT  /api/menuplan/targets      تعديلها من اللوحة
   GET  /api/menuplan/hours        الساعات الميتة وإيراد الساعة لكل فئة
   POST /api/menuplan/merchandise  ترتيب صفحات المنيو بالإيراد (dryRun افتراضي)
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
/* «إيه اللي يعتبر بيعة» لازم يبقى تعريف واحد في المشروع كله. الملف ده كان
   بيسأل عن order_status = 2، وده سؤال تاني خالص: TabSense بيقفل المرتجع
   والملغي بنفس الحالة ٢. فالفلتر ده كان بيعدّي ٣٢ مرتجع و٤ ملغي كأنهم
   مبيعات (٩٧٩ ر.س في ٣٠ يوم)، وفي نفس الوقت بيرمي ٣ طلبات حقيقية لسه
   مقفولة بحالة تانية (٢٦٨ ر.س) — خط أساس متضخّم ١.٩٪. القاعدة اتسحبت من
   analytics.js بدل نسخة تانية منها، عشان ما تحصلش إن شاشتين يقولوا رقمين
   لنفس اليوم. */
import { SALES_ONLY } from "./analytics.js";

const MENU_URL = process.env.MENUPLAN_MENU_URL || "https://order.o2m8.me/api/menu?branch_id=1";
const RULE_WINDOW_DAYS = Number(process.env.MENUPLAN_WINDOW_DAYS || 120);
const MENU_TTL = 10 * 60_000;
const RULES_TTL = 30 * 60_000;

/* ── الفئات ────────────────────────────────────────────────────────────────
   صفحة المنيو → فئة. "اضافات" بتتقسم لمقبلات ومشروبات لأنها مخلوطة:
   المياه والبيبسي جنب الكولسلو والبطاطس في نفس الصفحة. */
const PAGE_TO_CAT = {
  "بيتزا": "بيتزا", Pizza: "بيتزا",
  "باستا": "باستا", Pasta: "باستا",
  "كريبات": "كريب", crepes: "كريب", Crepes: "كريب",
  "حواوشي": "حواوشي", Hawawshi: "حواوشي",
  "برجر": "برجر", Burgers: "برجر",
  "طاسات": "طاسات", Skillets: "طاسات",
  "وجبات": "مشاوي", Meals: "مشاوي",
  "اضافات": "__split__", Additions: "__split__",
  "العروض": "عروض", Offers: "عروض",
};
/* صفحات العرض (الأكثر طلباً) بتكرّر أصناف من فئاتها الحقيقية — بتتسيب
   من غير فئة عشان ما تسرقش تصنيف الصنف. */
const MERCH_PAGES = new Set(["Best Sellers", "الأكثر طلباً"]);

export const MAIN_CATS = ["مشاوي", "كريب", "باستا", "بيتزا", "حواوشي", "برجر", "طاسات"];
export const ATTACH_CATS = ["مقبلات", "مشروبات"];
export const ALL_CATS = [...MAIN_CATS, ...ATTACH_CATS, "عروض"];

const DRINK_RE = /مياه|مياة|water|soft\s*drink|مشروب|بيبسي|pepsi|كولا|cola|عصير|juice|سفن|seven/i;

/* آخر ملجأ: الأصناف اللي في الكاشير بس ومش على المنيو الخارجي. الترتيب
   مهم — أول كلمة بتطابق هي اللي بتكسب، فالأخص قبل الأعم. */
const KEYWORD_CATS = [
  [/كريب|crepe/i, "كريب"],
  [/بيتزا|pizza/i, "بيتزا"],
  [/باستا|بنا |بينا|الفريدو|alfredo|كازرول|casserole|نجرسكو|ماك اند تشيز|mac\s*and\s*cheese|فتوتشيني|فتتوتشيني|fettucc/i, "باستا"],
  [/حواوشي|hawawshi/i, "حواوشي"],
  [/برجر|burger|ساندوتش|sandwich/i, "برجر"],
  [/طاسة|طاسه|skillet/i, "طاسات"],
  [/صينية اللمة|صينيه اللمه/i, "عروض"],
  [/مشوي|مشويه|مشوية|كفت|ريش|كباب|طرب|tarb|سجق|كبد|شيش|طاووق|دجاج|صدور|مشكل|فحم|grill|kofta|kebab|liver|charcoal/i, "مشاوي"],
  [DRINK_RE, "مشروبات"],
  [/كومبو|كمبو|combo|ارز|أرز|رز |بطاطس|فرايز|fries|كلوسلو|coleslaw|بصل|onion|دوريتوس|doritos|موتزريلا|mozzarella|سلطة|salad/i, "مقبلات"],
  [/توصيل|delivery|خدمه|رسوم/i, "رسوم"],
];

/* pg بيرجّع عمود DATE ككائن Date، و String(date) بيدي "Fri Aug 01 2026"
   مش "2026-08-01" — يعني .slice(0,7) بيطلع «Fri Aug» ويتحوّل لشهر في
   التقرير. الـ pg بيبني الـ Date بمكوّنات محلية (new Date(y, m-1, d))،
   فالقراءة بالمكوّنات المحلية هي الصح؛ toISOString هنا غلط لأنها بتحوّل
   لـ UTC وممكن ترجّع اليوم اللي فات. */
const p2 = (n) => String(n).padStart(2, "0");
export const dayISO = (d) =>
  d instanceof Date ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : String(d ?? "").slice(0, 10);
export const monthISO = (d) => dayISO(d).slice(0, 7);

/* توحيد الاسم: بيشيل التشكيل، بيوحّد الألف والتاء المربوطة والياء، وبيقصّ
   كل علامات الترقيم. "مياة" و"مياه" بيبقوا واحد، و"Water" بيفضل مختلف
   لحد ما المنيو نفسه يقول إنهم نفس الصنف (اسم عربي + local_name). */
export const norm = (s) => String(s || "")
  .replace(/[ً-ْـ]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي").replace(/ؤ/g, "و")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/* ── المنيو الحية ─────────────────────────────────────────────────────── */
let menuCache = { at: 0, data: null, error: null };
async function liveMenu() {
  if (menuCache.data && Date.now() - menuCache.at < MENU_TTL) return menuCache.data;
  try {
    const res = await fetch(MENU_URL, { headers: { "User-Agent": "freshcuts-menuplan" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();

    const byNorm = new Map();   // اسم موحّد → رقم الصنف (مش الكائن — شوف التعليق تحت)
    const byId = new Map();     // product id → صنف
    const catItems = new Map(); // فئة → [أصناف]
    let position = 0;
    const pages = [];
    for (const p of j?.data?.pages || []) {
      const pt = p.local_title || p.title || "";
      const en = p.title || "";
      pages.push({ id: p.id, title: pt, english: en, position: ++position, count: (p.items || []).length });
      let cat = PAGE_TO_CAT[pt] ?? PAGE_TO_CAT[en];
      if (MERCH_PAGES.has(pt) || MERCH_PAGES.has(en)) cat = null;
      for (const it of p.items || []) {
        const price = Number(it.retail_price ?? it.price) || 0;
        if (!(price > 0)) continue;
        const c = cat === "__split__" ? (DRINK_RE.test(it.name || "") ? "مشروبات" : "مقبلات") : cat;
        const rec = {
          id: String(it.id), name: (it.name || it.local_name || "").trim(),
          english: (it.local_name || "").trim(), price, image: it.image || "",
          cat: c || null, page: pt, pagePosition: position,
        };
        if (!byId.has(rec.id)) byId.set(rec.id, rec);
        else if (c && !byId.get(rec.id).cat) byId.set(rec.id, rec);   // الصفحة الحقيقية تكسب صفحة العرض
        /* byNorm بيخزّن رقم الصنف مش الكائن نفسه — وده مش تفصيلة.
           «وجبة نصف دجاجة على الفحم» بتظهر على صفحتين: «الأكثر طلباً»
           (صفحة عرض، من غير فئة) و«وجبات» (فئتها الحقيقية = مشاوي).
           صفحة العرض بتتقرا الأول، فلو خزّنّا الكائن هنا الاسم بيفضل
           مربوط بالنسخة اللي فئتها null حتى بعد ما byId تتصلّح — يعني
           أكتر ٦ أصناف مبيعاً بيقعوا من التصنيف كله. التخزين بالرقم
           والقراءة من byId وقت السؤال بيخلّي الترتيب ما يفرقش. */
        for (const nm of [it.name, it.local_name]) {
          const k = norm(nm);
          if (k && !byNorm.has(k)) byNorm.set(k, rec.id);
        }
      }
    }
    for (const rec of byId.values()) {
      if (!rec.cat) continue;
      if (!catItems.has(rec.cat)) catItems.set(rec.cat, []);
      catItems.get(rec.cat).push(rec);
    }
    menuCache = { at: Date.now(), data: { byNorm, byId, catItems, pages, keys: [...byNorm.keys()].sort((a, b) => b.length - a.length) }, error: null };
  } catch (e) {
    menuCache.error = String(e.message || e);
    if (!menuCache.data) throw e;
  }
  return menuCache.data;
}

/* ── من اسم سطر الطلب إلى صنف + فئة ────────────────────────────────────
   ترتيب المحاولات: مطابقة تامة → أطول اسم منيو الاسم بيبدأ بيه (ده اللي
   بيمسك "بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري") → احتواء → كلمات
   مفتاحية. اللي بيفشل في الأربعة بيرجع بفئة null ويتعدّ في unresolved. */
function makeResolver(menu) {
  const cache = new Map();
  // byNorm بيدي رقم الصنف؛ الفئة الحقيقية بتتقرا من byId وقت السؤال.
  const rec = (k) => (k == null ? null : menu.byId.get(menu.byNorm.get(k)) || null);
  return (raw) => {
    const n = norm(raw);
    if (cache.has(n)) return cache.get(n);
    let hit = rec(n);
    if (!hit) for (const k of menu.keys) { if (n.startsWith(k + " ")) { hit = rec(k); break; } }
    if (!hit) for (const k of menu.keys) { if (k.length >= 7 && n.includes(k)) { hit = rec(k); break; } }
    let out;
    if (hit) out = { key: norm(hit.name), name: hit.name, cat: hit.cat, price: hit.price, id: hit.id, onMenu: true };
    else {
      let cat = null;
      for (const [re, c] of KEYWORD_CATS) if (re.test(raw)) { cat = c; break; }
      // اسم بيتقص عند أول " - " عشان المقاسات ما تعملش أصناف وهمية
      const base = String(raw).split(" - ")[0].trim();
      out = { key: norm(base), name: base, cat, price: 0, id: null, onMenu: false };
    }
    cache.set(n, out);
    return out;
  };
}

/* ── تحميل السطور مصنّفة ──────────────────────────────────────────────── */
async function loadLines(pool, from, to) {
  const menu = await liveMenu();
  const resolve = makeResolver(menu);
  const rows = (await pool.query(
    `SELECT i.order_id, i.name, i.qty::float qty, i.amount::float amount,
            o.calendar_day, o.total::float total, o.order_option, o.customer_id,
            extract(hour from (o.order_date AT TIME ZONE 'Asia/Riyadh'))::int local_hour
       FROM ts_order_items i
       JOIN ts_orders o ON o.order_id = i.order_id
      WHERE ${SALES_ONLY} AND o.calendar_day BETWEEN $1::date AND $2::date`,
    [from, to])).rows;

  const unresolved = new Map();
  let imputedLines = 0, imputedValue = 0;
  for (const r of rows) {
    const h = resolve(r.name);
    r.cat = h.cat; r.key = h.key; r.canonName = h.name; r.productId = h.id;
    // البيتزا اللي معاها مقاسات بترجع من الـ POS بـ amount = 0. سعر المنيو
    // المعلن هو أقرب حقيقة عندنا — وبيتقال إنه محسوب مش مقروء.
    if (r.amount > 0) r.rev = r.amount;
    else if (h.price > 0) { r.rev = h.price * (r.qty || 1); imputedLines++; imputedValue += r.rev; }
    else r.rev = 0;
    if (!h.cat) unresolved.set(r.name, (unresolved.get(r.name) || 0) + 1);
  }

  const orders = new Map();
  for (const r of rows) {
    let o = orders.get(r.order_id);
    if (!o) {
      o = { id: r.order_id, day: r.calendar_day, total: r.total, option: r.order_option,
            cust: r.customer_id, hour: r.local_hour, lines: [], cats: new Set(), keys: new Set(), units: 0 };
      orders.set(r.order_id, o);
    }
    o.lines.push(r); o.units += (r.qty || 1);
    if (r.cat) o.cats.add(r.cat);
    o.keys.add(r.key);
  }

  const cov = (await pool.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ts_order_items i WHERE i.order_id=o.order_id))::int with_items
       FROM ts_orders o WHERE ${SALES_ONLY} AND o.calendar_day BETWEEN $1::date AND $2::date`,
    [from, to])).rows[0];

  return {
    rows, orders: [...orders.values()], menu,
    coverage: {
      ordersTotal: cov.total, ordersWithItems: cov.with_items,
      pct: cov.total ? Math.round(1000 * cov.with_items / cov.total) / 10 : 0,
      note: "التحليل ده بيشوف الطلبات اللي عندها سطور أصناف بس.",
    },
    imputed: {
      lines: imputedLines, value: Math.round(imputedValue),
      note: "سطور الـ POS كاتب فيها 0 (بيتزا بمقاسات) — اتسعّرت بسعر المنيو المعلن.",
    },
    unresolved: [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, n]) => ({ name, lines: n })),
  };
}

/* ── قواعد الاقتران ───────────────────────────────────────────────────────
   الاقتران الخام بيرجّع «الأكثر مبيعاً مع الأكثر مبيعاً» وخلاص — ده مش
   معلومة. اللي بيفرق هو الـ lift: كام مرة الاتنين بيتطلبوا مع بعض مقارنة
   بالمتوقّع لو مكانش بينهم علاقة. lift = 1 يعني صدفة. */
function buildRules(orders, minTogether) {
  const N = orders.length;
  const cnt = new Map(), pc = new Map(), catCnt = new Map(), itemCat = new Map();
  for (const o of orders) {
    for (const k of o.keys) cnt.set(k, (cnt.get(k) || 0) + 1);
    for (const c of o.cats) catCnt.set(c, (catCnt.get(c) || 0) + 1);
    const ks = [...o.keys].sort();
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
      const key = ks[i] + " " + ks[j];
      pc.set(key, (pc.get(key) || 0) + 1);
    }
    // item → category (عشان نقترح فئة لما الصنف نفسه معندوش شريك قوي)
    for (const k of o.keys) {
      if (!itemCat.has(k)) itemCat.set(k, new Map());
      const m = itemCat.get(k);
      for (const c of o.cats) m.set(c, (m.get(c) || 0) + 1);
    }
  }
  const pairs = [];
  for (const [key, together] of pc) {
    if (together < minTogether) continue;
    const [a, b] = key.split(" ");
    const sa = cnt.get(a) / N, sb = cnt.get(b) / N, sab = together / N;
    pairs.push({
      a, b, together,
      supportPct: +(100 * sab).toFixed(2),
      confAB: +(100 * together / cnt.get(a)).toFixed(1),
      confBA: +(100 * together / cnt.get(b)).toFixed(1),
      lift: +(sab / (sa * sb)).toFixed(2),
      nA: cnt.get(a), nB: cnt.get(b),
    });
  }
  pairs.sort((x, y) => y.lift - x.lift);
  return { N, cnt, catCnt, pairs, itemCat };
}

function catPairs(orders, minTogether) {
  const N = orders.length;
  const cnt = new Map(), pc = new Map();
  for (const o of orders) {
    const cs = [...o.cats].sort();
    for (const c of cs) cnt.set(c, (cnt.get(c) || 0) + 1);
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const k = cs[i] + " " + cs[j]; pc.set(k, (pc.get(k) || 0) + 1);
    }
  }
  const out = [];
  for (const [k, together] of pc) {
    if (together < minTogether) continue;
    const [a, b] = k.split(" ");
    const sa = cnt.get(a) / N, sb = cnt.get(b) / N, sab = together / N;
    out.push({ a, b, together, supportPct: +(100 * sab).toFixed(2),
      confAB: +(100 * together / cnt.get(a)).toFixed(1), confBA: +(100 * together / cnt.get(b)).toFixed(1),
      lift: +(sab / (sa * sb)).toFixed(2), nA: cnt.get(a), nB: cnt.get(b) });
  }
  return out.sort((x, y) => y.lift - x.lift);
}

/* ── كاش قواعد الاقتراح (المتجر بينادي كل إضافة للسلة) ────────────────── */
let rulesCache = { at: 0, data: null, building: null };
async function suggestionRules(pool, todayISO) {
  if (rulesCache.data && Date.now() - rulesCache.at < RULES_TTL) return rulesCache.data;
  if (rulesCache.building) return rulesCache.building;
  rulesCache.building = (async () => {
    const to = todayISO();
    const from = new Date(Date.now() - RULE_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
    const L = await loadLines(pool, from, to);
    const R = buildRules(L.orders, 6);
    const CP = catPairs(L.orders, 10);

    // شريك → لكل صنف، أفضل الشركاء المرتّبين
    const partners = new Map();
    for (const p of R.pairs) {
      if (p.lift < 1.15) continue;
      for (const [from_, to_, conf] of [[p.a, p.b, p.confAB], [p.b, p.a, p.confBA]]) {
        if (!partners.has(from_)) partners.set(from_, []);
        partners.get(from_).push({ key: to_, lift: p.lift, conf, together: p.together });
      }
    }
    for (const list of partners.values()) list.sort((a, b) => b.lift * b.conf - a.lift * a.conf);

    // fallback على مستوى الفئة: لكل فئة رئيسية، أحسن فئة مرافقة
    const catPartner = new Map();
    for (const p of CP) {
      if (p.lift < 1.05) continue;
      for (const [f, t, conf] of [[p.a, p.b, p.confAB], [p.b, p.a, p.confBA]]) {
        if (!ATTACH_CATS.includes(t)) continue;
        const cur = catPartner.get(f);
        if (!cur || cur.lift < p.lift) catPartner.set(f, { cat: t, lift: p.lift, conf });
      }
    }

    // أشهر صنف داخل كل فئة (لما نقترح فئة، نقترح أشهر صنف فيها)
    const catTop = new Map();
    for (const [key, n] of R.cnt) {
      const line = L.rows.find((r) => r.key === key);
      if (!line?.cat || !line.productId) continue;
      if (!catTop.has(line.cat)) catTop.set(line.cat, []);
      catTop.get(line.cat).push({ key, n, id: line.productId });
    }
    for (const l of catTop.values()) l.sort((a, b) => b.n - a.n);

    const data = { partners, catPartner, catTop, count: R.cnt, N: R.N, menu: L.menu, from, to, builtAt: new Date().toISOString() };
    rulesCache = { at: Date.now(), data, building: null };
    return data;
  })().catch((e) => { rulesCache.building = null; throw e; });
  return rulesCache.building;
}

/* ═══ التسجيل ════════════════════════════════════════════════════════════ */
export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, todayISO, daysAgoISO, jb } = ctx;

  const dayArg = (v, def) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : def);
  const R2 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
  const R0 = (n) => (n == null || !isFinite(n) ? null : Math.round(n));
  const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);

  /* جدول قياس الاقتراحات. بيتعمل هنا مش في schema.sql عشان الموديول
     يفضل مكتفي بنفسه ولو اتشال ما يسيبش أثر في ملف مشترك. */
  pool.query(`
    CREATE TABLE IF NOT EXISTS mp_events (
      id UUID PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      surface TEXT NOT NULL DEFAULT 'cart',
      session TEXT,
      cart_value NUMERIC DEFAULT 0,
      cart_items INT DEFAULT 0,
      suggested JSONB NOT NULL DEFAULT '[]',
      accepted TEXT,
      accepted_value NUMERIC DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS mp_events_at_idx ON mp_events(at);
    CREATE INDEX IF NOT EXISTS mp_events_session_idx ON mp_events(session);
  `).then(() => console.log("[menuplan] schema ready"))
    .catch((e) => console.error("[menuplan] schema failed:", e.message));

  /* ── GET /api/menuplan/categories ─────────────────────────────────────
     جدول الفئات كامل: الإيراد، الاختراق، متوسط السطر، الاتجاه الشهري،
     وعملاء كل فئة (كام عميل، كام واحد بياكل الفئة دي بس، ونسبة التكرار). */
  app.get("/api/menuplan/categories", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(89));
    const to = dayArg(c.req.query("to"), todayISO());
    const L = await loadLines(pool, from, to);
    const totalRev = L.rows.reduce((a, r) => a + r.rev, 0);
    const O = L.orders;

    const custOrders = new Map();
    for (const o of O) if (o.cust) { if (!custOrders.has(o.cust)) custOrders.set(o.cust, []); custOrders.get(o.cust).push(o); }

    const months = [...new Set(L.rows.map((r) => monthISO(r.calendar_day)))].sort();

    const cats = ALL_CATS.map((cat) => {
      const ls = L.rows.filter((r) => r.cat === cat);
      if (!ls.length) return null;
      const rev = ls.reduce((a, r) => a + r.rev, 0);
      const ords = new Set(ls.map((r) => r.order_id));
      const buyers = [...custOrders.entries()].filter(([, os]) => os.some((o) => o.cats.has(cat)));
      const isMain = MAIN_CATS.includes(cat);
      const only = isMain ? buyers.filter(([, os]) => {
        const mains = new Set();
        for (const o of os) for (const x of o.cats) if (MAIN_CATS.includes(x)) mains.add(x);
        return mains.size === 1 && mains.has(cat);
      }).length : null;
      const repeat = buyers.filter(([, os]) => os.filter((o) => o.cats.has(cat)).length >= 2).length;
      const theirOrders = buyers.flatMap(([, os]) => os.filter((o) => o.cats.has(cat)));
      return {
        cat, revenue: R0(rev), sharePct: pct(rev, totalRev),
        lines: ls.length, units: R2(ls.reduce((a, r) => a + (r.qty || 1), 0)),
        orders: ords.size, orderPenetrationPct: pct(ords.size, O.length),
        avgLineValue: R2(rev / ls.length),
        revenuePerDay: R0(rev / Math.max(1, new Set(O.map((o) => dayISO(o.day))).size)),
        customers: buyers.length,
        onlyThisCategory: only, onlyPct: isMain ? pct(only, buyers.length) : null,
        repeatCustomers: repeat, repeatRatePct: pct(repeat, buyers.length),
        avgTicketOfTheirOrders: R2(theirOrders.reduce((a, o) => a + o.total, 0) / (theirOrders.length || 1)),
        monthly: months.map((m) => R0(ls.filter((r) => monthISO(r.calendar_day) === m).reduce((a, r) => a + r.rev, 0))),
      };
    }).filter(Boolean).sort((a, b) => b.revenue - a.revenue);

    return c.json({
      ok: true, from, to, months,
      totalItemRevenue: R0(totalRev),
      orders: O.length,
      days: new Set(O.map((o) => dayISO(o.day))).size,
      categories: cats,
      customerBasis: {
        linkedCustomers: custOrders.size,
        linkedOrders: O.filter((o) => o.cust).length,
        ordersInWindow: O.length,
        note: "أرقام العملاء محسوبة على الطلبات المربوطة بعميل بس — الباقي كاش من غير اسم.",
      },
      coverage: L.coverage, imputed: L.imputed, unresolved: L.unresolved,
    });
  });

  /* ── GET /api/menuplan/pairs ──────────────────────────────────────────
     الاقترانات الحقيقية + «الأصناف اللي بتخرج لوحدها»: دي مش نفس الحاجة.
     الأولى بتقول أقترح إيه، والتانية بتقول أقترح فين. */
  app.get("/api/menuplan/pairs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(119));
    const to = dayArg(c.req.query("to"), todayISO());
    const min = Math.max(3, Number(c.req.query("min")) || 8);
    const L = await loadLines(pool, from, to);
    const R = buildRules(L.orders, min);
    const nameOf = new Map(L.rows.map((r) => [r.key, r.canonName]));
    const catOf = new Map(L.rows.map((r) => [r.key, r.cat]));
    const shape = (p) => ({
      a: nameOf.get(p.a), catA: catOf.get(p.a), b: nameOf.get(p.b), catB: catOf.get(p.b),
      together: p.together, supportPct: p.supportPct, confAB: p.confAB, confBA: p.confBA,
      lift: p.lift, ordersA: p.nA, ordersB: p.nB,
      verdict: p.lift >= 1.5 ? "قوي" : p.lift >= 1.15 ? "مفيد" : p.lift >= 0.9 ? "صدفة" : "متنافر",
    });

    // الأصناف اللي بتخرج من غير أي مقبلات ولا مشروب
    const byItem = new Map();
    for (const r of L.rows) {
      if (!MAIN_CATS.includes(r.cat)) continue;
      if (!byItem.has(r.key)) byItem.set(r.key, { name: r.canonName, cat: r.cat, id: r.productId, orders: new Set() });
      byItem.get(r.key).orders.add(r.order_id);
    }
    const oById = new Map(L.orders.map((o) => [o.id, o]));
    const days = Math.max(1, new Set(L.orders.map((o) => dayISO(o.day))).size);
    const naked = [...byItem.values()].filter((m) => m.orders.size >= 12).map((m) => {
      const os = [...m.orders].map((id) => oById.get(id));
      const alone = os.filter((o) => ![...o.cats].some((x) => ATTACH_CATS.includes(x)));
      const withSide = os.filter((o) => [...o.cats].some((x) => ATTACH_CATS.includes(x)));
      const gap = (withSide.reduce((a, o) => a + o.total, 0) / (withSide.length || 1)) -
                  (alone.reduce((a, o) => a + o.total, 0) / (alone.length || 1));
      return {
        item: m.name, cat: m.cat, productId: m.id, orders: os.length,
        nakedOrders: alone.length, nakedPct: pct(alone.length, os.length),
        avgTicketNaked: R2(alone.reduce((a, o) => a + o.total, 0) / (alone.length || 1)),
        avgTicketWithSide: R2(withSide.reduce((a, o) => a + o.total, 0) / (withSide.length || 1)),
        gapSAR: R2(gap),
        nakedPerDay: R2(alone.length / days),
        // لو ربع الطلبات العارية دي بس اتقبلت اقتراح، ده كام في الشهر
        monthlyOpportunitySAR: R0((alone.length / days) * 30 * 0.25 * Math.max(0, gap)),
      };
    }).sort((a, b) => b.monthlyOpportunitySAR - a.monthlyOpportunitySAR);

    return c.json({
      ok: true, from, to, minTogether: min, orders: L.orders.length,
      itemPairs: R.pairs.slice(0, 80).map(shape),
      itemPairsByVolume: [...R.pairs].sort((a, b) => b.together - a.together).slice(0, 40).map(shape),
      categoryPairs: catPairs(L.orders, Math.max(min, 10)),
      tooWeakToUse: R.pairs.filter((p) => p.lift < 1.15).slice(0, 25).map(shape),
      nakedMains: naked,
      coverage: L.coverage, imputed: L.imputed,
    });
  });

  /* ── GET /api/menuplan/attach ─────────────────────────────────────────
     الرقم اللي المالك سأل عنه بالظبط: الفاتورة بكام مع مقبلات ومن غيرها.
     بيترجع مرتين — على كل الطلبات، وعلى الطلبات اللي فيها طبق رئيسي واحد
     بس. التانية هي الصادقة: من غيرها الفرق بيبقى «الطلبات الكبيرة أكبر». */
  app.get("/api/menuplan/attach", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(89));
    const to = dayArg(c.req.query("to"), todayISO());
    const L = await loadLines(pool, from, to);
    const O = L.orders;
    const stat = (arr) => ({
      orders: arr.length,
      avgTicket: R2(arr.reduce((a, o) => a + o.total, 0) / (arr.length || 1)),
      avgItems: R2(arr.reduce((a, o) => a + o.units, 0) / (arr.length || 1)),
    });
    const has = (cat) => O.filter((o) => o.cats.has(cat));
    const hasnt = (cat) => O.filter((o) => !o.cats.has(cat));
    const singleMain = O.filter((o) =>
      o.lines.filter((l) => MAIN_CATS.includes(l.cat)).reduce((a, l) => a + (l.qty || 1), 0) === 1);
    const gap = (a, b) => R2(a.avgTicket - b.avgTicket);

    const smApp = stat(singleMain.filter((o) => o.cats.has("مقبلات")));
    const smNoApp = stat(singleMain.filter((o) => !o.cats.has("مقبلات")));
    const smDr = stat(singleMain.filter((o) => o.cats.has("مشروبات")));
    const smNoDr = stat(singleMain.filter((o) => !o.cats.has("مشروبات")));

    const byMonth = [...new Set(O.map((o) => monthISO(o.day)))].sort().map((m) => {
      const s = O.filter((o) => monthISO(o.day) === m);
      return { month: m, orders: s.length,
        appetizerAttachPct: pct(s.filter((o) => o.cats.has("مقبلات")).length, s.length),
        drinkAttachPct: pct(s.filter((o) => o.cats.has("مشروبات")).length, s.length),
        avgTicket: R2(s.reduce((a, o) => a + o.total, 0) / (s.length || 1)) };
    });

    const byOption = [...new Set(O.map((o) => o.option))].map((op) => {
      const s = O.filter((o) => o.option === op);
      return { option: op, ...stat(s),
        appetizerAttachPct: pct(s.filter((o) => o.cats.has("مقبلات")).length, s.length),
        drinkAttachPct: pct(s.filter((o) => o.cats.has("مشروبات")).length, s.length) };
    }).sort((a, b) => b.orders - a.orders);

    return c.json({
      ok: true, from, to,
      overall: {
        all: stat(O),
        appetizerAttachPct: pct(has("مقبلات").length, O.length),
        drinkAttachPct: pct(has("مشروبات").length, O.length),
        withAppetizer: stat(has("مقبلات")), withoutAppetizer: stat(hasnt("مقبلات")),
        withDrink: stat(has("مشروبات")), withoutDrink: stat(hasnt("مشروبات")),
      },
      /* المقارنة العادلة */
      singleMainOnly: {
        orders: singleMain.length,
        withAppetizer: smApp, withoutAppetizer: smNoApp, appetizerGapSAR: gap(smApp, smNoApp),
        appetizerGapPct: smNoApp.avgTicket ? Math.round(1000 * (smApp.avgTicket - smNoApp.avgTicket) / smNoApp.avgTicket) / 10 : null,
        withDrink: smDr, withoutDrink: smNoDr, drinkGapSAR: gap(smDr, smNoDr),
        note: "طلبات فيها طبق رئيسي واحد بس — عشان الفرق يبقى بسبب المقبلات مش بسبب حجم الطلب.",
      },
      byMonth, byOption,
      appetizerMenuPlacement: L.menu.pages.map((p) => ({ page: p.title, position: p.position, of: L.menu.pages.length, items: p.count })),
      coverage: L.coverage,
    });
  });

  /* ── POST /api/menuplan/merchandise ───────────────────────────────────
     ترتيب صفحات المنيو بحسب مساهمتها الحقيقية في الإيراد.

     الوضع النهارده: «اضافات» — اللي فيها كل المقبلات وكل المشروبات —
     آخر صفحة من عشرة. يعني العميل لازم يعدّي ٨٢ طبق قبل ما يشوف كولسلو.
     و«باستا» تاسعة وهي بتعمل ١٦٪ من الإيراد. الاتنين دفن، بس لسببين
     مختلفين: الباستا بتخسر طلبات، والمقبلات بتخسر رافعة الفاتورة
     (+٨.٨٢ ر.س على الطلب اللي فيه طبق رئيسي واحد).

     الترتيب الجديد بيحطّ المقبلات في النص مش في الأول — الأطباق
     الرئيسية تفضل هي اللي بتفتح المنيو، والمقبلات تبقى في الطريق مش
     في آخر السكة.

     الافتراضي dryRun: الراوت ده بيكتب في منيو العميل الحي، فمحدش
     بيغيّره بالغلط. لازم apply=1 صريحة. وبيرجّع دايماً أمر التراجع.  */
  const MERCH_BEFORE = [38, 39, 21, 23, 25, 40, 41, 42, 24, 26];
  const MERCH_AFTER = [38, 39, 21, 23, 24, 40, 26, 25, 41, 42];
  app.post("/api/menuplan/merchandise", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const apply = c.req.query("apply") === "1";
    let menu;
    try { menu = await import("./menu.js"); }
    catch (e) { return c.json({ ok: false, error: `menu module unavailable: ${e.message}` }, 500); }

    let editor;
    try { editor = await menu.fetchMenuEditor(menu.EXTERNAL_MENU); }
    catch (e) { return c.json({ ok: false, error: `TabSense read failed: ${e.message}` }, 502); }
    const curIds = editor.pages.map((p) => p.id);
    const titleOf = new Map(editor.pages.map((p) => [p.id, p.localTitle || p.title]));

    // لو المالك زوّد أو شال صفحة، الترتيب المحفوظ هنا بقى قديم — نوقف
    // بدل ما نرتّب على فرضية باظت.
    const same = JSON.stringify([...curIds].sort((a, b) => a - b)) === JSON.stringify([...MERCH_BEFORE].sort((a, b) => a - b));
    if (!same) {
      return c.json({
        ok: false, error: "page set changed since this plan was written",
        current: curIds.map((id) => ({ id, title: titleOf.get(id) })),
        expected: MERCH_BEFORE,
        hint: "المنيو اتغيّر — راجع الترتيب المقترح قبل ما تطبّقه.",
      }, 409);
    }

    const plan = {
      before: curIds.map((id, i) => ({ position: i + 1, id, title: titleOf.get(id) })),
      after: MERCH_AFTER.map((id, i) => ({ position: i + 1, id, title: titleOf.get(id) })),
      rollback: { endpoint: "POST /api/menuplan/merchandise?apply=1&rollback=1", order: MERCH_BEFORE },
    };
    if (!apply) return c.json({ ok: true, dryRun: true, applied: false, plan, note: "ضيف apply=1 عشان يتنفّذ فعلاً." });

    const order = c.req.query("rollback") === "1" ? MERCH_BEFORE : MERCH_AFTER;
    try {
      await menu.orderPages(menu.EXTERNAL_MENU, order);
      const after = await menu.fetchMenuEditor(menu.EXTERNAL_MENU);
      menuCache = { at: 0, data: menuCache.data, error: null };   // اقرا المنيو من الأول
      return c.json({
        ok: true, applied: true, rolledBack: c.req.query("rollback") === "1",
        result: after.pages.map((p, i) => ({ position: i + 1, id: p.id, title: p.localTitle || p.title })),
        plan,
      });
    } catch (e) {
      return c.json({ ok: false, error: `reorder failed: ${e.message}`, plan }, 502);
    }
  });

  /* ── GET /api/menuplan/hours ──────────────────────────────────────────
     الساعات الميتة جوّه ١٢ظ–٢ص، وإيه اللي بيتباع في كل ساعة. */
  app.get("/api/menuplan/hours", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(89));
    const to = dayArg(c.req.query("to"), todayISO());
    const L = await loadLines(pool, from, to);
    const days = Math.max(1, new Set(L.orders.map((o) => dayISO(o.day))).size);
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const s = L.orders.filter((o) => o.hour === h);
      if (!s.length) continue;
      const rev = s.reduce((a, o) => a + o.total, 0);
      hours.push({
        hour: h, orders: s.length, ordersPerDay: R2(s.length / days),
        revenue: R0(rev), revenuePerDay: R0(rev / days),
        avgTicket: R2(rev / s.length),
        categories: ALL_CATS.map((cat) => ({ cat, orders: s.filter((o) => o.cats.has(cat)).length }))
          .filter((x) => x.orders > 0).sort((a, b) => b.orders - a.orders).slice(0, 5),
      });
    }
    const open = hours.filter((h) => h.hour >= 12 || h.hour <= 2);
    const median = open.length ? [...open].sort((a, b) => a.revenuePerDay - b.revenuePerDay)[Math.floor(open.length / 2)].revenuePerDay : 0;
    return c.json({
      ok: true, from, to, days, hours,
      idleHours: open.filter((h) => h.revenuePerDay < median * 0.6)
        .sort((a, b) => a.revenuePerDay - b.revenuePerDay)
        .map((h) => ({ hour: h.hour, revenuePerDay: h.revenuePerDay, ordersPerDay: h.ordersPerDay, avgTicket: h.avgTicket })),
      medianOpenHourRevenuePerDay: R0(median),
      note: "الساعة بتوقيت الرياض. «ميتة» = إيراد الساعة أقل من ٦٠٪ من وسيط ساعات الفتح.",
      coverage: L.coverage,
    });
  });

  /* ── GET /api/menuplan/suggest ────────────────────────────────────────
     عام. المتجر بينادي ده لما العميل يضيف صنف للسلة. بيرجّع أصناف من
     المنيو الحية بس — مفيش صنف ولا سعر مخترع. */
  app.get("/api/menuplan/suggest", async (c) => {
    let rules;
    try { rules = await suggestionRules(pool, todayISO); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e), suggestions: [] }, 200); }

    const ids = String(c.req.query("ids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40);
    const limit = Math.min(4, Math.max(1, Number(c.req.query("limit")) || 3));
    const surface = c.req.query("surface") === "checkout" ? "checkout" : "cart";
    const menu = rules.menu;

    const inCart = [], cartKeys = new Set(), cartCats = new Set();
    for (const id of ids) {
      const rec = menu.byId.get(String(id));
      if (!rec) continue;
      inCart.push(rec);
      cartKeys.add(norm(rec.name));
      if (rec.cat) cartCats.add(rec.cat);
    }
    if (!inCart.length) return c.json({ ok: true, suggestions: [], reason: "empty cart" });

    /* الترشيح: كل شريك حقيقي لأي صنف في السلة، من غير اللي موجود أصلاً.
       المقبلات والمشروبات بتاخد دفعة لأنها بتزوّد الفاتورة من غير ما
       تاكل من طبق رئيسي تاني — وده كل الهدف. */
    const scored = new Map();
    for (const rec of inCart) {
      const key = norm(rec.name);
      for (const p of rules.partners.get(key) || []) {
        if (cartKeys.has(p.key)) continue;
        const cand = menu.byId.get(menu.byNorm.get(p.key));
        if (!cand || !cand.cat) continue;              // لازم يكون على المنيو الحية
        if (cand.id === rec.id) continue;
        const boost = ATTACH_CATS.includes(cand.cat) ? 1.6 : 1;
        const score = p.lift * Math.log1p(p.conf) * Math.log1p(p.together) * boost;
        const prev = scored.get(cand.id);
        if (!prev || prev.score < score) {
          scored.set(cand.id, { item: cand, score, lift: p.lift, conf: p.conf, together: p.together, becauseOf: rec.name, source: "item" });
        }
      }
    }

    /* لو الصنف نفسه مالوش شريك مثبت، ننزل لمستوى الفئة: أشهر صنف في
       الفئة اللي بتترافق مع فئة الطبق. مقولة إنها fallback في الرد. */
    if (scored.size < limit) {
      for (const cat of cartCats) {
        const cp = rules.catPartner.get(cat);
        if (!cp) continue;
        for (const top of (rules.catTop.get(cp.cat) || []).slice(0, 4)) {
          const cand = menu.byId.get(String(top.id));
          if (!cand || !cand.cat || cartKeys.has(norm(cand.name)) || scored.has(cand.id)) continue;
          scored.set(cand.id, { item: cand, score: cp.lift * 0.5, lift: cp.lift, conf: cp.conf, together: null, becauseOf: cat, source: "category" });
        }
      }
    }

    /* مشروب واحد بالكتير — تلات مشروبات في صف مش اقتراح، ده إلحاح. */
    const picked = [];
    let drinks = 0;
    for (const s of [...scored.values()].sort((a, b) => b.score - a.score)) {
      if (s.item.cat === "مشروبات" && drinks >= 1) continue;
      if (s.item.cat === "مشروبات") drinks++;
      picked.push(s);
      if (picked.length >= limit) break;
    }

    c.header("Cache-Control", "public, max-age=120");
    return c.json({
      ok: true, surface,
      basedOn: { orders: rules.N, from: rules.from, to: rules.to, builtAt: rules.builtAt },
      suggestions: picked.map((s) => ({
        id: s.item.id, name: s.item.name, english: s.item.english,
        price: s.item.price, image: s.item.image, cat: s.item.cat,
        becauseOf: s.becauseOf, source: s.source,
        lift: s.lift, confidencePct: s.conf, together: s.together,
        // نص للعميل: نبرة جرسون، من غير أرقام ولا ضغط
        line: s.source === "item"
          ? `كتير بيطلبوه مع ${s.becauseOf}`
          : `يمشي حلو مع ${s.becauseOf}`,
      })),
    });
  });

  /* ── POST /api/menuplan/event ─────────────────────────────────────────
     قياس. من غيره الاقتراح ده مجرد رأي. */
  const KINDS = new Set(["shown", "accepted", "dismissed", "checkout"]);
  const seen = new Map();  // rate limit بسيط لكل IP
  app.post("/api/menuplan/event", async (c) => {
    const ip = (c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "?";
    const now = Date.now();
    const hits = (seen.get(ip) || []).filter((t) => now - t < 60_000);
    if (hits.length >= 60) return c.json({ ok: false, error: "rate limited" }, 429);
    hits.push(now); seen.set(ip, hits);
    if (seen.size > 5000) seen.clear();

    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
    const kind = String(b.kind || "");
    if (!KINDS.has(kind)) return c.json({ ok: false, error: "unknown kind" }, 400);
    const suggested = (Array.isArray(b.suggested) ? b.suggested : []).slice(0, 6)
      .map((s) => ({ id: String(s?.id ?? "").slice(0, 32), cat: String(s?.cat ?? "").slice(0, 32) })).filter((s) => s.id);

    await pool.query(
      `INSERT INTO mp_events (id, kind, surface, session, cart_value, cart_items, suggested, accepted, accepted_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [crypto.randomUUID(), kind,
       String(b.surface || "cart").slice(0, 16),
       String(b.session || "").slice(0, 64) || null,
       Math.max(0, Math.min(100000, Number(b.cartValue) || 0)),
       Math.max(0, Math.min(999, Math.round(Number(b.cartItems) || 0))),
       jb(suggested),
       b.accepted ? String(b.accepted).slice(0, 32) : null,
       Math.max(0, Math.min(10000, Number(b.acceptedValue) || 0))]
    ).catch((e) => console.error("[menuplan] event store failed:", e.message));
    return c.json({ ok: true });
  });

  /* ── GET /api/menuplan/uplift ─────────────────────────────────────────
     هل الاقتراح رفع الفاتورة؟ المقارنة الوحيدة النضيفة اللي عندنا: نفس
     السطح، ناس اتعرض عليهم اقتراح وقبلوا مقابل ناس اتعرض عليهم ورفضوا —
     مش مقابل كل الزوار (دول مش نفس الناس أصلاً). ومع ذلك دي مش تجربة
     عشوائية، فبتترجع مكتوب عليها كده. */
  app.get("/api/menuplan/uplift", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());

    const rows = (await pool.query(
      `SELECT kind, surface, session, cart_value::float cart_value, cart_items,
              accepted, accepted_value::float accepted_value, at
         FROM mp_events
        WHERE at >= $1::date AND at < ($2::date + 1)`, [from, to])).rows;

    const bySession = new Map();
    for (const r of rows) {
      const k = r.session || r.id || Math.random();
      if (!bySession.has(k)) bySession.set(k, []);
      bySession.get(k).push(r);
    }
    const shown = [], accepted = [], declined = [];
    for (const evs of bySession.values()) {
      if (!evs.some((e) => e.kind === "shown")) continue;
      const final = evs.filter((e) => e.kind === "checkout").sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      const value = final ? final.cart_value : Math.max(...evs.map((e) => e.cart_value || 0));
      const rec = { value, items: final ? final.cart_items : Math.max(...evs.map((e) => e.cart_items || 0)), reachedCheckout: !!final };
      shown.push(rec);
      (evs.some((e) => e.kind === "accepted") ? accepted : declined).push(rec);
    }
    const agg = (a) => ({
      sessions: a.length,
      avgCartValue: R2(a.reduce((x, r) => x + r.value, 0) / (a.length || 1)),
      avgItems: R2(a.reduce((x, r) => x + r.items, 0) / (a.length || 1)),
      reachedCheckoutPct: pct(a.filter((r) => r.reachedCheckout).length, a.length),
    });
    const A = agg(accepted), D = agg(declined);

    const counts = {};
    for (const k of ["shown", "accepted", "dismissed", "checkout"]) counts[k] = rows.filter((r) => r.kind === k).length;
    const bySurface = ["cart", "checkout"].map((s) => ({
      surface: s,
      shown: rows.filter((r) => r.kind === "shown" && r.surface === s).length,
      accepted: rows.filter((r) => r.kind === "accepted" && r.surface === s).length,
    })).map((x) => ({ ...x, acceptRatePct: pct(x.accepted, x.shown) }));

    const topAccepted = Object.entries(rows.filter((r) => r.kind === "accepted" && r.accepted)
      .reduce((m, r) => { m[r.accepted] = (m[r.accepted] || 0) + 1; return m; }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, n]) => ({ productId: id, accepted: n }));

    return c.json({
      ok: true, from, to, counts, bySurface, topAccepted,
      acceptRatePct: pct(counts.accepted, counts.shown),
      accepted: A, declined: D,
      upliftSAR: A.avgCartValue != null && D.avgCartValue != null ? R2(A.avgCartValue - D.avgCartValue) : null,
      upliftPct: D.avgCartValue ? Math.round(1000 * (A.avgCartValue - D.avgCartValue) / D.avgCartValue) / 10 : null,
      caveat: "مقارنة رصدية مش تجربة عشوائية: اللي بيقبل اقتراح غالباً جعان أكتر من الأساس. الرقم مؤشر اتجاه، مش سببية.",
    });
  });

  /* ── أهداف الفئات ─────────────────────────────────────────────────────
     مفيش مخزن تاني للأهداف. بطاقة الأداء (scorecard.js) بتقرا من
     settings.scorecard.categoryTargets بمفاتيح إنجليزي — فده بالظبط المكان
     اللي بنكتب فيه، وبنفس المفاتيح. الملف ده بيحسب الأرقام؛ البطاقة
     بتعرضها؛ ومحدش بيخزّن نسخته الخاصة عشان الاتنين ما يختلفوش.
     الكتابة بـ jsonb_set على المفتاح ده لوحده — باقي إعدادات البطاقة
     (نافذة الفتح، الروافع، نسبة الإعلانات) ما بتتلمسش. */
  const CAT_TO_SCORECARD = {
    "بيتزا": "pizza", "باستا": "pasta", "كريب": "crepe", "مشاوي": "grill",
    "حواوشي": "hawawshi", "برجر": "burger", "مقبلات": "appetizers",
    "طاسات": "skillet", "مشروبات": "drinks", "عروض": "offers",
  };
  const SCORECARD_TO_CAT = Object.fromEntries(Object.entries(CAT_TO_SCORECARD).map(([a, e]) => [e, a]));

  const targetsOf = async () => {
    const s = await getSettingsData();
    const t = s?.scorecard?.categoryTargets || null;
    if (!t) return null;
    const out = {};
    for (const [k, v] of Object.entries(t)) if (SCORECARD_TO_CAT[k] && v != null) out[SCORECARD_TO_CAT[k]] = Number(v);
    return out;
  };

  app.get("/api/menuplan/targets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    const mp = s.menuplan || {};
    const targets = await targetsOf();
    const dailyGoal = Number(s?.scorecard?.goalDailySales || s?.goalDailySales || 10000);

    // الفعلي آخر ٣٠ يوم، على نفس التقسيم، عشان الهدف يتقرا جنب الواقع
    let actual = null;
    try {
      const L = await loadLines(pool, daysAgoISO(29), todayISO());
      const days = Math.max(1, new Set(L.orders.map((o) => dayISO(o.day))).size);
      const totalItemRev = L.rows.reduce((a, r) => a + r.rev, 0);
      // إيراد الفئة الفعلي بالريال/يوم، متدرّج على إجمالي الفواتير الحقيقي
      // (سطور الأصناف مش مغطية كل الطلبات، فالنسبة أصدق من الرقم الخام)
      const realDaily = (await pool.query(
        `SELECT COALESCE(sum(o.total),0)::float rev, count(DISTINCT o.calendar_day)::int d
           FROM ts_orders o WHERE ${SALES_ONLY} AND o.calendar_day >= CURRENT_DATE - 29`)).rows[0];
      const scale = totalItemRev ? (Number(realDaily.rev) / Math.max(1, realDaily.d)) / (totalItemRev / days) : 1;
      actual = { days, scaleNote: "نصيب الفئة من سطور الأصناف × إجمالي المبيعات الحقيقي", byCat: {} };
      for (const cat of ALL_CATS) {
        const rev = L.rows.filter((r) => r.cat === cat).reduce((a, r) => a + r.rev, 0);
        actual.byCat[cat] = R0((rev / days) * scale);
      }
      actual.totalPerDay = R0(Number(realDaily.rev) / Math.max(1, realDaily.d));
    } catch (e) { actual = { error: String(e.message || e) }; }

    return c.json({
      ok: true, dailyGoal, targets, actual,
      storedAt: "settings.scorecard.categoryTargets",
      rationale: mp.rationale || null,
      updatedAt: mp.targetsUpdatedAt || null,
      note: targets ? null : "مفيش أهداف متسجّلة لسه — استخدم PUT /api/menuplan/targets.",
    });
  });

  app.put("/api/menuplan/targets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
    const targets = {}, scoreTargets = {};
    for (const [k, v] of Object.entries(b.targets || {})) {
      const n = Number(v);
      const id = CAT_TO_SCORECARD[k] || (SCORECARD_TO_CAT[k] ? k : null);
      if (!id || !isFinite(n) || n < 0) continue;
      scoreTargets[id] = Math.round(n);
      targets[SCORECARD_TO_CAT[id]] = Math.round(n);
    }
    if (!Object.keys(scoreTargets).length) return c.json({ ok: false, error: "no valid targets" }, 400);
    const dailyGoal = Number(b.dailyGoal) > 0 ? Math.round(Number(b.dailyGoal)) : 10000;

    // مفتاحين منفصلين: أهداف الفئات في مخزن البطاقة، وسبب كل رقم عندنا.
    await pool.query(
      `INSERT INTO settings (id, data) VALUES (1, jsonb_build_object('scorecard',
          jsonb_build_object('categoryTargets', $1::jsonb, 'goalDailySales', $2::int)))
       ON CONFLICT (id) DO UPDATE SET
         data = jsonb_set(
                  jsonb_set(COALESCE(settings.data,'{}'::jsonb), '{scorecard}',
                            COALESCE(settings.data->'scorecard','{}'::jsonb), true),
                  '{scorecard,categoryTargets}', $1::jsonb, true)
                || jsonb_build_object('menuplan',
                     COALESCE(settings.data->'menuplan','{}'::jsonb) || $3::jsonb),
         updated_at = NOW()`,
      [jb(scoreTargets), dailyGoal,
       jb({ targetsUpdatedAt: new Date().toISOString(), dailyGoal, ...(b.rationale ? { rationale: b.rationale } : {}) })]);

    return c.json({
      ok: true, targets, scorecardKeys: scoreTargets, dailyGoal,
      sum: Object.values(scoreTargets).reduce((a, v) => a + v, 0),
      storedAt: "settings.scorecard.categoryTargets",
    });
  });

  console.log("[menuplan] routes ready");
  return { loadLines: (from, to) => loadLines(pool, from, to), targetsOf, liveMenu, MAIN_CATS, ATTACH_CATS, ALL_CATS };
}
