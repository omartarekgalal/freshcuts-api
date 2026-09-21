/* تفضيل الأكل لعميل التطبيق + شرائحه (قرار عمر ٢١/٩).
   الاختبارات دي بتحرس الحاجات اللي لو اتكسرت الرسالة توصل غلط:
   «بيتزا برجر» مش برجر، «ورقة سجق» حواوشي مش مشاوي، والمقبلات
   والمشروبات مش إشارة تفضيل أصلاً. */
import test from "node:test";
import assert from "node:assert/strict";

import { foodGroup, topFoodGroup, FOOD_GROUPS, FOOD_GROUP_IDS, foodGroupOf, APP_FOOD_SEGMENTS, smsParts, optoutLine, priceMatcher, lineValue } from "./smsrules.js";

test("كل صنف في المنيو الحي بيروح لمجموعته الصح", () => {
  const cases = {
    // مشاوي — الوجبات والمشاوي بالوزن (تعريف عمر للكاتيجوري)
    "وجبة نصف دجاجة على الفحم": "grill", "كفتة مشوية بالوزن": "grill", "ريش مشوية بالوزن": "grill",
    "مشكل مخصوص بالوزن": "grill", "طبق كبدة اسكندراني": "grill", "وجبة ميكس جريل": "grill",
    // كريب
    "كريب زنجر سوبريم": "crepe", "كريب هوت دوج": "crepe", "كريب ميكس لحوم": "crepe",
    // باستا (شامل الكازرول والفريدو والنجرسكو)
    "باستا بشاميل": "pasta", "سي فود كازرول": "pasta", "تشيكن بينا الفريدو": "pasta",
    "ماك اند تشيز": "pasta", "نجرسكو": "pasta",
    // بيتزا — أسماء نقطة البيع بتيجي بلاحقة، فالمطابقة لازم تمسكها
    "بيتزا مارجريتا": "pizza", "بيتزا تشيكن رانش 1.0 بدون حشو اطراف": "pizza",
    "بيتزا بيبروني 1.0 حشو اطراف كيري": "pizza",
    // حواوشي
    "حواوشي سادة": "hawawshi", "حواوشي كيري بسطرمة": "hawawshi",
    // برجر — أربعة بس، و«جريلد تشيكن ساندوتش» واحد منهم
    "برجر لحم كلاسيك": "burger", "مشروم بيف بيكون برجر": "burger",
    "جريلد تشيكن ساندوتش": "burger", "كريمي مشروم تشيكن": "burger",
  };
  for (const [name, g] of Object.entries(cases)) assert.equal(foodGroup(name), g, name);
});

test("«بيتزا برجر» بيتزا مش برجر — الترتيب مقصود", () => {
  assert.equal(foodGroup("بيتزا برجر 1.0 حشو اطراف كيري"), "pizza");
});

test("«ورقة سجق اسكندراني» حواوشي مش مشاوي — عيش ملفوف مش وزن", () => {
  assert.equal(foodGroup("ورقة سجق اسكندراني"), "hawawshi");
  assert.equal(foodGroup("سجق مشوي بالوزن"), "grill");
});

test("المقبلات والمشروبات مش إشارة تفضيل", () => {
  for (const n of ["بطاطس محمرة", "كلوسلو", "مشروبات غازية", "مياه", "دوريتوس", "تشيز فرايز", "إضافة كومبو", "مخلل"]) {
    assert.equal(foodGroup(n), null, n);
  }
});

test("أعلى مجموعة بالإنفاق، والتعادل بيترتّب ثابت", () => {
  assert.equal(topFoodGroup({ crepe: 120, grill: 90 }), "crepe");
  assert.equal(topFoodGroup({ grill: 90, crepe: 90 }), "grill"); // ترتيب FOOD_GROUPS
  assert.equal(topFoodGroup({}), null);
  assert.equal(topFoodGroup(null), null);
  assert.equal(topFoodGroup({ pizza: 0 }), null);
});

/* سطر البيتزا اللي عليه حشو أطراف بيتسجّل بصفر في نقطة البيع. من غير
   التسعير من الكتالوج شريحة «بيتزا» بتطلع صفر بني آدم بينما فيه ١٤. */
const CATALOG = [
  { name_ar: "بيتزا", price_incl: 99 }, // فخ: اسم أقصر لازم يخسر
  { name_ar: "بيتزا تشيكن رانش", price_incl: 28 },
  { name_ar: "بيتزا مارجريتا", price_incl: 20 },
  { name_ar: "كريب ميكس لحوم", price_incl: 30 },
  { name_ar: "طحينه", price_incl: 0 }, // سعر صفر مايدخلش القايمة
];

test("التسعير من الكتالوج بياخد أطول اسم بيطابق البداية", () => {
  const p = priceMatcher(CATALOG);
  assert.equal(p("بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري"), 28);
  assert.equal(p("بيتزا مارجريتا 1.0 بدون حشو اطراف"), 20);
  assert.equal(p("بيتزا حاجة متعرفهاش"), 99); // بترجع للاسم العام
  assert.equal(p("حاجة مش في الكتالوج"), 0);
  assert.equal(p("طحينه"), 0);
});

test("سطر بسعر بيفضل بسعره، وسطر بصفر بيتسعّر × الكمية", () => {
  const p = priceMatcher(CATALOG);
  assert.equal(lineValue({ name: "بيتزا مارجريتا - وسط", amount: 25, qty: 1 }, p), 25);
  assert.equal(lineValue({ name: "بيتزا تشيكن رانش 1.0 حشو اطراف كيري", amount: 0, qty: 2 }, p), 56);
  assert.equal(lineValue({ name: "بيتزا تشيكن رانش 1.0 حشو اطراف كيري", amount: 0 }, p), 28); // كمية ناقصة = ١
  assert.equal(lineValue({ name: "مش موجود", amount: 0, qty: 3 }, p), 0);
});

