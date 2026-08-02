/* ═══════════════════════════════════════════════════════════════════════════
   WHY WAS THIS ORDER DISCOUNTED?

   July carried 8,500 SAR of discounts and the P&L counted every riyal of it as
   lost revenue. That is wrong in both directions:

     • An influencer eating free is ADVERTISING. It belongs in marketing spend
       with the TikTok and Meta money, judged on what it brings back — not
       buried in "discounts" where it looks like leakage.
     • A 50% staff meal is a staff benefit, not a promotion, and it should
       never flatter or damage a marketing figure.
     • A 15% coupon is a promotion and should be measured as one.

   Telling them apart needs to know WHO the customer is, which is why this
   module syncs TabSense's customer groups (مجموعات العملاء). Owners and staff
   are named there; everything else is inferred from the discount shape, and
   every rule is configurable because an inference is not a fact.

   Two owners sit in that group — محمد عبدالعال and عمر طارق — and both were
   previously topping the "best customers" list on lifetime spend. They are not
   customers. Any customer ranking that includes them is telling Omar about
   himself.
═══════════════════════════════════════════════════════════════════════════ */

const TZ_SHIFT = "interval '3 hour'";

// Discount shapes, as fractions of the pre-discount VAT-inclusive price.
// Bands are wide enough to survive rounding on a 3-item order but narrow
// enough not to swallow a neighbouring rule.
const DEFAULT_RULES = {
  fullCompIsInfluencer: true,   // a 100% comp with no named customer = influencer
  staffPct: [0.45, 0.55],
  couponPct: [0.13, 0.17],
  platformPromoPct: [0.18, 0.22],
  // Groups whose members are internal, keyed by the TabSense group name.
  internalGroups: ["الملاك", "owners", "موظفين المطعم", "Staff Only"],
};

const REASONS = {
  influencer: { label: "مؤثرين (ضيافة)", marketing: true },
  influencer_paid: { label: "مؤثرين (مدفوع)", marketing: true },
  staff: { label: "موظفين وملاك", marketing: false },
  coupon: { label: "كوبونات تحفيزية", marketing: true },
  platform_promo: { label: "عروض التطبيقات", marketing: true },
  other: { label: "خصومات أخرى", marketing: false },
};

