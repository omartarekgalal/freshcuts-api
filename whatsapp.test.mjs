/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات whatsapp.js (Cloud API) + ربطه بـ notify.js
     ١) القوالب: عدد المتغيرات = bind = المثال، وجسم الإرسال صح (URL/OTP)
     ٢) مقفول افتراضياً: من غير WHATSAPP_ENABLED=1 مفيش ولا طلب شبكة
     ٣) الموافقة: utility محتاج updates، marketing محتاج marketing ومش موقوف
     ٤) الويب هوك: توقيع، تحقق، failed → SMS بديل مرة واحدة، «إيقاف» → إلغاء التسويق
     ٥) notify: واتساب نجح + whatsappReplacesSms → مفيش SMS؛ اتخطّى → SMS عادي
     node --test whatsapp.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const W = await import("./whatsapp.js");
const { register: registerNotify } = await import("./notify.js");

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function fakeApp() {
  const routes = {};
  const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
}

function fakeCtx({ raw = "", headers = {}, query = {}, json = {} } = {}) {
  return {
    req: {
      text: async () => raw, json: async () => json,
      header: (n) => headers[String(n).toLowerCase()],
      query: (n) => query[n],
    },
    json: (body, status = 200) => ({ body, status }),
    text: (body, status = 200) => ({ body, status }),
  };
}

/* ذاكرة بسيطة للجداول اللي الموديول بيلمسها. */
function memPool({ optins = {}, suppressed = [], orders = {} } = {}) {
  const msgs = [];
  const smsCalls = [];
  const pool = {
    msgs, smsCalls, optins,
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^CREATE TABLE/i.test(s)) return { rows: [] };
      if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: optins[p[0]] ? [optins[p[0]]] : [] };
      if (/^INSERT INTO wa_optins/i.test(s)) {
        const cur = optins[p[0]] || { updates: false, marketing: false };
        optins[p[0]] = { updates: p[1] ?? cur.updates, marketing: p[2] ?? cur.marketing };
        return { rows: [] };
      }
      if (/FROM cms_contacts/i.test(s)) return { rowCount: suppressed.includes(p[0]) ? 1 : 0, rows: [] };
      if (/^UPDATE cms_contacts/i.test(s)) { suppressed.push(p[0]); return { rowCount: 1, rows: [] }; }
      if (/FROM shop_orders/i.test(s)) return { rows: orders[p[0]] ? [orders[p[0]]] : [] };
      if (/^INSERT INTO wa_messages/i.test(s)) {
        if (/'out'/.test(s)) msgs.push({ id: msgs.length + 1, wamid: p[0], direction: "out", phone_norm: p[1], template: p[2], category: p[3], order_no: p[4], stage: p[5], status: p[6], error: p[7], fallback_sms: p[9], fallback_done: false });
        else msgs.push({ id: msgs.length + 1, wamid: p[0], direction: "in", phone_norm: p[1], body: p[2] });
        return { rows: [] };
      }
      if (/^UPDATE wa_messages SET status/i.test(s)) {
        const m = msgs.find((x) => x.wamid === p[0]);
        if (!m) return { rows: [] };
        m.status = p[1];
        return { rows: [m] };
      }
      if (/^UPDATE wa_messages SET fallback_done/i.test(s)) {
        const m = msgs.find((x) => x.id === p[0] && !x.fallback_done);
        if (!m) return { rowCount: 0, rows: [] };
        m.fallback_done = true;
        return { rowCount: 1, rows: [{ id: m.id }] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

function fakeFetch(reply = { messages: [{ id: "wamid.TEST1" }] }, ok = true) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok, status: ok ? 200 : 400, json: async () => reply };
  };
  fn.calls = calls;
  return fn;
}

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "META_CAPI_TOKEN"];
function withEnv(vals, fn) {
  return async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, vals);
    try { await fn(); } finally {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
}
const ON = { WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_APP_SECRET: "sec", WHATSAPP_VERIFY_TOKEN: "vt" };

function setupWa({ pool, fetch, notifications = { whatsappEnabled: true }, sendSms } = {}) {
  const app = fakeApp();
  const api = W.register(app, {
    pool: pool || memPool(), requireAdmin: async () => null,
    getSettingsData: async () => ({ notifications }), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""),
  }, { fetch: fetch || fakeFetch(), sendSms: sendSms || (async () => ({ ok: true })) });
  return { app, api };
}

/* ── ١) القوالب ── */
test("every template: placeholders == example == bind output", () => {
  const sample = { order_no: "W1", total: 96, name: "محمد", resumePath: "?r=1", offer: "كيلو", price: "96", slug: "x", percent: 15, code: "C1" };
  for (const [name, t] of Object.entries(W.TEMPLATES)) {
    assert.match(name, /^[a-z0-9_]{1,512}$/, name);
    const body = t.components.find((c) => c.type === "BODY");
    if (t.category === "AUTHENTICATION") continue;
    const n = (body.text.match(/\{\{\d+\}\}/g) || []).length;
    assert.equal(body.example.body_text[0].length, n, `${name} example`);
    assert.equal(t.bind(sample).body.length, n, `${name} bind`);
    assert.ok(body.text.length <= 1024, `${name} length`);
    if (t.category === "MARKETING") assert.ok(t.components.some((c) => c.type === "FOOTER"), `${name} needs opt-out footer`);
  }
});

