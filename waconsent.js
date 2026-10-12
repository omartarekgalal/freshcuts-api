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
export const WA_UPDATES_TEXTS = Object.freeze({
  "wa-updates-v1": Object.freeze({
    ar: "تحديثات طلبك على واتساب؟ نرسل لك من فريش كاتس على هذا الرقم: تأكيد الطلب، وقت جاهزيته، وخروجه مع المندوب. توقفها في أي وقت بإرسال كلمة «إيقاف».",
    en: "Order updates on WhatsApp? Fresh Cuts will message this number with: order confirmation, when it is ready, and when it leaves with the courier. Stop any time by sending “إيقاف” (stop).",
    yes: "نعم، أرسلوها على واتساب", no: "لا، شكراً",
  }),
});
export const WA_UPDATES_CURRENT = "wa-updates-v1";

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
        kind TEXT NOT NULL,            -- updates
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
