import test from "node:test";
import assert from "node:assert/strict";
import { zonedHourToUtc, tzOffsetMin, metaRowToHour, snapPointToHour, metaDaysFor, bucketByBizDay, campaignKind } from "./adspend.js";

test("LA hour → UTC respects DST", () => {
  // PDT (UTC-7) in September
  assert.equal(zonedHourToUtc("2026-09-18", 1, "America/Los_Angeles").toISOString(), "2026-09-18T08:00:00.000Z");
  // PST (UTC-8) in December
  assert.equal(zonedHourToUtc("2026-12-10", 1, "America/Los_Angeles").toISOString(), "2026-12-10T09:00:00.000Z");
  assert.equal(tzOffsetMin(Date.parse("2026-09-18T12:00:00Z"), "Asia/Riyadh"), 180);
});

test("a Meta hourly row lands on the right Riyadh business day", () => {
  // LA 17:00 on 18/9 = 00:00Z 19/9 = 03:00 Riyadh 19/9 → business day 18/9
  const late = metaRowToHour({ campaign_id: "1", campaign_name: "FC-96-STORE", objective: "OUTCOME_SALES", spend: "10.5",
    date_start: "2026-09-18", hourly_stats_aggregated_by_advertiser_time_zone: "17:00:00 - 17:59:59", actions: [{ action_type: "purchase", value: "2" }] }, "America/Los_Angeles");
  assert.equal(late.hour_start.toISOString(), "2026-09-19T00:00:00.000Z");
  assert.equal(late.biz_day, "2026-09-18");
  assert.equal(late.purchases, 2);
  assert.equal(late.kind, "web");
  // LA 18:00 on 18/9 = 04:00 Riyadh 19/9 → business day 19/9
  const early = metaRowToHour({ campaign_id: "2", campaign_name: "fc-wa-orders", objective: "OUTCOME_ENGAGEMENT", spend: "3",
    date_start: "2026-09-18", hourly_stats_aggregated_by_advertiser_time_zone: "18:00:00 - 18:59:59" }, "America/Los_Angeles");
  assert.equal(early.biz_day, "2026-09-19");
  assert.equal(early.kind, "whatsapp");
});

test("snap point converts USD micros at the 3.75 peg", () => {
  const x = snapPointToHour({ start_time: "2026-09-19T02:00:00.000+03:00", stats: { spend: 1000000 } });
  assert.equal(x.spend, 3.75);
  assert.equal(x.biz_day, "2026-09-18");
});

test("meta days needed for one business day", () => {
  assert.deepEqual(metaDaysFor("2026-09-18", "2026-09-18", "America/Los_Angeles"), { since: "2026-09-17", until: "2026-09-18" });
});

test("bucketing splits WhatsApp out of Meta", () => {
  const rows = [
    { platform: "meta", kind: "web", hour_start: new Date("2026-09-18T10:00:00Z"), spend: 10 },
    { platform: "meta", kind: "whatsapp", hour_start: new Date("2026-09-18T11:00:00Z"), spend: 4 },
    { platform: "snapchat", kind: "web", hour_start: new Date("2026-09-19T00:30:00Z"), spend: 2 },
    { platform: "meta", kind: "web", hour_start: new Date("2026-09-19T01:00:00Z"), spend: 1 },
  ];
  const b = bucketByBizDay(rows);
  assert.deepEqual(b[0], { day: "2026-09-18", total: 16, meta: 10, meta_whatsapp: 4, snapchat: 2 });
  assert.equal(b[1].day, "2026-09-19");
  assert.equal(campaignKind("FC-96-STORE", "OUTCOME_SALES"), "web");
});
