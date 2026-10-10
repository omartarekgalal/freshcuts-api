/* معنى ضغطات الكاشير (عمر ١٠/١٠) — node --test portal-status.test.mjs

   «جاهز» = المطبخ خلّص · «تم التوصيل» على طلب توصيل = سلّم للمندوب (مش وصل
   للعميل) · وقت التحضير = القبول ← «جاهز»، تنبيه ٢٥ ومخالفة ٣٠.
   كل حاجة وهمية: مفيش قاعدة بيانات ولا شبكة ولا SMS. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  posMilestones, prepCfg, prepCheck, prepState, prepEnd, externalTooSoon, reviewDueAt, READY_TEXT, orderKind, PREP_DEFAULTS,
  prepSmsEnabled, itemsSummary,
} from "./prepstatus.js";
import { register as registerShop, DEFAULT_SLA } from "./shop.js";
import { toPortalOrder, stageLabel, pushKindForEvent, pushPayload } from "./portal-core.js";
import { statusSmsText } from "./notify.js";
import { prepBlock, prepSql, shapeReport } from "./portal-reports.js";
import { ORDER_SLA_FIELDS, FIELD_BY_PATH } from "./deliverycontrol.js";
import { slaAlertText } from "./staffalerts.js";
import { ORDER_COLUMNS } from "./orders-schema.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-09T15:00:00Z");
const at = (m) => new Date(T0 + m * MIN).toISOString();

/* ═══ ١) محطات نقطة البيع ═════════════════════════════════════════════════ */

test("posMilestones: جاهز وتم التوصيل ورا بعض في نفس الثواني — الاتنين بيتسجّلوا بوقتهم", () => {
  // الشكل الحقيقي: accepted ← (٢٥ د) ← pickup_ready ← (٦ ثواني) ← delivered/completed مرتين
  const m = posMilestones([
    { received_at: at(0), approval: "accepted", order_status: "processing" },
    { received_at: at(25), approval: "pickup_ready", order_status: "processing" },
    { received_at: new Date(T0 + 25 * MIN + 6000).toISOString(), approval: "delivered", order_status: "completed" },
    { received_at: new Date(T0 + 25 * MIN + 6100).toISOString(), approval: "delivered", order_status: "completed" },
  ]);
  assert.equal(m.acceptedAt, at(0));
  assert.equal(m.readyAt, at(25));
  assert.equal(m.readyBasis, "pos_ready");
  assert.equal(m.closedAt, new Date(T0 + 25 * MIN + 6000).toISOString());
  assert.equal(m.rejected, false);
});

test("posMilestones: الترتيب مش مضمون، وأول وقت هو اللي بيتاخد", () => {
  const m = posMilestones([
    { received_at: at(30), approval: "delivered", order_status: "completed" },
    { received_at: at(20), approval: "pickup_ready", order_status: "processing" },
    { received_at: at(22), approval: "pickup_ready", order_status: "processing" },
    { received_at: at(1), approval: "accepted", order_status: "processing" },
  ]);
  assert.deepEqual([m.acceptedAt, m.readyAt, m.closedAt], [at(1), at(20), at(30)]);
});

test("posMilestones: الكاشير قفل الطلب من غير «جاهز» ⇒ الجهوزية = وقت القفل، والأساس بيقول كده", () => {
  const m = posMilestones([
    { received_at: at(0), approval: "accepted", order_status: "processing" },
    { received_at: at(28), approval: "delivered", order_status: "completed" },
  ]);
  assert.equal(m.readyAt, at(28));
  assert.equal(m.readyBasis, "pos_closed");
});

test("posMilestones: مقبول بس / رفض / داتا بايظة", () => {
  const a = posMilestones([{ received_at: at(0), approval: "accepted", order_status: "processing" }]);
  assert.deepEqual([a.acceptedAt, a.readyAt, a.readyBasis, a.closedAt], [at(0), null, null, null]);
  const r = posMilestones([{ received_at: at(0), approval: "rejected", order_status: "cancelled" }]);
  assert.equal(r.rejected, true);
  assert.equal(r.acceptedAt, null);
  assert.deepEqual(posMilestones(null), { acceptedAt: null, readyAt: null, readyBasis: null, closedAt: null, rejected: false });
  assert.equal(posMilestones([{ received_at: "مش تاريخ", approval: "pickup_ready" }, {}, null]).readyAt, null);
  // fully_paid/order-paid لحظة الإنشاء (طلبات الشريك مدفوعة مسبقاً) مش «استلم»: الإشارة order_status=completed بس
  const p = posMilestones([{ received_at: at(0), approval: "accepted", order_status: "processing" }]);
  assert.equal(p.closedAt, null);
});

/* ═══ ٢) مهلة التحضير ═════════════════════════════════════════════════════ */

test("prepCfg: الافتراضي ٢٥/٣٠، بيتقرا من settings.delivery.sla، والتنبيه دايماً قبل الحد", () => {
  assert.deepEqual(prepCfg(), { warnMin: 25, maxMin: 30 });
  assert.deepEqual(prepCfg({ prepMinutes: 20, prepBreachMinutes: 35 }), { warnMin: 20, maxMin: 35 });
  assert.deepEqual(prepCfg({ prepMinutes: 40, prepBreachMinutes: 30 }), { warnMin: 25, maxMin: 30 });
  assert.deepEqual(prepCfg({ prepMinutes: "x", prepBreachMinutes: 0 }), { warnMin: 25, maxMin: 30 });
  assert.equal(DEFAULT_SLA.prepMinutes, PREP_DEFAULTS.prepMinutes);
  assert.equal(DEFAULT_SLA.prepBreachMinutes, 30);
});

