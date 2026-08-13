/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات تصنيف الأصناف — الفئة غلط معناها هدف غلط

   المالك بيحطّ هدف بالريال على كل فئة. لو «إضافة كومبو» اتحسبت كريب، هدف
   الكريب بيقرا محقّق وهو مش محقّق. الأسماء اللي تحت كلها أسماء حقيقية
   موجودة دلوقتي في ts_order_items — مش أمثلة متخيّلة.

     node --test scorecard.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import { normItemName, baseItemName, buildPosMap, classifyItem, CATEGORIES } from "./scorecard.js";

/* كتالوج نقطة البيع الحقيقي، مقصوص على الأصناف اللي الاختبارات بتلمسها. */
const POS = [
  { name_ar: "بيتزا تشيكن رانش", name_en: "Chicken Ranch Pizza", category_ar: "بيتزا" },
  { name_ar: "بيتزا مارجريتا", name_en: "Margherita Pizza", category_ar: "بيتزا" },
  { name_ar: "باستا بشاميل", name_en: "Pasta Béchamel", category_ar: "باستا" },
  { name_ar: "بنا تشيكن كازرول", name_en: "Penne Chicken Casserole", category_ar: "باستا" },
  { name_ar: "نجرسكو", name_en: "Negresco", category_ar: "باستا" },
  { name_ar: "كريب ميكس دجاج", name_en: "Mixed Chicken Crepe", category_ar: "كريبات" },
  { name_ar: "إضافة كومبو", name_en: "Combo Add-on", category_ar: "كريبات" },
  { name_ar: "حواوشي سادة", name_en: "Plain Hawawshi", category_ar: "سندوتشات" },
  { name_ar: "برجر لحم كلاسيك", name_en: "Classic Beef Burger", category_ar: "برجر" },
  { name_ar: "جريلد تشيكن ساندوتش", name_en: "Grilled Chicken Sandwich Burger", category_ar: "برجر" },
  { name_ar: "بطاطس محمرة", name_en: "French Fries", category_ar: "مقبلات" },
  { name_ar: "كلوسلو", name_en: "Coleslaw", category_ar: "مقبلات" },
  { name_ar: "وجبة نصف دجاجة على الفحم", name_en: "Half Charcoal Chicken Meal", category_ar: "وجبات" },
  { name_ar: "مشكل مخصوص بالوزن", name_en: "Special Mix Grill Weight", category_ar: "وجبات" },
  { name_ar: "وجبة كفتة وطرب", name_en: "Kofta &amp; Tarb Meal", category_ar: "وجبات" },
  { name_ar: "طبق كبدة اسكندراني", name_en: "Alexandrian Liver Meal", category_ar: "وجبات" },
  { name_ar: "طاسة كرانشي", name_en: "Crunchy Skillet", category_ar: "طاسات" },
  { name_ar: "مياه", name_en: "Water", category_ar: "مشروبات" },
  { name_ar: "مشروبات غازية", name_en: "Soft Drinks", category_ar: "مشروبات" },
  { name_ar: "صينية اللمة 100 ريال", name_en: "Lamma Offer", category_ar: "العروض" },
];
const posMap = buildPosMap(POS);
const cat = (name) => classifyItem(name, posMap);

test("التطبيع بيوحّد الإملاء اللي الكاشير بيكتبه بشكلين", () => {
  assert.equal(normItemName("مياة"), normItemName("مياه"));
  assert.equal(normItemName("إضافة كومبو"), normItemName("أضافه كومبو"));
  assert.equal(normItemName("Kofta &amp; Tarb Meal"), "kofta tarb meal");
});

test("الاسم الأساسي بيشيل المقاس والوزن وذيل المودفاير", () => {
  assert.equal(baseItemName("بيتزا تشيكن رانش - وسط"), normItemName("بيتزا تشيكن رانش"));
  assert.equal(baseItemName("مشكل مخصوص بالوزن - نصف كيلو"), normItemName("مشكل مخصوص بالوزن"));
  assert.equal(baseItemName("Chicken Ranch Pizza - M"), "chicken ranch pizza");
  assert.equal(baseItemName("بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري"), normItemName("بيتزا تشيكن رانش"));
  assert.equal(baseItemName("ملوخيه 4"), "ملوخيه");
});

test("سطور المودفاير بقيمة صفر بتتعزل — مش أكل ومش بتتحسب طلب", () => {
  assert.equal(cat("بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري"), "modifier");
  assert.equal(cat("بيتزا سوبر سوبريم 1.0 بدون حشو اطراف"), "modifier");
  assert.equal(cat("بيتزا مارجريتا - وسط 1.0 حشو اطراف موزاريلا"), "modifier");
});

