/* ═══════════════════════════════════════════════════════════════════════════
   KEETA REPORTS — Keeta-only reporting + a Keeta-specialist growth advisor.

   Registered by index.js via `register(app, ctx)` with the shared moduleCtx.
   Everything here is admin-only and READ-ONLY against our own database; the
   only outbound calls are to the Keeta merchant portal, through the connector
   in keeta.js (we reuse its transport, we never re-implement it).

   ── What "a Keeta order" means here ──────────────────────────────────────
   `order_sources.source_note = 'Keeta'` (case-insensitive). Verified on the
   live cache: 152 orders, 115 distinct phones, ZERO orders without an
   identity — Keeta hands us the customer's phone on every single order, which
   is why the customer/retention half of this module is trustworthy in a way
   it is not for walk-ins.

   ── Business rules inherited from analytics.js (do not diverge) ───────────
   1. MONEY IS VAT-INCLUSIVE. TabSense's gross/discount/net EXCLUDE VAT;
      total/gross_incl/discount_incl INCLUDE it. Only the *_incl columns and
      `total` are ever read here, because that is what Omar's receipts say.
   2. VOIDS AND REFUNDS ARE NOT SALES. Excluded everywhere.
   3. THE BUSINESS DAY IS `calendar_day` (TabSense already rolls it over at
      04:00 Riyadh). We group by it and never re-derive a day from order_date.
      Hour-of-day reporting still uses the real Riyadh wall clock, so the
      late-night Keeta peak reads as 00:00–02:00 on the evening it belongs to.
   4. The shared new-customer rule lives in analytics.js (FIRST_ORDER_DAY_CTE)
      and is imported, not copied — "new to Keeta" and "new to the restaurant"
      are two different questions and this module answers both.
═══════════════════════════════════════════════════════════════════════════ */

import { FIRST_ORDER_DAY_CTE } from "./analytics.js";
import { keetaCall, KeetaError, num as kNum, configured as keetaConfigured } from "./keeta.js";

const TZ = "Asia/Riyadh";

/* The portal addresses the shop by id and the ads BFF by ACCOUNT id. keeta.js
   keeps these as module-private constants, so growth reads them from the same
   env vars with the same defaults rather than exporting internals. If you
   change them, change them in both files. */
const SHOP_ID = process.env.KEETA_SHOP_ID || "1430391221";
const ACCT_ID = process.env.KEETA_ACCT_ID || "4611686018430691085";

/* ═══════════════════════════════════════════════════════════════════════════
   KEETA CONTRACT — the documented defaults, all overridable from `settings`.

   Read from `settings.data.keetaFees` (the settings row is a single jsonb
   blob; the key does not exist yet, so every figure below is the CONTRACT
   DEFAULT until Omar saves an override). Every response ships the fee model it
   used under `fees`, so a commission number on screen is always auditable.

   ⚠️ SUBSIDY TIERS — OMAR MUST CONFIRM THE PAIRING. The merchant-funded
   delivery subsidy is a five-tier table by order value, but the contract PDF
   is right-to-left and its text extraction pairs the value column and the
   subsidy column ambiguously: it is not certain from the file whether "≤30 →
   4" or "≤30 → 15" is the real row. The pairing below is our best reading and
   it is CONFIGURABLE precisely because it is not verified. Until Omar
   confirms it against a real Keeta settlement statement, treat
   `subsidyCostSAR` as an estimate and say so on screen.

   ⚠️ COMMISSION BASE. We apply the rates to the VAT-INCLUSIVE order total,
   because that is the number on the receipt and the only one we can show
   Omar without a second explanation. If a settlement statement shows Keeta
   billing on the VAT-exclusive net instead, flip `commissionBase` to "net".
═══════════════════════════════════════════════════════════════════════════ */
const FEE_DEFAULTS = {
  deliveryCommissionRate: 0.18,   // 8% data service + 10% delivery service
  pickupServiceRate: 0.03,        // استلام شخصي
  paymentFeeRate: 0.025,          // bank / payment processing
  minServiceFeeSAR: 1,            // floor on the service fee, per order
  commissionBase: "total",        // "total" (VAT-incl) | "net" (VAT-excl)
  subsidyEnabled: true,
  // ⚠️ pairing unconfirmed — see the block comment above.
  subsidyTiers: [
    { upTo: 30, sar: 4 },
    { upTo: 35, sar: 9 },
    { upTo: 45, sar: 11 },
    { upTo: 55, sar: 12 },
    { upTo: 70, sar: 15 },
  ],
  // One-off, not per-order. Shown as context, never mixed into per-order cost.
  oneOffPosFeeSAR: 500,
  oneOffPhotographyFeeSAR: 500,
};

/* ── numeric helpers — same contract as analytics.js ─────────────────────── */
const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(n0(v) * 100) / 100;
const qtyR = (v) => Math.round(n0(v) * 1000) / 1000;
const rate = (v) => (v === null || v === undefined ? null : Math.round(n0(v) * 10000) / 10000);
/** null (not 0, not Infinity) when there is nothing to divide by — the UI must
 *  be able to render "—" for "no basis" instead of a fake zero. */
const ratio = (a, b) => (n0(b) === 0 ? null : rate(n0(a) / n0(b)));
const delta = (cur, base) => (base === null || base === undefined || n0(base) === 0 ? null : rate((n0(cur) - n0(base)) / n0(base)));

const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayArg = (v, fallback) => (typeof v === "string" && DAY_RE.test(v) ? v : fallback);
const shiftDay = (iso, k) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);
const compactDay = (iso) => String(iso || "").replace(/-/g, "").slice(0, 8);

/* ═══════════════════════════════════════════════════════════════════════════
   SQL — one CTE, reused by every query in the file.
   Verified against the live cache (152 rows, 115 idents, 0 unidentified).
═══════════════════════════════════════════════════════════════════════════ */
const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

// Pickup vs delivery changes which rate applies. The POS types EVERY Keeta
// order as order_option 'Dine in' / order_type 'External' (checked: 152/152),
// so this predicate currently matches nothing — it is here so the fee model
// stays correct the day Keeta pickup orders start arriving, and the response
// reports `pickupOrders` so a silent misclassification is visible.
const IS_PICKUP = `(o.order_option ILIKE '%pick%' OR o.order_option ILIKE '%استلام%')`;

