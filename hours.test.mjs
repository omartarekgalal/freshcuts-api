import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenNow } from "./carts.js";

// مواعيد عمر من اللوحة: ١٢ الضهر → ٢ الفجر، والخميس والجمعة لين ٣
const HOURS = { enabled: true, days: {
  sat: { open: "12:00", close: "02:00" }, sun: { open: "12:00", close: "02:00" },
  mon: { open: "12:00", close: "02:00" }, tue: { open: "12:00", close: "02:00" },
  wed: { open: "12:00", close: "02:00" }, thu: { open: "12:00", close: "03:00" },
  fri: { open: "12:00", close: "03:00" } } };
const riyadh = (iso) => new Date(iso + "+03:00");

test("الأحد ٣:٠٤ الفجر مقفول — ده اللي عمر شافه «مفتوح»", () => {
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-13T03:04:00")), false);
});
test("الأحد ١:٣٠ الفجر مفتوح — لسه ذيل ليلة السبت (لين ٢)", () => {
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-13T01:30:00")), true);
});
test("الأحد ٢:٣٠ الفجر مقفول — السبت بيقفل ٢", () => {
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-13T02:30:00")), false);
});
test("الجمعة ٢:٣٠ الفجر مفتوح — الخميس بيقفل ٣", () => {
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-18T02:30:00")), true);
});
test("السبت ٢:٣٠ الفجر مفتوح — الجمعة بتقفل ٣", () => {
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-19T02:30:00")), true);
});
test("الاثنين ١١:٥٩ مقفول و١٢:٠٠ مفتوح", () => {
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-14T11:59:00")), false);
  assert.equal(isOpenNow(HOURS, riyadh("2026-09-14T12:00:00")), true);
});
test("المواعيد مش متفعّلة = مانمنعش", () => {
  assert.equal(isOpenNow({ enabled: false, days: HOURS.days }, riyadh("2026-09-13T04:00:00")), true);
  assert.equal(isOpenNow(null), true);
});
