/* ═══════════════════════════════════════════════════════════════════════════
   🍽 FD1 (١٤/١٠) — حملة واتساب «طبقك المفضل»: عرض لكل عميل من طلباته القديمة + سعر توصيله الحقيقي

   طلب عمر (١٤/١٠): «ابعت ١٠٠ رسالة تسويقية واتساب فيها بيانات واضحة تحفّز الناس تطلب، بناءً على طلباتهم القديمة
   وأصنافهم المفضلة» وبعدها: «نظهر التوصيل وسعره على الطلب، ولو في عرض للأصناف المفضلة أو بوكسات تكون لها أولوية».

   القالب: fc_frame_ask_text (الرد أولاً، معتمد) — «جديد من فريش كاتس 👋\n{{1}}: {{2}}.\nتبي نجهز لك الطلب هنا؟ …»
   {{1}} عنوان قصير و{{2}} سطر واحد، وبيتحسبوا هنا **لكل عميل** (wa_send_queue.vars.cloud) — الحملة نفسها مالهاش قيم.

   الأولوية (chooseOffer):
     ١) بوكس / باقة شغّالة فيها طبقه المفضل بالظبط (الباقات المربوطة بعرض: لعميل تاريخه فيه طلبات جمعات بس، والعرض شغّال)
     ٢) بوكس من نفس نوع أكله («بوكس يناسب ذوقك» — «بسعر يبدأ من» لو فيه اختيارات بزيادة)
     ٣) طبقه نفسه (بالوزن: وزنه المعتاد «كباب مشوي نص كيلو»؛ من غير عدد أشخاص أبداً)
   مايتختارش أبداً: مشروب، صوص، إضافة، رز، صنف جانبي (isDishName + قسم «إضافات»).

   السعر: من المنيو والبوكسات الحيّة (نفس مصادر البوت). بيتراجع تاني وقت الإرسال (recheck) ووقت ضغطة «أبغى أطلب»:
   الصنف/البوكس اتشال أو خلص أو اتخفى أو سعره اتغيّر ⇒ الصف يتخطّى (offer_changed / offer_gone) — مفيش سعر قديم يوصل لعميل.

   التوصيل (deliveryLine): نفس دالة التسعير بتاعة صفحة الدفع (delivery.quote) لآخر عنوان توصيل مدفوع للعميل (وإلا آخر
   عنوان في حسابه)، **من كاش مسافات جوجل بس** (cacheOnly — مفيش نداء جديد). مسافة مش مؤكدة ⇒ مفيش رقم:
   «ونوصله لك أو تستلمه من فرعنا»، والتقدير بيقول بره النطاق ⇒ «وتقدر تستلمه من فرعنا». FIRST (أول توصيل من الموقع، حد أدنى من
   الكوبون نفسه) ومكافأة الولاء بنفس قواعد الدفع: بيلغوا الرسم الأساسي بس (رسم المسافة الإضافية بيفضل)، والرقم المحسوب بالكود بيتقال
   معاه اسم الكود. من غير مسافة مؤكدة FIRST بيتقال دايماً «داخل نطاق التوصيل» (مراجعة FD1: مفيش وعد مجاني صفحة الدفع مش هتنفّذه).

   الرد (wabotrun): ضغطة «أبغى أطلب» على الرسالة، أو «نعم/أبغى» مكتوبة كأول حاجة بعدها (yesGate) ⇒ سلة جاهزة بنفس العرض بالحرف
   (tapOffer: أي اختلاف عن اللي اتبعت ⇒ الرد العادي). أي رسالة تانية (حتى «أبغى أطلب برجر») بتمشي في طريقها العادي.

   الشريحة (audienceRows): عملاء طلبوا (موقع أو نقطة بيع) في آخر poolDays يوم، ومش النهارده، من غير الفريق/التجربة/خصم
   المالك/الموقفين/أرقام تطبيقات التوصيل بس. الفاصل (٥–٩٠ يوم) والعدد من فلاتر الحملة العادية (wasender: minDaysSince /
   maxDaysSince / limit — الافتراضي ٥ و٩٠ هنا FAV_DEFAULT_FILTERS). باقي الاستبعادات (سقف التسويق ١/٧ و٣/٣٠، فاصل الـ٧ أيام،
   SMS قريب، طابور/محجوز، طلب مفتوح، أرقام غلط) في wasender.build زي أي حملة، وبتتراجع تاني وقت الإرسال.
═══════════════════════════════════════════════════════════════════════════ */
import { isDishName, cleanItemName } from "./wamsg.js";
import { QUICK_STATS_SQL } from "./customer360.js";
import { shopPaidSql, appOnlyPhonesSql, bizDaySql } from "./identity.js";
import { staffPhoneSet } from "./smsrules.js";
import { staffFromSettings, OWNER_COUPONS } from "./uploadgate.js";
import { teamConfig } from "./wateam.js";
import { findTemplate } from "./watemplates.js";
import { pausedOffersOf } from "./soldout.js";

export const FAV_PICK = "fav_pick";
export const FAV_AUDIENCE = Object.freeze({
  label: "🍽 طبقك المفضل + سعر التوصيل (لكل عميل)",
  hint: "كل عميل بيوصله بوكس فيه طبقه المفضل (أو طبقه نفسه) بسعره الحي وسعر التوصيل لعنوانه — قالب «الرد أولاً» بس",
});
/* الفاصل الافتراضي للشريحة دي (لو الحملة مابعتتش فلتر): آخر طلب من ٥ لـ٩٠ يوم */
export const FAV_DEFAULT_FILTERS = Object.freeze({ minDaysSince: 5, maxDaysSince: 90 });
/* قواعد الاختيار — ثابتة هنا ومتجرّبة (wafavpick.test.mjs). */
export const FAV_RULES = Object.freeze({
  poolDays: 120,            // أقدم طلب بيدخل الشريحة (الفلاتر بتضيّق جوّاه)
  histPerSource: 10,        // آخر كام طلب من الموقع + من نقطة البيع بيتقروا لكل عميل
  bigOrder: 250, bigTwice: 200, bigKilos: 2,   // «طلبات جمعات»: طلب ≥٢٥٠، أو طلبين ≥٢٠٠، أو ٢ كيلو في طلب
  packCeil: 1.3,            // الباقة لحد ١٫٣ × أكبر طلب في تاريخه
  boxHiMult: 1.6, boxHiAdd: 30, dishBoxMult: 1.15,   // سقف سعر البوكس قدّام متوسط سلّته
  minShareItem: 0.4, minShareCat: 0.55, minAbs: 100, // البوكس مايبقاش أرخص بكتير من سلّته
  firstBasket: 38,          // عميل مستحق FIRST وسلّته ≥٣٨: البوكس المستهدف فوق حد FIRST
  nudgeFree: 30, nudgeFirst: 35,                     // «ومجاني لو طلبك من …» لو الفرق ≤ كده
  recencyFull: 30, recencyFloor: 0.45, recencySpan: 110, spendCap: 3000, ordersCap: 20, perOrder: 25,
});

const DAY = 86400000;
const nz = (v) => (v == null ? "" : String(v));
const money = (n) => { const x = Number(n); return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, ""); };
export const maskPn = (pn) => `${nz(pn).slice(0, 2)}•••••${nz(pn).slice(-2)}`;

/* ── الأسماء ─────────────────────────────────────────────────────────────── */
const ALIAS = [[/موتزريلا/g, "موتزاريلا"], [/بينا/g, "بنا"], [/الاكيلة/g, "الأكيلة"]];
export function normAr(s) {
  let t = nz(s);
  for (const [re, to] of ALIAS) t = t.replace(re, to);
  return t.replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ـ/g, "").replace(/\s+/g, " ").trim();
}
export const cleanKey = (name) => normAr(cleanItemName(name, { withSize: false }));
export const dishName = (it) => nz(it && it.name).replace(/\s*بالوزن/g, "").replace(/\s+/g, " ").trim();
export function normW(w) {
  const s = nz(w).replace(/\s+/g, " ").trim();
  if (/^(نصف|نص) كيلو$/.test(s)) return "نصف كيلو";
  if (s === "ثلث كيلو") return "ثلث كيلو";
  if (s === "ربع كيلو") return "ربع كيلو";
  if (s === "كيلو") return "كيلو";
  return null;
}
export const showW = (w) => (w === "نصف كيلو" ? "نص كيلو" : w);

/* ── المنيو والبوكسات الحيّة ⇒ فهرس ──────────────────────────────────────── */
const SG_BY_CAT = { "Grills by the Kilo": "grill_kilo", Meals: "grill_meal", Skillets: "skillet", Crepes: "crepe", Pizza: "pizza", Pasta: "pasta", Burgers: "burger", Hawawshi: "hawawshi", "Sides & Drinks": "side" };
const SG_BY_CAT_AR = { "مشاوي بالوزن": "grill_kilo", "وجبات": "grill_meal", "طاسات": "skillet", "كريبات": "crepe", "بيتزا": "pizza", "باستا": "pasta", "برجر": "burger", "حواوشي": "hawawshi", "إضافات": "side" };
const FOOD_SG = new Set(["grill_kilo", "grill_meal", "skillet", "crepe", "pizza", "pasta", "burger", "hawawshi"]);
export function subgroupOf(it) {
  if (!it) return "other";
  return SG_BY_CAT[it.category] || SG_BY_CAT_AR[it.categoryAr] || (it.byWeight ? "grill_kilo" : "other");
}
const liveItem = (it) => Boolean(it) && !it.soldOut && FOOD_SG.has(subgroupOf(it)) && Number(it.price) > 0;

