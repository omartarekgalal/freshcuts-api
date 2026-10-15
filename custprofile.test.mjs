/* CP1 (١٥/١٠) — تصنيف العملاء التلقائي: node --test custprofile.test.mjs
   كل البيانات مصطنعة (أرقام 5100001xx / 5200000xx، أسماء ومناطق عامة) — مفيش بيانات عميل حقيقية، ولا شبكة، ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";

const P = await import("./custprofile.js");
const W = await import("./whatsapp.js");
const C = await import("./wacloud.js");
const S = await import("./wasender.js");
const CAT = await import("./watemplates.js");
W.registerCatalog(CAT);
C.registerCampaignTemplates();

const NOW = Date.parse("2026-10-15T09:00:00Z");      // ١٢:٠٠ الرياض الخميس
const PN = "510000101";
const CFG = P.profileCfg({});
const LOY = { enabled: true, startedAt: "2026-09-11T00:00:00Z", every: 3, reward: "free_delivery", percent: 10, minTotal: 0 };

/* عميل مصطنع: ٣ طلبات من ٣ قنوات */
function sample(x = {}) {
  return {
    pn: PN, staff: false,
    names: [{ src: "ts", name: "عبد الله التجربة" }, { src: "web", name: "x" }],
    orders: [
      { at: "2026-10-10T20:00:00Z", total: 120, channel: "pos", service: "takeaway", items: [{ name: "كباب مشوي بالوزن - نص كيلو", qty: 2 }, { name: "مياه", qty: 1 }], discount: false },
      { at: "2026-10-02T19:00:00Z", total: 80, channel: "apps", app: "keeta", service: "delivery", items: [{ name: "كباب مشوي بالوزن - نص كيلو", qty: 1 }], discount: true },
      { at: "2026-09-25T10:00:00Z", total: 300, channel: "web", service: "delivery", coupon: "FIRST", discount: true, fee: 0, km: 4.2, far: false, district: "حي التجربة",
        items: [{ name: "كريب زنجر سوبريم", qty: 2 }, { name: "كفتة مشوية بالوزن - كيلو", qty: 2 }] },
    ],
    wa: { inbound: 2, ar: 3, en: 0, lastIn: "2026-10-12T18:00:00Z" },
    mkt: { at: "2026-10-09T12:00:00Z", channel: "whatsapp", ref: "wa:7", label: "حملة تجربة", cloudStatus: "read", replied: false, clicks: 0, tapped: false },
    mkt30: 2, loyaltyCount: 1, reward: null, firstUsed: true, webDeliv: 1,
    ...x,
  };
}
const CUTS = P.tierCuts([20, 40, 60, 80, 100, 120, 140, 160, 500, 2000], CFG);
const profile = (x, extra = {}) => P.finalizeProfile(P.computeProfile(sample(x), { cfg: CFG, now: NOW, trigger: "test", firstLive: true, loyalty: LOY, ...extra }), { cuts: CUTS, cfg: CFG, now: NOW });

// ───────── الإعدادات ─────────
test("الإعدادات: الافتراضي والحدود، والترتيب المكسور بيرجع للافتراضي؛ والحفظ من اللوحة من غير تقريب في صمت", () => {
  assert.equal(CFG.tierA, 10); assert.deepEqual(CFG.weekendDays, ["thu", "fri"]); assert.equal(CFG.nightlyHour, 5); assert.equal(CFG.groupOrderSar, 250);
  const x = P.profileCfg({ cms: { customerProfile: { tierA: 0, bigBillSar: "99999", weekendDays: ["fri", "sat", "xx"], lateStart: 21 } } });
  assert.deepEqual([x.tierA, x.bigBillSar, x.lateStart], [1, 2000, 21]); assert.deepEqual(x.weekendDays, ["fri", "sat"]);
  const broken = P.profileCfg({ cms: { customerProfile: { tierA: 40, tierB: 30 } } });
  assert.deepEqual([broken.tierA, broken.tierB, broken.tierC], [10, 30, 60]);
  const bad = P.cleanProfileSettings({ tierA: 70, nope: 1 }, {});
  assert.equal(bad.ok, false); assert.ok(bad.errors.some(([k]) => k === "nope")); assert.ok(bad.errors.some(([k]) => k === "tierA"));
  assert.ok(P.cleanProfileSettings({ activeDays: 50, riskDays: 40 }, {}).errors.some(([k]) => k === "recency"));
  assert.ok(P.cleanProfileSettings({ weekendDays: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }, {}).errors.some(([k]) => k === "weekendDays"));
  const ok = P.cleanProfileSettings({ bigBillSar: 180, weekendDays: ["wed", "thu"] }, {});
  assert.equal(ok.ok, true); assert.equal(ok.cfg.bigBillSar, 180); assert.deepEqual(ok.cfg.weekendDays, ["wed", "thu"]);
  for (const s of P.PROFILE_SCHEMA) assert.ok(s.ar && P.PROFILE_SETTING_GROUPS[s.group], s.key);
});

test("الساعة بتوقيت الرياض (نقطة البيع UTC) ويوم العمل بيقلب ٤ الفجر", () => {
  const c = P.riyadhClock("2026-10-15T19:30:00Z");
  assert.deepEqual([c.hour, c.bizDow, c.bizDay], [22, "thu", "2026-10-15"]);
  const n = P.riyadhClock("2026-10-15T22:30:00Z");      // ١:٣٠ فجر الجمعة ⇒ يوم عمل الخميس
  assert.deepEqual([n.hour, n.bizDow, n.bizDay], [1, "thu", "2026-10-15"]);
  assert.deepEqual([22, 1, 13, 19, 8].map((h) => P.daypartOf(h, CFG)), ["late", "late", "lunch", "dinner", "morning"]);
  assert.equal(P.kilosOf([{ name: "كفتة مشوية بالوزن - كيلو", qty: 2 }, { name: "كباب مشوي بالوزن - نص كيلو", qty: 1 }, { name: "مياه", qty: 3 }]), 2.5);
  assert.equal(P.firstNameOf("عبد الله التجربة"), "عبد الله"); assert.equal(P.firstNameOf("سارة"), "سارة"); assert.equal(P.firstNameOf(""), null);
});

