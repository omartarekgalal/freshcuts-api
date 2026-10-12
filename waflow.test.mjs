/* 🪜 حركة المحادثة (ST2) — node --test waflow.test.mjs
   قاعدة وهمية بحالة + waowner.js الحقيقي فوق بوت وهمي + بديل لـwateam بيسجّل كل رسالة فريق. مفيش شبكة ولا رسالة حقيقية. */
import test from "node:test";
import assert from "node:assert/strict";

const F = await import("./waflow.js");
const O = await import("./waowner.js");
const T = await import("./wateam.js");
const A = await import("./waassistrun.js");

const CUST = "512345678", CASH1 = "561000001", CASH2 = "561000002", MGR = "506000003", OWN1 = "544000004", OWN2 = "561000005";
const MEMBERS = [{ phone: `0${CASH1}`, name: "منى", role: "cashier" }, { phone: `0${CASH2}`, name: "سارة", role: "cashier" }, { phone: `0${MGR}`, name: "خالد", role: "manager" },
  { phone: `0${OWN1}`, name: "عمر", role: "owner" }, { phone: `0${OWN2}`, name: "طارق", role: "owner" }];
const P_CASHIER = { id: "s1", name: "سلمى", role: "cashier", via: "portal" }, P_MANAGER = { id: "m1", name: "خالد", role: "manager", via: "portal" };
const MIN = 60_000;

