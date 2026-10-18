/* RTG2 (١٨/١٠) — لعبة الجري: التوكن، قواعد العلامة، الحدود، مين بيلعب، فلتر الاسم، اللوحة (لاعب = صف + الاستبعاد + الكاش)،
   الأسبوع (السبت ٤ الفجر الرياض)، شاشة المالك (الجوال كامل/مقنّع)، PUT بالقصّ، المقفول ⇒ 503، أحداث الرحلة، track.game. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  register, gameCfg, GAME_DEFAULTS, GAME_LABELS, signToken, verifyToken, cleanFirstName, isProfane, flagReasons,
  leaderboardOf, weekStartOf, maskPhone, excludedPhones, LIMITS,
} from "./game.js";
import * as J from "./journey.js";
import { sectionOf } from "./cms.js";
import { SERVER_OWNED_PATHS } from "./settings-guard.js";

const SECRET = "test-secret";
const T0 = Date.parse("2026-10-18T15:00:00Z");      // الأحد ١٨/١٠ ٦ المغرب الرياض

/* ═══ قاعدة بيانات وهمية: game_scores في الذاكرة + طلبات + عملاء ═══ */
function fakeDb({ orders = {}, history = {}, pos = {} } = {}) {
  const rows = [];
  const calls = [];
  let id = 0;
  const pk = (r) => r.phone_norm || (r.device_id ? "d:" + r.device_id : r.session_id ? "s:" + r.session_id : "r:" + r.run_id);
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
          const r = { id: ++id, run_id: p[0], phone_norm: p[1], first_name: p[2], score: p[3], duration_ms: p[4], session_id: p[5], device_id: p[6], ip_hash: p[7], source: p[8], order_no: p[9], flagged: p[10], flag_reason: p[11], created_at: new Date(clock.now) };
          rows.push(r); return { rowCount: 1, rows: [{ id: r.id, created_at: r.created_at }] };
        }
        case "top": {
          const from = p[0] ? Date.parse(p[0]) : null, ex = new Set(p[1] || []);
          return { rows: rows.filter((r) => !r.flagged && (from == null || r.created_at.getTime() >= from) && !(r.phone_norm && ex.has(r.phone_norm))).map((r) => ({ ...r, pk: pk(r) })) };
        }
        case "best": {
          const from = p[1] ? Date.parse(p[1]) : null;
          const col = /phone_norm = \$1/.test(s) ? "phone_norm" : (s.match(/AND (device_id|session_id|run_id) = \$1/) || [])[1];
          const m = rows.filter((r) => !r.flagged && r[col] === p[0] && (col === "phone_norm" || !r.phone_norm) && (from == null || r.created_at.getTime() >= from));
          return { rows: [{ best: m.reduce((x, r) => Math.max(x, r.score), 0) }] };
        }
        case "order": { const o = orders[p[0]]; return { rows: o ? [o] : [] }; }
        case "hist-order": return { rows: history[p[0]] ? [{ n: history[p[0]] }] : [] };
        case "hist-pos": return { rows: pos[p[0]] ? [{ n: pos[p[0]] }] : [] };
        case "stats": {
          const from = Date.parse(p[0]), today = Date.parse(p[1]);
          const w = rows.filter((r) => r.created_at.getTime() >= from);
          const players = new Set(w.filter((r) => !r.flagged).map(pk));
          const named = new Set(w.filter((r) => !r.flagged && r.first_name).map(pk));
          return { rows: [{ runs_today: w.filter((r) => r.created_at.getTime() >= today).length, runs_week: w.length, players_week: players.size, flagged_week: w.filter((r) => r.flagged).length, named_week: named.size }] };
        }
        case "flagged": return { rows: rows.filter((r) => r.flagged).slice().reverse().slice(0, 20) };
        default: return { rows: [], rowCount: 0 };
      }
    },
  };
  return { pool, rows, calls, clock };
}

