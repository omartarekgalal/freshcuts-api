/* ═══════════════════════════════════════════════════════════════════════════
   🎁 الولاء — الأجزاء الـpure (الإعدادات، نص الرسالة، مين ياخد SMS) — ٥/١٠/٢٠٢٦

   قرار عمر: «مكافآت الولاء لازم تتستخدم». ٨ كوبونات اتعملت واتستخدم صفر،
   لأنها كانت إشعار بس (الوصول ~٢٨). دلوقتي:
     (أ) الكوبون مربوط بجوال العميل (shop_coupons.phone_norm) والدفع بيطبّقه
         لوحده للعميل المسجّل دخول (/api/account/me → rewards). السيرفر هو اللي
         بيتحقق: نفس الجوال، مش منتهي، مااتستخدمش.
     (ب) SMS واحدة بالكود لما المكافأة تتعمل — من المُرسل التسويقي وبكل قواعده:
         ساعات الهدوء، الموقوفين، حاجبين الإعلانات (مافيش تحويل للمُرسل الخدمي —
         ده نفس اللي السلة المتروكة وبديل الواتساب بيعملوه)، الموظفين وأرقام
         التجارب، السقف اليومي والميزانية، وسطر الإيقاف. جزئين بالكتير، ورابط
         متتبّع /l/loy-<code> (utm_source=sms, utm_medium=loyalty).
         مابنطبّقش «الفاصل بين الرسايل» عليها: دي مكافأة العميل كسبها وصلاحيتها
         ١٤ يوم — لو استنت ٢١ يوم فاصل كانت هتنتهي قبل ما توصله.
═══════════════════════════════════════════════════════════════════════════ */
import { smsParts } from "./smsrules.js";
import { LOYALTY_MIN_DEFAULT, loyaltyMinTotal } from "./couponmin.js";

export const LOYALTY_SLUG = "loy";
export const LOYALTY_DEFAULT = Object.freeze({
  enabled: false, every: 5, reward: "free_delivery", percent: 10, validDays: 14, startedAt: null,
  // رسالة SMS بالكود لما المكافأة تتعمل — مفتاح في إعدادات الولاء (افتراضي شغّال)
  smsEnabled: true,
  // أقل طلب تتستخدم عليه المكافأة (قرار عمر ١٠/١٠) — ٠ = من غير حد
  minTotal: LOYALTY_MIN_DEFAULT,
});

export function loyaltyCfgOf(settings) {
  const raw = (((settings || {}).cms || {}).loyalty) || {};
  const c = { ...LOYALTY_DEFAULT, ...(raw && typeof raw === "object" ? raw : {}) };
  c.smsEnabled = c.smsEnabled !== false;
  c.minTotal = loyaltyMinTotal(c);
  return c;
}

/* PUT /api/cms/loyalty: نفس التنظيف القديم + smsEnabled (أي حاجة غير false = شغّال) */
export function loyaltyCfgFromBody(b, prev, nowIso = new Date().toISOString()) {
  const enabled = b.enabled === true;
  return {
    enabled,
    every: Math.min(20, Math.max(2, Number(b.every) || 5)),
    reward: b.reward === "percent" ? "percent" : "free_delivery",
    percent: Math.min(50, Math.max(5, Number(b.percent) || 10)),
    validDays: Math.min(90, Math.max(3, Number(b.validDays) || 14)),
    // أول تفعيل بيثبّت نقطة البداية؛ الإيقاف والتشغيل تاني مابيعدّش التاريخ
    startedAt: enabled ? (prev.startedAt || nowIso) : prev.startedAt,
    smsEnabled: b.smsEnabled === undefined ? prev.smsEnabled !== false : b.smsEnabled !== false,
    // لو مااتبعتش: يفضل الحالي
    minTotal: loyaltyMinTotal(b.minTotal === undefined ? prev : b),
  };
}

/* «2026-10-18» → «18/10» */
export const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${Number(m[3])}/${Number(m[2])}` : "";
};

/* نص الرسالة: أطول صيغة تدخل في جزئين UCS-2 مع الرابط وسطر الإيقاف.
   الصيغ من الأطول للأقصر — سطر إيقاف طويل (وضع «الاتنين») بيختار الأقصر.
   null = ولا صيغة دخلت ⇒ مابنبعتش. فصحى بسيطة (العملاء في جدة). */
export function loyaltySmsText({ code, expires, link, optout, reward = "free_delivery", percent = 10, minTotal = 0 }) {
  const d = shortDate(expires);
  const prize = reward === "percent" ? `خصم ${Number(percent) || 10}٪` : "توصيل مجاني";
  const until = d ? ` حتى ${d}` : "";
  const min = Number(minTotal) > 0 ? ` للطلبات من ${Number(minTotal)} ر.س` : "";
  const variants = [
    `🎁 كسبت ${prize}${min} من فريش كاتس! كودك ${code} ينطبق تلقائياً${until}: ${link}`,
    `🎁 كسبت ${prize}${min} من فريش كاتس، ينطبق تلقائياً${until}: ${link}`,
    ...(min ? [`🎁 ${prize}${min} من فريش كاتس، ينطبق تلقائياً${until}: ${link}`, `🎁 ${prize}${min} من فريش كاتس${until}: ${link}`] : []),
    `🎁 كسبت ${prize} من فريش كاتس! كودك ${code} ينطبق تلقائياً${until}: ${link}`,
    `🎁 كسبت ${prize} من فريش كاتس، ينطبق تلقائياً${until}: ${link}`,
    `🎁 ${prize} من فريش كاتس${until}: ${link}`,
  ];
  for (const v of variants) {
    const body = optout ? `${v}\n${optout}` : v;
    if (smsParts(body) <= 2) return body;
  }
  return null;
}

/* مين ياخد SMS دلوقتي. rows = مكافآت لسه في الطابور (sms_status NULL) وصالحة
   (مااتستخدمتش ومش منتهية) — مترتّبين بأي ترتيب. رسالة واحدة لكل رقم: أقرب
   مكافأة هتنتهي، والباقي «merged» (الدفع بيطبّقهم لوحده بعد كده). */
export function planLoyaltySms(rows, { staff = new Set(), testSet = new Set(), optedOut = new Set(), adBlocked = new Set(), minDaysLeft = 1, today = new Date().toISOString().slice(0, 10) } = {}) {
  const send = [], skip = [], merged = [];
  const byPhone = new Map();
  for (const r of rows) {
    if (!byPhone.has(r.phone_norm)) byPhone.set(r.phone_norm, []);
    byPhone.get(r.phone_norm).push(r);
  }
  const daysLeft = (exp) => (exp ? Math.round((Date.parse(exp) - Date.parse(today)) / 86400000) : Infinity);
  for (const [pn, list] of byPhone) {
    list.sort((a, b) => String(a.exp || "9999").localeCompare(String(b.exp || "9999")) || a.reward_no - b.reward_no);
    const [head, ...rest] = list;
    const reason = staff.has(pn) ? "staff" : testSet.has(pn) ? "test"
      : optedOut.has(pn) ? "opted_out" : adBlocked.has(pn) ? "ad_blocked"
      : daysLeft(head.exp) < minDaysLeft ? "expiring" : null;
    if (reason) { for (const r of list) skip.push({ row: r, reason }); continue; }
    send.push(head);
    merged.push(...rest);
  }
  return { send, skip, merged };
}
