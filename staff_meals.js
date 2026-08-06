/* ═══════════════════════════════════════════════════════════════════════════
   STAFF CONSUMPTION — two costs that were both invisible, kept apart on purpose.

   Registered by index.js via `register(app, ctx)`. Admin-only. Read-only over
   everybody else's tables; the only rows it writes are its own `sm_*`.

   ── THE TWO HALVES, AND WHY THEY MUST NEVER BE ADDED ──────────────────────

   A. STAFF PURCHASES AT 50%  →  /api/staff-purchases/*
      Staff and owners buy off the menu at half price. This is REVENUE GIVEN
      UP: the sale happened, the invoice exists, TabSense recorded it, and the
      money that did not arrive is already sitting in `ts_orders.discount_incl`.
      It is a discount line, not a cost line.

   B. STAFF DAILY MEALS       →  /api/staff-meals/*
      The kitchen feeds the staff every day and raises NO invoice at all. There
      is no order, no discount, no row anywhere — the food simply leaves the
      store. This is COGS, and until now it was invisible in every report.

   Adding them would double-count nothing and yet be wrong in both directions:
   A is revenue forgone at MENU price (VAT-inclusive), B is raw material
   consumed at PURCHASE price (VAT-exclusive). One riyal of A is not one riyal
   of B. Every payload below therefore carries an explicit `kind`, and the two
   are never summed anywhere in this file.

   ── BUSINESS RULES ─────────────────────────────────────────────────────────
   1. THE BUSINESS DAY IS `ts_orders.calendar_day`. TabSense rolls the day over
      at 04:00 Riyadh, so a meal eaten at 01:00 belongs to the previous day. We
      group by `calendar_day` and NEVER re-derive a day from a timestamp. The
      only place a timestamp is read is the hour-of-day flag, which wants the
      real Riyadh wall clock on purpose.
   2. MONEY FROM ORDERS IS VAT-INCLUSIVE (`total`, `gross_incl`,
      `discount_incl`) — same convention as analytics.js and dayreport.js.
      MONEY FROM MATERIALS IS VAT-EXCLUSIVE — same convention as costing.js.
      Half A is the first, half B is the second, and the payloads say so.
   3. AN UNMEASURED NUMBER IS `null`, NEVER 0. A meal component with no price
      is not a free ingredient, and a person with no history has no baseline.
      Both render as "—", never as a fabricated zero.
   4. GROUP MEMBERSHIP IS A FACT; A DISCOUNT PERCENTAGE IS A GUESS. Exactly the
      rule groups.js is built on, and this module inherits its configurable
      `staffPct` band from the same settings key rather than keeping a copy.
   5. SEEDED ONLY WHEN EMPTY. Once the manager corrects a portion or a
      headcount, redeploying never overwrites it — costing.js's rule 7.

   ── WHAT IS MEASURED AND WHAT IS ASSUMED (read before quoting a number) ────
   Half A is entirely MEASURED: every order, riyal and person comes off rows
   TabSense wrote. The thresholds that decide what is "abnormal" are judgement
   calls, and they ship in `rules` on every response so they can be argued with.

   Half B is a MODEL. Omar gave the seven meal NAMES and nothing else. Every
   gram, every piece and the headcount are this module's assumptions, flagged
   `assumed` on the row until a manager confirms them. A staff-meal cost is
   therefore an ESTIMATE built on guessed portions, and `basis` on every
   response says exactly that until the last component turns `confirmed`.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const TZ = "Asia/Riyadh";
const BIZ_DAY_START_HOUR = 4;

// Business rule 2 / dayreport.js rule 2: a void never happened and a refund
// reverses an order already counted on its own day.
const SALES_ONLY =
  `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

// The identity of the human behind an order, same expression analytics.js and
// dayreport.js use, plus the group member's own phone as a last resort so a
// member matched by `customer_id` alone still has a key to group by.
const IDENT_SQL =
  `COALESCE(NULLIF(s.phone_norm, ''), NULLIF(tc.phone_norm, ''), NULLIF(m.phone_norm, ''))`;

/* "This order belongs to an internal person" — the same predicate groups.js
   uses (customer_id first, then the phone on either the POS customer record or
   the cashier station's typed number), but as a LATERAL … LIMIT 1 rather than
   a plain JOIN.

   THE LIMIT 1 IS LOAD-BEARING. A plain join multiplies the order row once per
   matching membership, and somebody who sits in both الملاك and موظفين المطعم
   would have every riyal of their spend counted twice on a report whose entire
   job is to say what a person's spend was. Nobody is in both today; the report
   must not break the day somebody is. Owners sort first, so a person in both
   is reported as an owner — the more conservative reading of who they are. */
const INTERNAL_JOIN = `
  JOIN LATERAL (
    SELECT m0.phone_norm,
           CASE WHEN COALESCE(g0.local_name,'') = 'owners' OR COALESCE(g0.name,'') = 'الملاك'
                THEN 'owners' ELSE 'staff' END AS grp
      FROM customer_group_members m0
      JOIN customer_groups g0 ON g0.group_id = m0.group_id AND g0.is_internal
     WHERE m0.customer_id = o.customer_id
        OR (m0.phone_norm <> '' AND m0.phone_norm = COALESCE(NULLIF(tc.phone_norm,''), s.phone_norm))
     ORDER BY (CASE WHEN COALESCE(g0.local_name,'') = 'owners' OR COALESCE(g0.name,'') = 'الملاك'
                    THEN 0 ELSE 1 END), m0.customer_id
     LIMIT 1
  ) m ON TRUE`;

/* ── Labels. Keys stay English, everything Omar reads is Arabic. ─────────── */

// Postgres extract(dow): 0 = Sunday. Omar's rotation table starts at السبت,
// which is 6 — the seed below maps his table onto these indices explicitly
// rather than relying on anyone's memory of which end the week starts.
const DOW_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const GROUP_LABELS = { owners: "الملاك", staff: "الموظفين" };

/* ── The rotation, exactly as Omar wrote it ────────────────────────────────
   السبت   جبنة وبيض وبطاطس
   الأحد   أرز فتة لحمة
   الاثنين أرز وخضار وفراخ
   الثلاثاء مكرونة بشاميل
   الأربعاء أرز بصينية بطاطس بالفراخ
   الخميس  مكرونة كفتة داود باشا
   الجمعة  أرز وخضار وسلطة                                                  */
const SEED_MEALS = [
  [6, "جبنة وبيض وبطاطس"],
  [0, "أرز فتة لحمة"],
  [1, "أرز وخضار وفراخ"],
  [2, "مكرونة بشاميل"],
  [3, "أرز بصينية بطاطس بالفراخ"],
  [4, "مكرونة كفتة داود باشا"],
  [5, "أرز وخضار وسلطة"],
];

/* ── The component list — THE ASSUMPTION LAYER ─────────────────────────────
   [dow, componentName, canonical raw material (or '' = does not exist), qty
   per person, unit, note].

   READ THIS BEFORE QUOTING A MEAL COST. Omar gave meal names. Nobody has
   weighed a staff portion. Every quantity below is a plausible restaurant
   portion typed by this module, seeded as `assumed`, and the whole point of
   /api/staff-meals/components/:id is that the manager replaces it with what
   the kitchen actually scoops.

   Three components carry NO material on purpose — see the notes. They make the
   day's cost incomplete, which is the correct answer: a partial cost presented
   as a total is worse than a partial cost that says it is partial.           */
