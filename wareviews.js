/* ═══════════════════════════════════════════════════════════════════════════
   WAREVIEWS — التقييم بالنجوم جوّه واتساب لكل أنواع الطلبات (RV1، عمر ١٥/١٠/٢٠٢٦)

   عمر: «ناخد التقييم من الواتساب بالنجوم، ولو أكثر من ٣ نبعتله رابط جوجل على الواتس بدل ما يدخل صفحة التقييم
   وبعدها يرجع يدخل جوجل. كمان عايزين نبعت التقييم لكل العملاء اللي بتاكل في الصالة أو تيك أواي أو كيتا أو التطبيق.»

   الموديول ده = القواعد الصافية + النصوص + المخطط + استعلامات صغيرة. التشغيل نفسه:
     • reviews.js   — مين يتسأل وامتى (دعوة لكل طلب: موقع + كاشير)، الحدود، ساعات الهدوء، الـSMS، ورابط جوجل المتتبَّع.
     • wabotrun.js  — الإرسال على واتساب (reviewAsk) والرد على النجوم/الأسباب (work + buildReply).

   القواعد (كلها من اللوحة، waBot.reviewFlow):
     ١. السؤال: جوّه نافذة الـ٢٤ ساعة ⇒ قايمة نجوم (⭐ … ⭐⭐⭐⭐⭐) ببلاش. بره النافذة ⇒ قالب خدمي.
        ميتا بتسمح لحد ١٠ ردود سريعة في القالب، بس أكتر من ٣ ⇒ الموبايل بيعرض أول اتنين و«عرض كل الخيارات»، وواتساب
        الكمبيوتر مابيفتحوش خالص. خمس نجوم في القالب = ⭐⭐⭐⭐⭐ و⭐⭐⭐⭐ ظاهرين والنجوم الواطية مستخبية ⇒ مش أمين.
        البديل: ٣ أزرار ظاهرين كلهم «ممتاز ⭐⭐⭐⭐⭐ / جيد جداً ⭐⭐⭐⭐ / يحتاج تحسين» = ٥ / ٤ / (٣ أو أقل، exact=false).
     ٢. التوجيه: ٤–٥ ⇒ شكر + زر جوجل في نفس الرسالة (عدّاد الضغطات بتاعنا لو trackGoogle). ٣ أو أقل ⇒ اعتذار + «وش اللي
        ما عجبك؟» (قايمة أسباب أو نص) + تحويل عاجل للمدير برقم الطلب. **عمر ما بنطلب من صاحب تقييم واطي يروح جوجل** —
        حتى لو عتبة صفحة التقييم اتغيّرت لـ٣ (هنا الحد الأدنى ٤ دايماً).
     ٣. كل تقييم صف في reviews (channel='whatsapp' + رقم الطلب + الجوال + النوع) ⇒ الوارد والإحصائيات وقمع جوجل صح.
   ممنوع: أي هدية/خصم مقابل التقييم (سياسة جوجل)، وأسماء التطبيقات في رسايل جوجل.
═══════════════════════════════════════════════════════════════════════════ */
import { LIMITS } from "./wabot.js";
import { validPlaceId, writeReviewUrl } from "./places.js";
import { reviewDueAt } from "./prepstatus.js";
import { STAR_BUTTONS } from "./watemplates.js";

export const REVIEW_KINDS = Object.freeze(["delivery", "pickup", "table", "dinein", "takeaway", "app"]);
export const KIND_AR = Object.freeze({ delivery: "توصيل", pickup: "استلام من الفرع", table: "طاولة (QR)", dinein: "أكل في الصالة", takeaway: "سفري من الكاشير", app: "تطبيق توصيل" });
/* السطر تحت «كيف كانت تجربتك؟» في صفحة التقييم (للعميل) — KIND_AR للفريق (الوارد وكارت البوابة) */
export const PAGE_LABEL = Object.freeze({ delivery: "توصيل", pickup: "استلام من الفرع", table: "طلب الطاولة", dinein: "زيارتك للمطعم", takeaway: "طلبك من الفرع", app: "طلبك" });
export const WEB_KINDS = new Set(["delivery", "pickup", "table"]);      // طلبات متجرنا (shop_orders)
export const VISIT_KINDS = new Set(["dinein", "takeaway", "app"]);      // نقطة البيع (ts_orders) — مالهاش رسايل طلب على واتساب
/* محافظ تطبيقات التوصيل في نقطة البيع (نفس قايمة chat.js / الإعدادات deliveryAppMethods) */
export const APP_METHODS = Object.freeze(["ninja", "feedus", "keeta", "hungerstation", "jahez", "toyou", "mrsool", "careem"]);
/* رابط جوجل المتتبَّع: GET /api/reviews/g/<كود الدعوة> بيعدّ الضغطة ويحوّل لرابط جوجل من الإعدادات (مش من الطلب ⇒ مفيش open redirect) */
export const REVIEW_GO_BASE = `${String(process.env.PUBLIC_API_BASE || "https://freshcuts-api.o2m8.me").replace(/\/+$/, "")}/api/reviews/g/`;
const CODE_RE = /^[a-z0-9]{4,16}$/;

