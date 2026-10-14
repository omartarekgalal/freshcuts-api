/* PO1 — حضور البوابة = أي نشاط بوابة (طلبات + بث SSE + نبضة)، و«البورتال مقفول» من غير زنّ (١٤/١٠ مساءً).
   يوم ١٤/١٠ بالظبط: ٣٢ رسالة كاشير (١٦ مرة × كاشيرين) + ٥ مدير + ٣ «رجع» في ٣.٥ ساعة ⇒ القواعد الجديدة على نفس الحضور.
   قاعدة وهمية بحالة، مفيش شبكة ولا رسالة حقيقية ولا Postgres.      node --test wa-po1.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import * as HO from "./wahandover.js";
import * as T from "./wateam.js";
import { register as registerPortal } from "./portal.js";
import { hashPin } from "./portal-core.js";

const MIN = 60_000, SEC = 1000;
const CASH1 = "561000001", CASH2 = "561000002", MGR = "506000003", OWN = "544000004";
const MEMBERS = [{ phone: `0${CASH1}`, name: "منى", role: "cashier" }, { phone: `0${CASH2}`, name: "سارة", role: "cashier" }, { phone: `0${MGR}`, name: "خالد", role: "manager" }, { phone: `0${OWN}`, name: "عمر", role: "owner" }];
const TABLET = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const CASHIER = { id: "s1", name: "منى", role: "cashier" };
const utc = (hms, day = "2026-10-14") => Date.parse(`${day}T${hms}Z`);
const hms = (ms) => new Date(ms).toISOString().slice(11, 19);
const settle = () => new Promise((r) => setImmediate(r));

/* ── عالم واحد: wahandover (الحضور) + wateam (التنبيهات) فوق نفس القاعدة الوهمية ────────────────────────── */
function world({ start = "2026-10-14T13:00:00Z", waTeam = {}, members = MEMBERS, settings = {}, preLog = [] } = {}) {
  let nowMs = Date.parse(start);
  const ms = (v) => (v ? Date.parse(v) : NaN);
  const db = { presence: new Map(), writes: [], portal: null, to: new Map(), log: [...preLog],
    settings: { waTeam: { members, keeper: { enabled: false }, odd: { enabled: false }, daily: { enabled: false }, ...waTeam }, ...settings } };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    /* ── portal_presence: نفس منطق الـUPSERT (seen_since / visible_since بفجوة STREAK_GAP_MS) ── */
    if (/^INSERT INTO portal_presence/i.test(s)) {
      const [id, dev, role, name, ls, via, lv] = p, k = `${id}|${dev}`, o = db.presence.get(k), GAP = HO.STREAK_GAP_MS;
      db.writes.push({ at: nowMs, k, ls, via, lv });
      if (!o) { db.presence.set(k, { staff_id: id, device: dev, role, staff_name: name, last_seen: ls, seen_since: ls, via, last_visible: lv, visible_since: lv }); return { rows: [] }; }
      const n = { ...o, role, staff_name: name, via };
      n.seen_since = !o.seen_since || ms(o.last_seen) < ms(ls) - GAP ? ls : o.seen_since;
      n.last_seen = ms(o.last_seen) >= ms(ls) ? o.last_seen : ls;
      if (lv) { n.visible_since = !o.visible_since || !o.last_visible || ms(o.last_visible) < ms(lv) - GAP ? lv : o.visible_since; n.last_visible = o.last_visible && ms(o.last_visible) >= ms(lv) ? o.last_visible : lv; }
      db.presence.set(k, n); return { rows: [] };
    }
    if (/^SELECT staff_id, staff_name, role, device, last_seen, seen_since, via, last_visible, visible_since FROM portal_presence/i.test(s))
      return { rows: [...db.presence.values()].filter((x) => ms(x.last_seen) > ms(p[0])).sort((a, b) => ms(b.last_seen) - ms(a.last_seen)).map((x) => ({ ...x })) };
    /* ── wateam ── */
    if (/^SELECT max\(created_at\) AS at FROM wa_messages/i.test(s)) return { rows: [{ at: new Date(nowMs - 60 * MIN).toISOString() }] };      // كل النوافذ مفتوحة
    if (/^INSERT INTO wa_team_log/i.test(s)) { db.log.push({ at: nowMs, to: p[0], role: p[1], topic: p[2], kind: p[3], via: p[4], ok: p[5] }); return { rows: [] }; }
    if (/^SELECT since, alerts, last_alert_at, manager_told, resolved_at FROM wa_team_portal/i.test(s)) return { rows: db.portal ? [{ ...db.portal }] : [] };
    if (/^DELETE FROM wa_team_portal WHERE id='cashier'/i.test(s)) { const r = db.portal; db.portal = null; return { rows: r ? [r] : [] }; }
    if (/^INSERT INTO wa_team_portal\(id, since, alerts, manager_told\)/i.test(s)) { if (!db.portal) db.portal = { since: p[0], alerts: 0, last_alert_at: null, manager_told: false, resolved_at: null }; return { rows: [] }; }
    if (/^UPDATE wa_team_portal SET resolved_at=\$1/i.test(s)) { if (db.portal && !db.portal.resolved_at) db.portal.resolved_at = p[0]; return { rows: [] }; }
    if (/^UPDATE wa_team_portal SET since=\$1, alerts=0/i.test(s)) { if (db.portal) Object.assign(db.portal, { since: p[0], alerts: 0, last_alert_at: null, manager_told: false, resolved_at: null }); return { rows: [] }; }
    if (/^UPDATE wa_team_portal SET alerts=alerts\+1, last_alert_at=\$1/i.test(s)) { if (db.portal) { db.portal.alerts++; db.portal.last_alert_at = p[0]; } return { rows: [] }; }
    if (/^UPDATE wa_team_portal SET manager_told=TRUE/i.test(s)) { if (db.portal) db.portal.manager_told = true; return { rows: [] }; }
    if (/^INSERT INTO wa_team_portal_to\(phone_norm, last_at, last_mgr_at\)/i.test(s)) {
      const [ph, at, cut, mgr] = p, r = db.to.get(ph);
      if (r && r.last_at && ms(r.last_at) > ms(cut)) return { rows: [] };
      db.to.set(ph, { phone_norm: ph, last_at: at, last_mgr_at: mgr || (r && r.last_mgr_at) || null, last_back_at: (r && r.last_back_at) || null });
      return { rows: [{ phone_norm: ph }] };
    }
    if (/^UPDATE wa_team_portal_to SET last_at=\$2, last_back_at=\$2/i.test(s)) {
      const [ph, at, cut, since] = p, r = db.to.get(ph);
      if (!r || !(ms(r.last_mgr_at) >= ms(since)) || (r.last_at && ms(r.last_at) > ms(cut)) || ms(r.last_back_at) >= ms(since)) return { rows: [] };
      r.last_at = at; r.last_back_at = at; return { rows: [{ phone_norm: ph }] };
    }
    if (/^INSERT INTO wa_team_portal_to\(phone_norm, last_at, last_mgr_at, last_back_at\) SELECT/i.test(s)) {      // البذرة من السجل (آخر يوم)
      for (const l of db.log) {
        if (l.topic !== "portal_offline" || l.at <= nowMs - 24 * 60 * MIN || db.to.has(l.to)) continue;
        const mine = db.log.filter((x) => x.to === l.to && x.topic === "portal_offline" && x.at > nowMs - 24 * 60 * MIN), mx = (f) => { const a = mine.filter(f).map((x) => x.at); return a.length ? new Date(Math.max(...a)).toISOString() : null; };
        db.to.set(l.to, { phone_norm: l.to, last_at: mx(() => true), last_mgr_at: mx((x) => x.kind === "manager"), last_back_at: mx((x) => x.kind === "back") });
      }
      return { rows: [] };
    }
    if (/^SELECT phone_norm, last_mgr_at, last_back_at FROM wa_team_portal_to/i.test(s)) return { rows: [...db.to.values()].filter((r) => p[0].includes(r.phone_norm)).map((r) => ({ ...r })) };
    if (/^SELECT phone_norm, count\(\*\) FILTER \(WHERE kind='cashier'/i.test(s)) {
      const win = ms(p[0]), day = ms(p[1]), lo = Math.min(win, day), by = new Map();
      for (const l of db.log) {
        if (l.topic !== "portal_offline" || l.at < lo) continue;
        const r = by.get(l.to) || { phone_norm: l.to, win: 0, day: 0, last_cashier: null };
        if (l.kind === "cashier" && l.at > win) r.win++;
        if (l.at >= day) r.day++;
        if (l.kind === "cashier" && (!r.last_cashier || l.at > ms(r.last_cashier))) r.last_cashier = new Date(l.at).toISOString();
        by.set(l.to, r);
      }
      return { rows: [...by.values()] };
    }
    if (/^SELECT count\(\*\)::int AS n FROM wa_team_log WHERE topic='portal_offline'/i.test(s)) return { rows: [{ n: db.log.filter((l) => l.topic === "portal_offline" && l.at >= ms(p[0])).length }] };
    return { rows: [], rowCount: 0 };
  } };
  const sent = [];
  const wa = { sendFreeform: async ({ phoneNorm, payload }) => { sent.push({ at: nowMs, to: phoneNorm, text: payload.interactive ? payload.interactive.body.text : payload.text.body }); return { ok: true }; } };
  const ho = HO.register({ get() {}, post() {} }, { pool }, { requirePortal: async () => ({ res: "no" }), now: () => new Date(nowMs), noTimer: true, log: { error() {} } });
  const team = T.register(null, { pool, requireAdmin: async () => null, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)) },
    { wa, now: () => new Date(nowMs), noTimer: true, log: { error() {} }, presence: () => ho });
  const offLog = () => db.log.filter((l) => l.topic === "portal_offline");
  return { db, ho, team, sent, offLog, setNow: (t) => { nowMs = t; }, now: () => new Date(nowMs), nowMs: () => nowMs,
    signal: (via = "poll", user = CASHIER, ua = TABLET) => ho.seen(user, { ua, via }) };
}
/* سيناريو بالثواني: إشارات + flush كل ١٥ ث (زي السيرفر) + دورات wateam ⇒ نتايج الدورات */
async function play(w, { from, to, signals = [], ticks }) {
  const ev = [];
  for (const s of signals) if (s.t >= from && s.t <= to) ev.push({ t: s.t, k: 0, s });
  for (let t = from; t <= to; t += HO.PRESENCE_FLUSH_MS) ev.push({ t, k: 1 });
  for (const t of ticks) if (t >= from && t <= to) ev.push({ t, k: 2 });
  ev.sort((a, b) => a.t - b.t || a.k - b.k);
  const out = [];
  for (const e of ev) {
    w.setNow(e.t);
    if (e.k === 0) w.signal(e.s.via, e.s.user, e.s.ua);
    else if (e.k === 1) w.ho.flush();
    else { const r = await w.team.tick(); out.push({ t: e.t, portal: r.portal }); }
    await settle();
  }
  return out;
}
const everySec = (a, b, step) => { const o = []; for (let t = a; t <= b; t += step * SEC) o.push(t); return o; };
const polls = (a, b, via = "poll") => everySec(utc(a), utc(b), 20).map((t) => ({ t, via }));

