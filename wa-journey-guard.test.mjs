/* CJ1a — الحارس المركزي (whatsapp.js guardSend) بيطبّق «مفيش رسايل ورا بعض» وسقف رسايل الطلب:
     • proactive:true والعميل واصلته رسالة من أي نظام من أقل من burstHoldMin ⇒ burst_hold + until، من غير أي طلب لميتا — والرد على العميل / تحديث الطلب مش بيتلمس
     • رسالة عن طلب (orderNo + stage): «بنجهّز» بتتشال بعد «استلمنا» (order_cap_low، policy:true ⇒ مفيش SMS بدلها)، والخامسة بتتشال (order_cap)، والتوصيل عمره ما يتشال
     • المفتاح الرئيسي journeyBursts مقفول ⇒ زي الأول
   node --test wa-journey-guard.test.mjs — عالم صغير بنفس شكل wa-guard.test.mjs. */
import test from "node:test";
import assert from "node:assert/strict";

const W = await import("./whatsapp.js");

const ENV_KEYS = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID", "META_CAPI_TOKEN", "WHATSAPP_TEST_PHONE_ID"];
function withEnv(vals, fn) {
  return async () => {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vals);
    try { await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}
const ALLOW = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "PHONE1", WHATSAPP_ENABLED: "1" };
const CUST = "512345678";
const MIN = 60_000;

