import test from "node:test";
import assert from "node:assert/strict";
import {
  normDistrict, districtCandidates, applyMargin, marginCfg, marginLabel,
  districtCfg, findDistrict, districtQuote, districtOfRow, seedDistricts,
  seedConfig, activeDistrictNames, SEED_PRICE_LIST,
} from "./districts.js";
import { computeDeliveryFee, DEFAULT_POLICY } from "./delivery.js";

/* ── تطبيع الاسم ──────────────────────────────────────────────────────── */
test("normDistrict: التشكيل والهمزات والتاء المربوطة كلهم بيروحوا", () => {
  assert.equal(normDistrict("حيّ الفَيْصَليّة"), "الفيصليه");
  assert.equal(normDistrict("الفيصليه"), "الفيصليه");
  assert.equal(normDistrict("الفيصلية"), "الفيصليه");
  assert.equal(normDistrict("  أبحر  الشمالية "), "ابحر الشماليه");
  assert.equal(normDistrict("إبحر الشماليه"), "ابحر الشماليه");
  assert.equal(normDistrict(""), "");
  assert.equal(normDistrict(null), "");
});

test("normDistrict: «حي» في الأول بتتشال، بس «ضاحية» لأ", () => {
  assert.equal(normDistrict("حي الشفاء"), "الشفاء".replace("ء", "ء"));
  assert.equal(normDistrict("حي الشفاء"), normDistrict("الشفاء"));
  assert.equal(normDistrict("ضاحية الجوهرة"), "ضاحيه الجوهره");
});

test("districtCandidates: بيفصل العنوان الكامل لأجزاء", () => {
  const c = districtCandidates("حي الفيصلية، شارع الأمير سلطان، جدة");
  assert.ok(c.includes("الفيصليه"));
  assert.ok(c.length > 1);
});

/* ── قاعدة الهامش ─────────────────────────────────────────────────────── */
test("applyMargin: plus_round (الافتراضي) = (التكلفة + ٥) مقرّبة لأعلى ٥", () => {
  const m = { mode: "plus_round", add: 5, roundTo: 5 };
  assert.equal(applyMargin(15, m), 20);
  assert.equal(applyMargin(30, m), 35);
  assert.equal(applyMargin(40, m), 45);
  assert.equal(applyMargin(22, m), 30);   // 27 → 30
});

test("applyMargin: كل الأوضاع", () => {
  assert.equal(applyMargin(30, { mode: "plus", add: 7, roundTo: 5 }), 37);       // من غير تقريب
  assert.equal(applyMargin(31, { mode: "roundup", add: 9, roundTo: 5 }), 35);    // add متجاهَل
  assert.equal(applyMargin(30, { mode: "none", add: 9, roundTo: 5 }), 30);
  assert.equal(applyMargin(30, { mode: "plus_round", add: 0, roundTo: 5 }), 30); // مضاعف ٥ أصلاً مابيتحركش
});

test("applyMargin: الحد الأدنى والسقف", () => {
  assert.equal(applyMargin(5, { mode: "none", min: 20 }), 20);
  assert.equal(applyMargin(80, { mode: "plus", add: 10, max: 60 }), 60);
  assert.equal(applyMargin(-5, { mode: "none" }), 0);
});

test("applyMargin: ريالات صحيحة دايماً (الرسم بيدخل فاتورة نقطة البيع)", () => {
  assert.equal(applyMargin(17.5, { mode: "plus", add: 2.3, roundTo: 0 }), 20);
  assert.ok(Number.isInteger(applyMargin(33.33, { mode: "plus", add: 1.5 })));
});

test("marginCfg بيرفض وضع مش معروف ويرجع للافتراضي", () => {
  assert.equal(marginCfg({ mode: "magic" }).mode, "plus_round");
  assert.equal(marginCfg(null).add, 5);
  assert.equal(marginCfg({ add: -9 }).add, 0);
});

test("marginLabel بيوصف القاعدة بالعربي", () => {
  assert.match(marginLabel({ mode: "plus_round", add: 5, roundTo: 5 }), /\+ 5/);
  assert.match(marginLabel({ mode: "none" }), /بدون هامش/);
});

