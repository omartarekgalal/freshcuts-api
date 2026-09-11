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
// نفس قواعد الهوية والقناة اللي المؤشرات بتستخدمها — مفيش نسخة تانية
import { IDENT_SQL, SALES_ONLY, deliverySql } from "./analytics.js";

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
  [/^\/api\/cms\/(products|catalog|collections)/, "products"],
  [/^\/api\/cms\/(growth|links)/, "growth"],
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

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, DEFAULT_DELIVERY_APPS } = ctx;

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
      -- الطبقة التسويقية فوق كتالوج تاب سينس (الأسماء والأسعار منهم، مابنلمسهاش)
      CREATE TABLE IF NOT EXISTS cms_products (
        product_id TEXT PRIMARY KEY,
        image TEXT,
        description TEXT,
        description_en TEXT,
        badge TEXT,
        seo_title TEXT,
        seo_description TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS cms_collections (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        name_en TEXT,
        product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        sort INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- روابط الحملات: freshcuts.sa/l/<slug>
      CREATE TABLE IF NOT EXISTS cms_links (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        label TEXT,
        target_type TEXT NOT NULL DEFAULT 'home',
        target_id TEXT,
        coupon TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        clicks INT NOT NULL DEFAULT 0,
        last_click_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT
      );
      -- الحملات: رسالة لشريحة (إشعار مجاني أو SMS تسويقي)
      CREATE TABLE IF NOT EXISTS cms_campaigns (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        segment TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'push',
        message TEXT NOT NULL,
        coupon TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        audience INT,
        sent INT NOT NULL DEFAULT 0,
        failed INT NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        sent_by TEXT,
        last_error TEXT
      );
      -- كود إلغاء الاشتراك لكل رقم (شرط هيئة الاتصالات لرسائل الإعلانات)
      CREATE TABLE IF NOT EXISTS cms_contacts (
        phone_norm TEXT PRIMARY KEY,
        optout_code TEXT UNIQUE NOT NULL,
        opted_out_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS cms_sms_daily (
        day DATE PRIMARY KEY,
        n INT NOT NULL DEFAULT 0
      );
      -- دفتر مكافآت الولاء: مكافأة واحدة لكل (رقم، رقم المكافأة) — مفيش تكرار
      CREATE TABLE IF NOT EXISTS cms_loyalty (
        phone_norm TEXT NOT NULL,
        reward_no INT NOT NULL,
        coupon TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (phone_norm, reward_no)
      );
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

  /* ═══ المرحلة ٢: المنتجات (طبقة تسويقية) + التجميعات + روابط الحملات ═══

     المنتجات: تاب سينس هو المصدر للأسماء والأسعار. إحنا بنخزّن «اللبس» بس
     (صورة/وصف/شارة/SEO)، والبروكسي بيدمجه في /api/menu — فبيوصل للموقع
     ولكتالوج ميتا (catalog.js بيقرا من هناك) في نفس الوقت.
     الإخفاء بيتكتب في settings.catalog.hiddenIds — نفس المكان اللي المتجر
     بيقرا منه أصلاً، عشان مايبقاش فيه مفتاحين إخفاء بيتخانقوا. */
  const STORE_BASE = () => (process.env.CATALOG_MENU_BASE || process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const clip = (v, n) => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };
  const okImage = (u) => !u || /^https:\/\/[^\s"'<>]+$/i.test(u);
  const who = async (c) => {
    const t = bearer(c);
    if (t.startsWith("cms:")) { const u = await sessionUser(t); if (u) return u.name; }
    return "المالك";
  };

  // المنيو الخام من البروكسي (raw=1 = من غير طبقتنا) — كاش دقيقة
  let rawMenu = { at: 0, items: null };
  async function menuItems() {
    if (rawMenu.items && Date.now() - rawMenu.at < 60_000) return rawMenu.items;
    const r = await fetch(`${STORE_BASE()}/api/menu?branch_id=1&raw=1`, {
      signal: AbortSignal.timeout(15000), headers: { "User-Agent": "freshcuts-cms" } });
    if (!r.ok) throw new Error(`menu HTTP ${r.status}`);
    const pages = (await r.json())?.data?.pages || [];
    // صفحات «الأكثر طلباً/العروض» بتكرر أصناف موجودة في قسمها الحقيقي — نقرا
    // الأقسام الحقيقية الأول عشان الصنف ياخد قسمه الصح.
    const MERCH = /best|الأكثر|offers|العروض/i;
    const rank = (p) => (MERCH.test(`${p.title || ""} ${p.local_title || ""}`) ? 1 : 0);
    const seen = new Set(), items = [];
    for (const p of [...pages].sort((a, b) => rank(a) - rank(b))) {
      const category = p.local_title || p.title || "";
      for (const it of p.items || []) {
        const id = String(it.id);
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({
          id, name: it.name || it.local_name || "", name_en: it.local_name || "", category,
          price: Number(it.retail_price != null ? it.retail_price : it.price) || 0,
          image: it.image || "", description: it.description || "", description_en: it.local_description || "",
        });
      }
    }
    rawMenu = { at: Date.now(), items };
    return items;
  }

  let overlayCache = { at: 0, data: null };
  const bustOverlay = () => { overlayCache = { at: 0, data: null }; };
  async function buildOverlay() {
    if (overlayCache.data && Date.now() - overlayCache.at < 30_000) return overlayCache.data;
    const [p, cl] = await Promise.all([
      pool.query("SELECT product_id, image, description, description_en, badge FROM cms_products"),
      pool.query("SELECT id, name, name_en, product_ids FROM cms_collections WHERE active ORDER BY sort, id"),
    ]);
    const items = {};
    for (const r of p.rows) {
      const o = {};
      if (r.image) o.image = r.image;
      if (r.description) o.description = r.description;
      if (r.description_en) o.description_en = r.description_en;
      if (r.badge) o.badge = r.badge;
      if (Object.keys(o).length) items[r.product_id] = o;
    }
    const collections = cl.rows.map((r) => ({
      id: r.id, name: r.name, name_en: r.name_en || "", product_ids: (r.product_ids || []).map(String) }));
    overlayCache = { at: Date.now(), data: { ok: true, items, collections } };
    return overlayCache.data;
  }

  // عام عن قصد: البروكسي بيقراه من غير توكن ويدمجه في /api/menu.
  app.get("/api/cms/catalog-overlay", async (c) => {
    try { return c.json(await buildOverlay()); }
    catch (e) { return c.json({ ok: false, items: {}, collections: [], error: e.message }); }
  });

  app.get("/api/cms/products", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let items;
    try { items = await menuItems(); }
    catch (e) { return c.json({ ok: false, error: "menu_unavailable", message: e.message, items: [], collections: [] }); }
    const [ov, cl, s] = await Promise.all([
      pool.query("SELECT * FROM cms_products"),
      pool.query("SELECT * FROM cms_collections ORDER BY sort, id"),
      getSettingsData(),
    ]);
    const byId = Object.fromEntries(ov.rows.map((r) => [r.product_id, r]));
    const hidden = new Set(((s?.catalog || {}).hiddenIds || []).map(String));
    return c.json({
      ok: true,
      items: items.map((it) => {
        const o = byId[it.id];
        return {
          ...it, hidden: hidden.has(it.id),
          overlay: o ? {
            image: o.image || "", description: o.description || "", description_en: o.description_en || "",
            badge: o.badge || "", seo_title: o.seo_title || "", seo_description: o.seo_description || "",
          } : null,
        };
      }),
      collections: cl.rows.map((r) => ({ ...r, product_ids: (r.product_ids || []).map(String) })),
    });
  });

  app.put("/api/cms/products/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = String(c.req.param("id")).slice(0, 64);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const f = {
      image: clip(b.image, 500), description: clip(b.description, 600), description_en: clip(b.description_en, 600),
      badge: clip(b.badge, 40), seo_title: clip(b.seo_title, 120), seo_description: clip(b.seo_description, 300),
    };
    if (!okImage(f.image)) return c.json({ ok: false, error: "bad_image_url" }, 400);
    if (Object.values(f).some(Boolean)) {
      await pool.query(
        `INSERT INTO cms_products(product_id, image, description, description_en, badge, seo_title, seo_description, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)
         ON CONFLICT (product_id) DO UPDATE SET image=$2, description=$3, description_en=$4, badge=$5,
           seo_title=$6, seo_description=$7, updated_at=NOW(), updated_by=$8`,
        [id, f.image, f.description, f.description_en, f.badge, f.seo_title, f.seo_description, await who(c)]);
    } else {
      // كل الحقول فاضية = رجوع كامل لتاب سينس
      await pool.query("DELETE FROM cms_products WHERE product_id=$1", [id]);
    }
    if (typeof b.hidden === "boolean") {
      const s = await getSettingsData();
      const cur = new Set(((s?.catalog || {}).hiddenIds || []).map(String));
      if (b.hidden) cur.add(id); else cur.delete(id);
      await pool.query(
        `UPDATE settings SET data = jsonb_set(
           CASE WHEN data ? 'catalog' THEN data ELSE jsonb_set(data,'{catalog}','{}'::jsonb,true) END,
           '{catalog,hiddenIds}', $1::jsonb, true) WHERE id=1`, [jb([...cur])]);
    }
    bustOverlay();
    return c.json({ ok: true });
  });

  const cleanIds = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).slice(0, 64)).filter(Boolean).slice(0, 60);
  app.post("/api/cms/collections", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const name = clip(b.name, 60);
    if (!name) return c.json({ ok: false, error: "name_required" }, 400);
    const r = await pool.query(
      `INSERT INTO cms_collections(name, name_en, product_ids, sort, active) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, clip(b.name_en, 60), jb(cleanIds(b.product_ids)), Number(b.sort) || 0, b.active !== false]);
    bustOverlay();
    return c.json({ ok: true, collection: r.rows[0] });
  });
  app.put("/api/cms/collections/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const name = clip(b.name, 60);
    if (!name) return c.json({ ok: false, error: "name_required" }, 400);
    const r = await pool.query(
      `UPDATE cms_collections SET name=$2, name_en=$3, product_ids=$4, sort=$5, active=$6, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [Number(c.req.param("id")), name, clip(b.name_en, 60), jb(cleanIds(b.product_ids)), Number(b.sort) || 0, b.active !== false]);
    if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
    bustOverlay();
    return c.json({ ok: true, collection: r.rows[0] });
  });
  app.delete("/api/cms/collections/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM cms_collections WHERE id=$1", [Number(c.req.param("id"))]);
    bustOverlay();
    return c.json({ ok: true });
  });

  /* روابط الحملات — freshcuts.sa/l/<slug>. البروكسي بينادي resolve (عام)
     اللي بيعدّ الضغطة ويبني رابط الهبوط، فالقواعد في مكان واحد. */
  const MEDIUM = { influencer: "influencer", whatsapp: "message", sms: "message", qr: "offline" };
  const slugOk = (s) => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s);
  function linkBody(b) {
    const target_type = ["home", "collection", "product"].includes(b.target_type) ? b.target_type : "home";
    const utm_source = clip(b.utm_source, 30) || "other";
    return {
      label: clip(b.label, 80), target_type,
      target_id: target_type === "home" ? null : clip(b.target_id, 64),
      coupon: clip(String(b.coupon || "").toUpperCase(), 40),
      utm_source, utm_medium: MEDIUM[utm_source] || "paid",
      utm_campaign: clip(b.utm_campaign, 80),
    };
  }

  app.get("/api/cms/links", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query("SELECT * FROM cms_links ORDER BY active DESC, created_at DESC")).rows;
    return c.json({ ok: true, links: rows });
  });
  app.post("/api/cms/links", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const slug = String(b.slug || "").toLowerCase().trim();
    if (!slugOk(slug)) return c.json({ ok: false, error: "bad_slug" }, 400);
    const x = linkBody(b);
    try {
      const r = await pool.query(
        `INSERT INTO cms_links(slug, label, target_type, target_id, coupon, utm_source, utm_medium, utm_campaign, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [slug, x.label, x.target_type, x.target_id, x.coupon, x.utm_source, x.utm_medium, x.utm_campaign, b.active !== false, await who(c)]);
      return c.json({ ok: true, link: r.rows[0] });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return c.json({ ok: false, error: "slug_taken" }, 409);
      throw e;
    }
  });
  app.put("/api/cms/links/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    // تشغيل/إيقاف بس (زرار في القائمة)
    if (Object.keys(b).length === 1 && typeof b.active === "boolean") {
      await pool.query("UPDATE cms_links SET active=$2 WHERE id=$1", [id, b.active]);
      return c.json({ ok: true });
    }
    const slug = String(b.slug || "").toLowerCase().trim();
    if (!slugOk(slug)) return c.json({ ok: false, error: "bad_slug" }, 400);
    const x = linkBody(b);
    try {
      const r = await pool.query(
        `UPDATE cms_links SET slug=$2, label=$3, target_type=$4, target_id=$5, coupon=$6, utm_source=$7,
                utm_medium=$8, utm_campaign=$9, active=$10 WHERE id=$1 RETURNING *`,
        [id, slug, x.label, x.target_type, x.target_id, x.coupon, x.utm_source, x.utm_medium, x.utm_campaign, b.active !== false]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      return c.json({ ok: true, link: r.rows[0] });
    } catch (e) {
      if (String(e.message).includes("duplicate")) return c.json({ ok: false, error: "slug_taken" }, 409);
      throw e;
    }
  });
  app.delete("/api/cms/links/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM cms_links WHERE id=$1", [Number(c.req.param("id"))]);
    return c.json({ ok: true });
  });

  // عام: البروكسي بيناديه لما حد يضغط /l/<slug>. رابط موقوف/مش موجود = 404،
  // والبروكسي ساعتها بيودّي على الرئيسية (الإعلان الشغّال عمره ما يقع).
  app.post("/api/cms/links/resolve/:slug", async (c) => {
    const slug = String(c.req.param("slug") || "").toLowerCase();
    if (!slugOk(slug)) return c.json({ ok: false }, 404);
    const r = await pool.query(
      `UPDATE cms_links SET clicks = clicks + 1, last_click_at = NOW()
        WHERE slug=$1 AND active RETURNING *`, [slug]);
    const l = r.rows[0];
    if (!l) return c.json({ ok: false }, 404);
    const q = new URLSearchParams();
    q.set("utm_source", l.utm_source || "other");
    q.set("utm_medium", l.utm_medium || "paid");
    if (l.utm_campaign) q.set("utm_campaign", l.utm_campaign);
    q.set("utm_content", l.slug);
    if (l.coupon) q.set("c", l.coupon);
    if (l.target_type === "collection" && l.target_id) q.set("col", l.target_id);
    if (l.target_type === "product" && l.target_id) q.set("p", l.target_id);
    q.set("fc_link", l.slug);
    return c.json({ ok: true, url: "/?" + q.toString() });
  });

  /* ═══ المرحلة ٣: الشرائح + الحملات + الولاء ═══════════════════════════ */
  const STORE_PUBLIC = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const notify = () => (typeof deps.notify === "function" ? deps.notify() : null);
  const PHONE_RE = "^5[0-9]{8}$";
  const PAID_ONLINE = "status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')";

  /* عميل واحد = رقم جوال واحد، محسوب من كل الطلبات (نفس IDENT_SQL بتاع
     المؤشرات) + عملاء الموقع اللي طلباتهم لسه مانزلتش نقطة البيع. */
  let segCache = { at: 0, rows: null };
  async function customerRows() {
    if (segCache.rows && Date.now() - segCache.at < 5 * 60_000) return segCache.rows;
    const s = await getSettingsData();
    const apps = (Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length
      ? s.deliveryAppMethods : (DEFAULT_DELIVERY_APPS || [])).map((x) => String(x).toLowerCase());
    const [pos, online, push, names] = await Promise.all([
      pool.query(`
        WITH x AS (
          SELECT ${IDENT_SQL} AS pn, o.total, o.calendar_day AS day, NULLIF(tc.name, '') AS name,
                 ${deliverySql("$1::text[]")} AS is_app
            FROM ts_orders o
            LEFT JOIN order_sources s ON s.order_id = o.order_id
            LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
           WHERE ${SALES_ONLY}
        )
        SELECT pn, count(*)::int AS orders, COALESCE(sum(total), 0)::float AS spend,
               max(day) AS last_day, max(name) AS name, count(*) FILTER (WHERE is_app)::int AS app_orders
          FROM x WHERE pn ~ '${PHONE_RE}' GROUP BY pn`, [apps]),
      pool.query(`SELECT phone_norm AS pn, count(*)::int AS n, COALESCE(sum(total), 0)::float AS spend,
                         max(created_at)::date AS last_day
                    FROM shop_orders WHERE ${PAID_ONLINE} AND phone_norm ~ '${PHONE_RE}' GROUP BY 1`),
      pool.query("SELECT DISTINCT phone_norm AS pn FROM push_subs WHERE NOT disabled AND phone_norm IS NOT NULL"),
      pool.query("SELECT phone_norm AS pn, NULLIF(name, '') AS name FROM acct_customers"),
    ]);
    const onl = new Map(online.rows.map((r) => [r.pn, r]));
    const pushSet = new Set(push.rows.map((r) => r.pn));
    const nameOf = new Map(names.rows.map((r) => [r.pn, r.name]));
    const today = new Date(new Date().toISOString().slice(0, 10));
    const daysSince = (d) => (d ? Math.max(0, Math.round((today - new Date(d)) / 86400000)) : 9999);
    const rows = pos.rows.map((r) => {
      const o = onl.get(r.pn);
      const last = o && o.last_day > r.last_day ? o.last_day : r.last_day;
      return { pn: r.pn, name: r.name || nameOf.get(r.pn) || "", orders: r.orders, spend: r.spend,
        appOrders: r.app_orders, online: o ? o.n : 0, push: pushSet.has(r.pn), lastDay: last, daysSince: daysSince(last) };
    });
    // عملاء طلبوا من الموقع بس ولسه طلبهم مادخلش سجل نقطة البيع
    const seen = new Set(rows.map((r) => r.pn));
    for (const o of online.rows) {
      if (seen.has(o.pn)) continue;
      rows.push({ pn: o.pn, name: nameOf.get(o.pn) || "", orders: o.n, spend: o.spend, appOrders: 0,
        online: o.n, push: pushSet.has(o.pn), lastDay: o.last_day, daysSince: daysSince(o.last_day) });
    }
    // VIP = أعلى ٢٠٪ إنفاق (نفس نسبة المؤشرات)
    const spends = rows.map((r) => r.spend).sort((a, b) => a - b);
    const cut = spends.length ? spends[Math.floor(spends.length * 0.8)] : Infinity;
    for (const r of rows) r.vip = r.spend >= cut && r.spend > 0;
    rows.sort((a, b) => a.daysSince - b.daysSince);
    segCache = { at: Date.now(), rows };
    return rows;
  }

  /* الشرائح عدسات متداخلة عن قصد. أول اتنين هما «الفرص الذهبية»: عملاء
     بيطلبوا فعلاً بس مش من متجرنا — تحويلهم أرخص من أي إعلان. ٢١ يوم = نفس
     حد «متوقف» في المؤشرات. */
  const SEGMENTS = [
    { id: "never_online", icon: "🎯", label: "نشطين ومجربوش الموقع", hint: "طلبوا خلال ٦٠ يوم (صالة/تطبيقات) ولسه ماطلبوش من متجرنا — أرخص تحويل ممكن",
      test: (c) => c.online === 0 && c.daysSince <= 60 },
    { id: "apps_only", icon: "🛵", label: "عملاء التطبيقات بس", hint: "كل طلباتهم من كيتا/هنقر — كل طلب بيدفع عمولة ~٤٠٪. حوّلهم لمتجرك بكوبون",
      test: (c) => c.orders > 0 && c.appOrders === c.orders && c.online === 0 },
    { id: "new", icon: "🌱", label: "جداد", hint: "أول طلب خلال آخر ١٤ يوم", test: (c) => c.orders === 1 && c.daysSince <= 14 },
    { id: "one_timer", icon: "1️⃣", label: "جربوا مرة ومرجعوش", hint: "طلب واحد من ١٥ لـ٦٠ يوم — محتاجين دفعة", test: (c) => c.orders === 1 && c.daysSince >= 15 && c.daysSince <= 60 },
    { id: "loyal", icon: "💎", label: "مخلصين", hint: "٣ طلبات أو أكتر وآخر طلب خلال ٢١ يوم", test: (c) => c.orders >= 3 && c.daysSince <= 21 },
    { id: "vip", icon: "⭐", label: "VIP", hint: "أعلى ٢٠٪ إنفاق ولسه نشطين (٤٥ يوم)", test: (c) => c.vip && c.daysSince <= 45 },
    { id: "at_risk", icon: "⚠️", label: "في خطر", hint: "كانوا بيرجعوا وبقالهم ٢٢–٤٥ يوم", test: (c) => c.orders >= 2 && c.daysSince >= 22 && c.daysSince <= 45 },
    { id: "dormant", icon: "😴", label: "نايمين", hint: "آخر طلب من ٤٦ لـ٩٠ يوم", test: (c) => c.daysSince >= 46 && c.daysSince <= 90 },
    { id: "lost", icon: "👻", label: "ضايعين", hint: "أكتر من ٩٠ يوم من غير طلب", test: (c) => c.daysSince > 90 },
    { id: "online_buyers", icon: "🛒", label: "عملاء الموقع", hint: "طلبوا من متجرنا مرة على الأقل", test: (c) => c.online > 0 },
  ];
  const segById = Object.fromEntries(SEGMENTS.map((s) => [s.id, s]));
  const pub = (s) => ({ id: s.id, icon: s.icon, label: s.label, hint: s.hint });

  app.get("/api/cms/segments", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = await customerRows();
    return c.json({
      ok: true, asOf: new Date(segCache.at).toISOString(), customers: rows.length,
      segments: SEGMENTS.map((s) => {
        const m = rows.filter(s.test);
        return { ...pub(s), count: m.length, reachablePush: m.filter((x) => x.push).length };
      }),
    });
  });

  app.get("/api/cms/segments/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = segById[c.req.param("id")];
    if (!s) return c.json({ ok: false, error: "not_found" }, 404);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const m = (await customerRows()).filter(s.test);
    return c.json({
      ok: true, ...pub(s), total: m.length,
      members: m.slice(offset, offset + limit).map((x) => ({
        phone: x.pn, name: x.name, orders: x.orders, spend: Math.round(x.spend), lastDay: x.lastDay,
        daysSince: x.daysSince, appOrders: x.appOrders, onlineOrders: x.online, vip: x.vip, push: x.push })),
    });
  });

  /* ── الحملات ── */
  const CAMP_DEFAULT = { smsEnabled: false, dailySmsCap: 1000 };
  async function campaignCfg() {
    const s = await getSettingsData();
    return { ...CAMP_DEFAULT, ...(((s || {}).cms || {}).campaigns || {}) };
  }
  const smsPartsOf = (t) => { const n = [...String(t || "")].length; return n <= 70 ? 1 : Math.ceil(n / 67); };
  async function smsToday() {
    const r = await pool.query("SELECT n FROM cms_sms_daily WHERE day = CURRENT_DATE");
    return r.rows[0]?.n || 0;
  }
  const bumpSms = (parts) => pool.query(
    `INSERT INTO cms_sms_daily(day, n) VALUES (CURRENT_DATE, $1)
     ON CONFLICT (day) DO UPDATE SET n = cms_sms_daily.n + $1`, [parts]).catch(() => {});
  const renderMsg = (tpl, { name, coupon }) => String(tpl || "")
    .replaceAll("{name}", String(name || "").split(/\s+/)[0] || "")
    .replaceAll("{coupon}", coupon || "")
    .replace(/[ \t]{2,}/g, " ").trim();

  async function optoutCodes(phones) {
    if (!phones.length) return new Map();
    await pool.query(
      `INSERT INTO cms_contacts(phone_norm, optout_code)
       SELECT p, substr(md5(random()::text || p || clock_timestamp()::text), 1, 10) FROM unnest($1::text[]) p
       ON CONFLICT (phone_norm) DO NOTHING`, [phones]);
    const r = await pool.query(
      "SELECT phone_norm, optout_code, opted_out_at FROM cms_contacts WHERE phone_norm = ANY($1)", [phones]);
    return new Map(r.rows.map((x) => [x.phone_norm, x]));
  }

  // الجمهور الفعلي: إشعار = اللي مفعّل إشعارات بس، SMS = الكل ناقص اللي ألغى
  async function audienceFor(camp) {
    const s = segById[camp.segment];
    if (!s) return { list: [], segmentSize: 0, optedOut: 0 };
    const m = (await customerRows()).filter(s.test);
    if (camp.channel === "push") return { list: m.filter((x) => x.push), segmentSize: m.length, optedOut: 0 };
    const codes = await optoutCodes(m.map((x) => x.pn));
    const list = m.filter((x) => !codes.get(x.pn)?.opted_out_at).map((x) => ({ ...x, code: codes.get(x.pn)?.optout_code }));
    return { list, segmentSize: m.length, optedOut: m.length - list.length };
  }

  const smsBody = (camp, person) =>
    `${renderMsg(camp.message, { name: person.name, coupon: camp.coupon })}\nإيقاف: ${STORE_PUBLIC().replace(/^https?:\/\//, "")}/u/${person.code}`;

  async function sendMarketingSms(pn, body) {
    const key = process.env.TAQNYAT_API_KEY, sender = process.env.TAQNYAT_SENDER_AD;
    if (!key || !sender) throw Object.assign(new Error("ad sender not configured"), { code: "sms_failed" });
    const resp = await fetch("https://api.taqnyat.sa/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipients: [`966${pn}`], body, sender }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || (data.statusCode && data.statusCode >= 400)) {
      throw Object.assign(new Error(`Taqnyat: ${data.message || resp.status}`), { code: "sms_failed" });
    }
    bumpSms(smsPartsOf(body));
    return data;
  }

  async function couponOk(code) {
    if (!code) return true;
    const r = await pool.query("SELECT 1 FROM shop_coupons WHERE upper(code)=upper($1) AND active", [code]);
    return r.rowCount > 0;
  }
  const bad = (c, error, status = 400) => c.json({ ok: false, error }, status);
  function campBody(b) {
    return {
      name: clip(b.name, 80), segment: segById[b.segment] ? b.segment : null,
      channel: b.channel === "sms" ? "sms" : "push", message: clip(b.message, 600),
      coupon: clip(String(b.coupon || "").toUpperCase(), 40),
    };
  }

  app.get("/api/cms/campaigns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const [rows, cfg, today] = await Promise.all([
      pool.query("SELECT * FROM cms_campaigns ORDER BY created_at DESC LIMIT 100"), campaignCfg(), smsToday()]);
    return c.json({ ok: true, campaigns: rows.rows, smsEnabled: cfg.smsEnabled === true,
      dailySmsCap: cfg.dailySmsCap, smsSentToday: today, smsSender: process.env.TAQNYAT_SENDER_AD || null });
  });

  app.post("/api/cms/campaigns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const x = campBody(b);
    if (!x.name || !x.segment || !x.message) return bad(c, "name_segment_message_required");
    const r = await pool.query(
      `INSERT INTO cms_campaigns(name, segment, channel, message, coupon, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [x.name, x.segment, x.channel, x.message, x.coupon, await who(c)]);
    return c.json({ ok: true, campaign: r.rows[0] });
  });

  app.put("/api/cms/campaigns/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const x = campBody(b);
    if (!x.name || !x.segment || !x.message) return bad(c, "name_segment_message_required");
    const r = await pool.query(
      `UPDATE cms_campaigns SET name=$2, segment=$3, channel=$4, message=$5, coupon=$6
        WHERE id=$1 AND status='draft' RETURNING *`,
      [Number(c.req.param("id")), x.name, x.segment, x.channel, x.message, x.coupon]);
    if (!r.rowCount) return bad(c, "already_sent", 409);
    return c.json({ ok: true, campaign: r.rows[0] });
  });

  app.delete("/api/cms/campaigns/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("DELETE FROM cms_campaigns WHERE id=$1 AND status='draft'", [Number(c.req.param("id"))]);
    if (!r.rowCount) return bad(c, "already_sent", 409);
    return c.json({ ok: true });
  });

  app.get("/api/cms/campaigns/:id/preview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const camp = (await pool.query("SELECT * FROM cms_campaigns WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!camp) return bad(c, "not_found", 404);
    const aud = await audienceFor(camp);
    const first = aud.list[0];
    const sample = first
      ? (camp.channel === "sms" ? smsBody(camp, first) : renderMsg(camp.message, { name: first.name, coupon: camp.coupon }))
      : "";
    const parts = camp.channel === "sms" ? smsPartsOf(sample || camp.message) : 0;
    return c.json({ ok: true, audience: aud.list.length, segmentSize: aud.segmentSize, optedOut: aud.optedOut,
      costEstimate: Math.round(aud.list.length * parts * 0.075 * 100) / 100, sampleBody: sample });
  });

  app.post("/api/cms/campaigns/:id/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const pn = String(b.phone || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
    if (!/^5\d{8}$/.test(pn)) return bad(c, "bad_phone");
    const camp = (await pool.query("SELECT * FROM cms_campaigns WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!camp) return bad(c, "not_found", 404);
    const person = { pn, name: "", code: (await optoutCodes([pn])).get(pn)?.optout_code };
    try {
      if (camp.channel === "sms") {
        await sendMarketingSms(pn, "[تجربة] " + smsBody(camp, person));
      } else {
        const ok = await notify()?.sendToAudience({ phoneNorm: pn, title: "فريش كاتس 🍔 [تجربة]",
          body: renderMsg(camp.message, { coupon: camp.coupon }), url: camp.coupon ? `${STORE_PUBLIC()}/?c=${camp.coupon}` : STORE_PUBLIC() });
        if (!ok) return bad(c, "no_push_for_phone");
      }
    } catch (e) { return c.json({ ok: false, error: "sms_failed", message: e.message }, 502); }
    return c.json({ ok: true, channel: camp.channel });
  });

  async function runSend(camp, list, actor) {
    let sent = 0, failed = 0, lastError = null;
    const url = camp.coupon ? `${STORE_PUBLIC()}/?c=${encodeURIComponent(camp.coupon)}` : STORE_PUBLIC();
    const one = async (p) => {
      try {
        if (camp.channel === "sms") { await sendMarketingSms(p.pn, smsBody(camp, p)); sent++; }
        else if (await notify()?.sendToAudience({ phoneNorm: p.pn, title: "فريش كاتس 🍔",
          body: renderMsg(camp.message, { name: p.name, coupon: camp.coupon }), url })) sent++;
        else failed++;
      } catch (e) { failed++; lastError = e.message; }
    };
    // ٥ في نفس الوقت — تقنيات وخوادم الإشعارات مابتحبش الانفجار
    for (let i = 0; i < list.length; i += 5) {
      await Promise.all(list.slice(i, i + 5).map(one));
      if (camp.channel === "sms") await new Promise((r) => setTimeout(r, 300));
    }
    await pool.query(
      `UPDATE cms_campaigns SET status='sent', sent=$2, failed=$3, audience=$4, sent_at=NOW(), sent_by=$5, last_error=$6
        WHERE id=$1`, [camp.id, sent, failed, list.length, actor, lastError]);
    console.log(`[cms] campaign ${camp.id} (${camp.channel}) → sent ${sent}, failed ${failed}`);
  }

  app.post("/api/cms/campaigns/:id/send", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const id = Number(c.req.param("id"));
    // انتقال ذرّي من مسودة لـ«بتتبعت» — ضغطتين مايبعتوش مرتين
    const r = await pool.query("UPDATE cms_campaigns SET status='sending' WHERE id=$1 AND status='draft' RETURNING *", [id]);
    if (!r.rowCount) return bad(c, "already_sent", 409);
    const camp = r.rows[0];
    const revert = () => pool.query("UPDATE cms_campaigns SET status='draft' WHERE id=$1 AND status='sending'", [id]);
    try {
      const aud = await audienceFor(camp);
      if (!aud.list.length) { await revert(); return bad(c, "empty_audience"); }
      if (Number(b.confirm) !== aud.list.length) { await revert(); return bad(c, "confirm_mismatch"); }
      if (!(await couponOk(camp.coupon))) { await revert(); return bad(c, "coupon_invalid"); }
      if (camp.channel === "sms") {
        const cfg = await campaignCfg();
        if (cfg.smsEnabled !== true) { await revert(); return bad(c, "sms_disabled", 403); }
        const parts = smsPartsOf(smsBody(camp, aud.list[0]));
        if ((await smsToday()) + aud.list.length * parts > Number(cfg.dailySmsCap || 0)) { await revert(); return bad(c, "daily_cap"); }
      }
      const actor = await who(c);
      setImmediate(() => runSend(camp, aud.list, actor).catch(async (e) => {
        console.error(`[cms] campaign ${id} failed:`, e.message);
        await pool.query("UPDATE cms_campaigns SET status='draft', last_error=$2 WHERE id=$1", [id, e.message]).catch(() => {});
      }));
      return c.json({ ok: true, queued: true, audience: aud.list.length });
    } catch (e) { await revert(); throw e; }
  });

  // المالك بس (المسار مش تحت «customers» في خريطة الأقسام عن قصد): SMS بفلوس
  app.put("/api/cms/campaign-settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const val = { smsEnabled: b.smsEnabled === true, dailySmsCap: Math.min(20000, Math.max(0, Number(b.dailySmsCap) || 0)) };
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END,
         '{cms,campaigns}', $1::jsonb, true) WHERE id=1`, [jb(val)]);
    return c.json({ ok: true, ...val });
  });

  // عام: صفحة /u/<code> على المتجر بتناديه
  app.post("/api/cms/optout/:code", async (c) => {
    const code = String(c.req.param("code") || "").slice(0, 20);
    if (!/^[a-f0-9]{6,20}$/.test(code)) return c.json({ ok: false }, 404);
    const r = await pool.query(
      "UPDATE cms_contacts SET opted_out_at = COALESCE(opted_out_at, NOW()) WHERE optout_code=$1 RETURNING 1", [code]);
    return r.rowCount ? c.json({ ok: true }) : c.json({ ok: false }, 404);
  });

  /* ── الولاء: كل N طلبات من الموقع = كوبون شخصي ──
     بيعدّ من لحظة التفعيل بس (startedAt) — لو عدّ التاريخ كله، التفعيل كان
     هيطلّع كوبونات لكل العملاء القدام مرة واحدة كتكلفة مفاجئة. */
  const LOYALTY_DEFAULT = { enabled: false, every: 5, reward: "free_delivery", percent: 10, validDays: 14, startedAt: null };
  async function loyaltyCfg() {
    const s = await getSettingsData();
    return { ...LOYALTY_DEFAULT, ...(((s || {}).cms || {}).loyalty || {}) };
  }
  async function loyaltyCounts(cfg) {
    const since = cfg.startedAt || "1970-01-01";
    return (await pool.query(
      `SELECT o.phone_norm AS pn, count(*)::int AS n,
              (SELECT count(*)::int FROM cms_loyalty l WHERE l.phone_norm = o.phone_norm) AS issued
         FROM shop_orders o
        WHERE ${PAID_ONLINE} AND o.phone_norm ~ '${PHONE_RE}' AND o.created_at >= $1::timestamptz
        GROUP BY 1`, [since])).rows;
  }
  async function loyaltyRun() {
    const cfg = await loyaltyCfg();
    if (!cfg.enabled || !cfg.startedAt) return;
    const every = Math.max(2, Number(cfg.every) || 5);
    for (const r of await loyaltyCounts(cfg)) {
      for (let k = r.issued + 1; k <= Math.floor(r.n / every); k++) {
        const code = "FC" + crypto.randomBytes(4).toString("hex").toUpperCase();
        const ins = await pool.query(
          "INSERT INTO cms_loyalty(phone_norm, reward_no, coupon) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1",
          [r.pn, k, code]);
        if (!ins.rowCount) continue;
        const expires = new Date(Date.now() + (Number(cfg.validDays) || 14) * 86400000).toISOString().slice(0, 10);
        const isFree = cfg.reward !== "percent";
        await pool.query(
          `INSERT INTO shop_coupons(code, percent, active, min_total, max_uses, expires_at, note, once_per_customer, free_delivery)
           VALUES ($1,$2,true,0,1,$3,$4,true,$5)`,
          [code, isFree ? 0 : Math.min(50, Number(cfg.percent) || 10), expires, `مكافأة ولاء #${k} — ${r.pn.slice(-4)}`, isFree]);
        const what = isFree ? "توصيل مجاني" : `خصم ${Number(cfg.percent) || 10}٪`;
        notify()?.sendToAudience({ phoneNorm: r.pn, title: "مبروك! 🎁",
          body: `كمّلت ${every * k} طلبات من فريش كاتس — كوبونك ${code}: ${what} لحد ${expires}`,
          url: `${STORE_PUBLIC()}/?c=${code}` }).catch(() => {});
        console.log(`[cms] loyalty reward ${code} → ${r.pn.slice(-4)} (#${k})`);
      }
    }
  }
  setTimeout(() => loyaltyRun().catch((e) => console.error("[cms] loyalty:", e.message)), 60_000);
  setInterval(() => loyaltyRun().catch((e) => console.error("[cms] loyalty:", e.message)), 15 * 60_000);

  app.get("/api/cms/loyalty", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await loyaltyCfg();
    const every = Math.max(2, Number(cfg.every) || 5);
    const counts = await loyaltyCounts(cfg);
    const [issued, used, recent] = await Promise.all([
      pool.query("SELECT count(*)::int AS n FROM cms_loyalty"),
      pool.query("SELECT count(*)::int AS n FROM cms_loyalty l JOIN shop_coupons s ON s.code = l.coupon WHERE s.used_count > 0"),
      pool.query(`SELECT l.phone_norm AS phone, l.reward_no, l.coupon, l.created_at, COALESCE(s.used_count,0) > 0 AS used
                    FROM cms_loyalty l LEFT JOIN shop_coupons s ON s.code = l.coupon ORDER BY l.created_at DESC LIMIT 10`),
    ]);
    return c.json({ ok: true, config: cfg, stats: {
      members: counts.length,
      eligibleSoon: counts.filter((r) => r.n % every === every - 1).length,
      rewardsIssued: issued.rows[0].n, rewardsUsed: used.rows[0].n, recent: recent.rows,
    } });
  });

  app.put("/api/cms/loyalty", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const prev = await loyaltyCfg();
    const enabled = b.enabled === true;
    const val = {
      enabled,
      every: Math.min(20, Math.max(2, Number(b.every) || 5)),
      reward: b.reward === "percent" ? "percent" : "free_delivery",
      percent: Math.min(50, Math.max(5, Number(b.percent) || 10)),
      validDays: Math.min(90, Math.max(3, Number(b.validDays) || 14)),
      // أول تفعيل بيثبّت نقطة البداية؛ الإيقاف والتشغيل تاني مابيعدّش التاريخ
      startedAt: enabled ? (prev.startedAt || new Date().toISOString()) : prev.startedAt,
    };
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'cms' THEN data ELSE jsonb_set(data,'{cms}','{}'::jsonb,true) END,
         '{cms,loyalty}', $1::jsonb, true) WHERE id=1`, [jb(val)]);
    return c.json({ ok: true, config: val });
  });

  console.log("[cms] routes ready");
  return { sectionOf, effectivePerms, sessionUser, whoami };
}
