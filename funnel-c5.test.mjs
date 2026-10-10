// C5 — Meta CAPI external_id (device + phone) and a durable fbc.
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
const { __test: A } = await import("./ads.js");

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const DEV = "dmg3k2x1abcdefgh";
const DEV_HASH = sha("fc:" + DEV);
const DIGITS = "966544775082";

function normPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00966")) return d.slice(5);
  if (d.startsWith("966")) return d.slice(3);
  if (d.startsWith("0") && d.length === 10) return d.slice(1);
  return d;
}

/* ── pure ─────────────────────────────────────────────────────────────── */

test("deviceExternalId: a valid 64-hex value from the storefront wins", () => {
  const given = sha("anything");
  assert.equal(F.deviceExternalId({ externalId: given, anonId: DEV }), given);
  assert.equal(F.deviceExternalId({ externalId: given.toUpperCase() }), given);   // normalised to lowercase
});

test("deviceExternalId: missing or invalid value falls back to sha256('fc:' + fc_dev)", () => {
  assert.equal(F.deviceExternalId({ anonId: DEV }), DEV_HASH);
  for (const bad of ["abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), 12345, { x: 1 }, DEV]) {
    assert.equal(F.deviceExternalId({ externalId: bad, anonId: DEV }), DEV_HASH, String(bad));
    assert.equal(F.deviceExternalId({ externalId: bad }), null, String(bad));
  }
  assert.equal(F.deviceExternalId({ anonId: "short" }), null);
  assert.equal(F.deviceExternalId({ anonId: "has space in it" }), null);
  assert.equal(F.deviceExternalId(), null);
});

test("externalIdsOf: [device, phone], deduped, empty when nothing is known", () => {
  assert.deepEqual(F.externalIdsOf({ externalId: DEV_HASH, digits: DIGITS }), [DEV_HASH, sha(DIGITS)]);
  assert.deepEqual(F.externalIdsOf({ externalId: DEV_HASH }), [DEV_HASH]);
  assert.deepEqual(F.externalIdsOf({ digits: DIGITS }), [sha(DIGITS)]);
  assert.deepEqual(F.externalIdsOf({ externalId: "not-a-hash" }), []);
  assert.deepEqual(F.externalIdsOf({}), []);
});

test("metaUserData: external_id is an array; the phone hash equals ph", () => {
  const u = F.metaUserData({
    ip: "1.2.3.4", ua: "UA", digits: DIGITS, email: null, externalId: DEV_HASH,
    click: { fbp: "fb.1.1.2", fbc: "fb.1.1726400000000.ABC" },
  });
  assert.deepEqual(u.external_id, [DEV_HASH, sha(DIGITS)]);
  assert.deepEqual(u.ph, [sha(DIGITS)]);
  assert.equal(u.external_id[1], u.ph[0]);
  assert.equal(u.fbc, "fb.1.1726400000000.ABC");
  assert.equal(u.fbp, "fb.1.1.2");
  assert.equal(u.client_ip_address, "1.2.3.4");
  // anonymous browsing: device only, nothing invented
  const anon = F.metaUserData({ ip: "1.2.3.4", ua: "UA", externalId: DEV_HASH, click: {} });
  assert.deepEqual(anon.external_id, [DEV_HASH]);
  assert.ok(!("ph" in anon) && !("fbc" in anon));
  const none = F.metaUserData({ ip: "1.2.3.4", ua: "UA", click: {} });
  assert.ok(!("external_id" in none));
});

test("fbcOf: built from fbclid as fb.1.<ms>.<fbclid> when the cookie is missing", () => {
  assert.equal(F.fbcOf({ fbclid: "IwAR123" }, "2026-10-09T10:00:00.000Z"), `fb.1.${Date.parse("2026-10-09T10:00:00.000Z")}.IwAR123`);
  assert.equal(F.fbcOf({ fbc: "fb.1.5.COOKIE", fbclid: "IwAR123" }), "fb.1.5.COOKIE");
  assert.match(F.fbcOf({ fbclid: "IwAR123" }), /^fb\.1\.\d{13}\.IwAR123$/);
  assert.equal(F.fbcOf({}), null);
});

test("serverPurchaseEvent: device id from the order becomes anonId + externalId", () => {
  const order = { order_no: "W1", pos_order_id: "4017", total: 119, customer: { deviceId: DEV }, attribution: null };
  const e = F.serverPurchaseEvent(order, { digits: DIGITS });
  assert.equal(e.anonId, DEV);
  assert.equal(e.externalId, DEV_HASH);
  assert.equal(e.eventId, "4017");                       // dedup id untouched
  const bare = F.serverPurchaseEvent({ order_no: "W2", pos_order_id: "9", total: 10 }, {});
  assert.equal(bare.anonId, null);
  assert.equal(bare.externalId, null);
});

test("stored-fbc lookup is bounded and keyed on device / phone", () => {
  assert.equal(F.STORED_FBC_DAYS, 7);
  assert.match(F.STORED_FBC_SQL, /anon_id = \$1/);
  assert.match(F.STORED_FBC_SQL, /phone_norm = \$2/);
  assert.match(F.STORED_FBC_SQL, /\$3::int \* INTERVAL '1 day'/);
  assert.match(F.STORED_FBC_SQL, /LIMIT 1/);
});

/* ── route + senders ──────────────────────────────────────────────────── */

function setup({ shopOrders = [], stored = [] } = {}) {
  const db = { funnel: [], ads: new Set(), fbcLookups: [] };
  const pool = {
    async query(sql, params = []) {
      const s = String(sql);
      if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/.test(s) && !/INSERT/.test(s)) return { rows: [], rowCount: 0 };
      if (s.includes("click_ids->>'fbc' AS fbc")) {
        db.fbcLookups.push(params);
        const hit = stored.find((r) => (params[0] && r.anon_id === params[0]) || (params[1] && r.phone_norm === params[1]));
        return { rows: hit ? [{ fbc: hit.fbc }] : [], rowCount: hit ? 1 : 0 };
      }
      if (s.includes("to_jsonb(o) AS o FROM shop_orders")) {
        const o = shopOrders.find((x) => x.order_no === params[0]);
        return { rows: o ? [{ o }] : [], rowCount: o ? 1 : 0 };
      }
      if (s.includes("FROM shop_orders")) {
        const o = shopOrders.find((x) => x.pos_order_id === params[0] || x.order_no === params[0]);
        return { rows: o ? [o] : [], rowCount: o ? 1 : 0 };
      }
      if (s.includes("FROM funnel_events") && s.includes("event_name = 'Purchase'")) {
        const hit = db.funnel.find((r) => r.event_name === "Purchase" && params[0].includes(r.order_id));
        return { rows: hit ? [{ x: 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      if (s.includes("INSERT INTO funnel_events")) {
        const dedup = s.includes("dedup_key") ? params[15] : null;
        if (dedup && db.funnel.some((r) => r.dedup_key === dedup)) return { rows: [], rowCount: 0 };
        db.funnel.push({ id: params[0], event_name: params[1], order_id: params[3], click_ids: params[9], dedup_key: dedup,
          anon_id: dedup ? params[17] : params[16] });
        return { rows: dedup ? [{ id: params[0] }] : [], rowCount: 1 };
      }
      if (s.includes("INSERT INTO ads_events")) {
        const key = `${params[1]}|${params[5]}`;
        if (db.ads.has(key)) return { rows: [], rowCount: 0 };
        db.ads.add(key);
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/UPDATE (funnel_events|ads_events)/.test(s)) return { rows: [], rowCount: 1 };
      throw new Error("unexpected SQL in test: " + s.slice(0, 80));
    },
  };
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, init });
    const json = /facebook/.test(url) ? { events_received: 1 } : /tiktok/.test(url) ? { code: 0 } : { status: "VALID" };
    return { ok: true, status: 200, json };
  };
  const app = new Hono();
  const ctx = { pool, requireAdmin: async () => null, jb: (v) => (v == null ? null : JSON.stringify(v)), normPhone };
  const api = F.register(app, ctx, { httpJson: http });
  let n = 0;
  const post = async (body) => (await app.request("/api/funnel/event", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": `10.77.0.${++n}`, "user-agent": "UA-browser" },
    body: JSON.stringify(body),
  })).json();
  const sent = (re) => calls.filter((c) => re.test(c.url)).map((c) => c.init.body.data[0]);
  return { db, calls, api, post, sent };
}

