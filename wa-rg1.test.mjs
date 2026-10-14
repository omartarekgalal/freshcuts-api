/* RG1 — التحويل يفضل يرنّ لحد ما حد يستلمه، والتصعيد يوصل بوابة المدير، و«طلب مسؤول»، و«البورتال مقفول وقت الشغل» (١٤/١٠).
   قاعدة وهمية بحالة، مفيش شبكة ولا Push حقيقي ولا رسالة لعميل.      node --test wa-rg1.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as HO from "./wahandover.js";
import * as T from "./wateam.js";
import { makePortalPush } from "./portal-push.js";
import { asksManager, MANAGER_ASK_RE } from "./wabotrun.js";
import { matchIntent } from "./wabot.js";

const MIN = 60_000;
const CUST = "512345678";

/* ── wahandover فوق قاعدة وهمية ─────────────────────────────────────────── */
function hoWorld({ at = "2026-10-14T12:29:00Z" } = {}) {
  let nowMs = Date.parse(at);
  const db = { rows: [], seq: 0, holds: new Set(), echoes: [], presence: new Map(), sql: [] };
  const iso = (v) => new Date(v).toISOString();
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    db.sql.push(s.slice(0, 60));
    if (/^CREATE TABLE IF NOT EXISTS wa_handovers/i.test(s)) return { rows: [] };
    if (/^SELECT body FROM wa_messages WHERE phone_norm=\$1 AND direction='in'/i.test(s)) return { rows: [{ body: "ابغي اتواصل مع احد المسؤولين" }] };
    if (/^INSERT INTO wa_handovers/i.test(s)) {
      const row = { id: ++db.seq, phone_norm: p[0], reason: p[1], reason_ar: p[2], urgent: p[3], order_no: p[4], test: p[5], last_text: p[6], at: p[7], acked_at: null, acked_by: null, rung_at: null, rings: 0, escalated_at: null };
      db.rows.push(row); return { rows: [{ ...row }], rowCount: 1 };
    }
    if (/^SELECT id, phone_norm, reason, reason_ar, urgent, order_no, test, last_text, at FROM wa_handovers WHERE phone_norm=\$1 AND acked_at IS NULL ORDER BY at DESC LIMIT 1/i.test(s))
      return { rows: db.rows.filter((r) => r.phone_norm === p[0] && !r.acked_at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 1).map((r) => ({ ...r })) };
    if (/^UPDATE wa_handovers SET rung_at=\$2 WHERE id=\$1/i.test(s)) { const r = db.rows.find((x) => x.id === p[0]); if (r) r.rung_at = p[1]; return { rows: [], rowCount: r ? 1 : 0 }; }
    if (/^UPDATE wa_handovers SET escalated_at=\$2, rung_at=\$2 WHERE id=\$1/i.test(s)) { const r = db.rows.find((x) => x.id === p[0]); if (r) { r.escalated_at = p[1]; r.rung_at = p[1]; } return { rows: [], rowCount: 1 }; }
    if (/^SELECT h\.id, h\.phone_norm/i.test(s)) {
      return { rows: db.rows.filter((r) => !r.acked_at && Date.parse(r.at) > Date.parse(p[0])).map((r) => ({ ...r, taken: db.holds.has(r.phone_norm),
        answered: db.echoes.some((e) => e.phone === r.phone_norm && Date.parse(e.at) > Date.parse(r.at)), superseded: db.rows.some((x) => x.phone_norm === r.phone_norm && x.id > r.id) })) };
    }
    if (/^UPDATE wa_handovers SET acked_at=NOW\(\), acked_by=\$2 WHERE id=\$1 AND acked_at IS NULL/i.test(s)) { const r = db.rows.find((x) => x.id === p[0] && !x.acked_at); if (!r) return { rows: [], rowCount: 0 }; r.acked_at = iso(nowMs); r.acked_by = p[1]; return { rows: [{ id: r.id }], rowCount: 1 }; }
    if (/^UPDATE wa_handovers SET rung_at=\$2, rings=rings\+1 WHERE id=\$1 AND acked_at IS NULL AND COALESCE\(rung_at, at\) <= \$3/i.test(s)) {
      const r = db.rows.find((x) => x.id === p[0] && !x.acked_at && Date.parse(x.rung_at || x.at) <= Date.parse(p[2]));
      if (!r) return { rows: [], rowCount: 0 }; r.rung_at = p[1]; r.rings++; return { rows: [{ id: r.id }], rowCount: 1 };
    }
    if (/^UPDATE portal_presence SET last_visible = last_seen/i.test(s)) return { rows: [], rowCount: 0 };      // PO1 (المراجعة التانية): نقل صفوف RG1 القديمة
    if (/^INSERT INTO portal_presence/i.test(s)) { db.presence.set(`${p[0]}|${p[1]}`, { staff_id: p[0], device: p[1], role: p[2], staff_name: p[3], last_seen: p[4], via: p[5], last_visible: p[6] }); return { rows: [], rowCount: 1 }; }
    if (/^SELECT staff_id, staff_name, role, device, last_seen, seen_since, via, last_visible, visible_since FROM portal_presence/i.test(s)) return { rows: [...db.presence.values()].filter((x) => Date.parse(x.last_seen) > Date.parse(p[0])) };
    throw new Error("unexpected SQL: " + s.slice(0, 90));
  } };
  const routes = {}, events = [], pushes = [];
  const app = { get: (path, h) => { routes[`GET ${path}`] = h; }, post: (path, h) => { routes[`POST ${path}`] = h; } };
  let user = { id: "s1", name: "منى", role: "cashier" };
  const make = () => HO.register(app, { pool }, { requirePortal: async () => ({ user }), broadcast: (e, d) => events.push([e, d]), now: () => new Date(nowMs), log: { error() {} }, noTimer: true,
    push: () => ({ PORTAL_URL: "https://freshcuts-invite.o2m8.me/portal/", sendToSubs: async (pl, o = {}) => { pushes.push({ ...pl, to: o.role || "all" }); return { sent: 1, of: 1 }; } }) });
  const api = make();
  const poll = (ua = "iPhone Safari") => routes["GET /api/portal/wa-handovers"]({ req: { param: () => null, header: () => ua }, json: (body, status = 200) => ({ body, status }) });
  return { db, events, pushes, api, make, poll, advance: (m) => { nowMs += m * MIN; }, now: () => new Date(nowMs), setUser: (u) => { user = u; } };
}
const EV = { phone: `0${CUST}`, reason: "asked_human", reasonAr: "طلب موظف", urgent: false, orderNo: null, at: "2026-10-14T12:29:00Z", test: false };
const RING = { enabled: true, everyMin: 3, capMin: 45 };

