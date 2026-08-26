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
import { msisdn, readableAddress } from "./couriers.js";

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
  /* ما نقولش «تم الاسترجاع» والاسترجاع فشل.
     كان في الكود القديم مسار بيحط الطلب على rejected_refunded حتى لما
     MakeRefund بترمي — يعني العميل ياخد رسالة «تم استرجاع المبلغ كاملاً
     لبطاقتك» وفلوسه لسه معانا. ده أسوأ من عطل تقني: ده وعد كاذب بفلوس.
     الحالة دي بتفصل الحقيقة، وبتفضل ظاهرة كإنذار أحمر في اللوحة لحد ما
     حد يسترجع بإيده. */
  refund_failed: { label: "جاري استرجاع مبلغك — فريقنا بيتابع معك", step: -1 },
  courier_cancelled: { label: "تعثر التوصيل — جاري المتابعة", step: -1 },
  paid_pos_failed: { label: "تم الدفع — جاري تأكيد الطلب", step: 1 },
  expired: { label: "انتهت صلاحية الطلب", step: -1 },
};

/* ═══════════════════════════════════════════════════════════════════════════
   الاسترجاع — القرار متفصّل عن التنفيذ

   قاعدة عمر (2026-08-11): الكاشير يرفض طلب مدفوع ⇒ استرجاع تلقائي من غير
   موافقة. والفلوس دي فلوس عملاء حقيقيين، فالمنطق لازم يتجرّب أوفلاين من
   غير MyFatoorah ولا قاعدة بيانات — عشان كده القرار دالة صافية.

   القواعد:
     • مرة واحدة بس. refund_id موجود ⇒ خلاص. (MakeRefund مش idempotent —
       نداءان معناهم فلوس مرتين.)
     • من غير mf_payment_id مفيش حاجة تترجع: الطلب ما وصلش لدفع أصلاً.
     • المبلغ = `total` (أكل + توصيل + بقشيش) — اللي العميل دفعه بالظبط،
       مش `subtotal`. غلطة هنا معناها إن العميل بيدفع تمن التوصيلة على
       طلب اعتذرنا عنه.                                                     */
export function refundDecision(row, { maxAttempts = 3 } = {}) {
  if (!row) return { act: false, reason: "no_order" };
  if (row.refund_id) return { act: false, reason: "already_refunded", refundId: row.refund_id };
  if (!row.mf_payment_id) return { act: false, reason: "never_paid" };
  const amount = Number(row.total) || 0;
  if (!(amount > 0)) return { act: false, reason: "zero_amount" };
  /* بعد محاولات فاشلة متكررة بنبطّل نجرّب: كل محاولة فيها احتمال إن
     الاسترجاع نجح عندهم والرد ضاع في الطريق. بعد الحد ده الطلب بيفضل
     أحمر في اللوحة عشان بني آدم يشوفه ويسترجع بإيده. */
  if (Number(row.refund_attempts || 0) >= maxAttempts) {
    return { act: false, reason: "max_attempts", attempts: Number(row.refund_attempts) };
  }
  return { act: true, paymentId: String(row.mf_payment_id), amount };
}

/* ═══════════════════════════════════════════════════════════════════════════
   مراقب المهل (SLA) — شبكة الأمان للمرحلة اليدوية

   المرحلة الأولى فيها بني آدم في النص: الكاشير لازم يفتح لوحة شركة التوصيل
   ويكتب الطلب. والكاشير في عز الخدمة ممكن ينسى، أو ما يشوفش الشاشة، أو
   يكون واقف على الكاسة. **والفلوس اتاخدت خلاص** — فطلب بيقع هنا مش
   إزعاج، ده استرجاع وعميل ضايع.

   الدالة صافية عن قصد: بتاخد صورة الطلب وترجّع درجة الخطورة والخطوة
   المطلوبة، من غير قاعدة بيانات — فكل حالة اتفحصت في الاختبارات.

   الدرجات:
     1 = متأخر، الشاشة تولّع أحمر
     2 = تجاوز، رسالة للمدير على جواله
     3 = انتهى الوقت، تدخّل مالي (استرجاع)

   ليه الاسترجاع التلقائي بيحصل في حالة واحدة بس؟
   لو المطعم **ما قبلش** الطلب أصلاً، يبقى مفيش أكل اتعمل ومفيش كابتن
   اتبعت — العميل قاعد مستني على الفاضي، والاسترجاع هو الحل الصح والآمن.
   لكن لو المطعم قبل وجهّز الأكل، الاسترجاع التلقائي ممكن يرجّع فلوس طلب
   الكابتن ماسكه في إيده. الحالة دي بتروح لبني آدم، مش لكود.               */
