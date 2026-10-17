/* ═══════════════════════════════════════════════════════════════════════════
   CR1 (عمر ١٧/١٠): «الإلغاءات والارتجاع بينزل في تسلسل الفاتورة — لازم نبقى عارفينه بشكل كامل».

   الملف ده بيجمّع كل إلغاء/ارتجاع من مصادره التلاتة في شكل واحد، بالأيام، عشان يبان جنب المبيعات:
     ١. نقطة البيع (ts_orders): صفوف `order_type` فيها Void (الطلب نفسه اتعمله فويد — بيفضل برقمه وتسلسله)
        أو Refund (صف ارتجاع)، وأي صف مجموعه بالسالب. تاب سينس مابتدّيش سبب — بنقول كده صراحة.
     ٢. الموقع (shop_orders): اعتذر المطعم واسترجعنا (rejected_refunded، فلوس ماي فاتورة رجعت)، الاسترجاع فشل
        (refund_failed — الفلوس لسه معانا ومستحقة للعميل)، انتهت صلاحيته من غير دفع (expired)، أو اتلغى. السبب من
        سجل الطلب (history) لو موجود.
     ٣. كيتا (keeta_payouts): اترجع بالكامل (order_status 50 — برّه التسوية كلها) أو ارتجاع جزئي (part_refund) — بسبب
        كيتا نفسه (applyReason) ومين المسؤول (merchantAtFault).

   القاعدة المهمة — «مش رقمين لنفس الطلب»: طلب الموقع لما الكاشير يرفضه بيتعمله فويد في نقطة البيع كمان. صف الفويد
   اللي رقمه = shop_orders.pos_tenant_order_id بيتعلّم «مرآة» ومابيتجمعش تاني (بيتحسب مرة واحدة تحت الموقع).

   «قبل الإلغاءات → الإلغاءات → الصافي»: الصافي = مبيعات bizreports زي ما هي (الفويد/الارتجاع/كيتا المرتجع بالكامل
   مش جوّاها أصلاً). «قبل» = الصافي + اللي اتشال منه. الارتجاع الجزئي من كيتا **مش مخصوم** من المبيعات (الطلب بيتحسب
   بمجموعه) والاسترجاع الفاشل لسه فلوسه معانا — بنعرضهم لوحدهم بعنوان واضح، مش جوّه الخصم.

   المسار: GET /api/reports/biz/cancellations ?preset|from&to (admin، قراءة بس) — نفس فترات «مبيعات اليوم».
═══════════════════════════════════════════════════════════════════════════ */
import { bizDay, bizRange, rangeJson } from "./bizday.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;

export const WEB_STATUSES = Object.freeze(["expired", "rejected_refunded", "refund_failed", "cancelled", "canceled", "payment_failed", "failed"]);

export const KIND_LABELS = Object.freeze({
  pos_void: "فويد (إلغاء) من نقطة البيع",
  pos_refund: "ارتجاع من نقطة البيع",
  web_refunded: "طلب موقع — اعتذر المطعم واسترجعنا المبلغ",
  web_refund_failed: "طلب موقع — الاسترجاع فشل (يدوي من ماي فاتورة)",
  web_expired: "طلب موقع — ماتدفعش (انتهت صلاحيته)",
  web_cancelled: "طلب موقع — اتلغى",
  keeta_reversed: "كيتا — اترجع بالكامل",
  keeta_partial: "كيتا — ارتجاع جزئي",
});

/* أسباب الموقع اللي الكود بيكتبها بالإنجليزي في history → عربي للموظفين */
const WEB_REASONS = [
  [/never accepted/i, "ماتقبلش من المطعم خالص — استرجاع تلقائي"],
  [/rejected by cashier/i, "الكاشير رفض الطلب من نقطة البيع"],
  [/refunded from dashboard/i, "استرجاع من اللوحة"],
  [/retry after failure/i, "إعادة محاولة الاسترجاع بعد فشل"],
  [/REFUND FAILED/i, "فشل الاسترجاع عند ماي فاتورة"],
  [/لا يوجد مبلغ/, "مفيش مبلغ يتسترجع"],
];
export function webReason(row) {
  const hist = Array.isArray(row.history) ? row.history : [];
  const last = [...hist].reverse().find((h) => h && h.status === row.status) || hist.at(-1) || {};
  const note = String(last.note || "").trim();
  if (row.status === "expired") return "العميل ماكمّلش الدفع";
  if (!note) return row.status === "rejected_refunded" ? "اعتذر المطعم" : null;
  for (const [re, ar] of WEB_REASONS) if (re.test(note)) return ar;
  return note.slice(0, 160);
}

