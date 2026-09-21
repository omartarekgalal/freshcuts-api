/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات ترحيل أعمدة shop_orders (orders-schema.js — W1-01، الخطة §٤-٢)
     ١) كل أعمدة §٤-٢ موجودة، وكل DDL فيها IF NOT EXISTS (snapshot)
     ٢) الترحيل idempotent: الموجود بيتفوّت، ونداء تاني مابيعملش ALTER
     ٣) قاعدة فاضية (مفيش shop_orders) → مفيش أي تعديل
     ٤) مابترميش حتى لو كل استعلام فشل
     node --test orders-schema.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const sch = await import("./orders-schema.js");
const { ORDER_COLUMNS, ORDER_INDEXES, migrationStatements, ensureOrderColumns, REAL_VIEW_SQL, BACKFILL_ACCEPTED_SQL } = sch;

const BASE_COLS = ["order_no", "status", "option", "branch_id", "customer", "phone_norm", "address", "items", "total",
  "pos_order_id", "history", "created_at", "updated_at", "attribution"];

/* داتابيز مزيّفة بتفهم فحص الجدول/الأعمدة/الفهارس وبتطبّق ADD COLUMN و CREATE INDEX */
function fakePool({ table = true, cols = BASE_COLS, idx = ["shop_orders_attr_link_idx"], failAll = false } = {}) {
  const columns = new Set(cols), indexes = new Set(idx);
  return {
    sql: [], columns, indexes,
    async query(sql) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      this.sql.push(s);
      if (failAll) throw new Error("db down");
      if (/to_regclass/.test(s)) return { rows: [{ t: table ? "shop_orders" : null }] };
      if (/information_schema\.columns/.test(s)) return { rows: [...columns].map((column_name) => ({ column_name })) };
      if (/FROM pg_indexes/.test(s)) return { rows: [...indexes].map((indexname) => ({ indexname })) };
      let m = s.match(/^ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS (\w+)/);
      if (m) { columns.add(m[1]); return { rows: [], rowCount: 0 }; }
      m = s.match(/^CREATE INDEX IF NOT EXISTS (\w+)/);
      if (m) { indexes.add(m[1]); return { rows: [], rowCount: 0 }; }
      if (/^UPDATE shop_orders o SET accepted_at/.test(s)) return { rows: [], rowCount: 3 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const quiet = { error() {} };

test("every §4-2 column is declared with the planned type", () => {
  const byName = Object.fromEntries(ORDER_COLUMNS.map((c) => [c.name, c.type]));
  assert.deepEqual(byName, {
    attribution: "JSONB",
    journey_sid: "TEXT",
    client: "TEXT",
    app_version: "TEXT",
    is_test: "BOOLEAN NOT NULL DEFAULT false",
    attrib_source: "TEXT",
    customer_seq: "INT",
    phone_verified_at: "TIMESTAMPTZ",
    ready_source: "TEXT",
    ready_by: "TEXT",
    accepted_at: "TIMESTAMPTZ",
    portal_ack_at: "TIMESTAMPTZ",
    portal_ack_by: "TEXT",
    collected_at: "TIMESTAMPTZ",
    // ٢١/٩ — ts_orders.order_id بتاع مرآة الطلب في نقطة البيع (من
    // tenant_order_id بتاع API الشركاء). pos_order_id المقنّع مالوش علاقة بيه.
    pos_tenant_order_id: "TEXT",
  });
});

test("DDL snapshot: all IF NOT EXISTS / OR REPLACE, planned indexes and view", () => {
  const stmts = migrationStatements();
  for (const s of stmts) {
    if (/^ALTER TABLE/.test(s)) assert.match(s, /^ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS \w+ /, s);
    else if (/^CREATE INDEX/.test(s)) assert.match(s, /^CREATE INDEX IF NOT EXISTS \w+ ON shop_orders/, s);
    else if (/^CREATE/.test(s)) assert.match(s, /^CREATE OR REPLACE VIEW shop_orders_real /, s);
    else assert.match(s, /^UPDATE shop_orders o SET accepted_at/, s);
    assert.ok(!/\bDROP\b|\bALTER COLUMN\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\b/i.test(s), s);
  }
  const idx = ORDER_INDEXES.map((i) => i.sql).join("\n");
  assert.match(idx, /ON shop_orders\(created_at DESC, order_no DESC\)/);
  assert.match(idx, /ON shop_orders\(option, created_at DESC\)/);
  assert.match(idx, /ON shop_orders\(pos_order_id\) WHERE pos_order_id IS NOT NULL/);
  assert.match(idx, /ON shop_orders\(attrib_source, created_at DESC\)/);
  assert.match(idx, /ON shop_orders\(created_at DESC\) WHERE is_test/);
  assert.match(idx, /\(\(attribution->>'fc_link'\)\)/);
  for (const i of ORDER_INDEXES) assert.ok(i.sql.includes(` ${i.name} `), i.name);
  assert.equal(REAL_VIEW_SQL, "CREATE OR REPLACE VIEW shop_orders_real AS SELECT * FROM shop_orders WHERE NOT is_test");
  assert.match(BACKFILL_ACCEPTED_SQL, /WHERE o\.accepted_at IS NULL/);
  assert.match(BACKFILL_ACCEPTED_SQL, /h->>'status' = 'accepted'/);
});

test("fresh migration adds only missing columns/indexes, creates view, backfills", async () => {
  const pool = fakePool();
  const r = await ensureOrderColumns(pool, { log: quiet });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!r.added.includes("attribution"), "attribution already exists → no ALTER");
  assert.deepEqual(r.added.sort(), ORDER_COLUMNS.map((c) => c.name).filter((n) => n !== "attribution").sort());
  assert.ok(!r.indexes.includes("shop_orders_attr_link_idx"));
  assert.equal(r.indexes.length, ORDER_INDEXES.length - 1);
  assert.equal(r.view, true);
  assert.equal(r.backfilled, 3);
  // الأعمدة قبل الفهارس قبل الـview
  const firstIdx = pool.sql.findIndex((s) => /^CREATE INDEX/.test(s));
  const lastAlter = pool.sql.map((s) => /^ALTER TABLE/.test(s)).lastIndexOf(true);
  const viewAt = pool.sql.findIndex((s) => /^CREATE OR REPLACE VIEW/.test(s));
  assert.ok(lastAlter < firstIdx && firstIdx < viewAt);
  for (const s of pool.sql) {
    if (/^(ALTER|CREATE INDEX)/.test(s)) assert.match(s, /IF NOT EXISTS/);
  }
});

test("second run is a no-op for columns and indexes (idempotent)", async () => {
  const pool = fakePool();
  await ensureOrderColumns(pool, { log: quiet });
  pool.sql.length = 0;
  const r = await ensureOrderColumns(pool, { log: quiet });
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.indexes, []);
  assert.ok(!pool.sql.some((s) => /^ALTER TABLE|^CREATE INDEX/.test(s)));
});

test("concurrent calls share one run", async () => {
  const pool = fakePool();
  const [a, b] = await Promise.all([ensureOrderColumns(pool, { log: quiet }), ensureOrderColumns(pool, { log: quiet })]);
  assert.equal(a, b);
  assert.equal(pool.sql.filter((s) => /ADD COLUMN IF NOT EXISTS is_test/.test(s)).length, 1);
});

test("empty database (no shop_orders): nothing touched", async () => {
  const pool = fakePool({ table: false });
  const r = await ensureOrderColumns(pool, { log: quiet });
  assert.equal(r.skipped, "no_table");
  assert.equal(pool.sql.length, 1);
});

test("never throws: no pool, or every query failing", async () => {
  const r1 = await ensureOrderColumns(null, { log: quiet });
  assert.equal(r1.ok, false);
  assert.equal(r1.skipped, "no_pool");
  const r2 = await ensureOrderColumns(fakePool({ failAll: true }), { log: quiet });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.length >= 1);
});

test("a single failing ALTER does not stop the rest; view skipped when is_test missing", async () => {
  const pool = fakePool();
  const orig = pool.query.bind(pool);
  pool.query = async (sql) => {
    if (/ADD COLUMN IF NOT EXISTS is_test/.test(sql)) throw new Error("lock timeout");
    return orig(sql);
  };
  const r = await ensureOrderColumns(pool, { log: quiet });
  assert.equal(r.ok, false);
  assert.ok(r.added.includes("collected_at"));
  assert.ok(!r.added.includes("is_test"));
  assert.equal(r.view, false);
  assert.ok(r.errors.some((e) => e.step === "column:is_test"));
});

test("order-events.register runs the orders migration without blocking", async () => {
  const ev = await import("./order-events.js");
  const pool = fakePool();
  ev.register({}, { pool, log: quiet });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(pool.sql.some((s) => /CREATE TABLE IF NOT EXISTS shop_order_events/.test(s)));
  assert.ok(pool.sql.some((s) => /ADD COLUMN IF NOT EXISTS journey_sid/.test(s)));
  ev.stopEventStore();
});
