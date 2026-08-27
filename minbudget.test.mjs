/* القواعد اللي الحساب الإعلاني الجديد اتبنى عليها — متثبّتة في اختبار عشان
   ماترجعش تتفك بالصدفة:

     ١. الحد الأدنى للميزانية = ٧٫١٤ × تكلفة النتيجة  (٥٠ نتيجة/أسبوع ÷ ٧)
     ٢. حجم الجمهور من ميتا: lower === upper ⇒ رقم أرضية، **مش عدد**
     ٣. توقيت الحساب بيتقرا من ميتا، والجملة اللي بتوصف لفّة اليوم بتتحسب
        مش تتكتب

   node --test minbudget.test.mjs   (أو: node minbudget.test.mjs)            */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_BUDGET_MULTIPLE, minViableDailyBudget, learningBudgetCheck,
  audienceSizeVerdict, lookalikeGate, LAL_MIN_SEED,
  accountRollInLocal, accountRollNote, accountTzInfo, ADS_ACCOUNT_TZ_FALLBACK,
} from "./ads.js";

/* ═══ ١. حساب الحد الأدنى ═══════════════════════════════════════════════ */

test("المضاعف هو ٥٠ ÷ ٧ بالظبط", () => {
  assert.equal(MIN_BUDGET_MULTIPLE, 50 / 7);
  assert.ok(Math.abs(MIN_BUDGET_MULTIPLE - 7.142857) < 1e-5);
});

test("الأرقام اللي في خطة القياس بتطلع نفسها", () => {
  // محادثة واتساب ٢٫٨٣ ر.س → ~٢٠ ر.س/يوم
  assert.ok(Math.abs(minViableDailyBudget(2.83) - 20.22) < 0.05);
  // حدث شرا ٢١٫٨ ر.س → ~١٥٦ ر.س/يوم
  assert.ok(Math.abs(minViableDailyBudget(21.8) - 155.72) < 0.05);
});

test("تكلفة نتيجة غير صالحة بترجّع null مش صفر", () => {
  for (const bad of [0, -1, null, undefined, NaN, "أهلاً"]) {
    assert.equal(minViableDailyBudget(bad), null, `${bad} المفروض null`);
  }
});

/* ═══ ٢. الحكم على ميزانية فعلية ═══════════════════════════════════════ */

test("fc-wa-delivery-10km: ١٧ ر.س ضد ٣٫١٠ = تحت السور", () => {
  const v = learningBudgetCheck({ dailyBudget: 17, costPerResult: 3.10, name: "fc-wa-delivery-10km" });
  assert.equal(v.ok, false);
  assert.ok(Math.abs(v.minViable - 22.15) < 0.05);
  assert.ok(v.ratio < 1);
  assert.ok(v.expectedResultsPerWeek < 50);
});

test("fc-wa-walkin-5km: ٢٥٠ ر.س ضد ٢٫٧١ = فوق السور بمراحل", () => {
  const v = learningBudgetCheck({ dailyBudget: 250, costPerResult: 2.71, name: "fc-wa-walkin-5km" });
  assert.equal(v.ok, true);
  assert.equal(v.blocked, false);
  assert.ok(v.ratio > 12);
  assert.ok(v.expectedResultsPerWeek > 600);
});

test("fc-sales-broad-8km: ٥٠ ر.س ضد ٢٥٠٫٦٦ — الحساب القديم بالحرف", () => {
  const v = learningBudgetCheck({ dailyBudget: 50, costPerResult: 250.66, name: "fc-sales-broad-8km" });
  assert.equal(v.ok, false);
  assert.ok(v.minViable > 1700);
  assert.ok(v.expectedResultsPerWeek < 2);      // نتيجة ونص في الأسبوع مقابل ٥٠
});

test("الهيكل الجديد كله فوق السور", () => {
  // CBO ١٨٠ على مجموعتين ≈ ٩٠ للواحدة، ضد ٢٫٧١ و٣٫١٠
  for (const [budget, cpr, name] of [[90, 2.71, "JED5KM-BROAD"], [90, 3.10, "JED10KM-DELIVERY"],
                                     [60, 8.00, "RMK-ALL-WARM"], [60, 3.10, "LAB"]]) {
    const v = learningBudgetCheck({ dailyBudget: budget, costPerResult: cpr, name });
    assert.equal(v.ok, true, `${name} المفروض فوق السور: ${v.why}`);
    assert.ok(v.expectedResultsPerWeek >= 50, `${name} لازم ≥٥٠ نتيجة/أسبوع`);
  }
});

test("من غير تكلفة نتيجة = «مش عارفين»، وبيعدّي بس بيقولها", () => {
  const v = learningBudgetCheck({ dailyBudget: 60, costPerResult: null, name: "جديدة" });
  assert.equal(v.ok, true);              // مابنمنعش إطلاق مجموعة جديدة
  assert.equal(v.blocked, false);
  assert.equal(v.minViable, null);       // بس مابندّعيش رقم
  assert.match(v.why, /عمى قياس|مانقدرش/);
});

/* ═══ ٣. فخ رقم الأرضية ═════════════════════════════════════════════════ */

