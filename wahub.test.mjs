/* قسم واتساب في اللوحة — مسارات القراءة (N1, N3, N7, العدّادان) — node --test wahub.test.mjs
   قاعدة وهمية، مفيش شبكة حقيقية ولا أي إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, hubRoles, botState, watchedValues, diffWatched, maskPhone, DEFAULT_INBOX_ROLES } from "./wahub.js";
import { sectionOf, DEFAULT_PERMS } from "./cms.js";
import { SERVER_OWNED_PATHS } from "./settings-guard.js";
import * as W from "./whatsapp.js";

const NOW = Date.parse("2026-10-13T18:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const T = (pn, x = {}) => ({ phone_norm: pn, last_in_at: ago(30), last_at: ago(20), last_text: "السلام عليكم", last_dir: "in", unread: 1, order_no: null, name: "أحمد", orders: 3,
  muted_until: null, mute_reason: null, muted_by: null, handoff_at: null, handoff_reason: null, ad: false, last_source: "api", last_echo_at: null, ...x });

function world({ role = "owner", settings = {}, threads = [], messages = [], botLog = [], metaList = null, orders7d = 21, queued = { n: 12, people: 9 } } = {}) {
  const db = { settings: { ...settings }, threads: threads.map((t) => ({ ...t })), log: [], snap: null, sql: [], unmuted: [], replies: [] };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    db.sql.push(s);
    if (/^CREATE TABLE IF NOT EXISTS wa_settings_log/i.test(s)) return { rows: [] };
    if (/^SELECT phone_norm FROM wa_threads WHERE md5\(\$1 \|\| ':' \|\| phone_norm\) = \$2/i.test(s)) {
      const crypto = await import("node:crypto");
      const hit = db.threads.find((t) => crypto.createHash("md5").update(`${p[0]}:${t.phone_norm}`).digest("hex") === p[1]);
      return { rows: hit ? [{ phone_norm: hit.phone_norm }] : [] };
    }
    if (/^SELECT count\(\*\)::int AS total,/i.test(s)) return { rows: [{ total: db.threads.length, waiting: db.threads.filter((t) => t.handoff_at).length, bot: 1, muted: 0, ad: 0,
      unread: db.threads.filter((t) => t.unread).length, unread_messages: db.threads.reduce((a, t) => a + t.unread, 0), oldest_waiting: db.threads.map((t) => t.handoff_at).filter(Boolean).sort()[0] || null }] };
    if (/^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.last_text/i.test(s)) {
      let rows = [...db.threads].sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at));
      const before = p.find((x) => typeof x === "string" && /^\d{4}-\d\d-\d\dT/.test(x));
      if (before) rows = rows.filter((t) => Date.parse(t.last_at) < Date.parse(before));
      return { rows: rows.slice(0, p[p.length - 1]) };
    }
    if (/^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.unread/i.test(s)) return { rows: db.threads.filter((t) => t.phone_norm === p[0]).map((t) => ({ ...t, optin_updates: true, optin_marketing: false, stopped_at: null })) };
    if (/^SELECT wamid, direction, status, error, body, template, category, order_no, created_at, source, pricing FROM wa_messages/i.test(s)) {
      let rows = messages.filter((m) => m.phone_norm === p[0]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      if (p[1]) rows = rows.filter((m) => Date.parse(m.created_at) < Date.parse(p[1]));
      return { rows: rows.slice(0, p[2]) };
    }
    if (/^SELECT wamid, at, decision, reason, reply_key, handoff FROM wa_bot_log/i.test(s)) return { rows: botLog.filter((l) => l.phone_norm === p[0]) };
    if (/^UPDATE wa_threads SET unread=0/i.test(s)) { const t = db.threads.find((x) => x.phone_norm === p[0]); if (t) { t.unread = 0; t.read_by = p[1]; } return { rows: [], rowCount: t ? 1 : 0 }; }
    if (/^SELECT template, count\(\*\) FILTER/i.test(s)) return { rows: [{ template: "fc_order_preparing", sent: 40, delivered: 38, read: 30, failed: 2, last_at: ago(60) }] };
    if (/^SELECT name, language, event, reason, at FROM wa_template_events/i.test(s)) return { rows: [{ name: "fc_order_preparing", language: "ar", event: "APPROVED", reason: null, at: ago(5000) }] };
    if (/^SELECT data FROM wa_settings_snap/i.test(s)) return { rows: db.snap ? [{ data: db.snap }] : [] };
    if (/^INSERT INTO wa_settings_snap/i.test(s)) { db.snap = JSON.parse(p[0]); return { rows: [] }; }
    if (/^UPDATE wa_settings_snap/i.test(s)) { db.snap = JSON.parse(p[0]); return { rows: [] }; }
    if (/^INSERT INTO wa_settings_log/i.test(s)) { db.log.push({ id: db.log.length + 1, at: new Date(NOW + db.log.length).toISOString(), key: p[0], from_v: JSON.parse(p[1]), to_v: JSON.parse(p[2]), who: p[3] }); return { rows: [] }; }
    if (/^SELECT id, at, key, from_v, to_v, who FROM wa_settings_log/i.test(s)) return { rows: db.log.filter((r) => !p[0] || r.key.startsWith(p[0])).slice().reverse().slice(0, p[1]) };
    if (/FROM shop_orders WHERE created_at >= \$1 AND created_at < \$2/i.test(s)) { db.ordersRange = [p[0], p[1]]; return { rows: [{ n: orders7d }] }; }
    if (/FROM wa_send_queue q JOIN wa_send_jobs j/i.test(s)) return { rows: [queued] };
    throw new Error("unexpected SQL: " + s.slice(0, 90));
  } };
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST") };
  let user = role ? { name: "منى", role } : null;
  const fetches = [];
  const fetch = async (url, init) => { fetches.push({ url: String(url), auth: init?.headers?.Authorization });
    return metaList ? { ok: true, status: 200, json: async () => ({ data: metaList }) } : { ok: false, status: 400, json: async () => ({ error: { message: "nope" } }) }; };
  const inboxCalls = [];
  const api = register(app, { pool, requireAdmin: async (c) => (user ? null : c.json({ ok: false, error: "unauthorized" }, 401)), getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)) },
    { whoami: async () => user, now: () => NOW, timer: false, keySalt: "test-salt", fetch, log: { error() {} },
      wa: { token: () => "systok", idsInUse: () => ({ wabaId: "WABA1" }), gate: async () => { if (db.gateThrows) throw new Error("x"); return db.gate === undefined ? "disabled" : db.gate; } },
      waInbox: () => ({ replyText: async (a) => { inboxCalls.push(["text", a]); return db.nextReply || { ok: true, wamid: "wamid.R1", window: { open: true } }; },
        replyTemplate: async (a) => { inboxCalls.push(["template", a]); return db.nextReply || { ok: true, wamid: "wamid.T1" }; } }),
      bot: () => ({ unmuteChat: async (pn) => { db.unmuted.push(pn); return { ok: true }; }, botConfig: async () => ({ humanPauseMin: 30 }) }), staff: () => db.staff || null });
  const call = (method, path, { params = {}, query = {}, json = {} } = {}) => routes[`${method} ${path}`]({
    req: { param: (k) => params[k], query: (k) => query[k], json: async () => json, method, path }, json: (body, status = 200) => ({ body, status }) });
  return { db, api, call, fetches, inboxCalls, setUser: (u) => { user = u; } };
}

/* ══ N1: مين يشوف ══════════════════════════════════════════════════════════ */
test("N1 access: owner, operations and kitchen/cashier may read chats; marketing and accounting are refused although they have «orders: view»", async () => {
  assert.deepEqual([...DEFAULT_INBOX_ROLES], ["owner", "operations", "kitchen"]);
  assert.equal(sectionOf("/api/cms/wa/threads"), "orders");
  assert.equal(sectionOf("/api/cms/wa/threads/abc/reply"), "orders");
  assert.equal(DEFAULT_PERMS.marketing.orders, "view"); assert.equal(DEFAULT_PERMS.accounting.orders, "view");
  for (const role of ["owner", "operations", "kitchen"]) {
    const w = world({ role, threads: [T("512345678")] });
    const r = await w.call("GET", "/api/cms/wa/threads");
    assert.equal(r.status, 200, role); assert.equal(r.body.threads.length, 1);
  }
  for (const role of ["marketing", "accounting", "someone-new"]) {
    const w = world({ role, threads: [T("512345678")] });
    for (const [m, p] of [["GET", "/api/cms/wa/threads"], ["GET", "/api/cms/wa/threads/:key"], ["POST", "/api/cms/wa/threads/:key/read"], ["POST", "/api/cms/wa/threads/:key/reply"]]) {
      const r = await w.call(m, p, { params: { key: "512345678" } });
      assert.equal(r.status, 403, `${role} ${p}`); assert.equal(r.body.error, "role_not_allowed");
    }
    assert.ok(!w.db.sql.some((s) => /FROM wa_threads|FROM wa_messages/.test(s)), "refused before any chat data is read");
  }
  const none = world({ role: null });
  assert.equal((await none.call("GET", "/api/cms/wa/threads")).status, 401);
});

