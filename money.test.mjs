/* وحدة الفلوس — الباج اللي وقف الطلبات ١٧ سبتمبر ٢٠٢٦.
   تاب سينس بترفض أي unit_amount ≥ 1e11، والمتجر بيقول معامل الضرب 1e9، فكل
   صنف سعره الصافي ≥ ١٠٠ ر.س (كل المشاوي بالكيلو) كان بيترفض والسلة تعلّق.
     node --test money.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MULTIPLY, LEGACY_MULTIPLY, TS_UNIT_LIMIT, safeMultiply, scaleOf, netSarOf,
  stampMf, rescaleItems, maxUnitAmount, exceedsTsLimit, isUnitLimitError, nextFactorDown,
} from "./money.js";
import { MULTIPLY as BUNDLES_MULTIPLY, exVatUnits, expandBundle, normalizeSlots } from "./bundles.js";
import * as tsstore from "./tsstore.js";
import { partnerItemsOf } from "./shop.js";

/* الأسعار الحقيقية من قايمة الإنتاج (١٧ سبتمبر) — الصافي قبل الضريبة. */
const KILO = {
  "ريش": 160.86956522, "مشكل مخصوص": 134.7826087, "كباب": 121.73913043,
  "سجق": 104.34782609, "كفتة": 83.47826087, "كبدة": 86.95652174,
};

test("كل الوحدات في المشروع واحدة — الباقات والمتجر ونقطة البيع", () => {
  assert.equal(MULTIPLY, 1000000);
  assert.equal(tsstore.MULTIPLY, MULTIPLY);
  assert.equal(BUNDLES_MULTIPLY, MULTIPLY);
  assert.equal(LEGACY_MULTIPLY, 1000000000);
});

test("كل صنف بالكيلو بيعدّي حد تاب سينس بالوحدة الجديدة — وكان بيترفض بالقديمة", () => {
  for (const [name, net] of Object.entries(KILO)) {
    assert.ok(Math.round(net * MULTIPLY) < TS_UNIT_LIMIT, `${name} كيلو لسه فوق الحد`);
  }
  // الحالة اللي كسرت الإنتاج: نفس الأسعار بالنانو
  const broken = Object.entries(KILO).filter(([, net]) => Math.round(net * LEGACY_MULTIPLY) >= TS_UNIT_LIMIT);
  assert.deepEqual(broken.map(([n]) => n), ["ريش", "مشكل مخصوص", "كباب", "سجق"]);
});

test("سعر ١٦٠٫٨٧ بيرجع زي ما هو لحد الهللة", () => {
  const units = Math.round(KILO["ريش"] * MULTIPLY);
  assert.equal(units, 160869565);
  assert.ok(Math.abs(units / MULTIPLY - KILO["ريش"]) < 1e-6);
  // الإجمالي شامل الضريبة = ١٨٥٫٠٠ بالظبط بعد التقريب لهللتين
  assert.equal(Math.round(units * 1.15 / MULTIPLY * 100) / 100, 185);
});

test("سلة ٣ كيلو (ريش + كباب + مشكل) تحت الحد وإجماليها صح", () => {
  const lines = ["ريش", "كباب", "مشكل مخصوص"].map((k) => ({ unit_amount: Math.round(KILO[k] * MULTIPLY), quantity: 1 }));
  assert.ok(!exceedsTsLimit(lines));
  assert.equal(maxUnitAmount(lines), 160869565);
  const incl = lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0) * 1.15 / MULTIPLY;
  assert.equal(Math.round(incl * 100) / 100, 480); // ١٨٥ + ١٤٠ + ١٥٥
  // حتى ٢٠ كيلو ريش مايوصلوش الحد
  assert.ok(!exceedsTsLimit([{ unit_amount: Math.round(KILO["ريش"] * MULTIPLY), quantity: 20 }]));
});

test("safeMultiply: معامل المتجر مابيتصدّقش لو أكبر من السقف", () => {
  assert.equal(safeMultiply(1000000000), MULTIPLY); // اللي /api/info بيقوله فعلاً
  assert.equal(safeMultiply(100), 100);             // أصغر ⇒ بنمشي وراه
  for (const bad of [null, undefined, 0, -5, "x", NaN]) assert.equal(safeMultiply(bad), MULTIPLY);
});

test("scaleOf: سطر موسوم بوحدته، وسطر قديم من غير وسم = نانو", () => {
  assert.equal(scaleOf({ mf: MULTIPLY }), MULTIPLY);
  assert.equal(scaleOf({}), LEGACY_MULTIPLY);
  assert.equal(scaleOf(null), LEGACY_MULTIPLY);
  assert.equal(netSarOf({ unit_amount: 50 * MULTIPLY, mf: MULTIPLY }), 50);
  assert.equal(netSarOf({ unit_amount: 50 * LEGACY_MULTIPLY }), 50); // طلب قديم
});

