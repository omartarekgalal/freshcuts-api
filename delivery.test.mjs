/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات محرك تسعير التوصيل — العميل بيتحاسب بالنتيجة دي حرفياً

   قاعدة عمر: «أول (عدد) كم بسعر، وكل كم زيادة بسعر» + أنظمة الخصم بتاعة
   تطبيقات التوصيل (توصيل مجاني فوق مبلغ، خصم ثابت/نسبة). الدالة صافية
   عشان تتجرب هنا من غير قاعدة بيانات ولا API.

     node --test delivery.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import { computeDeliveryFee, haversineKm, DEFAULT_POLICY } from "./delivery.js";

const CFG = {
  type: "distance_tiers",
  baseKm: 3, baseFee: 10, perKm: 2,
  feeCap: null, freeOverTotal: null, minOrderTotal: 0, maxKm: 15,
  routeFactor: 1, discount: { mode: "none", value: 0, label: "" },
};

test("داخل الباقة الأساسية: المسافة أقل من baseKm تدفع baseFee بس", () => {
  const r = computeDeliveryFee(CFG, { distanceKm: 2.4, orderTotal: 50 });
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 10);
});

test("بالظبط على حد الباقة: مفيش كيلومتر إضافي", () => {
  const r = computeDeliveryFee(CFG, { distanceKm: 3, orderTotal: 50 });
  assert.equal(r.fee, 10);
});

test("الكيلومتر الإضافي بيتحسب لكل كم بدأ (ceil): 4.2 كم = كم إضافي 2", () => {
  // 4.2 - 3 = 1.2 → يتقرّب لـ 2 كم إضافي × 2 ر.س = 4
  const r = computeDeliveryFee(CFG, { distanceKm: 4.2, orderTotal: 50 });
  assert.equal(r.fee, 14);
});

test("أبعد من maxKm: مش قابل للتوصيل مع ذكر السبب", () => {
  const r = computeDeliveryFee(CFG, { distanceKm: 16, orderTotal: 50 });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "out_of_range");
});

test("تحت الحد الأدنى للطلب: مرفوض قبل ما نحسب أي رسوم", () => {
  const r = computeDeliveryFee({ ...CFG, minOrderTotal: 40 }, { distanceKm: 2, orderTotal: 39 });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "under_minimum");
});

test("توصيل مجاني فوق مبلغ بيصفّر الرسوم مهما كانت المسافة", () => {
  const r = computeDeliveryFee({ ...CFG, freeOverTotal: 100 }, { distanceKm: 9, orderTotal: 120 });
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 0);
});

test("الحد الأقصى للرسوم بيقصّ قبل الخصومات", () => {
  // 3+9 كم إضافي: 10 + 9×2 = 28 → cap 20
  const r = computeDeliveryFee({ ...CFG, feeCap: 20 }, { distanceKm: 12, orderTotal: 50 });
  assert.equal(r.fee, 20);
});

test("خصم ثابت ما ينزلش الرسوم تحت الصفر", () => {
  const r = computeDeliveryFee({ ...CFG, discount: { mode: "flat", value: 50, label: "عرض" } },
    { distanceKm: 2, orderTotal: 50 });
  assert.equal(r.fee, 0);
});

test("خصم نسبة: 50% على رسوم 14 = 7", () => {
  const r = computeDeliveryFee({ ...CFG, discount: { mode: "percent", value: 50, label: "نص التوصيل" } },
    { distanceKm: 4.2, orderTotal: 50 });
  assert.equal(r.fee, 7);
});

test("قيم ناقصة في السياسة بتقع على الافتراضيات بدل ما تكسر الحساب", () => {
  const r = computeDeliveryFee({ baseFee: 12 }, { distanceKm: 1, orderTotal: 50 });
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 12);
  assert.equal(DEFAULT_POLICY.baseKm > 0, true);
});

test("هافرساين: المطعم لنفسه صفر، وجدة→مكة ≈ 64 كم", () => {
  assert.equal(haversineKm(21.5881, 39.1521, 21.5881, 39.1521), 0);
  const jeddahToMakkah = haversineKm(21.5881, 39.1521, 21.3891, 39.8579);
  assert.equal(jeddahToMakkah > 55 && jeddahToMakkah < 80, true, `got ${jeddahToMakkah}`);
});

