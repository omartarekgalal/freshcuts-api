/* تفضيل الأكل لعميل التطبيق + شرائحه (قرار عمر ٢١/٩).
   الاختبارات دي بتحرس الحاجات اللي لو اتكسرت الرسالة توصل غلط:
   «بيتزا برجر» مش برجر، «ورقة سجق» حواوشي مش مشاوي، والمقبلات
   والمشروبات مش إشارة تفضيل أصلاً. */
import test from "node:test";
import assert from "node:assert/strict";

import { foodGroup, topFoodGroup, FOOD_GROUPS, FOOD_GROUP_IDS, foodGroupOf, APP_FOOD_SEGMENTS, smsParts, optoutLine } from "./smsrules.js";

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
