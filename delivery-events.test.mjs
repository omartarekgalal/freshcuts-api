/* ═══════════════════════════════════════════════════════════════════════════
   أحداث المندوب على ناقل الطلب (W1-05، الخطة §٤-١)

     courier_dispatch  ← dispatch()        (نجاح وفشل، والفشل لسه بيرمي)
     courier_update    ← pollInFlight()    لما الحالة أو الكابتن يتغيّر بس
     courier_update    ← راوت الويبهوك     (source = courier_webhook)
     courier_manual    ← manualEvent()
     courier_cancel    ← cancelShipment()

   ومفيش تغيير في اللي بيتبعت للمندوب، والحدث عمره ما يرمي في وش اللي نادى.

     node --test delivery-events.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

import { register as registerDelivery, driverKey, driverChanged } from "./delivery.js";
import { PROVIDERS } from "./couriers.js";
import { bus, CHANNEL } from "./order-events.js";

const jb = (v) => JSON.stringify(v);

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

/* بيبدّل دوال مزوّد لاجلك مؤقتاً — مفيش أي اتصال شبكة حقيقي. */
function patchProvider(id, patch) {
  const p = PROVIDERS[id];
  const prev = {};
  for (const k of Object.keys(patch)) { prev[k] = p[k]; p[k] = patch[k]; }
  return () => { for (const k of Object.keys(prev)) p[k] = prev[k]; };
}

function capture() {
  const events = [];
  const fn = (e) => events.push(e);
  bus.on(CHANNEL, fn);
  return { events, stop: () => bus.off(CHANNEL, fn) };
}