test("رسوم التوصيل مش صنف أكل", () => {
  assert.equal(cat("توصيل"), "fee");
});

test("«إضافة كومبو» مقبلات مش كريب — رغم إنها مسجّلة تحت صفحة الكريبات", () => {
  // ده الاختبار اللي بيمنع أغلى غلطة في الملف: الكتالوج بيقول «كريبات»،
  // والحقيقة إنها بطاطس ومشروب. لو رجعت "crepe" يبقى هدف الكريب بيتضخّم.
  assert.equal(cat("إضافة كومبو"), "appetizers");
  assert.equal(cat("أضافه كومبو"), "appetizers");
});

test("الفئات السبعة اللي المالك سمّاها بتتصنّف صح من أسماء حقيقية", () => {
  const cases = [
    ["بيتزا تشيكن رانش - وسط", "pizza"],
    ["بيتزا كواترو تشيز - وسط", "pizza"],
    ["Chicken Ranch Pizza - M", "pizza"],
    ["باستا بشاميل", "pasta"],
    ["بنا بيف كازرول", "pasta"],
    ["نجرسكو", "pasta"],
    ["ماك اند تشيز", "pasta"],
    ["سي فود الفريدو", "pasta"],
    ["كريب ميكس دجاج", "crepe"],
    ["كريب زنجر سوبريم", "crepe"],
    ["كريب كفته مخصوص", "crepe"],          // كريب مش مشاوي
    ["كريب حلو نوتيلا", "crepe"],
    ["وجبة نصف دجاجة على الفحم", "grill"],
    ["مشكل مخصوص بالوزن - ثلث كيلو", "grill"],
    ["طبق كبدة اسكندراني", "grill"],
    ["كفتة مشوية بالوزن - كيلو", "grill"],
    ["ورقة سجق اسكندراني", "grill"],
    ["Half Charcoal Chicken Meal", "grill"],
    ["حواوشي سادة", "hawawshi"],
    ["حواوشي كيري بسطرمة", "hawawshi"],
    ["برجر لحم كلاسيك", "burger"],
    ["مشروم بيف بيكون برجر", "burger"],
    ["جريلد تشيكن ساندوتش", "burger"],
    ["بطاطس محمرة", "appetizers"],
    ["تشيلي تشيز فرايز", "appetizers"],
    ["كلوسلو", "appetizers"],
    ["دوريتوس", "appetizers"],
    ["فرايد موتزريلا", "appetizers"],
    ["حلقات بصل", "appetizers"],
  ];
  for (const [name, want] of cases) assert.equal(cat(name), want, name);
});

test("«بيتزا برجر» بيتزا و«طاسة برجر» طاسة — الأخص بيكسب الأعم", () => {
  assert.equal(cat("بيتزا برجر - وسط"), "pizza");
  assert.equal(cat("طاسة كرانشي"), "skillet");
  assert.equal(cat("طاسة برجر"), "skillet");
});

test("المشروبات بكل إملاءاتها", () => {
  for (const n of ["مياه", "مياة", "Water", "بيبسي زجاج", "مشروبات غازية - كان",
    "مشروبات غازية - can", "pepsi - can", "Soft Drinks - can"]) {
    assert.equal(cat(n), "drinks", n);
  }
});

test("العروض والأطباق الجانبية ليها مكانها، ومحدش بيتحط في غير مصنّف من غير داعي", () => {
  assert.equal(cat("صينية اللمة 100 ريال"), "offers");
  assert.equal(cat("ارز ساده"), "appetizers");
  assert.equal(cat("طبق أرز بسمتي"), "appetizers");
  assert.equal(cat("سلطه خضرا"), "appetizers");
  assert.equal(cat("ملوخيه 4"), "grill");
});

test("الاسم اللي محدش يعرفه بيرجع «غير مصنّف» — مش بيتوزّع على فئة عشوائية", () => {
  assert.equal(cat("زقزقة الفلانية"), "other");
  assert.equal(cat(""), "other");
  assert.equal(cat(null), "other");
});

test("الفئات السبعة بتاعة المالك كلها معرّفة ومتعلّمة owner", () => {
  const owner = CATEGORIES.filter((c) => c.owner).map((c) => c.id).sort();
  assert.deepEqual(owner, ["appetizers", "burger", "crepe", "grill", "hawawshi", "pasta", "pizza"]);
  // كل فئة مربوطة بصفحة منيو حقيقية أو معلّمة إنها مالهاش صفحة عن قصد
  for (const c of CATEGORIES) assert.ok("pos" in c, c.id);
});