const SEED_COMPONENTS = [
  // السبت — جبنة وبيض وبطاطس
  [6, "بيض", "بيض", 2, "piece", ""],
  [6, "بطاطس", "بطاطس", 200, "g", ""],
  [6, "جبنة بيضاء", "", 60, "g", "مفيش جبنة بيضاء في المواد الخام — الموجود رومي/شيدر/كيري وبديلهم رقم مخترع"],
  [6, "زيت قلي", "زيت قلي دلال", 20, "g", ""],
  [6, "خبز", "خبز", 1, "piece", ""],
  // الأحد — أرز فتة لحمة
  [0, "أرز", "أرز بسمتي الوليمة", 150, "g", "وزن جاف قبل السلق"],
  [0, "لحمة", "لحم رقبة", 120, "g", ""],
  [0, "خبز الفتة", "خبز", 1, "piece", ""],
  [0, "صلصة", "صلصة بوريه", 40, "g", ""],
  [0, "ثوم", "ثوم", 5, "g", ""],
  [0, "خل", "خل", 5, "g", ""],
  [0, "سمن/زيت", "زيت درة", 10, "g", ""],
  [0, "بهارات", "السبع بهارات", 2, "g", ""],
  // الاثنين — أرز وخضار وفراخ
  [1, "أرز", "أرز بسمتي الوليمة", 150, "g", "وزن جاف قبل السلق"],
  [1, "فراخ", "أوراك مخلية", 180, "g", ""],
  [1, "جزر", "جزر", 40, "g", ""],
  [1, "بصل", "بصل", 40, "g", ""],
  [1, "فلفل رومي", "فلفل رومي", 30, "g", ""],
  [1, "بازلاء", "", 50, "g", "مفيش بازلاء ولا خضار مجمد مشكّل في المواد الخام"],
  [1, "زيت", "زيت درة", 15, "g", ""],
  [1, "مرقة دجاج", "مرقة دجاج ( بهارات دجاج )", 5, "g", ""],
  // الثلاثاء — مكرونة بشاميل
  [2, "مكرونة", "مكرونة أقلام قودي", 120, "g", "وزن جاف"],
  [2, "لحمة مفرومة", "لحم مفروم", 100, "g", ""],
  [2, "حليب", "حليب المراعي", 150, "g", ""],
  [2, "زبدة", "زبدة المراعي", 15, "g", ""],
  [2, "دقيق", "دقيق", 15, "g", ""],
  [2, "جبنة رومي", "جبنة رومي", 20, "g", ""],
  [2, "بصل", "بصل", 30, "g", ""],
  [2, "جوزة الطيب", "جوزة الطيب", 0.5, "g", ""],
  // الأربعاء — أرز بصينية بطاطس بالفراخ
  [3, "أرز", "أرز بسمتي الوليمة", 150, "g", "وزن جاف قبل السلق"],
  [3, "بطاطس", "بطاطس", 200, "g", ""],
  [3, "فراخ", "دجاجة 1كيلو بالعضم", 0.25, "piece", "ربع فرخة للفرد"],
  [3, "صلصة", "صلصة بوريه", 50, "g", ""],
  [3, "بصل", "بصل", 30, "g", ""],
  [3, "زيت", "زيت درة", 15, "g", ""],
  [3, "بهارات", "السبع بهارات", 2, "g", ""],
  // الخميس — مكرونة كفتة داود باشا
  [4, "مكرونة", "مكرونة شريط", 120, "g", "سعر المادة في الجدول صفر — محتاج سعر حقيقي"],
  [4, "لحمة مفرومة", "لحم مفروم", 130, "g", ""],
  [4, "صلصة", "صلصة بوريه", 60, "g", ""],
  [4, "بصل", "بصل", 40, "g", ""],
  [4, "ثوم", "ثوم", 5, "g", ""],
  [4, "بقدونس", "بقدونس", 0.1, "piece", "ربطة بقدونس تكفّي ١٠ أفراد"],
  [4, "بقسماط", "بقسماط", 10, "g", ""],
  [4, "زيت", "زيت درة", 15, "g", ""],
  [4, "بهارات", "السبع بهارات", 2, "g", ""],
  // الجمعة — أرز وخضار وسلطة
  [5, "أرز", "أرز بسمتي الوليمة", 150, "g", "وزن جاف قبل السلق"],
  [5, "جزر", "جزر", 40, "g", ""],
  [5, "بصل", "بصل", 40, "g", ""],
  [5, "فلفل رومي", "فلفل رومي", 30, "g", ""],
  [5, "بازلاء", "", 50, "g", "مفيش بازلاء ولا خضار مجمد مشكّل في المواد الخام"],
  [5, "خيار السلطة", "خيار", 50, "g", ""],
  [5, "طماطم السلطة", "طماطم", 60, "g", ""],
  [5, "كرنب السلطة", "كرنب سلطة", 40, "g", ""],
  [5, "ليمون", "ليمون", 10, "g", ""],
  [5, "زيت", "زيت درة", 15, "g", ""],
];

// The staff group has 9 members in TabSense. That is a MEMBERSHIP COUNT, not a
// count of who eats — the manager confirms it on /api/staff-meals/config.
const DEFAULT_HEADCOUNT = 9;

/* ── The anomaly thresholds ────────────────────────────────────────────────
   Every one of these is a judgement call, so every one ships in `rules` on the
   response. They are deliberately MEDIAN-based: a mean is dragged by the very
   outlier we are hunting, so comparing a spike against a mean that already
   contains it hides the spike.                                             */
const RULES = {
  // The entitlement is a flat 50%. 111 of the ~130 internal discounted orders
  // sit at exactly 0.500; anything outside this band is a manual override.
  expectedPct: 0.5,
  rateTolerance: 0.02,
  // A day is a spike when it is this many times the person's OWN median day
  // AND clears a floor — 3x of SAR 10 is not news.
  spikeFactor: 3,
  spikeFloorSar: 50,
  // Same test at order granularity, on the pre-discount menu value: one person
  // does not eat SAR 500 of food. That is a party, a family, or a giveaway.
  ticketFactor: 3,
  ticketFloorSar: 150,
  // "Never bought, suddenly buying daily": at most this many buying days in
  // the EQUAL-LENGTH period immediately before the window, at least this many
  // inside it. The before-window is equal-length (analytics.js's `prev`
  // convention) because comparing 4 months of "now" against 30 days of
  // "before" is not a comparison.
  newHabitPriorDays: 1,
  newHabitWindowDays: 5,
  // An hour is CLOSED when it carried less than this share of the last 90
  // days' orders. Derived from the data, never hardcoded — the kitchen's hours
  // are allowed to change without anyone editing this file.
  closedHourShare: 0.002,
  closedHourLookback: 90,
};

const FLAG_META = {
  unlisted_staff_rate: {
    label: "خصم موظفين لاسم مش في المجموعة",
    severity: "high",
    why: "الخصم اتصرف بنسبة الموظفين لعميل مش مسجّل في مجموعة الموظفين ولا الملاك. يا هو موظف ناقص من المجموعة، يا هو خصم راح لحد مالوش حق فيه.",
  },
  no_identity: {
    label: "خصم موظفين على طلب بدون عميل",
    severity: "high",
    why: "نسبة خصم الموظفين اتحطت على طلب مالوش عميل ولا تليفون خالص — مفيش حد نسأله.",
  },
  wrong_rate: {
    label: "نسبة خصم مش ٥٠٪",
    severity: "high",
    why: "استحقاق الموظف نصف الحساب. أي نسبة تانية معناها إن حد غيّرها بإيده على الكاشير.",
  },
  spike_vs_self: {
    label: "يوم أعلى بكتير من معدّل الشخص نفسه",
    severity: "high",
    why: "المقارنة بمعدّل الشخص نفسه، مش بمعدّل المجموعة: صاحب المطعم اللي بياخد ٢٠٠ ريال في اليوم ده طبيعي بالنسباله وكارثة بالنسبة لعامل.",
  },
  big_ticket: {
    label: "طلب واحد أكبر بكتير من طلباته العادية",
    severity: "medium",
    why: "كمية محدش بياكلها في قعدة واحدة — غالبًا طلب عيلة أو ضيافة اتحطت على حساب الموظف.",
  },
  new_habit: {
    label: "شخص مكانش بيشتري وبقى بيشتري كل يوم",
    severity: "medium",
    why: "تغيّر سلوك، مش رقم كبير. المقارنة بفترة قبلها بنفس الطول بالظبط، ولو بيانات الطلبات مابتوصلهاش الفحص ده مابيشتغلش أصلًا بدل ما يفضح الكل غلط.",
  },
  closed_hours: {
    label: "طلب في ساعة المطعم فيها مقفول",
    severity: "high",
    why: "ساعات الشغل متحسوبة من الطلبات نفسها آخر ٩٠ يوم، مش مكتوبة في الكود. طلب بره الساعات دي يعني الفاتورة اتفتحت والمحل مقفول.",
  },
};

/* ── small helpers ────────────────────────────────────────────────────────── */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(num(v) * 100) / 100;
const round3 = (v) => Math.round(num(v) * 1000) / 1000;
const round4 = (v) => Math.round(num(v) * 10000) / 10000;
// Business rule 3: no denominator means UNKNOWN, not zero.
const ratio = (a, b) => (num(b) === 0 ? null : round4(num(a) / num(b)));
const nOrNull = (v) => (v === null || v === undefined || v === "" ? null : num(v));