/* ═══ ١) الحضور: أي نشاط بوابة ═════════════════════════════════════════════════════════════════════════════ */
test("presenceVia: the heartbeat, the handover list, the stream, a click and any other read; logout does not count", () => {
  assert.equal(HO.presenceVia("POST", "/api/portal/presence"), "beat");
  assert.equal(HO.presenceVia("GET", "/api/portal/wa-handovers"), "poll");
  assert.equal(HO.presenceVia("GET", "/api/portal/stream"), "sse");
  assert.equal(HO.presenceVia("POST", "/api/portal/orders/W1/ack"), "action");
  assert.equal(HO.presenceVia("POST", "/api/portal/wa/chats/0512/take"), "action");
  assert.equal(HO.presenceVia("GET", "/api/portal/orders"), "api");
  assert.equal(HO.presenceVia("GET", "/api/tables/live"), "api");
  assert.equal(HO.presenceVia("POST", "/api/portal/logout"), null);
  assert.deepEqual([...HO.VISIBLE_VIA], ["beat", "poll", "action"]);
});

test("touch: one write a minute per staff/device at most; signals inside the minute are flushed with their real time (not lost); visible vs connected", async () => {
  const w = world({ start: "2026-10-14T18:00:00Z" });
  w.signal("api"); await settle();
  assert.equal(w.db.writes.length, 1);
  for (const s of [10, 20, 30, 40, 50]) { w.setNow(utc("18:00:00") + s * SEC); w.signal(s === 30 ? "poll" : "sse"); await settle(); }
  assert.equal(w.db.writes.length, 1, "still one write inside the minute");
  w.setNow(utc("18:00:55")); assert.equal(w.ho.flush(), 0, "the minute is not over yet");
  w.setNow(utc("18:01:00")); assert.equal(w.ho.flush(), 1); await settle();
  const row = [...w.db.presence.values()][0];
  assert.deepEqual([row.last_seen, row.last_visible, row.via], ["2026-10-14T18:00:50.000Z", "2026-10-14T18:00:30.000Z", "sse"], "last_seen = the newest signal, last_visible = the newest visible one");
  assert.equal(row.seen_since, "2026-10-14T18:00:00.000Z");
  w.setNow(utc("18:01:05")); assert.equal(w.ho.flush(), 0, "nothing pending ⇒ no write");
  /* فجوة أكتر من ٢.٥ دقيقة ⇒ فتحة جديدة */
  w.setNow(utc("18:04:00")); w.signal("poll"); await settle();
  assert.equal([...w.db.presence.values()][0].seen_since, "2026-10-14T18:04:00.000Z");
  assert.equal(w.ho.touch({ id: "k1", role: "kitchen" }, TABLET, "api"), false, "kitchen ignored");
  assert.equal(w.ho.touch({ id: "admin", role: "manager", admin: true }, TABLET, "api"), false, "the owner's dashboard key is not a portal");
  assert.equal(w.ho.seen(CASHIER, { method: "POST", path: "/api/portal/logout", ua: TABLET }), false);
  const list = await w.ho.presence();
  assert.deepEqual(Object.keys(list[0]).sort(), ["device", "lastSeen", "lastVisible", "name", "role", "seenSince", "staffId", "via", "visibleSince"]);
});

