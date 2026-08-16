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
  const notify = deps.notify || null;
  const accounts = deps.accounts || (() => null); // late-bound — accounts registers after us
  const carts = deps.carts || (() => null);       // late-bound — abandoned-cart tracker

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
      -- Coupons (2026-08-12): a percentage flows into the POS invoice itself
      -- (adjustments.discount {id:null, percentage_value} — probed live), so
      -- what MyFatoorah charges IS what TabSense books.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS coupon TEXT;
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC NOT NULL DEFAULT 0;
      -- POS-push audit (2026-08-13, after a paid order stalled with a
      -- swallowed error): every attempt counts itself and keeps TabSense's
      -- actual answer, so "وقف ومش عارفين ليه" cannot happen again.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS pos_attempts INT NOT NULL DEFAULT 0;
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS last_pos_error TEXT;
      CREATE TABLE IF NOT EXISTS shop_coupons (
        code TEXT PRIMARY KEY,
        percent NUMERIC NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        min_total NUMERIC NOT NULL DEFAULT 0,
        max_uses INT,
        used_count INT NOT NULL DEFAULT 0,
        expires_at DATE,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- «مرة واحدة لكل عميل»: نفس الكود ينفع لمئات العملاء لكن كل رقم جوال
      -- مرة واحدة بس (بيتحسب من الطلبات المدفوعة فعلاً).
      ALTER TABLE shop_coupons ADD COLUMN IF NOT EXISTS once_per_customer BOOLEAN NOT NULL DEFAULT FALSE;
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
    // notify.js decides which stages the customer hears about; a notification
    // failure must never fail the state change it describes.
    if (notify) notify.orderStatusChanged(String(orderNo), status).catch((e) =>
      console.error(`[shop] notify failed for ${orderNo}:`, e.message));
  }

  /* ── coupons ──
     Two pools answer to the same field: shop_coupons (dashboard-made) first,
     then the AMBASSADOR codes (the invite system) — Omar asked that the codes
     already living in the system work on the store too. An ambassador code
     carries its batch's percentage, burns once (redeemed=true at payment),
     and the attribution to its ambassador stays intact for free.
     Caveat (told to Omar): online redemption marks it used HERE — the POS
     cashier flow has its own promotion check and cannot see ours. */
  async function checkCoupon(codeRaw, subtotal, phoneNorm) {
    const code = String(codeRaw || "").trim().toUpperCase();
    if (!code) return null;
    const r = await pool.query("SELECT * FROM shop_coupons WHERE upper(code)=$1", [code]);
    const cp = r.rows[0];
    if (cp) {
      if (!cp.active) return { ok: false, error: "not_found" };
      if (cp.expires_at && new Date(cp.expires_at) < new Date(new Date().toDateString())) return { ok: false, error: "expired" };
      if (cp.max_uses != null && cp.used_count >= cp.max_uses) return { ok: false, error: "maxed" };
      if (Number(subtotal) < Number(cp.min_total)) return { ok: false, error: "min_total", minTotal: Number(cp.min_total) };
      if (cp.once_per_customer && phoneNorm) {
        const used = await pool.query(
          `SELECT 1 FROM shop_orders
            WHERE coupon=$1 AND phone_norm=$2 AND status NOT IN ('pending_payment','expired') LIMIT 1`,
          [cp.code, phoneNorm]);
        if (used.rowCount) return { ok: false, error: "already_used" };
      }
      return { ok: true, code: cp.code, percent: Number(cp.percent), kind: "coupon" };
    }
    // أكواد السفراء: قابلة للإيقاف من اللوحة لو قلق الاستخدام المزدوج
    // (أونلاين + كاشير) رجّح كفة الفصل الكامل بين القناتين.
    if (((await getSettingsData()).shop || {}).acceptAmbassadorCodes === false) {
      return { ok: false, error: "not_found" };
    }
    const amb = (await pool.query(
      `SELECT c.code, c.redeemed, b.discount_percent, b.validity_date
         FROM codes c JOIN batches b ON b.id = c.batch_id
        WHERE upper(c.code)=$1`, [code])).rows[0];
    if (!amb) return { ok: false, error: "not_found" };
    if (amb.redeemed) return { ok: false, error: "maxed" };
    if (amb.validity_date && new Date(amb.validity_date) < new Date(new Date().toDateString())) {
      return { ok: false, error: "expired" };
    }
    return { ok: true, code: amb.code, percent: Number(amb.discount_percent), kind: "ambassador" };
  }

  // PUBLIC — the cart asks before checkout so the customer sees the discount live.
  app.post("/api/shop/validate-coupon", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 120)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const res = await checkCoupon(b.code, Number(b.subtotal) || 0, b.phone ? normPhone(b.phone) : null);
    if (!res) return c.json({ ok: false, error: "empty" }, 400);
    return c.json(res, res.ok ? 200 : 404);
  });

  // Admin CRUD — the dashboard's coupons pane.
  app.get("/api/shop/coupons", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query("SELECT * FROM shop_coupons ORDER BY created_at DESC")).rows;
    return c.json({ ok: true, coupons: rows });
  });
  app.post("/api/shop/coupons", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json();
    const code = String(b.code || "").trim().toUpperCase();
    if (!code || !(Number(b.percent) > 0)) return c.json({ ok: false, error: "code and percent required" }, 400);
    const r = await pool.query(
      `INSERT INTO shop_coupons(code, percent, active, min_total, max_uses, expires_at, note, once_per_customer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET percent=$2, active=$3, min_total=$4, max_uses=$5, expires_at=$6, note=$7, once_per_customer=$8
       RETURNING *`,
      [code, Math.min(100, Number(b.percent)), b.active !== false, Number(b.min_total) || 0,
       b.max_uses != null && b.max_uses !== "" ? Number(b.max_uses) : null,
       b.expires_at || null, String(b.note || "").slice(0, 120), b.once_per_customer === true]);
    return c.json({ ok: true, coupon: r.rows[0] });
  });
  app.delete("/api/shop/coupons/:code", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM shop_coupons WHERE code=$1", [String(c.req.param("code")).toUpperCase()]);
    return c.json({ ok: true });
  });

  /* ── storefront appearance + behavior (PUBLIC) — edited from the dashboard.
     Colors/texts live in settings.storefront so a rebrand (or the coming
     freshcuts.sa / SaaS skinning) is a settings edit, not a deploy. */
  app.get("/api/shop/storefront", async (c) => {
    const s = await getSettingsData();
    const sf = s.storefront || {};
    const cat = s.catalog || {};
    return c.json({
      ok: true,
      theme: sf.theme || {},           // {brand, deep, bg, ink, ...} CSS vars
      texts: sf.texts || {},           // {title, subtitle}
      // الفوتر: {line1, line2, links:[{label,url}]} — من اللوحة، من غير أي
      // ذكر لمزوّد خارجي (طلب عمر 2026-08-16: TabSense ما يظهرش)
      footer: sf.footer || {},
      // بانرات العروض: [{title, desc, emoji, color, target_item?, active}] —
      // بتترسم في شريط العروض قبل عروض TabSense، وبتتعدل من اللوحة فوراً.
      banners: (sf.banners || []).filter((x) => x && x.active !== false),
      // أصناف مخفية من العرض (غير نشطة أو تكرارات الأوزان): بتختفي من
      // القايمة والبحث لكن بتفضل في البيانات — عشان منتقي الوزن يلاقيها.
      hiddenIds: (cat.hiddenIds || []).map(String),
      // مواعيد العمل من اللوحة: {enabled, days:{sat..fri:{open,close}}, note}
      // «close» أصغر من «open» معناها بعد منتصف الليل (12:00 → 02:00).
      // المتجر بيمنع الطلب بره المواعيد (وTabSense كمان بتقول pos_available).
      hours: s.hours || null,
      // مجموعات الأوزان: الصنف الأصل بيفتح منتقي (⅓/½/كيلو) وكل اختيار
      // بيطلب صنف TabSense الحقيقي بتاعه — المطبخ يشوف الوزن الصح دايماً.
      variantGroups: cat.variantGroups || [],
      allowCash: (s.shop || {}).allowCash === true, // Omar 2026-08-12: online-only by default
    });
  });

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
    // dine-in-only offers (صينية اللمة …) cannot be delivered/picked up: refuse
    // BEFORE a payment session exists. Same list the storefront + catalog use.
    {
      const s0 = await getSettingsData();
      const dine = new Set([
        ...String(process.env.CATALOG_DINE_IN_IDS ?? "121").split(","),
        ...((s0.catalog || {}).dineInIds || []).map(String),
      ].map((x) => String(x).trim()).filter(Boolean));
      const bad = items.filter((it) => dine.has(String(it.product_id)));
      if (bad.length) return c.json({ ok: false, error: "dine_in_only", items: bad.map((x) => x.product_id) }, 422);
    }
    const cust = b.customer || {};
    const phoneNorm = normPhone(cust.phone);
    if (!/^5\d{8}$/.test(phoneNorm)) return c.json({ ok: false, error: "invalid_phone" }, 400);
    if (option === "delivery" && !(b.address?.latitude && b.address?.longitude)) {
      return c.json({ ok: false, error: "address_required" }, 400);
    }

    // Coupon first — the discount changes every number after it.
    let coupon = null;
    if (b.coupon) {
      // subtotal check happens against the raw cart estimate; the authoritative
      // re-check against real totals comes right after the first calc.
      coupon = await checkCoupon(b.coupon, Number.MAX_SAFE_INTEGER, phoneNorm);
      if (coupon && !coupon.ok) return c.json({ ok: false, error: "coupon_" + coupon.error, coupon }, 422);
    }
    // Standing per-customer discount (الملاك): auto-applies by phone alone.
    // Never stacks with a coupon — the customer gets whichever is bigger.
    const standing = await (accounts()?.customerDiscount?.(phoneNorm) ?? null);
    let discountPercent = coupon?.percent || 0;
    let discountSource = coupon?.ok ? { kind: coupon.kind, code: coupon.code } : null;
    if (standing && standing.percent > discountPercent) {
      discountPercent = standing.percent;
      discountSource = { kind: "customer", label: standing.label };
      coupon = null; // the code stays unburnt when the standing discount wins
    }

    // Pass 1: food only, discounted — this is the subtotal the delivery quote
    // (free-over / minimum rules) judges against.
    let calc;
    try {
      calc = await tsstore.calculateOrder({
        branchId, orderOptionId: OPTION_ID[option], purchases: items,
        tipAmount: Number(b.tip) || 0, discountPercent,
      });
    } catch (e) {
      return c.json({ ok: false, error: "calc_failed", detail: e.message }, 422);
    }
    let totals = calc.totals || {};
    const foodTotal = r2((totals.tendered_amount || totals.total_amount || 0) / tsstore.MULTIPLY);
    if (coupon?.ok && Number(coupon.percent) > 0) {
      const recheck = await checkCoupon(b.coupon, foodTotal, phoneNorm);
      if (!recheck.ok) return c.json({ ok: false, error: "coupon_" + recheck.error, coupon: recheck }, 422);
    }

    let deliveryFee = 0, dq = null;
    if (option === "delivery") {
      dq = await delivery.quote({
        lat: b.address.latitude, lng: b.address.longitude, orderTotal: foodTotal,
      });
      if (!dq.deliverable) return c.json({ ok: false, error: "not_deliverable", quote: dq }, 422);
      deliveryFee = dq.fee;
    }

    // Pass 2 (Omar's rule: «إجمالي المدفوع يتسجل كله في TabSense بالشكل
    // المظبوط»): the fee rides INTO the POS invoice as quantity×(1-SAR
    // delivery product) — TabSense ignores charge adjustments and rejects
    // free-form prices, so the quantity trick is the one exact channel.
    // Needs settings.shop.deliveryFeeProductId (a 1.00-SAR menu product);
    // without it we fall back to charging the fee outside the POS invoice.
    const feeProductId = ((await getSettingsData()).shop || {}).deliveryFeeProductId;
    let feeInPos = false;
    if (deliveryFee > 0 && feeProductId) {
      const prod = await tsstore.findProduct(feeProductId, branchId).catch(() => null);
      if (prod) {
        // The discount percentage applies order-wide, fee line included. To
        // keep the CUSTOMER's fee equal to the quote, inflate the quantity so
        // the discounted line lands back on the quoted fee (integer SAR).
        const qty = discountPercent > 0
          ? Math.round(deliveryFee / (1 - discountPercent / 100))
          : deliveryFee;
        const feeLine = {
          product_id: Number(feeProductId), quantity: qty,
          tax_id: prod.tax_id ?? 1,
          // `price` is the pre-VAT system price — the field calculate-order
          // validates against (retail_price is the VAT-inclusive display one).
          unit_amount: Math.round(Number(prod.price) * tsstore.MULTIPLY),
        };
        try {
          calc = await tsstore.calculateOrder({
            branchId, orderOptionId: OPTION_ID[option], purchases: [...items, feeLine],
            tipAmount: Number(b.tip) || 0, discountPercent,
          });
          totals = calc.totals || {};
          feeInPos = true;
        } catch (e) {
          console.error("[shop] fee-product calc failed, falling back:", e.message);
        }
      }
    }

    const tip = r2(b.tip);
    const posTotal = r2((totals.tendered_amount || totals.total_amount || 0) / tsstore.MULTIPLY);
    // When the fee is booked in the POS, the charge == the POS invoice exactly;
    // otherwise the fee is collected on top (the old designed gap).
    const total = feeInPos ? posTotal : r2(posTotal + deliveryFee);
    const discountAmount = r2(((totals.total_amount_discount_excluded || 0) - (totals.total_amount || 0)) / tsstore.MULTIPLY);

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
         mf_session_id, notes, coupon, discount_percent, discount_amount, history)
       VALUES ($1,'pending_payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [orderNo, option, branchId,
       jb({ name: cust.name || "", phone: "+966" + phoneNorm, deviceId: b.deviceId ? String(b.deviceId).slice(0, 64) : null }), phoneNorm,
       jb(b.address || null), jb(items), jb(calc),
       // subtotal = the food part of what was charged (fee booked separately
       // whether inside or outside the POS invoice).
       r2(total - deliveryFee), deliveryFee, tip, total, jb(dq ? { ...dq, feeInPos } : null),
       session.SessionId || null, (b.notes || "").slice(0, 200),
       coupon?.ok ? coupon.code : null, discountPercent, discountAmount,
       jb([{ at: new Date().toISOString(), status: "pending_payment" }])]
    );
    return c.json({
      ok: true, orderNo, total, subtotal: r2(total - deliveryFee), deliveryFee, tip,
      discount: discountAmount, coupon: coupon?.ok ? coupon.code : null,
      discountSource, feeInPos, currency: "SAR",
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

    const publicUrl = env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa");
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
    // The coupon burns exactly when money moved, not at checkout — an
    // abandoned payment must not eat a limited-use code. Ambassador codes
    // (not in shop_coupons) mark redeemed instead, keeping their attribution.
    if (row.coupon) {
      pool.query("UPDATE shop_coupons SET used_count = used_count + 1 WHERE code=$1", [row.coupon])
        .then((up) => up.rowCount ? null : pool.query(
          "UPDATE codes SET redeemed=true, redeemed_at=NOW(), updated_at=NOW() WHERE upper(code)=upper($1)", [row.coupon]))
        .catch((e) => console.error("[shop] coupon burn failed:", e.message));
    }
    // العنوان يتحفظ في دفتر العميل بمجرد ما الفلوس تتحرك — بغض النظر عن كونه
    // مسجل دخول وقت الطلب أو لأ. من غير ده، اللي طلب كضيف النهاردة وسجّل
    // دخول بكرة يلاقي دفتر عناوين فاضي، ويبقى وعدنا ليه بالدخول كلام فاضي.
    if (row.option === "delivery" && row.address) {
      Promise.resolve(accounts()?.saveAddressFor?.(row.phone_norm, row.address))
        .catch((e) => console.error("[shop] address autosave failed:", e.message));
    }
    // السلة المتروكة اتقفلت: الطلب اتم فعلاً
    const cartsApi = carts();
    if (cartsApi) cartsApi.markOrdered({
      phoneNorm: row.phone_norm, deviceId: (row.customer || {}).deviceId, orderNo: row.order_no,
    }).catch(() => {});
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
        // Omar's rule (2026-08-13): وقت الطلب ووقت الاستلام في الملاحظات
        // إجباري. Riyadh clock — the cashier reads this, not a machine.
        notes: (() => {
          const hm = (t) => new Date(new Date(t).getTime() + 3 * 3600_000).toISOString().slice(11, 16);
          return [
            row.option === "delivery" ? "توصيل" : "استلام",
            `طُلب ${hm(row.created_at)}`,
            row.option === "pickup" ? `استلام ${hm(Date.now() + 40 * 60_000)}` : "",
            "مدفوع أونلاين✅",
            row.notes || "",
          ].filter(Boolean).join(" - ");
        })(),
        paymentMethod: settings.posPaymentMethod || "cash", // → "online" after task-#6 probe + POS setting
        deliveryAddress: addr.street || addr.area || (row.option === "delivery" ? "Delivery" : "Pickup"),
        latitude: addr.latitude, longitude: addr.longitude,
      });
      await setStatus(orderNo, "pos_created", {
        cols: { pos_order_id: String(created.id) },
      });
      await pool.query(
        "UPDATE shop_orders SET pos_attempts=pos_attempts+1, last_pos_error=NULL WHERE order_no=$1", [orderNo]);
    } catch (e) {
      // TabSense's actual answer is the diagnosis — "order creation failed"
      // alone cost us a stalled paid order on 2026-08-13.
      const detail = e.resp ? JSON.stringify(e.resp).slice(0, 600) : "";
      const errText = `${e.message}${detail ? " | " + detail : ""}`;
      console.error(`[shop] POS create failed for ${orderNo}: ${errText}`);
      await pool.query(
        "UPDATE shop_orders SET pos_attempts=pos_attempts+1, last_pos_error=$2, updated_at=NOW() WHERE order_no=$1",
        [orderNo, errText.slice(0, 800)]);
      // history gets ONE entry per state change, not one per 2-minute retry
      if (row.status !== "paid_pos_failed") {
        await setStatus(orderNo, "paid_pos_failed", { note: errText.slice(0, 300) });
      }
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
      // the id the ad pixels must use for Purchase — same id the offline POS
      // sync reports, so the platforms de-dupe instead of double counting
      posOrderId: row.pos_order_id || null,
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
              coupon, discount_amount, mf_invoice_id, mf_payment_id, refund_id, pos_order_id,
              pos_approval, pos_attempts, last_pos_error, created_at, updated_at
         FROM shop_orders ${where} ORDER BY created_at DESC LIMIT $${p.length}`, p)).rows;
    return c.json({ ok: true, orders: rows });
  });

  /* Full audit of one order: the lifecycle history, the POS-push record, the
     items — «تراكينج كامل» for the dashboard's order drill-down. */
  app.get("/api/shop/orders/:orderNo", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    const shipment = row.option === "delivery" ? await delivery.shipmentOf(row.order_no) : null;
    const { pos_calc, ...rest } = row;
    return c.json({ ok: true, order: rest, shipment });
  });

  /* Manual retry from the dashboard — no waiting for the 2-minute sweep. */
  app.post("/api/shop/orders/:orderNo/retry-pos", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (!["paid", "paid_pos_failed"].includes(row.status)) {
      return c.json({ ok: false, error: "not_retryable", status: row.status }, 409);
    }
    // السلة المتروكة اتقفلت: الطلب اتم فعلاً
    const cartsApi = carts();
    if (cartsApi) cartsApi.markOrdered({
      phoneNorm: row.phone_norm, deviceId: (row.customer || {}).deviceId, orderNo: row.order_no,
    }).catch(() => {});
    await createPosOrder(row.order_no);
    const after = await getOrderRow(row.order_no);
    return c.json({ ok: true, status: after.status, posOrderId: after.pos_order_id, lastError: after.last_pos_error });
  });

  /* Reconciliation feed: MyFatoorah collected vs what the POS knows about.
     The gap (delivery fees + tips) is BY DESIGN — the POS order carries the
     food total only — so the screen states it instead of hiding it. */
  app.get("/api/shop/summary", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = c.req.query("from") || null, to = c.req.query("to") || null;
    const r = (await pool.query(
      `SELECT
         count(*) FILTER (WHERE status NOT IN ('pending_payment','expired'))::int AS paid_orders,
         COALESCE(sum(total) FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS gateway_total,
         -- Once the fee rides inside the POS invoice (feeInPos), the POS books
         -- food + fee; before that it books food only.
         COALESCE(sum(subtotal + CASE WHEN (delivery_quote->>'feeInPos')::boolean THEN delivery_fee ELSE 0 END)
           FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS pos_total,
         COALESCE(sum(delivery_fee) FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS delivery_fees,
         COALESCE(sum(tip) FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS tips,
         count(*) FILTER (WHERE status='rejected_refunded')::int AS refunds,
         COALESCE(sum(total) FILTER (WHERE status='rejected_refunded'),0)::numeric AS refunded_total,
         count(*) FILTER (WHERE status='paid_pos_failed')::int AS stuck_orders,
         count(*) FILTER (WHERE status='pending_payment')::int AS awaiting_payment,
         count(*) FILTER (WHERE status='delivered')::int AS delivered
       FROM shop_orders
       WHERE ($1::date IS NULL OR created_at >= $1::date)
         AND ($2::date IS NULL OR created_at < ($2::date + 1))`,
      [from, to])).rows[0];
    const n = (v) => Number(v) || 0;
    return c.json({
      ok: true, from, to,
      paidOrders: n(r.paid_orders),
      gatewayTotal: n(r.gateway_total),   // what MyFatoorah collected
      posTotal: n(r.pos_total),           // what TabSense shows (food only)
      deliveryFees: n(r.delivery_fees),   // the designed gap, part 1
      tips: n(r.tips),                    // the designed gap, part 2
      refunds: n(r.refunds), refundedTotal: n(r.refunded_total),
      stuckOrders: n(r.stuck_orders),     // paid but not in the POS — needs eyes NOW
      awaitingPayment: n(r.awaiting_payment),
      delivered: n(r.delivered),
    });
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
