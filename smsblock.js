/* ═══════════════════════════════════════════════════════════════════════════
   📵 حاجبين الإعلانات عند المشغّل — مابنبعتلهمش دعائي تاني (طلب عمر ٢٥/٩)

   ── الدليل ─────────────────────────────────────────────────────────────────
   تقرير التسليم الكامل من تقنيات (١٠ → ٢٥ سبتمبر، ٣٬٢٠٣ رسالة):
       FreshCut     (خدمي)   ٩٠٤ وصلت · ٢ ماوصلتش   → ٩٩٫٨٪
       FreshCut-AD  (دعائي) ١٬٣٣٢ وصلت · ٩٤٨ ماوصلتش → ٥٩٪
   نفس العملاء ونفس الشبكات. الفرق الوحيد اسم المرسِل. ده حجب المشغّل
   للإعلانات — اختيار العميل، ومابنحاولش نلفّ حواليه.

   ٥٨٧ رقم **عمرهم ما وصلهم أي دعائي** واتصرف عليهم ٩٤٤ محاولة. كل محاولة
   بنتحاسب عليها. فبنشيلهم من الدعائي، ونسيبهم للخدمي بس (تأكيد طلب، OTP،
   المندوب في الطريق) — دول بيوصلوا عادي لأن المرسِل مختلف.

   ── القاعدة ────────────────────────────────────────────────────────────────
   الرقم يتحجب لما يكون عنده «ماوصلتش» على الدعائي ≥ `minFails` **وصفر**
   «وصلت» على الدعائي. اللي وصله مرة وفشل مرة (١٧ رقم) مش حاجب — ده غالباً
   الجهاز مقفول أو الشبكة وقتها، فبنسيبه.
   الرقم يرجع لوحده لو وصله دعائي بعد كده (العميل شال الحجب).

   ── المصادر ───────────────────────────────────────────────────────────────
   ١) استيراد تقرير تقنيات (Excel) — `POST /api/sms/blocked/import`
   ٢) ويب هوك تقارير التسليم — `POST /api/sms/dlr` (بيتظبط من بوابة تقنيات)
═══════════════════════════════════════════════════════════════════════════ */

export const DEFAULTS = {
  enabled: true,
  minFails: 1,          // أقل عدد «ماوصلتش» على الدعائي عشان نحجب (مع صفر «وصلت»)
  adSenders: ["FreshCut-AD"],
};

export function cfgOf(settings) {
  const raw = ((settings || {}).sms || {}).adBlock || {};
  const c = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  c.minFails = Math.min(10, Math.max(1, Math.round(Number(c.minFails) || DEFAULTS.minFails)));
  c.adSenders = Array.isArray(c.adSenders) && c.adSenders.length ? c.adSenders.map(String) : DEFAULTS.adSenders;
  c.enabled = c.enabled !== false;
  return c;
}

/* الجوال بصيغتنا (5XXXXXXXX) من أي شكل: 966…، 0…، +966… */
export function pnOf(v) {
  const d = String(v == null ? "" : v).replace(/\D+/g, "");
  const nine = d.slice(-9);
  return /^5\d{8}$/.test(nine) ? nine : null;
}

const DELIVERED = /^delivered$/i;
const FAILED = /not\s*delivered|undeliver|failed|rejected|expired|blocked/i;

/* تجميع صفوف التقرير لكل رقم على المرسِلين الدعائيين بس.
   `rows` = [{ sender, number, status, at }] */
export function tally(rows, cfg = DEFAULTS) {
  const ad = new Set((cfg.adSenders || DEFAULTS.adSenders).map((s) => s.toLowerCase()));
  const per = new Map();
  for (const r of rows || []) {
    if (!r || !ad.has(String(r.sender || "").toLowerCase())) continue;
    const pn = pnOf(r.number);
    if (!pn) continue;
    const t = per.get(pn) || { pn, ok: 0, fail: 0, first: null, last: null };
    const st = String(r.status || "");
    if (DELIVERED.test(st)) t.ok++;
    else if (FAILED.test(st)) t.fail++;
    else continue;                      // «Sent» = لسه مافيش تقرير — مانحكمش
    const at = r.at ? String(r.at) : null;
    if (at && (!t.first || at < t.first)) t.first = at;
    if (at && (!t.last || at > t.last)) t.last = at;
    per.set(pn, t);
  }
  return per;
}

