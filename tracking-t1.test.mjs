// T1 (10/10 tracking audit): Snap single external_id, Meta name/city/country keys,
// website orders seen at the till use the website key + carry their Google click id.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Hono } from "hono";

process.env.META_WEB_PIXEL_ID = "PIXEL_TEST";
process.env.META_CAPI_TOKEN = "fake-token-for-tests";
process.env.SNAP_WEB_PIXEL_ID = "SNAP_TEST";
process.env.SNAP_ACCESS_TOKEN = "fake-snap-token";
process.env.TIKTOK_WEB_PIXEL_ID = "TT_TEST";
process.env.TIKTOK_ACCESS_TOKEN = "fake-tt-token";

const F = await import("./funnel.js");
const A = await import("./ads.js");
const { createGoogleAdapter } = await import("./google.js");
const { gateOfflineRows } = await import("./uploadgate.js");

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const DEV_HASH = sha("fc:dmg3k2x1abcdefgh");
const DIGITS = "966544775082";

/* ── Snap ─────────────────────────────────────────────────────────────── */
test("snapExternalId: never more than one value (Snap answers HTTP 400 to two)", () => {
  assert.deepEqual(F.snapExternalId({ externalId: DEV_HASH, digits: DIGITS }), [DEV_HASH]);
  assert.deepEqual(F.snapExternalId({ digits: DIGITS }), [sha(DIGITS)]);
  assert.deepEqual(F.snapExternalId({ externalId: DEV_HASH }), [DEV_HASH]);
  assert.equal(F.snapExternalId({}), null);
});

function normPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00966")) return d.slice(5);
  if (d.startsWith("966")) return d.slice(3);
  if (d.startsWith("0") && d.length === 10) return d.slice(1);
  return d;
}
function setup() {
  const calls = [];
  const pool = { async query(sql) {
    if (/SELECT slug, offer_id FROM cms_bundles/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM shop_orders/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO/.test(sql)) return { rows: [{ id: "x" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const app = new Hono();
  F.register(app, { pool, requireAdmin: async () => null, jb: (v) => JSON.stringify(v), normPhone }, {
    httpJson: async (url, opt) => { calls.push({ url, body: opt.body }); return /snapchat/.test(url) ? { ok: true, status: 200, json: { status: "VALID" } } : /tiktok/.test(url) ? { ok: true, status: 200, json: { code: 0 } } : { ok: true, status: 200, json: { events_received: 1 } }; },
  });
  const post = (body) => app.request("/api/funnel/event", { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", "user-agent": "Mozilla/5.0 (iPhone)" }, body: JSON.stringify(body) });
  return { calls, post };
}

test("route: an event with a device id AND a phone sends ONE external_id to Snap, two to Meta, country=sa", async () => {
  const { calls, post } = setup();
  const r = await post({ eventName: "AddToCart", value: 30, phone: "0544775082", anonId: "dmg3k2x1abcdefgh", clickIds: { fbp: "fb.1.1.2" } });
  assert.equal(r.status, 200);
  const snap = calls.find((c) => /snapchat/.test(c.url)).body.data[0].user_data;
  assert.deepEqual(snap.external_id, [DEV_HASH]);
  assert.deepEqual(snap.ph, [sha(DIGITS)]);
  const meta = calls.find((c) => /facebook/.test(c.url)).body.data[0].user_data;
  assert.deepEqual(meta.external_id, [DEV_HASH, sha(DIGITS)]);
  assert.deepEqual(meta.country, [sha("sa")]);
  assert.equal(meta.fn, undefined);                    // the browser never sends a name
  assert.equal(meta.ct, undefined);
});

test("route: an anonymous event claims no country", async () => {
  const { calls, post } = setup();
  await post({ eventName: "PageView", anonId: "dmg3k2x1abcdefgh" });
  const meta = calls.find((c) => /facebook/.test(c.url)).body.data[0].user_data;
  assert.equal(meta.country, undefined);
  assert.equal(meta.ph, undefined);
});

/* ── Meta match keys ──────────────────────────────────────────────────── */
test("nameParts: first / last word, lowercase, punctuation out, placeholders refused", () => {
  assert.deepEqual(F.nameParts("  Ahmed  Al-Ghamdi "), { fn: "ahmed", ln: "ghamdi" });
  assert.deepEqual(F.nameParts("محمد عبدالله الحربي"), { fn: "محمد", ln: "الحربي" });
  assert.deepEqual(F.nameParts("Sara"), { fn: "sara", ln: null });
  for (const bad of ["", null, "عميل", "عميل أونلاين", "Customer", "x", "123"]) assert.deepEqual(F.nameParts(bad), { fn: null, ln: null }, String(bad));
});

test("countryOfDigits: only a Saudi mobile is 'sa'", () => {
  assert.equal(F.countryOfDigits("966544775082"), "sa");
  for (const no of ["201001234567", "96654477508", "9661144775082", "", null]) assert.equal(F.countryOfDigits(no), null, String(no));
});

test("serverPurchaseEvent + metaUserData: paid order carries fn, ln, ct=jeddah, country=sa, all hashed", () => {
  const e = F.serverPurchaseEvent({ order_no: "W1", pos_order_id: "PngGq71OeN", total: 120, customer: { name: "Omar Tarek", deviceId: "dmg3k2x1abcdefgh" }, attribution: { ip: "1.2.3.4", ua: "UA", click: { fbp: "fb.1.1.2" } } }, { digits: DIGITS });
  const u = F.metaUserData(e);
  assert.deepEqual(u.fn, [sha("omar")]);
  assert.deepEqual(u.ln, [sha("tarek")]);
  assert.deepEqual(u.ct, [sha("jeddah")]);
  assert.deepEqual(u.country, [sha("sa")]);
  assert.deepEqual(u.ph, [sha(DIGITS)]);
  assert.ok(!JSON.stringify(u).toLowerCase().includes("omar"));     // nothing readable leaves
});

test("metaUserData: a placeholder name adds nothing", () => {
  const u = F.metaUserData({ ip: "1.2.3.4", ua: "UA", digits: DIGITS, fullName: "عميل", click: {} });
  assert.equal(u.fn, undefined);
  assert.equal(u.ln, undefined);
});

/* ── website order seen at the till ───────────────────────────────────── */
test("loadOrdersQuery: resolves the shop order by partner hash id OR tenant number, and holds both", () => {
  const q = A.loadOrdersQuery("2026-10-01", "2026-10-10", 500);
  assert.match(q.text, /w\.pos_order_id = o\.order_id OR w\.pos_tenant_order_id = o\.order_id/);
  assert.match(q.text, /web\.pos_order_id AS web_pos_id, web\.click AS web_click/);
  assert.match(q.text, /\(so\.pos_order_id = o\.order_id OR so\.pos_tenant_order_id = o\.order_id\)\s+AND so\.created_at > NOW\(\) - \(\$4 \|\| ' hours'\)::interval/);
  assert.deepEqual(q.values, ["2026-10-01", "2026-10-10", 500, "6"]);
});

test("webOrderOverlay: the till row of a website order takes the website key and the order's click id", () => {
  const o = A.webOrderOverlay({ order_id: "5279", web_pos_id: "7mowxnagLV", web_click: { gclid: "Cj0KCQ", fbp: "fb.1.1.2", fbclid: "x" } });
  assert.deepEqual(o, { orderId: "7mowxnagLV", legacyId: "5279", click: { gclid: "Cj0KCQ", gbraid: null, wbraid: null } });
  // old flow: the till id IS the shop id → nothing legacy, no click
  assert.deepEqual(A.webOrderOverlay({ order_id: "123", web_pos_id: "123", web_click: {} }), { orderId: "123", legacyId: null, click: null });
  assert.equal(A.webOrderOverlay({ order_id: "5280" }), null);         // a plain till order
  assert.equal(A.webOrderOverlay({ order_id: "5280", web_pos_id: null, web_click: null }), null);
  assert.deepEqual(A.webOrderOverlay({ order_id: "9", web_pos_id: "H", web_click: { gbraid: "GB" } }).click, { gclid: null, gbraid: "GB", wbraid: null });
});

test("Google Data Manager: a website order seen at the till is a WEB event with its gclid", () => {
  process.env.GOOGLE_ADS_CUSTOMER_ID = "878-265-9560";
  process.env.GOOGLE_ADS_CONVERSION_ACTION_ID = "7717198051";
  const g = createGoogleAdapter({ httpJson: async () => ({ ok: false }), hashEmail: () => null, hashPhonePlus: (d) => (d ? sha("+" + d) : null), googleDateTime: (d) => d.toISOString() });
  const web = g.dmEvent({ orderId: "7mowxnagLV", eventTime: new Date(), value: 113, phoneDigits: DIGITS, actionSource: "physical_store", webOrder: true, gclid: "Cj0KCQ" });
  assert.equal(web.eventSource, "WEB");
  assert.deepEqual(web.adIdentifiers, { gclid: "Cj0KCQ" });
  assert.equal(web.transactionId, "7mowxnagLV");
  const till = g.dmEvent({ orderId: "5280", eventTime: new Date(), value: 50, phoneDigits: DIGITS, actionSource: "physical_store" });
  assert.equal(till.eventSource, "IN_STORE");
});

test("upload gate: a till row that resolved to a shop order is a website order (always passes)", async () => {
  const pool = { async query(sql) {
    if (/SELECT pos_order_id FROM shop_orders/.test(sql)) return { rows: [] };          // the tenant number never matches pos_order_id
    return { rows: [] };
  } };
  const rows = [{ order_id: "5279", web_pos_id: "7mowxnagLV", phone_norm: "544775082" }, { order_id: "5280", phone_norm: "500000001" }];
  const out = await gateOfflineRows(pool, rows, { trigger: "test" });
  assert.ok(out.rows.some((r) => r.order_id === "5279"), "website order kept");
});