const KEETA_CTE = `
  keeta AS (
    SELECT o.order_id, o.calendar_day, o.order_date,
           o.total, o.gross_incl, o.discount_incl,
           ${IS_PICKUP} AS is_pickup,
           COALESCE(NULLIF(s.phone_norm, ''), NULLIF(tc.phone_norm, '')) AS ident,
           COALESCE(NULLIF(tc.name, ''),  NULLIF(s.customer_name, ''))  AS cname,
           COALESCE(NULLIF(tc.phone, ''), NULLIF(s.customer_phone, '')) AS cphone
      FROM ts_orders o
      JOIN order_sources s  ON s.order_id = o.order_id
      LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
     WHERE lower(COALESCE(s.source_note, '')) = 'keeta' AND ${SALES_ONLY}
  ),
  kfirst AS (
    -- First day this human EVER ordered on Keeta (all history, not the window).
    SELECT ident, min(calendar_day) AS first_day
      FROM keeta WHERE ident IS NOT NULL GROUP BY 1
  ),
  klife AS (
    -- Lifetime Keeta footprint per human — needed so "days since last order"
    -- is measured against their real last order, not the last one that happens
    -- to fall inside the chosen window.
    SELECT ident, min(calendar_day) AS first_day, max(calendar_day) AS last_day,
           count(*)::int AS orders, COALESCE(sum(total), 0) AS spent
      FROM keeta WHERE ident IS NOT NULL GROUP BY 1
  )`;

/* ═══════════════════════════════════════════════════════════════════════════
   FEE MODEL
═══════════════════════════════════════════════════════════════════════════ */

function resolveFees(settings) {
  const raw = (settings && typeof settings.keetaFees === "object" && settings.keetaFees) || {};
  const tiers = Array.isArray(raw.subsidyTiers) && raw.subsidyTiers.length
    ? raw.subsidyTiers
      .map((t) => ({ upTo: Number(t?.upTo), sar: Number(t?.sar) }))
      .filter((t) => Number.isFinite(t.upTo) && Number.isFinite(t.sar))
      .sort((a, b) => a.upTo - b.upTo)
    : FEE_DEFAULTS.subsidyTiers;
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    deliveryCommissionRate: numOr(raw.deliveryCommissionRate, FEE_DEFAULTS.deliveryCommissionRate),
    pickupServiceRate: numOr(raw.pickupServiceRate, FEE_DEFAULTS.pickupServiceRate),
    paymentFeeRate: numOr(raw.paymentFeeRate, FEE_DEFAULTS.paymentFeeRate),
    minServiceFeeSAR: numOr(raw.minServiceFeeSAR, FEE_DEFAULTS.minServiceFeeSAR),
    commissionBase: raw.commissionBase === "net" ? "net" : "total",
    subsidyEnabled: raw.subsidyEnabled === undefined ? FEE_DEFAULTS.subsidyEnabled : !!raw.subsidyEnabled,
    subsidyTiers: tiers.length ? tiers : FEE_DEFAULTS.subsidyTiers,
    oneOffPosFeeSAR: numOr(raw.oneOffPosFeeSAR, FEE_DEFAULTS.oneOffPosFeeSAR),
    oneOffPhotographyFeeSAR: numOr(raw.oneOffPhotographyFeeSAR, FEE_DEFAULTS.oneOffPhotographyFeeSAR),
    // Surfaced so the UI can print the caveat next to the number rather than
    // presenting an estimate as a settled fact.
    subsidyPairingConfirmed: raw.subsidyPairingConfirmed === true,
    source: Object.keys(raw).length ? "settings.keetaFees" : "contract defaults (settings.keetaFees not set)",
  };
}

/**
 * Per-order fee model over the raw order rows.
 * Returns null when there are no orders — an empty window has no commission,
 * and reporting "0 ر.س عمولة" would read as a measurement instead of "no data".
 */
