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
import * as places from "./places.js";
import { staffPhoneSet } from "./smsrules.js";
import { subscribe } from "./order-events.js";

const CATEGORIES = ["الأكل", "التوصيل", "الخدمة", "السعر", "النظافة", "الوقت"];
export const DEFAULTS = {
  active: true, threshold: 4, googleUrl: "", brand: "فريش كاتس", alertNegative: true,
  /* ⭐ التقييم الحقيقي من جوجل (places.js) — معرّف المكان بيتحفظ هنا، مش
     مكتوب في الكود، عشان يتغيّر من اللوحة لو فتح فرع تاني. */
  placeId: "", googleRefreshHours: 12, showBadge: true,
  /* 📩 طلب التقييم بعد التوصيل (عمر ١٧ سبتمبر): «بعد ما العميل يستلم الطلب
     نبعتله لينك التقييم بنص ساعة». رسالة واحدة لكل طلب، بالمُرسل المعاملاتي،
     وبتحترم نافذة سكوت (ما نصحّيش حد الفجر عشان نقييم). */
  askAfterDelivery: true,
  askAfterMinutes: 30,
  askText: "كيف كان طلبك من فريش كاتس؟ رأيك يهمنا: {link}",
  askQuietStart: 2,   // من ٢ الفجر…
  askQuietEnd: 11,    // …لحد ١١ الصبح: الطلب اللي اتسلّم بالليل بيتأجّل للصبح
  askMaxAgeHours: 20, // فات ٢٠ ساعة على التوصيل؟ خلاص، مانسألش على طلب قديم
};

/* نافذة السكوت ممكن تلف حوالين نص الليل (٢٢ → ١١) — نفس منطق smsrules */
export function inAskQuiet(hour, start, end) {
  const h = ((Math.round(Number(hour)) % 24) + 24) % 24;
  const s = ((Math.round(Number(start)) % 24) + 24) % 24;
  const e = ((Math.round(Number(end)) % 24) + 24) % 24;
  if (s === e) return false;
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}
export const riyadhHour = (now = new Date()) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", hour12: false }).format(now));

/* نص رسالة طلب التقييم — {link} إجباري، ولو المالك مسحه بنلزقه في الآخر
   (رسالة تقييم من غير رابط = تكلفة من غير فايدة). */
