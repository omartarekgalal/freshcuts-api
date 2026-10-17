/* node --test cancellations.test.mjs — CR1: الإلغاءات والارتجاع بالأيام (نقطة البيع + الموقع + كيتا) + الراوت */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { summarize, webReason, webKind, posKind, keetaReason, keetaReversed, loadCancellations, register, KIND_LABELS, WEB_STATUSES } from "./cancellations.js";

const T = (h) => `2026-10-16T${h}:00:00.000Z`;    // ١٦/١٠ يوم تشغيلي (١١ص الرياض = 08:00Z)

test("posKind: Void / Refund / سالب / بيع عادي", () => {
  assert.equal(posKind({ order_type: "Void", total: 30 }), "pos_void");
  assert.equal(posKind({ order_type: "Void QR-Menu Orders", total: 30 }), "pos_void");
  assert.equal(posKind({ order_type: "Refund", total: 20 }), "pos_refund");
  assert.equal(posKind({ order_type: "Take away", total: -12 }), "pos_refund");
  assert.equal(posKind({ order_type: "External", total: 50 }), null);
});

test("webKind + webReason: الأسباب الإنجليزية من history بتطلع عربي، expired = ماكمّلش الدفع", () => {
  assert.equal(webKind("rejected_refunded"), "web_refunded");
  assert.equal(webKind("refund_failed"), "web_refund_failed");
  assert.equal(webKind("expired"), "web_expired");
  assert.equal(webKind("cancelled"), "web_cancelled");
  assert.equal(webReason({ status: "expired", history: [] }), "العميل ماكمّلش الدفع");
  assert.equal(webReason({ status: "rejected_refunded", history: [{ status: "paid" }, { status: "rejected_refunded", note: "FreshCuts W1 never accepted by restaurant" }] }), "ماتقبلش من المطعم خالص — استرجاع تلقائي");
  assert.equal(webReason({ status: "rejected_refunded", history: [{ status: "rejected_refunded", note: "rejected by cashier" }] }), "الكاشير رفض الطلب من نقطة البيع");
  assert.equal(webReason({ status: "rejected_refunded", history: [] }), "اعتذر المطعم");
  assert.equal(webReason({ status: "refund_failed", history: [{ status: "refund_failed", note: "REFUND FAILED: timeout" }] }), "فشل الاسترجاع عند ماي فاتورة");
  assert.equal(webReason({ status: "cancelled", history: [{ status: "cancelled", note: "سبب مكتوب" }] }), "سبب مكتوب");
});

test("keetaReason: سبب كيتا + على حساب مين", () => {
  assert.equal(keetaReason({ refunds: [{ reason: "Missing items", merchantAtFault: true }] }), "Missing items — على حساب المطعم");
  assert.equal(keetaReason({ refunds: [{ merchantAtFault: false }] }), "مش على حساب المطعم");
  assert.equal(keetaReason({ refunds: [] }), "السبب مش في بيانات كيتا");
});

