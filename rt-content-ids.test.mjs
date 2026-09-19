/* معرّفات الكتالوج = معرّفات البيكسل (١٩/٩): الباقة «b:<slug>» ⇒ صف العرض،
   والشراء من السيرفر بيجمع سطور الباقة في صف واحد بسعرها الكامل.
     node --test rt-content-ids.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalContentId, purchaseContentsOf } from "./funnel.js";
import { catalogLink } from "./catalog.js";
import { parseCheckoutConsent, CURRENT_VERSION } from "./consent.js";

const BM = { "national96-grill": "offer-nd96-kilo", "national96-box": "offer-nd96-box" };

test("canonicalContentId: باقة معروفة ⇒ صف العرض، غير كده زي ما هو", () => {
  assert.equal(canonicalContentId("b:national96-grill", BM), "offer-nd96-kilo");
  assert.equal(canonicalContentId("b:unknown", BM), "b:unknown");
  assert.equal(canonicalContentId("41", BM), "41");
  assert.equal(canonicalContentId(41, null), "41");
  assert.equal(canonicalContentId("b:national96-box", null), "b:national96-box");
});

test("purchaseContentsOf: سطور الباقة ⇒ صف عرض واحد × عدد الباقات، بسعر الباقة", async () => {
  // باقتين كيلو (bundle_qty 2): كفتة ٨٣.٤٨ صافي + أرز ٠ ، وصنف عادي
  const items = [
    { product_id: 91, name: "كفتة", bundle: "national96-grill", bundle_line: "L1", bundle_qty: 2, quantity: 2, unit_amount: 83.478, mf: 1 },
    { product_id: 123, name: "أرز", bundle: "national96-grill", bundle_line: "L1", bundle_qty: 2, quantity: 2, unit_amount: 0, mf: 1 },
    { product_id: 41, name: "بيتزا", quantity: 1, unit_amount: 26.96, mf: 1 },
  ];
  const c = await purchaseContentsOf(items, 0, null, BM);
  const off = c.find((x) => x.id === "offer-nd96-kilo");
  assert.ok(off, "صف العرض موجود");
  assert.equal(off.quantity, 2);
  assert.ok(Math.abs(off.itemPrice - 96) < 0.05, `سعر الباقة ≈ ٩٦ (${off.itemPrice})`);
  assert.ok(!c.find((x) => x.id === "123"), "الأرز مابقاش صف لوحده");
  assert.ok(c.find((x) => x.id === "41"));
});

test("purchaseContentsOf: من غير خريطة ⇒ السلوك القديم (أصناف)", async () => {
  const c = await purchaseContentsOf([{ product_id: 91, bundle: "national96-grill", quantity: 1, unit_amount: 10, mf: 1 }]);
  assert.equal(c[0].id, "91");
});

test("catalogLink: العرض بيفتح المنتقي، الصنف بيفتح ورقته", () => {
  assert.match(catalogLink({ id: "offer-nd96-box", offerId: "nd96_box" }), /\/\?offer=nd96_box$/);
  assert.match(catalogLink({ id: "41" }), /\/#item-41$/);
});

test("parseCheckoutConsent: true صريح بس، وإصدار معروف بس", () => {
  assert.deepEqual(parseCheckoutConsent({ ads: true, version: CURRENT_VERSION }), { ads: true, version: CURRENT_VERSION });
  assert.deepEqual(parseCheckoutConsent({ ads: "yes", version: CURRENT_VERSION }), { ads: false, version: CURRENT_VERSION });
  assert.equal(parseCheckoutConsent({ ads: true, version: "v999" }), null);
  assert.equal(parseCheckoutConsent(null), null);
  assert.equal(parseCheckoutConsent("true"), null);
});

import { policyOf, staffFromSettings } from "./uploadgate.js";
test("uploadgate.policyOf: كله مقفول افتراضياً، والموافقة مطلوبة", () => {
  assert.deepEqual(policyOf(null, null, null), { lists: false, offline: false, requireConsent: true });
  assert.deepEqual(policyOf("true", "true", "false"), { lists: true, offline: true, requireConsent: false });
  assert.deepEqual(policyOf("false", "yes", "maybe"), { lists: false, offline: false, requireConsent: true });
});
test("uploadgate.staffFromSettings: أرقام الفريق من كل المصادر", () => {
  const s = staffFromSettings({ delivery: { alertPhones: "0501234567, 966502222222", newOrderPhones: [{ phone: "0503333333" }] },
    cms: { staffPhones: ["0504444444"], campaigns: { excludePhones: ["0505555555"] } } });
  assert.deepEqual([...s].sort(), ["501234567", "502222222", "503333333", "504444444", "505555555"]);
});