function build({ settings, shipment = null, pollRows = [], updRows = 1 } = {}) {
  const restoreEnv = setEnv({
    FA_POLL_MINUTES: "0", DELIVERY_FORCE_MANUAL: undefined, DELIVERY_DISPATCH_MODE: undefined,
    LEAJLAK_WEBHOOK_SECRET: undefined,
  });
  const routes = {};
  const app = {
    get(p, h) { routes[`GET ${p}`] = h; }, post(p, h) { routes[`POST ${p}`] = h; },
    put(p, h) { routes[`PUT ${p}`] = h; }, delete(p, h) { routes[`DELETE ${p}`] = h; },
  };
  const sql = [];
  const pool = {
    query: async (s, vals) => {
      s = String(s);
      sql.push({ s, vals });
      if (/count\(\*\)::int AS n FROM dl_policies/i.test(s)) return { rows: [{ n: 1 }], rowCount: 1 };
      if (/SELECT \* FROM dl_shipments WHERE shop_order_no/i.test(s)) {
        return { rows: shipment ? [shipment] : [], rowCount: shipment ? 1 : 0 };
      }
      if (/SELECT id, shop_order_no, provider, provider_ref, status, driver FROM dl_shipments/i.test(s)) {
        return { rows: pollRows, rowCount: pollRows.length };
      }
      if (/INSERT INTO dl_shipments\(shop_order_no, provider, provider_ref, status, driver, cost, dispatch, events\)/i.test(s)) {
        return { rows: [{ id: 9, shop_order_no: vals[0], provider: "manual", status: vals[2] }], rowCount: 1 };
      }
      if (/UPDATE dl_shipments SET\s+status=\$2,\s+provider_ref/i.test(s)) {
        return { rows: [{ ...(shipment || {}), status: vals[1] }], rowCount: 1 };
      }
      if (/UPDATE dl_shipments SET\s+status = COALESCE/i.test(s)) {
        return updRows
          ? { rows: [{ id: 1, shop_order_no: vals[0] || "W1", status: vals[1] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const shipmentEvents = [];
  const api = registerDelivery(app,
    { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb },
    { shop: () => ({ onShipmentEvent: async (no, st) => { shipmentEvents.push([no, st]); } }) });
  return { api, routes, sql, shipmentEvents, restoreEnv };
}

const AUTO_LJ = { delivery: { provider: "leajlak", dispatchMode: "auto" } };
const PHONE = "0551234567";
const noPhone = (events) => {
  for (const e of events) assert.ok(!/5\d{8}/.test(JSON.stringify(e)), `رقم جوال في الحدث ${e.name}`);
};

/* ── driverKey / driverChanged ─────────────────────────────────────────── */

test("driverKey: الهوية مش الموقع", () => {
  assert.equal(driverKey(null), null);
  assert.equal(driverKey({}), null);
  assert.equal(driverKey({ id: 7, lat: 1 }), "id:7");
  assert.equal(driverKey({ id: 7, lat: 1 }), driverKey(JSON.stringify({ id: 7, lat: 2 })));
  assert.equal(driverChanged({ id: 7, lat: 1 }, { id: 7, lat: 2 }), false);
  assert.equal(driverChanged(null, { name: "Ali", phone: PHONE }), true);
  assert.equal(driverChanged({ name: "Ali", phone: PHONE }, { name: "Ali", phone: PHONE, lng: 3 }), false);
  assert.equal(driverChanged({ id: 1 }, { id: 2 }), true);
  assert.equal(driverChanged({ id: 1 }, null), false);
});

/* ── dispatch ──────────────────────────────────────────────────────────── */

test("dispatch: نجاح بيطلق courier_dispatch ok:true، والطلب المبعوت للمزوّد زي ما هو", async () => {
  const sent = [];
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async (order, cfg) => {
      sent.push({ order, cfg });
      return { ref: "dsp-1", orderNumber: "dsp-1", cost: 19.55, driver: null, status: "pending", raw: { ok: 1 } };
    },
  });
  const cap = capture();
  const { api, sql, restoreEnv } = build({ settings: AUTO_LJ });
  try {
    const order = { order_no: "FC-100", customer: { phone: PHONE } };
    const res = await api.dispatch(order);
    assert.equal(res.provider, "leajlak");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].order, order, "نفس كائن الطلب بيتبعت للمزوّد");
    assert.ok(sql.some((q) => /INSERT INTO dl_shipments\(shop_order_no, provider, provider_ref, fa_order_id/i.test(q.s)));
    const evs = cap.events.filter((e) => e.name === "courier_dispatch");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].orderNo, "FC-100");
    assert.equal(evs[0].ok, true);
    assert.equal(evs[0].data.provider, "leajlak");
    assert.equal(evs[0].data.assigned, false);
    noPhone(cap.events);
  } finally { cap.stop(); restoreP(); restoreEnv(); }
});

test("dispatch: الفشل بيطلق ok:false وبيرمي نفس الخطأ", async () => {
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async () => { throw Object.assign(new Error("boom"), { code: "LJ_ERROR" }); },
  });
  const cap = capture();
  const { api, restoreEnv } = build({ settings: AUTO_LJ });
  try {
    await assert.rejects(api.dispatch({ order_no: "FC-101" }), /boom/);
    const evs = cap.events.filter((e) => e.name === "courier_dispatch");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].ok, false);
    assert.equal(evs[0].data.reason, "LJ_ERROR");
  } finally { cap.stop(); restoreP(); restoreEnv(); }
});

test("dispatch: الوضع اليدوي لسه بيرمي MANUAL_MODE قبل أي إرسال", async () => {
  let called = 0;
  const restoreP = patchProvider("leajlak", { configured: () => true, dispatch: async () => { called++; } });
  const cap = capture();
  const { api, restoreEnv } = build({ settings: { delivery: { provider: "leajlak" } } });
  try {
    await assert.rejects(api.dispatch({ order_no: "FC-102" }), (e) => e.code === "MANUAL_MODE");
    assert.equal(called, 0);
    const evs = cap.events.filter((e) => e.name === "courier_dispatch");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].data.reason, "MANUAL_MODE");
  } finally { cap.stop(); restoreP(); restoreEnv(); }
});

test("dispatch: مستمع بيرمي مابيأثرش على الإرسال", async () => {
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async () => ({ ref: "r", orderNumber: null, cost: null, driver: { id: 3 }, status: "assigned", raw: {} }),
  });
  const bad = () => { throw new Error("listener down"); };
  bus.on("courier_dispatch", bad);
  const origErr = console.error; console.error = () => {};
  const { api, restoreEnv } = build({ settings: AUTO_LJ });
  try {
    const res = await api.dispatch({ order_no: "FC-103" });
    assert.equal(res.assigned, true);
  } finally { console.error = origErr; bus.off("courier_dispatch", bad); restoreP(); restoreEnv(); }
});

/* ── pollInFlight ──────────────────────────────────────────────────────── */

