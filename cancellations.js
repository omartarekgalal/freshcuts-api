/* ═══════════════════════════════════════════════════════════════════════════
   CR1 (عمر ١٧/١٠): «الإلغاءات والارتجاع بينزل في تسلسل الفاتورة — لازم نبقى عارفينه بشكل كامل».

   الملف ده بيجمّع كل إلغاء/ارتجاع من مصادره التلاتة في شكل واحد، بالأيام، عشان يبان جنب المبيعات:
     ١. نقطة البيع (ts_orders): صفوف `order_type` فيها Void (الطلب نفسه اتعمله فويد — بيفضل برقمه وتسلسله)
        أو Refund (صف ارتجاع)، وأي صف مجموعه بالسالب. تاب سينس مابتدّيش سبب — بنقول كده صراحة.
     ٢. الموقع (shop_orders): اعتذر المطعم واسترجعنا (rejected_refunded، فلوس ماي فاتورة رجعت)، الاسترجاع فشل
        (refund_failed — الفلوس لسه معانا ومستحقة للعميل)، انتهت صلاحيته من غير دفع (expired)، أو اتلغى. السبب من
        سجل الطلب (history) لو موجود.
     ٣. كيتا (keeta_payouts): اترجع بالكامل — **نفس قاعدة bizreports/finance بالحرف** (keetaReversed تحت: refunds غير
        فاضية AND part_refund = false؛ order_status 50 لوحده مش دليل) — أو ارتجاع جزئي (part_refund) — بسبب كيتا نفسه
        (applyReason) ومين المسؤول (merchantAtFault).

   القاعدة المهمة — «مش رقمين لنفس الطلب»:
     • الموقع: طلب الموقع لما الكاشير يرفضه بيتعمله فويد في نقطة البيع كمان. صف الفويد اللي رقمه =
       shop_orders.pos_tenant_order_id بيتعلّم «مرآة» ومابيتجمعش تاني (بيتحسب مرة واحدة تحت الموقع).
     • كيتا (مراجعة ١٧/١٠): طلب كيتا المرتجع بالكامل له صف في نقطة البيع برضه (keeta_payouts.order_id = ts_orders.order_id
       عن طريق فيدأس) — لو الكاشير عمله فويد/ارتجاع كمان كان بيتحسب مرتين (كيتا + فويد). دلوقتي بيتحسب مرة واحدة تحت كيتا،
       صف نقطة البيع بيتعلّم «مرآة» (mirrorSrc = keeta)، وصف كيتا شايل posMirror. المبلغ المخصوم = مجموع صف نقطة البيع
       (ده اللي bizreports شالته من المبيعات فعلاً؛ قيمة كيتا بتشمل رسوم توصيلها اللي ماكانتش مبيعاتنا) — وقيمة كيتا في orderValue.

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

/**
 * «اترجع بالكامل» على كيتا — نسخة JS حرفية من شرط keeta_reversed في bizreports.js (loadWindow SELECT) وSALES_ONLY في finance.js:
 *     EXISTS (SELECT 1 FROM keeta_payouts kp WHERE kp.order_id = o.order_id
 *               AND jsonb_array_length(COALESCE(kp.refunds,'[]'::jsonb)) > 0
 *               AND COALESCE(kp.part_refund, false) = false)
 * يعني: فيه صف ارتجاع واحد على الأقل، ومش معلّم «جزئي». order_status 50 لوحده مش بيدخل الطلب هنا (bizreports بيحسبه مبيعات)
 * — لو دخلناه كان الصافي هيختلف عن «مبيعات اليوم». cancellations.test.mjs فيه حارس بيقرا bizreports.js ويتأكد إن الشرط لسه زي ما هو.
 */
export function keetaReversed(k) {
  return Array.isArray(k?.refunds) && k.refunds.length > 0 && !k.part_refund;
}