/* ═══ الإعدادات (waBot.reviewFlow) ═══════════════════════════════════════ */
export const REVIEW_FLOW_DEFAULTS = Object.freeze({
  enabled: true,          // النجوم جوّه واتساب (مقفول = زي الأول: رابط صفحة التقييم)
  starsTemplate: false,   // قالب النجوم fc_review_stars بره النافذة — بعد اعتماد ميتا بس
  trackGoogle: true,      // زر جوجل بيعدّي على عدّادنا
  delivery: true, pickup: true, table: true, dinein: true, takeaway: true,
  apps: false,            // ⚠️ قواعد منصة كيتا ٥.١ — مقفول بتوصية
  smsVisits: false,       // SMS لعملاء الكاشير لو واتساب مش متاح (قرار المالك)
  deliveryMin: 30, pickupMin: 45, tableMin: 75, dineinMin: 90, takeawayMin: 50, appsMin: 100,
  quietFromHour: 23, quietFromMinute: 30, quietToHour: 11, quietToMinute: 30, resumeHour: 13, resumeMinute: 0,
  capDays: 7,             // طلب تقييم واحد للعميل في المدة دي مهما طلب
  lowCommentMin: 120,     // بعد التقييم الواطي: أول نص يكتبه العميل في المدة دي = تعليقه في الوارد
  posLookbackHours: 12,   // طلبات الكاشير: بنبص على آخر الساعات دي (الجوال بيتربط بالطلب بعد ~٣٠ دقيقة)
});
const NUM = Object.freeze({
  deliveryMin: [1, 720], pickupMin: [1, 720], tableMin: [15, 720], dineinMin: [15, 720], takeawayMin: [10, 720], appsMin: [30, 720],
  quietFromHour: [0, 23], quietFromMinute: [0, 59], quietToHour: [0, 23], quietToMinute: [0, 59], resumeHour: [0, 23], resumeMinute: [0, 59],
  capDays: [0, 60], lowCommentMin: [5, 1440], posLookbackHours: [1, 20],
});
const BOOL_ON = ["enabled", "trackGoogle", "delivery", "pickup", "table", "dinein", "takeaway"];      // الافتراضي مفتوح
const BOOL_OFF = ["starsTemplate", "apps", "smsVisits"];                                              // الافتراضي مقفول
const num = (v, [lo, hi], d) => { const n = Number(v); return v !== "" && v !== null && v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d; };

