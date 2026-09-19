/* ═══════════════════════════════════════════════════════════════════════════
   BIZREPORTS — قلب التقارير (عمر، ١٩ سبتمبر ٢٠٢٦).

   كل رقم مبيعات في اللوحة المفروض يطلع من هنا، بنفس القواعد:
   ١. اليوم التشغيلي من bizday.js (١١ الصبح ← ٣ الفجر، القطع التقني ٤ الفجر).
   ٢. طلبات المتجر (الموقع) من shop_orders نفسه — اللي حصّلناه فعلاً (أكل +
      رسوم + إكرامية)، من غير طلبات الاختبار (is_test) وكوبون المالك التجريبي.
      الطلبات دي بتنزل نقطة البيع كـExternal من غير محفظة تطبيق («مرآة»)، فبتتشال
      من جانب نقطة البيع عشان مايتعدّوش مرتين. المرآة بتتعرف بتطابق الوقت (±٢٠
      دقيقة) والمبلغ (±٢ ريال) مع طلب متجر — لو مالقيناش طلب متجر يطابقها، يبقى
      طلب تطبيق لسه مااتعلّمش (فيدأس بتحط المحفظة بعد القفل) وبيتحسب «تطبيق غير
      محدد» بدل ما يختفي.
   ٣. نقطة البيع: فويد/ريفند برّه المبيعات؛ وطلبات كيتا اللي اترجعت بالكامل
      (keeta_payouts) برّه — نفس قاعدة finance.js.
   ٤. القنوات: تطبيق (كل تطبيق لوحده) · المتجر (توصيل/استلام) · الصالة (Dine in)
      · سفري من الكاشير (Take away) · توصيل المطعم من الكاشير (تليفون).
      تحديد التطبيق: order_sources.source_note (فيدأس/الكاشير) ثم محفظة الدفع.
   ٥. العميل الجديد = أول طلب ليه من أي قناة وقع جوّه الفترة — identity.js
      (firstOrderDays) هي المرجع الوحيد. الهوية = الجوال.
   ٦. عمولة التطبيقات من جدول العقود في finance.js (mergeRates/bandFor) بتاريخ
      الطلب نفسه — مش بتاريخ النهارده. أي رقم مبني على افتراض متعلّم.
   ٧. الصرف الإعلاني من ad_spend_hourly (adspend.js) في نفس النافذة بالظبط.

   المسارات (كلها admin، قراءة بس):
     GET /api/reports/biz/range      ?preset|from&to  → الفترة محلولة (للواجهة)
     GET /api/reports/biz/sales      كروت القنوات + الإجمالي + المقارنات + الصرف
     GET /api/reports/biz/pulse      نبض اليوم (نسخة خفيفة من sales لليوم)
     GET /api/reports/biz/indicators المؤشرات والاحتفاظ بالعربي البسيط
     GET /api/reports/biz/reconcile  ?day= مطابقة يوم مع البيانات الخام
═══════════════════════════════════════════════════════════════════════════ */

import { bizDay, bizStart, bizEnd, bizRange, rangeJson, riyadhHour, bizHourIndex, shiftDay, spanDays, DAY_RE, BIZ_TZ, bizDaySql, DEFAULT_WEEK_START } from "./bizday.js";
import { firstOrderDays } from "./identity.js";
import { mergeRates, bandFor, nextBandFor, subsidyFor } from "./finance.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const rate4 = (v) => Math.round(num(v) * 10000) / 10000;
const ratio = (a, b) => (num(b) === 0 ? null : rate4(num(a) / num(b)));
const delta = (cur, base) => (base == null || num(base) === 0 ? null : rate4((num(cur) - num(base)) / num(base)));
const VAT = 0.15;

export const NOT_PAID = ["pending_payment", "expired", "rejected_refunded", "refunded", "refund_failed", "cancelled", "canceled", "payment_failed", "failed", "unpaid"];
export const TEST_COUPONS = ["OMAR-9X4T"];

/* ── التطبيقات ─────────────────────────────────────────────────────────── */
export const APP_LABELS = {
  keeta: "كيتا", hungerstation: "هنقرستيشن", jahez: "جاهز", ninja: "نينجا", toyou: "تو يو",
  mrsool: "مرسول", careem: "كريم", talabat: "طلبات", thechefz: "ذا شيفز", external: "تطبيق غير محدد",
};
const APP_ALIASES = { "hunger station": "hungerstation", hunger: "hungerstation", "to you": "toyou", feedus: "external", "the chefz": "thechefz", chefz: "thechefz" };
export function normApp(v) {
  const s = String(v || "").toLowerCase().trim();
  if (!s) return null;
  return APP_ALIASES[s] || s.replace(/\s+/g, "");
}
export const CHANNEL_LABELS = {
  store: "متجرنا (الموقع)", hall: "الصالة", takeaway: "سفري من الكاشير", own_delivery: "توصيل المطعم (تليفون)",
};
export const channelLabel = (ch) => (ch.startsWith("app:") ? APP_LABELS[ch.slice(4)] || ch.slice(4) : CHANNEL_LABELS[ch] || ch);
export const channelGroup = (ch) => (ch.startsWith("app:") ? "apps" : ch === "store" ? "store" : "restaurant");

/**
 * قناة طلب نقطة بيع. بيرجّع:
 *   null        → مش مبيعات (فويد/ريفند)
 *   "mirror?"   → External من غير أي علامة تطبيق — يا مرآة لطلب متجر يا تطبيق لسه ماتعلّمش
 *   "qr"        → طلب QR-Menu (المتجر القديم قبل ربط الشريك)
 *   "app:<x>" | "hall" | "takeaway" | "own_delivery"
 */