// ───────── الحساب ─────────
test("ملف عميل: القيمة والحداثة والتكرار والقنوات والذوق والمواعيد والفاتورة والأسعار والولاء والتوصيل والتواصل وآخر رسالة", () => {
  const r = profile();
  assert.deepEqual([r.orders, r.spend, r.aov, r.max_ticket], [3, 500, 166.67, 300]);
  assert.deepEqual([r.value_tier, r.spend_pct], ["A", 94]);
  assert.deepEqual([r.days_since, r.recency_band, r.orders_90d, r.freq_band, r.avg_gap_days], [4, "active", 3, "regular", 7.7]);
  assert.deepEqual([r.pos_orders, r.web_orders, r.app_orders, r.main_channel, r.app_names, r.service_pref], [1, 1, 1, "web", "keeta", "delivery"]);
  assert.deepEqual([r.fav_dish, r.fav_weight, r.fav_category, r.fav_subcat, r.lean], ["كباب مشوي", "نصف كيلو", "grill", "grill", "grill"]);
  assert.deepEqual(r.cat_shares, { grill: 0.71, crepe: 0.29 });
  assert.deepEqual([r.late_night_share, r.lunch_share, r.dinner_share, r.daypart], [0.667, 0.333, 0, "late"]);
  assert.deepEqual([r.weekend_share, r.day_pref], [0.667, "weekend"]);
  assert.deepEqual([r.big_bill, r.group_order], [true, true]);
  assert.deepEqual([r.coupon_orders, r.used_first, r.discount_share, r.price_sensitivity, r.first_eligible], [0, true, 0.667, "medium", false]);
  assert.deepEqual([r.loyalty_orders, r.loyalty_left], [1, 2]);
  assert.deepEqual([r.delivery_orders, r.district, r.last_fee, r.last_km, r.fee_band], [1, "حي التجربة", 0, 4.2, "free"]);
  assert.deepEqual([r.lang, r.lang_src, r.wa_reach, r.wa_chat], ["ar", "wa_chat", "reachable", true]);
  assert.deepEqual([r.mkt_last_channel, r.mkt_last_result, r.mkt_30d], ["whatsapp", "ordered", 2]);      // طلب ١٠/١٠ خلال ٧ أيام من رسالة ٩/١٠
  assert.deepEqual([r.name, r.first_name, r.is_staff, r.trigger, r.orders_through], ["عبد الله التجربة", "عبد الله", false, "test", "2026-10-10T20:00:00.000Z"]);
  assert.deepEqual(r.segments, ["late_night", "weekend_regulars", "gatherings", "rising"]);
  for (const f of P.PROFILE_FIELDS) assert.ok(f.key in r, `field ${f.key} computed`);
  for (const [c] of P.PROFILE_COLS) assert.ok(c in r, `column ${c} computed`);
});

test("الحالات الحدّية: من غير طلبات، فريق، والوصول على واتساب بالأولوية", () => {
  const empty = profile({ orders: [], mkt: null, mkt30: 0, loyaltyCount: 0, firstUsed: false, webDeliv: 0 });
  assert.deepEqual([empty.orders, empty.value_tier, empty.recency_band, empty.freq_band, empty.daypart, empty.fee_band, empty.price_sensitivity, empty.first_eligible],
    [0, "none", "none", null, null, "none", null, true]);
  assert.deepEqual(empty.segments, []);
  const staff = profile({ staff: true });
  assert.deepEqual([staff.wa_reach, staff.segments], ["staff", []]);
  const reach = (wa) => profile({ wa: { inbound: 0, ...wa } }).wa_reach;
  assert.equal(reach({ optedOut: true, stopped: true, invalid: true }), "opted_out");
  assert.equal(reach({ stopped: true, invalid: true }), "stopped");
  assert.equal(reach({ marketingOff: true }), "stopped");
  assert.equal(reach({ invalid: true, appOnly: true }), "invalid");
  assert.equal(reach({ appOnly: true }), "app_only");
  assert.equal(profile({ wa: { en: 5, ar: 1 } }).lang, "en");
  // الرسالة اللي فشلت مابتتحسبش «طلب بعدها»، والضغط قبل الرد
  assert.equal(P.mktResultOf({ at: "2026-10-09T12:00:00Z", cloudStatus: "failed" }, [{ at: "2026-10-10T00:00:00Z" }]), "failed");
  assert.equal(P.mktResultOf({ at: "2026-10-01T12:00:00Z", clicks: 1, replied: true }, [{ at: "2026-10-10T00:00:00Z" }]), "tapped");
  assert.equal(P.mktResultOf({ at: "2026-10-01T12:00:00Z", replied: true, cloudStatus: "read" }, []), "replied");
  // حساسية السعر: كوبونين اختارهم بنفسه = عالية؛ ٣ طلبات كلها بخصم = عالية؛ من غير خصم = قليلة
  const plain = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ at: `2026-10-0${i + 1}T12:00:00Z`, total: 50, channel: "pos", items: [], ...extra }));
  assert.equal(profile({ orders: [...plain(1), { at: "2026-09-20T12:00:00Z", total: 60, channel: "web", coupon: "SAVE5", discount: true, items: [] }, { at: "2026-09-21T12:00:00Z", total: 60, channel: "web", coupon: "SAVE6", discount: true, items: [] }] }).price_sensitivity, "high");
  assert.equal(profile({ orders: plain(3, { discount: true }) }).price_sensitivity, "high");
  assert.equal(profile({ orders: plain(2) }).price_sensitivity, "low");
  assert.equal(profile({ orders: [{ at: "2026-09-20T12:00:00Z", total: 60, channel: "web", coupon: "FC1A2B3C4D", reward: true, discount: true, items: [] }, ...plain(1)] }).coupon_orders, 0);      // مكافأة الولاء مش «كوبون اختاره»
});