test("summarize: قبل الإلغاءات = الصافي + اللي اتشال، ومرآة الموقع في نقطة البيع مابتتحسبش مرتين", () => {
  const s = summarize({
    salesRevenue: 6436.54,
    pos: [
      { order_id: "5540", receipt: "R5540", ts: T("18"), day: "2026-10-16", order_type: "Void", order_option: "Take away", total: 30, staff_name: "أحمد", mirror_of: null },
      { order_id: "5534", receipt: "R5534", ts: T("19"), day: "2026-10-16", order_type: "Void", order_option: "Delivery", total: 250, staff_name: "أحمد", mirror_of: "W144892" },
      { order_id: "5550", receipt: "R5550", ts: T("20"), day: "2026-10-16", order_type: "Refund", order_option: "Dine in", total: -15, staff_name: "منى", mirror_of: null },
      { order_id: "5551", receipt: "R5551", ts: T("20"), day: "2026-10-16", order_type: "Take away", order_option: "Take away", total: 40, staff_name: "منى", mirror_of: null },
    ],
    web: [
      { order_no: "W144892", ts: T("19"), day: "2026-10-16", status: "rejected_refunded", option: "delivery", total: 250, refund_id: "RF1", history: [{ status: "rejected_refunded", note: "rejected by cashier" }], is_test: false },
      { order_no: "W2", ts: T("12"), day: "2026-10-16", status: "expired", option: "pickup", total: 84, history: [], is_test: false },
      { order_no: "W3", ts: T("13"), day: "2026-10-16", status: "refund_failed", option: "delivery", total: 99, history: [{ status: "refund_failed", note: "REFUND FAILED: x" }], is_test: false },
      { order_no: "W4", ts: T("13"), day: "2026-10-16", status: "rejected_refunded", option: "delivery", total: 0.5, history: [], is_test: true },
    ],
    keeta: [
      { order_view_id: "K1", order_id: "k1", keeta_day: "2026-10-16", order_time: T("21"), order_status: 50, refunds: [{ reason: "Cancelled by customer", merchantAtFault: false }], refunded_to_customer: 120, refund_price: 0, part_refund: false, product_price: 110, customer_pay_total: 120 },
      { order_view_id: "K2", order_id: "k2", keeta_day: "2026-10-16", order_time: T("22"), order_status: 20, refunds: [{ reason: "Missing item", merchantAtFault: true, isPartial: true }], refunded_to_customer: 18, refund_price: 18, part_refund: true, product_price: 90, customer_pay_total: 95 },
      { order_view_id: "K3", order_id: "k3", keeta_day: "2026-10-16", order_time: T("22"), order_status: 20, refunds: [], refunded_to_customer: 0, refund_price: 0, part_refund: false, product_price: 50, customer_pay_total: 55 },
    ],
  });
  const t = s.totals;
  assert.deepEqual(t.pos.voids, { n: 1, amount: 30 });            // المرآة اتشالت من الفويد
  assert.equal(t.pos.mirrors, 1);
  assert.deepEqual(t.pos.refunds, { n: 1, amount: 15 });           // السالب = ارتجاع بقيمته المطلقة
  assert.deepEqual(t.web.refunded, { n: 1, amount: 250 });         // الاختبار مش محسوب
  assert.deepEqual(t.web.refundFailed, { n: 1, amount: 99 });
  assert.deepEqual(t.web.expired, { n: 1, amount: 84 });
  assert.deepEqual(t.keeta.reversed, { n: 1, amount: 120 });
  assert.deepEqual(t.keeta.partial, { n: 1, amount: 18 });
  assert.equal(t.deducted, 30 + 15 + 250 + 120);
  assert.equal(t.deductedN, 4);
  assert.equal(t.net, 6436.54);
  assert.equal(t.gross, 6436.54 + 415);
  assert.equal(t.notDeducted, 18);
  assert.equal(t.owed, 99);
  assert.equal(t.unpaid, 84);
  assert.ok(t.rate > 0.06 && t.rate < 0.061, String(t.rate));
  // الصفوف: الفويد المرآة موجود بس معلّم، والبيع العادي مش موجود، والاختبار مش موجود
  assert.equal(s.rows.length, 8);
  const mirror = s.rows.find((r) => r.id === "5534");
  assert.equal(mirror.mirrorOf, "W144892"); assert.equal(mirror.deducted, false);
  assert.ok(!s.rows.some((r) => r.id === "5551" || r.id === "W4" || r.id === "K3"));
  assert.ok(s.rows.every((r) => KIND_LABELS[r.kind] === r.label));
  assert.equal(s.rows.find((r) => r.id === "W144892").reason, "الكاشير رفض الطلب من نقطة البيع");
  assert.equal(s.rows.find((r) => r.id === "K2").reason, "Missing item — على حساب المطعم");
  // اليوم
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].day, "2026-10-16");
  assert.equal(s.days[0].deducted, 415);
  assert.equal(s.days[0].posVoids, 30);
  assert.equal(s.days[0].keeta, 138);
  assert.ok(s.notes.length >= 4);
});

