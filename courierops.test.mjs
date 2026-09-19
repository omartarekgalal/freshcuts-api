import test from "node:test";
import assert from "node:assert/strict";
import {
  courierSlaCfg, DEFAULT_COURIER_SLA, shipmentTimes, providerCancelled, expectedDriveMin, evalCourierSla,
  farGuardDecision, routeKmOf, courierAlertText, violationsCsv, preDispatchEta, CUSTOMER_TEXT, eventStatus,
} from "./courierops.js";
import { smsInfo } from "./staffalerts.js";
import { PROVIDERS, API_PROVIDER_IDS } from "./couriers.js";

const cfg = courierSlaCfg({});

// W1789825687099 — ١٩/٩: لاجلك قبلت ولغت بعد دقيقتين (13.47 كم)
const refused = {
  id: 29, shop_order_no: "W1789825687099", provider: "leajlak", status: "cancelled",
  created_at: "2026-09-19T14:09:24.196Z",
  events: [
    { at: "2026-09-19T14:09:24.196Z", event: "created", provider: "leajlak", resp: { status: "New Order" } },
    { at: "2026-09-19T14:10:23.093Z", event: "poll", status: "assigned", raw: "Order Accept", provider: "leajlak" },
    { at: "2026-09-19T14:12:22.987Z", event: "poll", status: "cancelled", raw: "Canceled", provider: "leajlak" },
  ],
};
// W1789826771169 — ١٩/٩: ٠٫٣٢ كم، الكابتن استلم ١٤:٤٤ ولسه ماوصّلش ١٥:٢١
const late = {
  id: 31, shop_order_no: "W1789826771169", provider: "leajlak", status: "picked",
  created_at: "2026-09-19T14:25:24.411Z", arrived_at: "2026-09-19T14:41:23.122Z", picked_at: "2026-09-19T14:44:23.155Z",
  events: [
    { at: "2026-09-19T14:25:24.410Z", event: "created", provider: "leajlak" },
    { at: "2026-09-19T14:26:23.221Z", event: "poll", status: "assigned", raw: "Order Accept" },
    { at: "2026-09-19T14:44:23.160Z", event: "poll", status: "picked", raw: "Order Picked" },
  ],
};

test("defaults + editable settings (clamped, bad values ignored)", () => {
  assert.equal(cfg.assignMin, 12);
  assert.equal(cfg.arriveMin, 20);
  assert.equal(cfg.deliverGraceMin, 2);
  assert.equal(cfg.farGuard.mode, "confirm");
  const c = courierSlaCfg({ delivery: { courierSla: { assignMin: "8", arriveMin: -3, alertStaff: false, farGuard: { mode: "suggest", fromKm: 12 } } } });
  assert.equal(c.assignMin, 8);
  assert.equal(c.arriveMin, 20);
  assert.equal(c.alertStaff, false);
  assert.deepEqual(c.farGuard, { enabled: true, fromKm: 12, mode: "suggest" });
  assert.equal(courierSlaCfg({ delivery: { courierSla: { farGuard: { mode: "weird" } } } }).farGuard.mode, "confirm");
});

test("shipmentTimes: first time per stage from the event log", () => {
  const t = shipmentTimes(refused);
  assert.equal(t.assignedAt, "2026-09-19T14:10:23.093Z");
  assert.equal(t.cancelledAt, "2026-09-19T14:12:22.987Z");
  assert.equal(t.ourCancel, false);
  const t2 = shipmentTimes(late);
  assert.equal(t2.pickedAt, "2026-09-19T14:44:23.155Z");   // العمود أولى من الحدث
  assert.equal(t2.deliveredAt, null);
});

test("provider cancel vs our cancel", () => {
  assert.equal(providerCancelled(refused), true);
  const ours = { ...refused, events: [...refused.events, { at: "2026-09-19T14:12:00Z", event: "cancel", provider: "leajlak" }] };
  assert.equal(providerCancelled(ours), false);
  assert.equal(providerCancelled({ ...refused, provider: "external" }), false);
  assert.equal(providerCancelled({ ...refused, status: "assigned" }), false);
});

