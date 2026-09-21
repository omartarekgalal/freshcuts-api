/* ═══════════════════════════════════════════════════════════════════════════
   SMS RULES — قواعد الرسايل التسويقية في مكان واحد (١٧ سبتمبر ٢٠٢٦)

   قرار عمر: «اسم المرسل مفعل وكله تمام ابدا … حملات الsms». الشروط اللي
   بتحكم أي رسالة تسويقية (حملة / أتمتة / سلة متروكة):
     • من المُرسل التسويقي بس، ومعاها سطر الإيقاف (optoutLine تحت)
     • مفيش إرسال في ساعات الهدوء (قبل ١٢ الضهر وبعد ١٠ بالليل بتوقيت الرياض)
     • فاصل متدرّج بين أي رسالتين تسويقيتين لنفس الرقم + سقف أسبوعي/شهري
       (٢١/٩ — بدل الرقم الواحد اللي كان ٢١ وبقى ٧؛ شوف GAP_DEFAULT تحت)
     • لازم يكون طلب مننا مباشرة (صالة/سفري/موقع) — أرقام التطبيقات بس ممنوعة
     • الموظفين وأرقام التجارب برا
     • جزئين UCS-2 كحد أقصى
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

import { logSms } from "./smslog.js";

export const QUIET_START = 22; // من ١٠ بالليل
export const QUIET_END = 12;   // لحد ١٢ الضهر

export function riyadhParts(now = new Date()) {
  const d = new Date(now.getTime() + 3 * 3600_000); // الرياض UTC+3 طول السنة
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
}
/* ساعات الهدوء — مصدر واحد (٢٠٢٦-٠٩-١٩): settings.cms.campaigns.quietStart/quietEnd
   (من شاشة الحملات)، والافتراضي ٢٢ → ١٢. الحملات والأتمتة واسترجاع السلة
   بيقروا من هنا بس. (رسايل التقييم ليها ساعاتها لوحدها في settings.reviews
   لأنها رسالة معاملة بعد طلب، مش تسويق.) */
