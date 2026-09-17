/* تقرير الدخل اليومي للإعلانات — 17 سبتمبر 2026.
     node --test adsreport.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { reportDayAt, previousBizDay, adSourceOf, recommend, smsText, buildReport } from "./adsreport.js";
import { smsInfo } from "./staffalerts.js";

const at = (iso) => new Date(iso);

test("يوم التقرير: من ٠٣:٤٠ لحد ١٢:٠٠ الرياض = يوم الشغل اللي خلص، وبره كده ولا حاجة", () => {
  assert.equal(reportDayAt(at("2026-09-18T00:39:00Z")), null);            // 03:39 Riyadh
  assert.equal(reportDayAt(at("2026-09-18T00:40:00Z")), "2026-09-17");    // 03:40
  assert.equal(reportDayAt(at("2026-09-18T08:59:00Z")), "2026-09-17");    // 11:59
  assert.equal(reportDayAt(at("2026-09-18T09:00:00Z")), null);            // 12:00
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
  assert.equal(adSourceOf(null), null);
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
  { order_no: "W1", option: "delivery", total: "96", coupon: "FIRST", is_test: false, attribution: { fc_link: "96-m3-box-b" } },
  { order_no: "W2", option: "pickup", total: "120", coupon: null, is_test: false, attribution: { utm: {} } },
  { order_no: "W3", option: "delivery", total: "106", coupon: null, is_test: false, attribution: null },
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
  assert.equal(r.ads.ordersFromAds, 2);                           // max(ours, meta)
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
