/* ═══════════════════════════════════════════════════════════════════════════
   FINANCE — the real profit picture per delivery app and for the restaurant.

   Registered by index.js via `register(app, ctx)`. Everything is admin-only.
   Only two writes exist: PUT /settings (merges finance keys into the settings
   blob) and PUT /item-costs (upserts real per-item costs).

   ── THE FIVE RULES THIS FILE IS BUILT ON ────────────────────────────────────

   1. VAT IS NOT REVENUE AND NOT A COST. TabSense stores `gross`/`discount`/
      `net`/`tax` EXCLUDING VAT and `gross_incl`/`discount_incl`/`total`
      INCLUDING it (`gross_incl - discount_incl = total` held for 1474/1474
      orders probed). Every margin in this module is computed VAT-EXCLUSIVE:
      the 15% we collect belongs to ZATCA, not to Fresh Cuts, so counting it as
      revenue would inflate every margin by roughly 15%.

      MEASURED VAT RATE: avg(total/net) across 2077 real orders = 1.14994 → 15%.

   2. `net` IS NOT ALWAYS POPULATED — THIS IS THE BIGGEST TRAP IN THE DATA.
      The `net`/`tax`/`gross_incl`/`discount_incl` columns were ALTER-added
      later, so they are empty for older rows. Probed on 2026-08-01:
         2026-04: 78/78 orders with net = 0      2026-06: 628/649 missing
         2026-05: 660/660 missing                2026-07: 10/836 missing
      A naive `sum(net)` would therefore report April and May as ZERO revenue
      and every commission on them as ZERO. So every VAT-exclusive figure here
      falls back to `total / 1.15`, and each order carries a `netEstimated`
      flag. The response reports how many orders used the fallback.

   3. COMMISSION IS MODELLED ON THE VAT-EXCLUSIVE ORDER VALUE (`net`).
      The three signed contracts quote their percentages on "order value".
      We read that as the VAT-exclusive value the merchant actually bills, so
      the base is NET_EX (after discount, before VAT). THIS ASSUMPTION IS
      MATERIAL: on a SAR 220.79 order it is the difference between a SAR 34.56
      and a SAR 39.74 commission — a 15% swing on the single largest cost line
      after food. It is stated in the API response (`assumptions`) and printed
      on the UI, and `commissionBasis` in settings can flip it to "total".

   4. THE FOOD COST BASE IS THE PRE-DISCOUNT MENU VALUE, NOT THE NET.
      A 25%-off order costs the kitchen exactly what a full-price one costs.
      Applying the blended 43% to `net` would make discounts look free. So the
      blended rate is applied to GROSS_EX (pre-discount, VAT-exclusive) and the
      discount lands where it belongs — on the revenue side.

   5. THE BUSINESS DAY IS `calendar_day`. TabSense rolls the day at 04:00
      Riyadh; it is never re-derived here. Voids and refunds are excluded.

   ── FOOD COST: MEASURED VS ASSUMED ─────────────────────────────────────────
   Omar's TabSense menu says 43% blended food cost. That is ONE number applied
   to a menu of 267 distinct items, so it is an assumption, not a measurement.
   The engine is built so real per-item costs replace it incrementally without
   any rewrite:

     for each order:
       measuredCost   = Σ (item_costs.cost × qty)  for items that HAVE a cost
       coveredValueEx = Σ (item.amount)/1.15       for those same items
       uncoveredEx    = max(GROSS_EX − coveredValueEx, 0)
       foodCost       = measuredCost + blendedRate × uncoveredEx

   With zero rows in `item_costs` that degrades exactly to "43% of everything",
   which is today's behaviour. Every response carries `foodCostMeasuredShare`
   — the fraction of the food-cost figure that came from a real per-item cost —
   so nobody can mistake the assumption for a measurement.

   NOTE ON `ts_order_items.amount`: it is VAT-INCLUSIVE and pre-discount.
   Verified — order 1685's seven lines sum to 295.98 against gross_incl 295.989
   (665 of 793 probed orders match gross_incl within SAR 0.5; only 42 match the
   VAT-exclusive `gross`). Hence the /1.15 above. `item_costs.cost` is entered
   VAT-EXCLUSIVE, because a cost of goods has no output VAT in it.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const VAT_RATE = 0.15;              // measured, see rule 1
const DEFAULT_FOOD_COST_PCT = 0.43; // Omar's TabSense blended figure

/* Voids/refunds never happened. Same predicate as analytics.js. */
const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

/* VAT-exclusive money, with the rule-2 fallback chain baked in. */
const NET_EX = `COALESCE(NULLIF(o.net,0), NULLIF(o.total,0)/${1 + VAT_RATE}, 0)`;
const GROSS_EX = `COALESCE(NULLIF(o.gross,0), NULLIF(o.gross_incl,0)/${1 + VAT_RATE}, NULLIF(o.total,0)/${1 + VAT_RATE}, 0)`;

/* ═══════════════════════════════════════════════════════════════════════════
   CONTRACT RATE TABLE — the documented defaults from the three signed
   agreements. Everything here is overridable through PUT /api/finance/settings
   (settings.financeRates); these constants are only the fallback.

   TIME BANDS ARE THE POINT. Two of the three contracts step their rate on a
   date, so the engine must pick the band by THE ORDER'S OWN calendar_day —
   never by "today". Ninja stepped 10% → 16% on 2026-07-23 and HungerStation
   steps 10% → 18% on 2026-10-01; a report run in November over a July window
   has to still say 10% for July.
═══════════════════════════════════════════════════════════════════════════ */
export const DEFAULT_RATES = {
  keeta: {
    label: "كيتا",
    labelEn: "Keeta",
    // Flat, no time band in the contract we hold.
    bands: [{
      from: "2000-01-01", to: null,
      delivery: 0.18, pickup: 0.03,
      // The 18% is contractually two lines; kept split so the P&L can show why.
      components: { dataService: 0.08, deliveryService: 0.10 },
      note: "١٨٪ توصيل = ٨٪ خدمة بيانات + ١٠٪ خدمة توصيل · ٣٪ استلام من الفرع",
    }],
    paymentFeePct: 0.025,
    minServiceFeeSar: 1,      // minimum service fee per order
    monthlySubscriptionSar: 0, // contract: subscription exempt
    subscriptionFrom: null,
    /* MERCHANT-FUNDED DELIVERY SUBSIDY — CONFIRM WITH OMAR BEFORE TRUSTING.
       The signed PDF is Arabic/RTL and its table extracts with the value and
       the threshold paired ambiguously, so the mapping below is our best read
       of it, NOT a verified fact. It is configurable for exactly that reason
       and `subsidyConfirmed:false` makes the UI show it as unconfirmed.
       On a 30-day Keeta window this line is worth several hundred riyals, so
       it is not a rounding error — get it confirmed. */
    subsidyTiers: [
      { upTo: 30, amountSar: 4 },
      { upTo: 35, amountSar: 9 },
      { upTo: 45, amountSar: 11 },
      { upTo: 55, amountSar: 12 },
      { upTo: 70, amountSar: 15 },
    ],
    // The contract's table stops at 70. We do NOT invent a band above it —
    // default 0 and say so, rather than silently extrapolating SAR 15.
    subsidyAboveTopSar: 0,
    subsidyConfirmed: false,
    oneOffsHint: "جهاز نقاط بيع ٥٠٠ ر.س + تصوير ٥٠٠ ر.س (مرة واحدة — أضفهما في الإعدادات بتاريخهما)",
    caveats: [],
  },

  hungerstation: {
    label: "هنقرستيشن",
    labelEn: "HungerStation",
    // Contract OQ-0010703967, effective 01/07/2026. Time-banded delivery rate.
    bands: [
      { from: "2026-07-01", to: "2026-09-30", delivery: 0.10, pickup: 0.21, note: "عمولة توصيل تمهيدية ١٠٪ حتى ٣٠/٠٩/٢٠٢٦" },
      { from: "2026-10-01", to: "2027-06-30", delivery: 0.18, pickup: 0.21, note: "١٨٪ من ٠١/١٠/٢٠٢٦ حتى ٣٠/٠٦/٢٠٢٧" },
      { from: "2027-07-01", to: null, delivery: 0.21, pickup: 0.21, note: "٢١٪ من ٠١/٠٧/٢٠٢٧" },
    ],
    paymentFeePct: 0.025,
    minServiceFeeSar: 0,
    monthlySubscriptionSar: 200,
    subscriptionFrom: "2026-07-01",
    subsidyTiers: [],
    subsidyAboveTopSar: 0,
    subsidyConfirmed: true,
    // Pickup-only promo: customer gets >=20% off, merchant bears up to SAR 2.5.
    // We hold ZERO pickup orders (see PICKUP note below) so this never fires
    // today; it is modelled so it will be right the day pickup starts.
    pickupPromoMerchantCapSar: 2.5,
    caveats: [],
  },

  ninja: {
    label: "نينجا",
    labelEn: "Ninja",
    // Subscription agreement dated 22/04/2026. Time-banded service fee.
    bands: [
      { from: "2026-04-22", to: "2026-07-22", delivery: 0.10, pickup: 0.10, note: "رسوم خدمة ١٠٪ من ٢٢/٠٤/٢٠٢٦ حتى ٢٢/٠٧/٢٠٢٦" },
      { from: "2026-07-23", to: null, delivery: 0.16, pickup: 0.16, note: "رسوم خدمة ١٦٪ من ٢٣/٠٧/٢٠٢٦" },
    ],
    paymentFeePct: 0.025,
    minServiceFeeSar: 0,
    monthlySubscriptionSar: 0,
    subscriptionFrom: null,
    subsidyTiers: [],
    subsidyAboveTopSar: 0,
    subsidyConfirmed: true,
    caveats: [
      // Surfaced in the UI — the terms below may not be the final ones.
      "نسختنا من عقد نينجا مكتوب على كل صفحة فيها «Incomplete» — البنود دي ممكن ما تكونش النهائية، راجعها قبل ما تبني عليها قرار.",
    ],
  },

  // In-restaurant orders. Card-machine fees are NOT in any contract we hold,
  // so the default is 0 rather than a guess; set it once Omar has the rate.
  restaurant: {
    label: "المطعم (بدون تطبيقات)",
    labelEn: "Restaurant",
    bands: [{ from: "2000-01-01", to: null, delivery: 0, pickup: 0, note: "لا توجد عمولة منصة" }],
    paymentFeePct: 0,
    minServiceFeeSar: 0,
    monthlySubscriptionSar: 0,
    subscriptionFrom: null,
    subsidyTiers: [],
    subsidyAboveTopSar: 0,
    subsidyConfirmed: true,
    caveats: [],
  },
};

