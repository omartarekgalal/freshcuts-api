/* ═══════════════════════════════════════════════════════════════════════════
   PROMO — أكواد العروض: الدليل الوحيد إن الإعلان جاب عميل جوّه المطعم.

   المشكلة اللي الملف ده اتعمل عشانها: أغلب عملاء Fresh Cuts بياكلوا جوّه
   المطعم. العميل ده مبيسيبش أي أثر رقمي — مفيش click id، مفيش utm، مفيش
   حاجة. فأي كلام عن "الإعلان جاب كام" للزيارات الجوّه هو تخمين، إلا لو
   العميل نفسه قال حاجة اتعلّمت في الإعلان.

   الميكانيزم: الإعلان بيقول للناس «قول للكاشير كلمة برجر20». العميل بيقولها،
   الكاشير بيدوس عليها بضغطة واحدة، والكلمة دي مربوطة بحملة بعينها. ساعتها
   إحنا مش بنقدّر — إحنا عندنا دليل.

   ── إزاي الدليل ده بيوصل لبقية النظام (من غير أي منطق مكرر) ───────────────
   كل استخدام لكود بيتكتب صف في `funnel_events` باسم حدث `PromoRedeem` وجواه
   الـ utm بتاع الحملة صاحبة الكود. من هنا مسار الإسناد الموجود أصلاً بيشتغل
   لوحده:
     funnel_events → attribution.sweepLinks → attrib_links → attrib_daily
   يعني الطلب بيبقى basis='linked' ودرجة ثقته «مؤكد»، وبيتنسب للحملة بالاسم.
   مبنكتبش ولا سطر إسناد جديد — بنغذّي المسار القديم بدليل حقيقي بس.

   ملاحظة مقصودة: اسم الحدث `PromoRedeem` مش `Lead`. لو كتبناه Lead كان هيتعدّ
   في `SQL_ROLL_LEADS` كأنه اهتمام جديد، وده كذب: استخدام الكود بيحصل عند
   الدفع، مش قبله. الاسم الجديد بيخلّي الربط شغال من غير ما يلوّث عدّ الـ leads.

   ── الخصم نفسه ───────────────────────────────────────────────────────────
   إحنا مش بنطبّق أي خصم. `discount_text` وصف للكاشير بس («خصم ٢٠٪»)؛ الخصم
   الحقيقي بيتعمل في TabSense زي ما بيتعمل دايماً. الكود عندنا أداة قياس مش
   أداة تسعير — ولو حاولنا نخلّيه الاتنين هنكسر الفاتورة.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

/* الكاشير بيدوس بالعربي والإعلان ممكن يكتب الرقم عربي أو إنجليزي. المفتاح
   بيتوحّد عشان «برجر٢٠» و«برجر20» و«BURGER20» يوصلوا لنفس الكود. */
const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
                    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };
export function codeKey(s) {
  return String(s || "")
    .trim()
    .replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] || d)
    .replace(/[ً-ْـ]/g, "")   // تشكيل + تطويل
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")   // «لمة» و«لمه» نفس الكلمة لما حد يكتبها
    .replace(/[\s._\-]+/g, "")
    .toUpperCase();
}

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const num = (v) => (v == null ? 0 : Number(v) || 0);
const isResponse = (x) => typeof Response !== "undefined" && x instanceof Response;
const newId = () => `pc_${crypto.randomBytes(5).toString("hex")}`;
const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

