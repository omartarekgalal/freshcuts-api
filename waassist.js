/* ═══════════════════════════════════════════════════════════════════════════
   مساعد الطلبات على واتساب — القلب (الشريحة ١ من ٢) — ١٢/١٠/٢٠٢٦

   الملف ده **مابيكلّمش أي موديل ومابيبعتش أي رسالة**. فيه الأربع حاجات اللي بتضمن إن المساعد مايقولش غلط:
     ١) الأدوات: كل حقيقة (صنف، سعر، بوكس، توصيل، عرض، مواعيد، حالة طلب، ملف العميل) بتتقرا من النظام وقت السؤال.
     ٢) بنّاء السلة: أصناف وبوكسات باختياراتها وحشو الأطراف والملاحظات، متسعّرة بنفس دالة الدفع (cms.expandBundle + modifiers.resolve)،
        وبتطلع رابط سلة جاهزة freshcuts.sa/c/<code> (نفس مخزن «نفس طلبي السابق»).
     ٣) حاسبة الاقتراح: اقتراح واحد بالكتير، محسوب بالكود (باقي كام على رسوم أقل، مشروب/جانبي ناقص، بوكس أرخص من الأصناف منفصلة،
        الأكثر مبيعاً فعلاً، عرض بتاريخ نهايته) — الموديل يقدر يقوله، مايقدرش يخترعه.
     ٤) المراجِع: أي رقم أو اسم صنف أو رابط في رد الموديل لازم يكون راجع من أداة في نفس الدور، وأي وعد ممنوع بيترفض.

   خصوصية: ملف العميل = صاحب الرقم اللي بيكلّمنا بس، والحقول اللي بتتبعت للموديل هي الحد الأدنى (من غير رقم جوال، من غير عنوان — الحي بس).
   الثوابت اللي هنا (ASSIST_DEFAULTS) هتبقى إعدادات في اللوحة مع الشريحة ٢.
═══════════════════════════════════════════════════════════════════════════ */
import { normalize } from "./wabot.js";
import { loyaltyCfgOf, loyaltyStatusFor, LOYALTY_COUNTED_SQL } from "./loyalty.js";
import { firstEligibility, couponQueries } from "./couponrules.js";

export const ASSIST_DEFAULTS = Object.freeze({
  searchMax: 8,              // أقصى نتايج بحث المنيو
  nudgeGapSar: 20,           // «باقي لك X وتوصل الشريحة الجاية» يتقال لو الفرق أقل من أو يساوي كده
  topSellerDays: 30,         // الأكثر مبيعاً من مبيعات آخر كام يوم
  profileOrders: 40,         // كام طلب من التاريخ بيتحسب منهم «المعتاد»
  maxCartLines: 20,
});
const STORE = "https://freshcuts.sa";
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const qtyOf = (v) => Math.min(20, Math.max(1, Math.round(Number(v) || 1)));
const words = (s) => normalize(String(s || "")).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).map((w) => w.replace(/^(ال|وال|بال|لل)(?=.{2,})/, "")).filter((w) => w.length > 1);
const DRINK_RE = /بيبسي|سفن|ميرندا|كولا|مياه|ماء|عصير|مشروب|شاي|قهوه|لبن|pepsi|7up|seven|mirinda|cola|water|juice|drink|tea/i;
const SIDE_RE = /بطاطس|كولسلو|سلطه|ارز|رز|خبز|صوص|طحينه|ثوم|حمص|fries|coleslaw|salad|rice|bread|sauce|dip/i;
const kindOf = (it) => (/Sides|Drinks|إضافات/i.test(`${it.category} ${it.categoryAr}`) ? (DRINK_RE.test(normalize(`${it.name} ${it.nameEn}`)) ? "drink" : "side") : "main");

/* ── ١) بحث المنيو (صافي) ─────────────────────────────────────────────── */
export function searchMenu(menu, query, max = ASSIST_DEFAULTS.searchMax) {
  if (!menu || !Array.isArray(menu.items)) return null;                  // المنيو مش متاح ⇒ null (مش «مفيش نتايج»)
  const qw = [...new Set(words(query))];
  if (!qw.length) return [];
  const scored = [];
  for (const it of menu.items) {
    const tw = new Set([...words(it.name), ...words(it.nameEn), ...words(it.categoryAr), ...words(it.category)]);
    const dw = new Set(words(it.desc));
    let s = 0;
    for (const w of qw) { if (tw.has(w)) s += 3; else if ([...tw].some((t) => t.startsWith(w) || w.startsWith(t))) s += 2; else if (dw.has(w)) s += 1; }
    if (s > 0) scored.push([s, it]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].price - b[1].price);
  return scored.slice(0, max).map(([, it]) => itemBrief(it));
}
export const itemBrief = (it) => ({ id: String(it.id), name: it.name, name_en: it.nameEn || it.name, price: it.price, section: it.categoryAr || it.category, kind: kindOf(it), sold_out: Boolean(it.soldOut), by_weight: Boolean(it.byWeight) });

/* ── ملف العميل للموديل: الحد الأدنى (صافي) ─────────────────────────────
   p = customer360.buildProfile(pn). extra = { loyalty, rewards, firstEligible, consent, lang }.
   مفيش رقم جوال ولا شارع ولا مبنى: الحي بس. التعليقات النصية للتقييمات مابتتبعتش — العدد والتصنيف بس. */
