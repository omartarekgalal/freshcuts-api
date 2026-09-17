/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات «المنطقة البعيدة» — العميل بيدفع بالنتيجة دي حرفياً

   قرار عمر (2026-09-17): «لو العميل عنوانه مش مغطي يجيله زرار: ممكن نوصلك
   برسوم اضافية … لو وافق يتحسبله رسوم ٣ ريال على كل كيلو فوق العشرة».

   التلات قواعد اللي الاختبارات دي بتقفلها:
     ١) من غير موافقة صريحة → الرد يفضل رفض (زي الأول) + العرض بس.
     ٢) الرسم = ceil(المشوار − ١٠) × ٣، من ١٠ كم بالظبط مش من سقف المنطقة.
     ٣) مفيش خصم بيلمسه: السلّم، التوصيل المجاني، الضمان، كوبون FIRST.

     node --test farzone.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import { computeDeliveryFee, farZoneOf } from "./delivery.js";
import { farOut, scalePolygon, circlePolygon } from "./deliveryzone.js";

/* نسخة طبق الأصل من سياسة الإنتاج (dl_policies id=1، 2026-09-17) + الافتراضات
   الجديدة للمنطقة البعيدة. أي اختبار هنا بيتكلم عن أرقام العميل الحقيقية. */
const POL = {
  type: "distance_tiers",
  baseKm: 10, baseFee: 20, perKm: 3, maxKm: 10.9,
  feeByTotal: [{ over: 0, fee: 20 }, { over: 60, fee: 15 }, { over: 80, fee: 10 },
               { over: 100, fee: 5 }, { over: 150, fee: 0 }],
  minOrderTotal: 0, routeFactor: 1.3,
  neverBeatenByApps: { enabled: false },
  farZoneEnabled: true, farZoneMaxKm: 15, farZoneFromKm: 10, farZonePerKm: 3,
};
const q = (km, total, accepted = true) =>
  computeDeliveryFee(POL, { distanceKm: km, orderTotal: total, farZoneAccepted: accepted });

/* ── ١) حسابات المسافة ────────────────────────────────────────────────── */

test("١٠٫٠ كم: جوّه المنطقة — مفيش رسم إضافي ولا حتى الحقل", () => {
  const r = q(10.0, 50);
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 20);
  assert.equal(r.farZone, undefined);
});

test("١٠٫٩ كم: على حد المنطقة بالظبط — سلوك النهاردة زي ما هو (perKm)", () => {
  const r = q(10.9, 50);
  assert.equal(r.deliverable, true);
  assert.equal(r.fee, 23); // ٢٠ سلّم + كم إضافي واحد × ٣ (perKm القديم)
  assert.equal(r.farZone, undefined);
});

test("١٢٫٣ كم: ٣ كم فوق العشرة = ٩ ر.س رسم إضافي فوق رسم السلّم", () => {
  const r = q(12.3, 50);
  assert.equal(r.deliverable, true);
  assert.equal(r.feeBase, 20);
  assert.deepEqual(
    { km: r.farZone.km, extraKm: r.farZone.extraKm, surcharge: r.farZone.surcharge },
    { km: 12.3, extraKm: 3, surcharge: 9 });
  assert.equal(r.fee, 29);
});

test("١٤٫٩ كم: آخر مسافة مقبولة — ٥ كم × ٣ = ١٥ ر.س", () => {
  const r = q(14.9, 50);
  assert.equal(r.deliverable, true);
  assert.equal(r.farZone.extraKm, 5);
  assert.equal(r.fee, 20 + 15);
});

test("١٥٫١ كم: فوق السقف النهائي — مرفوض حتى لو العميل وافق، ومن غير عرض", () => {
  const r = q(15.1, 50);
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "out_of_range");
  assert.equal(r.farZoneOffer, undefined);
});

test("١٥٫٠ كم بالظبط: لسه جوّه السقف", () => {
  assert.equal(q(15.0, 50).deliverable, true);
  assert.equal(q(15.0, 50).farZone.surcharge, 15);
});

test("كل كيلو **بدأ**: ١٢٫٠ كم = ٢ كم، و١٢٫٠١ كم = ٣ كم", () => {
  assert.equal(q(12.0, 50).farZone.extraKm, 2);
  assert.equal(q(12.01, 50).farZone.extraKm, 3);
});