test("ringPlan: an open handover nobody took rings again every N minutes until the cap; taken / answered close it; test, newer card or switch off ⇒ silent", () => {
  const now = "2026-10-14T12:35:00Z";
  const row = (o) => ({ id: 1, at: "2026-10-14T12:29:00Z", rung_at: null, test: false, ...o });
  assert.deepEqual(HO.ringPlan([row()], { now, everyMin: 3, capMin: 45 }).ring.map((r) => r.id), [1]);
  assert.deepEqual(HO.ringPlan([row({ rung_at: "2026-10-14T12:34:00Z" })], { now, everyMin: 3, capMin: 45 }).ring, [], "rang a minute ago");
  assert.deepEqual(HO.ringPlan([row({ at: "2026-10-14T11:49:00Z" })], { now, everyMin: 3, capMin: 45 }).ring, [], "past the 45-minute cap");
  assert.deepEqual(HO.ringPlan([row({ test: true }), row({ id: 2, superseded: true })], { now, everyMin: 3, capMin: 45 }).ring, []);
  assert.deepEqual(HO.ringPlan([row()], { now, everyMin: 3, capMin: 45, enabled: false }).ring, []);
  assert.deepEqual(HO.ringPlan([row({ taken: true }), row({ id: 2, answered: true })], { now, everyMin: 3, capMin: 45, enabled: false }).settle, [{ id: 1, by: "استلمها موظف" }, { id: 2, by: "اترد على العميل" }], "settling works even with the ring off");
});

test("the 14/10 case: rings at 12:29, the 12:34 reminder, then every 3 minutes with requireInteraction + renotify — and a restart does not ring twice", async () => {
  const w = hoWorld();
  const out = await w.api.emit(EV);
  assert.equal(w.pushes.length, 1); assert.equal(w.pushes[0].requireInteraction, false, "the first push stays as it was");
  w.advance(3); assert.deepEqual(await w.api.ringDue(RING), { settled: 0, rung: 1 });
  const p = w.pushes[1];
  assert.equal(p.title, "🔔 لسه مستني 3 دقايق: طلب موظف"); assert.equal(p.body, "عميل …5678 محتاج موظف ومحدش استلم");
  assert.deepEqual([p.requireInteraction, p.renotify, p.urgency, p.tag, p.to], [true, true, "high", `wa-handover-${out.id}`, "all"]);
  assert.deepEqual(w.events.at(-1)[0], "wa_handover"); assert.equal(w.events.at(-1)[1].ring, true); assert.equal(w.events.at(-1)[1].waitedMin, 3);
  w.advance(2); await w.api.emit({ ...EV, reminder: true, waitedMin: 5 });      // the bot's 12:34 reminder counts as a ring
  w.advance(1); assert.equal((await w.api.ringDue(RING)).rung, 0, "a minute after the reminder: nothing");
  const again = w.make();      // a second container / a restart sharing the same table
  w.advance(2); assert.equal((await again.ringDue(RING)).rung, 1); assert.equal((await w.api.ringDue(RING)).rung, 0, "the claim in the row stops the twin");
  for (let i = 0; i < 20; i++) { w.advance(3); await w.api.ringDue(RING); }
  const rings = w.db.rows[0].rings;
  assert.ok(rings >= 12 && rings <= 14, `stops at the 45-minute cap (rings ${rings})`);
  assert.ok(w.pushes.every((x) => !/512345678/.test(JSON.stringify(x))), "masked number only");
});

