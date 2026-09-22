/* ═══════════════════════════════════════════════════════════════════════════
   استرجاع طلب لاجلك من لوحتهم (٢١ سبتمبر ٢٠٢٦)

   الـHTML اللي في الاختبارات دي مأخوذ من صفحات حقيقية على اللايف لطلب
   W1790011118692 (طلبهم OR#3263217) — نفس الأعمدة ونفس صيغة الوقت.

     node --test leajlakdash.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import { parseRows, parseTable, rowToOrder, riyadhToIso, parseDetail, makeLeajlakDash,
         looksDate, looksMoney, looksStatus, looksName } from "./leajlakdash.js";

/* ── الـHTML الحقيقي من اللايف (٢٢/٩) ──────────────────────────────────
   الفخ: الـ<thead> فيه ١٢ عنوان والـ<tbody> فيه **١٤ خلية** — عمودين
   زياده من غير عنوان (اسم العميل و«Fast») مدسوسين قبل التاريخ. القراءة
   بالترتيب كانت بتدّي: الكابتن = "2026-09-21" والحالة = "Fast". */
const LIST_HTML = `
<table><thead><tr><th>#</th><th>Order ID</th><th>Client ID</th><th>Client Shopname</th><th>Area</th>
<th>Zone</th><th>Amount</th><th>Del. Charge</th><th>Order Date</th><th>Status</th><th>Captain</th><th>Action</th></tr></thead>
<tbody>
<tr><td><input type="checkbox"></td><td>OR#3263217</td><td>#W1790011118692</td><td>FRESH CUTS-JED-SALAMAH</td>
<td>NORTH JEDDAH</td><td>AL SALAMAH(JED)</td><td>96.00 SAR</td><td>17.00 SAR</td>
<td>Ahmed Elbeltagy</td><td>Fast</td>
<td>2026-09-21</td><td><span class="badge">Delivered</span></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td>
<td><a href="https://app.leajlak.com/orders-client/3263217"><i class="eye"></i></a></td></tr>
</tbody></table>`;

/* لو صلّحوا جدولهم يوم من الأيام (١٢ عنوان = ١٢ خلية) لازم يفضل شغّال */
const LIST_HTML_TIDY = `
<table><thead><tr><th>#</th><th>Order ID</th><th>Client ID</th><th>Client Shopname</th><th>Area</th>
<th>Zone</th><th>Amount</th><th>Del. Charge</th><th>Order Date</th><th>Status</th><th>Captain</th><th>Action</th></tr></thead>
<tbody>
<tr><td></td><td>OR#3263217</td><td>#W1790011118692</td><td>FRESH CUTS-JED-SALAMAH</td>
<td>NORTH JEDDAH</td><td>AL SALAMAH(JED)</td><td>96.00 SAR</td><td>17.00 SAR</td>
<td>2026-09-21</td><td>Delivered</td><td>ELFADIL IBAHIM -JED - leajlak11 A</td>
<td><a href="https://app.leajlak.com/orders-client/3263217">x</a></td></tr>
</tbody></table>`;

/* طلب جديد لسه من غير كابتن — الخانة بتبقى فاضية، ومش تحذير */
const LIST_HTML_NEW = `
<table><thead><tr><th>#</th><th>Order ID</th><th>Client ID</th><th>Client Shopname</th><th>Area</th>
<th>Zone</th><th>Amount</th><th>Del. Charge</th><th>Order Date</th><th>Status</th><th>Captain</th><th>Action</th></tr></thead>
<tbody>
<tr><td></td><td>OR#3299001</td><td>#W1790099900011</td><td>FRESH CUTS-JED-SALAMAH</td>
<td>NORTH JEDDAH</td><td>AL SALAMAH(JED)</td><td>150.00 SAR</td><td>17.00 SAR</td>
<td>Sara A</td><td>Fast</td>
<td>2026-09-22</td><td>New Order</td><td></td>
<td><a href="https://app.leajlak.com/orders-client/3299001">x</a></td></tr>
</tbody></table>`;

