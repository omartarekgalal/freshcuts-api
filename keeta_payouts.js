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

   ═════════════ ROUND 2 (2026-08-02) — measured on 153 of 153 orders ═══════
   Full coverage was reached, so several round-1 statements are now superseded.
   Everything below was verified against the five settlement bills, and bills
   1-4 (149 orders, 01/07-31/07) reconcile to the HALALA on gross items, item
   subsidy, delivery subsidy, commission and bank fee.

   1. ID COVERAGE IS SOLVED. `feedus.js` also exports `fetchSalesOrders(from,to)`
      — a paginated JSON API whose `order_id` IS the Keeta `orderViewIdStr`.
      149/149 Keeta rows carried a usable id. `fetchPosLogs` is still used on top
      because it reaches the newest days the sales dashboard has not ingested.
      Round 1's "we can only ever see ~13 ids" is wrong.

   2. THE COMMISSION RULE, complete:
        delivery: max(SAR 5.00, 18% x (productPrice - activityFee))
        pickup:   max(SAR 1.00,  3% x (productPrice - activityFee))
      * The SAR 5.00 delivery floor is real: 6 of 6 orders whose 18% fell below
        5.00 were charged exactly 5.00, and the boundary is exact (base 27.80 ->
        5.00 unfloored, base 28.00 -> 5.04). Round 1 called this a one-order
        hypothesis; it is now settled. Cost over the window: SAR 1.56.
      * The SAR 1.00 minimum DOES exist — on PICKUP only. Round 1 never saw a
        pickup order. 8 pickup orders, 3% exact, floor bit on 7. Cost SAR 5.50.
      * `distanceFee` is SAR 1.00 flat, on 29 of 147 orders, ADDED to the
        commission. Statement category 30101, despite being named
        "العمولة الأساسية", carries commission INCLUDING distanceFee.

   3. THE BANK-FEE BASE IS SOLVED — it is `payTotal - platformFee - tip`.
        bankTransactionFee = 2.875% x (payTotal - platformFee - tip)
      Exact on 147 of 147 orders. That decodes `bankTransactionFeeCalculateBy: 0`.
      Round 1's "base ~= customer paid, we cannot pin it" is superseded.

   4. REFUNDS LIVE IN `orderInfo`, NOT IN A SEPARATE ENDPOINT:
        refundInfos[]        the after-sale ledger (applyType, refundType,
                             partRefund, refundMoney/actRefundMoney in halalas,
                             duty/responsible/commonExt.refundBearer = who pays,
                             applyReason, commonExt.cancelType, refundStatusHisList)
        partRefundOrderTag   bool
        rebatesTag           bool — the rebates* family is populated
        refundInfo           appeals container; empty for this shop
      `/api/order/statisticsAfterSaleOrder` was never needed and is NOT called.
      Three refunds exist in the whole visible history, of three different kinds:
        (a) auto-cancel, merchant never accepted (applyType 3001, refundBearer -1)
            -> settlement reverses EVERYTHING including the bank fee. Costs nothing.
        (b) full after-sale refund, merchant at fault (applyType 1001, refundBearer 20)
            -> revenue, commission and both subsidies reversed, but the BANK FEE
               IS RETAINED. Proven: it is the entire 2.48 residual in bill 4.
        (c) partial refund (applyType 2002, partRefund 1) -> the rebates* family
            appears. Commission fell 1.92 on a base that fell 24.00 = exactly
            8.000%, i.e. only the contract's 8-point data-service share came back
            and the 10-point delivery share was kept. rebatesBankTransactionFee=0
            means NOTHING was rebated: the recomputed identity closes only with
            the ORIGINAL bank fee.
      ** getOrderDtl is NOT refund-aware for (a) and (b): it still shows the full
         original `earnings`. Only the settlement knows. Never quote `earnings`
         on an order whose status is 50. **

   5. STATUS 50 = reversed/cancelled. Its revenue and fees are absent from the
      statement entirely. FeedUs may still report such an order as "Accepted",
      and `ts_orders` holds it as a normal completed sale — so our own revenue
      overstates Keeta by the full value of those orders.

   6. AD SPEND IS BILLED WITH A ONE-DAY LAG. Statement category 20205 for a bill
      period [from..to] equals the ads portal's daily `debit` summed over
      [from-1 .. to-1]. Exact on all five bills. Ad spend is a real deduction
      from the payout, not a dashboard-only number.

   7. VAT: category 20204 is 0.00 on every bill — Keeta withholds nothing and
      Omar remits the 15% himself. Because `productPrice` is VAT-INCLUSIVE, the
      18% is levied on a base that contains the government's money.

   ── STILL NOT CALLED (writes) ────────────────────────────────────────────
      everything listed above, plus /api/bff/ad/poi/v1/sspcpc/plan/update/status,
      /api/bff/ad/poi/v1/sspcpc/operation/update and
      /api/ad/billing/account/fund/allocate. The ad routes here are READ ONLY.
═══════════════════════════════════════════════════════════════════════════ */

import { keetaCall, KeetaError, configured as keetaConfigured } from "./keeta.js";
import { fetchPosLogs, fetchSalesOrders, ENABLED as FEEDUS_ENABLED } from "./feedus.js";

