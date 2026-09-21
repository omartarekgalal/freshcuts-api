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
import { FIRST_ORDER_CTE, bizDaySql } from "./identity.js";

export const BASE_CTE = `WITH base AS (
  SELECT o.order_no, o.status, o.option, o.total, o.subtotal, o.delivery_fee, o.tip,
         o.discount_amount, o.coupon, o.phone_norm, o.created_at, o.pay_gateway, o.attribution,
         o.attrib_source, o.items, o.alerts, o.history, o.pos_ready_at, o.accepted_at,
         /* «المنطقة البعيدة» — محفوظة جوّه تسعيرة الطلب نفسها، مفيش عمود تاني
            يتعارض معاها. NULL = طلب عادي جوّه النطاق. */
         (o.delivery_quote->'farZone') AS far_zone,
         /* «التوصيل بالحي» — نفس الحكاية: جوّه التسعيرة، مفيش عمود تاني.
            فيه نوعين والاتنين بيروحوا لنفس المندوب:
              districtDelivery = العميل دفع سعر الحي (كان بره نطاقنا)
              districtDispatch = دفع السلّم العادي، بس بعتنا للحي عشان أرخص
            COALESCE بيجمّعهم في عمود واحد للتقرير، و district_mode بيفرّق. */
         COALESCE(o.delivery_quote->'districtDelivery', o.delivery_quote->'districtDispatch') AS district_delivery,
         CASE WHEN o.delivery_quote ? 'districtDelivery' THEN 'priced'
              WHEN o.delivery_quote ? 'districtDispatch' THEN 'dispatch' END AS district_mode,
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
  /* المنطقة البعيدة: كام طلب، وإيرادهم، والرسم الإضافي المحصّل، ومتوسط
     الكيلومترات الزيادة — عمر عايز يشوف هل المشوار الطويل بيدفع تمن نفسه.
     لعجلك بتاخد ٢٫٣٠ ر.س/كم شامل فوق العشرة **بالكسر** (عمر ١٩/٩ + تصدير
     لوحتهم)، واحنا بناخد ٣/كم لكل كيلو بدأ — فالكيلومترات اللي بتتحاسب علينا
     = المسافة الفعلية − ١٠ (مش extraKm المقرّب لفوق اللي العميل دفعه). */
  count(*) FILTER (WHERE is_net AND far_zone IS NOT NULL)::int AS far_zone_orders,
  COALESCE(sum(total) FILTER (WHERE is_net AND far_zone IS NOT NULL),0)::float AS far_zone_revenue,
  COALESCE(sum((far_zone->>'surcharge')::numeric) FILTER (WHERE is_net AND far_zone IS NOT NULL),0)::float AS far_zone_surcharge,
  COALESCE(sum((far_zone->>'extraKm')::numeric) FILTER (WHERE is_net AND far_zone IS NOT NULL),0)::float AS far_zone_extra_km,
  COALESCE(max((far_zone->>'km')::numeric) FILTER (WHERE is_net AND far_zone IS NOT NULL),0)::float AS far_zone_max_km,
  COALESCE(sum(GREATEST(0, (far_zone->>'km')::numeric - 10)) FILTER (WHERE is_net AND far_zone IS NOT NULL),0)::float AS far_zone_courier_km,
  /* التوصيل بالحي: الرسم اللي حصّلناه مقابل التكلفة اللي اتفقنا عليها مع
     المندوب — عمر عايز يشوف الهامش لكل طلب، مش مخلوط مع لاجلك. */
  count(*) FILTER (WHERE is_net AND district_delivery IS NOT NULL)::int AS district_orders,
  COALESCE(sum(total) FILTER (WHERE is_net AND district_delivery IS NOT NULL),0)::float AS district_revenue,
  COALESCE(sum((district_delivery->>'fee')::numeric) FILTER (WHERE is_net AND district_delivery IS NOT NULL),0)::float AS district_fees,
  COALESCE(sum((district_delivery->>'cost')::numeric) FILTER (WHERE is_net AND district_delivery IS NOT NULL),0)::float AS district_cost,
  count(*) FILTER (WHERE is_net AND district_mode='priced')::int AS district_priced_orders,
  count(*) FILTER (WHERE is_net AND district_mode='dispatch')::int AS district_dispatch_orders,
  COALESCE(sum((district_delivery->>'fee')::numeric) FILTER (WHERE is_net AND district_mode='dispatch'),0)::float AS district_dispatch_fees,
  COALESCE(sum((district_delivery->>'cost')::numeric) FILTER (WHERE is_net AND district_mode='dispatch'),0)::float AS district_dispatch_cost,
  /* التوفير مقابل لاجلك: تكلفتهم على نفس المشوار (١٩٫٥٥ ثابت، +٢٫٣٠/كم فوق
     العشرة بالكسر) ناقص اللي دفعناه للمندوب بالحي. بيتحسب في SQL عشان يبقى
     على المشوار الفعلي لكل طلب، مش على متوسط. */
  COALESCE(sum(
    (19.55 + GREATEST(0, COALESCE((district_delivery->>'km')::numeric, 0) - 10) * 2.30)
    - COALESCE((district_delivery->>'cost')::numeric, 0)
  ) FILTER (WHERE is_net AND district_delivery IS NOT NULL AND (district_delivery->>'cost') IS NOT NULL),0)::float AS district_saving,
  COALESCE(sum(
    19.55 + GREATEST(0, COALESCE((district_delivery->>'km')::numeric, 0) - 10) * 2.30
  ) FILTER (WHERE is_net AND district_delivery IS NOT NULL AND (district_delivery->>'cost') IS NOT NULL),0)::float AS district_leajlak_cost,
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

  /* ═══ أداء شركة التوصيل (١٧ سبتمبر — طلب عمر) ═══════════════════════
     المحطّتان الجداد (وصل المطعم / استلم) متخزّنين على الشحنة نفسها، فالأوقات
     دي بتتحسب من dl_shipments مش من history الطلب. الشحنة الملغية مستبعدة،
     والشحنة اليدوية كمان (المزوّد فيها هو الكاشير، مفيش إشارات).
     ready_to_arrived سالب = المندوب وصل **قبل** ما الأكل يجهز. */
  courierTimes: `${BASE_CTE},