function fakeApp() { const add = () => () => {}; return { get: add(), post: add(), put: add(), delete: add() }; }
/* عالم: نافذة مفتوحة للعميل، موافق على التحديثات، آخر رسالة طالعة له (lastOut)، وعدد رسايل الطلب (sentByOrder) */
function world({ waBot = {}, lastOut = null, sentByOrder = {}, inbound = [CUST] } = {}) {
  const db = { settings: { notifications: { whatsappEnabled: true, whatsappStages: Object.keys(W.STAGE_TEMPLATES) }, waMaster: { enabled: true }, waBot: { testPhones: ["0544775082"], ...waBot } },
    optins: { [CUST]: { updates: true, marketing: true } }, inbound: [...inbound], msgs: [], skips: [], queries: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    db.queries.push(s);
    if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: db.inbound.includes(p[0]) ? [{}] : [] };
    if (/FROM wa_optins WHERE phone_norm/i.test(s)) return { rows: db.optins[p[0]] ? [db.optins[p[0]]] : [] };
    if (/AS last_out FROM/i.test(s)) { if (db.lastOutThrows) throw new Error("db down"); return { rows: [{ last_out: typeof db.lastOut === "function" ? db.lastOut() : db.lastOut }] }; }
    if (/count\(\*\)::int AS n FROM wa_messages WHERE order_no=\$1/i.test(s)) return { rows: [{ n: Number(db.sentByOrder[p[0]] || 0) }] };
    if (/^INSERT INTO wa_policy_skips/i.test(s)) { db.skips.push({ order_no: p[0], phone: p[1], stage: p[2], reason: p[3] }); return { rows: [], rowCount: 1 }; }
    if (/FROM cms_contacts/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO wa_messages/i.test(s)) { db.msgs.push({ wamid: p[0], phone_norm: p[1], status: p[6] }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  db.lastOut = lastOut; db.sentByOrder = sentByOrder;
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.G${calls.length}` }] }) }; };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), jb: (x) => JSON.stringify(x),
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch, sendSms: async () => ({ ok: true }) });
  return { db, pool, calls, wa };
}
const text = (body = "أهلاً") => ({ type: "text", text: { body } });
const ago = (min) => new Date(Date.now() - min * MIN).toISOString();

test("(١) الهدوء: رسالة طالعة من دقيقتين ⇒ المبادِرة burst_hold بميعاد ≈ +٨ دقايق ومفيش طلب لميتا؛ نفس الرسالة من غير proactive (رد على العميل) بتعدّي", withEnv(ALLOW, async () => {
  const w = world({ lastOut: ago(2) });
  const g = await w.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot", proactive: true });
  assert.equal(g.ok, false); assert.equal(g.reason, "burst_hold");
  const until = Date.parse(g.until); assert.ok(until > Date.now() + 7 * MIN && until <= Date.now() + 8 * MIN + 2000, g.until);
  const r = await w.wa.sendFreeform({ phoneNorm: CUST, payload: text("العرض لسه متاح"), source: "bot", proactive: true });
  assert.equal(r.ok, false); assert.equal(r.skipped, "burst_hold"); assert.ok(r.until, "المنادي بياخد الميعاد عشان يأجّل");
  assert.equal(w.calls.length, 0, "ولا طلب لميتا");
  assert.equal(w.db.msgs.length, 0, "ولا صف «فشل» في السجل — ده تأجيل مش فشل");
  const reply = await w.wa.sendFreeform({ phoneNorm: CUST, payload: text("طلبك في المطبخ"), source: "bot" });
  assert.equal(reply.ok, true, "الرد على كلام العميل مش بيستنى");
  assert.equal(w.calls.length, 1);
}));

test("(١) الهدوء بيخلص: آخر رسالة من ١٢ دقيقة ⇒ المبادِرة بتعدّي؛ ومفيش رسالة طالعة أصلاً ⇒ بتعدّي؛ والإعداد من اللوحة بيغيّر المدة", withEnv(ALLOW, async () => {
  const w = world({ lastOut: ago(12) });
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot", proactive: true })).ok, true);
  w.db.lastOut = null;
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot", proactive: true })).ok, true);
  const w2 = world({ lastOut: ago(12), waBot: { burstHoldMin: 20 } });
  assert.equal((await w2.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot", proactive: true })).reason, "burst_hold");
  const w3 = world({ lastOut: ago(1), waBot: { journeyBursts: false } });
  assert.equal((await w3.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot", proactive: true })).ok, true, "المفتاح الرئيسي مقفول ⇒ زي الأول");
}));

test("(١) الحملة وطلب التقييم مبادِرين دايماً: قالب حملة لعميل واصلته رسالة من دقيقة ⇒ burst_hold (قبل أي موافقة)، وقالب التقييم كذلك؛ تحديث الطلب (source window/api) لأ", withEnv(ALLOW, async () => {
  const w = world({ lastOut: ago(1) });
  const t = Object.entries(W.TEMPLATES).find(([, x]) => x.category === "MARKETING" && typeof x.bind === "function");
  assert.ok(t, "فيه قالب تسويقي في الكتالوج");
  const camp = await w.wa.sendTemplate({ phoneNorm: CUST, template: t[0], params: { body: [] }, source: "campaign" });
  assert.equal(camp.skipped, "burst_hold"); assert.ok(camp.until);
  const rv = await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", source: "review", orderNo: "W1", stage: "review", proactive: true });
  assert.equal(rv.reason, "burst_hold");
  const upd = await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: W.TEMPLATES.fc_order_preparing.bind({ order_no: "W1" }), orderNo: "W1", stage: "on_the_way", source: "window" });
  assert.equal(upd.ok, true, "تحديث الطلب مش مبادِر — بيطلع في وقته");
  assert.equal(w.calls.length, 1);
}));

test("(١) القراءة فشلت ⇒ المبادِرة تستنى دقيقة (مش تتبعت ومش تفشل)", withEnv(ALLOW, async () => {
  const w = world(); w.db.lastOutThrows = true;
  const g = await w.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot", proactive: true });
  assert.equal(g.reason, "burst_hold"); assert.ok(Date.parse(g.until) - Date.now() <= MIN + 1000);
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot" })).ok, true, "الرد العادي مش محتاج القراءة دي");
}));

test("(٤) سقف الطلب ٤: بعد «استلمنا» (١) «بنجهّز» بتتشال order_cap_low بـpolicy:true (مفيش SMS بدلها) وبتتسجّل في wa_policy_skips؛ «مع المندوب» بتعدّي؛ الخامسة order_cap؛ التوصيل عمره ما يتشال", withEnv(ALLOW, async () => {
  const w = world({ sentByOrder: { W1: 1, W4: 4, W9: 9 } });
  const P = (no) => W.TEMPLATES.fc_order_preparing.bind({ order_no: no });
  const low = await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: P("W1"), orderNo: "W1", stage: "accepted", source: "window" });
  assert.deepEqual(low, { ok: false, skipped: "order_cap_low", policy: true });
  assert.deepEqual(w.db.skips, [{ order_no: "W1", phone: CUST, stage: "accepted", reason: "order_cap_low" }]);
  const free = await w.wa.sendFreeform({ phoneNorm: CUST, payload: text("بنجهّز طلبك"), source: "window", orderNo: "W1", stage: "accepted" });
  assert.equal(free.skipped, "order_cap_low", "الرسالة الحرة جوّه النافذة بنفس السقف");
  assert.equal((await w.wa.sendTemplate({ phoneNorm: CUST, template: "fc_order_preparing", params: P("W1"), orderNo: "W1", stage: "on_the_way", source: "window" })).ok, true);
  const fifth = await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W4", stage: "review", source: "review" });
  assert.equal(fifth.reason, "order_cap"); assert.equal(fifth.policy, true);
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W9", stage: "delivered", source: "window" })).ok, true, "التوصيل دايماً");
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W9", stage: "rejected_refunded", source: "window" })).ok, true, "الاسترداد دايماً");
  assert.equal(w.calls.length, 1, "طلب واحد لميتا («مع المندوب») بس");
}));

test("(٤) السقف مابيلمسش: الرد على العميل عن طلبه (source reply)، رسالة من غير طلب، الفريق/المندوب، أو والمفتاح مقفول — وماقدرناش نعدّ ⇒ تحديث الطلب بيعدّي", withEnv(ALLOW, async () => {
  const w = world({ sentByOrder: { W9: 9 } });
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "reply", orderNo: "W9", stage: "accepted" })).ok, true);
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot" })).ok, true, "من غير طلب = مفيش سقف");
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W9" })).ok, true, "من غير مرحلة = مفيش سقف (مش بتاع رحلة الطلب)");
  const off = world({ sentByOrder: { W9: 9 }, waBot: { journeyBursts: false } });
  assert.equal((await off.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W9", stage: "accepted", source: "window" })).ok, true);
  const zero = world({ sentByOrder: { W9: 9 }, waBot: { orderMsgCap: 0 } });
  assert.equal((await zero.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W9", stage: "accepted", source: "window" })).ok, true, "صفر = من غير سقف");
  const broken = world({ sentByOrder: { W9: 9 } });
  const q0 = broken.pool.query; broken.pool.query = async (sql, p) => { if (/AS n FROM wa_messages WHERE order_no/.test(String(sql))) throw new Error("db"); return q0(sql, p); };
  assert.equal((await broken.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W9", stage: "accepted", source: "window" })).ok, true, "العدّ فشل ⇒ التحديث بيعدّي (السقف مش موافقة)");
}));

test("الأقفال اللي قبل كده لسه هي اللي بتحكم: عميل موقِّف التحديثات ⇒ opted_out حتى لو السقف سامح؛ ونافذة مقفولة ⇒ window_closed قبل الهدوء", withEnv(ALLOW, async () => {
  const w = world({ lastOut: ago(1) });
  w.db.optins[CUST] = { updates: false, marketing: false, stopped_at: "2026-10-13T08:00:00Z" };
  assert.equal((await w.wa.guardSend({ phoneNorm: CUST, kind: "template", template: "fc_order_preparing", orderNo: "W1", stage: "on_the_way", source: "window" })).reason, "opted_out");
  const closed = world({ lastOut: ago(1), inbound: [] });
  assert.equal((await closed.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot", proactive: true })).reason, "burst_hold", "الهدوء بيتقال الأول (التأجيل أرخص من قفل النافذة للمنادي)");
  assert.equal((await closed.wa.guardSend({ phoneNorm: CUST, kind: "session", source: "bot" })).reason, "window_closed");
}));
