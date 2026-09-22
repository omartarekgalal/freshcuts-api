/* ═══════════════════════════════════════════════════════════════════════════
   ويبهوك Cervo من الباب للباب — الراوت الحقيقي، بقاعدة وهمية و API وهمي.

   السؤال اللي الاختبار ده بيجاوبه: Cervo مالهاش توقيع، يعني أي حد يعرف
   الرابط يقدر يبعت «الطلب اتوصّل». الراوت المفروض ياخد الرسالة كتنبيه
   وبس، ويسأل GET /order/{uid} ويصدّق ردّهم هو. فبنزوّر ردّهم ونتأكد إن
   **ردّهم** هو اللي بيمشي الحالة، مش الرسالة.

     node --test cervo-webhook.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import { register as registerDelivery } from "./delivery.js";
import { CERVO_STATUS } from "./cervo.js";

const jb = (v) => JSON.stringify(v);
const TOKEN = "cervo-test-token-never-logged";
const UID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ORDER_NO = "W1789825687099";

function setEnv(map) {
  const prev = {};
  for (const [k, v] of Object.entries(map)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => { for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

/* ردّهم المزوّر على GET /order/{uid}. `apiStatus = null` = الـAPI واقع. */
function build({ apiStatus = 4, apiFails = false, hasShipment = true, envMap = {},
                 driver = { DriverName: "سعد", DriverMobile: "+966500000000" },
                 tracking = "https://track.cervodelivery.com/x" } = {}) {
  const restore = setEnv({
    FA_POLL_MINUTES: "0", DISPATCH_LOST_SWEEP_SECONDS: "0",
    CERVO_TOKEN: TOKEN, CERVO_WEBHOOK_SECRET: undefined,
    CERVO_WEBHOOK_MIN_MS: "0",          // الخنق بيتجرّب في اختباره لوحده
    ...envMap,
  });
  const routes = {};
  const app = { get(p, h) { routes[`GET ${p}`] = h; }, post(p, h) { routes[`POST ${p}`] = h; },
                put(p, h) { routes[`PUT ${p}`] = h; }, delete(p, h) { routes[`DELETE ${p}`] = h; } };

  const logs = [], updates = [], shipmentEvents = [], milestones = [];
  const pool = { query: async (sql, vals) => {
    sql = String(sql);
    if (/count\(\*\)::int AS n FROM dl_policies/i.test(sql)) return { rows: [{ n: 1 }], rowCount: 1 };
    if (/INSERT INTO dl_webhook_log/i.test(sql)) {
      const [provider, verified, matched, http_status, body, header_keys] = vals;
      logs.push({ provider, verified, matched, http_status, body: body == null ? null : JSON.parse(body), header_keys, vals });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM dl_shipments\s+WHERE provider = 'cervo'/i.test(sql)) {
      return hasShipment
        ? { rows: [{ id: 7, shop_order_no: ORDER_NO, status: "assigned", provider: "cervo",
                     arrived_at: null, picked_at: null }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/UPDATE dl_shipments SET\s+status = COALESCE/i.test(sql)) {
      updates.push({ orderNo: vals[0], status: vals[1], driver: vals[2] && JSON.parse(vals[2]),
                     events: JSON.parse(vals[3]), cost: vals[4], ref: vals[5], provider: vals[6],
                     tracking: vals[7] });
      return { rows: [{ id: 7, shop_order_no: ORDER_NO, status: vals[1], provider: "cervo",
                        arrived_at: null, picked_at: null }], rowCount: 1 };
    }
    if (/UPDATE dl_shipments SET (arrived_at|picked_at)/i.test(sql)) {
      milestones.push(/arrived_at/.test(sql) ? "arrived" : "picked");
      return { rows: [{ shop_order_no: ORDER_NO, at: new Date().toISOString() }], rowCount: 1 };
    }
    if (/UPDATE dl_shipments SET events/i.test(sql)) {
      updates.push({ unverifiedOnly: true, events: JSON.parse(vals[1]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  } };

  /* الـAPI بتاعهم مزوّر. أي نداء تاني (Google/لاجلك) مالوش لازمة هنا. */
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET" });
    if (apiFails) return new Response("boom", { status: 500 });
    const body = JSON.stringify({
      id: UID, db_id: 12345, Status: apiStatus, ...driver,
      OrderStatus: [{ Status: 1, Date: "2026-09-22 10:00" }], tracking,
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };

  registerDelivery(app, { pool, requireAdmin: async () => null,
    getSettingsData: async () => ({ delivery: { provider: "leajlak" } }), jb },
    { shop: () => ({ onShipmentEvent: async (no, st) => { shipmentEvents.push([no, st]); } }),
      drive: { ensureSchema: async () => {} },
      zone: { ensureSchema: async () => {}, schedule: async () => {}, current: async () => ({}), refresh: async () => ({}) },
      leajlakDash: { configured: () => false, missing: () => ["x"], lookup: async () => ({ found: false }) } });

  const hook = routes["POST /api/delivery/cervo-webhook"];
  assert.ok(hook, "راوت ويبهوك Cervo مش متسجّل");
  const shared = routes["POST /api/delivery/courier-webhook"];

  const mk = (handler) => async (raw, headers = {}) => handler({
    req: { text: async () => raw, raw: { headers: new Headers(headers) } },
    json: (obj, status = 200) => ({ obj, status }),
    redirect: (to, status) => ({ redirect: to, status }),
  });

  return { call: mk(hook), callShared: mk(shared), logs, updates, shipmentEvents, milestones, calls,
           restore: () => { globalThis.fetch = realFetch; restore(); } };
}

const wh = (code, extra = {}) => JSON.stringify({
  order_id: UID, partner_ref: ORDER_NO, order_status: code,
  driver_name: "سعد", driver_mobile: "0500000000",
  tracking: "https://track.cervodelivery.com/x", ...extra });

/* ═══ كل كود حالة من الباب للباب ═══ */
for (const [code, expected] of Object.entries(CERVO_STATUS)) {
  test(`ويبهوك كود ${code} ← ${expected} (مصدّق من عندهم)`, async () => {
    const t = build({ apiStatus: Number(code) });
    try {
      const r = await t.call(wh(Number(code)));
      assert.equal(r.status, 200);
      assert.equal(r.obj.status, expected);
      /* اتسأل عنهم فعلاً قبل ما يمشي حاجة */
      assert.ok(t.calls.some((x) => x.url.includes(`/order/${UID}`)), "ماسألش الـAPI بتاعهم");
      const u = t.updates.find((x) => !x.unverifiedOnly);
      assert.ok(u, "الشحنة ما اتحدّثتش");
      assert.equal(u.status, expected);
      assert.equal(u.provider, "cervo");
      assert.equal(u.ref, UID);
      assert.equal(u.tracking, "https://track.cervodelivery.com/x");
      assert.deepEqual(t.shipmentEvents, [[ORDER_NO, expected]]);
      const l = t.logs.at(-1);
      assert.equal(l.provider, "cervo");
      assert.equal(l.matched, true);
      assert.equal(l.verified, true);
      assert.equal(l.http_status, 200);
    } finally { t.restore(); }
  });
}

test("٢٠ بتسجّل محطة «وصل المطعم»، و٣ بتسجّل «استلم»", async () => {
  let t = build({ apiStatus: 20 });
  try { await t.call(wh(20)); assert.deepEqual(t.milestones, ["arrived"]); } finally { t.restore(); }
  t = build({ apiStatus: 3 });
  try { await t.call(wh(3)); assert.deepEqual(t.milestones, ["picked"]); } finally { t.restore(); }
  t = build({ apiStatus: 2 });
  try { await t.call(wh(2)); assert.deepEqual(t.milestones, []); } finally { t.restore(); }
});

/* ═══ الرسالة مش مصدر الحقيقة ═══ */
test("رسالة مزوّرة «اتوصّل» و API بيقول «لسه ماشي» ← ردّهم بيغلب", async () => {
  const t = build({ apiStatus: 2 });          // عندهم: الكابتن قبل بس
  try {
    const r = await t.call(wh(4));            // الرسالة بتدّعي التوصيل
    assert.equal(r.obj.status, "assigned");
    assert.equal(t.updates.find((x) => !x.unverifiedOnly).status, "assigned");
    assert.deepEqual(t.shipmentEvents, [[ORDER_NO, "assigned"]]);
  } finally { t.restore(); }
});

test("الـAPI بتاعهم واقع ← مفيش تحريك حالة خالص", async () => {
  const t = build({ apiFails: true });
  try {
    const r = await t.call(wh(4));
    assert.equal(r.obj.unverified, true);
    assert.equal(r.status, 202);
    assert.equal(t.updates.some((x) => !x.unverifiedOnly), false, "حرّك حالة من غير تصديق!");
    /* الرسالة بتتسجّل في تاريخ الشحنة عشان الأثر مايضيعش */
    const ev = t.updates.find((x) => x.unverifiedOnly);
    assert.equal(ev.events[0].event, "webhook_unverified");
    assert.equal(t.shipmentEvents.length, 0);
    assert.equal(t.logs.at(-1).verified, false);
    assert.equal(t.logs.at(-1).http_status, 202);
  } finally { t.restore(); }
});

test("مرجع مش عندنا ← بيتسجّل ويتقفل من غير ما نسأل عنهم أصلاً", async () => {
  const t = build({ hasShipment: false });
  try {
    const r = await t.call(wh(4));
    assert.deepEqual(r.obj, { ok: true, ignored: true });
    assert.equal(t.calls.length, 0, "سأل الـAPI على مرجع مش عندنا");
    assert.equal(t.logs.at(-1).matched, false);
    assert.equal(t.logs.at(-1).provider, "cervo");
  } finally { t.restore(); }
});

test("رسالة من غير مرجعهم = متجاهلة", async () => {
  const t = build();
  try {
    const r = await t.call(JSON.stringify({ partner_ref: ORDER_NO, order_status: 4 }));
    assert.deepEqual(r.obj, { ok: true, ignored: true });
    assert.equal(t.calls.length, 0);
  } finally { t.restore(); }
});

test("JSON بايظ ← 400 + صف في السجل", async () => {
  const t = build();
  try {
    const r = await t.call("{{{", { "content-type": "text/plain" });
    assert.equal(r.status, 400);
    assert.equal(t.logs[0].http_status, 400);
    assert.equal(t.logs[0].provider, "cervo");
  } finally { t.restore(); }
});

test("سرّ متسجّل + رسالة من غيره ← 401 من غير أي نداء عليهم، والسرّ مايتسجّلش", async () => {
  const t = build({ envMap: { CERVO_WEBHOOK_SECRET: "sh-h-h" } });
  try {
    const r = await t.call(wh(4), { "x-cervo-signature": "wrong" });
    assert.equal(r.status, 401);
    assert.equal(t.calls.length, 0);
    assert.equal(t.logs[0].verified, false);
    assert.equal(JSON.stringify(t.logs[0].vals).includes("sh-h-h"), false);
  } finally { t.restore(); }
});

test("سرّ صح ← بيعدّي عادي", async () => {
  const t = build({ envMap: { CERVO_WEBHOOK_SECRET: "sh-h-h" }, apiStatus: 4 });
  try {
    const r = await t.call(wh(4), { "x-cervo-signature": "sh-h-h" });
    assert.equal(r.obj.status, "delivered");
  } finally { t.restore(); }
});

test("رشّة رسايل على نفس المرجع ← الخنق بيمنع رشّة نداءات عليهم", async () => {
  const t = build({ envMap: { CERVO_WEBHOOK_MIN_MS: "5000" }, apiStatus: 4 });
  try {
    const a = await t.call(wh(4));
    const b = await t.call(wh(4));
    const c = await t.call(wh(4));
    assert.equal(a.obj.status, "delivered");
    assert.equal(b.obj.throttled, true);
    assert.equal(c.obj.throttled, true);
    assert.equal(t.calls.length, 1, "سأل الـAPI أكتر من مرة في ثانية");
    assert.equal(t.logs.at(-1).http_status, 429);
  } finally { t.restore(); }
});

test("رسالة Cervo على الراوت المشترك ← بتتحوّل للراوت المصدّق مش بتتطبّق", async () => {
  const t = build();
  try {
    const r = await t.callShared(wh(4));
    assert.equal(r.status, 307);
    assert.equal(r.redirect, "/api/delivery/cervo-webhook");
    assert.equal(t.updates.length, 0, "الراوت المشترك حرّك حالة Cervo من غير تصديق!");
    assert.equal(t.logs.at(-1).provider, "cervo");
    assert.equal(t.logs.at(-1).http_status, 307);
  } finally { t.restore(); }
});

test("رسالة لاجلك على الراوت المشترك ما اتغيّرتش", async () => {
  const t = build();
  try {
    const r = await t.callShared(JSON.stringify({ id: "W1", status: "Delivered", dsp_order_id: "u-1" }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.obj, { ok: true });
    const u = t.updates.find((x) => !x.unverifiedOnly);
    assert.equal(u.provider, "leajlak");
    assert.equal(u.status, "delivered");
  } finally { t.restore(); }
});

test("سبب الإلغاء من الرسالة بيتسجّل (مالوش مصدر تاني ومالوش أثر خطير)", async () => {
  const t = build({ apiStatus: 5 });
  try {
    const r = await t.call(wh(5, { cancel: "الكابتن اتعطّل" }));
    assert.equal(r.obj.status, "cancelled");
    assert.equal(t.updates.find((x) => !x.unverifiedOnly).status, "cancelled");
  } finally { t.restore(); }
});
