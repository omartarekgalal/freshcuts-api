import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedLeajlakFee, ljContract, feeFromApi, mapInvoiceRow, reconcile, toCsv } from "./leajlakrecon.js";

const C = ljContract({});

test("flat 19.55 within 10 km, any distance", () => {
  for (const km of [0.2, 5, 9.99, 10]) {
    const e = expectedLeajlakFee({ km, status: "delivered", picked: true }, C);
    assert.equal(e.total, 19.55); assert.equal(e.exVat, 17); assert.equal(e.vat, 2.55); assert.equal(e.extraKm, 0);
  }
});

test("beyond 10 km: each started km at 2 ex VAT (ceil)", () => {
  const e = expectedLeajlakFee({ km: 10.38, status: "delivered", picked: true }, C);
  assert.equal(e.extraKm, 1); assert.equal(e.exVat, 19); assert.equal(e.total, 21.85);
  const e2 = expectedLeajlakFee({ km: 12.1, status: "delivered" }, C);
  assert.equal(e2.extraKm, 3); assert.equal(e2.total, 26.45);
  const ex = expectedLeajlakFee({ km: 12.5, status: "delivered" }, ljContract({ leajlakContract: { kmRounding: "exact", perKmExVat: 2.5 } }));
  assert.equal(ex.extraKm, 2.5); assert.equal(ex.exVat, 23.25);
});

test("cancelled before pickup = cancel fee (0 default); after pickup = full fare", () => {
  assert.equal(expectedLeajlakFee({ km: 3, status: "cancelled", picked: false }, C).total, 0);
  assert.equal(expectedLeajlakFee({ km: 3, status: "cancelled", picked: true }, C).total, 19.55);
  assert.equal(expectedLeajlakFee({ km: 3, status: "cancelled" }, ljContract({ leajlakContract: { cancelFeeExVat: 5 } })).total, 5.75);
});

test("contract settings are coerced, junk falls back to defaults", () => {
  const c = ljContract({ leajlakContract: { flatExVat: "18", perKmExVat: "abc", kmRounding: "x" } });
  assert.equal(c.flatExVat, 18); assert.equal(c.perKmExVat, 2); assert.equal(c.kmRounding, "ceil");
});

test("feeFromApi ignores order total, reads fee keys when present", () => {
  assert.equal(feeFromApi({ id: "W1", status: "Delivered", total: 57 }).fee, null);
  assert.equal(feeFromApi({ id: "W1", delivery_fee: "19.55" }).fee, 19.55);
  assert.equal(feeFromApi({ pricing: { price: 21.85, distance_km: 10.4 } }).distanceKm, 10.4);
  assert.deepEqual(feeFromApi({ status: "x", id: 1 }).keys, ["id", "status"]);
});

test("mapInvoiceRow: English columns", () => {
  const l = mapInvoiceRow({ "Client Order ID": "W123", "Delivery Fee": 17, "VAT": 2.55, "Total": 19.55, "Distance (km)": "4.2", "Status": "Delivered", "Date": "2026-09-18" }, C);
  assert.equal(l.ref, "W123"); assert.equal(l.total, 19.55); assert.equal(l.exVat, 17); assert.equal(l.vat, 2.55);
  assert.equal(l.distanceKm, 4.2); assert.equal(l.status, "Delivered");
});

test("mapInvoiceRow: Arabic columns, Arabic digits, single fee column = incl VAT", () => {
  const l = mapInvoiceRow({ "رقم الطلب": "W9", "رسوم التوصيل": "١٩٫٥٥ ر.س", "المسافة": "3" }, C);
  assert.equal(l.ref, "W9"); assert.equal(l.total, 19.55); assert.equal(l.exVat, 17); assert.equal(l.vat, 2.55);
  const l2 = mapInvoiceRow({ "المرجع": "abc", "المبلغ قبل الضريبة": 17, "الضريبة": 2.55 }, C);
  assert.equal(l2.total, 19.55); assert.equal(l2.exVat, 17);
  const l3 = mapInvoiceRow({ "dsp_order_id": "uuid-1", "Cancellation Fee": 5, "Amount": 0 }, C);
  assert.equal(l3.ref, "uuid-1"); assert.equal(l3.cancelFee, 5); assert.equal(l3.total, 0);
});

