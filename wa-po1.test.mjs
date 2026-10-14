/* PO1 — حضور البوابة و«البورتال مقفول» من غير زنّ (١٤/١٠ مساءً)، بعد المراجعة.
   يوم ١٤/١٠ بالظبط: ٣٢ رسالة كاشير (١٦ مرة × كاشيرين) + ٥ مدير + ٣ «رجع» في ٣.٥ ساعة ⇒ القواعد الجديدة على نفس الحضور.
   القواعد: الحضور من طلبات الجهاز بس (نبضة البث بتاعة السيرفر مابتتحسبش)، الافتراضي «ظاهر على الشاشة» بس (زي RG1)، السلّم جوّه المرة
   (الكاشير ← المدير بتذكير ← الكاشير لو المدير خلّص رصيده)، التكرار والسقف لكل رقم، و«رجع» على طول ومابتاخدش من التكرار ولا السقف.
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
const isoMs = (v) => (v == null ? NaN : Date.parse(v instanceof Date ? v.toISOString() : v));
const later = (a, b) => (!a ? b : !b ? a : isoMs(a) >= isoMs(b) ? a : b);      // GREATEST في Postgres (بيتجاهل NULL)

/* ── عالم واحد: wahandover (الحضور) + wateam (التنبيهات) فوق نفس القاعدة الوهمية ────────────────────────── */
function world({ start = "2026-10-14T13:00:00Z", waTeam = {}, members = MEMBERS, settings = {}, preLog = [], preTo = [], prePresence = [], app = null, owner = true, fail = () => false, failSql = null } = {}) {
  let nowMs = Date.parse(start);
  const ms = isoMs;
  const db = { presence: new Map(prePresence.map((r) => [`${r.staff_id}|${r.device}`, { ...r }])), writes: [], portal: null, to: new Map(preTo.map((r) => [r.phone_norm, { ...r }])), log: [...preLog],
    settings: { waTeam: { members, keeper: { enabled: false }, odd: { enabled: false }, daily: { enabled: false }, ...waTeam }, ...settings } };
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (failSql && failSql.test(s)) throw new Error(`emulated failure: ${s.slice(0, 40)}`);
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    /* صفوف RG1 القديمة (via NULL ومن غير last_visible) ⇒ last_visible = last_seen، مرة واحدة */
    if (/^UPDATE portal_presence SET last_visible = last_seen, visible_since = COALESCE\(visible_since, seen_since, last_seen\) WHERE via IS NULL AND last_visible IS NULL/i.test(s)) {
      for (const x of db.presence.values()) if (x.via == null && !x.last_visible) { x.last_visible = x.last_seen; x.visible_since = x.visible_since || x.seen_since || x.last_seen; }
      return { rows: [] };
    }
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
    if (/^SELECT since, alerts, last_alert_at, manager_told, opened_at, reopened_at FROM wa_team_portal/i.test(s)) return { rows: db.portal ? [{ ...db.portal }] : [] };
    if (/^UPDATE wa_team_portal SET reopened_at=\$1 WHERE id='cashier' AND reopened_at IS NULL/i.test(s)) { if (db.portal && !db.portal.reopened_at) db.portal.reopened_at = p[0]; return { rows: [] }; }
    if (/^UPDATE wa_team_portal SET reopened_at=NULL WHERE id='cashier'/i.test(s)) { if (db.portal) db.portal.reopened_at = null; return { rows: [] }; }
    if (/^DELETE FROM wa_team_portal WHERE id='cashier'/i.test(s)) { const r = db.portal; db.portal = null; return { rows: r ? [{ since: r.since }] : [] }; }
    if (/^INSERT INTO wa_team_portal\(id, since, alerts, manager_told, opened_at\)/i.test(s)) { if (!db.portal) db.portal = { since: p[0], alerts: 0, last_alert_at: null, manager_told: false, opened_at: p[1], reopened_at: null }; return { rows: [] }; }
    if (/^UPDATE wa_team_portal SET alerts=alerts\+1, last_alert_at=\$1/i.test(s)) { if (db.portal) { db.portal.alerts++; db.portal.last_alert_at = p[0]; } return { rows: [] }; }
    if (/^UPDATE wa_team_portal SET manager_told=TRUE/i.test(s)) { if (db.portal) db.portal.manager_told = true; return { rows: [] }; }
    if (/^INSERT INTO wa_team_portal_to\(phone_norm, last_at, last_mgr_at\) VALUES/i.test(s)) {      // الحجز
      const [ph, at, cut, mgr] = p, r = db.to.get(ph);
      if (r && r.last_at && ms(r.last_at) > ms(cut)) return { rows: [] };
      db.to.set(ph, { phone_norm: ph, last_at: at, last_mgr_at: mgr || (r && r.last_mgr_at) || null, last_back_at: (r && r.last_back_at) || null });
      return { rows: [{ phone_norm: ph }] };
    }
    if (/^UPDATE wa_team_portal_to SET last_back_at=\$2 WHERE phone_norm=\$1/i.test(s)) { const r = db.to.get(p[0]); if (r) r.last_back_at = p[1]; return { rows: [] }; }
    if (/^SELECT last_at FROM wa_team_portal_to WHERE phone_norm=\$1/i.test(s)) { const r = db.to.get(p[0]); return { rows: r ? [{ last_at: r.last_at }] : [] }; }
    if (/^SELECT phone_norm, last_at FROM wa_team_portal_to WHERE phone_norm = ANY\(\$1::text\[\]\)/i.test(s)) return { rows: p[0].filter((ph) => db.to.has(ph)).map((ph) => ({ phone_norm: ph, last_at: db.to.get(ph).last_at })) };
    if (/^INSERT INTO wa_team_portal_to\(phone_norm, last_at, last_mgr_at, last_back_at\) SELECT/i.test(s)) {      // البذرة من السجل (آخر يوم) + GREATEST
      const by = new Map();
      for (const l of db.log) {
        if (l.topic !== "portal_offline" || l.at <= nowMs - 24 * 60 * MIN) continue;
        const r = by.get(l.to) || { last_at: null, last_mgr_at: null, last_back_at: null }, iso = new Date(l.at).toISOString();
        if (l.kind === "cashier" || l.kind === "manager") r.last_at = later(r.last_at, iso);
        if (l.kind === "manager") r.last_mgr_at = later(r.last_mgr_at, iso);
        if (l.kind === "back") r.last_back_at = later(r.last_back_at, iso);
        by.set(l.to, r);
      }
      for (const [ph, r] of by) { const o = db.to.get(ph); db.to.set(ph, o ? { phone_norm: ph, last_at: later(o.last_at, r.last_at), last_mgr_at: later(o.last_mgr_at, r.last_mgr_at), last_back_at: later(o.last_back_at, r.last_back_at) } : { phone_norm: ph, ...r }); }
      return { rows: [] };
    }
    if (/^SELECT phone_norm, count\(\*\) FILTER \(WHERE kind IN \('cashier','manager'\) AND ok AND at >= \$1::timestamptz\)::int AS day, max\(at\) FILTER \(WHERE kind='manager' AND ok AND at >= \$2::timestamptz\) AS last_mgr, count\(\*\) FILTER \(WHERE kind='cashier' AND ok AND at >= \$2::timestamptz\)::int AS cash_ok/i.test(s)) {
      const day = ms(p[0]), from = ms(p[1]), lo = Math.min(day, from), by = new Map();
      for (const l of db.log) {
        if (l.topic !== "portal_offline" || l.at < lo) continue;
        const r = by.get(l.to) || { phone_norm: l.to, day: 0, last_mgr: null, cash_ok: 0 };
        if ((l.kind === "cashier" || l.kind === "manager") && l.ok && l.at >= day) r.day++;
        if (l.kind === "cashier" && l.ok && l.at >= from) r.cash_ok++;
        if (l.kind === "manager" && l.ok && l.at >= from && (!r.last_mgr || l.at > ms(r.last_mgr))) r.last_mgr = new Date(l.at).toISOString();
        by.set(l.to, r);
      }
      return { rows: [...by.values()] };
    }
    if (/^SELECT count\(\*\) FILTER \(WHERE ok\)::int AS n, count\(\*\) FILTER \(WHERE NOT ok\)::int AS failed FROM wa_team_log WHERE topic='portal_offline' AND kind IN \('cashier','manager'\) AND at >= \$1/i.test(s)) {
      const ls = db.log.filter((l) => l.topic === "portal_offline" && (l.kind === "cashier" || l.kind === "manager") && l.at >= ms(p[0]));
      return { rows: [{ n: ls.filter((l) => l.ok).length, failed: ls.filter((l) => !l.ok).length }] };
    }
    if (/^UPDATE settings SET data = jsonb_set\(COALESCE\(data,'\{\}'::jsonb\), '\{waTeam\}'/i.test(s)) { db.settings.waTeam = JSON.parse(p[0]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const sent = [], failed = [];
  const wa = { sendFreeform: async ({ phoneNorm, payload }) => {
    const text = payload.interactive ? payload.interactive.body.text : payload.text.body;
    if (fail(phoneNorm, nowMs)) { failed.push({ at: nowMs, to: phoneNorm, text }); return { ok: false, error: "send_failed" }; }
    sent.push({ at: nowMs, to: phoneNorm, text }); return { ok: true };
  } };
  let ho = null, team = null;
  /* تشغيل جديد (deploy / وقوع): الذاكرة بتضيع (حدّ الكتابة، وقت الشغل اللي الدورة شافته)، والقاعدة زي ما هي */
  const errors = [];
  const logger = { error: (...a) => errors.push(a.join(" ")) };
  const boot = () => {
    ho = HO.register({ get() {}, post() {} }, { pool }, { requirePortal: async () => ({ res: "no" }), now: () => new Date(nowMs), noTimer: true, log: logger });
    team = T.register(app, { pool, requireAdmin: async () => null, isOwner: async () => owner, getSettingsData: async () => JSON.parse(JSON.stringify(db.settings)) },
      { wa, now: () => new Date(nowMs), noTimer: true, log: logger, presence: () => ho });
    return Promise.all([team.ready, ho.ready]);
  };
  boot();
  const offLog = () => db.log.filter((l) => l.topic === "portal_offline");
  return { db, get ho() { return ho; }, get team() { return team; }, restart: boot, sent, failed, errors, offLog, setNow: (t) => { nowMs = t; }, now: () => new Date(nowMs), nowMs: () => nowMs,
    signal: (via = "poll", user = CASHIER, ua = TABLET) => ho.seen(user, { ua, via }) };
}
/* سيناريو بالثواني: إشارات + flush كل ١٥ ث (زي السيرفر) + دورات wateam + أحداث (تغيير إعدادات) ⇒ نتايج الدورات */
async function play(w, { from, to, signals = [], ticks, events = [] }) {
  const ev = [];
  for (const s of signals) if (s.t >= from && s.t <= to) ev.push({ t: s.t, k: 0, s });
  for (const e of events) if (e.t >= from && e.t <= to) ev.push({ t: e.t, k: 0, fn: e.fn });
  for (let t = from; t <= to; t += HO.PRESENCE_FLUSH_MS) ev.push({ t, k: 1 });
  for (const t of ticks) if (t >= from && t <= to) ev.push({ t, k: 2 });
  ev.sort((a, b) => a.t - b.t || a.k - b.k);
  const out = [];
  for (const e of ev) {
    w.setNow(e.t);
    if (e.k === 0) { if (e.fn) await e.fn(w); else w.signal(e.s.via, e.s.user, e.s.ua); }
    else if (e.k === 1) w.ho.flush();
    else { const r = await w.team.tick(); out.push({ t: e.t, portal: r.portal }); }
    await settle();
  }
  return out;
}
const everySec = (a, b, step) => { const o = []; for (let t = a; t <= b; t += step * SEC) o.push(t); return o; };
const polls = (a, b, via = "poll") => everySec(utc(a), utc(b), 20).map((t) => ({ t, via }));
const ticks47 = (a, b, day) => everySec(utc(a, day), utc(b, day), 60);
const closedKinds = (l) => l.kind === "cashier" || l.kind === "manager";
/* قواعد ثابتة لكل رقم: مفيش رسالتين «مقفول» قبل repeatMin (بسماح ٣٠ ث)، ولا أكتر من السقف في اليوم التشغيلي (٠٤:٠٠ الرياض = ٠١:٠٠ UTC) */
function assertLimits(w, { repeatMin = 45, cap = 6 } = {}) {
  for (const ph of [CASH1, CASH2, MGR, OWN]) {
    const ts = w.offLog().filter((l) => l.to === ph && closedKinds(l)).map((l) => l.at).sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= repeatMin * MIN - 30 * SEC, `${ph.slice(-4)}: ${hms(ts[i - 1])} → ${hms(ts[i])} < ${repeatMin} min`);
    const per = new Map();
    for (const t of ts) { const d = new Date(t - 60 * MIN).toISOString().slice(0, 10); per.set(d, (per.get(d) || 0) + 1); }
    for (const [d, n] of per) assert.ok(n <= cap, `${ph.slice(-4)}: ${n} on ${d} > cap ${cap}`);
  }
}
const at = (w, ph, pred = () => true) => w.offLog().filter((l) => l.to === ph && pred(l)).map((l) => `${hms(l.at)} ${l.kind}`);
const texts = (w, ph) => w.sent.filter((x) => x.to === ph).map((x) => `${hms(x.at)} ${x.text.split("\n")[0]}`);

/* ═══ ١) الحضور: من طلبات الجهاز بس ══════════════════════════════════════════════════════════════════════ */
test("presenceVia: the heartbeat, the handover list, opening the stream, a click and any other read; the automatic push subscription is a plain read; logout does not count", () => {
  assert.equal(HO.presenceVia("POST", "/api/portal/presence"), "beat");
  assert.equal(HO.presenceVia("GET", "/api/portal/wa-handovers"), "poll");
  assert.equal(HO.presenceVia("GET", "/api/portal/stream"), "sse");
  assert.equal(HO.presenceVia("POST", "/api/portal/orders/W1/ack"), "action");
  assert.equal(HO.presenceVia("POST", "/api/portal/wa/chats/0512/take"), "action");
  assert.equal(HO.presenceVia("POST", "/api/portal/push/subscribe"), "api", "sent by itself when the portal loads, maybe hidden");
  assert.equal(HO.presenceVia("POST", "/api/portal/push/test"), "action", "a button");
  assert.equal(HO.presenceVia("GET", "/api/portal/orders"), "api");
  assert.equal(HO.presenceVia("GET", "/api/tables/live"), "api");
  assert.equal(HO.presenceVia("POST", "/api/portal/logout"), null);
  assert.deepEqual([...HO.VISIBLE_VIA], ["beat", "poll", "action"]);
});

test("touch: one write a minute per staff/device; signals inside the minute are flushed with their real time; the same signal reported twice is one signal (no extra write a minute later)", async () => {
  const w = world({ start: "2026-10-14T18:00:00Z" });
  w.signal("api"); await settle();
  assert.equal(w.db.writes.length, 1);
  for (const s of [10, 20, 30, 40, 50]) { w.setNow(utc("18:00:00") + s * SEC); w.signal(s === 30 ? "poll" : "api"); await settle(); }
  assert.equal(w.db.writes.length, 1, "still one write inside the minute");
  w.setNow(utc("18:00:55")); assert.equal(w.ho.flush(), 0, "the minute is not over yet");
  w.setNow(utc("18:01:00")); assert.equal(w.ho.flush(), 1); await settle();
  const row = [...w.db.presence.values()][0];
  assert.deepEqual([row.last_seen, row.last_visible, row.via], ["2026-10-14T18:00:50.000Z", "2026-10-14T18:00:30.000Z", "api"], "last_seen = the newest signal, last_visible = the newest visible one");
  assert.equal(row.seen_since, "2026-10-14T18:00:00.000Z");
  w.setNow(utc("18:01:05")); assert.equal(w.ho.flush(), 0, "nothing pending ⇒ no write");
  /* فجوة أكتر من ٢.٥ دقيقة ⇒ فتحة جديدة */
  w.setNow(utc("18:04:00")); w.signal("poll"); await settle();
  assert.equal([...w.db.presence.values()][0].seen_since, "2026-10-14T18:04:00.000Z");
  /* نفس الطلب اتبلّغ مرتين (requirePortal + المسار، بفرق مللي ثواني): مفيش إشارة مستنية ⇒ مفيش كتابة تانية بعد دقيقة */
  w.setNow(utc("18:04:00") + 3); w.signal("poll"); await settle();
  w.setNow(utc("18:05:15")); assert.equal(w.ho.flush(), 0, "the duplicate report did not queue a second write");
  /* بس إشارة «ظاهرة» بعد كتابة مش ظاهرة في نفس الثانية فيها معلومة جديدة ⇒ بتتحفظ */
  w.setNow(utc("18:10:00")); w.signal("api"); await settle();
  w.setNow(utc("18:10:00") + 5); w.signal("poll"); await settle();
  w.setNow(utc("18:11:00")); assert.equal(w.ho.flush(), 1); await settle();
  assert.equal([...w.db.presence.values()][0].last_visible, "2026-10-14T18:10:00.005Z");
  assert.equal(w.ho.touch({ id: "k1", role: "kitchen" }, TABLET, "api"), false, "kitchen ignored");
  assert.equal(w.ho.touch({ id: "admin", role: "manager", admin: true }, TABLET, "api"), false, "the owner's dashboard key is not a portal");
  assert.equal(w.ho.seen(CASHIER, { method: "POST", path: "/api/portal/logout", ua: TABLET }), false);
  const list = await w.ho.presence();
  assert.deepEqual(Object.keys(list[0]).sort(), ["device", "lastSeen", "lastVisible", "name", "role", "seenSince", "staffId", "via", "visibleSince"]);
});

test("a presence write that fails is counted and logged (first time, then once per 10 min) instead of vanishing; health() says so", async () => {
  let nowMs = utc("18:00:00"), fail = true;
  const errs = [];
  const pool = { async query(sql) { if (/INSERT INTO portal_presence/.test(String(sql))) { if (fail) throw new Error("column \"via\" does not exist"); } return { rows: [] }; } };
  const ho = HO.register({ get() {}, post() {} }, { pool }, { requirePortal: async () => ({ res: "no" }), now: () => new Date(nowMs), noTimer: true, log: { error: (...a) => errs.push(a.join(" ")) } });
  ho.touch(CASHIER, TABLET, "poll"); await settle(); await settle();
  nowMs += 61 * SEC; ho.touch(CASHIER, TABLET, "poll"); await settle(); await settle();
  let h = ho.health();
  assert.deepEqual([h.writes, h.errors, h.failing], [0, 2, true]); assert.match(h.lastError, /column "via" does not exist/);
  assert.equal(errs.length, 1, "logged once, not on every write"); assert.match(errs[0], /presence write failed/);
  nowMs += 11 * MIN; ho.touch(CASHIER, TABLET, "poll"); await settle(); await settle();
  assert.equal(errs.length, 2, "and again after 10 minutes");
  fail = false; nowMs += 61 * SEC; ho.touch(CASHIER, TABLET, "poll"); await settle(); await settle();
  h = ho.health();
  assert.deepEqual([h.writes, h.errors], [1, 3]); assert.equal(h.lastOkAt, new Date(nowMs).toISOString());
  assert.equal(h.failing, false, "the count stays as history, but a later good write means it is not failing NOW (no permanent red banner)");
});

test("production wiring (portal.js + wahandover on one Hono app): every authenticated request reports once; the handover poll writes once (no duplicate a minute later); opening the SSE stream counts, the server's own heartbeats do not", async () => {
  const seen = [], writes = [];
  let nowMs = Date.now();
  const app = new Hono();
  const settings = { portal: { staff: [{ id: "st_c", name: "علي", role: "cashier", pinHash: hashPin("2468") }] }, webPushKeys: { publicKey: "PUB", privateKey: "PRIV" } };
  let ho = null;
  const api = registerPortal(app, { pool: { async query() { return { rows: [], rowCount: 0 }; } }, getSettingsData: async () => settings, requireAdmin: async (c) => c.json({ error: "Unauthorized" }, 401), log: { error() {} } },
    { timers: false, eventStore: false, heartbeatMs: 25, env: { ADMIN_TOKEN: "admin-token-xyz-123" }, subscribe: () => () => {}, emitOrder: () => {}, webpush: { sendNotification: async () => {} },
      onSeen: (u, x) => { seen.push({ id: u.id, role: u.role, ...x }); return ho && ho.seen(u, x); } });
  const hoPool = { async query(sql, p = []) { if (/^\s*INSERT INTO portal_presence/.test(String(sql))) writes.push({ via: p[5], vis: p[6] }); return { rows: [] }; } };
  ho = HO.register(app, { pool: hoPool }, { requirePortal: api.requirePortal, now: () => new Date(nowMs), noTimer: true, log: { error() {} } });
  const lr = await app.request("/api/portal/login", { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "10.0.0.9" }, body: JSON.stringify({ pin: "2468" }) });
  const { token } = await lr.json();
  const H = { Authorization: `Bearer portal:${token}`, "User-Agent": TABLET };
  assert.equal((await app.request("/api/portal/me", { headers: H })).status, 200);
  assert.deepEqual(seen.at(-1), { id: "st_c", role: "cashier", ua: TABLET, method: "GET", path: "/api/portal/me" });
  const n = seen.length;
  assert.equal((await app.request("/api/portal/me", { headers: { Authorization: "Bearer portal:nope" } })).status, 401);
  assert.equal(seen.length, n, "unauthenticated ⇒ nothing");
  /* استطلاع التحويلات: requirePortal بلّغ (a.seen) ⇒ المسار مابيعدّش تاني ⇒ كتابة واحدة، ومفيش نسخة مستنية تتكتب بعد دقيقة */
  nowMs += 2 * MIN; writes.length = 0;
  assert.equal((await app.request("/api/portal/wa-handovers", { headers: H })).status, 200);
  await settle(); await settle();
  assert.deepEqual(writes.map((x) => x.via), ["poll"]);
  nowMs += 61 * SEC; assert.equal(ho.flush(), 0, "no second copy of the same poll"); await settle();
  assert.equal(writes.length, 1);
  /* البث: الفتح نفسه طلب من الجهاز (sse)، ونبضات السيرفر كل ٢٥ مللي ثانية هنا (٢٠ ث في الإنتاج) مابتبلّغش حاجة */
  const before = seen.length;
  const res = await app.request(`/api/portal/stream?token=${encodeURIComponent(token)}`, { headers: { "User-Agent": TABLET } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  const keep = setTimeout(() => {}, 3000);      // نبضة البث unref ⇒ مؤقّت عادي يخلّي الاختبار صاحي وهو بيقرا
  const end = Date.now() + 1500;
  while (Date.now() < end && (buf.match(/event: ping/g) || []).length < 3) { const r = await reader.read(); if (r.done) break; buf += dec.decode(r.value, { stream: true }); }
  clearTimeout(keep);
  await reader.cancel();
  assert.ok((buf.match(/event: ping/g) || []).length >= 3, "the server sent heartbeats");
  const fromStream = seen.slice(before);
  assert.deepEqual(fromStream.map((x) => x.path), ["/api/portal/stream"], "one report: the device opening the stream; heartbeats report nothing");
  assert.equal(HO.presenceVia(fromStream[0].method, fromStream[0].path), "sse");
  api.stop();
});

test("POST /api/portal/presence (the visible heartbeat) and the handover list count as visible when the auth layer did not report them already", async () => {
  const routes = {}, db = { rows: [] };
  let nowMs = utc("18:00:00"), reported = false;
  const pool = { async query(sql, p = []) { if (/^INSERT INTO portal_presence/.test(String(sql).trim())) db.rows.push(p); return { rows: [] }; } };
  HO.register({ get: (pt, h) => { routes[`GET ${pt}`] = h; }, post: (pt, h) => { routes[`POST ${pt}`] = h; } }, { pool },
    { requirePortal: async () => ({ user: CASHIER, ...(reported ? { seen: true } : {}) }), now: () => new Date(nowMs), noTimer: true, log: { error() {} } });
  const c = { req: { param: () => null, header: () => TABLET }, json: (body, status = 200) => ({ body, status }) };
  assert.deepEqual(await routes["POST /api/portal/presence"](c), { body: { ok: true }, status: 200 });
  await settle();
  assert.equal(db.rows.length, 1); assert.deepEqual([db.rows[0][5], db.rows[0][6]], ["beat", "2026-10-14T18:00:00.000Z"]);
  nowMs += 61 * SEC; await routes["GET /api/portal/wa-handovers"](c); await settle();
  assert.equal(db.rows.at(-1)[5], "poll"); assert.ok(db.rows.at(-1)[6]);
  reported = true; nowMs += 61 * SEC; await routes["GET /api/portal/wa-handovers"](c); await settle();
  assert.equal(db.rows.length, 2, "a.seen ⇒ the route does not count it again");
});

/* ═══ ٢) يوم ١٤/١٠ بالظبط ════════════════════════════════════════════════════════════════════════════════
   الحضور اللي اتسجّل فعلاً (تابلت الكاشير، أندرويد ١٠، كروم): البوابة اتفتحت على الشاشة الفترات دي بس (استطلاع التحويلات كل ٢٠ ث):
     14:35:20 بصّة · 14:53:30 بصّة · 15:18:40–15:19:50 · 15:24:10–15:28:30 · 16:03:20–16:06:30 · 16:41:09 بصّة
   + شغل حقيقي (استلم/خلصت) 15:04 و15:19 و15:28. الدورة كل دقيقة على :47 لحد ما الحاوية اتعادت الساعة ١٥:٠٠، وبعدها :58.
   التأكيد إن ده نفس اليوم: قواعد RG1 (٣ / ١٥ / ٢) على الحضور ده بتطلّع ١٦ مرة كاشير + ٥ مدير + ٣ «رجع»، وفي نفس دقايق سجل اللايف.
   والإشارات كلها «ظاهرة» (استطلاع + شغل) ⇒ ده بالظبط اللي الافتراضي (countBackground مقفول) بيشوفه. */
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

test("14/10 replay, new rules (defaults 10 / 45 / 3, on-screen only, stable 2 min, cap 6): 5 per cashier instead of 16, every one for a real closure; no manager message because the cashier opened it each time; no phone twice within 45 min", async () => {
  const w = world();
  await play(w, { from: utc("13:19:00"), to: utc("16:46:58"), signals: DAY_SIGNALS, ticks: DAY_TICKS });
  const inWin = w.offLog().filter((l) => l.at >= WIN[0] && l.at <= WIN[1]);
  const per = (ph) => inWin.filter((l) => l.to === ph).map((l) => `${hms(l.at)} ${l.kind}`);
  const WANT = ["13:20:47 cashier", "14:05:47 cashier", "14:50:47 cashier", "15:38:58 cashier", "16:23:58 cashier"];
  assert.deepEqual(per(CASH1), WANT, "3 while it stayed closed; then it was really opened (15:24–15:28) — new closure ⇒ the cashier again, 45 min after the last; same at 16:06");
  assert.deepEqual(per(CASH2), WANT);
  assert.deepEqual(per(MGR), [], "the manager is told only after 3 alerts in the SAME closure — the cashier opened it at 15:24 (before the manager's turn at 15:35) and again at 16:03");
  assert.deepEqual([per(OWN).length, inWin.length], [0, 10], "10 WhatsApp messages instead of 40");
  assertLimits(w);
  assert.deepEqual(texts(w, CASH1), ["13:20:47 ⚠️ البورتال مقفول من أول الشغل — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.",
    "14:05:47 ⚠️ البورتال مقفول من أول الشغل — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.",
    "14:50:47 ⚠️ البورتال مقفول من 15 دقيقة — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.",
    "15:38:58 ⚠️ البورتال مقفول من 10 دقايق — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.",
    "16:23:58 ⚠️ البورتال مقفول من 17 دقيقة — افتحه عشان الطلبات ومحادثات العملاء ترن عندك."], "the time since the last signal (the replay has no presence before 14:35 ⇒ «since the shift began»)");
});

test("deploy over a live log: the per-phone claims catch up with the last message in wa_team_log (GREATEST — even over an older claim, e.g. after a rollback), «back» rows do not block; 14/10 itself: one message left for the manager, then muted", async () => {
  const row = (t, to, kind) => ({ at: utc(t), to, role: kind === "cashier" ? "cashier" : "manager", topic: "portal_offline", kind, via: "wa_free", ok: true });
  const w = world({ start: "2026-10-14T17:05:00Z", preLog: [row("16:55:00", CASH1, "cashier"), row("16:55:00", CASH2, "cashier"), row("16:58:00", MGR, "back")],
    preTo: [{ phone_norm: CASH1, last_at: "2026-10-14T10:00:00.000Z", last_mgr_at: null, last_back_at: null }] });
  await w.team.ready;
  assert.equal(w.db.to.get(CASH1).last_at, "2026-10-14T16:55:00.000Z", "an RG1-era message newer than the claim moves the claim forward");
  assert.equal(w.db.to.get(MGR).last_at, null, "«back» does not hold the manager's next message");
  await play(w, { from: utc("17:05:00"), to: utc("17:46:30"), signals: [], ticks: everySec(utc("17:05:30"), utc("17:46:30"), 60) });
  assert.deepEqual(at(w, CASH1), ["16:55:00 cashier", "17:39:30 cashier"], "the 16:55 message still counts: next one 45 min after it (30 s tick slack), not at the restart");
  /* اليوم نفسه: ١٦ مرة × كاشيرين + ٥ مدير + ٣ «رجع» قبل الـdeploy ⇒ الكاشيرين فوق السقف (٦)، والمدير ٥ «مقفول» ⇒ رسالة واحدة ليه ("الكاشير وصل للسقف") وبعدها مفيش */
  const pre = rg1Replay(DAY_SIGNALS, DAY_TICKS).flatMap(([t, k]) => (k === "cashier" ? [CASH1, CASH2].map((to) => ({ ...row("00:00:00", to, k), at: t })) : [{ ...row("00:00:00", MGR, k), at: t }]));
  const d = world({ start: "2026-10-14T17:20:00Z", preLog: pre });
  await play(d, { from: utc("17:20:00"), to: utc("23:59:30"), signals: [], ticks: everySec(utc("17:20:30"), utc("23:59:30"), 60) });
  const fresh = d.offLog().slice(pre.length);
  assert.deepEqual(fresh.map((l) => [hms(l.at), l.to, l.kind]), [["17:24:30", MGR, "manager"]], "the manager's 6th, 45 min (30 s slack) after his last one (16:39:58 in the replay)");
  assert.match(d.sent[0].text, /^⚠️ بورتال الكاشير مقفول من أول الشغل — الكاشير خد 16 تنبيه النهارده \(أقصى عدد\) ومش هيوصله تاني النهارده\./);
  const st = await d.team.portalStatus(T.teamConfig(d.db.settings), d.now());
  assert.equal(st.muted, true, "everyone at the cap ⇒ the dashboard says nothing more goes out today");
});

/* ═══ ٣) المراجعة: كل حالة ═══════════════════════════════════════════════════════════════════════════════ */
test("closed all day: the cashiers 3 times, then the manager every 45 min (a reminder, not a one-off), then — manager at his cap — the cashiers again up to theirs; nobody is skipped while someone has budget", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z" });
  await play(w, { from: utc("08:00:00"), to: utc("23:59:47"), signals: [{ t: utc("08:00:00"), via: "poll" }], ticks: ticks47("08:00:47", "23:59:47") });
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "08:55:47 cashier", "09:40:47 cashier", "14:11:47 cashier", "14:56:47 cashier", "15:41:47 cashier"]);
  assert.deepEqual(at(w, CASH2), at(w, CASH1));
  assert.deepEqual(at(w, MGR), ["10:25:47 manager", "11:10:47 manager", "11:55:47 manager", "12:40:47 manager", "13:25:47 manager", "14:10:47 manager"]);
  assertLimits(w);
  const m = texts(w, MGR);
  assert.equal(m[0], "10:25:47 ⚠️ بورتال الكاشير مقفول من أول الشغل رغم 3 تنبيهات للكاشير. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.", "true at that moment: 3 delivered alerts in this closure; «may not ring» (portal push still rings)");
  assert.equal(m[1], "11:10:47 ⚠️ تذكير: بورتال الكاشير لسه مقفول من أول الشغل. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.", "no signal since his last message ⇒ «لسه»");
  const st = await w.team.portalStatus(T.teamConfig(w.db.settings), w.now());
  assert.deepEqual([st.muted, st.recipients.map((r) => [r.name, r.today, r.capped])], [true, [["منى", 6, true], ["سارة", 6, true], ["خالد", 6, true]]]);
  assert.deepEqual([st.alerts.count, st.alerts.delivered, st.alerts.managerTold, st.alerts.managerLeft, st.alerts.cashierLeft, st.sentToday, st.failedToday], [6, 6, true, false, false, 18, 0]);
});

