/* إضافات المتجر — الاختبارات اللي بتمسك الغلطات اللي بتكلّف فلوس (٢٥/٩)

   أخطر حاجتين هنا:
   ١) **السعر**: لو المتصفح قدر يحدّده، حد ياخد حشو موزاريلا (٥ ر.س) بصفر.
      فالسعر بيتحسب من كتالوج الشريك بس.
   ٢) **الوحدات**: مسار الشريك بالهللات ومسار المتجر بجزء من مليون، ومسار
      المتجر بيرفض فرق قرش واحد. تقريب السعر بدري = «unit_amount and system
      price must match» والعميل مايقدرش يدفع. */
import test from "node:test";
import assert from "node:assert/strict";
import { menuIdOf, buildCatalog, resolveChoice, cfgOf, linesFor, DEFAULTS } from "./modifiers.js";

/* عيّنة حقيقية من الإنتاج (٢٥/٩) — الأسعار قبل الضريبة زي ما الشريك بيرجّعها */
const GROUP = {
  id: "74lo3Y8dXQ", name: "حشو اطراف", local_name: "Stuffed Crust", min: 0, max: 3,
  options: [
    { id: "74lo3Y8dXQ", tenant_modifier_option_id: "freshcuts-15", name: "بدون حشو اطراف", price: 0 },
    { id: "xeZOAWg6Eb", tenant_modifier_option_id: "freshcuts-16", name: "حشو اطراف كيري", price: 2.608695652173913 },
    { id: "7PpoE783lN", tenant_modifier_option_id: "freshcuts-17", name: "حشو اطراف موزاريلا", price: 4.347826086956522 },
  ],
};
const PIZZA = { tenant_product_id: "freshcuts-40", name: "بيتزا بيبروني", modifiers: [GROUP] };
const REQUIRED = { tenant_product_id: "freshcuts-36", name: "بيتزا تشيكن",
  modifiers: [{ ...GROUP, min: 1, max: 1 }] };
const BURGER = { tenant_product_id: "freshcuts-90", name: "برجر", modifiers: [] };

const catOf = (prods, cfg = DEFAULTS) => buildCatalog(prods, cfg);
const groupsOf = (prod, cfg = DEFAULTS) => catOf([prod], cfg)[menuIdOf(prod.tenant_product_id)];

test("رقم المنيو بيتقرا من tenant_product_id", () => {
  assert.equal(menuIdOf("freshcuts-40"), "40");
  assert.equal(menuIdOf("freshcuts-7"), "7");
});

test("شكل غريب = null، مش تخمين", () => {
  for (const v of [null, "", "freshcuts", "40", "freshcuts-", "freshcuts-40-x", undefined]) {
    assert.equal(menuIdOf(v), null, `${v} المفروض null`);
  }
});

test("السعر الخام بيتحفظ زي ما هو — التقريب بيكسر حساب المتجر", () => {
  const opts = groupsOf(PIZZA)[0].options;
  const kiri = opts.find((o) => /كيري/.test(o.name));
  assert.equal(kiri.sar, 2.608695652173913, "مش مقرّب");
  assert.equal(kiri.shown, 3, "اللي العميل يشوفه = بالضريبة");
  assert.equal(kiri.id, 16, "الرقم الخام من tenant_modifier_option_id");
  assert.equal(opts.find((o) => /موزاريلا/.test(o.name)).shown, 5);
  assert.equal(opts.find((o) => /بدون/.test(o.name)).shown, 0);
});

test("الوحدات: الشريك هللات والمتجر جزء من مليون", () => {
  const { lines } = resolveChoice(groupsOf(PIZZA), [16]);
  assert.deepEqual(linesFor(lines, 100), [{ id: 16, quantity: 1, unit_amount: 261 }]);
  /* ٢٬٦٠٨٬٦٩٦ مش ٢٬٦١٠٬٠٠٠ — الفرق ده هو اللي المتجر بيرفض عليه */
  assert.deepEqual(linesFor(lines, 1e6), [{ id: 16, quantity: 1, unit_amount: 2608696 }]);
});

test("صنف من غير إضافات مابيظهرش خالص", () => {
  const cat = catOf([PIZZA, BURGER]);
  assert.ok(cat["40"]);
  assert.equal(cat["90"], undefined);
});

test("onlyItemIds بتقفل على البيتزا بس", () => {
  assert.deepEqual(Object.keys(catOf([PIZZA, REQUIRED], { ...DEFAULTS, onlyItemIds: ["40"] })), ["40"]);
});