export function classifyPos(o, apps) {
  const type = String(o.order_type || "").toLowerCase();
  if (type.includes("void") || type.includes("refund")) return null;
  const pays = (o.pay_keys || []).map((k) => String(k).toLowerCase());
  const appPay = pays.find((k) => apps.includes(k));
  const note = normApp(o.source_note);
  // تاج «Feedus» لوحده مش دليل: الكاشير/التاجر التلقائي بعد ٤٨ ساعة بيعلّم طلبات
  // المتجر المنعكسة كده برضه (اتشاف على 3923/4024/4028/4043). التطبيق مؤكد بس
  // لو فيه محفظة تطبيق أو اسم تطبيق محدد.
  const noteIsApp = note && note !== "external" && (APP_LABELS[note] || apps.includes(String(o.source_note || "").toLowerCase()));
  if (appPay || noteIsApp) {
    const a = (noteIsApp && note) || normApp(appPay) || "external";
    return `app:${a}`;
  }
  if (type.includes("qr-menu")) return "qr";
  if (type.includes("external")) return "mirror?";
  if (o.source === "delivery_app") return "app:external";
  const opt = String(o.order_option || "").toLowerCase();
  if (opt.includes("dine") || type === "table") return "hall";
  if (opt.includes("deliver") || opt.includes("توصيل")) return "own_delivery";
  return "takeaway";
}

/**
 * يربط طلبات «mirror?» بطلبات المتجر (وقت ±٢٠ دقيقة، مبلغ ±٢ ريال، أقرب
 * وقت الأول). بيرجّع Set فيه order_id اللي طلعت مرايا.
 */
export function matchMirrors(posRows, shopRows, { minutes = 20, sar = 2 } = {}) {
  const cands = posRows.filter((p) => p._ch === "mirror?");
  const used = new Set(), mirrors = new Set();
  const pairs = [];
  for (const p of cands) {
    const pt = new Date(p.ts).getTime();
    for (const s of shopRows) {
      const dt = Math.abs(new Date(s.ts).getTime() - pt) / 60000;
      if (dt > minutes) continue;
      const amounts = [num(s.total), num(s.subtotal), num(s.subtotal) + num(s.delivery_fee)];
      if (!amounts.some((a) => Math.abs(a - num(p.total)) <= sar)) continue;
      pairs.push({ p: p.order_id, s: s.order_no, dt });
    }
  }
  pairs.sort((a, b) => a.dt - b.dt);
  for (const x of pairs) {
    if (mirrors.has(x.p) || used.has(x.s)) continue;
    mirrors.add(x.p); used.add(x.s);
  }
  return mirrors;
}

/** اقتصاديات طلب تطبيق: العمولة/رسوم الدفع/دعم التوصيل حسب عقده في يوم الطلب. */
export function appEconomics(app, day, total, netRaw, rates, basis = "net") {
  const cfg = rates?.[app];
  if (!cfg) return { known: false, base: 0, rate: null, commission: 0, paymentFee: 0, subsidy: 0 };
  const netEx = num(netRaw) > 0 ? num(netRaw) : num(total) / (1 + VAT);
  const base = cfg.commissionBase === "total_after_promo" || basis === "total" ? num(total) : netEx;
  const band = bandFor(cfg, day);
  const rate = num(band.delivery);
  return {
    known: true, base, rate, band: band.outOfContract ? null : { from: band.from, to: band.to, note: band.note || "" },
    outOfContract: !!band.outOfContract,
    commission: base * rate,
    paymentFee: base * num(cfg.paymentFeePct),
    subsidy: subsidyFor(cfg, base).amount,
  };
}

/** افتراضات العمولة لكل تطبيق — بتتعرض جنب الرقم. */
export function appAssumptions(app, rates, basis, day) {
  const cfg = rates?.[app];
  const out = [];
  if (!cfg) {
    out.push("مفيش عقد متسجّل للتطبيق ده — العمولة مش محسوبة (الصافي = الإجمالي). ضيف نسبته من «المالية ← الإعدادات».");
    return out;
  }
  if (cfg.commissionBase !== "total_after_promo") {
    out.push(basis === "total" ? "العمولة محسوبة على المبلغ شامل الضريبة (إعداد يدوي)." : "افتراض: العمولة على المبلغ بدون ضريبة — العقد مابيحددش؛ لو شامل الضريبة العمولة تزيد ١٥٪.");
  }
  if (cfg.subsidyTiers?.length && cfg.subsidyConfirmed === false) out.push("دعم التوصيل (كيتا) مقدّر من طلبات فعلية ولسه مش متأكد من العقد.");
  for (const cv of cfg.caveats || []) out.push(cv);
  out.push("التطبيقات بتنزل نقطة البيع من غير ما نفرّق توصيل/استلام، فكلها بعمولة التوصيل.");
  const nb = nextBandFor(cfg, day);
  if (nb) out.push(`تنبيه: من ${nb.from} النسبة هتبقى ${Math.round(num(nb.delivery) * 100)}٪.`);
  return out;
}

const emptyHourly = () => Array.from({ length: 24 }, (_, i) => ({ hour: (i + 4) % 24, orders: 0, revenue: 0 }));

/**
 * يجمّع صفوف موحّدة ({ch, ts, total, net, ident, day, opt}) في كروت.
 * firsts: Map(ident → أول يوم). range: {from,to}.
 */
