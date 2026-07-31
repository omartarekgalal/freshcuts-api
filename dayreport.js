/* ═══════════════════════════════════════════════════════════════════════════
   DAY REPORT — "what happened today?" in one request.

   Registered by index.js via `register(app, ctx)`. Admin-only, strictly
   read-only. Two endpoints:

     GET /api/day?date=YYYY-MM-DD   the whole day, one payload
     GET /api/day/available         which business days exist (last 120)

   Why this module exists: every number below already exists somewhere in
   /api/analytics/*, /api/staff/* or /api/marketing/*, but the owner had to
   open four tabs and mentally join them to answer "how did today go?". This
   endpoint answers it once, for today or for any past day, with the SAME
   business semantics as analytics.js — it deliberately mirrors that file's
   SQL fragments rather than inventing new ones, so the two can never disagree.

   ── Business rules that shape every query in this file ─────────────────────
   1. MONEY IS VAT-INCLUSIVE. TabSense reports gross/discount/net EXCLUDING
      VAT, but the receipt the customer holds is VAT-inclusive. We only ever
      read `total`, `gross_incl`, `discount_incl`. Never `gross`/`discount`.
   2. VOID AND REFUND ORDERS ARE EXCLUDED FROM SALES — a void never happened
      and a refund reverses an order already counted on its own day. They are
      NOT dropped though: they are counted separately in `summary.voids` /
      `summary.refunds`, because a spike in voids is exactly the kind of thing
      an owner opens this screen to notice.
   3. THE BUSINESS DAY IS NOT THE CALENDAR DAY. TabSense rolls the day over at
      04:00 Riyadh, so a 01:30 order belongs to the PREVIOUS day. We always
      group by `calendar_day` (TabSense is the authority) and never re-derive a
      day from a timestamp. Hour-of-day reporting still uses the real Riyadh
      wall clock, so a night shift reads as 12:00 → 03:00.
   4. LIKE-FOR-LIKE COMPARISON. When the requested day is TODAY it is only
      half finished, so every comparison day is cut at the same business-day
      elapsed offset. Comparing a partial day against a full one would report a
      collapse every single afternoon. For a past day the cutoff is 24h, i.e.
      full day vs full day.
   5. AN UNDEFINED RATIO IS `null`, never 0 and never Infinity — the UI must be
      able to render "—" instead of a fabricated -100%.
═══════════════════════════════════════════════════════════════════════════ */

const TZ = "Asia/Riyadh";
// Hour (Riyadh local) at which TabSense rolls the business day over. See rule 3.
const BIZ_DAY_START_HOUR = 4;

/* ── SQL fragments. Every one takes the ts_orders alias so the same rule can
      be reused inside a correlated subquery that already uses `o`. ───────── */

const localTs = (a = "o") => `(${a}.order_date AT TIME ZONE '${TZ}')`;
const bizTs = (a = "o") => `((${a}.order_date AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')`;
// Hours elapsed into the business day the order belongs to (0 → 24).
const bizElapsedH = (a = "o") => `(extract(epoch from (${bizTs(a)} - ${bizTs(a)}::date::timestamp)) / 3600.0)`;
const localHour = (a = "o") => `(extract(hour from ${localTs(a)})::int)`;
// Business rule 2. order_type values seen in the wild: 'Void', 'Refund',
// 'Void QR-Menu Orders' — hence the ILIKE match rather than an equality test.
const salesOnly = (a = "o") =>
  `(${a}.order_type IS NULL OR (${a}.order_type NOT ILIKE '%void%' AND ${a}.order_type NOT ILIKE '%refund%'))`;

// An order is a delivery-aggregator order when TabSense typed it 'External'
// (true from the moment it is created) OR when one of its payment methods is
// an aggregator wallet (only lands once the order is paid). Both signals are
// needed: the POS logs aggregator orders as Dine-in, so order_option lies.
const deliverySql = (appsParam, a = "o") =>
  `(${a}.order_type ILIKE '%external%' OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(${a}.payments) k WHERE lower(k) = ANY(${appsParam})))`;

// Which app an order came through. `order_sources.source_note` is the truth
// (filled by the FeedUs connector or the cashier); the aggregator payment
// method is the fallback, and 'external' means "delivery, app unknown".
// Requires an `order_sources s` join.
const channelSql = (appsParam, a = "o") => `
  CASE WHEN ${deliverySql(appsParam, a)} THEN
    lower(COALESCE(
      NULLIF(s.source_note, ''),
      (SELECT k FROM jsonb_object_keys(${a}.payments) k WHERE lower(k) = ANY(${appsParam}) LIMIT 1),
      'external'))
  ELSE 'inhouse' END`;

// Identity of the human behind an order. The cashier station's typed phone
// wins over the POS customer record because it is captured at the counter for
// orders TabSense attached no customer to.
const IDENT_SQL = `COALESCE(NULLIF(s.phone_norm, ''), NULLIF(tc.phone_norm, ''))`;

// First time we ever saw each phone, across BOTH identity sources — the same
// definition /api/analytics/compare uses, so "new customer" means the same
// thing on this screen as on the analytics screen.
const FIRSTS_CTE = `
  firsts AS (
    SELECT pn, min(first_at) AS first_at FROM (
      SELECT phone_norm AS pn, min(filled_at) AS first_at
        FROM order_sources WHERE phone_norm <> '' GROUP BY 1
      UNION ALL
      SELECT phone_norm AS pn, min(COALESCE(first_order_at, registered_at)) AS first_at
        FROM ts_customers WHERE phone_norm IS NOT NULL AND phone_norm <> '' GROUP BY 1
    ) u GROUP BY 1
  )`;

