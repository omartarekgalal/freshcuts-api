/* ═══════════════════════════════════════════════════════════════════════════
   موافقة «تحديثات الطلب على واتساب» — WO (١٢/١٠/٢٠٢٦)

   المشكلة: قوالب تحديثات الطلب كلها معتمدة، لكن جدول wa_optins فيه رقم واحد بس موافق على updates —
   فالقوالب ماكانتش هتوصل لحد تقريباً. السبب (من الكود، مش تخمين): السيرفر بيقبل waUpdates في
   /api/shop/checkout من ٢٨/٩، بس المتجر **عمره ما بعته** — مفيش أي واجهة بتسأل العميل.

   القاعدة (سياسة واتساب بزنس — صفحة «Get opt-in»، اتقرت ١٢/١٠):
     • لازم نقول بوضوح إن الشخص بيوافق يستقبل رسايل **من النشاط** على واتساب، وباسم النشاط.
     • طريقة الموافقة متروكة للنشاط، بشرط توافق القانون المحلي. الصفحة مابتذكرش الخانة المعلَّمة مسبقاً.
     • نظام حماية البيانات السعودي عايز موافقة صريحة ⇒ **اختيار فعلي من العميل، مفيش تعليم مسبق**.
   فاللي بيتسجّل هنا: اختيار العميل (نعم/لا) + الوقت + نسخة النص + النص نفسه + المصدر + رقم الطلب + IP/UA،
   والرقم دايماً رقم متحقق بالـOTP (جلسة الحساب أو الشيك أوت). التسويق موافقة تانية خالص ومش بتتلمس هنا.

   مفيش أي إرسال بيحصل من الملف ده: ده تسجيل موافقة بس. WHATSAPP_ENABLED وبوابة الإرسال زي ما هم.
═══════════════════════════════════════════════════════════════════════════ */

/* النص اللي العميل شافه، لكل نسخة — المتجر بيبعت رقم النسخة بس، والنص بيتسجّل من هنا (إثبات).
   أي تغيير في الصياغة = نسخة جديدة (ومفتاح جديد في المتجر: checkout2.js WA_TEXT). */
import { createHash } from "node:crypto";
import { isPlaceholderPhone } from "./phonecheck.js";
export const WA_UPDATES_TEXTS = Object.freeze({
  "wa-updates-v1": Object.freeze({
    ar: "تحديثات طلبك على واتساب؟ نرسل لك من فريش كاتس على هذا الرقم: تأكيد الطلب، وقت جاهزيته، وخروجه مع المندوب. توقفها في أي وقت بإرسال كلمة «إيقاف».",
    en: "Order updates on WhatsApp? Fresh Cuts will message this number with: order confirmation, when it is ready, and when it leaves with the courier. Stop any time by sending “إيقاف” (stop).",
    yes: "نعم، أرسلوها على واتساب", no: "لا، شكراً",
  }),
});
export const WA_UPDATES_CURRENT = "wa-updates-v1";

/* ── TC (١٣/١٠، قرار عمر: «نكتفي على الرسالة انه موافق على الشروط … التفاصيل تكون موجودة في صفحة الشروط») ─────────────
   سؤال الزرّين اتشال من الشيك أوت. الموافقة على تحديثات الطلب على واتساب بقت جزءاً من الشروط نفسها:
   السطر تحت زر الدفع عام زي ما هو، والمادة (١١) من الشروط + سياسة الخصوصية بيقولوا بوضوح إن فريش كاتس بيبعت رسايل الطلب
   SMS وعلى واتساب، وإزاي تتوقف. وكل طلب بيتسجّل معاه **نسخة الشروط** اللي اتعمل تحتها + الوقت، في نفس سجل الإثبات.
   waOrderUpdates = النسخة دي بتذكر واتساب لتحديثات الطلب (الحارس في whatsapp.js بيعتمد عليها). أي نسخة قبلها مش هنا
   ⇒ طلباتها مش مغطّاة. تغيير نص المادة = نسخة جديدة هنا + نفس الرقم في المتجر (consent.js: FC_TERMS_VERSION). */