test("N1 access: the role list is a server setting; the owner cannot be removed; a role may read chats with the number hidden", async () => {
  assert.deepEqual(hubRoles({}), { inbox: ["owner", "operations", "kitchen"], phone: ["owner", "operations", "kitchen"] });
  assert.deepEqual(hubRoles({ waHub: { inboxRoles: ["marketing", "bogus"] } }).inbox, ["owner", "marketing"]);
  assert.deepEqual(hubRoles({ waHub: { inboxRoles: [] } }).inbox, ["owner"]);
  assert.deepEqual(hubRoles({ waHub: { inboxRoles: ["operations", "kitchen"], phoneRoles: ["operations", "accounting"] } }).phone, ["owner", "operations"], "phone roles are a subset of the readers");
  assert.ok(SERVER_OWNED_PATHS.includes("waHub"), "the general settings save cannot change who reads chats");
  const w = world({ role: "kitchen", settings: { waHub: { inboxRoles: ["operations", "kitchen"], phoneRoles: ["operations"] } }, threads: [T("512345678")] });
  const list = (await w.call("GET", "/api/cms/wa/threads")).body;
  assert.equal(list.threads[0].phone, "…5678");
  assert.match(list.threads[0].key, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(list).includes("512345678"), "the full number is nowhere in the answer");
  assert.equal((await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "0512345678" } })).status, 404, "a hidden-number role cannot address a chat by number");
  const th = await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: list.threads[0].key } });
  assert.equal(th.status, 200); assert.equal(th.body.phone, "…5678");
  assert.ok(!JSON.stringify(th.body).includes("512345678"));
  assert.equal(maskPhone("512345678"), "…5678");
});

