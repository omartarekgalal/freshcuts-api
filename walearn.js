/* ═══════════════════════════════════════════════════════════════════════════
   walearn.js — BF1 (١٩/١٠/٢٠٢٦): «ماجد والبوت يتعلموا من أخطائهم» (طلب عمر ١٩/١٠)

   أ) سجل الأخطاء wa_bot_mistakes: كل غلطة متأكدة = نوع، مثال المحادثة (الرقم مخفي «…1234»)، الرد الغلط، التصرف الصح، الحارس/القاعدة اللي
      بتمنعها دلوقتي، والحالة (suspected مشتبه · confirmed متأكدة · fixed اتصلّحت · dismissed مش غلطة). اللوحة بتعرضه كجدول من
      GET /api/cms/wabot/mistakes (columns + rows — نفس شكل جداول اللوحة) والمالك بيعدّل الحالة والدرس من PUT.
   ب) الدروس: الغلطة المتأكدة اللي ليها «ماتعملش / اعمل» ومفتاح الدرس شغّال ⇒ سطر في كتلة «دروس من أخطاء حقيقية» بتتبعت لماجد كجزء من التعليمات
      (كتلة لوحدها، بالحجم الأقصى من اللوحة lessonsMaxChars، ولكل تغيير نسخة في wa_bot_lessons). مراجعة ١٩/١٠ متزرّعة (٣١ ملاحظة) كـ«متأكدة».
   ج) الفحص الليلي (selfReview، ٤:٣٠ الرياض افتراضياً، مفتاح في اللوحة، شغّال افتراضياً): **قراية بس** من المحادثات — فحوص ثابتة على ردود اليوم:
      وعود اتمنعت (الحارس)، رسالة بيع/اعتذار لحد طلب، موظف استلم وماكتبش، ضغطة متأخرة اتحوّلت، تحويل ماحدش رد عليه، سعر غير المنيو الحي،
      كلام مصري، كلام وصفات/موردين، رسالة مبادِرة والمطعم مقفول، ماجد والموظف ردّوا مع بعض ⇒ صفوف «مشتبه» للمالك يأكدها. مفيش موديل (مجاني ومضمون).
   د) العدّ اليومي حسب النوع ⇒ /api/cms/wabot/stats (mistakes.byDay) عشان نشوفه بينزل.
   ملف صافي من ناحية الاعتماد: القاعدة والمنيو والإعدادات بييجوا من wabotrun في deps.
═══════════════════════════════════════════════════════════════════════════ */
import { normalize } from "./wabot.js";
import { maskText } from "./wabotllm.js";
import { promiseProblems, latinShort, complimentOnly } from "./waguard.js";
import { isRestaurantOpenAt } from "./sendhours.js";

export const LEARN_GROUP = "botLearn";
export const LEARN_GROUP_AR = "ماجد والبوت: الحرّاس والتعلّم من الأخطاء (BF1)";
export const LEARN_DEFAULTS = Object.freeze({
  orderAwareHours: 3,          // A: طلب (موقع/كاشير/صالة) في آخر الساعات دي ⇒ مفيش بيع ولا اعتذار، والمحادثة «طلب موجود»
  promiseGuard: true,          // D: ماجد مايقولش «جهّزت / أضفت / كتبت للمطبخ / طلبك جاهز» من غير ما ده يحصل في نفس الدور
  goAheadCart: true,           // H: «جهّزه / أبغى أطلب» ⇒ السلة في نفس الرد، والاقتراح زر جوّاها
  campExpiredAlt: true,        // G/E: العرض خلص ⇒ أقرب بوكس حي لنفس العدد بسعره وزره، وماجد بيعرف آخر حملة وصلت العميل
  staffStopsMajed: true,       // L: موظف كتب في المحادثة ⇒ ماجد يسكت فوراً (ومايبعتش رد كان بيجهّزه)
  claimSilentMin: 3,           // C: موظف استلم وماكتبش في الدقايق دي ⇒ تنبيه تاني + المدير. صفر = مقفول
  claimEscalate: true,         // …والتصعيد للمدير
  closedComplaintAtOpen: true, // C: تقييم واطي/شكوى العميل ردّ عليها والمطعم مقفول ⇒ للمدير أول ما نفتح
  spamQuiet: true,             // I: سبام (رابط دعوة / تيمو…) ⇒ سطر واحد، ولا «أنا معك» ولا تنبيه
  shortEnglishArabic: true,    // BF3 (…4268 ٢٠/١٠): «Online» / «Offers» / «Menu» لوحدها أو نص زر ⇒ الرد بالعربي (البوت وماجد)
  praiseThanks: true,          // BF3 (…5082 ٢٠/١٠): مدح الأكل ⇒ شكر قصير، مش تحويل لموظف
  lessonsEnabled: true,        // ب: الدروس بتتبعت لماجد
  lessonsMaxChars: 1500,       // …بحد أقصى
  selfReview: true,            // ج: الفحص الليلي
  selfReviewHour: 4, selfReviewMinute: 30,   // …بتوقيت الرياض (بعد القفل)
  selfReviewMax: 60,           // …أقصى عدد صفوف «مشتبه» في الليلة
});
export const LEARN_NUMS = Object.freeze({ orderAwareHours: [1, 24], claimSilentMin: [0, 30], lessonsMaxChars: [300, 4000], selfReviewHour: [0, 11], selfReviewMinute: [0, 59], selfReviewMax: [5, 300] });
export const LEARN_BOOLS = Object.freeze(["promiseGuard", "goAheadCart", "campExpiredAlt", "staffStopsMajed", "claimEscalate", "closedComplaintAtOpen", "spamQuiet", "shortEnglishArabic", "praiseThanks", "lessonsEnabled", "selfReview"]);
const clamp = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, n)) : d; };
export function learnConfig(x = {}) {
  const src = x && typeof x === "object" ? x : {};
  const out = {};
  for (const k of LEARN_BOOLS) out[k] = src[k] !== false;
  for (const [k, lim] of Object.entries(LEARN_NUMS)) out[k] = Math.round(clamp(src[k], lim, LEARN_DEFAULTS[k]));
  return out;
}
const S = (type, ar, help, extra = {}) => Object.freeze({ group: LEARN_GROUP, type, ar, help, ...extra });
const NS = (k, ar, help, unit) => S("number", ar, help, { min: LEARN_NUMS[k][0], max: LEARN_NUMS[k][1], unit });
export const LEARN_SCHEMA = Object.freeze({
  orderAwareHours: NS("orderAwareHours", "العميل طلب خلاص: الساعات اللي بنبص فيها", "طلب موقع مدفوع أو طلب كاشير/صالة على نفس الرقم في آخر الساعات دي ⇒ مفيش «أنا معك» ولا «ما قدرنا نخدمك» ولا متابعة بيع، وماجد بيتكلم معاه كعميل عنده طلب (بيقرا أصنافه).", "ساعة"),
  promiseGuard: S("boolean", "حارس الوعود: ماجد مايقولش «جهّزت / أضفت / كتبت للمطبخ / طلبك جاهز» إلا لو حصل فعلاً", "لو قالها من غير سلة اتعملت في نفس الدور ⇒ الرد بيترفض ويتكتب تاني، ولو فضل ⇒ رد البوت الثابت. مفيش حاجة بتوصل المطبخ من المحادثة. كل مرة الحارس يمسك فيها بتنزل في الفحص الليلي."),
  goAheadCart: S("boolean", "«جهّزه / أبغى أطلب» = السلة في نفس الرد", "العميل وافق على سلة اتسعّرت ⇒ رابط السلة في نفس الرسالة على طول (حتى والمطعم مقفول)، والاقتراح (رز، مشروب) زر تحتها مش سؤال قبلها."),
  campExpiredAlt: S("boolean", "العرض خلص ⇒ بديل لنفس العدد", "ضغطة «أبغى أطلب» على حملة عرضها خلص، أو «العرض» ⇒ أقرب بوكس شغّال لنفس عدد الأشخاص بسعره وزره. وماجد بيعرف آخر حملة وصلت العميل قبل ما يقول «ما عندنا عرض»."),
  staffStopsMajed: S("boolean", "موظف كتب ⇒ ماجد يسكت فوراً", "أي رسالة من الموظف في المحادثة (البورتال / اللوحة / الموبايل) ⇒ ماجد مايردش، ورد كان بيجهّزه في نفس اللحظة مايتبعتش. بوت القواعد بيكمل بقاعدة سكوت الموظف العادية."),
  claimSilentMin: NS("claimSilentMin", "موظف استلم المحادثة وماكتبش: تنبيه تاني بعد", "الموظف ضغط «استلم» والعميل مستني ومحدش كتب له في الدقايق دي ⇒ الكارت يرنّ تاني والتنبيه يتبعت. صفر = مقفول.", "دقيقة"),
  claimEscalate: S("boolean", "…ويتصعّد للمدير", "مع التنبيه التاني: كارت تصعيد على أجهزة المدير (نفس سلّم التحويلات)."),
  closedComplaintAtOpen: S("boolean", "شكوى / تقييم واطي اتردّ عليه والمطعم مقفول ⇒ للمدير أول ما نفتح", "العميل رد على تقييمه الواطي أو شكوته بعد القفل ⇒ أول ما نفتح، لو محدش كتب له، تنبيه عاجل للمدير وكارت على البورتال."),
  spamQuiet: S("boolean", "سبام ⇒ سطر واحد وبس", "رابط دعوة / تيمو / شي إن / «اربح» ⇒ سطر «الرقم ده لطلبات فريش كاتس» مرة، ومفيش «أنا معك» ولا تحويل ولا تنبيه للفريق."),
  shortEnglishArabic: S("boolean", "كلمة إنجليزي لوحدها أو نص زر ⇒ الرد بالعربي", "«Online» أو «Offers» أو «Menu» أو «Hi» أو نص زر إعلان قصير مش لغة العميل (عميلنا سعودي) ⇒ البوت وماجد يردّوا بالعربي. الإنجليزي بس لما العميل يكتب جملة إنجليزي حقيقية (٣ كلمات أو أكتر)، أو لو المحادثة كانت إنجليزي قبلها. مقفول ⇒ الحكم القديم (كلمة زي «Menu» ⇒ إنجليزي)."),
  praiseThanks: S("boolean", "مدح الأكل ⇒ شكر قصير، مش تحويل لموظف", "«الشوي انهارده أحسن من امبارح» أو «تحفة» أو «ما شاء الله» ⇒ سطر شكر دافي («تسلم، يسعدنا إن الشوي عجبك 🙏 ننتظرك دايماً») من غير بيع ولا تحويل. أي كلمة سلبية («بس»، «بارد»، «مجاش»…) ⇒ مش مدح ويمشي في مسار الشكوى زي ما هو. نص الشكر في نصوص البوت (praise)."),
  lessonsEnabled: S("boolean", "دروس الأخطاء بتتبعت لماجد", "الأخطاء المتأكدة اللي ليها «ماتعملش / اعمل» ومفتاح الدرس شغّال ⇒ كتلة قصيرة في تعليمات ماجد. كل تغيير نسخة في السجل."),
  lessonsMaxChars: NS("lessonsMaxChars", "دروس الأخطاء: الحجم الأقصى", "اللي يزيد بيتقص (الأحدث تأكيداً أولاً).", "حرف"),
  selfReview: S("boolean", "الفحص الليلي لردود البوت وماجد", "كل ليلة بعد القفل: فحوص ثابتة على ردود اليوم (قراية بس، من غير موديل) ⇒ صفوف «مشتبه» في سجل الأخطاء للمالك يأكدها أو يشيلها."),
  selfReviewHour: NS("selfReviewHour", "الفحص الليلي: الساعة", "بتوقيت الرياض، بعد القفل.", "ساعة"),
  selfReviewMinute: NS("selfReviewMinute", "الفحص الليلي: الدقيقة", "الدقيقة اللي بيبدأ فيها الفحص بعد الساعة اللي فوق (مثلاً ٤ و٣٠ = ٤:٣٠ الفجر بتوقيت الرياض).", "دقيقة"),
  selfReviewMax: NS("selfReviewMax", "الفحص الليلي: أقصى عدد صفوف في الليلة", "أقصى عدد صفوف «مشتبه» جديدة بيضيفها الفحص في الليلة الواحدة، عشان السجل مايتمليش لو فيه مشكلة متكررة. اللي يزيد عن الحد مايتسجّلش الليلة دي.", "صف"),
});