export function aggregate(rows, { firsts = new Map(), range, rates = null, basis = "net" } = {}) {
  const cards = new Map();
  const mk = (ch) => ({
    id: ch, label: channelLabel(ch), group: channelGroup(ch),
    orders: 0, revenue: 0, idents: new Map(), unknownOrders: 0,
    hourly: emptyHourly(),
    split: ch === "store" ? { delivery: { orders: 0, revenue: 0 }, pickup: { orders: 0, revenue: 0 } } : null,
    econ: ch.startsWith("app:") ? { base: 0, commission: 0, paymentFee: 0, subsidy: 0, known: true, rates: new Set(), outOfContract: 0 } : null,
  });
  for (const r of rows) {
    if (!cards.has(r.ch)) cards.set(r.ch, mk(r.ch));
    const c = cards.get(r.ch);
    const t = num(r.total);
    c.orders++; c.revenue += t;
    const hi = bizHourIndex(riyadhHour(r.ts));
    c.hourly[hi].orders++; c.hourly[hi].revenue += t;
    if (c.split) { const s = r.opt === "pickup" ? c.split.pickup : c.split.delivery; s.orders++; s.revenue += t; }
    if (r.ident) c.idents.set(r.ident, (c.idents.get(r.ident) || 0) + 1); else c.unknownOrders++;
    if (c.econ) {
      const e = appEconomics(r.ch.slice(4), r.day, t, r.net, rates, basis);
      if (!e.known) c.econ.known = false;
      c.econ.base += e.base; c.econ.commission += e.commission; c.econ.paymentFee += e.paymentFee; c.econ.subsidy += e.subsidy;
      if (e.rate != null) c.econ.rates.add(e.rate);
      if (e.outOfContract) c.econ.outOfContract++;
    }
  }
  const custOf = (idents) => {
    let nw = 0, ret = 0;
    for (const id of idents.keys()) {
      const f = firsts.get(id);
      if (!f || (range && f >= range.from)) nw++; else ret++;
    }
    return { known: idents.size, new: nw, returning: ret };
  };
  const out = [];
  for (const c of cards.values()) {
    const card = {
      id: c.id, label: c.label, group: c.group,
      orders: c.orders, revenue: r2(c.revenue), aov: c.orders ? r2(c.revenue / c.orders) : null,
      customers: { ...custOf(c.idents), unknownOrders: c.unknownOrders },
      hourly: c.hourly.map((h) => ({ ...h, revenue: r2(h.revenue) })),
    };
    if (c.split) {
      for (const k of ["delivery", "pickup"]) {
        const s = c.split[k];
        s.revenue = r2(s.revenue); s.aov = s.orders ? r2(s.revenue / s.orders) : null;
      }
      card.split = c.split;
    }
    if (c.econ) {
      const deductions = c.econ.commission + c.econ.paymentFee + c.econ.subsidy;
      card.commission = {
        known: c.econ.known,
        gross: r2(c.revenue),
        base: r2(c.econ.base),
        ratePct: [...c.econ.rates].sort(),
        effectivePct: ratio(c.econ.commission, c.econ.base),
        commission: r2(c.econ.commission),
        paymentFee: r2(c.econ.paymentFee),
        subsidy: r2(c.econ.subsidy),
        deductions: r2(deductions),
        net: r2(c.revenue - deductions),
        netPctOfGross: ratio(c.revenue - deductions, c.revenue),
        outOfContractOrders: c.econ.outOfContract,
      };
    }
    out.push(card);
  }
  return out;
}

/** الإجمالي فوق الكروت + تقسيم المجموعات. */
export function totalsOf(cards) {
  const t = { orders: 0, revenue: 0, customersKnown: 0, newCustomers: 0, returning: 0, appDeductions: 0 };
  const groups = { store: { orders: 0, revenue: 0 }, apps: { orders: 0, revenue: 0 }, restaurant: { orders: 0, revenue: 0 } };
  const hourly = emptyHourly();
  for (const c of cards) {
    t.orders += c.orders; t.revenue += c.revenue;
    t.newCustomers += c.customers.new; t.returning += c.customers.returning;
    if (c.commission) t.appDeductions += c.commission.deductions;
    groups[c.group].orders += c.orders; groups[c.group].revenue += c.revenue;
    c.hourly.forEach((h, i) => { hourly[i].orders += h.orders; hourly[i].revenue += h.revenue; });
  }
  for (const g of Object.values(groups)) { g.revenue = r2(g.revenue); g.share = ratio(g.revenue, t.revenue); }
  return {
    orders: t.orders, revenue: r2(t.revenue), aov: t.orders ? r2(t.revenue / t.orders) : null,
    // عميل ممكن يطلب من قناتين — العدد هنا مجموع الكروت (تقريب)، والدقيق في `customers` تحت
    newCustomers: t.newCustomers, returningCustomers: t.returning,
    appDeductions: r2(t.appDeductions), netAfterApps: r2(t.revenue - t.appDeductions),
    groups, hourly: hourly.map((h) => ({ ...h, revenue: r2(h.revenue) })),
  };
}