/* ══ N1: القايمة ═══════════════════════════════════════════════════════════ */
test("N1 list: works with the sending switch off; rows carry the window, the bot state with its reason, unread, the ad mark; counts; pages", async () => {
  const saved = process.env.WHATSAPP_ENABLED; delete process.env.WHATSAPP_ENABLED;
  try {
    const w = world({ threads: [
      T("511111111", { last_at: ago(5), handoff_at: ago(4), handoff_reason: "complaint", unread: 2 }),
      T("522222222", { last_at: ago(10), ad: true }),
      T("533333333", { last_at: ago(15), last_in_at: ago(60 * 30), unread: 0 }),
    ] });
    const r = (await w.call("GET", "/api/cms/wa/threads", { query: { limit: "2" } })).body;
    assert.equal(r.ok, true);
    assert.deepEqual(r.counts, { all: 3, waiting: 1, bot: 1, muted: 0, ad: 0, unread: 2, unreadMessages: 3, oldestWaitingAt: ago(4) });
    assert.equal(r.threads.length, 2);
    const a = r.threads[0];
    assert.deepEqual(Object.keys(a).sort(), ["ad", "bot", "key", "lastAt", "lastDir", "lastSource", "lastText", "name", "orderNo", "orders", "phone", "phoneMasked", "unread", "window"]);
    assert.equal(a.phone, "0511111111"); assert.equal(a.phoneMasked, "…1111"); assert.equal(a.unread, 2);
    assert.deepEqual(a.bot, { state: "waiting", reason: "complaint", mutedUntil: null, mutedBy: null, handoffAt: ago(4) });
    assert.equal(a.window.open, true); assert.ok(a.window.msLeft > 23 * 3600_000);
    assert.equal(r.threads[1].ad, true);
    assert.equal(r.nextBefore, ago(10));
    const p2 = (await w.call("GET", "/api/cms/wa/threads", { query: { limit: "2", before: r.nextBefore } })).body;
    assert.deepEqual(p2.threads.map((t) => t.phoneMasked), ["…3333"]);
    assert.equal(p2.nextBefore, null);
    assert.equal(p2.threads[0].window.open, false); assert.equal(p2.threads[0].bot.state, "closed");
  } finally { if (saved !== undefined) process.env.WHATSAPP_ENABLED = saved; }
});

