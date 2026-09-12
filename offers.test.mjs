/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات سجلّ العروض — التواريخ والنص، مش الآليّة

   الملف ده بيحرس تلات حاجات بتغلط بسهولة ومحدش بيلاحظها غير العميل:
     ١) عرض منتهي لسه معلن (أو عرض جديد ظهر بدري)
     ٢) عرضين اليوم الوطني اتسجّلوا مرتين
     ٣) رقم «توفير» متحسوب على عرض مالوش سعر قبل

     node --test offers.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFERS, offerById, offerState, activeOffers, catalogOffers, publicOffer,
  hiddenOfferItemIds, canClaimSavings, untilText,
  OLD_OFFERS_UNTIL, ND96_FROM, ND96_UNTIL, ND96_UNTIL_PROVISIONAL,
} from "./offers.js";

// نص النهار UTC = نفس اليوم في الرياض بعد إزاحة يوم الشغل (٤ص) — تاريخ مضمون
const at = (day) => new Date(`${day}T12:00:00Z`);
const ids = (now) => activeOffers(now).map((o) => o.id).sort();

test("النهاردة: العرضين القدام لسه شغّالين — السجلّ بقى مطابق للواقع", () => {
  // كانوا مكتوبين ٣١ أغسطس والمطعم لسه بيبيعهم؛ عمر مدّهم لحد ما العروض الجديدة تبدأ
  assert.deepEqual(ids(at("2026-09-12")), ["combo70", "lamma"]);
});

test("١٤ سبتمبر آخر يوم للعرضين القدام (و`until` شامل لليوم نفسه)", () => {
  assert.equal(OLD_OFFERS_UNTIL, "2026-09-14");
  assert.deepEqual(ids(at("2026-09-14")), ["combo70", "lamma"]);
  assert.equal(offerState(offerById("lamma"), at("2026-09-14")).daysLeft, 0);
});

test("١٥ سبتمبر: القدام وقفوا والجداد بدأوا — مفيش تلاقي ومفيش يوم فاضي", () => {
  assert.deepEqual(ids(at("2026-09-15")), ["nd96_box", "nd96_kilo"]);
  assert.equal(offerState(offerById("combo70"), at("2026-09-15")).ended, true);
  assert.equal(offerState(offerById("nd96_kilo"), at("2026-09-14")).started, false);
  assert.equal(ND96_FROM, "2026-09-15");
});

test("عرض واحد بس لليوم الوطني… يعني عرضين، ومفيش تالت متسجّل قبلهم", () => {
  // كان في nd96 (بيتزا هدية على فاتورة ٩٦) — اتشال لإنه اتستبدل
  assert.equal(offerById("nd96"), null);
  const nd = OFFERS.filter((o) => o.from === ND96_FROM);
  assert.deepEqual(nd.map((o) => o.id), ["nd96_kilo", "nd96_box"]);
  assert.equal(OFFERS.length, 4);
  // ومفيش id مكرر في السجلّ كله
  assert.equal(new Set(OFFERS.map((o) => o.id)).size, OFFERS.length);
  assert.equal(new Set(OFFERS.map((o) => o.productId)).size, OFFERS.length);
});

test("٩٦ **سعر** العرض، مش أقل فاتورة تستحق هدية", () => {
  for (const id of ["nd96_kilo", "nd96_box"]) {
    const p = publicOffer(offerById(id), at("2026-09-16"));
    assert.equal(p.price, 96);
    assert.equal(p.priceRole, "price");
    assert.equal(p.mechanic, "bundle");
  }
});

test("ممنوع أي رقم «توفير» على عروض ٩٦ — كيلو صدور ٩٠ + أرز ٦ = ٩٦ بالظبط", () => {
  assert.equal(90 + 6, 96);                       // التوفير صفر على الاختيار ده
  for (const o of OFFERS) {
    assert.equal(canClaimSavings(o), false, o.id);
    const p = publicOffer(o, at("2026-09-16"));
    assert.equal(p.savingsClaim, false);
    assert.equal(p.compareAtPrice, null);         // مفيش سعر «قبل» يتحسب منه أصلاً
  }
  // ولا في النص نفسه
  for (const id of ["nd96_kilo", "nd96_box"]) {
    const o = offerById(id);
    assert.equal(/وفّر|وفر\s|خصم|٪|%/.test(`${o.title} ${o.desc} ${o.catalogTitle}`), false, id);
  }
});

test("تاريخ النهاية قيمة واحدة بتحكم العرضين، ومتعلّمة إنها مبدئية", () => {
  assert.equal(offerById("nd96_kilo").until, ND96_UNTIL);
  assert.equal(offerById("nd96_box").until, ND96_UNTIL);
  assert.equal(ND96_UNTIL_PROVISIONAL, true);
  assert.equal(publicOffer(offerById("nd96_box"), at("2026-09-16")).untilProvisional, true);
  // ومفيش عرض من غير تاريخ نهاية — ده الغلط اللي الملف اتكتب عشانه
  for (const o of OFFERS) assert.equal(typeof o.until, "string", o.id);
});

test("الكيلو من غير بيبسي، والبوكس معاه بيبسي لتر", () => {
  const kilo = offerById("nd96_kilo"), box = offerById("nd96_box");
  assert.equal(kilo.components.some((c) => /بيبسي/.test(c.label)), false);
  assert.deepEqual(kilo.excludes, ["بيبسي"]);
  assert.equal(box.components.some((c) => /بيبسي لتر/.test(c.label)), true);
  assert.equal(/بحريات/.test(box.desc), true);     // البحريات مستثناة من الاختيار
});

test("مفيش عرض من العروض دي على تطبيقات التوصيل", () => {
  for (const id of ["nd96_kilo", "nd96_box"]) {
    assert.equal(offerById(id).channels.deliveryApps, false);
    assert.equal(/تطبيقات التوصيل/.test(publicOffer(offerById(id)).note), true);
  }
});

test("الآليّة مش هنا: الشريط إعلامي وزرار الشراء بيجي من تجميعة المتجر", () => {
  for (const o of OFFERS) assert.equal(publicOffer(o).orderable, false, o.id);
  assert.equal(offerById("nd96_kilo").orderableVia, "store_bundle");
});

test("الثغرة: صنف نقطة البيع بتاع عرض منتهي بيتشال من الكتالوج الإعلاني", () => {
  // صينية اللمة صنف حقيقي (id 121) — صفها بيتولد من المنيو مش من العروض،
  // فتاريخ الانتهاء لوحده ماكانش بيسقّطه من feed.csv
  assert.equal(offerById("lamma").posItemId, "121");
  assert.equal(hiddenOfferItemIds(at("2026-09-12")).size, 0);        // العرض شغّال
  assert.equal(hiddenOfferItemIds(at("2026-09-15")).has("121"), true); // وقف → اتشال
  assert.equal(hiddenOfferItemIds(at("2026-08-31")).size, 0);
});

test("صفوف الكتالوج: الصينية مالهاش صف (عشان ما يتكررش id)، والجداد ليهم", () => {
  assert.deepEqual(catalogOffers(at("2026-09-12")).map((o) => o.id), ["combo70"]);
  assert.deepEqual(catalogOffers(at("2026-09-16")).map((o) => o.id), ["nd96_kilo", "nd96_box"]);
});

test("جملة التاريخ بالعربي بتتكتب من مكان واحد", () => {
  assert.equal(untilText(offerById("combo70")), "حتى 14 سبتمبر");
  assert.equal(untilText(offerById("nd96_kilo")), "حتى 30 سبتمبر");
});
