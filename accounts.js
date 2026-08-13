/* ═══════════════════════════════════════════════════════════════════════════
   ACCOUNTS — the customer's own profile on order.o2m8.me.

   Omar's spec (2026-08-11): «العميل يكون ليه ملف يشوف طلباته ويعيد الطلب
   ويعمل كل حاجة» + «يتسجل تلقائياً في دفتر عملاء تاب سينس، ولو بياناته
   موجودة قبل كده تدخل لواحدها عادي».

   Identity = the Saudi mobile, same rule as the whole API. Login is
   phone + OTP over SMS (Taqnyat — subscription in progress; until the
   credentials land, settings.shop.otpDevMode=true lets us test end-to-end
   and MUST be off in production because it returns the code in the reply).

   TabSense directory: on login we link, we don't blindly create. If the
   phone already exists in ts_customers the account simply points at it
   (Omar: «تدخل لواحدها عادي»); only a genuinely new phone goes through
   tabsense.createCustomer — which enforces the silent-rejection rules
   (short names, non-Saudi mobiles) and still can't be fully trusted, so we
   record its answer and let the next ts_customers sync confirm the truth.

   Env: TAQNYAT_API_KEY, TAQNYAT_SENDER (CITC-approved sender name).
   Toggle: settings.notifications.smsEnabled (dashboard-controlled).
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import * as tabsense from "./tabsense.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();

const OTP_TTL_MIN = 5;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_DAYS = 180;

/* ── Taqnyat SMS (the one place SMS leaves this API; notify.js will reuse) ── */
export async function sendSms({ phoneNorm, body }) {
  const key = env("TAQNYAT_API_KEY");
  const sender = env("TAQNYAT_SENDER");
  if (!key || !sender) throw Object.assign(new Error("Taqnyat not configured"), { code: "SMS_UNCONFIGURED" });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  let resp;
  try {
    resp = await fetch("https://api.taqnyat.sa/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipients: [`966${phoneNorm}`], body, sender }),
      signal: ctl.signal,
    });
  } finally { clearTimeout(t); }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data.statusCode && data.statusCode >= 400)) {
    throw Object.assign(new Error(`Taqnyat: ${data.message || resp.status}`), { code: "SMS_FAILED", resp: data });
  }
  return data;
}

const hashOtp = (phoneNorm, code) =>
  crypto.createHash("sha256").update(`${phoneNorm}|${code}|${env("ADMIN_TOKEN", "otp")}`).digest("hex");

