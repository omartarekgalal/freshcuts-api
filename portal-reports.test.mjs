/* تقارير البوابة — node --test portal-reports.test.mjs (مفيش قاعدة حقيقية) */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRange, daysBetween, shapeReport, buildReport, SQL, riyadhToday, MAX_RANGE_DAYS } from "./portal-reports.js";

test("parseRange: افتراضي النهارده بتوقيت الرياض، وتواريخ غلط/معكوسة/طويلة بتترفض", () => {
  const now = Date.parse("2026-09-16T22:30:00Z"); // ١:٣٠ فجر ١٧ في الرياض
  assert.equal(riyadhToday(now), "2026-09-17");
  assert.deepEqual(parseRange(null, null, now), { ok: true, from: "2026-09-17", to: "2026-09-17", days: 1 });
  assert.deepEqual(parseRange("2026-09-01", "2026-09-07", now), { ok: true, from: "2026-09-01", to: "2026-09-07", days: 7 });
  assert.equal(parseRange("2026-02-30", "2026-03-01", now).error, "bad_date");
  assert.equal(parseRange("17-09-2026", null, now).error, "bad_date");
  assert.equal(parseRange("2026-09-10", "2026-09-01", now).error, "from_after_to");
  assert.equal(parseRange("2026-01-01", "2026-09-01", now).error, "range_too_long");
  assert.equal(parseRange("2026-06-18", "2026-09-17", now).days, MAX_RANGE_DAYS);
  assert.deepEqual(daysBetween("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("SQL: كله على مدى الرياض ومن غير الاختبار وقراية بس", () => {
  for (const [k, sql] of Object.entries(SQL)) {
    assert.match(sql, /AT TIME ZONE 'Asia\/Riyadh'/, k);
    assert.match(sql, /NOT COALESCE\(o\.is_test, false\)/, k);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i, k);
    assert.doesNotMatch(sql, /\$3/, k);
  }
});

test("shapeReport: KPIs + هامش التوصيل + ملء الأيام والساعات + أزمنة + SLA", () => {
  const r = shapeReport({
    range: { from: "2026-09-10", to: "2026-09-12", days: 3 },
    totals: { paid_orders: 12, net_orders: 10, revenue: "1000.456", gross_revenue: 1100, food_revenue: 850, delivery_orders: 6, pickup_orders: 4,
      delivery_revenue: 700, pickup_revenue: 300, delivery_fees: 90, tips: 5, discounts: 40, discounted_orders: 3,
      refunded_orders: 1, refunded_total: 60, refund_failed_orders: 1, refund_failed_total: 40, courier_cancelled_orders: 1,
      pos_failed_orders: 0, expired_orders: 7, pending_payment_orders: 2, sla_late_orders: 3, sla_breach_orders: 1, customers: 9 },
    courier: { courier_cost: 75.5, shipments: 6, shipments_without_cost: 1, cancelled_shipments: 1, orders_with_courier: 6 },
    daily: [{ day: "2026-09-11", orders: 4, revenue: 400, delivery: 2, pickup: 2, refunded: 0 }],
    hourly: [{ hour: 13, orders: 5, revenue: 500 }],
    times: [{ k: "accepted_to_ready", n: 5, avg: 18.84, median: 17.2, p90: 27.55 }],
    slaCodes: [{ key: "accept_late:1", orders: 3 }, { key: "accept_breach:2", orders: 1 }, { key: "staff:new_order", orders: 10 }],
    topItems: [{ name: "برجر", qty: "14", orders: 8 }],
    customers: { new_orders: 6, returning_orders: 4, new_customers: 6, customers: 9 },
    sources: [{ source: "direct", orders: 7, revenue: 700 }], links: [{ link: "tiktok-sep", orders: 2, revenue: 190 }],
    payments: [{ method: "ap", orders: 10, revenue: 1000 }],
  });
  assert.equal(r.kpis.revenue, 1000.46);
  assert.equal(r.kpis.aov, 100.05);
  assert.equal(r.fulfilment.deliverySharePct, 60);
  assert.deepEqual(r.delivery, { feesCollected: 90, courierCost: 75.5, margin: 14.5, shipments: 6, shipmentsWithoutCost: 1, cancelledShipments: 1, ordersWithCourier: 6,
    farZone: { orders: 0, revenue: 0, surcharge: 0, extraKm: 0, avgExtraKm: 0, maxKm: 0, courierExtraCost: 0, gap: 0, courierPerKm: 2.5 } });
  assert.equal(r.losses.refunded.total, 60);
  assert.deepEqual(r.series.daily.map((d) => [d.day, d.orders]), [["2026-09-10", 0], ["2026-09-11", 4], ["2026-09-12", 0]]);
  assert.equal(r.series.hourly.length, 24);
  assert.equal(r.series.hourly[13].orders, 5);
  assert.deepEqual(r.times.accepted_to_ready, { label: "من القبول لـ«جاهز»", n: 5, avgMin: 18.8, medianMin: 17.2, p90Min: 27.6 });
  assert.equal(r.times.paid_to_accepted.n, 0);
  assert.deepEqual(r.sla.byCode.map((x) => x.code).sort(), ["accept_breach", "accept_late"]);
  assert.equal(r.topItems[0].qty, 14);
  assert.equal(r.customers.returningOrders, 4);
  assert.equal(r.attribution.links[0].link, "tiktok-sep");
});

test("buildReport: الاستعلامات واحد ورا التاني بنفس الباراميترز، وفشل واحد = partial مش انهيار", async () => {
  let active = 0, maxActive = 0;
  const seen = [];
  const pool = {
    query: async (sql, vals) => {
      active++; maxActive = Math.max(maxActive, active);
      seen.push(vals);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      if (/jsonb_array_elements\(CASE WHEN jsonb_typeof\(b\.items\)/.test(sql)) throw new Error("boom");
      if (/AS paid_orders/.test(sql)) return { rows: [{ net_orders: 2, revenue: 200 }] };
      return { rows: [] };
    },
  };
  const r = await buildReport(pool, { from: "2026-09-01", to: "2026-09-02", days: 2 }, { error() {} });
  assert.equal(maxActive, 1, "مابياخدش الـpool كله");
  assert.equal(seen.length, Object.keys(SQL).length);
  assert.ok(seen.every((v) => v[0] === "2026-09-01" && v[1] === "2026-09-02"));
  assert.deepEqual(r.partial, ["topItems"]);
  assert.equal(r.kpis.aov, 100);
  assert.deepEqual(r.topItems, []);
});

test("SQL: مفيش كلمة محجوزة في Postgres مستخدمة كاسم عمود بدون تنصيص (returning كان بيوقّع customers)", () => {
  // اتجرّبت كل الاستعلامات على Postgres حقيقي (PGlite) بسكيمة shop.js/delivery.js/orders-schema.js
  const RESERVED = ["returning", "user", "order", "group", "limit", "offset", "window", "end", "default", "check"];
  for (const [k, sql] of Object.entries(SQL)) {
    for (const w of RESERVED) {
      const re = new RegExp(`\b(AS|WHERE NOT|WHERE)\s+${w}\b(?!_)`, "i");
      assert.ok(!re.test(sql), `${k}: ${w}`);
    }
  }
});

/* ═══ أداء شركة التوصيل — محطّتا المندوب (١٧ سبتمبر) ═════════════════════ */

test("shapeReport: أوقات محطّات المندوب + عدّ «وصل قبل/بعد ما الأكل يجهز»", () => {
  const r = shapeReport({
    range: { from: "2026-09-16", to: "2026-09-17", days: 2 },
    courierTimes: [
      { k: "ready_to_arrived", n: 8, avg: -3.44, median: -2.1, p90: 6.77 },
      { k: "arrived_to_picked", n: 8, avg: 4.25, median: 3.9, p90: 9.1 },
      { k: "courier_picked_to_delivered", n: 7, avg: 21.36, median: 20, p90: 33.2 },
    ],
    courierMilestones: { shipments: 10, with_arrived: 8, with_picked: 9,
      arrived_before_ready: 5, arrived_after_ready: 3, providers: 1, provider: "leajlak" },
    courierDaily: [{ day: "2026-09-17", shipments: 6, with_arrived: 5, ready_to_arrived: -2.55,
      arrived_to_picked: 4.4, picked_to_delivered: 19.9, arrived_before_ready: 3, arrived_after_ready: 2 }],
  });
  assert.deepEqual(r.times.ready_to_arrived,
    { label: "من «جاهز» لوصول المندوب المطعم", n: 8, avgMin: -3.4, medianMin: -2.1, p90Min: 6.8 });
  assert.equal(r.times.arrived_to_picked.avgMin, 4.3);
  assert.equal(r.times.courier_picked_to_delivered.n, 7);
  assert.equal(r.courierPerf.shipments, 10);
  assert.equal(r.courierPerf.withArrived, 8);
  assert.equal(r.courierPerf.arrivedBeforeReady, 5, "المندوب استنّى المطعم");
  assert.equal(r.courierPerf.arrivedAfterReady, 3, "المطعم استنّى المندوب");
  assert.equal(r.courierPerf.coveragePct, 80);
  assert.equal(r.courierPerf.provider, "leajlak");
  assert.equal(r.courierPerf.daily[0].readyToArrivedMin, -2.5);
  assert.equal(r.courierPerf.daily[0].arrivedBeforeReady, 3);
});

test("shapeReport: مافيش شحنات = مفيش تغطية مخترعة", () => {
  const r = shapeReport({ range: { from: "2026-09-17", to: "2026-09-17", days: 1 } });
  assert.equal(r.courierPerf.shipments, 0);
  assert.equal(r.courierPerf.coveragePct, null, "مش صفر% — إحنا مش عارفين أصلاً");
  assert.deepEqual(r.courierPerf.daily, []);
  assert.equal(r.times.ready_to_arrived.n, 0);
});

test("SQL: استعلامات المندوب بتستبعد اليدوي والملغي", () => {
  for (const k of ["courierTimes", "courierMilestones", "courierDaily"]) {
    const sql = SQL[k];
    assert.match(sql, /provider <> 'manual'/, `${k}: الشحنة اليدوية مالهاش إشارات`);
    assert.match(sql, /status <> 'cancelled'/, `${k}: الملغي مش أداء`);
    assert.match(sql, /option = 'delivery'/, `${k}: الاستلام مالوش مندوب`);
  }
});
