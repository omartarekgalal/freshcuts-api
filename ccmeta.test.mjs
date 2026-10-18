// CC1a — مركز التواصل (إنستجرام/فيسبوك): التحليل، النوافذ، الربط، البوابة، والويب هوك بقاعدة بيانات وهمية.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Hono } from "hono";
import { parseMetaWebhook, sendWindow, phoneInText, ccConfig, idOfKey, keyOf, chanOf, textBytes, register, DAY_MS } from "./ccmeta.js";

const IDS = { pageId: "P1", igId: "IG1" };

test("parse: إنستجرام رسالة واردة + صدى ردّنا + حذف + قراية", () => {
  const ev = parseMetaWebhook({ object: "instagram", entry: [{ id: "IG1", messaging: [
    { sender: { id: "U9" }, recipient: { id: "IG1" }, timestamp: 1760000000000, message: { mid: "m1", text: "كم سعر المشكل؟" } },
    { sender: { id: "IG1" }, recipient: { id: "U9" }, timestamp: 1760000001000, message: { mid: "m2", text: "أهلاً", is_echo: true } },
    { sender: { id: "U9" }, recipient: { id: "IG1" }, message: { mid: "m1", is_deleted: true } },
    { sender: { id: "U9" }, recipient: { id: "IG1" }, read: { mid: "m2" } },
    { sender: { id: "U9" }, recipient: { id: "IG1" }, message: { mid: "m3", attachments: [{ type: "image", payload: { url: "https://x/y.jpg" } }], reply_to: { story: { id: "s1" } } } },
  ] }] }, IDS);
  assert.equal(ev.length, 5);
  assert.deepEqual([ev[0].type, ev[0].platform, ev[0].extUser, ev[0].echo, ev[0].text], ["dm", "ig", "U9", false, "كم سعر المشكل؟"]);
  assert.equal(ev[0].at, new Date(1760000000000).toISOString());
  assert.deepEqual([ev[1].extUser, ev[1].echo], ["U9", true], "الصدى بيتسجّل على محادثة العميل (المستلم)");
  assert.deepEqual([ev[2].type, ev[2].mid], ["dm_deleted", "m1"]);
  assert.equal(ev[3].type, "read");
  assert.deepEqual([ev[4].storyReply, ev[4].attachments[0].type], [true, "image"]);
});

test("parse: كومنت إنستجرام + رد + منشن، وكومنت فيسبوك (إضافة/حذف) وكومنتنا", () => {
  const ig = parseMetaWebhook({ object: "instagram", entry: [{ id: "IG1", changes: [
    { field: "comments", value: { id: "c1", text: "لذيذ 😍", from: { id: "U5", username: "sara" }, media: { id: "M1" } } },
    { field: "comments", value: { id: "c2", text: "شكراً", from: { id: "IG1", username: "freshcuts.sa" }, media: { id: "M1" }, parent_id: "c1" } },
    { field: "mentions", value: { media_id: "M7", comment_id: "c9" } },
  ] }] }, IDS);
  assert.deepEqual(ig.map((e) => e.type), ["comment", "comment", "mention"]);
  assert.deepEqual([ig[0].commentId, ig[0].parentId, ig[0].postId, ig[0].fromName, ig[0].own], ["c1", null, "M1", "sara", false]);
  assert.deepEqual([ig[1].parentId, ig[1].own], ["c1", true]);
  const fb = parseMetaWebhook({ object: "page", entry: [{ id: "P1", changes: [
    { field: "feed", value: { item: "comment", verb: "add", comment_id: "P1_9_1", post_id: "P1_9", parent_id: "P1_9", message: "فين الفرع؟", from: { id: "F3", name: "Ali" }, created_time: 1760000000 } },
    { field: "feed", value: { item: "comment", verb: "add", comment_id: "P1_9_2", post_id: "P1_9", parent_id: "P1_9_1", message: "ابحر الشمالية", from: { id: "P1", name: "Fresh Cuts" } } },
    { field: "feed", value: { item: "comment", verb: "remove", comment_id: "P1_9_1", post_id: "P1_9" } },
    { field: "feed", value: { item: "reaction", verb: "add" } },
  ] }] }, IDS);
  assert.equal(fb.length, 3, "اللايكات مش محادثات");
  assert.deepEqual([fb[0].parentId, fb[0].fromName, fb[0].own], [null, "Ali", false], "parent = البوست ⇒ كومنت رئيسي");
  assert.deepEqual([fb[1].parentId, fb[1].own], ["P1_9_1", true]);
  assert.equal(fb[2].verb, "remove");
});