export function register(app, ctx) {
  const { pool, requireAdmin, todayISO, daysAgoISO, normPhone, ts, getSettingsData } = ctx;

  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const range = (c, d = 30) => [
    isDate(c.req.query("from")) ? c.req.query("from") : daysAgoISO(d - 1),
    isDate(c.req.query("to")) ? c.req.query("to") : todayISO(),
  ];

  (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_groups (
        group_id     TEXT PRIMARY KEY,
        name         TEXT NOT NULL DEFAULT '',
        local_name   TEXT NOT NULL DEFAULT '',
        is_internal  BOOLEAN NOT NULL DEFAULT FALSE,
        synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_group_members (
        group_id     TEXT NOT NULL,
        customer_id  TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        phone_norm   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (group_id, customer_id)
      );
      CREATE INDEX IF NOT EXISTS cgm_phone_idx ON customer_group_members(phone_norm);
      -- Cash paid to influencers. There is no system of record for this, so it
      -- is entered by hand and reported beside the comped meals, because both
      -- are the same spend from Omar's side.
      CREATE TABLE IF NOT EXISTS influencer_payments (
        id           TEXT PRIMARY KEY,
        paid_on      DATE NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        platform     TEXT NOT NULL DEFAULT '',
        amount_sar   NUMERIC NOT NULL DEFAULT 0,
        note         TEXT NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((e) => console.error("[groups] schema:", e.message));
  })();

  const rules = async () => {
    const s = await getSettingsData().catch(() => ({}));
    return { ...DEFAULT_RULES, ...(s?.discountRules || {}) };
  };

  /* ─── POST /api/groups/sync ─────────────────────────────────────────────
     Pull the groups and their members from the TabSense dashboard.         */
  app.post("/api/groups/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const r = await rules();
      const groups = await ts.fetchCustomerGroups();
      let members = 0;
      for (const g of groups) {
        const internal = r.internalGroups.some(
          (n) => n === g.name || n === g.localName);
        await pool.query(
          `INSERT INTO customer_groups (group_id, name, local_name, is_internal, synced_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (group_id) DO UPDATE SET
             name=EXCLUDED.name, local_name=EXCLUDED.local_name,
             is_internal=EXCLUDED.is_internal, synced_at=NOW()`,
          [String(g.id), g.name || "", g.localName || "", internal]
        );
        await pool.query("DELETE FROM customer_group_members WHERE group_id=$1", [String(g.id)]);
        for (const m of g.members || []) {
          await pool.query(
            `INSERT INTO customer_group_members (group_id, customer_id, name, phone_norm)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [String(g.id), String(m.id), m.name || "", normPhone(m.phone)]
          );
          members++;
        }
      }
      return c.json({ ok: true, groups: groups.length, members });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 502);
    }
  });

  app.get("/api/groups", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(`
      SELECT g.group_id, g.name, g.local_name, g.is_internal, g.synced_at,
             count(m.customer_id)::int AS members
        FROM customer_groups g
        LEFT JOIN customer_group_members m ON m.group_id = g.group_id
       GROUP BY 1,2,3,4,5 ORDER BY members DESC`)).rows;
    return c.json({ ok: true, groups: rows });
  });

  /* ─── GET /api/discounts/breakdown?from&to ──────────────────────────────
     Every discounted order, labelled with WHY. The classification order is
     deliberate: who the customer is beats what the discount looks like,
     because group membership is a fact and a percentage is a guess.        */
  app.get("/api/discounts/breakdown", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const [from, to] = range(c);
    const r = await rules();

    const rows = (await pool.query(`
      SELECT o.order_id, o.receipt, o.calendar_day::text AS day, o.gross_incl, o.discount_incl,
             o.total, o.staff_name,
             to_char(o.order_date + ${TZ_SHIFT}, 'HH24:MI') AS time,
             COALESCE(NULLIF(tc.name,''), NULLIF(s.customer_name,'')) AS customer,
             COALESCE(NULLIF(tc.phone_norm,''), NULLIF(s.phone_norm,'')) AS phone,
             COALESCE(s.source_note,'') AS app,
             (m.customer_id IS NOT NULL) AS is_internal,
             COALESCE(g.local_name, g.name, '') AS group_name
        FROM ts_orders o
        LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
        LEFT JOIN order_sources s ON s.order_id = o.order_id
        LEFT JOIN customer_group_members m
               ON (m.customer_id = o.customer_id
                   OR (m.phone_norm <> '' AND m.phone_norm = COALESCE(NULLIF(tc.phone_norm,''), s.phone_norm)))
        LEFT JOIN customer_groups g ON g.group_id = m.group_id AND g.is_internal
       WHERE o.calendar_day BETWEEN $1::date AND $2::date
         AND o.discount_incl > 0 AND o.gross_incl > 0
         AND o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'
       ORDER BY o.discount_incl DESC`, [from, to])).rows;

    const within = (v, [lo, hi]) => v >= lo && v <= hi;
    const out = rows.map((x) => {
      const gross = Number(x.gross_incl) || 0;
      const disc = Number(x.discount_incl) || 0;
      const pct = gross > 0 ? disc / gross : 0;
      let reason = "other";
      if (x.is_internal) reason = "staff";
      else if (pct >= 0.995) reason = r.fullCompIsInfluencer ? "influencer" : "other";
      else if (within(pct, r.staffPct)) reason = "staff";
      else if (within(pct, r.couponPct)) reason = "coupon";
      else if (x.app && within(pct, r.platformPromoPct)) reason = "platform_promo";
      return {
        orderId: x.order_id, receipt: x.receipt, day: x.day, time: x.time,
        gross, discount: disc, pct, paid: Number(x.total) || 0,
        customer: x.customer || null, phone: x.phone || null,
        app: x.app || null, staffName: x.staff_name || null,
        group: x.group_name || null, reason, reasonLabel: REASONS[reason].label,
        marketing: REASONS[reason].marketing,
        // A staff discount identified only by its percentage is a guess; one
        // identified by group membership is not. Say which this is.
        confident: !!x.is_internal || pct >= 0.995,
      };
    });

    const byReason = {};
    for (const k of Object.keys(REASONS)) {
      byReason[k] = { ...REASONS[k], orders: 0, discount: 0, gross: 0 };
    }
    for (const o of out) {
      const b = byReason[o.reason];
      b.orders++; b.discount += o.discount; b.gross += o.gross;
    }

    const paid = (await pool.query(
      `SELECT COALESCE(sum(amount_sar),0)::numeric AS total, count(*)::int AS n
         FROM influencer_payments WHERE paid_on BETWEEN $1::date AND $2::date`, [from, to])).rows[0];
    byReason.influencer_paid.orders = Number(paid.n) || 0;
    byReason.influencer_paid.discount = Number(paid.total) || 0;

    const totalDiscount = out.reduce((a, o) => a + o.discount, 0) + (Number(paid.total) || 0);
    const marketingSpend = Object.entries(byReason)
      .filter(([, v]) => v.marketing).reduce((a, [, v]) => a + v.discount, 0);

    return c.json({
      ok: true, from, to, rules: r,
      totals: {
        discountedOrders: out.length,
        totalDiscount,
        // The headline this whole module exists for: how much of the discount
        // bill was actually advertising.
        marketingSpend,
        marketingShare: totalDiscount > 0 ? marketingSpend / totalDiscount : null,
        unconfident: out.filter((o) => !o.confident).length,
      },
      byReason, orders: out,
    });
  });

  app.get("/api/influencer-payments", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const [from, to] = range(c, 90);
    const rows = (await pool.query(
      `SELECT * FROM influencer_payments WHERE paid_on BETWEEN $1::date AND $2::date
        ORDER BY paid_on DESC`, [from, to])).rows;
    return c.json({ ok: true, from, to, payments: rows,
      total: rows.reduce((a, r) => a + (Number(r.amount_sar) || 0), 0) });
  });

  app.post("/api/influencer-payments", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    if (!isDate(b.paidOn)) return c.json({ ok: false, error: "paidOn required (YYYY-MM-DD)" }, 400);
    const amount = Number(b.amountSar);
    if (!(amount > 0)) return c.json({ ok: false, error: "amountSar must be > 0" }, 400);
    const id = `inf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO influencer_payments (id, paid_on, name, platform, amount_sar, note)
       VALUES ($1,$2::date,$3,$4,$5,$6)`,
      [id, b.paidOn, String(b.name || "").slice(0, 120), String(b.platform || "").slice(0, 40),
       amount, String(b.note || "").slice(0, 300)]
    );
    return c.json({ ok: true, id });
  });

  app.delete("/api/influencer-payments/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("DELETE FROM influencer_payments WHERE id=$1", [c.req.param("id")]);
    return c.json({ ok: true, deleted: r.rowCount });
  });
}