const cmpOf = (cur, base, label) => (base == null ? null : {
  label, orders: base.orders, revenue: r2(base.revenue),
  deltaOrders: delta(cur.orders, base.orders), deltaRevenue: delta(cur.revenue, base.revenue),
});

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, DEFAULT_DELIVERY_APPS } = ctx;
  const spend = () => (typeof deps.adspend === "function" ? deps.adspend() : deps.adspend) || null;

  async function settings() {
    const s = (await getSettingsData()) || {};
    const apps = (Array.isArray(s.deliveryAppMethods) && s.deliveryAppMethods.length ? s.deliveryAppMethods : DEFAULT_DELIVERY_APPS)
      .map((x) => String(x).toLowerCase());
    const ws = Number(s.reportWeekStart);
    return {
      apps,
      weekStart: Number.isInteger(ws) && ws >= 0 && ws <= 6 ? ws : DEFAULT_WEEK_START,
      rates: mergeRates(s.financeRates),
      basis: s.financeCommissionBasis === "total" ? "total" : "net",
      dailyTarget: Number(s.dailyTarget) || 200,
    };
  }

  /* ── تحميل الطلبات الموحّدة لنافذة زمنية ─────────────────────────────── */
  async function loadWindow(startUtc, endUtc, cfg) {
    const pad = 30 * 60e3; // طلبات متجر حوالين الحدود عشان مطابقة المرايا
    const [pos, shop] = await Promise.all([
      pool.query(
        `SELECT o.order_id, o.order_date AS ts, o.order_type, o.order_option, o.total, o.net,
                COALESCE((SELECT array_agg(lower(k)) FROM jsonb_object_keys(COALESCE(o.payments,'{}'::jsonb)) k), '{}') AS pay_keys,
                s.source, s.source_note,
                COALESCE(NULLIF(s.phone_norm, ''), NULLIF(tc.phone_norm, '')) AS ident,
                EXISTS (SELECT 1 FROM keeta_payouts kp WHERE kp.order_id = o.order_id
                          AND jsonb_array_length(COALESCE(kp.refunds,'[]'::jsonb)) > 0
                          AND COALESCE(kp.part_refund, false) = false) AS keeta_reversed
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.order_date >= $1 AND o.order_date < $2`, [startUtc, endUtc]),
      pool.query(
        // طلبات الاختبار بتتحمّل برضه — عشان مرآيتها في نقطة البيع تتشال — بس مابتتحسبش
        `SELECT order_no, created_at AS ts, option, total, subtotal, delivery_fee, tip, coupon,
                NULLIF(phone_norm, '') AS ident, status, attrib_source,
                (is_test IS TRUE OR upper(COALESCE(coupon, '')) = ANY($4::text[])) AS test
           FROM shop_orders
          WHERE created_at >= $1 AND created_at < $2
            AND status <> ALL($3::text[])`,
        [new Date(startUtc.getTime() - pad), new Date(endUtc.getTime() + pad), NOT_PAID, TEST_COUPONS]),
    ]);
    return unify(pos.rows, shop.rows, startUtc, endUtc, cfg);
  }

  function unify(posRows, shopRows, startUtc, endUtc, cfg) {
    for (const p of posRows) p._ch = p.keeta_reversed ? null : classifyPos(p, cfg.apps);
    const mirrors = matchMirrors(posRows, shopRows);
    const s0 = startUtc.getTime(), s1 = endUtc.getTime();
    const rows = [];
    const stats = { mirrors: mirrors.size, unmatchedExternal: 0, qrLegacy: 0, excluded: 0, keetaReversed: 0 };
    for (const p of posRows) {
      if (p.keeta_reversed) { stats.keetaReversed++; continue; }
      if (!p._ch) { stats.excluded++; continue; }
      if (mirrors.has(p.order_id)) continue;
      let ch = p._ch;
      if (ch === "mirror?") { ch = "app:external"; stats.unmatchedExternal++; }
      if (ch === "qr") { ch = "store"; stats.qrLegacy++; }
      rows.push({ src: "pos", id: p.order_id, ch, ts: p.ts, day: bizDay(p.ts), total: num(p.total), net: num(p.net), ident: p.ident || null,
        opt: /deliver|توصيل/i.test(p.order_option || "") ? "delivery" : "pickup" });
    }
    for (const s of shopRows) {
      const t = new Date(s.ts).getTime();
      if (t < s0 || t >= s1) continue;
      if (s.test) { stats.testExcluded = (stats.testExcluded || 0) + 1; continue; }
      rows.push({ src: "store", id: s.order_no, ch: "store", ts: s.ts, day: bizDay(s.ts), total: num(s.total), net: num(s.total) / (1 + VAT),
        ident: s.ident || null, opt: s.option === "pickup" ? "pickup" : "delivery", attrib: s.attrib_source || null });
    }
    return { rows, stats };
  }

  /* أول يوم لكل هوية — القاعدة الموحّدة في identity.js (كل القنوات + المتجر). */
  async function firstDays(idents) {
    return firstOrderDays(pool, idents.filter(Boolean));
  }

  /* ── قلب «المبيعات»: الفترة + المقارنتين + الصرف ───────────────────────── */
  async function salesData(range, cfg) {
    const [cur, prev, lw] = await Promise.all([
      loadWindow(range.startUtc, range.cutUtc, cfg),
      loadWindow(range.prev.startUtc, range.prev.cutUtc, cfg),
      loadWindow(range.lastWeek.startUtc, range.lastWeek.cutUtc, cfg),
    ]);
    const firsts = await firstDays(cur.rows.map((r) => r.ident));
    const opts = { firsts, range, rates: cfg.rates, basis: cfg.basis };
    const cards = aggregate(cur.rows, opts);
    const pCards = aggregate(prev.rows, { rates: cfg.rates, basis: cfg.basis });
    const lCards = aggregate(lw.rows, { rates: cfg.rates, basis: cfg.basis });
    // كل قناة ظهرت في أي فترة + كيتا وهنقرستيشن دايماً (حتى لو صفر)
    const ids = new Set([...cards, ...pCards, ...lCards].map((c) => c.id));
    for (const must of ["store", "hall", "takeaway", "app:keeta", "app:hungerstation"]) ids.add(must);
    const byId = (list) => new Map(list.map((c) => [c.id, c]));
    const cM = byId(cards), pM = byId(pCards), lM = byId(lCards);
    const zero = (id) => ({ id, label: channelLabel(id), group: channelGroup(id), orders: 0, revenue: 0, aov: null,
      customers: { known: 0, new: 0, returning: 0, unknownOrders: 0 }, hourly: emptyHourly(),
      ...(id === "store" ? { split: { delivery: { orders: 0, revenue: 0, aov: null }, pickup: { orders: 0, revenue: 0, aov: null } } } : {}),
      ...(id.startsWith("app:") ? { commission: { known: !!cfg.rates[id.slice(4)], gross: 0, base: 0, ratePct: [], effectivePct: null, commission: 0, paymentFee: 0, subsidy: 0, deductions: 0, net: 0, netPctOfGross: null, outOfContractOrders: 0 } } : {}) });
    const ORDER = (c) => (c.id === "store" ? 0 : c.group === "apps" ? 1 : c.id === "hall" ? 2 : c.id === "takeaway" ? 3 : 4);
    const out = [...ids].map((id) => {
      const c = cM.get(id) || zero(id);
      const p = pM.get(id) || { orders: 0, revenue: 0 };
      const l = lM.get(id) || { orders: 0, revenue: 0 };
      const card = { ...c, compare: { prev: cmpOf(c, p, range.prev.label), lastWeek: cmpOf(c, l, range.lastWeek.label) } };
      if (id.startsWith("app:")) {
        const a = id.slice(4);
        const band = cfg.rates[a] ? bandFor(cfg.rates[a], range.to) : null;
        card.contract = cfg.rates[a] ? {
          currentRatePct: band && !band.outOfContract ? num(band.delivery) : null,
          paymentFeePct: num(cfg.rates[a].paymentFeePct),
          note: band?.note || "",
        } : null;
        card.assumptions = appAssumptions(a, cfg.rates, cfg.basis, range.to);
        if (c.commission && p) card.compare.prevNet = p.commission ? r2(p.commission.net) : null;
      }
      return card;
    }).sort((a, b) => ORDER(a) - ORDER(b) || b.revenue - a.revenue);

    const totals = totalsOf(cards);
    const pT = totalsOf(pCards), lT = totalsOf(lCards);
    // عدد العملاء الفعلي (بدون تكرار بين القنوات)
    const uniq = new Set(cur.rows.map((r) => r.ident).filter(Boolean));
    let nw = 0; for (const id of uniq) { const f = firsts.get(id); if (!f || f >= range.from) nw++; }
    totals.customers = { known: uniq.size, new: nw, returning: uniq.size - nw, unknownOrders: cur.rows.filter((r) => !r.ident).length };
    totals.compare = { prev: cmpOf(totals, pT, range.prev.label), lastWeek: cmpOf(totals, lT, range.lastWeek.label) };

    let ads = null;
    const sp = spend();
    if (sp) {
      try {
        const [a, ap, al] = await Promise.all([
          sp.spendInWindow(range.startUtc, range.cutUtc),
          sp.spendInWindow(range.prev.startUtc, range.prev.cutUtc),
          sp.spendInWindow(range.lastWeek.startUtc, range.lastWeek.cutUtc),
        ]);
        const store = cM.get("store") || { orders: 0, revenue: 0 };
        ads = {
          ...a,
          shareOfRevenue: ratio(a.total, totals.revenue),
          costPerStoreOrder: store.orders ? r2(a.web / store.orders) : null,
          storeRoas: a.web ? r2(store.revenue / a.web) : null,
          compare: {
            prev: { label: range.prev.label, total: ap.total, delta: delta(a.total, ap.total) },
            lastWeek: { label: range.lastWeek.label, total: al.total, delta: delta(a.total, al.total) },
          },
          note: "الصرف متقسّم ساعة بساعة على نفس نافذة الطلبات (يوم ميتا على توقيت لوس أنجلوس اتحوّل لليوم التشغيلي بتاعنا).",
        };
      } catch (e) { ads = { error: e.message }; }
    }
    return { cards: out, totals, ads, stats: cur.stats };
  }

  const rangeOf = (c, cfg) => bizRange({ preset: c.req.query("preset"), from: c.req.query("from") || c.req.query("date"), to: c.req.query("to") || c.req.query("date"), weekStart: cfg.weekStart });

  app.get("/api/reports/biz/range", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await settings();
    return c.json({ ok: true, range: rangeJson(rangeOf(c, cfg)) });
  });

  app.get("/api/reports/biz/sales", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const cfg = await settings();
      const range = rangeOf(c, cfg);
      const d = await salesData(range, cfg);
      return c.json({ ok: true, range: rangeJson(range), ...d,
        notes: [
          `اليوم التشغيلي ${range.window} — طلب الساعة ١ بالليل بيتحسب على اليوم اللي قبله.`,
          "المتجر = اللي حصّلناه فعلاً (أكل + رسوم توصيل + إكرامية)، من غير طلبات الاختبار.",
          "التطبيقات: «قبل» = اللي دفعه العميل، «بعد» = بعد العمولة ورسوم الدفع ودعم التوصيل حسب العقد بتاريخ كل طلب.",
          range.partial ? "الفترة لسه شغّالة: المقارنات متقطوعة عند نفس الساعة (يوم ناقص قدام يوم ناقص)." : null,
        ].filter(Boolean) });
    } catch (e) {
      console.error("[bizreports] sales:", e.message);
      return c.json({ ok: false, error: e.message });
    }
  });

  /* نبض اليوم — نفس salesData لليوم الحالي، مختصر. */
  app.get("/api/reports/biz/pulse", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const cfg = await settings();
      const range = bizRange({ preset: "today", weekStart: cfg.weekStart });
      const d = await salesData(range, cfg);
      const store = d.cards.find((x) => x.id === "store");
      return c.json({
        ok: true, range: rangeJson(range), target: cfg.dailyTarget,
        store: { orders: store?.orders || 0, revenue: store?.revenue || 0, split: store?.split || null, compare: store?.compare || null },
        totals: d.totals,
        channels: d.cards.filter((x) => x.orders > 0 || x.compare?.prev?.orders > 0)
          .map((x) => ({ id: x.id, label: x.label, group: x.group, orders: x.orders, revenue: x.revenue, deltaOrders: x.compare?.lastWeek?.deltaOrders ?? null })),
        ads: d.ads, stats: d.stats,
      });
    } catch (e) {
      console.error("[bizreports] pulse:", e.message);
      return c.json({ ok: false, error: e.message });
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     المؤشرات والاحتفاظ — كل الطلبات من أول التاريخ (بالهوية)، وكل مؤشر معاه
     شرح بالعربي: معناه إيه، إمتى يبقى كويس، واتجاهه قدام الفترة اللي قبلها.
  ═════════════════════════════════════════════════════════════════════ */
  let allCache = { at: 0, data: null };
  async function allOrders(cfg) {
    if (allCache.data && Date.now() - allCache.at < 120_000) return allCache.data;
    const start = new Date("2020-01-01T00:00:00Z"), end = new Date(Date.now() + 3600e3);
    const { rows } = await loadWindow(start, end, cfg);
    // تاريخ أقدم من الكاش: أول طلب مسجّل على بطاقة العميل في تاب سينس
    const hist = (await pool.query(
      `SELECT phone_norm AS pn, min(first_order_at) AS f FROM ts_customers
        WHERE COALESCE(phone_norm,'') <> '' AND first_order_at IS NOT NULL GROUP BY 1`)).rows; // identity.js: التسجيل مش طلب
    const histFirst = new Map(hist.map((h) => [h.pn, bizDay(h.f)]));
    allCache = { at: Date.now(), data: { rows, histFirst } };
    return allCache.data;
  }

  app.get("/api/reports/biz/indicators", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const cfg = await settings();
      const range = rangeOf(c, cfg);
      const { rows, histFirst } = await allOrders(cfg);
      return c.json({ ok: true, range: rangeJson(range), ...indicators(rows, histFirst, range) });
    } catch (e) {
      console.error("[bizreports] indicators:", e.message);
      return c.json({ ok: false, error: e.message });
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     مطابقة يوم مع الخام: كل رقم في «مبيعات اليوم» جنبه مصدره.
  ═════════════════════════════════════════════════════════════════════ */
  app.get("/api/reports/biz/reconcile", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const cfg = await settings();
      const day = DAY_RE.test(String(c.req.query("day") || "")) ? c.req.query("day") : shiftDay(bizDay(new Date()), -1);
      const s = bizStart(day), e = bizEnd(day);
      const [shopRaw, posRaw, posCal] = await Promise.all([
        pool.query(`SELECT status, option, is_test, count(*)::int n, COALESCE(sum(total),0)::float rev FROM shop_orders
                     WHERE created_at >= $1 AND created_at < $2 GROUP BY 1,2,3 ORDER BY 1`, [s, e]),
        pool.query(`SELECT order_type, order_option, COALESCE((SELECT string_agg(k, '+') FROM jsonb_object_keys(COALESCE(payments,'{}'::jsonb)) k), '—') pays,
                           count(*)::int n, COALESCE(sum(total),0)::float rev FROM ts_orders
                     WHERE order_date >= $1 AND order_date < $2 GROUP BY 1,2,3 ORDER BY 4 DESC`, [s, e]),
        pool.query(`SELECT count(*)::int n, COALESCE(sum(total),0)::float rev,
                           count(*) FILTER (WHERE ${bizDaySql("order_date")} <> calendar_day)::int AS differ
                      FROM ts_orders WHERE calendar_day = $1::date`, [day]),
      ]);
      const range = bizRange({ from: day, to: day, weekStart: cfg.weekStart });
      const d = await salesData(range, cfg);
      let spendRaw = null, campaigns = null;
      const sp = spend();
      if (sp) {
        campaigns = await sp.campaignsInWindow(s, e);
        spendRaw = (await pool.query(`SELECT platform, src_day, ok, rows, spend::float, error, fetched_at FROM ad_spend_sync
                                        WHERE src_day BETWEEN $1::date - 1 AND $1::date ORDER BY 1,2`, [day]).catch(() => ({ rows: [] }))).rows;
      }
      return c.json({
        ok: true, day, window: { startUtc: s.toISOString(), endUtc: e.toISOString(), riyadh: `${day} 04:00 → ${shiftDay(day, 1)} 04:00` },
        report: { cards: d.cards.map((x) => ({ id: x.id, label: x.label, orders: x.orders, revenue: x.revenue, split: x.split || null, commission: x.commission || null })), totals: d.totals, ads: d.ads, stats: d.stats },
        raw: { shopOrders: shopRaw.rows, posByType: posRaw.rows, posCalendarDay: posCal.rows[0], adSpendSync: spendRaw, campaigns },
      });
    } catch (e) {
      console.error("[bizreports] reconcile:", e.message);
      return c.json({ ok: false, error: e.message });
    }
  });

  return { salesData, loadWindow, settings, firstDays };
}