export const TERMS_VERSIONS = Object.freeze({
  "terms-2026-10-13": Object.freeze({
    waOrderUpdates: true, effective: "2026-10-13",
    line_ar: "بإتمام الطلب أنت توافق على الشروط والأحكام وسياسة الخصوصية",
    line_en: "By placing your order you agree to the Terms & Conditions and Privacy Policy",
    // السطر تحت زر «أرسل الكود» في خطوة رقم الجوال (التسجيل)
    reg_ar: "بتسجيل رقمك أنت توافق على الشروط والأحكام وسياسة الخصوصية",
    reg_en: "By registering your number you agree to the Terms & Conditions and Privacy Policy",
  }),
});
export const TERMS_CURRENT = "terms-2026-10-13";
/* نسخة الشروط اللي المتجر بعتها مع الطلب ⇒ الاسم لو معروفة، وإلا null (نسخة مش معروفة = مش إثبات، مايتسجّلش حاجة) */
export function parseTermsVersion(raw) {
  const v = typeof raw === "string" ? raw.trim() : "";
  return TERMS_VERSIONS[v] ? v : null;
}

const SOURCES = ["otp_step", "summary", "checkout", "account"];
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/* اللي جه من المتصفح ⇒ { value, version, source } أو null (مفيش إجابة صالحة ⇒ مايتسجّلش حاجة).
   value لازم boolean حقيقي: "true"/1/أي حاجة تانية مرفوضة — الموافقة مابتتخمّنش. */
export function parseWaUpdates(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  if (typeof r.updates !== "boolean") return null;
  const version = String(r.version || "");
  if (!WA_UPDATES_TEXTS[version]) return null;                 // نص مش معروف ⇒ مش إثبات
  const source = SOURCES.includes(r.source) ? r.source : "checkout";
  return { value: r.updates, version, source };
}

let schemaP = null;
export function ensureWaConsentSchema(pool) {
  if (!schemaP) {
    schemaP = pool.query(`
      CREATE TABLE IF NOT EXISTS wa_optins (
        phone_norm TEXT PRIMARY KEY,
        updates BOOLEAN NOT NULL DEFAULT FALSE,
        marketing BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT, order_no TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- متى أجاب العميل على سؤال «تحديثات الطلب» (نعم أو لا) وبأي نسخة نص — NULL = ما اتسألش/ماجاوبش
      ALTER TABLE wa_optins ADD COLUMN IF NOT EXISTS updates_answered_at TIMESTAMPTZ;
      ALTER TABLE wa_optins ADD COLUMN IF NOT EXISTS updates_version TEXT;
      -- سجل الإثبات: كل إجابة صف (مابيتعدّلش): النص اللي اتعرض، المصدر، الطلب، IP/UA
      CREATE TABLE IF NOT EXISTS wa_optin_log (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        kind TEXT NOT NULL,            -- updates | marketing | terms | review (RV1: موافقة الدفع عند الكاشير على طلب التقييم)
        value BOOLEAN NOT NULL,
        text_version TEXT,
        text TEXT,
        source TEXT,
        order_no TEXT,
        ip TEXT,
        ua TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS wa_optin_log_phone_idx ON wa_optin_log(phone_norm, at DESC);
    `).catch((e) => { schemaP = null; throw e; });
  }
  return schemaP;
}
export function _resetSchemaForTests() { schemaP = null; }

/* الكتابة الوحيدة في wa_optins.updates وسجل الإثبات — الشيك أوت/الحساب وسؤال البوت بيعدّوا من هنا. */
async function writeAnswer(pool, { phoneNorm, value, version, text, source, orderNo = null, ip = null, ua = null }) {
  await ensureWaConsentSchema(pool);
  await pool.query(
    `INSERT INTO wa_optins(phone_norm, updates, marketing, source, order_no, updates_answered_at, updates_version)
     VALUES ($1, $2, FALSE, $3, $4, NOW(), $5)
     ON CONFLICT (phone_norm) DO UPDATE SET
       updates = $2, source = $3, order_no = COALESCE($4, wa_optins.order_no),
       updates_answered_at = NOW(), updates_version = $5, updated_at = NOW()`,
    [phoneNorm, value, source, clip(orderNo, 30), version]);
  await pool.query(
    `INSERT INTO wa_optin_log(phone_norm, kind, value, text_version, text, source, order_no, ip, ua)
     VALUES ($1, 'updates', $2, $3, $4, $5, $6, $7, $8)`,
    [phoneNorm, value, version, text, source, clip(orderNo, 30), clip(ip, 60), clip(ua, 200)]);
}

