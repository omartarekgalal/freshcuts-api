/* بوابة المطعم — المسارات (node --test portal-api.test.mjs)
   Hono حقيقي + قاعدة وهمية بحالة + shop/delivery وهميين. مفيش شبكة ولا
   شركة توصيل ولا SMS ولا Push حقيقي. */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { register } from "./portal.js";
import { hashPin } from "./portal-core.js";
import { register as registerShop } from "./shop.js";

const ADMIN = "admin-token-xyz-123";
const NOW = Date.now();
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function orderRow(no, extra = {}) {
  return {
    order_no: no, status: "accepted", option: "delivery", customer: { name: "عميل" }, phone_norm: "512345678",
    address: { area: "السلامة", latitude: 21.5, longitude: 39.1 }, items: [{ name: "برجر", quantity: 1 }],
    subtotal: 80, delivery_fee: 15, tip: 0, total: 95, notes: "", pos_order_id: "P1",
    created_at: new Date(NOW - 10 * 60_000).toISOString(), updated_at: new Date(NOW - 60_000).toISOString(),
    history: [{ at: new Date(NOW - 9 * 60_000).toISOString(), status: "paid" }, { at: new Date(NOW - 5 * 60_000).toISOString(), status: "accepted" }],
    alerts: {}, pos_ready_at: null, accepted_at: null, portal_ack_at: null, portal_ack_by: null, pay_gateway: "mada",
    is_test: false, dispatch_claimed_at: null, ...extra,
  };
}