function applyFees(rows, fees) {
  if (!rows.length) return null;
  let serviceFee = 0, paymentFee = 0, subsidy = 0;
  let minFeeHits = 0, aboveTopTier = 0, pickupOrders = 0, base = 0;
  const tierHits = new Map();

  for (const r of rows) {
    const v = fees.commissionBase === "net" ? n0(r.net_base) : n0(r.total);
    base += v;
    const isPickup = !!r.is_pickup;
    if (isPickup) pickupOrders++;

    let sf = v * (isPickup ? fees.pickupServiceRate : fees.deliveryCommissionRate);
    if (sf < fees.minServiceFeeSAR) { sf = fees.minServiceFeeSAR; minFeeHits++; }
    serviceFee += sf;
    paymentFee += v * fees.paymentFeeRate;

    // The merchant-funded delivery subsidy applies to delivery, not pickup.
    if (fees.subsidyEnabled && !isPickup) {
      const tier = fees.subsidyTiers.find((t) => v <= t.upTo);
      if (tier) {
        subsidy += tier.sar;
        tierHits.set(tier.upTo, (tierHits.get(tier.upTo) || 0) + 1);
      } else {
        // Above the top documented tier the contract says nothing, so we add
        // nothing and count it instead of inventing a sixth tier.
        aboveTopTier++;
      }
    }
  }

  const totalCost = serviceFee + paymentFee + subsidy;
  return {
    orders: rows.length,
    pickupOrders,
    commissionBase: fees.commissionBase,
    baseSAR: money(base),
    serviceFeeSAR: money(serviceFee),
    paymentFeeSAR: money(paymentFee),
    subsidySAR: money(subsidy),
    totalCostSAR: money(totalCost),
    costShareOfRevenue: ratio(totalCost, base),
    avgCostPerOrderSAR: money(totalCost / rows.length),
    minFeeOrders: minFeeHits,
    ordersAboveTopTier: aboveTopTier,
    tierBreakdown: fees.subsidyTiers.map((t) => ({
      upToSAR: t.upTo, subsidySAR: t.sar, orders: tierHits.get(t.upTo) || 0,
    })),
    // Honesty flag the UI must render next to any subsidy figure.
    subsidyEstimated: !fees.subsidyPairingConfirmed,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATA BUILDERS — shared by the routes and by the advisor's evidence pack.
═══════════════════════════════════════════════════════════════════════════ */

async function loadOverview(pool, fees, from, to) {
  const P = [from, to];
  const days = spanDays(from, to);
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(prevTo, -(days - 1));

  const [totalsQ, repeatQ, dailyQ, hourQ, itemsQ, ordersQ, prevQ] = await Promise.all([
    // Headline totals + the two different "new customer" questions.
    pool.query(
      `WITH ${KEETA_CTE}, ${FIRST_ORDER_DAY_CTE}
       SELECT count(*)::int                                   AS orders,
              COALESCE(sum(k.total), 0)                       AS revenue,
              COALESCE(sum(k.gross_incl), 0)                  AS gross_incl,
              COALESCE(sum(k.discount_incl), 0)               AS discount,
              count(DISTINCT k.ident)::int                    AS customers,
              count(*) FILTER (WHERE k.ident IS NULL)::int    AS unidentified_orders,
              count(*) FILTER (WHERE k.ident IS NOT NULL)::int AS identified_orders,
              -- new to KEETA: first Keeta order ever falls inside the window
              count(DISTINCT k.ident) FILTER (
                WHERE kf.first_day BETWEEN $1::date AND $2::date)::int AS new_to_keeta,
              -- new to the RESTAURANT: shared rule, any channel
              count(DISTINCT k.ident) FILTER (
                WHERE f.first_day BETWEEN $1::date AND $2::date)::int  AS new_to_restaurant,
              count(*) FILTER (WHERE kf.first_day < k.calendar_day)::int AS returning_orders,
              min(k.calendar_day)::text AS first_day,
              max(k.calendar_day)::text AS last_day
         FROM keeta k
         LEFT JOIN kfirst kf ON kf.ident = k.ident
         LEFT JOIN firsts f  ON f.pn     = k.ident
        WHERE k.calendar_day BETWEEN $1::date AND $2::date`, P),

    // Repeat behaviour measured INSIDE the window (ordered 2+ times here).
    pool.query(
      `WITH ${KEETA_CTE},
       inwin AS (
         SELECT k.ident, count(*)::int AS n
           FROM keeta k
          WHERE k.calendar_day BETWEEN $1::date AND $2::date AND k.ident IS NOT NULL
          GROUP BY 1
       )
       SELECT count(*)::int AS customers,
              count(*) FILTER (WHERE n >= 2)::int AS repeat_customers,
              COALESCE(avg(n), 0) AS avg_orders_per_customer,
              COALESCE(max(n), 0)::int AS max_orders_one_customer
         FROM inwin`, P),

    pool.query(
      `WITH ${KEETA_CTE}
       SELECT k.calendar_day AS "day", count(*)::int AS orders,
              COALESCE(sum(k.total), 0) AS revenue,
              count(DISTINCT k.ident)::int AS customers
         FROM keeta k
        WHERE k.calendar_day BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 1`, P),

    // Riyadh wall clock — deliberately NOT the business-day offset. Only hours
    // that actually saw an order are returned; a bar for an hour the shop was
    // shut is not a measurement.
    pool.query(
      `WITH ${KEETA_CTE}
       SELECT extract(hour from (k.order_date AT TIME ZONE '${TZ}'))::int AS "hour",
              count(*)::int AS orders, COALESCE(sum(k.total), 0) AS revenue
         FROM keeta k
        WHERE k.calendar_day BETWEEN $1::date AND $2::date AND k.order_date IS NOT NULL
        GROUP BY 1 ORDER BY 1`, P),

    pool.query(
      `WITH ${KEETA_CTE}
       SELECT i.name, sum(i.qty) AS qty, sum(i.amount) AS revenue,
              count(DISTINCT i.order_id)::int AS orders
         FROM ts_order_items i
         JOIN keeta k ON k.order_id = i.order_id
        WHERE k.calendar_day BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY revenue DESC`, P),

    // Per-order rows for the fee model. `net_base` is only read when
    // commissionBase = "net"; it is the VAT-exclusive figure TabSense stores.
    pool.query(
      `WITH ${KEETA_CTE}
       SELECT k.order_id, k.total::float8 AS total, k.is_pickup,
              (SELECT o2.net::float8 FROM ts_orders o2 WHERE o2.order_id = k.order_id) AS net_base
         FROM keeta k
        WHERE k.calendar_day BETWEEN $1::date AND $2::date`, P),

    pool.query(
      `WITH ${KEETA_CTE}
       SELECT count(*)::int AS orders, COALESCE(sum(k.total), 0) AS revenue,
              count(DISTINCT k.ident)::int AS customers
         FROM keeta k
        WHERE k.calendar_day BETWEEN $1::date AND $2::date`, [prevFrom, prevTo]),
  ]);

  const t = totalsQ.rows[0] || {};
  const rp = repeatQ.rows[0] || {};
  const pv = prevQ.rows[0] || {};

  const orders = n0(t.orders);
  const revenue = money(t.revenue);
  const prevOrders = n0(pv.orders);
  const prevRevenue = money(pv.revenue);

  const daily = dailyQ.rows.map((r) => ({
    day: isoDay(r.day), orders: n0(r.orders), revenue: money(r.revenue), customers: n0(r.customers),
  }));
  const hours = hourQ.rows.map((r) => ({ hour: n0(r.hour), orders: n0(r.orders), revenue: money(r.revenue) }));
  const itemRows = itemsQ.rows.map((r) => ({
    name: r.name, qty: qtyR(r.qty), revenue: money(r.revenue), orders: n0(r.orders),
  }));
  const itemRevenue = itemRows.reduce((a, r) => a + r.revenue, 0);

  const cost = applyFees(ordersQ.rows, fees);
  const peak = [...hours].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue)[0] || null;

  return {
    from, to, days,
    previousWindow: { from: prevFrom, to: prevTo },
    dataSpan: { first: t.first_day || null, last: t.last_day || null },
    totals: {
      orders,
      revenueSAR: revenue,
      grossInclSAR: money(t.gross_incl),
      discountSAR: money(t.discount),
      discountRatio: ratio(t.discount, t.gross_incl),
      avgOrderSAR: orders > 0 ? money(revenue / orders) : null,
      ordersPerDay: orders > 0 ? Math.round((orders / days) * 100) / 100 : null,
      revenuePerDaySAR: orders > 0 ? money(revenue / days) : null,
      customers: n0(t.customers),
      identifiedOrders: n0(t.identified_orders),
      unidentifiedOrders: n0(t.unidentified_orders),
      // Keeta gives us a phone on every order, so this is normally 1.0. If it
      // ever drops, every customer number below is only that reliable.
      identificationRate: ratio(t.identified_orders, t.orders),
    },
    customers: {
      distinct: n0(rp.customers),
      newToKeeta: n0(t.new_to_keeta),
      newToRestaurant: n0(t.new_to_restaurant),
      returningOrders: n0(t.returning_orders),
      returningOrderShare: ratio(t.returning_orders, t.identified_orders),
      repeatCustomers: n0(rp.repeat_customers),
      repeatRate: ratio(rp.repeat_customers, rp.customers),
      avgOrdersPerCustomer: Math.round(n0(rp.avg_orders_per_customer) * 100) / 100,
      maxOrdersOneCustomer: n0(rp.max_orders_one_customer),
    },
    cost,
    net: cost ? {
      afterKeetaCostSAR: money(revenue - cost.totalCostSAR),
      marginAfterKeetaCost: ratio(revenue - cost.totalCostSAR, revenue),
      // Food/labour are NOT in here. This is revenue minus what Keeta takes,
      // not profit, and the UI must label it that way.
      note: "الإيراد بعد خصم تكلفة كيتا فقط — مش ربح صافي (التكلفة والعمالة مش محسوبة).",
    } : null,
    previous: { orders: prevOrders, revenueSAR: prevRevenue, customers: n0(pv.customers) },
    delta: {
      orders: delta(orders, prevOrders),
      revenue: delta(revenue, prevRevenue),
      avgOrder: delta(orders > 0 ? revenue / orders : 0, prevOrders > 0 ? prevRevenue / prevOrders : 0),
    },
    daily,
    hours,
    peakHour: peak,
    items: {
      distinct: itemRows.length,
      totalRevenueSAR: money(itemRevenue),
      topByRevenue: itemRows.slice(0, 15).map((r) => ({ ...r, revenueShare: ratio(r.revenue, itemRevenue) })),
      topByQty: [...itemRows].sort((a, b) => b.qty - a.qty).slice(0, 15),
      // Present but barely moving — the menu-pruning / re-photographing list.
      slowest: [...itemRows].sort((a, b) => a.qty - b.qty).slice(0, 10),
    },
    fees,
  };
}

const LAPSED_DAYS = 21;   // 21+ days silent on Keeta = lapsed
const VIP_TOP_SHARE = 0.2; // top 20% by spend inside the window

async function loadCustomers(pool, from, to) {
  const rows = (await pool.query(
    `WITH ${KEETA_CTE},
     inwin AS (
       SELECT k.ident,
              max(k.cname)  AS name,
              max(k.cphone) AS phone,
              count(*)::int AS orders,
              COALESCE(sum(k.total), 0) AS spent,
              min(k.calendar_day) AS first_in_window,
              max(k.calendar_day) AS last_in_window
         FROM keeta k
        WHERE k.calendar_day BETWEEN $1::date AND $2::date AND k.ident IS NOT NULL
        GROUP BY 1
     )
     SELECT w.*,
            l.first_day AS first_ever, l.last_day AS last_ever,
            l.orders    AS lifetime_orders, l.spent AS lifetime_spent,
            ($2::date - l.last_day)::int AS days_since_last,
            CASE WHEN l.orders > 1
                 THEN round((l.last_day - l.first_day)::numeric / (l.orders - 1), 1)
            END AS avg_gap_days
       FROM inwin w JOIN klife l ON l.ident = w.ident
      ORDER BY w.spent DESC`, [from, to]
  )).rows;

  const shaped = rows.map((r) => ({
    ident: r.ident,
    name: r.name || null,
    phone: r.phone || r.ident || null,
    orders: n0(r.orders),
    spendSAR: money(r.spent),
    avgOrderSAR: n0(r.orders) > 0 ? money(n0(r.spent) / n0(r.orders)) : null,
    firstOrder: isoDay(r.first_ever),
    lastOrder: isoDay(r.last_ever),
    firstOrderInWindow: isoDay(r.first_in_window),
    lastOrderInWindow: isoDay(r.last_in_window),
    lifetimeOrders: n0(r.lifetime_orders),
    lifetimeSpendSAR: money(r.lifetime_spent),
    // Measured from the END of the chosen window, not from "now" — otherwise a
    // report on a past month would call everyone lapsed.
    daysSinceLast: r.days_since_last === null ? null : n0(r.days_since_last),
    avgDaysBetween: r.avg_gap_days === null ? null : Math.round(n0(r.avg_gap_days) * 10) / 10,
    lapsed: r.days_since_last !== null && n0(r.days_since_last) >= LAPSED_DAYS,
    vip: false,
  }));

  // VIP = top 20% by in-window spend. On a 5-customer window that is 1 person,
  // which is the honest answer; ceil() never yields an empty VIP set.
  const vipCount = shaped.length ? Math.max(1, Math.ceil(shaped.length * VIP_TOP_SHARE)) : 0;
  for (let i = 0; i < vipCount; i++) shaped[i].vip = true;
  const vipThreshold = vipCount ? shaped[vipCount - 1].spendSAR : null;

  const lapsed = shaped.filter((x) => x.lapsed);
  const repeat = shaped.filter((x) => x.orders >= 2);
  const oneTime = shaped.filter((x) => x.lifetimeOrders === 1);
  const spendTotal = shaped.reduce((a, x) => a + x.spendSAR, 0);
  const vipSpend = shaped.filter((x) => x.vip).reduce((a, x) => a + x.spendSAR, 0);
  const gaps = shaped.map((x) => x.avgDaysBetween).filter((v) => v !== null);

  return {
    from, to,
    rules: { lapsedAfterDays: LAPSED_DAYS, vipTopShare: VIP_TOP_SHARE, vipSpendThresholdSAR: vipThreshold,
      recencyMeasuredFrom: to },
    summary: {
      customers: shaped.length,
      repeatCustomers: repeat.length,
      repeatRate: ratio(repeat.length, shaped.length),
      oneTimeCustomers: oneTime.length,
      lapsedCustomers: lapsed.length,
      lapsedRate: ratio(lapsed.length, shaped.length),
      lapsedSpendAtRiskSAR: money(lapsed.reduce((a, x) => a + x.lifetimeSpendSAR, 0)),
      vipCustomers: vipCount,
      vipSpendSAR: money(vipSpend),
      vipShareOfSpend: ratio(vipSpend, spendTotal),
      avgSpendPerCustomerSAR: shaped.length ? money(spendTotal / shaped.length) : null,
      medianDaysBetweenOrders: gaps.length
        ? (() => { const s = [...gaps].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
          return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10; })()
        : null,
    },
    customers: shaped,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROWTH — the merchant portal joined to our own orders.

   The portal is behind a human-refreshed cookie (see keeta.js), so it is
   EXPECTED to be down sometimes. This route must therefore never 500: it
   answers { ok:true, portal:false, reason } and still ships our own numbers,
   because "the ad panel is asleep" is not a reason to hide the sales data.
═══════════════════════════════════════════════════════════════════════════ */

/** keeta.js keeps its daily-row normaliser private; this is the same four
 *  fields off the same payload, using its exported `num` parser (their values
 *  arrive as RTL-marked display strings, not numbers). */
function adDailyRow(r) {
  return {
    day: (() => { const s = String(r?.time || ""); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10); })(),
    impressions: kNum(r?.showCount),
    clicks: kNum(r?.clickCount),
    adOrders: kNum(r?.orders),
    adRevenueSAR: kNum(r?.adrevenue),
    spendSAR: kNum(r?.debit),
  };
}

async function loadGrowth(pool, from, to) {
  // Our own side always resolves, portal or no portal.
  const ourRows = (await pool.query(
    `WITH ${KEETA_CTE}
     SELECT k.calendar_day AS "day", count(*)::int AS orders,
            COALESCE(sum(k.total), 0) AS revenue
       FROM keeta k
      WHERE k.calendar_day BETWEEN $1::date AND $2::date
      GROUP BY 1 ORDER BY 1`, [from, to]
  )).rows;
  const ours = ourRows.map((r) => ({ day: isoDay(r.day), orders: n0(r.orders), revenue: money(r.revenue) }));

  // Summed BEFORE rounding — adding up 26 already-rounded days drifts a few
  // halalas away from the same total on the overview tab, and two tabs
  // disagreeing about one number is how a report loses its credibility.
  const oursTotals = {
    orders: ourRows.reduce((a, r) => a + n0(r.orders), 0),
    revenueSAR: money(ourRows.reduce((a, r) => a + n0(r.revenue), 0)),
  };

  if (!keetaConfigured()) {
    return {
      ok: true, from, to, portal: false,
      reason: "كيتا مش مربوطة — الناقص KEETA_COOKIE أو KEETA_SHOP_ID",
      expired: true, ours, oursTotals,
    };
  }

  let plan = null, his = null, reason = null, expired = false;
  const errors = [];
  const [planR, hisR] = await Promise.allSettled([
    keetaCall("/api/bff/ad/poi/v1/sspcpc/plan/query", undefined, { query: { targetAcctId: ACCT_ID, shopId: SHOP_ID } }),
    keetaCall("/api/bff/ad/poi/v1/sspcpc/data/query/his", {
      targetAcctId: ACCT_ID, startDate: compactDay(from), endDate: compactDay(to),
    }),
  ]);
  if (planR.status === "fulfilled") plan = planR.value; else errors.push(`plan: ${planR.reason?.message || planR.reason}`);
  if (hisR.status === "fulfilled") his = hisR.value; else errors.push(`data: ${hisR.reason?.message || hisR.reason}`);

  for (const r of [planR, hisR]) {
    if (r.status === "rejected" && r.reason instanceof KeetaError && r.reason.expired) expired = true;
  }

  if (!plan && !his) {
    // Both halves failed — the portal is genuinely unreachable. Still 200.
    reason = errors[0] || "تعذر الوصول إلى بوابة كيتا";
    return { ok: true, from, to, portal: false, expired, reason, errors, ours, oursTotals };
  }

  const totalsRaw = his?.total?.selfData || null;
  const impressions = kNum(totalsRaw?.showCount);
  const clicks = kNum(totalsRaw?.clickCount);
  const adOrders = kNum(totalsRaw?.orders);
  const adRevenue = kNum(totalsRaw?.adrevenue);
  const spend = kNum(totalsRaw?.debit);

  const daily = (his?.details?.selfData || []).map(adDailyRow);
  const oursByDay = new Map(ours.map((r) => [r.day, r]));
  const joined = daily.map((d) => {
    const o = oursByDay.get(d.day);
    return {
      ...d,
      ourOrders: o ? o.orders : 0,
      ourRevenueSAR: o ? o.revenue : 0,
      // What share of the Keeta orders we actually booked that day did the ad
      // claim credit for. >1 means their attribution window is wider than ours.
      adOrderShare: o && o.orders ? ratio(d.adOrders, o.orders) : null,
      costPerOurOrderSAR: o && o.orders && d.spendSAR ? money(d.spendSAR / o.orders) : null,
    };
  });
  // Days where we sold but the ad report has no row at all.
  for (const o of ours) {
    if (!daily.some((d) => d.day === o.day)) {
      joined.push({ day: o.day, impressions: null, clicks: null, adOrders: null, adRevenueSAR: null,
        spendSAR: null, ourOrders: o.orders, ourRevenueSAR: o.revenue, adOrderShare: null, costPerOurOrderSAR: null });
    }
  }
  joined.sort((a, b) => String(a.day).localeCompare(String(b.day)));

  const planUnit = (plan?.unitList || [])[0] || {};
  const budget = plan?.budget == null ? null : kNum(plan.budget) / 100;
  const budgetUsed = plan?.budgetUsed == null ? null : kNum(plan.budgetUsed) / 100;

  return {
    ok: true, from, to, portal: true, expired: false,
    errors: errors.length ? errors : undefined,
    campaign: plan ? {
      planId: plan.planId ?? null,
      active: plan.status === 0,
      budgetSAR: budget,
      spentInPeriodSAR: budgetUsed,
      remainingSAR: budget === null || budgetUsed === null ? null : money(budget - budgetUsed),
      remainingPercent: plan.budgetRemainingPercent ?? null,
      bid: planUnit.bid == null ? null : kNum(planUnit.bid),
      targetRoi: planUnit.targetRoi ?? null,
    } : null,
    ads: totalsRaw ? {
      impressions, clicks, adOrders,
      adRevenueSAR: adRevenue,
      spendSAR: spend,
      ctr: ratio(clicks, impressions),
      cpcSAR: clicks ? money(spend / clicks) : null,
      clickToOrder: ratio(adOrders, clicks),
      // Keeta reports its own ROAS; keep both, they use different attribution.
      roasReported: kNum(totalsRaw?.roas),
      roasComputed: spend ? Math.round((adRevenue / spend) * 100) / 100 : null,
    } : null,
    // The honest cross-check: OUR booked Keeta revenue against THEIR spend.
    blended: totalsRaw ? {
      ourOrders: oursTotals.orders,
      ourRevenueSAR: oursTotals.revenueSAR,
      spendSAR: spend,
      costPerOurOrderSAR: oursTotals.orders && spend ? money(spend / oursTotals.orders) : null,
      spendShareOfOurRevenue: ratio(spend, oursTotals.revenueSAR),
      blendedRoas: spend ? Math.round((oursTotals.revenueSAR / spend) * 100) / 100 : null,
      note: "المقارنة دي بين صرف الإعلان في البوابة وبين طلبات كيتا اللي دخلت الكاشير فعلًا — مش إسناد إعلاني، ده مقياس تكلفة إجمالية.",
    } : null,
    daily: joined,
    ours, oursTotals,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADVISOR — a Keeta growth specialist, grounded in the numbers above.

   Same contract as ai.js: the model gets a facts pack, is told (in Egyptian
   Arabic) that every recommendation must quote a real number from it, answers
   through a forced tool call, and then EVERY recommendation is checked against
   the pack before it can reach the screen. The guard is the feature.
═══════════════════════════════════════════════════════════════════════════ */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const MAX_TOKENS = 12000;
const LLM_TIMEOUT_MS = 180000;
const ADVISOR_CACHE_MS = 6 * 3600 * 1000;

function resolveProvider() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: DEFAULT_MODEL };
  }
  if (process.env.LITELLM_KEY) {
    // The proxy routes Anthropic models under an "anthropic/" prefix. A bare
    // model id 404s on its wildcard route.
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
    // Never echo credentials — only the provider's own body.
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
    const block = (data.content || []).find((b) => b.type === "tool_use");
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

/* ── the evidence guard ──────────────────────────────────────────────────────
   ai.js drops any idea whose `evidence` field is empty. That catches the lazy
   case but not the dangerous one: a confident sentence containing a number the
   model made up. So we go one step further and require the evidence string to
   quote a number that is ACTUALLY IN THE PACK. Every numeric leaf of the pack
   is collected, along with its ×100 form (so "18%" matches a stored 0.18) and
   its 0/1/2-decimal roundings (so "62.73" matches 62.7269...). A recommendation
   whose evidence cites nothing real does not reach the screen. */
function collectNumbers(node, out = new Set()) {
  if (node === null || node === undefined) return out;
  if (typeof node === "number") {
    if (!Number.isFinite(node)) return out;
    out.add(node);
    out.add(Math.round(node));
    out.add(Math.round(node * 10) / 10);
    out.add(Math.round(node * 100) / 100);
    const p = node * 100;                       // fraction rendered as a percent
    if (Math.abs(p) < 1e12) {
      out.add(p); out.add(Math.round(p)); out.add(Math.round(p * 10) / 10);
    }
    return out;
  }
  if (Array.isArray(node)) { for (const x of node) collectNumbers(x, out); return out; }
  if (typeof node === "object") { for (const k of Object.keys(node)) collectNumbers(node[k], out); return out; }
  return out;
}

const NUM_TOKEN = /-?\d[\d,]*(?:\.\d+)?/g;

/* An Arabic-speaking model writes its numbers in Arabic-Indic digits — "٢٠٠٠
   ريال", not "2000". Caught live: the moment the prompt asked for Arabic prose
   in `evidence` instead of a JSON path, an ASCII-only regex stopped matching
   ANYTHING and the guard threw away a perfectly well-grounded plan. So every
   candidate string is folded to ASCII digits before it is checked:
     ٠-٩ (U+0660..0669) · ۰-۹ (U+06F0..06F9) · ٫ decimal · ٬ thousands. */
function foldDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, ".")
    .replace(/[٬،]/g, ",");
}

function citesRealNumber(text, pool) {
  const s = foldDigits(text || "");
  const tokens = s.match(NUM_TOKEN);
  if (!tokens) return false;
  for (const raw of tokens) {
    const v = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    // A bare year / tiny integer is not evidence on its own, but it is also not
    // a lie — only reject when NOTHING in the string matches the pack.
    for (const p of pool) {
      const tol = Math.max(0.01, Math.abs(p) * 0.005);
      if (Math.abs(v - p) <= tol) return true;
    }
  }
  return false;
}

const ADVISOR_SYSTEM = `أنت مستشار نمو متخصص في منصة "كيتا" (Keeta) لمطعم "فريش كتس" في جدة بالسعودية.

قواعد صارمة ماينفعش تكسرها:
1. بتتكلم عربي باللهجة المصرية العامية، كلام مباشر وعملي كأنك قاعد مع صاحب المطعم.
2. كل توصية لازم تكون مبنية على رقم حقيقي موجود في حزمة الأرقام (evidence) اللي هتستلمها، والرقم ده لازم تكتبه بالنص في حقل evidence بتاع التوصية.
3. ممنوع تمامًا تخترع أي رقم. لو رقم مش موجود في الحزمة، ما تذكرهوش. لو البيانات ناقصة في نقطة، قول إنها ناقصة بدل ما تخمّن.
4. ممنوع الكلام العام اللي ينفع أي مطعم. كل فكرة لازم تكون مربوطة بصنف أو ساعة أو شريحة عملاء أو رقم عمولة موجود فعلًا في البيانات دي.
5. كن صادق في حجم الأثر. ما توعدش بمضاعفات خيالية زي "٣٠ ضعف". قول بالظبط الرقم اللي البيانات تسنده، ولو الفترة قصيرة أو العينة صغيرة قول كده صراحة.
6. العملة ريال سعودي شامل الضريبة. التوقيت توقيت الرياض. اليوم التجاري بيبدأ ٤ الفجر.
7. رتّب التوصيات: priority = 1 هي الأعلى أثرًا وأسرع تنفيذًا.
8. غطّي المحاور دي لما البيانات تسمح: التسعير وتأثير عمولة كيتا، تشكيلة الأصناف، شرايح العروض والدعم، ميزانية الإعلان، تغطية ساعات الذروة، واسترجاع العملاء المتوقفين.`;

const ADVISOR_TOOL = {
  name: "submit_keeta_plan",
  description: "سلّم خطة نمو كيتا النهائية بصيغة منظمة.",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "٣ إلى ٥ جمل: وضع كيتا دلوقتي بالأرقام." },
      // Required on purpose: left optional, the model folds its caveats into
      // the summary and the limits of the data stop being a separate,
      // always-visible block on screen.
      honesty: { type: "string", description: "حدود البيانات صراحةً: قِصر الفترة، صغر العينة، أي رقم تقديري زي دعم التوصيل، وأي حاجة مش مقدر تتأكد منها من الأرقام دي." },
      actions: {
        type: "array", minItems: 3, maxItems: 10,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "معرّف قصير بالإنجليزي، مثل lapsed-winback-sms" },
            title: { type: "string" },
            area: { type: "string", enum: ["pricing", "items", "promos", "ads", "hours", "winback", "operations"] },
            why: { type: "string" },
            // Prose, not a JSON path: the owner reads this line on his phone.
            evidence: { type: "string", description: "جملة عربية قصيرة فيها رقم حقيقي منقول بالظبط من حزمة الأرقام مع اسمه بالعربي — مش مسار JSON. مثال: «ميزانية الإعلان ٢٠٠٠ ريال والمصروف منها ٧٦.٩٢ ريال بس»." },
            how: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
            expectedImpact: { type: "string", description: "أثر واقعي مربوط برقم، من غير مبالغة" },
            howToMeasure: { type: "string", description: "إزاي نعرف إنها نجحت وامتى" },
            effort: { type: "string", enum: ["low", "medium", "high"] },
            priority: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["id", "title", "area", "why", "evidence", "how", "expectedImpact", "howToMeasure", "effort", "priority"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "honesty", "actions"],
    additionalProperties: false,
  },
};

