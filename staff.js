/* ═══════════════════════════════════════════════════════════════════════════
   STAFF — the per-employee POS station.

   Registered by index.js via `register(app, ctx)`.

   Why this module exists: the cashier station used to be ONE screen behind ONE
   shared PIN, so every tagged order was credited to "the cashier" and nobody
   could be coached. TabSense already records WHO rang each order
   (`ts_orders.staff_name`), so we give each employee their own short PIN, show
   them only the orders THEY rang, and score them on their own numbers.

   The old shared-PIN flow (`/api/auth/cashier`, `/api/cashier/*`) is left
   untouched and keeps working — this module is additive.

   ── Business rules that shape every query here ─────────────────────────────
   1. THE BUSINESS DAY IS NOT THE CALENDAR DAY. The kitchen runs until ~03:00,
      so TabSense books a 01:30 order onto the PREVIOUS day. `calendar_day` is
      TabSense's own business day — we always GROUP BY it and never re-derive
      a day from `order_date`. "Today" is derived from a 04:00 Riyadh rollover.
   2. VOID AND REFUND ORDERS DO NOT COUNT. A void never happened; a refund is
      the reversal of an order already counted on its own day.
   3. SCORING DENOMINATOR = IN-RESTAURANT ORDERS ONLY. A delivery-aggregator
      order (order_type 'External', or an aggregator payment method) arrives
      with no customer standing at the counter, so there is no phone number and
      no "how did you hear about us?" the cashier could possibly have captured.
      Counting those orders against an employee would punish them for the
      channel mix of the day, which they do not control — so they are EXCLUDED
      from the denominator, not counted as misses.
   4. MONEY IS VAT-INCLUSIVE — only `total`, `gross_incl`, `discount_incl`.

   Auth: `Authorization: Bearer staff:<id>:<pin>`. The admin token is accepted
   everywhere a manager would be, so Omar can see any employee's station.
═══════════════════════════════════════════════════════════════════════════ */

import { randomInt, randomBytes } from "node:crypto";

const TZ = "Asia/Riyadh";
// Hour (Riyadh local) at which TabSense rolls the business day over. See rule 1.
const BIZ_DAY_START_HOUR = 4;
// The business day we are currently inside.
const BIZ_TODAY = `(((now() AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date)`;

// Same vocabulary the shared cashier station posts, so a station switched over
// to per-employee login produces rows analytics already understands.
const STAFF_SOURCES = [
  "facebook", "instagram", "tiktok", "snapchat", "google_maps", "influencer",
  "friend", "walkin", "old_customer", "delivery_app", "other", "skipped",
];
const ROLES = ["cashier", "manager"];

// Targets the coaching engine measures against. Same numbers the owner quotes.
const TARGET_SOURCE_RATE = 0.9;
const TARGET_IDENTIFY_RATE = 0.9;
const MAX_SKIP_RATE = 0.1;
// A "streak day" is a business day the employee worked at >= 80% source tagging.
const STREAK_THRESHOLD = 0.9;
const STREAK_LOOKBACK_DAYS = 120;

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
// A rate with no denominator is UNKNOWN, not zero and not Infinity — an
// employee who rang no in-restaurant orders has no attach rate to judge.
const rate = (n, d) => (d > 0 ? n / d : null);
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : dflt;
};
// Hono's c.json() hands back a real Response; that is how the require* helpers
// signal "stop, I already built the error".
const isResponse = (x) => typeof Response !== "undefined" && x instanceof Response;