test("القيمة: حدود الشرايح من توزيع الإنفاق، والنسبة المئوية، ومن غير حدود = من غير شريحة", () => {
  assert.deepEqual([CUTS.a, CUTS.b, CUTS.c, CUTS.n], [500, 140, 100, 10]);
  assert.equal(CUTS.q.length, 101);
  const t = (spend) => P.applyTier({ orders: 1, spend }, CUTS).value_tier;
  assert.deepEqual([t(2000), t(500), t(140), t(100), t(40)], ["A", "A", "B", "C", "D"]);
  assert.equal(P.applyTier({ orders: 0, spend: 0 }, CUTS).value_tier, "none");
  assert.equal(P.applyTier({ orders: 2, spend: 90 }, null).value_tier, null);
  assert.equal(P.pctFromQ(1, CUTS.q), 0); assert.equal(P.pctFromQ(99999, CUTS.q), 100);
  assert.equal(P.tierCuts([0, 0], CFG), null);
});

test("الشرايح المشتقّة: كبار غايبين، جاهزين لأول طلب من الموقع، الغدا، والعروض — وشرايح اللوحة p_* بتقرا العضوية من الملف", () => {
  const lapsed = profile({ orders: [{ at: "2026-09-10T19:00:00Z", total: 300, channel: "pos", items: [] }, { at: "2026-08-01T10:00:00Z", total: 300, channel: "pos", items: [] }] });
  assert.equal(lapsed.recency_band, "at_risk"); assert.ok(lapsed.segments.includes("big_lapsed")); assert.ok(!lapsed.segments.includes("rising"));
  const ready = profile({ firstUsed: false, webDeliv: 0, orders: [{ at: "2026-10-05T10:00:00Z", total: 40, channel: "pos", items: [] }, { at: "2026-10-01T11:00:00Z", total: 40, channel: "pos", items: [] }] });
  assert.equal(ready.first_eligible, true); assert.ok(ready.segments.includes("first_ready")); assert.ok(ready.segments.includes("lunch_regulars"));
  assert.ok(!profile({ firstUsed: false, webDeliv: 0 }, { firstLive: false }).first_eligible, "FIRST مقفول ⇒ مش متاح لحد");
  const segs = P.profileCmsSegments(() => CFG);
  assert.deepEqual(segs.map((s) => s.id), P.SEG_IDS.map((id) => `p_${id}`));
  assert.match(segs[0].hint, /من ملف العميل المصنّف: .*22:00/);
  assert.equal(segs[0].test({ psegs: ["late_night"] }), true); assert.equal(segs[0].test({ psegs: [] }), false); assert.equal(segs[0].test({}), false);
  for (const s of P.segmentsView(CFG)) assert.ok(s.label && s.hint && s.icon, s.id);
});

test("التجميع: طلب الموقع ونسخته في نقطة البيع (External) بيتعدّوا مرة، والقنوات والخدمة من نوع الطلب", () => {
  const m = P.assemble({ pns: [PN, "510000102"],
    pos: [
      { pn: PN, order_id: "9001", at: "2026-10-01T15:30:00Z", total: 99, discount_incl: 0, order_type: "External Partner", order_option: "توصيل Delivery", payments: {}, items: [{ name: "بيتزا مارجريتا", qty: 1 }] },
      { pn: PN, order_id: "9002", at: "2026-10-03T18:00:00Z", total: 45, discount_incl: 5, order_type: "Normal", order_option: "Dine in", payments: {}, items: [{ name: "كريب زنجر سوبريم", qty: 1 }] },
      { pn: "510000199", order_id: "9003", at: "2026-10-03T18:00:00Z", total: 45, order_type: "Normal", order_option: "Take away", payments: {}, items: [] },
    ],
    web: [{ pn: PN, order_no: "W100", at: "2026-10-01T15:00:00Z", total: 99, coupon: "first", option: "delivery", table_no: 0, q_fee: "9", q_km: "6.5", q_far: false, district: "حي التجربة",
      items: [{ name: "بيتزا مارجريتا", variant_name: "وسط", quantity: 1 }] }],
    optins: [{ pn: PN, stopped_at: null, marketing_off_at: null, marketing: true }],
    contacts: [{ pn: "510000102", opted_out_at: "2026-09-01T00:00:00Z", is_staff: false }],
    mkt: [{ pn: PN, at: "2026-09-30T12:00:00Z", ch: "sms", ref: "sms:3", label: "SMS", cs: null, replied: false, clicks: 0, tapped: false, n30: 1 }],
    webAgg: [{ pn: PN, n: 1, deliv: 1 }], firstUsed: [{ pn: PN }], rewards: [{ pn: PN, code: "FCAAAA0000", expires: "2026-10-20" }],
  });
  const x = m.get(PN);
  assert.equal(x.orders.length, 2, "External mirror of W100 dropped");
  const web = x.orders.find((o) => o.channel === "web"), pos = x.orders.find((o) => o.channel === "pos");
  assert.deepEqual([web.coupon, web.fee, web.km, web.service, web.items[0].name], ["FIRST", 9, 6.5, "delivery", "بيتزا مارجريتا - وسط"]);
  assert.deepEqual([pos.service, pos.discount], ["dine_in", true]);
  assert.deepEqual([x.wa.optin, x.firstUsed, x.webDeliv, x.reward.code, x.mkt30], [true, true, 1, "FCAAAA0000", 1]);
  assert.equal(m.get("510000102").wa.optedOut, true);
  assert.equal(m.has("510000199"), false, "رقم مش مطلوب مايدخلش");
  const r = P.computeProfile(x, { cfg: CFG, now: NOW, loyalty: LOY });
  assert.deepEqual([r.reward_code, r.reward_expires, r.service_pref], ["FCAAAA0000", "2026-10-20", "delivery"]);
});

