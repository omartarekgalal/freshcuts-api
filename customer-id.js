/* ═══════════════════════════════════════════════════════════════════════════
   CUSTOMER-ID — معرّف العميل الموحّد (customer_id) — ١٩ سبتمبر ٢٠٢٦
   docs/build-2026-09/tracking-architecture.md §٣ (في ريبو اللوحة)

   الجوال هو هوية العميل الحقيقية عندنا (OTP + shop_orders + ts_customers)، بس
   عمره ما بيطلع برّه السيرفر خام. أي نظام برّه (GA4 user_id، Clarity identify،
   external_id في CAPI، تطبيقات الموبايل) بياخد customer_id بداله:

     customer_id = HMAC-SHA256(secret, phone_norm) → أول ٣٢ حرف hex

   • ثابت لنفس الرقم على كل الأجهزة والقنوات (ويب/تطبيق/نقطة البيع).
   • مايترجعش للرقم: الـsecret عشوائي، بيتولّد مرة واحدة ويتحفظ في
     fc_identity_secret (مش env — لو اتغيّر كل المعرّفات القديمة هتتقطع).
     من غير secret، hash الجوال بيتكسر بالتجربة (١٠^٨ احتمال بس).
   • phone_norm = الشكل بتاع normPhone (٩ أرقام تبدأ بـ5).
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

export const CUSTOMER_ID_RE = /^[a-f0-9]{32}$/;
const PHONE_RE = /^5\d{8}$/;

/* pure: نفس المدخلات = نفس المعرّف (متجرّب في customer-id.test.mjs) */
export function customerIdFrom(secret, phoneNorm) {
  const pn = String(phoneNorm || "").trim();
  if (!secret || !PHONE_RE.test(pn)) return null;
  return crypto.createHmac("sha256", String(secret)).update("fc-cid:v1:" + pn).digest("hex").slice(0, 32);
}

let _secret = null, _loading = null;
async function loadSecret(pool) {
  if (_secret) return _secret;
  if (_loading) return _loading;
  _loading = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS fc_identity_secret (
      k TEXT PRIMARY KEY, v TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`INSERT INTO fc_identity_secret (k, v) VALUES ('customer_id', $1) ON CONFLICT (k) DO NOTHING`,
      [crypto.randomBytes(32).toString("hex")]);
    const r = await pool.query(`SELECT v FROM fc_identity_secret WHERE k='customer_id'`);
    _secret = r.rows[0]?.v || null;
    return _secret;
  })();
  try { return await _loading; } finally { _loading = null; }
}

/* customer_id لرقم — null لو الرقم مش صالح أو الداتابيز مش متاحة (مايوقعش أي مسار) */
export async function customerId(pool, phoneNorm) {
  try {
    const s = await loadSecret(pool);
    return customerIdFrom(s, phoneNorm);
  } catch (e) {
    console.error("[identity] secret load failed:", e.message);
    return null;
  }
}

/* SQL-side: الـsecret بيتقرا مرة ويتبعت كـparameter لـhmac في Postgres مش
   متاح من غير pgcrypto — فالـbackfill بيحسب في Node على دفعات. */
export async function secretFor(pool) {
  try { return await loadSecret(pool); } catch { return null; }
}
