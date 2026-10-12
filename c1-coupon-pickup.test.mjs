// C1 (12/10): a free-delivery code on a pickup / table order never stops the checkout; the answer says it was ignored.
// A delivery order is not touched by this rule: there, dropping the code changes the amount charged, so the refusal stays.
// Run: node --test c1-coupon-pickup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nonDeliveryCoupon } from "./couponrules.js";
const shop = readFileSync(new URL("./shop.js", import.meta.url), "utf8");

const FIRST_OK = { ok: true, code: "FIRST", percent: 0, freeDelivery: true, minTotal: 60 };
const FIRST_USED = { ok: false, error: "already_used", reason: "prior_delivery" };
const FIRST_MIN = { ok: false, error: "min_total", minTotal: 60 };

test("pickup: FIRST that is valid is not recorded on the order (it would be burnt) — ignored, and said", () => {
  const r = nonDeliveryCoupon(FIRST_OK, { option: "pickup", code: "first" });
  assert.equal(r.coupon, null);
  assert.deepEqual(r.ignored, { code: "FIRST", reason: "free_delivery_code_on_pickup", error: null });
});

test("pickup: FIRST that is NOT valid for the phone (already used, under minimum) does not stop the order", () => {
  for (const c of [FIRST_USED, FIRST_MIN]) {
    const r = nonDeliveryCoupon(c, { option: "pickup", code: "FIRST", pureFree: true });
    assert.equal(r.coupon, null, c.error);
    assert.deepEqual(r.ignored, { code: "FIRST", reason: "free_delivery_code_on_pickup", error: c.error });
  }
});

test("table order: same rule, named as a table", () => {
  assert.equal(nonDeliveryCoupon(FIRST_OK, { option: "pickup", table: true }).ignored.reason, "free_delivery_code_on_table");
  assert.equal(nonDeliveryCoupon(FIRST_USED, { option: "pickup", table: true, pureFree: true, code: "FIRST" }).ignored.reason, "free_delivery_code_on_table");
});

test("pickup: any other code is untouched — a valid percent code applies, an invalid or mistyped code is still refused", () => {
  const pct = { ok: true, code: "SAVE10", percent: 10, freeDelivery: false };
  assert.deepEqual(nonDeliveryCoupon(pct, { option: "pickup" }), { coupon: pct, ignored: null });
  const both = { ok: true, code: "VIP", percent: 15, freeDelivery: true };
  assert.deepEqual(nonDeliveryCoupon(both, { option: "pickup" }), { coupon: both, ignored: null }, "percent + free delivery keeps its percent");
  const bad = { ok: false, error: "not_found" };
  assert.deepEqual(nonDeliveryCoupon(bad, { option: "pickup", pureFree: false, code: "NOPE99" }), { coupon: bad, ignored: null }, "the caller then answers coupon_not_found");
  const usedPct = { ok: false, error: "already_used" };
  assert.deepEqual(nonDeliveryCoupon(usedPct, { option: "pickup", pureFree: false, code: "SAVE10" }), { coupon: usedPct, ignored: null });
});

test("delivery: the rule does nothing — an invalid FIRST is still refused there, so the customer sees the real total first", () => {
  assert.deepEqual(nonDeliveryCoupon(FIRST_USED, { option: "delivery", pureFree: true, code: "FIRST" }), { coupon: FIRST_USED, ignored: null });
  assert.deepEqual(nonDeliveryCoupon(FIRST_OK, { option: "delivery" }), { coupon: FIRST_OK, ignored: null });
  assert.deepEqual(nonDeliveryCoupon(null, { option: "pickup" }), { coupon: null, ignored: null });
});

test("the checkout route uses the rule and tells the storefront when it ignored a code", () => {
  const i = shop.indexOf("coupon = await checkCoupon(b.coupon, Number.MAX_SAFE_INTEGER, phoneNorm);");
  const j = shop.indexOf('if (coupon && !coupon.ok) return fail("coupon_" + coupon.error, 422, { coupon });', i);
  assert.ok(i > 0 && j > i);
  const seg = shop.slice(i, j);
  assert.ok(seg.includes("nonDeliveryCoupon(coupon, { option, code: b.coupon, table: Boolean(tableSid),"));
  assert.ok(seg.includes("couponIgnored = nd.ignored;") && seg.includes("coupon = nd.coupon;"));
  assert.ok(seg.includes('if (coupon && option !== "delivery")'), "delivery orders skip the rule");
  /* the field must sit in the CHECKOUT route (where the variable lives), not anywhere in the file: on 12/10 this assertion
     accepted the same text in /api/shop/execute, where the variable does not exist, and every payment attempt returned 500.
     The behaviour itself is tested end to end in shop-pay-routes.test.mjs. */
  const co = shop.slice(shop.indexOf('app.post("/api/shop/checkout"'), shop.indexOf('app.post("/api/shop/execute"'));
  const ex = shop.slice(shop.indexOf('app.post("/api/shop/execute"'), shop.indexOf("async function confirmOrder("));
  assert.ok(co.includes("let coupon = null, couponIgnored = null;") && co.includes("...(couponIgnored ? { couponIgnored } : {}),"), "declared and returned in the checkout route");
  assert.ok(!ex.includes("couponIgnored"), "the execute route knows nothing about it");
  // the authoritative re-check against the real total is still there for a coupon that is applied
  assert.ok(shop.includes('if (!recheck.ok) return fail("coupon_" + recheck.error, 422, { coupon: recheck });'));
});
