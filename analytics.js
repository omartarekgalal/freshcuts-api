/* ═══════════════════════════════════════════════════════════════════════════
   ANALYTICS — deep reporting on top of the TabSense order/customer cache.

   Registered by index.js via `register(app, ctx)`. Everything here is
   admin-only and read-only except POST /api/analytics/backfill-items, which
   pulls line items from TabSense into ts_order_items.

   ── Business rules that shape every query in this file ────────────────────
   1. MONEY IS VAT-INCLUSIVE. TabSense reports gross/discount/net EXCLUDING
      VAT, but the receipt the customer holds (and every number Omar quotes)
      is VAT-inclusive. So we only ever read `total`, `gross_incl` and
      `discount_incl`. Never `gross`/`discount`/`net`.
   2. VOID AND REFUND ORDERS ARE EXCLUDED FROM SALES. A voided order never
      happened and a refund is the reversal of an order already counted on
      its own day — including either would double-count or inflate revenue.
      (order_type values seen in the wild: 'Void', 'Refund',
      'Void QR-Menu Orders' — hence the ILIKE '%void%' / '%refund%' match.)
   3. THE BUSINESS DAY IS NOT THE CALENDAR DAY. The kitchen runs ~12:00 until
      ~03:00 the next morning, so TabSense books a 01:30 order onto the
      PREVIOUS day. Verified against the live cache: local hours 00–03 sit on
      the previous `calendar_day`, hour 04 onward on the same one. We
      therefore (a) always group days by `calendar_day` (TabSense is the
      authority, we never recompute it) and (b) derive "how far into the
      business day are we" from a 04:00 Riyadh start when we need an
      elapsed-time cutoff. Hour-of-day reporting still uses the real Riyadh
      wall clock, so a Friday-night shift reads as Friday 12:00→03:00.
═══════════════════════════════════════════════════════════════════════════ */

const TZ = "Asia/Riyadh";
// Hour (Riyadh local) at which TabSense rolls the business day over. See note 3.
const BIZ_DAY_START_HOUR = 4;

// SQL fragments. All of these assume the orders table is aliased `o`.
const LOCAL_TS = `(o.order_date AT TIME ZONE '${TZ}')`;
const BIZ_TS = `((o.order_date AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')`;
// Hours elapsed into the business day the order belongs to (0 → 24).
const BIZ_ELAPSED_H = `(extract(epoch from (${BIZ_TS} - ${BIZ_TS}::date::timestamp)) / 3600.0)`;
const LOCAL_HOUR = `(extract(hour from ${LOCAL_TS})::int)`;
// See business rule 2.
const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

// An order is a delivery-aggregator order when TabSense typed it 'External'
// (true from the moment it is created) OR when one of its payment methods is
// an aggregator wallet (only lands once the order is paid). Both signals are
// needed: the POS logs aggregator orders as Dine-in, so order_option lies.
const deliverySql = (appsParam) =>
  `(o.order_type ILIKE '%external%' OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY(${appsParam})))`;

// Which app an order came through. `order_sources.source_note` is the truth
// (filled by the FeedUs connector or the cashier); the aggregator payment
// method is the fallback, and 'external' means "delivery, app unknown".
const channelSql = (appsParam) => `
  CASE WHEN ${deliverySql(appsParam)} THEN
    lower(COALESCE(
      NULLIF(s.source_note, ''),
      (SELECT k FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY(${appsParam}) LIMIT 1),
      'external'))
  ELSE 'inhouse' END`;

// Identity of the human behind an order. The cashier station's typed phone
// wins over the POS customer record because it is captured at the counter for
// orders TabSense attached no customer to.
const IDENT_SQL = `COALESCE(NULLIF(s.phone_norm, ''), NULLIF(tc.phone_norm, ''))`;

/* ═══════════════════════════════════════════════════════════════════════════
   THE NEW-CUSTOMER RULE — ONE DEFINITION FOR THE WHOLE API.

   IN PLAIN TERMS: a customer is NEW in a window when they ORDERED INSIDE THE
   WINDOW **and** had never ordered before it. Both halves are required.
   Everyone else who ordered in the window is a RETURNING customer, and someone
   who did not order in the window is neither — they are not on the report at
   all. Registering, being synced, or being typed into the cashier station is
   not "new": only an order makes a customer appear.

   Dropping the first half is what made /api/analytics/live report 93 new
   customers on 2026-07-31, a day on which only 13 of them ordered — it counted
   every identity first seen that day whether or not they bought anything.

   FIRST-SEEN COMES FROM ORDER DAYS, NEVER FROM A SYNC TIMESTAMP.
   `order_sources.filled_at` is when the cashier station (or a backfill) WROTE
   the row, not when the order happened: 153 of 162 rows are stamped after
   their own order's business day, 9.4 days later on average and up to 37. Any
   rule built on it silently rewrites new-customer history for past days every
   time a backfill runs. So first-seen is the earliest `ts_orders.calendar_day`
   of the orders behind the identity — via the order each order_sources row
   belongs to, and via the customer record the POS attached to the order — with
   the customer record's own first_order_at (falling back to registered_at only
   when there is no first order) folded onto the business day as a third
   source, so a customer whose real first order predates our order cache is not
   mistaken for new. Being a min(), that third source can only pull first_day
   EARLIER; it can never invent a first day after an order we actually hold.

   Voids and refunds do not count as a first order — a void never happened.

   Yields `firsts(pn, first_day)`. Callers join it as
   `LEFT JOIN firsts f ON f.pn = <the identity expression>` and use exactly
   these two predicates:
     new customer in [from,to]  →  f.first_day BETWEEN <from> AND <to>
     returning on an order      →  f.first_day < <that order's calendar_day>
   A NULL first_day (no order day known at all) is never counted as new.

   Aliases inside are deliberately fs/fo/fc so the fragment can be pasted into
   any query without capturing an outer `o` / `s` / `tc`.
═══════════════════════════════════════════════════════════════════════════ */
export const FIRST_ORDER_DAY_CTE = `
  firsts AS (
    SELECT pn, min(first_day) AS first_day FROM (
      -- (a) the phone the cashier station / FeedUs connector typed on the order
      SELECT fs.phone_norm AS pn, min(fo.calendar_day) AS first_day
        FROM order_sources fs
        JOIN ts_orders fo ON fo.order_id = fs.order_id
       WHERE fs.phone_norm <> ''
         AND (fo.order_type IS NULL
              OR (fo.order_type NOT ILIKE '%void%' AND fo.order_type NOT ILIKE '%refund%'))
       GROUP BY 1
      UNION ALL
      -- (b) the customer record the POS attached to the order
      SELECT fc.phone_norm AS pn, min(fo.calendar_day) AS first_day
        FROM ts_orders fo
        JOIN ts_customers fc ON fc.customer_id = fo.customer_id
       WHERE COALESCE(fc.phone_norm, '') <> ''
         AND (fo.order_type IS NULL
              OR (fo.order_type NOT ILIKE '%void%' AND fo.order_type NOT ILIKE '%refund%'))
       GROUP BY 1
      UNION ALL
      -- (c) history older than our order cache, straight off the customer record
      SELECT fc.phone_norm AS pn,
             min(((COALESCE(fc.first_order_at, fc.registered_at) AT TIME ZONE '${TZ}')
                  - interval '${BIZ_DAY_START_HOUR} hours')::date) AS first_day
        FROM ts_customers fc
       WHERE COALESCE(fc.phone_norm, '') <> ''
         AND COALESCE(fc.first_order_at, fc.registered_at) IS NOT NULL
       GROUP BY 1
    ) u GROUP BY 1
  )`;

