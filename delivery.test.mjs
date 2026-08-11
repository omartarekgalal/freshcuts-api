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