test("N1 list: filters are fixed SQL conditions; search by name or by number — a hidden-number role can only match the last four digits", async () => {
  const w = world({ threads: [T("512345678")] });
  await w.call("GET", "/api/cms/wa/threads", { query: { filter: "waiting", q: "0512" } });
  let s = w.db.sql.find((x) => /^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.last_text/.test(x));
  assert.ok(s.includes("b.handoff_at IS NOT NULL AND NOT COALESCE(b.muted_until > NOW(), FALSE)"));
  assert.ok(s.includes("t.phone_norm LIKE '%' || $1 || '%'"));
  assert.equal((await w.call("GET", "/api/cms/wa/threads", { query: { filter: "'; DROP TABLE x;--" } })).body.filter, "all");
  const k = world({ role: "kitchen", settings: { waHub: { inboxRoles: ["kitchen"], phoneRoles: [] } }, threads: [T("512345678")] });
  await k.call("GET", "/api/cms/wa/threads", { query: { q: "512345678" } });
  s = k.db.sql.find((x) => /^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.last_text/.test(x));
  assert.ok(s.includes("right(t.phone_norm, 4) = right($1, 4)") && !s.includes("LIKE '%' || $1"), "no digit-by-digit guessing of a hidden number");
  const n = world({ threads: [T("512345678")] });
  await n.call("GET", "/api/cms/wa/threads", { query: { q: "أحمد" } });
  assert.ok(n.db.sql.some((x) => x.includes("ILIKE '%' || $1 || '%'")));
});

test("N1 bot state: muted › waiting for staff › staff replying › window closed › bot", () => {
  const base = { last_in_at: ago(10), muted_until: null, handoff_at: null, last_echo_at: null };
  const st = (x) => botState({ ...base, ...x }, { now: NOW, pauseMin: 30 }).state;
  assert.equal(st({}), "bot");
  assert.equal(st({ last_echo_at: ago(10) }), "staff");
  assert.equal(st({ last_echo_at: ago(40) }), "bot", "the staff pause ended");
  assert.equal(st({ handoff_at: ago(3), last_echo_at: ago(1) }), "waiting");
  assert.equal(st({ handoff_at: ago(3), muted_until: new Date(NOW + 3600_000).toISOString() }), "muted");
  assert.equal(st({ muted_until: ago(1) }), "bot", "an expired mute is not a mute");
  assert.equal(st({ last_in_at: ago(60 * 25) }), "closed");
  assert.equal(st({ last_in_at: null }), "closed");
});

/* ══ N1: المحادثة ══════════════════════════════════════════════════════════ */
test("N1 thread: messages oldest-first with source, template cost and the bot's decision on each customer message; handovers as events; pages backwards", async () => {
  const pn = "512345678";
  const messages = [
    { phone_norm: pn, wamid: "in1", direction: "in", status: "received", body: "الطلب وصل بارد", created_at: ago(50), source: "api", pricing: null },
    { phone_norm: pn, wamid: "out1", direction: "out", status: "read", body: "نعتذر منك", created_at: ago(49), source: "bot", pricing: null },
    { phone_norm: pn, wamid: "echo1", direction: "out", status: "sent", body: "معك محمد", created_at: ago(40), source: "echo", pricing: null },
    { phone_norm: pn, wamid: "tpl1", direction: "out", status: "delivered", body: null, template: "fc_order_preparing", category: "UTILITY", order_no: "W1", created_at: ago(30), source: "api", pricing: { billable: true, category: "utility", pricing_model: "PMP" } },
  ];
  const botLog = [{ phone_norm: pn, wamid: "in1", at: ago(50), decision: "replied", reason: null, reply_key: "complaint", handoff: "complaint:urgent" }];
  const w = world({ threads: [T(pn, { handoff_at: ago(50), handoff_reason: "complaint" })], messages, botLog });
  const r = (await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "0512345678" }, query: { limit: "3" } })).body;
  assert.equal(r.ok, true); assert.equal(r.phone, "0512345678"); assert.equal(r.name, "أحمد"); assert.equal(r.orders, 3);
  assert.deepEqual(r.optIn, { updates: true, marketing: false, stopped: false });
  assert.equal(r.bot.state, "waiting"); assert.equal(r.window.open, true);
  assert.deepEqual(r.messages.map((m) => m.id), ["out1", "echo1", "tpl1"]);
  assert.deepEqual(r.messages.map((m) => m.source), ["bot", "echo", "api"]);
  assert.deepEqual(r.messages[2].cost, { billable: true, category: "utility" });
  assert.equal(r.messages[2].text, "[قالب: fc_order_preparing]");
  assert.equal(r.nextBefore, ago(49));
  const older = (await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: r.key }, query: { before: r.nextBefore } })).body;
  assert.deepEqual(older.messages.map((m) => m.id), ["in1"]);
  assert.deepEqual(older.messages[0].bot, { decision: "replied", replyKey: "complaint", reason: null });
  assert.deepEqual(older.events, [{ at: ago(50), kind: "handover", reason: "complaint" }]);
  assert.equal(older.nextBefore, null);
  assert.equal((await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "0598765432" } })).status, 404);
  assert.equal((await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "f".repeat(32) } })).status, 404);
});

