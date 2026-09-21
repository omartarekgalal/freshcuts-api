/* ═══════════════════════════════════════════════════════════════════════════
   ORDERS SCHEMA — ترحيل واحد لأعمدة shop_orders الجديدة (الخطة الرئيسية §٤-٢، W1-01).

   بدل ما كل مسار (٠٢، ٠٣، ٠٤، ٠٥، ٠٧، ٠٨، ٠٩) يضيف أعمدته جوّه shop.js ensureSchema،
   كله هنا في مكان واحد:
     - كل عمود `ADD COLUMN IF NOT EXISTS` وnullable أو بقيمة افتراضية → آمن حتى
       لو الميزة لسه مااتفعّلتش، وآمن يتنادى في كل إقلاع.
     - attribution (اتضاف في W0-03 جوّه shop.js) متكرر هنا عمداً — idempotent.
     - فهارس `IF NOT EXISTS`، وview `shop_orders_real` (من غير طلبات الاختبار)،
       وbackfill لـaccepted_at من history.
     - مابيلمسش shop_orders لو الجدول مش موجود (قاعدة فاضية: shop.js بيعمله الأول).
     - الأعمدة/الفهارس الموجودة بتتفوّت من غير ALTER (عشان مانخدش قفل على
       الجدول في كل إقلاع وقت الـrollover).
   ensureOrderColumns(pool) مابترميش أبداً — بترجع تقرير.
═══════════════════════════════════════════════════════════════════════════ */

import { classifySource, mergeSessionAttribution } from "./checkout-meta.js";

export const ORDER_COLUMNS = Object.freeze([
  // ٠٩ — W0-03 (موجود؛ مكرر عشان الترحيل يبقى كامل ومستقل)
  { name: "attribution", type: "JSONB" },
  // ٠٢، ٠٨ — الـcheckout (W1-02)
  { name: "journey_sid", type: "TEXT" },
  { name: "client", type: "TEXT" },
  { name: "app_version", type: "TEXT" },
  // ٠٧ — الطلب الاصطناعي بس
  { name: "is_test", type: "BOOLEAN NOT NULL DEFAULT false" },
  // ٠٤ — مهمة خلفية (W4-02)
  { name: "attrib_source", type: "TEXT" },
  { name: "customer_seq", type: "INT" },
  // ٠٣ — الـcheckout أو otp/verify
  { name: "phone_verified_at", type: "TIMESTAMPTZ" },
  // ٠٥ — setStatus وmarkReady والبوابة
  { name: "ready_source", type: "TEXT" },
  { name: "ready_by", type: "TEXT" },
  { name: "accepted_at", type: "TIMESTAMPTZ" },
  { name: "portal_ack_at", type: "TIMESTAMPTZ" },
  { name: "portal_ack_by", type: "TEXT" },
  { name: "collected_at", type: "TIMESTAMPTZ" },
  /* ٢١/٩ — رقم الطلب الرقمي في تاب سينس (tenant_order_id من API الشركاء بدون
     بادئة المتجر). pos_order_id هو الـid المقنّع اللي بيرجّعه الشريك، وهو
     **مش** نفس ts_orders.order_id، فمن غير العمود ده مفيش طريقة نربط مرآة
     الطلب في نقطة البيع بطلب الموقع — والتقارير وملف العميل بيضيعوا. */
  { name: "pos_tenant_order_id", type: "TEXT" },
]);

export const ORDER_INDEXES = Object.freeze([
  { name: "shop_orders_attr_link_idx", sql: "CREATE INDEX IF NOT EXISTS shop_orders_attr_link_idx ON shop_orders ((attribution->>'fc_link'))" },
  { name: "shop_orders_is_test_idx", sql: "CREATE INDEX IF NOT EXISTS shop_orders_is_test_idx ON shop_orders(created_at DESC) WHERE is_test" },
  { name: "shop_orders_created_idx", sql: "CREATE INDEX IF NOT EXISTS shop_orders_created_idx ON shop_orders(created_at DESC, order_no DESC)" },
  { name: "shop_orders_option_idx", sql: "CREATE INDEX IF NOT EXISTS shop_orders_option_idx ON shop_orders(option, created_at DESC)" },
  { name: "shop_orders_pos_idx", sql: "CREATE INDEX IF NOT EXISTS shop_orders_pos_idx ON shop_orders(pos_order_id) WHERE pos_order_id IS NOT NULL" },
  { name: "shop_orders_attrib_idx", sql: "CREATE INDEX IF NOT EXISTS shop_orders_attrib_idx ON shop_orders(attrib_source, created_at DESC)" },
  { name: "shop_orders_updated_idx", sql: "CREATE INDEX IF NOT EXISTS shop_orders_updated_idx ON shop_orders(updated_at DESC)" },
]);