export function quietOf(settings) {
  const c = ((settings || {}).cms || {}).campaigns || {};
  const h = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 23 ? n : d; };
  return { start: h(c.quietStart, QUIET_START), end: h(c.quietEnd, QUIET_END) };
}
export const quietText = (q) => `${String(q.start).padStart(2, "0")}:00–${String(q.end).padStart(2, "0")}:00`;
export function inQuietFor(settings, now = new Date()) {
  const q = quietOf(settings);
  return inQuietHours(now, q.start, q.end);
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

/* ── عملاء كيتا (قرار عمر ١٧/٩ مساءً: «بالنسبة لارقام عملاء كيتا انا واخد موافقة
   باستخدامهم») — شرائح بالتفضيل من أصناف طلبات كيتا نفسها:
     مشاوي غالبة → كيلو ٩٦، بيتزا/باستا/كريب/حواوشي غالبة أو مختلط → بوكس ٩٦.
   «غالبة» = مشترياتها ≥ ١٫٥ ضعف التانية. باقي قواعد الامتثال زي ما هي (إيقاف،
   موظفين، فاصل ٢١ يوم، ساعات هدوء، سقف) + مفيش طلب أونلاين آخر ١٤ يوم.
   allowApps على الشريحة بيفك شرط «العلاقة المباشرة» ليها هي بس. */
const BOX_WORDS = ["بيتزا", "باستا", "بشاميل", "الفريدو", "كازرول", "كريب", "حواوشي", "ماك اند تشيز", "نجرسكو", "كريمي مشروم", "ورقة سجق"];
const GRILL_WORDS = ["مشوي", "بالوزن", "وجبة", "كفتة", "طرب", "ريش", "كباب", "شيش", "مشكل", "على الفحم"];
export function itemFamily(name) {
  const n = String(name || "");
  if (BOX_WORDS.some((w) => n.includes(w))) return "box";
  if (GRILL_WORDS.some((w) => n.includes(w))) return "grill";
  return "other";
}
export function leanOf(grill, box) {
  const g = Number(grill) || 0, b = Number(box) || 0;
  if (g > b * 1.5) return "grill";
  if (b > g * 1.5) return "box";
  return "mixed";
}
const keetaFresh = (c) => (c.keetaOrders || 0) > 0 && !((c.onlineDaysSince ?? 9999) <= 14);
export const KEETA_SEGMENTS = [
  { id: "k_keeta_kilo", icon: "🛵", label: "عملاء كيتا — بيميلوا للمشاوي (كيلو ٩٦)", allowApps: true,
    hint: "طلبوا من كيتا وأغلب مشترياتهم هناك مشاوي. مش طالبين من الموقع آخر ١٤ يوم (موافقة عمر ١٧/٩)",
    test: (c) => keetaFresh(c) && c.keetaLean === "grill" },
  { id: "k_keeta_box", icon: "🛵", label: "عملاء كيتا — بيتزا/باستا/كريب/حواوشي أو مختلط (بوكس ٩٦)", allowApps: true,
    hint: "طلبوا من كيتا وأغلبهم بيتزا/باستا/كريب/حواوشي أو مختلط. مش طالبين من الموقع آخر ١٤ يوم (موافقة عمر ١٧/٩)",
    test: (c) => keetaFresh(c) && c.keetaLean !== "grill" },
];

/* ═══ تفضيل الأكل الحقيقي لعميل التطبيق (قرار عمر ٢١/٩) ═══════════════════
   عمر بالحرف: «عملاء كيتا لازم يعرفوا بالتوصيل المجاني مع العرض حسب الاكل
   الى بياكلوه ولازم نحسب نسبة تحولهم للمتجر بتاعنا».
   (ملاحظة مهمة: «مش هصرف على كيتا وهنجر» = صرف الإعلانات بس. الرسايل اللي
   بتسحبهم لمتجرنا هي بالظبط اللي هو عايزها — الحملة ٩/١٩ اتلغت على سوء فهم.)

   القديم (itemFamily/leanOf) كان بيقسّم الدنيا لحتّتين: مشاوي ولا بوكس.
   ده كفاية عشان تختار العرض، بس مش كفاية عشان تكتب رسالة العميل يحس إنها
   ليه. هنا بنقسّم بالفئة الحقيقية من نقطة البيع (٦ مجموعات = تعريفات عمر
   للكاتيجوري) وكل مجموعة ليها عرضها ورسالتها.

   الترتيب في الفحص مقصود: «بيتزا برجر» لازم تتحسب بيتزا (بتبدأ بـ«بيتزا»)،
   و«كريب هوت دوج» كريب، و«جريلد تشيكن ساندوتش» برجر (واحد من الأربعة —
   شوف memory freshcuts-menu-category-rules)، و«ورقة سجق اسكندراني» مع
   الحواوشي لأنها عيش ملفوف مش مشاوي بالوزن. */
export const FOOD_GROUPS = Object.freeze([
  { id: "grill", label: "مشاوي", icon: "🔥", offer: "kilo", offerLabel: "كيلو ٩٦" },
  { id: "crepe", label: "كريب", icon: "🌯", offer: "box", offerLabel: "بوكس ٩٦" },
  { id: "pasta", label: "باستا", icon: "🍝", offer: "box", offerLabel: "بوكس ٩٦" },
  { id: "pizza", label: "بيتزا", icon: "🍕", offer: "box", offerLabel: "بوكس ٩٦" },
  { id: "hawawshi", label: "حواوشي", icon: "🥙", offer: "box", offerLabel: "بوكس ٩٦" },
  { id: "burger", label: "برجر", icon: "🍔", offer: "box", offerLabel: "بوكس ٩٦" },
]);
export const FOOD_GROUP_IDS = FOOD_GROUPS.map((g) => g.id);
const foodById = Object.fromEntries(FOOD_GROUPS.map((g) => [g.id, g]));
export const foodGroupOf = (id) => foodById[id] || null;

/* اسم الصنف زي ما نقطة البيع بتكتبه → مجموعة. بيتزا نقطة البيع بتيجي
   بلاحقة («بيتزا بيبروني 1.0 حشو اطراف كيري») فالمطابقة بالبداية مش بالاسم
   الكامل — المطابقة بالاسم الكامل كانت بتسيب ٧٩ سطر بيتزا من غير فئة. */
const FOOD_RULES = [
  { g: "pizza", re: /بيتزا/ },
  { g: "crepe", re: /كريب/ },
  { g: "hawawshi", re: /حواوشي|ورقة سجق/ },
  { g: "pasta", re: /باستا|كازرول|الفريدو|ماك اند تشيز|نجرسكو|بشاميل/ },
  { g: "burger", re: /برجر|جريلد تشيكن ساندوتش|كريمي مشروم تشيكن/ },
  { g: "grill", re: /وجبة|بالوزن|مشوي|مشوية|على الفحم|كبدة|مشكل|كفتة|طرب|ريش|كباب|شيش|سجق/ },
];
export function foodGroup(name) {
  const n = String(name || "");
  for (const r of FOOD_RULES) if (r.re.test(n)) return r.g;
  return null; // مقبلات/مشروبات/طاسات — مش إشارة تفضيل
}
/* أعلى مجموعة بالإنفاق. التعادل بيترتّب بترتيب FOOD_GROUPS عشان النتيجة
   تبقى ثابتة (نفس العميل مايتنقلش بين شريحتين كل ما نعيد الحساب). */
export function topFoodGroup(amounts) {
  const a = amounts || {};
  let best = null, bestV = 0;
  for (const g of FOOD_GROUPS) {
    const v = Number(a[g.id]) || 0;
    if (v > bestV) { best = g.id; bestV = v; }
  }
  return best;
}

/* شرائح عملاء التطبيقات بالتفضيل. allowApps=true لأن دول بالتعريف أرقام
   جاية من تطبيق توصيل (كيتا هو الوحيد اللي بيدّي جوال حقيقي — هنقرستيشن
   ونينجا بيخفوا الرقم، شوف memory freshcuts-marketing-center). الشريحة
   بتشتغل على أي مصدر تطبيق، فلو جالنا أرقام هنقر/نينجا بكرة تدخل لوحدها. */
const appFresh = (c) => (c.appSrcOrders || 0) > 0 && !((c.onlineDaysSince ?? 9999) <= 14);
export const APP_FOOD_SEGMENTS = FOOD_GROUPS.map((g) => ({
  id: `k_app_${g.id}`, icon: g.icon, label: `عملاء التطبيقات — ${g.label} (${g.offerLabel})`, allowApps: true,
  hint: `أغلب إنفاقهم على التطبيق ${g.label}. الرسالة بتربط أكلهم بـ${g.offerLabel} + توصيل مجاني لأول طلب من موقعنا. مش طالبين من الموقع آخر ١٤ يوم`,
  test: (c) => appFresh(c) && c.appTopFood === g.id,
}));

/* ═══ الفاصل بين الرسايل التسويقية — قاعدة متدرّجة (قرار عمر ٢١/٩) ═══════
   عمر: «حاسس ان قاعدة منكلمش العميل ٧ ايام دي قاعدة مش حلوة».
   الـ٧ (والـ٢١ قبلها) كانت رقم واحد على كل الناس: نفس الفاصل للزبون اللي
   طلب امبارح واللي رقمه جاي من كيتا من سنة. النتيجة إن الموجة التالتة
   لقت ٤٢ شخص من ٢٤٣.

   بدل رقم واحد، تلات طبقات + سقف تكرار:
     • recent  — آخر طلب ≤٣٠ يوم  → ٣ أيام. بيعرفنا، بيطلب، وأقل حد يزعل.
     • lapsed  — ٣١–٩٠ يوم        → ٧ أيام.
     • cold    — >٩٠ يوم أو رقم من تطبيق (ماطلبش مننا مباشرة أبداً)
                                   → ١٤ يوم. أضعف علاقة = أعلى خطر شكوى.
     • سقف: ٢ رسالة/٧ أيام و٤ رسايل/٣٠ يوم لأي رقم مهما كانت الطبقة.

   ليه ٣ أساس مش ١؟ دورة العروض عندنا أسبوعية، والسقف الشهري (٤) هو
   الفرملة الحقيقية — الفاصل بيمنع رسالتين ورا بعض بس. ٣×٤ = أقصى تكرار
   مستدام ~رسالة كل ٧.٥ يوم للزبون النشط، وده أوسع بكتير من ٧ الحالية
   من غير ما نحرق القايمة. كله بيتعدّل من شاشة الحملات. */
export const GAP_DEFAULT = Object.freeze({
  minGapDays: 3,      // recent — الاسم القديم عشان الإعدادات المحفوظة ماتتكسرش
  gapLapsedDays: 7,
  gapColdDays: 14,
  maxPerWeek: 2,
  maxPerMonth: 4,
});
const intIn = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};
export function gapOf(cfg) {
  const c = cfg || {};
  return {
    minGapDays: intIn(c.minGapDays, 0, 90, GAP_DEFAULT.minGapDays),
    gapLapsedDays: intIn(c.gapLapsedDays, 0, 90, GAP_DEFAULT.gapLapsedDays),
    gapColdDays: intIn(c.gapColdDays, 0, 180, GAP_DEFAULT.gapColdDays),
    maxPerWeek: intIn(c.maxPerWeek, 0, 14, GAP_DEFAULT.maxPerWeek),
    maxPerMonth: intIn(c.maxPerMonth, 0, 60, GAP_DEFAULT.maxPerMonth),
  };
}
export const GAP_TIERS = [
  { id: "recent", key: "minGapDays", label: "طلب آخر ٣٠ يوم" },
  { id: "lapsed", key: "gapLapsedDays", label: "آخر طلب ٣١–٩٠ يوم" },
  { id: "cold", key: "gapColdDays", label: "أكتر من ٩٠ يوم أو رقم من تطبيق" },
];
/* الطبقة من بيانات العميل نفسه (customerRows) — مفيش استعلام زيادة */
export function gapTier(m) {
  if (!directRelationship(m)) return "cold";          // رقم تطبيق = ماطلبش مننا
  const d = Number(m.daysSince);
  if (!Number.isFinite(d) || d > 90) return "cold";
  return d <= 30 ? "recent" : "lapsed";
}
export const gapDaysFor = (tier, g) => g[(GAP_TIERS.find((t) => t.id === tier) || GAP_TIERS[2]).key];

