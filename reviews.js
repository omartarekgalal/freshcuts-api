/* ═══════════════════════════════════════════════════════════════════════════
   التقييمات (Reputation) — لينك/QR/NFC → تقييم → توجيه ذكي متوافق

   الفكرة: العميل يمسح كود (على الطاولة، الفاتورة، إدراج التوصيل) أو يفتح لينك،
   يقيّم بالنجوم:
     • راضي (≥ العتبة، افتراضي ٤) → «يسعدنا رأيك» + زرار لجوجل ماب.
     • مش راضي → فورم داخلي «قولنا إيه اللي حصل» + تنبيه فوري للمدير، ورابط
       جوجل يفضل ظاهر مش مخفي.

   ليه مش بوابة صارمة (حجب السلبي عن جوجل): ده review gating وجوجل بيمنعه —
   ممكن يحذف تقييماتك أو يعلّق صفحتك. التوجيه الذكي بيجيب نفس النتيجة (تمسك
   المشكلة بدري) من غير ما يخالف السياسة، لأننا مابنمنعش حد من جوجل — بنخلّي
   الحل الداخلي هو الأسهل والأجذب للزعلان بس.

   كل تقييم بيتسجّل بمصدره (أي كود) عشان تعرف المشاكل جاية منين.
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

const CATEGORIES = ["الأكل", "التوصيل", "الخدمة", "السعر", "النظافة", "الوقت"];
const DEFAULTS = { active: true, threshold: 4, googleUrl: "", brand: "فريش كاتس", alertNegative: true };

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  const notify = () => (typeof deps.notify === "function" ? deps.notify() : null);

  const clip = (v, n) => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };
  const bad = (c, error, status = 400) => c.json({ ok: false, error }, status);
  const norm = (p) => { try { return normPhone(p); } catch { return null; } };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id BIGSERIAL PRIMARY KEY,
        rating INT NOT NULL,
        comment TEXT,
        categories TEXT[] NOT NULL DEFAULT '{}',
        code TEXT,
        code_label TEXT,
        channel TEXT,                 -- qr | nfc | link
        phone_norm TEXT,
        name TEXT,
        went_google BOOLEAN NOT NULL DEFAULT FALSE,
        resolved BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        resolution_note TEXT,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS reviews_created_idx ON reviews(created_at DESC);
      CREATE INDEX IF NOT EXISTS reviews_open_idx ON reviews(resolved, rating);
      -- أكواد لكل مكان (طاولة/فاتورة/توصيل) عشان نعرف التقييم جه منين
      CREATE TABLE IF NOT EXISTS review_codes (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'qr',   -- qr | nfc | link
        scans INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
  ensureSchema().then(() => console.log("[reviews] ready"))
    .catch((e) => console.error("[reviews] init failed:", e.message));

  async function cfg() {
    const s = await getSettingsData();
    return { ...DEFAULTS, ...(((s || {}).reviews) || {}) };
  }
  const STORE_PUBLIC = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const ipOf = (c) => c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";

  /* بسيط ضد الإساءة: نفس الـIP مش أكتر من ٢٠ تقييم في الساعة */
  const rl = new Map();
  function limited(ip) {
    const now = Date.now(), slot = rl.get(ip);
    if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
    slot.n++; if (rl.size > 5000) rl.clear();
    return slot.n > 20;
  }

  /* ── عام: إعدادات صفحة التقييم (اللاندنج بتناديها أول ما تفتح) ─────────── */
  app.get("/api/reviews/config", async (c) => {
    const cf = await cfg();
    const code = clip(c.req.query("c"), 40);
    let label = null;
    if (code) {
      const r = await pool.query(
        "UPDATE review_codes SET scans = scans + 1 WHERE code=$1 AND active RETURNING label", [code]);
      label = r.rows[0]?.label || null;
    }
    return c.json({
      ok: true, active: cf.active !== false, brand: cf.brand,
      threshold: cf.threshold, hasGoogle: Boolean(cf.googleUrl),
      googleUrl: cf.googleUrl || "", categories: CATEGORIES, codeLabel: label,
    });
  });

  /* ── عام: تسجيل النجوم. بيرجّع التوجيه: جوجل ولا فورم داخلي ────────────── */
  app.post("/api/reviews/rate", async (c) => {
    const ip = ipOf(c);
    if (limited(ip)) return bad(c, "rate_limited", 429);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const rating = Math.round(Number(b.rating));
    if (!(rating >= 1 && rating <= 5)) return bad(c, "bad_rating");
    const cf = await cfg();
    if (cf.active === false) return bad(c, "inactive", 403);
    const code = clip(b.code, 40);
    let label = null, kind = "link";
    if (code) {
      const r = await pool.query("SELECT label, kind FROM review_codes WHERE code=$1", [code]);
      if (r.rows[0]) { label = r.rows[0].label; kind = r.rows[0].kind; }
    }
    const ins = await pool.query(
      `INSERT INTO reviews(rating, code, code_label, channel, ip) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [rating, code, label, kind, ip.slice(0, 60)]);
    const id = ins.rows[0].id;
    const route = rating >= cf.threshold && cf.googleUrl ? "google" : "internal";
    return c.json({ ok: true, id, route, googleUrl: cf.googleUrl || "", threshold: cf.threshold });
  });

  /* ── عام: تفاصيل التقييم السلبي (الفورم الداخلي) + تنبيه المدير ────────── */
  app.post("/api/reviews/:id/feedback", async (c) => {
    const id = Number(c.req.param("id"));
    if (!(id > 0)) return bad(c, "bad_id");
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const comment = clip(b.comment, 1000);
    const cats = Array.isArray(b.categories)
      ? b.categories.filter((x) => CATEGORIES.includes(x)).slice(0, 6) : [];
    const phone = norm(b.phone);
    const name = clip(b.name, 80);
    const r = await pool.query(
      `UPDATE reviews SET comment=$2, categories=$3,
              phone_norm=$4, name=$5
        WHERE id=$1 AND comment IS NULL RETURNING rating, code_label`,
      [id, comment, cats, /^5\d{8}$/.test(phone || "") ? phone : null, name]);
    if (!r.rowCount) return c.json({ ok: true, dup: true }); // اتبعت قبل كده
    // تنبيه المدير — نفس أرقام إنذارات التشغيل، بالمرسل المعاملاتي (مش الإعلاني)
    const cf = await cfg();
    if (cf.alertNegative !== false) {
      const s = await getSettingsData();
      const managers = ((s.delivery || {}).alertPhones || []).map(norm).filter((p) => /^5\d{8}$/.test(p || ""));
      const rv = r.rows[0];
      const where = rv.code_label ? ` (${rv.code_label})` : "";
      const text = `⚠️ تقييم ${rv.rating}★${where}: ${comment || "بدون تعليق"}${cats.length ? ` — ${cats.join("، ")}` : ""}${phone ? ` — ${phone}` : ""}`;
      const n = notify();
      for (const p of managers) n?.sendSmsTo?.(p, text).catch(() => {});
    }
    return c.json({ ok: true });
  });

  /* ── عام: بيكون (beacon) إن العميل ضغط زرار جوجل فعلاً ────────────────── */
  app.post("/api/reviews/:id/went-google", async (c) => {
    const id = Number(c.req.param("id"));
    if (id > 0) await pool.query("UPDATE reviews SET went_google=TRUE WHERE id=$1", [id]);
    return c.json({ ok: true });
  });

  /* ═══ لوحة التحكم (تحت قسم العملاء) ══════════════════════════════════════ */

  app.get("/api/cms/reviews", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const q = (k) => c.req.query(k);
    const where = ["1=1"], p = [];
    if (q("filter") === "open") where.push("resolved=FALSE AND rating < 4");
    else if (q("filter") === "negative") where.push("rating < 4");
    else if (q("filter") === "positive") where.push("rating >= 4");
    if (/^\d{4}-\d{2}-\d{2}$/.test(q("from") || "")) { p.push(q("from")); where.push(`created_at >= $${p.length}::date`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q("to") || "")) { p.push(q("to")); where.push(`created_at < ($${p.length}::date + 1)`); }
    const rows = (await pool.query(
      `SELECT id, rating, comment, categories, code_label, channel, phone_norm, name,
              went_google, resolved, resolved_by, resolved_at, resolution_note, created_at
         FROM reviews WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 300`, p)).rows;
    return c.json({ ok: true, reviews: rows });
  });

  app.get("/api/cms/reviews/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
    const [tot, dist, open] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n, avg(rating)::float AS avg,
                         count(*) FILTER (WHERE rating >= 4)::int AS positive,
                         count(*) FILTER (WHERE rating < 4)::int AS negative,
                         count(*) FILTER (WHERE went_google)::int AS to_google
                    FROM reviews WHERE created_at > NOW() - ($1||' days')::interval`, [String(days)]),
      pool.query(`SELECT rating, count(*)::int AS n FROM reviews
                   WHERE created_at > NOW() - ($1||' days')::interval GROUP BY 1`, [String(days)]),
      pool.query(`SELECT count(*)::int AS n FROM reviews WHERE resolved=FALSE AND rating < 4`),
    ]);
    const t = tot.rows[0];
    const distribution = {};
    for (let i = 1; i <= 5; i++) distribution[i] = 0;
    for (const r of dist.rows) distribution[r.rating] = r.n;
    return c.json({
      ok: true, days,
      total: t.n, avg: t.avg == null ? null : Number(t.avg),
      positive: t.positive, negative: t.negative, toGoogle: t.to_google,
      openNegative: open.rows[0].n, distribution,
    });
  });

  app.post("/api/cms/reviews/:id/resolve", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    let b = {}; try { b = await c.req.json(); } catch { /* لا شيء */ }
    const who = await whoName(c);
    await pool.query(
      `UPDATE reviews SET resolved=TRUE, resolved_by=$2, resolved_at=NOW(), resolution_note=$3 WHERE id=$1`,
      [id, who, clip(b.note, 500)]);
    return c.json({ ok: true });
  });

  // رد على العميل اللي ساب رقمه (SMS من المرسل المعاملاتي)
  app.post("/api/cms/reviews/:id/reply", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const text = clip(b.text, 300);
    if (!text) return bad(c, "empty");
    const r = await pool.query("SELECT phone_norm FROM reviews WHERE id=$1", [id]);
    const ph = r.rows[0]?.phone_norm;
    if (!/^5\d{8}$/.test(ph || "")) return bad(c, "no_phone");
    try { await notify()?.sendSmsTo?.(ph, text); } catch (e) { return bad(c, "sms_failed", 502); }
    return c.json({ ok: true });
  });

  app.put("/api/cms/reviews/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const cur = await cfg();
    const next = { ...cur };
    if (typeof b.active === "boolean") next.active = b.active;
    if (b.googleUrl !== undefined) {
      const u = clip(b.googleUrl, 500);
      if (u && !/^https:\/\//i.test(u)) return bad(c, "bad_url");
      next.googleUrl = u || "";
    }
    if (b.threshold !== undefined) {
      const t = Math.round(Number(b.threshold));
      if (!(t >= 2 && t <= 5)) return bad(c, "bad_threshold");
      next.threshold = t;
    }
    if (typeof b.alertNegative === "boolean") next.alertNegative = b.alertNegative;
    if (b.brand !== undefined) next.brand = clip(b.brand, 40) || DEFAULTS.brand;
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'reviews' THEN data ELSE jsonb_set(data,'{reviews}','{}'::jsonb,true) END,
         '{reviews}', $1::jsonb, true) WHERE id=1`, [jb(next)]);
    return c.json({ ok: true, settings: next });
  });

  /* الأكواد (طاولة/فاتورة/توصيل…) */
  app.get("/api/cms/reviews/codes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query("SELECT * FROM review_codes ORDER BY created_at")).rows;
    return c.json({ ok: true, codes: rows, base: `${STORE_PUBLIC()}/r` });
  });
  app.post("/api/cms/reviews/codes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const label = clip(b.label, 60);
    if (!label) return bad(c, "label_required");
    const kind = ["qr", "nfc", "link"].includes(b.kind) ? b.kind : "qr";
    const code = (clip(b.code, 40) || crypto.randomBytes(4).toString("hex"))
      .toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!code) return bad(c, "bad_code");
    try {
      await pool.query("INSERT INTO review_codes(code, label, kind) VALUES ($1,$2,$3)", [code, label, kind]);
    } catch { return bad(c, "code_exists", 409); }
    return c.json({ ok: true, code, url: `${STORE_PUBLIC()}/r?c=${code}` });
  });
  app.put("/api/cms/reviews/codes/:code", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const code = c.req.param("code");
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    await pool.query("UPDATE review_codes SET label=COALESCE($2,label), active=COALESCE($3,active) WHERE code=$1",
      [code, clip(b.label, 60), typeof b.active === "boolean" ? b.active : null]);
    return c.json({ ok: true });
  });
  app.delete("/api/cms/reviews/codes/:code", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM review_codes WHERE code=$1", [c.req.param("code")]);
    return c.json({ ok: true });
  });

  async function whoName(c) {
    try {
      const h = c.req.header("authorization") || "";
      const t = h.replace(/^Bearer\s+/i, "");
      if (t.startsWith("cms:") && deps.sessionUser) { const u = await deps.sessionUser(t); if (u) return u.name; }
    } catch { /* تجاهل */ }
    return "المالك";
  }

  console.log("[reviews] routes registered");
}