export function reviewFlowConfig(x) {
  const src = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  for (const k of BOOL_ON) out[k] = src[k] !== false;
  for (const k of BOOL_OFF) out[k] = src[k] === true;
  for (const [k, r] of Object.entries(NUM)) out[k] = num(src[k], r, REVIEW_FLOW_DEFAULTS[k]);
  return out;
}
/* من جسم اللوحة: الأرقام بره الحدود بيمسكها rangeErrors بتاع البوت (من المخطط)؛ هنا نوع المفاتيح + الدمج مع القديم. */
export function reviewFlowFromBody(src, prev) {
  const errors = [];
  if (!src || typeof src !== "object" || Array.isArray(src)) return { ok: false, errors: ["reviewFlow: كائن"] };
  const out = { ...((prev && typeof prev === "object") ? prev : {}) };
  for (const [k, v] of Object.entries(src)) {
    if ([...BOOL_ON, ...BOOL_OFF].includes(k)) { if (typeof v === "boolean") out[k] = v; else errors.push(`reviewFlow.${k}: مفتوح/مقفول`); }
    else if (NUM[k]) { const n = Number(v); if (v === "" || v === null || !Number.isFinite(n) || n < NUM[k][0] || n > NUM[k][1]) errors.push(`reviewFlow.${k}`); else out[k] = Math.round(n); }
    else errors.push(`reviewFlow.${k}: إعداد مش معروف`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

const B = (ar, help) => Object.freeze({ group: "reviews", type: "boolean", ar, help });
const N = (k, ar, help, unit) => Object.freeze({ group: "reviews", type: "number", ar, help, min: NUM[k][0], max: NUM[k][1], ...(unit ? { unit } : {}) });
export const REVIEW_FLOW_SCHEMA = Object.freeze({
  "reviewFlow.enabled": B("التقييم بالنجوم جوّه واتساب", "مفتوح: سؤال التقييم جوّه النافذة قايمة نجوم، و«تمام» على رسالة التوصيل بتفتح نفس القايمة. ٤–٥ نجوم ⇒ شكر + زر جوجل في نفس الرسالة. ٣ أو أقل ⇒ اعتذار وسؤال «وش اللي ما عجبك» وتحويل عاجل للمدير برقم الطلب، ومن غير أي رابط جوجل. كل تقييم بيتسجّل في «التقييمات ← الوارد». المواعيد وساعات الهدوء اللي تحت بتغني عن اللي في صفحة التقييمات. مقفول = زي الأول (رابط صفحة التقييم)."),
  "reviewFlow.starsTemplate": B("قالب النجوم بره النافذة (fc_review_stars)", "افتحه بعد ما ميتا تعتمد القالب: ٣ أزرار «ممتاز / جيد جداً / يحتاج تحسين» بدل رابط الصفحة. مقفول = القالب المعتمد الحالي لطلبات الموقع (تمام / عندي ملاحظة + رابط)، ومفيش قالب لعملاء الكاشير."),
  "reviewFlow.trackGoogle": B("عدّ ضغطات زر جوجل", "مفتوح: الزر بيعدّي على عدّادنا وبعدين جوجل، فالتقرير اليومي بيقول مين ضغط. مقفول: رابط جوجل مباشر ومن غير عدّ."),
  "reviewFlow.delivery": B("نسأل: توصيل من الموقع", "بعد «وصل». النافذة مقفولة ⇒ زرّين رسالة التوصيل هما السؤال (سياسة القوالب)."),
  "reviewFlow.pickup": B("نسأل: استلام من الفرع (الموقع)", "بعد ما الكاشير يسجّل إن العميل استلم."),
  "reviewFlow.table": B("نسأل: طاولات QR", "بعد الطلب بالمدة اللي تحت (أو بعد «الطاولة فضيت»)."),
  "reviewFlow.dinein": B("نسأل: الأكل في الصالة (الكاشير، بجوال)", "طلب نقطة البيع اللي عليه جوال عميل. واتساب بس لو العميل وافق على رسايل واتساب أو كلّمنا آخر ٢٤ ساعة، وإلا SMS لو مفتوح تحت."),
  "reviewFlow.takeaway": B("نسأل: سفري من الكاشير (بجوال)", "نفس شروط الصالة."),
  "reviewFlow.apps": B("نسأل: تطبيقات التوصيل (كيتا)", "⚠️ مخالف لقواعد منصة كيتا (البند ٥.١: بيانات العميل لتوصيل الطلب بس) — مقفول بتوصية. هنقرستيشن ونينجا مابيدّوش جوال العميل أصلاً."),
  "reviewFlow.smsVisits": B("SMS لعملاء الكاشير لو واتساب مش متاح", "معظم عملاء الصالة والسفري ماوافقوش على رسايل واتساب، فالقالب بيترفض. مفتوح = SMS بنص «رسالة ما بعد التوصيل» ورابط صفحة التقييم. مقفول = مفيش رسالة ليهم إلا لو كلّمونا على واتساب آخر ٢٤ ساعة."),
  "reviewFlow.deliveryMin": N("deliveryMin", "التوصيل: نسأل بعد «وصل» بـ", "", "دقيقة"),
  "reviewFlow.pickupMin": N("pickupMin", "الاستلام: نسأل بعد «استلم» بـ", "ومش قبل ساعة من الطلب.", "دقيقة"),
  "reviewFlow.tableMin": N("tableMin", "طاولات QR: نسأل بعد الطلب بـ", "", "دقيقة"),
  "reviewFlow.dineinMin": N("dineinMin", "الصالة: نسأل بعد الطلب بـ", "وقت الأكل + دفع الفاتورة.", "دقيقة"),
  "reviewFlow.takeawayMin": N("takeawayMin", "السفري: نسأل بعد الطلب بـ", "", "دقيقة"),
  "reviewFlow.appsMin": N("appsMin", "التطبيقات: نسأل بعد الطلب بـ", "", "دقيقة"),
  "reviewFlow.quietFromHour": N("quietFromHour", "ساعات الهدوء: من الساعة", "توقيت الرياض. مفيش طلب تقييم بيطلع وقت الهدوء.", "ساعة"),
  "reviewFlow.quietFromMinute": N("quietFromMinute", "ساعات الهدوء: من الدقيقة", "", "دقيقة"),
  "reviewFlow.quietToHour": N("quietToHour", "ساعات الهدوء: لحد الساعة", "", "ساعة"),
  "reviewFlow.quietToMinute": N("quietToMinute", "ساعات الهدوء: لحد الدقيقة", "", "دقيقة"),
  "reviewFlow.resumeHour": N("resumeHour", "اللي وقع في الهدوء يطلع الساعة", "الطلب اللي ميعاده جه بالليل بيتأجّل لليوم اللي بعده الساعة دي (مش بيتلغي، إلا لو عدّى «أقصى عمر للدعوة»).", "ساعة"),
  "reviewFlow.resumeMinute": N("resumeMinute", "…والدقيقة", "", "دقيقة"),
  "reviewFlow.capDays": N("capDays", "طلب تقييم واحد للعميل كل", "مهما طلب ومن أي قناة. صفر = من غير حد (مش منصوح).", "يوم"),
  "reviewFlow.lowCommentMin": N("lowCommentMin", "بعد التقييم الواطي: كلام العميل بيتسجّل تعليق لحد", "أول رسالة نصية بس بتروح الوارد؛ الباقي في المحادثة.", "دقيقة"),
  "reviewFlow.posLookbackHours": N("posLookbackHours", "طلبات الكاشير: نبص على آخر", "جوال العميل بيتربط بطلب الكاشير بعد شوية، فبنرجع نبص على الطلبات الأقدم لحد المدة دي.", "ساعة"),
});
export const REVIEW_SCHEMA_GROUP = Object.freeze({ reviews: "التقييمات على واتساب (النجوم وجوجل)" });

/* ═══ النصوص (بتنضاف لنصوص البوت — بتتعدّل من «نصوص البوت») — لهجة بيضاء، من غير أرقام ═══ */
const t = (label, ar, en, vars = [], opt = [], max = 900) => ({ label, ar, en, vars, opt, max });
export const REVIEW_TEXTS = Object.freeze({
  rs_ask_order: t("طلب التقييم بالنجوم: طلب من الموقع (برقم الطلب)", "كيف كان طلبك رقم {order_no}؟ 🌟\nقيّمه بالنجوم من القائمة 👇", "How was your order {order_no}? 🌟\nRate it with stars from the list 👇", ["order_no"], [], 300),
  rs_ask_visit: t("طلب التقييم بالنجوم: أكل في الصالة / طاولة", "شكراً لزيارتك فريش كاتس 🌟\nكيف تقيّم تجربتك معنا؟ اختر من القائمة 👇", "Thank you for visiting Fresh Cuts 🌟\nHow would you rate your experience? Pick from the list 👇", [], [], 300),
  rs_ask_takeaway: t("طلب التقييم بالنجوم: سفري من الكاشير", "شكراً لطلبك من فريش كاتس 🌟\nكيف تقيّم طلبك؟ اختر من القائمة 👇", "Thank you for your Fresh Cuts order 🌟\nHow would you rate it? Pick from the list 👇", [], [], 300),
  rs_ask_ok: t("بعد «تمام» على رسالة التوصيل: سؤال النجوم", "يسعدنا ذلك 🌟\nكم نجمة تعطي طلبك؟ اختر من القائمة 👇", "Glad to hear it 🌟\nHow many stars would you give your order? Pick from the list 👇", [], [], 300),
  btn_rs_list: t("زر قايمة النجوم", "اختر تقييمك", "Choose rating", [], [], LIMITS.listButton),
  row_rs_5: t("صف: خمس نجوم", "⭐⭐⭐⭐⭐ ممتاز", "⭐⭐⭐⭐⭐ Excellent", [], [], LIMITS.rowTitle),
  row_rs_4: t("صف: أربع نجوم", "⭐⭐⭐⭐ جيد جداً", "⭐⭐⭐⭐ Very good", [], [], LIMITS.rowTitle),
  row_rs_3: t("صف: ثلاث نجوم", "⭐⭐⭐ جيد", "⭐⭐⭐ Good", [], [], LIMITS.rowTitle),
  row_rs_2: t("صف: نجمتين", "⭐⭐ مقبول", "⭐⭐ Fair", [], [], LIMITS.rowTitle),
  row_rs_1: t("صف: نجمة", "⭐ ضعيف", "⭐ Poor", [], [], LIMITS.rowTitle),
  rs_google: t("بعد تقييم عالي: شكر + زر جوجل (من غير أي هدية)", "شكراً على تقييمك 🌟 يسعدنا إن تجربتك كانت حلوة!\nإذا حاب، اكتب لنا كلمتين على جوجل بأسلوبك — رأيك يساعد غيرك يتعرّف علينا 🙏", "Thank you for your rating 🌟 We're glad you enjoyed it!\nIf you'd like, a few words on Google in your own words help others find us 🙏", [], [], 400),
  cta_google: t("زر: قيّمنا على جوجل", "قيّمنا على جوجل", "Review us on Google", [], [], LIMITS.ctaText),
  rs_thanks: t("بعد تقييم عالي ومفيش رابط جوجل في الإعدادات", "شكراً على تقييمك 🌟 يسعدنا إن تجربتك كانت حلوة، ونتشرّف بزيارتك مرة ثانية.", "Thank you for your rating 🌟 We're glad you enjoyed it, and we'd love to see you again.", [], [], 300),
  rs_low: t("بعد تقييم واطي: اعتذار + السبب + المدير (من غير جوجل)", "نعتذر منك 🙏 ما كانت تجربتك مثل ما نتمنى.\nوش اللي ما عجبك؟ اختر من القائمة أو اكتب لنا هنا، ويتواصل معك المدير في أقرب وقت.\n{order_line}", "We're sorry 🙏 your experience wasn't what we want it to be.\nWhat went wrong? Pick from the list or write to us here, and the manager will contact you as soon as possible.\n{order_line}", [], ["order_line"], 500),
  rs_order_line: t("سطر رقم الطلب تحت الاعتذار (طلبات الموقع بس)", "رقم الطلب: {order_no}", "Order: {order_no}", ["order_no"], [], 80),
  btn_rr_list: t("زر قايمة الأسباب", "اختر السبب", "Choose reason", [], [], LIMITS.listButton),
  row_rr_food: t("سبب: الأكل", "الأكل (الطعم أو الجودة)", "Food (taste or quality)", [], [], LIMITS.rowTitle),
  row_rr_wrong: t("سبب: الطلب ناقص أو غلط", "الطلب ناقص أو غلط", "Missing or wrong items", [], [], LIMITS.rowTitle),
  row_rr_time: t("سبب: التأخير", "التأخير", "Waiting time", [], [], LIMITS.rowTitle),
  row_rr_delivery: t("سبب: التوصيل والمندوب", "التوصيل والمندوب", "Delivery and courier", [], [], LIMITS.rowTitle),
  row_rr_service: t("سبب: الخدمة", "الخدمة والتعامل", "Service", [], [], LIMITS.rowTitle),
  row_rr_price: t("سبب: السعر", "السعر", "Price", [], [], LIMITS.rowTitle),
  row_rr_clean: t("سبب: النظافة", "النظافة", "Cleanliness", [], [], LIMITS.rowTitle),
  row_rr_other: t("سبب: شيء ثاني", "شيء ثاني", "Something else", [], [], LIMITS.rowTitle),
  rs_reason_ok: t("بعد اختيار السبب", "شكراً، وصلت ملاحظتك ✅ ويتواصل معك المدير في أقرب وقت.\nإذا حاب تضيف تفاصيل، اكتبها هنا.", "Thank you, your note has reached us ✅ The manager will contact you as soon as possible.\nIf you'd like to add details, write them here.", [], [], 300),
  rs_already: t("تقييم تاني لنفس الطلب", "وصلنا تقييمك، شكراً لك 🌟", "We have your rating, thank you 🌟", [], [], 200),
  rs_subj_order: t("قالب النجوم {{1}}: طلب من الموقع", "طلبك رقم {order_no}", "your order {order_no}", ["order_no"], [], 60),
  rs_subj_visit: t("قالب النجوم {{1}}: أكل في الصالة / طاولة", "زيارتك للمطعم", "your visit", [], [], 60),
  rs_subj_takeaway: t("قالب النجوم {{1}}: سفري / تطبيق", "طلبك من الفرع", "your order from the branch", [], [], 60),
});

/* ═══ الوقت: ساعات الهدوء + ميعاد كل نوع ═══════════════════════════════════ */
const minOf = (h, m) => h * 60 + m;
export function quietWindow(flow) {
  const f = flow || REVIEW_FLOW_DEFAULTS;
  return { from: minOf(f.quietFromHour, f.quietFromMinute), to: minOf(f.quietToHour, f.quietToMinute), resume: minOf(f.resumeHour, f.resumeMinute) };
}
/* الرياض UTC+3 من غير توقيت صيفي */
export const riyadhMin = (d) => { const x = new Date(d); return (x.getUTCHours() * 60 + x.getUTCMinutes() + 180) % 1440; };
const minInQuiet = (m, { from, to }) => (from === to ? false : from < to ? m >= from && m < to : m >= from || m < to);
export const inQuiet = (d, flow) => minInQuiet(riyadhMin(d), quietWindow(flow));
/* أول لحظة مسموحة: لو الوقت في الهدوء ⇒ أقرب «resume» جاية (ولو الـresume نفسها جوّه الهدوء ⇒ نهاية الهدوء). */
export function nextAllowed(d, flow) {
  const t0 = new Date(d);
  const w = quietWindow(flow);
  if (!minInQuiet(riyadhMin(t0), w)) return t0;
  const target = minInQuiet(w.resume, w) ? w.to : w.resume;
  let delta = (target - riyadhMin(t0) + 1440) % 1440;
  if (delta === 0) delta = 1440;
  const out = new Date(t0.getTime() + delta * 60_000);
  out.setUTCSeconds(0, 0);
  return out;
}
const msOf = (v) => { const x = v ? new Date(v).getTime() : NaN; return Number.isFinite(x) ? x : null; };
/* ميعاد السؤال لكل نوع (قبل ساعات الهدوء): التوصيل والاستلام بنفس قواعد prepstatus.reviewDueAt (تأكيد المندوب / ساعة من الطلب للاستلام). */
export function dueFor(kind, { orderAt = null, deliveredAt = null, createdAt = null, pickedAt = null, courierConfirmed = true } = {}, flow = REVIEW_FLOW_DEFAULTS, now = Date.now()) {
  const M = 60_000, f = flow || REVIEW_FLOW_DEFAULTS;
  const order = msOf(orderAt) ?? msOf(createdAt) ?? now, delivered = msOf(deliveredAt);
  let due;
  if (kind === "delivery") due = reviewDueAt({ deliveredAt: delivered ?? now, askAfterMin: f.deliveryMin, option: "delivery", createdAt, pickedAt, courierConfirmed }).getTime();
  else if (kind === "pickup") due = reviewDueAt({ deliveredAt: delivered ?? now, askAfterMin: f.pickupMin, option: "pickup", createdAt: createdAt || orderAt }).getTime();
  else if (kind === "table") due = Math.max(order + f.tableMin * M, (delivered ?? order) + 15 * M);
  else if (kind === "dinein") due = order + f.dineinMin * M;
  else if (kind === "takeaway") due = order + f.takeawayMin * M;
  else if (kind === "app") due = order + f.appsMin * M;
  else due = (delivered ?? now) + f.deliveryMin * M;
  return nextAllowed(new Date(due), f);
}
/* النوع من صف دعوة قديم (قبل RV1: option بس) */
export const kindOfInvite = (iv) => (iv && REVIEW_KINDS.includes(iv.kind) ? iv.kind : iv && iv.option === "pickup" ? "pickup" : iv && REVIEW_KINDS.includes(iv.option) ? iv.option : "delivery");
/* طلب نقطة البيع ⇒ نوعه (أو null = مش بنسأل عليه). row = { is_app, order_option } */
export function posKindOf(row) {
  if (!row) return null;
  if (row.is_app) return "app";
  const o = String(row.order_option || "").toLowerCase();
  if (/dine|صالة|محلي/.test(o)) return "dinein";
  if (/take|سفري/.test(o)) return "takeaway";
  return null;      // توصيل يدوي من الكاشير وغيره: مش بنسأل (مالوش وقت وصول نعرفه)
}
export const kindOn = (kind, flow) => {
  const f = flow || REVIEW_FLOW_DEFAULTS;
  return kind === "app" ? f.apps === true : Boolean(f[kind]);
};

/* ═══ النجوم والأسباب ═════════════════════════════════════════════════════ */
const clean = (s) => String(s ?? "").replace(/️/g, "").replace(/\s+/g, " ").trim();
/* صف القايمة: rs:<نجوم>:<كود الدعوة> */
export function starOfListId(id) {
  const m = /^rs:([1-5]):([a-z0-9]{4,16})$/i.exec(String(id || ""));
  return m ? { stars: Number(m[1]), code: m[2].toLowerCase(), exact: true } : null;
}
/* زر القالب (الـpayload = نص الزر) */
const QR_MAP = new Map(STAR_BUTTONS.map((b) => [clean(b.text), { stars: b.stars, exact: b.exact }]));
export function starOfQr(text) { return QR_MAP.get(clean(text)) || null; }
/* «٥» / «5 نجوم» / «⭐⭐⭐⭐» مكتوبة — بتتحسب بس لو فيه سؤال نجوم مستني رد (wabotrun) */
export function typedStar(text) {
  const s = clean(text).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));
  let m = /^([1-5])\s*(?:\/\s*5|من\s*5|نجوم|نجمات|نجمه|نجمة|stars?)?\s*[.!]?$/i.exec(s);
  if (m) return Number(m[1]);
  m = /^(⭐{1,5})(?:\s+[\p{L}\s]{1,20})?$/u.exec(s);
  return m ? [...m[1]].length : null;
}
export const REASONS = Object.freeze([
  { id: "food", cat: "الأكل", row: "row_rr_food" },
  { id: "wrong", cat: "الطلب ناقص أو غلط", row: "row_rr_wrong" },
  { id: "time", cat: "الوقت", row: "row_rr_time" },
  { id: "delivery", cat: "التوصيل", row: "row_rr_delivery", kinds: ["delivery", "app"] },
  { id: "service", cat: "الخدمة", row: "row_rr_service" },
  { id: "price", cat: "السعر", row: "row_rr_price" },
  { id: "clean", cat: "النظافة", row: "row_rr_clean", kinds: ["dinein", "table"] },
  { id: "other", cat: "غير ذلك", row: "row_rr_other" },
]);
export const reasonsFor = (kind) => REASONS.filter((r) => !r.kinds || r.kinds.includes(kind || "delivery"));
export function reasonOfListId(id) {
  const m = /^rr:([a-z]{3,10}):(\d{1,12})$/.exec(String(id || ""));
  const r = m ? REASONS.find((x) => x.id === m[1]) : null;
  return r ? { reason: r.id, cat: r.cat, reviewId: Number(m[2]) } : null;
}
/* التوجيه — جوجل للعالي بس. «يحتاج تحسين» (exact=false) أو ٣ وأقل ⇒ داخلي دايماً، مهما كانت عتبة صفحة التقييم. */
export function routeOf({ stars, exact = true, threshold = 4, googleUrl = "" } = {}) {
  const t = Math.max(4, Math.round(Number(threshold)) || 4);
  if (!exact || !(Number(stars) >= t)) return "low";
  return googleUrl ? "google" : "thanks";
}
/* إعدادات صفحة التقييم اللي التوجيه محتاجها (نفس reviews.js cfg): العتبة + رابط جوجل (أو من معرّف المكان) */
export function reviewsCfgOf(settings) {
  const r = ((settings || {}).reviews) || {};
  let googleUrl = /^https:\/\//i.test(String(r.googleUrl || "")) ? String(r.googleUrl) : "";
  if (!googleUrl && validPlaceId(r.placeId)) googleUrl = writeReviewUrl(r.placeId);
  return { threshold: Number(r.threshold) || 4, googleUrl };
}
export const googleLinkOf = (code, flow, googleUrl) => ((flow || REVIEW_FLOW_DEFAULTS).trackGoogle && CODE_RE.test(String(code || "")) ? `${REVIEW_GO_BASE}${code}` : String(googleUrl || ""));
/* زر الرابط في رسالة البوت (payloadProblem): رابط العدّاد بتاعنا أو رابط «اكتب تقييم» بتاع جوجل بالشكل المضبوط */
export function reviewCtaOk(url) {
  const u = String(url || "");
  if (u.startsWith(REVIEW_GO_BASE)) return CODE_RE.test(u.slice(REVIEW_GO_BASE.length));
  return /^https:\/\/search\.google\.com\/local\/writereview\?placeid=[A-Za-z0-9_-]{10,255}$/.test(u) || /^https:\/\/g\.page\/r\/[A-Za-z0-9_-]{4,64}\/review$/.test(u);
}
/* الرقم اللي العميل يعرفه: رقم طلب الموقع، أو «فاتورة #…» لطلب الكاشير */
export function refOf(iv) {
  if (!iv) return null;
  if (iv.ref) return String(iv.ref);
  return /^W\d{6,20}$/.test(String(iv.order_no || "")) ? String(iv.order_no) : null;
}

/* ═══ الردود (صافية: T = نص، F = نص بمتغيّرات) ═══════════════════════════ */
export function starsAskReply({ T, F, kind = null, orderNo = null, code, lead = null }) {
  if (!CODE_RE.test(String(code || ""))) throw new Error("review_code");
  const k = kind || "delivery";
  const body = lead === "ok" ? T("rs_ask_ok")
    : WEB_KINDS.has(k) && /^W\d{6,20}$/.test(String(orderNo || "")) ? F("rs_ask_order", { order_no: orderNo })
      : k === "dinein" || k === "table" ? T("rs_ask_visit") : T("rs_ask_takeaway");
  return { body, list: { button: T("btn_rs_list"), rows: [5, 4, 3, 2, 1].map((n) => ({ id: `rs:${n}:${code}`, title: T(`row_rs_${n}`) })) } };
}
/* موضوع قالب النجوم {{1}} */
export function starsSubject({ T, F, kind = null, orderNo = null }) {
  const k = kind || "delivery";
  if (WEB_KINDS.has(k) && /^W\d{6,20}$/.test(String(orderNo || ""))) return F("rs_subj_order", { order_no: orderNo });
  return k === "dinein" || k === "table" ? T("rs_subj_visit") : T("rs_subj_takeaway");
}
/* رد ضغطة نجوم (arg من applyStar). callLine = سطر رقم المطعم (زي أي تحويل). */
export function starReply({ T, F, arg = {}, callLine = "" }) {
  const a = arg || {};
  if (a.route === "already") return { body: T("rs_already") };
  if (a.route === "google" && a.link) return { body: T("rs_google"), cta: { title: T("cta_google"), url: a.link } };
  if (a.route === "google" || a.route === "thanks") return { body: T("rs_thanks") };
  const webNo = /^W\d{6,20}$/.test(String(a.ref || "")) ? String(a.ref) : "";      // رقم طلب الموقع بس؛ فاتورة الكاشير في كارت البوابة (العميل مايعرفهاش)
  const body = `${F("rs_low", { order_line: webNo ? F("rs_order_line", { order_no: webNo }) : "" })}${callLine || ""}`;
  const note = `تقييم ${a.exact === false ? "«يحتاج تحسين»" : `${a.stars}★`}${a.ref ? ` · طلب ${a.ref}` : ""}${a.kind ? ` · ${KIND_AR[a.kind] || a.kind}` : ""}`;
  /* orderNo بيروح لـSMS الفريق (إنجليزي سطر واحد) ⇒ رقم طلب الموقع بس؛ «فاتورة …» بالعربي في ملاحظة كارت البوابة */
  const base = { body, handoff: ["review_low", "urgent"], note, orderNo: /^W\d{6,20}$/.test(String(a.ref || "")) ? a.ref : null };
  if (!(Number(a.reviewId) > 0)) return base;
  return { ...base, list: { button: T("btn_rr_list"), rows: reasonsFor(a.kind).map((r) => ({ id: `rr:${r.id}:${a.reviewId}`, title: T(r.row) })) } };
}

/* ═══ قاعدة البيانات (q = استعلام بيرجّع الصفوف أو null لو فشل — زي wabotrun) ═══ */
const INV_COLS = "order_no, code, phone_norm, option, kind, rating, review_id, ref";
/* الدعوة اللي الضغطة بترد عليها — **لنفس الجوال بس** (كود دعوة عميل تاني مابيتقبلش). */
export async function resolveInvite(q, { phone, code = null, contextId = null } = {}) {
  const pn = String(phone || "");
  if (!/^5\d{8}$/.test(pn)) return null;
  const one = (rows) => (rows && rows[0] && rows[0].phone_norm === pn ? rows[0] : null);
  if (CODE_RE.test(String(code || ""))) { const r = one(await q(`SELECT ${INV_COLS} FROM review_invites WHERE code=$1`, [String(code)])); if (r) return r; }
  if (contextId) { const r = one(await q(`SELECT ${INV_COLS} FROM review_invites WHERE wa_msg_id=$1 AND phone_norm=$2 LIMIT 1`, [String(contextId).slice(0, 200), pn])); if (r) return r; }
  const c = await q("SELECT review_code FROM wa_bot_chats WHERE phone_norm=$1 AND review_asked_at > NOW() - INTERVAL '48 hours'", [pn]);
  if (c && c[0] && CODE_RE.test(String(c[0].review_code || ""))) { const r = one(await q(`SELECT ${INV_COLS} FROM review_invites WHERE code=$1`, [c[0].review_code])); if (r) return r; }
  return one(await q(`SELECT ${INV_COLS} FROM review_invites WHERE phone_norm=$1 AND created_at > NOW() - INTERVAL '48 hours' AND order_no NOT LIKE 'TEST-%'
                       ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`, [pn]));
}
/* سؤال نجوم مستني رد؟ (للنجوم المكتوبة) ⇒ { code } أو null */
export async function pendingStars(q, phone, now = new Date(), hours = 24) {
  const r = await q("SELECT review_code, review_stars_at, review_answered_at FROM wa_bot_chats WHERE phone_norm=$1", [String(phone || "")]);
  const c = r && r[0];
  if (!c || !c.review_stars_at || !CODE_RE.test(String(c.review_code || ""))) return null;
  const at = Date.parse(c.review_stars_at);
  if (!Number.isFinite(at) || new Date(now).getTime() - at > hours * 3600_000) return null;
  if (c.review_answered_at && Date.parse(c.review_answered_at) > at) return null;      // «تمام» قبل القايمة بلحظة (نفس المللي ثانية) ⇒ لسه مستني النجوم
  /* «٢» بعد ما المحادثة كمّلت في حاجة تانية (المساعد سأل «كام شخص؟») مش تقييم: لازم سؤال النجوم يكون آخر حاجة طلعت للعميل
     (سماح ١٥ ثانية: رسالة القايمة نفسها بتتسجّل بعد علامة السؤال بلحظة لما «تمام» بتفتحها) */
  const later = await q("SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND direction='out' AND created_at > $2::timestamptz + INTERVAL '15 seconds' LIMIT 1", [String(phone), new Date(at).toISOString()]);
  if (later === null || later.length) return null;
  return { code: c.review_code };
}
/* ضغطة نجوم ⇒ صف تقييم + الدعوة بتتقفل + التوجيه. بيرجّع cls جديد (arg = { route, stars, exact, code, order, ref, kind, reviewId, link }). */
export async function applyStar(q, { phone, cls, flow = REVIEW_FLOW_DEFAULTS, rcfg = { threshold: 4, googleUrl: "" }, contextId = null } = {}) {
  const a = (cls && cls.arg) || {};
  const stars = Math.min(5, Math.max(1, Math.round(Number(a.stars)) || 0));
  if (!stars) return cls;
  const exact = a.exact !== false;
  const iv = await resolveInvite(q, { phone, code: a.code, contextId });
  const kind = iv ? kindOfInvite(iv) : null;
  const done = (route, extra = {}) => ({ ...cls, key: "review_star", arg: { route, stars, exact, code: iv ? iv.code : null, order: iv ? iv.order_no : null, ref: refOf(iv), kind, ...extra } });
  if (iv) {
    if (iv.rating != null) return done("already");
    const claim = await q(`UPDATE review_invites SET rating=$2, wa_answer=$3, wa_answered_at=NOW(), sent_at=COALESCE(sent_at, NOW()), channel=COALESCE(channel, 'wa_tap')
                            WHERE code=$1 AND rating IS NULL RETURNING order_no`, [iv.code, stars, `stars:${stars}${exact ? "" : ":band"}`]);
    if (claim && !claim.length) return done("already");      // ضغطتين في نفس اللحظة: الأولى بس
  } else {
    const dup = await q("SELECT id FROM reviews WHERE phone_norm=$1 AND channel='whatsapp' AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1", [phone]);
    if (dup && dup.length) return done("already");
  }
  const label = `${kind ? `واتساب · ${KIND_AR[kind]}` : "واتساب"}${exact ? "" : " · «يحتاج تحسين»"}`;      // الوارد بيعرض النجوم: «يحتاج تحسين» = ٣ أو أقل من غير رقم
  const ins = await q(`INSERT INTO reviews(rating, code, code_label, channel, order_no, phone_norm, is_test, rating_exact, kind)
                       VALUES ($1,$2,$3,'whatsapp',$4,$5,$6,$7,$8) RETURNING id`,
    [stars, iv ? iv.code : null, label, iv ? iv.order_no : null, phone, Boolean(iv && /^TEST-/.test(String(iv.order_no))), exact, kind]);
  const reviewId = ins && ins[0] ? Number(ins[0].id) : null;
  if (iv && reviewId) await q("UPDATE review_invites SET review_id=$2 WHERE code=$1", [iv.code, reviewId]);
  await q("UPDATE wa_bot_chats SET review_answered_at=NOW() WHERE phone_norm=$1", [phone]);
  const route = routeOf({ stars, exact, threshold: rcfg.threshold, googleUrl: rcfg.googleUrl });
  if (route === "low" && reviewId) {
    await q(`INSERT INTO wa_bot_chats(phone_norm, review_low_id, review_low_at) VALUES ($1,$2,NOW())
             ON CONFLICT (phone_norm) DO UPDATE SET review_low_id=$2, review_low_at=NOW(), updated_at=NOW()`, [phone, reviewId]);
  }
  return done(route, { reviewId, link: route === "google" ? googleLinkOf(iv ? iv.code : null, flow, rcfg.googleUrl) : null });
}
/* زر رابط جوجل اتبعت فعلاً (بعد الإرسال) */
export async function markGoogleSent(q, code) {
  if (CODE_RE.test(String(code || ""))) await q("UPDATE review_invites SET google_sent_at=COALESCE(google_sent_at, NOW()) WHERE code=$1", [code]);
}
/* صف سبب ⇒ بيتضاف لتصنيفات التقييم (لنفس الجوال، آخر ٧ أيام) */
export async function applyReason(q, { phone, cls } = {}) {
  const a = (cls && cls.arg) || {};
  const r = Number(a.reviewId) > 0 && a.cat ? await q(`UPDATE reviews SET categories = CASE WHEN $3 = ANY(categories) THEN categories ELSE array_append(categories, $3) END
                                                        WHERE id=$1 AND phone_norm=$2 AND created_at > NOW() - INTERVAL '7 days' RETURNING id`, [a.reviewId, phone, a.cat]) : null;
  return { ...cls, key: "review_reason", arg: { ...a, saved: Boolean(r && r.length) } };
}
/* أول نص بعد التقييم الواطي (خلال lowCommentMin) = تعليقه في الوارد */
export async function captureLowComment(q, { phone, text, flow = REVIEW_FLOW_DEFAULTS, now = new Date() } = {}) {
  const r = await q("SELECT review_low_id, review_low_at FROM wa_bot_chats WHERE phone_norm=$1", [phone]);
  const c = r && r[0];
  if (!c || !(Number(c.review_low_id) > 0) || !c.review_low_at) return false;
  if (new Date(now).getTime() - Date.parse(c.review_low_at) > (flow.lowCommentMin || REVIEW_FLOW_DEFAULTS.lowCommentMin) * 60_000) return false;
  const txt = String(text || "").trim().slice(0, 1000);
  if ([...txt].length < 2) return false;
  const u = await q("UPDATE reviews SET comment=$3 WHERE id=$1 AND phone_norm=$2 AND comment IS NULL RETURNING id", [Number(c.review_low_id), phone, txt]);
  return Boolean(u && u.length);
}

/* يوم العمل (١١ ص ← ٣ الفجر، القطع ٤ الفجر بتوقيت الرياض) — نفس wamajed.businessDay من غير ما نسحب موديولات المساعد */
export function bizDayWindow(day, now = new Date()) {
  const R = 3 * 3600_000, CUT = 4 * 3600_000;
  let d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? String(day) : null;
  if (!d) d = new Date(new Date(now).getTime() + R - CUT).toISOString().slice(0, 10);
  const from = Date.parse(`${d}T00:00:00Z`) - R + CUT;
  return { day: d, from: new Date(from).toISOString(), to: new Date(from + 86400_000).toISOString() };
}

/* ═══ التقرير اليومي (من/لحد = حدود يوم العمل) ═══════════════════════════ */
export async function reviewsDaily(q, { from, to, place = null } = {}) {
  const P = [from, to];
  const [inv, skip, rv, g, low, open] = await Promise.all([
    q(`SELECT COALESCE(channel,'-') AS channel, COALESCE(kind, option, '-') AS kind, count(*)::int AS n FROM review_invites
        WHERE sent_at >= $1 AND sent_at < $2 AND order_no NOT LIKE 'TEST-%' GROUP BY 1,2`, P),
    q(`SELECT skip_reason AS reason, count(*)::int AS n FROM review_invites
        WHERE created_at >= $1 AND created_at < $2 AND skip_reason IS NOT NULL AND order_no NOT LIKE 'TEST-%' GROUP BY 1 ORDER BY 2 DESC`, P),
    q(`SELECT COALESCE(channel,'-') AS channel, rating, COALESCE(rating_exact, TRUE) AS exact, count(*)::int AS n, count(*) FILTER (WHERE went_google)::int AS google
         FROM reviews WHERE created_at >= $1 AND created_at < $2 AND NOT COALESCE(is_test,false) AND hidden_at IS NULL GROUP BY 1,2,3`, P),
    q(`SELECT count(*) FILTER (WHERE google_sent_at >= $1 AND google_sent_at < $2)::int AS sent, count(*) FILTER (WHERE google_clicked_at >= $1 AND google_clicked_at < $2)::int AS clicked
         FROM review_invites WHERE order_no NOT LIKE 'TEST-%' AND (google_sent_at >= $1 OR google_clicked_at >= $1)`, P),
    q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE r.resolved)::int AS resolved,
              count(*) FILTER (WHERE r.resolved OR EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm = r.phone_norm AND m.source='echo' AND COALESCE(m.echo_kind,'staff') <> 'auto'
                                                         AND m.created_at > r.created_at AND m.created_at < r.created_at + INTERVAL '24 hours'))::int AS handled
         FROM reviews r WHERE r.created_at >= $1 AND r.created_at < $2 AND r.rating < 4 AND NOT COALESCE(r.is_test,false) AND r.hidden_at IS NULL`, P),
    q(`SELECT count(*)::int AS n FROM reviews WHERE rating < 4 AND NOT resolved AND NOT COALESCE(is_test,false) AND hidden_at IS NULL AND created_at > NOW() - INTERVAL '30 days'`, []),
  ]);
  if (inv === null || rv === null) return { ok: false, error: "unavailable" };
  const byChannel = {}, byKind = {};
  let total = 0;
  for (const r of inv) { total += r.n; byChannel[r.channel] = (byChannel[r.channel] || 0) + r.n; byKind[r.kind] = (byKind[r.kind] || 0) + r.n; }
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let n = 0, sum = 0, exactN = 0, band = 0, wa = 0, page = 0, pageGoogle = 0;
  for (const r of rv) {
    n += r.n; if (r.channel === "whatsapp") wa += r.n; else { page += r.n; pageGoogle += r.google; }
    if (r.exact) { dist[r.rating] = (dist[r.rating] || 0) + r.n; sum += r.rating * r.n; exactN += r.n; } else band += r.n;
  }
  const l = (low && low[0]) || {}, gg = (g && g[0]) || {};
  return {
    ok: true,
    requests: { total, byChannel, byKind },
    skipped: Object.fromEntries((skip || []).map((r) => [r.reason, r.n])),
    ratings: { total: n, avg: exactN ? Math.round((sum / exactN) * 100) / 100 : null, dist, needsImprovement: band, whatsapp: wa, page, replyRate: total ? Math.round((wa / total) * 1000) / 1000 : null },
    google: { linksSent: gg.sent || 0, clicked: gg.clicked || 0, pageClicks: pageGoogle },
    low: { total: l.n || 0, handled: l.handled || 0, resolved: l.resolved || 0, openLast30d: (open && open[0] && open[0].n) || 0 },
    place: place && place.rating ? { rating: Number(place.rating), count: Number(place.count) || null, at: place.at || null } : null,
    note: "requests = invites sent in the day by channel (wa_list = stars list in the window, wa_stars = stars template, wa_template = old link template, wa_merged = the delivered message's buttons, sms) · ratings = every rating saved that day (whatsapp + rating page); avg/dist exact stars only · low.handled = closed in the inbox or a staff reply in the chat within 24 h",
  };
}
