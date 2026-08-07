/* ═══════════════════════════════════════════════════════════════════════════
   ATTRIBUTION — "نعرف مردود الإعلانات بالتفصيل".

   السؤال اللي الملف ده بيجاوبه: كل ريال اتصرف على إعلان، رجع بكام؟
   بالقناة، وبالحملة، ومقسوم عملاء جداد / عملاء راجعين.

   العميل بيوصلنا بخمس طرق، وكل طريقة ليها أثر مختلف في الداتا:
     (أ) مكالمة تليفون      → مفيش أثر رقمي. العدّ اليدوي في mk_entries بس.
     (ب) ضغطة واتساب        → funnel_events Contact (بالـ utm لو جاي من إعلان)
     (ج) طلب من المتجر      → funnel_events كامل من PageView لـ Purchase
     (د) زيارة داخل المحل   → order_sources (الكاشير بيسأل ويسجّل)
     (هـ) تيك أواي          → order_sources كمان

   ── إزاي بنربط الطلب بالقناة (بالترتيب، أول شرط يتحقق هو اللي يفوز) ────────
     1. attrib_links   — الطلب فيه رقم جوال اتطابق مع lead في الفنل (آخر لمسة)
                          → درجة الثقة: مؤكد
     2. order_sources  — الكاشير صنّف الطلب بإيده
                          → درجة الثقة: مرجّح (بيعتمد على ذاكرة العميل)
     3. order_type='External' — طلب تطبيق توصيل، ده كلام الكاشير نفسه
                          → درجة الثقة: مؤكد
     4. مفيش أي حاجة   → قناة organic
                          → درجة الثقة: تقديري

   ممنوع نعرض تقدير على إنه حقيقة. كل صف بيرجع `confidence` و
   `confidenceBreakdown` بأعداد الطلبات وراء كل درجة، فاللي بيقرأ يقدر يحكم.

   ── الصرف ────────────────────────────────────────────────────────────────
   الصرف بيتجمّع من مصدرين: insights المنصات (لايف من ads.js) + mk_entries
   (اللي المالك بيدخّله بإيده). الاتنين بيتجمعوا، والصف بيقول كل رقم جاي منين
   في `spend.platform` و `spend.manual`. لو منصة رجّعت خطأ، الخطأ بيتقال في
   `reasons` ومبنعوّضش عنه برقم مخترع.

   ── الجدول اليومي (attrib_daily) ─────────────────────────────────────────
   الحساب الكامل بيمسح ts_orders كلها (عشان "أول طلب في حياته" محتاج التاريخ
   كله). عشان الواجهة ما تستناش، النتيجة بتتخزن يوم بيوم في attrib_daily،
   والأيام القديمة مبتتعادش. اليومين الأخيرين بس بيتعاد بناهم كل مرة لإن
   الداتا بتاعتهم لسه بتتحرك.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { PLATFORMS, canManage, missingOf } from "./ads.js";

/* ── القنوات ────────────────────────────────────────────────────────────────
   التسعة الأساسيين بيرجعوا دايماً حتى لو أصفار. influencer و referral
   بيرجعوا بس لما يكون فيهم داتا — تصنيفات كاشير موجودة ومش من ضمن التسعة. */
export const CORE_CHANNELS = [
  { id: "meta",         label: "ميتا (فيسبوك/انستقرام)", kind: "paid" },
  { id: "tiktok",       label: "تيك توك",                kind: "paid" },
  { id: "snapchat",     label: "سناب شات",               kind: "paid" },
  { id: "google",       label: "جوجل / خرائط جوجل",      kind: "paid" },
  { id: "whatsapp",     label: "واتساب",                 kind: "direct" },
  { id: "phone",        label: "مكالمة تليفون",          kind: "direct" },
  { id: "walkin",       label: "زيارة للمحل",            kind: "walkin" },
  { id: "delivery_app", label: "تطبيقات التوصيل",        kind: "delivery" },
  { id: "organic",      label: "من غير مصدر معروف",      kind: "organic" },
];
export const EXTRA_CHANNELS = [
  { id: "influencer", label: "مشاهير / إنفلونسر", kind: "paid" },
  { id: "referral",   label: "توصية صاحب",        kind: "organic" },
];
const ALL_CHANNELS = [...CORE_CHANNELS, ...EXTRA_CHANNELS];
const channelMeta = (id) => ALL_CHANNELS.find((c) => c.id === id) || { id, label: id, kind: "organic" };

/* order_sources.source (تصنيف الكاشير) → قناة */
const SOURCE_CHANNEL = {
  facebook: "meta", instagram: "meta", meta: "meta", fb: "meta", ig: "meta",
  tiktok: "tiktok", tt: "tiktok",
  snapchat: "snapchat", snap: "snapchat",
  google_maps: "google", google: "google", maps: "google",
  whatsapp: "whatsapp", wa: "whatsapp",
  phone: "phone", call: "phone",
  walkin: "walkin", walk_in: "walkin", dinein: "walkin", takeaway: "walkin",
  delivery_app: "delivery_app", delivery: "delivery_app",
  influencer: "influencer",
  friend: "referral",
  old_customer: "organic",   // عميل قديم رجع من نفسه — مش إعلان
};

/* utm_source (من رابط الإعلان) → قناة */
const UTM_CHANNEL = {
  fb: "meta", facebook: "meta", meta: "meta", ig: "meta", instagram: "meta",
  tiktok: "tiktok", tt: "tiktok",
  snap: "snapchat", snapchat: "snapchat", sc: "snapchat",
  google: "google", googleads: "google", adwords: "google", gmb: "google", google_maps: "google",
  whatsapp: "whatsapp", wa: "whatsapp",
  influencer: "influencer",
};

/* mk_campaigns.platform → قناة */
const MK_CHANNEL = {
  meta: "meta", facebook: "meta", instagram: "meta",
  tiktok: "tiktok", snapchat: "snapchat", snap: "snapchat",
  google: "google", whatsapp: "whatsapp", influencer: "influencer",
};