const DETAIL_HTML = `
<div>Client Order ID : #W1790011118692</div>
<table><tbody>
<tr><td>Item</td><td>Quantity</td><td>Price</td><td>Amount</td></tr>
</tbody></table>
<table><tbody>
<tr><td>Delivery Charges</td><td>17.00 SAR</td></tr>
</tbody></table>
<table><tbody>
<tr><td>New Order</td><td></td><td>FRESH CUTS</td><td>2026-09-21 08:33 PM</td></tr>
<tr><td>Assigned By</td><td></td><td>Mohamed Ibrahim  DIS</td><td>2026-09-21 08:35 PM</td></tr>
<tr><td>Assigned to</td><td></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td><td>2026-09-21 08:35 PM</td></tr>
<tr><td>Order Accept</td><td></td><td>Mohamed Ibrahim  DIS</td><td>2026-09-21 08:35 PM</td></tr>
<tr><td>Start Ride</td><td></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td><td>2026-09-21 08:35 PM</td></tr>
<tr><td>Reached shop</td><td></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td><td>2026-09-21 08:56 PM</td></tr>
<tr><td>Order Picked</td><td></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td><td>2026-09-21 08:57 PM</td></tr>
<tr><td>Shipped</td><td></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td><td>2026-09-21 08:57 PM</td></tr>
<tr><td>Reached Destination</td><td></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td><td>2026-09-21 09:27 PM</td></tr>
<tr><td>Delivered</td><td></td><td>ELFADIL IBAHIM -JED - leajlak11 A</td><td>2026-09-21 09:29 PM</td></tr>
</tbody></table>`;

test("جدولهم المكسور (١٢ عنوان / ١٤ خلية): الكابتن والحالة صح مش مزحلقين", () => {
  const { headers, rows } = parseTable(LIST_HTML);
  assert.equal(headers.length, 12);
  assert.equal(rows[0].cells.length, 14, "الصف فيه عمودين زياده من غير عنوان");
  const o = rowToOrder(rows[0], "W1790011118692");
  assert.equal(o.theirNo, "3263217");
  assert.equal(o.orderNo, "W1790011118692");
  assert.equal(o.rawStatus, "Delivered", "مش «Fast»");
  assert.equal(o.captain, "ELFADIL IBAHIM -JED - leajlak11 A", "مش التاريخ");
  assert.equal(o.date, "2026-09-21");
  assert.equal(o.amount, 96);
  assert.equal(o.feeEx, 17);
  assert.equal(o.feeIncl, 19.55);
  assert.deepEqual(o.warnings, [], "قراءة نضيفة = مفيش تحذيرات");
  // اسم العميل عمره ما بيتخزّن
  assert.ok(!JSON.stringify(o).includes("Ahmed Elbeltagy"));
});

test("لو صلّحوا الجدول (١٢ = ١٢) يفضل شغّال زي ما هو", () => {
  const o = rowToOrder(parseTable(LIST_HTML_TIDY).rows[0], "W1790011118692");
  assert.equal(o.rawStatus, "Delivered");
  assert.equal(o.captain, "ELFADIL IBAHIM -JED - leajlak11 A");
  assert.equal(o.date, "2026-09-21");
  assert.deepEqual(o.warnings, []);
});

test("طلب لسه من غير كابتن: فاضي من غير تحذير كاذب", () => {
  const o = rowToOrder(parseTable(LIST_HTML_NEW).rows[0], "W1790099900011");
  assert.equal(o.rawStatus, "New Order");
  assert.equal(o.captain, null);
  assert.equal(o.date, "2026-09-22");
  assert.deepEqual(o.warnings, []);
});