/* ── Labels. Keys stay English, everything the owner reads is Arabic. ────── */

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

// Vocabulary posted by the cashier station (index.js CASHIER_SOURCES) and by
// the per-employee station (staff.js STAFF_SOURCES); `untagged` is ours, for
// orders nobody answered "how did you hear about us?" on.
const SOURCE_LABELS = {
  facebook: "فيسبوك",
  instagram: "انستقرام",
  tiktok: "تيك توك",
  snapchat: "سناب شات",
  google_maps: "خرائط قوقل",
  influencer: "مشهور / مؤثر",
  friend: "صديق",
  walkin: "مارّ بالمحل",
  old_customer: "عميل قديم",
  delivery_app: "تطبيق توصيل",
  other: "أخرى",
  skipped: "تم التخطي",
  untagged: "غير مسجّل",
};
const srcLabel = (id) => SOURCE_LABELS[String(id || "").toLowerCase()] || id || "غير مسجّل";

const PLATFORM_LABELS = { tiktok: "تيك توك", meta: "ميتا", facebook: "فيسبوك", instagram: "انستقرام", snapchat: "سناب شات", google: "قوقل", other: "أخرى" };

/* ── Category heuristic ───────────────────────────────────────────────────
   HEURISTIC — READ BEFORE TRUSTING. TabSense gives us no category column on
   ts_order_items, only a free-text `name` typed by whoever built the POS menu.
   So we bucket by keyword. The menu is bilingual and inconsistently spelled
   ("مياه"/"مياة", "وجبة"/"وجبه", "Soft Drinks - can"/"مشروبات غازية - كان"),
   which is why names are normalised first (see `normName`) and why every
   bucket lists both the Arabic and the English keyword.

   FIRST MATCH WINS, so the order of this list is the whole design:
   - `توصيل` first: a delivery-fee line is not food and must never land in a
     food bucket.
   - `وجبات` before everything else food: "وجبة صدور مشوية" is sold as a meal,
     not as a grill portion, and the owner prices/thinks about it that way.
   - `حلويات` before `كريب`: a nutella crepe is a dessert to the customer.
   - `إضافات` LAST among the food-ish rules: modifier text ("1.0 حشو اطراف
     كيري", "1.0 مشروب + بطاطس") is appended to the parent item's own name, so
     testing for it early would file half the pizzas as add-ons.
   Anything that matches nothing at all lands in "أخرى" — that bucket growing
   is the signal that the map needs a new keyword, not that sales moved. ─── */
const CATEGORY_RULES = [
  ["توصيل", ["توصيل", "delivery"]],
  ["وجبات", ["وجبه", "meal", "صينيه"]],
  ["حلويات", ["نوتيلا", "nutella", "حلو", "نجرسكو", "negresco", "ايس كريم", "ice cream", "كيك", "cake", "بسبوسه", "كنافه"]],
  ["كريب", ["كريب", "crepe", "crep"]],
  ["بيتزا", ["بيتزا", "pizza"]],
  ["باستا", ["باستا", "pasta", "كازرول", "casserole", "الفريدو", "alfredo", "فتتوتشيني", "fettuccine", "بينا", "penne", "ماك اند تشيز", "mac and cheese", "سباجيتي", "spaghetti", "بشاميل", "bechamel", "béchamel"]],
  ["سندوتشات", ["برجر", "burger", "ساندوتش", "sandwich", "حواوشي", "hawawshi", "هوت دوج", "hot dog", "شاورما", "shawarma"]],
  ["مشروبات", ["مياه", "water", "بيبسي", "pepsi", "مشروبات", "soft drink", "عصير", "juice", "شاي", "قهوه", "coffee", "كولا", "cola", "سفن", "ميرندا"]],
  ["مقبلات وسلطات", ["بطاطس", "fries", "فرايز", "كلوسلو", "coleslaw", "حلقات بصل", "onion ring", "دوريتوس", "doritos", "سلطه", "سلطات", "salad", "موتزريلا", "mozzarella", "ارز", "rice", "مخلل", "خبز", "bread", "صوص", "sauce"]],
  ["مشاوي وأطباق", ["مشوي", "كباب", "kebab", "ريش", "kofta", "كفته", "طرب", "tarb", "شيش", "tawook", "مشكل", "كيلو", "كبده", "liver", "طبق", "سجق", "sausage", "فرايد تشيكن", "fried chicken", "دجاج", "chicken", "صدور", "فحم", "charcoal", "طاسه", "skillet", "سي فود", "seafood", "مشروم", "ملوخيه"]],
  ["إضافات", ["اضافه", "add", "كومبو", "كمبو", "combo", "حشو", "extra", "زياده"]],
];
const CATEGORY_OTHER = "أخرى";

// Arabic spelling is not stable in a POS menu: hamza forms, ة/ه and ى/ي are
// typed interchangeably. Fold them all so one keyword covers every spelling.
const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, "") // tashkeel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim();

function categoryOf(name) {
  const n = normName(name);
  if (!n) return CATEGORY_OTHER;
  for (const [label, keys] of CATEGORY_RULES) {
    for (const k of keys) if (n.includes(k)) return label;
  }
  return CATEGORY_OTHER;
}

/* ── small numeric / date helpers ────────────────────────────────────────── */

// pg returns NUMERIC and BIGINT as strings; everything user-facing goes
// through these so the JSON is always real numbers.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Totals carry float noise from TabSense (e.g. 2203.975249926) — round money.
const money = (v) => Math.round(num(v) * 100) / 100;
const qtyOf = (v) => Math.round(num(v) * 1000) / 1000;
const rate = (v) => (v === null || v === undefined ? null : Math.round(num(v) * 10000) / 10000);
// Business rule 5: no denominator means UNKNOWN, not zero.
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