/* منصات ads.js اللي بتديّنا صرف لايف → قناة */
const PLATFORM_CHANNEL = { meta: "meta", tiktok: "tiktok", snapchat: "snapchat", google: "google" };

const LINK_WINDOW_DAYS = 7;   // شباك مطابقة الـ lead بالطلب
const HOT_DAYS = 2;           // آخر يومين بيتعاد بناهم كل مرة

/* قيم بيكتبها نظام الكاشير معناها "مفيش تصنيف" — مش تصنيف يتبنى عليه حكم. */
const EMPTY_SOURCES = ["", "skipped", "unknown", "none", "-"];
const NOT_TAGGED = EMPTY_SOURCES.map((s) => `'${s}'`).join(",");

/* CASE مبنية من الخرايط فوق عشان الماب يفضل في مكان واحد بس. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
function sqlCase(expr, map, fallback) {
  const whens = Object.entries(map).map(([k, v]) => `WHEN ${lit(k)} THEN ${lit(v)}`).join("\n           ");
  return `CASE lower(btrim(COALESCE(${expr},'')))\n           ${whens}\n           ELSE ${fallback} END`;
}
const SRC_CASE = sqlCase("o.src", SOURCE_CHANNEL, lit("organic"));
const UTM_CASE = sqlCase("lt.utm_source", UTM_CHANNEL, lit("organic"));
const LEAD_UTM_CASE = sqlCase(
  "COALESCE(NULLIF(utm->>'utm_source',''), CASE WHEN event_name='Contact' THEN 'whatsapp' ELSE '' END)",
  UTM_CHANNEL, lit("organic"));
const MK_CASE = sqlCase("c.platform", MK_CHANNEL, lit("organic"));

/* ── الـ CTE الأساسية: كل طلب × قناته × أساس النسبة × جديد/راجع ─────────────
   `firsts` بتتحسب على التاريخ كله (من غير فلتر تواريخ) لإن "أول طلب في حياته"
   معناها الأول على الإطلاق، مش الأول جوه المدى المطلوب. */
export const ORDERS_CTE = `
  WITH ord AS (
    SELECT o.order_id,
           o.calendar_day AS day,
           COALESCE(o.total,0) AS total,
           o.order_type,
           NULLIF(COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')),'') AS pn,
           lower(btrim(COALESCE(s.source,''))) AS src,
           lower(btrim(COALESCE(s.customer_kind,''))) AS kind
      FROM ts_orders o
      LEFT JOIN order_sources s ON s.order_id = o.order_id
      LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
     WHERE o.calendar_day IS NOT NULL
       AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
  ),
  firsts AS (
    SELECT pn, min(day) AS first_day FROM ord WHERE pn IS NOT NULL GROUP BY pn
  ),
  lt AS (
    SELECT DISTINCT ON (l.order_id) l.order_id, l.utm_source, l.utm_campaign
      FROM attrib_links l JOIN funnel_events f ON f.id = l.lead_event_id
     ORDER BY l.order_id, f.created_at DESC
  ),
  res AS (
    SELECT o.order_id, o.day, o.total, o.pn, o.src, o.kind,
           CASE WHEN lt.order_id IS NOT NULL             THEN 'linked'
                WHEN o.src NOT IN (${NOT_TAGGED})        THEN 'tagged'
                WHEN o.order_type ILIKE '%external%'     THEN 'pos'
                ELSE 'guess' END AS basis,
           CASE WHEN lt.order_id IS NOT NULL             THEN ${UTM_CASE}
                WHEN o.src NOT IN (${NOT_TAGGED})        THEN ${SRC_CASE}
                WHEN o.order_type ILIKE '%external%'     THEN 'delivery_app'
                ELSE 'organic' END AS channel,
           CASE WHEN lt.order_id IS NOT NULL THEN COALESCE(NULLIF(lt.utm_campaign,''),'') ELSE '' END AS campaign,
           (o.pn IS NOT NULL AND fs.first_day = o.day) AS is_new
      FROM ord o
      LEFT JOIN lt ON lt.order_id = o.order_id
      LEFT JOIN firsts fs ON fs.pn = o.pn
  )`;

/* ثلاث جمل البناء اليومي. على مستوى الموديول (مش جوه register) عشان تتقرا
   وتتجرّب على قاعدة البيانات من غير ما نشغّل السيرفر كله. */
export const SQL_ROLL_ORDERS = `
  ${ORDERS_CTE}
  INSERT INTO attrib_daily (day, channel, campaign, orders, revenue, new_customers,
                            returning_orders, linked_orders, tagged_orders, pos_orders, guessed_orders)
  SELECT day, channel, campaign,
         count(*)::int,
         COALESCE(sum(total),0),
         count(DISTINCT pn) FILTER (WHERE is_new)::int,
         count(*) FILTER (WHERE NOT is_new)::int,
         count(*) FILTER (WHERE basis='linked')::int,
         count(*) FILTER (WHERE basis='tagged')::int,
         count(*) FILTER (WHERE basis='pos')::int,
         count(*) FILTER (WHERE basis='guess')::int
    FROM res
   WHERE day BETWEEN $1::date AND $2::date
   GROUP BY 1,2,3
  ON CONFLICT (day, channel, campaign) DO UPDATE SET
    orders=EXCLUDED.orders, revenue=EXCLUDED.revenue, new_customers=EXCLUDED.new_customers,
    returning_orders=EXCLUDED.returning_orders, linked_orders=EXCLUDED.linked_orders,
    tagged_orders=EXCLUDED.tagged_orders, pos_orders=EXCLUDED.pos_orders,
    guessed_orders=EXCLUDED.guessed_orders`;

