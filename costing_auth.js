/* ═══════════════════════════════════════════════════════════════════════════
   COSTING AUTH — who is allowed to touch the food-cost system of record.

   Registered by `costing.js` (NOT by index.js): the workbench and its login
   are one feature, and wiring them separately would let one ship without the
   other. `costing.js` calls `registerCostingAuth(app, ctx)` and keeps the two
   guards it returns.

   ── Why this is not the staff PIN ──────────────────────────────────────────
   `staff.js` stores a 4-digit PIN in plaintext, on purpose: it guards a
   till screen, the owner has to be able to read a PIN back to hand it out,
   and the worst a stolen PIN buys you is the ability to tag an order.

   This module guards the numbers the P&L is computed from. A manager who
   confirms a cost here changes what every margin report says for months. So:

     • PASSWORD, not PIN — free-form, minimum 8 characters.
     • scrypt (node:crypto) with a per-user 16-byte salt. The plaintext is
       never stored, never returned by any route, and never logged — not on
       creation, not on reset, not on a failed login.
     • The bearer token is NOT the password. Login mints a random 32-byte
       token, stores only its SHA-256, and gives the raw token to the client
       once. A dump of `costing_sessions` cannot be replayed.
     • Sessions expire. A browser left open on the pass counter stops being a
       key after 14 days.

   ── The token shape ────────────────────────────────────────────────────────
     Authorization: Bearer costing:<userId>:<token>
   Same three-part shape as `staff:<id>:<pin>` so the frontend's existing
   header helper needed no new concept — but the third part is a session
   token with an expiry, not a secret the user knows.

   ── Roles ──────────────────────────────────────────────────────────────────
   `manager` — works the queue: reviews items, edits recipes, fixes prices.
   `owner`   — everything the manager can do, plus user administration and the
               `visibility` blob that decides which sections the manager sees.
   The site-wide admin token (`requireAdmin`) is always accepted as an owner,
   so Omar can administer this from the admin console he already uses and can
   never lock himself out of his own costing system.

   ── First boot ─────────────────────────────────────────────────────────────
   If no user exists we create ONE owner from `COSTING_OWNER_PASSWORD`. If
   that variable is unset we create NOTHING and say so in the log. There is no
   default password. A costing system that ships with a known password is a
   costing system anybody can rewrite.
   ═══════════════════════════════════════════════════════════════════════════ */

import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/* scrypt parameters. N=16384 is the node default and costs ~50 ms here, which
   is the point — it is the whole defence against an offline dictionary attack
   on a stolen `pass_hash`. Stored alongside the hash so raising the cost later
   does not invalidate existing passwords. */
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

const SESSION_DAYS = 14;
const MIN_PASSWORD = 8;
const ROLES = ["manager", "owner"];

const newUserId = () => `cu_${randomBytes(5).toString("hex")}`;
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const isResponse = (x) => typeof Response !== "undefined" && x instanceof Response;

/* Which sections of the workbench a manager is allowed to see. The owner sees
   everything regardless — this blob only ever narrows the manager. Defaults
   are deliberately generous except for the two levers that move the P&L for
   everybody at once (`recalc`) and the packaging rules that apply across the
   whole menu (`rules`). */
export const DEFAULT_VISIBILITY = {
  tasks: true,        // قائمة المهام
  items: true,        // الأصناف
  materials: true,    // المواد الخام
  batches: true,      // التشغيلات
  packaging: true,    // التغليف
  // The manager needs both of these to finish a job — packaging rules are half
  // the cost model, and /recalc is how his work reaches the P&L at all. They
  // are listed here so the owner can take them away, not because they start
  // taken away: a queue you cannot close is not a queue.
  rules: true,        // قواعد التغليف — تمس كل الأصناف
  recalc: true,       // إعادة الاحتساب — تكتب في الأرباح والخسائر
  audit: true,        // سجل التغييرات
  sales: true,        // أرقام المبيعات بجانب كل صنف
  prices: true,       // أسعار البيع
  users: false,       // إدارة المستخدمين — للمالك فقط دائماً
};

