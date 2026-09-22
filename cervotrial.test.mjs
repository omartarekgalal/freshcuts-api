/* ═══════════════════════════════════════════════════════════════════════════
   تجربة Cervo — الاختبارات.

   السؤال الكبير: هل ممكن التجربة تخلّي عميل دافع يستنى؟ كل اختبار تحت
   بيقفل باب من أبواب ده:
     • الطلب مايدخلش التجربة غير لو مطابق (تغطية/بعيد/بالحي/تجريبي/مسافة).
     • اختيار المدير بيغلب دايماً.
     • العدّاد بيقف عند الهدف لوحده.
     • مافيش كابتن في المهلة ⇒ إلغاء عند Cervo + لاجلك + تنبيه، وبقفل
       بيمنع كنستين يبعتوا مرتين.

     node --test cervotrial.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CERVO_TRIAL, cervoTrialCfg, trialDecision, trialFallbackDue,
  stillNeedsCourier, shipmentMetrics, summarize, register,
} from "./cervotrial.js";

const t = test;
const on = (patch = {}) => cervoTrialCfg({ delivery: { cervoTrial: { enabled: true, ...patch } } });
const OK = { cfg: on(), km: 5, count: 0, configured: true };

/* ═══ الإعدادات ═══ */
t("الافتراضي مقفول — مفيش طلب حقيقي بيروح لهم من غير قرار", () => {
  assert.equal(DEFAULT_CERVO_TRIAL.enabled, false);
  assert.equal(cervoTrialCfg({}).enabled, false);
  assert.equal(cervoTrialCfg({}).target, 10);
  assert.equal(cervoTrialCfg({}).fallbackMin, 6);
  assert.equal(cervoTrialCfg({}).maxKm, 10);
});
t("الأرقام الغلط بترجع للافتراضي بدل ما تعدّي", () => {
  const c = cervoTrialCfg({ delivery: { cervoTrial: { target: -3, fallbackMin: 9999, maxKm: "abc" } } });
  assert.equal(c.target, 10);
  assert.equal(c.fallbackMin, 6);
  assert.equal(c.maxKm, 10);
});
t("enabled بيتقرا من النص «true» كمان (اللوحة بتبعت نصوص)", () => {
  assert.equal(cervoTrialCfg({ delivery: { cervoTrial: { enabled: "true" } } }).enabled, true);
  assert.equal(cervoTrialCfg({ delivery: { cervoTrial: { enabled: "0" } } }).enabled, false);
});

/* ═══ قرار الدخول ═══ */
t("مقفولة ⇒ مفيش طلب بيدخل", () => {
  const d = trialDecision({ ...OK, cfg: cervoTrialCfg({}) });
  assert.equal(d.take, false);
  assert.equal(d.code, "off");
});
t("طلب مطابق بيدخل وبياخد رقم في العدّ", () => {
  const d = trialDecision(OK);
  assert.equal(d.take, true);
  assert.equal(d.seq, 1);
  assert.equal(d.target, 10);
});
t("اختيار المدير الصريح بيغلب التجربة", () => {
  const d = trialDecision({ ...OK, explicitProvider: "leajlak" });
  assert.equal(d.take, false);
  assert.equal(d.code, "manager_choice");
});
t("العدّاد خلص ⇒ التوجيه بيرجع طبيعي لوحده", () => {
  const d = trialDecision({ ...OK, count: 10 });
  assert.equal(d.take, false);
  assert.equal(d.code, "done");
  /* ولا حتى الطلب اللي بعده بالظبط */
  assert.equal(trialDecision({ ...OK, count: 11 }).take, false);
  /* التاسع لسه داخل */
  assert.equal(trialDecision({ ...OK, count: 9 }).take, true);
  assert.equal(trialDecision({ ...OK, count: 9 }).seq, 10);
});
t("فوق حد التغطية المؤكدة ⇒ بره التجربة", () => {
  const d = trialDecision({ ...OK, km: 10.4 });
  assert.equal(d.take, false);
  assert.equal(d.code, "beyond_coverage");
  assert.equal(trialDecision({ ...OK, km: 10 }).take, true);
});
t("مشوار بعيد (far zone) وتوصيل بالحي بره التجربة", () => {
  assert.equal(trialDecision({ ...OK, farZone: true }).code, "far_zone");
  assert.equal(trialDecision({ ...OK, district: true }).code, "district");
});
t("مسافة مش معروفة ⇒ مانجرّبش", () => {
  assert.equal(trialDecision({ ...OK, km: null }).code, "no_km");
  assert.equal(trialDecision({ ...OK, km: 0 }).code, "no_km");
});
t("طلب تجريبي مابيتحسبش في تجربة على طلبات حقيقية", () => {
  assert.equal(trialDecision({ ...OK, isTest: true }).code, "test_order");
});
t("مفاتيح Cervo ناقصة ⇒ مفيش تجربة (مش فشل إرسال)", () => {
  assert.equal(trialDecision({ ...OK, configured: false }).code, "unconfigured");
});
t("كل رفض بيرجّع سبب بالعربي للوحة", () => {
  for (const d of [trialDecision({ ...OK, km: 30 }), trialDecision({ ...OK, count: 99 }),
                   trialDecision({ ...OK, farZone: true })]) {
    assert.equal(typeof d.why, "string");
    assert.ok(d.why.length > 5);
  }
});

