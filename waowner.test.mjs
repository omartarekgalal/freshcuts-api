/* مين ماسك محادثة واتساب (waowner.js + مسارات wastaff.js / wahub.js) — SR2
   node --test waowner.test.mjs — قاعدة وبوت وهميين؛ مفيش شبكة ولا إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const O = await import("./waowner.js");
const S = await import("./wastaff.js");
const H = await import("./wahub.js");

const A = "512345678", B = "598765432", SALT = "salt-1";
const keyOf = (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex");
const CASHIER = { id: "s1", name: "سلمى", role: "cashier", via: "portal" };
const CASHIER2 = { id: "s2", name: "نورة", role: "cashier", via: "portal" };
const MANAGER = { id: "m1", name: "خالد", role: "manager", via: "portal" };

function world({ settings = {}, portalUser = CASHIER, dashUser = { id: 7, username: "ops1", name: "عمليات", role: "operations" } } = {}) {
  let nowMs = Date.parse("2026-10-13T15:00:00Z");
  const at = (min = 0) => new Date(nowMs - min * 60_000).toISOString();
  const db = { settings: { ...settings }, threads: new Map([[A, { phone_norm: A, last_in_at: at(3), last_at: at(3), unread: 1 }], [B, { phone_norm: B, last_in_at: at(50), last_at: at(50), unread: 0 }]]),
    chats: new Map(), holds: new Map(), log: [], echoes: [], jobsCancelled: [] };
  const chat = (pn) => { if (!db.chats.has(pn)) db.chats.set(pn, { phone_norm: pn }); return db.chats.get(pn); };
  const lastEcho = (pn) => db.echoes.filter((e) => e.pn === pn).map((e) => e.at).sort().pop() || null;
  const rowOf = (pn) => { const t = db.threads.get(pn); if (!t) return null; const c = db.chats.get(pn) || {}; return { ...t, muted_until: c.muted_until || null, muted_by: c.muted_by || null, mute_reason: c.mute_reason || null, handoff_at: c.handoff_at || null, handoff_reason: c.handoff_reason || null, last_echo_at: lastEcho(pn), ad: false }; };
  const pool = { async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    if (/^SELECT t\.phone_norm, t\.last_in_at, b\.muted_until/i.test(s)) { const r = rowOf(p[0]); return { rows: r ? [r] : [] }; }
    if (/^SELECT phone_norm, state, by_key.* FROM wa_chat_holds WHERE phone_norm = ANY/i.test(s)) return { rows: p[0].map((x) => db.holds.get(x)).filter(Boolean) };
    if (/^SELECT h\.phone_norm FROM wa_chat_holds h JOIN wa_bot_chats/i.test(s)) return { rows: [...db.holds.values()].filter((h) => h.state === "held" && h.by_key === p[0] && Date.parse(db.chats.get(h.phone_norm)?.muted_until || 0) > nowMs).map((h) => ({ phone_norm: h.phone_norm })) };
    if (/^INSERT INTO wa_chat_holds\(.*VALUES \(\$1,'held'/i.test(s)) { const old = db.holds.get(p[0]); const same = old && old.state === "held" && old.by_key === p[1];
      db.holds.set(p[0], { phone_norm: p[0], state: "held", by_key: p[1], by_id: p[2], by_name: p[3], role: p[4], via: p[5], since: same ? old.since : at(), touched_at: at() }); return { rows: [] }; }
    if (/^INSERT INTO wa_chat_holds\(.*VALUES \(\$1,'closed'/i.test(s)) { db.holds.set(p[0], { phone_norm: p[0], state: "closed", by_key: p[1], by_id: p[2], by_name: p[3], role: p[4], via: p[5], since: at(), touched_at: at() }); return { rows: [] }; }
    if (/^DELETE FROM wa_chat_holds WHERE phone_norm=\$1 AND state='held'/i.test(s)) { if (db.holds.get(p[0])?.state === "held") db.holds.delete(p[0]); return { rows: [] }; }
    if (/^DELETE FROM wa_chat_holds/i.test(s)) { db.holds.delete(p[0]); return { rows: [] }; }
    if (/^INSERT INTO wa_chat_owner_log/i.test(s)) { db.log.push({ pn: p[0], action: p[1], by_key: p[2], by_name: p[3], role: p[4], via: p[5], forced: p[6], prev: p[7] }); return { rows: [] }; }
    if (/^SELECT by_name FROM wa_chat_holds WHERE phone_norm=\$1 AND state='held'/i.test(s)) { const h = db.holds.get(p[0]); return { rows: h && h.state === "held" ? [h] : [] }; }
    if (/^UPDATE wa_chat_holds SET touched_at=NOW\(\)/i.test(s)) { db.holds.get(p[0]).touched_at = at(); return { rows: [] }; }
    if (/^UPDATE wa_chat_holds SET touched_at=\$2/i.test(s)) { db.holds.get(p[0]).touched_at = p[1]; return { rows: [] }; }
    if (/^SELECT h\.phone_norm, h\.by_name, h\.touched_at, b\.muted_until/i.test(s)) return { rows: [...db.holds.values()].filter((h) => h.state === "held").map((h) => ({ phone_norm: h.phone_norm, by_name: h.by_name, touched_at: h.touched_at, muted_until: db.chats.get(h.phone_norm)?.muted_until || null, last_echo_at: lastEcho(h.phone_norm) })) };
    if (/^SELECT phone_norm FROM wa_threads WHERE md5/i.test(s)) { const hit = [...db.threads.keys()].find((t) => keyOf(t) === p[1] && p[0] === SALT); return { rows: hit ? [{ phone_norm: hit }] : [] }; }
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waInbox\}'/i.test(s)) { db.settings.waInbox = JSON.parse(p[0]); return { rows: [] }; }
    /* wahub list / thread */
    if (/^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.last_text/i.test(s)) { let rows = [...db.threads.keys()].map(rowOf); if (/t\.phone_norm = ANY/.test(s)) rows = rows.filter((r) => p[0].includes(r.phone_norm)); if (/WHERE b\.muted_until > NOW\(\)/.test(s)) rows = rows.filter((r) => Date.parse(r.muted_until || 0) > nowMs); return { rows }; }
    if (/^SELECT count\(\*\)::int AS total/i.test(s)) return { rows: [{ total: db.threads.size, waiting: 0, bot: 0, muted: [...db.chats.values()].filter((c) => Date.parse(c.muted_until || 0) > nowMs).length, ad: 0, unread: 1, unread_messages: 1, oldest_waiting: null }] };
    if (/^SELECT t\.phone_norm, t\.last_in_at, t\.last_at, t\.unread, t\.order_no/i.test(s)) { const r = rowOf(p[0]); return { rows: r ? [r] : [] }; }
    return { rows: [], rowCount: 0 };
  } };
  /* البوت الوهمي: نفس عقد holdChat / unmuteChat في wabotrun.js */
  const bot = {
    holdChat: async (pn, minutes, by) => { Object.assign(chat(pn), { muted_until: new Date(nowMs + minutes * 60_000).toISOString(), mute_reason: "manual", muted_by: by }); db.jobsCancelled.push(pn); return { ok: true, minutes }; },
    unmuteChat: async (pn, { release = false, keepHandover = false } = {}) => { const c = chat(pn); Object.assign(c, { muted_until: null, mute_reason: null, muted_by: null }); if (!keepHandover) Object.assign(c, { handoff_at: null, handoff_reason: null }); if (release) c.released_at = at(); return { ok: true }; },
    botConfig: async () => ({ handoffOpenHours: 24, humanPauseMin: 30 }),
  };
  const events = [];
  const fakeApp = () => { const routes = {}; const add = (m) => (pth, h) => { routes[`${m} ${pth}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; };
  const app = fakeApp();
  const users = { portal: portalUser, dash: dashUser, owner: false };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)), isOwner: async () => users.owner };
  const sent = [];
  const wa = { gate: async () => null, envState: () => "allow", configured: () => true, testPhones: async () => [],
    sendFreeform: async (o) => { sent.push(o); db.echoes.push({ pn: o.phoneNorm, at: at() }); return { ok: true, wamid: `wamid.S${sent.length}` }; } };
  let hub = null;
  const requirePortal = async (c) => (users.portal ? (users.portal.role === "kitchen" ? { res: c.json({ ok: false, error: "kitchen_only" }, 403) } : { user: users.portal }) : { res: c.json({ ok: false, error: "unauthorized" }, 401) });
  const st = S.register(app, ctx, { wa, hub: () => hub, requirePortal, keySalt: SALT, log: { error() {} }, bot: () => bot, broadcast: (e, d) => events.push([e, d]), noTimer: true, now: () => nowMs });
  hub = H.register(app, { ...ctx }, { whoami: async () => users.dash, wa, bot: () => bot, staff: () => st, keySalt: SALT, log: { error() {} }, now: () => nowMs });
  /* wa_messages: نافذة مفتوحة للعميل A */
  const q0 = pool.query.bind(pool);
  pool.query = async (sql, p = []) => { const s = String(sql).replace(/\s+/g, " ").trim(); if (/^SELECT 1 FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: [{}] }; return q0(sql, p); };
  const call = (route, { json = {}, query = {}, param = {} } = {}) => app.routes[route]({
    req: { json: async () => { if (json === "BAD") throw new Error("bad"); return json; }, header: () => undefined, query: (n) => query[n], param: (n) => param[n] }, json: (body, status = 200) => ({ body, status }) });
  return { db, st, bot, events, users, sent, call, chat, clock: { advance: (min) => { nowMs += min * 60_000; }, now: () => nowMs }, at,
    echo: (pn, min = 0) => db.echoes.push({ pn, at: at(min) }), inbound: (pn) => { db.threads.get(pn).last_in_at = at(); } };
}

test("ownerOf: held › waiting_staff › closed › bot, with who, since, waited minutes and mine", () => {
  const now = Date.parse("2026-10-13T15:00:00Z"), t = (m) => new Date(now - m * 60_000).toISOString();
  const hold = { state: "held", by_key: "portal:s1", by_id: "s1", by_name: "سلمى", role: "cashier", via: "portal", since: t(6) };
  const held = O.ownerOf({ muted_until: t(-14), muted_by: "سلمى", handoff_at: t(9), last_in_at: t(2), last_echo_at: t(5) }, hold, { now, me: CASHIER });
  assert.deepEqual(held, { state: "held", by: { id: "s1", name: "سلمى", role: "cashier", via: "portal" }, since: t(6), waitedMin: 2, mine: true, autoReleaseAt: t(-14), reason: null });
  assert.equal(O.ownerOf({ muted_until: t(-14), last_in_at: t(8), last_echo_at: t(5) }, hold, { now, me: CASHIER2 }).mine, false);
  assert.equal(O.ownerOf({ muted_until: t(-14), last_in_at: t(8), last_echo_at: t(5) }, hold, { now }).waitedMin, null, "the last word is the staff's");
  /* الكتم القديم من اللوحة (من غير صف سحب) */
  assert.deepEqual(O.ownerOf({ muted_until: t(-60), muted_by: "عمر" }, null, { now, me: CASHIER }).by, { id: null, name: "عمر", role: null, via: "mute" });
  const w = O.ownerOf({ handoff_at: t(7), handoff_reason: "complaint", last_in_at: t(7) }, null, { now });
  assert.deepEqual([w.state, w.since, w.waitedMin, w.reason, w.by], ["waiting_staff", t(7), 7, "complaint", null]);
  assert.equal(O.ownerOf({ handoff_at: t(25 * 60) }, null, { now }).state, "bot", "a handover older than its open time is not waiting");
  /* السحب اللي مهلته خلصت ⇒ يرجع «مستنية موظف» لو التحويل لسه مفتوح */
  assert.equal(O.ownerOf({ muted_until: t(1), handoff_at: t(30) }, hold, { now }).state, "waiting_staff");
  const closed = { state: "closed", by_key: "portal:s1", by_id: "s1", by_name: "سلمى", role: "cashier", via: "portal", since: t(4) };
  assert.equal(O.ownerOf({ last_in_at: t(10) }, closed, { now }).state, "closed");
  assert.equal(O.ownerOf({ last_in_at: t(1) }, closed, { now }).state, "bot", "the customer wrote again ⇒ the bot has it");
  assert.equal(O.ownerOf({}, null, { now }).state, "bot");
  assert.deepEqual([O.holdMinutes({}), O.holdMinutes({ waInbox: { holdAutoReleaseMin: 2 } }), O.holdMinutes({ waInbox: { holdAutoReleaseMin: 999 } }), O.holdMinutes({ waInbox: { holdAutoReleaseMin: 45 } })], [20, 5, 240, 45]);
  assert.equal(O.accountOf({ id: "cashier", name: "الكاشير", role: "cashier", via: "portal" }).key, "portal:cashier");
  assert.deepEqual([O.canManage(CASHIER), O.canManage(MANAGER), O.canManage({ role: "owner" }), O.canManage({ role: "operations" }), O.canManage({ role: "kitchen" })], [false, true, true, true, false]);
});

test("the module writes none of the bot's tables: every change there goes through the bot's own functions", () => {
  const src = fs.readFileSync(new URL("./waowner.js", import.meta.url), "utf8");
  assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+wa_bot_/i.test(src));
  assert.ok(!/graph\.facebook|fetch\(/.test(src));
});

test("portal take: the cashier holds the chat for the settable time, the bot is silenced through holdChat, and it is logged and announced", async () => {
  const w = world({ settings: { waInbox: { holdAutoReleaseMin: 15 } } });
  const r = await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  assert.equal(r.status, 200); assert.equal(r.body.owner.state, "held"); assert.equal(r.body.owner.mine, true);
  assert.deepEqual(r.body.owner.by, { id: "s1", name: "سلمى", role: "cashier", via: "portal" });
  assert.equal(Date.parse(r.body.owner.autoReleaseAt) - w.clock.now(), 15 * 60_000);
  assert.equal(r.body.owner.waitedMin, 3);
  assert.deepEqual(w.db.jobsCancelled, [A]);
  assert.deepEqual(w.db.log.map((l) => [l.action, l.by_name, l.via, l.forced]), [["take", "سلمى", "portal", false]]);
  assert.equal(w.events.length, 1); assert.equal(w.events[0][0], "wa_chat_owner"); assert.equal(w.events[0][1].key, keyOf(A)); assert.equal(w.events[0][1].owner.state, "held");
  assert.ok(!JSON.stringify(w.events).includes(A), "no phone number in the live event");
  /* تاني مرة من نفس الحساب: المهلة تتجدد و«من امتى» زي ما هي ومفيش صف سجل جديد */
  w.clock.advance(5);
  const again = await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  assert.equal(again.body.owner.since, r.body.owner.since); assert.equal(Date.parse(again.body.owner.autoReleaseAt) - w.clock.now(), 15 * 60_000); assert.equal(w.db.log.length, 1);
  /* مطبخ ممنوع، ومفتاح غلط 404 */
  w.users.portal = { id: "k", name: "مطبخ", role: "kitchen" };
  assert.equal((await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } })).status, 403);
  w.users.portal = CASHIER;
  assert.equal((await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: "f".repeat(32) } })).status, 404);
});

test("someone else's chat: a cashier is refused (409 / 403); a manager takes it over or releases it; force from a cashier does nothing", async () => {
  const w = world();
  await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  w.users.portal = CASHIER2;
  const no = await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) }, json: { force: true } });
  assert.equal(no.status, 409); assert.equal(no.body.error, "held_by_other"); assert.equal(no.body.owner.by.name, "سلمى"); assert.match(no.body.message, /سلمى/);
  for (const act of ["release", "done"]) { const x = await w.call(`POST /api/portal/wa/chats/:key/${act}`, { param: { key: keyOf(A) } }); assert.equal(x.status, 403); assert.equal(x.body.error, "not_yours"); }
  assert.equal(w.db.holds.get(A).by_name, "سلمى");
  w.users.portal = MANAGER;
  assert.equal((await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } })).status, 409, "a manager must say force");
  const over = await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) }, json: { force: true } });
  assert.equal(over.status, 200); assert.equal(over.body.owner.by.name, "خالد"); assert.equal(over.body.owner.mine, true);
  assert.deepEqual(w.db.log.slice(-1).map((l) => [l.action, l.by_name, l.forced, l.prev]), [["take", "خالد", true, "سلمى"]]);
  /* المدير يسيب محادثة كاشير */
  w.users.portal = CASHIER; await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(B) } });
  w.users.portal = MANAGER;
  const rel = await w.call("POST /api/portal/wa/chats/:key/release", { param: { key: keyOf(B) } });
  assert.equal(rel.status, 200); assert.equal(rel.body.owner.state, "bot"); assert.equal(w.db.log.slice(-1)[0].forced, true);
});

test("release hands the chat to the bot at once (release flag, handover closed); done also marks it closed until the customer writes", async () => {
  const w = world();
  Object.assign(w.chat(A), { handoff_at: w.at(8), handoff_reason: "handover" });
  await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  const rel = await w.call("POST /api/portal/wa/chats/:key/release", { param: { key: keyOf(A) } });
  assert.equal(rel.body.owner.state, "bot");
  const c = w.db.chats.get(A);
  assert.equal(c.muted_until, null); assert.equal(c.handoff_at, null); assert.ok(c.released_at, "the bot is told to ignore the staff's earlier replies");
  assert.equal(w.db.holds.has(A), false);
  /* done من غير سحب: بيقفل التحويل المفتوح */
  Object.assign(w.chat(B), { handoff_at: w.at(8), handoff_reason: "complaint" });
  const d = await w.call("POST /api/portal/wa/chats/:key/done", { param: { key: keyOf(B) } });
  assert.equal(d.status, 200); assert.equal(d.body.owner.state, "closed"); assert.equal(d.body.owner.by.name, "سلمى"); assert.equal(w.db.chats.get(B).handoff_at, null);
  w.clock.advance(2); w.inbound(B);
  assert.equal((await w.st.owner.ownerFor(B, CASHIER)).state, "bot");
  /* release على محادثة مش مسحوبة = تمام */
  assert.equal((await w.call("POST /api/portal/wa/chats/:key/release", { param: { key: keyOf(B) } })).status, 200);
  assert.deepEqual(w.db.log.map((l) => l.action), ["take", "release", "done", "release"]);
});

test("auto-release: a forgotten hold returns to the bot and keeps the open handover; a staff reply (portal or the restaurant phone) restarts the timer", async () => {
  const w = world();      // المهلة الافتراضية ٢٠ د
  Object.assign(w.chat(A), { handoff_at: w.at(5), handoff_reason: "complaint" });
  await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  w.clock.advance(12);
  /* رد من البورتال: المهلة تبدأ من جديد، والرد بيرجّع owner */
  const rep = await w.call("POST /api/portal/wa/chats/:key/reply", { param: { key: keyOf(A) }, json: { text: "لحظة من فضلك" } });
  assert.equal(rep.status, 200); assert.equal(rep.body.owner.state, "held"); assert.equal(Date.parse(rep.body.owner.autoReleaseAt) - w.clock.now(), 20 * 60_000);
  assert.equal(w.sent[0].source, "echo");
  /* رد من موبايل المطعم (صدى): sweep بيجدد */
  w.clock.advance(15); w.echo(A);
  assert.deepEqual(await w.st.owner.sweep(), { extended: 1, released: 0 });
  assert.equal(Date.parse(w.db.chats.get(A).muted_until) - w.clock.now(), 20 * 60_000);
  assert.deepEqual(await w.st.owner.sweep(), { extended: 0, released: 0 }, "the same echo does not extend twice");
  /* اتنست: بعد ٢١ دقيقة من غير رد */
  w.clock.advance(21);
  assert.equal((await w.st.owner.ownerFor(A, CASHIER)).state, "waiting_staff", "already back with staff-waiting before the sweep runs");
  assert.deepEqual(await w.st.owner.sweep(), { extended: 0, released: 1 });
  const c = w.db.chats.get(A);
  assert.equal(c.muted_until, null); assert.ok(c.handoff_at, "the complaint is still open"); assert.equal(c.released_at || null, null);
  assert.equal(w.db.holds.has(A), false);
  assert.deepEqual(w.db.log.slice(-1).map((l) => [l.action, l.by_key, l.prev]), [["auto_release", null, "سلمى"]]);
  assert.equal(w.events.slice(-1)[0][1].owner.state, "waiting_staff");
  /* الرد مابيسحبش محادثة مش مسحوبة */
  const r2 = await w.call("POST /api/portal/wa/chats/:key/reply", { param: { key: keyOf(B) }, json: { text: "هلا" } });
  assert.equal(r2.body.owner.state, "bot"); assert.equal(w.db.holds.has(B), false);
});

test("lists and the chat carry owner; filters held / mine and their counts; the dashboard routes; owner and operations may take over", async () => {
  const w = world();
  await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  const list = await w.call("GET /api/portal/wa/chats", { query: { filter: "all" } });
  const byKey = Object.fromEntries(list.body.threads.map((t) => [t.key, t.owner]));
  assert.equal(byKey[keyOf(A)].state, "held"); assert.equal(byKey[keyOf(A)].mine, true); assert.equal(byKey[keyOf(B)].state, "bot");
  assert.equal(list.body.counts.held, 1); assert.equal(list.body.counts.mine, 1);
  const mine = await w.call("GET /api/portal/wa/chats", { query: { filter: "mine" } });
  assert.deepEqual(mine.body.threads.map((t) => t.key), [keyOf(A)]); assert.equal(mine.body.filter, "mine");
  w.users.portal = CASHIER2;
  const other = await w.call("GET /api/portal/wa/chats", { query: { filter: "mine" } });
  assert.deepEqual(other.body.threads, []); assert.equal(other.body.counts.mine, 0); assert.equal(other.body.counts.held, 1);
  const one = await w.call("GET /api/portal/wa/chats/:key", { param: { key: keyOf(A) } });
  assert.equal(one.body.owner.state, "held"); assert.equal(one.body.owner.mine, false); assert.equal(one.body.owner.by.name, "سلمى");
  /* اللوحة */
  const dl = await w.call("GET /api/cms/wa/threads", { query: { filter: "held" } });
  assert.deepEqual(dl.body.threads.map((t) => [t.key, t.owner.state, t.owner.mine]), [[keyOf(A), "held", false]]);
  const dt = await w.call("POST /api/cms/wa/threads/:key/take", { param: { key: keyOf(A) } });
  assert.equal(dt.status, 409); assert.equal(dt.body.error, "held_by_other");
  const df = await w.call("POST /api/cms/wa/threads/:key/take", { param: { key: keyOf(A) }, json: { force: true } });
  assert.equal(df.status, 200); assert.deepEqual(df.body.owner.by, { id: "ops1", name: "عمليات", role: "operations", via: "dashboard" });
  const dd = await w.call("POST /api/cms/wa/threads/:key/done", { param: { key: keyOf(A) } });
  assert.equal(dd.body.owner.state, "closed");
  assert.equal((await w.call("GET /api/cms/wa/threads/:key", { param: { key: keyOf(A) } })).body.owner.state, "closed");
  /* دور مش مسموح له بالمحادثات */
  w.users.dash = { id: 9, username: "mk", name: "تسويق", role: "marketing" };
  assert.equal((await w.call("POST /api/cms/wa/threads/:key/take", { param: { key: keyOf(B) } })).status, 403);
});

test("the hold time is a setting: anyone in the section reads it, only the owner saves it, inside 5–240", async () => {
  const w = world();
  { const g = (await w.call("GET /api/cms/wa/threads-hold")).body; assert.deepEqual([g.ok, g.holdAutoReleaseMin, g.default, g.min, g.max, g.mediaKeepDays], [true, 20, 20, 5, 240, 30]); }
  assert.equal((await w.call("POST /api/cms/wa/threads-hold", { json: { holdAutoReleaseMin: 30 } })).status, 403);
  w.users.owner = true;
  assert.equal((await w.call("POST /api/cms/wa/threads-hold", { json: { holdAutoReleaseMin: 3 } })).status, 400);
  assert.equal((await w.call("POST /api/cms/wa/threads-hold", { json: { holdAutoReleaseMin: "x" } })).status, 400);
  w.db.settings.waInbox = { other: 1 };
  const ok = await w.call("POST /api/cms/wa/threads-hold", { json: { holdAutoReleaseMin: 30 } });
  assert.equal(ok.body.holdAutoReleaseMin, 30); assert.deepEqual(w.db.settings.waInbox, { other: 1, holdAutoReleaseMin: 30 });
  const t = await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  assert.equal(Date.parse(t.body.owner.autoReleaseAt) - w.clock.now(), 30 * 60_000);
});

test("the bot module is missing ⇒ 503, nothing written", async () => {
  const w = world();
  w.bot.holdChat = undefined;
  const r = await w.call("POST /api/portal/wa/chats/:key/take", { param: { key: keyOf(A) } });
  assert.equal(r.status, 503); assert.equal(r.body.error, "unavailable"); assert.equal(w.db.holds.size, 0);
});