function build({ settings = {}, owner = true, accounts = null, db = fakeDb() } = {}) {
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT") };
  const cfg = { settings };
  const ctx = {
    pool: db.pool, jb: JSON.stringify, getSettingsData: async () => cfg.settings, gameSecret: SECRET,
    requireAdmin: async (c) => (c.req.header("Authorization") ? null : c.json({ error: "Unauthorized" }, 401)),
    isOwner: () => owner,
  };
  const api = register(app, ctx, { accounts: () => accounts, now: () => db.clock.now });
  const call = async (key, { body, headers = {}, query = {} } = {}) => {
    const h = Object.fromEntries(Object.entries({ "cf-connecting-ip": "1.1.1.1", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
    const c = {
      req: { header: (n) => h[String(n).toLowerCase()], json: async () => { if (body === undefined) throw new Error("no body"); return body; }, query: (k) => query[k] },
      json: (b, status = 200) => ({ body: b, status }),
    };
    return routes[key](c);
  };
  const start = async (body = {}, headers = {}) => (await call("POST /api/game/start", { body, headers })).body;
  const score = (body, headers = {}) => call("POST /api/game/score", { body, headers });
  return { routes, call, start, score, db, api, cfg };
}
/* جولة سليمة: توكن، والساعة بتتقدّم مدة الجولة، وبعدين النتيجة */
async function play(g, { score = 100, durationMs = 20000, start = {}, extra = {}, headers = {}, advance = durationMs + 500 } = {}) {
  const st = await g.start(start, headers);
  g.db.clock.now += advance;
  return g.score({ token: st.token, score, durationMs, ...extra }, headers);
}

/* ═══ التوكن ═══ */
test("token: sign/verify round-trip; forged body or mac ⇒ null; older than 3 h or from the future ⇒ null", () => {
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
  assert.equal(verifyToken(tk, SECRET, T0 + 3 * 3600_000 + 1), null, "expired");
  assert.ok(verifyToken(tk, SECRET, T0 + 3 * 3600_000 - 1000), "just inside 3 h");
  assert.equal(verifyToken(signToken({ ...p, t: T0 + 120_000 }, SECRET), SECRET, T0), null, "issued in the future");
  assert.equal(verifyToken(signToken({ ...p, r: "x" }, SECRET), SECRET, T0), null, "run id shape");
});

test("start: token + settings + known/firstName null for a stranger; config route mirrors the settings", async () => {
  const g = build();
  const r = await g.start({ src: "track" });
  assert.equal(r.ok, true); assert.equal(r.enabled, true); assert.equal(r.maxScorePerSec, 45); assert.equal(r.period, "week");
  assert.equal(r.known, false); assert.equal(r.firstName, null);
  const p = verifyToken(r.token, SECRET, T0);
  assert.equal(p.s, "track"); assert.equal(p.t, T0); assert.match(p.r, /^[a-f0-9]{24}$/); assert.equal(p.ih.length, 8);
  assert.deepEqual((await g.call("GET /api/game/config")).body, { ok: true, enabled: true, period: "week" });
  const g2 = build({ settings: { game: { leaderboardPeriod: "all", maxScorePerSec: 80 } } });
  assert.deepEqual((await g2.call("GET /api/game/config")).body, { ok: true, enabled: true, period: "all" });
  assert.equal((await g2.start()).maxScorePerSec, 80);
});

test("score: forged / expired / reused token ⇒ 400 bad_token and nothing saved (or saved once)", async () => {
  const g = build();
  const st = await g.start();
  const [b, m] = st.token.split(".");
  let r = await g.score({ token: `${b}.${m.slice(0, -3)}abc`, score: 10, durationMs: 5000 });
  assert.deepEqual([r.status, r.body.error], [400, "bad_token"]);
  assert.equal(g.db.rows.length, 0);
  g.db.clock.now += 3 * 3600_000 + 5000;
  r = await g.score({ token: st.token, score: 10, durationMs: 5000 });
  assert.deepEqual([r.status, r.body.error], [400, "bad_token"], "expired");
  assert.equal(g.db.rows.length, 0);
  const st2 = await g.start();
  g.db.clock.now += 10_000;
  r = await g.score({ token: st2.token, score: 50, durationMs: 9000 });
  assert.equal(r.body.saved, true);
  r = await g.score({ token: st2.token, score: 60, durationMs: 9500 });
  assert.deepEqual([r.status, r.body.error], [400, "bad_token"], "reused");
  assert.equal(g.db.rows.length, 1);
});

test("score: bad numbers ⇒ 400 bad_score (non-integer, negative, too big)", async () => {
  const g = build();
  for (const [score, durationMs] of [[1.5, 5000], [-1, 5000], [1_000_001, 5000], [10, -1], [10, 7_200_001], ["10", 5000], [10, null]]) {
    const st = await g.start();
    const r = await g.score({ token: st.token, score, durationMs });
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
  const g = build();
  // score_rate
  let r = await play(g, { score: 5000, durationMs: 10_000 });
  assert.equal(r.status, 200); assert.equal(r.body.saved, true); assert.equal(r.body.rank, null);
  assert.equal(r.body.best, 5000, "the cheater sees his own number");
  assert.deepEqual([g.db.rows[0].flagged, g.db.rows[0].flag_reason], [true, "score_rate"]);
  // duration_gt_wall: says 60 s, only 10 s passed
  r = await play(g, { score: 100, durationMs: 60_000, advance: 10_000 });
  assert.equal(g.db.rows[1].flag_reason, "duration_gt_wall"); assert.equal(r.body.rank, null);
  // too_short
  r = await play(g, { score: 5, durationMs: 1000 });
  assert.equal(g.db.rows[2].flag_reason, "too_short");
  const lb = (await g.call("GET /api/game/leaderboard")).body;
  assert.deepEqual(lb.top, [], "flagged rows never appear");
});

test("score: outlier = more than 3× the best clean score once there are ≥ 20 clean runs", async () => {
  const g = build();
  for (let i = 0; i < 20; i++) await play(g, { score: 80 + i, durationMs: 20_000, extra: { dev: "dev-player-" + i } });
  assert.equal(g.db.rows.filter((x) => !x.flagged).length, 20);
  const r = await play(g, { score: 400, durationMs: 20_000, extra: { dev: "dev-cheat-001" } });   // within the rate (45×20+50) but > 3×99
  assert.equal(r.body.rank, null);
  assert.deepEqual([g.db.rows.at(-1).flagged, g.db.rows.at(-1).flag_reason], [true, "outlier"]);
  const ok = await play(g, { score: 290, durationMs: 20_000, extra: { dev: "dev-good-0001" } });
  assert.equal(ok.body.rank, 1); assert.equal(g.db.rows.at(-1).flagged, false);
});

/* ═══ الحدود ═══ */
test("rate limits: 60 starts/h per IP, 30 scores/h per IP, 20 scores/h per session; the hour resets", async () => {
  const g = build();
  for (let i = 0; i < 60; i++) assert.equal((await g.start()).ok, true);
  let r = await g.call("POST /api/game/start", { body: {} });
  assert.deepEqual([r.status, r.body.error], [429, "rate_limited"]);
  r = await g.call("POST /api/game/start", { body: {}, headers: { "cf-connecting-ip": "2.2.2.2" } });
  assert.equal(r.status, 200, "another IP is fine");
  // scores per IP (no session id): 30 pass the limiter, the 31st is 429 (bad tokens still count)
  for (let i = 0; i < 30; i++) assert.notEqual((await g.score({ token: "x.y", score: 1, durationMs: 1 }, { "cf-connecting-ip": "3.3.3.3" })).status, 429);
  r = await g.score({ token: "x.y", score: 1, durationMs: 1 }, { "cf-connecting-ip": "3.3.3.3" });
  assert.deepEqual([r.status, r.body.error], [429, "rate_limited"]);
  // per session across IPs
  for (let i = 0; i < 20; i++) assert.notEqual((await g.score({ token: "x.y", score: 1, durationMs: 1, sid: "s1abcdef99" }, { "cf-connecting-ip": "9.9.9." + i })).status, 429);
  r = await g.score({ token: "x.y", score: 1, durationMs: 1, sid: "s1abcdef99" }, { "cf-connecting-ip": "9.9.8.1" });
  assert.equal(r.status, 429);
  g.db.clock.now += 3600_001;
  r = await g.call("POST /api/game/start", { body: {} });
  assert.equal(r.status, 200, "next hour");
});

/* ═══ مين بيلعب ═══ */
test("identity: store session beats the order beats the typed name; phone stored, typed name ignored when known", async () => {
  const db = fakeDb({ orders: { W1792400000001: { phone_norm: "500000222", name: "Sara Ahmed" } }, history: { "500000333": "خالد العتيبي" } });
  const acct = { phone_norm: "500000111", name: "محمد عبدالله" };
  const accounts = { customerOf: async (c) => (/cust:a{48}/.test(c.req.header("Authorization") || "") ? acct : null) };
  const g = build({ db, accounts });
  const AUTH = { Authorization: "Bearer cust:" + "a".repeat(48) };
  let st = await g.start({ ord: "W1792400000001" }, AUTH);
  assert.deepEqual([st.known, st.firstName], [true, "محمد"], "session wins over ord");
  let r = await play(g, { start: { ord: "W1792400000001" }, headers: AUTH, extra: { firstName: "Hacker", ord: "W1792400000001" } });
  assert.equal(r.body.firstName, "محمد");
  assert.deepEqual([db.rows.at(-1).phone_norm, db.rows.at(-1).first_name, db.rows.at(-1).order_no], ["500000111", "محمد", "W1792400000001"]);
  // order only
  st = await g.start({ ord: "W1792400000001" });
  assert.deepEqual([st.known, st.firstName], [true, "Sara"]);
  r = await play(g, { extra: { firstName: "Omar", ord: "W1792400000001" } });
  assert.deepEqual([r.body.firstName, db.rows.at(-1).phone_norm], ["Sara", "500000222"]);
  // not a W order / unknown order ⇒ stranger
  st = await g.start({ ord: "12345678" });
  assert.deepEqual([st.known, st.firstName], [false, null]);
  // typed only
  r = await play(g, { extra: { firstName: "  omar tarek " } });
  assert.deepEqual([r.body.firstName, db.rows.at(-1).phone_norm, r.body.nameRejected], ["Omar", null, undefined]);
  // account without a name ⇒ name from the last web order
  acct.phone_norm = "500000333"; acct.name = null;
  st = await g.start({}, AUTH);
  assert.deepEqual([st.known, st.firstName], [true, "خالد"]);
  // bad token header ⇒ customerOf null ⇒ stranger
  st = await g.start({}, { Authorization: "Bearer cust:" + "b".repeat(48) });
  assert.equal(st.known, false);
});

test("name filter: first word, 2–20 letters, Arabic/Latin; insults, digits, URLs, @ rejected (stored NULL + nameRejected)", async () => {
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
  const g = build();
  const r = await play(g, { extra: { firstName: "زق" } });
  assert.deepEqual([r.body.saved, r.body.firstName, r.body.nameRejected], [true, null, true]);
  assert.equal(g.db.rows.at(-1).first_name, null);
});

/* ═══ اللوحة ═══ */
test("leaderboardOf (pure): one row per player (best, earliest on ties), excluded phones out, flagged out, ≤ 10", () => {
  const at = (m) => new Date(T0 + m * 1000).toISOString();
  const rows = [
    { run_id: "r1", phone_norm: "500000001", first_name: "محمد", score: 300, created_at: at(1) },
    { run_id: "r2", phone_norm: "500000001", first_name: "محمد", score: 500, created_at: at(2) },
    { run_id: "r3", device_id: "devA", first_name: null, score: 500, created_at: at(1) },
    { run_id: "r4", device_id: "devA", first_name: "Ali", score: 100, created_at: at(3) },
    { run_id: "r5", phone_norm: "599999999", first_name: "Staff", score: 9999, created_at: at(1) },
    { run_id: "r6", session_id: "s1", first_name: "Cheat", score: 8000, created_at: at(1), flagged: true },
    { run_id: "r7", session_id: "s2", first_name: "Lina", score: 50, created_at: at(1) },
  ];
  const top = leaderboardOf(rows, { exclude: new Set(["599999999"]) });
  assert.deepEqual(top.map((r) => [r.rank, r.firstName, r.score, r.runId, r.runs]), [
    [1, "Ali", 500, "r3", 2],          // tie at 500 ⇒ the earlier run; name from another run of the same player
    [2, "محمد", 500, "r2", 2],
    [3, "Lina", 50, "r7", 1],
  ]);
  const many = Array.from({ length: 15 }, (_, i) => ({ run_id: "m" + i, device_id: "dev" + i, score: i, created_at: at(i) }));
  assert.equal(leaderboardOf(many).length, 10);
  assert.equal(leaderboardOf(many)[0].firstName, null);
});

test("leaderboard route: public shape (no phone, no last name), staff + bot test phones excluded, noAds customers kept, 30 s cache", async () => {
  const settings = {
    waBot: { testPhones: ["0500000999"] },
    cms: { phoneLists: { migratedAt: "2026-10-15", staffPhones: [{ phone: "0500000888", reason: "employee" }], noAdsPhones: [{ phone: "0500000777", reason: "ads_request" }] } },
  };
  const db = fakeDb({ orders: {
    W1792400000011: { phone_norm: "500000999", name: "Tester One" }, W1792400000012: { phone_norm: "500000888", name: "Staff Guy" },
    W1792400000013: { phone_norm: "500000777", name: "Noads Customer" }, W1792400000014: { phone_norm: "500000666", name: "Real Customer" } } });
  const g = build({ settings, db });
  assert.ok(excludedPhones(settings).has("500000999") && excludedPhones(settings).has("500000888") && !excludedPhones(settings).has("500000777"));
  for (const [ord, score] of [["W1792400000011", 900], ["W1792400000012", 800], ["W1792400000013", 300], ["W1792400000014", 200], ["W1792400000014", 250]]) {
    await play(g, { score, durationMs: 25_000, extra: { ord } });
  }
  await play(g, { score: 100, durationMs: 25_000, extra: { dev: "anon-device-1" } });
  const r = (await g.call("GET /api/game/leaderboard")).body;
  assert.equal(r.ok, true); assert.equal(r.period, "week");
  assert.equal(r.from, "2026-10-17T01:00:00.000Z", "Saturday 04:00 Riyadh");
  assert.deepEqual(r.top, [{ rank: 1, firstName: "Noads", score: 300 }, { rank: 2, firstName: "Real", score: 250 }, { rank: 3, firstName: null, score: 100 }]);
  assert.ok(!JSON.stringify(r).includes("5000007"), "no phone in the public board");
  // cache: the score route refreshes it; a plain GET within 30 s does not query
  const n0 = db.calls.filter((t) => t === "top").length;
  await g.call("GET /api/game/leaderboard"); await g.call("GET /api/game/leaderboard");
  assert.equal(db.calls.filter((t) => t === "top").length, n0);
  db.clock.now += 31_000;
  await g.call("GET /api/game/leaderboard");
  assert.equal(db.calls.filter((t) => t === "top").length, n0 + 1);
  // all-time period: from null; invalid query ⇒ the setting
  const all = (await g.call("GET /api/game/leaderboard", { query: { period: "all" } })).body;
  assert.deepEqual([all.period, all.from, all.top.length], ["all", null, 3]);
  assert.equal((await g.call("GET /api/game/leaderboard", { query: { period: "month" } })).body.period, "week");
});

test("score response: rank in the current top 10 + this player's best this period; last week's runs don't count", async () => {
  const g = build();
  let r = await play(g, { score: 200, durationMs: 20_000, extra: { dev: "player-one-1", firstName: "Omar" } });
  assert.deepEqual([r.body.rank, r.body.best, r.body.firstName], [1, 200, "Omar"]);
  r = await play(g, { score: 150, durationMs: 20_000, extra: { dev: "player-one-1", firstName: "Omar" } });
  assert.deepEqual([r.body.rank, r.body.best], [null, 200], "a worse run is not the one on the board");
  r = await play(g, { score: 300, durationMs: 20_000, extra: { dev: "player-two-2", firstName: "Lina" } });
  assert.equal(r.body.rank, 1);
  // next week: board empties, best restarts
  g.db.clock.now = Date.parse("2026-10-24T01:00:00Z") + 1000;
  r = await play(g, { score: 120, durationMs: 20_000, extra: { dev: "player-one-1", firstName: "Omar" } });
  assert.deepEqual([r.body.rank, r.body.best], [1, 120]);
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
test("cms GET: config/defaults/labels/week/top/stats/flagged; full phone for the owner only, masked otherwise", async () => {
  const db = fakeDb({ orders: { W1792400000021: { phone_norm: "512341234", name: "Faisal Al" } } });
  const mk = (owner) => build({ db, owner });
  const g = mk(true);
  await play(g, { score: 400, durationMs: 25_000, extra: { ord: "W1792400000021" } });
  await play(g, { score: 350, durationMs: 25_000, extra: { ord: "W1792400000021" } });
  await play(g, { score: 300, durationMs: 25_000, extra: { dev: "guest-dev-77" } });
  await play(g, { score: 9000, durationMs: 5_000, extra: { dev: "cheater-dev-1", firstName: "Bad" } });
  const AUTH = { Authorization: "Bearer x" };
  assert.equal((await g.call("GET /api/cms/game")).status, 401);
  const r = (await g.call("GET /api/cms/game", { headers: AUTH })).body;
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, GAME_DEFAULTS); assert.deepEqual(r.defaults, GAME_DEFAULTS); assert.equal(r.labels.enabled, GAME_LABELS.enabled);
  assert.deepEqual(r.week, { from: "2026-10-17T01:00:00.000Z", to: "2026-10-24T01:00:00.000Z" });
  assert.deepEqual(r.top.map((x) => [x.rank, x.firstName, x.score, x.phone, x.phoneKnown, x.runs, x.durationMs]), [
    [1, "Faisal", 400, "0512341234", true, 2, 25_000], [2, null, 300, null, false, 1, 25_000]]);
  assert.ok(r.top[0].bestAt);
  assert.deepEqual(r.stats, { runsToday: 4, runsWeek: 4, playersWeek: 2, flaggedWeek: 1, namedWeek: 1 });
  assert.equal(r.flagged.length, 1);
  assert.deepEqual(Object.keys(r.flagged[0]).sort(), ["createdAt", "durationMs", "firstName", "id", "reason", "score"]);
  assert.deepEqual([r.flagged[0].firstName, r.flagged[0].score, r.flagged[0].reason], ["Bad", 9000, "score_rate"]);
  const m = (await mk(false).call("GET /api/cms/game", { headers: AUTH })).body;
  assert.equal(m.top[0].phone, "05••••1234"); assert.equal(maskPhone("512341234"), "05••••1234");
  assert.equal(m.top[1].phone, null);
});

test("cms PUT: clamps and saves under {game}; board cache cleared", async () => {
  const g = build();
  const AUTH = { Authorization: "Bearer x" };
  let r = await g.call("PUT /api/cms/game", { body: { enabled: false, leaderboardPeriod: "all", maxScorePerSec: 9999, junk: 1 }, headers: AUTH });
  assert.deepEqual(r.body, { ok: true, config: { enabled: false, leaderboardPeriod: "all", maxScorePerSec: 500 } });
  assert.deepEqual(g.db.pool.saved, { enabled: false, leaderboardPeriod: "all", maxScorePerSec: 500 });
  r = await g.call("PUT /api/cms/game", { body: { enabled: "yes", leaderboardPeriod: "month", maxScorePerSec: 2 }, headers: AUTH });
  assert.deepEqual(r.body.config, { enabled: true, leaderboardPeriod: "week", maxScorePerSec: 10 });
  assert.equal((await g.call("PUT /api/cms/game", { body: {} })).status, 401);
  assert.deepEqual(gameCfg({}), GAME_DEFAULTS);
  assert.deepEqual(gameCfg({ game: { maxScorePerSec: "abc" } }).maxScorePerSec, 45);
});

test("disabled ⇒ config enabled:false, start + score 503 disabled; the board still answers", async () => {
  const g = build({ settings: { game: { enabled: false } } });
  assert.deepEqual((await g.call("GET /api/game/config")).body, { ok: true, enabled: false, period: "week" });
  let r = await g.call("POST /api/game/start", { body: {} });
  assert.deepEqual([r.status, r.body], [503, { ok: false, error: "disabled" }]);
  r = await g.score({ token: "a.b", score: 1, durationMs: 5000 });
  assert.deepEqual([r.status, r.body.error], [503, "disabled"]);
  assert.equal((await g.call("GET /api/game/leaderboard")).body.ok, true);
  // turned off mid-run: the token from before is refused too
  g.cfg.settings = {};
  const st = await g.start();
  g.cfg.settings = { game: { enabled: false } };
  r = await g.score({ token: st.token, score: 10, durationMs: 5000 });
  assert.equal(r.status, 503);
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
    { n: "game_leaderboard_view", t: now, seq: 3, path: "/play", p: { period: "week", src: "play" } },
    { n: "game_cheat", t: now, seq: 4, p: {} },
  ] }), { now });
  assert.deepEqual(p.events.map((e) => e.name), ["game_play", "game_over", "game_leaderboard_view"]);
  assert.deepEqual(p.rejected, { unknown: 1 });
  assert.deepEqual(p.events[0].props, { src: "play" });
  assert.deepEqual(p.events[1].props, { score: 1234, ms: 45678, src: "track" });
  assert.deepEqual(p.events[2].props, { period: "week", src: "play" });
  assert.equal(p.events[1].path, "/track/:order");
  for (const e of p.events) { assert.equal(e.step, null); assert.equal(J.stampsSession(e.name), false); }
  assert.deepEqual(J.GAME_EVENTS, ["game_play", "game_over", "game_leaderboard_view"]);
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