function world({ waTeam = { members: MEMBERS }, at = "2026-10-13T15:00:00Z" } = {}) {
  let nowMs = Date.parse(at);
  const clock = { now: () => new Date(nowMs), advance: (m) => { nowMs += m * MIN; } };
  const iso = (v) => new Date(v).toISOString();
  const db = { settings: { ...(waTeam ? { waTeam } : {}) }, flow: new Map(), fidSeq: 0, pending: new Map(), holds: new Map(), chats: new Map(), threads: new Map([[CUST, { phone_norm: CUST, last_in_at: iso(nowMs - 2 * MIN) }]]),
    msgs: [], handovers: [], names: new Map([[CUST, "محمد أحمد"]]), ownerLog: [], handled: [] };
  const chat = (pn) => { if (!db.chats.has(pn)) db.chats.set(pn, { phone_norm: pn }); return db.chats.get(pn); };
  const lastEcho = (pn) => db.msgs.filter((m) => m.phone === pn && m.source === "echo").map((m) => m.at).sort().pop() || null;
  const upsert = (pn, patch) => { const cur = db.flow.get(pn) || { fid: ++db.fidSeq, phone_norm: pn, ho_at: null, reason: null, reason_ar: null, urgent: false, order_no: null, step: null, alerted: [], transfer: null, last_close: null, handback: null, close_reminded_at: null };
    const next = { ...cur, ...patch }; db.flow.set(pn, next); return next; };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    /* waowner */
    if (/^SELECT t\.phone_norm, t\.last_in_at, b\.muted_until/i.test(s)) { const t = db.threads.get(p[0]); if (!t) return { rows: [] }; const c = db.chats.get(p[0]) || {}; return { rows: [{ ...t, muted_until: c.muted_until || null, muted_by: c.muted_by || null, handoff_at: c.handoff_at || null, handoff_reason: c.handoff_reason || null, last_echo_at: lastEcho(p[0]) }] }; }
    if (/^SELECT phone_norm, state, by_key.* FROM wa_chat_holds WHERE phone_norm = ANY/i.test(s)) return { rows: p[0].map((x) => db.holds.get(x)).filter(Boolean) };
    if (/^INSERT INTO wa_chat_holds\(.*VALUES \(\$1,'held'/i.test(s)) { const old = db.holds.get(p[0]); const same = old && old.state === "held" && old.by_key === p[1]; db.holds.set(p[0], { phone_norm: p[0], state: "held", by_key: p[1], by_id: p[2], by_name: p[3], role: p[4], via: p[5], since: same ? old.since : iso(nowMs), touched_at: iso(nowMs) }); return { rows: [] }; }
    if (/^INSERT INTO wa_chat_holds\(.*VALUES \(\$1,'closed'/i.test(s)) { db.holds.set(p[0], { phone_norm: p[0], state: "closed", by_key: p[1], by_id: p[2], by_name: p[3], role: p[4], via: p[5], since: iso(nowMs), touched_at: iso(nowMs) }); return { rows: [] }; }
    if (/^DELETE FROM wa_chat_holds/i.test(s)) { db.holds.delete(p[0]); return { rows: [] }; }
    if (/^INSERT INTO wa_chat_owner_log/i.test(s)) { db.ownerLog.push([p[1], p[3]]); return { rows: [] }; }
    if (/^SELECT since FROM wa_chat_holds WHERE phone_norm=\$1 AND state='held'/i.test(s)) { const h = db.holds.get(p[0]); return { rows: h && h.state === "held" ? [{ since: h.since }] : [] }; }
    /* waflow */
    if (/^SELECT \* FROM wa_flow WHERE phone_norm=\$1/i.test(s)) return { rows: db.flow.has(p[0]) ? [{ ...db.flow.get(p[0]) }] : [] };
    if (/^SELECT \* FROM wa_flow WHERE fid=\$1/i.test(s)) return { rows: [...db.flow.values()].filter((r) => r.fid === p[0]).map((r) => ({ ...r })) };
    if (/^SELECT \* FROM wa_flow WHERE phone_norm = ANY/i.test(s)) return { rows: p[0].map((x) => db.flow.get(x)).filter(Boolean).map((r) => ({ ...r })) };
    if (/^SELECT \* FROM wa_flow WHERE step IN \('cashier','manager'\) AND ho_at > \$1/i.test(s)) return { rows: [...db.flow.values()].filter((r) => ["cashier", "manager"].includes(r.step) && Date.parse(r.ho_at) > Date.parse(p[0])).map((r) => ({ ...r })) };
    if (/^INSERT INTO wa_flow\(phone_norm, ho_at, reason/i.test(s)) return { rows: [{ ...upsert(p[0], { ho_at: p[1], reason: p[2], reason_ar: p[3], urgent: p[4], order_no: p[5], step: p[6], alerted: JSON.parse(p[7]), transfer: null, close_reminded_at: null }) }] };
    if (/^UPDATE wa_flow SET step=NULL, updated_at=NOW\(\) WHERE phone_norm=\$1 AND step=\$2/i.test(s)) { const r = db.flow.get(p[0]); if (r && r.step === p[1]) r.step = null; return { rows: [] }; }
    if (/^UPDATE wa_flow SET step=\$3, alerted=\$4::jsonb/i.test(s)) { const r = db.flow.get(p[0]); if (!r || r.step !== p[1]) return { rows: [] }; r.step = p[2]; r.alerted = JSON.parse(p[3]); return { rows: [{ fid: r.fid }] }; }
    if (/^UPDATE wa_flow SET step=NULL, close_reminded_at=NULL/i.test(s)) { const r = db.flow.get(p[0]); if (r) { r.step = null; r.close_reminded_at = null; } return { rows: [] }; }
    if (/^UPDATE wa_flow SET step=NULL, transfer=NULL/i.test(s)) { const r = db.flow.get(p[0]); if (r) { r.step = null; r.transfer = null; } return { rows: [] }; }
    if (/^INSERT INTO wa_flow\(phone_norm, step, transfer, last_close, handback/i.test(s)) { upsert(p[0], { step: null, transfer: null, last_close: JSON.parse(p[1]), handback: JSON.parse(p[2]) }); return { rows: [] }; }
    if (/^INSERT INTO wa_flow\(phone_norm, transfer, step/i.test(s)) return { rows: [{ ...upsert(p[0], { transfer: JSON.parse(p[1]), step: null, close_reminded_at: null }) }] };
    if (/^INSERT INTO wa_flow\(phone_norm, close_reminded_at/i.test(s)) { const cur = db.flow.get(p[0]); if (cur && cur.close_reminded_at && !(Date.parse(cur.close_reminded_at) < Date.parse(p[2]))) return { rows: [] }; const r = upsert(p[0], { close_reminded_at: p[1] }); return { rows: [{ fid: r.fid }] }; }
    if (/^UPDATE wa_flow SET handback=NULL/i.test(s)) { const r = db.flow.get(p[0]); if (r) r.handback = null; return { rows: [] }; }
    if (/^SELECT count\(\*\)::int AS n FROM wa_flow f WHERE f\.transfer IS NOT NULL/i.test(s)) return { rows: [{ n: [...db.flow.values()].filter((r) => r.transfer && !(db.holds.get(r.phone_norm) && db.holds.get(r.phone_norm).state === "held")).length }] };
    if (/^SELECT handoff_at FROM wa_bot_chats WHERE phone_norm=\$1/i.test(s)) return { rows: db.chats.has(p[0]) ? [{ handoff_at: db.chats.get(p[0]).handoff_at || null }] : [] };
    if (/^SELECT b\.handoff_at, b\.muted_until, \(SELECT 1 FROM wa_messages/i.test(s)) { const c = db.chats.get(p[0]); if (!c) return { rows: [] };
      return { rows: [{ handoff_at: c.handoff_at || null, muted_until: c.muted_until || null, answered: db.msgs.some((m) => m.phone === p[0] && m.source === "echo" && Date.parse(m.at) > Date.parse(p[1])) ? 1 : null,
        acked: db.handovers.some((h) => h.phone === p[0] && h.acked_at) ? 1 : null }] }; }
    if (/^SELECT COALESCE\(full_name, profile_name\) AS name FROM wa_contact_names/i.test(s)) return { rows: db.names.has(p[0]) ? [{ name: db.names.get(p[0]) }] : [] };
    if (/^SELECT body FROM wa_messages WHERE phone_norm=\$1 AND source='echo'/i.test(s)) return { rows: db.msgs.filter((m) => m.phone === p[0] && m.source === "echo" && Date.parse(m.at) > Date.parse(p[1])).map((m) => ({ body: m.body })) };
    if (/^UPDATE wa_handovers SET acked_at=NOW\(\)/i.test(s)) { const open = db.handovers.filter((h) => h.phone === p[0] && !h.acked_at); for (const h of open) h.acked_at = iso(nowMs); return { rows: open.map((h) => ({ id: h.id })) }; }
    if (/^SELECT h\.phone_norm, h\.by_id, h\.by_name, h\.role, h\.since, t\.last_in_at, f\.close_reminded_at/i.test(s)) return { rows: [...db.holds.values()].filter((h) => h.state === "held").map((h) => ({ phone_norm: h.phone_norm, by_id: h.by_id, by_name: h.by_name, role: h.role, since: h.since,
      last_in_at: (db.threads.get(h.phone_norm) || {}).last_in_at || null, close_reminded_at: (db.flow.get(h.phone_norm) || {}).close_reminded_at || null, last_echo_at: lastEcho(h.phone_norm) })) };
    if (/^INSERT INTO wa_flow_pending/i.test(s)) { db.pending.set(p[0], { phone_norm: p[1], kind: "transfer", at: p[2] }); return { rows: [] }; }
    if (/^DELETE FROM wa_flow_pending WHERE staff_phone=\$1 RETURNING/i.test(s)) { const x = db.pending.get(p[0]); db.pending.delete(p[0]); return { rows: x ? [x] : [] }; }
    throw new Error("unexpected SQL: " + s.slice(0, 90));
  } };
  const bot = { lines: [],
    holdChat: async (pn, minutes, by) => { Object.assign(chat(pn), { muted_until: iso(nowMs + minutes * MIN), muted_by: by }); },
    unmuteChat: async (pn, { keepHandover = false } = {}) => { const c = chat(pn); Object.assign(c, { muted_until: null, muted_by: null }); if (!keepHandover) Object.assign(c, { handoff_at: null, handoff_reason: null }); },
    botConfig: async () => ({ handoffOpenHours: 24 }), sendFlowLine: async (pn, key) => { bot.lines.push([pn, key]); return "sent"; } };
  const ctx = { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)) };
  const events = [], sent = [];
  const owner = O.create({ pool, getSettingsData: ctx.getSettingsData, bot: () => bot, keyOf: (pn) => `k${pn}`, noTimer: true, now: () => nowMs, log: { error() {} } });
  const team = { sendToStaff: async (cfg, m, msg) => { sent.push({ to: m.phone, role: m.role, ...msg }); return { ok: true, via: "wa_free" }; },
    fanOut: async (cfg, members, build) => { for (const m of members) sent.push({ to: m.phone, role: m.role, ...build(m) }); return { sent: members.length, wa: members.length, sms: 0, failed: 0, to: members.length }; },
    lastCustomerText: async () => "الطلب وصل بارد، كلموني على [رقم]" };
  const routes = {};
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  let portalUser = P_CASHIER;
  const flow = F.register(app, ctx, { team: () => team, staff: () => ({ owner }), bot: () => bot, hub: () => ({ keyOf: (pn) => `k${pn}`, markHandled: async (pn) => { db.handled.push(pn); } }),
    broadcast: (e, d) => events.push([e, d]), now: clock.now, noTimer: true, log: { error() {} }, requirePortal: async () => ({ user: portalUser }) });
  const cfg = () => T.teamConfig(db.settings);
  const handover = (o = {}) => { chat(CUST).handoff_at = iso(nowMs); chat(CUST).handoff_reason = o.reason || "asked_human";
    return flow.onHandover({ cfg: cfg(), phone: CUST, reason: "asked_human", reasonAr: "طلب موظف", urgent: false, orderNo: null, stage: "new", sms: "SMS", ...o }); };
  const echo = (body) => db.msgs.push({ phone: CUST, source: "echo", body, at: iso(nowMs) });
  const tap = (member, id, extra = {}) => flow.staffInbound({ phone: member.phone.slice(1), type: "interactive", interactiveId: id, text: "", ...extra }, { ...member, phone: member.phone.slice(1), active: true }, cfg());
  const call = (k) => routes[k]({ req: {}, json: (body, status = 200) => ({ body, status }) });
  return { db, clock, flow, owner, bot, sent, events, cfg, handover, echo, tap, call, chat, setPortalUser: (u) => { portalUser = u; } };
}
const roles = (w, from = 0) => w.sent.slice(from).map((s) => s.role);

/* ══ ١) السلّم ════════════════════════════════════════════════════════════ */
test("ladder: cashiers first; nobody took it after 5 minutes ⇒ the manager; 10 more ⇒ the owners, with the manager's number", async () => {
  const w = world();
  assert.deepEqual(await w.handover(), { sent: 2, wa: 2, sms: 0, failed: 0, to: 2 });
  assert.deepEqual(w.sent.map((s) => s.to), [CASH1, CASH2]);
  assert.equal(w.sent[0].body, ["💬 تحويل لموظف — طلب موظف", "العميل: محمد …5678", "آخر رسالة منه: «الطلب وصل بارد، كلموني على [رقم]»", "مستني: لسه دلوقتي",
    "المطلوب: اضغط «استلم المحادثة» ورد على العميل من البورتال، ولما تخلص «خلصت — اقفل».", "رد من البورتال ↗ https://freshcuts-invite.o2m8.me/portal/"].join("\n"));
  assert.deepEqual(w.sent[0].buttons, [{ id: "flow:take:1", title: "استلم المحادثة" }]);
  assert.equal(w.sent[0].sms, "SMS"); assert.ok(!w.sent[0].body.includes(CUST));
  w.clock.advance(4); assert.deepEqual(await w.flow.tick(), { escalated: 0, closeReminders: 0 });
  w.clock.advance(1); assert.equal((await w.flow.tick()).escalated, 1);
  assert.deepEqual(roles(w, 2), ["manager"]);
  assert.match(w.sent[2].body, /^⬆️ تصعيد للمدير: محدش رد على العميل — طلب موظف\nالعميل: محمد …5678\n.*\nمستني: 5 دقايق\nاتبلّغ قبل كده: الكاشير\nالمطلوب: اضغط «استلم المحادثة»/s);
  assert.deepEqual(w.events.at(-1), ["wa_handover", { phone: `0${CUST}`, phoneMasked: "…5678", reason: "asked_human", reasonAr: "طلب موظف", urgent: false, orderNo: null, at: w.db.flow.get(CUST).ho_at, step: "manager", escalated: true, waitedMin: 5, reminder: true }]);
  await w.flow.tick(); w.clock.advance(9); await w.flow.tick();
  assert.equal(w.sent.length, 3, "one message per rung");
  w.clock.advance(1); await w.flow.tick();
  assert.deepEqual(roles(w, 3), ["owner", "owner"]);
  assert.equal(w.sent[3].body, ["⬆️ تصعيد للملاك: العميل لسه من غير رد — طلب موظف", "العميل: محمد …5678", "آخر رسالة منه: «الطلب وصل بارد، كلموني على [رقم]»", "مستني: 15 دقيقة", "اتبلّغ قبل كده: الكاشير، المدير",
    "المسؤول دلوقتي: المدير خالد", `رقم المدير: 0${MGR}`, "المطلوب: تابع مع المدير، أو اضغط «استلم المحادثة» لو هترد بنفسك.", "رد من البورتال ↗ https://freshcuts-invite.o2m8.me/portal/"].join("\n"));
  assert.deepEqual(w.db.flow.get(CUST).alerted.map((a) => a.role), ["cashier", "manager", "owners"]);
  w.clock.advance(60); await w.flow.tick(); assert.equal(w.sent.length, 5, "the ladder ends at the owners");
});

test("ladder stops the moment somebody takes the chat, replies, acks, or the handover closes; an urgent handover tells all three at once", async () => {
  for (const stop of ["take", "echo", "ack", "closed"]) {
    const w = world(); await w.handover();
    if (stop === "take") assert.equal((await w.flow.take(CUST, P_CASHIER)).ok, true);
    if (stop === "echo") { w.clock.advance(1); w.echo("أهلاً، معك سلمى"); }
    if (stop === "ack") w.db.handovers.push({ id: 1, phone: CUST, acked_at: "x" });
    if (stop === "closed") w.chat(CUST).handoff_at = null;
    w.clock.advance(30); await w.flow.tick(); w.clock.advance(30); await w.flow.tick();
    assert.equal(w.sent.length, 2, stop);
  }
  const u = world();
  await u.handover({ reason: "complaint", reasonAr: "شكوى", urgent: true });
  assert.deepEqual(roles(u), ["cashier", "cashier", "manager", "owner", "owner"]);
  assert.match(u.sent[0].body, /^🚨 تحويل عاجل لموظف — شكوى\n/);
  assert.match(u.sent[3].body, /\nالمسؤول دلوقتي: المدير خالد\nرقم المدير: 0506000003\n/);
  u.clock.advance(60); await u.flow.tick(); assert.equal(u.sent.length, 5, "nothing left to escalate");
  // a reminder from the bot goes to the people already told, not further up
  const r = world(); await r.handover();
  await r.flow.onHandover({ cfg: r.cfg(), phone: CUST, reason: "asked_human", reasonAr: "طلب موظف", stage: "reminder", waitedMin: 3, sms: "SMS" });
  assert.deepEqual(roles(r, 2), ["cashier", "cashier"]); assert.match(r.sent[2].body, /^🔔 تذكير: العميل لسه مستني — طلب موظف\n/);
});

test("ladder with gaps in the directory: no cashier ⇒ the manager first; no manager ⇒ straight to the owners; nobody ⇒ null (the old SMS path)", async () => {
  const noCash = world({ waTeam: { members: MEMBERS.slice(2) } }); await noCash.handover(); assert.deepEqual(roles(noCash), ["manager"]);
  const noMgr = world({ waTeam: { members: [MEMBERS[0], MEMBERS[3]] } }); await noMgr.handover(); noMgr.clock.advance(5); await noMgr.flow.tick();
  assert.deepEqual(roles(noMgr), ["cashier", "owner"]); assert.ok(!noMgr.sent[1].body.includes("رقم المدير"));
  assert.equal(await world({ waTeam: { members: [] } }).handover(), null);
  assert.deepEqual([F.nextStep({ step: "cashier", hoAt: "2026-10-13T15:00:00Z", now: "2026-10-13T15:05:00Z", ladder: T.DEFAULTS.ladder }), F.nextStep({ step: "manager", hoAt: "2026-10-13T15:00:00Z", now: "2026-10-13T15:14:59Z", ladder: T.DEFAULTS.ladder }),
    F.nextStep({ step: "manager", hoAt: "2026-10-13T15:00:00Z", now: "2026-10-13T15:15:00Z", ladder: T.DEFAULTS.ladder }), F.nextStep({ step: "owners", hoAt: "2026-10-13T15:00:00Z", now: "2026-10-13T16:00:00Z", ladder: T.DEFAULTS.ladder }),
    F.nextStep({ step: "cashier", hoAt: "2026-10-13T10:00:00Z", now: "2026-10-13T15:00:00Z", ladder: T.DEFAULTS.ladder }), F.nextStep({ step: "cashier", hoAt: "2026-10-13T15:00:00Z", now: "2026-10-13T16:00:00Z", ladder: { ...T.DEFAULTS.ladder, enabled: false } })],
  ["manager", null, "owners", null, null, null]);
  const c = T.teamConfig({ waTeam: { members: MEMBERS, ladder: { managerAfterMin: 3, ownersAfterMin: 500 }, close: { remindAfterMin: 0 } } });
  assert.deepEqual([c.ladder.managerAfterMin, c.ladder.ownersAfterMin, c.close.remindAfterMin, c.close.requireOutcome, c.transfer.enabled], [3, 10, 0, true, true]);
  assert.equal(T.configFromBody({ ladder: { managerAfterMin: 0 } }, {}).ok, false); assert.equal(T.configFromBody({ close: { remindAfterMin: 15, requireOutcome: false }, transfer: { enabled: false } }, {}).ok, true);
});

/* ══ ٢) الحالة والفعل الأساسي ═════════════════════════════════════════════ */
test("flow: ONE primary action per state, for the cashier and for the manager; waitingSince in every state", async () => {
  const w = world();
  const f = async (me, meta = null) => w.flow.flowFor(CUST, me, undefined, meta);
  assert.deepEqual([(await f(P_CASHIER)).state, (await f(P_CASHIER)).primary, (await f(P_CASHIER)).actions, (await f(P_CASHIER)).waitingSince], ["bot", null, ["take"], null]);
  assert.equal((await f(P_CASHIER, { lastInAt: "2026-10-13T14:58:00Z", unanswered: true })).waitingSince, "2026-10-13T14:58:00.000Z", "an unanswered message with no handover still counts as waiting");
  await w.handover();
  const wait = await f(P_CASHIER);
  assert.deepEqual([wait.state, wait.primary, wait.actions, wait.step, wait.kind, wait.kindAr, wait.urgent, wait.waitingSince, wait.alerted.map((a) => a.role)], ["waiting_staff", "take", ["take"], "cashier", "asked_human", "طلب موظف", false, "2026-10-13T15:00:00.000Z", ["cashier"]]);
  const t = await w.flow.take(CUST, P_CASHIER);
  assert.deepEqual([t.flow.state, t.flow.primary, t.flow.actions], ["held", "done", ["done", "release", "transfer"]]);
  assert.deepEqual([(await f({ ...P_CASHIER, id: "s2", name: "نورة" })).primary, (await f({ ...P_CASHIER, id: "s2" })).actions], [null, []], "another cashier: nothing to do");
  assert.deepEqual([(await f(P_MANAGER)).primary, (await f(P_MANAGER)).actions], ["take", ["take"]], "the manager may take over");
  assert.equal((await f(P_CASHIER, { lastInAt: "2026-10-13T15:02:00Z", unanswered: true })).waitingSince, "2026-10-13T15:02:00.000Z");
  assert.equal((await f(P_CASHIER, { lastInAt: "2026-10-13T15:02:00Z", unanswered: false })).waitingSince, null);
  const mt = await w.flow.take(CUST, P_MANAGER, { force: true });
  assert.deepEqual([mt.flow.primary, mt.flow.actions], ["done", ["done", "release"]], "a manager has nobody to transfer to");
  const d = await w.flow.close(CUST, P_MANAGER, { outcome: "answered" });
  assert.deepEqual([d.flow.state, d.flow.primary, d.flow.actions, d.flow.lastClose.outcomeAr, d.flow.lastClose.by], ["closed", null, ["take"], "استفسار واترد عليه", "خالد"]);
  // a hold taken from the staff WhatsApp thread is the same desk as the portal account of that role
  const own = O.ownerOf({ muted_until: "2026-10-13T16:00:00Z" }, { state: "held", by_key: "dashboard:wa:561000001", by_id: "wa:561000001", role: "cashier", via: "dashboard" }, { now: Date.parse("2026-10-13T15:00:00Z"), me: P_CASHIER });
  assert.equal(own.mine, true); assert.equal(O.ownerOf({ muted_until: "2026-10-13T16:00:00Z" }, { state: "held", by_key: "dashboard:wa:561000001", by_id: "wa:561000001", role: "cashier" }, { now: Date.parse("2026-10-13T15:00:00Z"), me: P_MANAGER }).mine, false);
  assert.equal(O.ownerOf({ muted_until: "2026-10-13T16:00:00Z" }, { state: "held", by_key: "portal:s1", by_id: "s1", role: "cashier" }, { now: Date.parse("2026-10-13T15:00:00Z"), me: { ...P_CASHIER, id: "s2" } }).mine, false, "two portal accounts stay separate, as before");
});

/* ══ ٣) القفل بنتيجة ══════════════════════════════════════════════════════ */
test("close: an outcome is required from the list; the note is optional and limited; the close is recorded, acked on the portal and marked handled", async () => {
  const w = world(); await w.handover(); w.db.handovers.push({ id: 9, phone: CUST, acked_at: null });
  await w.flow.take(CUST, P_CASHIER);
  const no = await w.flow.close(CUST, P_CASHIER, {});
  assert.deepEqual([no.ok, no.error, no.status, no.message, no.outcomes], [false, "outcome_required", 400, "اختار نتيجة المحادثة",
    [{ id: "ordered", label: "تم الطلب" }, { id: "answered", label: "استفسار واترد عليه" }, { id: "complaint_solved", label: "شكوى اتحلت" }, { id: "follow_up", label: "محتاج متابعة" }, { id: "not_customer", label: "مش عميل" }]]);
  assert.equal((await w.flow.close(CUST, P_CASHIER, { outcome: "whatever" })).error, "outcome_required");
  assert.equal((await w.flow.close(CUST, P_CASHIER, { outcome: "ordered", note: "x".repeat(301) })).error, "note_too_long");
  assert.equal((await w.flow.close(CUST, { ...P_CASHIER, id: "s2" }, { outcome: "ordered" })).error, "not_yours", "another cashier cannot close it");
  assert.equal(w.db.holds.get(CUST).state, "held", "nothing changed by the refused attempts");
  w.clock.advance(2); w.echo("تمام، طلبك اتسجّل ورقمي 0551234567"); w.echo("هيوصلك خلال الوقت المعتاد");
  const ok = await w.flow.close(CUST, P_CASHIER, { outcome: "follow_up", note: "عايز فاتورة ضريبية على الإيميل" });
  assert.equal(ok.ok, true); assert.equal(ok.flow.state, "closed");
  assert.deepEqual(ok.flow.lastClose, { outcome: "follow_up", outcomeAr: "محتاج متابعة", note: "عايز فاتورة ضريبية على الإيميل", by: "سلمى", at: w.clock.now().toISOString() });
  assert.deepEqual(w.db.handled, [CUST]); assert.ok(w.db.handovers[0].acked_at);
  assert.ok(w.events.some((e) => e[0] === "wa_handover_ack" && e[1].id === 9)); assert.equal(w.events.at(-1)[0], "wa_chat_owner"); assert.equal(w.events.at(-1)[1].flow.state, "closed");
  assert.equal(w.bot.lines.length, 0, "closing sends nothing to the customer");
  // requireOutcome off ⇒ a close with no outcome is stored as «answered»
  const lax = world({ waTeam: { members: MEMBERS, close: { requireOutcome: false } } }); await lax.handover(); await lax.flow.take(CUST, P_CASHIER);
  assert.equal((await lax.flow.close(CUST, P_CASHIER, {})).flow.lastClose.outcome, "answered");
});

test("close reminder: staff answered and never closed ⇒ ONE reminder to the holder after 20 minutes; not while the customer is the one waiting", async () => {
  const w = world(); await w.handover(); await w.flow.take(CUST, P_CASHIER);
  w.clock.advance(25); assert.equal((await w.flow.tick()).closeReminders, 0, "not answered yet: that is not a forgotten close");
  w.echo("أهلاً، تم"); w.clock.advance(19); assert.equal((await w.flow.tick()).closeReminders, 0);
  w.clock.advance(1);
  const before = w.sent.length;
  assert.equal((await w.flow.tick()).closeReminders, 1);
  assert.deepEqual(w.sent.slice(before).map((s) => [s.role, s.kind]), [["cashier", "close_reminder"], ["cashier", "close_reminder"]], "a portal cashier account is the shared desk ⇒ the cashiers");
  assert.equal(w.sent[before].body, "⏳ محادثة محمد …5678 اترد عليها من 20 دقيقة ولسه مفتوحة.\nلو خلصت اضغط «خلصت — اقفل» واختار النتيجة، ولو لسه كمّل مع العميل.");
  assert.deepEqual(w.sent[before].buttons, [{ id: "flow:done:1", title: "خلصت — اقفل" }]);
  assert.deepEqual(w.events.at(-1), ["wa_chat_close_reminder", { key: `k${CUST}`, holder: "سلمى", waitedMin: 20 }]);
  w.clock.advance(30); await w.flow.tick(); assert.equal(w.sent.length, before + 2, "once");
  const c = world(); await c.handover(); await c.flow.take(CUST, P_CASHIER); c.echo("أهلاً"); c.clock.advance(5); c.db.threads.get(CUST).last_in_at = c.clock.now().toISOString(); c.clock.advance(30);
  assert.equal((await c.flow.tick()).closeReminders, 0, "the customer wrote after the reply");
  const off = world({ waTeam: { members: MEMBERS, close: { remindAfterMin: 0 } } }); await off.handover(); await off.flow.take(CUST, P_CASHIER); off.echo("x"); off.clock.advance(90);
  assert.equal((await off.flow.tick()).closeReminders, 0);
});

/* ══ ٤) حوّل للمدير ═══════════════════════════════════════════════════════ */
test("transfer: a cashier hands the chat to the manager with a note; the manager gets it, the customer gets one line, the bot stays silent", async () => {
  const w = world(); await w.handover(); await w.flow.take(CUST, P_CASHIER);
  assert.deepEqual([(await w.flow.transfer(CUST, P_CASHIER, {})).error, (await w.flow.transfer(CUST, P_CASHIER, { note: "  " })).error, (await w.flow.transfer(CUST, P_CASHIER, { note: "x".repeat(301) })).error, (await w.flow.transfer(CUST, P_MANAGER, { note: "x" })).error], ["note_required", "note_required", "note_too_long", "cashier_only"]);
  const before = w.sent.length;
  const r = await w.flow.transfer(CUST, P_CASHIER, { note: "العميل عايز استرجاع — رقمه 0551234567" });
  assert.equal(r.ok, true); assert.equal(r.customerLine, "sent");
  assert.deepEqual([r.flow.state, r.flow.primary, r.flow.actions, r.flow.transfer.by, r.flow.transfer.note, r.flow.waitingSince], ["transferred", null, [], "سلمى", "العميل عايز استرجاع — رقمه 0551234567", w.clock.now().toISOString()]);
  assert.deepEqual(w.sent.slice(before).map((s) => [s.to, s.kind]), [[MGR, "transfer"]]);
  assert.equal(w.sent[before].body, ["↪️ حوّل للمدير — من سلمى", "العميل: محمد …5678", "ملاحظة الكاشير: «العميل عايز استرجاع — رقمه [رقم]»", "آخر رسالة منه: «الطلب وصل بارد، كلموني على [رقم]»", "العميل اتقال له إن المدير هيكمّل معاه.",
    "المطلوب: اضغط «استلم المحادثة» ورد عليه من البورتال، ولما تخلص «خلصت — اقفل».", "رد من البورتال ↗ https://freshcuts-invite.o2m8.me/portal/"].join("\n"));
  assert.deepEqual(w.bot.lines, [[CUST, "transfer_note"]]);
  assert.ok(Date.parse(w.chat(CUST).muted_until) > w.clock.now().getTime(), "still silent for the bot"); assert.equal(w.db.holds.has(CUST), false);
  assert.ok(w.events.some((e) => e[0] === "wa_chat_transfer" && e[1].note === "العميل عايز استرجاع — رقمه 0551234567" && e[1].by === "سلمى"));
  assert.equal(await w.flow.transferredCount(), 1);
  const m = await w.flow.flowFor(CUST, P_MANAGER);
  assert.deepEqual([m.state, m.primary, m.actions], ["transferred", "take", ["take"]]);
  const t = await w.flow.take(CUST, P_MANAGER);
  assert.deepEqual([t.flow.state, t.flow.primary, t.flow.transfer.note], ["held", "done", "العميل عايز استرجاع — رقمه 0551234567"]);
  assert.equal(await w.flow.transferredCount(), 0);
  assert.equal((await w.flow.close(CUST, P_MANAGER, { outcome: "complaint_solved" })).flow.transfer, null);
  // refusals that change nothing
  const other = world(); await other.handover(); await other.flow.take(CUST, { ...P_CASHIER, id: "s2", name: "نورة" });
  assert.equal((await other.flow.transfer(CUST, P_CASHIER, { note: "x" })).error, "held_by_other");
  assert.equal((await world({ waTeam: { members: [MEMBERS[0], MEMBERS[3]] } }).flow.transfer(CUST, P_CASHIER, { note: "x" })).error, "no_manager");
  assert.equal((await world({ waTeam: { members: MEMBERS, transfer: { enabled: false } } }).flow.transfer(CUST, P_CASHIER, { note: "x" })).error, "transfer_off");
});

/* ══ ٥) أزرار واتساب الموظف ═══════════════════════════════════════════════ */
test("staff WhatsApp buttons use the same words: استلم المحادثة → خلصت — اقفل (outcome list) / حوّل للمدير (note as the next message) / رجّعها للبوت", async () => {
  const w = world(); await w.handover();
  const n0 = w.sent.length;
  assert.equal(await w.tap(MEMBERS[0], "flow:take:1"), true);
  assert.equal(w.db.holds.get(CUST).by_id, `wa:${CASH1}`);
  assert.match(w.sent[n0].body, /^✅ المحادثة معاك — محمد …5678\nرد على العميل من البورتال ↗ /);
  assert.deepEqual(w.sent[n0].buttons.map((b) => b.title), ["خلصت — اقفل", "حوّل للمدير", "رجّعها للبوت"]); assert.equal(w.sent[n0].button, false);
  // the portal cashier account can go on with a chat taken from WhatsApp (same desk)
  assert.equal((await w.flow.flowFor(CUST, P_CASHIER)).primary, "done");
  assert.equal(await w.tap(MEMBERS[1], "flow:xfer:1"), true);
  assert.match(w.sent.at(-1).body, /^اكتب ملاحظة قصيرة للمدير عن محادثة …5678/);
  assert.equal(await w.flow.staffInbound({ phone: CASH2, type: "text", text: "العميل زعلان من التأخير وعايز المدير" }, { phone: CASH2, name: "سارة", role: "cashier", active: true }, w.cfg()), true);
  assert.equal(w.db.flow.get(CUST).transfer.note, "العميل زعلان من التأخير وعايز المدير"); assert.equal(w.sent.at(-1).body, "↪️ محادثة …5678 اتحوّلت للمدير بملاحظتك.");
  assert.equal(await w.flow.staffInbound({ phone: CASH2, type: "text", text: "كلام تاني" }, { phone: CASH2, role: "cashier", active: true }, w.cfg()), false, "no pending note ⇒ not ours");
  // the manager takes, asks to close, picks the outcome from the list
  await w.tap(MEMBERS[2], "flow:take:1");
  assert.deepEqual(w.sent.at(-1).buttons.map((b) => b.title), ["خلصت — اقفل", "رجّعها للبوت"]);
  await w.tap(MEMBERS[2], "flow:done:1");
  assert.equal(w.sent.at(-1).body, "نتيجة محادثة …5678 إيه؟ اختار من القايمة عشان تتقفل.");
  assert.deepEqual(w.sent.at(-1).list.rows, T.OUTCOMES.map((o) => ({ id: `flow:out:1:${o.id}`, title: o.label })));
  assert.equal(w.db.holds.get(CUST).state, "held", "asking is not closing");
  await w.tap(MEMBERS[2], "flow:out:1:complaint_solved");
  assert.equal(w.sent.at(-1).body, "✅ اتقفلت محادثة …5678 — شكوى اتحلت."); assert.equal(w.db.flow.get(CUST).last_close.outcome, "complaint_solved");
  // refusals are said, not swallowed; an unknown chat id too; a manager cannot «transfer»
  await w.tap(MEMBERS[0], "flow:take:99"); assert.equal(w.sent.at(-1).body, "المحادثة دي اتقفلت أو اتغيّرت — افتح البورتال");
  await w.tap(MEMBERS[2], "flow:xfer:1"); assert.equal(w.sent.at(-1).body, "«حوّل للمدير» للكاشير بس");
  const x = world(); await x.handover(); await x.flow.take(CUST, { ...P_CASHIER, id: "s2", via: "portal" }); await x.tap(MEMBERS[2], "flow:take:1");
  assert.equal(x.db.holds.get(CUST).role, "manager", "the manager takes over from a cashier");
  await x.tap(MEMBERS[0], "flow:rel:1"); assert.match(x.sent.at(-1).body, /^ماقدرتش: المحادثة ماسكها حد تاني/);
  assert.equal(await x.tap(MEMBERS[0], "team:renew"), false, "not a flow button");
  for (const t of [...Object.values(T.ACTIONS), "✅ جدّد التنبيهات"]) assert.ok([...t].length <= 20, t);
  for (const o of T.OUTCOMES) assert.ok([...o.label].length <= 24, o.label);
});

/* ══ ٦) رجوع المساعد ══════════════════════════════════════════════════════ */
test("assistant re-entry: after the close it gets what staff told the customer (masked), the outcome and the note — once, for 24 h", async () => {
  const w = world(); await w.handover(); await w.flow.take(CUST, P_CASHIER);
  assert.equal(await w.flow.handbackFor(CUST), null, "nothing while staff still hold it");
  w.clock.advance(1); w.echo("أهلاً أستاذ محمد، طلبك اتسجّل"); w.echo("لو فيه مشكلة كلمني على 0551234567");
  await w.flow.close(CUST, P_CASHIER, { outcome: "follow_up", note: "عايز يضيف بيبسي للطلب" });
  w.clock.advance(7);
  const hb = await w.flow.handbackFor(CUST);
  assert.deepEqual(hb, { outcome: "follow_up", outcome_label: "محتاج متابعة", staff_note: "عايز يضيف بيبسي للطلب", staff_told_customer: ["أهلاً أستاذ محمد، طلبك اتسجّل", "لو فيه مشكلة كلمني على [رقم]"], closed_minutes_ago: 7, still_to_do: true });
  const ctx = A.buildContext({ handback: hb });
  assert.deepEqual(ctx.staff_handled_this_chat, hb);
  assert.equal(A.buildContext({}).staff_handled_this_chat, undefined);
  await w.flow.handbackUsed(CUST); assert.equal(await w.flow.handbackFor(CUST), null, "used once");
  const s = world(); await s.handover(); await s.flow.take(CUST, P_CASHIER); await s.flow.close(CUST, P_CASHIER, { outcome: "ordered" });
  assert.deepEqual([(await s.flow.handbackFor(CUST)).still_to_do, (await s.flow.handbackFor(CUST)).staff_told_customer], [false, []]);
  s.clock.advance(24 * 60 + 1); assert.equal(await s.flow.handbackFor(CUST), null, "stale after 24 h");
});

/* ══ ٧) ورقة التعليمات ════════════════════════════════════════════════════ */
test("SOP: numbered Egyptian instructions with the live minutes, the action names and the outcome list; from the portal route by role", async () => {
  const w = world({ waTeam: { members: MEMBERS, ladder: { managerAfterMin: 7, ownersAfterMin: 12 }, close: { remindAfterMin: 25 } } });
  const c = (await w.call("GET /api/portal/wa/sop")).body;
  assert.equal(c.ok, true); assert.equal(c.role, "cashier");
  assert.deepEqual(c.actions, [{ id: "take", label: "استلم المحادثة" }, { id: "release", label: "رجّعها للبوت" }, { id: "done", label: "خلصت — اقفل" }, { id: "transfer", label: "حوّل للمدير" }]);
  assert.deepEqual(c.outcomes.map((o) => o.id), ["ordered", "answered", "complaint_solved", "follow_up", "not_customer"]); assert.ok(c.outcomes.every((o) => o.label && o.hint));
  assert.deepEqual(c.ladder, { managerAfterMin: 7, ownersAfterMin: 12, closeRemindMin: 25 });
  assert.deepEqual(c.sections.map((s) => s.title), ["الكاشير — لما ييجي تحويل من واتساب", "المدير — التصعيد والتحويلات", "القفل — «خلصت — اقفل»"]);
  const all = c.sections.flatMap((s) => s.steps).join("\n");
  for (const need of ["«استلم المحادثة»", "«حوّل للمدير»", "«رجّعها للبوت»", "«خلصت — اقفل»", "خلال 7 دقايق", "بـ12 دقايق", "تذكير بعد 25 دقيقة"]) assert.ok(all.includes(need), need);
  assert.ok(c.sections.every((s) => s.steps.length >= 5 && s.steps.every((x) => typeof x === "string" && x.length > 10)));
  w.setPortalUser(P_MANAGER);
  assert.equal((await w.call("GET /api/portal/wa/sop")).body.sections[0].title, "المدير — التصعيد والتحويلات");
  w.setPortalUser({ role: "kitchen" });
  assert.equal((await w.call("GET /api/portal/wa/sop")).status, 403);
  assert.equal((await w.call("GET /api/cms/wa/threads-sop")).body.role, "manager");
});