/* ── مراجعة ١٧/١٠: كيتا ↔ نقطة البيع ─────────────────────────────────────── */
test("keetaReversed = نفس شرط keeta_reversed في bizreports.js وSALES_ONLY في finance.js بالحرف (حارس مزامنة)", () => {
  // الشرط نفسه
  assert.equal(keetaReversed({ refunds: [{ reason: "x" }], part_refund: false }), true);
  assert.equal(keetaReversed({ order_status: 20, refunds: [{}], part_refund: false }), true);      // الحالة مش شرط
  assert.equal(keetaReversed({ order_status: 50, refunds: [], part_refund: false }), false);       // 50 لوحده مش دليل (bizreports بيحسبه مبيعات)
  assert.equal(keetaReversed({ refunds: [{}], part_refund: true }), false);                        // جزئي
  assert.equal(keetaReversed({ refunds: null }), false);
  assert.equal(keetaReversed({}), false);
  // الحارس: لو حد غيّر الشرط في bizreports/finance من غير هنا، الاختبار ده يقع
  for (const f of ["./bizreports.js", "./finance.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /jsonb_array_length\(COALESCE\(kp\.refunds,'\[\]'::jsonb\)\) > 0/, f);
    assert.match(src, /COALESCE\(kp\.part_refund, false\) = false/, f);
  }
});

test("summarize: طلب كيتا مرتجع بالكامل + فويد في نقطة البيع = مرة واحدة تحت كيتا بمجموع نقطة البيع، والفويد «مرآة نقطة البيع»", () => {
  const keetaRefund = [{ reason: "Order cancelled", merchantAtFault: true }];
  const s = summarize({
    salesRevenue: 1000,
    pos: [
      // (١) فويد كيتا بنفس order_id — كان بيتحسب مرتين (فويد ١١٠ + كيتا ١٢٠)
      { order_id: "7001", receipt: "R7001", ts: T("18"), day: "2026-10-16", order_type: "Void External", order_option: "Delivery", total: 110, staff_name: "أحمد", mirror_of: null },
      // (٢) فويد اتسجّل بصف تاني بنفس الإيصال (order_id مختلف) — بيتمسك بالإيصال
      { order_id: "7002-v", receipt: "R7002", ts: T("19"), day: "2026-10-16", order_type: "Void", order_option: "Delivery", total: 80, staff_name: "أحمد", mirror_of: null },
      // (٣) فويد عادي مالوش علاقة بكيتا
      { order_id: "7005", receipt: "R7005", ts: T("20"), day: "2026-10-16", order_type: "Void", order_option: "Take away", total: 30, staff_name: "منى", mirror_of: null },
      // (٤) فويد مرآة موقع — بيفضل موقع حتى لو كيتا فيها نفس الرقم بالصدفة
      { order_id: "7006", receipt: "R7006", ts: T("20"), day: "2026-10-16", order_type: "Void", order_option: "Delivery", total: 50, staff_name: "منى", mirror_of: "W9" },
    ],
    web: [{ order_no: "W9", ts: T("20"), day: "2026-10-16", status: "rejected_refunded", option: "delivery", total: 50, history: [], is_test: false }],
    keeta: [
      { order_view_id: "K7001", order_id: "7001", keeta_day: "2026-10-16", order_time: T("18"), order_status: 50, refunds: keetaRefund, refunded_to_customer: 120, refund_price: 0, part_refund: false, product_price: 110, customer_pay_total: 120,
        pos: { order_id: "7001", receipt: "R7001", order_type: "Void External", total: 110 } },
      { order_view_id: "K7002", order_id: "7002", keeta_day: "2026-10-16", order_time: T("19"), order_status: 50, refunds: keetaRefund, refunded_to_customer: 90, refund_price: 0, part_refund: false, product_price: 80, customer_pay_total: 90,
        pos: { order_id: "7002", receipt: "R7002", order_type: "External", total: 80 } },
      // (٥) مرتجع بالكامل وصفه في نقطة البيع عادي (مش فويد) — bizreports شاله بـkeeta_reversed؛ مرة واحدة بمجموع نقطة البيع
      { order_view_id: "K7003", order_id: "7003", keeta_day: "2026-10-16", order_time: T("21"), order_status: 20, refunds: keetaRefund, refunded_to_customer: 70, refund_price: 0, part_refund: false, product_price: 60, customer_pay_total: 70,
        pos: { order_id: "7003", receipt: "R7003", order_type: "External", total: 60 } },
      // (٦) مرتجع بالكامل من غير صف في نقطة البيع — قيمة كيتا
      { order_view_id: "K7004", order_id: null, keeta_day: "2026-10-16", order_time: T("21"), order_status: 50, refunds: keetaRefund, refunded_to_customer: 40, refund_price: 0, part_refund: false, product_price: 35, customer_pay_total: 40, pos: null },
      // (٧) order_status 50 من غير refunds — مش مرتجع (bizreports بيحسبه مبيعات) ⇒ مش معروض ولا مخصوم
      { order_view_id: "K7006", order_id: "7006", keeta_day: "2026-10-16", order_time: T("22"), order_status: 50, refunds: [], refunded_to_customer: 0, refund_price: 0, part_refund: false, product_price: 50, customer_pay_total: 55, pos: { order_id: "7006", receipt: "R7006", order_type: "Void", total: 50 } },
    ],
  });
  const t = s.totals;
  assert.deepEqual(t.pos.voids, { n: 1, amount: 30 });                 // الفويد العادي بس
  assert.equal(t.pos.mirrors, 3);                                     // موقع ١ + كيتا ٢
  assert.equal(t.pos.keetaMirrors, 2);
  assert.deepEqual(t.keeta.reversed, { n: 4, amount: 110 + 80 + 60 + 40 });   // بمجموع نقطة البيع لما موجود، وإلا قيمة كيتا
  assert.equal(t.keeta.posMirrors, 3);
  assert.equal(t.deducted, 30 + 50 + 290);                            // فويد + موقع + كيتا — ولا طلب مرتين
  assert.equal(t.deductedN, 1 + 1 + 4);
  assert.equal(t.gross, 1000 + 370);
  // الصفوف
  const v1 = s.rows.find((r) => r.id === "7001");
  assert.equal(v1.mirrorOf, "K7001"); assert.equal(v1.mirrorSrc, "keeta"); assert.equal(v1.deducted, false);
  const v2 = s.rows.find((r) => r.id === "7002-v");
  assert.equal(v2.mirrorOf, "K7002"); assert.equal(v2.mirrorSrc, "keeta"); assert.equal(v2.deducted, false);
  const v4 = s.rows.find((r) => r.id === "7006");
  assert.equal(v4.mirrorOf, "W9"); assert.equal(v4.mirrorSrc, "web");
  assert.equal(s.rows.find((r) => r.id === "7005").mirrorSrc, null);
  const k1 = s.rows.find((r) => r.id === "K7001");
  assert.deepEqual(k1.posMirror, { id: "7001", receipt: "R7001", orderType: "Void External", total: 110, voided: true });
  assert.equal(k1.amount, 110); assert.equal(k1.orderValue, 120); assert.equal(k1.deducted, true);
  assert.equal(s.rows.find((r) => r.id === "K7002").posMirror.id, "7002-v");       // صف الفويد اللي اتمسك بالإيصال
  const k3 = s.rows.find((r) => r.id === "K7003");
  assert.equal(k3.posMirror.voided, false); assert.equal(k3.amount, 60); assert.equal(k3.orderValue, 70);
  assert.equal(s.rows.find((r) => r.id === "K7004").posMirror, null);
  assert.equal(s.rows.find((r) => r.id === "K7004").amount, 40);
  assert.ok(!s.rows.some((r) => r.id === "K7006"));
  // اليوم: الفويدات المرايا مش في posVoids، وكيتا بمجموعها مرة واحدة
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].posVoids, 30);
  assert.equal(s.days[0].keeta, 290);
  assert.equal(s.days[0].deducted, 370);
  // مفيش رقم طلب مخصوم مرتين (نفس الفحص اللي verify.py بيعمله على الحي)
  const dedIds = s.rows.filter((r) => r.deducted).map((r) => (r.src === "keeta" && r.posMirror ? r.posMirror.id : r.id));
  assert.equal(new Set(dedIds).size, dedIds.length);
  assert.ok(s.notes.some((n) => /كيتا المرتجع بالكامل له صف في نقطة البيع/.test(n)));
});

