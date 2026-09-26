/* رسايل واتساب للعميل — الاختبارات (مرحلة ٠، ٢٦/٩).
   الرسالة رايحة لعميل سعودي في جدة: كلمة مصرية أو صنف غلط = رسالة بتضر. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  agoSa, cleanItemName, isDishName, itemsPhraseSa, favDish, renderTemplate, templateProblem,
  isOptOutText, parseRecipientSlug, recipientLink, effectiveDailyCap, creditOrders, dropPosMirrors,
  summarizeResults, TEMPLATE_VARS,
} from "./wamsg.js";
import { inHoldout } from "./smsrules.js";

const DAY = 86400000;
const NOW = Date.parse("2026-09-26T12:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test("agoSa: سعودي مش مصري", () => {
  const cases = [[0, "اليوم"], [1, "أمس"], [2, "قبل يومين"], [3, "قبل 3 أيام"], [6, "قبل 6 أيام"], [7, "قبل أسبوع"],
    [13, "قبل أسبوع"], [14, "قبل أسبوعين"], [21, "قبل 3 أسابيع"], [28, "قبل 4 أسابيع"], [45, "قبل شهر"],
    [70, "قبل شهرين"], [95, "قبل 3 أشهر"], [200, "قبل 7 أشهر"], [400, "قبل سنة تقريباً"], [900, "من فترة طويلة"]];
  for (const [d, want] of cases) assert.equal(agoSa(ago(d), NOW), want, `${d} يوم`);
  for (const d of [0, 1, 3, 10, 21, 45, 120]) {
    const t = agoSa(ago(d), NOW);
    assert.ok(!/امبارح|النهاردة|شهور|تانية|من \d/.test(t), `مصري: ${t}`);
  }
  for (const v of [null, undefined, "", "x"]) assert.equal(agoSa(v, NOW), "");
});

test("cleanItemName: ضوضاء الوزن والخيارات بتتشال", () => {
  assert.equal(cleanItemName("كفتة مشوية بالوزن - ثلث كيلو"), "كفتة مشوية ثلث كيلو");
  assert.equal(cleanItemName("مشكل مخصوص بالوزن - نصف كيلو"), "مشكل مخصوص نصف كيلو");
  assert.equal(cleanItemName("طرب مشوي بالوزن - كيلو"), "طرب مشوي كيلو");
  assert.equal(cleanItemName("كفتة مشوية بالوزن"), "كفتة مشوية");
  assert.equal(cleanItemName("كفتة مشوية بالوزن - ثلث كيلو", { withSize: false }), "كفتة مشوية");
  assert.equal(cleanItemName("بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري"), "بيتزا تشيكن رانش");
  assert.equal(cleanItemName("بيتزا تشيكن رانش 1.0 بدون حشو اطراف"), "بيتزا تشيكن رانش");
  assert.equal(cleanItemName("وجبة كفتة 1.0 مشروب + بطاطس"), "وجبة كفتة");
  assert.equal(cleanItemName("Kofta Meal"), "وجبة كفتة");
  assert.equal(cleanItemName("Chicken Ranch Pizza - M"), "بيتزا تشيكن رانش");
  assert.equal(cleanItemName("Mixed Chicken Crepe 1.0 Add"), "كريب ميكس دجاج");
  assert.equal(cleanItemName("Fire Bird Chicken Burger"), "", "إنجليزي مش معروف مايدخلش الرسالة");
  assert.equal(cleanItemName(""), "");
});

test("isDishName: مية/بيبسي/رز/إضافات مش أطباق — والكريب بطاطس طبق", () => {
  for (const n of ["مياه", "مياة", "Water", "بيبسي زجاج", "مشروبات غازية - كان", "pepsi - can", "طبق أرز بسمتي", "ارز",
    "بطاطس محمرة", "كلوسلو", "إضافة كومبو", "أضافه كومبو", "توصيل", "رسوم التوصيل", "تشيز فرايز", "حلقات بصل", "دوريتوس", "Add Combo"])
    assert.equal(isDishName(n), false, n);
  for (const n of ["كريب بطاطس", "وجبة نصف دجاجة على الفحم", "بيتزا تشيكن رانش - وسط", "حواوشي سادة", "طبق كبدة اسكندراني",
    "كفتة مشوية بالوزن - كيلو", "جريلد تشيكن ساندوتش", "طاسة كرانشي", "صينية اللمة 100 ريال"])
    assert.equal(isDishName(n), true, n);
});

test("itemsPhraseSa: صنفين بالكتير وبعدين «وغيرها»، الأطباق الأول", () => {
  assert.equal(itemsPhraseSa(["كريب زنجر سوبريم"]), "كريب زنجر سوبريم");
  assert.equal(itemsPhraseSa(["كريب زنجر سوبريم", "مياه", "بيبسي زجاج"]), "كريب زنجر سوبريم");
  assert.equal(itemsPhraseSa(["كفتة مشوية بالوزن - ثلث كيلو", "كريب ستربس"]), "كفتة مشوية ثلث كيلو وكريب ستربس");
  assert.equal(itemsPhraseSa(["أ", "ب", "ج", "د"]), "أ وب وغيرها");
  assert.equal(itemsPhraseSa(["مياه", "بيبسي زجاج"]), "مياه وبيبسي زجاج", "طلب كله مشروبات = نكتبه زي ما هو");
  assert.equal(itemsPhraseSa(["حواوشي سادة", "حواوشي سادة"]), "حواوشي سادة", "مفيش تكرار");
  assert.equal(itemsPhraseSa([]), "");
  assert.ok(!/تانية|أصناف/.test(itemsPhraseSa(["أ", "ب", "ج"])));
});

test("favDish: عدد × حداثة، ومن غير الجوانب والمشروبات", () => {
  const hist = [
    { at: ago(2), names: "كريب زنجر سوبريم|مياه|بطاطس محمرة" },
    { at: ago(20), names: "كفتة مشوية بالوزن - ثلث كيلو|طبق أرز بسمتي" },
    { at: ago(40), names: "كفتة مشوية بالوزن - كيلو|بيبسي زجاج" },
    { at: ago(60), names: "كفتة مشوية بالوزن|مياه" },
  ];
  const f = favDish(hist, NOW);
  assert.equal(f.dish, "كفتة مشوية", "٣ مرات قديمة تكسب مرة جديدة");
  assert.equal(f.group, "grill");
  assert.equal(f.groupLabel, "مشاوي");
  const recent = favDish([{ at: ago(1), names: "حواوشي سادة" }, { at: ago(300), names: "كريب ستربس" }], NOW);
  assert.equal(recent.dish, "حواوشي سادة");
  assert.equal(recent.groupLabel, "حواوشي");
  assert.deepEqual(favDish([{ at: ago(1), names: "مياه|بيبسي زجاج" }], NOW), { dish: "", group: null, groupLabel: "" });
  assert.equal(favDish([{ at: ago(3), names: "Kofta Meal|Water" }], NOW).dish, "وجبة كفتة");
});

test("القالب: {name} إجباري، والمتغير المجهول بيترفض، والفاضي = القالب العام", () => {
  assert.equal(templateProblem(""), null);
  assert.equal(templateProblem("أهلاً"), "name_required");
  assert.equal(templateProblem("هلا {first_name}"), null);
  assert.equal(templateProblem("هلا {name} {lnk}"), "unknown_var:lnk");
  assert.equal(templateProblem("هلا {name} {link} {coupon} {fav_dish} {fav_group}"), null);
  const m = renderTemplate("هلا {name}، {fav_dish} ينتظرك: {link}", { name: "سارة", fav_dish: "كريب ستربس", link: "freshcuts.sa/l/w3-abc123" });
  assert.equal(m, "هلا سارة، كريب ستربس ينتظرك: freshcuts.sa/l/w3-abc123");
  assert.equal(renderTemplate("هلا {name} {coupon}\nتم", { name: "علي" }), "هلا علي\nتم", "متغير فاضي مابيسيبش مسافات");
  assert.ok(TEMPLATE_VARS.every((v) => v.key && v.label && v.example));
});

test("رد «إيقاف» على واتساب", () => {
  for (const t of ["إيقاف", "ايقاف", " ايقاف. ", "إيقاف 🙏", "STOP", "stop", "Unsubscribe", "الغاء الاشتراك", "إلغاء", "وقف",
    "ايقاف الرسائل", "لا ترسلوا لي رسائل", "لا ترسل", "ما ابي رسايل", "ما أبغى رسائل", "إِيقَاف"])
    assert.equal(isOptOutText(t), true, t);
  for (const t of ["ممكن ايقاف الطلب؟", "شكراً", "تمام", "كم سعر الكيلو", "", null, "ايقاف الطلب لو سمحت",
    "لا شكرا عندي طلب", "stop by later please thanks a lot my friend"])
    assert.equal(isOptOutText(t), false, String(t));
});

test("روابط لكل عميل /l/<slug>-<code>", () => {
  assert.deepEqual(parseRecipientSlug("w12-a1b2c3"), { base: "w12", code: "a1b2c3" });
  assert.deepEqual(parseRecipientSlug("wa-sept-offer-zz9k2m"), { base: "wa-sept-offer", code: "zz9k2m" });
  assert.equal(parseRecipientSlug("96-sms"), null);
  assert.equal(parseRecipientSlug("w12"), null);
  assert.equal(parseRecipientSlug("W12-A1B2C3").code, "a1b2c3");
  assert.equal(recipientLink("https://freshcuts.sa/", "w12", "a1b2c3"), "freshcuts.sa/l/w12-a1b2c3");
  assert.equal(recipientLink("freshcuts.sa", "w12", null), "freshcuts.sa/l/w12");
});

test("التجميع التدريجي: مقفول افتراضياً، ولما يشتغل بيزيد لحد السقف", () => {
  assert.equal(effectiveDailyCap({ dailyCap: 40 }, NOW), 40);
  assert.equal(effectiveDailyCap({ dailyCap: 40, warmup: { enabled: false, startedAt: ago(0) } }, NOW), 40);
  const w = (d) => ({ dailyCap: 40, warmup: { enabled: true, startedAt: ago(d), from: 10, step: 5 } });
  assert.equal(effectiveDailyCap(w(0), NOW), 10);
  assert.equal(effectiveDailyCap(w(3), NOW), 25);
  assert.equal(effectiveDailyCap(w(30), NOW), 40);
});

test("holdout ثابت لكل (حملة، رقم) وقريب من النسبة", () => {
  const pns = Array.from({ length: 2000 }, (_, i) => `5${String(10000000 + i * 37).padStart(8, "0")}`);
  const n = pns.filter((p) => inHoldout("wa12", p, 10)).length;
  assert.ok(n > 140 && n < 260, `~10%: ${n}`);
  assert.equal(inHoldout("wa12", pns[5], 10), inHoldout("wa12", pns[5], 10));
  assert.equal(pns.filter((p) => inHoldout("wa12", p, 0)).length, 0);
});

test("النسب: كل طلب لآخر رسالة قبله خلال ٧ أيام — مرة واحدة", () => {
  const sends = [
    { pn: "500000001", at: ago(10), jobId: 1 },
    { pn: "500000001", at: ago(5), jobId: 2 },
    { pn: "500000002", at: ago(9), jobId: 1 },
    { pn: "500000003", at: ago(3), jobId: null },   // يدوي
  ];
  const orders = [
    { key: "a", pn: "500000001", at: ago(4), total: 100 },   // بعد رسالة ٢ ⇒ حملة ٢ (مش ١)
    { key: "b", pn: "500000001", at: ago(9.5), total: 50 },  // بعد رسالة ١ وقبل ٢ ⇒ حملة ١
    { key: "c", pn: "500000002", at: ago(1), total: 70 },    // بعد ٨ أيام ⇒ برا النافذة
    { key: "d", pn: "500000003", at: ago(2), total: 30 },    // يدوي
    { key: "e", pn: "500000009", at: ago(2), total: 30 },    // مالوش رسالة
    { key: "f", pn: "500000001", at: ago(11), total: 30 },   // قبل أي رسالة
  ];
  const m = creditOrders(sends, orders, 7);
  assert.equal(m.get("a").jobId, 2);
  assert.equal(m.get("b").jobId, 1);
  assert.equal(m.has("c"), false);
  assert.equal(m.get("d").jobId, null);
  assert.equal(m.has("e"), false);
  assert.equal(m.has("f"), false);
});

test("طلب الموقع اللي نزل نقطة البيع مابيتعدّش مرتين", () => {
  const web = [{ pn: "500000001", at: "2026-09-20T10:00:00Z", total: 100 }];
  const pos = [
    { key: "p1", pn: "500000001", at: "2026-09-20T10:05:00Z", total: 100.5 },  // نفس الطلب
    { key: "p2", pn: "500000001", at: "2026-09-21T10:05:00Z", total: 100 },    // يوم تاني
    { key: "p3", pn: "500000002", at: "2026-09-20T10:05:00Z", total: 100 },    // رقم تاني
  ];
  assert.deepEqual(dropPosMirrors(pos, web).map((x) => x.key), ["p2", "p3"]);
});

test("ملخص النتيجة: التحويل مقابل المحجوز والطلبات الزيادة", () => {
  const o = (pn, total) => ({ pn, total });
  const r = summarizeResults({ sentN: 100, holdN: 10,
    sentOrders: [o("1", 100), o("2", 50), o("2", 50), o("3", 80), o("4", 20)], holdOrders: [] });
  assert.equal(r.sent.people, 4); assert.equal(r.sent.orders, 5); assert.equal(r.sent.rate, 4); assert.equal(r.sent.revenue, 300);
  assert.equal(r.holdout.rate, 0); assert.equal(r.liftPts, 4); assert.equal(r.incremental, 5);
  const noHold = summarizeResults({ sentN: 10, holdN: 0, sentOrders: [], holdOrders: [] });
  assert.equal(noHold.incremental, null); assert.equal(noHold.liftPts, null);
});

test("fav_group = مجموعة الطبق المفضّل نفسه (مش مجموعة تانية في نفس الجملة)", () => {
  const f = favDish([{ at: ago(1), names: "حواوشي كيري بسطرمة" }, { at: ago(20), names: "وجبة ميكس جريل" }, { at: ago(25), names: "وجبة كفتة" }], NOW);
  assert.equal(f.dish, "حواوشي كيري بسطرمة");
  assert.equal(f.groupLabel, "حواوشي");
});