const CHANNEL_LABELS = {
  inhouse: "داخل المطعم",
  keeta: "كيتا",
  hungerstation: "هنقرستيشن",
  ninja: "نينجا",
  jahez: "جاهز",
  toyou: "تو يو",
  mrsool: "مرسول",
  careem: "كريم",
  feedus: "تطبيقات التوصيل (فيدأس)",
  external: "توصيل — تطبيق غير محدد",
  delivery: "توصيل",
};
const chLabel = (id) => CHANNEL_LABELS[String(id || "").toLowerCase()] || id || "غير معروف";

// Postgres `extract(dow)`: 0 = Sunday.
const DOW_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const SEGMENT_LABELS = {
  champions: "الأبطال",
  loyal: "أوفياء",
  new: "جدد",
  at_risk: "في خطر",
  lost: "مفقودون",
};

/* ── small numeric / date helpers ────────────────────────────────────────── */

// pg returns NUMERIC and BIGINT as strings; everything user-facing goes
// through these so the JSON is always real numbers.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Totals carry float noise from TabSense (e.g. 2203.975249926) — round money.
const money = (v) => Math.round(num(v) * 100) / 100;
const qty = (v) => Math.round(num(v) * 1000) / 1000;
const rate = (v) => (v === null || v === undefined ? null : Math.round(num(v) * 10000) / 10000);

// Ratio with an explicit "undefined" answer. Returning null (not 0, not
// Infinity) is the whole point: a frontend must be able to render "—" for
// "there is nothing to compare against" instead of a fake -100%.
const ratio = (a, b) => (num(b) === 0 ? null : rate(num(a) / num(b)));
const delta = (cur, base) => (base === null || base === undefined || num(base) === 0
  ? null
  : rate((num(cur) - num(base)) / num(base)));

const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayArg = (v, fallback) => (typeof v === "string" && DAY_RE.test(v) ? v : fallback);
const shiftDay = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);

