/* ═══════════════════════════════════════════════════════════════════════════
   CMS — فريق لوحة المتجر: مستخدمين، أدوار، صلاحيات، وسجل نشاط (2026-09-11)

   قرار عمر: «فريق كامل بأدوار» من أول يوم — تسويق، عمليات، محاسبة، مطبخ —
   وكل واحد يشوف اللي يخصّه بس.

   الفكرة الأساسية: كل موديول قديم محمي بـ requireAdmin اللي كان بيقبل مفتاح
   أدمن واحد مشترك. بدل ما نعدّل ٤٠ موديول، index.js بقى بينده الهوكس هنا:
     • مفتاح الأدمن القديم  → بيعدّي زي ما هو (المالك) + سطر في السجل.
     • توكن فريق  cms:<id>:<hex> → بنجيب المستخدم، نعرف «قسم» المسار من
       PATH_SECTIONS، ونقارن بصلاحية دوره: GET/HEAD محتاجة «عرض»، أي كتابة
       محتاجة «تعديل». غير كده 403 واضحة فيها القسم والصلاحية المطلوبة.
   مستخدم دوره «مالك» = أدمن كامل حتى في المسارات القديمة اللي بتقرا getAuth
   مباشرة (السفراء/الكاشير): جلساته محفوظة في الذاكرة ومتحمّلة وقت الإقلاع،
   فـ getAuth المتزامنة تقدر تتعرّف عليه (isOwnerSync).

   المسارات اللي مش متصنّفة بتقع على «الإعدادات» (المالك بس) — الرفض هو
   الافتراضي، فأي موديول جديد مايتفتحش لدور غلط بالغلط.

   الباسوردات scrypt بملح لكل مستخدم، والجلسات مخزّنة كـ sha256 بس — التوكن
   نفسه مايتحفظش في الداتابيز. السجل بيكتب المسار والطريقة بس، من غير الجسم،
   عشان مايتسجّلش باسورد ولا بيانات حساسة.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const CACHE_MS = 10 * 60 * 1000;

export const SECTIONS = [
  { id: "home", label: "الرئيسية", icon: "📈" },
  { id: "growth", label: "النمو والاكتساب", icon: "🚀" },
  { id: "orders", label: "الطلبات", icon: "🧾" },
  { id: "products", label: "المنتجات", icon: "🍔" },
  { id: "customers", label: "العملاء", icon: "👥" },
  { id: "discounts", label: "الخصومات", icon: "🎟" },
  { id: "delivery", label: "التوصيل", icon: "🛵" },
  { id: "analytics", label: "التحليلات", icon: "📊" },
  { id: "finance", label: "المالية", icon: "💰" },
  { id: "settings", label: "الإعدادات والفريق", icon: "⚙️" },
];
const SECTION_IDS = SECTIONS.map((s) => s.id);

export const ROLES = [
  { id: "owner", label: "المالك", hint: "كل حاجة — تعديل كامل، مايتقلّش" },
  { id: "marketing", label: "تسويق", hint: "النمو والإعلانات والمنتجات والعملاء والخصومات" },
  { id: "operations", label: "عمليات", hint: "الطلبات والتوصيل" },
  { id: "accounting", label: "محاسبة", hint: "المالية + عرض الأرقام" },
  { id: "kitchen", label: "مطبخ / كاشير", hint: "الطلبات وحالاتها بس" },
];
const ROLE_IDS = ROLES.map((r) => r.id);

const E = "edit", V = "view", N = "none";
const LEVELS = [N, V, E];
const all = (lvl) => Object.fromEntries(SECTION_IDS.map((s) => [s, lvl]));

export const DEFAULT_PERMS = {
  owner: all(E),
  marketing: { home: V, growth: E, orders: V, products: E, customers: E, discounts: E, delivery: N, analytics: V, finance: N, settings: N },
  operations: { home: V, growth: N, orders: E, products: V, customers: V, discounts: V, delivery: E, analytics: V, finance: N, settings: N },
  accounting: { home: V, growth: V, orders: V, products: N, customers: N, discounts: V, delivery: V, analytics: V, finance: E, settings: N },
  kitchen: { home: N, growth: N, orders: E, products: N, customers: N, discounts: N, delivery: V, analytics: N, finance: N, settings: N },
};

/* مسار → قسم. أول تطابق بيكسب، والترتيب مقصود: المحدد قبل العام
   (keeta-payouts مالية قبل keeta تحليلات، coupons خصومات قبل shop). */