test("portal.js: every authenticated portal request and the SSE stream (connect + every heartbeat) call onSeen; a rejected request does not", async () => {
  const seen = [];
  const app = new Hono();
  const settings = { portal: { staff: [{ id: "st_c", name: "علي", role: "cashier", pinHash: hashPin("2468") }] }, webPushKeys: { publicKey: "PUB", privateKey: "PRIV" } };
  const api = registerPortal(app, { pool: { async query() { return { rows: [], rowCount: 0 }; } }, getSettingsData: async () => settings, requireAdmin: async (c) => c.json({ error: "Unauthorized" }, 401), log: { error() {} } },
    { timers: false, eventStore: false, heartbeatMs: 25, env: { ADMIN_TOKEN: "admin-token-xyz-123" }, subscribe: () => () => {}, emitOrder: () => {}, webpush: { sendNotification: async () => {} },
      onSeen: (u, x) => seen.push({ id: u.id, role: u.role, ...x }) });
  const lr = await app.request("/api/portal/login", { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "10.0.0.9" }, body: JSON.stringify({ pin: "2468" }) });
  const { token } = await lr.json();
  const H = { Authorization: `Bearer portal:${token}`, "User-Agent": TABLET };
  assert.equal((await app.request("/api/portal/me", { headers: H })).status, 200);
  assert.deepEqual(seen.at(-1), { id: "st_c", role: "cashier", ua: TABLET, method: "GET", path: "/api/portal/me", via: null });
  const n = seen.length;
  assert.equal((await app.request("/api/portal/me", { headers: { Authorization: "Bearer portal:nope" } })).status, 401);
  assert.equal(seen.length, n, "unauthenticated ⇒ nothing");
  await app.request("/api/portal/push/subscribe", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}" });
  assert.deepEqual([seen.at(-1).method, seen.at(-1).path], ["POST", "/api/portal/push/subscribe"]);
  const res = await app.request(`/api/portal/stream?token=${encodeURIComponent(token)}`, { headers: { "User-Agent": TABLET } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder(); let buf = "";
  const keep = setTimeout(() => {}, 3000);      // نبضة البث unref ⇒ مؤقّت عادي يخلّي الاختبار صاحي وهو بيقرا
  const end = Date.now() + 1500;
  while (Date.now() < end && (buf.match(/event: ping/g) || []).length < 2) { const r = await reader.read(); if (r.done) break; buf += dec.decode(r.value, { stream: true }); }
  clearTimeout(keep);
  await reader.cancel();
  const sse = seen.filter((x) => x.via === "sse");
  assert.ok(seen.some((x) => x.path === "/api/portal/stream" && x.via === null), "connect = an authenticated request on the stream path");
  assert.ok(sse.length >= 2, `a presence signal per heartbeat (${sse.length})`);
  assert.ok(sse.every((x) => x.ua === TABLET && x.id === "st_c"), "same staff + device as the stream");
  assert.equal(HO.presenceVia(sse[0].method, "/api/portal/stream"), "sse");
  api.stop();
});

test("POST /api/portal/presence (the visible heartbeat) and the handover list both count as visible", async () => {
  const routes = {}, db = { rows: [] };
  let nowMs = utc("18:00:00");
  const pool = { async query(sql, p = []) { if (/^INSERT INTO portal_presence/.test(String(sql).trim())) db.rows.push(p); return { rows: [] }; } };
  const ho = HO.register({ get: (pt, h) => { routes[`GET ${pt}`] = h; }, post: (pt, h) => { routes[`POST ${pt}`] = h; } }, { pool },
    { requirePortal: async () => ({ user: CASHIER }), now: () => new Date(nowMs), noTimer: true, log: { error() {} } });
  const c = { req: { param: () => null, header: () => TABLET }, json: (body, status = 200) => ({ body, status }) };
  assert.deepEqual(await routes["POST /api/portal/presence"](c), { body: { ok: true }, status: 200 });
  await settle();
  assert.equal(db.rows.length, 1); assert.deepEqual([db.rows[0][5], db.rows[0][6]], ["beat", "2026-10-14T18:00:00.000Z"]);
  nowMs += 61 * SEC; await routes["GET /api/portal/wa-handovers"](c); await settle();
  assert.equal(db.rows.at(-1)[5], "poll"); assert.ok(db.rows.at(-1)[6]);
  assert.equal(typeof ho.stop, "function");
});

/* ═══ ٢) يوم ١٤/١٠ بالظبط ════════════════════════════════════════════════════════════════════════════════
   الحضور اللي اتسجّل فعلاً (تابلت الكاشير، أندرويد ١٠، كروم): البوابة اتفتحت على الشاشة الفترات دي بس (استطلاع التحويلات كل ٢٠ ث):
     14:35:20 بصّة · 14:53:30 بصّة · 15:18:40–15:19:50 · 15:24:10–15:28:30 · 16:03:20–16:06:30 · 16:41:09 بصّة
   + شغل حقيقي (استلم/خلصت) 15:04 و15:19 و15:28. الدورة كل دقيقة على :47 لحد ما الحاوية اتعادت الساعة ١٥:٠٠، وبعدها :58.
   التأكيد إن ده نفس اليوم: قواعد RG1 (٣ / ١٥ / ٢) على الحضور ده بتطلّع ١٦ مرة كاشير + ٥ مدير + ٣ «رجع»، وفي نفس دقايق سجل اللايف. */
const VISIBLE = [["14:35:20", "14:35:40"], ["14:53:30", "14:53:50"], ["15:18:40", "15:19:50"], ["15:24:10", "15:28:30"], ["16:03:20", "16:06:30"], ["16:41:09", "16:41:29"]];
const ACTIONS = ["15:04:00", "15:19:00", "15:28:00"];
const DAY_SIGNALS = [...VISIBLE.flatMap(([a, b]) => polls(a, b)), ...ACTIONS.map((x) => ({ t: utc(x), via: "action" }))].sort((a, b) => a.t - b.t);
const DAY_TICKS = [...everySec(utc("13:20:47"), utc("14:59:47"), 60), ...everySec(utc("15:00:58"), utc("16:46:58"), 60)];
const WIN = [utc("13:16:00"), utc("16:46:00")];
/* سجل اللايف (wa_team_log، topic portal_offline) من ١٤:١٩ لحد آخر تنبيه — كل مرة = الكاشيرين في نفس الدقيقة */
const LIVE = [["14:20:47", "cashier"], ["14:20:48", "manager"], ["14:35:47", "back"], ["14:38:47", "cashier"], ["14:56:47", "cashier"], ["15:11:58", "cashier"], ["15:22:57", "cashier"],
  ["15:31:58", "cashier"], ["15:47:57", "cashier"], ["16:02:58", "cashier"], ["16:02:59", "manager"], ["16:03:57", "back"], ["16:09:58", "cashier"], ["16:24:58", "cashier"],
  ["16:40:58", "cashier"], ["16:40:59", "manager"], ["16:42:05", "back"], ["16:45:05", "cashier"]];
/* قواعد RG1 زي ما كانت شغّالة: كتابة أول استطلاع في كل دقيقة، offMin بالتقريب لتحت، أي كتابة ⇒ الصف يتمسح، التكرار جوّه الحلقة بس */
function rg1Replay(signals, ticks) {
  const writes = [];
  for (const s of signals) if (s.via === "poll" && (!writes.length || s.t - writes.at(-1) >= MIN)) writes.push(s.t);
  let row = null; const out = [];
  for (const t of ticks) {
    const last = writes.filter((x) => x <= t).at(-1);
    if (last != null && Math.floor((t - last) / MIN) < 3) { if (row && row.told) out.push([t, "back"]); row = null; continue; }
    if (row && t - row.last < 15 * MIN) continue;
    row = row ? { ...row, n: row.n + 1, last: t } : { n: 1, last: t, told: false };
    out.push([t, "cashier"]);
    if (row.n > 2) { out.push([t, "manager"]); row.told = true; }
  }
  return out;
}

test("14/10 replay, old rules (RG1: 3 / 15 / 2): the reconstructed presence gives exactly the live counts — 16 cashier rounds, 5 manager, 3 «back» — at the live minutes", () => {
  const out = rg1Replay(DAY_SIGNALS, DAY_TICKS);
  const n = (k) => out.filter((x) => x[1] === k).length;
  assert.deepEqual([n("cashier"), n("manager"), n("back")], [16, 5, 3], "32 cashier messages (2 cashiers), 5 manager, 3 back");
  const live = LIVE.map(([x, k]) => [utc(x), k]);
  for (const [t, k] of out.filter((x) => x[0] >= utc("14:19:00"))) {
    const m = live.find(([lt, lk]) => lk === k && Math.abs(lt - t) <= 61 * SEC);
    assert.ok(m, `${hms(t)} ${k} matches the live log (±1 min tick jitter)`);
  }
  assert.equal(out.filter((x) => x[0] >= utc("14:19:00")).length, LIVE.length, "nothing extra, nothing missing after 14:19");
});

test("14/10 replay, new rules (10 / 45 / 3, stable 2 min, cap 6): ≤ 3 messages per cashier in the 3.5 h (was 16 each), the manager twice, no phone twice within 45 min", async () => {
  const w = world();
  await play(w, { from: utc("13:19:00"), to: utc("16:46:58"), signals: DAY_SIGNALS, ticks: DAY_TICKS });
  const inWin = w.offLog().filter((l) => l.at >= WIN[0] && l.at <= WIN[1]);
  const per = (ph) => inWin.filter((l) => l.to === ph);
  assert.ok(per(CASH1).length <= 3 && per(CASH2).length <= 3, `cashier messages ${per(CASH1).length} + ${per(CASH2).length}`);
  assert.deepEqual(per(CASH1).map((l) => hms(l.at)), ["13:20:47", "14:05:47", "14:50:47"], "every 45 min while really closed; then the manager's turn");
  assert.deepEqual(per(CASH2).map((l) => hms(l.at)), ["13:20:47", "14:05:47", "14:50:47"]);
  assert.deepEqual(per(MGR).map((l) => [hms(l.at), l.kind]), [["15:38:58", "manager"], ["16:23:58", "manager"]],
    "15:38:58 = closed 10 min after the real work at 15:28 and the cashiers already had 3 · 16:23:58 = closed again after a 3-minute opening, 45 min after his last message");
  assert.equal(per(OWN).length, 0);
  for (const ph of [CASH1, CASH2, MGR]) {
    const ts = w.offLog().filter((l) => l.to === ph).map((l) => l.at);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 44.5 * MIN, `${ph.slice(-4)}: ${hms(ts[i - 1])} → ${hms(ts[i])}`);
  }
  assert.equal(inWin.length, 8, "8 WhatsApp messages instead of 40");
  assert.match(w.sent.find((x) => x.to === MGR).text, /^⚠️ بورتال الكاشير مقفول من 10 دقايق — الكاشير اتبعتله 3 تنبيهات في آخر 4 ساعات ولسه ماتفتحش/);
});

