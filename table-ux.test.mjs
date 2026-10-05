/* 🍽 QR الطاولات — تجربة العميل والويتر (مراجعة ٥/١٠ مساءً).
   node --test table-ux.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { firstNameOf, tableWho, tableNote, liveTables, tableBusy, openTableSession, register, tableCfg } from "./table-order.js";
import { posNotesOf, posAddressLine } from "./shop.js";
import { statusSmsText } from "./notify.js";

function fakePool(handlers = {}) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      log.push({ sql, params });
      for (const [needle, fn] of Object.entries(handlers)) if (sql.includes(needle)) return fn(params, sql);
      return { rows: [], rowCount: 0 };
    },
  };
}

test("الاسم الأول: كلمة واحدة مُنضّفة ≤١٤ حرف — مفيش حروف اتجاه ولا أرقام ولا جوال", () => {
  assert.equal(firstNameOf("  أحمد محمد علي"), "أحمد");
  assert.equal(firstNameOf("MOHAMED ABDELMONSEF"), "MOHAMED");
  assert.equal(firstNameOf("‮سارة"), "سارة");          // RLO اتشال
  assert.equal(firstNameOf("0544775082 خالد"), "خالد");      // الرقم مش اسم
  assert.equal(firstNameOf("عبدالرحمنعبدالرحمن"), "عبدالرحمنعبدال");
  for (const bad of ["", null, undefined, "123", "🍽"]) assert.equal(firstNameOf(bad), null, String(bad));
});

test("التذكرة: «طاولة 7 · أحمد» في نقطة البيع والعنوان — ومن غير اسم زي الأول بالظبط", () => {
  const row = { order_no: "W1", option: "pickup", table_no: 7, created_at: "2026-10-05T17:00:00Z", customer: { name: "أحمد سالم" } };
  assert.equal(tableWho(7, "أحمد سالم"), "طاولة 7 · أحمد");
  assert.ok(posNotesOf(row).startsWith("🍽 طاولة 7 · أحمد — يتقدّم على الطاولة"), posNotesOf(row));
  assert.equal(posAddressLine(row), "صالة — طاولة 7 · أحمد");
  assert.equal(tableNote(7), "🍽 طاولة 7 — يتقدّم على الطاولة");
  assert.equal(posAddressLine({ ...row, customer: {} }), "صالة — طاولة 7");
});

test("شريط البوابة: كل طلب باسمه الأول وحالته (جاهز/اتقدّم) — من غير جوال", () => {
  const live = liveTables({
    sessions: [{ table_no: 7, sessions: 3, since: "2026-10-05T17:00:00Z", last_at: "2026-10-05T17:30:00Z" }],
    orders: [
      { order_no: "W1", table_no: 7, total: 50, created_at: "2026-10-05T17:10:00Z", pos_ready_at: "2026-10-05T17:25:00Z", customer_name: "أحمد سالم", status: "accepted" },
      { order_no: "W2", table_no: 7, total: 30, created_at: "2026-10-05T17:12:00Z", customer_name: "سارة", status: "accepted" },
    ],
  });
  assert.deepEqual(live[0].people, [
    { orderNo: "W1", name: "أحمد", ready: true, served: false },
    { orderNo: "W2", name: "سارة", ready: false, served: false },
  ]);
  assert.ok(!/5\d{8}/.test(JSON.stringify(live)), "مفيش جوال");
});

test("حد الطلبات بيعدّ القعدة الحالية بس (من بعد «الطاولة فضيت»)", async () => {
  const p = fakePool({ "FROM shop_orders": () => ({ rows: [{ n: 0 }] }) });
  await tableBusy(p, 7, tableCfg({}));
  assert.match(p.log[0].sql, /freed_at FROM table_qr WHERE table_no=\$1/);
});

test("نفس الموبايل اتنقل لطاولة تانية: جلسته القديمة بتخلص (moved)", async () => {
  const p = fakePool({ "UPDATE table_sessions SET last_at=NOW()": () => ({ rows: [] }) });
  const id = await openTableSession(p, 5, "dev_0123456789abcdef", tableCfg({}));
  assert.ok(id);
  const moved = p.log.find((l) => l.sql.includes("end_reason='moved'"));
  assert.ok(moved, "مفيش قفل للجلسة القديمة");
  assert.equal(moved.params[1], 5);
  assert.ok(p.log.findIndex((l) => l.sql.includes("end_reason='moved'")) < p.log.findIndex((l) => l.sql.includes("INSERT INTO table_sessions")));
});

test("«الطاولة فضيت»: الطلبات الجاهزة بس بتتعلّم «اتقدّم» (delivered) — اللي بيتجهّز مابيتلمسش", async () => {
  const marked = [];
  const pool = fakePool({
    "CREATE TABLE": () => ({ rows: [] }),
    "SELECT order_no, status FROM shop_orders": (params, sql) => {
      assert.match(sql, /pos_ready_at IS NOT NULL/);
      assert.match(sql, /status IN \('pos_created','accepted'\)/);
      return { rows: [{ order_no: "W9", status: "accepted" }] };
    },
    "end_reason='freed'": () => ({ rowCount: 2 }),
  });
  const app = new Hono();
  register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({}) }, {
    portal: () => ({ requirePortal: async () => ({ user: { name: "كاشير" } }) }),
    shop: () => ({ setStatus: async (no, st, extra) => { marked.push([no, st, extra.from]); } }),
  });
  const r = await (await app.request("/api/tables/7/free", { method: "POST" })).json();
  assert.deepEqual([r.ok, r.ended, r.served], [true, 2, 1]);
  assert.deepEqual(marked, [["W9", "delivered", "accepted"]]);
});

test("رسالة «اتسلّم»: الاستلام/الطاولة مابتقولش «تم توصيل طلبك»", () => {
  assert.ok(!/توصيل/.test(statusSmsText("delivered", { option: "pickup", order_no: "W1" })));
  assert.match(statusSmsText("delivered", { option: "delivery", order_no: "W1" }), /تم توصيل طلبك/);
});