test("parse: ماسنجر postback، وأي object تاني يتجاهل", () => {
  const ev = parseMetaWebhook({ object: "page", entry: [{ messaging: [{ sender: { id: "F1" }, recipient: { id: "P1" }, timestamp: 1, postback: { title: "ابدأ", payload: "GET_STARTED", mid: "pb1" } }] }] }, IDS);
  assert.deepEqual([ev[0].type, ev[0].platform, ev[0].text, ev[0].mid], ["dm", "fb", "ابدأ", "pb1"]);
  assert.deepEqual(parseMetaWebhook({ object: "whatsapp_business_account", entry: [{}] }, IDS), []);
  assert.deepEqual(parseMetaWebhook(null, IDS), []);
});

test("sendWindow: ٢٤ ساعة حر › لحد ٧ أيام موظف بس › مقفول؛ الكومنت علني دايماً + خاص مرة خلال ٧ أيام", () => {
  const now = Date.parse("2026-10-18T10:00:00Z");
  const at = (h) => new Date(now - h * 3600_000).toISOString();
  assert.equal(sendWindow({ kind: "dm", last_in_at: at(2) }, now).mode, "open");
  assert.equal(sendWindow({ kind: "dm", last_in_at: at(30) }, now).mode, "human");
  assert.equal(sendWindow({ kind: "dm", last_in_at: at(24 * 8) }, now).mode, "closed");
  assert.equal(sendWindow({ kind: "dm", last_in_at: null }, now).mode, "closed");
  const c = sendWindow({ kind: "comment", created_at: at(5) }, now);
  assert.deepEqual([c.mode, c.open, c.privateOpen], ["public", true, true]);
  assert.equal(sendWindow({ kind: "comment", created_at: at(5), private_sent_at: at(1) }, now).privateOpen, false, "الرد الخاص مرة واحدة");
  assert.equal(sendWindow({ kind: "comment", created_at: at(24 * 8) }, now).privateOpen, false);
  assert.equal(DAY_MS, 86400000);
});

test("phoneInText: جوال سعودي بأي شكل، والأرقام التانية لأ", () => {
  assert.equal(phoneInText("رقمي ٠٥٥١٢٣٤٥٦٧ لو سمحت"), "551234567");
  assert.equal(phoneInText("+966 55 123 4567"), "551234567");
  assert.equal(phoneInText("0551234567"), "551234567");
  assert.equal(phoneInText("طلبي W12345"), null);
  assert.equal(phoneInText("كم سعر 2 كيلو"), null);
});

test("مفاتيح/إعدادات/قنوات", () => {
  assert.equal(keyOf(12), "cc-12"); assert.equal(idOfKey("cc-12"), 12); assert.equal(idOfKey("abc"), null); assert.equal(idOfKey("cc-1;drop"), null);
  assert.equal(chanOf("ig", "dm"), "ig_dm");
  const off = ccConfig({});
  assert.equal(off.enabled, false); assert.equal(off.channels.ig_dm.enabled, false, "كل حاجة مقفولة افتراضياً");
  const on = ccConfig({ cc: { enabled: true, channels: { ig_comment: { enabled: true }, fb_dm: { enabled: "yes" } } } });
  assert.deepEqual([on.enabled, on.channels.ig_comment.enabled, on.channels.fb_dm.enabled], [true, true, false], "true بس هي اللي بتشغّل");
  assert.equal(textBytes("أ"), 2);
});