test("eventStatus: webhook raw names + manual/external stages", () => {
  assert.equal(eventStatus({ event: "Canceled" }, "leajlak"), "cancelled");
  assert.equal(eventStatus({ event: "driver_assigned" }, "flyingarrow"), "assigned");
  assert.equal(eventStatus({ event: "picked", provider: "external" }, "external"), "picked");
  assert.equal(eventStatus({ event: "cost", provider: "external" }, "external"), null);
});

test("expectedDriveMin: max(model, google) rounded up", () => {
  assert.equal(expectedDriveMin({ km: 0.32 }, cfg), 6);         // 5 + 0.8
  assert.equal(expectedDriveMin({ km: 7.29, durationSec: 600 }, cfg), 24); // model 23.2 > google 10
  assert.equal(expectedDriveMin({ km: 2, durationSec: 1800 }, cfg), 30);
  assert.equal(expectedDriveMin({}, cfg), null);
});

test("late order: deliver_late open breach, ETA from pickup", () => {
  const now = Date.parse("2026-09-19T15:21:00Z");
  const r = evalCourierSla({ sh: late, km: 0.32, expectedMin: 6, cfg, now });
  const codes = r.breaches.map((b) => b.code);
  assert.deepEqual(codes, ["deliver_late"]);
  const b = r.breaches[0];
  assert.equal(b.open, true);
  assert.equal(b.deadlineAt, "2026-09-19T14:52:23.155Z"); // picked + 6 + 2
  assert.ok(b.overMin > 28 && b.overMin < 29);
  assert.equal(b.claimable, true);
  assert.equal(r.eta, "2026-09-19T14:50:23.155Z");
  assert.equal(r.etaBasis, "picked");
  // الوصول ١٦ د < ٢٠ (العقد) والتعيين دقيقة < ١٢ ⇒ مفيش مخالفة
  assert.equal(r.deadlines.arrive.done, "2026-09-19T14:41:23.122Z");
});

test("refused order: no SLA breach counted (incident handles it), no ETA", () => {
  const r = evalCourierSla({ sh: refused, km: 13.47, expectedMin: 39, cfg, now: Date.parse("2026-09-19T15:00:00Z") });
  assert.deepEqual(r.breaches, []);
  assert.equal(r.eta, null);
});

test("no captain after 12 min ⇒ open assign_late; contract arrive_late at 20", () => {
  const sh = { provider: "leajlak", status: "pending", created_at: "2026-09-19T14:00:00Z", events: [{ at: "2026-09-19T14:00:00Z", event: "created" }] };
  const at13 = evalCourierSla({ sh, expectedMin: 10, cfg, now: Date.parse("2026-09-19T14:13:00Z") });
  assert.deepEqual(at13.breaches.map((b) => b.code), ["assign_late"]);
  const at21 = evalCourierSla({ sh, expectedMin: 10, cfg, now: Date.parse("2026-09-19T14:21:00Z") });
  assert.deepEqual(at21.breaches.map((b) => b.code).sort(), ["arrive_late", "assign_late"]);
  assert.equal(at21.breaches.find((b) => b.code === "arrive_late").basis, "not_arrived");
});

test("no arrival signal: pickup time is the upper bound for arrival", () => {
  const sh = { provider: "flyingarrow", status: "picked", created_at: "2026-09-19T14:00:00Z", picked_at: "2026-09-19T14:25:00Z", events: [] };
  const r = evalCourierSla({ sh, expectedMin: 10, cfg, now: Date.parse("2026-09-19T14:30:00Z") });
  const a = r.breaches.find((b) => b.code === "arrive_late");
  assert.equal(a.basis, "picked_no_arrival_signal");
  assert.equal(a.overMin, 5);
});

