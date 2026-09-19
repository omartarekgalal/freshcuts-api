/* ═══════════════════════════════════════════════════════════════════════════
   UPLOAD GATE — البوابة الوحيدة لأي رقم جوال رايح لمنصة إعلانات (PDPL / O6)

   نوعين رفع بيعدّوا من هنا:
     lists    قوايم العملاء المشفّرة (audiences.js → Custom Audiences / SAM / DMP)
     offline  تحويلات نقطة البيع/الصالة (ads.syncOrders → CAPI physical_store)

   الاتنين **مقفولين افتراضياً** لحد رد المحامي (السؤال في consent.js):
     ap_settings.data.syncAudiences = true   ⇐ يفتح القوايم (أي قيمة تانية/مش موجود = مقفول)
     ap_settings.data.posConversions = true  ⇐ يفتح تحويلات الصالة (أي قيمة تانية = مقفول)
   طلبات المتجر الإلكتروني (shop_orders) مش «أوفلاين» — دي مشتريات الموقع
   نفسه وبتتبعت من funnel.js؛ شبكة الأمان في syncOrders بتفضل تبعتها.

   ولما يتفتحوا، الضمانات دي بتشتغل على طول (مش اختيارية):
     ١) SHA-256 بس — الرقم الخام عمره ما بيطلع (ads.js hashPhoneDigits/Plus).
     ٢) أي رقم عامل إلغاء اشتراك (cms_contacts.opted_out_at) بيتشال، وكمان أرقام
        الفريق (settings.delivery.alertPhones/newOrderPhones، cms.staffPhones،
        cms.campaigns.excludePhones، journey.staffPhones)، السفراء (ambassadors)،
        وأي رقم عليه طلب اختبار (shop_orders.is_test) أو كوبون المالك OMAR-9X4T.
     ٣) أي رقم مالوش موافقة إعلانات (mk_consent.ads_consent) بيتشال —
        ما عدا لو ap_settings.data.consentOnly = false **صريح** (قرار قانوني
        مكتوب إن المصلحة المشروعة كفاية). الافتراضي: موافقة مطلوبة.
     ٤) كل رفع — اتعمل أو اتمنع — بيتسجّل في aud_upload_log **بالأعداد بس**
        (كام مرشّح، كام اتشال بإلغاء، كام اتشال من غير موافقة، كام اتبعت).
        مفيش ولا رقم في السجل.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { consentedSet } from "./consent.js";

let schemaP = null;
function ensureSchema(pool) {
  if (!schemaP) {
    schemaP = pool.query(`
      CREATE TABLE IF NOT EXISTS aud_upload_log (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,              -- lists | offline
        platform TEXT,
        segment TEXT,
        trigger TEXT,
        enabled BOOLEAN NOT NULL,
        candidates INT NOT NULL DEFAULT 0,
        excluded_optout INT NOT NULL DEFAULT 0,
        excluded_no_consent INT NOT NULL DEFAULT 0,
        excluded_staff INT NOT NULL DEFAULT 0,
        kept INT NOT NULL DEFAULT 0,
        sent INT,
        status TEXT,                     -- blocked | sent | failed | dry
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS aud_upload_log_time_idx ON aud_upload_log(created_at DESC);
      ALTER TABLE aud_upload_log ADD COLUMN IF NOT EXISTS excluded_staff INT NOT NULL DEFAULT 0;
    `).catch((e) => { schemaP = null; throw e; });
  }
  return schemaP;
}

/** قراءة المفاتيح. أي فشل ⇒ مقفول + موافقة مطلوبة (الأضيق). */
export async function uploadPolicy(pool) {
  try {
    const r = await pool.query(
      `SELECT data->>'syncAudiences' sa, data->>'posConversions' pc, data->>'consentOnly' co FROM ap_settings WHERE id=1`);
    const x = r.rows[0] || {};
    return policyOf(x.sa, x.pc, x.co);
  } catch {
    return { lists: false, offline: false, requireConsent: true, readFailed: true };
  }
}
/** صافية للاختبار: true صريح بس بيفتح. consentOnly=false صريح بس بيشيل شرط الموافقة. */
export function policyOf(sa, pc, co) {
  const t = (v) => v === true || String(v).toLowerCase() === "true";
  const f = (v) => v === false || String(v).toLowerCase() === "false";
  return { lists: t(sa), offline: t(pc), requireConsent: !f(co) };
}

const nine = (s) => {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0") && d.length === 10) d = d.slice(1);
  return d;
};

async function optedOut(pool) {
  try {
    const r = await pool.query(`SELECT phone_norm FROM cms_contacts WHERE opted_out_at IS NOT NULL`);
    return new Set(r.rows.map((x) => nine(x.phone_norm)));
  } catch { return null; }   // مانقدرش نعرف مين لغى ⇒ المتصل بيمنع الرفع
}

/* أرقام مش عملاء: الفريق + السفراء + أرقام الاختبار/المالك. فشل أي قراءة ⇒ null
   (المتصل بيمنع الرفع كله — رفع رقم موظف أهون منه ماحدش يرفع، بس الأهون من الاتنين
   إننا مانرفعش وإحنا مش شايفين). */