test("glances every 30 min all morning, then a genuine 2 h closure 14:30–16:30Z: messages keep coming inside the closure (cashiers back once the manager used his 6), and «back» reaches the manager when it is really open", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z" });
  const sig = [];
  for (let t = utc("08:00:00"); t < utc("14:30:00"); t += 30 * MIN) sig.push(...everySec(t, t + 20 * SEC, 20).map((x) => ({ t: x, via: "poll" })));
  sig.push(...everySec(utc("16:30:00"), utc("18:00:00"), 20).map((t) => ({ t, via: "poll" })));
  await play(w, { from: utc("08:00:00"), to: utc("18:00:00"), signals: sig, ticks: ticks47("08:00:47", "17:59:47") });
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "08:55:47 cashier", "09:40:47 cashier", "14:11:47 cashier", "14:56:47 cashier", "15:41:47 cashier"]);
  assert.deepEqual(at(w, MGR), ["10:25:47 manager", "11:10:47 manager", "11:55:47 manager", "12:40:47 manager", "13:25:47 manager", "14:10:47 manager", "16:32:47 back"]);
  assert.ok(w.offLog().filter((l) => l.at > utc("14:30:20") && l.at < utc("16:30:00")).length >= 4, "the 2 h closure got messages");
  assert.equal(texts(w, MGR).at(-1), "16:32:47 ✅ تمام، بورتال الكاشير اتفتح تاني ومفتوح من 19:30.", "no inflated «closed 509 min»");
  assert.equal(w.db.portal, null);
  assertLimits(w);
});