test("taken or answered ⇒ the card closes on every portal (wa_handover_ack) and stops ringing; test-mode handovers never push", async () => {
  const w = hoWorld();
  await w.api.emit(EV);
  w.db.holds.add(CUST); w.advance(3);
  assert.deepEqual(await w.api.ringDue(RING), { settled: 1, rung: 0 });
  assert.deepEqual(w.events.at(-1), ["wa_handover_ack", { id: 1, by: "استلمها موظف" }]);
  const e = hoWorld(); await e.api.emit(EV); e.advance(1); e.db.echoes.push({ phone: CUST, at: e.now().toISOString() }); e.advance(3);
  assert.deepEqual(await e.api.ringDue(RING), { settled: 1, rung: 0 });
  const t = hoWorld(); await t.api.emit({ ...EV, test: true }); t.advance(10);
  assert.deepEqual(await t.api.ringDue(RING), { settled: 0, rung: 0 }); assert.equal(t.pushes.length, 0);
  const off = hoWorld(); await off.api.emit(EV); off.advance(10);
  assert.equal((await off.api.ringDue({ ...RING, enabled: false })).rung, 0);
});

test("escalation to the manager: wa_handover_escalated with the card id + a push to manager devices only; «طلب مسؤول» says so", async () => {
  const w = hoWorld();
  await w.api.emit(EV); w.advance(5);
  const ev = await w.api.escalate({ phone: CUST, waitedMin: 5 });
  assert.equal(ev.id, 1); assert.equal(ev.step, "manager"); assert.equal(ev.waitedMin, 5); assert.equal(ev.direct, false);
  assert.deepEqual(w.events.at(-1)[0], "wa_handover_escalated");
  const p = w.pushes.at(-1);
  assert.deepEqual([p.to, p.title, p.body, p.requireInteraction, p.urgency], ["manager", "⬆️ تصعيد للمدير: طلب موظف", "عميل …5678 مستني من 5 دقايق ومحدش استلم", true, "high"]);
  assert.ok(w.db.rows[0].escalated_at && w.db.rows[0].rung_at, "counts as a ring");
  const d = hoWorld(); await d.api.emit({ ...EV, reason: "asked_manager", reasonAr: "طلب مسؤول" });
  assert.deepEqual([d.pushes[0].title, d.pushes[0].requireInteraction, d.pushes[0].urgency], ["🙋 واتساب: طلب مسؤول", true, "high"], "asking for a manager is loud from the first push");
  await d.api.escalate({ phone: CUST, direct: true });
  assert.equal(d.pushes.at(-1).body, "عميل …5678 طالب مسؤول — رد عليه من البوابة");
  const np = hoWorld(); await np.api.emit(EV); await np.api.escalate({ phone: CUST, waitedMin: 5, push: false });
  assert.equal(np.pushes.length, 1, "managerPush off ⇒ the event only"); assert.equal(np.events.at(-1)[0], "wa_handover_escalated");
});

test("portal-push: a role filter (manager devices only)", async () => {
  const seen = [];
  const pool = { async query(sql, vals = []) { seen.push([String(sql).replace(/\s+/g, " "), vals]); return { rows: [] }; } };
  const push = makePortalPush({ pool, getSettingsData: async () => ({ webPushKeys: { publicKey: "p", privateKey: "k" } }), webpush: { sendNotification: async () => {} }, log: { error() {} }, baseUrl: "x", subject: "y" });
  await push.sendToSubs({ kind: "wa_handover", title: "t" }, { role: "manager" });
  const sel = seen.find(([s]) => /FROM portal_push_subs/.test(s) && /SELECT id, sub/.test(s));
  assert.match(sel[0], /WHERE role=\$1/); assert.deepEqual(sel[1], ["manager"]);
});

