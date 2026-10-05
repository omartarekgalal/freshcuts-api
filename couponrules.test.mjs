import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCoupon, firstEligibility, isFirstCode, isPureFreeDelivery, usedOnceSql, PRIOR_DELIVERY_SQL } from "./couponrules.js";

/* fake «قاعدة»: طلبات الجوال (option/coupon/status/paid) — نفس منطق الـSQL */
function fakeQ(orders) {
  const calls = [];
  return {
    calls,
    usedOnce: async (code, pn, pureFree) => {
      calls.push(["usedOnce", code, pn, pureFree]);
      return orders.some((o) => o.pn === pn && o.coupon === code && !["pending_payment", "expired"].includes(o.status)
        && (!pureFree || o.option === "delivery"));
    },
    priorDelivery: async (pn) => {
      calls.push(["priorDelivery", pn]);
      return orders.some((o) => o.pn === pn && o.option === "delivery" && o.paid !== false && !o.is_test);
    },
  };
}
const FIRST = { code: "FIRST", percent: "0", active: true, min_total: "60", max_uses: null, used_count: 116,
  expires_at: null, once_per_customer: true, free_delivery: true, phone_norm: null };
const PN = "512345678";
const NOW = new Date("2026-10-06T10:00:00Z");

test("FIRST: a customer whose only orders were table/pickup still gets it (decision 5/10)", async () => {
  const q = fakeQ([
    { pn: PN, option: "pickup", status: "delivered" },              // طاولة (pickup + table_no في الداتا)
    { pn: PN, option: "pickup", status: "delivered", coupon: "FIRST" }, // استلام قديم اتسجّل عليه FIRST قبل الإصلاح
  ]);
  const r = await evaluateCoupon(FIRST, { subtotal: 75, phoneNorm: PN, now: NOW }, q);
  assert.equal(r.ok, true);
  assert.equal(r.freeDelivery, true);
  assert.deepEqual(q.calls[0], ["usedOnce", "FIRST", PN, true], "once-per-customer counts delivery orders only");
});

test("FIRST: refused after any earlier paid web DELIVERY order, even one without FIRST", async () => {
  const q = fakeQ([{ pn: PN, option: "delivery", status: "delivered" }]);
  const r = await evaluateCoupon(FIRST, { subtotal: 75, phoneNorm: PN, now: NOW }, q);
  assert.deepEqual(r, { ok: false, error: "already_used", reason: "prior_delivery" },
    "same error code the live storefront already handles (auto-FIRST drops quietly)");
});

test("FIRST: still once per phone — used on a delivery order = already_used", async () => {
  const q = fakeQ([{ pn: PN, option: "delivery", status: "delivered", coupon: "FIRST" }]);
  const r = await evaluateCoupon(FIRST, { subtotal: 75, phoneNorm: PN, now: NOW }, q);
  assert.equal(r.ok, false);
  assert.equal(r.error, "already_used");
  assert.equal(r.reason, undefined);
});

test("FIRST: unpaid / test delivery orders don't block; min 60 still enforced", async () => {
  const q = fakeQ([
    { pn: PN, option: "delivery", status: "pending_payment", paid: false },
    { pn: PN, option: "delivery", status: "delivered", is_test: true },
  ]);
  assert.equal((await evaluateCoupon(FIRST, { subtotal: 60, phoneNorm: PN, now: NOW }, q)).ok, true);
  assert.deepEqual(await evaluateCoupon(FIRST, { subtotal: 59.99, phoneNorm: PN, now: NOW }, q),
    { ok: false, error: "min_total", minTotal: 60 });
});

test("FIRST: other phone's delivery orders don't matter; no phone (cart preview) = no order checks", async () => {
  const q = fakeQ([{ pn: "598765432", option: "delivery", status: "delivered", coupon: "FIRST" }]);
  assert.equal((await evaluateCoupon(FIRST, { subtotal: 80, phoneNorm: PN, now: NOW }, q)).ok, true);
  const q2 = fakeQ([]);
  assert.equal((await evaluateCoupon(FIRST, { subtotal: 80, phoneNorm: null, now: NOW }, q2)).ok, true);
  assert.equal(q2.calls.length, 0);
});

test("prior delivery rule is FIRST-only: loyalty / WB free-delivery codes ignore earlier deliveries", async () => {
  const loyal = { code: "FC1A2B3C4D", percent: "0", active: true, min_total: "0", max_uses: 1, used_count: 0,
    expires_at: "2026-10-18", once_per_customer: true, free_delivery: true, phone_norm: PN };
  const q = fakeQ([{ pn: PN, option: "delivery", status: "delivered" }]);
  assert.equal((await evaluateCoupon(loyal, { subtotal: 30, phoneNorm: PN, now: NOW }, q)).ok, true);
  assert.ok(!q.calls.some((c) => c[0] === "priorDelivery"));
});