test("breakdown بيشرح كل سطر دفع العميل ليه المبلغ ده", () => {
  const r = computeDeliveryFee({ ...CFG, freeOverTotal: 100 }, { distanceKm: 5, orderTotal: 120 });
  assert.equal(r.breakdown.length >= 2, true);
  assert.equal(r.breakdown.at(-1).includes("مجاني"), true);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ضمان «مايلاقيش التطبيقات أرخص» — الثغرة اللي وقّفت الضمان، والقاعدة الجديدة

   سلّم عمر المعتمد (نفس اللي في dl_policies id=1): <60→20، 60-80→15،
   80-100→10، 100-150→5، 150+→مجاني. baseKm = maxKm = 10، وتكلفة لعجلك
   ١٩٫٥٥ ثابتة جوّه العشر كيلو.
═══════════════════════════════════════════════════════════════════════════ */

import { appsGuard, APPS_GUARD_DEFAULTS, BENCHMARKS } from "./delivery.js";

const LADDER = {
  type: "distance_tiers",
  baseKm: 10, baseFee: 20, perKm: 3, maxKm: 10, routeFactor: 1.3,
  feeCap: null, freeOverTotal: null, freeCoverMax: null, minOrderTotal: 0,
  feeByTotal: [{ over: 0, fee: 20 }, { over: 60, fee: 15 }, { over: 80, fee: 10 },
    { over: 100, fee: 5 }, { over: 150, fee: 0 }],
  discount: { mode: "none", value: 0, label: "" },
};
const ON = { ...LADDER, neverBeatenByApps: { enabled: true, appMarkupPct: 33, minCheaperBy: 1 } };
const feeAt = (cfg, orderTotal) => computeDeliveryFee(cfg, { distanceKm: 6, orderTotal });
// صافي الطلب = مساهمة الأكل + الرسم المحصّل − تكلفة الكابتن
const net = (total, fee) => Math.round((BENCHMARKS.dineInContribution * total + fee - 19.55) * 100) / 100;

test("الثغرة اللي عمر جرّبها: ١ مياه بريال — التوصيل مش صفر", () => {
  // القاعدة القديمة: floor(1 × 33% − 1) = −1 → صفر → خسارة ١٩٫١٠ على الطلب
  const r = feeAt(ON, 1);
  assert.equal(r.fee, 20);
  assert.equal(r.guard.capped, true);          // الوعد مستحيل على السلة دي
  assert.equal(r.guard.applied, false);
  assert.equal(net(1, 0), -19.1);              // اللي كان بيحصل
  assert.equal(net(1, r.fee) > 0, true, `net=${net(1, r.fee)}`);  // اللي بيحصل دلوقتي
});

test("أرضية عدم الخسارة بتتحسب من تكلفة الكابتن مش من رقم مكتوب بالإيد", () => {
  const g = appsGuard({ total: 1, fee: 20, nextTierFee: 15, guard: { enabled: true } });
  // 19.55 − 0.452×1 = 19.098 → الأرضية ٢٠ بعد التقريب لأعلى
  assert.equal(g.breakEven, 19.1);
  assert.equal(g.floor, 20);
  assert.equal(g.ceiling < g.floor, true);
});

test("الضمان مابينزلش تحت رسم الشريحة اللي بعدها (السلّم ما ينقلبش)", () => {
  // سلة ٤٠: السقف ١٢، لكن شريحة الـ٦٠ بتدفع ١٥ — فسلة ٤٠ ما تدفعش أقل من ١٥
  const g = appsGuard({ total: 40, fee: 20, nextTierFee: 15, guard: { enabled: true } });
  assert.equal(g.ceiling, 12);
  assert.equal(g.ladderFloor, 15);
  assert.equal(g.fee, 20);                     // مفيش قص جزئي
  assert.equal(g.capped, true);
  assert.equal(feeAt(ON, 40).fee, 20);
});

test("المقارنة بقت بين إجماليين: أكلنا + توصيلنا ضد أكلهم المرفوع + توصيلهم", () => {
  const g = appsGuard({ total: 51, fee: 20, nextTierFee: 15, guard: { enabled: true } });
  assert.equal(g.appTotal, 67.83);             // 51 × 1.33 + 0
  assert.equal(g.fee, 15);
  assert.equal(g.ourTotal, 66);                // 51 + 15
  assert.equal(g.cheaperBy >= 1, true);        // الهامش المطلوب اتحقق فعلاً
});

test("رسم توصيل التطبيق **افتراض** قابل للتعديل، وافتراضه صفر (أسوأ حالة لنا)", () => {
  assert.equal(APPS_GUARD_DEFAULTS.appDeliveryFee, 0);
  const tight = appsGuard({ total: 45, fee: 20, nextTierFee: 15, guard: { enabled: true } });
  const loose = appsGuard({ total: 45, fee: 20, nextTierFee: 15, guard: { enabled: true, appDeliveryFee: 6 } });
  assert.equal(tight.ceiling, 13);             // 45×0.33 − 1
  assert.equal(loose.ceiling, 19);             // + ٦ ر.س توصيل التطبيق
  assert.equal(tight.fee, 20);                 // السقف تحت الأرضية → مفيش قص
  assert.equal(loose.fee, 19);                 // بقى فوق الأرضية → القص اشتغل
});

test("الضمان بيقص فعلاً في المدى اللي ينفع فيه (٤٨٫٥ → ٦٠)", () => {
  assert.equal(feeAt(ON, 51).fee, 15);
  assert.equal(feeAt(ON, 55).fee, 17);
  assert.equal(feeAt(ON, 59).fee, 18);
  // وكلهم لسه فوق أرضية كيتا (٢٤٫٥٪ مساهمة)
  for (const t of [51, 55, 59]) {
    const f = feeAt(ON, t).fee;
    assert.equal(net(t, f) / t > BENCHMARKS.keetaNet, true, `${t} → ${f} → ${net(t, f)}`);
  }
});

test("فوق ٦٠ السلّم لوحده أرخص من التطبيقات — الضمان ما بيلمسش حاجة", () => {
  for (const [total, expected] of [[60, 15], [80, 10], [96, 10], [120, 5], [150, 0], [200, 0]]) {
    const r = feeAt(ON, total);
    assert.equal(r.fee, expected, `سلة ${total}`);
    assert.equal(r.guard.applied, false);
    assert.equal(r.guard.capped, false);
    assert.equal(r.guard.reason, "already_cheaper");
  }
});

test("الضمان سقف مش أرضية: عمره ما بيرفع رسم", () => {
  for (const total of [1, 20, 40, 60, 96, 150]) {
    assert.equal(feeAt(ON, total).fee <= feeAt(LADDER, total).fee, true, `سلة ${total}`);
  }
});

test("الضمان مقفول (السياسة الحية) = السلّم زي ما هو بالظبط", () => {
  const OFF = { ...LADDER, neverBeatenByApps: { enabled: false, appMarkupPct: 33, minCheaperBy: 1 } };
  for (const [total, expected] of [[1, 20], [20, 20], [40, 20], [51, 20], [60, 15], [80, 10], [100, 5], [150, 0]]) {
    assert.equal(feeAt(OFF, total).fee, expected, `سلة ${total}`);
    assert.equal(feeAt(OFF, total).guard.reason, "disabled");
  }
});

test("من غير سلّم: أرضية عدم الخسارة لوحدها بتمسك السلة الصغيرة", () => {
  const NO_LADDER = { ...CFG, neverBeatenByApps: { enabled: true, appMarkupPct: 33, minCheaperBy: 1 } };
  const r = computeDeliveryFee(NO_LADDER, { distanceKm: 2, orderTotal: 5 });
  assert.equal(r.fee, 10);                     // baseFee زي ما هو — السقف تحت الأرضية
  assert.equal(r.guard.ladderFloor, 0);
  assert.equal(r.guard.capped, true);
});

test("لما الضمان يعجز، الرد بيقول الفرق — عشان الواجهة تنده مش عشان تكدب", () => {
  const r = feeAt(ON, 20);
  assert.equal(r.guard.capped, true);
  assert.equal(r.guard.shortfall, 14.4);       // 40 − 26.6 + 1
  // ومفيش سطر في الـbreakdown بيقول للعميل إن التطبيق أرخص
  assert.equal(r.breakdown.some((l) => l.includes("التطبيقات")), false);
});

test("افتراضات الضمان مربوطة بمرجع واحد مش مكتوبة مرتين", () => {
  assert.equal(APPS_GUARD_DEFAULTS.contributionPct, BENCHMARKS.dineInContribution);
  assert.equal(APPS_GUARD_DEFAULTS.enabled, false);   // الافتراضي مقفول
  assert.equal(APPS_GUARD_DEFAULTS.courierCost, 19.55);
});
