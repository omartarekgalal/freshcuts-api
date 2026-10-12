/* ════════════════════════════════════════════════════════════════════════════
   ١٢/١٠/٢٠٢٦ — رصيد الولاء على واتساب (القالب الخدمي fc_loyalty_status) وتنبيه الفتح الخدمي (fc_open_notice).
   بيانات واقعية (كل ٣ طلبات، توصيل/استلام/طاولة، طلب مرفوض في النص)، والنص النهائي حرفياً، ومفيش إرسال
   إلا بكل الأقفال + مفتاح اللوحة + موافقة «التحديثات»، ومرة وحدة للطلب.
     node --test wa-loyalty-status.test.mjs
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const W = await import("./whatsapp.js");
const C = await import("./watemplates.js");
const L = await import("./loyalty.js");
const OW = await import("./openwait.js");
const { register: registerNotify } = await import("./notify.js");
W.registerCatalog(C);

const PHONE = "512345678";
const START = "2026-09-11T00:00:00Z";
const BAD = [...L.LOYALTY_COUNTED_SQL.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
/* طلبات العميل بالترتيب: واحد قبل بداية البرنامج، واحد مرفوض، والباقي محتسب */
const ORDERS = [
  { order_no: "W1780000000001", created_at: "2026-09-01T18:00:00Z", status: "delivered", option: "delivery", total: "70.00", table_no: null },   // قبل البداية
  { order_no: "W1790000000001", created_at: "2026-10-01T18:00:00Z", status: "delivered", option: "delivery", total: "86.50", table_no: null },   // 1
  { order_no: "W1790000000002", created_at: "2026-10-03T19:00:00Z", status: "rejected_refunded", option: "delivery", total: "40.00", table_no: null },
  { order_no: "W1790000000003", created_at: "2026-10-05T20:00:00Z", status: "delivered", option: "pickup", total: "65.00", table_no: 4 },        // 2 (طاولة)
  { order_no: "W1790000000004", created_at: "2026-10-08T21:00:00Z", status: "delivered", option: "pickup", total: "61.00", table_no: null },     // 3 (استلام) ⇒ اكتمل
  { order_no: "W1790000000005", created_at: "2026-10-11T22:00:00Z", status: "delivered", option: "delivery", total: "92.00", table_no: null },   // 4 ⇒ 1 من 3
];
const byNo = (no) => ORDERS.find((o) => o.order_no === no);