test("«back» goes at once (not 45 min later) and takes nothing from the manager's repeat or cap: a closure right after «back» starts a new round with the cashiers at once", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z" });
  const sig = [{ t: utc("08:00:00"), via: "poll" }, ...polls("10:30:00", "11:11:30"), ...polls("11:52:00", "13:00:00")];
  await play(w, { from: utc("08:00:00"), to: utc("13:00:00"), signals: sig, ticks: ticks47("08:00:47", "12:59:47") });
  assert.deepEqual(at(w, MGR), ["10:25:47 manager", "10:32:47 back"], "«back» the minute it is stably open");
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "08:55:47 cashier", "09:40:47 cashier", "11:21:47 cashier"], "the 11:11 closure: the cashier 10 min later (a new round), not silence");
  assert.equal(w.db.to.get(MGR).last_at, "2026-10-14T10:25:47.000Z", "«back» did not move the manager's repeat claim");
  assert.match(texts(w, MGR)[1], /^10:32:47 ✅ تمام، بورتال الكاشير اتفتح تاني ومفتوح من 13:30\.$/);
});

test("the manager's message is always true: after the cashier really opened the portal, a new closure goes to the cashier (count restarts), never «sent 3 alerts and still closed»; at the cap the manager hears «the cashier got 6 today» — at the cashier's next slot, not a minute after the 6th", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z" });
  /* ٣ تنبيهات، والكاشير يفتح ويشتغل كام دقيقة بعد التالت وبعد اللي بعده — كل مرة قفلة جديدة */
  const sig = [{ t: utc("08:00:00"), via: "poll" }, ...polls("09:45:00", "09:52:00"), { t: utc("10:30:00"), via: "action" }, ...polls("10:31:00", "10:36:00")];
  const out = await play(w, { from: utc("08:00:00"), to: utc("12:45:00"), signals: sig, ticks: ticks47("08:00:47", "12:44:47") });
  assert.equal(out.find((x) => x.t === utc("11:40:47")).portal.stage, "cashier", "11:40: a new closure ⇒ the cashier's turn, count 1");
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "08:55:47 cashier", "09:40:47 cashier", "10:25:47 cashier", "11:10:47 cashier", "11:55:47 cashier"]);
  assert.deepEqual(at(w, MGR), ["12:40:47 manager"], "never «3 alerts in this closure» (it was opened twice); the cap message 45 min after the cashier's 6th");
  assert.match(texts(w, MGR)[0], /^12:40:47 ⚠️ بورتال الكاشير مقفول من ساعتين — الكاشير خد 6 تنبيهات النهارده \(أقصى عدد\) ومش هيوصله تاني النهارده\./);
  assertLimits(w);
});

