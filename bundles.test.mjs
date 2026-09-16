/* اختبارات الباقات + انتقال الوزن — أوفلاين تماماً (مفيش شبكة ولا داتابيز).

   الفلوس هنا فلوس عملاء حقيقيين، فالقاعدتين اللي لازم يتأكدوا:
     ١. توزيع سعر الباقة بيجمع على سعر الباقة **بالظبط**، مهما كانت
        المكوّنات والكميات — مفيش هللة تضيع ولا تزيد.
     ٢. اختيار الوزن (كيلو/نصف/ثلث) بيوصل من السلة لسطر نقطة البيع.
*/
import assert from "node:assert";
import {
  distribute, exVatUnits, expandBundle, normalizeSlots, normalizeKinds, MULTIPLY, VAT_RATE,
} from "./bundles.js";
import { partnerPurchase } from "./tspartner.js";
import { partnerItemsOf } from "./shop.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message); }
};

/* أسعار حقيقية من قايمة تاب سينس (قبل الضريبة) — اتجابت بالمجسّ 2026-09-12 */
const MENU = {
  "91:46":  { name: "كفتة مشوية بالوزن",     variantName: "كيلو", priceEx: 104.34782609, taxId: 1 },
  "94:49":  { name: "طرب مشوي بالوزن",        variantName: "كيلو", priceEx: 121.73913043, taxId: 1 },
  "111:67": { name: "صدور مشوية بالوزن",      variantName: "كيلو", priceEx: 78.26086957,  taxId: 1 },
  "114:70": { name: "شيش طاووق مشوي بالوزن",  variantName: "كيلو", priceEx: 95.65217391,  taxId: 1 },
  "123":    { name: "طبق أرز بسمتي",          priceEx: 5.2173913,   taxId: 1 },  // برّه المنيو
  "21":     { name: "حواوشي سادة",            priceEx: 17.39130435, taxId: 1 },
  "79":     { name: "بطاطس محمرة",            priceEx: 5.2173913,   taxId: 1 },
  "72":     { name: "كلوسلو",                 priceEx: 5.2173913,   taxId: 1 },
  "132":    { name: "بيبسي لتر",              priceEx: 6.08695652,  taxId: 1 },  // برّه المنيو
  "39":     { name: "بيتزا مارجريتا",         priceEx: 30.43478261, taxId: 1 },
  "57":     { name: "باستا الفريدو",          priceEx: 34.7826087,  taxId: 1 },
  "63":     { name: "كريب نوتيلا",            priceEx: 26.08695652, taxId: 1 },
};
const resolve = (p, v) => MENU[v ? `${p}:${v}` : String(p)] || null;

console.log("\n— التوزيع بيجمع بالظبط —");

t("باقة ٩٦: كيلو طرب + أرز → المجموع = إجمالي الباقة قبل الضريبة", () => {
  const T = exVatUnits(96);
  const out = distribute(T, [
    { key: "grill", menuPriceEx: 121.73913043, quantity: 1 },
    { key: "rice",  menuPriceEx: 5.2173913,   quantity: 1 },
  ]);
  const sum = out.reduce((a, l) => a + l.unitAmount * l.quantity, 0);
  assert.strictEqual(sum, T, `المجموع ${sum} ≠ ${T}`);
  // المشوي أغلى ⇒ نصيبه أكبر
  assert.ok(out[0].unitAmount > out[1].unitAmount, "المشوي المفروض ياخد نصيب أكبر");
});

t("الإجمالي شامل الضريبة بيرجع ٩٦٫٠٠ بعد التقريب", () => {
  const T = exVatUnits(96);
  const incl = T * (1 + VAT_RATE) / MULTIPLY;
  assert.strictEqual(Math.round(incl * 100) / 100, 96.00, `طلع ${incl}`);
});

t("كل تركيبات باقة المشاوي الأربعة بتجمع بالظبط", () => {
  for (const g of ["91:46", "94:49", "111:67", "114:70"]) {
    const T = exVatUnits(96);
    const out = distribute(T, [
      { key: "grill", menuPriceEx: MENU[g].priceEx, quantity: 1 },
      { key: "rice",  menuPriceEx: MENU["123"].priceEx, quantity: 1 },
    ]);
    const sum = out.reduce((a, l) => a + l.unitAmount * l.quantity, 0);
    assert.strictEqual(sum, T, `${g}: ${sum} ≠ ${T}`);
  }
});

