/* LR1: الحدث الحي wa_chat_update + آخر رسالة في القايمة — node --test walive.test.mjs
   الويب هوك الحقيقي (whatsapp.processWebhook) لحد حدث البورتال؛ مفيش شبكة ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const W = await import("./whatsapp.js");
const S = await import("./wastaff.js");
const H = await import("./wahub.js");

const CUST = "512345678", SALT = "salt-1", BIZ = "966546715683";
const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");
const ENV = ["WHATSAPP_ENABLED", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_WABA_ID"];
const withEnv = (vals, fn) => async () => { const saved = {}; for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, vals);
  try { await fn(); } finally { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };

function world() {
  const db = { settings: {}, sql: [] };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim(); db.sql.push(s);
    if (/^INSERT INTO wa_messages/i.test(s)) return { rows: [{ id: 1 }], rowCount: 1 };
    if (/^UPDATE wa_messages SET status = CASE/i.test(s)) return p[0] === "wamid.KNOWN" ? { rows: [{ id: 5, phone_norm: CUST, status: p[1] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/^SELECT phone_norm FROM wa_threads WHERE md5/i.test(s)) return { rows: keyOf(CUST) === p[1] && p[0] === SALT ? [{ phone_norm: CUST }] : [] };
    return { rows: [], rowCount: 0 };
  } };
  const fakeApp = () => { const routes = {}; const add = (m) => (pth, h) => { routes[`${m} ${pth}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => ({}), jb: (x) => JSON.stringify(x), isOwner: async () => true,
    normPhone: (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "") };
  const wa = W.register(fakeApp(), ctx, { fetch: async () => { throw new Error("no network in this test"); }, sendSms: async () => ({ ok: true }) });
  const events = []; const app = fakeApp();
  const st = S.register(app, ctx, { wa, hub: () => ({}), requirePortal: async () => ({ user: { id: "s1", name: "سلمى", role: "cashier" } }), keySalt: SALT, log: { error() {} }, noTimer: true, broadcast: (e, d) => events.push([e, d]) });
  const call = (route, { param = {} } = {}) => app.routes[route]({ req: { json: async () => ({}), header: () => undefined, query: () => undefined, param: (n) => param[n] }, json: (body, status = 200) => ({ body, status }) });
  return { db, wa, st, events, call };
}
const hook = (value, field = "messages") => ({ entry: [{ changes: [{ field, value: { metadata: { phone_number_id: "PHONE1", display_phone_number: BIZ }, ...value } }] }] });

test("wa_chat_update: fired for a customer message, a message sent from the restaurant phone, a delivery status and a read — key only, no text, phone or name", withEnv({ WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "PHONE1" }, async () => {
  const w = world();
  await w.wa.processWebhook(hook({ contacts: [{ wa_id: "966" + CUST, profile: { name: "محمد العتيبي" } }], messages: [{ id: "wamid.IN1", from: "966" + CUST, type: "text", timestamp: "1760356800", text: { body: "نص سري من العميل" } }] }));
  await w.wa.processWebhook(hook({ message_echoes: [{ id: "wamid.E1", from: BIZ, to: "966" + CUST, type: "text", timestamp: "1760356805", text: { body: "رد الكاشير" } }] }, "smb_message_echoes"));
  await w.wa.processWebhook(hook({ statuses: [{ id: "wamid.KNOWN", status: "delivered", recipient_id: "966" + CUST, timestamp: "1760356810" }, { id: "wamid.UNKNOWN", status: "read", recipient_id: "966500000000", timestamp: "1760356811" }] }));
  const r = await w.call("POST /api/portal/wa/chats/:key/read", { param: { key: keyOf(CUST) } });
  assert.equal(r.status, 200);
  const ev = w.events.filter((e) => e[0] === "wa_chat_update").map((e) => e[1]);
  assert.deepEqual(ev.map((e) => [e.what, e.dir]), [["message", "in"], ["message", "out"], ["status", "out"], ["read", null]]);
  for (const e of ev) { assert.equal(e.key, keyOf(CUST)); assert.deepEqual(Object.keys(e).sort(), ["at", "dir", "key", "what"]); assert.ok(Number.isFinite(Date.parse(e.at))); }
  const all = JSON.stringify(w.events);
  assert.ok(!all.includes(CUST) && !all.includes("نص سري") && !all.includes("رد الكاشير") && !all.includes("محمد"), "no phone, text or name in any event");
}));

test("no salt or no stream ⇒ no event and nothing breaks", withEnv({ WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "PHONE1" }, async () => {
  const w = world();
  assert.equal(typeof w.st.chatUpdate, "function");
  w.st.chatUpdate("not-a-phone", "message", "in"); w.st.chatUpdate(null, "read");
  assert.equal(w.events.length, 0);
}));

test("chat list: the preview, direction and time come from the last stored message (highest id), not from second-granular timestamps", async () => {
  const ago = (m) => new Date(Date.parse("2026-10-13T15:00:00Z") - m * 60000).toISOString();
  const rows = [
    /* رسالة العميل اتسجّلت بوقت واتساب (ثانية كاملة) بعد رد البوت اللي اتسجّل بوقت السيرفر ⇒ صف المحادثة فضل على القديم */
    { phone_norm: "511111111", last_in_at: ago(1), last_at: ago(1), last_text: "رد البوت القديم", last_dir: "out", unread: 1, name: "أحمد", orders: 1, last_source: "api", lm_dir: "in", lm_body: "رسالة العميل\nالأحدث", lm_template: null, lm_at: ago(1.01) },
    { phone_norm: "522222222", last_in_at: ago(9), last_at: ago(9), last_text: "x", last_dir: "in", unread: 0, name: null, orders: 0, last_source: "campaign", lm_dir: "out", lm_body: null, lm_template: "fc_winback", lm_at: ago(8) },
    { phone_norm: "533333333", last_in_at: ago(20), last_at: ago(20), last_text: "من غير رسايل متخزّنة", last_dir: "in", unread: 0, name: null, orders: 0, last_source: null },
  ];
  const sql = [];
  const pool = { async query(q) { const s = String(q).replace(/\s+/g, " ").trim(); sql.push(s);
    if (/^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.last_text/i.test(s)) return { rows };
    if (/^SELECT count\(\*\)::int AS total/i.test(s)) return { rows: [{ total: 3 }] };
    return { rows: [] }; } };
  const routes = {}; const add = (m) => (pth, h) => { routes[`${m} ${pth}`] = h; };
  const hub = H.register({ get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }, { pool, requireAdmin: async () => null, getSettingsData: async () => ({}) },
    { whoami: async () => ({ role: "owner", name: "عمر" }), keySalt: SALT, log: { error() {} }, timer: false, now: () => Date.parse("2026-10-13T15:00:00Z") });
  const out = await hub.listThreads({ filter: "all", full: true });
  const [a, b, c] = out.threads;
  assert.deepEqual([a.lastText, a.lastDir], ["رسالة العميل الأحدث", "in"]);
  assert.equal(a.lastAt, ago(1), "the time never goes backwards");
  assert.deepEqual([b.lastText, b.lastDir, b.lastAt, b.lastSource], ["[قالب: fc_winback]", "out", ago(8), "campaign"]);
  assert.deepEqual([c.lastText, c.lastDir, c.lastAt], ["من غير رسايل متخزّنة", "in", ago(20)], "a chat with no stored message keeps the thread row's values");
  assert.ok(sql.some((s) => /LEFT JOIN LATERAL \(SELECT m\.source, m\.direction, m\.body, m\.template, m\.created_at, m\.status FROM wa_messages m WHERE m\.phone_norm = t\.phone_norm AND COALESCE\(m\.source, 'api'\) <> 'history' ORDER BY m\.id DESC LIMIT 1\) lm ON TRUE/.test(s)), "the newest row by id is the last message (TK1a: with its status in the same row)");
});