test("poll: الحالة اتغيّرت → courier_update واحد بالحالة الجديدة", async () => {
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    track: async () => ({ status: "picked", driver: { id: 5, lat: 21.5 }, cost: null, raw: {} }),
  });
  const cap = capture();
  const { api, shipmentEvents, restoreEnv } = build({
    settings: AUTO_LJ,
    pollRows: [{ id: 1, shop_order_no: "FC-200", provider: "leajlak", provider_ref: "d", status: "assigned", driver: { id: 5, lat: 21.4 } }],
  });
  try {
    await api.pollInFlight();
    const evs = cap.events.filter((e) => e.name === "courier_update");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].orderNo, "FC-200");
    assert.equal(evs[0].data.status, "picked");
    assert.equal(evs[0].data.from, "assigned");
    assert.equal(evs[0].data.driver_changed, false, "تغيّر الموقع بس مش سائق جديد");
    assert.equal(evs[0].source, "courier_poll");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(shipmentEvents, [["FC-200", "picked"]]);
  } finally { cap.stop(); restoreP(); restoreEnv(); }
});

test("poll: السائق بس اتعيّن (الحالة زي ما هي) → courier_update driver_changed", async () => {
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    track: async () => ({ status: "pending", driver: { name: "Ali", phone: PHONE }, cost: null, raw: {} }),
  });
  const cap = capture();
  const { api, shipmentEvents, restoreEnv } = build({
    settings: AUTO_LJ,
    pollRows: [{ id: 1, shop_order_no: "FC-201", provider: "leajlak", provider_ref: "d", status: "pending", driver: null }],
  });
  try {
    await api.pollInFlight();
    const evs = cap.events.filter((e) => e.name === "courier_update");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].data.driver_changed, true);
    assert.equal(evs[0].data.status, "pending");
    assert.deepEqual(shipmentEvents, [], "مفيش onShipmentEvent لما الحالة ما اتغيرتش");
    noPhone(cap.events);
  } finally { cap.stop(); restoreP(); restoreEnv(); }
});

test("poll: مفيش تغيير (نفس الحالة ونفس السائق) → مفيش حدث", async () => {
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    track: async () => ({ status: "assigned", driver: { id: 5, lat: 22 }, cost: null, raw: {} }),
  });
  const cap = capture();
  const { api, restoreEnv } = build({
    settings: AUTO_LJ,
    pollRows: [
      { id: 1, shop_order_no: "FC-202", provider: "leajlak", provider_ref: "d", status: "assigned", driver: { id: 5, lat: 21 } },
    ],
  });
  try {
    await api.pollInFlight();
    assert.equal(cap.events.filter((e) => e.name === "courier_update").length, 0);
  } finally { cap.stop(); restoreP(); restoreEnv(); }
});

/* ── webhook ───────────────────────────────────────────────────────────── */

test("webhook: شحنة متطابقة → courier_update بمصدر courier_webhook، والرد زي ما هو", async () => {
  const cap = capture();
  const { routes, shipmentEvents, restoreEnv } = build({ settings: { delivery: { provider: "leajlak" } } });
  try {
    const hook = routes["POST /api/delivery/courier-webhook"];
    const c = {
      req: { text: async () => JSON.stringify({ id: "FC-300", status: "assigned", driver: { name: "Ali", phone: PHONE } }),
             raw: { headers: new Headers({}) } },
      json: (obj, status = 200) => ({ obj, status }),
    };
    const r = await hook(c);
    assert.deepEqual(r, { obj: { ok: true }, status: 200 });
    const evs = cap.events.filter((e) => e.name === "courier_update");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].orderNo, "FC-300");
    assert.equal(evs[0].source, "courier_webhook");
    assert.equal(evs[0].data.via, "webhook");
    assert.equal(evs[0].data.provider, "leajlak");
    assert.equal(evs[0].data.has_driver, true);
    assert.equal(shipmentEvents.length, 1);
    noPhone(cap.events);
  } finally { cap.stop(); restoreEnv(); }
});

test("webhook: طلب مش عندنا → مفيش حدث", async () => {
  const cap = capture();
  const { routes, restoreEnv } = build({ settings: { delivery: { provider: "leajlak" } }, updRows: 0 });
  try {
    const hook = routes["POST /api/delivery/courier-webhook"];
    const c = {
      req: { text: async () => JSON.stringify({ id: "NOPE", status: "assigned" }), raw: { headers: new Headers({}) } },
      json: (obj, status = 200) => ({ obj, status }),
    };
    const r = await hook(c);
    assert.equal(r.obj.ignored, true);
    assert.equal(cap.events.filter((e) => e.name.startsWith("courier_")).length, 0);
  } finally { cap.stop(); restoreEnv(); }
});

