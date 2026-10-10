/* البوكسات (١٠/١٠): حشو الأطراف + ملاحظة لكل صنف جوّه الباقة.
   شغّل: node --test boxes.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandBundle, normalizeSlots, cleanSlotMods, cleanSlotNote, MULTIPLY } from "./bundles.js";
import { partnerItemsOf } from "./shop.js";
import { itemsOf, lineMods } from "./portal-core.js";
import { itemsFromShop } from "./kitchen-core.js";
import { linesFor } from "./modifiers.js";

const EX = (incl) => incl / 1.15;
const MENU = {
  "43:36": { name: "بيتزا تشيكن رانش", variantName: "وسط", priceEx: EX(28), taxId: 1 },
  "41:34": { name: "بيتزا سوبر سوبريم", variantName: "وسط", priceEx: EX(31), taxId: 1 },
  "59:": { name: "بنا تشيكن كازرول", priceEx: EX(28), taxId: 1 },
  "79:": { name: "بطاطس محمرة", priceEx: EX(6), taxId: 1 },
  "82:42": { name: "مشروبات غازية", variantName: "كان", priceEx: EX(3), taxId: 1 },
};
const resolve = (p, v) => MENU[`${p}:${v || ""}`] || null;
const BOX = {
  slug: "box-pizza-night", name: "بوكس سهرة البيتزا", price: 85,
  slots: normalizeSlots([
    { key: "pizza1", type: "choice", label: "البيتزا الأولى (وسط)", label_en: "First pizza (medium)",
      choices: [{ product_id: "43", variant_option_id: 36 }, { product_id: "41", variant_option_id: 34 }] },
    { key: "pizza2", type: "choice", label: "البيتزا التانية (وسط)", label_en: "Second pizza (medium)",
      choices: [{ product_id: "43", variant_option_id: 36 }, { product_id: "41", variant_option_id: 34 }] },
    { key: "pasta", type: "fixed", label: "باستا", product_id: "59" },
    { key: "fries", type: "fixed", label: "بطاطس محمرة", label_en: "French fries", product_id: "79" },
    { key: "drinks", type: "fixed", label: "مشروبات غازية", label_en: "Soft drinks", product_id: "82", variant_option_id: 42, quantity: 2 },
  ]),
};
const CH = { pizza1: { product_id: "43", variant_option_id: 36 }, pizza2: { product_id: "41", variant_option_id: 34 } };

test("normalizeSlots: label_en بيتحفظ، ومن غيره الخانة زي ما هي", () => {
  assert.equal(BOX.slots[0].label_en, "First pizza (medium)");
  assert.ok(!("label_en" in BOX.slots[2]), "خانة من غير اسم إنجليزي مايتضافلهاش مفتاح فاضي");
  assert.equal(normalizeSlots([{ key: "a", type: "fixed", product_id: "1", label_en: "x".repeat(200) }])[0].label_en.length, 80);
});

test("cleanSlotMods / cleanSlotNote: أرقام صحيحة موجبة بس، ونص نضيف بحد أقصى", () => {
  assert.deepEqual(cleanSlotMods([16, "17", 16, 0, -1, "x", 1.5, null]), [16, 17]);
  assert.deepEqual(cleanSlotMods("16"), []);
  assert.equal(cleanSlotNote("  بدون\n بصل \t "), "بدون بصل");
  assert.equal(cleanSlotNote("ن".repeat(300)).length, 100);
  assert.equal(cleanSlotNote(null), "");
});

test("expandBundle: من غير mods/notes النتيجة هي هي (مفيش مفاتيح زيادة)", () => {
  const r = expandBundle(BOX, CH, 1, resolve, { lineUid: "u" });
  assert.ok(r.ok);
  for (const l of r.lines) { assert.ok(!("modifiers" in l)); assert.ok(!("note" in l)); }
  assert.equal(r.lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0), r.totalEx);
  assert.equal(r.totalEx, Math.round(85 * MULTIPLY / 1.15));
});

test("expandBundle: الإضافات والملاحظة بيتحطّوا على سطر خانتهم بس — وسعر الباقة مابيتغيّرش", () => {
  const base = expandBundle(BOX, CH, 1, resolve, { lineUid: "u" });
  const r = expandBundle(BOX, CH, 1, resolve, { lineUid: "u",
    mods: { pizza1: [16], pizza2: [17, 17], fries: [], nope: [99] },
    notes: { pizza1: "بدون زيتون", drinks: "سفن أب", pasta: "   " } });
  assert.ok(r.ok);
  const by = (k) => r.lines.filter((l) => l.bundle_slot === k);
  assert.deepEqual(by("pizza1")[0].modifiers, [16]);
  assert.equal(by("pizza1")[0].note, "بدون زيتون");
  assert.deepEqual(by("pizza2")[0].modifiers, [17]);
  assert.ok(!("note" in by("pizza2")[0]));
  assert.ok(!("modifiers" in by("fries")[0]));
  assert.ok(!("note" in by("pasta")[0]), "ملاحظة فاضية مابتتخزنش");
  for (const l of by("drinks")) assert.equal(l.note, "سفن أب");
  assert.equal(r.totalEx, base.totalEx, "الإضافة فلوس فوق سعر الباقة — مش من جوّاه");
  assert.deepEqual(r.lines.map((l) => l.unit_amount), base.lines.map((l) => l.unit_amount));
  assert.deepEqual(r.picks.find((p) => p.slot === "pizza1").modifiers, [16]);
  assert.equal(r.picks.find((p) => p.slot === "pizza1").note, "بدون زيتون");
});

test("expandBundle: lineUid اللي جاي من الشيك أوت بيتستخدم (بوكسين من نفس النوع مايتلخبطوش)", () => {
  const a = expandBundle(BOX, CH, 1, resolve, { lineUid: "box-pizza-night-x-0" });
  const b = expandBundle(BOX, CH, 1, resolve, { lineUid: "box-pizza-night-x-1" });
  assert.notEqual(a.lines[0].bundle_line, b.lines[0].bundle_line);
});

test("partnerItemsOf: سطر البيتزا جوّه البوكس بينزل نقطة البيع بالحشو والملاحظة", () => {
  const r = expandBundle(BOX, CH, 2, resolve, { lineUid: "u", mods: { pizza1: [16] }, notes: { pizza1: "مقطّعة ٨" } });
  // الشيك أوت بيسعّر الإضافة من كتالوج الشريك وبيخزّنها بوحدة السطر
  const priced = r.lines.map((l) => ({ ...l, mf: MULTIPLY,
    ...(l.modifiers ? { modifiers: linesFor([{ id: 16, quantity: 1, sar: 2.608695652173913 }], MULTIPLY), modifier_labels: ["حشو اطراف كيري"] } : {}) }));
  const out = partnerItemsOf({ items: priced, discount_percent: 10 });
  const pz = out.find((x) => x.productId === 43);
  assert.deepEqual(pz.modifiers, [{ id: 16, quantity: 1, unit_amount: 261 }]);
  assert.equal(pz.lineNote, "مقطّعة ٨");
  assert.equal(pz.quantity, 2);
  assert.equal(pz.variantOptionId, 36);
  // خصم النسبة مابيتطبّقش على سطور الباقة
  assert.ok(Math.abs(pz.unitPrice - priced.find((l) => l.product_id === 43).unit_amount / MULTIPLY) < 1e-9);
  assert.equal(out.find((x) => x.productId === 41).lineNote, undefined);
});

test("البوابة والمطبخ: مكوّن البوكس بيعرض الحشو + ملاحظة العميل، و«بدون حشو» مابتتكتبش", () => {
  const r = expandBundle(BOX, CH, 1, resolve, { lineUid: "u", mods: { pizza1: [16], pizza2: [15] }, notes: { pizza1: "بدون زيتون", drinks: "سفن أب" } });
  const stored = r.lines.map((l) => ({ ...l,
    ...(l.bundle_slot === "pizza1" ? { modifier_labels: ["حشو اطراف كيري"] } : {}),
    ...(l.bundle_slot === "pizza2" ? { modifier_labels: ["بدون حشو اطراف"] } : {}) }));
  assert.deepEqual(lineMods(stored[0]), ["حشو اطراف كيري"]);
  const rows = itemsOf(stored);
  assert.equal(rows[0].kind, "bundle");
  assert.equal(rows[0].name, "بوكس سهرة البيتزا");
  const p1 = rows.find((x) => x.name.startsWith("بيتزا تشيكن رانش"));
  assert.equal(p1.note, "حشو اطراف كيري · بدون زيتون");
  assert.equal(rows.find((x) => x.name.startsWith("بيتزا سوبر سوبريم")).note, null);
  assert.equal(rows.find((x) => x.name.startsWith("مشروبات غازية")).note, "سفن أب");
  const kds = itemsFromShop(stored);
  assert.equal(kds.length, 1);
  assert.ok(kds[0].bundle);
  assert.ok(kds[0].mods.some((m) => /رانش/.test(m.name) && /كيري/.test(m.note || "") && /زيتون/.test(m.note || "")));
});

test("صنف عادي (مش باقة): الحشو بيبان في ملاحظة السطر على البوابة", () => {
  const rows = itemsOf([{ product_id: 40, name: "بيتزا بيبروني", variant_name: "وسط", quantity: 1, modifier_labels: ["حشو اطراف موزاريلا"] }]);
  assert.equal(rows[0].note, "حشو اطراف موزاريلا");
});