const newId = () => `st_${randomBytes(5).toString("hex")}`;
const newPin = () => String(randomInt(1000, 10000));

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const {
    pool, requireAdmin, getSettingsData, todayISO, daysAgoISO, normPhone,
    DEFAULT_DELIVERY_APPS,
  } = ctx;

  /* ─── Schema + first-boot seeding ───────────────────────────────────────── */

  async function ensureStaffSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pin TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'cashier',      -- cashier | manager
        tabsense_name TEXT NOT NULL DEFAULT '',    -- maps to ts_orders.staff_name
        active BOOL NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS staff_accounts_tsname_idx ON staff_accounts(tabsense_name);
    `);

    // Seed ONCE, on a genuinely empty table. Re-seeding on every boot would
    // resurrect accounts the owner deliberately deleted.
    const existing = await pool.query("SELECT count(*)::int AS n FROM staff_accounts");
    if (existing.rows[0].n > 0) return;

    const names = (await pool.query(
      `SELECT DISTINCT staff_name FROM ts_orders
        WHERE staff_name IS NOT NULL AND btrim(staff_name) <> ''
        ORDER BY 1`
    )).rows.map((r) => String(r.staff_name).trim());

    if (!names.length) {
      console.log("[staff] no staff_name values in ts_orders yet — nothing seeded");
      return;
    }
    // This is the ONLY place a PIN is ever printed: the owner needs to read the
    // log once to hand each employee their number. No endpoint and no later log
    // line repeats it — the admin accounts endpoint is the way to look it up.
    for (const name of names) {
      const id = newId();
      const pin = newPin();
      await pool.query(
        `INSERT INTO staff_accounts (id, name, pin, role, tabsense_name, active)
         VALUES ($1,$2,$3,'cashier',$4,true)`,
        [id, name, pin, name]
      );
      console.log(`[staff] seeded account — name="${name}" id=${id} pin=${pin}`);
    }
    console.log(`[staff] seeded ${names.length} account(s) from ts_orders.staff_name — hand out the PINs above, they are never logged again`);
  }

  /* ─── Scope helpers ─────────────────────────────────────────────────────── */

  async function deliveryApps() {
    const s = await getSettingsData();
    const list = Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length
      ? s.deliveryAppMethods
      : DEFAULT_DELIVERY_APPS;
    return list.map((x) => String(x).toLowerCase());
  }

  // Business rules 2 + 3, as one WHERE fragment. `o` is the ts_orders alias,
  // `appsParam` the $n holding the aggregator payment-method list.
  const scorableSql = (appsParam) => `
        COALESCE(o.order_type,'') NOT ILIKE '%void%'
    AND COALESCE(o.order_type,'') NOT ILIKE '%refund%'
    AND COALESCE(o.order_type,'') NOT ILIKE '%external%'
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY(${appsParam}))`;

  // The three things an employee is measured on, as SQL aggregates.
  //   identified   — we ended up with a customer identity on the order, either
  //                  because the POS had one or because the cashier typed a phone
  //   source_tagged— "how did you hear about us?" was answered (not skipped)
  //   skipped      — the cashier explicitly pressed skip
  const METRIC_AGGS = `
    count(*)::int AS orders,
    COALESCE(sum(o.total),0) AS revenue,
    count(*) FILTER (WHERE o.customer_id IS NOT NULL OR COALESCE(s.phone_norm,'') <> '')::int AS identified,
    count(*) FILTER (WHERE s.order_id IS NOT NULL AND s.source <> 'skipped')::int AS source_tagged,
    count(*) FILTER (WHERE s.source = 'skipped')::int AS skipped`;

  const shapeAgg = (r) => {
    const orders = r.orders || 0;
    return {
      orders,
      revenue: num(r.revenue),
      avgOrder: orders > 0 ? num(r.revenue) / orders : null,
      identified: r.identified || 0,
      identifyRate: rate(r.identified || 0, orders),
      sourceTagged: r.source_tagged || 0,
      sourceRate: rate(r.source_tagged || 0, orders),
      skipped: r.skipped || 0,
      skipRate: rate(r.skipped || 0, orders),
    };
  };

  // Per-employee aggregates for a window, keyed by ts_orders.staff_name.
  // Used by the score ranking and by the leaderboard, so both always agree.
  async function perStaffAgg(from, to, apps) {
    const rows = (await pool.query(
      `SELECT NULLIF(btrim(o.staff_name),'') AS staff, ${METRIC_AGGS}
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date
          AND NULLIF(btrim(o.staff_name),'') IS NOT NULL
          AND ${scorableSql("$3")}
        GROUP BY 1`,
      [from, to, apps]
    )).rows;
    const map = new Map();
    for (const r of rows) map.set(r.staff, { staff: r.staff, ...shapeAgg(r) });
    return map;
  }

  /* ─── Auth ──────────────────────────────────────────────────────────────── */

  const unauthorized = (c) =>
    c.json({ ok: false, error: "unauthorized", message: "الاسم أو الرقم السري غير صحيح" }, 401);

  // The admin token is a manager everywhere. Gives Omar the same station the
  // staff see without needing a staff PIN of his own.
  const ADMIN_AS_MANAGER = {
    id: "admin", name: "المدير", pin: "", role: "manager",
    tabsense_name: "", active: true, isAdmin: true,
  };

  /**
   * Resolve the caller to a staff row, or return a 401 JSON Response.
   * Accepts `Bearer staff:<id>:<pin>` and the admin token (as a manager).
   */
  async function requireStaff(c) {
    const h = c.req.header("Authorization") || "";
    if (h.startsWith("Bearer staff:")) {
      // The PIN may not contain ':' (digits only), so split off the first two parts.
      const rest = h.slice("Bearer staff:".length);
      const i = rest.indexOf(":");
      if (i > 0) {
        const id = rest.slice(0, i);
        const pin = rest.slice(i + 1);
        const r = await pool.query(
          "SELECT * FROM staff_accounts WHERE id = $1 AND active = true",
          [id]
        );
        if (r.rowCount && pin && String(r.rows[0].pin) === String(pin)) return r.rows[0];
      }
      return unauthorized(c);
    }
    // Not a staff token — fall back to the admin token.
    const adminErr = await requireAdmin(c);
    if (!adminErr) return ADMIN_AS_MANAGER;
    return unauthorized(c);
  }

  const isManager = (staff) => staff.role === "manager" || staff.isAdmin === true;
  // The name to match against ts_orders.staff_name. Empty means "matches
  // nothing" — an account with no TabSense mapping must NOT silently see
  // everybody's orders.
  const tsName = (staff) => String(staff.tabsense_name || "").trim();

  const publicStaff = (s) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    tabsenseName: s.tabsense_name || "",
    active: s.active !== false,
  });

  /* ─── POST /api/staff/login ─────────────────────────────────────────────── */
  // {name|id, pin} → {ok, staff, token}. A wrong PIN and an unknown name give
  // the exact same 401 body, so the screen can never be used to enumerate who
  // works here.
  app.post("/api/staff/login", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const key = String(b.id || b.name || "").trim();
    const pin = String(b.pin || "").trim();
    if (!key || !pin) return unauthorized(c);

    const r = await pool.query(
      `SELECT * FROM staff_accounts
        WHERE active = true
          AND (id = $1 OR lower(btrim(name)) = lower($1) OR lower(btrim(tabsense_name)) = lower($1))
        ORDER BY (id = $1) DESC
        LIMIT 1`,
      [key]
    );
    if (!r.rowCount || String(r.rows[0].pin) !== pin) return unauthorized(c);

    const s = r.rows[0];
    return c.json({
      ok: true,
      staff: { id: s.id, name: s.name, role: s.role },
      token: `staff:${s.id}:${s.pin}`,
    });
  });

  /* ─── GET /api/staff/me ─────────────────────────────────────────────────── */
  // Profile + today's numbers, so the station can greet the employee with
  // "you rang 14 orders today, tagged 11".
  app.get("/api/staff/me", async (c) => {
    const staff = await requireStaff(c); if (isResponse(staff)) return staff;
    const apps = await deliveryApps();
    const mine = tsName(staff);
    // `me` is personal: a manager who also rings orders sees THEIR OWN numbers
    // here (the queue is the place they see everybody's work). Only a manager
    // with no POS mapping at all — e.g. the admin token — falls back to totals.
    const all = isManager(staff) && !mine;

    const today = (await pool.query(
      `SELECT ${BIZ_TODAY} AS day, ${METRIC_AGGS}
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day = ${BIZ_TODAY}
          AND ($1::bool OR btrim(o.staff_name) = $2)
          AND ${scorableSql("$3")}`,
      [all, mine, apps]
    )).rows[0];

    // How much work is still sitting in their queue right now.
    const pending = (await pool.query(
      `SELECT count(*)::int AS n
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.order_id IS NULL
          AND o.order_date >= NOW() - interval '48 hours'
          AND ($1::bool OR btrim(o.staff_name) = $2)`,
      [all, mine]
    )).rows[0].n;

    return c.json({
      ok: true,
      staff: publicStaff(staff),
      scope: all ? "all" : "own",
      today: { day: isoDay(today.day), ...shapeAgg(today) },
      pending,
    });
  });

  /* ─── GET /api/staff/queue?hours=48 ─────────────────────────────────────── */
  // Same shape as /api/cashier/queue (the existing station UI renders it
  // as-is), but scoped to the orders THIS employee rang. A manager sees all.
  app.get("/api/staff/queue", async (c) => {
    const staff = await requireStaff(c); if (isResponse(staff)) return staff;
    const settings = await getSettingsData();
    const hours = clampInt(c.req.query("hours"), 1, 168, 48);
    const mine = tsName(staff);
    const all = isManager(staff);

    const pending = (await pool.query(
      `SELECT o.order_id, o.receipt, o.order_date, o.calendar_day, o.order_option, o.order_type,
              o.total, o.discount_incl AS discount, o.gross_incl, o.payments, o.customer_id, o.staff_name,
              tc.name AS customer_name, tc.phone AS customer_phone
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
        WHERE s.order_id IS NULL
          AND o.order_date >= NOW() - ($1 || ' hours')::interval
          AND ($2::bool OR btrim(o.staff_name) = $3)
        ORDER BY o.order_date DESC LIMIT 100`,
      [String(hours), all, mine]
    )).rows.map((r) => ({
      orderId: r.order_id,
      receipt: r.receipt || "",
      orderDate: r.order_date,
      day: isoDay(r.calendar_day),
      orderOption: r.order_option || "",
      orderType: r.order_type || "",
      total: num(r.total),
      discount: num(r.discount),
      grossIncl: num(r.gross_incl),
      customerName: r.customer_name || "",
      customerPhone: r.customer_phone || "",
      hasCustomer: !!r.customer_id,
      staffName: r.staff_name || "",
      // POS bug: aggregator orders are logged as Dine-in, so order_option
      // lies. order_type 'External' and the aggregator payment method are the
      // only reliable delivery signals.
      deliveryApp: ctx.deliveryAppOf(r.payments, settings)
        || (/external/i.test(r.order_type || "") ? "Feedus" : null),
    }));

    // Today's progress, scoped the same way. `filled_by` may be the legacy
    // shared-station 'cashier' or the new 'staff:<id>' — both are human work.
    const stats = (await pool.query(
      `SELECT count(*)::int AS today_orders,
              count(*) FILTER (WHERE s.filled_by = 'cashier' OR s.filled_by LIKE 'staff:%')::int AS today_tagged,
              count(*) FILTER (WHERE s.filled_by IN ('auto','feedus'))::int AS today_auto,
              count(*) FILTER (WHERE s.order_id IS NULL)::int AS today_pending
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day = ${BIZ_TODAY}
          AND ($1::bool OR btrim(o.staff_name) = $2)`,
      [all, mine]
    )).rows[0];

    return c.json({
      ok: true,
      pending,
      stats: {
        today_orders: stats.today_orders,
        today_tagged: stats.today_tagged,
        today_auto: stats.today_auto,
        today_pending: stats.today_pending,
      },
      scope: all ? "all" : "own",
      staff: publicStaff(staff),
    });
  });

  /* ─── POST /api/staff/submit ────────────────────────────────────────────── */
  // {orderId, source, note?, customerKind?, customerName?, customerPhone?}
  app.post("/api/staff/submit", async (c) => {
    const staff = await requireStaff(c); if (isResponse(staff)) return staff;
    const b = await c.req.json().catch(() => ({}));
    const orderId = String(b.orderId || "").trim();
    const source = String(b.source || "");
    if (!orderId || !STAFF_SOURCES.includes(source)) {
      return c.json({ ok: false, error: "orderId + valid source required", message: "اختر مصدر العميل أولاً" }, 400);
    }

    const own = await pool.query(
      "SELECT order_id, btrim(COALESCE(staff_name,'')) AS staff_name FROM ts_orders WHERE order_id = $1",
      [orderId]
    );
    if (!own.rowCount) {
      return c.json({ ok: false, error: "order_not_found", message: "الطلب غير موجود" }, 404);
    }
    // You may only tag what you rang. Managers tag anything.
    if (!isManager(staff) && own.rows[0].staff_name !== tsName(staff)) {
      return c.json({ ok: false, error: "not_your_order", message: "هذا الطلب ليس من طلباتك" }, 403);
    }

    // Cashier-captured identity: TabSense often has no customer on the order,
    // so the phone typed here is what makes new-vs-returning measurable.
    const name = String(b.customerName || "").trim();
    const phone = String(b.customerPhone || "").trim();
    const pn = normPhone(phone);
    const filledBy = staff.isAdmin ? "admin" : `staff:${staff.id}`;

    await pool.query(
      `INSERT INTO order_sources (order_id, source, source_note, customer_kind, filled_by, filled_at,
                                  customer_name, customer_phone, phone_norm)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8)
       ON CONFLICT (order_id) DO UPDATE SET
         source=EXCLUDED.source, source_note=EXCLUDED.source_note,
         customer_kind=EXCLUDED.customer_kind, filled_by=EXCLUDED.filled_by, filled_at=NOW(),
         customer_name=EXCLUDED.customer_name, customer_phone=EXCLUDED.customer_phone,
         phone_norm=EXCLUDED.phone_norm`,
      [orderId, source, String(b.note || ""), String(b.customerKind || "unknown"),
       filledBy, name, phone, pn]
    );

    // Was this phone seen before (TabSense directory or an earlier tag)? Lets
    // the station tell the employee "returning customer" on the spot.
    let seenBefore = null;
    if (pn) {
      const r = await pool.query(
        `SELECT (SELECT count(*)::int FROM ts_customers WHERE phone_norm = $1) AS in_directory,
                (SELECT count(*)::int FROM order_sources WHERE phone_norm = $1 AND order_id <> $2) AS earlier_orders`,
        [pn, orderId]
      );
      seenBefore = r.rows[0].in_directory > 0 || r.rows[0].earlier_orders > 0;
    }
    return c.json({ ok: true, seenBefore, filledBy });
  });

  /* ─── GET /api/staff/score?days=7 ───────────────────────────────────────── */
  app.get("/api/staff/score", async (c) => {
    const staff = await requireStaff(c); if (isResponse(staff)) return staff;
    // Accept an explicit range too. Reporting a 7-day window under a `period`
    // block the caller did not ask for is worse than an error — it looks right.
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    const qFrom = c.req.query("from"), qTo = c.req.query("to");
    const days = clampInt(c.req.query("days"), 1, 365, 7);
    const from = isDate(qFrom) ? qFrom : daysAgoISO(days - 1);
    const to = isDate(qTo) ? qTo : todayISO();
    const apps = await deliveryApps();
    const mine = tsName(staff);

    // An account with no TabSense mapping has nothing to score — say so
    // honestly instead of returning zeros that look like bad performance.
    if (!mine) {
      const hint = isManager(staff)
        ? "هذا حساب إداري بدون اسم على الكاشير — شوف لوحة الترتيب لمتابعة الفريق."
        : "حسابك غير مرتبط باسمك على الكاشير — كلّم المدير عشان يربطه.";
      return c.json({
        ok: true, staff: publicStaff(staff), period: { from, to, days },
        orders: 0, identified: 0, identifyRate: null, sourceTagged: 0, sourceRate: null,
        skipped: 0, revenue: 0, avgOrder: null,
        rank: { identify: null, source: null, of: 0 },
        trend: [], streak: 0,
        weakest: { metric: "unmapped", value: null, hint },
      });
    }

    const totals = shapeAgg((await pool.query(
      `SELECT ${METRIC_AGGS}
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date
          AND btrim(o.staff_name) = $3
          AND ${scorableSql("$4")}`,
      [from, to, mine, apps]
    )).rows[0]);

    // Day-by-day, business days only (rule 1). Days off simply have no row.
    const trend = (await pool.query(
      `SELECT o.calendar_day AS day, ${METRIC_AGGS}
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date
          AND btrim(o.staff_name) = $3
          AND ${scorableSql("$4")}
        GROUP BY 1 ORDER BY 1`,
      [from, to, mine, apps]
    )).rows.map((r) => {
      const a = shapeAgg(r);
      return { day: isoDay(r.day), orders: a.orders, identifyRate: a.identifyRate, sourceRate: a.sourceRate };
    });

    // Streak: consecutive WORKED business days, newest first, at >= 80% source
    // tagging. Computed over a long lookback so a short ?days window can never
    // truncate a streak the employee actually earned. Gaps-and-islands: the
    // streak is (position of the first failing day) - 1.
    const streak = (await pool.query(
      `WITH per_day AS (
         SELECT o.calendar_day AS day,
                count(*)::int AS orders,
                count(*) FILTER (WHERE s.order_id IS NOT NULL AND s.source <> 'skipped')::int AS tagged
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date
            AND btrim(o.staff_name) = $3
            AND ${scorableSql("$4")}
          GROUP BY 1
       ), ranked AS (
         SELECT row_number() OVER (ORDER BY day DESC) AS rn,
                (tagged::numeric / NULLIF(orders,0)) >= ${STREAK_THRESHOLD} AS ok
           FROM per_day
       )
       SELECT COALESCE(
                (SELECT min(rn) FROM ranked WHERE ok IS NOT TRUE),
                (SELECT count(*) + 1 FROM ranked)
              )::int - 1 AS streak`,
      [daysAgoISO(STREAK_LOOKBACK_DAYS), to, mine, apps]
    )).rows[0].streak;

    // Rank against everyone who rang an in-restaurant order in the window.
    // Employees with no orders are not ranked at all (no denominator).
    const agg = await perStaffAgg(from, to, apps);
    const field = agg.get(mine);
    const contenders = [...agg.values()].filter((x) => x.orders > 0);
    const rankBy = (key) => {
      if (!field || field.orders === 0 || field[key] === null) return null;
      // 1 + how many people beat you on this metric.
      return 1 + contenders.filter((x) => x[key] !== null && x[key] > field[key]).length;
    };

    return c.json({
      ok: true,
      staff: publicStaff(staff),
      period: { from, to, days },
      orders: totals.orders,
      identified: totals.identified,
      identifyRate: totals.identifyRate,
      sourceTagged: totals.sourceTagged,
      sourceRate: totals.sourceRate,
      skipped: totals.skipped,
      revenue: totals.revenue,
      avgOrder: totals.avgOrder,
      rank: { identify: rankBy("identifyRate"), source: rankBy("sourceRate"), of: contenders.length },
      trend,
      weakest: weakestOf(totals),
      streak,
    });
  });

  /* ─── GET /api/staff/missing-orders?from&to&staff= ───────────────────────
     The specific tickets behind a low score. A percentage tells an employee
     they are short; the receipt number, the time and the amount tell them
     exactly which orders to think about — that is what makes it actionable
     rather than an accusation. Same scorable filter as the score itself, so
     delivery-app orders can never appear here.                              */
  app.get("/api/staff/missing-orders", async (c) => {
    const staff = await requireStaff(c); if (isResponse(staff)) return staff;
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    const qFrom = c.req.query("from"), qTo = c.req.query("to");
    const days = clampInt(c.req.query("days"), 1, 365, 1);
    const from = isDate(qFrom) ? qFrom : daysAgoISO(days - 1);
    const to = isDate(qTo) ? qTo : todayISO();
    const apps = await deliveryApps();
    // A cashier sees only their own; a manager sees everyone, or one person.
    const who = staff.role === "manager" ? (c.req.query("staff") || null) : staff.tabsense_name;
    const limit = clampInt(c.req.query("limit"), 1, 500, 200);

    const rows = (await pool.query(
      `SELECT COALESCE(NULLIF(o.staff_name,''),'(غير معروف)') AS staff_name,
              o.order_id, o.receipt, o.order_date, o.total, o.calendar_day,
              (o.customer_id IS NOT NULL OR COALESCE(s.phone_norm,'') <> '') AS has_customer,
              (s.order_id IS NOT NULL AND s.source <> 'skipped') AS has_source
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date
          AND ${scorableSql("$3::text[]")}
          AND ($4::text IS NULL OR o.staff_name = $4)
          AND NOT (
            (o.customer_id IS NOT NULL OR COALESCE(s.phone_norm,'') <> '')
            AND (s.order_id IS NOT NULL AND s.source <> 'skipped'))
        ORDER BY o.order_date DESC
        LIMIT $5`,
      [from, to, apps, who, limit]
    )).rows;

    const byStaff = new Map();
    for (const r of rows) {
      const key = r.staff_name;
      if (!byStaff.has(key)) byStaff.set(key, { staff: key, missing: [] });
      const missing = [];
      if (!r.has_customer) missing.push("customer");
      if (!r.has_source) missing.push("source");
      byStaff.get(key).missing.push({
        orderId: r.order_id,
        receipt: r.receipt || "",
        day: r.calendar_day instanceof Date ? r.calendar_day.toISOString().slice(0, 10) : r.calendar_day,
        // Riyadh wall clock — the employee remembers the shift, not UTC.
        time: new Date(new Date(r.order_date).getTime() + 3 * 3600_000).toISOString().slice(11, 16),
        total: Number(r.total) || 0,
        missing,
        label: missing.length === 2 ? "بدون عميل وبدون مصدر"
          : missing[0] === "customer" ? "بدون بيانات عميل" : "بدون تسجيل مصدر",
      });
    }
    const out = [...byStaff.values()].sort((a, b) => b.missing.length - a.missing.length);
    return c.json({
      ok: true, from, to, scope: staff.role === "manager" ? "all" : "own",
      totalMissing: rows.length, staff: out,
    });
  });

  /* ─── GET /api/staff/leaderboard?days=7 ─────────────────────────────────── */
  // Every ACTIVE account that rang orders in the window, plus anyone who rang
  // orders without an account yet (so a new POS user is visible immediately).
  app.get("/api/staff/leaderboard", async (c) => {
    const staff = await requireStaff(c); if (isResponse(staff)) return staff;
    // Accept an explicit range too. Reporting a 7-day window under a `period`
    // block the caller did not ask for is worse than an error — it looks right.
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    const qFrom = c.req.query("from"), qTo = c.req.query("to");
    const days = clampInt(c.req.query("days"), 1, 365, 7);
    const from = isDate(qFrom) ? qFrom : daysAgoISO(days - 1);
    const to = isDate(qTo) ? qTo : todayISO();
    const apps = await deliveryApps();

    const accounts = (await pool.query(
      "SELECT id, name, role, tabsense_name, active FROM staff_accounts WHERE active = true"
    )).rows;
    const byTsName = new Map(
      accounts.filter((a) => String(a.tabsense_name || "").trim())
        .map((a) => [String(a.tabsense_name).trim(), a])
    );

    const agg = await perStaffAgg(from, to, apps);
    const rows = [...agg.values()]
      .filter((x) => x.orders > 0)
      .map((x) => {
        const acc = byTsName.get(x.staff) || null;
        return {
          id: acc ? acc.id : null,
          name: acc ? acc.name : x.staff,
          tabsenseName: x.staff,
          role: acc ? acc.role : null,
          hasAccount: !!acc,
          orders: x.orders,
          identified: x.identified,
          identifyRate: x.identifyRate,
          sourceTagged: x.sourceTagged,
          sourceRate: x.sourceRate,
          skipped: x.skipped,
          revenue: x.revenue,
          avgOrder: x.avgOrder,
          // Combined score out of 100: source tagging is the job we actually
          // ask for (60%), capturing an identity is the harder ask (40%).
          // A null rate contributes nothing rather than crashing the sort.
          score: Math.round((60 * (x.sourceRate ?? 0) + 40 * (x.identifyRate ?? 0)) * 10) / 10,
        };
      })
      .sort((a, b) => b.score - a.score || b.orders - a.orders);

    rows.forEach((r, i) => { r.rank = i + 1; });

    const me = tsName(staff);
    const youRow = rows.find((r) => r.tabsenseName === me) || null;
    return c.json({
      ok: true,
      period: { from, to, days },
      leaderboard: rows,
      you: youRow
        ? { id: staff.id, tabsenseName: me, rank: youRow.rank, score: youRow.score }
        : { id: staff.id, tabsenseName: me, rank: null, score: null },
    });
  });

  /* ─── Admin: account management ─────────────────────────────────────────── */

  app.get("/api/staff/accounts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    // PINs are returned here on purpose — this is the owner's only way to look
    // up a PIN after the one-time seed log. Admin token required.
    const rows = (await pool.query(
      `SELECT s.id, s.name, s.pin, s.role, s.tabsense_name, s.active, s.created_at,
              (SELECT count(*)::int FROM ts_orders o
                WHERE btrim(o.staff_name) = btrim(s.tabsense_name) AND btrim(s.tabsense_name) <> '') AS orders
         FROM staff_accounts s ORDER BY s.active DESC, s.name`
    )).rows.map((r) => ({
      id: r.id, name: r.name, pin: r.pin, role: r.role,
      tabsenseName: r.tabsense_name || "", active: r.active,
      createdAt: r.created_at, orders: r.orders,
    }));
    // Names on the POS that nobody has an account for yet.
    const unmapped = (await pool.query(
      `SELECT DISTINCT btrim(o.staff_name) AS name FROM ts_orders o
        WHERE btrim(COALESCE(o.staff_name,'')) <> ''
          AND NOT EXISTS (SELECT 1 FROM staff_accounts s
                           WHERE btrim(s.tabsense_name) = btrim(o.staff_name))
        ORDER BY 1`
    )).rows.map((r) => r.name);
    return c.json({ ok: true, accounts: rows, unmappedPosNames: unmapped });
  });

  // Create or update. Passing an existing `id` updates; omitting it creates.
  app.post("/api/staff/accounts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const id = String(b.id || "").trim();
    const name = String(b.name || "").trim();
    const pin = String(b.pin || "").trim();
    const role = ROLES.includes(String(b.role)) ? String(b.role) : "cashier";
    const tabsenseName = String(b.tabsenseName ?? b.tabsense_name ?? "").trim();
    const active = b.active === undefined ? true : !!b.active;

    if (pin && !/^\d{4,6}$/.test(pin)) {
      return c.json({ ok: false, error: "bad_pin", message: "الرقم السري لازم يكون من 4 إلى 6 أرقام" }, 400);
    }

    if (id) {
      const cur = await pool.query("SELECT * FROM staff_accounts WHERE id = $1", [id]);
      if (!cur.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      const r = (await pool.query(
        `UPDATE staff_accounts SET
           name = COALESCE(NULLIF($2,''), name),
           pin = COALESCE(NULLIF($3,''), pin),
           role = $4, tabsense_name = $5, active = $6
         WHERE id = $1 RETURNING *`,
        [id, name, pin, role, tabsenseName, active]
      )).rows[0];
      return c.json({ ok: true, account: { ...publicStaff(r), pin: r.pin } });
    }

    if (!name) return c.json({ ok: false, error: "name_required", message: "الاسم مطلوب" }, 400);
    const newAcc = (await pool.query(
      `INSERT INTO staff_accounts (id, name, pin, role, tabsense_name, active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId(), name, pin || newPin(), role, tabsenseName || name, active]
    )).rows[0];
    return c.json({ ok: true, account: { ...publicStaff(newAcc), pin: newAcc.pin } });
  });

  app.delete("/api/staff/accounts/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("DELETE FROM staff_accounts WHERE id = $1", [c.req.param("id")]);
    return c.json({ ok: true, deleted: r.rowCount });
  });

  /* ─── Boot ──────────────────────────────────────────────────────────────── */
  ensureStaffSchema()
    .then(() => console.log("[staff] schema ready"))
    .catch((e) => console.error("[staff] schema init failed:", e.message));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Coaching — name the ONE thing this employee should fix next.

   Each metric is compared to its target as a relative gap, so a 40%/80% source
   rate (gap 0.50) outranks a 50%/60% identify rate (gap 0.17): we point at the
   biggest miss, not the smallest raw number.