/* نسخة نص سؤال البوت: نفس نص المتجر الحالي ⇒ نفس رقم النسخة؛ نص اتعدّل من اللوحة ⇒ «bot-<بصمة النص>» والنص نفسه في السجل. */
export function botTextVersion(text) {
  const t = String(text || ""), cur = WA_UPDATES_TEXTS[WA_UPDATES_CURRENT];
  return t === cur.ar || t === cur.en ? WA_UPDATES_CURRENT : `bot-${createHash("sha1").update(t).digest("hex").slice(0, 10)}`;
}

/* إجابة سؤال البوت في محادثة واتساب. الرقم المتحقق = مُرسِل الرسالة نفسه (واتساب هو اللي بيثبته في الويب هوك الموقّع)،
   المصدر "bot"، والنص اللي اتعرض فعلاً بيتسجّل بنسخته. wamid رسالة الإجابة بيتحفظ في عمود ua كـ«wa:<id>». */
export async function recordWaUpdatesBot(pool, { phoneNorm, value, text, wamid = null, orderNo = null }) {
  if (!/^5\d{8}$/.test(String(phoneNorm || ""))) return { ok: false, error: "invalid_phone" };
  if (typeof value !== "boolean" || !String(text || "").trim()) return { ok: false, error: "bad_answer" };
  const version = botTextVersion(text);
  await writeAnswer(pool, { phoneNorm, value, version, text: String(text).slice(0, 1000), source: "bot", orderNo, ua: wamid ? `wa:${wamid}` : null });
  return { ok: true, updates: value, version };
}

/* العميل ضغط زر «رجّع كل الرسائل» تحت رسالة الإيقاف في المحادثة: صف إثبات في نفس السجل (kind = marketing).
   الأعمدة نفسها (marketing / stopped_at) بتتظبط من whatsapp.js applyIntent("start") — هنا الإثبات بس: الرقم = مُرسِل الرسالة،
   النص اللي اتعرض ونسخته، المصدر bot، wamid الضغطة. */
export async function recordWaMarketingBot(pool, { phoneNorm, value, text, wamid = null }) {
  if (!/^5\d{8}$/.test(String(phoneNorm || ""))) return { ok: false, error: "invalid_phone" };
  if (typeof value !== "boolean" || !String(text || "").trim()) return { ok: false, error: "bad_answer" };
  await ensureWaConsentSchema(pool);
  const version = `bot-${createHash("sha1").update(String(text)).digest("hex").slice(0, 10)}`;
  await pool.query(
    `INSERT INTO wa_optin_log(phone_norm, kind, value, text_version, text, source, order_no, ip, ua)
     VALUES ($1, 'marketing', $2, $3, $4, 'bot', NULL, NULL, $5)`,
    [phoneNorm, value, version, String(text).slice(0, 1000), wamid ? `wa:${wamid}` : null]);
  return { ok: true, version };
}

/* TC: قبول الشروط مع الطلب — صف إثبات واحد لكل طلب (kind = terms) في نفس السجل: الرقم المتحقق، نسخة الشروط، نص السطر
   اللي اتعرض، الطلب، الوقت، IP/UA. مابيلمسش wa_optins (ده مش اختيار نعم/لا، ده الطلب اتعمل تحت أنهي شروط). */
export async function recordTermsAcceptance(pool, { phoneNorm, version, orderNo, ip = null, ua = null, source = "checkout" }) {
  if (!/^5\d{8}$/.test(String(phoneNorm || ""))) return { ok: false, error: "invalid_phone" };
  const v = parseTermsVersion(version);
  if (!v) return { ok: false, error: "unknown_version" };
  /* TC2 (١٣/١٠): التسجيل برقم الجوال (OTP) بيتسجّل هو كمان — source = register ومن غير رقم طلب. الطلب لازم له رقم. */
  const src = source === "register" ? "register" : "checkout";
  if (src === "checkout" && !orderNo) return { ok: false, error: "no_order" };
  await ensureWaConsentSchema(pool);
  await pool.query(
    `INSERT INTO wa_optin_log(phone_norm, kind, value, text_version, text, source, order_no, ip, ua)
     VALUES ($1, 'terms', TRUE, $2, $3, $7, $4, $5, $6)`,
    [phoneNorm, v, src === "register" ? TERMS_VERSIONS[v].reg_ar : TERMS_VERSIONS[v].line_ar, src === "register" ? null : clip(orderNo, 30), clip(ip, 60), clip(ua, 300), src]);
  return { ok: true, version: v };
}