export const DEFAULT_SLA = {
  posFailMinutes: 5,          // مدفوع وما وصلش النظام
  acceptMinutes: 8,           // في صندوق الطلبات الخارجية ومحدش قبله
  acceptBreachMinutes: 15,
  autoRefundNoAcceptMinutes: 25,  // ما اتقبلش خالص ⇒ استرجاع تلقائي
  handoffMinutes: 10,         // اتقبل، والكاشير ما دخّلوش على لوحة الشركة
  handoffBreachMinutes: 20,
  pickupMinutes: 25,          // اتدخّل على اللوحة، والكابتن ما جاش
  pickupBreachMinutes: 45,
  deliverMinutes: 45,         // خرج للعميل وما وصلش
  deliverBreachMinutes: 75,
};

export function slaCheck(o, cfg = {}, now = Date.now()) {
  const s = { ...DEFAULT_SLA, ...(cfg || {}) };
  const mins = (t) => (t ? Math.floor((now - new Date(t).getTime()) / 60000) : 0);
  const age = mins(o.created_at);
  const inStatus = mins(o.updated_at || o.created_at);
  const none = { level: 0, code: null, minutes: age };

  const at = (level, code, message, minutes, action) => ({ level, code, message, minutes, action: action || null });

  switch (o.status) {
    case "paid":
    case "paid_pos_failed":
      if (age >= s.posFailMinutes) {
        return at(2, "pos_stuck", `مدفوع من ${age} دقيقة ولسه ما وصلش النظام`, age, "retry_pos");
      }
      return none;

    case "pos_created":
      if (age >= s.autoRefundNoAcceptMinutes) {
        return at(3, "never_accepted",
          `${age} دقيقة والطلب ما اتقبلش — استرجاع تلقائي`, age, "auto_refund");
      }
      if (age >= s.acceptBreachMinutes) {
        return at(2, "accept_breach", `${age} دقيقة ومحدش قبل الطلب`, age, "accept_now");
      }
      if (age >= s.acceptMinutes) {
        return at(1, "accept_late", `${age} دقيقة في انتظار القبول`, age, "accept_now");
      }
      return none;

    case "accepted":
      if (o.option !== "delivery") return none;
      if (inStatus >= s.handoffBreachMinutes) {
        return at(2, "handoff_breach",
          `${inStatus} دقيقة من القبول والطلب لسه ما اتدخّلش على لوحة شركة التوصيل`, inStatus, "manual_handoff");
      }
      if (inStatus >= s.handoffMinutes) {
        return at(1, "handoff_late",
          `${inStatus} دقيقة — ادخّل الطلب على لوحة شركة التوصيل`, inStatus, "manual_handoff");
      }
      return none;

    case "courier_requested":
    case "courier_assigned":
      if (inStatus >= s.pickupBreachMinutes) {
        return at(2, "pickup_breach", `${inStatus} دقيقة والكابتن ما استلمش الطلب`, inStatus, "chase_courier");
      }
      if (inStatus >= s.pickupMinutes) {
        return at(1, "pickup_late", `${inStatus} دقيقة في انتظار الكابتن`, inStatus, "chase_courier");
      }
      return none;

    case "on_the_way":
      if (inStatus >= s.deliverBreachMinutes) {
        return at(2, "deliver_breach", `${inStatus} دقيقة والطلب لسه ما وصلش العميل`, inStatus, "chase_courier");
      }
      if (inStatus >= s.deliverMinutes) {
        return at(1, "deliver_late", `${inStatus} دقيقة في الطريق`, inStatus, "chase_courier");
      }
      return none;

    case "refund_failed":
      return at(3, "refund_failed", "فشل استرجاع مبلغ العميل — استرجع يدوياً من لوحة ماي فاتورة", inStatus, "manual_refund");

    case "courier_cancelled":
      return at(2, "delivery_failed", "تعثّر التوصيل — قرّر: إعادة إرسال ولا استرجاع", inStatus, "decide");

    default:
      return none;
  }
}

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
  const { pool, requireAdmin, requireCashierOrAdmin, getSettingsData, jb, normPhone } = ctx;
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
      -- الاسترجاع (2026-08-26): عدّاد المحاولات عشان ما نفضلش نضرب على
      -- MyFatoorah لما ترفض — MakeRefund مش idempotent، ومحاولة زيادة
      -- ممكن ترجّع فلوس مرتين لو الرد الأول ضاع في الطريق بس نجح عندهم.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS refund_attempts INT NOT NULL DEFAULT 0;
      -- سجل الإنذارات: كل درجة تصعيد تتبعت مرة واحدة لكل طلب، عشان المدير
      -- ما يصحاش على عشرين رسالة عن نفس الطلب.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS alerts JSONB NOT NULL DEFAULT '{}'::jsonb;
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
      // نافذة ترويجية: بتظهر مرة كل X ساعة لكل جهاز، وبتتقفل من اللوحة
      // بضغطة. {enabled,title,body,image,ctaLabel,ctaTarget,everyHours,
      //          delaySeconds,firstVisitOnly,couponCode}
      popup: (sf.popup && sf.popup.enabled) ? {
        id: String(sf.popup.id || "p1"),           // تغييره بيرجّع العرض للكل
        title: sf.popup.title || "", body: sf.popup.body || "",
        image: sf.popup.image || "", couponCode: sf.popup.couponCode || "",
        ctaLabel: sf.popup.ctaLabel || "", ctaTarget: sf.popup.ctaTarget || "",
        everyHours: Number(sf.popup.everyHours) || 24,
        delaySeconds: Number(sf.popup.delaySeconds) || 3,
        firstVisitOnly: sf.popup.firstVisitOnly === true,
      } : null,
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
  /* ── بورتال الكاشير ────────────────────────────────────────────────────
     شاشة الطلبات الحية اللي بتفتح على تابلت في المطبخ. بتستخدم نفس دخول
     الكاشير (رقم سري) — مش توكن الأدمن، عشان ما نديش موظف الكاشير مفتاح
     اللوحة كلها.

     اللي بترجعه مقصود ومحدود: اللي الكاشير محتاجه عشان يشتغل، ومفيش أرقام
     فلوس اللوحة ولا بيانات تانية. */
  app.get("/api/shop/board", async (c) => {
    const err = await requireCashierOrAdmin(c); if (err) return err;
    const hours = Math.min(48, Math.max(1, Number(c.req.query("hours")) || 12));
    const rows = (await pool.query(
      `SELECT o.order_no, o.status, o.option, o.customer, o.phone_norm, o.address,
              o.items, o.subtotal, o.delivery_fee, o.tip, o.total, o.coupon,
              o.pos_order_id, o.notes, o.created_at, o.updated_at, o.last_pos_error,
              o.alerts, o.refund_attempts,
              s.status AS ship_status, s.driver AS ship_driver, s.fa_order_number, s.dispatch,
              s.provider AS ship_provider, s.provider_ref AS ship_ref, s.cost AS ship_cost
         FROM shop_orders o
         LEFT JOIN LATERAL (
           SELECT status, driver, fa_order_number, dispatch, provider, provider_ref, cost
             FROM dl_shipments
            WHERE shop_order_no = o.order_no ORDER BY id DESC LIMIT 1) s ON TRUE
        WHERE o.status NOT IN ('pending_payment','expired')
          AND o.created_at > NOW() - ($1 || ' hours')::interval
        ORDER BY o.created_at DESC LIMIT 80`, [String(hours)])).rows;

    /* الوضع + مهل التصعيد بيرجعوا مع كل تحديث: الشاشة لازم تعرف إحنا في
       المرحلة اليدوية ولا الآلية عشان تعرض الأزرار الصح — مش تفترض. */
    const settings = await getSettingsData();
    const gate = await delivery.dispatchGate();
    const sla = (settings.delivery || {}).sla || {};

    return c.json({
      ok: true, at: new Date().toISOString(),
      mode: gate.mode, modeForced: gate.forced, modeSource: gate.source,
      /* بيانات المرحلة اليدوية اللي الكاشير محتاجها في اللوحة الخارجية */
      manualTarget: {
        provider: (settings.delivery || {}).manualProviderLabel || "أجلك (4U)",
        dashboardUrl: (settings.delivery || {}).manualDashboardUrl || null,
        pickup: {
          name: (settings.delivery || {}).pickupContactName || "فريش كتس",
          phone: msisdn((settings.delivery || {}).pickupContactPhone || ""),
          address: (settings.delivery || {}).pickupAddress || "فريش كتس — حي السلامة، دوار رامي، جدة",
          lat: Number(process.env.TABSENSE_STORE_LAT || 21.5881404),
          lng: Number(process.env.TABSENSE_STORE_LNG || 39.1521236),
        },
      },
      orders: rows.map((r) => ({
        orderNo: r.order_no, status: r.status, option: r.option,
        name: (r.customer || {}).name || null, phone: r.phone_norm,
        address: r.address || null, items: r.items || [],
        subtotal: Number(r.subtotal), deliveryFee: Number(r.delivery_fee),
        tip: Number(r.tip), total: Number(r.total), coupon: r.coupon,
        posOrderId: r.pos_order_id, notes: r.notes,
        createdAt: r.created_at, updatedAt: r.updated_at,
        posError: r.last_pos_error,
        refundAttempts: Number(r.refund_attempts) || 0,

        /* درجة التأخير — الشاشة بتلوّن وترتّب بيها، والرسالة مكتوبة
           للكاشير مش للمبرمج. */
        sla: slaCheck(r, sla),

        /* ── حزمة النقل اليدوي ───────────────────────────────────────
           كل حاجة الكاشير محتاج ينقلها للوحة «أجلك»، **بصيغتها النهائية**،
           عشان ما يقعدش يحوّل أرقام في دماغه وهو واقف في عز الخدمة:
             • الجوال بصيغة أجلك بالظبط: 9665XXXXXXXX من غير +
             • الجوال المحلي للاتصال بالعميل
             • العنوان سطر واحد جاهز للّصق
             • الإحداثيات «lat,lng» — نسخة واحدة تتلزق في خانة الموقع
           كل واحدة فيهم حقل مستقل عشان زرار «انسخ» ينسخ الحاجة لوحدها. */
        handoff: r.option !== "delivery" ? null : {
          name: (r.customer || {}).name || "عميل فريش كتس",
          phone: msisdn(r.phone_norm),                    // 9665XXXXXXXX
          phoneLocal: r.phone_norm ? "0" + r.phone_norm : null,
          address: readableAddress(r.address || {}),
          coords: (r.address || {}).latitude && (r.address || {}).longitude
            ? `${(r.address).latitude},${(r.address).longitude}` : null,
          mapsUrl: (r.address || {}).latitude && (r.address || {}).longitude
            ? `https://www.google.com/maps/dir/?api=1&destination=${(r.address).latitude},${(r.address).longitude}`
            : null,
          total: Number(r.total),
          // الكابتن ما بيحصّلش — الطلب مدفوع. أهم سطر في الشاشة كلها.
          paid: true,
          payNote: "مدفوع أونلاين — لا يُحصَّل من العميل",
          notes: r.notes || "",
          orderNo: r.order_no,
        },

        courier: r.ship_status ? {
          status: r.ship_status, driver: r.ship_driver || null,
          orderNumber: r.fa_order_number || null,
          // «اتقبل الطلب» مش معناها «في كابتن» — الشاشة لازم تفرّق
          assigned: Boolean((r.dispatch || {}).assigned),
          note: (r.dispatch || {}).message || null,
          provider: r.ship_provider || null,
          manual: r.ship_provider === "manual",
          ref: r.ship_ref || null,                 // رقم الطلب في لوحة الشركة
          cost: r.ship_cost != null ? Number(r.ship_cost) : null,
        } : null,
      })),
    });
  });

  /* الكاشير بيطلب مندوب بنفسه — لما التلقائي يكون مقفول، أو التوزيع فشل
     لأن مفيش كباتن ساعتها وبقى في كباتن دلوقتي. */
  app.post("/api/shop/board/:orderNo/courier", async (c) => {
    const err = await requireCashierOrAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (row.option !== "delivery") return c.json({ ok: false, error: "not_delivery" }, 400);
    if (!["accepted", "pos_created", "courier_requested"].includes(row.status)) {
      return c.json({ ok: false, error: "not_ready", status: row.status }, 409);
    }
    /* في المرحلة اليدوية الزرار ده مقفول. delivery.dispatch() بترمي برضه
       (البوابة الحقيقية)، بس بنرد رد واضح هنا عشان الشاشة تعرف تقول
       للكاشير «ادخّل الطلب على لوحة الشركة» بدل رسالة خطأ عامة. */
    const gate = await delivery.dispatchGate();
    if (gate.mode !== "auto") {
      return c.json({
        ok: false, error: "manual_mode", mode: gate.mode, source: gate.source,
        message: "المرحلة اليدوية: ادخّل الطلب على لوحة شركة التوصيل، وبعدين سجّله من زرار «سجّلت الطلب»",
      }, 409);
    }
    try {
      const res = await delivery.dispatch(row);
      if (row.status !== "courier_requested") await setStatus(row.order_no, "courier_requested");
      return c.json({ ok: true, assigned: res.assigned, orderNumber: res.orderNumber, note: res.dispatch?.message || null });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  /* ═══ المرحلة الأولى: الكاشير بيقول للسيستم عمل إيه ═══════════════════
     الكاشير بيفتح لوحة «أجلك»، يكتب الطلب، وبعدين يرجع هنا يسجّل الخطوة.
     كل خطوة بتحرّك حالة الطلب اللي العميل شايفها — والقاعدة اللي محكومين
     بيها: **ما نقولش للعميل حاجة ما حصلتش**.

       handoff   → courier_requested  «بنطلب لك مندوب»  (صح: طلبنا فعلاً)
       assigned  → courier_assigned   «المندوب في الطريق للمطعم»
                   الزرار ده بيتضغط لما الكاشير يشوف الكابتن اتعيّن في
                   لوحتهم — مش بيتحط تلقائي. عمر كان واضح إن ما ينفعش
                   نقول «اتعيّن مندوب» ومحدش اتعيّن.
       picked    → on_the_way         «طلبك في الطريق إليك»
       delivered → delivered
       failed    → courier_cancelled  + الطلب بيبان أحمر للإدارة

     مفيش أي خطوة فيهم بتتحرك لوحدها. الوقت وحده ما بيرقّيش حالة. */
  const MANUAL_TO_ORDER = {
    handoff: "courier_requested",
    assigned: "courier_assigned",
    picked: "on_the_way",
    delivered: "delivered",
    cancelled: "courier_cancelled",
  };

  app.post("/api/shop/board/:orderNo/manual/:stage", async (c) => {
    const err = await requireCashierOrAdmin(c); if (err) return err;
    const stage = String(c.req.param("stage"));
    const next = MANUAL_TO_ORDER[stage];
    if (!next) return c.json({ ok: false, error: "bad_stage" }, 400);

    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (row.option !== "delivery") return c.json({ ok: false, error: "not_delivery" }, 400);

    /* الطلب لازم يكون المطعم قبله قبل ما ندخّله على شركة التوصيل — الكابتن
       ما يجيش لطلب لسه ما اتعملش. (بنسمح بـ pos_created عشان الكاشير
       اللي بيقبل من شاشة الـPOS وبيسجّل هنا قبل ما الكنس يلحق يشوف.) */
    const OK_FROM = {
      handoff: ["pos_created", "accepted", "courier_requested"],
      assigned: ["courier_requested", "courier_assigned"],
      picked: ["courier_requested", "courier_assigned", "on_the_way"],
      delivered: ["courier_requested", "courier_assigned", "on_the_way"],
      cancelled: ["pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way"],
    };
    if (!OK_FROM[stage].includes(row.status)) {
      return c.json({ ok: false, error: "wrong_stage", status: row.status }, 409);
    }

    const b = await c.req.json().catch(() => ({}));
    let shipment;
    try {
      shipment = await delivery.manualEvent(row.order_no, stage, {
        ref: b.ref ? String(b.ref).slice(0, 64) : null,       // رقم الطلب في لوحتهم
        cost: b.cost != null && b.cost !== "" ? Number(b.cost) : null,
        driverName: b.driverName ? String(b.driverName).slice(0, 80) : null,
        driverPhone: b.driverPhone ? String(b.driverPhone).slice(0, 20) : null,
        note: b.note ? String(b.note).slice(0, 200) : null,
        by: "cashier",
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
    if (row.status !== next) await setStatus(row.order_no, next, { note: `يدوي: ${stage}` });
    return c.json({ ok: true, status: next, shipment: { status: shipment.status, ref: shipment.provider_ref } });
  });

  /* استرجاع بضغطة من اللوحة — لما التوصيل يتعثّر والقرار يبقى «رجّع فلوسه».
     أدمن بس: دي فلوس بتخرج، مش خطوة تشغيلية. */
  app.post("/api/shop/orders/:orderNo/refund", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const res = await refundOrder(row, String(b.reason || "refunded from dashboard").slice(0, 120));
    return c.json(res, res.ok ? 200 : 502);
  });

  /* أداء أكواد التحويل — قياس كارت «اطلب مباشرة» اللي بيتحط في طلبات
     تطبيقات التوصيل. طلبات التطبيقات بتوصل من غير رقم عميل، فالكود ده هو
     الجسر الوحيد بين عميل التطبيق والعميل المباشر. من غير الشاشة دي
     الكارت بيبقى صرف تاني من غير قياس. */
  app.get("/api/shop/coupons/performance", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `WITH used AS (
         SELECT coupon, phone_norm, total, created_at
           FROM shop_orders
          WHERE coupon IS NOT NULL AND status NOT IN ('pending_payment','expired')
       )
       SELECT u.coupon,
              count(*)::int                        AS redemptions,
              count(DISTINCT u.phone_norm)::int    AS customers,
              COALESCE(sum(u.total),0)::numeric    AS revenue,
              COALESCE(avg(u.total),0)::numeric    AS avg_order,
              min(u.created_at)                    AS first_use,
              max(u.created_at)                    AS last_use,
              -- عملاء رجعوا وطلبوا تاني من غير الكود = التحويل نجح فعلاً
              (SELECT count(DISTINCT o2.phone_norm)::int FROM shop_orders o2
                WHERE o2.phone_norm IN (SELECT phone_norm FROM used WHERE coupon = u.coupon)
                  AND (o2.coupon IS DISTINCT FROM u.coupon)
                  AND o2.status NOT IN ('pending_payment','expired')) AS repeat_customers
         FROM used u GROUP BY u.coupon ORDER BY redemptions DESC`)).rows;
    return c.json({
      ok: true,
      coupons: rows.map((r) => ({
        code: r.coupon, redemptions: r.redemptions, customers: r.customers,
        revenue: Number(r.revenue), avgOrder: Number(r.avg_order),
        repeatCustomers: r.repeat_customers,
        repeatRate: r.customers ? Math.round((r.repeat_customers / r.customers) * 100) : 0,
        firstUse: r.first_use, lastUse: r.last_use,
      })),
    });
  });

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
  /* المفاتيح دي بتغطي مصدرين: أسماء أحداث الويبهوك (driver_assigned…) وقيم
     الحالة اللي بترجع من GET /orders/{id} وقت الاستطلاع (in_transit…). */
  /* الحالات دي **موحّدة** جاية من طبقة المزوّدين (couriers.js)، مش بلغة
     شركة بعينها. ترجمة مصطلحات كل شركة بتحصل جوّاها، فلو بدّلنا من Flying
     Arrow لـ Leajlak الجدول ده ما يتغيّرش ولا العميل يحس بفرق.
     ولسه بنقبل الأسماء القديمة عشان ويبهوك متأخر من شحنة قديمة ما يضيعش. */
  const SHIP_STAGE = {
    // الموحّدة
    pending: null,                      // اتسجّل عندهم، لسه مفيش كابتن
    assigned: "courier_assigned",
    picked: "on_the_way",
    delivered: "delivered",
    cancelled: "courier_cancelled",
    // أسماء قديمة (Flying Arrow خام) — للتوافق مع صفوف قبل التوحيد
    created: null,
    confirmed: null,
    driver_assigned: "courier_assigned",
    accepted: "courier_assigned",
    pickup_completed: "on_the_way",
    picked_up: "on_the_way",
    in_transit: "on_the_way",
    on_the_way: "on_the_way",
    completed: "delivered",
    canceled: "courier_cancelled",
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

  /* ── تنفيذ الاسترجاع ──────────────────────────────────────────────────
     القرار في refundDecision (صافي ومُختبر)، والتنفيذ هنا. الفرق المهم عن
     النسخة القديمة: فشل الاسترجاع بيروح لحالة `refund_failed` مش
     `rejected_refunded`. الحالة القديمة كانت بتبعت للعميل رسالة «تم
     استرجاع المبلغ كاملاً لبطاقتك» وفلوسه لسه معانا. */
  async function refundOrder(row, reason) {
    if (!row) return { ok: false, error: "no_order" };
    const d = refundDecision(row);
    if (!d.act) {
      if (d.reason === "already_refunded") return { ok: true, skipped: d.reason };
      if (d.reason === "max_attempts") return { ok: false, error: "max_attempts" };
      // مفيش دفعة نسترجعها — الطلب بيتقفل من غير ما نوعد بفلوس
      await setStatus(row.order_no, "rejected_refunded", { note: `لا يوجد مبلغ للاسترجاع (${d.reason})` });
      return { ok: true, skipped: d.reason };
    }
    await pool.query("UPDATE shop_orders SET refund_attempts = refund_attempts + 1 WHERE order_no=$1",
      [row.order_no]);
    try {
      const ref = await pay.makeRefund({
        paymentId: d.paymentId, amount: d.amount,
        comment: `FreshCuts ${row.order_no} ${reason || "refund"}`,
      });
      await setStatus(row.order_no, "rejected_refunded", {
        cols: { refund_id: String(ref.RefundId ?? ref.RefundReference ?? "requested"), refund: jb(ref) },
      });
      return { ok: true, refundId: String(ref.RefundId ?? ref.RefundReference ?? "requested") };
    } catch (e) {
      console.error(`[shop] AUTO-REFUND FAILED for ${row.order_no}:`, e.message);
      await setStatus(row.order_no, "refund_failed", {
        note: `REFUND FAILED: ${e.message}`.slice(0, 300),
        cols: { refund: jb({ error: e.message, at: new Date().toISOString(), amount: d.amount }) },
      });
      return { ok: false, error: e.message };
    }
  }

  /* ── مراقب المهل: الطلبات اللي وقعت من إيد بني آدم ────────────────────
     بيلف على كل طلب حي، يسأل slaCheck عن درجته، وبيصعّد **مرة واحدة** لكل
     درجة (العمود alerts بيفتكر مين اتبعت). درجة 3 بتعمل تدخّل مالي. */
  async function watchdog() {
    const settings = await getSettingsData();
    const sla = (settings.delivery || {}).sla || {};
    const managers = ((settings.delivery || {}).alertPhones || [])
      .map((p) => normPhone(p)).filter((p) => /^5\d{8}$/.test(p));
    const autoRefundOn = (settings.delivery || {}).autoRefundOnNoAccept !== false;

    const rows = (await pool.query(
      `SELECT order_no, status, option, total, mf_payment_id, refund_id, refund_attempts,
              customer, alerts, created_at, updated_at
         FROM shop_orders
        WHERE status NOT IN ('pending_payment','expired','delivered','rejected_refunded')
          AND created_at > NOW() - INTERVAL '24 hours'`)).rows;

    for (const row of rows) {
      const v = slaCheck(row, sla);
      if (!v.level) continue;
      const seen = row.alerts || {};
      const key = `${v.code}:${v.level}`;
      if (seen[key]) continue;

      // نسجّل الإنذار الأول قبل أي تصعيد — لو التصعيد نفسه وقع، ما نكررش
      await pool.query(
        "UPDATE shop_orders SET alerts = COALESCE(alerts,'{}'::jsonb) || $2::jsonb WHERE order_no=$1",
        [row.order_no, jb({ [key]: new Date().toISOString() })]);

      if (v.level >= 2) {
        console.error(`[shop] SLA ${v.level} — ${row.order_no}: ${v.message}`);
        const text = `فريش كتس ⚠️ الطلب ${row.order_no}: ${v.message}`;
        for (const p of managers) {
          if (notify?.sendSmsTo) notify.sendSmsTo(p, text).catch((e) =>
            console.error("[shop] SLA sms failed:", e.message));
        }
      }
      if (v.level >= 3 && v.action === "auto_refund" && autoRefundOn) {
        /* المطعم ما قبلش الطلب خالص: مفيش أكل اتعمل ومفيش كابتن اتبعت،
           والعميل قاعد مستني على الفاضي. الاسترجاع هنا هو الصح.
           بنلغي الطلب من الـPOS الأول لو ينفع، وبعدين نسترجع. */
        console.error(`[shop] AUTO-REFUND (never accepted) — ${row.order_no}`);
        if (row.option === "delivery" && delivery.cancelShipment) {
          delivery.cancelShipment(row.order_no, `order ${row.order_no} never accepted`).catch(() => {});
        }
        await refundOrder(await getOrderRow(row.order_no), "never accepted by restaurant");
      }
    }
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
        /* الطبقة الأولى من طبقتين. البوابة الحقيقية جوّه delivery.dispatch()
           وبترمي في الوضع اليدوي مهما نادى عليها مين — دي بس بتمنع
           المحاولة أصلاً عشان ما نملاش اللوج بأخطاء متوقعة.
           لاحظ إن الشرط بقى «لازم auto» بدل «مش false»: الافتراضي القديم
           كان بيرسل لو الإعداد ناقص، والافتراضي دلوقتي بيسكت. */
        const autoOk = await delivery.canAutoDispatch();
        if (r.option === "delivery" && autoOk && settings.autoDispatch !== false) {
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
        // لو كنا طلبنا كابتن قبل الرفض، نلغي عندهم — رسوم الإلغاء أرخص من
        // توصيلة كاملة لطلب المطعم اعتذر عنه.
        if (r.option === "delivery" && delivery.cancelShipment) {
          delivery.cancelShipment(r.order_no, `order ${r.order_no} rejected by restaurant`)
            .catch((e) => console.error(`[shop] courier cancel failed for ${r.order_no}:`, e.message));
        }
        // Omar's rule: automatic refund, exactly once.
        await refundOrder(await getOrderRow(r.order_no), `rejected by cashier`);
      }
    }

    // 3) housekeeping: a payment session nobody completed.
    await pool.query(
      `UPDATE shop_orders SET status='expired', updated_at=NOW()
        WHERE status='pending_payment' AND created_at < NOW() - INTERVAL '6 hours'`);

    // 4) إعادة محاولة الاسترجاعات الفاشلة — لحد سقف المحاولات، وبعدين بشر.
    const stuckRefunds = (await pool.query(
      `SELECT * FROM shop_orders
        WHERE status='refund_failed' AND refund_attempts < 3
          AND created_at > NOW() - INTERVAL '48 hours'`)).rows;
    for (const row of stuckRefunds) await refundOrder(row, "retry after failure");

    // 5) شبكة الأمان: الطلبات اللي بني آدم اتأخر عليها.
    await watchdog().catch((e) => console.error("[shop] watchdog failed:", e.message));
  }

  const sweepSec = Number(env("SHOP_SWEEP_SECONDS", "120"));
  if (sweepSec > 0) {
    setInterval(() => sweep().catch((e) => console.error("[shop] sweep failed:", e.message)), sweepSec * 1000);
  }

  return { confirmOrder, onShipmentEvent, sweep, refundOrder, watchdog };
}