test("per-phone repeat (the approved rule, default): a new closure soon after a phone's last message waits until repeatMin since that message — held «repeat» WITH the time it can go, in the tick result and on the dashboard («hold»); the manager is not told (managerOnHold off)", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z" });
  const sig = [{ t: utc("08:00:00"), via: "poll" }, ...polls("09:45:00", "09:50:00"), ...polls("10:20:00", "12:00:00")];
  let st = null;
  const out = await play(w, { from: utc("08:00:00"), to: utc("12:00:00"), signals: sig, ticks: ticks47("08:00:47", "11:59:47"),
    events: [{ t: utc("10:06:00"), fn: async (x) => { st = await x.team.portalStatus(T.teamConfig(x.db.settings), x.now()); } }] });
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "08:55:47 cashier", "09:40:47 cashier"], "09:50–10:20: the cashier had a message at 09:40:47 ⇒ nothing before 10:25:17, and it reopened at 10:20");
  assert.deepEqual(at(w, MGR), [], "managerOnHold off ⇒ the manager is not told about this short re-closure");
  const t = out.find((x) => x.t === utc("10:05:47")).portal;
  assert.deepEqual([t.offline, t.stage, t.held.map((h) => [h.why, h.until])], [true, "cashier", [["repeat", "2026-10-14T10:25:17.000Z"], ["repeat", "2026-10-14T10:25:17.000Z"]]]);
  assert.deepEqual([st.alerts.count, st.alerts.hold], [0, { lastAt: "2026-10-14T09:40:47.000Z", until: "2026-10-14T10:25:17.000Z" }], "the dashboard says when the next message can go");
  assert.deepEqual(st.recipients.filter((r) => r.role === "cashier").map((r) => [r.lastAt, r.nextAt]), [["2026-10-14T09:40:47.000Z", "2026-10-14T10:25:17.000Z"], ["2026-10-14T09:40:47.000Z", "2026-10-14T10:25:17.000Z"]]);
});

test("«back» belongs to its own round: «back» right before the portal closes again does not swallow the next round's «back»", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z", waTeam: { portalOffline: { managerAfter: 1, repeatMin: 15 } } });
  const sig = [{ t: utc("08:00:00"), via: "poll" }, ...polls("08:30:00", "08:33:00"), ...polls("09:10:00", "09:20:00")];
  await play(w, { from: utc("08:00:00"), to: utc("09:30:00"), signals: sig, ticks: ticks47("08:00:47", "09:29:47") });
  assert.deepEqual(at(w, MGR), ["08:25:47 manager", "08:32:47 back", "08:58:47 manager", "09:12:47 back"], "two rounds, two «back» — the 08:33 closure was 13 s after the first «back»");
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "08:43:47 cashier"]);
  assertLimits(w, { repeatMin: 15 });
});

test("«back» switch: turned off while the portal is still closed ⇒ no «back» when it comes back (checked at sending time)", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z" });
  const sig = [{ t: utc("08:00:00"), via: "poll" }, ...polls("10:40:00", "11:00:00")];
  await play(w, { from: utc("08:00:00"), to: utc("11:00:00"), signals: sig, ticks: ticks47("08:00:47", "10:59:47"),
    events: [{ t: utc("10:30:00"), fn: (x) => { x.db.settings.waTeam.portalOffline = { backNotice: false }; } }] });
  assert.deepEqual(at(w, MGR), ["10:25:47 manager"]);
  assert.equal(w.db.portal, null, "the round ended silently");
});

test("the first alert of the day says «since the shift began», not the overnight minutes; long closures in hours", async () => {
  const w = world({ start: "2026-10-14T23:20:00Z" });
  await play(w, { from: utc("23:20:00"), to: utc("23:30:00"), signals: [{ t: utc("23:30:00"), via: "poll" }], ticks: [] });      // ٠٢:٣٠ الرياض
  await play(w, { from: utc("07:59:00", "2026-10-15"), to: utc("08:11:00", "2026-10-15"), signals: [], ticks: ticks47("07:59:47", "08:10:47", "2026-10-15") });
  assert.equal(texts(w, CASH1).at(-1), "08:10:47 ⚠️ البورتال مقفول من أول الشغل — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.", "not «من 520 دقيقة»");
  assert.deepEqual([T.durAr(1), T.durAr(2), T.durAr(7), T.durAr(25), T.durAr(60), T.durAr(64), T.durAr(80), T.durAr(135), T.durAr(190), T.durAr(670)],
    ["دقيقة", "دقيقتين", "7 دقايق", "25 دقيقة", "ساعة", "ساعة", "ساعة و20 دقيقة", "ساعتين و15 دقيقة", "3 ساعات و10 دقايق", "11 ساعة و10 دقايق"]);
  assert.match(T.portalOfflineText({ offMin: 135 }), /^⚠️ البورتال مقفول من ساعتين و15 دقيقة — /);
});

test("store paused then resumed: the afterMin grace counts from the resume (the pause has no history in settings, the tick remembers it)", async () => {
  const days = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { open: "11:00", close: "03:00" }]));
  const hours = { enabled: true, days };
  const w = world({ start: "2026-10-14T11:30:00Z", settings: { hours, service: { delivery: { paused: false }, pickup: { paused: false } } } });
  const pause = (on) => (x) => { x.db.settings.service = { delivery: { paused: on }, pickup: { paused: on }, ...(on ? {} : { resumedAt: new Date(x.nowMs()).toISOString() }) }; };
  const sig = [...polls("11:30:00", "12:05:00")];
  const out = await play(w, { from: utc("11:30:00"), to: utc("13:00:00"), signals: sig, ticks: ticks47("11:30:47", "12:59:47"),
    events: [{ t: utc("12:00:00"), fn: pause(true) }, { t: utc("12:40:00"), fn: pause(false) }] });
  assert.ok(out.filter((x) => x.t > utc("12:00:00") && x.t < utc("12:40:00")).every((x) => x.portal.work === false), "paused ⇒ not working time");
  assert.deepEqual(at(w, CASH1), ["12:50:47 cashier"], "resumed 12:40 ⇒ the first alert 10 min later, not at 12:40:47");
  assert.match(texts(w, CASH1)[0], /^12:50:47 ⚠️ البورتال مقفول من أول الشغل — /, "the closure counts from the resume");
  /* تشغيل جديد جوّه المهلة (الدورة ماشافتش الرجوع): آخر رجوع متسجّل (service.resumedAt) هو اللي بيتحسب */
  const r = world({ start: "2026-10-14T12:41:00Z", settings: { hours, service: { delivery: { paused: false }, pickup: { paused: false }, resumedAt: "2026-10-14T12:40:00.000Z" } } });
  await r.restart();
  await play(r, { from: utc("12:41:00"), to: utc("12:52:00"), signals: [], ticks: ticks47("12:41:47", "12:51:47") });
  assert.deepEqual(at(r, CASH1), ["12:50:47 cashier"], "a restart at 12:41 still waits until 12:50 (resumedAt + 10)");
  assert.equal(T.workStartOf({ hours }, "2026-10-14T09:07:30Z"), "2026-10-14T08:00:30.000Z", "11:00 Riyadh opening, found by quarter-hour steps then minutes");
});