/* Orders that are clearly delivery but carry no app tag. They get NO
   commission modelled, which UNDERSTATES cost — so they are their own channel
   and their count ships in `warnings`, never quietly folded into the total. */
const UNKNOWN_APP = "other_delivery";

const CHANNEL_ORDER = ["keeta", "hungerstation", "ninja", UNKNOWN_APP, "restaurant"];
const CHANNEL_LABEL = {
  keeta: "كيتا", hungerstation: "هنقرستيشن", ninja: "نينجا",
  [UNKNOWN_APP]: "توصيل — تطبيق غير محدد", restaurant: "المطعم (بدون تطبيقات)",
};

/* ── numeric / date helpers ──────────────────────────────────────────────── */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(num(v) * 100) / 100;
const rate4 = (v) => (v === null || v === undefined ? null : Math.round(num(v) * 10000) / 10000);
const ratio = (a, b) => (num(b) === 0 ? null : rate4(num(a) / num(b)));

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayArg = (v, fallback) => (typeof v === "string" && DAY_RE.test(v) ? v : fallback);
const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const shiftDay = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* ═══════════════════════════════════════════════════════════════════════════
   THE ENGINE
═══════════════════════════════════════════════════════════════════════════ */

/** Deep-merge the stored overrides onto DEFAULT_RATES without letting a partial
 *  override wipe a whole app's contract. */
export function mergeRates(stored) {
  const out = JSON.parse(JSON.stringify(DEFAULT_RATES));
  if (!stored || typeof stored !== "object") return out;
  for (const key of Object.keys(out)) {
    const s = stored[key];
    if (!s || typeof s !== "object") continue;
    for (const k of Object.keys(s)) {
      if (s[k] !== undefined && s[k] !== null) out[key][k] = s[k];
    }
  }
  return out;
}

/**
 * Pick the rate band that governs an order, BY THE ORDER'S OWN DAY.
 * Returns the band plus a human-readable `why` so /commissions can prove it.
 */
export function bandFor(appCfg, day) {
  const bands = Array.isArray(appCfg?.bands) ? appCfg.bands : [];
  for (const b of bands) {
    const from = b.from || "2000-01-01";
    const to = b.to || "9999-12-31";
    if (day >= from && day <= to) {
      return {
        ...b,
        why: `تاريخ الطلب ${day} يقع في الشريحة ${from} → ${b.to || "بدون نهاية"}`,
        whyEn: `order day ${day} falls in band ${from} → ${b.to || "open-ended"}`,
      };
    }
  }
  // Before the contract started (e.g. a HungerStation order dated May 2026).
  // Falling back to the earliest band silently would apply a rate that was not
  // in force; we return a zeroed band and flag it instead.
  return {
    from: null, to: null, delivery: 0, pickup: 0, components: null,
    outOfContract: true,
    why: `تاريخ الطلب ${day} خارج أي شريحة في العقد — لم تُحتسب عمولة`,
    whyEn: `order day ${day} is outside every contract band — no commission applied`,
  };
}

/** Merchant-funded delivery subsidy for one order (Keeta only today). */
export function subsidyFor(appCfg, value) {
  const tiers = Array.isArray(appCfg?.subsidyTiers) ? appCfg.subsidyTiers : [];
  if (!tiers.length) return { amount: 0, tier: null };
  for (const t of tiers) {
    if (value <= num(t.upTo)) return { amount: num(t.amountSar), tier: `≤ ${t.upTo}` };
  }
  return { amount: num(appCfg.subsidyAboveTopSar), tier: `> ${tiers[tiers.length - 1].upTo}` };
}

/**
 * Full economics of ONE order. This is the single place the money model lives;
 * /pnl, /per-order, /commissions and the advisor all go through it, so they can
 * never disagree with each other.
 *
 * `row` carries the SQL-side figures; `cfg` is the merged rate table.
 */
export function orderEconomics(row, cfg, foodCostPct, commissionBasis) {
  const day = isoDay(row.calendar_day);
  const channel = row.channel;
  const appCfg = cfg[channel] || cfg.restaurant;

  const netEx = num(row.net_ex);
  const grossEx = num(row.gross_ex);
  const totalIncl = num(row.total);
  const discountEx = Math.max(grossEx - netEx, 0);

  // Rule 3 — the commission base. `net` by default; settings can flip it to the
  // VAT-inclusive total, which raises every commission by exactly 15%.
  const base = commissionBasis === "total" ? totalIncl : netEx;

  /* PICKUP: TabSense stamps EVERY aggregator order `order_option = 'Dine in'`
     and `order_type = 'External'` — probed across all 163 app-tagged orders,
     there is not one distinguishable pickup row. So we cannot detect pickup and
     we bill the DELIVERY rate, which is the conservative (higher-cost) read for
     Keeta (18% vs 3%) and for HungerStation is actually the cheaper one today
     (10% vs 21%). If pickup ever becomes real, it needs a tag on the order —
     it cannot be inferred from what TabSense stores. */
  const band = bandFor(appCfg, day);
  const ratePct = num(band.delivery);

  const commissionTotal = base * ratePct;
  // Contractual split, when the contract names one (Keeta's 8% + 10%).
  const comps = band.components && typeof band.components === "object" ? band.components : null;
  const componentBreakdown = comps
    ? Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, money(base * num(v))]))
    : null;

  // Minimum service fee: a top-up, not an extra charge — the contract floors
  // the service fee at SAR 1, it does not add SAR 1 on top of the percentage.
  const minFee = num(appCfg.minServiceFeeSar);
  const minFeeTopUp = commissionTotal < minFee ? minFee - commissionTotal : 0;

  const paymentFee = base * num(appCfg.paymentFeePct);
  const sub = subsidyFor(appCfg, base);

  /* FOOD COST — rule 4 (pre-discount base) + the measured/assumed split. */
  const measuredCost = num(row.measured_cost);
  const coveredValueEx = num(row.covered_value_incl) / (1 + VAT_RATE);
  const uncoveredEx = Math.max(grossEx - coveredValueEx, 0);
  const estimatedCost = uncoveredEx * foodCostPct;
  const foodCost = measuredCost + estimatedCost;

  const platformCost = commissionTotal + minFeeTopUp + paymentFee + sub.amount;
  // "Contribution" = what the order leaves behind before fixed overheads
  // (subscriptions, ads, rent, salaries). Those are period costs, not per-order.
  const contribution = netEx - foodCost - platformCost;

  return {
    orderId: row.order_id,
    receipt: row.receipt || "",
    day,
    channel,
    channelLabel: CHANNEL_LABEL[channel] || channel,
    orderType: row.order_type || "",
    orderOption: row.order_option || "",

    revenueIncl: money(totalIncl),
    revenueEx: money(netEx),
    grossEx: money(grossEx),
    discountEx: money(discountEx),

    foodCost: money(foodCost),
    foodCostMeasured: money(measuredCost),
    foodCostEstimated: money(estimatedCost),
    // 1 = fully measured from item_costs, 0 = entirely the blended 43% guess.
    foodCostMeasuredShare: foodCost > 0 ? rate4(measuredCost / foodCost) : null,
    hasItems: !!row.has_items,

    commissionRate: rate4(ratePct),
    commissionBase: money(base),
    commission: money(commissionTotal),
    commissionComponents: componentBreakdown,
    minFeeTopUp: money(minFeeTopUp),
    paymentFee: money(paymentFee),
    deliverySubsidy: money(sub.amount),
    subsidyTier: sub.tier,
    platformCost: money(platformCost),

    netProfit: money(contribution),
    netMarginPct: netEx > 0 ? rate4(contribution / netEx) : null,
    losesMoney: contribution < 0,

    // Honesty flags the UI turns into badges.
    netEstimated: !!row.net_estimated,
    outOfContract: !!band.outOfContract,
    bandFrom: band.from,
    bandTo: band.to,
    bandWhy: band.why,
    subsidyConfirmed: appCfg.subsidyConfirmed !== false,
  };
}

