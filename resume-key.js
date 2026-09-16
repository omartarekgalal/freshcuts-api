/* ═══════════════════════════════════════════════════════════════════════════
   RESUME KEY — مفتاح استكمال/تتبع الطلب (الخطة الرئيسية W1-02، ٠٣ A3/A5/A9، ٠٨).

   k = HMAC_SHA256(SHOP_RESUME_SECRET, orderNo + "|" + created_at) مقصوص لـ24 حرف
   (base64url — آمن في الرابط: /pay/<orderNo>?k=… و/track/<orderNo>?k=…).

   - created_at بيتوحّد لـISO (Date من pg أو نص) عشان نفس الطلب يطلع نفس المفتاح
     مهما كان شكل القيمة اللي جاية من قاعدة البيانات.
   - من غير SHOP_RESUME_SECRET المفتاح null — مفيش سر افتراضي في الكود.
   - verifyResumeKey مقارنة ثابتة الوقت، ومابترميش.
   - دوال صافية، مفيش side effect وقت الـimport.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

export const KEY_LENGTH = 24;

const envSecret = () => String(process.env.SHOP_RESUME_SECRET || "").trim();

/* created_at → نص ثابت. Date/نص قابل للتحويل → ISO؛ غير كده null. */
export function normCreatedAt(v) {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/* resumeKey(row) أو resumeKey({orderNo, createdAt}) — بيرجع 24 حرف أو null */
export function resumeKey(order, secret = envSecret()) {
  try {
    const sec = String(secret || "").trim();
    if (!sec || !order || typeof order !== "object") return null;
    const orderNo = String(order.order_no ?? order.orderNo ?? "").trim();
    const createdAt = normCreatedAt(order.created_at ?? order.createdAt);
    if (!orderNo || !createdAt) return null;
    return crypto.createHmac("sha256", sec)
      .update(`${orderNo}|${createdAt}`, "utf8")
      .digest("base64url")
      .slice(0, KEY_LENGTH);
  } catch {
    return null;
  }
}

/* k صحيح للطلب ده؟ false لأي حاجة ناقصة/غلط (مابترميش). */
export function verifyResumeKey(order, k, secret = envSecret()) {
  try {
    if (typeof k !== "string" || k.length !== KEY_LENGTH) return false;
    const expected = resumeKey(order, secret);
    if (!expected) return false;
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(k, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
