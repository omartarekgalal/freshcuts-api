/* أسماء الأصناف — محلّل الأسماء والـbackfill (node --test product-names.test.mjs)
   مفيش شبكة ولا قاعدة بيانات حقيقية: tsstore وهمي، وpool وهمي بيسجّل الاستعلامات. */
import test from "node:test";
import assert from "node:assert/strict";
import { makeNameResolver, backfillItemNames, needsName } from "./product-names.js";

const MENU = {
  pages: [
    { items: [{ id: 105, name: "سجق مشوي بالوزن", local_name: "Grilled Sausage" },
              { id: 79, name: "كفتة مشوية بالوزن" }] },
    { items: [{ id: 9, name: "بيبسي" }, { id: 105, name: "مكرر يتتجاهل" }] },
  ],
};

/* pool وهمي: بيرد على DDL وSELECT وINSERT من غير ما يلمس قاعدة حقيقية */
function fakePool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      if (/^SELECT product_id/i.test(sql.trim())) return { rows };
      if (/^SELECT order_no/i.test(sql.trim())) return { rows };
      return { rows: [], rowCount: 1 };
    },
  };
}
const quietLog = { error: () => {}, log: () => {} };
const fakeTs = (menu = MENU, product = null) => ({
  fetchMenu: async () => menu,
  STORE: () => "freshcuts",
  callStore: async () => (product ? { data: product } : (() => { throw new Error("404"); })()),
});

test("needsName: السطر اللي مالوش اسم بس", () => {
  assert.equal(needsName({ product_id: 79 }), true);
  assert.equal(needsName({ product_id: 79, name: "  " }), true);
  assert.equal(needsName({ product_id: 79, name: "كفتة" }), false);
  assert.equal(needsName({ product_id: 79, product_name: "كفتة" }), false);
  assert.equal(needsName({ quantity: 1 }), false, "من غير product_id مفيش حاجة نحلّها");
  assert.equal(needsName(null), false);
});

test("fillNames: الاسم بييجي من القايمة، والسعر والكمية ما يتلمسوش", async () => {
  const pool = fakePool();
  const r = makeNameResolver({ pool, tsstore: fakeTs(), log: quietLog });
  const items = [
    { product_id: 79, quantity: 2, unit_amount: 34782608700, tax_id: 1 },
    { product_id: 9, quantity: 1, unit_amount: 5000000000 },
    { product_id: 999, quantity: 1 },                     // مش في القايمة
    { product_id: 105, quantity: 1, name: "اسم يدوي" },   // اسمه موجود = ما يتغيّرش
  ];
  const out = await r.fillNames(items);
  assert.equal(out.filled, 2);
  assert.equal(out.items[0].name, "كفتة مشوية بالوزن");
  assert.equal(out.items[0].quantity, 2);
  assert.equal(out.items[0].unit_amount, 34782608700, "الفلوس زي ما هي");
  assert.equal(out.items[1].name, "بيبسي");
  assert.equal(out.items[2].name, undefined, "المجهول بيفضل مجهول — الشاشة بتقول «صنف #999»");
  assert.equal(out.items[3].name, "اسم يدوي");
  // المصفوفة الأصلية ما اتغيّرتش (نسخة جديدة بس)
  assert.equal(items[0].name, undefined);
});

test("fillNames: مافيش شغل لو كل السطور بأسماء", async () => {
  const pool = fakePool();
  let menuHits = 0;
  const ts = { ...fakeTs(), fetchMenu: async () => { menuHits++; return MENU; } };
  const r = makeNameResolver({ pool, tsstore: ts, log: quietLog });
  const out = await r.fillNames([{ product_id: 1, name: "كبدة", quantity: 1 }]);
  assert.equal(out.filled, 0);
  assert.equal(menuHits, 0, "مانضربش تاب سينس على الفاضي");
  assert.deepEqual(await r.fillNames([]), { items: [], filled: 0 });
  assert.deepEqual((await r.fillNames(null)).items, null);
});