test("الحرّاس: تاريخ/فلوس/حالة مايعدّوش كاسم كابتن", () => {
  assert.equal(looksDate("2026-09-21"), true);
  assert.equal(looksMoney("17.00 SAR"), true);
  assert.equal(looksStatus("Delivered"), true);
  assert.equal(looksStatus("Fast"), false, "«Fast» مش حالة");
  assert.equal(looksName("2026-09-21"), false);
  assert.equal(looksName("17.00 SAR"), false);
  assert.equal(looksName("Delivered"), false);
  assert.equal(looksName("ELFADIL IBAHIM -JED - leajlak11 A"), true);
  assert.equal(looksName(""), false);
});

test("عمود زيادة تاني يوم من الأيام: المرساة هي الحالة فمفيش زحلقة", () => {
  for (const extra of ["<td>EXTRA</td>", "<td>1.5 km</td>", "<td>حاجة جديدة</td>"]) {
    const html = LIST_HTML.replace("<td>2026-09-21</td>", `${extra}<td>2026-09-21</td>`);
    const o = rowToOrder(parseTable(html).rows[0], "W1790011118692");
    assert.equal(o.rawStatus, "Delivered", extra);
    assert.equal(o.captain, "ELFADIL IBAHIM -JED - leajlak11 A", extra);
    assert.equal(o.date, "2026-09-21", extra);
  }
});

test("لو الحالة نفسها اختفت: تحذير صريح ومفيش قيمة مخترعة", () => {
  const html = LIST_HTML.replace("<span class=\"badge\">Delivered</span>", "???");
  const o = rowToOrder(parseTable(html).rows[0], "W1790011118692");
  assert.equal(o.rawStatus, null, "ما نخزّنش قيمة مش حالة");
  assert.ok(o.warnings.some((w) => /مفيش حالة معروفة/.test(w)));
});

test("خلية الكابتن فيها خردة: بترجع فاضية مع تحذير مش بتتخزّن", () => {
  const html = LIST_HTML.replace("<td>ELFADIL IBAHIM -JED - leajlak11 A</td>", "<td>2026-09-21</td>");
  const o = rowToOrder(parseTable(html).rows[0], "W1790011118692");
  assert.equal(o.captain, null);
  assert.ok(o.warnings.some((w) => /الكابتن مش منطقي/.test(w)));
});

test("رقم طلب تاني في نفس الصفحة مابيتاخدش بالغلط", () => {
  assert.equal(rowToOrder(parseTable(LIST_HTML).rows[0], "W9999999999999"), null);
});

test("وقت لوحتهم بتوقيت الرياض → UTC", () => {
  // مثبت: الطلب اتعمل عندنا 17:33 UTC وظهر عندهم 08:33 PM
  assert.equal(riyadhToIso("2026-09-21 08:33 PM"), "2026-09-21T17:33:00.000Z");
  assert.equal(riyadhToIso("2026-09-21 09:29 PM"), "2026-09-21T18:29:00.000Z");
  assert.equal(riyadhToIso("2026-09-22 12:05 AM"), "2026-09-21T21:05:00.000Z");
  assert.equal(riyadhToIso("2026-09-21 12:30 PM"), "2026-09-21T09:30:00.000Z");
  assert.equal(riyadhToIso("مش وقت"), null);
});

test("سجل المحطّات → أوقات الشحنة + الرسوم", () => {
  const d = parseDetail(DETAIL_HTML);
  assert.equal(d.feeEx, 17);
  assert.equal(d.times.created, "2026-09-21T17:33:00.000Z");
  assert.equal(d.times.assigned, "2026-09-21T17:35:00.000Z");
  assert.equal(d.times.arrived, "2026-09-21T17:56:00.000Z");   // Reached shop
  assert.equal(d.times.picked, "2026-09-21T17:57:00.000Z");    // Order Picked
  assert.equal(d.times.delivered, "2026-09-21T18:29:00.000Z");
  // «Assigned By» (الديسباتشر) مايغلبش «Assigned to» — الاتنين نفس الدقيقة هنا
  assert.ok(d.log.length >= 10);
});