/* الطلب ده اتعمل تحت شروط بتذكر تحديثات الطلب على واتساب؟ (للحارس). الرقم لازم يكون رقم الطلب نفسه.
   أي خطأ أو نسخة مش معروفة = لأ. */
export async function termsCoverOrder(pool, phoneNorm, orderNo) {
  if (!orderNo || !/^5\d{8}$/.test(String(phoneNorm || ""))) return false;
  try {
    await ensureWaConsentSchema(pool);
    const r = await pool.query(
      "SELECT text_version FROM wa_optin_log WHERE kind='terms' AND value AND order_no=$1 AND phone_norm=$2 ORDER BY id DESC LIMIT 1",
      [String(orderNo), String(phoneNorm)]);
    const v = r.rows && r.rows[0] && r.rows[0].text_version;
    return Boolean(v && TERMS_VERSIONS[v] && TERMS_VERSIONS[v].waOrderUpdates === true);
  } catch { return false; }
}

/* ── RV1 (عمر ١٥/١٠/٢٠٢٦ ١٤:١٥، بنصّه: «عملاء المحل صالة وتيك أواي موافقين مسبقاً وقت الدفع عند الكاشير») ───────────────────────
   مصدر موافقة صريح ومحدود: فاتورة صالة أو سفري في نقطة البيع عليها جوال العميل = موافقة على **رسالة طلب التقييم** على واتساب، بس.
     • بيتسجّل صف إثبات لكل فاتورة في نفس السجل (wa_optin_log): kind = review، source = pos_payment، order_no = pos:<رقم طلب نقطة البيع>،
       الوقت = وقت الفاتورة (لحظة الدفع)، النص = قرار المالك بنسخته. مابيلمسش wa_optins (ده مش «نعم» على تحديثات الطلب ولا العروض).
     • الحارس (whatsapp.js guardSend) بيقبله لقالب التقييم (POS_REVIEW_CONSENT.templates) لما المصدر "review" والطلب pos:… والصف موجود لنفس
       الجوال ونفس الفاتورة والإعداد مفتوح — غير كده ولا حاجة اتغيّرت: «إيقاف» و«لا» الصريحة بيغلبوا، والعروض وتحديثات الطلب على قواعدهم.
     • الإعداد: waBot.reviewFlow.posConsent («عملاء الكاشير موافقين وقت الدفع» — مفتوح افتراضياً). مقفول ⇒ مفيش تسجيل ولا استخدام. */