/* شكل الخانات (للتأكد إن نص البوكس المكتوب لسه بيوصف البوكس الحي): الثابت بصنفه ووزنه وكميته، والاختيار بأوزانه/أحجامه */
export function boxSig(slots) {
  return (slots || []).map((s) => (s.type === "fixed"
    ? `F:${s.key}:${s.item ? `${s.item.pid}${s.item.v != null ? `/${s.item.v}` : ""}` : "-"}x${s.q}`
    : `C:${s.key}x${s.q}:${[...new Set((s.choices || []).map((c) => c.vname || ""))].sort().join(",")}`)).join("|");
}
function normBox(b) {
  const slots = (Array.isArray(b.slots) ? b.slots : []).map((s) => (s && s.type === "fixed"
    ? { key: nz(s.key), type: "fixed", q: Number(s.quantity) || 1, item: s.item ? { pid: nz(s.item.product_id), v: s.item.variant_option_id ?? null, name: nz(s.item.name), vname: s.item.variant_name || null } : null }
    : { key: nz(s && s.key), type: "choice", q: Number(s && s.quantity) || 1,
      choices: (Array.isArray(s && s.choices) ? s.choices : []).map((c) => ({ pid: nz(c.product_id), v: c.variant_option_id ?? null, name: nz(c.name), vname: c.variant_name || null, sur: Number(c.surcharge) > 0 ? Number(c.surcharge) : 0 })) }));
  const section = nz(b.section).trim();
  const tier = !section ? "group" : /فردي/.test(section) ? "solo" : /لشخصين/.test(section) ? "duo" : "share";
  const kinds = Array.isArray(b.order_kinds) ? b.order_kinds.map(nz) : null;
  return { slug: nz(b.slug), name: nz(b.name || b.slug).trim(), price: Number(b.price), section, tier, offerId: b.offer_id ? nz(b.offer_id) : null, featured: b.featured === true, slots, sig: boxSig(slots), kinds };
}
/* menu = wabot.indexMenu (المخفي مش موجود فيه، و«خلص اليوم» soldOut) · bundles = ‎/api/shop/bundles (المتاح بس) · offers = العروض الشغّالة (null = مش معروفة ⇒ مفيش باقات)
   paused = settings.catalog.pausedOffers الشغّالة الحين (soldout.pausedOffersOf — بالـslug أو رقم العرض): باقة اتوقفت من البوابة بتختفي فوراً، من غير ما نستنى كاش البوكسات.
   الرسالة بتقول «والتوصيل لعنوانك …»: بوكس قنواته معروفة ومافيهاش توصيل (استلام/صالة بس) مابيتعرضش. */
export function buildLive({ menu, bundles, offers, paused = null } = {}) {
  const items = new Map(), byClean = new Map();
  for (const it of (menu && menu.items) || []) {
    items.set(nz(it.id), it);
    if (!FOOD_SG.has(subgroupOf(it))) continue;
    const c = cleanKey(it.name);
    if (c && !byClean.has(c)) byClean.set(c, it);
  }
  const stopped = paused && typeof paused === "object" ? paused : {};
  const boxes = new Map(), boxByClean = new Map();
  for (const raw of Array.isArray(bundles) ? bundles : []) {
    if (!raw || !raw.slug || !(Number(raw.price) > 0)) continue;
    const b = normBox(raw);
    if (b.kinds && b.kinds.length && !b.kinds.includes("delivery")) continue;
    if (stopped[b.slug] || (b.offerId && stopped[b.offerId])) continue;
    if (!b.slots.length || b.slots.some((s) => (s.type === "fixed" ? !s.item : !s.choices.length))) continue;
    boxes.set(b.slug, b);
    const c = cleanKey(b.name);
    if (c && !boxByClean.has(c)) boxByClean.set(c, b);
  }
  const offerIds = new Set((Array.isArray(offers) ? offers : []).map((o) => nz(o && o.id)).filter(Boolean));
  return { items, byClean, boxes, boxByClean, offerIds };
}
const inMenu = (live, pid) => live.items.get(nz(pid)) || null;
/* اختيار شغّال: مش «خلص اليوم». صنف مش في المنيو (مخفي) البوكسات نفسها بتقرّر عليه — ماينفعش يبقى اختيار افتراضي بس */
const choiceOk = (live, c) => { const it = inMenu(live, c.pid); return !(it && it.soldOut); };
export function boxLive(b, live) {
  if (!b) return false;
  for (const s of b.slots) {
    if (s.type === "fixed") { const it = inMenu(live, s.item.pid); if (it && it.soldOut) return false; }
    else if (!s.choices.some((c) => choiceOk(live, c))) return false;
  }
  if (b.tier === "group" && !(b.offerId && live.offerIds.has(b.offerId))) return false;
  return true;
}
export function inBox(b, pid) {
  const id = nz(pid);
  for (const s of b.slots) {
    if (s.type === "fixed" && s.item.pid === id) return { slot: s.key, fixed: true, sur: 0, v: s.item.v };
    if (s.type === "choice") { const c = s.choices.find((x) => x.pid === id); if (c) return { slot: s.key, fixed: false, sur: c.sur, v: c.v }; }
  }
  return null;
}
function boxHasGroup(b, sg, live) {
  if (!FOOD_SG.has(sg)) return false;
  return b.slots.some((s) => (s.type === "fixed" ? [s.item] : s.choices).some((c) => subgroupOf(inMenu(live, c.pid)) === sg));
}
const hasSur = (b) => b.slots.some((s) => s.type === "choice" && s.choices.some((c) => c.sur > 0));

