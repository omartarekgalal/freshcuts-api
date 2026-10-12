// A2 (12/10): the box's «قيمة الأصناف منفردة» comes from the server (value_max = the most expensive valid combination by menu
// prices), the storefront shows it as is. Run: node --test a2-bundle-value.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundleValue } from "./bundles.js";
const cms = readFileSync(new URL("./cms.js", import.meta.url), "utf8");

const crepes = [{ product_id: "1", price_incl: 29 }, { product_id: "2", price_incl: 33 }, { product_id: "3", price_incl: 31 }];
const sides = [{ product_id: "10", price_incl: 12 }, { product_id: "11", price_incl: 8 }];

test("most expensive and cheapest combination, quantities included", () => {
  const slots = [
    { key: "a", type: "choice", quantity: 1, choices: crepes }, { key: "b", type: "choice", quantity: 1, choices: crepes },
    { key: "s", type: "choice", quantity: 2, choices: sides }, { key: "d", type: "fixed", quantity: 2, item: { product_id: "20", price_incl: 5 } },
  ];
  assert.deepEqual(bundleValue(slots), { min: 29 + 29 + 8 * 2 + 5 * 2, max: 33 + 33 + 12 * 2 + 5 * 2 });
});

test("a choice's surcharge is not menu value", () => {
  const withSur = [{ key: "a", type: "choice", quantity: 1, choices: [{ product_id: "1", price_incl: 29 }, { product_id: "2", price_incl: 33, surcharge: 4 }] }];
  assert.deepEqual(bundleValue(withSur), { min: 29, max: 33 });
});

test("an unknown or zero price gives no number at all (never a wrong one)", () => {
  assert.equal(bundleValue([{ type: "choice", quantity: 1, choices: [{ price_incl: 29 }, { price_incl: 0 }] }]), null);
  assert.equal(bundleValue([{ type: "choice", quantity: 1, choices: [] }]), null);
  assert.equal(bundleValue([{ type: "fixed", quantity: 1, item: { price_incl: null } }]), null);
  assert.equal(bundleValue([{ type: "fixed", quantity: 1 }]), null);
  assert.equal(bundleValue([]), null);
  assert.equal(bundleValue(null), null);
});

test("rounding to halalas; a missing quantity counts as 1", () => {
  assert.deepEqual(bundleValue([{ type: "fixed", item: { price_incl: 10.005 } }, { type: "fixed", quantity: 3, item: { price_incl: 3.335 } }]), { min: 20.01, max: 20.01 });
});

test("the same rule as the storefront's own fallback (boxSavings: max over choices × quantity + fixed items)", () => {
  // storefront: value = price + boxSavings(b).max = Σ max(price_incl)·q — identical by construction, checked on a real-shaped box
  const box = { price: 65, slots: [{ type: "choice", quantity: 1, choices: crepes }, { type: "choice", quantity: 1, choices: crepes }, { type: "choice", quantity: 1, choices: sides }, { type: "fixed", quantity: 2, item: { price_incl: 5 } }] };
  let hi = 0;
  for (const s of box.slots) { const q = s.quantity || 1; hi += (s.type === "choice" ? Math.max(...s.choices.map((c) => c.price_incl)) : s.item.price_incl) * q; }
  assert.equal(bundleValue(box.slots).max, hi);
});

test("/api/shop/bundles sends value_max / value_min only when the value is known", () => {
  assert.ok(cms.includes("const val = bundlesLib.bundleValue(slots);"));
  assert.ok(cms.includes("...(val ? { value_max: val.max, value_min: val.min } : {}) });"));
});