export const POS_REVIEW_CONSENT = Object.freeze({
  kind: "review", source: "pos_payment", version: "pos-payment-2026-10-15",
  text: "قرار المالك (١٥/١٠/٢٠٢٦): عملاء المحل (صالة وسفري) اللي جوالهم على الفاتورة موافقين مسبقاً وقت الدفع عند الكاشير على رسالة طلب التقييم على واتساب.",
  templates: Object.freeze(["fc_review_stars"]),       // رسالة التقييم بس — أي قالب تاني مايعدّيش بالموافقة دي
  kinds: Object.freeze(["dinein", "takeaway"]),       // فواتير الكاشير بس (مش التطبيقات ولا طلبات الموقع)
  /* مراجعة RV1: رقم على العدد ده من الفواتير أو أكتر في ٢٤ ساعة = رقم الكاشير الافتراضي (حشو)، مش عميل واحد ⇒ مفيش موافقة ولا رسالة.
     والرقم «الحشو» الصريح (555555555 / 500000000 / نفس الرقم ٨ مرات / 512345678 — phonecheck.js) مالوش موافقة أبداً. */
  sharedBills: 4,
});
const POS_ORDER_RE = /^pos:[A-Za-z0-9_-]{1,64}$/;
/* الإعداد مفتوح؟ (نفس افتراضيات wareviews.reviewFlowConfig: المسار الجديد والموافقة مفتوحين إلا لو اتقفلوا صراحةً) */
export function posReviewConsentOn(settings) {
  const f = (((settings || {}).waBot) || {}).reviewFlow;
  const x = f && typeof f === "object" ? f : {};
  return x.enabled !== false && x.posConsent !== false;
}
/* صف الإثبات (مرة واحدة لكل فاتورة وجوال). at = وقت الفاتورة. ⇒ { ok, recorded } — بيرمي لو القاعدة وقعت (المنادي يقرر). */
export async function recordPosReviewConsent(pool, { phoneNorm, orderNo, kind, at = null, receipt = null }) {
  if (!/^5\d{8}$/.test(String(phoneNorm || ""))) return { ok: false, error: "invalid_phone" };
  if (isPlaceholderPhone(phoneNorm)) return { ok: false, error: "placeholder_phone" };      // رقم حشو من الكاشير ⇒ ده مش عميل وافق
  if (!POS_ORDER_RE.test(String(orderNo || ""))) return { ok: false, error: "not_pos_order" };
  if (!POS_REVIEW_CONSENT.kinds.includes(kind)) return { ok: false, error: "kind_not_covered" };
  await ensureWaConsentSchema(pool);
  const when = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  const r = await pool.query(
    `INSERT INTO wa_optin_log(phone_norm, kind, value, text_version, text, source, order_no, ip, ua, at)
     SELECT $1, 'review', TRUE, $2, $3, 'pos_payment', $4, NULL, $5, $6::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM wa_optin_log WHERE kind='review' AND source='pos_payment' AND order_no=$4 AND phone_norm=$1)`,
    [String(phoneNorm), POS_REVIEW_CONSENT.version, POS_REVIEW_CONSENT.text, String(orderNo), receipt ? clip(`receipt:${receipt}`, 60) : null, when]);
  return { ok: true, recorded: Boolean(r && r.rowCount) };
}
/* الفاتورة دي عليها موافقة الدفع عند الكاشير لنفس الجوال؟ (للحارس) — أي خطأ = لأ */
export async function posReviewConsentCovers(pool, phoneNorm, orderNo) {
  if (!POS_ORDER_RE.test(String(orderNo || "")) || !/^5\d{8}$/.test(String(phoneNorm || "")) || isPlaceholderPhone(phoneNorm)) return false;
  try {
    await ensureWaConsentSchema(pool);
    const r = await pool.query(
      "SELECT 1 FROM wa_optin_log WHERE kind='review' AND source='pos_payment' AND value AND order_no=$1 AND phone_norm=$2 AND text_version=$3 LIMIT 1",
      [String(orderNo), String(phoneNorm), POS_REVIEW_CONSENT.version]);
    return Boolean(r && r.rows && r.rows.length);
  } catch { return false; }
}

/* ── KA2 (عمر ١٨/١٠/٢٠٢٦، بنصّه: «كيتا هي اللي بتبعتلنا الرقم، موافقين») ─────────────────────────────────────────────────────────────
   مصدر موافقة ضيّق زي pos_payment بالظبط: رقم عميل كيتا اللي جه مع طلبه = موافقة على **رسالة طلب التقييم** لطلب كيتا ده بس (قالب fc_review_stars،
   المصدر "review"، الطلب pos:<رقم طلب كيتا>). صف إثبات لكل طلب (kind = review، source = keeta_order) بيتكتب لما KA2 تدخّل الطلب (keeta_pull.js).
   الحارس بيقبله بس والمفتاح keeta.pull.enabled مفتوح. رسالة «اطلب من موقعنا» قالب تسويق — مالهاش علاقة بالموافقة دي (قاعدة «للكل إلا اللي وقّف»). */