test("أول متر بره المنطقة بيدفع كيلو كامل (١٠٫٩١ كم = كيلو واحد)", () => {
  const r = q(10.91, 50);
  assert.equal(r.farZone.extraKm, 1);
  assert.equal(r.farZone.surcharge, 3);
});

/* ── ٢) بوابة الموافقة ────────────────────────────────────────────────── */

test("من غير موافقة: نفس الرفض القديم بالظبط + العرض في حقل منفصل", () => {
  const r = q(12.3, 50, false);
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "out_of_range");
  assert.equal(r.maxKm, 10.9);
  assert.equal(r.distanceKm, 12.3);
  assert.deepEqual(
    { extraKm: r.farZoneOffer.extraKm, surcharge: r.farZoneOffer.surcharge, maxKm: r.farZoneOffer.maxKm },
    { extraKm: 3, surcharge: 9, maxKm: 15 });
});

test("العرض مطابق للحساب النهائي — العميل مايشوفش رقم ويدفع غيره", () => {
  for (const km of [10.95, 11.4, 12.3, 13.7, 14.9]) {
    assert.equal(q(km, 50, false).farZoneOffer.surcharge, q(km, 50).farZone.surcharge, `km=${km}`);
    assert.equal(q(km, 50).fee, q(km, 50).feeBase + q(km, 50, false).farZoneOffer.surcharge, `km=${km}`);
  }
});

test("الميزة مقفولة: رفض زي الأول من غير عرض، والموافقة مابتفتحش حاجة", () => {
  const off = { ...POL, farZoneEnabled: false };
  const a = computeDeliveryFee(off, { distanceKm: 12.3, orderTotal: 50, farZoneAccepted: false });
  const b = computeDeliveryFee(off, { distanceKm: 12.3, orderTotal: 50, farZoneAccepted: true });
  assert.equal(a.deliverable, false);
  assert.equal(a.farZoneOffer, undefined);
  assert.equal(b.deliverable, false);
});

test("جوّه المنطقة الموافقة مالهاش أي أثر", () => {
  assert.deepEqual(q(8.2, 50).fee, computeDeliveryFee(POL, { distanceKm: 8.2, orderTotal: 50 }).fee);
});

/* ── ٣) مفيش خصم بيلمس الرسم الإضافي ──────────────────────────────────── */

test("سلّم السلة بينزّل الرسم الأساسي بس — الإضافي ثابت على كل الشرائح", () => {
  for (const [total, base] of [[50, 20], [70, 15], [90, 10], [120, 5], [200, 0]]) {
    const r = q(12.3, total);
    assert.equal(r.feeBase, base, `total=${total}`);
    assert.equal(r.farZone.surcharge, 9, `total=${total}`);
    assert.equal(r.fee, base + 9, `total=${total}`);
  }
});

test("توصيل مجاني (سلّم ١٥٠+): الأساسي صفر والإضافي بيتدفع كامل", () => {
  const r = q(12.3, 200);
  assert.equal(r.feeBase, 0);
  assert.equal(r.fee, 9);
});

test("«توصيل مجاني فوق مبلغ» (freeOverTotal) مابيصفّرش الرسم الإضافي", () => {
  const r = computeDeliveryFee({ ...POL, freeOverTotal: 100, feeByTotal: null },
    { distanceKm: 12.3, orderTotal: 150, farZoneAccepted: true });
  assert.equal(r.feeBase, 0);
  assert.equal(r.fee, 9);
});

test("خصم ثابت/نسبة على الرسم مابيلمسش الإضافي", () => {
  const flat = computeDeliveryFee({ ...POL, discount: { mode: "flat", value: 100, label: "خصم" } },
    { distanceKm: 12.3, orderTotal: 50, farZoneAccepted: true });
  assert.equal(flat.feeBase, 0);
  assert.equal(flat.fee, 9);
  const pct = computeDeliveryFee({ ...POL, discount: { mode: "percent", value: 100, label: "خصم" } },
    { distanceKm: 13.5, orderTotal: 50, farZoneAccepted: true });
  assert.equal(pct.feeBase, 0);
  assert.equal(pct.fee, 12);
});