test("external courier: ETA yes, provider SLA breaches no", () => {
  const sh = { provider: "external", status: "picked", created_at: "2026-09-19T14:00:00Z", picked_at: "2026-09-19T14:40:00Z", events: [] };
  const r = evalCourierSla({ sh, expectedMin: 20, cfg, now: Date.parse("2026-09-19T16:00:00Z") });
  assert.deepEqual(r.breaches, []);
  assert.equal(r.eta, "2026-09-19T15:00:00.000Z");
});

test("delivered in time: no breach, claimable only over threshold", () => {
  const sh = { provider: "leajlak", status: "delivered", created_at: "2026-09-19T12:00:00Z", arrived_at: "2026-09-19T12:10:00Z",
    picked_at: "2026-09-19T12:15:00Z", delivered_at: "2026-09-19T12:28:00Z", events: [{ at: "2026-09-19T12:01:00Z", event: "poll", status: "assigned" }] };
  assert.deepEqual(evalCourierSla({ sh, expectedMin: 12, cfg }).breaches, []);
  const r = evalCourierSla({ sh, expectedMin: 10, cfg }); // deadline 12:27 → +1 د
  assert.equal(r.breaches[0].code, "deliver_late");
  assert.equal(r.breaches[0].claimable, false); // < claimMinOverMin (2)
});

test("pre-dispatch ETA: later of food ready and courier at shop", () => {
  const eta = preDispatchEta({ acceptedAt: "2026-09-19T14:00:00Z", expectedMin: 10, dispatchDelayMin: 15, cfg });
  // ready ~14:19, courier ~14:29 (15+14) → +2 +10 = 14:41
  assert.equal(eta, "2026-09-19T14:41:00.000Z");
  assert.equal(preDispatchEta({ acceptedAt: null, expectedMin: 10, cfg }), null);
});

test("far guard: >10 km route ⇒ hold in confirm mode, flag in suggest, nothing when off", () => {
  const row = { delivery_quote: { routeKm: 13.47, farZone: { km: 13.47 } } };
  assert.deepEqual(farGuardDecision(row, cfg), { far: true, km: 13.5, fromKm: 10, mode: "confirm", hold: true });
  const sug = courierSlaCfg({ delivery: { courierSla: { farGuard: { mode: "suggest" } } } });
  assert.equal(farGuardDecision(row, sug).hold, false);
  assert.equal(farGuardDecision(row, sug).far, true);
  const off = courierSlaCfg({ delivery: { courierSla: { farGuard: { mode: "off" } } } });
  assert.equal(farGuardDecision(row, off).far, false);
  assert.equal(farGuardDecision({ delivery_quote: { routeKm: 9.9 } }, cfg).far, false);
  assert.equal(routeKmOf({ delivery_quote: JSON.stringify({ routeKm: "10.4" }) }), 10.4);
  assert.equal(routeKmOf({}), null);
});

test("staff SMS fit one segment (EN ≤160 GSM, AR ≤70)", () => {
  for (const code of ["refused_far", "provider_cancelled", "no_assignment", "far_hold", "assign_late", "arrive_late", "deliver_late"]) {
    const en = courierAlertText("W1789825687099", code, { km: 13.47, over: 28.6, target: 8, min: 12 }, "en");
    assert.equal(smsInfo(en).segments, 1, en);
    assert.equal(smsInfo(en).encoding, "GSM-7", en);
    const ar = courierAlertText("W1789825687099", code, { km: 13.47, over: 28.6, target: 8, min: 12 }, "ar");
    assert.equal(smsInfo(ar).segments, 1, ar);
  }
});

test("customer texts are one UCS-2 segment and transactional", () => {
  for (const k of Object.keys(CUSTOMER_TEXT)) {
    const t = CUSTOMER_TEXT[k]("W1789825687099");
    assert.ok(t.length <= 70, `${k}: ${t.length}`);
    assert.ok(!/http|خصم|عرض|كوبون/.test(t));
  }
});