/* مين يتحجب ومين يرجع */
export function decide(per, cfg = DEFAULTS) {
  const block = [], clear = [];
  for (const t of per.values()) {
    if (t.ok > 0) clear.push(t);                          // وصله دعائي ⇒ مش حاجب
    else if (t.fail >= cfg.minFails) block.push(t);
  }
  return { block, clear };
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS sms_ad_blocked (
      phone_norm TEXT PRIMARY KEY,
      fails INT NOT NULL DEFAULT 0,
      first_fail_at TIMESTAMPTZ,
      last_fail_at TIMESTAMPTZ,
      source TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sms_dlr_log (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw JSONB,
      phone_norm TEXT,
      status TEXT,
      sender TEXT
    );
    CREATE INDEX IF NOT EXISTS sms_dlr_log_at ON sms_dlr_log(at DESC);
  `).catch((e) => log.error(`[smsblock] schema: ${e.message}`));

  const cfg = async () => cfgOf(await getSettingsData().catch(() => ({})));
  const ts = (v) => { const t = Date.parse(String(v || "").replace(" ", "T") + (/[zZ+]/.test(String(v)) ? "" : "+03:00")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

  async function apply(per, source) {
    await ready;
    const C = await cfg();
    const { block, clear } = decide(per, C);
    for (const t of block) {
      await pool.query(
        `INSERT INTO sms_ad_blocked(phone_norm, fails, first_fail_at, last_fail_at, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (phone_norm) DO UPDATE SET
           fails = GREATEST(sms_ad_blocked.fails, EXCLUDED.fails),
           first_fail_at = LEAST(COALESCE(sms_ad_blocked.first_fail_at, EXCLUDED.first_fail_at), EXCLUDED.first_fail_at),
           last_fail_at  = GREATEST(COALESCE(sms_ad_blocked.last_fail_at, EXCLUDED.last_fail_at), EXCLUDED.last_fail_at),
           source = EXCLUDED.source, updated_at = NOW()`,
        [t.pn, t.fail, ts(t.first), ts(t.last), source]);
    }
    /* وصله دعائي ⇒ شال الحجب. بنرجّعه للقايمة من غير ما حد يفتكر. */
    if (clear.length) {
      await pool.query(`DELETE FROM sms_ad_blocked WHERE phone_norm = ANY($1::text[])`, [clear.map((t) => t.pn)]);
    }
    return { blocked: block.length, cleared: clear.length };
  }

  /* الفلتر بيقرا من هنا — مجموعة الأرقام المحجوبة */
  async function blockedSet(pns) {
    await ready;
    const C = await cfg();
    if (!C.enabled) return new Set();
    const r = pns && pns.length
      ? await pool.query(`SELECT phone_norm FROM sms_ad_blocked WHERE phone_norm = ANY($1::text[])`, [pns])
      : await pool.query(`SELECT phone_norm FROM sms_ad_blocked`);
    return new Set(r.rows.map((x) => x.phone_norm));
  }

  /* ١) استيراد تقرير تقنيات: المتصفح (أو سكريبت) بيبعت الصفوف كـJSON.
     مابنقراش Excel هنا — الملف بيتحوّل قبلها، والسيرفر بيستقبل بيانات بس. */
  app.post("/api/sms/blocked/import", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 50000) : [];
    if (!rows.length) return c.json({ ok: false, error: "no_rows" }, 400);
    const per = tally(rows, await cfg());
    const r = await apply(per, String(b.source || "taqnyat_export").slice(0, 40));
    const total = (await pool.query(`SELECT count(*)::int n FROM sms_ad_blocked`)).rows[0].n;
    return c.json({ ok: true, numbers: per.size, ...r, totalBlocked: total });
  });

  app.get("/api/sms/blocked", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const C = await cfg();
    const r = await pool.query(
      `SELECT count(*)::int n, COALESCE(sum(fails),0)::int wasted, min(first_fail_at) since
         FROM sms_ad_blocked`);
    const last = (await pool.query(`SELECT at, status, sender FROM sms_dlr_log ORDER BY at DESC LIMIT 1`)).rows[0] || null;
    return c.json({ ok: true, config: C, ...r.rows[0], lastDlr: last });
  });

  /* ٢) ويب هوك تقارير التسليم. شكل الـpayload مش موثّق عند تقنيات، فبنسجّل
     الخام دايماً ونحاول نستخرج الرقم والحالة من الأسماء الشائعة. العبارة
     السرية (بتتحط في البوابة) لازم تطابق — غير كده بنرفض. */
  app.post("/api/sms/dlr", async (c) => {
    await ready;
    const secret = process.env.TAQNYAT_DLR_SECRET || "";
    let raw = {};
    const ctype = c.req.header("content-type") || "";
    try {
      raw = /json/i.test(ctype) ? await c.req.json()
        : Object.fromEntries(new URLSearchParams(await c.req.text()));
    } catch { raw = {}; }
    const given = String(c.req.header("x-passphrase") || c.req.query("pass") || raw.passPhrase || raw.passphrase || raw.pass || "");
    if (!secret || given !== secret) return c.json({ ok: false, error: "unauthorized" }, 401);

    const list = Array.isArray(raw) ? raw : Array.isArray(raw.data) ? raw.data : [raw];
    const rows = [];
    for (const x of list) {
      const number = x.recipient || x.mobile || x.number || x.to || x.msisdn || x.phone;
      const status = x.status || x.dlr || x.state || x.msgStatus || x.delivery_status;
      const sender = x.sender || x.senderName || x.from || "";
      await pool.query(`INSERT INTO sms_dlr_log(raw, phone_norm, status, sender) VALUES ($1::jsonb,$2,$3,$4)`,
        [JSON.stringify(x).slice(0, 4000), pnOf(number), String(status || "").slice(0, 60), String(sender).slice(0, 40)]);
      rows.push({ number, status, sender, at: x.date || x.time || new Date().toISOString() });
    }
    const r = await apply(tally(rows, await cfg()), "dlr_webhook");
    return c.json({ ok: true, received: list.length, ...r });
  });

  return { blockedSet };
}