test("من غير بيانات دخول: مقفول بهدوء وبيقول ناقصه إيه — مش بيرمي", async () => {
  const d = makeLeajlakDash({ env: {} });
  assert.equal(d.configured(), false);
  assert.deepEqual(d.missing(), ["LEAJLAK_DASH_EMAIL", "LEAJLAK_DASH_PASSWORD"]);
  const r = await d.lookup("W1");
  assert.equal(r.found, false);
  assert.equal(r.reason, "dash_unconfigured");
});

/* fetch مزيّف: صفحة دخول بـ_token، تحويل بعد الدخول، وصفحات اللوحة. */
function fakeFetch({ failLogin = false } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || "GET", body: opts.body || null });
      const h = new Map();
      const mk = (status, text, loc) => ({
        status, headers: { get: (k) => (k === "location" ? loc || null : null), getSetCookie: () => ["leajlak_session=abc; Path=/"] },
        text: async () => text,
      });
      if (url.endsWith("/login") && (opts.method || "GET") === "GET") {
        return mk(200, '<form method="POST"><input type="hidden" name="_token" value="CSRF123"><input name="email"><input type="password" name="password"></form>');
      }
      if (url.endsWith("/login")) {
        return failLogin ? mk(200, '<form><input type="hidden" name="_token" value="x"><input type="password" name="password"></form>')
                         : mk(302, "", "https://app.leajlak.com/client-dashboard");
      }
      if (url.includes("/orders-client?q=")) return mk(200, LIST_HTML);
      if (/\/orders-client\/\d+/.test(url)) return mk(200, DETAIL_HTML);
      return mk(404, "nope");
    },
  };
}

test("الاسترجاع الكامل: دخول → بحث → تفاصيل، والباسورد عمره ما يرجع في الرد", async () => {
  const f = fakeFetch();
  const d = makeLeajlakDash({ env: { LEAJLAK_DASH_EMAIL: "a@b.c", LEAJLAK_DASH_PASSWORD: "s3cr3t" }, fetchImpl: f.fn });
  const r = await d.lookup("W1790011118692");
  assert.equal(r.found, true);
  assert.equal(r.providerOrderNo, "3263217");
  assert.equal(r.ref, null, "اللوحة مابتعرضش الـUUID — المرجع بيفضل فاضي عن قصد");
  assert.equal(r.feeEx, 17);
  assert.equal(r.feeIncl, 19.55);
  assert.equal(r.driver.name, "ELFADIL IBAHIM -JED - leajlak11 A");
  assert.equal(r.driver.source, "leajlak");
  assert.equal(r.times.delivered, "2026-09-21T18:29:00.000Z");
  assert.ok(!JSON.stringify(r).includes("s3cr3t"), "الباسورد مايظهرش في الرد");
  // الكوكي اتبعت في الطلبات اللي بعد الدخول
  const after = f.calls.filter((c) => c.url.includes("orders-client"));
  assert.ok(after.length >= 2);
});

test("دخول مرفوض: خطأ واضح من غير ما يطبع بيانات الدخول", async () => {
  const f = fakeFetch({ failLogin: true });
  const d = makeLeajlakDash({ env: { LEAJLAK_DASH_EMAIL: "a@b.c", LEAJLAK_DASH_PASSWORD: "s3cr3t" }, fetchImpl: f.fn });
  const r = await d.lookup("W1790011118692");
  assert.equal(r.found, false);
  assert.equal(r.code, "DASH_LOGIN_FAILED");
  assert.ok(!JSON.stringify(r).includes("s3cr3t"));
});

test("طلب مش عندهم: found=false من غير ما يخترع حاجة", async () => {
  const f = fakeFetch();
  const d = makeLeajlakDash({ env: { LEAJLAK_DASH_EMAIL: "a@b.c", LEAJLAK_DASH_PASSWORD: "p" }, fetchImpl: f.fn });
  const r = await d.lookup("W0000000000000");
  assert.equal(r.found, false);
});
