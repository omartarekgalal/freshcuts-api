/* FD1 (١٤/١٠) — حملة واتساب «طبقك المفضل» (wafavpick.js): الاختيار والأولوية، الوزن المعتاد، سطر التوصيل (نفس دالة الدفع)،
   شكل {{1}}/{{2}}، إعادة الحساب وقت الإرسال والضغطة، والسلة الجاهزة. المنيو والبوكسات الحقيقية يوم ١٤/١٠ (wafavpick.fixture.json).
   node --test wafavpick.test.mjs — قاعدة وهمية، مفيش شبكة ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const F = await import("./wafavpick.js");
const WB = await import("./wabot.js");
const D = await import("./delivery.js");
const DD = await import("./drivedist.js");
const CM = await import("./couponmin.js");
const { QUICK_STATS_SQL } = await import("./customer360.js");
const { appOnlyPhonesSql } = await import("./identity.js");
const FX = JSON.parse(fs.readFileSync(new URL("./wafavpick.fixture.json", import.meta.url), "utf8"));

const NOW = Date.parse("2026-10-14T17:30:00Z");            // ٢٠:٣٠ الرياض
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const H = (...o) => o.map(([d, total, names]) => ({ at: ago(d), total, names }));
const clone = (x) => JSON.parse(JSON.stringify(x));
const menuOf = ({ soldOut = {}, hiddenIds = [], pages = FX.pages } = {}) => WB.indexMenu(pages, { hiddenIds, soldOut, variants: FX.variants });
const liveOf = (o = {}) => F.buildLive({ menu: menuOf(o), bundles: o.bundles || FX.bundles, offers: o.offers === undefined ? FX.offers : o.offers });
/* نفس دالة الرسوم بتاعة الدفع على مسافة طريق معروفة (كاش جوجل) — زي delivery.quote */
const quoteAt = (km) => (x) => ({ ...D.computeDeliveryFee(FX.policy, { distanceKm: km, straightKm: km / 1.3, orderTotal: x.orderTotal, farZoneAccepted: x.farZoneAccepted }), distanceSource: "google", routeKm: km });
const LADDER = FX.policy.feeByTotal;
const line = (live, p, { km = null, firstElig = false, reward = null, webOrders = 0 } = {}) => {
  const r = F.renderPick(p.spec, live);
  assert.ok(r.ok, JSON.stringify(r));
  const q = km == null ? null : quoteAt(km)({ orderTotal: r.price, farZoneAccepted: true });
  const dl = F.deliveryLine({ price: r.price, located: km != null, q, firstElig, firstMin: 60, reward, webOrders, ladder: LADDER });
  return { title: r.title, line: `${r.main}، ${dl.text}`, price: r.price, dl };
};

// ═════════ ١) الطبق المفضل من التاريخ ═════════
test("الطبق المفضل: أسماء نقطة البيع بتتوحّد (همزة/تاء مربوطة/موتزريلا/بينا)، الوزن المعتاد بيتعدّ، والمشروبات والجوانب والإضافات عمرها ما تبقى المفضل", () => {
  const r = F.rankDishes(H([3, 40, "حواوشي موتزريلا ×2|بيبسي|مياه صغيرة"], [10, 60, "تشيكن بينا الفريدو|بطاطس محمرة|طبق أرز بسمتي"], [40, 90, "كفتة مشوية بالوزن - نصف كيلو|كفتة مشوية بالوزن - نصف كيلو"]), NOW);
  const keys = r.list.map(([k]) => k);
  // سطرين كفتة من ٤٠ يوم (٢ × ٠٫٤٣) بيغلبوا سطر باستا من ١٠ أيام (٠٫٧٥)
  assert.deepEqual(keys, [F.cleanKey("حواوشي موتزاريلا"), F.cleanKey("كفتة مشوية"), F.cleanKey("تشيكن بنا الفريدو")]);
  assert.equal(r.weights.get(`${F.cleanKey("كفتة مشوية")}|نصف كيلو`), 2);
  assert.ok(!keys.some((k) => /بيبسي|مياه|بطاطس|ارز/.test(k)), "مفيش مشروب ولا جانبي");
  const live = liveOf();
  assert.equal(F.pickFor({ H: H([2, 9, "بيبسي|مياه|طبق أرز بسمتي|كولسلو"]), live, now: NOW }).why, "no_dish");
  // الحداثة: طبق قديم مرات أكتر ممكن يخسر قدام طبق جديد
  const r2 = F.rankDishes(H([1, 30, "كريب زنجر سوبريم"], [80, 30, "بيتزا بيبروني - وسط"], [85, 30, "بيتزا بيبروني - وسط"]), NOW);
  assert.equal(r2.list[0][0], F.cleanKey("كريب زنجر سوبريم"));
});

// ═════════ ٢) الأولوية ═════════
test("الأولوية: بوكس فيه طبقه بالظبط ⇒ «بوكس فيه طبقك المفضل» بالسعر الحي (+الزيادة لو اختياره بزيادة)، وعميل FIRST سلّته بتترفع فوق ٦٠", () => {
  const live = liveOf();
  const pz = F.pickFor({ H: H([12, 57, "بيتزا تشيكن رانش - وسط|وجبة صدور مشوية"], [30, 70, "بيتزا تشيكن رانش - وسط 1.0 حشو اطراف كيري"]), live, firstElig: true, firstMin: 60, now: NOW });
  assert.deepEqual([pz.spec.kind, pz.spec.slug, pz.spec.pid, pz.spec.slot, pz.spec.favV, pz.spec.catOnly], ["box", "box-pizza-pasta", "43", "pizza", 36, false]);
  // من غير عنوان مؤكد: FIRST بشرط «داخل نطاق التوصيل» (المنطقة البعيدة عليها رسم مسافة، وبعد ١٥ كم مفيش توصيل) — مراجعة FD1
  assert.deepEqual(line(live, pz, { firstElig: true }), { title: "بوكس فيه طبقك المفضل", price: 69, dl: { text: "وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل", status: "no_location", via: "FIRST", alt: { text: "ونوصله لك أو تستلمه من فرعنا", via: null } },
    line: "بيتزا وباستا لشخصين (بيتزا تشيكن رانش وسط وباستا من اختيارك مع مقرمشات وكولسلو ومشروبين) بـ69 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل" });
  // سلّة ٤٢ ومستحق FIRST ⇒ بوكس لشخصين ٦٥ (مش الفردي)
  const cr = F.pickFor({ H: H([6, 42, "كريب شيش طاووق"], [15, 40, "كريب شيش طاووق"]), live, firstElig: true, firstMin: 60, now: NOW });
  assert.deepEqual([cr.spec.slug, cr.spec.slot], ["box-crepe-duo", "crepe1"]);
  // من غير FIRST ونفس السلّة ⇒ الفردي، واختياره بزيادة ٤ ⇒ ٣٣
  const solo = F.pickFor({ H: H([6, 32, "كريب سوبر كرانشي"], [15, 34, "كريب سوبر كرانشي"]), live, now: NOW });
  assert.equal(solo.spec.slug, "box-solo-crepe");
  assert.match(line(live, solo).line, /^بوكس الكريب الفردي \(كريب سوبر كرانشي مع صنف جانبي ومشروب غازي\) بـ33 ر.س، /);
  // مشوي بالوزن جوّه بوكس نص ونص (خانته نص كيلو)
  const kf = F.pickFor({ H: H([6, 120, "كفتة مشوية بالوزن - كيلو|طبق أرز بسمتي"], [20, 96, "كفتة مشوية بالوزن - كيلو"]), live, now: NOW });
  assert.deepEqual([kf.spec.slug, kf.spec.favV], ["box-grill-half-half", 45]);
  assert.equal(line(live, kf, { km: 0.5 }).line, "بوكس المشاوي نص ونص (نص كيلو كفتة مشوية ونص كيلو ثاني من اختيارك مع طبقين أرز وبطاطس وكولسلو) بـ125 ر.س، والتوصيل لعنوانك 5 ر.س، ومجاني لو طلبك من 150 ر.س");
});