export const MISTAKE_TYPES = Object.freeze({
  broken_promise: "وعد بحاجة ماحصلتش (جهّزت / كتبت للمطبخ من غير سلة)",
  sold_after_order: "رسالة بيع لحد طلب خلاص",
  apology_after_order: "اعتذار «ما قدرنا نخدمك» لحد اتخدم",
  late_tap_handover: "ضغطة زرار متأخرة اتحوّلت لموظف",
  staff_claim_silent: "موظف استلم المحادثة وماكتبش",
  handover_unanswered: "تحويل محدش رد عليه",
  no_cart_on_go_ahead: "«جهّزه / أبغى أطلب» من غير سلة",
  upsell_before_cart: "اقتراح قبل السلة بدل زر جوّاها",
  expired_offer_no_alt: "العرض خلص ورد عام من غير بديل",
  denied_received_offer: "«ما عندنا عرض» والعميل واصله عرض",
  misunderstood: "فهم غلط / رد مش على السؤال",
  sold_during_complaint: "بيع لعميل عنده شكوى مفتوحة",
  spam_nudge: "متابعة / بيع لسبام",
  wrong_language: "رد بالإنجليزي لعميل عربي",
  location_no_map: "موقع الفرع من غير رابط الخريطة",
  double_reply: "ماجد والموظف ردّوا مع بعض",
  wrong_price: "سعر غير المنيو الحي",
  dialect_egyptian: "كلام مصري في رد للعميل",
  recipe_disclosure: "كلام وصفة / مقادير / مورّد",
  out_of_hours_send: "رسالة مبادِرة والمطعم مقفول",
  repeated_question: "نفس السؤال اتكرر",
  other: "غير ذلك",
});
export const MISTAKE_STATUSES = Object.freeze({ suspected: "مشتبه", confirmed: "متأكدة", fixed: "اتصلّحت", dismissed: "مش غلطة" });

export const LEARN_DDL = `
  CREATE TABLE IF NOT EXISTS wa_bot_mistakes (
    id BIGSERIAL PRIMARY KEY, mkey TEXT UNIQUE, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'suspected', source TEXT NOT NULL DEFAULT 'selfreview',
    day DATE, phone_masked TEXT, example TEXT, wrong_reply TEXT, correct TEXT, guard TEXT, lesson_dont TEXT, lesson_do TEXT,
    lesson_on BOOLEAN NOT NULL DEFAULT FALSE, detail JSONB, hits INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT);
  CREATE INDEX IF NOT EXISTS wa_bot_mistakes_day_idx ON wa_bot_mistakes(day DESC);
  CREATE INDEX IF NOT EXISTS wa_bot_mistakes_type_idx ON wa_bot_mistakes(type, status);
  CREATE TABLE IF NOT EXISTS wa_bot_lessons (version SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), who TEXT, text TEXT NOT NULL, chars INT NOT NULL DEFAULT 0, ids BIGINT[]);
  CREATE TABLE IF NOT EXISTS wa_selfreview_runs (day DATE PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ, found INT, filed INT, detail JSONB);
  CREATE TABLE IF NOT EXISTS wa_bot_guard_hits (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), phone_norm TEXT, guard TEXT NOT NULL, kind TEXT, value TEXT, text TEXT, blocked BOOLEAN NOT NULL DEFAULT TRUE, log_id BIGINT);
  CREATE INDEX IF NOT EXISTS wa_bot_guard_hits_at_idx ON wa_bot_guard_hits(at DESC);`;

export const maskPhone = (p) => { const s = String(p || "").replace(/\D/g, ""); return s.length >= 4 ? `…${s.slice(-4)}` : null; };
const clip = (v, n) => (v == null ? null : String(v).replace(/\s+/g, " ").trim().slice(0, n) || null);
const riyadhDay = (d) => new Date((d instanceof Date ? d.getTime() : Number(d)) + 3 * 3600_000).toISOString().slice(0, 10);

