/* ⚡ RT1 (عمر ١٧/١٠/٢٠٢٦): «التحديثات موصلتش بشكل فوري … وموصلتش رسايل واتساب إن الطلب جاهز»
   node --test rt1-webhook-now.test.mjs

   ويبهوك تاب سينس بيتطبّق على الطلب لحظة وصوله (tspartner.webhook → shop.applyWebhookFor)
   بنفس دوال الكنس. كل حاجة وهمية: داتابيز في الذاكرة لطلب واحد + ويبهوكاته، إشعارات
   وأحداث بتتلمّ في مصفوفات. مفيش شبكة ولا SMS ولا جوال حقيقي (9665xxxxxxx بس). */
import test from "node:test";
import assert from "node:assert/strict";
import { register as registerShop } from "./shop.js";
import { register as registerTsp } from "./tspartner.js";
import { sweepSecOf, readyGraceMinOf, readyNotifyDue, SWEEP_LIMITS, READY_GRACE_LIMITS } from "./prepstatus.js";
import { describeFields } from "./deliverycontrol.js";
import { readyLagTone } from "./syshealth.js";

const jb = (v) => JSON.stringify(v);
const normPhone = (p) => String(p || "").replace(/\D/g, "").slice(-9);
const MIN = 60_000;
const T0 = Date.parse("2026-10-17T16:00:00Z");
const at = (m) => new Date(T0 + m * MIN).toISOString();
const tick = () => new Promise((r) => setImmediate(r));

function fakeApp() {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}

