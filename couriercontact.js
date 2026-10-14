/* ═══════════════════════════════════════════════════════════════════════════
   SB5 — «راسل المندوب على واتساب» في رسالة «طلبك مع المندوب» (عمر ١٤/١٠: «في رسالة المندوب في الطريق يكون فيها بيانات المندوب وامكانية انه يتواصل معاه واتساب»)

   اللي عندنا عن المندوب: dl_shipments.driver = { name, phone, location } (لاجلك، كل دقيقة من الاستعلام) أو { name, phone, source } (Cervo / مندوب خارجي / يدوي).
   مفيش نوع مركبة ولا لوحة عند أي مزوّد. (عدّ آخر ١٠٠ شحنة ١٤/١٠: لاجلك ٩٣ منهم ٩٠ فيها اسم+جوال، خارجي ٧ منهم ٦ فيها جوال.)

   الرابط اللي العميل بيضغطه مابيحملش رقم المندوب: freshcuts-api…/api/shop/courier-chat/<رقم الطلب>-<توقيع> ⇒ ٣٠٢ لـ wa.me/<رقم المندوب>?text=<«معك عميل فريش كاتس، طلب رقم …»>
   — بس والطلب مع المندوب لسه (مُعيَّن / في الطريق). بعد التسليم أو الإلغاء ⇒ صفحة تتبّع الطلب (الرابط بيموت لوحده). التوقيع HMAC بسر السيرفر، فمحدش يقدر يولّد رابط لطلب تاني.
   رقم العميل مابيتبعتش لأي حد من هنا: العميل هو اللي بيفتح المحادثة من جواله لو حب (والمندوب عنده رقمه أصلاً من طلب التوصيل).
═══════════════════════════════════════════════════════════════════════════ */
import { createHmac, timingSafeEqual } from "node:crypto";

const STORE = "https://freshcuts.sa";
/* زر القالب لازم على دومين المتجر (قاعدة القوالب الخدمية: أزرارها على freshcuts.sa). freshcuts.sa/m/<توقيع> بيتحوّل لنفس المسار ده — محتاج سطر تحويل في المتجر
   (server.py: /m/<tok> ⇒ ٣٠٢ لـ COURIER_CHAT_BASE+tok) قبل تشغيل القالب. الرسالة الحرة جوّه النافذة بتستخدم رابط الـAPI مباشرة (شغّال من غير المتجر ولا ميتا). */
export const COURIER_TEMPLATE_BASE = "https://freshcuts.sa/m/";
export const COURIER_CHAT_BASE = String(process.env.PUBLIC_API_BASE || "https://freshcuts-api.o2m8.me").replace(/\/+$/, "") + "/api/shop/courier-chat/";
const secret = () => String(process.env.SECRETS_KEY || process.env.ADMIN_TOKEN || "fc-courier-chat");
const sigOf = (orderNo) => createHmac("sha256", secret()).update(`courier-chat:${orderNo}`).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
/* «W179…-sig» — حروف رابط آمنة بس (شرط ميتا للاحقة الزر الديناميكي) */
export const courierToken = (orderNo) => (/^[A-Za-z0-9-]{3,30}$/.test(String(orderNo || "")) ? `${orderNo}.${sigOf(orderNo)}` : null);
export function verifyCourierToken(tok) {
  const m = /^([A-Za-z0-9-]{3,30})\.([A-Za-z0-9]{12})$/.exec(String(tok || ""));
  if (!m) return null;
  const a = Buffer.from(m[2]), b = Buffer.from(sigOf(m[1]));
  return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
}
/* جوال المندوب ⇒ رقم wa.me (سعودي 05… / 5… / 9665… ⇒ 9665…؛ غير كده أرقام دولية ٩–١٥ رقم). مش صالح ⇒ null */
export function courierWaNumber(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (/^05\d{8}$/.test(d)) d = `966${d.slice(1)}`; else if (/^5\d{8}$/.test(d)) d = `966${d}`; else if (/^00/.test(d)) d = d.slice(2);
  return /^\d{9,15}$/.test(d) ? d : null;
}
/* اسم المندوب الأول بس، حروف بس (٢–١٥) — غير كده null (الرسالة بتطلع من غير اسم) */
export function courierFirstName(name) {
  const f = String(name || "").trim().split(/\s+/)[0] || "";
  return /^[\p{L}]{2,15}$/u.test(f) && !/^(test|تجربه|تجربة|driver|captain|مندوب|كابتن)$/i.test(f) ? f : null;
}
/* driver (من dl_shipments) ⇒ { first_name, wa, link } أو null */
export function courierOf(driver, orderNo) {
  let d = driver; if (typeof d === "string") { try { d = JSON.parse(d); } catch { d = null; } }
  if (!d || typeof d !== "object") return null;
  const wa = courierWaNumber(d.phone || d.mobile || d.driver_phone || d.driverMobile), first = courierFirstName(d.name || d.driver_name || d.driverName);
  if (!wa && !first) return null;
  return { first_name: first, wa, link: wa ? courierToken(orderNo) : null };
}
export const courierChatUrl = (orderNo) => { const t = courierToken(orderNo); return t ? `${COURIER_CHAT_BASE}${t}` : null; };

export function register(app, ctx) {
  const { pool } = ctx;
  app.get("/api/shop/courier-chat/:tok", async (c) => {
    const orderNo = verifyCourierToken(c.req.param("tok"));
    if (!orderNo) return c.redirect(STORE, 302);
    const track = `${STORE}/track/${encodeURIComponent(orderNo)}`;
    try {
      const r = await pool.query(`SELECT o.status, s.driver FROM shop_orders o LEFT JOIN LATERAL (SELECT driver FROM dl_shipments WHERE shop_order_no=o.order_no ORDER BY id DESC LIMIT 1) s ON TRUE WHERE o.order_no=$1`, [orderNo]);
      const row = r.rows && r.rows[0];
      if (!row || !["courier_assigned", "on_the_way"].includes(String(row.status))) return c.redirect(track, 302);      // التسليم / الإلغاء ⇒ الرابط ميت
      const co = courierOf(row.driver, orderNo);
      if (!co || !co.wa) return c.redirect(track, 302);
      const text = encodeURIComponent(`مرحبا، معك عميل فريش كاتس — طلب رقم ${orderNo}`);
      return c.redirect(`https://wa.me/${co.wa}?text=${text}`, 302);
    } catch { return c.redirect(track, 302); }
  });
}
