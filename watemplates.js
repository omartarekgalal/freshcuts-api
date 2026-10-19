import { COURIER_TEMPLATE_BASE } from "./couriercontact.js";      // SB5
/* ═══════════════════════════════════════════════════════════════════════════
   كتالوج قوالب واتساب (Cloud API) — فريش كاتس، جدة. (٢٨/٩/٢٠٢٦)

   كل قالب هنا = جسم التقديم لميتا بالظبط (POST /{WABA_ID}/message_templates:
   name · language · category · components مع أمثلة لكل متغيّر) + بياناتنا:
   الغرض، إيش يطلقه، ربط كل متغيّر بحقل عندنا، نص SMS البديل، وهل يترسل
   تلقائياً ولا يدوي.

   هذا الملف **كتالوج بس**: ما يرسل شي، ما يقدّم شي لميتا، وما يلمس قاعدة
   البيانات. الإرسال عند whatsapp.js (فرع wa-cloud)، والتقديم لميتا قرار عمر.

   قواعد ميتا اللي validateTemplate() تفحصها (واختبار watemplates.test.mjs
   يمشي على الكتالوج كله):
     • الاسم snake_case صغير [a-z0-9_] ≤512 · اللغة ar (قوالب الفريق en+ar)
     • الفئة UTILITY | MARKETING | AUTHENTICATION — ميتا تعيد تصنيف أي نص فيه
       ترويج (خصم/كود/«اطلب الحين») لـMARKETING، فالقوالب التشغيلية هنا ما فيها
       أي ترويج، واللي حدّها رمادي معلَّم reclassRisk.
     • الجسم ≤1024 حرف، ما يبدأ ولا ينتهي بمتغيّر، المتغيّرات {{1}}..{{n}}
       بالترتيب، ولا متغيّرين جنب بعض بمسافة بس، ومثال لكل متغيّر.
     • الهيدر نص ≤60 أو صورة (مثالها handle يتجاب وقت الرفع ⇒ needsUpload).
     • الفوتر ≤60 ومن غير متغيّرات.
     • الأزرار: ردود سريعة ≤3، أزرار CTA (رابط/اتصال) ≤2، نص الزر ≤25.
       زر الرابط الديناميكي: {{1}} آخر الرابط + مثال **كامل** للرابط.
     • قيمة المتغيّر وقت الإرسال ما فيها سطر جديد ولا tab ولا ٤ مسافات
       ورا بعض ⇒ bindTemplate() تنظّفها.
     • كل قالب تسويقي: فوتر «للإيقاف ردّ: إيقاف» + زر رد سريع «إيقاف».

   حقائق ثابتة متأكدين منها (ما تتغيّر مع المنيو):
     • الاسم «فريش كاتس» · الموقع freshcuts.sa · الفرع حي السلامة بجدة عند
       دوار رامي (settings.storefront.seo.faq) · خرائط جوجل cid 14767749764292326433.
     • أي رقم/سعر/كود/عرض = متغيّر يتعبّى من البيانات الحية وقت الإرسال،
       ما ينكتب في نص القالب.
     • ممنوع: «ستيك» (ما عندنا)، عدد أشخاص لـ«مشكل مخصوص»، «أرخص من
       التطبيقات» (الحارس مقفول من ١٣/٩) — الجملة الصحيحة «بأسعار المنيو الأصلية».
═══════════════════════════════════════════════════════════════════════════ */

export const STORE = "https://freshcuts.sa";
export const MAPS_URL = "https://maps.google.com/?cid=14767749764292326433";
export const PORTAL_URL = "https://freshcuts-invite.o2m8.me/portal/";
export const OPTOUT_FOOTER = "للإيقاف ردّ: إيقاف";
export const OPTOUT_BUTTON = "إيقاف";

export const CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"];
export const GROUPS = {
  order: "دورة الطلب (للعميل)",
  account: "الحساب والولاء",
  staff: "الإدارة والمتابعة (للفريق)",
  marketing: "تسويق وعروض",
  ads: "إعلانات «راسلنا على واتساب»",
  courier: "المندوب الخارجي (أزرار التوصيل)",
};

/* ── بنّاء القالب ────────────────────────────────────────────────────────────
   vars: [{ path, ex, label, fmt? }] — path = مسار الحقل في كائن البيانات اللي
   يمرّره المُرسِل (order.order_no …)، ex = المثال اللي يروح لميتا.
   buttons: url(text, base, {path, ex}) | link(text, url) | qr(text) | otp(). */
const url = (text, base, v) => ({ kind: "url", text, base, var: v || null });
const link = (text, u) => ({ kind: "url", text, base: u, var: null });
const qr = (text) => ({ kind: "qr", text });

function T(def) {
  const { name, category, language = "ar", group, header, body, vars = [], footer, buttons = [], meta = {} } = def;
  const components = [];
  if (header?.image) {
    components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: ["<UPLOAD_REQUIRED>"] } });
  } else if (header?.video) {      // OF1: إطار بفيديو (mp4 لحد ١٦ ميجا) — المثال بيترفع وقت التقديم زي الصورة
    components.push({ type: "HEADER", format: "VIDEO", example: { header_handle: ["<UPLOAD_REQUIRED>"] } });
  } else if (header?.text) {
    components.push({ type: "HEADER", format: "TEXT", text: header.text });
  }
  if (category === "AUTHENTICATION") {
    components.push({ type: "BODY", add_security_recommendation: true });
    components.push({ type: "FOOTER", code_expiration_minutes: def.expiryMinutes || 5 });
    components.push({ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: def.copyText || "نسخ الرمز" }] });
  } else {
    const b = { type: "BODY", text: body };
    if (vars.length) b.example = { body_text: [vars.map((v) => String(v.ex))] };
    components.push(b);
    if (footer) components.push({ type: "FOOTER", text: footer });
    if (buttons.length) {
      components.push({
        type: "BUTTONS",
        buttons: buttons.map((x) => {
          if (x.kind === "qr") return { type: "QUICK_REPLY", text: x.text };
          if (x.var) return { type: "URL", text: x.text, url: `${x.base}{{1}}`, example: [`${x.base}${x.var.ex}`] };
          return { type: "URL", text: x.text, url: x.base };
        }),
      });
    }
  }
  return {
    name, language, category, components,
    meta: {
      group,
      vars: vars.map((v, i) => ({ n: i + 1, path: v.path, label: v.label || v.path, example: String(v.ex), fmt: v.fmt || null })),
      buttonVars: buttons.filter((x) => x.var).map((x) => ({ button: x.text, path: x.var.path, example: String(x.var.ex), base: x.base })),
      needsUpload: Boolean(header?.image || header?.video),
      ...meta,
    },
  };
}

/* ═══ الكتالوج ═══════════════════════════════════════════════════════════ */
const ORDER_NO = { path: "order.order_no", label: "رقم الطلب", ex: "W1790012345678" };
const FIRST_NAME = { path: "customer.name", label: "الاسم الأول (افتراضي «عميلنا»)", ex: "محمد", fmt: "firstName" };
const TRACK = (text = "تتبّع الطلب") => url(text, `${STORE}/track/`, { path: "order.order_no", ex: "W1790012345678" });
const CART = (text = "كمّل طلبك") => url(text, `${STORE}/c/`, { path: "cart.code", ex: "ab12cd34" });
const LAND = (text = "اطلب الآن", ex = "wa-first") => url(text, `${STORE}/l/`, { path: "link.suffix", ex });
/* رابط الكوبون القديم (‎/?c=<code>) — مستعمل في fc_winback_45 بس: اعتُمد من ميتا بهذا الزر (١٢/١٠) وتعديل زره يرجّعه للمراجعة. */
const COUPON_LINK = (text = "استخدم الكود") => url(text, `${STORE}/?c=`, { path: "coupon.code", ex: "WB-4Q7M" });
/* كل قالب تسويقي ثاني: رابطنا المتتبَّع ‎/l/<slug>-<code> (cms.js يحسب الضغطة على صف المُرسَل إليه، وكوبونه الشخصي يركب في ‎?c=). */
const TRACKED = (text, ex) => url(text, `${STORE}/l/`, { path: "link.suffix", ex });
const MKT = { footer: OPTOUT_FOOTER };
/* FR1: زر الرد في الإطارات + نسخة الإنجليزي. «STOP» كلمة الإيقاف اللي الويب هوك بيفهمها (STOP_RE). */
export const ORDER_BUTTON = "أبغى أطلب";
export const ORDER_BUTTON_EN = "I want to order";
/* RF1 (١٤/١٠): زر الرد «ورّني المنيو» في إطارات «الرد أولاً» — البوت والمساعد بيفهموه «المنيو» (wabotrun classify ⇒ cats) */
export const MENU_BUTTON = "ورّني المنيو";
export const MENU_BUTTON_EN = "Show me the menu";
export const OPTOUT_FOOTER_EN = "To stop, reply: STOP";
/* RV1 (١٥/١٠): أزرار قالب النجوم fc_review_stars. ميتا بتسمح لحد ١٠ ردود سريعة، بس أكتر من ٣ ⇒ الموبايل بيعرض أول اتنين و«عرض كل الخيارات»
   (والكمبيوتر مابيفتحش القالب) ⇒ خمس نجوم = العالي ظاهر والواطي مستخبي. ٣ أزرار ظاهرين كلهم: ٥ / ٤ / «٣ أو أقل» (exact=false).
   الضغطة بتوصل بنص الزر (wareviews.starOfQr) — أي تعديل هنا = تقديم القالب من جديد.
   RV4 (١٦/١٠): ميتا رفضت التقديم الأول (code 100 / subcode 2388060 «Button format is incorrect»): نص زر القالب ممنوع فيه إيموجي
   ولا متغيّر ولا سطر جديد ولا رموز تنسيق ⇒ الأزرار من غير النجوم. legacy = النصوص القديمة بالنجوم: wareviews.starOfQr بيقبلها كمان
   (أي رسالة قديمة في جوال عميل لسه بتتفهم صح). validateTemplate بيرفض أي زر فيه الحاجات دي (buttonTextProblem). */
export const STAR_BUTTONS = Object.freeze([
  Object.freeze({ text: "ممتاز", stars: 5, exact: true, legacy: Object.freeze(["ممتاز ⭐⭐⭐⭐⭐"]) }),
  Object.freeze({ text: "جيد جداً", stars: 4, exact: true, legacy: Object.freeze(["جيد جداً ⭐⭐⭐⭐"]) }),
  Object.freeze({ text: "يحتاج تحسين", stars: 3, exact: false, legacy: Object.freeze([]) }),
]);
/* RV4: قاعدة ميتا لنص زر القالب (رفض 2388060): «Buttons can't have any variables, newlines, emojis or formatting characters».
   بيرجّع سبب بالعربي أو null. الحركات العربية (الشدّة/التنوين) مسموحة — «تتبّع الطلب» و«كمّل طلبك» معتمدين عند ميتا. */