/* داتابيز وهمية: صف واحد في shop_orders + جدول tsp_webhooks حي (الويبهوك بيضيف فيه) */
function fakeDb(order) {
  const db = { order: { ...order }, hooks: [], queries: [] };
  db.pool = {
    query: async (sql, vals = []) => {
      const s = String(sql);
      db.queries.push({ sql: s, vals });
      const o = db.order;
      const hooksOf = (pid) => db.hooks.filter((h) => h.pid === String(pid)).sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
      if (/^INSERT INTO tsp_webhooks/.test(s)) {
        const p = JSON.parse(vals[1]);
        const h = { pid: String(p.resource?.order?.id ?? ""), received_at: p.__at || new Date().toISOString(),
          approval: p.resource?.statuses_slugs?.approval_status ?? null, order_status: p.resource?.statuses_slugs?.order_status ?? null, payload: p };
        db.hooks.push(h);
        return { rows: [{ id: db.hooks.length, received_at: h.received_at }], rowCount: 1 };
      }
      // applyWebhookFor: ربط الويبهوك بالطلب
      if (/FROM shop_orders\s+WHERE created_at > NOW\(\) - INTERVAL '48 hours'\s+AND \(\(\$1 <> ''/.test(s)) {
        return String(o.pos_order_id) === String(vals[0]) ? { rows: [{ ...o }] } : { rows: [] };
      }
      // WEBHOOKS_SQL (كل ويبهوكات الطلب) / آخر approval
      if (/approval_status' AS approval/.test(s)) return { rows: hooksOf(vals[0]).map(({ received_at, approval, order_status }) => ({ received_at, approval, order_status })) };
      if (/jsonb_build_object\('statuses_slugs'/.test(s)) {
        const last = hooksOf(vals[0]).at(-1);
        return { rows: last ? [{ payload: { resource: { statuses_slugs: { approval_status: last.approval, order_status: last.order_status } } } }] : [] };
      }
      if (/SET pos_ready_at = \$2::timestamptz/.test(s)) {
        if (o.pos_ready_at) return { rows: [], rowCount: 0 };
        o.pos_ready_at = vals[1]; o.ready_source = vals[2]; return { rows: [], rowCount: 1 };
      }
      if (/SET handed_at = LEAST/.test(s)) {
        if (o.handed_at && o.handed_source !== "courier") return { rows: [], rowCount: 0 };
        o.handed_at = vals[1]; o.handed_source = "pos"; return { rows: [], rowCount: 1 };
      }
      if (/collected_at = COALESCE\(collected_at, \$4::timestamptz\)/.test(s)) {
        o.pos_approval = "delivered"; o.pos_ready_at = o.pos_ready_at || vals[1]; o.collected_at = o.collected_at || vals[3]; return { rows: [], rowCount: 1 };
      }
      if (/UPDATE shop_orders SET status=\$2/.test(s)) { o.status = vals[1]; return { rows: [], rowCount: 1 }; }
      if (/SET accepted_at = COALESCE/.test(s)) { o.accepted_at = o.accepted_at || vals[1]; return { rows: [], rowCount: 1 }; }
      if (/SET pos_approval=\$2, updated_at=NOW\(\)/.test(s)) { o.pos_approval = vals[1]; return { rows: [], rowCount: 1 }; }
      // الكنس
      if (/pos_ready_at IS NULL\s+OR \(option='delivery'/.test(s)) {
        const watch = ["accepted", "courier_requested", "courier_assigned", "on_the_way", "out_for_delivery", "courier_cancelled"];
        return watch.includes(o.status) && o.pos_order_id && (!o.pos_ready_at || (o.option === "delivery" && (o.handed_source || "courier") === "courier"))
          ? { rows: [{ ...o }] } : { rows: [] };
      }
      if (/WHERE option='pickup' AND pos_order_id IS NOT NULL/.test(s)) {
        return o.option === "pickup" && ["pos_created", "accepted"].includes(o.status) ? { rows: [{ order_no: o.order_no, pos_order_id: o.pos_order_id, option: o.option, pos_ready_at: o.pos_ready_at }] } : { rows: [] };
      }
      if (/WHERE status='pos_created' AND pos_order_id IS NOT NULL/.test(s)) return o.status === "pos_created" ? { rows: [{ ...o }] } : { rows: [] };
      if (/SELECT \* FROM shop_orders WHERE order_no=\$1/.test(s)) return { rows: [{ ...o }] };
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

function build(order, { settings = {}, shopDeps = {} } = {}) {
  const prev = { SHOP_SWEEP_SECONDS: process.env.SHOP_SWEEP_SECONDS, TSP_AUTO_ORDER: process.env.TSP_AUTO_ORDER, TSP_KEEPALIVE: process.env.TSP_KEEPALIVE };
  process.env.SHOP_SWEEP_SECONDS = "0"; delete process.env.TSP_AUTO_ORDER; process.env.TSP_KEEPALIVE = "0";
  const db = fakeDb(order);
  const events = [], readyPush = [], statusNotify = [];
  const ctx = { pool: db.pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => settings, jb, normPhone };
  const shopApi = registerShop(fakeApp(), ctx, {
    pay: { configured: () => true },
    delivery: { quote: async () => ({}), shipmentOf: async () => null, cancelShipment: async () => null,
      dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
    notify: { orderStatusChanged: async (no, st) => { statusNotify.push([no, st]); }, orderReady: async (no) => { readyPush.push(no); return 1; } },
    emitOrder: (name, opts) => { events.push({ name, ...opts }); },
    ...shopDeps,
  });
  const app = fakeApp();
  const tsp = registerTsp(app, ctx, { shop: () => shopDeps.shopOverride || shopApi });
  const webhook = app.routes["POST /webhooks/"];
  const post = async (body) => webhook({ req: { json: async () => body, text: async () => "" }, json: (obj, status = 200) => ({ body: obj, status }) });
  const restore = () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return { db, shopApi, tsp, post, events, readyPush, statusNotify, restore };
}

/* ويبهوك تاب سينس زي الحقيقي (ev3.json)، بس بأرقام وهمية. __at = وقت الوصول للاختبار */
const hook = (pid, approval, orderStatus, atMin, event = "order-updated") => ({
  event, __at: at(atMin),
  resource: { order: { id: pid, tenant_order_id: "freshcuts-9001", customer: { phone: "+966500000001", first_name: "اختبار" } },
    statuses_slugs: { order_status: orderStatus, payment_status: "fully_paid", approval_status: approval } },
});
const PICKUP = { order_no: "W1792250000001", status: "accepted", option: "pickup", branch_id: "1", pos_order_id: "Gw8eTEST01", pos_ready_at: null,
  handed_at: null, handed_source: null, total: 96, mf_payment_id: "p1", refund_id: null, created_at: at(-30), phone_norm: "500000001", history: [] };

/* ═══ ١) الويبهوك ⇒ «جاهز» فوراً: pos_ready_at + حدث + إشعار، وحدث webhook_applied بالفرق ═══ */
test("ويبهوك pickup_ready ⇒ pos_ready_at فوراً + pos_ready + إشعار «جاهز» + webhook_applied بالفرق (من غير كنس)", async () => {
  const s = build(PICKUP);
  try {
    await s.post(hook("Gw8eTEST01", "accepted", "processing", 0));
    const res = await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    assert.deepEqual(res, { body: { ok: true }, status: 200 });
    await s.tsp.drainWebhooks(); await tick();
    assert.equal(s.db.order.pos_ready_at, at(20), "وقت «جاهز» = وقت الويبهوك مش وقت المعالجة");
    assert.deepEqual(s.readyPush, [PICKUP.order_no]);
    const ready = s.events.filter((e) => e.name === "pos_ready");
    assert.equal(ready.length, 1);
    assert.deepEqual(ready[0].data, { source: "pos", by: null, approval: "pickup_ready", at: at(20), basis: "pos_ready" }, "نفس شكل الحدث القديم");
    const applied = s.events.filter((e) => e.name === "webhook_applied");
    assert.equal(applied.length, 2, "حدث لكل ويبهوك اتربط بطلب (القبول كمان)");
    const last = applied.at(-1);
    assert.equal(last.orderNo, PICKUP.order_no);
    assert.equal(last.data.via, "webhook");
    assert.equal(last.data.ready, true);
    assert.equal(last.data.approval, "pickup_ready");
    assert.equal(typeof last.data.lagSec, "number");
    // الفرق = لحظة التطبيق − received_at اللي الـINSERT رجّعه (في الاختبار الويبهوك مثبّت على 16:20Z)
    const expectedLag = (Date.now() - Date.parse(at(20))) / 1000;
    assert.ok(Math.abs(last.data.lagSec - expectedLag) < 5, `lagSec=${last.data.lagSec} متوقع ≈ ${expectedLag.toFixed(1)}`);
    assert.ok(last.data.workMs >= 0 && last.data.workMs < 2000, "المعالجة نفسها بالمللي ثانية");
    assert.equal(s.db.order.status, "accepted", "«جاهز» مش «استلم»");
  } finally { s.restore(); }
});

/* ═══ ٢) نفس الويبهوك مرتين ⇒ مرة واحدة ═══ */
test("نفس ويبهوك «جاهز» مرتين ⇒ إشعار واحد وحدث pos_ready واحد (الشرط في الـUPDATE + الصف بيتحدّث في الذاكرة)", async () => {
  const s = build(PICKUP);
  try {
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.tsp.drainWebhooks(); await tick();
    assert.deepEqual(s.readyPush, [PICKUP.order_no]);
    assert.equal(s.events.filter((e) => e.name === "pos_ready").length, 1);
    const applied = s.events.filter((e) => e.name === "webhook_applied");
    assert.deepEqual(applied.map((e) => e.data.ready), [true, false], "التاني اتسجّل بس ماغيّرش حاجة");
  } finally { s.restore(); }
});

/* ═══ ٣) الكنس بعد الويبهوك ⇒ مفيش إشعار تاني ولا حدث «الكنس طبّق» ═══ */
test("الكنس بعد الويبهوك ⇒ مفيش إشعار تاني ولا webhook_applied via=sweep (مفيش حاجة اتغيّرت)", async () => {
  const s = build(PICKUP);
  try {
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.tsp.drainWebhooks(); await tick();
    assert.deepEqual(s.readyPush, [PICKUP.order_no]);
    await s.shopApi.sweep(); await tick();
    assert.deepEqual(s.readyPush, [PICKUP.order_no]);
    assert.equal(s.events.filter((e) => e.name === "pos_ready").length, 1);
    assert.equal(s.events.filter((e) => e.name === "webhook_applied" && e.data.via === "sweep").length, 0);
  } finally { s.restore(); }
});

/* ═══ ٤) الويبهوك واقع والكنس هو اللي لمّها ⇒ webhook_applied via=sweep بالفرق من آخر ويبهوك ═══ */
test("شبكة الأمان: الويبهوك اتسجّل من غير معالجة ⇒ الكنس بيطبّقه وبيسجّل webhook_applied via=sweep", async () => {
  const s = build(PICKUP, { shopDeps: { shopOverride: { applyWebhookFor: null } } });   // مفيش معالجة فورية
  try {
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.tsp.drainWebhooks(); await tick();
    assert.deepEqual(s.readyPush, [], "لسه محدش طبّق");
    await s.shopApi.sweep(); await tick();
    assert.deepEqual(s.readyPush, [PICKUP.order_no]);
    const sw = s.events.filter((e) => e.name === "webhook_applied");
    assert.equal(sw.length, 1);
    assert.equal(sw[0].data.via, "sweep");
    assert.equal(sw[0].data.ready, true);
    assert.equal(typeof sw[0].data.lagSec, "number");
  } finally { s.restore(); }
});

/* ═══ ٥) القفل جوّه المهلة ⇒ إشعار «جاهز» يطلع برضه؛ بعدها ⇒ يتشال بسبب مسجّل ═══ */
test("جاهز ثم قفل بعد ٢٠ ثانية (جوّه المهلة ١٠ د) ⇒ إشعار «جاهز» + «استلمت طلبك»، والطلب delivered بوقت القفل", async () => {
  const s = build(PICKUP);
  try {
    // الكاشير ضغط الاتنين ورا بعض، والويبهوكين وصلوا قبل ما نعالج أي حاجة
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.post(hook("Gw8eTEST01", "delivered", "completed", 20.33));
    await s.tsp.drainWebhooks(); await tick();
    assert.deepEqual(s.readyPush, [PICKUP.order_no], "«جاهز» في وقتها حتى لو القفل جه معاها");
    assert.equal(s.db.order.status, "delivered");
    assert.equal(s.db.order.collected_at, at(20.33));
    assert.deepEqual(s.statusNotify, [[PICKUP.order_no, "delivered"]]);
    assert.equal(s.events.filter((e) => e.name === "pos_ready").length, 1);
    const closedEv = s.events.filter((e) => e.name === "webhook_applied").at(-1);
    assert.equal(closedEv.data.closed, true);
  } finally { s.restore(); }
});

test("جاهز ثم قفل بعد ١١ دقيقة (بعد المهلة) ⇒ «جاهز» قديمة: مفيش إشعار + notify_sent/closed_after_grace؛ ومع مهلة ٣٠ من اللوحة ⇒ يطلع", async () => {
  let s = build(PICKUP, { shopDeps: { shopOverride: { applyWebhookFor: null } } });
  try {
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.post(hook("Gw8eTEST01", "delivered", "completed", 31));
    await s.tsp.drainWebhooks();
    // المعالجة الأولى بتشوف الاتنين مع بعض (الكنس أو ويبهوك القفل)
    await s.shopApi.applyWebhookFor({ posOrderId: "Gw8eTEST01", receivedAt: at(31) }); await tick();
    assert.deepEqual(s.readyPush, []);
    const skip = s.events.find((e) => e.name === "notify_sent" && e.data?.reason === "closed_after_grace");
    assert.ok(skip); assert.equal(skip.data.graceMin, READY_GRACE_LIMITS.def);
    assert.equal(s.db.order.status, "delivered");
  } finally { s.restore(); }

  s = build(PICKUP, { settings: { shop: { readyNotifyGraceMin: 30 } }, shopDeps: { shopOverride: { applyWebhookFor: null } } });
  try {
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.post(hook("Gw8eTEST01", "delivered", "completed", 31));
    await s.tsp.drainWebhooks();
    await s.shopApi.applyWebhookFor({ posOrderId: "Gw8eTEST01", receivedAt: at(31) }); await tick();
    assert.deepEqual(s.readyPush, [PICKUP.order_no]);
  } finally { s.restore(); }
});

test("التوصيل: «جاهز» + «تم التوصيل» من الويبهوك فوراً ⇒ pos_ready_at + handed_at (تسليم للمندوب)، ومفيش إشعار «جاهز» ولا delivered", async () => {
  const s = build({ ...PICKUP, option: "delivery", status: "courier_assigned" });
  try {
    await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
    await s.post(hook("Gw8eTEST01", "delivered", "completed", 20.2));
    await s.tsp.drainWebhooks(); await tick();
    assert.equal(s.db.order.pos_ready_at, at(20));
    assert.equal(s.db.order.handed_at, at(20.2));
    assert.equal(s.db.order.handed_source, "pos");
    assert.deepEqual(s.readyPush, []);
    assert.equal(s.db.order.status, "courier_assigned", "التوصيل بيتقفل بتحديثات المندوب مش ضغطة الكاشير");
    assert.equal(s.events.filter((e) => e.name === "staff_action" && e.data.action === "handed_to_courier").length, 1);
  } finally { s.restore(); }
});

/* ═══ ٦) القبول من صندوق نقطة البيع فوراً ═══ */
test("طلب pos_created + ويبهوك accepted ⇒ accepted فوراً بوقت الويبهوك (مش الكنس)", async () => {
  const s = build({ ...PICKUP, option: "delivery", status: "pos_created" });
  try {
    await s.post(hook("Gw8eTEST01", "accepted", "processing", 3));
    await s.tsp.drainWebhooks(); await tick();
    assert.equal(s.db.order.status, "accepted");
    assert.equal(s.db.order.accepted_at, at(3));
    assert.deepEqual(s.statusNotify, [[PICKUP.order_no, "accepted"]]);
    const applied = s.events.find((e) => e.name === "webhook_applied");
    assert.equal(applied.data.accepted, true);
    assert.equal(applied.data.status, "accepted");
  } finally { s.restore(); }
});

/* ═══ ٧) الرد 200 دايماً ═══ */
test("الويبهوك بيرجع 200 حتى لو المعالج رمى (sync وasync) أو التخزين وقع أو الطلب مش بتاعنا", async () => {
  const origErr = console.error; console.error = () => {};
  try {
    for (const bad of [{ applyWebhookFor: () => { throw new Error("boom"); } }, { applyWebhookFor: async () => { throw new Error("boom-async"); } }]) {
      const s = build(PICKUP, { shopDeps: { shopOverride: bad } });
      try {
        const res = await s.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
        assert.deepEqual(res, { body: { ok: true }, status: 200 });
        await s.tsp.drainWebhooks();
      } finally { s.restore(); }
    }
    // طلب كاشير (مش أونلاين): بيتسجّل وبيرجع 200 ومفيش حدث
    const s = build(PICKUP);
    try {
      const res = await s.post(hook("SOME-OTHER-POS-ORDER", "pickup_ready", "processing", 20));
      assert.equal(res.status, 200);
      await s.tsp.drainWebhooks(); await tick();
      assert.equal(s.events.length, 0);
      assert.deepEqual(s.readyPush, []);
    } finally { s.restore(); }
    // التخزين نفسه وقع ⇒ 200 برضه (ومش بنرمي)
    const s2 = build(PICKUP);
    try {
      const q = s2.db.pool.query;
      s2.db.pool.query = async (sql, vals) => { if (/INSERT INTO tsp_webhooks/.test(String(sql))) throw new Error("db down"); return q(sql, vals); };
      const res = await s2.post(hook("Gw8eTEST01", "pickup_ready", "processing", 20));
      assert.equal(res.status, 200);
      await s2.tsp.drainWebhooks();
    } finally { s2.restore(); }
    // جسم مش JSON
    const s3 = build(PICKUP);
    try {
      const webhook = s3.tsp && null;
      void webhook;
      const res = await s3.post("plain text");
      assert.equal(res.status, 200);
    } finally { s3.restore(); }
  } finally { console.error = origErr; }
});

/* ═══ ٨) الإعدادات: خانتين في اللوحة بافتراضياتهم، والكنس بيقرا الفترة كل دورة ═══ */
test("الإعدادات في اللوحة: shop.sweepSec (١٢٠، ٣٠–٦٠٠) و shop.readyNotifyGraceMin (١٠، ٠–١٢٠) بعناوين عربية ووصف", () => {
  const rows = Object.fromEntries(describeFields({}, () => "").map((f) => [f.path, f]));
  const sw = rows["shop.sweepSec"], gr = rows["shop.readyNotifyGraceMin"];
  assert.ok(sw && gr);
  assert.deepEqual([sw.effective, sw.min, sw.max, sw.type, sw.source.kind], [120, 30, 600, "int", "default"]);
  assert.deepEqual([gr.effective, gr.min, gr.max, gr.type, gr.source.kind], [10, 0, 120, "int", "default"]);
  assert.ok(/[؀-ۿ]/.test(sw.label) && /[؀-ۿ]/.test(sw.hint));
  assert.ok(/[؀-ۿ]/.test(gr.label) && /[؀-ۿ]/.test(gr.hint));
});

test("sweepSecOf: اللوحة ⇒ env احتياطي (مقصوص على المدى) ⇒ ١٢٠؛ والكنس بيعيد القراية كل دورة من غير ريستارت", async () => {
  const noEnv = () => undefined;
  assert.equal(sweepSecOf({}, noEnv), SWEEP_LIMITS.def);
  assert.equal(sweepSecOf({ shop: { sweepSec: 60 } }, noEnv), 60);
  assert.equal(sweepSecOf({ shop: { sweepSec: 5 } }, noEnv), 120, "بره المدى ⇒ الافتراضي");
  assert.equal(sweepSecOf({ shop: { sweepSec: "90" } }, noEnv), 90);
  assert.equal(sweepSecOf({}, () => "45"), 45);
  assert.equal(sweepSecOf({}, () => "5"), 30, "env أقل من الحد ⇒ الحد");
  assert.equal(sweepSecOf({}, () => "9999"), 600);
  assert.equal(sweepSecOf({ shop: { sweepSec: 300 } }, () => "45"), 300, "اللوحة بتكسب env");
  assert.equal(readyGraceMinOf({}), READY_GRACE_LIMITS.def);
  assert.equal(readyGraceMinOf({ shop: { readyNotifyGraceMin: 0 } }), 0);
  assert.equal(readyGraceMinOf({ shop: { readyNotifyGraceMin: 500 } }), 10);
  // الحي: الإعداد اتغيّر ⇒ الدورة الجاية بتقراه
  const settings = { shop: {} };
  const s = build(PICKUP, { settings });
  try {
    assert.equal(await s.shopApi.nextSweepSec(), 120);
    settings.shop.sweepSec = 45;
    assert.equal(await s.shopApi.nextSweepSec(), 45);
  } finally { s.restore(); }
});

test("readyNotifyDue (صافية): توصيل لأ، قفل من غير «جاهز» لأ، مفيش قفل أيوه، قفل جوّه المهلة أيوه، بعدها لأ، ٠ = القديم", () => {
  assert.equal(readyNotifyDue({ option: "delivery", readyAt: at(0), closedAt: null }), false);
  assert.equal(readyNotifyDue({ option: "pickup", readyAt: at(0), closedAt: at(0), readyBasis: "pos_closed" }), false);
  assert.equal(readyNotifyDue({ option: "pickup", readyAt: at(0), closedAt: null }), true);
  assert.equal(readyNotifyDue({ option: "pickup", readyAt: at(0), closedAt: at(9.9) }), true);
  assert.equal(readyNotifyDue({ option: "pickup", readyAt: at(0), closedAt: at(10.1) }), false);
  assert.equal(readyNotifyDue({ option: "pickup", readyAt: at(0), closedAt: at(25), graceMin: 30 }), true);
  assert.equal(readyNotifyDue({ option: "pickup", readyAt: at(0), closedAt: at(0.1), graceMin: 0 }), false, "٠ = أي قفل يشيل الإشعار (القديم)");
  assert.equal(readyNotifyDue({ option: "table", readyAt: at(0), closedAt: at(3) }), true);
  assert.equal(readyNotifyDue({ option: "pickup", readyAt: null, closedAt: null }), false);
});

test("readyLagTone (حالة النظام): ≤ ٥ ث أخضر، ≤ ٦٠ أصفر، فوقها أحمر، والكنس لمّ أكتر من الخُمس أصفر، ومفيش بيانات رمادي", () => {
  assert.equal(readyLagTone({ n: 0 }), "unknown");
  assert.equal(readyLagTone({ n: 10, p50: 0.8 }), "good");
  assert.equal(readyLagTone({ n: 10, p50: 12 }), "warn");
  assert.equal(readyLagTone({ n: 10, p50: 70 }), "bad");
  assert.equal(readyLagTone({ n: 10, bySweep: 3, p50: 1 }), "warn");
  assert.equal(readyLagTone({ n: 10, bySweep: 1, p50: 1 }), "good");
});