/**
 * Subscription fees pro-rated across a window. A monthly subscription is a
 * fixed cost you pay whether or not an order arrives, so it is charged for the
 * days of the window that fall inside the contract, not per order.
 */
export function subscriptionsFor(cfg, from, to) {
  const out = {};
  for (const [id, appCfg] of Object.entries(cfg)) {
    const monthly = num(appCfg.monthlySubscriptionSar);
    if (monthly <= 0) { out[id] = { amount: 0, days: 0, monthly: 0 }; continue; }
    const start = appCfg.subscriptionFrom && DAY_RE.test(appCfg.subscriptionFrom)
      ? appCfg.subscriptionFrom : from;
    const winFrom = from > start ? from : start;
    if (winFrom > to) { out[id] = { amount: 0, days: 0, monthly }; continue; }

    // Month by month, so February is not billed at a 30-day rate.
    let amount = 0, days = 0;
    let cursor = winFrom;
    while (cursor <= to) {
      const y = Number(cursor.slice(0, 4)), m = Number(cursor.slice(5, 7));
      const dim = daysInMonth(y, m);
      const monthEnd = `${cursor.slice(0, 7)}-${String(dim).padStart(2, "0")}`;
      const segEnd = monthEnd < to ? monthEnd : to;
      const segDays = spanDays(cursor, segEnd);
      amount += monthly * (segDays / dim);
      days += segDays;
      cursor = shiftDay(segEnd, 1);
    }
    out[id] = { amount: money(amount), days, monthly };
  }
  return out;
}

/* Empty cost bucket — every aggregation starts from this shape so a channel
   with no orders still renders a full row instead of a hole. */
const emptyAgg = () => ({
  orders: 0, revenueIncl: 0, revenueEx: 0, grossEx: 0, discountEx: 0,
  foodCost: 0, foodCostMeasured: 0, foodCostEstimated: 0,
  commission: 0, minFeeTopUp: 0, paymentFee: 0, deliverySubsidy: 0, platformCost: 0,
  netProfit: 0, losingOrders: 0, netEstimatedOrders: 0, ordersWithItems: 0,
  outOfContractOrders: 0, components: {},
});

function accumulate(a, e) {
  a.orders += 1;
  a.revenueIncl += e.revenueIncl;
  a.revenueEx += e.revenueEx;
  a.grossEx += e.grossEx;
  a.discountEx += e.discountEx;
  a.foodCost += e.foodCost;
  a.foodCostMeasured += e.foodCostMeasured;
  a.foodCostEstimated += e.foodCostEstimated;
  a.commission += e.commission;
  a.minFeeTopUp += e.minFeeTopUp;
  a.paymentFee += e.paymentFee;
  a.deliverySubsidy += e.deliverySubsidy;
  a.platformCost += e.platformCost;
  a.netProfit += e.netProfit;
  if (e.losesMoney) a.losingOrders += 1;
  if (e.netEstimated) a.netEstimatedOrders += 1;
  if (e.hasItems) a.ordersWithItems += 1;
  if (e.outOfContract) a.outOfContractOrders += 1;
  if (e.commissionComponents) {
    for (const [k, v] of Object.entries(e.commissionComponents)) {
      a.components[k] = (a.components[k] || 0) + v;
    }
  }
  return a;
}