const BTN_EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]/u;
export function buttonTextProblem(text) {
  const s = String(text ?? "");
  if (/\{\{/.test(s)) return "متغيّر";
  if (/[\r\n\t]/.test(s)) return "سطر جديد";
  if (BTN_EMOJI.test(s)) return "إيموجي";
  if (/[*_~`]/.test(s)) return "رموز تنسيق";
  return null;
}
export const OPTOUT_BUTTON_EN = "STOP";
const V = (path, label, ex, fmt) => ({ path, label, ex, ...(fmt ? { fmt } : {}) });
const FRAMES_DEF = [
  { name: "fc_frame_offer_img", header: { image: true }, purpose: "إطار عرض بصورة (اسم + تفاصيل + سعر)", btnAr: "اطلب الآن", btnEn: "Order now",
    ar: "من فريش كاتس 🔥\n{{1}}: {{2}}.\nالسعر {{3}} ر.س، واطلبه من موقعنا للتوصيل أو الاستلام.",
    en: "From Fresh Cuts 🔥\n{{1}}: {{2}}.\nPrice {{3}} SAR. Order it from our website for delivery or pickup.",
    vars: [V("offer.title", "اسم العرض", "بوكس التشكيلة"), V("offer.line", "اللي فيه (سطر واحد)", "مشاوي على الفحم مع بيتزا وباستا وأصناف جانبية ومشروبات"), V("offer.price", "السعر", "105", "money")],
    varsEn: [V("offer.title", "Offer name", "Taste-it-all box"), V("offer.line", "What is in it (one line)", "charcoal grills with pizza, pasta, sides and drinks"), V("offer.price", "Price", "105", "money")],
    notes: "إطار: القيم من العرض المختار. لا نكتب عدد أشخاص لصنف بالوزن ولا مقارنة بالتطبيقات." },
  { name: "fc_frame_video", header: { video: true }, purpose: "إطار فيديو (عنوان + تفاصيل)", btnAr: "اطلب الآن", btnEn: "Order now",
    ar: "من فريش كاتس 🎬\n{{1}}: {{2}}.\nاطلب من موقعنا للتوصيل أو الاستلام.",
    en: "From Fresh Cuts 🎬\n{{1}}: {{2}}.\nOrder from our website for delivery or pickup.",
    vars: [V("offer.title", "العنوان", "اطلب من موقعنا مباشرة"), V("offer.line", "التفاصيل (سطر واحد — السعر وآخر يوم بيتكتبوا هنا لو موجودين)", "اختر البوكس، حدّد عنوانك على الخريطة وادفع أونلاين، وأول طلب توصيله مجاني للطلبات من 60 ر.س")],
    varsEn: [V("offer.title", "Title", "Order directly from our website"), V("offer.line", "Details (one line)", "pick your box, set your address on the map and pay online; delivery is free on your first order from 60 SAR")],
    notes: "الفيديو mp4 لحد ١٦ ميجا من مخزن الوسائط بتاعنا. من غير خانة سعر عشان ينفع لفيديو «طريقة الطلب» ولأي عرض." },
  { name: "fc_frame_limited_img", header: { image: true }, purpose: "إطار عرض بصورة له آخر يوم", btnAr: "اطلب الآن", btnEn: "Order now",
    ar: "عرض لفترة محدودة من فريش كاتس 🎉\n{{1}}: {{2}}.\nالسعر {{3}} ر.س، والعرض لين {{4}}. اطلبه من موقعنا للتوصيل أو الاستلام.",
    en: "A limited-time offer from Fresh Cuts 🎉\n{{1}}: {{2}}.\nPrice {{3}} SAR, valid until {{4}}. Order it from our website for delivery or pickup.",
    vars: [V("offer.title", "اسم العرض", "باقة تجمّع ٤–٦ أشخاص"), V("offer.line", "اللي فيه (سطر واحد)", "مشاوي على الفحم مع الأرز والأصناف الجانبية والمشروبات"), V("offer.price", "السعر", "225", "money"), V("offer.untilText", "آخر يوم", "السبت 18 أكتوبر")],
    varsEn: [V("offer.title", "Offer name", "Gathering pack for 4-6"), V("offer.line", "What is in it (one line)", "charcoal grills with rice, sides and drinks"), V("offer.price", "Price", "225", "money"), V("offer.untilText", "Last day", "Saturday 18 October")],
    notes: "آخر يوم لازم يكون تاريخ العرض الفعلي في اللوحة — مفيش استعجال مخترع." },
  { name: "fc_frame_news_text", header: null, purpose: "إطار خبر/عرض نص بس", btnAr: "شوف التفاصيل", btnEn: "See details",
    ar: "جديد من فريش كاتس 👋\n{{1}}: {{2}}.\nالتفاصيل والطلب من موقعنا للتوصيل أو الاستلام.",
    en: "New from Fresh Cuts 👋\n{{1}}: {{2}}.\nDetails and ordering on our website, for delivery or pickup.",
    vars: [V("offer.title", "العنوان", "بوكسات فردية"), V("offer.line", "التفاصيل (سطر واحد)", "كريب أو برجر أو باستا أو حواوشي أو وجبة مشاوي مع صنف جانبي ومشروب، من 29 ر.س")],
    varsEn: [V("offer.title", "Title", "Solo boxes"), V("offer.line", "Details (one line)", "crepe, burger, pasta, hawawshi or a grill meal with a side and a drink, from 29 SAR")],
    notes: "من غير صورة أو من غير سعر." },
];

const ASK_CLOSE_AR = "تبي نجهز لك الطلب هنا؟ اضغط الزر وكمّل معنا في المحادثة.";
const ASK_CLOSE_EN = "Want us to prepare your order here? Tap a button and continue with us in this chat.";
const ASK_FRAMES_DEF = [
  { name: "fc_frame_ask_video", header: { video: true }, purpose: "إطار فيديو — الرد أولاً (من غير رابط)",
    ar: `من فريش كاتس 🎬\n{{1}}: {{2}}.\n${ASK_CLOSE_AR}`, en: `From Fresh Cuts 🎬\n{{1}}: {{2}}.\n${ASK_CLOSE_EN}`,
    vars: [V("offer.title", "العنوان", "بوكس التشكيلة"), V("offer.line", "التفاصيل (سطر واحد — السعر وآخر يوم بيتكتبوا هنا لو موجودين)", "مشاوي على الفحم مع بيتزا وباستا وأصناف جانبية ومشروبات، بـ105 ر.س")],
    varsEn: [V("offer.title", "Title", "Taste-it-all box"), V("offer.line", "Details (one line)", "charcoal grills with pizza, pasta, sides and drinks, for 105 SAR")],
    notes: "الفيديو mp4 لحد ١٦ ميجا من مخزن الوسائط بتاعنا. مفيش زر رابط: العميل بيرد والمساعد يكمّل. لا نكتب عدد أشخاص لصنف بالوزن ولا مقارنة بالتطبيقات." },
  { name: "fc_frame_ask_text", header: null, purpose: "إطار نص — الرد أولاً (من غير رابط)",
    ar: `جديد من فريش كاتس 👋\n{{1}}: {{2}}.\n${ASK_CLOSE_AR}`, en: `New from Fresh Cuts 👋\n{{1}}: {{2}}.\n${ASK_CLOSE_EN}`,
    vars: [V("offer.title", "العنوان", "بوكسات فردية"), V("offer.line", "التفاصيل (سطر واحد)", "كريب أو برجر أو باستا أو حواوشي أو وجبة مشاوي مع صنف جانبي ومشروب، من 29 ر.س")],
    varsEn: [V("offer.title", "Title", "Solo boxes"), V("offer.line", "Details (one line)", "crepe, burger, pasta, hawawshi or a grill meal with a side and a drink, from 29 SAR")],
    notes: "من غير صورة ولا فيديو. مفيش زر رابط: العميل بيرد والمساعد يكمّل." },
];

export const TEMPLATES = [
  /* ── ١) دورة الطلب — UTILITY ─────────────────────────────────────────── */
  T({ name: "fc_order_received", category: "UTILITY", group: "order",
    body: "أهلاً {{1}}، استلمنا طلبك رقم {{2}} وتم الدفع بنجاح ✅\nالإجمالي: {{3}} ر.س\nنبلّغك هنا بكل تحديث على طلبك.",
    vars: [FIRST_NAME, ORDER_NO, { path: "order.total", label: "الإجمالي", ex: "86.50", fmt: "money" }],
    buttons: [TRACK()],
    meta: { purpose: "تأكيد الطلب بعد الدفع ونزوله نقطة البيع", trigger: "shop.js حالة pos_created (notify.orderStatusChanged)",
      stage: "pos_created", send: "auto", fallbackSms: "order.pos_created (smstemplates.js)", existing: "whatsapp.js fc_order_received (نص أقدم)" } }),

  T({ name: "fc_payment_received", category: "UTILITY", group: "order",
    body: "تم استلام دفعتك لطلب رقم {{1}} بمبلغ {{2}} ر.س ✅\nنأكّد الطلب مع المطعم الحين، ونرسل لك التأكيد هنا.",
    vars: [ORDER_NO, { path: "order.total", label: "المبلغ", ex: "86.50", fmt: "money" }],
    meta: { purpose: "الدفع تم لكن نقطة البيع ما أكّدت بعد (تأخير أو فشل مؤقت)", trigger: "حالة paid_pos_failed أو paid لأكثر من دقيقتين",
      stage: "paid_pos_failed", send: "auto", fallbackSms: "فريش كاتس: استلمنا دفعتك لطلب {order_no} ونأكّده مع المطعم الحين" } }),

  T({ name: "fc_order_preparing", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} صار في المطبخ 👨‍🍳\nنطبخ الأكل طازج عند الطلب، ونبلّغك أول ما يجهز.",
    vars: [ORDER_NO], buttons: [TRACK()],
    meta: { purpose: "الكاشير قبل الطلب", trigger: "حالة accepted", stage: "accepted", send: "auto",
      fallbackSms: "order.accepted", existing: "whatsapp.js fc_order_preparing" } }),

  T({ name: "fc_order_ready_pickup", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} جاهز للاستلام ✅\nاذكر رقم الطلب للكاشير عند الاستلام.",
    vars: [ORDER_NO],
    buttons: [TRACK("تفاصيل الطلب")],
    meta: { purpose: "طلب استلام صار جاهز", trigger: "pos_ready_at لطلب option=pickup بس (PK1 ١٧/١٠: مفيش مؤقّت — pickupReadyMinutes القديم كان لصفحة التتبع بس واتشال)",
      stage: "pickup_ready", send: "auto", fallbackSms: "فريش كاتس: طلبك {order_no} جاهز للاستلام من الفرع", existing: "whatsapp.js fc_order_ready_pickup",
      notes: "١٢/١٠: النسخة الأولى (زر «موقع الفرع» → خرائط جوجل + «تقدر تستلمه من…») رفضتها ميتا INCORRECT_CATEGORY — القالب الخدمي الوحيد اللي زره مش رابط الطلب نفسه. الزر بقى رابط تتبّع الطلب زي باقي قوالب الطلب المعتمدة، والنص عن الطلب بس. ١٢/١٠ (تاني): التعديل اترفض برضه INCORRECT_CATEGORY والزر كان رابط الطلب ⇒ الباقي المختلف عن القوالب المعتمدة هو جملة الفرع والحي والمدينة — اتشالت، والنص بقى حالة الطلب + تعليمة الاستلام بس." } }),

  /* SW1 (١٣/١٠ — M6-3): fc_order_ready_pickup مرفوض عند ميتا. ده اسم جديد بصياغة خدمية بحتة: رقم الطلب + «جاهز للاستلام».
     **موقوف (HOLD)** لحد ما المالك يوافق على النص — مش مربوط بمرحلة ولا بيتقدّم.
     📍 RT2 (١٧/١٠ — عمر: «موصلتش رسايل واتس اب ان الطلب جاهز»): النص بقى الصياغة اللي المالك اقترحها (فريش كاتس + تفضّل إلى الفرع + اذكر رقم طلبك)،
     بالعربي والإنجليزي — ده جسم التقديم لميتا زي ما هو (submissionBody). لحد ما ميتا تعتمده: نفس النص بيطلع **رسالة حرة ببلاش** جوّه نافذة الـ٢٤ ساعة
     (whatsapp.js sendOrderUpdate لمرحلة pickup_ready لما المرحلة في waBot.windowV2Stages)، وبره النافذة ⇒ SMS البديل لو المرحلة في smsStages.
     لسه مانتبهش: النسختين اللي قبله اترفضوا INCORRECT_CATEGORY (جملة الفرع/الحي/زر الخرايط) — النص ده عن الطلب وتعليمة الاستلام بس، من غير حي ولا مدينة. */
  T({ name: "fc_order_pickup_ready", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} جاهز للاستلام من فريش كاتس 📍 تفضّل إلى الفرع واذكر رقم طلبك.",
    vars: [ORDER_NO], buttons: [TRACK("تفاصيل الطلب")],
    meta: { purpose: "طلب استلام صار جاهز — صياغة المالك (١٧/١٠) باسم جديد", trigger: "notify.orderReady ⇒ pos_ready_at لطلب option=pickup (RT2: حر جوّه النافذة الآن، قالب بعد اعتماد ميتا)",
      send: "auto-candidate", replaces: "fc_order_ready_pickup", stageWhenApproved: "pickup_ready",
      fallbackSms: "فريش كاتس: طلبك {order_no} جاهز للاستلام من الفرع",
      notes: "RT2 ١٧/١٠: مربوط بالمرحلة pickup_ready عن طريق waBot.windowV2Stages (الاسم البديل بدل _v2) — بره النافذة مايتبعتش إلا لو ميتا بتقول APPROVED." } }),
  T({ name: "fc_order_pickup_ready", category: "UTILITY", group: "order", language: "en",
    body: "Your order {{1}} is ready for pickup from Fresh Cuts 📍 Please come to the branch and mention your order number.",
    vars: [ORDER_NO], buttons: [TRACK("Order details")],
    meta: { purpose: "Pickup order is ready — the owner's wording (17/10) under a new name", trigger: "notify.orderReady, option=pickup", send: "auto-candidate", replaces: "fc_order_ready_pickup", stageWhenApproved: "pickup_ready", fallbackSms: null } }),

  T({ name: "fc_courier_assigned", category: "UTILITY", group: "order",
    body: "رتّبنا مندوب لطلبك رقم {{1}} 🛵\nيستلم الطلب أول ما يجهز من المطبخ، وتقدر تتابع من الرابط.",
    vars: [ORDER_NO], buttons: [TRACK()],
    meta: { purpose: "شركة التوصيل عيّنت مندوب — صياغة محايدة (الأكل ممكن لسه يتجهّز)", trigger: "حالة courier_assigned",
      stage: "courier_assigned", send: "auto", fallbackSms: "order.courier_assigned",
      notes: "قرار عمر ١١/٩: لا نقول «المندوب في الطريق» قبل ما الأكل يجهز" } }),

  T({ name: "fc_order_on_the_way", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} مع المندوب وفي الطريق إليك 🛵\nخلّ جوالك قريب، ممكن يتصل عليك المندوب عند الوصول.",
    vars: [ORDER_NO], buttons: [TRACK("تتبّع المندوب")],
    meta: { purpose: "المندوب استلم الطلب", trigger: "حالة on_the_way (المندوب الخارجي: /d/<token> «ابدأ التوصيل»)",
      stage: "on_the_way", send: "auto", fallbackSms: "order.on_the_way", existing: "whatsapp.js fc_order_on_the_way" } }),

  T({ name: "fc_order_delivered", category: "UTILITY", group: "order",
    body: "تم توصيل طلبك رقم {{1}} ✅ بالعافية عليك.\nلو عندك أي ملاحظة على الطلب ردّ على هذي الرسالة ونخدمك.",
    vars: [ORDER_NO],
    meta: { purpose: "تأكيد التوصيل — ويفتح نافذة ٢٤ ساعة لو العميل ردّ", trigger: "حالة delivered",
      stage: "delivered", send: "auto", fallbackSms: "order.delivered", existing: "whatsapp.js fc_order_delivered" } }),

  T({ name: "fc_review_request", category: "UTILITY", group: "order",
    body: "نتمنى الأكل عجبك 🌟\nكيف كانت تجربتك مع طلب رقم {{1}}؟ التقييم ياخذ أقل من دقيقة ويساعدنا نتحسّن.",
    vars: [ORDER_NO], buttons: [url("قيّم طلبك", `${STORE}/r?c=`, { path: "review.code", ex: "ab12cd" })],
    meta: { purpose: "طلب التقييم بعد التوصيل", trigger: "reviews.js review_invites — بعد ٣٠ دقيقة من التوصيل، خارج ٢ص–١١ص",
      send: "auto", fallbackSms: "review.invite", reclassRisk: "medium",
      notes: "مرتبط بطلب محدد ⇒ UTILITY، لكن ميتا أحياناً تصنّف الاستبيانات تسويق. صفحة /r فيها التوجيه الحالي (٤–٥★ جوجل) — انتبه لملاحظة review gating في freshcuts-seo-compliance" } }),

  /* SB4 — «نوافذ الـ٢٤ ساعة» (عمر ١٤/١٠): نسخ v2 من قوالب الطلب فيها رد سريع مفيد للعميل. الضغطة رسالة واردة ⇒ نافذة ٢٤ ساعة ببلاش،
     والتحديثات اللي بعدها بتطلع رسالة حرة (whatsapp.js sendOrderUpdate). نفس النص الخدمي بالحرف + زر رد سريع؛ مفيش كلام ترويجي (وإلا ميتا تصنّفه تسويق).
     **مالهاش stage**: مش مربوطة بمرحلة لحد ما المالك يقدّمها وتتعتمد ويحط المرحلة في waBot.windowV2Stages. الرد السريع بيوصل للبوت بنصه (wabotrun QR_IDS). */
  T({ name: "fc_order_received_v2", category: "UTILITY", group: "order",
    body: "أهلاً {{1}}، استلمنا طلبك رقم {{2}} وتم الدفع بنجاح ✅\nالإجمالي: {{3}} ر.س\nنبلّغك هنا بكل تحديث على طلبك.",
    vars: [FIRST_NAME, ORDER_NO, { path: "order.total", label: "الإجمالي", ex: "86.50", fmt: "money" }],
    buttons: [qr("تابع طلبي"), TRACK()],
    meta: { purpose: "تأكيد الطلب + رد سريع «تابع طلبي» يفتح نافذة ٢٤ ساعة", trigger: "pos_created لما المرحلة في waBot.windowV2Stages", send: "auto-candidate", replaces: "fc_order_received", fallbackSms: "order.pos_created" } }),
  T({ name: "fc_order_preparing_v2", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} صار في المطبخ 👨‍🍳\nنطبخ الأكل طازج عند الطلب، ونبلّغك أول ما يجهز.",
    vars: [ORDER_NO], buttons: [qr("تابع طلبي"), TRACK()],
    meta: { purpose: "الطلب في المطبخ + «تابع طلبي»", trigger: "accepted لما المرحلة في waBot.windowV2Stages", send: "auto-candidate", replaces: "fc_order_preparing", fallbackSms: "order.accepted" } }),
  T({ name: "fc_order_on_the_way_v2", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} مع المندوب وفي الطريق إليك 🛵\nخلّ جوالك قريب، ممكن يتصل عليك المندوب عند الوصول.",
    vars: [ORDER_NO], buttons: [qr("تابع طلبي"), TRACK("تتبّع المندوب")],
    meta: { purpose: "مع المندوب + «تابع طلبي»", trigger: "on_the_way لما المرحلة في waBot.windowV2Stages", send: "auto-candidate", replaces: "fc_order_on_the_way", fallbackSms: "order.on_the_way" } }),
  /* SB5 (عمر ١٤/١٠: «في رسالة المندوب في الطريق يكون فيها بيانات المندوب وامكانية انه يتواصل معاه واتساب»): اسم المندوب الأول + زر «راسل المندوب» (رابطنا اللي بيحوّل
     لواتساب المندوب ما دام الطلب معه، ومابيحملش رقمه) + زر التتبع. مالوش stage: بيتبعت بدل fc_order_on_the_way بس لما waBot.courierTemplate مفتوح (بعد اعتماد ميتا)
     وللمندوب اسم وجوال؛ غير كده القالب القديم. */
  /* CW1 (١٦/١٠، عمر: «المندوب بيكون عنده صعوبة انه يضغط ع اللينك… نبعتله رسالة على الواتس فيها الأزرار»): طلب توصيل لمندوب خارجي
     (طلباتك وغيرهم) بره نافذة الـ٢٤ ساعة. ٣ ردود سريعة بالظبط (أكتر من ٣ بتستخبى ورا «عرض كل الخيارات») — كل زر بيرجع بـpayload موقّع
     للرحلة دي (courierwa.js) مش بنصّه. بعد أول ضغطة النافذة بتتفتح والباقي رسايل حرة ببلاش. الحارس: الرقم لازم مندوب على رحلة شغّالة.
     **مش متقدّم لميتا** — المالك/الجلسة الرئيسية بيقدّموه بعد النشر، وبعد الاعتماد يتفتح «courierJob.useTemplate» من اللوحة. */
  T({ name: "fc_courier_job_v1", category: "UTILITY", group: "courier",
    body: "طلب توصيل من فريش كاتس رقم {{1}} 🛵\nالعميل: {{2}}، وجواله {{3}}\nالعنوان: {{4}}\nالموقع على الخريطة: {{5}}\nالطلب مدفوع مسبقاً، لا تحصّل أي مبلغ من العميل.\nاضغط «استلمت الطلب» أول ما تستلمه من المطعم، و«تم التسليم» بعد ما تسلّمه للعميل.",
    vars: [ORDER_NO, { path: "courier.customerName", label: "اسم العميل", ex: "أحمد" },
      { path: "courier.customerPhone", label: "جوال العميل", ex: "0551234567" },
      { path: "courier.address", label: "العنوان المقروء (couriers.readableAddress)", ex: "السلامة، شارع الأمير سلطان، عمارة 12، الدور 3، شقة 7" },
      { path: "courier.map", label: "رابط الخريطة", ex: "https://maps.google.com/?q=21.614700,39.145036" }],
    buttons: [qr("استلمت الطلب"), qr("وصلت عند العميل"), qr("تم التسليم")],
    meta: { purpose: "طلب توصيل لمندوب خارجي بأزرار الاستلام والوصول والتسليم", trigger: "courierwa.js — تسجيل «مندوب من بره» في البوابة والنافذة مقفولة، لما waBot.courierJob.useTemplate مفتوح",
      send: "auto-candidate", fallbackSms: null, notes: "الأزرار بترجع payload موقّع للرحلة (cw1.<run>.<action>.<sig>) — مش نص الزر." } }),
  T({ name: "fc_order_on_the_way_courier", category: "UTILITY", group: "order",
    body: "طلبك رقم {{1}} مع المندوب {{2}} وفي الطريق إليك 🛵\nتقدر تراسله على واتساب من الزر، أو تتابع الطلب من الرابط.",
    vars: [ORDER_NO, { path: "courier.first_name", label: "اسم المندوب الأول", ex: "أحمد" }],
    buttons: [url("راسل المندوب", COURIER_TEMPLATE_BASE, { path: "courier.link", ex: "W1790012345678.Ab12Cd34Ef56" }), TRACK("تتبّع الطلب")],
    meta: { purpose: "مع المندوب: اسمه وزر واتساب له وزر التتبع", trigger: "on_the_way لما waBot.courierTemplate مفتوح وللمندوب اسم وجوال", send: "auto-candidate", replaces: "fc_order_on_the_way", fallbackSms: "order.on_the_way" } }),
  T({ name: "fc_order_on_the_way_courier", category: "UTILITY", group: "order", language: "en",
    body: "Your order {{1}} is with your courier {{2}} and on its way 🛵\nYou can message the courier on WhatsApp from the button, or follow the order from the link.",
    vars: [ORDER_NO, { path: "courier.first_name", label: "Courier first name", ex: "Ahmed" }],
    buttons: [url("Message the courier", COURIER_TEMPLATE_BASE, { path: "courier.link", ex: "W1790012345678.Ab12Cd34Ef56" }), TRACK("Track order")],
    meta: { purpose: "With the courier: name, WhatsApp button, tracking", trigger: "on_the_way when waBot.courierTemplate is on", send: "auto-candidate", replaces: "fc_order_on_the_way", fallbackSms: null } }),
  T({ name: "fc_order_delivered_v2", category: "UTILITY", group: "order",
    body: "تم توصيل طلبك رقم {{1}} ✅ بالعافية عليك.\nوصلك الطلب مثل ما تبي؟",
    vars: [ORDER_NO], buttons: [qr("تمام"), qr("عندي ملاحظة")],
    meta: { purpose: "تأكيد التوصيل + «تمام / عندي ملاحظة» (الضغطة = رأيه في الطلب ويفتح نافذة)", trigger: "delivered لما المرحلة في waBot.windowV2Stages", send: "auto-candidate", replaces: "fc_order_delivered", fallbackSms: "order.delivered" } }),
  T({ name: "fc_order_refunded_v2", category: "UTILITY", group: "order",
    body: "نعتذر منك، ما قدرنا ننفّذ طلبك رقم {{1}} وتم استرجاع المبلغ كاملاً لوسيلة الدفع 💳\nيظهر المبلغ في حسابك حسب إجراءات البنك.",
    vars: [ORDER_NO], buttons: [qr("عندي سؤال")],
    meta: { purpose: "الاسترجاع نجح + «عندي سؤال» (موظف)", trigger: "rejected_refunded لما المرحلة في waBot.windowV2Stages", send: "auto-candidate", replaces: "fc_order_refunded", mandatory: true, fallbackSms: "order.rejected_refunded" } }),
  T({ name: "fc_refund_in_progress_v2", category: "UTILITY", group: "order",
    body: "نعتذر منك بخصوص طلبك رقم {{1}} 🙏\nاسترجاع المبلغ جاري وفريقنا يتابعه، وبنتواصل معك للتأكيد.",
    vars: [ORDER_NO], buttons: [qr("عندي سؤال")],
    meta: { purpose: "الاسترجاع جاري + «عندي سؤال» (موظف)", trigger: "refund_failed لما المرحلة في waBot.windowV2Stages", send: "auto-candidate", replaces: "fc_refund_in_progress", mandatory: true, fallbackSms: "order.refund_failed" } }),
  T({ name: "fc_review_request_v2", category: "UTILITY", group: "order",
    body: "كيف كانت تجربتك مع طلب رقم {{1}}؟ 🌟\nاختر من الأزرار، أو قيّم الطلب من الرابط.",
    vars: [ORDER_NO], buttons: [qr("تمام"), qr("عندي ملاحظة"), url("قيّم طلبك", `${STORE}/r?c=`, { path: "review.code", ex: "ab12cd" })],
    meta: { purpose: "طلب التقييم بره النافذة + «تمام / عندي ملاحظة»", trigger: "reviews.js — لما waBot.windowV2Stages فيها review", send: "auto-candidate", replaces: "fc_review_request", fallbackSms: "review.invite" } }),
  /* RV1 (عمر ١٥/١٠: «ناخد التقييم من الواتساب بالنجوم»): النجوم في القالب نفسه بره النافذة — ضغطة واحدة. ٤–٥ ⇒ رابط جوجل في المحادثة، «يحتاج تحسين» ⇒ اعتذار + المدير.
     الضغطة رسالة واردة ⇒ الرد بعدها حر وببلاش. {{1}} = «طلبك رقم W…» (موقع) / «زيارتك للمطعم» (صالة) / «طلبك من الفرع» (سفري) — نصوص البوت rs_subj_*.
     **موقوف (HOLD) عن الدفعات** — عمر وافق على النص ١٥/١٠ ١٤:١٥؛ بيتقدّم بعد النشر بـ force:true، وبعد اعتماد ميتا: waBot.reviewFlow.starsTemplate = مفتوح. */
  T({ name: "fc_review_stars", category: "UTILITY", group: "order",
    body: "فريش كاتس تشكرك 🌟\nكيف تقيّم {{1}}؟ اختر من الأزرار 👇",
    vars: [{ path: "review.subject", label: "الطلب أو الزيارة (طلبك رقم … / زيارتك للمطعم / طلبك من الفرع)", ex: "طلبك رقم W1790012345678" }],
    buttons: STAR_BUTTONS.map((b) => qr(b.text)),
    meta: { purpose: "طلب التقييم بالنجوم بره النافذة (ممتاز / جيد جداً / يحتاج تحسين)", trigger: "reviews.js — لما waBot.reviewFlow.starsTemplate مفتوح (كل أنواع الطلبات)", send: "auto-candidate",
      replaces: "fc_review_request_v2", reclassRisk: "medium", fallbackSms: "review.invite",
      notes: "مربوط بطلب محدد ومافيهوش ترويج ⇒ UTILITY؛ ميتا ممكن تصنّف الاستبيانات تسويق — لو حصل ماتتربطش (خانة الفئة في الكتالوج). مفيش رابط في القالب: جوجل بيتبعت في المحادثة بعد ٤–٥ بس." } }),

  T({ name: "fc_order_delayed", category: "UTILITY", group: "order",
    body: "نعتذر منك، طلبك رقم {{1}} تأخر عن الوقت المتوقع 🙏\nفريقنا يتابعه الحين ونبلّغك أول ما يتحرك، وتقدر تتابع حالته من الرابط.",
    vars: [ORDER_NO], buttons: [TRACK()],
    meta: { purpose: "اعتذار استباقي عن التأخير", trigger: "slaCheck مستوى ≥2 (handoff_breach/pickup_breach/deliver_breach) — مرة وحدة للطلب",
      send: "auto-candidate", fallbackSms: "فريش كاتس: نعتذر عن تأخر طلبك {order_no}، فريقنا يتابعه الحين",
      notes: "ما فيه وعد بدقائق — ما عندنا ETA حقيقي (لاجلك ما يرجّع ETA)" } }),

  T({ name: "fc_order_refunded", category: "UTILITY", group: "order",
    body: "نعتذر منك، ما قدرنا ننفّذ طلبك رقم {{1}} وتم استرجاع المبلغ كاملاً لوسيلة الدفع 💳\nيظهر المبلغ في حسابك حسب إجراءات البنك.",
    vars: [ORDER_NO],
    meta: { purpose: "الطلب اترفض والاسترجاع نجح", trigger: "حالة rejected_refunded", stage: "rejected_refunded",
      send: "auto", mandatory: true, fallbackSms: "order.rejected_refunded", existing: "whatsapp.js fc_order_refunded" } }),

  T({ name: "fc_refund_in_progress", category: "UTILITY", group: "order",
    body: "نعتذر منك بخصوص طلبك رقم {{1}} 🙏\nاسترجاع المبلغ جاري وفريقنا يتابعه، وبنتواصل معك للتأكيد.",
    vars: [ORDER_NO],
    meta: { purpose: "الاسترجاع الآلي فشل — لا نقول «تم»", trigger: "حالة refund_failed", stage: "refund_failed",
      send: "auto", mandatory: true, fallbackSms: "order.refund_failed", existing: "whatsapp.js fc_refund_in_progress" } }),

  T({ name: "fc_order_cancelled", category: "UTILITY", group: "order",
    body: "تم إلغاء طلبك رقم {{1}} حسب طلبك.\nلو دفعت المبلغ يرجع لوسيلة الدفع حسب إجراءات البنك، ولأي استفسار ردّ على هذي الرسالة.",
    vars: [ORDER_NO],
    meta: { purpose: "إلغاء بطلب العميل (الموظف ألغى من البورتال)", trigger: "إلغاء يدوي من المدير بعد طلب العميل",
      send: "manual", fallbackSms: "فريش كاتس: تم إلغاء طلبك {order_no} حسب طلبك" } }),

  T({ name: "fc_payment_failed", category: "UTILITY", group: "order",
    body: "ما اكتملت عملية الدفع لطلبك رقم {{1}} من فريش كاتس، والطلب ما تأكّد.\nلو ظهر مبلغ معلّق في حسابك يرجع تلقائياً حسب إجراءات البنك، ولأي استفسار ردّ على هذي الرسالة.",
    vars: [ORDER_NO],
    meta: { purpose: "جلسة الدفع فشلت/انتهت (رفض بنك) — تنبيه عن عملية الدفع نفسها", trigger: "shop_orders pending_payment → expired (مرة وحدة للطلب)",
      send: "auto-candidate", reclassRisk: "low", fallbackSms: "فريش كاتس: ما اكتمل الدفع لطلبك {order_no} والطلب ما تأكّد",
      notes: "١٢/١٠: كان فيه «سلتك محفوظة» وزر «كمّل الدفع» → /c/ = تذكير سلة (تسويق عند ميتا). النص الآن عن عملية الدفع لطلب محدد بس، بدون رابط ولا دعوة للطلب. استرجاع السلة يفضل عند fc_cart_1h (تسويق، بموافقة التسويق)." } }),

  T({ name: "fc_otp", category: "AUTHENTICATION", group: "order", expiryMinutes: 5, copyText: "نسخ الرمز",
    meta: { purpose: "رمز الدخول في الشيك أوت", trigger: "accounts.js /api/account/otp/request (قناة واتساب اختيارية)",
      send: "auto", fallbackSms: "account.otp",
      notes: "نص قوالب التحقق ثابت من ميتا («{{1}} هو رمز التحقق الخاص بك»). الإرسال: body=[code] + button url param=[code]",
      bind: [{ n: 1, path: "otp.code", label: "الرمز", example: "4821" }], existing: "whatsapp.js fc_otp" } }),

  T({ name: "fc_address_confirm", category: "UTILITY", group: "order",
    body: "قبل ما نرسل طلبك رقم {{1}} للمندوب نبي نتأكد من العنوان:\n{{2}}\nهل العنوان صحيح؟",
    vars: [ORDER_NO, { path: "order.addressText", label: "العنوان المقروء (سطر واحد)", ex: "حي الصفا، شارع الأمير سلطان، عمارة 12" }],
    buttons: [qr("العنوان صحيح"), qr("تعديل العنوان")],
    meta: { purpose: "تأكيد العنوان لما الدبوس بعيد عن الحي المكتوب أو ناقص", trigger: "يدوي من البورتال (أو مستقبلاً: فرق الدبوس/النص)",
      send: "manual", fallbackSms: "فريش كاتس: نبي نتأكد من عنوان طلبك {order_no}، اتصل علينا 0546715683",
      replies: { "العنوان صحيح": "addr:ok", "تعديل العنوان": "addr:edit → handoff" } } }),

  T({ name: "fc_scheduled_reminder", category: "UTILITY", group: "order",
    body: "تذكير بطلبك المجدول رقم {{1}} ⏰\nنجهّزه ويوصلك في موعده: {{2}}.\nلو تبي تعدّل أي شي ردّ على هذي الرسالة قبل الموعد بساعة.",
    vars: [ORDER_NO, { path: "order.slotText", label: "الموعد (من scheduled_slot)", ex: "اليوم 8:00 – 11:00 م" }],
    buttons: [TRACK()],
    meta: { purpose: "تذكير الطلب المجدول", trigger: "preorder.js قبل scheduled_for بـprepLeadMin",
      send: "auto-candidate", fallbackSms: "فريش كاتس: تذكير بطلبك المجدول {order_no}",
      notes: "settings.preorder.enabled=false حالياً — يشتغل لما يتفعّل" } }),

  T({ name: "fc_waitlist_open", category: "MARKETING", group: "order", ...MKT,
    body: "فتحنا الحين 🎉\nطلبت منّا نذكّرك أول ما يفتح المطعم، وسلتك محفوظة مثل ما تركتها.",
    buttons: [CART(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "«نبّهني لما تفتحوا» — تنبيه طلبه العميل بنفسه", trigger: "openwait.js عند الفتح (نافذة openWindowMinutes)",
      send: "auto", reclassRisk: "medium", fallbackSms: "waitlist.open",
      notes: "١٢/١٠: إرشادات ميتا تعدّ تذكير السلة/إعادة الاستهداف تسويقاً «حتى لو طلبه العميل» ⇒ MARKETING مع فوتر وزر الإيقاف" } }),

  T({ name: "fc_open_notice", category: "UTILITY", group: "order",
    body: "تنبيه الفتح رقم {{1}} المسجَّل {{2}} 🔔\nطلبت منّا تنبيهك عند فتح المطعم: فريش كاتس مفتوح الآن ويستقبل الطلبات حتى الساعة {{3}}.",
    vars: [{ path: "waitlist.ref", label: "مرجع طلب التنبيه (open_waitlist.id ⇒ N-<id>)", ex: "N-1042" },
      { path: "waitlist.requestedText", label: "وقت تسجيل طلب التنبيه بتوقيت الرياض (open_waitlist.created_at)", ex: "يوم 12/10 الساعة 4:35 ص" },
      { path: "hours.closeText", label: "وقت الإقفال اليوم (settings.hours)", ex: "2:00 ص" }],
    meta: { purpose: "«نبّهني لما تفتحوا» — التنبيه اللي طلبه العميل، بمرجع طلبه ووقته، بدون سلة ولا رابط ولا دعوة للطلب", trigger: "openwait.js عند الفتح، لرقم متحقَّق منه بـOTP (openNoticeData)",
      send: "auto-candidate", reclassRisk: "medium", fallbackSms: "waitlist.open", pairedWith: "fc_waitlist_open",
      notes: "١٢/١٠ (قرار عمر: يتربط بطلب التنبيه نفسه): النص بيذكر مرجع الطلب ووقت تسجيله ⇒ «خاص بطلب العميل ومطلوب منه» بنص تعريف ميتا للخدمي. من غير زر: ميتا تعدّ الدعوة للطلب لزائر الموقع تسويقاً «حتى لو طلبها»، فرابط السلة يفضل في fc_waitlist_open (تسويق). لو ميتا صنّفته تسويق نقف ونفضل على التسويقي — من غير إعادة تقديم." } }),

  /* ── ٢) الحساب والولاء ───────────────────────────────────────────────── */
  T({ name: "fc_welcome_account", category: "UTILITY", group: "account",
    body: "أهلاً {{1}}، تم تفعيل حسابك في فريش كاتس ✅\nتقدر تتابع طلباتك وعناوينك المحفوظة من الموقع، وأي استفسار ردّ على هذي الرسالة.",
    vars: [FIRST_NAME],
    meta: { purpose: "تأكيد إنشاء الحساب بعد أول تحقق OTP — بدون عرض وبدون زر", trigger: "acct_customers أول تسجيل",
      send: "auto-candidate", fallbackSms: null, notes: "١٢/١٠: زر «فتح الموقع» اتشال — زر للموقع في رسالة ترحيب = دعوة للزيارة (تسويق عند ميتا)" } }),

  T({ name: "fc_loyalty_status", category: "UTILITY", group: "account",
    body: "تم احتساب طلبك رقم {{1}} في برنامج ولاء فريش كاتس ✅\nرصيدك من الطلبات الآن {{2}} من {{3}}: {{4}}.\nالتفاصيل في صفحة الطلب.",
    vars: [ORDER_NO, { path: "loyalty.progress", label: "ترتيب هذا الطلب في الدورة (1..every — الطلب المكمِّل = every، مش صفر)", ex: "2" },
      { path: "loyalty.every", label: "عدد طلبات الدورة (cms.loyalty.every)", ex: "3" },
      { path: "loyalty.statusText", label: "الحالة نصاً (loyalty.js loyaltyStatusFor): «باقي طلب واحد» / «باقي طلبين» / «اكتمل الرصيد»", ex: "باقي طلب واحد" }],
    buttons: [TRACK("تفاصيل الطلب")],
    meta: { purpose: "رصيد الولاء بعد استلام الطلب — تحديث حساب مرتبط بطلب محدد", trigger: "notify.js عند «delivered» (توصيل/استلام/طاولة) — مرة وحدة للطلب، مفتاح notifications.whatsappLoyaltyStatus",
      send: "auto", reclassRisk: "medium", fallbackSms: null, pairedWith: "fc_loyalty_progress",
      notes: "١٢/١٠: النسخة الخدمية من fc_loyalty_progress — رصيد وحالة بس: لا اسم المكافأة، لا «اطلب»، لا كود. الطلب المكمِّل للدورة بيقول «اكتمل الرصيد» والكود نفسه بيوصل برسالة المكافأة (SMS الحالي). الأرقام من نفس قاعدة cms.js loyaltyCounts." } }),

  T({ name: "fc_feedback_received", category: "UTILITY", group: "account",
    body: "شكراً على ملاحظتك بخصوص طلبك رقم {{1}} 🙏\nوصلت ملاحظتك للفريق وراجعناها، ولو احتجنا تفاصيل أكثر نتواصل معك على هذا الرقم.",
    vars: [ORDER_NO],
    meta: { purpose: "متابعة ملاحظة العميل على طلب محدد — بدون هدية", trigger: "يدوي من صندوق التقييمات بعد مراجعة الملاحظة",
      send: "manual", reclassRisk: "low", fallbackSms: null, pairedWith: "fc_review_thanks_coupon",
      notes: "١٢/١٠: النسخة الخدمية من fc_review_thanks_coupon (ميتا: «كود خصم شكراً على طلب سابق» = تسويق). لو فيه هدية تتبعت بالقالب التسويقي للي وافق على التسويق." } }),

  T({ name: "fc_loyalty_progress", category: "MARKETING", group: "account", ...MKT,
    body: "باقي لك {{1}} وتحصل على {{2}} 🎁\nكل طلب من موقع فريش كاتس يقرّبك من مكافأتك.",
    vars: [{ path: "loyalty.remainingText", label: "الباقي نصاً: «طلب واحد» / «طلبين» (لا رقم مجرّد)", ex: "طلب واحد" }, { path: "loyalty.rewardText", label: "المكافأة (من cms.loyalty)", ex: "توصيل مجاني" }],
    buttons: [LAND("اطلب الآن", "wa-loyalty"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "تقدّم الولاء", trigger: "بعد كل طلب مدفوع لو cms.loyalty.enabled و remaining ≤ 2",
      send: "auto-candidate", fallbackSms: null, notes: "الولاء شغّال من ٥/١٠: كل ٣ طلبات = توصيل مجاني (حد أدنى ٦٠)" } }),

  T({ name: "fc_loyalty_reward", category: "MARKETING", group: "account", ...MKT,
    body: "مبروك {{1}} 🎉 وصلت لمكافأتك في فريش كاتس: {{2}}.\nكودك الخاص {{3}} صالح لين {{4}}، استخدمه في طلبك الجاي من الموقع.",
    vars: [FIRST_NAME, { path: "loyalty.rewardText", label: "المكافأة", ex: "توصيل مجاني للطلبات من 60 ر.س" },
      { path: "coupon.code", label: "الكود الشخصي (cms_loyalty.coupon)", ex: "LOY-8F3K" }, { path: "coupon.expiresText", label: "تاريخ الانتهاء", ex: "26 أكتوبر" }],
    buttons: [TRACKED("استخدم الكود", "loy-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "كوبون الولاء", trigger: "cms.js loyaltyRun يصدر كوبون", send: "auto", fallbackSms: "push/SMS الحالي في loyaltyRun" } }),

  T({ name: "fc_coupon_expiring", category: "MARKETING", group: "account", ...MKT,
    body: "تذكير لطيف: كودك {{1}} ينتهي {{2}} ⏳\nاستخدمه في طلبك من موقع فريش كاتس قبل ما يروح عليك.",
    vars: [{ path: "coupon.code", label: "الكود", ex: "LOY-8F3K" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "بكرة" }],
    buttons: [TRACKED("استخدم الكود", "wa-coupon-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "كوبون شخصي (ولاء/واتساب مرة وحدة) قرب ينتهي", trigger: "shop_coupons phone_norm غير فاضي، used_count=0، expires_at = بكرة",
      send: "auto-candidate", fallbackSms: null } }),

  /* ── ٣) الإدارة — UTILITY لأرقام الفريق (settings.delivery.staffSmsLanguage) ── */
  ...staffPair("fc_staff_new_order",
    { body: "New online order {{1}}: {{2}}, {{3}} SAR, paid. {{4}} items, follow it on the portal.",
      ar: "طلب أونلاين جديد {{1}}: {{2}} بمبلغ {{3}} ر.س مدفوع. عدد الأصناف {{4}}، تابعه من البورتال." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "order.optionText", ex: "Delivery", exAr: "توصيل", label: "توصيل/استلام" },
      { path: "order.total", ex: "86.50", label: "الإجمالي", fmt: "money" }, { path: "order.itemCount", ex: "3", label: "عدد الأصناف" }],
    { purpose: "طلب أونلاين جديد مدفوع", trigger: "staffalerts.js newOrderText — settings.delivery.newOrderPhones", send: "auto",
      fallbackSms: "staffalerts.newOrderText" }),
  ...staffPair("fc_staff_sla_alert",
    { body: "Order {{1}} needs action now: {{2}}. Please check the portal.",
      ar: "الطلب {{1}} يحتاج تدخل الحين: {{2}}. افتح البورتال وتابعه." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "sla.text", ex: "25min since acceptance, no courier requested", exAr: "٢٥ دقيقة من القبول بدون مندوب", label: "نص slaCheck" }],
    { purpose: "طلب متعطّل (SLA)", trigger: "shop.js slaCheck مستوى ≥2 — نفس أكواد SLA_EN/SLA_AR", send: "auto", fallbackSms: "staffalerts SLA" }),
  ...staffPair("fc_staff_courier_issue",
    { body: "Courier problem on order {{1}}: {{2}}. Request another courier or send an external one from the portal.",
      ar: "مشكلة مندوب في الطلب {{1}}: {{2}}. اطلب مندوب ثاني أو أرسل مندوب خارجي من البورتال." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "courier.issue", ex: "Leajlak refused the order", exAr: "لاجلك رفض الطلب", label: "المشكلة (courierops)" }],
    { purpose: "رفض/تأخر المندوب", trigger: "courierops.js رفض لاجلك أو تأخر الوصول > 20 دقيقة", send: "auto", fallbackSms: "staffalerts courier" }),
  ...staffPair("fc_staff_pos_failed",
    { body: "Order {{1}} is PAID but did not reach the POS ({{2}}). Enter it manually on the POS now.",
      ar: "الطلب {{1}} مدفوع وما نزل نقطة البيع ({{2}}). أدخله يدوي على الكاشير الحين." },
    [{ path: "order.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "pos.error", ex: "partner token expired", exAr: "انتهت صلاحية الربط", label: "سبب الفشل (last_pos_error مختصر)" }],
    { purpose: "فشل المزامنة مع نقطة البيع", trigger: "paid_pos_failed فوري", send: "auto", fallbackSms: "staffalerts paid_pos_failed" }),
  ...staffPair("fc_staff_daily_summary",
    { body: "Fresh Cuts daily summary for {{1}}: {{2}} online orders, {{3}} SAR sales, average rating {{4}}. Details are in the dashboard.",
      ar: "ملخص فريش كاتس ليوم {{1}}: {{2}} طلب أونلاين، مبيعات {{3}} ر.س، متوسط التقييم {{4}}. التفاصيل في اللوحة." },
    [{ path: "day.label", ex: "27 Sep", exAr: "٢٧ سبتمبر", label: "اليوم التشغيلي (bizday 11→03)" },
      { path: "day.orders", ex: "14", label: "عدد الطلبات" }, { path: "day.sales", ex: "1240", label: "المبيعات", fmt: "money" },
      { path: "day.rating", ex: "4.6", label: "متوسط تقييمنا الداخلي" }],
    { purpose: "ملخص يومي", trigger: "dayreport.js بعد قفلة اليوم التشغيلي (٠٤:٠٠)", send: "auto-candidate", fallbackSms: null },
    [link("Open dashboard", "https://freshcuts-invite.o2m8.me/#store")], [link("فتح اللوحة", "https://freshcuts-invite.o2m8.me/#store")]),
  ...staffPair("fc_staff_low_rating",
    { body: "New low rating: {{1}} stars on order {{2}}. Customer note: {{3}}. Please call the customer today.",
      ar: "تقييم منخفض جديد: {{1}} نجوم على الطلب {{2}}. ملاحظة العميل: {{3}}. اتصل على العميل اليوم." },
    [{ path: "review.rating", ex: "2", label: "النجوم" }, { path: "review.order_no", ex: "W1790012345678", label: "رقم الطلب" },
      { path: "review.comment", ex: "the food arrived cold", exAr: "الأكل وصل بارد", label: "التعليق (مختصر ≤120)" }],
    { purpose: "تقييم ≤٣ نجوم", trigger: "reviews.js feedback (alertNegative)", send: "auto", fallbackSms: "reviews manager SMS" }),
  ...staffPair("fc_staff_checkout_watchdog",
    { body: "Checkout alert: {{1}}. Last successful online order was {{2}}. Please test the website now.",
      ar: "تنبيه الدفع: {{1}}. آخر طلب ناجح كان {{2}}. جرّب الموقع الحين." },
    [{ path: "watch.problem", ex: "3 payment sessions failed in 20 min", exAr: "٣ محاولات دفع فشلت خلال ٢٠ دقيقة", label: "المشكلة (checkoutwatch)" },
      { path: "watch.lastOrderAgo", ex: "95 min ago", exAr: "قبل ٩٥ دقيقة", label: "آخر طلب ناجح" }],
    { purpose: "حارس الشيك أوت", trigger: "checkoutwatch.js / ops/checkout-watch-run.mjs", send: "auto", fallbackSms: "checkoutwatch SMS" }),
  /* ١٢/١٠: ميتا صنّفت fc_staff_checkout_watchdog (ar+en) و fc_staff_daily_summary (ar) تسويق. دول صياغة تانية بأسماء جديدة:
     تنبيه/تقرير تشغيلي لحساب المطعم نفسه — بدون «جرّب الموقع» وبدون كلمة «مبيعات». القديمة باقية بأسمائها (لا تتمسح). */
  ...staffPair("fc_staff_payment_alert",
    { body: "Operations alert on the Fresh Cuts ordering system: {{1}}. Last paid order on the system: {{2}}. Follow it up from the portal.",
      ar: "تنبيه تشغيلي في نظام طلبات فريش كاتس: {{1}}. آخر طلب مدفوع على النظام: {{2}}. تابع من البورتال." },
    [{ path: "watch.problem", ex: "3 payment sessions failed in 20 min", exAr: "٣ محاولات دفع فشلت خلال ٢٠ دقيقة", label: "المشكلة (checkoutwatch)" },
      { path: "watch.lastOrderAgo", ex: "95 min ago", exAr: "قبل ٩٥ دقيقة", label: "آخر طلب ناجح" }],
    { purpose: "حارس الشيك أوت — صياغة تشغيلية", trigger: "checkoutwatch.js / ops/checkout-watch-run.mjs", send: "auto", fallbackSms: "checkoutwatch SMS",
      reclassRisk: "medium", replaces: "fc_staff_checkout_watchdog" }),
  /* SW1 (M6-4): fc_staff_checkout_watchdog اتصنّف «تسويق» عند ميتا. صياغة تالتة باسم جديد: إشعار نظام بحت، من غير أي طلب فعل ولا كلمة بيع.
     **موقوف (HOLD)** لحد ما المالك يوافق — وfc_staff_payment_alert (١٢/١٠) موجود بنفس الغرض: المالك يختار واحد. */
  ...staffPair("fc_staff_checkout_notice",
    { body: "Fresh Cuts ordering system notice: {{1}}. Last paid order: {{2}}. This is an automated operations message.",
      ar: "إشعار من نظام طلبات فريش كاتس: {{1}}. آخر طلب مدفوع: {{2}}. هذه رسالة تشغيلية آلية." },
    [{ path: "watch.problem", ex: "3 payment sessions failed in 20 min", exAr: "٣ محاولات دفع فشلت خلال ٢٠ دقيقة", label: "المشكلة (checkoutwatch)" },
      { path: "watch.lastOrderAgo", ex: "95 min ago", exAr: "قبل ٩٥ دقيقة", label: "آخر طلب ناجح" }],
    { purpose: "حارس الشيك أوت — إشعار نظام (اسم جديد)", trigger: "checkoutwatch.js / ops/checkout-watch-run.mjs", send: "auto-candidate", fallbackSms: "checkoutwatch SMS",
      reclassRisk: "medium", replaces: "fc_staff_checkout_watchdog" }),
  ...staffPair("fc_staff_day_report",
    { body: "End-of-day operations report for {{1}}: {{2}} online orders handled, {{3}} SAR collected, average customer rating {{4}}. The full report is in the dashboard.",
      ar: "تقرير إقفال اليوم التشغيلي {{1}}: عدد الطلبات الأونلاين {{2}}، المبلغ المحصّل {{3}} ر.س، متوسط التقييم {{4}}. التقرير الكامل في اللوحة." },
    [{ path: "day.label", ex: "27 Sep", exAr: "٢٧ سبتمبر", label: "اليوم التشغيلي (bizday 11→03)" },
      { path: "day.orders", ex: "14", label: "عدد الطلبات" }, { path: "day.sales", ex: "1240", label: "المبلغ المحصّل", fmt: "money" },
      { path: "day.rating", ex: "4.6", label: "متوسط تقييمنا الداخلي" }],
    { purpose: "تقرير إقفال اليوم — صياغة تشغيلية", trigger: "dayreport.js بعد قفلة اليوم التشغيلي (٠٤:٠٠)", send: "auto-candidate", fallbackSms: null,
      reclassRisk: "medium", replaces: "fc_staff_daily_summary" },
    [link("Open dashboard", "https://freshcuts-invite.o2m8.me/#store")], [link("فتح اللوحة", "https://freshcuts-invite.o2m8.me/#store")]),
  ...staffPair("fc_staff_wa_handoff",
    { body: "A WhatsApp customer needs a staff reply ({{1}}): {{2}}. Open the WhatsApp inbox in the portal.",
      ar: "عميل واتساب يحتاج رد موظف ({{1}}): {{2}}. افتح صندوق واتساب في البورتال." },
    [{ path: "handoff.reasonText", ex: "complaint", exAr: "شكوى", label: "السبب (wabot handoff.reason)" },
      { path: "handoff.summary", ex: "order W1790012345678 arrived cold", exAr: "طلب W1790012345678 وصل بارد", label: "ملخص رسالة العميل ≤120" }],
    { purpose: "تحويل من البوت لموظف (شكوى/إلغاء/طلب موظف)", trigger: "wabot action handoff (priority high فوري، normal لو ما رد أحد خلال ١٠ دقائق)",
      send: "auto", fallbackSms: "Fresh Cuts: WhatsApp customer needs a reply ({reason})" },
    [link("Open inbox", PORTAL_URL)], [link("فتح البورتال", PORTAL_URL)]),

  /* ── ٤) تسويق وعروض — MARKETING (فوتر إيقاف + زر إيقاف) ─────────────── */
  T({ name: "fc_welcome_offer", category: "MARKETING", group: "marketing", ...MKT,
    body: "أهلاً {{1}} 👋 حيّاك في فريش كاتس.\nأول طلب لك من موقعنا توصيله مجاني بكود {{2}} للطلبات من {{3}} ر.س وأكثر داخل نطاق التوصيل.\nمشاوي على الفحم، كريبات، بيتزا وباستا نطبخها طازجة عند الطلب.",
    vars: [FIRST_NAME, { path: "coupon.code", label: "كود أول طلب (shop_coupons FIRST)", ex: "FIRST" },
      { path: "coupon.min_total", label: "الحد الأدنى (shop_coupons.min_total)", ex: "60", fmt: "money" }],
    buttons: [LAND("اطلب الآن", "wa-first"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "ترحيب بعرض أول طلب", trigger: "رقم جديد ما عنده طلب موقع مدفوع (identity.js) ووافق على التسويق",
      send: "auto-candidate", fallbackSms: "حملة SMS w_recent_new", notes: "FIRST: free_delivery + once_per_customer + min 60 (من ٥/١٠)، لأول طلب توصيل — لا يغطي رسوم المسافة البعيدة" } }),

  T({ name: "fc_winback_21", category: "MARKETING", group: "marketing", ...MKT,
    body: "اشتقنا لك يا {{1}} 🔥\nصار لك فترة ما طلبت من فريش كاتس، ومشاوينا على الفحم تنتظرك. اطلب من موقعنا بأسعار المنيو الأصلية.",
    vars: [FIRST_NAME], buttons: [LAND("اطلب الآن", "wa-wb21"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "استرجاع ٢١ يوم (بدون كوبون)", trigger: "آخر طلب (أي قناة، identity.js) قبل ٢١–٤٤ يوم", send: "auto-candidate",
      fallbackSms: "w_lapsed", notes: "يحترم فجوة ٢١ يوم وقواعد smsrules (ساعات الهدوء، الموقوفين، الفريق)" } }),

  T({ name: "fc_winback_45", category: "MARKETING", group: "marketing", ...MKT,
    body: "اشتقنا لك يا {{1}} 🙌\nجهّزنا لك {{2}} على طلبك الجاي من موقع فريش كاتس بكود {{3}}، والكود صالح لين {{4}} لا يفوتك.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الميزة", ex: "توصيل مجاني" },
      { path: "coupon.code", label: "كود شخصي لمرة وحدة", ex: "WB-4Q7M" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "26 أكتوبر" }],
    buttons: [COUPON_LINK("اطلب بالكود"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "استرجاع ٤٥ يوم بكوبون شخصي", trigger: "آخر طلب قبل ٤٥–٨٩ يوم", send: "auto-candidate", fallbackSms: "w_lapsed",
      notes: "معتمد من ميتا ١٢/١٠ (id 2300518740740218) — النص والزر لا يتغيّران هنا (أي تعديل = مراجعة جديدة)" } }),

  T({ name: "fc_winback_90", category: "MARKETING", group: "marketing", ...MKT,
    body: "من زمان ما شفناك يا {{1}}!\nعشان ترجع تجرّبنا هذي هدية منّا: {{2}} على طلبك من الموقع بكود {{3}}. الكود لمرة وحدة وصالح لين {{4}} بس.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الميزة", ex: "توصيل مجاني" },
      { path: "coupon.code", label: "كود شخصي", ex: "WB-9Z2P" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "26 أكتوبر" }],
    buttons: [TRACKED("اطلب بالكود", "wa-wb90-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "آخر محاولة استرجاع ٩٠ يوم", trigger: "آخر طلب قبل ٩٠–١٨٠ يوم (مرة وحدة)", send: "auto-candidate", fallbackSms: "w_last_call" } }),

  T({ name: "fc_vip_lapsed", category: "MARKETING", group: "marketing", ...MKT,
    body: "يا هلا {{1}} ⭐ أنت من أغلى عملائنا ولاحظنا غيابك من فترة.\nجهّزنا لك {{2}} بكود خاص فيك {{3}} صالح لين {{4}}، ونتمنى نشوف طلبك قريب.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الميزة", ex: "توصيل مجاني" },
      { path: "coupon.code", label: "كود شخصي", ex: "VIP-3H8D" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "26 أكتوبر" }],
    buttons: [TRACKED("اطلب بالكود", "wa-vip-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "VIP غايب", trigger: "أعلى ١٠٪ إنفاق (customer360) وآخر طلب قبل ≥٣٠ يوم", send: "manual", fallbackSms: null } }),

  T({ name: "fc_fav_dish", category: "MARKETING", group: "marketing", ...MKT,
    body: "مشتهي {{1}} اليوم؟ 😋\nطلبته منّا قبل، وهو متوفر الحين بـ{{2}} ر.س في موقع فريش كاتس. اطلبه بضغطة ويوصلك حار.",
    vars: [{ path: "dish.name", label: "الطبق المفضّل (أكثر صنف طلبه — من المنيو الحي فقط)", ex: "وجبة ميكس جريل" },
      { path: "dish.price", label: "السعر الحي من /api/menu", ex: "37", fmt: "money" }],
    buttons: [TRACKED("اطلبه الآن", "wa-fav-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "توصية بالطبق المفضّل", trigger: "ts_order_items/shop_orders — الصنف الأكثر للعميل، بشرط موجود في المنيو الحي ومش «خلص»",
      send: "auto-candidate", fallbackSms: null, notes: "الحارس: لو الصنف مش في المنيو الحي أو السعر اختلف ⇒ لا ترسل" } }),

  T({ name: "fc_new_item", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "جديد في فريش كاتس 🔥\nجرّب {{1}}: {{2}}.\nالسعر {{3}} ر.س ومتوفر الحين في الموقع.",
    vars: [{ path: "item.name", label: "اسم الصنف (المنيو الحي)", ex: "طاسة كرانشي" },
      { path: "item.description", label: "الوصف من المنيو ≤120", ex: "طاسة جبن مع سترِبس دجاج ورومي مدخن" },
      { path: "item.price", label: "السعر الحي", ex: "38", fmt: "money" }],
    buttons: [TRACKED("اطلبه الآن", "wa-new-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "إطلاق صنف جديد (صورة)", trigger: "يدوي من اللوحة عند إضافة صنف", send: "manual", fallbackSms: null,
      notes: "الصورة: صورة الصنف الحقيقية من المنيو (قرار ١٨/٩: بدون نص/سعر داخل الصورة)" } }),

  T({ name: "fc_weekend_offer", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "عرض نهاية الأسبوع في فريش كاتس 🎉\n{{1}} بـ{{2}} ر.س، والعرض لين {{3}} فقط. اطلبه من الموقع للتوصيل أو الاستلام.",
    vars: [{ path: "offer.title", label: "عنوان العرض (offer_registry)", ex: "باقة تجمّع ٤–٦ أشخاص" },
      { path: "offer.price", label: "السعر", ex: "225", fmt: "money" }, { path: "offer.untilText", label: "آخر يوم", ex: "السبت" }],
    buttons: [TRACKED("شوف العرض", "wa-weekend-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "عرض الويكند (صورة)", trigger: "الخميس ١٦:٠٠ لعرض شغّال في offer_registry (enabled + التاريخ + قناة delivery)",
      send: "manual", fallbackSms: null, notes: "offers-cache-chain: تأكد العرض enabled في offer_registry مو بس الباقة" } }),

  T({ name: "fc_bundle_offer", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "لمّة الأهل والأصحاب؟ 🍢\n{{1}} بـ{{2}} ر.س وفيها {{3}}.\nاطلبها من الموقع للتوصيل أو الاستلام.",
    vars: [{ path: "offer.title", label: "اسم الباقة", ex: "باقة تجمّع ٨–١٠ أشخاص" }, { path: "offer.price", label: "السعر", ex: "395", fmt: "money" },
      { path: "offer.line", label: "المحتوى — وصف الباقة كما هو في اللوحة (cms_bundles.description)", ex: "مشاوي على الفحم مع الأرز والبطاطس والكولسلو والمشروبات" }],
    buttons: [TRACKED("كوّن الباقة", "wa-bundle-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "عرض الباقات/البوكس (صورة)", trigger: "يدوي أو شريحة «طلبات كبيرة»", send: "manual", fallbackSms: null,
      notes: "المحتوى من offer_registry كما هو — لا نضيف عدد أشخاص لأي صنف بالوزن («مشكل مخصوص» خصوصاً)" } }),

  /* ── OF1 (١٣/١٠) + FR1: «إطارات» العروض — كلام ثابت قليل حوالين متغيرات، والصورة/الفيديو والرابط بيتغيروا مع كل إرسال.
     بتتعتمد مرة واحدة وبعدها أي عرض جديد من مكتبة العروض (waoffers.js) بيتبعت بيها من غير اعتماد جديد.
     قواعد ميتا المتراعاة: مفيش متغير في أول ولا آخر النص، مفيش متغيرين ملزوقين، وكلام ثابت كفاية حوالين المتغيرات.
     FR1 (قرار عمر ١٣/١٠ «ابدا على طول»): الصياغة اتوافق عليها ⇒ خرجت من HOLD، اتضاف زر رد «أبغى أطلب» (بيفتح نافذة
     المحادثة والبوت بيفهمه كطلب)، ونسخة إنجليزي لكل إطار. ترتيب الأزرار: الرابط، وبعده أزرار الرد مع بعض (شرط ميتا). ── */
  ...FRAMES_DEF.flatMap((f) => [
    T({ name: f.name, category: "MARKETING", group: "marketing", ...MKT, header: f.header, body: f.ar, vars: f.vars,
      /* TS1 (١٤/١٠ — قرار عمر: «بالنسبة لإيقاف نخلي العميل يكتبها، متكونش زرار»): الإطارات الستة من غير زر «إيقاف».
         سطر الفوتر «للإيقاف ردّ: إيقاف» باقي، والكلمة المكتوبة شغّالة زي ما هي (الويب هوك). باقي القوالب التسويقية زي ما هي. */
      buttons: [TRACKED(f.btnAr, "wa-offer-ab12cd"), qr(ORDER_BUTTON)],
      meta: { purpose: f.purpose, trigger: "مكتبة عروض واتساب ← حملة", send: "manual", fallbackSms: null, stopButton: false, notes: f.notes } }),
    T({ name: f.name, category: "MARKETING", group: "marketing", language: "en", footer: OPTOUT_FOOTER_EN, header: f.header, body: f.en, vars: f.varsEn,
      buttons: [TRACKED(f.btnEn, "wa-offer-ab12cd"), qr(ORDER_BUTTON_EN)],
      meta: { purpose: `${f.purpose} (English)`, trigger: "مكتبة عروض واتساب ← حملة", send: "manual", fallbackSms: null, stopButton: false, notes: f.notes } }),
  ]),

  /* RF1 (١٤/١٠ — ملاحظة عمر على أول موجة: «لازم نخلي العميل يبدأ يتكلم معانا»): إطارات «الرد أولاً».
     الفعل الأساسي = رد (بيفتح نافذة الـ٢٤ ساعة المجانية والمساعد يكمّل البيع في المحادثة) مش رابط: **مفيش زر رابط خالص** — ٣ أزرار رد سريع بس:
     «أبغى أطلب» · «ورّني المنيو» · «إيقاف». نفس متغيّرات إطار الفيديو/الخبر المعتمدين ({{1}} العنوان، {{2}} التفاصيل)، سطر افتتاح ثابت وسؤال ختام ثابت.
     قابلة للتقديم (مش HOLD). */
  ...ASK_FRAMES_DEF.flatMap((f) => [
    T({ name: f.name, category: "MARKETING", group: "marketing", ...MKT, header: f.header, body: f.ar, vars: f.vars,
      buttons: [qr(ORDER_BUTTON), qr(MENU_BUTTON)],
      meta: { purpose: f.purpose, trigger: "مكتبة عروض واتساب ← حملة (الرد أولاً)", send: "manual", fallbackSms: null, replyFirst: true, stopButton: false, notes: f.notes } }),
    T({ name: f.name, category: "MARKETING", group: "marketing", language: "en", footer: OPTOUT_FOOTER_EN, header: f.header, body: f.en, vars: f.varsEn,
      buttons: [qr(ORDER_BUTTON_EN), qr(MENU_BUTTON_EN)],
      meta: { purpose: `${f.purpose} (English)`, trigger: "مكتبة عروض واتساب ← حملة (الرد أولاً)", send: "manual", fallbackSms: null, replyFirst: true, stopButton: false, notes: f.notes } }),
  ]),

  T({ name: "fc_cart_1h", category: "MARKETING", group: "marketing", ...MKT,
    body: "سلتك في فريش كاتس محفوظة 🛒\nكمّل طلبك بضغطة من الرابط، ولو عندك سؤال ردّ علينا هنا.",
    buttons: [CART(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "سلة متروكة — الخطوة ١", trigger: "carts.js sms1AfterMinutes (٣٥ د) — واتساب بدل SMS لو الرقم عنده موافقة",
      send: "auto", fallbackSms: "cart.sms1", existing: "whatsapp.js fc_cart_reminder (نص أقدم، رابط ?resume=)" } }),

  T({ name: "fc_cart_24h", category: "MARKETING", group: "marketing", ...MKT,
    body: "لسا طلبك ينتظرك في سلة فريش كاتس 😋\nكمّل الحين من الرابط ونبدأ نجهّزه لك طازج.",
    buttons: [CART(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "سلة متروكة — الخطوة ٢ (عميل قديم)", trigger: "carts.js sms2 (تاني يوم ١٧:٠٠، سلة ≥ ٦٠)", send: "auto", fallbackSms: "cart.sms2" } }),

  T({ name: "fc_cart_24h_first", category: "MARKETING", group: "marketing", ...MKT,
    body: "لسا طلبك ينتظرك في سلة فريش كاتس 😋\nوبما إنه أول طلب لك من الموقع، التوصيل مجاني بكود {{1}} للطلبات من {{2}} ر.س وأكثر داخل نطاق التوصيل.",
    vars: [{ path: "coupon.code", label: "كود أول طلب", ex: "FIRST" }, { path: "coupon.min_total", label: "الحد الأدنى (shop_coupons.min_total)", ex: "60", fmt: "money" }],
    buttons: [CART(), qr(OPTOUT_BUTTON)],
    meta: { purpose: "سلة متروكة — الخطوة ٢ (عميل جديد)", trigger: "carts.js sms2_first", send: "auto", fallbackSms: "cart.sms2_first" } }),

  T({ name: "fc_birthday", category: "MARKETING", group: "marketing", ...MKT,
    body: "كل عام وأنت بخير يا {{1}} 🎂\nهديتك من فريش كاتس: {{2}} بكود {{3}}، صالح لين {{4}} على طلبك من الموقع.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الهدية", ex: "توصيل مجاني" },
      { path: "coupon.code", label: "كود شخصي", ex: "BD-6T1R" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "26 أكتوبر" }],
    buttons: [TRACKED("استخدم الهدية", "wa-bd-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "عيد ميلاد (قالب جاهز)", trigger: "لا يوجد تاريخ ميلاد في بياناتنا حالياً — placeholder", send: "manual", fallbackSms: null,
      needsOmar: "هل نجمع تاريخ الميلاد؟" } }),

  T({ name: "fc_occasion", category: "MARKETING", group: "marketing", ...MKT, header: { image: true },
    body: "بمناسبة {{1}} نقول لك كل عام وأنت بخير 🎉\nجهّزنا لك {{2}} على طلبك من موقع فريش كاتس لين {{3}}.",
    vars: [{ path: "occasion.name", label: "المناسبة", ex: "اليوم الوطني" }, { path: "occasion.offerText", label: "العرض (من offer_registry — عرض شغّال فعلاً)", ex: "توصيل مجاني للطلبات من 60 ر.س" },
      { path: "occasion.untilText", label: "آخر يوم", ex: "26 أكتوبر" }],
    buttons: [TRACKED("اطلب الآن", "wa-occasion"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "مناسبة وطنية/موسمية عامة", trigger: "يدوي", send: "manual", fallbackSms: null,
      notes: "اليوم الوطني: الهوية الرسمية (saudi-national-day-identity). رمضان/العيد: نفس القالب" } }),

  T({ name: "fc_review_thanks_coupon", category: "MARKETING", group: "marketing", ...MKT,
    body: "شكراً {{1}} على ملاحظتك لفريش كاتس 🙏\nكلامك يوصل للفريق كامل، وهذي هدية بسيطة لطلبك الجاي: {{2}} بكود {{3}} على طلبك من الموقع.",
    vars: [FIRST_NAME, { path: "coupon.benefitText", label: "الهدية", ex: "توصيل مجاني" }, { path: "coupon.code", label: "كود شخصي", ex: "TY-2M5W" }],
    buttons: [TRACKED("استخدم الهدية", "wa-ty-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "شكر على الملاحظة الداخلية", trigger: "يدوي من صندوق التقييمات بعد حل المشكلة", send: "manual", fallbackSms: null,
      notes: "للملاحظات الداخلية بس — لا ترسله مقابل تقييم جوجل (سياسة جوجل تمنع الحوافز)" } }),

  T({ name: "fc_referral_invite", category: "MARKETING", group: "marketing", ...MKT,
    body: "يا هلا {{1}} 👋 عندك صديق يحب المشاوي؟\nشارك معه كودك {{2}} ويحصل على {{3}} في أول طلب له من موقع فريش كاتس.",
    vars: [FIRST_NAME, { path: "referral.code", label: "كود السفير (batches)", ex: "AMB-OMAR" }, { path: "referral.benefitText", label: "ميزة الصديق", ex: "توصيل مجاني" }],
    buttons: [TRACKED("افتح رابطك", "wa-ref-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "دعوة صديق / سفير", trigger: "يدوي أو بعد ٣ طلبات ناجحة", send: "manual", fallbackSms: null,
      needsOmar: "برنامج الإحالة — المكافأة وقواعدها" } }),

  T({ name: "fc_try_website", category: "MARKETING", group: "marketing", ...MKT,
    body: "شكراً إنك اخترت فريش كاتس 🙏\nتقدر الحين تطلب مباشرة من موقعنا بأسعار المنيو الأصلية، وأول طلب توصيله مجاني بكود {{1}} للطلبات من {{2}} ر.س وأكثر.",
    vars: [{ path: "coupon.code", label: "كود أول طلب", ex: "FIRST" }, { path: "coupon.min_total", label: "الحد الأدنى", ex: "60", fmt: "money" }],
    buttons: [LAND("جرّب الموقع", "wa-site"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "تحويل عملاء الصالة/التطبيقات للموقع", trigger: "رقم له طلبات POS/كيتا وما له طلب موقع (O6 app segments)",
      send: "auto-candidate", fallbackSms: "k_app_* waves", notes: "لا «أرخص من التطبيقات» — الحارس مقفول" } }),

  T({ name: "fc_one_time_coupon", category: "MARKETING", group: "marketing", ...MKT,
    body: "يا هلا {{1}} 🎁\nهذا كود خاص فيك لمرة وحدة {{2}} ويعطيك {{3}} على طلبك من موقع فريش كاتس، صالح لين {{4}} فقط.",
    vars: [FIRST_NAME, { path: "coupon.code", label: "كود مقفول على الجوال (shop_coupons.phone_norm)", ex: "WA-7K2Q" },
      { path: "coupon.benefitText", label: "الميزة", ex: "توصيل مجاني" }, { path: "coupon.expiresText", label: "الانتهاء", ex: "26 أكتوبر" }],
    buttons: [TRACKED("استخدم الكود", "wa-otc-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "كوبون شخصي لمرة وحدة", trigger: "wasender.js عروض واتساب (مرة لكل عميل)", send: "auto-candidate", fallbackSms: null } }),

  /* ── ٥) إعلانات «راسلنا على واتساب» ─────────────────────────────────── */
  T({ name: "fc_ad_lead_followup", category: "MARKETING", group: "ads", ...MKT,
    body: "أهلاً {{1}} 👋 تواصلت معنا من إعلان فريش كاتس.\nالمنيو كامل بأسعاره في موقعنا، وأول طلب توصيله مجاني بكود {{2}} للطلبات من {{3}} ر.س وأكثر داخل نطاق التوصيل.",
    vars: [FIRST_NAME, { path: "coupon.code", label: "كود أول طلب", ex: "FIRST" }, { path: "coupon.min_total", label: "الحد الأدنى (shop_coupons.min_total)", ex: "60", fmt: "money" }],
    buttons: [LAND("شوف المنيو", "wa-ad"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "متابعة عميل إعلان ما طلب (بعد قفل نافذة ٢٤ ساعة)", trigger: "wa conversation بـreferral، بدون طلب خلال ٢٤–٤٨ ساعة",
      send: "auto-candidate", fallbackSms: null } }),

  T({ name: "fc_ad_lead_last_call", category: "MARKETING", group: "ads", ...MKT,
    body: "آخر تذكير منّا يا {{1}} 😊\nعرض {{2}} لسا شغّال لين {{3}}، ولو عندك أي سؤال ردّ هنا ونخدمك.",
    vars: [FIRST_NAME, { path: "offer.title", label: "العرض الشغّال", ex: "باقة تجمّع ٤–٦ أشخاص" }, { path: "offer.untilText", label: "آخر يوم", ex: "26 أكتوبر" }],
    buttons: [TRACKED("شوف العرض", "wa-ad2-ab12cd"), qr(OPTOUT_BUTTON)],
    meta: { purpose: "آخر محاولة لعميل الإعلان", trigger: "بعد ٧٢ ساعة من fc_ad_lead_followup بدون طلب — مرة وحدة", send: "auto-candidate", fallbackSms: null } }),
];

/* قوالب الفريق: نفس الاسم بلغتين (en افتراضي، ar لو staffSmsLanguage="ar") */
function staffPair(name, texts, vars, meta, buttonsEn = [link("Open portal", PORTAL_URL)], buttonsAr = [link("فتح البورتال", PORTAL_URL)]) {
  const m = { ...meta, audience: "staff", langSetting: "settings.delivery.staffSmsLanguage" };
  return [
    T({ name, category: "UTILITY", group: "staff", language: "en", body: texts.body, vars, buttons: buttonsEn, meta: m }),
    T({ name, category: "UTILITY", group: "staff", language: "ar", body: texts.ar,
      vars: vars.map((v) => ({ ...v, ex: v.exAr || v.ex })), buttons: buttonsAr, meta: m }),
  ];
}

/* ══ ST1 (١٢/١٠) — تواصل الفريق على واتساب (wateam.js) ═══════════════════════════════════════════
   بلوك مستقل: قالبين للفريق بيتضافوا على الكتالوج هنا (مش جوّه القايمة فوق) عشان مايتعارضوش مع أي تعديل في قوالب العملاء.
   الاتنين UTILITY، للموظفين بس (الحارس بيرفض أي رقم مش في دليل الفريق: not_staff)، وفيهم زر رد واحد «جدّد التنبيهات»:
   ضغطته رسالة واردة ⇒ نافذة الـ٢٤ ساعة بتاعة الموظف بتتفتح والتنبيهات اللي بعدها بتوصله حرة ببلاش.
   نص القالبين العربي فصحى مبسّطة زي باقي قوالب الكتالوج (بيتراجع من ميتا، واختبار الكتالوج بيرفض العامية المصرية) — الرسايل الحرة للفريق هي اللي بالمصري.
   زر القالب من غير إيموجي (ميتا بترفض الإيموجي في أزرار القوالب) — زر الرسالة الحرة هو «✅ جدّد التنبيهات».
     • fc_staff_alerts_renew  — النافذة قفلت: مرة واحدة لكل قفلة، وبعدها نستنى الضغطة.
     • fc_staff_team_notice   — تنبيه (تحويل لموظف / حاجة غريبة / الملخص) لموظف نافذته مقفولة: سطر واحد من غير نص العميل. */
export const STAFF_RENEW_BUTTON = "جدّد التنبيهات";
export const STAFF_RENEW_BUTTON_EN = "Renew alerts";
TEMPLATES.push(
  ...staffPair("fc_staff_alerts_renew",
    { body: "Fresh Cuts team alerts: WhatsApp alerts for your number are paused because the chat window has closed. Tap the button below to keep receiving team alerts here. This is an automated operations message.",
      ar: "تنبيهات فريق فريش كاتس: تنبيهات واتساب لرقمك متوقفة حالياً لأن نافذة المحادثة أُغلقت. اضغط الزر بالأسفل لتستمر تنبيهات الفريق في الوصول إليك هنا. هذه رسالة تشغيلية آلية." },
    [],
    { purpose: "تجديد نافذة تنبيهات الموظف (حارس النافذة)", trigger: "wateam.js keeper — نافذة الموظف قفلت؛ مرة واحدة لكل قفلة", send: "auto",
      fallbackSms: "Fresh Cuts: your WhatsApp alerts are paused. Send the word ALERTS to the restaurant WhatsApp number" },
    [qr(STAFF_RENEW_BUTTON_EN)], [qr(STAFF_RENEW_BUTTON)]),
  ...staffPair("fc_staff_team_notice",
    { body: "Fresh Cuts team notice from the WhatsApp chat system: {{1}}. Open the WhatsApp inbox for the details. This is an automated operations message.",
      ar: "تنبيه لفريق فريش كاتس من نظام محادثات واتساب: {{1}}. افتح صندوق المحادثات للتفاصيل. هذه رسالة تشغيلية آلية." },
    [{ path: "notice.text", ex: "a customer ending 5678 needs a staff reply (complaint)", exAr: "عميل آخر رقمه 5678 محتاج موظف (شكوى)", label: "سطر التنبيه ≤120 (آخر ٤ أرقام بس، من غير نص العميل)" }],
    { purpose: "تنبيه فريق لموظف نافذته مقفولة (تحويل / حاجة غريبة / ملخص)", trigger: "wateam.js sendToStaff — النافذة مقفولة والقالب معتمد", send: "auto",
      fallbackSms: "Fresh Cuts WhatsApp: customer needs staff ({reason})" },
    [qr(STAFF_RENEW_BUTTON_EN), link("Open portal", PORTAL_URL)], [qr(STAFF_RENEW_BUTTON), link("فتح البورتال", PORTAL_URL)]),
);

/* ══ UT1 (١٩/١٠ — عمر: «نستفيد من الرسايل الخدمية … بدل التسويقية») — بدايل خدمية لـfc_staff_team_notice و fc_staff_alerts_renew ═══════════
   ميتا حوّلت الاتنين لـMARKETING بعد اعتمادهم (previous_category=UTILITY): بيتحاسبوا ٠٫٢٢ ر.س بدل ٠٫٠٤، ومن ١٣ لـ١٦/١٠ اتمنعت ٥٧ رسالة من ٧٦
   بخطأ 131049 (حد ميتا لرسايل التسويق لكل رقم) — يعني تنبيهات فريق ماوصلتش أصلاً. السبب الأرجح: سطر حر {{1}} يحتمل أي كلام + زر رد سريع
   «جدّد التنبيهات» (شكل إعادة اشتراك). كل القوالب الخدمية المعتمدة للفريق: حدث محدد بمرجع (رقم طلب/عميل/وقت) + زر رابط بس.
   فالبدايل هنا بنفس الشكل: كل قالب لحدث واحد الموظف شغّال عليه، بمرجع (آخر ٤ أرقام / اسم البوابة / الساعة)، من غير كلام ترويجي، من غير زر رد سريع،
   والتجديد بكلمة «تنبيهات» المكتوبة (staffCommand بيفهمها من زمان). فصحى مبسّطة + إنجليزي (staffPair). */
TEMPLATES.push(
  ...staffPair("fc_staff_portal_offline",
    { body: "Fresh Cuts shift alert: the {{1}} portal has been closed since {{2}}. Open it so new orders and customer chats ring at the restaurant.",
      ar: "تنبيه وردية فريش كاتس: بوابة {{1}} مغلقة منذ الساعة {{2}}. افتحها حتى تصل الطلبات الجديدة ومحادثات العملاء إلى المطعم." },
    [{ path: "portal.name", ex: "cashier", exAr: "الكاشير", label: "البوابة (الكاشير)" },
      { path: "portal.since", ex: "21:05", label: "من الساعة كام (بتوقيت الرياض HH:MM)" }],
    { purpose: "بوابة الكاشير مقفولة وقت الشغل (للكاشير ثم المدير)", trigger: "wateam.js portalWatch — النافذة مقفولة والإشعار مش على البورتال", send: "auto",
      replaces: "fc_staff_team_notice", fallbackSms: null }),
  ...staffPair("fc_staff_chat_review",
    { body: "Fresh Cuts WhatsApp inbox: the chat with the customer ending {{1}} needs a staff review ({{2}}). Open the inbox in the portal to follow it up.",
      ar: "صندوق محادثات واتساب لفريش كاتس: محادثة العميل المنتهي رقمه بـ {{1}} تحتاج مراجعة من الفريق ({{2}}). افتح صندوق المحادثات في البورتال لمتابعتها." },
    [{ path: "chat.ref4", ex: "5678", label: "آخر ٤ أرقام من جوال العميل" },
      { path: "chat.reason", ex: "complaint", exAr: "شكوى", label: "النوع (ODD_KINDS)" }],
    { purpose: "حاجة غريبة في محادثة عميل (شكوى / مشكلة دفع / سؤال وصفة …)", trigger: "wateam.js odd — محادثة عميل محددة", send: "auto",
      replaces: "fc_staff_team_notice", fallbackSms: null }),
  ...staffPair("fc_staff_inbox_summary",
    { body: "Fresh Cuts WhatsApp inbox summary up to {{1}}: {{2}} chats handed to staff and {{3}} other alerts. The details are in the inbox on the portal.",
      ar: "ملخص صندوق محادثات واتساب لفريش كاتس حتى الساعة {{1}}: عدد التحويلات لموظف {{2}}، وعدد التنبيهات الأخرى {{3}}. التفاصيل في صندوق المحادثات على البورتال." },
    [{ path: "inbox.at", ex: "23:40", label: "الساعة (بتوقيت الرياض HH:MM)" },
      { path: "inbox.handovers", ex: "4", label: "عدد التحويلات لموظف" }, { path: "inbox.alerts", ex: "2", label: "عدد التنبيهات التانية" }],
    { purpose: "ملخص الصندوق (الملخص اليومي / ملخص الحاجات الغريبة / تنبيه نظام من غير عميل / زر التجربة)", trigger: "wateam.js dailyDigest + flushOdd + odd من غير جوال + /team/test", send: "auto",
      replaces: "fc_staff_team_notice", fallbackSms: null }),
  ...staffPair("fc_staff_task_notice",
    { body: "Fresh Cuts management sent you a work message for your role ({{1}}) at {{2}}. Send the word ALERTS in this chat to receive the full text here.",
      ar: "أرسلت لك إدارة فريش كاتس رسالة عمل تخص دورك ({{1}}) الساعة {{2}}. أرسل كلمة «تنبيهات» في هذه المحادثة لتصلك الرسالة كاملة هنا." },
    [{ path: "task.role", ex: "social media", exAr: "السوشيال ميديا", label: "دور الموظف" },
      { path: "task.at", ex: "14:20", label: "وقت الرسالة (بتوقيت الرياض HH:MM)" }],
    { purpose: "رسالة المالك لموظف واحد ونافذته مقفولة — إشعار بوجود الرسالة من غير نصها", trigger: "wateam.js POST /api/cms/wabot/team/send", send: "auto",
      replaces: "fc_staff_team_notice", fallbackSms: null }),
  ...staffPair("fc_staff_alerts_paused",
    { body: "Your Fresh Cuts team WhatsApp alerts ({{1}}) have been paused since {{2}} because the chat window closed. Send the word ALERTS in this chat to resume them.",
      ar: "تنبيهات واتساب الخاصة بك في فريق فريش كاتس ({{1}}) متوقفة منذ الساعة {{2}} بسبب إغلاق نافذة المحادثة. أرسل كلمة «تنبيهات» في هذه المحادثة لاستئنافها." },
    [{ path: "member.role", ex: "cashier", exAr: "الكاشير", label: "دور الموظف" },
      { path: "paused.at", ex: "20:15", label: "النافذة قفلت الساعة (بتوقيت الرياض HH:MM)" }],
    { purpose: "تنبيهات الموظف وقفت (النافذة قفلت) — حالة حسابه في نظام التنبيهات", trigger: "wateam.js keeperFor — مرة واحدة لكل قفلة", send: "auto",
      replaces: "fc_staff_alerts_renew", fallbackSms: "Fresh Cuts: your WhatsApp alerts are paused. Send the word ALERTS to the restaurant WhatsApp number" }),
);
/* ══ UT2 (١٩/١٠ — عمر: «كل الى نقدر نحوله خدمي خلينا نحاول ناخد عليه موافقة انه خدمي … ونتابع ميتا ونغيره») ═══════════════════════════════
   بدايل خدمية بأسماء جديدة لقوالب خدمة ميتا صنّفتها تسويق. القديم مابيتعدّلش (معتمد وشغّال) — المُرسل بيفضل عليه لحد ما الجديد يبقى APPROVED
   **وفئته الحيّة عند ميتا UTILITY** (warewrite.js + whatsapp.js resolveRewrite)، ولو ميتا صنّفت الجديد تسويق أو رفضته بيفضل القديم وبيتسجّل.
   القواعد اللي اتكتبت بيها (docs/designs-2026-10/whatsapp/meta-approval-rules.md — من تاريخ قوالبنا عند ميتا):
     • الجملة الأولى = المعاملة نفسها بمرجع ثابت في النص قبل المتغيّر («طلبك رقم {{1}}»، «طلب التنبيه رقم {{1}}»، «الساعة {{1}}») — مفيش متغيّر حر يحتمل أي كلام.
     • من غير شكر/ترحيب/اسم المطعم في الأول، من غير «جرّب/تفضّل/اطلب»، من غير إيموجي في سؤال التقييم.
     • الأزرار: ردود سريعة بس لو هي إجابة على المعاملة (تقييم)، أو زر رابط للبورتال للفريق — مفيش زر «جدّد/اشترك».
     • لغة واحدة بس للي محتاجينه (المصنِّف بتاع ميتا بيدّي نفس المعنى فئتين مختلفتين بين العربي والإنجليزي). */
TEMPLATES.push(
  /* بديل fc_review_stars (ميتا صنّفته MARKETING ١٦/١٠، previous_category=UTILITY): {{1}} = رقم يعرفه العميل (W… / رقم فاتورة الكاشير / رقم فاتورة طلب كيتا)
     بدل «زيارتك للمطعم» الحرة، و{{2}} = تاريخ الطلب. نفس الأزرار بالحرف (wareviews.starOfQr بيقرا نص الزر). شكل fc_review_request_v2 المعتمد خدمي. */
  T({ name: "fc_review_order_v3", category: "UTILITY", group: "order",
    body: "تقييم طلبك رقم {{1}} من فريش كاتس بتاريخ {{2}}: كيف كانت تجربتك مع هذا الطلب؟ اختر تقييمك من الأزرار.",
    vars: [{ path: "review.ref", label: "رقم الطلب اللي العميل يعرفه (W… / رقم الفاتورة)", ex: "W1790012345678" },
      { path: "review.dateText", label: "تاريخ الطلب بتوقيت الرياض d/m/yyyy", ex: "18/10/2026" }],
    buttons: STAR_BUTTONS.map((b) => qr(b.text)),
    meta: { purpose: "طلب التقييم بالنجوم بره النافذة — مرتبط بطلب محدد برقمه وتاريخه", trigger: "wabotrun.reviewAsk مكان fc_review_stars لما الجديد APPROVED + UTILITY (UT2)",
      send: "auto-candidate", replaces: "fc_review_stars", fallbackSms: "review.invite",
      notes: "مفيش رقم معروف للطلب ⇒ مايتبعتش (القديم/الـSMS زي ما هو). ميتا: الاستبيان خدمي «لو مرتبط بطلب أو تعامل محدد»." } }),
  /* بديل fc_waitlist_open (تسويق بطبيعته: سلة + رابط) — نسخة خدمية تانية من fc_open_notice (مااتقدّمش أبداً): تحديث حالة طلب التنبيه نفسه
     («وبهذا اكتمل طلب التنبيه»)، من غير «يستقبل الطلبات»، من غير إيموجي ولا زر. مش مربوط: التنبيه النهارده SMS + إشعار (openwait.js). */
  T({ name: "fc_open_request_update", category: "UTILITY", group: "order",
    body: "تحديث طلب التنبيه رقم {{1}} المسجَّل {{2}}: فريش كاتس مفتوح الآن حتى الساعة {{3}}، وبهذا اكتمل طلب التنبيه.",
    vars: [{ path: "waitlist.ref", label: "مرجع طلب التنبيه (open_waitlist.id ⇒ N-<id>)", ex: "N-1042" },
      { path: "waitlist.requestedText", label: "وقت تسجيل طلب التنبيه بتوقيت الرياض", ex: "يوم 12/10 الساعة 4:35 ص" },
      { path: "hours.closeText", label: "وقت الإقفال اليوم (settings.hours)", ex: "2:00 ص" }],
    meta: { purpose: "«نبّهني لما تفتحوا» — تحديث حالة طلب التنبيه اللي العميل سجّله (رقمه ووقته)", trigger: "openwait.js عند الفتح — غير مربوط (القناة النهارده SMS + إشعار)",
      send: "auto-candidate", replaces: "fc_waitlist_open", fallbackSms: "waitlist.open", pairedWith: "fc_waitlist_open",
      notes: "UT2: يتربط لما المالك يقرر واتساب لتنبيه الفتح (openNoticeData جاهزة بنفس المتغيّرات)." } }),
  /* بديل fc_staff_inbox_summary:ar (ميتا: ar = MARKETING و en = UTILITY لنفس المعنى). «تنبيه» بعدد حاجات مستنية متابعة بدل «ملخص». نفس مسارات البيانات (inboxData). */
  T({ name: "fc_staff_inbox_alert", category: "UTILITY", group: "staff", language: "ar",
    body: "تنبيه صندوق محادثات واتساب في فريش كاتس الساعة {{1}}: {{2}} محادثة محوّلة لموظف و{{3}} تنبيه آخر بانتظار المتابعة. افتح صندوق المحادثات في البورتال.",
    vars: [{ path: "inbox.at", label: "الساعة (بتوقيت الرياض HH:MM)", ex: "23:40" },
      { path: "inbox.handovers", label: "عدد التحويلات لموظف", ex: "4" }, { path: "inbox.alerts", label: "عدد التنبيهات التانية", ex: "2" }],
    buttons: [link("فتح البورتال", PORTAL_URL)],
    meta: { purpose: "تنبيه الصندوق بعدد المحادثات المحوّلة والتنبيهات المستنية", trigger: "wateam.js — مكان fc_staff_inbox_summary:ar لما الجديد APPROVED + UTILITY (UT2)", send: "auto",
      replaces: "fc_staff_inbox_summary", audience: "staff", fallbackSms: null } }),
  /* بديل fc_staff_task_notice:en (ميتا: en = MARKETING و ar = UTILITY). wateam بيبعت عربي دلوقتي ⇒ ده للموظف اللي لغته إنجليزي لو اتربط. */
  T({ name: "fc_staff_task_alert", category: "UTILITY", group: "staff", language: "en",
    body: "Fresh Cuts staff account ({{1}}): a work message from the restaurant management has been waiting for you since {{2}}. Send the word ALERTS in this chat to receive it here.",
    vars: [{ path: "task.role", label: "Staff role", ex: "social media" }, { path: "task.at", label: "Message time (Riyadh HH:MM)", ex: "14:20" }],
    buttons: [link("Open portal", PORTAL_URL)],
    meta: { purpose: "Owner's work message waiting for one staff member (window closed) — notice only, not the text", trigger: "wateam.js — instead of fc_staff_task_notice:en when APPROVED + UTILITY (UT2)", send: "auto",
      replaces: "fc_staff_task_notice", audience: "staff", fallbackSms: null } }),
  /* بديل fc_staff_checkout_watchdog:ar (ميتا: «جرّب الموقع الحين» ⇒ MARKETING؛ الإنجليزي رجع UTILITY بعد المراجعة). حدث دفع + آخر طلب مدفوع، من غير «جرّب».
     مش مربوط: حارس الشيك أوت بيبعت SMS (staffalerts.js) مش واتساب. */
  T({ name: "fc_staff_payment_notice", category: "UTILITY", group: "staff", language: "ar",
    body: "تنبيه الدفع في موقع فريش كاتس: {{1}}، وآخر طلب مدفوع على النظام كان {{2}}. افتح البورتال لمتابعة عمليات الدفع.",
    vars: [{ path: "watch.problem", label: "المشكلة (checkoutwatch)", ex: "٣ محاولات دفع فشلت خلال ٢٠ دقيقة" },
      { path: "watch.lastOrderAgo", label: "آخر طلب ناجح", ex: "قبل ٩٥ دقيقة" }],
    buttons: [link("فتح البورتال", PORTAL_URL)],
    meta: { purpose: "حارس الشيك أوت — تنبيه دفع للفريق", trigger: "غير مربوط (checkoutwatch.js بيبعت SMS عن طريق staffalerts.js)", send: "auto-candidate",
      replaces: "fc_staff_checkout_watchdog", audience: "staff", fallbackSms: "checkoutwatch SMS" } }),
);
/* UT1: أسماء الأدوار في متغيّرات القوالب (من غير أقواس ولا شرح — ROLE_AR في wateam فيه «(مهام يدوية)») */
export const STAFF_ROLE_TPL = Object.freeze({
  ar: Object.freeze({ cashier: "الكاشير", manager: "المدير", owner: "المالك", social: "السوشيال ميديا" }),
  en: Object.freeze({ cashier: "cashier", manager: "manager", owner: "owner", social: "social media" }),
});

/* ── مراجعة ١٢/١٠/٢٠٢٦ (كل القوالب، قبل التقديم) ─────────────────────────────
   HOLD = قوالب **لا تُقدَّم** لميتا الآن، وكل واحد بسببه. مسار التقديم (whatsapp.js) يرفضها بـ«held»
   إلا بـ force:true من المالك. الباقي يتقدّم على دفعات SUBMIT_BATCHES بالترتيب، واحد في الطلب. */
export const HOLD = Object.freeze({
  fc_birthday: "لا يوجد تاريخ ميلاد في بياناتنا — لا شيء يطلقه",
  fc_referral_invite: "برنامج الإحالة غير معرَّف (المكافأة والقواعد) — النص يعد بميزة لا يصدرها النظام",
  fc_order_cancelled: "لا يوجد مسار إلغاء بطلب العميل يسترجع المبلغ آلياً — النص يقول «يرجع لوسيلة الدفع»",
  fc_address_confirm: "لا يوجد في البورتال ما يرسله ولا ما يعالج ردّي الزرّين",
  fc_scheduled_reminder: "الطلب المسبق مقفول (settings.preorder.enabled=false)",
  fc_welcome_account: "غير مربوط بمُرسل (الزر اتشال ١٢/١٠ فالنص خدمي؛ يتقدّم لما يتقرّر إرساله)",
  fc_ad_lead_last_call: "يحتاج عرضاً له تاريخ انتهاء؛ البوكسات بلا تاريخ انتهاء — لا شيء صادق يُكتب في المتغيّرين",
  /* SW1 (١٣/١٠): صياغتان جديدتان باسمين جديدين — بانتظار موافقة المالك على النص (العربي والإنجليزي في README الشريحة SW1) */
  fc_order_pickup_ready: "بانتظار موافقة المالك النهائية على النص (صياغته هو، ١٧/١٠ — RT2) — بديل fc_order_ready_pickup المرفوض. لحد الاعتماد: نفس النص رسالة حرة جوّه النافذة، وبره النافذة SMS. ماتتقدّمش من غير force:true",
  fc_staff_checkout_notice: "بانتظار موافقة المالك على النص (بديل fc_staff_checkout_watchdog المصنَّف تسويق؛ fc_staff_payment_alert موجود لنفس الغرض)",
  /* RV1 (١٥/١٠): قالب النجوم — النص في docs/designs-2026-10/whatsapp/reviews-workflow.md */
  fc_review_stars: "النص اتوافق عليه (عمر ١٥/١٠ ١٤:١٥: «موافق على كل حاجة») — بيتقدّم لميتا بعد النشر بـ force:true (RV1 — التقييم بالنجوم بره النافذة)، وبعد الاعتماد يتفتح مفتاح «قالب النجوم». ١٦/١٠: التقديم الأول اترفض (2388060 — إيموجي النجوم في الأزرار)؛ RV4 شال الإيموجي ⇒ تقديم جديد (مش edit — القالب مااتعملش عند ميتا)",
});

/* دفعات التقديم بالأولوية. الدفعة ١ = قائمة «أول ٨» الأصلية. */
export const SUBMIT_BATCHES = Object.freeze([
  ["fc_otp", "fc_order_received", "fc_order_on_the_way", "fc_order_delivered", "fc_order_refunded", "fc_staff_new_order", "fc_cart_1h", "fc_welcome_offer"],
  ["fc_order_preparing", "fc_order_ready_pickup", "fc_refund_in_progress", "fc_cart_24h", "fc_cart_24h_first", "fc_loyalty_reward", "fc_winback_21", "fc_review_request"],
  ["fc_staff_sla_alert", "fc_staff_courier_issue", "fc_staff_pos_failed", "fc_staff_wa_handoff", "fc_staff_low_rating", "fc_staff_checkout_watchdog", "fc_staff_daily_summary"],
  ["fc_order_delayed", "fc_courier_assigned", "fc_payment_received", "fc_waitlist_open", "fc_loyalty_progress", "fc_coupon_expiring", "fc_try_website", "fc_ad_lead_followup"],
  ["fc_winback_90", "fc_vip_lapsed", "fc_one_time_coupon", "fc_review_thanks_coupon", "fc_fav_dish"],
  // بصورة: يحتاج sampleImageUrl وقت التقديم
  ["fc_new_item", "fc_weekend_offer", "fc_bundle_offer", "fc_occasion"],
  // ١٢/١٠ «خدمي ولا تسويقي»: النسخ الخدمية الجديدة — من الأضمن للأخطر، واحد في المرة، ونقف عند أول قالب ميتا تصنّفه تسويق
  ["fc_payment_failed", "fc_feedback_received", "fc_loyalty_status", "fc_staff_payment_alert", "fc_staff_day_report", "fc_open_notice"],
  // FR1 (١٣/١٠): إطارات العروض — النصي الأول (مافيهوش رفع)، وبعده الصور، وآخرهم الفيديو. كل اسم = عربي + إنجليزي
  ["fc_frame_news_text", "fc_frame_offer_img", "fc_frame_limited_img", "fc_frame_video"],
  // RF1 (١٤/١٠): إطارات «الرد أولاً» — النصي الأول (مافيهوش رفع) وبعده الفيديو. كل اسم = عربي + إنجليزي
  ["fc_frame_ask_text", "fc_frame_ask_video"],
  // ST1 (١٢/١٠): قوالب تواصل الفريق — التجديد أولاً (من غير متغيّرات)، وبعده سطر التنبيه. كل اسم = إنجليزي + عربي
  ["fc_staff_alerts_renew", "fc_staff_team_notice"],
  // SB4 (١٤/١٠): نسخ v2 بزر رد سريع يفتح نافذة ٢٤ ساعة — التوصيل والتقييم أولاً (الضغطة = رأيه)، بعدين التتبع، وآخرهم الاسترجاع
  ["fc_order_on_the_way_courier"],      // SB5
  ["fc_courier_job_v1"],      // CW1 (١٦/١٠): أزرار المندوب الخارجي بره النافذة — بعد الاعتماد يتفتح «courierJob.useTemplate» من اللوحة
  ["fc_order_delivered_v2", "fc_review_request_v2", "fc_order_on_the_way_v2", "fc_order_preparing_v2", "fc_order_received_v2", "fc_order_refunded_v2", "fc_refund_in_progress_v2"],
  // UT1 (١٩/١٠): بدايل خدمية لقوالب الفريق اللي ميتا حوّلتها تسويق — البوابة الأول (أكتر واحد اتبعت)، والتجديد آخر واحد (أكتر واحد ممكن يتصنّف تسويق تاني)
  ["fc_staff_portal_offline", "fc_staff_chat_review", "fc_staff_inbox_summary", "fc_staff_task_notice", "fc_staff_alerts_paused"],
  // UT2 (١٩/١٠): بدايل خدمية بأسماء جديدة لقوالب خدمة ميتا صنّفتها تسويق — الأكبر فلوس الأول (النجوم)، والأخطر آخر واحد (تنبيه الفتح). لغة واحدة لكل اسم.
  ["fc_review_order_v3", "fc_staff_inbox_alert", "fc_staff_task_alert", "fc_staff_payment_notice", "fc_open_request_update"],
]);
export const RECOMMENDED_FIRST = SUBMIT_BATCHES[0];
export const FRAME_BATCH = SUBMIT_BATCHES.find((b) => b.includes("fc_frame_news_text"));      // FR1: دفعة الإطارات (بالرابط)
export const ASK_FRAME_BATCH = SUBMIT_BATCHES.find((b) => b.includes("fc_frame_ask_text"));   // RF1: دفعة «الرد أولاً»

/* الفئة الفعلية عند ميتا لما تختلف عن فئتنا (ميتا غيّرتها وقت الاعتماد — previous_category=UTILITY). المفتاح name:language.
   UT1 (قراءة ١٩/١٠ من GET message_templates): الحارس (whatsapp.js) بيقرا الفئة **الحيّة** من قايمة ميتا (كاش ١٠ دقايق، wacloud.js) — الجدول ده
   هو الاحتياطي لما القايمة ماتتقريش، وبيتحدّث يدوي مع كل قراءة. اتشال منه: fc_staff_checkout_watchdog:en و fc_staff_daily_summary:ar (ميتا رجّعتهم UTILITY).
   **fc_review_stars:ar مش هنا بالقصد** (ميتا صنّفته MARKETING ١٦/١٠): posReviewBasis بيقرا الجدول ده — إضافته بتوقف طلب التقييم لعملاء الكاشير/كيتا
   فوراً، ودي قرار المالك (README شريحة UT1) مش تعديل جانبي. الحارس الحي بيعرفه من غير الجدول (والاستثناء في utilityFirst.reviewStarsAsMarketing). */
export const META_CATEGORY = Object.freeze({
  "fc_staff_checkout_watchdog:ar": "MARKETING",
  "fc_staff_team_notice:ar": "MARKETING",
  "fc_staff_team_notice:en": "MARKETING",
  "fc_staff_alerts_renew:ar": "MARKETING",
  "fc_staff_alerts_renew:en": "MARKETING",
  /* UT2 (قراءة ١٩/١٠ ٠٩:٠٢ الرياض): اتنين من بدايل UT1 ميتا اعتمدتهم MARKETING بلغة واحدة — البديل في warewrite.js */
  "fc_staff_inbox_summary:ar": "MARKETING",
  "fc_staff_task_notice:en": "MARKETING",
});
export const billedCategory = (t) => META_CATEGORY[`${t.name}:${t.language}`] || t.category;

/* ═══ أدوات ══════════════════════════════════════════════════════════════ */
export const bodyOf = (t) => (t.components.find((c) => c.type === "BODY") || {}).text || "";
export const footerOf = (t) => (t.components.find((c) => c.type === "FOOTER") || {}).text || "";
export const buttonsOf = (t) => (t.components.find((c) => c.type === "BUTTONS") || {}).buttons || [];
export const templateKey = (t) => `${t.name}:${t.language}`;
export const findTemplate = (name, language = "ar") =>
  TEMPLATES.find((t) => t.name === name && t.language === language) || null;

const varNums = (s) => [...String(s || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));

/* فحص قواعد ميتا — يرجّع قائمة أخطاء (فاضية = صالح) */
export function validateTemplate(t) {
  const e = [];
  if (!/^[a-z0-9_]{1,512}$/.test(t.name || "")) e.push("name: snake_case صغير فقط");
  if (!CATEGORIES.includes(t.category)) e.push(`category غير معروفة: ${t.category}`);
  if (!["ar", "en"].includes(t.language)) e.push(`language: ${t.language}`);
  const comps = t.components || [];
  const body = comps.find((c) => c.type === "BODY");
  if (!body) e.push("BODY مفقود");
  if (t.category === "AUTHENTICATION") {
    if (!body?.add_security_recommendation) e.push("auth: add_security_recommendation");
    const b = buttonsOf(t);
    if (b.length !== 1 || b[0].type !== "OTP") e.push("auth: زر OTP واحد");
    return e;
  }
  const text = body?.text || "";
  if (!text.trim()) e.push("BODY فاضي");
  if ([...text].length > 1024) e.push("BODY > 1024");
  if (/^\s*\{\{\d+\}\}/.test(text)) e.push("BODY يبدأ بمتغيّر");
  if (/\{\{\d+\}\}\s*$/.test(text)) e.push("BODY ينتهي بمتغيّر");
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text)) e.push("متغيّرين جنب بعض");
  if (/\n{3,}/.test(text)) e.push("أسطر فاضية كثيرة");
  const nums = varNums(text);
  const uniq = [...new Set(nums)];
  if (uniq.some((n, i) => n !== i + 1) || uniq.length !== nums.length) e.push("المتغيّرات لازم {{1}}..{{n}} بالترتيب وبدون تكرار");
  const ex = body?.example?.body_text?.[0] || [];
  if (nums.length && ex.length !== uniq.length) e.push(`أمثلة المتغيّرات ${ex.length} ≠ ${uniq.length}`);
  if (ex.some((v) => !String(v).trim() || /[\n\t]|\s{4,}/.test(String(v)))) e.push("مثال متغيّر فاضي أو فيه سطر جديد");
  // ميتا ترفض # و $ و % داخل قيمة المثال (سبب رفض موثّق)، و«٪» نتجنّبها معها
  if (ex.some((v) => /[#$%٪]/.test(String(v)))) e.push("مثال متغيّر فيه # أو $ أو %");
  // ميتا ترفض النص اللي متغيّراته كثيرة بالنسبة لطوله
  const words = text.replace(/\{\{\d+\}\}/g, " ").split(/\s+/).filter(Boolean).length;
  if (uniq.length && words < uniq.length * 3) e.push("نسبة المتغيّرات للنص عالية");
  const header = comps.find((c) => c.type === "HEADER");
  if (header) {
    if (header.format === "TEXT" && [...(header.text || "")].length > 60) e.push("HEADER > 60");
    if (header.format === "IMAGE" && !header.example?.header_handle?.length) e.push("HEADER IMAGE بدون مثال");
  }
  const footer = comps.find((c) => c.type === "FOOTER");
  if (footer) {
    if ([...(footer.text || "")].length > 60) e.push("FOOTER > 60");
    if (/\{\{/.test(footer.text || "")) e.push("FOOTER فيه متغيّر");
  }
  const btns = buttonsOf(t);
  const qrs = btns.filter((b) => b.type === "QUICK_REPLY");
  const ctas = btns.filter((b) => b.type === "URL" || b.type === "PHONE_NUMBER");
  if (qrs.length > 3) e.push("ردود سريعة > 3");
  if (ctas.length > 2) e.push("أزرار CTA > 2");
  if (btns.filter((b) => b.type === "URL").length > 2) e.push("روابط > 2");
  for (const b of btns) {
    if (!b.text || [...b.text].length > 25) e.push(`نص الزر «${b.text}» > 25`);
    { const p = b.text ? buttonTextProblem(b.text) : null; if (p) e.push(`نص الزر «${b.text}» فيه ${p} — ميتا بترفضه (2388060)`); }      // RV4
    if (b.type === "URL") {
      if (!/^https:\/\//.test(b.url)) e.push(`رابط غير https: ${b.url}`);
      const vn = varNums(b.url);
      if (vn.length > 1 || (vn.length && vn[0] !== 1)) e.push("الرابط: متغيّر واحد {{1}} فقط");
      if (vn.length && !/\{\{1\}\}$/.test(b.url)) e.push("الرابط: {{1}} لازم في الآخر");
      if (vn.length && !(Array.isArray(b.example) && /^https:\/\//.test(b.example[0] || ""))) e.push("الرابط: مثال كامل مطلوب");
      // لاحقة الرابط = حروف رابط آمنة فقط (ميتا تطلب ترميز أي رمز خاص؛ ? و # و = لا تدخل في المتغيّر)
      if (vn.length && Array.isArray(b.example) && !/^[A-Za-z0-9._~-]+$/.test(String(b.example[0] || "").slice(b.url.replace("{{1}}", "").length))) e.push("الرابط: لاحقة المثال فيها رموز غير آمنة");
      // التسويق: الرابط لازم رابطنا المتتبَّع /l/ أو رابط السلة /c/ (والاستثناء الوحيد fc_winback_45 المعتمد بزر ‎?c=)
      if (t.category === "MARKETING" && t.name !== "fc_winback_45" && !/^https:\/\/freshcuts\.sa\/(l|c)\/\{\{1\}\}$/.test(b.url)) e.push(`التسويق: رابط غير متتبَّع ${b.url}`);
    }
  }
  // ترتيب الأزرار: ميتا تطلب تجميع الردود السريعة مع بعض والـCTA مع بعض
  const kinds = btns.map((b) => (b.type === "QUICK_REPLY" ? "q" : "c")).join("");
  if (/q+c+q|c+q+c/.test(kinds)) e.push("الأزرار مخلوطة (لازم مجموعات)");
  if (t.category === "MARKETING") {
    /* FR1: القالب الإنجليزي بياخد المقابل الإنجليزي (STOP) — الويب هوك بيفهم الكلمتين */
    if (footerOf(t) !== (t.language === "en" ? OPTOUT_FOOTER_EN : OPTOUT_FOOTER)) e.push("التسويق: فوتر الإيقاف مطلوب");
    /* TS1: القالب اللي meta.stopButton=false (الإطارات — قرار المالك) لازم **مايكونش** فيه زر إيقاف؛ الباقي لازم يكون فيه. الفوتر مطلوب في الاتنين. */
    const hasStop = qrs.some((b) => b.text === (t.language === "en" ? OPTOUT_BUTTON_EN : OPTOUT_BUTTON));
    if (t.meta?.stopButton === false ? hasStop : !hasStop) e.push(t.meta?.stopButton === false ? "التسويق: القالب ده من غير زر «إيقاف» (الإيقاف بالكتابة)" : "التسويق: زر «إيقاف» مطلوب");
  }
  if (t.category === "UTILITY" && /(^|[\s،.])(خصم|كود|كوبون|عرض|العرض|عروض|مجاني|مجانا)|٪|%|discount|coupon|offer|promo/i.test(text)) {
    e.push("UTILITY فيه كلام ترويجي — ميتا بتصنّفه تسويق");
  }
  if (/ستيك|steak/i.test(text)) e.push("ادعاء ستيك — مو في المنيو");
  if (/أرخص من التطبيقات|ارخص من التطبيقات/.test(text)) e.push("ادعاء «أرخص من التطبيقات» ممنوع");
  if (!t.meta?.purpose || !t.meta?.trigger || !t.meta?.send) e.push("meta: purpose/trigger/send مطلوبة");
  if (!["auto", "auto-candidate", "manual"].includes(t.meta?.send)) e.push(`meta.send: ${t.meta?.send}`);
  return e;
}

/* جسم التقديم لميتا (بدون بياناتنا) */
export function submissionBody(t) {
  return { name: t.name, language: t.language, category: t.category, components: t.components };
}

const getPath = (obj, path) => String(path || "").split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
/* ميتا ترفض قيمة فيها سطر جديد/tab/أكثر من ٤ مسافات */
export const cleanParam = (v, max = 1000) => String(v ?? "")
  .replace(/[\r\n\t]+/g, " - ").replace(/\s{4,}/g, "   ").trim().slice(0, max);
function fmtVal(v, fmt) {
  if (fmt === "firstName") {
    const w = String(v || "").trim().split(/\s+/)[0] || "";
    return w.length >= 2 && w.length <= 20 ? w : "عميلنا";
  }
  if (fmt === "money") {
    if (v == null || String(v).trim() === "") return "";   // مبلغ ناقص = متغيّر ناقص (Number("") = 0 كان يطلع «0 ر.س»)
    const n = Number(v);
    return Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : "";
  }
  return v;
}

/* البيانات → باراميترات الإرسال {body:[...], buttons:[{index, text}], missing:[...]}
   (نفس الترتيب اللي buildTemplatePayload في whatsapp.js يستعمله). أي متغيّر
   فاضي = missing ⇒ المُرسل لازم ما يرسل (لا نرسل «{{2}}» فاضي للعميل). */
export function bindTemplate(t, data = {}) {
  const missing = [];
  if (t.category === "AUTHENTICATION") {
    const code = cleanParam(getPath(data, "otp.code"));
    if (!/^[A-Za-z0-9]{1,15}$/.test(code)) missing.push("otp.code");   // ميتا: الرمز ١٥ خانة كحد أقصى
    return { body: [code], buttons: [{ index: 0, sub_type: "url", text: code }], missing };
  }
  const body = (t.meta.vars || []).map((v) => {
    const raw = fmtVal(getPath(data, v.path), v.fmt);
    const s = cleanParam(raw);
    if (!s) missing.push(v.path);
    return s;
  });
  const buttons = [];
  buttonsOf(t).forEach((b, index) => {
    if (b.type !== "URL" || !/\{\{1\}\}/.test(b.url)) return;
    const bv = (t.meta.buttonVars || []).find((x) => x.button === b.text);
    const s = cleanParam(getPath(data, bv?.path), 2000);
    if (!s || !/^[A-Za-z0-9._~-]+$/.test(s)) missing.push(bv?.path || `button:${index}`);
    buttons.push({ index, sub_type: "url", text: s });
  });
  return { body, buttons, missing };
}

/* معاينة النص بقيم الأمثلة (أو بيانات حقيقية) */
export function previewText(t, data = null) {
  if (t.category === "AUTHENTICATION") return "{{1}} هو رمز التحقق الخاص بك. لأمانك، لا تشاركه مع أي شخص.\nتنتهي صلاحية هذا الرمز خلال 5 دقائق.";
  const vals = data ? bindTemplate(t, data).body : (t.meta.vars || []).map((v) => v.example);
  return bodyOf(t).replace(/\{\{(\d+)\}\}/g, (m, n) => vals[Number(n) - 1] ?? m);
}

export function summary() {
  const byCategory = {};
  for (const t of TEMPLATES) byCategory[t.category] = (byCategory[t.category] || 0) + 1;
  return {
    total: TEMPLATES.length,
    names: new Set(TEMPLATES.map((t) => t.name)).size,
    byCategory,
    byGroup: Object.fromEntries(Object.keys(GROUPS).map((g) => [g, TEMPLATES.filter((t) => t.meta.group === g).length])),
    needsUpload: TEMPLATES.filter((t) => t.meta.needsUpload).map((t) => t.name),
    invalid: TEMPLATES.map((t) => ({ key: templateKey(t), errors: validateTemplate(t) })).filter((x) => x.errors.length),
  };
}