cs AS (
  SELECT s.*, b.pos_ready_at
    FROM dl_shipments s
    JOIN base b ON b.order_no = s.shop_order_no AND b.is_net AND b.option = 'delivery'
   WHERE s.provider <> 'manual' AND s.status <> 'cancelled'
),
cm AS (
  SELECT 'ready_to_arrived' AS k, (EXTRACT(EPOCH FROM (arrived_at - pos_ready_at))/60)::float8 AS mins FROM cs
  UNION ALL SELECT 'arrived_to_picked', (EXTRACT(EPOCH FROM (picked_at - arrived_at))/60)::float8 FROM cs
  UNION ALL SELECT 'courier_picked_to_delivered',
                   (EXTRACT(EPOCH FROM (updated_at - picked_at))/60)::float8 FROM cs WHERE status='delivered'
)
SELECT k, count(*)::int AS n, avg(mins)::float AS avg,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY mins)::float AS median,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY mins)::float AS p90
  FROM cm WHERE mins IS NOT NULL AND mins > -720 AND mins < 720
 GROUP BY k`,

  /* العدّ: كام مرة المندوب وصل قبل ما الأكل يجهز (استنّانا) وكام مرة بعده
     (احنا استنّيناه) — ده اللي عمر بيحكم بيه على لاجلك. */
  courierMilestones: `${BASE_CTE}