// ───────── الفلتر ─────────
test("فلتر الاستهداف: التنظيف (قيم معروفة بس) والمطابقة (قوايم، منطقي، نطاقات، شرايح، حي، أيام من آخر رسالة)", () => {
  const r = profile();
  const nf = P.normalizeProfileFilter({ value_tier: ["A", "B"], fav_category: "grill", big_bill: true, late_night_share_min: 0.5, segments: ["late_night"], district: ["حي التجربة"] });
  assert.equal(nf.ok, true);
  assert.deepEqual(nf.filter, { value_tier: ["A", "B"], fav_category: ["grill"], big_bill: true, late_night_share: { min: 0.5 }, segments: ["late_night"], district: ["حي التجربة"] });
  assert.equal(P.matchProfile(r, nf.filter, NOW), true);
  assert.equal(P.matchProfile({ ...r, big_bill: false }, nf.filter, NOW), false);
  assert.equal(P.matchProfile({ ...r, value_tier: "C" }, nf.filter, NOW), false);
  assert.equal(P.matchProfile({ ...r, late_night_share: 0.4 }, nf.filter, NOW), false);
  assert.equal(P.matchProfile({ ...r, segments: [] }, nf.filter, NOW), false);
  for (const bad of [{ value_tier: ["Z"] }, { nope: 1 }, { orders_min: -1 }, { orders: { min: 5, max: 2 } }, { big_bill: "yes" }, { segments: ["x"] }, [1], "x"]) {
    assert.equal(P.normalizeProfileFilter(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(P.normalizeProfileFilter(null).filter, {});
  const quiet = P.normalizeProfileFilter({ mkt_days_min: 7 }).filter;
  assert.equal(P.matchProfile({ ...r, mkt_last_at: "2026-10-10T09:00:00Z" }, quiet, NOW), false);      // اتبعتله من ٥ أيام
  assert.equal(P.matchProfile({ ...r, mkt_last_at: null }, quiet, NOW), true);                         // عمره ما اتبعتله
  assert.equal(P.matchProfile({ ...r, days_since: null }, P.normalizeProfileFilter({ days_since_max: 30 }).filter, NOW), false);
  assert.equal(P.matchProfile(r, P.normalizeProfileFilter({ has_reward: false, wa_reach: ["reachable"] }).filter, NOW), true);
});

// ───────── قيم الرسالة ─────────
const MENU = { items: [{ id: 101, name: "كباب مشوي بالوزن", category: "Grills by the Kilo", price: 45, byWeight: true, weights: [{ variant_option_id: 7, label_ar: "نص كيلو", price: 45 }] },
  { id: 200, name: "طبق أرز بسمتي", category: "Sides & Drinks", price: 8 }] };
const BOXES = [{ slug: "box-solo-grill-test", name: "بوكس المشاوي الفردي", price: 59, section: "فردي",
  slots: [{ key: "main", type: "choice", quantity: 1, choices: [{ product_id: 101, name: "كباب مشوي", variant_option_id: 7, variant_name: "نص كيلو" }] },
    { key: "side", type: "fixed", quantity: 1, item: { product_id: 200, name: "طبق أرز بسمتي" } }] }];
const { buildLive } = await import("./wafavpick.js");
const LIVE = buildLive({ menu: MENU, bundles: BOXES, offers: [], now: NOW });

test("قيم الرسالة لكل مستلم: الطبق بوزنه، البوكس الشغّال، سطر التوصيل من غير رسوم، الولاء — والناقص بيطلّع العميل", () => {
  const r = profile();
  const vals = { "offer.title": "طبقك المفضل", "offer.line": "{fav_dish_weight} جاهز لك، {fee_line}" };
  const a = P.resolveProfileValues(vals, r, { firstLive: true, firstMin: 60 });
  assert.equal(a.ok, true);
  assert.deepEqual(a.values, { "offer.line": "كباب مشوي نص كيلو جاهز لك، ونوصله لك أو تستلمه من فرعنا" });      // الخانة الثابتة مابترجعش
  const eligible = { ...r, first_eligible: true };
  const f = P.resolveProfileValues({ "offer.line": "{fee_line}" }, eligible, { firstLive: true, firstMin: 60 });
  assert.equal(f.values["offer.line"], "ونوصله لك أو تستلمه من فرعنا، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من 60 ر.س");
  assert.deepEqual(f.uses, { firstHint: true });
  assert.equal(P.resolveProfileValues({ "offer.line": "{fee_line}" }, eligible, { firstLive: false }).values["offer.line"], "ونوصله لك أو تستلمه من فرعنا");
  const box = P.resolveProfileValues({ "offer.title": "{fav_box}" }, r, { live: LIVE });
  assert.deepEqual([box.ok, box.values["offer.title"], box.uses.box], [true, "بوكس المشاوي الفردي", "box-solo-grill-test"]);
  assert.equal(P.resolveProfileValues({ "offer.title": "{fav_box}" }, r, { live: null }).why, "fav_box:catalog_unavailable");
  assert.equal(P.resolveProfileValues({ "offer.title": "{fav_box}" }, { ...r, fav_dish: "كريب زنجر سوبريم" }, { live: LIVE }).why, "fav_box:no_box");
  assert.equal(P.resolveProfileValues(vals, { ...r, fav_dish: null }, {}).why, "fav_dish_weight:no_fav_dish");
  assert.equal(P.resolveProfileValues(vals, null, {}).why, "fav_dish_weight:no_profile");
  const loy = P.resolveProfileValues({ "offer.line": "{loyalty_line}" }, r, { loyalty: LOY });
  assert.deepEqual([loy.values["offer.line"], loy.uses.loy], ["باقي لك طلبين من الموقع وتكسب توصيل مجاني", 2]);
  assert.equal(P.loyaltyLineOf(1, { ...LOY, minTotal: 60 }), "باقي لك طلب واحد من الموقع وتكسب توصيل مجاني للطلبات من 60 ر.س");
  assert.equal(P.resolveProfileValues({ "offer.line": "{loyalty_line}" }, r, { loyalty: { enabled: false } }).why, "loyalty_line:no_loyalty");
  assert.equal(P.resolveProfileValues({ "offer.line": "{fee_line} {fee_line} {fee_line}" }, r, { fieldMax: { "offer.line": 60 } }).why, "offer.line:too_long");
  assert.equal(P.resolveProfileValues({ "x": "{first_name}" }, { ...r, first_name: null }, {}).values.x, "عميلنا");
  assert.deepEqual(P.profileTokensIn({ a: "{fav_dish} و{fee_line}", b: "ثابت", c: "{fav_dish}" }).sort(), ["fav_dish", "fee_line"]);
  assert.deepEqual(P.exampleProfileValues({ a: "{fav_dish} اليوم", b: "ثابت" }), { a: "كريب زنجر سوبريم اليوم" });
});

test("صف من Postgres: NUMERIC نص ⇒ رقم، التواريخ ⇒ ISO، الشرايح الفاضية ⇒ []", () => {
  const r = P.fromDb({ phone_norm: PN, spend: "123.45", orders: 3, late_night_share: "0.500", computed_at: new Date("2026-10-15T02:00:00Z"), reward_expires: "2026-10-20", segments: null, cat_shares: { grill: 1 } });
  assert.deepEqual([r.spend, r.orders, r.late_night_share, r.computed_at, r.reward_expires, r.segments, r.cat_shares.grill], [123.45, 3, 0.5, "2026-10-15T02:00:00.000Z", "2026-10-20", [], 1]);
  assert.match(P.PROFILE_UPSERT_SQL, /jsonb_populate_recordset\(NULL::cust_profile/);
  assert.ok(P.PROFILE_DDL.some((d) => /ADD COLUMN IF NOT EXISTS segments TEXT\[\]/.test(d)));
});

// ───────── التشغيل (قاعدة مزيّفة) ─────────
function fakeApp() { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; }
const callR = (app, route, { json = {}, param = {}, query = {} } = {}) => app.routes[route]({
  req: { json: async () => json, param: (n) => param[n], query: (n) => query[n], header: () => undefined, path: route.split(" ")[1], method: route.split(" ")[0] },
  json: (body, status = 200) => ({ body, status }), set() {}, get() {} });

function runtime({ owner = true } = {}) {
  const db = { upserts: [], state: { id: 1, cuts: null, full_at: null, ts_cursor: null, src_cursor: null, shop_cursor: null }, runs: [], settingsWrites: [], sql: [] };
  const POS = [
    { pn: PN, order_id: "9002", at: "2026-10-10T20:00:00Z", total: 120, discount_incl: 0, order_type: "Normal", order_option: "Take away", payments: {}, items: [{ name: "كباب مشوي بالوزن - نص كيلو", qty: 2 }] },
    { pn: "510000102", order_id: "9003", at: "2026-06-01T12:00:00Z", total: 40, discount_incl: 0, order_type: "Normal", order_option: "Dine in", payments: {}, items: [{ name: "كريب زنجر سوبريم", qty: 1 }] },
  ];
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^(CREATE|ALTER|INSERT INTO cust_profile_state)/.test(s)) return { rows: [] };
    if (/json_agg.* FROM ts_orders o LEFT JOIN order_sources s/.test(s)) return { rows: POS };
    if (/AS q_fee/.test(s)) return { rows: [] };
    if (/FROM cms_contacts WHERE phone_norm ~/.test(s)) return { rows: [{ pn: PN }, { pn: "510000102" }, { pn: "510000103" }] };
    if (/'acct' src/.test(s)) return { rows: [{ pn: PN, src: "acct", name: "سارة التجربة" }] };
    if (/FROM wa_optins/.test(s)) return { rows: [] };
    if (/FROM cms_contacts WHERE phone_norm = ANY/.test(s)) return { rows: [{ pn: "510000103", is_staff: true }] };
    if (/WHERE upper\(code\)='FIRST' AND phone_norm IS NULL/.test(s)) return { rows: [{ code: "FIRST", active: true, min_total: 60, free_delivery: true, percent: 0, expires_at: null }] };
    if (/^SELECT \* FROM cust_profile_state/.test(s)) return { rows: [db.state] };
    if (/^UPDATE cust_profile_state SET cuts/.test(s)) { db.state.cuts = JSON.parse(p[0]); db.state.full_at = new Date(NOW).toISOString(); return { rows: [] }; }
    if (/^INSERT INTO cust_profile SELECT/.test(s)) { db.upserts.push(...JSON.parse(p[0])); return { rows: [] }; }
    if (/^INSERT INTO cust_profile_runs/.test(s)) { db.runs.push(p); return { rows: [] }; }
    if (/^SELECT \* FROM cust_profile WHERE orders > 0/.test(s)) return { rows: db.upserts.filter((r) => r.orders > 0).map((r) => ({ ...r, spend: String(r.spend) })) };
    if (/^SELECT \* FROM cust_profile WHERE phone_norm = ANY/.test(s)) return { rows: db.upserts.filter((r) => p[0].includes(r.phone_norm)) };
    if (/^SELECT phone_norm FROM c360_refs WHERE ref=\$1/.test(s)) return { rows: p[0] === "c0123456789abcde" ? [{ phone_norm: PN }] : [] };
    if (/^UPDATE settings SET data = jsonb_set/.test(s)) { db.settingsWrites.push(JSON.parse(p[0])); return { rows: [], rowCount: 1 }; }
    if (/^SELECT count\(\*\)::int n, count\(\*\) FILTER \(WHERE orders > 0\)/.test(s)) return { rows: [{ n: db.upserts.length, buyers: db.upserts.filter((r) => r.orders > 0).length, last: null }] };
    return { rows: [] };
  } };
  const app = fakeApp();
  const settings = { cms: { loyalty: { enabled: true, every: 3, startedAt: "2026-09-11T00:00:00Z" } } };
  const api = P.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => settings, log: { log() {}, error() {} } },
    { now: () => NOW, jobs: false, whoami: async () => (owner ? { role: "owner", name: "المالك" } : { role: "marketing" }) });
  return { db, app, api };
}