test("stampMf بيوسم كل سطر من غير ما يلمس أي حاجة تانية", () => {
  const out = stampMf([{ product_id: 1, unit_amount: 7 }, { bundle: "b96", quantity: 1 }]);
  assert.deepEqual(out[0], { product_id: 1, unit_amount: 7, mf: MULTIPLY });
  assert.deepEqual(out[1], { bundle: "b96", quantity: 1, mf: MULTIPLY });
});

test("rescaleItems: متصفح قديم مكاشّ لسه بيبعت بالنانو بيتحوّل صح", () => {
  const old = [{ product_id: 100, quantity: 1, unit_amount: Math.round(KILO["ريش"] * LEGACY_MULTIPLY) }];
  const now = rescaleItems(old, LEGACY_MULTIPLY);
  assert.equal(now[0].unit_amount, 160869565);
  assert.ok(!exceedsTsLimit(now));
  // مفيش multiply_factor في الجسم ⇒ النانو القديم هو الافتراضي
  assert.deepEqual(rescaleItems(old, undefined), now);
  // نفس الوحدة ⇒ السطور بترجع زي ما هي
  const same = [{ unit_amount: 5 }];
  assert.equal(rescaleItems(same, MULTIPLY)[0], same[0]);
  // سطر باقة (من غير سعر) مابيتلمسش
  assert.deepEqual(rescaleItems([{ bundle: "b96", quantity: 2 }], LEGACY_MULTIPLY), [{ bundle: "b96", quantity: 2 }]);
});

test("حزام الأمان: بنعرف خطأ الحد وبننزل درجة", () => {
  assert.ok(isUnitLimitError("The purchases.0.unit_amount must be less than 100000000000."));
  assert.ok(!isUnitLimitError("The purchases.0.unit_amount and purchases.0.system price must match"));
  assert.ok(!isUnitLimitError(""));
  assert.equal(nextFactorDown(MULTIPLY), 1000);
  assert.equal(nextFactorDown(1000), 100);
  assert.equal(nextFactorDown(100), null); // mf=1 مرفوض من تاب سينس نفسها
});

test("الباقات: ٩٦ و٢٨٨ لسه بالظبط على الوحدة الجديدة", () => {
  assert.equal(exVatUnits(96), 83478261);
  assert.equal(Math.round(exVatUnits(96) * 1.15 / MULTIPLY * 100) / 100, 96);
  assert.equal(Math.round(exVatUnits(288) * 1.15 / MULTIPLY * 100) / 100, 288);
});

test("بوكس ٩٦: التوزيع مضبوط، وكل سطر تحت حد تاب سينس", () => {
  const bundle = {
    slug: "nd96-box", name: "بوكس ٩٦", price: 96,
    slots: normalizeSlots([
      { key: "grill", label: "المشوي", type: "choice", quantity: 1, choices: [{ product_id: "100", variant_option_id: 55 }] },
      { key: "side", label: "الرز", type: "fixed", quantity: 2, product_id: "123" },
    ]),
  };
  const resolve = (pid) => String(pid) === "100"
    ? { name: "ريش كيلو", priceEx: KILO["ريش"], taxId: 1, variantName: "كيلو" }
    : { name: "رز", priceEx: 8.69565217, taxId: 1 };
  const r = expandBundle(bundle, { grill: { product_id: "100", variant_option_id: 55 } }, 1, resolve,
    { lineUid: "fixed-uid" });
  assert.ok(r.ok, r.error);
  const sum = r.lines.reduce((a, l) => a + l.unit_amount * l.quantity, 0);
  assert.equal(Math.round(sum * 1.15 / MULTIPLY * 100) / 100, 96);
  assert.ok(!exceedsTsLimit(r.lines), "سطر باقة فوق حد تاب سينس");
});

test("partnerItemsOf بيقرا القديم والجديد صح (الطلبات اللي اتخزّنت قبل النزلة)", () => {
  const nu = partnerItemsOf({ items: [{ product_id: 100, quantity: 1, unit_amount: Math.round(KILO["ريش"] * MULTIPLY), mf: MULTIPLY }] });
  const old = partnerItemsOf({ items: [{ product_id: 100, quantity: 1, unit_amount: Math.round(KILO["ريش"] * LEGACY_MULTIPLY) }] });
  assert.ok(Math.abs(nu[0].unitPrice - KILO["ريش"]) < 1e-6);
  assert.ok(Math.abs(old[0].unitPrice - KILO["ريش"]) < 1e-6);
});