test("N1 actions: read clears the count by name; «تم التعامل» calls the bot's own function and writes none of its tables", async () => {
  const w = world({ role: "kitchen", threads: [T("512345678", { unread: 4, handoff_at: ago(3) })] });
  assert.deepEqual((await w.call("POST", "/api/cms/wa/threads/:key/read", { params: { key: "512345678" } })).body, { ok: true });
  assert.equal(w.db.threads[0].unread, 0); assert.equal(w.db.threads[0].read_by, "منى");
  assert.deepEqual((await w.call("POST", "/api/cms/wa/threads/:key/handled", { params: { key: "512345678" } })).body, { ok: true });
  assert.deepEqual(w.db.unmuted, ["512345678"]);
  const src = readFileSync(new URL("./wahub.js", import.meta.url), "utf8");
  assert.ok(!/(UPDATE|INSERT INTO|DELETE FROM) wa_bot/.test(src));
});

test("N1 reply: only through the inbox module (the send guard); a refusal names the lock; a paid template is for owner and operations", async () => {
  const w = world({ role: "kitchen", threads: [T("512345678")] });
  const ok = await w.call("POST", "/api/cms/wa/threads/:key/reply", { params: { key: "512345678" }, json: { text: "حياك الله" } });
  assert.deepEqual(ok.body, { ok: true, wamid: "wamid.R1", window: { open: true } });
  assert.deepEqual(w.inboxCalls[0], ["text", { phoneNorm: "512345678", text: "حياك الله", by: "منى" }]);
  for (const [reply, gate, status] of [[{ ok: false, error: "disabled" }, "disabled", 409], [{ ok: false, skipped: "master_off" }, "master_off", 409],
    [{ ok: false, error: "window_closed", window: { open: false } }, "window_closed", 409], [{ ok: false, skipped: "settings_off" }, "settings_off", 409], [{ ok: false, error: "empty" }, null, 400]]) {
    w.db.nextReply = reply;
    const r = await w.call("POST", "/api/cms/wa/threads/:key/reply", { params: { key: "512345678" }, json: { text: "x" } });
    assert.equal(r.status, status); assert.equal(r.body.ok, false); assert.equal(r.body.gate, gate, JSON.stringify(reply));
  }
  w.db.nextReply = null;
  const no = await w.call("POST", "/api/cms/wa/threads/:key/template", { params: { key: "512345678" }, json: { template: "fc_order_preparing" } });
  assert.equal(no.status, 403);
  assert.equal(w.inboxCalls.filter((c) => c[0] === "template").length, 0);
  const ops = world({ role: "operations", threads: [T("512345678")] });
  const t = await ops.call("POST", "/api/cms/wa/threads/:key/template", { params: { key: "512345678" }, json: { template: "fc_order_preparing", params: { body: ["W1"] } } });
  assert.equal(t.body.ok, true);
  assert.deepEqual(ops.inboxCalls[0], ["template", { phoneNorm: "512345678", template: "fc_order_preparing", params: { body: ["W1"] }, by: "منى" }]);
  const src = readFileSync(new URL("./wahub.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const x of ["sendTemplate(", "sendText(", "sendFreeform(", "guardSend(", "deliver(", "/messages"]) assert.ok(!src.includes(x), "no send path of its own: " + x);
});

/* ══ N3: القوالب ═══════════════════════════════════════════════════════════ */
test("N3 templates: one row per name with Meta's rejection reason verbatim, quality, wiring, 30-day sends and history", async () => {
  const stageName = W.STAGE_TEMPLATES[Object.keys(W.STAGE_TEMPLATES)[0]];
  const campaign = Object.keys(W.TEMPLATES).find((n) => W.TEMPLATES[n].campaign);
  const metaList = [
    { id: "1", name: "fc_order_preparing", status: "APPROVED", category: "UTILITY", language: "ar", quality_score: { score: "GREEN" }, rejected_reason: "NONE" },
    { id: "2", name: "fc_order_preparing", status: "REJECTED", category: "UTILITY", language: "en", rejected_reason: "INVALID_FORMAT" },
    { id: "3", name: "fc_only_at_meta", status: "APPROVED", category: "MARKETING", language: "ar" },
  ];
  const w = world({ role: "marketing", metaList });
  assert.equal(sectionOf("/api/cms/wa/templates"), "customers", "the marketing role reaches the templates view");
  const r = (await w.call("GET", "/api/cms/wa/templates")).body;
  assert.equal(r.ok, true); assert.deepEqual(r.meta, { ok: true, error: null, variants: 3 });
  assert.equal(w.fetches[0].auth, "Bearer systok");
  assert.match(w.fetches[0].url, /\/WABA1\/message_templates\?fields=id,name,status,category,language,quality_score,rejected_reason/);
  const names = r.templates.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "counted by name, languages inside the row");
  const p = r.templates.find((t) => t.name === "fc_order_preparing");
  assert.equal(p.rejectedReason, "INVALID_FORMAT"); assert.equal(p.quality, "GREEN"); assert.equal(p.submitted, true);
  assert.deepEqual(p.statuses.map((s) => [s.language, s.status, s.rejectedReason]), [["ar", "APPROVED", null], ["en", "REJECTED", "INVALID_FORMAT"]]);
  assert.deepEqual([p.sent30d, p.delivered30d, p.read30d, p.failed30d], [40, 38, 30, 2]);
  assert.deepEqual(p.events, [{ at: ago(5000), event: "APPROVED", reason: null, language: "ar" }]);
  assert.ok(Array.isArray(p.components) && p.category === "UTILITY");
  const st = r.templates.find((t) => t.name === stageName);
  assert.equal(st.wiredTo[0].kind, "stage");
  if (campaign) assert.ok(r.templates.find((t) => t.name === campaign).wiredTo.some((x) => x.kind === "campaign"));
  assert.ok(r.templates.find((t) => t.name === "fc_loyalty_status").wiredTo.some((x) => x.kind === "flow" && x.id === "loyalty_status"));
  const foreign = r.templates.find((t) => t.name === "fc_only_at_meta");
  assert.equal(foreign.inCatalog, false); assert.deepEqual(foreign.wiredTo, []);
  const notSent = r.templates.find((t) => t.inCatalog && !t.submitted);
  if (notSent) { assert.deepEqual(notSent.statuses, []); assert.equal(notSent.sent30d, 0); }
  assert.ok(r.needAction >= 1);
});

test("N3 templates: Meta unreachable ⇒ the catalogue still answers, and says the statuses are missing", async () => {
  const w = world({ metaList: null });
  const r = (await w.call("GET", "/api/cms/wa/templates")).body;
  assert.equal(r.ok, true); assert.equal(r.meta.ok, false); assert.equal(r.meta.error, "nope");
  assert.ok(r.templates.length >= 10); assert.ok(r.templates.every((t) => t.statuses.length === 0));
});

/* ══ N7: سجل المفاتيح ═════════════════════════════════════════════════════ */
test("N7 watched keys: the WhatsApp switches and caps, never a secret", () => {
  const v = watchedValues({ notifications: { whatsappEnabled: true, smsEnabled: true, whatsappReplacesSms: false, whatsappAutoReplyText: "أهلاً" },
    waMaster: { enabled: true, by: "عمر", log: [] }, waCloud: { enabled: false, dailyCap: 200, configId: "x" }, waSender: { enabled: true, agentHash: "SECRET", gapDays: 3, hours: { from: 12 } },
    waCloudActive: { phoneId: "P1", wabaId: "W1", token: "T" }, waBot: { mode: "test", testPhones: ["0544775082"] } });
  assert.deepEqual(v, { "notifications.whatsappEnabled": true, "notifications.whatsappReplacesSms": false, "notifications.whatsappAutoReplyText": "أهلاً", "waMaster.enabled": true,
    "waCloud.enabled": false, "waCloud.dailyCap": 200, "waSender.enabled": true, "waSender.gapDays": 3, "waCloudActive.phoneId": "P1", "waCloudActive.wabaId": "W1", "waBot.mode": "test" });
  assert.ok(!JSON.stringify(v).includes("SECRET") && !("notifications.smsEnabled" in v));
  assert.deepEqual(diffWatched({ a: 1, b: true, c: "x" }, { a: 2, b: true, d: false, e: true }), [{ key: "a", from: 1, to: 2 }, { key: "c", from: "x", to: null }, { key: "e", from: null, to: true }],
    "«not written» → false is not a change");
  assert.deepEqual(diffWatched({ x: false }, {}), []);
  /* live on 13/10: none of the three main switches had ever been written — they must be watched anyway, as off */
  const bare = watchedValues({ waSender: { enabled: true }, waBot: { mode: "test" } });
  assert.deepEqual([bare["notifications.whatsappEnabled"], bare["waMaster.enabled"], bare["waCloud.enabled"]], [false, false, false]);
  assert.deepEqual(diffWatched({ "waSender.enabled": true, "waBot.mode": "test" }, bare), [], "the snapshot taken before this fix produces no rows");
  assert.deepEqual(diffWatched(bare, watchedValues({ waSender: { enabled: true }, waBot: { mode: "test" }, waMaster: { enabled: true } })), [{ key: "waMaster.enabled", from: false, to: true }]);
});

test("N7 log: the first look only takes a snapshot; each later change is one row with from → to and who did it", async () => {
  const w = world({ settings: { notifications: { whatsappEnabled: false }, waMaster: { enabled: false } } });
  assert.equal(await w.api.sweep("عمر"), 0, "nothing is invented for the state found at start");
  assert.equal(w.db.log.length, 0);
  w.db.settings.notifications.whatsappEnabled = true;
  assert.equal(await w.api.sweep("منى"), 1);
  w.db.settings.waMaster = { enabled: true }; w.db.settings.waCloud = { enabled: true, dailyCap: 100 };
  w.setUser({ name: "عمر", role: "owner" });
  assert.equal(await w.api.sweepFor({}), 3);
  assert.equal(await w.api.sweep(null), 0, "no change, no row");
  const r = (await w.call("GET", "/api/cms/wa/settings-log")).body;
  assert.deepEqual(r.rows.map((x) => [x.key, x.from, x.to, x.who]).sort(), [
    ["notifications.whatsappEnabled", false, true, "منى"], ["waCloud.dailyCap", null, 100, "عمر"], ["waCloud.enabled", false, true, "عمر"], ["waMaster.enabled", false, true, "عمر"]]);
  assert.ok(r.rows.every((x) => x.at && x.id));
  assert.ok(r.watched.includes("waMaster.enabled"));
  w.db.settings.waBot = { mode: "live" };
  const again = (await w.call("GET", "/api/cms/wa/settings-log", { query: { key: "waBot" } })).body;
  assert.deepEqual(again.rows.map((x) => [x.key, x.to, x.who]), [["waBot.mode", "live", null]], "a change nobody announced is still logged, without a name");
  assert.equal(sectionOf("/api/cms/wa/settings-log"), "settings");
});

test("N7 wiring: every successful write on a settings route is followed by a sweep in the writer's name", () => {
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const i = index.indexOf('app.use("/api/*", async (c, next) => { await next(); try { if (waHubApi && c.req.method !== "GET" && c.res && c.res.status < 400');
  assert.ok(i > 0);
  assert.ok(index.slice(i, i + 400).includes("/^\\/api\\/(settings|notify\\/|cms\\/(wa-cloud|wa-sender|wabot\\/config))/.test(c.req.path)) waHubApi.sweepFor(c);"));
  assert.ok(i < index.indexOf("settingsGuard.register(app,"), "registered before the routes it watches");
  assert.ok(index.includes("waHubApi = wahub.register(app, moduleCtx, { whoami: (c) => cmsApi.whoami(c), wa: waApi, waInbox: () => waInboxApi, bot: () => wabotApi, staff: () => waStaffApi });"));
  assert.ok(index.includes("waStaffApi = wastaff.register(app, moduleCtx, { wa: waApi, hub: () => waHubApi, requirePortal: portalApi.requirePortal, audit: portalApi.audit });"));
});

/* ══ العدّادان ═════════════════════════════════════════════════════════════ */
test("master-switch counts: website orders per day over the last 7 closed business days, and Cloud campaign recipients waiting", async () => {
  const w = world({ orders7d: 23, queued: { n: 14, people: 11 } });
  const r = (await w.call("GET", "/api/cms/wa/master-counts")).body;
  assert.deepEqual([r.ok, r.days, r.orders7d, r.ordersPerDay, r.queuedCloudMessages, r.queuedCloudRecipients], [true, 7, 23, 3.3, 14, 11]);
  assert.equal(Date.parse(r.to) - Date.parse(r.from), 7 * 86400_000);
  assert.ok(Date.parse(r.to) <= NOW, "today's unfinished day is not counted");
  assert.deepEqual(w.db.ordersRange, [r.from, r.to]);
  assert.equal(sectionOf("/api/cms/wa/master-counts"), "settings", "owner only");
  const q = w.db.sql.find((s) => /FROM wa_send_queue q JOIN wa_send_jobs j/.test(s));
  assert.ok(q.includes("q.status = 'pending'") && q.includes("COALESCE(q.channel, j.channel) = 'wa_cloud'") && q.includes("j.status IN ('running','paused')"));
});

/* ══ send: حالة الإرسال للي بيسأل (طلب مصمّم القسم ١٣/١٠) ═════════════════════ */
test("send state: the list and the chat tell the caller — cashier included — whether a reply can go, and which lock is closed", async () => {
  const w = world({ role: "kitchen", threads: [T("512345678"), T("533333333", { last_in_at: ago(60 * 30), last_at: ago(60 * 30) })] });
  let l = (await w.call("GET", "/api/cms/wa/threads")).body;
  assert.deepEqual(l.send, { ok: false, gate: "disabled" });
  for (const g of ["unconfigured", "master_off", "settings_off"]) { w.db.gate = g; assert.deepEqual((await w.call("GET", "/api/cms/wa/threads")).body.send, { ok: false, gate: g }); }
  w.db.gate = "master_off";
  assert.deepEqual((await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "512345678" } })).body.send, { ok: false, gate: "master_off" }, "the channel lock comes before the window");
  w.db.gate = null;
  l = (await w.call("GET", "/api/cms/wa/threads")).body;
  assert.deepEqual(l.send, { ok: true, gate: null });
  assert.deepEqual((await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "512345678" } })).body.send, { ok: true, gate: null });
  assert.deepEqual((await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "533333333" } })).body.send, { ok: false, gate: "window_closed" });
  w.db.gateThrows = true;
  assert.deepEqual((await w.call("GET", "/api/cms/wa/threads")).body.send, { ok: false, gate: "settings_unreadable" }, "if the state cannot be read the box stays locked");
  const m = world({ role: "marketing", threads: [T("512345678")] });
  assert.equal((await m.call("GET", "/api/cms/wa/threads")).body.send, undefined, "a refused role learns nothing");
});

