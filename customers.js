/* ═══════════════════════════════════════════════════════════════════════════
   CUSTOMERS — KPIs and the badge that sits next to a name in the orders report

   Omar asked for "مقاييس للعملاء وKPIs واضحة ومؤشر واضح جنب كل اسم عميل في
   تقرير الطلبات". A name on its own says nothing: the same string could be a
   first-time walk-in or the man who has spent 900 SAR over eleven visits. The
   badge answers "who is this?" at a glance; the KPI endpoints answer it in
   aggregate.

   The identity is the normalised mobile number — one person, one number. That
   is Omar's rule and it is what makes any of this countable.
═══════════════════════════════════════════════════════════════════════════ */

import { FIRST_ORDER_DAY_CTE } from "./analytics.js";

// A customer who has not ordered in this long is treated as lapsed. Chosen to
// be a little over three weeks: the repeat customers we have cluster around a
// 9-14 day gap, so 21 days is clearly outside the normal rhythm rather than
// just a slow fortnight.
const LAPSED_DAYS = 21;
// Top slice of lifetime spend that earns the VIP mark.
const VIP_TOP_FRACTION = 0.2;
// A returning customer whose gap exceeded this came back from the cold.
const WINBACK_DAYS = 21;

const NOT_VOID = `o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'`;

// The order's customer identity: the phone the cashier/FeedUs recorded, else
// the phone on the POS customer record the order was attached to.
const IDENTITY = `COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,''))`;

const IDENTITY_JOIN = `
  LEFT JOIN order_sources s ON s.order_id = o.order_id
  LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id`;