/* ── الإعدادات ────────────────────────────────────────────────────────── */
const cfgOf = (over = {}) => districtCfg({
  delivery: {
    districtCouriers: {
      enabled: true,
      margin: { mode: "plus_round", add: 5, roundTo: 5 },
      providers: [{ id: "tlb", name: "طلباتك", phone: "0501234567", active: true }],
      districts: [
        { name: "أبحر الشمالية", price: 40, provider: "tlb", active: true, confirmed: true },
        { name: "بحرة", price: 50, provider: "tlb", active: true, confirmed: true },
        { name: "الفيصلية", price: 20, provider: "tlb", active: false },   // مش مفعّل
        { name: "الوادي", price: null, provider: "tlb", active: true },     // من غير سعر
      ],
      ...over,
    },
  },
});

test("districtCfg بينضّف ويشيل المكرر", () => {
  const c = districtCfg({ delivery: { districtCouriers: {
    districts: [{ name: "الروضة", price: 20 }, { name: "الروضه", price: 99 }],
  } } });
  assert.equal(c.districts.length, 1);
  assert.equal(c.districts[0].price, 20);
  assert.equal(c.enabled, false);           // مقفول ما لم يتكتب صراحةً
  assert.equal(c.districts[0].active, false); // ومفيش حي بيبقى مفعّل بالصدفة
});

test("districtCfg: الجوال بيتنضّف من أي رموز", () => {
  const c = districtCfg({ delivery: { districtCouriers: {
    providers: [{ id: "x", name: "مندوب", phone: "+966 50 123 4567" }],
  } } });
  assert.equal(c.providers[0].phone, "966501234567");
});

/* ── البحث ────────────────────────────────────────────────────────────── */
test("findDistrict: مطابقة تامة على الاسم المطبَّع", () => {
  const c = cfgOf();
  assert.equal(findDistrict(c, "ابحر الشماليه").name, "أبحر الشمالية");
  assert.equal(findDistrict(c, "حي بحرة").name, "بحرة");
  assert.equal(findDistrict(c, "حي بحرة، شارع ٣٠، جدة").name, "بحرة");
  assert.equal(findDistrict(c, "الصفا"), null);
});

test("findDistrict: «يحتوي» بس لما يبقى مرشّح واحد", () => {
  const c = districtCfg({ delivery: { districtCouriers: { enabled: true, districts: [
    { name: "النزلة اليمانية", price: 30, active: true },
    { name: "النزلة الشرقية", price: 30, active: true },
    { name: "بحرة", price: 50, active: true },
  ] } } });
  // «النزلة» لوحدها بتطابق الاتنين → بنرفض بدل ما نخمّن
  assert.equal(findDistrict(c, "النزلة"), null);
  assert.equal(findDistrict(c, "النزلة اليمانية").name, "النزلة اليمانية");
});

/* ── التسعيرة ─────────────────────────────────────────────────────────── */
test("districtQuote: التكلفة + الهامش + المندوب", () => {
  const q = districtQuote(cfgOf(), "أبحر الشمالية");
  assert.equal(q.district, "أبحر الشمالية");
  assert.equal(q.cost, 40);
  assert.equal(q.fee, 45);
  assert.equal(q.margin, 5);
  assert.equal(q.provider.name, "طلباتك");
  assert.equal(q.confirmed, true);
});

test("districtQuote: null لما الميزة مقفولة أو الحي مش مفعّل أو مفيش سعر", () => {
  assert.equal(districtQuote(cfgOf({ enabled: false }), "بحرة"), null);
  assert.equal(districtQuote(cfgOf(), "الفيصلية"), null);   // active:false
  assert.equal(districtQuote(cfgOf(), "الوادي"), null);     // مفيش سعر ولا fallback
  assert.equal(districtQuote(null, "بحرة"), null);
});

test("districtQuote: fallbackPrice بيغطي حي مفعّل من غير سعر", () => {
  const q = districtQuote(cfgOf({ fallbackPrice: 35 }), "الوادي");
  assert.equal(q.cost, 35);
  assert.equal(q.fee, 40);
});