const VISIBILITY_LABELS = {
  tasks: "قائمة المهام", items: "الأصناف", materials: "المواد الخام",
  batches: "التشغيلات", packaging: "أصناف التغليف", rules: "قواعد التغليف",
  recalc: "إعادة احتساب التكاليف", audit: "سجل التغييرات",
  sales: "أرقام المبيعات", prices: "أسعار البيع", users: "إدارة المستخدمين",
};

/* ── Password hashing ──────────────────────────────────────────────────────
   `pass_hash` is stored as `scrypt$N$r$p$<hex>` so the parameters travel with
   the hash. `verify` reads them back out of the stored string rather than
   assuming today's constants, and compares with timingSafeEqual. */
async function hashPassword(plain, salt) {
  const buf = await scryptAsync(String(plain), salt, KEY_LEN,
    { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${buf.toString("hex")}`;
}

async function verifyPassword(plain, salt, stored) {
  const s = String(stored || "");
  const parts = s.split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let want;
  try { want = Buffer.from(parts[4], "hex"); } catch { return false; }
  let got;
  try {
    got = await scryptAsync(String(plain), salt, want.length, { N, r, p });
  } catch { return false; }
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/** Why a password is not acceptable, or null. Arabic, because the manager
 *  reads it. Deliberately does NOT demand symbols/mixed case — a long simple
 *  passphrase beats a short cryptic one and gets written on a sticky note less
 *  often. */
export function passwordProblem(plain) {
  const p = String(plain ?? "");
  if (p.length < MIN_PASSWORD) return `كلمة المرور لازم تكون ${MIN_PASSWORD} أحرف على الأقل`;
  if (p.length > 200) return "كلمة المرور طويلة جداً";
  if (/^\d+$/.test(p)) return "كلمة المرور أرقام فقط — استخدم كلمات مع أرقام";
  if (p.trim() !== p) return "كلمة المرور تبدأ أو تنتهي بمسافة — الأغلب خطأ نسخ";
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Mounts the costing auth + user-administration routes and returns the two
 * guards `costing.js` needs.
 *
 * @returns {{ requireCostingUser, requireCostingOwner, getVisibility, audit,
 *             publicUser, ensureCostingAuthSchema }}
 */
export function registerCostingAuth(app, ctx) {
  const { pool, requireAdmin } = ctx;

  /* ── Schema ─────────────────────────────────────────────────────────────
     `cw_audit` is created here as well as in costing.js, with byte-identical
     DDL and IF NOT EXISTS, because both modules boot their schema in parallel
     and either one may win. A login attempt must be auditable even if the
     workbench tables are still being built. */
  async function ensureCostingAuthSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS costing_users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL DEFAULT 'manager',   -- manager | owner
        pass_hash     TEXT NOT NULL,
        pass_salt     TEXT NOT NULL,
        active        BOOL NOT NULL DEFAULT true,
        must_change   BOOL NOT NULL DEFAULT false,
        last_login_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- Only the SHA-256 of a session token is stored. The raw token is handed
      -- to the client once, at login, and never persisted anywhere.
      CREATE TABLE IF NOT EXISTS costing_sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_agent   TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS costing_sessions_user_idx ON costing_sessions(user_id);
      CREATE INDEX IF NOT EXISTS costing_sessions_exp_idx  ON costing_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS costing_settings (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS cw_audit (
        id         TEXT PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id   TEXT NOT NULL DEFAULT '',
        actor_name TEXT NOT NULL DEFAULT '',
        entity     TEXT NOT NULL DEFAULT '',
        entity_ref TEXT NOT NULL DEFAULT '',
        field      TEXT NOT NULL DEFAULT '',
        old_value  TEXT,
        new_value  TEXT,
        note       TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS cw_audit_at_idx     ON cw_audit(at DESC);
      CREATE INDEX IF NOT EXISTS cw_audit_entity_idx ON cw_audit(entity, entity_ref);
    `);
    await bootstrapOwner();
    // Housekeeping, not security: an expired row is already refused by the
    // guard's `expires_at > NOW()` predicate.
    await pool.query("DELETE FROM costing_sessions WHERE expires_at < NOW() - interval '30 days'")
      .catch(() => {});
  }

  /** First boot only. Never invents a password. */
  async function bootstrapOwner() {
    const n = (await pool.query("SELECT count(*)::int AS n FROM costing_users")).rows[0].n;
    if (n > 0) return;

    const pw = process.env.COSTING_OWNER_PASSWORD || "";
    if (!pw) {
      console.log(
        "[costing-auth] no costing user exists and COSTING_OWNER_PASSWORD is unset — " +
        "nothing was created. Set the env var and restart, or POST /api/costing/users " +
        "with the site admin token to create the first owner."
      );
      return;
    }
    const problem = passwordProblem(pw);
    if (problem) {
      // Report the RULE that failed, never the value that failed it.
      console.error(`[costing-auth] COSTING_OWNER_PASSWORD rejected: ${problem} — no user created`);
      return;
    }
    const username = String(process.env.COSTING_OWNER_USERNAME || "omar").trim().toLowerCase();
    const salt = randomBytes(16).toString("hex");
    const hash = await hashPassword(pw, salt);
    const id = newUserId();
    await pool.query(
      `INSERT INTO costing_users (id, username, display_name, role, pass_hash, pass_salt, active)
       VALUES ($1,$2,$3,'owner',$4,$5,true) ON CONFLICT (username) DO NOTHING`,
      [id, username, "عمر — المالك", hash, salt]
    );
    // The username is safe to log. The password is not, and is not.
    console.log(`[costing-auth] first owner created from COSTING_OWNER_PASSWORD — username="${username}"`);
  }

  /* ── Audit ──────────────────────────────────────────────────────────────
     Every write in the workbench funnels through here. Failing to audit must
     never fail the write it was describing, so this swallows its own errors
     and complains to the log instead. */
  async function audit(actor, entity, entityRef, field, oldValue, newValue, note = "") {
    try {
      const str = (v) =>
        v === null || v === undefined ? null
        : typeof v === "object" ? JSON.stringify(v)
        : String(v);
      await pool.query(
        `INSERT INTO cw_audit (id, actor_id, actor_name, entity, entity_ref, field, old_value, new_value, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [`au_${randomBytes(8).toString("hex")}`,
         String(actor?.id || ""), String(actor?.display_name || actor?.name || ""),
         String(entity || ""), String(entityRef ?? ""), String(field || ""),
         str(oldValue), str(newValue), String(note || "")]
      );
    } catch (e) {
      console.error("[costing-auth] audit write failed:", e.message);
    }
  }

  /* ── Visibility blob ────────────────────────────────────────────────────── */

  async function getVisibility() {
    try {
      const r = await pool.query("SELECT value FROM costing_settings WHERE key = 'visibility'");
      const stored = r.rowCount ? (r.rows[0].value || {}) : {};
      // Merge over the defaults so a section added in a later deploy is visible
      // immediately instead of silently defaulting to false.
      const out = { ...DEFAULT_VISIBILITY };
      for (const k of Object.keys(DEFAULT_VISIBILITY))
        if (typeof stored[k] === "boolean") out[k] = stored[k];
      return out;
    } catch {
      return { ...DEFAULT_VISIBILITY };
    }
  }

  /** What THIS caller can see. An owner sees everything, always — the blob is
   *  a manager-narrowing device and must not be able to blind the owner. */
  async function visibilityFor(user) {
    const v = await getVisibility();
    if (user?.role === "owner" || user?.isAdmin) {
      const all = {};
      for (const k of Object.keys(DEFAULT_VISIBILITY)) all[k] = true;
      return all;
    }
    return { ...v, users: false };   // never, whatever the blob says
  }

  /* ── Guards ─────────────────────────────────────────────────────────────── */

  const unauthorized = (c) =>
    c.json({ ok: false, error: "unauthorized", message: "اسم المستخدم أو كلمة المرور غير صحيحة" }, 401);
  const forbidden = (c) =>
    c.json({ ok: false, error: "forbidden", message: "هذا القسم للمالك فقط" }, 403);

  /* The site admin token, presented as an owner. Gives Omar the workbench from
     the console he already has, and makes lockout impossible. */
  const ADMIN_AS_OWNER = {
    id: "admin", username: "admin", display_name: "المالك", role: "owner",
    active: true, isAdmin: true,
  };

  /**
   * Resolve `Authorization: Bearer costing:<userId>:<token>` to a user row,
   * or return a 401 JSON Response. Falls back to the site admin token.
   *
   * The session token is looked up by its HASH, and the row must both belong
   * to the claimed user and still be inside its expiry.
   */
  async function requireCostingUser(c) {
    const h = c.req.header("Authorization") || "";
    if (h.startsWith("Bearer costing:")) {
      const rest = h.slice("Bearer costing:".length);
      const i = rest.indexOf(":");
      if (i > 0) {
        const userId = rest.slice(0, i);
        const token = rest.slice(i + 1);
        if (token) {
          const r = await pool.query(
            `SELECT u.* FROM costing_sessions s
               JOIN costing_users u ON u.id = s.user_id
              WHERE s.token_hash = $1 AND s.user_id = $2
                AND s.expires_at > NOW() AND u.active = true`,
            [sha256(token), userId]
          );
          if (r.rowCount) {
            // Cheap liveness, best-effort — a failure here must not log a
            // working user out.
            pool.query("UPDATE costing_sessions SET last_seen_at = NOW() WHERE token_hash = $1",
              [sha256(token)]).catch(() => {});
            return r.rows[0];
          }
        }
      }
      return unauthorized(c);
    }
    const adminErr = await requireAdmin(c);
    if (!adminErr) return ADMIN_AS_OWNER;
    return unauthorized(c);
  }

  /** Owner-or-admin. Returns the user, or a 401/403 Response. */
  async function requireCostingOwner(c) {
    const u = await requireCostingUser(c);
    if (isResponse(u)) return u;
    if (u.role === "owner" || u.isAdmin) return u;
    return forbidden(c);
  }

  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    name: u.display_name || u.username,
    role: u.role,
    active: u.active !== false,
    mustChange: u.must_change === true,
    lastLoginAt: u.last_login_at || null,
    createdAt: u.created_at || null,
  });

  /* ═══════════════════════════════════════════════════════════════════════
     ROUTES
     ═══════════════════════════════════════════════════════════════════════ */

  /* ── POST /api/costing/login ──────────────────────────────────────────────
     {username, password} → {ok, token, user}.
     A wrong password and an unknown username return the identical 401 body,
     and both run the scrypt work, so the endpoint cannot be used to find out
     who has an account or to time-probe for one. */
  app.post("/api/costing/login", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const username = String(b.username || b.user || "").trim().toLowerCase();
      const password = String(b.password || "");
      if (!username || !password) return unauthorized(c);

      const r = await pool.query(
        "SELECT * FROM costing_users WHERE lower(username) = $1 AND active = true LIMIT 1",
        [username]
      );
      // Same work either way (see above): hash against a throwaway salt when
      // the user does not exist, then fail.
      const row = r.rowCount ? r.rows[0] : null;
      const ok = row
        ? await verifyPassword(password, row.pass_salt, row.pass_hash)
        : await verifyPassword(password, "0".repeat(32), await hashPassword("x", "0".repeat(32)));
      if (!row || !ok) {
        // The username is logged so a locked-out manager can be helped. The
        // password is never logged, not even its length.
        console.log(`[costing-auth] failed login for username="${username}"`);
        return unauthorized(c);
      }

      const token = randomBytes(32).toString("hex");
      await pool.query(
        `INSERT INTO costing_sessions (token_hash, user_id, expires_at, user_agent)
         VALUES ($1,$2, NOW() + ($3 || ' days')::interval, $4)`,
        [sha256(token), row.id, String(SESSION_DAYS),
         String(c.req.header("User-Agent") || "").slice(0, 200)]
      );
      await pool.query("UPDATE costing_users SET last_login_at = NOW() WHERE id = $1", [row.id]);
      await audit(row, "auth", row.id, "login", null, null, "دخول");

      return c.json({
        ok: true,
        token: `costing:${row.id}:${token}`,
        user: { id: row.id, username: row.username, name: row.display_name || row.username, role: row.role },
        mustChange: row.must_change === true,
        expiresInDays: SESSION_DAYS,
      });
    } catch (e) {
      console.error("[costing-auth] login failed:", e.message);
      return c.json({ ok: false, error: "login_failed" }, 500);
    }
  });

  /* ── POST /api/costing/logout ───────────────────────────────────────────── */
  app.post("/api/costing/logout", async (c) => {
    const h = c.req.header("Authorization") || "";
    if (h.startsWith("Bearer costing:")) {
      const rest = h.slice("Bearer costing:".length);
      const i = rest.indexOf(":");
      if (i > 0) {
        await pool.query("DELETE FROM costing_sessions WHERE token_hash = $1",
          [sha256(rest.slice(i + 1))]).catch(() => {});
      }
    }
    return c.json({ ok: true });
  });

  /* ── GET /api/costing/me ─────────────────────────────────────────────────
     {ok, user, visibility}. The frontend renders its sections off `visibility`,
     but every section's own route re-checks — a hidden section is a courtesy,
     not a permission. */
  app.get("/api/costing/me", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    return c.json({
      ok: true,
      user: publicUser(u),
      visibility: await visibilityFor(u),
      labels: VISIBILITY_LABELS,
    });
  });

  /* ── POST /api/costing/me/password ───────────────────────────────────────
     A user changing their OWN password must present the current one. Resetting
     somebody else's is the owner route below and needs no old password. */
  app.post("/api/costing/me/password", async (c) => {
    const u = await requireCostingUser(c); if (isResponse(u)) return u;
    if (u.isAdmin) return c.json({ ok: false, error: "admin_has_no_password",
      message: "حساب الإدارة العام ليس له كلمة مرور هنا" }, 400);
    const b = await c.req.json().catch(() => ({}));
    const okOld = await verifyPassword(String(b.currentPassword || ""), u.pass_salt, u.pass_hash);
    if (!okOld) return c.json({ ok: false, error: "bad_password", message: "كلمة المرور الحالية غير صحيحة" }, 400);
    const problem = passwordProblem(b.newPassword);
    if (problem) return c.json({ ok: false, error: "weak_password", message: problem }, 400);

    const salt = randomBytes(16).toString("hex");
    const hash = await hashPassword(String(b.newPassword), salt);
    await pool.query(
      `UPDATE costing_users SET pass_hash=$2, pass_salt=$3, must_change=false, updated_at=NOW()
        WHERE id=$1`, [u.id, hash, salt]);
    // Every other session for this user dies. A password change that leaves the
    // old sessions alive has not changed anything for an attacker.
    await pool.query("DELETE FROM costing_sessions WHERE user_id = $1", [u.id]);
    await audit(u, "user", u.id, "password", null, null, "غيّر كلمة مروره بنفسه");
    return c.json({ ok: true, message: "تم تغيير كلمة المرور — سجّل الدخول من جديد" });
  });

  /* ═══ Owner administration ═════════════════════════════════════════════ */

  /* ── GET /api/costing/users ──────────────────────────────────────────────
     Hashes and salts are NEVER in the response. There is no route in this
     module that returns a password or anything derived from one. */
  app.get("/api/costing/users", async (c) => {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    const rows = (await pool.query(
      `SELECT u.*,
              (SELECT count(*)::int FROM costing_sessions s
                WHERE s.user_id = u.id AND s.expires_at > NOW()) AS live_sessions
         FROM costing_users u ORDER BY u.active DESC, u.role, u.username`
    )).rows;
    return c.json({
      ok: true,
      users: rows.map((r) => ({ ...publicUser(r), liveSessions: r.live_sessions })),
      roles: [{ key: "manager", label: "مدير المطعم" }, { key: "owner", label: "المالك" }],
      // Say out loud that the admin token is a way in, so nobody concludes
      // from an empty list that the workbench is unreachable.
      adminTokenIsOwner: true,
    });
  });

  /* ── POST /api/costing/users ─────────────────────────────────────────────
     {username, name, role, password} → {ok, user}.
     Also the bootstrap path: when NO user exists yet this accepts the site
     admin token, which is how the first owner is created without an env var. */
  app.post("/api/costing/users", async (c) => {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    const b = await c.req.json().catch(() => ({}));
    const username = String(b.username || "").trim().toLowerCase();
    const name = String(b.name || b.displayName || "").trim();
    const role = ROLES.includes(String(b.role)) ? String(b.role) : "manager";
    if (!/^[a-z0-9._-]{3,32}$/.test(username))
      return c.json({ ok: false, error: "bad_username",
        message: "اسم المستخدم: حروف إنجليزية وأرقام فقط، من 3 إلى 32 خانة" }, 400);
    const problem = passwordProblem(b.password);
    if (problem) return c.json({ ok: false, error: "weak_password", message: problem }, 400);

    const exists = await pool.query("SELECT 1 FROM costing_users WHERE lower(username) = $1", [username]);
    if (exists.rowCount) return c.json({ ok: false, error: "username_taken",
      message: "اسم المستخدم مستخدم بالفعل" }, 409);

    const salt = randomBytes(16).toString("hex");
    const hash = await hashPassword(String(b.password), salt);
    const id = newUserId();
    const row = (await pool.query(
      `INSERT INTO costing_users (id, username, display_name, role, pass_hash, pass_salt, active, must_change)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING *`,
      [id, username, name || username, role, hash, salt, b.mustChange !== false]
    )).rows[0];
    await audit(u, "user", id, "create", null, { username, role }, `أنشأ مستخدم ${username}`);
    return c.json({ ok: true, user: publicUser(row) });
  });

  /* ── PUT /api/costing/users/:id  (and PUT /users with id in the body) ─────
     Renames, role changes, activate/deactivate. Never touches the password —
     that is its own route, so a rename can never reset a password by accident. */
  async function updateUser(c, idFromPath) {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    const b = await c.req.json().catch(() => ({}));
    const id = String(idFromPath || b.id || "").trim();
    if (!id) return c.json({ ok: false, error: "id_required" }, 400);

    const cur = (await pool.query("SELECT * FROM costing_users WHERE id = $1", [id])).rows[0];
    if (!cur) return c.json({ ok: false, error: "not_found" }, 404);

    const name = b.name === undefined && b.displayName === undefined
      ? cur.display_name : String(b.name ?? b.displayName ?? "").trim();
    const role = b.role === undefined ? cur.role
      : (ROLES.includes(String(b.role)) ? String(b.role) : cur.role);
    const active = b.active === undefined ? cur.active : !!b.active;

    // You cannot demote or deactivate the last active owner. Locking the owner
    // out of his own cost system is not a state this endpoint may produce.
    if ((cur.role === "owner" && (role !== "owner" || !active))) {
      const others = (await pool.query(
        "SELECT count(*)::int AS n FROM costing_users WHERE role='owner' AND active=true AND id <> $1", [id]
      )).rows[0].n;
      if (others === 0) return c.json({ ok: false, error: "last_owner",
        message: "لا يمكن إلغاء آخر حساب مالك" }, 400);
    }

    const row = (await pool.query(
      `UPDATE costing_users SET display_name=$2, role=$3, active=$4, updated_at=NOW()
        WHERE id=$1 RETURNING *`, [id, name || cur.username, role, active])).rows[0];
    if (!active) await pool.query("DELETE FROM costing_sessions WHERE user_id = $1", [id]);

    if (cur.role !== role) await audit(u, "user", id, "role", cur.role, role);
    if (cur.active !== active) await audit(u, "user", id, "active", cur.active, active);
    if (cur.display_name !== row.display_name) await audit(u, "user", id, "name", cur.display_name, row.display_name);
    return c.json({ ok: true, user: publicUser(row) });
  }
  app.put("/api/costing/users/:id", async (c) => updateUser(c, c.req.param("id")));
  app.put("/api/costing/users", async (c) => updateUser(c, null));

  /* ── POST /api/costing/users/:id/password ───────────────────────────────
     Owner resets somebody's password. The new password comes FROM the owner in
     the request body — this route never generates one, because a generated
     password has to be transported somehow and the only channels available
     here (the log, the response) are both places it should not appear. */
  app.post("/api/costing/users/:id/password", async (c) => {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    const id = String(c.req.param("id") || "").trim();
    const b = await c.req.json().catch(() => ({}));
    const problem = passwordProblem(b.password ?? b.newPassword);
    if (problem) return c.json({ ok: false, error: "weak_password", message: problem }, 400);

    const cur = (await pool.query("SELECT * FROM costing_users WHERE id = $1", [id])).rows[0];
    if (!cur) return c.json({ ok: false, error: "not_found" }, 404);

    const salt = randomBytes(16).toString("hex");
    const hash = await hashPassword(String(b.password ?? b.newPassword), salt);
    await pool.query(
      `UPDATE costing_users SET pass_hash=$2, pass_salt=$3, must_change=$4, updated_at=NOW() WHERE id=$1`,
      [id, hash, salt, b.mustChange !== false]);
    await pool.query("DELETE FROM costing_sessions WHERE user_id = $1", [id]);
    await audit(u, "user", id, "password_reset", null, null, `أعاد تعيين كلمة مرور ${cur.username}`);
    // The response says it worked and nothing else. The owner already knows the
    // password — he chose it.
    return c.json({ ok: true, message: "تم تغيير كلمة المرور — الجلسات القديمة انتهت" });
  });

  /* ── DELETE /api/costing/users/:id — deactivate, never destroy ───────────
     The audit trail references `actor_id`; deleting the row would orphan
     months of history and make "who changed this" unanswerable. */
  app.delete("/api/costing/users/:id", async (c) => {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    const id = String(c.req.param("id") || "").trim();
    const cur = (await pool.query("SELECT * FROM costing_users WHERE id = $1", [id])).rows[0];
    if (!cur) return c.json({ ok: false, error: "not_found" }, 404);
    if (cur.role === "owner") {
      const others = (await pool.query(
        "SELECT count(*)::int AS n FROM costing_users WHERE role='owner' AND active=true AND id <> $1", [id]
      )).rows[0].n;
      if (others === 0) return c.json({ ok: false, error: "last_owner",
        message: "لا يمكن إلغاء آخر حساب مالك" }, 400);
    }
    await pool.query("UPDATE costing_users SET active=false, updated_at=NOW() WHERE id=$1", [id]);
    await pool.query("DELETE FROM costing_sessions WHERE user_id = $1", [id]);
    await audit(u, "user", id, "active", true, false, `عطّل ${cur.username}`);
    return c.json({ ok: true, deactivated: true });
  });

  /* ── GET / PUT /api/costing/visibility ──────────────────────────────────── */
  app.get("/api/costing/visibility", async (c) => {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    return c.json({ ok: true, visibility: await getVisibility(), labels: VISIBILITY_LABELS,
                    defaults: DEFAULT_VISIBILITY });
  });

  app.put("/api/costing/visibility", async (c) => {
    const u = await requireCostingOwner(c); if (isResponse(u)) return u;
    const b = await c.req.json().catch(() => ({}));
    const src = b && typeof b.visibility === "object" && b.visibility !== null ? b.visibility : b;
    const before = await getVisibility();
    const next = { ...before };
    for (const k of Object.keys(DEFAULT_VISIBILITY))
      if (typeof src?.[k] === "boolean") next[k] = src[k];
    next.users = false;   // the manager never administers users, whatever is posted

    await pool.query(
      `INSERT INTO costing_settings (key, value, updated_at, updated_by)
       VALUES ('visibility', $1::jsonb, NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
      [JSON.stringify(next), String(u.id || "")]);
    const changed = Object.keys(DEFAULT_VISIBILITY).filter((k) => before[k] !== next[k]);
    if (changed.length) await audit(u, "visibility", "visibility", changed.join(","), before, next);
    return c.json({ ok: true, visibility: next, changed, labels: VISIBILITY_LABELS });
  });

  /* ── Boot ─────────────────────────────────────────────────────────────────
     The promise is RETURNED, not just fired. `costing.js` waits on it before
     running its own DDL: both modules declare `cw_audit`, and two concurrent
     `CREATE TABLE IF NOT EXISTS` on the same relation is one of the few DDL
     races PostgreSQL does not swallow — it raises a duplicate-key error on
     pg_type, which would take the rest of the workbench schema down with it.
     Sequencing them costs a few milliseconds at boot and removes the race. */
  const ready = ensureCostingAuthSchema()
    .then(() => console.log("[costing-auth] schema ready"))
    .catch((e) => console.error("[costing-auth] schema init failed:", e.message));

  return {
    requireCostingUser, requireCostingOwner, getVisibility, visibilityFor,
    audit, publicUser, ensureCostingAuthSchema, hashPassword, verifyPassword,
    isResponse, ready,
  };
}

export default registerCostingAuth;
