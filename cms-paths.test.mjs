/* W0-01 — تصنيف المسارات في cms.js (PATH_SECTIONS).
   الاسترجاع لازم يتصنّف «المالية» قبل سطر shop/orders العام، عشان دور
   المطبخ (orders: edit) مايقدرش يرجّع فلوس. */
import test from "node:test";
import assert from "node:assert/strict";

import { sectionOf, DEFAULT_PERMS } from "./cms.js";

test("refund routes (shop + cms) map to finance", () => {
  assert.equal(sectionOf("/api/shop/orders/FC-1234/refund"), "finance");
  assert.equal(sectionOf("/api/cms/orders/FC-1234/refund"), "finance");
});

test("refund regex is anchored — look-alikes don't become finance", () => {
  assert.equal(sectionOf("/api/shop/orders/FC-1234/refund-status"), "orders");
  assert.equal(sectionOf("/api/shop/orders/FC-1234/extra/refund"), "orders");
});

test("other order operations stay in orders", () => {
  assert.equal(sectionOf("/api/shop/orders/FC-1234/retry-pos"), "orders");
  assert.equal(sectionOf("/api/shop/orders"), "orders");
  assert.equal(sectionOf("/api/shop/board"), "orders");
  assert.equal(sectionOf("/api/shop/board/FC-1234/courier"), "orders");
  assert.equal(sectionOf("/api/shop/summary"), "orders");
});

test("neighbouring rules unchanged", () => {
  assert.equal(sectionOf("/api/shop/coupons"), "discounts");
  assert.equal(sectionOf("/api/keeta-payouts/refunds"), "finance");
  assert.equal(sectionOf("/api/cms/users"), "settings");
});

test("kitchen role cannot touch finance; owner and accounting can edit it", () => {
  assert.equal(DEFAULT_PERMS.kitchen.finance, "none");
  assert.equal(DEFAULT_PERMS.kitchen.orders, "edit");
  assert.equal(DEFAULT_PERMS.owner.finance, "edit");
  assert.equal(DEFAULT_PERMS.accounting.finance, "edit");
  // operations عندهم orders: edit بس مالهمش المالية — الاسترجاع مقفول عليهم كمان
  assert.equal(DEFAULT_PERMS.operations.finance, "none");
});

/* W1-03 — التسجيل المسبق لمسارات الموجات الجاية (خطة ٢٠٢٦-٠٩ §٤-٦). */
test("§4-6: every pre-registered pattern maps to its section", () => {
  const cases = [
    // الاسترجاع يفضل مالية حتى بعد إضافة cms/orders العام
    ["/api/shop/orders/W1234/refund", "finance"],
    ["/api/cms/orders/W1234/refund", "finance"],
    ["/api/cms/orders/W1234/courier/cancel", "delivery"],
    ["/api/cms/orders/W1234/courier/dispatch", "delivery"],
    ["/api/cms/orders", "orders"],
    ["/api/cms/orders/W1234", "orders"],
    ["/api/cms/orders/W1234/note", "orders"],
    ["/api/cms/orders/W1234/courier", "orders"], // من غير «/» بعدها = مش فعل مندوب
    ["/api/cms/order-views", "orders"],
    ["/api/cms/order-views/3", "orders"],
    ["/api/cms/offer-pages", "products"],
    ["/api/cms/offer-pages/nd96_kilo", "products"],
    ["/api/cms/search", "home"],
    ["/api/cms/search?q=kilo", "home"],
    ["/api/cms/nav-event", "home"],
    ["/api/journey/customer/5xxxxxxxx", "customers"],
    ["/api/journey/order/W1234", "orders"],
    ["/api/journey/settings", "settings"],
    ["/api/journey/funnel", "analytics"],
    ["/api/journey/sessions", "analytics"],
    ["/api/portal/summary", "orders"],
    ["/api/portal/issues", "orders"],
    ["/api/portal/devices/2", "orders"],
    ["/api/app/config", "growth"],
    // بيفضلوا على الموجود
    ["/api/system/health", "settings"],
    ["/api/ads/plan", "growth"],
  ];
  for (const [path, section] of cases) assert.equal(sectionOf(path), section, path);
});

test("§4-6: pre-registration didn't move existing cms routes", () => {
  assert.equal(sectionOf("/api/cms/offers"), "products");
  assert.equal(sectionOf("/api/cms/offers/nd96_kilo"), "products");
  assert.equal(sectionOf("/api/cms/bundles"), "products");
  assert.equal(sectionOf("/api/cms/home"), "home");
  assert.equal(sectionOf("/api/cms/links"), "growth");
  assert.equal(sectionOf("/api/cms/ops/live"), "orders");
  assert.equal(sectionOf("/api/cms/audit"), "settings");
  assert.equal(sectionOf("/api/portal/login"), "settings"); // مش في القايمة ⇒ الافتراضي المقفول
  assert.equal(sectionOf("/api/apps"), "settings");         // ^/api/app/ بالشرطة بس
});

test("«منتظرين الفتح» والتقييمات في قسمهم الصح", () => {
  // استرداد طلب ضايع = نمو، زي السلات المتروكة بالظبط
  assert.equal(sectionOf("/api/cms/openwait"), "growth");
  assert.equal(sectionOf("/api/openwait/join"), "growth");
  assert.equal(sectionOf("/api/carts/stats"), "growth");
  // التقييمات (بما فيها جوجل والدعوات) تحت العملاء
  assert.equal(sectionOf("/api/cms/reviews/google"), "customers");
  assert.equal(sectionOf("/api/cms/reviews/invites"), "customers");
});

/* ١٨/٩ — «طلبات نقطة البيع» كانت 403 لأي دور غير المالك: /api/manager/* مكانش
   متصنّف فكان بيقع على «الإعدادات». دلوقتي «الطلبات» (قراءة). */
test("POS orders explorer (/api/manager/*) maps to orders, so ops/kitchen/marketing roles can view", () => {
  assert.equal(sectionOf("/api/manager/orders"), "orders");
  assert.equal(sectionOf("/api/manager/order/123456/items"), "orders");
  assert.notEqual(sectionOf("/api/managerx/orders"), "orders"); // الـprefix لازم يكون بالظبط
  // الدور اللي عنده orders عرض على الأقل يعدّي، والمحاسبة بتقرا كمان
  for (const role of ["owner", "operations", "kitchen"]) assert.notEqual(DEFAULT_PERMS[role].orders, "none", role);
});

test("dashboard SMS opt-out + courier report map to customers / orders", () => {
  assert.equal(sectionOf("/api/cms/sms-optout"), "customers");
  assert.equal(sectionOf("/api/cms/sms-optout/abc123"), "customers");
  assert.equal(sectionOf("/api/cms/sms-optout/resubscribe"), "customers");
  assert.equal(sectionOf("/api/cms/ops/courier-report"), "orders");
  assert.equal(sectionOf("/api/content/posts/cp_1/pause"), "growth");
  assert.equal(sectionOf("/api/content/queue"), "growth");
});

test("مُرسل واتساب تحت «العملاء» مش «الإعدادات» (٢٦/٩)", () => {
  assert.equal(sectionOf("/api/cms/wa-sender"), "customers");
  assert.equal(sectionOf("/api/cms/wa-sender/jobs/3/results"), "customers");
  assert.equal(sectionOf("/api/cms/outreach"), "customers");
});
