/* ═══════════════════════════════════════════════════════════════════════════
   HUB — الطبقة اللي بتخلي صفحة «المراجعة والموافقة» في التسويق تشتغل.

   الصفحة نفسها (src/pages/MarketingHubPage.jsx) بتقرا أغلب أرقامها من
   endpoints موجودة أصلاً: /api/insights/summary و /api/attribution/overview
   و /api/ads/campaigns و /api/ads/events و /api/promo/*. الناقص كان ٣ حاجات
   مالهاش مكان تتخزن فيه، وده اللي الملف ده بيضيفه:

   1) campaign_notes — «الحملة دي بتجيب إيه وإزاي» بالعربي، مكتوبة بإيد عمر.
      المنصة بتقول اسم الحملة و objective بالإنجليزي؛ دي مش إجابة. الوصف
      البشري بيتخزن هنا بمفتاح (platform, campaign_id) عشان يفضل مربوط
      بالحملة الحقيقية مش بصف يدوي في mk_campaigns.

   2) approvals — طابور عام لأي حاجة مستنية موافقة المالك: تصميم اتعمل
      واتحجز، عرض محتاج تأكيد، نص إعلان محتاج تعديل. أي وكيل تاني يقدر
      يحطّ فيه بند بـ POST، والمالك يوافق أو يرفض من نفس الصفحة.

   3) mk_offers — العروض اللي جوّه المطعم. دي «مصدر الحقيقة» اللي أي تصميم
      أو نص إعلان لازم ينقل منه السعر والمكوّنات — عشان ما يحصلش إن إعلان
      يقول ٩٠ ريال والكاشير يقول ١٠٠.

   وكمان endpoint واحد بيوصّل أزرار (وقف/شغّل/غيّر الميزانية) بمسار الموافقة
   الموجود في الطيار الآلي: بيسجّل قرار proposed، والواجهة بتنده
   /api/autopilot/decisions/:id/approve — يعني نفس حدود الأمان بالحرف
   (maxCampaignBudget و ADS_ALLOW_WRITE)، ونفس السجل. مفيش طريق جانبي
   بيصرف فلوس من غير ما يتسجّل.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const newId = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;

/* العرضين اللي شغالين في المطعم دلوقتي — بيتزرعوا مرة واحدة وبعد كده
   الجدول هو المرجع (لو عمر عدّل السعر، الزرع مش بيرجّعه). */
const SEED_OFFERS = [
  {
    id: "of_lamma",
    name: "صينية اللمة",
    price: 100,
    contents: "٦ قطع كفتة، ٣ قطع طرب، ٤ قطع شيش طاووق، ٢ صدور دجاج مشوية، حواوشي مصري — مع بطاطس وأرز وسلطة وطحينة",
    validity: "سارٍ حاليًا — من غير تاريخ انتهاء",
    channels: "all",
    sort: 1,
  },
  {
    id: "of_pizza_pasta_crepe",
    name: "بيتزا + باستا + كريب",
    price: 70,
    contents: "بيتزا + باستا + كريب",
    validity: "سارٍ حاليًا — من غير تاريخ انتهاء",
    channels: "all",
    sort: 2,
  },
];