export function webKind(status) {
  if (status === "rejected_refunded") return "web_refunded";
  if (status === "refund_failed") return "web_refund_failed";
  if (status === "expired") return "web_expired";
  return "web_cancelled";
}

export function posKind(row) {
  const t = String(row.order_type || "").toLowerCase();
  if (t.includes("void")) return "pos_void";
  if (t.includes("refund") || num(row.total) < 0) return "pos_refund";
  return null;
}

/* قيمة الطلب على كيتا لما نعرض «اترجع بالكامل»: اللي دفعه العميل لو موجود، وإلا سعر المنتجات */
const keetaValue = (r) => (num(r.customer_pay_total) > 0 ? num(r.customer_pay_total) : num(r.product_price));

export function keetaReason(r) {
  const ev = Array.isArray(r.refunds) ? r.refunds : [];
  const why = ev.map((e) => String(e?.reason || "").trim()).filter(Boolean)[0] || null;
  const fault = ev.some((e) => e?.merchantAtFault);
  const parts = [];
  if (why) parts.push(why.slice(0, 120));
  parts.push(fault ? "على حساب المطعم" : ev.length ? "مش على حساب المطعم" : "السبب مش في بيانات كيتا");
  return parts.join(" — ");
}

/**
 * يحوّل الصفوف الخام لقايمة موحّدة + مجاميع. صافية ومتختبرة.
 *  pos:   [{order_id, receipt, ts, day, order_type, order_option, total, staff_name, mirror_of}]
 *  web:   [{order_no, ts, status, option, total, refund, history, is_test}]
 *  keeta: [{order_view_id, order_id, keeta_day, order_time, order_status, refunds, refunded_to_customer, refund_price, part_refund, product_price, customer_pay_total}]
 */