SELECT count(*)::int AS shipments,
       count(*) FILTER (WHERE s.arrived_at IS NOT NULL)::int AS with_arrived,
       count(*) FILTER (WHERE s.picked_at IS NOT NULL)::int AS with_picked,
       count(*) FILTER (WHERE s.arrived_at IS NOT NULL AND b.pos_ready_at IS NOT NULL
                          AND s.arrived_at <= b.pos_ready_at)::int AS arrived_before_ready,
       count(*) FILTER (WHERE s.arrived_at IS NOT NULL AND b.pos_ready_at IS NOT NULL
                          AND s.arrived_at >  b.pos_ready_at)::int AS arrived_after_ready,
       count(DISTINCT s.provider)::int AS providers,
       max(s.provider) AS provider
  FROM dl_shipments s
  JOIN base b ON b.order_no = s.shop_order_no AND b.is_net AND b.option = 'delivery'
 WHERE s.provider <> 'manual' AND s.status <> 'cancelled'`,

  courierDaily: `${BASE_CTE}
SELECT to_char(b.local_at, 'YYYY-MM-DD') AS day,
       count(*)::int AS shipments,
       count(*) FILTER (WHERE s.arrived_at IS NOT NULL)::int AS with_arrived,
       avg(EXTRACT(EPOCH FROM (s.arrived_at - b.pos_ready_at))/60)
         FILTER (WHERE s.arrived_at IS NOT NULL AND b.pos_ready_at IS NOT NULL)::float AS ready_to_arrived,
       avg(EXTRACT(EPOCH FROM (s.picked_at - s.arrived_at))/60)
         FILTER (WHERE s.picked_at IS NOT NULL AND s.arrived_at IS NOT NULL)::float AS arrived_to_picked,
       avg(EXTRACT(EPOCH FROM (s.updated_at - s.picked_at))/60)
         FILTER (WHERE s.picked_at IS NOT NULL AND s.status='delivered')::float AS picked_to_delivered,
       count(*) FILTER (WHERE s.arrived_at IS NOT NULL AND b.pos_ready_at IS NOT NULL
                          AND s.arrived_at <= b.pos_ready_at)::int AS arrived_before_ready,
       count(*) FILTER (WHERE s.arrived_at IS NOT NULL AND b.pos_ready_at IS NOT NULL
                          AND s.arrived_at >  b.pos_ready_at)::int AS arrived_after_ready
  FROM dl_shipments s
  JOIN base b ON b.order_no = s.shop_order_no AND b.is_net AND b.option = 'delivery'
 WHERE s.provider <> 'manual' AND s.status <> 'cancelled'
 GROUP BY 1 ORDER BY 1`,

  slaCodes: `${BASE_CTE}
SELECT k AS key, count(*)::int AS orders
  FROM base b, jsonb_object_keys(CASE WHEN jsonb_typeof(b.alerts)='object' THEN b.alerts ELSE '{}'::jsonb END) k
 WHERE b.is_paid AND k ~ ':[0-9]$'
 GROUP BY k ORDER BY orders DESC LIMIT 30`,

  topItems: `${BASE_CTE}
SELECT COALESCE(NULLIF(it->>'name',''), NULLIF(it->>'product_name',''), 'صنف #' || COALESCE(it->>'product_id','?')) AS name,
       sum(CASE WHEN COALESCE(it->>'quantity', it->>'qty') ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN COALESCE(it->>'quantity', it->>'qty')::numeric ELSE 1 END)::float AS qty,
       count(DISTINCT b.order_no)::int AS orders
  FROM base b, jsonb_array_elements(CASE WHEN jsonb_typeof(b.items)='array' THEN b.items ELSE '[]'::jsonb END) it
 WHERE b.is_net
 GROUP BY 1 ORDER BY qty DESC, orders DESC LIMIT 20`,

  customers: `${BASE_CTE},
