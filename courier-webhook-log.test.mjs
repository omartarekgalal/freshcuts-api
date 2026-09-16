/* ═══════════════════════════════════════════════════════════════════════════
   سجل ويبهوك المندوب (dl_webhook_log)

   لاجلك عمرها ما بعتت ويبهوك واحد (كل الأحداث لحد النهارده poll). الجدول
   ده هو الإثبات: كل نداء على /api/delivery/courier-webhook بيكتب صف، في كل
   فروع الرد (400 / ignored / bad_secret / matched / مش عندنا)، والرد نفسه
   ما بيتغيرش. والهيدرز بالأسماء بس — ولا قيمة سرّ بتتخزّن.

     node --test courier-webhook-log.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

import { register as registerDelivery, webhookLogBody } from "./delivery.js";

const jb = (v) => JSON.stringify(v);
const SECRET = "s3cr3t-value-never-logged";

function setEnv(map) {
  const prev = {};
  for (const [k, v] of Object.entries(map)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

/* بيبني وحدة التوصيل بتطبيق وهمي بيمسك الراوتات، وقاعدة وهمية بتسجّل
   صفوف dl_webhook_log وبترد على UPDATE dl_shipments بالعدد المطلوب. */
function build({ settings = { delivery: { provider: "leajlak" } }, envMap = {}, updRows = 1, logThrows = false } = {}) {
  const restore = setEnv({ FA_POLL_MINUTES: "0", LEAJLAK_WEBHOOK_SECRET: undefined, ...envMap });
  const routes = {};
  const app = {
    get(p, h) { routes[`GET ${p}`] = h; }, post(p, h) { routes[`POST ${p}`] = h; },
    put(p, h) { routes[`PUT ${p}`] = h; }, delete(p, h) { routes[`DELETE ${p}`] = h; },
  };
  const logs = [];
  const shipmentEvents = [];
  const pool = {
    query: async (sql, vals) => {
      sql = String(sql);
      if (/count\(\*\)::int AS n FROM dl_policies/i.test(sql)) return { rows: [{ n: 1 }], rowCount: 1 };
      if (/INSERT INTO dl_webhook_log/i.test(sql)) {
        if (logThrows) throw new Error("relation dl_webhook_log does not exist");
        const [provider, verified, matched, http_status, body, header_keys] = vals;
        logs.push({ provider, verified, matched, http_status, body: body == null ? null : JSON.parse(body), header_keys, vals });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE dl_shipments SET\s+status = COALESCE/i.test(sql)) {
        return updRows
          ? { rows: [{ id: 1, shop_order_no: vals[0] || "W1", status: vals[1] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  registerDelivery(app, { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb },
    { shop: () => ({ onShipmentEvent: async (no, st) => { shipmentEvents.push([no, st]); } }) });
  const hook = routes["POST /api/delivery/courier-webhook"];
  assert.ok(hook, "راوت الويبهوك مش متسجّل");

  const call = async (raw, headers = {}) => {
    const c = {
      req: { text: async () => raw, raw: { headers: new Headers(headers) } },
      json: (obj, status = 200) => ({ obj, status }),
    };
    return hook(c);
  };
  return { call, logs, shipmentEvents, restore };
}

const noSecretAnywhere = (logs) => {
  for (const l of logs) assert.ok(!JSON.stringify(l.vals).includes(SECRET), "قيمة السرّ اتسجّلت!");
};

test("JSON بايظ ← نفس الرد 400 + صف http_status=400", async () => {
  const t = build();
  try {
    const r = await t.call("not json {", { "content-type": "text/plain" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.obj, { ok: false });
    assert.equal(t.logs.length, 1);
    assert.equal(t.logs[0].http_status, 400);
    assert.equal(t.logs[0].provider, null);
    assert.equal(t.logs[0].matched, false);
    assert.deepEqual(t.logs[0].header_keys, ["content-type"]);
  } finally { t.restore(); }
});

test("form-encoded فيه سرّ ← بيتسجّل مع إخفاء القيمة", async () => {
  const t = build();
  try {
    const r = await t.call(`id=W1&status=Delivered&secret=${SECRET}`);
    assert.equal(r.status, 400);
    assert.match(t.logs[0].body._unparsed, /secret=\[redacted\]/);
    noSecretAnywhere(t.logs);
  } finally { t.restore(); }
});

test("رسالة محدش فاهمها ← ignored + صف provider=null", async () => {
  const t = build();
  try {
    const r = await t.call(JSON.stringify({ hello: "world" }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.obj, { ok: true, ignored: true });
    assert.equal(t.logs.length, 1);
    assert.equal(t.logs[0].provider, null);
    assert.equal(t.logs[0].matched, false);
    assert.equal(t.logs[0].http_status, 200);
    assert.deepEqual(t.logs[0].body, { hello: "world" });
  } finally { t.restore(); }
});

test("سرّ غلط ← نفس الرد 401 + صف verified=false، والهيدرز بالأسماء بس", async () => {
  const t = build({ envMap: { LEAJLAK_WEBHOOK_SECRET: SECRET } });
  try {
    const r = await t.call(JSON.stringify({ id: "W1", status: "Delivered", secret: "wrong" }),
      { authorization: `Bearer nope-${SECRET}`, "x-request-id": "abc" });
    assert.equal(r.status, 401);
    assert.deepEqual(r.obj, { ok: false, error: "bad_secret" });
    assert.equal(t.logs.length, 1);
    const l = t.logs[0];
    assert.equal(l.provider, "leajlak");
    assert.equal(l.verified, false);
    assert.equal(l.matched, false);
    assert.equal(l.http_status, 401);
    assert.deepEqual([...l.header_keys].sort(), ["authorization", "x-request-id"]);
    assert.equal(l.body.secret, "[redacted]");
    noSecretAnywhere(t.logs);
    assert.ok(!JSON.stringify(l.vals).includes("abc"), "قيمة هيدر اتسجّلت");
  } finally { t.restore(); }
});

test("سرّ صح + شحنة عندنا ← { ok:true } + صف matched=true verified=true", async () => {
  const t = build({ envMap: { LEAJLAK_WEBHOOK_SECRET: SECRET } });
  try {
    const r = await t.call(JSON.stringify({ id: "W1", status: "Delivered" }), { "x-webhook-secret": SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(r.obj, { ok: true });
    assert.equal(t.logs.length, 1);
    const l = t.logs[0];
    assert.equal(l.provider, "leajlak");
    assert.equal(l.verified, true);
    assert.equal(l.matched, true);
    assert.equal(l.http_status, 200);
    assert.deepEqual(l.header_keys, ["x-webhook-secret"]);
    noSecretAnywhere(t.logs);
    assert.equal(t.shipmentEvents.length, 1);
  } finally { t.restore(); }
});

test("من غير سرّ متسجّل ← verified=null (مش true)", async () => {
  const t = build();
  try {
    const r = await t.call(JSON.stringify({ id: "W1", status: "Delivered" }));
    assert.deepEqual(r.obj, { ok: true });
    assert.equal(t.logs[0].verified, null);
    assert.equal(t.logs[0].matched, true);
  } finally { t.restore(); }
});

test("شحنة مش عندنا ← ignored + صف provider=leajlak matched=false", async () => {
  const t = build({ updRows: 0 });
  try {
    const r = await t.call(JSON.stringify({ id: "W999", status: "Delivered" }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.obj, { ok: true, ignored: true });
    assert.equal(t.logs.length, 1);
    assert.equal(t.logs[0].provider, "leajlak");
    assert.equal(t.logs[0].matched, false);
    assert.equal(t.shipmentEvents.length, 0);
  } finally { t.restore(); }
});

test("ويبهوك Flying Arrow برضه بيتسجّل باسم مزوّده", async () => {
  const t = build({ settings: { delivery: { provider: "flyingarrow" } } });
  try {
    const r = await t.call(JSON.stringify({ external_order_id: "W1", event: "order.delivered" }));
    assert.deepEqual(r.obj, { ok: true });
    assert.equal(t.logs[0].provider, "flyingarrow");
    assert.equal(t.logs[0].matched, true);
  } finally { t.restore(); }
});

test("الجدول واقع ← الرد ما يتغيرش", async () => {
  const t = build({ logThrows: true });
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.deepEqual((await t.call("bad")).obj, { ok: false });
    assert.deepEqual((await t.call(JSON.stringify({ x: 1 }))).obj, { ok: true, ignored: true });
    assert.deepEqual((await t.call(JSON.stringify({ id: "W1", status: "Delivered" }))).obj, { ok: true });
  } finally { console.error = realErr; t.restore(); }
});

test("webhookLogBody: بيقص الرسايل الكبيرة ويخفي المفاتيح المتداخلة", () => {
  const big = { id: "W1", blob: "x".repeat(20000) };
  const out = webhookLogBody(big);
  assert.equal(out._truncated, true);
  assert.ok(out.head.length <= 8000);
  assert.ok(out._length > 8000);

  const nested = webhookLogBody({ id: "W1", meta: { api_key: "k", token: "t", driver: { name: "أحمد" } } });
  assert.equal(nested.meta.api_key, "[redacted]");
  assert.equal(nested.meta.token, "[redacted]");
  assert.equal(nested.meta.driver.name, "أحمد");
  assert.equal(nested.id, "W1");
});

test("JSON مش كائن (نص) ← الصف بيتكتب بـJSON صالح والرد زي ما هو", async () => {
  const t = build();
  const realErr = console.error;
  console.error = () => {};
  try {
    const r = await t.call(JSON.stringify("hello"));
    assert.deepEqual(r.obj, { ok: true, ignored: true });
    assert.deepEqual(t.logs[0].body, { _value: "hello" });
    const out = webhookLogBody("hello");
    assert.deepEqual(out, { _value: "hello" });
    // jb الحقيقي بيرجّع النص زي ما هو — لازم يبقى JSON صالح
    JSON.parse(JSON.stringify(out));
  } finally { console.error = realErr; t.restore(); }
});

test("JSON مكسور فيه سرّ ← القيمة بتتخفى", async () => {
  const t = build();
  try {
    const r = await t.call(`{"id":"W1","secret":"${SECRET}","x":`, { authorization: "Bearer zzz" });
    assert.equal(r.status, 400);
    noSecretAnywhere(t.logs);
    const out = webhookLogBody({ _unparsed: `Authorization: Bearer ${SECRET}\n{"api_key": "${SECRET}"` });
    assert.ok(!JSON.stringify(out).includes(SECRET));
  } finally { t.restore(); }
});

test("سرّ متداخل أعمق من ٦ مستويات ← مايتسجّلش", () => {
  let deep = { token: SECRET };
  for (let i = 0; i < 12; i++) deep = { n: deep };
  assert.ok(!JSON.stringify(webhookLogBody(deep)).includes(SECRET));
});
