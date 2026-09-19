/* ═══════════════════════════════════════════════════════════════════════════
   ACCOUNTS — the customer's own profile on order.o2m8.me.

   Omar's spec (2026-08-11): «العميل يكون ليه ملف يشوف طلباته ويعيد الطلب
   ويعمل كل حاجة» + «يتسجل تلقائياً في دفتر عملاء تاب سينس، ولو بياناته
   موجودة قبل كده تدخل لواحدها عادي».

   Identity = the Saudi mobile, same rule as the whole API. Login is
   phone + OTP over SMS (Taqnyat — subscription in progress; until the
   credentials land, settings.shop.otpDevMode=true lets us test end-to-end
   and MUST be off in production because it returns the code in the reply).

   TabSense directory: on login we link, we don't blindly create. If the
   phone already exists in ts_customers the account simply points at it
   (Omar: «تدخل لواحدها عادي»); only a genuinely new phone goes through
   tabsense.createCustomer — which enforces the silent-rejection rules
   (short names, non-Saudi mobiles) and still can't be fully trusted, so we
   record its answer and let the next ts_customers sync confirm the truth.

   Env: TAQNYAT_API_KEY, TAQNYAT_SENDER (CITC-approved sender name).
   Toggle: settings.notifications.smsEnabled (dashboard-controlled).
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import * as tabsense from "./tabsense.js";
import { logSms } from "./smslog.js";
import { customerId } from "./customer-id.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();

const OTP_TTL_MIN = 5;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_DAY = 6;          // حد يومي لكل رقم — يمنع ضخّ الرسائل على رقم واحد
const SESSION_DAYS = 180;

/* قاطع دائرة لحماية رصيد الرسائل: سقف إجمالي لكل ساعة عبر كل الأرقام. لو
   حصل هجوم موزّع (أرقام كتير من IPs كتير) ده بيوقفه قبل ما يحرق الرصيد.
   قابل للضبط بـ OTP_SMS_HOUR_CAP (افتراضي 300 رسالة/ساعة). */
let _smsHour = { start: Date.now(), n: 0 };
function smsBudgetOk() {
  const cap = Number((process.env.OTP_SMS_HOUR_CAP || "").trim()) || 300;
  if (Date.now() - _smsHour.start > 3600_000) _smsHour = { start: Date.now(), n: 0 };
  return _smsHour.n < cap;
}

/* أعطال شبكة قبل ما الطلب يوصل تقنيات أصلاً (DNS/اتصال) — آمن نعيد فيها من
   غير خوف من رسالتين. 14 سبتمبر: DNS الحاوية فشل في api.taqnyat.sa (EAI_AGAIN)
   وعميل وقف على «أرسل رمز جديد بعد شوي» والرسالة عمرها ما خرجت. مهلة الرد
   (AbortError) مش منهم: الطلب ممكن يكون وصل، والإعادة تبعت رمزين. */