export function profileForModel(p, extra = {}, now = new Date(), cfg = ASSIST_DEFAULTS) {
  if (!p || !isObj(p)) return { known: false };
  const sum = p.summary || {}, orders = (Array.isArray(p.orders) ? p.orders : []).filter((o) => !o.void && !o.isTest).slice(0, cfg.profileOrders);
  const first = String((p.identity && p.identity.name) || "").trim().split(/\s+/)[0] || "";
  const name = /^[\p{L}]{2,15}$/u.test(first) ? first : null;
  const modes = {}, hours = {};
  for (const o of orders) {
    const m = o.option || (o.source === "pos" ? "in_store" : null); if (m) modes[m] = (modes[m] || 0) + 1;
    const h = new Date(new Date(o.at).getTime() + 3 * 3600_000).getUTCHours(); if (Number.isFinite(h)) hours[h] = (hours[h] || 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
  const last = orders[0] || null;
  const fav = p.favorites || {};
  const low = (Array.isArray(p.reviews) ? p.reviews : []).filter((r) => Number(r.rating) > 0 && Number(r.rating) <= 2 && !r.hidden);
  const refunds = (Array.isArray(p.unpaidAttempts) ? p.unpaidAttempts : []).filter((o) => /refund/.test(String(o.status || ""))).length + (Array.isArray(p.voidedOrders) ? p.voidedOrders.length : 0);
  return {
    known: Number(sum.orders) > 0,
    name,
    orders: Number(sum.orders) || 0,
    status: sum.status || "no_orders",                         // no_orders | one_time | repeat | lapsed
    days_since_last: Number.isFinite(Number(sum.daysSinceLast)) ? Math.round(Number(sum.daysSinceLast)) : null,
    usual_basket_sar: sum.aov ? round2(sum.aov) : null,
    usual_mode: top(modes) ? top(modes)[0] : null,
    usual_hour: top(hours) ? Number(top(hours)[0]) : null,
    favourites: (fav.items || []).slice(0, 5).map((x) => ({ name: x.name, times: x.orders })),
    taste: fav.leanLabel || fav.lean || null,
    last_order: last ? { days_ago: Math.max(0, Math.round((now.getTime() - new Date(last.at).getTime()) / 86400_000)), channel: last.channel || last.source, mode: last.option || null, total: round2(last.total), items: (last.items || []).slice(0, 8).map((i) => ({ name: i.name, qty: Number(i.qty) || 1 })) } : null,
    districts: [...new Set((Array.isArray(p.addresses) ? p.addresses : []).map((a) => String(a.area || "").trim()).filter(Boolean))].slice(0, 3),
    loyalty: extra.loyalty || null,                            // { every, progress, left, reward }
    unused_rewards: (extra.rewards || []).map((r) => ({ kind: r.freeDelivery ? "free_delivery" : "percent", percent: r.percent || 0, min_total: r.minTotal || 0, expires: r.expires || null })),
    first_order_offer: extra.firstEligible === true,
    low_ratings: low.length ? { count: low.length, about: [...new Set(low.flatMap((r) => r.categories || []))].slice(0, 5), last_days_ago: Math.round((now.getTime() - new Date(low[0].at).getTime()) / 86400_000) } : null,
    refunds_or_voids: refunds,
    language: extra.lang || "ar",
    consent: extra.consent || null,                            // { updates, marketing, stopped }
  };
}
/* «إيش تعرفوا عني؟» ⇒ ملخص صريح بنفس البيانات اللي الموديل بيشوفها */
export function profileSummaryAr(m) {
  if (!m || !m.known) return "ما عندنا طلبات سابقة مسجّلة على رقمك هذا.";
  const out = [`عدد طلباتك السابقة: ${m.orders}.`];
  if (m.favourites.length) out.push(`أكثر ما طلبته: ${m.favourites.map((f) => f.name).join("، ")}.`);
  if (m.usual_mode) out.push(`طريقة الطلب المعتادة: ${{ delivery: "توصيل", pickup: "استلام من الفرع", in_store: "من الفرع", table: "من الطاولة", dine_in: "في الصالة" }[m.usual_mode] || m.usual_mode}.`);
  if (m.districts.length) out.push(`الأحياء اللي وصّلنا لها: ${m.districts.join("، ")}.`);
  if (m.loyalty) out.push(`الولاء: ${m.loyalty.progress} من ${m.loyalty.every} طلبات.`);
  out.push("نستخدمها عشان نخدمك أسرع بس. لإيقاف رسائلنا اكتب: إيقاف");
  return out.join("\n");
}

/* ── ٣) حاسبة الاقتراح (صافية) — اقتراح واحد بالكتير ──────────────────────
   cart = { lines:[{ id?, slug?, name, price, qty, kind }], subtotal, option }
   ctx  = { menu, boxes, quote, offers, topSellers:[id], declined:[kind], profile }
   ⇒ null أو { kind, ...أرقام حقيقية } . الترتيب: بوكس أوفر ⇒ فرق الشريحة ⇒ مشروب ⇒ جانبي ⇒ الأكثر مبيعاً. اللي العميل رفضه مايتكررش. */
export function suggestOne(cart, ctx = {}, cfg = ASSIST_DEFAULTS) {
  if (!cart || !Array.isArray(cart.lines) || !cart.lines.length) return null;
  const declined = new Set(ctx.declined || []);
  const menu = ctx.menu, items = menu && Array.isArray(menu.items) ? menu.items.filter((i) => !i.soldOut) : [];
  /* اللي في السلة = الأصناف + كل اللي جوّه البوكسات (الثابت والمختار) — مانقترحش على العميل حاجة هو واخدها جوّه البوكس (عطل تقييم ١٢/١٠: «وجبة ميكس جريل» فوق بوكس الميكس جريل). */
  const inCart = new Set([...cart.lines.filter((l) => l.id).map((l) => String(l.id)), ...cart.lines.flatMap((l) => (Array.isArray(l.contains) ? l.contains.map(String) : []))]);
  const hasBox = cart.lines.some((l) => l.slug);
  const avoid = new Set((ctx.profile && ctx.profile.low_ratings && ctx.profile.low_ratings.items) || []);
  // (أ) بوكس فيه نفس الأصناف بسعر أقل — حساب بحت
  if (!declined.has("box_saves") && Array.isArray(ctx.boxes)) {
    let best = null;
    for (const b of ctx.boxes) {
      const need = [];
      let okBox = Array.isArray(b.slots) && b.slots.length > 0;
      for (const s of b.slots || []) {
        const ids = s.type === "fixed" ? [String(s.item && s.item.product_id)] : (s.choices || []).filter((c) => !(Number(c.surcharge) > 0)).map((c) => String(c.product_id));
        const hit = cart.lines.find((l) => l.id && ids.includes(String(l.id)) && !need.some((n) => n.line === l && n.used >= l.qty));
        if (!hit) { okBox = false; break; }
        const prev = need.find((n) => n.line === hit); const q = Number(s.quantity) || 1;
        if (prev) prev.used += q; else need.push({ line: hit, used: q });
        if ((prev ? prev.used : q) > hit.qty) { okBox = false; break; }
      }
      if (!okBox) continue;
      const separate = round2(need.reduce((a, n) => a + n.line.price * n.used, 0)), saves = round2(separate - Number(b.price));
      if (saves >= 1 && (!best || saves > best.saves)) best = { kind: "box_saves", slug: b.slug, name: b.name, box_price: Number(b.price), separate, saves };
    }
    if (best) return best;
  }
  // (ب) فرق بسيط للشريحة الجاية من رسوم التوصيل (من عرض السعر الحقيقي لموقعه)
  const qv = ctx.quote;
  if (!declined.has("next_tier") && cart.option !== "pickup" && qv && qv.deliverable && Number(qv.toNextTier) > 0 && Number(qv.toNextTier) <= cfg.nudgeGapSar && Number.isFinite(Number(qv.nextTierFee))) {
    const gap = round2(qv.toNextTier);
    const pick = items.filter((i) => !inCart.has(String(i.id)) && i.price >= gap && !avoid.has(i.name)).sort((a, b) => a.price - b.price)[0] || null;
    return { kind: "next_tier", add_sar: gap, fee_now: Number(qv.fee), fee_then: Number(qv.nextTierFee), free: Number(qv.nextTierFee) === 0, item: pick ? itemBrief(pick) : null };
  }
  const has = (k) => cart.lines.some((l) => l.kind === k || l.slug);            // البوكسات فيها مشروب وجانبي غالباً ⇒ مانقترحش عليهم
  /* مشروب / جانبي: الأكثر مبيعاً فعلاً (ترتيب مبيعات نقطة البيع) مش الأرخص؛ المياه مابتتقترحش كـ«المشروب» إلا لو مفيش غيرها (قرار ١٢/١٠). */
  const rank = new Map((Array.isArray(ctx.topSellers) ? ctx.topSellers : []).map((id, i) => [String(id), i]));
  const WATER = /مياه|ماء|water/i;
  const best = (k) => { const c = items.filter((i) => kindOf(i) === k && !inCart.has(String(i.id)) && !avoid.has(i.name));
    const order = (a, b) => (rank.has(String(a.id)) ? rank.get(String(a.id)) : 1e6) - (rank.has(String(b.id)) ? rank.get(String(b.id)) : 1e6) || a.price - b.price;
    const nw = c.filter((i) => !WATER.test(normalize(`${i.name} ${i.nameEn}`))); return (nw.length ? nw : c).sort(order)[0] || null; };
  if (!declined.has("drink") && !has("drink")) { const d = best("drink"); if (d) return { kind: "drink", item: itemBrief(d) }; }
  if (!declined.has("side") && !has("side")) { const s2 = best("side"); if (s2) return { kind: "side", item: itemBrief(s2) }; }
  /* صنف رئيسي من الأكثر مبيعاً: بس لو السلة مافيهاش صنف رئيسي ولا بوكس (العميل طالب مشروب/جانبي بس) — «زوّد وجبة تانية» مش اقتراح أمين. */
  if (!declined.has("top_seller") && Array.isArray(ctx.topSellers) && !hasBox && !cart.lines.some((l) => l.kind === "main")) {
    const t = ctx.topSellers.map((id) => items.find((i) => String(i.id) === String(id))).find((i) => i && !inCart.has(String(i.id)) && kindOf(i) === "main" && !avoid.has(i.name));
    if (t) return { kind: "top_seller", item: itemBrief(t) };
  }
  return null;
}

/* ── ٤) المراجِع (صافي) ───────────────────────────────────────────────────
   reply: نص الموديل. facts: كل نتايج الأدوات في الدور ده + نص العميل (أرقامه هو مسموح تتكرر).
   know: { menu, boxes } لاكتشاف اسم صنف/بوكس اتذكر ومارجعش من أداة.
   ⇒ { ok, problems:[{type, value}] } . أي مشكلة ⇒ الرد مايتبعتش. */
const FORBIDDEN = [
  [/خالي(ة)? من|خال من|لا يحتوي|ما فيه(ا)? اي|امن(ة)? (لك|ل)|مناسب(ة)? لمرضى|مضمون|نضمن|free from|safe for|guarantee/i, "health_or_guarantee"],
  [/(خلال|في غضون|بعد) ?\d+ ?(دقيق|دقايق|ساع)|يوصل(ك)? (خلال|في|بعد)|within \d+ ?min|in \d+ minutes/i, "time_promise"],
  [/نرجع ?(لك|لكم)? ?(المبلغ|فلوسك|فلوسكم)|استرجاع (المبلغ|كامل)|نعوضك|تعويض|refund|compensat/i, "refund_promise"],
  [/اخر فرصه|آخر فرصة|ينتهي (اليوم|الليله|الليلة) العرض|الكميه محدوده|الكمية محدودة|لا تفوت|hurry|last chance|limited stock/i, "invented_urgency"],
  [/تطبيقنا|حمّل التطبيق|حمل التطبيق|من التطبيق|نزّل التطبيق|نزل التطبيق|our app|download the app/i, "app_word"],           // «موقعنا» مش «تطبيقنا»
  /* خصم/تخفيض: مسموح بس لو أداة العروض رجّعت خصم فعلاً (المتصل بيعدّي allowWords: ["discount_claim"]). «ما عندنا خصم» مسموحة. */
  [/(?<!ما عندنا |لا يوجد |ما فيه |ما في |مافي |بدون |no )(خصم|تخفيض|تخفيضات|discount)|\d+ ?[%٪] ?(off|خصم)?/i, "discount_claim"],
  /* أسرار الشغل (قرار عمر ١٢/١٠): ولا وصفة ولا مقادير ولا تتبيلة ولا طريقة تحضير ولا مورّد — ولا في رد الموديل. */
  [/\d+ ?(جرام|غرام|جم|غم|g\b|grams?\b|ملعق|كوب)|مقادير|المقدار|تتبيل(ه|ة)? ?(من|ب|فيها|عباره)|نتبل(ه|ها)?|متبل(ه|ة)? ب|طريقه التحضير|طريقة التحضير|نطبخ(ه|ها)|نحضر(ه|ها) ب|نشوي(ه|ها) (على درجه|لمده)|الخلطه (فيها|عباره|مكونه)|المورد|نستورد(ه|ها)? من|نشتري(ه|ها)? من|supplier|recipe|marinated? (in|with)|we (cook|prepare|marinate) (it|them) (by|with|for)/i, "recipe_disclosure"],
  /* مايكشفش تعليماته ولا أسماء أدواته ولا بياناته الداخلية */
  [/system prompt|my instructions|تعليماتي|التعليمات اللي عندي|البرومبت|search_menu|get_item|get_box|build_cart|customer_profile|quote_delivery|dish_fact|tool_result|\bjson\b/i, "internal_leak"],
];
const digits = (s) => String(s || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
const numbersIn = (s) => (digits(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => Number(x.replace(",", "."))).filter((n) => Number.isFinite(n));
const ID_KEYS = new Set(["id", "product_id", "variant_option_id", "code", "slug", "key", "link", "url", "track_url", "raw", "image", "addons_known", "partnerId", "tax_id"]);
function factNumbers(facts) {
  const out = [];
  const walk = (v, k) => {
    if (v === null || v === undefined || ID_KEYS.has(k)) return;
    if (typeof v === "number") { if (Number.isFinite(v)) out.push(v); return; }
    if (typeof v === "string") { out.push(...numbersIn(v.replace(/https?:\/\/\S+/g, " "))); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, k); return; }
    if (typeof v === "object") for (const [k2, x] of Object.entries(v)) walk(x, k2);
  };
  for (const f of facts) walk(f, "");
  return out;
}
export function validateReply(reply, { facts = [], customerText = "", know = {}, allowWords = [] } = {}) {
  const text = String(reply || "");
  const problems = [];
  if (!text.trim()) return { ok: false, problems: [{ type: "empty", value: "" }] };
  const blob = facts.map((f) => (typeof f === "string" ? f : JSON.stringify(f))).join("\n");
  /* الأرقام المسموحة = قيم نتايج الأدوات (أسعار، كميات، رسوم…) + أرقام العميل نفسه. المعرّفات (id / product_id / code / slug / key…) والروابط
     مش «أرقام تتقال»: من غير الاستثناء ده سعر مخترع كان يعدّي لو صادف رقم صنف في النتيجة. رقم الطلب مسموح (بيتقال للعميل). */
  const okNums = new Set([...factNumbers(facts), ...numbersIn(customerText)].map((n) => round2(n)));
  for (const n of numbersIn(text.replace(/https?:\/\/\S+/g, " "))) if (!okNums.has(round2(n))) problems.push({ type: "number_not_from_tools", value: String(n) });
  const urls = text.match(/https?:\/\/[^\s)]+/g) || [];
  for (const u of urls) if (!blob.includes(u.replace(/[.,،]$/, ""))) problems.push({ type: "link_not_from_tools", value: u });
  const nb = normalize(blob), nt = normalize(text);
  const names = [...((know.menu && know.menu.items) || []).map((i) => i.name), ...((know.boxes || []).map((b) => b.name))].filter((n) => [...String(n)].length >= 5);
  for (const n of new Set(names)) { const k = normalize(n); if (nt.includes(k) && !nb.includes(k)) problems.push({ type: "name_not_from_tools", value: n }); }
  for (const [re, type] of FORBIDDEN) { const m = re.exec(nt) || re.exec(text); if (m && !allowWords.includes(type)) problems.push({ type, value: m[0] }); }
  if ([...text].length > 900) problems.push({ type: "too_long", value: String([...text].length) });
  return { ok: problems.length === 0, problems };
}

/* ── ٢) بنّاء السلة + باقي الأدوات (بتقرا من النظام) ─────────────────────
   deps: { pool, menuIndex(), boxes() ⇒ قايمة /api/shop/bundles بخاناتها, expandBundle(slug, choices, qty, option, {mods,notes}), modifiers ⇒ { catalogItems(), resolve(id, ids) },
           quote({lat,lng,orderTotal,district}), offers(), openState(), buildProfile(pn), botCarts, lastLocation(pn), now() } */
export function makeAssistTools(deps = {}) {
  const { pool } = deps;
  const now = deps.now || (() => new Date());
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { (deps.log || console.error)("[assist] db:", e.message); return null; } };
  const okPhone = (p) => /^5\d{8}$/.test(String(p || ""));
  const menuOf = async () => { try { return await deps.menuIndex(); } catch { return null; } };
  const boxesOf = async () => { try { const b = await deps.boxes(); return Array.isArray(b) && b.length ? b : null; } catch { return null; } };
  const unavailable = (what) => ({ ok: false, error: "unavailable", what });
  /* الحدود (عدد نتايج البحث، فرق الشريحة، أيام الأكثر مبيعاً…) من إعدادات اللوحة لو المتصل وصّلها (deps.tune)، وإلا الافتراضي. */
  const tuneOf = async () => { try { const t = deps.tune ? await deps.tune() : null; return t && typeof t === "object" ? { ...ASSIST_DEFAULTS, ...t } : ASSIST_DEFAULTS; } catch { return ASSIST_DEFAULTS; } };

  async function search_menu(_p, { query } = {}) {
    const r = searchMenu(await menuOf(), query, (await tuneOf()).searchMax);
    return r === null ? unavailable("menu") : { ok: true, results: r };
  }
  async function addonsOf(id) {
    try { const cat = deps.modifiers ? await deps.modifiers.catalogItems() : null; const g = cat && cat[String(id)];
      /* الكتالوج الحي: name = الاسم العربي، localName = الإنجليزي (زي أصناف المنيو). الشريحة ١ كانت بتعرض الإنجليزي للعميل العربي. */
      return Array.isArray(g) ? g.map((x) => ({ group: x.name || x.localName, group_en: x.localName || x.name, min: x.min, max: x.max, options: (x.options || []).map((o) => ({ id: o.id, name: o.name || o.localName, name_en: o.localName || o.name, price: round2(o.shown) })) })) : []; }
    catch { return null; }
  }
  async function get_item(_p, { id } = {}) {
    const menu = await menuOf(); if (!menu) return unavailable("menu");
    const it = menu.items.find((i) => String(i.id) === String(id));
    if (!it) return { ok: false, error: "not_found" };
    const addons = await addonsOf(it.id);
    /* جملة عامة وافق عليها المالك (حقايق ١٢/١٠: «الصوص يُقدَّم جانبياً»، «صدور دجاج مقرمشة…») — بتتقال مع وصف المنيو */
    let ownerNote = null; try { ownerNote = typeof deps.dishNote === "function" ? await deps.dishNote(String(it.id)) : null; } catch { ownerNote = null; }
    return { ok: true, item: { ...itemBrief(it), description: it.desc || "", ...(ownerNote ? { owner_note: ownerNote } : {}), addons: addons || [], addons_known: addons !== null, note: "description is the menu description, not a full ingredient list" } };
  }
  const slotView = (s) => (s.type === "fixed"
    ? { key: s.key, label: s.label, type: "fixed", quantity: s.quantity || 1, item: s.item ? { product_id: String(s.item.product_id), name: s.item.name, variant: s.item.variant_name || null } : null }
    : { key: s.key, label: s.label, type: "choice", quantity: s.quantity || 1, choices: (s.choices || []).map((c) => ({ product_id: String(c.product_id), variant_option_id: c.variant_option_id ?? null, name: c.name, variant: c.variant_name || null, extra: Number(c.surcharge) > 0 ? round2(c.surcharge) : 0 })) });
  async function get_box(_p, { slug } = {}) {
    const bs = await boxesOf(); if (!bs) return unavailable("boxes");
    const b = bs.find((x) => String(x.slug) === String(slug));
    if (!b) return { ok: false, error: "not_found" };
    const slots = (b.slots || []).map(slotView);
    const menu = await menuOf(), enOf = (pid) => { const it = menu && menu.items.find((i) => String(i.id) === String(pid)); return it && it.nameEn ? it.nameEn : null; };
    for (const s of slots) { if (s.label && (b.slots.find((x) => x.key === s.key) || {}).label_en) s.label_en = b.slots.find((x) => x.key === s.key).label_en;
      if (s.type === "fixed" && s.item) { const e = enOf(s.item.product_id); if (e) s.item.name_en = e; } if (s.type === "choice") for (const c of s.choices) { const e = enOf(c.product_id); if (e) c.name_en = e; } }
    for (const s of slots) if (s.type === "choice") for (const c of s.choices) { const a = await addonsOf(c.product_id); c.addons = (a || []).flatMap((g) => g.options.map((o) => ({ id: o.id, name: o.name, price: o.price, group: g.group }))); }
    return { ok: true, box: { slug: b.slug, name: b.name, name_en: b.name_en || null, price: Number(b.price), description: b.description || "", description_en: b.description_en || null, section: b.section || "", slots, online_only: true } };
  }
  /* سؤال محدد عن صنف: «هل X فيه <مكوّن/مسبّب حساسية>؟» ⇒ نعم / لا / غير معروف (⇒ موظف) + هل يتشال عند الطلب. **الإجابة بس** — ملف حقايق الأصناف
     داخلي ومابيتبعتش للموديل ولا يتقتبس (قرار عمر: «نجاوب على قد السؤال»). لحد ما الملف يتوافق عليه: deps.dishFact مش موجود ⇒ غير معروف ⇒ موظف. */
  async function dish_fact(_p, { id, ask } = {}) {
    const menu = await menuOf(); if (!menu) return unavailable("menu");
    const it = menu.items.find((i) => String(i.id) === String(id));
    if (!it) return { ok: false, error: "not_found" };
    const what = String(ask || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!what) return { ok: false, error: "ask_required" };
    let f = null; try { f = typeof deps.dishFact === "function" ? await deps.dishFact({ id: String(it.id), name: it.name, ask: what }) : null; } catch { f = null; }
    if (!f || typeof f.contains !== "boolean") return { ok: true, item: it.name, asked: what, answer: "unknown", handover: true };
    return { ok: true, item: it.name, asked: what, answer: f.contains ? "yes" : "no", can_remove_on_request: f.contains ? f.removable === true : null,
      shared_kitchen_note: true, severe_allergy: "hand over to staff; never say safe or free from" };
  }
  async function list_boxes() {
    const bs = await boxesOf(); if (!bs) return unavailable("boxes");
    return { ok: true, boxes: bs.filter((b) => String(b.section || "").trim()).map((b) => ({ slug: b.slug, name: b.name, name_en: b.name_en || null, price: Number(b.price), section: b.section, section_en: b.section_en || null, description: b.description || "", description_en: b.description_en || null })), online_only: true };
  }
  async function check_availability(_p, { ids = [] } = {}) {
    const menu = await menuOf(); if (!menu) return unavailable("menu");
    return { ok: true, items: (Array.isArray(ids) ? ids : []).slice(0, 30).map((id) => { const it = menu.items.find((i) => String(i.id) === String(id)); return { id: String(id), status: !it ? "not_on_menu" : it.soldOut ? "sold_out_today" : "available", name: it ? it.name : null }; }) };
  }
  /* عرض سعر التوصيل: من موقع شاركه العميل في المحادثة (lat/lng) أو آخر موقع محفوظ له. من غير موقع ⇒ need_location (مانخمّنش من اسم الحي). */
  async function quote_delivery(phone, { lat, lng, total = 0 } = {}) {
    let la = Number(lat), ln = Number(lng), from = "given";
    if (!(Number.isFinite(la) && Number.isFinite(ln))) { const l = deps.lastLocation ? await deps.lastLocation(phone) : null; if (l && Number.isFinite(Number(l.lat))) { la = Number(l.lat); ln = Number(l.lng); from = "shared_in_chat"; } }
    if (!(Number.isFinite(la) && Number.isFinite(ln))) return { ok: false, error: "need_location", hint: "ask the customer to share their location pin in the chat; until it arrives do not say whether we deliver to them or what the fee is" };
    let r; try { r = await deps.quote({ lat: la, lng: ln, orderTotal: Number(total) || 0 }); } catch { r = null; }
    if (!r || typeof r.deliverable !== "boolean") return unavailable("delivery_quote");
    if (r.deliverable) return { ok: true, deliverable: true, fee: Number(r.fee), for_total: Number(total) || 0, to_next_tier: Number(r.toNextTier) > 0 ? round2(r.toNextTier) : null, next_tier_fee: Number.isFinite(Number(r.nextTierFee)) ? Number(r.nextTierFee) : null,
      to_free: Number(r.toFree) > 0 ? round2(r.toFree) : null, far_zone_extra: r.farZone ? Number(r.farZone.surcharge) : 0, location: from,
      /* حد التوصيل المجاني كقيمة طلب (مش «باقي كام»): بيتقال للعميل اللي لسه ماعندوش سلة. مسافة الطريق لموقعه. */
      ...(Number(r.toFree) > 0 ? { free_from_total: round2((Number(total) || 0) + Number(r.toFree)) } : Number(r.fee) === 0 ? { free_now: true } : {}),
      ...(Number(r.routeKm) > 0 ? { distance_km: Math.round(Number(r.routeKm) * 10) / 10 } : {}),
      /* وقت التوصيل: بيتقال «تقريباً» **بس** لو التسعيرة رجّعت تقدير حقيقي (النهارده مابترجّعش ⇒ المساعد مايذكرش وقت). */
      ...(Number(r.etaMinutes) > 0 ? { about_minutes: Math.round(Number(r.etaMinutes)) } : {}), raw: { fee: r.fee, toNextTier: r.toNextTier, nextTierFee: r.nextTierFee, deliverable: true } };
    return { ok: true, deliverable: false, reason: r.reason, min_order: r.minOrderTotal ?? null, far_zone_offer_extra: r.farZoneOffer ? Number(r.farZoneOffer.surcharge) : null, pickup_available: true, location: from };
  }
  async function get_offers(phone) {
    const settings = deps.settings ? await deps.settings() : {};
    const out = { ok: true, first_order: null, loyalty: null, timed: [], rewards: [] };
    try { const fr = await q(`SELECT code, percent, active, expires_at, free_delivery, min_total FROM shop_coupons WHERE upper(code)='FIRST' LIMIT 1`, []);
      if (fr && fr[0] && okPhone(phone)) { const e = await firstEligibility(fr[0], phone, couponQueries(pool), now()); out.first_order = { eligible: e.eligible, code: fr[0].code, free_delivery: Boolean(fr[0].free_delivery), min_total: Number(fr[0].min_total) || 0, reason: e.reason }; } } catch { out.first_order = null; }
    out.loyalty = await loyaltyOf(phone, settings);
    out.rewards = await rewardsOf(phone);
    try { const list = deps.offers ? await deps.offers() : null; out.timed = (list || []).map((o) => ({ title: o.title, price: Number(o.price), until: o.until || null })); out.timed_known = list !== null; } catch { out.timed_known = false; }
    return out;
  }
  async function loyaltyOf(phone, settings) {
    try { const cfg = loyaltyCfgOf(settings || (deps.settings ? await deps.settings() : {})); if (!cfg || !cfg.enabled || !okPhone(phone)) return null;
      const r = await q(`SELECT count(*)::int AS n FROM shop_orders WHERE phone_norm=$1 AND created_at >= $2::timestamptz AND ${LOYALTY_COUNTED_SQL}`, [phone, cfg.startedAt || "2000-01-01"]);
      if (!r) return null; const n = Number(r[0]?.n) || 0, progress = n % cfg.every;
      return { every: cfg.every, progress, left: cfg.every - progress, reward: cfg.reward === "percent" ? `${cfg.percent}%` : "free_delivery", min_total: cfg.minTotal || 0, status: loyaltyStatusFor(n, cfg.every)?.statusText || null }; }
    catch { return null; }
  }
  async function rewardsOf(phone) {
    if (!okPhone(phone)) return [];
    const r = await q(`SELECT s.code, s.percent, s.free_delivery, s.min_total, to_char(s.expires_at AT TIME ZONE 'Asia/Riyadh','YYYY-MM-DD') AS expires FROM cms_loyalty l JOIN shop_coupons s ON s.code = l.coupon
                        WHERE l.phone_norm=$1 AND s.active AND s.used_count < COALESCE(s.max_uses,1) AND (s.expires_at IS NULL OR s.expires_at > NOW())
                          AND NOT EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm=$1 AND o.coupon = s.code AND o.status NOT IN ('pending_payment','expired')) ORDER BY l.created_at DESC LIMIT 5`, [phone]);
    return (r || []).map((x) => ({ code: x.code, freeDelivery: Boolean(x.free_delivery), percent: Number(x.percent) || 0, minTotal: Number(x.min_total) || 0, expires: x.expires }));
  }
  async function get_hours() {
    try { const o = await deps.openState(); if (!o) return unavailable("hours"); return { ok: true, open_now: o.open === true, closes_at: o.closesText || null, opens: o.opensText || null, delivery_paused: Boolean(o.deliveryPaused) }; }
    catch { return unavailable("hours"); }
  }
  /* حالة الطلب: من غير أي مُدخل — الرقم هو مُرسِل الرسالة (بيتحدد في الكود، مش من الموديل) */
  async function order_status(phone) {
    if (!okPhone(phone)) return { ok: false, error: "no_phone" };
    const r = await q(`SELECT order_no, status, option, total, created_at FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment') AND created_at > NOW() - INTERVAL '72 hours' ORDER BY created_at DESC LIMIT 3`, [phone]);
    if (r === null) return unavailable("orders");
    return { ok: true, orders: r.map((o) => ({ order_no: o.order_no, status: o.status, mode: o.option, total: round2(o.total), track_url: `${STORE}/track/${o.order_no}` })) };
  }
  async function customer_profile(phone) {
    if (!okPhone(phone)) return { ok: true, profile: { known: false } };
    let p = null; try { p = await deps.buildProfile(phone); } catch { p = null; }
    if (!p) return unavailable("profile");
    let firstEligible = null; try { const fr = await q(`SELECT code, percent, active, expires_at, free_delivery FROM shop_coupons WHERE upper(code)='FIRST' LIMIT 1`, []); if (fr && fr[0]) firstEligible = (await firstEligibility(fr[0], phone, couponQueries(pool), now())).eligible; } catch { firstEligible = null; }
    const co = await q(`SELECT updates, marketing, stopped_at FROM wa_optins WHERE phone_norm=$1`, [phone]);
    const consent = co && co[0] ? { updates: co[0].updates === true, marketing: co[0].marketing === true, stopped: Boolean(co[0].stopped_at) } : null;
    return { ok: true, profile: profileForModel(p, { loyalty: await loyaltyOf(phone), rewards: await rewardsOf(phone), firstEligible, consent, lang: deps.langOf ? await deps.langOf(phone) : "ar" }, now(), await tuneOf()) };
  }

  /* بنّاء السلة. input = { option: "delivery"|"pickup", items:[{ id, qty, note }], boxes:[{ slug, qty, choices:{ slot:{product_id,variant_option_id} }, addons:{ slot:[id] }, notes:{ slot:"…" } }] }
     كل سطر بيتراجع على النظام؛ أي سطر مايتبنيش بيرجع بسببه (والباقي يتبني). السعر: الأصناف من المنيو الحي، البوكس من cms.expandBundle + modifiers.resolve.
     save=true ⇒ يتعمل صف في wa_bot_carts ويرجع الرابط؛ save=false ⇒ معاينة بس. الأصناف بالوزن والإضافات على صنف عادي مش مدعومين هنا ⇒ بيترجعوا كـ«اختاره من صفحته». */
  async function build_cart(phone, input = {}, { save = true } = {}) {
    const menu = await menuOf(); if (!menu) return unavailable("menu");
    const option = input.option === "pickup" ? "pickup" : "delivery";
    const lines = [], problems = [], raw = {}, items = [];
    for (const li of (Array.isArray(input.items) ? input.items : []).slice(0, (await tuneOf()).maxCartLines)) {
      const it = menu.items.find((i) => String(i.id) === String(li && li.id));
      if (!it) { problems.push({ id: String(li && li.id), error: "not_on_menu" }); continue; }
      if (it.soldOut) { problems.push({ id: it.id, name: it.name, error: "sold_out_today" }); continue; }
      if (it.byWeight) { problems.push({ id: it.id, name: it.name, error: "choose_weight_on_site", url: `${STORE}/l/wab-menu#item-${it.id}` }); continue; }
      if (Array.isArray(li.addons) && li.addons.length) { problems.push({ id: it.id, name: it.name, error: "addons_on_site_only", url: `${STORE}/l/wab-menu#item-${it.id}` }); continue; }
      const qty = qtyOf(li.qty), note = String(li.note || "").replace(/\s+/g, " ").trim().slice(0, 100);
      const prev = raw[it.id];
      if (prev && !note && !prev.note) { prev.qty = Math.min(20, prev.qty + qty); const l0 = lines.find((l) => l.id === it.id && !l.note); l0.qty = prev.qty; l0.total = round2(it.price * prev.qty); continue; }
      const key = prev ? `${it.id}:n${lines.length}` : String(it.id);
      raw[key] = { item: { id: Number(it.id) }, qty, ...(note ? { note } : {}) };
      lines.push({ id: it.id, name: it.name, name_en: it.nameEn || it.name, price: it.price, qty, total: round2(it.price * qty), kind: kindOf(it), ...(note ? { note } : {}) });
      items.push({ id: it.id, n: it.name.slice(0, 60), q: qty, p: it.price });
    }
    const boxesIn = (Array.isArray(input.boxes) ? input.boxes : []).slice(0, 10);
    const bs = boxesIn.length ? await boxesOf() : [];
    if (boxesIn.length && !bs) return unavailable("boxes");
    for (const bi of boxesIn) {
      const b = bs.find((x) => String(x.slug) === String(bi && bi.slug));
      if (!b) { problems.push({ slug: String(bi && bi.slug), error: "box_not_found" }); continue; }
      const qty = qtyOf(bi.qty), choices = {}, mods = {}, notes = {};
      for (const s of b.slots || []) {
        if (s.type !== "choice") { const n0 = String((bi.notes || {})[s.key] || "").replace(/\s+/g, " ").trim().slice(0, 100); if (n0) notes[s.key] = n0; continue; }
        const want = (bi.choices || {})[s.key];
        const c = want && (s.choices || []).find((x) => String(x.product_id) === String(isObj(want) ? want.product_id : want) && (!isObj(want) || want.variant_option_id == null || Number(x.variant_option_id) === Number(want.variant_option_id)));
        if (c) choices[s.key] = c;
        const m = ((bi.addons || {})[s.key] || []).map(Number).filter(Number.isInteger).slice(0, 12).sort((a, b2) => a - b2); if (m.length) mods[s.key] = m;
        const n1 = String((bi.notes || {})[s.key] || "").replace(/\s+/g, " ").trim().slice(0, 100); if (n1) notes[s.key] = n1;
      }
      const missing = (b.slots || []).filter((s) => s.type === "choice" && !choices[s.key]).map((s) => ({ key: s.key, label: s.label }));
      if (missing.length) { problems.push({ slug: b.slug, name: b.name, error: "choice_required", missing }); continue; }
      let ex; try { ex = await deps.expandBundle(b.slug, Object.fromEntries(Object.entries(choices).map(([k, c]) => [k, { product_id: c.product_id, variant_option_id: c.variant_option_id ?? null }])), qty, option, { mods, notes }); } catch (e) { ex = { ok: false, error: "expand_failed" }; }
      if (!ex || !ex.ok) { problems.push({ slug: b.slug, name: b.name, error: `box_${(ex && ex.error) || "failed"}`, detail: ex && (ex.message || ex.items || ex.missing || null) }); continue; }
      let modsIncl = 0, modBad = null;
      for (const [k, ids] of Object.entries(mods)) {
        let r; try { r = await deps.modifiers.resolve(choices[k].product_id, ids); } catch { r = { ok: false, error: "unavailable" }; }
        if (!r || !r.ok) { modBad = { slot: k, error: (r && r.error) || "unavailable" }; break; }
        modsIncl += Number(r.shown) || 0;
      }
      if (modBad) { problems.push({ slug: b.slug, name: b.name, error: `addon_${modBad.error}`, slot: modBad.slot }); continue; }
      const surIncl = round2((Number(ex.surchargeIncl) || 0) / (ex.quantity || qty)), unit = round2(Number(b.price) + surIncl + modsIncl);
      const noteSig = Object.keys(notes).sort().map((k) => `${k}=${notes[k]}`).join("|");
      let nh = 0; for (let i = 0; i < noteSig.length; i++) nh = (nh * 31 + noteSig.charCodeAt(i)) >>> 0;
      const sig = Object.keys(choices).sort().map((k) => `${k}=${choices[k].product_id}:${choices[k].variant_option_id || ""}${mods[k] ? `:m${mods[k].join("-")}` : ""}`).join("|") + (noteSig ? `|n${nh.toString(36)}` : "");
      const key = `b:${b.slug}:${sig}`;      // نفس مفتاح المتجر (addBundleToCart): نفس التركيبة سطر واحد
      raw[key] = { key, bundle: b, choices, qty, mods, notes, modsIncl: round2(modsIncl), surIncl,
        item: { id: `b:${b.slug}`, name: b.name, local_name: b.name_en || b.name, retail_price: round2(Number(b.price) + surIncl), price: round2((Number(b.price) + surIncl) / 1.15), image: b.image || "" } };
      lines.push({ slug: b.slug, name: b.name, name_en: b.name_en || b.name, price: unit, qty, total: round2(unit * qty), kind: "box", contains: [...new Set([...(b.slots || []).filter((s) => s.type === "fixed" && s.item).map((s) => String(s.item.product_id)), ...Object.values(choices).map((c) => String(c.product_id))])],
        picks: (ex.picks || []).map((p) => ({ slot: p.label || p.slot, name: p.name, variant: p.variant_name || null, ...(p.note ? { note: p.note } : {}) })), base_price: Number(b.price), choices_extra: surIncl, addons_extra: round2(modsIncl) });
      items.push({ id: key, n: String(b.name).slice(0, 60), q: qty, p: unit });
    }
    const subtotal = round2(lines.reduce((a, l) => a + l.total, 0));
    if (!lines.length) return { ok: false, error: "empty_cart", problems };
    const out = { ok: true, option, lines, subtotal, problems, note: "prices include VAT; the delivery fee is separate and shown by quote_delivery and again on the site before payment" };
    if (!save) return { ...out, saved: false };
    if (!okPhone(phone) || !deps.botCarts) return { ...out, saved: false, error_link: "cannot_save" };
    const made = await deps.botCarts.create({ phone, source: "assistant", plan: { ok: true, raw, items, removed: [], repriced: [], review: [] }, option, days: deps.linkDays || 7 });
    if (!made) return { ...out, saved: false, error_link: "cannot_save" };
    return { ...out, saved: true, link: `${STORE}/c/${made.code}`, code: made.code };
  }
  /* الأكثر مبيعاً فعلاً (نقطة البيع، آخر N يوم) ⇒ معرّفات المنيو بترتيب المبيعات */
  async function top_sellers() {
    const menu = await menuOf(); if (!menu) return [];
    const r = await q(`SELECT i.name, sum(i.qty)::float AS qty FROM ts_order_items i JOIN ts_orders o ON o.order_id = i.order_id
                        WHERE o.order_date > NOW() - make_interval(days => $1::int) AND COALESCE(o.order_type,'') NOT ILIKE '%void%' AND COALESCE(o.order_type,'') NOT ILIKE '%refund%' GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, [(await tuneOf()).topSellerDays]);
    const byName = new Map(menu.items.map((i) => [normalize(i.name), i.id]));
    return (r || []).map((x) => byName.get(normalize(x.name))).filter(Boolean);
  }
  /* اقتراح واحد على سلة اتبنت: بيجمع المدخلات الحقيقية وينده suggestOne */
  async function suggest(phone, { cart, declined = [], profile = null } = {}) {
    if (!cart || !cart.ok) return { ok: true, suggestion: null };
    const [menu, boxes, tops] = await Promise.all([menuOf(), boxesOf(), top_sellers()]);
    let quote = null;
    let freeAnyway = false;
    if (cart.option !== "pickup") { try { const of = await get_offers(phone); freeAnyway = Boolean((of.first_order && of.first_order.eligible && of.first_order.free_delivery && cart.subtotal >= (of.first_order.min_total || 0)) || (of.rewards || []).some((r) => r.freeDelivery && cart.subtotal >= (r.minTotal || 0))); } catch { freeAnyway = false; } }
    if (cart.option !== "pickup" && !freeAnyway) { const qv = await quote_delivery(phone, { total: cart.subtotal }); if (qv.ok && qv.deliverable) quote = { deliverable: true, fee: qv.fee, toNextTier: qv.to_next_tier, nextTierFee: qv.next_tier_fee }; }
    return { ok: true, suggestion: suggestOne(cart, { menu, boxes: boxes || [], quote, topSellers: tops, declined, profile }, await tuneOf()) };
  }
  /* باقات التجمعات (الباقات اللي مالهاش قسم بوكسات): الاسم والسعر والوصف العام */
  async function list_packs() {
    const bs = await boxesOf(); if (!bs) return unavailable("boxes");
    return { ok: true, packs: bs.filter((b) => !String(b.section || "").trim()).map((b) => ({ slug: b.slug, name: b.name, name_en: b.name_en || null, price: Number(b.price), description: b.description || "", description_en: b.description_en || null })), online_only: true };
  }
  /* «جوعان ومش عارف أطلب إيه»: الأكثر مبيعاً فعلاً (نقطة البيع) من الأصناف المتاحة الحين — لحد ٥ */
  async function recommend() {
    const menu = await menuOf(); if (!menu) return unavailable("menu");
    const ids = await top_sellers();
    const picks = ids.map((id) => menu.items.find((i) => String(i.id) === String(id))).filter((i) => i && !i.soldOut && kindOf(i) === "main").slice(0, 5).map(itemBrief);
    return { ok: true, basis: "real sales, most sold first", results: picks };
  }
  return { dish_fact, search_menu, get_item, get_box, list_boxes, list_packs, recommend, check_availability, quote_delivery, get_offers, get_hours, order_status, customer_profile, build_cart, top_sellers, suggest };
}
