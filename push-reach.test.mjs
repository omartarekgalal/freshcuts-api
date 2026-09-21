/* ═══════════════════════════════════════════════════════════════════════════
   وصول الإشعارات (٢١/٩): سجل الإرسال + توكنات التطبيق + فاصل الحملات.
   السبب: «بعتنا» ما كانتش تعني «وصل» — مفيش سطر في قاعدة البيانات يثبت
   إن الإشعار اتعرض أو اتفتح، ومفيش حتة يقعد فيها توكن FCM بتاع التطبيق.
     node --test push-reach.test.mjs
═══════════════════════════════════════════════════════════════════════════ */

import test from "node:test";
import assert from "node:assert/strict";

const { register } = await import("./notify.js");

function fakeApp() {
  const routes = { get: {}, post: {}, put: {}, delete: {} };
  return {
    routes,
    get(p, h) { routes.get[p] = h; }, post(p, h) { routes.post[p] = h; },
    put(p, h) { routes.put[p] = h; }, delete(p, h) { routes.delete[p] = h; },
  };
}

/* بول بيسجّل كل استعلام، وبيرجّع id وهمي لأي INSERT فيه RETURNING id */
function recordingPool({ subs = [], order = null, logId = 77 } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, args) {
      const s = String(sql).replace(/\s+/g, " ");
      seen.push({ s, args });
      if (/INSERT INTO push_log/i.test(s)) return { rows: [{ id: logId }] };
      if (/FROM shop_orders/i.test(s)) return { rows: order ? [order] : [] };
      if (/FROM push_subs/i.test(s)) return { rows: subs };
      if (/FROM push_log/i.test(s)) return { rows: [{ sent: 3, delivered: 2, clicked: 1 }] };
      return { rows: [] };
    },
  };
}

function fakePush() {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
    setVapidDetails() {},
    async sendNotification(sub, body) { sent.push({ sub, body: JSON.parse(body) }); },
  };
}

function setup({ pool, push } = {}) {
  const app = fakeApp();
  const api = register(app, {
    pool: pool || recordingPool(),
    requireAdmin: async () => null,
    getSettingsData: async () => ({ webPushKeys: { publicKey: "pub", privateKey: "priv" }, notifications: {} }),
    jb: (x) => JSON.stringify(x),
    normPhone: (p) => String(p || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, ""),
    webpush: push || fakePush(),
    sendSms: async () => ({ ok: true }),
  });
  return { app, api };
}

test("كل إشعار بيتسجّل في push_log وبيشيل رقم السطر عشان المتصفح يرجّع «وصل»", async () => {
  const pool = recordingPool();
  const push = fakePush();
  const { api } = setup({ pool, push });
  const sent = await api.sendPushTo([{ id: 5, sub: { endpoint: "e" }, kind: "web", phone_norm: "512345678" }],
    { title: "ت", body: "ب", url: "https://freshcuts.sa/track/X" },
    { stage: "on_the_way", orderNo: "FC-1", campaignId: null });
  assert.equal(sent, 1);
  const log = pool.seen.find((q) => /INSERT INTO push_log/.test(q.s));
  assert.ok(log, "لازم يتكتب سطر في push_log");
  assert.equal(log.args[3], "on_the_way");
  assert.equal(push.sent[0].body.n, "77", "الحمولة لازم تشيل n = رقم السطر");
});

test("الإشعار الميت بيتشال، وسطر السجل بتاعه مابيفضلش يعدّ كأنه اتبعت", async () => {
  const pool = recordingPool();
  const push = fakePush();
  push.sendNotification = async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); };
  const { api } = setup({ pool, push });
  const sent = await api.sendPushTo([{ id: 9, sub: { endpoint: "e" }, kind: "web" }], { title: "ت" }, { stage: "x" });
  assert.equal(sent, 0);
  assert.ok(pool.seen.some((q) => /UPDATE push_subs SET disabled=TRUE/.test(q.s)), "الاشتراك الميت يتقفل");
  assert.ok(pool.seen.some((q) => /DELETE FROM push_log/.test(q.s)), "سطر الإرسال الفاشل يتشال");
});

test("توكن التطبيق (FCM) من غير مفتاح خدمة مابيتبعتش — ومابيكسرش الباقي", async () => {
  delete process.env.FCM_SERVICE_ACCOUNT;
  const pool = recordingPool();
  const push = fakePush();
  const { api } = setup({ pool, push });
  const sent = await api.sendPushTo([
    { id: 1, sub: { kind: "fcm", token: "t".repeat(40) }, kind: "fcm" },
    { id: 2, sub: { endpoint: "e" }, kind: "web" },
  ], { title: "ت" }, { stage: "x" });
  assert.equal(sent, 1, "اشتراك المتصفح بيعدّي، وتوكن التطبيق بس اللي بيفشل");
  assert.equal(api.fcmReady(), false);
});

test("تسجيل توكن تطبيق بيتخزّن كـkind=fcm وendpoint=fcm:<token>", async () => {
  const pool = recordingPool();
  const { app } = setup({ pool });
  const body = { kind: "fcm", token: "a".repeat(64), platform: "android", appVersion: "1.0.0", phone: "0512345678" };
  const c = { req: { header: () => "", json: async () => body }, json: (x, s) => ({ x, s }) };
  const res = await app.routes.post["/api/notify/subscribe"](c);
  assert.equal(res.x.ok, true);
  assert.equal(res.x.kind, "fcm");
  const ins = pool.seen.find((q) => /INSERT INTO push_subs/.test(q.s));
  assert.equal(ins.args[2], `fcm:${"a".repeat(64)}`);
  assert.equal(ins.args[5], "fcm");
  assert.equal(ins.args[0], "512345678", "الجوال بيتطبّع ويتربط");
});

test("اشتراك من صفحة التتبع من غير جوال بياخد جوال الطلب من قاعدة البيانات", async () => {
  const pool = recordingPool({ order: { phone_norm: "599887766" } });
  const { app } = setup({ pool });
  const body = { subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } }, orderNo: "FC-9" };
  const c = { req: { header: () => "", json: async () => body }, json: (x) => ({ x }) };
  const res = await app.routes.post["/api/notify/subscribe"](c);
  assert.equal(res.x.linked, true);
  const ins = pool.seen.find((q) => /INSERT INTO push_subs/.test(q.s));
  assert.equal(ins.args[0], "599887766");
});

test("«وصل» و«اتفتح» بيتكتبوا على السطر الصح من غير أي بيانات شخصية", async () => {
  const pool = recordingPool();
  const { app } = setup({ pool });
  const c = { req: { header: () => "", json: async () => ({ id: 77, t: "click" }) }, json: (x) => ({ x }) };
  await app.routes.post["/api/notify/event"](c);
  const up = pool.seen.find((q) => /UPDATE push_log SET clicked_at/.test(q.s));
  assert.ok(up);
  assert.deepEqual(up.args, [77]);
});

test("فاصل الحملات بيتقرا من push_log بحملات بس (إشعار الطلب مش بيحرق الفاصل)", async () => {
  const pool = recordingPool();
  const { api } = setup({ pool });
  await api.pushedSince(["512345678"], 3);
  const q = pool.seen.find((x) => /DISTINCT phone_norm FROM push_log/.test(x.s));
  assert.ok(q, "لازم يسأل push_log");
  assert.match(q.s, /campaign_id IS NOT NULL/);
});
