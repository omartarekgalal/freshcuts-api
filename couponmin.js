/* الحد الأدنى للكوبون — قاعدة واحدة للسيرفر كله (مراجعة عمر ١٠/١٠).
   • كوبون (FIRST / مكافأة ولاء / أي free_delivery) مايتطبّقش ولا يتنازل عن رسم التوصيل
     طول ما الإجمالي المؤهَّل (أكل بعد الخصم، من غير التوصيل) أقل من min_total.
   • السيرفر هو الحكم: الواجهة بتعرض «باقي X» بس، والرقم اللي بيتحصّل بيتحسب هنا.
   • مكافأة الولاء لها حد أدنى (قرار عمر ١٠/١٠) — settings.cms.loyalty.minTotal، الافتراضي ٦٠. */
export const LOYALTY_MIN_DEFAULT = 60;

export function loyaltyMinTotal(cfg) {
  const raw = cfg && cfg.minTotal;
  if (raw === undefined || raw === null || raw === "") return LOYALTY_MIN_DEFAULT;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return LOYALTY_MIN_DEFAULT;
  return Math.min(1000, Math.max(0, n));
}

/* cp = صف shop_coupons أو نتيجة checkCoupon ({minTotal}) */
export function couponMinState(cp, subtotal) {
  const min = Number(cp && (cp.minTotal ?? cp.min_total)) || 0;
  const sub = Number(subtotal) || 0;
  if (!(min > 0) || sub + 1e-9 >= min) return { ok: true, minTotal: min, gap: 0 };
  return { ok: false, minTotal: min, gap: Math.round((min - sub) * 100) / 100 };
}

/* رسم التوصيل بعد كوبون «توصيل مجاني». keep = الجزء اللي الكوبون مابيلمسهوش
   (رسم المسافة الإضافية / التوصيل بالحي). تحت الحد الأدنى: مفيش تنازل أبداً. */
export function feeAfterCoupon({ fee, keep = 0, coupon, foodTotal }) {
  const f = Number(fee) || 0, k = Number(keep) || 0;
  if (!(coupon && coupon.ok && coupon.freeDelivery) || !(f > 0)) return { fee: f, waived: false };
  if (!couponMinState(coupon, foodTotal).ok) return { fee: f, waived: false };
  if (f > k) return { fee: k, waived: true };
  return { fee: f, waived: false };
}

/* مكافآت الولاء اللي لسه ماتستخدمتش بتمشي على الحد الحالي (الجديد والقديم) */
export const LOYALTY_MIN_BACKFILL_SQL =
  `UPDATE shop_coupons s SET min_total = $1
     FROM cms_loyalty l
    WHERE l.coupon = s.code AND COALESCE(s.used_count,0) = 0 AND s.min_total IS DISTINCT FROM $1::numeric`;