/* h = {days, in7, in30} من سجل الإرسال. بترجع سبب الاستبعاد أو null */
export function gapReason(m, h, g) {
  if (!h) return null;
  if (g.maxPerWeek > 0 && (h.in7 || 0) >= g.maxPerWeek) return "cap_week";
  if (g.maxPerMonth > 0 && (h.in30 || 0) >= g.maxPerMonth) return "cap_month";
  const need = gapDaysFor(gapTier(m), g);
  if (need > 0 && Number.isFinite(h.days) && h.days < need) return "gap";
  return null;
}

/* فلترة الجمهور: بترجع القايمة + سبب كل استبعاد (بيتسجّل مع الحملة).
   history = Map(رقم → {days, in7, in30}); لو مش موجودة بنرجع للطريقة
   القديمة (Set لمين اتبعتله) عشان الأتمتة القديمة ماتقعش. */
export function filterAudience(members, { staff = new Set(), optedOut = new Set(), recentlyMessaged = new Set(), recentOnline = new Set(), allowApps = false, history = null, gap = null } = {}) {
  const excluded = { apps_only: 0, staff: 0, opted_out: 0, gap: 0, cap_week: 0, cap_month: 0, recent_online_order: 0 };
  const g = history ? gapOf(gap) : null;
  const list = [];
  for (const m of members) {
    if (!allowApps && !directRelationship(m)) { excluded.apps_only++; continue; }
    if (staff.has(m.pn)) { excluded.staff++; continue; }
    if (optedOut.has(m.pn)) { excluded.opted_out++; continue; }
    if (recentOnline.has(m.pn)) { excluded.recent_online_order++; continue; }
    if (history) {
      const why = gapReason(m, history.get(m.pn), g);
      if (why) { excluded[why]++; continue; }
    } else if (recentlyMessaged.has(m.pn)) { excluded.gap++; continue; }
    list.push(m);
  }
  return { list, excluded };
}
export const EXCLUDE_LABELS = Object.freeze({
  apps_only: "رقمه من تطبيق توصيل بس (ماطلبش مننا مباشرة)",
  staff: "موظف أو رقم مستبعد",
  opted_out: "أوقف الرسائل الإعلانية",
  recent_online_order: "طلب من الموقع آخر ٣ أيام",
  gap: "لسه ماعدّاش الفاصل بين رسالتين",
  cap_week: "وصل سقف رسايل الأسبوع",
  cap_month: "وصل سقف رسايل الشهر",
  holdout: "المجموعة المحجوزة (للمقارنة)",
});

