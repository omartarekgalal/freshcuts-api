// فرق سعر الاختيار داخل البوكس («+4 ر.س») — قرار عمر ١٠/١٠ «درجتين ٢٩ و٣٣».
// القاعدتان: (١) ما يدفعه العميل = سعر البوكس + الفرق بالضبط، (٢) ما ينزل نقطة البيع = ما دُفع.
// أوفلاين تماماً: نفس الدوال التي يستخدمها الشيك أوت والتحويل لطلب الشريك.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expandBundle, normalizeSlots, exVatUnits, cleanSurcharge, MULTIPLY, VAT_RATE, SURCHARGE_MAX } from "./bundles.js";
import { partnerPurchase } from "./tspartner.js";
import { partnerItemsOf } from "./shop.js";
import { stampMf, scaleOf } from "./money.js";

// أسعار المنيو قبل الضريبة (شامل ÷ 1.15): كريب 24–30، بطاطس 6، كولسلو 6، دوريتوس 5، كان 3
const ex = (incl) => Math.round(incl / 1.15 * 1e8) / 1e8;
const MENU = {
  "7": { name: "كريب فاهيتا دجاج", priceEx: ex(24), taxId: 1 }, "8": { name: "كريب زنجر سوبريم", priceEx: ex(25), taxId: 1 },
  "9": { name: "كريب سوبر كرانشي", priceEx: ex(28), taxId: 1 }, "3": { name: "كريب ميكس دجاج", priceEx: ex(29), taxId: 1 },
  "1": { name: "كريب ميكس لحوم", priceEx: ex(30), taxId: 1 },
  "79": { name: "بطاطس محمرة", priceEx: ex(6), taxId: 1 }, "72": { name: "كولسلو", priceEx: ex(6), taxId: 1 }, "119": { name: "دوريتوس", priceEx: ex(5), taxId: 1 },
  "82:42": { name: "مشروبات غازية", variantName: "كان", priceEx: ex(3), taxId: 1 },
};
const resolve = (p, v) => MENU[v ? `${p}:${v}` : String(p)] || null;
const SOLO = {
  slug: "box-solo-crepe", name: "بوكس الكريب الفردي", price: 29,
  slots: normalizeSlots([
    { key: "crepe", type: "choice", quantity: 1, label: "اختر الكريب", choices: [
      { product_id: "7" }, { product_id: "8" }, { product_id: "9", surcharge: 4 }, { product_id: "3", surcharge: 4 }, { product_id: "1", surcharge: 4 }] },
    { key: "side", type: "choice", quantity: 1, label: "اختر الصنف الجانبي", choices: [{ product_id: "79" }, { product_id: "72" }, { product_id: "119" }] },
    { key: "drink", type: "fixed", quantity: 1, label: "مشروب غازي", product_id: "82", variant_option_id: 42 },
  ]),
};
const pick = (crepe, side = "79") => ({ crepe: { product_id: crepe }, side: { product_id: side } });
const r2 = (n) => Math.round(n * 100) / 100;
// نفس حساب shop.js للباقات: مجموع السطور قبل الضريبة × 1.15، لأقرب هللة
const paidIncl = (lines) => r2(stampMf(lines, MULTIPLY).reduce((a, x) => a + (Number(x.unit_amount) / scaleOf(x)) * Number(x.quantity), 0) * (1 + VAT_RATE));
// ما يستقبله تاب سينس: partnerItemsOf → partnerPurchase (هللات قبل الضريبة)، وتاب سينس يضيف الضريبة بنفسه
const posIncl = (lines) => {
  const purchases = partnerItemsOf({ items: stampMf(lines, MULTIPLY), discount_percent: 0 })
    .map((it) => partnerPurchase({ ...it, partnerProductId: "p" + it.productId, taxId: "t" }, { id: "t" }));
  return { purchases, total: purchases.reduce((a, p) => a + p.unit_amount * p.quantity, 0) * (1 + VAT_RATE) / 100 };
};

test("the slot shape keeps a clean surcharge and nothing else", () => {
  assert.deepEqual(SOLO.slots[0].choices.map((c) => c.surcharge || 0), [0, 0, 4, 4, 4]);
  assert.equal(cleanSurcharge("4"), 4);
  assert.equal(cleanSurcharge(3.999), 4, "rounded to the halala");
  for (const bad of [0, -4, "x", null, undefined, NaN, Infinity, SURCHARGE_MAX + 1]) assert.equal(cleanSurcharge(bad), 0, String(bad));
  const s = normalizeSlots([{ key: "a", type: "choice", choices: [{ product_id: "7", surcharge: -2 }, { product_id: "8", surcharge: 0 }] }]);
  assert.ok(s[0].choices.every((c) => !("surcharge" in c)), "no surcharge key unless it is a real positive amount");
  assert.ok(!("surcharge" in SOLO.slots[2]), "a fixed slot never has one");
});

test("a standard choice is 29, a premium choice is 33 — and the lines add up to exactly that", () => {
  const base = expandBundle(SOLO, pick("7"), 1, resolve);
  assert.ok(base.ok);
  assert.equal(base.priceIncl, 29);
  assert.equal(base.surchargeIncl, 0);
  assert.equal(base.totalEx, exVatUnits(29));
  assert.equal(base.lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0), exVatUnits(29));
  assert.ok(base.picks.every((p) => !("surcharge" in p)));

  for (const premium of ["9", "3", "1"]) {
    const r = expandBundle(SOLO, pick(premium), 1, resolve);
    assert.ok(r.ok, premium);
    assert.equal(r.priceIncl, 33);
    assert.equal(r.basePriceIncl, 29);
    assert.equal(r.surchargeIncl, 4);
    assert.equal(r.totalEx, exVatUnits(33), "the surcharge is inside the distributed total, not beside it");
    assert.equal(r.lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0), exVatUnits(33));
    assert.equal(r.picks.find((p) => p.slot === "crepe").surcharge, 4);
    assert.equal(r.lines.length, 3, "same three POS lines: crepe, side, can — no extra «surcharge» product");
  }
});