/* ═══ شبكة الأمان ═══ */
const shipAt = (minAgo, extra = {}) => ({
  provider: "cervo", status: "pending", driver: null,
  created_at: new Date(Date.now() - minAgo * 60_000).toISOString(), ...extra,
});
t("مافيش كابتن بعد المهلة ⇒ لازم نرجّع للاجلك", () => {
  const d = trialFallbackDue({ sh: shipAt(7), cfg: on() });
  assert.equal(d.due, true);
  assert.ok(d.waitedMin >= 6);
});
t("لسه في المهلة ⇒ مانتحركش", () => {
  assert.equal(trialFallbackDue({ sh: shipAt(3), cfg: on() }).due, false);
});
t("الكابتن اتعيّن ⇒ مفيش رجوع حتى لو الوقت عدّى", () => {
  const d = trialFallbackDue({ sh: shipAt(30, { driver: { name: "سعد" } }), cfg: on() });
  assert.equal(d.due, false);
});
t("الشحنة اتحرّكت (assigned/picked/delivered) ⇒ مفيش رجوع", () => {
  for (const status of ["assigned", "picked", "delivered", "cancelled"]) {
    assert.equal(trialFallbackDue({ sh: shipAt(30, { status }), cfg: on() }).due, false);
  }
});
t("شحنة مش Cervo عمرها ما تتلمس", () => {
  assert.equal(trialFallbackDue({ sh: shipAt(30, { provider: "leajlak" }), cfg: on() }).due, false);
});
t("المهلة قابلة للتعديل", () => {
  assert.equal(trialFallbackDue({ sh: shipAt(4), cfg: on({ fallbackMin: 3 }) }).due, true);
  assert.equal(trialFallbackDue({ sh: shipAt(4), cfg: on({ fallbackMin: 10 }) }).due, false);
});
t("مانبعتش لاجلك على طلب اتلغى أو اتوصّل", () => {
  assert.equal(stillNeedsCourier("courier_requested"), true);
  assert.equal(stillNeedsCourier("accepted"), true);
  assert.equal(stillNeedsCourier("courier_cancelled"), true);
  assert.equal(stillNeedsCourier("delivered"), false);
  assert.equal(stillNeedsCourier("rejected_refunded"), false);
  assert.equal(stillNeedsCourier(null), false);
});

