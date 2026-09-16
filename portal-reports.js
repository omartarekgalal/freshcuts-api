/* ═══════════════════════════════════════════════════════════════════════════
   PORTAL REPORTS — تقارير الأونلاين للمدير (طلبات المتجر بس، من غير الاختبار).

   الأيام بتوقيت الرياض (تقويمي: ٠٠:٠٠–٢٤:٠٠). كل الاستعلامات قراية بس وعلى
   فهرس created_at، وبتتنفّذ واحد ورا التاني عشان ماتاخدش الـpool كله من
   الشيك أوت.

   تعريفات:
     مدفوع  = status NOT IN ('pending_payment','expired')
     صافي   = مدفوع ومش مرفوض/مسترجع (rejected_refunded, refund_failed)
     الإيراد = Σ total للصافي (أكل + توصيل + بقشيش) — نفس اللي ماي فاتورة حصّلته
═══════════════════════════════════════════════════════════════════════════ */

export const MAX_RANGE_DAYS = 92;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function riyadhToday(now = Date.now()) {
  return new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
}

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* تحقق المدى: بيرجّع {ok, from, to, days} أو {ok:false, error} */
export function parseRange(fromRaw, toRaw, now = Date.now()) {
  const today = riyadhToday(now);
  const to = toRaw ? String(toRaw) : today;
  const from = fromRaw ? String(fromRaw) : (toRaw ? to : today);
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) return { ok: false, error: "bad_date" };
  const f = new Date(`${from}T00:00:00Z`), t = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f.toISOString().slice(0, 10) !== from || t.toISOString().slice(0, 10) !== to) {
    return { ok: false, error: "bad_date" };
  }
  if (t < f) return { ok: false, error: "from_after_to" };
  const days = Math.round((t - f) / 86400_000) + 1;
  if (days > MAX_RANGE_DAYS) return { ok: false, error: "range_too_long", maxDays: MAX_RANGE_DAYS };
  return { ok: true, from, to, days };
}

export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length <= MAX_RANGE_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

/* الطلبات في المدى — $1=from، $2=to (تواريخ الرياض) */
export const BASE_CTE = `WITH base AS (
  SELECT o.order_no, o.status, o.option, o.total, o.subtotal, o.delivery_fee, o.tip,
         o.discount_amount, o.coupon, o.phone_norm, o.created_at, o.pay_gateway, o.attribution,
         o.attrib_source, o.items, o.alerts, o.history, o.pos_ready_at, o.accepted_at,
         (o.created_at AT TIME ZONE 'Asia/Riyadh') AS local_at,
         o.status NOT IN ('pending_payment','expired') AS is_paid,
         o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed') AS is_net
    FROM shop_orders o
   WHERE o.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Riyadh')
     AND o.created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Riyadh')
     AND NOT COALESCE(o.is_test, false)
)`;

const TS_OK = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'`;

