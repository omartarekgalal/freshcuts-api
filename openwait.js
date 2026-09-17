/* ═══════════════════════════════════════════════════════════════════════════
   «نبّهني لما تفتحوا» — منتظرين الفتح.

   عمر (١٧ سبتمبر): «ممكن نخلي اللي عايز يطلب يجي عند الدفع ويقوله إن المطعم
   مقفول، نبّهني لما يفتح، وتوصل له رسالة SMS إنه يدخل يكمّل طلبه».

   الحقيقة اللي بتحكم التصميم: المتجر بيفتح ١٢ الضهر وبيقفل ٢–٣ الفجر. اللي
   بيجي الساعة ٥ الفجر ولاقى «مقفول» بيمشي ومابيرجعش. دلوقتي بيسيب رقمه،
   وسلته بتتحفظ ورا **نفس رابط الاسترداد** بتاع السلات المتروكة
   (freshcuts.sa/c/<code>) — فالرسالة بترجّعه لسلته زي ما سابها بالظبط، مش
   للصفحة الرئيسية.

   القواعد اللي بتمنع الإزعاج:
     • رسالة واحدة لكل رقم في اليوم، ومرة واحدة لكل دخول للقايمة.
     • بس في نافذة الفتح (من ميعاد فتح اليوم ولمدة openWindowMinutes) —
       يعني عمرها ما تتبعت ٣ الفجر ولا قبل ١٢ الضهر.
     • اللي طلب فعلاً بعد ما سجّل ⇒ بيتشال من غير رسالة.
     • الموقوفين (/u/<code>) وأرقام الفريق مستبعدين.
     • سقف لكل دورة (capPerRun) عشان فاتورة الرسايل تفضل متوقّعة.
═══════════════════════════════════════════════════════════════════════════ */

import { isOpenNow } from "./carts.js";
import { staffPhoneSet } from "./smsrules.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PAID_SQL = "status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')";

export const OPENWAIT_DEFAULTS = {
  enabled: true,
  text: "فريش كاتس فتح! كمّل طلبك: {link}",
  openWindowMinutes: 240,   // نبعت في أول ٤ ساعات من الفتح بس
  capPerRun: 60,
  maxAgeHours: 48,          // سجّل من يومين ولسه ماجاش؟ خلاص
};

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function openWaitCfg(settings) {
  const x = { ...OPENWAIT_DEFAULTS, ...(((settings || {}).openWait) || {}) };
  return {
    enabled: typeof x.enabled === "boolean" ? x.enabled : true,
    text: String(x.text || OPENWAIT_DEFAULTS.text).slice(0, 200),
    openWindowMinutes: Math.round(clampN(x.openWindowMinutes, 30, 720, 240)),
    capPerRun: Math.round(clampN(x.capPerRun, 1, 500, 60)),
    maxAgeHours: Math.round(clampN(x.maxAgeHours, 2, 168, 48)),
  };
}

export const waitBody = (text, link) => {
  const t = String(text || OPENWAIT_DEFAULTS.text).trim().slice(0, 200);
  return t.includes("{link}") ? t.replace("{link}", link) : `${t} ${link}`;
};

/* الدقايق اللي عدّت من ميعاد فتح اليوم (بتوقيت الرياض). بترجّع null لو اليوم
   مقفول أو المواعيد مش معرّفة. بعد نص الليل إحنا في ذيل يوم امبارح، يعني
   عدّى عليه أكتر من ٢٤ ساعة… لأ: بنحسبه من فتح امبارح فبيطلع رقم كبير
   وبالتالي بره النافذة — وده المطلوب بالظبط (ما نبعتش ٢ الفجر). */