/* ── قاعدة بيانات وهمية بسيطة: بتفهم الاستعلامات اللي الموديول بيعملها ── */
function fakeDb() {
  const ids = [], threads = [], msgs = [], health = {};
  let settings = {};
  const q = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^CREATE/.test(s) || s.startsWith("UPDATE cc_threads t SET last_at = x.at")) return { rows: [] };
    if (s.startsWith("INSERT INTO cc_webhook_health")) { health[p[0]] = (health[p[0]] || 0) + 1; return { rows: [] }; }
    if (s.startsWith("INSERT INTO cc_identities")) {
      let r = ids.find((x) => x.platform === p[0] && x.ext_id === p[1]);
      if (!r) { r = { id: ids.length + 1, platform: p[0], ext_id: p[1], username: p[2], name: p[3], phone_norm: null, profile_at: null }; ids.push(r); }
      else { r.username = p[2] ?? r.username; r.name = p[3] ?? r.name; }
      return { rows: [r] };
    }
    if (s.startsWith("UPDATE cc_identities SET profile_at")) { ids.find((x) => x.id === p[0]).profile_at = new Date(); return { rows: [] }; }
    if (s.startsWith("UPDATE cc_identities SET username")) return { rows: [] };
    if (s.startsWith("UPDATE cc_identities SET phone_norm = $2")) { Object.assign(ids.find((x) => x.id === p[0]), { phone_norm: p[1], linked_by: p[2] }); return { rows: [] }; }
    if (s.startsWith("INSERT INTO cc_threads")) {
      let t = threads.find((x) => x.platform === p[0] && x.kind === p[1] && x.ext_thread === p[2]);
      if (!t) { t = { id: threads.length + 1, platform: p[0], kind: p[1], ext_thread: p[2], identity_id: p[3], post_id: p[4], created_at: p[5] || new Date().toISOString(), unread: 0, status: "open", hidden: false }; threads.push(t); }
      else { t.identity_id = t.identity_id || p[3]; }
      return { rows: [t] };
    }
    if (s.startsWith("INSERT INTO cc_messages")) {
      if (p[1] && msgs.find((m) => m.ext_id === p[1])) return { rows: [] };
      const m = { id: msgs.length + 1, thread_id: p[0], ext_id: p[1], direction: p[2], kind: p[3], body: p[4], sender: p[6], staff_name: p[7], status: p[8], error: p[9], at: p[10] || new Date().toISOString(), deleted: false };
      msgs.push(m); return { rows: [{ id: m.id }] };
    }
    if (s.startsWith("UPDATE cc_threads SET last_in_at")) { const t = threads.find((x) => x.id === p[0]); Object.assign(t, { last_in_at: p[1] || new Date().toISOString(), last_at: new Date().toISOString(), last_text: p[2], last_dir: "in", unread: t.unread + 1, status: "open", suggested_phone: p[3] || t.suggested_phone }); return { rows: [] }; }
    if (s.startsWith("UPDATE cc_threads SET last_out_at")) { Object.assign(threads.find((x) => x.id === p[0]), { last_out_at: new Date().toISOString(), last_text: p[1], last_dir: "out" }); return { rows: [] }; }
    if (s.startsWith("UPDATE cc_threads SET unread = 0, read_at = NOW(), read_by")) { threads.find((x) => x.id === p[0]).unread = 0; return { rows: [] }; }
    if (s.startsWith("UPDATE cc_threads SET private_sent_at")) { threads.find((x) => x.id === p[0]).private_sent_at = new Date().toISOString(); return { rows: [] }; }
    if (s.startsWith("UPDATE cc_threads SET post_permalink")) return { rows: [] };
    if (s.startsWith("UPDATE cc_messages SET deleted")) { const m = msgs.find((x) => x.ext_id === p[0]); if (m) m.deleted = true; return { rows: [] }; }
    if (s.includes("FROM cc_threads t LEFT JOIN cc_identities i") && s.includes("WHERE t.id = $1")) {
      const t = threads.find((x) => x.id === p[0]); if (!t) return { rows: [] };
      const i = ids.find((x) => x.id === t.identity_id) || {};
      return { rows: [{ ...t, username: i.username, name: i.name, phone_norm: i.phone_norm, user_ext: i.ext_id }] };
    }
    if (s.startsWith("SELECT ext_id FROM cc_identities")) return { rows: ids.filter((x) => x.id === p[0]) };
    if (s.startsWith("UPDATE settings SET data = jsonb_set")) { settings = { ...settings, cc: JSON.parse(p[0]) }; return { rows: [] }; }
    throw new Error(`fake db: unhandled ${s.slice(0, 80)}`);
  };
  return { pool: { query: q }, ids, threads, msgs, health, settings: () => settings, setSettings: (x) => { settings = x; } };
}