test("phone-bound coupon (loyalty): other phone = not_found; expired/maxed/inactive refused", async () => {
  const base = { code: "FC1A2B3C4D", percent: "0", active: true, min_total: "0", max_uses: 1, used_count: 0,
    expires_at: "2026-10-18T00:00:00.000Z", once_per_customer: true, free_delivery: true, phone_norm: PN };
  const q = fakeQ([]);
  assert.deepEqual(await evaluateCoupon(base, { subtotal: 30, phoneNorm: "598765432", now: NOW }, q), { ok: false, error: "not_found" });
  assert.equal((await evaluateCoupon(base, { subtotal: 30, phoneNorm: PN, now: new Date("2026-10-18T20:00:00Z") }, q)).ok, true, "valid through its expiry day");
  assert.deepEqual(await evaluateCoupon(base, { subtotal: 30, phoneNorm: PN, now: new Date("2026-10-19T08:00:00Z") }, q), { ok: false, error: "expired" });
  assert.deepEqual(await evaluateCoupon({ ...base, used_count: 1 }, { subtotal: 30, phoneNorm: PN, now: NOW }, q), { ok: false, error: "maxed" });
  assert.deepEqual(await evaluateCoupon({ ...base, active: false }, { subtotal: 30, phoneNorm: PN, now: NOW }, q), { ok: false, error: "not_found" });
  const used = fakeQ([{ pn: PN, option: "delivery", status: "on_the_way", coupon: "FC1A2B3C4D" }]);
  assert.deepEqual(await evaluateCoupon(base, { subtotal: 30, phoneNorm: PN, now: NOW }, used), { ok: false, error: "already_used" });
});

test("percent coupons keep the old once-per-customer semantics (any order type counts)", async () => {
  const pct = { code: "SAVE10", percent: "10", active: true, min_total: "0", max_uses: null, used_count: 0,
    expires_at: null, once_per_customer: true, free_delivery: false, phone_norm: null };
  const q = fakeQ([{ pn: PN, option: "pickup", status: "delivered", coupon: "SAVE10" }]);
  assert.equal((await evaluateCoupon(pct, { subtotal: 30, phoneNorm: PN, now: NOW }, q)).error, "already_used");
  assert.equal(isPureFreeDelivery(pct), false);
  assert.equal(isPureFreeDelivery({ ...pct, percent: "0", free_delivery: true }), true);
  assert.equal(isPureFreeDelivery({ ...pct, percent: "10", free_delivery: true }), false);
});

test("firstEligibility: inactive/expired FIRST, used, prior delivery, table-only customer", async () => {
  assert.deepEqual(await firstEligibility(null, PN, fakeQ([])), { eligible: false, reason: "inactive" });
  assert.deepEqual(await firstEligibility({ ...FIRST, active: false }, PN, fakeQ([])), { eligible: false, reason: "inactive" });
  assert.deepEqual(await firstEligibility({ ...FIRST, expires_at: "2026-10-01" }, PN, fakeQ([]), NOW), { eligible: false, reason: "expired" });
  assert.deepEqual(await firstEligibility(FIRST, PN, fakeQ([{ pn: PN, option: "delivery", status: "delivered", coupon: "FIRST" }])), { eligible: false, reason: "used" });
  assert.deepEqual(await firstEligibility(FIRST, PN, fakeQ([{ pn: PN, option: "delivery", status: "delivered" }])), { eligible: false, reason: "prior_delivery" });
  assert.deepEqual(await firstEligibility(FIRST, PN, fakeQ([{ pn: PN, option: "pickup", status: "delivered" }])), { eligible: true, reason: null });
});

test("SQL: delivery-only filter only for pure free-delivery; prior-delivery uses the paid-order rule", () => {
  assert.match(usedOnceSql(true), /option='delivery'/);
  assert.doesNotMatch(usedOnceSql(false), /option=/);
  assert.match(PRIOR_DELIVERY_SQL, /so\.option='delivery'/);
  assert.match(PRIOR_DELIVERY_SQL, /is_test/);
  assert.match(PRIOR_DELIVERY_SQL, /rejected_refunded/);
  assert.equal(isFirstCode(" first "), true);
  assert.equal(isFirstCode("FIRST2"), false);
});
