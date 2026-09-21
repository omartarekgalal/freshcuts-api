import test from "node:test";
import assert from "node:assert/strict";
import { elapsedShare, paceVerdict, FALLBACK_CURVE, BIZ_HOURS } from "./adsefficiency.js";

test("BIZ_HOURS يبدأ ٤ الصبح وينتهي ٣ الفجر", () => {
  assert.equal(BIZ_HOURS[0], 4);
  assert.equal(BIZ_HOURS[23], 3);
  assert.equal(BIZ_HOURS.length, 24);
});

test("elapsedShare = صفر قبل الفتح و١ آخر اليوم", () => {
  assert.equal(elapsedShare(FALLBACK_CURVE, 0, 0), 0);           // ٤ الصبح
  assert.equal(elapsedShare(FALLBACK_CURVE, 23, 60), 1);          // ٣ الفجر
});

test("elapsedShare بيوزن المساء أكتر من الظهر", () => {
  const at15 = elapsedShare(FALLBACK_CURVE, BIZ_HOURS.indexOf(15), 60); // خلصت ٣ العصر
  const at21 = elapsedShare(FALLBACK_CURVE, BIZ_HOURS.indexOf(21), 60); // خلصت ٩ بالليل
  assert.ok(at15 < 0.25, `٣ العصر لازم تكون شوية من اليوم، طلعت ${at15}`);
  assert.ok(at21 > 0.65 && at21 < 0.95, `٩ بالليل المفروض معظم اليوم، طلعت ${at21}`);
});

test("elapsedShare بيقع على المنحنى الافتراضي لو المنحنى فاضي", () => {
  assert.equal(elapsedShare([], 10, 0), elapsedShare(FALLBACK_CURVE, 10, 0));
  assert.equal(elapsedShare(new Array(24).fill(0), 10, 0), elapsedShare(FALLBACK_CURVE, 10, 0));
});

test("paceVerdict: في الهدف", () => {
  const v = paceVerdict({ spend: 150, revenue: 1000, target: 0.15, share: 0.3 });
  assert.equal(v.status, "ok");
  assert.equal(v.ratio, 0.15);
  assert.equal(v.projected.revenue, 3333.33);
});

test("paceVerdict: فوق الهدف بيطلع over ومساحة سالبة", () => {
  const v = paceVerdict({ spend: 400, revenue: 1000, target: 0.15, share: 0.4 });
  assert.equal(v.status, "over");
  assert.ok(v.headroom < 0);
  assert.equal(v.allowedSpendNow, 150);
});

test("paceVerdict: تحت الهدف بيطلع under ومساحة موجبة", () => {
  const v = paceVerdict({ spend: 80, revenue: 1000, target: 0.15, share: 0.5 });
  assert.equal(v.status, "under");
  assert.equal(v.headroom, 70);
});

test("paceVerdict: صرف من غير دخل مش بيقسم على صفر", () => {
  const v = paceVerdict({ spend: 120, revenue: 0, target: 0.15, share: 0.2 });
  assert.equal(v.status, "no_revenue");
  assert.equal(v.ratio, null);
  assert.equal(v.projected.revenue, 0);
});

test("paceVerdict: يوم لسه مابدأش", () => {
  const v = paceVerdict({ spend: 0, revenue: 0, target: 0.15, share: 0.01 });
  assert.equal(v.status, "idle");
});

test("paceVerdict: الدخل المطلوب عشان النسبة تطلع صح", () => {
  const v = paceVerdict({ spend: 300, revenue: 1200, target: 0.15, share: 0.4 });
  // الصرف المتوقع آخر اليوم = 300/0.4 = 750 ← الدخل المطلوب = 750/0.15 = 5000
  assert.equal(v.projected.spend, 750);
  assert.equal(v.revenueNeededForTarget, 5000);
});
