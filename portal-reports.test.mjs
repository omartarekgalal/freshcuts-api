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
  assert.deepEqual(r.delivery, { feesCollected: 90, courierCost: 75.5, margin: 14.5, shipments: 6, shipmentsWithoutCost: 1, cancelledShipments: 1, ordersWithCourier: 6 });
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