test("hiddenGroupIds بتشيل مجموعة من المتجر", () => {
  assert.equal(catOf([PIZZA], { ...DEFAULTS, hiddenGroupIds: ["74lo3Y8dXQ"] })["40"], undefined);
});

test("hideZeroOption بتشيل «بدون» لما الاختيار إجباري بس", () => {
  const req = groupsOf(REQUIRED, { ...DEFAULTS, hideZeroOption: true })[0];
  assert.ok(!req.options.some((o) => /بدون/.test(o.name)));
  // min=0 ⇒ «بدون» هي الافتراضي، فبتفضل
  const opt = groupsOf(PIZZA, { ...DEFAULTS, hideZeroOption: true })[0];
  assert.ok(opt.options.some((o) => /بدون/.test(o.name)));
});

/* ═══ السعر ═══ */
test("السعر بييجي من الكتالوج مهما العميل بعت", () => {
  const r = resolveChoice(groupsOf(PIZZA), [17]);
  assert.equal(r.ok, true);
  assert.equal(r.sar, 4.347826086956522);
  assert.equal(r.shown, 5);
  assert.deepEqual(linesFor(r.lines, 100), [{ id: 17, quantity: 1, unit_amount: 435 }]);
});

test("id مش موجود بيترفض — مابيعديش بصفر", () => {
  const r = resolveChoice(groupsOf(PIZZA), [999]);
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown_modifier");
});

test("نص أو رقم — نفس الاختيار", () => {
  assert.equal(resolveChoice(groupsOf(PIZZA), ["16"]).shown, 3);
  assert.equal(resolveChoice(groupsOf(PIZZA), [16]).shown, 3);
});

test("اختيار لصنف مالوش إضافات بيترفض", () => {
  const r = resolveChoice([], [16]);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_modifiers_for_item");
});

test("صنف مالوش إضافات ومحدش اختار = عادي", () => {
  assert.deepEqual(resolveChoice([], []), { ok: true, lines: [], sar: 0, shown: 0, labels: [] });
});

test("min بيتطبّق — اختيار إجباري ماتساقش", () => {
  const g = groupsOf(REQUIRED);
  assert.equal(resolveChoice(g, []).error, "modifier_required");
  assert.equal(resolveChoice(g, [15]).ok, true, "«بدون» اختيار صالح");
});

test("max بيتطبّق — مايتاخدش اتنين حشو في مجموعة max=1", () => {
  const r = resolveChoice(groupsOf(REQUIRED), [16, 17]);
  assert.equal(r.ok, false);
  assert.equal(r.error, "modifier_too_many");
});

test("اتنين في مجموعة max=3 بيعدّوا ويتجمعوا", () => {
  const r = resolveChoice(groupsOf(PIZZA), [16, 17]);
  assert.equal(r.ok, true);
  assert.equal(r.shown, 8, "٣ + ٥");
  assert.equal(r.lines.length, 2);
});

test("التكرار مابيتحسبش مرتين", () => {
  const r = resolveChoice(groupsOf(PIZZA), [16, 16]);
  assert.equal(r.ok, true);
  assert.equal(r.shown, 3, "نفس الاختيار مرتين = مرة واحدة");
  assert.equal(r.lines.length, 1);
});

test("مدخل باظ مابيرميش", () => {
  const g = groupsOf(PIZZA);
  for (const v of [null, undefined, "نص", {}, 5]) {
    const r = resolveChoice(g, v);
    assert.equal(r.ok, true, `${JSON.stringify(v)} المفروض تتعامل كـ«مفيش اختيار»`);
    assert.equal(r.sar, 0);
  }
  assert.deepEqual(buildCatalog(null, DEFAULTS), {});
  assert.deepEqual(buildCatalog([{ tenant_product_id: "freshcuts-1" }], DEFAULTS), {});
  assert.deepEqual(linesFor(null, 100), []);
});

/* ═══ الإعدادات ═══ */
test("الافتراضي مقفول — مايتفتحش لوحده", () => {
  assert.equal(cfgOf({}).enabled, false);
  assert.equal(cfgOf(null).enabled, false);
  assert.equal(cfgOf({ shop: { modifiers: { enabled: true } } }).enabled, true);
});

test("الإعدادات بتتقرا من shop.modifiers والجذر", () => {
  assert.equal(cfgOf({ shop: { modifiers: { cacheMinutes: 30 } } }).cacheMinutes, 30);
  assert.equal(cfgOf({ modifiers: { cacheMinutes: 30 } }).cacheMinutes, 30);
});