const SHOP_ID = process.env.KEETA_SHOP_ID || "1430391221";
/* The ad account the CPC plan hangs off. Same default keeta.js uses. */
const ACCT_ID = process.env.KEETA_ACCT_ID || "4611686018430691085";
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

    -- ── round 2: the refund surface ───────────────────────────────────────
    -- The refunds column is orderInfo.refundInfos normalised. Empty array = no refund
    -- ever happened, which is NOT the same as "refunded zero" — an order that
    -- was reversed entirely (status 50) carries a refund row while its
    -- merchantFee still shows the full original earnings.
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS refunds JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS refunded_to_customer NUMERIC DEFAULT 0;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS part_refund BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS has_rebates BOOLEAN NOT NULL DEFAULT FALSE;
    -- Keeta's own post-refund recomputation. NULL (not 0) where Keeta did not
    -- populate it, so "not rebated" can never be misread as "rebated to zero".
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS rebates_product_price NUMERIC;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS rebates_activity_fee  NUMERIC;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS rebates_commission    NUMERIC;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS rebates_bank_fee      NUMERIC;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS rebates_distance_fee  NUMERIC;
    -- customerFee components — needed because the bank fee base is
    -- (payTotal - platformFee - tip) and nothing else reproduces it.
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS customer_platform_fee NUMERIC DEFAULT 0;
    ALTER TABLE keeta_payouts ADD COLUMN IF NOT EXISTS customer_tip          NUMERIC DEFAULT 0;
    CREATE INDEX IF NOT EXISTS keeta_payouts_status_idx ON keeta_payouts(order_status);

    -- One row per settlement bill: the authoritative money-moved view, cached
    -- so the audit routes do not have to re-walk the portal on every request.
    CREATE TABLE IF NOT EXISTS keeta_bills (
      bill_id            TEXT PRIMARY KEY,
      period_from        DATE,
      period_to          DATE,
      period_from_ms     BIGINT,
      period_to_ms       BIGINT,
      label              TEXT NOT NULL DEFAULT '',
      status             INT,
      status_name        TEXT NOT NULL DEFAULT '',
      pay_date           TEXT NOT NULL DEFAULT '',
      -- Keeta signs deductions negative here; we store its own sign untouched
      -- in the categories column and expose flipped values in the routes.
      categories         JSONB NOT NULL DEFAULT '{}'::jsonb,
      net_paid           NUMERIC DEFAULT 0,
      fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS keeta_bills_period_idx ON keeta_bills(period_from);
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
   THE MEASURED RULES — what Keeta actually does, as opposed to FEE_DEFAULTS
   above which is what the signed contract says. Every constant here was
   reproduced to the halala against the portal; the comment on each says on how
   many orders, because that IS the strength of the claim.
═══════════════════════════════════════════════════════════════════════════ */
const MEASURED = {
  // 133/139 delivery orders reproduce exactly; the other 6 are the floor below.
  deliveryCommissionRate: 0.18,
  // 8/8 pickup orders reproduce exactly.
  pickupCommissionRate: 0.03,
  // 6/6 delivery orders whose 18% fell under 5.00 were charged exactly 5.00,
  // and base 28.00 (18% = 5.04) was NOT floored. Boundary confirmed both sides.
  deliveryMinCommissionSAR: 5,
  // 7/8 pickup orders hit this; the 8th (base 34.50) paid a clean 3%.
  pickupMinCommissionSAR: 1,
  // Keeta ships this as a STRING percent in every payload: "2.875".
  bankFeeRate: 0.02875,
  // SAR 1.00 flat, never another value, on 29 of 147 orders. ADDED to commission.
  distanceFeeSAR: 1,
  // The base the 18%/3% is charged on: VAT-inclusive value after ALL
  // merchant-funded promotions.
  commissionBase: "productPrice - activityFee",
  // 147/147 exact. Decodes bankTransactionFeeCalculateBy: 0.
  bankFeeBase: "payTotal - platformFee - tip",
  // Saudi standard rate. Keeta withholds none of it (category 20204 = 0.00).
  vatRate: 0.15,
  sampleOrders: 153,
  sampleWindow: "2026-07-01 .. 2026-08-02",
};

/** Keeta's real commission for one order, from Keeta's own inputs. */
function measuredCommission({ productPrice, activityFee, isPickup, distanceFee }) {
  const base = money(n0(productPrice) - n0(activityFee));
  const rate = isPickup ? MEASURED.pickupCommissionRate : MEASURED.deliveryCommissionRate;
  const floor = isPickup ? MEASURED.pickupMinCommissionSAR : MEASURED.deliveryMinCommissionSAR;
  const raw = base * rate;
  const basic = money(Math.max(raw, floor));
  return {
    baseSAR: base,
    rate,
    rawSAR: money(raw),
    floorSAR: floor,
    floorApplied: raw < floor,
    floorCostSAR: raw < floor ? money(floor - raw) : 0,
    basicCommissionSAR: basic,
    // distanceFee is additive and we cannot predict WHICH orders get it, so it
    // is passed through from the payload rather than modelled.
    distanceFeeSAR: money(distanceFee),
    commissionSAR: money(basic + n0(distanceFee)),
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
  /* ── the refund ledger ──────────────────────────────────────────────────
     `refundInfos` is the only place a refund is actually recorded. On a fully
     reversed order (status 50) NOTHING in merchantFee changes — earnings still
     reads as if the order paid out — so this array is the sole signal. */
  const refundRows = Array.isArray(info.refundInfos) ? info.refundInfos : [];
  const parseExt = (x) => { try { return JSON.parse(x?.commonExt || "{}"); } catch { return {}; } };
  const refunds = refundRows.map((x) => {
    const ext = parseExt(x);
    return {
      refundId: x?.id != null ? String(x.id) : null,
      // 1001 customer after-sale claim, 2002 partial, 3001 auto-cancel (merchant
      // never accepted). Keeta does not publish this enum; these are observed.
      applyType: x?.applyType ?? null,
      refundType: x?.refundType ?? null,
      isPartial: Number(x?.partRefund) === 1,
      // status 5002 = refund completed.
      status: x?.status ?? null,
      completed: Number(x?.status) === 5002,
      refundedToCustomerSAR: hal(x?.actRefundMoney ?? x?.refundMoney),
      // duty/responsible/refundBearer all encode fault. 20 = merchant,
      // -1 = nobody (platform absorbs), 0 = unassigned.
      duty: x?.duty ?? null,
      responsible: x?.responsible ?? null,
      bearer: ext?.refundBearer ?? null,
      merchantAtFault: Number(x?.duty) === 20 || Number(ext?.refundBearer) === 20,
      cancelType: ext?.cancelType ?? null,
      compensationSAR: hal(ext?.compensationMoneyAmount),
      reason: x?.applyReason || null,
      at: Number(x?.ctime) ? new Date(Number(x.ctime)).toISOString() : null,
    };
  });
  const refundedToCustomer = money(refunds.reduce((a, r) => a + n0(r.refundedToCustomerSAR), 0));

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
    /* Keeta's post-refund recomputation. NULL where Keeta left the field out —
       storing 0 there would read as "rebated down to zero", which is the
       opposite of the truth. Note rebatesBankTransactionFee is genuinely 0 on
       the one partial refund we have: nothing of the payment fee came back. */
    rebatesProductPrice: m.rebatesProductPrice === undefined ? null : hal(m.rebatesProductPrice),
    rebatesActivityFee: m.rebatesActivityFee === undefined ? null : hal(m.rebatesActivityFee),
    rebatesCommission: (m.rebatesCommission ?? m.rebatesBrokerage) === undefined
      ? null : hal(m.rebatesCommission ?? m.rebatesBrokerage),
    rebatesBankFee: m.rebatesBankTransactionFee === undefined ? null : hal(m.rebatesBankTransactionFee),
    rebatesDistanceFee: m.rebatesDistanceFee === undefined ? null : hal(m.rebatesDistanceFee),
    refunds,
    refundedToCustomer,
    partRefund: !!info.partRefundOrderTag,
    hasRebates: !!info.rebatesTag,
    /* status 50 = the order was reversed. Its money is absent from the
       settlement even though merchantFee still shows the original earnings. */
    reversed: Number(mo.status ?? base.status) === 50,
    customerPayTotal: hal(c.payTotal),
    customerShippingFee: hal(c.shippingFee),
    customerDiscounts: hal(c.discounts),
    customerPlatformFee: hal(c.platformFee),
    customerTip: hal(c.tip),
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
        /* TWO FeedUs sources, deliberately. `fetchSalesOrders` is the one that
           gives full historical coverage — its `order_id` IS the Keeta
           orderViewIdStr, and it takes a date range, so it reaches every order
           in the window (149/149 on the first full run). `fetchPosLogs` only
           walks a few shallow pages, but it is the ONLY source that carries the
           TabSense order id, and it sees the newest orders before the sales
           dashboard has ingested them. Union of both. */
        const from = dayArg(body.from, daysAgoISO(45));
        const to = dayArg(body.to, todayISO());
        const seen = new Map();   // viewId -> orderId|null
        let salesErr = null, logsErr = null, salesCount = 0;

        for (let i = 0; i < 2; i++) {
          try {
            const rows = await fetchSalesOrders(from, to, { perPage: 100, maxPages: 40 });
            salesCount = rows.length;
            for (const r of rows) {
              if (!/keeta/i.test(r.provider || "")) continue;
              const v = String(r.orderId || "").trim();
              if (!/^\d{6,}$/.test(v)) continue;
              if (!seen.has(v)) seen.set(v, null);
            }
            salesErr = null; break;
          } catch (e) { salesErr = e; await sleep(1500); }
        }
        for (let i = 0; i < 2; i++) {
          try {
            const logs = await fetchPosLogs({ pages: POSLOG_PAGES });
            for (const r of logs) {
              if (!/keeta/i.test(r.provider || "")) continue;
              const v = String(r.providerOrderId || "").trim();
              if (!/^\d{6,}$/.test(v)) continue;
              // The POS log is the only carrier of the TabSense id, so it wins
              // on that field even when the sales API already supplied the id.
              seen.set(v, r.tabsenseOrderId || seen.get(v) || null);
            }
            logsErr = null; break;
          } catch (e) { logsErr = e; await sleep(1500); }
        }
        if (salesErr && logsErr) {
          return c.json({ ok: false, error: `تعذر قراءة FeedUs: ${salesErr.message} / ${logsErr.message}` }, 502);
        }
        for (const [viewId, orderId] of seen) candidates.push({ viewId, orderId });
        notes.push(
          `مصادر المعرفات: مبيعات FeedUs (${from} → ${to}) رجّعت ${salesCount} سطر` +
          (salesErr ? ` (فشلت: ${salesErr.message})` : "") +
          `، وسجل POS أضاف معرفات TabSense` + (logsErr ? ` (فشل: ${logsErr.message})` : "") +
          `. الإجمالي ${candidates.length} طلب كيتا.`
        );
        const withTs = candidates.filter((x) => x.orderId).length;
        if (withTs < candidates.length) {
          notes.push(`${candidates.length - withTs} طلب من غير معرّف TabSense — بيتخزّن وبيتحسب في المطابقة مع الكشف، لكن مش هيظهر في /reconcile اللي بيربط على ts_orders.`);
        }
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
             promos, earnings_formula, raw, items,
             refunds, refunded_to_customer, part_refund, has_rebates,
             rebates_product_price, rebates_activity_fee, rebates_commission,
             rebates_bank_fee, rebates_distance_fee,
             customer_platform_fee, customer_tip, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                   $21,$22,$23,$24,$25,$26,$27,$28,$29,
                   $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40, NOW())
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
             raw = EXCLUDED.raw, items = EXCLUDED.items,
             refunds = EXCLUDED.refunds,
             refunded_to_customer = EXCLUDED.refunded_to_customer,
             part_refund = EXCLUDED.part_refund, has_rebates = EXCLUDED.has_rebates,
             rebates_product_price = EXCLUDED.rebates_product_price,
             rebates_activity_fee = EXCLUDED.rebates_activity_fee,
             rebates_commission = EXCLUDED.rebates_commission,
             rebates_bank_fee = EXCLUDED.rebates_bank_fee,
             rebates_distance_fee = EXCLUDED.rebates_distance_fee,
             customer_platform_fee = EXCLUDED.customer_platform_fee,
             customer_tip = EXCLUDED.customer_tip,
             fetched_at = NOW()`,
          [p.orderViewId, cand.orderId, p.shopId, p.orderTime, p.keetaDay, p.status,
            p.userGetMode, p.currency, p.productPrice, p.platformServiceFee, p.diffPrice,
            p.basicCommission, p.distanceFee, p.commission, p.bankFee, p.bankFeeRate,
            p.activityFee, p.deliverySubsidy, p.itemSubsidy, p.earnings, p.rebatesEarnings,
            p.refundPrice, p.customerPayTotal, p.customerShippingFee, p.customerDiscounts,
            jb ? jb(p.promos) : JSON.stringify(p.promos), p.earningsFormula,
            jb ? jb(p.raw || {}) : JSON.stringify(p.raw || {}),
            jb ? jb(p.items) : JSON.stringify(p.items),
            jb ? jb(p.refunds) : JSON.stringify(p.refunds), p.refundedToCustomer,
            p.partRefund, p.hasRebates,
            p.rebatesProductPrice, p.rebatesActivityFee, p.rebatesCommission,
            p.rebatesBankFee, p.rebatesDistanceFee,
            p.customerPlatformFee, p.customerTip]
        );
        stored++;
        await sleep(FETCH_GAP_MS);
      }

      /* ── link sweep ────────────────────────────────────────────────────
         Only `fetchPosLogs` carries the TabSense id, and it walks a handful of
         pages, so most rows arrive with order_id NULL. Recover the link from
         the money instead: round 1 proved `ts_orders.gross_incl` equals Keeta's
         `productPrice` to the halala, and the two clocks agree to within the
         POS-push delay. Require the match to be UNIQUE on both sides — an
         ambiguous match is left NULL rather than guessed, because a wrong link
         would silently attribute one order's fees to another order's revenue. */
      const linked = (await pool.query(`
        WITH cand AS (
          SELECT p.order_view_id, o.order_id,
                 count(*) OVER (PARTITION BY p.order_view_id) AS n_orders,
                 count(*) OVER (PARTITION BY o.order_id)      AS n_payouts
            FROM keeta_payouts p
            JOIN order_sources s ON lower(COALESCE(s.source_note, '')) = 'keeta'
            JOIN ts_orders o ON o.order_id = s.order_id
           WHERE p.order_id IS NULL
             AND p.order_time IS NOT NULL
             AND abs(o.gross_incl - p.product_price) <= 0.05
             AND o.order_date BETWEEN p.order_time - interval '90 minutes'
                                  AND p.order_time + interval '90 minutes'
             AND NOT EXISTS (SELECT 1 FROM keeta_payouts q WHERE q.order_id = o.order_id)
        )
        UPDATE keeta_payouts t
           SET order_id = c.order_id
          FROM cand c
         WHERE t.order_view_id = c.order_view_id
           AND c.n_orders = 1 AND c.n_payouts = 1
        RETURNING t.order_view_id`)).rowCount || 0;
      if (linked) notes.push(`ربطنا ${linked} طلب كمان بـ TabSense عن طريق تطابق القيمة شاملة الضريبة مع وقت الطلب (تطابق وحيد من الناحيتين فقط).`);

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
      // the rule that actually generated the reality. Round 2 completed this
      // rule: the rate depends on the channel and BOTH channels carry a floor.
      const orders = rows.map((r) => {
        const mdl = modelOrder(fee, { total: r.our_total, net: r.our_net, isPickup: !!r.is_pickup });
        // The base Keeta charges on: VAT-inclusive value after merchant promos.
        const kBase = money(n0(r.product_price) - n0(r.activity_fee));
        /* Keeta's own channel — `userGetMode`, not our order_option guess. A
           pickup order is billed at 3% with a SAR 1 floor, a delivery order at
           18% with a SAR 5 floor, so getting the channel wrong misprices it. */
        const keetaPickup = String(r.user_get_mode || "").toLowerCase() === "pickup";
        const mc = measuredCommission({
          productPrice: r.product_price, activityFee: r.activity_fee,
          isPickup: keetaPickup, distanceFee: r.distance_fee,
        });
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
          // What the MEASURED rule predicts vs what was charged — channel rate
          // plus the channel's floor. Anything but ~0 now means a genuine
          // anomaly, not a rule we have not identified yet.
          commissionByKeetaRuleSAR: mc.basicCommissionSAR,
          commissionRuleResidualSAR: money(n0(r.basic_commission) - mc.basicCommissionSAR),
          commissionRule: mc,
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
            keetaRuleComplete: "توصيل: max(5.00, 18% × الأساس) | استلام: max(1.00, 3% × الأساس) | + رسم مسافة 1.00 على بعض الطلبات",
            verdict: orders.length === 0 ? "مفيش بيانات"
              : `القاعدة الكاملة مضبوطة على ${ruleExact} من ${orders.length} طلب: ` +
                `توصيل ١٨٪ من (المجموع شامل الضريبة − العروض ممولة التاجر) بحد أدنى ٥ ر.س.، واستلام ٣٪ بنفس الأساس بحد أدنى ريال. ` +
                `النسبة الإجمالية بتطلع ${(onKeetaBase * 100).toFixed(3)}% لأن فيها طلبات استلام بـ٣٪. ` +
                `النموذج الحالي بيحسب ${(fee.deliveryCommissionRate * 100).toFixed(1)}% على ${fee.commissionBase === "net" ? "الصافي بدون ضريبة" : "الإجمالي قبل الخصم"} — ` +
                `يعني بيحمّل الطلب المخصوم عمولة أكبر من الحقيقة، وبيحمّل طلب الاستلام ١٨٪ بدل ٣٪.`,
            fixHint: "keeta_reports.js لازم (١) يطرح العروض ممولة التاجر من الأساس قبل ما يضرب في النسبة، (٢) يفرّق بين التوصيل والاستلام على userGetMode بتاع كيتا مش على order_option بتاعنا، (٣) يطبّق حد أدنى ٥ ر.س. على التوصيل مش ريال.",
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
            // Now measured, not guessed: both floors are real and neither is
            // the contract's SAR 1 on delivery.
            measuredDeliveryFloorSAR: MEASURED.deliveryMinCommissionSAR,
            measuredPickupFloorSAR: MEASURED.pickupMinCommissionSAR,
            residualsAfterApplyingTheMeasuredRule: ruleOff,
            verdict: "فيه حدين أدنى، ومفيش واحد فيهم بيطابق العقد على التوصيل. " +
              "التوصيل: حد أدنى ٥.٠٠ ر.س. — كل طلب توصيل الـ١٨٪ بتاعه أقل من ٥ اتحسب ٥.٠٠ بالظبط، وطلب أساسه ٢٨.٠٠ (١٨٪ = ٥.٠٤) ماتحسبش بالحد، يعني الحد عند ٥ بالضبط. العقد بيقول ريال. " +
              "الاستلام: حد أدنى ١.٠٠ ر.س. — مطابق للعقد. " +
              "أما الريال اللي كنا شايفينه على طلبات التوصيل فهو distanceFee، رسم مسافة منفصل بيتزاد فوق العمولة (commission = basicCommission + distanceFee) ومش موجود في العقد أصلًا. " +
              "تفاصيل الأثر النقدي في /api/keeta-payouts/contract-audit.",
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

  /* ─── SHARED: cached per-order rows for a KEETA-DAY window ────────────────
     These three routes are about Keeta's money, so they window on `keeta_day`
     (Riyadh midnight — Keeta's own bill day), NOT on ts_orders.calendar_day.
     They also do not JOIN ts_orders, so orders FeedUs never handed a TabSense
     id to are still counted. */
  async function cachedRows(from, to) {
    return (await pool.query(`
      SELECT order_view_id, order_id, keeta_day::text AS keeta_day, order_time,
             order_status, user_get_mode,
             product_price::float8 AS product_price, activity_fee::float8 AS activity_fee,
             delivery_subsidy::float8 AS delivery_subsidy, item_subsidy::float8 AS item_subsidy,
             basic_commission::float8 AS basic_commission, distance_fee::float8 AS distance_fee,
             commission::float8 AS commission, bank_fee::float8 AS bank_fee,
             bank_fee_rate::float8 AS bank_fee_rate,
             platform_service_fee::float8 AS platform_service_fee, diff_price::float8 AS diff_price,
             earnings::float8 AS earnings, rebates_earnings::float8 AS rebates_earnings,
             refund_price::float8 AS refund_price,
             customer_pay_total::float8 AS customer_pay_total,
             customer_platform_fee::float8 AS customer_platform_fee,
             customer_tip::float8 AS customer_tip,
             customer_shipping_fee::float8 AS customer_shipping_fee,
             refunds, refunded_to_customer::float8 AS refunded_to_customer,
             part_refund, has_rebates,
             rebates_product_price::float8 AS rebates_product_price,
             rebates_activity_fee::float8  AS rebates_activity_fee,
             rebates_commission::float8    AS rebates_commission,
             rebates_bank_fee::float8      AS rebates_bank_fee,
             rebates_distance_fee::float8  AS rebates_distance_fee,
             promos
        FROM keeta_payouts
       WHERE keeta_day BETWEEN $1::date AND $2::date
       ORDER BY order_time`, [from, to])).rows;
  }
  const isPickupRow = (r) => String(r.user_get_mode || "").toLowerCase() === "pickup";
  /** status 50 = reversed. Its money is absent from the settlement entirely. */
  const isReversed = (r) => Number(r.order_status) === 50;

  /* ─── SHARED: bills, cached in keeta_bills ────────────────────────────────
     `cate/detail/timeRange` snaps to the bill period containing the start
     stamp, so each bill is always asked for with its OWN stamps.              */
  async function syncBills(fromMs, toMs) {
    const bills = await fetchBills(fromMs, toMs);
    const out = [];
    for (const b of bills) {
      const cats = await fetchBillCategories(b);
      // Keep Keeta's own signs in `categories`; flip only at the edges.
      const flat = {};
      for (const [code, v] of Object.entries(cats)) flat[code] = v.amount;
      const row = {
        billId: String(b.billId),
        periodFrom: isoDay(new Date(n0(b.periodStartDateStamp) + 3 * 3600000).toISOString()),
        periodTo: isoDay(new Date(n0(b.periodEndDateStamp) + 3 * 3600000).toISOString()),
        fromMs: n0(b.periodStartDateStamp), toMs: n0(b.periodEndDateStamp),
        label: b.timeText || "", status: b.status ?? null,
        statusName: BILL_STATUS[b.status] || `STATUS_${b.status}`,
        payDate: b.payTimeText || "",
        categories: flat,
        netPaidSAR: money(flat[CAT.paid] || 0),
      };
      await pool.query(
        `INSERT INTO keeta_bills (bill_id, period_from, period_to, period_from_ms, period_to_ms,
           label, status, status_name, pay_date, categories, net_paid, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (bill_id) DO UPDATE SET
           period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to,
           period_from_ms = EXCLUDED.period_from_ms, period_to_ms = EXCLUDED.period_to_ms,
           label = EXCLUDED.label, status = EXCLUDED.status,
           status_name = EXCLUDED.status_name, pay_date = EXCLUDED.pay_date,
           categories = EXCLUDED.categories, net_paid = EXCLUDED.net_paid, fetched_at = NOW()`,
        [row.billId, row.periodFrom, row.periodTo, row.fromMs, row.toMs, row.label,
          row.status, row.statusName, row.payDate,
          jb ? jb(row.categories) : JSON.stringify(row.categories), row.netPaidSAR]
      );
      out.push(row);
      await sleep(FETCH_GAP_MS);
    }
    return out;
  }

  /* ─── 5. REFUNDS ──────────────────────────────────────────────────────────
     Omar's question, answered per order: when a customer gets money back, does
     Keeta give back its commission and its payment fee, or does he pay them on
     money he never kept?

     Three refund shapes were observed and they behave differently, so this
     route classifies each one rather than applying a single rule.             */
  app.get("/api/keeta-payouts/refunds", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    try {
      const rows = (await cachedRows(from, to)).filter(
        (r) => (Array.isArray(r.refunds) && r.refunds.length) || n0(r.refund_price) > 0 || isReversed(r)
      );

      const orders = rows.map((r) => {
        const events = Array.isArray(r.refunds) ? r.refunds : [];
        const reversed = isReversed(r);
        const pickup = isPickupRow(r);
        const rate = pickup ? MEASURED.pickupCommissionRate : MEASURED.deliveryCommissionRate;
        const base = money(n0(r.product_price) - n0(r.activity_fee));
        const refundedToCustomer = money(
          n0(r.refunded_to_customer) || events.reduce((a, e) => a + n0(e?.refundedToCustomerSAR), 0)
        );
        const merchantAtFault = events.some((e) => e?.merchantAtFault);

        /* ── what came back, and what Keeta kept ──────────────────────────
           Only a PARTIAL refund populates the rebates* family, so only there
           can we compute the split from Keeta's own numbers. */
        let kept = null;
        if (r.has_rebates && r.rebates_product_price !== null && r.rebates_commission !== null) {
          const rebBase = money(n0(r.rebates_product_price) - n0(r.rebates_activity_fee));
          const baseReversedSAR = money(base - rebBase);
          const commissionGivenBack = money(n0(r.commission) - n0(r.rebates_commission));
          // If commission scaled with the base the way it does on a fresh
          // order, this is what should have come back.
          const commissionShouldReturn = money(baseReversedSAR * rate);
          // rebates_bank_fee = 0 means NOTHING was rebated, not "fee zeroed":
          // the recomputed earnings identity only closes with the ORIGINAL fee.
          const bankGivenBack = money(n0(r.rebates_bank_fee));
          const bankOnRefunded = money(refundedToCustomer * MEASURED.bankFeeRate);
          kept = {
            commissionBaseReversedSAR: baseReversedSAR,
            commissionGivenBackSAR: commissionGivenBack,
            commissionShouldReturnAtFullRateSAR: commissionShouldReturn,
            commissionKeptOnRefundedMoneySAR: money(commissionShouldReturn - commissionGivenBack),
            effectiveRefundedCommissionRate: ratio(commissionGivenBack, baseReversedSAR),
            bankFeeGivenBackSAR: bankGivenBack,
            bankFeeKeptOnRefundedMoneySAR: bankGivenBack === 0 ? bankOnRefunded : money(bankOnRefunded - bankGivenBack),
            earningsBeforeSAR: money(r.earnings),
            earningsAfterSAR: money(r.rebates_earnings),
            earningsLostSAR: money(n0(r.earnings) - n0(r.rebates_earnings)),
          };
        }

        return {
          orderViewId: r.order_view_id,
          orderId: r.order_id,
          keetaDay: r.keeta_day,
          orderTime: r.order_time,
          channel: r.user_get_mode || null,
          /* Which of the three shapes this is. */
          kind: reversed ? "reversed_entirely" : (r.part_refund ? "partial_refund" : "refund_recorded"),
          reversedEntirely: reversed,
          isPartial: !!r.part_refund,
          merchantAtFault,
          refundedToCustomerSAR: refundedToCustomer,
          orderValueSAR: money(r.product_price),
          customerPaidSAR: money(r.customer_pay_total),
          /* What the ORDER SCREEN still claims. On a reversed order this is a
             trap: getOrderDtl is not refund-aware and keeps showing the full
             original earnings even though the settlement paid nothing. */
          orderScreenStillShows: {
            earningsSAR: money(r.earnings),
            commissionSAR: money(r.commission),
            bankFeeSAR: money(r.bank_fee),
            warning: reversed
              ? "الطلب دا اتلغى بالكامل — الشاشة لسه بتعرض الأرباح الأصلية، بس الكشف مدفعش عليه ولا هللة. متقراش الرقم دا كإيراد."
              : null,
          },
          keetaKept: kept,
          settlementEvidence: reversed
            ? "الإيراد والعمولة والدعم اتشالوا كلهم من الكشف. الرسوم البنكية بتتشال كمان لو الإلغاء مش غلطة المطعم؛ لو غلطة المطعم بتفضل متخصومة."
            : null,
          events,
        };
      });

      /* ── window-level exposure ─────────────────────────────────────────── */
      const all = await cachedRows(from, to);
      const S = (rs, f) => money(rs.reduce((a, x) => a + n0(f(x)), 0));
      const reversedRows = all.filter(isReversed);
      const refundedTotal = S(orders, (o) => o.refundedToCustomerSAR);
      const commissionKept = S(orders.filter((o) => o.keetaKept), (o) => o.keetaKept.commissionKeptOnRefundedMoneySAR);
      const bankKeptPartial = S(orders.filter((o) => o.keetaKept), (o) => o.keetaKept.bankFeeKeptOnRefundedMoneySAR);
      // On a merchant-fault full reversal the bank fee stays charged — measured
      // once (order 4776823276295365, SAR 2.48, the whole residual of bill 4).
      const bankKeptOnReversals = S(
        reversedRows.filter((r) => (Array.isArray(r.refunds) ? r.refunds : []).some((e) => e?.merchantAtFault)),
        (r) => r.bank_fee
      );

      /* ── refunds our own books do not know about ───────────────────────── */
      const viewIds = reversedRows.map((r) => r.order_view_id);
      const blind = viewIds.length ? (await pool.query(`
        SELECT p.order_view_id, p.order_id, o.calendar_day::text AS calendar_day,
               o.total::float8 AS our_total, o.gross_incl::float8 AS our_gross_incl,
               o.order_type
          FROM keeta_payouts p
          JOIN ts_orders o ON o.order_id = p.order_id
         WHERE p.order_view_id = ANY($1::text[])
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
      `, [viewIds])).rows : [];

      return c.json({
        ok: true,
        window: { from, to, basis: "keeta_day (Riyadh midnight — Keeta's own bill day)" },
        coverage: {
          ordersInCache: all.length,
          ordersWithARefundRecord: orders.length,
          refundRatePercent: all.length ? rate4((orders.length / all.length) * 100) : null,
          note: all.length
            ? null
            : "مفيش صفوف مخزّنة للفترة دي — شغّل POST /api/keeta-payouts/sync الأول.",
        },
        /* The direct answer, three shapes, each with its evidence. */
        howKeetaTreatsRefunds: [
          {
            kind: "reversed_entirely",
            trigger: "المطعم مقبلش الطلب في الوقت / كيتا لغت الطلب تلقائيًا (applyType 3001, refundBearer -1)",
            commission: "بترجع بالكامل",
            bankFee: "بترجع بالكامل",
            costToMerchantSAR: 0,
            evidence: "طلب 4726820734515664 — 185.00 ر.س. اتشالت من الكشف بالكامل مع العمولة 23.94 والرسوم البنكية 3.82.",
          },
          {
            kind: "full_after_sale_refund_merchant_at_fault",
            trigger: "شكوى عميل والمنصة حمّلت المطعم المسؤولية (applyType 1001, duty 20, refundBearer 20)",
            commission: "بترجع بالكامل",
            bankFee: "❌ متترجعش — بتفضل متخصومة على فلوس رجعت للعميل",
            evidence: "طلب 4776823276295365 — العميل استرد 88.40 كاملة؛ الإيراد 105.00 والعمولة 12.85 والدعم اتشالوا، بس الرسوم البنكية 2.48 فضلت. الـ2.48 دي هي بالظبط الفرق الوحيد في كشف 22-31/07.",
          },
          {
            kind: "partial_refund",
            trigger: "استرداد جزئي (applyType 2002, partRefund 1) — بيملا حقول rebates*",
            commission: "⚠️ بترجع جزئيًا بس — ٨ نقط من الـ١٨ رجعت والـ١٠ اتاخدت",
            bankFee: "❌ متترجعش خالص (rebatesBankTransactionFee = 0)",
            evidence: "طلب 4796823030358149 — الأساس نزل 24.00 ر.س. والعمولة نزلت 1.92 بس = ٨٪ بالظبط. العقد بيقول الـ١٨٪ = ٨٪ خدمة بيانات + ١٠٪ خدمة توصيل، يعني كيتا رجّعت حصة البيانات وقعدت بحصة التوصيل: 2.40 ر.س. عمولة على أكل اترد ثمنه.",
            sampleSize: 1,
            caveat: "قياس على طلب واحد. القاعدة مضبوطة رياضيًا لكن محتاجة استرداد جزئي تاني عشان تتأكد كسياسة.",
          },
        ],
        exposure: {
          refundedToCustomersSAR: refundedTotal,
          feesKeetaKeptOnRefundedMoneySAR: money(commissionKept + bankKeptPartial + bankKeptOnReversals),
          breakdown: {
            commissionKeptOnPartialRefundsSAR: commissionKept,
            bankFeeKeptOnPartialRefundsSAR: bankKeptPartial,
            bankFeeKeptOnMerchantFaultReversalsSAR: bankKeptOnReversals,
          },
          note: "الأرقام دي على الاستردادات الظاهرة في الفترة دي بس. لو الاستردادات زادت، البند اللي بيكبر أسرع هو الاسترداد الجزئي.",
        },
        /* The operational finding: our own books count reversed orders as sales. */
        refundsOurBooksMiss: {
          reversedOrders: reversedRows.length,
          stillCountedAsSalesInTsOrders: blind.length,
          grossInclStillCountedSAR: S(blind, (b) => b.our_gross_incl),
          revenueStillCountedSAR: S(blind, (b) => b.our_total),
          orders: blind.map((b) => ({
            orderViewId: b.order_view_id, orderId: b.order_id,
            calendarDay: b.calendar_day, orderType: b.order_type,
            ourGrossInclSAR: money(b.our_gross_incl), ourRevenueSAR: money(b.our_total),
          })),
          note: "TabSense مبيسجّلش استرداد كيتا خالص — الطلبات دي متسجلة عندنا كمبيعات تامة، فإيرادنا بيزيد عن اللي كيتا سوّته فعلًا بنفس القيمة.",
        },
        orders,
      });
    } catch (e) { return fail(c, e, "refunds"); }
  });

  /* ─── 6. CONTRACT AUDIT ───────────────────────────────────────────────────
     Line by line: what the signed agreement says, what Keeta actually did,
     the SAR difference, and which side it favours. Machine-readable so the UI
     can render it as a table and so Omar can take it to Keeta.

     TWO KINDS OF FINDING, kept strictly apart, because conflating them would
     destroy the credibility of the whole document:
       * `calculationError: true`  — Keeta deviates from its OWN contract.
         These are the only ones that are arguably a mistake.
       * `calculationError: false` — Keeta applies the contract correctly and
         the contract itself is the issue (or our model was wrong).
     Every line carries `source` so no figure is ever mistaken for a
     contract-derived guess.                                                   */
  app.get("/api/keeta-payouts/contract-audit", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    const wantPortal = c.req.query("portal") !== "0";
    try {
      const fee = await fees();
      const all = await cachedRows(from, to);
      // Reversed orders never reached the settlement, so they must not inflate
      // any fee total in the audit.
      const rows = all.filter((r) => !isReversed(r));
      const dlv = rows.filter((r) => !isPickupRow(r));
      const pick = rows.filter((r) => isPickupRow(r));
      const S = (rs, f) => money(rs.reduce((a, x) => a + n0(f(x)), 0));
      const baseOf = (r) => n0(r.product_price) - n0(r.activity_fee);
      const bankBaseOf = (r) => n0(r.customer_pay_total) - n0(r.customer_platform_fee) - n0(r.customer_tip);

      const grossIncl = S(rows, (r) => r.product_price);
      const commissionBase = S(rows, baseOf);
      const commissionCharged = S(rows, (r) => r.commission);
      const basicCharged = S(rows, (r) => r.basic_commission);
      const distanceCharged = S(rows, (r) => r.distance_fee);
      const bankCharged = S(rows, (r) => r.bank_fee);
      const bankBase = S(rows, bankBaseOf);
      const dlvSubsidy = S(rows, (r) => r.delivery_subsidy);
      const itemSubsidy = S(rows, (r) => r.item_subsidy);

      /* ── per-order rule conformance ─────────────────────────────────────── */
      const exact = (a, b) => Math.abs(n0(a) - n0(b)) <= 0.011;
      const dlvExact = dlv.filter((r) => exact(r.basic_commission,
        measuredCommission({ productPrice: r.product_price, activityFee: r.activity_fee, isPickup: false, distanceFee: 0 }).basicCommissionSAR)).length;
      const pickExact = pick.filter((r) => exact(r.basic_commission,
        measuredCommission({ productPrice: r.product_price, activityFee: r.activity_fee, isPickup: true, distanceFee: 0 }).basicCommissionSAR)).length;
      const bankExact = rows.filter((r) => exact(r.bank_fee, Math.round(bankBaseOf(r) * MEASURED.bankFeeRate * 100) / 100)).length;

      // What the SAR 5 delivery floor and the SAR 1 pickup floor actually cost.
      const dlvFloorHits = dlv.filter((r) => baseOf(r) * MEASURED.deliveryCommissionRate < MEASURED.deliveryMinCommissionSAR);
      const dlvFloorCost = S(dlvFloorHits, (r) => MEASURED.deliveryMinCommissionSAR - baseOf(r) * MEASURED.deliveryCommissionRate);
      const pickFloorHits = pick.filter((r) => baseOf(r) * MEASURED.pickupCommissionRate < MEASURED.pickupMinCommissionSAR);
      const pickFloorCost = S(pickFloorHits, (r) => MEASURED.pickupMinCommissionSAR - baseOf(r) * MEASURED.pickupCommissionRate);
      const distanceOrders = rows.filter((r) => n0(r.distance_fee) > 0).length;

      // The contract's five-tier subsidy table, applied to the same orders.
      const modelledSubsidy = S(dlv, (r) => {
        const t = fee.subsidyTiers.find((x) => n0(r.product_price) <= x.upTo);
        return t ? t.sar : 0;
      });
      const aboveTopTier = dlv.filter((r) => n0(r.product_price) > Math.max(...fee.subsidyTiers.map((t) => t.upTo)));
      const aboveTopTierCharged = S(aboveTopTier, (r) => r.delivery_subsidy);

      // VAT — the base Keeta charges on is VAT-INCLUSIVE.
      const vatInBase = money(commissionBase - commissionBase / (1 + MEASURED.vatRate));
      const commissionOnVat = money(vatInBase * MEASURED.deliveryCommissionRate);
      const bankOnVat = money(vatInBase * MEASURED.bankFeeRate);

      /* ── the statement side: fees that should have appeared and did not ─── */
      let statement = null;
      if (wantPortal && keetaConfigured()) {
        try {
          const fromMs = Date.parse(from + "T00:00:00+03:00") - 7 * 86400000;
          const toMs = Date.parse(to + "T23:59:59+03:00") + 7 * 86400000;
          const bills = await syncBills(fromMs, toMs);
          const cat = (code) => money(bills.reduce((a, b) => a + n0(b.categories?.[code]), 0));
          statement = {
            bills: bills.length,
            periods: bills.map((b) => `${b.periodFrom}..${b.periodTo} (${b.statusName})`),
            posMachineFeeSAR: money(-cat("20202")),
            photographyFeeSAR: money(-cat("30301")),
            vatWithheldSAR: money(-cat("20204")),
            platformClawbackMerchantFaultSAR: money(-cat("20201")),
            platformCompensationToMerchantSAR: cat("10201"),
            commissionAdjustmentSAR: money(-cat("30303")),
            adSpendSAR: money(-cat("20205")),
            commissionSAR: money(-cat("30101")),
            bankFeeSAR: money(-cat("30201")),
            deliverySubsidySAR: money(-cat("30302")),
            itemSubsidySAR: money(-cat("20101")),
            grossItemsSAR: cat("10101"),
            netPaidSAR: cat(CAT.paid),
            note: "كل الفئات الـ٢٤ موجودة في كل كشف حتى لو بصفر، فالصفر هنا معناه فعلًا مفيش خصم — مش إن البند ناقص.",
          };
        } catch (e) {
          statement = { available: false, expired: e instanceof KeetaError ? !!e.expired : false, reason: e.message };
        }
      }

      const L = [];
      const line = (o) => { L.push(o); return o; };

      line({
        id: "delivery_commission_rate",
        contractSays: "عمولة توصيل ١٨٪ (٨٪ خدمة بيانات + ١٠٪ خدمة توصيل)",
        keetaActuallyDoes: `${MEASURED.deliveryCommissionRate * 100}% على (المجموع شامل الضريبة − العروض ممولة التاجر)`,
        measured: {
          baseSAR: S(dlv, baseOf), chargedSAR: S(dlv, (r) => r.basic_commission),
          effectiveRate: ratio(S(dlv, (r) => r.basic_commission), S(dlv, baseOf)),
          ordersMatchingExactly: dlvExact, orders: dlv.length,
        },
        sarImpact: 0, category: "correct", favours: "neutral", calculationError: false,
        source: "getOrderDtl merchantFee.basicCommission على " + dlv.length + " طلب توصيل",
        note: "النسبة نفسها مطابقة للعقد. تقسيم الـ٨٪/١٠٪ مش مبيّن في أي طلب عادي — بيبان بس وقت الاسترداد الجزئي.",
      });

      line({
        id: "commission_base",
        contractSays: "العقد مبيحددش الأساس صراحة",
        keetaActuallyDoes: "الأساس = المجموع شامل الضريبة ناقص كل العروض اللي ممولها التاجر",
        measured: { baseSAR: commissionBase, grossInclSAR: grossIncl, differenceSAR: money(grossIncl - commissionBase) },
        /* NOT money Keeta owes or saved — this line only says our own old model
           was wrong. Kept out of every total on purpose. */
        sarImpact: 0,
        modelCorrectionSAR: money((grossIncl - commissionBase) * MEASURED.deliveryCommissionRate),
        category: "model_correction",
        favours: "omar", calculationError: false,
        source: "getOrderDtl — 18% × (productPrice − activityFee) بيطابق basicCommission بالهللة",
        note: `كيتا بتخصم العروض قبل ما تحسب العمولة. نموذجنا القديم كان بيحسب على الإجمالي قبل الخصم، يعني كان بيبالغ في العمولة بـ${money((grossIncl - commissionBase) * MEASURED.deliveryCommissionRate)} ر.س. ده لصالح عمر — مكسب في الدقة مش مطالبة على كيتا.`,
      });

      line({
        id: "pickup_rate",
        contractSays: "استلام من المطعم ٣٪",
        keetaActuallyDoes: `${MEASURED.pickupCommissionRate * 100}% على نفس الأساس`,
        measured: { orders: pick.length, ordersMatchingExactly: pickExact, chargedSAR: S(pick, (r) => r.basic_commission), baseSAR: S(pick, baseOf) },
        sarImpact: 0, category: "correct", favours: "neutral", calculationError: false,
        source: `getOrderDtl على ${pick.length} طلب استلام`,
        note: "مطابق للعقد بالظبط.",
      });

      line({
        id: "min_service_fee_delivery",
        contractSays: "حد أدنى لرسوم الخدمة ريال واحد للطلب",
        keetaActuallyDoes: `حد أدنى ${MEASURED.deliveryMinCommissionSAR}.00 ر.س. على طلبات التوصيل — مش ريال`,
        measured: {
          ordersHittingTheFloor: dlvFloorHits.length,
          floorSAR: MEASURED.deliveryMinCommissionSAR,
          contractFloorSAR: fee.minServiceFeeSAR,
          examples: dlvFloorHits.slice(0, 8).map((r) => ({
            orderViewId: r.order_view_id, baseSAR: money(baseOf(r)),
            eighteenPercentSAR: money(baseOf(r) * MEASURED.deliveryCommissionRate),
            chargedSAR: money(r.basic_commission),
          })),
        },
        sarImpact: dlvFloorCost, category: "calculation_error", favours: "keeta", calculationError: true,
        source: "getOrderDtl — كل طلب توصيل الـ١٨٪ بتاعه أقل من ٥ اتحسب ٥.٠٠ بالظبط؛ وطلب أساسه ٢٨.٠٠ (١٨٪ = ٥.٠٤) ماتحسبش بالحد الأدنى، يعني الحد عند ٥ مش عند ١",
        note: "ده أوضح بند ممكن يترفع لكيتا: العقد بيقول ريال، والمطبّق خمسة. الأثر النقدي صغير دلوقتي لأن الطلبات الصغيرة قليلة، بس النص غلط بمقدار خمس أضعاف.",
      });

      line({
        id: "min_service_fee_pickup",
        contractSays: "حد أدنى لرسوم الخدمة ريال واحد للطلب",
        keetaActuallyDoes: `حد أدنى ${MEASURED.pickupMinCommissionSAR}.00 ر.س. على طلبات الاستلام — مطابق`,
        measured: { ordersHittingTheFloor: pickFloorHits.length, floorSAR: MEASURED.pickupMinCommissionSAR },
        sarImpact: pickFloorCost, category: "contract_term", favours: "keeta", calculationError: false,
        source: `getOrderDtl على ${pick.length} طلب استلام`,
        note: "الحد الأدنى موجود فعلًا على الاستلام وبقيمة العقد. التكلفة دي مستحقة تعاقديًا — مش خطأ.",
      });

      line({
        id: "distance_fee",
        contractSays: "مفيش أي بند اسمه رسوم مسافة",
        keetaActuallyDoes: `${MEASURED.distanceFeeSAR}.00 ر.س. للطلب، بتتضاف فوق العمولة الأساسية`,
        measured: {
          ordersCharged: distanceOrders, orders: rows.length,
          shareOfOrders: ratio(distanceOrders, rows.length),
          totalSAR: distanceCharged,
          onlyValueSeenSAR: MEASURED.distanceFeeSAR,
        },
        sarImpact: distanceCharged, category: "calculation_error", favours: "keeta", calculationError: true,
        source: "getOrderDtl merchantFee.distanceFee — commission = basicCommission + distanceFee",
        note: "مش موجود في العقد خالص، وبيتحصّل على " + distanceOrders + " طلب. وأسوأ من كده إنه مش ظاهر في الكشف: بند 30101 اسمه «العمولة الأساسية» بس بيشمل رسوم المسافة جواه، فمن الكشف لوحده مستحيل تشوفه.",
      });

      line({
        id: "payment_fee_rate",
        contractSays: "رسوم بنكية / دفع ٢.٥٪",
        keetaActuallyDoes: `${MEASURED.bankFeeRate * 100}% — كيتا بتعلنها بنفسها في bankTransactionFeeRate`,
        measured: {
          contractRate: fee.paymentFeeRate, actualRate: MEASURED.bankFeeRate,
          baseSAR: bankBase, baseFormula: MEASURED.bankFeeBase,
          chargedSAR: bankCharged,
          atContractRateSAR: money(bankBase * fee.paymentFeeRate),
          ordersMatchingExactly: bankExact, orders: rows.length,
        },
        sarImpact: money(bankCharged - bankBase * fee.paymentFeeRate),
        category: "calculation_error", favours: "keeta", calculationError: true,
        source: "getOrderDtl merchantFee.bankTransactionFeeRate = \"2.875\" على كل طلب؛ والأساس (payTotal − platformFee − tip) بيطابق الرسم بالهللة على " + bankExact + " من " + rows.length,
        note: "العقد بيقول ٢.٥٪ والمحصّل ٢.٨٧٥٪ — فرق ٠.٣٧٥ نقطة. ده تاني أوضح بند يترفع لكيتا، والفرق النقدي أكبر من الحد الأدنى.",
      });

      line({
        id: "delivery_subsidy_tiers",
        contractSays: "خمس شرايح دعم توصيل يغطيها التاجر (≤30→4، ≤35→9، ≤45→11، ≤55→12، ≤70→15) ومفيش دعم فوق ٧٠",
        keetaActuallyDoes: "مش جدول في العقد — ده عرض التوصيل المجاني بتاع المطعم نفسه (promo type 4)، وكيتا بتقسّم رسوم التوصيل المتنازل عنها بين المطعم والمنصة. ومفيش سقف عند ٧٠",
        measured: {
          actualSAR: dlvSubsidy, contractTierModelSAR: modelledSubsidy,
          ordersAboveTopTier: aboveTopTier.length,
          stillChargedAboveTopTierSAR: aboveTopTierCharged,
        },
        sarImpact: money(dlvSubsidy - modelledSubsidy),
        category: "merchant_choice", favours: "keeta", calculationError: false,
        source: "getOrderDtl merchantActivityFeeDtls[type=4] — sillAmount / reduceFee / merchantActivityFee / platformActivityFee",
        note: `جدول العقد بيقول صفر فوق ٧٠ ر.س.، والواقع إن ${aboveTopTier.length} طلب فوق السقف دفعوا ${aboveTopTierCharged} ر.س. بس ده مش خطأ حسابي من كيتا: البند دا حملة المطعم نفسه وهو اللي مشغّلها، فالتحكم فيه عند عمر مش عند كيتا. لو عايز يوقفه، يوقف حملة التوصيل المجاني.`,
      });

      line({
        id: "pos_machine_fee",
        contractSays: "رسوم جهاز نقاط بيع ٥٠٠ ر.س. لمرة واحدة",
        keetaActuallyDoes: "متحصّلتش خالص",
        measured: { statementCategory: "20202 رسوم آلة الدفع", chargedSAR: statement?.posMachineFeeSAR ?? null },
        sarImpact: 0, notChargedButContractedSAR: 500, category: "in_omars_favour", favours: "omar", calculationError: false,
        source: "بند 20202 = 0.00 في كل الكشوف الخمسة",
        note: "لصالح عمر. تستاهل تتسجّل عشان لو كيتا حصّلتها بأثر رجعي بعدين يبقى فيه توثيق إنها ماكانتش متحصّلة.",
      });

      line({
        id: "photography_fee",
        contractSays: "رسوم تصوير ٥٠٠ ر.س. لمرة واحدة",
        keetaActuallyDoes: "متحصّلتش خالص",
        measured: { statementCategory: "30301 رسوم خدمة الصور", chargedSAR: statement?.photographyFeeSAR ?? null },
        sarImpact: 0, notChargedButContractedSAR: 500, category: "in_omars_favour", favours: "omar", calculationError: false,
        source: "بند 30301 = 0.00 في كل الكشوف الخمسة",
        note: "لصالح عمر.",
      });

      line({
        id: "subscription_fee",
        contractSays: "معفى من رسوم الاشتراك",
        keetaActuallyDoes: "مفيش أي بند اشتراك في شجرة الكشف أصلًا",
        measured: { categoriesInTree: 24, subscriptionCategoriesFound: 0 },
        sarImpact: 0, category: "in_omars_favour", favours: "omar", calculationError: false,
        source: "شجرة cate/detail/timeRange كاملة، ٢٤ بند، متطابقة في الخمس كشوف",
        note: "الإعفاء متطبّق.",
      });

      line({
        id: "vat_base",
        contractSays: "العقد بيقول ١٨٪ من قيمة الطلب، من غير ما يحدد قبل ولا بعد الضريبة",
        keetaActuallyDoes: "بتحسب على أساس شامل ضريبة القيمة المضافة ١٥٪، وفي نفس الوقت مبتقتطعش الضريبة (بند 20204 = 0.00)",
        measured: {
          commissionBaseInclVatSAR: commissionBase,
          vatInsideBaseSAR: vatInBase,
          baseExclVatSAR: money(commissionBase - vatInBase),
          commissionChargedOnVatSAR: commissionOnVat,
          bankFeeChargedOnVatSAR: bankOnVat,
          totalFeesOnVatSAR: money(commissionOnVat + bankOnVat),
          headlineRate: MEASURED.deliveryCommissionRate,
          effectiveRateOnVatExclusiveRevenue: ratio(commissionCharged, commissionBase - vatInBase),
          vatWithheldByKeetaSAR: statement?.vatWithheldSAR ?? 0,
        },
        sarImpact: money(commissionOnVat + bankOnVat),
        category: "contract_term", favours: "keeta", calculationError: false,
        source: "productPrice شامل الضريبة (بيطابق ts_orders.gross_incl بالهللة) + بند 20204 = 0.00",
        note: `كيتا بتقتطعش ضريبة، يعني عمر بيورّد الـ١٥٪ لهيئة الزكاة والضريبة من جيبه. وبما إن الأساس شامل الضريبة، فعمر بيدفع لكيتا عمولة ورسوم على فلوس الحكومة اللي هو أصلًا مش بياخدها: ${money(commissionOnVat + bankOnVat)} ر.س. في الفترة دي. النتيجة إن الـ١٨٪ المعلنة بتساوي ${((ratio(commissionCharged, commissionBase - vatInBase) || 0) * 100).toFixed(2)}٪ من الإيراد الحقيقي بدون ضريبة. ده مش خطأ حسابي — كيتا بتطبّق شروطها صح — لكنه بند تفاوضي مشروع.`,
      });

      line({
        id: "refund_bank_fee",
        contractSays: "العقد مبيقولش إيه اللي بيرجع لما يحصل استرداد",
        keetaActuallyDoes: "الرسوم البنكية متترجعش على الاسترداد الكامل اللي المطعم مسؤول عنه، ولا على الاسترداد الجزئي",
        measured: { seeRoute: "/api/keeta-payouts/refunds" },
        sarImpact: null, category: "contract_term", favours: "keeta", calculationError: false,
        source: "فرق كشف 22-31/07 = 2.48 ر.س. بالظبط = الرسوم البنكية للطلب 4776823276295365 المسترد بالكامل",
        note: "الأثر النقدي محسوب في راوت /refunds. القاعدة نفسها مش مكتوبة في العقد، فهي بند يستحق التوضيح مع كيتا.",
      });

      line({
        id: "refund_commission_split",
        contractSays: "١٨٪ = ٨٪ خدمة بيانات + ١٠٪ خدمة توصيل",
        keetaActuallyDoes: "على الاسترداد الجزئي بترجع حصة الـ٨٪ بس وبتقعد بحصة الـ١٠٪",
        measured: { observedOn: 1, refundedRatePercent: 8, keptRatePercent: 10, seeRoute: "/api/keeta-payouts/refunds" },
        sarImpact: null, category: "contract_term", favours: "keeta", calculationError: false,
        source: "طلب 4796823030358149 — الأساس نزل 24.00 والعمولة نزلت 1.92 = ٨.٠٠٠٪ بالظبط",
        note: "قياس على طلب واحد. رياضيًا مضبوط تمامًا، لكن مينفعش يتقال إنه سياسة مؤكدة من عينة واحدة.",
      });

      line({
        id: "ad_spend",
        contractSays: "مش جزء من العقد — منتج إعلانات منفصل",
        keetaActuallyDoes: "بتتخصم من التحويل الأسبوعي في بند 20205، بتأخير يوم واحد",
        measured: { statementAdSpendSAR: statement?.adSpendSAR ?? null, seeRoute: "/api/keeta-payouts/ad-spend" },
        sarImpact: statement?.adSpendSAR ?? null, category: "correct", favours: "neutral", calculationError: false,
        source: "بند 20205 مقابل data/query/his — مطابق بالهللة على الخمس كشوف بعد إزاحة يوم",
        note: "كيتا بتحسبها صح. المهم إن دي تكلفة حقيقية بتقلّل التحويل، مش رقم لوحة تحكم.",
      });

      /* ── BUCKETS, kept apart on purpose ─────────────────────────────────
         A single "total in Keeta's favour" would be dishonest: it would add
         Omar's own free-delivery campaign, a legitimate contract term and an
         actual breach into one number he might then quote at Keeta. Each
         bucket means something different and only the first is claimable. */
      const sum = (xs) => money(xs.reduce((a, x) => a + n0(x.sarImpact), 0));
      const byCat = (k) => L.filter((x) => x.category === k);
      const errors = byCat("calculation_error");
      const contractTerms = byCat("contract_term");
      const merchantChoice = byCat("merchant_choice");
      const inOmarsFavour = byCat("in_omars_favour");

      return c.json({
        ok: true,
        window: { from, to, basis: "keeta_day (Riyadh midnight)" },
        coverage: {
          ordersInCache: all.length,
          reversedExcluded: all.length - rows.length,
          deliveryOrders: dlv.length, pickupOrders: pick.length,
          note: all.length
            ? "الأرقام على الطلبات المخزّنة في الفترة دي بس. شغّل sync لو التغطية ناقصة."
            : "مفيش صفوف مخزّنة — شغّل POST /api/keeta-payouts/sync الأول.",
        },
        contractModel: fee,
        measuredRules: MEASURED,
        headline: {
          /* ONLY this number is a claim against Keeta. Everything else is
             either a term of the contract, Omar's own campaign, or a
             correction to our own model. */
          claimableAgainstKeeta: {
            lines: errors.length,
            sarImpact: sum(errors),
            items: errors.map((x) => ({ id: x.id, sarImpact: x.sarImpact, contractSays: x.contractSays, keetaActuallyDoes: x.keetaActuallyDoes })),
            note: "دي البنود الوحيدة اللي كيتا بتخالف فيها نص عقدها هي نفسها. الرقم دا هو اللي ينفع يترفع لكيتا.",
          },
          contractTermsWorthNegotiating: {
            lines: contractTerms.length,
            sarImpact: sum(contractTerms),
            note: "كيتا بتطبّق شروطها صح هنا — الاعتراض على الشرط نفسه مش على الحساب. ينفع يتفاوض عليه، مش يترفع كخطأ.",
          },
          merchantsOwnChoice: {
            lines: merchantChoice.length,
            sarImpact: sum(merchantChoice),
            note: "دي حملة التوصيل المجاني بتاعة المطعم نفسه. عمر هو اللي مشغّلها وهو اللي يقدر يوقفها — مش مطالبة على كيتا.",
          },
          inOmarsFavour: {
            lines: inOmarsFavour.length,
            contractedButNeverChargedSAR: money(inOmarsFavour.reduce((a, x) => a + n0(x.notChargedButContractedSAR), 0)),
            note: "رسوم منصوص عليها في العقد ومتحصّلتش. مهم تتوثّق قبل أي نقاش مع كيتا.",
          },
          summary:
            `${errors.length} بنود كيتا بتخالف فيها عقدها هي نفسها، بأثر ${sum(errors)} ر.س. في الفترة دي: ` +
            `الرسوم البنكية ٢.٨٧٥٪ بدل ٢.٥٪ المكتوبة، ورسم مسافة ريال للطلب مش موجود في العقد أصلًا، وحد أدنى للعمولة ٥ ر.س. بدل الريال المكتوب. ` +
            `دول بس اللي ينفعوا يترفعوا لكيتا. ` +
            `بند الضريبة (${sum(contractTerms)} ر.س.) شرط تعاقدي مطبّق صح — تفاوض مش مطالبة. ` +
            `ودعم التوصيل (${sum(merchantChoice)} ر.س.) حملة المطعم نفسه. ` +
            `وفي المقابل رسوم جهاز نقاط البيع ٥٠٠ ر.س. ورسوم التصوير ٥٠٠ ر.س. متحصّلوش خالص، ومفيش رسوم اشتراك.`,
          doNotAdd: "متجمعش الأربع أرقام دي في رقم واحد — كل واحد منهم معناه مختلف تمامًا عن التاني.",
        },
        lines: L,
        statement,
        integrity: {
          note: "أي بند sarImpact فيه = null معناه إنه مش متقدّر رقميًا من البيانات المتاحة، مش إنه بصفر.",
        },
      });
    } catch (e) { return fail(c, e, "contract-audit"); }
  });

  /* ─── 7. AD SPEND ─────────────────────────────────────────────────────────
     Ad spend as a real cost line: per settlement period, from the statement,
     reconciled against what the ads portal reports.

     THE ONE-DAY LAG is the whole trick. Statement category 20205 for a bill
     period [from..to] equals the ads portal's daily `debit` summed over
     [from-1 .. to-1]. Without the shift the two sides look permanently wrong
     by a day's spend; with it they match to the halala on every bill.

     READ ONLY. plan/query and data/query/his only — never plan/update/status,
     never operation/update, never fund/allocate.                              */
  app.get("/api/keeta-payouts/ad-spend", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = qRange(c);
    if (!keetaConfigured()) {
      return c.json({ ok: false, expired: true, error: "كيتا مش مربوطة — الناقص KEETA_COOKIE أو KEETA_SHOP_ID" }, 401);
    }
    const compact = (d) => String(d).replace(/-/g, "");
    const shiftDay = (d, n) => isoDay(new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString());
    try {
      // ── statement side ────────────────────────────────────────────────────
      const fromMs = Date.parse(from + "T00:00:00+03:00") - 7 * 86400000;
      const toMs = Date.parse(to + "T23:59:59+03:00") + 7 * 86400000;
      const bills = await syncBills(fromMs, toMs);

      // ── ads portal side: one daily series covering every bill period, shifted ──
      const spanFrom = bills.length ? shiftDay(bills[0].periodFrom, -1) : shiftDay(from, -1);
      const spanTo = bills.length ? shiftDay(bills[bills.length - 1].periodTo, -1) : shiftDay(to, -1);
      let daily = [], plan = null, portalError = null;
      try {
        const his = await keetaCall("/api/bff/ad/poi/v1/sspcpc/data/query/his", {
          targetAcctId: ACCT_ID, startDate: compact(spanFrom), endDate: compact(spanTo),
        });
        const rows = his?.details?.selfData || his?.details || [];
        // `debit` is the money actually spent that day. adrevenue/roas are
        // Keeta's own attribution and are passed through untouched.
        daily = (Array.isArray(rows) ? rows : []).map((d) => {
          const t = String(d?.time || "");
          return {
            day: t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t,
            spendSAR: money(String(d?.debit ?? "0").replace(/[^\d.-]/g, "")),
            impressions: n0(String(d?.showCount ?? "0").replace(/[^\d.-]/g, "")),
            clicks: n0(String(d?.clickCount ?? "0").replace(/[^\d.-]/g, "")),
            attributedOrders: n0(String(d?.orders ?? "0").replace(/[^\d.-]/g, "")),
            attributedRevenueSAR: money(String(d?.adrevenue ?? "0").replace(/[^\d.-]/g, "")),
          };
        });
      } catch (e) {
        if (e instanceof KeetaError && e.expired) throw e;
        portalError = e.message;
      }
      try {
        const p = await keetaCall("/api/bff/ad/poi/v1/sspcpc/plan/query", undefined, {
          query: { targetAcctId: ACCT_ID, shopId: SHOP_ID },
        });
        if (p) {
          plan = {
            planId: p.planId ?? null,
            running: Number(p.status) === 0,
            budgetSAR: hal(p.budget),
            // NOT lifetime spend — this is spend inside the CURRENT budget
            // period, which is why it disagrees with the settlement total.
            budgetUsedThisPeriodSAR: hal(p.budgetUsed),
            budgetRemainingPercent: p.budgetRemainingPercent ?? null,
            lifetimeClicks: n0(p.clickCount),
            bidSAR: hal((p.unitList || [])[0]?.bid * 100),
            targetRoi: (p.unitList || [])[0]?.targetRoi ?? null,
          };
        }
      } catch (e) {
        if (e instanceof KeetaError && e.expired) throw e;
        portalError = portalError ? `${portalError}; ${e.message}` : e.message;
      }

      const byDay = new Map(daily.map((d) => [d.day, d]));
      const sumRange = (a, b, f) => money(daily.filter((d) => d.day >= a && d.day <= b).reduce((x, d) => x + n0(f(d)), 0));

      const periods = bills.map((b) => {
        const statementSAR = money(-n0(b.categories?.[CAT.ads]));
        const shiftedFrom = shiftDay(b.periodFrom, -1);
        const shiftedTo = shiftDay(b.periodTo, -1);
        const portalShifted = sumRange(shiftedFrom, shiftedTo, (d) => d.spendSAR);
        const portalSameDates = sumRange(b.periodFrom, b.periodTo, (d) => d.spendSAR);
        return {
          billId: b.billId,
          period: { from: b.periodFrom, to: b.periodTo },
          label: b.label,
          status: b.statusName,
          settled: b.status === 90,
          payDate: b.payDate || null,
          adSpendFromStatementSAR: statementSAR,
          adSpendFromPortalSAR: portalShifted,
          portalWindowUsed: { from: shiftedFrom, to: shiftedTo, note: "مزاح يوم لورا — ده اللي بيخلي الرقمين يطابقوا" },
          differenceSAR: money(statementSAR - portalShifted),
          /* An unsettled bill is still filling up, so it CANNOT match a full
             period of portal spend and a mismatch there means nothing.
             `matches` is null for those rather than false, and they are left
             out of the verdict entirely. */
          comparable: b.status === 90,
          matches: b.status === 90 ? Math.abs(statementSAR - portalShifted) <= 0.011 : null,
          openBillNote: b.status === 90 ? null
            : "الكشف دا لسه مفتوح وبيتجمّع — الفرق هنا صرف لسه مانزلش، مش اختلاف في الحساب.",
          adSpendFromPortalSameDatesSAR: portalSameDates,
          differenceWithoutShiftSAR: money(statementSAR - portalSameDates),
          // Performance over the bill's own dates, not shifted — this is what
          // the campaign did, as opposed to what was billed.
          performanceOverBillDates: {
            impressions: sumRange(b.periodFrom, b.periodTo, (d) => d.impressions),
            clicks: sumRange(b.periodFrom, b.periodTo, (d) => d.clicks),
            attributedOrders: sumRange(b.periodFrom, b.periodTo, (d) => d.attributedOrders),
            attributedRevenueSAR: sumRange(b.periodFrom, b.periodTo, (d) => d.attributedRevenueSAR),
          },
          netPaidSAR: b.netPaidSAR,
          adSpendShareOfNetPaid: ratio(statementSAR, b.netPaidSAR),
        };
      });

      const statementTotal = money(periods.reduce((a, p) => a + n0(p.adSpendFromStatementSAR), 0));
      const portalTotal = money(daily.reduce((a, d) => a + n0(d.spendSAR), 0));
      const comparable = periods.filter((p) => p.comparable);
      const matched = comparable.filter((p) => p.matches).length;
      const openBills = periods.filter((p) => !p.comparable);
      // Spend the portal has recorded that no bill has picked up yet: whatever
      // the open bills have not accrued, plus anything past the last period.
      const notYetBilled = money(
        openBills.reduce((a, p) => a + Math.max(0, n0(p.adSpendFromPortalSAR) - n0(p.adSpendFromStatementSAR)), 0)
        + (bills.length
          ? daily.filter((d) => d.day > shiftDay(bills[bills.length - 1].periodTo, -1)).reduce((a, d) => a + n0(d.spendSAR), 0)
          : 0)
      );

      return c.json({
        ok: true,
        window: { from, to },
        source: {
          statement: "/api/settlement/statement/v2 — category 20205 تكاليف الإعلانات",
          portal: "/api/bff/ad/poi/v1/sspcpc/data/query/his (daily `debit`) + plan/query",
          readOnly: true,
        },
        reconciliation: {
          periodsTotal: periods.length,
          periodsComparable: comparable.length,
          periodsStillOpen: openBills.length,
          periodsMatchingExactly: matched,
          allSettledPeriodsMatch: comparable.length > 0 && matched === comparable.length,
          statementTotalSAR: statementTotal,
          portalTotalOverWholeSpanSAR: portalTotal,
          spendNotYetBilledSAR: notYetBilled,
          billingLagDays: 1,
          rule: "بند 20205 لفترة [من..إلى] = مجموع debit اليومي من البوابة لـ [من−١ .. إلى−١]",
          verdict: comparable.length === 0
            ? "مفيش كشوف مقفولة في الفترة دي عشان نطابق عليها."
            : (matched === comparable.length
              ? `كيتا بتحسب الإعلانات صح: ${matched} من ${comparable.length} كشف مقفول مطابقين بالهللة بعد إزاحة اليوم الواحد. ` +
                (openBills.length
                  ? `فيه كمان ${openBills.length} كشف لسه مفتوح — الفرق فيه (${notYetBilled} ر.س.) صرف لسه مانزلش، مش فلوس ضايعة ولا محسوبة مرتين.`
                  : "")
              : `${matched} من ${comparable.length} كشف مقفول مطابق. اللي مش مطابق محتاج مراجعة — بص على differenceSAR.`),
        },
        /* The point of the route: ad spend is a real deduction from the bank
           transfer, not a dashboard-only number. Proven independently on the
           22-31/07 bill, where earnings − adSpend − retainedBankFee equals the
           statement's own net-paid figure to the halala. */
        costLine: {
          note: "صرف الإعلانات بيتخصم من التحويل الأسبوعي فعلًا — لازم يتحسب كتكلفة تشغيل، مش كرقم في لوحة تحكم منفصلة.",
          totalDeductedFromPayoutsSAR: statementTotal,
        },
        plan,
        planCaveat: plan
          ? "budgetUsedThisPeriodSAR هو الصرف جوه فترة الميزانية الحالية بس — مش الصرف الكلي. الصرف الكلي هو portalTotalOverWholeSpanSAR."
          : null,
        attributionCaveat: "attributedRevenueSAR دي قيمة الطلبات اللي كيتا بتنسبها للإعلان — قيمة إجمالية قبل العمولة والرسوم والعروض. مش ربح، ومش صافي عمر. الـROAS اللي البوابة بتعرضه محسوب عليها.",
        periods,
        daily,
        portalError,
      });
    } catch (e) { return fail(c, e, "ad-spend"); }
  });

  console.log("[keeta-payouts] routes ready (/api/keeta-payouts/sync|reconcile|summary|order/:viewId|refunds|contract-audit|ad-spend)");
}

export default { register };