test("الأولوية: مفيش بوكس فيه طبقه ⇒ بوكس من نوع أكله «يناسب ذوقك» («بسعر يبدأ من» لو فيه اختيارات بزيادة) ⇒ مفيش ⇒ طبقه نفسه بوزنه المعتاد (من غير عدد أشخاص)", () => {
  const live = liveOf();
  // كريب بطاطس مش اختيار في أي بوكس ⇒ الكريب الفردي من نوعه، وفيه اختيارات بزيادة ⇒ «يبدأ من 29»
  const cat = F.pickFor({ H: H([5, 28, "كريب بطاطس"], [9, 30, "كريب بطاطس"]), live, now: NOW });
  assert.deepEqual([cat.spec.slug, cat.spec.catOnly], ["box-solo-crepe", true]);
  const c1 = line(live, cat);
  assert.equal(c1.title, "بوكس يناسب ذوقك");
  assert.match(c1.line, /^بوكس الكريب الفردي \(كريب من اختيارك مع صنف جانبي ومشروب غازي\) بسعر يبدأ من 29 ر.س، /);
  // كباب بالوزن مش في أي بوكس، وبوكسات المشاوي أغلى بكتير من سلّته ⇒ الطبق نفسه بوزنه المعتاد (نص كيلو)
  const kb = F.pickFor({ H: H([7, 70, "كباب مشوي بالوزن - نصف كيلو"], [21, 70, "كباب مشوي بالوزن - نصف كيلو|بيبسي"]), live, now: NOW });
  assert.deepEqual([kb.spec.kind, kb.spec.pid, kb.spec.vid, kb.spec.wl], ["item", "97", 51, "نصف كيلو"]);
  assert.deepEqual(line(live, kb), { title: "طبقك المفضل", price: 70, dl: { text: "ونوصله لك أو تستلمه من فرعنا", status: "no_location", via: null }, line: "كباب مشوي نص كيلو بـ70 ر.س، ونوصله لك أو تستلمه من فرعنا" });
  // مشكل مخصوص ثلث كيلو (سلّة صغيرة) ⇒ الطبق نفسه — من غير «يكفي كذا شخص»
  const ms = F.pickFor({ H: H([5, 53, "مشكل مخصوص بالوزن - ثلث كيلو"], [9, 53, "مشكل مخصوص بالوزن - ثلث كيلو"], [30, 50, "مشكل مخصوص بالوزن - ثلث كيلو"]), live, firstElig: true, now: NOW });
  const m1 = line(live, ms, { firstElig: true });
  assert.equal(m1.line, "مشكل مخصوص ثلث كيلو بـ53 ر.س، ونوصله لك أو تستلمه من فرعنا، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من 60 ر.س");
  assert.ok(!/شخص|أشخاص|يكفي/.test(m1.line));
});

test("الباقات (عروض الجمعات): لعميل تاريخه فيه طلبات جمعات بس، والعرض لازم يكون شغّال — منتهي ⇒ مفيش باقة", () => {
  const big = H([16, 470, "طرب مشوي بالوزن - كيلو ×4|طبق أرز بسمتي ×4"], [41, 72, "طرب مشوي بالوزن - نصف كيلو"]);
  const p = F.pickFor({ H: big, live: liveOf(), firstElig: true, now: NOW });
  assert.deepEqual([p.spec.kind, p.spec.slug, p.spec.slot, p.spec.favV], ["pack", "gathering-4", "grill1", 49]);
  assert.equal(line(liveOf(), p, { firstElig: true }).line, "باقة تجمّع 4–6 أشخاص (2 كيلو مشاوي من اختيارك مع أرز وبطاطس وكولسلو و4 مشروبات) بـ225 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل");
  assert.equal(line(liveOf(), p, { firstElig: true }).title, "باقة لجمعتكم");
  // العرض خلص (مش في العروض الشغّالة) ⇒ مفيش باقة، ولو اتخزّنت قبل كده ⇒ إعادة الحساب ترفض
  const ended = liveOf({ offers: [] });
  assert.notEqual(F.pickFor({ H: big, live: ended, firstElig: true, now: NOW }).spec.kind, "pack");
  assert.deepEqual(F.renderPick(p.spec, ended), { ok: false, why: "offer_ended" });
  // نفس الطبق من غير طلبات جمعات ⇒ مفيش باقة
  const small = F.pickFor({ H: H([17, 140, "طرب مشوي بالوزن - كيلو"], [40, 70, "طرب مشوي بالوزن - نصف كيلو"]), live: liveOf(), now: NOW });
  assert.notEqual(small.spec.kind, "pack");
});