/* ── manualEvent ───────────────────────────────────────────────────────── */

test("manualEvent: شحنة جديدة وتحديث — courier_manual من غير جوال السائق", async () => {
  const cap = capture();
  const first = build({ settings: AUTO_LJ, shipment: null });
  try {
    await first.api.manualEvent("FC-400", "handoff", { by: "Sara", ref: "LJ-9", cost: 19.55 });
  } finally { first.restoreEnv(); }
  const second = build({
    settings: AUTO_LJ,
    shipment: { id: 9, shop_order_no: "FC-400", provider: "manual", status: "pending", driver: null },
  });
  try {
    await second.api.manualEvent("FC-400", "assigned", { by: "Sara", driverName: "Ali", driverPhone: PHONE });
    const evs = cap.events.filter((e) => e.name === "courier_manual");
    assert.equal(evs.length, 2);
    assert.equal(evs[0].data.stage, "handoff");
    assert.equal(evs[0].data.status, "pending");
    assert.equal(evs[0].data.ref, "LJ-9");
    assert.equal(evs[0].actor.name, "Sara");
    assert.equal(evs[1].data.status, "assigned");
    assert.equal(evs[1].data.from, "pending");
    assert.equal(evs[1].data.driver_changed, true);
    noPhone(cap.events);
  } finally { cap.stop(); second.restoreEnv(); }
});

test("manualEvent: مرحلة غلط لسه بترمي BAD_STAGE ومن غير حدث", async () => {
  const cap = capture();
  const { api, restoreEnv } = build({ settings: AUTO_LJ });
  try {
    await assert.rejects(api.manualEvent("FC-401", "teleport"), (e) => e.code === "BAD_STAGE");
    assert.equal(cap.events.length, 0);
  } finally { cap.stop(); restoreEnv(); }
});

/* ── cancelShipment ────────────────────────────────────────────────────── */

test("cancelShipment: نجاح → courier_cancel ok:true", async () => {
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    cancel: async () => ({ fee: null, refund: null, raw: {} }),
  });
  const cap = capture();
  const { api, restoreEnv } = build({
    settings: AUTO_LJ,
    shipment: { id: 3, shop_order_no: "FC-500", provider: "leajlak", provider_ref: "d", status: "assigned" },
  });
  try {
    const r = await api.cancelShipment("FC-500", "rejected");
    assert.ok(r);
    const evs = cap.events.filter((e) => e.name === "courier_cancel");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].ok, true);
    assert.equal(evs[0].data.from, "assigned");
  } finally { cap.stop(); restoreP(); restoreEnv(); }
});

test("cancelShipment: فشل المزوّد → courier_cancel ok:false والدالة ترجع null زي الأول", async () => {
  const restoreP = patchProvider("leajlak", {
    configured: () => true,
    cancel: async () => { throw new Error("vendor down"); },
  });
  const cap = capture();
  const origErr = console.error; console.error = () => {};
  const { api, restoreEnv } = build({
    settings: AUTO_LJ,
    shipment: { id: 3, shop_order_no: "FC-501", provider: "leajlak", provider_ref: "d", status: "assigned" },
  });
  try {
    assert.equal(await api.cancelShipment("FC-501"), null);
    const evs = cap.events.filter((e) => e.name === "courier_cancel");
    assert.equal(evs.length, 1);
    assert.equal(evs[0].ok, false);
  } finally { console.error = origErr; cap.stop(); restoreP(); restoreEnv(); }
});

test("cancelShipment: شحنة متوصّلة → مفيش إلغاء ولا حدث", async () => {
  const cap = capture();
  const { api, restoreEnv } = build({
    settings: AUTO_LJ,
    shipment: { id: 3, shop_order_no: "FC-502", provider: "leajlak", provider_ref: "d", status: "delivered" },
  });
  try {
    assert.equal(await api.cancelShipment("FC-502"), null);
    assert.equal(cap.events.length, 0);
  } finally { cap.stop(); restoreEnv(); }
});
