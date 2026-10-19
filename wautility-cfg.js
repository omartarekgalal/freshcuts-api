/* UT1 (عمر ١٩/١٠: «لازم نوصل لمرحلة اننا بنستفيد من الرسايل الخدمية ونحاول ع قد ما نقدر نستخدمها بدل التسويقية لانها بنص السعر …
   وهي فعلا مش تسويقية») — إعدادات «الخدمي أولاً» (settings.waBot.utilityFirst). ملف لوحده من غير أي import عشان wabotrun.js
   (مخطط «كل إعدادات البوت» في اللوحة) وwhatsapp.js (الحارس) يقروه من غير ما يسحبوا حاجة تانية.

   القاعدة (الحارس في whatsapp.js — guardSend): رسالة خدمية (قالب فئته عندنا UTILITY) وميتا مصنّفاه MARKETING (قراءة حيّة لقايمة
   message_templates كل ١٠ دقايق، وإلا META_CATEGORY في الكتالوج) ⇒ الحارس بيرفضه بسبب meta_marketing، والمنادي بيكمّل للي بعده:
   الرسالة الحرة جوّه النافذة (ببلاش) ← قالب خدمي معتمد تاني ← SMS — **مش** القالب اللي بيتحاسب تسويق.
     • staff      — قوالب الفريق (wateam / waflow / ackescalate)
     • customers  — قوالب العملاء الخدمية (تحديثات الطلب، التقييم …)
     • reviewStarsAsMarketing — استثناء واحد بالاسم: fc_review_stars (ميتا صنّفته تسويق ١٦/١٠). مفتوح افتراضياً = زي ما هو شغّال النهارده
       (قرار المالك ١٨/١٠ لطلبات الكاشير وكيتا)؛ قفله ⇒ طلب الموقع ياخد fc_review_request_v2 الخدمي، وطلب الكاشير/كيتا بيرجع لقرار reviews.js (SMS). */
export const UTILITY_FIRST_DEFAULTS = Object.freeze({ staff: true, customers: true, reviewStarsAsMarketing: true });
const BOOLS = Object.keys(UTILITY_FIRST_DEFAULTS);
/* الاستثناءات بالاسم: قالب خدمي ميتا صنّفته تسويق والمالك سايبه يتبعت بسعر التسويق لحد ما البديل الخدمي يتعتمد */
export const MARKETING_EXCEPTIONS = Object.freeze({ fc_review_stars: "reviewStarsAsMarketing" });

export function utilityFirstConfig(x) {
  const src = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  for (const k of BOOLS) out[k] = typeof src[k] === "boolean" ? src[k] : UTILITY_FIRST_DEFAULTS[k];
  return out;
}
export function utilityFirstFromBody(src, prev) {
  if (!src || typeof src !== "object" || Array.isArray(src)) return { ok: false, errors: ["utilityFirst: كائن"] };
  const errors = [], out = { ...((prev && typeof prev === "object") ? prev : {}) };
  for (const [k, v] of Object.entries(src)) {
    if (!BOOLS.includes(k)) { errors.push(`utilityFirst.${k}: إعداد مش معروف`); continue; }
    if (typeof v === "boolean") out[k] = v; else errors.push(`utilityFirst.${k}: مفتوح/مقفول`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}
/* قرار الحارس (صافي): القالب ده يترفض؟ ⇒ null = يعدّي · "meta_marketing" = يترفض والمنادي يكمّل للبديل */
export function utilityFirstVerdict({ cfg, audience, template, billedMarketing }) {
  if (!billedMarketing) return null;
  const c = utilityFirstConfig(cfg);
  if (audience === "staff") return c.staff ? "meta_marketing" : null;
  if (!c.customers) return null;
  const ex = MARKETING_EXCEPTIONS[template];
  return ex && c[ex] === true ? null : "meta_marketing";
}

const G = "utilityFirst";
const B = (ar, help) => Object.freeze({ group: G, type: "boolean", ar, help });
export const UTILITY_FIRST_SCHEMA_GROUP = Object.freeze({ [G]: "💸 الخدمي أولاً: مفيش سعر تسويق على رسالة خدمية" });
export const UTILITY_FIRST_SCHEMA = Object.freeze({
  "utilityFirst.staff": B("قوالب الفريق: ماتبعتش قالب ميتا صنّفته تسويق",
    "ميتا ساعات بتحوّل قالب خدمي لـ«تسويق» بعد اعتماده (fc_staff_team_notice و fc_staff_alerts_renew حصل فيهم كده): بيتحاسب بحوالي ٥ أضعاف سعر الخدمي (٠٫٢٢ ر.س بدل ٠٫٠٤)، وميتا بتمنع جزء كبير منه (خطأ 131049 — من ١٣ لـ١٦/١٠ اتمنعت ٥٧ رسالة فريق من ٧٦). مفتوح = الحارس بيقرا فئة ميتا الحقيقية كل ١٠ دقايق، والتنبيه بيروح للرسالة الحرة لو النافذة مفتوحة، وإلا لقالب فريق خدمي معتمد، وإلا SMS/إشعار البورتال — عمره ما بيدفع سعر التسويق. مقفول = القالب القديم يتبعت حتى لو بيتحاسب تسويق."),
  "utilityFirst.customers": B("رسايل العملاء الخدمية: ماتبعتش قالب ميتا صنّفته تسويق",
    "نفس القاعدة لتحديثات الطلب وطلب التقييم وأي رسالة خدمية لعميل: القالب اللي ميتا حوّلته تسويق مابيتبعتش، والرسالة بتروح للبديل الخدمي أو SMS حسب كل مُرسل. الاستثناء اللي تحت بس هو اللي بيعدّي."),
  "utilityFirst.reviewStarsAsMarketing": B("استثناء: قالب النجوم fc_review_stars يفضل يتبعت بسعر التسويق",
    "ميتا صنّفت fc_review_stars تسويق (١٦/١٠). من ١٦ لـ١٨/١٠ اتبعت ٦٧ مرة (٦٣ منهم لطلبات الكاشير) بحوالي ٠٫٢٢ ر.س للرسالة ≈ ١٤٥ ر.س في الشهر بدل ≈ ٢٧ لو خدمي، و٧ اتمنعوا (131049). مفتوح = زي النهارده. مقفول = طلب الموقع ياخد fc_review_request_v2 الخدمي، وطلب الكاشير/كيتا مالوش قالب خدمي لحد ما الصياغة الجديدة تتعتمد (reviews.js بيقرر SMS)."),
});