// Arabic sentence fragments for highlights.
const pctTxt = (x) => `${Math.round(Math.abs(num(x)) * 100)}%`;
const sarTxt = (v) => `${Math.round(num(v))} ريال`;
const hhTxt = (h) => `${String(h).padStart(2, "0")}:00`;

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, DEFAULT_DELIVERY_APPS } = ctx;

  // Payment-method names that mean "delivery aggregator", overridable in settings.
  async function deliveryApps() {
    const s = await getSettingsData();
    const list = Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length
      ? s.deliveryAppMethods
      : DEFAULT_DELIVERY_APPS;
    return list.map((x) => String(x).toLowerCase());
  }

  // The business day we are currently inside + how many hours into it we are.
  // Both numbers come from Postgres, never from the Node clock, so the report
  // agrees with the rows it is reporting on even if the container drifts.
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
     GET /api/day?date=YYYY-MM-DD
     Default = the current business day. Everything below is aggregated in
     SQL and fired as ONE Promise.all round; the only follow-up query is the
     line items of the ten orders we ended up showing (keyed on those ids, so
     it is one extra query and never an N+1).
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/day", async (c) => {
    const err = await requireAdmin(c); if (err) return err;

    const apps = await deliveryApps();
    const { day: bizDay, elapsedH } = await bizNow();
    const date = dayArg(c.req.query("date"), bizDay);
    const isToday = date === bizDay;
    // Business rule 4: a finished day is compared whole; today is compared
    // only as far as it has actually run.
    const cutoff = isToday ? elapsedH : 24;

    const [
      dayAggRows,     // 0  target day + the 5 comparison days
      weekDayRows,    // 1  which of the 4 same-weekday days the shop operated
      voidRows,       // 2  voids / refunds on the target day
      voidBaseRows,   // 3  28-day void+refund baseline (for the spike highlight)
      hourRows,       // 4  hour-of-day, target vs same weekday x4
      recentRows,     // 5  last 10 orders
      itemRows,       // 6  every item sold on the day
      staffRows,      // 7  per-cashier performance
      sourceRows,     // 8  "how did you hear about us?" breakdown
      channelRows,    // 9  per-app / in-house split
      chBaseRows,     // 10 which channels have been alive the last 28 days
      custRows,       // 11 per-customer rows for the day
      dqRows,         // 12 data-quality coverage
      spendRows,      // 13 ad spend booked on this calendar day
      normRows,       // 14 28-day discount norm + 90-day revenue record
    ] = await Promise.all([
      /* 0 ── Target day and its five comparison days in a single pass, all cut
             at the same elapsed offset (business rule 4). */
      pool.query(
        `WITH scoped AS (
           SELECT o.calendar_day, o.total, o.discount_incl, o.gross_incl,
                  ${bizElapsedH()} AS eh,
                  ${deliverySql("$3::text[]")} AS is_delivery
             FROM ts_orders o
            WHERE o.calendar_day = ANY (ARRAY[
                    $1::date, $1::date - 1, $1::date - 7,
                    $1::date - 14, $1::date - 21, $1::date - 28])
              AND ${salesOnly()}
         )
         SELECT calendar_day AS day,
                count(*)::int AS orders,
                COALESCE(sum(total), 0) AS revenue,
                COALESCE(sum(discount_incl), 0) AS discount,
                COALESCE(sum(gross_incl), 0) AS gross_incl,
                count(*) FILTER (WHERE is_delivery)::int AS delivery_orders,
                COALESCE(sum(total) FILTER (WHERE is_delivery), 0) AS delivery_revenue,
                count(*) FILTER (WHERE NOT is_delivery)::int AS inhouse_orders,
                COALESCE(sum(total) FILTER (WHERE NOT is_delivery), 0) AS inhouse_revenue
           FROM scoped
          WHERE eh <= $2::numeric
          GROUP BY 1`,
        [date, cutoff, apps]
      ),
      /* 1 ── Denominator for the 4-week average = the same-weekday days the
             restaurant actually OPERATED, not the days that happen to have an
             order inside the elapsed window. Early in a business day most
             comparison days are legitimately empty, and averaging only the
             non-empty ones would drop real zeros and inflate the baseline;
             dividing by a hardcoded 4 would be wrong the other way once the
             cache stops reaching back a full month. */
      pool.query(
        `SELECT DISTINCT o.calendar_day AS day FROM ts_orders o
          WHERE o.calendar_day = ANY (ARRAY[$1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28])
            AND ${salesOnly()}`,
        [date]
      ),
      /* 2 ── Voids and refunds. Deliberately NOT filtered by salesOnly — this
             is the one place they are the subject, not noise. */
      pool.query(
        `SELECT count(*) FILTER (WHERE o.order_type ILIKE '%void%')::int AS voids,
                count(*) FILTER (WHERE o.order_type ILIKE '%refund%')::int AS refunds,
                COALESCE(sum(o.total) FILTER (WHERE o.order_type ILIKE '%refund%'), 0) AS refund_amount
           FROM ts_orders o
          WHERE o.calendar_day = $1::date AND ${bizElapsedH()} <= $2::numeric`,
        [date, cutoff]
      ),
      /* 3 ── How many voids+refunds a normal day carries, over the 28 days
             before this one. Used only to decide whether today is a spike. */
      pool.query(
        `SELECT count(*) FILTER (WHERE o.order_type ILIKE '%void%' OR o.order_type ILIKE '%refund%')::int AS n,
                count(DISTINCT o.calendar_day)::int AS days
           FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date - 28 AND $1::date - 1`,
        [date]
      ),
      /* 4 ── Hour of day. `hour` is the real Riyadh wall clock while the rows
             are selected by business day, so a night shift reads 12:00 → 03:00
             on one line instead of splitting at midnight. The baseline is the
             SAME WEEKDAY four times back, not a trailing 28-day mean: a
             Thursday 21:00 has nothing to learn from a Monday 21:00. */
      pool.query(
        `SELECT ${localHour()} AS hour,
                count(*) FILTER (WHERE o.calendar_day = $1::date)::int AS orders,
                COALESCE(sum(o.total) FILTER (WHERE o.calendar_day = $1::date), 0) AS revenue,
                COALESCE(sum(o.total) FILTER (WHERE o.calendar_day <> $1::date), 0) AS base_revenue
           FROM ts_orders o
          WHERE o.calendar_day = ANY (ARRAY[
                  $1::date, $1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28])
            AND ${salesOnly()}
          GROUP BY 1`,
        [date]
      ),
      /* 5 ── The last ten orders. Voids and refunds are INCLUDED here (and
             carry their `orderType`) precisely because "the order that just
             got voided" is what an owner opens this screen to see; they stay
             out of every money total above. */
      pool.query(
        `SELECT o.order_id, COALESCE(o.receipt, '') AS receipt,
                to_char(${localTs()}, 'HH24:MI') AS time,
                o.total, o.discount_incl,
                COALESCE(o.order_option, '') AS order_option,
                COALESCE(o.order_type, '') AS order_type,
                ${channelSql("$3::text[]")} AS channel,
                COALESCE(NULLIF(tc.name, ''), NULLIF(s.customer_name, ''), '') AS customer_name,
                (${IDENT_SQL} IS NOT NULL) AS has_customer,
                COALESCE(NULLIF(btrim(o.staff_name), ''), '') AS staff_name,
                COALESCE(s.source, '') AS source
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day = $1::date AND ${bizElapsedH()} <= $2::numeric
          ORDER BY o.order_date DESC
          LIMIT 10`,
        [date, cutoff, apps]
      ),
      /* 6 ── Every item sold on the day. Returned in full (not top-N) because
             `categories` has to bucket the whole day, not just the head. */
      pool.query(
        `SELECT i.name, sum(i.qty) AS qty, sum(i.amount) AS revenue,
                count(DISTINCT i.order_id)::int AS orders
           FROM ts_order_items i
           JOIN ts_orders o ON o.order_id = i.order_id
          WHERE o.calendar_day = $1::date AND ${salesOnly()} AND ${bizElapsedH()} <= $2::numeric
          GROUP BY 1`,
        [date, cutoff]
      ),
      /* 7 ── Per-cashier. `orders`/`revenue` are everything they rang, but the
             two RATES are scored only on in-restaurant orders: a delivery
             order arrives with nobody at the counter, so there is no phone and
             no "how did you hear about us?" the cashier could have captured.
             Counting those as misses would punish them for the day's channel
             mix, which they do not control — same rule staff.js scores on.
             The account name is looked up with a LIMIT 1 scalar subquery
             rather than a JOIN so a duplicated tabsense_name cannot multiply
             an employee's order count. */
      pool.query(
        `WITH scoped AS (
           SELECT btrim(o.staff_name) AS staff, o.total, o.customer_id,
                  s.order_id AS s_id, s.source, COALESCE(s.phone_norm, '') AS phone_norm,
                  NOT (${deliverySql("$3::text[]")}) AS scorable
             FROM ts_orders o
             LEFT JOIN order_sources s ON s.order_id = o.order_id
            WHERE o.calendar_day = $1::date AND ${salesOnly()} AND ${bizElapsedH()} <= $2::numeric
              AND NULLIF(btrim(o.staff_name), '') IS NOT NULL
         )
         SELECT COALESCE(
                  (SELECT NULLIF(btrim(sa.name), '') FROM staff_accounts sa
                    WHERE sa.tabsense_name = sc.staff LIMIT 1),
                  sc.staff) AS name,
                count(*)::int AS orders,
                COALESCE(sum(sc.total), 0) AS revenue,
                count(*) FILTER (WHERE sc.scorable)::int AS scorable_orders,
                count(*) FILTER (WHERE sc.scorable
                  AND (sc.customer_id IS NOT NULL OR sc.phone_norm <> ''))::int AS identified,
                count(*) FILTER (WHERE sc.scorable
                  AND sc.s_id IS NOT NULL AND sc.source <> 'skipped')::int AS source_tagged
           FROM scoped sc
          GROUP BY 1
          ORDER BY revenue DESC`,
        [date, cutoff, apps]
      ),
      /* 8 ── Source breakdown. Orders with no order_sources row at all are
             reported as an explicit `untagged` bucket instead of vanishing, so
             the rows always add up to the day's order count. */
      pool.query(
        `SELECT COALESCE(NULLIF(s.source, ''), 'untagged') AS source,
                count(*)::int AS orders,
                COALESCE(sum(o.total), 0) AS revenue
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day = $1::date AND ${salesOnly()} AND ${bizElapsedH()} <= $2::numeric
          GROUP BY 1
          ORDER BY 2 DESC`,
        [date, cutoff]
      ),
      /* 9 ── Channels on the day. */
      pool.query(
        `SELECT ${channelSql("$3::text[]")} AS ch,
                count(*)::int AS orders,
                COALESCE(sum(o.total), 0) AS revenue
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day = $1::date AND ${salesOnly()} AND ${bizElapsedH()} <= $2::numeric
          GROUP BY 1
          ORDER BY 3 DESC`,
        [date, cutoff, apps]
      ),
      /* 10 ── Channels that were alive over the previous 28 days. A channel
              missing from the day is only worth flagging if it normally
              produces something. */
      pool.query(
        `SELECT ${channelSql("$2::text[]")} AS ch,
                count(*)::int AS orders,
                count(DISTINCT o.calendar_day)::int AS days
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day BETWEEN $1::date - 28 AND $1::date - 1 AND ${salesOnly()}
          GROUP BY 1`,
        [date, apps]
      ),
      /* 11 ── One row per identified human on the day. `is_new` uses the same
              "first time we ever saw this phone" definition as
              /api/analytics/compare, folded onto the BUSINESS day. Orders with
              no phone at all are excluded from both sides rather than silently
              counted as new — dataQuality.customerCoverage is how the UI knows
              how big that hole is. */
      pool.query(
        `WITH scoped AS (
           SELECT o.order_id, o.total,
                  ${IDENT_SQL} AS ident,
                  COALESCE(NULLIF(tc.name, ''), NULLIF(s.customer_name, '')) AS cname,
                  COALESCE(NULLIF(tc.phone, ''), NULLIF(s.customer_phone, '')) AS cphone
             FROM ts_orders o
             LEFT JOIN order_sources s ON s.order_id = o.order_id
             LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
            WHERE o.calendar_day = $1::date AND ${salesOnly()} AND ${bizElapsedH()} <= $2::numeric
         ),
         ${FIRSTS_CTE}
         SELECT sc.ident,
                max(sc.cname) AS name,
                max(sc.cphone) AS phone,
                count(*)::int AS orders,
                COALESCE(sum(sc.total), 0) AS revenue,
                bool_or(((f.first_at AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date
                        >= $1::date) AS is_new
           FROM scoped sc LEFT JOIN firsts f ON f.pn = sc.ident
          WHERE sc.ident IS NOT NULL
          GROUP BY 1
          ORDER BY revenue DESC`,
        [date, cutoff]
      ),
      /* 12 ── How much of the day we actually know. Everything above is only
              as good as these three numbers, which is why they ship with the
              response instead of being assumed. */
      pool.query(
        `SELECT count(*)::int AS orders,
                count(*) FILTER (WHERE s.order_id IS NOT NULL)::int AS with_source,
                count(*) FILTER (WHERE o.customer_id IS NOT NULL
                  OR COALESCE(s.phone_norm, '') <> '')::int AS with_customer,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM ts_order_items i WHERE i.order_id = o.order_id))::int AS with_items
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day = $1::date AND ${salesOnly()} AND ${bizElapsedH()} <= $2::numeric`,
        [date, cutoff]
      ),
      /* 13 ── Ad spend. mk_entries is keyed by PLAIN calendar day (an ad
              platform has no idea what a restaurant business day is), so this
              is the one query that must not use calendar_day semantics. */
      pool.query(
        `SELECT COALESCE(NULLIF(c.platform, ''), 'other') AS platform,
                COALESCE(sum(e.spend), 0) AS spend
           FROM mk_entries e
           LEFT JOIN mk_campaigns c ON c.id = e.campaign_id
          WHERE e.day = $1::date
          GROUP BY 1
          ORDER BY 2 DESC`,
        [date]
      ),
      /* 14 ── Norms the highlights need: what discounting normally looks like
              (28 days) and the best day of the last 90, to decide whether this
              one is a record. Both windows END the day before the target day,
              so a day can never be compared against itself. */
      pool.query(
        `SELECT COALESCE(sum(o.discount_incl), 0) AS discount,
                COALESCE(sum(o.gross_incl), 0) AS gross_incl,
                (SELECT COALESCE(max(rev), 0) FROM (
                   SELECT sum(o2.total) AS rev FROM ts_orders o2
                    WHERE o2.calendar_day BETWEEN $1::date - 90 AND $1::date - 1
                      AND ${salesOnly("o2")}
                    GROUP BY o2.calendar_day) t) AS max_rev_90
           FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date - 28 AND $1::date - 1 AND ${salesOnly()}`,
        [date]
      ),
    ]);

    /* ── summary ─────────────────────────────────────────────────────────── */

    const byDay = new Map(dayAggRows.rows.map((r) => [isoDay(r.day), r]));
    const ZERO = {
      orders: 0, revenue: 0, discount: 0, gross_incl: 0,
      delivery_orders: 0, delivery_revenue: 0, inhouse_orders: 0, inhouse_revenue: 0,
    };
    const getDay = (iso) => byDay.get(iso) || ZERO;
    const t = getDay(date);

    const orders = num(t.orders);
    const revenue = money(t.revenue);

    const custs = custRows.rows.map((r) => ({
      name: r.name || "—",
      phone: r.phone || r.ident || "",
      orders: num(r.orders),
      revenue: money(r.revenue),
      isNew: !!r.is_new,
    }));
    const newCustomers = custs.filter((x) => x.isNew).length;

    const items = itemRows.rows.map((r) => ({
      name: r.name,
      qty: qtyOf(r.qty),
      revenue: money(r.revenue),
      orders: num(r.orders),
    }));
    const itemsSold = qtyOf(items.reduce((a, r) => a + r.qty, 0));
    const itemRevenue = items.reduce((a, r) => a + r.revenue, 0);

    // Hourly, always 24 slots so the UI can render a fixed axis.
    const weekDays = weekDayRows.rows.map((r) => isoDay(r.day));
    const hourMap = new Map(hourRows.rows.map((r) => [num(r.hour), r]));
    const hourly = [];
    for (let h = 0; h < 24; h++) {
      const r = hourMap.get(h) || {};
      hourly.push({
        hour: h,
        orders: num(r.orders),
        revenue: money(r.revenue),
        avgRevenue4w: weekDays.length ? money(num(r.base_revenue) / weekDays.length) : 0,
      });
    }
    // Busiest hour by orders, revenue breaking the tie. Undefined on an empty
    // day — null, not a misleading midnight (business rule 5).
    const peak = hourly.filter((x) => x.orders > 0)
      .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue)[0] || null;

    const v = voidRows.rows[0] || {};

    const summary = {
      orders,
      revenue,
      avgOrder: orders > 0 ? money(revenue / orders) : 0,
      discount: money(t.discount),
      // Discount as a share of the pre-discount VAT-inclusive menu price — the
      // only denominator where "we gave away 12%" actually means 12%.
      discountRatio: ratio(t.discount, t.gross_incl),
      uniqueCustomers: custs.length,
      newCustomers,
      returningCustomers: custs.length - newCustomers,
      deliveryOrders: num(t.delivery_orders),
      deliveryRevenue: money(t.delivery_revenue),
      inhouseOrders: num(t.inhouse_orders),
      inhouseRevenue: money(t.inhouse_revenue),
      voids: num(v.voids),
      refunds: num(v.refunds),
      refundAmount: money(v.refund_amount),
      itemsSold,
      peakHour: peak ? peak.hour : null,
    };

    /* ── compare ─────────────────────────────────────────────────────────── */

    const avg4 = weekDays.length
      ? {
        orders: weekDays.reduce((a, d) => a + num(getDay(d).orders), 0) / weekDays.length,
        revenue: weekDays.reduce((a, d) => a + num(getDay(d).revenue), 0) / weekDays.length,
      }
      : { orders: 0, revenue: 0 };

    const cmp = (key, label, base) => ({
      key, label,
      orders: Math.round(num(base.orders) * 100) / 100,
      revenue: money(base.revenue),
      deltaOrders: delta(orders, base.orders),
      deltaRevenue: delta(revenue, base.revenue),
    });
    const compare = [
      cmp("yesterday", "أمس", getDay(shiftDay(date, -1))),
      cmp("lastWeek", "نفس اليوم الأسبوع الماضي", getDay(shiftDay(date, -7))),
      cmp("avg4Weeks", "متوسط ٤ أسابيع", avg4),
    ];

    /* ── recent orders + their line items (one extra query, not an N+1) ──── */

    const recentIds = recentRows.rows.map((r) => r.order_id);
    const lineRows = recentIds.length
      ? (await pool.query(
        `SELECT order_id, name, qty, amount FROM ts_order_items
          WHERE order_id = ANY($1::text[]) ORDER BY order_id, idx`,
        [recentIds]
      )).rows
      : [];
    const linesByOrder = new Map();
    for (const r of lineRows) {
      if (!linesByOrder.has(r.order_id)) linesByOrder.set(r.order_id, []);
      linesByOrder.get(r.order_id).push({ name: r.name, qty: qtyOf(r.qty), amount: money(r.amount) });
    }
    const recentOrders = recentRows.rows.map((r) => ({
      orderId: r.order_id,
      receipt: r.receipt || "",
      time: r.time || "",
      total: money(r.total),
      discount: money(r.discount_incl),
      orderOption: r.order_option || "",
      orderType: r.order_type || "",
      channel: r.channel || "inhouse",
      channelLabel: chLabel(r.channel),
      customerName: r.customer_name || "",
      hasCustomer: !!r.has_customer,
      staffName: r.staff_name || "",
      source: r.source || "",
      sourceLabel: r.source ? srcLabel(r.source) : "",
      items: linesByOrder.get(r.order_id) || [],
    }));

    /* ── items, categories ───────────────────────────────────────────────── */

    const itemsOut = [...items]
      .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)
      .slice(0, 25)
      .map((r) => ({ ...r, share: ratio(r.revenue, itemRevenue) }));

    const catMap = new Map();
    for (const r of items) {
      const key = categoryOf(r.name);
      const cur = catMap.get(key) || { name: key, qty: 0, revenue: 0 };
      cur.qty += r.qty;
      cur.revenue += r.revenue;
      catMap.set(key, cur);
    }
    const categories = [...catMap.values()]
      .map((r) => ({ name: r.name, qty: qtyOf(r.qty), revenue: money(r.revenue), share: ratio(r.revenue, itemRevenue) }))
      .sort((a, b) => b.revenue - a.revenue);

    /* ── staff, sources, channels ────────────────────────────────────────── */

    const staff = staffRows.rows.map((r) => {
      const scorable = num(r.scorable_orders);
      return {
        name: r.name,
        orders: num(r.orders),
        revenue: money(r.revenue),
        scorableOrders: scorable,
        identified: num(r.identified),
        identifyRate: ratio(r.identified, scorable),
        sourceTagged: num(r.source_tagged),
        sourceRate: ratio(r.source_tagged, scorable),
      };
    });

    const sources = sourceRows.rows.map((r) => ({
      source: r.source,
      label: srcLabel(r.source),
      orders: num(r.orders),
      revenue: money(r.revenue),
    }));

    const channels = channelRows.rows.map((r) => {
      const o = num(r.orders);
      const rev = money(r.revenue);
      return {
        id: r.ch,
        label: chLabel(r.ch),
        orders: o,
        revenue: rev,
        avgOrder: o > 0 ? money(rev / o) : 0,
        share: ratio(rev, revenue),
      };
    });

    /* ── ad spend ────────────────────────────────────────────────────────── */

    const byPlatform = spendRows.rows.map((r) => ({
      platform: r.platform,
      label: PLATFORM_LABELS[String(r.platform).toLowerCase()] || r.platform,
      spend: money(r.spend),
    }));
    const spendTotal = money(byPlatform.reduce((a, r) => a + r.spend, 0));
    const adSpend = {
      total: spendTotal,
      byPlatform,
      // No spend booked means "we cannot tell", not "acquisition was free".
      costPerOrder: spendTotal > 0 && orders > 0 ? money(spendTotal / orders) : null,
    };

    /* ── data quality ────────────────────────────────────────────────────── */

    const dq = dqRows.rows[0] || {};
    const dataQuality = {
      sourceCoverage: ratio(dq.with_source, dq.orders),
      customerCoverage: ratio(dq.with_customer, dq.orders),
      itemCoverage: ratio(dq.with_items, dq.orders),
    };

    /* ── highlights ──────────────────────────────────────────────────────── */

    const norms = normRows.rows[0] || {};
    const vb = voidBaseRows.rows[0] || {};
    const highlights = buildHighlights({
      isToday, orders, revenue, summary, compare, peak, categories,
      // Best seller BY REVENUE, taken from the full item list rather than the
      // top-25-by-quantity slice: quantity would nominate bottled water every
      // single day, which tells the owner nothing.
      topItem: [...items].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)[0] || null,
      channels, chBase: chBaseRows.rows, staff, dataQuality, adSpend,
      normDiscountRatio: ratio(norms.discount, norms.gross_incl),
      maxRev90: money(norms.max_rev_90),
      voidBaseline: num(vb.days) > 0 ? num(vb.n) / num(vb.days) : null,
    });

    return c.json({
      ok: true,
      date,
      isToday,
      generatedAt: new Date().toISOString(),
      // How much of the business day the numbers cover, and what the
      // comparison rows were therefore cut at. Without this a client cannot
      // tell a quiet evening from a report pulled at 14:00.
      hoursElapsed: Math.round(cutoff * 100) / 100,
      summary,
      compare,
      hourly,
      recentOrders,
      items: itemsOut,
      categories,
      staff,
      sources,
      channels,
      customers: custs.slice(0, 20),
      adSpend,
      dataQuality,
      highlights,
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/day/available
     Which business days actually have sales, newest first, for the last 120.
     Lets the date picker skip the closed days instead of walking the owner
     through a week of empty screens.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/day/available", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { day: bizDay } = await bizNow();

    const rows = (await pool.query(
      `SELECT o.calendar_day AS day,
              count(*)::int AS orders,
              COALESCE(sum(o.total), 0) AS revenue
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date - 119 AND $1::date
          AND ${salesOnly()}
        GROUP BY 1
        ORDER BY 1 DESC`,
      [bizDay]
    )).rows;

    const days = rows.map((r) => ({
      date: isoDay(r.day),
      orders: num(r.orders),
      revenue: money(r.revenue),
    }));

    return c.json({
      ok: true,
      // minDate is the oldest day WITH data inside the window; maxDate is the
      // current business day even when it is still empty, because "today" must
      // always be a reachable destination in the picker.
      minDate: days.length ? days[days.length - 1].date : null,
      maxDate: bizDay,
      days,
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   HIGHLIGHTS — 3 to 6 short Arabic observations.

   Every line is computed from a value that is already in the response, so the
   owner can always point at the number that produced it. No generic advice, no
   "consider running a promotion". Rules are evaluated in priority order and
   the list is capped at MAX_HIGHLIGHTS.
═══════════════════════════════════════════════════════════════════════════ */

const MAX_HIGHLIGHTS = 6;
const MIN_HIGHLIGHTS = 3;
// Movement smaller than this is noise on a single restaurant day.
const MOVE_THRESHOLD = 0.15;
// Same 80% source-tagging target the staff module coaches against.
const TARGET_SOURCE_RATE = 0.9;
// Below this many orders a cashier's rate is not a signal, it is a small sample.
const MIN_ORDERS_TO_JUDGE = 5;
// Discounting is only remarkable when it is both well above the norm AND
// materially large — 1.5x of 0.4% is still nothing.
const DISCOUNT_SPIKE_FACTOR = 1.4;
const DISCOUNT_SPIKE_FLOOR = 0.03;
const VOID_SPIKE_FACTOR = 2;
const VOID_SPIKE_FLOOR = 3;
const LOW_COVERAGE = 0.8;

function buildHighlights(d) {
  const out = [];
  const push = (type, text) => { if (text) out.push({ type, text }); };

  // An empty day has exactly one honest thing to say.
  if (!d.orders) {
    return [{ type: "info", text: d.isToday ? "لا توجد طلبات بعد في هذا اليوم." : "لا توجد طلبات مسجّلة في هذا اليوم." }];
  }

  const partial = d.isToday ? " (حتى الآن)" : "";
  const yest = d.compare.find((x) => x.key === "yesterday");
  const avg4 = d.compare.find((x) => x.key === "avg4Weeks");

  /* 1. A record day beats everything else on the screen. */
  if (d.maxRev90 > 0 && d.revenue > d.maxRev90) {
    push("up", `أعلى مبيعات يومية خلال ٩٠ يوم: ${sarTxt(d.revenue)}${partial}.`);
  }

  /* 2. Where the day sits against a normal same-weekday. */
  if (avg4 && avg4.deltaRevenue !== null && Math.abs(avg4.deltaRevenue) >= MOVE_THRESHOLD) {
    const up = avg4.deltaRevenue > 0;
    push(up ? "up" : "down",
      `المبيعات ${up ? "أعلى" : "أقل"} من متوسط ٤ أسابيع بـ${pctTxt(avg4.deltaRevenue)} (${sarTxt(d.revenue)} مقابل ${sarTxt(avg4.revenue)})${partial}.`);
  } else if (yest && yest.deltaRevenue !== null && Math.abs(yest.deltaRevenue) >= MOVE_THRESHOLD) {
    const up = yest.deltaRevenue > 0;
    push(up ? "up" : "down",
      `المبيعات ${up ? "أعلى" : "أقل"} من أمس بـ${pctTxt(yest.deltaRevenue)} (${sarTxt(d.revenue)} مقابل ${sarTxt(yest.revenue)})${partial}.`);
  }

  /* 3. A void/refund spike — the reason voids are counted at all. */
  const badOrders = d.summary.voids + d.summary.refunds;
  if (badOrders >= VOID_SPIKE_FLOOR && d.voidBaseline !== null && badOrders > d.voidBaseline * VOID_SPIKE_FACTOR) {
    push("warn", `${badOrders} عملية إلغاء/استرجاع اليوم مقابل ${Math.round(d.voidBaseline * 10) / 10} في المتوسط اليومي — تستاهل مراجعة.`);
  }

  /* 4. A delivery app that normally works and produced nothing today. */
  const live = new Set(d.channels.filter((x) => x.orders > 0).map((x) => x.id));
  const silent = (d.chBase || [])
    .filter((r) => r.ch !== "inhouse" && num(r.days) >= 5 && !live.has(r.ch))
    .sort((a, b) => num(b.orders) - num(a.orders))[0];
  if (silent) {
    const perDay = Math.round((num(silent.orders) / num(silent.days)) * 10) / 10;
    push("warn", `${chLabel(silent.ch)} بدون أي طلب اليوم رغم متوسط ${perDay} طلب يوميًا آخر ٢٨ يوم.`);
  }

  /* 5. Discounting well above the recent norm. */
  const dr = d.summary.discountRatio;
  if (dr !== null && dr >= DISCOUNT_SPIKE_FLOOR
      && d.normDiscountRatio !== null && d.normDiscountRatio > 0
      && dr > d.normDiscountRatio * DISCOUNT_SPIKE_FACTOR) {
    push("warn", `نسبة الخصم اليوم ${pctTxt(dr)} مقابل ${pctTxt(d.normDiscountRatio)} كمعدل آخر ٢٨ يوم (${sarTxt(d.summary.discount)}).`);
  }

  /* 6. A cashier far below the 80% source-tagging target. */
  const laggard = d.staff
    .filter((s) => s.scorableOrders >= MIN_ORDERS_TO_JUDGE && s.sourceRate !== null && s.sourceRate < TARGET_SOURCE_RATE)
    .sort((a, b) => a.sourceRate - b.sourceRate)[0];
  if (laggard) {
    push("warn", `${laggard.name}: تسجيل مصدر العميل ${pctTxt(laggard.sourceRate)} من ${laggard.scorableOrders} طلب داخل المطعم — الهدف ${pctTxt(TARGET_SOURCE_RATE)}.`);
  }

  /* 7. Busiest hour. */
  if (d.peak) {
    push("info", `أعلى ساعة ${hhTxt(d.peak.hour)} بـ${d.peak.orders} طلب و${sarTxt(d.peak.revenue)}.`);
  }

  /* 8. New customers — a zero here on a busy day is itself the finding. */
  if (d.summary.newCustomers > 0) {
    push("info", `${d.summary.newCustomers} عميل جديد اليوم من أصل ${d.summary.uniqueCustomers} عميل معروف.`);
  } else if (d.summary.uniqueCustomers > 0) {
    push("warn", `لا يوجد أي عميل جديد اليوم — كل العملاء المعروفين (${d.summary.uniqueCustomers}) سبق لهم الشراء.`);
  }

  /* 9. Best seller, by the money it brought in. */
  if (d.topItem) {
    push("info", `الأعلى مبيعًا: ${d.topItem.name} بـ${sarTxt(d.topItem.revenue)} من ${qtyOf(d.topItem.qty)} قطعة.`);
  }

  /* 10. Channel mix. */
  const deliveryShare = d.revenue > 0 ? d.summary.deliveryRevenue / d.revenue : null;
  if (deliveryShare !== null && d.summary.deliveryOrders > 0) {
    push("info", `التوصيل ${pctTxt(deliveryShare)} من المبيعات (${d.summary.deliveryOrders} طلب) والباقي داخل المطعم.`);
  }

  /* 11. Ad efficiency, only when there is spend to divide. */
  if (d.adSpend.costPerOrder !== null) {
    push("info", `صرف إعلاني ${sarTxt(d.adSpend.total)} بتكلفة ${sarTxt(d.adSpend.costPerOrder)} لكل طلب.`);
  }

  /* 12. Trust caveat — last, because it qualifies everything above it. */
  if (d.dataQuality.itemCoverage !== null && d.dataQuality.itemCoverage < LOW_COVERAGE) {
    push("warn", `تغطية الأصناف ${pctTxt(d.dataQuality.itemCoverage)} فقط — أرقام الأصناف والفئات ناقصة.`);
  }

  // Guarantee the floor with facts that are always available on a non-empty
  // day, then cap. Order above is already priority order.
  if (out.length < MIN_HIGHLIGHTS) {
    push("info", `${d.orders} طلب بمتوسط ${sarTxt(d.summary.avgOrder)} للطلب${partial}.`);
  }
  if (out.length < MIN_HIGHLIGHTS && d.categories.length) {
    const topCat = d.categories[0];
    push("info", `أكبر فئة: ${topCat.name} بـ${sarTxt(topCat.revenue)}.`);
  }
  return out.slice(0, MAX_HIGHLIGHTS);
}

export default { register };
