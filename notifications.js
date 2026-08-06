/* ═══════════════════════════════════════════════════════════════════════════
   NOTIFICATIONS — the one place that tells Omar what he needs to know.

   Registered by index.js via `register(app, ctx)`. Everything is admin-only.

   ── THE PROBLEM THIS FILE IS TRYING NOT TO CAUSE ──────────────────────────
   This system already knows a great deal: portal state, order flow, refunds,
   reconciliation gaps, discount reasons, sync health, 121 open costing tasks.
   Piping all of that into a list produces 200 rows nobody reads, and a
   notification tab nobody reads is worse than none — it makes the real alarm
   invisible. So the whole substance of this module is the *choice* of what is
   allowed to interrupt, and every threshold below was measured against live
   history before it was written down. The numbers are in RULES[].calibration
   and are served to the UI, so the reasoning is readable, not folklore.

   Three rules governed every decision:

   1. AN ALERT MUST NAME AN ACTION. "Revenue was up 40%" is interesting and is
      not here. "Keeta says the store is closed while the kitchen is taking
      orders" is a phone call, and is.
   2. AN ALERT MUST SCALE ITSELF. A fixed "no orders for 3 hours" threshold is
      right for Keeta (6 orders/day) and absurd for Ninja (2 orders/MONTH).
      Every flow rule is expressed against the channel's own measured rate, so
      a thin channel simply never trips it.
   3. AN ALERT MUST GO AWAY. Anything describing a *condition* auto-resolves
      when the condition lifts, and says so, instead of lingering as a lie.

   ── DEDUPLICATION ─────────────────────────────────────────────────────────
   Same idea as costing.js's cw_tasks, which solved this problem well: one row
   per fingerprint (`kind|scope`), upserted on every run, never re-inserted.
   What is different here is that this list has a READ STATE, so "already
   raised" is not enough — the row must also stop demanding attention once
   read, and start demanding it again only when something materially changed.

   That is done with `changed_at` vs the reader's `read_changed_at`:
     unread  ⇔  no read row, OR read row is older than the row's changed_at
   and `changed_at` only moves when the BUCKETED payload changes (SAR rounded
   to 25, hours to 1, percent to 1) or when a resolved row fires again. A
   silence that grows from 9.1h to 9.3h is the same news; one that grows from
   9h to 14h is not.

   ── AUTO-RESOLVE IS SCOPED ────────────────────────────────────────────────
   Each rule belongs to a `source`. A cycle may only close rows belonging to
   sources that RAN AND SUCCEEDED in that cycle. If the Keeta portal times out,
   its rows are left exactly as they were rather than being cheerfully marked
   "problem solved" — the most dangerous bug this file could have is telling
   Omar a store reopened because we failed to check.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { checkAll as checkPortals } from "./portals.js";

const TZ = "Asia/Riyadh";
const BIZ_DAY_START_HOUR = 4;   // TabSense rolls the business day at 04:00 Riyadh.

/* The trading window, in Riyadh wall-clock hours, measured from 28 days of
   ts_orders: hours 13→01 carry 660 of 665 orders. Hour 12 sees 7 orders in 28
   days and hours 03–11 see four in total, so treating them as "open" would
   make every morning look like an outage. */
const TRADE_START_H = 13;
const TRADE_END_H = 2;          // exclusive; the window is [13:00, 02:00)
const TRADE_HOURS = 13;

