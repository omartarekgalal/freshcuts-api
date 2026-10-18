/* RTG2 v2.1 (١٨/١٠) — لعبة الجري: الدخول إجباري (جلسة المتجر) والاسم مربوط بالجوال (game_players: أول مرة + تعديل واحد)،
   التوكن (٢٤ ساعة، مرة واحدة)، قواعد العلامة، الحدود، فلتر الاسم، اللوحة (جوال = صف بالاسم الحالي + الاستبعاد + الكاش، كل الوقت
   افتراضياً)، الأسبوع (السبت ٤ الفجر الرياض)، شاشة المالك (top + topWeek، جوال كامل/مقنّع)، PUT بالقصّ، المقفول ⇒ 503،
   أحداث الرحلة، track.game. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  register, gameCfg, GAME_DEFAULTS, GAME_LABELS, signToken, verifyToken, cleanFirstName, isProfane, flagReasons,
  leaderboardOf, weekStartOf, maskPhone, excludedPhones, LIMITS, percentileOf,
  orderIdentityValid, newChallengeCode, CHALLENGE_RE, CHALLENGE_ALPHABET,
} from "./game.js";
import * as J from "./journey.js";
import { sectionOf } from "./cms.js";
import { SERVER_OWNED_PATHS } from "./settings-guard.js";

const SECRET = "test-secret";
const T0 = Date.parse("2026-10-18T15:00:00Z");      // الأحد ١٨/١٠ ٦ المغرب الرياض

/* ═══ قاعدة بيانات وهمية: game_scores + game_players في الذاكرة + أسماء من الطلبات/نقطة البيع ═══ */
function fakeDb({ history = {}, pos = {}, orders = {} } = {}) {
  const rows = [];
  const players = new Map();
  const calls = [];
  let id = 0;
  const clock = { now: T0 };
  const pool = {
    query: async (sql, p = []) => {
      const s = String(sql);
      const tag = (s.match(/\/\*game:([a-z-]+)\*\//) || [])[1];
      calls.push(tag || s.slice(0, 30));
      if (/CREATE TABLE IF NOT EXISTS game_scores/.test(s)) return { rows: [] };
      if (/^UPDATE settings SET data = jsonb_set\(data, '\{game\}'/.test(s)) { pool.saved = JSON.parse(p[0]); return { rowCount: 1, rows: [] }; }
      switch (tag) {
        case "alltime": { const ok = rows.filter((r) => !r.flagged); return { rows: [{ n: ok.length, best: ok.reduce((m, r) => Math.max(m, r.score), 0) }] }; }
        case "insert": {
          if (rows.some((r) => r.run_id === p[0])) return { rowCount: 0, rows: [] };
          if (p[13] && (rows.some((r) => r.challenge_code === p[13]) || pool.forceCodeClash > 0)) {
            if (pool.forceCodeClash > 0) pool.forceCodeClash--;
            throw Object.assign(new Error("duplicate key value violates unique constraint \"game_scores_challenge_idx\""), { code: "23505", constraint: "game_scores_challenge_idx" });
          }
          const r = { id: ++id, challenge_code: p[13] || null, run_id: p[0], phone_norm: p[1], first_name: p[2], score: p[3], duration_ms: p[4], session_id: p[5], device_id: p[6], ip_hash: p[7], source: p[8], order_no: p[9], flagged: p[10], flag_reason: p[11], queued: p[12], created_at: new Date(clock.now) };
          rows.push(r); return { rowCount: 1, rows: [{ id: r.id, created_at: r.created_at }] };
        }
        case "top": {
          const from = p[0] ? Date.parse(p[0]) : null, ex = new Set(p[1] || []);
          return { rows: rows.filter((r) => !r.flagged && r.phone_norm && (from == null || r.created_at.getTime() >= from) && !ex.has(r.phone_norm))
            .map((r) => ({ ...r, player_name: players.get(r.phone_norm)?.first_name || null })) };
        }
        case "best": case "mybest": {
          const from = p[1] ? Date.parse(p[1]) : null;
          const m = rows.filter((r) => !r.flagged && r.phone_norm === p[0] && (from == null || r.created_at.getTime() >= from));
          if (tag === "mybest") return { rows: [{ best: m.length ? m.reduce((x, r) => Math.max(x, r.score), 0) : null }] };
          return { rows: [{ best: m.reduce((x, r) => Math.max(x, r.score), 0) }] };
        }
        case "player": { const x = players.get(p[0]); return { rows: x ? [{ ...x }] : [] }; }
        case "player-insert": {
          if (players.has(p[0])) return { rowCount: 0, rows: [] };
          players.set(p[0], { first_name: p[1], name_edits: 0 }); return { rowCount: 1, rows: [{ first_name: p[1], name_edits: 0 }] };
        }
        case "player-edit": {
          const x = players.get(p[0]);
          if (!x || x.name_edits !== 0) return { rowCount: 0, rows: [] };
          x.first_name = p[1]; x.name_edits += 1; return { rowCount: 1, rows: [{ ...x }] };
        }
        case "order": {
          const o = orders[p[0]];
          const paid = o && !["pending_payment", "expired", "rejected_refunded", "refund_failed", "paid_pos_failed"].includes(o.status || "paid");
          const week = o && clock.now - Date.parse(o.created_at || new Date(clock.now).toISOString()) < 7 * 86400_000;
          pool.lastOrderSql = s;
          return { rows: o && paid && !o.is_test && week ? [{ phone_norm: o.phone_norm, name: o.name, created_at: o.created_at || new Date(clock.now).toISOString(), done_at: o.done_at || null }] : [] };
        }
        case "dist": {
          const ex = new Set(p[0] || []), m = new Map();
          for (const r of rows) if (!r.flagged && r.phone_norm && !ex.has(r.phone_norm)) m.set(r.phone_norm, Math.max(m.get(r.phone_norm) || 0, r.score));
          return { rows: [...m].map(([phone_norm, best]) => ({ phone_norm, best })) };
        }
        case "mybestrun": {
          const m = rows.filter((r) => !r.flagged && r.phone_norm === p[0]).sort((a, b) => b.score - a.score || a.created_at - b.created_at)[0];
          return { rows: m ? [{ id: m.id, score: m.score, first_name: m.first_name, challenge_code: m.challenge_code }] : [] };
        }
        case "setcode": { const r = rows.find((x) => x.id === p[0]); if (!r || r.challenge_code) return { rows: [] }; r.challenge_code = p[1]; return { rows: [{ challenge_code: p[1] }] }; }
        case "getcode": { const r = rows.find((x) => x.id === p[0]); return { rows: r ? [{ challenge_code: r.challenge_code }] : [] }; }
        case "challenge": {
          const r = rows.find((x) => x.challenge_code === p[0]);
          return { rows: r ? [{ score: r.score, flagged: r.flagged, phone_norm: r.phone_norm, name: players.get(r.phone_norm)?.first_name || r.first_name }] : [] };
        }
        case "hist-order": return { rows: history[p[0]] ? [{ n: history[p[0]] }] : [] };
        case "hist-pos": return { rows: pos[p[0]] ? [{ n: pos[p[0]] }] : [] };
        case "stats": {
          const from = Date.parse(p[0]), today = Date.parse(p[1]);
          const w = rows.filter((r) => r.created_at.getTime() >= from);
          const ph = (xs) => new Set(xs.filter((r) => r.phone_norm).map((r) => r.phone_norm)).size;
          return { rows: [{ runs_today: w.filter((r) => r.created_at.getTime() >= today).length, runs_week: w.length,
            players_week: ph(w.filter((r) => !r.flagged)), flagged_week: w.filter((r) => r.flagged).length,
            named_week: ph(w.filter((r) => !r.flagged && r.first_name)), queued_week: w.filter((r) => r.queued).length, players: ph(rows.filter((r) => !r.flagged)) }] };
        }
        case "flagged": return { rows: rows.filter((r) => r.flagged).slice().reverse().slice(0, 20) };
        default: return { rows: [], rowCount: 0 };
      }
    },
  };
  return { pool, rows, players, calls, clock };
}

/* جلسات متجر وهمية: التوكن ⇒ الحساب */
const tokenOf = (pn) => "cust:" + (pn + "f".repeat(48)).slice(0, 48).replace(/[^a-f0-9]/g, "a");
function fakeAccounts(accts) {
  const byTok = new Map(Object.values(accts).map((a) => ["Bearer " + tokenOf(a.phone_norm), a]));
  return { customerOf: async (c) => byTok.get(c.req.header("Authorization") || "") || null };
}
const AUTH = (pn) => ({ Authorization: "Bearer " + tokenOf(pn) });

function build({ settings = {}, owner = true, accts = {}, db = fakeDb() } = {}) {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT") };
  const cfg = { settings };
  const ctx = {
    pool: db.pool, jb: JSON.stringify, getSettingsData: async () => cfg.settings, gameSecret: SECRET,
    requireAdmin: async (c) => (/^Bearer x$/.test(c.req.header("Authorization") || "") ? null : c.json({ error: "Unauthorized" }, 401)),
    isOwner: () => owner,
  };
  const accounts = fakeAccounts(accts);
  const api = register(app, ctx, { accounts: () => accounts, now: () => db.clock.now });
  const call = async (key, { body, headers = {}, query = {}, params = {} } = {}) => {
    const h = Object.fromEntries(Object.entries({ "cf-connecting-ip": "1.1.1.1", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
    const c = {
      req: { header: (n) => h[String(n).toLowerCase()], json: async () => { if (body === undefined) throw new Error("no body"); return body; }, query: (k) => query[k], param: (k) => params[k] },
      json: (b, status = 200) => ({ body: b, status }),
    };
    return routes[key](c);
  };
  const start = async (body = {}, headers = {}) => (await call("POST /api/game/start", { body, headers })).body;
  const score = (body, headers = {}) => call("POST /api/game/score", { body, headers });
  const setName = (pn, firstName) => call("POST /api/game/me", { body: { firstName }, headers: AUTH(pn) });
  return { routes, call, start, score, setName, db, api, cfg };
}
/* لاعب جاهز: حساب + اسم في اللعبة */
async function withPlayer(g, pn, name) { await g.setName(pn, name); return AUTH(pn); }
/* جولة: توكن، والساعة بتتقدّم مدة الجولة، وبعدين النتيجة */
async function play(g, { score = 100, durationMs = 20000, headers = {}, extra = {}, advance = durationMs + 500 } = {}) {
  const st = await g.start({}, headers);
  g.db.clock.now += advance;
  return g.score({ token: st.token, score, durationMs, ...extra }, headers);
}
const accts = (...pns) => Object.fromEntries(pns.map((x) => (Array.isArray(x) ? [x[0], { phone_norm: x[0], name: x[1] }] : [x, { phone_norm: x, name: null }])));

/* ═══ التوكن ═══ */
test("token: sign/verify round-trip; forged body or mac ⇒ null; older than 24 h or from the future ⇒ null", () => {
  const p = { r: "ab12cd34ef56ab12cd34ef56", t: T0, ih: "deadbeef", s: "play" };
  const tk = signToken(p, SECRET);
  assert.deepEqual(verifyToken(tk, SECRET, T0 + 1000), p);
  assert.equal(verifyToken(tk, "other-secret", T0), null, "another secret");
  const [body, mac] = tk.split(".");
  const forged = Buffer.from(JSON.stringify({ ...p, t: T0 + 999 })).toString("base64url");
  assert.equal(verifyToken(`${forged}.${mac}`, SECRET, T0), null, "body changed, old mac");
  assert.equal(verifyToken(`${body}.${mac.slice(0, -2)}xx`, SECRET, T0), null, "mac changed");
  assert.equal(verifyToken("garbage", SECRET, T0), null);
  assert.equal(verifyToken(null, SECRET, T0), null);
  assert.equal(LIMITS.tokenMaxAgeMs, 24 * 3600_000);
  assert.ok(verifyToken(tk, SECRET, T0 + 5 * 3600_000), "5 h later still fine (offline run sent when back online)");
  assert.ok(verifyToken(tk, SECRET, T0 + 24 * 3600_000 - 1000), "just inside 24 h");
  assert.equal(verifyToken(tk, SECRET, T0 + 24 * 3600_000 + 1), null, "expired");
  assert.equal(verifyToken(signToken({ ...p, t: T0 + 120_000 }, SECRET), SECRET, T0), null, "issued in the future");
  assert.equal(verifyToken(signToken({ ...p, r: "x" }, SECRET), SECRET, T0), null, "run id shape");
});

/* ═══ start + config ═══ */
test("start: no login ⇒ known false; login without a game name ⇒ known + suggested + named false; with a name ⇒ named true; config default all", async () => {
  const g = build({ accts: accts(["500000111", "محمد عبدالله"]) });
  let r = await g.start({ src: "track" });
  assert.equal(r.ok, true); assert.equal(r.enabled, true); assert.equal(r.maxScorePerSec, 60); assert.equal(r.period, "all");
  assert.deepEqual([r.known, r.firstName, r.named], [false, null, false]);
  const p = verifyToken(r.token, SECRET, T0);
  assert.equal(p.s, "track"); assert.equal(p.t, T0); assert.match(p.r, /^[a-f0-9]{24}$/); assert.equal(p.ih.length, 8);
  r = await g.start({}, AUTH("500000111"));
  assert.deepEqual([r.known, r.firstName, r.named], [true, "محمد", false], "suggested from the account");
  await g.setName("500000111", "Mido");
  r = await g.start({}, AUTH("500000111"));
  assert.deepEqual([r.known, r.firstName, r.named], [true, "Mido", true]);
  assert.deepEqual((await g.call("GET /api/game/config")).body, { ok: true, enabled: true, period: "all" });
  assert.equal(GAME_DEFAULTS.leaderboardPeriod, "all");
  const g2 = build({ settings: { game: { leaderboardPeriod: "week", maxScorePerSec: 80 } } });
  assert.deepEqual((await g2.call("GET /api/game/config")).body, { ok: true, enabled: true, period: "week" });
  assert.equal((await g2.start()).maxScorePerSec, 80);
});

/* ═══ /api/game/me ═══ */
test("me: login required; suggested from account → last web order → POS; first set free, one edit, then name_locked; bad_name; same name doesn't burn the edit", async () => {
  const db = fakeDb({ history: { "500000222": "Sara Ahmed" }, pos: { "500000333": "خالد العتيبي" } });
  const g = build({ db, accts: accts(["500000111", "محمد عبدالله"], "500000222", "500000333", ["500000444", "عميل"]) });
  let r = await g.call("GET /api/game/me");
  assert.deepEqual([r.status, r.body], [401, { ok: false, error: "login_required" }]);
  r = await g.call("POST /api/game/me", { body: { firstName: "Omar" } });
  assert.deepEqual([r.status, r.body.error], [401, "login_required"]);
  r = await g.call("GET /api/game/me", { headers: { Authorization: "Bearer cust:" + "9".repeat(48) } });
  assert.equal(r.status, 401, "unknown session");
  assert.deepEqual((await g.call("GET /api/game/me", { headers: AUTH("500000111") })).body, { ok: true, firstName: null, suggested: "محمد", canEdit: true, best: null });
  assert.equal((await g.call("GET /api/game/me", { headers: AUTH("500000222") })).body.suggested, "Sara", "account has no name ⇒ last web order");
  assert.equal((await g.call("GET /api/game/me", { headers: AUTH("500000333") })).body.suggested, "خالد", "⇒ POS record");
  assert.equal((await g.call("GET /api/game/me", { headers: AUTH("500000444") })).body.suggested, null, "«عميل» is not a name");
  // bad names
  for (const bad of ["", "شرموط", "omar123", "www.x.com", "a"]) {
    r = await g.setName("500000111", bad);
    assert.deepEqual([r.status, r.body], [400, { ok: false, error: "bad_name" }], bad);
  }
  assert.equal(g.db.players.size, 0);
  // first set (free), multi-word ⇒ first word
  r = await g.setName("500000111", "omar tarek");
  assert.deepEqual([r.status, r.body], [200, { ok: true, firstName: "Omar", canEdit: true }]);
  r = await g.setName("500000111", "Omar");
  assert.deepEqual(r.body, { ok: true, firstName: "Omar", canEdit: true }, "same name: no edit used");
  // one edit
  r = await g.setName("500000111", "محمد");
  assert.deepEqual(r.body, { ok: true, firstName: "محمد", canEdit: false });
  assert.deepEqual(g.db.players.get("500000111"), { first_name: "محمد", name_edits: 1 });
  r = await g.setName("500000111", "Mido");
  assert.deepEqual([r.status, r.body], [403, { ok: false, error: "name_locked" }]);
  assert.equal(g.db.players.get("500000111").first_name, "محمد");
  r = await g.setName("500000111", "محمد");
  assert.deepEqual(r.body, { ok: true, firstName: "محمد", canEdit: false }, "re-sending the current name is fine after the lock");
  const me = (await g.call("GET /api/game/me", { headers: AUTH("500000111") })).body;
  assert.deepEqual([me.firstName, me.canEdit, me.best], ["محمد", false, null]);
});

test("me.best: this phone's best clean all-time score (flagged ignored, other weeks count)", async () => {
  const g = build({ accts: accts("500000111") });
  const H = await withPlayer(g, "500000111", "Omar");
  await play(g, { headers: H, score: 300, durationMs: 20_000 });
  g.db.clock.now += 9 * 86400_000;      // next week
  await play(g, { headers: H, score: 200, durationMs: 20_000 });
  await play(g, { headers: H, score: 9000, durationMs: 5_000 });       // flagged
  assert.equal((await g.call("GET /api/game/me", { headers: H })).body.best, 300);
});

/* ═══ score: الدخول والاسم ═══ */
test("score: no login ⇒ 401 login_required, no name ⇒ 409 name_required — token NOT consumed, same run goes through afterwards", async () => {
  const g = build({ accts: accts("500000111") });
  const st = await g.start();
  g.db.clock.now += 20_500;
  const run = { token: st.token, score: 120, durationMs: 20_000 };
  let r = await g.score(run);
  assert.deepEqual([r.status, r.body], [401, { ok: false, error: "login_required" }]);
  r = await g.score(run, { Authorization: "Bearer cust:" + "9".repeat(48) });
  assert.equal(r.status, 401, "expired / unknown session");
  r = await g.score(run, AUTH("500000111"));
  assert.deepEqual([r.status, r.body], [409, { ok: false, error: "name_required" }]);
  assert.equal(g.db.rows.length, 0);
  await g.setName("500000111", "Omar");
  r = await g.score(run, AUTH("500000111"));
  assert.deepEqual([r.status, r.body.saved, r.body.firstName, r.body.rank, r.body.best], [200, true, "Omar", 1, 120]);
  assert.equal(g.db.rows[0].phone_norm, "500000111");
});

test("score: typed firstName and ord in the body are ignored; phone from the session, name from game_players; queued stored", async () => {
  const g = build({ accts: accts("500000111") });
  const H = await withPlayer(g, "500000111", "Omar");
  let r = await play(g, { headers: H, extra: { firstName: "Hacker", ord: "W1792400000001", queued: true } });
  assert.equal(r.body.firstName, "Omar");
  assert.equal(r.body.nameRejected, undefined);
  assert.deepEqual([g.db.rows[0].phone_norm, g.db.rows[0].first_name, g.db.rows[0].order_no, g.db.rows[0].queued], ["500000111", "Omar", null, true]);
  r = await play(g, { headers: H, extra: { queued: "yes" } });
  assert.equal(g.db.rows[1].queued, null, "only queued:true counts");
});

test("score: forged / expired (24 h) / reused token ⇒ 400 bad_token and nothing saved (or saved once)", async () => {
  const g = build({ accts: accts("500000111") });
  const H = await withPlayer(g, "500000111", "Omar");
  const st = await g.start({}, H);
  const [b, m] = st.token.split(".");
  let r = await g.score({ token: `${b}.${m.slice(0, -3)}abc`, score: 10, durationMs: 5000 }, H);
  assert.deepEqual([r.status, r.body.error], [400, "bad_token"]);
  assert.equal(g.db.rows.length, 0);
  g.db.clock.now += 24 * 3600_000 + 5000;
  r = await g.score({ token: st.token, score: 10, durationMs: 5000 }, H);
  assert.deepEqual([r.status, r.body.error], [400, "bad_token"], "expired");
  assert.equal(g.db.rows.length, 0);
  const st2 = await g.start({}, H);
  g.db.clock.now += 10_000;
  r = await g.score({ token: st2.token, score: 50, durationMs: 9000 }, H);
  assert.equal(r.body.saved, true);
  r = await g.score({ token: st2.token, score: 60, durationMs: 9500 }, H);
  assert.deepEqual([r.status, r.body.error], [400, "bad_token"], "reused");
  assert.equal(g.db.rows.length, 1);
});

test("score: an offline run (token prefetched, sent 6 h later, queued:true) is accepted; the wall-time check is unchanged", async () => {
  const g = build({ accts: accts("500000111") });
  const H = await withPlayer(g, "500000111", "Omar");
  const st = await g.start({}, H);
  g.db.clock.now += 6 * 3600_000;
  const r = await g.score({ token: st.token, score: 900, durationMs: 60_000, queued: true }, H);
  assert.deepEqual([r.body.saved, r.body.rank], [true, 1]);
  assert.deepEqual([g.db.rows[0].flagged, g.db.rows[0].queued], [false, true]);
  // a run claiming longer than the time since the token ⇒ still flagged
  const st2 = await g.start({}, H);
  g.db.clock.now += 10_000;
  await g.score({ token: st2.token, score: 100, durationMs: 60_000 }, H);
  assert.equal(g.db.rows[1].flag_reason, "duration_gt_wall");
});

test("score: bad numbers ⇒ 400 bad_score (non-integer, negative, too big)", async () => {
  const g = build({ accts: accts("500000111") });
  const H = await withPlayer(g, "500000111", "Omar");
  for (const [score, durationMs] of [[1.5, 5000], [-1, 5000], [1_000_001, 5000], [10, -1], [10, 7_200_001], ["10", 5000], [10, null]]) {
    const st = await g.start({}, H);
    const r = await g.score({ token: st.token, score, durationMs }, H);
    assert.deepEqual([r.status, r.body.error], [400, "bad_score"], JSON.stringify([score, durationMs]));
  }
  assert.equal(g.db.rows.length, 0);
});

/* ═══ قواعد العلامة ═══ */
test("flagReasons (pure): each rule on its own", () => {
  const base = { issuedAt: T0, now: T0 + 30_000, maxScorePerSec: 45, allTimeBest: 0, allTimeRuns: 0 };
  assert.deepEqual(flagReasons({ ...base, score: 500, durationMs: 25_000 }), []);
  assert.deepEqual(flagReasons({ ...base, score: 100, durationMs: 33_001 }), ["duration_gt_wall"]);
  assert.deepEqual(flagReasons({ ...base, score: 100, durationMs: 33_000 }), [], "3 s slack");
  assert.deepEqual(flagReasons({ ...base, score: 45 * 10 + 51, durationMs: 10_000 }), ["score_rate"]);
  assert.deepEqual(flagReasons({ ...base, score: 45 * 10 + 50, durationMs: 10_000 }), []);
  assert.deepEqual(flagReasons({ ...base, score: 1, durationMs: 1499 }), ["too_short"]);
  assert.deepEqual(flagReasons({ ...base, score: 0, durationMs: 200 }), [], "zero score in a short run is fine");
  assert.deepEqual(flagReasons({ ...base, score: 301, durationMs: 20_000, allTimeBest: 100, allTimeRuns: 20 }), ["outlier"]);
  assert.deepEqual(flagReasons({ ...base, score: 301, durationMs: 20_000, allTimeBest: 100, allTimeRuns: 19 }), [], "needs 20 runs");
});

test("score: flagged runs are saved with the reason, answer looks normal (saved, rank null), never on the board", async () => {
  const g = build({ accts: accts("500000111") });
  const H = await withPlayer(g, "500000111", "Omar");
  let r = await play(g, { headers: H, score: 5000, durationMs: 10_000 });
  assert.equal(r.status, 200); assert.equal(r.body.saved, true); assert.equal(r.body.rank, null);
  assert.equal(r.body.best, 5000, "the cheater sees his own number");
  assert.deepEqual([g.db.rows[0].flagged, g.db.rows[0].flag_reason], [true, "score_rate"]);
  r = await play(g, { headers: H, score: 100, durationMs: 60_000, advance: 10_000 });
  assert.equal(g.db.rows[1].flag_reason, "duration_gt_wall"); assert.equal(r.body.rank, null);
  await play(g, { headers: H, score: 5, durationMs: 1000 });
  assert.equal(g.db.rows[2].flag_reason, "too_short");
  assert.deepEqual((await g.call("GET /api/game/leaderboard")).body.top, [], "flagged rows never appear");
});

test("score: outlier = more than 3× the best clean score once there are ≥ 20 clean runs", async () => {
  const pns = Array.from({ length: 22 }, (_, i) => String(510000000 + i));
  const g = build({ accts: accts(...pns) });
  for (let i = 0; i < 20; i++) await play(g, { headers: await withPlayer(g, pns[i], "Player"), score: 80 + i, durationMs: 20_000 });
  const r = await play(g, { headers: await withPlayer(g, pns[20], "Cheat"), score: 400, durationMs: 20_000 });   // within the rate but > 3×99
  assert.equal(r.body.rank, null);
  assert.deepEqual([g.db.rows.at(-1).flagged, g.db.rows.at(-1).flag_reason], [true, "outlier"]);
  const ok = await play(g, { headers: await withPlayer(g, pns[21], "Good"), score: 290, durationMs: 20_000 });
  assert.equal(ok.body.rank, 1); assert.equal(g.db.rows.at(-1).flagged, false);
});

/* ═══ الحدود ═══ */
test("rate limits: 60 starts/h per IP, 30 scores/h per IP, 20 scores/h per session and per phone, 20 name writes/h; the hour resets", async () => {
  const pns = Array.from({ length: 40 }, (_, i) => String(520000000 + i));
  const g = build({ accts: accts(...pns) });
  for (let i = 0; i < 60; i++) assert.equal((await g.start()).ok, true);
  let r = await g.call("POST /api/game/start", { body: {} });
  assert.deepEqual([r.status, r.body.error], [429, "rate_limited"]);
  assert.equal((await g.call("POST /api/game/start", { body: {}, headers: { "cf-connecting-ip": "2.2.2.2" } })).status, 200, "another IP is fine");
  // per IP (counts before auth — also stops login_required spam)
  for (let i = 0; i < 30; i++) assert.notEqual((await g.score({ token: "x.y", score: 1, durationMs: 1 }, { "cf-connecting-ip": "3.3.3.3" })).status, 429);
  r = await g.score({ token: "x.y", score: 1, durationMs: 1 }, { "cf-connecting-ip": "3.3.3.3" });
  assert.deepEqual([r.status, r.body.error], [429, "rate_limited"]);
  // per session across IPs
  for (let i = 0; i < 20; i++) assert.notEqual((await g.score({ token: "x.y", score: 1, durationMs: 1, sid: "s1abcdef99" }, { "cf-connecting-ip": "9.9.9." + i })).status, 429);
  assert.equal((await g.score({ token: "x.y", score: 1, durationMs: 1, sid: "s1abcdef99" }, { "cf-connecting-ip": "9.9.8.1" })).status, 429);
  // per phone across IPs and sessions
  const H = await withPlayer(g, pns[0], "Omar");
  for (let i = 0; i < 20; i++) assert.notEqual((await g.score({ token: "x.y", score: 1, durationMs: 1 }, { ...H, "cf-connecting-ip": "8.8.8." + i })).status, 429);
  assert.equal((await g.score({ token: "x.y", score: 1, durationMs: 1 }, { ...H, "cf-connecting-ip": "8.8.7.1" })).status, 429);
  // name writes
  for (let i = 0; i < 19; i++) assert.notEqual((await g.setName(pns[0], "Omar")).status, 429);
  assert.equal((await g.setName(pns[0], "Omar")).status, 429);
  g.db.clock.now += 3600_001;
  assert.equal((await g.call("POST /api/game/start", { body: {} })).status, 200, "next hour");
});

/* ═══ فلتر الاسم ═══ */
test("name filter: first word, 2–20 letters, Arabic/Latin; insults, digits, URLs, @ rejected", () => {
  assert.deepEqual(cleanFirstName("محمد"), { name: "محمد", rejected: false });
  assert.deepEqual(cleanFirstName("Omar"), { name: "Omar", rejected: false });
  assert.deepEqual(cleanFirstName("OMAR"), { name: "Omar", rejected: false });
  assert.deepEqual(cleanFirstName("عبدالله محمد السعيد"), { name: "عبدالله", rejected: false }, "multi-word ⇒ first word");
  assert.deepEqual(cleanFirstName("مُحَمَّد"), { name: "محمد", rejected: false }, "tashkeel dropped");
  assert.deepEqual(cleanFirstName("عز بركات"), { name: "عز", rejected: false }, "no false hit across word boundaries");
  assert.deepEqual(cleanFirstName(""), { name: null, rejected: false });
  assert.deepEqual(cleanFirstName(null), { name: null, rejected: false });
  for (const bad of ["شرموط", "يا قحبة", "كلب", "منيوك", "Fuck", "fuuuck you", "BITCH", "ass", "sh1t", "omar123", "٠٥٥٥", "www.site.com", "x@y", "https://a.b", "t.me/xx", "a", "abcdefghijklmnopqrstu", "🙂🙂", "$$$"]) {
    assert.equal(cleanFirstName(bad).name, null, bad);
    assert.equal(cleanFirstName(bad).rejected, true, bad);
  }
  for (const okName of ["كساب", "Cassidy", "Hassan", "Abbas", "نورة", "Glass", "خالد", "Dickson"]) assert.equal(isProfane(okName), false, okName);
});

/* ═══ اللوحة ═══ */
test("leaderboardOf (pure): one row per phone (best, earliest on ties), CURRENT player name, no-phone rows ineligible, excluded + flagged out, ≤ 10", () => {
  const at = (m) => new Date(T0 + m * 1000).toISOString();
  const rows = [
    { run_id: "r1", phone_norm: "500000001", first_name: "Old", player_name: "محمد", score: 300, created_at: at(1) },
    { run_id: "r2", phone_norm: "500000001", first_name: "Old", player_name: "محمد", score: 500, created_at: at(2) },
    { run_id: "r3", phone_norm: "500000002", first_name: "Ali", player_name: "Ali", score: 500, created_at: at(1) },
    { run_id: "r4", device_id: "devA", first_name: "Guest", score: 9000, created_at: at(1) },
    { run_id: "r5", phone_norm: "599999999", first_name: "Staff", player_name: "Staff", score: 9999, created_at: at(1) },
    { run_id: "r6", phone_norm: "500000003", first_name: "Cheat", score: 8000, created_at: at(1), flagged: true },
    { run_id: "r7", phone_norm: "500000004", first_name: "Lina", player_name: null, score: 50, created_at: at(1) },
  ];
  const top = leaderboardOf(rows, { exclude: new Set(["599999999"]) });
  assert.deepEqual(top.map((r) => [r.rank, r.firstName, r.score, r.runId, r.runs, r.phone]), [
    [1, "Ali", 500, "r3", 1, "500000002"],          // tie at 500 ⇒ the earlier run
    [2, "محمد", 500, "r2", 2, "500000001"],         // the current game name, not the one stored on the run
    [3, "Lina", 50, "r7", 1, "500000004"],          // no game_players row ⇒ name on the run
  ]);
  const many = Array.from({ length: 15 }, (_, i) => ({ run_id: "m" + i, phone_norm: String(530000000 + i), player_name: "P", score: i, created_at: at(i) }));
  assert.equal(leaderboardOf(many).length, 10);
});

test("leaderboard route: all-time by default, public shape only, staff + bot test phones out, noAds customers in, name edit shows at once, 30 s cache", async () => {
  const settings = {
    waBot: { testPhones: ["0500000999"] },
    cms: { phoneLists: { migratedAt: "2026-10-15", staffPhones: [{ phone: "0500000888", reason: "employee" }], noAdsPhones: [{ phone: "0500000777", reason: "ads_request" }] } },
  };
  const db = fakeDb();
  const g = build({ settings, db, accts: accts("500000999", "500000888", "500000777", "500000666") });
  assert.ok(excludedPhones(settings).has("500000999") && excludedPhones(settings).has("500000888") && !excludedPhones(settings).has("500000777"));
  // an old v1 row without a phone (migration) never ranks
  db.rows.push({ id: 999, run_id: "old1", phone_norm: null, first_name: "Guest", score: 99999, duration_ms: 60000, flagged: false, created_at: new Date(T0 - 86400_000) });
  for (const [pn, name, score] of [["500000999", "Tester", 900], ["500000888", "Staff", 800], ["500000777", "Noads", 300], ["500000666", "Real", 200], ["500000666", "Real", 250]]) {
    await play(g, { headers: await withPlayer(g, pn, name), score, durationMs: 25_000 });
  }
  let r = (await g.call("GET /api/game/leaderboard")).body;
  assert.deepEqual([r.ok, r.period, r.from], [true, "all", null]);
  assert.deepEqual(r.top, [{ rank: 1, firstName: "Noads", score: 300 }, { rank: 2, firstName: "Real", score: 250 }]);
  assert.ok(!JSON.stringify(r).includes("50000"), "no phone in the public board");
  // cache: a plain GET within 30 s does not query
  const n0 = db.calls.filter((t) => t === "top").length;
  await g.call("GET /api/game/leaderboard"); await g.call("GET /api/game/leaderboard");
  assert.equal(db.calls.filter((t) => t === "top").length, n0);
  // the one allowed edit busts the cache ⇒ the new name everywhere at once
  await g.setName("500000666", "Rami");
  r = (await g.call("GET /api/game/leaderboard")).body;
  assert.equal(r.top[1].firstName, "Rami");
  const n1 = db.calls.filter((t) => t === "top").length;
  db.clock.now += 31_000;
  await g.call("GET /api/game/leaderboard");
  assert.equal(db.calls.filter((t) => t === "top").length, n1 + 1, "refreshed after 30 s");
  // week period
  const wk = (await g.call("GET /api/game/leaderboard", { query: { period: "week" } })).body;
  assert.deepEqual([wk.period, wk.from, wk.top.length], ["week", "2026-10-17T01:00:00.000Z", 2]);
  assert.equal((await g.call("GET /api/game/leaderboard", { query: { period: "month" } })).body.period, "all", "invalid ⇒ the setting");
});

test("score response: rank in the current top 10 (all-time default) + best; a worse run ⇒ rank null; week setting resets weekly", async () => {
  const g = build({ accts: accts("500000111", "500000222") });
  const A = await withPlayer(g, "500000111", "Omar"), B = await withPlayer(g, "500000222", "Lina");
  let r = await play(g, { headers: A, score: 200, durationMs: 20_000 });
  assert.deepEqual([r.body.rank, r.body.best, r.body.firstName], [1, 200, "Omar"]);
  r = await play(g, { headers: A, score: 150, durationMs: 20_000 });
  assert.deepEqual([r.body.rank, r.body.best], [null, 200], "a worse run is not the one on the board");
  r = await play(g, { headers: B, score: 300, durationMs: 20_000 });
  assert.equal(r.body.rank, 1);
  g.db.clock.now = Date.parse("2026-10-24T01:00:00Z") + 1000;
  r = await play(g, { headers: A, score: 120, durationMs: 20_000 });
  assert.deepEqual([r.body.rank, r.body.best], [null, 200], "all-time: last week still counts");
  g.cfg.settings = { game: { leaderboardPeriod: "week" } };
  r = await play(g, { headers: A, score: 110, durationMs: 20_000 });
  assert.deepEqual([r.body.rank, r.body.best], [null, 120], "week: best restarts on Saturday 04:00 (200 is last week); 110 < 120 isn't the shown run");
  r = await play(g, { headers: A, score: 130, durationMs: 20_000 });
  assert.deepEqual([r.body.rank, r.body.best], [1, 130], "week: Lina's 300 was last week ⇒ Omar is #1 this week");
});

test("week start: latest Saturday 04:00 Riyadh (01:00 UTC); before 04:00 Saturday it is still last week", () => {
  const ws = (iso) => weekStartOf(new Date(iso)).toISOString();
  assert.equal(ws("2026-10-18T15:00:00Z"), "2026-10-17T01:00:00.000Z");   // Sunday
  assert.equal(ws("2026-10-17T01:00:00Z"), "2026-10-17T01:00:00.000Z");   // Saturday 04:00 exactly
  assert.equal(ws("2026-10-17T00:59:59Z"), "2026-10-10T01:00:00.000Z");   // Saturday 03:59 Riyadh ⇒ previous week
  assert.equal(ws("2026-10-23T22:00:00Z"), "2026-10-17T01:00:00.000Z");   // Saturday 01:00 Riyadh (Friday night shift)
  assert.equal(ws("2026-10-24T02:00:00Z"), "2026-10-24T01:00:00.000Z");
  assert.equal(ws("2027-01-01T12:00:00Z"), "2026-12-26T01:00:00.000Z");   // across the year
  assert.equal(weekStartOf(new Date("2026-10-18T15:00:00Z"), 0).toISOString(), "2026-10-18T01:00:00.000Z", "reportWeekStart = Sunday");
});

/* ═══ المالك ═══ */
test("cms GET: top (configured = all-time) + topWeek, stats incl. players + queuedWeek, flagged; full phone for the owner only", async () => {
  const db = fakeDb();
  const A = ["512341234", "Faisal"], B = ["512345678", "Noor"];
  const mk = (owner) => build({ db, owner, accts: accts(A[0], B[0], "512340000") });
  const g = mk(true);
  const HA = await withPlayer(g, A[0], A[1]), HB = await withPlayer(g, B[0], B[1]), HC = await withPlayer(g, "512340000", "Bad");
  g.db.clock.now -= 7 * 86400_000;      // last week: B scores big
  await play(g, { headers: HB, score: 800, durationMs: 25_000 });
  g.db.clock.now = T0;
  await play(g, { headers: HA, score: 400, durationMs: 25_000 });
  await play(g, { headers: HA, score: 350, durationMs: 25_000, extra: { queued: true } });
  await play(g, { headers: HC, score: 9000, durationMs: 5_000 });
  const AUTHX = { Authorization: "Bearer x" };
  assert.equal((await g.call("GET /api/cms/game")).status, 401);
  const r = (await g.call("GET /api/cms/game", { headers: AUTHX })).body;
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, GAME_DEFAULTS); assert.deepEqual(r.defaults, GAME_DEFAULTS);
  assert.equal(r.labels.leaderboardPeriod, "لوحة الأبطال: كل الوقت ولا الأسبوع ده"); assert.equal(r.labels.enabled, GAME_LABELS.enabled);
  assert.deepEqual(r.week, { from: "2026-10-17T01:00:00.000Z", to: "2026-10-24T01:00:00.000Z" });
  const shape = (x) => [x.rank, x.firstName, x.score, x.phone, x.phoneKnown, x.runs, x.durationMs];
  assert.deepEqual(r.top.map(shape), [[1, "Noor", 800, "0512345678", true, 1, 25_000], [2, "Faisal", 400, "0512341234", true, 2, 25_000]]);
  assert.deepEqual(r.topWeek.map(shape), [[1, "Faisal", 400, "0512341234", true, 2, 25_000]]);
  assert.ok(r.top[0].bestAt);
  assert.deepEqual(r.stats, { runsToday: 3, runsWeek: 3, playersWeek: 1, flaggedWeek: 1, namedWeek: 1, players: 2, queuedWeek: 1 });
  assert.equal(r.flagged.length, 1);
  assert.deepEqual(Object.keys(r.flagged[0]).sort(), ["createdAt", "durationMs", "firstName", "id", "reason", "score"]);
  assert.deepEqual([r.flagged[0].firstName, r.flagged[0].score, r.flagged[0].reason], ["Bad", 9000, "score_rate"]);
  const m = (await mk(false).call("GET /api/cms/game", { headers: AUTHX })).body;
  assert.equal(m.top[0].phone, "05••••5678"); assert.equal(m.topWeek[0].phone, "05••••1234"); assert.equal(maskPhone("512341234"), "05••••1234");
  // configured week ⇒ top = the week too
  const w = build({ db, settings: { game: { leaderboardPeriod: "week" } } });
  assert.deepEqual((await w.call("GET /api/cms/game", { headers: AUTHX })).body.top.map((x) => x.firstName), ["Faisal"]);
});

test("cms PUT: clamps and saves under {game} (bad period ⇒ all); board cache cleared", async () => {
  const g = build();
  const AUTHX = { Authorization: "Bearer x" };
  let r = await g.call("PUT /api/cms/game", { body: { enabled: false, leaderboardPeriod: "week", maxScorePerSec: 9999, junk: 1 }, headers: AUTHX });
  assert.deepEqual(r.body, { ok: true, config: { enabled: false, leaderboardPeriod: "week", maxScorePerSec: 500 } });
  assert.deepEqual(g.db.pool.saved, { enabled: false, leaderboardPeriod: "week", maxScorePerSec: 500 });
  r = await g.call("PUT /api/cms/game", { body: { enabled: "yes", leaderboardPeriod: "month", maxScorePerSec: 2 }, headers: AUTHX });
  assert.deepEqual(r.body.config, { enabled: true, leaderboardPeriod: "all", maxScorePerSec: 10 });
  assert.equal((await g.call("PUT /api/cms/game", { body: {} })).status, 401);
  assert.deepEqual(gameCfg({}), GAME_DEFAULTS);
  assert.deepEqual(gameCfg({ game: { maxScorePerSec: "abc" } }).maxScorePerSec, 60);
  assert.equal(GAME_DEFAULTS.maxScorePerSec, 60, "v2.2: power-ups ⇒ legit max ≈ 48.5/s");
});

test("disabled ⇒ config enabled:false, start + score 503 disabled; the board still answers", async () => {
  const g = build({ settings: { game: { enabled: false } }, accts: accts("500000111") });
  assert.deepEqual((await g.call("GET /api/game/config")).body, { ok: true, enabled: false, period: "all" });
  let r = await g.call("POST /api/game/start", { body: {} });
  assert.deepEqual([r.status, r.body], [503, { ok: false, error: "disabled" }]);
  r = await g.score({ token: "a.b", score: 1, durationMs: 5000 });
  assert.deepEqual([r.status, r.body.error], [503, "disabled"]);
  assert.equal((await g.call("GET /api/game/leaderboard")).body.ok, true);
  g.cfg.settings = {};
  const H = await withPlayer(g, "500000111", "Omar");
  const st = await g.start({}, H);
  g.cfg.settings = { game: { enabled: false } };
  assert.equal((await g.score({ token: st.token, score: 10, durationMs: 5000 }, H)).status, 503, "turned off mid-run");
});

test("wiring: /api/cms/game is a growth route; settings.game is server-owned", () => {
  assert.equal(sectionOf("/api/cms/game"), "growth");
  assert.equal(sectionOf("/api/cms/openwait"), "growth");
  assert.ok(SERVER_OWNED_PATHS.includes("game"));
  assert.equal(LIMITS.topN, 10);
});

/* ═══ الرحلة ═══ */
test("journey: game_play / game_over / game_leaderboard_view accepted with their props; unknown game_* rejected; no session stamp, no funnel step", () => {
  const now = Date.now();
  const p = J.parseBatch(JSON.stringify({ v: 1, sessionId: "s1abc2def3", anonId: "d1abc2def3", events: [
    { n: "game_play", t: now, seq: 1, path: "/play", p: { src: "play" } },
    { n: "game_over", t: now, seq: 2, path: "/track/W1792500000001", p: { score: 1234, ms: 45678, src: "track" } },
    { n: "game_leaderboard_view", t: now, seq: 3, path: "/play", p: { period: "all", src: "play" } },
    { n: "game_cheat", t: now, seq: 4, p: {} },
  ] }), { now });
  assert.deepEqual(p.events.map((e) => e.name), ["game_play", "game_over", "game_leaderboard_view"]);
  assert.deepEqual(p.rejected, { unknown: 1 });
  assert.deepEqual(p.events[0].props, { src: "play" });
  assert.deepEqual(p.events[1].props, { score: 1234, ms: 45678, src: "track" });
  assert.deepEqual(p.events[2].props, { period: "all", src: "play" });
  assert.equal(p.events[1].path, "/track/:order");
  for (const e of p.events) { assert.equal(e.step, null); assert.equal(J.stampsSession(e.name), false); }
  assert.deepEqual(J.GAME_EVENTS, ["game_play", "game_over", "game_leaderboard_view", "game_share", "game_challenge_open"]);
  const q = J.parseBatch(JSON.stringify({ v: 1, sessionId: "s1abc2def3", anonId: "d1abc2def3", events: [
    { n: "game_share", t: now, seq: 1, path: "/play", p: { via: "wa", src: "play" } },
    { n: "game_challenge_open", t: now, seq: 2, path: "/play", p: { src: "play" } } ] }), { now });
  assert.deepEqual(q.events.map((e) => [e.name, e.props, e.step]), [["game_share", { via: "wa", src: "play" }, null], ["game_challenge_open", { src: "play" }, null]]);
  for (const n of J.GAME_EVENTS) { assert.ok(J.WEB_EVENTS.includes(n)); assert.ok(J.GAME_EVENT_LABELS[n]); }
  assert.equal(J.stampsSession("order_created"), true, "checkout events still stamp");
});

/* ═══ صفحة التتبّع: track.game ═══ */
test("track: game true by default, false when the owner turns the game off", async () => {
  const { register: registerShop } = await import("./shop.js");
  const NO = "W1792400000099";
  const run = async (settings) => {
    const routes = {};
    const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
    const app = { get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
    const pool = { query: async (sql) => (/^SELECT \* FROM shop_orders WHERE order_no=\$1/.test(String(sql))
      ? { rows: [{ order_no: NO, status: "paid", option: "delivery", phone_norm: "500000001", total: "79", subtotal: "76", delivery_fee: "3", created_at: new Date().toISOString() }] }
      : { rows: [], rowCount: 0 }) };
    process.env.SHOP_SWEEP_SECONDS = "0";
    registerShop(app, { pool, requireAdmin: async () => null, requireCashierOrAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: (p) => String(p || "").replace(/\D/g, "").slice(-9) }, {
      pay: { configured: () => false }, delivery: { quote: async () => ({}), shipmentOf: async () => null, cancelShipment: async () => null, dispatchGate: async () => ({ mode: "manual" }), canAutoDispatch: async () => false },
      emitOrder: () => {}, journey: () => ({ emit: () => {} }) });
    return (await routes["GET /api/shop/track/:orderNo"]({ req: { param: () => NO, header: () => undefined, query: () => undefined }, json: (body, status = 200) => ({ body, status }) })).body;
  };
  const on = await run({});
  assert.equal(on.ok, true); assert.equal(on.game, true);
  const off = await run({ game: { enabled: false } });
  assert.equal(off.ok, true); assert.equal(off.game, false);
});

/* ═══ v2.2: هوية صامتة من رقم الطلب (صفحة التتبّع) ═══ */
const ORD = "W1792400000501";
const orderDb = () => fakeDb({ orders: {
  [ORD]: { phone_norm: "500000555", name: "Faisal Al-Harbi", status: "paid", created_at: new Date(T0 - 3600_000).toISOString() },
  W1792400000502: { phone_norm: "500000556", name: "Old Order", status: "delivered", created_at: new Date(T0 - 49 * 3600_000).toISOString() },
  W1792400000503: { phone_norm: "500000557", name: "Unpaid", status: "pending_payment", created_at: new Date(T0).toISOString() },
  W1792400000504: { phone_norm: "500000558", name: "Tester", status: "paid", is_test: true, created_at: new Date(T0).toISOString() },
  W1792400000505: { phone_norm: "500000559", name: "عميل", status: "paid", created_at: new Date(T0).toISOString() },
  W1792400000506: { phone_norm: "500000111", name: "Other Name", status: "paid", created_at: new Date(T0).toISOString() },
} });

test("order identity: paid order < 48 h ⇒ start/me/score as that phone; name auto-created from the order (edits 0); order_no stored; no phone returned", async () => {
  const g = build({ db: orderDb() });
  const st = await g.start({ ord: ORD });
  assert.deepEqual([st.known, st.firstName, st.named], [true, "Faisal", true]);
  assert.deepEqual(g.db.players.get("500000555"), { first_name: "Faisal", name_edits: 0 });
  const me = await g.call("GET /api/game/me", { query: { ord: ORD } });
  assert.deepEqual(me.body, { ok: true, firstName: "Faisal", suggested: "Faisal", canEdit: false, best: null });
  assert.ok(!JSON.stringify(me.body).includes("500000555") && !JSON.stringify(st).includes("500000555"), "never the phone");
  g.db.clock.now += 20_500;
  const r = await g.score({ token: st.token, score: 300, durationMs: 20_000, ord: ORD, nearMiss: 3, powerups: 2 });
  assert.deepEqual([r.status, r.body.saved, r.body.firstName, r.body.rank, r.body.best], [200, true, "Faisal", 1, 300]);
  assert.ok(!JSON.stringify(r.body).includes("500000555"));
  assert.deepEqual([g.db.rows[0].phone_norm, g.db.rows[0].order_no, g.db.rows[0].first_name], ["500000555", ORD, "Faisal"]);
  assert.equal((await g.call("GET /api/game/me", { query: { ord: ORD } })).body.best, 300);
  assert.equal((await g.call("POST /api/game/me", { body: { firstName: "Fofo", ord: ORD } })).status, 401, "editing needs a real login");
});

test("order identity: an existing game name wins over the order name; a session always wins over the order", async () => {
  const g = build({ db: orderDb(), accts: accts(["500000111", "محمد"], "500000777") });
  await g.setName("500000111", "Mido");
  assert.equal((await g.start({ ord: "W1792400000506" })).firstName, "Mido", "the game name, not the order name");
  const H = AUTH("500000777");
  const st = await g.start({ ord: ORD }, H);
  assert.deepEqual([st.known, st.named], [true, false]);
  assert.equal(g.db.players.has("500000555"), false, "the order was not even used");
  g.db.clock.now += 20_500;
  const r = await g.score({ token: st.token, score: 100, durationMs: 20_000, ord: ORD }, H);
  assert.deepEqual([r.status, r.body.error], [409, "name_required"], "session without a game name ⇒ 409; the order does not rescue it");
  assert.equal((await g.call("GET /api/game/me", { headers: H, query: { ord: ORD } })).body.canEdit, true, "session ⇒ can edit");
});

test("order identity: old (> 48 h) / unpaid / test / bad-shape order ⇒ anonymous: 401 login_required, token NOT consumed; no usable name ⇒ 409", async () => {
  const g = build({ db: orderDb() });
  for (const ord of ["W1792400000502", "W1792400000503", "W1792400000504", "12345678", "W12", "W1792400000999"]) {
    const st = await g.start({ ord });
    assert.deepEqual([st.known, st.firstName, st.named], [false, null, false], ord);
    assert.equal((await g.call("GET /api/game/me", { query: { ord } })).status, 401, ord);
    g.db.clock.now += 10_500;
    const r = await g.score({ token: st.token, score: 50, durationMs: 10_000, ord });
    assert.deepEqual([r.status, r.body.error], [401, "login_required"], ord);
    const ok = await g.score({ token: st.token, score: 50, durationMs: 10_000, ord: ORD });
    assert.equal(ok.body.saved, true, ord + " ⇒ token not consumed");
  }
  const st = await g.start({ ord: "W1792400000505" });
  assert.deepEqual([st.known, st.firstName, st.named], [true, null, false], "«عميل» is no name");
  g.db.clock.now += 10_500;
  const r = await g.score({ token: st.token, score: 50, durationMs: 10_000, ord: "W1792400000505" });
  assert.deepEqual([r.status, r.body.error], [409, "name_required"]);
  assert.equal(g.db.players.has("500000559"), false);
  assert.deepEqual((await g.call("GET /api/game/me", { query: { ord: "W1792400000505" } })).body, { ok: true, firstName: null, suggested: null, canEdit: false, best: null });
  g.db.clock.now = T0 + 48 * 3600_000;
  assert.equal((await g.start({ ord: ORD })).known, false, "the valid order expires after 48 h too");
});

test("order identity: 20 scores/h per order (across IPs)", async () => {
  const g = build({ db: orderDb() });
  for (let i = 0; i < 20; i++) assert.notEqual((await g.score({ token: "x.y", score: 1, durationMs: 1, ord: ORD }, { "cf-connecting-ip": "7.7.7." + i })).status, 429);
  const r = await g.score({ token: "x.y", score: 1, durationMs: 1, ord: ORD }, { "cf-connecting-ip": "7.7.6.1" });
  assert.deepEqual([r.status, r.body.error], [429, "rate_limited"]);
});

/* ═══ v2.2: percentile ═══ */
test("percentileOf (pure): share of players whose best is lower, floored; null under 5 players", () => {
  assert.equal(percentileOf([10, 20, 30, 40], 50), null, "4 players");
  assert.equal(percentileOf([10, 20, 30, 40, 50], 35), 60);
  assert.equal(percentileOf([10, 20, 30, 40, 50], 10), 0, "equal is not lower");
  assert.equal(percentileOf([10, 20, 30, 40, 50], 999), 100);
  assert.equal(percentileOf([1, 2, 3, 4, 5, 6, 7], 5), 57);
});

test("score.percentile: ranked players only (distinct phones, clean, no team/test), includes this player; null under 5; flagged run still gets one", async () => {
  const pns = Array.from({ length: 7 }, (_, i) => String(540000000 + i));
  const g = build({ settings: { waBot: { testPhones: ["0" + pns[6]] } }, accts: accts(...pns) });
  const H = [];
  for (const pn of pns) H.push(await withPlayer(g, pn, "Player"));
  let r = await play(g, { headers: H[6], score: 5000, durationMs: 100_000 });     // test phone: never counted
  for (let i = 0; i < 3; i++) r = await play(g, { headers: H[i], score: 100 * (i + 1), durationMs: 20_000 });
  assert.equal(r.body.percentile, null, "3 ranked players");
  r = await play(g, { headers: H[0], score: 150, durationMs: 20_000 });
  assert.equal(r.body.percentile, null, "same phone again: still 3 players");
  r = await play(g, { headers: H[3], score: 400, durationMs: 20_000 });
  assert.equal(r.body.percentile, null, "4 players");
  r = await play(g, { headers: H[4], score: 250, durationMs: 20_000 });   // bests 150 200 300 400 250 ⇒ lower than 250: 2 of 5
  assert.equal(r.body.percentile, 40);
  r = await play(g, { headers: H[5], score: 5000, durationMs: 10_000 });  // flagged ⇒ not in the distribution, answer looks normal
  assert.equal(g.db.rows.at(-1).flagged, true);
  assert.deepEqual([r.body.saved, r.body.rank, r.body.percentile], [true, null, 100]);
});

/* ═══ v2.3: «تحدّى أصحابك» ═══ */
test("challenge code: 7 chars, unambiguous alphabet (no 0/O/o/1/l/I), random, matches the lookup regex", () => {
  assert.ok(!/[0Oo1lI]/.test(CHALLENGE_ALPHABET));
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = newChallengeCode();
    assert.equal(c.length, 7); assert.ok(CHALLENGE_RE.test(c), c); assert.ok(!/[0Oo1lI]/.test(c), c);
    seen.add(c);
  }
  assert.ok(seen.size > 495, "random");
  for (const bad of ["abc", "ABCDEF0", "ABCDEFl", "ABCDEFI", "ABCDEFO", "abc-def", "ABCDEFGHJKM", "ABCDEFG/"]) assert.equal(CHALLENGE_RE.test(bad), false, bad);
});

test("score: clean run ⇒ challenge code saved on the row; flagged run ⇒ challenge null (rest looks normal); code clash ⇒ retried", async () => {
  const g = build({ accts: accts("500000111") });
  const H = await withPlayer(g, "500000111", "Omar");
  let r = await play(g, { headers: H, score: 200, durationMs: 20_000 });
  assert.ok(CHALLENGE_RE.test(r.body.challenge), String(r.body.challenge));
  assert.equal(g.db.rows[0].challenge_code, r.body.challenge);
  r = await play(g, { headers: H, score: 9000, durationMs: 5_000 });
  assert.deepEqual([r.body.saved, r.body.rank, r.body.challenge], [true, null, null]);
  assert.equal(g.db.rows[1].challenge_code, null);
  g.db.pool.forceCodeClash = 2;
  r = await play(g, { headers: H, score: 150, durationMs: 20_000 });
  assert.equal(r.body.saved, true); assert.ok(CHALLENGE_RE.test(r.body.challenge));
  assert.equal(g.db.rows.length, 3);
});

test("POST /api/game/challenge: best clean all-time run, reuses its code, makes one for an old run; 401 / 404 no_score; order identity works", async () => {
  const db = orderDb();
  const g = build({ db, accts: accts("500000111", "500000222") });
  assert.deepEqual((await g.call("POST /api/game/challenge", { body: {} })).body, { ok: false, error: "login_required" });
  const H = await withPlayer(g, "500000111", "Omar");
  let r = await g.call("POST /api/game/challenge", { body: {}, headers: H });
  assert.deepEqual([r.status, r.body], [404, { ok: false, error: "no_score" }]);
  const a = await play(g, { headers: H, score: 300, durationMs: 20_000 });
  await play(g, { headers: H, score: 200, durationMs: 20_000 });
  await play(g, { headers: H, score: 9000, durationMs: 5_000 });      // flagged ⇒ never the best
  r = await g.call("POST /api/game/challenge", { body: {}, headers: H });
  assert.deepEqual(r.body, { ok: true, challenge: a.body.challenge, firstName: "Omar", score: 300 });
  // a run from before v2.3 (no code) ⇒ a code gets made once and then reused
  await withPlayer(g, "500000222", "Lina");
  db.rows.push({ id: 900, run_id: "old-run", phone_norm: "500000222", first_name: "Lina", score: 500, duration_ms: 30000, flagged: false, challenge_code: null, created_at: new Date(T0 - 86400_000) });
  const c1 = (await g.call("POST /api/game/challenge", { body: {}, headers: AUTH("500000222") })).body;
  assert.ok(CHALLENGE_RE.test(c1.challenge)); assert.equal(c1.score, 500);
  assert.equal((await g.call("POST /api/game/challenge", { body: {}, headers: AUTH("500000222") })).body.challenge, c1.challenge);
  // order identity (tracking page)
  const st = await g.start({ ord: ORD });
  db.clock.now += 20_500;
  const o = await g.score({ token: st.token, score: 120, durationMs: 20_000, ord: ORD });
  r = await g.call("POST /api/game/challenge", { body: { ord: ORD } });
  assert.deepEqual(r.body, { ok: true, challenge: o.body.challenge, firstName: "Faisal", score: 120 });
});

test("GET /api/game/challenge/:code: current name + score only; unknown / bad shape / flagged / team phone ⇒ 404; 30 s cache; name edit shows; 120 lookups/h per IP", async () => {
  const settings = { waBot: { testPhones: ["0500000999"] } };
  const db = fakeDb();
  const g = build({ db, settings, accts: accts("500000111", "500000999") });
  const H = await withPlayer(g, "500000111", "Omar");
  const a = await play(g, { headers: H, score: 321, durationMs: 20_000 });
  const look = (code, headers = {}) => g.call("GET /api/game/challenge/:code", { params: { code }, headers });
  let r = await look(a.body.challenge);
  assert.deepEqual([r.status, r.body], [200, { ok: true, firstName: "Omar", score: 321 }]);
  for (const k of ["phone", "phone_norm", "order", "orderNo", "id", "runId"]) assert.equal(r.body[k], undefined, k);
  assert.ok(!JSON.stringify(r.body).includes("500000111"));
  for (const bad of ["ZZZZZZZ", "abc", "ABC0DEF", ""]) assert.deepEqual((await look(bad)).body, { ok: false, error: "not_found" }, bad);
  // flagged row with a code (should never exist, but the lookup refuses it anyway)
  db.rows.push({ id: 901, run_id: "x1", phone_norm: "500000111", first_name: "Omar", score: 99999, flagged: true, challenge_code: "FLAGGED", created_at: new Date(T0) });
  assert.equal((await look("FLAGGED")).status, 404);
  // team/test phone
  const T = await withPlayer(g, "500000999", "Tester");
  const t = await play(g, { headers: T, score: 400, durationMs: 20_000 });
  assert.equal((await look(t.body.challenge)).status, 404);
  assert.deepEqual((await g.call("POST /api/game/challenge", { body: {}, headers: T })).body, { ok: false, error: "no_score" });
  // cache 30 s
  const n0 = db.calls.filter((x) => x === "challenge").length;
  await look(a.body.challenge); await look(a.body.challenge);
  assert.equal(db.calls.filter((x) => x === "challenge").length, n0);
  // the one name edit shows at once
  await g.setName("500000111", "Mido");
  assert.equal((await look(a.body.challenge)).body.firstName, "Mido");
  // rate limit per IP
  const g2 = build();
  for (let i = 0; i < 120; i++) assert.notEqual((await g2.call("GET /api/game/challenge/:code", { params: { code: "ABCDEFG" } })).status, 429);
  assert.deepEqual((await g2.call("GET /api/game/challenge/:code", { params: { code: "ABCDEFG" } })).body, { ok: false, error: "rate_limited" });
});

/* ═══ v2.3: هوية رابط التتبّع بتخلص بعد ساعة من التسليم/الاستلام ═══ */
test("orderIdentityValid (pure): delivered/collected ⇒ until done + 1 h; not done ⇒ 48 h from creation", () => {
  const C = new Date(T0).toISOString();
  const D = new Date(T0 + 40 * 60_000).toISOString();      // delivered 40 min after the order
  assert.equal(orderIdentityValid({ createdAt: C, doneAt: D, now: T0 + 40 * 60_000 + 3600_000 - 1 }), true, "59:59 after delivery");
  assert.equal(orderIdentityValid({ createdAt: C, doneAt: D, now: T0 + 40 * 60_000 + 3600_000 }), false, "exactly 1 h after");
  assert.equal(orderIdentityValid({ createdAt: C, doneAt: null, now: T0 + 48 * 3600_000 - 1 }), true, "not delivered: 48 h cap");
  assert.equal(orderIdentityValid({ createdAt: C, doneAt: null, now: T0 + 48 * 3600_000 }), false);
  assert.equal(orderIdentityValid({ createdAt: C, doneAt: "garbage", now: T0 + 3 * 3600_000 }), true, "unknown time ⇒ 48 h rule");
  assert.equal(orderIdentityValid({ createdAt: null, doneAt: null, now: T0 }), false);
});

test("order identity expiry from the route: delivered 1 h ago ⇒ anonymous (start known:false, score 401, token NOT consumed); final status without a time ⇒ 48 h; the SQL reads collected_at, shipment delivered_at and history", async () => {
  const D = T0 + 30 * 60_000;
  const db = fakeDb({ orders: {
    W1792400000701: { phone_norm: "500000701", name: "Delivered Guy", status: "delivered", created_at: new Date(T0).toISOString(), done_at: new Date(D).toISOString() },
    W1792400000702: { phone_norm: "500000702", name: "Final Notime", status: "delivered", created_at: new Date(T0).toISOString() },
  } });
  const g = build({ db });
  db.clock.now = D + 3600_000 - 60_000;      // 59 min after delivery
  const st = await g.start({ ord: "W1792400000701" });
  assert.deepEqual([st.known, st.firstName], [true, "Delivered"]);
  assert.match(db.pool.lastOrderSql, /collected_at/); assert.match(db.pool.lastOrderSql, /dl_shipments/); assert.match(db.pool.lastOrderSql, /history/);
  assert.ok(db.pool.lastOrderSql.includes("~ '^\\d{4}-\\d{2}-\\d{2}T'"), "the history guard regex reaches SQL with its backslashes (template literal trap)");
  db.clock.now = D + 3600_000 + 1000;        // just past 1 h ⇒ the same order is anonymous now
  assert.equal((await g.start({ ord: "W1792400000701" })).known, false);
  assert.equal((await g.call("GET /api/game/me", { query: { ord: "W1792400000701" } })).status, 401);
  const r = await g.score({ token: st.token, score: 100, durationMs: 20_000, ord: "W1792400000701" });
  assert.deepEqual([r.status, r.body.error], [401, "login_required"]);
  assert.equal(db.rows.length, 0, "nothing saved, token still unused");
  // final status, delivery time unknown ⇒ 48 h from creation
  db.clock.now = T0 + 47 * 3600_000;
  assert.equal((await g.start({ ord: "W1792400000702" })).known, true);
  db.clock.now = T0 + 48 * 3600_000 + 1;
  assert.equal((await g.start({ ord: "W1792400000702" })).known, false);
});