test("الحساب الكامل: كل الأرقام (طلبات + الدليل)، الحدود بتتحفظ، صف لكل رقم بالفريق محسوب، وسجل للدورة", async () => {
  const w = runtime();
  const r = await w.api.rebuild(null, "nightly");
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.phones, 3);
  const by = Object.fromEntries(w.db.upserts.map((x) => [x.phone_norm, x]));
  assert.deepEqual(Object.keys(by).sort(), [PN, "510000102", "510000103"]);
  assert.deepEqual([by[PN].name, by[PN].first_name, by[PN].orders, by[PN].fav_dish, by[PN].fav_weight, by[PN].first_eligible], ["سارة التجربة", "سارة", 1, "كباب مشوي", "نصف كيلو", true]);
  assert.deepEqual([by["510000102"].recency_band, by["510000103"].orders, by["510000103"].wa_reach, by["510000103"].value_tier], ["lost", 0, "staff", "none"]);
  assert.equal(by[PN].loyalty_left, 3, "loyalty on with 0 web orders ⇒ 3 left");
  assert.ok(w.db.state.cuts && w.db.state.cuts.q.length === 101);
  assert.equal(w.db.runs.length, 1); assert.equal(w.db.runs[0][0], "nightly");
});

test("المسارات: بنّاء الجمهور (عدد + عينة)، ملف عميل بالـref، الإعدادات للمالك بس وبتتحقق، والفلتر الغلط 422", async () => {
  const w = runtime();
  await w.api.rebuild(null, "nightly");
  const cnt = await callR(w.app, "GET /api/cms/customers/profiles/count", { query: { f: JSON.stringify({ fav_category: ["grill"] }) } });
  assert.equal(cnt.status, 200, JSON.stringify(cnt.body));
  assert.deepEqual([cnt.body.total, cnt.body.matched, cnt.body.reachable], [2, 1, 1]);      // الفريق بره العدّ
  assert.equal(cnt.body.sample[0].favDish, "كباب مشوي");
  assert.equal((await callR(w.app, "GET /api/cms/customers/profiles/count", { query: { f: "{bad" } })).status, 400);
  assert.equal((await callR(w.app, "GET /api/cms/customers/profiles/count", { query: { f: JSON.stringify({ value_tier: ["Q"] }) } })).status, 422);
  const pr = await callR(w.app, "GET /api/cms/customers/profile/:ref", { param: { ref: "c0123456789abcde" } });
  assert.equal(pr.status, 200); assert.equal(pr.body.profile.fields.fav_dish, "كباب مشوي"); assert.equal(pr.body.tokens.fav_dish_weight, "كباب مشوي نص كيلو");
  assert.equal(pr.body.tokens.fav_box, null, "من غير كاش البوت مفيش بوكس");
  assert.equal((await callR(w.app, "GET /api/cms/customers/profile/:ref", { param: { ref: "c000" } })).status, 404);
  const fields = await callR(w.app, "GET /api/cms/customers/profile-fields");
  assert.equal(fields.body.fields.length, P.PROFILE_FIELDS.length); assert.equal(fields.body.tokens.length, P.PROFILE_TOKENS.length);
  const sch = await callR(w.app, "GET /api/cms/customers/profile-settings");
  assert.equal(sch.body.canEdit, true); assert.equal(sch.body.settings.find((x) => x.key === "bigBillSar").value, 150);
  assert.equal((await callR(w.app, "POST /api/cms/customers/profile-settings", { json: { tierA: 99 } })).status, 422);
  const ok = await callR(w.app, "POST /api/cms/customers/profile-settings", { json: { bigBillSar: 200 } });
  assert.equal(ok.status, 200); assert.equal(w.db.settingsWrites.at(-1).bigBillSar, 200);
  const mk = runtime({ owner: false });
  assert.equal((await callR(mk.app, "POST /api/cms/customers/profile-settings", { json: { bigBillSar: 200 } })).status, 403);
  assert.equal((await callR(mk.app, "POST /api/cms/customers/profiles/rebuild")).status, 403);
  assert.equal((await callR(mk.app, "GET /api/cms/customers/profile-settings")).body.canEdit, false);
});

