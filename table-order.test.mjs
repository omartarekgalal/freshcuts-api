/* 🍽 «اطلب وادفع من طاولتك» — QR الطاولات (أكتوبر ٢٠٢٦).
   node --test table-order.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { parseTable, tableCfg, tableForCheckout, posOptionOf, tableNote, TABLE_DEFAULTS } from "./table-order.js";
import { posNotesOf, posAddressLine } from "./shop.js";
import { buildBoard } from "./kitchen-core.js";
import { toPortalOrder } from "./portal-core.js";
import { ORDER_COLUMNS } from "./orders-schema.js";

test("parseTable: رقم/نص/table-N/tN/أرقام هندية — وأي حاجة تانية null", () => {
  assert.equal(parseTable(7), 7);
  assert.equal(parseTable("7"), 7);
  assert.equal(parseTable(" table-12 "), 12);
  assert.equal(parseTable("T3"), 3);
  assert.equal(parseTable("طاولة ٧"), 7);
  for (const bad of [0, -1, 100, "1.5", "7a", "abc", "", null, undefined, true, {}, [], "table-", "999"]) {
    assert.equal(parseTable(bad), null, `bad ${JSON.stringify(bad)}`);
  }
});

test("الإعدادات: الافتراضي ١٢ طاولة، maxNo ٩٩، والقفل بيرجّع null", () => {
  assert.deepEqual(tableCfg({}), { ...TABLE_DEFAULTS });
  assert.deepEqual(tableCfg({ tables: { count: 10, maxNo: 20 } }), { ...TABLE_DEFAULTS, count: 10, maxNo: 20 });
  assert.deepEqual(tableCfg({ tables: { count: "x", maxNo: -3 } }), { ...TABLE_DEFAULTS });
  assert.equal(parseTable(21, tableCfg({ tables: { maxNo: 20 } })), null);
  assert.equal(parseTable(5, tableCfg({ tables: { enabled: false } })), null);
});

test("tableForCheckout: استلام دلوقتي بس — توصيل أو طلب مسبق = من غير طاولة", () => {
  assert.equal(tableForCheckout({ table: 4 }, "pickup"), 4);
  assert.equal(tableForCheckout({ table: 4 }, "delivery"), null);
  assert.equal(tableForCheckout({ table: 4 }, "pickup", { scheduled: true }), null);
  assert.equal(tableForCheckout({}, "pickup"), null);
  assert.equal(tableForCheckout(null, "pickup"), null);
  assert.equal(tableForCheckout({ table: 4 }, "pickup", { settings: { tables: { enabled: false } } }), null);
});

test("نقطة البيع: Dine in + أول الملاحظات «🍽 طاولة N» ومفيش «استلام HH:MM»", () => {
  const base = { order_no: "W1", option: "pickup", created_at: "2026-10-05T17:00:00Z", delivery_fee: 0, notes: "بدون بصل" };
  assert.equal(posOptionOf({ ...base, table_no: 7 }), "dine_in");
  assert.equal(posOptionOf(base), "pickup");
  assert.equal(posOptionOf({ ...base, option: "delivery" }), "delivery");
  const t = posNotesOf({ ...base, table_no: 7 }, { withFee: true });
  assert.ok(t.startsWith(tableNote(7)), t);
  assert.ok(!/استلام/.test(t), t);
  assert.ok(t.includes("مدفوع أونلاين✅") && t.includes("📝 بدون بصل"), t);
  // الطلب العادي زي ما هو بالظبط
  const p = posNotesOf(base, { withFee: true, now: Date.parse("2026-10-05T17:00:00Z") });
  assert.ok(p.startsWith("استلام - طُلب 20:00 - استلام 20:40"), p);
  assert.equal(posAddressLine({ ...base, table_no: 7 }), "صالة — طاولة 7");
  assert.equal(posAddressLine(base), "استلام");
});

test("المطبخ: طلب الطاولة بيظهر «طاولة N» بقناة store_table — والاستلام العادي مايتغيّرش", () => {
  const NOW = Date.parse("2026-10-05T18:00:00Z");
  const iso = (m) => new Date(NOW - m * 60_000).toISOString();
  const row = (no, extra) => ({ order_no: no, status: "pos_created", option: "pickup", pos_order_id: null,
    items: [{ name: "وجبة طرب", qty: 1 }], notes: "", address: null, created_at: iso(3), updated_at: iso(1), is_test: false, ...extra });
  const board = buildBoard({ tsOrders: [], shopRows: [row("W7", { table_no: 7 }), row("W8", {})], now: NOW });
  const t = board.find((o) => o.key === "shop:W7");
  const p = board.find((o) => o.key === "shop:W8");
  assert.equal(t.table, "طاولة 7");
  assert.equal(t.channel.key, "store_table");
  assert.equal(p.table, null);
  assert.equal(p.channel.key, "store_pickup");
});

test("البوابة: tableNo على الكارت", () => {
  const r = { order_no: "W7", option: "pickup", status: "pos_created", items: [], history: [], created_at: "2026-10-05T17:00:00Z" };
  assert.equal(toPortalOrder({ ...r, table_no: 7 }).tableNo, 7);
  assert.equal(toPortalOrder(r).tableNo, null);
});

test("الترحيل: عمود table_no INT nullable", () => {
  assert.deepEqual(ORDER_COLUMNS.find((c) => c.name === "table_no"), { name: "table_no", type: "INT" });
});
