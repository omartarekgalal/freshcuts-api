import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./smsrules.js";

const at = (h, m = 0) => new Date(Date.UTC(2026, 8, 17, (h - 3 + 24) % 24, m)); // Riyadh h:m

test("quiet hours 22:00–12:00 Riyadh", () => {
  assert.equal(R.inQuietHours(at(16, 30)), false);
  assert.equal(R.inQuietHours(at(12, 0)), false);
  assert.equal(R.inQuietHours(at(21, 59)), false);
  assert.equal(R.inQuietHours(at(22, 0)), true);
  assert.equal(R.inQuietHours(at(3, 0)), true);
  assert.equal(R.inQuietHours(at(11, 59)), true);
});

test("sms parts: Arabic = UCS-2 (70/67), English GSM (160/153)", () => {
  assert.equal(R.smsParts("a".repeat(160)), 1);
  assert.equal(R.smsParts("a".repeat(161)), 2);
  assert.equal(R.smsParts("ب".repeat(70)), 1);
  assert.equal(R.smsParts("ب".repeat(71)), 2);
  assert.equal(R.smsParts("ب".repeat(134)), 2);
  assert.equal(R.smsParts("ب".repeat(135)), 3);
  assert.equal(R.smsParts("🛒" + "ب".repeat(69)), 2); // emoji = 2 units
});

test("apps-only customers and staff/opted-out/gap are excluded", () => {
  const m = [
    { pn: "500000001", orders: 3, appOrders: 3, online: 0 },   // keeta only
    { pn: "500000002", orders: 3, appOrders: 1, online: 0 },   // mixed → ok
    { pn: "500000003", orders: 1, appOrders: 0, online: 0 },   // staff
    { pn: "500000004", orders: 1, appOrders: 0, online: 0 },   // opted out
    { pn: "500000005", orders: 1, appOrders: 0, online: 0 },   // messaged recently
    { pn: "500000006", orders: 1, appOrders: 1, online: 1 },   // app + website → direct
  ];
  const f = R.filterAudience(m, { staff: new Set(["500000003"]), optedOut: new Set(["500000004"]), recentlyMessaged: new Set(["500000005"]) });
  assert.deepEqual(f.list.map((x) => x.pn), ["500000002", "500000006"]);
  assert.deepEqual(f.excluded, { apps_only: 1, staff: 1, opted_out: 1, gap: 1, recent_online_order: 0 });
});

test("staff phones come from alert/new-order/exclude lists in any format", () => {
  const s = R.staffPhoneSet({ delivery: { alertPhones: ["0544775082", "966506338246"], newOrderPhones: "0506338246" }, cms: { campaigns: { excludePhones: ["+966 55 111 2222"] } } });
  assert.deepEqual([...s].sort(), ["506338246", "544775082", "551112222"]);
});

test("wave segments don't overlap for the same day", () => {
  const ids = ["w_hall_regulars", "w_lapsed", "w_one_time", "w_recent_new", "w_online_buyers"];
  const segs = R.WAVE_SEGMENTS.filter((s) => ids.includes(s.id));
  for (let orders = 1; orders <= 6; orders++) for (let d = 0; d <= 120; d++) for (const online of [0, 1]) {
    const c = { orders, appOrders: 0, online, daysSince: d };
    const hits = segs.filter((s) => s.test(c)).map((s) => s.id);
    assert.ok(hits.length <= 1, `${orders}/${d}/${online} → ${hits}`);
  }
  const hall = R.WAVE_SEGMENTS.find((s) => s.id === "w_hall_regulars");
  assert.equal(hall.test({ orders: 4, appOrders: 4, online: 0, daysSince: 3 }), false, "apps-only never in a wave");
});

test("holdout is deterministic and near the percentage", () => {
  let n = 0;
  for (let i = 0; i < 2000; i++) if (R.inHoldout(7, String(500000000 + i), 15)) n++;
  assert.ok(n > 220 && n < 380, String(n));
  assert.equal(R.inHoldout(7, "512345678", 15), R.inHoldout(7, "512345678", 15));
  assert.equal(R.inHoldout(7, "512345678", 0), false);
});

test("audience drift tolerance", () => {
  assert.equal(R.audienceDriftOk(100, 118), true);
  assert.equal(R.audienceDriftOk(100, 125), false);
  assert.equal(R.audienceDriftOk(20, 29), true);
});
