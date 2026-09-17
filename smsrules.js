/* ═══════════════════════════════════════════════════════════════════════════
   SMS RULES — قواعد الرسايل التسويقية في مكان واحد (١٧ سبتمبر ٢٠٢٦)

   قرار عمر: «اسم المرسل مفعل وكله تمام ابدا … حملات الsms». الشروط اللي
   بتحكم أي رسالة تسويقية (حملة / أتمتة / سلة متروكة):
     • من المُرسل التسويقي بس، ومعاها رابط الإيقاف /u/<code>
     • مفيش إرسال في ساعات الهدوء (قبل ١٢ الضهر وبعد ١٠ بالليل بتوقيت الرياض)
     • ٢١ يوم بين أي رسالتين تسويقيتين لنفس الرقم (الحملات والأتمتة)
     • لازم يكون طلب مننا مباشرة (صالة/سفري/موقع) — أرقام التطبيقات بس ممنوعة
     • الموظفين وأرقام التجارب برا
     • جزئين UCS-2 كحد أقصى
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

export const QUIET_START = 22; // من ١٠ بالليل
export const QUIET_END = 12;   // لحد ١٢ الضهر

export function riyadhParts(now = new Date()) {
  const d = new Date(now.getTime() + 3 * 3600_000); // الرياض UTC+3 طول السنة
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
}
export function inQuietHours(now = new Date(), start = QUIET_START, end = QUIET_END) {
  const { hour } = riyadhParts(now);
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}

/* أجزاء الرسالة زي ما تقنيات بتحسبها: أي حرف برا GSM-7 → UCS-2 (٧٠ / ٦٧ للجزء).
   بنعدّ وحدات UTF-16 (الإيموجي = ٢). */
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";
export function smsParts(text) {
  const t = String(text || "");
  const gsm = [...t].every((ch) => GSM.includes(ch) || GSM_EXT.includes(ch));
  if (gsm) {
    const n = [...t].reduce((s, ch) => s + (GSM_EXT.includes(ch) ? 2 : 1), 0);
    return n <= 160 ? 1 : Math.ceil(n / 153);
  }
  const n = t.length; // UTF-16 units
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

/* holdout ثابت لكل (حملة، رقم) — نفس الرقم مايتنقلش بين المجموعتين لو اتحسب تاني */
export function inHoldout(campaignId, phone, pct) {
  const p = Number(pct) || 0;
  if (p <= 0) return false;
  const h = crypto.createHash("sha1").update(`${campaignId}:${phone}`).digest();
  return (h.readUInt32BE(0) % 100) < Math.min(50, p);
}

export const normLocal = (p) => {
  const d = String(p || "").replace(/\D/g, "").replace(/^00/, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? d : null;
};

/* أرقام مستبعدة دايماً: إنذارات الإدارة + رسايل الطلبات + قايمة استبعاد الحملات */
export function staffPhoneSet(settings = {}) {
  const s = settings || {};
  const out = new Set();
  const add = (v) => {
    const list = Array.isArray(v) ? v : String(v || "").split(/[,\s]+/);
    for (const x of list) { const n = normLocal(typeof x === "object" && x ? x.phone : x); if (n) out.add(n); }
  };
  add(s.delivery?.alertPhones); add(s.delivery?.newOrderPhones);
  add(s.cms?.campaigns?.excludePhones);
  return out;
}

/* علاقة مباشرة = عنده طلب واحد على الأقل مش من تطبيق توصيل (صالة/سفري/موقع).
   اللي كل طلباته من كيتا/هنقر رقمه جاي من طرف تالت → ممنوع (O6). */
export const directRelationship = (c) => (c.orders - (c.appOrders || 0)) > 0 || (c.online || 0) > 0;

/* شرائح موجات ٩٦ — تقسيم من غير تداخل عشان محدش ياخد رسالتين في نفس اليوم.
   «أونلاين = ٠» شرط موجات FIRST (توصيل مجاني لأول طلب من الموقع). */
const hall = (c) => c.orders >= 2 && c.daysSince <= 45;
export const WAVE_SEGMENTS = [
  { id: "w_hall_regulars", icon: "🏠", label: "زبائن الصالة المنتظمين (موجة)", hint: "طلبين أو أكتر وآخر طلب ≤٤٥ يوم، مش تطبيقات بس، ماطلبوش من الموقع",
    test: (c) => directRelationship(c) && c.online === 0 && hall(c) },
  { id: "w_lapsed", icon: "😴", label: "غايبين ٣٠–٩٠ يوم (موجة)", hint: "آخر طلب من ٣٠ لـ٩٠ يوم، مش منتظمين ومش «جربوا مرة»، ماطلبوش من الموقع",
    test: (c) => directRelationship(c) && c.online === 0 && !hall(c) && c.daysSince >= 30 && c.daysSince <= 90
      && !(c.orders === 1 && c.daysSince <= 60) },
  { id: "w_one_time", icon: "1️⃣", label: "جربوا مرة ١٥–٦٠ يوم (موجة)", hint: "طلب واحد من ١٥ لـ٦٠ يوم، ماطلبوش من الموقع",
    test: (c) => directRelationship(c) && c.online === 0 && c.orders === 1 && c.daysSince >= 15 && c.daysSince <= 60 },
  { id: "w_recent_new", icon: "🌱", label: "جداد ≤١٤ يوم (موجة)", hint: "أول طلب خلال ١٤ يوم، ماطلبوش من الموقع",
    test: (c) => directRelationship(c) && c.online === 0 && c.orders === 1 && c.daysSince <= 14 },
  { id: "w_online_buyers", icon: "🛒", label: "عملاء الموقع ≤٩٠ يوم (موجة، من غير FIRST)", hint: "طلبوا من الموقع قبل كده — رابط من غير كوبون",
    test: (c) => (c.online || 0) > 0 && c.daysSince <= 90 },
  { id: "w_last_call", icon: "⏳", label: "آخر أيام ٩٦ — ماطلبوش من الموقع ≤٩٠ يوم", hint: "كل اللي ليهم علاقة مباشرة ≤٩٠ يوم وماطلبوش من الموقع (الفاصل ٢١ يوم بيشيل اللي اتبعتله قريب)",
    test: (c) => directRelationship(c) && c.online === 0 && c.daysSince <= 90 },
];

/* فلترة الجمهور: بترجع القايمة + سبب كل استبعاد (بيتسجّل مع الحملة) */
export function filterAudience(members, { staff = new Set(), optedOut = new Set(), recentlyMessaged = new Set(), recentOnline = new Set() } = {}) {
  const excluded = { apps_only: 0, staff: 0, opted_out: 0, gap: 0, recent_online_order: 0 };
  const list = [];
  for (const m of members) {
    if (!directRelationship(m)) { excluded.apps_only++; continue; }
    if (staff.has(m.pn)) { excluded.staff++; continue; }
    if (optedOut.has(m.pn)) { excluded.opted_out++; continue; }
    if (recentOnline.has(m.pn)) { excluded.recent_online_order++; continue; }
    if (recentlyMessaged.has(m.pn)) { excluded.gap++; continue; }
    list.push(m);
  }
  return { list, excluded };
}

/* سماحية تغيّر الجمهور بين التأكيد ووقت الإرسال المجدول: الزيادة بس هي الخطر
   (تكلفة ماحدش وافق عليها). النقصان طبيعي — الفاصل ٢١ يوم والإيقاف بيشيلوا ناس. */
export const audienceDriftOk = (confirmed, now) =>
  Number(now) - Number(confirmed) <= Math.max(10, Math.round(Number(confirmed) * 0.2));

/* إرسال تسويقي واحد عبر تقنيات (المُرسل الإعلاني) — نفس المسار للحملات والسلة */
export async function sendAdSms(pn, body) {
  const key = process.env.TAQNYAT_API_KEY, sender = process.env.TAQNYAT_SENDER_AD;
  if (!key || !sender) throw Object.assign(new Error("ad sender not configured"), { code: "sms_failed" });
  if (smsParts(body) > 2) throw Object.assign(new Error("too_long"), { code: "sms_failed" });
  const resp = await fetch("https://api.taqnyat.sa/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipients: [`966${pn}`], body, sender }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data.statusCode && data.statusCode >= 400)) {
    throw Object.assign(new Error(`Taqnyat: ${data.message || resp.status}`), { code: "sms_failed" });
  }
  return { messageId: data.messageId != null ? String(data.messageId) : null, cost: Number(data.cost) || 0, parts: Number(data.msgLength) || smsParts(body) };
}
