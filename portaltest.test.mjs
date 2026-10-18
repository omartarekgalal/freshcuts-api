/* PV2 — «طلب تجريبي» (node --test portaltest.test.mjs)
   المخزن الصافي + المسارات على Hono حقيقي. مفيش قاعدة بيانات خالص: المسارات مابتلمسش pool — ده جزء من الاختبار
   (لو حد ضاف استعلام على shop_orders / تاب سينس هنا، الـpool الوهمي بيرمي والاختبار بيقع). */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { makeTestPings, register, testOrderPush, TEST_ORDER_TTL_MS, TEST_ORDER_RATE_MS, TEST_ORDER_TITLE } from "./portaltest.js";

test("store: create ⇒ live 60 s, rate limit 1 per 30 s, first ack per person wins (idempotent), late ack flagged", () => {
  let t = 1_000_000;
  let n = 0;
  const s = makeTestPings({ now: () => t, idOf: () => `p${++n}` });
  const a = s.create({ id: "m1", name: "المدير" });
  assert.equal(a.ok, true);
  assert.equal(a.ping.title, TEST_ORDER_TITLE);
  assert.equal(a.ping.live, true);
  assert.equal(a.ping.msLeft, TEST_ORDER_TTL_MS);
  assert.equal(Date.parse(a.ping.expiresAt) - Date.parse(a.ping.at), TEST_ORDER_TTL_MS);
  t += 10_000;
  const b = s.create({ id: "m1", name: "المدير" });
  assert.equal(b.ok, false); assert.equal(b.error, "rate_limited"); assert.equal(b.retryInSec, 20);
  t += 2_000;
  const k1 = s.ack("p1", { id: "c1", name: "منى", role: "cashier" });
  assert.equal(k1.ok, true); assert.equal(k1.first, true); assert.equal(k1.ms, 12_000); assert.equal(k1.late, false);
  t += 5_000;
  const k2 = s.ack("p1", { id: "c1", name: "منى", role: "cashier" });
  assert.equal(k2.first, false); assert.equal(k2.ms, 12_000, "the second tap keeps the first time");
  assert.equal(s.get("p1").firstAckMs, 12_000);
  assert.equal(s.active().length, 1);
  t += TEST_ORDER_TTL_MS;
  assert.equal(s.active().length, 0, "gone after a minute");
  assert.equal(s.get("p1").live, false, "the manager still sees the result");
  const late = s.ack("p1", { id: "c2", name: "أحمد", role: "cashier" });
  assert.equal(late.late, true);
  t += TEST_ORDER_RATE_MS;
  assert.equal(s.create({ id: "m1" }).ok, true, "allowed again after 30 s");
  t += 10 * 60_000;
  assert.equal(s.get("p1"), null, "swept after 5 minutes");
  assert.equal(s.ack("nope", {}).ok, false);
});

test("push payload: cashier-facing, no order number, short TTL", () => {
  const p = testOrderPush({ id: "x1", by: "المدير" }, "https://x/portal/");
  assert.equal(p.kind, "test_order"); assert.equal(p.orderNo, null); assert.equal(p.ttl, 60); assert.match(p.body, /مش طلب حقيقي/);
});

function harness({ role = "manager", t0 = 5_000_000 } = {}) {
  let t = t0;
  const events = [], audits = [], pushes = [];
  const users = { manager: { id: "m1", name: "مدير", role: "manager" }, cashier: { id: "c1", name: "منى", role: "cashier" } };
  let who = role;
  const app = new Hono();
  const requirePortal = async (c, need) => {
    const u = users[c.req.header("x-who") || who];
    if (!u) return { res: c.json({ ok: false, error: "unauthorized" }, 401) };
    if (need === "manager" && u.role !== "manager") return { res: c.json({ ok: false, error: "forbidden" }, 403) };
    return { user: u };
  };
  register(app, {
    requirePortal, now: () => t,
    broadcastTo: (event, data, roles) => events.push({ event, data, roles }),
    push: { PORTAL_URL: "https://p/portal/", sendToSubs: async (payload, opts) => { pushes.push({ payload, opts }); return { sent: 2, of: 3 }; } },
    audit: (...a) => audits.push(a), clientIp: () => "1.2.3.4", streamsFor: (r) => (r === "cashier" ? 2 : 0), log: { error() {} },
  });
  const call = async (method, path, as) => { const r = await app.request(path, { method, headers: as ? { "x-who": as } : {} }); return { status: r.status, body: await r.json() }; };
  return { call, events, audits, pushes, tick: (ms) => { t += ms; }, as: (r) => { who = r; } };
}

test("routes: manager sends ⇒ SSE to cashier role only + push to cashier devices + one audit row (no order number); cashier 403", async () => {
  const h = harness();
  const r = await h.call("POST", "/api/portal/test-order");
  assert.equal(r.status, 200);
  assert.equal(r.body.cashierStreams, 2);
  assert.deepEqual(r.body.push, { sent: 2, of: 3 });
  assert.deepEqual(h.events.map((e) => [e.event, e.roles.join()]), [["test_order", "cashier"]]);
  assert.equal(h.pushes[0].opts.role, "cashier");
  assert.equal(h.pushes[0].payload.kind, "test_order");
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0][1], "portal_test_order");
  assert.equal(h.audits[0][2], null, "no order number on the audit row ⇒ never in an order timeline");
  assert.deepEqual(h.audits[0][6], { emit: false }, "no order event on the bus");
  assert.equal((await h.call("POST", "/api/portal/test-order", "cashier")).status, 403);
  const again = await h.call("POST", "/api/portal/test-order");
  assert.equal(again.status, 429); assert.equal(again.body.error, "rate_limited"); assert.ok(again.body.retryInSec > 0);
});

test("routes: cashier sees the live ping, taps «وصلني» ⇒ ack event to manager + cashier with the seconds; manager reads the result", async () => {
  const h = harness();
  const { body } = await h.call("POST", "/api/portal/test-order");
  const id = body.ping.id;
  h.tick(4_200);
  const act = await h.call("GET", "/api/portal/test-order/active", "cashier");
  assert.equal(act.body.pings.length, 1);
  assert.equal(act.body.pings[0].msLeft, TEST_ORDER_TTL_MS - 4_200, "remaining time comes from the server clock");
  const ack = await h.call("POST", `/api/portal/test-order/${id}/ack`, "cashier");
  assert.equal(ack.status, 200); assert.equal(ack.body.ms, 4_200);
  const ev = h.events.find((e) => e.event === "test_order_ack");
  assert.deepEqual(ev.roles, ["manager", "cashier"]);
  assert.equal(ev.data.ms, 4_200); assert.equal(ev.data.by, "منى");
  assert.equal(h.audits.filter((a) => a[1] === "portal_test_ack").length, 1);
  await h.call("POST", `/api/portal/test-order/${id}/ack`, "cashier");
  assert.equal(h.events.filter((e) => e.event === "test_order_ack").length, 1, "the second tap does not re-broadcast");
  const st = await h.call("GET", `/api/portal/test-order/${id}`);
  assert.equal(st.body.ping.firstAckMs, 4_200);
  assert.equal((await h.call("GET", `/api/portal/test-order/${id}`, "cashier")).status, 403);
  h.tick(TEST_ORDER_TTL_MS);
  assert.equal((await h.call("GET", "/api/portal/test-order/active", "cashier")).body.pings.length, 0);
  assert.equal((await h.call("POST", "/api/portal/test-order/nope/ack", "cashier")).status, 404);
});