const SMS_TRANSIENT = new Set(["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
export const smsRetryable = (e) => SMS_TRANSIENT.has((e && e.cause && e.cause.code) || (e && e.code));

/* ── Taqnyat SMS (the one place SMS leaves this API; notify.js will reuse) ── */
/* kind/ref (اختياري) بيروحوا لسجل الرسايل الموحّد (smslog.js) — مين بعت إيه
   ولمين. التسجيل مابيأثرش على الإرسال خالص. */
export async function sendSms({ phoneNorm, body, kind, ref }, opts = {}) {
  try {
    const data = await sendSmsRaw({ phoneNorm, body }, opts);
    logSms({ phoneNorm, kind: kind || "other", sender: env("TAQNYAT_SENDER") || null, ref, body, status: "sent",
      msgId: data && data.messageId, cost: data && data.cost, parts: data && data.msgLength });
    return data;
  } catch (e) {
    logSms({ phoneNorm, kind: kind || "other", sender: env("TAQNYAT_SENDER") || null, ref, body, status: "failed", error: e && (e.code || e.message) });
    throw e;
  }
}

async function sendSmsRaw({ phoneNorm, body }, { attempts = 3, backoffMs = 700 } = {}) {
  const key = env("TAQNYAT_API_KEY");
  const sender = env("TAQNYAT_SENDER");
  if (!key || !sender) throw Object.assign(new Error("Taqnyat not configured"), { code: "SMS_UNCONFIGURED" });
  let resp;
  for (let attempt = 1; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      resp = await fetch("https://api.taqnyat.sa/v1/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: [`966${phoneNorm}`], body, sender }),
        signal: ctl.signal,
      });
      break;
    } catch (e) {
      if (attempt >= attempts || !smsRetryable(e)) throw e;
      console.error(`[accounts] SMS network error (${(e.cause && e.cause.code) || e.code}) — retry ${attempt}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    } finally { clearTimeout(t); }
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data.statusCode && data.statusCode >= 400)) {
    throw Object.assign(new Error(`Taqnyat: ${data.message || resp.status}`), { code: "SMS_FAILED", resp: data });
  }
  return data;
}

/* A POS name is only worth adopting when it looks like a NAME. TabSense is
   full of cashier junk («الاسم الكامل 111111», bare digits, placeholders) —
   copying that over is worse than leaving the field empty for the customer
   to fill. */
export function plausibleName(s) {
  const v = String(s || "").trim();
  if (v.length < 2 || v.length > 60) return false;
  if (/^[\d\s\-_.+]+$/.test(v)) return false;               // digits/punctuation only
  if (/الاسم الكامل|full ?name|unknown|test|بدون اسم/i.test(v)) return false;
  if (/^عميل( |$)/.test(v)) return false;                   // our own placeholders
  return true;
}

const hashOtp = (phoneNorm, code) =>
  crypto.createHash("sha256").update(`${phoneNorm}|${code}|${env("ADMIN_TOKEN", "otp")}`).digest("hex");

/* per-IP limiter (same naive shape as funnel.js) */
const rl = new Map();
function rateLimited(ip, max) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

/* ── دفتر العناوين (الشيك أوت الجديد) ────────────────────────────────────
   شكل العنوان: {id, label, area, street, building, floor, landmark, notes,
   latitude, longitude, is_default, created_at, used_at}

   - label نص حر ٣٠ حرف (الواجهة بتقترح المنزل/العمل/بيت الأهل/آخر).
   - عنوان افتراضي واحد بس لكل عميل؛ أول عنوان بيبقى افتراضي تلقائياً،
     وتعيين واحد بيشيل العلامة من الباقي، وحذف الافتراضي بيرقّي الأحدث
     استخداماً.
   - العناوين القديمة المخزّنة (من غير id/is_default/تواريخ) بتتقري زي ما هي:
     أول واحد في الترتيب المخزّن بيبقى الافتراضي — نفس اللي كانت الواجهة
     القديمة بتختاره (index 0) — فمفيش حاجة بتتغيّر قدام العميل.
   - الترتيب الراجع: الافتراضي أولاً، بعدين الأحدث استخداماً. */
export const ADDR_MAX = 10;
// <> بيتشالوا: المتجر الحالي بيعرض الاسم/الحي/الشارع جوا innerHTML من غير escape
const txt = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const coord = (v) => (v === "" || v == null ? NaN : Number(v));
const validLat = (v) => Number.isFinite(v) && v !== 0 && Math.abs(v) <= 90;
const validLng = (v) => Number.isFinite(v) && v !== 0 && Math.abs(v) <= 180;
const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";
const tsOf = (a) => Date.parse((a && (a.used_at || a.created_at)) || "") || 0;

/* يدمج المدخلات فوق عنوان قائم (أو فاضي). الحقول اللي مش مبعوتة بتفضل زي
   ما هي — فالواجهة القديمة اللي بتبعت label/area/street/notes بس ماتمسحش
   الدور والمبنى. */
export function cleanAddress(input, prev = null, now = new Date().toISOString()) {
  const b = input || {};
  const p = prev || {};
  const pick = (k, n, legacyN = n) =>
    (b[k] !== undefined ? txt(b[k], n) : txt(p[k], legacyN));
  const lat = b.latitude !== undefined ? coord(b.latitude) : coord(p.latitude);
  const lng = b.longitude !== undefined ? coord(b.longitude) : coord(p.longitude);
  return {
    id: p.id || crypto.randomUUID(),
    // ٣٠ حرف للجديد؛ اسم قديم أطول (كان الحد ٤٠) مابيتقصّش لو ماتعدّلش
    label: pick("label", 30, 40) || "عنواني",
    area: pick("area", 60),
    street: pick("street", 120),
    building: pick("building", 30),
    floor: pick("floor", 30),
    // الشقة خانة لوحدها من 18 سبتمبر (قبلها الدور والشقة كانوا في floor)
    apartment: pick("apartment", 30),
    landmark: pick("landmark", 80),
    notes: pick("notes", 120),
    latitude: lat, longitude: lng,
    // «اترك الطلب عند الباب» — تفضيل محفوظ مع العنوان
    leave_at_door: b.leave_at_door !== undefined ? truthy(b.leave_at_door) : Boolean(p.leave_at_door),
    /* موافقة العميل على رسوم المسافة الإضافية («المنطقة البعيدة»). محفوظة مع
       العنوان نفسه لأنها خاصة بالمكان ده بالظبط — عنوان تاني قريب لازم
       موافقة جديدة، والعميل مايتفاجئش برسم وافق عليه مرة في مكان تاني. */
    far_zone_accepted: b.far_zone_accepted !== undefined ? truthy(b.far_zone_accepted) : Boolean(p.far_zone_accepted),
    is_default: Boolean(p.is_default),
    created_at: p.created_at || now,
    used_at: p.used_at || p.created_at || now,
  };
}

export const validCoords = (a) => validLat(coord(a && a.latitude)) && validLng(coord(a && a.longitude));

export const sameSpot = (a, b) =>
  Math.abs(Number(a.latitude) - Number(b.latitude)) < 0.0005 &&
  Math.abs(Number(a.longitude) - Number(b.longitude)) < 0.0005;

/* نفس المكان ونفس المبنى/الدور = نفس العنوان (تحديث مش إضافة). الواجهة
   القديمة مابتبعتش مبنى/دور فبتفضل تتصرف زي الأول؛ الجديدة تقدر تحفظ «بيت
   الأهل» في نفس العمارة بدور تاني كعنوان منفصل.
   المبنى/الدور بيتقارنوا بس لو المدخل بعتهم فعلاً — طلب من الواجهة القديمة
   (من غير مبنى/دور) على نفس الدبوس بيحدّث العنوان بدل ما يكرره. */
const sameAddress = (a, b, input = {}) =>
  sameSpot(a, b) &&
  (input.building === undefined || txt(a.building, 30) === txt(b.building, 30)) &&
  (input.floor === undefined || txt(a.floor, 30) === txt(b.floor, 30)) &&
  (input.apartment === undefined || txt(a.apartment, 30) === txt(b.apartment, 30));

/* id لكل عنوان + افتراضي واحد بالظبط (لو القائمة مش فاضية). */
export function normalizeAddresses(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((a) => a && typeof a === "object")
    .map((a) => ({ ...a, id: a.id ? String(a.id) : crypto.randomUUID() }));
  let seen = false;
  for (const a of list) {
    if (a.is_default && !seen) { a.is_default = true; seen = true; }
    else a.is_default = false;
  }
  if (!seen && list.length) list[0].is_default = true;
  return list;
}

/* الافتراضي أولاً، بعدين الأحدث استخداماً. القديم من غير تواريخ بيتحط بعد
   المؤرّخ بترتيبه المخزّن. الترتيب لازم يكون ثابت (idempotent): ترتيب عكسي
   للتعادل كان بيقلب القائمة مع كل قراءة/كتابة. */
export function sortAddresses(list) {
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) =>
      (Number(Boolean(y.a.is_default)) - Number(Boolean(x.a.is_default))) ||
      (tsOf(y.a) - tsOf(x.a)) ||
      (x.i - y.i))
    .map((x) => x.a);
}

function setDefault(list, id) {
  for (const a of list) a.is_default = a.id === id;
}

/* الأحدث استخداماً بين الباقيين بيبقى الافتراضي لو مفيش افتراضي */
function ensureDefault(list) {
  if (!list.length || list.some((a) => a.is_default)) return list;
  const best = sortAddresses(list)[0];
  setDefault(list, best.id);
  return list;
}

/* فوق الحد: نشيل الأقدم استخداماً — عمر الافتراضي ما يتشال */
function capList(list) {
  while (list.length > ADDR_MAX) {
    // الأقدم استخداماً؛ التعادل (قديم من غير تواريخ) = الأقدم في الترتيب المخزّن
    let victim = null;
    for (const a of list) if (!a.is_default && (!victim || tsOf(a) < tsOf(victim))) victim = a;
    if (!victim) break;
    list.splice(list.indexOf(victim), 1);
  }
  return list;
}

/* إضافة (أو تحديث لو نفس العنوان). يرجّع {list, address}. */
export function addAddress(stored, input, { now = new Date().toISOString(), touch = true } = {}) {
  const list = normalizeAddresses(stored);
  const draft = cleanAddress(input, null, now);
  const i = list.findIndex((a) => sameAddress(a, draft, input || {}));
  let addr;
  if (i >= 0) {
    addr = cleanAddress(input, list[i], now);
    if (touch) addr.used_at = now;
    list[i] = addr;
  } else {
    addr = draft;
    list.push(addr);
  }
  if (truthy(input && input.is_default) || list.length === 1) setDefault(list, addr.id);
  ensureDefault(list);
  capList(list);
  return { list: sortAddresses(list), address: addr };
}

/* تعديل بالمعرّف. is_default:false على الافتراضي بيرقّي غيره (لو فيه). */
export function updateAddress(stored, id, input, { now = new Date().toISOString() } = {}) {
  const list = normalizeAddresses(stored);
  const i = list.findIndex((a) => a.id === String(id));
  if (i < 0) return null;
  const next = cleanAddress(input, list[i], now);
  if (!validCoords(next)) return { error: "location_required" };
  list[i] = next;
  const b = input || {};
  if (truthy(b.is_default)) setDefault(list, next.id);
  else if (b.is_default !== undefined && next.is_default && list.length > 1) {
    next.is_default = false;
    const other = sortAddresses(list.filter((a) => a.id !== next.id))[0];
    setDefault(list, other.id);
  }
  ensureDefault(list);
  return { list: sortAddresses(list), address: next };
}

/* حذف بالمعرّف (أو بالترتيب المخزّن للنسخ القديمة من الواجهة). */
export function removeAddress(stored, id) {
  const list = normalizeAddresses(stored);
  const key = String(id);
  const byIndex = /^\d+$/.test(key) && !list.some((a) => a.id === key);
  const next = byIndex
    ? list.filter((_, i) => i !== Number(key))
    : list.filter((a) => a.id !== key);
  ensureDefault(next);
  return sortAddresses(next);
}

/* طلب توصيل اتدفع: لو المكان محفوظ نحدّث «آخر استخدام» بس (عنوان الطلب
   مركّب «شارع …، مبنى …» ومايصحش يدوس على اللي العميل كتبه بإيده)؛ لو جديد
   يتضاف. يرجّع null لو مفيش تغيير يستاهل كتابة. */
export function recordUsedAddress(stored, raw, { now = new Date().toISOString() } = {}) {
  if (!validCoords(raw)) return null;
  const list = normalizeAddresses(stored);
  const hit = list.find((a) => sameSpot(a, { latitude: coord(raw.latitude), longitude: coord(raw.longitude) }));
  if (hit) {
    hit.used_at = now;
    return sortAddresses(list);
  }
  return addAddress(list, {
    area: raw.area, street: raw.street, notes: raw.notes, label: raw.label,
    latitude: raw.latitude, longitude: raw.longitude,
  }, { now }).list;
}

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb, normPhone, deliveryAppOf } = ctx;

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS acct_customers (
        phone_norm TEXT PRIMARY KEY,
        name TEXT,
        addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
        ts_customer_id BIGINT,
        ts_sync JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      -- خصم دائم لعميل بعينه (الملاك 50% مثلاً): بينزل تلقائياً في الشيك أوت
      -- بمجرد ما رقمه يتكتب — مش محتاج حتى تسجيل دخول.
      ALTER TABLE acct_customers ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE acct_customers ADD COLUMN IF NOT EXISTS discount_label TEXT;
      CREATE TABLE IF NOT EXISTS acct_otp (
        phone_norm TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        day_count INT NOT NULL DEFAULT 0,
        day_start TIMESTAMPTZ
      );
      ALTER TABLE acct_otp ADD COLUMN IF NOT EXISTS day_count INT NOT NULL DEFAULT 0;
      ALTER TABLE acct_otp ADD COLUMN IF NOT EXISTS day_start TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS acct_sessions (
        token TEXT PRIMARY KEY,
        phone_norm TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS acct_sessions_phone_idx ON acct_sessions(phone_norm);
    `);
  }
  ensureSchema()
    .then(() => console.log("[accounts] schema ready"))
    .catch((e) => console.error("[accounts] schema failed:", e.message));

  /* customer auth: Authorization: Bearer cust:<token> → account row or null */
  async function customerOf(c) {
    const h = c.req.header("Authorization") || "";
    const m = h.match(/^Bearer cust:([a-f0-9]{48,96})$/i);
    if (!m) return null;
    // نافذة منزلقة: العميل النشط عمره ما يتسجل خروجه. الشرط على آخر ظهور
    // مش على تاريخ الدخول — واحد بيطلب كل أسبوع يفضل داخل للأبد، واللي
    // اختفى ١٨٠ يوم بس هو اللي بيطلع.
    const r = await pool.query(
      `UPDATE acct_sessions SET last_seen_at=NOW()
        WHERE token=$1 AND last_seen_at > NOW() - INTERVAL '${SESSION_DAYS} days'
        RETURNING phone_norm`, [m[1]]);
    if (!r.rowCount) return null;
    const a = await pool.query("SELECT * FROM acct_customers WHERE phone_norm=$1", [r.rows[0].phone_norm]);
    return a.rows[0] || null;
  }

  /* ── POST /api/account/recognise {phone} ────────────────────────────────
     العميل كتب رقمه في الشيك أوت. لو الرقم معروف عندنا، بنعرض شريط صغير:
     «أهلاً محمد ع. — عندك ٣ عناوين محفوظة و١٢ طلب سابق» وجنبه زرار دخول.
     ده أقوى نداء تسجيل دخول عندنا، لأن العميل بيشوف تاريخه الحقيقي قبل ما
     يدفع تمن الدخول.

     أمان: الرد ده عملياً «هل الرقم ده عميل عندكم؟» — فبيرجع أرقام بس،
     والاسم مقنّع (اسم أول + حرف)، ومحدود بـ 20 طلب/ساعة لكل IP، وشكل الرد
     واحد للمعروف وغير المعروف عشان ما يتقاسش بالفرق. */
  app.post("/api/account/recognise", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 20)) return c.json({ ok: true, known: false }, 200);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: true, known: false }); }
    const phoneNorm = normPhone(b.phone);
    if (!/^5\d{8}$/.test(phoneNorm)) return c.json({ ok: true, known: false });

    const acct = (await pool.query(
      "SELECT name, addresses FROM acct_customers WHERE phone_norm=$1", [phoneNorm])).rows[0];
    const online = (await pool.query(
      `SELECT count(*)::int AS n FROM shop_orders
        WHERE phone_norm=$1 AND status NOT IN ('expired','pending_payment')`, [phoneNorm])).rows[0].n;
    const pos = (await pool.query(
      `SELECT count(*)::int AS n FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
        WHERE o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'
          AND COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) = $1`, [phoneNorm])).rows[0].n;
    // الاسم من دفتر تاب سينس لو مالناش صف حساب — ده بيخلي عميل الصالة
    // القديم يتعرف عليه من أول طلب أونلاين.
    let name = acct && acct.name;
    if (!name) {
      const ts = (await pool.query(
        "SELECT name FROM ts_customers WHERE phone_norm=$1 LIMIT 1", [phoneNorm])).rows[0];
      if (ts && plausibleName(ts.name)) name = ts.name;
    }
    const addresses = ((acct && acct.addresses) || []).length;
    const known = Boolean(acct || online || pos);
    return c.json({
      ok: true, known,
      name: known && name ? maskName(name) : null,
      hasAccount: Boolean(acct),
      addresses, orders: online, posVisits: pos,
    });
  });

  /* «محمد عبدالله السالم» → «محمد ع.» — كفاية إن العميل يتعرف على نفسه،
     ومش كفاية إن حد تاني يعرف مين صاحب الرقم. */
  function maskName(s) {
    const parts = String(s || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[1].charAt(0)}.`;
  }

  /* ── POST /api/account/otp/request {phone} ── */
  app.post("/api/account/otp/request", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 30)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const phoneNorm = normPhone(b.phone);
    if (!/^5\d{8}$/.test(phoneNorm)) return c.json({ ok: false, error: "invalid_phone" }, 400);

    const prev = await pool.query(
      "SELECT created_at, day_count, day_start FROM acct_otp WHERE phone_norm=$1", [phoneNorm]);
    if (prev.rowCount && Date.now() - new Date(prev.rows[0].created_at).getTime() < OTP_RESEND_SECONDS * 1000) {
      return c.json({ ok: false, error: "resend_too_soon", retryAfter: OTP_RESEND_SECONDS }, 429);
    }
    // حد يومي لكل رقم: يمنع ضخّ 60 رسالة/ساعة على رقم واحد.
    if (prev.rowCount && prev.rows[0].day_start
        && Date.now() - new Date(prev.rows[0].day_start).getTime() < 86400_000
        && (prev.rows[0].day_count || 0) >= OTP_MAX_PER_DAY) {
      return c.json({ ok: false, error: "daily_limit" }, 429);
    }
    // قاطع دائرة الرصيد: يوقف هجوم موزّع قبل ما يحرق رصيد الرسائل.
    if (!smsBudgetOk()) return c.json({ ok: false, error: "temporarily_unavailable" }, 429);

    const code = String(crypto.randomInt(1000, 10000));
    await pool.query(
      `INSERT INTO acct_otp(phone_norm, code_hash, attempts, expires_at, created_at, day_count, day_start)
       VALUES ($1,$2,0,NOW() + INTERVAL '${OTP_TTL_MIN} minutes',NOW(),1,NOW())
       ON CONFLICT (phone_norm) DO UPDATE
         SET code_hash=$2, attempts=0, expires_at=NOW() + INTERVAL '${OTP_TTL_MIN} minutes', created_at=NOW(),
             day_count = CASE WHEN acct_otp.day_start > NOW() - INTERVAL '24 hours' THEN acct_otp.day_count + 1 ELSE 1 END,
             day_start = CASE WHEN acct_otp.day_start > NOW() - INTERVAL '24 hours' THEN acct_otp.day_start ELSE NOW() END`,
      [phoneNorm, hashOtp(phoneNorm, code)]);

    const settings = await getSettingsData();
    // وضع التجربة (توجّل واحد من اللوحة): بيرجّع الرمز في الرد وما بيبعتش SMS
    // حقيقي مهما كانت قناة الرسائل مفعّلة — عشان الزرار يشتغل لوحده من غير ما
    // تحتاج تطفّي SMS كمان. قبل الإطلاق لازم يتقفل.
    if ((settings.shop || {}).otpDevMode === true) {
      return c.json({ ok: true, sent: "dev", devCode: code });
    }
    const smsOn = (settings.notifications || {}).smsEnabled !== false && env("TAQNYAT_API_KEY");
    if (smsOn) {
      try {
        // السطر الأخير (@domain #code) هو عقد WebOTP: من غيره كروم على أندرويد
        // بيتجاهل الرسالة تماماً وما بيملاش الرمز لوحده.
        const origin = env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa")
          .replace(/^https?:\/\//, "").replace(/\/$/, "");
        await sendSms({ phoneNorm, kind: "otp",
          body: `رمز الدخول لفريش كاتس: ${code}\nصالح ${OTP_TTL_MIN} دقائق.\n\n@${origin} #${code}` });
        _smsHour.n++; // اصرف من ميزانية الساعة بعد إرسال فعلي
        return c.json({ ok: true, sent: "sms" });
      } catch (e) {
        console.error("[accounts] OTP SMS failed:", e.message, (e.cause && e.cause.code) || "");
        // الرسالة ماخرجتش ⇒ مانحبسش العميل ٦٠ ثانية على «أرسل رمز جديد بعد شوي»
        // ولا نحسبها من حده اليومي — يقدر يدوس «إرسال» تاني على طول.
        await pool.query(
          `UPDATE acct_otp SET created_at = NOW() - INTERVAL '1 hour',
                  day_count = GREATEST(COALESCE(day_count, 1) - 1, 0)
            WHERE phone_norm=$1`, [phoneNorm]).catch(() => {});
        // fall through — dev mode may still save the flow, otherwise honest error
      }
    }
    // (وضع التجربة اتفحص فوق قبل محاولة الإرسال)
    return c.json({ ok: false, error: "sms_not_configured" }, 503);
  });

  /* ── POST /api/account/otp/verify {phone, code, name?} → session token ── */
  app.post("/api/account/otp/verify", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 60)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const phoneNorm = normPhone(b.phone);
    const code = String(b.code || "").replace(/\D/g, "");
    if (!/^5\d{8}$/.test(phoneNorm) || !code) return c.json({ ok: false, error: "invalid_input" }, 400);

    const r = await pool.query("SELECT * FROM acct_otp WHERE phone_norm=$1", [phoneNorm]);
    const otp = r.rows[0];
    if (!otp || new Date(otp.expires_at) < new Date()) return c.json({ ok: false, error: "expired" }, 401);
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return c.json({ ok: false, error: "too_many_attempts" }, 429);
    if (otp.code_hash !== hashOtp(phoneNorm, code)) {
      await pool.query("UPDATE acct_otp SET attempts=attempts+1 WHERE phone_norm=$1", [phoneNorm]);
      return c.json({ ok: false, error: "wrong_code" }, 401);
    }
    await pool.query("DELETE FROM acct_otp WHERE phone_norm=$1", [phoneNorm]);

    const name = String(b.name || "").trim().slice(0, 60) || null;
    await pool.query(
      `INSERT INTO acct_customers(phone_norm, name, last_login_at) VALUES ($1,$2,NOW())
       ON CONFLICT (phone_norm) DO UPDATE
         SET name = COALESCE(EXCLUDED.name, acct_customers.name), last_login_at=NOW()`,
      [phoneNorm, name]);

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query("INSERT INTO acct_sessions(token, phone_norm) VALUES ($1,$2)", [token, phoneNorm]);

    // TabSense directory, Omar's rule: link if known, create only if new —
    // and never let a POS hiccup block a login.
    linkOrCreateTsCustomer(phoneNorm).catch((e) =>
      console.error("[accounts] ts link failed:", e.message));

    return c.json({ ok: true, token, phone: phoneNorm, name });
  });

  async function linkOrCreateTsCustomer(phoneNorm) {
    const acct = (await pool.query("SELECT * FROM acct_customers WHERE phone_norm=$1", [phoneNorm])).rows[0];
    if (!acct || acct.ts_customer_id) return;
    // already in the POS directory? just point at it.
    const known = await pool.query(
      "SELECT customer_id, name FROM ts_customers WHERE phone_norm=$1 LIMIT 1", [phoneNorm]);
    if (known.rowCount) {
      // البيانات الموجودة على TabSense هي الأصل (طلب عمر 2026-08-14): اسم
      // العميل المسجل هناك بيكسب على اللي اتكتب وقت الدخول — الربط بيحصل
      // مرة واحدة فمفيش دهس متكرر لاسم اختاره العميل بعدها.
      const tsName = String(known.rows[0].name || "").trim();
      await pool.query(
        `UPDATE acct_customers SET ts_customer_id=$2, ts_sync=$3,
                name = COALESCE(NULLIF($4,''), name)
          WHERE phone_norm=$1`,
        [phoneNorm, known.rows[0].customer_id,
         jb({ linked: "existing", at: new Date().toISOString() }),
         plausibleName(tsName) ? tsName : ""]);
      return;
    }
    // genuinely new: create — respecting the silent-reject rules inside
    // tabsense.createCustomer. The answer is recorded, not trusted; the
    // ts_customers worker sync is what proves the record exists.
    if (!env("TABSENSE_EMAIL")) return; // dashboard connector not configured
    const res = await tabsense.createCustomer({
      firstName: acct.name || "عميل أونلاين",
      phone: phoneNorm,
    });
    await pool.query("UPDATE acct_customers SET ts_sync=$2 WHERE phone_norm=$1",
      [phoneNorm, jb({ create: res, at: new Date().toISOString() })]);
  }

  /* ── profile ── */
  app.get("/api/account/me", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    return c.json({
      ok: true,
      phone: acct.phone_norm, name: acct.name,
      // customer_id (customer-id.js): GA4 user_id / Clarity identify / التطبيق — مش الجوال
      uid: await customerId(pool, acct.phone_norm),
      addresses: await addressesOf(acct),
      linkedToPos: Boolean(acct.ts_customer_id),
      // الخصم الدائم للرقم (مثلاً «خصم الملاك ٥٠٪») — عشان المتجر يعرضه في السلة قبل الدفع.
      // الحساب النهائي بيفضل على السيرفر وقت الـcheckout (مابيتطبقش على العروض).
      discount: await customerDiscount(acct.phone_norm),
    });
  });

  /* ── رسايل العروض: رجوع الاشتراك من الشيك أوت (١٧/٩) ──
     المتجر بيسأل «موقوف؟» لعميل متحقق بالـOTP بس، ولو موقوف بيعرض مربع
     «تبي توصلك عروض فريش كاتس؟» فاضي. الرجوع بيحصل بس لو العميل علّم عليه. */
  app.get("/api/account/marketing", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    const r = await pool.query("SELECT opted_out_at FROM cms_contacts WHERE phone_norm=$1", [acct.phone_norm]).catch(() => ({ rows: [] }));
    return c.json({ ok: true, optedOut: Boolean(r.rows[0]?.opted_out_at) });
  });
  app.post("/api/account/marketing", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch {}
    if (b.subscribe !== true) return c.json({ ok: false, error: "subscribe_must_be_true" }, 400);
    const r = await pool.query(
      `UPDATE cms_contacts SET opted_out_at=NULL, optout_source=NULL, optout_reason=NULL, optout_by=NULL
        WHERE phone_norm=$1 AND opted_out_at IS NOT NULL RETURNING 1`, [acct.phone_norm]);
    if (r.rowCount) {
      await pool.query("INSERT INTO cms_optout_log(phone_norm, action, source, ua) VALUES ($1,'resubscribe','checkout_optin',$2)",
        [acct.phone_norm, String(c.req.header("user-agent") || "").slice(0, 200) || null]).catch(() => {});
    }
    return c.json({ ok: true, changed: r.rowCount > 0 });
  });

  app.put("/api/account/me", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return c.json({ ok: false, error: "name_required" }, 400);
    await pool.query("UPDATE acct_customers SET name=$2 WHERE phone_norm=$1", [acct.phone_norm, name]);
    return c.json({ ok: true, name });
  });

  /* addresses — الشكل والقواعد فوق عند cleanAddress/normalizeAddresses.

     كل عنوان بمعرّف ثابت. قبل كده كان الحذف بالترتيب في المصفوفة — تبويبتين
     مفتوحتين، كل واحدة تحذف عنوان، والنتيجة إن عنوان تالت غلط هو اللي يطير.
     التعديل بالمعرّف بيمنع ده تماماً. القائمة بتتخزن مترتّبة (الافتراضي
     أولاً) فالترتيب المخزّن = اللي راجع للواجهة. */
  const writeAddresses = (phoneNorm, list) =>
    pool.query("UPDATE acct_customers SET addresses=$2 WHERE phone_norm=$1", [phoneNorm, jb(list)]);

  /* عناوين قديمة من غير id/is_default: نثبّتها مرة واحدة، عشان المعرّفات
     اللي الواجهة شافتها هي نفسها اللي هتبعتها في التعديل/الحذف. */
  async function addressesOf(acct) {
    const raw = Array.isArray(acct.addresses) ? acct.addresses : [];
    const list = sortAddresses(normalizeAddresses(raw));
    const legacy = raw.some((a) => !a || !a.id || typeof a.is_default !== "boolean");
    if (legacy && list.length) {
      await writeAddresses(acct.phone_norm, list).catch((e) =>
        console.error("[accounts] address normalize failed:", e.message));
    }
    return list;
  }

  /* يستخدمها shop.js لما طلب توصيل يتأكد دفعه — عشان العميل اللي طلب كضيف
     يلاقي عنوانه جاهز أول ما يسجل دخول، واللي عنده العنوان أصلاً يطلع له
     فوق (الأحدث استخداماً). من غير ده وعد تسجيل الدخول («عناوينك محفوظة»)
     بيبقى كلام مش صحيح. */
  async function saveAddressFor(phoneNorm, raw) {
    if (!/^5\d{8}$/.test(String(phoneNorm || ""))) return null;
    if (!(raw && validCoords(raw))) return null;
    const acct = (await pool.query(
      "SELECT addresses FROM acct_customers WHERE phone_norm=$1", [phoneNorm])).rows[0];
    if (!acct) return null; // من غير حساب مفيش دفتر عناوين نحفظ فيه
    const next = recordUsedAddress(acct.addresses || [], raw);
    if (!next) return null;
    await writeAddresses(phoneNorm, next);
    return next;
  }

  app.get("/api/account/addresses", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    return c.json({ ok: true, addresses: await addressesOf(acct) });
  });

  app.post("/api/account/addresses", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!b || typeof b !== "object" || !validCoords(b)) {
      return c.json({ ok: false, error: "location_required" }, 400);
    }
    const { list, address } = addAddress(acct.addresses || [], b);
    await writeAddresses(acct.phone_norm, list);
    return c.json({ ok: true, address, addresses: list });
  });

  /* تعديل عنوان قائم — قبل كده كان لازم العميل يمسح ويحدد الدبوس من الأول
     عشان رقم مبنى غلط. */
  app.put("/api/account/addresses/:id", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!b || typeof b !== "object") return c.json({ ok: false, error: "bad json" }, 400);
    const r = updateAddress(acct.addresses || [], String(c.req.param("id")), b);
    if (!r) return c.json({ ok: false, error: "not_found" }, 404);
    if (r.error) return c.json({ ok: false, error: r.error }, 400);
    await writeAddresses(acct.phone_norm, r.list);
    return c.json({ ok: true, address: r.address, addresses: r.list });
  });

  /* بالمعرّف — والترتيب مقبول مؤقتاً للنسخ القديمة من الواجهة. حذف الافتراضي
     بيرقّي الأحدث استخداماً. */
  app.delete("/api/account/addresses/:id", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    const next = removeAddress(acct.addresses || [], String(c.req.param("id")));
    await writeAddresses(acct.phone_norm, next);
    return c.json({ ok: true, addresses: next });
  });

  /* order history: the WHOLE relationship, not just the online slice.
     Omar 2026-08-14: «العميل لما يسجل دخوله يلاقي طلباته اللي طلبها قبل
     كده سواء صالة/تيك أواي/توصيل». The POS cache (ts_orders) is joined by
     the same phone identity the analytics use; orders that ARE our online
     orders are excluded so nothing shows twice. Online rows keep their
     items (reorder works); POS rows are display-only — TabSense's public
     surface doesn't give us their line items. */
  app.get("/api/account/orders", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    const rows = (await pool.query(
      `SELECT order_no, status, option, items, subtotal, delivery_fee, tip, total, created_at
         FROM shop_orders
        WHERE phone_norm=$1 AND status <> 'expired'
        ORDER BY created_at DESC LIMIT 50`, [acct.phone_norm])).rows;

    const settings = await getSettingsData();
    const pos = (await pool.query(
      `SELECT o.order_id, o.order_date, o.calendar_day, o.order_option, o.order_type,
              o.total, o.payments
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
        WHERE o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'
          AND COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) = $1
          AND o.order_id NOT IN (SELECT pos_order_id FROM shop_orders WHERE pos_order_id IS NOT NULL)
        ORDER BY o.order_date DESC NULLS LAST LIMIT 50`, [acct.phone_norm])).rows;

    const posOrders = pos.map((r) => {
      const app = deliveryAppOf(r.payments, settings);
      const opt = String(r.order_option || "");
      const label = app ? `توصيل عبر ${app}`
        : /external/i.test(String(r.order_type || "")) ? "توصيل تطبيقات"
        : /take/i.test(opt) ? "تيك أواي"
        : /deliver/i.test(opt) ? "توصيل المطعم"
        : "في الصالة";
      return {
        kind: "pos", order_id: r.order_id, label,
        total: Number(r.total) || 0,
        at: r.order_date || r.calendar_day,
      };
    });

    return c.json({ ok: true, orders: rows, posOrders });
  });

  /* Line items of ONE past POS order — lazily fetched from the TabSense
     dashboard (the same fetchOrderProducts the analytics backfill uses) and
     cached in ts_order_items, so each order costs one upstream call ever.
     Ownership is checked by the same phone identity as the history list. */
  app.get("/api/account/orders/:orderId/items", async (c) => {
    const acct = await customerOf(c);
    if (!acct) return c.json({ ok: false, error: "unauthorized" }, 401);
    const orderId = String(c.req.param("orderId"));
    const own = await pool.query(
      `SELECT 1 FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
        WHERE o.order_id = $2
          AND COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) = $1`,
      [acct.phone_norm, orderId]);
    if (!own.rowCount) return c.json({ ok: false, error: "not_found" }, 404);

    let items = (await pool.query(
      "SELECT name, qty, amount, note FROM ts_order_items WHERE order_id=$1 ORDER BY idx",
      [orderId])).rows;
    if (!items.length && env("TABSENSE_EMAIL")) {
      try {
        const rows = await tabsense.fetchOrderProducts(orderId);
        for (let i = 0; i < rows.length; i++) {
          await pool.query(
            `INSERT INTO ts_order_items (order_id, idx, name, qty, amount, note)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (order_id, idx) DO UPDATE SET
               name=EXCLUDED.name, qty=EXCLUDED.qty, amount=EXCLUDED.amount, note=EXCLUDED.note`,
            [orderId, i, rows[i].name, rows[i].qty, rows[i].amount, rows[i].note || ""]);
        }
        items = rows;
      } catch (e) {
        console.error(`[accounts] order items fetch failed for ${orderId}:`, e.message);
      }
    }
    return c.json({ ok: true, items });
  });

  app.post("/api/account/logout", async (c) => {
    const h = c.req.header("Authorization") || "";
    const m = h.match(/^Bearer cust:([a-f0-9]{48,96})$/i);
    if (m) await pool.query("DELETE FROM acct_sessions WHERE token=$1", [m[1]]);
    return c.json({ ok: true });
  });

  /* admin: the dashboard's customer-accounts list */
  app.get("/api/account/admin/list", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `SELECT a.phone_norm, a.name, a.ts_customer_id, a.discount_percent, a.discount_label,
              a.created_at, a.last_login_at,
              count(o.order_no)::int AS online_orders,
              COALESCE(sum(o.total),0)::numeric AS online_spend
         FROM acct_customers a
         LEFT JOIN shop_orders o ON o.phone_norm = a.phone_norm AND o.status NOT IN ('expired','pending_payment')
        GROUP BY a.phone_norm
        ORDER BY a.discount_percent DESC, a.created_at DESC LIMIT 500`)).rows;
    return c.json({ ok: true, accounts: rows });
  });

  /* admin: grant/update/remove a standing discount for one phone. Creates the
     account row if the person never logged in — the discount works from the
     first order either way. */
  app.post("/api/account/admin/discount", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const phone = normPhone(b.phone);
    if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "invalid_phone" }, 400);
    const pct = Math.max(0, Math.min(100, Number(b.percent) || 0));
    await pool.query(
      `INSERT INTO acct_customers(phone_norm, name, discount_percent, discount_label)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (phone_norm) DO UPDATE SET
         discount_percent=$3, discount_label=$4,
         name = COALESCE(acct_customers.name, EXCLUDED.name)`,
      [phone, String(b.name || "").trim().slice(0, 60) || null, pct,
       pct > 0 ? String(b.label || "خصم خاص").slice(0, 40) : null]);
    return c.json({ ok: true, phone, percent: pct });
  });

  /* shop.js asks: does this phone carry a standing discount? */
  async function customerDiscount(phoneNorm) {
    const r = await pool.query(
      "SELECT discount_percent, discount_label FROM acct_customers WHERE phone_norm=$1", [phoneNorm]);
    const row = r.rows[0];
    if (!row || !(Number(row.discount_percent) > 0)) return null;
    return { percent: Number(row.discount_percent), label: row.discount_label || "خصم خاص" };
  }

  /* الجلسات المنتهية بتتراكم للأبد من غير ده */
  setInterval(() => {
    pool.query(`DELETE FROM acct_sessions WHERE last_seen_at < NOW() - INTERVAL '200 days'`)
      .catch(() => {});
  }, 24 * 3600_000).unref?.();

  return { customerOf, sendSms, customerDiscount, saveAddressFor };
}
