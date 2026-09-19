// ai.js — AI advisors for Fresh Cuts (Jeddah, KSA).
//
// Two endpoints that answer the owner's two standing questions:
//   POST /api/ai/marketing-ideas  → ad + promo ideas
//   POST /api/ai/decisions        → operational / pricing / menu / staffing calls
//   GET  /api/ai/last?kind=...    → last stored result (free, instant UI load)
//
// The whole point of this module is that the model NEVER speaks generically.
// Every call first builds a "facts pack" — a compact JSON aggregate of the
// owner's real numbers over the requested window plus the equivalent previous
// window — and the model is instructed (in Arabic) that each recommendation must
// quote a real number from that pack. It is a grounding harness, not a chatbot.
//
// Money note (load-bearing): TabSense reports `gross`/`discount` EXCLUDING VAT
// while `total`/`gross_incl`/`discount_incl` are VAT-inclusive. Everything a
// human reads must come from the *_incl / total columns, so that is all we use.

import crypto from "node:crypto";
import { FIRST_ORDER_CTE } from "./identity.js";

/* ── LLM provider config ──────────────────────────────────────────────────────
   Preference order:
     1. ANTHROPIC_API_KEY  → api.anthropic.com/v1/messages (native, tool use)
     2. LITELLM_KEY        → the team's LiteLLM proxy (OpenAI-compatible)
   Verified on the VPS: the proxy answers on anthropic/<model> (its wildcard
   route), so a bare model id gets the "anthropic/" prefix added for that path. */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.AI_MODEL || "claude-sonnet-5";

const MAX_TOKENS = 12000;       // adaptive thinking shares this budget — leave room
const LLM_TIMEOUT_MS = 180000;  // a facts-grounded answer can legitimately take minutes
const CACHE_HOURS = 6;          // identical (kind, from, to) inside this window is reused
const FACTS_CHAR_BUDGET = 24000; // hard ceiling on the prompt payload (cost guard)