test("ضمان «أرخص من التطبيقات» بيقصّ الأساسي بس", () => {
  const cfg = { ...POL, neverBeatenByApps: { enabled: true, appMarkupPct: 33, minCheaperBy: 1, courierCost: 0, contributionPct: 0.452, respectLadder: false } };
  /* سلة ٣٠ ر.س: سقف الضمان ٨ ر.س وهو أقل من رسم السلّم (٢٠) ⇒ الضمان بيقصّ. */
  const inZone = computeDeliveryFee(cfg, { distanceKm: 9, orderTotal: 30 });
  const far = computeDeliveryFee(cfg, { distanceKm: 12.3, orderTotal: 30, farZoneAccepted: true });
  assert.equal(far.feeBase, inZone.fee);          // نفس القصّ بالظبط
  assert.equal(far.fee, inZone.fee + 9);          // + الإضافي كامل
  assert.equal(far.guard.applied, true);
});

test("كوبون FIRST (توصيل مجاني): الرسم الأساسي بيتنازل عنه والإضافي لأ", () => {
  /* الكوبون بيتطبّق في shop.js: deliveryFee = الرسم الإضافي بس. الاختبار ده
     بيقفل الحساب اللي shop.js بيعتمد عليه. */
  const r = q(12.3, 50);
  const afterCoupon = r.farZone ? r.farZone.surcharge : 0;
  assert.equal(afterCoupon, 9);
  assert.equal(q(8, 50).farZone, undefined); // جوّه المنطقة: الكوبون بيصفّر كل حاجة
});

test("مفيش حساب مرتين: perKm مابيشتغلش فوق بداية الرسم الإضافي", () => {
  /* من غير القصّ، ١٢٫٣ كم كانت هتدفع perKm (٣×٣) + الإضافي (٩) = ١٨ زيادة. */
  const r = q(12.3, 50);
  assert.equal(r.feeBase, 20);
});

/* ── ٤) الحد الأدنى + شكل الرد ───────────────────────────────────────── */

test("الحد الأدنى للطلب بيتفحص برضه في المنطقة البعيدة", () => {
  const r = computeDeliveryFee({ ...POL, minOrderTotal: 40 },
    { distanceKm: 12.3, orderTotal: 30, farZoneAccepted: true });
  assert.equal(r.deliverable, false);
  assert.equal(r.reason, "under_minimum");
});

test("سطر الرسم الإضافي بيظهر في التفصيلة بالعربي", () => {
  const r = q(12.3, 50);
  assert.ok(r.breakdown.some((l) => l.includes("رسوم مسافة إضافية") && l.includes("3 كم") && l.includes("9")));
});

test("farZoneOf: دالة صافية بترجّع null جوّه المنطقة وفوق السقف", () => {
  assert.equal(farZoneOf(POL, 9), null);
  assert.equal(farZoneOf(POL, 10.9), null);
  assert.equal(farZoneOf(POL, 15.01), null);
  assert.equal(farZoneOf({ ...POL, farZoneMaxKm: 10.9 }, 11), null); // السقف = المنطقة ⇒ مفيش حزام
  assert.equal(farZoneOf(POL, 11).surcharge, 3);
});

/* ── ٥) حزام الخريطة ─────────────────────────────────────────────────── */

test("حزام المنطقة البعيدة: مضلّع أوسع بنفس الشكل حوالين المضلّع المغطّى", () => {
  const st = { lat: 21.5881, lng: 39.1521 };
  const poly = circlePolygon(st, 5, 12);
  const out = farOut({ maxKm: 10, farZoneMaxKm: 15, farZoneFromKm: 10, farZonePerKm: 3, farZoneEnabled: true }, st, poly);
  assert.equal(out.farZone.maxKm, 15);
  assert.equal(out.farZone.polygon.length, poly.length);
  // النقطة الأولى (شمال المطعم): المسافة اتضاعفت ١٫٥ مرة
  const d0 = poly[0][0] - st.lat, d1 = out.farZone.polygon[0][0] - st.lat;
  assert.ok(Math.abs(d1 / d0 - 1.5) < 0.01);
});