export function register(app, ctx) {
  const { pool, requireAdmin, todayISO, daysAgoISO } = ctx;

  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const range = (c, defDays = 30) => {
    const from = isDate(c.req.query("from")) ? c.req.query("from") : daysAgoISO(defDays - 1);
    const to = isDate(c.req.query("to")) ? c.req.query("to") : todayISO();
    return [from, to];
  };

  /* ─── GET /api/customers/kpis?from&to ──────────────────────────────────────
     The headline numbers. Every one of them is a count of orders that carry an
     identity — orders with nobody attached are reported separately as
     `unidentifiedOrders` rather than being silently folded into the base, which
     would quietly flatter every rate on the page.                            */
  app.get("/api/customers/kpis", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const [from, to] = range(c);

    const r = (await pool.query(
      `WITH ${FIRST_ORDER_DAY_CTE},
       scoped AS (
         SELECT o.order_id, o.calendar_day, o.total, ${IDENTITY} AS pn
           FROM ts_orders o ${IDENTITY_JOIN}
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${NOT_VOID}
       ),
       ident AS (SELECT * FROM scoped WHERE pn IS NOT NULL AND pn <> ''),
       -- lifetime totals per customer, not just the window: "spent 900 SAR"
       -- means over their whole history, which is what LTV has to mean.
       life AS (
         SELECT ${IDENTITY} AS pn, count(*)::int AS orders,
                sum(o.total)::numeric AS spend, max(o.calendar_day) AS last_day
           FROM ts_orders o ${IDENTITY_JOIN}
          WHERE ${NOT_VOID} AND ${IDENTITY} IS NOT NULL AND ${IDENTITY} <> ''
          GROUP BY 1
       )
       SELECT
         (SELECT count(*)::int FROM scoped)                          AS orders,
         (SELECT count(*)::int FROM scoped WHERE pn IS NULL OR pn = '') AS unidentified_orders,
         (SELECT count(*)::int FROM ident)                           AS identified_orders,
         (SELECT count(DISTINCT pn)::int FROM ident)                 AS customers,
         (SELECT count(DISTINCT i.pn)::int FROM ident i JOIN firsts f ON f.pn = i.pn
           WHERE f.first_day BETWEEN $1::date AND $2::date)          AS new_customers,
         (SELECT COALESCE(sum(i.total),0)::numeric FROM ident i JOIN firsts f ON f.pn = i.pn
           WHERE f.first_day BETWEEN $1::date AND $2::date)          AS new_customer_value,
         (SELECT count(*)::int FROM ident i JOIN firsts f ON f.pn = i.pn
           WHERE f.first_day < i.calendar_day)                       AS returning_orders,
         (SELECT COALESCE(sum(total),0)::numeric FROM ident)         AS identified_value,
         (SELECT count(*)::int FROM life WHERE orders > 1)           AS repeat_customers,
         (SELECT count(*)::int FROM life)                            AS lifetime_customers,
         (SELECT COALESCE(avg(orders),0)::numeric FROM life)         AS avg_orders_per_customer,
         (SELECT COALESCE(avg(spend),0)::numeric FROM life)          AS avg_lifetime_value,
         (SELECT count(*)::int FROM life
           WHERE last_day < CURRENT_DATE - $3::int)                  AS lapsed_customers`,
      [from, to, LAPSED_DAYS]
    )).rows[0];

    const n = (v) => Number(v) || 0;
    const orders = n(r.orders), ident = n(r.identified_orders);
    const life = n(r.lifetime_customers);
    // Every rate guards its denominator: a null reads as "لا يوجد" in the UI,
    // which is the truth, where a 0 would read as a measured failure.
    const rate = (num, den) => (den > 0 ? num / den : null);

    return c.json({
      ok: true, from, to,
      lapsedAfterDays: LAPSED_DAYS,
      orders,
      unidentifiedOrders: n(r.unidentified_orders),
      identifiedOrders: ident,
      identifyRate: rate(ident, orders),
      customers: n(r.customers),
      newCustomers: n(r.new_customers),
      newCustomerValue: n(r.new_customer_value),
      returningOrders: n(r.returning_orders),
      returningRate: rate(n(r.returning_orders), ident),
      aov: rate(n(r.identified_value), ident),
      repeatCustomers: n(r.repeat_customers),
      lifetimeCustomers: life,
      repeatRate: rate(n(r.repeat_customers), life),
      avgOrdersPerCustomer: n(r.avg_orders_per_customer),
      avgLifetimeValue: n(r.avg_lifetime_value),
      lapsedCustomers: n(r.lapsed_customers),
    });
  });

  /* ─── GET /api/customers/list?from&to&limit ────────────────────────────────
     One row per customer with the numbers behind the badge.                   */
  app.get("/api/customers/list", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const [from, to] = range(c);
    const limit = Math.max(1, Math.min(1000, Number(c.req.query("limit")) || 300));

    const rows = (await pool.query(
      `WITH life AS (
         SELECT ${IDENTITY} AS pn,
                count(*)::int AS orders,
                sum(o.total)::numeric AS spend,
                min(o.calendar_day) AS first_day,
                max(o.calendar_day) AS last_day,
                max(COALESCE(NULLIF(s.customer_name,''), tc.name)) AS name
           FROM ts_orders o ${IDENTITY_JOIN}
          WHERE ${NOT_VOID} AND ${IDENTITY} IS NOT NULL AND ${IDENTITY} <> ''
          GROUP BY 1
       ),
       window_rows AS (
         SELECT ${IDENTITY} AS pn, count(*)::int AS orders_in_window,
                sum(o.total)::numeric AS spend_in_window
           FROM ts_orders o ${IDENTITY_JOIN}
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${NOT_VOID}
            AND ${IDENTITY} IS NOT NULL AND ${IDENTITY} <> ''
          GROUP BY 1
       ),
       ranked AS (
         SELECT l.*, percent_rank() OVER (ORDER BY l.spend DESC) AS spend_rank
           FROM life l
       )
       SELECT r.pn AS phone, r.name, r.orders, r.spend, r.first_day, r.last_day,
              r.spend_rank,
              (CURRENT_DATE - r.last_day)::int AS days_since,
              COALESCE(w.orders_in_window,0)::int AS orders_in_window,
              COALESCE(w.spend_in_window,0)::numeric AS spend_in_window
         FROM ranked r
         LEFT JOIN window_rows w ON w.pn = r.pn
        WHERE w.pn IS NOT NULL
        ORDER BY r.spend DESC
        LIMIT $3`,
      [from, to, limit]
    )).rows;

    const out = rows.map((r) => {
      const orders = Number(r.orders) || 0;
      const spend = Number(r.spend) || 0;
      const daysSince = Number(r.days_since) || 0;
      const vip = Number(r.spend_rank) <= VIP_TOP_FRACTION && orders > 1;
      return {
        phone: r.phone,
        name: r.name || "(بدون اسم)",
        orders,
        spend,
        aov: orders > 0 ? spend / orders : null,
        firstDay: r.first_day instanceof Date ? r.first_day.toISOString().slice(0, 10) : r.first_day,
        lastDay: r.last_day instanceof Date ? r.last_day.toISOString().slice(0, 10) : r.last_day,
        daysSince,
        ordersInWindow: Number(r.orders_in_window) || 0,
        spendInWindow: Number(r.spend_in_window) || 0,
        vip,
        lapsed: daysSince > LAPSED_DAYS,
        repeat: orders > 1,
      };
    });
    return c.json({ ok: true, from, to, lapsedAfterDays: LAPSED_DAYS, count: out.length, customers: out });
  });

  /* ─── GET /api/customers/badges?from&to ────────────────────────────────────
     orderId → the mark that goes next to the name in the orders report. One
     badge per order, decided in priority order so a row never carries two
     contradictory marks. Returned as a map so the report can render without a
     second lookup per row.                                                    */
  app.get("/api/customers/badges", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const [from, to] = range(c);

    const rows = (await pool.query(
      `WITH ${FIRST_ORDER_DAY_CTE},
       -- every order resolved to an identity, once, so the rest of the query
       -- never has to repeat the COALESCE or the join
       oi AS (
         SELECT o.order_id, o.calendar_day, o.total, ${IDENTITY} AS pn,
                COALESCE(NULLIF(s.customer_name,''), tc.name) AS name
           FROM ts_orders o ${IDENTITY_JOIN}
          WHERE ${NOT_VOID}
       ),
       life AS (
         SELECT pn, count(*)::int AS orders, sum(total)::numeric AS spend
           FROM oi WHERE pn IS NOT NULL AND pn <> '' GROUP BY 1
       ),
       ranked AS (SELECT pn, orders, spend, percent_rank() OVER (ORDER BY spend DESC) AS spend_rank FROM life),
       -- the same customer's previous order day, straight off a window
       with_prev AS (
         SELECT order_id, calendar_day, pn, name,
                lag(calendar_day) OVER (PARTITION BY pn ORDER BY calendar_day, order_id) AS prev_day
           FROM oi
       )
       SELECT w.order_id, w.calendar_day, w.pn, w.name, w.prev_day,
              f.first_day, r.orders, r.spend, r.spend_rank
         FROM with_prev w
         LEFT JOIN firsts f ON f.pn = w.pn
         LEFT JOIN ranked r ON r.pn = w.pn
        WHERE w.calendar_day BETWEEN $1::date AND $2::date`,
      [from, to]
    )).rows;

    const badges = {};
    for (const r of rows) {
      const id = String(r.order_id);
      if (!r.pn) { badges[id] = { key: "none", label: "بدون عميل", icon: "⚪" }; continue; }
      const orders = Number(r.orders) || 0;
      const day = r.calendar_day;
      const isNew = r.first_day && String(r.first_day).slice(0, 10) === String(day).slice(0, 10);
      const gap = r.prev_day
        ? Math.round((new Date(day) - new Date(r.prev_day)) / 86400000)
        : null;
      const vip = r.spend_rank != null && Number(r.spend_rank) <= VIP_TOP_FRACTION && orders > 1;

      // Priority: VIP outranks everything (it is the one Omar acts on), then a
      // win-back, then new, then plain repeat.
      let b;
      if (vip) b = { key: "vip", label: `عميل مميز · ${orders} طلب`, icon: "⭐" };
      else if (gap != null && gap >= WINBACK_DAYS) b = { key: "winback", label: `رجع بعد ${gap} يوم`, icon: "🔙" };
      else if (isNew) b = { key: "new", label: "عميل جديد", icon: "🆕" };
      else if (orders > 1) b = { key: "repeat", label: `متكرر · ${orders} طلب`, icon: "🔁" };
      else b = { key: "single", label: "طلب واحد", icon: "👤" };

      badges[id] = { ...b, name: r.name || "(بدون اسم)", phone: r.pn, orders, spend: Number(r.spend) || 0 };
    }
    return c.json({ ok: true, from, to, count: Object.keys(badges).length, badges });
  });
}