test("staff reply (wastaff.js): when registered, the dashboard reply and the chat's send state go through it", async () => {
  const w = world({ role: "kitchen", threads: [T("512345678")], messages: [{ phone_norm: "512345678", wamid: "wamid.S1", direction: "out", status: "accepted", body: "حياك", source: "echo", created_at: ago(2) }] });
  const calls = [];
  w.db.staff = { reply: async (a) => { calls.push(a); return w.db.staffReply || { ok: true, wamid: "wamid.S1", test: false }; },
    sendStateFor: async (pn) => ({ ok: true, gate: null, test: pn === "512345678" }),
    annotate: async (ms) => { for (const m of ms) if (m.id === "wamid.S1") { m.source = "staff"; m.staff = { by: "منى", role: "kitchen", via: "dashboard" }; } return ms; } };
  const ok = await w.call("POST", "/api/cms/wa/threads/:key/reply", { params: { key: "512345678" }, json: { text: "حياك الله" } });
  assert.deepEqual(ok.body, { ok: true, wamid: "wamid.S1", test: false, send: { ok: true, gate: null, test: true } });
  assert.deepEqual(calls[0], { phoneNorm: "512345678", text: "حياك الله", by: "منى", role: "kitchen", via: "dashboard" });
  assert.equal(w.inboxCalls.length, 0, "the old inbox path is not used once wastaff is registered");
  for (const [reply, status] of [[{ ok: false, error: "opted_out", gate: "opted_out" }, 409], [{ ok: false, error: "window_closed", gate: "window_closed" }, 409], [{ ok: false, error: "empty", gate: null }, 400]]) {
    w.db.staffReply = reply;
    const r = await w.call("POST", "/api/cms/wa/threads/:key/reply", { params: { key: "512345678" }, json: { text: "x" } });
    assert.equal(r.status, status); assert.equal(r.body.gate, reply.gate); assert.equal(r.body.error, reply.error);
  }
  const one = await w.call("GET", "/api/cms/wa/threads/:key", { params: { key: "512345678" } });
  assert.deepEqual(one.body.send, { ok: true, gate: null, test: true });
  assert.deepEqual(one.body.messages.map((m) => [m.source, m.staff ? m.staff.via : null]), [["staff", "dashboard"]]);
  // a role that may not read chats is still refused before wastaff is reached
  w.setUser({ name: "x", role: "marketing" });
  assert.equal((await w.call("POST", "/api/cms/wa/threads/:key/reply", { params: { key: "512345678" }, json: { text: "x" } })).status, 403);
  assert.equal(calls.length, 4);
});