export function register(app, ctx) {
  const { pool, requireAdmin, jb } = ctx;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_notes (
        platform TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT NOT NULL DEFAULT '',
        brings TEXT NOT NULL DEFAULT '',
        how TEXT NOT NULL DEFAULT '',
        audience TEXT NOT NULL DEFAULT '',
        offer_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (platform, campaign_id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'other',
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        detail JSONB NOT NULL DEFAULT '{}',
        requested_by TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        owner_note TEXT NOT NULL DEFAULT '',
        decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at DESC);
      CREATE TABLE IF NOT EXISTS mk_offers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price NUMERIC NOT NULL DEFAULT 0,
        contents TEXT NOT NULL DEFAULT '',
        validity TEXT NOT NULL DEFAULT '',
        channels TEXT NOT NULL DEFAULT 'all',
        active BOOL NOT NULL DEFAULT true,
        sort INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    for (const o of SEED_OFFERS) {
      await pool.query(
        `INSERT INTO mk_offers (id, name, price, contents, validity, channels, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [o.id, o.name, o.price, o.contents, o.validity, o.channels, o.sort]
      );
    }
  }
  ensureSchema()
    .then(() => console.log("[hub] schema ready"))
    .catch((e) => console.error("[hub] schema failed:", e.message));

  /* ═══ ١) وصف الحملات بالعربي ════════════════════════════════════════════ */
  const noteRow = (r) => ({
    platform: r.platform,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name || "",
    brings: r.brings || "",
    how: r.how || "",
    audience: r.audience || "",
    offerId: r.offer_id || "",
    updatedAt: r.updated_at,
  });

  // كل الأوصاف مرة واحدة — الصفحة بتجيبها مع قايمة الحملات في نفس اللحظة
  app.get("/api/marketing/campaign-notes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("SELECT * FROM campaign_notes ORDER BY updated_at DESC");
    return c.json({ ok: true, notes: r.rows.map(noteRow) });
  });

  app.get("/api/marketing/campaign-notes/:platform/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query(
      "SELECT * FROM campaign_notes WHERE platform=$1 AND campaign_id=$2",
      [c.req.param("platform"), c.req.param("id")]
    );
    if (!r.rowCount) return c.json({ ok: true, note: null });
    return c.json({ ok: true, note: noteRow(r.rows[0]) });
  });

  app.put("/api/marketing/campaign-notes/:platform/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const r = await pool.query(
      `INSERT INTO campaign_notes (platform, campaign_id, campaign_name, brings, how, audience, offer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (platform, campaign_id) DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name,
         brings = EXCLUDED.brings, how = EXCLUDED.how,
         audience = EXCLUDED.audience, offer_id = EXCLUDED.offer_id,
         updated_at = NOW()
       RETURNING *`,
      [c.req.param("platform"), c.req.param("id"), String(b.campaignName || ""),
       String(b.brings || ""), String(b.how || ""), String(b.audience || ""),
       b.offerId ? String(b.offerId) : null]
    );
    return c.json({ ok: true, note: noteRow(r.rows[0]) });
  });

  app.delete("/api/marketing/campaign-notes/:platform/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM campaign_notes WHERE platform=$1 AND campaign_id=$2",
      [c.req.param("platform"), c.req.param("id")]);
    return c.json({ ok: true });
  });

  /* ═══ ٢) طابور الموافقات العام ═══════════════════════════════════════════ */
  const approvalRow = (r) => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body || "",
    detail: r.detail || {}, requestedBy: r.requested_by || "",
    status: r.status, ownerNote: r.owner_note || "",
    decidedAt: r.decided_at, createdAt: r.created_at,
  });

  app.get("/api/marketing/approvals", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") || 100), 500);
    const params = [];
    let where = "";
    if (status) { params.push(status); where = "WHERE status = $1"; }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM approvals ${where} ORDER BY (status='pending') DESC, created_at DESC LIMIT $${params.length}`,
      params
    );
    const pending = (await pool.query("SELECT count(*)::int AS n FROM approvals WHERE status='pending'")).rows[0].n;
    return c.json({ ok: true, pending, approvals: r.rows.map(approvalRow) });
  });

  /* أي وكيل تاني بيحطّ بند هنا: تصميم، نص إعلان، عرض محتاج تأكيد.
     kind اختياري وبيتعرض بأيقونته في الصفحة. */
  app.post("/api/marketing/approvals", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const title = String(b.title || "").trim();
    if (!title) return c.json({ ok: false, error: "title required" }, 400);
    const r = await pool.query(
      `INSERT INTO approvals (id, kind, title, body, detail, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.id || newId("ap"), String(b.kind || "other"), title, String(b.body || ""),
       jb(b.detail || {}), String(b.requestedBy || "")]
    );
    return c.json({ ok: true, approval: approvalRow(r.rows[0]) });
  });

  for (const [verb, status] of [["approve", "approved"], ["reject", "rejected"]]) {
    app.post(`/api/marketing/approvals/:id/${verb}`, async (c) => {
      const err = await requireAdmin(c); if (err) return err;
      const b = await c.req.json().catch(() => ({}));
      const r = await pool.query(
        `UPDATE approvals SET status=$2, owner_note=$3, decided_at=NOW()
          WHERE id=$1 AND status='pending' RETURNING *`,
        [c.req.param("id"), status, String(b.note || "")]
      );
      if (!r.rowCount) return c.json({ ok: false, error: "not found or already decided" }, 404);
      return c.json({ ok: true, approval: approvalRow(r.rows[0]) });
    });
  }

  app.delete("/api/marketing/approvals/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM approvals WHERE id=$1", [c.req.param("id")]);
    return c.json({ ok: true });
  });

  /* ═══ ٣) العروض ═════════════════════════════════════════════════════════ */
  const offerRow = (r) => ({
    id: r.id, name: r.name, price: Number(r.price) || 0,
    contents: r.contents || "", validity: r.validity || "",
    channels: r.channels || "all", active: r.active !== false,
    sort: r.sort || 0, updatedAt: r.updated_at,
  });

  app.get("/api/marketing/offers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("SELECT * FROM mk_offers ORDER BY active DESC, sort, created_at");
    return c.json({ ok: true, offers: r.rows.map(offerRow) });
  });

  app.post("/api/marketing/offers", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    if (!name) return c.json({ ok: false, error: "name required", message: "اكتب اسم العرض" }, 400);
    const r = await pool.query(
      `INSERT INTO mk_offers (id, name, price, contents, validity, channels, active, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, price=EXCLUDED.price, contents=EXCLUDED.contents,
         validity=EXCLUDED.validity, channels=EXCLUDED.channels,
         active=EXCLUDED.active, sort=EXCLUDED.sort, updated_at=NOW()
       RETURNING *`,
      [b.id || newId("of"), name, Number(b.price) || 0, String(b.contents || ""),
       String(b.validity || ""), String(b.channels || "all"),
       b.active === undefined ? true : !!b.active, Math.trunc(Number(b.sort) || 0)]
    );
    return c.json({ ok: true, offer: offerRow(r.rows[0]) });
  });

  app.put("/api/marketing/offers/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const r = await pool.query(
      `UPDATE mk_offers SET
         name=COALESCE($2,name), price=COALESCE($3,price), contents=COALESCE($4,contents),
         validity=COALESCE($5,validity), channels=COALESCE($6,channels),
         active=COALESCE($7,active), sort=COALESCE($8,sort), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [c.req.param("id"),
       b.name === undefined ? null : String(b.name),
       b.price === undefined ? null : Number(b.price) || 0,
       b.contents === undefined ? null : String(b.contents),
       b.validity === undefined ? null : String(b.validity),
       b.channels === undefined ? null : String(b.channels),
       b.active === undefined ? null : !!b.active,
       b.sort === undefined ? null : Math.trunc(Number(b.sort) || 0)]
    );
    if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, offer: offerRow(r.rows[0]) });
  });

  app.delete("/api/marketing/offers/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM mk_offers WHERE id=$1", [c.req.param("id")]);
    return c.json({ ok: true });
  });

  /* ═══ ٤) زراير الحملة → مسار موافقة الطيار الآلي ══════════════════════════
     مش بننفّذ من هنا. بنسجّل قرار «مقترح» بنفس شكل قرارات الوكيل، والواجهة
     بتنده /api/autopilot/decisions/:id/approve. يعني:
       • حدود الميزانية (maxCampaignBudget / ADS_MAX_DAILY_BUDGET) شغالة زي ما هي
       • ADS_ALLOW_WRITE لازم يكون مفعّل — وإلا الرفض بيرجع بنصه للواجهة
       • القرار بيبان في سجل القرارات زي أي قرار تاني، ومعاه إنه يدوي */
  app.post("/api/marketing/campaign-action", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const kind = String(b.kind || "");
    if (!["pause", "resume", "budget"].includes(kind)) {
      return c.json({ ok: false, error: "kind must be pause|resume|budget" }, 400);
    }
    const platform = String(b.platform || "").trim();
    const campaignId = String(b.campaignId || "").trim();
    if (!platform || !campaignId) return c.json({ ok: false, error: "platform & campaignId required" }, 400);

    const detail = {};
    let reason = "";
    if (kind === "budget") {
      const to = Number(b.to);
      if (!Number.isFinite(to) || to <= 0) {
        return c.json({ ok: false, error: "to must be a positive daily budget", message: "اكتب ميزانية يومية أكبر من صفر" }, 400);
      }
      detail.to = to;
      if (Number.isFinite(Number(b.from))) detail.from = Number(b.from);
      reason = `تعديل ميزانية يدوي من صفحة المراجعة${Number.isFinite(Number(b.from)) ? ` — من ${Number(b.from)} إلى ${to} ر.س يوميًا` : ` — ${to} ر.س يوميًا`}`;
    } else {
      reason = kind === "pause" ? "إيقاف يدوي من صفحة المراجعة" : "تشغيل يدوي من صفحة المراجعة";
    }
    detail.manual = true;
    detail.source = "marketing-hub";

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,'proposed')`,
      [id, platform, campaignId, String(b.campaignName || ""), kind, jb(detail), reason]
    );
    return c.json({ ok: true, decisionId: id, kind, detail, reason });
  });

  console.log("[hub] routes ready");
}