export const addColumnSql = (c) => `ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS ${c.name} ${c.type}`;

/* SELECT * بيتجمّد وقت الإنشاء؛ الأعمدة الجديدة بتتضاف في آخر الجدول، فـOR REPLACE
   بيلحقها في الإقلاع اللي بعده من غير ما يكسر الـview. */
export const REAL_VIEW_SQL = "CREATE OR REPLACE VIEW shop_orders_real AS SELECT * FROM shop_orders WHERE NOT is_test";

/* backfill: accepted_at من أول history entry حالتها accepted. `at` لازم يبدأ بتاريخ
   ISO عشان cast غلط مايوقعش الاستعلام كله. idempotent (بس الصفوف الفاضية). */
export const BACKFILL_ACCEPTED_SQL = `UPDATE shop_orders o SET accepted_at = (
    SELECT min((h->>'at')::timestamptz) FROM jsonb_array_elements(o.history) h
     WHERE h->>'status' = 'accepted' AND (h->>'at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'
  )
  WHERE o.accepted_at IS NULL
    AND jsonb_typeof(o.history) = 'array'
    AND o.history @> '[{"status":"accepted"}]'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.history) h2
                 WHERE h2->>'status' = 'accepted' AND (h2->>'at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}')`;

/* backfill: attrib_source للطلبات القديمة. العمود اتعرّف في W4-02 وماكانش
   بيتكتب، فكل الطلبات اللي قبل النهاردة مالهاش مصدر. بنقرا الصفوف الناقصة
   ونحسبها بنفس دالة الـcheckout (classifySource) — مفيش نسخة تانية من المنطق
   في SQL عشان ما تفرقش عن اللايف. لو الطلب عنده journey_sid بنكمّل الـutm من
   الجلسة الأول. idempotent: بس الصفوف اللي attrib_source فيها NULL. */
export const ATTRIB_BACKFILL_SELECT =
  `SELECT o.order_no, o.attribution, o.journey_sid,
          s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term,
          s.link_slug, s.channel, s.referrer_host, s.started_at
     FROM shop_orders o
     LEFT JOIN journey_sessions s ON s.session_id = o.journey_sid
    WHERE o.attrib_source IS NULL
    ORDER BY o.created_at DESC
    LIMIT $1`;

/* نفس الاستعلام من غير الـJOIN — لو جدول الرحلة لسه مش موجود (قاعدة جديدة)،
   الترحيل مايفشلش، بنصنّف من الـattribution اللي في الطلب بس. */
export const ATTRIB_BACKFILL_SELECT_NOJOIN =
  `SELECT order_no, attribution, journey_sid FROM shop_orders
    WHERE attrib_source IS NULL ORDER BY created_at DESC LIMIT $1`;

export async function backfillAttribSource(pool, { limit = 5000, log = console } = {}) {
  const out = { ok: true, scanned: 0, updated: 0, enriched: 0, error: null };
  try {
    const hasJourney = await pool.query("SELECT to_regclass('public.journey_sessions') AS t")
      .then((r) => !!r?.rows?.[0]?.t).catch(() => false);
    const { rows } = await pool.query(hasJourney ? ATTRIB_BACKFILL_SELECT : ATTRIB_BACKFILL_SELECT_NOJOIN, [limit]);
    out.scanned = rows.length;
    for (const r of rows) {
      const session = r.journey_sid && (r.utm_source || r.link_slug || r.channel) ? r : null;
      const { attribution, enriched } = mergeSessionAttribution(r.attribution || {}, session);
      const src = classifySource(attribution, session);
      await pool.query(
        "UPDATE shop_orders SET attrib_source=$2, attribution=COALESCE($3::jsonb, attribution) WHERE order_no=$1",
        [r.order_no, src, enriched ? JSON.stringify(attribution) : null]);
      out.updated += 1;
      if (enriched) out.enriched += 1;
    }
  } catch (e) {
    out.ok = false;
    out.error = String(e?.message || e).slice(0, 200);
    try { log.error(`[orders-schema] backfill:attrib_source failed: ${out.error}`); } catch {}
  }
  return out;
}

