/* ═══════════════════════════════════════════════════════════════════════════
   الإرسال المكرّر للمندوب (٢١ سبتمبر ٢٠٢٦)

   اللي حصل فعلاً: الكنس التلقائي بعت W1790011118692 للاجلك، الحاوية ماتت في
   نصّ المحاولة (نشر جديد)، فلا صف شحنة اتكتب ولا حدث. النتيجة: لاجلك عندها
   الطلب، وإحنا مش شايفين ولا أثر، والمدير دوس ٣ مرات وكل مرة يردّوا
   «an order is already exist in our system» — وفي الآخر بعت بموظف.

   الاختبارات دي بتثبّت السلوك الجديد:
     ١) كل محاولة بتتكتب **قبل** نداء الشبكة (فالضايعة بتبان).
     ٢) «موجود عندهم» → استرجاع، مش إعادة.
     ٣) الاسترجاع لو فشل → قفل: مفيش إعادة تلقائية، ورسالة واحدة واضحة.
     ٤) التجاوز اليدوي بس هو اللي بيفك القفل.
     ٥) شحنة شغّالة أو محاولة طايرة = مفيش نداء شبكة خالص (منع السباق).

     node --test dispatch-duplicate.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

import { register as registerDelivery } from "./delivery.js";
import { PROVIDERS } from "./couriers.js";

const jb = (v) => JSON.stringify(v);
const AUTO_LJ = { delivery: { provider: "leajlak", dispatchMode: "auto" } };
const ORDER = { order_no: "W1790011118692", total: 96, customer: { name: "عميل", phone: "0551234567" },
                address: { latitude: 21.58, longitude: 39.2 } };

function patchProvider(id, patch) {
  const p = PROVIDERS[id];
  const prev = {};
  for (const k of Object.keys(patch)) { prev[k] = p[k]; p[k] = patch[k]; }
  return () => { for (const k of Object.keys(prev)) p[k] = prev[k]; };
}

/* pool مزيّف بيقلّد الفهرس الفريد الجزئي: محاولة واحدة طايرة لكل طلب. */
function build({ shipments = [] } = {}) {
  const prevPoll = process.env.FA_POLL_MINUTES, prevSweep = process.env.DISPATCH_LOST_SWEEP_SECONDS;
  process.env.FA_POLL_MINUTES = "0";
  process.env.DISPATCH_LOST_SWEEP_SECONDS = "0";
  const attempts = [];
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const pool = {
    query: async (s, vals = []) => {
      s = String(s);
      if (/count\(\*\)::int AS n FROM dl_policies/i.test(s)) return { rows: [{ n: 1 }], rowCount: 1 };
      if (/SELECT \* FROM dl_shipments WHERE shop_order_no/i.test(s)) {
        const r = shipments.filter((x) => x.shop_order_no === vals[0]);
        return { rows: r.slice(-1), rowCount: r.length ? 1 : 0 };
      }
      if (/INSERT INTO dl_shipments/i.test(s)) {
        shipments.push({ id: shipments.length + 1, shop_order_no: vals[0], provider: vals[1],
                         provider_ref: vals[2], status: "pending" });
        return { rows: [{ id: shipments.length }], rowCount: 1 };
      }
      if (/INSERT INTO dl_dispatch_attempts/i.test(s)) {
        if (attempts.some((a) => a.shop_order_no === vals[0] && !a.finished_at)) {
          throw Object.assign(new Error("duplicate key value"), { code: "23505" });
        }
        const row = { id: attempts.length + 1, shop_order_no: vals[0], provider: vals[1],
                      trigger: vals[2], actor: vals[3], started_at: new Date(), finished_at: null,
                      outcome: null, resolved_at: null, error_message: null };
        attempts.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/SELECT id, shop_order_no FROM dl_dispatch_attempts\s+WHERE finished_at IS NULL AND started_at </i.test(s)) {
        const stale = attempts.filter((x) => !x.finished_at
          && Date.now() - x.started_at.getTime() > Number(vals[0]) * 60000);
        return { rows: stale.map((x) => ({ id: x.id, shop_order_no: x.shop_order_no })), rowCount: stale.length };
      }
      if (/FROM dl_dispatch_attempts WHERE shop_order_no=\$1 AND finished_at IS NULL/i.test(s)) {
        const a = attempts.find((x) => x.shop_order_no === vals[0] && !x.finished_at);
        return { rows: a ? [{ ...a, age_min: (Date.now() - a.started_at.getTime()) / 60000 }] : [], rowCount: a ? 1 : 0 };
      }
      if (/FROM dl_dispatch_attempts\s+WHERE shop_order_no=\$1 AND resolved_at IS NULL AND outcome IN/i.test(s)) {
        const a = [...attempts].reverse().find((x) => x.shop_order_no === vals[0] && !x.resolved_at
          && ["duplicate", "lost"].includes(x.outcome));
        return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
      }
      if (/UPDATE dl_dispatch_attempts SET finished_at=NOW\(\), ok=\$2/i.test(s)) {
        const a = attempts.find((x) => x.id === vals[0]);
        if (a) { a.finished_at = new Date(); a.ok = vals[1]; a.outcome = vals[2]; a.error_message = vals[5]; }
        return { rows: [], rowCount: a ? 1 : 0 };
      }
      if (/UPDATE dl_dispatch_attempts\s+SET finished_at=NOW\(\), ok=false, outcome='lost'/i.test(s)) {
        const a = attempts.find((x) => x.id === vals[0] && !x.finished_at);
        if (a) { a.finished_at = new Date(); a.ok = false; a.outcome = "lost"; }
        return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
      }
      if (/UPDATE dl_dispatch_attempts SET resolved_at=NOW\(\)/i.test(s)) {
        for (const a of attempts) {
          if (a.shop_order_no === vals[0] && !a.resolved_at) a.resolved_at = new Date();
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const api = registerDelivery(app,
    { pool, requireAdmin: async () => null, getSettingsData: async () => AUTO_LJ, jb }, {});
  const restore = () => {
    if (prevPoll === undefined) delete process.env.FA_POLL_MINUTES; else process.env.FA_POLL_MINUTES = prevPoll;
    if (prevSweep === undefined) delete process.env.DISPATCH_LOST_SWEEP_SECONDS; else process.env.DISPATCH_LOST_SWEEP_SECONDS = prevSweep;
  };
  return { api, attempts, shipments, restore };
}

const dupErr = () => Object.assign(new Error("الطلب مسجّل عند لاجلك بالفعل"),
  { code: "COURIER_DUPLICATE", provider: "leajlak", status: 400,
    providerMessage: "With this W1790011118692 client order id an order is already exist in our system" });

test("كل محاولة بتتسجّل قبل نداء الشبكة", async () => {
  let seenAtCall = -1;
  const { api, attempts, restore } = build();
  const un = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async () => { seenAtCall = attempts.length; return { ref: "dsp-1", orderNumber: "dsp-1", status: "pending", raw: {} }; },
  });
  try {
    await api.dispatch(ORDER, { trigger: "sweep" });
    assert.equal(seenAtCall, 1, "الصف لازم يكون مكتوب قبل ما نكلّم الشركة");
    assert.equal(attempts[0].outcome, "created");
    assert.equal(attempts[0].trigger, "sweep");
  } finally { un(); restore(); }
});

test("«موجود عندهم» بينجح لما الاسترجاع يلاقي مرجعهم — وبيتحوّل لشحنة عادية", async () => {
  const { api, attempts, shipments, restore } = build();
  const un = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async () => { throw dupErr(); },
    lookup: async () => ({ found: true, ref: "abc-uuid", status: "assigned", driver: null, tried: [], via: "/orders" }),
  });
  try {
    const res = await api.dispatch(ORDER, { trigger: "portal", actor: "محمد" });
    assert.equal(res.adopted, true);
    assert.equal(res.faOrderId, "abc-uuid");
    assert.equal(shipments.at(-1).provider_ref, "abc-uuid", "لازم يبقى فيه صف شحنة عشان التتبع يكمّل");
    assert.equal(attempts.at(-1).outcome, "adopted");
  } finally { un(); restore(); }
});