test("deploy over a live log: the per-phone claims start from the last message in wa_team_log (no message right after the restart), and 14/10 itself is already over every cap", async () => {
  const row = (t, to, kind) => ({ at: utc(t), to, role: kind === "cashier" ? "cashier" : "manager", topic: "portal_offline", kind, via: "wa_free", ok: true });
  const w = world({ start: "2026-10-14T17:05:00Z", preLog: [row("17:00:00", CASH1, "cashier"), row("17:00:00", CASH2, "cashier")] });
  await w.team.ready;
  assert.equal(w.db.to.get(CASH1).last_at, "2026-10-14T17:00:00.000Z", "seeded from the log");
  await play(w, { from: utc("17:05:00"), to: utc("17:46:30"), signals: [], ticks: everySec(utc("17:05:30"), utc("17:46:30"), 60) });
  assert.deepEqual(w.offLog().filter((l) => l.to === CASH1).map((l) => hms(l.at)), ["17:00:00", "17:44:30"], "the old 17:00 message still counts: next one 45 min after it, not at the restart");
  /* اليوم نفسه: ١٦ مرة × كاشيرين + ٥ مدير + ٣ «رجع» قبل الـdeploy ⇒ كله فوق السقف (٦) ⇒ ولا رسالة لآخر اليوم التشغيلي */
  const pre = rg1Replay(DAY_SIGNALS, DAY_TICKS).flatMap(([t, k]) => (k === "cashier" ? [CASH1, CASH2].map((to) => ({ ...row("00:00:00", to, k), at: t })) : [{ ...row("00:00:00", MGR, k), at: t }]));
  const d = world({ start: "2026-10-14T17:20:00Z", preLog: pre });
  await play(d, { from: utc("17:20:00"), to: utc("23:59:30"), signals: [], ticks: everySec(utc("17:20:30"), utc("23:59:30"), 60) });
  assert.equal(d.offLog().length, pre.length, "nothing new for the rest of 14/10");
});

