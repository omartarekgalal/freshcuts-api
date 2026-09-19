import test from "node:test";
import assert from "node:assert/strict";
import { classifyPos, matchMirrors, appEconomics, aggregate, totalsOf, indicators, normApp } from "./bizreports.js";
import { mergeRates } from "./finance.js";
import { bizRange } from "./bizday.js";

const APPS = ["ninja", "feedus", "keeta", "hungerstation", "jahez", "toyou", "mrsool", "careem"];

test("classifyPos: apps by source_note / wallet, store mirrors, hall/takeaway/own delivery", () => {
  assert.equal(classifyPos({ order_type: "External", order_option: "Take away", pay_keys: ["Feedus"], source_note: "Keeta" }, APPS), "app:keeta");
  assert.equal(classifyPos({ order_type: "External", pay_keys: ["Feedus"], source_note: "Hungerstation" }, APPS), "app:hungerstation");
  assert.equal(classifyPos({ order_type: "External", pay_keys: ["Feedus"] }, APPS), "app:external");
  assert.equal(classifyPos({ order_type: "External", pay_keys: [], source: "delivery_app", source_note: "Feedus" }, APPS), "mirror?");
  assert.equal(classifyPos({ order_type: "Created", order_option: "Take away", pay_keys: [], source: "delivery_app", source_note: "Feedus" }, APPS), "app:external");
  assert.equal(classifyPos({ order_type: "External", order_option: "توصيل Delivery", pay_keys: [] }, APPS), "mirror?");
  assert.equal(classifyPos({ order_type: "Created", order_option: "Dine in", pay_keys: ["TABsense Pay"] }, APPS), "hall");
  assert.equal(classifyPos({ order_type: "Table", order_option: "Dine in", pay_keys: [] }, APPS), "hall");
  assert.equal(classifyPos({ order_type: "Created", order_option: "Take away", pay_keys: ["Cash"] }, APPS), "takeaway");
  assert.equal(classifyPos({ order_type: "Created", order_option: "توصيل Delivery", pay_keys: ["Cash"] }, APPS), "own_delivery");
  assert.equal(classifyPos({ order_type: "Void", pay_keys: [] }, APPS), null);
  assert.equal(classifyPos({ order_type: "QR-Menu Orders", pay_keys: [] }, APPS), "qr");
  assert.equal(normApp("ninja"), "ninja");
});

test("matchMirrors pairs store orders by time+amount, leaves unmatched External as app", () => {
  const pos = [
    { order_id: "1", _ch: "mirror?", ts: "2026-09-18T12:02:40Z", total: 96.002 },
    { order_id: "2", _ch: "mirror?", ts: "2026-09-18T12:03:16Z", total: 129.007 },
    { order_id: "3", _ch: "mirror?", ts: "2026-09-18T19:00:00Z", total: 55 },
    { order_id: "4", _ch: "hall", ts: "2026-09-18T12:02:00Z", total: 96 },
  ];
  const shop = [
    { order_no: "W1", ts: "2026-09-18T12:01:41Z", total: 96, subtotal: 96, delivery_fee: 0 },
    { order_no: "W2", ts: "2026-09-18T12:02:44Z", total: 129, subtotal: 124, delivery_fee: 5 },
  ];
  const m = matchMirrors(pos, shop);
  assert.deepEqual([...m].sort(), ["1", "2"]);
});

test("appEconomics uses the contract band of the order's own day", () => {
  const rates = mergeRates(null);
  const hs1 = appEconomics("hungerstation", "2026-09-18", 115, 100, rates, "net");
  assert.equal(hs1.rate, 0.10);
  assert.equal(hs1.base, 115); // same basis as Keeta: total incl. VAT after promo
  assert.equal(Math.round(hs1.commission * 100) / 100, 11.5);
  const hs2 = appEconomics("hungerstation", "2026-10-02", 115, 100, rates, "net");
  assert.equal(hs2.rate, 0.18);
  const k = appEconomics("keeta", "2026-09-18", 100, 86.96, rates, "net");
  assert.equal(k.base, 100); // Keeta measured: 18% of total after promo
  assert.equal(k.commission, 18);
  assert.equal(appEconomics("jahez", "2026-09-18", 100, 0, rates).known, false);
});

test("aggregate builds per-channel cards with store split, customers and app net", () => {
  const rates = mergeRates(null);
  const rows = [
    { ch: "store", ts: "2026-09-18T12:00:00Z", day: "2026-09-18", total: 100, ident: "500000001", opt: "delivery" },
    { ch: "store", ts: "2026-09-18T22:00:00Z", day: "2026-09-18", total: 50, ident: "500000002", opt: "pickup" },
    { ch: "app:keeta", ts: "2026-09-18T15:00:00Z", day: "2026-09-18", total: 100, net: 86.96, ident: "500000003" },
    { ch: "hall", ts: "2026-09-18T16:00:00Z", day: "2026-09-18", total: 80, ident: null },
  ];
  const firsts = new Map([["500000001", "2026-09-01"], ["500000002", "2026-09-18"]]);
  const cards = aggregate(rows, { firsts, range: { from: "2026-09-18", to: "2026-09-18" }, rates });
  const store = cards.find((c) => c.id === "store");
  assert.equal(store.orders, 2);
  assert.equal(store.revenue, 150);
  assert.deepEqual([store.split.delivery.orders, store.split.pickup.orders], [1, 1]);
  assert.deepEqual([store.customers.new, store.customers.returning], [1, 1]);
  assert.equal(store.hourly.find((h) => h.hour === 1).orders, 1); // 22:00Z = 01:00 Riyadh
  const keeta = cards.find((c) => c.id === "app:keeta");
  assert.equal(keeta.commission.commission, 18);
  assert.ok(keeta.commission.net < 100 && keeta.commission.net > 60);
  const t = totalsOf(cards);
  assert.equal(t.orders, 4);
  assert.equal(t.revenue, 330);
  assert.equal(t.groups.store.revenue, 150);
});

test("indicators: new vs returning, time to second order, first-channel cohorts", () => {
  const rows = [];
  const add = (ident, day, ch, total = 100) => rows.push({ ident, day, ch, total, ts: `${day}T12:00:00Z` });
  add("a", "2026-07-01", "store"); add("a", "2026-07-08", "store"); add("a", "2026-09-10", "store");
  add("b", "2026-07-05", "app:keeta"); add("b", "2026-09-12", "app:keeta");
  add("c", "2026-09-15", "hall");
  add(null, "2026-09-15", "hall");
  const range = bizRange({ from: "2026-09-10", to: "2026-09-18", now: new Date("2026-09-19T10:00:00Z") });
  const out = indicators(rows, new Map(), range);
  assert.equal(out.current.customers, 3);
  assert.equal(out.current.newCustomers, 1);
  assert.equal(out.current.returningCustomers, 2);
  const k = Object.fromEntries(out.kpis.map((x) => [x.key, x]));
  assert.equal(k.daysToSecond.value, 38); // a: 7 days, b: 69 days → median 38
  const store = out.byFirstChannel.find((x) => x.group === "store");
  assert.equal(store.return30, 1);
  assert.equal(out.byFirstChannel.find((x) => x.group === "app:keeta").return30, 0);
});