test("lower === upper = رقم أرضية، مش عدد — وماينفعش بذرة LAL", () => {
  // «FreshCuts عملاء VIP» زي ما ميتا بترجّعها بالظبط. الحقيقة ٧٧ شخص.
  const vip = audienceSizeVerdict({
    name: "FreshCuts عملاء VIP", subtype: "CUSTOM",
    approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1000,
    delivery_status: { code: 200 },
  });
  assert.equal(vip.sentinel, true);
  assert.equal(vip.measured, false);
  assert.equal(vip.lalReady, false, "بذرة ٧٧ شخص عمرها ما تعدّي — دي اللي كلّفت ٤٣٫٦٦ ر.س");
  assert.equal(vip.size, null);
  assert.equal(vip.knownMetaFloor, true);
});

test("السور الساذج «lower >= 1000» كان هيعدّي البذرة الفاشلة", () => {
  const naive = 1000 >= LAL_MIN_SEED;                       // بيعدّي ✅ — وده الغلط
  assert.equal(naive, true);
  const real = audienceSizeVerdict({
    approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1000,
    delivery_status: { code: 200 }, name: "seed",
  }).lalReady;
  assert.equal(real, false, "السور الصح لازم يشترط إن الرقم متقاس أصلاً");
});

test("حجم متقاس فعلاً (الحدّين مختلفين) وفوق الحد = بذرة صالحة", () => {
  const fb = audienceSizeVerdict({
    name: "FreshCuts FB Page Engagers 365d", subtype: "ENGAGEMENT",
    approximate_count_lower_bound: 6300, approximate_count_upper_bound: 7400,
    delivery_status: { code: 200 },
  });
  assert.equal(fb.measured, true);
  assert.equal(fb.sentinel, false);
  assert.equal(fb.lalReady, true);
  assert.deepEqual(fb.size, { lower: 6300, upper: 7400 });
});

test("delivery_status 300 بيقفل الباب مهما كان الرقم", () => {
  const v = audienceSizeVerdict({
    name: "Video Viewers 30d",
    approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1000,
    delivery_status: { code: 300 },
  });
  assert.equal(v.lalReady, false);
  assert.equal(v.adSetReady, false);
});

test("delivery_status 200 مش دليل حجم", () => {
  // ستة جماهير موقع راجعة ٢٠/٢٠ **و** كود ٢٠٠ في نفس الوقت.
  const v = audienceSizeVerdict({
    name: "FreshCuts Web Visitors 7d", subtype: "WEBSITE",
    approximate_count_lower_bound: 20, approximate_count_upper_bound: 20,
    delivery_status: { code: 200 },
  });
  assert.equal(v.adSetReady, true);      // ينفع في استهداف
  assert.equal(v.lalReady, false);       // مايصلحش بذرة
  assert.equal(v.measured, false);
});

test("بوابة LAL بتفضل مقفولة لما كل البذور أرضيات", () => {
  const gate = lookalikeGate([
    { id: "1", name: "عملاء VIP", approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1000, delivery_status: { code: 200 } },
    { id: "2", name: "كل العملاء", approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1000, delivery_status: { code: 200 } },
    { id: "3", name: "Web Visitors 7d", approximate_count_lower_bound: 20, approximate_count_upper_bound: 20, delivery_status: { code: 200 } },
  ]);
  assert.equal(gate.open, false);
  assert.equal(gate.readySeeds.length, 0);
});

test("بوابة LAL بتفتح أول ما بذرة حقيقية تعدّي الحد", () => {
  const gate = lookalikeGate([
    { id: "1", name: "عملاء VIP", approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1000, delivery_status: { code: 200 } },
    { id: "2", name: "FB Page Engagers 365d", approximate_count_lower_bound: 6300, approximate_count_upper_bound: 7400, delivery_status: { code: 200 } },
  ]);
  assert.equal(gate.open, true);
  assert.equal(gate.readySeeds.length, 1);
  assert.equal(gate.readySeeds[0].name, "FB Page Engagers 365d");
});

/* ═══ ٤. التوقيت ═══════════════════════════════════════════════════════ */

test("حساب على الرياض: يوم الحساب بيلف نص الليل بتوقيت جدة", () => {
  const r = accountRollInLocal("Asia/Riyadh", "Asia/Riyadh");
  assert.equal(r.minutesIntoLocalDay, 0);
  assert.equal(r.sameAsLocal, true);
  assert.match(accountRollNote("Asia/Riyadh"), /نفس نص الليل/);
});

test("حساب على لوس أنجلوس: بيلف ~١٠ صباحاً بتوقيت جدة — محسوبة مش مكتوبة", () => {
  const r = accountRollInLocal("America/Los_Angeles", "Asia/Riyadh");
  // فرق ١٠ أو ١١ ساعة حسب التوقيت الصيفي — الاتنين صح، والمكتوب بالإيد لأ.
  assert.ok([600, 660].includes(r.minutesIntoLocalDay), `طلعت ${r.minutesIntoLocalDay}`);
  assert.equal(r.sameAsLocal, false);
  assert.match(accountRollNote("America/Los_Angeles"), /مش نص الليل/);
});

test("مصدر التوقيت بيتقال، مش بس التوقيت", () => {
  const i = accountTzInfo();
  assert.ok(["meta", "env", "hardcoded-fallback"].includes(i.source));
  // من غير نداء لميتا، مابندّعيش ثقة.
  assert.equal(i.trusted, i.source === "meta");
  assert.equal(i.fallback, ADS_ACCOUNT_TZ_FALLBACK);
});