export function summarize({ pos = [], web = [], keeta = [], salesRevenue = null, range = null } = {}) {
  const rows = [];
  const bucket = () => ({ n: 0, amount: 0 });
  const t = {
    pos: { voids: bucket(), refunds: bucket(), mirrors: 0 },
    web: { refunded: bucket(), refundFailed: bucket(), expired: bucket(), cancelled: bucket() },
    keeta: { reversed: bucket(), partial: bucket() },
  };
  const add = (b, amt) => { b.n++; b.amount += amt; };

  for (const p of pos) {
    const kind = posKind(p); if (!kind) continue;
    const amt = Math.abs(num(p.total));
    const day = p.day || bizDay(p.ts);
    if (p.mirror_of) { t.pos.mirrors++; }
    else add(kind === "pos_void" ? t.pos.voids : t.pos.refunds, amt);
    rows.push({ src: "pos", kind, label: KIND_LABELS[kind], day, at: p.ts, ref: p.receipt || p.order_id, id: String(p.order_id),
      amount: r2(amt), option: p.order_option || null, staff: p.staff_name || null,
      reason: "السبب مش متاح من نقطة البيع (تاب سينس مابتسجّلش سبب الفويد)",
      mirrorOf: p.mirror_of || null, deducted: !p.mirror_of });
  }
  for (const w of web) {
    if (w.is_test) continue;
    const kind = webKind(w.status);
    const amt = num(w.total);
    const b = kind === "web_refunded" ? t.web.refunded : kind === "web_refund_failed" ? t.web.refundFailed : kind === "web_expired" ? t.web.expired : t.web.cancelled;
    add(b, amt);
    const paid = kind === "web_refunded" || kind === "web_refund_failed";
    rows.push({ src: "web", kind, label: KIND_LABELS[kind], day: w.day || bizDay(w.ts), at: w.ts, ref: w.order_no, id: w.order_no,
      amount: r2(amt), option: w.option || null, staff: null, reason: webReason(w),
      refundId: w.refund_id || null, paid, deducted: kind === "web_refunded" });
  }
  for (const k of keeta) {
    const reversed = Number(k.order_status) === 50 || (!k.part_refund && Array.isArray(k.refunds) && k.refunds.length > 0);
    const partial = !reversed && (Boolean(k.part_refund) || num(k.refunded_to_customer) > 0 || num(k.refund_price) > 0);
    if (!reversed && !partial) continue;
    const kind = reversed ? "keeta_reversed" : "keeta_partial";
    const amt = reversed ? keetaValue(k) : (num(k.refunded_to_customer) || num(k.refund_price));
    add(reversed ? t.keeta.reversed : t.keeta.partial, amt);
    rows.push({ src: "keeta", kind, label: KIND_LABELS[kind], day: k.keeta_day ? String(k.keeta_day).slice(0, 10) : bizDay(k.order_time), at: k.order_time || null,
      ref: k.order_view_id || k.order_id, id: String(k.order_view_id || k.order_id), amount: r2(amt), option: null, staff: null,
      reason: keetaReason(k), orderValue: r2(keetaValue(k)), deducted: reversed });
  }
  rows.sort((a, b) => String(b.at || b.day).localeCompare(String(a.at || a.day)));
  for (const g of Object.values(t)) for (const b of Object.values(g)) if (b && typeof b === "object") b.amount = r2(b.amount);

  /* اللي اتشال فعلاً من المبيعات (فويد/ارتجاع نقطة البيع من غير المرايا + الموقع المسترجع + كيتا المرتجع بالكامل) */
  const deducted = r2(t.pos.voids.amount + t.pos.refunds.amount + t.web.refunded.amount + t.keeta.reversed.amount);
  const deductedN = t.pos.voids.n + t.pos.refunds.n + t.web.refunded.n + t.keeta.reversed.n;
  const notDeducted = r2(t.keeta.partial.amount);              // الطلب لسه محسوب بمجموعه في المبيعات
  const owed = r2(t.web.refundFailed.amount);                  // فلوس عميل لسه معانا
  const unpaid = r2(t.web.expired.amount + t.web.cancelled.amount);   // ماكانتش فلوس أصلاً
  const days = {};
  for (const r of rows) {
    const d = days[r.day] || (days[r.day] = { day: r.day, n: 0, deducted: 0, posVoids: 0, posRefunds: 0, webRefunded: 0, webExpired: 0, keeta: 0 });
    d.n++;
    if (r.deducted) d.deducted = r2(d.deducted + r.amount);
    if (r.kind === "pos_void" && !r.mirrorOf) d.posVoids = r2(d.posVoids + r.amount);
    if (r.kind === "pos_refund" && !r.mirrorOf) d.posRefunds = r2(d.posRefunds + r.amount);
    if (r.kind === "web_refunded") d.webRefunded = r2(d.webRefunded + r.amount);
    if (r.kind === "web_expired" || r.kind === "web_cancelled") d.webExpired = r2(d.webExpired + r.amount);
    if (r.src === "keeta") d.keeta = r2(d.keeta + r.amount);
  }
  const net = salesRevenue == null ? null : r2(salesRevenue);
  return {
    totals: {
      ...t,
      deducted, deductedN, notDeducted, owed, unpaid,
      net, gross: net == null ? null : r2(net + deducted),
      rate: net == null || net + deducted === 0 ? null : Math.round((deducted / (net + deducted)) * 10000) / 10000,
    },
    days: Object.values(days).sort((a, b) => (a.day < b.day ? 1 : -1)),
    rows,
    range: range || null,
    notes: [
      "الصافي = «مبيعات اليوم» زي ما هي (إقفال الكاشير). «قبل الإلغاءات» = الصافي + اللي اتشال منه: فويد وارتجاع نقطة البيع، طلبات الموقع المسترجعة، وطلبات كيتا المرتجعة بالكامل.",
      "طلب الموقع لما يترفض بيتعمله فويد في نقطة البيع كمان — بيتحسب مرة واحدة (تحت الموقع)، وصف الفويد بيتعلّم «مرآة».",
      "ارتجاع كيتا الجزئي مش مخصوم من المبيعات (الطلب محسوب بمجموعه) — معروض لوحده. يوم كيتا = يوم فاتورتها (نص الليل)، مش اليوم التشغيلي.",
      "«ماتدفعش» = طلبات موقع انتهت قبل الدفع — ماكانتش فلوس، للمتابعة بس.",
      "تاب سينس مابتسجّلش سبب الفويد؛ السبب موجود للموقع (سجل الطلب) ولكيتا (سبب كيتا + على حساب مين).",
    ],
  };
}

