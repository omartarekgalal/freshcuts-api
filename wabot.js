/* ═══════════════════════════════════════════════════════════════════════════
   WABOT — الرد الآلي على واتساب لفريش كاتس (داخل نافذة الـ٢٤ ساعة، نص حر).

   ┌─ طريقة التوصيل (لوكيل التكامل — فرع wa-cloud) ─────────────────────────┐
   │  import * as wabot from "./wabot.js";                                    │
   │  const bot = wabot.register(app, moduleCtx, { app });                    │
   │                                                                          │
   │  // لكل رسالة واردة من الويب هوك (بعد parseWebhook):                    │
   │  const r = await bot.handleInbound({                                     │
   │    from: m.from,            // wa_id «9665XXXXXXXX»                      │
   │    type: m.type,            // text|button|interactive|location|image…   │
   │    text: m.text,            // النص أو عنوان الزر                         │
   │    replyId: m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? null,
   │    location: m.location ? { lat: m.location.latitude, lng: m.location.longitude } : null,
   │    referral: m.referral || null,   // Click-to-WhatsApp                  │
   │    profileName: contacts[0]?.profile?.name || null,                      │
   │    at: m.at,                                                             │
   │  });                                                                     │
   │  // r = { skip:null|"<سبب>", intent, messages:[payload…], actions:[…] }  │
   │  for (const p of r.messages) await send({ messaging_product:"whatsapp",  │
   │                                  recipient_type:"individual", to: m.from, ...p });
   │  for (const a of r.actions) …  // handoff | optout | optin | waitlist_join
   │                                                                          │
   │  // رسالة طلعت من جوال المطعم (echo / smb_message_echoes):               │
   │  bot.state.staffReplied(waId)   // البوت يسكت staffMuteHours (افتراضي ٤) │
   └──────────────────────────────────────────────────────────────────────────┘

   الـpayloads = أجسام رسائل Cloud API بدون `to` (text | interactive
   button ≤3 | interactive list ≤10 صفوف | interactive cta_url). حدود ميتا
   مفحوصة في wabot.test.mjs لكل رد.

   القواعد:
   • ولا حقيقة مكتوبة في الكود: الأسعار والأصناف من /api/menu الحي، المواعيد
     من settings.hours (+ إيقاف الخدمة service.js)، رسوم التوصيل من
     dl_policies، الكوبونات من shop_coupons، العروض من offer_registry،
     الموقع/الدفع/الضريبة من settings.storefront.seo.faq، والباقي من
     settings.waBot.facts. معلومة ناقصة ⇒ «أتأكد لك من الفريق» + تحويل.
   • حقائق ثابتة تحققنا منها: الاسم، الموقع freshcuts.sa، رابط التتبع
     /track/<رقم>، التطبيقات اللي نشتغل معها (order_sources ٢٨/٩).
   • لا «ستيك» ولا عدد أشخاص لصنف بالوزن ولا «أرخص من التطبيقات».
   • لغة سعودية/محايدة (مو مصرية)، قصيرة ودافية. إنجليزي لو العميل كتب إنجليزي.
   • ساعات العمل: برّه الدوام نقول متى نفتح + زر «ذكّرني» (waitlist).
   • تحويل لموظف: البوت يسكت handoffQuietMinutes (افتراضي ٣٠) إلا للإيقاف
     والاشتراك وحالة الطلب، ويسكت staffMuteHours بعد رد الموظف من الجوال.
   • حد الردود: ٦ ردود/٥ دقائق للرقم، ونفس النص خلال ٩٠ ثانية ما نعيده.
   • matchIntent / buildReply دوال صافية (بدون شبكة ولا قاعدة) — كل البيانات
     تجي في ctx من loadContext.
═══════════════════════════════════════════════════════════════════════════ */

import { isOpenNow } from "./carts.js";
import { nextOpening } from "./soldout.js";
import { serviceState } from "./service.js";
import { SEED_PRICE_LIST } from "./districts.js";

export const STORE = "https://freshcuts.sa";
const UTM = "utm_source=whatsapp&utm_medium=bot";
export const BOT_DEFAULTS = Object.freeze({
  enabled: true,
  staffMuteHours: 4,          // بعد رد الموظف من الجوال
  handoffQuietMinutes: 30,    // بعد ما البوت يحوّل لموظف
  maxRepliesPer5Min: 6,
  duplicateSeconds: 90,
  orderLookbackHours: 72,
  lateAfterMinutes: 70,       // طلب نشط أقدم من كذا + «وين طلبي» ⇒ تحويل عاجل
  publicCoupons: ["FIRST"],   // الكوبونات اللي البوت يذكرها لأي أحد
});