test("عميل كل بيتزته بصفر لازم يبقى «بيتزا» مش بلا تفضيل", () => {
  const p = priceMatcher(CATALOG);
  const lines = [
    { name: "بيتزا تشيكن رانش 1.0 حشو اطراف كيري", amount: 0, qty: 1 },
    { name: "بيتزا مارجريتا 1.0 بدون حشو اطراف", amount: 0, qty: 1 },
    { name: "كريب ميكس لحوم", amount: 30, qty: 1 },
  ];
  const food = {};
  for (const l of lines) { const g = foodGroup(l.name); if (g) food[g] = (food[g] || 0) + lineValue(l, p); }
  assert.equal(topFoodGroup(food), "pizza"); // ٤٨ بيتزا مقابل ٣٠ كريب
  // من غير التسعير كان هيطلع كريب — ده بالظبط الباج
  const naive = {};
  for (const l of lines) { const g = foodGroup(l.name); if (g) naive[g] = (naive[g] || 0) + (Number(l.amount) || 0); }
  assert.equal(topFoodGroup(naive), "crepe");
});

test("المشاوي بتروح للكيلو والباقي للبوكس", () => {
  assert.equal(foodGroupOf("grill").offer, "kilo");
  for (const id of FOOD_GROUP_IDS.filter((x) => x !== "grill")) assert.equal(foodGroupOf(id).offer, "box");
  assert.equal(foodGroupOf("nope"), null);
});

test("شريحة لكل مجموعة، كلها allowApps، ومفيش تداخل بينهم", () => {
  assert.equal(APP_FOOD_SEGMENTS.length, FOOD_GROUPS.length);
  for (const s of APP_FOOD_SEGMENTS) assert.equal(s.allowApps, true);
  const base = { appSrcOrders: 2, onlineDaysSince: 9999 };
  for (const g of FOOD_GROUP_IDS) {
    const hit = APP_FOOD_SEGMENTS.filter((s) => s.test({ ...base, appTopFood: g }));
    assert.equal(hit.length, 1, `${g} لازم يقع في شريحة واحدة بالظبط`);
    assert.equal(hit[0].id, `k_app_${g}`);
  }
});

test("اللي طلب من موقعنا آخر ١٤ يوم مابياخدش رسالة «حوّل لموقعنا»", () => {
  const s = APP_FOOD_SEGMENTS[0];
  assert.equal(s.test({ appSrcOrders: 3, appTopFood: "grill", onlineDaysSince: 9999 }), true);
  assert.equal(s.test({ appSrcOrders: 3, appTopFood: "grill", onlineDaysSince: 5 }), false);
  assert.equal(s.test({ appSrcOrders: 0, appTopFood: "grill", onlineDaysSince: 9999 }), false);
});

/* الرسايل الفعلية — لو أي واحدة عدّت جزئين تقنيات بترفضها (MAX_PARTS=2)
   والموجة كلها بتتوقف. الاختبار ده بيمسك ده قبل الجدولة مش بعدها. */
const OPTOUT = optoutLine({ optoutMode: "keyword" }, { sender: "FreshCut-AD" });
export const APP_MESSAGES = {
  grill: "المشاوي اللي بتحبها: كيلو ٩٦ والرز هدية — وأول توصيل مجاني freshcuts.sa/l/96ag",
  crepe: "الكريب اللي بتحبه في بوكس ٩٦ مع بيتزا وباستا وحواوشي — وأول توصيل مجاني freshcuts.sa/l/96ac",
  pasta: "الباستا اللي بتحبها في بوكس ٩٦ مع بيتزا وكريب وحواوشي — وأول توصيل مجاني freshcuts.sa/l/96ap",
  pizza: "البيتزا اللي بتحبها في بوكس ٩٦ مع باستا وكريب وحواوشي — وأول توصيل مجاني freshcuts.sa/l/96az",
  hawawshi: "الحواوشي اللي بتحبه في بوكس ٩٦ مع بيتزا وباستا وكريب — وأول توصيل مجاني freshcuts.sa/l/96ah",
  burger: "البرجر عاجبك؟ بيتزا برجر في بوكس ٩٦ مع باستا وكريب — وأول توصيل مجاني freshcuts.sa/l/96ab",
};

test("كل رسالة مجموعة ≤ جزئين بعد إضافة سطر الإيقاف", () => {
  for (const [g, body] of Object.entries(APP_MESSAGES)) {
    const parts = smsParts(`${body}\n${OPTOUT}`);
    assert.ok(parts <= 2, `${g}: ${parts} أجزاء — ${[...body].length} حرف`);
  }
});

test("كل رسالة بتذكر أكل العميل + العرض + التوصيل المجاني + رابطها", () => {
  const words = { grill: "المشاوي", crepe: "الكريب", pasta: "الباستا", pizza: "البيتزا", hawawshi: "الحواوشي", burger: "البرجر" };
  for (const [g, body] of Object.entries(APP_MESSAGES)) {
    assert.ok(body.includes(words[g]), `${g} لازم يذكر ${words[g]}`);
    assert.ok(body.includes("٩٦"), `${g} لازم يذكر العرض`);
    assert.ok(body.includes("توصيل مجاني"), `${g} لازم يذكر التوصيل المجاني`);
    assert.ok(/freshcuts\.sa\/l\/96a[gcpzhb]/.test(body), `${g} لازم يكون له رابطه`);
  }
  // رابط مختلف لكل مجموعة — غير كده القياس بيتخلط
  const slugs = Object.values(APP_MESSAGES).map((m) => m.match(/\/l\/(\S+)/)[1]);
  assert.equal(new Set(slugs).size, slugs.length);
});
