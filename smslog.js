/* ═══════════════════════════════════════════════════════════════════════════
   SMS LOG — سجل موحّد لكل رسالة SMS بتخرج من السيرفر (١٩/٩، Customer 360)

   قبل كده كل موديول بيسجّل على طريقته (أو مابيسجّلش خالص): الحملات في
   cms_campaign_sends، السلة في cart_recovery، دعوات التقييم في review_invites،
   حالة الطلب في shop_order_events، والـOTP ورسايل الإدارة في ولا حتة.

   دلوقتي: accounts.sendSms (المُرسل العادي) وsmsrules.sendAdSms (المُرسل
   الإعلاني) بيكتبوا هنا بعد كل محاولة — نجحت أو فشلت. الحملات مستثناة عن
   قصد: ليها سجل كامل في cms_campaign_sends وشاشة السجل بتقراه من هناك (مفيش
   صف مكرر).

   قواعد:
   • نص الـOTP مابيتخزّنش — الأرقام بتتشال («رمز التحقق ••••»).
   • التسجيل عمره ما يوقّف رسالة: fire-and-forget، والجدول بيتعمل أول مرة.
   • تقنيات مالهاش API لتقارير التسليم — الحالة = «اتقبلت عند تقنيات» أو «فشلت».
═══════════════════════════════════════════════════════════════════════════ */

let _pool = null;
let _ready = null;

export const SMS_KINDS = {
  otp: "رمز التحقق",
  order_status: "حالة الطلب",
  review_invite: "دعوة تقييم",
  review_reply: "رد على تقييم",
  cart_recovery: "استرداد سلة",
  waitlist: "منتظرين الفتح",
  campaign: "حملة",
  flow: "أتمتة",
  staff: "للإدارة/الفريق",
  test: "تجربة",
  other: "أخرى",
};

export const SMS_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS sms_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    phone_norm TEXT,
    kind TEXT NOT NULL DEFAULT 'other',
    sender TEXT,
    ref TEXT,
    body TEXT,
    parts INT,
    cost NUMERIC,
    status TEXT NOT NULL DEFAULT 'sent',
    msg_id TEXT,
    error TEXT,
    origin TEXT NOT NULL DEFAULT 'live',
    src_key TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS sms_log_at_idx ON sms_log(at DESC);
  CREATE INDEX IF NOT EXISTS sms_log_phone_idx ON sms_log(phone_norm, at DESC);
  CREATE INDEX IF NOT EXISTS sms_log_kind_idx ON sms_log(kind, at DESC);`;

export function initSmsLog(pool) {
  _pool = pool;
  _ready = pool.query(SMS_LOG_DDL).catch((e) => { _ready = null; console.error("[smslog] schema:", e.message); });
  return _ready;
}

/* الـOTP: الرمز نفسه مايتخزّنش */
export function redactBody(kind, body) {
  const b = String(body == null ? "" : body);
  if (kind === "otp") return b.replace(/\d/g, "•");
  return b.slice(0, 1000);
}

/* UCS-2 (عربي) = 70 حرف للجزء الواحد و67 لو أكتر؛ GSM = 160/153 */
export function partsOf(body) {
  const t = String(body || "");
  const ucs = /[^\x00-\x7F]/.test(t);
  const one = ucs ? 70 : 160, multi = ucs ? 67 : 153;
  return t.length <= one ? 1 : Math.ceil(t.length / multi);
}

/* بيرجّع promise (للاختبارات) بس محدش لازم يستناه */
export function logSms({ phoneNorm, kind = "other", sender = null, ref = null, body = "", status = "sent",
  msgId = null, cost = null, parts = null, error = null } = {}) {
  if (!_pool) return Promise.resolve(false);
  const k = SMS_KINDS[kind] ? kind : "other";
  const p = (_ready || Promise.resolve()).then(() => _pool.query(
    `INSERT INTO sms_log (phone_norm, kind, sender, ref, body, parts, cost, status, msg_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [phoneNorm ? String(phoneNorm) : null, k, sender, ref == null ? null : String(ref).slice(0, 120),
      redactBody(k, body), Number(parts) || partsOf(body), cost == null || cost === "" ? null : Number(cost) || 0,
      status === "failed" ? "failed" : "sent", msgId == null ? null : String(msgId), error ? String(error).slice(0, 300) : null]))
    .then(() => true)
    .catch((e) => { console.error("[smslog] insert:", e.message); return false; });
  return p;
}

export function _resetForTests() { _pool = null; _ready = null; }
