/* تقرير الدخل اليومي للإعلانات — 17 سبتمبر 2026.
     node --test adsreport.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { reportDayAt, previousBizDay, adSourceOf, sourceOf, recommend, smsText, smsAdsText, changesText, buildReport, NOTES, COMPARE_FROM } from "./adsreport.js";
import { smsInfo } from "./staffalerts.js";

const at = (iso) => new Date(iso);

test("يوم التقرير: ٣:٠٠ الفجر عادةً، ٤:٠٠ بعد ليلة الخميس والجمعة، لحد ١٢:٠٠", () => {
  // يوم ١٦/٩ أربعاء → ٣:٠٠ يوم الخميس ١٧
  assert.equal(reportDayAt(at("2026-09-16T23:59:00Z")), null);            // 02:59 Riyadh
  assert.equal(reportDayAt(at("2026-09-17T00:00:00Z")), "2026-09-16");    // 03:00
  // يوم ١٧/٩ خميس → ٤:٠٠ يوم الجمعة ١٨
  assert.equal(reportDayAt(at("2026-09-18T00:40:00Z")), null);            // 03:40
  assert.equal(reportDayAt(at("2026-09-18T01:00:00Z")), "2026-09-17");    // 04:00
  assert.equal(reportDayAt(at("2026-09-18T08:59:00Z")), "2026-09-17");    // 11:59
  assert.equal(reportDayAt(at("2026-09-18T09:00:00Z")), null);            // 12:00
  // يوم ١٨/٩ جمعة → ٤:٠٠ السبت ١٩ ؛ يوم ١٩/٩ سبت → ٣:٠٠ الأحد
  assert.equal(reportDayAt(at("2026-09-19T00:30:00Z")), null);
  assert.equal(reportDayAt(at("2026-09-19T01:00:00Z")), "2026-09-18");
  assert.equal(reportDayAt(at("2026-09-20T00:00:00Z")), "2026-09-19");
  assert.equal(reportDayAt(at("2026-09-17T22:30:00Z"), "01:30"), "2026-09-17"); // 01:30 config
  assert.equal(previousBizDay(at("2026-09-18T00:30:00Z")), "2026-09-16"); // 03:30 → still inside 17th → previous = 16th
  assert.equal(previousBizDay(at("2026-09-18T02:00:00Z")), "2026-09-17"); // 05:00 → 17th ended
});

test("مصدر الطلب: روابط 96-m2/m3/meta و fbc = ميتا، UTM مدفوع بس، وسناب", () => {
  assert.equal(adSourceOf({ fc_link: "96-m3-box-b" }), "meta");
  assert.equal(adSourceOf({ utm: { utm_content: "96-m2-kilo-a" } }), "meta");
  assert.equal(adSourceOf({ click: { fbc: "fb.1.x" } }), "meta");
  assert.equal(adSourceOf({ utm: { utm_source: "meta", utm_medium: "paid" } }), "meta");
  assert.equal(adSourceOf({ utm: { utm_source: "instagram", utm_medium: "story" } }), null); // organic
  assert.equal(adSourceOf({ utm: { utm_source: "direct", utm_medium: "offer-link", utm_content: "96-box" } }), null);
  assert.equal(adSourceOf({ click: { ScCid: "x" } }), "snapchat");
  // attrib_source (classifySource on the server session) rescues the in-app-browser orders
  assert.equal(adSourceOf({ utm: { utm_medium: "paid" } }, "meta"), "meta");
  assert.equal(adSourceOf({ fc_link: "96-snap-kilo" }, "snapchat"), "snapchat");
  assert.equal(adSourceOf({ utm: { utm_medium: "story" } }, "meta"), null); // organic post
  assert.equal(adSourceOf(null), null);
});

test("مصدر الطلب للعرض: attrib_source الأول، وبعده utm، وبعده الرابط", () => {
  assert.equal(sourceOf({ attrib_source: "meta", attribution: {} }), "meta");
  assert.equal(sourceOf({ attribution: { utm: { utm_source: "instagram" } } }), "instagram");
  assert.equal(sourceOf({ attribution: { fc_link: "96-qr-hall" } }), "link");
  assert.equal(sourceOf({ attribution: null }), "direct");
});

test("التوصية بنفس حدود الحارس", () => {
  assert.equal(recommend({ spendTotal: 0 }).code, "NO_SPEND");
  assert.equal(recommend({ spendTotal: 500, spendShareOfRevenue: 0.2, cpaOnline: 50, ordersFromAds: 3 }).code, "SCALE");
  assert.equal(recommend({ spendTotal: 500, spendShareOfRevenue: 0.36, cpaOnline: 50, ordersFromAds: 3 }).code, "CUT");
  assert.equal(recommend({ spendTotal: 500, spendShareOfRevenue: 0.2, cpaOnline: 95, ordersFromAds: 3 }).code, "CUT");
  assert.equal(recommend({ spendTotal: 500, spendShareOfRevenue: 0.2, cpaOnline: null, ordersFromAds: 0 }).code, "CUT");
  assert.equal(recommend({ spendTotal: 500, spendShareOfRevenue: 0.32, cpaOnline: 70, ordersFromAds: 2 }).code, "HOLD");
  assert.equal(recommend({ spendTotal: 500, spendShareOfRevenue: 0.2, cpaOnline: 40, ordersFromAds: 0 }).code, "HOLD");
});

const pos = { hall: { orders: 30, revenue: 1500.5 }, deliveryApps: { orders: 12, revenue: 800.25, byApp: {} }, onlineInPos: { orders: 4, revenue: 380 } };
const shop = [
  { order_no: "W1", option: "delivery", total: "96", coupon: "FIRST", is_test: false, attrib_source: "meta", attribution: { fc_link: "96-m3-box-b" } },
  { order_no: "W2", option: "pickup", total: "120", coupon: null, is_test: false, attrib_source: "direct", attribution: { utm: {} } },
  { order_no: "W3", option: "delivery", total: "106", coupon: null, is_test: false, attrib_source: "direct", attribution: null },
  { order_no: "W4", option: "delivery", total: "32.5", coupon: "OMAR-9X4T", is_test: false, attribution: null },
  { order_no: "W5", option: "delivery", total: "50", coupon: null, is_test: true, attribution: null },
];
const meta = { campaigns: [
  { id: "1", name: "FC96-SALES-PUR", objective: "OUTCOME_SALES", kind: "web", spend: 300, purchases: 2, purchaseValue: 192, conversations: 0 },
  { id: "2", name: "fc-wa-orders", objective: "OUTCOME_ENGAGEMENT", kind: "whatsapp", spend: 150, purchases: 0, purchaseValue: 0, conversations: 40 },
] };

test("بناء التقرير: الأونلاين من shop_orders بس (مفيش عدّ مرتين)، والتجارب برا", () => {
  const r = buildReport({ day: "2026-09-18", pos, shop, meta, now: at("2026-09-19T00:40:00Z") });
  assert.equal(r.online.orders, 3);
  assert.equal(r.online.testOrdersExcluded, 2);
  assert.equal(r.revenue.onlineDelivery.revenue, 202);
  assert.equal(r.revenue.onlinePickup.revenue, 120);
  assert.equal(r.revenue.total, 1500.5 + 800.25 + 322);          // onlineInPos NOT added
  assert.equal(r.ads.spendTotal, 450);
  assert.equal(r.ads.spendWeb, 300);
  assert.equal(r.ads.ordersFromAdsOurs, 1);
  assert.equal(r.ads.ordersFromAds, 1);                           // OUR paid orders decide, not Meta's 2
  assert.equal(r.online.bySource.meta.orders, 1);
  assert.equal(r.online.bySource.direct.orders, 2);
  assert.equal(r.ads.cpaOnline, 100);                             // 300 / 3
  assert.equal(r.ads.roasOnline, 1.07);                           // 322 / 300
  assert.equal(r.ads.spendShareOfRevenue, Math.round(450 / 2622.75 * 10000) / 10000);
  assert.equal(r.ads.whatsappConversations, 40);
  assert.equal(r.recommendation.code, "CUT");                      // CPA 100 > 90
});

test("رسالة عمر: إنجليزي، رسالة واحدة GSM-7، حتى في أسوأ الأرقام", () => {
  const r = buildReport({ day: "2026-09-18", pos, shop, meta });
  assert.equal(smsInfo(r.sms).encoding, "GSM-7");
  assert.equal(smsInfo(r.sms).segments, 1);
  assert.match(r.sms, /^FC 18\/09 Rev 2623/);
  const huge = buildReport({
    day: "2026-12-31",
    pos: { hall: { orders: 999, revenue: 123456789 }, deliveryApps: { orders: 999, revenue: 987654321, byApp: {} }, onlineInPos: { orders: 0, revenue: 0 } },
    shop: Array.from({ length: 400 }, (_, i) => ({ option: i % 2 ? "pickup" : "delivery", total: "99999", attribution: { fc_link: "96-m3-kilo-a" } })),
    meta: { campaigns: [{ name: "x", objective: "OUTCOME_SALES", kind: "web", spend: 99999999, purchases: 9999 }] },
  });
  assert.equal(smsInfo(huge.sms).segments, 1);
  assert.equal(smsInfo(huge.sms).encoding, "GSM-7");
  const empty = buildReport({ day: "2026-09-18", pos: { hall: { orders: 0, revenue: 0 }, deliveryApps: { orders: 0, revenue: 0, byApp: {} }, onlineInPos: { orders: 0, revenue: 0 } }, shop: [], meta: { campaigns: [] } });
  assert.equal(empty.ads.spendShareOfRevenue, null);
  assert.equal(empty.recommendation.code, "NO_SPEND");
  assert.equal(smsInfo(empty.sms).segments, 1);
});

test("ملاحظات التقرير: مقارنة من ١٧/٩، والواتساب مايتحاسبش بالبكسل", () => {
  const before = NOTES("2026-09-10"), after = NOTES(COMPARE_FROM);
  assert.match(before[0], /مش مقارنة عادلة/);
  assert.match(after[0], /المقارنة بتبدأ/);
  assert.equal(before.length, 3);
  assert.ok(after.some((n) => n.includes("96-wa-")));
});

test("الواتساب في التقرير: صرف ومحادثات وتكلفة المحادثة وزيارات الروابط", () => {
  const r = buildReport({ day: "2026-09-18", pos, shop, meta, whatsapp: { linkLandings: 12, ordersFromLinks: 2, revenueFromLinks: 180 } });
  assert.equal(r.whatsapp.spend, 150);
  assert.equal(r.whatsapp.conversations, 40);
  assert.equal(r.whatsapp.costPerConversation, 3.75);
  assert.equal(r.whatsapp.linkLandings, 12);
  assert.equal(r.whatsapp.ordersFromLinks, 2);
  const empty = buildReport({ day: "2026-09-18", pos, shop, meta: { campaigns: [] } });
  assert.equal(empty.whatsapp.costPerConversation, null);
  assert.equal(empty.whatsapp.linkLandings, 0);
});

test("سطر الإعلانات اليومي (١٨/٩): الطلبات حسب المصدر، تكلفة الطلب، واللي الحارس غيّره — رسالة واحدة GSM-7", () => {
  const pos = { hall: { orders: 20, revenue: 1400 }, deliveryApps: { orders: 10, revenue: 850, byApp: {} }, onlineInPos: { orders: 0, revenue: 0 } };
  const shop = [
    { option: "delivery", total: "96", attrib_source: "meta", attribution: { fc_link: "96-m3-kilo-a", utm: { utm_source: "meta", utm_medium: "paid" } } },
    { option: "pickup", total: "99", attrib_source: "sms", attribution: { fc_link: "cv" } },
    { option: "delivery", total: "121", attrib_source: "direct", attribution: {} },
  ];
  const meta = { campaigns: [
    { name: "FC96-SALES-PUR", objective: "OUTCOME_SALES", kind: "web", spend: 300, purchases: 1 },
    { name: "fc-wa-orders", objective: "OUTCOME_ENGAGEMENT", kind: "whatsapp", spend: 100, conversations: 30 },
  ] };
  const guardLog = [
    { action: "set_ACTIVE", label: "WA fc-wa-walkin-5km (100/day)", detail: {} },
    { action: "pace_lifetime_budget", label: "FC96-SALES-ATC", detail: { pace: 435, to: 5655 } },
    { action: "boost_evening", label: "WA fc-wa-walkin-5km (100/day)", detail: { from: 100, to: 125 } },
    { action: "health_alert", label: "health", detail: {} },
    { action: "health_alert", label: "health", detail: {} },
  ];
  const r = buildReport({ day: "2026-09-18", pos, shop, meta, snap: { spend: 100 }, guardLog });
  assert.equal(r.ads.spendSnap, 100);
  assert.equal(r.ads.spendTotal, 500);
  assert.equal(smsInfo(r.smsAds).encoding, "GSM-7");
  assert.equal(smsInfo(r.smsAds).segments, 1);
  assert.match(r.smsAds, /^FC ADS 18\/09 Ord M1 S0 SMS1 D1 \| CPA 133 \(ads 400\) \| Spend M300 S100 WA100 \| Chg: pace ATC 435, boost WA 125, 2 alerts$/);
  assert.equal(changesText([]), "none");
  assert.equal(changesText([{ action: "hard_cap_hit", label: "account" }, { action: "error" }]), "HIT 3000 CAP, 1 err");
  // worst case still one segment
  const many = Array.from({ length: 40 }, (_, i) => ({ action: "setup_create", label: `X${i}`, detail: {} }));
  const big = buildReport({ day: "2026-09-18", pos, shop, meta, guardLog: many });
  assert.equal(smsInfo(big.smsAds).segments, 1);
  assert.equal(smsInfo(big.smsAds).encoding, "GSM-7");
});

test("تغييرات الحارس: الإعداد بيتجمّع «+N edits» والأهم الأول", () => {
  const g = [
    { action: "setup_create", label: "FC96-SALES-PUR" }, { action: "setup_create", label: "FC-RT-WEB-96" },
    { action: "pause_whatsapp", label: "WA fc-wa-walkin-5km" }, { action: "budget_up_from_whatsapp", label: "FC-RT-WEB-96", detail: { toDaily: 120 } },
    { action: "switch_to_add_to_cart", label: "FC96-SALES-ATC-8KM-ADV" }, { action: "reenable_whatsapp_tracked", label: "WA fc-wa-walkin-5km" },
    { action: "pause_ad_ai_video", label: "x" }, { action: "pause_ad_ai_video", label: "y" },
  ];
  assert.equal(changesText(g), "WA off, RT 120, WA on, 2 AI vids off, +3 edits");
});