/* ═══ بطاقة النتيجة ═══ */
t("المقاييس بتتحسب من أوقات الشحنة", () => {
  const base = Date.parse("2026-09-22T10:00:00Z");
  const m = shipmentMetrics({
    shop_order_no: "W1", provider: "cervo", status: "delivered",
    created_at: new Date(base).toISOString(),
    assigned_at: new Date(base + 3 * 60_000).toISOString(),
    arrived_at: new Date(base + 12 * 60_000).toISOString(),
    picked_at: new Date(base + 14 * 60_000).toISOString(),
    delivered_at: new Date(base + 30 * 60_000).toISOString(),
    cost: 19.55, dispatch: { trial: true, costAssumed: true },
  });
  assert.equal(m.toAssignMin, 3);
  assert.equal(m.toArriveMin, 12);
  assert.equal(m.pickupToDeliverMin, 16);
  assert.equal(m.totalMin, 30);
  assert.equal(m.delivered, true);
  assert.equal(m.costAssumed, true);
  assert.equal(m.trial, true);
});
t("وقت ناقص = null مش صفر — صفر كان هيكدب في المتوسط", () => {
  const m = shipmentMetrics({ created_at: "2026-09-22T10:00:00Z", status: "pending" });
  assert.equal(m.toAssignMin, null);
  assert.equal(m.totalMin, null);
  assert.equal(m.delivered, false);
});
t("الملخّص بيعدّ الملغي والمتوسطات بيتجاهلوا الفاضي", () => {
  const s = summarize([
    { toAssignMin: 2, totalMin: 30, cancelled: false, delivered: true, cost: 19.55, costAssumed: true },
    { toAssignMin: 4, totalMin: 40, cancelled: false, delivered: true, cost: 19.55, costAssumed: true },
    { toAssignMin: null, totalMin: null, cancelled: true, delivered: false, cost: null, costAssumed: false },
  ]);
  assert.equal(s.shipments, 3);
  assert.equal(s.delivered, 2);
  assert.equal(s.cancelled, 1);
  assert.equal(s.avgAssignMin, 3);
  assert.equal(s.medTotalMin, 35);
  assert.equal(s.cancelRatePct, 33.3);
  assert.equal(s.costAssumedShipments, 2);
  assert.equal(s.cost, 39.1);
});

/* ═══ الكنس الحقيقي: إلغاء + لاجلك + تنبيه ═══════════════════════════════
   قاعدة وهمية + delivery/courierOps وهميين. بنتأكد من الترتيب: الحادثة
   (القفل) الأول، بعدين الإلغاء، بعدين لاجلك. */