export const SQL = Object.freeze({
  totals: `${BASE_CTE},
flag AS (
  SELECT b.*, EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(b.alerts)='object' THEN b.alerts ELSE '{}'::jsonb END) k
                       WHERE k ~ ':[23]$') AS breached,
              EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(b.alerts)='object' THEN b.alerts ELSE '{}'::jsonb END) k
                       WHERE k ~ ':[1-3]$') AS late
    FROM base b
)
SELECT
  count(*) FILTER (WHERE is_paid)::int AS paid_orders,
  count(*) FILTER (WHERE is_net)::int AS net_orders,
  COALESCE(sum(total) FILTER (WHERE is_paid),0)::float AS gross_revenue,
  COALESCE(sum(total) FILTER (WHERE is_net),0)::float AS revenue,
  COALESCE(sum(subtotal) FILTER (WHERE is_net),0)::float AS food_revenue,
  count(*) FILTER (WHERE is_net AND option='delivery')::int AS delivery_orders,
  count(*) FILTER (WHERE is_net AND option='pickup')::int AS pickup_orders,
  COALESCE(sum(total) FILTER (WHERE is_net AND option='delivery'),0)::float AS delivery_revenue,
  COALESCE(sum(total) FILTER (WHERE is_net AND option='pickup'),0)::float AS pickup_revenue,
  COALESCE(sum(delivery_fee) FILTER (WHERE is_net AND option='delivery'),0)::float AS delivery_fees,
  COALESCE(sum(tip) FILTER (WHERE is_net),0)::float AS tips,
  COALESCE(sum(discount_amount) FILTER (WHERE is_net),0)::float AS discounts,
  count(*) FILTER (WHERE is_net AND (coupon IS NOT NULL OR discount_amount > 0))::int AS discounted_orders,
  count(*) FILTER (WHERE status='rejected_refunded')::int AS refunded_orders,
  COALESCE(sum(total) FILTER (WHERE status='rejected_refunded'),0)::float AS refunded_total,
  count(*) FILTER (WHERE status='refund_failed')::int AS refund_failed_orders,
  COALESCE(sum(total) FILTER (WHERE status='refund_failed'),0)::float AS refund_failed_total,
  count(*) FILTER (WHERE status='courier_cancelled')::int AS courier_cancelled_orders,
  count(*) FILTER (WHERE status='paid_pos_failed')::int AS pos_failed_orders,
  count(*) FILTER (WHERE status='expired')::int AS expired_orders,
  count(*) FILTER (WHERE status='pending_payment')::int AS pending_payment_orders,
  count(*) FILTER (WHERE is_paid AND late)::int AS sla_late_orders,
  count(*) FILTER (WHERE is_paid AND breached)::int AS sla_breach_orders,
  count(DISTINCT phone_norm) FILTER (WHERE is_net)::int AS customers
FROM flag`,

  courierCost: `${BASE_CTE}
SELECT COALESCE(sum(s.cost) FILTER (WHERE s.status <> 'cancelled'),0)::float AS courier_cost,
       count(*) FILTER (WHERE s.status <> 'cancelled')::int AS shipments,
       count(*) FILTER (WHERE s.status <> 'cancelled' AND s.cost IS NULL)::int AS shipments_without_cost,
       count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled_shipments,
       count(DISTINCT s.shop_order_no) FILTER (WHERE s.status <> 'cancelled')::int AS orders_with_courier
  FROM dl_shipments s
  JOIN base b ON b.order_no = s.shop_order_no AND b.is_net AND b.option='delivery'`,

  daily: `${BASE_CTE}
SELECT to_char(local_at, 'YYYY-MM-DD') AS day,
       count(*) FILTER (WHERE is_net)::int AS orders,
       COALESCE(sum(total) FILTER (WHERE is_net),0)::float AS revenue,
       count(*) FILTER (WHERE is_net AND option='delivery')::int AS delivery,
       count(*) FILTER (WHERE is_net AND option='pickup')::int AS pickup,
       count(*) FILTER (WHERE status IN ('rejected_refunded','refund_failed'))::int AS refunded
  FROM base GROUP BY 1 ORDER BY 1`,

  hourly: `${BASE_CTE}
SELECT EXTRACT(HOUR FROM local_at)::int AS hour,
       count(*) FILTER (WHERE is_net)::int AS orders,
       COALESCE(sum(total) FILTER (WHERE is_net),0)::float AS revenue
  FROM base GROUP BY 1 ORDER BY 1`,

  times: `${BASE_CTE},
t AS (
  SELECT b.option, b.pos_ready_at, COALESCE(b.accepted_at, hh.accepted_at) AS accepted_at,
         hh.paid_at, hh.assigned_at, hh.onway_at, hh.delivered_at
    FROM base b
    LEFT JOIN LATERAL (
      SELECT min(ts) FILTER (WHERE st='paid') AS paid_at,
             min(ts) FILTER (WHERE st='accepted') AS accepted_at,
             min(ts) FILTER (WHERE st='courier_assigned') AS assigned_at,
             min(ts) FILTER (WHERE st='on_the_way') AS onway_at,
             min(ts) FILTER (WHERE st='delivered') AS delivered_at
        FROM (SELECT h->>'status' AS st, (h->>'at')::timestamptz AS ts
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.history)='array' THEN b.history ELSE '[]'::jsonb END) h
               WHERE (h->>'at') ~ ${TS_OK}) e
    ) hh ON TRUE
   WHERE b.is_net
),
m AS (
  SELECT 'paid_to_accepted' AS k, (EXTRACT(EPOCH FROM (accepted_at - paid_at))/60)::float8 AS mins FROM t
  UNION ALL SELECT 'accepted_to_ready', (EXTRACT(EPOCH FROM (pos_ready_at - accepted_at))/60)::float8 FROM t
  UNION ALL SELECT 'ready_to_courier_assigned', (EXTRACT(EPOCH FROM (assigned_at - pos_ready_at))/60)::float8 FROM t WHERE option='delivery'
  UNION ALL SELECT 'picked_to_delivered', (EXTRACT(EPOCH FROM (delivered_at - onway_at))/60)::float8 FROM t WHERE option='delivery'
  UNION ALL SELECT 'paid_to_delivered', (EXTRACT(EPOCH FROM (delivered_at - paid_at))/60)::float8 FROM t WHERE option='delivery'
)
SELECT k, count(*)::int AS n, avg(mins)::float AS avg,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY mins)::float AS median,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY mins)::float AS p90
  FROM m WHERE mins IS NOT NULL AND mins >= 0 AND mins < 720
 GROUP BY k`,

  slaCodes: `${BASE_CTE}
SELECT k AS key, count(*)::int AS orders
  FROM base b, jsonb_object_keys(CASE WHEN jsonb_typeof(b.alerts)='object' THEN b.alerts ELSE '{}'::jsonb END) k
 WHERE b.is_paid AND k ~ ':[0-9]$'
 GROUP BY k ORDER BY orders DESC LIMIT 30`,

  topItems: `${BASE_CTE}
SELECT COALESCE(NULLIF(it->>'name',''), NULLIF(it->>'product_name',''), 'منتج ' || COALESCE(it->>'product_id','?')) AS name,
       sum(CASE WHEN COALESCE(it->>'quantity', it->>'qty') ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN COALESCE(it->>'quantity', it->>'qty')::numeric ELSE 1 END)::float AS qty,
       count(DISTINCT b.order_no)::int AS orders
  FROM base b, jsonb_array_elements(CASE WHEN jsonb_typeof(b.items)='array' THEN b.items ELSE '[]'::jsonb END) it
 WHERE b.is_net
 GROUP BY 1 ORDER BY qty DESC, orders DESC LIMIT 20`,

  customers: `${BASE_CTE},
x AS (
  SELECT b.order_no, b.phone_norm,
         EXISTS (SELECT 1 FROM shop_orders p
                  WHERE p.phone_norm = b.phone_norm AND p.created_at < b.created_at
                    AND p.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed')
                    AND NOT COALESCE(p.is_test, false)) AS is_returning
    FROM base b WHERE b.is_net AND b.phone_norm IS NOT NULL
)
SELECT count(*) FILTER (WHERE NOT is_returning)::int AS new_orders,
       count(*) FILTER (WHERE is_returning)::int AS returning_orders,
       count(DISTINCT phone_norm) FILTER (WHERE NOT is_returning)::int AS new_customers,
       count(DISTINCT phone_norm)::int AS customers
  FROM x`,

  sources: `${BASE_CTE}
SELECT COALESCE(NULLIF(attrib_source,''), NULLIF(attribution->'utm'->>'utm_source',''),
                CASE WHEN NULLIF(attribution->>'fc_link','') IS NOT NULL THEN 'link' END, 'direct') AS source,
       count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue
  FROM base WHERE is_net GROUP BY 1 ORDER BY orders DESC LIMIT 20`,

  links: `${BASE_CTE}
SELECT attribution->>'fc_link' AS link, count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue
  FROM base WHERE is_net AND NULLIF(attribution->>'fc_link','') IS NOT NULL
 GROUP BY 1 ORDER BY orders DESC LIMIT 20`,

  payments: `${BASE_CTE}
SELECT COALESCE(NULLIF(pay_gateway,''), 'unknown') AS method, count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue
  FROM base WHERE is_paid GROUP BY 1 ORDER BY orders DESC LIMIT 20`,
});

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r1 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

