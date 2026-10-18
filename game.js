/* ═══════════════════════════════════════════════════════════════════════════
   🎮 لعبة الجري (RTG2 — ١٨/١٠): لعبة زي ديناصور كروم على المتجر
   (freshcuts.sa/play + جوّه صفحة تتبّع الطلب) ولوحة أبطال «أحسن ١٠» بالاسم الأول بس.

   المالك: عايز بعدين يدّي أبطال الأسبوع خصم. الشريحة دي **مابتعملش كوبونات** —
   بتجهّز القايمة بس (GET /api/cms/game ⇒ top بالجوال للمالك) والخصم شغل بعدين.

   المسارات العامة:
     GET  /api/game/config                 { ok, enabled, period }
     POST /api/game/start                  توكن جولة موقّع من السيرفر (HMAC) + الاسم لو العميل معروف
     POST /api/game/score                  النتيجة — بنحفظ كل حاجة وبنعلّم على المشكوك فيه بدل ما نرفضه
     GET  /api/game/leaderboard?period=    أحسن ١٠ (لاعب واحد = صف واحد بأحسن نتيجة)
   المالك (requireAdmin، قسم «النمو»):
     GET  /api/cms/game                    الإعدادات + أبطال الأسبوع (الجوال كامل للمالك بس) + أرقام + آخر المعلَّم عليهم
     PUT  /api/cms/game                    الإعدادات (jsonb_set '{game}')

   ضد الغش (نعلّم مش نرفض — الرد شكله عادي فالغشاش مابيتعلّمش حاجة):
     • توكن مزوّر / أقدم من ٣ ساعات / اتستخدم قبل كده ⇒ 400 bad_token ومفيش حفظ.
     • مدة الجولة أطول من الوقت الحقيقي من ساعة التوكن + ٣ ث ⇒ duration_gt_wall
     • نقاط أكتر من maxScorePerSec × الثواني + ٥٠ ⇒ score_rate
     • أقل من ١٫٥ ث ونقاط > ٠ ⇒ too_short
     • أكتر من ٣× أحسن نتيجة سليمة على الإطلاق (بعد ٢٠ جولة) ⇒ outlier
     المعلَّم عليه مابيظهرش في اللوحة العامة أبداً، والرد بيقول saved:true وrank:null.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { bizDay, bizStart, shiftDay, weekdayOf, DEFAULT_WEEK_START } from "./bizday.js";
import { teamPhoneSet } from "./smsrules.js";

export const GAME_DEFAULTS = Object.freeze({ enabled: true, leaderboardPeriod: "week", maxScorePerSec: 45 });
export const GAME_LABELS = Object.freeze({
  enabled: "اللعبة شغّالة",
  leaderboardPeriod: "لوحة الأبطال: الأسبوع ده ولا كل الوقت",
  maxScorePerSec: "أقصى نقاط في الثانية (اللي فوقه يتعلّم عليه)",
  periods: { week: "الأسبوع ده (من السبت ٤ الفجر)", all: "كل الوقت" },
  flags: {
    duration_gt_wall: "مدة الجولة أطول من الوقت الحقيقي",
    score_rate: "نقاط أسرع من المسموح",
    too_short: "جولة أقصر من ثانية ونص وفيها نقاط",
    outlier: "أكتر من ٣ أضعاف أحسن نتيجة",
  },
});
export const PERIODS = Object.freeze(["week", "all"]);
export const LIMITS = Object.freeze({
  tokenMaxAgeMs: 3 * 3600_000, wallSlackMs: 3000, rateSlack: 50, minDurationMs: 1500,
  outlierFactor: 3, outlierMinRuns: 20, maxScore: 1_000_000, maxDurationMs: 7_200_000,
  startsPerHourIp: 60, startsPerHourSession: 60, scoresPerHourIp: 30, scoresPerHourSession: 20,
  boardCacheMs: 30_000, topN: 10,
});

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function gameCfg(settings) {
  const x = { ...GAME_DEFAULTS, ...(((settings || {}).game) || {}) };
  return {
    enabled: typeof x.enabled === "boolean" ? x.enabled : true,
    leaderboardPeriod: PERIODS.includes(x.leaderboardPeriod) ? x.leaderboardPeriod : "week",
    maxScorePerSec: Math.round(clampN(x.maxScorePerSec, 10, 500, 45)),
  };
}

/* ── الأسبوع: من آخر سبت ٤:٠٠ الفجر الرياض (نفس أسابيع التقارير — bizday.js) ── */
export function weekStartOf(now = new Date(), weekStart = DEFAULT_WEEK_START) {
  const ws = Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : DEFAULT_WEEK_START;
  const day = bizDay(now);
  const back = (weekdayOf(day) - ws + 7) % 7;
  return bizStart(shiftDay(day, -back));
}
export const periodFrom = (period, now = new Date(), weekStart) => (period === "all" ? null : weekStartOf(now, weekStart));