/* ═══ سطر الإيقاف ═══════════════════════════════════════════════════════
   عمر ٢١/٩: «بلاش رابط ايقاف الرسالة يكون طويل وكبير في الرسالة اعمله غير
   قابل للضغط عشان العميل ميضغطش عليه بدل رابط العرض».

   الأساس النظامي (تنظيمات الحد من الرسائل والمكالمات الاقتحامية — هيئة
   الاتصالات والفضاء والتقنية، النسخة التالتة أكتوبر ٢٠٢٢، قرار ٤٩٣/١٤٤٤):
     ٤-٦-٦-٢ «تمكين المستخدم النهائي من طلب إيقاف استقبال الرسائل الدعائية
              في أي وقت، وعبر القنوات التقليدية والإلكترونية»
     ٤-٦-٦-٣ التوقف خلال ٢٤ ساعة من الطلب
     ٤-٦-٦-٤ إشعار يؤكد الإيقاف بعد الطلب
   **مفيش مادة بتفرض رابط جوّه نص الرسالة.** المطلوب إن الآلية موجودة
   ومتاحة في أي وقت. واللائحة نفسها (ملحق الرسائل الدعائية) بتنص على
   الآلية الوطنية: «لحجب الرسائل الدعائية من مرسل معين؛ أرسل اسم المرسل»
   إلى ٨٠١٠٠١ (وفك الحجب ٨٠١٠٠٢) — مجانية وفورية على مستوى المشغل.

   فالافتراضي بقى keyword: «إيقاف: أرسل FreshCut-AD لـ801001» — نفس طول
   سطر الرابط القديم بالظبط، ومفيش فيه أي حاجة تنافس رابط العرض.
   ومسار /u/<code> بتاعنا فضل شغّال بالكامل (الصفحة + البوابة + الشيك أوت)
   عشان القناة الإلكترونية بتاعتنا تفضل متاحة في أي وقت، ولأنه المسار
   الوحيد اللي بيسجّل عندنا ويوقف الفلوس. المالك يقدر يرجّع الرابط أو
   يحط الاتنين من شاشة الحملات (optoutMode). */