test("a portal genuinely closed for 30 min: the first message comes within afterMin+1 min of the last signal, and only once in the 30 min", async () => {
  const w = world({ start: "2026-10-14T17:00:00Z" });
  const signals = everySec(utc("17:00:00"), utc("17:30:00"), 20).map((t) => ({ t, via: "poll" }));
  const out = await play(w, { from: utc("17:00:00"), to: utc("18:00:30"), signals, ticks: everySec(utc("17:00:30"), utc("18:00:30"), 60) });
  const first = w.offLog().filter((l) => l.kind === "cashier");
  assert.equal(first.length, 2, "one per cashier");
  const lag = first[0].at - utc("17:30:00");
  assert.ok(lag >= 10 * MIN && lag <= 11 * MIN, `alert ${(lag / MIN).toFixed(2)} min after the last signal`);
  assert.equal(w.offLog().filter((l) => l.at <= utc("18:00:00")).length, 2, "nothing more inside the 30 minutes (repeat 45)");
  assert.ok(out.filter((x) => x.t < utc("17:30:00")).every((x) => x.portal.offline === false), "open while it polls");
  assert.match(w.sent[0].text, /^⚠️ البورتال مقفول من 10 دقايق/);
});

/* ═══ ٣) القواعد واحدة واحدة ═════════════════════════════════════════════════════════════════════════════ */
test("flapping: a glance (one or two requests) after the alert neither ends the episode nor sends «back», and the next cashier message still waits 45 min", async () => {
  const w = world({ start: "2026-10-14T17:00:00Z" });
  const signals = [{ t: utc("17:00:00"), via: "poll" }, ...[12, 24, 36].flatMap((m) => [{ t: utc("17:00:00") + m * MIN, via: "poll" }, { t: utc("17:00:20") + m * MIN, via: "api" }])];
  const out = await play(w, { from: utc("17:00:00"), to: utc("17:59:30"), signals, ticks: everySec(utc("17:00:30"), utc("17:59:30"), 60) });
  const cash = w.offLog().filter((l) => l.to === CASH1);
  assert.deepEqual(cash.map((l) => hms(l.at)), ["17:10:30", "17:55:30"], "glances at 17:12, 17:24, 17:36 change nothing");
  assert.equal(w.offLog().filter((l) => l.kind === "back").length, 0);
  assert.ok(out.some((x) => x.portal.waitingStable), "after a glance: still the same episode");
  assert.equal(w.db.portal.alerts, 2, "same episode, second round");
});