test("route: the storefront's externalId reaches Meta, TikTok and Snap on a plain web event", async () => {
  const given = sha("fc:" + DEV);
  const { post, sent } = setup();
  const out = await post({ eventName: "AddToCart", eventId: "e1", value: 46, anonId: DEV, externalId: given, clickIds: {} });
  assert.equal(out.ok, true);
  const meta = sent(/facebook/)[0];
  assert.equal(meta.event_id, "e1");                                   // dedup id untouched
  assert.equal(meta.event_name, "AddToCart");
  assert.deepEqual(meta.user_data.external_id, [given]);
  assert.equal(sent(/tiktok/)[0].user.external_id, given);
  assert.deepEqual(sent(/snapchat/)[0].user_data.external_id, [given]);
});

test("route: old storefront (anonId only) → the same device hash, derived on the server", async () => {
  const { post, sent } = setup();
  await post({ eventName: "PageView", eventId: "e2", anonId: DEV, clickIds: {} });
  assert.deepEqual(sent(/facebook/)[0].user_data.external_id, [DEV_HASH]);
});

test("route: snake_case external_id is accepted; garbage is ignored, never forwarded", async () => {
  const given = sha("x");
  const a = setup();
  await a.post({ eventName: "PageView", eventId: "e3", external_id: given, clickIds: {} });
  assert.deepEqual(a.sent(/facebook/)[0].user_data.external_id, [given]);
  const b = setup();
  await b.post({ eventName: "PageView", eventId: "e4", externalId: "<script>", clickIds: {} });
  assert.ok(!("external_id" in b.sent(/facebook/)[0].user_data));
});