t("بوكس ٩٦ (٧ مكوّنات) بيجمع بالظبط", () => {
  const T = exVatUnits(96);
  const out = distribute(T, [
    { key: "pizza", menuPriceEx: 30.43478261, quantity: 1 },
    { key: "pasta", menuPriceEx: 34.7826087,  quantity: 1 },
    { key: "crepe", menuPriceEx: 26.08695652, quantity: 1 },
    { key: "hawa",  menuPriceEx: 17.39130435, quantity: 1 },
    { key: "fries", menuPriceEx: 5.2173913,   quantity: 1 },
    { key: "slaw",  menuPriceEx: 5.2173913,   quantity: 1 },
    { key: "pepsi", menuPriceEx: 6.08695652,  quantity: 1 },
  ]);
  const sum = out.reduce((a, l) => a + l.unitAmount * l.quantity, 0);
  assert.strictEqual(sum, T);
});

t("كميات أكبر من واحد: المجموع يفضل مضبوط", () => {
  for (const q of [2, 3, 5, 7, 11]) {
    const T = exVatUnits(96);
    const out = distribute(T, [
      { key: "a", menuPriceEx: 30.43478261, quantity: q },
      { key: "b", menuPriceEx: 5.2173913,   quantity: 3 },
      { key: "c", menuPriceEx: 6.08695652,  quantity: 1 },
    ]);
    const sum = out.reduce((a, l) => a + l.unitAmount * l.quantity, 0);
    assert.strictEqual(sum, T, `qty=${q}: ${sum} ≠ ${T}`);
  }
});

t("عشوائي ٢٠٠٠ باقة: المجموع دايماً مضبوط (خاصية، مش مثال)", () => {
  let seed = 20260912;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 2000; n++) {
    const price = Math.round(rnd() * 50000) / 100 + 1; // ١ → ٥٠١ ريال
    const count = 1 + Math.floor(rnd() * 8);
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push({ key: i, menuPriceEx: Math.round(rnd() * 20000) / 100, quantity: 1 + Math.floor(rnd() * 6) });
    }
    const T = exVatUnits(price);
    const out = distribute(T, lines);
    const sum = out.reduce((a, l) => a + l.unitAmount * l.quantity, 0);
    assert.strictEqual(sum, T, `price=${price} lines=${JSON.stringify(lines)} → ${sum} ≠ ${T}`);
    assert.ok(out.every((l) => Number.isInteger(l.unitAmount) && l.unitAmount >= 0), "سعر وحدة سالب أو كسري");
  }
});

t("كل الأسعار أصفار ⇒ توزيع بالتساوي، والمجموع مضبوط", () => {
  const T = exVatUnits(50);
  const out = distribute(T, [
    { key: "a", menuPriceEx: 0, quantity: 1 },
    { key: "b", menuPriceEx: 0, quantity: 2 },
  ]);
  assert.strictEqual(out.reduce((a, l) => a + l.unitAmount * l.quantity, 0), T);
});

t("مكوّن واحد بس: بياخد الإجمالي كله", () => {
  const T = exVatUnits(96);
  const out = distribute(T, [{ key: "a", menuPriceEx: 100, quantity: 1 }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].unitAmount, T);
});

t("نفس المدخلات ⇒ نفس المخرجات (التوزيع محدَّد مش عشوائي)", () => {
  const T = exVatUnits(96);
  const args = [
    { key: "a", menuPriceEx: 10, quantity: 1 },
    { key: "b", menuPriceEx: 10, quantity: 1 },
    { key: "c", menuPriceEx: 10, quantity: 1 },
  ];
  assert.deepStrictEqual(distribute(T, args), distribute(T, args));
});

console.log("\n— توسيع الباقة —");