test("portal presence: a real poll of the handover list = the portal is open; one write a minute per device at most; kitchen/unknown roles ignored", async () => {
  const w = hoWorld();
  await w.poll("Tablet"); await w.poll("Tablet"); w.advance(0.5); await w.poll("Tablet");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.db.sql.filter((s) => /^INSERT INTO portal_presence/.test(s)).length, 1, "throttled");
  w.advance(1); await w.poll("Tablet"); await w.poll("iPhone");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.db.presence.size, 2, "tablet and iPhone are two devices of the same cashier");
  const list = await w.api.presence();
  assert.deepEqual(list.map((x) => [x.staffId, x.role]), [["s1", "cashier"], ["s1", "cashier"]]);
  w.setUser({ id: "k1", role: "kitchen" }); assert.equal(w.api.touch({ id: "k1", role: "kitchen" }, "x"), false);
  assert.notEqual(HO.deviceOf("a"), HO.deviceOf("b")); assert.ok(!/\d{9}/.test(HO.deviceOf("Mozilla/5.0 (iPhone)")));
});

/* ── «طلب مسؤول» ───────────────────────────────────────────────────────── */
test("asked_manager: «مسؤول / مدير / الإدارة / مشرف» and manager/supervisor are a manager request; an ordinary staff request is not", () => {
  for (const t of ["ابغي اتواصل مع احد المسؤولين", "ابي اكلم المدير", "ابغى الإدارة", "وين المشرف", "ممكن المسؤول", "عطوني مديركم", "I want to talk to a manager", "supervisor please", "المديرة لو سمحت"]) {
    assert.equal(asksManager(t), true, t); assert.equal(matchIntent(t, { type: "text" }).intent, "human", t);
  }
  for (const t of ["ابي موظف", "كلموني", "customer service", "التدوير", "الطلب متأخر"]) assert.equal(asksManager(t), false, t);
  assert.ok(MANAGER_ASK_RE instanceof RegExp);
});

/* ── الإعدادات ─────────────────────────────────────────────────────────── */
test("settings: every new knob has a default (on), limits, an Arabic label in the schema, and is validated on save", () => {
  const c = T.teamConfig({ waTeam: { members: [] } });
  assert.deepEqual(c.portalRing, { enabled: true, everyMin: 3, capMin: 45 });
  /* PO1: القيم اللي اتظبطت على اللايف ١٤/١٠ بقت الافتراضي + المفاتيح الجديدة (wa-po1.test.mjs بيغطّيها) */
  assert.deepEqual(c.portalOffline, { enabled: true, afterMin: 10, repeatMin: 45, managerAfter: 3, backStableMin: 2, dailyCap: 6, countBackground: false, managerOnHold: false, backNotice: true });
  assert.deepEqual([c.ladder.managerPush, c.ladder.managerDirect], [true, true]);
  const get = (o, k) => k.split(".").reduce((x, y) => (x == null ? undefined : x[y]), o);
  for (const k of T.KNOBS) {
    assert.notEqual(get(c, k.key), undefined, k.key); assert.match(k.label, /[؀-ۿ]/, k.key);
    if (k.type === "num") assert.ok(Array.isArray(T.LIMITS[k.key]), `limits for ${k.key}`);
  }
  assert.equal(T.configFromBody({ portalRing: { everyMin: 0 } }, {}).ok, false);
  assert.equal(T.configFromBody({ portalOffline: { managerAfter: 11 } }, {}).ok, false);
  assert.equal(T.configFromBody({ ladder: { managerDirect: "yes" } }, {}).ok, false);
  const ok = T.configFromBody({ portalRing: { enabled: false, everyMin: 5 }, portalOffline: { afterMin: 10, backNotice: false }, ladder: { managerPush: false } }, {});
  assert.equal(ok.ok, true);
  const c2 = T.teamConfig({ waTeam: ok.value });
  assert.deepEqual([c2.portalRing.enabled, c2.portalRing.everyMin, c2.portalRing.capMin, c2.portalOffline.afterMin, c2.portalOffline.backNotice, c2.ladder.managerPush, c2.ladder.managerDirect], [false, 5, 45, 10, false, false, true]);
  assert.deepEqual(T.teamConfig({ waTeam: { portalRing: { everyMin: 99 } } }).portalRing.everyMin, 3, "out of range ⇒ default");
});

/* ── البورتال مقفول وقت الشغل ──────────────────────────────────────────────
   PO1 (١٤/١٠ مساءً) غيّر الحالة كلها (حلقة بتخلص بالاستقرار، تكرار وسقف لكل رقم، سلّم جوّه المرة بتذكير للمدير) ⇒ الاختبارات في wa-po1.test.mjs:
   الساعات / الإيقاف / بوابة المدير / المفتاح، وحالة اللوحة، وإعادة يوم ١٤/١٠ بالظبط. */