test("route: a known phone adds the phone hash as the second external_id", async () => {
  const { post, sent } = setup();
  await post({ eventName: "InitiateCheckout", eventId: "e5", anonId: DEV, phone: "0544775082", clickIds: {} });
  const u = sent(/facebook/)[0].user_data;
  assert.deepEqual(u.external_id, [DEV_HASH, sha(DIGITS)]);
  assert.deepEqual(u.ph, [sha(DIGITS)]);
});

test("route: fbclid without an _fbc cookie → fbc = fb.1.<ms>.<fbclid>", async () => {
  const { post, sent } = setup();
  await post({ eventName: "ViewContent", eventId: "e6", anonId: DEV, clickIds: { fbclid: "IwAR_CLICK" } });
  assert.match(sent(/facebook/)[0].user_data.fbc, /^fb\.1\.\d{13}\.IwAR_CLICK$/);
});

test("route: Purchase without any click id takes the fbc remembered for the device", async () => {
  const { post, sent, db } = setup({ stored: [{ anon_id: DEV, fbc: "fb.1.1759900000000.OLDCLICK" }] });
  const out = await post({ eventName: "Purchase", eventId: "ord-1", orderId: "ord-1", value: 100, anonId: DEV, clickIds: {} });
  assert.equal(out.ok, true);
  assert.equal(sent(/facebook/)[0].user_data.fbc, "fb.1.1759900000000.OLDCLICK");
  assert.equal(sent(/facebook/)[0].event_id, "ord-1");
  assert.equal(JSON.parse(db.funnel[0].click_ids).fbc, "fb.1.1759900000000.OLDCLICK");
  assert.equal(db.fbcLookups.length, 1);
});

test("route: the browser's own fbc is never replaced, and non-Purchase events do no lookup", async () => {
  const { post, sent, db } = setup({ stored: [{ anon_id: DEV, fbc: "fb.1.1.OLD" }] });
  await post({ eventName: "Purchase", eventId: "ord-2", orderId: "ord-2", value: 50, anonId: DEV, clickIds: { fbc: "fb.1.2.FRESH" } });
  assert.equal(sent(/facebook/)[0].user_data.fbc, "fb.1.2.FRESH");
  await post({ eventName: "AddToCart", eventId: "e7", anonId: DEV, clickIds: {} });
  assert.equal(db.fbcLookups.length, 0);
  assert.ok(!("fbc" in sent(/facebook/)[1].user_data));
});

test("serverPurchase: external_id = [device, phone]; fbc from the phone's earlier click", async () => {
  const order = {
    order_no: "W1789000000009", status: "pos_created", pos_order_id: "5001", total: 80, discount_percent: 0,
    phone_norm: "544775082", items: [], customer: { deviceId: DEV },
    attribution: { utm: {}, click: {}, ip: "5.6.7.8", ua: "UA-checkout" },
  };
  const { api, sent, db } = setup({ shopOrders: [order], stored: [{ phone_norm: "544775082", fbc: "fb.1.1759900000000.PHONECLICK" }] });
  const out = await api.serverPurchase({ orderNo: order.order_no });
  assert.equal(out.ok, true);
  const ev = sent(/facebook/)[0];
  assert.equal(ev.event_id, "5001");
  assert.equal(ev.action_source, "website");
  assert.deepEqual(ev.user_data.external_id, [DEV_HASH, sha(DIGITS)]);
  assert.equal(ev.user_data.fbc, "fb.1.1759900000000.PHONECLICK");
  assert.equal(db.funnel[0].anon_id, DEV);
});

/* ── till orders (ads.js) ─────────────────────────────────────────────── */

test("ads.js Meta batch: the hashed phone is an external_id too, so store and web purchases stitch", () => {
  process.env.META_PIXEL_ID = "OFFLINE_TEST";
  const meta = A.PLATFORMS.find((p) => p.id === "meta");
  const ev = (over) => ({ eventId: "77", orderId: "77", eventName: "Purchase", eventTime: new Date("2026-10-09T18:00:00Z"),
    value: 60, currency: "SAR", actionSource: "physical_store", ...over });
  const built = meta.buildBatch([
    ev({ phoneDigits: DIGITS, externalId: "cust-9" }),
    ev({ eventId: "78", phoneDigits: DIGITS }),
    ev({ eventId: "79", externalId: "cust-9" }),
  ]);
  const data = (built.body || built).data;
  assert.deepEqual(data[0].user_data.external_id, [sha("cust-9"), sha(DIGITS)]);
  assert.deepEqual(data[1].user_data.external_id, [sha(DIGITS)]);
  assert.deepEqual(data[2].user_data.external_id, [sha("cust-9")]);
  assert.deepEqual(data[0].user_data.ph, [sha(DIGITS)]);
  assert.equal(data[0].action_source, "physical_store");
  assert.equal(data[0].event_id, "77");
  // the web side sends the very same phone hash
  assert.equal(F.externalIdsOf({ digits: DIGITS })[0], data[1].user_data.external_id[0]);
});
