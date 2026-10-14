/* ═══════════════════════════════════════════════════════════════════════════
   «عقل البيع» لماجد (SB1، ١٤/١٠/٢٠٢٦) — قرارات البيع بالكود، والموديل يصيغها بس

   عمر (١٤/١٠): «ليه العروض مش بتتعرض… ليه مفيش upselling و cross selling بشكل ذكي… ليه مش بيقولهم ان اول توصيل مجاني…
   ليه لو طلب قبل كذا مش بيشجعه ببرنامج الولاء… ليه الردود مش تفاعلية… ليه التنسيق مش أفضل حاجة».
   محادثات ١٣/١٠ (٢٧ محادثة، صفر سلة): عرض أول طلب اتقال لما اتسأل بس، مفيش ولا اقتراح حد/بوكس، الولاء ولا مرة، وأغلب الردود فقرات.

   الملف ده صافي (مفيش موديل ولا قاعدة ولا إرسال):
     ١) بطاقة العميل (salesCard): أول طلب من الموقع؟ الولاء (كام طلب للمكافأة، مكافأة مااتستخدمتش وتاريخها)، آخر طلب والمعتاد، توصيل ولا استلام، طلب مفتوح.
     ٢) السطر المبادِر (proactiveLine): مرة واحدة في المحادثة، في لحظتها: أول طلب توصيله مجاني / باقي لك طلب واحد / عندك مكافأة / نفس طلبك؟
     ٣) الحد الجاي (thresholdPlan): أقرب حد رسوم (60 / 80 / 100 / 150 أو أول طلب) بالفرق بالظبط وصنف واحد بيقفله (من جدول الاقتران ثم الأكثر مبيعاً).
     ٤) الأزرار (choiceButtons): أي رد بيسأل العميل يختار ⇒ أزرار (≤٣) أو قايمة (≤١٠) بدل «اكتب…».
     ٥) التنسيق (formatReply / boldNames / boldLine): سطور قصيرة، أسماء الأصناف بخط عريض *…*، والسعر «27 ر.س».
   كل رقم هنا جاي من المدخلات (المنيو، السلّم، العروض) — مفيش رقم مكتوب.
═══════════════════════════════════════════════════════════════════════════ */
import { normalize } from "./wabot.js";

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/* «2026-10-18» ⇒ «18/10» (تاريخ نهاية في نص للعميل) */
export const dayMonth = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${Number(m[3])}/${Number(m[2])}` : String(iso || ""); };

/* ── ١) بطاقة العميل ─────────────────────────────────────────────────────────
   profile = waassist.profileForModel(...) · offers = get_offers() · reorder = { lines:[{name, qty}], day } (خطة «نفس الطلب» من بوت القواعد) · openOrder = true|false|null */
export function salesCard({ profile = null, offers = null, reorder = null, openOrder = null } = {}) {
  const p = isObj(profile) ? profile : { known: false };
  const fo = offers && offers.first_order;
  const first = fo && fo.eligible === true && fo.free_delivery ? { eligible: true, from: Number(fo.min_total) || 0, code: String(fo.code || "FIRST") } : { eligible: false };
  const lo = (offers && offers.loyalty) || p.loyalty || null;
  const loyalty = lo && Number(lo.every) > 0 ? { every: Number(lo.every), progress: Number(lo.progress) || 0, left: Number(lo.left) || Number(lo.every), reward: lo.reward || "free_delivery", min_total: Number(lo.min_total) || 0 } : null;
  const rw = ((offers && offers.rewards) || []).find((x) => x && x.code) || null;
  const reward = rw ? { code: String(rw.code), free_delivery: Boolean(rw.freeDelivery), percent: Number(rw.percent) || 0, min_total: Number(rw.minTotal) || 0, expires: rw.expires || null } : null;
  const orders = Number(p.orders) || 0;
  const regular = Boolean(reorder && Array.isArray(reorder.lines) && reorder.lines.length) && orders >= 2;
  return {
    segment: regular ? "regular" : orders > 0 ? "returning" : "first_timer",
    name: p.name || null, orders,
    first, loyalty, reward,
    last_order: p.last_order ? { days_ago: p.last_order.days_ago, mode: p.last_order.mode || null, items: (p.last_order.items || []).slice(0, 4).map((i) => i.name) } : null,
    usual: (p.favourites || []).slice(0, 3).map((f) => f.name),
    usual_mode: p.usual_mode || null,
    same_order: regular ? { lines: reorder.lines.slice(0, 4).map((l) => ({ name: l.name, qty: Number(l.qty) || 1 })), day: reorder.day || null } : null,
    open_order: openOrder === true ? true : openOrder === false ? false : null,
  };
}
/* نسخة صغيرة للموديل (كل دور): من غير أسماء أصناف طويلة ولا أرقام مالهاش لازمة */
export function cardForModel(card) {
  if (!card) return null;
  return { segment: card.segment, ...(card.name ? { first_name: card.name } : {}), first_order_free_delivery: card.first.eligible ? { from: card.first.from, code: card.first.code } : false,
    ...(card.loyalty ? { loyalty: { every: card.loyalty.every, done: card.loyalty.progress, left: card.loyalty.left } } : {}), ...(card.reward ? { unused_reward: { code: card.reward.code, from: card.reward.min_total, until: card.reward.expires } } : {}),
    ...(card.usual_mode ? { usual_mode: card.usual_mode } : {}), ...(card.open_order ? { open_order: true } : {}) };
}

/* ── ٢) السطر المبادِر: مرة واحدة في المحادثة، في لحظته ──────────────────────
   topics = { delivery, order, pin, cart, preview, greeting, offers, firstAsked } (من نص العميل ومن اللي حصل في الدور)
   ⇒ { kind, key, vars, question } أو null. الكود بيحط النص (من نصوص اللوحة) لو الرد ناقصه. */
export const DELIVERY_TOPIC_RE = /(^| )(توصيل|التوصيل|توصلون|توصلوا|توصل|يوصل|نوصل|وصلوا|delivery|deliver|delivered)( |$)/i;
export const ORDER_TOPIC_RE = /(^| )(ابي|ابغى|ابغا|ابا|بدي|ودي|اريد|عايز|عاوز|اطلب|طلب|اطلبلي|جهز|جهزلي|جهزها|جهزه|حط|ضيف|اضف|سله|السله|order|i want|cart)( |$)/i;
export const FIRST_ASK_RE = /(عرض|كود) (ال)?(اول|أول) طلب|(اول|أول) طلب|first order|\bfirst\b/i;
export const OFFERS_ASK_RE = /(^| )(وش|ايش|شو|ايه|إيش|اش|شنو)? ?(ال)?(عروض|عرض اليوم|العروض)( |$)|(^| )(عندكم|عندك|فيه|في|هل) (اي )?(عروض|عرض)( |$)|\b(offers?|deals?|promotions?)\b/i;
export function topicsOf(text) {
  const n = normalize(String(text || ""));
  return { delivery: DELIVERY_TOPIC_RE.test(n), order: ORDER_TOPIC_RE.test(n), firstAsked: FIRST_ASK_RE.test(n), offers: OFFERS_ASK_RE.test(n) };
}
export function proactiveLine(card, st = {}, topics = {}) {
  if (!card || st.proactive) return null;
  const moment = topics.delivery || topics.order || topics.pin || topics.cart || topics.preview || topics.offers;
  /* المنتظم: «نفس طلبك؟» في أول دور لو العميل لسه ماسمّاش حاجة (تحية / عام) */
  if (card.same_order && topics.opening && !topics.named) return { kind: "same", key: "sb_same", vars: { items: card.same_order.lines.map((l) => (l.qty > 1 ? `${l.qty} × ${l.name}` : l.name)).join(" + ") }, question: true, buttons: "same" };
  if (!moment) return null;
  if (card.first.eligible && !topics.firstAsked) return { kind: "first", key: "sb_first", vars: { from: card.first.from, code: card.first.code } };
  if (card.reward && card.reward.free_delivery) return { kind: "reward", key: card.reward.expires ? "sb_reward_until" : "sb_reward", vars: { code: card.reward.code, from: card.reward.min_total, until: card.reward.expires ? dayMonth(card.reward.expires) : "" } };
  if (card.loyalty && card.loyalty.reward === "free_delivery" && card.orders > 0 && (topics.cart || topics.preview || topics.order || topics.delivery || topics.pin)) {
    if (card.loyalty.left === 1) return { kind: "loyalty_one", key: "sb_loyalty_one", vars: { from: card.loyalty.min_total } };
    if (card.loyalty.progress > 0) return { kind: "loyalty_left", key: "sb_loyalty_left", vars: { every: card.loyalty.every, left: card.loyalty.left, from: card.loyalty.min_total } };
  }
  return null;
}
/* الرد فيه السطر ده (أو معناه) خلاص؟ ⇒ مانكررهوش */
export function lineAlreadySaid(kind, text, card) {
  const t = String(text || ""), n = normalize(t);
  if (kind === "first") return card && card.first.code ? t.toUpperCase().includes(String(card.first.code).toUpperCase()) || /(اول|أول) طلب.{0,40}مجان/.test(n) : false;
  if (kind === "reward") return card && card.reward ? t.toUpperCase().includes(String(card.reward.code).toUpperCase()) : false;
  if (kind === "loyalty_one" || kind === "loyalty_left") return /باقي لك|مكافا|مكافأ/.test(n);
  if (kind === "same") return /نفس (ال)?طلب/.test(n);
  return false;
}
/* السطر بيتحط فين: سؤال ⇒ بدل سؤال القفلة (رسالة واحدة = سؤال واحد). معلومة ⇒ قبل سطر السؤال الأخير، وإلا في الآخر. */
export function placeLine(text, line, { question = false } = {}) {
  const ls = String(text || "").split("\n");
  const lastIdx = (() => { for (let i = ls.length - 1; i >= 0; i--) if (ls[i].trim()) return i; return -1; })();
  if (lastIdx < 0) return line;
  const last = ls[lastIdx].trim(), endsQ = /[؟?]\s*$/.test(last);
  if (question) {
    if (endsQ) { const m = /^(.*[.!،\p{Extended_Pictographic}])\s+((?:[^.!،؟?\p{Extended_Pictographic}]|ر\.س)*[؟?])\s*$/u.exec(last); if (m && m[1].trim()) ls[lastIdx] = m[1].trim(); else ls.splice(lastIdx, 1); }
    return [...ls.filter((x, i) => i <= lastIdx || x.trim()), line].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (endsQ) {
    /* السطر الأخير فقرة («… بـ 65 ر.س. توصيل ولا استلام؟»): السطر الجديد قبل جملة السؤال بس، مش فوق الفقرة كلها (batch20: سطر أول طلب طلع فوق التعريف) */
    const m = /^(.*[.!،\p{Extended_Pictographic}])\s+((?:[^.!،؟?\p{Extended_Pictographic}]|ر\.س)*[؟?])\s*$/u.exec(last);
    if (m && m[1].trim()) ls.splice(lastIdx, 1, m[1].trim(), line, m[2].trim()); else ls.splice(lastIdx, 0, line);
    return ls.join("\n").trim();
  }
  return `${String(text || "").trim()}\n${line}`;
}

/* ── ٣) الحد الجاي: أقرب حد رسوم بالفرق بالظبط + صنف واحد بيقفله ─────────────
   cart = { subtotal, option, lines } · ladder = [{ over, fee }] · quote = نتيجة quote_delivery (مع دبوس) أو null · first = card.first
   candidates = أصناف مرشّحة بالترتيب (اقتران العيلة أولاً، بعدين الجانبي/المشروب الأكثر مبيعاً) — كل واحد { id, name, price }
   ⇒ null أو { kind: "next_tier", add_sar, fee_now, fee_then, free, with_code?, located, item, total_now, total_then } */
export function thresholdPlan({ cart, ladder = null, quote = null, first = null, candidates = [], maxGap = 20, inCart = new Set() } = {}) {
  if (!cart || cart.option === "pickup" || !(Number(cart.subtotal) > 0)) return null;
  const t = r2(cart.subtotal);
  const located = Boolean(quote && quote.ok && quote.deliverable === true);
  if (quote && quote.ok && quote.deliverable === false) return null;
  const steps = (Array.isArray(ladder) ? ladder : []).map((x) => ({ over: Number(x.over), fee: Number(x.fee) })).filter((x) => Number.isFinite(x.over) && Number.isFinite(x.fee)).sort((a, b) => a.over - b.over);
  const far = located ? Number(quote.far_zone_extra) || 0 : 0;
  const feeAt = (v) => { const s = [...steps].reverse().find((x) => v >= x.over); return s ? s.fee + (s.fee > 0 || far ? far : 0) : null; };
  /* أول طلب: الكود بيصفّر التوصيل من حده ⇒ لو السلة تحته، ده الحد الجاي */
  const firstOn = Boolean(first && first.eligible && Number(first.from) > 0);
  if (firstOn && t >= Number(first.from)) return null;                  // التوصيل مجاني بالكود أصلاً
  const feeNow = located ? Number(quote.fee) : feeAt(t);
  if (!(feeNow > 0)) return null;
  let target = null, feeThen = null, withCode = null;
  if (firstOn) { target = Number(first.from); feeThen = 0; withCode = String(first.code); }
  else { const up = steps.find((s) => s.over > t && s.fee + (s.fee > 0 ? far : 0) < feeNow); if (up) { target = up.over; feeThen = up.fee + (up.fee > 0 ? far : 0); } }
  if (target === null) return null;
  const gap = r2(target - t);
  if (!(gap > 0) || gap > Number(maxGap)) return null;
  const item = (candidates || []).find((c) => c && Number(c.price) >= gap && !inCart.has(String(c.id))) || null;
  if (!item) return null;
  const totalNow = r2(t + feeNow), totalThen = r2(t + Number(item.price) + feeThen);
  return { kind: "next_tier", add_sar: gap, fee_now: feeNow, fee_then: feeThen, free: feeThen === 0, ...(withCode ? { with_code: withCode } : {}), located, item: { id: String(item.id), name: item.name, price: Number(item.price) }, total_now: totalNow, total_then: totalThen, order_from: target };
}

/* ── ٣ب) S1 — الرسوم مع الاقتراح (١٤/١٠): ترتيب بالأهمية مش بالأرخص، والدرجة اللي مش مجانية بس لو الإضافة بتغطي اللي هينزل ──
   cart · ladder · quote · first = card.first · reward = { free, from, code } (مكافأة توصيل مجاني) · pick = اقتراح القواعد ({ item, qty, total })
   candidates = أصناف بالترتيب (عادته ⇒ الاقتران ⇒ مشروب لكل شخص ⇒ الأكثر مبيعاً) كل واحد { id, name, price, qty, total, via }
   netOnly (tierNetOnly) · allowStep = false لو الاقتراح عادته («زي العادة» مايتبدّلش بدرجة رسوم مش مجانية)
   ⇒ null
     | { cross: true, fee_now, fee_then, free, with_code?, total_now, total_then, order_from }      — الاقتراح نفسه بينزّل الرسوم: نفس السطر بيقولها
     | { kind: "next_tier", rule: "tier", add_sar, fee_now, fee_then, free, with_code?, item, qty, total, total_now, total_then, order_from, usual? }      — التوصيل المجاني قريب / درجة أرخص */
export function feePlan({ cart, ladder = null, quote = null, first = null, reward = null, pick = null, candidates = [], maxGap = 20, inCart = new Set(), netOnly = false, allowStep = true } = {}) {
  if (!cart || cart.option === "pickup" || !(Number(cart.subtotal) > 0)) return null;
  if (quote && quote.ok && quote.deliverable === false) return null;
  const t = r2(cart.subtotal), located = Boolean(quote && quote.ok && quote.deliverable === true);
  const steps = (Array.isArray(ladder) ? ladder : []).map((x) => ({ over: Number(x.over), fee: Number(x.fee) })).filter((x) => Number.isFinite(x.over) && Number.isFinite(x.fee)).sort((a, b) => a.over - b.over);
  const far = located ? Number(quote.far_zone_extra) || 0 : 0;
  const stepFee = (v) => { const s = [...steps].reverse().find((x) => v >= x.over); return s ? s.fee + (s.fee > 0 || far ? far : 0) : null; };
  /* التوصيل المجاني: كود أول طلب (لحده)، مكافأة العميل، أو آخر السلّم. من غير كود أحسن من بكود لما الاتنين ينفعوا. */
  const frees = [];
  if (first && first.eligible && Number(first.from) > 0) frees.push({ from: Number(first.from), code: String(first.code || "FIRST") });
  if (reward && reward.free && reward.code) frees.push({ from: Number(reward.from) || 0, code: String(reward.code) });
  const zero = steps.find((s) => s.fee === 0); if (zero && far === 0) frees.push({ from: zero.over, code: null });
  const freeAt = (v) => frees.filter((f) => v >= f.from).sort((a, b) => (a.code ? 1 : 0) - (b.code ? 1 : 0))[0] || null;
  if (freeAt(t)) return null;                                           // التوصيل مجاني أصلاً
  const feeNow = located ? Number(quote.fee) : stepFee(t);
  if (!(feeNow > 0)) return null;
  const feeAt = (v) => { const f = freeAt(v); return f ? { fee: 0, code: f.code, from: f.from } : { fee: stepFee(v), code: null, from: (steps.filter((s) => v >= s.over).pop() || {}).over }; };
  const tot = (c) => r2(Number(c.total ?? Number(c.price) * (Number(c.qty) || 1)));
  /* (أ) اقتراح القواعد بيعدّي درجة ⇒ نفس السطر بيقول الرسوم الجديدة */
  if (pick && tot(pick) > 0) {
    const v = r2(t + tot(pick)), f = feeAt(v);
    /* مراجعة ١٥/١٠: درجة مش مجانية بصنف أرخص من اللي هينزل من الرسوم = خسارة (المندوب بياخد نفس المبلغ) ⇒ مانذكرش الرسوم (netOnly) */
    const loses = netOnly && f.fee > 0 && tot(pick) < r2(feeNow - f.fee);
    if (Number.isFinite(f.fee) && f.fee < feeNow && !loses) return { cross: true, fee_now: feeNow, fee_then: f.fee, free: f.fee === 0, ...(f.code ? { with_code: f.code } : {}), total_now: r2(t + feeNow), total_then: r2(v + f.fee), order_from: f.from, located };
  }
  const plan = (target, feeThen, code, c) => ({ kind: "next_tier", rule: "tier", add_sar: r2(target - t), fee_now: feeNow, fee_then: feeThen, free: feeThen === 0, ...(code ? { with_code: code } : {}), located,
    item: { id: String(c.id), name: c.name, price: Number(c.price) }, qty: Number(c.qty) || 1, total: tot(c), total_now: r2(t + feeNow), total_then: r2(t + tot(c) + feeThen), order_from: target, ...(c.via === "habit" ? { usual: true } : {}), ...(c.via ? { via: c.via } : {}) });
  /* (ب) التوصيل المجاني في المتناول ⇒ أهم صنف بيوصّله (مش الأرخص) */
  const nf = frees.filter((f) => f.from > t).sort((a, b) => a.from - b.from)[0];
  if (nf && r2(nf.from - t) <= Number(maxGap)) {
    const c = (candidates || []).find((x) => x && tot(x) >= r2(nf.from - t) && !inCart.has(String(x.id)));
    if (c) return plan(nf.from, 0, nf.code, c);
  }
  /* (ج) درجة أرخص (مش مجانية): بس لو مفيش «زي العادة»، والصنف (netOnly) سعره ≥ اللي هينزل من الرسوم */
  if (allowStep) {
    const up = steps.find((s) => s.over > t && stepFee(s.over) < feeNow);
    if (up && r2(up.over - t) <= Number(maxGap)) {
      const fThen = stepFee(up.over), drop = r2(feeNow - fThen), gap = r2(up.over - t);
      const c = (candidates || []).find((x) => x && tot(x) >= gap && (!netOnly || tot(x) >= drop) && !inCart.has(String(x.id)));
      if (c) return plan(up.over, fThen, null, c);
    }
  }
  return null;
}

/* ── ٤) الأزرار: أي سؤال اختيار ⇒ أزرار أو قايمة ──────────────────────────────
   text = الرد النهائي · ctx = { weights: [{ label, price, variant_option_id }] (صنف بالوزن في الدور ده), lang }
   ⇒ { kind, … } أو null. الترتيب: أوزان ⇒ تأكيد ⇒ توصيل/استلام ⇒ كام شخص. */
/* آخر جملة سؤال في الرد (السطر الأخير ممكن يكون فقرة: «… كيلو 155 ر.س. كم شخص أنتم؟» ⇒ «كم شخص أنتم؟») */
const lastQ = (text) => { const ls = String(text || "").split("\n").map((x) => x.trim()).filter(Boolean); const l = ls[ls.length - 1] || ""; if (!/[؟?]\s*$/.test(l)) return ""; const segs = l.split(/(?<=[^\d][.!])\s+/u); return segs[segs.length - 1].trim(); };
export const MODE_Q_RE = /توصيل (ولا|او|أو|أم|ام) (استلام|تستلم)|(استلام|تستلم) (ولا|او|أو|أم|ام) توصيل|delivery or pickup|pickup or delivery|(?:delivered|deliver) or (?:picked up|pick up|pickup|collect)/i;
export const PEOPLE_Q_RE = /كم شخص|لكم شخص|كم عددكم|كم فرد|كم نفر|how many (of you|people)/i;
export const CONFIRM_Q_RE = /[أا]عتمد(ه|ها|هم)?|[أات]جه[ّ]?ز(ه|ها|هم) ?لك|نجه[ّ]?ز(ه|ها|هم)|تبي(ه|ها) نفس|نفس (ال)?طلب|shall i (prepare|get|go ahead)|go ahead\?/i;
export function choiceButtons(text, { weights = null } = {}) {
  const q = lastQ(text); if (!q) return null;
  const nq = normalize(q);
  if (Array.isArray(weights) && weights.length >= 2 && /ثلث|تلت|نص|نصف|كيلو|kilo|half|third|weight|وزن/i.test(nq)) return { kind: "weights", weights: weights.slice(0, 3) };
  if (MODE_Q_RE.test(q) || MODE_Q_RE.test(nq)) return { kind: "mode" };      // «أجهّزه لك توصيل ولا استلام؟» = سؤال توصيل/استلام مش تأكيد
  if (CONFIRM_Q_RE.test(q) || CONFIRM_Q_RE.test(nq)) return { kind: "confirm" };
  if (PEOPLE_Q_RE.test(q) || PEOPLE_Q_RE.test(nq)) return { kind: "people" };
  return null;
}

/* ── ٥) التنسيق ───────────────────────────────────────────────────────────────
   أسماء الأصناف والبوكسات اللي في الرد ⇒ *خط عريض* (أول مرة بس). «الاسم» بين أقواس الاقتباس ⇒ *الاسم*. مفيش تغيير في الكلام نفسه. */
export function boldNames(text, names = []) {
  let out = String(text || "");
  const list = [...new Set((names || []).map((n) => String(n || "").trim()).filter((n) => [...n].length >= 4))].sort((a, b) => b.length - a.length);
  const taken = [];      // [start, end) اتعلّمت
  const inside = (i, j) => taken.some(([a, b]) => i < b && j > a) || /\*[^*\n]*$/.test(out.slice(0, i)) && /^[^*\n]*\*/.test(out.slice(j));
  for (const n of list) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`«?${esc}»?`, "i"); const m = re.exec(out); if (!m) continue;
    const i = m.index, j = i + m[0].length; if (inside(i, j)) continue;
    const before = out[i - 1] || " ", after = out[j] || " ";
    if (/[\p{L}\p{N}]/u.test(m[0][0] === "«" ? " " : before) || /[\p{L}\p{N}]/u.test(m[0].endsWith("»") ? " " : after)) continue;      // جزء من كلمة أطول
    const rep = `*${n === m[0] ? m[0] : m[0].replace(/^«|»$/g, "")}*`;
    out = out.slice(0, i) + rep + out.slice(j);
    for (const tk of taken) if (tk[0] >= j) { tk[0] += rep.length - (j - i); tk[1] += rep.length - (j - i); }
    taken.push([i, i + rep.length]);
  }
  return out;
}
/* سطور قصيرة: سطر أطول من max فيه أكتر من جملة ⇒ كل جملة في سطر. «ريال» ⇒ «ر.س». */
export function formatReply(text, { maxLine = 150 } = {}) {
  const lines = String(text || "").replace(/(\d)\s*(?:ريال|ريالات)(?![\p{L}])/gu, "$1 ر.س").split("\n");
  const out = [];
  for (const l of lines) {
    if ([...l].length <= maxLine) { out.push(l); continue; }
    const parts = l.split(/(?<=[^\d][.!؛])\s+(?=\S)/u);
    if (parts.length > 1) out.push(...parts.map((p) => p.trim()).filter(Boolean)); else out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/* الاقتراح الواحد بقالب ثابت (لو الموديل ماقالهوش): الأرقام كلها من الحساب.
   S1: كل قاعدة بقالبها (نصوص اللوحة): «زي العادة» (sb_usual / sb_usual_qty)، الأرز مع المشاوي بالوزن (sb_rice_weight)، مشروب لكل شخص (sb_drinks_people)،
   بوكس العيلة من غير مشروبات (sb_box_drinks، والعدد مش معروف: sb_drink_each)، الكومبو (sb_combo)، والرسوم: الاقتراح نفسه بينزّل الرسوم (s.tier) أو صنف
   بيوصّل حد (next_tier) — «زي العادة» بـ sb_tier_usual / sb_tier_usual_free. الكمية > ١ ⇒ «الصنف × الكمية» بالإجمالي. */
export function suggestionVars(s) {
  if (!s) return null;
  const qty = Math.max(1, Math.round(Number(s.qty) || 1)), it = s.item || null;
  const label = it ? (qty > 1 ? `${it.name} × ${qty}` : it.name) : null, price = it ? (qty > 1 ? s.total : it.price) : null;
  const tierKey = (x, usual) => (x.free ? (x.with_code ? "sb_tier_first" : usual ? "sb_tier_usual_free" : "sb_tier_free") : usual ? "sb_tier_usual" : "sb_tier");
  const tierVars = (x) => ({ item: label, price, fee_now: x.fee_now, fee_then: x.fee_then, code: x.with_code || "", from: x.order_from, total_now: x.total_now, total_then: x.total_then });
  if (s.kind === "next_tier" && it) return { key: tierKey(s, s.usual === true), vars: tierVars(s), name: it.name };
  if (s.kind === "box_saves") return { key: "sb_box_saves", vars: { box: s.name, price: s.box_price, separate: s.separate }, name: s.name };
  if (s.kind === "pair" && s.box) return { key: "sb_pair_box", vars: { box: s.box.name, price: s.box.price }, name: s.box.name };
  if (!it) return null;
  if (s.tier && s.tier.fee_then < s.tier.fee_now) return { key: tierKey(s.tier, s.personal === true), vars: tierVars(s.tier), name: it.name };
  if (s.rule === "box_drinks" && s.kind === "drink" && s.box_name) return s.people_known === false
    ? { key: "sb_drink_each", vars: { box: s.box_name, item: it.name, price: it.price }, name: it.name }
    : { key: "sb_box_drinks", vars: { box: s.box_name, item: it.name, qty, total: s.total }, name: it.name };
  if (s.personal === true) return qty > 1 ? { key: "sb_usual_qty", vars: { item: it.name, qty, total: s.total }, name: it.name } : { key: "sb_usual", vars: { item: it.name, price: it.price }, name: it.name };
  if (s.rule === "rice_weight") return { key: "sb_rice_weight", vars: { item: it.name, price: it.price }, name: it.name };
  if (s.rule === "drinks_people" && qty > 1) return { key: "sb_drinks_people", vars: { item: it.name, qty, total: s.total }, name: it.name };
  if (s.rule === "combo" && s.contents) return { key: "sb_combo", vars: { item: it.name, contents: s.contents, price: it.price }, name: it.name };
  return { key: "sb_add_item", vars: { item: label, price }, name: it.name };
}