export const KA2_REVIEW_CONSENT = Object.freeze({
  kind: "review", source: "keeta_order", version: "keeta-order-2026-10-18",
  text: "قرار المالك (١٨/١٠/٢٠٢٦): رقم عميل كيتا اللي كيتا بتبعته مع الطلب — موافقين (اتفاق مع كيتا) على رسالة طلب التقييم على واتساب لطلب كيتا ده.",
  templates: Object.freeze(["fc_review_stars"]),
});
export function ka2ReviewConsentOn(settings) {
  const p = (((settings || {}).keeta) || {}).pull;
  return Boolean(p && typeof p === "object" && p.enabled === true);
}
export async function recordKa2ReviewConsent(pool, { phoneNorm, orderNo, at = null }) {
  if (!/^5\d{8}$/.test(String(phoneNorm || ""))) return { ok: false, error: "invalid_phone" };
  if (isPlaceholderPhone(phoneNorm)) return { ok: false, error: "placeholder_phone" };
  if (!POS_ORDER_RE.test(String(orderNo || ""))) return { ok: false, error: "not_pos_order" };
  await ensureWaConsentSchema(pool);
  const when = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  const r = await pool.query(
    `INSERT INTO wa_optin_log(phone_norm, kind, value, text_version, text, source, order_no, ip, ua, at)
     SELECT $1, 'review', TRUE, $2, $3, 'keeta_order', $4, NULL, NULL, $5::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM wa_optin_log WHERE kind='review' AND source='keeta_order' AND order_no=$4 AND phone_norm=$1)`,
    [String(phoneNorm), KA2_REVIEW_CONSENT.version, KA2_REVIEW_CONSENT.text, String(orderNo), when]);
  return { ok: true, recorded: Boolean(r && r.rowCount) };
}
export async function ka2ReviewConsentCovers(pool, phoneNorm, orderNo) {
  if (!POS_ORDER_RE.test(String(orderNo || "")) || !/^5\d{8}$/.test(String(phoneNorm || "")) || isPlaceholderPhone(phoneNorm)) return false;
  try {
    await ensureWaConsentSchema(pool);
    const r = await pool.query(
      "SELECT 1 FROM wa_optin_log WHERE kind='review' AND source='keeta_order' AND value AND order_no=$1 AND phone_norm=$2 AND text_version=$3 LIMIT 1",
      [String(orderNo), String(phoneNorm), KA2_REVIEW_CONSENT.version]);
    return Boolean(r && r.rows && r.rows.length);
  } catch { return false; }
}

/* تسجيل الإجابة. phoneNorm لازم يكون جاي من رقم متحقق (جلسة OTP) — المتصل هو المسؤول عن ده.
   بيحدّث updates بس؛ عمود marketing مابيتلمسش. */
export async function recordWaUpdates(pool, { phoneNorm, answer, orderNo = null, ip = null, ua = null }) {
  if (!/^5\d{8}$/.test(String(phoneNorm || ""))) return { ok: false, error: "invalid_phone" };
  const a = answer && typeof answer.value === "boolean" && WA_UPDATES_TEXTS[answer.version] ? answer : null;
  if (!a) return { ok: false, error: "bad_answer" };
  await writeAnswer(pool, { phoneNorm, value: a.value, version: a.version, text: WA_UPDATES_TEXTS[a.version].ar, source: a.source, orderNo, ip, ua });
  return { ok: true, updates: a.value, version: a.version };
}

/* حالة الرقم: جاوب ولا لأ، وإجابته. موافقة قديمة (updates=true من قبل WO من غير وقت) = «جاوب: نعم». */
export async function waUpdatesState(pool, phoneNorm) {
  await ensureWaConsentSchema(pool);
  const r = (await pool.query("SELECT updates, updates_answered_at, updates_version FROM wa_optins WHERE phone_norm=$1", [phoneNorm])).rows[0];
  if (!r) return { answered: false, updates: null, version: null, at: null };
  const answered = Boolean(r.updates_answered_at) || r.updates === true;
  return { answered, updates: answered ? r.updates === true : null, version: r.updates_version || null, at: r.updates_answered_at || null };
}

export function register(app, ctx, deps = {}) {
  const { pool } = ctx;
  const customerOf = deps.customerOf;               // accounts.js — جلسة العميل (OTP)
  const ipOf = (c) => c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || null;
  const ready = ensureWaConsentSchema(pool).catch((e) => console.error("[wa-consent] schema:", e.message));

  /* المتجر بيسأل: الرقم ده جاوب قبل كده؟ (عشان السؤال يظهر مرة واحدة بس) */
  app.get("/api/account/wa-updates", async (c) => {
    const acct = customerOf ? await customerOf(c) : null;
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    await ready;
    const st = await waUpdatesState(pool, acct.phone_norm);
    return c.json({ ok: true, answered: st.answered, updates: st.updates, version: WA_UPDATES_CURRENT });
  });

  /* العميل اختار (نعم/لا) — الرقم من الجلسة المتحققة، مش من الطلب نفسه */
  app.post("/api/account/wa-updates", async (c) => {
    const acct = customerOf ? await customerOf(c) : null;
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const answer = parseWaUpdates(b);
    if (!answer) return c.json({ ok: false, error: "bad_answer" }, 400);
    await ready;
    const r = await recordWaUpdates(pool, { phoneNorm: acct.phone_norm, answer, ip: ipOf(c), ua: c.req.header("user-agent") || null });
    return c.json(r, r.ok ? 200 : 400);
  });

  return { ready };
}