// ───────── حملات واتساب (wasender + wacloud) ─────────
test("campaignParams: خانة فيها {token} قيمتها من صف المستلم بس — صف من غير قيمته مايطلعش بالنص الخام", () => {
  const job = { link_slug: "w9", cloud_vars: { values: { "offer.title": "طبقك المفضل", "offer.line": "{fav_dish} جاهز لك" }, profileVars: true } };
  const ok = C.campaignParams("fc_frame_ask_text", { vars: { first_name: "سارة", cloud: { values: { "offer.line": "كباب مشوي جاهز لك" } } }, link_code: "abc123" }, job);
  assert.match(ok.text, /طبقك المفضل: كباب مشوي جاهز لك\./);
  const miss = C.campaignParams("fc_frame_ask_text", { vars: { first_name: "سارة" }, link_code: "abc123" }, job);
  assert.ok(!JSON.stringify(miss.params).includes("{fav_dish}"), "raw token never reaches the params");
  const plain = C.campaignParams("fc_frame_ask_text", { vars: {}, link_code: "x" }, { link_slug: "w9", cloud_vars: { values: { "offer.title": "بوكسات", "offer.line": "{fav_dish}" } } });
  assert.match(plain.text, /\{fav_dish\}/, "حملة قديمة من غير profileVars زي ما هي (jobInput بيمنعها من الأساس)");
});