const GRILL_BUNDLE = {
  slug: "national96-grill", name: "كيلو مشاوي — اليوم الوطني ٩٦", price: 96,
  slots: normalizeSlots([
    { key: "grill", label: "اختر المشوي (كيلو)", type: "choice", quantity: 1, choices: [
      { product_id: "91", variant_option_id: 46 }, { product_id: "94", variant_option_id: 49 },
      { product_id: "114", variant_option_id: 70 }, { product_id: "111", variant_option_id: 67 }] },
    { key: "rice", label: "طبق أرز بسمتي", type: "fixed", quantity: 1, product_id: "123" },
  ]),
};

t("الاختيار بيوصل لسطر فيه variant_option_id الصح", () => {
  const r = expandBundle(GRILL_BUNDLE, { grill: "94" }, 1, resolve);
  assert.ok(r.ok, r.error);
  const grill = r.lines.find((l) => l.bundle_slot === "grill");
  assert.strictEqual(grill.product_id, 94);
  assert.strictEqual(grill.variant_option_id, 49, "الوزن المفروض كيلو (٤٩)");
  assert.strictEqual(grill.variant_name, "كيلو");
  const rice = r.lines.find((l) => l.bundle_slot === "rice");
  assert.strictEqual(rice.product_id, 123);
  assert.ok(!("variant_option_id" in rice), "الأرز مالوش وزن");
});

t("مجموع سطور الباقة = سعر الباقة بالظبط", () => {
  for (const g of ["91", "94", "111", "114"]) {
    const r = expandBundle(GRILL_BUNDLE, { grill: g }, 1, resolve);
    assert.ok(r.ok, r.error);
    const sum = r.lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0);
    assert.strictEqual(sum, exVatUnits(96), `${g}`);
    assert.strictEqual(Math.round(sum * 1.15 / MULTIPLY * 100) / 100, 96.00);
  }
});

t("٣ باقات = ٣ × السعر بالظبط (مفيش تقريب جديد)", () => {
  const r = expandBundle(GRILL_BUNDLE, { grill: "114" }, 3, resolve);
  assert.ok(r.ok, r.error);
  const sum = r.lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0);
  assert.strictEqual(sum, exVatUnits(96) * 3);
  assert.strictEqual(Math.round(sum * 1.15 / MULTIPLY * 100) / 100, 288.00);
});

t("كل السطور موسومة بالباقة والخانة (عشان التقارير)", () => {
  const r = expandBundle(GRILL_BUNDLE, { grill: "94" }, 1, resolve);
  assert.ok(r.lines.every((l) => l.bundle === "national96-grill"), "وسم الباقة ناقص");
  assert.ok(r.lines.every((l) => l.bundle_slot && l.bundle_line), "وسم الخانة/السطر ناقص");
  assert.ok(r.lines.every((l) => l.bundle_line === r.lines[0].bundle_line), "نفس السطر لازم نفس المعرّف");
});

t("اختيار ناقص ⇒ رفض واضح، مش سطر ناقص", () => {
  const r = expandBundle(GRILL_BUNDLE, {}, 1, resolve);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "choice_required");
  assert.deepStrictEqual(r.missing, ["grill"]);
});

t("منتج بره الاختيارات المسموحة ⇒ رفض (العميل مايختارش استيك بسعر أرز)", () => {
  const r = expandBundle(GRILL_BUNDLE, { grill: "132" }, 1, resolve);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "choice_not_allowed");
});

t("منتج اتشال من القايمة ⇒ رفض بدل سعر مخترع", () => {
  const r = expandBundle(GRILL_BUNDLE, { grill: "94" }, 1, (p, v) => (String(p) === "123" ? null : resolve(p, v)));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "product_unavailable");
});

t("normalizeSlots بيرمي الخانات الفاضية وبيمنع تكرار المفاتيح", () => {
  const s = normalizeSlots([
    { key: "a", type: "choice", choices: [] },                       // مرفوضة
    { key: "a", type: "fixed", product_id: "123" },
    { key: "a", type: "fixed", product_id: "21" },                   // مفتاح مكرر
    { key: "b", type: "fixed", product_id: "abc" },                  // مرفوضة
    { key: "c", type: "choice", quantity: 99, choices: [{ product_id: "39" }, { product_id: "39" }] },
  ]);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(new Set(s.map((x) => x.key)).size, 3, "المفاتيح لازم تكون فريدة");
  assert.strictEqual(s[2].quantity, 20, "الكمية لازم تتقيّد");
  assert.strictEqual(s[2].choices.length, 1, "الاختيار المكرر لازم يتشال");
});