/* ── أ) مراجعة ١٩/١٠ متزرّعة (٣١ ملاحظة في ١٧ محادثة) — status confirmed، و«ماتعملش / اعمل» لماجد في الغلطات اللي عن كلامه ── */
const R = (key, type, phone, example, wrong, correct, guard, lessonDont = null, lessonDo = null) => ({ mkey: `rev1910:${key}`, type, phone_masked: phone, example, wrong_reply: wrong, correct, guard, lesson_dont: lessonDont, lesson_do: lessonDo, day: "2026-10-18" });
const R2 = (key, type, phone, example, wrong, correct, guard, lessonDont = null, lessonDo = null) => ({ ...R(key, type, phone, example, wrong, correct, guard, lessonDont, lessonDo), mkey: `rev2010:${key}`, day: "2026-10-20" });      // BF3
export const REVIEW_SEED = Object.freeze([
  R("A:1149", "apology_after_order", "…1149", "«عاوز اعمل اوردر» ⇒ موظف ⇒ العميل اتصل وطلب (كاشير ٢٥ ر.س 17:58)", "18:27 «وصلتنا رسالتك وما قدرنا نخدمك وقتها، نعتذر… وش تحب تطلب؟»", "مفيش اعتذار ولا بيع: العميل اتخدم", "waorders.ordersSince في lead_followup (موقع + كاشير، orderAwareHours) + طلب موظف/تحويل بيمنع المتابعة"),
  R("A:0448", "apology_after_order", "…0448", "«Hello» ⇒ الكاشير بعت الروابط ⇒ دفعت موقع ٤٨ ر.س 01:30", "01:53 «ما قدرنا نخدمك وقتها، نعتذر… وش تحب تطلب؟»", "مفيش اعتذار: دفعت قبلها بـ٢٣ دقيقة", "lead_followup بيشوف طلبات الموقع والكاشير في آخر orderAwareHours"),
  R("A:9821", "apology_after_order", "…9821", "ضغطة تقييم ⇒ «شكراً + جوجل» ⇒ ❤️", "18:23 «ما قدرنا نخدمك وقتها، نعتذر»", "تفاعل (❤️) بعد شكر = المحادثة خلصت كويس: مفيش متابعة", "lead_followup: آخر رد للبوت ناجح أو طلب في آخر الساعات ⇒ مفيش متابعة"),
  R("A:0558", "sold_after_order", "…0558", "«انا جاي» / «٢ دقيقة وأكون عندكم» ⇒ دخل الصالة ٩٥ ر.س 17:44", "17:56 «أنا معك 🙂 قل لي كم شخص»", "«حيّاك الله، نستناك 🌟» مرة وسكوت", "comingKind ⇒ رد «coming» + waorders في متابعة «أنا معك»", "تسأل «نفس الطلب السابق؟» تاني لعميل قال «أنا جاي» / «دقيقتين وأكون عندكم»", "ترد «حيّاك الله، نستناك 🌟» مرة وتسكت"),
  R("A:3214", "sold_after_order", "…3214", "المنيو ⇒ طلب في الصالة ٩٦ ر.س 21:32", "21:42 «أنا معك 🙂»", "مفيش متابعة بعد طلب الصالة", "runNudge بيشوف طلبات نقطة البيع (order_sources / ts_customers)"),
  R("A:0494", "sold_after_order", "…0494", "طلب من الكاشير ١٤١+٤+٢٠+٢٩ ر.س 01:10–01:31", "01:25 «أنا معك»", "مفيش متابعة بعد طلب الكاشير", "runNudge + waorders"),
  R("A:6102b", "sold_after_order", "…6102", "طلب كاشير استلام ٥٩ ر.س 17:31", "متابعة بيع بعد الطلب", "مفيش متابعة بيع", "waorders في كل المتابعات"),
  R("B:8282", "late_tap_handover", "…8282", "ضغط «تابع طلبي» (ميتا: 17:03، وصلت 17:37) وطلبه متوصّل", "«سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم»", "الضغطة تتنفّذ: حالة الطلب «اتوصّل»", "decide: late_message للنص المكتوب بس — الضغطات بتتنفّذ"),
  R("B:6102", "late_tap_handover", "…6102", "«أبغى أطلب» (ضغطة وقتها 16:54، وصلت 18:15)", "تحويل late_message، والموظف استلم وماكتبش", "الضغطة تتنفّذ عادي", "decide: late_message للنص المكتوب بس"),
  R("C:8282", "staff_claim_silent", "…8282", "الكاشير ضغط «استلم» 17:38", "ولا رد مكتوب", "تنبيه تاني بعد ٣ دقايق + المدير", "claim_silent: claimSilentMin + claimEscalate"),
  R("C:6102", "staff_claim_silent", "…6102", "تحويل late_message ⇒ استلام", "ولا رد مكتوب", "تنبيه تاني + المدير", "claim_silent"),
  R("C:0356", "staff_claim_silent", "…0356", "«الطلب جاي معاه رز؟» ⇒ موظف ⇒ استلم 18:37", "ولا رد", "ماجد يقرا أصناف الطلب ويرد لوحده؛ ولو اتحوّل: تنبيه تاني", "order_status بيرجّع الأصناف + claim_silent"),
  R("C:2488", "handover_unanswered", "…2488", "تقييم 3★، ردت الصبح 09:11 والمطعم مقفول", "محدش رجعلها لحد 17:20", "أول ما نفتح: تنبيه عاجل للمدير", "closed_complaint عند الفتح (closedComplaintAtOpen)"),
  R("D:6102a", "broken_promise", "…6102", "«جهزها علي ما اوصل» ⇒ «وكريب سوبر زنجر حراق»", "«أضفت كريب زنجر سوبريم وكتبت للمطبخ ملاحظة حار زيادة» — ولا سلة ولا رابط", "سلة حقيقية في نفس الرد + «كتبتها ملاحظة في سلتك»", "promiseProblems (حارس الوعود) + goAheadCart", "تقول «كتبت للمطبخ» أو «أضفت» أو «جهّزت» من غير سلة اتعملت في نفس الرد — مفيش حاجة بتوصل المطبخ من المحادثة", "لما العميل يوافق: build_cart على طول والزر بيتحط؛ والملاحظة «كتبتها ملاحظة في سلتك»"),
  R("D:6102c", "broken_promise", "…6102", "١٩/١٠ 10:36 مقفلين: «عايز نص دجاج فحم وباكت بطاطس»", "«أجهّز لك السلة من الحين» ومااتبنتش", "سلة جاهزة ٣٤ ر.س على طول + «نفتح ١٢» + رسالة وقت الفتح", "حارس الوعود + WO1 «نكمّل لما نفتح»", "تقول «أجهّز لك السلة من الحين» والمطعم مقفول من غير ما تبني السلة", "تبني السلة على طول (الزر بيتحط) وتقول إمتى بنفتح"),
  R("D:2488", "broken_promise", "…2488", "«ربي يبارك فيكم» بعد تقييم 3★", "«تبين أجهّز نفس طلبك السابق؟»", "مفيش بيع لعميلة عندها شكوى مفتوحة", "complaint_open في سياق ماجد + منع البيع"),
  R("D:3466", "broken_promise", "…3466", "«Hello! Can I get more info on this?» والمطعم مقفول", "رد إنجليزي «أي صنف تقصد؟» ومفيش تنبيه عند الفتح", "رد عربي بأشهر عرضين + «نفتح ١٢» + رسالة وقت الفتح", "adPrefill ⇒ عربي + نية طلب لـ«نكمّل لما نفتح»"),
  R("D:0558", "broken_promise", "…0558", "«انا جاي»", "«أبشر، نجهّز لك الطلب. تبي نفس الطلب السابق؟» ×٣", "«حيّاك، نستناك 🌟»", "حارس الوعود + comingKind"),
  R("E:0494", "denied_received_offer", "…0494", "«محتاج أطلب العرض» وواصله ١٥/١٠ «بوكس الكريب لشخصين»", "«حالياً ما عندنا عرض مؤقت»", "العرض اللي وصله (أو بديل لنفس العدد لو خلص)", "last_campaign في سياق ماجد + campExpiredAlt", "تقول «ما عندنا عرض» قبل ما تبص على آخر حملة وصلت العميل (السياق last_campaign)", "تذكر العرض اللي وصله، ولو خلص: أقرب بوكس لنفس العدد بسعره"),
  R("E:7271", "misunderstood", "…7271", "بعت لوكيشن ⇒ «ده الموقع مظبوط»", "«📍 فرعنا في حي السلامة»", "«تمام 👍 وصلنا موقعك»", "locationConfirm ⇒ loc_ok"),
  R("E:0356", "misunderstood", "…0356", "«بطلي من الاون لاين» بعد ما دفع ١٣٠ ر.س", "«الطلب أونلاين يكون من موقعنا… لكم شخص؟» ثم «ما عندي تفاصيل أصنافه… اكتب موظف»", "متابعة طلب: أصناف طلبه من order_status", "existing_order في سياق ماجد + الأصناف", "تشرح إزاي يطلب أونلاين أو تسأل «لكم شخص؟» لعميل عنده طلب لسه دافعه", "تكلمه عن طلبه (حالته وأصنافه من order_status)"),
  R("F:2488", "sold_during_complaint", "…2488", "«استاذ محمد حضرتك؟»", "«أنا ماجد… تبين أجهّز نفس طلبك السابق؟»", "«هوصّل رسالتك لأستاذ محمد» + تحويل", "asksStaffByName ⇒ تحويل + complaint_open", "تعرض «نفس طلبك» أو أي بيع لعميل عنده شكوى أو تقييم واطي مفتوح", "تقول إنك هتوصّل رسالته للفريق وتنده handover"),
  R("G:4333", "expired_offer_no_alt", "…4333", "ضغط «أبغى أطلب» على «باقة التجمّع ٤–٦ أشخاص» (١٥/١٠) والعرض خلص", "«الطلب من موقعنا ياخد دقيقة» من غير بديل", "«العرض ده خلص 🙏 لنفس العدد بوكس العائلة ١٧٩ ر.س» + زر", "camp_alt (altBoxFor)"),
  R("G:9156", "no_cart_on_go_ahead", "…9156", "«أبغى أطلب» (مش على حملة)", "رد عام", "سلة نفس الطلب الأخير لو موجود، وإلا أزرار", "order ⇒ reorder لو فيه طلب سابق يتجهّز"),
  R("H:1526", "upsell_before_cart", "…1526", "«إيه، جهّزه ✅» على «نفس الطلب؟»", "«أضيف لك أرز؟» قبل السلة ⇒ العميل مسح رسالته", "السلة على طول والأرز زر تحتها", "isGoAhead ⇒ reorder / سلة + زر الاقتراح", "تسأل اقتراح (أرز / مشروب) قبل السلة لما العميل قال «جهّزه»", "تبعت السلة على طول، والاقتراح زر تحتها"),
  R("H:6102", "no_cart_on_go_ahead", "…6102", "١٨/١٠: ٣ أدوار من غير build_cart", "ولا سلة", "سلة في نفس الدور", "goAheadCart"),
  R("I:0639", "spam_nudge", "…0639", "رابط دعوة تيمو", "تنبيه «أنا معك 🙂 قل لي كم شخص» ثم بوكس العائلة ١٧٩ (٠٫٢٥ ر.س)", "سطر واحد وسكوت", "spamKind ⇒ spam_line + مفيش متابعة 24 ساعة"),
  R("J:0448", "wrong_language", "…0448", "«Hello» (اسمها مريم)", "رد إنجليزي", "الترحيب بالعربي", "loneLatinGreeting ⇒ عربي"),
  R("J:3466", "wrong_language", "…3466", "نص إعلان «راسلنا» الجاهز بالإنجليزي", "رد إنجليزي", "رد عربي", "adPrefillEn ⇒ عربي"),
  R("K:6575", "location_no_map", "…6575", "«ارسل موقع المحل»", "«📍 فرعنا في حي السلامة بجدة، عند دوار رامي.» بس", "العنوان + رابط الخريطة", "رد location فيه الرابط في النص + الزر"),
  R("L:5430", "double_reply", "…5430", "«عاوزة أطلب أون لاين»", "ماجد والكاشير ردّوا في نفس الدقيقة", "موظف كتب ⇒ ماجد يسكت", "staffStopsMajed + فحص قبل الإرسال"),
  R("L:0448", "double_reply", "…0448", "«Hello»", "ماجد + الكاشير", "موظف كتب ⇒ ماجد يسكت", "staffStopsMajed"),
  R("L:9572", "double_reply", "…9572", "الكاشير كتب «عليكم السلام… مع حضرتك» وماجد شغال", "الاتنين ردّوا", "ماجد يسكت أول ما الموظف يكتب", "staffStopsMajed + فحص قبل الإرسال"),
  /* BF3 (٢٠/١٠، من wa_assist_turns قراية بس): دول بس اللي من النوعين دول في ردود اليوم كله (…5960 «تخفه» اتردّ عليها صح) */
  R2("J:4268a", "wrong_language", "…4268", "«Online» (أول رسالة، كلمة إنجليزي لوحدها — غالباً نص زر من إعلان)", "«I'm Majed, Fresh Cuts' digital assistant. Ordering is simple: tell me what you'd like…»", "الرد بالعربي: معك ماجد… وش تحب تطلب؟", "latinShort ⇒ عربي (turnLang لماجد + detectLang للقواعد) — shortEnglishArabic",
    "ترد بالإنجليزي على كلمة إنجليزي لوحدها أو نص زر («Online» · «Offers» · «Menu» · «Hi»)", "ترد بالعربي؛ الإنجليزي بس لجملة إنجليزي حقيقية"),
  R2("J:4268b", "wrong_language", "…4268", "«Offers» بعد دقيقة", "«Here's what we have right now: 🔥 Our offers now: • Crepe Solo Box — SAR 29 …» (العروض كلها بالإنجليزي)", "نفس العروض بأسعارها بالعربي («بوكس الكريب الفردي 29 ر.س»…)", "latinShort ⇒ عربي، ولغة المحادثة ماتتسجّلش إنجليزي من كلمة واحدة"),
  R2("P:5082", "misunderstood", "…5082", "«الشوي انهارده احسن من امبارح» (مدح، بعد ملاحظة على طلبه)", "«سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.» + تحويل needs_staff", "«تسلم، يسعدنا إن الشوي عجبك 🙏 ننتظرك دايماً» — مفيش تحويل", "complimentOnly ⇒ رد praise (القواعد) + customer_praise لماجد + handover(needs_staff) مرفوض على المدح — praiseThanks",
    "تحوّل مدح الأكل («الشوي انهارده احسن من امبارح») لموظف", "سطر شكر دافي («تسلم، يسعدنا إن الشوي عجبك 🙏 ننتظرك دايماً»)، والشكوى بس تتحوّل"),
].map((x) => ({ ...x, lesson_on: Boolean(x.lesson_dont || x.lesson_do) })));