test("buildTemplatePayload: body params + URL button suffix at the right index", () => {
  const p = W.buildTemplatePayload("fc_order_received", "966512345678",
    W.TEMPLATES.fc_order_received.bind({ order_no: "W9", total: 50, name: "سارة" }));
  assert.equal(p.to, "966512345678");
  assert.equal(p.template.language.code, "ar");
  assert.deepEqual(p.template.components[0].parameters.map((x) => x.text), ["سارة", "W9", "50.00"]);
  assert.deepEqual(p.template.components[1], { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "W9" }] });
  const otp = W.buildTemplatePayload("fc_otp", "966512345678", W.TEMPLATES.fc_otp.bind({ code: "4821" }));
  assert.equal(otp.template.components[0].parameters[0].text, "4821");
  assert.equal(otp.template.components[1].sub_type, "url");
  assert.throws(() => W.buildTemplatePayload("nope", "1", {}));
});

test("stage map covers the customer-facing order stages", () => {
  for (const st of ["pos_created", "accepted", "on_the_way", "delivered", "rejected_refunded", "refund_failed"]) {
    assert.ok(W.STAGE_TEMPLATES[st], st);
  }
});

test("phone helpers only accept Saudi mobiles", () => {
  assert.equal(W.toWaId("512345678"), "966512345678");
  assert.equal(W.toWaId("966512345678"), "966512345678");
  assert.equal(W.toWaId("1234"), null);
  assert.equal(W.fromWaId("966512345678"), "512345678");
  assert.equal(W.fromWaId("201111993980"), null);
});

/* ── ٢) مقفول افتراضياً ── */
test("master switch off → skipped, zero network calls", withEnv({ WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "p" }, async () => {
  const fetch = fakeFetch();
  const pool = memPool({ optins: { "512345678": { updates: true, marketing: true } } });
  const { api } = setupWa({ pool, fetch });
  const r = await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params: { body: ["W1"], button: ["W1"] } });
  assert.equal(r.skipped, "disabled");
  assert.equal(fetch.calls.length, 0);
}));

test("dashboard toggle off → skipped even with env on", withEnv(ON, async () => {
  const fetch = fakeFetch();
  const { api } = setupWa({ fetch, notifications: {} });
  const r = await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params: { body: ["W1"] } });
  assert.equal(r.skipped, "settings_off");
  assert.equal(fetch.calls.length, 0);
}));

/* ── ٣) الموافقة ── */
test("utility without opt-in → skipped; with opt-in → sent + logged", withEnv(ON, async () => {
  const fetch = fakeFetch();
  const pool = memPool();
  const { api } = setupWa({ pool, fetch });
  const a = await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params: { body: ["W1"], button: ["W1"] } });
  assert.equal(a.skipped, "no_optin");
  assert.equal(fetch.calls.length, 0);
  await api.recordOptIn({ phone: "0512345678", updates: true });
  const b = await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params: { body: ["W1"], button: ["W1"] }, orderNo: "W1" });
  assert.equal(b.ok, true);
  assert.equal(b.wamid, "wamid.TEST1");
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].url, /graph\.facebook\.com\/v\d+\.0\/PHONE1\/messages$/);
  assert.equal(fetch.calls[0].auth, "Bearer tok");
  assert.equal(pool.msgs[0].status, "accepted");
}));

test("marketing needs marketing opt-in and respects cms opt-out", withEnv(ON, async () => {
  const fetch = fakeFetch();
  const pool = memPool({ optins: { "512345678": { updates: true, marketing: false }, "598765432": { updates: false, marketing: true } }, suppressed: ["598765432"] });
  const { api } = setupWa({ pool, fetch });
  const p = { body: ["محمد"], button: ["?r=1"] };
  assert.equal((await api.sendTemplate({ phoneNorm: "512345678", template: "fc_cart_reminder", params: p })).skipped, "no_optin");
  assert.equal((await api.sendTemplate({ phoneNorm: "598765432", template: "fc_cart_reminder", params: p })).skipped, "opted_out");
  assert.equal(fetch.calls.length, 0);
}));

test("Graph error → ok:false, logged failed, never throws", withEnv(ON, async () => {
  const fetch = fakeFetch({ error: { code: 131047, message: "Re-engagement" } }, false);
  const pool = memPool({ optins: { "512345678": { updates: true } } });
  const { api } = setupWa({ pool, fetch });
  const r = await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params: { body: ["W1"] } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "WA_131047");
  assert.equal(pool.msgs[0].status, "failed");
}));

/* ── ٤) الويب هوك ── */
test("signature verification", () => {
  const raw = JSON.stringify({ a: 1 });
  const sig = "sha256=" + crypto.createHmac("sha256", "sec").update(raw).digest("hex");
  assert.equal(W.verifySignature(raw, sig, "sec"), true);
  assert.equal(W.verifySignature(raw + " ", sig, "sec"), false);
  assert.equal(W.verifySignature(raw, sig, ""), false);
  assert.equal(W.verifySignature(raw, "sha256=zz", "sec"), false);
});

