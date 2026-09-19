import { test } from "node:test";
import assert from "node:assert/strict";
import { normPhone, maskPhone, isNewCustomer, FIRST_ORDER_CTE, SHOP_PAID_SQL } from "./identity.js";
import { FIRST_ORDER_DAY_CTE } from "./analytics.js";
import { matchWebToPos, summarize, favorites, itemCategory, posChannel, refOf } from "./customer360.js";
import { redactBody, partsOf, logSms } from "./smslog.js";
import { routeFor } from "./reviews.js";

test("normPhone: every spelling of one mobile is one identity", () => {
  for (const v of ["0512345678", "+966512345678", "00966512345678", "966 51 234 5678", "512345678", "٠٥١٢٣٤٥٦٧٨"]) {
    assert.equal(normPhone(v), "512345678", v);
  }
  assert.equal(normPhone("0112345678"), "");
  assert.equal(normPhone(""), "");
  assert.equal(maskPhone("512345678"), "05•••••78");
});

test("isNewCustomer: first order EVER inside the window", () => {
  assert.equal(isNewCustomer("2026-09-18", "2026-09-18"), true);
  assert.equal(isNewCustomer("2026-09-01", "2026-09-18"), false); // ordered before → returning
  assert.equal(isNewCustomer("2026-09-10", "2026-09-01", "2026-09-30"), true);
  assert.equal(isNewCustomer(null, "2026-09-18"), false);          // no known order → never new
});

test("shared first-order CTE: all channels, no registered_at, same name everywhere", () => {
  assert.equal(FIRST_ORDER_DAY_CTE, FIRST_ORDER_CTE);
  assert.match(FIRST_ORDER_CTE, /shop_orders/);
  assert.match(FIRST_ORDER_CTE, /first_order_at/);
  assert.doesNotMatch(FIRST_ORDER_CTE, /registered_at/);
  assert.doesNotMatch(FIRST_ORDER_CTE, /filled_at/);
  assert.match(SHOP_PAID_SQL, /is_test/);
  assert.match(SHOP_PAID_SQL, /pending_payment/);
});

test("matchWebToPos: partner External copy counted once, closest wins, inhouse never", () => {
  const web = [{ orderNo: "W1", at: "2026-09-18T12:00:00Z", total: 96 }, { orderNo: "W2", at: "2026-09-18T12:05:00Z", total: 96 }];
  const pos = [
    { id: "4098", at: "2026-09-18T12:01:00Z", total: 96.002, channel: "external" },
    { id: "4100", at: "2026-09-18T12:06:00Z", total: 96.002, channel: "external" },
    { id: "4101", at: "2026-09-18T12:02:00Z", total: 96, channel: "inhouse" },
    { id: "5000", at: "2026-09-19T12:02:00Z", total: 96, channel: "external" }, // next day
  ];
  const m = matchWebToPos(web, pos);
  assert.equal(m.get("4098"), "W1");
  assert.equal(m.get("4100"), "W2");
  assert.equal(m.has("4101"), false);
  assert.equal(m.has("5000"), false);
});

test("posChannel", () => {
  assert.equal(posChannel({ order_type: "QR-Menu Orders" }), "website");
  assert.equal(posChannel({ order_type: "External", source_note: "Keeta" }), "keeta");
  assert.equal(posChannel({ order_type: "External", payments: { Feedus: 30 } }), "feedus");
  assert.equal(posChannel({ order_type: "External" }), "external");
  assert.equal(posChannel({ order_type: "Created", payments: { Cash: 1 } }), "inhouse");
});

test("summarize + favorites", () => {
  const orders = [
    { at: "2026-09-01T12:00:00Z", total: 100, channel: "inhouse", items: [{ name: "وجبة كفتة", qty: 2 }] },
    { at: "2026-09-11T12:00:00Z", total: 50, channel: "website", items: [{ name: "كريب سوبر كرانشي", qty: 1 }] },
    { at: "2026-09-05T12:00:00Z", total: 999, channel: "keeta", void: true, items: [] },
    { at: "2026-09-11T12:10:00Z", total: 50, channel: "external", dupOf: "W1", items: [{ name: "بيتزا", qty: 9 }] },
  ];
  const s = summarize(orders, new Date("2026-09-19T12:00:00Z"));
  assert.equal(s.orders, 2); assert.equal(s.spend, 150); assert.equal(s.aov, 75);
  assert.equal(s.avgGapDays, 10); assert.equal(s.daysSinceLast, 8); assert.equal(s.firstChannel, "inhouse"); assert.equal(s.voided, 1);
  const f = favorites(orders);
  assert.equal(f.items[0].name, "وجبة كفتة");
  assert.ok(!f.items.some((i) => i.name === "بيتزا")); // duplicate ignored
  assert.equal(itemCategory("ريش مشوية بالوزن"), "grill");
  assert.equal(itemCategory("وجبة طرب"), "meal");
  assert.equal(itemCategory("حواوشي لحم"), "hawawshi");
});

test("refOf is opaque and stable", () => {
  const r = refOf("512345678");
  assert.match(r, /^c[0-9a-f]{15}$/);
  assert.equal(r, refOf("512345678"));
  assert.ok(!r.includes("512345678"));
});

test("sms log: OTP code never stored, parts counted, no pool = no-op", async () => {
  assert.equal(redactBody("otp", "رمز الدخول: 4821 #4821"), "رمز الدخول: •••• #••••");
  assert.equal(redactBody("order_status", "طلبك W123"), "طلبك W123");
  assert.equal(partsOf("a".repeat(160)), 1);
  assert.equal(partsOf("ع".repeat(71)), 2);
  assert.equal(await logSms({ phoneNorm: "5", body: "x" }), false);
});

test("review routing is the owner's strict rule: ≤3★ internal only, 4–5★ Google", () => {
  for (const r of [1, 2, 3]) assert.equal(routeFor(r, 4, "https://g.page/x"), "internal");
  for (const r of [4, 5]) assert.equal(routeFor(r, 4, "https://g.page/x"), "google");
  assert.equal(routeFor(5, 4, ""), "internal"); // no Google link configured
});