test("jobInput: قيم ملف العميل في قالب كتالوج ⇒ profileVars؛ متغيّر مش معروف أو قالب قديم = خطأ؛ وFD1 زي ما هو", () => {
  const HOSTS = ["freshcuts-api.o2m8.me", "freshcuts.sa"];
  const ok = S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "طبقك المفضل", "offer.line": "{fav_dish_weight}، {fee_line}" } }, fallback: "sms" }, { hosts: HOSTS });
  assert.deepEqual(ok.errs, []); assert.equal(ok.profileVars, true); assert.equal(ok.cloudVars.profileVars, true); assert.equal(ok.fallback, "none");
  const unknown = S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "{favdish}", "offer.line": "x" } } }, { hosts: HOSTS });
  assert.equal(unknown.errs[0][0], "unknown_var");
  const legacy = S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_offer_img", imageUrl: "https://freshcuts-api.o2m8.me/api/content/media/1.jpg", cloudVars: { offer: "{fav_dish} بـ45" } }, { hosts: HOSTS });
  assert.equal(legacy.errs[0][0], "profile_vars_catalog");
  const plain = S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "بوكسات", "offer.line": "من 29 ر.س" } } }, { hosts: HOSTS });
  assert.equal(plain.profileVars, false); assert.equal(plain.cloudVars.profileVars, undefined);
  const fav = S.jobInput({ channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "{fav_dish}" } }, filters: { audience: "fav_pick" } }, { hosts: HOSTS });
  assert.deepEqual([fav.perRecipient, fav.profileVars], [true, false]);
});

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN"];
const withEnv = (vals, fn) => async () => { const saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const ALLOW = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_ENABLED: "1" };
const GREEN = { phoneInfo: async () => ({ ok: true, status: "CONNECTED", quality: "GREEN", tier: "TIER_250", portfolio: { ok: true, limit: "TIER_250" }, checkedAt: new Date(NOW).toISOString() }), templateInfo: async () => ({ ok: true, list: [] }) };
const callW = (app, route, { json = {}, auth = "Bearer admin" } = {}) => app.routes[route]({
  req: { json: async () => json, header: (n) => (String(n).toLowerCase() === "authorization" ? auth : undefined), query: () => undefined, param: () => undefined }, json: (body, status = 200) => ({ body, status }) });