${FIRST_ORDER_CTE},
x AS (
  /* ١٩/٩: «راجع» = طلب قبل كده من أي قناة (identity.js) — مش من الموقع بس.
     عميل صالة/كيتا أول مرة يطلب أونلاين = راجع مش جديد. */
  SELECT b.order_no, b.phone_norm,
         COALESCE((SELECT fa.first_day FROM firsts fa WHERE fa.pn = b.phone_norm) < ${bizDaySql("b.created_at")}, false)
         OR EXISTS (SELECT 1 FROM shop_orders p
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

/* تكلفة الكيلو الزيادة عند لعجلك فوق ١٠ كم = ٢ قبل الضريبة = **٢٫٣٠ شامل**
   بالكسر (عمر أكّد ١٩/٩، ومطابق لتصدير لوحتهم: 17.80 = 17 + 0.40×2).
   احنا بناخد ٣ من العميل لكل كيلو بدأ. التكلفة الفعلية لكل شحنة في sh.cost. */
export const FAR_ZONE_COURIER_PER_KM = Number(process.env.FAR_ZONE_COURIER_PER_KM) || 2.3;

/* كتلة «التوصيل بالحي»: الرسم المحصّل − تكلفة المندوب = الهامش.
   منفصلة عن لاجلك عن قصد — دي مشاوير مابتعدّيش على شركة التوصيل أصلاً،
   فخلطها مع `courierCost` كانت هتخلي مطابقة فاتورة لاجلك تطلع غلط. */
export function districtBlock(t = {}) {
  const orders = Number(t.district_orders) || 0;
  const fees = r2(t.district_fees);
  const cost = r2(t.district_cost);
  const priced = Number(t.district_priced_orders) || 0;
  const dispatch = Number(t.district_dispatch_orders) || 0;
  const saving = r2(t.district_saving);
  const dFees = r2(t.district_dispatch_fees), dCost = r2(t.district_dispatch_cost);
  return {
    orders,
    revenue: r2(t.district_revenue),
    feesCollected: fees,
    courierCost: cost,
    margin: r2(fees - cost),
    marginPerOrder: orders ? r2((fees - cost) / orders) : 0,
    avgFee: orders ? r2(fees / orders) : 0,
    avgCost: orders ? r2(cost / orders) : 0,
    /* تفصيل النوعين + التوفير مقابل لاجلك — عمر بيقيس بيه هل قرار الترشيح
       (السلامة ١٥ بدل ١٩٫٥٥) بيجيب فلوس فعلاً ولا لأ. */
    priced: { orders: priced, feesCollected: r2(fees - dFees), courierCost: r2(cost - dCost) },
    dispatch: { orders: dispatch, feesCollected: dFees, courierCost: dCost,
      margin: r2(dFees - dCost), avgCost: dispatch ? r2(dCost / dispatch) : 0 },
    leajlakWouldCost: r2(t.district_leajlak_cost),
    savedVsLeajlak: saving,
    savedPerOrder: orders ? r2(saving / orders) : 0,
  };
}

/* كتلة «المنطقة البعيدة» في التقرير: هل المشوار الطويل بيدفع تمن نفسه؟ */
export function farZoneBlock(t = {}) {
  const orders = Number(t.far_zone_orders) || 0;
  const extraKm = Number(t.far_zone_extra_km) || 0;
  const surcharge = r2(t.far_zone_surcharge);
  // الكيلومترات الفعلية فوق ١٠ (لو الاستعلام القديم مارجّعهاش → المقرّبة)
  const courierKm = t.far_zone_courier_km != null ? Number(t.far_zone_courier_km) || 0 : extraKm;
  const courierExtra = r2(courierKm * FAR_ZONE_COURIER_PER_KM);
  return {
    orders,
    revenue: r2(t.far_zone_revenue),
    surcharge,                                   // اللي حصّلناه من العميل
    extraKm: r2(extraKm),
    avgExtraKm: orders ? r1(extraKm / orders) : 0,
    maxKm: r1(t.far_zone_max_km) || 0,
    courierExtraCost: courierExtra,              // تقدير تكلفة المندوب الزيادة
    gap: r2(surcharge - courierExtra),           // + يعني الرسم بيغطي ويزيد
    courierKm: r2(courierKm),                   // الكيلومترات اللي لاجلك بتحاسب عليها (بالكسر)
    courierPerKm: FAR_ZONE_COURIER_PER_KM,
  };
}

const TIME_LABELS = {
  paid_to_accepted: "من الدفع للقبول",
  accepted_to_ready: "من القبول لـ«جاهز»",
  ready_to_courier_assigned: "من «جاهز» لتعيين الكابتن",
  picked_to_delivered: "من استلام الكابتن للتوصيل",
  paid_to_delivered: "من الدفع للتوصيل",
  // محطّات المندوب (من إشارات شركة التوصيل نفسها)
  ready_to_arrived: "من «جاهز» لوصول المندوب المطعم",
  arrived_to_picked: "من وصول المندوب لاستلامه الطلب",
  courier_picked_to_delivered: "من استلام المندوب لتسليمه للعميل",
};

/* تشكيل النتايج (صافي — بيتجرّب من غير قاعدة) */
export function shapeReport({ range, totals = {}, courier = {}, daily = [], hourly = [], times = [], slaCodes = [],
  topItems = [], customers = {}, sources = [], links = [], payments = [],
  courierTimes = [], courierMilestones = {}, courierDaily = [] }) {
  const t = totals || {};
  const revenue = r2(t.revenue);
  const netOrders = Number(t.net_orders) || 0;
  const fees = r2(t.delivery_fees);
  const cost = r2(courier.courier_cost);
  const byDay = new Map((daily || []).map((d) => [d.day, d]));
  const byHour = new Map((hourly || []).map((h) => [Number(h.hour), h]));
  const timeMap = {};
  for (const k of Object.keys(TIME_LABELS)) timeMap[k] = { label: TIME_LABELS[k], n: 0, avgMin: null, medianMin: null, p90Min: null };
  for (const x of [...(times || []), ...(courierTimes || [])]) {
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
      farZone: farZoneBlock(t),
      district: districtBlock(t),
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
    /* أداء شركة التوصيل — «وصل المطعم» و«استلم» جايين من إشارات الشركة نفسها.
       coverage = نسبة الشحنات اللي وصلتنا فيها إشارة وصول: لو صفر فالشركة
       مش بتبعتها أصلاً، والشاشة بتقول كده بدل ما تعرض متوسطات على الفاضي. */
    courierPerf: {
      shipments: Number(courierMilestones.shipments) || 0,
      withArrived: Number(courierMilestones.with_arrived) || 0,
      withPicked: Number(courierMilestones.with_picked) || 0,
      arrivedBeforeReady: Number(courierMilestones.arrived_before_ready) || 0,
      arrivedAfterReady: Number(courierMilestones.arrived_after_ready) || 0,
      provider: (Number(courierMilestones.providers) || 0) === 1 ? courierMilestones.provider || null : null,
      coveragePct: Number(courierMilestones.shipments)
        ? r1(((Number(courierMilestones.with_arrived) || 0) / Number(courierMilestones.shipments)) * 100) : null,
      daily: (courierDaily || []).map((d) => ({
        day: d.day,
        shipments: Number(d.shipments) || 0,
        withArrived: Number(d.with_arrived) || 0,
        readyToArrivedMin: r1(d.ready_to_arrived),
        arrivedToPickedMin: r1(d.arrived_to_picked),
        pickedToDeliveredMin: r1(d.picked_to_delivered),
        arrivedBeforeReady: Number(d.arrived_before_ready) || 0,
        arrivedAfterReady: Number(d.arrived_after_ready) || 0,
      })),
    },
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
  const courierTimes = await q("courierTimes");
  const courierMilestones = (await q("courierMilestones"))[0] || {};
  const courierDaily = await q("courierDaily");
  const report = shapeReport({ range, totals, courier, daily, hourly, times, slaCodes, topItems, customers, sources, links, payments,
    courierTimes, courierMilestones, courierDaily });
  if (errors.length) report.partial = errors;
  return report;
}
