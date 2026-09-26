import { test } from "node:test";
import assert from "node:assert/strict";
import { settleStatus, courierKey, allocate } from "./extsettle.js";

test("حالة التسوية", () => {
  assert.equal(settleStatus(null, 0), "needs_cost");
  assert.equal(settleStatus(0, 0), "settled");        // موظف من عندنا
  assert.equal(settleStatus(25, 0), "unpaid");
  assert.equal(settleStatus(25, 10), "partial");
  assert.equal(settleStatus(25, 25), "settled");
  assert.equal(settleStatus(25, 30), "overpaid");
  assert.equal(settleStatus(19.999, 20), "settled");  // تقريب لأقرب هللة
});

test("مفتاح المندوب: الجوال بأي شكل = نفس المندوب", () => {
  assert.equal(courierKey({ phone: "0551234567" }), "p:551234567");
  assert.equal(courierKey({ phone: "+966 55 123 4567", name: "أحمد" }), "p:551234567");
  assert.equal(courierKey({ name: " أحمد " }), "n:أحمد");
  assert.equal(courierKey(null), "unknown");
});

const rows = [
  { id: 3, cost: 20, paid: 0, created_at: "2026-09-25T10:00:00Z" },
  { id: 1, cost: 25, paid: 5, created_at: "2026-09-20T10:00:00Z" },
  { id: 2, cost: 15, paid: 15, created_at: "2026-09-22T10:00:00Z" },
];

test("دفعة من غير مبلغ = كل واحد برصيده", () => {
  const p = allocate(rows, null);
  assert.equal(p.total, 40);
  assert.deepEqual(p.parts, [{ id: 1, amount: 20 }, { id: 3, amount: 20 }]);
});

test("دفعة بمبلغ بتتوزّع بالأقدم أولاً", () => {
  assert.deepEqual(allocate(rows, 30).parts, [{ id: 1, amount: 20 }, { id: 3, amount: 10 }]);
  assert.deepEqual(allocate(rows, 40).parts, [{ id: 1, amount: 20 }, { id: 3, amount: 20 }]);
});

test("مبلغ أكبر من المستحق أو صفر = مرفوض", () => {
  assert.throws(() => allocate(rows, 41), /أكبر من المستحق/);
  assert.throws(() => allocate(rows, 0), /أكبر من صفر/);
});