test("GET verify echoes challenge only with the right token", withEnv(ON, async () => {
  const { app } = setupWa();
  const h = app.routes["GET /api/wa/webhook"];
  assert.deepEqual(h(fakeCtx({ query: { "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "42" } })), { body: "42", status: 200 });
  assert.equal(h(fakeCtx({ query: { "hub.mode": "subscribe", "hub.verify_token": "bad", "hub.challenge": "42" } })).status, 403);
}));

function signed(obj, secret = "sec") {
  const raw = JSON.stringify(obj);
  return fakeCtx({ raw, headers: { "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex") } });
}
const statusHook = (wamid, status) => ({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status, recipient_id: "966512345678", timestamp: "1726500000", errors: status === "failed" ? [{ code: 131026, title: "undeliverable" }] : undefined }] } }] }] });

test("failed status → SMS fallback exactly once (duplicate webhooks)", withEnv(ON, async () => {
  const sms = [];
  const pool = memPool({ optins: { "512345678": { updates: true } } });
  const { app, api } = setupWa({ pool, notifications: { whatsappEnabled: true, smsEnabled: true }, sendSms: async (x) => { sms.push(x); } });
  await api.sendTemplate({ phoneNorm: "512345678", template: "fc_order_preparing", params: { body: ["W1"] }, orderNo: "W1", fallbackSms: "نص بديل" });
  const h = app.routes["POST /api/wa/webhook"];
  assert.equal((await h(signed(statusHook("wamid.TEST1", "failed")))).status, 200);
  await h(signed(statusHook("wamid.TEST1", "failed")));
  await flush();
  assert.equal(sms.length, 1);
  assert.deepEqual(sms[0], { phoneNorm: "512345678", body: "نص بديل" });
}));

test("unsigned webhook is ignored with 200", withEnv(ON, async () => {
  const sms = [];
  const pool = memPool();
  const { app } = setupWa({ pool, sendSms: async (x) => sms.push(x) });
  const r = await app.routes["POST /api/wa/webhook"](fakeCtx({ raw: JSON.stringify(statusHook("x", "failed")) }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, "signature");
}));

test("inbound «إيقاف» turns marketing off and marks cms opt-out", withEnv(ON, async () => {
  const pool = memPool({ optins: { "512345678": { updates: true, marketing: true } } });
  const { app } = setupWa({ pool });
  const body = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.IN1", from: "966512345678", type: "text", text: { body: " إيقاف " }, timestamp: "1726500000" }] } }] }] };
  await app.routes["POST /api/wa/webhook"](signed(body));
  await flush();
  assert.equal(pool.optins["512345678"].marketing, false);
  assert.equal(pool.optins["512345678"].updates, true);
  assert.equal(pool.msgs[0].direction, "in");
  assert.equal(W.parseWebhook(body).messages[0].intent, "stop");
}));

/* ── ٥) notify.js ── */
function notifyWith({ waResult, notifications }) {
  const sms = [];
  const calls = [];
  const pool = { async query(sql) {
    if (/FROM shop_orders/i.test(sql)) return { rows: [{ order_no: "W1", phone_norm: "512345678", option: "delivery", total: 50 }] };
    return { rows: [] };
  } };
  const api = registerNotify({ get() {}, post() {} }, {
    pool, requireAdmin: async () => null, jb: JSON.stringify, normPhone: String,
    getSettingsData: async () => ({ webPushKeys: { publicKey: "p", privateKey: "q" }, notifications }),
    webpush: { generateVAPIDKeys: () => ({}), setVapidDetails() {}, async sendNotification() {} },
    sendSms: async (x) => { sms.push(x); },
  }, { wa: { sendOrderUpdate: async (o, st, opts) => { calls.push({ st, opts }); return waResult; } } });
  return { api, sms, calls };
}

test("notify: WhatsApp accepted + whatsappReplacesSms → no SMS, fallback text handed over", async () => {
  const { api, sms, calls } = notifyWith({ waResult: { ok: true, wamid: "w" },
    notifications: { pushEnabled: false, smsEnabled: true, whatsappEnabled: true, whatsappReplacesSms: true } });
  await api.orderStatusChanged("W1", "pos_created");
  assert.equal(sms.length, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].opts.fallbackSms, /W1/);
});

test("notify: WhatsApp skipped (no opt-in) → SMS goes as before", async () => {
  const { api, sms } = notifyWith({ waResult: { ok: false, skipped: "no_optin" },
    notifications: { pushEnabled: false, smsEnabled: true, whatsappEnabled: true, whatsappReplacesSms: true } });
  await api.orderStatusChanged("W1", "pos_created");
  assert.equal(sms.length, 1);
});

test("notify: whatsappEnabled off → module never called", async () => {
  const { api, calls, sms } = notifyWith({ waResult: { ok: true },
    notifications: { pushEnabled: false, smsEnabled: true } });
  await api.orderStatusChanged("W1", "pos_created");
  assert.equal(calls.length, 0);
  assert.equal(sms.length, 1);
});
