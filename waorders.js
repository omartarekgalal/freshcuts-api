/* ═══════════════════════════════════════════════════════════════════════════
   waorders.js — BF1 (١٩/١٠/٢٠٢٦): «العميل طلب خلاص؟» من كل القنوات — مراجعة ١٩/١٠ بند A

   الحادثة: ٧ رسايل بيع/اعتذار («أنا معك 🙂 قل لي كم شخص» ×٤، «وصلتنا رسالتك وما قدرنا نخدمك وقتها، نعتذر» ×٣) لعملاء طلبوا خلاص —
   ماجد والمتابعات كانوا بيبصّوا على shop_orders بس (طلب الموقع)، وطلب الكاشير/الصالة (نقطة البيع) مش شايفينه. و…0448 دفعت ٤٨ ر.س
   على الموقع قبل الاعتذار بـ٢٣ دقيقة و lead_followup مابصّش على الطلبات خالص.

   هنا الاستعلام الواحد اللي الكل بيستخدمه: طلب موقع مدفوع (يشمل طلب الطاولة/الصالة من الـQR — بيتسجّل في shop_orders) +
   طلب نقطة البيع (ts_orders) مربوط بالجوال عن طريق order_sources (الكاشير سجّله) أو ts_customers (عميل تاب سينس). الملغي/المرتجع/التجربة لأ.
   القاعدة ماردّتش ⇒ null (المنادي بيقفل: مانبعتش بيع لحد مانعرفش هو طلب ولا لأ).
═══════════════════════════════════════════════════════════════════════════ */
export const SITE_DONE = Object.freeze(["pending_payment", "expired", "rejected_refunded", "refund_failed", "cancelled", "canceled"]);
export const POS_NOT_VOID = (a) => `(${a}.order_type IS NULL OR (${a}.order_type NOT ILIKE '%void%' AND ${a}.order_type NOT ILIKE '%refund%'))`;
/* $1 الجوال (5XXXXXXXX) · $2 من امتى (timestamptz). الأحدث أولاً، لحد ٥. */
export const ORDERS_SINCE_SQL = `/*bf1:orders_since*/ SELECT * FROM (
    SELECT 'site'::text AS channel, so.order_no::text AS ref, so.created_at AS at, so.status::text AS status, so.option::text AS option, so.total::float AS total,
           NULLIF(to_jsonb(so)->>'table_no','') AS table_no, so.items AS items
      FROM shop_orders so
     WHERE so.phone_norm = $1 AND NOT COALESCE(so.is_test,false) AND so.status <> ALL($3::text[]) AND so.created_at > $2::timestamptz
    UNION ALL
    SELECT 'pos'::text, o.order_id::text, o.order_date, o.order_status::text, COALESCE(o.order_option, o.order_type)::text, o.total::float, NULL, NULL
      FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
     WHERE (s.phone_norm = $1 OR tc.phone_norm = $1) AND o.order_date > $2::timestamptz AND ${POS_NOT_VOID("o")}
  ) x ORDER BY at DESC LIMIT 5`;
/* أصناف طلب نقطة البيع (ts_order_items) — لإجابة «طلبي فيه رز؟» على طلب الكاشير */
export const POS_ITEMS_SQL = "/*bf1:pos_items*/ SELECT name, qty FROM ts_order_items WHERE order_id = $1 ORDER BY idx LIMIT 30";

/* أصناف طلب الموقع (shop_orders.items) ⇒ [{ name, qty, note? }] — الاسم اللي اتخزّن وقت الشيك أوت (product-names.js). */
export function siteItems(items) {
  const arr = Array.isArray(items) ? items : (() => { try { return JSON.parse(items || "[]"); } catch { return []; } })();
  return arr.filter((it) => it && typeof it === "object").slice(0, 30).map((it) => {
    const name = String(it.name || it.product_name || it.title || "").trim(), v = String(it.variant_name || "").trim();
    const note = String(it.note || it.customer_note || "").trim();
    return { name: [name, v].filter(Boolean).join(" — ").slice(0, 80) || null, qty: Number(it.quantity || it.qty) || 1, ...(note ? { note: note.slice(0, 80) } : {}) };
  }).filter((x) => x.name);
}

/* ⇒ مصفوفة الطلبات (فاضية = مفيش) أو null (مانعرفش) */
export async function ordersSince(q, phone, since) {
  if (!/^5\d{8}$/.test(String(phone || ""))) return [];
  const t = since instanceof Date ? since : new Date(since);
  if (!Number.isFinite(t.getTime())) return [];
  const r = await q(ORDERS_SINCE_SQL, [String(phone), t.toISOString(), [...SITE_DONE]]);
  if (r === null || r === undefined) return null;
  return (Array.isArray(r) ? r : []).filter((x) => x && x.ref).map((x) => ({ channel: x.channel === "pos" ? "pos" : "site", ref: String(x.ref), at: x.at ? new Date(x.at).toISOString() : null, status: x.status == null ? null : String(x.status),
    option: x.option || null, total: Number(x.total) || 0, ...(x.table_no ? { table: String(x.table_no) } : {}), items: x.channel === "site" ? siteItems(x.items) : null }));
}
/* آخر `hours` ساعة */
export const recentOrdersOf = (q, phone, now, hours) => ordersSince(q, phone, new Date((now instanceof Date ? now.getTime() : Number(now)) - Math.max(0.25, Number(hours) || 3) * 3600_000));

/* للمساعد: ملخص صغير (من غير مبالغ) — القناة، امتى من كام دقيقة، الحالة، والأصناف لو معروفة */
export function existingOrderBrief(orders, now, posItems = null) {
  const o = Array.isArray(orders) && orders[0] ? orders[0] : null;
  if (!o) return null;
  const mins = o.at ? Math.max(0, Math.round(((now instanceof Date ? now.getTime() : Number(now)) - Date.parse(o.at)) / 60_000)) : null;
  const where = o.channel === "pos" ? "at the branch (cashier / dine-in / phone)" : o.table ? `dine-in table ${o.table} (QR)` : o.option === "pickup" ? "website, pickup" : "website, delivery";
  const items = o.channel === "site" ? o.items : Array.isArray(posItems) ? posItems.map((x) => ({ name: String(x.name || "").slice(0, 80), qty: Number(x.qty) || 1 })).filter((x) => x.name) : null;
  return { placed: where, minutes_ago: mins, ...(o.channel === "site" ? { order_no: o.ref, status: o.status } : {}), ...(items && items.length ? { items } : {}), count_last_hours: orders.length };
}