/* ── التحميل من القاعدة لنافذة ─────────────────────────────────────────── */
export async function loadCancellations(pool, { startUtc, endUtc }) {
  const fromDay = bizDay(startUtc), toDay = bizDay(new Date(endUtc.getTime() - 1));
  const [pos, web, keeta] = await Promise.all([
    pool.query(
      `SELECT o.order_id, o.receipt, o.order_date AS ts, o.calendar_day, o.order_type, o.order_option, o.total, o.staff_name
         FROM ts_orders o
        WHERE o.calendar_day >= $2::date AND o.calendar_day <= $3::date AND o.order_date < $1
          AND (o.order_type ILIKE '%void%' OR o.order_type ILIKE '%refund%' OR o.total < 0)
        ORDER BY o.order_date DESC LIMIT 2000`, [endUtc, fromDay, toDay]),
    pool.query(
      `SELECT so.order_no, so.created_at AS ts, so.status, so.option, so.total, so.refund_id, so.refund, so.history, so.is_test
         FROM shop_orders so
        WHERE so.created_at >= $1 AND so.created_at < $2 AND so.status = ANY($3::text[])
        ORDER BY so.created_at DESC LIMIT 2000`, [startUtc, endUtc, WEB_STATUSES]),
    pool.query(
      `SELECT order_view_id, order_id, keeta_day::text AS keeta_day, order_time, order_status, refunds,
              refunded_to_customer::float8 AS refunded_to_customer, refund_price::float8 AS refund_price, part_refund,
              product_price::float8 AS product_price, customer_pay_total::float8 AS customer_pay_total
         FROM keeta_payouts
        WHERE keeta_day >= $1::date AND keeta_day <= $2::date
          AND (order_status = 50 OR jsonb_array_length(COALESCE(refunds,'[]'::jsonb)) > 0 OR COALESCE(refund_price,0) > 0 OR COALESCE(part_refund,false))
        ORDER BY order_time DESC LIMIT 2000`, [fromDay, toDay]).catch(() => ({ rows: [] })),
  ]);
  /* مرآة طلب الموقع في نقطة البيع (الفويد بعد الرفض) — مرة واحدة */
  const ids = pos.rows.map((p) => String(p.order_id));
  let mirrors = new Map();
  if (ids.length) {
    const m = await pool.query(`SELECT order_no, pos_tenant_order_id::text AS pid FROM shop_orders WHERE pos_tenant_order_id::text = ANY($1::text[])`, [ids]).catch(() => ({ rows: [] }));
    mirrors = new Map(m.rows.map((r) => [String(r.pid), r.order_no]));
  }
  const posRows = pos.rows.map((p) => ({ ...p, day: dayOf(p), mirror_of: mirrors.get(String(p.order_id)) || null }));
  const webRows = web.rows.map((w) => ({ ...w, day: bizDay(w.ts) }));
  return { pos: posRows, web: webRows, keeta: keeta.rows };
}
function dayOf(p) {
  const c = p.calendar_day;
  if (c instanceof Date && !isNaN(c)) { const z = new Date(c.getTime() - c.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); }
  if (typeof c === "string" && /^\d{4}-\d{2}-\d{2}/.test(c)) return c.slice(0, 10);
  return bizDay(p.ts);
}

/** للاستعمال من bizreports (نفس النافذة): مجاميع + صفوف — مابيرميش. */
export async function cancellationsInWindow(pool, { startUtc, endUtc, salesRevenue = null, range = null }) {
  try {
    const raw = await loadCancellations(pool, { startUtc, endUtc });
    return summarize({ ...raw, salesRevenue, range });
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 200), totals: null, days: [], rows: [] };
  }
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const biz = () => (typeof deps.biz === "function" ? deps.biz() : deps.biz) || null;
  app.get("/api/reports/biz/cancellations", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const b = biz();
      const cfg = b ? await b.settings() : { weekStart: undefined };
      const range = bizRange({ preset: c.req.query("preset"), from: c.req.query("from") || c.req.query("date"), to: c.req.query("to") || c.req.query("date"), weekStart: cfg.weekStart });
      let salesRevenue = null;
      if (b && c.req.query("sales") !== "0") {
        try { const d = await b.salesData(range, cfg); salesRevenue = d.totals.revenue; } catch { salesRevenue = null; }
      }
      const out = await cancellationsInWindow(pool, { startUtc: range.startUtc, endUtc: range.cutUtc, salesRevenue, range: rangeJson(range) });
      return c.json({ ok: !out.error, ...out, kinds: KIND_LABELS });
    } catch (e) {
      console.error("[cancellations]", e.message);
      return c.json({ ok: false, error: e.message });
    }
  });
  return { cancellationsInWindow: (o) => cancellationsInWindow(pool, o), summarize };
}

export default { register };
