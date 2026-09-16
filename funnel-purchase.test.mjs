/* Purchase دقيق من السيرفر — W0-02، 16 سبتمبر 2026.
   funnel_events كان فيه ٣٧ Purchase لأقل من ٥ طلبات حقيقية: ريفريش صفحة
   التتبع + إطلاق مزدوج من المتصفح + physical_store بيسبق الويب.
   مفيش شبكة ولا داتابيز هنا: pool وhttp مزيّفين، ومفيش أي نداء لمنصة إعلانات.
     node --test funnel-purchase.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import * as tsstore from "./tsstore.js";
import { register, purchaseContentsOf, serverPurchaseEvent, PURCHASE_DEDUP_HOURS } from "./funnel.js";
import { loadOrdersQuery, WEB_ORDER_HOLD_HOURS } from "./ads.js";

const M = tsstore.MULTIPLY;
const HOUR = 3600_000;

// إعدادات ميتا وهمية بس (مفيش HTTP حقيقي — http متحقن). تيك توك/سناب مقفولين.
for (const k of ["META_PIXEL_ID", "META_TEST_EVENT_CODE", "TIKTOK_WEB_PIXEL_ID", "TIKTOK_PIXEL_ID",
  "TIKTOK_ACCESS_TOKEN", "SNAP_WEB_PIXEL_ID", "SNAP_PIXEL_ID", "SNAP_ACCESS_TOKEN"]) delete process.env[k];
process.env.META_WEB_PIXEL_ID = "PIXEL_TEST";
process.env.META_CAPI_TOKEN = "fake-token-for-tests";

function normPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00966")) return d.slice(5);
  if (d.startsWith("966")) return d.slice(3);
  if (d.startsWith("0") && d.length === 10) return d.slice(1);
  return d;
}

/* داتابيز مزيّفة على قد الاستعلامات اللي funnel.js بيعملها. */
function fakeDb({ shopOrders = [] } = {}) {
  const db = { funnel: [], ads: new Map(), updates: [], shopOrders, now: () => Date.now() };
  db.pool = {
    async query(sql, params = []) {
      const s = String(sql);
      if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/.test(s) && !/INSERT/.test(s)) return { rows: [], rowCount: 0 };
      if (s.includes("to_jsonb(o) AS o FROM shop_orders")) {
        const o = db.shopOrders.find((x) => x.order_no === params[0]);
        return { rows: o ? [{ o }] : [], rowCount: o ? 1 : 0 };
      }
      if (s.includes("SELECT order_no, pos_order_id, total FROM shop_orders")) {
        const o = db.shopOrders.find((x) => x.pos_order_id === params[0] || x.order_no === params[0]);
        return { rows: o ? [{ order_no: o.order_no, pos_order_id: o.pos_order_id, total: o.total }] : [], rowCount: o ? 1 : 0 };
      }
      if (s.includes("FROM funnel_events") && s.includes("event_name = 'Purchase'")) {
        const ids = params[0], hours = Number(params[1]);
        const hit = db.funnel.find((r) => r.event_name === "Purchase" && ids.includes(r.order_id)
          && r.created_at > db.now() - hours * HOUR);
        return { rows: hit ? [{ "?column?": 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      if (s.includes("INSERT INTO funnel_events")) {
        db.funnel.push({ id: params[0], event_name: params[1], event_id: params[2], order_id: params[3],
          value: params[4], url: params[6], utm: params[8], click_ids: params[9], phone_norm: params[10],
          ip: params[11], ua: params[12], results: params[13], contents: params[14], created_at: db.now() });
        return { rows: [], rowCount: 1 };
      }
      if (s.includes("INSERT INTO ads_events")) {
        const key = `${params[1]}|${params[5]}|Purchase`;
        if (db.ads.has(key)) return { rows: [], rowCount: 0 };
        db.ads.set(key, { id: params[0], order_id: params[1], platform: params[5], request: JSON.parse(params[6]) });
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (s.includes("UPDATE ads_events")) { db.updates.push(params); return { rows: [], rowCount: 1 }; }
      throw new Error("unexpected SQL in test: " + s.slice(0, 80));
    },
  };
  return db;
}

function setup(opts = {}) {
  const db = fakeDb(opts);
  const calls = [];
  const http = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: { events_received: 1 } }; };
  const app = new Hono();
  const ctx = { pool: db.pool, requireAdmin: async () => null, jb: (v) => (v == null ? null : JSON.stringify(v)), normPhone };
  const api = register(app, ctx, { httpJson: http, ...(opts.deps || {}) });
  let ipN = 0;
  const post = async (body) => {
    const res = await app.request("/api/funnel/event", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": `10.9.${opts.ipBase ?? 0}.${++ipN}`, "user-agent": "UA-browser" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  return { db, calls, app, api, post };
}

const line = (productId, qty, net, extra = {}) => ({ product_id: productId, quantity: qty, unit_amount: Math.round(net * M), ...extra });

const paidOrder = (over = {}) => ({
  order_no: "W1789000000001",
  status: "pos_created",
  pos_order_id: "4017",
  total: 119,
  discount_percent: 0,
  phone_norm: "544775082",
  items: [line(12, 2, 40, { name: "مشكل مشاوي" }), line(33, 1, 23.47826087, { name: "رز" })],
  attribution: {
    fc_link: "96-m2-box",
    utm: { utm_source: "meta", utm_campaign: "M2" },
    click: { fbc: "fb.1.1726400000000.TEST123", fbp: "fb.1.1726400000000.999", ScCid: "snap-1" },
    ip: "5.6.7.8",
    ua: "UA-checkout",
    captured: "checkout",
  },
  ...over,
});

/* ── contents ─────────────────────────────────────────────────────────── */

test("contents: معرّفات الكتالوج من product_id، والسعر ريال شامل الضريبة", async () => {
  const c = await purchaseContentsOf([line(12, 2, 40), line(33, 1, 20)]);
  assert.deepEqual(c.map((i) => i.id), ["12", "33"]);
  assert.equal(c[0].quantity, 2);
  assert.equal(c[0].itemPrice, 46);          // 40 × 1.15
  assert.equal(c[1].itemPrice, 23);
});

test("contents: الخصم على الأصناف العادية بس، والسطور المكررة بتتجمع", async () => {
  const c = await purchaseContentsOf([
    line(12, 1, 40), line(12, 1, 40),
    line(48, 1, 30, { bundle: "national96-box" }),
  ], 50);
  assert.equal(c.length, 2);
  assert.equal(c[0].id, "12");
  assert.equal(c[0].quantity, 2);
  assert.equal(c[0].itemPrice, 23);          // 40 × 1.15 × 0.5
  assert.equal(c[1].itemPrice, 34.5);        // الباقة مابتتخصمش
});

test("contents: سطر من غير product_id بيتطابق بالاسم، والرسوم بتتشال", async () => {
  const match = async (name) => (name === "كفتة" ? "77" : name === "توصيل" ? "__fee__" : null);
  const c = await purchaseContentsOf([
    { name: "كفتة", quantity: 1, unit_amount: 10 * M },
    { name: "توصيل", quantity: 1, unit_amount: 5 * M },
    { name: "مجهول", quantity: 1, unit_amount: 5 * M },
  ], 0, match);
  assert.deepEqual(c.map((i) => i.id), ["77"]);
});

test("serverPurchaseEvent: event_id = pos_order_id، والكليك آي دي من attribution", () => {
  const e = serverPurchaseEvent(paidOrder(), { contents: [{ id: "12", quantity: 2, itemPrice: 46 }], digits: "966544775082", now: 1726400000000, baseUrl: "https://freshcuts.sa" });
  assert.equal(e.eventId, "4017");
  assert.equal(e.orderId, "4017");
  assert.equal(e.value, 119);
  assert.equal(e.click.fbc, "fb.1.1726400000000.TEST123");
  assert.equal(e.click.fbp, "fb.1.1726400000000.999");
  assert.equal(e.click.scid, "snap-1");
  assert.equal(e.ip, "5.6.7.8");
  assert.equal(e.ua, "UA-checkout");
  assert.equal(e.url, "https://freshcuts.sa/track/W1789000000001");
  assert.equal(e.numItems, 2);
  // من غير attribution (طلب قبل W0-03): مايقعش
  const bare = serverPurchaseEvent(paidOrder({ attribution: null }), {});
  assert.equal(bare.click.fbc, null);
  assert.equal(bare.ip, null);
});

/* ── serverPurchase ───────────────────────────────────────────────────── */

test("serverPurchase: payload ميتا website + event_id + fbc + content_ids، والحجز source=website", async () => {
  const { db, calls, api } = setup({ shopOrders: [paidOrder()], ipBase: 1 });
  const out = await api.serverPurchase({ orderNo: "W1789000000001" });
  assert.equal(out.ok, true);
  assert.equal(out.orderId, "4017");
  assert.deepEqual(out.results.meta, { sent: true });
  assert.deepEqual(out.results.tiktok, { skipped: "not configured" });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /graph\.facebook\.com\/v[\d.]+\/PIXEL_TEST\/events$/);
  const ev = calls[0].init.body.data[0];
  assert.equal(ev.event_name, "Purchase");
  assert.equal(ev.action_source, "website");
  assert.equal(ev.event_id, "4017");
  assert.equal(ev.user_data.fbc, "fb.1.1726400000000.TEST123");
  assert.equal(ev.user_data.fbp, "fb.1.1726400000000.999");
  assert.equal(ev.user_data.client_ip_address, "5.6.7.8");
  assert.equal(ev.user_data.client_user_agent, "UA-checkout");
  assert.equal(ev.user_data.ph.length, 1);
  assert.notEqual(ev.user_data.ph[0], "966544775082");          // متهيّش
  assert.deepEqual(ev.custom_data.content_ids, ["12", "33"]);
  assert.equal(ev.custom_data.value, 119);
  assert.equal(ev.custom_data.order_id, "4017");

  const claim = db.ads.get("4017|meta|Purchase");
  assert.equal(claim.request.source, "website");
  assert.equal(claim.request.eventId, "4017");
  assert.equal(db.funnel.length, 1);
  assert.equal(db.funnel[0].order_id, "4017");
  assert.ok(db.funnel[0].contents);
  assert.equal(JSON.parse(db.funnel[0].click_ids).fbc, "fb.1.1726400000000.TEST123");
});

test("serverPurchase: لو claimPurchase رجّع null (اتبعت قبل كده) → مفيش HTTP", async () => {
  const { db, calls, api } = setup({ shopOrders: [paidOrder()], ipBase: 2 });
  db.ads.set("4017|meta|Purchase", { id: "meta:Purchase:4017", request: { source: "pos" } });
  const out = await api.serverPurchase({ orderNo: "W1789000000001" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.meta, { skipped: "already reported for this order" });
  assert.equal(calls.length, 0);
});

test("serverPurchase: مرتين لنفس الطلب → التاني duplicate ومفيش HTTP ولا صف تاني", async () => {
  const { db, calls, api } = setup({ shopOrders: [paidOrder()], ipBase: 3 });
  await api.serverPurchase({ orderNo: "W1789000000001" });
  const again = await api.serverPurchase({ orderNo: "W1789000000001" });
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(db.funnel.length, 1);
});

test("serverPurchase: طلبات مش مؤهلة بتتخطّى من غير أي نداء", async () => {
  const { db, calls, api } = setup({
    ipBase: 4,
    shopOrders: [
      paidOrder({ order_no: "WTEST", is_test: true }),
      paidOrder({ order_no: "WNOPOS", pos_order_id: null }),
      paidOrder({ order_no: "WREF", status: "rejected_refunded" }),
      paidOrder({ order_no: "WPEND", status: "pending_payment" }),
      paidOrder({ order_no: "WZERO", total: 0 }),
    ],
  });
  assert.equal((await api.serverPurchase({ orderNo: "WTEST" })).skipped, "test_order");
  assert.equal((await api.serverPurchase({ orderNo: "WNOPOS" })).skipped, "no_pos_order");
  assert.equal((await api.serverPurchase({ orderNo: "WREF" })).skipped, "status:rejected_refunded");
  assert.equal((await api.serverPurchase({ orderNo: "WPEND" })).skipped, "status:pending_payment");
  assert.equal((await api.serverPurchase({ orderNo: "WZERO" })).skipped, "zero_total");
  assert.equal((await api.serverPurchase({ orderNo: "NOPE" })).skipped, "not_found");
  assert.equal((await api.serverPurchase({})).skipped, "no_order_no");
  assert.equal(calls.length, 0);
  assert.equal(db.funnel.length, 0);
});

/* ── POST /api/funnel/event dedup ─────────────────────────────────────── */

test("route: Purchase بنفس orderId مرتين خلال ٢٤ ساعة → التاني duplicate وصف واحد بس", async () => {
  const { db, calls, post } = setup({ ipBase: 5 });
  const body = { eventName: "Purchase", orderId: "9001", eventId: "9001", value: 80 };
  const first = await post(body);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, undefined);
  const second = await post(body);
  assert.deepEqual(second, { ok: true, duplicate: true });
  const purchases = db.funnel.filter((r) => r.event_name === "Purchase");
  assert.equal(purchases.length, 1);
  assert.equal(calls.length, 1);
  // طلب مش من المتجر: الحجز بيفضل source=funnel زي الأول
  assert.equal(db.ads.get("9001|meta|Purchase").request.source, "funnel");
});

test("route: بعد ٢٤ ساعة نفس الـorderId مابيتعتبرش تكرار في funnel_events", async () => {
  const { db, post } = setup({ ipBase: 6 });
  await post({ eventName: "Purchase", orderId: "9002", value: 50 });
  db.funnel[0].created_at -= (PURCHASE_DEDUP_HOURS + 1) * HOUR;
  const again = await post({ eventName: "Purchase", orderId: "9002", value: 50 });
  assert.equal(again.duplicate, undefined);
  assert.equal(db.funnel.length, 2);
});

test("route: السيرفر سبق المتصفح → Purchase المتصفح (ولو بـW…) duplicate", async () => {
  const { db, calls, api, post } = setup({ shopOrders: [paidOrder()], ipBase: 7 });
  await api.serverPurchase({ orderNo: "W1789000000001" });
  assert.deepEqual(await post({ eventName: "Purchase", orderId: "4017", value: 0 }), { ok: true, duplicate: true });
  assert.deepEqual(await post({ eventName: "Purchase", orderId: "W1789000000001", value: 119 }), { ok: true, duplicate: true });
  assert.equal(db.funnel.length, 1);
  assert.equal(calls.length, 1);
});

test("route: المتصفح سبق → الحجز website بالـid الرسمي، وserverPurchase بعده duplicate", async () => {
  const { db, calls, api, post } = setup({ shopOrders: [paidOrder()], ipBase: 8 });
  const r = await post({ eventName: "Purchase", orderId: "W1789000000001", eventId: "4017", value: 7 });
  assert.equal(r.ok, true);
  assert.equal(db.funnel[0].order_id, "4017");
  // القيمة من shop_orders.total مش من جسم الطلب العام
  assert.equal(db.funnel[0].value, 119);
  assert.equal(calls[0].init.body.data[0].custom_data.value, 119);
  assert.equal(db.ads.get("4017|meta|Purchase").request.source, "website");
  const s = await api.serverPurchase({ orderNo: "W1789000000001" });
  assert.equal(s.duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(db.funnel.length, 1);
});

test("route: طلب متجر لسه مانزلش نقطة البيع → deferred من غير إدراج ولا إرسال", async () => {
  const { db, calls, post } = setup({ shopOrders: [paidOrder({ pos_order_id: null })], ipBase: 9 });
  const r = await post({ eventName: "Purchase", orderId: "W1789000000001", value: 119 });
  assert.deepEqual(r, { ok: true, deferred: true });
  assert.equal(db.funnel.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(db.ads.size, 0);
});

test("route: الأحداث التانية (AddToCart) مابيتطبقش عليها dedup", async () => {
  const { db, post } = setup({ ipBase: 10 });
  await post({ eventName: "AddToCart", orderId: null, value: 10 });
  await post({ eventName: "AddToCart", orderId: null, value: 10 });
  assert.equal(db.funnel.length, 2);
});

/* ── ads.loadOrders: طلبات الموقع بتستنى ٦ ساعات ───────────────────────── */

test("loadOrdersQuery: شرط الاستبعاد موجود والمعاملات مرقّمة", () => {
  const q = loadOrdersQuery("2026-09-01", "2026-09-16", 500);
  assert.equal(WEB_ORDER_HOLD_HOURS, 6);
  assert.match(q.text, /NOT EXISTS\s*\(\s*SELECT 1 FROM shop_orders so\s+WHERE so\.pos_order_id = o\.order_id\s+AND so\.created_at > NOW\(\) - \(\$4 \|\| ' hours'\)::interval\)/);
  assert.deepEqual(q.values, ["2026-09-01", "2026-09-16", 500, "6"]);
  assert.match(q.text, /LIMIT \$3/);
});

test("loadOrdersQuery: طلب موقع عمره ساعة مستبعد، عمره ٧ ساعات راجع، وطلب كاشير راجع", () => {
  const q = loadOrdersQuery("2026-09-01", "2026-09-16", 500);
  const now = Date.now();
  // مقيّم صغير للشرط اللي اتولّد: بياخد عدد الساعات من values زي Postgres بالظبط
  const holdMs = Number(q.values[3]) * HOUR;
  const shop = [
    { pos_order_id: "A1", created_at: now - 1 * HOUR },
    { pos_order_id: "A7", created_at: now - 7 * HOUR },
  ];
  const ts = [{ order_id: "A1" }, { order_id: "A7" }, { order_id: "CASHIER" }];
  assert.ok(q.text.includes("so.pos_order_id = o.order_id"));
  const kept = ts.filter((o) => !shop.some((so) => so.pos_order_id === o.order_id && so.created_at > now - holdMs));
  assert.deepEqual(kept.map((o) => o.order_id), ["A7", "CASHIER"]);
});