test("countBackground off (default): a portal that only talks from the background is «not on screen» — the cashier is told to keep it in front; on: it counts as open", async () => {
  const sig = [...polls("17:00:00", "17:01:00"), ...everySec(utc("17:01:20"), utc("17:40:00"), 60).map((t) => ({ t, via: "api" }))];
  const ticks = everySec(utc("17:00:30"), utc("17:40:30"), 60);
  const off = world({ start: "2026-10-14T17:00:00Z" });
  await play(off, { from: utc("17:00:00"), to: utc("17:40:30"), signals: sig, ticks });
  assert.deepEqual(at(off, CASH1), ["17:11:30 cashier"]);
  assert.equal(texts(off, CASH1)[0], "17:11:30 ⚠️ البورتال مش ظاهر على الشاشة من 10 دقايق — خليه مفتوح قدامك عشان الطلبات ومحادثات العملاء ترن عندك.");
  const st = await off.team.portalStatus(T.teamConfig(off.db.settings), off.now());
  assert.deepEqual([st.countBackground, st.cashier.hidden, st.devices[0].visible, st.devices[0].background, st.devices[0].open], [false, true, false, true, false]);
  const on = world({ start: "2026-10-14T17:00:00Z", waTeam: { portalOffline: { countBackground: true } } });
  await play(on, { from: utc("17:00:00"), to: utc("17:40:30"), signals: sig, ticks });
  assert.equal(on.offLog().length, 0, "the owner chose: background requests count");
  /* البث المفتوح لوحده (من غير طلبات من الجهاز) مابيبقاش حضور: نبضاته بتاعة السيرفر (اختبار portal.js فوق) ⇒ تاب متجمّد = مقفول */
  const frozen = world({ start: "2026-10-14T17:00:00Z", waTeam: { portalOffline: { countBackground: true } } });
  await play(frozen, { from: utc("17:00:00"), to: utc("17:20:30"), signals: [...polls("17:00:00", "17:00:40"), { t: utc("17:00:50"), via: "sse" }], ticks: everySec(utc("17:00:30"), utc("17:20:30"), 60) });
  assert.deepEqual(at(frozen, CASH1), ["17:11:30 cashier"], "10 min after the device's last own request");
});

test("dashboard devices: «on screen» means a visible signal in the last ~2.5 min (not the last afterMin); background = talking now but not visible", async () => {
  const w = world({ start: "2026-10-14T15:00:00Z" });
  w.db.presence.set("s1|tab", { staff_id: "s1", staff_name: "منى", role: "cashier", device: "tab", last_seen: "2026-10-14T14:59:50Z", seen_since: "2026-10-14T14:30:00Z", via: "api", last_visible: "2026-10-14T14:51:00Z", visible_since: "2026-10-14T14:30:00Z" });
  w.db.presence.set("s2|ph", { staff_id: "s2", staff_name: "سارة", role: "cashier", device: "ph", last_seen: "2026-10-14T14:59:20Z", seen_since: "2026-10-14T14:50:00Z", via: "beat", last_visible: "2026-10-14T14:59:20Z", visible_since: "2026-10-14T14:50:00Z" });
  w.db.presence.set("m1|pc", { staff_id: "m1", staff_name: "خالد", role: "manager", device: "pc", last_seen: "2026-10-14T14:40:00Z", seen_since: null, via: "poll", last_visible: "2026-10-14T14:40:00Z", visible_since: null });
  const st = await w.team.portalStatus(T.teamConfig(w.db.settings), w.now());
  assert.deepEqual(st.devices.map((d) => [d.name, d.open, d.visible, d.background, d.offMin, d.via]),
    [["منى", true, false, true, 9, "api"], ["سارة", true, true, false, 0, "beat"], ["خالد", false, false, false, 20, "poll"]], "منى: on screen 9 min ago, background now ⇒ not «on screen»");
  assert.deepEqual(st.cashier, { open: true, stable: true, lastSeen: "2026-10-14T14:59:20.000Z", offMin: 0, hidden: false });
  assert.deepEqual([st.working, st.alerts, st.sentToday, st.countBackground, st.afterMin, st.freshSec, st.dailyCap, st.muted], [true, null, 0, false, 10, 150, 6, false]);
  assert.deepEqual([st.repeatMin, st.backStableMin, st.keepMin, st.managerOnHold, st.failedToday, st.error], [45, 2, 45, false, 0, undefined]);
  assert.deepEqual(st.presence, { writes: 0, errors: 0, lastOkAt: null, lastError: null, lastErrorAt: null, readErrors: 0, lastReadOkAt: "2026-10-14T15:00:00.000Z", lastReadError: null, lastReadErrorAt: null, failing: false, readFailing: false },
    "the write/read health travels with the status (verify.py reads it); failing = the LAST attempt failed");
});