/* الـ leads من الفنل، بتوقيت الرياض عشان اليوم يطابق يوم الكاشير. */
export const SQL_ROLL_LEADS = `
  INSERT INTO attrib_daily (day, channel, campaign, leads)
  SELECT (created_at AT TIME ZONE 'Asia/Riyadh')::date AS day,
         ${LEAD_UTM_CASE} AS channel,
         COALESCE(NULLIF(utm->>'utm_campaign',''),'') AS campaign,
         count(*)::int
    FROM funnel_events
   WHERE event_name IN ('Contact','Lead')
     AND (created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date
   GROUP BY 1,2,3
  ON CONFLICT (day, channel, campaign) DO UPDATE SET leads=EXCLUDED.leads`;

/* الصرف اليدوي + الـ leads اليدوية من مركز التسويق. */
export const SQL_ROLL_SPEND = `
  INSERT INTO attrib_daily (day, channel, campaign, spend_manual, manual_leads)
  SELECT e.day, ${MK_CASE} AS channel, COALESCE(c.name,'') AS campaign,
         COALESCE(sum(e.spend),0),
         COALESCE(sum(COALESCE(e.leads_whatsapp,0)+COALESCE(e.leads_calls,0)+COALESCE(e.leads_visits,0)
                    +COALESCE(e.leads_delivery,0)+COALESCE(e.leads_apps,0)),0)::int
    FROM mk_entries e JOIN mk_campaigns c ON c.id = e.campaign_id
   WHERE e.day BETWEEN $1::date AND $2::date
   GROUP BY 1,2,3
  ON CONFLICT (day, channel, campaign) DO UPDATE SET
    spend_manual=EXCLUDED.spend_manual, manual_leads=EXCLUDED.manual_leads`;

/* تشخيص التغطية — الرقم اللي بيفسّر ليه الأرقام "تقديري". من غيره الواجهة
   هتفضل تسأل "ليه مفيش طلبات مربوطة؟" من غير إجابة. */
export const SQL_COVERAGE = `
  SELECT
    (SELECT count(*)::int FROM funnel_events
      WHERE event_name IN ('Contact','Lead')
        AND (created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date) AS leads_total,
    (SELECT count(*)::int FROM funnel_events
      WHERE event_name IN ('Contact','Lead') AND COALESCE(phone_norm,'') <> ''
        AND (created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date) AS leads_with_phone,
    (SELECT count(*)::int FROM ts_orders o WHERE o.calendar_day BETWEEN $1::date AND $2::date) AS orders_total,
    (SELECT count(*)::int FROM ts_orders o
       LEFT JOIN order_sources s ON s.order_id = o.order_id
       LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
      WHERE o.calendar_day BETWEEN $1::date AND $2::date
        AND COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) IS NOT NULL) AS orders_with_phone,
    (SELECT count(*)::int FROM attrib_links l JOIN ts_orders o ON o.order_id = l.order_id
      WHERE o.calendar_day BETWEEN $1::date AND $2::date) AS links`;

/* أساس نسبة الطلب للقناة → درجة الثقة اللي نقدر نقولها بضمير مرتاح. */
export const CONFIDENCE_OF_BASIS = { linked: "مؤكد", pos: "مؤكد", tagged: "مرجّح", guess: "تقديري" };

/* درجة ثقة الصف = الأساس اللي بيغطي نص الطلبات على الأقل، وإلا الأضعف.
   مبنقولش "مؤكد" غير لما نص الطلبات على الأقل وراها مطابقة رقم جوال أو
   تصنيف من نظام الكاشير نفسه (External) — مش تخمين ولا كلام عميل. */
export function confidenceOf({ orders, linked, pos, tagged }) {
  if (!orders) return { confidence: CONFIDENCE_OF_BASIS.guess, note: "مفيش طلبات في المدى ده — أي رقم عائد هنا صفر مش تقدير." };
  const certain = (linked || 0) + (pos || 0);
  if (certain / orders >= 0.5) {
    return { confidence: CONFIDENCE_OF_BASIS.linked, note: `${certain} من ${orders} طلب متطابقين برقم جوال من الفنل أو مصنّفين من نظام الكاشير نفسه.` };
  }
  if ((tagged || 0) > 0) {
    return { confidence: CONFIDENCE_OF_BASIS.tagged, note: `${tagged} من ${orders} طلب معتمدين على تصنيف الكاشير اليدوي — ده كلام العميل مش دليل تقني.` };
  }
  return { confidence: CONFIDENCE_OF_BASIS.guess, note: `${orders} طلب من غير أي مصدر — محسوبين هنا بالاستبعاد، مش بدليل.` };
}

const num = (v) => (v == null ? 0 : Number(v) || 0);
const r2 = (v) => Math.round(v * 100) / 100;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/* التغطية بتقول للمالك ليه الأرقام واقفة عند "تقديري" وإيه اللي يصلّحها.
   الربط كله معلّق على حاجة واحدة: إن الـ lead يحمل رقم جوال. */
function coverageOf(cov) {
  const leads = num(cov.leads_total), leadsPh = num(cov.leads_with_phone);
  const orders = num(cov.orders_total), ordersPh = num(cov.orders_with_phone);
  const links = num(cov.links);
  const blockers = [];
  if (leads > 0 && leadsPh === 0) {
    blockers.push("مفيش ولا lead من الفنل جاي معاه رقم جوال — يعني مستحيل نربط أي طلب بإعلان بدليل. الحل: خلي زر الواتساب/فورم الطلب يبعت phone مع الحدث في POST /api/funnel/event.");
  } else if (leads > 0 && leadsPh / leads < 0.3) {
    blockers.push(`${leadsPh} من ${leads} lead بس فيهم رقم جوال — الباقي مش قابل للربط.`);
  }
  if (orders > 0 && ordersPh / orders < 0.3) {
    blockers.push(`${ordersPh} من ${orders} طلب بس فيهم رقم جوال (من الكاشير أو من ملف العميل) — الطلبات من غير رقم مش هتتربط بأي إعلان.`);
  }
  return {
    leads, leadsWithPhone: leadsPh, leadPhoneRate: leads > 0 ? r2(leadsPh / leads) : null,
    orders, ordersWithPhone: ordersPh, orderPhoneRate: orders > 0 ? r2(ordersPh / orders) : null,
    linkedOrders: links,
    blockers,
    healthy: blockers.length === 0,
  };
}