const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => typeof v === "string" && DAY_RE.test(v);
const dayArg = (v, fallback) => (isDay(v) ? v : fallback);
const shiftDay = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);
// UTC is safe here: the string is a plain calendar date, and getUTCDay on a
// UTC-midnight Date is the same weekday Postgres extract(dow) reports.
const dowOf = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();
const newId = (p) => `${p}_${crypto.randomBytes(8).toString("hex")}`;
const trim = (v, n) => String(v ?? "").trim().slice(0, n);
const clean = (s) => String(s ?? "").replace(/[‎‏]/g, "").trim(); // same fold as costing.js `norm`

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, todayISO, daysAgoISO } = ctx;

  /* ── Schema. Fired once at registration; a failure logs instead of taking
     the API down, same as costing.js / groups.js. ───────────────────────── */
  async function ensureSchema() {
    await pool.query(`
      -- The weekly rotation. PK is Postgres extract(dow): 0 = Sunday .. 6 =
      -- Saturday, so a day's meal is a direct lookup and never a date guess.
      CREATE TABLE IF NOT EXISTS sm_meals (
        dow        SMALLINT PRIMARY KEY,
        name_ar    TEXT NOT NULL DEFAULT '',
        note       TEXT NOT NULL DEFAULT '',
        active     BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL DEFAULT ''
      );
      -- What one PERSON eats of one meal. \`material_ar\` points at
      -- cost_raw_materials.canonical_ar; empty means "this ingredient has no
      -- raw material row", which is a finding, not an error.
      -- qty_source: assumed = this module typed it; confirmed = a manager did.
      CREATE TABLE IF NOT EXISTS sm_meal_components (
        id             TEXT PRIMARY KEY,
        dow            SMALLINT NOT NULL,
        name_ar        TEXT NOT NULL DEFAULT '',
        material_ar    TEXT NOT NULL DEFAULT '',
        qty_per_person NUMERIC,
        unit           TEXT NOT NULL DEFAULT 'g',
        qty_source     TEXT NOT NULL DEFAULT 'assumed',
        note           TEXT NOT NULL DEFAULT '',
        sort           INT NOT NULL DEFAULT 0,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by     TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS sm_meal_components_dow_idx ON sm_meal_components(dow, sort);
      -- Per-BUSINESS-day override. A row exists only when somebody said
      -- something about that day; absence means "the default applied".
      CREATE TABLE IF NOT EXISTS sm_headcount (
        day       DATE PRIMARY KEY,
        headcount INT,
        served    BOOLEAN NOT NULL DEFAULT TRUE,
        source    TEXT NOT NULL DEFAULT 'confirmed',
        note      TEXT NOT NULL DEFAULT '',
        set_by    TEXT NOT NULL DEFAULT '',
        set_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- Singleton (id = 1).
      CREATE TABLE IF NOT EXISTS sm_config (
        id                INT PRIMARY KEY,
        default_headcount INT,
        headcount_source  TEXT NOT NULL DEFAULT 'assumed',
        note              TEXT NOT NULL DEFAULT '',
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by        TEXT NOT NULL DEFAULT ''
      );
    `);
    await seedIfEmpty();
  }

  /** Business rule 5 — seed only when empty, so a manager's corrections
   *  survive every redeploy. */
  async function seedIfEmpty() {
    const empty = async (t) =>
      num((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n) === 0;

    if (await empty("sm_meals")) {
      for (const [dow, name] of SEED_MEALS) {
        await pool.query(
          `INSERT INTO sm_meals (dow, name_ar, note) VALUES ($1,$2,$3)
           ON CONFLICT (dow) DO NOTHING`,
          [dow, name, "من جدول عمر"]
        );
      }
    }
    if (await empty("sm_meal_components")) {
      let i = 0;
      for (const [dow, name, mat, qty, unit, note] of SEED_COMPONENTS) {
        await pool.query(
          `INSERT INTO sm_meal_components
             (id, dow, name_ar, material_ar, qty_per_person, unit, qty_source, note, sort)
           VALUES ($1,$2,$3,$4,$5,$6,'assumed',$7,$8) ON CONFLICT (id) DO NOTHING`,
          [newId("smc"), dow, name, mat, qty, unit, note, i++]
        );
      }
    }
    if (await empty("sm_config")) {
      await pool.query(
        `INSERT INTO sm_config (id, default_headcount, headcount_source, note)
         VALUES (1, $1, 'assumed', $2) ON CONFLICT (id) DO NOTHING`,
        [DEFAULT_HEADCOUNT,
         "٩ = عدد أعضاء مجموعة «موظفين المطعم» في TabSense، مش عدّة اللي بياكلوا فعلًا. المدير هو اللي يأكّدها."]
      );
    }
  }

  ensureSchema()
    .then(() => console.log("[staff_meals] schema ready"))
    .catch((e) => console.error("[staff_meals] ensureSchema failed:", e.message));

  /* `cw_audit` belongs to costing.js / costing_auth.js, which both note that
     concurrent CREATE TABLE IF NOT EXISTS on one relation is a real race in
     PostgreSQL. This module therefore does NOT declare it — it only writes,
     and a write that lands before costing.js has created the table is
     swallowed. Losing an audit line is better than racing a DDL. */
  async function audit(entity, ref, field, oldV, newV, by, note = "") {
    try {
      await pool.query(
        `INSERT INTO cw_audit (id, actor_id, actor_name, entity, entity_ref, field, old_value, new_value, note)
         VALUES ($1,'',$2,$3,$4,$5,$6,$7,$8)`,
        [newId("aud"),
         // The admin token is shared and carries no identity, so the caller may
         // name itself in `by`; without it the honest actor is just "admin".
         trim(by, 80) || "admin",
         entity, String(ref), field,
         oldV === null || oldV === undefined ? null : String(oldV),
         newV === null || newV === undefined ? null : String(newV),
         note]
      );
    } catch (e) {
      console.error("[staff_meals] audit skipped:", e.message);
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PRICES — the dated, trim-aware resolver.

     Deliberately a MIRROR of costing.js's `effRaw`, not a second model:
       1. the newest `cw_material_prices` row with effective_from <= the day,
       2. falling back to `cost_raw_materials.cost_per_g / cost_per_piece`,
       3. divided by (1 − trim loss) so the price is per USABLE gram.
     It could not be imported — `effRaw` lives inside costing.js's register()
     closure — so it is restated here and nowhere else. If costing.js's rule
     changes, this is the one function that has to follow it.

     A price of exactly ZERO is treated as NO PRICE. A kilo of pasta does not
     cost nothing; a zero in that column is a broken row, and costing it at zero
     would silently make the meal look cheaper than it is.
  ═════════════════════════════════════════════════════════════════════════ */
  async function loadPrices(day) {
    const mats = await pool.query(
      `SELECT canonical_ar, name_en, purchase_unit, cost_per_g, cost_per_piece, status,
              trim_loss_pct, trim_bought_g, trim_usable_g, trim_source
         FROM cost_raw_materials`
    ).catch(() => ({ rows: [] }));

    // The workbench price table is costing.js's; if it has not been created yet
    // we simply fall back to the material's own price rather than 500.
    const dated = await pool.query(
      `SELECT DISTINCT ON (canonical_ar) canonical_ar, supplier, price, cost_per_g, cost_per_piece,
              effective_from, source, purchase_unit
         FROM cw_material_prices
        WHERE effective_from <= $1::date
        ORDER BY canonical_ar, effective_from DESC`,
      [day]
    ).catch(() => ({ rows: [] }));

    const byMat = new Map(mats.rows.map((r) => [clean(r.canonical_ar), r]));
    const byPrice = new Map(dated.rows.map((r) => [clean(r.canonical_ar), r]));

    return {
      day,
      materials: mats.rows,
      /** Cost per usable gram / piece on `day`, with the paper trail. */
      of(canonicalAr) {
        const key = clean(canonicalAr);
        if (!key) return { linked: false, found: false, perG: null, perPiece: null, reason: "no_material" };
        const base = byMat.get(key) || null;
        const p = byPrice.get(key) || null;
        if (!base && !p) {
          return { linked: true, found: false, perG: null, perPiece: null, reason: "material_missing" };
        }
        const pick = (a, b) => {
          const v = a !== null && a !== undefined ? Number(a)
            : b !== null && b !== undefined ? Number(b) : null;
          return Number.isFinite(v) ? v : null;
        };
        const rawPerG = pick(p?.cost_per_g, base?.cost_per_g);
        const rawPerPiece = pick(p?.cost_per_piece, base?.cost_per_piece);
        // Zero is not a price. See the header note.
        const purchasePerG = rawPerG === 0 ? null : rawPerG;
        const purchasePerPiece = rawPerPiece === 0 ? null : rawPerPiece;

        // Trim loss, two weights first, a typed percentage only as a fallback —
        // costing.js's `trimFrom` in three lines.
        const bought = nOrNull(base?.trim_bought_g);
        const usable = nOrNull(base?.trim_usable_g);
        let lossPct = null, trimSource = "";
        if (bought !== null && usable !== null && bought > 0 && usable > 0 && usable <= bought) {
          lossPct = 1 - usable / bought;
          trimSource = "weighed";
        } else if (nOrNull(base?.trim_loss_pct) !== null) {
          lossPct = num(base.trim_loss_pct);
          trimSource = String(base.trim_source || "assumed");
        }
        const f = lossPct === null || lossPct >= 1 ? 1 : 1 / (1 - lossPct);

        const zeroed = (rawPerG === 0 || rawPerPiece === 0) && purchasePerG === null && purchasePerPiece === null;
        return {
          linked: true,
          found: true,
          perG: purchasePerG === null ? null : purchasePerG * f,
          perPiece: purchasePerPiece === null ? null : purchasePerPiece * f,
          purchasePerG, purchasePerPiece,
          trimLossPct: lossPct, yieldFactor: f, trimSource,
          priceSource: p ? String(p.source || "workbook") : (base ? "workbook" : null),
          // Only a real supplier document counts as verified — costing.js's word.
          verified: String(p?.source || "") === "invoice",
          supplier: String(p?.supplier || ""),
          effectiveFrom: p ? isoDay(p.effective_from) : null,
          purchaseUnit: String(p?.purchase_unit || base?.purchase_unit || ""),
          flaggedReview: String(base?.status || "").toUpperCase() === "REVIEW",
          reason: zeroed ? "zero_price"
            : (purchasePerG === null && purchasePerPiece === null) ? "no_price" : null,
        };
      },
    };
  }

  const REASON_TEXT = {
    no_material: "المكوّن مش مربوط بأي مادة خام",
    material_missing: "المادة الخام دي مش موجودة في جدول المواد",
    no_price: "المادة موجودة بس من غير سعر",
    zero_price: "سعر المادة مسجّل صفر — ده سعر مكسور مش مكوّن ببلاش",
    wrong_unit: "الوحدة مش متطابقة مع طريقة شراء المادة (جرام مقابل حبة)",
  };

  /* ── One meal, priced ──────────────────────────────────────────────────── */
  function priceMeal(meal, components, prices) {
    const rows = components.map((c) => {
      const qty = nOrNull(c.qty_per_person);
      const unit = String(c.unit || "g").toLowerCase() === "piece" ? "piece" : "g";
      const e = prices.of(c.material_ar);
      let cost = null, reason = e.reason;

      if (qty === null || qty <= 0) {
        reason = reason || "no_price";
        cost = null;
      } else if (!reason) {
        // Business rule from costing.js: exactly one of per-g / per-piece is
        // meaningful for a material. Never multiply a per-piece cost by grams.
        const per = unit === "piece" ? e.perPiece : e.perG;
        if (per === null) { reason = "wrong_unit"; cost = null; }
        else cost = per * qty;
      }

      return {
        id: c.id,
        nameAr: c.name_ar,
        materialAr: c.material_ar || null,
        qtyPerPerson: qty,
        unit,
        qtySource: c.qty_source || "assumed",
        // The single most important field on this row: a cost the manager has
        // not confirmed the portion for is an estimate, however precise it looks.
        qtyConfirmed: c.qty_source === "confirmed",
        note: c.note || "",
        costPerPerson: cost === null ? null : round3(cost),
        priced: cost !== null,
        reason: reason || null,
        reasonText: reason ? REASON_TEXT[reason] : null,
        price: e.found ? {
          perG: e.perG === null ? null : round3(e.perG * 1000) / 1000,
          perPiece: e.perPiece === null ? null : round3(e.perPiece),
          sarPerKg: e.perG === null ? null : round3(e.perG * 1000),
          source: e.priceSource,
          verified: !!e.verified,
          supplier: e.supplier || null,
          effectiveFrom: e.effectiveFrom,
          trimLossPct: e.trimLossPct === null || e.trimLossPct === undefined ? null : round4(e.trimLossPct),
          trimSource: e.trimSource || null,
          flaggedReview: !!e.flaggedReview,
        } : null,
      };
    });

    const priced = rows.filter((r) => r.priced);
    const unpriced = rows.filter((r) => !r.priced);
    const costPerPersonPriced = round3(priced.reduce((a, r) => a + r.costPerPerson, 0));
    const complete = rows.length > 0 && unpriced.length === 0;
    const allConfirmed = rows.length > 0 && rows.every((r) => r.qtyConfirmed);

    return {
      dow: meal.dow,
      dowLabel: DOW_AR[meal.dow] || String(meal.dow),
      nameAr: meal.name_ar,
      note: meal.note || "",
      active: meal.active !== false,
      components: rows,
      // Business rule 3. The cost of an incomplete meal is UNKNOWN; what we can
      // add up is shipped separately as costPerPersonPriced so the screen can
      // show "SAR 7.4 من ٥ مكوّنات من ٦" without ever calling it the total.
      costPerPerson: complete ? costPerPersonPriced : null,
      costPerPersonPriced,
      complete,
      componentCount: rows.length,
      pricedCount: priced.length,
      unpricedCount: unpriced.length,
      unpriced: unpriced.map((r) => ({ nameAr: r.nameAr, materialAr: r.materialAr, reason: r.reason, reasonText: r.reasonText, note: r.note })),
      // "measured" is only reachable once every portion is confirmed AND every
      // component is priced. Until then this is a model, and it says so.
      basis: allConfirmed && complete ? "confirmed" : "assumed",
      assumedComponents: rows.filter((r) => !r.qtyConfirmed).length,
    };
  }

  async function loadRotation(day) {
    const [meals, comps, prices] = await Promise.all([
      pool.query("SELECT * FROM sm_meals ORDER BY dow"),
      pool.query("SELECT * FROM sm_meal_components ORDER BY dow, sort, id"),
      loadPrices(day),
    ]);
    const byDow = new Map();
    for (const c of comps.rows) {
      if (!byDow.has(c.dow)) byDow.set(c.dow, []);
      byDow.get(c.dow).push(c);
    }
    const out = new Map();
    for (const m of meals.rows) out.set(m.dow, priceMeal(m, byDow.get(m.dow) || [], prices));
    return { asOf: day, meals: out, prices };
  }

  async function loadConfig() {
    const r = await pool.query("SELECT * FROM sm_config WHERE id = 1");
    const c = r.rows[0] || {};
    return {
      defaultHeadcount: nOrNull(c.default_headcount) ?? DEFAULT_HEADCOUNT,
      headcountSource: c.headcount_source || "assumed",
      note: c.note || "",
    };
  }

  /** The headcount that applies to one day: the day's own row if a manager
   *  wrote one, otherwise the default — and always which of the two it was. */
  function headcountFor(day, cfg, overrideRow) {
    if (overrideRow) {
      return {
        value: overrideRow.served === false ? 0 : nOrNull(overrideRow.headcount),
        served: overrideRow.served !== false,
        source: overrideRow.served === false ? "confirmed" : (overrideRow.source || "confirmed"),
        note: overrideRow.note || "",
        overridden: true,
      };
    }
    return {
      value: cfg.defaultHeadcount,
      served: true,
      source: cfg.headcountSource,
      note: cfg.note,
      overridden: false,
    };
  }

  /** One business day of staff meals. Shaped so the parent can drop it beside
   *  `/api/day`'s `summary` without reshaping anything. */
  function mealDay(day, rot, cfg, overrideRow) {
    const dow = dowOf(day);
    const meal = rot.meals.get(dow) || null;
    const hc = headcountFor(day, cfg, overrideRow);
    const n = hc.served ? nOrNull(hc.value) : 0;
    const perPriced = meal ? meal.costPerPersonPriced : null;
    const perFull = meal ? meal.costPerPerson : null;

    return {
      kind: "staff_meals_cogs",
      date: day,
      dow,
      dowLabel: DOW_AR[dow],
      served: hc.served && !!meal && meal.active,
      headcount: n,
      headcountSource: hc.source,
      headcountOverridden: hc.overridden,
      headcountNote: hc.note,
      meal: meal ? { nameAr: meal.nameAr, note: meal.note, dow: meal.dow } : null,
      costPerPerson: perFull,
      costPerPersonPriced: perPriced,
      // Business rule 3 again: an incomplete recipe has no total, only a floor.
      totalCost: perFull === null || n === null ? null : money(perFull * n),
      totalCostPriced: perPriced === null || n === null ? null : money(perPriced * n),
      complete: meal ? meal.complete : false,
      basis: meal ? meal.basis : "assumed",
      unpriced: meal ? meal.unpriced : [],
      assumedComponents: meal ? meal.assumedComponents : 0,
      components: meal ? meal.components : [],
      vat: "excl",
      note: "تكلفة مواد خام بدون ضريبة. متضافش على خصم مشتريات الموظفين — ده صرف من المخزن وده إيراد متنازل عنه.",
    };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     HALF B — STAFF MEALS. Routes.
  ═════════════════════════════════════════════════════════════════════════ */

  /* GET /api/staff-meals/rotation?date=  — the whole week, priced as of `date`. */
  app.get("/api/staff-meals/rotation", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const day = dayArg(c.req.query("date"), todayISO());
    const [rot, cfg] = await Promise.all([loadRotation(day), loadConfig()]);
    const meals = [...rot.meals.values()].sort((a, b) => a.dow - b.dow);
    const n = cfg.defaultHeadcount;

    const withDay = meals.map((m) => ({
      ...m,
      dailyCost: m.costPerPerson === null || n === null ? null : money(m.costPerPerson * n),
      dailyCostPriced: n === null ? null : money(m.costPerPersonPriced * n),
    }));
    const complete = withDay.filter((m) => m.complete);
    // A weekly total is only honest when every day of the week is complete.
    const weekCost = complete.length === withDay.length && n !== null
      ? money(withDay.reduce((a, m) => a + m.costPerPerson * n, 0)) : null;

    return c.json({
      ok: true, kind: "staff_meals_cogs", asOf: day,
      headcount: n, headcountSource: cfg.headcountSource, headcountNote: cfg.note,
      meals: withDay,
      totals: {
        weekCost,
        weekCostPriced: n === null ? null : money(withDay.reduce((a, m) => a + m.costPerPersonPriced * n, 0)),
        // What a 30-day month would carry at this rotation — only when the week
        // is fully priced, otherwise it would be a floor dressed as a forecast.
        monthCostEstimate: weekCost === null ? null : money((weekCost / 7) * 30),
        completeDays: complete.length,
        totalDays: withDay.length,
        unpricedComponents: withDay.reduce((a, m) => a + m.unpricedCount, 0),
        assumedComponents: withDay.reduce((a, m) => a + m.assumedComponents, 0),
      },
      vat: "excl",
      basis: withDay.every((m) => m.basis === "confirmed") ? "confirmed" : "assumed",
      disclaimer: "الكميات دي افتراضات الموديول، مش وزن اتقاس في المطبخ. كل مكوّن عليه علامة «مفترض» لحد ما المدير يأكّده.",
    });
  });

  /* GET /api/staff-meals/day?date= — one business day, dashboard-shaped. */
  app.get("/api/staff-meals/day", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const day = dayArg(c.req.query("date"), todayISO());
    const [rot, cfg, ov] = await Promise.all([
      loadRotation(day), loadConfig(),
      pool.query("SELECT * FROM sm_headcount WHERE day = $1::date", [day]),
    ]);
    return c.json({ ok: true, ...mealDay(day, rot, cfg, ov.rows[0] || null) });
  });

  /* GET /api/staff-meals/period?from&to — the daily series + honest totals. */
  app.get("/api/staff-meals/period", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    if (from > to) return c.json({ ok: false, error: "from_after_to" }, 400);
    const n = spanDays(from, to);
    if (n > 400) return c.json({ ok: false, error: "range_too_long" }, 400);

    // Prices are resolved as of `to`. Resolving per day would be more correct
    // and costs one query per day; it is deliberately not done here, and this
    // line is why: over a month the purchase prices in this kitchen move by
    // cents, and a 30x query fan-out for that is a bad trade. `pricedAsOf` on
    // the response says which day the prices came from.
    const [rot, cfg, ovs] = await Promise.all([
      loadRotation(to), loadConfig(),
      pool.query("SELECT * FROM sm_headcount WHERE day BETWEEN $1::date AND $2::date", [from, to]),
    ]);
    const ovByDay = new Map(ovs.rows.map((r) => [isoDay(r.day), r]));

    const days = [];
    for (let i = 0; i < n; i++) {
      const d = shiftDay(from, i);
      days.push(mealDay(d, rot, cfg, ovByDay.get(d) || null));
    }

    const served = days.filter((d) => d.served && d.headcount);
    const completeDays = served.filter((d) => d.complete);
    const totalPriced = money(served.reduce((a, d) => a + num(d.totalCostPriced), 0));
    // A period total is only a TOTAL when every served day inside it was fully
    // priced. Otherwise it is a floor, and it is reported as one.
    const total = completeDays.length === served.length && served.length > 0 ? totalPriced : null;

    return c.json({
      ok: true, kind: "staff_meals_cogs", from, to, days: n, pricedAsOf: to,
      daily: days.map((d) => ({
        date: d.date, dowLabel: d.dowLabel, served: d.served, headcount: d.headcount,
        headcountSource: d.headcountSource, meal: d.meal?.nameAr || null,
        costPerPerson: d.costPerPerson, costPerPersonPriced: d.costPerPersonPriced,
        totalCost: d.totalCost, totalCostPriced: d.totalCostPriced,
        complete: d.complete, unpricedCount: d.unpriced.length,
      })),
      totals: {
        servedDays: served.length,
        completeDays: completeDays.length,
        totalCost: total,
        totalCostPriced: totalPriced,
        avgPerDay: served.length ? money(totalPriced / served.length) : null,
        avgPerPerson: ratio(totalPriced, served.reduce((a, d) => a + num(d.headcount), 0)),
        meals: served.reduce((a, d) => a + num(d.headcount), 0),
      },
      vat: "excl",
      basis: days.every((d) => d.basis === "confirmed") ? "confirmed" : "assumed",
      note: "ده صرف مواد خام من المخزن، مش خصم على فاتورة. مايتجمعش مع تقرير مشتريات الموظفين.",
    });
  });

  /* GET /api/staff-meals/config */
  app.get("/api/staff-meals/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await loadConfig();
    // The membership count the default was taken from, so the screen can show
    // the manager what he is being asked to confirm against.
    const grp = (await pool.query(
      `SELECT count(*)::int AS n FROM customer_group_members m
         JOIN customer_groups g ON g.group_id = m.group_id AND g.is_internal
        WHERE COALESCE(g.local_name,'') <> 'owners' AND COALESCE(g.name,'') <> 'الملاك'`
    ).catch(() => ({ rows: [{ n: null }] }))).rows[0];
    return c.json({ ok: true, ...cfg, staffGroupSize: nOrNull(grp?.n) });
  });

  /* PUT /api/staff-meals/config  { defaultHeadcount, note, by } */
  app.put("/api/staff-meals/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const hc = nOrNull(b.defaultHeadcount);
    if (hc === null || !Number.isInteger(hc) || hc < 0 || hc > 500) {
      return c.json({ ok: false, error: "defaultHeadcount must be an integer 0..500" }, 400);
    }
    const before = await loadConfig();
    await pool.query(
      `INSERT INTO sm_config (id, default_headcount, headcount_source, note, updated_at, updated_by)
       VALUES (1,$1,'confirmed',$2,NOW(),$3)
       ON CONFLICT (id) DO UPDATE SET
         default_headcount = EXCLUDED.default_headcount,
         headcount_source  = 'confirmed',
         note = EXCLUDED.note, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [hc, trim(b.note, 300), trim(b.by, 80)]
    );
    await audit("staff_meal_config", 1, "default_headcount", before.defaultHeadcount, hc, trim(b.by, 80));
    return c.json({ ok: true, ...(await loadConfig()) });
  });

  /* PUT /api/staff-meals/headcount  { day, headcount, served, note, by }
     A per-day correction. `served:false` is how a closed day is recorded — it
     is NOT the same as headcount 0 with the kitchen open, and the two would
     otherwise be indistinguishable on the report. */
  app.put("/api/staff-meals/headcount", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    if (!isDay(b.day)) return c.json({ ok: false, error: "day required (YYYY-MM-DD)" }, 400);
    const served = b.served !== false;
    const hc = nOrNull(b.headcount);
    if (served && (hc === null || !Number.isInteger(hc) || hc < 0 || hc > 500)) {
      return c.json({ ok: false, error: "headcount must be an integer 0..500" }, 400);
    }
    const before = (await pool.query("SELECT * FROM sm_headcount WHERE day=$1::date", [b.day])).rows[0] || null;
    await pool.query(
      `INSERT INTO sm_headcount (day, headcount, served, source, note, set_by, set_at)
       VALUES ($1::date,$2,$3,'confirmed',$4,$5,NOW())
       ON CONFLICT (day) DO UPDATE SET
         headcount = EXCLUDED.headcount, served = EXCLUDED.served,
         source = 'confirmed', note = EXCLUDED.note,
         set_by = EXCLUDED.set_by, set_at = NOW()`,
      [b.day, served ? hc : null, served, trim(b.note, 300), trim(b.by, 80)]
    );
    await audit("staff_meal_headcount", b.day, "headcount",
      before ? before.headcount : null, served ? hc : "not_served", trim(b.by, 80));
    return c.json({ ok: true, day: b.day, headcount: served ? hc : null, served });
  });

  /* DELETE /api/staff-meals/headcount/:day — drop the override, fall back to
     the default. Deliberately available: an override typed by mistake would
     otherwise be permanent. */
  app.delete("/api/staff-meals/headcount/:day", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const day = c.req.param("day");
    if (!isDay(day)) return c.json({ ok: false, error: "bad day" }, 400);
    const r = await pool.query("DELETE FROM sm_headcount WHERE day=$1::date", [day]);
    if (r.rowCount) await audit("staff_meal_headcount", day, "headcount", "override", "default", "");
    return c.json({ ok: true, deleted: r.rowCount });
  });

  /* PUT /api/staff-meals/rotation/:dow  { nameAr, note, active, by } */
  app.put("/api/staff-meals/rotation/:dow", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const dow = Number(c.req.param("dow"));
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return c.json({ ok: false, error: "dow must be 0..6" }, 400);
    const b = await c.req.json().catch(() => ({}));
    const before = (await pool.query("SELECT * FROM sm_meals WHERE dow=$1", [dow])).rows[0] || null;
    const name = b.nameAr === undefined ? (before?.name_ar || "") : trim(b.nameAr, 200);
    if (!name) return c.json({ ok: false, error: "nameAr required" }, 400);
    await pool.query(
      `INSERT INTO sm_meals (dow, name_ar, note, active, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,NOW(),$5)
       ON CONFLICT (dow) DO UPDATE SET
         name_ar = EXCLUDED.name_ar, note = EXCLUDED.note,
         active = EXCLUDED.active, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [dow, name,
       b.note === undefined ? (before?.note || "") : trim(b.note, 300),
       b.active === undefined ? (before?.active !== false) : b.active !== false,
       trim(b.by, 80)]
    );
    await audit("staff_meal", dow, "name_ar", before?.name_ar ?? null, name, trim(b.by, 80));
    return c.json({ ok: true, dow });
  });

  /* POST /api/staff-meals/components
     { dow, nameAr, materialAr, qtyPerPerson, unit, note, by } */
  app.post("/api/staff-meals/components", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const dow = Number(b.dow);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return c.json({ ok: false, error: "dow must be 0..6" }, 400);
    const name = trim(b.nameAr, 200);
    if (!name) return c.json({ ok: false, error: "nameAr required" }, 400);
    const qty = nOrNull(b.qtyPerPerson);
    if (qty !== null && (!(qty > 0) || qty > 100000)) return c.json({ ok: false, error: "qtyPerPerson out of range" }, 400);
    const unit = String(b.unit || "g").toLowerCase() === "piece" ? "piece" : "g";
    const id = newId("smc");
    const sort = num((await pool.query(
      "SELECT COALESCE(max(sort),0)+1 AS s FROM sm_meal_components WHERE dow=$1", [dow])).rows[0].s);
    await pool.query(
      `INSERT INTO sm_meal_components
         (id, dow, name_ar, material_ar, qty_per_person, unit, qty_source, note, sort, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed',$7,$8,$9)`,
      [id, dow, name, trim(b.materialAr, 200), qty, unit, trim(b.note, 300), sort, trim(b.by, 80)]
    );
    await audit("staff_meal_component", id, "created", null, `${name} ${qty ?? "—"}${unit}`, trim(b.by, 80));
    return c.json({ ok: true, id });
  });

  /* PUT /api/staff-meals/components/:id
     Any edit to the QUANTITY promotes the row from `assumed` to `confirmed` —
     that is the whole mechanism by which a guessed portion becomes a measured
     one, and it is why the flag lives on the row and not on the module. */
  app.put("/api/staff-meals/components/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    const before = (await pool.query("SELECT * FROM sm_meal_components WHERE id=$1", [id])).rows[0];
    if (!before) return c.json({ ok: false, error: "not_found" }, 404);

    const name = b.nameAr === undefined ? before.name_ar : trim(b.nameAr, 200);
    const mat = b.materialAr === undefined ? before.material_ar : trim(b.materialAr, 200);
    const qty = b.qtyPerPerson === undefined ? nOrNull(before.qty_per_person) : nOrNull(b.qtyPerPerson);
    if (qty !== null && (!(qty > 0) || qty > 100000)) return c.json({ ok: false, error: "qtyPerPerson out of range" }, 400);
    const unit = b.unit === undefined ? before.unit
      : (String(b.unit).toLowerCase() === "piece" ? "piece" : "g");
    const note = b.note === undefined ? before.note : trim(b.note, 300);
    const qtyChanged = qty !== nOrNull(before.qty_per_person) || unit !== before.unit;
    const source = qtyChanged ? "confirmed" : before.qty_source;

    await pool.query(
      `UPDATE sm_meal_components SET
         name_ar=$2, material_ar=$3, qty_per_person=$4, unit=$5,
         qty_source=$6, note=$7, updated_at=NOW(), updated_by=$8
       WHERE id=$1`,
      [id, name, mat, qty, unit, source, note, trim(b.by, 80)]
    );
    if (qtyChanged) {
      await audit("staff_meal_component", id, "qty_per_person",
        `${before.qty_per_person ?? "—"} ${before.unit}`, `${qty ?? "—"} ${unit}`, trim(b.by, 80));
    }
    if (mat !== before.material_ar) {
      await audit("staff_meal_component", id, "material_ar", before.material_ar || null, mat || null, trim(b.by, 80));
    }
    return c.json({ ok: true, id, qtySource: source });
  });

  /* DELETE /api/staff-meals/components/:id */
  app.delete("/api/staff-meals/components/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const before = (await pool.query("SELECT * FROM sm_meal_components WHERE id=$1", [id])).rows[0];
    const r = await pool.query("DELETE FROM sm_meal_components WHERE id=$1", [id]);
    if (r.rowCount) await audit("staff_meal_component", id, "deleted", before?.name_ar ?? null, null, "");
    return c.json({ ok: true, deleted: r.rowCount });
  });

  /* GET /api/staff-meals/materials?q= — the picker the manager links an
     unpriced component with, priced as of today so he can see what he is
     choosing rather than only its name. */
  app.get("/api/staff-meals/materials", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const day = dayArg(c.req.query("date"), todayISO());
    const q = clean(c.req.query("q")).toLowerCase();
    const prices = await loadPrices(day);
    const out = prices.materials
      .filter((m) => !q
        || String(m.canonical_ar).toLowerCase().includes(q)
        || String(m.name_en || "").toLowerCase().includes(q))
      .map((m) => {
        const e = prices.of(m.canonical_ar);
        return {
          canonicalAr: m.canonical_ar,
          nameEn: m.name_en || "",
          purchaseUnit: m.purchase_unit || "",
          // Which unit this material can actually be costed in — the picker
          // must not offer grams for a material bought by the piece.
          unit: e.perPiece !== null && e.perG === null ? "piece" : e.perG !== null ? "g" : null,
          sarPerKg: e.perG === null ? null : round3(e.perG * 1000),
          sarPerPiece: e.perPiece === null ? null : round3(e.perPiece),
          priced: e.perG !== null || e.perPiece !== null,
          reason: e.reason || null,
          verified: !!e.verified,
        };
      })
      .sort((a, b) => String(a.canonicalAr).localeCompare(String(b.canonicalAr), "ar"));
    return c.json({ ok: true, asOf: day, count: out.length, materials: out.slice(0, 400) });
  });

  /* ═════════════════════════════════════════════════════════════════════════
     HALF A — STAFF PURCHASES AT 50%.

     Omar's ask, verbatim in effect: «عشان لو في اي حاجة غير طبيعية». So this is
     not a total with a person column bolted on. Every row is scored against
     what NORMAL looks like, and normal is defined per person, because the two
     owners buy an order of magnitude more than any cook and always will.

     WHAT IS FLAGGED, AND WHY (each also ships its own `why` in Arabic):

       unlisted_staff_rate  a staff-rate discount on somebody who is NOT in the
                            staff/owners group. Membership is a fact, the
                            percentage is a guess (groups.js's rule): a 50% off
                            a stranger is either a missing group member or
                            leakage, and both need fixing.
       no_identity          the same, on an order with no customer at all. Split
                            out from the above because there is nobody to ask.
       wrong_rate           a group member charged at anything but 50% (±2%).
                            The entitlement is flat; a different number means a
                            human overrode it at the till.
       spike_vs_self        a day ≥ 3× that person's own MEDIAN day and ≥ SAR 50.
                            Median, not mean — a mean that already contains the
                            spike hides the spike.
       big_ticket           one order ≥ 3× that person's own median order and
                            ≥ SAR 150 pre-discount. This is the "quantity no one
                            eats" test.
       new_habit            ≤ 1 buying day in the 30 before the window, ≥ 5
                            inside it. Behaviour change, not size.
       closed_hours         an order in an hour the restaurant is shut. The
                            open hours are DERIVED from the last 90 days of
                            orders, not hardcoded, so the kitchen can change
                            its hours without this becoming a false alarm.

     NOT flagged, on purpose: total volume. The owners take ~90% of the discount
     and that is a decision, not an anomaly; the report splits owners from staff
     so it is visible without pretending to be a finding.
  ═════════════════════════════════════════════════════════════════════════ */

  async function staffRateBand() {
    const s = await getSettingsData().catch(() => ({}));
    const b = s?.discountRules?.staffPct;
    return Array.isArray(b) && b.length === 2 && b[0] < b[1] ? [Number(b[0]), Number(b[1])] : [0.45, 0.55];
  }

  /** The hours the restaurant is actually open, derived from the orders. */
  async function openHours(to) {
    const rows = (await pool.query(
      `SELECT extract(hour from (o.order_date AT TIME ZONE '${TZ}'))::int AS h, count(*)::int AS n
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date - ${RULES.closedHourLookback} AND $1::date
          AND ${SALES_ONLY}
        GROUP BY 1`,
      [to]
    )).rows;
    const total = rows.reduce((a, r) => a + num(r.n), 0);
    // No history at all → every hour is "open", because we cannot say otherwise.
    if (total === 0) return { hours: new Set(Array.from({ length: 24 }, (_, i) => i)), total: 0 };
    const open = new Set(rows.filter((r) => num(r.n) / total >= RULES.closedHourShare).map((r) => num(r.h)));
    return { hours: open, total };
  }

  async function purchasesReport(from, to) {
    const [band, oh] = await Promise.all([staffRateBand(), openHours(to)]);

    /* Every order placed by an internal person in the window. `pn` is the
       identity key; the DISPLAY name comes from ts_customers, because
       customer_group_members.name is just the group name repeated on every
       member row and would render eleven people as "موظفين المطعم". */
    const orders = (await pool.query(
      `SELECT o.order_id, COALESCE(o.receipt,'') AS receipt, o.calendar_day::text AS day,
              o.gross_incl, o.discount_incl, o.total,
              extract(hour from (o.order_date AT TIME ZONE '${TZ}'))::int AS hour,
              to_char(o.order_date AT TIME ZONE '${TZ}', 'HH24:MI') AS time,
              COALESCE(NULLIF(o.staff_name,''), '') AS cashier,
              ${IDENT_SQL} AS pn,
              COALESCE(NULLIF(tc.name,''), NULLIF(s.customer_name,''), '') AS cname,
              m.grp AS grp
         FROM ts_orders o
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         ${INTERNAL_JOIN}
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        ORDER BY o.calendar_day DESC, o.order_date DESC`,
      [from, to]
    )).rows;

    /* Each person's OWN baseline, over their whole history up to `to`. A median
       is used, and it is computed over ALL their days rather than only the days
       before the window: a median is not moved by one outlier, and a baseline
       built from a two-week window would be empty for the people who buy least
       — exactly the people whose first big order matters most. */
    const base = (await pool.query(
      `WITH mine AS (
         SELECT ${IDENT_SQL} AS pn, o.calendar_day AS d, o.gross_incl, o.discount_incl
           FROM ts_orders o
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           ${INTERNAL_JOIN}
          WHERE o.calendar_day <= $1::date AND ${SALES_ONLY}
       ),
       perday AS (
         SELECT pn, d, sum(discount_incl) AS day_disc, sum(gross_incl) AS day_gross
           FROM mine GROUP BY 1,2
       )
       SELECT p.pn,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY p.day_disc) AS med_day_disc,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY p.day_gross) AS med_day_gross,
              count(*)::int AS lifetime_days,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY m.gross_incl)
                 FROM mine m WHERE m.pn = p.pn) AS med_order_gross,
              (SELECT count(*)::int FROM mine m WHERE m.pn = p.pn) AS lifetime_orders
         FROM perday p GROUP BY p.pn`,
      [to]
    )).rows;
    const baseline = new Map(base.map((r) => [r.pn, r]));

    /* Buying days in the equal-length period immediately BEFORE the window —
       the "never bought, now buying daily" test needs a before.

       AND THE BEFORE HAS TO EXIST. If the order cache does not reach back far
       enough, everybody's "before" is zero for the trivial reason that we hold
       no rows there, and the flag fires on all eleven of them — it did exactly
       that on an April→August window, nominating both owners. An unknown
       before is `null`, not zero (business rule 3), so the flag is skipped
       entirely and `newHabitComparable` on the response says why. */
    const priorFrom = shiftDay(from, -spanDays(from, to));
    const priorTo = shiftDay(from, -1);
    const cacheStart = isoDay((await pool.query(
      `SELECT min(o.calendar_day) AS d FROM ts_orders o`)).rows[0]?.d);
    const priorCovered = !!cacheStart && cacheStart <= priorFrom;

    const prior = new Map((await pool.query(
      `SELECT ${IDENT_SQL} AS pn, count(DISTINCT o.calendar_day)::int AS days
         FROM ts_orders o
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         ${INTERNAL_JOIN}
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1`,
      [priorFrom, priorTo]
    )).rows.map((r) => [r.pn, num(r.days)]));

    /* Staff-rate discounts given to somebody NOT in the group — the exact
       complement of INTERNAL_JOIN, written as NOT EXISTS rather than a
       LEFT JOIN … IS NULL so a customer who sits in two non-internal groups
       cannot appear twice and double the reported leakage. */
    const outsiders = (await pool.query(
      `SELECT o.order_id, COALESCE(o.receipt,'') AS receipt, o.calendar_day::text AS day,
              to_char(o.order_date AT TIME ZONE '${TZ}', 'HH24:MI') AS time,
              o.gross_incl, o.discount_incl, o.total,
              COALESCE(NULLIF(o.staff_name,''), '') AS cashier,
              COALESCE(NULLIF(tc.name,''), NULLIF(s.customer_name,''), '') AS cname,
              COALESCE(NULLIF(tc.phone_norm,''), NULLIF(s.phone_norm,''), '') AS pn
         FROM ts_orders o
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          AND o.discount_incl > 0 AND o.gross_incl > 0
          AND (o.discount_incl / o.gross_incl) BETWEEN $3::numeric AND $4::numeric
          AND NOT EXISTS (
            SELECT 1 FROM customer_group_members m0
              JOIN customer_groups g0 ON g0.group_id = m0.group_id AND g0.is_internal
             WHERE m0.customer_id = o.customer_id
                OR (m0.phone_norm <> '' AND m0.phone_norm = COALESCE(NULLIF(tc.phone_norm,''), s.phone_norm)))
        ORDER BY o.discount_incl DESC`,
      [from, to, band[0], band[1]]
    )).rows;

    /* Group membership, so people who never bought are still on the report —
       a benefit 4 of 11 members have never used is worth knowing.
       DISTINCT ON (customer_id), owners first, for the same reason the LATERAL
       above has a LIMIT 1: one human must be one row. */
    const members = (await pool.query(
      `SELECT DISTINCT ON (m.customer_id)
              m.customer_id, m.phone_norm,
              COALESCE(NULLIF(tc.name,''), '') AS cname,
              CASE WHEN COALESCE(g.local_name,'') = 'owners' OR COALESCE(g.name,'') = 'الملاك'
                   THEN 'owners' ELSE 'staff' END AS grp
         FROM customer_group_members m
         JOIN customer_groups g ON g.group_id = m.group_id AND g.is_internal
         LEFT JOIN ts_customers tc ON tc.customer_id = m.customer_id
        ORDER BY m.customer_id,
                 (CASE WHEN COALESCE(g.local_name,'') = 'owners' OR COALESCE(g.name,'') = 'الملاك'
                       THEN 0 ELSE 1 END)`
    )).rows;

    /* ── score every order ─────────────────────────────────────────────────── */

    const flagRows = { unlisted_staff_rate: [], no_identity: [], wrong_rate: [], spike_vs_self: [], big_ticket: [], new_habit: [], closed_hours: [] };
    const people = new Map();
    const dayKey = (pn, d) => `${pn} ${d}`;
    const perDay = new Map();

    for (const o of orders) {
      const pn = o.pn || `id:${o.order_id}`;
      const gross = num(o.gross_incl);
      const disc = num(o.discount_incl);
      const pct = gross > 0 ? disc / gross : null;
      const b = baseline.get(o.pn) || null;
      const medOrder = b ? nOrNull(b.med_order_gross) : null;

      const flags = [];
      if (disc > 0 && pct !== null && Math.abs(pct - RULES.expectedPct) > RULES.rateTolerance) flags.push("wrong_rate");
      if (!oh.hours.has(num(o.hour))) flags.push("closed_hours");
      if (medOrder !== null && medOrder > 0
          && gross >= RULES.ticketFloorSar && gross >= medOrder * RULES.ticketFactor) flags.push("big_ticket");

      const row = {
        orderId: o.order_id, receipt: o.receipt, day: o.day, time: o.time, hour: num(o.hour),
        phone: o.pn || null, name: o.cname || null, group: o.grp,
        groupLabel: GROUP_LABELS[o.grp], cashier: o.cashier || null,
        gross: money(gross), discount: money(disc), paid: money(o.total),
        pct: pct === null ? null : round4(pct),
        medianOrderGross: medOrder === null ? null : money(medOrder),
        flags,
      };
      for (const f of flags) flagRows[f].push(row);

      if (!people.has(pn)) {
        people.set(pn, {
          phone: o.pn || null, name: o.cname || "—", group: o.grp, groupLabel: GROUP_LABELS[o.grp],
          orders: 0, discountedOrders: 0, gross: 0, discount: 0, paid: 0,
          days: new Set(), firstDay: o.day, lastDay: o.day, maxOrderGross: 0, flags: new Set(),
        });
      }
      const p = people.get(pn);
      p.orders++; if (disc > 0) p.discountedOrders++;
      p.gross += gross; p.discount += disc; p.paid += num(o.total);
      p.days.add(o.day);
      p.maxOrderGross = Math.max(p.maxOrderGross, gross);
      if (o.day < p.firstDay) p.firstDay = o.day;
      if (o.day > p.lastDay) p.lastDay = o.day;
      for (const f of flags) p.flags.add(f);

      const k = dayKey(pn, o.day);
      if (!perDay.has(k)) perDay.set(k, { pn, day: o.day, orders: 0, gross: 0, discount: 0, flags: [] });
      const d = perDay.get(k);
      d.orders++; d.gross += gross; d.discount += disc;
    }

    // Day-level spike, against the person's own median day.
    for (const d of perDay.values()) {
      const b = baseline.get(d.pn) || null;
      const med = b ? nOrNull(b.med_day_disc) : null;
      if (med !== null && med > 0 && d.discount >= RULES.spikeFloorSar && d.discount >= med * RULES.spikeFactor) {
        d.flags.push("spike_vs_self");
        const p = people.get(d.pn);
        if (p) p.flags.add("spike_vs_self");
        flagRows.spike_vs_self.push({
          phone: p?.phone || null, name: p?.name || "—", group: p?.group || "staff",
          groupLabel: GROUP_LABELS[p?.group] || GROUP_LABELS.staff,
          day: d.day, orders: d.orders, gross: money(d.gross), discount: money(d.discount),
          medianDayDiscount: money(med), timesMedian: round3(d.discount / med),
        });
      }
    }

    // Behaviour change — only meaningful once the window is a week or more AND
    // the equal-length period before it is actually covered by the cache.
    const windowDays = spanDays(from, to);
    const newHabitComparable = windowDays >= 7 && priorCovered;
    if (newHabitComparable) {
      for (const p of people.values()) {
        const before = prior.get(p.phone) ?? 0;
        if (before <= RULES.newHabitPriorDays && p.days.size >= RULES.newHabitWindowDays) {
          p.flags.add("new_habit");
          flagRows.new_habit.push({
            phone: p.phone, name: p.name, group: p.group, groupLabel: GROUP_LABELS[p.group],
            daysBefore: before, daysNow: p.days.size,
            discount: money(p.discount), priorFrom, priorTo,
          });
        }
      }
    }

    // Outsiders on the staff rate.
    for (const o of outsiders) {
      const row = {
        orderId: o.order_id, receipt: o.receipt, day: o.day, time: o.time,
        phone: o.pn || null, name: o.cname || null, cashier: o.cashier || null,
        gross: money(o.gross_incl), discount: money(o.discount_incl), paid: money(o.total),
        pct: round4(num(o.discount_incl) / num(o.gross_incl)),
      };
      flagRows.unlisted_staff_rate.push(row);
      if (!o.pn && !o.cname) flagRows.no_identity.push(row);
    }

    /* ── shape the people list ─────────────────────────────────────────────── */

    const totalDiscount = orders.reduce((a, o) => a + num(o.discount_incl), 0);
    const peopleOut = [...people.values()].map((p) => {
      const b = baseline.get(p.phone) || null;
      return {
        phone: p.phone, name: p.name, group: p.group, groupLabel: p.groupLabel,
        orders: p.orders, discountedOrders: p.discountedOrders, days: p.days.size,
        gross: money(p.gross), discount: money(p.discount), paid: money(p.paid),
        avgOrderGross: p.orders ? money(p.gross / p.orders) : null,
        avgPerDay: p.days.size ? money(p.discount / p.days.size) : null,
        maxOrderGross: money(p.maxOrderGross),
        firstDay: p.firstDay, lastDay: p.lastDay,
        share: ratio(p.discount, totalDiscount),
        // The person's OWN normal, shipped so the reader can check the flag
        // rather than trust it (business rule 3: null when they have no history).
        medianDayDiscount: b ? (nOrNull(b.med_day_disc) === null ? null : money(b.med_day_disc)) : null,
        medianOrderGross: b ? (nOrNull(b.med_order_gross) === null ? null : money(b.med_order_gross)) : null,
        lifetimeOrders: b ? num(b.lifetime_orders) : 0,
        lifetimeDays: b ? num(b.lifetime_days) : 0,
        flags: [...p.flags],
      };
    }).sort((a, b) => b.discount - a.discount);

    const seen = new Set(peopleOut.map((p) => p.phone).filter(Boolean));
    const neverBought = members
      .filter((m) => !seen.has(m.phone_norm))
      .map((m) => ({ phone: m.phone_norm, name: m.cname || "—", group: m.grp, groupLabel: GROUP_LABELS[m.grp] }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));

    const byGroup = ["owners", "staff"].map((gk) => {
      const rows = peopleOut.filter((p) => p.group === gk);
      return {
        group: gk, label: GROUP_LABELS[gk],
        members: members.filter((m) => m.grp === gk).length,
        buyers: rows.length,
        orders: rows.reduce((a, p) => a + p.orders, 0),
        gross: money(rows.reduce((a, p) => a + p.gross, 0)),
        discount: money(rows.reduce((a, p) => a + p.discount, 0)),
        paid: money(rows.reduce((a, p) => a + p.paid, 0)),
      };
    });

    const flags = Object.entries(flagRows)
      .filter(([, rows]) => rows.length > 0)
      .map(([code, rows]) => ({
        code, ...FLAG_META[code],
        count: rows.length,
        // The riyals riding on the flag, so it can be ranked by damage rather
        // than by row count — costing.js's /health does the same.
        valueSar: money(rows.reduce((a, r) => a + num(r.discount), 0)),
        rows: rows.slice(0, 60),
        truncated: rows.length > 60,
      }))
      .sort((a, b) => (a.severity === b.severity ? b.valueSar - a.valueSar : a.severity === "high" ? -1 : 1));

    const gross = orders.reduce((a, o) => a + num(o.gross_incl), 0);
    return {
      kind: "staff_purchases_discount",
      from, to, days: windowDays,
      rules: { ...RULES, staffPct: band },
      openHours: [...oh.hours].sort((a, b) => a - b),
      // Whether the "new habit" test could run at all, and against what.
      newHabit: {
        comparable: newHabitComparable,
        priorFrom, priorTo, cacheStart,
        reason: newHabitComparable ? null
          : (windowDays < 7 ? "الفترة أقصر من أسبوع — مفيش «قبل» نقارن بيه"
                            : "بيانات الطلبات مابتوصلش لفترة المقارنة السابقة"),
      },
      totals: {
        orders: orders.length,
        discountedOrders: orders.filter((o) => num(o.discount_incl) > 0).length,
        gross: money(gross),
        discount: money(totalDiscount),
        paid: money(orders.reduce((a, o) => a + num(o.total), 0)),
        // The share of menu value actually given away — the only denominator
        // where "we gave away 50%" means 50%.
        discountRatio: ratio(totalDiscount, gross),
        people: peopleOut.length,
        members: members.length,
        discountPerDay: money(totalDiscount / windowDays),
        flagged: flags.reduce((a, f) => a + f.count, 0),
      },
      byGroup, people: peopleOut, neverBought, flags,
      orders: orders.map((o) => ({
        orderId: o.order_id, receipt: o.receipt, day: o.day, time: o.time,
        phone: o.pn || null, name: o.cname || "—", group: o.grp, groupLabel: GROUP_LABELS[o.grp],
        cashier: o.cashier || null,
        gross: money(o.gross_incl), discount: money(o.discount_incl), paid: money(o.total),
        pct: num(o.gross_incl) > 0 ? round4(num(o.discount_incl) / num(o.gross_incl)) : null,
      })),
      vat: "incl",
      note: "ده إيراد متنازل عنه بسعر المنيو شامل الضريبة. مايتجمعش مع تكلفة وجبات الموظفين — دي مواد خام بدون ضريبة.",
    };
  }

  /* GET /api/staff-purchases/report?from&to */
  app.get("/api/staff-purchases/report", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    if (from > to) return c.json({ ok: false, error: "from_after_to" }, 400);
    if (spanDays(from, to) > 400) return c.json({ ok: false, error: "range_too_long" }, 400);
    return c.json({ ok: true, ...(await purchasesReport(from, to)) });
  });

  /* GET /api/staff-purchases/day?date=
     The single-day slice, shaped like a /api/day block: a `summary` of scalars
     plus short Arabic `highlights` built only from numbers that are already in
     the payload, so the owner can always point at what produced the sentence. */
  app.get("/api/staff-purchases/day", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const date = dayArg(c.req.query("date"), todayISO());
    const r = await purchasesReport(date, date);

    const owners = r.byGroup.find((g) => g.group === "owners") || { discount: 0, orders: 0 };
    const staff = r.byGroup.find((g) => g.group === "staff") || { discount: 0, orders: 0 };

    const highlights = [];
    for (const f of r.flags) {
      highlights.push({
        type: f.severity === "high" ? "warn" : "info",
        code: f.code,
        text: `${f.label}: ${f.count} طلب بقيمة ${Math.round(f.valueSar)} ريال.`,
      });
    }
    if (!highlights.length && r.totals.orders > 0) {
      highlights.push({
        type: "info", code: "normal",
        text: `${r.totals.orders} طلب موظفين وملاك بخصم ${Math.round(r.totals.discount)} ريال — مفيش حاجة خارجة عن المعتاد.`,
      });
    }
    if (!r.totals.orders) {
      highlights.push({ type: "info", code: "empty", text: "مفيش أي طلب موظفين أو ملاك في اليوم ده." });
    }

    return c.json({
      ok: true, kind: r.kind, date,
      summary: {
        orders: r.totals.orders,
        gross: r.totals.gross,
        discount: r.totals.discount,
        paid: r.totals.paid,
        discountRatio: r.totals.discountRatio,
        people: r.totals.people,
        ownersDiscount: owners.discount,
        ownersOrders: owners.orders,
        staffDiscount: staff.discount,
        staffOrders: staff.orders,
        flagged: r.totals.flagged,
      },
      highlights,
      flags: r.flags.map((f) => ({ code: f.code, label: f.label, severity: f.severity, count: f.count, valueSar: f.valueSar, why: f.why })),
      people: r.people,
      orders: r.orders,
      vat: "incl",
      note: r.note,
    });
  });
}

export default { register };