test("الاسترجاع لو فشل: قفل — الإعادة بتترفض من غير ما تكلّم الشركة تاني", async () => {
  let calls = 0;
  const { api, attempts, restore } = build();
  const un = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async () => { calls++; throw dupErr(); },
    lookup: async () => ({ found: false, tried: [{ path: "/orders", status: 404 }] }),
  });
  try {
    await assert.rejects(() => api.dispatch(ORDER, { trigger: "portal" }),
      (e) => e.code === "COURIER_DUPLICATE");
    assert.equal(attempts.at(-1).outcome, "duplicate");
    // إعادة تانية وتالتة زي اللي المدير عملها — المفروض ما توصلش الشركة خالص
    await assert.rejects(() => api.dispatch(ORDER, { trigger: "portal" }),
      (e) => e.code === "DISPATCH_BLOCKED");
    await assert.rejects(() => api.dispatch(ORDER, { trigger: "sweep" }),
      (e) => e.code === "DISPATCH_BLOCKED");
    assert.equal(calls, 1, "الشركة اتكلّمت مرة واحدة بس");
  } finally { un(); restore(); }
});

test("التجاوز اليدوي بس هو اللي بيفك القفل", async () => {
  const { api, restore } = build();
  let calls = 0;
  const un = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async () => { calls++; if (calls === 1) throw dupErr(); return { ref: "dsp-9", orderNumber: "dsp-9", status: "pending", raw: {} }; },
    lookup: async () => ({ found: false, tried: [] }),
  });
  try {
    await assert.rejects(() => api.dispatch(ORDER, { trigger: "portal" }), (e) => e.code === "COURIER_DUPLICATE");
    await assert.rejects(() => api.dispatch(ORDER, { trigger: "portal" }), (e) => e.code === "DISPATCH_BLOCKED");
    const res = await api.dispatch(ORDER, { trigger: "portal", actor: "محمد", force: true });
    assert.equal(res.faOrderId, "dsp-9");
    assert.equal(calls, 2);
  } finally { un(); restore(); }
});