/* ── توكن الجولة: base64url(JSON) + "." + HMAC-SHA256 ── */
const b64u = (buf) => Buffer.from(buf).toString("base64url");
export function gameSecret(env = process.env) {
  if (env.GAME_SECRET) return String(env.GAME_SECRET);
  return crypto.createHash("sha256").update("game:" + String(env.ADMIN_TOKEN || "")).digest("hex");
}
export function signToken(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}
/* بيرجّع الـpayload أو null (شكل غلط / توقيع غلط / قديم / من المستقبل) */
export function verifyToken(token, secret, now = Date.now(), maxAgeMs = LIMITS.tokenMaxAgeMs) {
  if (typeof token !== "string" || token.length > 600) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const want = crypto.createHmac("sha256", secret).update(parts[0]).digest();
  let got;
  try { got = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p !== "object" || typeof p.r !== "string" || !/^[a-f0-9]{16,64}$/.test(p.r) || !Number.isFinite(p.t)) return null;
  if (p.t > now + 60_000 || now - p.t > maxAgeMs) return null;
  return p;
}

export const ipHashOf = (ip, secret, now = new Date()) =>
  crypto.createHash("sha256").update(`${String(ip || "?")}|${secret}|${new Date(now).toISOString().slice(0, 10)}`).digest("hex").slice(0, 16);

/* ── الاسم الأول: كلمة واحدة ٢–٢٠ حرف عربي/لاتيني، من غير شتايم ولا أرقام ولا روابط ── */
const TASHKEEL = /[ً-ْٰـ]/g;      // تشكيل + تطويل
const LETTERS_ONLY = /^[A-Za-zء-غف-يٱ-ۓ]+$/;
const LINKISH = /[0-9٠-٩۰-۹@]|https?:|www\.|\.(com|net|org|sa|me|io|ly)\b|t\.me/i;
/* كلمات قصيرة: لازم تطابق الكلمة كلها (عشان «كساب» و«Cassidy» يعدّوا). طويلة: لو جوّه الكلمة. */
const BAD_EXACT = new Set([
  "كس", "كسي", "كسك", "زب", "زبي", "زق", "طيز", "نيك", "خول", "عرص", "كلب", "حمار", "خرا", "خره", "تيس", "بقره", "وسخ", "زفت", "غبي", "حقير", "قذر", "شاذ", "لوطي",
  "ass", "fag", "cum", "sex", "sexy", "xxx", "tit", "tits", "dick", "cock", "porn", "anal", "piss", "shit", "damn", "hoe",
]);
const BAD_PART = [
  "شرموط", "منيوك", "منيك", "متناك", "نياك", "قحبه", "عاهره", "ديوث", "قواد", "معرص", "خنيث", "مخنث", "زباله", "حيوان", "سافل", "منيوكه", "زبر", "كسمك", "كسختك",
  "يلعن", "لعنه", "ابنالكلب", "كلبه", "بزاز", "مكوه", "مومس", "انيك", "تنيك", "عرصه", "خوله", "تافه", "حماره",
  "fuck", "fuk", "phuk", "shit", "bitch", "biatch", "cunt", "pussy", "whore", "slut", "nigg", "faggot", "bastard", "asshole", "dildo", "penis", "vagina", "boob", "wank", "motherf", "retard", "rape", "hitler",
];
const normForBad = (s) => String(s || "").toLowerCase()
  .replace(TASHKEEL, "").replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
  .replace(/(.)\1+/g, "$1");