/* ٤ عملاء في الشريحة: ٣ ليهم ملف (٢ مشاوي، ١ كريب من غير طبق مفضّل) و١ لسه مالوش ملف */
function waWorld({ queue = [], jobs = [] } = {}) {
  const db = { jobs, queue, settings: { waCloud: { enabled: true }, waSender: { startHour: 0, endHour: 24 }, waMaster: { enabled: true }, notifications: { whatsappEnabled: true }, waBot: { testPhones: ["0544775000"] } },
    optins: {}, newJobs: [], queued: [], sql: [] };
  const qrow = (id) => db.queue.find((q) => q.id === Number(id));
  const job = (id) => db.jobs.find((j) => j.id === Number(id));
  const pool = { connect: async () => ({ query: (s, p) => pool.query(s, p), release() {} }), async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^SELECT \* FROM wa_sender_state WHERE id=\$1/i.test(s)) return { rows: [{ stopped_reason: null, warmup: { step: 3, since: "2026-09-01", startedAt: "2026-09-01" } }] };
    if (/^INSERT INTO wa_send_jobs/i.test(s)) { db.newJobs.push(p); return { rows: [{ id: 77 }] }; }
    if (/^INSERT INTO wa_send_queue\(job_id, phone_norm, name, message, score, status/i.test(s)) { db.queued.push({ pn: p[1], message: p[3], status: p[5], vars: JSON.parse(p[9]) }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT id, spend_cap_sar, rate_sar, cloud_template, brake_ack_at FROM wa_send_jobs WHERE status='running'/i.test(s)) return { rows: db.jobs.filter((j) => j.status === "running") };
    if (/^UPDATE wa_send_queue SET status='sending'/i.test(s)) { const q = db.queue.find((x) => x.status === "pending"); if (!q) return { rows: [] }; q.status = "sending"; q.attempts = (q.attempts || 0) + 1; return { rows: [q] }; }
    if (/^SELECT id, cloud_template, cloud_vars, image_url, video_url/i.test(s)) return { rows: [job(p[0])] };
    if (/^UPDATE wa_send_queue SET status='skipped', reason=\$2 WHERE id/i.test(s)) { Object.assign(qrow(p[0]), { status: "skipped", reason: p[1] }); return { rows: [] }; }
    if (/^UPDATE wa_send_queue SET status='sent'/i.test(s)) { Object.assign(qrow(p[0]), { status: "sent" }); return { rows: [], rowCount: 1 }; }
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/^SELECT 1 FROM cms_links WHERE slug=\$1/i.test(s)) return { rows: [], rowCount: 0 };
    if (/AS invalid, \(SELECT count/i.test(s)) return { rows: [{ invalid: 0, replies7: 0, optouts7: 0 }] };
    return { rows: [], rowCount: 0 };
  } };
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.T${calls.length}` }] }) }; };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const people = ["520000001", "520000002", "520000003", "520000004"];
  const rows = people.map((pn, i) => ({ pn, name: `تجربة ${i}`, orders: 2, spend: 100, daysAgo: 30, lastTotal: 60, score: 10 - i, vars: { first_name: `تجربة${i}` } }));
  const PROFILES = {
    520000001: { ...profile(), phone_norm: "520000001" },
    520000002: { ...profile(), phone_norm: "520000002", fav_dish: "كفتة مشوية", fav_weight: "كيلو", first_eligible: true },
    520000003: { ...profile(), phone_norm: "520000003", fav_category: "crepe", fav_dish: null },
  };
  const prof = {
    phones: async () => people,
    profilesFor: async (pns) => new Map(pns.filter((pn) => PROFILES[pn]).map((pn) => [pn, PROFILES[pn]])),
    normalizeFilter: P.normalizeProfileFilter, match: P.matchProfile, resolveValues: P.resolveProfileValues,
    tokenContext: async ({ needBox, fieldMax }) => ({ firstLive: true, firstMin: 60, loyalty: { enabled: false }, live: needBox ? LIVE : null, fieldMax }),
    recheckRow: async (q) => (q.vars && q.vars.prof && q.vars.prof.box === "gone-box" ? "profile_box_gone" : null),
  };
  const outreach = { AUDIENCES: { lapsed: { label: "غايبين" } }, audienceRows: async (aud, o = {}) => rows.filter((r) => !o.segmentPhones || o.segmentPhones.has(r.pn)), cfg: async () => ({ template: "أهلاً {name}" }) };
  const app = fakeApp();
  const api = S.register(app, ctx, { wa, fetch, outreach, cloudLoop: false, lock: false, now: () => NOW, cms: () => null, cloud: () => GREEN, profile: () => prof,
    sessionUser: async () => ({ name: "عمر", role: "owner" }) });
  return { db, app, api, calls };
}
const FRAME = { channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "طبقك المفضل", "offer.line": "{fav_dish_weight} جاهز لك اليوم، {fee_line}" } } };

test("المعاينة: فلتر ملف العميل فوق الشريحة (اللي مالوش ملف بيتعدّ لوحده) + شريحة «كل العملاء»", withEnv(ALLOW, async () => {
  const w = waWorld();
  const list = (await callW(w.app, "GET /api/cms/wa-sender")).body;
  assert.ok(list.audiences.some((a) => a.id === "profile_all")); assert.equal(list.profileTokens.length, P.PROFILE_TOKENS.length);
  const r = await callW(w.app, "POST /api/cms/wa-sender/preview", { json: { channel: "wa_cloud", cloudTemplate: "fc_frame_ask_text", cloudVars: { values: { "offer.title": "بوكسات", "offer.line": "من 29 ر.س" } },
    filters: { audience: "profile_all", profile: { fav_category: ["grill"] } } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.inAudience, r.body.afterFilters, r.body.willQueue], [4, 2, 2]);
  assert.deepEqual(r.body.profile, { filter: { fav_category: ["grill"] }, missing: 1, notMatched: 1, matched: 2 });
  const bad = await callW(w.app, "POST /api/cms/wa-sender/preview", { json: { ...FRAME, filters: { audience: "lapsed", profile: { value_tier: ["Z"] } } } });
  assert.equal(bad.status, 422); assert.equal(bad.body.error, "bad_profile_filter");
}));

test("المعاينة والبدء: قيم لكل مستلم من ملفه — اللي قيمته ناقصة بيطلع، والطابور بيتخزّن فيه القيم + اللي يتراجع وقت الإرسال", withEnv(ALLOW, async () => {
  const w = waWorld();
  const pv = await callW(w.app, "POST /api/cms/wa-sender/preview", { json: { ...FRAME, filters: { audience: "lapsed", limit: 50 } } });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.profileVars, true);
  assert.equal(pv.body.willQueue, 2, "520000003 (مالوش طبق مفضّل) و520000004 (مالوش ملف) بره");
  assert.equal(pv.body.excluded.profileValue, 2);
  assert.deepEqual(pv.body.profile.values.missing, { "fav_dish_weight:no_fav_dish": 1, "fav_dish_weight:no_profile": 1 });
  assert.match(pv.body.sample[0].cloud.text, /طبقك المفضل: كباب مشوي نص كيلو جاهز لك اليوم، ونوصله لك أو تستلمه من فرعنا\./);
  assert.match(pv.body.sample[1].cloud.text, /كفتة مشوية كيلو جاهز لك اليوم، ونوصله لك أو تستلمه من فرعنا، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من 60 ر.س/);
  const job = await callW(w.app, "POST /api/cms/wa-sender/jobs", { json: { ...FRAME, name: "طبقك من الملف", filters: { audience: "lapsed", limit: 50 }, confirmCount: 2 }, auth: "Bearer cms:own" });
  assert.equal(job.status, 200, JSON.stringify(job.body));
  const cloudVars = JSON.parse(w.db.newJobs[0][11]);
  assert.equal(cloudVars.profileVars, true);
  assert.equal(w.db.queued.length, 2);
  assert.equal(w.db.queued[1].vars.cloud.values["offer.line"], "كفتة مشوية كيلو جاهز لك اليوم، ونوصله لك أو تستلمه من فرعنا، والتوصيل مجاني بكود FIRST داخل نطاق التوصيل لو طلبك من 60 ر.س");
  assert.deepEqual(w.db.queued[1].vars.prof, { firstHint: true });
  assert.match(w.db.queued[0].message, /كباب مشوي نص كيلو/, "نص الصف = اللي هيتبعت فعلاً");
  assert.equal(w.calls.length, 0, "البدء مابيبعتش حاجة لوحده");
}));

test("وقت الإرسال: قيمة اتغيّرت (البوكس اتوقف) ⇒ الصف يتخطّى بسببها، والباقي بيتبعت بقيمه", withEnv(ALLOW, async () => {
  const J = { id: 1, status: "running", channel: "wa_cloud", cloud_template: "fc_frame_ask_text", cloud_vars: { values: FRAME.cloudVars.values, profileVars: true }, image_url: null, video_url: null,
    link_slug: "w1", offer: null, fallback: "none", spend_cap_sar: null, rate_sar: 0.2, brake_ack_at: null };
  const Q = (id, prof) => ({ id, job_id: 1, phone_norm: `52000010${id}`, status: "pending", channel: "wa_cloud", name: "تجربة", link_code: `c${id}`, coupon: null, attempts: 0,
    vars: { first_name: "تجربة", cloud: { values: { "offer.line": "كباب مشوي نص كيلو جاهز لك اليوم، ونوصله لك أو تستلمه من فرعنا" } }, prof } });
  const w = waWorld({ jobs: [J], queue: [Q(1, { box: "gone-box" }), Q(2, {})] });
  const r = await w.api.cloudTick();
  assert.equal(w.db.queue[0].status, "skipped"); assert.equal(w.db.queue[0].reason, "profile_box_gone");
  assert.equal(w.db.queue[1].status, "sent", JSON.stringify(r));
  assert.equal(w.calls.length, 1);
  assert.match(JSON.stringify(w.calls[0].body), /كباب مشوي نص كيلو جاهز لك اليوم/);
}));
