import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedLeajlakFee, ljContract, feeFromApi, mapInvoiceRow, reconcile, toCsv, parseLeajlakSheet, parseLjDate, dominantMonth, exportTable, LJ_EXPORT_COLS } from "./leajlakrecon.js";

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

// ملف أغسطس الحقيقي من لاجلك (FRESH CUTS August 2026 Order Details.xlsx) كما يقراه xlsx بـ header:1
const AUG = [
  ["Order Date", "Order No", "Client Name", "Shop Name", "AWB", "Dist. b/w Shop & Dlvry", "Order Status", "Payment Type"],
  ["8/30/26", "3142728", "FRESH CUTS", "FRESH CUTS-JED-SALAMAH", "W1788110759469", "0.017", "Delivered", "Pre Paid"],
  ["", "", "", "", "", "", "", ""], ["", "", "", "", "", "", "", ""], ["", "", "", "", "", "", "", ""],
  ["", "", "", "FRESH CUTS", "", "", "", ""],
  ["", "", "", "Total Order Delivered ", "", "", "1", ""],
  ["", "", "", "Financial request for delivery", "", "", "SAR 17.00 ", ""],
  ["", "", "", "COD Charge", "", "", "SAR 0.00 ", ""],
  ["", "", "", "Cash in Hand ", "", "", "SAR 0", ""],
  ["", "", "", "Extra km", "", "", "0.00", ""],
  ["", "", "", "Financial request Extra km", "", "", " SAR -   ", ""],
  ["", "", "", "Payment", "", "", "SAR 17.00 ", ""],
];

test("parseLeajlakSheet: real August Order Details file", () => {
  const p = parseLeajlakSheet(AUG, C);
  assert.equal(p.format, "leajlak_order_details");
  assert.equal(p.lines.length, 1);
  const l = p.lines[0];
  assert.equal(l.ref, "W1788110759469"); assert.equal(l.theirNo, "3142728"); assert.equal(l.date, "2026-08-30");
  assert.equal(l.distanceKm, 0.017); assert.equal(l.exVat, 17); assert.equal(l.vat, 2.55); assert.equal(l.total, 19.55);
  assert.deepEqual(p.summary, { delivered: 1, deliveryExVat: 17, codCharge: 0, cashInHand: 0, extraKm: 0, extraKmExVat: 0, paymentExVat: 17 });
  assert.equal(p.checks.deliveredCountMatches, true); assert.equal(p.checks.paymentMatchesSummary, true);
  assert.equal(p.checks.linesMatchPayment, true); assert.equal(p.checks.rateMatchesContract, true);
  assert.equal(dominantMonth(p.lines), "2026-08");
});

test("parseLeajlakSheet: extra km billed from their distance, cancelled rows free", () => {
  const g = [AUG[0],
    ["9/2/26", "1", "FRESH CUTS", "S", "W1", "12.4", "Delivered", "Pre Paid"],
    ["9/3/26", "2", "FRESH CUTS", "S", "W2", "3", "Cancelled", "Pre Paid"], [],
    ["", "", "", "Total Order Delivered", "", "", "1"], ["", "", "", "Financial request for delivery", "", "", "SAR 17.00"],
    ["", "", "", "Extra km", "", "", "3.00"], ["", "", "", "Financial request Extra km", "", "", "SAR 6.00"],
    ["", "", "", "Payment", "", "", "SAR 23.00"]];
  const p = parseLeajlakSheet(g, C);
  assert.equal(p.lines[0].extraKm, 3); assert.equal(p.lines[0].exVat, 23);
  assert.equal(p.lines[1].exVat, 0);
  assert.equal(p.checks.linesMatchPayment, true);
});

test("parseLjDate: their M/D/YY and ISO", () => {
  assert.equal(parseLjDate("8/30/26"), "2026-08-30");
  assert.equal(parseLjDate("2026-09-01 10:00"), "2026-09-01");
  assert.equal(parseLjDate("30/08/2026"), "2026-08-30");
});

test("export mirrors their columns in order, with their summary beside ours", () => {
  const p = parseLeajlakSheet(AUG, C);
  const line = { ...p.lines[0], shipmentId: 1 };
  const r = reconcile({ shipments: [ship({ orderNo: "W1788110759469", ourKm: 1.29, isTest: true })], lines: [line], contract: C,
    invoice: { summary: p.summary, taxInvoice: { no: "INV/2026/00598", taxable: 17, vat: 2.55, total: 19.55 } } });
  assert.equal(r.rows[0].charged, 19.55); assert.equal(r.rows[0].chargedExVat, 17);
  assert.ok(!r.rows[0].flags.includes("over_expected"));
  const t = exportTable(r);
  assert.deepEqual(t.columns.slice(0, 8), LJ_EXPORT_COLS);
  assert.equal(t.rows[0]["Order Date"], "8/30/26"); assert.equal(t.rows[0]["Order No"], "3142728");
  assert.equal(t.rows[0]["AWB"], "W1788110759469"); assert.equal(t.rows[0]["Order Status"], "Delivered");
  const pay = t.summary.find((x) => x.label === "Payment");
  assert.equal(pay.leajlak, 17); assert.equal(pay.ours, 17);
  assert.equal(t.summary.find((x) => x.label.startsWith("Invoice Total")).ours, 19.55);
  const csv = toCsv(r);
  assert.ok(csv.startsWith("﻿Order Date,Order No,Client Name,Shop Name,AWB,"));
});

test("reconcile: delivered shipment absent from an imported invoice is flagged (not bad)", () => {
  const r = reconcile({ shipments: [ship({ id: 1 }), ship({ id: 2, orderNo: "W2", providerRef: "u2" })],
    lines: [{ ref: "W1", total: 19.55, exVat: 17 }], contract: C });
  assert.ok(r.rows.find((x) => x.orderNo === "W2").flags.includes("missing_from_invoice"));
});