function harness({ opened = new Set(), dispatchThrows = null, rows = null } = {}) {
  const calls = { incidents: [], cancels: [], dispatches: [], redispatch: [], updates: [] };
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const pool = { query: async (sql, vals) => {
    sql = String(sql);
    if (/FROM dl_shipments sh JOIN shop_orders s/i.test(sql) && /dispatch->>'trial'/.test(sql)) {
      return { rows: rows || [], rowCount: (rows || []).length };
    }
    if (/UPDATE dl_shipments SET dispatch = dispatch/i.test(sql)) {
      calls.updates.push(JSON.parse(vals[1])); return { rows: [], rowCount: 1 };
    }
    if (/FROM shop_orders WHERE order_no/i.test(sql)) {
      return { rows: [{ order_no: vals[0], option: "delivery" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  } };
  const courierOps = {
    openIncident: async (orderNo, kind, opts) => {
      calls.incidents.push({ orderNo, kind, ...opts });
      const key = `${orderNo}|${kind}`;
      if (opened.has(key)) return null;      // ON CONFLICT DO NOTHING
      opened.add(key); return opened.size;
    },
    onRedispatch: async (orderNo, x) => { calls.redispatch.push({ orderNo, ...x }); return 1; },
  };
  const delivery = {
    cancelShipment: async (orderNo, reason) => { calls.cancels.push({ orderNo, reason }); return { ok: true }; },
    dispatch: async (row, opts) => {
      calls.dispatches.push({ orderNo: row.order_no, ...opts });
      if (dispatchThrows) throw new Error(dispatchThrows);
      return { provider: "leajlak", faOrderId: "W-NEW" };
    },
  };
  const api = register(app, {
    pool, jb: (v) => JSON.stringify(v),
    getSettingsData: async () => ({ delivery: { cervoTrial: { enabled: true, fallbackMin: 6 } } }),
    requireAdmin: async () => null,
    log: { error() {} },
  }, { delivery, courierOps, shop: () => null, timers: false });
  return { api, calls, opened };
}

const STUCK = [{ id: 11, shop_order_no: "W1", provider: "cervo", provider_ref: "uid-1", status: "pending",
                 driver: null, created_at: new Date(Date.now() - 8 * 60_000).toISOString(),
                 dispatch: { trial: true }, order_status: "courier_requested", is_test: false }];

t("مافيش كابتن ⇒ حادثة بتنبيه، إلغاء عند Cervo، وإرسال للاجلك — بالترتيب ده", async () => {
  const h = harness({ rows: STUCK });
  const out = await h.api.sweep();
  assert.equal(out.fellBack, 1);
  assert.equal(h.calls.incidents[0].kind, "cervo_trial_fallback");
  assert.equal(h.calls.incidents[0].alert, true);
  assert.equal(h.calls.cancels.length, 1);
  assert.equal(h.calls.dispatches.length, 1);
  assert.equal(h.calls.dispatches[0].provider, "leajlak");
  assert.equal(h.calls.dispatches[0].trigger, "cervo_trial_fallback");
  assert.equal(h.calls.redispatch[0].switched, true);
});
t("الشحنة بتتعلّم «رجعت للاجلك» عشان بطاقة النتيجة تقول الحقيقة", async () => {
  const h = harness({ rows: STUCK });
  await h.api.sweep();
  assert.equal(h.calls.updates[0].fellBackTo, "leajlak");
  assert.ok(h.calls.updates[0].waitedMin >= 6);
});
t("كنستين في نفس اللحظة ⇒ إرسال واحد بس (الحادثة هي القفل)", async () => {
  const opened = new Set();
  const a = harness({ rows: STUCK, opened });
  const b = harness({ rows: STUCK, opened });
  await Promise.all([a.api.sweep(), b.api.sweep()]);
  assert.equal(a.calls.dispatches.length + b.calls.dispatches.length, 1);
  assert.equal(a.calls.cancels.length + b.calls.cancels.length, 1);
});
t("لاجلك رفضت الإرسال ⇒ حادثة تانية بتنبيه، مش سكوت", async () => {
  const h = harness({ rows: STUCK, dispatchThrows: "لاجلك: مفاتيح ناقصة" });
  const out = await h.api.sweep();
  assert.equal(out.failed, 1);
  const last = h.calls.incidents[h.calls.incidents.length - 1];
  assert.equal(last.kind, "cervo_trial_fallback_failed");
  assert.equal(last.alert, true);
  /* الإلغاء عند Cervo حصل برضه — مانسيبش طلب حيّ عندهم */
  assert.equal(h.calls.cancels.length, 1);
});
t("طلب اتوصّل/اتلغى مابيتلمسش حتى لو الشحنة معلّقة", async () => {
  const h = harness({ rows: [{ ...STUCK[0], order_status: "delivered" }] });
  const out = await h.api.sweep();
  assert.equal(out.fellBack, 0);
  assert.equal(h.calls.dispatches.length, 0);
});
t("طلب تجريبي مابيحركش شبكة الأمان ولا بيبعت SMS", async () => {
  const h = harness({ rows: [{ ...STUCK[0], is_test: true }] });
  await h.api.sweep();
  assert.equal(h.calls.incidents.length, 0);
  assert.equal(h.calls.dispatches.length, 0);
});
t("شحنة لسه في المهلة مابتتحركش", async () => {
  const fresh = [{ ...STUCK[0], created_at: new Date(Date.now() - 60_000).toISOString() }];
  const h = harness({ rows: fresh });
  const out = await h.api.sweep();
  assert.equal(out.checked, 1);
  assert.equal(out.fellBack, 0);
});