function shapeAgg(a) {
  return {
    orders: a.orders,
    revenueIncl: money(a.revenueIncl),
    revenueEx: money(a.revenueEx),
    grossEx: money(a.grossEx),
    discountEx: money(a.discountEx),
    avgOrderEx: a.orders ? money(a.revenueEx / a.orders) : 0,
    foodCost: money(a.foodCost),
    foodCostMeasured: money(a.foodCostMeasured),
    foodCostEstimated: money(a.foodCostEstimated),
    foodCostPctOfRevenue: ratio(a.foodCost, a.revenueEx),
    foodCostMeasuredShare: a.foodCost > 0 ? rate4(a.foodCostMeasured / a.foodCost) : null,
    commission: money(a.commission),
    commissionComponents: Object.fromEntries(Object.entries(a.components).map(([k, v]) => [k, money(v)])),
    minFeeTopUp: money(a.minFeeTopUp),
    paymentFee: money(a.paymentFee),
    deliverySubsidy: money(a.deliverySubsidy),
    platformCost: money(a.platformCost),
    platformCostPctOfRevenue: ratio(a.platformCost, a.revenueEx),
    contribution: money(a.netProfit),
    contributionMarginPct: ratio(a.netProfit, a.revenueEx),
    losingOrders: a.losingOrders,
    netEstimatedOrders: a.netEstimatedOrders,
    ordersWithItems: a.ordersWithItems,
    itemCoverage: ratio(a.ordersWithItems, a.orders),
    outOfContractOrders: a.outOfContractOrders,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE ONE QUERY EVERY ENDPOINT READS FROM.

   One row per order carrying: the VAT-exclusive money (the rule-2 fallback is
   applied IN SQL so no caller can forget it), the channel, and the per-item
   cost aggregates.

   The LATERAL is what makes per-item costs date-aware: for each line it picks
   the newest cost row that was ALREADY EFFECTIVE on that order's own day, so
   entering a cost tomorrow does not silently rewrite last month's profit.

   Exported (with the helpers above) so it can be exercised against the live
   database without booting the whole API.
   $1 = from, $2 = to, $3 = delivery payment-method names.
═══════════════════════════════════════════════════════════════════════════ */
export const ORDERS_SQL = `
  WITH ic AS (
    SELECT i.order_id, o2.calendar_day, i.name, i.qty, i.amount
      FROM ts_order_items i
      JOIN ts_orders o2 ON o2.order_id = i.order_id
     WHERE o2.calendar_day BETWEEN $1::date AND $2::date
  ),
  items AS (
    SELECT ic.order_id,
           sum(ic.amount) AS item_value_incl,
           COALESCE(sum(c.cost * ic.qty) FILTER (WHERE c.cost IS NOT NULL), 0) AS measured_cost,
           COALESCE(sum(ic.amount)       FILTER (WHERE c.cost IS NOT NULL), 0) AS covered_value_incl,
           count(*)::int AS lines
      FROM ic
      LEFT JOIN LATERAL (
        SELECT x.cost FROM item_costs x
         WHERE x.item_name = ic.name AND x.effective_from <= ic.calendar_day
         ORDER BY x.effective_from DESC LIMIT 1
      ) c ON true
     GROUP BY 1
  )
  SELECT o.order_id, o.receipt, o.calendar_day, o.order_type, o.order_option,
         o.total, o.staff_name,
         ${NET_EX}   AS net_ex,
         ${GROSS_EX} AS gross_ex,
         (o.net IS NULL OR o.net = 0) AS net_estimated,
         CASE
           WHEN lower(COALESCE(s.source_note,'')) = 'keeta'         THEN 'keeta'
           WHEN lower(COALESCE(s.source_note,'')) = 'hungerstation' THEN 'hungerstation'
           WHEN lower(COALESCE(s.source_note,'')) = 'ninja'         THEN 'ninja'
           -- Delivery we can see but cannot attribute: no commission is
           -- modelled for it, so it must not hide inside 'restaurant'.
           WHEN o.order_type ILIKE '%external%'
             OR EXISTS (SELECT 1 FROM jsonb_object_keys(o.payments) k
                         WHERE lower(k) = ANY($3::text[]))          THEN '${UNKNOWN_APP}'
           ELSE 'restaurant'
         END AS channel,
         COALESCE(it.measured_cost, 0)       AS measured_cost,
         COALESCE(it.covered_value_incl, 0)  AS covered_value_incl,
         COALESCE(it.item_value_incl, 0)     AS item_value_incl,
         (it.lines IS NOT NULL)              AS has_items
    FROM ts_orders o
    LEFT JOIN order_sources s ON s.order_id = o.order_id
    LEFT JOIN items it ON it.order_id = o.order_id
   WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
   ORDER BY o.calendar_day, o.order_id`;

/* Payment-method names that mean "delivery aggregator" — same list index.js
   uses for DEFAULT_DELIVERY_APPS. Only a FALLBACK signal here: `source_note`
   is the authority for which app an order belongs to. */
export const DELIVERY_PAY_KEYS = ["ninja", "feedus", "keeta", "hungerstation", "jahez", "toyou", "mrsool", "careem"];

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb, todayISO, daysAgoISO } = ctx;

  /* ── Schema. Same pattern as index.js's ensureMarketingSchema: fired once at
     registration, and a failure logs instead of taking the API down. ──────── */
  async function ensureFinanceSchema() {
    await pool.query(`
      -- Real per-item food costs. Designed to REPLACE the blended 43% one item
      -- at a time: the engine prefers a row here and falls back to the blend.
      -- \`cost\` is SAR per single unit, VAT-EXCLUSIVE (a COGS has no output VAT).
      -- \`effective_from\` lets a price change apply from a date without
      -- rewriting last month's reported profit.
      CREATE TABLE IF NOT EXISTS item_costs (
        id TEXT PRIMARY KEY,
        item_name TEXT NOT NULL,
        item_id TEXT NOT NULL DEFAULT '',
        cost NUMERIC NOT NULL DEFAULT 0,
        effective_from DATE NOT NULL DEFAULT '2000-01-01',
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (item_name, effective_from)
      );
      CREATE INDEX IF NOT EXISTS item_costs_name_idx ON item_costs(item_name);
      -- Cached CFO answers. An LLM call costs real money and the P&L does not
      -- move fast enough to justify one per page load.
      CREATE TABLE IF NOT EXISTS fin_advice (
        id TEXT PRIMARY KEY,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        evidence JSONB NOT NULL DEFAULT '{}',
        result JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS fin_advice_lookup_idx
        ON fin_advice(from_date, to_date, created_at DESC);
    `);
  }
  ensureFinanceSchema()
    .then(() => console.log("[finance] schema ready"))
    .catch((e) => console.error("[finance] ensureFinanceSchema failed:", e.message));

  /* ── Config load ─────────────────────────────────────────────────────────
     Finance config lives inside the single `settings` blob (id=1) so it shares
     the existing backup/restore path instead of inventing a second one. */
  async function financeConfig() {
    const s = await getSettingsData();
    const pctRaw = Number(s?.financeFoodCostPct);
    const foodCostPct = Number.isFinite(pctRaw) && pctRaw >= 0 && pctRaw <= 1
      ? pctRaw : DEFAULT_FOOD_COST_PCT;
    return {
      foodCostPct,
      foodCostPctIsDefault: !(Number.isFinite(pctRaw) && pctRaw >= 0 && pctRaw <= 1),
      rates: mergeRates(s?.financeRates),
      commissionBasis: s?.financeCommissionBasis === "total" ? "total" : "net",
      oneOffs: Array.isArray(s?.financeOneOffs) ? s.financeOneOffs : [],
    };
  }

  /** Load + price every order in the window. ~800 rows for a 30-day window, so
   *  doing the arithmetic in JS (where the date-banded rates live) is cheap. */
  async function loadEconomics(from, to, cfg) {
    const rows = (await pool.query(ORDERS_SQL, [from, to, DELIVERY_PAY_KEYS])).rows;
    return rows.map((r) => orderEconomics(r, cfg.rates, cfg.foodCostPct, cfg.commissionBasis));
  }

  /** Ad spend from the marketing module, keyed by plain calendar day. */
  async function adSpend(from, to) {
    const r = await pool.query(
      `SELECT COALESCE(sum(spend),0) AS spend, count(*)::int AS entries,
              count(DISTINCT campaign_id)::int AS campaigns
         FROM mk_entries WHERE day BETWEEN $1::date AND $2::date`, [from, to]);
    const byPlatform = (await pool.query(
      `SELECT c.platform, COALESCE(sum(e.spend),0) AS spend
         FROM mk_entries e JOIN mk_campaigns c ON c.id = e.campaign_id
        WHERE e.day BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 2 DESC`, [from, to])).rows
      .map((x) => ({ platform: x.platform, spend: money(x.spend) }));
    return {
      total: money(r.rows[0].spend),
      entries: num(r.rows[0].entries),
      campaigns: num(r.rows[0].campaigns),
      byPlatform,
      /* ATTRIBUTION IS DELIBERATELY NOT DONE. mk_entries has no channel link,
         so we do NOT split ad spend across Keeta/HungerStation/restaurant —
         a made-up split would silently move profit between channels. It is a
         period overhead and is reported as one. */
      allocation: "unallocated",
    };
  }

  /** The assumption block that ships with EVERY response. If a number on the
   *  screen rests on a guess, the guess is right next to it. */
  function assumptionsBlock(cfg, stats) {
    return {
      vatRate: VAT_RATE,
      vatNote: "كل الأرقام هنا بدون ضريبة القيمة المضافة — الـ١٥٪ دي فلوس الدولة مش إيراد المطعم.",
      commissionBasis: cfg.commissionBasis,
      commissionBasisNote: cfg.commissionBasis === "net"
        ? "العمولات محسوبة على قيمة الطلب بدون ضريبة (net). ده افتراض: العقود بتقول «قيمة الطلب» من غير ما تحدد. لو المقصود القيمة شاملة الضريبة، كل رقم عمولة هيزيد ١٥٪."
        : "العمولات محسوبة على قيمة الطلب شاملة الضريبة (total) — إعداد يدوي، مش الافتراضي.",
      foodCostPct: cfg.foodCostPct,
      foodCostPctIsDefault: cfg.foodCostPctIsDefault,
      foodCostNote: `تكلفة الطعام مقدّرة بنسبة ${Math.round(cfg.foodCostPct * 100)}٪ موحّدة على كل الأصناف — دي تقدير من TabSense مش قياس. الأصناف اللي ليها تكلفة حقيقية في جدول التكاليف بتستخدم رقمها الفعلي.`,
      foodCostBase: "gross_ex",
      foodCostBaseNote: "النسبة بتتحسب على قيمة المنيو قبل الخصم — الطلب المخصوم بيتكلف في المطبخ نفس تكلفة الطلب كامل السعر.",
      netFallbackNote: "عمود net فاضي في طلبات قديمة (أبريل/مايو/يونيو ٢٠٢٦)، فبنشتق القيمة بدون ضريبة من total ÷ ١٫١٥. الطلبات دي متعلّمة بعلامة «مقدّر».",
      pickupNote: "TabSense بيسجّل كل طلبات التطبيقات كـ Dine in / External من غير ما يفرّق بين توصيل واستلام، فكل طلبات التطبيقات بتتحسب بعمولة التوصيل.",
      adSpendNote: "صرف الإعلانات مصروف عام على الفترة كلها — مش متوزّع على القنوات، لأن مفيش ربط بين الحملة والقناة في البيانات.",
      ...stats,
    };
  }

  function warningsFor(cfg, list, spend) {
    const w = [];
    const est = list.filter((e) => e.netEstimated).length;
    if (est) {
      w.push({
        level: "info", code: "net_estimated",
        text: `${est} من ${list.length} طلب مفيهاش عمود net، فالقيمة بدون ضريبة اتحسبت من total ÷ ١٫١٥.`,
      });
    }
    const unknown = list.filter((e) => e.channel === UNKNOWN_APP).length;
    if (unknown) {
      w.push({
        level: "warn", code: "untagged_delivery",
        text: `${unknown} طلب توصيل من غير تحديد التطبيق — ما اتحسبتش عليه أي عمولة، يعني التكلفة الحقيقية أعلى من اللي ظاهر.`,
      });
    }
    const noItems = list.filter((e) => !e.hasItems).length;
    if (noItems) {
      w.push({
        level: "info", code: "missing_items",
        text: `${noItems} طلب مفيهوش أصناف مخزّنة، فتكلفة أكله كلها بالنسبة الموحّدة.`,
      });
    }
    const ooc = list.filter((e) => e.outOfContract).length;
    if (ooc) {
      w.push({
        level: "warn", code: "out_of_contract",
        text: `${ooc} طلب تاريخه خارج شرائح العقد الخاصة بتطبيقه — ما اتحسبتش عليه عمولة.`,
      });
    }
    if (!cfg.rates.keeta.subsidyConfirmed) {
      w.push({
        level: "warn", code: "keeta_subsidy_unconfirmed",
        text: "شرائح دعم التوصيل في عقد كيتا مقروءة من PDF عربي والترتيب فيه لبس — أكّدها مع كيتا قبل ما تبني عليها قرار.",
      });
    }
    for (const [id, a] of Object.entries(cfg.rates)) {
      for (const cv of (Array.isArray(a.caveats) ? a.caveats : [])) {
        w.push({ level: "warn", code: `${id}_contract_caveat`, text: cv });
      }
    }
    if (spend.total === 0) {
      w.push({
        level: "info", code: "no_ad_spend",
        text: "مفيش أي صرف إعلانات مسجّل في الفترة دي — لو فيه صرف فعلي، صافي الربح اللي فوق أعلى من الحقيقة.",
      });
    }
    return w;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     1. GET /api/finance/pnl?from&to
  ═════════════════════════════════════════════════════════════════════════ */
  app.get("/api/finance/pnl", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(29));
      const to = dayArg(c.req.query("to"), todayISO());
      const cfg = await financeConfig();

      const [list, spend] = await Promise.all([loadEconomics(from, to, cfg), adSpend(from, to)]);

      // Overall + per channel, from the same per-order numbers.
      const overallAgg = emptyAgg();
      const byChannel = Object.fromEntries(CHANNEL_ORDER.map((k) => [k, emptyAgg()]));
      const byDay = new Map();
      for (const e of list) {
        accumulate(overallAgg, e);
        accumulate(byChannel[e.channel] || (byChannel[e.channel] = emptyAgg()), e);
        if (!byDay.has(e.day)) byDay.set(e.day, emptyAgg());
        accumulate(byDay.get(e.day), e);
      }

      const subs = subscriptionsFor(cfg.rates, from, to);
      const subsTotal = Object.values(subs).reduce((a, s) => a + num(s.amount), 0);

      // One-off fees (Keeta POS SAR 500, photography SAR 500, …) only land in a
      // period whose window actually contains their date. Empty by default —
      // we do not know the dates, and inventing them would be a fake cost.
      const oneOffs = cfg.oneOffs
        .filter((o) => DAY_RE.test(String(o?.day || "")) && o.day >= from && o.day <= to)
        .map((o) => ({
          app: String(o.app || ""), label: String(o.label || ""),
          amount: money(o.amount), day: o.day,
        }));
      const oneOffTotal = oneOffs.reduce((a, o) => a + o.amount, 0);

      const overall = shapeAgg(overallAgg);
      const fixedCosts = subsTotal + spend.total + oneOffTotal;
      const netProfit = overall.contribution - fixedCosts;

      const channels = CHANNEL_ORDER
        .filter((id) => byChannel[id] && byChannel[id].orders > 0)
        .map((id) => {
          const cfgApp = cfg.rates[id] || {};
          const shaped = shapeAgg(byChannel[id]);
          const sub = subs[id] || { amount: 0, days: 0, monthly: 0 };
          return {
            id,
            label: CHANNEL_LABEL[id] || id,
            ...shaped,
            subscription: sub.amount,
            subscriptionMonthly: sub.monthly,
            // Channel profit AFTER that channel's own fixed subscription but
            // BEFORE ads/rent/salaries, which are not attributable.
            channelProfit: money(shaped.contribution - sub.amount),
            channelMarginPct: ratio(shaped.contribution - sub.amount, shaped.revenueEx),
            revenueShare: ratio(shaped.revenueEx, overall.revenueEx),
            bands: (Array.isArray(cfgApp.bands) ? cfgApp.bands : []).map((b) => ({
              from: b.from, to: b.to, delivery: b.delivery, pickup: b.pickup,
              note: b.note || "", active: (b.from || "2000-01-01") <= to && (b.to || "9999-12-31") >= from,
            })),
            paymentFeePct: num(cfgApp.paymentFeePct),
            minServiceFeeSar: num(cfgApp.minServiceFeeSar),
            subsidyConfirmed: cfgApp.subsidyConfirmed !== false,
            caveats: Array.isArray(cfgApp.caveats) ? cfgApp.caveats : [],
          };
        });

      const daily = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, a]) => {
        const s = shapeAgg(a);
        return {
          day, orders: s.orders, revenueEx: s.revenueEx, foodCost: s.foodCost,
          platformCost: s.platformCost, contribution: s.contribution,
        };
      });

      return c.json({
        ok: true, from, to, days: spanDays(from, to),
        overall: {
          ...overall,
          subscriptions: money(subsTotal),
          adSpend: spend.total,
          oneOffs: money(oneOffTotal),
          fixedCosts: money(fixedCosts),
          netProfit: money(netProfit),
          netProfitMarginPct: ratio(netProfit, overall.revenueEx),
          // Total cost of doing business, for a one-glance sanity check.
          totalCosts: money(overall.foodCost + overall.platformCost + fixedCosts),
        },
        channels,
        daily,
        subscriptions: Object.entries(subs)
          .filter(([, s]) => s.amount > 0)
          .map(([id, s]) => ({ id, label: CHANNEL_LABEL[id] || id, ...s })),
        oneOffs,
        adSpend: spend,
        assumptions: assumptionsBlock(cfg, {
          ordersPriced: list.length,
          ordersWithEstimatedNet: list.filter((e) => e.netEstimated).length,
          ordersWithItems: list.filter((e) => e.hasItems).length,
          foodCostMeasuredShare: overall.foodCostMeasuredShare,
        }),
        warnings: warningsFor(cfg, list, spend),
      });
    } catch (e) {
      console.error("[finance] pnl failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ═════════════════════════════════════════════════════════════════════════
     2. GET /api/finance/per-order?from&to&app=&losing=1&limit=
  ═════════════════════════════════════════════════════════════════════════ */
  app.get("/api/finance/per-order", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(29));
      const to = dayArg(c.req.query("to"), todayISO());
      const appQ = String(c.req.query("app") || "").toLowerCase();
      const losingOnly = c.req.query("losing") === "1";
      const limit = Math.min(2000, Math.max(1, Number(c.req.query("limit")) || 500));
      const cfg = await financeConfig();

      const all = await loadEconomics(from, to, cfg);
      let list = all;
      if (appQ && appQ !== "all") list = list.filter((e) => e.channel === appQ);
      const scoped = list;
      if (losingOnly) list = list.filter((e) => e.losesMoney);

      // Sort worst-margin first: the whole point of this screen is to find the
      // orders that cost more than they brought in.
      list = [...list].sort((a, b) => a.netProfit - b.netProfit).slice(0, limit);

      const losers = scoped.filter((e) => e.losesMoney);
      const totals = shapeAgg(scoped.reduce((a, e) => accumulate(a, e), emptyAgg()));

      return c.json({
        ok: true, from, to, app: appQ || "all",
        count: list.length, scopedCount: scoped.length,
        totals,
        losing: {
          orders: losers.length,
          share: ratio(losers.length, scoped.length),
          lostSar: money(losers.reduce((a, e) => a + e.netProfit, 0)),
          byChannel: CHANNEL_ORDER
            .map((id) => ({
              id, label: CHANNEL_LABEL[id] || id,
              orders: losers.filter((e) => e.channel === id).length,
              lostSar: money(losers.filter((e) => e.channel === id).reduce((a, e) => a + e.netProfit, 0)),
            }))
            .filter((x) => x.orders > 0),
        },
        orders: list,
        assumptions: assumptionsBlock(cfg, { ordersPriced: scoped.length }),
      });
    } catch (e) {
      console.error("[finance] per-order failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ═════════════════════════════════════════════════════════════════════════
     3. GET /api/finance/commissions?from&to
     The audit trail: for every app, which rate applied to which orders AND WHY
     (the date rule that selected the band). Without the "why" the commission
     total is just a number somebody has to trust.
  ═════════════════════════════════════════════════════════════════════════ */
  app.get("/api/finance/commissions", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(29));
      const to = dayArg(c.req.query("to"), todayISO());
      const cfg = await financeConfig();
      const list = await loadEconomics(from, to, cfg);

      const apps = [];
      for (const id of CHANNEL_ORDER) {
        if (id === "restaurant" || id === UNKNOWN_APP) continue;
        const appCfg = cfg.rates[id];
        if (!appCfg) continue;
        const mine = list.filter((e) => e.channel === id);

        // Group by the band that actually fired, not by the band table — a band
        // with no orders in the window is shown separately as "not exercised".
        const groups = new Map();
        for (const e of mine) {
          const key = `${e.bandFrom || "-"}..${e.bandTo || "-"}|${e.commissionRate}`;
          if (!groups.has(key)) {
            groups.set(key, {
              from: e.bandFrom, to: e.bandTo, rate: e.commissionRate,
              why: e.bandWhy, outOfContract: e.outOfContract,
              orders: 0, base: 0, commission: 0, minFeeTopUp: 0,
              paymentFee: 0, subsidy: 0, components: {},
              firstDay: e.day, lastDay: e.day,
            });
          }
          const g = groups.get(key);
          g.orders += 1;
          g.base += e.commissionBase;
          g.commission += e.commission;
          g.minFeeTopUp += e.minFeeTopUp;
          g.paymentFee += e.paymentFee;
          g.subsidy += e.deliverySubsidy;
          if (e.day < g.firstDay) g.firstDay = e.day;
          if (e.day > g.lastDay) g.lastDay = e.day;
          if (e.commissionComponents) {
            for (const [k, v] of Object.entries(e.commissionComponents)) {
              g.components[k] = (g.components[k] || 0) + v;
            }
          }
        }

        const bandRows = [...groups.values()].map((g) => ({
          bandFrom: g.from, bandTo: g.to,
          rate: g.rate, ratePct: rate4(g.rate * 100),
          why: g.why,
          outOfContract: g.outOfContract,
          orders: g.orders,
          firstDay: g.firstDay, lastDay: g.lastDay,
          commissionBase: money(g.base),
          commission: money(g.commission),
          components: Object.fromEntries(Object.entries(g.components).map(([k, v]) => [k, money(v)])),
          minFeeTopUp: money(g.minFeeTopUp),
          paymentFee: money(g.paymentFee),
          deliverySubsidy: money(g.subsidy),
          // Reproducible by hand: base × rate should equal commission.
          check: `${money(g.base)} × ${rate4(g.rate * 100)}٪ = ${money(g.base * g.rate)}`,
          totalCharged: money(g.commission + g.minFeeTopUp + g.paymentFee + g.subsidy),
        })).sort((a, b) => (a.bandFrom || "") < (b.bandFrom || "") ? -1 : 1);

        const sub = subscriptionsFor(cfg.rates, from, to)[id] || { amount: 0, days: 0, monthly: 0 };
        apps.push({
          id, label: CHANNEL_LABEL[id] || id,
          orders: mine.length,
          commissionBase: money(mine.reduce((a, e) => a + e.commissionBase, 0)),
          commission: money(mine.reduce((a, e) => a + e.commission, 0)),
          minFeeTopUp: money(mine.reduce((a, e) => a + e.minFeeTopUp, 0)),
          paymentFee: money(mine.reduce((a, e) => a + e.paymentFee, 0)),
          deliverySubsidy: money(mine.reduce((a, e) => a + e.deliverySubsidy, 0)),
          subscription: sub.amount,
          totalCost: money(mine.reduce((a, e) => a + e.platformCost, 0) + sub.amount),
          effectiveRate: ratio(
            mine.reduce((a, e) => a + e.platformCost, 0) + sub.amount,
            mine.reduce((a, e) => a + e.revenueEx, 0)),
          bandsExercised: bandRows,
          // The full contract table, so the UI can show what changes and when.
          contract: {
            bands: (Array.isArray(appCfg.bands) ? appCfg.bands : []).map((b) => ({
              from: b.from, to: b.to, delivery: b.delivery, pickup: b.pickup,
              note: b.note || "",
              exercised: bandRows.some((r) => r.bandFrom === b.from),
              upcoming: !!b.from && b.from > to,
            })),
            paymentFeePct: num(appCfg.paymentFeePct),
            minServiceFeeSar: num(appCfg.minServiceFeeSar),
            monthlySubscriptionSar: num(appCfg.monthlySubscriptionSar),
            subscriptionFrom: appCfg.subscriptionFrom || null,
            subsidyTiers: Array.isArray(appCfg.subsidyTiers) ? appCfg.subsidyTiers : [],
            subsidyAboveTopSar: num(appCfg.subsidyAboveTopSar),
            subsidyConfirmed: appCfg.subsidyConfirmed !== false,
            pickupPromoMerchantCapSar: num(appCfg.pickupPromoMerchantCapSar),
            caveats: Array.isArray(appCfg.caveats) ? appCfg.caveats : [],
            oneOffsHint: appCfg.oneOffsHint || "",
          },
        });
      }

      return c.json({
        ok: true, from, to,
        apps,
        totals: {
          commission: money(apps.reduce((a, x) => a + x.commission, 0)),
          paymentFee: money(apps.reduce((a, x) => a + x.paymentFee, 0)),
          deliverySubsidy: money(apps.reduce((a, x) => a + x.deliverySubsidy, 0)),
          minFeeTopUp: money(apps.reduce((a, x) => a + x.minFeeTopUp, 0)),
          subscription: money(apps.reduce((a, x) => a + x.subscription, 0)),
          total: money(apps.reduce((a, x) => a + x.totalCost, 0)),
        },
        assumptions: assumptionsBlock(cfg, { ordersPriced: list.length }),
      });
    } catch (e) {
      console.error("[finance] commissions failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ═════════════════════════════════════════════════════════════════════════
     4. GET / PUT /api/finance/settings
  ═════════════════════════════════════════════════════════════════════════ */
  app.get("/api/finance/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await financeConfig();
    return c.json({
      ok: true,
      foodCostPct: cfg.foodCostPct,
      foodCostPctIsDefault: cfg.foodCostPctIsDefault,
      defaultFoodCostPct: DEFAULT_FOOD_COST_PCT,
      commissionBasis: cfg.commissionBasis,
      vatRate: VAT_RATE,
      rates: cfg.rates,
      defaults: DEFAULT_RATES,
      oneOffs: cfg.oneOffs,
      settingsKeys: ["financeFoodCostPct", "financeRates", "financeCommissionBasis", "financeOneOffs"],
    });
  });

  app.put("/api/finance/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const b = await c.req.json().catch(() => ({}));
      const patch = {};

      if (b.foodCostPct !== undefined) {
        const p = Number(b.foodCostPct);
        if (!Number.isFinite(p) || p < 0 || p > 1) {
          return c.json({ ok: false, error: "foodCostPct must be a fraction between 0 and 1" }, 400);
        }
        patch.financeFoodCostPct = p;
      }
      if (b.commissionBasis !== undefined) {
        if (!["net", "total"].includes(String(b.commissionBasis))) {
          return c.json({ ok: false, error: "commissionBasis must be 'net' or 'total'" }, 400);
        }
        patch.financeCommissionBasis = String(b.commissionBasis);
      }
      if (b.rates !== undefined) {
        if (!b.rates || typeof b.rates !== "object") {
          return c.json({ ok: false, error: "rates must be an object" }, 400);
        }
        // Store the MERGED table so a later default change never silently
        // rewrites a rate Omar deliberately set.
        patch.financeRates = mergeRates(b.rates);
      }
      if (b.oneOffs !== undefined) {
        if (!Array.isArray(b.oneOffs)) return c.json({ ok: false, error: "oneOffs must be an array" }, 400);
        patch.financeOneOffs = b.oneOffs
          .filter((o) => o && DAY_RE.test(String(o.day || "")))
          .map((o) => ({
            app: String(o.app || ""), label: String(o.label || ""),
            amount: money(o.amount), day: String(o.day),
          }));
      }
      if (!Object.keys(patch).length) return c.json({ ok: false, error: "nothing to update" }, 400);

      // JSONB merge, NOT a whole-object replace: the settings row is shared with
      // the rest of the app and PUT /api/settings would clobber it.
      await pool.query(
        "UPDATE settings SET data = COALESCE(data,'{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = 1",
        [jb(patch)]);

      const cfg = await financeConfig();
      return c.json({ ok: true, updated: Object.keys(patch), foodCostPct: cfg.foodCostPct, rates: cfg.rates });
    } catch (e) {
      console.error("[finance] put settings failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ═════════════════════════════════════════════════════════════════════════
     5. GET / PUT /api/finance/item-costs
     The path off the 43% assumption. GET also returns the menu ranked by the
     money it moves, so Omar costs the items that matter first.
  ═════════════════════════════════════════════════════════════════════════ */
  app.get("/api/finance/item-costs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const from = dayArg(c.req.query("from"), daysAgoISO(29));
      const to = dayArg(c.req.query("to"), todayISO());
      const cfg = await financeConfig();

      const costs = (await pool.query(
        `SELECT * FROM item_costs ORDER BY item_name, effective_from DESC`)).rows.map((r) => ({
          id: r.id,
          itemName: r.item_name,
          itemId: r.item_id || "",
          cost: money(r.cost),
          effectiveFrom: isoDay(r.effective_from),
          note: r.note || "",
          updatedAt: r.updated_at,
        }));

      // Menu volume in the window, with the newest cost that applies today.
      const items = (await pool.query(
        `SELECT i.name,
                sum(i.qty)    AS qty,
                sum(i.amount) AS value_incl,
                count(DISTINCT i.order_id)::int AS orders
           FROM ts_order_items i
           JOIN ts_orders o ON o.order_id = i.order_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          GROUP BY 1 ORDER BY value_incl DESC`, [from, to])).rows;

      const costByName = new Map();
      for (const r of costs) if (!costByName.has(r.itemName)) costByName.set(r.itemName, r);

      const totalValueIncl = items.reduce((a, r) => a + num(r.value_incl), 0);
      const covered = items.filter((r) => costByName.has(r.name));
      const menu = items.map((r) => {
        const c2 = costByName.get(r.name) || null;
        const valueEx = num(r.value_incl) / (1 + VAT_RATE);
        const realCost = c2 ? c2.cost * num(r.qty) : null;
        return {
          name: r.name,
          qty: money(r.qty),
          valueIncl: money(r.value_incl),
          valueEx: money(valueEx),
          orders: num(r.orders),
          valueShare: ratio(r.value_incl, totalValueIncl),
          cost: c2 ? c2.cost : null,
          effectiveFrom: c2 ? c2.effectiveFrom : null,
          measured: !!c2,
          // Side by side so Omar sees whether the blend is flattering an item.
          costTotal: realCost === null ? null : money(realCost),
          costPctReal: realCost === null ? null : ratio(realCost, valueEx),
          costTotalBlended: money(valueEx * cfg.foodCostPct),
        };
      });

      return c.json({
        ok: true, from, to,
        foodCostPct: cfg.foodCostPct,
        costs,
        menu,
        coverage: {
          itemsWithCost: covered.length,
          itemsTotal: items.length,
          itemsPct: ratio(covered.length, items.length),
          // The number that actually matters — share of MONEY covered, not of
          // item names. Costing 5 top sellers beats costing 50 rarities.
          valueCoveredPct: ratio(covered.reduce((a, r) => a + num(r.value_incl), 0), totalValueIncl),
        },
        note: "التكلفة تُدخل لكل وحدة واحدة وبدون ضريبة. الأصناف اللي مالهاش تكلفة بتستخدم النسبة الموحّدة.",
      });
    } catch (e) {
      console.error("[finance] item-costs failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.put("/api/finance/item-costs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const b = await c.req.json().catch(() => ({}));
      const items = Array.isArray(b?.items) ? b.items : null;
      if (!items) return c.json({ ok: false, error: "items array required" }, 400);

      let upserted = 0, deleted = 0;
      const errors = [];
      for (const it of items) {
        const name = String(it?.itemName || it?.name || "").trim();
        if (!name) { errors.push("row with no itemName skipped"); continue; }
        const effectiveFrom = DAY_RE.test(String(it?.effectiveFrom || "")) ? it.effectiveFrom : "2000-01-01";

        // cost === null is the documented way to REMOVE a cost and fall back to
        // the blended rate, as opposed to setting a cost of zero (which would
        // claim the item is free).
        if (it?.cost === null) {
          const r = await pool.query(
            "DELETE FROM item_costs WHERE item_name=$1 AND effective_from=$2::date", [name, effectiveFrom]);
          deleted += r.rowCount;
          continue;
        }
        const cost = Number(it?.cost);
        if (!Number.isFinite(cost) || cost < 0) { errors.push(`${name}: invalid cost`); continue; }

        await pool.query(
          `INSERT INTO item_costs (id, item_name, item_id, cost, effective_from, note)
           VALUES ($1,$2,$3,$4,$5::date,$6)
           ON CONFLICT (item_name, effective_from) DO UPDATE SET
             cost = EXCLUDED.cost, item_id = EXCLUDED.item_id,
             note = EXCLUDED.note, updated_at = NOW()`,
          [crypto.randomUUID(), name, String(it?.itemId || ""), cost, effectiveFrom, String(it?.note || "")]);
        upserted += 1;
      }

      return c.json({ ok: true, upserted, deleted, errors });
    } catch (e) {
      console.error("[finance] put item-costs failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ═════════════════════════════════════════════════════════════════════════
     6. POST /api/finance/advisor — the AI CFO.

     Same grounding harness as ai.js: build an evidence pack of REAL numbers,
     force a structured tool call, then DROP any recommendation whose evidence
     field does not quote a figure that exists in the pack. A CFO who invents a
     number is worse than no CFO.
  ═════════════════════════════════════════════════════════════════════════ */
  const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const ANTHROPIC_VERSION = "2023-06-01";
  const DEFAULT_MODEL = process.env.AI_MODEL || "claude-sonnet-5";
  const MAX_TOKENS = 12000;
  const LLM_TIMEOUT_MS = 180000;
  const CACHE_HOURS = 6;

  function resolveProvider() {
    if (process.env.ANTHROPIC_API_KEY) {
      return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: DEFAULT_MODEL };
    }
    if (process.env.LITELLM_KEY) {
      // The proxy routes Anthropic models under an "anthropic/" prefix.
      const model = DEFAULT_MODEL.includes("/") ? DEFAULT_MODEL : `anthropic/${DEFAULT_MODEL}`;
      return { kind: "litellm", key: process.env.LITELLM_KEY, model };
    }
    return null;
  }

  async function postJSON(url, headers, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      // Never echo credentials — only the provider's own message body.
      if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function callTool(provider, { system, user, tool }) {
    if (provider.kind === "anthropic") {
      const data = await postJSON(ANTHROPIC_URL, {
        "x-api-key": provider.key, "anthropic-version": ANTHROPIC_VERSION,
      }, {
        model: provider.model, max_tokens: MAX_TOKENS, system,
        messages: [{ role: "user", content: user }],
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
        tool_choice: { type: "tool", name: tool.name },
      });
      const block = (data.content || []).find((x) => x.type === "tool_use");
      if (!block) throw new Error("model returned no tool_use block");
      return block.input;
    }
    const data = await postJSON(`${LITELLM_BASE}/chat/completions`, {
      authorization: `Bearer ${provider.key}`,
    }, {
      model: provider.model, max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    });
    const call = ((data.choices || [])[0]?.message?.tool_calls || [])[0];
    if (!call) throw new Error("model returned no tool call");
    return JSON.parse(call.function.arguments || "{}");
  }

  const CFO_SYSTEM = `أنت المدير المالي لمطعم "فريش كتس" في جدة بالسعودية. بتكلم صاحب المطعم شخصيًا.

قواعد صارمة ما ينفعش تكسرها:
1. بالعربية بس، بلهجة مصرية واضحة ومباشرة زي محاسب شاطر بيشرح لصاحبه.
2. كل توصية لازم تكون مبنية على رقم موجود حرفيًا في حزمة البيانات (evidence) اللي هتستلمها.
3. ممنوع تخترع أي رقم. لو رقم مش موجود، ما تذكرهوش. لو البيانات ناقصة، قول إنها ناقصة.
4. حقل evidence لازم يكون فيه رقم منقول من البيانات مع اسمه (مثال: "هامش كيتا ٢١٫٨٪ مقابل ٤٣٪ للمطعم").
5. افتكر إن تكلفة الطعام تقدير موحّد ٤٣٪ مش قياس حقيقي — لو توصيتك معتمدة عليها، قول ده صراحة في حقل caveat.
6. العملة ريال سعودي وكل الأرقام بدون ضريبة القيمة المضافة.
7. ممنوع النصايح العامة اللي تنفع أي مطعم. كل قرار لازم يكون مربوط بقناة أو صنف أو عرض موجود فعلًا في الأرقام.
8. priority = 1 هي أعلى أثر وأسرع تنفيذ.`;

  const CFO_TOOL = {
    name: "submit_cfo_advice",
    description: "سلّم التحليل المالي والتوصيات بصيغة منظمة.",
    schema: {
      type: "object",
      properties: {
        headline: { type: "string", description: "جملة واحدة تلخّص الوضع المالي بالأرقام" },
        findings: {
          type: "array", minItems: 2, maxItems: 8,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              detail: { type: "string" },
              evidence: { type: "string", description: "رقم حقيقي من البيانات" },
            },
            required: ["title", "detail", "evidence"], additionalProperties: false,
          },
        },
        recommendations: {
          type: "array", minItems: 3, maxItems: 10,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              area: { type: "string", enum: ["channels", "pricing", "menu", "promos", "costs", "ads", "operations"] },
              action: { type: "string" },
              why: { type: "string" },
              evidence: { type: "string", description: "رقم حقيقي منقول من البيانات" },
              expectedImpactSar: { type: "string" },
              risk: { type: "string" },
              caveat: { type: "string", description: "لو التوصية معتمدة على تقدير مش قياس، اكتبه هنا" },
              effort: { type: "string", enum: ["low", "medium", "high"] },
              priority: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["id", "title", "area", "action", "why", "evidence", "expectedImpactSar", "risk", "effort", "priority"],
            additionalProperties: false,
          },
        },
      },
      required: ["headline", "findings", "recommendations"],
      additionalProperties: false,
    },
  };

  /* ── THE EVIDENCE GUARD ──────────────────────────────────────────────────
     Copied in spirit from ai.js's validator and tightened: every number the
     model quotes must actually appear in the evidence pack. We pull all
     numeric tokens out of the pack, and out of the model's `evidence` string,
     and require an overlap. A claim citing "١٢٪" when no 12 exists anywhere in
     the data is exactly the hallucination this whole feature exists to stop.

     Matching is deliberately loose about precision (a model rounding 34.5582 to
     34.56 or to 35 is being helpful, not lying), so a quoted number counts as
     supported if it is within 2% of ANY figure in the pack, or if it appears in
     it verbatim. Arabic-Indic digits are folded to ASCII first. */
  const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "٫": ".", "٬": "" };
  const foldDigits = (s) => String(s).replace(/[٠-٩٫٬]/g, (ch) => AR_DIGITS[ch] ?? ch);

  function collectNumbers(node, into) {
    if (node === null || node === undefined) return into;
    if (typeof node === "number") { if (Number.isFinite(node)) into.add(Math.abs(node)); return into; }
    if (typeof node === "string") {
      for (const m of foldDigits(node).matchAll(/-?\d+(?:\.\d+)?/g)) into.add(Math.abs(Number(m[0])));
      return into;
    }
    if (Array.isArray(node)) { for (const x of node) collectNumbers(x, into); return into; }
    if (typeof node === "object") { for (const x of Object.values(node)) collectNumbers(x, into); return into; }
    return into;
  }

  function evidenceSupported(text, pool2) {
    const quoted = [...foldDigits(String(text)).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Math.abs(Number(m[0])));
    if (!quoted.length) return false; // no number at all → not evidence
    return quoted.some((q) => {
      for (const v of pool2) {
        if (v === q) return true;
        const tol = Math.max(Math.abs(v) * 0.02, 0.01);
        if (Math.abs(v - q) <= tol) return true;
        // Percentages: the pack stores 0.2185, the model writes 21.85 or 22.
        if (Math.abs(v * 100 - q) <= Math.max(Math.abs(v * 100) * 0.02, 0.5)) return true;
      }
      return false;
    });
  }

  function validateAdvice(raw, evidencePack) {
    const numbers = collectNumbers(evidencePack, new Set());
    const str = (v) => (typeof v === "string" ? v.trim() : "");

    const dropped = [];
    const findings = (Array.isArray(raw?.findings) ? raw.findings : []).filter((f) => {
      if (!str(f?.title) || !str(f?.evidence)) return false;
      if (!evidenceSupported(f.evidence, numbers)) { dropped.push(`finding "${str(f.title)}": ${str(f.evidence)}`); return false; }
      return true;
    }).map((f) => ({ title: str(f.title), detail: str(f.detail), evidence: str(f.evidence) }));

    const recommendations = (Array.isArray(raw?.recommendations) ? raw.recommendations : []).filter((r) => {
      if (!str(r?.title) || !str(r?.action) || !str(r?.evidence)) return false;
      if (!evidenceSupported(r.evidence, numbers)) { dropped.push(`recommendation "${str(r.title)}": ${str(r.evidence)}`); return false; }
      return true;
    }).map((r, i) => ({
      id: str(r.id) || `rec-${i + 1}`,
      title: str(r.title),
      area: ["channels", "pricing", "menu", "promos", "costs", "ads", "operations"].includes(str(r.area)) ? str(r.area) : "operations",
      action: str(r.action),
      why: str(r.why),
      evidence: str(r.evidence),
      expectedImpactSar: str(r.expectedImpactSar),
      risk: str(r.risk),
      caveat: str(r.caveat),
      effort: ["low", "medium", "high"].includes(str(r.effort)) ? str(r.effort) : "medium",
      priority: Number.isFinite(Number(r.priority)) ? Math.max(1, Math.min(10, Math.round(Number(r.priority)))) : i + 1,
    })).sort((a, b) => a.priority - b.priority);

    if (recommendations.length < 2) {
      return { ok: false, error: `too few evidence-backed recommendations (dropped ${dropped.length})`, dropped };
    }
    return { ok: true, value: { headline: str(raw?.headline), findings, recommendations, droppedForNoEvidence: dropped } };
  }

  /** The evidence pack: the SAME numbers the P&L screen shows, nothing else. */
  async function buildEvidence(from, to) {
    const cfg = await financeConfig();
    const [list, spend] = await Promise.all([loadEconomics(from, to, cfg), adSpend(from, to)]);

    const overallAgg = emptyAgg();
    const byChannel = new Map();
    for (const e of list) {
      accumulate(overallAgg, e);
      if (!byChannel.has(e.channel)) byChannel.set(e.channel, emptyAgg());
      accumulate(byChannel.get(e.channel), e);
    }
    const overall = shapeAgg(overallAgg);
    const subs = subscriptionsFor(cfg.rates, from, to);
    const subsTotal = Object.values(subs).reduce((a, s) => a + num(s.amount), 0);

    // Item-level contribution, so the CFO can name the dishes that pay.
    const items = (await pool.query(
      `SELECT i.name, sum(i.qty) AS qty, sum(i.amount) AS value_incl,
              count(DISTINCT i.order_id)::int AS orders
         FROM ts_order_items i JOIN ts_orders o ON o.order_id = i.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY value_incl DESC LIMIT 25`, [from, to])).rows.map((r) => {
      const valueEx = num(r.value_incl) / (1 + VAT_RATE);
      return {
        name: r.name, qty: money(r.qty), valueEx: money(valueEx), orders: num(r.orders),
        assumedFoodCostSar: money(valueEx * cfg.foodCostPct),
        assumedGrossMarginSar: money(valueEx * (1 - cfg.foodCostPct)),
      };
    });

    // Discounts: the fastest lever, and the one most often invisible.
    const discountByChannel = [...byChannel.entries()].map(([id, a]) => ({
      channel: CHANNEL_LABEL[id] || id,
      discountSar: money(a.discountEx),
      discountPctOfMenu: ratio(a.discountEx, a.grossEx),
    }));

    const losers = list.filter((e) => e.losesMoney);

    return {
      meta: {
        currency: "SAR", city: "جدة", window: { from, to, days: spanDays(from, to) },
        ordersPriced: list.length,
      },
      assumptions: assumptionsBlock(cfg, {
        foodCostMeasuredShare: overall.foodCostMeasuredShare,
        ordersWithEstimatedNet: list.filter((e) => e.netEstimated).length,
      }),
      overall: {
        ...overall,
        subscriptionsSar: money(subsTotal),
        adSpendSar: spend.total,
        netProfitSar: money(overall.contribution - subsTotal - spend.total),
        netProfitMarginPct: ratio(overall.contribution - subsTotal - spend.total, overall.revenueEx),
      },
      byChannel: [...byChannel.entries()].map(([id, a]) => {
        const s = shapeAgg(a);
        const sub = subs[id] || { amount: 0 };
        return {
          channel: CHANNEL_LABEL[id] || id, channelId: id,
          orders: s.orders, revenueExSar: s.revenueEx, avgOrderExSar: s.avgOrderEx,
          foodCostSar: s.foodCost, commissionSar: s.commission,
          paymentFeeSar: s.paymentFee, deliverySubsidySar: s.deliverySubsidy,
          subscriptionSar: sub.amount,
          contributionSar: money(s.contribution - sub.amount),
          contributionMarginPct: ratio(s.contribution - sub.amount, s.revenueEx),
          platformCostPctOfRevenue: s.platformCostPctOfRevenue,
          losingOrders: s.losingOrders,
          revenueSharePct: ratio(s.revenueEx, overall.revenueEx),
        };
      }).sort((a, b) => b.revenueExSar - a.revenueExSar),
      discounts: discountByChannel,
      losingOrders: {
        count: losers.length,
        sharePct: ratio(losers.length, list.length),
        totalLossSar: money(losers.reduce((a, e) => a + e.netProfit, 0)),
        worst: losers.slice(0, 8).sort((a, b) => a.netProfit - b.netProfit).slice(0, 8).map((e) => ({
          receipt: e.receipt, day: e.day, channel: e.channelLabel,
          revenueExSar: e.revenueEx, foodCostSar: e.foodCost,
          platformCostSar: e.platformCost, lossSar: e.netProfit,
        })),
      },
      topItems: items,
      ads: spend,
      contractRates: Object.fromEntries(Object.entries(cfg.rates).map(([id, a]) => [id, {
        bands: a.bands, paymentFeePct: a.paymentFeePct,
        monthlySubscriptionSar: a.monthlySubscriptionSar,
        subsidyTiers: a.subsidyTiers, subsidyConfirmed: a.subsidyConfirmed !== false,
        caveats: a.caveats,
      }])),
    };
  }

  app.post("/api/finance/advisor", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const body = await c.req.json().catch(() => ({}));
      const from = dayArg(body?.from, daysAgoISO(29));
      const to = dayArg(body?.to, todayISO());
      const force = body?.force === true;

      if (!force) {
        const hit = await pool.query(
          `SELECT * FROM fin_advice
            WHERE from_date=$1::date AND to_date=$2::date
              AND created_at > NOW() - INTERVAL '${CACHE_HOURS} hours'
            ORDER BY created_at DESC LIMIT 1`, [from, to]);
        if (hit.rowCount) {
          const r = hit.rows[0];
          return c.json({
            ok: true, cached: true, from, to, model: r.model,
            generatedAt: r.created_at, evidence: r.evidence, ...r.result,
          });
        }
      }

      const provider = resolveProvider();
      if (!provider) {
        return c.json({
          ok: false, error: "no_llm_provider",
          hint: "set ANTHROPIC_API_KEY, or LITELLM_KEY for the https://llm.o2m8.me/v1 proxy",
        }, 503);
      }

      const evidence = await buildEvidence(from, to);
      // Never pay for a model call with nothing to reason about.
      if (!evidence.meta.ordersPriced) {
        return c.json({ ok: false, error: "no_data", from, to }, 200);
      }

      const user = `دي الأرقام المالية الحقيقية للمطعم في الفترة المطلوبة (JSON):

${JSON.stringify(evidence, null, 1)}

عايز منك تحليل مدير مالي: أنهي قناة (كيتا / هنقرستيشن / نينجا / المطعم نفسه) بتكسب فعلًا بعد العمولة ورسوم الدفع ودعم التوصيل والاشتراك، وأنهي أصناف وعروض بتاكل الربح، وإيه اللي تغيّره بالظبط. قارن هامش كل قناة برقمه، واحسب لو الخصومات دي مستاهلة، وقول رأيك في الطلبات الخسرانة.

استخدم أداة submit_cfo_advice للإجابة. كل بند لازم يكون فيه رقم من البيانات دي بالظبط.`;

      let out = null, lastErr = "";
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        const prompt = attempt === 0 ? user
          : `${user}\n\nملاحظة: المحاولة السابقة اتّرفضت (${lastErr}). كل حقل evidence لازم يكون فيه رقم منقول حرفيًا من البيانات اللي فوق، مش رقم من عندك.`;
        try {
          const raw = await callTool(provider, { system: CFO_SYSTEM, user: prompt, tool: CFO_TOOL });
          const v = validateAdvice(raw, evidence);
          if (v.ok) out = v.value; else lastErr = v.error;
        } catch (e) { lastErr = e.message; }
      }
      if (!out) throw new Error(`model response invalid after retry: ${lastErr}`);

      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO fin_advice (id, from_date, to_date, model, evidence, result)
         VALUES ($1,$2::date,$3::date,$4,$5,$6)`,
        [id, from, to, provider.model, jb(evidence), jb(out)]);

      return c.json({
        ok: true, cached: false, from, to, model: provider.model,
        generatedAt: new Date().toISOString(), evidence, ...out,
      });
    } catch (e) {
      console.error("[finance] advisor failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  console.log("[finance] routes ready");
}

export default { register };
