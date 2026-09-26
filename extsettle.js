/* ═══════════════════════════════════════════════════════════════════════════
   🧾 تسوية المناديب الخارجيين (٢٦/٩)

   طلب عمر: «احتاج في اللوحة يكون في مكان لتسوية طلبات المناديب الخارجيين،
   ويكون في مهام بادخال التكلفة وادخال المدفوع منها للمطابقة».

   المصدر: dl_shipments provider='external' (المدير بيسجّلها من البورتال —
   مندوب من بره، أو موظف من عندنا kind=staff، أو «التوصيل بالحي»).
     • التكلفة = dl_shipments.cost (نفس العمود اللي تقارير البورتال بتجمعه —
       مصدر واحد). null = «لسه ماتكتبتش» ⇒ مهمة «أدخل التكلفة».
     • المدفوع = مجموع dl_ext_payments للشحنة. التكلفة > المدفوع ⇒ مهمة
       «أدخل المدفوع». دفعة واحدة لكذا طلب بتتوزّع بالأقدم أولاً.
   الحالة: needs_cost ← unpaid ← partial ← settled (أو overpaid لو دفعنا زيادة).
   الشحنة الملغية من غير تكلفة مش بتظهر (المندوب ماشتغلش).
═══════════════════════════════════════════════════════════════════════════ */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const METHODS = { cash: "كاش", transfer: "تحويل بنكي", stc: "STC Pay", other: "أخرى" };

export function settleStatus(cost, paid) {
  if (cost == null) return "needs_cost";
  const c = r2(cost), p = r2(paid);
  if (c === 0 && p === 0) return "settled";
  if (p === 0) return "unpaid";
  if (p < c) return "partial";
  if (p > c) return "overpaid";
  return "settled";
}

/* مفتاح المندوب للتجميع: الجوال لو موجود، غير كده الاسم */
export function courierKey(driver) {
  const d = driver || {};
  const ph = String(d.phone || "").replace(/\D/g, "").replace(/^(966|0)/, "");
  if (/^5\d{8}$/.test(ph)) return `p:${ph}`;
  const nm = String(d.name || "").trim();
  return nm ? `n:${nm}` : "unknown";
}

/* توزيع دفعة على شحنات (الأقدم أولاً). amount=null ⇒ كل واحدة بياخد رصيده.
   بيرمي لو المبلغ أكبر من المستحق (زيادة = غلط في الإدخال غالباً). */
export function allocate(rows, amount) {
  const due = rows.map((r) => ({ id: r.id, left: r2(Math.max(0, r2(r.cost) - r2(r.paid))), at: r.created_at }))
    .filter((r) => r.left > 0)
    .sort((a, b) => new Date(a.at) - new Date(b.at) || Number(a.id) - Number(b.id));
  const total = r2(due.reduce((a, r) => a + r.left, 0));
  if (amount == null) return { total, parts: due.map((r) => ({ id: r.id, amount: r.left })) };
  let left = r2(amount);
  if (left <= 0) throw Object.assign(new Error("المبلغ لازم يكون أكبر من صفر"), { code: "bad_amount" });
  if (left > total + 0.001) throw Object.assign(new Error(`المبلغ (${left}) أكبر من المستحق (${total})`), { code: "over_due" });
  const parts = [];
  for (const r of due) {
    if (left <= 0) break;
    const a = r2(Math.min(r.left, left));
    parts.push({ id: r.id, amount: a });
    left = r2(left - a);
  }
  return { total, parts };
}

