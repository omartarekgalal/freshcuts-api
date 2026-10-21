// APP1 (21/10): data collected in the Fresh Cuts app never reaches an ad platform — Apple's definition of "tracking"
// (App Tracking Transparency) / Google Play "shared for advertising". uploadgate.js is the one gate for every phone
// and conversion upload; retargeting.js filters the ladder; funnel.serverPurchase skips app orders (funnel-purchase.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filterPhones, gateOfflineRows, appPhones, isAppClient, APP_PHONES_SQL } from "./uploadgate.js";

function pool({ app = ["544000001"], appOrders = [], failApp = false, policy = { sa: "true", pc: "true", co: "false" } } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push(sql);
      if (/FROM ap_settings/.test(sql)) return { rows: [policy] };
      if (/opted_out_at IS NOT NULL/.test(sql)) return { rows: [] };
      if (/FROM settings WHERE id=1/.test(sql)) return { rows: [{ data: {} }] };
      if (/FROM ambassadors/.test(sql)) return { rows: [] };
      if (/is_test IS TRUE/.test(sql)) return { rows: [] };
      if (sql === APP_PHONES_SQL) { if (failApp) throw new Error("db down"); assert.deepEqual(params[0], ["ios", "android"]); return { rows: app.map((p) => ({ phone_norm: p })) }; }
      if (/SELECT pos_order_id, pos_tenant_order_id FROM shop_orders/.test(sql)) { if (failApp) throw new Error("db down"); return { rows: appOrders }; }
      if (/SELECT pos_order_id FROM shop_orders/.test(sql)) return { rows: [{ pos_order_id: "WEBPOS1" }, { pos_order_id: "APPPOS1" }] };
      if (/aud_upload_log/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test("isAppClient: ios/android only", () => {
  assert.equal(isAppClient("ios"), true);
  assert.equal(isAppClient("ANDROID"), true);
  for (const c of ["web", "pwa", "webview", null, undefined, ""]) assert.equal(isAppClient(c), false);
});

test("appPhones: one query on shop_orders.client; a failed read = null (callers block)", async () => {
  assert.deepEqual([...(await appPhones(pool({ app: ["0544000001", "+966544000002"] })))], ["544000001", "544000002"]);
  assert.equal(await appPhones(pool({ failApp: true })), null);
  assert.match(APP_PHONES_SQL, /client = ANY\(\$1::text\[\]\)/);
});

test("lists: a number that ever ordered in the app is removed from every audience upload (counted, not logged)", async () => {
  const f = await filterPhones(pool(), ["544000001", "0544000009", "544000010"], { requireConsent: false });
  assert.deepEqual(f.phones, ["0544000009", "544000010"]);
  assert.equal(f.stats.excluded_app, 1);
  assert.equal(f.stats.kept, 2);
});

test("lists: app numbers unknown (read failed) ⇒ the whole upload is blocked", async () => {
  const f = await filterPhones(pool({ failApp: true }), ["544000009"], { requireConsent: false });
  assert.match(f.blocked, /APP1/);
});

test("offline: an app order seen at the till is never sent (neither as website nor as physical_store); web orders still pass", async () => {
  const rows = [
    { order_id: "WEBPOS1", phone_norm: "544000009" },
    { order_id: "APPPOS1", phone_norm: "544000001" },
    { order_id: "5301", web_pos_id: "APPHASH", phone_norm: "544000001" },   // tenant number resolved to an app order (T1)
    { order_id: "5302", phone_norm: "544000001" },                           // in-store sale by an app customer
    { order_id: "5303", phone_norm: "544000011" },                           // ordinary in-store sale
  ];
  const out = await gateOfflineRows(pool({ appOrders: [{ pos_order_id: "APPPOS1", pos_tenant_order_id: null }, { pos_order_id: "APPHASH", pos_tenant_order_id: "5301" }] }), rows);
  const ids = out.rows.map((r) => r.order_id).sort();
  assert.deepEqual(ids, ["5303", "WEBPOS1"]);
  assert.equal(out.app, 2);
});

test("offline: app orders unknown (read failed) ⇒ no shop order goes out in this batch", async () => {
  const out = await gateOfflineRows(pool({ failApp: true }), [{ order_id: "WEBPOS1", phone_norm: "544000009" }]);
  assert.equal(out.rows.length, 0);
});

test("retargeting ladder drops app customers; unknown ⇒ dry run", () => {
  const s = readFileSync(new URL("./retargeting.js", import.meta.url), "utf8");
  assert.match(s, /const appSet = await appPhones\(pool\);\s*\n\s*if \(!appSet\) dry = true;\s*\n\s*const rows = \(await ladder\(\)\)\.filter\(\(x\) => !appSet \|\| !appSet\.has\(String\(x\.pn\)\)\);/);
});
