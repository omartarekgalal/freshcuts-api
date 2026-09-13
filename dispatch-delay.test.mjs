/* مهلة طلب المندوب — قرار عمر 13 سبتمبر 2026: الكابتن يتطلب بعد «جاهز» أو
   بعد مهلة التحضير من القبول، أيهما أسبق. والمهلة مش «تأخير» في الإنذارات.
     node --test dispatch-delay.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchDue, dispatchDelayOf, DEFAULT_DISPATCH_DELAY_MIN } from "./delivery.js";
import { slaCheck } from "./shop.js";

const T0 = Date.parse("2026-09-13T12:00:00Z");
const min = (m) => T0 + m * 60000;

test("جاهز = نطلب فوراً حتى لو المهلة لسه", () => {
  assert.deepEqual(dispatchDue({ delayMin: 15, acceptedAt: T0, readyAt: min(3), now: min(3) }), { due: true, reason: "ready" });
});
test("مهلة صفر = الطريقة القديمة (مع القبول)", () => {
  assert.equal(dispatchDue({ delayMin: 0, acceptedAt: T0, readyAt: null, now: T0 }).due, true);
});
test("قبل المهلة ومش جاهز = نستنى", () => {
  const v = dispatchDue({ delayMin: 15, acceptedAt: new Date(T0).toISOString(), readyAt: null, now: min(10) });
  assert.equal(v.due, false);
  assert.equal(v.leftMin, 5);
});
test("عدّت المهلة ومش جاهز = نطلب (احتياطي لو الكاشير نسي)", () => {
  assert.deepEqual(dispatchDue({ delayMin: 15, acceptedAt: T0, readyAt: null, now: min(15) }), { due: true, reason: "timeout" });
});
test("وقت القبول مجهول = ما نحبسش الطلب", () => {
  assert.equal(dispatchDue({ delayMin: 15, acceptedAt: null, readyAt: null, now: T0 }).due, true);
});
test("إعداد المهلة: الافتراضي 15، الصفر مسموح، الغلط يرجع للافتراضي، والسقف 90", () => {
  assert.equal(DEFAULT_DISPATCH_DELAY_MIN, 15);
  assert.equal(dispatchDelayOf({}), 15);
  assert.equal(dispatchDelayOf({ delivery: { dispatchDelayMin: 0 } }), 0);
  assert.equal(dispatchDelayOf({ delivery: { dispatchDelayMin: "20" } }), 20);
  assert.equal(dispatchDelayOf({ delivery: { dispatchDelayMin: "abc" } }), 15);
  assert.equal(dispatchDelayOf({ delivery: { dispatchDelayMin: -3 } }), 15);
  assert.equal(dispatchDelayOf({ delivery: { dispatchDelayMin: 500 } }), 90);
});

const acc = (inStatusMin, extra = {}) => ({
  status: "accepted", option: "delivery",
  created_at: new Date(min(-inStatusMin - 1)).toISOString(),
  updated_at: new Date(min(-inStatusMin)).toISOString(), ...extra,
});
test("الإنذار: 12 دقيقة من القبول جوّه مهلة 15 = مفيش إنذار", () => {
  assert.equal(slaCheck(acc(12), { dispatchDelayMin: 15 }, T0).level, 0);
});
test("الإنذار: من غير مهلة (يدوي) 12 دقيقة = إنذار أول زي الأول", () => {
  assert.equal(slaCheck(acc(12), {}, T0).level, 1);
});
test("الإنذار: جاهز ومحدش طلب كابتن 12 دقيقة = إنذار أول (المهلة مابتتحسبش)", () => {
  assert.equal(slaCheck(acc(12, { pos_ready_at: new Date(min(-12)).toISOString() }), { dispatchDelayMin: 15 }, T0).level, 1);
});
test("الإنذار: 36 دقيقة ومفيش كابتن مع مهلة 15 = تصعيد", () => {
  assert.equal(slaCheck(acc(36), { dispatchDelayMin: 15 }, T0).level, 2);
});
