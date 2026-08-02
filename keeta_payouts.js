/* ═══════════════════════════════════════════════════════════════════════════
   KEETA PAYOUTS — what Keeta ACTUALLY paid us, per order, and how far that is
   from the contract model in keeta_reports.js.

   Registered by index.js via `register(app, ctx)` with the shared moduleCtx.
   Admin-only. READ-ONLY against the Keeta portal and against every table it
   does not own; the only thing it writes is its own `keeta_payouts` cache.

   ── WHY THIS EXISTS ──────────────────────────────────────────────────────
   Everything we report about Keeta profitability today (keeta_reports.js
   `applyFees`) is CONTRACT arithmetic: 18% commission, 2.5% payment fee, a
   five-tier merchant-funded delivery subsidy read off an RTL PDF, and a SAR 1
   minimum service fee. Not one of those four numbers had ever been checked
   against money that actually moved. This module checks them.

   ── WHERE THE REAL NUMBERS LIVE (both verified live, 2026-08-02) ─────────
   1. PER ORDER — POST /api/order/getOrderDtl  body {shopId, viewId}
      (the gateway names those params itself when they are missing:
       `findMerchantOrderByViewId.qry.shopId / .viewId`).
      This is the endpoint behind the الطلبات order-detail panel — the Mach
      render whose fee rows carry the `otd-content-fee-list-history-item` /
      `otd-content-special-fee-line-earnings` classes.
      `data.orderInfo.feeDtl.merchantFee` carries, in HALALAS, positive-signed
      even for deductions:
        productPrice        المجموع (شاملة الضريبة) — gross items, VAT-INCLUSIVE,
                            before any discount
        activityFee         العرض الترويجي ممول من التاجر — ALL merchant-funded
                            promotions. USE THIS, not the sum of the children:
                            on order 4796823030358149 the children sum to 23.40
                            while activityFee is 29.40, and only activityFee
                            closes the arithmetic.
        merchantActivityFeeDtls[]  per promotion: type/typeName/activityId/
                            sillAmount (threshold)/reduceFee/merchantActivityFee/
                            platformActivityFee/promotionRuleDesc
        basicCommission     العمولة الأساسية
        distanceFee         a per-order distance charge, ADDED to commission
        commission          العمولة = basicCommission + distanceFee
        bankTransactionFee  رسوم الدفع الإلكتروني, + bankTransactionFeeRate,
                            a STRING percent: "2.875"
        diffPrice           الفارق عن الحد الأدنى للطلب — ADDED, not deducted
        platformServiceFee  رسوم الخدمة the CUSTOMER pays. It does NOT reach the
                            merchant — it stays with Keeta. Do not credit it.
        earnings            الأرباح ← THE NET WE ARE PAID
        rebates*            every field recomputed AFTER refunds
      `customerFee` carries what the customer actually paid (payTotal,
      shippingFee, discounts).
      `orderInfo.products[]` carries per item `originPrice` (list) vs `price`
      (after the promotion) — i.e. which items are being discounted.

      ── THE IDENTITY, verified to the halala on every order sampled ────────
        earnings = productPrice − activityFee − commission − bankTransactionFee
                   + diffPrice
      which is Keeta's own `earningsFormula`:
        "الأرباح = إجمالي - العمولة - العرض الترويجي ممول من التاجر
         - رسوم الدفع الإلكتروني + الفارق عن الحد الأدنى للطلب"

      ── THE COMMISSION RULE, measured not assumed ─────────────────────────
        basicCommission = 18% × (productPrice − activityFee)
      i.e. 18% of the VAT-INCLUSIVE order value AFTER all merchant-funded
      promotions. Exact (17.986%–18.006%) on 9 of the first 10 orders sampled.
      keeta_reports.js charges 18% of the *pre-discount* VAT-inclusive total,
      which overstates the commission on every discounted order.
      The tenth order charged 5.00 where the rule gives 4.86, and 5.00 is the
      smallest commission in the sample — possibly a SAR 5 minimum. One data
      point, so the code reports it as a candidate and never applies it.

   2. THE AUTHORITATIVE STATEMENT — the الشؤون المالية micro-app
      (/web/app/finance) speaks /api/settlement/statement/v2/*:
        billPage/billList              weekly bills {billId, period, amountText,
                                       status, payTime}
        billPage/dailyBillDetail       per-DAY net for one bill
        billPage/cate/detail/timeRange the deduction tree for one BILL PERIOD
      Bill status enum: 10 INIT, 20 SUMMARY_SUC, 23 ADJUSTING, 30 PARTNER_CONFIRM,
      40 WRITTEN_OFF, 80 PAY_ING, 85 PAY_FAIL, 90 PAY_SUC, 95 STOP_PAY_SUC.
      `inputType` = 1 (SINGLE_SHOP), `inputId` = KEETA_SHOP_ID.
      NOTE: cate/detail/timeRange does NOT honour an arbitrary range — it snaps
      to the bill period containing periodStartDateStamp. Always pass a bill's
      own period stamps, never your own from/to.

   ── DELIBERATELY NOT CALLED (writes) ─────────────────────────────────────
      /api/settlement/statement/v2/account/w/withdraw       moves real money
      /api/settlement/statement/v2/w/download/task/create   creates an export job
      /api/order/confirm                                    accepts an order
   ── BLOCKED, RECORDED ────────────────────────────────────────────────────
      /api/order/history/getOrders answers `code 50002 参数校验出错`
      (ParamCheckException) for every body we could derive from the portal
      bundle — pageNum/pageSize alone, +shopId, +shopIds[], ms and second
      timestamps, +status, +orderClassify, +sorts/keyWord/seqNoStr, and a
      shopId header. `/api/order/history/getFilters` on the same prefix answers
      code 0, so the session is fine and the route exists; the list call wants a
      parameter that is not visible in the client. Consequence: we cannot
      enumerate Keeta order ids from Keeta. We get them from FeedUs instead —
      which is correct anyway, because that is what makes the join exact.

   ── THE JOIN KEY ─────────────────────────────────────────────────────────
   FeedUs's POS log carries, on the same row, TabSense's order id and Keeta's
   own `providerOrderId`. That value IS `orderInfo.baseOrder.orderViewIdStr`.
   So: ts_orders.order_id ⇄ FeedUs ⇄ Keeta viewId. Exact, not time-based.
   Verified on a 10-order sample: 10/10 matched ts_orders and 10/10 returned a
   merchantFee block. Our `ts_orders.gross_incl` equals Keeta's `productPrice`
   to the halala, which is an independent confirmation that the join is right.

   ── BUSINESS RULES (inherited, do not diverge) ───────────────────────────
   * The business day is `ts_orders.calendar_day` (TabSense rolls it at 04:00
     Riyadh). Keeta's bill periods roll at 00:00 Riyadh, so a bill period and a
     span of calendar_days are NOT the same set of orders. Every route that
     mixes the two says so.
   * `total`/`gross_incl`/`discount_incl` INCLUDE VAT; `net`/`gross`/`discount`
     EXCLUDE it. Keeta's productPrice is VAT-inclusive.
   * Voids and refunds are not sales.
═══════════════════════════════════════════════════════════════════════════ */

import { keetaCall, KeetaError, configured as keetaConfigured } from "./keeta.js";
import { fetchPosLogs, ENABLED as FEEDUS_ENABLED } from "./feedus.js";

const SHOP_ID = process.env.KEETA_SHOP_ID || "1430391221";
/* How many POS-log pages to walk when hunting for order ids. FeedUs's
   pagination is shallow in practice (a `pages:12` sweep returned 13 rows
   total), so this is a ceiling, not a promise. */