test("«back»: only after the portal stays open backStableMin, only if the manager was told in this episode, deferred to 45 min after his last message, once — and dropped if it closes again first", async () => {
  /* المدير اتبلّغ: الكاشيرين خلّصوا نصيبهم (٣ في آخر ٤ ساعات) من بدري */
  const seed = (w) => { for (const t of ["13:00:00", "13:45:00", "14:30:00"]) for (const ph of [CASH1, CASH2]) w.db.log.push({ at: utc(t), to: ph, role: "cashier", topic: "portal_offline", kind: "cashier", via: "wa_free", ok: true }); };
  const w = world({ start: "2026-10-14T15:00:00Z" }); seed(w);
  const sig = [{ t: utc("15:00:00"), via: "poll" }, ...everySec(utc("15:30:00"), utc("16:30:00"), 20).map((t) => ({ t, via: "poll" }))];
  await play(w, { from: utc("15:00:00"), to: utc("16:30:00"), signals: sig, ticks: everySec(utc("15:00:30"), utc("16:30:30"), 60) });
  const m = w.offLog().filter((l) => l.to === MGR);
  /* المدير: ميعاد التنبيه الرابع للكاشير (١٤:٣٠ + ٤٥ د، بالسماح ٣٠ ث للدورة) ⇒ 15:14:30 · مفتوح من 15:30 ⇒ «رجع» بعد ٤٥ د من رسالته = 15:59:30 */
  assert.deepEqual(m.map((l) => [hms(l.at), l.kind]), [["15:14:30", "manager"], ["15:59:30", "back"]], "told, open steadily from 15:30, «back» 45 min after his message");
  assert.match(w.sent.find((x) => x.to === MGR && /✅/.test(x.text)).text, /^✅ تمام، بورتال الكاشير مفتوح تاني من 18:30 \(كان مقفول 30 دقيقة\)\.$/);
  assert.equal(w.db.portal, null, "episode closed after «back»");
  assert.equal(w.offLog().filter((l) => l.to === CASH1 && l.at >= utc("15:00:00")).length, 0, "the cashiers were already at their share");
  /* نفس الكلام بس البورتال قفل تاني قبل الـ٤٥ ⇒ مفيش «رجع» */
  const w2 = world({ start: "2026-10-14T15:00:00Z" }); seed(w2);
  const sig2 = [{ t: utc("15:00:00"), via: "poll" }, ...everySec(utc("15:30:00"), utc("15:40:00"), 20).map((t) => ({ t, via: "poll" }))];
  await play(w2, { from: utc("15:00:00"), to: utc("16:10:00"), signals: sig2, ticks: everySec(utc("15:00:30"), utc("16:10:30"), 60) });
  assert.deepEqual(w2.offLog().filter((l) => l.to === MGR).map((l) => [hms(l.at), l.kind]), [["15:14:30", "manager"], ["15:59:30", "manager"]],
    "closed again at 15:50 ⇒ no «back»; a new episode tells him again 45 min after the first");
  /* المدير ماتبلّغش ⇒ «رجع» ماتتبعتش خالص */
  const w3 = world({ start: "2026-10-14T15:00:00Z" });
  await play(w3, { from: utc("15:00:00"), to: utc("15:40:00"), signals: [{ t: utc("15:00:00"), via: "poll" }, ...everySec(utc("15:20:00"), utc("15:40:00"), 20).map((t) => ({ t, via: "poll" }))], ticks: everySec(utc("15:00:30"), utc("15:40:30"), 60) });
  assert.deepEqual(w3.offLog().map((l) => l.kind), ["cashier", "cashier"]); assert.equal(w3.db.portal, null, "stable ⇒ episode ended silently");
});

test("daily cap: at most dailyCap portal_offline messages per phone per business day (no manager in the team ⇒ no ladder, only repeat + cap); a new business day starts again", async () => {
  const w = world({ start: "2026-10-14T09:00:00Z", members: MEMBERS.filter((m) => m.role !== "manager"), waTeam: { portalOffline: { repeatMin: 30 } } });
  await play(w, { from: utc("09:00:00"), to: utc("23:59:00"), signals: [], ticks: everySec(utc("09:00:30"), utc("23:59:30"), 60) });
  const c1 = w.offLog().filter((l) => l.to === CASH1);
  assert.equal(c1.length, 6); assert.deepEqual([hms(c1[0].at), hms(c1[5].at)], ["09:00:30", "11:30:30"]);
  /* اليوم التشغيلي الجديد بيبدأ ٠٤:٠٠ الرياض = ٠١:٠٠ UTC، والشغل من ١١:٠٠ الرياض = ٠٨:٠٠ UTC */
  await play(w, { from: utc("08:00:00", "2026-10-15"), to: utc("08:30:00", "2026-10-15"), signals: [], ticks: everySec(utc("08:00:30", "2026-10-15"), utc("08:30:30", "2026-10-15"), 60) });
  assert.equal(w.offLog().filter((l) => l.to === CASH1 && l.at >= utc("08:00:00", "2026-10-15")).length, 1, "new business day ⇒ the cap resets");
});