export function minutesSinceOpen(hours, now = new Date()) {
  if (!hours || hours.enabled === false || !hours.days) return null;
  const r = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  const mins = r.getHours() * 60 + r.getMinutes();
  const hhmm = (s) => { const [h, m] = String(s || "").split(":").map(Number); return Number.isFinite(h) ? (h || 0) * 60 + (m || 0) : null; };
  const today = hours.days[DAYS[r.getDay()]];
  if (!today || today.closed || !today.open) return null;
  const o = hhmm(today.open);
  if (o == null) return null;
  return mins >= o ? mins - o : mins + 1440 - o;   // قبل الفتح = ذيل امبارح
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  const notify = () => (typeof deps.notify === "function" ? deps.notify() : deps.notify || null);
  const carts = () => (typeof deps.carts === "function" ? deps.carts() : deps.carts || null);

  const bad = (c, error, status = 400) => c.json({ ok: false, error }, status);
  const norm = (p) => { try { return normPhone(p); } catch { return null; } };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS open_waitlist (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        device_id TEXT,
        code TEXT,                    -- كود /c/<code> اللي بيرجّع نفس السلة
        item_count INT NOT NULL DEFAULT 0,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        option TEXT,
        source TEXT,                  -- checkout | strip
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notified_at TIMESTAMPTZ, channel TEXT, skip_reason TEXT,
        order_no TEXT, ordered_at TIMESTAMPTZ
      );
      -- صف مفتوح واحد بس لكل رقم: تسجيل تاني بيحدّث السلة مش بيعمل صف جديد
      CREATE UNIQUE INDEX IF NOT EXISTS open_waitlist_one_open_idx
        ON open_waitlist(phone_norm) WHERE notified_at IS NULL AND skip_reason IS NULL;
      CREATE INDEX IF NOT EXISTS open_waitlist_created_idx ON open_waitlist(created_at DESC);
    `);
  }
  ensureSchema().then(() => console.log("[openwait] ready"))
    .catch((e) => console.error("[openwait] init failed:", e.message));

  const storeHost = () => (process.env.STOREFRONT_PUBLIC_URL || "https://freshcuts.sa").replace(/\/+$/, "").replace(/^https?:\/\//, "");

  const rl = new Map();
  function limited(ip) {
    const now = Date.now(), slot = rl.get(ip);
    if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
    slot.n++; if (rl.size > 5000) rl.clear();
    return slot.n > 30;
  }

  /* ── عام: «نبّهني لما تفتحوا» من شاشة الدفع ───────────────────────────── */
  app.post("/api/openwait/join", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (limited(ip)) return bad(c, "rate_limited", 429);
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const s = await getSettingsData();
    const cfg = openWaitCfg(s);
    if (!cfg.enabled) return bad(c, "disabled", 503);
    const phone = norm(b.phone);
    if (!/^5\d{8}$/.test(phone || "")) return bad(c, "bad_phone");
    // مفتوح دلوقتي؟ يبقى مالوش لازمة — نقول للواجهة تكمّل الطلب عادي
    if (isOpenNow(s.hours)) return c.json({ ok: true, open: true, joined: false });

    const device = /^[a-z0-9_-]{8,64}$/i.test(String(b.deviceId || "")) ? String(b.deviceId).slice(0, 64) : null;
    const items = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
    const itemCount = items.reduce((n, it) => n + (Number(it.qty) || 1), 0);
    let code = null;
    try {
      const flow = await carts()?.createRestoreFlow?.({
        phoneNorm: phone, deviceId: device, subtotal: Number(b.subtotal) || 0, itemCount,
        items: items.map((it) => ({ id: it.id, n: String(it.name || "").slice(0, 60), q: Number(it.qty) || 1, p: Number(it.price) || 0 })),
        raw: b.raw, option: b.option,
      });
      code = flow?.code || null;
    } catch (e) {
      console.error("[openwait] restore link failed:", e.message);   // الرابط للرئيسية أحسن من رفض التسجيل
    }
    await pool.query(
      `INSERT INTO open_waitlist(phone_norm, device_id, code, item_count, subtotal, option, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (phone_norm) WHERE notified_at IS NULL AND skip_reason IS NULL
       DO UPDATE SET code = COALESCE(EXCLUDED.code, open_waitlist.code),
                     device_id = COALESCE(EXCLUDED.device_id, open_waitlist.device_id),
                     item_count = EXCLUDED.item_count, subtotal = EXCLUDED.subtotal,
                     option = EXCLUDED.option, created_at = NOW()`,
      [phone, device, code, itemCount, Number(b.subtotal) || 0,
       b.option ? String(b.option).slice(0, 12) : null, b.source === "strip" ? "strip" : "checkout"]);
    return c.json({ ok: true, joined: true, open: false });
  });

  /* ── الحارس: رسالة واحدة وقت الفتح ───────────────────────────────────── */
  let running = false;
  async function runOpenWait(now = new Date()) {
    if (running) return { skipped: "running" };
    running = true;
    try {
      const s = await getSettingsData();
      const cfg = openWaitCfg(s);
      if (!cfg.enabled) return { skipped: "disabled" };
      // قديم ⇒ يتقفل بدل ما يستنى للأبد
      await pool.query(
        `UPDATE open_waitlist SET skip_reason='expired'
          WHERE notified_at IS NULL AND skip_reason IS NULL
            AND created_at < $1::timestamptz - ($2 || ' hours')::interval`,
        [now.toISOString(), String(cfg.maxAgeHours)]);
      if (!isOpenNow(s.hours, now)) return { skipped: "closed" };
      const since = minutesSinceOpen(s.hours, now);
      if (since == null || since > cfg.openWindowMinutes) return { skipped: "outside_open_window", since };

      const rows = (await pool.query(
        `SELECT id, phone_norm, code FROM open_waitlist
          WHERE notified_at IS NULL AND skip_reason IS NULL
          ORDER BY created_at LIMIT $1`, [cfg.capPerRun])).rows;
      if (!rows.length) return { sent: 0 };
      const staff = staffPhoneSet(s);
      const n = notify();
      const out = { sent: 0, skipped: 0 };
      for (const w of rows) {
        const close = (reason) => pool.query("UPDATE open_waitlist SET skip_reason=$2 WHERE id=$1", [w.id, reason]);
        if (staff.has(w.phone_norm)) { await close("staff"); out.skipped++; continue; }
        // طلب خلاص بعد ما سجّل ⇒ ما نزعّجوش
        const paid = await pool.query(
          `SELECT order_no FROM shop_orders WHERE phone_norm=$1 AND ${PAID_SQL}
             AND created_at > (SELECT created_at FROM open_waitlist WHERE id=$2) LIMIT 1`, [w.phone_norm, w.id]);
        if (paid.rows[0]) {
          await pool.query("UPDATE open_waitlist SET order_no=$2, ordered_at=NOW(), skip_reason='ordered' WHERE id=$1",
            [w.id, paid.rows[0].order_no]);
          out.skipped++; continue;
        }
        const oo = (await pool.query("SELECT opted_out_at FROM cms_contacts WHERE phone_norm=$1", [w.phone_norm])).rows[0];
        if (oo?.opted_out_at) { await close("opted_out"); out.skipped++; continue; }
        // رسالة واحدة لكل رقم في اليوم (لو سجّل تاني بعد ما اتبعتله)
        const dup = await pool.query(
          `SELECT 1 FROM open_waitlist WHERE phone_norm=$1 AND id<>$2
             AND notified_at > date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh' LIMIT 1`,
          [w.phone_norm, w.id]);
        if (dup.rowCount) { await close("dup_today"); out.skipped++; continue; }
        const link = `${storeHost()}/${w.code ? `c/${w.code}` : "?utm_source=sms&utm_medium=crm&utm_campaign=open_now"}`;
        try {
          const ok = await n?.sendSmsTo?.(w.phone_norm, waitBody(cfg.text, link));
          if (!ok) { await close("sms_disabled"); out.skipped++; continue; }
          await pool.query("UPDATE open_waitlist SET notified_at=NOW(), channel='sms' WHERE id=$1", [w.id]);
          out.sent++;
        } catch (e) { await close("sms_failed: " + String(e.message).slice(0, 80)); out.skipped++; }
      }
      if (out.sent) console.log(`[openwait] opening → sent ${out.sent}, skipped ${out.skipped}`);
      return out;
    } finally { running = false; }
  }

  const EVERY_MIN = Number(process.env.OPENWAIT_MINUTES ?? 5);
  if (EVERY_MIN > 0) {
    setInterval(() => runOpenWait().catch((e) => console.error("[openwait] failed:", e.message)), EVERY_MIN * 60_000);
  }

  /* ── اللوحة: «منتظرين الفتح» (مستنيين اليوم / اتبعتلهم / طلبوا) ──────── */
  app.get("/api/cms/openwait", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettingsData();
    const day = "date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'";
    const r = (await pool.query(
      `SELECT count(*) FILTER (WHERE created_at > ${day})::int AS joined_today,
              count(*) FILTER (WHERE notified_at IS NULL AND skip_reason IS NULL)::int AS waiting,
              count(*) FILTER (WHERE notified_at > ${day})::int AS notified_today,
              count(*) FILTER (WHERE order_no IS NOT NULL AND created_at > ${day} - INTERVAL '7 days')::int AS converted_7d,
              count(*) FILTER (WHERE notified_at > ${day} - INTERVAL '7 days')::int AS notified_7d,
              COALESCE(sum(subtotal) FILTER (WHERE notified_at IS NULL AND skip_reason IS NULL),0)::float AS waiting_value
         FROM open_waitlist`)).rows[0];
    const recent = (await pool.query(
      `SELECT id, item_count, subtotal, option, source, created_at, notified_at, channel, skip_reason, order_no
         FROM open_waitlist ORDER BY created_at DESC LIMIT 50`)).rows;
    return c.json({
      ok: true, config: openWaitCfg(s), defaults: OPENWAIT_DEFAULTS,
      openNow: isOpenNow(s.hours), minutesSinceOpen: minutesSinceOpen(s.hours),
      stats: { ...r, waitingValue: Math.round(r.waiting_value) }, recent,
    });
  });

  app.put("/api/cms/openwait", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const val = openWaitCfg({ openWait: b });
    await pool.query(`UPDATE settings SET data = jsonb_set(data, '{openWait}', $1::jsonb, true) WHERE id=1`, [jb(val)]);
    return c.json({ ok: true, config: val });
  });

  app.post("/api/cms/openwait/run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, result: await runOpenWait() });
  });

  /* رسالة تجريبية لرقم واحد بنص الفتح الحقيقي — بتتخطى نافذة الفتح عشان
     نقدر نشوف الرسالة والرابط من غير ما نستنى ١٢ الضهر. مابتلمسش القايمة. */
  app.post("/api/cms/openwait/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const phone = norm(b.phone);
    if (!/^5\d{8}$/.test(phone || "")) return bad(c, "bad_phone");
    const s = await getSettingsData();
    const cfg = openWaitCfg(s);
    let code = null;
    if (b.withCart !== false) {
      const w = (await pool.query(
        "SELECT code FROM open_waitlist WHERE phone_norm=$1 AND code IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [phone])).rows[0];
      code = w?.code || null;
    }
    const link = `${storeHost()}/${code ? `c/${code}` : "?utm_source=sms&utm_medium=crm&utm_campaign=open_now"}`;
    const body = waitBody(cfg.text, link);
    try {
      const ok = await notify()?.sendSmsTo?.(phone, body);
      return c.json({ ok: Boolean(ok), sent: Boolean(ok), body, link, reason: ok ? null : "sms_disabled" });
    } catch (e) { return c.json({ ok: false, error: String(e.message).slice(0, 160), body }, 502); }
  });

  console.log("[openwait] routes registered");
  return { runOpenWait };
}