const PATH_SECTIONS = [
  [/^\/api\/cms\/(users|roles|audit)/, "settings"],
  [/^\/api\/cms\/home/, "home"],
  [/^\/api\/cms\/(products|catalog)/, "products"],
  [/^\/api\/cms\/growth/, "growth"],
  [/^\/api\/cms\/(customers|segments|loyalty|campaigns)/, "customers"],
  [/^\/api\/cms\/(analytics|exec)/, "analytics"],
  [/^\/api\/cms\/(ops|sla)/, "orders"],
  [/^\/api\/(shop\/coupons|discounts)/, "discounts"],
  [/^\/api\/(finance|keeta-payouts|costing|staff-meals|staff_meals|pay\/|influencer-payments)/, "finance"],
  [/^\/api\/delivery/, "delivery"],
  [/^\/api\/groups/, "customers"],
  [/^\/api\/(shop\/(orders|board|summary)|day\b|day\/|staff\/|cashier|chef|notifications)/, "orders"],
  [/^\/api\/(ads|autopilot|attribution|funnel|audiences|retargeting|retarget|marketing|content|social|promo|catalog|tracking|offers|carts|menuplan|scorecard|ai\/|chat)/, "growth"],
  [/^\/api\/(customers|account\/admin)/, "customers"],
  [/^\/api\/(analytics|reports|insights|keeta-reports|hungerstation|ninja|keeta\b|keeta\/)/, "analytics"],
];
export function sectionOf(path) {
  for (const [re, s] of PATH_SECTIONS) if (re.test(path)) return s;
  return "settings";
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

async function hashPassword(plain, salt) {
  const buf = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${buf.toString("hex")}`;
}
async function verifyPassword(plain, salt, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  let want;
  try { want = Buffer.from(parts[4], "hex"); } catch { return false; }
  let got;
  try { got = await scryptAsync(String(plain), salt, want.length, { N, r, p }); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const rl = new Map();
function loginLimited(ip) {
  const now = Date.now(), slot = rl.get(ip);
  if (!slot || now - slot.start > 15 * 60_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > 10;
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;

  /* جلسات في الذاكرة: token_hash → { user, exp }. مليانة وقت الإقلاع بكل
     الجلسات السارية، فـ isOwnerSync بتشتغل حتى بعد أي نشر/إعادة تشغيل. */
  const sessions = new Map();

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cms_users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'marketing',
        pass_salt TEXT NOT NULL,
        pass_hash TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        must_change BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS cms_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INT NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS cms_sessions_user_idx ON cms_sessions(user_id);
      CREATE TABLE IF NOT EXISTS cms_audit (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id INT,
        actor_name TEXT,
        role TEXT,
        method TEXT,
        path TEXT,
        section TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS cms_audit_at_idx ON cms_audit(at DESC);
    `);
    const r = await pool.query(
      `SELECT s.token_hash, s.expires_at, u.id, u.username, u.name, u.role, u.active
         FROM cms_sessions s JOIN cms_users u ON u.id = s.user_id
        WHERE s.expires_at > NOW() AND u.active`);
    for (const row of r.rows) {
      sessions.set(row.token_hash, { user: publicUser(row), exp: Date.now() + CACHE_MS });
    }
    await pool.query("DELETE FROM cms_sessions WHERE expires_at < NOW()");
  }
  ensureSchema()
    .then(() => console.log(`[cms] schema ready — ${sessions.size} live team session(s)`))
    .catch((e) => console.error("[cms] schema failed:", e.message));

  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });
  const OWNER_KEY = { id: 0, username: "admin", name: "المالك", role: "owner", adminKey: true };

  /* الصلاحيات الفعلية: الافتراضي + تعديلات المالك (settings.data.cms.perms).
     المالك دايماً «تعديل» في كل حاجة — مفيش حد يقدر يقفل الباب على نفسه. */
  let permsCache = { at: 0, perms: null };
  async function effectivePerms() {
    if (permsCache.perms && Date.now() - permsCache.at < 30_000) return permsCache.perms;
    const over = (((await getSettingsData()) || {}).cms || {}).perms || {};
    const out = {};
    for (const role of ROLE_IDS) {
      const base = { ...DEFAULT_PERMS[role] };
      for (const s of SECTION_IDS) {
        const v = over?.[role]?.[s];
        if (LEVELS.includes(v)) base[s] = v;
      }
      out[role] = role === "owner" ? all(E) : base;
    }
    permsCache = { at: Date.now(), perms: out };
    return out;
  }

  const bearer = (c) => {
    const h = c.req.header("Authorization") || "";
    return h.startsWith("Bearer ") ? h.slice(7) : "";
  };

  async function sessionUser(token) {
    if (!token || !token.startsWith("cms:")) return null;
    const th = sha(token);
    const hit = sessions.get(th);
    if (hit && hit.exp > Date.now()) return hit.user;
    const r = await pool.query(
      `SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at
         FROM cms_sessions s JOIN cms_users u ON u.id = s.user_id
        WHERE s.token_hash = $1`, [th]);
    const row = r.rows[0];
    if (!row || !row.active || new Date(row.expires_at) < new Date()) { sessions.delete(th); return null; }
    const user = publicUser(row);
    sessions.set(th, { user, exp: Date.now() + CACHE_MS });
    pool.query("UPDATE cms_sessions SET last_seen_at=NOW() WHERE token_hash=$1", [th]).catch(() => {});
    return user;
  }

  function isOwnerSync(token) {
    const hit = sessions.get(sha(token));
    return Boolean(hit && hit.user.role === "owner");
  }

  const isWrite = (c) => !["GET", "HEAD", "OPTIONS"].includes(c.req.method);

  function writeAudit(actor, c, section, note) {
    pool.query(
      `INSERT INTO cms_audit(actor_id, actor_name, role, method, path, section, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.id || null, actor.name || null, actor.role || null, c.req.method,
       String(c.req.path).slice(0, 300), section, note || null])
      .catch(() => {});
  }

  /* هوك requireAdmin: رجوع true = مسموح، Response = رفض، null = مش توكن فريق. */
  async function resolve(c) {
    const token = bearer(c);
    if (!token.startsWith("cms:")) return null;
    const user = await sessionUser(token);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const section = sectionOf(c.req.path);
    const need = isWrite(c) ? E : V;
    const level = (await effectivePerms())[user.role]?.[section] || N;
    const ok = level === E || (level === V && need === V);
    if (!ok) {
      return c.json({ error: "forbidden", section, need,
        message: `دورك (${user.role}) مالوش صلاحية ${need === E ? "تعديل" : "عرض"} في «${section}»` }, 403);
    }
    if (need === E) writeAudit(user, c, section);
    return true;
  }

  /* مفتاح الأدمن (أو مالك الفريق) عدّى — نسجّل الكتابات بس. */
  function auditHook(c, auth) {
    if (!isWrite(c)) return;
    const token = bearer(c);
    const hit = auth && auth.cms ? sessions.get(sha(token)) : null;
    const actor = hit ? hit.user : { id: null, name: "المالك (مفتاح الأدمن)", role: "owner" };
    writeAudit(actor, c, sectionOf(c.req.path));
  }

  ctx.setCmsHooks?.({ resolve, audit: auditHook, isOwnerSync });

  /* مين أنا؟ — الشِل بيناديها أول ما يفتح (وده كمان بيسخّن الجلسة). */
  async function whoami(c) {
    const token = bearer(c);
    if (!token) return null;
    const auth = (await requireAdmin(c)) === null;
    const user = await sessionUser(token);
    if (user) return user;
    return auth ? OWNER_KEY : null;
  }

  app.get("/api/cms/me", async (c) => {
    const token = bearer(c);
    let user = token.startsWith("cms:") ? await sessionUser(token) : null;
    if (!user) {
      const denied = await requireAdmin(c);
      if (denied) return denied;
      user = OWNER_KEY;
    }
    const perms = (await effectivePerms())[user.role] || all(N);
    return c.json({ ok: true, user, perms, sections: SECTIONS, roles: ROLES });
  });

  app.post("/api/cms/login", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (loginLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const username = String(b.username || "").trim().toLowerCase();
    const r = await pool.query("SELECT * FROM cms_users WHERE lower(username)=$1", [username]);
    const u = r.rows[0];
    // نفس الرد للمستخدم الغلط والباسورد الغلط — مانقولش أنهي فيهم.
    if (!u || !u.active || !(await verifyPassword(b.password || "", u.pass_salt, u.pass_hash))) {
      return c.json({ ok: false, error: "invalid_credentials" }, 401);
    }
    const token = `cms:${u.id}:${crypto.randomBytes(32).toString("hex")}`;
    const th = sha(token);
    await pool.query(
      `INSERT INTO cms_sessions(token_hash, user_id, expires_at, user_agent)
       VALUES ($1,$2,NOW() + INTERVAL '${SESSION_DAYS} days',$3)`,
      [th, u.id, String(c.req.header("user-agent") || "").slice(0, 200)]);
    await pool.query("UPDATE cms_users SET last_login_at=NOW() WHERE id=$1", [u.id]);
    const user = publicUser(u);
    sessions.set(th, { user, exp: Date.now() + CACHE_MS });
    writeAudit(user, c, "settings", "login");
    return c.json({ ok: true, token, user, mustChange: u.must_change });
  });

  app.post("/api/cms/logout", async (c) => {
    const token = bearer(c);
    if (token.startsWith("cms:")) {
      const th = sha(token);
      sessions.delete(th);
      await pool.query("DELETE FROM cms_sessions WHERE token_hash=$1", [th]).catch(() => {});
    }
    return c.json({ ok: true });
  });

  app.post("/api/cms/password", async (c) => {
    const user = await sessionUser(bearer(c));
    if (!user) return c.json({ ok: false, error: "team_account_only" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const next = String(b.next || "");
    if (next.length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
    const u = (await pool.query("SELECT * FROM cms_users WHERE id=$1", [user.id])).rows[0];
    if (!u || !(await verifyPassword(b.current || "", u.pass_salt, u.pass_hash))) {
      return c.json({ ok: false, error: "wrong_current" }, 401);
    }
    const salt = crypto.randomBytes(16).toString("hex");
    await pool.query("UPDATE cms_users SET pass_salt=$2, pass_hash=$3, must_change=FALSE WHERE id=$1",
      [u.id, salt, await hashPassword(next, salt)]);
    writeAudit(user, c, "settings", "password_changed");
    return c.json({ ok: true });
  });

  /* ── إدارة الفريق (قسم الإعدادات = المالك افتراضياً) ── */
  app.get("/api/cms/users", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT u.id, u.username, u.name, u.role, u.active, u.must_change, u.created_at, u.last_login_at,
              (SELECT count(*)::int FROM cms_sessions s WHERE s.user_id=u.id AND s.expires_at > NOW()) AS live_sessions
         FROM cms_users u ORDER BY u.active DESC, u.created_at`)).rows;
    return c.json({ ok: true, users: rows, roles: ROLES });
  });

  app.post("/api/cms/users", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const username = String(b.username || "").trim().toLowerCase();
    const name = String(b.name || "").trim().slice(0, 60);
    const role = ROLE_IDS.includes(b.role) ? b.role : null;
    const password = String(b.password || "");
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return c.json({ ok: false, error: "bad_username" }, 400);
    if (!name || !role) return c.json({ ok: false, error: "name_and_role_required" }, 400);
    if (password.length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
    const salt = crypto.randomBytes(16).toString("hex");
    try {
      const r = await pool.query(
        `INSERT INTO cms_users(username, name, role, pass_salt, pass_hash, must_change)
         VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id, username, name, role, active, must_change, created_at`,
        [username, name, role, salt, await hashPassword(password, salt)]);
      return c.json({ ok: true, user: r.rows[0] });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return c.json({ ok: false, error: "username_taken" }, 409);
      throw e;
    }
  });

  app.put("/api/cms/users/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const sets = [], vals = [id];
    if (b.name != null) { vals.push(String(b.name).trim().slice(0, 60)); sets.push(`name=$${vals.length}`); }
    if (b.role != null) {
      if (!ROLE_IDS.includes(b.role)) return c.json({ ok: false, error: "bad_role" }, 400);
      vals.push(b.role); sets.push(`role=$${vals.length}`);
    }
    if (b.active != null) { vals.push(b.active === true); sets.push(`active=$${vals.length}`); }
    if (b.password) {
      if (String(b.password).length < 8) return c.json({ ok: false, error: "password_too_short" }, 400);
      const salt = crypto.randomBytes(16).toString("hex");
      vals.push(salt); sets.push(`pass_salt=$${vals.length}`);
      vals.push(await hashPassword(b.password, salt)); sets.push(`pass_hash=$${vals.length}`);
      sets.push("must_change=TRUE");
    }
    if (!sets.length) return c.json({ ok: false, error: "nothing_to_update" }, 400);
    const r = await pool.query(
      `UPDATE cms_users SET ${sets.join(", ")} WHERE id=$1
       RETURNING id, username, name, role, active, must_change`, vals);
    if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
    // دور اتغيّر / حساب اتقفل / باسورد اتغيّر → الجلسات القديمة بتسقط فوراً
    if (b.role != null || b.active === false || b.password) {
      await pool.query("DELETE FROM cms_sessions WHERE user_id=$1", [id]);
      for (const [th, s] of sessions) if (s.user.id === id) sessions.delete(th);
    }
    return c.json({ ok: true, user: r.rows[0] });
  });

  app.delete("/api/cms/users/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    await pool.query("DELETE FROM cms_users WHERE id=$1", [id]);
    for (const [th, s] of sessions) if (s.user.id === id) sessions.delete(th);
    return c.json({ ok: true });
  });

  app.get("/api/cms/roles", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, roles: ROLES, sections: SECTIONS, defaults: DEFAULT_PERMS, perms: await effectivePerms() });
  });

  app.put("/api/cms/roles", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const clean = {};
    for (const role of ROLE_IDS) {
      if (role === "owner") continue;
      clean[role] = {};
      for (const s of SECTION_IDS) {
        const v = b?.perms?.[role]?.[s];
        clean[role][s] = LEVELS.includes(v) ? v : DEFAULT_PERMS[role][s];
      }
    }
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END,
         '{cms,perms}', $1::jsonb, true) WHERE id=1`, [jb(clean)]);
    permsCache = { at: 0, perms: null };
    return c.json({ ok: true, perms: await effectivePerms() });
  });

  app.get("/api/cms/audit", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
    const rows = (await pool.query(
      `SELECT id, at, actor_id, actor_name, role, method, path, section, note
         FROM cms_audit ORDER BY at DESC LIMIT $1`, [limit])).rows;
    return c.json({ ok: true, rows });
  });

  console.log("[cms] routes ready");
  return { sectionOf, effectivePerms, sessionUser, whoami };
}
