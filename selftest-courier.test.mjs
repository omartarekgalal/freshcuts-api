/* ═══════════════════════════════════════════════════════════════════════════
   الفحص الذاتي بيفحص شركة الشحن **المختارة** — و/api/pay/health مابيرجعش 5xx

   قبل كده checkCourier كان بينادي delivery.isLive() = activeProvider({})
   من غير إعدادات، فبيرجع flyingarrow وبيسأل faVehicles مع إن الشغل الحقيقي
   على لاجلك. والـpay/health كان بيرجّع 502 وكلاودفلير بيبلع الرسالة.

     node --test selftest-courier.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

import { register as registerDelivery } from "./delivery.js";
import { register as registerSelftest } from "./selftest.js";
import { register as registerPay } from "./pay.js";

const jb = (v) => JSON.stringify(v);
const fakeApp = (routes = {}) => ({
  get(p, h) { routes[`GET ${p}`] = h; }, post(p, h) { routes[`POST ${p}`] = h; },
  put(p, h) { routes[`PUT ${p}`] = h; }, delete(p, h) { routes[`DELETE ${p}`] = h; },
});
const fakePool = () => ({
  query: async (sql) => /count\(\*\)::int AS n FROM dl_policies/i.test(String(sql))
    ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 },
});

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

function build(settings, envMap) {
  const restore = setEnv({ FA_POLL_MINUTES: "0", COURIER_PROVIDER: undefined, ...envMap });
  const ctx = { pool: fakePool(), requireAdmin: async () => null, getSettingsData: async () => settings, jb };
  const real = registerDelivery(fakeApp(), ctx, {});
  let faCalls = 0;
  // spy: faVehicles ممنوع يتنادي لما المزوّد المختار لاجلك
  const api = { ...real, faVehicles: async () => { faCalls++; return { 8: { service: { name_ar: "التوصيل المبرد والساخن" } } }; } };
  const st = registerSelftest(fakeApp(), ctx, { delivery: () => api });
  return { st, real, faCalls: () => faCalls, restore };
}

const quiet = async (fn) => {
  const l = console.log; console.log = () => {};
  try { return await fn(); } finally { console.log = l; }
};

test("delivery.isLive بيقرا الإعدادات (leajlak من غير مفاتيحه = false حتى لو مفتاح FA موجود)", async () => {
  await quiet(async () => {
    const t = build({ delivery: { provider: "leajlak" } },
      { FLYINGARROW_API_KEY: "fa-key", LEAJLAK_TOKEN: undefined, LEAJLAK_SHOP_ID: undefined });
    try {
      assert.equal(await t.real.isLive(), false);
      assert.equal(await t.real.activeProviderId(), "leajlak");
    } finally { t.restore(); }
  });
});

test("provider=leajlak ← checkCourier بينادي reference() (404 = سليم) ومابينادّيش faVehicles", async () => {
  await quiet(async () => {
    const t = build({ delivery: { provider: "leajlak" } },
      { FLYINGARROW_API_KEY: "fa-key", LEAJLAK_TOKEN: "tok", LEAJLAK_SHOP_ID: "821015895" });
    const realFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (/\/orders\/healthcheck-000$/.test(String(url))) {
        return new Response(JSON.stringify({ message: "Order not found" }), { status: 404 });
      }
      throw new Error(`نداء غير متوقع: ${url}`);
    };
    try {
      const r = await t.st.checks.checkCourier();
      assert.equal(r.status, "ok", JSON.stringify(r));
      assert.match(r.detail, /لاجلك/);
      assert.equal(t.faCalls(), 0, "faVehicles اتنادت والمزوّد المختار لاجلك");
      assert.equal(urls.length, 1);
    } finally { globalThis.fetch = realFetch; t.restore(); }
  });
});

test("provider=leajlak والتوكن مرفوض (401) ← fail", async () => {
  await quiet(async () => {
    const t = build({ delivery: { provider: "leajlak" } }, { LEAJLAK_TOKEN: "tok", LEAJLAK_SHOP_ID: "1" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "Unauthenticated." }), { status: 401 });
    try {
      const r = await t.st.checks.checkCourier();
      assert.equal(r.status, "fail");
      assert.equal(t.faCalls(), 0);
    } finally { globalThis.fetch = realFetch; t.restore(); }
  });
});

test("provider=leajlak من غير مفاتيح ← fail باسم لاجلك مش Flying Arrow", async () => {
  await quiet(async () => {
    const t = build({ delivery: { provider: "leajlak" } },
      { FLYINGARROW_API_KEY: "fa-key", LEAJLAK_TOKEN: undefined, LEAJLAK_SHOP_ID: undefined });
    try {
      const r = await t.st.checks.checkCourier();
      assert.equal(r.status, "fail");
      assert.match(r.detail, /لاجلك/);
      assert.equal(t.faCalls(), 0);
    } finally { t.restore(); }
  });
});

test("provider=flyingarrow ← الفحص القديم (faVehicles) زي ما هو", async () => {
  await quiet(async () => {
    const t = build({ delivery: { provider: "flyingarrow", faCityId: 20, pickupContactPhone: "0500000000" } },
      { FLYINGARROW_API_KEY: "fa-key" });
    try {
      const r = await t.st.checks.checkCourier();
      assert.equal(t.faCalls(), 1);
      assert.equal(r.status, "ok", JSON.stringify(r));
    } finally { t.restore(); }
  });
});

test("provider=manual ← ok من غير أي نداء", async () => {
  await quiet(async () => {
    const t = build({ delivery: { provider: "manual" } }, {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("نداء شبكة ممنوع"); };
    try {
      const r = await t.st.checks.checkCourier();
      assert.equal(r.status, "ok");
      assert.equal(t.faCalls(), 0);
    } finally { globalThis.fetch = realFetch; t.restore(); }
  });
});

test("/api/pay/health لما ماي فاتورة تفشل ← HTTP 200 مع ok:false (مش 502)", async () => {
  await quiet(async () => {
    const restore = setEnv({ MYFATOORAH_API_KEY: "mf-key" });
    const routes = {};
    registerPay(fakeApp(routes), { pool: fakePool(), requireAdmin: async () => null, jb }, {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    try {
      let status = null, body = null;
      const c = { json: (obj, s = 200) => { status = s; body = obj; return obj; } };
      await routes["GET /api/pay/health"](c);
      assert.equal(status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.configured, true);
      assert.match(body.error, /ENOTFOUND/);
    } finally { globalThis.fetch = realFetch; restore(); }
  });
});

test("provider=leajlak ومفيش شبكة (DNS/timeout) ← fail مش ok", async () => {
  await quiet(async () => {
    const t = build({ delivery: { provider: "leajlak" } }, { LEAJLAK_TOKEN: "tok", LEAJLAK_SHOP_ID: "1" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    try {
      const r = await t.st.checks.checkCourier();
      assert.equal(r.status, "fail", JSON.stringify(r));
      assert.match(r.detail, /fetch failed/);
    } finally { globalThis.fetch = realFetch; t.restore(); }
  });
});
