import test from "node:test";
import assert from "node:assert/strict";
import { hourBucket, monthPhase, confidenceOf, shrinkWeight, recencyWeight, mergeCfg, DEFAULTS } from "./adspacing.js";

test("hourBucket: الذروة بتلف حوالين نص الليل", () => {
  for (const h of [18, 19, 22, 23, 0, 1]) assert.equal(hourBucket(h), "peak", `الساعة ${h}`);
  for (const h of [12, 13, 15, 17]) assert.equal(hourBucket(h), "offpeak", `الساعة ${h}`);
  for (const h of [2, 3, 5, 9, 11]) assert.equal(hourBucket(h), "late", `الساعة ${h}`);
});

test("hourBucket: حدود قابلة للتعديل", () => {
  const cfg = { ...DEFAULTS, peakFromHour: 20, peakToHour: 2, offpeakFromHour: 11 };
  assert.equal(hourBucket(19, cfg), "offpeak");
  assert.equal(hourBucket(20, cfg), "peak");
  assert.equal(hourBucket(2, cfg), "peak");
  assert.equal(hourBucket(3, cfg), "late");
  assert.equal(hourBucket(11, cfg), "offpeak");
});

test("monthPhase: نافذة الرواتب ٢٧ ← ٥ بتعدّي الشهر", () => {
  assert.equal(monthPhase("2026-09-27"), "salary");
  assert.equal(monthPhase("2026-09-30"), "salary");
  assert.equal(monthPhase("2026-10-01"), "salary");
  assert.equal(monthPhase("2026-10-05"), "salary");
  assert.equal(monthPhase("2026-10-06"), "mid");
  assert.equal(monthPhase("2026-09-21"), "mid");
});

test("confidenceOf: بتقول بصراحة لما العيّنة صغيرة", () => {
  assert.equal(confidenceOf(0).level, "none");
  assert.equal(confidenceOf(0).trust, false);
  assert.equal(confidenceOf(2, 500, 30).level, "tiny");
  assert.equal(confidenceOf(2, 500, 30).trust, false);
  assert.equal(confidenceOf(6, 500, 30).level, "low");
  assert.equal(confidenceOf(6, 500, 30).trust, false);
  assert.equal(confidenceOf(20, 500, 30).level, "medium");
  assert.equal(confidenceOf(20, 500, 30).trust, true);
  assert.equal(confidenceOf(40, 500, 30).level, "high");
  // صرف صغير مايرفعش الثقة مهما كان عدد الطلبات
  assert.equal(confidenceOf(40, 10, 30).level, "low");
  // الخطأ النسبي = ١/√n
  assert.equal(confidenceOf(25, 500, 30).rse, 0.2);
});

test("shrinkWeight: عيّنة صغيرة = وزن قريب من ١", () => {
  // ٨ ملاحظات، k=3 → ٧٣٪ من الفرق
  assert.equal(shrinkWeight(1.5, 8, 3, 0.6, 1.8), 1.364);
  // ملاحظة واحدة → الوزن بيتقرّب جامد ناحية ١
  assert.equal(shrinkWeight(1.5, 1, 3, 0.6, 1.8), 1.125);
  // مفيش عيّنة → ١ بالظبط
  assert.equal(shrinkWeight(1.5, 0, 3, 0.6, 1.8), 1);
  // الحدود بتتحترم
  assert.equal(shrinkWeight(9, 50, 3, 0.6, 1.8), 1.8);
  assert.equal(shrinkWeight(0.05, 50, 3, 0.6, 1.8), 0.6);
});

test("recencyWeight: نصف العمر بيشتغل", () => {
  assert.equal(recencyWeight("2026-09-20", "2026-09-20", 21), 1);
  assert.equal(Math.round(recencyWeight("2026-08-30", "2026-09-20", 21) * 1000) / 1000, 0.5);
  assert.ok(recencyWeight("2026-07-01", "2026-09-20", 21) < 0.1);
});

test("mergeCfg: أرقام المالك بتكسب، والسقف الصلب ٣٠٠٠ مايتعداش", () => {
  const c = mergeCfg({ hardCapDaily: 99999, offpeak: { mode: "off" }, overrides: { dates: { "2026-09-21": 1.4 } } });
  assert.equal(c.hardCapDaily, 3000);
  assert.equal(c.offpeak.mode, "off");
  assert.equal(c.offpeak.minShare, DEFAULTS.offpeak.minShare);   // الباقي من الافتراضي
  assert.equal(c.overrides.dates["2026-09-21"], 1.4);
  assert.equal(c.floorDaily, DEFAULTS.floorDaily);
});

test("mergeCfg: تعديل السقف من اللوحة بيتطبّق", () => {
  const c = mergeCfg({ overrides: { hardCapDaily: 1200, floorDaily: 400 } });
  assert.equal(c.hardCapDaily, 1200);
  assert.equal(c.floorDaily, 400);
  // الأرضية مابتعديش السقف
  assert.equal(mergeCfg({ overrides: { hardCapDaily: 300, floorDaily: 900 } }).floorDaily, 300);
});

test("mergeCfg: إعدادات فاضية = الافتراضي", () => {
  const c = mergeCfg(null);
  assert.equal(c.auto, true);
  assert.equal(c.weeks, 8);
  assert.equal(c.hardCapDaily, 3000);
  assert.deepEqual(c.overrides.dates, {});
});