test("summarize: فاضي = أصفار وصافي بس، ومن غير مبيعات gross = null", () => {
  const s = summarize({ salesRevenue: 100 });
  assert.equal(s.totals.deducted, 0); assert.equal(s.totals.gross, 100); assert.equal(s.totals.rate, 0);
  const s2 = summarize({});
  assert.equal(s2.totals.gross, null); assert.equal(s2.totals.net, null);
  assert.deepEqual(s2.rows, []); assert.deepEqual(s2.days, []);
});

/* ── التحميل: الاستعلامات الصح + المرآة ─────────────────────────────────── */
function fakePool(handlers) {
  const q = [];
  return { q, query: async (sql, vals) => { q.push({ sql: String(sql), vals }); for (const [re, fn] of handlers) if (re.test(String(sql))) return fn(vals); return { rows: [] }; } };
}

test("loadCancellations: ts_orders بالـcalendar_day + shop_orders بالحالات + keeta_payouts بالـkeeta_day، والمرآة تتعلّم", async () => {
  const pool = fakePool([
    [/FROM ts_orders/, () => ({ rows: [{ order_id: "5534", receipt: "R", ts: T("19"), calendar_day: "2026-10-16", order_type: "Void", order_option: "Delivery", total: 250, staff_name: "x" }] })],
    [/FROM shop_orders so/, () => ({ rows: [{ order_no: "W1", ts: T("19"), status: "rejected_refunded", option: "delivery", total: 250, history: [], is_test: false }] })],
    [/FROM keeta_payouts/, () => ({ rows: [] })],
    [/pos_tenant_order_id::text = ANY/, (vals) => ({ rows: vals[0].includes("5534") ? [{ order_no: "W1", pid: "5534" }] : [] })],
  ]);
  const out = await loadCancellations(pool, { startUtc: new Date("2026-10-16T01:00:00Z"), endUtc: new Date("2026-10-17T01:00:00Z") });
  assert.equal(out.pos[0].mirror_of, "W1");
  assert.equal(out.pos[0].day, "2026-10-16");
  assert.equal(out.web[0].day, "2026-10-16");
  const ts = pool.q.find((x) => /FROM ts_orders/.test(x.sql));
  assert.match(ts.sql, /calendar_day >= \$2::date AND o\.calendar_day <= \$3::date/);
  assert.match(ts.sql, /ILIKE '%void%'/); assert.match(ts.sql, /o\.total < 0/);
  assert.deepEqual(ts.vals.slice(1), ["2026-10-16", "2026-10-16"]);
  const sh = pool.q.find((x) => /FROM shop_orders so/.test(x.sql));
  assert.deepEqual(sh.vals[2], WEB_STATUSES);
  const kp = pool.q.find((x) => /FROM keeta_payouts/.test(x.sql));
  assert.match(kp.sql, /jsonb_array_length\(COALESCE\(refunds,'\[\]'::jsonb\)\) > 0/);
  assert.match(kp.sql, /COALESCE\(part_refund,false\)/);
  assert.ok(!/order_status = 50/.test(kp.sql), "50 لوحده مش شرط (نفس bizreports)");
  // مفيش كيتا مرتجع ⇒ مفيش استعلام ts_orders بالأرقام
  assert.ok(!pool.q.some((x) => /FROM ts_orders WHERE order_id = ANY/.test(x.sql)));
  // مفيش ولا كتابة
  assert.ok(pool.q.every((x) => /^\s*SELECT/i.test(x.sql)));
});

