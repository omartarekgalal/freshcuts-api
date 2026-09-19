import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedLeajlakFee, ljContract, feeFromApi, mapInvoiceRow, reconcile, toCsv, parseLeajlakSheet, parseLjDate, dominantMonth, exportTable, LJ_EXPORT_COLS,
  parseLeajlakDashboardExport, impliedKmFromFee, feeSlack } from "./leajlakrecon.js";

const C = ljContract({});

test("flat 19.55 within 10 km, any distance", () => {
  for (const km of [0.2, 5, 9.99, 10]) {
    const e = expectedLeajlakFee({ km, status: "delivered", picked: true }, C);
    assert.equal(e.total, 19.55); assert.equal(e.exVat, 17); assert.equal(e.vat, 2.55); assert.equal(e.extraKm, 0);
  }
});

test("beyond 10 km: 2 ex VAT (2.30 incl) per km, fractions pro-rata (Omar 19/9 + their dashboard)", () => {
  assert.equal(C.kmRounding, "exact"); assert.equal(C.perKmInclVat, 2.3); assert.equal(C.flatInclVat, 19.55);
  const e = expectedLeajlakFee({ km: 10.38, status: "delivered", picked: true }, C);
  assert.equal(e.extraKm, 0.38); assert.equal(e.exVat, 17.76); assert.equal(e.total, 20.42);
  // their dashboard: 17.80 = 10.40 km, 17.78 = 10.39 km, 28.52 = 15.76 km
  for (const [km, ex] of [[10.4, 17.8], [10.39, 17.78], [15.76, 28.52]]) assert.equal(expectedLeajlakFee({ km, status: "delivered" }, C).exVat, ex);
  const e2 = expectedLeajlakFee({ km: 12.1, status: "delivered" }, C);
  assert.equal(e2.extraKm, 2.1); assert.equal(e2.total, 24.38);
  const ce = expectedLeajlakFee({ km: 10.38, status: "delivered" }, ljContract({ leajlakContract: { kmRounding: "ceil" } }));
  assert.equal(ce.extraKm, 1); assert.equal(ce.total, 21.85);
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
  assert.equal(c.flatExVat, 18); assert.equal(c.perKmExVat, 2); assert.equal(c.kmRounding, "exact");
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
    { ref: "u3", total: 20.47 },         // 10.4 km → 0.4 extra km → (17 + 0.8) × 1.15
    { ref: "u4", total: 19.55 }, { ref: "u4", total: 19.55 },   // duplicate
    { ref: "zzz", total: 19.55 },        // not ours
  ];
  const r = reconcile({ shipments, lines, orphanOrders: [{ orderNo: "W5", createdAt: "2026-09-11T00:00:00Z", customerFee: 0 }], contract: C });
  const by = Object.fromEntries(r.rows.map((x) => [x.orderNo, x]));
  assert.ok(by.W1.flags.includes("over_expected")); assert.equal(by.W1.diff, 3.45);
  assert.ok(by.W2.flags.includes("charged_cancelled"));
  assert.deepEqual(by.W3.flags, []); assert.equal(by.W3.charged, 20.47);
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
    ["9/2/26", "1", "FRESH CUTS", "S", "W1", "13", "Delivered", "Pre Paid"],
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

// تصدير لوحة لاجلك الحقيقي (client-order-export-10669.csv، ١٩/٩) — عيّنة، من غير عمود الكابتن الحقيقي
const DASH = [
  ["Order ID", "Client ID", "Shop Name", "Area", "Zone", "Amount", "Delivery Charge", "Order Date", "Status", "Assigned Captain"],
  ["OR#3248118", "#W1789756903889", "FRESH CUTS-JED-SALAMAH", "NORTH JEDDAH", "AL SALAMAH(JED)", "48.00 SAR", "17.00 SAR", "2026-09-18", "Delivered", "x"],
  ["OR#3245496", "#W1789733313648", "FRESH CUTS-JED-SALAMAH", "NORTH JEDDAH", "AL SALAMAH(JED)", "96.00 SAR", "17.80 SAR", "2026-09-18", "Delivered", "x"],
  ["OR#3245472", "#W1789732900662", "FRESH CUTS-JED-SALAMAH", "NORTH JEDDAH", "AL SALAMAH(JED)", "96.00 SAR", "17.78 SAR", "2026-09-18", "Delivered", "x"],
  ["OR#3162272", "#Adel", "FRESH CUTS-JED-SALAMAH", "NORTH JEDDAH", "AL SALAMAH(JED)", "0.00 SAR", "28.52 SAR", "2026-09-03", "Delivered", "x"],
  ["OR#3140942", "#W1788089340142", "FRESH CUTS-JED-SALAMAH", "NORTH JEDDAH", "AL SALAMAH(JED)", "46.00 SAR", "0.00 SAR", "2026-08-30", "Canceled", ""],
];

test("dashboard export: detected, Delivery Charge is ex VAT, implied km, every row fits the contract", () => {
  const p = parseLeajlakSheet(DASH, C);
  assert.equal(p.format, "leajlak_dashboard_export");
  const by = Object.fromEntries(p.lines.map((l) => [l.ref, l]));
  assert.equal(by.W1789756903889.theirNo, "3248118"); assert.equal(by.W1789756903889.total, 19.55);
  assert.equal(by.W1789756903889.distanceKm, null); assert.equal(by.W1789756903889.orderAmount, 48);
  assert.equal(by.W1789733313648.exVat, 17.8); assert.equal(by.W1789733313648.total, 20.47); assert.equal(by.W1789733313648.distanceKm, 10.4);
  assert.equal(by.W1789732900662.distanceKm, 10.39);
  assert.equal(by.Adel.distanceKm, 15.76); assert.equal(by.Adel.total, 32.8);
  assert.equal(by.W1788089340142.total, 0); assert.equal(by.W1788089340142.date, "2026-08-30");
  assert.deepEqual(p.checks.notFitting, []);
  assert.equal(p.checks.extraRows, 3); assert.equal(p.checks.cancelled, 1);
  assert.equal(impliedKmFromFee(17, C), null);
});

test("reconcile with dashboard prices: our km ±0.05 of theirs is not an anomaly; stray priced row is", () => {
  const p = parseLeajlakDashboardExport(DASH, C);
  const ref = (r) => p.lines.find((l) => l.ref === r);
  const shipments = [
    ship({ id: 1, orderNo: "W1789756903889", ourKm: 1.11 }),
    ship({ id: 2, orderNo: "W1789733313648", ourKm: 10.44 }),
    ship({ id: 3, orderNo: "W1789732900662", ourKm: 10.38 }),
    ship({ id: 4, orderNo: "W9", ourKm: 11.5 }),
  ];
  const dashLines = [{ ...ref("W1789756903889"), shipmentId: 1 }, { ...ref("W1789733313648"), shipmentId: 2 },
    { ...ref("W1789732900662"), shipmentId: 3 }, { ...ref("W9") || { ref: "W9", exVat: 21, total: 24.15 }, shipmentId: 4 },
    { ...ref("Adel"), shipmentId: null }, { ...ref("W1788089340142"), shipmentId: null }];
  const r = reconcile({ shipments, dashLines, contract: C });
  const by = Object.fromEntries(r.rows.map((x) => [x.orderNo, x]));
  assert.equal(by.W1789733313648.chargedSource, "dashboard"); assert.equal(by.W1789733313648.charged, 20.47);
  assert.equal(by.W1789733313648.expected.total, 20.56);
  assert.deepEqual(by.W1789733313648.flags, []); assert.deepEqual(by.W1789732900662.flags, []);
  assert.equal(by.W1789733313648.theirKm, 10.4);
  // 11.5 km ours but they charged 13 km → over
  assert.ok(by.W9.flags.includes("over_expected"));
  // Adel (28.52 ex = 32.80) is flagged; the free cancelled test row is not listed
  assert.equal(r.unmatched.length, 1); assert.ok(r.unmatched[0].flags.includes("dashboard_line_unmatched"));
  assert.equal(r.totals.dashboardStray, 32.8); assert.equal(r.totals.dashboardCount, 4);
  // dispute (no invoice yet) = W9 over + Adel
  assert.equal(r.totals.disputeCandidate, r2x(by.W9.diff + 32.8));
  // invoice + dashboard disagree → flagged
  const r2 = reconcile({ shipments: [shipments[0]], dashLines: [dashLines[0]], lines: [{ ref: "W1789756903889", total: 21.85, exVat: 19 }], contract: C });
  assert.ok(r2.rows[0].flags.includes("dashboard_vs_invoice")); assert.equal(r2.rows[0].chargedSource, "invoice");
});

const r2x = (v) => Math.round(v * 100) / 100;

test("feeSlack widens only near/over the 10 km edge", () => {
  assert.equal(feeSlack(4, C), 0.1);
  assert.equal(feeSlack(10.44, C), 0.56);
  assert.equal(feeSlack(null, C), 0.1);
});