const TIME_LABELS = {
  paid_to_accepted: "من الدفع للقبول",
  accepted_to_ready: "من القبول لـ«جاهز»",
  ready_to_courier_assigned: "من «جاهز» لتعيين الكابتن",
  picked_to_delivered: "من استلام الكابتن للتوصيل",
  paid_to_delivered: "من الدفع للتوصيل",
};

/* تشكيل النتايج (صافي — بيتجرّب من غير قاعدة) */
export function shapeReport({ range, totals = {}, courier = {}, daily = [], hourly = [], times = [], slaCodes = [],
  topItems = [], customers = {}, sources = [], links = [], payments = [] }) {
  const t = totals || {};
  const revenue = r2(t.revenue);
  const netOrders = Number(t.net_orders) || 0;
  const fees = r2(t.delivery_fees);
  const cost = r2(courier.courier_cost);
  const byDay = new Map((daily || []).map((d) => [d.day, d]));
  const byHour = new Map((hourly || []).map((h) => [Number(h.hour), h]));
  const timeMap = {};
  for (const k of Object.keys(TIME_LABELS)) timeMap[k] = { label: TIME_LABELS[k], n: 0, avgMin: null, medianMin: null, p90Min: null };
  for (const x of times || []) {
    if (!timeMap[x.k]) continue;
    timeMap[x.k] = { label: TIME_LABELS[x.k], n: Number(x.n) || 0, avgMin: r1(x.avg), medianMin: r1(x.median), p90Min: r1(x.p90) };
  }
  const slaByCode = {};
  for (const s of slaCodes || []) {
    const m = /^(.+):(\d)$/.exec(String(s.key || ""));
    if (!m || m[1].startsWith("staff")) continue;
    const e = slaByCode[m[1]] || (slaByCode[m[1]] = { code: m[1], maxLevel: 0, orders: 0 });
    e.maxLevel = Math.max(e.maxLevel, Number(m[2]));
    e.orders = Math.max(e.orders, Number(s.orders) || 0);
  }
  return {
    range,
    kpis: {
      paidOrders: Number(t.paid_orders) || 0,
      orders: netOrders,
      revenue,
      grossRevenue: r2(t.gross_revenue),
      foodRevenue: r2(t.food_revenue),
      aov: netOrders ? r2(revenue / netOrders) : 0,
      customers: Number(t.customers) || 0,
      tips: r2(t.tips),
    },
    fulfilment: {
      delivery: { orders: Number(t.delivery_orders) || 0, revenue: r2(t.delivery_revenue) },
      pickup: { orders: Number(t.pickup_orders) || 0, revenue: r2(t.pickup_revenue) },
      deliverySharePct: netOrders ? r1(((Number(t.delivery_orders) || 0) / netOrders) * 100) : 0,
    },
    delivery: {
      feesCollected: fees,
      courierCost: cost,
      margin: r2(fees - cost),
      shipments: Number(courier.shipments) || 0,
      shipmentsWithoutCost: Number(courier.shipments_without_cost) || 0,
      cancelledShipments: Number(courier.cancelled_shipments) || 0,
      ordersWithCourier: Number(courier.orders_with_courier) || 0,
    },
    discounts: { total: r2(t.discounts), orders: Number(t.discounted_orders) || 0 },
    losses: {
      refunded: { orders: Number(t.refunded_orders) || 0, total: r2(t.refunded_total) },
      refundFailed: { orders: Number(t.refund_failed_orders) || 0, total: r2(t.refund_failed_total) },
      courierCancelled: Number(t.courier_cancelled_orders) || 0,
      posFailed: Number(t.pos_failed_orders) || 0,
      expired: Number(t.expired_orders) || 0,
      pendingPayment: Number(t.pending_payment_orders) || 0,
    },
    sla: {
      lateOrders: Number(t.sla_late_orders) || 0,
      breachOrders: Number(t.sla_breach_orders) || 0,
      byCode: Object.values(slaByCode).sort((a, b) => b.orders - a.orders),
    },
    times: timeMap,
    series: {
      daily: daysBetween(range.from, range.to).map((day) => {
        const d = byDay.get(day) || {};
        return { day, orders: Number(d.orders) || 0, revenue: r2(d.revenue), delivery: Number(d.delivery) || 0,
          pickup: Number(d.pickup) || 0, refunded: Number(d.refunded) || 0 };
      }),
      hourly: Array.from({ length: 24 }, (_, hour) => {
        const h = byHour.get(hour) || {};
        return { hour, orders: Number(h.orders) || 0, revenue: r2(h.revenue) };
      }),
    },
    topItems: (topItems || []).map((x) => ({ name: x.name, qty: r2(x.qty), orders: Number(x.orders) || 0 })),
    customers: {
      newOrders: Number(customers.new_orders) || 0,
      returningOrders: Number(customers.returning_orders) || 0,
      newCustomers: Number(customers.new_customers) || 0,
      customers: Number(customers.customers) || 0,
    },
    attribution: {
      sources: (sources || []).map((x) => ({ source: x.source, orders: Number(x.orders) || 0, revenue: r2(x.revenue) })),
      links: (links || []).map((x) => ({ link: x.link, orders: Number(x.orders) || 0, revenue: r2(x.revenue) })),
    },
    payments: (payments || []).map((x) => ({ method: x.method, orders: Number(x.orders) || 0, revenue: r2(x.revenue) })),
  };
}

/* تشغيل كل الاستعلامات (واحد ورا التاني) — أي استعلام يقع بيرجّع فاضي بدل ما يوقّع التقرير كله */
export async function buildReport(pool, range, log = console) {
  const params = [range.from, range.to];
  const errors = [];
  const q = async (key) => {
    try { return (await pool.query(SQL[key], params)).rows || []; }
    catch (e) {
      errors.push(key);
      try { log.error(`[portal-reports] ${key} failed: ${e?.message || e}`); } catch {}
      return [];
    }
  };
  const totals = (await q("totals"))[0] || {};
  const courier = (await q("courierCost"))[0] || {};
  const daily = await q("daily");
  const hourly = await q("hourly");
  const times = await q("times");
  const slaCodes = await q("slaCodes");
  const topItems = await q("topItems");
  const customers = (await q("customers"))[0] || {};
  const sources = await q("sources");
  const links = await q("links");
  const payments = await q("payments");
  const report = shapeReport({ range, totals, courier, daily, hourly, times, slaCodes, topItems, customers, sources, links, payments });
  if (errors.length) report.partial = errors;
  return report;
}