test("repeat jitter: a tick that runs a little early still sends at the 45th minute (30 s slack) — and never at 44", async () => {
  const w = world({ start: "2026-10-14T17:00:00Z", members: MEMBERS.filter((m) => m.role !== "manager") });
  await play(w, { from: utc("17:00:00"), to: utc("17:00:30"), signals: [], ticks: [utc("17:00:30")] });
  assert.equal(w.offLog().length, 2);
  await play(w, { from: utc("17:44:30"), to: utc("17:44:30"), signals: [], ticks: [utc("17:44:30")] });
  assert.equal(w.offLog().length, 2, "44 min: no");
  await play(w, { from: utc("17:45:29.6"), to: utc("17:45:29.6"), signals: [], ticks: [utc("17:45:29.6")] });
  assert.equal(w.offLog().length, 4, "44:59.6 counts as 45");
});

test("countBackground: a hidden tab that is still connected (SSE heartbeats, background reads) counts as open by default; with the switch off only visible signals count", async () => {
  const sig = [...everySec(utc("17:00:00"), utc("17:01:00"), 20).map((t) => ({ t, via: "poll" })), ...everySec(utc("17:01:20"), utc("17:40:00"), 20).map((t) => ({ t, via: "sse" }))];
  const ticks = everySec(utc("17:00:30"), utc("17:40:30"), 60);
  const on = world({ start: "2026-10-14T17:00:00Z" });
  await play(on, { from: utc("17:00:00"), to: utc("17:40:30"), signals: sig, ticks });
  assert.equal(on.offLog().length, 0, "connected in the background ⇒ not «closed»");
  const off = world({ start: "2026-10-14T17:00:00Z", waTeam: { portalOffline: { countBackground: false } } });
  await play(off, { from: utc("17:00:00"), to: utc("17:40:30"), signals: sig, ticks });
  assert.deepEqual(off.offLog().filter((l) => l.to === CASH1).map((l) => hms(l.at)), ["17:11:30"], "not on screen for 10 min ⇒ closed");
  const st = await off.team.portalStatus(T.teamConfig(off.db.settings), off.now());
  assert.deepEqual([st.devices[0].visible, st.devices[0].background, st.devices[0].open], [false, true, false]);
});

test("portal watch: never outside working hours (an open episode ends silently), a manager-only portal does not count, and the switch turns it off", async () => {
  const night = world({ start: "2026-10-14T03:00:00Z" });      // ٠٦:٠٠ الرياض
  assert.equal((await night.team.tick()).portal.work, false); assert.equal(night.sent.length, 0);
  const late = world({ start: "2026-10-14T23:50:00Z" });      // ٠٢:٥٠ الرياض ⇒ تنبيه، وبعد ٠٣:٠٠ الحلقة تتمسح في صمت
  await late.team.tick(); assert.equal(late.offLog().length, 2); assert.ok(late.db.portal);
  late.setNow(utc("00:01:00", "2026-10-15")); const r = (await late.team.tick()).portal;
  assert.deepEqual([r.work, r.cleared], [false, true]); assert.equal(late.db.portal, null); assert.equal(late.offLog().length, 2);
  const mgrOnly = world({ start: "2026-10-14T15:00:00Z" });
  mgrOnly.signal("poll", { id: "m1", name: "خالد", role: "manager" }, "PC"); await settle();
  assert.equal((await mgrOnly.team.tick()).portal.round, 1, "the manager's PC is not a cashier portal");
  const off = world({ waTeam: { portalOffline: { enabled: false } } });
  assert.deepEqual((await off.team.tick()).portal, { skipped: "off" });
  const noCash = world({ members: MEMBERS.slice(2) });
  assert.deepEqual((await noCash.team.tick()).portal, { skipped: "no_cashier" });
  assert.equal(T.workingNow({}, "2026-10-14T08:05:00Z", 10), false, "11:05 Riyadh: open less than afterMin (10)");
  assert.equal(T.workingNow({}, "2026-10-14T08:10:00Z", 10), true);
});

test("portalSignal: closed by the newest signal of any cashier device (exact ms, no rounding); stable = one device open backStableMin in a row", () => {
  const now = "2026-10-14T15:00:00Z";
  const d = (o) => ({ role: "cashier", ...o });
  const a = T.portalSignal([d({ lastSeen: "2026-10-14T14:50:00.500Z", seenSince: "2026-10-14T14:40:00Z" })], now, { afterMin: 10, backStableMin: 2 });
  assert.deepEqual([a.closed, a.offMin, a.stable], [false, 9, false], "9 min 59.5 s: not yet, and not fresh enough to be stable");
  const b = T.portalSignal([d({ lastSeen: "2026-10-14T14:59:30Z", seenSince: "2026-10-14T14:58:00Z" }), d({ lastSeen: "2026-10-14T14:20:00Z" })], now, { afterMin: 10, backStableMin: 2 });
  assert.deepEqual([b.closed, b.stable, b.lastSeen], [false, false, "2026-10-14T14:59:30.000Z"], "1.5 min streak < 2");
  const c = T.portalSignal([d({ lastSeen: "2026-10-14T14:59:30Z", seenSince: "2026-10-14T14:57:00Z" })], now, { afterMin: 10, backStableMin: 2 });
  assert.deepEqual([c.stable, c.streakStart], [true, "2026-10-14T14:57:00.000Z"]);
  assert.equal(T.portalSignal([d({ lastSeen: "2026-10-14T14:59:30Z" })], now, { afterMin: 10 }).stable, false, "old row without a streak start = one signal");
  assert.deepEqual(T.portalSignal([{ role: "manager", lastSeen: "2026-10-14T14:59:59Z" }], now, { afterMin: 10 }), { lastSeen: null, offMin: null, closed: true, stable: false, streakStart: null });
  assert.equal(T.portalSignal([d({ lastSeen: "2026-10-14T14:59:00Z", lastVisible: "2026-10-14T14:40:00Z" })], now, { afterMin: 10, countBackground: false }).closed, true);
});

