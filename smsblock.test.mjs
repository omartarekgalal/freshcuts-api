/* حاجبين الإعلانات — الاختبارات (٢٥/٩)

   الغلطتين اللي بتكلّف: نحجب عميل بيستقبل عادي (نخسر فرصة)، أو مانحجبش
   اللي حاجب (ندفع على رسالة مش هتوصل). والقاعدة: صفر «وصلت» + فشل ≥ الحد. */
import test from "node:test";
import assert from "node:assert/strict";
import { pnOf, tally, decide, cfgOf, DEFAULTS } from "./smsblock.js";
import { filterAudience } from "./smsrules.js";

const R = (number, status, sender = "FreshCut-AD", at = "2026-09-24 21:39") => ({ number, status, sender, at });

test("الجوال بيتوحّد مهما كان شكله", () => {
  for (const v of ["966570735091", "+966570735091", "0570735091", "570735091", "00966570735091"]) {
    assert.equal(pnOf(v), "570735091", v);
  }
  for (const v of ["", null, "12345", "966412345678", "abc"]) assert.equal(pnOf(v), null, String(v));
});

test("حاجب فعلاً: فشل ومفيش ولا مرة وصلت", () => {
  const per = tally([R("966570735091", "Not Delivered"), R("966570735091", "Not Delivered")]);
  const { block, clear } = decide(per, DEFAULTS);
  assert.equal(block.length, 1);
  assert.equal(block[0].fail, 2);
  assert.equal(clear.length, 0);
});

test("وصله مرة وفشل مرة = مش حاجب (غالباً الجهاز كان مقفول)", () => {
  const per = tally([R("966500000001", "Not Delivered"), R("966500000001", "Delivered")]);
  const { block, clear } = decide(per, DEFAULTS);
  assert.equal(block.length, 0);
  assert.equal(clear.length, 1, "بيتشال من القايمة لو كان فيها");
});

test("الخدمي مابيتحسبش — FreshCut بيوصل للمحجوب عادي", () => {
  const per = tally([R("966570735091", "Not Delivered", "FreshCut"), R("966570735091", "Delivered", "FreshCut")]);
  assert.equal(per.size, 0, "مفيش حكم على الدعائي من رسايل خدمية");
});

test("«Sent» يعني لسه مافيش تقرير — مانحكمش", () => {
  const per = tally([R("966570735091", "Sent")]);
  assert.equal(per.size, 0);
});

test("اسم المرسِل مش حساس لحالة الحروف", () => {
  const per = tally([R("966570735091", "Not Delivered", "freshcut-ad")]);
  assert.equal(per.size, 1);
});

test("minFails بيتحكم في الحساسية", () => {
  const per = tally([R("966570735091", "Not Delivered")]);
  assert.equal(decide(per, { ...DEFAULTS, minFails: 1 }).block.length, 1);
  assert.equal(decide(per, { ...DEFAULTS, minFails: 2 }).block.length, 0);
});

test("الإعدادات: الافتراضي شغّال وبحدود معقولة", () => {
  assert.equal(cfgOf({}).enabled, true);
  assert.equal(cfgOf({ sms: { adBlock: { enabled: false } } }).enabled, false);
  assert.equal(cfgOf({ sms: { adBlock: { minFails: 999 } } }).minFails, 10);
  assert.equal(cfgOf({ sms: { adBlock: { minFails: -3 } } }).minFails, 1);
  assert.deepEqual(cfgOf({ sms: { adBlock: { adSenders: [] } } }).adSenders, DEFAULTS.adSenders);
});

test("مدخل باظ مابيرميش", () => {
  assert.equal(tally(null).size, 0);
  assert.equal(tally([null, {}, R("", "Not Delivered")]).size, 0);
  assert.deepEqual(decide(new Map(), DEFAULTS), { block: [], clear: [] });
});

/* ═══ الفلتر نفسه ═══ */
const M = (pn) => ({ pn, direct: true, web_orders: 1, pos_orders: 1 });

test("الفلتر بيشيل الحاجب ويعدّه", () => {
  const f = filterAudience([M("570735091"), M("500000001")], {
    adBlocked: new Set(["570735091"]), allowApps: true });
  assert.deepEqual(f.list.map((x) => x.pn), ["500000001"]);
  assert.equal(f.excluded.ad_blocked, 1);
});

test("من غير قايمة حجب الفلتر شغّال زي الأول", () => {
  const f = filterAudience([M("570735091")], { allowApps: true });
  assert.equal(f.list.length, 1);
  assert.equal(f.excluded.ad_blocked, 0);
});

test("إلغاء الاشتراك بيتحسب قبل الحجب (سببين = يتعدّ مرة)", () => {
  const f = filterAudience([M("570735091")], {
    optedOut: new Set(["570735091"]), adBlocked: new Set(["570735091"]), allowApps: true });
  assert.equal(f.excluded.opted_out, 1);
  assert.equal(f.excluded.ad_blocked, 0);
});