/* ── ب) كتلة الدروس ────────────────────────────────────────────────────────── */
/* rows = غلطات متأكدة/اتصلّحت فيها lesson_on (الأحدث تأكيداً أولاً). سطر لكل درس (من غير تكرار نفس النص)، مقصوصة على maxChars. ⇒ { text, ids } */
export function lessonsText(rows, maxChars = LEARN_DEFAULTS.lessonsMaxChars) {
  const head = "# Lessons from real mistakes in our chats (approved by the owner; follow them exactly like the rules above)";
  const seen = new Set(), lines = [], ids = [];
  let len = head.length;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.lesson_on || !["confirmed", "fixed"].includes(String(r.status))) continue;
    const dont = clip(r.lesson_dont, 260), dox = clip(r.lesson_do, 260);
    if (!dont && !dox) continue;
    const line = `- ${dont ? `Never: ${dont}.` : ""}${dont && dox ? " " : ""}${dox ? `Instead: ${dox}.` : ""}`;
    const k = normalize(line); if (seen.has(k)) continue;
    if (len + line.length + 1 > maxChars) break;
    seen.add(k); lines.push(line); ids.push(Number(r.id) || null); len += line.length + 1;
  }
  return { text: lines.length ? `${head}\n${lines.join("\n")}` : "", ids: ids.filter(Boolean) };
}

/* ── ج) الفحوص الثابتة على النص (صافية) ───────────────────────────────────── */
export const DIALECT_EG_RE = /(?<![\p{L}])(عايز|عاوز|عايزه|دلوقتي|ازاي|إزاي|كده|كدا|بتاع|بتاعت|بتاعك|أوي|اوي|علشان|عشان كده|مفيش|حضرتك|يا فندم|يافندم|ايوه يا)(?![\p{L}])/u;
export const RECIPE_SAY_RE = /(?:نتبل(?:ه|ها)? ب|التتبيل[ةه] في(?:ها)?|متبل ب|بنحط (?:عليه|فيه)|مقادير|\d+ ?(?:جرام|غرام|جم)\b|موردنا|المورد (?:حقنا|عندنا|هو)|نشتري (?:اللحم|الدجاج)? ?من|we (?:marinate|season) (?:it )?with|our supplier is)/u;
/* أسعار غلط (BF2 ٢٠/١٠: أول فحص ليلي قرا «المجموع 58 ر.س» كسعر البطاطس): بنقارن **بس** الرقم اللي لازق في اسم الصنف —
   «*X* بـ N ر.س» · «X (N ر.س)» · «X: N ر.س» · «X N ر.س» (وزن زي «نصف كيلو» بينهم مسموح). أي رقم بعد المجموع / الإجمالي / total / التوصيل / الرسوم /
   الحد الأدنى / «من» / «فوق» / الكوبون، أو مفصول عن الاسم بكلمة أو علامة (✅ . + =)، مش سعر الصنف ومابيتقارنش. الكمية («2 ×» / «×2» / «2 كيلو») ⇒ السعر × الكمية مقبول.
   الاسم جوّه اسم بوكس ⇒ مايتفحصش. سطر خصم / عرض / بدل ⇒ مايتفحصش. محافظ: الشك ⇒ مش غلطة. */
const fold = (s) => String(s || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).toLowerCase().replace(/[ً-ٰٟـ]/g, "")      // الأرقام الأول: مدى التشكيل ده بيشمل ٠-٩
  .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
  .replace(/\s+/g, " ");