// Resolve the comparison window for ?vs=
function comparisonWindow(from, to, vs) {
  const n = spanDays(from, to);
  if (vs === "lastweek") return { from: shiftDay(from, -7), to: shiftDay(to, -7) };
  if (vs === "lastyear") return { from: shiftDay(from, -365), to: shiftDay(to, -365) };
  // default: the equal-length period immediately before `from`
  const prevTo = shiftDay(from, -1);
  return { from: shiftDay(prevTo, -(n - 1)), to: prevTo };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, getSettingsData, todayISO, daysAgoISO, ts, DEFAULT_DELIVERY_APPS } = ctx;

  // Payment-method names that mean "delivery aggregator", overridable in settings.
  async function deliveryApps() {
    const s = await getSettingsData();
    const list = Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length
      ? s.deliveryAppMethods
      : DEFAULT_DELIVERY_APPS;
    return list.map((x) => String(x).toLowerCase());
  }

  // Current business day + how many hours we are into it. Everything the live
  // endpoint compares hangs off these two numbers.
  async function bizNow() {
    const r = await pool.query(
      `SELECT ((now() AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date AS day,
              extract(epoch from (
                ((now() AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')
                - ((now() AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date::timestamp
              )) / 3600.0 AS elapsed_h`
    );
    return {
      day: isoDay(r.rows[0].day),
      elapsedH: Math.min(24, Math.max(0, num(r.rows[0].elapsed_h))),
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/analytics/live — today so far, with honest comparisons.

     The only defensible way to say "today is up 12%" at 19:00 is to compare
     today's first N hours against the SAME first N hours of the comparison
     day. Comparing a half-finished day against a full one would report a
     collapse every single afternoon, so every comparison row here is cut at
     the same business-day elapsed offset as today.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/analytics/live", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    const apps = await deliveryApps();
    const { day, elapsedH } = await bizNow();

    // Today + the five comparison days, all cut at the same elapsed offset.
    const perDay = (await pool.query(
      `WITH scoped AS (
         SELECT o.calendar_day, o.total, o.discount_incl,
                ${BIZ_ELAPSED_H} AS eh,
                ${deliverySql("$3::text[]")} AS is_delivery
           FROM ts_orders o
          WHERE o.calendar_day = ANY (ARRAY[
                  $1::date, $1::date - 1, $1::date - 7,
                  $1::date - 14, $1::date - 21, $1::date - 28])
            AND ${SALES_ONLY}
       )
       SELECT calendar_day AS day,
              count(*)::int AS orders,
              COALESCE(sum(total), 0) AS revenue,
              COALESCE(sum(discount_incl), 0) AS discount,
              count(*) FILTER (WHERE is_delivery)::int AS delivery_orders,
              COALESCE(sum(total) FILTER (WHERE is_delivery), 0) AS delivery_revenue,
              count(*) FILTER (WHERE NOT is_delivery)::int AS inhouse_orders,
              COALESCE(sum(total) FILTER (WHERE NOT is_delivery), 0) AS inhouse_revenue
         FROM scoped
        WHERE eh <= $2::numeric
        GROUP BY 1`,
      [day, elapsedH, apps]
    )).rows;

    const byDay = new Map(perDay.map((r) => [isoDay(r.day), r]));
    const zero = { orders: 0, revenue: 0, discount: 0, delivery_orders: 0, delivery_revenue: 0, inhouse_orders: 0, inhouse_revenue: 0 };
    const get = (iso) => byDay.get(iso) || zero;
    const t = get(day);

    // New customers — THE shared rule (see FIRST_ORDER_DAY_CTE): they have to
    // have ORDERED in today's window, not merely been first seen today. The
    // window here is the single business day `day`, cut at the same elapsed
    // offset as every other number on this screen.
    const nc = (await pool.query(
      `WITH scoped AS (
         SELECT ${IDENT_SQL} AS ident, ${BIZ_ELAPSED_H} AS eh
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day = $1::date AND ${SALES_ONLY}
       ),
       ${FIRST_ORDER_DAY_CTE}
       SELECT count(DISTINCT sc.ident)::int AS known,
              count(DISTINCT sc.ident) FILTER (
                WHERE f.first_day BETWEEN $1::date AND $1::date)::int AS n
         FROM scoped sc LEFT JOIN firsts f ON f.pn = sc.ident
        WHERE sc.ident IS NOT NULL AND sc.eh <= $2::numeric`,
      [day, elapsedH]
    )).rows[0];

    const cmp = (key, label, base) => ({
      key, label,
      orders: base.orders ? num(base.orders) : 0,
      revenue: money(base.revenue),
      deltaOrders: delta(t.orders, base.orders),
      deltaRevenue: delta(t.revenue, base.revenue),
    });

    // Denominator for the 4-week average = the comparison days the restaurant
    // actually operated on, NOT the days that happen to have an order inside
    // the elapsed window. Those are different: early in the business day most
    // comparison days are legitimately empty, and averaging only the non-empty
    // ones would quietly drop real zeros and inflate the baseline. Dividing by
    // a hardcoded 4 would be wrong the other way once the cache stops reaching
    // back a full month.
    const weekDays = (await pool.query(
      `SELECT DISTINCT o.calendar_day AS day FROM ts_orders o
        WHERE o.calendar_day = ANY (ARRAY[$1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28])
          AND ${SALES_ONLY}`,
      [day]
    )).rows.map((r) => isoDay(r.day));
    const avg4 = weekDays.length
      ? {
        orders: weekDays.reduce((a, d2) => a + num(get(d2).orders), 0) / weekDays.length,
        revenue: weekDays.reduce((a, d2) => a + num(get(d2).revenue), 0) / weekDays.length,
      }
      : { orders: 0, revenue: 0 };

    const compare = [
      cmp("yesterday", "أمس", get(shiftDay(day, -1))),
      cmp("lastWeek", "نفس اليوم الأسبوع الماضي", get(shiftDay(day, -7))),
      cmp("avg4Weeks", "متوسط ٤ أسابيع", avg4),
    ];

    // Hour-of-day: today vs the trailing 28-day average for the same hour.
    const hourRows = (await pool.query(
      `SELECT ${LOCAL_HOUR} AS hour,
              count(*) FILTER (WHERE o.calendar_day = $1::date)::int AS today_orders,
              COALESCE(sum(o.total) FILTER (WHERE o.calendar_day = $1::date), 0) AS today_revenue,
              count(*) FILTER (WHERE o.calendar_day < $1::date)::int AS base_orders
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date - 28 AND $1::date
          AND ${SALES_ONLY}
        GROUP BY 1`,
      [day]
    )).rows;
    const baseDays = num((await pool.query(
      `SELECT count(DISTINCT o.calendar_day)::int AS n FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date - 28 AND $1::date - 1 AND ${SALES_ONLY}`,
      [day]
    )).rows[0].n);

    const hourMap = new Map(hourRows.map((r) => [num(r.hour), r]));
    const hourly = [];
    for (let h = 0; h < 24; h++) {
      const r = hourMap.get(h) || {};
      const avg = baseDays > 0 ? num(r.base_orders) / baseDays : 0;
      // An hour that has not happened yet today has no honest comparison —
      // offset within the business day, so 04:00 is offset 0 and 03:00 is 23.
      const offset = (h - BIZ_DAY_START_HOUR + 24) % 24;
      const elapsed = offset < elapsedH;
      hourly.push({
        hour: h,
        orders: num(r.today_orders),
        revenue: money(r.today_revenue),
        todayVsAvg: elapsed ? delta(r.today_orders, avg) : null,
      });
    }

    // Per-channel today vs the like-for-like 4-week average for that channel.
    const chRows = (await pool.query(
      `WITH scoped AS (
         SELECT o.calendar_day, o.total, ${BIZ_ELAPSED_H} AS eh, ${channelSql("$3::text[]")} AS ch
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day = ANY (ARRAY[
                  $1::date, $1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28])
            AND ${SALES_ONLY}
       )
       SELECT ch,
              count(*) FILTER (WHERE calendar_day = $1::date)::int AS orders,
              COALESCE(sum(total) FILTER (WHERE calendar_day = $1::date), 0) AS revenue,
              count(*) FILTER (WHERE calendar_day < $1::date)::int AS base_orders
         FROM scoped
        WHERE eh <= $2::numeric
        GROUP BY 1 ORDER BY 2 DESC`,
      [day, elapsedH, apps]
    )).rows;
    // Same operating-days denominator as avg4Weeks above.
    const chBaseDays = weekDays.length || 1;
    const channels = chRows.map((r) => ({
      id: r.ch,
      label: chLabel(r.ch),
      orders: num(r.orders),
      revenue: money(r.revenue),
      deltaOrders: delta(r.orders, num(r.base_orders) / chBaseDays),
    }));

    const topItemsToday = (await pool.query(
      `SELECT i.name, sum(i.qty) AS qty, sum(i.amount) AS revenue
         FROM ts_order_items i
         JOIN ts_orders o ON o.order_id = i.order_id
        WHERE o.calendar_day = $1::date AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY qty DESC, revenue DESC LIMIT 10`,
      [day]
    )).rows.map((r) => ({ name: r.name, qty: qty(r.qty), revenue: money(r.revenue) }));

    return c.json({
      ok: true,
      asOf: new Date().toISOString(),
      today: {
        day,
        orders: num(t.orders),
        revenue: money(t.revenue),
        avgOrder: num(t.orders) > 0 ? money(num(t.revenue) / num(t.orders)) : 0,
        discount: money(t.discount),
        delivery: { orders: num(t.delivery_orders), revenue: money(t.delivery_revenue) },
        inhouse: { orders: num(t.inhouse_orders), revenue: money(t.inhouse_revenue) },
        newCustomers: num(nc.n),
        // The denominator newCustomers came out of: identifiable humans who
        // ordered inside the same window. Ships so the ratio is auditable.
        knownCustomers: num(nc.known),
        hoursElapsed: Math.round(elapsedH * 100) / 100,
      },
      compare,
      hourly,
      channels,
      topItemsToday,
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
     Period KPI block — shared by /compare.
  ───────────────────────────────────────────────────────────────────────── */
  async function periodKpis(from, to, apps) {
    const r = (await pool.query(
      `WITH scoped AS (
         SELECT o.order_id, o.calendar_day, o.total, o.discount_incl, o.gross_incl,
                ${deliverySql("$3::text[]")} AS is_delivery,
                ${IDENT_SQL} AS ident
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
       ),
       ${FIRST_ORDER_DAY_CTE}
       SELECT count(*)::int AS orders,
              COALESCE(sum(sc.total), 0) AS revenue,
              COALESCE(sum(sc.discount_incl), 0) AS discount,
              COALESCE(sum(sc.gross_incl), 0) AS gross_incl,
              count(*) FILTER (WHERE sc.is_delivery)::int AS delivery_orders,
              COALESCE(sum(sc.total) FILTER (WHERE sc.is_delivery), 0) AS delivery_revenue,
              count(*) FILTER (WHERE NOT sc.is_delivery)::int AS inhouse_orders,
              COALESCE(sum(sc.total) FILTER (WHERE NOT sc.is_delivery), 0) AS inhouse_revenue,
              count(DISTINCT sc.ident)::int AS unique_customers,
              -- THE shared new-customer rule: ordered in this window (scoped
              -- already guarantees that) AND never ordered before it.
              count(DISTINCT sc.ident) FILTER (
                WHERE f.first_day BETWEEN $1::date AND $2::date)::int AS new_customers,
              count(*) FILTER (WHERE sc.ident IS NOT NULL)::int AS identified_orders,
              count(*) FILTER (
                WHERE sc.ident IS NOT NULL
                  AND f.first_day < sc.calendar_day)::int AS returning_orders
         FROM scoped sc LEFT JOIN firsts f ON f.pn = sc.ident`,
      [from, to, apps]
    )).rows[0];

    // Ad spend lives in the marketing module and is keyed by plain calendar day.
    const spend = num((await pool.query(
      `SELECT COALESCE(sum(spend), 0) AS spend FROM mk_entries WHERE day BETWEEN $1::date AND $2::date`,
      [from, to]
    )).rows[0].spend);

    const daily = (await pool.query(
      `SELECT o.calendar_day AS day, count(*)::int AS orders,
              COALESCE(sum(o.total), 0) AS revenue,
              count(*) FILTER (WHERE ${deliverySql("$3::text[]")})::int AS delivery_orders
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY 1`,
      [from, to, apps]
    )).rows.map((x) => ({
      day: isoDay(x.day),
      orders: num(x.orders),
      revenue: money(x.revenue),
      deliveryOrders: num(x.delivery_orders),
    }));

    const orders = num(r.orders);
    const revenue = money(r.revenue);
    return {
      from, to,
      orders,
      revenue,
      avgOrder: orders > 0 ? money(revenue / orders) : 0,
      discount: money(r.discount),
      // Discount as a share of the pre-discount (VAT-inclusive) menu price —
      // the only denominator where "we gave away 12%" actually means 12%.
      discountRatio: ratio(r.discount, r.gross_incl),
      deliveryOrders: num(r.delivery_orders),
      deliveryRevenue: money(r.delivery_revenue),
      deliveryShare: ratio(r.delivery_revenue, r.revenue),
      inhouseOrders: num(r.inhouse_orders),
      inhouseRevenue: money(r.inhouse_revenue),
      newCustomers: num(r.new_customers),
      // Share of *identifiable* orders placed by someone who had ordered
      // before. Orders with no phone at all are left out of both sides rather
      // than silently counted as new.
      returningRate: ratio(r.returning_orders, r.identified_orders),
      identifiedOrders: num(r.identified_orders),
      uniqueCustomers: num(r.unique_customers),
      adSpend: money(spend),
      costPerOrder: spend > 0 && orders > 0 ? money(spend / orders) : null,
      daily,
    };
  }

  /* GET /api/analytics/compare?from&to&vs=prev|lastweek|lastyear */
  app.get("/api/analytics/compare", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    const vsRaw = String(c.req.query("vs") || "prev");
    const vs = ["prev", "lastweek", "lastyear"].includes(vsRaw) ? vsRaw : "prev";
    const apps = await deliveryApps();

    const win = comparisonWindow(from, to, vs);
    const [current, previous] = await Promise.all([
      periodKpis(from, to, apps),
      periodKpis(win.from, win.to, apps),
    ]);

    // Delta for every scalar KPI. Rates/shares are already fractions, so their
    // delta is the change in the ratio itself, not a ratio of ratios.
    const DELTA_KEYS = [
      "orders", "revenue", "avgOrder", "discount", "discountRatio",
      "deliveryOrders", "deliveryRevenue", "deliveryShare",
      "inhouseOrders", "inhouseRevenue",
      "newCustomers", "returningRate", "uniqueCustomers", "adSpend", "costPerOrder",
    ];
    const deltas = {};
    for (const k of DELTA_KEYS) deltas[k] = delta(current[k], previous[k]);

    const VS_LABELS = { prev: "الفترة السابقة", lastweek: "نفس الفترة الأسبوع الماضي", lastyear: "نفس الفترة العام الماضي" };

    return c.json({
      ok: true, from, to, vs,
      compareFrom: win.from, compareTo: win.to,
      compareLabel: VS_LABELS[vs],
      days: spanDays(from, to),
      current, previous, delta: deltas,
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/analytics/items?from&to&limit
     Item intelligence. ts_order_items is only populated for orders somebody
     opened (or that backfill-items pulled), so `coverage` ships with every
     response — without it the UI would present a 3-order sample as the truth.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/analytics/items", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
    const apps = await deliveryApps();
    const n = spanDays(from, to);
    const prevTo = shiftDay(from, -1);
    const prevFrom = shiftDay(prevTo, -(n - 1));

    const agg = (await pool.query(
      `SELECT i.name,
              sum(i.qty) AS qty,
              sum(i.amount) AS revenue,
              count(DISTINCT i.order_id)::int AS orders
         FROM ts_order_items i
         JOIN ts_orders o ON o.order_id = i.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1`,
      [from, to]
    )).rows;

    const totalRevenue = agg.reduce((a, r) => a + num(r.revenue), 0);
    const totalQty = agg.reduce((a, r) => a + num(r.qty), 0);
    const shape = (r) => ({
      name: r.name,
      qty: qty(r.qty),
      revenue: money(r.revenue),
      orders: num(r.orders),
      revenueShare: ratio(r.revenue, totalRevenue),
      qtyShare: ratio(r.qty, totalQty),
    });

    const byQty = [...agg].sort((a, b) => num(b.qty) - num(a.qty)).slice(0, limit).map(shape);
    const byRevenue = [...agg].sort((a, b) => num(b.revenue) - num(a.revenue)).slice(0, limit).map(shape);
    const revenueShare = [...agg]
      .sort((a, b) => num(b.revenue) - num(a.revenue))
      .slice(0, limit)
      .map((r) => ({ name: r.name, revenue: money(r.revenue), share: ratio(r.revenue, totalRevenue) }));

    // Movers: this period vs the equal-length period right before it.
    const movers = (await pool.query(
      `SELECT i.name,
              COALESCE(sum(i.qty) FILTER (WHERE o.calendar_day BETWEEN $1::date AND $2::date), 0) AS cur_qty,
              COALESCE(sum(i.qty) FILTER (WHERE o.calendar_day BETWEEN $3::date AND $4::date), 0) AS prev_qty,
              COALESCE(sum(i.amount) FILTER (WHERE o.calendar_day BETWEEN $1::date AND $2::date), 0) AS cur_rev
         FROM ts_order_items i
         JOIN ts_orders o ON o.order_id = i.order_id
        WHERE o.calendar_day BETWEEN $3::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1
        -- Noise gate: an item that moved 1 → 2 units is not a "riser".
       HAVING sum(i.qty) FILTER (WHERE o.calendar_day BETWEEN $1::date AND $2::date) >= 5
           OR sum(i.qty) FILTER (WHERE o.calendar_day BETWEEN $3::date AND $4::date) >= 5`,
      [from, to, prevFrom, prevTo]
    )).rows.map((r) => ({
      name: r.name,
      qty: qty(r.cur_qty),
      prevQty: qty(r.prev_qty),
      revenue: money(r.cur_rev),
      change: qty(num(r.cur_qty) - num(r.prev_qty)),
      delta: delta(r.cur_qty, r.prev_qty),
    }));
    const risers = movers.filter((m) => m.change > 0).sort((a, b) => b.change - a.change).slice(0, limit);
    const fallers = movers.filter((m) => m.change < 0).sort((a, b) => a.change - b.change).slice(0, limit);

    // Real basket analysis: a self-join on order_id. `b.name > a.name` keeps
    // each unordered pair once and drops an item paired with itself.
    const pairs = (await pool.query(
      `SELECT a.name AS item_a, b.name AS item_b, count(DISTINCT a.order_id)::int AS orders
         FROM ts_order_items a
         JOIN ts_order_items b ON b.order_id = a.order_id AND b.name > a.name
         JOIN ts_orders o ON o.order_id = a.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1, 2 ORDER BY orders DESC, 1 LIMIT 15`,
      [from, to]
    )).rows.map((r) => ({ itemA: r.item_a, itemB: r.item_b, orders: num(r.orders) }));

    const chan = (await pool.query(
      `WITH agg AS (
         SELECT CASE WHEN ${deliverySql("$3::text[]")} THEN 'delivery' ELSE 'inhouse' END AS ch,
                i.name, sum(i.qty) AS qty, sum(i.amount) AS revenue
           FROM ts_order_items i
           JOIN ts_orders o ON o.order_id = i.order_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          GROUP BY 1, 2
       )
       SELECT * FROM (
         SELECT agg.*, row_number() OVER (PARTITION BY ch ORDER BY qty DESC) AS rn FROM agg
       ) t WHERE rn <= $4::int`,
      [from, to, apps, limit]
    )).rows;
    const byChannel = { delivery: [], inhouse: [] };
    for (const r of chan) {
      (byChannel[r.ch] ||= []).push({ name: r.name, qty: qty(r.qty), revenue: money(r.revenue) });
    }

    const cov = (await pool.query(
      `SELECT count(*)::int AS orders_total,
              count(*) FILTER (
                WHERE EXISTS (SELECT 1 FROM ts_order_items i WHERE i.order_id = o.order_id))::int AS with_items
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`,
      [from, to]
    )).rows[0];

    return c.json({
      ok: true, from, to, limit,
      previousFrom: prevFrom, previousTo: prevTo,
      totals: { items: agg.length, qty: qty(totalQty), revenue: money(totalRevenue) },
      top: { byQty, byRevenue },
      revenueShare,
      risers, fallers,
      pairs,
      byChannel,
      coverage: {
        ordersWithItems: num(cov.with_items),
        ordersTotal: num(cov.orders_total),
        pct: ratio(cov.with_items, cov.orders_total),
      },
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/analytics/hours?from&to — day/hour heatmap.
     `dow` comes from calendar_day (the BUSINESS day) while `hour` is the real
     Riyadh wall clock. That combination is what a restaurant actually wants:
     the Friday shift reads as Friday 12:00 → 03:00 instead of splitting
     across two rows at midnight.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/analytics/hours", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());

    const rows = (await pool.query(
      `SELECT extract(dow from o.calendar_day)::int AS dow,
              ${LOCAL_HOUR} AS hour,
              count(*)::int AS orders,
              COALESCE(sum(o.total), 0) AS revenue
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [from, to]
    )).rows.map((r) => ({
      dow: num(r.dow),
      hour: num(r.hour),
      orders: num(r.orders),
      revenue: money(r.revenue),
    }));

    const withLabel = (s) => ({ ...s, label: `${DOW_AR[s.dow] || s.dow} ${String(s.hour).padStart(2, "0")}:00` });
    const live = rows.filter((r) => r.orders > 0);
    const peakHours = [...live].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue).slice(0, 3).map(withLabel);
    const deadHours = [...live].sort((a, b) => a.orders - b.orders || a.revenue - b.revenue).slice(0, 3).map(withLabel);

    // Marginal totals are cheap here and save the UI a second pass.
    const byDow = DOW_AR.map((label, dow) => {
      const slots = rows.filter((r) => r.dow === dow);
      return {
        dow, label,
        orders: slots.reduce((a, r) => a + r.orders, 0),
        revenue: money(slots.reduce((a, r) => a + r.revenue, 0)),
      };
    });
    const byHour = Array.from({ length: 24 }, (_, hour) => {
      const slots = rows.filter((r) => r.hour === hour);
      return {
        hour,
        orders: slots.reduce((a, r) => a + r.orders, 0),
        revenue: money(slots.reduce((a, r) => a + r.revenue, 0)),
      };
    });

    return c.json({ ok: true, from, to, cells: rows, byDow, byHour, peakHours, deadHours });
  });

  /* GET /api/analytics/channels?from&to&vs=prev */
  app.get("/api/analytics/channels", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    const vsRaw = String(c.req.query("vs") || "prev");
    const vs = ["prev", "lastweek", "lastyear"].includes(vsRaw) ? vsRaw : "prev";
    const apps = await deliveryApps();
    const win = comparisonWindow(from, to, vs);

    const q = async (f, t2) => (await pool.query(
      `SELECT ${channelSql("$3::text[]")} AS ch,
              count(*)::int AS orders,
              COALESCE(sum(o.total), 0) AS revenue,
              COALESCE(sum(o.discount_incl), 0) AS discount,
              min(o.order_date) AS first_order_at,
              max(o.order_date) AS last_order_at
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1`,
      [f, t2, apps]
    )).rows;

    const [cur, prev] = await Promise.all([q(from, to), q(win.from, win.to)]);
    const prevMap = new Map(prev.map((r) => [r.ch, r]));
    const totalRevenue = cur.reduce((a, r) => a + num(r.revenue), 0);
    const totalOrders = cur.reduce((a, r) => a + num(r.orders), 0);

    const channels = cur.map((r) => {
      const p = prevMap.get(r.ch) || { orders: 0, revenue: 0, discount: 0 };
      const orders = num(r.orders);
      const revenue = money(r.revenue);
      return {
        id: r.ch,
        label: chLabel(r.ch),
        isDelivery: r.ch !== "inhouse",
        orders,
        revenue,
        avgOrder: orders > 0 ? money(revenue / orders) : 0,
        share: ratio(r.revenue, totalRevenue),
        orderShare: ratio(r.orders, totalOrders),
        discount: money(r.discount),
        firstOrderAt: r.first_order_at || null,
        lastOrderAt: r.last_order_at || null,
        previous: {
          orders: num(p.orders),
          revenue: money(p.revenue),
          avgOrder: num(p.orders) > 0 ? money(num(p.revenue) / num(p.orders)) : 0,
          discount: money(p.discount),
        },
        delta: {
          orders: delta(r.orders, p.orders),
          revenue: delta(r.revenue, p.revenue),
          avgOrder: delta(
            num(r.orders) > 0 ? num(r.revenue) / num(r.orders) : 0,
            num(p.orders) > 0 ? num(p.revenue) / num(p.orders) : 0
          ),
          discount: delta(r.discount, p.discount),
        },
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // Channels that existed before but produced nothing this period are a
    // finding, not an absence — surface them instead of dropping them.
    const gone = prev
      .filter((p) => !cur.some((r) => r.ch === p.ch))
      .map((p) => ({
        id: p.ch, label: chLabel(p.ch), isDelivery: p.ch !== "inhouse",
        orders: 0, revenue: 0, avgOrder: 0, share: 0, orderShare: 0, discount: 0,
        firstOrderAt: null, lastOrderAt: null,
        previous: { orders: num(p.orders), revenue: money(p.revenue), avgOrder: num(p.orders) > 0 ? money(num(p.revenue) / num(p.orders)) : 0, discount: money(p.discount) },
        delta: { orders: -1, revenue: -1, avgOrder: null, discount: null },
      }));

    return c.json({
      ok: true, from, to, vs,
      compareFrom: win.from, compareTo: win.to,
      totals: { orders: totalOrders, revenue: money(totalRevenue) },
      channels: channels.concat(gone),
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/analytics/customers?from&to

     RFM-lite segment thresholds (recency measured from `to`, frequency and
     revenue measured over the customer's whole life, not just the window —
     a customer's loyalty does not reset because you changed the date filter):
       champions : >= 4 lifetime orders AND ordered within 30 days
       new       : exactly 1 lifetime order AND it was within 30 days
       loyal     : >= 2 lifetime orders AND ordered within 60 days
       at_risk   : last order 61-120 days ago
       lost      : last order > 120 days ago
     Cases are evaluated in that order, so the first match wins.
  ───────────────────────────────────────────────────────────────────────── */
  const RECENCY_ACTIVE = 30, RECENCY_LOYAL = 60, RECENCY_ATRISK = 120;
  const FREQ_CHAMPION = 4, FREQ_LOYAL = 2;

  app.get("/api/analytics/customers", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    const apps = await deliveryApps();

    // Every non-void order, keyed by the human behind it. Reused by all four
    // blocks below. Takes the apps placeholder as an argument because Postgres
    // rejects a statement that binds a parameter it never references, so each
    // query has to number its own params from $1.
    const knownCte = (appsParam) => `
      ${FIRST_ORDER_DAY_CTE},
      known AS (
        SELECT ${IDENT_SQL} AS ident,
               o.order_id, o.order_date, o.calendar_day, o.total,
               ${channelSql(appsParam)} AS ch,
               COALESCE(NULLIF(tc.name, ''), NULLIF(s.customer_name, '')) AS cname,
               COALESCE(NULLIF(tc.phone, ''), NULLIF(s.customer_phone, '')) AS cphone
          FROM ts_orders o
          LEFT JOIN order_sources s ON s.order_id = o.order_id
          LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         WHERE ${SALES_ONLY} AND ${IDENT_SQL} IS NOT NULL
      ),
      lifetime AS (
        -- first_day is THE shared first-order day (FIRST_ORDER_DAY_CTE), so
        -- "new" means the same thing here as on /live, /compare and /api/day.
        -- It is a BUSINESS day, which is also why cohorts and recency below
        -- bucket on calendar_day and never on a timestamp cast.
        SELECT k.ident, f.first_day,
               max(k.calendar_day) AS last_day,
               count(*)::int AS freq, sum(k.total) AS ltv
          FROM known k LEFT JOIN firsts f ON f.pn = k.ident
         GROUP BY 1, 2
      )`;

    // ── new vs returning, over the window ──
    const nvr = (await pool.query(
      `WITH ${knownCte("$3::text[]")}
       , win AS (
         SELECT k.*, l.first_day
           FROM known k JOIN lifetime l ON l.ident = k.ident
          WHERE k.calendar_day BETWEEN $1::date AND $2::date
       )
       -- Order-level split: an order is a "new" order when it was placed on the
       -- customer's own first order day, returning when they had ordered on an
       -- earlier day. >= rather than = only so the two always add up to
       -- identified_orders even if first_day were ever unknown.
       SELECT (SELECT count(*)::int FROM ts_orders o
                WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}) AS orders_total,
              count(*)::int AS identified_orders,
              count(*) FILTER (WHERE first_day >= calendar_day
                                  OR first_day IS NULL)::int AS new_orders,
              count(*) FILTER (WHERE first_day < calendar_day)::int AS returning_orders,
              count(DISTINCT ident)::int AS customers,
              -- THE shared new-customer rule (win already restricts to people
              -- who ordered inside the window).
              count(DISTINCT ident) FILTER (
                WHERE first_day BETWEEN $1::date AND $2::date)::int AS new_customers,
              COALESCE(sum(total) FILTER (WHERE first_day >= calendar_day
                                             OR first_day IS NULL), 0) AS new_revenue,
              COALESCE(sum(total) FILTER (WHERE first_day < calendar_day), 0) AS returning_revenue
         FROM win`,
      [from, to, apps]
    )).rows[0];

    // ── monthly first-order cohorts ──
    const cohortRows = (await pool.query(
      // Cohort = the month of the customer's first order BUSINESS day. Bucketing
      // on the raw order_date timestamp instead would file a 01:30 order on the
      // 1st into the wrong month, so the month comes off `first_day` and the
      // return windows are counted in business days, not timestamp intervals.
      `WITH ${knownCte("$1::text[]")}
       SELECT to_char(l.first_day, 'YYYY-MM') AS cohort,
              count(*)::int AS customers,
              COALESCE(sum(l.ltv), 0) AS revenue,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM known k WHERE k.ident = l.ident
                  AND k.calendar_day > l.first_day
                  AND k.calendar_day <= l.first_day + 30))::int AS ret30,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM known k WHERE k.ident = l.ident
                  AND k.calendar_day > l.first_day
                  AND k.calendar_day <= l.first_day + 60))::int AS ret60,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM known k WHERE k.ident = l.ident
                  AND k.calendar_day > l.first_day
                  AND k.calendar_day <= l.first_day + 90))::int AS ret90
         FROM lifetime l WHERE l.first_day IS NOT NULL GROUP BY 1 ORDER BY 1`,
      [apps]
    )).rows;

    // A cohort cannot have a 90-day return rate until 90 days after its last
    // member joined. Report null for immature windows rather than a rate that
    // is guaranteed to look bad.
    const nowMs = Date.now();
    const cohorts = cohortRows.map((r) => {
      const cohortEnd = Date.parse(`${r.cohort}-01T00:00:00Z`) + 31 * 86400000;
      const mature = (d) => nowMs - cohortEnd >= d * 86400000;
      const n2 = num(r.customers);
      return {
        cohort: r.cohort,
        customers: n2,
        revenue: money(r.revenue),
        ret30: n2 > 0 ? num(r.ret30) : 0,
        ret60: n2 > 0 ? num(r.ret60) : 0,
        ret90: n2 > 0 ? num(r.ret90) : 0,
        rate30: mature(30) ? ratio(r.ret30, n2) : null,
        rate60: mature(60) ? ratio(r.ret60, n2) : null,
        rate90: mature(90) ? ratio(r.ret90, n2) : null,
      };
    });

    // ── RFM-lite segments (thresholds documented above) ──
    const segRows = (await pool.query(
      `WITH ${knownCte("$1::text[]")}
       , scored AS (
         -- Recency in BUSINESS days: last_day is already the TabSense
         -- calendar_day of the customer's last order, so nothing is re-derived
         -- from a timestamp here.
         SELECT ident, freq, ltv, last_day,
                ($2::date - last_day) AS recency
           FROM lifetime
       )
       SELECT CASE
                WHEN freq >= ${FREQ_CHAMPION} AND recency <= ${RECENCY_ACTIVE} THEN 'champions'
                WHEN freq = 1 AND recency <= ${RECENCY_ACTIVE} THEN 'new'
                WHEN freq >= ${FREQ_LOYAL} AND recency <= ${RECENCY_LOYAL} THEN 'loyal'
                WHEN recency <= ${RECENCY_ATRISK} THEN 'at_risk'
                ELSE 'lost' END AS seg,
              count(*)::int AS customers,
              COALESCE(sum(ltv), 0) AS revenue,
              COALESCE(avg(freq), 0) AS avg_orders,
              COALESCE(avg(recency), 0) AS avg_recency
         FROM scored GROUP BY 1`,
      [apps, to]
    )).rows;
    const segMap = new Map(segRows.map((r) => [r.seg, r]));
    const segments = ["champions", "loyal", "new", "at_risk", "lost"].map((id) => {
      const r = segMap.get(id) || {};
      return {
        id,
        label: SEGMENT_LABELS[id],
        count: num(r.customers),
        revenue: money(r.revenue),
        avgOrders: Math.round(num(r.avg_orders) * 100) / 100,
        avgRecencyDays: Math.round(num(r.avg_recency)),
      };
    });

    // ── top customers in the window ──
    const topCustomers = (await pool.query(
      `WITH ${knownCte("$1::text[]")}
       SELECT k.ident,
              max(k.cname) AS name,
              max(k.cphone) AS phone,
              count(*)::int AS orders,
              COALESCE(sum(k.total), 0) AS revenue,
              max(k.order_date) AS last_order_at,
              mode() WITHIN GROUP (ORDER BY k.ch) AS ch,
              max(l.freq)::int AS lifetime_orders,
              max(l.ltv) AS lifetime_revenue
         FROM known k JOIN lifetime l ON l.ident = k.ident
        WHERE k.calendar_day BETWEEN $2::date AND $3::date
        GROUP BY 1 ORDER BY revenue DESC LIMIT 15`,
      [apps, from, to]
    )).rows.map((r) => ({
      name: r.name || "—",
      phone: r.phone || r.ident || "",
      orders: num(r.orders),
      revenue: money(r.revenue),
      avgOrder: num(r.orders) > 0 ? money(num(r.revenue) / num(r.orders)) : 0,
      lastOrderAt: r.last_order_at || null,
      channel: r.ch,
      channelLabel: chLabel(r.ch),
      lifetimeOrders: num(r.lifetime_orders),
      lifetimeRevenue: money(r.lifetime_revenue),
    }));

    const identified = num(nvr.identified_orders);
    return c.json({
      ok: true, from, to,
      newVsReturning: {
        ordersTotal: num(nvr.orders_total),
        identifiedOrders: identified,
        // Orders with no phone at all — the honest denominator caveat.
        unknownOrders: Math.max(0, num(nvr.orders_total) - identified),
        newOrders: num(nvr.new_orders),
        returningOrders: num(nvr.returning_orders),
        newRevenue: money(nvr.new_revenue),
        returningRevenue: money(nvr.returning_revenue),
        customers: num(nvr.customers),
        newCustomers: num(nvr.new_customers),
        returningRate: ratio(nvr.returning_orders, identified),
        coverage: ratio(identified, nvr.orders_total),
      },
      cohorts,
      segments,
      segmentRules: {
        recencyActiveDays: RECENCY_ACTIVE,
        recencyLoyalDays: RECENCY_LOYAL,
        recencyAtRiskDays: RECENCY_ATRISK,
        freqChampion: FREQ_CHAMPION,
        freqLoyal: FREQ_LOYAL,
      },
      topCustomers,
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
     POST /api/analytics/backfill-items  { from, to, cap }
     TabSense has no bulk line-item export, so items must be pulled one order
     at a time. It rate-limits per-order fetches, hence the throttle and the
     hard cap — a runaway loop would get the session blocked.
  ───────────────────────────────────────────────────────────────────────── */
  const BACKFILL_MAX = 300;
  const BACKFILL_THROTTLE_MS = 300;

  app.post("/api/analytics/backfill-items", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    if (typeof ts?.fetchOrderProducts !== "function") {
      return c.json({ ok: false, error: "tabsense_not_configured" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const from = dayArg(body.from, daysAgoISO(29));
    const to = dayArg(body.to, todayISO());
    const cap = Math.min(BACKFILL_MAX, Math.max(1, Number(body.cap) || BACKFILL_MAX));

    // Only orders with no cached items at all. Orders TabSense legitimately
    // returns empty stay eligible on the next run; that is cheaper than
    // maintaining a "known empty" marker table.
    const targets = (await pool.query(
      `SELECT o.order_id FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date
          AND ${SALES_ONLY}
          AND NOT EXISTS (SELECT 1 FROM ts_order_items i WHERE i.order_id = o.order_id)
        ORDER BY o.order_date DESC LIMIT $3::int`,
      [from, to, cap]
    )).rows.map((r) => r.order_id);

    const pending = num((await pool.query(
      `SELECT count(*)::int AS n FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          AND NOT EXISTS (SELECT 1 FROM ts_order_items i WHERE i.order_id = o.order_id)`,
      [from, to]
    )).rows[0].n);

    let fetched = 0, skipped = 0, failed = 0, items = 0;
    const errors = [];
    for (let n2 = 0; n2 < targets.length; n2++) {
      const id = targets[n2];
      if (n2 > 0) await sleep(BACKFILL_THROTTLE_MS);
      try {
        const rows = await ts.fetchOrderProducts(id);
        if (!rows || !rows.length) { skipped++; continue; }
        for (let i = 0; i < rows.length; i++) {
          const it = rows[i];
          await pool.query(
            `INSERT INTO ts_order_items (order_id, idx, name, qty, amount, note)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (order_id, idx) DO UPDATE SET
               name=EXCLUDED.name, qty=EXCLUDED.qty, amount=EXCLUDED.amount, note=EXCLUDED.note`,
            [id, i, it.name, it.qty, it.amount, it.note || ""]
          );
        }
        fetched++; items += rows.length;
      } catch (e) {
        failed++;
        if (errors.length < 5) errors.push(`${id}: ${String(e?.message || e)}`);
      }
    }

    return c.json({
      ok: true, from, to, cap,
      fetched, skipped, failed, items,
      attempted: targets.length,
      // Orders still missing items BEFORE this run — lets the UI show progress
      // and decide whether to call again.
      remainingBefore: pending,
      remainingAfter: Math.max(0, pending - fetched),
      errors,
    });
  });
}

export default { register };
