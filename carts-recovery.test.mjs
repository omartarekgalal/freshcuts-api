import { test } from "node:test";
import assert from "node:assert/strict";
import { cartCfg, CART_DEFAULTS, cartSmsBody, cartMessages, rawCart } from "./carts.js";
import { smsParts } from "./smsrules.js";

test("defaults: 35 min, next day 17:00, ≥60 SAR, 7-day cooldown, SMS off until the owner enables", () => {
  const c = cartCfg({});
  assert.equal(c.sms1AfterMinutes, 35);
  assert.equal(c.sms2Hour, 17);
  assert.equal(c.sms2MinSubtotal, 60);
  assert.equal(c.cooldownDays, 7);
  assert.equal(c.smsEnabled, false);
  assert.equal(c.requireVerifiedPhone, true);
  assert.deepEqual(Object.keys(c).sort(), Object.keys(CART_DEFAULTS).sort());
});

test("settings are clamped (never under 30 min, SMS2 never inside quiet hours)", () => {
  const c = cartCfg({ abandonedCarts: { sms1AfterMinutes: 5, sms2Hour: 23, cooldownDays: 0, smsEnabled: "yes", enabled: "no" } });
  assert.equal(c.sms1AfterMinutes, 30);
  assert.equal(c.sms2Hour, 21);
  assert.equal(c.cooldownDays, 1);
  assert.equal(c.smsEnabled, false, "only a real true enables SMS");
  assert.equal(c.enabled, true, "non-boolean falls back to default");
});

test("every recovery SMS fits 2 UCS-2 parts with link + opt-out, no Egyptian wording, no discount claims", () => {
  for (const step of [1, 2]) for (const first of [true, false]) {
    const b = cartSmsBody(step, first, "freshcuts.sa/c/abcdefgh", "freshcuts.sa/u/0123456789");
    assert.ok(smsParts(b) <= 2, `${step}/${first}: ${b.length}`);
    assert.match(b, /\/c\/abcdefgh/);
    assert.match(b, /إيقاف: freshcuts\.sa\/u\//);
    assert.doesNotMatch(b, /دلوقتي|عشان|وفّر|وفر|%|٪/);
  }
  const p = cartMessages.push1(3, true);
  assert.ok(p.title.length <= 30 && p.body.length <= 90);
});

test("raw cart is kept as-is but capped", () => {
  assert.equal(rawCart(null), null);
  assert.equal(rawCart([1, 2]), null);
  const r = JSON.parse(rawCart({ "12": { qty: 2, note: "بدون بصل" }, "b:nd96-box:x": { qty: 1, bundle: { slug: "nd96-box" } } }));
  assert.equal(r["12"].note, "بدون بصل");
  const big = {}; for (let i = 0; i < 60; i++) big["k" + i] = { pad: "x".repeat(1000) };
  assert.equal(rawCart(big), null);
});