═══════════════════════════════════════════════════════════════════════════ */
function weakestOf(t) {
  if (!t.orders) {
    return { metric: "orders", value: 0, hint: "لا توجد طلبات في هذه الفترة — ابدأ التسجيل من أول وردية." };
  }
  const candidates = [
    {
      metric: "sourceRate", value: t.sourceRate, target: TARGET_SOURCE_RATE, higherIsBetter: true,
      hint: "اسأل كل عميل «عرفت عننا منين؟» وسجّل الإجابة قبل ما تقفل الفاتورة.",
    },
    {
      metric: "identifyRate", value: t.identifyRate, target: TARGET_IDENTIFY_RATE, higherIsBetter: true,
      hint: "خُد اسم ورقم جوال العميل مع كل طلب — دي أهم خطوة عشان نرجّعه تاني.",
    },
    {
      metric: "skipRate", value: t.skipRate, target: MAX_SKIP_RATE, higherIsBetter: false,
      hint: "بتضغط «تخطي» كتير — التخطي آخر حل، سجّل المصدر حتى لو تقريبي.",
    },
  ].filter((x) => x.value !== null);

  if (!candidates.length) return { metric: "sourceRate", value: null, hint: "لسه مفيش بيانات كافية للتقييم." };

  for (const x of candidates) {
    x.gap = x.higherIsBetter
      ? (x.target - x.value) / x.target      // how far BELOW target
      : (x.value - x.target) / x.target;     // how far ABOVE the allowed ceiling
  }
  candidates.sort((a, b) => b.gap - a.gap);
  const worst = candidates[0];
  if (worst.gap <= 0) {
    return { metric: worst.metric, value: worst.value, hint: "أداؤك فوق المستوى المطلوب في كل المؤشرات — حافظ عليه." };
  }
  return { metric: worst.metric, value: worst.value, hint: worst.hint };
}