/* per-IP limiter (same naive shape as funnel.js) */
const rl = new Map();
function rateLimited(ip, max) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone, deliveryAppOf } = ctx;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS acct_customers (
        phone_norm TEXT PRIMARY KEY,
        name TEXT,
        addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
        ts_customer_id BIGINT,
        ts_sync JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      -- خصم دائم لعميل بعينه (الملاك 50% مثلاً): بينزل تلقائياً في الشيك أوت
      -- بمجرد ما رقمه يتكتب — مش محتاج حتى تسجيل دخول.
      ALTER TABLE acct_customers ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE acct_customers ADD COLUMN IF NOT EXISTS discount_label TEXT;
      CREATE TABLE IF NOT EXISTS acct_otp (
        phone_norm TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS acct_sessions (
        token TEXT PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS acct_sessions_phone_idx ON acct_sessions(phone_norm);
    `);
  }
  ensureSchema()
    .then(() => console.log("[accounts] schema ready"))
    .catch((e) => console.error("[accounts] schema failed:", e.message));

  /* customer auth: Authorization: Bearer cust:<token> → account row or null */
  async function customerOf(c) {
    const h = c.req.header("Authorization") || "";
    const m = h.match(/^Bearer cust:([a-f0-9]{48,96})$/i);
    if (!m) return null;
    const r = await pool.query(
      `UPDATE acct_sessions SET last_seen_at=NOW()
        WHERE token=$1 AND created_at > NOW() - INTERVAL '${SESSION_DAYS} days'
        RETURNING phone_norm`, [m[1]]);
    if (!r.rowCount) return null;
    const a = await pool.query("SELECT * FROM acct_customers WHERE phone_norm=$1", [r.rows[0].phone_norm]);
    return a.rows[0] || null;
  }

  /* ── POST /api/account/otp/request {phone} ── */
  app.post("/api/account/otp/request", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 30)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const phoneNorm = normPhone(b.phone);
    if (!/^5\d{8}$/.test(phoneNorm)) return c.json({ ok: false, error: "invalid_phone" }, 400);

    const prev = await pool.query("SELECT created_at FROM acct_otp WHERE phone_norm=$1", [phoneNorm]);
    if (prev.rowCount && Date.now() - new Date(prev.rows[0].created_at).getTime() < OTP_RESEND_SECONDS * 1000) {
      return c.json({ ok: false, error: "resend_too_soon", retryAfter: OTP_RESEND_SECONDS }, 429);
    }

    const code = String(crypto.randomInt(1000, 10000));
    await pool.query(
      `INSERT INTO acct_otp(phone_norm, code_hash, attempts, expires_at, created_at)
       VALUES ($1,$2,0,NOW() + INTERVAL '${OTP_TTL_MIN} minutes',NOW())
       ON CONFLICT (phone_norm) DO UPDATE
         SET code_hash=$2, attempts=0, expires_at=NOW() + INTERVAL '${OTP_TTL_MIN} minutes', created_at=NOW()`,
      [phoneNorm, hashOtp(phoneNorm, code)]);

    const settings = await getSettingsData();
    const smsOn = (settings.notifications || {}).smsEnabled !== false && env("TAQNYAT_API_KEY");
    if (smsOn) {
      try {
        await sendSms({ phoneNorm, body: `رمز الدخول لفريش كتس: ${code}\nصالح ${OTP_TTL_MIN} دقائق.` });
        return c.json({ ok: true, sent: "sms" });
      } catch (e) {
        console.error("[accounts] OTP SMS failed:", e.message);
        // fall through — dev mode may still save the flow, otherwise honest error
      }
    }
    if ((settings.shop || {}).otpDevMode === true) {
      // PRE-LAUNCH ONLY: lets us test the whole flow before Taqnyat activates.
      // The dashboard toggle must be off the day real customers arrive.
      return c.json({ ok: true, sent: "dev", devCode: code });
    }
    return c.json({ ok: false, error: "sms_not_configured" }, 503);
  });

  /* ── POST /api/account/otp/verify {phone, code, name?} → session token ── */
  app.post("/api/account/otp/verify", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 60)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const phoneNorm = normPhone(b.phone);
    const code = String(b.code || "").replace(/\D/g, "");
    if (!/^5\d{8}$/.test(phoneNorm) || !code) return c.json({ ok: false, error: "invalid_input" }, 400);

    const r = await pool.query("SELECT * FROM acct_otp WHERE phone_norm=$1", [phoneNorm]);
    const otp = r.rows[0];
    if (!otp || new Date(otp.expires_at) < new Date()) return c.json({ ok: false, error: "expired" }, 401);
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return c.json({ ok: false, error: "too_many_attempts" }, 429);
    if (otp.code_hash !== hashOtp(phoneNorm, code)) {
      await pool.query("UPDATE acct_otp SET attempts=attempts+1 WHERE phone_norm=$1", [phoneNorm]);
      return c.json({ ok: false, error: "wrong_code" }, 401);
    }
    await pool.query("DELETE FROM acct_otp WHERE phone_norm=$1", [phoneNorm]);

    const name = String(b.name || "").trim().slice(0, 60) || null;
    await pool.query(
      `INSERT INTO acct_customers(phone_norm, name, last_login_at) VALUES ($1,$2,NOW())
       ON CONFLICT (phone_norm) DO UPDATE
         SET name = COALESCE(EXCLUDED.name, acct_customers.name), last_login_at=NOW()`,
      [phoneNorm, name]);

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query("INSERT INTO acct_sessions(token, phone_norm) VALUES ($1,$2)", [token, phoneNorm]);

    // TabSense directory, Omar's rule: link if known, create only if new —
    // and never let a POS hiccup block a login.
    linkOrCreateTsCustomer(phoneNorm).catch((e) =>
      console.error("[accounts] ts link failed:", e.message));

    return c.json({ ok: true, token, phone: phoneNorm, name });
  });

  async function linkOrCreateTsCustomer(phoneNorm) {
    const acct = (await pool.query("SELECT * FROM acct_customers WHERE phone_norm=$1", [phoneNorm])).rows[0];
    if (!acct || acct.ts_customer_id) return;
    // already in the POS directory? just point at it.
    const known = await pool.query(
      "SELECT customer_id, name FROM ts_customers WHERE phone_norm=$1 LIMIT 1", [phoneNorm]);
    if (known.rowCount) {
      // البيانات الموجودة على TabSense هي الأصل (طلب عمر 2026-08-14): اسم
      // العميل المسجل هناك بيكسب على اللي اتكتب وقت الدخول — الربط بيحصل
      // مرة واحدة فمفيش دهس متكرر لاسم اختاره العميل بعدها.
      await pool.query(
        `UPDATE acct_customers SET ts_customer_id=$2, ts_sync=$3,
                name = COALESCE(NULLIF($4,''), name)
          WHERE phone_norm=$1`,
        [phoneNorm, known.rows[0].customer_id,
         jb({ linked: "existing", at: new Date().toISOString() }),
         String(known.rows[0].name || "").trim()]);
      return;
    }
    // genuinely new: create — respecting the silent-reject rules inside
    // tabsense.createCustomer. The answer is recorded, not trusted; the
    // ts_customers worker sync is what proves the record exists.
    if (!env("TABSENSE_EMAIL")) return; // dashboard connector not configured
    const res = await tabsense.createCustomer({
      firstName: acct.name || "عميل أونلاين",
      phone: phoneNorm,
    });
    await pool.query("UPDATE acct_customers SET ts_sync=$2 WHERE phone_norm=$1",
      [phoneNorm, jb({ create: res, at: new Date().toISOString() })]);
  }

  /* ── profile ── */
  app.get("/api/account/me", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    return c.json({
      ok: true,
      phone: acct.phone_norm, name: acct.name,
      addresses: acct.addresses || [],
      linkedToPos: Boolean(acct.ts_customer_id),
    });
  });

  app.put("/api/account/me", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return c.json({ ok: false, error: "name_required" }, 400);
    await pool.query("UPDATE acct_customers SET name=$2 WHERE phone_norm=$1", [acct.phone_norm, name]);
    return c.json({ ok: true, name });
  });

  /* addresses: [{label, street, area, latitude, longitude, notes}] */
  app.post("/api/account/addresses", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!(b.latitude && b.longitude)) return c.json({ ok: false, error: "location_required" }, 400);
    const addr = {
      label: String(b.label || "عنواني").slice(0, 40),
      street: String(b.street || "").slice(0, 120),
      area: String(b.area || "").slice(0, 60),
      latitude: Number(b.latitude), longitude: Number(b.longitude),
      notes: String(b.notes || "").slice(0, 120),
    };
    const list = [...(acct.addresses || []), addr].slice(-10); // keep the last 10
    await pool.query("UPDATE acct_customers SET addresses=$2 WHERE phone_norm=$1",
      [acct.phone_norm, jb(list)]);
    return c.json({ ok: true, addresses: list });
  });

  app.delete("/api/account/addresses/:idx", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    const idx = Number(c.req.param("idx"));
    const list = (acct.addresses || []).filter((_, i) => i !== idx);
    await pool.query("UPDATE acct_customers SET addresses=$2 WHERE phone_norm=$1",
      [acct.phone_norm, jb(list)]);
    return c.json({ ok: true, addresses: list });
  });

  /* order history: the WHOLE relationship, not just the online slice.
     Omar 2026-08-14: «العميل لما يسجل دخوله يلاقي طلباته اللي طلبها قبل
     كده سواء صالة/تيك أواي/توصيل». The POS cache (ts_orders) is joined by
     the same phone identity the analytics use; orders that ARE our online
     orders are excluded so nothing shows twice. Online rows keep their
     items (reorder works); POS rows are display-only — TabSense's public
     surface doesn't give us their line items. */
  app.get("/api/account/orders", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    const rows = (await pool.query(
      `SELECT order_no, status, option, items, subtotal, delivery_fee, tip, total, created_at
         FROM shop_orders
        WHERE phone_norm=$1 AND status <> 'expired'
        ORDER BY created_at DESC LIMIT 50`, [acct.phone_norm])).rows;

    const settings = await getSettingsData();
    const pos = (await pool.query(
      `SELECT o.order_id, o.order_date, o.calendar_day, o.order_option, o.order_type,
              o.total, o.payments
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
        WHERE o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'
          AND COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) = $1
          AND o.order_id NOT IN (SELECT pos_order_id FROM shop_orders WHERE pos_order_id IS NOT NULL)
        ORDER BY o.order_date DESC NULLS LAST LIMIT 50`, [acct.phone_norm])).rows;

    const posOrders = pos.map((r) => {
      const app = deliveryAppOf(r.payments, settings);
      const opt = String(r.order_option || "");
      const label = app ? `توصيل عبر ${app}`
        : /external/i.test(String(r.order_type || "")) ? "توصيل تطبيقات"
        : /take/i.test(opt) ? "تيك أواي"
        : /deliver/i.test(opt) ? "توصيل المطعم"
        : "في الصالة";
      return {
        kind: "pos", order_id: r.order_id, label,
        total: Number(r.total) || 0,
        at: r.order_date || r.calendar_day,
      };
    });

    return c.json({ ok: true, orders: rows, posOrders });
  });

  app.post("/api/account/logout", async (c) => {
    const h = c.req.header("Authorization") || "";
    const m = h.match(/^Bearer cust:([a-f0-9]{48,96})$/i);
    if (m) await pool.query("DELETE FROM acct_sessions WHERE token=$1", [m[1]]);
    return c.json({ ok: true });
  });

  /* admin: the dashboard's customer-accounts list */
  app.get("/api/account/admin/list", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT a.phone_norm, a.name, a.ts_customer_id, a.discount_percent, a.discount_label,
              a.created_at, a.last_login_at,
              count(o.order_no)::int AS online_orders,
              COALESCE(sum(o.total),0)::numeric AS online_spend
         FROM acct_customers a
         LEFT JOIN shop_orders o ON o.phone_norm = a.phone_norm AND o.status NOT IN ('expired','pending_payment')
        GROUP BY a.phone_norm
        ORDER BY a.discount_percent DESC, a.created_at DESC LIMIT 500`)).rows;
    return c.json({ ok: true, accounts: rows });
  });

  /* admin: grant/update/remove a standing discount for one phone. Creates the
     account row if the person never logged in — the discount works from the
     first order either way. */
  app.post("/api/account/admin/discount", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const phone = normPhone(b.phone);
    if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "invalid_phone" }, 400);
    const pct = Math.max(0, Math.min(100, Number(b.percent) || 0));
    await pool.query(
      `INSERT INTO acct_customers(phone_norm, name, discount_percent, discount_label)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (phone_norm) DO UPDATE SET
         discount_percent=$3, discount_label=$4,
         name = COALESCE(acct_customers.name, EXCLUDED.name)`,
      [phone, String(b.name || "").trim().slice(0, 60) || null, pct,
       pct > 0 ? String(b.label || "خصم خاص").slice(0, 40) : null]);
    return c.json({ ok: true, phone, percent: pct });
  });

  /* shop.js asks: does this phone carry a standing discount? */
  async function customerDiscount(phoneNorm) {
    const r = await pool.query(
      "SELECT discount_percent, discount_label FROM acct_customers WHERE phone_norm=$1", [phoneNorm]);
    const row = r.rows[0];
    if (!row || !(Number(row.discount_percent) > 0)) return null;
    return { percent: Number(row.discount_percent), label: row.discount_label || "خصم خاص" };
  }

  return { customerOf, sendSms, customerDiscount };
}