test("violations CSV: BOM, Riyadh times, contract ref", () => {
  const csv = violationsCsv([{ orderNo: "W1", providerRef: "abc", provider: "leajlak", code: "arrive_late",
    startedAt: "2026-09-19T14:00:00Z", deadlineAt: "2026-09-19T14:20:00Z", actualAt: "2026-09-19T14:31:00Z", overMin: 11,
    km: 4.2, driver: "X, Y", claimStatus: "open", note: 'a "q"' }]);
  assert.ok(csv.startsWith("﻿"));
  const line = csv.split("\n")[1];
  assert.ok(line.includes("2026-09-19 17:20"));
  assert.ok(line.includes("٢٠ د"));
  assert.ok(line.includes('"X, Y"'));
  assert.ok(line.includes('"a ""q"""'));
});

test("external provider never dispatches and never hits another company's API", async () => {
  assert.ok(PROVIDERS.external);
  await assert.rejects(() => PROVIDERS.external.dispatch({}), { code: "MANUAL_DISPATCH_ONLY" });
  assert.equal(await PROVIDERS.external.track({}), null);
  assert.equal(PROVIDERS.external.parseWebhook({ id: "W1", status: "Delivered" }), null);
  assert.ok(!API_PROVIDER_IDS.includes("external"));
  assert.equal(DEFAULT_COURIER_SLA.arriveMin, 20);
});

/* ── المسارات: Hono حقيقي + قاعدة وهمية ─────────────────────────────── */
import { Hono } from "hono";
import { register } from "./courierops.js";

function harness({ row, current = null } = {}) {
  const q = [];
  const calls = { setStatus: [], sms: [], cancel: 0, audit: [] };
  const pool = {
    query: async (sql, vals = []) => {
      sql = String(sql); q.push({ sql, vals });
      if (/INSERT INTO dl_shipments/.test(sql)) return { rows: [{ id: 99 }], rowCount: 1 };
      if (/SELECT phone_norm, is_test FROM shop_orders/.test(sql)) return { rows: [{ phone_norm: "512345678", is_test: false }], rowCount: 1 };
      if (/UPDATE dl_courier_incidents SET resolved_at/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const settings = { notifications: { smsEnabled: true, smsStages: ["pos_created", "on_the_way"] } };
  const app = new Hono();
  register(app, { pool, getSettingsData: async () => settings, requireAdmin: async () => null, jb: JSON.stringify, log: { error() {} } }, {
    timers: false, ensureSchema: false,
    shop: { getOrderRow: async () => row, setStatus: async (no, st, x) => { calls.setStatus.push([no, st, x]); } },
    delivery: { shipmentOf: async () => current, cancelShipment: async () => { calls.cancel++; return { fee: null }; }, activeProviderId: async () => "leajlak" },
    portal: { requirePortal: async () => ({ user: { id: "m1", name: "مدير", role: "manager" } }), audit: (...a) => calls.audit.push(a), scheduleRefresh() {} },
    notify: { sendSmsTo: async (p, body) => { calls.sms.push(body); return true; } },
    staff: { critical: async () => 1 },
    emitOrder: () => null,
  });
  const post = (path, body) => app.request(path, { method: "POST", body: JSON.stringify(body || {}), headers: { "Content-Type": "application/json" } });
  return { app, q, calls, post };
}
const baseRow = { order_no: "W1789825687099", status: "courier_cancelled", option: "delivery", delivery_fee: 12, total: 101 };

test("route: external courier after refusal → shipment + courier_assigned + customer SMS + incident resolved", async () => {
  const h = harness({ row: baseRow, current: { id: 29, provider: "leajlak", status: "cancelled" } });
  const r = await h.post("/api/portal/orders/W1789825687099/courier/external", { name: "أبو علي", cost: 25, reason: "لاجلك رفضت" });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.status, "courier_assigned");
  assert.equal(j.needsCost, false);
  assert.equal(h.calls.cancel, 0);                    // الشحنة الملغية مابتتلغيش تاني
  assert.deepEqual(h.calls.setStatus.map((x) => x[1]), ["courier_assigned"]);
  const ins = h.q.find((x) => /INSERT INTO dl_shipments/.test(x.sql));
  assert.equal(ins.vals[1], "assigned");
  assert.equal(ins.vals[3], 25);
  assert.ok(h.q.some((x) => /dispatch_claimed_at = COALESCE/.test(x.sql)));
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(h.calls.sms.length, 1);
  assert.match(h.calls.sms[0], /مندوب بديل/);
});

test("route: external while Leajlak captain still pending → cancel at Leajlak first; picked → refused", async () => {
  const h = harness({ row: { ...baseRow, status: "courier_requested" }, current: { id: 30, provider: "leajlak", status: "pending" } });
  const r = await h.post("/api/portal/orders/W1/courier/external", {});
  assert.equal(r.status, 200);
  assert.equal(h.calls.cancel, 1);
  assert.equal((await r.json()).needsCost, true);
  const h2 = harness({ row: { ...baseRow, status: "on_the_way" }, current: { id: 31, provider: "leajlak", status: "picked" } });
  const r2 = await h2.post("/api/portal/orders/W1/courier/external", {});
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).error, "already_picked");
});

