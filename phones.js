/* ═══════════════════════════════════════════════════════════════════════════
   👁 إظهار جوال العميل في لوحة التحكم — القاعدة الواحدة (٢١/٩)

   قرار عمر: «عايز رقم الموبايل ميظهرش مشفر في لوحة التحكم في أي مكان».
   فالرقم بقى كامل وقابل للنسخ في كل شاشات اللوحة — من غير ما نكسر الأدوار:

     الرقم الكامل = دورك عنده «عرض» (أو «تعديل») على قسم «العملاء».

   يعني المالك والتسويق والعمليات بيشوفوا الرقم؛ المحاسبة والمطبخ لأ
   (customers = none في DEFAULT_PERMS) — ودول أصلاً مش بيفتحوا شاشات العملاء،
   بس لو وصلوا لشاشة فيها جوال (زي رحلة العميل للمحاسبة) بيفضل مقنّع.

   اللي **ماتغيّرش**: شاشة المطبخ (KDS) مافيهاش جوال خالص، صفحة تتبّع العميل،
   وصفحة المندوب — دي مش لوحة تحكم.

   السجل: كل مرة عضو فريق (مش المالك) يفتح شاشة فيها أرقام كاملة بيتكتب سطر
   في cms_audit — مرة واحدة كل ساعة لكل (مستخدم × مسار) عشان مايغرقش السجل.
═══════════════════════════════════════════════════════════════════════════ */

import { maskPhone } from "./identity.js";

/** القسم اللي بيتحكم في رؤية الأرقام الكاملة. */
export const PHONE_SECTION = "customers";

/** شكل الجوال في أي رد من اللوحة: كامل + النسخة المقنّعة كـfallback. */
export function phoneOut(pn, full) {
  const norm = String(pn || "").replace(/\D/g, "");
  if (!norm) return { phone: null, phoneMasked: "" };
  return { phone: full ? "0" + norm : null, phoneMasked: maskPhone(norm) };
}

/** هل الدور ده يشوف الأرقام كاملة؟ (صافية — متجرّبة أوفلاين) */
export function roleSeesPhones(role, perms) {
  if (role === "owner") return true;
  const lvl = perms?.[role]?.[PHONE_SECTION] || "none";
  return lvl === "view" || lvl === "edit";
}

/* ── بوابة الطلب: بتتبني مرة واحدة في index.js وبتتحط على moduleCtx ────── */
const seen = new Map(); // "userId|path" → آخر تسجيل (ms)
const LOG_EVERY_MS = 3600_000;

export function makePhoneGate({ whoami, effectivePerms, isAdminToken, pool }) {
  return async function canSeePhones(c) {
    try {
      if (isAdminToken && isAdminToken(c)) return true;        // مفتاح الأدمن = المالك
      const u = await whoami(c);
      if (!u) return false;
      if (u.role === "owner") return true;
      const perms = await effectivePerms();
      if (!roleSeesPhones(u.role, perms)) return false;
      noteAccess(pool, u, c);
      return true;
    } catch { return false; }
  };
}

function noteAccess(pool, u, c) {
  if (!pool) return;
  const path = String(c?.req?.path || "");
  const key = `${u.id}|${path}`;
  const now = Date.now();
  if (now - (seen.get(key) || 0) < LOG_EVERY_MS) return;
  seen.set(key, now);
  if (seen.size > 2000) seen.clear();
  pool.query(
    `INSERT INTO cms_audit(actor_id, actor_name, role, method, path, section, note)
     VALUES ($1,$2,$3,'GET',$4,$5,$6)`,
    [u.id, u.name || "فريق", u.role, path, PHONE_SECTION, "شاف أرقام جوالات كاملة"],
  ).catch(() => {});
}