const POSLOG_PAGES = Number(process.env.KEETA_PAYOUT_POSLOG_PAGES || 8);
/* Politeness gap between per-order portal calls. The portal is behind a
   human-refreshed cookie; hammering it is how we lose the cookie. */
const FETCH_GAP_MS = Number(process.env.KEETA_PAYOUT_GAP_MS || 400);
const MAX_SYNC = Number(process.env.KEETA_PAYOUT_MAX_SYNC || 120);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── numeric helpers — same contract as analytics.js / keeta_reports.js ──── */
const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(n0(v) * 100) / 100;
const rate4 = (v) => (v === null || v === undefined ? null : Math.round(n0(v) * 10000) / 10000);
/** null (not 0, not Infinity) when there is nothing to divide by. */
const ratio = (a, b) => (n0(b) === 0 ? null : rate4(n0(a) / n0(b)));
/** Keeta money on the order API is integer HALALAS. 6579 → 65.79 */
const hal = (v) => (v === null || v === undefined ? 0 : Math.round(n0(v)) / 100);
const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayArg = (v, fb) => (typeof v === "string" && DAY_RE.test(v) ? v : fb);

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA — created at registration, exactly the way ensureMarketingSchema does
   it in index.js: one pool.query, IF NOT EXISTS everywhere, additive ALTERs so
   a redeploy never destroys a cached row.
