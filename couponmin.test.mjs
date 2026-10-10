// الحد الأدنى للكوبون (مراجعة عمر ١٠/١٠): التوصيل المجاني مايفضلش متطبّق تحت الحد، ومكافأة الولاء لها حد أدنى.
// Run: node --test couponmin.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { couponMinState, feeAfterCoupon, loyaltyMinTotal, LOYALTY_MIN_DEFAULT, LOYALTY_MIN_BACKFILL_SQL } from "./couponmin.js";

const src = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("under the minimum the coupon is not ok — and says how much is left", () => {
  assert.deepEqual(couponMinState({ min_total: "60" }, 59.99), { ok: false, minTotal: 60, gap: 0.01 });
  assert.deepEqual(couponMinState({ minTotal: 60 }, 28), { ok: false, minTotal: 60, gap: 32 });
  assert.equal(couponMinState({ minTotal: 60 }, 60).ok, true);
  assert.equal(couponMinState({ minTotal: 60 }, 84).ok, true);
  assert.equal(couponMinState({ minTotal: 0 }, 1).ok, true);
  assert.equal(couponMinState(null, 0).ok, true);
});

test("free-delivery waiver: never under the minimum, whatever the caller checked before", () => {
  const first = { ok: true, freeDelivery: true, minTotal: 60 };
  // Omar's repro: basket went 84 → 28 with FIRST still attached
  assert.deepEqual(feeAfterCoupon({ fee: 20, coupon: first, foodTotal: 28 }), { fee: 20, waived: false });
  assert.deepEqual(feeAfterCoupon({ fee: 15, coupon: first, foodTotal: 59.5 }), { fee: 15, waived: false });
  assert.deepEqual(feeAfterCoupon({ fee: 10, coupon: first, foodTotal: 84 }), { fee: 0, waived: true });
  assert.deepEqual(feeAfterCoupon({ fee: 15, coupon: first, foodTotal: 60 }), { fee: 0, waived: true });
  // far-zone / district part is never waived
  assert.deepEqual(feeAfterCoupon({ fee: 16, keep: 6, coupon: first, foodTotal: 90 }), { fee: 6, waived: true });
  assert.deepEqual(feeAfterCoupon({ fee: 6, keep: 6, coupon: first, foodTotal: 90 }), { fee: 6, waived: false });
  // a percent-only coupon or a failed one never touches the fee
  assert.deepEqual(feeAfterCoupon({ fee: 20, coupon: { ok: true, freeDelivery: false, minTotal: 0 }, foodTotal: 200 }), { fee: 20, waived: false });
  assert.deepEqual(feeAfterCoupon({ fee: 20, coupon: { ok: false, freeDelivery: true }, foodTotal: 200 }), { fee: 20, waived: false });
  assert.deepEqual(feeAfterCoupon({ fee: 20, coupon: null, foodTotal: 200 }), { fee: 20, waived: false });
  // a loyalty reward with the new minimum behaves the same
  assert.equal(feeAfterCoupon({ fee: 20, coupon: { ok: true, freeDelivery: true, minTotal: 60 }, foodTotal: 29 }).waived, false);
});

test("loyalty minimum: default 60, editable, clamped", () => {
  assert.equal(LOYALTY_MIN_DEFAULT, 60);
  assert.equal(loyaltyMinTotal({}), 60);
  assert.equal(loyaltyMinTotal(null), 60);
  assert.equal(loyaltyMinTotal({ minTotal: "" }), 60);
  assert.equal(loyaltyMinTotal({ minTotal: 0 }), 0);          // the owner may switch it off explicitly
  assert.equal(loyaltyMinTotal({ minTotal: "80" }), 80);
  assert.equal(loyaltyMinTotal({ minTotal: -5 }), 0);
  assert.equal(loyaltyMinTotal({ minTotal: 99999 }), 1000);
  assert.equal(loyaltyMinTotal({ minTotal: "abc" }), 60);
});

test("wiring: checkout waives through feeAfterCoupon, re-checks the real total, and tells the storefront the minimum", () => {
  const shop = src("shop.js");
  assert.ok(shop.includes('import { feeAfterCoupon } from "./couponmin.js";'));
  assert.ok(shop.includes("const w = feeAfterCoupon({ fee: deliveryFee, keep, coupon, foodTotal });"));
  assert.ok(shop.includes("const recheck = await checkCoupon(b.coupon, foodTotal, phoneNorm);"), "authoritative re-check against the real food total");
  assert.ok(shop.includes('if (!recheck.ok) return fail("coupon_" + recheck.error, 422, { coupon: recheck });'));
  const rules = src("couponrules.js");   // since the 5/10 coupon rules moved in, the row → verdict logic lives there
  assert.ok(shop.includes("if (cp) return evaluateCoupon(cp, { subtotal, phoneNorm }, couponQ);"));
  assert.ok(rules.includes("minTotal: Number(cp.min_total) || 0 };"), "validate-coupon returns minTotal so the cart can re-evaluate on every change");
  assert.ok(rules.includes('if (Number(subtotal) < Number(cp.min_total)) return { ok: false, error: "min_total", minTotal: Number(cp.min_total) };'));
});

test("wiring: loyalty rewards are issued with the minimum and unused ones follow the setting", () => {
  const cms = src("cms.js");
  assert.ok(cms.includes("VALUES ($1,$2,true,$7,1,$3,$4,true,$5,$6)"), "min_total comes from the setting, not a literal 0 — and the reward is bound to the phone");
  assert.ok(!cms.includes("VALUES ($1,$2,true,0,1,$3,$4,true,$5"));
  assert.ok(src("loyalty.js").includes("minTotal: loyaltyMinTotal(b.minTotal === undefined ? prev : b),"));
  assert.ok(cms.includes("await loyaltyMinSync(cfg)"));
  assert.ok(cms.includes("const synced = await loyaltyMinSync(val)"));
  assert.match(LOYALTY_MIN_BACKFILL_SQL, /COALESCE\(s\.used_count,0\) = 0/);
  assert.match(LOYALTY_MIN_BACKFILL_SQL, /FROM cms_loyalty l/);
});