// ═════════ ٣) التوصيل ═════════
test("التوصيل: الرسم لعنوانه من نفس دالة الدفع، المجاني من السلّم، FIRST بيلغي الأساسي بس (المسافة الإضافية بتفضل)، كود المكافأة، والمسافة مش مؤكدة ⇒ مفيش رقم", () => {
  const DL = (price, o) => F.deliveryLine({ price, firstMin: 60, ladder: LADDER, ...o });
  const at = (km, price) => quoteAt(km)({ orderTotal: price, farZoneAccepted: true });
  assert.equal(DL(85, { located: true, q: at(3.8, 85) }).text, "والتوصيل لعنوانك 10 ر.س");
  assert.equal(DL(65, { located: true, q: at(3, 65) }).text, "والتوصيل لعنوانك 15 ر.س");
  assert.equal(DL(125, { located: true, q: at(0.9, 125) }).text, "والتوصيل لعنوانك 5 ر.س، ومجاني لو طلبك من 150 ر.س");
  assert.equal(DL(395, { located: true, q: at(2.6, 395) }).text, "والتوصيل لعنوانك مجاني");
  assert.equal(DL(29, { located: true, q: at(6.7, 29), firstElig: true }).text, "والتوصيل لعنوانك 20 ر.س، ومجاني بكود FIRST لو طلبك من 60 ر.س");
  assert.deepEqual(DL(65, { located: true, q: at(2, 65), firstElig: true }), { text: "والتوصيل لعنوانك مجاني بكود FIRST لأول طلب من الموقع", status: "fee", fee: 0, via: "FIRST", far: false });
  assert.equal(DL(65, { located: true, q: at(2, 65), firstElig: true, webOrders: 1 }).text, "وأول توصيل من الموقع مجاني لعنوانك بكود FIRST");
  // منطقة بعيدة (١٠٫٦ كم): ٥ (سلّم ١٠٥) + ٣ مسافة = ٨؛ FIRST بيشيل الـ٥ بس ⇒ ٣، ومن غير «مجاني لو…» (المسافة الإضافية مابتتلغيش)
  assert.deepEqual(DL(105, { located: true, q: at(10.6, 105) }), { text: "والتوصيل لعنوانك 8 ر.س", status: "fee", fee: 8, via: null, far: true });
  /* مراجعة FD1: الرقم بعد FIRST بيتقال **بالكود** — الدفع من غير الكود بياخد ١٨/٨ مش ٣ (FIRST مابيتطبّقش لوحده في كل زيارة) */
  assert.deepEqual(DL(105, { located: true, q: at(10.6, 105), firstElig: true }), { text: "والتوصيل لعنوانك 3 ر.س بكود FIRST لأول طلب من الموقع", status: "fee", fee: 3, via: "FIRST", far: true });
  assert.equal(DL(65, { located: true, q: at(10.6, 65), firstElig: true, webOrders: 1 }).text, "وأول توصيل من الموقع لعنوانك بـ3 ر.س بكود FIRST");
  assert.equal(DL(45, { located: true, q: at(10.6, 45), firstElig: true }).text, "والتوصيل لعنوانك 23 ر.س", "بعيد + أقل من ٦٠: مفيش «مجاني بكود FIRST»");
  // مكافأة الولاء: بكودها، وحدّها الأدنى متحقق (كود وهمي للاختبار)
  const rw = { code: "FCTEST7Q2K", freeDelivery: true, percent: 0, minTotal: 60 };
  assert.equal(DL(65, { located: true, q: at(1.4, 65), reward: rw }).text, "والتوصيل لعنوانك مجاني بكود مكافأتك FCTEST7Q2K");
  assert.equal(F.pickReward([rw], 50), null, "تحت حد المكافأة ⇒ مالهاش ذكر");
  /* مراجعة FD1: في المنطقة البعيدة المكافأة بتلغي الأساسي برضه (feeAfterCoupon) — الرسالة كانت بتقول ٨ والدفع بالمكافأة ٣، و٢٤ قدام ٩ */
  assert.deepEqual(DL(105, { located: true, q: at(10.6, 105), reward: rw }), { text: "والتوصيل لعنوانك 3 ر.س بكود مكافأتك FCTEST7Q2K", status: "fee", fee: 3, via: "reward", far: true });
  assert.equal(DL(65, { located: true, q: at(12.4, 65), reward: rw }).text, "والتوصيل لعنوانك 9 ر.س بكود مكافأتك FCTEST7Q2K");
  // نفس الأرقام اللي صفحة الدفع بتحسبها بالكوبون (couponmin.feeAfterCoupon)
  for (const [km, price, via] of [[10.6, 105, { firstElig: true }], [12.4, 65, { reward: rw }], [10.6, 65, { firstElig: true }], [4, 85, { firstElig: true }]]) {
    const q = at(km, price), keep = q.farZone ? q.farZone.surcharge : 0;
    const co = CM.feeAfterCoupon({ fee: q.fee, keep, coupon: { ok: true, freeDelivery: true, minTotal: 60 }, foodTotal: price });
    assert.equal(DL(price, { located: true, q, ...via }).fee, co.fee, `${km} كم / ${price}`);
  }
  // المسافة مش من كاش جوجل (تقدير هوائي) ⇒ ولا رقم؛ FIRST بشرط «داخل نطاق التوصيل» بس
  const straight = { ...at(4, 85), distanceSource: "straight" };
  assert.deepEqual(DL(85, { located: true, q: straight }), { text: "ونوصله لك أو تستلمه من فرعنا", status: "no_location", via: null, est: true });
  assert.deepEqual(DL(85, { located: true, q: straight, firstElig: true }), { text: "وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل", status: "no_location", via: "FIRST", est: true, alt: { text: "ونوصله لك أو تستلمه من فرعنا", via: null } });
  assert.equal(DL(85, { located: false, firstElig: true, webOrders: 2 }).text, "وأول توصيل من الموقع مجاني بكود FIRST داخل نطاق التوصيل");
  /* مراجعة FD1 (الإصدار الأول كان بيقول «توصيله مجاني» هنا): عنوان الحساب على ٢٠ كم هوائي ⇒ الدفع بيرفض التوصيل ⇒ الاستلام بس، من غير FIRST */
  const far20 = { deliverable: false, reason: "out_of_range", distanceSource: "straight", straightKm: 20 };
  assert.deepEqual(DL(85, { located: true, q: far20, firstElig: true }), { text: "وتقدر تستلمه من فرعنا", status: "out_of_range", est: true });
  // تقدير المنطقة البعيدة (٨٫٣ هوائي × ١٫٣) ⇒ من غير رقم ومن غير «مجاني» (رسم المسافة بيفضل)
  const farEst = { ...D.computeDeliveryFee(FX.policy, { distanceKm: 8.3 * 1.3, straightKm: 8.3, orderTotal: 85, farZoneAccepted: true }), distanceSource: "straight" };
  assert.ok(farEst.farZone && farEst.deliverable);
  assert.deepEqual(DL(85, { located: true, q: farEst, firstElig: true }), { text: "ونوصله لك أو تستلمه من فرعنا", status: "no_location", via: null, far: true, est: true });
  // بره النطاق خالص (مسافة مؤكدة) ⇒ الاستلام
  assert.deepEqual(DL(85, { located: true, q: at(16, 85) }), { text: "وتقدر تستلمه من فرعنا", status: "out_of_range" });
  assert.deepEqual(DL(85, { located: true, q: at(16, 85), firstElig: true }), { text: "وتقدر تستلمه من فرعنا", status: "out_of_range" });
});

test("مراجعة FD1: مفيش سطر فيه «مجاني» من غير شرط لعميل مسافته مش مؤكدة — على أي مسافة هوائية لعنوانه (٠–٢٥ كم) وأي سلة", async () => {
  const STORE = { lat: 21.5881404, lng: 39.1521236 };
  for (let km = 0; km <= 25; km += 0.7) {
    for (const price of [29, 45, 59, 65, 85, 105, 160, 395]) {
      const to = { lat: STORE.lat + km / 111, lng: STORE.lng };
      const straightKm = D.haversineKm(STORE.lat, STORE.lng, to.lat, to.lng);
      const rk = await DD.resolveRouteKm({ cfg: FX.policy, straightKm, from: STORE, to, drive: { get: async () => null } });      // كاش فاضي (cacheOnly)
      const q = { ...D.computeDeliveryFee(FX.policy, { distanceKm: rk.routeKm, straightKm, orderTotal: price, farZoneAccepted: true }), distanceSource: rk.distanceSource };
      for (const firstElig of [false, true]) {
        const dl = F.deliveryLine({ price, located: true, q, firstElig, firstMin: 60, ladder: LADDER });
        const tag = `${km.toFixed(1)} كم / ${price} / FIRST ${firstElig}`;
        assert.ok(!/\d+ ر\.س بكود|لعنوانك \d/.test(dl.text), `مفيش رقم من تقدير: ${tag}: ${dl.text}`);
        if (/مجاني/.test(dl.text)) assert.match(dl.text, /داخل نطاق التوصيل/, tag);
        if (!q.deliverable) assert.equal(dl.text, "وتقدر تستلمه من فرعنا", tag);
        if (q.farZone) assert.ok(!/مجاني/.test(dl.text), `منطقة بعيدة بالتقدير ⇒ مفيش «مجاني»: ${tag}`);
      }
    }
  }
});