const sid = (v) => (v == null ? "" : String(v));

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
 *  keeta: [{order_view_id, order_id, keeta_day, order_time, order_status, refunds, refunded_to_customer, refund_price, part_refund, product_price, customer_pay_total,
 *           pos?: {order_id, receipt, order_type, total}}]   ← صف نقطة البيع لنفس الطلب لو اتجاب (loadCancellations)
 */
export function summarize({ pos = [], web = [], keeta = [], salesRevenue = null, range = null } = {}) {
  const rows = [];
  const bucket = () => ({ n: 0, amount: 0 });
  const t = {
    pos: { voids: bucket(), refunds: bucket(), mirrors: 0, keetaMirrors: 0 },
    web: { refunded: bucket(), refundFailed: bucket(), expired: bucket(), cancelled: bucket() },
    keeta: { reversed: bucket(), partial: bucket(), posMirrors: 0 },
  };
  const add = (b, amt) => { b.n++; b.amount += amt; };

  /* مرآة كيتا ↔ نقطة البيع: طلب كيتا المرتجع بالكامل بنعرفه في نقطة البيع برقم الطلب (keeta_payouts.order_id) أو برقم الإيصال
     (لو الفويد اتسجّل بصف تاني بنفس الإيصال). صف الفويد/الارتجاع اللي بيطابق مابيتخصمش تاني. */
  const kRev = keeta.filter(keetaReversed);
  const kByOrder = new Map(), kByReceipt = new Map();
  for (const k of kRev) {
    if (sid(k.order_id)) kByOrder.set(sid(k.order_id), k);
    if (k.pos && sid(k.pos.receipt)) kByReceipt.set(sid(k.pos.receipt), k);
  }
  const posRowOfKeeta = new Map();   // order_view_id → صف نقطة البيع (فويد/ارتجاع) اللي اتعلّم مرآة

  for (const p of pos) {
    const kind = posKind(p); if (!kind) continue;
    const amt = Math.abs(num(p.total));
    const day = p.day || bizDay(p.ts);
    let mirrorOf = p.mirror_of || null, mirrorSrc = p.mirror_of ? "web" : null;
    if (!mirrorOf) {
      const km = kByOrder.get(sid(p.order_id)) || (sid(p.receipt) ? kByReceipt.get(sid(p.receipt)) : null);
      if (km && !posRowOfKeeta.has(sid(km.order_view_id || km.order_id))) {
        mirrorOf = sid(km.order_view_id || km.order_id); mirrorSrc = "keeta";
        posRowOfKeeta.set(mirrorOf, p);
      }
    }
    if (mirrorOf) { t.pos.mirrors++; if (mirrorSrc === "keeta") t.pos.keetaMirrors++; }
    else add(kind === "pos_void" ? t.pos.voids : t.pos.refunds, amt);
    rows.push({ src: "pos", kind, label: KIND_LABELS[kind], day, at: p.ts, ref: p.receipt || p.order_id, id: String(p.order_id),
      amount: r2(amt), option: p.order_option || null, staff: p.staff_name || null,
      reason: "السبب مش متاح من نقطة البيع (تاب سينس مابتسجّلش سبب الفويد)",
      mirrorOf, mirrorSrc, deducted: !mirrorOf });
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
    const reversed = keetaReversed(k);
    const partial = !reversed && (Boolean(k.part_refund) || num(k.refunded_to_customer) > 0 || num(k.refund_price) > 0);
    if (!reversed && !partial) continue;
    const kind = reversed ? "keeta_reversed" : "keeta_partial";
    const kid = sid(k.order_view_id || k.order_id);
    /* صف نقطة البيع لنفس الطلب: الفويد/الارتجاع اللي اتعلّم مرآة فوق، وإلا الصف العادي اللي loadCancellations جابه (k.pos) */
    const pm = reversed ? (posRowOfKeeta.get(kid) || k.pos || null) : null;
    const posMirror = pm ? { id: sid(pm.order_id), receipt: pm.receipt || null, orderType: pm.order_type || null, total: r2(Math.abs(num(pm.total))), voided: posKind(pm) != null } : null;
    if (posMirror) t.keeta.posMirrors++;
    const amt = reversed ? (posMirror && posMirror.total > 0 ? posMirror.total : keetaValue(k)) : (num(k.refunded_to_customer) || num(k.refund_price));
    add(reversed ? t.keeta.reversed : t.keeta.partial, amt);
    rows.push({ src: "keeta", kind, label: KIND_LABELS[kind], day: k.keeta_day ? String(k.keeta_day).slice(0, 10) : bizDay(k.order_time), at: k.order_time || null,
      ref: k.order_view_id || k.order_id, id: kid, amount: r2(amt), option: null, staff: null,
      reason: keetaReason(k), orderValue: r2(keetaValue(k)), posMirror, deducted: reversed });
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
      "طلب كيتا المرتجع بالكامل له صف في نقطة البيع برضه — بيتحسب مرة واحدة (تحت كيتا) بمجموع صف نقطة البيع (ده اللي اتشال من المبيعات)؛ لو الكاشير عمله فويد كمان، صف الفويد بيتعلّم «مرآة نقطة البيع» ومابيتخصمش تاني.",
      "«اترجع بالكامل» على كيتا = نفس قاعدة «مبيعات اليوم»: فيه صف ارتجاع ومش جزئي. ارتجاع كيتا الجزئي مش مخصوم من المبيعات (الطلب محسوب بمجموعه) — معروض لوحده. يوم كيتا = يوم فاتورتها (نص الليل)، مش اليوم التشغيلي.",
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
          AND (jsonb_array_length(COALESCE(refunds,'[]'::jsonb)) > 0 OR COALESCE(refunded_to_customer,0) > 0 OR COALESCE(refund_price,0) > 0 OR COALESCE(part_refund,false))
        ORDER BY order_time DESC LIMIT 2000`, [fromDay, toDay]).catch(() => ({ rows: [] })),
  ]);
  /* (أ) مرآة طلب الموقع في نقطة البيع (الفويد بعد الرفض) — مرة واحدة
     (ب) صف نقطة البيع لطلب كيتا المرتجع بالكامل (keeta_payouts.order_id = ts_orders.order_id عبر فيدأس) — عشان يتحسب مرة واحدة
         ولو الكاشير عمله فويد كمان (مرآة)؛ من غير قيد بالـcalendar_day لأنه نفس الطلب أياً كان يوم إقفاله */
  const ids = pos.rows.map((p) => String(p.order_id));
  const kids = [...new Set(keeta.rows.filter(keetaReversed).map((k) => sid(k.order_id)).filter(Boolean))];
  const [m, kp] = await Promise.all([
    ids.length ? pool.query(`SELECT order_no, pos_tenant_order_id::text AS pid FROM shop_orders WHERE pos_tenant_order_id::text = ANY($1::text[])`, [ids]).catch(() => ({ rows: [] })) : { rows: [] },
    kids.length ? pool.query(`SELECT order_id, receipt, order_type, total::float8 AS total FROM ts_orders WHERE order_id = ANY($1::text[])`, [kids]).catch(() => ({ rows: [] })) : { rows: [] },
  ]);
  const mirrors = new Map(m.rows.map((r) => [String(r.pid), r.order_no]));
  const posOfKeeta = new Map(kp.rows.map((r) => [String(r.order_id), r]));
  const posRows = pos.rows.map((p) => ({ ...p, day: dayOf(p), mirror_of: mirrors.get(String(p.order_id)) || null }));
  const webRows = web.rows.map((w) => ({ ...w, day: bizDay(w.ts) }));
  const keetaRows = keeta.rows.map((k) => ({ ...k, pos: posOfKeeta.get(sid(k.order_id)) || null }));
  return { pos: posRows, web: webRows, keeta: keetaRows };
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