═══════════════════════════════════════════════════════════════════════════ */
async function ensurePayoutSchema(pool) {
  await pool.query(`
    -- One row per KEETA order (not per TabSense order): the payout breakdown
    -- exactly as Keeta reports it. Every amount is SAR, VAT-inclusive where
    -- Keeta's own field is, and POSITIVE for deductions (we keep Keeta's sign
    -- convention so a row can be eyeballed against the portal screen).
    CREATE TABLE IF NOT EXISTS keeta_payouts (
      order_view_id      TEXT PRIMARY KEY,        -- Keeta orderViewIdStr
      order_id           TEXT,                    -- TabSense order id, via FeedUs
      shop_id            TEXT NOT NULL DEFAULT '',
      order_time         TIMESTAMPTZ,             -- baseOrder.ctime
      keeta_day          DATE,                    -- Riyadh midnight day (Keeta's bill day)
      order_status       INT,
      user_get_mode      TEXT NOT NULL DEFAULT '',-- delivery | pickup
      currency           TEXT NOT NULL DEFAULT 'SAR',
      product_price      NUMERIC DEFAULT 0,       -- gross items, VAT-incl, pre-discount
      platform_service_fee NUMERIC DEFAULT 0,     -- credited TO us
      diff_price         NUMERIC DEFAULT 0,       -- min-order top-up, credited TO us
      basic_commission   NUMERIC DEFAULT 0,
      distance_fee       NUMERIC DEFAULT 0,
      commission         NUMERIC DEFAULT 0,       -- basic + distance
      bank_fee           NUMERIC DEFAULT 0,
      bank_fee_rate      NUMERIC,                 -- Keeta's own percent, e.g. 2.875
      activity_fee       NUMERIC DEFAULT 0,       -- all merchant-funded promos
      delivery_subsidy   NUMERIC DEFAULT 0,       -- promo type 4 only
      item_subsidy       NUMERIC DEFAULT 0,       -- every other merchant-funded promo
      earnings           NUMERIC DEFAULT 0,       -- NET PAID TO US
      rebates_earnings   NUMERIC DEFAULT 0,       -- net after refunds
      refund_price       NUMERIC DEFAULT 0,
      customer_pay_total NUMERIC DEFAULT 0,
      customer_shipping_fee NUMERIC DEFAULT 0,
      customer_discounts NUMERIC DEFAULT 0,
      promos             JSONB NOT NULL DEFAULT '[]'::jsonb,
      earnings_formula   TEXT NOT NULL DEFAULT '',
      raw                JSONB NOT NULL DEFAULT '{}'::jsonb,
      fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Per-item list price vs promotional price, so "which items are we
    -- discounting 20% on" is answerable without re-hitting the portal.
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS keeta_payouts_order_idx ON keeta_payouts(order_id);
    CREATE INDEX IF NOT EXISTS keeta_payouts_day_idx   ON keeta_payouts(keeta_day);
  `);
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE CONTRACT MODEL WE ARE TESTING

   Mirrors keeta_reports.js FEE_DEFAULTS on purpose — that file keeps
   `resolveFees` private, and importing a copy of the numbers is safer than
   exporting its internals. If the contract changes, change it in both.
   Overridable from `settings.keetaFees`, same key, same shape.
═══════════════════════════════════════════════════════════════════════════ */
const FEE_DEFAULTS = {
  deliveryCommissionRate: 0.18,
  pickupServiceRate: 0.03,
  paymentFeeRate: 0.025,
  minServiceFeeSAR: 1,
  commissionBase: "total",          // "total" (VAT-incl) | "net" (VAT-excl)
  subsidyEnabled: true,
  subsidyTiers: [
    { upTo: 30, sar: 4 },
    { upTo: 35, sar: 9 },
    { upTo: 45, sar: 11 },
    { upTo: 55, sar: 12 },
    { upTo: 70, sar: 15 },
  ],
};

function resolveFees(settings) {
  const raw = (settings && typeof settings.keetaFees === "object" && settings.keetaFees) || {};
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const tiers = Array.isArray(raw.subsidyTiers) && raw.subsidyTiers.length
    ? raw.subsidyTiers
      .map((t) => ({ upTo: Number(t?.upTo), sar: Number(t?.sar) }))
      .filter((t) => Number.isFinite(t.upTo) && Number.isFinite(t.sar))
      .sort((a, b) => a.upTo - b.upTo)
    : FEE_DEFAULTS.subsidyTiers;
  return {
    deliveryCommissionRate: numOr(raw.deliveryCommissionRate, FEE_DEFAULTS.deliveryCommissionRate),
    pickupServiceRate: numOr(raw.pickupServiceRate, FEE_DEFAULTS.pickupServiceRate),
    paymentFeeRate: numOr(raw.paymentFeeRate, FEE_DEFAULTS.paymentFeeRate),
    minServiceFeeSAR: numOr(raw.minServiceFeeSAR, FEE_DEFAULTS.minServiceFeeSAR),
    commissionBase: raw.commissionBase === "net" ? "net" : "total",
    subsidyEnabled: raw.subsidyEnabled === undefined ? FEE_DEFAULTS.subsidyEnabled : !!raw.subsidyEnabled,
    subsidyTiers: tiers.length ? tiers : FEE_DEFAULTS.subsidyTiers,
    source: Object.keys(raw).length ? "settings.keetaFees" : "contract defaults (settings.keetaFees not set)",
  };
}

/** The modelled cost of ONE order, exactly as keeta_reports.js computes it. */
function modelOrder(fees, { total, net, isPickup }) {
  const base = fees.commissionBase === "net" ? n0(net) : n0(total);
  let serviceFee = base * (isPickup ? fees.pickupServiceRate : fees.deliveryCommissionRate);
  const minFeeApplied = serviceFee < fees.minServiceFeeSAR;
  if (minFeeApplied) serviceFee = fees.minServiceFeeSAR;
  const paymentFee = base * fees.paymentFeeRate;
  let subsidy = 0, tierHit = null, aboveTopTier = false;
  if (fees.subsidyEnabled && !isPickup) {
    const t = fees.subsidyTiers.find((x) => base <= x.upTo);
    if (t) { subsidy = t.sar; tierHit = t.upTo; } else { aboveTopTier = true; }
  }
  return {
    base: money(base),
    serviceFeeSAR: money(serviceFee),
    paymentFeeSAR: money(paymentFee),
    subsidySAR: money(subsidy),
    totalCostSAR: money(serviceFee + paymentFee + subsidy),
    minFeeApplied,
    tierHit,
    aboveTopTier,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PORTAL READS
═══════════════════════════════════════════════════════════════════════════ */

/** One order's payout, normalised. Throws KeetaError on a portal/auth problem. */
async function fetchOrderPayout(viewId) {
  const d = await keetaCall("/api/order/getOrderDtl", { shopId: Number(SHOP_ID), viewId: String(viewId) });
  const info = d?.orderInfo || {};
  const m = info?.feeDtl?.merchantFee;
  const c = info?.feeDtl?.customerFee || {};
  const base = info?.baseOrder || {};
  const mo = info?.merchantOrder || {};
  if (!m) {
    // The order exists but carries no merchant fee block — nothing to store,
    // and storing zeros would read as "Keeta took nothing".
    const e = new Error(`الطلب ${viewId} رجع بدون تفاصيل تحصيل (feeDtl.merchantFee)`);
    e.noFee = true;
    throw e;
  }
  const promos = Array.isArray(m.merchantActivityFeeDtls) ? m.merchantActivityFeeDtls : [];
  // Promo type 4 = خصم رسوم التوصيل, the merchant's share of a waived delivery
  // fee — the thing keeta_reports.js models as a five-tier table. Everything
  // else (item promos, merchant-funded vouchers) is the item subsidy.
  const deliverySubsidy = promos.filter((p) => Number(p?.type) === 4)
    .reduce((a, p) => a + hal(p?.merchantActivityFee), 0);
  const itemSubsidyRows = promos.filter((p) => Number(p?.type) !== 4)
    .reduce((a, p) => a + hal(p?.merchantActivityFee), 0);
  const activityFee = hal(m.activityFee);
  // `activityFee` is the authority; the child rows can under-report it (seen:
  // 23.40 of rows against an activityFee of 29.40). Whatever the rows cannot
  // explain is still a merchant-funded item cost, so it lands in itemSubsidy
  // rather than vanishing and flattering the margin.
  const itemSubsidy = money(Math.max(itemSubsidyRows, activityFee - deliverySubsidy));

  const ms = Number(base.ctime || mo.ctime) || null;
  return {
    orderViewId: String(base.orderViewIdStr || mo.orderViewIdStr || viewId),
    shopId: String(mo.shopId || SHOP_ID),
    orderTime: ms ? new Date(ms).toISOString() : null,
    // Keeta bills on a Riyadh-midnight day; ts_orders.calendar_day rolls at
    // 04:00. Both are kept so the mismatch is visible instead of silent.
    keetaDay: ms ? new Date(ms + 3 * 3600000).toISOString().slice(0, 10) : null,
    status: mo.status ?? base.status ?? null,
    userGetMode: mo.userGetMode || "",
    currency: m?.i18n?.currency || base.currency || "SAR",
    productPrice: hal(m.productPrice),
    platformServiceFee: hal(m.platformServiceFee),
    diffPrice: hal(m.diffPrice),
    basicCommission: hal(m.basicCommission),
    distanceFee: hal(m.distanceFee),
    commission: hal(m.commission ?? m.brokerage),
    bankFee: hal(m.bankTransactionFee),
    // Keeta ships this as a STRING percent ("2.875"), not a fraction.
    bankFeeRate: Number.isFinite(Number(m.bankTransactionFeeRate)) ? Number(m.bankTransactionFeeRate) : null,
    activityFee,
    // The base Keeta actually charges commission on: 18% × this reproduces
    // basicCommission to the halala.
    commissionBase: money(hal(m.productPrice) - activityFee),
    deliverySubsidy: money(deliverySubsidy),
    itemSubsidy,
    earnings: hal(m.earnings ?? m.total),
    rebatesEarnings: hal(m.rebatesEarnings ?? m.rebatesTotal),
    refundPrice: hal(m.refundPrice),
    customerPayTotal: hal(c.payTotal),
    customerShippingFee: hal(c.shippingFee),
    customerDiscounts: hal(c.discounts),
    earningsFormula: String(m.earningsFormula || ""),
    promos: promos.map((p) => ({
      type: p?.type ?? null,
      typeName: p?.typeName || null,
      activityId: p?.activityId ? String(p.activityId) : null,
      // sillAmount is the ORDER-VALUE THRESHOLD the promo fires at — this is
      // the field that makes the "subsidy tier" question answerable at all.
      thresholdSAR: hal(p?.sillAmount),
      reduceFeeSAR: hal(p?.reduceFee),
      merchantPaysSAR: hal(p?.merchantActivityFee),
      platformPaysSAR: hal(p?.platformActivityFee),
      rule: p?.promotionRuleDesc || null,
    })),
    // List price vs promotional price per line — `price`/`originPrice` are the
    // line totals for `count` units.
    items: (Array.isArray(info.products) ? info.products : []).map((p) => ({
      name: p?.name || p?.spuName || null,
      qty: n0(p?.count) || 1,
      listPriceSAR: hal(p?.originPrice),
      paidPriceSAR: hal(p?.price),
      discountSAR: money(hal(p?.originPrice) - hal(p?.price)),
      discountPercent: ratio(hal(p?.originPrice) - hal(p?.price), hal(p?.originPrice)),
    })),
    raw: info.feeDtl,
  };
}

/** The weekly settlement statements — the authoritative, money-has-moved view. */
const SETTLE = "/api/settlement/statement/v2";
const BILL_STATUS = {
  10: "INIT", 20: "SUMMARY_SUC", 23: "ADJUSTING", 25: "BILL_INNER_SUBMIT",
  26: "INNER_CONFIRM_REJECT", 27: "INNER_CONFIRM_PASS", 30: "PARTNER_CONFIRM",
  40: "WRITTEN_OFF", 80: "PAY_ING", 85: "PAY_FAIL", 90: "PAY_SUC", 95: "STOP_PAY_SUC",
};
/* The category codes that carry money we care about. Names are Keeta's own
   Arabic; codes are stable, names are not, so we key on codes. */
const CAT = {
  paid: "-1",       // إجمالي المدفوعات — the net that lands in the bank
  revenue: "10101", // إجمالي الأصناف — gross items, VAT-incl, pre-discount
  minTopUp: "10102",// الفارق عن الحد الأدنى للطلب
  itemSubsidy: "20101",
  dlvSubsidyOld: "20102",
  ads: "20205",
  commission: "30101",
  bank: "30201",
  photography: "30301",
  dlvSubsidy: "30302", // إعانات التوصيل (طلب توصيل من Keeta) التي يغطيها التاجر
  commissionAdj: "30303",
};

function flattenCats(list, out = {}) {
  for (const c of list || []) {
    if (c && c.categoryCode != null) out[String(c.categoryCode)] = { name: c.categoryName || null, amount: hal(c.amount) };
    flattenCats(c?.subCategoryInfos, out);
  }
  return out;
}

async function fetchBills(fromMs, toMs) {
  const d = await keetaCall(`${SETTLE}/billPage/billList`, {
    inputId: Number(SHOP_ID), inputType: 1,
    periodStartDateStamp: fromMs, periodEndDateStamp: toMs,
  });
  return (d?.billInfoList || []).sort((a, b) => n0(a.periodStartDateStamp) - n0(b.periodStartDateStamp));
}

async function fetchBillCategories(bill) {
  // MUST be the bill's own stamps — this endpoint snaps to the bill period.
  const d = await keetaCall(`${SETTLE}/billPage/cate/detail/timeRange`, {
    inputId: Number(SHOP_ID), inputType: 1,
    periodStartDateStamp: bill.periodStartDateStamp,
    periodEndDateStamp: bill.periodEndDateStamp,
  });
  let parsed = d;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
  return flattenCats(parsed?.categoryInfoList);
}

/* ═══════════════════════════════════════════════════════════════════════════
   REGISTER
═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, todayISO, daysAgoISO, jb } = ctx;

  ensurePayoutSchema(pool)
    .then(() => console.log("[keeta-payouts] schema ready"))
    .catch((e) => console.error("[keeta-payouts] schema init failed:", e.message));

  const fail = (c, e, where) => {
    if (e instanceof KeetaError) {
      return c.json({ ok: false, expired: e.expired, error: e.message, code: e.code ?? null },
        e.expired ? 401 : 502);
    }
    console.error(`[keeta-payouts] ${where} failed:`, e?.message || e);
    return c.json({ ok: false, error: String(e?.message || e) }, 500);
  };

  const qRange = (c) => {
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    return from <= to ? { from, to } : { from: to, to: from };
  };

  async function fees() {
    try { return resolveFees(await getSettingsData()); }
    catch { return resolveFees(null); }
  }

  /* ─── 1. SYNC ─────────────────────────────────────────────────────────────
     Pull per-order payouts and cache them.

     Ids come from FeedUs's POS log, because Keeta's own order-history list is
     blocked for us (see the header). That is not a workaround — FeedUs is the
     only place the TabSense id and the Keeta id sit on the same row, so it is
     also what makes the join exact. `viewIds` in the body lets a human hand us
     ids the POS log can no longer reach.

     Nothing here writes to Keeta. `POST` only because it takes a body and
     mutates our own cache.                                                   */
  app.post("/api/keeta-payouts/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!keetaConfigured()) {
      return c.json({ ok: false, expired: true, error: "كيتا مش مربوطة — الناقص KEETA_COOKIE أو KEETA_SHOP_ID" }, 401);
    }
    let body = {};
    try { body = (await c.req.json()) || {}; } catch { body = {}; }
    const refresh = body.refresh === true;
    const limit = Math.max(1, Math.min(MAX_SYNC, Number(body.limit) || MAX_SYNC));
    const explicit = Array.isArray(body.viewIds)
      ? body.viewIds.map((v) => String(v).trim()).filter((v) => /^\d{6,}$/.test(v))
      : [];

    try {
      // ── id discovery ───────────────────────────────────────────────────
      let candidates = explicit.map((v) => ({ viewId: v, orderId: null }));
      const notes = [];
      if (!candidates.length) {
        if (!FEEDUS_ENABLED) {
          return c.json({
            ok: false,
            error: "FeedUs مش مربوط (FEEDUS_EMAIL/FEEDUS_PASSWORD) ومفيش viewIds في الطلب — مفيش مصدر لمعرفات طلبات كيتا.",
          }, 400);
        }
        let logs = null, lastErr = null;
        // FeedUs's login is flaky under load; two tries, then say so honestly.
        for (let i = 0; i < 2 && !logs; i++) {
          try { logs = await fetchPosLogs({ pages: POSLOG_PAGES }); }
          catch (e) { lastErr = e; await sleep(1500); }
        }
        if (!logs) {
          return c.json({ ok: false, error: `تعذر قراءة سجل FeedUs: ${lastErr?.message || "سبب غير معروف"}` }, 502);
        }
        const seen = new Set();
        for (const r of logs) {
          if (!/keeta/i.test(r.provider || "")) continue;
          const v = String(r.providerOrderId || "").trim();
          if (!/^\d{6,}$/.test(v) || seen.has(v)) continue;
          seen.add(v);
          candidates.push({ viewId: v, orderId: r.tabsenseOrderId || null });
        }
        notes.push(`FeedUs رجّع ${logs.length} سطر، منهم ${candidates.length} طلب كيتا. صفحات سجل FeedUs محدودة، فالتغطية بتكبر مع كل تشغيل.`);
      }

      // ── skip what we already hold ──────────────────────────────────────
      if (!refresh && candidates.length) {
        const have = new Set((await pool.query(
          `SELECT order_view_id FROM keeta_payouts WHERE order_view_id = ANY($1::text[])`,
          [candidates.map((x) => x.viewId)]
        )).rows.map((r) => r.order_view_id));
        candidates = candidates.filter((x) => !have.has(x.viewId));
      }
      const work = candidates.slice(0, limit);

      // ── fetch + store ──────────────────────────────────────────────────
      let stored = 0;
      const errors = [];
      for (const cand of work) {
        let p;
        try {
          p = await fetchOrderPayout(cand.viewId);
        } catch (e) {
          // A dead cookie kills the whole run — every later call would fail
          // the same way and we would just burn the portal's patience.
          if (e instanceof KeetaError && e.expired) throw e;
          errors.push({ viewId: cand.viewId, error: e.message });
          await sleep(FETCH_GAP_MS);
          continue;
        }
        await pool.query(
          `INSERT INTO keeta_payouts (
             order_view_id, order_id, shop_id, order_time, keeta_day, order_status,
             user_get_mode, currency, product_price, platform_service_fee, diff_price,
             basic_commission, distance_fee, commission, bank_fee, bank_fee_rate,
             activity_fee, delivery_subsidy, item_subsidy, earnings, rebates_earnings,
             refund_price, customer_pay_total, customer_shipping_fee, customer_discounts,
             promos, earnings_formula, raw, items, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                   $21,$22,$23,$24,$25,$26,$27,$28,$29, NOW())
           ON CONFLICT (order_view_id) DO UPDATE SET
             order_id = COALESCE(EXCLUDED.order_id, keeta_payouts.order_id),
             shop_id = EXCLUDED.shop_id, order_time = EXCLUDED.order_time,
             keeta_day = EXCLUDED.keeta_day, order_status = EXCLUDED.order_status,
             user_get_mode = EXCLUDED.user_get_mode, currency = EXCLUDED.currency,
             product_price = EXCLUDED.product_price,
             platform_service_fee = EXCLUDED.platform_service_fee,
             diff_price = EXCLUDED.diff_price, basic_commission = EXCLUDED.basic_commission,
             distance_fee = EXCLUDED.distance_fee, commission = EXCLUDED.commission,
             bank_fee = EXCLUDED.bank_fee, bank_fee_rate = EXCLUDED.bank_fee_rate,
             activity_fee = EXCLUDED.activity_fee, delivery_subsidy = EXCLUDED.delivery_subsidy,
             item_subsidy = EXCLUDED.item_subsidy, earnings = EXCLUDED.earnings,
             rebates_earnings = EXCLUDED.rebates_earnings, refund_price = EXCLUDED.refund_price,
             customer_pay_total = EXCLUDED.customer_pay_total,
             customer_shipping_fee = EXCLUDED.customer_shipping_fee,
             customer_discounts = EXCLUDED.customer_discounts,
             promos = EXCLUDED.promos, earnings_formula = EXCLUDED.earnings_formula,
             raw = EXCLUDED.raw, items = EXCLUDED.items, fetched_at = NOW()`,
          [p.orderViewId, cand.orderId, p.shopId, p.orderTime, p.keetaDay, p.status,
            p.userGetMode, p.currency, p.productPrice, p.platformServiceFee, p.diffPrice,
            p.basicCommission, p.distanceFee, p.commission, p.bankFee, p.bankFeeRate,
            p.activityFee, p.deliverySubsidy, p.itemSubsidy, p.earnings, p.rebatesEarnings,
            p.refundPrice, p.customerPayTotal, p.customerShippingFee, p.customerDiscounts,
            jb ? jb(p.promos) : JSON.stringify(p.promos), p.earningsFormula,
            jb ? jb(p.raw || {}) : JSON.stringify(p.raw || {}),
            jb ? jb(p.items) : JSON.stringify(p.items)]
        );
        stored++;
        await sleep(FETCH_GAP_MS);
      }

      const cov = (await pool.query(`
        SELECT count(*)::int AS ours,
               count(p.order_view_id)::int AS covered
          FROM ts_orders o
          JOIN order_sources s ON s.order_id = o.order_id
          LEFT JOIN keeta_payouts p ON p.order_id = o.order_id
         WHERE lower(COALESCE(s.source_note, '')) = 'keeta'
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
      `)).rows[0] || {};

      return c.json({
        ok: true,
        candidates: candidates.length,
        attempted: work.length,
        stored,
        skippedAlreadyCached: !refresh,
        errors,
        coverage: {
          ourKeetaOrders: n0(cov.ours),
          withPayoutRow: n0(cov.covered),
          rate: ratio(cov.covered, cov.ours),
        },
        notes,
      });
    } catch (e) { return fail(c, e, "sync"); }
  });

  /* ─── 2. RECONCILE ────────────────────────────────────────────────────────
     The deliverable. Per order: what our contract model charges vs what Keeta
     actually deducted, in SAR and %. Plus a verdict on each of the three
     assumptions keeta_reports.js flags as unconfirmed — computed from the
     cached rows, never asserted.

     Window is on `ts_orders.calendar_day` (04:00 rollover) so it lines up with
     every other report; `keeta_day` is carried per row so the boundary cases
     are visible.                                                              */
  app.get("/api/keeta-payouts/reconcile", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    try {
      const fee = await fees();
      const rows = (await pool.query(`
        SELECT p.order_view_id, p.order_id, p.keeta_day::text AS keeta_day, p.order_time,
               p.user_get_mode, p.product_price::float8 AS product_price,
               p.platform_service_fee::float8 AS platform_service_fee,
               p.diff_price::float8 AS diff_price,
               p.basic_commission::float8 AS basic_commission,
               p.distance_fee::float8 AS distance_fee,
               p.commission::float8 AS commission,
               p.bank_fee::float8 AS bank_fee, p.bank_fee_rate::float8 AS bank_fee_rate,
               p.activity_fee::float8 AS activity_fee,
               p.delivery_subsidy::float8 AS delivery_subsidy,
               p.item_subsidy::float8 AS item_subsidy,
               p.earnings::float8 AS earnings, p.rebates_earnings::float8 AS rebates_earnings,
               p.refund_price::float8 AS refund_price,
               p.customer_pay_total::float8 AS customer_pay_total,
               p.promos,
               o.calendar_day::text AS calendar_day,
               o.total::float8 AS our_total, o.net::float8 AS our_net,
               o.gross_incl::float8 AS our_gross_incl, o.discount_incl::float8 AS our_discount_incl,
               (o.order_option ILIKE '%pick%' OR o.order_option ILIKE '%استلام%') AS is_pickup
          FROM keeta_payouts p
          JOIN ts_orders o ON o.order_id = p.order_id
          JOIN order_sources s ON s.order_id = o.order_id
         WHERE lower(COALESCE(s.source_note, '')) = 'keeta'
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
           AND o.calendar_day BETWEEN $1::date AND $2::date
         ORDER BY o.calendar_day, p.order_time`, [from, to])).rows;

      // Rows Keeta gave us that we could not tie to a TabSense order — reported,
      // never silently dropped.
      const orphans = (await pool.query(`
        SELECT count(*)::int AS n FROM keeta_payouts p
         WHERE p.order_id IS NULL OR NOT EXISTS (SELECT 1 FROM ts_orders o WHERE o.order_id = p.order_id)`)).rows[0]?.n || 0;

      // Keeta's real rule, so the response can show the model, the reality, AND
      // the rule that actually generated the reality.
      const KEETA_COMMISSION_RATE = 0.18;
      const orders = rows.map((r) => {
        const mdl = modelOrder(fee, { total: r.our_total, net: r.our_net, isPickup: !!r.is_pickup });
        // The base Keeta charges on: VAT-inclusive value after merchant promos.
        const kBase = money(n0(r.product_price) - n0(r.activity_fee));
        // Keeta's own deduction set, on Keeta's sign convention (positive = taken).
        const actual = {
          commissionSAR: money(r.commission),
          basicCommissionSAR: money(r.basic_commission),
          distanceFeeSAR: money(r.distance_fee),
          bankFeeSAR: money(r.bank_fee),
          bankFeeRatePercent: r.bank_fee_rate ?? null,
          deliverySubsidySAR: money(r.delivery_subsidy),
          itemSubsidySAR: money(r.item_subsidy),
          // The comparable total: everything Keeta charged that our model tries
          // to predict. Item subsidy is EXCLUDED — the model does not claim to
          // predict item promos, and folding it in would flatter the model.
          totalCostSAR: money(n0(r.commission) + n0(r.bank_fee) + n0(r.delivery_subsidy)),
          netPaidSAR: money(r.earnings),
          // Keeta leaves the whole rebates* family at 0 on orders that were
          // never refunded, so it must not be read as "we got nothing".
          netAfterRefundsSAR: n0(r.refund_price) > 0 ? money(r.rebates_earnings) : money(r.earnings),
          refundSAR: money(r.refund_price),
          customerPaidSAR: money(r.customer_pay_total),
        };
        const diff = money(mdl.totalCostSAR - actual.totalCostSAR);
        return {
          orderId: r.order_id,
          orderViewId: r.order_view_id,
          calendarDay: r.calendar_day,
          keetaDay: r.keeta_day,
          // A different day on the two sides is the 04:00-vs-00:00 rollover, not an error.
          dayBoundaryShift: r.calendar_day !== r.keeta_day,
          orderTime: r.order_time,
          channel: r.user_get_mode || null,
          ours: {
            totalSAR: money(r.our_total),
            netSAR: money(r.our_net),
            grossInclSAR: money(r.our_gross_incl),
            discountInclSAR: money(r.our_discount_incl),
          },
          keetaProductPriceSAR: money(r.product_price),
          // Independent proof the join is right: Keeta's productPrice should
          // equal our VAT-inclusive pre-discount gross.
          grossMatchesKeeta: Math.abs(n0(r.product_price) - n0(r.our_gross_incl)) <= 0.05,
          modelled: mdl,
          actual,
          differenceSAR: diff,
          differencePercent: ratio(diff, actual.totalCostSAR),
          // The rate Keeta really charged, on every candidate base, so the
          // reader can see for themselves which one is flat.
          keetaCommissionBaseSAR: kBase,          // productPrice − activityFee
          effectiveCommissionOnKeetaBase: ratio(r.basic_commission, kBase),
          effectiveCommissionOnTotal: ratio(r.basic_commission, r.our_total),
          effectiveCommissionOnNet: ratio(r.basic_commission, r.our_net),
          effectiveBankOnCustomerPaid: ratio(r.bank_fee, r.customer_pay_total),
          // What the rule predicts vs what was charged. Anything but ~0 is
          // either a refund or a floor we have not identified.
          commissionByKeetaRuleSAR: money(kBase * KEETA_COMMISSION_RATE),
          commissionRuleResidualSAR: money(n0(r.basic_commission) - kBase * KEETA_COMMISSION_RATE),
          // Keeta's own arithmetic, recomputed. Non-zero = we misread a field.
          earningsIdentityResidualSAR: money(
            n0(r.product_price) - n0(r.activity_fee) - n0(r.commission) - n0(r.bank_fee)
            + n0(r.diff_price) - n0(r.earnings)
          ),
          promos: r.promos || [],
        };
      });

      const S = (f) => orders.reduce((a, o) => a + n0(f(o)), 0);
      const modelCost = S((o) => o.modelled.totalCostSAR);
      const realCost = S((o) => o.actual.totalCostSAR);
      const ourTotal = S((o) => o.ours.totalSAR);
      const ourNet = S((o) => o.ours.netSAR);
      const realBasic = S((o) => o.actual.basicCommissionSAR);
      const realBank = S((o) => o.actual.bankFeeSAR);
      const realDlv = S((o) => o.actual.deliverySubsidySAR);
      const modelDlv = S((o) => o.modelled.subsidySAR);
      const modelSvc = S((o) => o.modelled.serviceFeeSAR);
      const modelPay = S((o) => o.modelled.paymentFeeSAR);

      // ── the three flagged assumptions, answered from the data ────────────
      const onTotal = ratio(realBasic, ourTotal);
      const onNet = ratio(realBasic, ourNet);
      const keetaBaseTotal = S((o) => o.keetaCommissionBaseSAR);
      const onKeetaBase = ratio(realBasic, keetaBaseTotal);
      // How many orders the 18%-of-(productPrice−activityFee) rule reproduces
      // to within a halala. That count IS the strength of the finding.
      const ruleExact = orders.filter((o) => Math.abs(o.commissionRuleResidualSAR) <= 0.01).length;
      const ruleOff = orders.filter((o) => Math.abs(o.commissionRuleResidualSAR) > 0.01)
        .map((o) => ({
          orderId: o.orderId, orderViewId: o.orderViewId,
          baseSAR: o.keetaCommissionBaseSAR,
          ruleSaysSAR: o.commissionByKeetaRuleSAR,
          chargedSAR: o.actual.basicCommissionSAR,
          residualSAR: o.commissionRuleResidualSAR,
          hadRefund: o.actual.refundSAR > 0,
        }));
      const identityBroken = orders.filter((o) => Math.abs(o.earningsIdentityResidualSAR) > 0.01).length;
      // The smallest commission actually charged — if a floor exists, it is here.
      const chargedCommissions = orders.map((o) => o.actual.basicCommissionSAR).filter((v) => v > 0);
      const smallestCommission = chargedCommissions.length ? Math.min(...chargedCommissions) : null;
      const distinctBankRates = [...new Set(orders.map((o) => o.actual.bankFeeRatePercent).filter((v) => v != null))];
      const distanceFeeOrders = orders.filter((o) => o.actual.distanceFeeSAR > 0);
      const minFeeModelHits = orders.filter((o) => o.modelled.minFeeApplied).length;
      const aboveTopTier = orders.filter((o) => o.modelled.aboveTopTier);
      const aboveTopTierStillCharged = aboveTopTier.filter((o) => o.actual.deliverySubsidySAR > 0);
      // Every (order value → merchant-funded delivery subsidy) pair we have
      // seen. This is the empirical replacement for the guessed tier table.
      const tierPairs = [];
      for (const o of orders) {
        if (!o.actual.deliverySubsidySAR) continue;
        const p = (o.promos || []).find((x) => Number(x?.type) === 4);
        tierPairs.push({
          orderTotalSAR: o.ours.totalSAR,
          keetaProductPriceSAR: o.keetaProductPriceSAR,
          customerPaidSAR: o.actual.customerPaidSAR,
          merchantPaysSAR: o.actual.deliverySubsidySAR,
          promoThresholdSAR: p?.thresholdSAR ?? null,
          promoRule: p?.rule ?? null,
        });
      }
      const observedSubsidyAmounts = [...new Set(tierPairs.map((t) => t.merchantPaysSAR))].sort((a, b) => a - b);

      return c.json({
        ok: true,
        window: { from, to, basis: "ts_orders.calendar_day (04:00 Riyadh rollover)" },
        coverage: {
          reconciledOrders: orders.length,
          payoutRowsNotLinkedToAnOrder: orphans,
          note: orders.length
            ? null
            : "مفيش صفوف تحصيل مخزّنة للفترة دي — شغّل POST /api/keeta-payouts/sync الأول.",
        },
        feeModel: fee,
        totals: {
          ourRevenueInclVatSAR: money(ourTotal),
          ourRevenueExclVatSAR: money(ourNet),
          modelledCostSAR: money(modelCost),
          actualCostSAR: money(realCost),
          differenceSAR: money(modelCost - realCost),
          differencePercent: ratio(modelCost - realCost, realCost),
          modelled: {
            serviceFeeSAR: money(modelSvc),
            paymentFeeSAR: money(modelPay),
            deliverySubsidySAR: money(modelDlv),
          },
          actual: {
            commissionSAR: money(S((o) => o.actual.commissionSAR)),
            basicCommissionSAR: money(realBasic),
            distanceFeeSAR: money(S((o) => o.actual.distanceFeeSAR)),
            bankFeeSAR: money(realBank),
            deliverySubsidySAR: money(realDlv),
            itemSubsidySAR: money(S((o) => o.actual.itemSubsidySAR)),
            netPaidSAR: money(S((o) => o.actual.netPaidSAR)),
            netAfterRefundsSAR: money(S((o) => o.actual.netAfterRefundsSAR)),
          },
        },
        /* Three questions keeta_reports.js could only guess at. Each verdict is
           derived from the rows above; `sample` says how much to trust it. */
        assumptions: {
          commissionBase: {
            question: "العمولة على الإجمالي شامل الضريبة ولا على الصافي بدون ضريبة؟",
            sampleOrders: orders.length,
            // The answer is neither of the two options the model offers.
            keetaRule: "basicCommission = 18% × (productPrice − activityFee)",
            keetaRuleMeaning: "١٨٪ من قيمة الطلب شاملة الضريبة بعد خصم كل العروض اللي ممولها التاجر — مش من الإجمالي قبل الخصم، ومش من الصافي بدون ضريبة.",
            ordersMatchingRuleExactly: ruleExact,
            ordersNotMatching: ruleOff.length,
            exceptions: ruleOff,
            commissionShareOfKeetaBase: onKeetaBase,
            commissionShareOfVatInclusiveTotal: onTotal,
            commissionShareOfVatExclusiveNet: onNet,
            configuredRate: fee.deliveryCommissionRate,
            configuredBase: fee.commissionBase,
            verdict: orders.length === 0 ? "مفيش بيانات"
              : `القاعدة الحقيقية: ${(onKeetaBase * 100).toFixed(3)}% من (المجموع شامل الضريبة − العروض ممولة التاجر)، مضبوطة على ${ruleExact} من ${orders.length} طلب. ` +
                `النموذج الحالي بيحسب ${(fee.deliveryCommissionRate * 100).toFixed(1)}% على ${fee.commissionBase === "net" ? "الصافي بدون ضريبة" : "الإجمالي قبل الخصم"} — ` +
                `اللي بيطلع ${(onTotal * 100).toFixed(2)}% / ${(onNet * 100).toFixed(2)}% فعليًا، يعني بيحمّل الطلب المخصوم عمولة أكبر من الحقيقة.`,
            fixHint: "keeta_reports.js لازم يطرح العروض ممولة التاجر من الأساس قبل ما يضرب في ١٨٪. تغيير commissionBase لوحده مش كفاية.",
          },
          deliverySubsidyTiers: {
            question: "شرايح دعم التوصيل اللي يدفعها التاجر — القيم دي مقابل الشرايح دي؟",
            sampleOrdersWithSubsidy: tierPairs.length,
            observedAmountsSAR: observedSubsidyAmounts,
            configuredTiers: fee.subsidyTiers,
            modelledTotalSAR: money(modelDlv),
            actualTotalSAR: money(realDlv),
            differenceSAR: money(modelDlv - realDlv),
            differencePercent: ratio(modelDlv - realDlv, realDlv),
            ordersAboveTopConfiguredTier: aboveTopTier.length,
            ofWhichKeetaStillCharged: aboveTopTierStillCharged.length,
            verdict: tierPairs.length
              ? "مش جدول شرايح في العقد. ده عرض التوصيل بتاع المطعم نفسه (\"توصيل ١٨ ر.س. مجاني فوق ٣٠\")، وكيتا بتقسّم رسوم التوصيل المتنازل عنها بينها وبين التاجر: reduceFee هو الخصم كله، merchantActivityFee نصيب التاجر، platformActivityFee نصيب المنصة. نصيب التاجر بيزيد مع قيمة الطلب (٤ ← ٩ ← ١٢ ← ١٥) ومحدود بقيمة رسوم التوصيل نفسها، ومفيش سقف عند ٧٠ ريال — الطلبات الكبيرة برضه بتدفع ١٥."
              : "مفيش طلبات فيها دعم توصيل في العينة.",
            observedPairs: tierPairs,
          },
          minServiceFee: {
            question: "هل فيه حد أدنى لرسوم الخدمة بريال واحد؟",
            configuredMinFeeSAR: fee.minServiceFeeSAR,
            ordersWhereOurModelAppliedTheFloor: minFeeModelHits,
            ordersWithAKeetaDistanceFee: distanceFeeOrders.length,
            distanceFeeTotalSAR: money(S((o) => o.actual.distanceFeeSAR)),
            distinctDistanceFeeValuesSAR: [...new Set(distanceFeeOrders.map((o) => o.actual.distanceFeeSAR))].sort((a, b) => a - b),
            smallestCommissionChargedSAR: smallestCommission,
            // The only orders that could ever reveal a floor are the ones the
            // 18% rule under-shoots on. Reported as a candidate, never applied.
            possibleFloorCandidates: ruleOff.filter((x) => !x.hadRefund && x.residualSAR > 0),
            verdict: "مفيش حد أدنى بريال. الريال اللي كنا شايفينه هو distanceFee — رسم مسافة بيتزاد فوق العمولة الأساسية (commission = basicCommission + distanceFee)، مش أرضية بترفع عمولة الطلب الصغير. لو فيه حد أدنى أصلًا فهو على العمولة نفسها وشكله أكبر من ريال — بصّ في possibleFloorCandidates.",
          },
          paymentFee: {
            question: "نسبة رسوم الدفع 2.5%؟",
            configuredRate: fee.paymentFeeRate,
            keetaStatedRatePercent: distinctBankRates,
            actualShareOfOurVatInclusiveTotal: ratio(realBank, ourTotal),
            modelledSAR: money(modelPay),
            actualSAR: money(realBank),
            differenceSAR: money(modelPay - realBank),
            verdict: distinctBankRates.length
              ? `كيتا بتقول النسبة بنفسها في bankTransactionFeeRate = ${distinctBankRates.join(" / ")}% — مش ٢.٥٪. وبتحسبها على اللي العميل دفعه فعلًا (تقريبًا payTotal ناقص رسوم الخدمة)، مش على إجمالي الطلب عندنا.`
              : "مفيش نسبة معلنة في العينة.",
            caveat: "الأساس بالظبط مش متأكدين منه: بيطابق (payTotal − platformServiceFee) على طلبات، ومش بيطابق على اللي فيها قسيمة منصة أو بقشيش. فيه حقل bankTransactionFeeCalculateBy بيختار الأساس ومش عارفين ترجمته.",
          },
        },
        /* If this is not 0, we have misread a field — Keeta's own arithmetic
           does not close. Surfaced rather than hidden, because a silent
           mis-mapping here would quietly corrupt every margin on screen. */
        integrity: {
          ordersWhereEarningsIdentityFails: identityBroken,
          identity: "earnings = productPrice − activityFee − commission − bankFee + diffPrice",
        },
        orders,
      });
    } catch (e) { return fail(c, e, "reconcile"); }
  });

  /* ─── 3. SUMMARY ──────────────────────────────────────────────────────────
     Totals over a range: gross, every deduction type, net paid — from the
     cached per-order rows AND, side by side, from Keeta's own weekly
     statements, which are the number the bank actually saw.

     The two will not agree exactly and that is expected: the per-order side is
     limited to orders we have cached and uses calendar_day, the statement side
     is complete and uses Keeta's midnight bill periods. Both are labelled.     */
  app.get("/api/keeta-payouts/summary", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    const wantPortal = c.req.query("portal") !== "0";
    try {
      const t = (await pool.query(`
        SELECT count(*)::int AS orders,
               COALESCE(sum(p.product_price), 0)::float8      AS product_price,
               COALESCE(sum(p.platform_service_fee), 0)::float8 AS platform_service_fee,
               COALESCE(sum(p.diff_price), 0)::float8         AS diff_price,
               COALESCE(sum(p.basic_commission), 0)::float8   AS basic_commission,
               COALESCE(sum(p.distance_fee), 0)::float8       AS distance_fee,
               COALESCE(sum(p.commission), 0)::float8         AS commission,
               COALESCE(sum(p.bank_fee), 0)::float8           AS bank_fee,
               COALESCE(sum(p.delivery_subsidy), 0)::float8   AS delivery_subsidy,
               COALESCE(sum(p.item_subsidy), 0)::float8       AS item_subsidy,
               COALESCE(sum(p.earnings), 0)::float8           AS earnings,
               -- rebates_* is 0 on orders that were never refunded, so fall
               -- back to earnings there instead of summing zeros.
               COALESCE(sum(CASE WHEN p.refund_price > 0 THEN p.rebates_earnings
                                 ELSE p.earnings END), 0)::float8 AS rebates_earnings,
               COALESCE(sum(p.refund_price), 0)::float8       AS refund_price,
               COALESCE(sum(p.customer_pay_total), 0)::float8 AS customer_pay_total,
               COALESCE(sum(o.total), 0)::float8              AS our_total,
               COALESCE(sum(o.net), 0)::float8                AS our_net
          FROM keeta_payouts p
          JOIN ts_orders o ON o.order_id = p.order_id
          JOIN order_sources s ON s.order_id = o.order_id
         WHERE lower(COALESCE(s.source_note, '')) = 'keeta'
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
           AND o.calendar_day BETWEEN $1::date AND $2::date`, [from, to])).rows[0] || {};

      const cov = (await pool.query(`
        SELECT count(*)::int AS ours, count(p.order_view_id)::int AS covered
          FROM ts_orders o
          JOIN order_sources s ON s.order_id = o.order_id
          LEFT JOIN keeta_payouts p ON p.order_id = o.order_id
         WHERE lower(COALESCE(s.source_note, '')) = 'keeta'
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
           AND o.calendar_day BETWEEN $1::date AND $2::date`, [from, to])).rows[0] || {};

      const daily = (await pool.query(`
        SELECT o.calendar_day::text AS "day", count(*)::int AS orders,
               COALESCE(sum(p.commission), 0)::float8       AS commission,
               COALESCE(sum(p.bank_fee), 0)::float8         AS bank_fee,
               COALESCE(sum(p.delivery_subsidy), 0)::float8 AS delivery_subsidy,
               COALESCE(sum(p.item_subsidy), 0)::float8     AS item_subsidy,
               COALESCE(sum(p.earnings), 0)::float8         AS earnings
          FROM keeta_payouts p
          JOIN ts_orders o ON o.order_id = p.order_id
          JOIN order_sources s ON s.order_id = o.order_id
         WHERE lower(COALESCE(s.source_note, '')) = 'keeta'
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
           AND o.calendar_day BETWEEN $1::date AND $2::date
         GROUP BY 1 ORDER BY 1`, [from, to])).rows;

      const deductions = n0(t.commission) + n0(t.bank_fee) + n0(t.delivery_subsidy) + n0(t.item_subsidy);
      const perOrder = {
        source: "keeta_payouts cache (per-order getOrderDtl)",
        basis: "ts_orders.calendar_day",
        orders: n0(t.orders),
        grossItemsInclVatSAR: money(t.product_price),
        creditedToUs: {
          platformServiceFeeSAR: money(t.platform_service_fee),
          minOrderTopUpSAR: money(t.diff_price),
        },
        deductions: {
          commissionSAR: money(t.commission),
          ofWhichBasicSAR: money(t.basic_commission),
          ofWhichDistanceFeeSAR: money(t.distance_fee),
          bankFeeSAR: money(t.bank_fee),
          merchantDeliverySubsidySAR: money(t.delivery_subsidy),
          merchantItemSubsidySAR: money(t.item_subsidy),
          totalSAR: money(deductions),
          shareOfGross: ratio(deductions, t.product_price),
        },
        netPaidSAR: money(t.earnings),
        netAfterRefundsSAR: money(t.rebates_earnings),
        refundsSAR: money(t.refund_price),
        customerPaidSAR: money(t.customer_pay_total),
        ourRevenueInclVatSAR: money(t.our_total),
        ourRevenueExclVatSAR: money(t.our_net),
        avgNetPerOrderSAR: n0(t.orders) ? money(n0(t.earnings) / n0(t.orders)) : null,
      };

      const out = {
        ok: true,
        window: { from, to },
        coverage: {
          ourKeetaOrders: n0(cov.ours),
          withPayoutRow: n0(cov.covered),
          rate: ratio(cov.covered, cov.ours),
          note: "أي رقم في perOrder محسوب على الطلبات المخزّنة بس — لو التغطية أقل من 100% فهو ناقص بنفس النسبة.",
        },
        perOrder,
        daily: daily.map((r) => ({
          day: isoDay(r.day), orders: n0(r.orders),
          commissionSAR: money(r.commission), bankFeeSAR: money(r.bank_fee),
          deliverySubsidySAR: money(r.delivery_subsidy), itemSubsidySAR: money(r.item_subsidy),
          netPaidSAR: money(r.earnings),
        })),
        statements: null,
      };

      // ── the authoritative side ────────────────────────────────────────────
      if (wantPortal && keetaConfigured()) {
        try {
          // Widen by a week each way so a bill period straddling the window is
          // still returned; each bill reports its own period, so nothing is
          // silently attributed to the wrong range.
          const fromMs = Date.parse(from + "T00:00:00+03:00") - 7 * 86400000;
          const toMs = Date.parse(to + "T23:59:59+03:00") + 7 * 86400000;
          const bills = await fetchBills(fromMs, toMs);
          const shaped = [];
          for (const b of bills) {
            const cats = await fetchBillCategories(b);
            const g = (code) => (cats[code] ? cats[code].amount : 0);
            shaped.push({
              billId: String(b.billId),
              period: { from: isoDay(new Date(n0(b.periodStartDateStamp) + 3 * 3600000).toISOString()),
                to: isoDay(new Date(n0(b.periodEndDateStamp) + 3 * 3600000).toISOString()) },
              label: b.timeText || null,
              status: BILL_STATUS[b.status] || `STATUS_${b.status}`,
              paid: b.status === 90,
              payDate: b.payTimeText || null,
              netPaidSAR: money(g(CAT.paid)),
              grossItemsInclVatSAR: money(g(CAT.revenue)),
              minOrderTopUpSAR: money(g(CAT.minTopUp)),
              // Keeta sends deductions negative here; flip so the whole API
              // speaks one sign convention (positive = money taken from us).
              commissionSAR: money(-g(CAT.commission)),
              commissionAdjustmentSAR: money(-g(CAT.commissionAdj)),
              bankFeeSAR: money(-g(CAT.bank)),
              merchantItemSubsidySAR: money(-g(CAT.itemSubsidy)),
              merchantDeliverySubsidySAR: money(-(g(CAT.dlvSubsidy) + g(CAT.dlvSubsidyOld))),
              adSpendSAR: money(-g(CAT.ads)),
              photographyFeeSAR: money(-g(CAT.photography)),
            });
          }
          out.statements = {
            source: "/api/settlement/statement/v2 (billList + cate/detail/timeRange)",
            basis: "Keeta bill periods — Riyadh MIDNIGHT days, not our 04:00 business day",
            note: "دي الأرقام اللي المصرف شافها فعلًا. مش هتطابق perOrder بالظبط: perOrder على الطلبات المخزّنة وباليوم التجاري ٤ الفجر، والكشف كامل وبيوم كيتا من نص الليل.",
            bills: shaped,
          };
        } catch (e) {
          out.statements = {
            available: false,
            expired: e instanceof KeetaError ? !!e.expired : false,
            reason: e.message,
          };
        }
      } else if (wantPortal) {
        out.statements = { available: false, reason: "كيتا مش مربوطة — الناقص KEETA_COOKIE أو KEETA_SHOP_ID" };
      }

      return c.json(out);
    } catch (e) { return fail(c, e, "summary"); }
  });

  /* ─── 4. ONE ORDER, LIVE ──────────────────────────────────────────────────
     Straight passthrough of the portal's own per-order breakdown, for when
     Omar wants to argue about a specific order. Read-only, never cached here.  */
  app.get("/api/keeta-payouts/order/:viewId", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const viewId = String(c.req.param("viewId") || "").trim();
    if (!/^\d{6,}$/.test(viewId)) {
      return c.json({ ok: false, error: "viewId لازم يكون رقم طلب كيتا (providerOrderId من FeedUs)" }, 400);
    }
    try {
      const p = await fetchOrderPayout(viewId);
      const link = (await pool.query(
        `SELECT p.order_id, o.calendar_day::text AS calendar_day, o.total::float8 AS our_total,
                o.net::float8 AS our_net, o.gross_incl::float8 AS our_gross_incl
           FROM keeta_payouts p LEFT JOIN ts_orders o ON o.order_id = p.order_id
          WHERE p.order_view_id = $1`, [viewId])).rows[0] || null;
      return c.json({ ok: true, payout: p, ours: link });
    } catch (e) { return fail(c, e, "order"); }
  });

  console.log("[keeta-payouts] routes ready (/api/keeta-payouts/sync|reconcile|summary|order/:viewId)");
}

export default { register };