test("loadCancellations: كيتا المرتجع بالكامل بيجيب صف نقطة البيع بتاعه (order_id عبر فيدأس) ويلزقه pos — قراءة بس", async () => {
  const keetaRows = [
    { order_view_id: "K1", order_id: "7001", keeta_day: "2026-10-16", order_time: T("18"), order_status: 50, refunds: [{ reason: "x" }], refunded_to_customer: 120, refund_price: 0, part_refund: false, product_price: 110, customer_pay_total: 120 },
    { order_view_id: "K2", order_id: "7002", keeta_day: "2026-10-16", order_time: T("19"), order_status: 20, refunds: [{ isPartial: true }], refunded_to_customer: 10, refund_price: 10, part_refund: true, product_price: 90, customer_pay_total: 95 },
    { order_view_id: "K3", order_id: null, keeta_day: "2026-10-16", order_time: T("20"), order_status: 50, refunds: [{ reason: "y" }], refunded_to_customer: 40, refund_price: 0, part_refund: false, product_price: 35, customer_pay_total: 40 },
  ];
  const pool = fakePool([
    [/FROM ts_orders WHERE order_id = ANY/, (vals) => ({ rows: vals[0].includes("7001") ? [{ order_id: "7001", receipt: "R7001", order_type: "Void External", total: 110 }] : [] })],
    [/FROM ts_orders o/, () => ({ rows: [{ order_id: "7001", receipt: "R7001", ts: T("18"), calendar_day: "2026-10-16", order_type: "Void External", order_option: "Delivery", total: 110, staff_name: "x" }] })],
    [/FROM keeta_payouts/, () => ({ rows: keetaRows })],
  ]);
  const out = await loadCancellations(pool, { startUtc: new Date("2026-10-16T01:00:00Z"), endUtc: new Date("2026-10-17T01:00:00Z") });
  const look = pool.q.find((x) => /FROM ts_orders WHERE order_id = ANY/.test(x.sql));
  assert.deepEqual(look.vals[0], ["7001"]);                 // المرتجع بالكامل اللي له order_id بس (مش الجزئي ولا اللي من غير رقم)
  assert.deepEqual(out.keeta[0].pos, { order_id: "7001", receipt: "R7001", order_type: "Void External", total: 110 });
  assert.equal(out.keeta[1].pos, null); assert.equal(out.keeta[2].pos, null);
  assert.ok(pool.q.every((x) => /^\s*SELECT/i.test(x.sql)));
  // من الآخر للآخر: الفويد + كيتا = خصم واحد ١١٠ تحت كيتا، والفويد مرآة
  const s = summarize({ ...out, salesRevenue: 500 });
  assert.deepEqual(s.totals.keeta.reversed, { n: 2, amount: 110 + 40 });
  assert.deepEqual(s.totals.pos.voids, { n: 0, amount: 0 });
  assert.equal(s.totals.pos.keetaMirrors, 1);
  assert.equal(s.totals.deducted, 150); assert.equal(s.totals.gross, 650);
  assert.equal(s.rows.find((r) => r.id === "7001").mirrorOf, "K1");
});