/* ═══ التطبيع ════════════════════════════════════════════════════════════ */
export function normalize(s) {
  return String(s || "").toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/گ/g, "ك").replace(/[پ]/g, "ب").replace(/[ڤ]/g, "ف").replace(/چ/g, "ج")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[’`']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/\s+/g, " ").trim();
}
const hasArabic = (s) => /[؀-ۿ]/.test(String(s || ""));
/* إنجليزي = حروف لاتينية وكلمات إنجليزية معروفة، مو فرانكو (فيه أرقام داخل الكلمة) */
export function detectLang(text) {
  const t = String(text || "");
  if (!t.trim() || hasArabic(t)) return "ar";
  const n = normalize(t);
  if (/\b[a-z]*[2375689][a-z]+\b|\b[a-z]+[2375689]\b/.test(n)) return "ar"; // فرانكو
  const EN = /\b(the|is|are|you|your|what|where|when|how|can|do|does|i|my|me|order|menu|open|close|closed|price|prices|hi|hello|hey|thanks|thank|please|pls|want|delivery|deliver|much|have|any|food|pay|cash|location|address|hours|cancel|refund|help|good|stop|start|ok|okay|yes|no)\b/;
  if (/\b(abi|abgha|3ayez|3awz|talabi|talaby|fen|fein|wen|wein|kam|bkam|3ndko|3andko|mat3am|ya|habibi|yalla|mashawi|el|ana|enta|inta|tawseel|twseel|shukran|shokran|salam|slm|marhaba|ahlan|hala|mawa3eed)\b/.test(n)) return "ar";
  return EN.test(n) ? "en" : "ar";
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/* كلمة/عبارة كاملة مع السوابق العربية (و/ف + ب/ل/ك + ال) */
function W(list) {
  const alts = [...new Set(list.map(normalize).filter(Boolean))].sort((a, b) => b.length - a.length).map(esc);
  return new RegExp(`(?:^| )(?:[وف]?(?:لل|[بلك])?(?:ال)?)(?:${alts.join("|")})(?= |$)`);
}

/* ═══ المفردات ═══════════════════════════════════════════════════════════ */
const V = {
  greet: W(["السلام عليكم", "السلام", "سلام عليكم", "سلام", "مرحبا", "مرحبتين", "مراحب", "هلا", "هلا والله", "اهلا", "اهلين", "هاي", "هلو", "صباح الخير", "مساء الخير", "صباحو", "مساء النور", "يا هلا", "hi", "hello", "hey", "hola", "salam", "slm", "salamo alaykom", "salam alaikum", "marhaba", "ahlan", "hala", "good morning", "good evening", "رمضان كريم", "عيد مبارك", "عيدكم مبارك", "عيد سعيد", "عساكم من عواده", "كل عام وانتم بخير", "هلا وغلا"]),
  menu: W(["منيو", "منيوكم", "مينيو", "المنيو", "قائمه", "قائمه الطعام", "قائمة الاكل", "الاصناف", "اصنافكم", "اكلاتكم", "menu", "mnu", "meno", "menue", "the menu", "el menu", "al menu", "وش عندكم", "ايش عندكم", "شو عندكم", "ايه عندكم", "وش تبيعون", "ايش تبيعون", "وش الاكل", "ايش الاكل", "عندكم ايش", "وش تقدمون", "what do you have", "what do you sell", "send menu", "send the menu", "food list", "eh 3andko", "sho 3andkom", "كتالوج", "catalog", "الاكلات"]),
  price: W(["بكم", "بكام", "كم سعر", "سعر", "اسعار", "اسعاركم", "السعر", "كم حق", "كم قيمه", "قيمه", "كم ثمن", "كم يكلف", "كم تكلف", "كم الكيلو", "price", "prices", "pricing", "how much", "bkam", "b kam", "be kam", "se3r", "sa3r", "as3ar", "cost", "costs"]),
  recommend: W(["وش تنصح", "ايش تنصح", "تنصحني", "تنصحوني", "تنصحونا", "انصحني", "انصحوني", "انصحنا", "اقترح", "اقترحوا", "اقترح علي", "اقترحو", "وش الافضل", "ايش الافضل", "وش احسن", "ايش احسن", "وش احلى", "ايش احلى", "الاكثر طلب", "الاكثر طلبا", "الاكثر مبيعا", "الاشهر", "اشهر شي", "وش المميز", "المميز عندكم", "وش اطلب", "ايش اطلب", "محتار", "تنصحون", "وش تنصحون", "ايش تنصحون", "محتاره", "best seller", "best sellers", "bestseller", "recommend", "recommendation", "recommendations", "suggest", "suggestion", "whats good", "what is good", "most popular", "popular", "a7san", "afdal", "ahsan", "el a7la", "eh el a7la", "يستاهل"]),
  family: W(["عائلي", "عائليه", "للعائله", "عائله", "عايله", "العايله", "لمه", "جمعه", "جمعه عائليه", "تجمع", "family", "group", "اهلي", "الاهل", "الشله", "شله", "ربعي", "الربع"]),
  budget: W(["رخيص", "ارخص", "اقتصادي", "اقتصاديه", "ميزانيه", "على قد", "اوفر", "ارخص شي", "اقل سعر", "cheap", "cheapest", "budget", "affordable", "value"]),
  servings: W(["يكفي", "تكفي", "يكفي كم", "كم يكفي", "كم شخص", "كم نفر", "لكم شخص", "يشبع", "تشبع", "how many people", "serves", "enough for", "feeds", "portion"]),
  offers: W(["عروض", "عرض", "العروض", "عروضكم", "عرضكم", "خصم", "خصومات", "تخفيض", "تخفيضات", "offer", "offers", "deal", "deals", "discount", "discounts", "promo", "promotion", "promotions", "3rood", "3ard", "عرض اليوم", "عروض اليوم", "sale"]),
  coupon: W(["كوبون", "كوبونات", "كود", "الكود", "كود خصم", "رمز خصم", "coupon", "code", "promo code", "voucher", "first", "فرست"]),
  problem: W(["ما يشتغل", "مايشتغل", "ما اشتغل", "ما زبط", "مازبط", "ما ضبط", "ماضبط", "ما يزبط", "خطا", "غلط", "مرفوض", "رفض", "رافض", "غير صالح", "مو صالح", "not working", "doesnt work", "does not work", "didnt work", "invalid", "not valid", "expired", "ما قبل", "ماقبل", "ما ينفع", "ماينفع", "مو شغال", "مش شغال", "مب شغال", "error", "منتهي", "ما ركب", "ماركب", "ما يطبق", "ما انطبق", "ما انخصم", "ما نزل الخصم", "مو راضي", "مش راضي"]),
  how: W(["كيف اطلب", "كيف الطلب", "كيف اسوي طلب", "ابي اطلب", "ابغى اطلب", "ابغي اطلب", "ابا اطلب", "بغيت اطلب", "اريد اطلب", "ودي اطلب", "عايز اطلب", "عاوز اطلب", "حابب اطلب", "اطلب منكم", "طريقه الطلب", "ابي اسوي طلب", "ابغى اسوي طلب", "ممكن اطلب", "اقدر اطلب", "how to order", "how can i order", "how do i order", "i want to order", "want to order", "place an order", "order online", "can i order", "abi atlob", "abgha atlob", "3ayez atlob", "3awz atlob", "رابط الطلب", "رابط", "لينك", "website", "site", "link", "الموقع الالكتروني", "موقعكم الالكتروني", "اطلب اونلاين", "اونلاين", "online", "ابي اطلب اونلاين"]),
  pickup: W(["استلام", "استلم", "بستلم", "اجي استلم", "بيك اب", "pickup", "pick up", "سفري", "تيك اوي", "تيك اواي", "take away", "takeaway", "اخذه من المطعم", "اخذه من الفرع", "من الفرع", "امر اخذه", "اجي اخذه"]),
  delivery: W(["توصيل", "توصلون", "توصلوا", "توصلو", "يوصل", "توصل", "delivery", "deliver", "twseel", "tawseel", "twsel", "dlivery", "delivry"]),
  area: W(["توصلون", "توصلوا", "توصلو", "توصلونا", "توصلوني", "بتوصلوا", "يوصل حي", "توصلون حي", "توصيل حي", "توصيل ل", "توصيل الى", "منطقتي", "حينا", "حيي", "do you deliver", "deliver to", "delivery to", "delivery area", "delivery areas", "twasloon", "btwsalo", "btwaslo", "مناطق التوصيل", "وين توصلون", "نطاق التوصيل", "بعيد عنكم", "المسافه"]),
  fee: W(["رسوم التوصيل", "رسوم توصيل", "رسوم", "سعر التوصيل", "كم التوصيل", "التوصيل كم", "التوصيل بكم", "بكم التوصيل", "تكلفه التوصيل", "قيمه التوصيل", "توصيل مجاني", "التوصيل مجاني", "مجاني", "delivery fee", "delivery fees", "delivery free", "delivery charge", "delivery cost", "free delivery", "shipping", "fee", "fees"]),
  dtime: W(["كم ياخذ", "كم ياخذ التوصيل", "كم يطول", "كم دقيقه", "وقت التوصيل", "مده التوصيل", "كم يستغرق", "كم وقت", "كم ساعه ياخذ", "كم يبي وقت", "how long", "delivery time", "how many minutes", "eta", "متى يوصل", "متى يوصلني"]),
  minOrder: W(["الحد الادني", "الحد الادنى", "حد ادنى", "حد ادني", "اقل طلب", "اقل مبلغ", "اقل شي اطلب", "اقل قيمه", "minimum order", "min order", "minimum", "minimum amount"]),
  hours: W(["متى تفتحون", "متى تفتحوا", "متي تفتحون", "متى تفتح", "متى تسكرون", "متى تسكروا", "متى تقفلون", "متى تقفلوا", "متى تغلقون", "متى يفتح", "متى يقفل", "متى يسكر", "الدوام", "دوام", "دوامكم", "ساعات العمل", "ساعات الدوام", "مواعيد", "مواعيدكم", "اوقات", "اوقات العمل", "اوقاتكم", "وقت الدوام", "الى متى", "لين متى", "لحد متى", "opening hours", "open hours", "working hours", "business hours", "hours", "what time", "when do you open", "when do you close", "closing time", "close", "mawa3eed", "mwa3ed", "تسكرون", "تقفلون", "تفتحون"]),
  openNow: W(["مفتوحين", "فاتحين", "مفتوح الحين", "فاتحين الحين", "شغالين", "شغالين الحين", "تفتحون الحين", "open now", "are you open", "you open", "still open", "open", "fat7een", "fat7in", "مفتوح", "فاتح", "لسا فاتحين", "لسه فاتحين", "مازلتم مفتوحين", "داومتوا", "فتحتوا", "مسكرين", "مسكر", "مقفلين", "قافلين", "مغلق", "مغلقين", "closed", "are you closed"]),
  special: W(["رمضان", "العيد", "عيد", "الاعياد", "اجازه", "الاجازه", "اليوم الوطني", "عطله", "العطله", "ramadan", "eid", "holiday", "holidays", "national day"]),
  location: W(["وين موقعكم", "وين مكانكم", "وين المطعم", "وينكم", "وين انتم", "وين انتو", "وين محلكم", "فين المطعم", "فين مكانكم", "فينكم", "موقعكم", "مكانكم", "محلكم", "لوكيشن", "لوكيشنكم", "العنوان", "عنوانكم", "عنوان المطعم", "فرع", "فروع", "فروعكم", "الفرع", "location", "address", "where are you", "where is the restaurant", "where r u", "branch", "branches", "directions", "map", "maps", "google maps", "خريطه", "قوقل ماب", "جوجل ماب", "wenkom", "fen el mat3am", "mawqe3kom", "ارسل الموقع", "ارسلوا الموقع", "ابي الموقع", "ابغى الموقع", "كيف اوصلكم", "كيف اجيكم"]),
  locationWeak: W(["الموقع", "موقع"]),
  parking: W(["مواقف", "موقف سيارات", "مواقف سيارات", "باركنج", "باركينج", "parking", "park", "اوقف سيارتي", "اصف سيارتي", "وين اصف", "وين اوقف"]),
  dineIn: W(["جلسات", "جلسه", "صاله", "جلسات داخليه", "جلسات خارجيه", "قعده", "نقعد", "اقعد", "اجلس", "نجلس", "ناكل عندكم", "ناكل في المطعم", "اكل في المطعم", "محلي", "dine in", "dine-in", "seating", "tables", "seats", "sit", "family section", "قسم عائلات", "قسم العوائل", "قسم للعوائل", "للعوائل", "عوائل", "عائلات", "قسم نساء", "بارتشن", "بارتيشن", "مكان للجلوس"]),
  payment: W(["طرق الدفع", "طريقه الدفع", "وسائل الدفع", "الدفع", "ادفع", "كاش", "نقدا", "نقد", "نقدي", "الدفع عند الاستلام", "دفع عند الاستلام", "كاش عند الاستلام", "مدى", "ابل باي", "ابل بي", "apple pay", "applepay", "stc pay", "stcpay", "اس تي سي", "فيزا", "ماستر", "بطاقه", "بطاقات", "ائتمان", "ائتمانيه", "payment", "pay", "cash", "cod", "mada", "visa", "mastercard", "card", "تابي", "تمارا", "tabby", "tamara", "تقسيط", "شبكه"]),
  payIssue: W(["ما قدرت ادفع", "ماقدرت ادفع", "ما قدرنا ندفع", "الدفع ما تم", "ما تم الدفع", "ما مشى الدفع", "رفض الدفع", "انرفض", "مرفوضه", "انخصم", "خصم مني", "خصمو مني", "انسحب", "انسحب المبلغ", "سحب مبلغ", "انسحب مني", "خصمت", "تعذر الدفع", "تعذر اتمام الدفع", "payment failed", "payment declined", "declined", "charged", "charged twice", "double charged", "مرتين", "فلوسي انسحبت", "المبلغ انخصم", "ما وصلني تاكيد", "دفعت وما"]),
  status: W(["وين طلبي", "وين الطلب", "طلبي وين", "فين طلبي", "فين الطلب", "متى يوصل طلبي", "متى يجي طلبي", "متى يوصل الطلب", "متى يجي الطلب", "حاله الطلب", "حاله طلبي", "تتبع", "تتبع الطلب", "اتتبع", "تتبع طلبي", "وصل الطلب", "طلبي", "الطلب حقي", "طلبيتي", "where is my order", "wheres my order", "order status", "track", "tracking", "track my order", "my order", "wen talabi", "wein talabi", "fen talaby", "fein talabi", "el order fen", "talabi", "طلبي جاهز", "الطلب جاهز", "خلص الطلب", "جهز الطلب", "وينه", "وين المندوب", "المندوب وين", "where is the driver", "driver"]),
  late: W(["تاخر", "تاخرتوا", "تاخرتو", "متاخر", "متاخره", "تاخير", "صار له", "صار لي", "ساعه", "ساعتين", "late", "delayed", "taking too long", "too long", "still waiting", "لسه ما وصل", "لسا ما وصل", "ما وصل", "ماوصل", "ما جا", "ماجا", "طولتوا", "طولتو", "طول", "بطيئين", "مستني", "انتظر من", "صار لنا", "its been", "been waiting", "an hour", "waiting for", "still not here", "not arrived", "hasnt arrived"]),
  cancel: W(["الغي", "الغي الطلب", "الغاء الطلب", "الغاء طلبي", "الغو الطلب", "الغوا الطلب", "الغوا", "ابي الغي", "ابغى الغي", "ابغي الغي", "بلغي", "كنسل", "كنسلوا", "كنسل الطلب", "cancel", "cancel order", "cancel my order", "cancellation", "لا تسوون الطلب", "لا تجهزون الطلب", "لغيت", "ابي الغيه", "الغيه"]),
  modify: W(["تعديل الطلب", "اعدل الطلب", "اعدل طلبي", "ابي اعدل", "ابغى اعدل", "اغير الطلب", "اغير طلبي", "اضيف على الطلب", "ابي اضيف", "ابغى اضيف", "نسيت اضيف", "اغير العنوان", "تغيير العنوان", "تعديل العنوان", "عنوان غلط", "العنوان غلط", "غلطت في العنوان", "modify", "modify order", "change my order", "change order", "change address", "change the address", "edit order", "add to my order", "wrong address", "بدل صنف", "ابدل", "اشيل صنف"]),
  complaint: W(["شكوى", "شكوي", "اشتكي", "ابي اشتكي", "سيء", "سيئ", "سيئه", "زفت", "خايس", "مو زين", "مب زين", "بارد", "بارده", "الاكل بارد", "وصل بارد", "ناقص", "نقص", "ناقصه", "مو كامل", "خطا في الطلب", "مو طلبي", "مش طلبي", "مب طلبي", "طلب غلط", "جاني غلط", "وصلني غلط", "محروق", "محروقه", "نيء", "مو مستوي", "مو مطبوخ", "شعره", "حشره", "مو نظيف", "قذر", "وسخ", "رديء", "ردي", "complaint", "complain", "cold", "wrong", "missing", "bad", "terrible", "disgusting", "awful", "raw", "burnt", "hair", "undercooked", "not cooked", "ما عجبني", "مو حلو", "ما كان حلو", "تجربه سيئه", "خدمه سيئه", "زعلان", "متضايق", "مستاء", "مو راضي عن", "غلط في الطلب", "غلطتوا", "نسيتوا"]),
  severe: W(["تسمم", "مغص", "اسهال", "ترجيع", "استفراغ", "مستشفى", "sick", "food poisoning", "poisoning", "vomit", "vomiting", "hospital", "صار عندي حساسيه", "allergic reaction", "طحت مريض", "تسممت", "مسموم", "تسممنا"]),
  refund: W(["استرجاع", "استرداد", "ارجاع", "ارجاع المبلغ", "رجعوا فلوسي", "رجعو فلوسي", "ابي فلوسي", "ابغى فلوسي", "ابي مبلغي", "ترجيع المبلغ", "refund", "money back", "reimburse", "يرجع المبلغ", "متى يرجع المبلغ", "ترجع فلوسي", "تعويض", "عوضوني", "ابي تعويض"]),
  ingredients: W(["وش فيه", "ايش فيه", "وش يجي فيه", "ايش يجي فيه", "وش يجي معه", "ايش يجي معه", "وش معه", "مكونات", "المكونات", "مكوناته", "وش مكوناته", "ingredients", "what's in", "whats in", "ايش يجي مع", "وش يجي مع", "what comes with", "comes with", "وصف", "تفاصيل", "details", "describe"]),
  dietary: W(["حساسيه", "عندي حساسيه", "allergy", "allergies", "allergic", "جلوتين", "قلوتين", "غلوتين", "gluten", "gluten free", "نباتي", "نباتيه", "vegan", "vegetarian", "veggie", "فيجن", "حلال", "halal", "حار", "حاره", "سبايسي", "spicy", "حراق", "حراقه", "لاكتوز", "lactose", "مكسرات", "nuts", "nut", "peanut", "peanuts", "فول سوداني", "سمسم", "sesame", "dairy", "البان", "سعرات", "calories", "كالوري", "دايت", "diet", "كيتو", "keto", "صحي", "healthy"]),
  kids: W(["اطفال", "منيو اطفال", "وجبه اطفال", "وجبات اطفال", "kids", "kid", "children", "kids menu", "kids meal", "صغار", "بزران", "طفل", "للبزارين", "عيال", "العيال", "عيالي"]),
  catering: W(["حفله", "حفلات", "عزيمه", "عزايم", "عزومه", "عزومات", "تموين", "بوفيه", "بوفيهات", "طلب كبير", "طلبات كبيره", "كميه كبيره", "كميات", "طلبيه كبيره", "catering", "event", "events", "party", "large order", "big order", "bulk", "زواج", "عرس", "ملكه", "اجتماع", "طلب لشركه", "طلبات شركات", "موظفين", "للموظفين", "عندنا مناسبه", "عندي مناسبه", "طلب لمناسبه", "مدرسه", "مخيم", "كشته", "استراحه", "ولائم", "وليمه"]),
  reserve: W(["حجز", "احجز", "نحجز", "حجوزات", "طاوله", "reserve", "reservation", "reservations", "book a table", "booking", "ابي احجز", "ابغى احجز", "احجز طاوله"]),
  preorder: W(["طلب مسبق", "اطلب مسبق", "مسبقا", "جدوله", "اجدول", "طلب مجدول", "احدد وقت", "احدد موعد", "موعد التوصيل", "اطلب لبكره", "لبكره", "لبكرا", "بكره الساعه", "بكرا الساعه", "يوصل الساعه", "يوصلني الساعه", "schedule", "scheduled", "pre order", "preorder", "order for later", "for tomorrow", "later today"]),
  jobs: W(["وظيفه", "وظايف", "وظائف", "توظيف", "شغل عندكم", "فيه شغل", "اشتغل عندكم", "ابي اشتغل", "ابغى اشتغل", "ابي وظيفه", "ابغى وظيفه", "تقديم وظيفه", "اقدم على وظيفه", "سي في", "سيره ذاتيه", "cv", "resume", "job", "jobs", "vacancy", "vacancies", "hiring", "work with you", "career", "careers", "تحتاجون موظفين", "تحتاجون طباخ", "تحتاجون شيف", "وظيفه كاشير", "اشتغل مندوب"]),
  partner: W(["شراكه", "شراكات", "تعاون", "نتعاون", "تعاون اعلاني", "نبي نعلن", "نسوي لكم اعلان", "اسوي لكم اعلان", "اعلان عندكم", "مشهور", "مشاهير", "بلوقر", "بلوجر", "انفلونسر", "مؤثر", "influencer", "collab", "collaboration", "partnership", "partner", "advertise", "advertising", "مورد", "موردين", "توريد", "نورد لكم", "supplier", "suppliers", "supply", "marketing agency", "وكاله تسويق", "sponsor", "رعايه", "عرض تعاون"]),
  apps: W(["هنقرستيشن", "هنقر", "هنقرستيشين", "هنجر", "هنجرستيشن", "hungerstation", "hunger station", "hunger", "كيتا", "keeta", "keta", "نينجا", "ninja", "مرسول", "mrsool", "تويو", "toyou", "ذا شفز", "شفز", "the chefz", "chefz", "تطبيقات التوصيل", "تطبيقات", "التطبيقات", "تطبيق توصيل", "jahez", "على جاهز", "في جاهز", "من جاهز", "تطبيق جاهز", "فودكس", "تطبيق طلبات", "talabat", "التطبيق", "تطبيق"]),
  app: W(["تطبيقكم", "عندكم تطبيق", "ابلكيشن", "ابليكيشن", "app", "your app", "application", "تطبيق فريش"]),
  invoice: W(["فاتوره", "الفاتوره", "فواتير", "فاتوره ضريبيه", "ضريبيه", "invoice", "receipt", "tax invoice", "vat", "ضريبه", "الضريبه", "رقم ضريبي", "الرقم الضريبي", "ايصال", "سند", "شامل الضريبه", "شامله الضريبه"]),
  feedback: W(["تقييم", "اقيم", "ابي اقيم", "ابغى اقيم", "رايي", "ملاحظه", "ملاحظات", "عندي ملاحظه", "عندي اقتراح", "اقتراح", "feedback", "review", "rate", "rating", "ريفيو", "اكتب تقييم", "الاكل خطير", "الاكل روعه", "لذيذ", "تحفه", "يجنن", "يهبل", "ممتاز", "delicious", "amazing", "great food", "روعه", "ابدعتوا", "مبدعين"]),
  custom: W(["بدون", "من غير", "without", "no onion", "no onions", "extra", "زياده", "زيادة صوص", "زياده صوص", "على جنب", "on the side", "خفيف ملح", "less salt", "بدون بصل", "بدون مخلل", "بدون طحينه", "بدون مايونيز", "no mayo", "no pickles", "extra cheese", "جبن زياده"]),
  siteIssue: W(["الموقع ما يفتح", "الموقع ما يشتغل", "الموقع معلق", "الموقع خربان", "الموقع فيه مشكله", "الموقع واقف", "site not working", "website not working", "website down", "site is down", "ما قدرت اطلب", "ماقدرت اطلب", "ما يخليني اطلب", "ما يرضى يطلب", "الصفحه ما تفتح", "الرابط ما يفتح", "الرابط ما يشتغل", "link not working", "cant order", "can not order", "cannot order"]),
  human: W(["موظف", "موظفه", "انسان", "بشري", "شخص حقيقي", "خدمه العملاء", "خدمه عملاء", "الدعم", "كلمني", "كلموني", "اتصل", "اتصلوا", "اتصلو", "تتصل", "ابي اكلم", "ابغى اكلم", "ابي اتكلم", "ابغى اتكلم", "مدير", "المدير", "المسؤول", "مسؤول", "agent", "human", "real person", "customer service", "support", "call me", "talk to", "speak to", "representative", "manager", "رقمكم", "رقم المطعم", "رقم التواصل", "رقم التلفون", "رقم الهاتف", "رقم الجوال حقكم", "تلفون", "هاتف", "phone number", "contact", "contact number", "رد علي", "ردو علي", "ليش ما تردون", "محد يرد", "ما في احد يرد", "مافي احد"]),
  stopPhrase: W(["لا ترسلون", "لا ترسل لي", "لا ترسلوا", "لا ترسلو", "لا تراسلوني", "وقفوا الرسايل", "وقفو الرسايل", "وقف الرسايل", "وقف الرسائل", "ايقاف الرسائل", "ايقاف الرسايل", "اوقف الرسايل", "ابي اوقف الرسايل", "الغاء الاشتراك", "الغي الاشتراك", "unsubscribe", "stop sending", "stop messages", "stop messaging", "opt out", "optout", "بطلوا رسايل", "ازعاج", "مزعجين", "شيلوا رقمي", "احذفوا رقمي", "امسحوا رقمي", "remove my number", "dont message", "dont text me", "no more messages", "لا عاد ترسلون"]),
  startPhrase: W(["رجعوني", "فعل الرسائل", "فعلوا الرسايل", "رجعوا الرسايل", "ارسلوا لي العروض", "ابي العروض ترجع", "subscribe again", "resubscribe", "ابي اشترك"]),
  thanks: W(["شكرا", "شكرن", "مشكور", "مشكورين", "مشكوره", "يعطيك العافيه", "يعطيكم العافيه", "الله يعطيك العافيه", "الله يعطيكم العافيه", "thanks", "thank you", "thank u", "thx", "tnx", "ty", "shukran", "shokran", "تسلم", "تسلمون", "تسلمين", "جزاك الله خير", "جزاكم الله خير", "ما قصرت", "ما قصرتوا", "ماقصرتو", "ما قصرتو", "كفيت ووفيت", "الله يسعدك", "يسلمو", "يسلموا", "ممتنين"]),
  bye: W(["مع السلامه", "باي", "bye", "goodbye", "في امان الله", "فمان الله", "الله معك", "تصبح على خير", "see you", "cya", "bye bye"]),
  remind: W(["ذكرني", "ذكروني", "نبهني", "نبهوني", "ابلغوني", "بلغوني", "remind me", "notify me", "let me know when"]),
  yes: W(["اي", "ايوه", "ايوا", "ايه", "نعم", "اكيد", "تمام", "اوكي", "اوك", "ok", "okay", "yes", "yeah", "yep", "sure", "ابشر", "طيب", "يب", "yes please"]),
  no: W(["لا", "لا شكرا", "no", "nope", "مو لازم", "لا خلاص", "no thanks"]),
};
const STOP_EXACT = new Set(["ايقاف", "ايقاف العروض", "stop", "unsubscribe", "الغاء الاشتراك", "وقف", "اوقف", "stop ads", "stop all", "إيقاف"].map(normalize));
const START_EXACT = new Set(["اشتراك", "ابدا", "start", "subscribe", "resume", "اشترك"].map(normalize));
const CANCEL_BARE = new Set(["الغاء", "الغ", "cancel"].map(normalize));

/* أرقام الناس «٥٠ شخص» / «for 20 people» */
function peopleCount(n) {
  const m = n.match(/(\d{1,4})\s*(?:شخص|اشخاص|نفر|انفار|فرد|افراد|ضيف|ضيوف|people|persons|pax|guests)/);
  if (m) return Number(m[1]);
  if (/(?:^| )(?:عشرين|عشرينات) (?:شخص|نفر)/.test(n)) return 20;
  if (/(?:^| )(?:خمسين) (?:شخص|نفر)/.test(n)) return 50;
  if (/(?:^| )(?:مي[هت]|ميه) (?:شخص|نفر)/.test(n)) return 100;
  return null;
}
export const ORDER_NO_RE = /\b(W\d{10,15})\b/i;

/* ═══ المنيو: فهرسة ومطابقة ════════════════════════════════════════════ */
/* فئات المنيو بالعنوان الإنجليزي للصفحة (ثابت في TabSense) */
export const CATEGORY_ALIASES = [
  { title: "Meals", words: ["وجبه", "وجبات", "meal", "meals", "wajba"] },
  { title: "Grills by the Kilo", words: ["مشاوي", "مشويات", "بالوزن", "بالكيلو", "كيلو", "grill", "grills", "bbq", "mashawi", "على الفحم", "مشاوي بالوزن", "مشاوي بالكيلو"] },
  { title: "Crepes", words: ["كريب", "كريبات", "كريبس", "crepe", "crepes", "krep"] },
  { title: "Pizza", words: ["بيتزا", "بيتزه", "بيزا", "pizza", "pizzas"] },
  { title: "Skillets", words: ["طاسه", "طاسات", "طواسي", "skillet", "skillets"] },
  { title: "Pasta", words: ["باستا", "مكرونه", "مكرونات", "معكرونه", "pasta", "macaroni"] },
  { title: "Burgers", words: ["برجر", "برقر", "بيرجر", "برغر", "burger", "burgers"] },
  { title: "Hawawshi", words: ["حواوشي", "hawawshi", "7awawshi"] },
  { title: "Sides & Drinks", words: ["اضافات", "مشروبات", "مشروب", "بيبسي", "مويه", "ماء", "عصير", "drinks", "sides", "side", "pepsi", "water", "soft drink", "soft drinks", "مقبلات"] },
].map((c) => ({ ...c, re: W(c.words) }));
const MERCH = new Set(["Best Sellers", "Offers"]);

const SYN = {
  فراخ: "دجاج", فرخه: "دجاجه", فرخ: "دجاج", دجاجه: "دجاجه", نص: "نصف", برقر: "برجر", برغر: "برجر", بيرجر: "برجر",
  بيتزه: "بيتزا", بيزا: "بيتزا", كفته: "كفته", تاوك: "طاووق", طاوق: "طاووق", طاووك: "طاووق", طاووق: "طاووق", زنقر: "زنجر",
  زنجر: "زنجر", كرنشي: "كرانشي", كرانشى: "كرانشي", ستربس: "ستربس", استربس: "ستربس", بشميل: "بشاميل", الفريدو: "الفريدو",
  فريدو: "الفريدو", شيز: "تشيز", جبن: "جبنه", مشويه: "مشوي", مشويات: "مشوي", مشاوي: "مشوي", ريشه: "ريش", كبده: "كبده",
  سجق: "سجق", سوسيس: "سجق", مكرونه: "مكرونه", بطاطا: "بطاطس", فرايز: "فرايز", fries: "فرايز", chicken: "دجاج",
  beef: "لحم", لحمه: "لحم", كباب: "كباب", kebab: "كباب", kofta: "كفته", "شاورمه": "شاورما", steak: "ستيك", ستيك: "ستيك",
};
const STOPWORDS = new Set(["bkam", "bkm", "el", "al", "بكم", "بكام", "كم", "سعر", "اسعار", "السعر", "حق", "قيمه", "ثمن", "ابي", "ابغى", "ابغي", "ابا", "عندكم",
  "عندك", "في", "فيه", "هل", "وش", "ايش", "شو", "ايه", "من", "على", "مع", "و", "او", "يا", "لو", "ممكن", "اطلب", "طلب", "ودي",
  "the", "how", "much", "is", "a", "an", "of", "for", "price", "prices", "do", "you", "have", "i", "want", "please", "pls", "plz",
  "لو سمحت", "سمحت", "الله", "يعطيك", "العافيه", "الحين", "اليوم", "كام", "تكلف", "يكلف", "حبه", "واحد", "وحده", "بس", "ايوه",
  "طيب", "مرحبا", "هلا", "السلام", "عليكم", "كيف", "متوفر", "موجود", "فيه", "عندكم", "cost", "costs", "what", "whats", "your",
  "مكونات", "المكونات", "مكوناته", "وصف", "تفاصيل", "details", "ingredients", "يجي", "معه", "حار", "حاره", "spicy", "يكفي", "كم", "شخص",
  "and", "with", "in", "to", "on", "or", "my", "me", "it", "does", "serve"].map(normalize));

const stripAl = (w) => (w.length > 4 && w.startsWith("ال") ? w.slice(2) : w.length > 4 && /^[وفبل]ال/.test(w) ? w.slice(3) : w);
function canon(tok) {
  let w = tok;
  if (SYN[w]) return SYN[w];
  w = stripAl(w);
  if (SYN[w]) return SYN[w];
  if (w.length > 3 && /^[وب]/.test(w) && !/^(وجب|بطا|بيت|بسط|برج|بنا|بيف|بيب|بصل|بشا|بار|باس)/.test(w)) {
    const w2 = w.slice(1); if (SYN[w2]) return SYN[w2];
  }
  return w;
}
export const tokens = (s) => normalize(s).split(" ").filter(Boolean).map(canon);

/* الصفحات الحية → فهرس { items:[{id,name,nameEn,desc,price,image,category,categoryAr,tokens}], categories } */
export function indexMenu(pages = [], { hiddenIds = [], soldOut = {} } = {}) {
  const hidden = new Set((hiddenIds || []).map(String));
  const items = [], seen = new Map(), cats = [];
  const byRank = [...pages].sort((a, b) => (MERCH.has(a.title) ? 1 : 0) - (MERCH.has(b.title) ? 1 : 0));
  for (const p of byRank) {
    const catItems = [];
    for (const it of p.items || []) {
      const id = String(it.id);
      if (hidden.has(id)) continue;
      const price = Number(it.retail_price != null ? it.retail_price : it.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      let row = seen.get(id);
      if (!row) {
        const name = String(it.name || it.local_name || "").trim();
        const nameEn = String(it.local_name || "").trim();
        row = {
          id, name, nameEn, desc: String(it.description || "").trim(), price, image: it.image || "",
          category: p.title, categoryAr: p.local_title || p.title, soldOut: Boolean(soldOut[id]),
          byWeight: p.title === "Grills by the Kilo" || /بالوزن/.test(name),
        };
        row.tokens = [...new Set([...tokens(name), ...tokens(nameEn)])].filter((t) => !STOPWORDS.has(t));
        seen.set(id, row); items.push(row);
      }
      catItems.push(row);
    }
    cats.push({ id: String(p.id), title: p.title, titleAr: p.local_title || p.title, items: catItems, merch: MERCH.has(p.title) });
  }
  const df = new Map();
  for (const it of items) for (const t of it.tokens) df.set(t, (df.get(t) || 0) + 1);
  return { items, categories: cats.filter((c) => c.items.length), df };
}

export function findCategory(menu, n) {
  for (const a of CATEGORY_ALIASES) if (a.re.test(n)) {
    const c = (menu?.categories || []).find((x) => x.title === a.title);
    if (c) return c;
  }
  return null;
}

/* مطابقة الأصناف: كل كلمة لها وزن = ١/عدد الأصناف اللي فيها (الكلمة النادرة تفرق) */
export function findItems(menu, text) {
  if (!menu?.items?.length) return { items: [], leftovers: [] };
  const q = [...new Set(tokens(text))].filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (!q.length) return { items: [], leftovers: [] };
  const scored = [];
  for (const it of menu.items) {
    let s = 0, hits = 0, rare = false;
    for (const t of q) {
      const hit = it.tokens.includes(t) || (t.length >= 4 && it.tokens.some((x) => x.length >= 4 && (x.startsWith(t) || t.startsWith(x))));
      if (hit) {
        const d = menu.df.get(t) || it.tokens.filter((x) => x.startsWith(t)).length || 1;
        s += 1 / d; hits++; if (d <= 4) rare = true;
      }
    }
    if (hits && rare) scored.push({ it, s, hits });
  }
  const known = new Set(menu.items.flatMap((i) => i.tokens));
  const leftovers = q.filter((t) => !known.has(t) && ![...known].some((k) => k.length >= 4 && t.length >= 4 && (k.startsWith(t) || t.startsWith(k))));
  if (!scored.length) return { items: [], leftovers };
  scored.sort((a, b) => b.hits - a.hits || b.s - a.s);
  const top = scored[0];
  const best = scored.filter((x) => x.hits === top.hits && x.s >= top.s * 0.5).slice(0, 6).map((x) => x.it);
  return { items: best, leftovers };
}

/* الأحياء المعروفة (قائمة جدول التوصيل بالحي) — للتعرّف على اسم الحي فقط */
const DISTRICT_NAMES = Object.values(SEED_PRICE_LIST).flat();
const DISTRICT_KEYS = DISTRICT_NAMES.map((d) => ({ name: d.replace(/^حي /, ""), key: normalize(d.replace(/^حي /, "")).replace(/^ال/, "") }));
export function extractDistrict(text) {
  const n = normalize(text);
  const m = n.match(/(?:^| )حي ([^ ]+(?: [^ ]+)?)/);
  const cands = [];
  if (m) cands.push(m[1]);
  const m2 = n.match(/(?:توصلون|توصلوا|توصلو|يوصل|توصيل|deliver to|delivery to)(?: ل| الى| على| لحي| حي)? ([^ ]+(?: [^ ]+)?)/);
  if (m2) cands.push(m2[1]);
  for (const c of cands) {
    const k = normalize(c).replace(/^(ل|ال|لل)/, "").replace(/^ال/, "");
    const hit = DISTRICT_KEYS.find((d) => d.key === k) || DISTRICT_KEYS.find((d) => k.startsWith(d.key) && d.key.length >= 3)
      || DISTRICT_KEYS.find((d) => normalize(c).startsWith(normalize(d.name)))
      || (k.length >= 4 ? DISTRICT_KEYS.find((d) => d.key.startsWith(k)) : null);
    if (hit) return { name: hit.name, known: true };
  }
  for (const d of DISTRICT_KEYS) {
    if (d.key.length >= 4 && new RegExp(`(?:^| )(?:ال|لل|ل)?${esc(d.key)}(?= |$)`).test(n)) return { name: d.name, known: true };
  }
  if (m) return { name: m[1].split(" ")[0], known: false };
  return null;
}

/* ═══ تعريف النوايا (جدول المراجعة + أمثلة الاختبار) ═══════════════════ */
export const INTENTS = [
  { name: "greeting", label: "تحية", reply: "buttons", sources: ["settings.hours", "profileName"],
    examples: ["السلام عليكم", "مرحبا", "هلا والله", "hi", "hello", "salam", "مساء الخير", "هااااي"] },
  { name: "menu", label: "المنيو", reply: "list", sources: ["/api/menu (الصفحات الحية)"],
    examples: ["المنيو", "ارسل المنيو لو سمحت", "وش عندكم؟", "ممكن المنيو", "menu please", "send me the menu", "ايش عندكم اكل", "el menu law sama7t", "بيتزا", "عندكم كريبات؟"] },
  { name: "item_price", label: "سعر صنف", reply: "text/cta", sources: ["/api/menu"],
    examples: ["بكم نص دجاجة؟", "كم سعر الكفتة", "بكم البيتزا", "سعر كريب زنجر", "how much is the pepperoni pizza", "bkam el burger", "كم سعر ريش مشوية", "اسعار المشاوي", "بكام الحواوشي", "بكم الستيك"] },
  { name: "item_info", label: "مكونات/تفاصيل صنف", reply: "cta (صورة)", sources: ["/api/menu description"],
    examples: ["وش فيه كريب ميكس لحوم", "مكونات طاسة كرانشي", "ايش يجي مع وجبة ميكس جريل", "كريب سوبر كرانشي", "what's in the mac and cheese", "تفاصيل بيتزا سي فود رانش", "حواوشي كيري بسطرمة", "وش يجي فيه نجرسكو"] },
  { name: "recommend", label: "اقتراحات", reply: "list", sources: ["Best Sellers page", "offer_registry", "/api/menu"],
    examples: ["وش تنصحني", "ايش الاكثر طلب عندكم", "اقترح علي شي", "وش احلى شي عندكم", "what do you recommend", "best seller?", "شي رخيص وحلو", "ابي شي للعائلة", "محتار وش اطلب", "a7san 7aga 3andko"] },
  { name: "servings", label: "يكفي كم شخص", reply: "text", sources: ["offer_registry titles"],
    examples: ["المشكل يكفي كم شخص", "الكيلو يكفي كم نفر", "كم شخص يكفي الطاسة", "how many people does the kilo serve", "يشبع ٣ اشخاص؟", "وجبة دجاجة كاملة تكفي كم", "كم يكفي كيلو الكفتة", "الباقة تكفي كم"] },
  { name: "offers", label: "العروض والكوبونات", reply: "text + cta", sources: ["offer_registry", "shop_coupons (publicCoupons)", "dl_policies feeByTotal"],
    examples: ["فيه عروض؟", "عروض اليوم", "عندكم خصم", "any offers?", "discount", "كوبون خصم", "وش العروض", "3rood el nharda", "في كود خصم؟", "deals today"] },
  { name: "coupon_help", label: "الكود ما يشتغل", reply: "text + buttons", sources: ["shop_coupons", "shop_orders (طلبات سابقة)"],
    examples: ["الكود ما يشتغل", "كود FIRST مرفوض", "الكوبون غلط", "coupon not working", "the code is invalid", "حطيت الكود وما انخصم", "ليش الكود ما يزبط", "first code doesnt work", "الكود يقول منتهي"] },
  { name: "how_to_order", label: "طريقة الطلب/الاستلام", reply: "cta", sources: ["STORE link", "service.js"],
    examples: ["كيف اطلب", "ابي اطلب", "رابط الطلب", "how can i order", "i want to order", "abi atlob", "ابي استلم من الفرع", "عندكم سفري؟", "pickup available?", "ارسل اللينك"] },
  { name: "delivery", label: "التوصيل (عام)", reply: "text + buttons", sources: ["dl_policies", "shop_coupons FIRST"],
    examples: ["توصيل؟", "عندكم توصيل", "delivery?", "do you have delivery", "التوصيل", "فيه توصيل للبيت", "twseel", "tawseel 3andko"] },
  { name: "delivery_area", label: "توصلون حيّي؟", reply: "text + buttons", sources: ["dl_policies (maxKm/farZone)", "district names", "delivery quote (موقع مرسل)"],
    examples: ["توصلون حي الصفا؟", "توصلون الروضة", "هل توصلون لحي النزهة", "do you deliver to al rawdah", "يوصل حي السلامة؟", "توصلون ابحر؟", "مناطق التوصيل", "وين توصلون", "نطاق التوصيل كم"] },
  { name: "delivery_fee", label: "رسوم التوصيل", reply: "text", sources: ["dl_policies.feeByTotal", "shop_coupons FIRST"],
    examples: ["كم رسوم التوصيل", "التوصيل بكم", "سعر التوصيل", "delivery fee?", "is delivery free", "التوصيل مجاني؟", "رسوم التوصيل لحي الصفا", "كم التوصيل"] },
  { name: "delivery_time", label: "مدة التوصيل", reply: "text", sources: ["settings.waBot.facts.deliveryTime", "FAQ"],
    examples: ["كم ياخذ التوصيل", "كم وقت التوصيل", "how long does delivery take", "كم دقيقة يوصل", "مدة التوصيل كم", "delivery time?", "التوصيل كم يطول", "كم يستغرق التوصيل"] },
  { name: "min_order", label: "الحد الأدنى", reply: "text", sources: ["dl_policies.minOrderTotal", "shop_coupons.min_total"],
    examples: ["الحد الأدنى للطلب", "كم اقل طلب", "minimum order?", "فيه حد ادنى", "اقل مبلغ للتوصيل", "min order", "اقل شي اطلب كم", "الحد الادنى للتوصيل كم"] },
  { name: "hours", label: "المواعيد", reply: "text", sources: ["settings.hours"],
    examples: ["متى تفتحون", "متى تقفلون", "مواعيد الدوام", "ساعات العمل", "opening hours", "what time do you close", "لين متى فاتحين", "mawa3eed el sho8l", "اوقات الدوام", "الدوام متى يبدا"] },
  { name: "open_now", label: "مفتوحين الحين؟", reply: "text", sources: ["settings.hours", "service.js pause"],
    examples: ["مفتوحين؟", "فاتحين الحين", "are you open now", "open?", "شغالين الحين", "لسا فاتحين؟", "fat7een?", "المطعم مفتوح؟"] },
  { name: "special_hours", label: "رمضان/العيد", reply: "text", sources: ["settings.waBot.facts.specialHours", "settings.hours"],
    examples: ["دوامكم في رمضان", "مواعيدكم في العيد", "ramadan hours", "متى تفتحون في العيد", "دوام اليوم الوطني", "eid opening hours", "مواعيد رمضان", "تفتحون في الاجازة؟"] },
  { name: "location", label: "الموقع", reply: "cta (خرائط)", sources: ["settings.storefront.seo.faq", "settings.googlePlace.mapsUrl"],
    examples: ["وين موقعكم", "ارسل اللوكيشن", "وين المطعم", "where are you located", "address?", "location", "عندكم فروع؟", "wenkom", "كيف اوصلكم", "ابي الموقع على الخريطة"] },
  { name: "parking", label: "المواقف", reply: "text", sources: ["settings.waBot.facts.parking"],
    examples: ["فيه مواقف؟", "المواقف متوفرة", "parking available?", "وين اصف سيارتي", "is there parking", "مواقف سيارات عندكم", "باركنج؟", "وين اوقف السيارة"] },
  { name: "dine_in", label: "الجلسات/العوائل", reply: "text", sources: ["settings.waBot.facts.dineIn/familySection"],
    examples: ["عندكم جلسات؟", "فيه قسم عوائل", "ينفع ناكل في المطعم", "dine in available?", "do you have seating", "family section?", "الصالة كبيرة؟", "جلسات داخلية"] },
  { name: "payment", label: "طرق الدفع", reply: "text", sources: ["settings.storefront.seo.faq (طرق الدفع)", "settings.waBot.facts.cash"],
    examples: ["طرق الدفع", "اقدر ادفع كاش؟", "الدفع عند الاستلام؟", "تقبلون مدى", "apple pay?", "cash on delivery", "تابي؟", "payment methods", "تقبلون فيزا", "stc pay متوفر"] },
  { name: "payment_issue", label: "مشكلة دفع", reply: "text + handoff", sources: ["handoff"],
    examples: ["ما قدرت ادفع", "انخصم المبلغ وما وصل تاكيد", "payment failed", "charged twice", "الدفع ما تم", "انسحب المبلغ مرتين", "تعذر اتمام الدفع", "دفعت وما جاني شي"] },
  { name: "special_request", label: "طلب خاص (بدون/زيادة)", reply: "text (+تحويل لو فيه طلب نشط)", sources: ["shop_orders (طلب نشط)"],
    examples: ["بدون بصل لو سمحت", "no onions please", "زيادة صوص", "extra cheese", "بدون مخلل", "من غير طحينة", "ابي الصوص على جنب", "without mayo", "خفيف ملح"] },
  { name: "site_issue", label: "الموقع/الطلب ما يشتغل", reply: "text + handoff (عاجل)", sources: ["handoff"],
    examples: ["الموقع ما يفتح", "ما قدرت اطلب من الموقع", "website not working", "الرابط ما يشتغل", "الموقع معلق", "cant order from the site", "الصفحة ما تفتح", "الموقع فيه مشكلة"] },
  { name: "order_status", label: "وين طلبي", reply: "cta (تتبع)", sources: ["shop_orders (جوال الواتساب)", "/api/shop/track"],
    examples: ["وين طلبي", "متى يوصل طلبي", "where is my order", "حالة الطلب", "wen talabi", "تتبع الطلب", "طلبي W1790012345678", "track my order", "وين المندوب", "الطلب جاهز؟"] },
  { name: "cancel_or_stop", label: "«إلغاء» لوحدها وعنده طلب نشط", reply: "buttons", sources: ["shop_orders"], contextual: true,
    examples: ["الغاء", "إلغاء", "cancel", "الغ", "الغاء!", "إلغاء.", "CANCEL", "الغاااء"] },
  { name: "cancel_order", label: "إلغاء الطلب", reply: "text + handoff", sources: ["shop_orders", "handoff"],
    examples: ["ابي الغي الطلب", "الغاء الطلب", "كنسل الطلب", "cancel my order", "ابغى الغي طلبي", "لا تسوون الطلب", "cancel order please", "بلغي الطلب"] },
  { name: "modify_order", label: "تعديل الطلب/العنوان", reply: "text + handoff", sources: ["handoff"],
    examples: ["ابي اعدل الطلب", "نسيت اضيف بيبسي", "ابي اغير العنوان", "العنوان غلط", "change my order", "wrong address", "تعديل الطلب", "add fries to my order"] },
  { name: "complaint", label: "شكوى", reply: "text + handoff (تذكرة)", sources: ["shop_orders", "handoff"],
    examples: ["الاكل وصل بارد", "الطلب ناقص", "جاني طلب غلط", "طلبي متأخر ساعة", "the food was cold", "missing item", "الاكل محروق", "عندي شكوى", "تجربة سيئة", "صار عندي تسمم"] },
  { name: "refund", label: "استرجاع", reply: "text + handoff", sources: ["shop_orders", "handoff"],
    examples: ["ابي استرجاع المبلغ", "رجعوا فلوسي", "refund please", "ابغى فلوسي", "متى يرجع المبلغ", "i want my money back", "استرداد", "ابي تعويض"] },
  { name: "dietary", label: "حساسية/نباتي/حلال/حار", reply: "text (أو تحويل)", sources: ["/api/menu description", "settings.waBot.facts"],
    examples: ["عندي حساسية من المكسرات", "فيه اكل نباتي؟", "الاكل حلال؟", "كريب زنجر حار؟", "gluten free options?", "is it halal", "vegetarian?", "فيه شي حار", "السعرات كم", "بيتزا خضروات نباتية؟"] },
  { name: "kids_menu", label: "منيو أطفال", reply: "text", sources: ["settings.waBot.facts.kids", "/api/menu"],
    examples: ["عندكم وجبات اطفال", "منيو اطفال", "kids menu?", "شي للبزران", "وجبة طفل", "kids meal", "اكل للصغار", "شي يناسب الاطفال"] },
  { name: "catering", label: "طلبات كبيرة/مناسبات", reply: "text + handoff", sources: ["offer_registry (باقات)", "handoff"],
    examples: ["ابي طلب لـ ٥٠ شخص", "عندكم تموين حفلات", "عزيمة ٢٠ نفر", "catering for an event", "large order for office", "طلب كبير لشركة", "عندنا مناسبة", "بوفيه زواج"] },
  { name: "reservation", label: "حجز طاولة", reply: "text", sources: ["settings.waBot.facts.reservations"],
    examples: ["ابي احجز طاولة", "الحجز متاح؟", "reservation", "book a table for 4", "نحجز لعشرة", "كيف احجز", "حجز لليوم", "do you take reservations"] },
  { name: "preorder", label: "طلب مجدول", reply: "text", sources: ["settings.preorder"],
    examples: ["ابي اطلب لبكرة", "طلب مسبق", "اقدر اجدول الطلب", "schedule an order", "يوصلني الساعة ٩", "order for tomorrow", "احدد موعد التوصيل", "pre order"] },
  { name: "jobs", label: "وظائف", reply: "text", sources: ["settings.waBot.facts.jobs"],
    examples: ["فيه وظايف؟", "ابي اشتغل عندكم", "توظيف", "hiring?", "job vacancy", "ارسل سي في", "تحتاجون طباخ", "careers"] },
  { name: "partnership", label: "تعاون/إعلانات/موردين", reply: "text + handoff", sources: ["settings.waBot.facts.partnerships"],
    examples: ["نبي نتعاون معكم", "تعاون اعلاني", "انا بلوقر", "influencer collab", "مورد لحوم", "supplier", "partnership proposal", "وكالة تسويق"] },
  { name: "delivery_apps", label: "تطبيقات التوصيل", reply: "text + cta", sources: ["order_sources (٢٨/٩)", "shop_coupons FIRST"],
    examples: ["انتم في هنقرستيشن؟", "موجودين على كيتا", "jahez?", "hungerstation", "ليش في التطبيق اغلى", "عندكم تطبيق؟", "انتم على جاهز", "ninja?"] },
  { name: "invoice", label: "فاتورة ضريبية", reply: "text + handoff", sources: ["FAQ الضريبة", "handoff"],
    examples: ["ابي فاتورة", "فاتورة ضريبية", "invoice please", "الاسعار شاملة الضريبة؟", "الرقم الضريبي", "vat invoice", "ارسلوا الفاتورة", "receipt"] },
  { name: "feedback", label: "ملاحظة/تقييم", reply: "cta (تقييم)", sources: ["settings.reviews.googleUrl", "/r"],
    examples: ["عندي ملاحظة", "ابي اقيم", "الاكل خطير", "feedback", "لذيذ مره", "amazing food", "عندي اقتراح", "ابدعتوا"] },
  { name: "human", label: "كلّم موظف", reply: "text + handoff", sources: ["handoff", "FAQ الجوال"],
    examples: ["ابي اكلم موظف", "خدمة العملاء", "talk to a human", "customer service", "كلموني", "رقمكم", "ابي المدير", "محد يرد", "call me", "agent"] },
  { name: "stop", label: "إيقاف الرسائل", reply: "text", sources: ["action optout"],
    examples: ["إيقاف", "stop", "لا ترسلون لي", "الغاء الاشتراك", "unsubscribe", "وقفوا الرسايل", "ايقاف العروض", "احذفوا رقمي"] },
  { name: "start", label: "رجوع الاشتراك", reply: "text", sources: ["action optin"],
    examples: ["اشتراك", "start", "رجعوني", "subscribe", "ابدأ", "ارسلوا لي العروض", "resubscribe", "ابي اشترك"] },
  { name: "thanks", label: "شكر", reply: "text", sources: [],
    examples: ["شكرا", "مشكور", "يعطيك العافية", "thanks", "thank you", "ما قصرتوا", "تسلم", "جزاك الله خير"] },
  { name: "bye", label: "وداع", reply: "text", sources: [],
    examples: ["مع السلامة", "باي", "bye", "في امان الله", "goodbye", "تصبح على خير", "see you", "bye bye"] },
  { name: "waitlist_join", label: "ذكّرني لما تفتحون", reply: "text", sources: ["action waitlist_join", "settings.hours"],
    examples: ["ذكرني لما تفتحون", "نبهني اذا فتحتوا", "remind me when you open", "notify me", "بلغوني اذا فتحتوا", "ذكروني", "نبهوني", "let me know when you open"] },
  { name: "ad_welcome", label: "ترحيب إعلان (CTWA)", reply: "buttons + cta", sources: ["referral", "offer_registry", "shop_coupons FIRST"],
    examples: ["[referral] مرحبا", "[referral] السلام عليكم", "[referral] hi", "[referral] ابي اطلب", "[referral] العرض", "[referral] كم السعر", "[referral] hello", "[referral] 👋"] },
  { name: "media", label: "صورة/صوت/ملف", reply: "text (+تحويل)", sources: [],
    examples: ["[image]", "[audio]", "[video]", "[document]", "[sticker]", "[voice]", "[contacts]", "[unsupported]"] },
  { name: "unknown", label: "غير مفهوم", reply: "list (قائمة المواضيع)", sources: [],
    examples: ["asdkjh", "؟؟", "١٢٣", "طيب وبعدين", "hmm", "zzz", "......", "كذا"] },
];
export const INTENT_NAMES = INTENTS.map((i) => i.name);

/* ═══ matchIntent — صافية ════════════════════════════════════════════════
   ctx (اختياري): { menu (indexMenu), order (آخر طلب نشط), lastPrompt,
   type, replyId, referral, location, firstMessage }
   ⇒ { intent, score, lang, entities, scores } */
const REPLY_IDS = {
  menu: "menu", offers: "offers", status: "order_status", delivery: "delivery", fee: "delivery_fee", hours: "hours",
  location: "location", human: "human", how: "how_to_order", waitlist: "waitlist_join", stop: "stop", start: "start",
  cancel_order: "cancel_order", pay: "payment", rec: "recommend", apps: "delivery_apps", pickup: "how_to_order",
};
export function matchIntent(text, ctx = {}) {
  const raw = String(text || "");
  const n = normalize(raw);
  const lang = detectLang(raw);
  const entities = {};
  const out = (intent, score = 10, extra = {}) => ({ intent, score, lang, entities: { ...entities, ...extra }, n });

  // ١) رد على زر/قائمة: المعرّف يحسم
  if (ctx.replyId) {
    const id = String(ctx.replyId);
    const [k, v] = id.split(":");
    if (k === "cat") return out("menu", 10, { categoryId: v });
    if (k === "item") return out("item_info", 10, { itemId: v });
    if (k === "rec") return out("recommend", 10, { sub: v || "best" });
    if (k === "addr") return out(v === "ok" ? "thanks" : "modify_order", 10, { addr: v });
    if (REPLY_IDS[k]) return out(REPLY_IDS[k], 10);
  }
  // ٢) أنواع مو نص
  const type = ctx.type || "text";
  if (type === "location" || ctx.location) return out("delivery_area", 10, { location: ctx.location || null });
  if (ctx.referral && ctx.firstMessage !== false && !n.match(/وين طلبي|الغ|شكو|cancel/)) return out("ad_welcome", 10);
  if (["image", "audio", "voice", "video", "document", "sticker", "contacts", "unsupported", "reaction"].includes(type) && !n) {
    return out("media", 10, { mediaType: type });
  }
  if (!n) return out("unknown", 0);

  // ٣) الإيقاف والاشتراك أول شي (امتثال)
  if (CANCEL_BARE.has(n)) {
    if (ctx.order && ctx.order.active) return out("cancel_or_stop", 10);
    return out("stop", 10);
  }
  if (STOP_EXACT.has(n) || V.stopPhrase.test(n)) return out("stop", 12);
  if (START_EXACT.has(n) || V.startPhrase.test(n)) return out("start", 11);

  // ٤) الكيانات
  const om = raw.match(ORDER_NO_RE);
  if (om) entities.orderNo = om[1].toUpperCase();
  const people = peopleCount(n);
  if (people) entities.people = people;
  const menu = ctx.menu || null;
  const greetG = new RegExp(V.greet.source, "g");
  const f = menu ? findItems(menu, n.replace(greetG, " ")) : { items: [], leftovers: [] };
  const cat = menu ? findCategory(menu, n) : null;
  // الصنف «حقيقي» لو فيه كلمة مميزة مو بس اسم الفئة
  const catWords = cat ? new Set(CATEGORY_ALIASES.find((a) => a.title === cat.title).words.flatMap((w) => tokens(w))) : new Set();
  const content = [...new Set(tokens(n.replace(greetG, " ")))].filter((x) => x.length >= 2 && !STOPWORDS.has(x));
  const onlyCat = cat && content.length > 0 && content.every((x) => catWords.has(x) || [...catWords].some((w) => w.length >= 4 && (x.startsWith(w) || w.startsWith(x))));
  const itemsSpecific = f.items.length && f.items.length <= 6 && !onlyCat && !(cat && f.items.length >= Math.min(cat.items.length, 6) && f.items.every((i) => i.category === cat.title));
  if (itemsSpecific) entities.items = f.items.map((i) => i.id);
  if (cat) entities.categoryId = cat.id;
  if (f.leftovers.length) entities.unknownWords = f.leftovers.filter((w) => !catWords.has(w)).slice(0, 3);
  const district = extractDistrict(raw);
  if (district) entities.district = district;
  if (/ستيك|steak/.test(n)) entities.notOnMenu = "ستيك";
  else if (/شاورما|shawarma/.test(n)) entities.notOnMenu = "شاورما";

  // ٥) النقاط
  const S = Object.fromEntries(INTENT_NAMES.map((k) => [k, 0]));
  const t = (re) => re.test(n);
  const has = Object.fromEntries(Object.keys(V).map((k) => [k, t(V[k])]));

  if (has.greet) S.greeting += 1;
  if (has.menu) S.menu += 4;
  if (cat && !itemsSpecific && !has.price) S.menu += 3;
  if (has.price) { S.item_price += 3; if (itemsSpecific) S.item_price += 3; if (cat) S.item_price += 2; if (entities.notOnMenu) S.item_price += 3; }
  if (itemsSpecific && !has.price) S.item_info += 3.5;
  if (has.ingredients) { S.item_info += 2; if (itemsSpecific) S.item_info += 3; }
  if (entities.notOnMenu && !has.price) S.item_price += 4;
  if (has.recommend) S.recommend += 4;
  if (has.family) S.recommend += 2;
  if (has.budget) S.recommend += 3;
  if (has.servings) { S.servings += 5; if (itemsSpecific || cat) S.servings += 1; }
  if (has.offers) S.offers += 4;
  if (has.coupon) { S.offers += 3; if (has.problem) S.coupon_help += 9; }
  if (has.how) S.how_to_order += 4;
  if (has.pickup) S.how_to_order += 3.5;
  if (has.delivery) S.delivery += 3;
  if (has.area) S.delivery_area += 4.5;
  if (district && (has.delivery || has.area)) S.delivery_area += 3;
  if (has.fee) S.delivery_fee += (has.delivery || /رسوم|fee/.test(n)) ? 6 : 3;
  if (has.fee && (has.dtime || has.area) && !/رسوم|fee|مجاني|free/.test(n)) S.delivery_fee -= 3;
  if (has.fee && /رسوم|fee|charge/.test(n)) S.delivery_fee += 2;
  if (has.delivery && has.price && !itemsSpecific && !cat) S.delivery_fee += 6;
  if (has.dtime) S.delivery_time += 4.5;
  if (has.minOrder) S.min_order += 6;
  if (has.hours) S.hours += 5;
  if (has.openNow) S.open_now += 5;
  if (has.special && (has.hours || has.openNow)) S.special_hours += 9;
  if (has.location) S.location += 5;
  if (has.locationWeak && !has.how && !has.delivery) S.location += 2;
  if (has.parking) S.parking += 6;
  if (has.dineIn) S.dine_in += 5;
  if (has.payment) S.payment += 4;
  if (has.payIssue) S.payment_issue += 7.5;
  if (has.status) S.order_status += 5;
  if (entities.orderNo) S.order_status += 4;
  if (has.late) { S.complaint += 3; if (has.status || entities.orderNo) S.complaint += 2.5; }
  if (has.cancel) S.cancel_order += 7;
  if (has.modify) S.modify_order += 7;
  if (has.complaint) S.complaint += 6;
  if (has.severe) S.complaint += 10;
  if (has.refund) S.refund += 7;
  if (has.dietary) { S.dietary += 5; if (itemsSpecific || cat) S.dietary += 1.5; }
  if (has.kids) S.kids_menu += 6;
  if (has.catering) S.catering += 6;
  if (people && people >= 15) S.catering += 5;
  if (people && people < 15 && (has.family || has.servings || has.recommend)) S.recommend += 1;
  if (has.reserve) S.reservation += 7;
  if (has.preorder) S.preorder += 5;
  if (has.jobs) S.jobs += 6.5;
  if (has.partner) S.partnership += 6;
  if (has.apps) S.delivery_apps += 5.5;
  if (has.app) S.delivery_apps += 4;
  if (has.invoice) S.invoice += 6;
  if (has.feedback) S.feedback += 4;
  if (has.human) S.human += 6;
  if (has.siteIssue) { S.site_issue += 8; }
  if (/(?:^| )add (?:.+ )?to (?:my )?order/.test(n)) S.modify_order += 7;
  if (has.pickup) S.location -= 3;
  if (has.hours && has.openNow) S.hours += 1;
  if (has.thanks) S.thanks += 3;
  if (has.bye) S.bye += 3;
  if (has.remind) S.waitlist_join += 6;

  // «متى يوصل طلبي» = حالة طلب مو مدة توصيل عامة
  const mine = /طلبي|طلبيتي|my order|talabi|talaby|w\d{6}/.test(n);
  if (has.status && has.dtime) { if (mine) S.delivery_time -= 2; else S.order_status -= 2; }
  if (has.dtime && /عاده|عادتا|usually|normally|غالبا/.test(n)) S.delivery_time += 3;
  if (people && people < 15) S.catering -= 3;
  if (has.custom) { S.special_request += 4.5; if (itemsSpecific) S.item_info -= 2; }
  // مدح بدون شكوى = ملاحظة إيجابية
  if (has.feedback && has.complaint) S.feedback -= 2;
  // «فيه شي حار» بدون صنف = غذائي مو سعر
  // الشكر مع سؤال = السؤال يكسب
  const best = Object.entries(S).sort((a, b) => b[1] - a[1] || PRIO.indexOf(a[0]) - PRIO.indexOf(b[0]));
  let [intent, score] = best[0];

  // ٦) متابعة «ايوه/لا» على آخر سؤال
  if (score < 3 && (has.yes || has.no) && ctx.lastPrompt) {
    if (has.yes) return out(ctx.lastPrompt, 8, { followUp: true });
    return out("thanks", 6, { declined: ctx.lastPrompt });
  }
  if (score < 1) return out("unknown", 0);
  if (entities.people && intent === "recommend") entities.sub = "family";
  if (intent === "recommend") entities.sub = entities.sub || (has.budget ? "budget" : has.family ? "family" : "best");
  if (intent === "complaint") {
    entities.severity = has.severe ? "high" : "normal";
    entities.kind = has.severe ? "health" : has.late ? "late" : /بارد|cold/.test(n) ? "cold" : /ناقص|missing|نقص|نسيتوا/.test(n) ? "missing" : /غلط|wrong|مو طلبي|مب طلبي|مش طلبي/.test(n) ? "wrong" : "general";
  }
  if (intent === "dietary") {
    entities.topic = /حلال|halal/.test(n) ? "halal" : /نباتي|vegan|vegetarian|veggie|فيجن/.test(n) ? "vegetarian"
      : /جلوتين|قلوتين|غلوتين|gluten/.test(n) ? "gluten" : /(?:^| )(?:حار|حاره|سبايسي|spicy|حراق|حراقه)(?= |$)/.test(n) ? "spicy"
      : /سعرات|calories|كالوري|دايت|diet|كيتو|keto|صحي|healthy/.test(n) ? "calories" : "allergy";
  }
  if (intent === "how_to_order" && has.pickup) entities.sub = "pickup";
  if (intent === "delivery_apps" && has.app) entities.sub = "own_app";
  return { intent, score, lang, entities, n, scores: Object.fromEntries(best.filter(([, v]) => v > 0).slice(0, 4)) };
}
/* ترتيب الحسم عند التعادل: الأخطر/الأدق أول */
const PRIO = ["stop", "start", "cancel_or_stop", "complaint", "payment_issue", "site_issue", "special_request", "cancel_order", "modify_order", "refund", "coupon_help", "order_status",
  "special_hours", "catering", "reservation", "jobs", "partnership", "invoice", "dietary", "kids_menu", "servings", "min_order",
  "delivery_fee", "delivery_area", "delivery_time", "delivery_apps", "parking", "dine_in", "location", "open_now", "hours",
  "preorder", "payment", "item_info", "item_price", "recommend", "offers", "how_to_order", "delivery", "menu", "waitlist_join",
  "human", "feedback", "thanks", "bye", "greeting", "ad_welcome", "media", "unknown"];

/* ═══ بنّاؤو الرسائل (حدود ميتا) ══════════════════════════════════════════ */
const cut = (s, n) => { const a = [...String(s || "")]; return a.length <= n ? a.join("") : a.slice(0, n - 1).join("") + "…"; };
export const LIMITS = { text: 4096, ibody: 1024, btnTitle: 20, btns: 3, rows: 10, rowTitle: 24, rowDesc: 72, listButton: 20, sectionTitle: 24, header: 60, footer: 60, ctaText: 20 };
export const msgText = (body, preview = true) => ({ type: "text", text: { body: cut(body, LIMITS.text), preview_url: preview } });
export function msgButtons(body, buttons, { header, footer, image } = {}) {
  const i = { type: "button", body: { text: cut(body, LIMITS.ibody) },
    action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: String(b.id).slice(0, 256), title: cut(b.title, LIMITS.btnTitle) } })) } };
  if (image) i.header = { type: "image", image: { link: image } };
  else if (header) i.header = { type: "text", text: cut(header, LIMITS.header) };
  if (footer) i.footer = { text: cut(footer, LIMITS.footer) };
  return { type: "interactive", interactive: i };
}
export function msgList(body, button, rows, { header, footer, section } = {}) {
  const r = rows.slice(0, LIMITS.rows).map((x) => ({ id: String(x.id).slice(0, 200), title: cut(x.title, LIMITS.rowTitle),
    ...(x.description ? { description: cut(x.description, LIMITS.rowDesc) } : {}) }));
  const i = { type: "list", body: { text: cut(body, LIMITS.ibody) },
    action: { button: cut(button, LIMITS.listButton), sections: [{ title: cut(section || button, LIMITS.sectionTitle), rows: r }] } };
  if (header) i.header = { type: "text", text: cut(header, LIMITS.header) };
  if (footer) i.footer = { text: cut(footer, LIMITS.footer) };
  return { type: "interactive", interactive: i };
}
export function msgCta(body, display, url, { header, image, footer } = {}) {
  const i = { type: "cta_url", body: { text: cut(body, LIMITS.ibody) },
    action: { name: "cta_url", parameters: { display_text: cut(display, LIMITS.ctaText), url } } };
  if (image) i.header = { type: "image", image: { link: image } };
  else if (header) i.header = { type: "text", text: cut(header, LIMITS.header) };
  if (footer) i.footer = { text: cut(footer, LIMITS.footer) };
  return { type: "interactive", interactive: i };
}

/* ═══ أدوات البيانات ═════════════════════════════════════════════════════ */
const L = (ctx, ar, en) => (ctx.lang === "en" && en != null ? en : ar);
const money = (n) => { const x = Number(n); return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, ""); };
const sar = (ctx, n) => L(ctx, `${money(n)} ر.س`, `SAR ${money(n)}`);
const link = (path = "", extra = "") => {
  const [p, h] = String(path).split("#");
  const base = `${STORE}/${p.replace(/^\//, "")}`;
  const q = `${base.includes("?") ? "&" : "?"}${UTM}${extra ? `&${extra}` : ""}`;
  return `${base}${q}${h ? `#${h}` : ""}`;
};
const trackLink = (no) => `${STORE}/track/${encodeURIComponent(no)}`;
function faq(ctx, re) {
  const list = ctx.settings?.storefront?.seo?.faq || [];
  const f = list.find((x) => re.test(String(x.q || "")));
  return f ? { ar: f.a, en: f.a_en || f.a } : null;
}
const fact = (ctx, key) => {
  const v = ctx.settings?.waBot?.facts?.[key];
  if (v == null || v === "") return null;
  if (typeof v === "string") return { ar: v, en: v };
  return { ar: v.ar || v.en, en: v.en || v.ar };
};
const botCfg = (ctx) => ({ ...BOT_DEFAULTS, ...(ctx.settings?.waBot || {}) });
const phoneFact = (ctx) => {
  const f = fact(ctx, "phone") || faq(ctx, /تواصل|اتواصل/);
  const m = f && String(f.ar).match(/05\d{8}/);
  return m ? m[0] : null;
};

/* ── المواعيد ─────────────────────────────────────────────────────────── */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_AR = { sat: "السبت", sun: "الأحد", mon: "الإثنين", tue: "الثلاثاء", wed: "الأربعاء", thu: "الخميس", fri: "الجمعة" };
const DAY_EN = { sat: "Sat", sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" };
const WEEK = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
export function fmtTime(hhmm, lang = "ar") {
  const [h0, m0] = String(hhmm || "0:0").split(":").map(Number);
  const h = ((h0 % 24) + 24) % 24, m = m0 || 0;
  const mm = m ? `:${String(m).padStart(2, "0")}` : "";
  if (lang === "en") { const h12 = h % 12 || 12; return `${h12}${mm} ${h < 12 ? "AM" : "PM"}`; }
  const h12 = h % 12 || 12;
  const part = h < 5 ? "فجراً" : h < 12 ? "صباحاً" : h < 16 ? "ظهراً" : h < 19 ? "عصراً" : "مساءً";
  return `${h12}${mm} ${part}`;
}
export function hoursLines(hours, lang = "ar") {
  if (!hours || !hours.days) return [];
  const key = (d) => { const x = hours.days[d]; return !x || x.closed || !x.open ? "closed" : `${x.open}-${x.close}`; };
  const groups = [];
  for (const d of WEEK) {
    const k = key(d), g = groups[groups.length - 1];
    if (g && g.k === k) g.days.push(d); else groups.push({ k, days: [d] });
  }
  const dn = lang === "en" ? DAY_EN : DAY_AR;
  return groups.map((g) => {
    const span = g.days.length > 1 ? `${dn[g.days[0]]} – ${dn[g.days[g.days.length - 1]]}` : dn[g.days[0]];
    if (g.k === "closed") return `${span}: ${lang === "en" ? "closed" : "مغلق"}`;
    const [o, c] = g.k.split("-");
    return `${span}: ${fmtTime(o, lang)} – ${fmtTime(c, lang)}`;
  });
}
const riyadh = (d) => new Date(new Date(d).getTime() + 3 * 3600_000); // حقول UTC = الرياض
export function closingToday(hours, now = new Date()) {
  if (!hours?.days) return null;
  const r = riyadh(now), mins = r.getUTCHours() * 60 + r.getUTCMinutes();
  const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };
  const today = hours.days[DAYS[r.getUTCDay()]], yest = hours.days[DAYS[(r.getUTCDay() + 6) % 7]];
  if (yest && !yest.closed && yest.open && yest.close && hm(yest.close) < hm(yest.open) && mins < hm(yest.close)) return yest.close;
  if (today && !today.closed && today.open && today.close && mins >= hm(today.open)) return today.close;
  return null;
}
export function openingText(hours, now = new Date(), lang = "ar") {
  const iso = nextOpening(hours, now.getTime());
  const at = riyadh(iso), nr = riyadh(now);
  const dayDiff = Math.round((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.UTC(nr.getUTCFullYear(), nr.getUTCMonth(), nr.getUTCDate())) / 86400000);
  const hhmm = `${at.getUTCHours()}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const time = fmtTime(hhmm, lang);
  if (lang === "en") return dayDiff <= 0 ? `today at ${time}` : dayDiff === 1 ? `tomorrow at ${time}` : `${DAY_EN[DAYS[at.getUTCDay()]]} at ${time}`;
  return dayDiff <= 0 ? `اليوم الساعة ${time}` : dayDiff === 1 ? `بكرة الساعة ${time}` : `يوم ${DAY_AR[DAYS[at.getUTCDay()]]} الساعة ${time}`;
}
export function openState(settings, now = new Date()) {
  const hours = settings?.hours;
  const open = isOpenNow(hours, now);
  const svc = serviceState(settings || {}, now);
  return { open, delivery: open && svc.delivery.open, pickup: open && svc.pickup.open, svc,
    closesAt: open ? closingToday(hours, now) : null };
}

/* ── التوصيل من dl_policies ───────────────────────────────────────────── */
function ladder(policy) {
  const arr = Array.isArray(policy?.feeByTotal) ? [...policy.feeByTotal].sort((a, b) => a.over - b.over) : [];
  return arr.map((x, i) => ({ from: Number(x.over) || 0, to: arr[i + 1] ? Number(arr[i + 1].over) : null, fee: Number(x.fee) || 0 }));
}
function ladderText(ctx) {
  const lad = ladder(ctx.policy);
  if (!lad.length) return null;
  return lad.map((x) => {
    const range = x.to == null ? L(ctx, `من ${money(x.from)} ر.س وفوق`, `SAR ${money(x.from)}+`)
      : x.from === 0 ? L(ctx, `أقل من ${money(x.to)} ر.س`, `under SAR ${money(x.to)}`) : L(ctx, `${money(x.from)}–${money(x.to)} ر.س`, `SAR ${money(x.from)}–${money(x.to)}`);
    return `• ${range}: ${x.fee === 0 ? L(ctx, "توصيل مجاني", "free delivery") : sar(ctx, x.fee)}`;
  }).join("\n");
}
function zoneText(ctx) {
  const p = ctx.policy; if (!p) return null;
  const maxKm = Number(p.maxKm) || null;
  let s = maxKm ? L(ctx, `نوصّل من فرعنا لمسافة ${maxKm} كم بالسيارة`, `We deliver up to ${maxKm} km driving distance from our branch`) : "";
  if (p.farZoneEnabled !== false && Number(p.farZoneMaxKm) > (maxKm || 0) && Number(p.farZonePerKm) > 0) {
    s += L(ctx, `، ولين ${p.farZoneMaxKm} كم برسوم مسافة إضافية ${money(p.farZonePerKm)} ر.س لكل كم بعد الـ${p.farZoneFromKm || maxKm}`,
      `, and up to ${p.farZoneMaxKm} km with an extra SAR ${money(p.farZonePerKm)} per km beyond ${p.farZoneFromKm || maxKm} km`);
  }
  return s ? s + "." : null;
}
const firstCoupon = (ctx) => (ctx.coupons || []).find((c) => c.active !== false && c.free_delivery && c.once_per_customer) || null;
function firstLine(ctx) {
  const c = firstCoupon(ctx); if (!c) return null;
  const min = Number(c.min_total) > 0 ? L(ctx, ` للطلبات من ${money(c.min_total)} ر.س وأكثر`, ` on orders of SAR ${money(c.min_total)}+`) : "";
  return L(ctx, `🎁 أول طلب من الموقع توصيله مجاني بكود ${c.code}${min}.`, `🎁 First website order: free delivery with code ${c.code}${min}.`);
}

/* ── أزرار ثابتة ──────────────────────────────────────────────────────── */
const B = {
  menu: (ctx) => ({ id: "menu", title: L(ctx, "📋 المنيو", "📋 Menu") }),
  offers: (ctx) => ({ id: "offers", title: L(ctx, "🔥 العروض", "🔥 Offers") }),
  status: (ctx) => ({ id: "status", title: L(ctx, "📦 وين طلبي؟", "📦 My order") }),
  delivery: (ctx) => ({ id: "delivery", title: L(ctx, "🛵 التوصيل", "🛵 Delivery") }),
  human: (ctx) => ({ id: "human", title: L(ctx, "👤 كلّم موظف", "👤 Talk to staff") }),
  hours: (ctx) => ({ id: "hours", title: L(ctx, "⏰ المواعيد", "⏰ Hours") }),
  location: (ctx) => ({ id: "location", title: L(ctx, "📍 الموقع", "📍 Location") }),
  waitlist: (ctx) => ({ id: "waitlist", title: L(ctx, "⏰ ذكّرني لما تفتحون", "⏰ Remind me") }),
  stop: (ctx) => ({ id: "stop", title: L(ctx, "إيقاف الرسائل", "Stop messages") }),
  cancel: (ctx) => ({ id: "cancel_order", title: L(ctx, "إلغاء الطلب", "Cancel order") }),
};
const orderCta = (ctx, body, extraQs = "") => msgCta(body, L(ctx, "اطلب الآن", "Order now"), link("", extraQs));
const handoff = (reason, ctx, extra = {}) => ({ type: "handoff", reason, priority: extra.priority || "normal",
  summary: cut(ctx.text || "", 200), orderNo: ctx.order?.order_no || ctx.entities?.orderNo || null, ...extra });
function closedNote(ctx) {
  if (!ctx.openState || ctx.openState.open) return null;
  return L(ctx, `🌙 المطعم مقفل الحين، ونفتح ${openingText(ctx.settings?.hours, ctx.now, "ar")}.`,
    `🌙 We're closed now — we open ${openingText(ctx.settings?.hours, ctx.now, "en")}.`);
}
function staffWhen(ctx) {
  return ctx.openState && !ctx.openState.open
    ? L(ctx, `فريقنا يرد عليك أول ما نفتح ${openingText(ctx.settings?.hours, ctx.now, "ar")}.`, `Our team will reply once we open ${openingText(ctx.settings?.hours, ctx.now, "en")}.`)
    : L(ctx, "واحد من فريقنا يرد عليك هنا بأسرع وقت.", "A team member will reply here as soon as possible.");
}
const firstName = (ctx) => {
  const w = String(ctx.profileName || "").trim().split(/\s+/)[0] || "";
  return w && w.length <= 15 && /^[\p{L}]+$/u.test(w) ? w : "";
};

/* ═══ buildReply — صافية ═════════════════════════════════════════════════
   ctx: { lang, text, entities, now, settings, menu, policy, coupons, offers,
          order, orderHistory:{paid}, openState, profileName, quote }
   ⇒ { messages:[payload], actions:[…], prompt? } */
export function buildReply(intentOrMatch, ctx = {}) {
  const m = typeof intentOrMatch === "string" ? { intent: intentOrMatch, entities: {} } : intentOrMatch;
  const c = { ...ctx, lang: ctx.lang || m.lang || "ar", entities: { ...(m.entities || {}), ...(ctx.entities || {}) }, now: ctx.now || new Date() };
  if (!c.openState && c.settings) c.openState = openState(c.settings, c.now);
  const fn = R[m.intent] || R.unknown;
  const r = fn(c) || {};
  return { intent: m.intent, messages: r.messages || [], actions: r.actions || [], prompt: r.prompt || null };
}

const R = {
  greeting(c) {
    const nm = firstName(c);
    const hi = L(c, `هلا والله${nm ? ` ${nm}` : ""} 👋 حيّاك في فريش كاتس`, `Hi${nm ? ` ${nm}` : ""} 👋 Welcome to Fresh Cuts`);
    const lines = [hi, L(c, "مشاوي على الفحم، كريبات، بيتزا وباستا — كيف نقدر نخدمك؟", "Charcoal grills, crepes, pizza and pasta — how can we help?")];
    const cl = closedNote(c);
    if (cl) {
      lines.push(cl);
      return { messages: [msgButtons(lines.join("\n\n"), [B.menu(c), B.waitlist(c), B.status(c)])], prompt: "waitlist_join" };
    }
    return { messages: [msgButtons(lines.join("\n\n"), [B.menu(c), B.offers(c), B.status(c)])] };
  },

  menu(c) {
    const menu = c.menu;
    if (!menu?.categories?.length) return R._noData(c, "menu");
    const cat = c.entities.categoryId ? menu.categories.find((x) => x.id === String(c.entities.categoryId)) : null;
    if (cat) return categoryList(c, cat);
    const cats = menu.categories.filter((x) => !x.merch || x.title === "Best Sellers")
      .sort((a, b) => (b.title === "Best Sellers") - (a.title === "Best Sellers")).slice(0, 10);
    const rows = cats.map((x) => {
      const real = x.items.filter((i) => !isAddon(i));
      const min = Math.min(...(real.length ? real : x.items).map((i) => i.price));
      const byW = x.items.every((i) => i.byWeight);
      const cnt = real.length || x.items.length;
      return { id: `cat:${x.id}`, title: L(c, x.titleAr, x.title),
        description: L(c, `${cnt} ${cnt >= 3 && cnt <= 10 ? "أصناف" : "صنف"} · ${byW ? "بالوزن، " : ""}من ${money(min)} ر.س`, `${cnt} items · from SAR ${money(min)}`) };
    });
    const body = [L(c, "هذي أقسام المنيو 👇 اختر القسم وأرسل لك الأصناف بأسعارها.", "Here are our menu sections 👇 pick one to see items and prices."),
      closedNote(c)].filter(Boolean).join("\n\n");
    return { messages: [msgList(body, L(c, "أقسام المنيو", "Menu sections"), rows, { footer: L(c, "الأسعار شاملة الضريبة", "Prices include VAT") }),
      msgCta(L(c, "أو تصفّح المنيو كامل بالصور واطلب مباشرة:", "Or browse the full menu with photos and order directly:"), L(c, "المنيو كامل", "Full menu"), link("menu"))] };
  },

  item_price(c) {
    const menu = c.menu;
    if (!menu?.items?.length) return R._noData(c, "menu");
    if (c.entities.notOnMenu) {
      return { messages: [msgButtons(L(c, `ما عندنا ${c.entities.notOnMenu} حالياً 🙏 عندنا مشاوي على الفحم (بالوزن ووجبات)، كريبات، بيتزا، باستا، برجر، طاسات وحواوشي.`,
        `We don't serve ${c.entities.notOnMenu === "ستيك" ? "steak" : "that"} 🙏 We have charcoal grills, crepes, pizza, pasta, burgers, skillets and hawawshi.`), [B.menu(c), B.offers(c), B.human(c)])] };
    }
    const items = (c.entities.items || []).map((id) => menu.items.find((i) => i.id === String(id))).filter(Boolean);
    if (items.length === 1) return itemCard(c, items[0]);
    if (items.length > 1) {
      const lines = items.map((i) => `• ${L(c, i.name, i.nameEn || i.name)}: ${priceLabel(c, i)}${i.soldOut ? L(c, " (خلص اليوم)", " (sold out today)") : ""}`);
      return { messages: [msgCta(`${lines.join("\n")}\n\n${L(c, "الأسعار شاملة الضريبة.", "Prices include VAT.")}`, L(c, "اطلب الآن", "Order now"), link("menu"))] };
    }
    const cat = c.entities.categoryId ? menu.categories.find((x) => x.id === String(c.entities.categoryId)) : null;
    if (cat) return categoryList(c, cat);
    const w = (c.entities.unknownWords || []).join(" ");
    return { messages: [msgButtons(L(c, `ما لقيت ${w ? `«${w}»` : "الصنف"} في المنيو الحالي 🤔 تقدر تشوف الأقسام والأسعار من هنا:`,
      `I couldn't find ${w ? `"${w}"` : "that item"} on the current menu 🤔 Browse the sections here:`), [B.menu(c), B.human(c)])] };
  },

  item_info(c) {
    const menu = c.menu;
    if (!menu?.items?.length) return R._noData(c, "menu");
    const id = c.entities.itemId || (c.entities.items || [])[0];
    const it = id && menu.items.find((i) => i.id === String(id));
    if (!it) return R.item_price(c);
    if ((c.entities.items || []).length > 1 && !c.entities.itemId) return R.item_price(c);
    return itemCard(c, it);
  },

  recommend(c) {
    const menu = c.menu;
    if (!menu?.items?.length) return R._noData(c, "menu");
    const sub = c.entities.sub || "best";
    if (sub === "family") {
      const offers = (c.offers || []).filter((o) => /تجم|مناسب|عائل|family|باقة/.test(`${o.title} ${o.desc}`)).slice(0, 3);
      const lines = offers.map((o) => `• ${o.title}: ${sar(c, o.price)}${o.line ? ` — ${o.line}` : ""}`);
      const kilo = menu.categories.find((x) => x.title === "Grills by the Kilo");
      const f = faq(c, /جمعه|جمعة|عائلي/);
      const body = [L(c, "للجمعات والعائلة 👨‍👩‍👧‍👦", "For families and groups 👨‍👩‍👧‍👦"),
        lines.length ? L(c, `باقاتنا الحالية:\n${lines.join("\n")}`, `Current bundles:\n${lines.join("\n")}`) : null,
        kilo ? L(c, `أو المشاوي بالوزن (ثلث، نص، كيلو) وتختار الكمية حسب عددكم — تبدأ من ${money(Math.min(...kilo.items.map((i) => i.price)))} ر.س.`,
          `Or grills by weight (⅓, ½ or 1 kg) — choose the amount for your group, from SAR ${money(Math.min(...kilo.items.map((i) => i.price)))}.`) : null,
        !lines.length && f ? L(c, f.ar, f.en) : null].filter(Boolean).join("\n\n");
      const url = offers[0] ? link("", `offer=${encodeURIComponent(offers[0].id)}`) : link("menu");
      return { messages: [msgCta(body, L(c, offers[0] ? "شوف الباقات" : "المنيو", offers[0] ? "See bundles" : "Menu"), url)] };
    }
    let picks;
    if (sub === "budget") {
      picks = menu.items.filter((i) => !["Sides & Drinks"].includes(i.category) && !i.byWeight && !i.soldOut && !/اضافه|إضافة|add-on/i.test(i.name))
        .sort((a, b) => a.price - b.price).slice(0, 6);
    } else {
      const best = menu.categories.find((x) => x.title === "Best Sellers");
      picks = (best ? best.items : menu.items).filter((i) => !i.soldOut).slice(0, 6);
    }
    const head = sub === "budget" ? L(c, "خيارات اقتصادية ولذيذة 👌", "Great value picks 👌") : L(c, "الأكثر طلباً عندنا 🔥", "Our best sellers 🔥");
    const rows = picks.map((i) => ({ id: `item:${i.id}`, title: L(c, i.name, i.nameEn || i.name), description: `${priceLabel(c, i)} · ${L(c, i.categoryAr, i.category)}` }));
    return { messages: [msgList(`${head}\n${L(c, "اختر أي صنف وأرسل لك تفاصيله وصورته.", "Pick any item for details and a photo.")}`, L(c, "شوف الأصناف", "See items"), rows)] };
  },

  servings(c) {
    const menu = c.menu;
    const it = (c.entities.items || []).map((id) => menu?.items?.find((i) => i.id === String(id))).filter(Boolean)[0];
    const offers = (c.offers || []).filter((o) => /شخص|أشخاص|اشخاص|people/.test(o.title)).slice(0, 3);
    const lines = [];
    if (it && it.byWeight) lines.push(L(c, `${it.name} يُباع بالوزن (ثلث، نص، كيلو)، فتختار الكمية حسب عددكم وشهيتكم.`, `${it.nameEn || it.name} is sold by weight (⅓, ½ or 1 kg) — choose the amount for your group.`));
    else if (it) lines.push(L(c, `${it.name}: ${it.desc || ""}`.trim(), `${it.nameEn || it.name}: ${it.desc || ""}`.trim()));
    if (offers.length) lines.push(L(c, "ولو تبون شي محسوب للعدد، باقاتنا:", "If you want something sized for a group, our bundles:") + "\n" + offers.map((o) => `• ${o.title}: ${sar(c, o.price)}`).join("\n"));
    if (!lines.length) return R._noData(c, "servings");
    return { messages: [msgButtons(lines.join("\n\n"), [B.menu(c), B.offers(c), B.human(c)])] };
  },

  offers(c) {
    const lines = [];
    for (const o of (c.offers || []).slice(0, 4)) {
      lines.push(`• ${o.title}${o.price ? `: ${sar(c, o.price)}` : ""}${o.untilText ? ` (${o.untilText})` : ""}`);
    }
    const f = firstLine(c); if (f) lines.push(f);
    const free = ladder(c.policy).find((x) => x.fee === 0 && x.from > 0);
    if (free) lines.push(L(c, `🛵 التوصيل مجاني للطلبات من ${money(free.from)} ر.س وفوق داخل نطاق التوصيل.`, `🛵 Free delivery on orders of SAR ${money(free.from)}+ within our delivery zone.`));
    if (!lines.length) return { messages: [msgButtons(L(c, "ما عندنا عرض شغّال اليوم، بس أسعار المنيو في موقعنا هي أسعار المطعم الأصلية 👌", "No active offers today — our website uses the restaurant's own menu prices 👌"), [B.menu(c), B.delivery(c)])] };
    const body = [L(c, "عروضنا الحين 🔥", "Current offers 🔥"), lines.join("\n"), closedNote(c)].filter(Boolean).join("\n\n");
    const first = (c.offers || [])[0];
    return { messages: [msgCta(body, L(c, first ? "شوف العروض" : "اطلب الآن", first ? "See offers" : "Order now"), first ? link("", `offer=${encodeURIComponent(first.id)}`) : link(""))] };
  },

  coupon_help(c) {
    const cp = firstCoupon(c);
    if (!cp) return R._handoff(c, "coupon_help", L(c, "نعتذر عن المشكلة في الكود 🙏", "Sorry about the code issue 🙏"));
    const rules = [
      L(c, `كود ${cp.code}:`, `Code ${cp.code}:`),
      L(c, "• توصيل مجاني لأول طلب من الموقع فقط (مو التطبيقات).", "• Free delivery on your first website order only (not the delivery apps)."),
      Number(cp.min_total) > 0 ? L(c, `• الحد الأدنى للطلب ${money(cp.min_total)} ر.س.`, `• Minimum order SAR ${money(cp.min_total)}.`) : null,
      cp.once_per_customer ? L(c, "• مرة وحدة لكل رقم جوال.", "• Once per phone number.") : null,
      L(c, "• يغطي رسوم التوصيل داخل النطاق، ورسوم المسافة الإضافية ما تدخل فيه.", "• Covers the in-zone delivery fee; the extra-distance charge isn't included."),
      L(c, "• يشتغل مع التوصيل، ومع الاستلام ما فيه رسوم أصلاً.", "• Applies to delivery; pickup has no fee anyway."),
    ].filter(Boolean);
    const paid = Number(c.orderHistory?.paid) || 0;
    if (paid > 0 && cp.once_per_customer) rules.push(L(c, "📌 رقمك له طلب سابق من الموقع، عشان كذا الكود ما ينطبق عليه.", "📌 Your number already has a website order, so this code doesn't apply."));
    rules.push(L(c, "لو كل الشروط منطبقة والكود رافض، كلّم موظف ونحلها لك.", "If everything matches and it still fails, talk to our staff and we'll fix it."));
    return { messages: [msgButtons(rules.join("\n"), [B.human(c), B.menu(c)])] };
  },

  how_to_order(c) {
    const pickup = c.entities.sub === "pickup";
    const st = c.openState;
    const lines = [pickup
      ? L(c, "الاستلام من الفرع متاح 🏃‍♂️ اختر «استلام» في صفحة الطلب، ونبلّغك أول ما يجهز طلبك.", "Pickup is available 🏃‍♂️ Choose “Pickup” on the order page and we'll notify you when it's ready.")
      : L(c, "الطلب من موقعنا سهل 👇\n١. اختر أصنافك\n٢. حدّد موقعك (أو «استلام» من الفرع)\n٣. ادفع إلكترونياً وتابع طلبك لحظة بلحظة.", "Ordering is easy 👇\n1. Pick your items\n2. Set your location (or choose pickup)\n3. Pay online and track your order live.")];
    const f = firstLine(c); if (f && !pickup) lines.push(f);
    if (st && st.open && !st.delivery && st.svc?.delivery?.paused) lines.push(L(c, "⚠️ التوصيل متوقف مؤقتاً، والاستلام من الفرع شغّال.", "⚠️ Delivery is paused for now; pickup is open."));
    if (st && st.open && !st.pickup && st.svc?.pickup?.paused) lines.push(L(c, "⚠️ الاستلام من الفرع متوقف مؤقتاً.", "⚠️ Pickup is paused for now."));
    const cl = closedNote(c);
    if (cl) {
      lines.push(cl + L(c, " تقدر تجهّز سلتك الحين ونذكّرك أول ما نفتح.", " You can build your cart now and we'll remind you."));
      return { messages: [msgCta(lines.join("\n\n"), L(c, "افتح الموقع", "Open website"), link("")), msgButtons(L(c, "تبي نذكّرك لما نفتح؟", "Want a reminder when we open?"), [B.waitlist(c), B.menu(c)])], prompt: "waitlist_join" };
    }
    return { messages: [orderCta(c, lines.join("\n\n"))] };
  },

  delivery(c) {
    const z = zoneText(c), lad = ladderText(c), f = firstLine(c);
    if (!z && !lad) return R._noData(c, "delivery");
    const body = [L(c, "نعم نوصّل 🛵", "Yes, we deliver 🛵"), z, lad ? L(c, `رسوم التوصيل حسب قيمة السلة:\n${lad}`, `Delivery fee by basket total:\n${lad}`) : null, f,
      L(c, "حدّد موقعك في صفحة الطلب ويطلع لك الرسم النهائي قبل الدفع.", "Set your pin on the order page to see the exact fee before paying.")].filter(Boolean).join("\n\n");
    return { messages: [orderCta(c, body)] };
  },

  delivery_area(c) {
    const q = c.quote;
    if (q) {
      if (q.deliverable) {
        const fee = Number(q.fee) || 0;
        return { messages: [orderCta(c, [L(c, `✅ موقعك داخل نطاق التوصيل (${money(q.routeKm || q.distanceKm || 0)} كم تقريباً).`, `✅ Your location is inside our delivery zone (~${money(q.routeKm || q.distanceKm || 0)} km).`),
          fee ? L(c, `رسوم التوصيل تبدأ من ${sar(c, fee)} وتقل كل ما زادت السلة.`, `Delivery fee from ${sar(c, fee)}, lower on bigger baskets.`) : L(c, "التوصيل مجاني لهذا الموقع حسب السلة.", "Delivery is free for this location depending on basket."),
          firstLine(c)].filter(Boolean).join("\n"))] };
      }
      if (q.farZoneOffer) {
        return { messages: [orderCta(c, L(c, `موقعك برّه النطاق الأساسي، ونقدر نوصّلك برسوم مسافة إضافية ${sar(c, q.farZoneOffer.surcharge ?? q.farZoneOffer.fee ?? 0)} — أو تستلم من الفرع بدون رسوم.`,
          `You're outside the main zone — we can deliver with an extra distance fee of ${sar(c, q.farZoneOffer.surcharge ?? q.farZoneOffer.fee ?? 0)}, or pick up for free.`))] };
      }
      return { messages: [msgButtons(L(c, "للأسف موقعك برّه نطاق التوصيل حالياً 🙏 تقدر تستلم من الفرع، أو تطلبنا من تطبيقات التوصيل.", "Sorry, that location is outside our delivery range 🙏 You can pick up from the branch."), [B.location(c), B.menu(c)])] };
    }
    const z = zoneText(c);
    if (!z) return R._noData(c, "delivery");
    const d = c.entities.district;
    const lines = [d ? L(c, `بخصوص حي ${d.name}:`, `About ${d.name}:`) : null, z,
      L(c, "عشان نأكد لك بالضبط، أرسل موقعك 📍 (المشبك ← الموقع) وأرد عليك بالرسم، أو حدّد موقعك في صفحة الطلب ويطلع لك قبل الدفع.",
        "To confirm exactly, send your location 📍 (attach → Location) and I'll reply with the fee, or drop your pin on the order page.")].filter(Boolean);
    return { messages: [msgButtons(lines.join("\n\n"), [B.menu(c), { id: "fee", title: L(c, "💰 رسوم التوصيل", "💰 Delivery fees") }, B.human(c)])] };
  },

  delivery_fee(c) {
    const lad = ladderText(c);
    if (!lad) return R._noData(c, "delivery");
    const body = [L(c, "رسوم التوصيل عندنا حسب قيمة السلة 🛵", "Our delivery fee depends on the basket total 🛵"), lad, zoneText(c), firstLine(c)].filter(Boolean).join("\n\n");
    return { messages: [orderCta(c, body)] };
  },

  delivery_time(c) {
    const f = fact(c, "deliveryTime") || faq(c, /وقت الوصول|رسوم التوصيل ووقت/);
    const ch = faq(c, /الفحم/);
    const body = [f ? L(c, f.ar, f.en) : null,
      ch ? L(c, "وأكلنا يُطبخ طازج بعد ما يوصلنا الطلب، والمشاوي تاخذ وقت أكثر شوي من باقي الأصناف.", "We cook fresh after your order arrives, and grills take a little longer than other dishes.") : null].filter(Boolean);
    if (!body.length) return R._noData(c, "deliveryTime");
    return { messages: [orderCta(c, body.join("\n\n"))] };
  },

  min_order(c) {
    if (!c.policy) return R._noData(c, "delivery");
    const min = Number(c.policy.minOrderTotal) || 0;
    const cp = firstCoupon(c);
    const lines = [min > 0 ? L(c, `الحد الأدنى للطلب ${sar(c, min)}.`, `Minimum order is ${sar(c, min)}.`) : L(c, "ما عندنا حد أدنى للطلب 👌", "There's no minimum order 👌")];
    const lad = ladder(c.policy)[0];
    if (lad && lad.fee > 0) lines.push(L(c, `رسوم التوصيل للسلة الصغيرة (أقل من ${money(lad.to)} ر.س) ${sar(c, lad.fee)}، وتقل كل ما كبرت السلة.`, `Small baskets (under SAR ${money(lad.to)}) pay ${sar(c, lad.fee)} delivery; it drops as the basket grows.`));
    if (cp && Number(cp.min_total) > 0) lines.push(L(c, `وكود ${cp.code} (توصيل مجاني لأول طلب) يحتاج سلة ${money(cp.min_total)} ر.س وفوق.`, `Code ${cp.code} (free first delivery) needs SAR ${money(cp.min_total)}+.`));
    return { messages: [orderCta(c, lines.join("\n"))] };
  },

  hours(c) {
    const lines = hoursLines(c.settings?.hours, c.lang);
    if (!lines.length) return R._noData(c, "hours");
    const st = c.openState;
    const now = st?.open ? L(c, `🟢 مفتوحين الحين${st.closesAt ? ` لين ${fmtTime(st.closesAt, "ar")}` : ""}.`, `🟢 Open now${st.closesAt ? ` until ${fmtTime(st.closesAt, "en")}` : ""}.`) : closedNote(c);
    const body = [L(c, "⏰ مواعيدنا:", "⏰ Our hours:"), lines.join("\n"), now].filter(Boolean).join("\n");
    if (st && !st.open) return { messages: [msgButtons(body, [B.waitlist(c), B.menu(c)])], prompt: "waitlist_join" };
    return { messages: [msgText(body, false)] };
  },

  open_now(c) {
    const st = c.openState;
    if (!st || !c.settings?.hours) return R._noData(c, "hours");
    if (st.open) {
      const parts = [L(c, `🟢 إيه مفتوحين الحين${st.closesAt ? ` لين ${fmtTime(st.closesAt, "ar")}` : ""}.`, `🟢 Yes, we're open${st.closesAt ? ` until ${fmtTime(st.closesAt, "en")}` : ""}.`)];
      if (!st.delivery && st.svc?.delivery?.paused) parts.push(L(c, "التوصيل متوقف مؤقتاً، والاستلام من الفرع شغّال.", "Delivery is paused for now; pickup is open."));
      if (!st.pickup && st.svc?.pickup?.paused) parts.push(L(c, "الاستلام من الفرع متوقف مؤقتاً.", "Pickup is paused for now."));
      return { messages: [orderCta(c, parts.join("\n"))] };
    }
    return { messages: [msgButtons(`${closedNote(c)}\n${L(c, "تبي نذكّرك أول ما نفتح؟", "Want a reminder when we open?")}`, [B.waitlist(c), B.menu(c)])], prompt: "waitlist_join" };
  },

  special_hours(c) {
    const f = fact(c, "specialHours");
    if (f) return { messages: [msgText(L(c, f.ar, f.en), false)] };
    const lines = hoursLines(c.settings?.hours, c.lang);
    return { messages: [msgButtons([L(c, "مواعيد رمضان والأعياد نعلنها قبلها بفترة 🌙 مواعيدنا المعتادة:", "We announce Ramadan/Eid hours ahead of time 🌙 Our regular hours:"), lines.join("\n")].join("\n"), [B.human(c), B.menu(c)])],
      actions: [handoff("missing_fact:specialHours", c, { silent: true })] };
  },

  location(c) {
    const f = faq(c, /اين يقع|أين يقع|وين/) || fact(c, "location");
    const maps = c.settings?.googlePlace?.mapsUrl || fact(c, "mapsUrl")?.ar;
    if (!f && !maps) return R._noData(c, "location");
    const body = [L(c, "📍 فرعنا:", "📍 Our branch:"), f ? L(c, f.ar.replace(/ الموقع على خرائط جوجل.*$/, ""), (f.en || f.ar).replace(/ The Google Maps pin.*$/, "")) : null,
      L(c, "عندنا فرع واحد، والتوصيل منه.", "We have one branch and deliver from it.")].filter(Boolean).join("\n");
    return { messages: [maps ? msgCta(body, L(c, "افتح الخريطة", "Open in Maps"), maps) : msgText(body)] };
  },

  parking(c) { return R._fact(c, "parking"); },
  dine_in(c) { return R._fact(c, c.entities && /عوائل|عائلات|family|بارت/.test(c.text || "") ? "familySection" : "dineIn", "dineIn"); },
  reservation(c) { return R._fact(c, "reservations"); },
  jobs(c) { return R._fact(c, "jobs", null, false); },

  payment(c) {
    const f = fact(c, "payment") || faq(c, /طرق الدفع/);
    if (!f) return R._noData(c, "payment");
    const cash = fact(c, "cash");
    const body = [L(c, `💳 ${f.ar}`, `💳 ${f.en}`), cash ? L(c, cash.ar, cash.en) : L(c, "هذا للطلبات من الموقع (دفع إلكتروني وقت الطلب).", "That's for website orders (paid online at checkout).")].join("\n");
    return { messages: [orderCta(c, body)], actions: cash ? [] : [handoff("missing_fact:cash", c, { silent: true })] };
  },

  payment_issue(c) {
    return R._handoff(c, "payment_issue", L(c, "نعتذر منك 🙏 مشاكل الدفع نتابعها يدوياً عشان نتأكد من كل ريال. لو المبلغ انخصم وما وصلك تأكيد، يرجع تلقائياً حسب البنك أو نأكد طلبك.",
      "Sorry about that 🙏 We handle payment issues manually. If you were charged without a confirmation, it's either confirmed or returned automatically by the bank."), "high");
  },

  special_request(c) {
    if (c.order && c.order.active) {
      return R._handoff(c, "special_request", L(c, `وصلت ملاحظتك على طلب ${c.order.order_no} 👌 نبلّغ المطبخ الحين، ولو الطلب بدأ تجهيزه موظف يرد عليك.`,
        `Got your note for order ${c.order.order_no} 👌 We're telling the kitchen now; if it's already being prepared, a staff member will reply.`), "high");
    }
    return { messages: [orderCta(c, L(c, "أبشر 👌 اكتب طلبك الخاص في «ملاحظات الطلب» قبل الدفع (مثل: بدون بصل، الصوص على جنب)، والمطبخ يلتزم فيه.",
      "Sure 👌 Add it in the order notes before paying (e.g. no onions, sauce on the side) and the kitchen will follow it."))] };
  },

  site_issue(c) {
    return R._handoff(c, "site_issue", L(c, "نعتذر منك 🙏 نبّهنا الفريق التقني يشيّك على الموقع الحين. لو تقدر أرسل صورة الشاشة أو إيش ظهر لك، وموظف يكمل طلبك معك.",
      "Sorry about that 🙏 I've alerted our team to check the website now. A screenshot helps — a staff member will help you finish your order."), "high");
  },

  order_status(c) {
    const o = c.order;
    if (!o) {
      return { messages: [msgButtons(L(c, "ما لقيت طلب من الموقع على رقم الواتساب هذا خلال آخر ٣ أيام 🤔\nلو طلبت برقم ثاني أرسل رقم الطلب (يبدأ بـW)، ولو طلبت من تطبيق توصيل تابعه من التطبيق نفسه.",
        "I couldn't find a website order on this WhatsApp number in the last 3 days 🤔\nIf you ordered with another number, send the order number (starts with W); for delivery apps, track it in the app."), [B.human(c), B.menu(c)])] };
    }
    const label = saudize(o.label) || STATUS_AR[o.status] || o.status;
    const lines = [L(c, `طلبك رقم ${o.order_no}:`, `Order ${o.order_no}:`), `${label}`];
    const ageMin = o.created_at ? (c.now.getTime() - new Date(o.created_at).getTime()) / 60000 : 0;
    const acts = [];
    if (o.active && ageMin > (Number(botCfg(c).lateAfterMinutes) || 70)) {
      lines.push(L(c, "نعتذر عن التأخير 🙏 نبّهنا الفريق يتابع طلبك الحين.", "Sorry for the wait 🙏 I've alerted the team to check on it now."));
      acts.push(handoff("late_order", c, { priority: "high" }));
    }
    return { messages: [msgCta(lines.join("\n"), L(c, "تتبّع الطلب", "Track order"), trackLink(o.order_no))], actions: acts };
  },

  cancel_or_stop(c) {
    return { messages: [msgButtons(L(c, "تقصد إلغاء طلبك الحالي ولا إيقاف رسائل العروض؟", "Do you mean cancel your current order, or stop promotional messages?"), [B.cancel(c), B.stop(c)])] };
  },

  cancel_order(c) {
    const o = c.order;
    if (o && !o.active) return { messages: [msgButtons(L(c, `طلبك الأخير ${o.order_no} حالته: ${o.label || STATUS_AR[o.status] || o.status}، فما يحتاج إلغاء.`, `Your last order ${o.order_no} is ${o.status}, so there's nothing to cancel.`), [B.human(c), B.menu(c)])] };
    return R._handoff(c, "cancel_order", L(c, `وصلنا طلب الإلغاء${o ? ` للطلب ${o.order_no}` : ""} 🙏 أكلنا يدخل المطبخ بسرعة، فموظف يتأكد وين وصل التجهيز ويرد عليك.`,
      `Got your cancellation request${o ? ` for ${o.order_no}` : ""} 🙏 Food goes to the kitchen fast, so a staff member will check and reply.`), "high");
  },

  modify_order(c) {
    return R._handoff(c, "modify_order", L(c, "أبشر 🙏 التعديل يحتاج موظف يتأكد من المطبخ والمندوب — أرسل التعديل المطلوب هنا بالتفصيل.", "Sure 🙏 Changes need a staff member to check with the kitchen/courier — send the details here."), c.order?.active ? "high" : "normal");
  },

  complaint(c) {
    const sev = c.entities.severity === "high";
    const k = c.entities.kind;
    const opener = sev
      ? L(c, "سلامتك 🙏 نأسف جداً، وصحتك أهم شي عندنا. المدير بيتواصل معك بنفسه.", "We're so sorry 🙏 Your health comes first — the manager will contact you personally.")
      : k === "late" ? L(c, "نعتذر منك على التأخير 🙏 أكلنا يُطبخ طازج بعد الطلب، لكن هذا ما يبرر إنه يتأخر عليك.", "Sorry for the delay 🙏 We cook fresh to order, but that's no excuse for keeping you waiting.")
        : L(c, "نعتذر منك 🙏 ما نرضاها لك أبداً.", "We're really sorry 🙏 That's not the experience we want for you.");
    const ask = c.order ? L(c, `سجّلنا ملاحظتك على الطلب ${c.order.order_no}${k === "missing" || k === "wrong" ? "، ولو تقدر أرسل صورة للطلب" : ""}.`, `Noted on order ${c.order.order_no}${k === "missing" || k === "wrong" ? " — a photo helps if you can" : ""}.`)
      : L(c, "أرسل رقم الطلب (أو رقم الجوال اللي طلبت فيه) عشان المدير يتواصل معك.", "Please send your order number (or the phone you ordered with) so the manager can reach you.");
    const msgs = [msgText(`${opener}\n${ask}\n${staffWhen(c)}`, false)];
    if (k === "late" && c.order) msgs.push(msgCta(L(c, "تقدر تتابع طلبك من هنا:", "Track your order here:"), L(c, "تتبّع الطلب", "Track order"), trackLink(c.order.order_no)));
    return { messages: msgs, actions: [handoff(`complaint:${k || "general"}`, c, { priority: sev || k === "late" || c.order?.active ? "high" : "normal", ticket: true })] };
  },

  refund(c) {
    return R._handoff(c, "refund", L(c, `وصلنا طلبك بخصوص المبلغ${c.order ? ` (طلب ${c.order.order_no})` : ""} 🙏 الاسترجاع يرجع لنفس وسيلة الدفع، والمدير يراجع ويرد عليك.`,
      `We've got your refund request${c.order ? ` (order ${c.order.order_no})` : ""} 🙏 Refunds go back to the original payment method; the manager will review and reply.`), "high");
  },

  dietary(c) {
    const topic = c.entities.topic;
    const menu = c.menu;
    const it = (c.entities.items || []).map((id) => menu?.items?.find((i) => i.id === String(id))).filter(Boolean)[0];
    if (topic === "spicy") {
      if (it) {
        const hot = /حار|ديناميت|هالابينو|سبايسي|شيلي/.test(`${it.name} ${it.desc}`);
        return { messages: [msgText(L(c, `${it.name}: ${it.desc || ""}\n${hot ? "🌶️ فيه مكوّن حار حسب الوصف." : "الوصف ما يذكر مكوّن حار."} لو تبي تعديل على الحرارة اكتبه في ملاحظات الطلب.`,
          `${it.nameEn || it.name}: ${it.desc || ""}\n${hot ? "🌶️ The description lists a spicy ingredient." : "The description doesn't list a spicy ingredient."} Add a note at checkout for spice changes.`), false)] };
      }
      const hotItems = (menu?.items || []).filter((i) => /حار|ديناميت|هالابينو|شيلي/.test(`${i.name} ${i.desc}`)).slice(0, 6);
      if (hotItems.length) return { messages: [msgText(`${L(c, "🌶️ الأصناف اللي وصفها فيه حار:", "🌶️ Items with spicy ingredients:")}\n${hotItems.map((i) => `• ${L(c, i.name, i.nameEn || i.name)} — ${priceLabel(c, i)}`).join("\n")}`, false)] };
    }
    if (topic === "vegetarian" && menu?.items?.length) {
      const f = fact(c, "vegetarian");
      if (f) return { messages: [msgText(L(c, f.ar, f.en), false)] };
      const veg = menu.items.filter((i) => /خضروات|مارجريتا|جبن|بطاطس|vegetable|margherita|cheese|fries|onion|بصل/.test(`${i.name} ${i.nameEn}`) && !/دجاج|لحم|سجق|هوت|برجر|بسطرمه|رومي|تونه|ستربس|chicken|beef|burger/.test(normalize(`${i.name} ${i.desc}`))).slice(0, 8);
      const body = [L(c, "أصناف بدون لحوم حسب وصف المنيو:", "Meat-free items per the menu description:"), veg.map((i) => `• ${L(c, i.name, i.nameEn || i.name)} — ${priceLabel(c, i)}`).join("\n"),
        L(c, "للتأكد من طريقة التحضير (زيت/أدوات مشتركة) نسأل الفريق لك.", "For preparation details (shared oil/equipment) our team will confirm.")].filter(Boolean).join("\n");
      return { messages: [msgButtons(body, [B.human(c), B.menu(c)])], actions: [handoff("missing_fact:vegetarian", c, { silent: true })] };
    }
    const key = topic === "halal" ? "halal" : topic === "gluten" ? "gluten" : topic === "calories" ? "calories" : "allergens";
    const f = fact(c, key);
    if (f) return { messages: [msgText(L(c, f.ar, f.en), false)] };
    if (it && it.desc && topic === "allergy") {
      return R._handoff(c, `missing_fact:${key}`, L(c, `مكونات ${it.name} حسب المنيو: ${it.desc}.\nللحساسية نفضّل نأكد لك من المطبخ مباشرة عشان سلامتك.`, `${it.nameEn || it.name} ingredients per the menu: ${it.desc}.\nFor allergies we'd rather confirm with the kitchen for your safety.`));
    }
    return R._handoff(c, `missing_fact:${key}`, L(c, "سؤال مهم 🙏 عشان سلامتك نتأكد لك من المطبخ مباشرة بدل ما نعطيك معلومة ناقصة.", "Good question 🙏 For your safety we'll confirm with the kitchen rather than guess."));
  },

  kids_menu(c) {
    const f = fact(c, "kids");
    if (f) return { messages: [msgButtons(L(c, f.ar, f.en), [B.menu(c)])] };
    const menu = c.menu;
    const small = (menu?.items || []).filter((i) => ["Crepes", "Pizza", "Burgers", "Hawawshi"].includes(i.category) && i.price <= 25 && !isAddon(i) && !i.soldOut
      && !/حار|ديناميت|هالابينو|سي فود|جمبري/.test(`${i.name} ${i.desc}`)).sort((a, b) => a.price - b.price).slice(0, 5);
    if (!small.length) return R._noData(c, "kids");
    return { messages: [msgButtons([L(c, "ما عندنا منيو أطفال منفصل، لكن هذي أصناف خفيفة تناسب الصغار:", "We don't have a separate kids menu, but these light items suit kids:"),
      small.map((i) => `• ${L(c, i.name, i.nameEn || i.name)} — ${priceLabel(c, i)}`).join("\n")].join("\n"), [B.menu(c), B.human(c)])],
      actions: [handoff("missing_fact:kids", c, { silent: true })] };
  },

  catering(c) {
    const offers = (c.offers || []).filter((o) => /شخص|أشخاص|اشخاص|مناسب/.test(o.title)).slice(0, 3);
    const lines = [L(c, `حيّاكم 🎉${c.entities.people ? ` لطلب ${c.entities.people} شخص` : ""} الطلبات الكبيرة نرتّبها مع المدير عشان التوقيت والكميات تكون مضبوطة.`,
      `Happy to help 🎉${c.entities.people ? ` for ${c.entities.people} people` : ""} Large orders are arranged with our manager so timing and quantities are right.`)];
    if (offers.length) lines.push(L(c, "باقاتنا الجاهزة للمجموعات:", "Our ready group bundles:") + "\n" + offers.map((o) => `• ${o.title}: ${sar(c, o.price)}`).join("\n"));
    lines.push(L(c, "أرسل: التاريخ والوقت، العدد، توصيل ولا استلام، والحي.", "Send: date & time, headcount, delivery or pickup, and area."));
    return { messages: [msgText(`${lines.join("\n\n")}\n${staffWhen(c)}`, false)], actions: [handoff("catering", c, { priority: "normal", ticket: true })] };
  },

  preorder(c) {
    const p = c.settings?.preorder;
    if (p && p.enabled) {
      const slots = (p.slots || []).map((s) => `${fmtTime(s.start, c.lang)}–${fmtTime(s.end, c.lang)}`).join(L(c, "، ", ", "));
      return { messages: [orderCta(c, L(c, `نقدر نجدول طلبك 🗓️ ${p.note || ""}\nالفترات المتاحة: ${slots}\nاختر «موعد لاحق» في صفحة الطلب.`, `You can schedule your order 🗓️\nSlots: ${slots}\nChoose "Later" on the order page.`))] };
    }
    return { messages: [msgButtons(L(c, "الطلب المجدول مو متاح حالياً في الموقع 🙏 تقدر تطلب وقت ما تبي ونجهّزه طازج مباشرة، أو نرتّب لك مع موظف.", "Scheduled orders aren't available on the website right now 🙏 Order anytime and we cook it fresh, or arrange with our staff."), [B.human(c), B.menu(c)])] };
  },

  partnership(c) {
    const f = fact(c, "partnerships");
    return { messages: [msgText(`${f ? L(c, f.ar, f.en) : L(c, "شكراً لتواصلك 🙏 أرسل تفاصيل العرض (الاسم، الجهة، الفكرة، وحساباتك إن وجدت) ونوصلها للإدارة، ويتواصلون معك إذا فيه توافق.", "Thanks for reaching out 🙏 Send the details (name, company, idea, and your accounts if any) and we'll pass it to management.")}`, false)],
      actions: [handoff("partnership", c, { priority: "low" })] };
  },

  delivery_apps(c) {
    const apps = fact(c, "deliveryApps") || { ar: "هنقرستيشن وكيتا ونينجا", en: "HungerStation, Keeta and Ninja" };
    if (c.entities.sub === "own_app") {
      const f = fact(c, "app");
      return { messages: [orderCta(c, f ? L(c, f.ar, f.en) : L(c, "تقدر تطلب من موقعنا مباشرة من جوالك، وتضيفه للشاشة الرئيسية ويشتغل مثل التطبيق 📱", "Order directly from our website on your phone — add it to your home screen and it works like an app 📱"))] };
    }
    const f = firstLine(c);
    const body = [L(c, `موجودين على ${apps.ar} 👍`, `We're on ${apps.en} 👍`),
      L(c, "لكن الطلب من موقعنا مباشرة بأسعار المنيو الأصلية للمطعم، وتتابع طلبك وتكلّمنا هنا مباشرة.", "Ordering on our website uses the restaurant's own menu prices, and you can track and reach us directly here."), f].filter(Boolean).join("\n\n");
    return { messages: [orderCta(c, body)] };
  },

  invoice(c) {
    const vat = faq(c, /الضريبه|الضريبة/);
    const body = [vat ? L(c, vat.ar.replace(/^نعم[،,]\s*/, ""), (vat.en || "").replace(/^Yes[,.]\s*/, "")) : null, (c.order ? L(c, `للفاتورة الضريبية لطلب ${c.order.order_no}، موظف يرسلها لك هنا.`, `A staff member will send the VAT invoice for ${c.order.order_no} here.`) : L(c, "للفاتورة الضريبية أرسل رقم الطلب، وموظف يرسلها لك هنا.", "For a VAT invoice, send your order number and our staff will send it here."))].filter(Boolean).join("\n");
    return { messages: [msgText(`${body}\n${staffWhen(c)}`, false)], actions: [handoff("invoice", c, { priority: "low" })] };
  },

  feedback(c) {
    const url = c.settings?.reviews?.googleUrl || null;
    const positive = /لذيذ|خطير|روعه|تحفه|يجنن|يهبل|ممتاز|delicious|amazing|great|ابدعتوا|مبدعين/.test(normalize(c.text || ""));
    const body = positive
      ? L(c, "الله يسعدك 🤍 كلامك يفرّح الفريق كامل، ونوصله لهم الحين.", "That made our day 🤍 We'll share it with the whole team.")
      : L(c, "حيّاك 🙏 اكتب ملاحظتك هنا بالتفصيل، والإدارة تقرأ كل كلمة.", "Thank you 🙏 Write your feedback here in detail — management reads every word.");
    const acts = positive ? [] : [handoff("feedback", c, { priority: "low" })];
    if (positive && url) return { messages: [msgCta(`${body}\n${L(c, "ولو حاب تقيّمنا على جوجل يساعدنا كثير:", "A Google review would help us a lot:")}`, L(c, "قيّمنا على جوجل", "Review on Google"), url)], actions: acts };
    return { messages: [msgText(body, false)], actions: acts };
  },

  human(c) {
    const ph = phoneFact(c);
    return R._handoff(c, "human", L(c, `أبشر 🙏 حوّلت محادثتك لفريقنا.${ph ? `\nوتقدر تتصل على ${ph}.` : ""}`, `Sure 🙏 I've passed your chat to our team.${ph ? `\nYou can also call ${ph}.` : ""}`));
  },

  stop(c) {
    return { messages: [msgText(L(c, "تم ✅ أوقفنا رسائل العروض على رقمك. رسائل طلباتك توصلك عادي.\nلو حبيت ترجع أرسل: اشتراك", "Done ✅ You won't get promotional messages anymore. Order updates still come through.\nTo resubscribe, send: START"), false)],
      actions: [{ type: "optout", scope: "marketing" }] };
  },

  start(c) {
    return { messages: [msgText(L(c, "رجّعناك ✅ توصلك عروضنا من جديد. وللإيقاف في أي وقت أرسل: إيقاف", "You're back ✅ You'll receive our offers again. Send STOP anytime to opt out."), false)],
      actions: [{ type: "optin", scope: "marketing" }] };
  },

  thanks(c) {
    if (c.entities.declined) return { messages: [msgText(L(c, "ولا يهمك 🤍 إذا احتجت شي إحنا هنا.", "No problem 🤍 We're here if you need anything."), false)] };
    if (c.entities.addr === "ok") return { messages: [msgText(L(c, "تمام ✅ ثبّتنا العنوان، وطلبك ماشي.", "Great ✅ Address confirmed."), false)], actions: [{ type: "address_confirmed" }] };
    return { messages: [msgText(L(c, "العفو 🤍 بالعافية مقدماً، وإذا احتجت شي إحنا هنا.", "You're welcome 🤍 We're here anytime."), false)] };
  },

  bye(c) { return { messages: [msgText(L(c, "في أمان الله 🤍 ننتظرك في طلبك الجاي.", "Take care 🤍 See you on your next order."), false)] }; },

  waitlist_join(c) {
    if (c.openState?.open) return { messages: [orderCta(c, L(c, "إحنا مفتوحين الحين 🎉 تقدر تطلب مباشرة:", "We're open now 🎉 Order directly:"))] };
    return { messages: [msgText(L(c, `تم ✅ نرسل لك هنا أول ما نفتح ${openingText(c.settings?.hours, c.now, "ar")}.`, `Done ✅ We'll message you here when we open ${openingText(c.settings?.hours, c.now, "en")}.`), false)],
      actions: [{ type: "waitlist_join", opensAt: nextOpening(c.settings?.hours, c.now.getTime()) }] };
  },

  ad_welcome(c) {
    const nm = firstName(c);
    const offer = (c.offers || [])[0];
    const lines = [L(c, `هلا${nm ? ` ${nm}` : ""} 👋 حيّاك في فريش كاتس — مشاوي على الفحم وكريبات وبيتزا وباستا تنطبخ طازجة.`, `Hi${nm ? ` ${nm}` : ""} 👋 Welcome to Fresh Cuts — charcoal grills, crepes, pizza and pasta cooked fresh.`)];
    if (offer) lines.push(L(c, `🔥 ${offer.title}: ${sar(c, offer.price)}`, `🔥 ${offer.title}: ${sar(c, offer.price)}`));
    const f = firstLine(c); if (f) lines.push(f);
    const cl = closedNote(c); if (cl) lines.push(cl);
    const msgs = [msgButtons(lines.join("\n\n"), [B.menu(c), B.offers(c), cl ? B.waitlist(c) : B.delivery(c)])];
    msgs.push(msgCta(L(c, "تقدر تطلب مباشرة من هنا 👇", "Order directly here 👇"), L(c, "اطلب الآن", "Order now"), link("", "utm_campaign=ctwa")));
    return { messages: msgs, actions: [{ type: "ad_lead", referral: c.referral || null }], prompt: cl ? "waitlist_join" : null };
  },

  media(c) {
    return { messages: [msgText(L(c, `وصلتنا ${c.entities.mediaType === "image" ? "الصورة" : c.entities.mediaType === "audio" || c.entities.mediaType === "voice" ? "الرسالة الصوتية" : "رسالتك"} 🙏 ${staffWhen(c)}\nولو سؤالك عن المنيو أو التوصيل أو طلبك، اكتبه لي وأرد فوراً.`,
      `Got it 🙏 ${staffWhen(c)}\nIf it's about the menu, delivery or your order, type it and I'll answer right away.`), false)],
      actions: [handoff(`media:${c.entities.mediaType || "file"}`, c)] };
  },

  unknown(c) {
    const rows = [
      { id: "menu", title: L(c, "📋 المنيو والأسعار", "📋 Menu & prices") },
      { id: "offers", title: L(c, "🔥 العروض", "🔥 Offers") },
      { id: "status", title: L(c, "📦 وين طلبي؟", "📦 Where's my order?") },
      { id: "delivery", title: L(c, "🛵 التوصيل والرسوم", "🛵 Delivery & fees") },
      { id: "how", title: L(c, "🛒 كيف أطلب", "🛒 How to order") },
      { id: "hours", title: L(c, "⏰ المواعيد", "⏰ Opening hours") },
      { id: "location", title: L(c, "📍 الموقع", "📍 Location") },
      { id: "human", title: L(c, "👤 كلّم موظف", "👤 Talk to staff") },
    ];
    const acts = (c.unknownStreak || 0) >= 2 ? [handoff("bot_not_understood", c)] : [];
    return { messages: [msgList(L(c, "ما فهمت عليك تماماً 🙏 اختر موضوع أو اكتب سؤالك بطريقة ثانية:", "Sorry, I didn't quite get that 🙏 Pick a topic or rephrase:"), L(c, "المواضيع", "Topics"), rows)], actions: acts };
  },

  /* ── مشتركة ── */
  _fact(c, key, altKey = null, doHandoff = true) {
    const f = fact(c, key) || (altKey ? fact(c, altKey) : null);
    if (f) return { messages: [msgButtons(L(c, f.ar, f.en), [B.menu(c), B.location(c)])] };
    const q = {
      parking: L(c, "سؤال المواقف", "the parking question"), dineIn: L(c, "سؤال الجلسات", "the seating question"), familySection: L(c, "سؤال قسم العوائل", "the family section question"),
      reservations: L(c, "الحجز", "reservations"), jobs: L(c, "التوظيف", "jobs"),
    }[key] || key;
    if (key === "jobs") {
      return { messages: [msgText(L(c, "شكراً لاهتمامك بالعمل معنا 🙏 أرسل اسمك والوظيفة اللي تبيها وخبرتك باختصار، ونوصلها للإدارة.", "Thanks for your interest 🙏 Send your name, the role and a short summary of your experience, and we'll pass it to management."), false)],
        actions: [handoff("jobs", c, { priority: "low" })] };
    }
    return R._handoff(c, `missing_fact:${key}`, L(c, `بخصوص ${q} خلني أتأكد لك من الفريق بدل ما أعطيك معلومة غلط 🙏`, `Let me confirm ${q} with our team rather than guess 🙏`), "low");
  },
  _handoff(c, reason, text, priority = "normal") {
    return { messages: [msgText(`${text}\n${staffWhen(c)}`, false)], actions: [handoff(reason, c, { priority })] };
  },
  _noData(c, what) {
    return R._handoff(c, `missing_data:${what}`, L(c, "خلني أتأكد لك من الفريق 🙏", "Let me check with the team 🙏"), "low");
  },
};

const STATUS_AR = {
  paid: "تم الدفع ✅", pos_created: "تم الدفع واستلمنا طلبك ✅", accepted: "المطعم يجهّز طلبك 👨‍🍳", courier_requested: "المطعم يجهّز طلبك 👨‍🍳",
  courier_assigned: "المطعم يجهّز طلبك — والمندوب في الطريق للمطعم 🛵", on_the_way: "طلبك في الطريق إليك 🛵", delivered: "تم التوصيل — بالعافية 🌟",
  rejected_refunded: "اعتذر المطعم عن الطلب وتم استرجاع المبلغ", refund_failed: "استرجاع مبلغك جاري وفريقنا يتابع",
  courier_cancelled: "تعثر التوصيل — فريقنا يتابع", paid_pos_failed: "تم الدفع — جاري تأكيد الطلب", pending_payment: "بانتظار الدفع",
};
/* نص صفحة التتبع (shop.js) مكتوب بلهجة مصرية خفيفة — نفس المعنى بصياغة سعودية للواتساب */
export function saudize(label) {
  if (!label) return "";
  return String(label).replace(/بيجهّز|بيجهز/g, "يجهّز").replace(/بيتجهّز|بيتجهز/g, "يتجهّز").replace(/بنسلّمه|بنسلمه/g, "نسلّمه")
    .replace(/بيستلم/g, "يستلم").replace(/جاري إسناد/g, "نرتّب").replace(/قريباً/g, "قريب");
}
export const ACTIVE_STATUSES = ["paid", "pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way", "paid_pos_failed", "courier_cancelled"];

const isAddon = (i) => /إضافة|اضافه|add-on|addon/i.test(`${i.name} ${i.nameEn}`);
function priceLabel(c, it) {
  return it.byWeight ? L(c, `من ${money(it.price)} ر.س`, `from SAR ${money(it.price)}`) : sar(c, it.price);
}
function itemCard(c, it) {
  const body = [`*${L(c, it.name, it.nameEn || it.name)}* — ${priceLabel(c, it)}`,
    it.desc ? it.desc : null,
    it.byWeight ? L(c, "⚖️ بالوزن: ثلث، نص، أو كيلو — والسعر حسب الكمية اللي تختارها.", "⚖️ By weight: ⅓, ½ or 1 kg — the price depends on the size you choose.") : null,
    it.soldOut ? L(c, "⚠️ خلص اليوم، ويرجع قريب.", "⚠️ Sold out today.") : null,
  ].filter(Boolean).join("\n");
  const url = `${STORE}/?${UTM}#item-${it.id}`;
  return { messages: [msgCta(body, L(c, it.soldOut ? "شوف المنيو" : "اطلبه الآن", it.soldOut ? "See menu" : "Order it"), it.soldOut ? link("menu") : url, { image: it.image || undefined })] };
}
function categoryList(c, cat) {
  const items = cat.items.slice(0, 10);
  const more = cat.items.length - items.length;
  const rows = items.map((i) => ({ id: `item:${i.id}`, title: L(c, i.name, i.nameEn || i.name),
    description: `${priceLabel(c, i)}${i.soldOut ? L(c, " · خلص اليوم", " · sold out") : ""}${i.desc ? ` · ${i.desc}` : ""}` }));
  const body = [L(c, `${cat.titleAr} 👇 اختر صنف وأرسل لك صورته وتفاصيله.`, `${cat.title} 👇 pick an item for its photo and details.`),
    cat.items.every((i) => i.byWeight) ? L(c, "بالوزن (ثلث، نص، كيلو) والسعر حسب الكمية.", "Sold by weight (⅓, ½, 1 kg); price depends on size.") : null,
    more > 0 ? L(c, `و${more} أصناف ثانية في المنيو الكامل.`, `Plus ${more} more on the full menu.`) : null].filter(Boolean).join("\n");
  return { messages: [msgList(body, L(c, "الأصناف", "Items"), rows, { section: L(c, cat.titleAr, cat.title) })] };
}

/* ═══ الحالة: السكوت بعد الموظف + حد الردود ══════════════════════════════
   الذاكرة الافتراضية Map داخل العملية (تضيع مع إعادة التشغيل — مقبول: أسوأ
   شي البوت يرد مرة زيادة). التكامل يقدر يمرّر store بنفس الواجهة لو يبيها
   في القاعدة. */
export function createState({ store = new Map(), cfg = {} } = {}) {
  const C = { ...BOT_DEFAULTS, ...cfg };
  const get = (id) => { let s = store.get(id); if (!s) { s = { replies: [], unknownStreak: 0 }; store.set(id, s); } return s; };
  return {
    cfg: C,
    get,
    staffReplied(id, now = Date.now()) { get(id).mutedUntil = now + C.staffMuteHours * 3600_000; },
    unmute(id) { const s = get(id); s.mutedUntil = 0; s.handoffUntil = 0; },
    isMuted(id, now = Date.now()) { return (get(id).mutedUntil || 0) > now; },
    inHandoff(id, now = Date.now()) { return (get(id).handoffUntil || 0) > now; },
    markHandoff(id, now = Date.now()) { get(id).handoffUntil = now + C.handoffQuietMinutes * 60_000; },
    rate(id, n, now = Date.now()) {
      const s = get(id);
      s.replies = s.replies.filter((t) => now - t < 5 * 60_000);
      if (s.lastN === n && now - (s.lastAt || 0) < C.duplicateSeconds * 1000) return "duplicate";
      if (s.replies.length >= C.maxRepliesPer5Min) return s.limitNoticed ? "rate_limited" : "rate_notice";
      return null;
    },
    noteReply(id, n, now = Date.now(), { prompt = null, intent = null, limitNotice = false } = {}) {
      const s = get(id);
      s.replies.push(now); s.lastN = n; s.lastAt = now; s.lastPrompt = prompt; s.lastIntent = intent;
      s.unknownStreak = intent === "unknown" ? (s.unknownStreak || 0) + 1 : 0;
      s.limitNoticed = limitNotice ? true : s.replies.length < C.maxRepliesPer5Min ? false : s.limitNoticed;
      s.seen = true;
    },
  };
}

/* ═══ handleInbound — رسالة واردة ⇒ ردود ═════════════════════════════════
   deps: { state, loadContext: async({phone, orderNo, location, text}) ⇒ ctx, now? } */
const HANDOFF_ALLOWED = new Set(["stop", "start", "order_status", "cancel_or_stop"]);
export async function handleInbound(msg, deps) {
  const now = deps.now ? new Date(deps.now) : new Date();
  const state = deps.state;
  const id = String(msg.from || "");
  if (!/^\d{8,15}$/.test(id)) return { skip: "bad_sender", messages: [], actions: [] };
  const n = normalize(msg.text || "");
  const phone = id.startsWith("966") ? id.slice(3) : id;
  const s = state.get(id);
  const pre = matchIntent(msg.text, { type: msg.type, replyId: msg.replyId, location: msg.location, lastPrompt: s.lastPrompt });
  const compliance = pre.intent === "stop" || pre.intent === "start";
  if (!compliance && state.isMuted(id, now.getTime())) return { skip: "staff_active", intent: pre.intent, messages: [], actions: [] };

  const ctx = await deps.loadContext({ phone, orderNo: pre.entities.orderNo, location: msg.location, text: msg.text, now });
  const cfg = botCfg(ctx);
  if (cfg.enabled === false && !compliance) return { skip: "disabled", intent: pre.intent, messages: [], actions: [] };
  const match = matchIntent(msg.text, { ...ctx, type: msg.type, replyId: msg.replyId, location: msg.location, referral: msg.referral,
    firstMessage: !s.seen, lastPrompt: s.lastPrompt });
  if (!compliance && state.inHandoff(id, now.getTime()) && !HANDOFF_ALLOWED.has(match.intent)) {
    return { skip: "awaiting_staff", intent: match.intent, messages: [], actions: [] };
  }
  const rl = compliance ? null : state.rate(id, n || `${msg.type}:${msg.replyId || ""}`, now.getTime());
  if (rl === "duplicate" || rl === "rate_limited") return { skip: rl, intent: match.intent, messages: [], actions: [] };
  if (rl === "rate_notice") {
    state.noteReply(id, n, now.getTime(), { limitNotice: true });
    state.markHandoff(id, now.getTime());
    return { skip: null, intent: "rate_notice", messages: [msgText(L({ lang: match.lang }, "وصلتنا رسائلك 🙏 حوّلناك لموظف يكمل معك.", "Got your messages 🙏 A staff member will continue with you."), false)],
      actions: [handoff("rate_limit", { text: msg.text, entities: {} })] };
  }
  const reply = buildReply(match, { ...ctx, lang: match.lang, text: msg.text, profileName: msg.profileName, referral: msg.referral,
    now, unknownStreak: s.unknownStreak });
  state.noteReply(id, n || `${msg.type}:${msg.replyId || ""}`, now.getTime(), { prompt: reply.prompt, intent: match.intent });
  if (reply.actions.some((a) => a.type === "handoff" && !a.silent)) state.markHandoff(id, now.getTime());
  if (match.intent === "stop" || match.intent === "start") state.unmute(id);
  return { skip: null, intent: match.intent, match, messages: reply.messages, actions: reply.actions.map((a) => ({ ...a, phone })) };
}

/* ═══ تحميل السياق من البيانات الحية (قراءة فقط) ════════════════════════ */
export function makeContextLoader({ pool, getSettingsData, fetchMenuPages, activeOffers, quote } = {}) {
  let menuCache = { at: 0, pages: null };
  async function pages() {
    if (menuCache.pages && Date.now() - menuCache.at < 10 * 60_000) return menuCache.pages;
    try {
      const p = await fetchMenuPages();
      if (Array.isArray(p) && p.length) menuCache = { at: Date.now(), pages: p };
    } catch (e) { if (!menuCache.pages) console.error("[wabot] menu:", e.message); }
    return menuCache.pages || [];
  }
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { console.error("[wabot] db:", e.message); return []; } };
  return async function loadContext({ phone, orderNo, location, now = new Date() } = {}) {
    const settings = (await getSettingsData().catch(() => ({}))) || {};
    const cfg = { ...BOT_DEFAULTS, ...(settings.waBot || {}) };
    const soldOut = {};
    for (const [k, v] of Object.entries(settings.catalog?.soldOut || {})) if (!v?.until || Date.parse(v.until) > now.getTime()) soldOut[k] = true;
    const menu = indexMenu(await pages(), { hiddenIds: settings.catalog?.hiddenIds || [], soldOut });
    const [pol] = await q("SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1", []);
    const coupons = await q(`SELECT code, percent, min_total, once_per_customer, free_delivery, expires_at, active FROM shop_coupons
      WHERE code = ANY($1) AND active AND (expires_at IS NULL OR expires_at >= CURRENT_DATE) AND phone_norm IS NULL`, [cfg.publicCoupons || []]);
    const paused = settings.catalog?.pausedOffers || {};
    let offers = [];
    try {
      offers = (activeOffers ? activeOffers(now) : []).filter((o) => (o.channels?.delivery || o.channels?.takeaway) && !o.dineInOnly)
        .filter((o) => { const slug = o.extra?.bundleSlug || o.bundleSlug; const p = slug && paused[slug]; return !(p && (!p.until || Date.parse(p.until) > now.getTime())); })
        .map((o) => ({ id: o.id, title: o.title, desc: o.desc, price: o.price, line: o.copy?.line || o.extra?.copy?.line || "", untilText: o.until ? `لين ${o.until.slice(8, 10)}/${o.until.slice(5, 7)}` : "" }));
    } catch { offers = []; }
    let order = null, orderHistory = { paid: 0 };
    if (phone && /^5\d{8}$/.test(phone)) {
      const rows = orderNo
        ? await q("SELECT order_no, status, option, total, created_at, pos_ready_at FROM shop_orders WHERE order_no=$1 AND phone_norm=$2 LIMIT 1", [orderNo, phone])
        : await q(`SELECT order_no, status, option, total, created_at, pos_ready_at FROM shop_orders
            WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment')
              AND created_at > NOW() - ($2 || ' hours')::interval ORDER BY created_at DESC LIMIT 1`, [phone, String(cfg.orderLookbackHours)]);
      if (rows[0]) {
        order = { ...rows[0], active: ACTIVE_STATUSES.includes(rows[0].status) };
        if (quote?.track) { try { const t = await quote.track(order.order_no); if (t?.label) order.label = t.label; } catch { /* الاحتياطي STATUS_AR */ } }
      }
      const [h] = await q(`SELECT count(*)::int AS paid FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false)
        AND status IN ('paid','pos_created','accepted','courier_requested','courier_assigned','on_the_way','delivered')`, [phone]);
      if (h) orderHistory = h;
    }
    let qv = null;
    if (location && quote?.location) { try { qv = await quote.location(location.lat, location.lng); } catch { qv = null; } }
    return { settings, menu, policy: pol?.config || null, coupons, offers, order, orderHistory, quote: qv, now };
  };
}

/* ═══ register — مسارات إدارية للقراءة والتجربة فقط (ما ترسل شي) ════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const storeBase = (process.env.STOREFRONT_PUBLIC_URL || STORE).replace(/\/+$/, "");
  const fetchMenuPages = deps.fetchMenuPages || (async () => {
    const r = await fetch(`${storeBase}/api/menu?branch_id=1`, { headers: { "User-Agent": "freshcuts-wabot" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`menu HTTP ${r.status}`);
    return (await r.json())?.data?.pages || [];
  });
  let offersMod = null;
  const activeOffers = deps.activeOffers || ((now) => (offersMod ? offersMod.activeOffers(now) : []));
  if (!deps.activeOffers) import("./offers.js").then((m) => { offersMod = m; }).catch(() => {});
  // التتبع والتسعير من نفس مسارات المتجر (نفس المصدر، قراءة فقط)
  const self = deps.app || app;
  const quote = deps.quote || {
    track: async (no) => { const r = await self.request(`/api/shop/track/${encodeURIComponent(no)}`); return r.ok ? r.json() : null; },
    location: async (lat, lng) => { const r = await self.request(`/api/delivery/quote?lat=${lat}&lng=${lng}`); return r.ok ? r.json() : null; },
  };
  const loadContext = makeContextLoader({ pool, getSettingsData, fetchMenuPages, activeOffers, quote });
  const state = createState();

  app.get("/api/cms/wabot/catalogue", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const T = await import("./watemplates.js");
    return c.json({ ok: true, summary: T.summary(), recommendedFirst: T.RECOMMENDED_FIRST,
      templates: T.TEMPLATES.map((t) => ({ ...t, preview: T.previewText(t), errors: T.validateTemplate(t) })) });
  });
  app.get("/api/cms/wabot/intents", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, defaults: BOT_DEFAULTS, intents: INTENTS });
  });
  /* {text, phone?, replyId?, type?, referral?, lat?, lng?, at?} ⇒ النية + الرد (بدون إرسال) */
  app.post("/api/cms/wabot/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const now = b.at ? new Date(b.at) : new Date();
    if (!Number.isFinite(now.getTime())) return c.json({ ok: false, error: "bad_at" }, 400);
    const phone = String(b.phone || "").replace(/\D/g, "").replace(/^(966|0)/, "");
    const location = Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lng)) && b.lat && b.lng ? { lat: Number(b.lat), lng: Number(b.lng) } : null;
    const pre = matchIntent(b.text, { type: b.type, replyId: b.replyId, location });
    const data = await loadContext({ phone: /^5\d{8}$/.test(phone) ? phone : null, orderNo: pre.entities.orderNo, location, now });
    const match = matchIntent(b.text, { ...data, type: b.type, replyId: b.replyId, location, referral: b.referral || null });
    const reply = buildReply(match, { ...data, lang: match.lang, text: b.text, referral: b.referral || null, profileName: b.profileName || null, now });
    return c.json({ ok: true, match: { intent: match.intent, score: match.score, lang: match.lang, entities: match.entities, scores: match.scores },
      reply, context: { open: data.settings ? openState(data.settings, now) : null, orderFound: Boolean(data.order), menuItems: data.menu.items.length,
        offers: data.offers.length, coupons: data.coupons.map((x) => x.code) } });
  });

  return {
    state, loadContext,
    handleInbound: (msg) => handleInbound(msg, { state, loadContext }),
  };
}