test("daily cap without a manager in the team: cashiers only, repeat + cap; a new business day starts again", async () => {
  const w = world({ start: "2026-10-14T09:00:00Z", members: MEMBERS.filter((m) => m.role !== "manager"), waTeam: { portalOffline: { repeatMin: 30 } } });
  await play(w, { from: utc("09:00:00"), to: utc("23:59:00"), signals: [], ticks: everySec(utc("09:00:30"), utc("23:59:30"), 60) });
  const c1 = w.offLog().filter((l) => l.to === CASH1);
  assert.equal(c1.length, 6); assert.deepEqual([hms(c1[0].at), hms(c1[5].at)], ["09:00:30", "11:30:30"]);
  assertLimits(w, { repeatMin: 30 });
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

test("portal watch: never outside working hours (an open round ends silently), a manager-only portal does not count, and the switch turns it off", async () => {
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
  assert.equal(T.workingNow({}, "2026-10-14T12:05:00Z", 10, "2026-10-14T12:00:00Z"), false, "resumed 5 min ago");
  assert.equal(T.workStartOf({}, "2026-10-14T08:10:30Z"), "2026-10-14T08:00:30.000Z");
  assert.equal(T.workStartOf({}, "2026-10-14T03:00:00Z"), null);
});

test("portalSignal: closed by the newest counted signal of any cashier device (exact ms); stable = one device open backStableMin in a row; hidden = closed on screen but talking from the background", () => {
  const now = "2026-10-14T15:00:00Z";
  const d = (o) => ({ role: "cashier", ...o });
  const on = { afterMin: 10, backStableMin: 2, countBackground: true };
  const a = T.portalSignal([d({ lastSeen: "2026-10-14T14:50:00.500Z", seenSince: "2026-10-14T14:40:00Z" })], now, on);
  assert.deepEqual([a.closed, a.offMin, a.stable], [false, 9, false], "9 min 59.5 s: not yet, and not fresh enough to be stable");
  const b = T.portalSignal([d({ lastSeen: "2026-10-14T14:59:30Z", seenSince: "2026-10-14T14:58:00Z" }), d({ lastSeen: "2026-10-14T14:20:00Z" })], now, on);
  assert.deepEqual([b.closed, b.stable, b.lastSeen], [false, false, "2026-10-14T14:59:30.000Z"], "1.5 min streak < 2");
  const c = T.portalSignal([d({ lastSeen: "2026-10-14T14:59:30Z", seenSince: "2026-10-14T14:57:00Z" })], now, on);
  assert.deepEqual([c.stable, c.streakStart], [true, "2026-10-14T14:57:00.000Z"]);
  assert.equal(T.portalSignal([d({ lastSeen: "2026-10-14T14:59:30Z" })], now, on).stable, false, "old row without a streak start = one signal");
  assert.deepEqual(T.portalSignal([{ role: "manager", lastSeen: "2026-10-14T14:59:59Z" }], now, on), { lastSeen: null, offMin: null, closed: true, stable: false, streakStart: null, openSince: null, lastAny: null, hidden: false });
  /* openSince = بداية الفتحة اللي مخلّية البوابة «مش مقفولة» (أقدم بداية بين الأجهزة اللي إشارتها جوّه afterMin) — بداية فترة reopened_at */
  const two = T.portalSignal([d({ lastSeen: "2026-10-14T14:57:00Z", seenSince: "2026-10-14T14:57:00Z" }), d({ lastSeen: "2026-10-14T14:59:30Z", seenSince: "2026-10-14T14:58:30Z" }), d({ lastSeen: "2026-10-14T14:40:00Z", seenSince: "2026-10-14T14:30:00Z" })], now, on);
  assert.deepEqual([two.closed, two.openSince], [false, "2026-10-14T14:57:00.000Z"], "the device silent for 20 min does not count");
  assert.equal(T.portalSignal([d({ lastSeen: "2026-10-14T14:45:00Z", seenSince: "2026-10-14T14:44:00Z" })], now, on).openSince, null, "closed ⇒ no open run");
  assert.deepEqual([T.keepMinOf({ repeatMin: 45, afterMin: 10, backStableMin: 2 }), T.keepMinOf({ repeatMin: 5, afterMin: 10, backStableMin: 2 }), T.keepMinOf({ repeatMin: 5, afterMin: 60, backStableMin: 30 })], [45, 12, 90],
    "always longer than afterMin (one glance keeps it «not closed» for exactly afterMin) and never shorter than repeatMin");
  const def = T.portalSignal([d({ lastSeen: "2026-10-14T14:59:00Z", lastVisible: "2026-10-14T14:40:00Z" })], now, { afterMin: 10 });
  assert.deepEqual([def.closed, def.hidden, def.offMin], [true, true, 20], "default = on screen only; still talking from the background ⇒ hidden");
  assert.equal(T.portalSignal([d({ lastSeen: "2026-10-14T14:45:00Z", lastVisible: "2026-10-14T14:40:00Z" })], now, { afterMin: 10 }).hidden, false, "silent everywhere ⇒ closed, not hidden");
});

test("settings: defaults (the live 10 / 45 / 3; background does not count — RG1's rule; managerOnHold off), 9 portalOffline knobs with Arabic labels in draw order, limits (afterMin from 3); the window knob is gone", () => {
  const c = T.teamConfig({ waTeam: { members: [] } });
  assert.deepEqual(c.portalOffline, { enabled: true, afterMin: 10, repeatMin: 45, managerAfter: 3, backStableMin: 2, dailyCap: 6, countBackground: false, managerOnHold: false, backNotice: true });
  const keys = T.KNOBS.filter((k) => k.key.startsWith("portalOffline.")).map((k) => k.key.split(".")[1]);
  assert.deepEqual(keys, ["enabled", "countBackground", "afterMin", "backStableMin", "repeatMin", "dailyCap", "managerAfter", "managerOnHold", "backNotice"]);
  /* afterMin من ٣: الحضور بيتكتب مرة في الدقيقة ⇒ بدقيقة واحدة بوابة ظاهرة طول الوقت كانت بتطلع «مقفولة» (المراجعة التانية) */
  assert.deepEqual(T.LIMITS["portalOffline.afterMin"], [3, 60]);
  assert.equal(T.configFromBody({ portalOffline: { afterMin: 2 } }, {}).ok, false);
  assert.equal(T.teamConfig({ waTeam: { portalOffline: { afterMin: 1 } } }).portalOffline.afterMin, 10, "an old out-of-range value falls back to the default");
  assert.equal(T.configFromBody({ portalOffline: { managerOnHold: "on" } }, {}).ok, false);
  assert.equal(T.teamConfig({ waTeam: T.configFromBody({ portalOffline: { managerOnHold: true } }, {}).value }).portalOffline.managerOnHold, true);
  /* نص مفتاح «المدير يتبلّغ بعد» زي الكود: الكاشير بيرجع ياخد لو مفيش مدير أو المدير وصل لأقصى عدد، والمدير مش «على طول» */
  const ma = T.KNOBS.find((k) => k.key === "portalOffline.managerAfter").hint;
  assert.match(ma, /المدير وصل لأقصى عدد ⇒ الكاشير ياخد تاني/); assert.match(ma, /في ميعاد رسالة الكاشير الجاية/); assert.doesNotMatch(ma, /على طول/);
  assert.match(T.KNOBS.find((k) => k.key === "portalOffline.repeatMin").hint, /الرسالة الجاية بتستنى/, "the per-phone repeat trade-off is said where the owner sets it");
  for (const k of T.KNOBS.filter((x) => x.key.startsWith("portalOffline."))) {
    assert.match(k.label, /[؀-ۿ]/, k.key); assert.match(k.hint || "", /[؀-ۿ]/, `${k.key} hint`);
    if (k.type === "num") { assert.ok(Array.isArray(T.LIMITS[k.key]), k.key); assert.match(k.unit, /[؀-ۿ]/, k.key); }
  }
  assert.equal(T.LIMITS["portalOffline.managerWindowMin"], undefined);
  assert.doesNotMatch(T.KNOBS.find((k) => k.key === "portalOffline.countBackground").hint, /بيستقبل الطلبات/, "no promise nothing checks");
  assert.equal(T.configFromBody({ portalOffline: { dailyCap: 0 } }, {}).ok, false);
  assert.equal(T.configFromBody({ portalOffline: { countBackground: "yes" } }, {}).ok, false);
  const ok = T.configFromBody({ portalOffline: { repeatMin: 120, managerAfter: 10, backStableMin: 5, countBackground: true, dailyCap: 4 } }, {});
  assert.equal(ok.ok, true, "any combination inside the limits saves (no cross-check left to trip on)");
  assert.deepEqual(T.teamConfig({ waTeam: ok.value }).portalOffline, { enabled: true, afterMin: 10, repeatMin: 120, managerAfter: 10, backStableMin: 5, dailyCap: 4, countBackground: true, managerOnHold: false, backNotice: true });
  assert.equal(T.teamConfig({ waTeam: { portalOffline: { dailyCap: 99 } } }).portalOffline.dailyCap, 6, "out of range ⇒ default");
  assert.equal(T.teamConfig({ waTeam: { portalOffline: { countBackground: "true" } } }).portalOffline.countBackground, false, "only a real true turns it on");
});

test("texts: cashier (closed / not on screen), manager (ignored / cap / reminder / closed again / hold / not reaching the cashier — each true when sent, «may not ring», no state said twice), «back» (stable / kept)", () => {
  assert.equal(T.portalOfflineText({ offMin: 10 }), "⚠️ البورتال مقفول من 10 دقايق — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.\nافتح البورتال ↗ https://freshcuts-invite.o2m8.me/portal/");
  assert.equal(T.portalOfflineText({ offMin: 12, hidden: true }).split("\n")[0], "⚠️ البورتال مش ظاهر على الشاشة من 12 دقيقة — خليه مفتوح قدامك عشان الطلبات ومحادثات العملاء ترن عندك.");
  assert.equal(T.portalOfflineNotice({ offMin: 10 }), "البورتال مقفول من 10 دقايق — افتحه عشان الطلبات ومحادثات العملاء ترن عندك");
  const first = (x) => T.portalOfflineManagerText(x).split("\n")[0];
  assert.equal(first({ offMin: 25, alerts: 3 }), "⚠️ بورتال الكاشير مقفول من 25 دقيقة رغم 3 تنبيهات للكاشير. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.");
  assert.equal(first({ offMin: 25, alerts: 3, hidden: true }), "⚠️ بورتال الكاشير مش ظاهر على الشاشة من 25 دقيقة رغم 3 تنبيهات للكاشير. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.", "the state once, not twice");
  assert.equal(first({ offMin: 25, reason: "cap", cap: 6 }), "⚠️ بورتال الكاشير مقفول من 25 دقيقة — الكاشير خد 6 تنبيهات النهارده (أقصى عدد) ومش هيوصله تاني النهارده. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.");
  assert.equal(first({ offMin: 70, reminder: true, hidden: true }), "⚠️ تذكير: بورتال الكاشير لسه مش ظاهر على الشاشة من ساعة و10 دقايق. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.");
  assert.equal(first({ offMin: 10, reminder: true, reopened: true }), "⚠️ تذكير: بورتال الكاشير اتقفل تاني — مقفول من 10 دقايق. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.", "opened after his last message ⇒ not «still closed»");
  assert.match(first({ offMin: 5, alerts: 1 }), /رغم تنبيه واحد للكاشير\./);
  /* اللي وصل بس: محاولات فشلت بتتقال كده */
  assert.equal(first({ offMin: 25, alerts: 3, delivered: 0 }), "⚠️ بورتال الكاشير مقفول من 25 دقيقة — ومش قادرين نوصل للكاشير على واتساب (3 محاولات). الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.");
  assert.match(first({ offMin: 25, alerts: 3, delivered: 1 }), /رغم تنبيه واحد وصل للكاشير \(من 3 محاولات\)\./);
  assert.match(first({ offMin: 25, alerts: 3, delivered: 2 }), /رغم تنبيهين وصلوا للكاشير \(من 3 محاولات\)\./);
  /* اتقفل تاني بعد رسالة الكاشير بشوية (managerOnHold) */
  const held = { lastAt: "2026-10-14T08:10:47Z", until: "2026-10-14T08:55:17Z" };
  assert.equal(first({ offMin: 10, reason: "hold", held: { ...held, opened: true } }), "⚠️ بورتال الكاشير اتقفل تاني من 10 دقايق — الكاشير اتبعتله الساعة 11:10 وفتحه بعدها وقفله، ورسالته الجاية 11:55. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.");
  assert.equal(first({ offMin: 12, reason: "hold", held: { ...held, opened: false } }), "⚠️ بورتال الكاشير مقفول من 12 دقيقة — الكاشير اتبعتله الساعة 11:10 ولسه مافتحوش، ورسالته الجاية 11:55. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.", "never «closed again» when it was not opened");
  assert.equal(T.portalOfflineManagerNotice({ offMin: 25, alerts: 3 }), "بورتال الكاشير مقفول من 25 دقيقة رغم 3 تنبيهات للكاشير");
  assert.equal(T.portalOfflineManagerNotice({ offMin: 145, reason: "cap", cap: 6, hidden: true }), "بورتال الكاشير مش ظاهر على الشاشة من ساعتين و25 دقيقة — الكاشير خد 6 تنبيهات النهارده (أقصى عدد)", "the review's cut case now fits whole");
  assert.equal(T.portalBackText({ at: "2026-10-14T13:05:00Z" }), "✅ تمام، بورتال الكاشير اتفتح تاني ومفتوح من 16:05.");
  assert.equal(T.portalBackText({ at: "2026-10-14T10:30:00Z", kept: true, afterMin: 10 }), "✅ بورتال الكاشير رجع يتفتح من 13:30 — كل كام دقيقة، ومافضلش مقفول 10 دقايق ورا بعض (بس مش فاضل مفتوح على طول).", "kept: never claims it stayed on screen");
  assert.equal(T.fitLine("كلمة ".repeat(40), 120).length <= 120, true); assert.match(T.fitLine("كلمة ".repeat(40), 120), /كلمة…$/, "cut at a word, with an ellipsis");
});

test("template lines (fc_staff_team_notice ≤120, one line): every manager / cashier variant fits whole for any duration 1–960 min and any cap 1–30 — no word cut in half", () => {
  const held = { lastAt: "2026-10-14T20:59:00Z", until: "2026-10-14T21:44:00Z" };
  let longest = 0;
  for (let offMin = 1; offMin <= 960; offMin++) {
    for (const hidden of [false, true]) {
      const xs = [{ offMin, hidden, alerts: 10 }, { offMin, hidden, alerts: 30, delivered: 0 }, { offMin, hidden, alerts: 30, delivered: 12 }, { offMin, hidden, reminder: true }, { offMin, hidden, reminder: true, reopened: true },
        { offMin, hidden, reason: "hold", held: { ...held, opened: true } }, { offMin, hidden, reason: "hold", held: { ...held, opened: false } }, ...[1, 6, 12, 30].map((cap) => ({ offMin, hidden, reason: "cap", cap }))];
      for (const x of xs) {
        const n = T.portalOfflineManagerNotice(x);
        longest = Math.max(longest, n.length);
        assert.ok(n.length <= 120 && !/\n/.test(n) && !n.endsWith("…"), `${JSON.stringify(x)} ⇒ ${n.length}: ${n}`);
      }
      const c = T.portalOfflineNotice({ offMin, hidden });
      assert.ok(c.length <= 120 && !c.endsWith("…"), c);
    }
  }
  assert.ok(longest <= 120, `longest manager line ${longest}`);
});

test("saving answers with the whole team payload (schema, portal, members…) — the dashboard replaces its state with the answer, so the cards no longer vanish after a save", async () => {
  const routes = {};
  const app = { get: (p, h) => { routes[`GET ${p}`] = h; }, put: (p, h) => { routes[`PUT ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  const w = world({ start: "2026-10-14T15:00:00Z", app });
  const c = (body) => ({ req: { json: async () => body, header: () => null }, json: (b, status = 200) => ({ body: b, status }) });
  const g = await routes["GET /api/cms/wabot/team"](c());
  const r = await routes["PUT /api/cms/wabot/team"](c({ portalOffline: { afterMin: 15 } }));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), Object.keys(g.body).sort(), "same shape as GET");
  assert.equal(r.body.config.portalOffline.afterMin, 15);
  assert.ok(r.body.schema.knobs.some((k) => k.key === "portalOffline.afterMin") && r.body.portal && Array.isArray(r.body.members));
  assert.equal(r.body.portal.afterMin, 15, "the portal card already reflects the saved setting");
  assert.equal(w.db.settings.waTeam.portalOffline.afterMin, 15);
  const bad = await routes["PUT /api/cms/wabot/team"](c({ portalOffline: { dailyCap: 0 } }));
  assert.deepEqual([bad.status, bad.body.error], [400, "invalid"]);
});

/* ═══ ٤) المراجعة التانية (١٤/١٠ بالليل): كل ملاحظة باختبار ═════════════════════════════════════════════ */
const glances = (a, b, everyMin, day) => { const o = []; for (let t = utc(a, day); t <= utc(b, day); t += everyMin * MIN) o.push({ t, via: "poll" }); return o; };
const DAYS7 = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { open: "11:00", close: "03:00" }]));
const HOURS = { enabled: true, days: DAYS7 };
const OPEN_SERVICE = { delivery: { paused: false }, pickup: { paused: false } };

test("R2 major — glances that keep the portal «not closed» end the round after keepMin (max(repeatMin, afterMin+backStableMin) = 45): the manager told in it gets an honest «back», and the next real closure starts with the cashier — not «تذكير: لسه مقفول من 10 دقايق» with the cashier skipped for hours", async () => {
  /* سيناريو المراجعة (t4c): ٣ تنبيهات + المدير اتبلّغ، الكاشير بيبص كل ٤ دقايق ١٠:٣٠–١٤:٠٠Z، وبعدين قفلة حقيقية */
  const w = world({ start: "2026-10-14T08:00:00Z" });
  let mid = null;
  const out = await play(w, { from: utc("08:00:00"), to: utc("19:00:00"), signals: [{ t: utc("08:00:00"), via: "poll" }, ...glances("10:30:00", "14:00:00", 4)], ticks: ticks47("08:00:47", "18:59:47"),
    events: [{ t: utc("11:00:00"), fn: async (x) => { mid = await x.team.portalStatus(T.teamConfig(x.db.settings), x.now()); } }] });
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "08:55:47 cashier", "09:40:47 cashier", "14:08:47 cashier", "14:53:47 cashier", "15:38:47 cashier"], "was: nothing for the cashier until 17:09:47");
  assert.deepEqual(at(w, MGR), ["10:25:47 manager", "11:15:47 back", "16:23:47 manager", "17:08:47 manager", "17:53:47 manager", "18:38:47 manager"], "was: «تذكير … من 10 دقايق» at 14:08:47");
  const m = texts(w, MGR);
  assert.equal(m[1], "11:15:47 ✅ بورتال الكاشير رجع يتفتح من 13:30 — كل كام دقيقة، ومافضلش مقفول 10 دقايق ورا بعض (بس مش فاضل مفتوح على طول).");
  assert.equal(m[2], "16:23:47 ⚠️ بورتال الكاشير مقفول من ساعتين و25 دقيقة — الكاشير خد 6 تنبيهات النهارده (أقصى عدد) ومش هيوصله تاني النهارده. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.",
    "the cashiers' 6th was at 15:38:47 ⇒ the cap reason (true); never «reminder» — the morning round ended at 11:15");
  assert.equal(m[3], "17:08:47 ⚠️ تذكير: بورتال الكاشير لسه مقفول من 3 ساعات و10 دقايق. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.");
  const t1 = out.find((x) => x.t === utc("14:08:47")).portal;
  assert.deepEqual([t1.stage, t1.round, t1.held], ["cashier", 1, []], "the real closure goes to the cashier first (was: held [manager_turn, manager_turn])");
  assert.deepEqual([out.find((x) => x.t === utc("11:14:47")).portal.waitingStable, out.find((x) => x.t === utc("11:15:47")).portal.ended], [true, "kept"]);
  assert.deepEqual([mid.alerts.reopenedAt, mid.alerts.endsAt, mid.alerts.managerTold, mid.cashier.open], ["2026-10-14T10:30:00.000Z", "2026-10-14T11:15:00.000Z", true, true], "the dashboard: open again since 10:30, the round ends by itself at 11:15");
  assertLimits(w);
});

test("R2 major — glances right after the first alert: the morning round ends at keepMin, so the 14:10 closure needs 3 alerts of its own; a glance or two (shorter than keepMin) never end a round, and a reminder after the portal was opened again says «اتقفل تاني», not «لسه مقفول»", async () => {
  /* t4-flap: تنبيه ٠٨:١٠ وبعدين بصّات كل ٤ دقايق ٠٨:١٢–١٤:٠٠ ⇒ كان المدير بياخد «٣ تنبيهات» وواحد منهم بتاع الصبح */
  const w = world({ start: "2026-10-14T08:00:00Z" });
  await play(w, { from: utc("08:00:00"), to: utc("16:30:00"), signals: [{ t: utc("08:00:00"), via: "poll" }, ...glances("08:12:00", "14:00:00", 4)], ticks: ticks47("08:00:47", "16:29:47") });
  assert.deepEqual(at(w, CASH1), ["08:10:47 cashier", "14:10:47 cashier", "14:55:47 cashier", "15:40:47 cashier"]);
  assert.deepEqual(at(w, MGR), ["16:25:47 manager"]);
  assert.match(texts(w, MGR)[0], /^16:25:47 ⚠️ بورتال الكاشير مقفول من ساعتين و25 دقيقة رغم 3 تنبيهات للكاشير\./);
  /* بصّتين بفرق ٥ دقايق: «مش مقفول» ١٥ دقيقة < ٤٥ ⇒ نفس المرة، والعدّ مابيبدأش من الأول */
  const v = world({ start: "2026-10-14T08:00:00Z" });
  await play(v, { from: utc("08:00:00"), to: utc("11:00:00"), signals: [{ t: utc("08:00:00"), via: "poll" }, { t: utc("09:00:00"), via: "poll" }, { t: utc("09:05:00"), via: "poll" }], ticks: ticks47("08:00:47", "10:59:47") });
  assert.deepEqual([at(v, CASH1), at(v, MGR)], [["08:10:47 cashier", "08:55:47 cashier", "09:40:47 cashier"], ["10:25:47 manager"]]);
  /* المدير اتبلّغ، الكاشير بص ١٠:٤٠–١١:٠٠ (٢٠ دقيقة < ٤٥) وقفل ⇒ التذكير «اتقفل تاني — مقفول من 10 دقايق»، واللي بعده «لسه مقفول» */
  const r = world({ start: "2026-10-14T08:00:00Z" });
  await play(r, { from: utc("08:00:00"), to: utc("12:00:00"), signals: [{ t: utc("08:00:00"), via: "poll" }, ...glances("10:40:00", "11:00:00", 4)], ticks: ticks47("08:00:47", "11:59:47") });
  assert.deepEqual(texts(r, MGR), ["10:25:47 ⚠️ بورتال الكاشير مقفول من أول الشغل رغم 3 تنبيهات للكاشير. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.",
    "11:10:47 ⚠️ تذكير: بورتال الكاشير اتقفل تاني — مقفول من 10 دقايق. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.",
    "11:55:47 ⚠️ تذكير: بورتال الكاشير لسه مقفول من 55 دقيقة. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم."]);
  assertLimits(w); assertLimits(v); assertLimits(r);
});

test("R2 major (kept by default, owner's switch added) — closed again soon after the cashier's message: by default the cashier waits for repeatMin (approved per-phone repeat); with «managerOnHold» the manager hears it at once, once per closure, truthfully — and gets «back»", async () => {
  const sig34 = [{ t: utc("08:00:00"), via: "poll" }, ...polls("08:12:00", "08:16:00"), ...polls("08:50:00", "09:10:00")];
  const sig74 = [{ t: utc("08:00:00"), via: "poll" }, ...polls("08:12:00", "08:16:00"), ...polls("09:30:00", "09:40:00")];
  /* الافتراضي: نفس سيناريو المراجعة (t2) ⇒ مفيش رسالة للمدير، والكاشير بعد ٤٥ من رسالته */
  const d = world({ start: "2026-10-14T08:00:00Z" });
  const dout = await play(d, { from: utc("08:00:00"), to: utc("09:10:00"), signals: sig34, ticks: ticks47("08:00:47", "09:09:47") });
  assert.deepEqual([at(d, CASH1), at(d, MGR)], [["08:10:47 cashier"], []]);
  assert.deepEqual(dout.find((x) => x.t === utc("08:26:47")).portal.held.map((h) => [h.why, h.until]), [["repeat", "2026-10-14T08:55:17.000Z"], ["repeat", "2026-10-14T08:55:17.000Z"]]);
  /* المفتاح شغّال: القفلة ٣٤ دقيقة بقت بتتقال للمدير ٠٨:٢٦:٤٧ (afterMin + أقل من دقيقة)، و«رجع» أول ما فضل مفتوح */
  const w = world({ start: "2026-10-14T08:00:00Z", waTeam: { portalOffline: { managerOnHold: true } } });
  const out = await play(w, { from: utc("08:00:00"), to: utc("09:10:00"), signals: sig34, ticks: ticks47("08:00:47", "09:09:47") });
  assert.deepEqual([at(w, CASH1), at(w, MGR)], [["08:10:47 cashier"], ["08:26:47 manager", "08:52:47 back"]]);
  assert.deepEqual(texts(w, MGR), ["08:26:47 ⚠️ بورتال الكاشير اتقفل تاني من 10 دقايق — الكاشير اتبعتله الساعة 11:10 وفتحه بعدها وقفله، ورسالته الجاية 11:55. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.",
    "08:52:47 ✅ تمام، بورتال الكاشير اتفتح تاني ومفتوح من 11:50."]);
  const h = out.find((x) => x.t === utc("08:26:47")).portal;
  assert.deepEqual([h.stage, h.manager.reason, h.manager.to[0].hold], ["cashier", "hold", true]);
  /* القفلة ٧٤ دقيقة: المدير مرة واحدة (مش كل دقيقة)، والكاشير في ميعاده ٠٨:٥٥:٤٧ (أول تنبيه في المرة دي)، و«رجع» للمدير */
  const l = world({ start: "2026-10-14T08:00:00Z", waTeam: { portalOffline: { managerOnHold: true } } });
  await play(l, { from: utc("08:00:00"), to: utc("09:45:00"), signals: sig74, ticks: ticks47("08:00:47", "09:44:47") });
  assert.deepEqual([at(l, CASH1), at(l, MGR)], [["08:10:47 cashier", "08:55:47 cashier"], ["08:26:47 manager", "09:32:47 back"]]);
  assertLimits(w); assertLimits(l);
});

test("R2 minor — a restart during working hours, then a delivery-only pause that ends while pickup stayed open: nothing changes (resumedAt is read once after a boot) — the manager keeps his reminders and gets «back»", async () => {
  const pauseDelivery = (on) => (x) => { const s = x.db.settings.service || {}; x.db.settings.service = { ...s, delivery: { paused: on }, pickup: { paused: false }, ...(on ? {} : { resumedAt: new Date(x.nowMs()).toISOString() }) }; };
  const run = async (restart, sig) => {
    const w = world({ start: "2026-10-14T07:55:00Z", settings: { hours: HOURS, service: OPEN_SERVICE } });
    const events = [{ t: utc("11:20:00"), fn: pauseDelivery(true) }, { t: utc("11:40:00"), fn: pauseDelivery(false) }];
    if (restart) events.push({ t: utc("09:00:10"), fn: (x) => x.restart() });
    const out = await play(w, { from: utc("07:55:00"), to: utc("14:30:00"), signals: sig, ticks: ticks47("07:55:47", "14:29:47"), events });
    return { w, out };
  };
  const closed = [{ t: utc("07:56:00"), via: "poll" }];
  const a = await run(false, closed), b = await run(true, closed);
  const WANT = ["10:25:47 manager", "11:10:47 manager", "11:55:47 manager", "12:40:47 manager", "13:25:47 manager", "14:10:47 manager"];
  assert.deepEqual(at(a.w, MGR), WANT, "control");
  assert.deepEqual(at(b.w, MGR), WANT, "with the restart: was 10:25, 11:10 then nothing until 14:05 (the round was wiped at 11:40:47)");
  assert.deepEqual(at(b.w, CASH1), at(a.w, CASH1), "no extra cashier round after the resume");
  assert.equal(b.out.find((x) => x.t === utc("11:40:47")).portal.cleared, undefined);
  /* t3b: الكاشير فتح ١١:٤٢ وساب البورتال قدامه ⇒ «رجع» للمدير في الحالتين */
  const sig = [{ t: utc("07:56:00"), via: "poll" }, ...polls("11:42:00", "12:30:00")];
  for (const restart of [false, true]) { const { w } = await run(restart, sig); assert.deepEqual(at(w, MGR, (l) => l.at <= utc("12:30:00")), ["10:25:47 manager", "11:10:47 manager", "11:44:47 back"], `restart ${restart}`); }
});

test("R2 minor — the afterMin grace after a boot no longer wipes an open round: nothing new is sent during it, then the same round carries on (the manager's reminder, not a fresh cashier round)", async () => {
  const w = world({ start: "2026-10-14T08:00:00Z", settings: { hours: HOURS, service: OPEN_SERVICE } });
  const blip = (x) => { x.db.settings.service = { delivery: { paused: true }, pickup: { paused: true } }; };
  const back = (x) => { x.db.settings.service = { ...OPEN_SERVICE, resumedAt: new Date(x.nowMs()).toISOString() }; };
  const out = await play(w, { from: utc("08:00:00"), to: utc("11:30:00"), signals: [], ticks: ticks47("08:00:47", "11:29:47"),
    events: [{ t: utc("10:40:10"), fn: blip }, { t: utc("10:40:30"), fn: back }, { t: utc("10:40:40"), fn: (x) => x.restart() }] });
  const g = out.find((x) => x.t === utc("10:40:47")).portal;
  assert.deepEqual([g.work, g.grace, g.cleared], [false, true, undefined], "boot inside the grace of a recorded resume: hold, keep the round");
  assert.ok(w.db.portal && w.db.portal.manager_told === true, "the round (manager told 10:25:47) survived");
  assert.deepEqual(at(w, CASH1, (l) => l.at > utc("10:00:00")), [], "was: a fresh cashier round at 10:50:47");
  assert.deepEqual(at(w, MGR), ["10:25:47 manager", "11:10:47 manager"]);
  assert.match(texts(w, MGR)[1], /^11:10:47 ⚠️ تذكير: بورتال الكاشير لسه مقفول/);
});

test("R2 minor — only what reached the phone counts: failed sends take nothing from the daily cap and are not «sent»; the ladder still moves (a cashier WhatsApp cannot reach must reach the manager), and his text says so; a failed manager message is not «told»", async () => {
  /* كل رسايل الكاشيرين بتفشل */
  const w = world({ start: "2026-10-14T08:00:00Z", fail: (ph) => ph === CASH1 || ph === CASH2 });
  await play(w, { from: utc("08:00:00"), to: utc("11:30:00"), signals: [], ticks: ticks47("08:00:47", "11:29:47") });
  assert.deepEqual(w.offLog().filter((l) => l.to === CASH1).map((l) => [hms(l.at), l.ok]), [["08:10:47", false], ["08:55:47", false], ["09:40:47", false]]);
  assert.deepEqual(texts(w, MGR), ["10:25:47 ⚠️ بورتال الكاشير مقفول من أول الشغل — ومش قادرين نوصل للكاشير على واتساب (3 محاولات). الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.",
    "11:10:47 ⚠️ تذكير: بورتال الكاشير لسه مقفول من أول الشغل. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم."], "was: «الكاشير اتبعتله 3 تنبيهات» with nothing delivered");
  const st = await w.team.portalStatus(T.teamConfig(w.db.settings), w.now());
  assert.deepEqual([st.sentToday, st.failedToday, st.alerts.count, st.alerts.delivered], [2, 6, 3, 0]);
  assert.deepEqual(st.recipients.map((r) => [r.name, r.today, r.capped]), [["منى", 0, false], ["سارة", 0, false], ["خالد", 2, false]], "failures use none of the cashiers' budget");
  /* كاشير واحد بس بيفشل ⇒ كل جولة وصلت لحد ⇒ «رغم 3 تنبيهات» */
  const one = world({ start: "2026-10-14T08:00:00Z", fail: (ph) => ph === CASH2 });
  await play(one, { from: utc("08:00:00"), to: utc("10:30:00"), signals: [], ticks: ticks47("08:00:47", "10:29:47") });
  assert.match(texts(one, MGR)[0], /^10:25:47 ⚠️ بورتال الكاشير مقفول من أول الشغل رغم 3 تنبيهات للكاشير\./);
  /* رسالة المدير فشلت ⇒ مش «اتبلّغ»: اللي بعدها مش «تذكير»، ومفيش «رجع» مستحقة */
  const mf = world({ start: "2026-10-14T08:00:00Z", fail: (ph, t) => ph === MGR && t < utc("11:00:00") });
  const out = await play(mf, { from: utc("08:00:00"), to: utc("12:00:00"), signals: polls("11:30:00", "12:00:00"), ticks: ticks47("08:00:47", "11:59:47") });
  assert.equal(out.find((x) => x.t === utc("10:25:47")).portal.manager.sent, 0);
  assert.deepEqual(at(mf, MGR), ["10:25:47 manager", "11:10:47 manager", "11:32:47 back"]);
  assert.match(texts(mf, MGR)[0], /^11:10:47 ⚠️ بورتال الكاشير مقفول من أول الشغل رغم 3 تنبيهات للكاشير\./, "the first message that arrived is the first, not a «reminder»");
  assertLimits(w); assertLimits(one); assertLimits(mf);
});

test("R2 minor — the database cannot be read: the tick says so in the log (once per 10 min) and the dashboard gets the card with an error and the read health, instead of nothing", async () => {
  const w = world({ start: "2026-10-14T15:00:00Z", failSql: /FROM portal_presence/ });
  assert.deepEqual((await w.team.tick()).portal, { skipped: "presence_db" });
  w.setNow(utc("15:01:00")); await w.team.tick();
  assert.equal(w.errors.filter((e) => /portal watch: presence_db/.test(e)).length, 1, "logged once, not every minute");
  assert.equal(w.errors.filter((e) => /presence read failed/.test(e)).length, 1);
  const st = await w.team.portalStatus(T.teamConfig(w.db.settings), w.now());
  assert.deepEqual([st.error, st.presence.readFailing, st.presence.readErrors >= 2, st.devices, st.afterMin], ["presence_db", true, true, [], 10]);
  const s2 = world({ start: "2026-10-14T15:00:00Z", failSql: /FROM wa_team_portal WHERE id='cashier'/ });
  assert.deepEqual((await s2.team.tick()).portal, { skipped: "state_db" });
  assert.equal((await s2.team.portalStatus(T.teamConfig(s2.db.settings), s2.now())).error, "state_db");
});

test("R2 minor — RG1-era presence rows (last_seen from on-screen polls only, no last_visible) get last_visible at boot: a deploy inside working hours does not tell the cashiers «مقفول من أول الشغل» for a portal seen minutes ago, and the dashboard says «مقفول من X», not «ماتفتحش»", async () => {
  const rg1 = [{ staff_id: "s1", device: "tab", role: "cashier", staff_name: "منى", last_seen: "2026-10-14T22:35:00.000Z" },
    { staff_id: "m1", device: "pc", role: "manager", staff_name: "خالد", last_seen: "2026-10-14T16:44:00.000Z" },
    { staff_id: "s2", device: "ph", role: "cashier", staff_name: "سارة", last_seen: "2026-10-14T22:50:00.000Z", seen_since: "2026-10-14T22:40:00.000Z", via: "api", last_visible: null, visible_since: null }];
  const w = world({ start: "2026-10-14T23:10:00Z", prePresence: rg1 });      // ٠٢:١٠ الرياض (خميس/جمعة لسه شغل لحد ٠٣:٠٠)
  await w.team.ready; await w.ho.ready;
  assert.equal(w.db.presence.get("s1|tab").last_visible, "2026-10-14T22:35:00.000Z", "RG1 row: last_visible = last_seen");
  assert.equal(w.db.presence.get("s2|ph").last_visible, null, "a PO1 background row (via set) is left alone");
  await play(w, { from: utc("23:11:00"), to: utc("23:11:00"), signals: [], ticks: [utc("23:11:00")] });
  assert.equal(texts(w, CASH1)[0], "23:11:00 ⚠️ البورتال مقفول من 36 دقيقة — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.", "was: «من أول الشغل»");
  const st = await w.team.portalStatus(T.teamConfig(w.db.settings), w.now());
  assert.deepEqual(st.devices.map((d) => [d.name, d.open, d.offMin]), [["سارة", false, 21], ["منى", false, 36], ["خالد", false, 387]], "a background-only device: «مقفول من 21 د» from its last request");
});