// ═════════ ٤) شكل الرسالة والحملة ═════════
test("النص: {{1}}/{{2}} سطر واحد، {{2}} ≤ ٢٠٠ ومن غير «:» ولا نقطة في الآخر؛ الحملة بقالب «الرد أولاً» بس، على Cloud، ومن غير كوبون", () => {
  assert.equal(F.lineProblem("بوكس فيه طبقك المفضل", "بوكس (كذا) بـ65 ر.س، والتوصيل لعنوانك 15 ر.س"), null);
  assert.equal(F.lineProblem("عنوان\nسطرين", "x"), "bad_title");
  assert.equal(F.lineProblem("عنوان", "سطر\nتاني"), "bad_line");
  assert.equal(F.lineProblem("عنوان", "بوكس: كذا"), "line_colon");
  assert.equal(F.lineProblem("عنوان", "بوكس بـ65 ر.س."), "line_period");
  assert.equal(F.lineProblem("عنوان", "ب".repeat(201)), "line_too_long");
  assert.equal(F.favTemplateOk("fc_frame_ask_text"), true);
  assert.equal(F.favTemplateOk("fc_frame_ask_video"), true);
  for (const n of ["fc_frame_news_text", "fc_fav_dish", "fc_offer_img", "nope"]) assert.equal(F.favTemplateOk(n), false, n);
  assert.equal(F.favJobProblem({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text" }), null);
  assert.equal(F.favJobProblem({ channel: "wa_web", cloudTemplate: "fc_frame_ask_text" })[0], "fav_cloud_only");
  assert.equal(F.favJobProblem({ channel: "wa_cloud", cloudTemplate: "fc_fav_dish" })[0], "fav_template");
  assert.equal(F.favJobProblem({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", coupon: "FIRST" })[0], "fav_no_coupon");
  assert.equal(F.favJobProblem({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", offer: { oneTime: true } })[0], "fav_no_coupon");
  // كل البوكسات الـ٢١ يوم ١٤/١٠: نصها المكتوب بيوصف شكلها الحي، وكل سطر ممكن (بأطول اسم) تحت ٢٠٠
  const live = liveOf();
  assert.equal(live.boxes.size, 21);
  for (const b of live.boxes.values()) assert.equal(F.BOX_SIG[b.slug], b.sig, b.slug);
  // بوكس اتغيّر شكله (خانة اتشالت) ⇒ الصيغة العامة «اسم البوكس (فيه طبقك)» — مانوصفش محتوى مش موجود
  const changed = clone(FX.bundles); const cd = changed.find((b) => b.slug === "box-crepe-duo"); cd.slots = cd.slots.filter((s) => s.key !== "cheesefries");
  const l2 = liveOf({ bundles: changed });
  assert.equal(F.renderPick({ kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1" }, l2).main, "بوكس الكريب لشخصين (فيه كريب شيش طاووق) بـ65 ر.س");
});

// ═════════ ٥) إعادة الحساب ═════════
test("إعادة الحساب (وقت الإرسال والضغطة): نفس البيانات ⇒ نفس النص بالحرف؛ سعر البوكس اتغيّر ⇒ نص مختلف؛ الطبق خلص/اتخفى/اتشال من البوكس ⇒ مفيش عرض", () => {
  const live = liveOf();
  const spec = { kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1", sg: "crepe" };
  const a = F.renderPick(spec, live), b = F.renderPick(spec, liveOf());
  assert.deepEqual(a, b);
  const pricier = clone(FX.bundles); pricier.find((x) => x.slug === "box-crepe-duo").price = 69;
  assert.equal(F.renderPick(spec, liveOf({ bundles: pricier })).main.endsWith("بـ69 ر.س"), true);
  assert.deepEqual(F.renderPick(spec, liveOf({ soldOut: { 6: true } })), { ok: false, why: "sold_out" });
  assert.deepEqual(F.renderPick(spec, liveOf({ hiddenIds: ["6"] })), { ok: false, why: "item_gone" });
  const noChoice = clone(FX.bundles); for (const s of noChoice.find((x) => x.slug === "box-crepe-duo").slots) if (s.choices) s.choices = s.choices.filter((c) => String(c.product_id) !== "6");
  assert.deepEqual(F.renderPick(spec, liveOf({ bundles: noChoice })), { ok: false, why: "not_in_box" });
  assert.deepEqual(F.renderPick({ ...spec, slug: "box-gone" }, live), { ok: false, why: "box_gone" });
  // صنف بالوزن: الوزن اتشال ⇒ مفيش عرض؛ سعر الوزن اتغيّر ⇒ نص مختلف
  const item = { kind: "item", pid: "97", vid: 51 };
  assert.equal(F.renderPick(item, live).main, "كباب مشوي نص كيلو بـ70 ر.س");
  const v2 = clone(FX.variants); v2["97"] = v2["97"].filter((o) => o.id !== 51);
  assert.deepEqual(F.renderPick(item, F.buildLive({ menu: WB.indexMenu(FX.pages, { variants: v2 }), bundles: FX.bundles, offers: FX.offers })), { ok: false, why: "weight_gone" });
});

// ═════════ ٦) السلة الجاهزة ═════════
test("السلة الجاهزة للضغطة: طبقه في خانته، وباقي الخانات أول اختيار متاح من غير زيادة (فالسعر = اللي اتقال)؛ بوكس من نوعه ⇒ من غير سلة", () => {
  const live = liveOf();
  assert.deepEqual(F.cartInput({ kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1", favV: null }, live), {
    input: { option: "delivery", boxes: [{ slug: "box-crepe-duo", qty: 1, choices: { crepe1: { product_id: "6", variant_option_id: null }, crepe2: { product_id: "9", variant_option_id: null }, side: { product_id: "79", variant_option_id: null } } }] },
    picks: ["كريب شيش طاووق", "كريب سوبر كرانشي", "بطاطس محمرة"] });
  // الفردي: طبقه بزيادة ٤ في خانته، والجانبي من غير زيادة
  const solo = F.cartInput({ kind: "box", slug: "box-solo-crepe", pid: "9", slot: "crepe" }, live);
  assert.deepEqual(solo.input.boxes[0].choices, { crepe: { product_id: "9", variant_option_id: null }, side: { product_id: "79", variant_option_id: null } });
  // الباقة: طبقه بالكيلو + المشوي التاني
  assert.deepEqual(F.cartInput({ kind: "pack", slug: "gathering-4", pid: "94", slot: "grill1", favV: 49 }, live).picks, ["طرب مشوي كيلو", "كفتة مشوية كيلو"]);
  // صنف بالوزن ⇒ سطر بوزنه
  assert.deepEqual(F.cartInput({ kind: "item", pid: "97", vid: 51 }, live), { input: { option: "delivery", items: [{ id: "97", qty: 1, variant_option_id: 51 }] }, picks: [] });
  assert.equal(F.cartInput({ kind: "box", slug: "box-solo-crepe", pid: "11", catOnly: true }, live), null);
  // خانة كل اختياراتها بزيادة ⇒ مانبنيش سلة بسعر غير اللي اتقال
  const sur = clone(FX.bundles); for (const c of sur.find((x) => x.slug === "box-crepe-duo").slots.find((s) => s.key === "side").choices) c.surcharge = 2;
  assert.equal(F.cartInput({ kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1" }, liveOf({ bundles: sur })), null);
});

test("الترتيب: الفلوس + عدد الطلبات × الحداثة (كامل لحد ٣٠ يوم، وبينزل لـ٠٫٤٥ عند ٩٠)", () => {
  assert.equal(F.favScore({ spend: 1000, orders: 10, daysAgo: 12 }), 1250);
  assert.equal(F.favScore({ spend: 9000, orders: 50, daysAgo: 5 }), 3500);
  assert.equal(F.favScore({ spend: 1000, orders: 0, daysAgo: 85 }), 500);
  assert.equal(F.favScore({ spend: 1000, orders: 0, daysAgo: 200 }), 450);
});

// ═════════ ٧) التشغيل على قاعدة وهمية ═════════
function favWorld({ people = {}, bundles = FX.bundles, offers = FX.offers, soldOut = {}, settings = {}, first = { code: "FIRST", active: true, min_total: "60", free_delivery: true, percent: "0", expires_at: null }, lastSent = null, newer = false } = {}) {
  const calls = { quote: [], sql: [], live: [], params: [] };
  const st = { menu: menuOf({ soldOut }), bundles, offers, kmAt: new Map() };
  for (const [pn, p] of Object.entries(people)) if (p.loc) st.kmAt.set(`${p.loc.lat},${p.loc.lng}`, p.loc.km);
  const P = (pns) => (pns || []).map(String).filter((pn) => people[pn]);
  const pool = { async query(sql, params = []) {
    calls.sql.push(sql); calls.params.push(params);
    const S = F.FAV_SQL, rows = (r) => ({ rows: r, rowCount: r.length });
    if (sql === S.candidates) return rows(Object.keys(people).map((pn) => ({ pn })));
    if (sql === QUICK_STATS_SQL) return rows(P(params[0]).map((pn) => ({ pn, orders: people[pn].orders, spend: people[pn].spend, first_at: ago(200), last_at: ago(people[pn].daysAgo) })));
    if (sql === S.today) return rows(P(params[0]).filter((pn) => people[pn].today).map((pn) => ({ pn })));
    for (const [k, flag] of [["testOrOwner", "test"], ["ownerDiscount", "discount"], ["contactsStaffTest", "staffContact"], ["optedOut", "optedOut"], ["waStopped", "stopped"], ["firstUsed", "firstUsed"]]) if (sql === S[k]) return rows(P(params[0]).filter((pn) => people[pn][flag]).map((pn) => ({ pn })));
    if (sql === appOnlyPhonesSql("$1")) return rows(P(params[0]).filter((pn) => people[pn].appOnly).map((pn) => ({ pn })));
    if (sql === S.history) return rows(P(params[0]).flatMap((pn) => (people[pn].hist || []).map((o) => ({ pn, ...o }))));
    if (sql === S.names) return rows(P(params[0]).filter((pn) => people[pn].name).map((pn) => ({ pn, name: people[pn].name })));
    if (sql === S.web) return rows(P(params[0]).filter((pn) => people[pn].web).map((pn) => ({ pn, n: people[pn].web.n, deliv: people[pn].web.deliv })));
    if (sql === S.lastDelivery) return rows(P(params[0]).filter((pn) => people[pn].loc).map((pn) => ({ pn, lat: people[pn].loc.lat, lng: people[pn].loc.lng })));
    if (sql === S.accounts) return rows([]);
    if (sql === S.rewards) return rows(P(params[0]).flatMap((pn) => (people[pn].rewards || []).map((r) => ({ pn, code: r.code, percent: 0, free_delivery: true, min_total: r.minTotal }))));
    if (sql === S.first) return rows(first ? [first] : []);
    if (sql === S.policy) return rows([{ config: FX.policy }]);
    if (sql === S.orderedSince) return rows(people[params[0]] && people[params[0]].orderedSince ? [{ "?column?": 1 }] : []);
    if (sql === S.lastSent) return rows(lastSent ? [lastSent] : []);
    if (sql === S.newerTemplate) return rows(newer ? [{ "?column?": 1 }] : []);
    if (sql === S.inboundSince) return rows(people[params[0]] && people[params[0]].inboundSince ? [{ "?column?": 1 }] : []);
    if (sql === S.outboundSince) return rows(people[params[0]] && people[params[0]].outboundSince ? [{ "?column?": 1 }] : []);
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  } };
  const api = F.makeFavPick({ pool, now: () => NOW, getSettingsData: async () => ({ delivery: { alertPhones: ["0500000001"] }, ...settings }),
    live: () => ({ menu: async (o) => { calls.live.push(["menu", o]); return st.menu; }, bundles: async (o) => { calls.live.push(["bundles", o]); return st.bundles; }, offers: async (o) => { calls.live.push(["offers", o]); return st.offers; } }),
    quote: async (x) => { calls.quote.push(x); const km = st.kmAt.get(`${x.lat},${x.lng}`); return km == null ? { deliverable: true, fee: 20, distanceSource: "straight" } : quoteAt(km)(x); } });
  return { api, calls, st, people };
}
/* عملاء وهميين بالكامل (أرقام وأسماء وإحصائيات وأكواد مخترعة) — مراجعة FD1: ولا صف هنا منقول من عميل حقيقي */
const PEOPLE = () => ({
  "501000011": { name: "تجربة بيتزا", orders: 19, spend: 1180, daysAgo: 11, hist: H([11, 61, "بيتزا تشيكن رانش - وسط|كريب زنجر سوبريم"], [24, 66, "وجبة ميكس جريل|بيبسي"], [33, 70, "بيتزا تشيكن رانش - وسط"]) },
  "501000022": { name: "تجربة ميكس", orders: 8, spend: 640, daysAgo: 6, web: { n: 3, deliv: 3 }, loc: { lat: 21.6, lng: 39.16, km: 3.8 }, hist: H([6, 88, "وجبة ميكس جريل ×2|مياه"], [19, 92, "وجبة ميكس جريل|وجبة صدور مشوية"]) },
  "501000033": { name: "Test Crepe", orders: 6, spend: 280, daysAgo: 13, web: { n: 3, deliv: 0 }, firstUsed: true, loc: { lat: 21.59, lng: 39.15, km: 1.4 }, rewards: [{ code: "FCTEST7Q2K", minTotal: 60 }], hist: H([13, 58, "كريب سوبر كرانشي|كريب شيش طاووق"], [29, 63, "كريب سوبر كرانشي"]) },
  "501000044": { name: "تجربة جمعات", orders: 3, spend: 620, daysAgo: 16, web: { n: 1, deliv: 0 }, hist: H([16, 470, "طرب مشوي بالوزن - كيلو ×4|طبق أرز بسمتي ×4"], [41, 72, "طرب مشوي بالوزن - نصف كيلو"]) },
  "500000001": { name: "موظف", orders: 9, spend: 900, daysAgo: 6, hist: H([6, 60, "كريب زنجر سوبريم"]) },                 // أرقام التنبيهات
  "511111111": { name: "رقم وهمي", orders: 9, spend: 900, daysAgo: 6, hist: H([6, 60, "كريب زنجر سوبريم"]) },
  "520000001": { name: "طلب النهارده", orders: 4, spend: 200, daysAgo: 0, today: true, hist: H([0, 60, "كريب زنجر سوبريم"]) },
  "520000002": { name: "موقّف", orders: 4, spend: 200, daysAgo: 9, optedOut: true, hist: H([9, 60, "كريب زنجر سوبريم"]) },
  "520000003": { name: "تطبيق", orders: 4, spend: 200, daysAgo: 9, appOnly: true, hist: H([9, 60, "كريب زنجر سوبريم"]) },
  "520000004": { name: "خصم", orders: 4, spend: 200, daysAgo: 9, discount: true, hist: H([9, 60, "كريب زنجر سوبريم"]) },
  "520000005": { name: "قديم", orders: 4, spend: 200, daysAgo: 150, hist: H([150, 60, "كريب زنجر سوبريم"]) },
  "520000006": { name: "مشروبات", orders: 2, spend: 10, daysAgo: 9, hist: H([9, 5, "بيبسي|مياه"]) },
  "520000007": { name: "موقف واتساب", orders: 4, spend: 200, daysAgo: 9, stopped: true, hist: H([9, 60, "كريب زنجر سوبريم"]) },
});

test("الشريحة: الاستبعادات (فريق/وهمي/طلب النهارده/موقّف/تطبيقات بس/خصم المالك/قديم)، عرض لكل عميل بقيمه، الترتيب، والتوصيل من كاش المسافات بس", async () => {
  const w = favWorld({ people: PEOPLE() });
  const rows = await w.api.audienceRows();
  assert.deepEqual(rows.map((r) => r.pn), ["501000011", "501000022", "501000044", "501000033"], "مترتبين بالقيمة");
  assert.deepEqual(rows.stats.excluded, { bad_number: 1, ordered_today: 1, too_old: 1, staff: 1, opted_out: 1, app_only: 1, owner_discount: 1, wa_stopped: 1 });
  assert.deepEqual(rows.stats.noOffer, { no_dish: 1 });
  const by = Object.fromEntries(rows.map((r) => [r.pn, r]));
  assert.deepEqual(by["501000011"].vars.cloud.values, { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": "بيتزا وباستا لشخصين (بيتزا تشيكن رانش وسط وباستا من اختيارك مع مقرمشات وكولسلو ومشروبين) بـ69 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل" });
  assert.deepEqual(by["501000022"].vars.cloud.values["offer.line"], "ميكس جريل لشخصين (وجبة ميكس جريل ووجبة ثانية من اختيارك مع بطاطس وكولسلو ومشروبين) بـ85 ر.س، والتوصيل لعنوانك 10 ر.س");
  assert.equal(by["501000033"].vars.cloud.values["offer.line"].endsWith("والتوصيل لعنوانك مجاني بكود مكافأتك FCTEST7Q2K"), true, by["501000033"].vars.cloud.values["offer.line"]);
  assert.equal(by["501000044"].vars.cloud.values["offer.title"], "باقة لجمعتكم");
  assert.equal(by["501000044"].vars.cloud.values["offer.line"].endsWith("وأول توصيل من الموقع مجاني بكود FIRST داخل نطاق التوصيل"), true, "استلم من الموقع قبل كده ⇒ «أول توصيل»");
  // العرض المخزّن: من غير إحداثيات، ومعاه السعر ووقت التجهيز
  assert.deepEqual(Object.keys(by["501000022"].vars.fav).sort(), ["at", "catOnly", "direct", "fav", "favV", "kind", "pid", "price", "sg", "slot", "slug", "v"]);
  assert.equal(by["501000022"].vars.fav.at, new Date(NOW).toISOString());
  assert.deepEqual(by["501000022"].favView, { kind: "box", catOnly: false, ref: "box-mixgrill-duo", price: 85, delivery: "fee", via: null, fee: 10, far: false, loc: "last_delivery", km: 3.8 });
  // التسعير: delivery.quote نفسها، من الكاش بس (cacheOnly)، وعلى سعر العرض، والمنطقة البعيدة مقبولة (العميل بيوافق في صفحة الدفع)
  assert.ok(w.calls.quote.length >= 2 && w.calls.quote.every((x) => x.cacheOnly === true && x.farZoneAccepted === true));
  assert.deepEqual(w.calls.quote.find((x) => x.lat === 21.6).orderTotal, 85);
  for (const r of rows) assert.equal(F.lineProblem(r.vars.cloud.values["offer.title"], r.vars.cloud.values["offer.line"]), null);
  assert.ok(!JSON.stringify(rows.map((r) => r.vars)).includes("21.6"), "مفيش إحداثيات في متغيرات الطابور");
});

test("الشريحة مابتطلعش لو المنيو أو البوكسات مش متاحة (مفيش عروض بأسعار مش متأكدين منها)", async () => {
  const w = favWorld({ people: PEOPLE(), bundles: [] });
  await assert.rejects(() => w.api.audienceRows(), (e) => e.code === "FAV_CATALOG");
});

test("وقت الإرسال (recheck): نفس النص بالحرف ⇒ ابعت؛ السعر/التوصيل اتغيّر ⇒ offer_changed؛ طلب من ساعتها ⇒ ordered_since؛ خلص ⇒ offer_gone", async () => {
  const people = PEOPLE();
  const w = favWorld({ people });
  const rows = await w.api.audienceRows();
  const q = (pn) => ({ id: 1, phone_norm: pn, vars: rows.find((r) => r.pn === pn).vars });
  assert.equal(await w.api.recheck(q("501000022")), null);
  assert.equal(await w.api.recheck(q("501000011")), null);
  // سعر البوكس اتغيّر
  const b2 = clone(FX.bundles); b2.find((x) => x.slug === "box-mixgrill-duo").price = 89; w.st.bundles = b2;
  assert.equal(await w.api.recheck(q("501000022")), "offer_changed");
  w.st.bundles = FX.bundles;
  // العنوان بقى بعيد ⇒ رسم مختلف ⇒ مايتبعتش
  w.st.kmAt.set("21.6,39.16", 10.3);
  assert.equal(await w.api.recheck(q("501000022")), "offer_changed");
  w.st.kmAt.set("21.6,39.16", 3.8);
  // الكاش اتمسح (مسافة مش مؤكدة) ⇒ مايتبعتش بالرقم القديم
  w.st.kmAt.delete("21.6,39.16");
  assert.equal(await w.api.recheck(q("501000022")), "offer_changed");
  w.st.kmAt.set("21.6,39.16", 3.8);
  // الطبق خلص اليوم
  w.st.menu = menuOf({ soldOut: { 18: true } });
  assert.equal(await w.api.recheck(q("501000022")), "offer_gone:sold_out");
  w.st.menu = menuOf();
  // طلب من الموقع أو المحل بعد التجهيز
  people["501000022"].orderedSince = true;
  assert.equal(await w.api.recheck(q("501000022")), "ordered_since");
  // صف من غير قيم
  assert.equal(await w.api.recheck({ id: 9, phone_norm: "501000011", vars: { first_name: "x" } }), "offer_missing");
});

const CREPE_FAV = { v: 1, kind: "box", slug: "box-crepe-duo", pid: "6", slot: "crepe1", favV: null, sg: "crepe", price: 65 };
const CREPE_SENT = { "offer.title": "بوكس فيه طبقك المفضل", "offer.line": "بوكس الكريب لشخصين (كريب شيش طاووق وكريب ثاني من اختيارك مع تشيز فرايز وصنف جانبي ومشروبين) بـ65 ر.س، وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل" };
test("الضغطة: lastOffer بيرجّع عرض آخر رسالة «طبقك المفضل» للرقم بس (مش أي حملة، ومش لو فيه قالب تسويقي أحدث) ومعاه wamid رسالة الحملة", async () => {
  const row = { id: 7, job_id: 3, sent_at: ago(0.1), wamid: "wamid.CAMP7", vars: { fav: CREPE_FAV, cloud: { values: CREPE_SENT } }, cloud_template: "fc_frame_ask_text", cloud_vars: { offer: "", perRecipient: true } };
  const people = { "501000055": { name: "تجربة ضغطة", orders: 12, spend: 520, daysAgo: 5, hist: [] } };
  const lo = await favWorld({ people, lastSent: row }).api.lastOffer("501000055", 72);
  assert.deepEqual([lo.fav, lo.values, lo.wamid, lo.queueId], [CREPE_FAV, CREPE_SENT, "wamid.CAMP7", 7]);
  assert.equal(await favWorld({ people, lastSent: { ...row, cloud_vars: { offer: "عرض" } } }).api.lastOffer("501000055", 72), null, "حملة بقيمة واحدة للكل");
  assert.equal(await favWorld({ people, lastSent: { ...row, cloud_template: "fc_frame_news_text" } }).api.lastOffer("501000055", 72), null);
  assert.equal(await favWorld({ people, lastSent: row, newer: true }).api.lastOffer("501000055", 72), null, "قالب تسويقي أحدث ⇒ الضغطة ممكن تكون عليه");
  assert.equal(await favWorld({ people }).api.lastOffer("501000055", 72), null);
});

test("مراجعة FD1 — الضغطة: نفس العرض اللي اتبعت بالحرف بس (السعر/التوصيل/FIRST اتغيّر ⇒ مفيش سلة)؛ السلة بتتجرّب من غير حفظ، والحفظ خطوة لوحدها بنفس السعر", async () => {
  const people = { "501000055": { name: "تجربة ضغطة", orders: 12, spend: 520, daysAgo: 5, hist: [] } };
  const w = favWorld({ people });
  const seen = [];
  const assist = { build_cart: async (pn, input, o) => { seen.push({ pn, input, o }); return { ok: true, lines: [{ slug: "box-crepe-duo" }], subtotal: 65, ...(o.save ? { link: "https://freshcuts.sa/c/abc12345", code: "abc12345" } : {}) }; } };
  const t = await w.api.tapOffer("501000055", CREPE_FAV, { assist, sent: CREPE_SENT });
  assert.deepEqual([t.ok, t.cart, t.title, t.line, t.price, t.picks], [true, true, CREPE_SENT["offer.title"], CREPE_SENT["offer.line"], 65, ["كريب شيش طاووق", "كريب سوبر كرانشي", "بطاطس محمرة"]]);
  assert.equal(t.url, undefined, "مفيش رابط قبل الحفظ");
  assert.deepEqual(seen.map((x) => x.o), [{ save: false, source: "campaign" }], "التجربة من غير صف في wa_bot_carts");
  assert.equal(seen[0].input.boxes[0].choices.crepe1.product_id, "6");
  // الحفظ: نفس المدخلات، بمصدر campaign، ونفس السعر
  const sv = await w.api.saveCart("501000055", t, { assist });
  assert.deepEqual(sv, { ok: true, url: "https://freshcuts.sa/c/abc12345", code: "abc12345" });
  assert.deepEqual([seen[1].o, seen[1].input], [{ save: true, source: "campaign" }, t.cartInput]);
  assert.deepEqual(await w.api.saveCart("501000055", t, { assist: { build_cart: async () => ({ ok: true, lines: [{}], subtotal: 69, link: "x" }) } }), { ok: false, why: "cart_price_mismatch" });
  assert.deepEqual(await w.api.saveCart("501000055", t, { assist: { build_cart: async () => ({ ok: true, lines: [{}], subtotal: 65, saved: false, error_link: "cannot_save" }) } }), { ok: false, why: "cart:cannot_save" });
  // السعر اتغيّر بعد الإرسال (٦٥ ⇒ ٧٩): مفيش سلة بالسعر الجديد (الرسالة قالت ٦٥) — المراجعة: «العميل اللي جه على ٦٥ اتسلّم سلة بـ٧٩»
  const b2 = clone(FX.bundles); b2.find((x) => x.slug === "box-crepe-duo").price = 79; w.st.bundles = b2;
  assert.deepEqual(await w.api.tapOffer("501000055", CREPE_FAV, { assist, sent: CREPE_SENT }), { ok: false, why: "offer_changed" });
  w.st.bundles = FX.bundles;
  // FIRST اتستخدم من ساعتها ⇒ سطر التوصيل اتغيّر ⇒ مفيش سلة
  people["501000055"].firstUsed = true;
  assert.deepEqual(await w.api.tapOffer("501000055", CREPE_FAV, { assist, sent: CREPE_SENT }), { ok: false, why: "offer_changed" });
  people["501000055"].firstUsed = false;
  // صف من غير القيم اللي اتبعتت ⇒ مانعرفش اتقال إيه ⇒ مفيش سلة
  assert.deepEqual(await w.api.tapOffer("501000055", CREPE_FAV, { assist, sent: null }), { ok: false, why: "offer_missing" });
  // السلة طلعت بسعر تاني (زيادة اختيار مثلاً) ⇒ مانبعتش رابطها
  assert.deepEqual(await w.api.tapOffer("501000055", CREPE_FAV, { assist: { build_cart: async () => ({ ok: true, lines: [{}], subtotal: 69 }) }, sent: CREPE_SENT }), { ok: false, why: "cart_price_mismatch" });
  // بوكس من نوع أكله ⇒ من غير سلة، والرد بيفتح البوكس
  const catSpec = { kind: "box", slug: "box-solo-crepe", pid: "11", catOnly: true, sg: "crepe" };
  const catSent = { "offer.title": "بوكس يناسب ذوقك", "offer.line": "بوكس الكريب الفردي (كريب من اختيارك مع صنف جانبي ومشروب غازي) بسعر يبدأ من 29 ر.س، ونوصله لك أو تستلمه من فرعنا، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من 60 ر.س" };
  const cat = await w.api.tapOffer("501000055", catSpec, { assist, sent: catSent });
  assert.deepEqual([cat.ok, cat.cart, cat.boxSlug], [true, false, "box-solo-crepe"]);
  // الطبق خلص ⇒ مفيش عرض
  w.st.menu = menuOf({ soldOut: { 6: true } });
  assert.deepEqual(await w.api.tapOffer("501000055", CREPE_FAV, { assist, sent: CREPE_SENT }), { ok: false, why: "sold_out" });
});

test("مراجعة FD1 — «نعم» المكتوبة (yesGate): أول حاجة بعد رسالة الحملة بس — رسالة تانية من العميل، أو أي رسالة طلعت له، أو طلب من ساعتها ⇒ مش موافقة على العرض", async () => {
  const offer = { sentAt: ago(0.05), wamid: "wamid.CAMP7", fav: CREPE_FAV, values: CREPE_SENT };
  const people = { "501000055": { name: "تجربة ضغطة", orders: 12, spend: 520, daysAgo: 5, hist: [] } };
  const w = favWorld({ people });
  assert.equal(await w.api.yesGate("501000055", offer, { logId: 41 }), null);
  const i = w.calls.sql.indexOf(F.FAV_SQL.inboundSince), o = w.calls.sql.indexOf(F.FAV_SQL.outboundSince);
  assert.deepEqual(w.calls.params[i], ["501000055", 41, offer.sentAt], "رسالته هو نفسها مستثناة (logId)");
  assert.deepEqual(w.calls.params[o], ["501000055", offer.sentAt, "wamid.CAMP7"], "رسالة الحملة نفسها مستثناة (wamid)");
  people["501000055"].inboundSince = true;
  assert.equal(await w.api.yesGate("501000055", offer, { logId: 41 }), "not_first_reply");
  people["501000055"].inboundSince = false; people["501000055"].outboundSince = true;
  assert.equal(await w.api.yesGate("501000055", offer, { logId: 41 }), "chat_moved_on", "موظف رد / تحديث طلب / رد بوت بعد الحملة");
  people["501000055"].outboundSince = false; people["501000055"].orderedSince = true;
  assert.equal(await w.api.yesGate("501000055", offer, { logId: 41 }), "ordered_since");
  assert.equal(await w.api.yesGate("501000055", null, { logId: 41 }), "no_offer");
});

test("مراجعة FD1 — الكتالوج: كاش البوت لازم يكون محدّث (strict)، الباقة الموقوفة من البوابة بتختفي فوراً، والبوكس اللي مالوش توصيل مابيتعرضش", async () => {
  const w = favWorld({ people: PEOPLE() });
  await w.api.audienceRows();
  assert.ok(w.calls.live.length >= 3 && w.calls.live.every(([, o]) => o && o.strict === true), JSON.stringify(w.calls.live));
  // ⏸️ إيقاف من البوابة: بالـslug أو برقم العرض المربوط (settings.catalog.pausedOffers) — من غير ما نستنى كاش البوكسات
  const until = new Date(NOW + 3600_000).toISOString();
  const pz = favWorld({ people: PEOPLE(), settings: { catalog: { pausedOffers: { "box-pizza-pasta": { until } } } } });
  const g = await pz.api.globals();
  assert.equal(g.live.boxes.has("box-pizza-pasta"), false);
  const pk = favWorld({ people: PEOPLE(), settings: { catalog: { pausedOffers: { gathering_4: { until: null } } } } });
  assert.equal((await pk.api.globals()).live.boxes.has("gathering-4"), false);
  const old = favWorld({ people: PEOPLE(), settings: { catalog: { pausedOffers: { "box-pizza-pasta": { until: new Date(NOW - 60_000).toISOString() } } } } });
  assert.equal((await old.api.globals()).live.boxes.has("box-pizza-pasta"), true, "إيقاف خلص وقته");
  // البوكس اتوقف بعد ما الرسالة اتجهّزت ⇒ وقت الإرسال offer_gone
  const rows = await pz.api.audienceRows();
  assert.ok(!rows.some((r) => r.vars.fav.slug === "box-pizza-pasta"));
  // قنوات البوكس من غير توصيل ⇒ مايتعرضش (الرسالة بتقول «والتوصيل لعنوانك …»)
  const pick = clone(FX.bundles); pick.find((x) => x.slug === "box-crepe-duo").order_kinds = ["pickup", "dine_in"];
  assert.equal(liveOf({ bundles: pick }).boxes.has("box-crepe-duo"), false);
  assert.equal(liveOf().boxes.has("box-crepe-duo"), true);
});

test("مراجعة FD1 — الشريحة بتاخد فاصل الحملة: اللي برّاه مابيتحسبلوش عرض ولا سعر توصيل (نفس شرط applyFilters)", async () => {
  const people = PEOPLE();
  const w = favWorld({ people });
  const all = await w.api.audienceRows();
  const w2 = favWorld({ people });
  const win = await w2.api.audienceRows({ minDaysSince: 8, maxDaysSince: 90 });
  assert.deepEqual(win.map((r) => r.pn), all.filter((r) => r.daysAgo >= 8 && r.daysAgo <= 90).map((r) => r.pn));
  assert.equal(win.stats.excluded.outside_window >= 1, true);
  assert.ok(!w2.calls.quote.some((x) => x.lat === 21.6), "٥٠…٢٢ (آخر طلب من ٦ أيام) برّه الفاصل ⇒ مفيش quote");
  assert.deepEqual((await favWorld({ people }).api.audienceRows({ minDaysSince: "", maxDaysSince: null })).map((r) => r.pn), all.map((r) => r.pn), "فاضي = مفيش فلتر");
});

test("مراجعة FD1 — نص البوكسات: خانتين مشاوي «نص كيلو» = كيلو كامل («نوعين مشاوي نص كيلو لكل نوع»)، مش «نص كيلو من نوعين»", () => {
  const live = liveOf();
  const main = (spec) => F.renderPick(spec, live).main;
  assert.equal(main({ kind: "box", slug: "box-grill-half-half", pid: "97", catOnly: true, sg: "grill_kilo" }), "بوكس المشاوي نص ونص (نوعين مشاوي من اختيارك نص كيلو لكل نوع مع طبقين أرز وبطاطس وكولسلو) بـ125 ر.س");
  assert.equal(main({ kind: "box", slug: "box-family", pid: null, catOnly: true, sg: "grill_meal" }), "بوكس العائلة (نوعين مشاوي نص كيلو لكل نوع مع بيتزا وسط وباستا و3 أطباق أرز و4 مشروبات) بـ179 ر.س");
  assert.equal(main({ kind: "box", slug: "box-ribs-grill", pid: "100", sg: "grill_kilo", direct: true }), "بوكس الريش والمشاوي (ثلث كيلو ريش ونوعين مشاوي نص كيلو لكل نوع مع طبقين أرز وبطاطس و4 مشروبات) بـ189 ر.س");
  for (const b of live.boxes.values()) for (const fav of [null, "كباب مشوي"]) for (const sg of [null, "pizza", "pasta", "grill_kilo"]) {
    const t = F.BOX_COPY[b.slug] ? F.BOX_COPY[b.slug](fav, sg, null) : "";
    assert.ok(!/نص كيلو من نوعين/.test(t), `${b.slug}: ${t}`);
  }
});

test("مراجعة FD1 — سطر طويل: لو العرض + شرط FIRST عدّوا ٢٠٠ حرف ⇒ الصياغة الأقصر الصادقة (من غير FIRST) بدل ما العميل يقع", async () => {
  const people = { "501000066": { name: "تجربة سطر طويل", orders: 7, spend: 540, daysAgo: 9, hist: H([9, 70, "بيتزا تشيكن رانش - وسط"], [22, 70, "بيتزا تشيكن رانش - وسط"]) } };
  const long = clone(FX.bundles); const bx = long.find((x) => x.slug === "box-pizza-pasta"); bx.slots = bx.slots.filter((s) => s.key !== "coleslaw"); bx.name = "بوكس بيتزا وباستا لشخصين باسم طويل جداً جداً جداً للتجربة بس عشان السطر كله يعدّي الحد المسموح بيه في القالب";
  const w = favWorld({ people, bundles: long });
  const [r] = await w.api.audienceRows();
  assert.ok(r, "العميل مااتشالش");
  const line = r.vars.cloud.values["offer.line"];
  assert.ok([...line].length <= 200 && line.endsWith("، ونوصله لك أو تستلمه من فرعنا"), line);
  assert.deepEqual([r.favView.via, r.favView.short], [null, true]);
  assert.equal(await w.api.recheck({ id: 1, phone_norm: "501000066", vars: r.vars }), null, "نفس الصياغة وقت الإرسال");
});

test("delivery.quote cacheOnly: مسافة الطريق من كاش جوجل بس (drive.peek) — مفيش كاش ⇒ تقدير هوائي ومن غير أي نداء لجوجل", async () => {
  const calls = [];
  const drive = DD.makeDriveDistance({ keyFn: () => "k", log: () => {}, fetchImpl: async (u, i) => { calls.push(u); return { ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 4700, duration: "600s" }] }) }; } });
  const STORE = { lat: 21.5881404, lng: 39.1521236 }, to = { lat: 21.61, lng: 39.17 };
  const peekDrive = { get: async (from, t) => drive.peek(t) };
  const straight = D.haversineKm(STORE.lat, STORE.lng, to.lat, to.lng);
  const miss = await DD.resolveRouteKm({ cfg: FX.policy, straightKm: straight, from: STORE, to, drive: peekDrive });
  assert.deepEqual([miss.distanceSource, calls.length], ["straight", 0]);
  await drive.get(STORE, to);                                    // الدفع سأل جوجل مرة ⇒ الكاش اتملى
  const hit = await DD.resolveRouteKm({ cfg: FX.policy, straightKm: straight, from: STORE, to, drive: peekDrive });
  assert.deepEqual([hit.distanceSource, hit.routeKm, calls.length], ["google", 4.7, 1]);
});