export function register(app, ctx) {
  const { pool, requireAdmin, todayISO, daysAgoISO } = ctx;

  /* ── schema ── */
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attrib_links (
        order_id TEXT NOT NULL,
        lead_event_id TEXT NOT NULL,
        utm_source TEXT,
        utm_campaign TEXT,
        matched_by TEXT NOT NULL,          -- order_id | phone
        matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (order_id, lead_event_id)
      );
      CREATE INDEX IF NOT EXISTS attrib_links_campaign_idx ON attrib_links(utm_campaign);
      CREATE INDEX IF NOT EXISTS attrib_links_lead_idx ON attrib_links(lead_event_id);
      CREATE TABLE IF NOT EXISTS attrib_daily (
        day DATE NOT NULL,
        channel TEXT NOT NULL,
        campaign TEXT NOT NULL DEFAULT '',
        spend_manual NUMERIC NOT NULL DEFAULT 0,
        leads INT NOT NULL DEFAULT 0,
        manual_leads INT NOT NULL DEFAULT 0,
        orders INT NOT NULL DEFAULT 0,
        revenue NUMERIC NOT NULL DEFAULT 0,
        new_customers INT NOT NULL DEFAULT 0,
        returning_orders INT NOT NULL DEFAULT 0,
        linked_orders INT NOT NULL DEFAULT 0,
        tagged_orders INT NOT NULL DEFAULT 0,
        pos_orders INT NOT NULL DEFAULT 0,
        guessed_orders INT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, channel, campaign)
      );
      CREATE INDEX IF NOT EXISTS attrib_daily_day_idx ON attrib_daily(day);
      -- علامة "اليوم ده اتبنى" — لازمة عشان يوم فاضي فعلاً ما يفضلش يتعاد بناه.
      CREATE TABLE IF NOT EXISTS attrib_built (
        day DATE PRIMARY KEY,
        built_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS funnel_events_phone_idx ON funnel_events(phone_norm);
      CREATE INDEX IF NOT EXISTS funnel_events_order_idx ON funnel_events(order_id);
    `);
  }
  ensureSchema()
    .then(() => console.log("[attribution] schema ready"))
    .catch((e) => console.error("[attribution] schema failed:", e.message));

  /* ═══ ربط الـ leads بالطلبات ═══════════════════════════════════════════
     ماتش رقم الطلب أولاً (دليل قاطع) وبعدين ماتش الجوال جوه شباك 7 أيام.
     ON CONFLICT DO NOTHING معناها إن الماتش الأقوى بيفضل هو المسجّل. */

  async function sweepLinks({ days = 30, orderId = null } = {}) {
    const since = daysAgoISO(Math.max(1, Math.min(Number(days) || 30, 400)));
    const scope = orderId ? `AND o.order_id = ${lit(orderId)}` : "";

    const byOrder = await pool.query(
      `INSERT INTO attrib_links (order_id, lead_event_id, utm_source, utm_campaign, matched_by)
       SELECT o.order_id, f.id, NULLIF(f.utm->>'utm_source',''), NULLIF(f.utm->>'utm_campaign',''), 'order_id'
         FROM ts_orders o
         JOIN funnel_events f ON f.order_id = o.order_id
        WHERE o.calendar_day >= $1::date ${scope}
          AND f.event_name IN ('Purchase','InitiateCheckout','Lead','Contact')
       ON CONFLICT (order_id, lead_event_id) DO NOTHING`, [since]);

    const byPhone = await pool.query(
      `INSERT INTO attrib_links (order_id, lead_event_id, utm_source, utm_campaign, matched_by)
       SELECT op.order_id, f.id, NULLIF(f.utm->>'utm_source',''), NULLIF(f.utm->>'utm_campaign',''), 'phone'
         FROM (
           SELECT o.order_id,
                  COALESCE(o.order_date, o.calendar_day::timestamptz) AS at,
                  NULLIF(COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')),'') AS pn
             FROM ts_orders o
             LEFT JOIN order_sources s ON s.order_id = o.order_id
             LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
            WHERE o.calendar_day >= $1::date ${scope}
         ) op
         JOIN funnel_events f
           ON f.phone_norm = op.pn
          AND f.event_name IN ('Contact','Lead','InitiateCheckout','Purchase')
          AND f.created_at <= op.at + interval '1 day'
          AND f.created_at >= op.at - ($2 || ' days')::interval
        WHERE op.pn IS NOT NULL AND length(op.pn) >= 9
       ON CONFLICT (order_id, lead_event_id) DO NOTHING`,
      [since, String(LINK_WINDOW_DAYS)]);

    const linked = byOrder.rowCount + byPhone.rowCount;
    // أي يوم اتغيّر فيه ربط لازم يتعاد بناه.
    if (linked > 0) await pool.query(`DELETE FROM attrib_built WHERE day >= $1::date`, [since]).catch(() => {});
    return { ok: true, since, window: LINK_WINDOW_DAYS, linkedByOrderId: byOrder.rowCount, linkedByPhone: byPhone.rowCount, linked };
  }

  /* ═══ بناء الجدول اليومي ═══════════════════════════════════════════════ */

  async function rebuildDays(from, to) {
    await pool.query(`DELETE FROM attrib_daily WHERE day BETWEEN $1::date AND $2::date`, [from, to]);
    await pool.query(SQL_ROLL_ORDERS, [from, to]);
    await pool.query(SQL_ROLL_LEADS, [from, to]);
    await pool.query(SQL_ROLL_SPEND, [from, to]);
    await pool.query(`
      INSERT INTO attrib_built (day, built_at)
      SELECT d::date, NOW() FROM generate_series($1::date, $2::date, interval '1 day') d
      ON CONFLICT (day) DO UPDATE SET built_at=NOW()`, [from, to]);
  }

  /* بيعيد بناء الأيام الناقصة أو السخنة بس — مش المدى كله كل مرة. */
  async function ensureFresh(from, to, { force = false } = {}) {
    const hot = daysAgoISO(HOT_DAYS);
    if (force) { await rebuildDays(from, to); return { rebuilt: "كامل" }; }
    const stale = await pool.query(
      `SELECT d::date::text AS day
         FROM generate_series($1::date, $2::date, interval '1 day') d
        WHERE NOT EXISTS (SELECT 1 FROM attrib_built b WHERE b.day = d::date)
           OR d::date >= $3::date
        ORDER BY 1`, [from, to, hot]);
    const days = stale.rows.map((r) => r.day);
    if (!days.length) return { rebuilt: 0 };
    // مدى واحد متصل أرخص من N استعلامات — نبني من أول يوم ناقص لآخر واحد.
    await rebuildDays(days[0], days[days.length - 1]);
    return { rebuilt: days.length, fromDay: days[0], toDay: days[days.length - 1] };
  }

  /* ═══ الصرف اللايف من المنصات ═══════════════════════════════════════════
     insights بترجع مجاميع المدى كله (مش يوم بيوم)، فبتتجمع على مستوى المدى
     وبتتضاف للصف — ومبتتخزنش في الجدول اليومي عشان مانكدبش على نفسنا. */
  // نداء المنصات غالي ومحدود بحصة. نفس المدى بيترد من الكاش لمدة ٥ دقايق —
  // كفاية إن الواجهة والوكيل مايضربوش المنصات مرتين على نفس السؤال.
  const spendCache = new Map();
  const SPEND_TTL_MS = 5 * 60_000;

  async function platformSpend(from, to) {
    const key = `${from}|${to}`;
    const hit = spendCache.get(key);
    if (hit && Date.now() - hit.at < SPEND_TTL_MS) return hit.val;
    const val = await platformSpendFresh(from, to);
    if (spendCache.size > 50) spendCache.clear();
    spendCache.set(key, { at: Date.now(), val });
    return val;
  }

  async function platformSpendFresh(from, to) {
    const byChannel = {}, byCampaign = {}, reasons = {};
    for (const p of PLATFORMS) {
      const ch = PLATFORM_CHANNEL[p.id];
      if (!ch) continue;
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ") || "صلاحيات"}`; continue; }
      try {
        const r = await p.insights({ from, to });
        if (!r.ok) { reasons[p.id] = r.reason || "insights رجعت خطأ"; continue; }
        for (const row of r.rows) {
          if (row.error) { reasons[p.id] = row.error; continue; }
          byChannel[ch] = (byChannel[ch] || 0) + num(row.spend);
          const key = String(row.campaignName || row.campaignId || "").trim();
          if (key) {
            const cur = byCampaign[key] || { spend: 0, results: 0, platform: p.id, campaignId: row.campaignId };
            cur.spend += num(row.spend);
            cur.results += num(row.results);
            byCampaign[key] = cur;
          }
        }
      } catch (e) { reasons[p.id] = String(e.message || e); }
    }
    return { byChannel, byCampaign, reasons };
  }

  /* ═══ القراءات ═══════════════════════════════════════════════════════ */

  function range(c) {
    const to = isDay(c.req.query("to")) ? c.req.query("to") : todayISO();
    const from = isDay(c.req.query("from")) ? c.req.query("from") : daysAgoISO(29);
    return from <= to ? { from, to } : { from: to, to: from };
  }

  async function overviewData(from, to, { force = false } = {}) {
    const fresh = await ensureFresh(from, to, { force });
    const agg = await pool.query(
      `SELECT channel,
              COALESCE(sum(spend_manual),0) AS spend_manual,
              COALESCE(sum(leads),0)::int AS leads,
              COALESCE(sum(manual_leads),0)::int AS manual_leads,
              COALESCE(sum(orders),0)::int AS orders,
              COALESCE(sum(revenue),0) AS revenue,
              COALESCE(sum(new_customers),0)::int AS new_customers,
              COALESCE(sum(returning_orders),0)::int AS returning_orders,
              COALESCE(sum(linked_orders),0)::int AS linked_orders,
              COALESCE(sum(tagged_orders),0)::int AS tagged_orders,
              COALESCE(sum(pos_orders),0)::int AS pos_orders,
              COALESCE(sum(guessed_orders),0)::int AS guessed_orders
         FROM attrib_daily WHERE day BETWEEN $1::date AND $2::date
        GROUP BY 1`, [from, to]);

    // العملاء المميزين على مستوى المدى — مش قابل للجمع من الأيام، فبيتحسب لايف.
    const cust = await pool.query(
      `${ORDERS_CTE}
       SELECT channel,
              count(DISTINCT pn)::int AS customers,
              count(DISTINCT pn) FILTER (WHERE is_new)::int AS new_customers,
              count(DISTINCT pn) FILTER (WHERE NOT is_new)::int AS returning_customers
         FROM res WHERE day BETWEEN $1::date AND $2::date AND pn IS NOT NULL
        GROUP BY 1`, [from, to]);
    const custBy = Object.fromEntries(cust.rows.map((r) => [r.channel, r]));

    const spend = await platformSpend(from, to);
    const cov = (await pool.query(SQL_COVERAGE, [from, to])).rows[0] || {};

    const seen = new Set(agg.rows.map((r) => r.channel));
    for (const k of Object.keys(spend.byChannel)) seen.add(k);
    const ids = [
      ...CORE_CHANNELS.map((c) => c.id),
      ...EXTRA_CHANNELS.map((c) => c.id).filter((id) => seen.has(id)),
    ];
    const aggBy = Object.fromEntries(agg.rows.map((r) => [r.channel, r]));

    const rows = ids.map((id) => {
      const a = aggBy[id] || {};
      const cu = custBy[id] || {};
      const manual = num(a.spend_manual);
      const plat = num(spend.byChannel[id]);
      const total = manual + plat;
      const orders = num(a.orders), revenue = num(a.revenue);
      const leads = num(a.leads), manualLeads = num(a.manual_leads);
      const conf = confidenceOf({
        orders, linked: num(a.linked_orders), pos: num(a.pos_orders), tagged: num(a.tagged_orders),
      });
      const meta = channelMeta(id);
      return {
        channel: id, label: meta.label, kind: meta.kind,
        spend: { total: r2(total), platform: r2(plat), manual: r2(manual),
                 source: plat > 0 && manual > 0 ? "منصة + يدوي" : plat > 0 ? "منصة" : manual > 0 ? "يدوي" : "مفيش" },
        leads, manualLeads, leadsTotal: leads + manualLeads,
        orders, revenue: r2(revenue),
        newCustomers: num(cu.new_customers),
        returningCustomers: num(cu.returning_customers),
        customers: num(cu.customers),
        returningOrders: num(a.returning_orders),
        cpa: orders > 0 && total > 0 ? r2(total / orders) : null,
        cpl: (leads + manualLeads) > 0 && total > 0 ? r2(total / (leads + manualLeads)) : null,
        roas: total > 0 ? r2(revenue / total) : null,
        avgOrder: orders > 0 ? r2(revenue / orders) : null,
        confidence: conf.confidence,
        confidenceNote: conf.note,
        confidenceBreakdown: {
          linked: num(a.linked_orders), pos: num(a.pos_orders),
          tagged: num(a.tagged_orders), guessed: num(a.guessed_orders),
        },
      };
    });

    const totals = rows.reduce((t, r) => ({
      spend: t.spend + r.spend.total, leads: t.leads + r.leadsTotal,
      orders: t.orders + r.orders, revenue: t.revenue + r.revenue,
      newCustomers: t.newCustomers + r.newCustomers,
    }), { spend: 0, leads: 0, orders: 0, revenue: 0, newCustomers: 0 });

    return {
      range: { from, to }, rows,
      totals: {
        spend: r2(totals.spend), leads: totals.leads, orders: totals.orders,
        revenue: r2(totals.revenue), newCustomers: totals.newCustomers,
        cpa: totals.orders > 0 && totals.spend > 0 ? r2(totals.spend / totals.orders) : null,
        roas: totals.spend > 0 ? r2(totals.revenue / totals.spend) : null,
      },
      reasons: spend.reasons,
      rollup: fresh,
      coverage: coverageOf(cov),
      notes: [
        "الإيراد من ts_orders.total وهو شامل الضريبة — نفس الرقم اللي على الفاتورة.",
        "الطلبات الملغية/المرتجعة مستبعدة.",
        "درجة الثقة مش زينة: مؤكد = مطابقة رقم جوال أو تصنيف النظام نفسه، مرجّح = تصنيف الكاشير اليدوي، تقديري = محسوب بالاستبعاد.",
        "صرف جوجل يدوي بس — Google Ads API لسه محتاج developer token معتمد.",
      ],
    };
  }

  app.get("/api/attribution/overview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = range(c);
    try {
      const data = await overviewData(from, to, { force: c.req.query("refresh") === "1" });
      return c.json({ ok: true, ...data });
    } catch (e) {
      console.error("[attribution] overview failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* ── لكل حملة (utm_campaign) ───────────────────────────────────────────
     الطلبات هنا كلها متطابقة برقم جوال أو برقم طلب — يعني الصفوف دي "مؤكد"
     بطبيعتها. الحملة اللي ليها صرف بس من غير طلبات مربوطة بتبان بصفر
     وبعلامة `matched:false` بدل ما نخترع لها طلبات. */
  app.get("/api/attribution/campaigns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = range(c);
    try {
      await ensureFresh(from, to, { force: c.req.query("refresh") === "1" });

      const agg = await pool.query(
        `SELECT campaign, channel,
                COALESCE(sum(spend_manual),0) AS spend_manual,
                COALESCE(sum(leads),0)::int AS leads,
                COALESCE(sum(manual_leads),0)::int AS manual_leads,
                COALESCE(sum(orders),0)::int AS orders,
                COALESCE(sum(revenue),0) AS revenue,
                COALESCE(sum(new_customers),0)::int AS new_customers,
                COALESCE(sum(returning_orders),0)::int AS returning_orders,
                COALESCE(sum(linked_orders),0)::int AS linked_orders,
                COALESCE(sum(tagged_orders),0)::int AS tagged_orders,
                COALESCE(sum(pos_orders),0)::int AS pos_orders,
                COALESCE(sum(guessed_orders),0)::int AS guessed_orders
           FROM attrib_daily
          WHERE day BETWEEN $1::date AND $2::date AND campaign <> ''
          GROUP BY 1,2`, [from, to]);

      // أول لمسة / آخر لمسة — لكل طلب، أقدم lead مربوط وأحدث واحد.
      const touch = await pool.query(
        `WITH t AS (
           SELECT l.order_id, COALESCE(NULLIF(l.utm_campaign,''),'(بدون اسم حملة)') AS campaign,
                  f.created_at,
                  row_number() OVER (PARTITION BY l.order_id ORDER BY f.created_at ASC)  AS rn_first,
                  row_number() OVER (PARTITION BY l.order_id ORDER BY f.created_at DESC) AS rn_last
             FROM attrib_links l
             JOIN funnel_events f ON f.id = l.lead_event_id
             JOIN ts_orders o ON o.order_id = l.order_id
            WHERE o.calendar_day BETWEEN $1::date AND $2::date
         )
         SELECT campaign,
                count(*) FILTER (WHERE rn_first=1)::int AS first_touch,
                count(*) FILTER (WHERE rn_last=1)::int  AS last_touch
           FROM t GROUP BY 1`, [from, to]);
      const touchBy = Object.fromEntries(touch.rows.map((r) => [r.campaign, r]));

      const spend = await platformSpend(from, to);

      // اسم حملة المنصة مش لازم يساوي utm_campaign حرف بحرف (ولا اسم الحملة
      // اليدوي في mk_campaigns). بنطابق بالاسم بعد تبسيطه، ولو مفيش تطابق
      // بنقول كده صراحة في `matched`.
      const norm = (s) => String(s || "").toLowerCase().replace(/[\s_\-]+/g, "");
      const platBy = new Map(Object.entries(spend.byCampaign).map(([k, v]) => [norm(k), { name: k, ...v }]));

      // نفس الحملة ممكن تيجي مرتين: مرة باسم utm_campaign (ومعاها الطلبات)
      // ومرة باسم mk_campaigns (ومعاها الصرف اليدوي). بنضمّهم على المفتاح
      // المبسّط عشان الصف يبقى واحد.
      const merged = new Map();
      for (const a of agg.rows) {
        const key = norm(a.campaign);
        const cur = merged.get(key);
        if (!cur) { merged.set(key, { ...a, names: [a.campaign] }); continue; }
        cur.names.push(a.campaign);
        if (num(a.orders) > num(cur.orders)) cur.campaign = a.campaign;   // الاسم اللي جايب طلبات هو الظاهر
        if (cur.channel === "organic" && a.channel !== "organic") cur.channel = a.channel;
        for (const k of ["spend_manual", "leads", "manual_leads", "orders", "revenue", "new_customers",
                         "returning_orders", "linked_orders", "tagged_orders", "pos_orders", "guessed_orders"]) {
          cur[k] = num(cur[k]) + num(a[k]);
        }
      }

      const rows = [...merged.values()].map((a) => {
        const t = touchBy[a.campaign] || {};
        const hit = platBy.get(norm(a.campaign));
        const manual = num(a.spend_manual);
        const plat = hit ? num(hit.spend) : 0;
        const total = manual + plat;
        const orders = num(a.orders), revenue = num(a.revenue);
        const leads = num(a.leads) + num(a.manual_leads);
        const conf = confidenceOf({
          orders, linked: num(a.linked_orders), pos: num(a.pos_orders), tagged: num(a.tagged_orders),
        });
        return {
          campaign: a.campaign, channel: a.channel, label: channelMeta(a.channel).label,
          aliases: (a.names || []).filter((n) => n !== a.campaign),
          spend: { total: r2(total), platform: r2(plat), manual: r2(manual), matched: !!hit,
                   platformCampaign: hit ? hit.name : null },
          leads, orders, revenue: r2(revenue),
          newCustomers: num(a.new_customers), returningOrders: num(a.returning_orders),
          firstTouch: num(t.first_touch), lastTouch: num(t.last_touch),
          cpa: orders > 0 && total > 0 ? r2(total / orders) : null,
          roas: total > 0 ? r2(revenue / total) : null,
          confidence: conf.confidence, confidenceNote: conf.note,
        };
      });

      // حملات المنصات اللي مالهاش أي طلب مربوط — بتتعرض بصرفها وبصفر طلبات.
      const known = new Set(rows.map((r) => norm(r.campaign)));
      const unmatched = Object.entries(spend.byCampaign)
        .filter(([k]) => !known.has(norm(k)))
        .map(([k, v]) => ({
          campaign: k, channel: PLATFORM_CHANNEL[v.platform] || "organic",
          label: channelMeta(PLATFORM_CHANNEL[v.platform] || "organic").label,
          spend: { total: r2(v.spend), platform: r2(v.spend), manual: 0, matched: false, platformCampaign: k },
          leads: 0, orders: 0, revenue: 0, newCustomers: 0, returningOrders: 0,
          firstTouch: 0, lastTouch: 0, cpa: null, roas: null,
          confidence: "تقديري",
          confidenceNote: "الحملة صارفة بس مفيش ولا طلب اتربط بيها برقم جوال — يا إن الـ utm ناقص في الرابط، يا إن العميل بيجي بطريقة مبنقيسهاش.",
          platformResults: num(v.results),
        }));

      return c.json({
        ok: true, range: { from, to },
        window: LINK_WINDOW_DAYS,
        campaigns: [...rows, ...unmatched].sort((a, b) => b.spend.total - a.spend.total || b.orders - a.orders),
        reasons: spend.reasons,
        notes: [
          `الربط بيتم بمطابقة رقم الجوال بين lead في الفنل وطلب في الكاشير جوه شباك ${LINK_WINDOW_DAYS} أيام (أو برقم الطلب نفسه لو المتجر بعته).`,
          "أول لمسة = أقدم إعلان العميل تفاعل معاه قبل الطلب. آخر لمسة = آخر واحد. المجموعين مش لازم يتساووا.",
          "الحملات اللي فيها صرف من غير طلبات مربوطة معروضة كما هي — مش متشالة ومش متعوّض عنها بتقدير.",
        ],
      });
    } catch (e) {
      console.error("[attribution] campaigns failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* ── عملاء جداد ضد راجعين لكل قناة ─────────────────────────────────────
     "جديد" = أول طلب في حياة الرقم ده (على مستوى ts_customers + order_sources)
     وقع جوه المدى. لو الطلب مالهوش رقم، مبنحسبوش لا جديد ولا راجع — بيتقال
     في `withoutPhone` بدل ما يتحط في خانة عشوائية. */
  app.get("/api/attribution/customers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = range(c);
    try {
      const r = await pool.query(
        `${ORDERS_CTE}
         SELECT channel,
                count(*)::int AS orders,
                count(*) FILTER (WHERE pn IS NULL)::int AS orders_without_phone,
                count(DISTINCT pn)::int AS customers,
                count(DISTINCT pn) FILTER (WHERE is_new)::int AS new_customers,
                count(DISTINCT pn) FILTER (WHERE NOT is_new)::int AS returning_customers,
                count(*) FILTER (WHERE is_new)::int AS new_orders,
                count(*) FILTER (WHERE pn IS NOT NULL AND NOT is_new)::int AS returning_orders,
                COALESCE(sum(total) FILTER (WHERE is_new),0) AS new_revenue,
                COALESCE(sum(total) FILTER (WHERE pn IS NOT NULL AND NOT is_new),0) AS returning_revenue,
                COALESCE(sum(total),0) AS revenue
           FROM res WHERE day BETWEEN $1::date AND $2::date
          GROUP BY 1`, [from, to]);

      // كام عميل من اللي اتكسبوا في المدى ده رجع طلب تاني (ولو بعد المدى)؟
      const repeat = await pool.query(
        `${ORDERS_CTE}
         , cohort AS (
           SELECT DISTINCT pn, channel FROM res
            WHERE day BETWEEN $1::date AND $2::date AND is_new AND pn IS NOT NULL
         )
         SELECT ch.channel,
                count(*)::int AS acquired,
                count(*) FILTER (WHERE x.n > 1)::int AS repeated,
                COALESCE(avg(x.n),0)::numeric AS avg_orders
           FROM cohort ch
           JOIN (SELECT pn, count(*)::int AS n FROM res GROUP BY 1) x ON x.pn = ch.pn
          GROUP BY 1`, [from, to]);
      const repBy = Object.fromEntries(repeat.rows.map((r2r) => [r2r.channel, r2r]));

      const aggBy = Object.fromEntries(r.rows.map((x) => [x.channel, x]));
      const ids = [...new Set([...CORE_CHANNELS.map((x) => x.id), ...r.rows.map((x) => x.channel)])];

      const rows = ids.map((id) => {
        const a = aggBy[id] || {};
        const rp = repBy[id] || {};
        const customers = num(a.customers);
        const acquired = num(rp.acquired);
        return {
          channel: id, label: channelMeta(id).label,
          orders: num(a.orders),
          ordersWithoutPhone: num(a.orders_without_phone),
          customers,
          newCustomers: num(a.new_customers),
          returningCustomers: num(a.returning_customers),
          newShare: customers > 0 ? r2(num(a.new_customers) / customers) : null,
          newOrders: num(a.new_orders),
          returningOrders: num(a.returning_orders),
          newRevenue: r2(num(a.new_revenue)),
          returningRevenue: r2(num(a.returning_revenue)),
          revenue: r2(num(a.revenue)),
          avgOrdersPerCustomer: customers > 0 ? r2(num(a.orders) / customers) : null,
          // نسبة التكرار = من العملاء اللي اتكسبوا في المدى، كام واحد طلب تاني
          acquiredInRange: acquired,
          repeatedEver: num(rp.repeated),
          repeatRate: acquired > 0 ? r2(num(rp.repeated) / acquired) : null,
          lifetimeOrdersPerAcquired: acquired > 0 ? r2(num(rp.avg_orders)) : null,
        };
      }).filter((x) => x.orders > 0 || CORE_CHANNELS.some((c2) => c2.id === x.channel));

      return c.json({
        ok: true, range: { from, to }, rows,
        notes: [
          "\"جديد\" = أول طلب في تاريخ الرقم ده كله، مش أول طلب في المدى المعروض.",
          "الطلب من غير رقم جوال مش محسوب جديد ولا راجع — عدده في ordersWithoutPhone.",
          "عميل ممكن يتعدّ جديد وراجع في نفس المدى (اتكسب يوم ١ ورجع يوم ٥)، فالمجموع مش لازم يساوي customers.",
          "repeatRate بيتحسب على كل تاريخ العميل مش على المدى بس — عشان عميل اتكسب امبارح ما يبانش فاشل.",
        ],
      });
    } catch (e) {
      console.error("[attribution] customers failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* ── ربط طلب واحد بالـ leads بتاعته (بينده من funnel.js لما ييجي Purchase) ── */
  async function linkOrder({ orderId, days = 30 }) {
    if (!orderId) return { ok: false, error: "orderId مطلوب" };
    const r = await sweepLinks({ days, orderId: String(orderId) });
    const links = await pool.query(
      `SELECT lead_event_id, utm_source, utm_campaign, matched_by, matched_at
         FROM attrib_links WHERE order_id=$1 ORDER BY matched_at`, [String(orderId)]);
    return { ...r, orderId: String(orderId), links: links.rows };
  }

  app.post("/api/attribution/link-lead", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
    const orderId = b.orderId ? String(b.orderId).slice(0, 64) : null;
    try {
      // من غير orderId بتشتغل كـ sweep على المدى كله.
      const r = orderId
        ? await linkOrder({ orderId, days: Number(b.days) || 30 })
        : await sweepLinks({ days: Number(b.days) || 30 });
      return c.json({ ok: true, ...r });
    } catch (e) {
      console.error("[attribution] link-lead failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  app.post("/api/attribution/rebuild", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = range(c);
    try {
      const swept = await sweepLinks({ days: 90 });
      await rebuildDays(from, to);
      return c.json({ ok: true, range: { from, to }, swept });
    } catch (e) {
      console.error("[attribution] rebuild failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* بينده كل دورة من الأوتوبايلوت: يربط الجديد ويعيد بناء آخر أسبوع. */
  async function sweepAndRoll({ days = 14 } = {}) {
    const swept = await sweepLinks({ days });
    const from = daysAgoISO(days), to = todayISO();
    await rebuildDays(from, to);
    return { swept, rebuilt: { from, to } };
  }

  console.log("[attribution] routes ready");
  return { sweepLinks, sweepAndRoll, linkOrder, overviewData, rebuildDays, ensureFresh, CORE_CHANNELS };
}