/* كل الـSQL اللي الترحيل ممكن يبعته (للاختبار/المراجعة) */
export function migrationStatements() {
  return [
    ...ORDER_COLUMNS.map(addColumnSql),
    ...ORDER_INDEXES.map((i) => i.sql),
    REAL_VIEW_SQL,
    BACKFILL_ACCEPTED_SQL,
  ];
}

let running = null;

export function ensureOrderColumns(pool, { log = console, backfill = true } = {}) {
  // نداءين في نفس الوقت (register مرتين) → نفس التشغيلة
  if (running && running.pool === pool) return running.promise;
  const promise = run(pool, { log, backfill }).finally(() => {
    if (running?.promise === promise) running = null;
  });
  running = { pool, promise };
  return promise;
}

async function run(pool, { log, backfill }) {
  const report = { ok: true, skipped: null, added: [], indexes: [], view: false, backfilled: 0, attribSource: null, errors: [] };
  const fail = (step, e) => {
    report.ok = false;
    report.errors.push({ step, error: String(e?.message || e).slice(0, 200) });
    try { log.error(`[orders-schema] ${step} failed: ${e?.message || e}`); } catch {}
  };
  try {
    if (!pool || typeof pool.query !== "function") {
      report.ok = false;
      report.skipped = "no_pool";
      return report;
    }
    const t = await pool.query("SELECT to_regclass('public.shop_orders') AS t");
    if (!t?.rows?.[0]?.t) {
      report.skipped = "no_table";
      return report;
    }

    let haveCols = new Set();
    let haveIdx = new Set();
    try {
      const r = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_orders'",
      );
      haveCols = new Set((r?.rows || []).map((x) => x.column_name));
    } catch (e) { fail("list_columns", e); }
    try {
      const r = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='shop_orders'");
      haveIdx = new Set((r?.rows || []).map((x) => x.indexname));
    } catch (e) { fail("list_indexes", e); }

    for (const c of ORDER_COLUMNS) {
      if (haveCols.has(c.name)) continue;
      try {
        await pool.query(addColumnSql(c));
        report.added.push(c.name);
        haveCols.add(c.name);
      } catch (e) { fail(`column:${c.name}`, e); }
    }

    for (const i of ORDER_INDEXES) {
      if (haveIdx.has(i.name)) continue;
      try {
        await pool.query(i.sql);
        report.indexes.push(i.name);
      } catch (e) { fail(`index:${i.name}`, e); }
    }

    if (haveCols.has("is_test")) {
      try {
        await pool.query(REAL_VIEW_SQL);
        report.view = true;
      } catch (e) { fail("view:shop_orders_real", e); }
    }

    if (backfill && haveCols.has("accepted_at") && haveCols.has("history")) {
      try {
        const r = await pool.query(BACKFILL_ACCEPTED_SQL);
        report.backfilled = Number(r?.rowCount) || 0;
      } catch (e) { fail("backfill:accepted_at", e); }
    }

    if (backfill && haveCols.has("attrib_source") && haveCols.has("attribution")) {
      const r = await backfillAttribSource(pool, { log });
      report.attribSource = r;
      if (!r.ok) fail("backfill:attrib_source", r.error);
    }
  } catch (e) {
    fail("migrate", e);
  }
  if (report.added.length || report.indexes.length || report.backfilled || report.attribSource?.updated) {
    try {
      console.log(`[orders-schema] added=${report.added.join(",") || "-"} indexes=${report.indexes.join(",") || "-"} backfilled=${report.backfilled} attrib_source=${report.attribSource?.updated || 0}`);
    } catch {}
  }
  return report;
}

/* اختياري — لو اتربط لوحده. order-events.register بينادي ensureOrderColumns بالفعل. */
export function register(app, ctx = {}) {
  try {
    ensureOrderColumns(ctx?.pool, { log: ctx?.log || console }).catch(() => {});
  } catch {}
  return { ensureOrderColumns: () => ensureOrderColumns(ctx?.pool, { log: ctx?.log || console }) };
}