const AREAS = ["pricing", "items", "promos", "ads", "hours", "winback", "operations"];
const EFFORTS = ["low", "medium", "high"];
const str = (v) => (typeof v === "string" ? v.trim() : "");
const oneOf = (v, list, fb) => (list.includes(str(v)) ? str(v) : fb);

function validatePlan(raw, numberPool) {
  const list = Array.isArray(raw?.actions) ? raw.actions : null;
  if (!list || !list.length) return { ok: false, error: "no actions array" };
  const actions = [];
  let droppedEmpty = 0, droppedUnsupported = 0;
  for (const [i, x] of list.entries()) {
    const how = Array.isArray(x?.how) ? x.how.map(str).filter(Boolean) : [];
    const evidence = str(x?.evidence);
    if (!str(x?.title) || !evidence || !how.length) { droppedEmpty++; continue; }
    // THE GUARD: an unsupported number is worse than no advice.
    if (!citesRealNumber(evidence, numberPool)) { droppedUnsupported++; continue; }
    actions.push({
      id: str(x.id) || `keeta-action-${i + 1}`,
      title: str(x.title),
      area: oneOf(x.area, AREAS, "operations"),
      why: str(x.why),
      evidence,
      how,
      expectedImpact: str(x.expectedImpact),
      howToMeasure: str(x.howToMeasure),
      effort: oneOf(x.effort, EFFORTS, "medium"),
      priority: Number.isFinite(Number(x.priority)) ? Math.max(1, Math.min(10, Math.round(Number(x.priority)))) : i + 1,
    });
  }
  if (actions.length < 2) {
    return { ok: false, error: `only ${actions.length} grounded actions (dropped ${droppedEmpty} empty, ${droppedUnsupported} unsupported)` };
  }
  actions.sort((a, b) => a.priority - b.priority);
  return {
    ok: true,
    value: { summary: str(raw.summary), honesty: str(raw.honesty), actions,
      dropped: { empty: droppedEmpty, unsupported: droppedUnsupported } },
  };
}

