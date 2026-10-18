/* CW1 (١٦/١٠): إعدادات «أزرار المندوب الخارجي على واتساب» (settings.waBot.courierJob) — ملف لوحده من غير أي import
   عشان wabotrun.js (مخطط «كل إعدادات البوت» في اللوحة) يقراه من غير ما يسحب courierlive/delivery. المنطق في courierwa.js. */
export const CW_TEMPLATE = "fc_courier_job_v1";
export const COURIER_JOB_TEMPLATES = Object.freeze([CW_TEMPLATE]);

/* ── الإعدادات (settings.waBot.courierJob) ───────────────────────────────── */
const BOOL_ON = ["enabled", "arrivedButton", "problemButton", "openerLink", "openerReply", "locationButton"];
const BOOL_OFF = ["useTemplate"];
const NUM = { confirmMin: [0, 30], locationNudgeMin: [0, 30] };
export const COURIER_JOB_DEFAULTS = Object.freeze({
  enabled: true, arrivedButton: true, problemButton: true, openerLink: true, openerReply: true,
  useTemplate: false, templateName: CW_TEMPLATE, confirmMin: 3,
  locationButton: true, locationNudgeMin: 5,      // CX1 (١٨/١٠): زر «📍 شارك موقعي» + تذكير لما موقعه يقف
});
export function courierJobConfig(x) {
  const src = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  for (const k of BOOL_ON) out[k] = src[k] !== false;
  for (const k of BOOL_OFF) out[k] = src[k] === true;
  for (const [k, [lo, hi]] of Object.entries(NUM)) {
    const n = Number(src[k]);
    out[k] = src[k] === undefined || src[k] === null || src[k] === "" || !Number.isFinite(n) ? COURIER_JOB_DEFAULTS[k] : Math.min(hi, Math.max(lo, Math.round(n)));
  }
  out.templateName = COURIER_JOB_TEMPLATES.includes(src.templateName) ? src.templateName : COURIER_JOB_DEFAULTS.templateName;
  return out;
}
export function courierJobFromBody(src, prev) {
  const errors = [];
  if (!src || typeof src !== "object" || Array.isArray(src)) return { ok: false, errors: ["courierJob: كائن"] };
  const out = { ...((prev && typeof prev === "object") ? prev : {}) };
  for (const [k, v] of Object.entries(src)) {
    if ([...BOOL_ON, ...BOOL_OFF].includes(k)) { if (typeof v === "boolean") out[k] = v; else errors.push(`courierJob.${k}: مفتوح/مقفول`); }
    else if (NUM[k]) { const n = Number(v); if (v === "" || v === null || !Number.isFinite(n) || n < NUM[k][0] || n > NUM[k][1]) errors.push(`courierJob.${k}`); else out[k] = Math.round(n); }
    else if (k === "templateName") { if (COURIER_JOB_TEMPLATES.includes(v)) out[k] = v; else errors.push("courierJob.templateName: قالب مش معروف"); }
    else errors.push(`courierJob.${k}: إعداد مش معروف`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}
const G = "courierJob";
const B = (ar, help) => Object.freeze({ group: G, type: "boolean", ar, help });
export const COURIER_JOB_SCHEMA_GROUP = Object.freeze({ [G]: "🛵 المندوب الخارجي: الأزرار على واتساب" });
export const COURIER_JOB_SCHEMA = Object.freeze({
  "courierJob.enabled": B("ابعت للمندوب الخارجي رسالة واتساب بالأزرار", "لما المدير يسجّل «🛵 مندوب من بره» بجوال سعودي: السيرفر بيبعتله من رقم المطعم بيانات الطلب (العنوان + الخريطة + ملاحظات التوصيل + «مدفوع مسبقاً») وأزرار «استلمت الطلب / وصلت عند العميل / تم التسليم». كل ضغطة بتحرّك الطلب في البوابة وصفحة تتبّع العميل زي رابط المندوب بالظبط. لو المندوب ماكلّمناش آخر ٢٤ ساعة والقالب لسه مش معتمد ⇒ مابيتبعتش، والبوابة بتفتح الواتساب اليدوي زي الأول. مقفول = زي الأول (الرابط بس)."),
  "courierJob.arrivedButton": B("زر «وصلت عند العميل»", "بيظهر بعد «استلمت الطلب» جنب «تم التسليم». مقفول = «تم التسليم» بس (أسهل للمندوب، بس البوابة مش هتعرف إنه وصل قبل ما يسلّم)."),
  "courierJob.problemButton": B("زر «عندي مشكلة»", "مع كل رسالة أزرار. الضغطة بتبعت إشعار لأجهزة المديرين على البورتال وبتتسجّل في سجل الطلب، والمندوب بيقدر يكتب المشكلة في نفس المحادثة (بتظهر في صندوق واتساب)."),
  "courierJob.confirmMin": Object.freeze({ group: G, type: "number", ar: "«تم التسليم» بدري: اسأل تأكيد لو أقل من", help: "لو المندوب ضغط «تم التسليم» قبل المدة دي من «استلمت الطلب» (أو من غير ما يضغط استلمت): بنسأله «متأكد إنك سلّمته؟» بزرّين قبل ما نقول للعميل إن طلبه وصل. صفر = من غير تأكيد.", min: NUM.confirmMin[0], max: NUM.confirmMin[1], unit: "دقيقة" }),
  "courierJob.openerLink": B("سطر «تبي الأزرار على الواتساب؟» في رسالة الواتساب اليدوي", "لما الرسالة الحرة ماتتبعتش (المندوب ماكلّمناش آخر ٢٤ ساعة): رسالة الواتساب اليدوي (wa.me) بيبقى فيها رابط لرقم المطعم برسالة جاهزة فيها رمز الطلب. المندوب يضغط إرسال ⇒ نرد عليه بالأزرار ببلاش. الرمز موقّع ولرحلة واحدة."),
  "courierJob.openerReply": B("لو المندوب كتب لنا: ابعتله الأزرار", "أي رسالة من مندوب على رحلة شغّالة (والأزرار ما اتبعتتلوش آخر ١٠ دقايق) ⇒ نبعتله رسالة الأزرار بحالة الطلب الحالية. والبوت عمره ما بيبيع لرقم مندوب على رحلة شغّالة."),
  "courierJob.useTemplate": B("بره النافذة: قالب fc_courier_job_v1", "افتحه بعد ما ميتا تعتمد القالب: المندوب اللي ماكلّمناش آخر ٢٤ ساعة بياخد القالب بـ٣ أزرار (استلمت / وصلت / تم التسليم) بدل الواتساب اليدوي. القالب خدمي (UTILITY) وبيتحاسب. مقفول = الواتساب اليدوي زي الأول."),
  "courierJob.locationButton": B("زر «📍 شارك موقعي» على الواتساب", "مع رسالة الأزرار (جوّه النافذة) وبعد ما المندوب يضغط «استلمت الطلب» (حتى لو وصله القالب): رسالة فيها زر واحد «📍 شارك موقعي» بيفتح صفحة المندوب على freshcuts.sa — موقعه بيظهر للعميل في صفحة التتبّع وللمدير على خريطة البورتال لحد ما يسلّم. بيتبعت بس لو موقعه مش واصل دلوقتي. مقفول = الأزرار من غير رابط موقع (القالب أصلاً مافيهوش رابط)."),
  "courierJob.locationNudgeMin": Object.freeze({ group: G, type: "number", ar: "ذكّر المندوب لو موقعه وقف أكتر من", help: "المندوب ضغط «استلمت» أو «ابدأ التوصيل» وموقعه ماوصلش المدة دي (قفل الصفحة / فتح خرائط جوجل / ماشاركش خالص) ⇒ نبعتله على الواتساب زر «📍 شارك موقعي» تاني — بحد أقصى مرتين للطلب، و١٠ دقايق بين المرتين، وبس لو النافذة مفتوحة (ببلاش). صفر = من غير تذكير.", min: NUM.locationNudgeMin[0], max: NUM.locationNudgeMin[1], unit: "دقيقة" }),
  "courierJob.templateName": Object.freeze({ group: G, type: "enum", ar: "اسم قالب المندوب", help: "القالب اللي بيتبعت بره النافذة (لازم يكون معتمد عند ميتا).", options: [...COURIER_JOB_TEMPLATES] }),
});