test("prepCheck: من القبول (مش من الدفع ولا الإنشاء) — ٢٤ تمام، ٢٥ تنبيه، ٣٠ مخالفة", () => {
  const o = { status: "accepted", option: "delivery", created_at: at(-10), accepted_at: at(0) };
  assert.equal(prepCheck(o, {}, T0 + 24 * MIN).level, 0);
  const w = prepCheck(o, {}, T0 + 25 * MIN);
  assert.deepEqual([w.level, w.code, w.minutes, w.open], [1, "prep_late", 25, true]);
  const b = prepCheck(o, {}, T0 + 30 * MIN);
  assert.deepEqual([b.level, b.code, b.minutes, b.open, b.action], [2, "prep_breach", 30, true, "mark_ready"]);
  assert.equal(b.startAt, at(0));
  assert.equal(b.deadlineAt, at(30));
  assert.equal(prepCheck(o, {}, T0 + 41 * MIN).overMin, 11);
});

test("prepCheck: «جاهز» بتقفل المؤقت — جاهز عند ٢٢ د = تمام مهما الوقت عدّى بعدها", () => {
  const o = { status: "courier_assigned", option: "delivery", accepted_at: at(0), pos_ready_at: at(22) };
  const v = prepCheck(o, {}, T0 + 90 * MIN);
  assert.deepEqual([v.level, v.open, v.basis], [0, false, "ready"]);
  // جاهز متأخر = مخالفة مقفولة (بتتسجّل، من غير رسالة)
  const late = prepCheck({ ...o, pos_ready_at: at(37.5) }, {}, T0 + 90 * MIN);
  assert.deepEqual([late.level, late.code, late.open, late.overMin, late.exactMin], [2, "prep_breach", false, 7.5, 37.5]);
});

test("prepCheck: من غير «جاهز»، التسليم للمندوب / استلام المندوب / استلام العميل بينهوا التحضير", () => {
  const base = { status: "on_the_way", option: "delivery", accepted_at: at(0) };
  assert.equal(prepCheck({ ...base, handed_at: at(20) }, {}, T0 + 60 * MIN).basis, "handed");
  assert.equal(prepCheck({ ...base, picked_at: at(21) }, {}, T0 + 60 * MIN).level, 0);
  assert.equal(prepCheck({ ...base, picked_at: at(33) }, {}, T0 + 60 * MIN).code, "prep_breach");
  assert.equal(prepEnd({ handed_at: at(20), picked_at: at(24) }).basis, "handed", "الأبدر");
  assert.equal(prepEnd({ pos_ready_at: at(26), handed_at: at(20) }).basis, "ready", "«جاهز» هي المرجع لو موجودة");
  assert.equal(prepCheck({ status: "delivered", option: "pickup", accepted_at: at(0), collected_at: at(19) }, {}, T0 + 60 * MIN).basis, "collected");
});

test("prepCheck: من غير وقت قبول مفيش حكم، والطلب المقفول من غير أي إشارة مابنخترعلوش رقم", () => {
  assert.equal(prepCheck({ status: "accepted" }, {}, T0).level, 0);
  assert.equal(prepCheck({ status: "accepted" }, {}, T0).startAt, null);
  const closed = prepCheck({ status: "delivered", accepted_at: at(0) }, {}, T0 + 500 * MIN);
  assert.deepEqual([closed.level, closed.minutes], [0, null]);
  // وقت «جاهز» قبل القبول (حصل في الإنتاج) — مش مخالفة ومش رقم سالب
  assert.equal(prepCheck({ status: "accepted", accepted_at: at(10), pos_ready_at: at(5) }, {}, T0 + 60 * MIN).level, 0);
});

test("prepCheck: الطلب المسبق — المهلة من موعده مش من قبوله امبارح", () => {
  const o = { status: "accepted", option: "delivery", accepted_at: at(-600), scheduled_for: at(0) };
  assert.equal(prepCheck(o, {}, T0 + 10 * MIN).level, 0);
  assert.equal(prepCheck(o, {}, T0 + 31 * MIN).code, "prep_breach");
});

test("prepState: بداية ونهاية ثابتين للكارت (المؤقت الحي في المتصفح)", () => {
  assert.equal(prepState({}), null);
  assert.deepEqual(prepState({ accepted_at: at(0) }), { startAt: at(0), endAt: null, basis: null, minutes: null, warnMin: 25, maxMin: 30, late: false });
  const s = prepState({ accepted_at: at(0), pos_ready_at: at(31) }, { warnMin: 20, maxMin: 30 });
  assert.deepEqual([s.minutes, s.late, s.basis, s.warnMin], [31, true, "ready", 20]);
});

/* ═══ ٣) الكنس: الضغطتين بيتسجّلوا، والتوصيل مابيتقالش «اتوصّل» ══════════ */