const BAD_EXACT_N = new Set([...BAD_EXACT].map(normForBad));
const BAD_PART_N = BAD_PART.map(normForBad);
export function isProfane(word) {
  const n = normForBad(word);
  if (!n) return false;
  return BAD_EXACT_N.has(n) || BAD_PART_N.some((b) => n.includes(b));
}
/* { name: الاسم النضيف أو null, rejected: true لو كان فيه اسم واترفض } */
export function cleanFirstName(raw) {
  const s = String(raw == null ? "" : raw).replace(/[​-‏‪-‮⁦-⁩]/g, "").trim();
  if (!s) return { name: null, rejected: false };
  if (s.length > 80 || LINKISH.test(s)) return { name: null, rejected: true };
  const words = s.split(/[\s,،._\-/\\|]+/).filter(Boolean);
  const first = words[0] || "";
  // «يا قحبة» / "fuck you": الشتيمة في أي كلمة ⇒ الاسم كله مرفوض، مش أول كلمة بس
  if (words.slice(0, 8).some((x) => isProfane(x.replace(TASHKEEL, "")))) return { name: null, rejected: true };
  const w = first.replace(TASHKEEL, "");
  if (w.length < 2 || w.length > 20 || !LETTERS_ONLY.test(w) || isProfane(w)) return { name: null, rejected: true };
  const name = /^[A-Za-z]+$/.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
  return { name, rejected: false };
}
/* الاسم من سجل العميل: أول كلمة، ولو مش نضيفة ⇒ null (مش «اترفض» — العميل ماكتبهوش) */
export const firstNameOfRecord = (full) => cleanFirstName(String(full || "").trim().split(/\s+/)[0] || "").name;

/* ── ضد الغش: أسباب العلامة (أولها اللي بيتسجّل) — صافي ── */
export function flagReasons({ score, durationMs, issuedAt, now, maxScorePerSec, allTimeBest = 0, allTimeRuns = 0 }) {
  const out = [];
  if (durationMs > (now - issuedAt) + LIMITS.wallSlackMs) out.push("duration_gt_wall");
  if (score > maxScorePerSec * durationMs / 1000 + LIMITS.rateSlack) out.push("score_rate");
  if (durationMs < LIMITS.minDurationMs && score > 0) out.push("too_short");
  if (allTimeRuns >= LIMITS.outlierMinRuns && allTimeBest > 0 && score > LIMITS.outlierFactor * allTimeBest) out.push("outlier");
  return out;
}

/* ── مفتاح اللاعب (نفس COALESCE بتاع الـSQL) ── */
export const playerKeyOf = (r) => (r.phone_norm ? r.phone_norm : r.device_id ? "d:" + r.device_id : r.session_id ? "s:" + r.session_id : "r:" + r.run_id);

