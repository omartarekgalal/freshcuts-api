/* ═══════════════════════════════════════════════════════════════════════════
   COUPON RULES — قواعد صلاحية كوبونات المتجر في مكان واحد (٥/١٠/٢٠٢٦)

   قرار عمر (٥/١٠): «FIRST = توصيل مجاني على أول طلب **توصيل**». اللي أكل في
   الصالة (طاولة) أو استلم من الفرع قبل كده لسه ياخد FIRST على أول توصيل —
   ده أقوى تحويل من الصالة للتوصيل. ومن غير ما يتساب للاستغلال:
     • FIRST مرة واحدة لكل جوال (على طلب توصيل).
     • FIRST مرفوض لو الجوال عنده طلب توصيل مدفوع من الموقع قبل كده.
     • الحد الأدنى بتاعه (٦٠) من الكوبون نفسه زي أي كوبون.
   و«مرة لكل عميل» لكوبون توصيل مجاني صِرف (FIRST، الولاء، WB…) بتتعدّ على
   طلبات التوصيل بس: الكود ده مالوش قيمة على استلام/طاولة (السيرفر بيشيله
   هناك أصلاً)، فطلب استلام قديم اتسجّل عليه الكود قبل الإصلاح مايحرقهوش.

   الدوال هنا pure + استعلامات بتتحقن (q) عشان الاختبار من غير قاعدة بيانات.
═══════════════════════════════════════════════════════════════════════════ */
import { shopPaidSql } from "./identity.js";

export const FIRST_CODE = "FIRST";
export const isFirstCode = (code) => String(code || "").trim().toUpperCase() === FIRST_CODE;

/* كوبون توصيل مجاني «صِرف»: بيتنازل عن الرسم ومالوش نسبة خصم */
export const isPureFreeDelivery = (cp) => Boolean(cp) && cp.free_delivery === true && !(Number(cp.percent) > 0);

/* «اتستخدم قبل كده» على الرقم ده. pureFree ⇒ طلبات التوصيل بس. */
export const usedOnceSql = (pureFree) =>
  `SELECT 1 FROM shop_orders
    WHERE coupon=$1 AND phone_norm=$2 AND status NOT IN ('pending_payment','expired')
      ${pureFree ? "AND option='delivery'" : ""} LIMIT 1`;

/* طلب توصيل «حقيقي» من الموقع قبل كده (اتدفع، مش تجربة، الفلوس مارجعتش) */
export const PRIOR_DELIVERY_SQL =
  `SELECT 1 FROM shop_orders so WHERE so.phone_norm=$1 AND so.option='delivery' AND ${shopPaidSql("so")} LIMIT 1`;

/* استعلامات حقيقية فوق pool — نفس الشكل اللي evaluateCoupon/firstEligibility مستنياه */
export function couponQueries(pool) {
  return {
    usedOnce: async (code, pn, pureFree) => (await pool.query(usedOnceSql(pureFree), [code, pn])).rowCount > 0,
    priorDelivery: async (pn) => (await pool.query(PRIOR_DELIVERY_SQL, [pn])).rowCount > 0,
  };
}

const todayStart = (now) => new Date(new Date(now).toDateString());

/* صف shop_coupons ← نتيجة التحقق. نفس أشكال الأخطاء القديمة بالظبط (المتجر
   الحي بيقرأها): not_found / expired / maxed / min_total / already_used.
   FIRST لجوال عنده توصيل قبل كده = already_used + reason:"prior_delivery"
   (النسخة القديمة من المتجر بتشيل FIRST التلقائي بهدوء على already_used). */
export async function evaluateCoupon(cp, { subtotal = 0, phoneNorm = null, now = new Date() } = {}, q) {
  if (!cp.active) return { ok: false, error: "not_found" };
  if (cp.expires_at && new Date(cp.expires_at) < todayStart(now)) return { ok: false, error: "expired" };
  if (cp.max_uses != null && Number(cp.used_count) >= Number(cp.max_uses)) return { ok: false, error: "maxed" };
  if (Number(subtotal) < Number(cp.min_total)) return { ok: false, error: "min_total", minTotal: Number(cp.min_total) };
  // كوبون شخصي: جوال تاني = كأنه مش موجود. من غير جوال (معاينة السلة) بنسيبه،
  // والشيك أوت (بجوال متأكد بالـOTP) هو اللي بيحسم.
  if (cp.phone_norm && phoneNorm && cp.phone_norm !== phoneNorm) return { ok: false, error: "not_found" };
  const pureFree = isPureFreeDelivery(cp);
  if (cp.once_per_customer && phoneNorm && q && (await q.usedOnce(cp.code, phoneNorm, pureFree))) {
    return { ok: false, error: "already_used" };
  }
  if (isFirstCode(cp.code) && phoneNorm && q && (await q.priorDelivery(phoneNorm))) {
    return { ok: false, error: "already_used", reason: "prior_delivery" };
  }
  // minTotal: المتجر بيراجع الكوبون مع كل تغيير في السلة (P1 ١٠/١٠) — تحت الحد ⇒ معلّق
  return { ok: true, code: cp.code, percent: Number(cp.percent) || 0, freeDelivery: cp.free_delivery === true, kind: "coupon",
    minTotal: Number(cp.min_total) || 0 };
}

/* هل الجوال ده مؤهل لـFIRST؟ (الأتمتة/السلة المتروكة/الحساب بيسألوا هنا) —
   firstRow = صف FIRST من shop_coupons أو null. */
export async function firstEligibility(firstRow, phoneNorm, q, now = new Date()) {
  if (!firstRow || firstRow.active === false) return { eligible: false, reason: "inactive" };
  if (firstRow.expires_at && new Date(firstRow.expires_at) < todayStart(now)) return { eligible: false, reason: "expired" };
  if (!phoneNorm) return { eligible: true, reason: null };
  if (await q.usedOnce(firstRow.code || FIRST_CODE, phoneNorm, isPureFreeDelivery(firstRow))) return { eligible: false, reason: "used" };
  if (await q.priorDelivery(phoneNorm)) return { eligible: false, reason: "prior_delivery" };
  return { eligible: true, reason: null };
}