function world({ optins = { [PHONE]: { updates: true, marketing: false } }, notifications = { whatsappEnabled: true, whatsappStages: ["delivered"], whatsappLoyaltyStatus: true, pushEnabled: false },      // SW1: مرحلة «اتوصّل» مشغّلة
  loyalty = { enabled: true, every: 3, reward: "free_delivery", startedAt: START } } = {}) {
  const msgs = [], calls = [];
  const pool = { msgs, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: optins[p[0]] ? [optins[p[0]]] : [] };
    if (/bool_or\(order_no/.test(s)) {
      assert.ok(s.includes(L.LOYALTY_COUNTED_SQL), "the count uses the engine's status rule");
      const me = byNo(p[1]);
      const rows = ORDERS.filter((o) => p[0] === PHONE && o.created_at >= p[2] && !BAD.includes(o.status) && me && o.created_at <= me.created_at);
      return { rows: [{ n: rows.length, counted: rows.some((o) => o.order_no === p[1]) }] };
    }
    if (/FROM wa_messages WHERE order_no=\$1 AND template=\$2/.test(s)) return { rows: msgs.some((m) => m.order_no === p[0] && m.template === p[1] && !["failed", "skipped"].includes(m.status)) ? [{}] : [] };
    if (/^INSERT INTO wa_messages/i.test(s) && /'out'/.test(s)) { msgs.push({ wamid: p[0], phone_norm: p[1], template: p[2], order_no: p[4], stage: p[5], status: p[6], error: p[7], body: p[8] }); return { rows: [] }; }
    if (/FROM shop_orders WHERE order_no/i.test(s)) { const o = byNo(p[0]); return { rows: o ? [{ ...o, phone_norm: PHONE, name: "محمد العتيبي", refund_id: null }] : [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.L${calls.length}` }] }) }; };
  const settings = { notifications, cms: { loyalty }, waMaster: { enabled: true } };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: (x) => JSON.stringify(x), normPhone: (x) => x };
  const add = () => () => {};
  const app = { get: add(), post: add(), put: add(), delete: add() };
  const wa = W.register(app, ctx, { fetch, sendSms: async () => ({ ok: true }) });
  const notify = registerNotify(app, ctx, { wa, sendSms: async () => ({ ok: true }) });
  const sent = () => calls.filter((c) => /\/messages$/.test(c.url)).map((c) => c.body.template.name);
  const loyaltyMsg = () => msgs.filter((m) => m.template === "fc_loyalty_status");
  return { notify, wa, msgs, calls, sent, loyaltyMsg };
}
const ENV = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN"];
const withEnv = (vals, fn) => async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const ON = { WHATSAPP_ENABLED: "1", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" };
const TEXT = (no, a, st) => `تم احتساب طلبك رقم ${no} في برنامج ولاء فريش كاتس ✅\nرصيدك من الطلبات الآن ${a} من 3: ${st}.\nالتفاصيل في صفحة الطلب.`;

test("loyaltyStatusFor: position of the order in the cycle, never «0 من 3», worded count", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => { const x = L.loyaltyStatusFor(n, 3); return [x.progress, x.left, x.statusText]; }),
    [[1, 2, "باقي طلبين"], [2, 1, "باقي طلب واحد"], [3, 0, "اكتمل الرصيد"], [1, 2, "باقي طلبين"], [2, 1, "باقي طلب واحد"], [3, 0, "اكتمل الرصيد"]]);
  assert.equal(L.loyaltyStatusFor(1, 5).statusText, "باقي 4 طلبات");
  assert.equal(L.loyaltyStatusFor(1, 20).statusText, "باقي 19 طلب");
  assert.equal(L.loyaltyStatusFor(3, 3).reached, true);
  for (const bad of [[0, 3], [-1, 3], [NaN, 3], [2, 1], [2, 0], [null, 3], ["", 3]]) assert.equal(L.loyaltyStatusFor(...bad), null, JSON.stringify(bad));
});

test("the three places that count loyalty orders use the same status rule", () => {
  for (const f of ["shop.js", "cms.js"]) assert.ok(readFileSync(new URL(`./${f}`, import.meta.url), "utf8").includes(L.LOYALTY_COUNTED_SQL), f);
  assert.ok(readFileSync(new URL("./notify.js", import.meta.url), "utf8").includes("${LOYALTY_COUNTED_SQL}"));
});

test("«delivered» sends the balance once, with the exact text, for delivery, table and pickup orders", withEnv(ON, async () => {
  const cases = [
    ["W1790000000001", TEXT("W1790000000001", 1, "باقي طلبين"), ["fc_order_delivered", "fc_loyalty_status"]],
    ["W1790000000003", TEXT("W1790000000003", 2, "باقي طلب واحد"), ["fc_loyalty_status"]],     // table: no «تم التوصيل», still counted
    ["W1790000000004", TEXT("W1790000000004", 3, "اكتمل الرصيد"), ["fc_loyalty_status"]],      // pickup completes the cycle
    ["W1790000000005", TEXT("W1790000000005", 1, "باقي طلبين"), ["fc_order_delivered", "fc_loyalty_status"]],   // the rejected order in between is not counted
  ];
  for (const [no, text, names] of cases) {
    const w = world();
    await w.notify.orderStatusChanged(no, "delivered");
    assert.deepEqual(w.sent(), names, no);
    const m = w.loyaltyMsg();
    assert.equal(m.length, 1, no);
    assert.equal(m[0].body, text, no);
    assert.equal(m[0].order_no, no); assert.equal(m[0].stage, "loyalty_status"); assert.equal(m[0].status, "accepted");
    const payload = w.calls.at(-1).body;
    assert.equal(payload.to, `966${PHONE}`);
    assert.equal(payload.template.language.code, "ar");
    assert.deepEqual(payload.template.components.find((c) => c.type === "button").parameters, [{ type: "text", text: no }], "button = the order's own tracking link");
    assert.ok(!/\{\{|undefined|null|NaN| 0 من/.test(m[0].body), "no empty variable");
    // the same status arriving again sends nothing more
    await w.notify.orderStatusChanged(no, "delivered");
    assert.equal(w.loyaltyMsg().length, 1, `${no}: once per order`);
  }
}));

test("no balance message: other stages, toggle off (default), loyalty off, order before the start, no opt-in, uncounted order", withEnv(ON, async () => {
  const none = async (w, no = "W1790000000001", stage = "delivered") => { await w.notify.orderStatusChanged(no, stage); return w.sent().includes("fc_loyalty_status"); };
  assert.equal(await none(world(), "W1790000000001", "accepted"), false, "only after the order is handed over");
  assert.equal(await none(world(), "W1790000000001", "pos_created"), false);
  assert.equal(await none(world({ notifications: { whatsappEnabled: true, pushEnabled: false } })), false, "dashboard toggle is OFF by default");
  assert.equal(await none(world({ notifications: { whatsappEnabled: false, whatsappLoyaltyStatus: true, pushEnabled: false } })), false, "WhatsApp channel off");
  assert.equal(await none(world({ loyalty: { enabled: false, every: 3, startedAt: START } })), false);
  assert.equal(await none(world({ loyalty: { enabled: true, every: 3, startedAt: null } })), false);
  assert.equal(await none(world(), "W1780000000001"), false, "an order from before the programme started is not counted");
  assert.equal(await none(world(), "W1790000000002", "rejected_refunded"), false);
  const noOpt = world({ optins: {} });
  assert.equal(await none(noOpt), false, "utility needs the customer's updates opt-in");
  assert.equal(noOpt.calls.length, 0);
  const mktOnly = world({ optins: { [PHONE]: { updates: false, marketing: true } } });
  assert.equal(await none(mktOnly), false);
}));

test("nothing leaves while WHATSAPP_ENABLED is off, even with every dashboard switch on", withEnv({ WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1" }, async () => {
  const w = world();
  await w.notify.orderStatusChanged("W1790000000004", "delivered");
  assert.equal(w.calls.length, 0);
  assert.equal(w.loyaltyMsg().length, 0);
  assert.equal((await w.wa.sendOrderTemplateOnce({ order: { order_no: "W1790000000004", phone_norm: PHONE }, template: "fc_loyalty_status", data: {} })).skipped, "disabled");
}));

test("sendOrderTemplateOnce: an empty value blocks the send; unknown template refused", withEnv(ON, async () => {
  const w = world();
  const order = { order_no: "W1790000000001", phone_norm: PHONE };
  for (const data of [{ order, loyalty: { progress: "", every: 3, statusText: "باقي طلبين" } }, { order, loyalty: { progress: 1, every: 3 } }, { order: {}, loyalty: { progress: 1, every: 3, statusText: "باقي طلبين" } }, {}]) {
    assert.equal((await w.wa.sendOrderTemplateOnce({ order, template: "fc_loyalty_status", data })).skipped, "missing_param");
  }
  assert.equal((await w.wa.sendOrderTemplateOnce({ order, template: "fc_nope", data: {} })).error, "unknown_template");
  assert.equal(w.calls.length, 0);
}));

test("fc_loyalty_status stays a clean utility template: no reward name, no order push, only the order link", () => {
  const t = C.findTemplate("fc_loyalty_status");
  assert.equal(t.category, "UTILITY");
  assert.deepEqual(C.validateTemplate(t), []);
  assert.doesNotMatch(C.bodyOf(t), /اطلب|مكافأ|هدية|مجاني|كود|عرض|خصم/);
  for (const st of [1, 2, 3].map((n) => L.loyaltyStatusFor(n, 3).statusText).concat(L.loyaltyStatusFor(1, 9).statusText)) assert.doesNotMatch(st, /اطلب|مكافأ|هدية|مجاني|كود|عرض|خصم/, st);
  assert.deepEqual(C.buttonsOf(t).map((b) => b.url), ["https://freshcuts.sa/track/{{1}}"]);
  assert.equal(C.footerOf(t), "");
});

test("fc_open_notice: tied to the customer's own alert request (reference + time), no button, exact text from a waitlist row", () => {
  const t = C.findTemplate("fc_open_notice");
  assert.equal(t.category, "UTILITY");
  assert.deepEqual(C.buttonsOf(t), []);
  assert.doesNotMatch(C.bodyOf(t), /اطلب|كمّل|سلتك|سلة|هدية|مجاني|كود|عرض|خصم/);
  const data = OW.openNoticeData({ id: 1042, created_at: "2026-10-12T01:35:00Z" }, "2:00 ص");     // 04:35 Riyadh
  assert.deepEqual(data, { waitlist: { ref: "N-1042", requestedText: "يوم 12/10 الساعة 4:35 ص" }, hours: { closeText: "2:00 ص" } });
  const r = C.bindTemplate(t, data);
  assert.deepEqual(r.missing, []);
  assert.equal(C.bodyOf(t).replace(/\{\{(\d+)\}\}/g, (m, n) => r.body[n - 1]),
    "تنبيه الفتح رقم N-1042 المسجَّل يوم 12/10 الساعة 4:35 ص 🔔\nطلبت منّا تنبيهك عند فتح المطعم: فريش كاتس مفتوح الآن ويستقبل الطلبات حتى الساعة 2:00 ص.");
  assert.equal(OW.openNoticeData({ id: 7, created_at: new Date("2026-10-11T20:05:00Z") }, "3:00 ص").waitlist.requestedText, "يوم 11/10 الساعة 11:05 م");
  // a row without an id / time / closing hour can not be sent
  for (const [row, close, miss] of [[{ created_at: "2026-10-12T01:35:00Z" }, "2:00 ص", "waitlist.ref"], [{ id: 5 }, "2:00 ص", "waitlist.requestedText"], [{ id: 5, created_at: "x" }, "2:00 ص", "waitlist.requestedText"], [{ id: 5, created_at: "2026-10-12T01:35:00Z" }, "", "hours.closeText"]]) {
    assert.ok(C.bindTemplate(t, OW.openNoticeData(row, close)).missing.includes(miss), miss);
  }
});