// نفس تعريف اليوم التجاري المستخدم في staff.js — المطبخ بيقفل بعد منتصف الليل.
const BIZ_TODAY = "(((now() AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date)";

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, requireCashierOrAdmin, normPhone, jb, todayISO, daysAgoISO } = ctx;
  const staffApi = deps.staff || null;          // { requireStaff } — محطة الموظف
  const attribution = deps.attribution || null; // { linkOrder }
  const adsSync = deps.adsSync || null;         // { syncOrders }

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        code_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT '',
        utm_source TEXT NOT NULL DEFAULT '',
        utm_campaign TEXT NOT NULL DEFAULT '',
        discount_text TEXT NOT NULL DEFAULT '',
        starts_on DATE,
        ends_on DATE,
        max_redemptions INT NOT NULL DEFAULT 0,
        active BOOL NOT NULL DEFAULT true,
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS promo_redemptions (
        id TEXT PRIMARY KEY,
        code_id TEXT NOT NULL,
        code_key TEXT NOT NULL,
        order_id TEXT,
        phone_norm TEXT NOT NULL DEFAULT '',
        utm_source TEXT NOT NULL DEFAULT '',
        utm_campaign TEXT NOT NULL DEFAULT '',
        redeemed_by TEXT NOT NULL DEFAULT '',
        day DATE NOT NULL,
        funnel_event_id TEXT,
        redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS promo_redemptions_day_idx ON promo_redemptions(day);
      CREATE INDEX IF NOT EXISTS promo_redemptions_code_idx ON promo_redemptions(code_id);
      CREATE INDEX IF NOT EXISTS promo_redemptions_phone_idx ON promo_redemptions(phone_norm);
      -- نفس الكود على نفس الطلب مرة واحدة بس. لمس الزرار مرتين بالغلط على
      -- تابلت مش لازم يبقى استخدامين — الطابور بيتحدّث كل ٢٠ ثانية والكاشير
      -- مش هيلاحظ إنه ضغط مرتين.
      CREATE UNIQUE INDEX IF NOT EXISTS promo_redemptions_order_uniq
        ON promo_redemptions(code_id, order_id) WHERE order_id IS NOT NULL;

      /* الكود اتبعت لمين — وده أهم جدول في الملف كله.

         الإعلانات الشغالة دلوقتي (fc-wa-orders) بتقول للعميل يبعت كلمة على
         الواتساب وإحنا نرد عليه بالكود. يعني ساعة الرد إحنا عارفين رقمه
         والحملة اللي جابته، قبل ما يشوف الكاشير أصلاً. الصف اللي بيتكتب هنا
         بيدخل funnel_events كـ Lead برقم جوال، وبعدها sweepLinks بيطابقه
         بالطلب لوحده لما العميل ييجي — من غير ولا لمسة من الكاشير.

         ده مقصود: محطة الكاشير اتفتحت مرتين في عمرها كلها، فأي قياس معلّق
         على إن الموظف يفتكر يدوس هو قياس مش موجود. */
      CREATE TABLE IF NOT EXISTS promo_issues (
        id TEXT PRIMARY KEY,
        code_id TEXT NOT NULL,
        phone_norm TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        funnel_event_id TEXT,
        issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS promo_issues_uniq ON promo_issues(code_id, phone_norm);
      CREATE INDEX IF NOT EXISTS promo_issues_phone_idx ON promo_issues(phone_norm);
    `);
  }
  ensureSchema()
    .then(() => console.log("[promo] schema ready"))
    .catch((e) => console.error("[promo] schema failed:", e.message));

  /* ── الصلاحيات ──────────────────────────────────────────────────────────
     المحطة بتشتغل بوضعين: توكن الموظف أو الرقم السري المشترك. الاتنين
     مقبولين هنا — استخدام كود مش بيكشف أي بيانات عميل. */
  async function requireStation(c) {
    const shared = await requireCashierOrAdmin(c);
    if (!shared) return { who: "cashier" };
    if (staffApi?.requireStaff) {
      const s = await staffApi.requireStaff(c);
      if (!isResponse(s)) return { who: s.isAdmin ? "admin" : `staff:${s.id}`, staff: s };
    }
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }

  const shapeCode = (r, extra = {}) => ({
    id: r.id,
    code: r.code,
    codeKey: r.code_key,
    label: r.label || "",
    utmSource: r.utm_source || "",
    utmCampaign: r.utm_campaign || "",
    discountText: r.discount_text || "",
    startsOn: isoDay(r.starts_on),
    endsOn: isoDay(r.ends_on),
    maxRedemptions: num(r.max_redemptions),
    active: r.active !== false,
    notes: r.notes || "",
    createdAt: r.created_at,
    ...extra,
  });

  /* الكود صالح دلوقتي؟ بيرجّع السبب بالعربي عشان المحطة تعرضه زي ما هو. */
  function validityOf(row, used) {
    const today = todayISO();
    if (row.active === false) return { valid: false, reason: "inactive", message: "الكود ده متوقف" };
    const from = isoDay(row.starts_on), to = isoDay(row.ends_on);
    if (from && today < from) return { valid: false, reason: "not_started", message: `الكود ده بيبدأ يوم ${from}` };
    if (to && today > to) return { valid: false, reason: "expired", message: `الكود ده انتهى يوم ${to}` };
    const max = num(row.max_redemptions);
    if (max > 0 && used >= max) return { valid: false, reason: "exhausted", message: `الكود ده خلص (${max} استخدام)` };
    return { valid: true, reason: "", message: "" };
  }

  /* ═══ GET /api/promo/list ══════════════════════════════════════════════
     المحطة بتنده دي عشان ترسم الأزرار. `?all=1` (أدمن بس) بيرجّع المتوقف
     والمنتهي كمان عشان صفحة الإدارة. */
  app.get("/api/promo/list", async (c) => {
    const who = await requireStation(c); if (isResponse(who)) return who;
    const wantAll = c.req.query("all") === "1" && !(await requireAdmin(c));

    const rows = (await pool.query(
      `SELECT p.*,
              (SELECT count(*)::int FROM promo_redemptions r WHERE r.code_id = p.id) AS used,
              (SELECT count(*)::int FROM promo_redemptions r
                WHERE r.code_id = p.id AND r.day = ${BIZ_TODAY}) AS used_today,
              (SELECT max(r.redeemed_at) FROM promo_redemptions r WHERE r.code_id = p.id) AS last_used
         FROM promo_codes p ORDER BY p.active DESC, p.created_at DESC`
    )).rows;

    const codes = rows.map((r) => {
      const v = validityOf(r, num(r.used));
      return shapeCode(r, {
        used: num(r.used), usedToday: num(r.used_today), lastUsedAt: r.last_used,
        valid: v.valid, invalidReason: v.reason, invalidMessage: v.message,
      });
    });

    return c.json({
      ok: true,
      codes: wantAll ? codes : codes.filter((x) => x.valid),
      total: codes.length,
      notes: wantAll ? [] : ["الأكواد المتوقفة أو المنتهية مش معروضة هنا — استخدم ?all=1 بتوكن الأدمن."],
    });
  });

  /* ═══ POST /api/promo ══════════════════════════════════════════════════
     إنشاء أو تعديل. وجود `id` معناه تعديل؛ من غيره بيتعمل كود جديد. */
  app.post("/api/promo", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const id = String(b.id || "").trim();
    const code = String(b.code || "").trim();
    const key = codeKey(code);

    if (!id && !key) {
      return c.json({ ok: false, error: "code_required", message: "اكتب الكود الأول" }, 400);
    }
    if (key && key.length < 3) {
      return c.json({ ok: false, error: "code_too_short", message: "الكود لازم يكون ٣ حروف على الأقل" }, 400);
    }
    // كود قصير الناس بتقوله بصوت عالي — لو بقى جملة مش هيتقال.
    if (key.length > 24) {
      return c.json({ ok: false, error: "code_too_long", message: "الكود لازم يكون كلمة واحدة قصيرة يقدر العميل ينطقها" }, 400);
    }
    for (const f of ["startsOn", "endsOn"]) {
      if (b[f] && !isDay(b[f])) return c.json({ ok: false, error: `bad_${f}`, message: "التاريخ لازم يكون YYYY-MM-DD" }, 400);
    }

    const fields = {
      code: code || null,
      code_key: key || null,
      label: b.label === undefined ? null : String(b.label).trim(),
      utm_source: b.utmSource === undefined ? null : String(b.utmSource).trim().toLowerCase(),
      utm_campaign: b.utmCampaign === undefined ? null : String(b.utmCampaign).trim(),
      discount_text: b.discountText === undefined ? null : String(b.discountText).trim(),
      notes: b.notes === undefined ? null : String(b.notes).trim(),
    };

    try {
      if (id) {
        const cur = await pool.query("SELECT * FROM promo_codes WHERE id = $1", [id]);
        if (!cur.rowCount) return c.json({ ok: false, error: "not_found", message: "الكود ده مش موجود" }, 404);
        const r = (await pool.query(
          `UPDATE promo_codes SET
             code          = COALESCE($2, code),
             code_key      = COALESCE($3, code_key),
             label         = COALESCE($4, label),
             utm_source    = COALESCE($5, utm_source),
             utm_campaign  = COALESCE($6, utm_campaign),
             discount_text = COALESCE($7, discount_text),
             notes         = COALESCE($8, notes),
             starts_on     = $9, ends_on = $10,
             max_redemptions = COALESCE($11, max_redemptions),
             active        = COALESCE($12, active)
           WHERE id = $1 RETURNING *`,
          [id, fields.code, fields.code_key, fields.label, fields.utm_source, fields.utm_campaign,
           fields.discount_text, fields.notes,
           b.startsOn === undefined ? cur.rows[0].starts_on : (b.startsOn || null),
           b.endsOn === undefined ? cur.rows[0].ends_on : (b.endsOn || null),
           b.maxRedemptions === undefined ? null : Math.max(0, Math.trunc(Number(b.maxRedemptions) || 0)),
           b.active === undefined ? null : !!b.active]
        )).rows[0];
        return c.json({ ok: true, code: shapeCode(r) });
      }

      const r = (await pool.query(
        `INSERT INTO promo_codes (id, code, code_key, label, utm_source, utm_campaign, discount_text,
                                  starts_on, ends_on, max_redemptions, active, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (code_key) DO UPDATE SET
           code=EXCLUDED.code, label=EXCLUDED.label, utm_source=EXCLUDED.utm_source,
           utm_campaign=EXCLUDED.utm_campaign, discount_text=EXCLUDED.discount_text,
           starts_on=EXCLUDED.starts_on, ends_on=EXCLUDED.ends_on,
           max_redemptions=EXCLUDED.max_redemptions, active=EXCLUDED.active, notes=EXCLUDED.notes
         RETURNING *`,
        [newId(), code, key, fields.label || "", fields.utm_source || "", fields.utm_campaign || "",
         fields.discount_text || "", b.startsOn || null, b.endsOn || null,
         Math.max(0, Math.trunc(Number(b.maxRedemptions) || 0)),
         b.active === undefined ? true : !!b.active, fields.notes || ""]
      )).rows[0];
      return c.json({ ok: true, code: shapeCode(r) });
    } catch (e) {
      console.error("[promo] save failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  app.delete("/api/promo/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    // الاستخدامات القديمة بتفضل — هي الدليل نفسه. بنوقّف الكود مش بنمسح تاريخه.
    const used = (await pool.query("SELECT count(*)::int AS n FROM promo_redemptions WHERE code_id=$1", [id])).rows[0].n;
    if (used > 0) {
      const r = await pool.query("UPDATE promo_codes SET active=false WHERE id=$1 RETURNING *", [id]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      return c.json({ ok: true, deactivated: true, redemptions: used,
        message: `الكود اتوقف بدل ما يتمسح — عليه ${used} استخدام مسجّل` });
    }
    const r = await pool.query("DELETE FROM promo_codes WHERE id=$1", [id]);
    return c.json({ ok: true, deleted: r.rowCount });
  });

  /* ═══ POST /api/promo/issue ════════════════════════════════════════════
     { code, phone, channel? } — بتتنده لما نبعت الكود للعميل على الواتساب.

     دي الرجل اللي بتشتغل من غير كاشير خالص. الإعلان بيقول «ابعتلنا مشاوي على
     الواتساب» → إحنا نرد بالكود → هنا بنسجّل إن الرقم ده خد كود الحملة
     الفلانية. لما العميل ييجي المطعم ويتسجل رقمه في TabSense (وده بيحصل في
     ٧٢٪ من الطلبات فعلاً)، sweepLinks بيطابق الرقم بالرقم ويربط الطلب
     بالحملة لوحده. الكاشير مش طرف في العملية دي.

     الحدث هنا اسمه Lead — على عكس الاستخدام. ده صح: العميل كلّمنا فعلاً قبل
     ما يشتري، فده اهتمام حقيقي يستاهل يتعدّ في عدّ الـ leads. */
  app.post("/api/promo/issue", async (c) => {
    const who = await requireStation(c); if (isResponse(who)) return who;
    const b = await c.req.json().catch(() => ({}));
    const key = codeKey(b.code);
    const phone = normPhone(b.phone || "");
    if (!key) return c.json({ ok: false, error: "code_required", message: "اكتب الكود" }, 400);
    // من غير رقم الصف ده بلا قيمة — الرقم هو كل الفكرة.
    if (!phone || phone.length < 9) {
      return c.json({ ok: false, error: "phone_required", message: "رقم الجوال مطلوب — من غيره مفيش ربط" }, 400);
    }

    const cur = await pool.query(
      `SELECT p.*, (SELECT count(*)::int FROM promo_redemptions r WHERE r.code_id = p.id) AS used
         FROM promo_codes p WHERE p.code_key = $1`, [key]);
    if (!cur.rowCount) return c.json({ ok: false, error: "unknown_code", message: "الكود ده مش موجود" }, 404);
    const code = cur.rows[0];

    const id = `pi_${crypto.randomBytes(6).toString("hex")}`;
    const ins = await pool.query(
      `INSERT INTO promo_issues (id, code_id, phone_norm, channel)
       VALUES ($1,$2,$3,$4) ON CONFLICT (code_id, phone_norm) DO NOTHING RETURNING id`,
      [id, code.id, phone, String(b.channel || "whatsapp").slice(0, 24)]
    );
    if (!ins.rowCount) {
      return c.json({ ok: true, duplicate: true, code: shapeCode(code),
        message: "الرقم ده خد الكود ده قبل كده" });
    }

    let eventId = null;
    if (code.utm_campaign || code.utm_source) {
      eventId = crypto.randomUUID();
      try {
        await pool.query(
          `INSERT INTO funnel_events (id, event_name, event_id, value, currency, url, utm, phone_norm, results)
           VALUES ($1,'Lead',$2,0,'SAR','',$3,$4,$5)`,
          [eventId, id,
           jb({ utm_source: code.utm_source || "", utm_campaign: code.utm_campaign || "",
                utm_medium: "promo_code", promo_code: code.code }),
           phone,
           jb({ promo: { id: code.id, code: code.code, issue: id, channel: b.channel || "whatsapp" } })]
        );
        await pool.query("UPDATE promo_issues SET funnel_event_id=$2 WHERE id=$1", [id, eventId]);
      } catch (e) {
        eventId = null;
        console.error("[promo] issue event failed:", e.message);
      }
    }

    return c.json({
      ok: true, issueId: id, code: shapeCode(code), linkable: !!eventId,
      message: `📩 كود ${code.code} اتسجل للرقم ده`,
      note: "الطلب اللي هييجي بنفس الرقم خلال ٧ أيام هيتربط بالحملة دي لوحده — من غير أي تدخل من الكاشير.",
    });
  });

  /* ═══ POST /api/promo/redeem ═══════════════════════════════════════════
     { code, orderId?, phone? } — بتتنده من محطة الكاشير بضغطة واحدة. */
  app.post("/api/promo/redeem", async (c) => {
    const who = await requireStation(c); if (isResponse(who)) return who;
    const b = await c.req.json().catch(() => ({}));
    const key = codeKey(b.code);
    if (!key) return c.json({ ok: false, error: "code_required", message: "اكتب الكود" }, 400);

    const orderId = b.orderId ? String(b.orderId).slice(0, 64) : null;

    const cur = await pool.query(
      `SELECT p.*, (SELECT count(*)::int FROM promo_redemptions r WHERE r.code_id = p.id) AS used
         FROM promo_codes p WHERE p.code_key = $1`, [key]);
    if (!cur.rowCount) {
      return c.json({ ok: false, error: "unknown_code", message: "الكود ده مش موجود — اتأكد من العميل" }, 404);
    }
    const code = cur.rows[0];
    const v = validityOf(code, num(code.used));
    if (!v.valid) return c.json({ ok: false, error: v.reason, message: v.message, code: shapeCode(code) }, 409);

    /* الرقم: اللي الكاشير كتبه، وإلا اللي على الطلب أصلاً (TabSense أو تسجيل
       سابق). من غير رقم الاستخدام لسه دليل على القناة، بس مش هيربط بطلب. */
    let phone = normPhone(b.phone || "");
    let order = null;
    if (orderId) {
      const o = await pool.query(
        `SELECT o.order_id, o.total, o.calendar_day,
                COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) AS pn
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
          WHERE o.order_id = $1`, [orderId]);
      if (!o.rowCount) {
        return c.json({ ok: false, error: "order_not_found", message: "الطلب ده مش موجود عندنا" }, 404);
      }
      order = o.rows[0];
      if (!phone) phone = String(order.pn || "");
    }

    const id = `pr_${crypto.randomBytes(6).toString("hex")}`;
    const ins = await pool.query(
      `INSERT INTO promo_redemptions (id, code_id, code_key, order_id, phone_norm,
                                      utm_source, utm_campaign, redeemed_by, day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::date, ${BIZ_TODAY}))
       ON CONFLICT (code_id, order_id) WHERE order_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [id, code.id, code.code_key, orderId, phone,
       code.utm_source || "", code.utm_campaign || "", who.who || "",
       order ? isoDay(order.calendar_day) : null]
    );
    if (!ins.rowCount) {
      return c.json({ ok: true, duplicate: true, code: shapeCode(code),
        message: "الكود ده اتسجل على الطلب ده قبل كده" });
    }

    /* ── تغذية مسار الإسناد الموجود ───────────────────────────────────────
       صف واحد في funnel_events، وبعده الـ sweep بتاع attribution.js بيعمل
       الباقي. أي فشل هنا مبيرجّعش خطأ للكاشير: الاستخدام اتسجل خلاص، والربط
       بيتعوّض في دورة الأوتوبايلوت الجاية. */
    let eventId = null;
    if (code.utm_campaign || code.utm_source) {
      eventId = crypto.randomUUID();
      try {
        await pool.query(
          `INSERT INTO funnel_events (id, event_name, event_id, order_id, value, currency, url, utm, phone_norm, results)
           VALUES ($1,'PromoRedeem',$2,$3,$4,'SAR','', $5,$6,$7)`,
          [eventId, id, orderId, order ? num(order.total) : 0,
           jb({ utm_source: code.utm_source || "", utm_campaign: code.utm_campaign || "",
                utm_medium: "promo_code", promo_code: code.code }),
           phone || null,
           jb({ promo: { id: code.id, code: code.code, redemption: id } })]
        );
        await pool.query("UPDATE promo_redemptions SET funnel_event_id=$2 WHERE id=$1", [id, eventId]);
      } catch (e) {
        eventId = null;
        console.error("[promo] funnel event failed:", e.message);
      }
    }

    /* الرقم اللي الكاشير كتبه لازم يقعد على الطلب نفسه — من غيره التحويلة
       اللي بتتبعت للمنصات (ads.js) مش هيبقى معاها هوية تتطابق. مبنلمسش
       تصنيف المصدر لو الكاشير حطّه؛ بنملا الفاضي بس. */
    if (orderId && phone && !order.pn) {
      await pool.query(
        `INSERT INTO order_sources (order_id, source, source_note, customer_kind, filled_by, filled_at,
                                    customer_name, customer_phone, phone_norm)
         VALUES ($1,'other',$2,'unknown','promo',NOW(),'',$3,$3)
         ON CONFLICT (order_id) DO UPDATE SET
           customer_phone=COALESCE(NULLIF(order_sources.customer_phone,''), EXCLUDED.customer_phone),
           phone_norm=COALESCE(NULLIF(order_sources.phone_norm,''), EXCLUDED.phone_norm)`,
        [orderId, `كود ${code.code}`, phone]
      ).catch((e) => console.error("[promo] phone attach failed:", e.message));
    }

    // الربط الفوري: الطلب يبقى «مؤكد» ومنسوب للحملة قبل ما الشاشة ترجع.
    if (attribution?.linkOrder && orderId) {
      attribution.linkOrder({ orderId }).catch((e) => console.error("[promo] link failed:", e.message));
    }
    // ودفع تحويلة الطلب للمنصات بالهوية الجديدة. مكرر ومؤمّن ضد التكرار في
    // ads_events، فالنداء ده أسوأ حالاته إنه مايعملش حاجة.
    if (orderId && phone) pushConversions(isoDay(order.calendar_day) || todayISO());

    const used = num(code.used) + 1;
    return c.json({
      ok: true,
      redemptionId: id,
      code: shapeCode(code, { used }),
      linked: !!(eventId && orderId),
      phoneCaptured: !!phone,
      remaining: num(code.max_redemptions) > 0 ? Math.max(0, num(code.max_redemptions) - used) : null,
      message: `✅ اتسجل كود ${code.code}`,
    });
  });

  /* ═══ DELETE /api/promo/redemption/:id ═════════════════════════════════
     الكاشير دوس على كود غلط. من غير طريق رجوع الصف الغلط ده بيفضل «دليل
     مؤكد» في تقرير الإعلانات للأبد — وده أسوأ من إنه مايتسجلش أصلاً.

     بيمسح التلاتة مع بعض: الاستخدام، وحدث الفنل اللي اتكتب منه، والربط اللي
     اتبنى عليه. لو سبنا أي واحد فيهم الطلب هيفضل منسوب للحملة الغلط.
     الأدمن بيمسح أي صف؛ المحطة بتمسح صف عمره أقل من ربع ساعة بس. */
  app.delete("/api/promo/redemption/:id", async (c) => {
    const isAdmin = !(await requireAdmin(c));
    if (!isAdmin) {
      const who = await requireStation(c); if (isResponse(who)) return who;
    }
    const id = String(c.req.param("id") || "").trim();
    const win = isAdmin ? "" : " AND redeemed_at > NOW() - interval '15 minutes'";
    const r = await pool.query(
      `DELETE FROM promo_redemptions WHERE id = $1${win}
       RETURNING order_id, funnel_event_id`, [id]);
    if (!r.rowCount) {
      return c.json({ ok: false, error: "not_found",
        message: isAdmin ? "الاستخدام ده مش موجود" : "فات وقت التراجع" }, 404);
    }
    const { order_id, funnel_event_id } = r.rows[0];
    // الربط الأول، وبعدين الحدث — العكس بيسيب ربط شايل مفتاح مش موجود.
    if (funnel_event_id) {
      await pool.query("DELETE FROM attrib_links WHERE lead_event_id = $1", [funnel_event_id]).catch(() => {});
      await pool.query("DELETE FROM funnel_events WHERE id = $1", [funnel_event_id]).catch(() => {});
    }
    // اليوم اللي اتغيّر لازم يتعاد بناه، وإلا الرقم القديم يفضل في الجدول.
    if (order_id) {
      await pool.query(
        `DELETE FROM attrib_built WHERE day IN (SELECT calendar_day FROM ts_orders WHERE order_id = $1)`,
        [order_id]).catch(() => {});
    }
    return c.json({ ok: true, deleted: 1, orderId: order_id, message: "الاستخدام اترجع" });
  });

  /* دفع التحويلات للمنصات — مخنوق عمداً. الكاشير ممكن يسجّل عشر أكواد في
     دقيقة، ومفيش داعي نضرب المنصات عشر مرات على نفس اليوم. */
  const lastPush = new Map();
  function pushConversions(day) {
    if (!adsSync?.syncOrders || !day) return;
    const at = lastPush.get(day) || 0;
    if (Date.now() - at < 120_000) return;
    lastPush.set(day, Date.now());
    if (lastPush.size > 60) lastPush.clear();
    adsSync.syncOrders({ from: day, to: day })
      .catch((e) => console.error("[promo] ads sync failed:", e.message));
  }

  /* ═══ GET /api/promo/stats?from&to ═════════════════════════════════════ */
  app.get("/api/promo/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const to = isDay(c.req.query("to")) ? c.req.query("to") : todayISO();
    const from = isDay(c.req.query("from")) ? c.req.query("from") : daysAgoISO(29);

    const rows = (await pool.query(
      `SELECT p.id, p.code, p.label, p.utm_source, p.utm_campaign, p.discount_text, p.active,
              count(r.id)::int AS redemptions,
              count(r.id) FILTER (WHERE r.order_id IS NOT NULL)::int AS with_order,
              count(r.id) FILTER (WHERE COALESCE(r.phone_norm,'') <> '')::int AS with_phone,
              count(DISTINCT NULLIF(r.phone_norm,''))::int AS customers,
              COALESCE(sum(o.total),0) AS revenue,
              -- الكود اتبعت لكام رقم مقابل اتقال كام مرة. الفرق بينهم هو
              -- الرقم اللي بيقول الإعلان شغّال ولا لأ فعلاً.
              (SELECT count(*)::int FROM promo_issues i
                WHERE i.code_id = p.id AND i.issued_at::date BETWEEN $1::date AND $2::date) AS issued,
              min(r.redeemed_at) AS first_at, max(r.redeemed_at) AS last_at
         FROM promo_codes p
         LEFT JOIN promo_redemptions r
           ON r.code_id = p.id AND r.day BETWEEN $1::date AND $2::date
         LEFT JOIN ts_orders o ON o.order_id = r.order_id
        GROUP BY p.id, p.code, p.label, p.utm_source, p.utm_campaign, p.discount_text, p.active
        ORDER BY redemptions DESC, p.code`, [from, to])).rows;

    const daily = (await pool.query(
      `SELECT r.day::text AS day, count(*)::int AS redemptions
         FROM promo_redemptions r WHERE r.day BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 1`, [from, to])).rows;

    return c.json({
      ok: true, range: { from, to },
      codes: rows.map((r) => ({
        id: r.id, code: r.code, label: r.label || "",
        utmSource: r.utm_source || "", utmCampaign: r.utm_campaign || "",
        discountText: r.discount_text || "", active: r.active !== false,
        redemptions: num(r.redemptions), withOrder: num(r.with_order), withPhone: num(r.with_phone),
        customers: num(r.customers), revenue: Math.round(num(r.revenue) * 100) / 100,
        issued: num(r.issued),
        // نسبة اللي خدوا الكود وفعلاً جم — مقياس الإعلان نفسه، مش الكاشير.
        redeemRate: num(r.issued) > 0 ? Math.round((num(r.redemptions) / num(r.issued)) * 100) / 100 : null,
        firstAt: r.first_at, lastAt: r.last_at,
      })),
      daily,
      totals: {
        redemptions: rows.reduce((a, r) => a + num(r.redemptions), 0),
        withOrder: rows.reduce((a, r) => a + num(r.with_order), 0),
        revenue: Math.round(rows.reduce((a, r) => a + num(r.revenue), 0) * 100) / 100,
      },
      notes: [
        "«الإيراد» هنا هو إجمالي الطلبات اللي اتقال عليها الكود — مش ربح، والخصم نفسه بيتعمل في TabSense مش هنا.",
        "الاستخدام من غير رقم طلب بيفضل محسوب كدليل على القناة، بس مش بيتنسبله إيراد.",
      ],
    });
  });

  /* ═══ للاستهلاك الداخلي من attribution.js ═══════════════════════════════
     الاستخدامات في مدى، مقسومة على utm_source الخام — الماب لقناة بيحصل في
     attribution.js عشان خريطة القنوات تفضل في مكان واحد. */
  async function redemptionsInRange(from, to) {
    const r = await pool.query(
      `SELECT lower(btrim(COALESCE(p.utm_source,''))) AS utm_source,
              COALESCE(NULLIF(p.utm_campaign,''),'') AS utm_campaign,
              p.code,
              count(*)::int AS redemptions,
              -- الاستخدام اللي لسه مش مربوط بطلب: ده اللي بيضيف يقين جديد.
              -- اللي اتربط بقى جوّه linked_orders خلاص، وعدّه تاني بيبقى تكرار.
              count(*) FILTER (
                WHERE r.order_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM attrib_links l WHERE l.order_id = r.order_id)
              )::int AS unlinked
         FROM promo_redemptions r JOIN promo_codes p ON p.id = r.code_id
        WHERE r.day BETWEEN $1::date AND $2::date
        GROUP BY 1,2,3`, [from, to]);
    return r.rows;
  }

  console.log("[promo] routes ready");
  return { redemptionsInRange, codeKey };
}