test("الراوت: admin بس، بيستعمل فترة bizreports ومبيعاتها، وبيرجّع kinds", async () => {
  const pool = fakePool([]);
  const app = new Hono();
  const requireAdmin = async (c) => (c.req.header("authorization") === "Bearer ok" ? null : c.json({ ok: false, error: "unauthorized" }, 401));
  let askedRange = null;
  register(app, { pool, requireAdmin }, { biz: () => ({ settings: async () => ({ weekStart: 6 }), salesData: async (range) => { askedRange = range; return { totals: { revenue: 1234.5 } }; } }) });
  let r = await app.request("/api/reports/biz/cancellations?from=2026-10-16&to=2026-10-16");
  assert.equal(r.status, 401);
  r = await app.request("/api/reports/biz/cancellations?from=2026-10-16&to=2026-10-16", { headers: { authorization: "Bearer ok" } });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.totals.net, 1234.5); assert.equal(j.totals.gross, 1234.5);
  assert.equal(askedRange.from, "2026-10-16");
  assert.equal(j.range.from, "2026-10-16");
  assert.equal(j.kinds.pos_void, KIND_LABELS.pos_void);
  // sales=0 = من غير حساب المبيعات (أسرع للقايمة)
  r = await app.request("/api/reports/biz/cancellations?preset=yesterday&sales=0", { headers: { authorization: "Bearer ok" } });
  assert.equal((await r.json()).totals.net, null);
});

test("الراوت: القاعدة واقعة ⇒ ok:false + error من غير ما يرمي", async () => {
  const pool = { query: async () => { throw new Error("db down"); } };
  const app = new Hono();
  register(app, { pool, requireAdmin: async () => null }, { biz: () => null });
  const r = await app.request("/api/reports/biz/cancellations?preset=today");
  const j = await r.json();
  assert.equal(j.ok, false); assert.match(j.error, /db down/);
});