const CUR = String.raw`(?:ر\.?\s?س|ريال|sar)(?![\p{L}])`;
const WEIGHT = String.raw`(?:(?:ثلث|ربع|نصف|نص)\s*(?:ال)?كيلو|(\d+(?:\.\d+)?)\s*كيلو|كيلو(?:ين)?)`;
/* بعد الاسم مباشرة: نجمة البولد، كمية «×2»، رابط واحد (: - – ( بـ بسعر)، وزن، الرقم والعملة */
const ATTACH_RE = new RegExp(String.raw`^\*{0,2}\s*(?:[×x]\s*(\d+)\s*)?(?:[(:\-–]\s*)?(?:(?:بسعر|ب)\s*)?(?:${WEIGHT}\s*[:\-–]?\s*)?(\d+(?:\.\d+)?)\s*${CUR}`, "u");
const QTY_BEFORE_RE = /(?:^|[\s(])(\d+)\s*(?:[×x]\s*|كيلو\s*)?\*{0,2}\s*$/u;      // «2 ×» · «2 كيلو» قبل الاسم
const CLAUSE_SKIP_RE = /(?:^|[^\p{L}])(?:ال)?(?:مجموع|اجمالي|الكل|total|subtotal|توصيل|رسوم|حد ادني|الحد الادني|اقل طلب|minimum|fee|delivery|من|فوق|اكثر|باقي|يصير|كوبون|كود)(?![\p{L}])/u;
const LINE_SKIP_RE = /خصم|كوبون|بدل|عرض|وفر|توفير|%|off\b/u;
export function priceMismatches(text, { menu = null, boxes = [] } = {}) {
  const items = (menu && Array.isArray(menu.items) ? menu.items : []).filter((i) => i && i.name && fold(i.name).trim().length >= 4);
  if (!items.length) return [];
  const names = [...items.map((it) => ({ it, n: fold(it.name).trim() })), ...(boxes || []).filter((b) => b && b.name && fold(b.name).trim().length >= 4).map((b) => ({ box: b, n: fold(b.name).trim() }))]
    .sort((a, b) => b.n.length - a.n.length);
  const out = [];
  for (const line0 of String(text || "").split("\n")) {
    const line = fold(line0);
    if (!/\d/.test(line) || LINE_SKIP_RE.test(line)) continue;
    const taken = [];
    for (const c of names) {
      let from = 0, at;
      while ((at = line.indexOf(c.n, from)) >= 0) {
        from = at + 1;
        const end = at + c.n.length;
        if (/\p{L}/u.test(line[at - 1] || "") || /\p{L}/u.test(line[end] || "")) continue;      // جزء من كلمة تانية
        if (taken.some(([a, b]) => at < b && end > a)) continue;                                // جوّه اسم أطول (صنف أو بوكس)
        taken.push([at, end, c]);
      }
    }
    for (const [at, end, c] of taken.sort((a, b) => a[0] - b[0])) {
      if (c.box) continue;
      const m = ATTACH_RE.exec(line.slice(end)); if (!m) continue;
      const head = line.slice(0, at), clause = head.split(/[.،,؛;!?؟+=\n]/).pop();
      if (CLAUSE_SKIP_RE.test(clause.replace(/\*/g, " "))) continue;                            // «المجموع مع X …» / «التوصيل من …»
      const qb = QTY_BEFORE_RE.exec(clause);
      const qty = [Number(m[1]) || 1, Number(m[2]) || 1, qb ? Number(qb[1]) || 1 : 1].reduce((a, b) => a * b, 1);
      const it = c.it, v = Math.round(Number(m[3]) * 100) / 100;
      const base = [Number(it.price), ...((it.weights || []).map((w) => Number(w.price)))].filter((x) => Number.isFinite(x) && x > 0);
      if (!base.length) continue;
      const ok = new Set(); for (const x of base) for (const k of new Set([1, qty])) ok.add(Math.round(x * k * 100) / 100);
      if (ok.has(v)) continue;
      out.push({ item: it.name, said: v, live: base.map((x) => Math.round(x * 100) / 100).slice(0, 3) });
    }
  }
  return out.slice(0, 3);
}
/* دليل السلة في الدور (نفس إشارة حارس الوعود الحي: build_cart ⇒ cartBuilt، preview_cart أو build_cart ⇒ cartTouched) من سجل أدوار المساعد
   wa_assist_turns (tool_calls / cart_code)، ومعاه رابط سلة «/c/…» في الرد نفسه. بيشتغل كمان على ردود قبل ما الحارس يتنشر. */
export function cartEvidence(turns = [], replies = null) {
  let cartBuilt = /\/c\/[a-z0-9]{6,16}/i.test(JSON.stringify(replies || "")), cartTouched = false;
  for (const t of turns || []) {
    if (t && t.cart_code) cartBuilt = true;
    const tools = Array.isArray(t && t.tool_calls) ? t.tool_calls : (() => { try { return JSON.parse((t && t.tool_calls) || "[]"); } catch { return []; } })();
    for (const x of tools || []) {
      const okRes = x && x.result && typeof x.result === "object" ? x.result.ok !== false && !x.result.error : Boolean(x && x.result);
      if (!okRes) continue;
      if (x.name === "build_cart") cartBuilt = true;
      if (x.name === "preview_cart") cartTouched = true;
    }
  }
  return { cartBuilt, cartTouched: cartBuilt || cartTouched };
}
/* نصوص الردود اللي طلعت من صف السجل (replies = payloads) */
export function replyTexts(replies) {
  const arr = Array.isArray(replies) ? replies : (() => { try { return JSON.parse(replies || "[]"); } catch { return []; } })();
  return arr.map((p) => String((p && (p.text?.body || p.interactive?.body?.text)) || "")).filter(Boolean).join("\n");
}
/* BF3: رد «إنجليزي» = ٥ كلمات لاتيني ورا بعض ومفيش ٥ كلمات عربي ورا بعض؛ رد التحويل لموظف */
const EN_REPLY_RE = /(?:[A-Za-z][A-Za-z'’-]*[\s,.;:!?()-]+){5,}/, AR_REPLY_RE = /[؀-ۿ]{2,}(?:\s+[؀-ۿ]{2,}){4,}/, HANDOVER_SAY_RE = /يحتاج واحد من الفريق|حوّلته لهم|حولته لهم|حوّلت محادثتك|حولت محادثتك/;
const SALES_KEYS = ["lead_followup", "lead_nudge", "assist_followup", "reply_followup", "window_keep", "open_followup", "assist_reminder"];
const PROACTIVE = ["lead_followup", "lead_nudge", "assist_followup", "reply_followup", "window_keep", "open_followup", "paid_note"];

/* ═══ المصنع: القاعدة والمنيو من wabotrun ═══════════════════════════════════════ */
export function makeLearn({ q, ddl = null, jb, now = () => new Date(), menuIndex = null, bundles = null, getSettings = null, log = console } = {}) {
  let lessonCache = { at: -1e15, text: "", version: null };
  async function ensure() {
    /* DDL متعدد الجمل: لازم من غير parameters (ddl = pool.query الخام) */
    try { if (ddl) await ddl(LEARN_DDL); else if ((await q(LEARN_DDL)) === null) return false; } catch (e) { (log.error || console.error)("[learn] schema:", e.message); return false; }
    for (const r of REVIEW_SEED) {
      await q(`INSERT INTO wa_bot_mistakes(mkey, type, status, source, day, phone_masked, example, wrong_reply, correct, guard, lesson_dont, lesson_do, lesson_on, updated_by)
               VALUES ($1,$2,'confirmed','review',$3,$4,$5,$6,$7,$8,$9,$10,$11,'bf1-seed') ON CONFLICT (mkey) DO NOTHING`,
        [r.mkey, r.type, r.day, r.phone_masked, r.example, r.wrong_reply, r.correct, r.guard, r.lesson_dont, r.lesson_do, r.lesson_on]);
    }
    await rebuildLessons(null, "bf1-seed");
    return true;
  }
  /* نسخة جديدة من الدروس لو النص اتغيّر */
  async function rebuildLessons(maxChars = null, who = null) {
    let max = maxChars;
    if (!max && getSettings) { try { max = learnConfig(((await getSettings()) || {}).waBot || {}).lessonsMaxChars; } catch { max = null; } }
    const rows = await q("SELECT id, status, lesson_on, lesson_dont, lesson_do FROM wa_bot_mistakes WHERE lesson_on AND status IN ('confirmed','fixed') ORDER BY updated_at DESC, id DESC LIMIT 200", []);
    if (rows === null) return null;
    const { text, ids } = lessonsText(rows, max || LEARN_DEFAULTS.lessonsMaxChars);
    const last = ((await q("SELECT version, text FROM wa_bot_lessons ORDER BY version DESC LIMIT 1", [])) || [])[0] || null;
    if (last && String(last.text || "") === text) { lessonCache = { at: now().getTime(), text, version: last.version }; return last.version; }
    if (!last && !text) return null;
    const ins = await q("INSERT INTO wa_bot_lessons(who, text, chars, ids) VALUES ($1,$2,$3,$4) RETURNING version", [who ? String(who).slice(0, 60) : null, text, text.length, ids]);
    const v = ins && ins[0] ? ins[0].version : null;
    lessonCache = { at: now().getTime(), text, version: v };
    return v;
  }
  /* للمساعد: آخر نسخة (كاش دقيقة). مقفول من اللوحة ⇒ "" */
  async function lessonsNow(cfgLearn) {
    if (cfgLearn && cfgLearn.lessonsEnabled === false) return { text: "", version: null };
    if (now().getTime() - lessonCache.at < 60_000 && lessonCache.at > 0) return { text: lessonCache.text, version: lessonCache.version };
    const last = ((await q("SELECT version, text FROM wa_bot_lessons ORDER BY version DESC LIMIT 1", [])) || [])[0] || null;
    lessonCache = { at: now().getTime(), text: last ? String(last.text || "") : "", version: last ? last.version : null };
    const max = cfgLearn && cfgLearn.lessonsMaxChars ? cfgLearn.lessonsMaxChars : LEARN_DEFAULTS.lessonsMaxChars;
    return { text: lessonCache.text.slice(0, max), version: lessonCache.version };
  }
  /* حارس مسك رد (وقت التشغيل) ⇒ صف للفحص الليلي */
  async function recordGuardHit({ phone, guard, kind = null, value = null, text = null, blocked = true, logId = null }) {
    return q("INSERT INTO wa_bot_guard_hits(phone_norm, guard, kind, value, text, blocked, log_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [/^5\d{8}$/.test(String(phone || "")) ? String(phone) : null, String(guard).slice(0, 40), kind ? String(kind).slice(0, 40) : null, clip(value, 120), clip(maskText(text || ""), 300), blocked !== false, logId || null]);
  }
  /* صف مشتبه (مفتاح ثابت ⇒ مرة واحدة؛ اتكرر ⇒ hits+1) */
  async function file(c, day) {
    const r = await q(`INSERT INTO wa_bot_mistakes(mkey, type, status, source, day, phone_masked, example, wrong_reply, correct, guard, detail)
                       VALUES ($1,$2,'suspected','selfreview',$3,$4,$5,$6,$7,$8,$9)
                       ON CONFLICT (mkey) DO UPDATE SET hits = wa_bot_mistakes.hits + 1, updated_at = NOW() RETURNING (xmax = 0) AS inserted`,
      [c.mkey, c.type, day, c.phone_masked || null, clip(c.example, 400), clip(c.wrong_reply, 400), clip(c.correct, 300), clip(c.guard, 200), jb(c.detail || {})]);
    return Boolean(r && r[0] && r[0].inserted);
  }

  /* الفحص نفسه لليوم التشغيلي `day` (YYYY-MM-DD بالرياض: من ٤ الفجر لـ٤ الفجر اللي بعده). قراية بس من المحادثات. ⇒ { found, filed, byType } */
  async function runSelfReview(day, { max = LEARN_DEFAULTS.selfReviewMax, orderAwareHours = LEARN_DEFAULTS.orderAwareHours, claimMin = LEARN_DEFAULTS.claimSilentMin } = {}) {
    const from = new Date(`${day}T04:00:00+03:00`), to = new Date(from.getTime() + 24 * 3600_000);
    const A = [from.toISOString(), to.toISOString()];
    const cands = [];
    const add = (c) => { if (c && c.mkey && cands.length < max * 3) cands.push(c); };
    const key = (type, phone, ref) => `sr:${day}:${type}:${String(phone || "").slice(-6)}:${String(ref || "").slice(0, 40)}`;
    /* ١) الحارس مسك وعد */
    for (const h of (await q("SELECT id, phone_norm, guard, kind, value, text FROM wa_bot_guard_hits WHERE at >= $1 AND at < $2 ORDER BY at LIMIT 200", A)) || [])
      add({ mkey: key("broken_promise", h.phone_norm, `g${h.id}`), type: h.guard === "promise" ? "broken_promise" : h.guard === "offer" ? "denied_received_offer" : "other", phone_masked: maskPhone(h.phone_norm), example: h.text, wrong_reply: h.value, correct: "اتمسك قبل ما يتبعت ورد البوت الثابت راح بداله — راجع لو الدرس محتاج يتكتب", guard: `حارس ${h.guard}${h.kind ? ` (${h.kind})` : ""}`, detail: { hit: Number(h.id) } });
    /* ٢) رسالة بيع / اعتذار لحد طلب (موقع أو نقطة بيع) في الساعات اللي قبلها */
    const sales = (await q(`/*sr:sales*/ SELECT l.id, l.phone_norm, l.at, l.reply_key, l.replies FROM wa_bot_log l
        WHERE l.at >= $1 AND l.at < $2 AND l.decision = 'replied' AND l.reply_key = ANY($3::text[])
          AND (EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm = l.phone_norm AND NOT COALESCE(o.is_test,false) AND o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed') AND o.created_at < l.at AND o.created_at > l.at - make_interval(hours => $4::int))
            OR EXISTS (SELECT 1 FROM ts_orders t LEFT JOIN order_sources s ON s.order_id = t.order_id LEFT JOIN ts_customers tc ON tc.customer_id = t.customer_id
                        WHERE (s.phone_norm = l.phone_norm OR tc.phone_norm = l.phone_norm) AND t.order_date < l.at AND t.order_date > l.at - make_interval(hours => $4::int)))
        ORDER BY l.at LIMIT 100`, [...A, SALES_KEYS, orderAwareHours])) || [];
    for (const s of sales) add({ mkey: key(s.reply_key === "lead_followup" ? "apology_after_order" : "sold_after_order", s.phone_norm, s.id), type: s.reply_key === "lead_followup" ? "apology_after_order" : "sold_after_order", phone_masked: maskPhone(s.phone_norm), example: `طلب قبل الرسالة بأقل من ${orderAwareHours} ساعة`, wrong_reply: replyTexts(s.replies), correct: "مفيش بيع ولا اعتذار لعميل طلب", guard: "waorders.ordersSince", detail: { log: Number(s.id), key: s.reply_key } });
    /* ٣) موظف استلم وماكتبش (wa_chat_owner_log take) */
    const takes = (await q(`/*sr:claims*/ SELECT g.id, g.phone_norm, g.at, g.by_name FROM wa_chat_owner_log g
        WHERE g.at >= $1 AND g.at < $2 AND g.action = 'take'
          AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm = g.phone_norm AND m.direction = 'out' AND m.created_at > g.at AND m.created_at < g.at + make_interval(mins => $3::int)
                           AND COALESCE(m.status,'') NOT IN ('failed','skipped') AND ((m.source = 'echo' AND COALESCE(m.echo_kind,'staff') <> 'auto') OR (m.template IS NULL AND COALESCE(m.source,'api') NOT IN ('bot','window','echo'))))
        ORDER BY g.at LIMIT 100`, [...A, Math.max(10, claimMin * 3)])) || [];
    for (const t of takes) add({ mkey: key("staff_claim_silent", t.phone_norm, t.id), type: "staff_claim_silent", phone_masked: maskPhone(t.phone_norm), example: `استلم ${t.by_name || "موظف"}`, wrong_reply: "ولا رد مكتوب بعد الاستلام", correct: "رد في خلال دقايق، أو «سيبها للبوت»", guard: "claim_silent", detail: { take: Number(t.id) } });
    /* ٤) ضغطة متأخرة اتحوّلت لموظف */
    for (const l of (await q(`/*sr:latetap*/ SELECT id, phone_norm, text FROM wa_bot_log WHERE at >= $1 AND at < $2 AND handoff = 'late_message' AND COALESCE(msg_type,'') IN ('interactive','button') LIMIT 50`, A)) || [])
      add({ mkey: key("late_tap_handover", l.phone_norm, l.id), type: "late_tap_handover", phone_masked: maskPhone(l.phone_norm), example: l.text, wrong_reply: "تحويل late_message", correct: "الضغطة تتنفّذ", guard: "decide: late_message للنص بس", detail: { log: Number(l.id) } });
    /* ٥) تحويل محدش رد عليه في ٣٠ دقيقة */
    for (const h of (await q(`/*sr:unanswered*/ SELECT h.id, h.phone_norm, h.reason, h.at FROM wa_handovers h WHERE h.at >= $1 AND h.at < $2 AND NOT h.test AND COALESCE(h.reason,'') NOT IN ('order_note','loop_guard','staff_silent')
          AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm = h.phone_norm AND m.direction = 'out' AND m.created_at > h.at AND m.created_at < h.at + INTERVAL '30 minutes'
                           AND COALESCE(m.status,'') NOT IN ('failed','skipped') AND ((m.source = 'echo' AND COALESCE(m.echo_kind,'staff') <> 'auto') OR (m.template IS NULL AND COALESCE(m.source,'api') NOT IN ('bot','window','echo'))))
        ORDER BY h.at LIMIT 100`, A)) || [])
      add({ mkey: key("handover_unanswered", h.phone_norm, h.id), type: "handover_unanswered", phone_masked: maskPhone(h.phone_norm), example: `تحويل: ${h.reason}`, wrong_reply: "محدش رد في ٣٠ دقيقة", correct: "رد من الفريق", guard: "handover_check + claim_silent", detail: { handover: Number(h.id) } });
    /* ٦–٩) نص ردود البوت وماجد في اليوم: سعر، لهجة، وصفات، برا الساعات، وعود */
    const rows = (await q(`/*sr:replies*/ SELECT id, phone_norm, at, reply_key, replies, text, lang, handoff FROM wa_bot_log WHERE at >= $1 AND at < $2 AND decision = 'replied' AND replies IS NOT NULL ORDER BY at LIMIT 2000`, A)) || [];
    /* BF2: دليل السلة لكل رد من ردود ماجد (سجل الأدوار) — «أضفت» بعد preview_cart ناجح مش وعد مكسور */
    const turnsBy = new Map();
    const assistIds = rows.filter((r) => r.reply_key === "assist").map((r) => Number(r.id)).filter(Number.isFinite);
    if (assistIds.length) for (const t of (await q(`/*sr:turns*/ SELECT log_id, cart_code, tool_calls FROM wa_assist_turns WHERE log_id = ANY($1::bigint[])`, [assistIds])) || []) {
      const k = String(t.log_id); if (!turnsBy.has(k)) turnsBy.set(k, []); turnsBy.get(k).push(t); }
    let menu = null, boxes = [];
    try { menu = menuIndex ? await menuIndex() : null; boxes = bundles ? (await bundles()) || [] : []; } catch { menu = null; }
    let settings = null; try { settings = getSettings ? await getSettings() : null; } catch { settings = null; }
    const realEn = new Set(rows.filter((r) => r.lang === "en" && r.text && !latinShort(r.text)).map((r) => String(r.phone_norm)));      // BF3: الرقم كتب جملة إنجليزي حقيقية في اليوم
    for (const r of rows) {
      const txt = replyTexts(r.replies); if (!txt) continue;
      /* BF3 (…4268): رد إنجليزي على كلمة إنجليزي لوحدها / نص زر، والعميل ماكتبش جملة إنجليزي حقيقية في اليوم */
      if (r.text && latinShort(r.text) && !realEn.has(String(r.phone_norm)) && EN_REPLY_RE.test(txt) && !AR_REPLY_RE.test(txt))
        add({ mkey: key("wrong_language", r.phone_norm, r.id), type: "wrong_language", phone_masked: maskPhone(r.phone_norm), example: `«${String(r.text).slice(0, 60)}»`, wrong_reply: txt, correct: "الرد بالعربي (كلمة إنجليزي لوحدها مش لغة العميل)", guard: "latinShort ⇒ عربي (shortEnglishArabic)", detail: { log: Number(r.id) } });
      /* BF3 (…5082): مدح اتحوّل لموظف */
      if (r.text && complimentOnly(r.text) && (r.handoff || HANDOVER_SAY_RE.test(txt)))
        add({ mkey: key("misunderstood", r.phone_norm, `p${r.id}`), type: "misunderstood", phone_masked: maskPhone(r.phone_norm), example: `مدح: «${String(r.text).slice(0, 80)}»`, wrong_reply: txt, correct: "شكر قصير («تسلم، يسعدنا إن … عجبك 🙏») من غير تحويل", guard: "complimentOnly ⇒ praise (praiseThanks)", detail: { log: Number(r.id) } });
      for (const pm of priceMismatches(txt, { menu, boxes })) add({ mkey: key("wrong_price", r.phone_norm, `${r.id}:${pm.item}`), type: "wrong_price", phone_masked: maskPhone(r.phone_norm), example: `${pm.item}: قال ${pm.said}، المنيو الحي ${pm.live.join(" / ")}`, wrong_reply: txt, correct: "السعر من المنيو الحي", guard: "validator أسعار المساعد", detail: { log: Number(r.id), ...pm } });
      const eg = DIALECT_EG_RE.exec(txt); if (eg) add({ mkey: key("dialect_egyptian", r.phone_norm, r.id), type: "dialect_egyptian", phone_masked: maskPhone(r.phone_norm), example: eg[0], wrong_reply: txt, correct: "أبيض / فصحى بسيطة", guard: "dialect_egyptian (المساعد) + نصوص اللوحة", detail: { log: Number(r.id), key: r.reply_key } });
      const rc = RECIPE_SAY_RE.exec(txt); if (rc) add({ mkey: key("recipe_disclosure", r.phone_norm, r.id), type: "recipe_disclosure", phone_masked: maskPhone(r.phone_norm), example: rc[0], wrong_reply: txt, correct: "سطر الاعتذار المهني من غير تفاصيل", guard: "secret + recipe_disclosure", detail: { log: Number(r.id) } });
      if (r.reply_key === "assist") { const pp = promiseProblems(txt, cartEvidence(turnsBy.get(String(r.id)) || [], r.replies)); if (pp.length) add({ mkey: key("broken_promise", r.phone_norm, r.id), type: "broken_promise", phone_masked: maskPhone(r.phone_norm), example: pp.map((x) => x.value).join(" · "), wrong_reply: txt, correct: "مايتقالش إلا لو حصل", guard: "promiseProblems", detail: { log: Number(r.id) } }); }
      if (PROACTIVE.includes(String(r.reply_key)) && settings && isRestaurantOpenAt(new Date(r.at), settings) === false) add({ mkey: key("out_of_hours_send", r.phone_norm, r.id), type: "out_of_hours_send", phone_masked: maskPhone(r.phone_norm), example: `${r.reply_key} ${new Date(r.at).toISOString()}`, wrong_reply: txt, correct: "الرسايل المبادِرة بمواعيد المطعم بس", guard: "sendhours.isRestaurantOpenAt", detail: { log: Number(r.id) } });
    }
    /* ١٠) ماجد والموظف ردّوا مع بعض: رد ماجد خلال دقيقة من رسالة موظف (قبلها أو بعدها) لنفس العميل */
    for (const d of (await q(`/*sr:double*/ SELECT l.id, l.phone_norm, l.at FROM wa_bot_log l WHERE l.at >= $1 AND l.at < $2 AND l.decision = 'replied' AND l.reply_key = 'assist'
          AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm = l.phone_norm AND m.source = 'echo' AND COALESCE(m.echo_kind,'staff') <> 'auto' AND m.created_at BETWEEN l.at - INTERVAL '60 seconds' AND l.at + INTERVAL '60 seconds') LIMIT 50`, A)) || [])
      add({ mkey: key("double_reply", d.phone_norm, d.id), type: "double_reply", phone_masked: maskPhone(d.phone_norm), example: "رد ماجد ورسالة موظف في نفس الدقيقة", wrong_reply: null, correct: "موظف كتب ⇒ ماجد يسكت", guard: "staffStopsMajed", detail: { log: Number(d.id) } });
    let filed = 0; const byType = {};
    for (const c of cands.slice(0, max)) { if (await file(c, day)) { filed++; byType[c.type] = (byType[c.type] || 0) + 1; } }
    return { found: cands.length, filed, byType };
  }
  /* كل دقيقة من sweeps: بعد الساعة المحددة، مرة لكل يوم تشغيلي (اللي خلص). الحجز بصف wa_selfreview_runs قبل التشغيل. */
  async function maybeNightly(t, lc) {
    if (!lc || !lc.selfReview) return null;
    const r = new Date(t.getTime() + 3 * 3600_000), mins = r.getUTCHours() * 60 + r.getUTCMinutes();
    if (mins < lc.selfReviewHour * 60 + lc.selfReviewMinute || r.getUTCHours() >= 12) return null;
    const day = riyadhDay(new Date(t.getTime() - 24 * 3600_000));      // اليوم التشغيلي اللي خلص (٤ الفجر امبارح ⇒ ٤ الفجر النهارده)
    const claim = await q("INSERT INTO wa_selfreview_runs(day) VALUES ($1) ON CONFLICT (day) DO NOTHING RETURNING day", [day]);
    if (!claim || !claim.length) return null;
    let res = null;
    try { res = await runSelfReview(day, { max: lc.selfReviewMax, orderAwareHours: lc.orderAwareHours, claimMin: lc.claimSilentMin }); }
    catch (e) { (log.error || console.error)("[learn] self-review:", e.message); res = { found: 0, filed: 0, error: String(e.message).slice(0, 120) }; }
    await q("UPDATE wa_selfreview_runs SET finished_at=NOW(), found=$2, filed=$3, detail=$4 WHERE day=$1", [day, res.found || 0, res.filed || 0, jb(res)]);
    return { day, ...res };
  }
  /* د) العدّ اليومي حسب النوع */
  async function dailyCounts(days = 14) {
    const r = await q(`SELECT day::text AS day, type, count(*)::int AS n, count(*) FILTER (WHERE status IN ('confirmed','fixed'))::int AS confirmed
                         FROM wa_bot_mistakes WHERE source <> 'review' AND day > (NOW() AT TIME ZONE 'Asia/Riyadh')::date - $1::int GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC`, [Math.min(90, Math.max(1, Number(days) || 14))]);
    const g = await q(`SELECT (at AT TIME ZONE 'Asia/Riyadh')::date::text AS day, guard, count(*)::int AS n FROM wa_bot_guard_hits WHERE at > NOW() - make_interval(days => $1::int) GROUP BY 1,2 ORDER BY 1 DESC`, [Math.min(90, Math.max(1, Number(days) || 14))]);
    const open = await q("SELECT count(*)::int AS n FROM wa_bot_mistakes WHERE status = 'suspected'", []);
    return { byDay: r || [], guardHits: g || [], suspectedOpen: open && open[0] ? Number(open[0].n) || 0 : null };
  }
  return { ensure, rebuildLessons, lessonsNow, recordGuardHit, runSelfReview, maybeNightly, dailyCounts, file };
}

/* ═══ مسارات اللوحة ═══════════════════════════════════════════════════════════ */
export const MISTAKE_COLUMNS = Object.freeze([
  { key: "id", label: "#", type: "number" }, { key: "day", label: "اليوم", type: "date" }, { key: "type_ar", label: "النوع", type: "text" },
  { key: "status_ar", label: "الحالة", type: "badge" }, { key: "phone_masked", label: "الرقم", type: "text" }, { key: "example", label: "المحادثة", type: "text" },
  { key: "wrong_reply", label: "الرد الغلط", type: "text" }, { key: "correct", label: "الصح", type: "text" }, { key: "guard", label: "الحارس / القاعدة", type: "text" },
  { key: "lesson", label: "درس ماجد", type: "text" }, { key: "hits", label: "تكرار", type: "number" }, { key: "source_ar", label: "المصدر", type: "text" },
]);
const SOURCE_AR = { review: "مراجعة يدوية (١٩/١٠ + ٢٠/١٠)", selfreview: "الفحص الليلي", owner: "المالك" };
export const mistakeRow = (r) => ({ id: Number(r.id), day: r.day ? String(r.day).slice(0, 10) : null, type: r.type, type_ar: MISTAKE_TYPES[r.type] || r.type, status: r.status, status_ar: MISTAKE_STATUSES[r.status] || r.status,
  phone_masked: r.phone_masked || null, example: r.example || null, wrong_reply: r.wrong_reply || null, correct: r.correct || null, guard: r.guard || null,
  lesson_dont: r.lesson_dont || null, lesson_do: r.lesson_do || null, lesson_on: r.lesson_on === true, lesson: [r.lesson_dont ? `ماتعملش: ${r.lesson_dont}` : "", r.lesson_do ? `اعمل: ${r.lesson_do}` : ""].filter(Boolean).join(" · ") || null,
  hits: Number(r.hits) || 1, source: r.source, source_ar: SOURCE_AR[r.source] || r.source, updated_by: r.updated_by || null, updated_at: r.updated_at || null });

/* body ⇒ { ok, value } أو { ok:false, errors } — الحقول المسموحة بس */
export function mistakeFromBody(b = {}, { create = false } = {}) {
  const src = b && typeof b === "object" ? b : {}, out = {}, errors = [];
  if ("type" in src || create) { if (MISTAKE_TYPES[src.type]) out.type = src.type; else errors.push("type"); }
  if ("status" in src) { if (MISTAKE_STATUSES[src.status]) out.status = src.status; else errors.push("status"); }
  for (const [k, n] of [["example", 400], ["wrong_reply", 400], ["correct", 300], ["guard", 200], ["lesson_dont", 260], ["lesson_do", 260], ["phone_masked", 12]]) if (k in src) { const v = src[k] == null ? null : String(src[k]).replace(/\s+/g, " ").trim(); if (v && v.length > n) errors.push(`${k}:max ${n}`); else out[k] = k === "phone_masked" ? (v ? maskPhone(v) || v.slice(0, 12) : null) : v || null; }
  if ("lesson_on" in src) out.lesson_on = src.lesson_on === true;
  if ("example" in out && out.example) out.example = maskText(out.example).slice(0, 400);      // الرقم والعنوان مخفيين دايماً
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export function registerLearnRoutes(app, { requireAdmin, ownerOnly, actorOf, learn, q, cfgOf }) {
  app.get("/api/cms/wabot/mistakes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const status = c.req.query("status"), type = c.req.query("type"), days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 60));
    const rows = await q(`SELECT * FROM wa_bot_mistakes WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR type = $2) AND (day IS NULL OR day > (NOW() AT TIME ZONE 'Asia/Riyadh')::date - $3::int OR source = 'review')
                           ORDER BY (status = 'suspected') DESC, day DESC NULLS LAST, id DESC LIMIT 500`, [MISTAKE_STATUSES[status] ? status : null, MISTAKE_TYPES[type] ? type : null, days]);
    if (rows === null) return c.json({ ok: false, error: "db" }, 500);
    const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const lc = cfgOf ? await cfgOf() : LEARN_DEFAULTS;
    const ln = await learn.lessonsNow(lc);
    return c.json({ ok: true, columns: MISTAKE_COLUMNS, rows: rows.map(mistakeRow), types: Object.entries(MISTAKE_TYPES).map(([key, label]) => ({ key, label })), statuses: Object.entries(MISTAKE_STATUSES).map(([key, label]) => ({ key, label })),
      counts, lessons: { enabled: lc.lessonsEnabled !== false, version: ln.version, chars: ln.text.length, max: lc.lessonsMaxChars } });
  });
  app.post("/api/cms/wabot/mistakes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const v = mistakeFromBody(b, { create: true });
    if (!v.ok) return c.json({ ok: false, error: "invalid", errors: v.errors }, 400);
    const x = v.value, who = await actorOf(c);
    const r = await q(`INSERT INTO wa_bot_mistakes(type, status, source, day, phone_masked, example, wrong_reply, correct, guard, lesson_dont, lesson_do, lesson_on, updated_by)
                       VALUES ($1,$2,'owner',(NOW() AT TIME ZONE 'Asia/Riyadh')::date,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [x.type, x.status || "confirmed", x.phone_masked || null, x.example || null, x.wrong_reply || null, x.correct || null, x.guard || null, x.lesson_dont || null, x.lesson_do || null, x.lesson_on === true, who]);
    if (!r || !r[0]) return c.json({ ok: false, error: "db" }, 500);
    const version = await learn.rebuildLessons(null, who);
    return c.json({ ok: true, row: mistakeRow(r[0]), lessonsVersion: version });
  });
  app.put("/api/cms/wabot/mistakes/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    const id = Number(typeof c.req.param === "function" ? c.req.param("id") : NaN); if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "bad_id" }, 400);
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const v = mistakeFromBody(b);
    if (!v.ok) return c.json({ ok: false, error: "invalid", errors: v.errors }, 400);
    const keys = Object.keys(v.value); if (!keys.length) return c.json({ ok: false, error: "nothing_to_update" }, 400);
    const who = await actorOf(c);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const r = await q(`UPDATE wa_bot_mistakes SET ${sets}, updated_at = NOW(), updated_by = $${keys.length + 2} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => v.value[k]), who]);
    if (r === null) return c.json({ ok: false, error: "db" }, 500);
    if (!r.length) return c.json({ ok: false, error: "not_found" }, 404);
    const version = await learn.rebuildLessons(null, who);
    return c.json({ ok: true, row: mistakeRow(r[0]), lessonsVersion: version });
  });
  app.get("/api/cms/wabot/lessons", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const lc = cfgOf ? await cfgOf() : LEARN_DEFAULTS;
    const ln = await learn.lessonsNow({ ...lc, lessonsEnabled: true });
    const versions = (await q("SELECT version, at, who, chars FROM wa_bot_lessons ORDER BY version DESC LIMIT 30", [])) || [];
    return c.json({ ok: true, enabled: lc.lessonsEnabled !== false, max: lc.lessonsMaxChars, current: { version: ln.version, text: ln.text, chars: ln.text.length }, versions });
  });
  app.get("/api/cms/wabot/selfreview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const runs = (await q("SELECT day::text AS day, started_at, finished_at, found, filed, detail FROM wa_selfreview_runs ORDER BY day DESC LIMIT 30", [])) || [];
    const lc = cfgOf ? await cfgOf() : LEARN_DEFAULTS;
    return c.json({ ok: true, enabled: lc.selfReview !== false, at: `${String(lc.selfReviewHour).padStart(2, "0")}:${String(lc.selfReviewMinute).padStart(2, "0")}`, runs, counts: await learn.dailyCounts(14) });
  });
  /* تشغيل يدوي (المالك): يوم معيّن أو امبارح. قراية بس من المحادثات؛ بيكتب صفوف «مشتبه» بس. */
  app.post("/api/cms/wabot/selfreview/run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || "")) ? String(b.day) : riyadhDay(new Date(Date.now() - 28 * 3600_000));
    const lc = cfgOf ? await cfgOf() : LEARN_DEFAULTS;
    const res = await learn.runSelfReview(day, { max: lc.selfReviewMax, orderAwareHours: lc.orderAwareHours, claimMin: lc.claimSilentMin });
    return c.json({ ok: true, day, ...res });
  });
}