test("activeDistrictNames: المفعّل اللي ليه سعر بس", () => {
  const names = activeDistrictNames(cfgOf());
  assert.deepEqual(names, ["أبحر الشمالية", "بحرة"]);
});

/* ── الدمج مع computeDeliveryFee ──────────────────────────────────────── */
const POLICY = { ...DEFAULT_POLICY, feeByTotal: [{ over: 0, fee: 20 }, { over: 150, fee: 0 }],
  maxKm: 10.5, farZoneEnabled: true, farZoneMaxKm: 15, farZoneFromKm: 10, farZonePerKm: 3 };

test("جوّه النطاق: جدول الأحياء مابيتلمسش خالص", () => {
  const r = computeDeliveryFee(POLICY, { distanceKm: 6, orderTotal: 80, districts: cfgOf(), district: "بحرة" });
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 26);   // ٢٠ من السلّم + ٣ كم × ٢ فوق أول ٣ كم
  assert.equal(r.districtDelivery, undefined);
});

test("المنطقة البعيدة (١٠–١٥ كم) لسه هي الأولوية، مش الحي", () => {
  const r = computeDeliveryFee(POLICY, { distanceKm: 12, orderTotal: 80, farZoneAccepted: true,
    districts: cfgOf(), district: "بحرة" });
  assert.equal(r.deliverable, true);
  assert.ok(r.farZone, "المفروض رسم مسافة إضافية");
  assert.equal(r.districtDelivery, undefined);
});

test("overrideFarZone=true بيخلّي الحي يغلب المنطقة البعيدة", () => {
  const r = computeDeliveryFee(POLICY, { distanceKm: 12, orderTotal: 80, farZoneAccepted: true,
    districts: cfgOf({ overrideFarZone: true }), district: "بحرة" });
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 55);              // 50 + 5
  assert.equal(r.farZone, undefined);
  assert.equal(r.districtDelivery.district, "بحرة");
});

test("فوق سقف المنطقة البعيدة: الحي بيفتح الطلب برسم ثابت", () => {
  const r = computeDeliveryFee(POLICY, { distanceKm: 26, orderTotal: 80, farZoneAccepted: true,
    districts: cfgOf(), district: "أبحر الشمالية" });
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 45);
  assert.equal(r.feeBase, 0, "الرسم كله محمي — مفيش خصم بيلمسه");
  assert.equal(r.districtDelivery.cost, 40);
  assert.match(r.breakdown.join(" "), /توصيل حي أبحر الشمالية — طلباتك/);
});

test("من غير موافقة العميل: رفض + عرض `districtOffer`", () => {
  const r = computeDeliveryFee(POLICY, { distanceKm: 26, orderTotal: 80, districts: cfgOf(), district: "بحرة" });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "out_of_range");
  assert.equal(r.districtOffer.fee, 55);
  assert.equal(r.districtOffer.provider.name, "طلباتك");
  assert.equal(r.farZoneOffer, undefined);
});

test("حي مش في الجدول: «خارج النطاق» زي الأول + قايمة الأحياء المتاحة", () => {
  const r = computeDeliveryFee(POLICY, { distanceKm: 26, orderTotal: 80, farZoneAccepted: true,
    districts: cfgOf(), district: "حي مش موجود" });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "out_of_range");
  assert.equal(r.districtOffer, undefined);
  assert.deepEqual(r.districtChoices, ["أبحر الشمالية", "بحرة"]);
});

test("الجدول مقفول: السلوك القديم بالحرف", () => {
  const off = computeDeliveryFee(POLICY, { distanceKm: 26, orderTotal: 80, farZoneAccepted: true,
    districts: cfgOf({ enabled: false }), district: "بحرة" });
  const none = computeDeliveryFee(POLICY, { distanceKm: 26, orderTotal: 80, farZoneAccepted: true });
  assert.deepEqual(off, none);
  assert.equal(off.deliverable, false);
});

test("بره الدايرة الهوائية بس (مشوار قصير): الحي بيشتغل برضه", () => {
  const p = { ...POLICY, maxStraightKm: 7 };
  const r = computeDeliveryFee(p, { distanceKm: 9, straightKm: 8, orderTotal: 80, farZoneAccepted: true,
    districts: cfgOf(), district: "بحرة" });
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 55);
  assert.equal(r.districtDelivery.district, "بحرة");
});