function build({ settings = {}, orders = [], shipments = [], gate = "auto", dispatchImpl, cancelImpl, failSql = null } = {}) {
  const db = {
    orders: new Map(orders.map((o) => [o.order_no, { ...o }])),
    shipments: shipments.map((s) => ({ ...s })),
    audit: [], subs: [], pushLog: new Set(), settings: { ...settings }, queries: [],
  };
  const withShip = (o) => {
    const s = db.shipments.filter((x) => x.shop_order_no === o.order_no).at(-1);
    return { ...o, ship_status: s?.status ?? null, ship_driver: s?.driver ?? null, ship_provider: s?.provider ?? null,
      ship_ref: s?.provider_ref ?? null, ship_updated_at: s?.updated_at ?? null, ship_dispatch: s?.dispatch ?? null };
  };
  const pool = {
    query: async (sql, vals = []) => {
      sql = String(sql);
      db.queries.push({ sql, vals });
      if (failSql && failSql.test(sql)) throw new Error("relation does not exist");
      if (/^\s*CREATE (TABLE|INDEX)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/make_interval\(hours/.test(sql)) {
        const rows = [...db.orders.values()].filter((o) => !["pending_payment", "expired"].includes(o.status)).map(withShip);
        return { rows, rowCount: rows.length };
      }
      if (/order_no = ANY\(\$1::text\[\]\)/.test(sql)) {
        const rows = vals[0].map((n) => db.orders.get(n)).filter(Boolean).map(withShip);
        return { rows, rowCount: rows.length };
      }
      if (/SET dispatch_claimed_at=NOW\(\)\s+WHERE order_no=\$1 AND dispatch_claimed_at IS NULL/.test(sql)) {
        const o = db.orders.get(vals[0]);
        if (!o || o.dispatch_claimed_at) return { rows: [], rowCount: 0 };
        o.dispatch_claimed_at = new Date().toISOString();
        return { rows: [{ claimed: o.dispatch_claimed_at }], rowCount: 1 };
      }
      if (/dispatch_claimed_at < NOW\(\) - INTERVAL '90 seconds'/.test(sql)) {
        const o = db.orders.get(vals[0]);
        if (!o || !o.dispatch_claimed_at || Date.parse(o.dispatch_claimed_at) > Date.now() - 90_000) return { rows: [], rowCount: 0 };
        o.dispatch_claimed_at = new Date().toISOString();
        return { rows: [{ claimed: o.dispatch_claimed_at }], rowCount: 1 };
      }
      if (/SET dispatch_claimed_at = NOW\(\) - INTERVAL '5 minutes'/.test(sql)) {
        const o = db.orders.get(vals[0]);
        if (o && o.dispatch_claimed_at === vals[1]) o.dispatch_claimed_at = new Date(Date.now() - 300_000).toISOString();
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE shop_orders SET status='accepted'/.test(sql)) {
        const o = db.orders.get(vals[0]);
        if (!o || !["courier_requested", "courier_assigned"].includes(o.status)) return { rows: [], rowCount: 0 };
        o.status = "accepted"; o.history = [...o.history, ...JSON.parse(vals[1])];
        return { rows: [{ order_no: o.order_no }], rowCount: 1 };
      }
      if (/SET portal_ack_at = COALESCE/.test(sql)) {
        const o = db.orders.get(vals[0]);
        if (!o) return { rows: [], rowCount: 0 };
        o.portal_ack_at = o.portal_ack_at || new Date().toISOString(); o.portal_ack_by = o.portal_ack_by || vals[1];
        return { rows: [{ portal_ack_at: o.portal_ack_at, portal_ack_by: o.portal_ack_by }], rowCount: 1 };
      }
      if (/INSERT INTO portal_audit/.test(sql)) { db.audit.push({ staff_id: vals[0], staff_name: vals[1], role: vals[2], action: vals[3], order_no: vals[4], ok: vals[5], detail: JSON.parse(vals[6]), at: new Date().toISOString() }); return { rowCount: 1, rows: [] }; }
      if (/FROM portal_audit WHERE order_no/.test(sql)) return { rows: db.audit.filter((a) => a.order_no === vals[0]) };
      if (/FROM shop_order_events/.test(sql)) return { rows: [{ at: new Date(NOW - 8 * 60_000).toISOString(), name: "pos_push", source: "shop", ok: true, data: {} }] };
      if (/FROM dl_shipments WHERE shop_order_no=\$1 ORDER BY id LIMIT/.test(sql)) return { rows: db.shipments.filter((s) => s.shop_order_no === vals[0]) };
      if (/FROM tsp_webhooks/.test(sql)) return { rows: [{ received_at: new Date(NOW - 5 * 60_000).toISOString(), event: "order-updated", approval: "accepted" }] };
      if (/INSERT INTO portal_push_subs/.test(sql)) { db.subs = db.subs.filter((s) => s.endpoint !== vals[0]); db.subs.push({ id: db.subs.length + 1, endpoint: vals[0], sub: JSON.parse(vals[1]), staff_id: vals[2], role: vals[4], device_name: vals[5] }); return { rowCount: 1, rows: [] }; }
      if (/DELETE FROM portal_push_subs WHERE endpoint/.test(sql)) { const n = db.subs.length; db.subs = db.subs.filter((s) => !(s.endpoint === vals[0] && (vals[1] == null || s.staff_id === vals[1]))); return { rowCount: n - db.subs.length, rows: [] }; }
      if (/SELECT id, sub(, staff_id)? FROM portal_push_subs/.test(sql)) {
        let rows = db.subs; if (/staff_id=\$1/.test(sql)) rows = rows.filter((s) => s.staff_id === vals[0]);
        return { rows, rowCount: rows.length };
      }
      if (/INSERT INTO portal_push_log/.test(sql)) { const k = vals.join("|"); if (db.pushLog.has(k)) return { rows: [], rowCount: 0 }; db.pushLog.add(k); return { rows: [{}], rowCount: 1 }; }
      if (/FROM portal_push_log WHERE order_no/.test(sql)) return { rows: [] };
      if (/UPDATE settings SET data = jsonb_set/.test(sql)) { db.settings.portal = { ...(db.settings.portal || {}), ...JSON.parse(vals[0]) }; return { rowCount: 1, rows: [] }; }
      if (/SELECT o.order_no FROM shop_orders o\s+WHERE o.status IN \('paid','pos_created','paid_pos_failed'\)/.test(sql)) {
        const rows = [...db.orders.values()].filter((o) => ["paid", "pos_created", "paid_pos_failed"].includes(o.status) && !o.is_test && !db.pushLog.has(`${o.order_no}|new`)).map((o) => ({ order_no: o.order_no }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const calls = { dispatch: 0, setStatus: [], cancel: 0, manual: [] };
  const shop = {
    getOrderRow: async (no) => (db.orders.get(no) ? { ...db.orders.get(no) } : null),
    setStatus: async (no, status, extra) => { calls.setStatus.push({ no, status, extra }); const o = db.orders.get(no); if (o) o.status = status; },
  };
  const delivery = {
    dispatchGate: async () => ({ mode: gate }),
    shipmentOf: async (no) => db.shipments.filter((s) => s.shop_order_no === no).at(-1) || null,
    dispatch: async (row) => {
      calls.dispatch++;
      await wait(15);
      if (dispatchImpl) return dispatchImpl(row);
      db.shipments.push({ shop_order_no: row.order_no, status: "pending", provider: "leajlak", provider_ref: row.order_no });
      return { provider: "leajlak", faOrderId: row.order_no, assigned: false, dispatch: { message: null } };
    },
    cancelShipment: async (no) => {
      calls.cancel++;
      if (cancelImpl) return cancelImpl(no);
      const s = db.shipments.filter((x) => x.shop_order_no === no).at(-1); if (s) s.status = "cancelled";
      return { fee: 0 };
    },
    manualEvent: async (no, stage, data) => { calls.manual.push({ no, stage, data }); return {}; },
  };
  let listener = null;
  const events = [];
  const pushSent = [];
  const app = new Hono();
  const requireAdmin = async (c) => (c.req.header("Authorization") === `Bearer ${ADMIN}` ? null : c.json({ error: "Unauthorized" }, 401));
  const api = register(app, { pool, getSettingsData: async () => ({ webPushKeys: { publicKey: "PUB", privateKey: "PRIV" }, ...db.settings }), requireAdmin, log: { error() {} } }, {
    shop: () => shop, delivery: () => delivery, timers: false, eventStore: false, debounceMs: 5, heartbeatMs: 40,
    env: { ADMIN_TOKEN: ADMIN },
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    emitOrder: (name, opts) => { events.push({ name, ...opts }); },
    webpush: { sendNotification: async (sub, body, opts) => { pushSent.push({ sub, body: JSON.parse(body), opts }); } },
  });
  const req = (method, path, { token, body, headers = {} } = {}) => app.request(path, {
    method, headers: { "Content-Type": "application/json", "cf-connecting-ip": headers.ip || "10.0.0.1",
      ...(token ? { Authorization: token.startsWith("Bearer") ? token : `Bearer portal:${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (...a) => { const r = await req(...a); return { status: r.status, body: await r.json() }; };
  const emit = (evt) => listener?.(evt);
  return { app, api, db, calls, events, pushSent, req, json, emit };
}

const STAFF = () => [
  { id: "st_m", name: "سارة", role: "manager", pinHash: hashPin("7777") },
  { id: "st_c", name: "علي", role: "cashier", pinHash: hashPin("2468") },
];
async function login(s, pin, ip = "10.0.0.1") {
  const r = await s.json("POST", "/api/portal/login", { body: { pin }, headers: { ip } });
  return r;
}

/* ═══ الدخول والأدوار ═════════════════════════════════════════════════════ */

test("login: PIN صح ← توكن + دور + اسم، و/me بيرجّعهم", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  const r = await login(s, "7777");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.role, "manager");
  assert.equal(r.body.name, "سارة");
  assert.ok(r.body.token);
  const me = await s.json("GET", "/api/portal/me", { token: r.body.token });
  assert.deepEqual({ role: me.body.role, name: me.body.name, id: me.body.staffId }, { role: "manager", name: "سارة", id: "st_m" });
  const c = await login(s, "2468");
  assert.equal(c.body.role, "cashier");
  assert.equal((await s.json("GET", "/api/portal/me")).status, 401);
  assert.equal((await s.json("GET", "/api/portal/me", { token: "bad.token" })).status, 401);
});

test("login: الرقم المشترك كاشير لو مفيش موظفين، ومفتاح الأدمن مدير", async () => {
  const s = build({ settings: { shop: { cashierPin: "5151" } } });
  assert.equal((await login(s, "5151")).body.role, "cashier");
  assert.equal((await login(s, ADMIN)).body.role, "manager");
  // Bearer <ADMIN> مباشرة = مدير
  const rep = await s.json("GET", "/api/portal/orders", { token: `Bearer ${ADMIN}` });
  assert.equal(rep.status, 200);
});

test("login: ٥ غلطات من نفس الـIP ← 429 مقفول حتى بالرقم الصح، وIP تاني شغّال", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  for (let i = 0; i < 4; i++) assert.equal((await login(s, "0000", "1.1.1.1")).status, 401);
  const fifth = await login(s, "0000", "1.1.1.1");
  assert.equal(fifth.status, 429);
  const locked = await login(s, "7777", "1.1.1.1");
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, "locked");
  assert.ok(locked.body.retryAfterSec > 0);
  assert.equal((await login(s, "7777", "2.2.2.2")).status, 200);
});

test("الجلسة بتتلغي لو الـPIN اتغيّر", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  const { body } = await login(s, "2468");
  assert.equal((await s.json("GET", "/api/portal/me", { token: body.token })).status, 200);
  s.db.settings.portal = { staff: [STAFF()[0], { id: "st_c", name: "علي", role: "cashier", pinHash: hashPin("1212") }] };
  await s.api.limiter; // noop
  // كاش الهويات ١٠ ث — الدخول بيجبره يتجدد
  await login(s, "1212");
  const r = await s.json("GET", "/api/portal/me", { token: body.token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "session_revoked");
});

test("الكاشير: 403 على مسارات المدير (مندوب/إلغاء/تقارير/تجربة إشعار)", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")] });
  const { body } = await login(s, "2468");
  for (const [m, p] of [["POST", "/api/portal/orders/W1/courier"], ["POST", "/api/portal/orders/W1/courier/cancel"],
    ["GET", "/api/portal/reports"], ["POST", "/api/portal/push/test"], ["GET", "/api/portal/health"]]) {
    const r = await s.json(m, p, { token: body.token, body: m === "GET" ? undefined : {} });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal(s.calls.dispatch, 0);
  assert.equal((await s.json("GET", "/api/portal/orders", { token: body.token })).status, 200, "القراية مسموحة");
});

/* ═══ الطلبات والتفاصيل ═══════════════════════════════════════════════════ */

test("GET /orders: شكل العقد + now، ومن غير pending_payment", async () => {
  const s = build({
    settings: { portal: { staff: STAFF() } },
    orders: [orderRow("W1"), orderRow("W2", { status: "pending_payment" })],
    shipments: [{ shop_order_no: "W1", status: "assigned", provider: "leajlak", driver: { name: "كابتن", phone: "555000111", location: { lat: 21.6, lng: 39.2 } } }],
  });
  const { body } = await login(s, "2468");
  const r = await s.json("GET", "/api/portal/orders?hours=24", { token: body.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.now);
  assert.deepEqual(r.body.orders.map((o) => o.orderNo), ["W1"]);
  const o = r.body.orders[0];
  assert.equal(o.courier.name, "كابتن");
  assert.equal(o.courier.lat, 21.6);
  assert.equal(o.customer.phone, "0512345678");
  assert.ok(o.sla && "level" in o.sla);
  assert.equal(s.db.queries.find((q) => /make_interval/.test(q.sql)).vals[0], 24);
});

test("GET /orders/:no: الطلب + خط زمني مدموج، وجدول أحداث ناقص مايوقّعش", async () => {
  const s = build({
    settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")],
    shipments: [{ shop_order_no: "W1", status: "pending", provider: "leajlak", events: [{ at: new Date(NOW - 2 * 60_000).toISOString(), event: "created", resp: { x: 1 } }] }],
  });
  const { body } = await login(s, "2468");
  const r = await s.json("GET", "/api/portal/orders/W1", { token: body.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.order.orderNo, "W1");
  const types = r.body.timeline.map((x) => x.type);
  assert.ok(types.includes("pos_push") && types.includes("pos_webhook") && types.includes("courier_created") && types.includes("status"));
  assert.deepEqual(r.body.timeline.map((x) => x.at), [...r.body.timeline.map((x) => x.at)].sort());
  assert.equal((await s.json("GET", "/api/portal/orders/NOPE", { token: body.token })).status, 404);

  const s2 = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")], failSql: /shop_order_events|tsp_webhooks/ });
  const t2 = (await login(s2, "2468")).body.token;
  const r2 = await s2.json("GET", "/api/portal/orders/W1", { token: t2 });
  assert.equal(r2.status, 200);
  assert.ok(r2.body.timeline.length >= 2);
});

/* ═══ طلب/إلغاء المندوب ═══════════════════════════════════════════════════ */

test("courier: المدير يطلب ← dispatch مرة + حجز + courier_requested + سجل وحدث", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")] });
  const { body } = await login(s, "7777");
  const r = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(s.calls.dispatch, 1);
  assert.ok(s.db.orders.get("W1").dispatch_claimed_at, "اتحجز");
  assert.equal(s.calls.setStatus[0].status, "courier_requested");
  assert.equal(s.calls.setStatus[0].extra.source, "portal");
  await wait(5);
  assert.ok(s.db.audit.some((a) => a.action === "courier_request" && a.staff_name === "سارة" && a.ok === true));
  assert.ok(s.events.some((e) => e.name === "staff_action" && e.data.action === "courier_request" && e.actor.name === "سارة"));
  // تاني = already_requested
  const again = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(again.status, 409);
  assert.equal(s.calls.dispatch, 1);
});

test("courier: ضغطتين في نفس اللحظة = شحنة واحدة", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")] });
  const { body } = await login(s, "7777");
  const [a, b] = await Promise.all([
    s.json("POST", "/api/portal/orders/W1/courier", { token: body.token }),
    s.json("POST", "/api/portal/orders/W1/courier", { token: body.token }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(s.calls.dispatch, 1);
});

test("courier: الكنس حاجز لسه (بيبعت دلوقتي) ← 409 in_progress من غير dispatch", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1", { dispatch_claimed_at: new Date().toISOString() })] });
  const { body } = await login(s, "7777");
  const r = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "in_progress");
  assert.equal(s.calls.dispatch, 0);
});

test("courier: شحنة قديمة ملغية + حجز قديم ← إعادة الطلب مسموحة", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } },
    orders: [orderRow("W1", { status: "accepted", dispatch_claimed_at: new Date(Date.now() - 600_000).toISOString() })],
    shipments: [{ shop_order_no: "W1", status: "cancelled", provider: "leajlak" }] });
  const { body } = await login(s, "7777");
  const r = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(r.status, 200);
  assert.equal(s.calls.dispatch, 1);
});

test("courier: الوضع اليدوي / pos_created / استلام / فيه كابتن ← رفض واضح من غير dispatch", async () => {
  const cases = [
    [{ gate: "manual", orders: [orderRow("W1")] }, "manual_mode"],
    [{ orders: [orderRow("W1", { status: "pos_created" })] }, "not_accepted"],
    [{ orders: [orderRow("W1", { option: "pickup" })] }, "not_delivery"],
    [{ orders: [orderRow("W1", { status: "courier_assigned" })] }, "already_requested"],
    [{ orders: [orderRow("W1", { status: "courier_requested" })], shipments: [{ shop_order_no: "W1", status: "pending" }] }, "already_requested"],
  ];
  for (const [opts, err] of cases) {
    const s = build({ settings: { portal: { staff: STAFF() } }, ...opts });
    const { body } = await login(s, "7777");
    const r = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
    assert.equal(r.body.error, err);
    assert.equal(s.calls.dispatch, 0, err);
  }
});

test("courier: فشل الإرسال ← 502 + الحجز يتفك للمدير بس (مش NULL للكنس) + سجل فشل", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")],
    dispatchImpl: () => { throw Object.assign(new Error("no drivers"), { code: "COURIER_UNCONFIGURED" }); } });
  const { body } = await login(s, "7777");
  const r = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "COURIER_UNCONFIGURED");
  await wait(5);
  const claimed = s.db.orders.get("W1").dispatch_claimed_at;
  assert.ok(claimed && Date.parse(claimed) < Date.now() - 200_000, "الحجز باقي بس قديم");
  assert.equal(s.calls.setStatus.length, 0);
  assert.ok(s.db.audit.some((a) => a.action === "courier_request" && a.ok === false));
  const retry = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(retry.status, 502, "إعادة فورية مسموحة");
  assert.equal(s.calls.dispatch, 2);
});

test("courier/cancel: إلغاء الشحنة + الطلب يرجع accepted من غير notify + سجل", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1", { status: "courier_assigned" })],
    shipments: [{ shop_order_no: "W1", status: "assigned", provider: "leajlak" }] });
  const { body } = await login(s, "7777");
  const r = await s.json("POST", "/api/portal/orders/W1/courier/cancel", { token: body.token, body: { reason: "العميل طلب" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(s.calls.cancel, 1);
  assert.equal(s.db.orders.get("W1").status, "accepted");
  assert.equal(s.calls.setStatus.length, 0, "مفيش setStatus (مفيش رسالة للعميل)");
  assert.ok(s.events.some((e) => e.name === "order_status" && e.data.to === "accepted" && e.source === "portal"));
  await wait(5);
  assert.ok(s.db.audit.some((a) => a.action === "courier_cancel" && a.ok === true));
  assert.equal((await s.json("POST", "/api/portal/orders/W1/courier/cancel", { token: body.token })).body.error, "no_active_courier");
});

test("courier/cancel: الكابتن استلم ← 409، وفشل الشركة ← 502", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1", { status: "on_the_way" })],
    shipments: [{ shop_order_no: "W1", status: "picked", provider: "leajlak" }] });
  const t = (await login(s, "7777")).body.token;
  assert.equal((await s.json("POST", "/api/portal/orders/W1/courier/cancel", { token: t })).body.error, "already_picked");
  assert.equal(s.calls.cancel, 0);
  const s2 = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1", { status: "courier_requested" })],
    shipments: [{ shop_order_no: "W1", status: "pending", provider: "leajlak" }], cancelImpl: () => null });
  const t2 = (await login(s2, "7777")).body.token;
  const r = await s2.json("POST", "/api/portal/orders/W1/courier/cancel", { token: t2 });
  assert.equal(r.status, 502);
  assert.equal(s2.db.orders.get("W1").status, "courier_requested", "الحالة ماتغيّرتش");
});

test("ack: «شفته» بيختم portal_ack_at مرة ويطلق portal_ack", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1", { status: "pos_created" })] });
  const t = (await login(s, "2468")).body.token;
  const r = await s.json("POST", "/api/portal/orders/W1/ack", { token: t });
  assert.equal(r.status, 200);
  assert.equal(r.body.ackBy, "علي");
  assert.ok(s.events.some((e) => e.name === "portal_ack"));
  assert.equal((await s.json("POST", "/api/portal/orders/W1/handed", { token: t })).status, 200);
});

/* ═══ SSE ═════════════════════════════════════════════════════════════════ */

async function readUntil(reader, pred, ms = 1500) {
  const dec = new TextDecoder();
  let buf = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await Promise.race([reader.read(), wait(ms).then(() => ({ timeout: true }))]);
    if (r.timeout || r.done) break;
    buf += dec.decode(r.value, { stream: true });
    if (pred(buf)) return buf;
  }
  return buf;
}

test("stream: هيدرز SSE + hello + order عند تغيير + ping + تنظيف عند قطع الاتصال", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")] });
  const t = (await login(s, "2468")).body.token;
  const res = await s.req("GET", `/api/portal/stream?token=${encodeURIComponent(t)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const reader = res.body.getReader();
  let buf = await readUntil(reader, (b) => b.includes("event: hello"));
  assert.match(buf, /retry: 3000/);
  assert.match(buf, /event: hello/);
  assert.equal(s.api.hub.clients.size, 1);
  await wait(30); // scan الأولي يخلص
  s.db.orders.get("W1").status = "courier_requested";
  s.emit({ orderNo: "W1", name: "order_status", data: { to: "courier_requested" } });
  buf = await readUntil(reader, (b) => /event: order\ndata: .*"courier_requested"/.test(b));
  assert.match(buf, /event: order\ndata: .*"orderNo":"W1".*"courier_requested"/);
  // نفس الحالة تاني = مفيش بث مكرر
  s.emit({ orderNo: "W1", name: "notify_sent", data: {} });
  buf = await readUntil(reader, (b) => b.includes("event: ping"));
  assert.match(buf, /event: ping/);
  assert.doesNotMatch(buf, /event: order/);
  await reader.cancel();
  await wait(10);
  assert.equal(s.api.hub.clients.size, 0, "اتشال بعد القطع");
});

test("stream: توكن غلط 401، وحد أقصى للاتصالات لكل موظف", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  assert.equal((await s.req("GET", "/api/portal/stream?token=nope")).status, 401);
  assert.equal((await s.req("GET", "/api/portal/stream")).status, 401);
  const t = (await login(s, "2468")).body.token;
  const readers = [];
  for (let i = 0; i < 6; i++) {
    const r = await s.req("GET", `/api/portal/stream?token=${t}`);
    assert.equal(r.status, 200);
    readers.push(r.body.getReader());
  }
  const over = await s.req("GET", `/api/portal/stream?token=${t}`);
  assert.equal(over.status, 429);
  assert.equal((await over.json()).fallback, "poll");
  for (const r of readers) await r.cancel();
  await wait(10);
  assert.equal(s.api.hub.clients.size, 0);
  s.api.stop();
});

/* ═══ Push ════════════════════════════════════════════════════════════════ */

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };

test("push: key عام، subscribe بيربط الموظف والدور، test لجهازه بس، delete بيشيل", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  const key = await s.json("GET", "/api/portal/push/key");
  assert.deepEqual(key.body, { ok: true, publicKey: "PUB" });
  const tm = (await login(s, "7777")).body.token;
  const tc = (await login(s, "2468")).body.token;
  assert.equal((await s.json("POST", "/api/portal/push/subscribe", { token: tm, body: { subscription: { endpoint: "x" } } })).status, 400);
  assert.equal((await s.json("POST", "/api/portal/push/subscribe", { token: tm, body: { subscription: SUB, deviceName: "آيفون سارة" } })).status, 200);
  assert.equal((await s.json("POST", "/api/portal/push/subscribe", { token: tc, body: { subscription: { ...SUB, endpoint: SUB.endpoint + "c" }, deviceName: "تابلت" } })).status, 200);
  assert.deepEqual(s.db.subs.map((x) => [x.staff_id, x.role, x.device_name]), [["st_m", "manager", "آيفون سارة"], ["st_c", "cashier", "تابلت"]]);
  const t = await s.json("POST", "/api/portal/push/test", { token: tm, body: {} });
  assert.equal(t.body.sent, 1);
  assert.deepEqual(s.pushSent.map((p) => p.sub.endpoint), [SUB.endpoint]);
  assert.equal(s.pushSent[0].opts.urgency, "high");
  const d = await s.json("DELETE", "/api/portal/push/subscribe", { token: tm, body: { endpoint: SUB.endpoint } });
  assert.equal(d.body.removed, 1);
});

test("push triggers: order_paid من الناقل ← «طلب جديد» مرة، والاستطلاع الاحتياطي مايكررش", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W7", { status: "paid", total: 120, option: "pickup" }), orderRow("W8", { status: "pos_created" }), orderRow("WT", { status: "pos_created", is_test: true })] });
  s.db.subs.push({ id: 1, endpoint: "https://a.b/c", sub: { endpoint: "https://a.b/c" }, staff_id: "st_c" });
  s.emit({ orderNo: "W7", name: "order_paid", data: { total: 120 } });
  await wait(30);
  assert.equal(s.pushSent.length, 1);
  assert.equal(s.pushSent[0].body.title, "طلب جديد W7");
  assert.match(s.pushSent[0].body.body, /120/);
  const n = await s.api.pollNewOrders();
  assert.equal(n, 1, "W8 بس (W7 اتبعت، WT اختبار)");
  assert.deepEqual(s.pushSent.map((p) => p.body.orderNo), ["W7", "W8"]);
  s.emit({ orderNo: "W7", name: "order_paid", data: {} });
  await wait(30);
  assert.equal(s.pushSent.length, 2, "مفيش تكرار");
});

test("tabsenseDown: إشعار مرة في الساعة", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  s.db.subs.push({ id: 1, endpoint: "https://a.b/c", sub: { endpoint: "https://a.b/c" }, staff_id: "st_c" });
  await s.api.tabsenseDown("not connected");
  await s.api.tabsenseDown("not connected");
  assert.equal(s.pushSent.length, 1);
  assert.match(s.pushSent[0].body.title, /تاب سينس/);
});

/* ═══ التقارير + الموظفين ═════════════════════════════════════════════════ */

test("reports: مدير بس، والتواريخ بتتحقق، والشكل كامل", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  const t = (await login(s, "7777")).body.token;
  assert.equal((await s.json("GET", "/api/portal/reports?from=2026-09-10&to=2026-09-01", { token: t })).status, 400);
  assert.equal((await s.json("GET", "/api/portal/reports?from=2026-01-01&to=2026-09-01", { token: t })).body.error, "range_too_long");
  const r = await s.json("GET", "/api/portal/reports?from=2026-09-10&to=2026-09-16", { token: t });
  assert.equal(r.status, 200);
  assert.equal(r.body.series.daily.length, 7);
  assert.equal(r.body.series.hourly.length, 24);
  for (const k of ["kpis", "fulfilment", "delivery", "discounts", "losses", "sla", "times", "topItems", "customers", "attribution", "payments"]) assert.ok(k in r.body, k);
  const q = s.db.queries.filter((x) => /Asia\/Riyadh/.test(x.sql));
  assert.ok(q.length >= 10);
  assert.ok(q.every((x) => x.vals[0] === "2026-09-10" && x.vals[1] === "2026-09-16"));
  assert.ok(q.every((x) => /NOT COALESCE\(o\.is_test, false\)/.test(x.sql)), "من غير طلبات الاختبار");
});

test("staff: المالك بيضيف موظفين (PIN متشفّر)، ومفيش PIN مكرر، والكاشير مايوصلش", async () => {
  const s = build({ settings: {} });
  const put = await s.json("PUT", "/api/portal/staff", { token: `Bearer ${ADMIN}`, body: { staff: [
    { name: "سارة", role: "manager", pin: "7777" }, { name: "علي", role: "cashier", pin: "2468" }] } });
  assert.equal(put.status, 200);
  assert.ok(put.body.staff.every((x) => !("pinHash" in x) && !("pin" in x)));
  assert.ok(s.db.settings.portal.staff.every((x) => x.pinHash.startsWith("s1$") && !JSON.stringify(x).includes("7777")));
  assert.equal((await login(s, "7777")).body.role, "manager");
  const dup = await s.json("PUT", "/api/portal/staff", { token: `Bearer ${ADMIN}`, body: { staff: [
    { name: "أ", role: "manager", pin: "3333" }, { name: "ب", role: "cashier", pin: "3333" }] } });
  assert.equal(dup.status, 409);
  const tc = (await login(s, "2468")).body.token;
  assert.equal((await s.json("GET", "/api/portal/staff", { token: tc })).status, 401);
  const list = await s.json("GET", "/api/portal/staff", { token: `Bearer ${ADMIN}` });
  assert.equal(list.body.staff.length, 2);
});

/* ═══ ربط shop.js ═════════════════════════════════════════════════════════ */

test("shop.sweep: ربط تاب سينس واقع ← deps.portal().tabsenseDown (من غير ما يوقّع الكنس)", async () => {
  const prev = { TSP_AUTO_ORDER: process.env.TSP_AUTO_ORDER, SHOP_SWEEP_SECONDS: process.env.SHOP_SWEEP_SECONDS };
  process.env.TSP_AUTO_ORDER = "1";
  process.env.SHOP_SWEEP_SECONDS = "0";
  const seen = [];
  try {
    const routes = {};
    const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
    const api = registerShop({ get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }, {
      pool: { query: async () => ({ rows: [], rowCount: 0 }) }, requireAdmin: async () => null, requireCashierOrAdmin: async () => null,
      getSettingsData: async () => ({}), jb: JSON.stringify, normPhone: (x) => x,
    }, {
      delivery: { canAutoDispatch: async () => false, dispatchGate: async () => ({ mode: "manual" }) },
      tsp: () => null, emitOrder: () => {},
      portal: () => ({ tabsenseDown: (d) => { seen.push(d); throw new Error("portal boom"); } }),
    });
    await api.sweep();
    assert.deepEqual(seen, ["partner module missing"]);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

/* ═══ مراجعة عدائية — إصلاحات ═══════════════════════════════════════════ */

test("token: البصمة جوّه التوكن مقفولة بسر (مش sha256 للرقم المشترك) والجلسة لسه شغالة", async () => {
  const s = build({ settings: { shop: { cashierPin: "5151" } } });
  const { body } = await login(s, "5151");
  const payload = JSON.parse(Buffer.from(body.token.split(".")[0], "base64url").toString("utf8"));
  const { fingerprint } = await import("./portal-core.js");
  assert.notEqual(payload.pv, fingerprint("shared", "5151"), "البصمة الخام مش في التوكن");
  assert.equal((await s.json("GET", "/api/portal/me", { token: body.token })).status, 200);
  // تغيير الرقم المشترك بيقفل الجلسة (بعد كاش الهويات)
  s.db.settings.shop = { cashierPin: "9999" };
  await login(s, "9999"); // بيجدّد كاش الهويات
  const r = await s.json("GET", "/api/portal/me", { token: body.token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "session_revoked");
});

test("login: سقف عام — IPs كتير متزوّرة مابتخمّنش لما لا نهاية", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } } });
  for (let i = 0; i < 40; i++) await login(s, "0000", `9.9.${i}.1`);
  const r = await login(s, "7777", "8.8.8.8");
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "locked");
});

test("courier: فشل غير مؤكد (timeout/5xx) ← الحجز مايتفكّش + uncertain + رسالة راجع لوحة الشركة", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W1")],
    dispatchImpl: () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); } });
  const { body } = await login(s, "7777");
  const r = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(r.status, 502);
  assert.equal(r.body.uncertain, true);
  assert.match(r.body.message, /راجع لوحتهم/);
  await wait(5);
  const claimed = s.db.orders.get("W1").dispatch_claimed_at;
  assert.ok(claimed && Date.parse(claimed) > Date.now() - 60_000, "الحجز حديث");
  const retry = await s.json("POST", "/api/portal/orders/W1/courier", { token: body.token });
  assert.equal(retry.status, 409, "مفيش إعادة فورية = مفيش كابتن مكرر");
  assert.equal(s.calls.dispatch, 1);
});

test("push: جهاز موظف اتشال مايستقبلش، والكاشير مايمسحش اشتراك جهاز غيره", async () => {
  const s = build({ settings: { portal: { staff: STAFF() } }, orders: [orderRow("W7", { status: "paid" })] });
  s.db.subs.push({ id: 1, endpoint: "https://a.b/ok", sub: { endpoint: "https://a.b/ok" }, staff_id: "st_c" });
  s.db.subs.push({ id: 2, endpoint: "https://a.b/gone", sub: { endpoint: "https://a.b/gone" }, staff_id: "st_old" });
  s.emit({ orderNo: "W7", name: "order_paid", data: {} });
  await wait(30);
  assert.deepEqual(s.pushSent.map((p) => p.sub.endpoint), ["https://a.b/ok"]);
  const tc = (await login(s, "2468")).body.token;
  const d = await s.json("DELETE", "/api/portal/push/subscribe", { token: tc, body: { endpoint: "https://a.b/gone" } });
  assert.equal(d.body.removed, 0);
  assert.equal((await s.json("DELETE", "/api/portal/push/subscribe", { token: tc, body: { endpoint: "https://a.b/ok" } })).body.removed, 1);
});