t("normalizeKinds: فاضي = كل الأنواع", () => {
  assert.deepStrictEqual(normalizeKinds([]), ["delivery", "pickup", "dine_in"]);
  assert.deepStrictEqual(normalizeKinds(["pickup", "junk"]), ["pickup"]);
});

console.log("\n— انتقال الوزن من الطلب لنقطة البيع —");

t("partnerItemsOf: variant_option_id بينتقل من صف الطلب", () => {
  const items = partnerItemsOf({
    items: [
      { product_id: 94, quantity: 1, unit_amount: 121739130430, variant_option_id: 49, variant_name: "كيلو" },
      { product_id: 123, quantity: 2, unit_amount: 10000000000 },
    ],
  });
  assert.strictEqual(items[0].variantOptionId, 49, "الوزن ضاع في الطريق لنقطة البيع");
  assert.strictEqual(items[0].variantName, "كيلو");
  assert.strictEqual(items[1].variantOptionId, undefined, "صنف من غير وزن لازم يفضل من غير وزن");
  assert.strictEqual(items[1].quantity, 2);
});

t("partnerItemsOf: مفيش «ضمن: الباقة» تحت كل صنف في تذكرة المطبخ (قرار عمر 16 سبتمبر)", () => {
  const items = partnerItemsOf({
    items: [{ product_id: 94, quantity: 1, unit_amount: 1, variant_option_id: 49,
              bundle: "national96-grill", bundle_name: "كيلو مشاوي — اليوم الوطني ٩٦" }],
  });
  assert.strictEqual(items[0].lineNote, undefined, "ملاحظة السطر للمطبخ = اللي العميل كتبه بس");
});

t("partnerPurchase: بيبعت variant_option:{id} لما يكون في وزن", () => {
  const p = partnerPurchase({ partnerProductId: "Enz8rXjo5r", taxId: "ly6", quantity: 1,
    unitPrice: 121.73913043, variantOptionId: 49 }, { id: "ly6" });
  assert.deepStrictEqual(p.variant_option, { id: 49 });
  assert.strictEqual(p.product_id, "Enz8rXjo5r");
  assert.strictEqual(p.quantity, 1);
});

t("partnerPurchase: من غير وزن ⇒ مفيش variant_option خالص (زي النهارده)", () => {
  const p = partnerPurchase({ partnerProductId: "dEQ", taxId: "ly6", quantity: 2, unitPrice: 10 }, { id: "ly6" });
  assert.ok(!("variant_option" in p), "صنف عادي مالوش variant_option");
  assert.strictEqual(p.unit_amount, 1000);
  assert.strictEqual(p.quantity, 2);
  assert.deepStrictEqual(p.modifiers, []);
});

t("partnerPurchase: وزن صفر/فاضي مابيتبعتش (ما يتحوّلش لـ0)", () => {
  for (const v of [null, undefined, 0, "", false, "abc"]) {
    const p = partnerPurchase({ partnerProductId: "x", taxId: "t", quantity: 1, unitPrice: 5, variantOptionId: v }, { id: "t" });
    assert.ok(!("variant_option" in p), `variant_option اتبعت لـ ${JSON.stringify(v)}`);
  }
});

t("partnerPurchase: السعر بيتحوّل لهللات زي ما الشريك بيستقبله", () => {
  assert.strictEqual(partnerPurchase({ partnerProductId: "x", taxId: "t", quantity: 1, unitPrice: 60.869565 }, { id: "t" }).unit_amount, 6087);
  assert.strictEqual(partnerPurchase({ partnerProductId: "x", taxId: "t", quantity: 1, unitPrice: 0 }, { id: "t" }).unit_amount, 0);
});

t("partnerPurchase: الضريبة الافتراضية بتتستخدم لو المنتج مالوش", () => {
  const p = partnerPurchase({ partnerProductId: "x", quantity: 1, unitPrice: 1 }, { id: "DEFTAX" });
  assert.strictEqual(p.tax_id, "DEFTAX");
});

console.log(`\n${fail ? "✗" : "✓"} ${pass} نجحت · ${fail} فشلت\n`);
if (fail) process.exit(1);