test("الحد الأدنى للطلب لسه بيتطبّق على طلبات الحي", () => {
  const p = { ...POLICY, minOrderTotal: 50 };
  const r = computeDeliveryFee(p, { distanceKm: 26, orderTotal: 30, farZoneAccepted: true,
    districts: cfgOf(), district: "بحرة" });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "under_minimum");
});

test("«توصيل مجاني فوق ١٥٠» مابيصفّرش رسم الحي", () => {
  const r = computeDeliveryFee(POLICY, { distanceKm: 26, orderTotal: 500, farZoneAccepted: true,
    districts: cfgOf(), district: "بحرة" });
  assert.equal(r.fee, 55, "سلّم الرسوم مابيدخلش على تسعيرة الحي");
});

/* ── قراءة الطلب ──────────────────────────────────────────────────────── */
test("districtOfRow بيقرا من التسعيرة، نص أو كائن", () => {
  const dd = { district: "بحرة", fee: 55, cost: 50 };
  assert.equal(districtOfRow({ delivery_quote: { districtDelivery: dd } }).district, "بحرة");
  assert.equal(districtOfRow({ delivery_quote: JSON.stringify({ districtDelivery: dd }) }).fee, 55);
  assert.equal(districtOfRow({ delivery_quote: { farZone: { km: 12 } } }), null);
  assert.equal(districtOfRow({}), null);
  assert.equal(districtOfRow(null), null);
});

/* ── القايمة المنشورة ────────────────────────────────────────────────── */
test("قايمة طلباتك: ١٠٣ حي فريد (النزهة كانت مكرّرة) وكلهم مقفولين", () => {
  const d = seedDistricts();
  const published = Object.values(SEED_PRICE_LIST).reduce((a, x) => a + x.length, 0);
  // صفحتهم بتقول «١٠٤ حي» بس «النزهة» متكتوبة مرتين (٢٥ و٣٠) — فالفريد ١٠٣
  assert.equal(published, 103);
  assert.equal(d.length, 103);
  assert.ok(d.every((x) => x.active === false && x.confirmed === false));
  assert.ok(d.every((x) => x.price >= 15 && x.price <= 50));
});

test("قايمة طلباتك: «النزهة» المكرّرة بتاخد السعر الأغلى", () => {
  const d = seedDistricts().find((x) => normDistrict(x.name) === normDistrict("النزهة"));
  assert.equal(d.price, 30, "٢٥ و٣٠ في قايمتهم — بناخد ٣٠ عشان ما نسعّرش تحت التكلفة");
});

test("seedConfig بيطلع مقفول بالكامل", () => {
  const c = districtCfg({ delivery: { districtCouriers: seedConfig() } });
  assert.equal(c.enabled, false);
  assert.equal(c.districts.filter((d) => d.active).length, 0);
  assert.equal(activeDistrictNames(c).length, 0);
  assert.equal(c.providers[0].name, "طلباتك");
});

/* ── التقرير ──────────────────────────────────────────────────────────── */
test("districtBlock: الرسم المحصّل − تكلفة المندوب = الهامش", async () => {
  const { districtBlock } = await import("./portal-reports.js");
  const b = districtBlock({ district_orders: 4, district_revenue: 420, district_fees: 180, district_cost: 160 });
  assert.equal(b.orders, 4);
  assert.equal(b.feesCollected, 180);
  assert.equal(b.courierCost, 160);
  assert.equal(b.margin, 20);
  assert.equal(b.marginPerOrder, 5);
  assert.equal(b.avgFee, 45);
  assert.equal(b.avgCost, 40);
});

test("districtBlock: شهر من غير طلبات حي = أصفار، مش قسمة على صفر", () => {
  return import("./portal-reports.js").then(({ districtBlock }) => {
    const b = districtBlock({});
    assert.equal(b.orders, 0);
    assert.equal(b.marginPerOrder, 0);
    assert.equal(b.avgFee, 0);
  });
});