test("مفيش حزام لما الميزة مقفولة أو السقف مش أوسع من المنطقة", () => {
  const st = { lat: 21.5881, lng: 39.1521 };
  const poly = circlePolygon(st, 5, 12);
  assert.equal(farOut({ maxKm: 10, farZoneMaxKm: 15, farZoneEnabled: false }, st, poly).farZone, null);
  assert.equal(farOut({ maxKm: 15, farZoneMaxKm: 15, farZoneEnabled: true }, st, poly).farZone, null);
  assert.equal(scalePolygon(st, null, 1.5), null);
});

/* ── ٦) وصول الخبر للمطبخ والمندوب واللوحة والتقرير ──────────────────── */

import { posNotesOf } from "./shop.js";
import { courierNotes, farZoneOfRow } from "./couriers.js";
import { toPortalOrder } from "./portal-core.js";
import { farZoneBlock } from "./portal-reports.js";

const FAR_ROW = {
  order_no: "W1", option: "delivery", delivery_fee: 29, notes: "",
  created_at: "2026-09-18T18:00:00.000Z",
  address: { area: "أبحر", latitude: 21.7, longitude: 39.1 },
  delivery_quote: { deliverable: true, fee: 29, feeBase: 20, farZone: { km: 12.3, extraKm: 3, surcharge: 9 } },
};

test("ملاحظات نقطة البيع: الكاشير والمطبخ بيشوفوا «مشوار بعيد»", () => {
  const n = posNotesOf(FAR_ROW, { withFee: true });
  assert.ok(n.includes("مشوار بعيد 12.3 كم"), n);
  assert.ok(n.includes("توصيل 29ر"), n);
  const near = posNotesOf({ ...FAR_ROW, delivery_quote: { deliverable: true, fee: 20 } });
  assert.ok(!near.includes("مشوار بعيد"), near);
});

test("ملاحظات المندوب: «مشوار بعيد» أول حاجة، وبرضه تحت ٢٠٠ حرف", () => {
  const n = courierNotes({ ...FAR_ROW, notes: "الشقة فوق الصيدلية" });
  assert.ok(n.startsWith("مشوار بعيد 12.3 كم"), n);
  assert.ok(n.includes("الشقة فوق الصيدلية"));
  assert.ok(n.length <= 200);
  assert.equal(courierNotes({ order_no: "W2" }), "الطلب مدفوع مسبقاً — لا يُحصَّل من العميل");
});

test("farZoneOfRow: بيقرا التسعيرة نص كانت أو كائن، وبيرجّع null للطلب العادي", () => {
  assert.equal(farZoneOfRow(FAR_ROW).surcharge, 9);
  assert.equal(farZoneOfRow({ delivery_quote: JSON.stringify(FAR_ROW.delivery_quote) }).extraKm, 3);
  assert.equal(farZoneOfRow({ delivery_quote: { deliverable: true, fee: 20 } }), null);
  assert.equal(farZoneOfRow({}), null);
});

test("كارت البورتال: farZone جاي من الصف زي ما التسعيرة سجّلته", () => {
  const o = toPortalOrder({ ...FAR_ROW, status: "paid", total: 120, subtotal: 91,
    far_zone: FAR_ROW.delivery_quote.farZone, items: [], customer: {}, history: [] }, {}, Date.now());
  assert.deepEqual(o.farZone, { km: 12.3, extraKm: 3, surcharge: 9 });
  assert.equal(toPortalOrder({ ...FAR_ROW, items: [], customer: {}, history: [] }, {}, Date.now()).farZone, null);
});

test("التقرير: عدد الطلبات البعيدة وإيرادها والفرق على المندوب", () => {
  const b = farZoneBlock({ far_zone_orders: 4, far_zone_revenue: 480, far_zone_surcharge: 36,
    far_zone_extra_km: 12, far_zone_max_km: 14.2 });
  assert.equal(b.orders, 4);
  assert.equal(b.surcharge, 36);
  assert.equal(b.avgExtraKm, 3);
  assert.equal(b.courierExtraCost, 30);   // ١٢ كم × ٢٫٥
  assert.equal(b.gap, 6);                 // بناخد ٣ وبيتكلّف ٢٫٥ ⇒ نص ريال للكيلو
  assert.equal(farZoneBlock({}).orders, 0);
});
