// QA 10/10: a checkout that carries an ended / invalid table session must be refused by the SERVER (never turned into pickup).
// Run: node --test table-ended-checkout.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tableGate, tableCfg, TABLE_MSG, deviceHash } from "./table-order.js";

const SID = "AbCdEfGhIjKlMnOpQrStUv", DEV = "dev-AAAAAAAAAAAAAAAAAAAAAA";
const IN = { lat: 21.5881404, lng: 39.1521236, accuracy: 10 };
const poolWith = (row) => ({ query: async (sql) => (/FROM table_sessions s LEFT JOIN table_qr/.test(sql) ? { rows: row ? [row] : [], rowCount: row ? 1 : 0 } : { rows: [], rowCount: 0 }) });

const dh = deviceHash(DEV);
const cfg = tableCfg({ tables: { enabled: true } });

test("a freed / idle / rotated / unknown session is refused with table_invalid — whatever the location says", async () => {
  for (const reason of ["freed", "idle", "rotated", "geofence", "moved", "disabled"]) {
    const g = await tableGate(poolWith({ table_no: 7, device_hash: dh, via_key: true, ended_at: new Date(), end_reason: reason, idle: false, active: true }), { session: SID, device: DEV, geo: IN }, cfg, { endOnFar: true });
    assert.deepEqual([g.ok, g.error, g.reason], [false, "table_invalid", reason]);
  }
  const unknown = await tableGate(poolWith(null), { session: SID, device: DEV, geo: IN }, cfg, { endOnFar: true });
  assert.deepEqual([unknown.ok, unknown.error, unknown.reason], [false, "table_invalid", "unknown_session"]);
  const otherDevice = await tableGate(poolWith({ table_no: 7, device_hash: "x".repeat(64), via_key: true, ended_at: null, idle: false, active: true }), { session: SID, device: DEV, geo: IN }, cfg);
  assert.deepEqual([otherDevice.ok, otherDevice.error], [false, "table_invalid"]);
});

test("a live session inside the restaurant still passes (the guard is not over-eager)", async () => {
  const g = await tableGate(poolWith({ table_no: 7, device_hash: dh, via_key: true, ended_at: null, idle: false, active: true }), { session: SID, device: DEV, geo: IN }, cfg);
  assert.deepEqual([g.ok, g.table], [true, 7]);
});

test("wiring: checkout runs the gate before anything else and answers 409 with the customer message — no pickup fallback", () => {
  const shop = readFileSync(new URL("./shop.js", import.meta.url), "utf8");
  const i = shop.indexOf("const tg = await tableGate(pool, { session: tableSid, device: b.table_device, geo: tableGeoIn }, tcfg, { endOnFar: true });");
  assert.ok(i > 0);
  const after = shop.slice(i, i + 700);
  assert.ok(after.includes("return fail(tg.error, 409, { message: msg, detail: msg, reason: tg.reason });"));
  assert.ok(i < shop.indexOf("INSERT INTO shop_orders(order_no"), "refused before any order row exists");
  assert.ok(!/option\s*=\s*"pickup"/.test(after), "the order is never downgraded to pickup");
  assert.ok(TABLE_MSG.table_invalid.length > 10);
});
