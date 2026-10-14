/* تحكم هنقرستيشن (hs_control.js) — نفس أشكال الطلبات اللي البوابة بتبعتها واتجرّبت ١٤/١٠. */
import test from "node:test";
import assert from "node:assert/strict";

import { hsSchedules, hsItemView } from "./hs_control.js";
import { sectionOf } from "./cms.js";

const NOW = Date.parse("2026-10-14T12:56:16.359Z");

test("schedules: timed = AT_TIMESTAMP without millis (exact shape HS accepted)", () => {
  assert.deepEqual(hsSchedules("30m", NOW), [{ action: "ENABLE", type: "AT_TIMESTAMP", timestamp: "2026-10-14T13:26:16Z" }]);
  assert.deepEqual(hsSchedules("1h", NOW)[0].timestamp, "2026-10-14T13:56:16Z");
});

test("schedules: next opening, manual, ISO guards", () => {
  assert.deepEqual(hsSchedules("open", NOW), [{ action: "ENABLE", type: "NEXT_BUSINESS_DAY" }]);
  assert.equal(hsSchedules("manual", NOW), undefined);
  assert.equal(hsSchedules("2026-10-14T18:00:00Z", NOW)[0].timestamp, "2026-10-14T18:00:00Z");
  assert.throws(() => hsSchedules("2026-10-14T12:00:00Z", NOW));
  assert.throws(() => hsSchedules("2027-12-01T00:00:00Z", NOW));
  assert.throws(() => hsSchedules("bukra", NOW));
});

test("item view from a real product row", () => {
  const v = hsItemView({
    id: "126034809", name: "كبدة مشوية ثلث كيلو", unitPrice: 50, category: { id: "4608917" },
    availability: { available: false, schedules: [{ type: "AT_TIMESTAMP", action: "ENABLE", timestamp: "2027-09-25T17:08:09Z" }], status: "COMMITTED" },
    images: [{ url: "https://x/y.jpg" }],
  }, "وجبات");
  assert.equal(v.available, false);
  assert.equal(v.backAt, "2027-09-25T17:08:09Z");
  assert.equal(v.pending, false);
  assert.equal(v.category, "وجبات");
  const w = hsItemView({ id: 1, availability: { available: false, status: "REQUESTED", schedules: [{ type: "NEXT_BUSINESS_DAY", action: "ENABLE" }] } });
  assert.equal(w.pending, true);
  assert.equal(w.backAtNextOpen, true);
  assert.equal(hsItemView({ id: 2, availability: { available: true, status: "COMMITTED" } }).available, true);
});

test("permissions: /api/hs/control = products (not the owner-only default)", () => {
  assert.equal(sectionOf("/api/hs/control/state"), "products");
  assert.equal(sectionOf("/api/hs/control/availability"), "products");
  assert.equal(sectionOf("/api/hungerstation/overview"), "analytics");
});