/* ── Schema ─────────────────────────────────────────────────────────────────── */
async function ensureAiSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      facts JSONB NOT NULL DEFAULT '{}',
      result JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- The cache lookup is always (kind, from, to) newest-first.
    CREATE INDEX IF NOT EXISTS ai_reports_lookup_idx
      ON ai_reports(kind, from_date, to_date, created_at DESC);
  `);
}

/* ── Date helpers ───────────────────────────────────────────────────────────── */
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoOrNull(s) {
  if (!s || !ISO_RE.test(String(s))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : String(s);
}
function shiftISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.floor((b - a) / 86400000) + 1; // inclusive
}

/* ── Small numeric helpers (never divide by zero) ───────────────────────────── */
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const round = (v, p = 2) => {
  const n = num(v);
  const m = 10 ** p;
  return Math.round(n * m) / m;
};
/** Safe ratio. Returns null (not 0, not NaN) when the denominator is empty, so
 *  the model can tell "no data" apart from "genuinely zero". */
const div = (a, b, p = 3) => (num(b) === 0 ? null : round(num(a) / num(b), p));
const pctDelta = (cur, prev) => (num(prev) === 0 ? null : round(((num(cur) - num(prev)) / num(prev)) * 100, 1));

/* ── Facts pack ───────────────────────────────────────────────────────────────
   Everything below is aggregated by Postgres; JS only picks/sorts the rows the
   prompt should carry. Riyadh local time = order_date + interval '3 hours'
   (KSA is UTC+3 year-round, no DST).                                          */

// Reused predicate: a real, countable sale. Takes the table alias so BOTH
// comparisons get qualified — writing `o.${VALID}` would only prefix the first
// one and leave the second to resolve by luck once a join is added.
const valid = (a = "") => `${a}order_type NOT ILIKE '%void%' AND ${a}order_type NOT ILIKE '%refund%'`;
const VALID = valid();

async function buildFacts(pool, from, to) {
  const rangeDays = daysBetween(from, to);
  const prevTo = shiftISO(from, -1);
  const prevFrom = shiftISO(prevTo, -(rangeDays - 1));
  // $1=from $2=to $3=prevFrom  (the prev window ends the day before `from`, so
  // prevFrom..to is one contiguous scan and a CASE splits the two periods.)
  const P = [from, to, prevFrom];

  // Long windows would emit one row per day; bucket weekly past ~45 days so the
  // pack stays a few KB. The bucket is a code-chosen literal, never user input.
  const bucket = rangeDays > 45 ? "week" : "day";

  const [
    totalsQ, hoursQ, dowQ, itemsQ, channelsQ, sourcesQ, optionsQ,
    custQ, newCustQ, adsQ, seriesQ, staffQ,
  ] = await Promise.all([
    // 1. Headline totals, current vs previous period.
    pool.query(
      `WITH o AS (
         SELECT total, gross_incl, discount_incl, order_type, customer_id,
                CASE WHEN calendar_day >= $1::date THEN 'cur' ELSE 'prev' END AS period
           FROM ts_orders
          WHERE calendar_day BETWEEN $3::date AND $2::date AND ${VALID}
       )
       SELECT period,
              count(*)::int                                              AS orders,
              COALESCE(sum(total),0)                                     AS revenue,
              COALESCE(sum(gross_incl),0)                                AS gross_incl,
              COALESCE(sum(discount_incl),0)                             AS discount_incl,
              count(*) FILTER (WHERE order_type ILIKE '%external%')::int AS delivery_orders,
              COALESCE(sum(total) FILTER (WHERE order_type ILIKE '%external%'),0) AS delivery_revenue,
              count(DISTINCT customer_id)::int                           AS known_customers
         FROM o GROUP BY period`, P),

    // 2. Hour of day (Riyadh local).
    pool.query(
      `SELECT EXTRACT(hour FROM (order_date + interval '3 hours'))::int AS hour,
              count(*)::int AS orders, COALESCE(sum(total),0) AS revenue
         FROM ts_orders
        WHERE calendar_day BETWEEN $1::date AND $2::date AND ${VALID}
          AND order_date IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [from, to]),

    // 3. Day of week (1=Mon … 7=Sun, Riyadh local).
    pool.query(
      `SELECT EXTRACT(isodow FROM (order_date + interval '3 hours'))::int AS dow,
              count(*)::int AS orders, COALESCE(sum(total),0) AS revenue
         FROM ts_orders
        WHERE calendar_day BETWEEN $1::date AND $2::date AND ${VALID}
          AND order_date IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [from, to]),

    // 4. Items, current vs previous, so "rising / falling" is a fact not a guess.
    pool.query(
      `WITH o AS (
         SELECT order_id, calendar_day FROM ts_orders
          WHERE calendar_day BETWEEN $3::date AND $2::date AND ${VALID}
       )
       SELECT it.name,
              COALESCE(sum(it.qty)    FILTER (WHERE o.calendar_day >= $1::date),0) AS qty_cur,
              COALESCE(sum(it.amount) FILTER (WHERE o.calendar_day >= $1::date),0) AS rev_cur,
              COALESCE(sum(it.qty)    FILTER (WHERE o.calendar_day <  $1::date),0) AS qty_prev,
              COALESCE(sum(it.amount) FILTER (WHERE o.calendar_day <  $1::date),0) AS rev_prev
         FROM ts_order_items it JOIN o ON o.order_id = it.order_id
        GROUP BY it.name
        ORDER BY rev_cur DESC
        LIMIT 400`, P),

    // 5. Delivery-aggregator split (Keeta / Hungerstation / Ninja) + deltas.
    pool.query(
      `WITH o AS (
         SELECT order_id, calendar_day, total FROM ts_orders
          WHERE calendar_day BETWEEN $3::date AND $2::date AND ${VALID}
            AND order_type ILIKE '%external%'
       )
       SELECT COALESCE(NULLIF(s.source_note,''),'(غير محدد)') AS channel,
              count(*) FILTER (WHERE o.calendar_day >= $1::date)::int AS orders_cur,
              COALESCE(sum(o.total) FILTER (WHERE o.calendar_day >= $1::date),0) AS revenue_cur,
              count(*) FILTER (WHERE o.calendar_day <  $1::date)::int AS orders_prev,
              COALESCE(sum(o.total) FILTER (WHERE o.calendar_day <  $1::date),0) AS revenue_prev
         FROM o LEFT JOIN order_sources s ON s.order_id = o.order_id
        GROUP BY 1 ORDER BY orders_cur DESC LIMIT 15`, P),

    // 6. "How did this customer hear about us" mix, from the cashier station.
    pool.query(
      `SELECT COALESCE(NULLIF(s.source,''),'unknown') AS source,
              COALESCE(NULLIF(s.source_note,''),'')   AS note,
              count(*)::int AS orders, COALESCE(sum(o.total),0) AS revenue
         FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${valid('o.')}
        GROUP BY 1,2 ORDER BY orders DESC LIMIT 20`, [from, to]),

    // 7. Order option mix (dine-in / takeaway / …).
    pool.query(
      `SELECT COALESCE(NULLIF(order_option,''),'(غير محدد)') AS option,
              count(*)::int AS orders, COALESCE(sum(total),0) AS revenue
         FROM ts_orders
        WHERE calendar_day BETWEEN $1::date AND $2::date AND ${VALID}
        GROUP BY 1 ORDER BY orders DESC LIMIT 12`, [from, to]),

    // 8. New vs returning + repeat rate. A customer is keyed by normalised phone,
    //    taken from either the cashier capture or the TabSense directory; "first
    //    seen" is the earliest of those two sources across ALL history, so an
    //    order counts as "new" only if this window is genuinely their first.
    pool.query(
      `WITH scoped AS (
         SELECT o.order_id, o.calendar_day,
                NULLIF(COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')),'') AS pn
           FROM ts_orders o
           LEFT JOIN order_sources s  ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc  ON tc.customer_id = o.customer_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${valid('o.')}
       ), ${FIRST_ORDER_CTE}, agg AS (
         SELECT count(*)::int AS total_orders,
                count(*) FILTER (WHERE sc.pn IS NULL)::int AS unidentified_orders,
                count(*) FILTER (WHERE sc.pn IS NOT NULL AND f.first_day >= sc.calendar_day)::int AS new_customer_orders,
                count(*) FILTER (WHERE sc.pn IS NOT NULL AND f.first_day <  sc.calendar_day)::int AS returning_orders
           FROM scoped sc LEFT JOIN firsts f ON f.pn = sc.pn
       ), rep AS (
         SELECT count(*)::int AS identified_customers,
                count(*) FILTER (WHERE n >= 2)::int AS repeat_customers
           FROM (SELECT pn, count(*) AS n FROM scoped WHERE pn IS NOT NULL GROUP BY pn) t
       )
       SELECT * FROM agg CROSS JOIN rep`, [from, to]),

    // 9. Customers who registered inside the window.
    pool.query(
      `SELECT count(*)::int AS registered
         FROM ts_customers WHERE registered_at::date BETWEEN $1::date AND $2::date`, [from, to]),

    // 10. Paid-ads spend per platform. cost_per_lead uses NULLIF so a zero-lead
    //     platform yields NULL rather than blowing up or reading as "free".
    pool.query(
      `SELECT c.platform,
              count(DISTINCT c.id)::int   AS campaigns,
              COALESCE(sum(e.spend),0)    AS spend,
              COALESCE(sum(e.impressions),0)::bigint AS impressions,
              COALESCE(sum(e.clicks),0)::bigint      AS clicks,
              COALESCE(sum(e.results),0)  AS results,
              COALESCE(sum(e.leads_whatsapp + e.leads_calls + e.leads_visits
                         + e.leads_delivery + e.leads_apps),0) AS leads,
              COALESCE(sum(e.spend),0) / NULLIF(sum(e.leads_whatsapp + e.leads_calls
                         + e.leads_visits + e.leads_delivery + e.leads_apps),0) AS cost_per_lead,
              COALESCE(sum(e.spend),0) / NULLIF(sum(e.clicks),0) AS cost_per_click
         FROM mk_entries e JOIN mk_campaigns c ON c.id = e.campaign_id
        WHERE e.day BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY spend DESC`, [from, to]),

    // 11. Revenue trend inside the window.
    pool.query(
      `SELECT date_trunc('${bucket}', calendar_day)::date AS bucket,
              count(*)::int AS orders, COALESCE(sum(total),0) AS revenue
         FROM ts_orders
        WHERE calendar_day BETWEEN $1::date AND $2::date AND ${VALID}
        GROUP BY 1 ORDER BY 1`, [from, to]),

    // 12. Cashier performance — the staffing signal. Delivery-app orders carry no
    //     customer the cashier could capture, so they are excluded from the
    //     denominator rather than counted against the staff member.
    pool.query(
      `SELECT COALESCE(NULLIF(o.staff_name,''),'(غير معروف)') AS staff,
              count(*)::int AS orders,
              COALESCE(sum(o.total),0) AS revenue,
              count(*) FILTER (WHERE o.customer_id IS NOT NULL OR s.phone_norm <> '')::int AS identified
         FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${valid('o.')}
          AND o.order_type NOT ILIKE '%external%'
        GROUP BY 1 ORDER BY orders DESC LIMIT 10`, [from, to]),
  ]);

  const cur = totalsQ.rows.find((r) => r.period === "cur") || {};
  const prev = totalsQ.rows.find((r) => r.period === "prev") || {};

  const curOrders = num(cur.orders);
  const curRevenue = num(cur.revenue);
  const prevOrders = num(prev.orders);
  const prevRevenue = num(prev.revenue);

  // Ranking/slicing only — the sums themselves came from Postgres.
  const items = itemsQ.rows.map((r) => ({
    name: r.name,
    qty: round(r.qty_cur, 1),
    revenue: round(r.rev_cur),
    qtyPrev: round(r.qty_prev, 1),
    qtyDeltaPct: pctDelta(r.qty_cur, r.qty_prev),
  }));
  const sold = items.filter((i) => i.qty > 0);
  const movers = sold.filter((i) => i.qtyPrev >= 3 && i.qtyDeltaPct !== null);

  const hours = hoursQ.rows.map((r) => ({ hour: r.hour, orders: r.orders, revenue: round(r.revenue) }));
  const busiest = [...hours].sort((a, b) => b.orders - a.orders);

  const c = custQ.rows[0] || {};
  const identifiedOrders = num(c.new_customer_orders) + num(c.returning_orders);

  const ads = adsQ.rows.map((r) => ({
    platform: r.platform,
    campaigns: r.campaigns,
    spendSAR: round(r.spend),
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    leads: round(r.leads, 1),
    costPerLeadSAR: r.cost_per_lead === null ? null : round(r.cost_per_lead),
    costPerClickSAR: r.cost_per_click === null ? null : round(r.cost_per_click, 3),
  }));
  const totalSpend = ads.reduce((a, r) => a + r.spendSAR, 0);

  const facts = {
    meta: {
      currency: "SAR",
      city: "جدة، السعودية",
      timezone: "Asia/Riyadh (UTC+3)",
      window: { from, to, days: rangeDays },
      previousWindow: { from: prevFrom, to: prevTo, days: rangeDays },
      note: "كل المبالغ شاملة ضريبة القيمة المضافة. الطلبات الملغاة/المرتجعة مستبعدة.",
    },
    totals: {
      orders: curOrders,
      revenueSAR: round(curRevenue),
      avgBasketSAR: div(curRevenue, curOrders, 2),
      discountSAR: round(cur.discount_incl),
      discountRatio: div(cur.discount_incl, cur.gross_incl),
      ordersPerDay: div(curOrders, rangeDays, 1),
      revenuePerDaySAR: div(curRevenue, rangeDays, 2),
    },
    vsPreviousPeriod: {
      orders: prevOrders,
      revenueSAR: round(prevRevenue),
      avgBasketSAR: div(prevRevenue, prevOrders, 2),
      ordersDeltaPct: pctDelta(curOrders, prevOrders),
      revenueDeltaPct: pctDelta(curRevenue, prevRevenue),
      avgBasketDeltaPct: pctDelta(div(curRevenue, curOrders, 4), div(prevRevenue, prevOrders, 4)),
    },
    channelSplit: {
      deliveryApps: {
        orders: num(cur.delivery_orders),
        revenueSAR: round(cur.delivery_revenue),
        shareOfOrders: div(cur.delivery_orders, curOrders),
        ordersDeltaPct: pctDelta(cur.delivery_orders, prev.delivery_orders),
      },
      inRestaurant: {
        orders: curOrders - num(cur.delivery_orders),
        revenueSAR: round(curRevenue - num(cur.delivery_revenue)),
        shareOfOrders: div(curOrders - num(cur.delivery_orders), curOrders),
      },
      perDeliveryApp: channelsQ.rows.map((r) => ({
        channel: r.channel,
        orders: r.orders_cur,
        revenueSAR: round(r.revenue_cur),
        ordersPrev: r.orders_prev,
        ordersDeltaPct: pctDelta(r.orders_cur, r.orders_prev),
      })),
      orderOptions: optionsQ.rows.map((r) => ({
        option: r.option, orders: r.orders, revenueSAR: round(r.revenue),
      })),
    },
    items: {
      topByRevenue: sold.slice(0, 12),
      topByQty: [...sold].sort((a, b) => b.qty - a.qty).slice(0, 10)
        .map(({ name, qty, revenue }) => ({ name, qty, revenue })),
      bottomByRevenue: [...sold].sort((a, b) => a.revenue - b.revenue).slice(0, 8)
        .map(({ name, qty, revenue }) => ({ name, qty, revenue })),
      rising: [...movers].sort((a, b) => b.qtyDeltaPct - a.qtyDeltaPct).slice(0, 6),
      falling: [...movers].sort((a, b) => a.qtyDeltaPct - b.qtyDeltaPct).slice(0, 6),
      distinctItemsSold: sold.length,
    },
    customers: {
      registeredInWindow: num((newCustQ.rows[0] || {}).registered),
      knownCustomerIds: num(cur.known_customers),
      identifiedOrders,
      unidentifiedOrders: num(c.unidentified_orders),
      identificationRate: div(identifiedOrders, num(c.total_orders)),
      newCustomerOrders: num(c.new_customer_orders),
      returningOrders: num(c.returning_orders),
      returningShareOfIdentified: div(c.returning_orders, identifiedOrders),
      identifiedCustomers: num(c.identified_customers),
      repeatCustomers: num(c.repeat_customers),
      repeatRate: div(c.repeat_customers, c.identified_customers),
    },
    timing: {
      byHourRiyadh: hours,
      peakHours: busiest.slice(0, 4).map(({ hour, orders, revenue }) => ({ hour, orders, revenue })),
      deadHours: busiest.slice(-4).reverse().map(({ hour, orders, revenue }) => ({ hour, orders, revenue })),
      byWeekdayRiyadh: dowQ.rows.map((r) => ({
        // isodow: 1=Mon … 7=Sun
        weekday: ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"][r.dow - 1] || String(r.dow),
        orders: r.orders, revenueSAR: round(r.revenue),
      })),
    },
    sourceMix: sourcesQ.rows.map((r) => ({
      source: r.source, note: r.note, orders: r.orders, revenueSAR: round(r.revenue),
    })),
    ads: {
      totalSpendSAR: round(totalSpend),
      byPlatform: ads,
      // Attribution here is deliberately coarse: we do not claim a paid order,
      // we report spend against the period's real order count so the model can
      // reason about blended cost per order instead of inventing a funnel.
      blendedCostPerOrderSAR: div(totalSpend, curOrders, 2),
      blendedAdSpendShareOfRevenue: div(totalSpend, curRevenue),
    },
    revenueTrend: { bucket, points: seriesQ.rows.map((r) => ({
      date: r.bucket instanceof Date ? r.bucket.toISOString().slice(0, 10) : String(r.bucket),
      orders: r.orders, revenueSAR: round(r.revenue),
    })) },
    staff: staffQ.rows.map((r) => ({
      staff: r.staff, orders: r.orders, revenueSAR: round(r.revenue),
      identifiedOrders: r.identified, identificationRate: div(r.identified, r.orders),
    })),
  };

  return { facts, orderCount: curOrders };
}

/* ── المتجر الأونلاين (freshcuts.sa) — سياق «الأفكار الذكية» (١٩ سبتمبر) ──────
   قبل كده الموديل كان شايف نقطة البيع بس، فكان بيقترح أفكار لمطعم «من غير
   موقع» وبيقترح توصيل ببلاش وخصومات. هنا أرقام المتجر الحقيقية لآخر ٧ أيام
   شغل من جداول محسوبة أصلاً (shop_orders / journey_sessions / shop_carts /
   cart_recovery / cms_campaigns / mk_daily_reports) + العروض من السجل الحي +
   قرارات عمر اللي الأفكار لازم تحترمها. كل استعلام لوحده: لو واحد وقع الباقي
   بيوصل، والجزء الناقص بيتكتب «غير متاح» بدل ما الموديل يخمّنه. */
export const STORE_FACTS_VERSION = "store-v1";
const STORE_BIZ = `((created_at AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date`;

export const OWNER_PLAYBOOK = {
  goal: "هدف المالك: ٢٠٠ طلب يومياً من المتجر freshcuts.sa (توصيل من المطعم + استلام). التشغيل جاهز؛ الاختناق الوحيد هو جلب العملاء.",
  store: [
    "المتجر freshcuts.sa (نفس order.o2m8.me): منيو تاب سينس، دفع أونلاين (مدى/أبل باي)، تأكيد الجوال بـOTP قبل الدفع، تتبع الطلب.",
    "كوبون FIRST = توصيل ببلاش لأول طلب من الموقع — بيتحط لوحده على روابط الإعلانات (freshcuts.sa/l/<slug> بـUTM).",
    "استرداد السلات المتروكة: رسالة بعد ٣٥ دقيقة ورابط /c/<code> بيرجّع السلة — بس لازم العميل يكون كتب جواله (أغلب السلات مالهاش جوال).",
    "رسايل SMS تسويقية شغّالة (مُرسل FreshCut-AD): ساعات هدوء ١٠م–١٢ظ، فاصل ٧ أيام للرقم، holdout ١٥٪، فرامل عند إلغاء اشتراك >٥٪.",
    "الصالة والتطبيقات (كيتا/هنقرستيشن/نينجا/جاهز) شغّالين جنب المتجر؛ عروض ٩٦ مش متاحة على التطبيقات.",
  ],
  ads: [
    "ميتا: حملة شراء FC96-SALES-PUR (موزّعة على اليوم) + حملة ATC للمتجر + ريتارجت زوار الموقع FC-RT-WEB-96 (~١٢٠/يوم) + إعلان واتساب (~١٠٠/يوم، +٢٥٪ مساءً لو فيه طلبات).",
    "سناب: تجربة شراء لحد ٢٢/٩ ثم تقييم.",
    "حارس على السيرفر: الإعلانات شغّالة ١٢:٣٠ ← ١:٣٠ (الخميس/الجمعة ← ٢:٣٠)، سقف صلب ٣٬٠٠٠ ر.س/يوم.",
    "قاعدة الصرف: ≈ ٢٥–٣٠٪ من الدخل اليومي ومستمرة، وتكلفة طلب الموقع ≤ ٦٠ للتكبير. التركيز الخميس/الجمعة/السبت.",
    "المراجعة الجاية: الاتنين ٢١/٩ — تكلفة الطلب ≤ ٦٠ والدخل طالع ← كبّر، غير كده ← ~٤٥٠/يوم على أحسن إعلانين.",
  ],
  ownerRules: [
    "ممنوع كلمات «وفّر» و«خصم» و«٪» و«بدلاً من» في نص الإعلانات والعروض — السعر والمحتوى بس.",
    "ممنوع أي ادعاء عن الستيك.",
    "التوصيل: تكلفة المندوب ~٢٠ ر.س ثابتة من أول كيلو، فمفيش توصيل ببلاش على السلات الصغيرة — الحل رفع متوسط الفاتورة (AOV) مش منافسة كيتا على التوصيل المجاني.",
    "الولاء بعدين (كل ٥ طلبات) — مش دلوقتي.",
    "إعلانات الواتساب بتجيب عملاء للصالة مابيتتبعوش أونلاين — ماتحكمش عليها بطلبات الموقع؛ اقترح طرق تتبع (رسالة ترحيب لكل إعلان، رابط المتجر في الرد الآلي، سؤال الكاشير «من وين عرفتنا؟»).",
    "صور وفيديو حقيقي بس في الإعلانات (عمر رفض فيديوهات الذكاء الاصطناعي). صور أكل بالذكاء الاصطناعي مسموحة للمود من غير سعر/نص.",
    "البوكس = أصناف منفصلة في شنطة عليها ستيكر (مش علبة). كيلو ٩٦: نوع مشاوي واحد + خبز وسلطة وطحينة، والأرز هدية.",
    "المالك بيوافق قبل أي نشر أو صرف جديد؛ الأفكار اقتراحات.",
  ],
  apps: "تطبيقات أندرويد وآيفون بتتبني بالتوازي من ١٧/٩ (Capacitor فوق freshcuts.sa، تحديث من غير رفع نسخة) — لسه مانزلتش: مستنية حسابات Apple/Google/D-U-N-S من عمر. التطبيق أداة رجوع واحتفاظ (إشعارات، إعادة طلب)، مش أداة اكتساب.",
};

export async function buildStoreFacts(pool, now = new Date()) {
  const { OFFERS, offerState, riyadhDay } = await import("./offers.js");
  const { PAID_STATUSES, EXCLUDED_COUPONS } = await import("./adsplan.js");
  const to = riyadhDay(now);
  const from = shiftISO(to, -6);
  const safe = async (fn) => { try { return await fn(); } catch (e) { console.error("[ai] storeFacts:", e.message); return "غير متاح"; } };
  const REAL = `status = ANY($3::text[]) AND NOT COALESCE(is_test,false) AND upper(COALESCE(coupon,'')) <> ALL($4::text[])`;
  const P = [from, to, PAID_STATUSES, EXCLUDED_COUPONS];

  const [orders, bySource, funnel, carts, sms, daily] = await Promise.all([
    safe(async () => {
      const r = (await pool.query(
        `SELECT count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue,
                count(*) FILTER (WHERE option='pickup')::int AS pickup,
                count(*) FILTER (WHERE upper(COALESCE(coupon,''))='FIRST')::int AS first_coupon,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM shop_orders p WHERE p.phone_norm = o.phone_norm
                   AND p.created_at < o.created_at AND p.status = ANY($3::text[]) AND NOT COALESCE(p.is_test,false)))::int AS first_time
           FROM shop_orders o
          WHERE ${STORE_BIZ} BETWEEN $1::date AND $2::date AND ${REAL}`, P)).rows[0];
      const days = (await pool.query(
        `SELECT ${STORE_BIZ} AS day, count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue
           FROM shop_orders WHERE ${STORE_BIZ} BETWEEN $1::date AND $2::date AND ${REAL} GROUP BY 1 ORDER BY 1`, P)).rows;
      return {
        orders: r.orders, revenueSAR: round(r.revenue), aovSAR: div(r.revenue, r.orders, 2),
        pickupOrders: r.pickup, deliveryOrders: r.orders - r.pickup,
        firstTimeCustomers: r.first_time, ordersWithFIRST: r.first_coupon,
        daily: days.map((d) => ({ day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day), orders: d.orders, revenueSAR: round(d.revenue) })),
      };
    }),
    safe(async () => (await pool.query(
      `SELECT COALESCE(attrib_source,'unknown') AS source, count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue
         FROM shop_orders WHERE ${STORE_BIZ} BETWEEN $1::date AND $2::date AND ${REAL} GROUP BY 1 ORDER BY 2 DESC`, P))
      .rows.map((r) => ({ source: r.source, orders: r.orders, revenueSAR: round(r.revenue) }))),
    safe(async () => {
      const r = (await pool.query(
        `SELECT count(*)::int AS sessions, count(*) FILTER (WHERE max_step >= 1)::int AS viewed_item,
                count(*) FILTER (WHERE max_step >= 2)::int AS added_to_cart, count(*) FILTER (WHERE max_step >= 3)::int AS checkout,
                count(*) FILTER (WHERE max_step >= 6)::int AS payment, count(*) FILTER (WHERE paid)::int AS paid,
                count(*) FILTER (WHERE in_app IS NOT NULL)::int AS in_app_browser, count(*) FILTER (WHERE in_app IS NOT NULL AND paid)::int AS in_app_paid
           FROM journey_sessions WHERE biz_day BETWEEN $1::date AND $2::date AND NOT is_bot AND NOT is_qa AND NOT is_staff`, [from, to])).rows[0];
      return { ...r, conversion: div(r.paid, r.sessions, 4), note: "جلسات حقيقية (من غير بوتات/اختبار/موظفين). max_step: ١ شاف صنف، ٢ سلة، ٣ شيك أوت، ٦ دفع" };
    }),
    safe(async () => {
      const c = (await pool.query(
        `SELECT count(*)::int AS carts, count(*) FILTER (WHERE recovered_order IS NULL AND item_count > 0)::int AS abandoned,
                count(*) FILTER (WHERE recovered_order IS NULL AND item_count > 0 AND phone_norm IS NOT NULL)::int AS abandoned_with_phone,
                COALESCE(sum(subtotal) FILTER (WHERE recovered_order IS NULL AND item_count > 0 AND subtotal < 5000),0)::float AS abandoned_value
           FROM shop_carts WHERE updated_at > NOW() - interval '7 days'`)).rows[0];
      const r = (await pool.query(
        `SELECT count(*)::int AS flows, count(opened_at)::int AS opened, count(order_no)::int AS recovered,
                COALESCE(sum(order_total),0)::float AS recovered_value
           FROM cart_recovery WHERE started_at > NOW() - interval '7 days'`)).rows[0];
      return { ...c, abandoned_value: round(c.abandoned_value), recovery: { ...r, recovered_value: round(r.recovered_value) } };
    }),
    safe(async () => {
      const camps = (await pool.query(
        `SELECT id, name, status, sent, cost, sent_at, scheduled_at FROM cms_campaigns
          WHERE channel='sms' AND created_at > NOW() - interval '30 days' ORDER BY id DESC LIMIT 12`)).rows;
      const smsOrders = (await pool.query(
        `SELECT count(*)::int AS n, COALESCE(sum(total),0)::float AS rev FROM shop_orders
          WHERE attrib_source='sms' AND created_at > NOW() - interval '30 days' AND ${REAL.replace(/\$3/g, "$1").replace(/\$4/g, "$2")}`,
        [PAID_STATUSES, EXCLUDED_COUPONS])).rows[0];
      const optouts = (await pool.query(
        `SELECT count(*)::int AS n FROM cms_contacts WHERE opted_out_at > NOW() - interval '30 days'`)).rows[0];
      return {
        campaigns: camps.map((x) => ({ name: x.name, status: x.status, sent: x.sent, costSAR: round(x.cost),
          at: (x.sent_at || x.scheduled_at) ? new Date(x.sent_at || x.scheduled_at).toISOString().slice(0, 10) : null })),
        storeOrdersTaggedSms30d: smsOrders.n, storeRevenueTaggedSms30dSAR: round(smsOrders.rev), optOuts30d: optouts.n,
      };
    }),
    safe(async () => (await pool.query(`SELECT data FROM mk_daily_reports ORDER BY day DESC LIMIT 5`)).rows.map(({ data: d }) => ({
      day: d.day, revenueTotalSAR: round(d.revenue?.total), hallSAR: round(d.revenue?.hall?.revenue), appsSAR: round(d.revenue?.deliveryApps?.revenue),
      storeOrders: d.online?.orders, storeRevenueSAR: round(d.online?.revenue), storeAovSAR: d.online?.aov,
      adSpendSAR: round(d.ads?.spendTotal), adSpendShareOfRevenue: d.ads?.spendShareOfRevenue, ordersFromAds: d.ads?.ordersFromAds,
      cpaOnlineSAR: d.ads?.cpaOnline, roasOnline: d.ads?.roasOnline, whatsappConversations: d.whatsapp?.conversations,
      recommendation: d.recommendation?.ar,
    }))),
  ]);

  const offers = OFFERS.map((o) => ({ o, st: offerState(o, now) }))
    .filter(({ st }) => st.status === "live" || st.status === "upcoming")
    .map(({ o, st }) => ({ id: o.id, title: o.title, priceSAR: o.price ?? null, desc: o.desc, from: o.from || null, until: o.until,
      untilProvisional: !!o.untilProvisional, daysLeft: st.daysLeft, status: st.status,
      channels: o.channels ? Object.entries(o.channels).filter(([, v]) => v).map(([k]) => k) : null }));

  return {
    _v: STORE_FACTS_VERSION,
    window: { from, to, note: "آخر ٧ أيام شغل (اليوم بيدوّر ٤ الفجر). طلبات المالك التجريبية مستبعدة." },
    storeOrders: orders, storeOrdersBySource: bySource, storeFunnel: funnel, abandonedCarts: carts,
    smsCampaigns: sms, dailyReports: daily, liveOffers: offers, playbook: OWNER_PLAYBOOK,
  };
}

/** Trim the biggest arrays until the serialized pack fits the budget. Cost guard:
 *  the pack is the bulk of every prompt, so an unusually wide menu must not turn
 *  into an unbounded bill. */
function capFacts(facts) {
  const trims = [
    () => { facts.timing.byHourRiyadh = facts.timing.byHourRiyadh.slice(0, 0); },
    () => { facts.revenueTrend.points = facts.revenueTrend.points.slice(-14); },
    () => { facts.items.topByRevenue = facts.items.topByRevenue.slice(0, 6); },
    () => { facts.sourceMix = facts.sourceMix.slice(0, 8); },
    () => { facts.items.bottomByRevenue = facts.items.bottomByRevenue.slice(0, 4); },
    () => { facts.items.topByQty = facts.items.topByQty.slice(0, 5); },
  ];
  for (const trim of trims) {
    if (JSON.stringify(facts).length <= FACTS_CHAR_BUDGET) break;
    trim();
  }
  return facts;
}

/* ── LLM client ─────────────────────────────────────────────────────────────── */
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
    if (!res.ok) {
      // Never echo credentials — only the provider's own message body.
      throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the model for ONE forced tool call and return its parsed arguments.
 * Structured output via a tool schema (rather than prose parsing) is what makes
 * the response shape reliable enough to hand straight to the UI.
 */
async function callTool(provider, { system, user, tool }) {
  if (provider.kind === "anthropic") {
    const data = await postJSON(ANTHROPIC_URL, {
      "x-api-key": provider.key,
      "anthropic-version": ANTHROPIC_VERSION,
    }, {
      model: provider.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
      tool_choice: { type: "tool", name: tool.name },
    });
    const block = (data.content || []).find((b) => b.type === "tool_use");
    if (!block) throw new Error("model returned no tool_use block");
    return block.input;
  }

  // LiteLLM speaks OpenAI's function-calling shape.
  const data = await postJSON(`${LITELLM_BASE}/chat/completions`, {
    authorization: `Bearer ${provider.key}`,
  }, {
    model: provider.model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
    tool_choice: { type: "function", function: { name: tool.name } },
  });
  const call = ((data.choices || [])[0]?.message?.tool_calls || [])[0];
  if (!call) throw new Error("model returned no tool call");
  return JSON.parse(call.function.arguments || "{}");
}

/* ── Prompts (Arabic — the owner reads these answers) ───────────────────────── */
const SYSTEM_PROMPT = `أنت مستشار أعمال لمطعم "فريش كتس" في جدة بالسعودية. المطعم عنده صالة، وبيبيع على تطبيقات التوصيل، وعنده متجر أونلاين خاص بيه freshcuts.sa (توصيل من المطعم + استلام) — والمتجر هو أولوية النمو.

قواعد صارمة لا يجوز كسرها:
1. تتكلم بالعربية فقط، بلهجة أعمال مصرية/خليجية واضحة ومباشرة — كأنك بتكلم صاحب المطعم شخصيًا.
2. كل توصية لازم تكون مبنية على رقم حقيقي موجود في حزمة البيانات (facts) اللي هتستلمها.
3. ممنوع منعًا باتًا اختراع أي رقم. لو رقم مش موجود في البيانات، ماتذكرهوش. لو البيانات ناقصة في نقطة معينة، قول إنها ناقصة بدل ما تخمّن.
4. حقل evidence لازم يحتوي على رقم فعلي منقول حرفيًا من البيانات مع اسمه (مثال: "متوسط الفاتورة 47.30 ريال مقابل 52.10 في الفترة السابقة، بانخفاض 9.2%").
5. ممنوع النصائح العامة اللي تنفع أي مطعم. كل فكرة لازم تكون مربوطة بصنف أو قناة أو ساعة أو شريحة عملاء موجودة فعلًا في بياناته.
6. العملة ريال سعودي (SAR). التوقيت توقيت الرياض. كل المبالغ شاملة الضريبة.
7. رتّب النتائج بحيث priority = 1 هي الأعلى أثرًا وأسرع تنفيذًا.`;

function ideasUser(facts, focus) {
  const { store, ...pos } = facts;
  return `دي بيانات نقطة البيع الحقيقية (الصالة + تطبيقات التوصيل + طلبات الموقع اللي نزلت الكاشير) للفترة المطلوبة (JSON):

${JSON.stringify(pos, null, 1)}
${store ? `
ودي بيانات المتجر الأونلاين بتاعنا freshcuts.sa لآخر ٧ أيام + العروض الشغّالة + خطة الإعلانات + قرارات المالك (JSON — قرارات المالك في playbook ملزمة):

${JSON.stringify(store, null, 1)}
` : ""}
${focus ? `تركيز خاص طلبه صاحب المطعم: ${focus}\n\n` : ""}الهدف الأول: ${store ? store.playbook.goal : "زيادة الطلبات"}
اقترح من 6 إلى 8 أفكار تسويقية وإعلانية قابلة للتنفيذ خلال الأسبوعين الجايين:
- على الأقل ٤ أفكار للمتجر الأونلاين (رفع الزيارات، سد الفجوات في القمع storeFunnel، استرجاع السلات المتروكة، رفع متوسط الفاتورة، استغلال العروض الشغّالة liveOffers قبل ما تخلص، حملات SMS، الريتارجت)، وعلى الأقل فكرة للصالة.
- كل فكرة مبنية على رقم من البيانات: قمع المتجر، مصادر الطلبات، السلات المتروكة، نتايج حملات SMS، تقارير الدخل اليومية (نسبة الصرف من الدخل وتكلفة الطلب)، الأصناف، الساعات، القنوات، العملاء العائدين.
- احترم قرارات المالك حرفيًا: من غير «وفّر/خصم/٪» في أي نص إعلان، من غير ادعاءات ستيك، من غير توصيل ببلاش للسلات الصغيرة (FIRST لأول طلب بس)، الولاء مؤجل، وماتحكمش على الواتساب بطلبات الموقع.
- الإعلانات ضمن سقف ٣٬٠٠٠/يوم وقاعدة ٢٥–٣٠٪ من الدخل. لو اقترحت صرف زيادة قول هيتقاس بإيه.
- القناة: website = المتجر نفسه (صفحة/تجربة شراء/سلة)، sms = رسايل تسويقية، والباقي زي ما هو.

لكل فكرة: عنوان واضح، سبب مبني على رقم، خطوات تنفيذ عملية (٢ إلى ٥ خطوات)، الأثر المتوقع، الجهد المطلوب، والقناة الأنسب. استخدم أداة submit_marketing_ideas للإجابة.`;
}

function decisionsUser(facts) {
  return `دي بيانات المطعم الحقيقية للفترة المطلوبة (JSON):

${JSON.stringify(facts, null, 1)}

اطلع بقرارات إدارية وتشغيلية محددة يقدر صاحب المطعم ينفذها فورًا، مغطّية: التسعير، المنيو (إضافة/حذف/إعادة تسعير أصناف)، جدولة الموظفين حسب ساعات الذروة والساعات الميتة، الاستثمار في قنوات التوصيل مقابل داخل المطعم، والتشغيل اليومي.

لكل قرار: التوصية بالضبط، ليه، الرقم اللي يثبتها، المخاطرة لو نُفّذت، الأثر المتوقع، والجهد. استخدم أداة submit_decisions للإجابة.`;
}

/* ── Tool schemas ───────────────────────────────────────────────────────────── */
// website = المتجر freshcuts.sa، sms = الرسايل التسويقية (أُضيفوا ١٩/٩ — الواجهة عندها اسم لكل واحد)
const CHANNELS = ["tiktok", "meta", "snapchat", "whatsapp", "instore", "delivery_apps", "google", "website", "sms"];
const AREAS = ["pricing", "menu", "staffing", "channels", "operations", "marketing"];
const EFFORTS = ["low", "medium", "high"];

const IDEAS_TOOL = {
  name: "submit_marketing_ideas",
  description: "سلّم الأفكار التسويقية النهائية بصيغة منظمة.",
  schema: {
    type: "object",
    properties: {
      ideas: {
        type: "array", minItems: 3, maxItems: 10,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "معرّف قصير بالإنجليزية، مثل item-bundle-friday" },
            title: { type: "string" },
            why: { type: "string" },
            how: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
            expectedImpact: { type: "string" },
            effort: { type: "string", enum: EFFORTS },
            channel: { type: "string", enum: CHANNELS },
            evidence: { type: "string", description: "رقم حقيقي من البيانات يبرّر الفكرة" },
            priority: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["id", "title", "why", "how", "expectedImpact", "effort", "channel", "evidence", "priority"],
          additionalProperties: false,
        },
      },
    },
    required: ["ideas"],
    additionalProperties: false,
  },
};

const DECISIONS_TOOL = {
  name: "submit_decisions",
  description: "سلّم القرارات الإدارية النهائية بصيغة منظمة.",
  schema: {
    type: "object",
    properties: {
      decisions: {
        type: "array", minItems: 3, maxItems: 10,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            area: { type: "string", enum: AREAS },
            recommendation: { type: "string" },
            why: { type: "string" },
            evidence: { type: "string", description: "رقم حقيقي من البيانات يبرّر القرار" },
            risk: { type: "string" },
            expectedImpact: { type: "string" },
            effort: { type: "string", enum: EFFORTS },
            priority: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["id", "title", "area", "recommendation", "why", "evidence", "risk", "expectedImpact", "effort", "priority"],
          additionalProperties: false,
        },
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  },
};

/* ── Validation ─────────────────────────────────────────────────────────────── */
const str = (v) => (typeof v === "string" ? v.trim() : "");
const oneOf = (v, list, fallback) => (list.includes(str(v)) ? str(v) : fallback);

function validateIdeas(raw) {
  const list = Array.isArray(raw?.ideas) ? raw.ideas : null;
  if (!list || !list.length) return { ok: false, error: "no ideas array" };
  const ideas = [];
  for (const [i, x] of list.entries()) {
    const how = Array.isArray(x?.how) ? x.how.map(str).filter(Boolean) : [];
    // evidence is the whole contract of this feature — an idea without a cited
    // number is exactly the generic advice we are trying to avoid, so drop it.
    if (!str(x?.title) || !str(x?.evidence) || !how.length) continue;
    ideas.push({
      id: str(x.id) || `idea-${i + 1}`,
      title: str(x.title),
      why: str(x.why),
      how,
      expectedImpact: str(x.expectedImpact),
      effort: oneOf(x.effort, EFFORTS, "medium"),
      channel: oneOf(x.channel, CHANNELS, "instore"),
      evidence: str(x.evidence),
      priority: Number.isFinite(Number(x.priority)) ? Math.max(1, Math.min(10, Math.round(Number(x.priority)))) : i + 1,
    });
  }
  if (ideas.length < 3) return { ok: false, error: "too few valid ideas" };
  ideas.sort((a, b) => a.priority - b.priority);
  return { ok: true, value: { ideas } };
}

function validateDecisions(raw) {
  const list = Array.isArray(raw?.decisions) ? raw.decisions : null;
  if (!list || !list.length) return { ok: false, error: "no decisions array" };
  const decisions = [];
  for (const [i, x] of list.entries()) {
    if (!str(x?.title) || !str(x?.evidence) || !str(x?.recommendation)) continue;
    decisions.push({
      id: str(x.id) || `decision-${i + 1}`,
      title: str(x.title),
      area: oneOf(x.area, AREAS, "operations"),
      recommendation: str(x.recommendation),
      why: str(x.why),
      evidence: str(x.evidence),
      risk: str(x.risk),
      expectedImpact: str(x.expectedImpact),
      effort: oneOf(x.effort, EFFORTS, "medium"),
      priority: Number.isFinite(Number(x.priority)) ? Math.max(1, Math.min(10, Math.round(Number(x.priority)))) : i + 1,
    });
  }
  if (decisions.length < 3) return { ok: false, error: "too few valid decisions" };
  decisions.sort((a, b) => a.priority - b.priority);
  return { ok: true, value: { decisions } };
}

/* ── Generation (one retry on a malformed response) ─────────────────────────── */
async function generate(provider, { system, user, tool, validate }) {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? user
      : `${user}\n\nملاحظة: المحاولة السابقة رجعت إجابة غير مكتملة (${lastError}). التزم حرفيًا بمخطط الأداة، واملأ كل الحقول المطلوبة، وتأكد إن حقل evidence في كل عنصر فيه رقم حقيقي من البيانات.`;
    try {
      const raw = await callTool(provider, { system, user: prompt, tool });
      const v = validate(raw);
      if (v.ok) return v.value;
      lastError = v.error;
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(`model response invalid after retry: ${lastError}`);
}

/* ── Routes ─────────────────────────────────────────────────────────────────── */
export function register(app, ctx) {
  const { pool, requireAdmin, todayISO, daysAgoISO, jb } = ctx;

  // Fired once at boot; a failure must not take the API down with it.
  ensureAiSchema(pool).catch((e) => console.error("[ai] ensureAiSchema failed:", e.message));

  function range(body) {
    const from = isoOrNull(body?.from) || daysAgoISO(29);
    const to = isoOrNull(body?.to) || todayISO();
    return from <= to ? { from, to } : { from: to, to: from };
  }

  function envelope(row) {
    return {
      ok: true,
      generatedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      model: row.model,
      dataWindow: {
        from: row.from_date instanceof Date ? row.from_date.toISOString().slice(0, 10) : String(row.from_date),
        to: row.to_date instanceof Date ? row.to_date.toISOString().slice(0, 10) : String(row.to_date),
      },
      facts: row.facts,
      ...row.result,
    };
  }

  /** Shared body for both advisors — they differ only in prompt, tool and validator. */
  async function run(c, kind, buildTool, extraFacts = null) {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const body = await c.req.json().catch(() => ({}));
      const { from, to } = range(body);
      const force = body?.force === true;

      // Cache first: a regeneration costs real money, and nothing in the data
      // moves fast enough to justify one per page load.
      if (!force) {
        const hit = await pool.query(
          `SELECT * FROM ai_reports
            WHERE kind=$1 AND from_date=$2::date AND to_date=$3::date
              AND created_at > NOW() - INTERVAL '${CACHE_HOURS} hours'
              AND ($4::text IS NULL OR facts->'store'->>'_v' = $4)
            ORDER BY created_at DESC LIMIT 1`, [kind, from, to, extraFacts ? STORE_FACTS_VERSION : null]);
        if (hit.rowCount) return c.json({ ...envelope(hit.rows[0]), cached: true });
      }

      const provider = resolveProvider();
      if (!provider) {
        return c.json({
          ok: false,
          error: "no_llm_provider",
          hint: "set ANTHROPIC_API_KEY, or LITELLM_KEY for the https://llm.o2m8.me/v1 proxy",
        }, 503);
      }

      const { facts, orderCount } = await buildFacts(pool, from, to);
      // Never pay for a model call that has nothing to reason about.
      if (orderCount === 0) return c.json({ ok: false, error: "no_data", dataWindow: { from, to } }, 200);

      capFacts(facts);
      // سياق المتجر بعد القصّ — صغير (~٣ ك.ب) وأهم من أي صف أصناف زيادة
      if (extraFacts) facts.store = await extraFacts();
      const { tool, user, validate } = buildTool(facts, body);
      const result = await generate(provider, { system: SYSTEM_PROMPT, user, tool, validate });

      const row = {
        id: crypto.randomUUID(),
        kind, from_date: from, to_date: to,
        model: provider.model, facts, result,
        created_at: new Date(),
      };
      await pool.query(
        `INSERT INTO ai_reports (id, kind, from_date, to_date, model, facts, result)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7)`,
        [row.id, kind, from, to, provider.model, jb(facts), jb(result)]);

      return c.json(envelope(row));
    } catch (e) {
      console.error(`[ai] ${kind} failed:`, e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  }

  app.post("/api/ai/marketing-ideas", (c) => run(c, "marketing", (facts, body) => ({
    tool: IDEAS_TOOL,
    user: ideasUser(facts, str(body?.focus)),
    validate: validateIdeas,
  }), () => buildStoreFacts(pool)));

  app.post("/api/ai/decisions", (c) => run(c, "decisions", (facts) => ({
    tool: DECISIONS_TOOL,
    user: decisionsUser(facts),
    validate: validateDecisions,
  })));

  // Lets the UI render the last answer instantly without paying for a new one.
  app.get("/api/ai/last", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const kind = c.req.query("kind") === "decisions" ? "decisions" : "marketing";
      const r = await pool.query(
        `SELECT * FROM ai_reports WHERE kind=$1 ORDER BY created_at DESC LIMIT 1`, [kind]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found", kind }, 404);
      return c.json({ ...envelope(r.rows[0]), cached: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
}
