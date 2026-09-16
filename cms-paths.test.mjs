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