/* ── التاريخ ⇒ الأطباق المفضّلة ─────────────────────────────────────────── */
const WEIGHT_RE1 = /-\s*((?:ثلث|نصف|نص|ربع)?\s*كيلو)\s*$/;
const WEIGHT_RE2 = /\s((?:ثلث|نصف|نص|ربع)\s*كيلو)/;
const atMs = (v) => (v instanceof Date ? v.getTime() : Date.parse(nz(v)));
/* H = [{at, names:"a|b ×2|c"}] — نفس وزن الحداثة بتاع wamsg.favDish (١ ÷ (١ + الأيام/٣٠))، بس قايمة مترتبة + الأوزان المعتادة */
export function rankDishes(H, now = Date.now()) {
  const score = new Map(), weights = new Map();
  for (const o of H || []) {
    const t = atMs(o.at);
    const w = 1 / (1 + (Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : 90) / 30);
    for (const raw0 of nz(o.names).split("|")) {
      const raw = raw0.replace(/\s*×\d+\s*$/, "").trim();
      if (!raw || !isDishName(raw)) continue;
      const c = cleanKey(raw);
      if (!c) continue;
      score.set(c, (score.get(c) || 0) + w);
      const m = raw.match(WEIGHT_RE1) || raw.match(WEIGHT_RE2);
      const wn = m ? normW(m[1]) : null;
      if (wn) { const k = `${c}|${wn}`; weights.set(k, (weights.get(k) || 0) + 1); }
    }
  }
  return { list: [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)), weights };
}
/* الوزن المعتاد للصنف من تاريخه، على أوزانه الحيّة (variant_option_id) — مفيش ⇒ نص كيلو ⇒ أول وزن */
export function usualWeight(clean, weights, it) {
  const opts = Array.isArray(it && it.weights) ? it.weights : [];
  if (!opts.length) return null;
  let best = null, bn = 0;
  for (const [k, n] of weights || []) { const i = k.lastIndexOf("|"); if (k.slice(0, i) === clean && n > bn) { best = k.slice(i + 1); bn = n; } }
  const byLabel = (l) => opts.find((o) => normW(o.label_ar) === l) || null;
  const pick = (best && byLabel(best)) || byLabel("نصف كيلو") || opts[0];
  return pick ? { vid: pick.variant_option_id, label: normW(pick.label_ar) || nz(pick.label_ar), price: Number(pick.price), guessed: !(best && byLabel(best)) } : null;
}
const median = (a) => { const s = a.filter((x) => x > 0).sort((x, y) => x - y); if (!s.length) return 0; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/* سلّة العميل: الوسيط وأكبر طلب وهل عنده طلبات جمعات */
export function basketOf(H, { spend = 0, orders = 0 } = {}) {
  const totals = (H || []).map((o) => Number(o.total) || 0).filter((x) => x >= 15);
  const basketM = median(totals.slice(0, 8)) || (Number(spend) / Math.max(1, Number(orders) || 1));
  const maxT = Math.max(0, ...totals);
  const kilos = (H || []).map((o) => nz(o.names).split("|").reduce((n, x) => n + (/بالوزن\s*-\s*كيلو/.test(x) ? (Number((x.match(/×(\d+)\s*$/) || [])[1]) || 1) : 0), 0));
  const bigGroup = maxT >= FAV_RULES.bigOrder || totals.filter((x) => x >= FAV_RULES.bigTwice).length >= 2 || Math.max(0, ...kilos) >= FAV_RULES.bigKilos;
  return { basketM, maxT, bigGroup };
}

/* ── اختيار العرض (الأولوية) ─────────────────────────────────────────────── */
const THEME = { crepe: /crepe/, pasta: /pasta/, pizza: /pizza/, burger: /burger/, hawawshi: /hawawshi/, grill_meal: /meal|mixgrill/, grill_kilo: /grill-half|mashakel|ribs|gathering/, skillet: /late-night/ };
export function chooseOffer({ it, sg, basketM, maxT = 0, bigGroup = false, firstElig = false, firstMin = 60, dishPrice = null, live }) {
  const R = FAV_RULES;
  const T = Math.max(15, firstElig && basketM >= R.firstBasket ? Math.max(basketM, firstMin + 2) : basketM);
  const hi = Math.max(T * R.boxHiMult, T + R.boxHiAdd, (Number(dishPrice) || Number(it.price) || 0) * R.dishBoxMult);
  const cand = [];
  for (const b of live.boxes.values()) {
    if (!boxLive(b, live)) continue;
    const m = inBox(b, it.id);
    const catOnly = !m && boxHasGroup(b, sg, live);
    if (!m && !catOnly) continue;
    const price = b.price + (m ? m.sur : 0);
    const theme = THEME[sg] && THEME[sg].test(b.slug) ? 0.15 : 0;
    let rank;
    if (b.tier === "group") {
      if (!bigGroup || !(m || sg === "grill_kilo")) continue;
      if (price > maxT * R.packCeil) continue;
      rank = (m ? 0 : 0.5) - 0.3 + Math.abs(Math.log(price / Math.max(60, basketM, 0.6 * maxT)));
    } else {
      if (price > hi) continue;
      if (price < Math.min((m ? R.minShareItem : R.minShareCat) * T, R.minAbs)) continue;
      rank = (m ? 0 : 1) + Math.abs(Math.log(price / T)) - theme - (b.featured ? 0.03 : 0);
    }
    cand.push({ b, m, catOnly, price, rank });
  }
  cand.sort((x, y) => x.rank - y.rank || (x.b.slug < y.b.slug ? -1 : 1));
  return cand[0] || null;
}

/* ── نص البوكس ({{2}} من غير «:» — «اسم البوكس (المحتوى) بـX ر.س») ──────────────────────────────
   النص المكتوب لكل بوكس بيتستعمل بس لو شكل البوكس الحي لسه زي ما اتكتب عليه (BOX_SIG من بوكسات ١٤/١٠)،
   غير كده «اسم البوكس (فيه طبقك)» — مانوصفش محتوى اتغيّر. */
const PIZZA_M = (f, sg) => (sg === "pizza" ? `${f} وسط` : f);
export const BOX_COPY = {
  "box-solo-crepe": (f) => `بوكس الكريب الفردي (${f || "كريب من اختيارك"} مع صنف جانبي ومشروب غازي)`,
  "box-solo-mixgrill": (f) => `بوكس الميكس جريل الفردي (${f || "وجبة ميكس جريل أو كفتة وطرب"} مع صنف جانبي ومشروب غازي)`,
  "box-solo-burger": (f) => `بوكس البرجر الفردي (${f || "برجر من اختيارك"} مع بطاطس ومقرمشات ومشروب غازي)`,
  "box-solo-pasta": (f) => `بوكس الباستا الفردي (${f || "باستا من اختيارك"} مع صنف جانبي ومشروب غازي)`,
  "box-solo-hawawshi": (f) => `بوكس الحواوشي الفردي (${f || "حواوشي من اختيارك"} مع بطاطس وصنف جانبي ومشروب غازي)`,
  "box-solo-meal": (f) => `بوكس وجبة المشاوي الفردي (${f || "وجبة مشاوي من اختيارك"} مع صنف جانبي ومشروب غازي)`,
  "box-crepe-duo": (f) => `بوكس الكريب لشخصين (${f ? `${f} وكريب ثاني من اختيارك` : "كريبين من اختيارك"} مع تشيز فرايز وصنف جانبي ومشروبين)`,
  "box-mixgrill-duo": (f) => `ميكس جريل لشخصين (${f ? `${f} ووجبة ثانية من اختيارك` : "وجبتين ميكس جريل أو كفتة وطرب"} مع بطاطس وكولسلو ومشروبين)`,
  "box-pizza-pasta": (f, sg) => `بيتزا وباستا لشخصين (${f ? (sg === "pizza" ? `${f} وسط وباستا من اختيارك` : `${f} وبيتزا وسط من اختيارك`) : "بيتزا وسط وباستا من اختيارك"} مع مقرمشات وكولسلو ومشروبين)`,
  "box-meals-duo": (f) => `وجبتين مشاوي لشخصين (${f ? `${f} ووجبة ثانية من اختيارك` : "وجبتين من اختيارك"} مع بطاطس وكولسلو ودوريتوس ومشروبين)`,
  "box-burger-duo": (f) => `بوكس البرجر لشخصين (${f ? `${f} وبرجر ثاني من اختيارك` : "برجرين من اختيارك"} مع بطاطس وحلقات بصل وتشيز فرايز ومشروبين)`,
  "box-late-night": (f, sg) => `بوكس السهرة (${f ? (sg === "skillet" ? `${f} وكريب من اختيارك` : `${f} وطاسة من اختيارك`) : "طاسة وكريب من اختيارك"} مع تشيلي تشيز فرايز وحلقات بصل ومشروبين)`,
  "box-taste-all": (f, sg) => {
    const rest = { pizza: "باستا وكريب وحواوشي", pasta: "بيتزا وسط وكريب وحواوشي", crepe: "بيتزا وسط وباستا وحواوشي", hawawshi: "بيتزا وسط وباستا وكريب" }[sg];
    return `بوكس التشكيلة (${f && rest ? `${PIZZA_M(f, sg)} مع ${rest} من اختيارك` : "بيتزا وسط وباستا وكريب وحواوشي من اختيارك"} وبطاطس وكولسلو ومشروبين)`;
  },
  /* FD1 مراجعة: خانتين مشاوي «نصف كيلو» لكل واحدة = كيلو كامل — «نص كيلو من نوعين» كانت بتتقري نص كيلو بس */
  "box-grill-half-half": (f) => `بوكس المشاوي نص ونص (${f ? `نص كيلو ${f} ونص كيلو ثاني من اختيارك` : "نوعين مشاوي من اختيارك نص كيلو لكل نوع"} مع طبقين أرز وبطاطس وكولسلو)`,
  "box-family": (f, sg) => (sg === "grill_kilo" && f ? `بوكس العائلة (نص كيلو ${f} ونص كيلو مشاوي ثاني مع بيتزا وسط وباستا و3 أطباق أرز و4 مشروبات)`
    : sg === "pizza" && f ? `بوكس العائلة (${f} وسط ونوعين مشاوي نص كيلو لكل نوع وباستا مع 3 أطباق أرز و4 مشروبات)`
      : sg === "pasta" && f ? `بوكس العائلة (${f} ونوعين مشاوي نص كيلو لكل نوع وبيتزا وسط مع 3 أطباق أرز و4 مشروبات)`
        : "بوكس العائلة (نوعين مشاوي نص كيلو لكل نوع مع بيتزا وسط وباستا و3 أطباق أرز و4 مشروبات)"),
  "box-pizza-night": (f) => `بوكس سهرة البيتزا (${f ? `${f} وسط وبيتزا وسط ثانية من اختيارك` : "بيتزتين وسط من اختيارك"} مع فرايد موتزاريلا وبطاطس ومشروبين)`,
  "box-mashakel": (f, sg, pid) => `بوكس المشكل المخصوص (نص كيلو مشكل مخصوص ونص كيلو ${f && pid !== "103" ? f : "مشاوي من اختيارك"} مع طبقين أرز وبطاطس وكولسلو)`,
  "box-ribs-grill": (f, sg, pid) => `بوكس الريش والمشاوي (ثلث كيلو ريش و${f && pid !== "100" ? `نص كيلو ${f} ونص كيلو ثاني من اختيارك` : "نوعين مشاوي نص كيلو لكل نوع"} مع طبقين أرز وبطاطس و4 مشروبات)`,
  "gathering-4": () => "باقة تجمّع 4–6 أشخاص (2 كيلو مشاوي من اختيارك مع أرز وبطاطس وكولسلو و4 مشروبات)",
  "gathering-8": () => "باقة تجمّع 8–10 أشخاص (3 كيلو مشاوي ودجاجة كاملة على الفحم مع أرز وبطاطس وكولسلو و8 مشروبات)",
  "gathering-15": () => "باقة 15 شخص وأكثر (4 كيلو مشاوي ودجاجتين على الفحم مع أرز وبطاطس وكولسلو و12 مشروب)",
};
/* شكل كل بوكس يوم ١٤/١٠ (‎/api/shop/bundles‎) — النص اللي فوق بيوصفه. شكل مختلف ⇒ الصيغة العامة. */
export const BOX_SIG = {
  "gathering-4": "C:grill1x1:كيلو|C:grill2x1:كيلو|F:rice:123x2|F:fries:79x2|F:coleslaw:72x2|F:drinks:82/42x4",
  "gathering-8": "C:grill1x1:كيلو|C:grill2x1:كيلو|C:grill3x1:كيلو|F:chicken:14x1|F:rice:123x3|F:fries:79x4|F:coleslaw:72x3|F:drinks:82/42x8",
  "gathering-15": "C:grill1x1:كيلو|C:grill2x1:كيلو|C:grill3x1:كيلو|C:grill4x1:كيلو|F:chicken:14x2|F:rice:123x6|F:fries:79x6|F:coleslaw:72x4|F:drinks:82/42x12",
  "box-solo-crepe": "C:crepex1:|C:sidex1:|F:drink:82/42x1",
  "box-solo-mixgrill": "C:mealx1:|C:sidex1:|F:drink:82/42x1",
  "box-solo-burger": "C:burgerx1:|F:fries:79x1|C:extrax1:|F:drink:82/42x1",
  "box-solo-pasta": "C:pastax1:|C:sidex1:|F:drink:82/42x1",
  "box-solo-hawawshi": "C:hawawshix1:|F:fries:79x1|C:sidex1:|F:drink:82/42x1",
  "box-solo-meal": "C:mealx1:|C:sidex1:|F:drink:82/42x1",
  "box-crepe-duo": "C:crepe1x1:|C:crepe2x1:|F:cheesefries:78x1|C:sidex1:|F:drinks:82/42x2",
  "box-mixgrill-duo": "C:meal1x1:|C:meal2x1:|F:fries:79x1|F:coleslaw:72x1|F:drinks:82/42x2",
  "box-pizza-pasta": "C:pizzax1:وسط|C:pastax1:|C:extrax1:|F:coleslaw:72x1|F:drinks:82/42x2",
  "box-meals-duo": "C:meal1x1:|C:meal2x1:|F:fries:79x1|F:coleslaw:72x1|F:doritos:119x1|F:drinks:82/42x2",
  "box-burger-duo": "C:burger1x1:|C:burger2x1:|F:fries:79x2|F:onion:75x1|F:cheesefries:78x1|F:drinks:82/42x2",
  "box-late-night": "C:skilletx1:|C:crepex1:|F:chili:76x1|F:onion:75x1|F:drinks:82/42x2",
  "box-taste-all": "C:pizzax1:وسط|C:pastax1:|C:crepex1:|C:hawawshix1:|F:fries:79x1|F:coleslaw:72x1|F:drinks:82/42x2",
  "box-grill-half-half": "C:grill1x1:نصف كيلو|C:grill2x1:نصف كيلو|F:rice:123x2|F:fries:79x1|F:coleslaw:72x1",
  "box-family": "C:grill1x1:نصف كيلو|C:grill2x1:نصف كيلو|C:pizzax1:وسط|C:pastax1:|F:rice:123x3|F:fries:79x1|F:coleslaw:72x1|F:drinks:82/42x4",
  "box-pizza-night": "C:pizza1x1:وسط|C:pizza2x1:وسط|F:mozz:74x1|F:fries:79x1|F:coleslaw:72x1|F:drinks:82/42x2",
  "box-mashakel": "F:mashakel:103/57x1|C:grillx1:نصف كيلو|F:rice:123x2|F:fries:79x1|F:coleslaw:72x1",
  "box-ribs-grill": "F:ribs:100/53x1|C:grill1x1:نصف كيلو|C:grill2x1:نصف كيلو|F:rice:123x2|F:fries:79x1|F:coleslaw:72x1|F:drinks:82/42x4",
};
export function boxPhrase(b, fav, sg, pid) {
  const fn = BOX_COPY[b.slug];
  if (fn && BOX_SIG[b.slug] === b.sig) return fn(fav || null, sg || null, pid != null ? nz(pid) : null);
  return fav ? `${b.name} (فيه ${fav})` : b.name;
}

export const FAV_TITLES = Object.freeze({ item: "طبقك المفضل", boxFav: "بوكس فيه طبقك المفضل", boxTaste: "بوكس يناسب ذوقك", pack: "باقة لجمعتكم" });

/* العرض المخزّن (vars.fav) ⇒ السعر والنص من البيانات الحيّة الحين. نفس الدالة وقت التجهيز ووقت الإرسال ووقت الضغطة. */
export function renderPick(spec, live) {
  if (!spec || !live) return { ok: false, why: "no_spec" };
  if (spec.kind === "item") {
    const it = inMenu(live, spec.pid);
    if (!it) return { ok: false, why: "item_gone" };
    if (it.soldOut) return { ok: false, why: "sold_out" };
    let price = Number(it.price), phrase = dishName(it);
    if (spec.vid != null) {
      const w = (Array.isArray(it.weights) ? it.weights : []).find((x) => nz(x.variant_option_id) === nz(spec.vid));
      if (!w) return { ok: false, why: "weight_gone" };
      price = Number(w.price);
      phrase = `${dishName(it)} ${showW(normW(w.label_ar) || nz(w.label_ar))}`;
    } else if (it.byWeight) return { ok: false, why: "weight_unknown" };
    if (!(price > 0)) return { ok: false, why: "no_price" };
    return { ok: true, kind: "item", title: FAV_TITLES.item, main: `${phrase} بـ${money(price)} ر.س`, price, phrase };
  }
  const b = live.boxes.get(nz(spec.slug));
  if (!b) return { ok: false, why: "box_gone" };
  if (!boxLive(b, live)) return { ok: false, why: b.tier === "group" ? "offer_ended" : "box_sold_out" };
  let m = null, fav = null, sg = spec.sg || null;
  if (spec.pid != null && !spec.catOnly && !spec.direct) {
    const it = inMenu(live, spec.pid);
    if (!it) return { ok: false, why: "item_gone" };
    if (it.soldOut) return { ok: false, why: "sold_out" };
    m = inBox(b, spec.pid);
    if (!m) return { ok: false, why: "not_in_box" };
    fav = dishName(it); sg = subgroupOf(it);
  }
  const price = b.price + (m ? m.sur : 0);
  const from = !m && !spec.direct && hasSur(b);
  const phrase = boxPhrase(b, fav, sg, spec.pid);
  const title = b.tier === "group" ? FAV_TITLES.pack : (m || spec.direct) ? FAV_TITLES.boxFav : FAV_TITLES.boxTaste;
  return { ok: true, kind: b.tier === "group" ? "pack" : "box", title, main: from ? `${phrase} بسعر يبدأ من ${money(price)} ر.س` : `${phrase} بـ${money(price)} ر.س`, price, phrase, from };
}

/* ── التوصيل ────────────────────────────────────────────────────────────────
   q = رد delivery.quote({…, farZoneAccepted:true, cacheOnly:true}). مفيش وعد صفحة الدفع مش هتنفّذه:
   • مسافة مؤكدة (كاش جوجل، distanceSource "google"): الرسم بالرقم. FIRST والمكافأة بيلغوا الرسم الأساسي بس — رسم المسافة الإضافية /
     «التوصيل بالحي» بيفضل (keep — نفس shop.js + couponmin.feeAfterCoupon). لو الرقم اللي بنقوله محسوب بالكود، اسم الكود بيتقال معاه
     (FIRST مابيتطبّقش لوحده في كل زيارة للموقع، ولازم العميل يعرف إن السعر ده بالكود).
   • مسافة تقديرية (مش في الكاش): التقدير بيقول بره النطاق ⇒ الاستلام بس؛ المنطقة البعيدة ⇒ من غير رقم ومن غير «مجاني».
   • مفيش عنوان مؤكد (أو تقدير جوّه النطاق الأساسي): «مجاني بكود FIRST» دايماً بشرط «داخل نطاق التوصيل» — نفس صياغة سطر «أول طلب»
     في البوت (first_line)، لأن المنطقة البعيدة عليها رسم مسافة وبعد ١٥ كم مفيش توصيل.
   alt = صياغة أقصر صادقة لو السطر كله عدّى ٢٠٠ حرف (renderSpec). */
const PICKUP_ONLY = "وتقدر تستلمه من فرعنا";
const DELIVER_OR_PICKUP = "ونوصله لك أو تستلمه من فرعنا";
export function deliveryLine({ price, located = false, q = null, firstElig = false, firstMin = 60, reward = null, webOrders = 0, ladder = null }) {
  const R = FAV_RULES, p = Number(price) || 0, again = webOrders > 0;
  if (located && q && q.distanceSource === "google") {
    if (!q.deliverable) return { text: PICKUP_ONLY, status: "out_of_range" };
    /* الجزء اللي أي كوبون مابيلمسهوش — نفس keep بتاع صفحة الدفع (shop.js): رسم «التوصيل بالحي» أو رسم المسافة الإضافية */
    const keep = q.districtDelivery ? Number(q.districtDelivery.fee) || 0 : q.farZone ? Number(q.farZone.surcharge) || 0 : 0;
    const far = keep > 0;
    let fee = Math.max(0, Math.round(Number(q.fee) || 0)), via = null;
    if (firstElig && p >= firstMin && fee > keep) { fee = keep; via = "FIRST"; }
    else if (reward && fee > keep && p >= (Number(reward.minTotal) || 0)) { fee = keep; via = "reward"; }
    if (via === "FIRST") {
      const text = fee === 0 ? (again ? "وأول توصيل من الموقع مجاني لعنوانك بكود FIRST" : "والتوصيل لعنوانك مجاني بكود FIRST لأول طلب من الموقع")
        : again ? `وأول توصيل من الموقع لعنوانك بـ${money(fee)} ر.س بكود FIRST` : `والتوصيل لعنوانك ${money(fee)} ر.س بكود FIRST لأول طلب من الموقع`;
      return { text, status: "fee", fee, via, far };
    }
    if (via === "reward") return { text: fee === 0 ? `والتوصيل لعنوانك مجاني بكود مكافأتك ${reward.code}` : `والتوصيل لعنوانك ${money(fee)} ر.س بكود مكافأتك ${reward.code}`, status: "fee", fee, via, far };
    if (fee === 0) return { text: "والتوصيل لعنوانك مجاني", status: "fee", fee: 0, via: null, far };
    let text = `والتوصيل لعنوانك ${money(fee)} ر.س`;
    const free = (Array.isArray(ladder) ? ladder : []).map((t) => ({ over: Number(t.over), fee: Number(t.fee) })).filter((t) => t.fee === 0 && Number.isFinite(t.over)).sort((a, b) => a.over - b.over)[0] || null;
    if (keep === 0 && free && p < free.over && free.over - p <= R.nudgeFree) text += `، ومجاني لو طلبك من ${money(free.over)} ر.س`;
    else if (keep === 0 && firstElig && p < firstMin && firstMin - p <= R.nudgeFirst) text += `، ومجاني بكود FIRST لو طلبك من ${money(firstMin)} ر.س`;
    return { text, status: "fee", fee, via: null, far };
  }
  /* عنوان معروف بس المسافة تقدير هوائي (مش في كاش جوجل) */
  if (located && q && q.deliverable === false) return { text: PICKUP_ONLY, status: "out_of_range", est: true };
  if (located && q && (q.farZone || q.districtDelivery)) return { text: DELIVER_OR_PICKUP, status: "no_location", via: null, far: true, est: true };
  const est = located && q ? { est: true } : {};
  if (firstElig && p >= firstMin) return { text: again ? "وأول توصيل من الموقع مجاني بكود FIRST داخل نطاق التوصيل" : "وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل",
    status: "no_location", via: "FIRST", ...est, alt: { text: DELIVER_OR_PICKUP, via: null } };
  if (firstElig && firstMin - p <= R.nudgeFirst) return { text: `${DELIVER_OR_PICKUP}، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من ${money(firstMin)} ر.س`,
    status: "no_location", via: "FIRST_hint", ...est, alt: { text: DELIVER_OR_PICKUP, via: null } };
  return { text: DELIVER_OR_PICKUP, status: "no_location", via: null, ...est };
}
export const pickReward = (rewards, price) => (Array.isArray(rewards) ? rewards : []).find((r) => r && r.freeDelivery && !(Number(r.percent) > 0) && (Number(price) || 0) >= (Number(r.minTotal) || 0)) || null;

/* {{1}} و{{2}}: سطر واحد، من غير «:» جوّه {{2}} (القالب «{{1}}: {{2}}.»)، ومن غير نقطة في الآخر، و{{2}} ≤ ٢٠٠ حرف */
export function lineProblem(title, line) {
  const t = nz(title), l = nz(line);
  if (!t.trim() || /[\n\t]/.test(t) || [...t].length > 40) return "bad_title";
  if (!l.trim() || /[\n\t]/.test(l) || /\s{4,}/.test(l)) return "bad_line";
  if ([...l].length > 200) return "line_too_long";
  if (/[:：]/.test(l)) return "line_colon";
  if (/[.。]\s*$/.test(l)) return "line_period";
  return null;
}

/* قالب الحملة: «الرد أولاً» بخانتين (العنوان + التفاصيل) ومن غير زر رابط — fc_frame_ask_text / fc_frame_ask_video */
export function favTemplateOk(name) {
  const t = findTemplate(nz(name), "ar");
  if (!t || t.category !== "MARKETING" || !t.meta || t.meta.replyFirst !== true) return false;
  const paths = (t.meta.vars || []).map((v) => v.path);
  return paths.length === 2 && paths[0] === "offer.title" && paths[1] === "offer.line" && !(t.meta.buttonVars || []).length;
}
/* حملة بالشريحة دي: Cloud + قالب «الرد أولاً» + من غير كوبون (السعر والتوصيل محسوبين لكل عميل) ⇒ null أو [كود، رسالة] */
export function favJobProblem({ channel, cloudTemplate, offer = null, coupon = null }) {
  if (channel !== "wa_cloud") return ["fav_cloud_only", "حملة «طبقك المفضل» على قناة Cloud بس (قالب «الرد أولاً»)"];
  if (!favTemplateOk(cloudTemplate)) return ["fav_template", "حملة «طبقك المفضل» محتاجة قالب «الرد أولاً» بخانتين (العنوان + التفاصيل): fc_frame_ask_text"];
  if ((offer && offer.oneTime) || coupon) return ["fav_no_coupon", "الحملة دي من غير كوبون: السعر والتوصيل محسوبين لكل عميل"];
  return null;
}

/* ── السلة الجاهزة لضغطة «أبغى أطلب» ────────────────────────────────────────
   الصنف: سطر واحد (بوزنه). البوكس: طبقه في خانته + أول اختيار متاح من غير زيادة في باقي الخانات (عشان سعر السلة = السعر اللي اتقال).
   بوكس «من نفس النوع» من غير طبقه ⇒ null (الرد بيفتح البوكس نفسه يختار هو). */
const pickName = (c) => `${dishName({ name: c.name })}${c.vname ? ` ${showW(normW(c.vname) || c.vname)}` : ""}`;
export function cartInput(spec, live) {
  if (!spec) return null;
  if (spec.kind === "item") return { input: { option: "delivery", items: [{ id: nz(spec.pid), qty: 1, ...(spec.vid != null ? { variant_option_id: spec.vid } : {}) }] }, picks: [] };
  if (spec.catOnly) return null;
  const b = live.boxes.get(nz(spec.slug));
  if (!b) return null;
  const favPid = !spec.direct && spec.pid != null ? nz(spec.pid) : null;
  const choices = {}, picks = [];
  for (const s of b.slots) {
    if (s.type !== "choice") continue;
    let c = favPid && s.key === spec.slot ? s.choices.find((x) => x.pid === favPid && (spec.favV == null || nz(x.v) === nz(spec.favV))) || null : null;
    if (!c) {
      const ok = s.choices.filter((x) => !(x.sur > 0) && choiceOk(live, x));
      const shown = ok.filter((x) => inMenu(live, x.pid));
      c = shown.find((x) => x.pid !== favPid) || shown[0] || ok.find((x) => x.pid !== favPid) || ok[0] || null;
    }
    if (!c) return null;
    choices[s.key] = { product_id: c.pid, variant_option_id: c.v ?? null };
    picks.push(pickName(c));
  }
  return { input: { option: "delivery", boxes: [{ slug: b.slug, qty: 1, choices }] }, picks };
}

/* ── اختيار عرض عميل واحد (وقت التجهيز) ───────────────────────────────────── */
export function pickFor({ H, live, firstElig = false, firstMin = 60, spend = 0, orders = 0, now = Date.now() }) {
  const { list, weights } = rankDishes(H, now);
  let it = null, clean = null, boxDirect = null;
  for (const [c] of list) {
    const m = live.byClean.get(c);
    if (m && liveItem(m)) { it = m; clean = c; break; }
    const bx = live.boxByClean.get(c);
    if (bx && bx.tier !== "group" && boxLive(bx, live)) { boxDirect = bx; clean = c; break; }
  }
  if (!it && !boxDirect) return { ok: false, why: list.length ? "no_live_dish" : "no_dish" };
  const sg = it ? subgroupOf(it) : null;
  const bk = basketOf(H, { spend, orders });
  const wv = it && sg === "grill_kilo" ? usualWeight(clean, weights, it) : null;
  const dishPrice = wv ? wv.price : it ? Number(it.price) : null;
  const pick = boxDirect ? { b: boxDirect, m: null, catOnly: false, direct: true }
    : chooseOffer({ it, sg, basketM: bk.basketM, maxT: bk.maxT, bigGroup: bk.bigGroup, firstElig, firstMin, dishPrice, live });
  const base = { v: 1, sg, fav: it ? it.name : boxDirect.name };
  const spec = pick
    ? { ...base, kind: pick.b.tier === "group" ? "pack" : "box", slug: pick.b.slug, pid: it ? nz(it.id) : null, slot: pick.m ? pick.m.slot : null, favV: pick.m ? pick.m.v ?? null : null,
      catOnly: Boolean(pick.catOnly), direct: Boolean(pick.direct) }
    : { ...base, kind: "item", pid: nz(it.id), vid: wv ? wv.vid : null, wl: wv ? wv.label : null };
  return { ok: true, spec, basket: bk, weightGuessed: Boolean(wv && wv.guessed) };
}

/* الترتيب: الفلوس × عدد الطلبات × الحداثة (كامل لحد ٣٠ يوم، وبينزل لـ٠٫٤٥ عند ٩٠) */
export function favScore({ spend = 0, orders = 0, daysAgo = 0 }) {
  const R = FAV_RULES;
  const recency = daysAgo <= R.recencyFull ? 1 : Math.max(R.recencyFloor, 1 - (daysAgo - R.recencyFull) / R.recencySpan);
  return Math.round((Math.min(Number(spend) || 0, R.spendCap) + R.perOrder * Math.min(Number(orders) || 0, R.ordersCap)) * recency);
}

/* ═══ التشغيل (قاعدة + مصادر حيّة) ═════════════════════════════════════════
   deps = { pool, getSettingsData, live: () => ({ menu(), bundles(), offers() }) (بوت واتساب — نفس الكاش), quote: (x) => delivery.quote(x), now } */
const NOT_VOID = "(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))";
const PAID = shopPaidSql("so");
const NUM_RE = "'^-?[0-9]+([.][0-9]+)?$'";
export const FAV_SQL = Object.freeze({
  candidates: `SELECT DISTINCT pn FROM (
      SELECT COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) pn
        FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
       WHERE o.order_date > NOW() - make_interval(days => $1::int) AND ${NOT_VOID}
      UNION SELECT so.phone_norm FROM shop_orders so WHERE so.created_at > NOW() - make_interval(days => $1::int) AND ${PAID}
    ) x WHERE pn ~ '^5[0-9]{8}$'`,
  today: `SELECT DISTINCT pn FROM (
      SELECT COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) pn FROM ts_orders o
        LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
       WHERE o.order_date > NOW() - interval '2 days' AND ${bizDaySql("o.order_date")} = ${bizDaySql("NOW()")}
      UNION SELECT so.phone_norm FROM shop_orders so WHERE so.created_at > NOW() - interval '2 days' AND ${bizDaySql("so.created_at")} = ${bizDaySql("NOW()")} AND so.status NOT IN ('expired')
    ) z WHERE pn = ANY($1::text[])`,
  testOrOwner: "SELECT DISTINCT phone_norm pn FROM shop_orders WHERE phone_norm = ANY($1::text[]) AND (is_test IS TRUE OR upper(COALESCE(coupon,'')) = ANY($2::text[]))",
  ownerDiscount: "SELECT phone_norm pn FROM acct_customers WHERE phone_norm = ANY($1::text[]) AND discount_percent > 0",
  contactsStaffTest: "SELECT phone_norm pn FROM cms_contacts WHERE phone_norm = ANY($1::text[]) AND (is_staff IS TRUE OR is_test IS TRUE)",
  optedOut: "SELECT phone_norm pn FROM cms_contacts WHERE phone_norm = ANY($1::text[]) AND opted_out_at IS NOT NULL",
  waStopped: "SELECT phone_norm pn FROM wa_optins WHERE phone_norm = ANY($1::text[]) AND (stopped_at IS NOT NULL OR marketing_off_at IS NOT NULL)",
  /* آخر طلبات كل رقم: الموقع (بالحجم/الوزن من variant_name والكمية) + نقطة البيع (من غير مرايا طلبات الموقع: order_sources.source='website') */
  history: `SELECT pn, at, total, names FROM (
      SELECT so.phone_norm pn, so.created_at at, so.total,
        (SELECT string_agg(COALESCE(i->>'name','') || CASE WHEN COALESCE(i->>'variant_name', i->>'variant', '') <> '' THEN ' - ' || COALESCE(i->>'variant_name', i->>'variant') ELSE '' END
                           || CASE WHEN COALESCE(i->>'quantity','1') ~ '^[0-9]+$' THEN CASE WHEN (i->>'quantity')::int > 1 THEN ' ×' || (i->>'quantity') ELSE '' END ELSE '' END, '|')
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END) i WHERE jsonb_typeof(i) = 'object') names,
        row_number() OVER (PARTITION BY so.phone_norm ORDER BY so.created_at DESC) rn
        FROM shop_orders so WHERE so.phone_norm = ANY($1::text[]) AND ${PAID}
    ) w WHERE rn <= $2::int
    UNION ALL
    SELECT pn, at, total, names FROM (
      SELECT pn, at, total, (SELECT string_agg(i.name || CASE WHEN i.qty > 1 THEN ' ×' || trim(to_char(i.qty, 'FM999')) ELSE '' END, '|' ORDER BY i.idx) FROM ts_order_items i WHERE i.order_id = oid) names,
             row_number() OVER (PARTITION BY pn ORDER BY at DESC) rn FROM (
        SELECT COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) pn, o.order_date at, o.total, o.order_id oid
          FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         WHERE (s.phone_norm = ANY($1::text[]) OR tc.phone_norm = ANY($1::text[])) AND ${NOT_VOID} AND COALESCE(s.source,'') <> 'website'
      ) z0 WHERE pn IS NOT NULL
    ) z WHERE rn <= $2::int
    ORDER BY pn, at DESC`,
  names: `SELECT pn, (array_agg(name ORDER BY len DESC))[1] AS name FROM (
      SELECT phone_norm pn, btrim(name) name, length(btrim(name)) len FROM ts_customers WHERE phone_norm = ANY($1::text[]) AND COALESCE(btrim(name),'') <> ''
      UNION ALL SELECT phone_norm, btrim(customer_name), length(btrim(customer_name)) FROM order_sources WHERE phone_norm = ANY($1::text[]) AND COALESCE(btrim(customer_name),'') <> ''
      UNION ALL SELECT phone_norm, btrim(customer->>'name'), length(btrim(customer->>'name')) FROM shop_orders WHERE phone_norm = ANY($1::text[]) AND COALESCE(btrim(customer->>'name'),'') <> ''
      UNION ALL SELECT phone_norm, btrim(name), length(btrim(name)) FROM acct_customers WHERE phone_norm = ANY($1::text[]) AND COALESCE(btrim(name),'') <> ''
    ) x GROUP BY pn`,
  web: `SELECT so.phone_norm pn, count(*)::int n, count(*) FILTER (WHERE so.option='delivery')::int deliv
          FROM shop_orders so WHERE so.phone_norm = ANY($1::text[]) AND ${PAID} GROUP BY 1`,
  /* FIRST اتستخدم على توصيل (نفس couponrules.usedOnceSql للكوبون الصِرف) */
  firstUsed: "SELECT DISTINCT phone_norm pn FROM shop_orders WHERE phone_norm = ANY($1::text[]) AND upper(COALESCE(coupon,''))='FIRST' AND option='delivery' AND status NOT IN ('pending_payment','expired')",
  lastDelivery: `SELECT DISTINCT ON (so.phone_norm) so.phone_norm pn,
          CASE WHEN so.address->>'latitude' ~ ${NUM_RE} THEN (so.address->>'latitude')::float END lat,
          CASE WHEN so.address->>'longitude' ~ ${NUM_RE} THEN (so.address->>'longitude')::float END lng
     FROM shop_orders so WHERE so.phone_norm = ANY($1::text[]) AND so.option='delivery' AND ${PAID} AND so.address ? 'latitude'
    ORDER BY so.phone_norm, so.created_at DESC`,
  accounts: "SELECT phone_norm pn, addresses FROM acct_customers WHERE phone_norm = ANY($1::text[]) AND (CASE WHEN jsonb_typeof(addresses) = 'array' THEN jsonb_array_length(addresses) ELSE 0 END) > 0",
  /* مكافآت الولاء اللي لسه صالحة (نفس waassist.rewardsOf) */
  rewards: `SELECT l.phone_norm pn, s.code, s.percent, s.free_delivery, s.min_total FROM cms_loyalty l JOIN shop_coupons s ON s.code = l.coupon
     WHERE l.phone_norm = ANY($1::text[]) AND s.active AND s.used_count < COALESCE(s.max_uses,1) AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND (s.phone_norm IS NULL OR s.phone_norm = l.phone_norm)
       AND NOT EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm = l.phone_norm AND o.coupon = s.code AND o.status NOT IN ('pending_payment','expired'))
     ORDER BY l.created_at DESC`,
  first: "SELECT code, active, min_total, free_delivery, percent, expires_at FROM shop_coupons WHERE upper(code)='FIRST' AND phone_norm IS NULL ORDER BY active DESC LIMIT 1",
  policy: "SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1",
  /* طلب جديد (موقع أو نقطة بيع) بعد ما العرض اتجهّز ⇒ الرسالة مالهاش لازمة */
  orderedSince: `SELECT 1 FROM shop_orders so WHERE so.phone_norm = $1 AND so.created_at > $2::timestamptz AND so.status NOT IN ('expired','pending_payment')
    UNION ALL SELECT 1 FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
     WHERE (s.phone_norm = $1 OR tc.phone_norm = $1) AND o.order_date > $2::timestamptz AND ${NOT_VOID} LIMIT 1`,
  /* آخر رسالة حملة اتبعتت للرقم (أي حملة) — الضغطة على «أبغى أطلب» بتتقرا على آخر رسالة بس */
  lastSent: `SELECT q.id, q.job_id, q.sent_at, q.wamid, q.vars, j.cloud_template, j.cloud_vars FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id
     WHERE q.phone_norm = $1 AND q.status = 'sent' AND q.sent_at > NOW() - make_interval(hours => $2::int) ORDER BY q.sent_at DESC LIMIT 1`,
  newerTemplate: `SELECT 1 FROM wa_messages WHERE phone_norm = $1 AND direction = 'out' AND template IS NOT NULL AND category = 'MARKETING' AND template <> $2
       AND created_at > $3::timestamptz + interval '1 minute' AND COALESCE(status,'') NOT IN ('failed','skipped') LIMIT 1`,
  /* «نعم» المكتوبة = «أبغى أطلب» بس لو هي أول كلام بعد رسالة الحملة: مفيش رسالة تانية من العميل (أي رسالة اتسجّلت عند البوت، حتى اللي سكت عليها)… */
  inboundSince: "SELECT 1 FROM wa_bot_log WHERE phone_norm = $1 AND id <> $2 AND at > $3::timestamptz LIMIT 1",
  /* …ومفيش أي حاجة طلعت له بعدها (رد بوت، موظف من الموبايل، تحديث طلب، قالب) غير رسالة الحملة نفسها */
  outboundSince: `SELECT 1 FROM wa_messages WHERE phone_norm = $1 AND direction = 'out' AND created_at > $2::timestamptz
       AND COALESCE(wamid,'') <> COALESCE($3::text,'') AND COALESCE(status,'') NOT IN ('failed','skipped') LIMIT 1`,
});
const FAKE_RE = /^5(\d)\1{7}$|^5?12345678|^500000000$|^555555555$/;
const todayStart = (now) => new Date(new Date(now).toDateString());

export function makeFavPick(deps = {}) {
  const { pool } = deps;
  const getSettings = async () => { try { return (deps.getSettingsData ? await deps.getSettingsData() : {}) || {}; } catch { return {}; } };
  const now = () => (deps.now ? Number(deps.now()) : Date.now());
  const sets = async (sql, params) => {
    try { return new Set(((await pool.query(sql, params)).rows || []).map((r) => r.pn)); }
    catch (e) { if (e && e.code === "42P01") return new Set(); throw e; }      // جدول مش موجود (قاعدة جديدة) = مفيش استبعاد منه؛ أي غلطة تانية = مفيش شريحة
  };

  /* المنيو والبوكسات والعروض الحيّة + FIRST + سلّم الرسوم.
     strict (كل الاستعمالات): كاش البوت لازم يكون اتحدّث في مدته العادية (menuCacheMin / boxesCacheMin) — لو التحديث فشل والبوت شغّال على
     كاش قديم (لحد staleCacheMin)، مفيش أرقام: المعاينة بترفض والإرسال بيتخطّى (offer_unverified). والباقات الموقوفة من البوابة من الإعدادات نفسها. */
  async function globals() {
    const L = typeof deps.live === "function" ? deps.live() : deps.live;
    if (!L || typeof L.menu !== "function" || typeof L.bundles !== "function") return { ok: false, why: "live_unavailable" };
    const o = { strict: true };
    let menu = null, bundles = null, offers = null;
    try { [menu, bundles, offers] = await Promise.all([L.menu(o), L.bundles(o), typeof L.offers === "function" ? L.offers(o) : null]); }
    catch { return { ok: false, why: "live_unavailable" }; }
    if (!menu || !Array.isArray(menu.items) || !menu.items.length) return { ok: false, why: "menu_unavailable" };
    if (!Array.isArray(bundles) || !bundles.length) return { ok: false, why: "boxes_unavailable" };
    const s = await getSettings();
    const first = ((await pool.query(FAV_SQL.first)).rows || [])[0] || null;
    const firstLive = Boolean(first && first.active && first.free_delivery && !(Number(first.percent) > 0) && !(first.expires_at && new Date(first.expires_at) < todayStart(now())));
    const pol = ((await pool.query(FAV_SQL.policy)).rows || [])[0] || null;
    return { ok: true, live: buildLive({ menu, bundles, offers, paused: pausedOffersOf(s, now()) }), firstLive, firstMin: first ? Number(first.min_total) || 0 : 0,
      ladder: pol && pol.config && Array.isArray(pol.config.feeByTotal) ? pol.config.feeByTotal : null, settings: s };
  }

  /* لكل رقم: طلبات الموقع، FIRST، الموقع، مكافآت الولاء */
  async function contextFor(pns, g) {
    const out = new Map(pns.map((pn) => [pn, { webOrders: 0, webDeliv: 0, firstUsed: false, loc: null, rewards: [] }]));
    if (!pns.length) return out;
    for (const r of (await pool.query(FAV_SQL.web, [pns])).rows || []) { const x = out.get(r.pn); if (x) { x.webOrders = Number(r.n) || 0; x.webDeliv = Number(r.deliv) || 0; } }
    for (const pn of await sets(FAV_SQL.firstUsed, [pns])) { const x = out.get(pn); if (x) x.firstUsed = true; }
    for (const r of (await pool.query(FAV_SQL.lastDelivery, [pns])).rows || []) {
      const x = out.get(r.pn);
      if (x && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) && r.lat != null && r.lng != null) x.loc = { lat: Number(r.lat), lng: Number(r.lng), src: "last_delivery" };
    }
    for (const r of (await pool.query(FAV_SQL.accounts, [pns])).rows || []) {
      const x = out.get(r.pn);
      if (!x || x.loc || !Array.isArray(r.addresses)) continue;
      const ok = r.addresses.filter((a) => a && Number.isFinite(Number(a.latitude)) && Number.isFinite(Number(a.longitude)) && a.latitude !== "" && a.longitude !== "" && a.latitude != null && a.longitude != null);
      ok.sort((a, b) => (Date.parse(b.used_at || b.created_at || 0) || 0) - (Date.parse(a.used_at || a.created_at || 0) || 0) || (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
      if (ok[0]) x.loc = { lat: Number(ok[0].latitude), lng: Number(ok[0].longitude), src: "account" };
    }
    try {
      for (const r of (await pool.query(FAV_SQL.rewards, [pns])).rows || []) {
        const x = out.get(r.pn);
        if (x) x.rewards.push({ code: r.code, freeDelivery: r.free_delivery === true, percent: Number(r.percent) || 0, minTotal: Number(r.min_total) || 0 });
      }
    } catch (e) { if (!(e && e.code === "42P01")) throw e; }
    for (const x of out.values()) x.firstElig = Boolean(g && g.firstLive) && x.webDeliv === 0 && !x.firstUsed;
    return out;
  }

  /* العرض المخزّن ⇒ {{1}} و{{2}} بالبيانات الحيّة الحين (السعر + سطر التوصيل) */
  async function renderSpec(spec, g, ctx) {
    const r = renderPick(spec, g.live);
    if (!r.ok) return r;
    let q = null;
    if (ctx && ctx.loc && typeof deps.quote === "function") {
      try { q = await deps.quote({ lat: ctx.loc.lat, lng: ctx.loc.lng, orderTotal: r.price, farZoneAccepted: true, cacheOnly: true }); } catch { q = null; }
    }
    let dl = deliveryLine({ price: r.price, located: Boolean(ctx && ctx.loc), q, firstElig: Boolean(ctx && ctx.firstElig), firstMin: g.firstMin,
      reward: pickReward(ctx && ctx.rewards, r.price), webOrders: (ctx && ctx.webOrders) || 0, ladder: g.ladder });
    let line = `${r.main}، ${dl.text}`;
    /* السطر طويل (بوكس اسمه طويل + سطر FIRST بشرطه) ⇒ الصياغة الأقصر الصادقة (من غير FIRST) بدل ما العميل يقع من الشريحة */
    if (lineProblem(r.title, line) === "line_too_long" && dl.alt) { dl = { ...dl, text: dl.alt.text, via: dl.alt.via, short: true }; line = `${r.main}، ${dl.text}`; }
    const bad = lineProblem(r.title, line);
    if (bad) return { ok: false, why: bad };
    return { ok: true, kind: r.kind, title: r.title, line, price: r.price, dl, km: q && q.distanceSource === "google" ? Number(q.routeKm) || null : null };
  }

  /* ── الشريحة ───────────────────────────────────────────────────────────── */
  /* win = فاصل «آخر طلب» بتاع الحملة (wasender بيبعته: minDaysSince / maxDaysSince) — اللي برّاه بيتشال قبل التاريخ والتسعير
     (نفس شرط applyFilters بالظبط، فالنتيجة واحدة؛ الفرق إن مفيش quote لعميل مش هيتبعتله). */
  async function audienceRows(win = {}) {
    const T = now();
    const g = await globals();
    if (!g.ok) throw Object.assign(new Error(`fav_pick: ${g.why}`), { code: "FAV_CATALOG" });
    const s = g.settings || {};
    const wn = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const minD = wn(win && win.minDaysSince), maxD = wn(win && win.maxDaysSince);
    const stats = { phones: 0, inPool: 0, excluded: {}, noHistory: 0, noOffer: {}, kinds: { box: 0, boxCategory: 0, pack: 0, item: 0 }, located: 0, feeStated: 0, firstEligible: 0, weightGuessed: 0 };
    const pns0 = ((await pool.query(FAV_SQL.candidates, [FAV_RULES.poolDays + 5])).rows || []).map((r) => r.pn);
    stats.phones = pns0.length;
    if (!pns0.length) return Object.assign([], { stats });
    const st = new Map(((await pool.query(QUICK_STATS_SQL, [pns0])).rows || []).map((r) => [r.pn, r]));
    const today = await sets(FAV_SQL.today, [pns0]);
    const ex = (k) => { stats.excluded[k] = (stats.excluded[k] || 0) + 1; };
    const base = [];
    for (const pn of pns0) {
      const x = st.get(pn);
      if (!x || !(Number(x.orders) > 0)) { ex("no_paid_order"); continue; }
      if (FAKE_RE.test(pn)) { ex("bad_number"); continue; }
      if (today.has(pn)) { ex("ordered_today"); continue; }
      const daysAgo = Math.floor((T - atMs(x.last_at)) / DAY);
      if (!Number.isFinite(daysAgo) || daysAgo > FAV_RULES.poolDays) { ex("too_old"); continue; }
      if ((minD != null && daysAgo < minD) || (maxD != null && daysAgo > maxD)) { ex("outside_window"); continue; }
      base.push({ pn, orders: Number(x.orders) || 0, spend: Number(x.spend) || 0, lastAt: x.last_at, daysAgo });
    }
    /* الاستبعادات اللي wasender.build مابيعملهاش (الباقي هناك + وقت الإرسال) */
    const B = base.map((b) => b.pn);
    const staff = new Set([...staffPhoneSet(s), ...staffFromSettings(s)]);
    try { for (const m of teamConfig(s).members || []) { const n = nz(m && m.phone).replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""); if (n) staff.add(n); } } catch { /* دليل الفريق مش مقروء ⇒ الأرقام التانية كفاية */ }
    for (const t of ((s.waBot || {}).testPhones || [])) { const n = nz(t && typeof t === "object" ? t.phone : t).replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""); if (n) staff.add(n); }
    const excl = [
      ["staff", staff],
      ["test_or_owner", await sets(FAV_SQL.testOrOwner, [B, OWNER_COUPONS])],
      ["owner_discount", await sets(FAV_SQL.ownerDiscount, [B])],
      ["staff_or_test_contact", await sets(FAV_SQL.contactsStaffTest, [B])],
      ["opted_out", await sets(FAV_SQL.optedOut, [B])],
      ["wa_stopped", await sets(FAV_SQL.waStopped, [B])],
      ["app_only", await sets(appOnlyPhonesSql("$1"), [B])],
    ];
    const pool2 = base.filter((b) => { const hit = excl.find(([, set]) => set.has(b.pn)); if (hit) { ex(hit[0]); return false; } return true; });
    stats.inPool = pool2.length;
    const P = pool2.map((b) => b.pn);
    const hist = new Map();
    if (P.length) for (const r of (await pool.query(FAV_SQL.history, [P, FAV_RULES.histPerSource])).rows || []) { if (!hist.has(r.pn)) hist.set(r.pn, []); hist.get(r.pn).push(r); }
    for (const H of hist.values()) H.sort((a, b) => atMs(b.at) - atMs(a.at));
    const names = new Map(P.length ? ((await pool.query(FAV_SQL.names, [P])).rows || []).map((r) => [r.pn, r.name]) : []);
    const ctx = await contextFor(P, g);
    const rows = [];
    for (const b of pool2) {
      const H = hist.get(b.pn) || [];
      if (!H.length) { stats.noHistory++; continue; }
      const c = ctx.get(b.pn) || { firstElig: false, webOrders: 0, loc: null, rewards: [] };
      const p = pickFor({ H, live: g.live, firstElig: c.firstElig, firstMin: g.firstMin, spend: b.spend, orders: b.orders, now: T });
      if (!p.ok) { stats.noOffer[p.why] = (stats.noOffer[p.why] || 0) + 1; continue; }
      const r = await renderSpec(p.spec, g, c);
      if (!r.ok) { stats.noOffer[r.why] = (stats.noOffer[r.why] || 0) + 1; continue; }
      if (p.weightGuessed) stats.weightGuessed++;
      if (c.firstElig) stats.firstEligible++;
      if (c.loc) stats.located++;
      if (r.dl.status === "fee") stats.feeStated++;
      stats.kinds[r.kind === "box" ? (p.spec.catOnly ? "boxCategory" : "box") : r.kind]++;
      const name = nz(names.get(b.pn)).trim();
      const first = name ? name.split(/\s+/)[0] : "";
      const spec = { ...p.spec, price: r.price, at: new Date(T).toISOString() };
      rows.push({
        name: name || null, pn: b.pn, phone: `${b.pn.slice(0, 3)}••••${b.pn.slice(-2)}`,
        orders: b.orders, spend: Math.round(b.spend), webOrders: c.webOrders, lastAt: b.lastAt || null, daysAgo: b.daysAgo,
        lastItems: null, lastTotal: H[0] && H[0].total != null ? Math.round(Number(H[0].total)) : null, skippedSmall: 0, noMeaningfulOrder: false, adBlocked: false,
        favDish: p.spec.fav, favGroup: p.spec.sg,
        vars: { name: name || "عميلنا", first_name: first || "عميلنا", fav_dish: p.spec.fav, cloud: { values: { "offer.title": r.title, "offer.line": r.line } }, fav: spec },
        favView: { kind: r.kind, catOnly: Boolean(p.spec.catOnly), ref: p.spec.slug || `${p.spec.pid}${p.spec.wl ? `:${p.spec.wl}` : ""}`, price: r.price,
          delivery: r.dl.status, via: r.dl.via || null, fee: r.dl.fee ?? null, far: Boolean(r.dl.far), loc: c.loc ? c.loc.src : null, km: r.km != null ? Math.round(r.km * 10) / 10 : null,
          ...(r.dl.est ? { est: true } : {}), ...(r.dl.short ? { short: true } : {}) },
        message: "", wa: null,
        score: favScore(b),
      });
    }
    rows.sort((a, b) => b.score - a.score || (a.pn < b.pn ? -1 : 1));
    return Object.assign(rows, { stats });
  }

  /* ── وقت الإرسال: العرض المخزّن لسه نفسه بالظبط؟ null = ابعت، غير كده سبب التخطّي ── */
  async function recheck(q) {
    const v = (q && q.vars) || {}, spec = v.fav, vals = (v.cloud && v.cloud.values) || {};
    if (!spec || !vals["offer.title"] || !vals["offer.line"]) return "offer_missing";
    if (spec.at && ((await pool.query(FAV_SQL.orderedSince, [q.phone_norm, spec.at])).rows || []).length) return "ordered_since";
    const g = await globals();
    if (!g.ok) return "offer_unverified";
    const c = (await contextFor([q.phone_norm], g)).get(q.phone_norm);
    const r = await renderSpec(spec, g, c);
    if (!r.ok) return `offer_gone:${r.why}`.slice(0, 60);
    if (r.title !== vals["offer.title"] || r.line !== vals["offer.line"]) return "offer_changed";
    return null;
  }

  /* ── الرد على رسالة الحملة: آخر رسالة حملة للرقم ده لو كانت «طبقك المفضل» (ومفيش قالب تسويقي أحدث منها) ──
     الضغطة على «أبغى أطلب» بتتقرا عليها لحد campaignOfferHours. «نعم» المكتوبة لازم كمان تعدّي yesGate. */
  async function lastOffer(phone, hours = 72) {
    if (!/^5\d{8}$/.test(nz(phone))) return null;
    const x = ((await pool.query(FAV_SQL.lastSent, [phone, Math.max(1, Math.round(Number(hours) || 72))])).rows || [])[0];
    if (!x || !(x.cloud_vars && x.cloud_vars.perRecipient === true) || !/^fc_frame_ask_/.test(nz(x.cloud_template)) || !(x.vars && x.vars.fav)) return null;
    const sentAt = x.sent_at instanceof Date ? x.sent_at.toISOString() : nz(x.sent_at);
    if (((await pool.query(FAV_SQL.newerTemplate, [phone, x.cloud_template, sentAt])).rows || []).length) return null;
    return { queueId: Number(x.id), jobId: Number(x.job_id), sentAt, wamid: x.wamid || null, fav: x.vars.fav, values: (x.vars.cloud && x.vars.cloud.values) || null };
  }
  /* «نعم» المكتوبة (مش الضغطة) = «أبغى أطلب» بس لو دي أول حاجة حصلت في المحادثة بعد رسالة الحملة:
     ولا رسالة تانية من العميل، ولا أي رسالة طلعت له (رد بوت / موظف / تحديث طلب / قالب)، ولا طلب جديد (موقع أو نقطة بيع).
     null = تمام، غير كده السبب. logId = صف الرسالة دي نفسها في wa_bot_log. */
  async function yesGate(phone, offer, { logId = null } = {}) {
    if (!offer || !offer.sentAt) return "no_offer";
    const has = async (sql, params) => ((await pool.query(sql, params)).rows || []).length > 0;
    if (await has(FAV_SQL.inboundSince, [phone, Number(logId) || 0, offer.sentAt])) return "not_first_reply";
    if (await has(FAV_SQL.outboundSince, [phone, offer.sentAt, offer.wamid || null])) return "chat_moved_on";
    if (await has(FAV_SQL.orderedSince, [phone, offer.sentAt])) return "ordered_since";
    return null;
  }
  /* الضغطة: نفس العرض اللي اتبعت بالحرف (العنوان والسطر بسعره وتوصيله) محسوب تاني الحين — اتغيّر أي حاجة (سعر، توصيل، FIRST، خلص)
     ⇒ مفيش سلة (الرد العادي)، عمرنا ما بنسعّر العميل بغير الرقم اللي في الرسالة. sent = القيم اللي اتبعتت (vars.cloud.values).
     السلة بتتجرّب هنا من غير حفظ (build_cart save:false) عشان نتأكد إن سعرها = السعر اللي اتقال؛ الحفظ في saveCart بعد ما البوت يقرر إنه هيرد فعلاً. */
  async function tapOffer(phone, spec, { assist = null, sent = null } = {}) {
    if (!sent || !sent["offer.title"] || !sent["offer.line"]) return { ok: false, why: "offer_missing" };
    const g = await globals();
    if (!g.ok) return { ok: false, why: g.why };
    const c = (await contextFor([phone], g)).get(phone);
    const r = await renderSpec(spec, g, c);
    if (!r.ok) return { ok: false, why: r.why };
    if (r.title !== sent["offer.title"] || r.line !== sent["offer.line"]) return { ok: false, why: "offer_changed" };
    const out = { ok: true, kind: r.kind, title: r.title, line: r.line, price: r.price, delivery: r.dl.status, slug: spec.slug || null };
    const ci = cartInput(spec, g.live);
    if (!ci) return spec.kind !== "item" && spec.slug ? { ...out, cart: false, boxSlug: spec.slug } : { ok: false, why: "no_cart_input" };
    if (!assist || typeof assist.build_cart !== "function") return { ok: false, why: "no_cart_builder" };
    let made = null;
    try { made = await assist.build_cart(phone, ci.input, { save: false, source: "campaign" }); } catch { made = null; }
    if (!made || !made.ok || !(made.lines || []).length) return { ok: false, why: `cart:${(made && made.error) || "failed"}` };
    /* السلة لازم تبقى بنفس السعر اللي اتقال (السعر من نفس المنيو/البوكسات — اختلاف = حاجة اتغيّرت في النص) */
    if (Math.abs((Number(made.subtotal) || 0) - r.price) > 0.01) return { ok: false, why: "cart_price_mismatch" };
    return { ...out, cart: true, cartInput: ci.input, picks: ci.picks };
  }
  /* حفظ السلة الجاهزة (صف wa_bot_carts + الرابط) — بعد ما البوت قرر إن الرد هيطلع بيها. نفس السعر تاني وإلا مفيش رابط. */
  async function saveCart(phone, t, { assist = null } = {}) {
    if (!t || !t.cartInput || !assist || typeof assist.build_cart !== "function") return { ok: false, why: "no_cart" };
    let made = null;
    try { made = await assist.build_cart(phone, t.cartInput, { save: true, source: "campaign" }); } catch { made = null; }
    if (!made || !made.ok || !made.link || !(made.lines || []).length) return { ok: false, why: `cart:${(made && (made.error || made.error_link)) || "failed"}` };
    if (Math.abs((Number(made.subtotal) || 0) - Number(t.price)) > 0.01) return { ok: false, why: "cart_price_mismatch" };
    return { ok: true, url: made.link, code: made.code || null };
  }

  return { audienceRows, recheck, lastOffer, yesGate, tapOffer, saveCart, globals, contextFor, renderSpec };
}