test("شحنة شغّالة = مفيش نداء شبكة (الكنس وزرار البوابة ما يتسابقوش)", async () => {
  let calls = 0;
  const { api, restore } = build({ shipments: [{ id: 1, shop_order_no: ORDER.order_no, provider: "leajlak", status: "assigned", provider_ref: "x" }] });
  const un = patchProvider("leajlak", { configured: () => true, dispatch: async () => { calls++; return { ref: "y", status: "pending", raw: {} }; } });
  try {
    await assert.rejects(() => api.dispatch(ORDER, { trigger: "sweep" }), (e) => e.code === "ALREADY_DISPATCHED");
    assert.equal(calls, 0);
  } finally { un(); restore(); }
});

test("محاولتان في نفس اللحظة: واحدة بس بتوصل الشركة", async () => {
  let calls = 0;
  const { api, restore } = build();
  let release;
  const gate = new Promise((r) => { release = r; });
  const un = patchProvider("leajlak", {
    configured: () => true,
    dispatch: async () => { calls++; await gate; return { ref: "dsp-1", status: "pending", raw: {} }; },
  });
  try {
    const a = api.dispatch(ORDER, { trigger: "sweep" });
    const b = api.dispatch(ORDER, { trigger: "portal" }).catch((e) => e);
    const err = await b;
    release();
    await a;
    assert.equal(err.code, "DISPATCH_IN_PROGRESS");
    assert.equal(calls, 1);
  } finally { un(); restore(); }
});

test("محاولة ضاعت (الخدمة ماتت): الكنس بيقفلها كـ«ضايعة» والإرسال بيتقفل", async () => {
  const { api, attempts, restore } = build();
  const un = patchProvider("leajlak", { configured: () => true, dispatch: async () => { throw new Error("killed"); } });
  try {
    // محاكاة: الصف اتكتب والعملية ماتت — يعني finished_at فضل NULL
    attempts.push({ id: 99, shop_order_no: ORDER.order_no, provider: "leajlak", trigger: "sweep",
                    started_at: new Date(Date.now() - 10 * 60000), finished_at: null, outcome: null, resolved_at: null });
    const n = await api.sweepLostAttempts();
    assert.equal(n, 1);
    assert.equal(attempts.find((a) => a.id === 99).outcome, "lost");
    await assert.rejects(() => api.dispatch(ORDER, { trigger: "sweep" }), (e) => e.code === "DISPATCH_BLOCKED");
  } finally { un(); restore(); }
});