const ship = (o) => ({ id: 1, orderNo: "W1", providerRef: "u1", createdAt: "2026-09-10T10:00:00Z", period: "2026-09",
  status: "delivered", pickedAt: "2026-09-10T10:20:00Z", ourKm: 4, customerFee: 10, isTest: false, ...o });

test("reconcile: expected-only month (no invoice yet) — margin on expected", () => {
  const r = reconcile({ shipments: [ship({})], contract: C });
  assert.equal(r.totals.expectedTotal, 19.55); assert.equal(r.totals.charged, 0);
  assert.equal(r.rows[0].margin, -9.55); assert.equal(r.rows[0].marginBasis, "expected");
  assert.deepEqual(r.rows[0].flags, []);
});

test("reconcile: over-charge, charged-cancelled, duplicate line, unmatched line, missing shipment", () => {
  const shipments = [
    ship({ id: 1, orderNo: "W1", providerRef: "u1", ourKm: 4 }),
    ship({ id: 2, orderNo: "W2", providerRef: "u2", status: "cancelled", pickedAt: null }),
    ship({ id: 3, orderNo: "W3", providerRef: "u3", ourKm: 10.4 }),
    ship({ id: 4, orderNo: "W4", providerRef: "u4" }),
  ];
  const lines = [
    { ref: "u1", total: 23 },            // > 19.55
    { ref: "W2", total: 19.55 },         // cancelled before pickup → should be 0
    { ref: "u3", total: 21.85 },         // 10.4 km → 1 extra km → exact
    { ref: "u4", total: 19.55 }, { ref: "u4", total: 19.55 },   // duplicate
    { ref: "zzz", total: 19.55 },        // not ours
  ];
  const r = reconcile({ shipments, lines, orphanOrders: [{ orderNo: "W5", createdAt: "2026-09-11T00:00:00Z", customerFee: 0 }], contract: C });
  const by = Object.fromEntries(r.rows.map((x) => [x.orderNo, x]));
  assert.ok(by.W1.flags.includes("over_expected")); assert.equal(by.W1.diff, 3.45);
  assert.ok(by.W2.flags.includes("charged_cancelled"));
  assert.deepEqual(by.W3.flags, []); assert.equal(by.W3.charged, 21.85);
  assert.ok(by.W4.flags.includes("duplicate_invoice_line")); assert.equal(by.W4.charged, 39.1);
  assert.ok(by.W5.flags.includes("missing_shipment"));
  assert.equal(r.unmatched.length, 1); assert.equal(r.totals.unmatchedTotal, 19.55);
  // dispute = 3.45 (W1) + 19.55 (W2) + 19.55 (W4 extra) + 19.55 (stray)
  assert.equal(r.totals.disputeCandidate, 62.1);
  assert.equal(r.anomalies.invoice_line_unmatched, 1);
});

test("reconcile: line for a shipment from another month is not silently dropped", () => {
  const r = reconcile({ shipments: [ship({})], lines: [{ ref: "old", shipmentId: 99, total: 19.55 }], contract: C });
  assert.equal(r.unmatched.length, 1); assert.ok(r.unmatched[0].flags.includes("invoice_line_other_month"));
  assert.equal(r.totals.disputeCandidate, 0);
});

test("reconcile: two live shipments for one order are flagged", () => {
  const r = reconcile({ shipments: [ship({ id: 1 }), ship({ id: 2, providerRef: "u9" })], contract: C });
  assert.ok(r.rows.every((x) => x.flags.includes("duplicate_shipment")));
});

test("reconcile: manual fee used when no invoice, distance gap flagged", () => {
  const r = reconcile({ shipments: [ship({ feeActual: 19.55, feeSource: "manual", feeDistanceKm: 9 })], contract: C });
  assert.equal(r.rows[0].charged, 19.55); assert.equal(r.rows[0].chargedSource, "manual");
  assert.ok(r.rows[0].flags.includes("distance_gap"));
});

test("toCsv: BOM, header, one line per row + totals, quotes escaped", () => {
  const r = reconcile({ shipments: [ship({ feeNote: 'a,"b"' })], lines: [{ ref: "zzz", total: 5 }], contract: C });
  const csv = toCsv(r, { month: "2026-09" });
  assert.ok(csv.startsWith("﻿#,"));
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 1 + 1 + 1 + 2);
  assert.ok(lines[1].includes("W1") && lines[1].includes("19.55"));
});