/* تاب سينس يستقبل سعر الوحدة **هللات صحيحة قبل الضريبة** ثم يحسب الضريبة بنفسه. فإجمالي نقطة البيع قد يختلف عن المدفوع
   بكسر هللة لكل وحدة (29 ⇒ 28.99 في نقطة البيع) — هذا قائم اليوم لكل البوكسات وليس من الفرق. المطلوب هنا:
   المدفوع = سعر البوكس + الفرق بالضبط، وإجمالي نقطة البيع ضمن نفس حدّ التقريب، والفرق نفسه لا يضيف أي انحراف. */
test("what the customer pays is what TabSense receives (29 and 33, one box and three)", () => {
  for (const [crepe, qty, want] of [["7", 1, 29], ["1", 1, 33], ["9", 3, 99], ["8", 2, 58]]) {
    const r = expandBundle(SOLO, pick(crepe, "119"), qty, resolve);
    assert.equal(paidIncl(r.lines), want, `paid for ${crepe} ×${qty}`);
    const pos = posIncl(r.lines);
    // تاب سينس يستقبل هللات صحيحة قبل الضريبة لكل سطر: الفرق الأقصى نصف هللة للسطر قبل الضريبة
    assert.ok(Math.abs(pos.total - want) <= 0.005 * 1.15 * r.lines.length * qty + 1e-9, `POS total ${pos.total} vs paid ${want}`);
    if (qty === 1) assert.ok(Math.abs(pos.total - want) <= 0.02, `one box: POS ${pos.total.toFixed(4)} is within 2 halalas of ${want}`);
    assert.equal(pos.purchases.reduce((a, p) => a + p.quantity, 0), 3 * qty);
  }
});

test("the surcharge itself arrives whole: POS(premium) − POS(standard) = 4 SAR within one halala", () => {
  const a = posIncl(expandBundle(SOLO, pick("7"), 1, resolve).lines).total;
  const b = posIncl(expandBundle(SOLO, pick("1"), 1, resolve).lines).total;
  assert.ok(Math.abs((b - a) - 4) <= 0.02, `POS difference ${(b - a).toFixed(4)}`);
  assert.equal(paidIncl(expandBundle(SOLO, pick("1"), 1, resolve).lines) - paidIncl(expandBundle(SOLO, pick("7"), 1, resolve).lines), 4);
});

test("the premium line carries the bigger share; the surcharge of a ×2 slot counts twice", () => {
  const r = expandBundle(SOLO, pick("1"), 1, resolve);
  const crepe = r.lines.find((l) => l.bundle_slot === "crepe"), side = r.lines.find((l) => l.bundle_slot === "side");
  assert.ok(crepe.unit_amount > side.unit_amount * 3);
  const duo = { slug: "x", name: "x", price: 65, slots: normalizeSlots([
    { key: "c", type: "choice", quantity: 2, choices: [{ product_id: "7" }, { product_id: "1", surcharge: 4 }] },
    { key: "d", type: "fixed", quantity: 2, product_id: "82", variant_option_id: 42 }]) };
  const d = expandBundle(duo, { c: { product_id: "1" } }, 1, resolve);
  assert.equal(d.priceIncl, 73);
  assert.equal(d.surchargeIncl, 8);
  assert.equal(paidIncl(d.lines), 73);
});

test("a browser cannot move the price: an unknown choice is refused and a choice sent with its own «surcharge» is ignored", () => {
  assert.equal(expandBundle(SOLO, pick("41"), 1, resolve).error, "choice_not_allowed");
  const r = expandBundle(SOLO, { crepe: { product_id: "1", surcharge: 0 }, side: { product_id: "79" } }, 1, resolve);
  assert.equal(r.priceIncl, 33, "the surcharge comes from the stored box, never from the request");
});

test("wiring: the public box list, the expand answer, the dashboard save and the report know the surcharge", () => {
  const cms = readFileSync(new URL("./cms.js", import.meta.url), "utf8");
  assert.ok(cms.includes("{ ...d, surcharge: bundlesLib.cleanSurcharge(ch.surcharge) }"), "the storefront receives it to show «+4 ر.س»");
  assert.ok(cms.includes("surcharge_incl: Number(r.surchargeIncl) || 0 });"));
  assert.ok(cms.includes('if (!ch.surcharge && old && old.surcharge && !has(rawCh.get(k), "surcharge")) ch.surcharge = old.surcharge;'), "an editor that does not send the field cannot wipe it");
  assert.ok(cms.includes("sum((it->>'unit_amount')::numeric * (it->>'quantity')::numeric / NULLIF((it->>'mf')::numeric, 0)) AS rev_ex"), "box revenue is read from the order lines, so the 33s count as 33");
  const shop = readFileSync(new URL("./shop.js", import.meta.url), "utf8");
  assert.ok(shop.includes("r = await cms.expandBundle(String(it.bundle), it.choices || {}, it.quantity || 1, option,"), "checkout prices the box with the same function");
});