export const OPTOUT_MODES = Object.freeze(["keyword", "link", "both"]);
export const OPTOUT_SHORTCODE = "801001";
export const optoutMode = (cfg) => (OPTOUT_MODES.includes((cfg || {}).optoutMode) ? cfg.optoutMode : "keyword");
export function optoutLine(cfg, { code, host, sender } = {}) {
  const mode = optoutMode(cfg);
  const kw = `إيقاف: أرسل ${sender || "FreshCut-AD"} لـ${OPTOUT_SHORTCODE}`;
  const ln = code ? `إيقاف: ${String(host || "freshcuts.sa").replace(/^https?:\/\//, "").replace(/\/+$/, "")}/u/${code}` : "";
  if (mode === "link") return ln || kw;
  if (mode === "both" && ln) return `${kw} · ${ln}`;
  return kw;
}

/* سماحية تغيّر الجمهور بين التأكيد ووقت الإرسال المجدول: الزيادة بس هي الخطر
   (تكلفة ماحدش وافق عليها). النقصان طبيعي — الفاصل والإيقاف بيشيلوا ناس. */
export const audienceDriftOk = (confirmed, now) =>
  Number(now) - Number(confirmed) <= Math.max(10, Math.round(Number(confirmed) * 0.2));

/* سقف الجمهور (٢١/٩) — بديل حارس الـ٢٠٪ للموجات اللي متجدولة بعد أيام.
   موجة يوم ٣٠/٩ جمهورها النهارده صغير لأن نص الناس لسه في الفاصل؛ يوم ٣٠
   بيبقى كبير. الحارس القديم كان بيوقفها (held) والمالك لازم يعيد التأكيد.
   بالسقف: «ابعت لكل اللي هيبقى مؤهّل وقتها، بس مايزيدش عن N».
   بترجع null لو تمام، أو سبب الإيقاف. */
export function audienceGateReason(confirmed, max, now) {
  const n = Number(now);
  if (max != null && Number.isFinite(Number(max))) {
    return n > Number(max) ? `audience_over_max ${n}>${max}` : null;
  }
  return audienceDriftOk(confirmed, n) ? null : `audience_changed ${confirmed}→${n}`;
}

/* إرسال تسويقي واحد عبر تقنيات (المُرسل الإعلاني) — نفس المسار للحملات والسلة */
/* meta = {kind, ref} لسجل الرسايل الموحّد (smslog.js). الحملات (cms.js) ليها
   سجلها الخاص cms_campaign_sends ومابتعدّيش من هنا. */
export async function sendAdSms(pn, body, meta = {}) {
  const sender = process.env.TAQNYAT_SENDER_AD || null;
  try {
    const out = await sendAdSmsRaw(pn, body);
    logSms({ phoneNorm: pn, kind: meta.kind || "other", ref: meta.ref, sender, body, status: "sent",
      msgId: out.messageId, cost: out.cost, parts: out.parts });
    return out;
  } catch (e) {
    logSms({ phoneNorm: pn, kind: meta.kind || "other", ref: meta.ref, sender, body, status: "failed", error: e && e.message });
    throw e;
  }
}
async function sendAdSmsRaw(pn, body) {
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