export const OWNER_COUPONS = ["OMAR-9X4T"];
export function staffFromSettings(d = {}) {
  const out = new Set();
  const add = (v) => {
    const list = Array.isArray(v) ? v : String(v || "").split(/[,\s]+/);
    for (const x of list) { const n = nine(typeof x === "object" && x ? x.phone : x); if (/^5\d{8}$/.test(n)) out.add(n); }
  };
  add(d?.delivery?.alertPhones); add(d?.delivery?.newOrderPhones);
  add(d?.cms?.staffPhones); add(d?.cms?.campaigns?.excludePhones); add(d?.journey?.staffPhones);
  return out;
}
async function nonCustomers(pool) {
  try {
    const out = new Set();
    const s = await pool.query(`SELECT data FROM settings WHERE id=1`);
    for (const n of staffFromSettings(s.rows[0]?.data || {})) out.add(n);
    const a = await pool.query(`SELECT phone_norm FROM ambassadors WHERE COALESCE(phone_norm,'') <> ''`).catch(() => ({ rows: [] }));
    for (const x of a.rows) out.add(nine(x.phone_norm));
    const t = await pool.query(
      `SELECT DISTINCT phone_norm FROM shop_orders WHERE COALESCE(phone_norm,'') <> ''
          AND (is_test IS TRUE OR upper(COALESCE(coupon,'')) = ANY($1::text[]))`, [OWNER_COUPONS]);
    for (const x of t.rows) out.add(nine(x.phone_norm));
    return out;
  } catch { return null; }
}

/** فلترة قايمة أرقام (أي شكل). بترجع { phones, stats } أو { blocked } لو الفلترة نفسها فشلت. */
export async function filterPhones(pool, phones, policy) {
  const out = await optedOut(pool);
  if (!out) return { blocked: "مقدرناش نقرا قايمة إلغاء الاشتراك" };
  const staff = await nonCustomers(pool);
  if (!staff) return { blocked: "مقدرناش نقرا أرقام الفريق/الاختبار" };
  let consent = null;
  if (policy.requireConsent) {
    try { consent = await consentedSet(pool); } catch { return { blocked: "مقدرناش نقرا الموافقات" }; }
  }
  const stats = { candidates: phones.length, excluded_optout: 0, excluded_staff: 0, excluded_no_consent: 0, kept: 0 };
  const keep = [];
  for (const p of phones) {
    const n = nine(p);
    if (!/^5\d{8}$/.test(n)) { stats.excluded_no_consent++; continue; }
    if (out.has(n)) { stats.excluded_optout++; continue; }
    if (staff.has(n)) { stats.excluded_staff++; continue; }
    if (consent && !consent.has(n)) { stats.excluded_no_consent++; continue; }
    keep.push(p);
  }
  stats.kept = keep.length;
  return { phones: keep, stats };
}

export async function logUpload(pool, row) {
  try {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO aud_upload_log (id, kind, platform, segment, trigger, enabled, candidates, excluded_optout, excluded_no_consent, kept, sent, status, note, excluded_staff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [crypto.randomUUID(), row.kind, row.platform || null, row.segment || null, row.trigger || null, !!row.enabled,
       row.candidates || 0, row.excluded_optout || 0, row.excluded_no_consent || 0, row.kept || 0,
       row.sent ?? null, row.status || null, row.note ? String(row.note).slice(0, 300) : null, row.excluded_staff || 0]);
  } catch (e) { console.error("[uploadgate] log failed:", e.message); }
}

/** تحويلات الصالة: صفوف loadOrders → اللي مسموح يتبعت.
 *  طلب متجر (shop_orders.pos_order_id) بيعدّي دايماً — ده شرا موقع مش أوفلاين.
 *  طلب صالة: مقفول ⇒ بيتشال؛ مفتوح ⇒ لازم رقم مش لاغي و(لو مطلوب) موافق. */
export async function gateOfflineRows(pool, rows, { trigger = "sync" } = {}) {
  const policy = await uploadPolicy(pool);
  let web = new Set();
  const ids = rows.map((r) => String(r.order_id));
  if (ids.length) {
    try {
      const r = await pool.query(`SELECT pos_order_id FROM shop_orders WHERE pos_order_id = ANY($1::text[])`, [ids]);
      web = new Set(r.rows.map((x) => String(x.pos_order_id)));
    } catch { /* مانعرفش مين ويب ⇒ كله يتعامل أوفلاين (الأضيق) */ }
  }
  const webRows = rows.filter((r) => web.has(String(r.order_id)));
  const pos = rows.filter((r) => !web.has(String(r.order_id)));
  const stats = { candidates: pos.length, excluded_optout: 0, excluded_no_consent: 0, kept: 0 };
  let keptPos = [];
  let status = "blocked", note = "posConversions مقفول (O6)";
  if (policy.offline && pos.length) {
    const f = await filterPhones(pool, pos.map((r) => r.phone_norm || ""), policy);
    if (f.blocked) note = f.blocked;
    else {
      const ok = new Set(f.phones.map(nine));
      keptPos = pos.filter((r) => r.phone_norm && ok.has(nine(r.phone_norm)));
      stats.excluded_optout = f.stats.excluded_optout;
      stats.excluded_staff = f.stats.excluded_staff;
      stats.excluded_no_consent = f.stats.excluded_no_consent;
      status = "sent"; note = null;
    }
  }
  stats.kept = keptPos.length;
  if (pos.length) await logUpload(pool, { kind: "offline", trigger, enabled: policy.offline, ...stats, status, note });
  return { rows: [...webRows, ...keptPos], policy, stats, web: webRows.length };
}