export function askBody(text, link) {
  const t = String(text || DEFAULTS.askText).trim().slice(0, 200);
  return t.includes("{link}") ? t.replace("{link}", link) : `${t} ${link}`;
}

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
      -- دعوة تقييم واحدة لكل طلب اتسلّم (SMS بعد نص ساعة). الجدول هو الضمانة
      -- إن العميل مايتبعتلوش مرتين حتى لو الحدث اتكرر أو الحاوية اتبدّلت.
      CREATE TABLE IF NOT EXISTS review_invites (
        order_no TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        phone_norm TEXT,
        option TEXT,
        due_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ, channel TEXT, skip_reason TEXT,
        opened_at TIMESTAMPTZ,
        review_id BIGINT, rating INT,
        went_google BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS review_invites_due_idx ON review_invites(due_at)
        WHERE sent_at IS NULL AND skip_reason IS NULL;
      CREATE INDEX IF NOT EXISTS review_invites_created_idx ON review_invites(created_at DESC);
    `);
  }
  ensureSchema().then(() => console.log("[reviews] ready"))
    .catch((e) => console.error("[reviews] init failed:", e.message));

  async function cfg() {
    const s = await getSettingsData();
    const c = { ...DEFAULTS, ...(((s || {}).reviews) || {}) };
    // عمر لسه مالزقش رابط g.page؟ نبنيه من معرّف المكان — أحسن من صفحة شكر
    // من غير زرار جوجل (ده كان المفتوح الوحيد في مشروع التقييمات).
    if (!c.googleUrl && places.validPlaceId(c.placeId)) c.googleUrl = places.writeReviewUrl(c.placeId);
    return c;
  }
  const STORE_PUBLIC = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "");
  const ipOf = (c) => c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";

  /* ═══ ⭐ تقييم جوجل الحقيقي — نسخة واحدة في settings.googlePlace ═════════
     بيتحدّث كل googleRefreshHours (١٢ افتراضياً) من جوب في الخلفية، والمتجر
     بيقراه من الإعدادات. **مافيش نداء لجوجل في عرض صفحة أبداً** — ده اللي
     بيخلّي التكلفة صفر (شوف places.js للـSKU والحساب). */
  const placeCache = async () => ((await getSettingsData()) || {}).googlePlace || null;
  async function savePlace(p) {
    const row = { ...p, at: new Date().toISOString() };
    await pool.query(`UPDATE settings SET data = jsonb_set(data, '{googlePlace}', $1::jsonb, true) WHERE id=1`, [jb(row)]);
    return row;
  }
  async function refreshPlace({ force = false } = {}) {
    const cf = await cfg();
    const cur = await placeCache();
    const placeId = cf.placeId || cur?.placeId || "";
    if (!places.validPlaceId(placeId)) return { ok: false, error: "no_place_id" };
    if (!force && cur && !places.staleAfter(cur.at, cf.googleRefreshHours)) return { ok: true, cached: true, place: cur };
    try {
      const p = await places.fetchPlaceDetails(placeId);
      if (!p) return { ok: false, error: "no_rating" };            // مفيش تقييم = مانكتبش رقم مخترع
      const saved = await savePlace(p);
      console.log(`[reviews] google rating ${saved.rating}★ / ${saved.count}`);
      return { ok: true, place: saved };
    } catch (e) {
      console.error("[reviews] google refresh failed:", e.message);
      // بنسيب آخر رقم صحيح مكانه وبنسجّل سبب الفشل عشان اللوحة تقوله
      if (cur) await pool.query(
        `UPDATE settings SET data = jsonb_set(data, '{googlePlace,error}', $1::jsonb, true) WHERE id=1`,
        [jb(String(e.message).slice(0, 160))]).catch(() => {});
      return { ok: false, error: String(e.message).slice(0, 160) };
    }
  }
  /* الجوب: فحص كل ساعة، ونداء فعلي بس لما النسخة تبقى قديمة */
  if (Number(process.env.REVIEWS_GOOGLE_JOB ?? 1)) {
    setTimeout(() => refreshPlace().catch(() => {}), 20_000);
    setInterval(() => refreshPlace().catch(() => {}), 3600_000);
  }

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
      // مش كود مكان؟ يبقى كود طلب (رسالة ما بعد التوصيل) — نعدّ الفتحة كمان
      if (!label) {
        const iv = await pool.query(
          `UPDATE review_invites SET opened_at = COALESCE(opened_at, NOW())
            WHERE code=$1 RETURNING order_no, option`, [code]);
        if (iv.rows[0]) label = iv.rows[0].option === "pickup" ? "استلام من الفرع" : "توصيل";
      }
    }
    return c.json({
      ok: true, active: cf.active !== false, brand: cf.brand,
      threshold: cf.threshold, hasGoogle: Boolean(cf.googleUrl),
      googleUrl: cf.googleUrl || "", categories: CATEGORIES, codeLabel: label,
    });
  });

  /* ── عام: تقييم جوجل للمتجر (⭐ ٤٫٨ · ١٨١ تقييم) ─────────────────────────
     من النسخة المخزّنة بس — نداء جوجل بيحصل في الجوب، مش هنا. لو مفيش رقم
     حقيقي بنرجّع null والمتجر مابيرسمش الشارة (ولا بيخترع رقم). */
  app.get("/api/reviews/google", async (c) => {
    const [cf, p] = await Promise.all([cfg(), placeCache()]);
    const ok = Boolean(p && p.rating > 0 && p.count >= 1 && cf.showBadge !== false);
    return c.json({
      ok: true,
      rating: ok ? p.rating : null, count: ok ? p.count : null,
      url: ok ? (p.mapsUrl || places.placeMapsUrl(p.placeId)) : null,
      reviewUrl: cf.googleUrl || "", at: ok ? p.at : null,
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
      else {
        const iv = await pool.query("SELECT order_no, option FROM review_invites WHERE code=$1", [code]);
        if (iv.rows[0]) { kind = "sms"; label = iv.rows[0].option === "pickup" ? "استلام من الفرع" : "توصيل"; }
      }
    }
    const ins = await pool.query(
      `INSERT INTO reviews(rating, code, code_label, channel, ip) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [rating, code, label, kind, ip.slice(0, 60)]);
    const id = ins.rows[0].id;
    // كود طلب؟ نربط التقييم بالدعوة عشان نقيس «اتبعت ↔ قيّم» بجد
    if (code) await pool.query(
      "UPDATE review_invites SET review_id=$2, rating=$3 WHERE code=$1 AND review_id IS NULL", [code, id, rating]
    ).catch(() => {});
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
    if (id > 0) {
      await pool.query("UPDATE reviews SET went_google=TRUE WHERE id=$1", [id]);
      await pool.query("UPDATE review_invites SET went_google=TRUE WHERE review_id=$1", [id]).catch(() => {});
    }
    return c.json({ ok: true });
  });

  /* ═══ 📩 دعوة التقييم بعد التوصيل ═══════════════════════════════════════
     عمر (١٧ سبتمبر): «بعد ما العميل يستلم الطلب نبعتله لينك التقييم بنص
     ساعة نأخد رأيه في الأكل، ولو كويس نبعته على جوجل زي ما عملنا».

     التقاط: كل تغيير حالة لـdelivered (توصيل واستلام) بيعمل صف دعوة واحد
     (order_no مفتاح أساسي ⇒ التكرار مستحيل)، مع كود عشوائي للرابط
     freshcuts.sa/r?c=<code> اللي بيوصل لنفس صفحة التقييم بتوجيهها المعروف.
     الإرسال: مسح كل ٥ دقايق، رسالة واحدة بالمُرسل المعاملاتي.
     المستبعدين: أرقام الفريق، الطلبات الاصطناعية، الموقوفين، وبره النافذة. */
  const inviteCode = () => crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "").toLowerCase().slice(0, 8).padEnd(8, "x");

  async function queueInvite(orderNo, { at = new Date() } = {}) {
    const cf = await cfg();
    if (cf.askAfterDelivery === false) return { ok: false, reason: "disabled" };
    const r = await pool.query(
      "SELECT order_no, phone_norm, option, is_test FROM shop_orders WHERE order_no=$1", [String(orderNo)]);
    const o = r.rows[0];
    if (!o) return { ok: false, reason: "no_order" };
    if (o.is_test) return { ok: false, reason: "test_order" };
    if (!/^5\d{8}$/.test(o.phone_norm || "")) return { ok: false, reason: "no_phone" };
    const mins = Math.min(720, Math.max(1, Number(cf.askAfterMinutes) || 30));
    const due = new Date(at.getTime() + mins * 60_000);
    const ins = await pool.query(
      `INSERT INTO review_invites(order_no, code, phone_norm, option, due_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_no) DO NOTHING RETURNING code`,
      [o.order_no, inviteCode(), o.phone_norm, o.option, due.toISOString()]);
    return ins.rowCount ? { ok: true, code: ins.rows[0].code, due } : { ok: false, reason: "exists" };
  }

  // الحدث بيوصل من shop.setStatus في نفس العملية. لو الحاوية اتبدّلت وقت
  // التغيير الحدث بيضيع — عشان كده المسح تحت بيعوّض بالتاريخ المكتوب.
  subscribe((e) => {
    if (e?.name !== "order_status" || e?.data?.to !== "delivered") return;
    queueInvite(e.orderNo).catch((err) => console.error("[reviews] queueInvite:", err.message));
  }, "order_status");

  /* تعويض: أي طلب اتسلّم في آخر ٣ ساعات ومالوش دعوة (rollover / نشر جديد) */
  async function backfillInvites() {
    const rows = (await pool.query(
      `SELECT o.order_no,
              (SELECT max((h->>'at')::timestamptz) FROM jsonb_array_elements(o.history) h
                WHERE h->>'status'='delivered'
                  AND (h->>'at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}') AS at
         FROM shop_orders o
        WHERE o.status='delivered' AND NOT o.is_test
          AND o.updated_at > NOW() - INTERVAL '3 hours'
          AND NOT EXISTS (SELECT 1 FROM review_invites i WHERE i.order_no = o.order_no)
        LIMIT 50`)).rows;
    for (const r of rows) {
      await queueInvite(r.order_no, { at: r.at ? new Date(r.at) : new Date() }).catch(() => {});
    }
    return rows.length;
  }

  let sweeping = false;
  async function runInvites(now = new Date()) {
    if (sweeping) return { skipped: "running" };
    sweeping = true;
    try {
      const cf = await cfg();
      if (cf.askAfterDelivery === false) return { skipped: "disabled" };
      await backfillInvites().catch((e) => console.error("[reviews] backfill:", e.message));
      const maxAge = Math.min(72, Math.max(1, Number(cf.askMaxAgeHours) || 20));
      // فات ميعادها بكتير ⇒ تتقفل بدل ما تتبعت بعد يومين
      await pool.query(
        `UPDATE review_invites SET skip_reason='expired'
          WHERE sent_at IS NULL AND skip_reason IS NULL
            AND created_at < $1::timestamptz - ($2 || ' hours')::interval`,
        [now.toISOString(), String(maxAge)]);
      if (inAskQuiet(riyadhHour(now), cf.askQuietStart, cf.askQuietEnd)) return { skipped: "quiet" };
      const due = (await pool.query(
        `SELECT order_no, code, phone_norm FROM review_invites
          WHERE sent_at IS NULL AND skip_reason IS NULL AND due_at <= $1::timestamptz
          ORDER BY due_at LIMIT 40`, [now.toISOString()])).rows;
      if (!due.length) return { sent: 0 };
      const s = await getSettingsData();
      const staff = staffPhoneSet(s);
      const n = notify();
      const out = { sent: 0, skipped: 0 };
      for (const iv of due) {
        const mark = (col, val) => pool.query(`UPDATE review_invites SET ${col}=$2 WHERE order_no=$1`, [iv.order_no, val]);
        if (staff.has(iv.phone_norm)) { await mark("skip_reason", "staff"); out.skipped++; continue; }
        const oo = (await pool.query("SELECT opted_out_at FROM cms_contacts WHERE phone_norm=$1", [iv.phone_norm])).rows[0];
        if (oo?.opted_out_at) { await mark("skip_reason", "opted_out"); out.skipped++; continue; }
        const body = askBody(cf.askText, `${STORE_PUBLIC()}/r?c=${iv.code}`);
        try {
          const ok = await n?.sendSmsTo?.(iv.phone_norm, body);
          if (!ok) { await mark("skip_reason", "sms_disabled"); out.skipped++; continue; }
          await pool.query("UPDATE review_invites SET sent_at=NOW(), channel='sms' WHERE order_no=$1", [iv.order_no]);
          out.sent++;
        } catch (e) {
          await mark("skip_reason", "sms_failed: " + String(e.message).slice(0, 80));
          out.skipped++;
        }
      }
      if (out.sent) console.log(`[reviews] invites → sent ${out.sent}, skipped ${out.skipped}`);
      return out;
    } finally { sweeping = false; }
  }

  const INVITE_MIN = Number(process.env.REVIEW_INVITE_MINUTES ?? 5);
  if (INVITE_MIN > 0) {
    setInterval(() => runInvites().catch((e) => console.error("[reviews] invites failed:", e.message)), INVITE_MIN * 60_000);
  }

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
    // 📩 أرقام رسالة ما بعد التوصيل: اتبعت كام، رد كام، متوسطهم، وكام راح لجوجل
    const iv = (await pool.query(
      `SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
              count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
              count(*) FILTER (WHERE rating IS NOT NULL)::int AS rated,
              avg(rating)::float AS avg,
              count(*) FILTER (WHERE went_google)::int AS to_google,
              count(*) FILTER (WHERE sent_at IS NULL AND skip_reason IS NULL)::int AS waiting,
              count(*) FILTER (WHERE skip_reason IS NOT NULL)::int AS skipped
         FROM review_invites WHERE created_at > NOW() - ($1||' days')::interval`, [String(days)])).rows[0];
    return c.json({
      ok: true, days,
      total: t.n, avg: t.avg == null ? null : Number(t.avg),
      positive: t.positive, negative: t.negative, toGoogle: t.to_google,
      openNegative: open.rows[0].n, distribution,
      invites: {
        sent: iv.sent, opened: iv.opened, rated: iv.rated,
        avg: iv.avg == null ? null : Math.round(Number(iv.avg) * 100) / 100,
        toGoogle: iv.to_google, waiting: iv.waiting, skipped: iv.skipped,
        replyRate: iv.sent ? iv.rated / iv.sent : null,
      },
      google: await placeCache(),
    });
  });

  /* ⭐ جوجل: الحالة + تحديث يدوي + بحث عن معرّف المكان (مرة واحدة) */
  app.get("/api/cms/reviews/google", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cf = await cfg();
    return c.json({
      ok: true, place: await placeCache(),
      placeId: cf.placeId || "", refreshHours: cf.googleRefreshHours, showBadge: cf.showBadge !== false,
      keyConfigured: Boolean(places.placesKey()),
      sku: places.PLACES_SKU.details, cost: places.monthlyCost(cf.googleRefreshHours),
    });
  });
  app.post("/api/cms/reviews/google/refresh", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await refreshPlace({ force: true });
    return c.json(r, r.ok ? 200 : 502);
  });
  app.post("/api/cms/reviews/google/find", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { /* افتراضي */ }
    const q = clip(b.query, 200) || "فريش كاتس حي السلامة جدة";
    try {
      return c.json({ ok: true, results: await places.searchPlaces(q), sku: places.PLACES_SKU.search });
    } catch (e) { return bad(c, String(e.message).slice(0, 160), 502); }
  });

  /* 📩 اللوحة: الدعوات الأخيرة + تشغيل المسح يدوي (للاختبار) */
  app.get("/api/cms/reviews/invites", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT order_no, code, option, due_at, sent_at, channel, skip_reason, opened_at, rating, went_google, created_at
         FROM review_invites ORDER BY created_at DESC LIMIT 100`)).rows;
    const cf = await cfg();
    return c.json({ ok: true, invites: rows, config: {
      askAfterDelivery: cf.askAfterDelivery !== false, askAfterMinutes: cf.askAfterMinutes,
      askText: cf.askText, askQuietStart: cf.askQuietStart, askQuietEnd: cf.askQuietEnd,
      askMaxAgeHours: cf.askMaxAgeHours,
    } });
  });
  app.post("/api/cms/reviews/invites/run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, result: await runInvites() });
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
    /* ⭐ جوجل */
    let refetch = false;
    if (b.placeId !== undefined) {
      const id = clip(b.placeId, 255) || "";
      if (id && !places.validPlaceId(id)) return bad(c, "bad_place_id");
      refetch = id !== next.placeId;
      next.placeId = id;
      // الرابط فاضي؟ نثبّته من المعرّف دلوقتي (مش نحسبه كل مرة)
      if (id && !next.googleUrl) next.googleUrl = places.writeReviewUrl(id);
    }
    if (b.googleRefreshHours !== undefined) {
      const h = Math.round(Number(b.googleRefreshHours));
      if (!(h >= 1 && h <= 168)) return bad(c, "bad_refresh_hours");
      next.googleRefreshHours = h;
    }
    if (typeof b.showBadge === "boolean") next.showBadge = b.showBadge;
    /* 📩 رسالة ما بعد التوصيل */
    if (typeof b.askAfterDelivery === "boolean") next.askAfterDelivery = b.askAfterDelivery;
    if (b.askAfterMinutes !== undefined) {
      const m = Math.round(Number(b.askAfterMinutes));
      if (!(m >= 1 && m <= 720)) return bad(c, "bad_minutes");
      next.askAfterMinutes = m;
    }
    if (b.askText !== undefined) next.askText = clip(b.askText, 200) || DEFAULTS.askText;
    for (const k of ["askQuietStart", "askQuietEnd"]) {
      if (b[k] === undefined) continue;
      const h = Math.round(Number(b[k]));
      if (!(h >= 0 && h <= 23)) return bad(c, "bad_quiet_hour");
      next[k] = h;
    }
    if (b.askMaxAgeHours !== undefined) {
      const h = Math.round(Number(b.askMaxAgeHours));
      if (!(h >= 1 && h <= 72)) return bad(c, "bad_max_age");
      next.askMaxAgeHours = h;
    }
    await pool.query(
      `UPDATE settings SET data = jsonb_set(
         CASE WHEN data ? 'reviews' THEN data ELSE jsonb_set(data,'{reviews}','{}'::jsonb,true) END,
         '{reviews}', $1::jsonb, true) WHERE id=1`, [jb(next)]);
    // معرّف مكان جديد ⇒ نجيب تقييمه فوراً بدل ما اللوحة تفضل فاضية ١٢ ساعة
    const place = refetch ? await refreshPlace({ force: true }) : null;
    return c.json({ ok: true, settings: next, ...(place ? { place } : {}) });
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
  return { queueInvite, runInvites, refreshPlace, placeCache };
}