function harness({ role = "owner", settings = {}, graph } = {}) {
  process.env.WHATSAPP_VERIFY_TOKEN = "vt"; process.env.WHATSAPP_APP_SECRET = "sec"; process.env.META_CAPI_TOKEN = "UT";
  process.env.FB_PAGE_ID = "P1"; process.env.IG_USER_ID = "IG1";
  const db = fakeDb(); db.setSettings(settings);
  const calls = [];
  const fetch = async (url, opt = {}) => {
    const u = new URL(url); calls.push({ method: opt.method || "GET", path: u.pathname, q: Object.fromEntries(u.searchParams), body: opt.body ? JSON.parse(opt.body) : null });
    const out = graph ? graph(u, opt) : null;
    if (out) return { ok: !out.error, status: out.error ? 400 : 200, json: async () => out };
    if (u.pathname.endsWith("/P1") && u.searchParams.get("fields") === "access_token") return { ok: true, status: 200, json: async () => ({ access_token: "PT" }) };
    return { ok: true, status: 200, json: async () => ({ id: "x" }) };
  };
  const app = new Hono();
  const events = [];
  const api = register(app, { pool: db.pool, requireAdmin: async () => null, getSettingsData: async () => db.settings(), log: { log() {}, error() {} } },
    { fetch, whoami: async () => ({ role, name: "Omar" }), broadcast: (e, d) => events.push([e, d]) });
  return { app, api, db, calls, events };
}
const sign = (raw) => `sha256=${crypto.createHmac("sha256", "sec").update(raw).digest("hex")}`;

test("webhook: التحقق + رفض التوقيع الغلط + رسالة إنستجرام بتتسجّل مرة واحدة واقتراح الجوال", async () => {
  const h = harness();
  assert.equal((await h.app.request("/api/meta/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42")).status, 200);
  assert.equal((await h.app.request("/api/meta/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42")).status, 403);
  const body = { object: "instagram", entry: [{ id: "IG1", messaging: [{ sender: { id: "U9" }, recipient: { id: "IG1" }, timestamp: Date.now(), message: { mid: "m1", text: "رقمي 0551234567" } }] }] };
  const raw = JSON.stringify(body);
  const bad = await h.app.request("/api/meta/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": "sha256=00" } });
  assert.deepEqual(await bad.json(), { ok: true, ignored: "signature" });
  await h.api.processWebhook(body); await h.api.processWebhook(body);      // ميتا بتعيد
  assert.equal(h.db.msgs.length, 1, "التكرار مايدخلش مرتين");
  assert.equal(h.db.threads[0].unread, 1);
  assert.equal(h.db.threads[0].suggested_phone, "551234567");
  assert.ok(h.events.some(([e]) => e === "cc_chat_update"));
  const ok = await h.app.request("/api/meta/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
  assert.deepEqual(await ok.json(), { ok: true });
});

test("الإرسال مقفول افتراضياً — ولا نداء لميتا", async () => {
  const h = harness();
  await h.api.processWebhook({ object: "instagram", entry: [{ messaging: [{ sender: { id: "U9" }, recipient: { id: "IG1" }, timestamp: Date.now(), message: { mid: "m1", text: "هلا" } }] }] });
  const before = h.calls.filter((c) => c.method === "POST").length;
  const r = await h.app.request("/api/cms/cc/threads/cc-1/reply", { method: "POST", body: JSON.stringify({ text: "أهلاً" }), headers: { "content-type": "application/json" } });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "cc_off");
  assert.equal(h.calls.filter((c) => c.method === "POST").length, before);
});

test("رد رسالة جوه النافذة = RESPONSE، وبعد ٢٤ ساعة = HUMAN_AGENT، وبعد ٧ أيام مرفوض", async () => {
  const h = harness({ settings: { cc: { enabled: true, channels: { ig_dm: { enabled: true } } } }, graph: (u, o) => (o.method === "POST" && u.pathname.endsWith("/P1/messages") ? { message_id: `mid-${Math.random()}` } : null) });
  await h.api.processWebhook({ object: "instagram", entry: [{ messaging: [{ sender: { id: "U9" }, recipient: { id: "IG1" }, timestamp: Date.now(), message: { mid: "m1", text: "هلا" } }] }] });
  const send = (text) => h.app.request("/api/cms/cc/threads/cc-1/reply", { method: "POST", body: JSON.stringify({ text }), headers: { "content-type": "application/json" } });
  assert.equal((await send("أهلاً بك")).status, 200);
  let post = h.calls.filter((c) => c.method === "POST").at(-1);
  assert.deepEqual([post.body.recipient.id, post.body.messaging_type, post.body.tag, post.q.access_token], ["U9", "RESPONSE", undefined, "PT"]);
  h.db.threads[0].last_in_at = new Date(Date.now() - 30 * 3600_000).toISOString();
  assert.equal((await send("متابعة")).status, 200);
  post = h.calls.filter((c) => c.method === "POST").at(-1);
  assert.deepEqual([post.body.messaging_type, post.body.tag], ["MESSAGE_TAG", "HUMAN_AGENT"]);
  h.db.threads[0].last_in_at = new Date(Date.now() - 8 * DAY_MS).toISOString();
  const late = await send("متأخر");
  assert.equal(late.status, 400); assert.equal((await late.json()).error, "window_closed");
  assert.equal(h.db.msgs.filter((m) => m.direction === "out").length, 2);
});