/* ── اللوحة من الصفوف: لاعب واحد = صف واحد (أحسن نتيجة، والتعادل للأقدم)، من غير المعلَّم عليهم والفريق — صافي ── */
export function leaderboardOf(rows, { exclude = new Set(), topN = LIMITS.topN } = {}) {
  const best = new Map();
  for (const r of rows || []) {
    if (!r || r.flagged === true) continue;
    if (r.phone_norm && exclude.has(r.phone_norm)) continue;
    const k = r.pk || playerKeyOf(r);
    const score = Number(r.score) || 0;
    const at = new Date(r.created_at || 0).getTime();
    const cur = best.get(k);
    const runs = Number(r.runs) || 0;
    if (!cur) { best.set(k, { ...r, pk: k, score, _at: at, _runs: runs || 1, _name: r.first_name || r.any_name || null }); continue; }
    if (!runs) cur._runs += 1;
    if (!cur._name && (r.first_name || r.any_name)) cur._name = r.first_name || r.any_name;
    if (score > cur.score || (score === cur.score && at < cur._at)) {
      best.set(k, { ...r, pk: k, score, _at: at, _runs: cur._runs, _name: r.first_name || cur._name || r.any_name || null });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a._at - b._at).slice(0, topN)
    .map((r, i) => ({ rank: i + 1, firstName: r._name || null, score: r.score, pk: r.pk, runId: r.run_id, phone: r.phone_norm || null,
      runs: r._runs, durationMs: Number(r.duration_ms) || 0, bestAt: r.created_at ? new Date(r.created_at).toISOString() : null }));
}

export const maskPhone = (pn) => (/^5\d{8}$/.test(String(pn || "")) ? `05••••${String(pn).slice(-4)}` : null);
const fullPhone = (pn) => (/^5\d{8}$/.test(String(pn || "")) ? `0${pn}` : null);

/* الفريق + أرقام تجربة البوت ⇒ برا اللوحة. (المستثنين من الإعلانات بس = عملاء حقيقيين ⇒ بيظهروا.) */
const normLocal = (p) => { const d = String(p || "").replace(/\D/g, "").replace(/^00/, "").replace(/^966/, "").replace(/^0/, ""); return /^5\d{8}$/.test(d) ? d : null; };
export function excludedPhones(settings = {}) {
  const out = new Set();
  try { for (const p of teamPhoneSet(settings || {})) { const n = normLocal(p); if (n) out.add(n); } } catch { /* القايمة فشلت ⇒ مانوقفش اللوحة */ }
  const tp = (settings && settings.waBot && Array.isArray(settings.waBot.testPhones)) ? settings.waBot.testPhones : [];
  for (const t of tp) { const n = normLocal(t && typeof t === "object" ? t.phone : t); if (n) out.add(n); }
  return out;
}

const W_ORDER_RE = /^W\d{6,20}$/;
const SID_RE = /^[a-z0-9_-]{6,64}$/i;
const cleanId = (v) => (typeof v === "string" && SID_RE.test(v) ? v : null);

const TOP_SQL = `/*game:top*/
  WITH r AS (
    SELECT g.*, COALESCE(g.phone_norm, 'd:'||g.device_id, 's:'||g.session_id, 'r:'||g.run_id) AS pk
      FROM game_scores g
     WHERE NOT g.flagged AND ($1::timestamptz IS NULL OR g.created_at >= $1::timestamptz)
       AND (g.phone_norm IS NULL OR NOT (g.phone_norm = ANY($2::text[])))
  ), b AS (
    SELECT DISTINCT ON (pk) pk, run_id, phone_norm, device_id, session_id, first_name, score, duration_ms, created_at,
           count(*) OVER (PARTITION BY pk)::int AS runs,
           max(first_name) FILTER (WHERE first_name IS NOT NULL) OVER (PARTITION BY pk) AS any_name
      FROM r ORDER BY pk, score DESC, created_at ASC
  )
  SELECT * FROM b ORDER BY score DESC, created_at ASC LIMIT 50`;

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const isOwner = typeof ctx.isOwner === "function" ? ctx.isOwner : () => false;
  const accounts = () => (typeof deps.accounts === "function" ? deps.accounts() : deps.accounts || null);
  const secret = () => ctx.gameSecret || gameSecret();
  const nowMs = () => (typeof deps.now === "function" ? deps.now() : Date.now());
  const bad = (c, error, status = 400) => c.json({ ok: false, error }, status);

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_scores (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT UNIQUE,
        phone_norm TEXT,
        first_name TEXT,
        score INT NOT NULL DEFAULT 0,
        duration_ms INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_id TEXT,
        device_id TEXT,
        ip_hash TEXT,
        source TEXT,                 -- play | track
        order_no TEXT,
        flagged BOOLEAN NOT NULL DEFAULT FALSE,
        flag_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS game_scores_created_idx ON game_scores(created_at DESC);
      CREATE INDEX IF NOT EXISTS game_scores_score_idx ON game_scores(score DESC) WHERE NOT flagged;
    `);
  }
  const ready = ensureSchema().then(() => console.log("[game] ready"))
    .catch((e) => console.error("[game] init failed:", e.message));

  /* ── حدود في الذاكرة (زي openwait) ── */
  const buckets = new Map();
  function limited(key, max) {
    if (!key) return false;
    const now = nowMs(), slot = buckets.get(key);
    if (!slot || now - slot.start > 3600_000) { buckets.set(key, { start: now, n: 1 }); if (buckets.size > 20000) buckets.clear(); return false; }
    slot.n++;
    return slot.n > max;
  }
  const ipOf = (c) => String(c.req.header("cf-connecting-ip") || (c.req.header("x-forwarded-for") || "").split(",")[0] || "?").trim();
  const settingsOf = async () => { try { return (await getSettingsData()) || {}; } catch { return {}; } };
  const readJson = async (c) => { try { const b = await c.req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; } };

  /* ── مين بيلعب: جلسة المتجر > طلب W > ولا حد ── */
  async function nameFromHistory(pn) {
    const q = async (sql) => { try { return String((await pool.query(sql, [pn])).rows[0]?.n || "").trim(); } catch { return ""; } };
    let n = await q(`/*game:hist-order*/ SELECT customer->>'name' AS n FROM shop_orders WHERE phone_norm = $1
                      AND coalesce(customer->>'name','') NOT IN ('', 'عميل') ORDER BY created_at DESC LIMIT 1`);
    if (!n) n = await q(`/*game:hist-pos*/ SELECT name AS n FROM ts_customers WHERE phone_norm = $1 AND coalesce(name,'') <> '' ORDER BY updated_at DESC NULLS LAST LIMIT 1`);
    return n || null;
  }
  async function identityOf(c, ord) {
    let acct = null;
    if (/^Bearer cust:/i.test(c.req.header("Authorization") || "")) {
      try { acct = await accounts()?.customerOf?.(c); } catch { acct = null; }
    }
    if (acct && acct.phone_norm) {
      const full = acct.name && String(acct.name).trim() && acct.name !== "عميل" ? acct.name : await nameFromHistory(acct.phone_norm);
      return { known: true, via: "account", phone: acct.phone_norm, firstName: firstNameOfRecord(full) };
    }
    if (typeof ord === "string" && W_ORDER_RE.test(ord)) {
      const r = await pool.query(`/*game:order*/ SELECT phone_norm, customer->>'name' AS name FROM shop_orders
          WHERE order_no = $1 AND created_at > NOW() - INTERVAL '7 days'
            AND status NOT IN ('pending_payment','expired') LIMIT 1`, [ord]).catch(() => ({ rows: [] }));
      const o = r.rows[0];
      if (o && /^5\d{8}$/.test(String(o.phone_norm || ""))) return { known: true, via: "order", phone: o.phone_norm, firstName: firstNameOfRecord(o.name) };
    }
    return { known: false, via: null, phone: null, firstName: null };
  }

  /* ── اللوحة: كاش ٣٠ ث لكل فترة ── */
  const boardCache = new Map();
  async function topRows(period, s, now = new Date(nowMs())) {
    const from = periodFrom(period, now, s.reportWeekStart);
    const exclude = excludedPhones(s);
    const rows = (await pool.query(TOP_SQL, [from ? from.toISOString() : null, [...exclude]])).rows;
    return { from, top: leaderboardOf(rows, { exclude }) };
  }
  async function board(period, s, { fresh = false } = {}) {
    const hit = boardCache.get(period);
    if (!fresh && hit && nowMs() - hit.at < LIMITS.boardCacheMs) return hit.value;
    const value = await topRows(period, s);
    boardCache.set(period, { at: nowMs(), value });
    return value;
  }
  const publicTop = (top) => top.map((r) => ({ rank: r.rank, firstName: r.firstName || null, score: r.score }));

  app.get("/api/game/config", async (c) => {
    const cfg = gameCfg(await settingsOf());
    return c.json({ ok: true, enabled: cfg.enabled, period: cfg.leaderboardPeriod });
  });

  app.post("/api/game/start", async (c) => {
    const s = await settingsOf();
    const cfg = gameCfg(s);
    if (!cfg.enabled) return bad(c, "disabled", 503);
    const b = (await readJson(c)) || {};
    const sec = secret();
    const ih = ipHashOf(ipOf(c), sec, new Date(nowMs()));
    const sid = cleanId(b.sid) || cleanId(b.dev);
    if (limited("st:ip:" + ih, LIMITS.startsPerHourIp) || limited(sid ? "st:s:" + sid : null, LIMITS.startsPerHourSession)) return bad(c, "rate_limited", 429);
    const id = await identityOf(c, b.ord);
    const token = signToken({ r: crypto.randomBytes(12).toString("hex"), t: nowMs(), ih: ih.slice(0, 8), s: b.src === "track" ? "track" : "play" }, sec);
    return c.json({ ok: true, enabled: true, token, maxScorePerSec: cfg.maxScorePerSec, period: cfg.leaderboardPeriod, known: id.known, firstName: id.firstName || null });
  });

  app.post("/api/game/score", async (c) => {
    const s = await settingsOf();
    const cfg = gameCfg(s);
    if (!cfg.enabled) return bad(c, "disabled", 503);
    const b = await readJson(c);
    if (!b) return bad(c, "bad_json");
    const sec = secret();
    const now = nowMs();
    const ih = ipHashOf(ipOf(c), sec, new Date(now));
    const sid = cleanId(b.sid) || cleanId(b.dev);
    if (limited("sc:ip:" + ih, LIMITS.scoresPerHourIp) || limited(sid ? "sc:s:" + sid : null, LIMITS.scoresPerHourSession)) return bad(c, "rate_limited", 429);
    const tk = verifyToken(b.token, sec, now);
    if (!tk) return bad(c, "bad_token");
    const score = b.score, durationMs = b.durationMs;
    if (!Number.isInteger(score) || score < 0 || score > LIMITS.maxScore || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > LIMITS.maxDurationMs) return bad(c, "bad_score");

    const id = await identityOf(c, b.ord);
    let firstName = null, nameRejected = false;
    if (id.known) firstName = id.firstName || null;
    else { const n = cleanFirstName(b.firstName); firstName = n.name; nameRejected = n.rejected; }

    let allTimeBest = 0, allTimeRuns = 0;
    try {
      const a = (await pool.query("/*game:alltime*/ SELECT count(*)::int AS n, COALESCE(max(score),0)::int AS best FROM game_scores WHERE NOT flagged")).rows[0] || {};
      allTimeBest = Number(a.best) || 0; allTimeRuns = Number(a.n) || 0;
    } catch { /* مفيش مرجع ⇒ قاعدة outlier بس اللي بتقع */ }
    const reasons = flagReasons({ score, durationMs, issuedAt: tk.t, now, maxScorePerSec: cfg.maxScorePerSec, allTimeBest, allTimeRuns });
    const flagged = reasons.length > 0;
    const src = b.src === "track" || b.src === "play" ? b.src : (tk.s === "track" ? "track" : "play");
    const ord = typeof b.ord === "string" && W_ORDER_RE.test(b.ord) ? b.ord : null;
    const dev = cleanId(b.dev), sess = cleanId(b.sid);

    const ins = await pool.query(
      `/*game:insert*/ INSERT INTO game_scores(run_id, phone_norm, first_name, score, duration_ms, session_id, device_id, ip_hash, source, order_no, flagged, flag_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (run_id) DO NOTHING RETURNING id, created_at`,
      [tk.r, id.phone, firstName, score, durationMs, sess, dev, ih, src, ord, flagged, flagged ? reasons.join(",") : null]);
    if (!ins.rowCount) return bad(c, "bad_token");      // التوكن اتستخدم قبل كده

    const period = cfg.leaderboardPeriod;
    let rank = null, best = score;
    try {
      const v = await board(period, s, { fresh: true });
      const me = v.top.find((r) => r.runId === tk.r);
      rank = flagged || !me ? null : me.rank;
      const from = v.from;
      const [col, val] = id.phone ? ["phone_norm", id.phone] : dev ? ["device_id", dev] : sess ? ["session_id", sess] : ["run_id", tk.r];
      const keyCond = id.phone ? "phone_norm = $1" : `phone_norm IS NULL AND ${col} = $1`;
      const q = (await pool.query(`/*game:best*/ SELECT COALESCE(max(score),0)::int AS best FROM game_scores
          WHERE NOT flagged AND ${keyCond} AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`, [val, from ? from.toISOString() : null])).rows[0];
      best = Math.max(Number(q && q.best) || 0, flagged ? score : 0);
      if (!flagged) best = Math.max(best, score);
    } catch (e) { console.error("[game] rank failed:", e.message); }
    const out = { ok: true, saved: true, firstName, rank, best };
    if (nameRejected) out.nameRejected = true;
    return c.json(out);
  });

  app.get("/api/game/leaderboard", async (c) => {
    const s = await settingsOf();
    const cfg = gameCfg(s);
    const q = String(c.req.query("period") || "");
    const period = PERIODS.includes(q) ? q : cfg.leaderboardPeriod;
    try {
      const v = await board(period, s);
      return c.json({ ok: true, period, from: v.from ? v.from.toISOString() : null, top: publicTop(v.top) });
    } catch (e) {
      console.error("[game] leaderboard failed:", e.message);
      return c.json({ ok: false, error: "unavailable" }, 500);
    }
  });

  /* ── المالك ── */
  app.get("/api/cms/game", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await settingsOf();
    const cfg = gameCfg(s);
    const now = new Date(nowMs());
    const from = weekStartOf(now, s.reportWeekStart);
    const to = new Date(from.getTime() + 7 * 86400_000);
    const today = bizStart(bizDay(now));
    const owner = Boolean(isOwner(c));
    const v = await topRows("week", s, now);
    const top = v.top.map((r) => ({
      rank: r.rank, firstName: r.firstName || null, score: r.score,
      phone: r.phone ? (owner ? fullPhone(r.phone) : maskPhone(r.phone)) : null, phoneKnown: Boolean(r.phone),
      runs: r.runs, durationMs: r.durationMs, bestAt: r.bestAt,
    }));
    const st = (await pool.query(`/*game:stats*/ SELECT
        count(*) FILTER (WHERE created_at >= $2::timestamptz)::int AS runs_today,
        count(*)::int AS runs_week,
        count(DISTINCT COALESCE(phone_norm, 'd:'||device_id, 's:'||session_id, 'r:'||run_id)) FILTER (WHERE NOT flagged)::int AS players_week,
        count(*) FILTER (WHERE flagged)::int AS flagged_week,
        count(DISTINCT COALESCE(phone_norm, 'd:'||device_id, 's:'||session_id, 'r:'||run_id)) FILTER (WHERE NOT flagged AND first_name IS NOT NULL)::int AS named_week
      FROM game_scores WHERE created_at >= $1::timestamptz`, [from.toISOString(), today.toISOString()])).rows[0] || {};
    const fl = (await pool.query(`/*game:flagged*/ SELECT id, first_name, score, duration_ms, flag_reason, created_at
        FROM game_scores WHERE flagged ORDER BY created_at DESC LIMIT 20`)).rows;
    return c.json({
      ok: true, config: cfg, defaults: GAME_DEFAULTS, labels: GAME_LABELS,
      week: { from: from.toISOString(), to: to.toISOString() },
      top,
      stats: { runsToday: Number(st.runs_today) || 0, runsWeek: Number(st.runs_week) || 0, playersWeek: Number(st.players_week) || 0,
        flaggedWeek: Number(st.flagged_week) || 0, namedWeek: Number(st.named_week) || 0 },
      flagged: fl.map((r) => ({ id: Number(r.id), firstName: r.first_name || null, score: Number(r.score) || 0, durationMs: Number(r.duration_ms) || 0,
        reason: r.flag_reason || null, createdAt: r.created_at ? new Date(r.created_at).toISOString() : null })),
    });
  });

  app.put("/api/cms/game", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await readJson(c);
    if (!b) return bad(c, "bad json");
    const val = gameCfg({ game: b });
    await pool.query(`UPDATE settings SET data = jsonb_set(data, '{game}', $1::jsonb, true) WHERE id=1`, [jb(val)]);
    boardCache.clear();
    return c.json({ ok: true, config: val });
  });

  console.log("[game] routes registered");
  return { ready, board, _buckets: buckets, _boardCache: boardCache };
}
