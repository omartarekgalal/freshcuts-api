/* ═══════════════════════════════════════════════════════════════════════════
   SHOP — the online-order lifecycle on OUR OWN payment rail.

   One row in shop_orders is the truth for one online order, from cart to
   doorstep:

     pending_payment → paid → pos_created → accepted
       → (delivery) courier_requested → courier_assigned → on_the_way → delivered
       → (pickup)   ready is signalled by the staff panel, not the POS API
     failure exits: expired, paid_pos_failed (sweep retries), rejected_refunded,
     courier_cancelled.

   Money model (matters for the reconciliation screen): the POS order carries
   the FOOD total only — TabSense's calculate-order knows nothing about our
   delivery fee. MyFatoorah charges food + delivery + tip. So:
     MyFatoorah settlement  = Σ shop_orders.total
     POS (TabSense)         = Σ shop_orders.subtotal
     the gap                = Σ delivery_fee + tip   ← BY DESIGN, not a leak.
   (Task #6 probes whether adjustments.charges can carry the fee into the POS
   total; if yes we can fold it in later.)

   Payment trust: confirmOrder() is the ONLY door to "paid", and it always
   re-checks GetPaymentStatus — the webhook, the returning browser, and the
   sweep all funnel through it, so a forged callback can't mint an order.

   Omar's rule (2026-08-11): cashier rejects a paid order → refund runs
   AUTOMATICALLY, no approval. The sweep does it exactly once per order
   (refund_id guards the retry loop).
═══════════════════════════════════════════════════════════════════════════ */

import * as tsstore from "./tsstore.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const OPTION_ID = { pickup: 2, delivery: 3 };

// Customer-facing stages, in order, with Arabic labels for the tracking page.
export const STAGES = {
  pending_payment: { label: "بانتظار الدفع", step: 0 },
  paid: { label: "تم الدفع", step: 1 },
  pos_created: { label: "وصل المطعم", step: 1 },
  accepted: { label: "المطعم قبل طلبك وبدأ التجهيز", step: 2 },
  courier_requested: { label: "بنطلب لك مندوب", step: 3 },
  courier_assigned: { label: "المندوب في الطريق للمطعم", step: 3 },
  on_the_way: { label: "طلبك في الطريق إليك", step: 4 },
  delivered: { label: "تم التوصيل — بالهنا والشفا", step: 5 },
  rejected_refunded: { label: "اعتذر المطعم عن الطلب — تم استرجاع المبلغ", step: -1 },
  courier_cancelled: { label: "تعثر التوصيل — جاري المتابعة", step: -1 },
  paid_pos_failed: { label: "تم الدفع — جاري تأكيد الطلب", step: 1 },
  expired: { label: "انتهت صلاحية الطلب", step: -1 },
};

