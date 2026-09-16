/* ═══════════════════════════════════════════════════════════════════════════
   اختبارات أحداث الإشعارات (notify.js — W1-04، الخطة §٤-١)
     ١) Push وSMS و«مفيش قناة» — كل واحدة بتطلق notify_sent {stage,channel,ok}
     ٢) الفشل (Push بيرمي، SMS بيرمي، قاعدة البيانات) مابيوقفش ولا بيرمي
     ٣) sendPushTo بيرجّع العدد، وsendOrderPush(orderNo,payload) متصدّرة
     node --test notify-events.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const { register } = await import("./notify.js");
const { bus, CHANNEL } = await import("./order-events.js");

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

function fakeApp() {
  return { get() {}, post() {}, put() {}, delete() {} };
}

function fakePool({ subs = [], order = { order_no: "W1001", phone_norm: "512345678", option: "delivery", total: 50 }, failSubs = false } = {}) {
  return {
    async query(sql) {
      const s = String(sql).replace(/\s+/g, " ");
      if (/FROM shop_orders/i.test(s)) return { rows: order ? [order] : [] };
      if (/FROM push_subs/i.test(s)) {
        if (failSubs) throw new Error("db down");
        return { rows: subs };
      }
      return { rows: [] };
    },
  };
}

function fakePush({ failIds = [] } = {}) {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
    setVapidDetails() {},
    async sendNotification(sub, body) {
      if (failIds.includes(sub.id)) throw Object.assign(new Error("gone"), { statusCode: 500 });
      sent.push({ sub, body: JSON.parse(body) });
    },
  };
}

function setup({ notifications = {}, pool, push, sendSms } = {}) {
  const api = register(fakeApp(), {
    pool: pool || fakePool(),
    requireAdmin: async () => null,
    getSettingsData: async () => ({ webPushKeys: { publicKey: "pub", privateKey: "priv" }, notifications }),
    jb: (x) => JSON.stringify(x),
    normPhone: (p) => String(p || ""),
    webpush: push || fakePush(),
    sendSms: sendSms || (async () => ({ ok: true })),
  });
  return api;
}

function capture() {
  const events = [];
  const fn = (e) => { if (e.name === "notify_sent") events.push(e); };
  bus.on(CHANNEL, fn);
  return { events, stop: () => bus.off(CHANNEL, fn) };
}

test("exports sendPushTo + sendOrderPush alongside the old API", () => {
  const api = setup();
  for (const k of ["orderStatusChanged", "sendToAudience", "sendSmsTo", "sendPushTo", "sendOrderPush"]) {
    assert.equal(typeof api[k], "function", k);
  }
});

test("sendPushTo returns the delivered count", async () => {
  const push = fakePush({ failIds: [2] });
  const api = setup({ push });
  await flush();
  const n = await api.sendPushTo([{ id: 1, sub: { id: 1 } }, { id: 2, sub: { id: 2 } }, { id: 3, sub: { id: 3 } }], { title: "t" });
  assert.equal(n, 2);
  assert.equal(await api.sendPushTo([], { title: "t" }), 0);
});

test("push channel emits notify_sent {stage,channel,ok}", async () => {
  const push = fakePush();
  const api = setup({ push, pool: fakePool({ subs: [{ id: 1, sub: { id: 1 } }] }) });
  const cap = capture();
  try {
    await api.orderStatusChanged("W1001", "accepted");
    await flush();
    assert.equal(cap.events.length, 1);
    const e = cap.events[0];
    assert.equal(e.orderNo, "W1001");
    assert.equal(e.channel, "push");
    assert.equal(e.ok, true);
    assert.equal(e.source, "notify");
    assert.equal(e.data.stage, "accepted");
    assert.equal(e.data.channel, "push");
    assert.equal(e.data.ok, true);
    assert.equal(e.data.sent, 1);
    assert.equal(push.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(e), /5\d{8}/);
  } finally { cap.stop(); }
});

test("sms channel emits its own event (success and failure)", async () => {
  const calls = [];
  const api = setup({
    notifications: { pushEnabled: false, smsEnabled: true },
    sendSms: async (x) => { calls.push(x); },
  });
  const cap = capture();
  try {
    await api.orderStatusChanged("W1001", "pos_created");
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].channel, "sms");
    assert.equal(cap.events[0].ok, true);
    assert.equal(cap.events[0].data.stage, "pos_created");
  } finally { cap.stop(); }

  const bad = setup({
    notifications: { pushEnabled: false, smsEnabled: true },
    sendSms: async () => { throw Object.assign(new Error("taqnyat down"), { code: "ECONNRESET" }); },
  });
  const cap2 = capture();
  try {
    await assert.doesNotReject(bad.orderStatusChanged("W1001", "pos_created"));
    await flush();
    assert.equal(cap2.events.length, 1);
    assert.equal(cap2.events[0].channel, "sms");
    assert.equal(cap2.events[0].ok, false);
  } finally { cap2.stop(); }
});

test("push + sms both fire: one event per channel attempt", async () => {
  const api = setup({
    notifications: { smsEnabled: true },
    pool: fakePool({ subs: [{ id: 1, sub: { id: 1 } }] }),
  });
  const cap = capture();
  try {
    await api.orderStatusChanged("W1001", "pos_created");
    await flush();
    assert.deepEqual(cap.events.map((e) => e.channel).sort(), ["push", "sms"]);
  } finally { cap.stop(); }
});

test("no channel configured → a single 'none' event", async () => {
  // push on but no subscriptions, SMS off
  const api = setup({ notifications: {} });
  const cap = capture();
  try {
    await api.orderStatusChanged("W1001", "accepted");
    await flush();
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].channel, "none");
    assert.equal(cap.events[0].ok, false);
    assert.equal(cap.events[0].data.stage, "accepted");
  } finally { cap.stop(); }

  // everything off; SMS on but stage not in smsStages
  const api2 = setup({ notifications: { pushEnabled: false, smsEnabled: true, smsStages: ["delivered"] } });
  const cap2 = capture();
  try {
    await api2.orderStatusChanged("W1001", "accepted");
    await flush();
    assert.deepEqual(cap2.events.map((e) => e.channel), ["none"]);
  } finally { cap2.stop(); }
});

test("internal stages stay silent (no event, no send)", async () => {
  const api = setup({ notifications: { smsEnabled: true } });
  const cap = capture();
  try {
    await api.orderStatusChanged("W1001", "pending_payment");
    await flush();
    assert.equal(cap.events.length, 0);
  } finally { cap.stop(); }
});

test("failures never throw: push throws, sub lookup fails, listener throws", async () => {
  const push = fakePush({ failIds: [1] });
  const api = setup({ push, pool: fakePool({ subs: [{ id: 1, sub: { id: 1 } }] }) });
  const boom = () => { throw new Error("listener boom"); };
  bus.on(CHANNEL, boom);
  const origErr = console.error; console.error = () => {};
  const cap = capture();
  try {
    await assert.doesNotReject(api.orderStatusChanged("W1001", "on_the_way"));
    await flush();
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].channel, "push");
    assert.equal(cap.events[0].ok, false);

    const api2 = setup({ pool: fakePool({ failSubs: true }) });
    await assert.doesNotReject(api2.orderStatusChanged("W1001", "accepted"));
    await flush();
    const last = cap.events.at(-1);
    assert.equal(last.channel, "push");
    assert.equal(last.ok, false);
  } finally {
    bus.off(CHANNEL, boom);
    console.error = origErr;
    cap.stop();
  }
});

test("sendOrderPush(orderNo,payload) returns count and emits", async () => {
  const push = fakePush();
  const api = setup({ push, pool: fakePool({ subs: [{ id: 1, sub: { id: 1 } }, { id: 2, sub: { id: 2 } }] }) });
  const cap = capture();
  try {
    const n = await api.sendOrderPush("W1001", { stage: "portal_ready", body: "طلبك جاهز" });
    await flush();
    assert.equal(n, 2);
    assert.equal(push.sent[0].body.body, "طلبك جاهز");
    assert.equal(push.sent[0].body.stage, undefined);
    assert.match(push.sent[0].body.url, /\/track\/W1001$/);
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].channel, "push");
    assert.equal(cap.events[0].ok, true);
    assert.equal(cap.events[0].data.stage, "portal_ready");
  } finally { cap.stop(); }

  const off = setup({ notifications: { pushEnabled: false } });
  const cap2 = capture();
  try {
    assert.equal(await off.sendOrderPush("W1001", { body: "x" }), 0);
    await flush();
    assert.equal(cap2.events[0].channel, "none");
    assert.equal(cap2.events[0].data.stage, "custom");
  } finally { cap2.stop(); }

  const broken = setup({ pool: fakePool({ failSubs: true }) });
  const origErr = console.error; console.error = () => {};
  try {
    assert.equal(await broken.sendOrderPush("W1001", { body: "x" }), 0);
  } finally { console.error = origErr; }
});

test("whatsapp failure emits ok:false with the error code, never throws", async () => {
  const saved = { t: process.env.WHATSAPP_TOKEN, p: process.env.WHATSAPP_PHONE_ID };
  delete process.env.WHATSAPP_TOKEN; delete process.env.WHATSAPP_PHONE_ID;
  const api = setup({ notifications: { pushEnabled: false, whatsappEnabled: true } });
  const origErr = console.error; console.error = () => {};
  const cap = capture();
  try {
    await assert.doesNotReject(api.orderStatusChanged("W1001", "accepted"));
    await flush();
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].channel, "whatsapp");
    assert.equal(cap.events[0].ok, false);
    assert.equal(cap.events[0].data.error, "WA_UNCONFIGURED");
  } finally {
    console.error = origErr; cap.stop();
    if (saved.t !== undefined) process.env.WHATSAPP_TOKEN = saved.t;
    if (saved.p !== undefined) process.env.WHATSAPP_PHONE_ID = saved.p;
  }
});