const jb = (v) => JSON.stringify(v);
const normPhone = (p) => String(p || "").replace(/\D/g, "").slice(-9);
function fakeApp() {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}
function build({ handler = () => null, settings = {}, deps = {} } = {}) {
  const prev = process.env.SHOP_SWEEP_SECONDS;
  process.env.SHOP_SWEEP_SECONDS = "0";
  const prevTsp = process.env.TSP_AUTO_ORDER; delete process.env.TSP_AUTO_ORDER;
  const queries = [], events = [], readyPush = [], sms = [];
  const pool = { query: async (sql, vals) => { queries.push({ sql: String(sql), vals }); return (await handler(String(sql), vals)) || { rows: [], rowCount: 0 }; } };
  const api = registerShop(fakeApp(), {
    pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => settings, jb, normPhone,
  }, {
    pay: { configured: () => true },
    delivery: { quote: async () => ({}), shipmentOf: async () => null, cancelShipment: async () => null,
      dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
    notify: { orderStatusChanged: async (no, st) => { sms.push([no, st]); }, orderReady: async (no) => { readyPush.push(no); return 1; } },
    emitOrder: (name, opts) => { events.push({ name, ...opts }); },
    ...deps,
  });
  const restore = () => {
    if (prev === undefined) delete process.env.SHOP_SWEEP_SECONDS; else process.env.SHOP_SWEEP_SECONDS = prev;
    if (prevTsp !== undefined) process.env.TSP_AUTO_ORDER = prevTsp;
  };
  return { api, queries, events, readyPush, sms, restore };
}
const tick = () => new Promise((r) => setImmediate(r));
const hooks = (ready, closed) => [
  { received_at: at(0), approval: "accepted", order_status: "processing" },
  ...(ready != null ? [{ received_at: at(ready), approval: "pickup_ready", order_status: "processing" }] : []),
  ...(closed != null ? [{ received_at: at(closed), approval: "delivered", order_status: "completed" }] : []),
];

test("الكنس (توصيل): «جاهز» + «تم التوصيل» في نفس الدقيقة ⇒ pos_ready_at و handed_at بوقتهم، والحالة ماتتغيرش لـdelivered", async () => {
  const s = build({
    handler: (sql) => {
      if (/pos_ready_at IS NULL\s+OR \(option='delivery'/.test(sql)) {
        return { rows: [{ order_no: "W1", pos_order_id: "88", branch_id: "1", option: "delivery", pos_ready_at: null, handed_at: null, handed_source: null }] };
      }
      if (/FROM tsp_webhooks/.test(sql)) return { rows: hooks(26, 26.1) };
      if (/SET pos_ready_at = \$2::timestamptz/.test(sql) || /SET handed_at = LEAST/.test(sql)) return { rows: [], rowCount: 1 };
      return null;
    },
  });
  try {
    await s.api.sweep(); await tick();
    const ready = s.queries.find((q) => /SET pos_ready_at = \$2::timestamptz/.test(q.sql));
    assert.deepEqual(ready.vals.slice(0, 3), ["W1", at(26), "pos_ready"]);
    const handed = s.queries.find((q) => /SET handed_at = LEAST/.test(q.sql));
    assert.deepEqual(handed.vals, ["W1", at(26.1)]);
    assert.match(handed.sql, /handed_source = 'pos'/);
    assert.match(handed.sql, /handed_at IS NULL OR handed_source = 'courier'/, "ضغطة البوابة مابتتمسحش");
    const act = s.events.filter((e) => e.name === "staff_action");
    assert.deepEqual(act.map((e) => [e.orderNo, e.data.action, e.data.via, e.data.at]), [["W1", "handed_to_courier", "pos", at(26.1)]]);
    assert.equal(s.events.filter((e) => e.name === "pos_ready").length, 1);
    // أهم سطر: العميل مايتقالوش «تم التوصيل» من ضغطة الكاشير
    assert.equal(s.queries.some((q) => /SET status=\$2/.test(q.sql)), false);
    assert.deepEqual(s.sms, []);
    assert.deepEqual(s.readyPush, [], "التوصيل مالوش إشعار «جاهز» — العميل بيسمع من المندوب");
  } finally { s.restore(); }
});

test("الكنس (توصيل): نافذة المراقبة فيها delivered لآخر ٣ ساعات والطلبات اللي تسليمها متسجّل من المندوب بس", async () => {
  const s = build();
  try {
    await s.api.sweep();
    const q = s.queries.find((x) => /pos_ready_at IS NULL\s+OR \(option='delivery'/.test(x.sql));
    assert.ok(q);
    assert.match(q.sql, /status='delivered' AND option='delivery' AND updated_at > NOW\(\) - INTERVAL '3 hours'/);
    assert.match(q.sql, /'handed_source','courier'\) = 'courier'/);
    assert.match(q.sql, /'on_the_way'/);
  } finally { s.restore(); }
});

test("الكنس (استلام): «جاهز» من غير قفل ⇒ إشعار «طلبك جاهز» مرة واحدة؛ والقفل ⇒ collected_at + delivered بوقت الضغط", async () => {
  // أ) جاهز بس
  let s = build({
    handler: (sql) => {
      if (/pos_ready_at IS NULL\s+OR \(option='delivery'/.test(sql)) return { rows: [{ order_no: "P1", pos_order_id: "7", branch_id: "1", option: "pickup", pos_ready_at: null }] };
      if (/FROM tsp_webhooks/.test(sql)) return { rows: hooks(18, null) };
      if (/SET pos_ready_at = \$2::timestamptz/.test(sql)) return { rows: [], rowCount: 1 };
      return null;
    },
  });
  try {
    await s.api.sweep(); await tick();
    assert.deepEqual(s.readyPush, ["P1"]);
    assert.equal(s.queries.some((q) => /SET handed_at/.test(q.sql)), false, "الاستلام مالوش تسليم مندوب");
    assert.equal(s.queries.some((q) => /SET status=\$2/.test(q.sql)), false, "«جاهز» مش «استلم»");
  } finally { s.restore(); }

  // ب) جاهز + قفل في نفس اللحظة (اللي بيحصل فعلاً): «استلمت طلبك» بس، من غير إشعار «جاهز» قبلها بثانية
  s = build({
    handler: (sql) => {
      if (/pos_ready_at IS NULL\s+OR \(option='delivery'/.test(sql)) return { rows: [{ order_no: "P2", pos_order_id: "8", branch_id: "1", option: "pickup", pos_ready_at: null }] };
      if (/WHERE option='pickup' AND pos_order_id IS NOT NULL/.test(sql)) return { rows: [{ order_no: "P2", pos_order_id: "8" }] };
      if (/FROM tsp_webhooks/.test(sql)) return { rows: hooks(22, 22.2) };
      if (/SET pos_ready_at = \$2::timestamptz/.test(sql)) return { rows: [], rowCount: 1 };
      return null;
    },
  });
  try {
    await s.api.sweep(); await tick();
    assert.deepEqual(s.readyPush, []);
    const close = s.queries.find((q) => /collected_at = COALESCE\(collected_at, \$4::timestamptz\)/.test(q.sql));
    assert.deepEqual(close.vals, ["P2", at(22), "pos_ready", at(22.2)]);
    const st = s.queries.find((q) => /SET status=\$2/.test(q.sql));
    assert.equal(st.vals[1], "delivered");
    assert.deepEqual(s.sms, [["P2", "delivered"]]);
  } finally { s.restore(); }
});

test("الكنس (القبول): accepted_at = وقت ضغطة الكاشير (الويبهوك) مش وقت الكنس", async () => {
  const s = build({
    handler: (sql) => {
      if (/WHERE status='pos_created' AND pos_order_id IS NOT NULL/.test(sql)) {
        return { rows: [{ order_no: "W9", branch_id: "1", pos_order_id: "55", option: "delivery", total: 80, pos_ready_at: null }] };
      }
      if (/jsonb_build_object\('statuses_slugs'/.test(sql)) return { rows: [{ payload: { resource: { statuses_slugs: { approval_status: "accepted" } } } }] };
      if (/approval_status' AS approval/.test(sql)) return { rows: hooks(null, null) };
      return null;
    },
  });
  try {
    await s.api.sweep(); await tick();
    const acc = s.queries.find((q) => /SET accepted_at = COALESCE\(accepted_at, \$2::timestamptz\)/.test(q.sql));
    assert.deepEqual(acc.vals, ["W9", at(0)]);
    const st = s.queries.find((q) => /SET status=\$2/.test(q.sql));
    assert.equal(st.vals[1], "accepted");
    assert.match(st.sql, /accepted_at = COALESCE\(accepted_at, NOW\(\)\)/, "حزام تاني جوّه setStatus");
    assert.ok(s.queries.indexOf(acc) < s.queries.indexOf(st), "وقت الويبهوك بيتكتب الأول فـCOALESCE يحافظ عليه");
  } finally { s.restore(); }
});

test("المندوب استلم ومحدش سجّل التسليم ⇒ handed_at = وقت استلامه (مصدر courier)، ولو متسجّل مابيتلمسش", async () => {
  let row = { order_no: "W1", status: "courier_assigned", option: "delivery", handed_at: null };
  const s = build({ handler: (sql) => (/SELECT \* FROM shop_orders WHERE order_no=\$1/.test(sql) ? { rows: [row] } : null) });
  try {
    await s.api.onShipmentEvent("W1", "picked", {});
    const q = s.queries.find((x) => /handed_source = 'courier'/.test(x.sql));
    assert.ok(q);
    assert.match(q.sql, /WHERE order_no = \$1 AND handed_at IS NULL/);
    assert.match(q.sql, /s\.picked_at/);
    assert.equal(s.queries.find((x) => /SET status=\$2/.test(x.sql)).vals[1], "on_the_way");
    s.queries.length = 0;
    row = { ...row, handed_at: at(5) };
    await s.api.onShipmentEvent("W1", "picked", {});
    assert.equal(s.queries.some((x) => /handed_source = 'courier'/.test(x.sql)), false);
  } finally { s.restore(); }
});

/* ═══ ٤) الحارس: تنبيه ٢٥ + مخالفة ٣٠ ═══════════════════════════════════ */

function prepRows(rows) {
  return (sql) => {
    if (/AS picked_at\s+FROM shop_orders o/.test(sql)) return { rows };
    return null;
  };
}

test("prepWatch: ٢٦ د ⇒ تنبيه درجة ١ من غير SMS ومن غير صف مخالفة", async () => {
  const sent = [];
  const realNow = Date.now;
  const s = build({ handler: prepRows([{ order_no: "W1", status: "courier_assigned", option: "delivery", is_test: false, alerts: {},
    accepted_at: new Date(realNow() - 26 * MIN).toISOString() }]) });
  try {
    await s.api.prepWatch({});
    await tick();
    const ev = s.events.filter((e) => e.name === "sla_alert");
    assert.deepEqual(ev.map((e) => [e.orderNo, e.data.code, e.data.level, e.data.notified]), [["W1", "prep_late", 1, false]]);
    assert.equal(s.queries.some((q) => /INSERT INTO shop_prep_breaches/.test(q.sql)), false);
    const mark = s.queries.find((q) => /SET alerts = COALESCE/.test(q.sql));
    assert.deepEqual(Object.keys(JSON.parse(mark.vals[1])), ["prep_late:1"]);
    assert.deepEqual(sent, []);
  } finally { s.restore(); }
});

test("prepWatch: ٣١ د ولسه مفتوح ⇒ مخالفة علينا: صف + sla_alert درجة ٢ (إشعار البوابة)، ومرة واحدة بس", async () => {
  const acc = new Date(Date.now() - 31 * MIN).toISOString();
  const sent = [];
  const s = build({
    settings: { delivery: { alertPhones: ["0544775082"] } },
    handler: prepRows([{ order_no: "W2", status: "accepted", option: "pickup", table_no: null, is_test: false, alerts: {}, accepted_at: acc }]),
  });
  try {
    await s.api.prepWatch({ delivery: { alertPhones: ["0544775082"] } });
    await tick();
    const ins = s.queries.find((q) => /INSERT INTO shop_prep_breaches/.test(q.sql));
    assert.ok(ins);
    assert.deepEqual([ins.vals[0], ins.vals[1], ins.vals[4], ins.vals[8], ins.vals[9]], ["W2", "pickup", null, 30, false]);
    assert.equal(new Date(ins.vals[3]).getTime() - new Date(ins.vals[2]).getTime(), 30 * MIN, "الحد = القبول + ٣٠ د");
    assert.match(ins.sql, /WHERE shop_prep_breaches\.ready_at IS NULL/, "بيتحدّث لحد ما «جاهز» تتسجّل وبعدين يتقفل");
    const ev = s.events.filter((e) => e.name === "sla_alert");
    assert.deepEqual(ev.map((e) => [e.data.code, e.data.level, e.data.notified, e.data.action]), [["prep_breach", 2, true, "mark_ready"]]);
    assert.ok(s.queries.some((q) => /UPDATE shop_prep_breaches SET alerted_at = NOW\(\)/.test(q.sql)));
    void sent;
  } finally { s.restore(); }

  // اتبعت قبل كده ⇒ مفيش إنذار تاني (بس صف المخالفة بيتحدّث)
  const s2 = build({ handler: prepRows([{ order_no: "W2", status: "accepted", option: "pickup", is_test: false,
    alerts: { "prep_breach:2": "x", "prep_late:1": "x" }, accepted_at: acc }]) });
  try {
    await s2.api.prepWatch({});
    assert.equal(s2.events.filter((e) => e.name === "sla_alert").length, 0);
    assert.ok(s2.queries.some((q) => /INSERT INTO shop_prep_breaches/.test(q.sql)));
  } finally { s2.restore(); }
});

test("prepWatch: اتأخر واتسجّل «جاهز» قبل ما نشوفه ⇒ مخالفة متسجّلة من غير رسالة؛ وجاهز في الوقت ⇒ ولا حاجة؛ والقديم بعد نشر مايبعتش", async () => {
  const now = Date.now();
  const iso = (m) => new Date(now - m * MIN).toISOString();
  const s = build({ handler: prepRows([
    { order_no: "L1", status: "on_the_way", option: "delivery", is_test: false, alerts: {}, accepted_at: iso(60), pos_ready_at: iso(22) },   // ٣٨ د — مخالفة مقفولة
    { order_no: "OK", status: "on_the_way", option: "delivery", is_test: false, alerts: {}, accepted_at: iso(60), pos_ready_at: iso(40) },   // ٢٠ د — تمام
    { order_no: "Y1", status: "delivered", option: "pickup", is_test: false, alerts: {}, accepted_at: iso(60), pos_ready_at: iso(33) },      // ٢٧ د واتقفل — أصفر، مش مخالفة
    { order_no: "OLD", status: "courier_cancelled", option: "delivery", is_test: false, alerts: {}, accepted_at: iso(300) },                 // مفتوح من ٥ ساعات (بعد نشر)
    { order_no: "T1", status: "accepted", option: "delivery", is_test: true, alerts: {}, accepted_at: iso(31) },                              // طلب اختبار
  ]) });
  try {
    await s.api.prepWatch({});
    await tick();
    const ins = s.queries.filter((q) => /INSERT INTO shop_prep_breaches/.test(q.sql)).map((q) => q.vals[0]);
    assert.deepEqual(ins.sort(), ["L1", "OLD", "T1"]);
    const l1 = s.queries.find((q) => /INSERT INTO shop_prep_breaches/.test(q.sql) && q.vals[0] === "L1");
    assert.deepEqual([l1.vals[5], l1.vals[6], l1.vals[7]], ["ready", 38, 8]);
    assert.deepEqual(s.events.filter((e) => e.name === "sla_alert"), [], "ولا رنّة في البوابة لمخالفة مقفولة/قديمة/اختبار");
    // بس بتتعلّم على الطلب (التقارير بتعدّها) ومابتتكررش
    const marks = s.queries.filter((q) => /SET alerts = COALESCE/.test(q.sql)).map((q) => q.vals[0]).sort();
    assert.deepEqual(marks, ["L1", "OLD", "T1"]);
    assert.equal(s.queries.some((q) => /SET alerted_at = NOW\(\)/.test(q.sql)), false, "ولا رسالة للإدارة");
  } finally { s.restore(); }
});

test("prepWatch: الاستعلام بيسيب اللي لسه ما اتقبلش، وبيلحق الطلب اللي اتقفل من أقل من ٣٠ د", async () => {
  const s = build();
  try {
    await s.api.prepWatch({});
    const q = s.queries.find((x) => /AS picked_at\s+FROM shop_orders o/.test(x.sql));
    assert.match(q.sql, /'pos_created'/);
    assert.match(q.sql, /o\.status <> 'delivered' OR o\.updated_at > NOW\(\) - INTERVAL '30 minutes'/);
    assert.match(q.sql, /o\.scheduled_for IS NULL OR o\.scheduled_for <= NOW\(\)/);
  } finally { s.restore(); }
});

test("رسالة الإدارة لمخالفة التحضير: جزء واحد بالإنجليزي والعربي", () => {
  const en = slaAlertText("W1791632212804", { code: "prep_breach", minutes: 31 }, "en");
  assert.match(en, /kitchen prep 31min since acceptance/);
  assert.ok(en.length <= 160 && /^[\x20-\x7e\n]+$/.test(en), en);
  const ar = slaAlertText("W1791632212804", { code: "prep_breach", minutes: 31 }, "ar");
  assert.ok(ar.length <= 70, `${ar.length}: ${ar}`);
});

/* ═══ ٥) البوابة ═════════════════════════════════════════════════════════ */

const row = (over = {}) => ({
  order_no: "W1", status: "courier_assigned", option: "delivery", customer: { name: "أحمد" }, phone_norm: "512345678",
  items: [], total: 80, subtotal: 60, delivery_fee: 20, history: [{ status: "accepted", at: at(0) }], alerts: {},
  created_at: at(-3), updated_at: at(2), ...over,
});

test("toPortalOrder: handedAt/handedBy/handedSource + collectedAt + prep (من القبول)", () => {
  const o = toPortalOrder(row({ accepted_at: at(0), pos_ready_at: at(24), handed_at: at(24.2), handed_source: "pos" }), {}, T0 + 26 * MIN);
  assert.equal(o.handedAt, at(24.2));
  assert.equal(o.handedSource, "pos");
  assert.equal(o.handedBy, null);
  assert.deepEqual(o.prep, { startAt: at(0), endAt: at(24), basis: "ready", minutes: 24, warnMin: 25, maxMin: 30, late: false });
  // accepted_at فاضي (طلبات قبل النشر) ⇒ من history
  assert.equal(toPortalOrder(row(), {}, T0 + 5 * MIN).prep.startAt, at(0));
});

test("toPortalOrder: التحضير المفتوح اللي عدّى الحد بيبان مشكلة على الكارت (sla درجة ٢)، والمقفول لأ", () => {
  const open = toPortalOrder(row({ accepted_at: at(0) }), {}, T0 + 31 * MIN);
  assert.deepEqual([open.sla.level, open.sla.code], [2, "prep_breach"]);
  const warn = toPortalOrder(row({ accepted_at: at(0) }), {}, T0 + 26 * MIN);
  assert.deepEqual([warn.sla.level, warn.sla.code], [1, "prep_late"]);
  const closed = toPortalOrder(row({ accepted_at: at(0), pos_ready_at: at(35), updated_at: at(35) }), {}, T0 + 36 * MIN);
  assert.notEqual(closed.sla.code, "prep_breach");
  assert.equal(closed.prep.late, true);
  // الحدّين من الإعدادات
  const custom = toPortalOrder(row({ accepted_at: at(0) }), { prepMinutes: 10, prepBreachMinutes: 15 }, T0 + 16 * MIN);
  assert.equal(custom.sla.code, "prep_breach");
});

test("stageLabel: delivered مابقتش «تم التوصيل» لكل حاجة", () => {
  assert.equal(stageLabel({ status: "delivered", option: "delivery" }), "وصل للعميل");
  assert.equal(stageLabel({ status: "delivered", option: "pickup" }), "العميل استلم");
  assert.equal(stageLabel({ status: "delivered", option: "pickup", table_no: 4 }), "اتقدّم على الطاولة");
  assert.equal(stageLabel({ status: "delivered" }), "اتسلّم للعميل");
  assert.equal(stageLabel({ status: "courier_assigned", option: "delivery", handed_at: at(1) }), "سُلّم للمندوب — مستنيين تأكيده");
  assert.equal(stageLabel({ status: "courier_assigned", option: "delivery" }), "الكابتن جاي للمطعم");
});

/* ═══ ٦) العميل ══════════════════════════════════════════════════════════ */

test("رسالة النهاية بتقول اللي حصل: توصيل / استلام / طاولة — ومفيش «تم توصيل» لطلب استلام", () => {
  assert.match(statusSmsText("delivered", { order_no: "W1", option: "delivery" }), /تم توصيل طلبك/);
  // نص الاستلام/الطاولة من شريحة ١٣ (رسايل العميل): من غير كلمة «توصيل»
  const p = statusSmsText("delivered", { order_no: "W1", option: "pickup" });
  assert.match(p, /بالهنا والشفا/);
  assert.doesNotMatch(p, /توصيل/);
  assert.doesNotMatch(statusSmsText("delivered", { order_no: "W1", option: "pickup", table_no: 3 }), /توصيل/);
});

/* ═══ قرار عمر (١٠/١٠ مساءً): مخالفة التحضير = إشعار بوابة بالتفاصيل وبصوت، مش SMS ═══ */
test("مخالفة التحضير: الـSMS مقفول افتراضياً وبيتفتح من اللوحة بس", async () => {
  assert.equal(prepSmsEnabled({}), false);
  assert.equal(prepSmsEnabled({ delivery: {} }), false);
  assert.equal(prepSmsEnabled({ delivery: { prepBreachSms: "true" } }), false, "true الصريحة بس");
  assert.equal(prepSmsEnabled({ delivery: { prepBreachSms: true } }), true);
  const f = FIELD_BY_PATH["delivery.prepBreachSms"];
  assert.equal(f.type, "bool");
  assert.equal(f.group, "alerts");
  // الحارس: المخالفة الحيّة بتطلّع حدث البوابة (notified) من غير ما تلمس مرسل الـSMS
  const src = (await import("node:fs")).readFileSync(new URL("./shop.js", import.meta.url), "utf8");
  assert.match(src, /if \(prepSmsEnabled\(settings\)\) \{\s+staff\.critical\(\(lang\) => slaAlertText\(row\.order_no, v, lang\), `prep /);
});

test("إشعار البوابة «تحضير متأخر»: نوع لوحده بتفاصيل الطلب، مرة واحدة لكل طلب، وبيفضل على الشاشة بصوت", () => {
  const k = pushKindForEvent({ orderNo: "W1", name: "sla_alert", data: { code: "prep_breach", level: 2 } });
  assert.deepEqual(k, { kind: "prep", key: "prep_breach" });
  // التنبيه الأصفر (٢٥ د) مابيرنّش، وباقي المخالفات زي ما هي
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "sla_alert", data: { code: "prep_late", level: 1 } }), null);
  assert.equal(pushKindForEvent({ orderNo: "W1", name: "sla_alert", data: { code: "pickup_breach", level: 2 } }).kind, "sla");
  const p = pushPayload("prep", { orderNo: "W1791632212804", customerName: "أحمد", option: "delivery", minutes: 31,
    itemsSummary: "2× مشاوي مشكل، رز بخاري", itemsCount: 3 }, "https://x/portal/");
  assert.match(p.title, /تحضير متأخر/);
  assert.match(p.title, /31 د من القبول/);
  assert.match(p.title, /W1791632212804/);
  assert.match(p.body, /أحمد/);
  assert.match(p.body, /توصيل/);
  assert.match(p.body, /2× مشاوي مشكل، رز بخاري/);
  assert.equal(p.requireInteraction, true, "الـservice worker بيعامل requireInteraction كإشعار مهم: صوت + اهتزاز");
  assert.equal(p.urgency, "high");
  assert.match(p.url, /#order=W1791632212804$/);
  assert.match(pushPayload("prep", { orderNo: "W2", option: "pickup", tableNo: 4, minutes: 33, itemsCount: 2 }, "").body, /طاولة 4/);
  assert.match(pushPayload("prep", { orderNo: "W3", option: "pickup", minutes: 30 }, "").body, /استلام/);
  // ملخص الأصناف: عناوين الأصناف والباقات بس (من غير مكوّنات الباقة)، وبحد أقصى
  assert.equal(itemsSummary([{ name: "مشاوي مشكل", qty: 2, kind: "item" }, { name: "باقة العيلة", qty: 1, kind: "bundle" },
    { name: "رز", qty: 1, kind: "component" }, { name: "سلطة", qty: 1 }, { name: "عصير", qty: 3 }, { name: "خبز", qty: 1 }]),
    "2× مشاوي مشكل، باقة العيلة، سلطة +2");
  assert.equal(itemsSummary(null), "");
});

test("«طلبك جاهز»: للاستلام والطاولة بس، بلهجة بيضاء", () => {
  assert.equal(orderKind({ option: "delivery" }), "delivery");
  assert.equal(orderKind({ option: "pickup", table_no: 2 }), "table");
  assert.equal(READY_TEXT.delivery, undefined);
  assert.match(READY_TEXT.pickup({ order_no: "W1" }), /جاهز للاستلام من الفرع/);
  assert.match(READY_TEXT.table({ order_no: "W1", table_no: 7 }), /الطاولة 7/);
  for (const f of [READY_TEXT.pickup({ order_no: "W1" }), READY_TEXT.table({ order_no: "W1", table_no: 7 })]) {
    assert.doesNotMatch(f, /بنجهّز|هيتقدّم|دلوقتي|عشان|مستني/, "مفيش مصري تقيل في نص العميل");
  }
});

test("المندوب الخارجي: «العميل استلم» بدري قوي بتطلب تأكيد", () => {
  const picked = at(0);
  assert.equal(externalTooSoon({ pickedAt: picked, expectedMin: 20, now: T0 + 1 * MIN }).tooSoon, true);
  assert.equal(externalTooSoon({ pickedAt: picked, expectedMin: 20, now: T0 + 9.9 * MIN }).tooSoon, true);
  assert.equal(externalTooSoon({ pickedAt: picked, expectedMin: 20, now: T0 + 10 * MIN }).tooSoon, false);
  assert.equal(externalTooSoon({ pickedAt: picked, expectedMin: null, now: T0 + 4 * MIN }).minGap, 5, "أقل حاجة ٥ د");
  assert.equal(externalTooSoon({ pickedAt: null, now: T0 }).tooSoon, false);
});

test("دعوة التقييم: نص ساعة بعد الاستلام الحقيقي", () => {
  const d = (x) => Math.round((x.getTime() - T0) / MIN);
  // لاجلك أكّدت التوصيل ⇒ +٣٠ بالظبط
  assert.equal(d(reviewDueAt({ deliveredAt: at(50), askAfterMin: 30, option: "delivery" })), 80);
  // خارجي والمدير ضغط «استلم» و«وصّل» ورا بعض: مش قبل (الاستلام + ٣٠ مشوار + ٣٠)
  assert.equal(d(reviewDueAt({ deliveredAt: at(21), askAfterMin: 30, option: "delivery", pickedAt: at(20), courierConfirmed: false })), 80);
  // خارجي وأكّد من رابطه ⇒ عادي
  assert.equal(d(reviewDueAt({ deliveredAt: at(21), askAfterMin: 30, option: "delivery", pickedAt: at(20), courierConfirmed: true })), 51);
  // خارجي واتأخر فعلاً ⇒ من وقت التوصيل
  assert.equal(d(reviewDueAt({ deliveredAt: at(90), askAfterMin: 30, option: "delivery", pickedAt: at(20), courierConfirmed: false })), 120);
  // الاستلام: مش قبل ساعة من الطلب (زي الأول)
  assert.equal(d(reviewDueAt({ deliveredAt: at(15), askAfterMin: 30, option: "pickup", createdAt: at(0) })), 60);
  assert.equal(d(reviewDueAt({ deliveredAt: at(50), askAfterMin: 30, option: "pickup", createdAt: at(0) })), 80);
});

/* ═══ ٧) التقارير والإعدادات ═════════════════════════════════════════════ */

test("تقرير وقت التحضير: من القبول لـ«جاهز»، وعدّ اللي عدّى ٣٠ واللي مالوش إشارة", () => {
  const b = prepBlock([
    { option: "delivery", accepted: 66, measured: 65, over: 18, warn: 16, median: 25.6, p90: 37.1, max: 63.5 },
    { option: "pickup", accepted: 15, measured: 15, over: 5, warn: 1, median: 22.3, p90: 48, max: 102.8 },
  ], 25, 30);
  assert.deepEqual([b.accepted, b.measured, b.noSignal, b.over, b.onTime, b.warn], [81, 80, 1, 23, 57, 17]);
  assert.equal(b.overPct, 28.7);
  assert.equal(b.limitMin, 30);
  assert.equal(b.maxMin, 102.8);
  assert.equal(b.medianMin, null, "وسيط نوعين مش وسيط واحد — بيتعرض لكل نوع");
  assert.deepEqual([b.byOption.delivery.medianMin, b.byOption.delivery.overPct, b.byOption.pickup.over], [25.6, 27.7, 5]);
  assert.equal(prepBlock([], 25, 30).overPct, null);
  const sql = prepSql(25, 30);
  assert.match(sql, /pos_ready_at - accepted_at/);
  assert.match(sql, /mins >= 30/);
  assert.match(sql, /mins >= 25 AND mins < 30/);
  assert.doesNotMatch(sql, /created_at\)\)\/60/, "مش من وقت الطلب");
  assert.match(prepSql("x; DROP", null), /mins >= 30/, "الأرقام بس");
  const r = shapeReport({ range: { from: "2026-10-01", to: "2026-10-02", days: 2 }, prep: [{ option: "delivery", accepted: 2, measured: 2, over: 1, warn: 0, median: 28, p90: 33, max: 33 }] });
  assert.equal(r.prep.over, 1);
  assert.equal(r.prep.medianMin, 28);
  for (const k of ["ready_to_handed", "accepted_to_handed", "arrived_to_handed", "accepted_to_ready"]) assert.ok(r.times[k], k);
});

test("الحدّين بيتعدّلوا من لوحة التحكم، وأعمدة التسليم موجودة في الترحيل", () => {
  const keys = ORDER_SLA_FIELDS.map((f) => f[0]);
  assert.ok(keys.includes("prepMinutes") && keys.includes("prepBreachMinutes"));
  assert.equal(FIELD_BY_PATH["delivery.sla.prepBreachMinutes"].fallback, 30);
  assert.equal(FIELD_BY_PATH["delivery.sla.prepMinutes"].fallback, 25);
  for (const [k] of ORDER_SLA_FIELDS) assert.ok(k in DEFAULT_SLA, `${k} له افتراضي في DEFAULT_SLA`);
  const cols = Object.fromEntries(ORDER_COLUMNS.map((c) => [c.name, c.type]));
  assert.deepEqual([cols.handed_at, cols.handed_source, cols.handed_by], ["TIMESTAMPTZ", "TEXT", "TEXT"]);
});
