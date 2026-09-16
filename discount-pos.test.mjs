/* الخصم لازم يوصل نقطة البيع — 16 سبتمبر 2026 (خصومات ٥٠٪ لأرقام معيّنة).
     node --test discount-pos.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { partnerItemsOf } from "./shop.js";
import * as tsstore from "./tsstore.js";

const M = tsstore.MULTIPLY;
const line = (productId, qty, net) => ({ product_id: productId, quantity: qty, unit_amount: Math.round(net * M) });

test("من غير خصم: الأسعار زي ما هي ومفيش ملاحظة", () => {
  const out = partnerItemsOf({ discount_percent: 0, items: [line(1, 3, 26.08695652)] });
  assert.equal(out[0].unitPrice, 26.08695652);
  assert.equal(out[0].lineNote, undefined);
});

test("خصم ٥٠٪: سعر السطر نص السعر، ومفيش ملاحظة تحت الصنف (الخصم في ملاحظات الطلب)", () => {
  const out = partnerItemsOf({ discount_percent: 50, items: [line(1, 3, 26.08695652), line(3, 1, 25.2173913)] });
  assert.ok(Math.abs(out[0].unitPrice - 13.04347826) < 1e-6);
  assert.ok(Math.abs(out[1].unitPrice - 12.60869565) < 1e-6);
  assert.equal(out[0].lineNote, undefined);
  // الإجمالي شامل الضريبة = نص طلب W1789555412320 (119 ر.س أكل) ⇒ 59.5
  const total = out.reduce((a, x) => a + x.unitPrice * x.quantity, 0) * 1.15;
  assert.ok(Math.abs(total - 59.5) < 0.01, `total ${total}`);
});

test("الباقات مابيتخصمش عليها (سعرها محسوب أصلاً)", () => {
  const bundleLine = { ...line(48, 1, 30), bundle: "national96-box", bundle_name: "بوكس ٩٦" };
  const out = partnerItemsOf({ discount_percent: 50, items: [bundleLine, line(1, 1, 20)] });
  assert.equal(out[0].unitPrice, 30);
  assert.equal(out[0].lineNote, undefined); // مفيش «ضمن: …» في تذكرة المطبخ
  assert.equal(out[1].unitPrice, 10);
});

test("ملاحظة العميل نفسه على الصنف بتوصل المطبخ زي ما هي", () => {
  const out = partnerItemsOf({ discount_percent: 50, items: [{ ...line(1, 1, 20), note: "من غير بصل", bundle: "national96-box" }] });
  assert.equal(out[0].lineNote, "من غير بصل");
});

test("نسب غريبة بتتقفل بين ٠ و١٠٠", () => {
  assert.equal(partnerItemsOf({ discount_percent: 150, items: [line(1, 1, 20)] })[0].unitPrice, 0);
  assert.equal(partnerItemsOf({ discount_percent: -5, items: [line(1, 1, 20)] })[0].unitPrice, 20);
});