test("fillNames: اسم الوزن من تفاصيل الصنف لما المتصفح ما يبعتوش", async () => {
  const pool = fakePool();
  const ts = fakeTs(MENU, { id: 105, name: "سجق مشوي بالوزن",
    variant: { options: [{ id: 44, name: "ثلث كيلو" }, { id: 45, name: "نصف كيلو" }] } });
  const r = makeNameResolver({ pool, tsstore: ts, log: quietLog });
  const out = await r.fillNames([{ product_id: 105, variant_option_id: 45, quantity: 1 }]);
  assert.equal(out.items[0].name, "سجق مشوي بالوزن");
  assert.equal(out.items[0].variant_name, "نصف كيلو");
});

test("fillNames: تاب سينس واقعة = الطلب بيعدّي زي ما هو، من غير رمي", async () => {
  const pool = fakePool();
  const ts = { fetchMenu: async () => { throw new Error("upstream down"); },
    STORE: () => "x", callStore: async () => { throw new Error("down"); } };
  const r = makeNameResolver({ pool, tsstore: ts, log: quietLog });
  const out = await r.fillNames([{ product_id: 79, quantity: 1 }]);
  assert.equal(out.filled, 0);
  assert.equal(out.items[0].product_id, 79);
});

test("fillRows: بيرجّع نفس الصف بالظبط لو مفيش اسم ناقص", async () => {
  const pool = fakePool();
  const r = makeNameResolver({ pool, tsstore: fakeTs(), log: quietLog });
  const rows = [{ order_no: "W1", items: [{ product_id: 9, name: "بيبسي" }] }];
  assert.equal(await r.fillRows(rows), rows);
  const mixed = [{ order_no: "W2", items: [{ product_id: 9 }] }];
  const out = await r.fillRows(mixed);
  assert.equal(out[0].items[0].name, "بيبسي");
  assert.equal(out[0].order_no, "W2");
});

test("backfill: بيكتب الطلبات اللي اتصلّحت بس، والفشل ما يوقّفش الباقي", async () => {
  const updates = [];
  const pool = {
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, " ").trim();
      if (/^CREATE TABLE/i.test(q)) return { rows: [] };
      if (/^SELECT product_id/i.test(q)) return { rows: [] };
      if (/^SELECT order_no, items FROM shop_orders/i.test(q)) {
        return { rows: [
          { order_no: "W1", items: [{ product_id: 79, quantity: 1 }] },
          { order_no: "W2", items: [{ product_id: 999, quantity: 1 }] },   // مجهول = مايتكتبش
          { order_no: "W3", items: [{ product_id: 9, quantity: 1 }] },
        ] };
      }
      if (/^UPDATE shop_orders/i.test(q)) {
        if (params[0] === "W3") throw new Error("db hiccup");
        updates.push({ orderNo: params[0], items: JSON.parse(params[1]) });
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const r = makeNameResolver({ pool, tsstore: fakeTs(), log: quietLog });
  const out = await backfillItemNames(pool, r, { days: 30, limit: 100, log: quietLog });
  assert.equal(out.scanned, 3);
  assert.equal(out.updated, 1, "W1 بس — W2 مجهول وW3 وقع");
  assert.equal(out.lines, 1);
  assert.equal(out.failed, 1);
  assert.equal(updates[0].orderNo, "W1");
  assert.equal(updates[0].items[0].name, "كفتة مشوية بالوزن");
  assert.equal(updates[0].items[0].quantity, 1);
});

test("backfill: استعلام واقع = رد واضح مش انهيار", async () => {
  const pool = { async query() { throw new Error("no table"); } };
  const r = makeNameResolver({ pool, tsstore: fakeTs(), log: quietLog });
  const out = await backfillItemNames(pool, r, { log: quietLog });
  assert.equal(out.error, "query_failed");
  assert.equal(out.updated, 0);
});