test("كومنت: رد علني على المسار الصح لكل منصة + رد خاص مرة واحدة", async () => {
  const h = harness({ settings: { cc: { enabled: true, channels: { ig_comment: { enabled: true }, fb_comment: { enabled: true } } } } });
  await h.api.processWebhook({ object: "instagram", entry: [{ changes: [{ field: "comments", value: { id: "c1", text: "بكم؟", from: { id: "U5", username: "sara" }, media: { id: "M1" } } }] }] });
  await h.api.processWebhook({ object: "page", entry: [{ changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "P1_9_1", post_id: "P1_9", parent_id: "P1_9", message: "فين؟", from: { id: "F3", name: "Ali" } } }] }] });
  const reply = (k, b) => h.app.request(`/api/cms/cc/threads/${k}/reply`, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
  assert.equal((await reply("cc-1", { text: "أهلاً سارة" })).status, 200);
  assert.ok(h.calls.some((c) => c.method === "POST" && c.path.endsWith("/c1/replies") && c.q.access_token === "UT"));
  assert.equal((await reply("cc-2", { text: "حياك" })).status, 200);
  assert.ok(h.calls.some((c) => c.method === "POST" && c.path.endsWith("/P1_9_1/comments") && c.q.access_token === "PT"));
  assert.equal((await reply("cc-1", { text: "الأسعار في الرابط", mode: "private" })).status, 200);
  const pr = h.calls.filter((c) => c.path.endsWith("/P1/messages")).at(-1);
  assert.deepEqual(pr.body.recipient, { comment_id: "c1" });
  const again = await reply("cc-1", { text: "تاني", mode: "private" });
  assert.equal(again.status, 400); assert.equal((await again.json()).error, "private_closed");
});

test("الأدوار: المالية/التسويق برا، والربط بجوال للي بيشوف الأرقام بس، والإعدادات للمالك", async () => {
  const mk = harness({ role: "marketing" });
  assert.equal((await mk.app.request("/api/cms/cc/threads")).status, 403);
  const ops = harness({ role: "operations", settings: { waHub: { inboxRoles: ["operations"], phoneRoles: [] } } });
  await ops.api.processWebhook({ object: "instagram", entry: [{ messaging: [{ sender: { id: "U9" }, recipient: { id: "IG1" }, timestamp: Date.now(), message: { mid: "m1", text: "هلا" } }] }] });
  assert.equal((await ops.app.request("/api/cms/cc/threads/cc-1/link", { method: "POST", body: JSON.stringify({ phone: "0551234567" }), headers: { "content-type": "application/json" } })).status, 403);
  assert.equal((await ops.app.request("/api/cms/cc/settings", { method: "PUT", body: JSON.stringify({ enabled: true }), headers: { "content-type": "application/json" } })).status, 403);
  const own = harness();
  await own.api.processWebhook({ object: "instagram", entry: [{ messaging: [{ sender: { id: "U9" }, recipient: { id: "IG1" }, timestamp: Date.now(), message: { mid: "m1", text: "هلا" } }] }] });
  const l = await own.app.request("/api/cms/cc/threads/cc-1/link", { method: "POST", body: JSON.stringify({ phone: "0551234567" }), headers: { "content-type": "application/json" } });
  assert.equal(l.status, 200); assert.equal(own.db.ids[0].phone_norm, "551234567");
  const s = await own.app.request("/api/cms/cc/settings", { method: "PUT", body: JSON.stringify({ enabled: true, channels: { ig_dm: { enabled: true } } }), headers: { "content-type": "application/json" } });
  assert.equal(s.status, 200); assert.deepEqual([own.db.settings().cc.enabled, own.db.settings().cc.channels.ig_dm.enabled, own.db.settings().cc.channels.fb_dm.enabled], [true, true, false]);
});