/* ═══════════════════════════════════════════════════════════════════════════
   المؤشرات — صافية (متختبرة). rows = كل الطلبات الموحّدة، histFirst = أول يوم
   من بطاقة العميل في تاب سينس (لتاريخ أقدم من الكاش).
═══════════════════════════════════════════════════════════════════════════ */
const firstChannelGroup = (ch) => (ch === "store" ? "store" : ch.startsWith("app:") ? ch : ch === "hall" ? "hall" : ch === "takeaway" ? "takeaway" : "restaurant");
const FIRST_LABEL = (g) => (g === "store" ? "المتجر (الموقع)" : g === "hall" ? "الصالة" : g === "takeaway" ? "سفري" : g === "restaurant" ? "المطعم (أخرى)" : channelLabel(g));
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);

export function indicators(rows, histFirst = new Map(), range) {
  // خط زمني لكل عميل
  const byId = new Map();
  for (const r of rows) {
    if (!r.ident) continue;
    if (!byId.has(r.ident)) byId.set(r.ident, []);
    byId.get(r.ident).push(r);
  }
  for (const list of byId.values()) list.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const firstDay = (id) => {
    const l = byId.get(id); const h = histFirst.get(id);
    const f = l?.[0]?.day || null;
    return h && (!f || h < f) ? h : f;
  };

  function windowStats(from, to) {
    const inWin = rows.filter((r) => r.day >= from && r.day <= to);
    const known = inWin.filter((r) => r.ident);
    const ids = new Set(known.map((r) => r.ident));
    let nw = 0, ret = 0, multi = 0;
    const perId = new Map();
    for (const r of known) perId.set(r.ident, (perId.get(r.ident) || 0) + 1);
    for (const id of ids) { const f = firstDay(id); if (!f || f >= from) nw++; else ret++; if (perId.get(id) > 1) multi++; }
    const revenue = inWin.reduce((s, r) => s + r.total, 0);
    const returningRev = known.filter((r) => { const f = firstDay(r.ident); return f && f < from; }).reduce((s, r) => s + r.total, 0);
    return {
      orders: inWin.length, revenue: r2(revenue), aov: inWin.length ? r2(revenue / inWin.length) : null,
      customers: ids.size, newCustomers: nw, returningCustomers: ret,
      returningShare: ratio(ret, ids.size),
      multiOrderShare: ratio(multi, ids.size),
      ordersPerCustomer: ids.size ? rate4(known.length / ids.size) : null,
      returningRevenueShare: ratio(returningRev, known.reduce((s, r) => s + r.total, 0)),
      identifiedShare: ratio(known.length, inWin.length),
      storeShare: ratio(inWin.filter((r) => r.ch === "store").length, inWin.length),
      appsShare: ratio(inWin.filter((r) => r.ch.startsWith("app:")).length, inWin.length),
    };
  }
  const cur = windowStats(range.from, range.to);
  const prev = windowStats(range.prev.from, range.prev.to);

  // وقت الطلب التاني + رجوع ٣٠ يوم — للي أول طلب ليهم (في تاريخنا) ما بين ١٨٠ يوم قبل نهاية الفترة ونهايتها
  const asOf = range.to;
  const cohortFrom = shiftDay(asOf, -180);
  const secondDays = [];
  let mature30 = 0, back30 = 0;
  const byFirst = new Map();
  for (const [id, list] of byId) {
    const f = firstDay(id);
    if (!f || f < cohortFrom || f > asOf) continue;
    if (histFirst.get(id) && histFirst.get(id) < list[0].day) continue; // أول طلب أقدم من الكاش — مش هنعرف قناته
    const upto = list.filter((r) => r.day <= asOf);
    const g = firstChannelGroup(upto[0].ch);
    if (!byFirst.has(g)) byFirst.set(g, { group: g, label: FIRST_LABEL(g), customers: 0, mature30: 0, back30: 0, mature60: 0, back60: 0, everBack: 0, orders: 0, secondDays: [] });
    const b = byFirst.get(g);
    b.customers++; b.orders += upto.length;
    const second = upto.find((r, i) => i > 0 && r.day > upto[0].day);
    const age = dayDiff(f, asOf);
    if (second) { const dd = dayDiff(f, second.day); secondDays.push(dd); b.secondDays.push(dd); b.everBack++; }
    if (age >= 30) { mature30++; b.mature30++; if (second && dayDiff(f, second.day) <= 30) { back30++; b.back30++; } }
    if (age >= 60) { b.mature60++; if (second && dayDiff(f, second.day) <= 60) b.back60++; }
  }
  const byFirstChannel = [...byFirst.values()].map((b) => ({
    group: b.group, label: b.label, customers: b.customers,
    return30: ratio(b.back30, b.mature30), mature30: b.mature30,
    return60: ratio(b.back60, b.mature60), mature60: b.mature60,
    everReturned: ratio(b.everBack, b.customers),
    ordersPerCustomer: b.customers ? rate4(b.orders / b.customers) : null,
    medianDaysToSecond: median(b.secondDays),
  })).sort((a, b) => b.customers - a.customers);

  // كوهورتات شهرية (آخر ٦ شهور) بأول طلب
  const months = new Map();
  for (const [id, list] of byId) {
    const f = firstDay(id); if (!f) continue;
    const m = f.slice(0, 7);
    if (!months.has(m)) months.set(m, { month: m, size: 0, m30: 0, r30: 0, m60: 0, r60: 0, m90: 0, r90: 0 });
    const co = months.get(m); co.size++;
    const second = list.find((r) => r.day > f);
    const age = dayDiff(f, asOf);
    for (const w of [30, 60, 90]) {
      if (age >= w) { co[`m${w}`]++; if (second && dayDiff(f, second.day) <= w) co[`r${w}`]++; }
    }
  }
  const cohorts = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).slice(-6)
    .map((co) => ({ month: co.month, size: co.size, retained30: ratio(co.r30, co.m30), retained60: ratio(co.r60, co.m60), retained90: ratio(co.r90, co.m90) }));

  const metric = (key, label, value, prevV, { fmt = "num", better = "up", good, ok, explain, goodIf }) => {
    const d = value == null || prevV == null ? null : (fmt === "pct" ? rate4(value - prevV) : delta(value, prevV));
    const trend = d == null || Math.abs(d) < 0.02 ? "flat" : d > 0 ? "up" : "down";
    let verdict = null;
    if (value != null && good != null) {
      const v = value;
      verdict = better === "up" ? (v >= good ? "good" : v >= ok ? "ok" : "bad") : (v <= good ? "good" : v <= ok ? "ok" : "bad");
    }
    return { key, label, value, prev: prevV, delta: d, deltaKind: fmt === "pct" ? "points" : "relative", trend, better,
      trendIsGood: trend === "flat" ? null : (trend === "up") === (better === "up"), verdict, fmt, explain, goodIf };
  };
  const medSecond = median(secondDays);
  const kpis = [
    metric("revenue", "الإيراد", cur.revenue, prev.revenue, { fmt: "sar", explain: "كل الفلوس اللي دخلت من كل القنوات (شامل الضريبة) في الفترة.", goodIf: "يطلع مع الوقت." }),
    metric("orders", "عدد الطلبات", cur.orders, prev.orders, { explain: "كل الطلبات: المتجر + التطبيقات + الصالة + السفري.", goodIf: "يطلع مع الوقت — الهدف ٢٠٠ طلب متجر في اليوم." }),
    metric("aov", "متوسط الطلب", cur.aov, prev.aov, { fmt: "sar", explain: "الإيراد ÷ عدد الطلبات. العميل بيدفع كام في المرة.", goodIf: "يطلع = العميل بيزوّد في السلة (باقات، إضافات)." }),
    metric("newCustomers", "عملاء جداد", cur.newCustomers, prev.newCustomers, { explain: "عملاء أول طلب ليهم في تاريخنا كله وقع جوّه الفترة (بالجوال).", goodIf: "يطلع = الإعلانات والتسويق بيجيبوا ناس جديدة." }),
    metric("returningShare", "نسبة العملاء الراجعين", cur.returningShare, prev.returningShare, { fmt: "pct", good: 0.4, ok: 0.25, explain: "من كل العملاء المعروفين اللي طلبوا في الفترة، كام واحد كان طلب قبل كده.", goodIf: "فوق ٤٠٪ ممتاز، ٢٥–٤٠٪ مقبول، تحت ٢٥٪ يعني بنجيب ناس ومش بيرجعوا." }),
    metric("multiOrderShare", "طلبوا أكتر من مرة في الفترة", cur.multiOrderShare, prev.multiOrderShare, { fmt: "pct", good: 0.2, ok: 0.1, explain: "نسبة العملاء اللي طلبوا مرتين أو أكتر جوّه نفس الفترة (بتفرق على الفترات الطويلة).", goodIf: "في ٣٠ يوم: فوق ٢٠٪ ممتاز." }),
    metric("ordersPerCustomer", "طلبات لكل عميل", cur.ordersPerCustomer, prev.ordersPerCustomer, { explain: "متوسط عدد الطلبات للعميل المعروف في الفترة.", goodIf: "يطلع = العميل بيرجع أكتر." }),
    metric("return30", "رجعوا خلال ٣٠ يوم من أول طلب", ratio(back30, mature30), null, { fmt: "pct", good: 0.3, ok: 0.15, explain: `من العملاء اللي أول طلب ليهم في آخر ١٨٠ يوم (وعدّى عليه ٣٠ يوم — ${mature30} عميل)، كام واحد طلب تاني خلال شهر.`, goodIf: "فوق ٣٠٪ ممتاز لمطعم، ١٥–٣٠٪ مقبول، أقل من كده محتاج حملة رجوع (SMS/كوبون تاني طلب)." }),
    metric("daysToSecond", "متوسط الأيام لحد الطلب التاني", medSecond, null, { better: "down", good: 14, ok: 30, explain: `الوسيط: نص العملاء اللي رجعوا طلبوا تاني في أقل من كده (${secondDays.length} عميل).`, goodIf: "أقل من أسبوعين ممتاز. ده الوقت الصح لرسالة «وحشتنا»." }),
    metric("returningRevenueShare", "إيراد العملاء الراجعين", cur.returningRevenueShare, prev.returningRevenueShare, { fmt: "pct", good: 0.5, ok: 0.3, explain: "من إيراد العملاء المعروفين، كام في المية جاي من ناس طلبوا قبل كده.", goodIf: "فوق ٥٠٪ = بيزنس ثابت مش معتمد على إعلانات بس." }),
    metric("storeShare", "نصيب المتجر من الطلبات", cur.storeShare, prev.storeShare, { fmt: "pct", explain: "طلبات الموقع ÷ كل الطلبات. الموقع مفيش عليه عمولة تطبيقات.", goodIf: "يطلع = بنسحب العملاء من التطبيقات لمتجرنا." }),
    metric("identifiedShare", "طلبات معروف صاحبها", cur.identifiedShare, prev.identifiedShare, { fmt: "pct", good: 0.7, ok: 0.5, explain: "كام طلب عليه جوال نعرف بيه العميل. هنقرستيشن بيخفي الجوال، والصالة محتاجة الكاشير يسجّل.", goodIf: "كل ما يعلى كل المؤشرات اللي فوق تبقى أدق." }),
  ];
  return {
    kpis, current: cur, previous: prev, byFirstChannel, cohorts,
    notes: [
      "العميل = رقم جوال. الطلبات من غير جوال (أغلب الصالة وهنقرستيشن) مش داخلة في مؤشرات العملاء.",
      "«رجع» = عمل طلب في يوم تشغيلي تاني بعد أول يوم.",
      "الأسهم: أخضر = الاتجاه في صالحنا، أحمر = ضدنا، بمقارنة الفترة اللي قبلها بنفس الطول.",
    ],
  };
}

export default { register };