function csvCell(v) { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const bad = (c, error, message, status = 400) => c.json({ ok: false, error, message }, status);
  const J = (v) => JSON.stringify(v);
  const byOf = async (c) => {
    try {
      const t = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
      const u = t.startsWith("cms:") && deps.sessionUser ? await deps.sessionUser(t) : null;
      return (u && u.name) || "المالك";
    } catch { return "المالك"; }
  };

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dl_ext_payments (
        id BIGSERIAL PRIMARY KEY,
        shipment_id BIGINT NOT NULL,
        amount NUMERIC NOT NULL CHECK (amount > 0),
        paid_at DATE NOT NULL DEFAULT CURRENT_DATE,
        method TEXT NOT NULL DEFAULT 'cash',
        ref TEXT, note TEXT, batch TEXT,
        created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS dl_ext_payments_ship_idx ON dl_ext_payments(shipment_id);
    `);
  }
  ensureSchema().catch((e) => console.error("[extsettle] schema:", e.message));

  async function rowsFor({ from, to, ids } = {}) {
    const params = [];
    let where = `s.provider='external' AND (s.status <> 'cancelled' OR COALESCE(s.cost,0) > 0)`;
    if (ids) { params.push(ids); where += ` AND s.id = ANY($${params.length}::bigint[])`; }
    if (from) { params.push(from); where += ` AND (s.created_at AT TIME ZONE 'Asia/Riyadh')::date >= $${params.length}::date`; }
    if (to) { params.push(to); where += ` AND (s.created_at AT TIME ZONE 'Asia/Riyadh')::date <= $${params.length}::date`; }
    const r = await pool.query(
      `SELECT s.id, s.shop_order_no AS order_no, s.status, s.cost, s.cost_basis, s.driver, s.created_at, s.delivered_at,
              o.total AS order_total, o.delivery_fee,
              COALESCE(p.paid, 0) AS paid, p.last_paid_at, COALESCE(p.n, 0)::int AS payments
         FROM dl_shipments s
         LEFT JOIN shop_orders o ON o.order_no = s.shop_order_no
         LEFT JOIN (SELECT shipment_id, sum(amount) AS paid, max(paid_at) AS last_paid_at, count(*) AS n
                      FROM dl_ext_payments GROUP BY 1) p ON p.shipment_id = s.id
        WHERE ${where}
        ORDER BY s.created_at DESC LIMIT 2000`, params);
    return r.rows.map((x) => {
      const d = x.driver || {};
      const cost = x.cost == null ? null : r2(x.cost);
      const paid = r2(x.paid);
      return {
        id: Number(x.id), orderNo: x.order_no, shipStatus: x.status, createdAt: x.created_at, deliveredAt: x.delivered_at,
        courier: { key: courierKey(d), name: d.name || null, phone: d.phone || null, source: d.source || "external", district: d.district || null },
        cost, costBasis: x.cost_basis || null, paid, balance: cost == null ? null : r2(cost - paid),
        status: settleStatus(cost, paid), payments: x.payments, lastPaidAt: x.last_paid_at,
        orderTotal: x.order_total == null ? null : r2(x.order_total),
      };
    });
  }

  function summarize(rows) {
    const t = { count: rows.length, cost: 0, paid: 0, due: 0, needsCost: 0, unpaid: 0, partial: 0, settled: 0, overpaid: 0 };
    const by = new Map();
    for (const r of rows) {
      t[{ needs_cost: "needsCost", unpaid: "unpaid", partial: "partial", settled: "settled", overpaid: "overpaid" }[r.status]]++;
      t.cost += r.cost || 0; t.paid += r.paid;
      if (r.balance > 0) t.due += r.balance;
      const k = r.courier.key;
      const g = by.get(k) || { key: k, name: r.courier.name, phone: r.courier.phone, source: r.courier.source, count: 0, cost: 0, paid: 0, due: 0, needsCost: 0, lastAt: null };
      g.count++; g.cost += r.cost || 0; g.paid += r.paid; if (r.balance > 0) g.due += r.balance;
      if (r.status === "needs_cost") g.needsCost++;
      if (!g.lastAt || r.createdAt > g.lastAt) g.lastAt = r.createdAt;
      if (!g.name && r.courier.name) g.name = r.courier.name;
      by.set(k, g);
    }
    for (const k of ["cost", "paid", "due"]) t[k] = r2(t[k]);
    const couriers = [...by.values()].map((g) => ({ ...g, cost: r2(g.cost), paid: r2(g.paid), due: r2(g.due) }))
      .sort((a, b) => b.due - a.due || b.count - a.count);
    return { totals: t, couriers };
  }

  app.get("/api/delivery/ext-settle", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const q = (k) => c.req.query(k);
    const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null);
    const rows = await rowsFor({ from: iso(q("from")), to: iso(q("to")) });
    const { totals, couriers } = summarize(rows);
    if (q("format") === "csv") {
      const head = ["رقم الطلب", "التاريخ", "المندوب", "الجوال", "النوع", "التكلفة", "المدفوع", "المتبقي", "الحالة"];
      const ST = { needs_cost: "التكلفة ناقصة", unpaid: "مادفعناش", partial: "دفع جزئي", settled: "متسوّي", overpaid: "مدفوع زيادة" };
      const lines = [head.join(",")].concat(rows.map((r) => [r.orderNo, new Date(r.createdAt).toISOString().slice(0, 10),
        r.courier.name, r.courier.phone, r.courier.source === "staff" ? "موظف" : "خارجي", r.cost, r.paid, r.balance, ST[r.status]].map(csvCell).join(",")));
      return new Response("﻿" + lines.join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="external-couriers-${iso(q("from")) || "all"}.csv"` } });
    }
    return c.json({ ok: true, rows, totals, couriers, methods: METHODS });
  });

  // مدفوعات شحنة (للتفاصيل والتراجع)
  app.get("/api/delivery/ext-settle/:id/payments", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("SELECT * FROM dl_ext_payments WHERE shipment_id=$1 ORDER BY paid_at, id", [Number(c.req.param("id"))]);
    return c.json({ ok: true, payments: r.rows.map((p) => ({ ...p, id: Number(p.id), amount: r2(p.amount) })) });
  });

  // مهمة «أدخل التكلفة» (+ تصحيح اسم/جوال المندوب عشان التجميع يبقى صح)
  app.post("/api/delivery/ext-settle/:id/cost", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const id = Number(c.req.param("id"));
    const cur = (await rowsFor({ ids: [id] }))[0];
    if (!cur) return bad(c, "not_found", "الشحنة مش موجودة أو مش مندوب خارجي", 404);
    const by = await byOf(c);
    const at = new Date().toISOString();
    if (b.cost !== undefined) {
      const cost = b.cost === null || b.cost === "" ? null : Number(b.cost);
      if (cost != null && (!Number.isFinite(cost) || cost < 0 || cost > 500)) return bad(c, "bad_cost", "التكلفة لازم بين ٠ و٥٠٠");
      if (cost != null && cost < cur.paid) return bad(c, "below_paid", `دفعنا ${cur.paid} ر.س بالفعل — التكلفة ماتقلّش عن كده`);
      await pool.query(
        `UPDATE dl_shipments SET cost=$2, cost_basis=CASE WHEN $2::numeric IS NULL THEN NULL ELSE 'manual' END,
                events = events || $3::jsonb, updated_at=NOW() WHERE id=$1`,
        [id, cost, J([{ at, provider: "external", event: "cost", by: `dashboard:${by}`, note: cost == null ? "التكلفة اتمسحت" : `التكلفة ${cost} ر.س` }])]);
      await pool.query(`UPDATE dl_courier_incidents SET detail = detail || $2::jsonb WHERE order_no=$1`,
        [cur.orderNo, J({ needsCost: cost == null, cost })]).catch(() => {});
    }
    if (b.name !== undefined || b.phone !== undefined) {
      const patch = {};
      if (b.name !== undefined) patch.name = String(b.name || "").trim().slice(0, 80) || null;
      if (b.phone !== undefined) patch.phone = String(b.phone || "").trim().slice(0, 20) || null;
      await pool.query(`UPDATE dl_shipments SET driver = COALESCE(driver,'{}'::jsonb) || $2::jsonb, updated_at=NOW() WHERE id=$1`, [id, J(patch)]);
    }
    return c.json({ ok: true, row: (await rowsFor({ ids: [id] }))[0] });
  });

  /* مهمة «أدخل المدفوع». {shipmentIds:[…], amount?, method, paidAt?, ref?, note?}
     amount فاضي ⇒ كل شحنة بتتسوّى برصيدها. amount موجود ⇒ بيتوزّع بالأقدم أولاً. */
  app.post("/api/delivery/ext-settle/pay", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad_json", "بيانات غلط"); }
    const ids = (Array.isArray(b.shipmentIds) ? b.shipmentIds : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
    if (!ids.length) return bad(c, "no_rows", "اختار طلب واحد على الأقل");
    const rows = await rowsFor({ ids });
    const noCost = rows.filter((r) => r.cost == null);
    if (noCost.length) return bad(c, "needs_cost", `أدخل التكلفة الأول: ${noCost.map((r) => r.orderNo).join("، ")}`);
    const method = METHODS[b.method] ? b.method : "cash";
    const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(b.paidAt || "") ? b.paidAt : null;
    let plan;
    try { plan = allocate(rows.map((r) => ({ id: r.id, cost: r.cost, paid: r.paid, created_at: r.createdAt })),
      b.amount === undefined || b.amount === null || b.amount === "" ? null : Number(b.amount)); }
    catch (e) { return bad(c, e.code || "bad_amount", e.message); }
    if (!plan.parts.length) return bad(c, "nothing_due", "الطلبات دي متسوّية بالفعل");
    const by = await byOf(c);
    const batch = plan.parts.length > 1 ? `B${Date.now().toString(36)}` : null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of plan.parts) {
        await client.query(
          `INSERT INTO dl_ext_payments(shipment_id, amount, paid_at, method, ref, note, batch, created_by)
           VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7,$8)`,
          [p.id, p.amount, paidAt, method, String(b.ref || "").slice(0, 80) || null, String(b.note || "").slice(0, 300) || null, batch, by]);
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
    finally { client.release(); }
    const paid = r2(plan.parts.reduce((a, p) => a + p.amount, 0));
    return c.json({ ok: true, paid, count: plan.parts.length, batch, rows: await rowsFor({ ids }) });
  });

  // تراجع عن دفعة (غلط في الإدخال)
  app.delete("/api/delivery/ext-settle/payments/:pid", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await pool.query("DELETE FROM dl_ext_payments WHERE id=$1 RETURNING shipment_id", [Number(c.req.param("pid"))]);
    if (!r.rowCount) return bad(c, "not_found", "الدفعة مش موجودة", 404);
    return c.json({ ok: true, row: (await rowsFor({ ids: [Number(r.rows[0].shipment_id)] }))[0] || null });
  });

  return { rowsFor, summarize };
}