test("route: retro record = delivered silently (no setStatus, no SMS, review invite skipped)", async () => {
  const h = harness({ row: baseRow, current: { id: 29, provider: "leajlak", status: "cancelled" } });
  const r = await h.post("/api/portal/orders/W1789825687099/courier/external", { stage: "delivered", retro: true, reason: "بأثر رجعي" });
  assert.equal(r.status, 200);
  assert.equal(h.calls.setStatus.length, 0);
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(h.calls.sms.length, 0);
  assert.ok(h.q.some((x) => /UPDATE shop_orders SET status=\$2/.test(x.sql) && x.vals[1] === "delivered"));
  assert.ok(h.q.some((x) => /INSERT INTO review_invites/.test(x.sql) && /courier_incident/.test(x.sql)));
  const ins = h.q.find((x) => /INSERT INTO dl_shipments/.test(x.sql));
  assert.equal(ins.vals[9], null);   // وقت التوصيل مش معروف — مانخترعوش
});

test("route: convert to pickup flags delivery-fee refund, never moves money", async () => {
  const h = harness({ row: baseRow, current: { id: 29, provider: "leajlak", status: "cancelled" } });
  const r = await h.post("/api/portal/orders/W1/courier/pickup", { reason: "العميل هييجي" });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.refundDeliveryFee, 12);
  assert.ok(h.q.some((x) => /SET option='pickup', status='accepted'/.test(x.sql)));
  assert.ok(!h.q.some((x) => /refund_id|makeRefund/i.test(x.sql)));
});

test("route: external stages — picked then cost", async () => {
  const cur = { id: 99, provider: "external", status: "assigned" };
  const h = harness({ row: { ...baseRow, status: "courier_assigned" }, current: cur });
  const r = await h.post("/api/portal/orders/W1/courier/external/picked", {});
  assert.equal(r.status, 200);
  assert.deepEqual(h.calls.setStatus.map((x) => x[1]), ["on_the_way"]);
  const c = await h.post("/api/portal/orders/W1/courier/external/cost", { cost: 30 });
  assert.equal(c.status, 200);
  assert.ok(h.q.some((x) => /SET cost=\$2, cost_basis='manual'/.test(x.sql) && x.vals[1] === 30));
  const bad = await h.post("/api/portal/orders/W1/courier/external/cost", { cost: 9999 });
  assert.equal(bad.status, 400);
});