// See analytics.js business rule 2 — a void never happened and a refund is the
// reversal of an order already counted on its own day.
const SALES_ONLY =
  `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

const DELIVERY_APPS = ["ninja", "keeta", "hungerstation", "jahez", "toyou", "mrsool", "careem"];

// Which app an order came through — the same expression analytics.js uses, so
// a notification and the insights page can never disagree about a channel.
const CHANNEL_SQL = `
  lower(COALESCE(
    NULLIF(s.source_note, ''),
    (SELECT k FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY($CH_APPS)),
    CASE WHEN o.order_type ILIKE '%external%' THEN 'external' ELSE 'inhouse' END))`;

const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;
const median = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

/* Riyadh wall clock as a plain object. Node has no zoned Date, and the whole
   file needs "what hour is it in Jeddah" repeatedly. */
function riyadhNow(at = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(at).reduce((a, x) => (a[x.type] = x.value, a), {});
  return {
    iso: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}
const inTradingWindow = (r) => r.hour >= TRADE_START_H || r.hour < TRADE_END_H;

/** Hours between two instants that fall inside the trading window. Sampled at
 *  10-minute resolution, which is far finer than any threshold here needs. */
function tradingHoursBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date) || b <= a) return 0;
  const spanH = (b - a) / 3600000;
  if (spanH > 24 * 14) return TRADE_HOURS * 14;   // guard against a cold table
  let h = 0;
  for (let t = a.getTime() + 300000; t < b.getTime(); t += 600000) {
    if (inTradingWindow(riyadhNow(new Date(t)))) h += 1 / 6;
  }
  return h;
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE CATALOGUE.

   Served verbatim by GET /api/notifications/rules so Omar can read why every
   alert exists, what makes it fire, and what it was measured against. If a
   threshold below ever gets tuned, this text is the thing that must be tuned
   with it — the explanation is not documentation of the code, it IS the
   specification.
═══════════════════════════════════════════════════════════════════════════ */
const RULES = [
  {
    kind: "PORTAL_CLOSED", source: "portals", mode: "state", severity: "critical",
    titleAr: "متجر مقفول على منصة توصيل",
    whyAr: "المنصة نفسها بتقول إن المتجر مقفول والمطبخ شغال دلوقتي — كل ساعة دي طلبات ضايعة.",
    reasonAr: "ده أغلى إنذار في القايمة: المطعم بيشتغل والمنصة مش بتوصّل ليه طلبات. "
      + "بيشتغل بس جوّه ساعات العمل ولما تكون في طلبات فعلية على قناة تانية في آخر ٩٠ دقيقة — "
      + "يعني عندنا دليل إن المطبخ شغال، مش مجرد إننا فاكرين إنه المفروض يشتغل.",
    calibration: "نافذة العمل ١:٠٠ ظهراً → ٢:٠٠ فجراً (٦٦٠ من ٦٦٥ طلب في ٢٨ يوم داخلها).",
  },
  {
    kind: "PORTAL_BLIND", source: "portals", mode: "state", severity: "high",
    titleAr: "مش قادرين نقرأ حالة منصة",
    whyAr: "التوكن أو الجلسة انتهت، فمابقاش عندنا أي طريقة نعرف بيها إن المتجر مقفول.",
    reasonAr: "كاشف عطلان بيبان سليم أخطر من إنه مايكونش موجود. لما نفشل في قراءة المنصة، "
      + "إنذار «متجر مقفول» بتاعها بيبقى مش قادر يشتغل — فالعمى نفسه هو الخبر.",
    calibration: "توكن نينجا بيعيش ٢٤ ساعة وكوكيز كيتا بتلغى بالمخاطرة — الحالتين بيحصلوا فعلاً.",
  },
  {
    kind: "SYNC_STALLED", source: "sync", mode: "state", severity: "critical",
    titleAr: "المزامنة واقفة",
    whyAr: "آخر مرة الخادم كتب فيها طلب من TabSense بقى لها وقت طويل — كل الأرقام بعد كده قديمة.",
    reasonAr: "لما المزامنة تقف، كل صفحة في النظام بتفضل تعرض أرقام تبان صح وهي بايتة. "
      + "مافيش حاجة بتنبّه على ده غير إن حد يلاحظ إن الأرقام مش بتتحرك — وده بياخد أيام.",
    calibration: "الوركر بيلف كل ٥ دقايق؛ الحد ٤٥ دقيقة يعني ٩ دورات فايتة قبل ما نتكلم.",
  },
  {
    kind: "CHANNEL_SILENT", source: "flow", mode: "state", severity: "high",
    titleAr: "قناة توصيل ساكتة وهي مفتوحة",
    whyAr: "المتجر مفتوح على المنصة ومع ذلك مافيش طلبات، بالقدر اللي معدّلها بيقول إنه مش صدفة.",
    reasonAr: "الحد هنا مش «٣ ساعات» — الحد هو عدد الطلبات المتوقعة: معدّل القناة نفسها × "
      + "ساعات السكوت جوّه نافذة العمل. لازم يبقى المتوقع ٤ طلبات على الأقل قبل ما نتكلم. "
      + "كده قناة بتعمل طلبين في الشهر عمرها ما هتنبّه، وكيتا بتنبّه بعد ٩ ساعات صمت.",
    calibration: "٢٨ يوم: كيتا ٠.٤٥ طلب/ساعة → ٥ حالات؛ هنقرستيشن ٠.٠٢ → صفر؛ نينجا ٠.٠٠٥ → صفر.",
  },
  {
    kind: "REVENUE_DROP", source: "flow", mode: "event", severity: "high",
    titleAr: "يوم مبيعاته أقل بكتير من مستواه",
    whyAr: "اليوم ده قفل على أقل من نص المتوسط بتاع آخر ٢١ يوم.",
    reasonAr: "أول تصميم كان بيقارن بمتوسط نفس اليوم من الأسبوع، فطلع ٢٩ إنذار في ١٠٥ يوم — "
      + "لأن المطعم في نمو، فأي يوم بيكسر متوسط قديم. والأغلبية كانت أيام كويسة، واليوم الكويس "
      + "مش محتاج تصرّف. فبقى الإنذار على النزول بس، ومقارنة بالمستوى الحالي مش بمتوسط بايت.",
    calibration: "١٠٥ يوم: نزول ≥٤٥٪ عن متوسط ٢١ يوم = ٣ إنذارات فقط. النسخة القديمة كانت ٢٩.",
  },
  {
    kind: "KEETA_REFUND", source: "keeta", mode: "event", severity: "high",
    titleAr: "استرجاع جديد على كيتا",
    whyAr: "طلب اترجّع للعميل — والفلوس دي بتخرج من حسابنا في التسوية.",
    reasonAr: "شاشة الطلب في بوابة كيتا مش بتعرف الاسترجاع: بتفضل تعرض الأرباح الأصلية كاملة "
      + "حتى بعد ما التسوية تدفع صفر. فالاسترجاع مش هيتشاف غير في يوم الفلوس، بعد أسابيع.",
    calibration: "٣ استرجاعات في ٢١ يوم — اتنين منهم إلغاء كامل (٨٨ و١٣٥ ريال، الأرباح بقت صفر).",
  },
  {
    kind: "KEETA_RATE_SHIFT", source: "keeta", mode: "state", severity: "high",
    titleAr: "نسبة عمولة كيتا اتغيّرت",
    whyAr: "نسبة العمولة الفعلية في يوم بعيدة عن اللي كيتا نفسها ماشية عليه آخر ٢٨ يوم.",
    reasonAr: "بيقارن كيتا بنفسها، مش بعقد مكتوب. ده مقصود: أرقام العقد المخزّنة فيها "
      + "افتراضات، والاختبار ده مابيرثش الافتراضات دي — لو النسبة اتحرّكت، اتحرّكت.",
    calibration: "أيام بـ ٨ طلبات فأكتر: النسبة بين ١٨.٠٪ و١٨.٧٥٪، الوسيط ١٨.٢٪، أقصى انحراف "
      + "٠.٥٪. الحد ١.٥٪ — يعني مابينبّهش على البيانات الحالية خالص، وده المطلوب.",
  },
  {
    kind: "KEETA_PAYOUTS_STALE", source: "keeta", mode: "state", severity: "medium",
    titleAr: "بيانات تسويات كيتا قديمة",
    whyAr: "بقى لنا فترة من غير ما نسحب التسويات، فأي استرجاع بعد التاريخ ده إحنا عميان عنه.",
    reasonAr: "موجود عشان إنذار الاسترجاع اللي فوق يفضل صادق. من غيره، قايمة استرجاعات فاضية "
      + "ممكن تتقري «مافيش استرجاعات» وهي في الحقيقة «مابصّيناش».",
    calibration: "آخر سحب وقت الكتابة كان بقى له ٤ أيام — يعني الحالة دي بتحصل فعلاً.",
  },
  {
    kind: "STAFF_NO_CUSTOMER", source: "staff", mode: "state", severity: "medium",
    titleAr: "كاشير بيقفل طلبات من غير عميل",
    whyAr: "نسبة الطلبات اللي اتقفلت من غير عميل عند الموظف ده تحت هدف ٩٠٪.",
    reasonAr: "مش كل طلب على حدة — ده كان هيبقى مئات الصفوف. صف واحد لكل موظف على مدى ٧ أيام، "
      + "بيقفل لوحده لما يتحسّن. والرقم اللي بيهم هو قيمة الطلبات المجهولة بالريال: دي فلوس "
      + "اتباعت لناس مانقدرش نكلّمهم تاني.",
    calibration: "الرقم اتحرّك فعلاً: من ٥٢٪ من ٥ أسابيع لـ ٩٥٪ الأسبوع ده — والإنذار ساكت دلوقتي.",
  },
  {
    kind: "FULL_COMP_UNEXPLAINED", source: "discounts", mode: "event", severity: "high",
    titleAr: "ضيافة ١٠٠٪ من غير تفسير",
    whyAr: "طلب اتخصم عليه بالكامل وصاحبه مش في أي مجموعة داخلية معروفة.",
    reasonAr: "الضيافة الكاملة عادية لمؤثر أو مالك وغير عادية لأي حد تاني. النظام دلوقتي "
      + "بيصنّف أي خصم ١٠٠٪ على إنه «مؤثرين» بحكم قاعدة fullCompIsInfluencer — يعني بيفترض. "
      + "ومافيش مجموعة مؤثرين أصلاً في customer_groups تتحقق منها. الإنذار ده بيسأل السؤال "
      + "اللي الافتراض ده بيغطّي عليه.",
    calibration: "٢١ يوم: ٤ ضيافات كاملة — واحدة لمالك (اتسكتت)، وتلاتة لعملاء بلا مجموعة "
      + "(٣٥٦ و٢٨٩ و١٨٦ ريال).",
  },
  {
    kind: "COSTING_NEW_BIG", source: "costing", mode: "state", severity: "medium",
    titleAr: "ملاحظة تكاليف جديدة وكبيرة",
    whyAr: "بند جديد ظهر في قايمة التكاليف قيمته كبيرة، ولسه ماتفتحش.",
    reasonAr: "قايمة التكاليف فيها ١٢١ بند ولها صفحتها وترتيبها — نقلها هنا كان هيغرق كل حاجة "
      + "تانية. اللي بيعدّي بس: بند جديد (آخر ٧٢ ساعة) وقيمته ٣٠٠ ريال فأكتر، وبحد أقصى ٥ صفوف.",
    calibration: "cw_tasks: ١٣٠ بند اتعملوا يوم ٢ أغسطس، ٧ يوم ٣، واحد يوم ٥ — الفلتر ده "
      + "بيطلّع صفر أو واحد.",
  },
  {
    kind: "NINJA_LEAK", source: "reconcile", mode: "state", severity: "high",
    titleAr: "طلبات نينجا مش موجودة عندنا",
    whyAr: "المنصة عندها طلبات مالهاش أثر في الكاشير — دي فلوس اتحصّلت ومش متسجلة.",
    reasonAr: "أي حاجة عند المنصة ومش عندنا هي تسريب حقيقي. بيتشغّل بس في التوليد اليدوي "
      + "(deep) لأنه بينده بوابة نينجا وبيجيب تقرير CSV — حاجة مالهاش لازمة كل ٥ دقايق.",
    calibration: "آخر فحص: ٢ طلب عندهم، ٢ عندنا، فرق صفر. الحالة اللي فاتت كانت طلب بـ ١٤٢ ريال.",
  },
];
const RULE_BY_KIND = Object.fromEntries(RULES.map((r) => [r.kind, r]));

/* Bucketing for "did this materially change". A silence that grows 9.1h → 9.3h
   is the same news; 9h → 14h is not. Without this every generator run would
   mark everything unread again and the read state would be worthless. */
function bucket(v, unit) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  if (unit === "sar") return String(Math.round(n / 25) * 25);
  if (unit === "hours") return String(Math.round(n));
  if (unit === "pct") return String(Math.round(n));
  return String(Math.round(n));
}

export function register(app, ctx) {
  const { pool, requireAdmin } = ctx;

  /* ── Schema ──────────────────────────────────────────────────────────────
     Two tables. The notification is global (one row per condition); the read
     state is per user, so two people do not clear each other's inbox. */
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nt_notifications (
        id            TEXT PRIMARY KEY,
        fingerprint   TEXT NOT NULL UNIQUE,
        kind          TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT '',
        -- 'state' auto-resolves when the condition lifts. 'event' never does:
        -- a refund or a bad day was never a condition, so "it stopped being
        -- true" is a meaningless sentence about it.
        mode          TEXT NOT NULL DEFAULT 'state',
        severity      TEXT NOT NULL DEFAULT 'info',
        title_ar      TEXT NOT NULL DEFAULT '',
        why_ar        TEXT NOT NULL DEFAULT '',
        -- The number that makes it matter. NULL means there genuinely is no
        -- number — it is never coerced to 0, which would read as "SAR 0".
        metric_value  NUMERIC,
        metric_unit   TEXT NOT NULL DEFAULT '',
        metric_label  TEXT NOT NULL DEFAULT '',
        link_hash     TEXT NOT NULL DEFAULT '',
        link_label    TEXT NOT NULL DEFAULT '',
        evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
        state         TEXT NOT NULL DEFAULT 'active',   -- active | resolved
        resolved_at   TIMESTAMPTZ,
        resolved_note TEXT NOT NULL DEFAULT '',
        payload_hash  TEXT NOT NULL DEFAULT '',
        occurrences   INT NOT NULL DEFAULT 1,
        event_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- The clock the read state is compared against. See the header.
        changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS nt_notif_state_idx  ON nt_notifications(state, changed_at DESC);
      CREATE INDEX IF NOT EXISTS nt_notif_source_idx ON nt_notifications(source, state);

      CREATE TABLE IF NOT EXISTS nt_reads (
        notification_id TEXT NOT NULL,
        user_key        TEXT NOT NULL,
        read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- The changed_at that was current when it was read. If the row later
        -- changes materially, this falls behind and the row is unread again.
        read_changed_at TIMESTAMPTZ,
        PRIMARY KEY (notification_id, user_key)
      );

      CREATE TABLE IF NOT EXISTS nt_runs (
        id         TEXT PRIMARY KEY,
        ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deep       BOOLEAN NOT NULL DEFAULT FALSE,
        sources_ok TEXT NOT NULL DEFAULT '',
        sources_failed JSONB NOT NULL DEFAULT '{}'::jsonb,
        raised     INT NOT NULL DEFAULT 0,
        resolved   INT NOT NULL DEFAULT 0,
        ms         INT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS nt_runs_at_idx ON nt_runs(ran_at DESC);
    `);
  }
  const schemaReady = ensureSchema()
    .then(() => console.log("[notifications] schema ready"))
    .catch((e) => console.error("[notifications] schema failed:", e.message));

  // A single ADMIN_TOKEN backs every admin caller, so there is no user id to
  // key read state on. The caller may name itself; "admin" is the default
  // inbox. This keeps the read state per-user-shaped without inventing an
  // auth system that belongs to index.js.
  const userKey = (c) =>
    String(c.req.query("user") || c.req.header("X-Notif-User") || "admin")
      .trim().slice(0, 64) || "admin";

  /* ═══════════════════════════════════════════════════════════════════════
     RAISING

     A candidate is `{ kind, scope, severity, titleAr, whyAr, metric, unit,
     metricLabel, link, linkLabel, evidence, eventAt }`. The fingerprint is
     kind|scope, so the same condition owns one row for life.
     ═════════════════════════════════════════════════════════════════════ */
  async function raise(cand, stamp) {
    const rule = RULE_BY_KIND[cand.kind] || {};
    const fp = `${cand.kind}|${cand.scope}`;
    const id = `nt_${hash(fp).slice(0, 16)}`;
    const severity = cand.severity || rule.severity || "info";
    // What counts as "materially different" — severity plus the bucketed
    // number. Deliberately NOT the title or the why text, so a wording change
    // in this file never marks Omar's whole inbox unread on the next deploy.
    const payload = `${severity}|${bucket(cand.metric, cand.unit)}`;
    const ph = hash(payload);

    const prev = (await pool.query(
      "SELECT id, state, payload_hash, occurrences FROM nt_notifications WHERE fingerprint = $1",
      [fp])).rows[0];

    // Two things make a row demand attention again: the payload moved, or a
    // resolved condition came back. Anything else is the same news.
    const material = !prev || prev.payload_hash !== ph || prev.state === "resolved";

    await pool.query(
      `INSERT INTO nt_notifications
         (id, fingerprint, kind, source, mode, severity, title_ar, why_ar,
          metric_value, metric_unit, metric_label, link_hash, link_label,
          evidence, state, resolved_at, resolved_note, payload_hash,
          occurrences, event_at, last_seen_at, changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
               'active',NULL,'',$15,1,$16,$17,$17)
       ON CONFLICT (fingerprint) DO UPDATE SET
         severity=EXCLUDED.severity, title_ar=EXCLUDED.title_ar,
         why_ar=EXCLUDED.why_ar, metric_value=EXCLUDED.metric_value,
         metric_unit=EXCLUDED.metric_unit, metric_label=EXCLUDED.metric_label,
         link_hash=EXCLUDED.link_hash, link_label=EXCLUDED.link_label,
         evidence=EXCLUDED.evidence, state='active', resolved_at=NULL,
         resolved_note='', payload_hash=EXCLUDED.payload_hash,
         event_at=EXCLUDED.event_at, last_seen_at=EXCLUDED.last_seen_at,
         occurrences   = nt_notifications.occurrences + ($18::int),
         changed_at    = CASE WHEN $18::int = 1 THEN EXCLUDED.changed_at
                              ELSE nt_notifications.changed_at END`,
      [id, fp, cand.kind, rule.source || cand.source || "", rule.mode || "state",
       severity, cand.titleAr || rule.titleAr || "", cand.whyAr || rule.whyAr || "",
       cand.metric === null || cand.metric === undefined ? null : round2(cand.metric),
       cand.unit || "", cand.metricLabel || "",
       cand.link || "", cand.linkLabel || "",
       JSON.stringify(cand.evidence || {}), ph,
       cand.eventAt ? new Date(cand.eventAt) : stamp, stamp,
       material ? 1 : 0]);
    return material;
  }

  /** Close every 'state' row of a source that this cycle did NOT re-raise.
   *  Only ever called for sources that ran and succeeded. */
  async function resolveStale(source, stamp) {
    const r = await pool.query(
      `UPDATE nt_notifications
          SET state='resolved', resolved_at=NOW(),
              resolved_note='المشكلة دي مابقتش موجودة',
              -- A cleared critical/high is worth seeing once, so it goes
              -- unread again. A cleared medium/info is not actionable news,
              -- so it clears quietly and does not re-ping.
              changed_at = CASE WHEN severity IN ('critical','high')
                                THEN NOW() ELSE changed_at END
        WHERE source = $1 AND mode = 'state' AND state = 'active'
          AND last_seen_at < $2
        RETURNING id`, [source, stamp]);
    return r.rowCount;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     THE SOURCES
     ═════════════════════════════════════════════════════════════════════ */

  /** Is the kitchen demonstrably trading right now? Used to suppress every
   *  "channel is down" alert during hours when nothing is running anyway.
   *  Without it, "closed" and "not open yet" look identical. */
  async function kitchenIsTrading(minutes = 90) {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM ts_orders o
        WHERE ${SALES_ONLY} AND o.order_date >= NOW() - ($1 || ' minutes')::interval`,
      [String(minutes)]);
    return num(r.rows[0]?.n) > 0;
  }

  /* ── portals: closed while trading, or unreadable ───────────────────── */
  async function sourcePortals(stamp) {
    const portals = await checkPortals();
    const rNow = riyadhNow();
    const trading = inTradingWindow(rNow) && (await kitchenIsTrading(90));

    for (const p of portals) {
      if (p.state === "unconfigured") continue;   // a setup state, not news
      if (p.state === "error") {
        await raise({
          kind: "PORTAL_BLIND", scope: p.id, metric: null,
          titleAr: `مش قادرين نقرأ حالة ${p.label}`,
          whyAr: `${p.detail} — يعني إنذار «المتجر مقفول» بتاع ${p.label} مش شغّال دلوقتي.`,
          metricLabel: "بدون رقم — دي حالة عمى مش خسارة محسوبة",
          link: "#manager", linkLabel: "صفحة المدير",
          evidence: { portal: p.id, detail: p.detail },
        }, stamp);
      } else if (p.state === "closed" && trading) {
        await raise({
          kind: "PORTAL_CLOSED", scope: p.id, metric: null,
          titleAr: `${p.label}: المتجر مقفول والمطبخ شغال`,
          whyAr: `${p.detail} — وفي طلبات فعلاً بتتعمل على قنوات تانية آخر ٩٠ دقيقة.`,
          metricLabel: "كل ساعة قفل في وقت الذروة = طلبات ضايعة",
          link: "#manager", linkLabel: "صفحة المدير",
          evidence: { portal: p.id, detail: p.detail, riyadhHour: rNow.hour },
        }, stamp);
      }
    }
    return { checked: portals.length, trading };
  }

  /* ── sync: has the worker written anything lately? ──────────────────────
     Read from ts_orders.updated_at rather than the worker's in-memory state,
     because that state lives in index.js and this module does not get it.
     The worker re-upserts the recent window every cycle and the upsert always
     sets updated_at=NOW(), so max(updated_at) is a true "last wrote" clock —
     verified against /api/insights/status, which agreed to the second. */
  async function sourceSync(stamp) {
    const r = (await pool.query(
      `SELECT max(updated_at) AS last_write,
              round(extract(epoch from (now() - max(updated_at)))/60.0, 1) AS mins
         FROM ts_orders`)).rows[0];
    const mins = num(r?.mins);
    const LIMIT_MIN = 45;         // 9 missed 5-minute cycles
    if (r?.last_write && mins > LIMIT_MIN) {
      await raise({
        kind: "SYNC_STALLED", scope: "tabsense",
        metric: Math.round(mins), unit: "",         // minutes; bucketed to the minute
        metricLabel: "دقيقة من غير أي كتابة",
        titleAr: `المزامنة واقفة من ${Math.round(mins)} دقيقة`,
        whyAr: "آخر كتابة من TabSense كانت من فترة — كل رقم في النظام دلوقتي أقدم من كده.",
        link: "#manager", linkLabel: "صفحة المدير",
        evidence: { lastWrite: r.last_write, minutesStale: mins, limitMin: LIMIT_MIN },
      }, stamp);
    }
    return { minutesStale: mins };
  }

  /* ── flow: channel silence + revenue drop ───────────────────────────── */
  async function sourceFlow(stamp) {
    const out = {};

    /* ---- channel silence -------------------------------------------------
       Expressed as EXPECTED ORDERS, never as a fixed number of hours: the
       threshold has to mean the same thing on a channel doing 6 orders/day
       and one doing 2 orders/month. lambda = channel rate x silent trading
       hours; P(zero orders | lambda=4) is about 1.8%. */
    let portalState = {};
    try {
      portalState = Object.fromEntries((await checkPortals()).map((p) => [p.id, p.state]));
    } catch { portalState = {}; }

    const rows = (await pool.query(
      `SELECT ch, count(*)::int AS n28, max(order_date) AS last_at FROM (
         SELECT o.order_date, ${CHANNEL_SQL.replace("$CH_APPS", "$1")} AS ch
           FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE ${SALES_ONLY} AND o.calendar_day >= CURRENT_DATE - 28) t
       GROUP BY 1`, [DELIVERY_APPS])).rows;

    const silent = [];
    for (const r of rows) {
      if (!DELIVERY_APPS.includes(r.ch)) continue;         // inhouse has no portal
      if (portalState[r.ch] !== "open") continue;          // closed → PORTAL_CLOSED owns it
      const rate = num(r.n28) / (28 * TRADE_HOURS);
      if (!rate) continue;
      const silentH = tradingHoursBetween(new Date(r.last_at), new Date());
      const lambda = rate * silentH;
      if (lambda < 4) continue;

      // Was the kitchen even running during the silence? If nobody ordered
      // anything anywhere, this is a quiet night, not a broken channel.
      const others = num((await pool.query(
        `SELECT count(*)::int AS n FROM ts_orders o
          WHERE ${SALES_ONLY} AND o.order_date > $1`, [r.last_at])).rows[0]?.n);
      if (others < 3) continue;

      silent.push({ ch: r.ch, lambda, silentH });
      await raise({
        kind: "CHANNEL_SILENT", scope: r.ch,
        severity: lambda >= 8 ? "critical" : "high",
        metric: Math.round(silentH * 10) / 10, unit: "hours",
        metricLabel: "ساعة صمت داخل وقت العمل",
        titleAr: `${r.ch} ساكتة ${Math.round(silentH)} ساعة وهي مفتوحة`,
        whyAr: `بمعدّلها الطبيعي كان المفروض يجي حوالي ${Math.round(lambda)} طلب في المدة دي — وجه صفر، `
             + `و${others} طلب اتعملوا على قنوات تانية في نفس الوقت.`,
        link: "#manager", linkLabel: "صفحة المدير",
        evidence: { channel: r.ch, orders28d: r.n28, ratePerHour: round2(rate),
                    silentTradingHours: round2(silentH), expectedOrders: round2(lambda),
                    ordersElsewhere: others, lastOrderAt: r.last_at },
      }, stamp);
    }
    out.silentChannels = silent;

    /* ---- revenue drop ----------------------------------------------------
       Only COMPLETE business days. A day in progress is always below its own
       norm, so alerting on it would fire every single afternoon. A day D is
       complete once Riyadh time passes D+1 04:00. */
    const days = (await pool.query(
      `SELECT o.calendar_day::text AS d, extract(dow from o.calendar_day)::int AS dow,
              round(sum(o.total)::numeric, 0)::float AS rev
         FROM ts_orders o
        WHERE ${SALES_ONLY} AND o.calendar_day >= CURRENT_DATE - 60
        GROUP BY 1, 2 ORDER BY 1`)).rows;

    const rNow = riyadhNow();
    const lastComplete = new Date(Date.parse(rNow.iso + "T00:00:00Z")
      - (rNow.hour < BIZ_DAY_START_HOUR ? 2 : 1) * 86400000)
      .toISOString().slice(0, 10);

    const DROP = 0.45;
    const LOOKBACK = 21;
    // Only the last three complete days: an alert about a Tuesday two weeks
    // ago is history, not news, and it would land already-stale in the inbox.
    const recent = days.filter((x) => x.d <= lastComplete).slice(-3);
    for (const day of recent) {
      const i = days.findIndex((x) => x.d === day.d);
      const prior = days.slice(Math.max(0, i - LOOKBACK), i).map((x) => x.rev);
      if (prior.length < 10) continue;
      const base = median(prior);
      if (!base || day.rev >= base * (1 - DROP)) continue;

      const dowPeers = days.slice(0, i).filter((x) => x.dow === day.dow).slice(-8).map((x) => x.rev);
      const dowMed = median(dowPeers);
      const gap = base - day.rev;
      await raise({
        kind: "REVENUE_DROP", scope: day.d,
        metric: Math.round(gap), unit: "sar",
        metricLabel: "ريال أقل من المعتاد في اليوم ده",
        titleAr: `${day.d}: المبيعات ${Math.round(day.rev)} ريال بدل ${Math.round(base)}`,
        whyAr: `نزول ${Math.round((1 - day.rev / base) * 100)}٪ عن وسيط آخر ٢١ يوم`
             + (dowMed ? ` (ووسيط نفس اليوم من الأسبوع ${Math.round(dowMed)} ريال).` : "."),
        link: "#manager", linkLabel: "تقرير اليوم",
        eventAt: new Date(day.d + "T20:00:00Z"),
        evidence: { day: day.d, revenue: day.rev, median21d: base,
                    weekdayMedian: dowMed, dropPct: round2(1 - day.rev / base) },
      }, stamp);
    }
    out.lastCompleteDay = lastComplete;
    return out;
  }

  /* ── keeta: refunds, a silent rate change, and blindness to both ────── */
  async function sourceKeeta(stamp) {
    const out = {};

    const fresh = (await pool.query(
      `SELECT max(fetched_at) AS last_fetch, max(keeta_day)::text AS last_day,
              round(extract(epoch from (now() - max(fetched_at)))/86400.0, 1) AS days
         FROM keeta_payouts`)).rows[0];
    const staleDays = num(fresh?.days);
    out.payoutsStaleDays = staleDays;
    if (fresh?.last_fetch && staleDays > 3) {
      await raise({
        kind: "KEETA_PAYOUTS_STALE", scope: "sync",
        metric: Math.round(staleDays), unit: "",     // days
        metricLabel: "يوم من غير سحب تسويات",
        titleAr: `تسويات كيتا مسحوبة آخر مرة من ${Math.round(staleDays)} يوم`,
        whyAr: `آخر يوم عندنا ${fresh.last_day} — أي استرجاع بعده مش هيظهر في القايمة دي.`,
        link: "#manager", linkLabel: "صفحة المدير",
        evidence: { lastFetch: fresh.last_fetch, lastDay: fresh.last_day, staleDays },
      }, stamp);
    }

    /* Refunds. An event, not a condition: it never "stops being true", so it
       is never auto-resolved — it simply ages out of the 21-day lookback and
       stays in the table as history. */
    const refunds = (await pool.query(
      `SELECT order_view_id, order_id, keeta_day::text AS day, order_status, part_refund,
              GREATEST(COALESCE(refunded_to_customer,0), COALESCE(refund_price,0)) AS amt,
              product_price, earnings, rebates_earnings, order_time
         FROM keeta_payouts
        WHERE (jsonb_array_length(refunds) > 0 OR COALESCE(refund_price,0) > 0)
          AND keeta_day >= CURRENT_DATE - 21
        ORDER BY keeta_day DESC LIMIT 25`)).rows;
    out.refunds = refunds.length;

    for (const r of refunds) {
      // Status 50 is a full reversal: Keeta pays us nothing, yet the order
      // screen still shows the original earnings. That gap is the whole point.
      const reversed = Number(r.order_status) === 50;
      const lost = reversed ? num(r.earnings) : Math.max(0, num(r.earnings) - num(r.rebates_earnings));
      const amt = num(r.amt);
      await raise({
        kind: "KEETA_REFUND", scope: r.order_view_id,
        severity: reversed || amt >= 100 ? "high" : "medium",
        metric: round2(lost || amt), unit: "sar",
        metricLabel: reversed ? "ريال أرباح راحت بالكامل" : "ريال أرباح ناقصة بعد الاسترجاع",
        titleAr: reversed
          ? `طلب كيتا اتلغى بالكامل يوم ${r.day} — ${round2(amt)} ريال رجعت للعميل`
          : `استرجاع جزئي على كيتا يوم ${r.day} — ${round2(amt)} ريال`,
        whyAr: reversed
          ? `الأرباح كانت ${round2(r.earnings)} ريال وبقت صفر، بس شاشة الطلب في البوابة لسه بتعرض المبلغ الأصلي.`
          : `قيمة الطلب ${round2(r.product_price)} ريال، والأرباح نزلت من ${round2(r.earnings)} لـ ${round2(r.rebates_earnings)}.`,
        link: "#manager", linkLabel: "تسويات كيتا",
        eventAt: r.order_time || (r.day ? new Date(r.day + "T20:00:00Z") : null),
        evidence: { orderViewId: r.order_view_id, orderId: r.order_id, day: r.day,
                    status: r.order_status, reversedEntirely: reversed,
                    refundedToCustomerSAR: round2(amt),
                    earningsBeforeSAR: round2(r.earnings),
                    earningsAfterSAR: round2(r.rebates_earnings) },
      }, stamp);
    }

    /* Commission rate drift, measured against Keeta's OWN trailing median so
       it inherits none of the contract's assumed figures. */
    const rateRows = (await pool.query(
      `SELECT keeta_day::text AS day, count(*)::int AS n,
              sum(COALESCE(product_price,0) - COALESCE(activity_fee,0)) AS base,
              sum(COALESCE(commission,0)) AS comm
         FROM keeta_payouts
        WHERE COALESCE(user_get_mode,'') <> 'pickup' AND keeta_day >= CURRENT_DATE - 35
        GROUP BY 1 ORDER BY 1`)).rows
      .map((r) => ({ ...r, rate: num(r.base) > 0 ? num(r.comm) / num(r.base) : null }))
      .filter((r) => r.rate !== null && r.n >= 8);   // thin days are pure noise

    if (rateRows.length >= 6) {
      const baseline = median(rateRows.slice(0, -1).map((r) => r.rate));
      const latest = rateRows[rateRows.length - 1];
      const devPp = (latest.rate - baseline) * 100;
      out.keetaRatePp = round2(devPp);
      if (Math.abs(devPp) >= 1.5) {
        await raise({
          kind: "KEETA_RATE_SHIFT", scope: latest.day,
          metric: round2(Math.abs(devPp)), unit: "pct",
          metricLabel: "نقطة مئوية فرق في نسبة العمولة",
          titleAr: `عمولة كيتا يوم ${latest.day} ${(latest.rate * 100).toFixed(1)}٪ بدل ${(baseline * 100).toFixed(1)}٪`,
          whyAr: `على ${latest.n} طلب — الفرق ده على حجم الشهر يساوي `
               + `${Math.round(Math.abs(devPp) / 100 * num(latest.base) * 30)} ريال تقريباً.`,
          link: "#manager", linkLabel: "تدقيق عقد كيتا",
          evidence: { day: latest.day, orders: latest.n, rate: round2(latest.rate),
                      baselineRate: round2(baseline), deviationPp: round2(devPp) },
        }, stamp);
      }
    }
    return out;
  }

  /* ── staff: customers not captured at the counter ───────────────────── */
  async function sourceStaff(stamp) {
    const TARGET = 0.9;
    const rows = (await pool.query(
      `SELECT COALESCE(o.staff_name,'') AS staff, count(*)::int AS n,
              count(*) FILTER (WHERE o.customer_id IS NULL
                                 AND COALESCE(s.phone_norm,'') = '')::int AS missing,
              round(COALESCE(sum(o.total) FILTER (WHERE o.customer_id IS NULL
                                 AND COALESCE(s.phone_norm,'') = ''), 0)::numeric, 0)::float AS missed_sar
         FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE ${SALES_ONLY} AND o.calendar_day > CURRENT_DATE - 7
          AND (o.order_type IS NULL OR o.order_type NOT ILIKE '%external%')
          AND COALESCE(o.staff_name,'') <> ''
        GROUP BY 1 HAVING count(*) >= 20`)).rows;

    const flagged = [];
    for (const r of rows) {
      const rate = 1 - r.missing / r.n;
      // Both gates matter: a bad percentage on cheap orders is a habit worth a
      // word at the counter, not an interrupt. The money is what makes it one.
      if (rate >= TARGET || num(r.missed_sar) < 200) continue;
      flagged.push({ staff: r.staff, rate: round2(rate) });
      await raise({
        kind: "STAFF_NO_CUSTOMER", scope: r.staff,
        severity: rate < 0.75 ? "high" : "medium",
        metric: num(r.missed_sar), unit: "sar",
        metricLabel: "ريال مبيعات لعملاء مانعرفهمش",
        titleAr: `${r.staff}: ${Math.round(rate * 100)}٪ بس من الطلبات عليها عميل`,
        whyAr: `${r.missing} طلب من ${r.n} في آخر ٧ أيام اتقفلوا من غير عميل — الهدف ٩٠٪.`,
        link: "#manager", linkLabel: "طلبات بدون عميل",
        evidence: { staff: r.staff, orders: r.n, missing: r.missing,
                    identifiedRate: round2(rate), missedValueSar: num(r.missed_sar),
                    target: TARGET, windowDays: 7 },
      }, stamp);
    }
    return { staffChecked: rows.length, flagged };
  }

  /* ── discounts: 100% comps nobody can explain ───────────────────────── */
  async function sourceDiscounts(stamp) {
    /* A full comp to someone in an internal group (الملاك، موظفين المطعم) is
       normal and stays out. A full comp to a customer in NO group — or to no
       customer at all — is free food with no name on it. That is the only
       discount shape in this file: everything else has a plausible reason and
       lives on the discounts page. */
    const rows = (await pool.query(
      `SELECT o.order_id, o.receipt, o.calendar_day::text AS day, o.order_date,
              round(o.gross_incl::numeric, 2)::float AS gross,
              COALESCE(o.staff_name,'') AS staff, o.customer_id,
              (SELECT string_agg(cg.name, '، ') FROM customer_group_members m
                 JOIN customer_groups cg ON cg.group_id = m.group_id
                WHERE m.customer_id = o.customer_id) AS groups,
              COALESCE((SELECT bool_or(cg.is_internal) FROM customer_group_members m
                 JOIN customer_groups cg ON cg.group_id = m.group_id
                WHERE m.customer_id = o.customer_id), false) AS internal,
              COALESCE(tc.name, '') AS customer_name
         FROM ts_orders o LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
        WHERE ${SALES_ONLY} AND o.calendar_day >= CURRENT_DATE - 21
          AND o.gross_incl > 0 AND o.discount_incl >= o.gross_incl * 0.99
          AND o.gross_incl >= 150
        ORDER BY o.gross_incl DESC LIMIT 25`)).rows;

    const unexplained = rows.filter((r) => !r.internal);
    for (const r of unexplained) {
      const who = r.customer_name || (r.customer_id ? `عميل #${r.customer_id}` : "بدون عميل مسجّل");
      await raise({
        kind: "FULL_COMP_UNEXPLAINED", scope: r.order_id,
        severity: r.gross >= 300 ? "high" : "medium",
        metric: r.gross, unit: "sar",
        metricLabel: "ريال أكل اتقدّم مجاناً",
        titleAr: `ضيافة كاملة ${Math.round(r.gross)} ريال يوم ${r.day} — ${who}`,
        whyAr: r.groups
          ? `الطلب على ${r.staff || "موظف غير معروف"}، والعميل في مجموعة «${r.groups}» مش داخلية.`
          : `الطلب على ${r.staff || "موظف غير معروف"}، والعميل مش في أي مجموعة — مافيش حاجة بتفسّر الخصم.`,
        link: "#manager", linkLabel: "تحليل الخصومات",
        eventAt: r.order_date,
        evidence: { orderId: r.order_id, receipt: r.receipt, day: r.day,
                    grossSar: r.gross, staff: r.staff, customerId: r.customer_id,
                    customerName: r.customer_name || null, groups: r.groups || null },
      }, stamp);
    }
    return { fullComps: rows.length, unexplained: unexplained.length };
  }

  /* ── costing: only what is new AND large ────────────────────────────── */
  async function sourceCosting(stamp) {
    /* The costing queue has 121 open items, its own ranking, and its own page.
       Copying it here would drown every other alert in this file. So the only
       thing allowed through is a finding that is BOTH new (72h) and large
       (>= SAR 300), capped at five rows — which on the live table yields zero
       or one. Auto-resolves as soon as the costing task leaves 'open'. */
    const rows = (await pool.query(
      `SELECT id, kind, title, why, severity, impact_sar, item_ref, first_seen_at
         FROM cw_tasks
        WHERE status = 'open' AND impact_sar >= 300
          AND first_seen_at >= NOW() - interval '72 hours'
        ORDER BY impact_sar DESC LIMIT 5`)).rows;
    for (const r of rows) {
      await raise({
        kind: "COSTING_NEW_BIG", scope: r.id,
        severity: r.severity === "critical" ? "high" : "medium",
        metric: round2(r.impact_sar), unit: "sar",
        metricLabel: "ريال بيتحرّكوا لو البند ده اتصلّح",
        titleAr: `تكاليف: ${r.title}`,
        whyAr: `${(r.why || "").slice(0, 180)}`,
        link: "#costing", linkLabel: "ورشة التكاليف",
        eventAt: r.first_seen_at,
        evidence: { taskId: r.id, taskKind: r.kind, impactSar: round2(r.impact_sar),
                    itemRef: r.item_ref, firstSeenAt: r.first_seen_at },
      }, stamp);
    }
    return { newBig: rows.length };
  }

  /* ── reconcile: what the platform has and we do not (deep runs only) ── */
  async function sourceReconcile(stamp) {
    /* This one calls the Ninja portal for a CSV report. That is far too heavy
       for a 5-minute worker, so it runs only on an explicit deep generate.
       It reaches our own API over loopback rather than importing ninja.js,
       because the reconcile logic lives inside that module's register() and is
       not exported — and reaching in would mean editing a file this task does
       not own. If it should run automatically, see the note in the report. */
    const port = Number(process.env.PORT || 3000);
    const token = process.env.ADMIN_TOKEN || "";
    if (!token) throw new Error("ADMIN_TOKEN not set — cannot self-call");
    const res = await fetch(`http://127.0.0.1:${port}/api/ninja/reconcile`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`ninja reconcile HTTP ${res.status}`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "reconcile not ok");

    const missing = Array.isArray(j.missingFromPos) ? j.missingFromPos : [];
    const lost = missing.reduce((a, m) => a + num(m.revenue ?? m.total ?? m.amount), 0);
    if (missing.length) {
      await raise({
        kind: "NINJA_LEAK", scope: `${j.from}..${j.to}`,
        metric: round2(lost) || null, unit: "sar",
        metricLabel: "ريال عند نينجا ومالهاش أثر عندنا",
        titleAr: `${missing.length} طلب نينجا مش موجودين في الكاشير`,
        whyAr: `مطابقة ${j.from} → ${j.to}: نينجا عندها ${j.ninja?.orders} طلب وإحنا عندنا ${j.pos?.orders}.`,
        link: "#manager", linkLabel: "مطابقة نينجا",
        evidence: { from: j.from, to: j.to, missing: missing.slice(0, 10),
                    ninjaOrders: j.ninja?.orders, posOrders: j.pos?.orders },
      }, stamp);
    }
    return { missing: missing.length, lostSar: round2(lost) };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     THE GENERATOR
     ═════════════════════════════════════════════════════════════════════ */
  const SOURCES = [
    ["portals", sourcePortals, false],
    ["sync", sourceSync, false],
    ["flow", sourceFlow, false],
    ["keeta", sourceKeeta, false],
    ["staff", sourceStaff, false],
    ["discounts", sourceDiscounts, false],
    ["costing", sourceCosting, false],
    ["reconcile", sourceReconcile, true],   // deep only
  ];

  let running = null;   // the worker and a manual click must not overlap

  async function generate({ deep = false } = {}) {
    if (running) return running;
    running = (async () => {
      await schemaReady;
      const t0 = Date.now();
      const stamp = new Date();
      const ok = [];
      const failed = {};
      const detail = {};

      for (const [name, fn, isDeep] of SOURCES) {
        if (isDeep && !deep) { detail[name] = { skipped: "deep only" }; continue; }
        try {
          detail[name] = await fn(stamp);
          ok.push(name);
        } catch (e) {
          // A source that threw did NOT observe the world, so its rows are
          // left untouched. Auto-resolving here would be the worst bug this
          // file could have: "the store reopened" because we failed to look.
          failed[name] = e.message;
          console.error(`[notifications] source ${name} failed:`, e.message);
        }
      }

      let resolved = 0;
      for (const name of ok) resolved += await resolveStale(name, stamp);

      const raisedRow = (await pool.query(
        "SELECT count(*)::int AS n FROM nt_notifications WHERE last_seen_at >= $1", [stamp])).rows[0];
      const ms = Date.now() - t0;
      await pool.query(
        `INSERT INTO nt_runs (id, ran_at, deep, sources_ok, sources_failed, raised, resolved, ms)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [`run_${hash(String(stamp.getTime())).slice(0, 12)}`, stamp, !!deep,
         ok.join(","), JSON.stringify(failed), num(raisedRow?.n), resolved, ms]);

      return { ok: true, ranAt: stamp, deep: !!deep, sourcesOk: ok,
               sourcesFailed: failed, active: num(raisedRow?.n), resolved, ms, detail };
    })().finally(() => { running = null; });
    return running;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     ROUTES
     ═════════════════════════════════════════════════════════════════════ */

  // The unread test, in one place so the list and the badge can never
  // disagree about what "unread" means.
  const UNREAD_SQL = `(r.notification_id IS NULL OR r.read_changed_at IS NULL
                       OR r.read_changed_at < n.changed_at)`;

  const SEV_ORDER = `CASE n.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                          WHEN 'medium' THEN 2 ELSE 3 END`;

  function shape(r) {
    const rule = RULE_BY_KIND[r.kind] || {};
    return {
      id: r.id,
      kind: r.kind,
      source: r.source,
      mode: r.mode,
      severity: r.severity,
      title: r.title_ar,
      why: r.why_ar,
      // null is null. A notification with no number must never render as 0.
      metric: r.metric_value === null ? null : round2(r.metric_value),
      metricUnit: r.metric_unit || "",
      metricLabel: r.metric_label || "",
      link: r.link_hash || "",
      linkLabel: r.link_label || "",
      state: r.state,
      resolvedAt: r.resolved_at,
      resolvedNote: r.resolved_note || "",
      unread: !!r.unread,
      occurrences: r.occurrences,
      eventAt: r.event_at,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      changedAt: r.changed_at,
      evidence: r.evidence || {},
      reason: rule.reasonAr || "",
      calibration: rule.calibration || "",
    };
  }

  /* GET /api/notifications — the list.
     read=unread|read|all (default all), state=active|resolved|all (default all),
     severity=csv, kind=csv, limit. */
  async function listHandler(c) {
    const err = await requireAdmin(c); if (err) return err;
    await schemaReady;
    try {
      const u = userKey(c);
      const read = String(c.req.query("read") || "all").trim();
      const state = String(c.req.query("state") || "all").trim();
      const sev = String(c.req.query("severity") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const kinds = String(c.req.query("kind") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const limit = Math.min(300, Math.max(1, Number(c.req.query("limit")) || 120));

      const p = [u];
      const where = [];
      if (state === "active" || state === "resolved") { p.push(state); where.push(`n.state = $${p.length}`); }
      if (sev.length) { p.push(sev); where.push(`n.severity = ANY($${p.length})`); }
      if (kinds.length) { p.push(kinds); where.push(`n.kind = ANY($${p.length})`); }
      if (read === "unread") where.push(UNREAD_SQL);
      if (read === "read") where.push(`NOT ${UNREAD_SQL}`);
      p.push(limit);

      const rows = (await pool.query(
        `SELECT n.*, ${UNREAD_SQL} AS unread
           FROM nt_notifications n
           LEFT JOIN nt_reads r ON r.notification_id = n.id AND r.user_key = $1
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY (n.state = 'active') DESC, ${UNREAD_SQL} DESC,
                   ${SEV_ORDER}, n.changed_at DESC
          LIMIT $${p.length}`, p)).rows;

      const counts = (await pool.query(
        `SELECT n.severity, n.state, count(*)::int AS n,
                count(*) FILTER (WHERE ${UNREAD_SQL})::int AS unread
           FROM nt_notifications n
           LEFT JOIN nt_reads r ON r.notification_id = n.id AND r.user_key = $1
          GROUP BY 1, 2`, [u])).rows;

      const lastRun = (await pool.query(
        "SELECT * FROM nt_runs ORDER BY ran_at DESC LIMIT 1")).rows[0] || null;

      return c.json({
        ok: true, user: u,
        notifications: rows.map(shape),
        counts: {
          total: counts.reduce((a, r) => a + r.n, 0),
          unread: counts.reduce((a, r) => a + r.unread, 0),
          active: counts.filter((r) => r.state === "active").reduce((a, r) => a + r.n, 0),
          bySeverity: counts.filter((r) => r.state === "active")
            .reduce((a, r) => (a[r.severity] = (a[r.severity] || 0) + r.n, a), {}),
        },
        lastRun: lastRun && {
          ranAt: lastRun.ran_at, deep: lastRun.deep,
          sourcesOk: String(lastRun.sources_ok || "").split(",").filter(Boolean),
          sourcesFailed: lastRun.sources_failed || {},
          ms: lastRun.ms,
        },
      });
    } catch (e) {
      console.error("[notifications] list failed:", e);
      return c.json({ ok: false, error: "list_failed", detail: e.message }, 500);
    }
  }
  app.get("/api/notifications", listHandler);
  app.get("/api/notifications/", listHandler);

  /* GET /api/notifications/count — the badge. Deliberately cheap: it never
     generates, so putting it behind a 30-second poll costs one index scan. */
  app.get("/api/notifications/count", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await schemaReady;
    try {
      const u = userKey(c);
      const rows = (await pool.query(
        `SELECT n.severity, count(*)::int AS n
           FROM nt_notifications n
           LEFT JOIN nt_reads r ON r.notification_id = n.id AND r.user_key = $1
          WHERE ${UNREAD_SQL}
          GROUP BY 1`, [u])).rows;
      const bySeverity = rows.reduce((a, r) => (a[r.severity] = r.n, a), {});
      return c.json({
        ok: true, user: u,
        unread: rows.reduce((a, r) => a + r.n, 0),
        bySeverity,
        // What the badge should be coloured by.
        topSeverity: ["critical", "high", "medium", "info"].find((s) => bySeverity[s]) || null,
      });
    } catch (e) {
      return c.json({ ok: false, error: "count_failed", detail: e.message }, 500);
    }
  });

  /* GET /api/notifications/rules — why every alert exists, in Omar's words. */
  app.get("/api/notifications/rules", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, rules: RULES, tradingWindow: `${TRADE_START_H}:00 → 0${TRADE_END_H}:00 Asia/Riyadh` });
  });

  /* POST /api/notifications/:id/read — body { read: true|false } */
  app.post("/api/notifications/:id/read", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await schemaReady;
    try {
      const u = userKey(c);
      const id = String(c.req.param("id") || "").trim();
      const b = await c.req.json().catch(() => ({}));
      const want = b.read === false ? false : true;

      const n = (await pool.query(
        "SELECT id FROM nt_notifications WHERE id = $1", [id])).rows[0];
      if (!n) return c.json({ ok: false, error: "not_found" }, 404);

      if (!want) {
        await pool.query("DELETE FROM nt_reads WHERE notification_id = $1 AND user_key = $2", [id, u]);
        return c.json({ ok: true, id, read: false });
      }
      /* Stamping the row's own changed_at (not NOW()) is what makes a later
         material change reopen it: the read is pinned to the version read.

         The stamp is copied INSIDE SQL rather than read out and passed back
         in. TIMESTAMPTZ keeps microseconds and a JS Date only keeps
         milliseconds, so a round trip truncates — and the read stamp then
         lands a few microseconds BEFORE changed_at, leaving every row
         permanently unread no matter how often it was read. */
      await pool.query(
        `INSERT INTO nt_reads (notification_id, user_key, read_at, read_changed_at)
         SELECT n.id, $2, NOW(), n.changed_at FROM nt_notifications n WHERE n.id = $1
         ON CONFLICT (notification_id, user_key)
         DO UPDATE SET read_at = NOW(), read_changed_at = EXCLUDED.read_changed_at`,
        [id, u]);
      return c.json({ ok: true, id, read: true });
    } catch (e) {
      console.error("[notifications] read failed:", e);
      return c.json({ ok: false, error: "read_failed", detail: e.message }, 500);
    }
  });

  /* POST /api/notifications/read-all — body { severity?, kind?, ids?, state? }
     Marks everything currently unread and matching the filter. Bounded by the
     same filter the UI is showing, so "mark all read" never silently clears
     something that was filtered out of view. */
  app.post("/api/notifications/read-all", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await schemaReady;
    try {
      const u = userKey(c);
      const b = await c.req.json().catch(() => ({}));
      const p = [u];
      const where = [UNREAD_SQL];
      if (Array.isArray(b.ids) && b.ids.length) { p.push(b.ids.map(String)); where.push(`n.id = ANY($${p.length})`); }
      if (b.severity) {
        const sev = String(b.severity).split(",").map((s) => s.trim()).filter(Boolean);
        if (sev.length) { p.push(sev); where.push(`n.severity = ANY($${p.length})`); }
      }
      if (b.kind) {
        const kinds = String(b.kind).split(",").map((s) => s.trim()).filter(Boolean);
        if (kinds.length) { p.push(kinds); where.push(`n.kind = ANY($${p.length})`); }
      }
      if (b.state === "active" || b.state === "resolved") {
        p.push(b.state); where.push(`n.state = $${p.length}`);
      }

      const r = await pool.query(
        `INSERT INTO nt_reads (notification_id, user_key, read_at, read_changed_at)
         SELECT n.id, $1, NOW(), n.changed_at
           FROM nt_notifications n
           LEFT JOIN nt_reads r ON r.notification_id = n.id AND r.user_key = $1
          WHERE ${where.join(" AND ")}
         ON CONFLICT (notification_id, user_key)
         DO UPDATE SET read_at = NOW(), read_changed_at = EXCLUDED.read_changed_at`, p);
      return c.json({ ok: true, marked: r.rowCount });
    } catch (e) {
      console.error("[notifications] read-all failed:", e);
      return c.json({ ok: false, error: "read_all_failed", detail: e.message }, 500);
    }
  });

  /* POST /api/notifications/generate — body/query { deep: 1 } */
  app.post("/api/notifications/generate", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const b = await c.req.json().catch(() => ({}));
      const deep = b.deep === true || b.deep === 1 || String(c.req.query("deep") || "") === "1";
      const out = await generate({ deep });
      return c.json(out);
    } catch (e) {
      console.error("[notifications] generate failed:", e);
      return c.json({ ok: false, error: "generate_failed", detail: e.message }, 500);
    }
  });

  // Exported so index.js can hang it off the 5-minute worker without this
  // module having to know anything about the worker. Never pass deep:true
  // there — the reconcile source calls the Ninja portal.
  return { generate };
}

export default { register };