/** Plain-text rendering so Omar can copy the plan into WhatsApp. */
function planToText(plan, window) {
  const L = [`🛵 خطة نمو كيتا — ${window.from} ← ${window.to}`, ""];
  if (plan.summary) L.push(plan.summary, "");
  plan.actions.forEach((a, i) => {
    L.push(`${i + 1}) ${a.title}`);
    if (a.why) L.push(`   ليه: ${a.why}`);
    L.push(`   الدليل: ${a.evidence}`);
    a.how.forEach((h) => L.push(`   • ${h}`));
    if (a.expectedImpact) L.push(`   الأثر المتوقع: ${a.expectedImpact}`);
    if (a.howToMeasure) L.push(`   القياس: ${a.howToMeasure}`);
    L.push("");
  });
  if (plan.honesty) L.push(`⚠️ حدود البيانات: ${plan.honesty}`);
  return L.join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
   REGISTER
═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, todayISO, daysAgoISO } = ctx;

  // Default window = the last 30 days, ending today.
  const range = (get) => {
    const from = dayArg(get("from"), daysAgoISO(29));
    const to = dayArg(get("to"), todayISO());
    return from <= to ? { from, to } : { from: to, to: from };
  };
  const qRange = (c) => range((k) => c.req.query(k));

  const fail = (c, e, where) => {
    console.error(`[keeta-reports] ${where} failed:`, e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e) }, 500);
  };

  async function fees() {
    // getSettingsData() may legitimately fail (fresh DB); the contract
    // defaults are a complete fee model on their own, so never hard-fail here.
    try { return resolveFees(await getSettingsData()); }
    catch { return resolveFees(null); }
  }

  /* ── 1. OVERVIEW ──────────────────────────────────────────────────────── */
  app.get("/api/keeta-reports/overview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    try {
      return c.json({ ok: true, ...(await loadOverview(pool, await fees(), from, to)) });
    } catch (e) { return fail(c, e, "overview"); }
  });

  /* ── 2. CUSTOMERS ─────────────────────────────────────────────────────── */
  app.get("/api/keeta-reports/customers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    try {
      return c.json({ ok: true, ...(await loadCustomers(pool, from, to)) });
    } catch (e) { return fail(c, e, "customers"); }
  });

  /* ── 3. GROWTH (portal + our orders) ──────────────────────────────────── */
  app.get("/api/keeta-reports/growth", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    try {
      return c.json(await loadGrowth(pool, from, to));
    } catch (e) {
      // Contract: this route never 500s on a portal problem. A crash here is
      // ours (a DB error), so it is still reported honestly — but a KeetaError
      // is converted into the documented portal:false envelope.
      if (e instanceof KeetaError) {
        return c.json({ ok: true, from, to, portal: false, expired: !!e.expired, reason: e.message });
      }
      return fail(c, e, "growth");
    }
  });

  /* ── 4. ADVISOR ───────────────────────────────────────────────────────── */
  // In-memory only. A restart loses the last answer; that is deliberate — the
  // alternative is writing to a table this module does not own.
  const advisorCache = new Map(); // key -> { at, payload }

  app.post("/api/keeta-reports/advisor", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let body = {};
    try { body = (await c.req.json()) || {}; } catch { body = {}; }
    const { from, to } = range((k) => body?.[k]);
    const question = str(body.question).slice(0, 800);
    const force = body.force === true;
    const key = `${from}|${to}|${question}`;

    if (!force) {
      const hit = advisorCache.get(key);
      if (hit && Date.now() - hit.at < ADVISOR_CACHE_MS) return c.json({ ...hit.payload, cached: true });
    }

    try {
      const feeModel = await fees();
      // Gather the REAL numbers first — the model never sees a question it can
      // answer from priors alone.
      const [overview, customers, growth] = await Promise.all([
        loadOverview(pool, feeModel, from, to),
        loadCustomers(pool, from, to),
        loadGrowth(pool, from, to).catch((e) => ({ ok: true, portal: false, reason: String(e?.message || e) })),
      ]);

      if (!overview.totals.orders) {
        return c.json({
          ok: false, error: "no_data",
          detail: "مفيش طلبات كيتا في الفترة دي — اختار مدى تاني.",
          window: { from, to },
        });
      }

      const provider = resolveProvider();
      if (!provider) {
        return c.json({
          ok: false, error: "no_llm_provider",
          hint: "set ANTHROPIC_API_KEY, or LITELLM_KEY for the https://llm.o2m8.me/v1 proxy",
        }, 503);
      }

      // The evidence pack. Trimmed lists only — the model does not need 115
      // customer rows to reason about lapsed win-back, it needs the counts and
      // the top of the list.
      const evidence = {
        meta: {
          currency: "SAR (شامل الضريبة)",
          city: "جدة، السعودية",
          channel: "Keeta فقط",
          window: { from, to, days: overview.days },
          previousWindow: overview.previousWindow,
          dataSpan: overview.dataSpan,
          caveats: [
            "كل الأرقام دي لطلبات كيتا بس، مش كل المطعم.",
            overview.cost?.subsidyEstimated
              ? "دعم التوصيل من التاجر تقديري — ترتيب شرايح العقد لسه محتاج تأكيد من كشف تسوية حقيقي."
              : null,
            "تكلفة كيتا محسوبة على قيمة الطلب شاملة الضريبة.",
          ].filter(Boolean),
        },
        totals: overview.totals,
        vsPreviousPeriod: { ...overview.previous, delta: overview.delta },
        keetaCost: overview.cost,
        netAfterKeetaCost: overview.net,
        feeModel: {
          deliveryCommissionRate: feeModel.deliveryCommissionRate,
          pickupServiceRate: feeModel.pickupServiceRate,
          paymentFeeRate: feeModel.paymentFeeRate,
          minServiceFeeSAR: feeModel.minServiceFeeSAR,
          subsidyTiers: feeModel.subsidyTiers,
          source: feeModel.source,
        },
        customersSummary: { ...overview.customers, ...customers.summary, rules: customers.rules },
        topCustomers: customers.customers.slice(0, 12).map((x) => ({
          name: x.name, orders: x.orders, spendSAR: x.spendSAR, avgOrderSAR: x.avgOrderSAR,
          daysSinceLast: x.daysSinceLast, avgDaysBetween: x.avgDaysBetween, lapsed: x.lapsed, vip: x.vip,
        })),
        lapsedCustomers: customers.customers.filter((x) => x.lapsed).slice(0, 12).map((x) => ({
          name: x.name, lifetimeOrders: x.lifetimeOrders, lifetimeSpendSAR: x.lifetimeSpendSAR,
          daysSinceLast: x.daysSinceLast, lastOrder: x.lastOrder,
        })),
        items: {
          distinct: overview.items.distinct,
          totalRevenueSAR: overview.items.totalRevenueSAR,
          topByRevenue: overview.items.topByRevenue.slice(0, 10),
          topByQty: overview.items.topByQty.slice(0, 8),
          slowest: overview.items.slowest.slice(0, 8),
        },
        timing: {
          byHourRiyadh: overview.hours,
          peakHour: overview.peakHour,
          dailySeries: overview.daily.slice(-30),
        },
        portal: growth.portal
          ? { available: true, campaign: growth.campaign, ads: growth.ads, blended: growth.blended }
          : { available: false, reason: growth.reason || "بوابة كيتا مش متاحة دلوقتي" },
      };

      const numberPool = collectNumbers(evidence);
      const userMsg =
        `دي أرقام كيتا الحقيقية للمطعم في الفترة المطلوبة (JSON):\n\n${JSON.stringify(evidence, null, 1)}\n\n` +
        (question
          ? `سؤال صاحب المطعم بالنص: «${question}»\nجاوب على السؤال ده بالتحديد أول حاجة، وبعدها كمّل بخطة التنفيذ.\n\n`
          : "") +
        `صاحب المطعم عايز نمو كبير وحقيقي في كيتا. اطلع بخطة من ٤ إلى ٨ خطوات مرتّبة بالأولوية، كل خطوة قابلة للتنفيذ الأسبوع الجاي وقابلة للقياس. ` +
        `غطّي: التسعير مع الأخد في الاعتبار عمولة كيتا، تشكيلة الأصناف اللي تستحق الدفع فيها، شرايح العروض والدعم، ميزانية الإعلان، تغطية ساعات الذروة، واسترجاع العملاء المتوقفين. ` +
        `افتكر إن العينة صغيرة نسبيًا فكن صادق في تقدير الأثر — ما توعدش بأضعاف خيالية. استخدم أداة submit_keeta_plan للإجابة.`;

      // One retry on a malformed / ungrounded answer, exactly like ai.js.
      let plan = null, lastError = "";
      for (let attempt = 0; attempt < 2 && !plan; attempt++) {
        const prompt = attempt === 0 ? userMsg
          : `${userMsg}\n\nملاحظة: المحاولة السابقة اترفضت (${lastError}). التزم حرفيًا بمخطط الأداة، واتأكد إن حقل evidence في كل توصية فيه رقم منقول بالظبط من حزمة الأرقام اللي فوق.`;
        try {
          const v = validatePlan(await callTool(provider, { system: ADVISOR_SYSTEM, user: prompt, tool: ADVISOR_TOOL }), numberPool);
          if (v.ok) plan = v.value; else lastError = v.error;
        } catch (e) { lastError = e.message; }
      }
      if (!plan) {
        return c.json({ ok: false, error: "ungrounded_answer", detail: lastError, evidence }, 502);
      }

      const payload = {
        ok: true,
        model: provider.model,
        generatedAt: new Date().toISOString(),
        window: { from, to, days: overview.days },
        question: question || null,
        answer: plan,
        answerText: planToText(plan, { from, to }),
        evidence,
      };
      advisorCache.set(key, { at: Date.now(), payload });
      // Bounded — this is a per-process cache, not a store.
      if (advisorCache.size > 24) advisorCache.delete(advisorCache.keys().next().value);
      return c.json(payload);
    } catch (e) { return fail(c, e, "advisor"); }
  });

  console.log("[keeta-reports] routes ready (/api/keeta-reports/overview|customers|growth|advisor)");
}

export default { register };