test("portal status for the dashboard: each device open (on screen / in the background) or closed since N minutes, the cashier summary, the episode and today's count", async () => {
  const w = world({ start: "2026-10-14T15:00:00Z" });
  w.db.presence.set("s1|tab", { staff_id: "s1", staff_name: "منى", role: "cashier", device: "tab", last_seen: "2026-10-14T14:59:00Z", seen_since: "2026-10-14T14:30:00Z", via: "sse", last_visible: "2026-10-14T14:45:00Z", visible_since: "2026-10-14T14:30:00Z" });
  w.db.presence.set("m1|pc", { staff_id: "m1", staff_name: "خالد", role: "manager", device: "pc", last_seen: "2026-10-14T14:40:00Z", seen_since: null, via: "poll", last_visible: "2026-10-14T14:40:00Z", visible_since: null });
  const st = await w.team.portalStatus(T.teamConfig(w.db.settings), w.now());
  assert.deepEqual(st.cashier, { open: true, stable: true, lastSeen: "2026-10-14T14:59:00.000Z", offMin: 1 });
  assert.deepEqual(st.devices.map((d) => [d.name, d.open, d.visible, d.background, d.offMin, d.via]), [["منى", true, false, true, 0, "sse"], ["خالد", false, false, false, 20, "poll"]]);
  assert.deepEqual([st.working, st.alerts, st.sentToday, st.countBackground, st.afterMin], [true, null, 0, true, 10]);
});

test("settings: the new knobs have defaults (the live 10 / 45 / 3), limits, Arabic labels in the schema order the dashboard draws, and the window must hold managerAfter × repeatMin", () => {
  const c = T.teamConfig({ waTeam: { members: [] } });
  assert.deepEqual(c.portalOffline, { enabled: true, afterMin: 10, repeatMin: 45, managerAfter: 3, managerWindowMin: 240, backStableMin: 2, dailyCap: 6, countBackground: true, backNotice: true });
  const keys = T.KNOBS.filter((k) => k.key.startsWith("portalOffline.")).map((k) => k.key.split(".")[1]);
  assert.deepEqual(keys, ["enabled", "countBackground", "afterMin", "backStableMin", "repeatMin", "dailyCap", "managerAfter", "managerWindowMin", "backNotice"]);
  for (const k of T.KNOBS.filter((x) => x.key.startsWith("portalOffline."))) {
    assert.match(k.label, /[؀-ۿ]/, k.key);
    if (k.type === "num") { assert.ok(Array.isArray(T.LIMITS[k.key]), k.key); assert.match(k.unit, /[؀-ۿ]/, k.key); }
  }
  assert.equal(T.configFromBody({ portalOffline: { dailyCap: 0 } }, {}).ok, false);
  assert.equal(T.configFromBody({ portalOffline: { countBackground: "yes" } }, {}).ok, false);
  const bad = T.configFromBody({ portalOffline: { repeatMin: 120 } }, {});
  assert.equal(bad.ok, false); assert.match(bad.errors[0], /لازم تبقى 360 دقيقة على الأقل/);
  const ok = T.configFromBody({ portalOffline: { repeatMin: 120, managerWindowMin: 360, backStableMin: 5, countBackground: false, dailyCap: 4 } }, {});
  assert.equal(ok.ok, true);
  assert.deepEqual(T.teamConfig({ waTeam: ok.value }).portalOffline, { enabled: true, afterMin: 10, repeatMin: 120, managerAfter: 3, managerWindowMin: 360, backStableMin: 5, dailyCap: 4, countBackground: false, backNotice: true });
  assert.equal(T.teamConfig({ waTeam: { portalOffline: { dailyCap: 99 } } }).portalOffline.dailyCap, 6, "out of range ⇒ default");
});

test("texts: cashier, manager (the real count, not n-1), «back» with the time it came back", () => {
  assert.equal(T.portalOfflineText({ offMin: 10 }), "⚠️ البورتال مقفول من 10 دقايق — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.\nافتح البورتال ↗ https://freshcuts-invite.o2m8.me/portal/");
  assert.equal(T.portalOfflineManagerText({ offMin: 25, alerts: 3, windowMin: 240 }).split("\n")[0], "⚠️ بورتال الكاشير مقفول من 25 دقيقة — الكاشير اتبعتله 3 تنبيهات في آخر 4 ساعات ولسه ماتفتحش. الطلبات ومحادثات واتساب مش بترن في المطعم.");
  assert.match(T.portalOfflineManagerText({ offMin: 25, alerts: 6, windowMin: null }), /اتبعتله 6 تنبيهات النهارده/);
  assert.match(T.portalOfflineManagerText({ offMin: 5, alerts: 1, windowMin: 90 }), /تنبيه واحد في آخر 90 دقيقة/);
  assert.equal(T.portalBackText({ offMin: 37, at: "2026-10-14T13:05:00Z" }), "✅ تمام، بورتال الكاشير مفتوح تاني من 16:05 (كان مقفول 37 دقيقة).");
});