/* naive per-IP limiter, same shape as funnel.js — checkout is not a hot path */
const rl = new Map();
function rateLimited(ip, max = 60) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone } = ctx;
  const pay = deps.pay;
  const delivery = deps.delivery;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_orders (
        order_no TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending_payment',
        option TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT '1',
        customer JSONB,
        phone_norm TEXT,
        address JSONB,
        items JSONB,
        pos_calc JSONB,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        delivery_fee NUMERIC NOT NULL DEFAULT 0,
        tip NUMERIC NOT NULL DEFAULT 0,
        total NUMERIC NOT NULL DEFAULT 0,
        delivery_quote JSONB,
        mf_session_id TEXT,
        mf_invoice_id TEXT,
        mf_payment_id TEXT,
        refund_id TEXT,
        refund JSONB,
        pos_order_id TEXT,
        pos_approval TEXT,
        notes TEXT,
        history JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS shop_orders_status_idx ON shop_orders(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS shop_orders_phone_idx ON shop_orders(phone_norm, created_at DESC);
      CREATE INDEX IF NOT EXISTS shop_orders_invoice_idx ON shop_orders(mf_invoice_id);
    `);
  }
  ensureSchema()
    .then(() => console.log("[shop] schema ready"))
    .catch((e) => console.error("[shop] schema failed:", e.message));

  async function getOrderRow(orderNo) {
    const r = await pool.query("SELECT * FROM shop_orders WHERE order_no=$1", [String(orderNo)]);
    return r.rows[0] || null;
  }

  async function setStatus(orderNo, status, extra = {}) {
    const sets = ["status=$2", "history = history || $3::jsonb", "updated_at=NOW()"];
    const vals = [String(orderNo), status, jb([{ at: new Date().toISOString(), status, ...extra.note ? { note: extra.note } : {} }])];
    for (const [col, v] of Object.entries(extra.cols || {})) {
      vals.push(v);
      sets.push(`${col}=$${vals.length}`);
    }
    await pool.query(`UPDATE shop_orders SET ${sets.join(", ")} WHERE order_no=$1`, vals);
  }

  /* ── checkout: cart → locked POS prices → delivery quote → MF session ── */
  app.post("/api/shop/checkout", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    if (!pay.configured()) return c.json({ ok: false, error: "payments_not_configured" }, 503);

    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const option = b.option === "pickup" ? "pickup" : "delivery";
    const branchId = String(b.branch_id || "1");
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return c.json({ ok: false, error: "empty_cart" }, 400);
    const cust = b.customer || {};
    const phoneNorm = normPhone(cust.phone);
    if (!/^5\d{8}$/.test(phoneNorm)) return c.json({ ok: false, error: "invalid_phone" }, 400);
    if (option === "delivery" && !(b.address?.latitude && b.address?.longitude)) {
      return c.json({ ok: false, error: "address_required" }, 400);
    }

    // Lock prices with TabSense NOW; the same calc payload creates the POS
    // order after payment, so what the customer paid is what the POS gets.
    let calc;
    try {
      calc = await tsstore.calculateOrder({
        branchId, orderOptionId: OPTION_ID[option], purchases: items, tipAmount: Number(b.tip) || 0,
      });
    } catch (e) {
      return c.json({ ok: false, error: "calc_failed", detail: e.message }, 422);
    }
    const totals = calc.totals || {};
    const subtotal = r2((totals.tendered_amount || totals.total_amount || 0) / tsstore.MULTIPLY);

    let deliveryFee = 0, dq = null;
    if (option === "delivery") {
      dq = await delivery.quote({
        lat: b.address.latitude, lng: b.address.longitude, orderTotal: subtotal,
      });
      if (!dq.deliverable) return c.json({ ok: false, error: "not_deliverable", quote: dq }, 422);
      deliveryFee = dq.fee;
    }
    const tip = r2(b.tip);
    // subtotal already includes the tip when TabSense returns tendered_amount;
    // the delivery fee is the only amount TabSense does not know about.
    const total = r2(subtotal + deliveryFee);

    const orderNo = "W" + Date.now();
    let session;
    try {
      session = await pay.initiateSession(phoneNorm);
    } catch (e) {
      return c.json({ ok: false, error: "payment_init_failed", detail: e.message }, 502);
    }

    await pool.query(
      `INSERT INTO shop_orders(order_no, status, option, branch_id, customer, phone_norm,
         address, items, pos_calc, subtotal, delivery_fee, tip, total, delivery_quote,
         mf_session_id, notes, history)
       VALUES ($1,'pending_payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [orderNo, option, branchId,
       jb({ name: cust.name || "", phone: "+966" + phoneNorm }), phoneNorm,
       jb(b.address || null), jb(items), jb(calc),
       subtotal, deliveryFee, tip, total, jb(dq),
       session.SessionId || null, (b.notes || "").slice(0, 200),
       jb([{ at: new Date().toISOString(), status: "pending_payment" }])]
    );
    return c.json({
      ok: true, orderNo, total, subtotal, deliveryFee, tip, currency: "SAR",
      sessionId: session.SessionId, countryCode: session.CountryCode || "SAU",
    });
  });

  /* ── execute: embedded form collected the method → 3DS redirect URL ── */
  app.post("/api/shop/execute", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const row = await getOrderRow(b.orderNo);
    if (!row) return c.json({ ok: false, error: "order_not_found" }, 404);
    if (row.status !== "pending_payment") return c.json({ ok: false, error: "already_processed" }, 409);

    const publicUrl = env("STOREFRONT_PUBLIC_URL", "https://order.o2m8.me");
    let res;
    try {
      res = await pay.executePayment({
        sessionId: b.sessionId || row.mf_session_id,
        amount: Number(row.total),
        orderNo: row.order_no,
        customerName: row.customer?.name,
        customerMobile: row.customer?.phone,
        callbackUrl: `${publicUrl}/pay/success?on=${row.order_no}`,
        errorUrl: `${publicUrl}/pay/error?on=${row.order_no}`,
      });
    } catch (e) {
      return c.json({ ok: false, error: "execute_failed", detail: e.message }, 502);
    }
    await pool.query(
      "UPDATE shop_orders SET mf_invoice_id=$2, updated_at=NOW() WHERE order_no=$1",
      [row.order_no, res.InvoiceId != null ? String(res.InvoiceId) : null]
    );
    return c.json({ ok: true, paymentUrl: res.PaymentURL || res.InvoiceURL || null, invoiceId: res.InvoiceId });
  });

  /* ── confirmOrder — the one door to "paid" (webhook / browser / sweep) ── */
  async function confirmOrder({ orderNo, invoiceId }) {
    let row = orderNo ? await getOrderRow(orderNo) : null;
    if (!row && invoiceId) {
      const r = await pool.query("SELECT * FROM shop_orders WHERE mf_invoice_id=$1", [String(invoiceId)]);
      row = r.rows[0] || null;
    }
    if (!row) return { ok: false, error: "order_not_found" };
    if (row.status !== "pending_payment") {
      // paid already (or beyond) — idempotent success so retries are harmless
      return { ok: true, status: row.status, orderNo: row.order_no };
    }
    const key = row.mf_invoice_id || String(invoiceId || "");
    if (!key) return { ok: false, error: "no_invoice" };

    const st = await pay.paymentStatus({ key, keyType: "InvoiceId" });
    if (!st.isPaid) return { ok: false, status: "unpaid", invoiceStatus: st.invoiceStatus };
    // Belt-and-braces: the invoice must be OUR order's invoice for OUR amount.
    if (st.orderNo && st.orderNo !== row.order_no) {
      return { ok: false, error: "reference_mismatch" };
    }
    await setStatus(row.order_no, "paid", {
      cols: { mf_payment_id: st.paymentId != null ? String(st.paymentId) : null },
    });
    await createPosOrder(row.order_no);
    const after = await getOrderRow(row.order_no);
    return { ok: true, status: after.status, orderNo: row.order_no, posOrderId: after.pos_order_id };
  }

  /* Create the POS external order from the locked calc. Failure is a STATE
     (paid_pos_failed), not an exception — the sweep retries and the dashboard
     shows it; the customer's money is never in limbo silently. */
  async function createPosOrder(orderNo) {
    const row = await getOrderRow(orderNo);
    if (!row || row.pos_order_id) return;
    const settings = (await getSettingsData()).shop || {};
    const addr = row.address || {};
    try {
      const created = await tsstore.createPosOrder({
        branchId: row.branch_id,
        orderOptionId: OPTION_ID[row.option] || 3,
        calcData: row.pos_calc,
        orderNo: row.order_no,
        customer: {
          id: null,
          first_name: row.customer?.name || null,
          phone_number: row.customer?.phone || null,
          email: null,
          address: { city: null, area: addr.area || null, country_code: null, street: addr.street || null },
        },
        notes: [
          row.option === "delivery" ? "توصيل" : "استلام",
          "مدفوع أونلاين ✅",
          row.notes || "",
        ].filter(Boolean).join(" - "),
        paymentMethod: settings.posPaymentMethod || "cash", // → "online" after task-#6 probe + POS setting
        deliveryAddress: addr.street || addr.area || (row.option === "delivery" ? "Delivery" : "Pickup"),
        latitude: addr.latitude, longitude: addr.longitude,
      });
      await setStatus(orderNo, "pos_created", {
        cols: { pos_order_id: String(created.id) },
      });
    } catch (e) {
      console.error(`[shop] POS create failed for ${orderNo}:`, e.message);
      await setStatus(orderNo, "paid_pos_failed", { note: e.message });
    }
  }

  /* Browser lands back from 3DS → the storefront polls this. Public. */
  app.post("/api/shop/payment-status", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 240)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!b.orderNo) return c.json({ ok: false, error: "orderNo required" }, 400);
    const res = await confirmOrder({ orderNo: String(b.orderNo), invoiceId: b.invoiceId });
    return c.json(res, res.ok ? 200 : 402);
  });

  /* Customer tracking — delivery-app style stages + courier driver info. */
  app.get("/api/shop/track/:orderNo", async (c) => {
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, found: false }, 404);
    const stage = STAGES[row.status] || { label: row.status, step: 0 };
    let courier = null;
    if (row.option === "delivery" && ["courier_requested", "courier_assigned", "on_the_way", "delivered"].includes(row.status)) {
      const sh = await delivery.shipmentOf(row.order_no);
      if (sh) courier = { status: sh.status, driver: sh.driver || null };
    }
    return c.json({
      ok: true, found: true, orderNo: row.order_no, status: row.status,
      label: stage.label, step: stage.step, option: row.option,
      total: Number(row.total), subtotal: Number(row.subtotal),
      deliveryFee: Number(row.delivery_fee), courier,
      createdAt: row.created_at,
    });
  });

  /* Dashboard monitor + reconciliation feed. */
  app.get("/api/shop/orders", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const status = c.req.query("status");
    const p = [];
    let where = "";
    if (status) { p.push(status); where = `WHERE status=$1`; }
    p.push(Math.min(500, Number(c.req.query("limit")) || 100));
    const rows = (await pool.query(
      `SELECT order_no, status, option, customer, phone_norm, subtotal, delivery_fee, tip, total,
              mf_invoice_id, mf_payment_id, refund_id, pos_order_id, pos_approval, created_at, updated_at
         FROM shop_orders ${where} ORDER BY created_at DESC LIMIT $${p.length}`, p)).rows;
    return c.json({ ok: true, orders: rows });
  });

  /* Shipment webhook events → order stage. Called by delivery.js. */
  const SHIP_STAGE = {
    confirmed: null,                    // courier accepted the job; stage unchanged
    driver_assigned: "courier_assigned",
    pickup_completed: "on_the_way",
    delivered: "delivered",
    cancelled: "courier_cancelled",
  };
  async function onShipmentEvent(orderNo, event, _payload) {
    const next = SHIP_STAGE[event];
    if (!next) return;
    const row = await getOrderRow(orderNo);
    if (!row) return;
    // never let a late webhook drag a delivered order backwards
    const order = ["courier_requested", "courier_assigned", "on_the_way", "delivered"];
    if (next !== "courier_cancelled" &&
        order.indexOf(next) <= order.indexOf(row.status)) return;
    await setStatus(orderNo, next);
  }

  /* ── the sweep: retries, acceptance watch, auto-refund, dispatch ── */
  async function sweep() {
    // 1) paid but the POS never got the order — retry the create.
    const failed = (await pool.query(
      `SELECT order_no FROM shop_orders
        WHERE status='paid_pos_failed' AND created_at > NOW() - INTERVAL '24 hours'`)).rows;
    for (const r of failed) await createPosOrder(r.order_no);

    // 2) orders sitting in the POS inbox — did the cashier accept or reject?
    const watching = (await pool.query(
      `SELECT order_no, branch_id, pos_order_id, option, total, mf_payment_id, refund_id
         FROM shop_orders
        WHERE status='pos_created' AND pos_order_id IS NOT NULL
          AND created_at > NOW() - INTERVAL '24 hours'`)).rows;
    for (const r of watching) {
      let posOrder;
      try { posOrder = await tsstore.getOrder(r.pos_order_id, r.branch_id); } catch { continue; }
      const approval = tsstore.approvalOf(posOrder);
      if (approval) {
        await pool.query("UPDATE shop_orders SET pos_approval=$2, updated_at=NOW() WHERE order_no=$1",
          [r.order_no, approval]);
      }
      const a = String(approval || "").toLowerCase();
      if (a.includes("accept")) {
        await setStatus(r.order_no, "accepted");
        const settings = (await getSettingsData()).shop || {};
        if (r.option === "delivery" && settings.autoDispatch !== false) {
          try {
            await delivery.dispatch(await getOrderRow(r.order_no));
            await setStatus(r.order_no, "courier_requested");
          } catch (e) {
            console.error(`[shop] courier dispatch failed for ${r.order_no}:`, e.message);
            // stays 'accepted'; next sweep will NOT retry automatically —
            // dispatch failures need eyes, the dashboard shows the stall.
          }
        }
      } else if (a.includes("reject")) {
        // Omar's rule: automatic refund, exactly once.
        if (!r.refund_id && r.mf_payment_id) {
          try {
            const ref = await pay.makeRefund({
              paymentId: r.mf_payment_id, amount: Number(r.total),
              comment: `FreshCuts ${r.order_no} rejected by cashier`,
            });
            await setStatus(r.order_no, "rejected_refunded", {
              cols: { refund_id: String(ref.RefundId ?? ref.RefundReference ?? "requested"), refund: jb(ref) },
            });
          } catch (e) {
            console.error(`[shop] AUTO-REFUND FAILED for ${r.order_no}:`, e.message);
            await setStatus(r.order_no, "rejected_refunded", { note: `REFUND FAILED: ${e.message}` });
          }
        } else {
          await setStatus(r.order_no, "rejected_refunded");
        }
      }
    }

    // 3) housekeeping: a payment session nobody completed.
    await pool.query(
      `UPDATE shop_orders SET status='expired', updated_at=NOW()
        WHERE status='pending_payment' AND created_at < NOW() - INTERVAL '6 hours'`);
  }

  const sweepSec = Number(env("SHOP_SWEEP_SECONDS", "120"));
  if (sweepSec > 0) {
    setInterval(() => sweep().catch((e) => console.error("[shop] sweep failed:", e.message)), sweepSec * 1000);
  }

  return { confirmOrder, onShipmentEvent, sweep };
}
