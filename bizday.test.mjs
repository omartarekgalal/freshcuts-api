import test from "node:test";
import assert from "node:assert/strict";
import { bizDay, bizStart, bizEnd, bizRange, riyadhHour, bizHourIndex, bizDaySql, shiftDay } from "./bizday.js";

test("owner rule: an order at 01:00 on 19/9 (Riyadh) belongs to 18/9", () => {
  assert.equal(bizDay("2026-09-18T22:00:00Z"), "2026-09-18"); // 01:00 Riyadh 19/9
  assert.equal(bizDay("2026-09-19T00:05:00Z"), "2026-09-18"); // 03:05 Riyadh (Thu/Fri late close)
  assert.equal(bizDay("2026-09-19T00:59:59Z"), "2026-09-18"); // 03:59:59
  assert.equal(bizDay("2026-09-19T01:00:00Z"), "2026-09-19"); // 04:00 → new day
  assert.equal(bizDay("2026-09-19T08:00:00Z"), "2026-09-19"); // 11:00 opening
  assert.equal(bizDay("2026-09-18T20:59:00Z"), "2026-09-18"); // 23:59 Riyadh
});

test("bizStart / bizEnd are 04:00 Riyadh boundaries", () => {
  assert.equal(bizStart("2026-09-18").toISOString(), "2026-09-18T01:00:00.000Z");
  assert.equal(bizEnd("2026-09-18").toISOString(), "2026-09-19T01:00:00.000Z");
});

test("hour helpers", () => {
  assert.equal(riyadhHour("2026-09-18T22:30:00Z"), 1);
  assert.equal(bizHourIndex(4), 0);
  assert.equal(bizHourIndex(3), 23);
  assert.equal(bizHourIndex(11), 7);
  assert.match(bizDaySql("o.order_date"), /Asia\/Riyadh.*4 hours/);
});

test("today preset at 01:30 Riyadh on 19/9 is still 18/9, partial, comparisons cut at same offset", () => {
  const now = new Date("2026-09-18T22:30:00Z");
  const r = bizRange({ preset: "today", now });
  assert.equal(r.from, "2026-09-18");
  assert.equal(r.to, "2026-09-18");
  assert.equal(r.partial, true);
  assert.equal(r.cutUtc.toISOString(), now.toISOString());
  assert.equal(r.prev.from, "2026-09-17");
  assert.equal(r.prev.cutUtc.toISOString(), "2026-09-17T22:30:00.000Z");
  assert.equal(r.lastWeek.from, "2026-09-11");
  assert.equal(r.lastWeek.label, "نفس اليوم الأسبوع اللي فات");
  assert.equal(r.elapsedH, 21.5);
});

test("yesterday is a full day, not partial", () => {
  const r = bizRange({ preset: "yesterday", now: new Date("2026-09-19T10:00:00Z") });
  assert.equal(r.from, "2026-09-18");
  assert.equal(r.partial, false);
  assert.equal(r.cutUtc.toISOString(), "2026-09-19T01:00:00.000Z");
});

test("presets resolve (Saturday default week start, Sunday optional)", () => {
  const now = new Date("2026-09-19T10:00:00Z"); // Saturday 19/9 biz day
  const p = (id, ws = 0) => { const r = bizRange({ preset: id, now, weekStart: ws }); return [r.from, r.to]; };
  assert.deepEqual(bizRange({ preset: "wtd", now }).from, "2026-09-19"); // default = Saturday
  assert.deepEqual([bizRange({ preset: "lastWeek", now }).from, bizRange({ preset: "lastWeek", now }).to], ["2026-09-12", "2026-09-18"]);
  assert.deepEqual(p("last7"), ["2026-09-13", "2026-09-19"]);
  assert.deepEqual(p("last30"), ["2026-08-21", "2026-09-19"]);
  assert.deepEqual(p("mtd"), ["2026-09-01", "2026-09-19"]);
  assert.deepEqual(p("wtd"), ["2026-09-13", "2026-09-19"]);          // Sun 13/9
  assert.deepEqual(p("thisWeek"), ["2026-09-13", "2026-09-19"]);
  assert.deepEqual(p("lastWeek"), ["2026-09-06", "2026-09-12"]);
  assert.deepEqual(p("lastMonth"), ["2026-08-01", "2026-08-31"]);
  assert.deepEqual(p("wtd", 6), ["2026-09-19", "2026-09-19"]);       // Saturday start
});

test("custom range, swapped bounds, comparisons keep weekday alignment", () => {
  const r = bizRange({ from: "2026-09-18", to: "2026-09-01", now: new Date("2026-09-19T10:00:00Z") });
  assert.equal(r.preset, "custom");
  assert.equal(r.from, "2026-09-01");
  assert.equal(r.days, 18);
  assert.equal(r.prev.to, "2026-08-31");
  assert.equal(r.prev.from, "2026-08-14");
  assert.equal(r.lastWeek.shiftDays, 21); // 18 days → 3 whole weeks back
  assert.equal(shiftDay(r.from, -21), r.lastWeek.from);
});

test("bad input falls back to today", () => {
  const r = bizRange({ preset: "nope", from: "x", now: new Date("2026-09-19T10:00:00Z") });
  assert.equal(r.preset, "today");
  assert.equal(r.from, "2026-09-19");
});