test("أرقام الإعدادات بتتحبس في حدود معقولة", () => {
  assert.equal(cfgOf({ modifiers: { cacheMinutes: 9999 } }).cacheMinutes, 120);
  assert.equal(cfgOf({ modifiers: { cacheMinutes: 0 } }).cacheMinutes, DEFAULTS.cacheMinutes);
  assert.equal(cfgOf({ modifiers: { cacheMinutes: -5 } }).cacheMinutes, 1);
  assert.deepEqual(cfgOf({ modifiers: { onlyItemIds: [40, 41] } }).onlyItemIds, ["40", "41"]);
  assert.deepEqual(cfgOf({ modifiers: { onlyItemIds: "مش قايمة" } }).onlyItemIds, []);
});

/* ═══ قواعد المجموعة من اللوحة (٢٥/٩ — طلب عمر) ═══════════════════════════
   تاب سينس بيدّي نفس المجموعة بقواعد مختلفة من صنف لصنف (حشو الأطراف
   min0/max3 على بيتزا و min1/max1 على تانية). اللي العميل يشوفه لازم
   يبقى قاعدة واحدة، فاللوحة بتغلب. */
const RULES = (r) => ({ ...DEFAULTS, groupRules: { "74lo3Y8dXQ": r } });

test("اختيار واحد بس بيغلب max بتاع نقطة البيع", () => {
  const g = buildCatalog([PIZZA], RULES({ mode: "single" }))["40"][0];
  assert.equal(g.max, 1, "كان ٣ عند تاب سينس");
  assert.equal(resolveChoice([g], [16, 17]).error, "modifier_too_many");
});

test("متعدد بيفتح مجموعة تاب سينس قافلها على واحد", () => {
  const g = buildCatalog([REQUIRED], RULES({ mode: "multi" }))["36"][0];
  assert.ok(g.max >= 2);
  assert.equal(resolveChoice([g], [16, 17]).ok, true);
});

test("مطلوب/اختياري بيتغيّروا من اللوحة", () => {
  const req = buildCatalog([PIZZA], RULES({ required: true }))["40"][0];
  assert.equal(req.min, 1);
  assert.equal(resolveChoice([req], []).error, "modifier_required");
  const opt = buildCatalog([REQUIRED], RULES({ required: false }))["36"][0];
  assert.equal(opt.min, 0);
  assert.equal(resolveChoice([opt], []).ok, true);
});

test("الافتراضي بييجي من اللوحة", () => {
  assert.equal(buildCatalog([PIZZA], RULES({ default: 16 }))["40"][0].defaultId, 16);
  assert.equal(buildCatalog([PIZZA], RULES({ default: "17" }))["40"][0].defaultId, 17);
});

test("افتراضي مش موجود مابيتعلّمش عليه", () => {
  // اختياري + افتراضي غلط ⇒ مفيش افتراضي أصلاً
  assert.equal(buildCatalog([PIZZA], RULES({ default: 999 }))["40"][0].defaultId, null);
  // إجباري + افتراضي غلط ⇒ بنرجع لأرخص خيار عشان الشاشة ماتفضلش فاضية
  assert.equal(buildCatalog([REQUIRED], RULES({ default: 999 }))["36"][0].defaultId, 15);
});

test("افتراضي متخبّي مايتعلّمش عليه", () => {
  /* «بدون» متخبّية (hideZeroOption) ⇒ الافتراضي لازم يبقى خيار معروض،
     وإلا الشاشة تعلّم على حاجة العميل مش شايفها. */
  const g = buildCatalog([REQUIRED], { ...DEFAULTS, hideZeroOption: true,
    groupRules: { "74lo3Y8dXQ": { default: 15 } } })["36"][0];
  assert.ok(!g.options.some((o) => o.id === 15));
  assert.equal(g.defaultId, 16, "أرخص خيار معروض");
});

test("مفيش قاعدة = اللي نقطة البيع قالته", () => {
  const g = buildCatalog([PIZZA], DEFAULTS)["40"][0];
  assert.equal(g.min, 0);
  assert.equal(g.max, 3);
});

test("min مايعديش max بعد القواعد", () => {
  const g = buildCatalog([PIZZA], RULES({ mode: "single", required: true }))["40"][0];
  assert.equal(g.max, 1);
  assert.equal(g.min, 1);
});

test("groupRules باظة مابترميش", () => {
  for (const v of [null, "نص", [], 5]) {
    assert.deepEqual(cfgOf({ modifiers: { groupRules: v } }).groupRules, {});
  }
});
