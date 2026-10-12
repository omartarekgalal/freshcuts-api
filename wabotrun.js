/* ═══════════════════════════════════════════════════════════════════════════
   WABOTRUN — بوت واتساب v1 لفريش كاتس (١٢/١٠/٢٠٢٦). التصميم: docs/designs-2026-10/whatsapp/bot-design.md

   الرقم واحد: الكاشير بيرد من تطبيق واتساب بزنس، والبوت بيرد من الـCloud API (Coexistence).
   القاعدة الأولى: **البوت مايتكلّمش فوق إنسان، ومايبعتش كلمة مش متأكد منها.**

   • الوضع من اللوحة (settings.waBot.mode) — مفيش أي مفتاح في الكود ولا في env:
       off   مقفول (الافتراضي). مابيمسكش الرسالة أصلاً.
       dry   تجربة صامتة: بيقرّر ويسجّل اللي «كان هيبعته» لكل رسالة حقيقية، ومابيبعتش ولا حرف ولا تنبيه.
       test  بيرد فعلاً على أرقام قايمة التجربة (testPhones) **بس**، من غير فتح مفاتيح العملاء.
       live  بيرد على الكل — ومحتاج أقفال واتساب العادية (WHATSAPP_ENABLED + مفتاح اللوحة).
     الإعدادات بتتقري من القاعدة مع كل رسالة ⇒ تغيير الوضع لـoff = إيقاف فوري.
   • جوّه نافذة خدمة العملاء بس: بيرد على رسالة عميل لسه واصلة (الرسالة الأقدم من maxAgeMinutes مابيتردش عليها)،
     وعمره ما بيبدأ محادثة.
   • الإنسان أولاً — قواعد ١٢/١٠ (موافقة عمر، بحث docs/…/whatsapp/البوت-والموظف-السلوك-الطبيعي.md):
       ١ سكوت بالدقايق: humanPauseMin (٣٠) من **آخر** رسالة للموظف من الموبايل (صدى smb_message_echoes).
       ٢ العميل كتب وقت السكوت والموظف ماردّش خلال staffWaitMin (٥) ⇒ البوت يرد، بس على نية معروفة.
       ٣ المطعم مقفول (نفس مصدر المواعيد) ⇒ السكوت ده مالوش وجود.
       ٤ استثناءات: كتم يدوي للمحادثة (بمدة) بيفضل ماسك · شكوى مفتوحة ⇒ معلومات بس (مواعيد/موقع/حالة طلب) من غير
         روابط طلب ولا عروض · رد موظف وقت الإقفال ⇒ سكوت closedEchoPauseMin (١٠) بس.
       ٥ في الدوام: النية المعروفة تتجاوب فوراً؛ الغير مفهوم يستنى unknownWaitMin (٣) للموظف وبعدها القائمة. مقفول: فوراً.
       ٦ أي سكوت بيخلص ساعة الإقفال، والتحويل وقت الإقفال بيتقال له ميعاد الفتح الحقيقي.
       ٧ أول رسالة من البوت في كل محادثة (كل ٢٤ ساعة) بتعرّف إنه مساعد آلي + «موظف» + رقم المطعم.
     الرد المؤجّل = صف في wa_bot_jobs (بيعيش بعد إعادة التشغيل)، ووقت التنفيذ كل الشروط بتتراجع من جديد.
     حد معروف: رسايل تطبيق الموبايل من بعض الأجهزة المرتبطة مابتطلّعش صدى ⇒ السكوت ممكن مايحسّش بيها.
   • تحية واحدة لكل عميل كل greetWindowHours.
   • النية: wabot.matchIntent (قواعد وكلمات — مفيش LLM). الرد: نص ثابت مراجَع من settings.waBot.texts
     (والافتراضي هنا) بيتعبّى ببيانات حيّة: البوكسات من /api/shop/bundles، المواعيد من settings.hours،
     رسوم التوصيل من dl_policies، كود أول طلب من shop_coupons، الولاء من settings.cms.loyalty، الطلب من shop_orders
     **بجوال المرسل فقط**. أي بيانات ناقصة ⇒ مفيش نص ناقص: «حوّلتك لموظف» + تنبيه للفريق.
   • الفشل: محاولة إرسال واحدة (ولو الرسالة تفاعلية وفشلت: مرة واحدة كنص عادي). مفيش إعادة ولا حلقة.
   • التكرار: الويب هوك المكرر بيتمسك بالـwamid مرتين (wa_messages في whatsapp.js + wa_bot_log هنا).
   • الروابط: روابطنا المتتبَّعة /l/<slug> بس (cms_links) — رابط للمحادثات العادية ورابط لمحادثات الإعلانات
     (ومع خريطة «إعلان ⇒ رابط» اختيارية). رابط التتبع /track/<رقم الطلب> ورابط الخريطة من الإعدادات.
═══════════════════════════════════════════════════════════════════════════ */

import { matchIntent, detectLang, normalize, msgText, msgButtons, msgCta, LIMITS, openState, openingText, hoursLines, fmtTime, ORDER_NO_RE } from "./wabot.js";
import { staffPhones, fitOneSms, staffConfig } from "./staffalerts.js";
import { loyaltyCfgOf } from "./loyalty.js";
import { MAPS_URL } from "./watemplates.js";
import { isOpenNow } from "./carts.js";

export const STORE = "https://freshcuts.sa";
export const MODES = ["off", "dry", "test", "live"];

export const DEFAULTS = Object.freeze({
  mode: "off",
  testPhones: [],              // 5XXXXXXXX — من اللوحة فقط
  greetScope: "all",           // all | ads (تحية لمحادثات الإعلانات بس)
  humanPauseMin: 30,           // سكوت بعد **آخر** رد للموظف من الموبايل (في الدوام)
  staffWaitMin: 5,             // العميل كتب وقت السكوت: نستنى الموظف المدة دي وبعدها البوت يرد (نية معروفة بس)
  closedEchoPauseMin: 10,      // موظف رد والمطعم مقفول: سكوت قصير بس
  unknownWaitMin: 3,           // في الدوام: رسالة غير مفهومة تستنى الموظف قبل القائمة (٠ = فوراً)
  manualMuteHours: 24,         // «كتم البوت في المحادثة دي» من الموظف — المدة الافتراضية
  handoffOpenHours: 24,        // التحويل لموظف «مفتوح» المدة دي: شكوى ⇒ معلومات بس، ومفيش تنبيه مكرر
  publicPhone: "",             // رقم المطعم في رسالة التعريف؛ فاضي = من سؤال «كيف أتواصل» في الأسئلة الشائعة
  freeRepliesPerMonth: 1000,   // تسعيرة ميتا ١/١٠/٢٠٢٦: أول ١٠٠٠ رد حر في الشهر ببلاش…
  replyRateSar: 0.0401,        // …وبعدها بالريال للرد
  greetWindowHours: 24,        // تحية واحدة لكل عميل في المدة دي
  maxAgeMinutes: 20,           // رسالة أقدم من كده (ويب هوك متأخر) مابيتردش عليها
  duplicateSeconds: 120,       // نفس الرد لنفس العميل مايتكررش خلالها
  maxRepliesPerHour: 8,        // لكل عميل؛ عند الحد: تحويل لموظف وسكوت
  orderLookbackHours: 72,
  lateAfterMinutes: 70,        // «وين طلبي» على طلب نشط أقدم من كده ⇒ الحالة + تحويل
  interactive: true,           // أزرار/رابط بزر؛ false = نص عادي والرابط في آخره
  staffAlert: true,            // SMS للفريق عند التحويل (live؛ وفي test لو alertInTest)
  alertInTest: false,
  alertPhones: [],             // فاضي = أرقام الإنذارات (settings.delivery.alertPhones)
  maxAlertsPerHour: 6,
  firstCode: "FIRST",
  links: { organic: "wab-boxes", ads: "wa-boxes", adMap: {} },   // adMap: { "<ad source_id>": "<slug>" }
  intentsOff: [],              // مفاتيح ردود مقفولة ⇒ تحويل لموظف بدل الرد
  texts: {},                   // { key: { ar, en } } — الفاضي = الافتراضي
});

/* روابط البوت الأساسية — بتتعمل لو مش موجودة (cms_links)، وتتعدّل بعدها من «روابط الحملات» زي أي رابط. */
export const SEED_LINKS = Object.freeze([
  { slug: "wab-boxes", label: "بوت واتساب — البوكسات (محادثات عادية)", target_type: "collection", target_id: "offers",
    coupon: "FIRST", utm_source: "whatsapp", utm_medium: "bot", utm_campaign: "wa-bot" },
]);

/* ── النصوص ──────────────────────────────────────────────────────────────────
   كل نص: عربي أبيض + إنجليزي، والمتغيّرات المسموحة له. متغيّر بين [] = اختياري (لو مالوش قيمة سطره بيتشال).
   متغيّر إجباري مالوش قيمة ⇒ الرد كله مايتبعتش (DataMissing) ويتحوّل لموظف. */
const t = (label, ar, en, vars = [], opt = [], max = 900) => ({ label, ar, en, vars, opt, max });
export const TEXTS = Object.freeze({
  greet: t("التحية (أول رسالة)", "حيّاك الله في فريش كاتس 👋\n{boxes}\n{first}\n{paused}\n{closed}",
    "Welcome to Fresh Cuts 👋\n{boxes}\n{first}\n{paused}\n{closed}", ["boxes"], ["first", "paused", "closed"]),
  menu: t("المنيو / الأسعار", "{boxes}\nوالمنيو كامل بالصور والأسعار في موقعنا 👇\n{closed}",
    "{boxes}\nThe full menu with photos and prices is on our website 👇\n{closed}", ["boxes"], ["closed"]),
  order: t("أبي أطلب", "الطلب من موقعنا يأخذ دقيقة 👇\nاختر طلبك، حدّد موقعك على الخريطة وادفع إلكترونياً، ونبلّغك بكل تحديث.\n{first}\n{paused}\n{closed}",
    "Ordering on our website takes a minute 👇\nPick your order, drop your pin on the map and pay online. We keep you updated.\n{first}\n{paused}\n{closed}", [], ["first", "paused", "closed"]),
  offers: t("العروض / أول طلب", "{first}\n{loyalty}\n{boxes}", "{first}\n{loyalty}\n{boxes}", ["boxes"], ["first", "loyalty"]),
  hours_open: t("المواعيد (مفتوح)", "⏰ مواعيدنا:\n{hours}\n🟢 مفتوحين الحين لين {closes}.", "⏰ Our hours:\n{hours}\n🟢 Open now until {closes}.", ["hours", "closes"]),
  hours_closed: t("المواعيد (مقفل)", "⏰ مواعيدنا:\n{hours}\n🌙 مقفلين الحين، ونفتح {opens}.\nجهّز سلتك من الرابط واضغط «نبّهني أول ما نفتح» ونذكّرك.",
    "⏰ Our hours:\n{hours}\n🌙 We're closed now and open {opens}.\nBuild your cart from the link and tap “Notify me when we open”.", ["hours", "opens"]),
  delivery: t("التوصيل والرسوم", "🛵 نوصّل لمسافة {km} كم من فرعنا في حي السلامة بجدة.\n{far}\nرسوم التوصيل حسب قيمة الطلب:\n{fees}\n{first}\n{paused}\nحدّد موقعك على الخريطة في صفحة الطلب وتظهر لك الرسوم قبل الدفع.",
    "🛵 We deliver up to {km} km from our branch in Al Salamah, Jeddah.\n{far}\nDelivery fee by order total:\n{fees}\n{first}\n{paused}\nDrop your pin on the order page to see the exact fee before you pay.", ["km", "fees"], ["far", "first", "paused"]),
  location: t("موقع الفرع", "📍 فرعنا في حي السلامة بجدة، عند دوار رامي.", "📍 Our branch is in Al Salamah, Jeddah, by Rami Roundabout."),
  payment: t("طرق الدفع", "💳 {payment}", "💳 {payment}", ["payment"]),
  status_found: t("حالة الطلب", "طلبك رقم {order_no}: {status}", "Order {order_no}: {status}", ["order_no", "status"]),
  status_late: t("حالة طلب متأخر", "طلبك رقم {order_no}: {status}\nنعتذر عن التأخير 🙏 بلّغت الفريق يتابعه معك.\n{wait}",
    "Order {order_no}: {status}\nSorry for the delay 🙏 I've asked the team to follow it up with you.\n{wait}", ["order_no", "status"], ["wait"]),
  status_none: t("مافيه طلب على الرقم", "ما لقيت طلب حديث من موقعنا على رقمك هذا 🙏\nحوّلت محادثتك لموظف يتأكد لك.\n{wait}",
    "I couldn't find a recent website order on this number 🙏\nI've passed your chat to a staff member to check.\n{wait}", [], ["wait"]),
  complaint_known: t("شكوى (الطلب معروف)", "نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع.\nطلبك رقم {order_no} قدّامنا.\n{wait}",
    "We're sorry about that 🙏\nI've passed your chat to the branch manager.\nWe have your order {order_no} in front of us.\n{wait}", ["order_no"], ["wait"]),
  complaint_ask: t("شكوى (نطلب رقم الطلب)", "نعتذر منك على اللي صار 🙏\nحوّلت محادثتك لمدير الفرع.\nلو تكرّمت اكتب رقم الطلب (يبدأ بحرف W) عشان نخدمك أسرع.\n{wait}",
    "We're sorry about that 🙏\nI've passed your chat to the branch manager.\nPlease send your order number (it starts with W) so we can help faster.\n{wait}", [], ["wait"]),
  problem: t("مشكلة دفع / موقع / كود", "نعتذر عن المشكلة 🙏 حوّلتها لموظف.\n{wait}",
    "Sorry about the trouble 🙏 I've passed it to a staff member.\n{wait}", [], ["wait"]),
  change: t("تعديل / إلغاء طلب", "تعديل الطلب أو إلغاؤه يحتاج موظف 🙏 حوّلت طلبك له.\n{wait}",
    "Changing or cancelling an order needs a staff member 🙏 I've passed it on.\n{wait}", [], ["wait"]),
  human: t("طلب موظف", "أبشر 🙏 حوّلت محادثتك لموظف.\n{wait}",
    "Sure 🙏 I've passed your chat to a staff member.\n{wait}", [], ["wait"]),
  staff: t("سؤال يحتاج موظف", "سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.\n{wait}",
    "Your question needs one of the team 🙏 I've passed it on.\n{wait}", [], ["wait"]),
  media: t("صورة / صوت / ملف", "ما أقدر أفتح الصور والمقاطع الصوتية 🙏 حوّلت محادثتك لموظف.\n{wait}",
    "I can't open photos or voice notes 🙏 I've passed your chat to a staff member.\n{wait}", [], ["wait"]),
  unknown: t("غير مفهوم (أول مرة)", "ما فهمت طلبك تماماً 🙏 اختر من الأزرار، أو اكتب: موظف", "I didn't quite get that 🙏 Pick a button, or type: staff"),
  data_missing: t("معلومة ناقصة", "ما قدرت أجيب المعلومة الحين 🙏 حوّلت سؤالك لموظف.\n{wait}",
    "I couldn't get that information right now 🙏 I've passed your question to a staff member.\n{wait}", [], ["wait"]),
  rate: t("حد الردود", "وصلتنا رسائلك 🙏 حوّلت محادثتك لموظف يكمل معك.\n{wait}", "We got your messages 🙏 A staff member will continue with you.\n{wait}", [], ["wait"]),
  thanks: t("شكر / وداع", "العفو، حيّاك الله 🌟", "You're welcome 🌟"),
  stop: t("إيقاف العروض", "تم إيقاف رسائل العروض ✅ تحديثات طلباتك توصلك عادي.\nللرجوع اكتب: اشتراك", "Offer messages are stopped ✅ You will still get your order updates.\nTo resume, type: start"),
  start: t("رجوع الاشتراك", "تم تفعيل رسائل العروض ✅\nللإيقاف اكتب: إيقاف", "Offer messages are on ✅\nTo stop, type: stop"),
  // سطور بتدخل جوّه الردود
  boxes_head: t("عنوان البوكسات", "🎁 بوكساتنا:", "🎁 Our boxes:", [], [], 60),
  first_line: t("سطر أول طلب", "🎁 أول طلب توصيل لك من الموقع توصيله مجاني للطلبات من {first_min} ر.س وأكثر داخل نطاق التوصيل (كود {first_code} يتطبّق تلقائياً).",
    "🎁 Free delivery on your first website delivery order of SAR {first_min} or more inside our delivery zone (code {first_code} applies automatically).", ["first_min", "first_code"], [], 300),
  loyalty_line: t("سطر الولاء", "⭐ وكل {loy_every} طلبات من الموقع لك توصيل مجاني على طلب من {loy_min} ر.س وأكثر.",
    "⭐ Every {loy_every} website orders earn free delivery on an order of SAR {loy_min} or more.", ["loy_every", "loy_min"], [], 300),
  far_line: t("سطر النطاق البعيد", "ومن {km} إلى {far_km} كم برسوم مسافة إضافية {far_fee} ر.س لكل كم.", "From {km} to {far_km} km there is an extra distance charge of SAR {far_fee} per km.", ["km", "far_km", "far_fee"], [], 200),
  closed_line: t("سطر «مقفل الحين»", "🌙 المطعم مقفل الحين ونفتح {opens}. جهّز سلتك واضغط «نبّهني أول ما نفتح» ونذكّرك.",
    "🌙 We're closed now and open {opens}. Build your cart and tap “Notify me when we open”.", ["opens"], [], 300),
  hours_closed_plain: t("المواعيد (مقفل) — من غير رابط، لعميل عنده شكوى مفتوحة", "⏰ مواعيدنا:\n{hours}\n🌙 مقفلين الحين، ونفتح {opens}.",
    "⏰ Our hours:\n{hours}\n🌙 We're closed now and open {opens}.", ["hours", "opens"]),
  disclosure: t("التعريف بالبوت (أول رسالة في المحادثة)", "معك المساعد الآلي لفريش كاتس 🤖 للتحدث مع موظف اكتب: موظف",
    "This is Fresh Cuts' automated assistant 🤖 To reach a person type: staff", [], [], 200),
  disclosure_phone: t("التعريف بالبوت + رقم المطعم", "معك المساعد الآلي لفريش كاتس 🤖 للتحدث مع موظف اكتب: موظف، أو اتصل على {phone}",
    "This is Fresh Cuts' automated assistant 🤖 To reach a person type: staff, or call {phone}", ["phone"], [], 200),
  when_open: t("سطر «الرد قريب» (في الدوام بس)", "يرد عليك هنا في أقرب وقت.", "They will reply here shortly.", [], [], 200),
  wait_line: t("سطر «الرد لما نفتح»", "المطعم مقفل الحين، والرد يوصلك أول ما نفتح {opens}.", "We're closed now; you will get a reply once we open {opens}.", ["opens"], [], 200),
  paused_delivery: t("سطر «التوصيل متوقف»", "⚠️ التوصيل متوقف مؤقتاً، والاستلام من الفرع متاح.", "⚠️ Delivery is paused for now; pickup from the branch is available.", [], [], 200),
  footer: t("تذييل الرسائل بزر", "رد آلي · للموظف اكتب: موظف", "Automated reply · type: staff", [], [], LIMITS.footer),
  cta_order: t("زر: اطلب", "اطلب الآن", "Order now", [], [], LIMITS.ctaText),
  cta_menu: t("زر: المنيو", "شوف المنيو", "See the menu", [], [], LIMITS.ctaText),
  cta_cart: t("زر: جهّز سلتك", "جهّز سلتك", "Build your cart", [], [], LIMITS.ctaText),
  cta_map: t("زر: الخريطة", "افتح الخريطة", "Open the map", [], [], LIMITS.ctaText),
  cta_track: t("زر: التتبع", "تتبّع الطلب", "Track order", [], [], LIMITS.ctaText),
  btn_menu: t("زر رد: البوكسات", "🎁 البوكسات والمنيو", "🎁 Boxes & menu", [], [], LIMITS.btnTitle),
  btn_status: t("زر رد: وين طلبي", "📦 وين طلبي؟", "📦 My order", [], [], LIMITS.btnTitle),
  btn_human: t("زر رد: موظف", "👤 كلّم موظف", "👤 Talk to staff", [], [], LIMITS.btnTitle),
  // حالات الطلب
  st_received: t("حالة: استلمنا الطلب", "استلمنا طلبك وتم الدفع ✅", "received and paid ✅", [], [], 120),
  st_confirming: t("حالة: نأكّد مع المطعم", "تم الدفع ونأكّد طلبك مع المطعم الحين.", "paid, and we are confirming it with the restaurant now.", [], [], 120),
  st_preparing: t("حالة: في المطبخ", "المطبخ يجهّز طلبك 👨‍🍳", "the kitchen is preparing it 👨‍🍳", [], [], 120),
  st_ready_courier: t("حالة: جاهز وننتظر المندوب", "طلبك جاهز ونسلّمه للمندوب 🛵", "ready and being handed to the courier 🛵", [], [], 120),
  st_handed: t("حالة: مع المندوب", "سلّمنا طلبك للمندوب 🛵", "handed to the courier 🛵", [], [], 120),
  st_on_the_way: t("حالة: في الطريق", "طلبك مع المندوب وفي الطريق إليك 🛵", "with the courier and on the way to you 🛵", [], [], 120),
  st_delivered: t("حالة: تم التوصيل", "تم توصيل طلبك ✅", "delivered ✅", [], [], 120),
  st_pickup_ready: t("حالة: جاهز للاستلام", "طلبك جاهز للاستلام من الفرع ✅", "ready to collect from the branch ✅", [], [], 120),
  st_picked: t("حالة: تم الاستلام", "تم استلام طلبك ✅ بالعافية.", "collected ✅", [], [], 120),
  st_table_ready: t("حالة: جاهز للطاولة", "طلبك جاهز ويُقدَّم لك على الطاولة.", "ready and being served to your table.", [], [], 120),
  st_served: t("حالة: تم التقديم", "تم تقديم طلبك ✅ بالعافية.", "served ✅", [], [], 120),
  st_refunded: t("حالة: مسترجع", "اعتذر المطعم عن الطلب وتم استرجاع المبلغ لوسيلة الدفع.", "the restaurant could not fulfil it and the amount was refunded to your payment method.", [], [], 160),
  st_refund_pending: t("حالة: الاسترجاع جاري", "استرجاع المبلغ جاري وفريقنا يتابعه.", "the refund is in progress and our team is following it.", [], [], 160),
  st_courier_arranging: t("حالة: نرتّب مندوب", "نرتّب مندوب لطلبك وفريقنا يتابعه.", "we are arranging a courier and our team is on it.", [], [], 160),
});
export const TEXT_KEYS = Object.keys(TEXTS);

/* wabot intent ⇒ مفتاح رد v1. اللي مش هنا ⇒ staff (تحويل). */
export const INTENT_MAP = Object.freeze({
  greeting: "greet", menu: "menu", item_price: "menu", item_info: "menu", recommend: "menu", servings: "menu", kids_menu: "menu",
  offers: "offers", how_to_order: "order",
  delivery: "delivery", delivery_area: "delivery", delivery_fee: "delivery", min_order: "delivery", delivery_time: "delivery",
  hours: "hours", open_now: "hours", special_hours: "hours", waitlist_join: "hours",
  location: "location", payment: "payment", order_status: "status",
  complaint: "complaint", refund: "complaint",
  payment_issue: "problem", site_issue: "problem", coupon_help: "problem",
  cancel_order: "change", modify_order: "change", cancel_or_stop: "change", special_request: "change",
  human: "human", thanks: "thanks", bye: "thanks", stop: "stop", start: "start", media: "media", unknown: "unknown",
});
export const REPLY_KEYS = ["greet", "menu", "order", "offers", "delivery", "hours", "location", "payment", "status", "complaint", "problem", "change", "human", "staff", "media", "unknown", "thanks", "stop", "start"];
const HANDOFF_KEYS = { complaint: ["complaint", "urgent"], problem: ["problem", "urgent"], change: ["order_change", "urgent"], human: ["asked_human", "normal"], staff: ["needs_staff", "normal"], media: ["media", "normal"] };
const BUTTON_IDS = { "bot:menu": "menu", "bot:status": "status", "bot:human": "human" };
const IGNORED_TYPES = new Set(["reaction", "sticker", "unsupported", "system", "ephemeral", "request_welcome", "order"]);
const MEDIA_TYPES = new Set(["image", "audio", "voice", "video", "document", "contacts", "location"]);

/* ── الإعدادات ──────────────────────────────────────────────────────────── */
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const slugOk = (s) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(s || ""));
export function botConfig(settings) {
  const x = (settings && settings.waBot) || {};
  const L = x.links || {};
  const adMap = {};
  for (const [k, v] of Object.entries(L.adMap || {})) if (/^\d{5,25}$/.test(String(k)) && slugOk(v)) adMap[String(k)] = String(v);
  return {
    mode: MODES.includes(x.mode) ? x.mode : "off",
    testPhones: staffPhones(x.testPhones),
    greetScope: x.greetScope === "ads" ? "ads" : "all",
    // humanWindowHours (١٢ ساعة) اتلغى ١٢/١٠: المخزّن القديم بيتجاهَل والسكوت بقى humanPauseMin (٣٠ دقيقة)
    humanPauseMin: num(x.humanPauseMin, 1, 720, DEFAULTS.humanPauseMin),
    staffWaitMin: num(x.staffWaitMin, 1, 15, DEFAULTS.staffWaitMin),
    closedEchoPauseMin: num(x.closedEchoPauseMin, 0, 120, DEFAULTS.closedEchoPauseMin),
    unknownWaitMin: num(x.unknownWaitMin, 0, 15, DEFAULTS.unknownWaitMin),
    manualMuteHours: num(x.manualMuteHours, 1, 168, DEFAULTS.manualMuteHours),
    handoffOpenHours: num(x.handoffOpenHours, 1, 168, DEFAULTS.handoffOpenHours),
    publicPhone: /^0\d{8,9}$/.test(String(x.publicPhone || "")) ? String(x.publicPhone) : "",
    freeRepliesPerMonth: num(x.freeRepliesPerMonth, 0, 100000, DEFAULTS.freeRepliesPerMonth),
    replyRateSar: num(x.replyRateSar, 0, 5, DEFAULTS.replyRateSar),
    greetWindowHours: num(x.greetWindowHours, 1, 168, DEFAULTS.greetWindowHours),
    maxAgeMinutes: num(x.maxAgeMinutes, 1, 120, DEFAULTS.maxAgeMinutes),
    duplicateSeconds: num(x.duplicateSeconds, 0, 3600, DEFAULTS.duplicateSeconds),
    maxRepliesPerHour: num(x.maxRepliesPerHour, 1, 30, DEFAULTS.maxRepliesPerHour),
    orderLookbackHours: num(x.orderLookbackHours, 1, 336, DEFAULTS.orderLookbackHours),
    lateAfterMinutes: num(x.lateAfterMinutes, 20, 600, DEFAULTS.lateAfterMinutes),
    interactive: x.interactive !== false,
    staffAlert: x.staffAlert !== false,
    alertInTest: x.alertInTest === true,
    alertPhones: staffPhones(x.alertPhones),
    maxAlertsPerHour: num(x.maxAlertsPerHour, 0, 60, DEFAULTS.maxAlertsPerHour),
    firstCode: /^[A-Z0-9-]{2,20}$/.test(String(x.firstCode || "")) ? String(x.firstCode) : DEFAULTS.firstCode,
    links: { organic: slugOk(L.organic) ? L.organic : DEFAULTS.links.organic, ads: slugOk(L.ads) ? L.ads : DEFAULTS.links.ads, adMap },
    intentsOff: (Array.isArray(x.intentsOff) ? x.intentsOff : []).filter((k) => REPLY_KEYS.includes(k)),
    texts: x.texts && typeof x.texts === "object" ? x.texts : {},
  };
}

const placeholders = (s) => [...String(s || "").matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
/* فحص نص معدَّل من اللوحة: مفتاح معروف، طول، ومتغيّرات مسموحة لهذا النص بس. */
export function textProblem(key, lang, value) {
  const def = TEXTS[key];
  if (!def) return "unknown_key";
  if (!["ar", "en"].includes(lang)) return "bad_lang";
  const s = String(value ?? "");
  if (!s.trim()) return null;                                   // فاضي = الافتراضي
  if ([...s].length > def.max) return `too_long:${def.max}`;
  if (/\{\{|\}\}/.test(s)) return "double_braces";
  const allowed = new Set([...def.vars, ...def.opt]);
  const bad = placeholders(s).filter((p) => !allowed.has(p));
  if (bad.length) return `unknown_placeholder:${bad.join(",")}`;
  if (/[{}]/.test(s.replace(/\{[a-z_]+\}/g, ""))) return "stray_brace";
  if (def.max <= LIMITS.footer && /\n/.test(s)) return "single_line_only";
  return null;
}
/* settings.waBot من جسم اللوحة — بيرجّع {ok, value} أو {ok:false, errors[]} */
export function configFromBody(b, prev = {}) {
  const errors = [];
  const src = b && typeof b === "object" ? b : {};
  const out = { ...prev };
  if ("mode" in src) { if (MODES.includes(src.mode)) out.mode = src.mode; else errors.push("mode"); }
  if ("testPhones" in src) {
    const raw = Array.isArray(src.testPhones) ? src.testPhones : String(src.testPhones || "").split(/[\s,،;]+/).filter(Boolean);
    const ok = staffPhones(raw);
    if (ok.length !== new Set(raw.map((x) => String(x).trim()).filter(Boolean)).size) errors.push("testPhones: رقم غير صحيح (المطلوب جوال سعودي 05XXXXXXXX)");
    out.testPhones = ok;
  }
  if ("alertPhones" in src) out.alertPhones = staffPhones(Array.isArray(src.alertPhones) ? src.alertPhones : String(src.alertPhones || "").split(/[\s,،;]+/));
  if ("greetScope" in src) { if (["all", "ads"].includes(src.greetScope)) out.greetScope = src.greetScope; else errors.push("greetScope"); }
  delete out.humanWindowHours;      // اتلغى (١٢/١٠) — أي حفظ بينضّف المخزّن القديم
  for (const k of ["humanPauseMin", "staffWaitMin", "closedEchoPauseMin", "unknownWaitMin", "manualMuteHours", "handoffOpenHours", "freeRepliesPerMonth", "replyRateSar",
    "greetWindowHours", "maxAgeMinutes", "duplicateSeconds", "maxRepliesPerHour", "orderLookbackHours", "lateAfterMinutes", "maxAlertsPerHour"]) {
    if (k in src) { if (Number.isFinite(Number(src[k])) && src[k] !== "" && src[k] !== null) out[k] = Number(src[k]); else errors.push(k); }
  }
  for (const k of ["interactive", "staffAlert", "alertInTest"]) if (k in src) out[k] = src[k] === true;
  if ("publicPhone" in src) {
    const d = String(src.publicPhone || "").replace(/[^\d]/g, "").replace(/^(00966|966)/, "0");
    if (!String(src.publicPhone || "").trim()) out.publicPhone = ""; else if (/^0\d{8,9}$/.test(d)) out.publicPhone = d; else errors.push("publicPhone: رقم غير صحيح");
  }
  if ("firstCode" in src) { if (/^[A-Z0-9-]{2,20}$/.test(String(src.firstCode || ""))) out.firstCode = String(src.firstCode); else errors.push("firstCode"); }
  if ("links" in src) {
    const L = src.links || {}, cur = { ...(prev.links || {}) };
    for (const k of ["organic", "ads"]) if (k in L) { if (slugOk(L[k])) cur[k] = String(L[k]); else errors.push(`links.${k}`); }
    if ("adMap" in L) {
      const m = {};
      for (const [k, v] of Object.entries(L.adMap || {})) { if (/^\d{5,25}$/.test(String(k)) && slugOk(v)) m[String(k)] = String(v); else errors.push(`links.adMap.${k}`); }
      cur.adMap = m;
    }
    out.links = cur;
  }
  if ("intentsOff" in src) out.intentsOff = (Array.isArray(src.intentsOff) ? src.intentsOff : []).filter((k) => REPLY_KEYS.includes(k));
  if ("texts" in src) {
    const cur = { ...(prev.texts || {}) };
    for (const [key, v] of Object.entries(src.texts || {})) {
      const row = { ...(cur[key] || {}) };
      for (const lang of ["ar", "en"]) {
        if (!v || !(lang in v)) continue;
        const p = textProblem(key, lang, v[lang]);
        if (p) { errors.push(`texts.${key}.${lang}: ${p}`); continue; }
        if (String(v[lang] ?? "").trim()) row[lang] = String(v[lang]).replace(/\r\n/g, "\n").trim(); else delete row[lang];
      }
      if (Object.keys(row).length) cur[key] = row; else delete cur[key];
    }
    out.texts = cur;
  }
  // وضع التجربة من غير أرقام = مفيش حد هيتردّ عليه؛ مش خطأ، بس وضع live/test محتاج قرار واضح
  if (out.mode === "test" && !(out.testPhones || []).length) errors.push("mode=test يحتاج رقم تجربة واحد على الأقل");
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/* ── التعبئة ────────────────────────────────────────────────────────────── */
export class DataMissing extends Error { constructor(what) { super(`data_missing:${what}`); this.what = what; } }
const langOf = (lang) => (lang === "en" ? "en" : "ar");
export function textOf(cfg, key, lang) {
  const def = TEXTS[key];
  if (!def) throw new DataMissing(`text:${key}`);
  const o = cfg.texts?.[key]?.[langOf(lang)];
  return o && !textProblem(key, langOf(lang), o) ? String(o) : def[langOf(lang)];
}
/* {x} إجباري من غير قيمة ⇒ DataMissing. اختياري من غير قيمة ⇒ سطره يتشال (لو السطر مافيهوش غيره) أو يتشال هو بس. */
export function fill(key, tpl, vars = {}) {
  const def = TEXTS[key];
  const lines = String(tpl).split("\n").map((line) => {
    const names = placeholders(line);
    if (!names.length) return line;
    let dead = false;
    const outLine = line.replace(/\{([a-z_]+)\}/g, (m, n) => {
      const v = vars[n];
      const has = v !== undefined && v !== null && String(v).trim() !== "";
      if (has) return String(v);
      if (def && def.opt.includes(n)) { if (!line.replace(/\{[a-z_]+\}/g, "").trim()) dead = true; return ""; }
      throw new DataMissing(`${key}.${n}`);
    });
    return dead ? null : outLine;
  }).filter((l) => l !== null);
  const s = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s || /\{[a-z_]+\}|undefined|NaN|\[object/.test(s)) throw new DataMissing(`${key}:render`);
  return s;
}
const money = (n) => { const x = Number(n); if (!Number.isFinite(x)) throw new DataMissing("money"); return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ""); };

/* البوكسات من /api/shop/bundles (نفس اللي المتجر بيعرضه): أقل سعر لكل قسم. */
export function boxTiers(bundles) {
  const m = new Map();
  for (const b of Array.isArray(bundles) ? bundles : []) {
    const sec = String(b?.section || "").trim(), price = Number(b?.price);
    if (!sec || !(price > 0)) continue;
    const cur = m.get(sec);
    if (!cur || price < cur.min) m.set(sec, { section: sec, section_en: String(b.section_en || "").trim() || sec, min: price, n: (cur?.n || 0) + 1 });
    else cur.n += 1;
  }
  return [...m.values()].sort((a, b) => a.min - b.min);
}
function boxesBlock(cfg, lang, data) {
  const tiers = boxTiers(data.bundles);
  if (!tiers.length) return "";
  const head = textOf(cfg, "boxes_head", lang);
  return [head, ...tiers.map((x) => (lang === "en" ? `• ${x.section_en} from SAR ${money(x.min)}` : `• ${x.section} من ${money(x.min)} ر.س`))].join("\n");
}
function firstLine(cfg, lang, data) {
  const c = data.first;
  if (!c || c.active === false || !c.free_delivery || !c.once_per_customer) return "";
  if (c.expires_at && Date.parse(c.expires_at) < data.now.getTime()) return "";
  const min = Number(c.min_total);
  if (!(min > 0)) return "";                 // النص بيقول «للطلبات من X» — من غير حد أدنى معروف مانقولش حاجة
  return fill("first_line", textOf(cfg, "first_line", lang), { first_min: money(min), first_code: c.code });
}
function loyaltyLine(cfg, lang, data) {
  const l = data.loyalty;
  if (!l || l.enabled !== true || l.reward !== "free_delivery" || !(Number(l.every) > 0) || !(Number(l.minTotal) > 0)) return "";
  return fill("loyalty_line", textOf(cfg, "loyalty_line", lang), { loy_every: String(l.every), loy_min: money(l.minTotal) });
}
export function feeLines(policy, lang) {
  const arr = Array.isArray(policy?.feeByTotal) ? [...policy.feeByTotal].map((x) => ({ over: Number(x.over), fee: Number(x.fee) })) : [];
  if (!arr.length || arr.some((x) => !Number.isFinite(x.over) || !Number.isFinite(x.fee) || x.fee < 0)) return "";
  arr.sort((a, b) => a.over - b.over);
  if (arr[0].over !== 0) return "";
  return arr.map((x, i) => {
    const next = arr[i + 1];
    const fee = x.fee === 0 ? (lang === "en" ? "free" : "مجاني") : (lang === "en" ? `SAR ${money(x.fee)}` : `${money(x.fee)} ر.س`);
    const range = i === 0 && next ? (lang === "en" ? `under SAR ${money(next.over)}` : `أقل من ${money(next.over)} ر.س`)
      : i === 0 ? (lang === "en" ? "any order" : "أي طلب") : (lang === "en" ? `SAR ${money(x.over)}+` : `من ${money(x.over)} ر.س`);
    return `• ${range}: ${fee}`;
  }).join("\n");
}
const opensText = (data, lang) => { try { return openingText(data.settings?.hours, data.now, lang); } catch { return ""; } };
function closedLine(cfg, lang, data, key = "closed_line") {
  if (!data.open || data.open.open) return "";
  const opens = opensText(data, lang);
  return opens ? fill(key, textOf(cfg, key, lang), { opens }) : "";
}
const pausedLine = (cfg, lang, data) => (data.open?.open && data.open.svc?.delivery?.paused && !data.open.delivery ? textOf(cfg, "paused_delivery", lang) : "");

/* حالة الطلب ⇒ مفتاح نص (نفس منطق صفحة التتبع: «المطعم أولاً») + هل نحوّل لموظف */
export function orderStatusKey(o) {
  const st = String(o.status || ""), ready = Boolean(o.pos_ready_at), table = Number(o.table_no) > 0;
  if (st === "rejected_refunded") return o.refund_id ? { key: "st_refunded" } : null;
  if (st === "refund_failed") return { key: "st_refund_pending", handoff: true };
  if (st === "paid_pos_failed") return { key: "st_confirming", handoff: true };
  if (st === "courier_cancelled") return { key: "st_courier_arranging", handoff: true };
  if (table) return st === "delivered" ? { key: "st_served" } : ready ? { key: "st_table_ready" } : ["paid", "pos_created"].includes(st) ? { key: "st_received" } : { key: "st_preparing" };
  if (o.option === "pickup") return st === "delivered" ? { key: "st_picked" } : ready ? { key: "st_pickup_ready" } : ["paid", "pos_created"].includes(st) ? { key: "st_received" } : st === "accepted" ? { key: "st_preparing" } : null;
  if (o.option !== "delivery") return null;
  if (st === "delivered") return { key: "st_delivered" };
  if (st === "on_the_way") return { key: "st_on_the_way" };
  if (o.handed_at) return { key: "st_handed" };
  if (ready) return { key: "st_ready_courier" };
  if (["paid", "pos_created"].includes(st)) return { key: "st_received" };
  if (["accepted", "courier_requested", "courier_assigned"].includes(st)) return { key: "st_preparing" };
  return null;
}
const ACTIVE = new Set(["paid", "pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way", "paid_pos_failed", "courier_cancelled"]);

/* ── بناء الرد (مجرّد): { body, footer?, cta?:{title,url}, buttons?:[{id,title}] } ───────── */
const linkUrl = (slug) => `${STORE}/l/${slug}`;
export function pickLink(cfg, data, referral) {
  const ref = referral || data.chat?.referral || null;
  const fresh = referral || (data.chat?.referral_at && data.now.getTime() - Date.parse(data.chat.referral_at) < 72 * 3600_000);
  let slug = cfg.links.organic;
  if (ref && fresh) slug = (ref.source_id && cfg.links.adMap[String(ref.source_id)]) || cfg.links.ads;
  const ok = (s) => data.links && data.links[s] === true;
  if (ok(slug)) return slug;
  if (ok(cfg.links.organic)) return cfg.links.organic;     // رابط الإعلان اتقفل ⇒ الرابط العادي (برضه متتبَّع)
  throw new DataMissing(`link:${slug}`);
}
export function buildReply(key, c) {
  const { cfg, lang, data } = c;
  const T = (k) => textOf(cfg, k, lang);
  const F = (k, vars) => fill(k, T(k), vars);
  // في الدوام: «يرد عليك في أقرب وقت». مقفول: ميعاد الفتح الحقيقي. حالة المواعيد مش معروفة: ولا وعد.
  const wait = () => (data.open && data.open.open === true ? T("when_open") : closedLine(cfg, lang, data, "wait_line"));
  const order = data.order || null;
  const withLink = (k, vars, ctaKey) => { const slug = pickLink(cfg, data, c.referral); return { body: F(k, vars), cta: { title: T(ctaKey), url: linkUrl(slug) }, link: slug }; };
  switch (key) {
    case "greet": return withLink("greet", { boxes: boxesBlock(cfg, lang, data), first: firstLine(cfg, lang, data), paused: pausedLine(cfg, lang, data), closed: closedLine(cfg, lang, data) }, "cta_order");
    case "menu": return withLink("menu", { boxes: boxesBlock(cfg, lang, data), closed: closedLine(cfg, lang, data) }, "cta_menu");
    case "order": return withLink("order", { first: firstLine(cfg, lang, data), paused: pausedLine(cfg, lang, data), closed: closedLine(cfg, lang, data) }, "cta_order");
    case "offers": return withLink("offers", { first: firstLine(cfg, lang, data), loyalty: loyaltyLine(cfg, lang, data), boxes: boxesBlock(cfg, lang, data) }, "cta_order");
    case "delivery": {
      const p = data.policy;
      const km = Number(p?.maxKm);
      if (!(km > 0)) throw new DataMissing("policy.maxKm");
      const far = p.farZoneEnabled !== false && Number(p.farZoneMaxKm) > km && Number(p.farZonePerKm) > 0
        ? F("far_line", { km: money(Number(p.farZoneFromKm) > 0 ? p.farZoneFromKm : km), far_km: money(p.farZoneMaxKm), far_fee: money(p.farZonePerKm) }) : "";
      return withLink("delivery", { km: money(km), far, fees: feeLines(p, lang), first: firstLine(cfg, lang, data), paused: pausedLine(cfg, lang, data) }, "cta_order");
    }
    case "hours": {
      const lines = hoursLines(data.settings?.hours, lang);
      if (!lines.length || !data.open) throw new DataMissing("hours");
      if (data.open.open) {
        if (!data.open.closesAt) throw new DataMissing("hours.closes");
        return { body: F("hours_open", { hours: lines.join("\n"), closes: fmtTime(data.open.closesAt, lang) }) };
      }
      if (c.factual) return { body: F("hours_closed_plain", { hours: lines.join("\n"), opens: opensText(data, lang) }) };   // شكوى مفتوحة: من غير رابط طلب
      return withLink("hours_closed", { hours: lines.join("\n"), opens: opensText(data, lang) }, "cta_cart");
    }
    case "location": {
      const url = String(data.settings?.googlePlace?.mapsUrl || MAPS_URL);
      if (!/^https:\/\/(maps\.google\.com|www\.google\.com\/maps|maps\.app\.goo\.gl|g\.page)\//.test(url)) throw new DataMissing("mapsUrl");
      return { body: T("location"), cta: { title: T("cta_map"), url } };
    }
    case "payment": {
      const f = (data.settings?.storefront?.seo?.faq || []).find((x) => /طرق الدفع|الدفع/.test(String(x?.q || "")));
      const ans = f && (lang === "en" ? (f.a_en || "") : (f.a || ""));
      return { body: F("payment", { payment: String(ans || "").trim() }) };
    }
    case "status": {
      if (data.orderDbFailed) throw new DataMissing("orders_db");
      if (!order) return { body: F("status_none", { wait: wait() }), handoff: ["order_not_found", "normal"] };
      const sk = orderStatusKey(order);
      if (!sk) throw new DataMissing(`status:${order.status}`);
      const mins = (data.now.getTime() - Date.parse(order.created_at)) / 60000;
      const late = ACTIVE.has(String(order.status)) && Number.isFinite(mins) && mins > cfg.lateAfterMinutes;
      const vars = { order_no: order.order_no, status: T(sk.key), wait: late ? wait() : "" };
      const r = { body: F(late ? "status_late" : "status_found", vars), cta: { title: T("cta_track"), url: `${STORE}/track/${encodeURIComponent(order.order_no)}` } };
      if (late) r.handoff = ["order_late", "urgent"]; else if (sk.handoff) r.handoff = ["order_issue", "urgent"];
      return r;
    }
    case "complaint": return { body: order ? F("complaint_known", { order_no: order.order_no, wait: wait() }) : F("complaint_ask", { wait: wait() }) };
    case "problem": case "change": case "human": case "staff": case "media": case "data_missing": case "rate":
      return { body: F(key, { wait: wait() }) };
    case "unknown": return { body: T("unknown"), buttons: [{ id: "bot:menu", title: T("btn_menu") }, { id: "bot:status", title: T("btn_status") }, { id: "bot:human", title: T("btn_human") }] };
    case "thanks": case "stop": case "start": return { body: T(key) };
    default: throw new DataMissing(`key:${key}`);
  }
}
/* المجرّد ⇒ جسم Cloud API. interactive=false ⇒ نص عادي (الرابط في آخره؛ الأزرار تتحوّل لتعليمات مكتوبة). */
export function toPayload(r, { cfg, lang, interactive = true } = {}) {
  const footer = textOf(cfg, "footer", lang);
  if (interactive && r.cta) return msgCta(r.body, r.cta.title, r.cta.url, { footer });
  if (interactive && r.buttons) return msgButtons(r.body, r.buttons, { footer });
  if (r.cta) return msgText(`${r.body}\n${r.cta.url}`, true);
  return msgText(r.body, false);
}
export function payloadProblem(p) {
  const s = JSON.stringify(p);
  if (/\{[a-z_]+\}|\{\{|undefined|NaN|\[object Object\]/.test(s)) return "placeholder";
  if (p.type === "text") return !p.text?.body?.trim() ? "empty" : [...p.text.body].length > LIMITS.text ? "too_long" : null;
  const i = p.interactive;
  if (!i?.body?.text?.trim()) return "empty";
  if ([...i.body.text].length > LIMITS.ibody || /…$/.test(i.body.text)) return "body_too_long";
  if (i.footer && [...i.footer.text].length > LIMITS.footer) return "footer_too_long";
  if (i.type === "cta_url") {
    const a = i.action?.parameters || {};
    if (!a.display_text || [...a.display_text].length > LIMITS.ctaText || /…$/.test(a.display_text)) return "cta_title";
    if (!/^https:\/\/(freshcuts\.sa\/(l\/[a-z0-9-]+|track\/W\d{6,20})$|maps\.google\.com\/|www\.google\.com\/maps|maps\.app\.goo\.gl\/|g\.page\/)/.test(String(a.url || ""))) return "cta_url";
    return null;
  }
  if (i.type === "button") {
    const b = i.action?.buttons || [];
    if (!b.length || b.length > LIMITS.btns) return "buttons_count";
    if (b.some((x) => !x.reply?.title || [...x.reply.title].length > LIMITS.btnTitle || /…$/.test(x.reply.title))) return "button_title";
    if (new Set(b.map((x) => x.reply.title)).size !== b.length) return "button_dup";
    return null;
  }
  return "type";
}

const EXTRA = [
  [/(?:^| )عند(?:كم|كو|ك) (?:ايه|اي|شنو|شو)(?: |$)|(?:^| )ايه (?:الاكل|المنيو|الاصناف)|(?:^| )(?:الاكل|الاصناف) (?:ايه|ايش|وش)(?: |$)/, "menu"],
  [/(?:^| )(?:عايز|عاوز|عايزه|عاوزه|بدي|ابي|ابغى|اريد) (?:اكل|وجبه|بوكس|اشوف)/, "menu"],
  [/(?:^| )(?:فين|وين|فينه|وينه) (?:الاوردر|اوردري|الاوردر بتاعي)|(?:^| )الاوردر (?:فين|وين|اتاخر)/, "status"],
];

/* ── القرار (صافي) ──────────────────────────────────────────────────────────
   ev   = { phone, text, type, interactiveId, referral, at, intent(stop|start من whatsapp.js) }
   ctx  = { cfg, now, chat, humanActive, repliesLastHour, lastSame:{key, at}, data }
   ⇒ { act: "reply"|"silent", reason, key, rawIntent, lang, score, reply?, payloads?, handoff?, mute?, greet?, optout?, link? } */
export function classify(ev) {
  const type = String(ev.type || "text");
  const rawText = String(ev.text || "");
  const placeholder = /^\[[^\]]*\]$/.test(rawText.trim());
  const text = placeholder ? "" : rawText;
  const lang = detectLang(text);
  if (ev.interactiveId && BUTTON_IDS[ev.interactiveId]) return { key: BUTTON_IDS[ev.interactiveId], rawIntent: `button:${ev.interactiveId}`, lang, score: 10, entities: {} };
  if (IGNORED_TYPES.has(type)) return { key: null, rawIntent: `type:${type}`, lang, score: 0, entities: {} };
  if (MEDIA_TYPES.has(type) && !text.trim()) return { key: "media", rawIntent: `media:${type}`, lang, score: 10, entities: {} };
  if (ev.intent === "stop" || ev.intent === "start") return { key: ev.intent, rawIntent: ev.intent, lang, score: 12, entities: {} };
  const m = matchIntent(text, { type: "text" });
  let key = INTENT_MAP[m.intent] || "staff";
  // صياغات شائعة (مصرية/شامية) قاموس wabot ما يعرفها — تتجرّب بس لو النتيجة «غير مفهوم»
  if (key === "unknown") { const n = normalize(text); const x = EXTRA.find(([re]) => re.test(n)); if (x) key = x[1]; }
  const om = text.match(ORDER_NO_RE);
  return { key, rawIntent: m.intent, lang: m.lang || lang, score: m.score, entities: { ...(m.entities || {}), orderNo: om ? om[1].toUpperCase() : null } };
}

/* رقم المطعم للتعريف: إعداد البوت، وإلا من إجابة «كيف أتواصل مع المطعم؟» في الأسئلة الشائعة (إعدادات المتجر) */
export function publicPhoneOf(cfg, settings) {
  if (cfg.publicPhone) return cfg.publicPhone;
  const f = (settings?.storefront?.seo?.faq || []).find((x) => /تواصل/.test(String(x?.q || "")));
  const m = f && String(f.a || "").match(/0\d{8,9}/);
  return m ? m[0] : "";
}
export function disclosureLine(cfg, lang, settings) {
  const phone = publicPhoneOf(cfg, settings);
  return phone ? fill("disclosure_phone", textOf(cfg, "disclosure_phone", lang), { phone }) : textOf(cfg, "disclosure", lang);
}

/* سكوت الموظف (قواعد ١ و٣ و٤ج و٦). lastEchoAt = آخر رسالة بعتها الموظف من موبايل المطعم للعميل ده.
   مقفول: الصدى اللي اتبعت والمطعم فاتح اتلغى ساعة الإقفال؛ الصدى اللي اتبعت والمطعم مقفول = سكوت قصير بس. */
export function pauseState({ cfg, now, open, lastEchoAt, hours }) {
  const t = lastEchoAt ? Date.parse(lastEchoAt) : NaN;
  if (!Number.isFinite(t) || t > now.getTime()) return { paused: false, until: null, kind: null };
  if (open === false) {
    let echoWhileOpen = true;
    try { echoWhileOpen = isOpenNow(hours, new Date(t)); } catch { echoWhileOpen = true; }
    if (echoWhileOpen) return { paused: false, until: null, kind: null, expired: "closing" };
    const until = t + cfg.closedEchoPauseMin * 60_000;
    return { paused: until > now.getTime(), until, kind: "staff_pause_closed" };
  }
  const until = t + cfg.humanPauseMin * 60_000;
  return { paused: until > now.getTime(), until, kind: "staff_pause" };
}
const FACTUAL_KEYS = new Set(["hours", "location", "status", "thanks", "stop", "start"]);
const SERIOUS = new Set(["complaint", "problem", "order_change", "order_late", "order_issue", "send_failed"]);
const iso = (ms) => new Date(ms).toISOString();

/* ctx = { cfg, now, chat, lastEchoAt, repliesLastHour, lastSame, failedRecently, data, cls, afterWait }
   afterWait = "staff_wait" | "unknown_wait" لما الرد المؤجّل وقته جه (والتشغيل اتأكد إن مفيش صدى بعد رسالة العميل).
   ⇒ act: "reply" | "silent" | "wait" (+ waitKind, dueAt) · resumeAt = امتى البوت هيرد تاني (للسجل). */
export function decide(ev, ctx) {
  const { cfg, now } = ctx;
  const c = ctx.cls || classify(ev);
  const base = { key: c.key, rawIntent: c.rawIntent, lang: c.lang, score: c.score };
  const silent = (reason, extra = {}) => ({ act: "silent", reason, ...base, ...extra });
  if (cfg.mode === "off") return silent("off");
  if (!/^5\d{8}$/.test(String(ev.phone || ""))) return silent("not_saudi_mobile");
  if (cfg.mode === "test" && !cfg.testPhones.includes(ev.phone)) return silent("test_mode_not_listed");
  if (!c.key) return silent("ignored_type");
  const at = ev.at ? Date.parse(ev.at) : now.getTime();
  const ageMin = (now.getTime() - (Number.isFinite(at) ? at : now.getTime())) / 60000;
  if (ageMin >= 24 * 60) return silent("outside_window");
  const waited = ctx.afterWait === "staff_wait" ? cfg.staffWaitMin : ctx.afterWait === "unknown_wait" ? cfg.unknownWaitMin : 0;
  if (ageMin > cfg.maxAgeMinutes + waited) return silent("stale");
  const optout = c.key === "stop" || c.key === "start" ? c.key : null;
  const chat = ctx.chat || {};
  const nowMs = now.getTime();

  // ٤أ) كتم يدوي من الموظف — بيفضل ماسك حتى والمطعم مقفول
  if (chat.muted_until && Date.parse(chat.muted_until) > nowMs) return silent("manual_mute", { optout, resumeAt: new Date(chat.muted_until).toISOString() });
  if (ctx.failedRecently && !optout) return silent("recent_send_failure");

  // ١/٣/٤ج/٦) سكوت الموظف
  const open = ctx.data && ctx.data.open ? ctx.data.open.open === true : null;
  const ps = pauseState({ cfg, now, open, lastEchoAt: ctx.lastEchoAt, hours: ctx.data?.settings?.hours });
  if (ps.paused && !ctx.afterWait) {
    if (optout) return silent(ps.kind, { optout, resumeAt: iso(ps.until) });
    // ٢) نية معروفة: نستنى الموظف staffWaitMin وبعدها نرد. غير مفهوم: للموظف (هو في المحادثة).
    if (c.key === "unknown") return silent(ps.kind, { resumeAt: iso(ps.until), detail: "unknown_left_to_staff" });
    const due = Math.min(nowMs + cfg.staffWaitMin * 60_000, ps.until);
    return { act: "wait", waitKind: "staff_wait", dueAt: iso(due), resumeAt: iso(due), reason: ps.kind, ...base };
  }

  let key = c.key, handoff = null;
  if (cfg.intentsOff.includes(key) && !optout) { key = "staff"; }

  // ٤ب) تحويل مفتوح: شكوى ⇒ معلومات بس. طلب موظف اتكرر ⇒ الفريق اتنبّه خلاص، مفيش رسالة ولا تنبيه تاني.
  const hoAt = chat.handoff_at ? Date.parse(chat.handoff_at) : NaN;
  const ho = Number.isFinite(hoAt) && nowMs - hoAt < cfg.handoffOpenHours * 3600_000 ? String(chat.handoff_reason || "handover") : null;
  const hoUntil = ho ? iso(hoAt + cfg.handoffOpenHours * 3600_000) : null;
  const factual = Boolean(ho && SERIOUS.has(ho));
  if (factual && !FACTUAL_KEYS.has(key)) return silent("handoff_open", { key, resumeAt: hoUntil, detail: ho });
  if (ho && !factual && HANDOFF_KEYS[key] && !SERIOUS.has(HANDOFF_KEYS[key][0])) return silent("handoff_open", { key, resumeAt: hoUntil, detail: ho });

  if (key === "greet") {
    const hasAd = Boolean(ev.referral) || Boolean(chat.referral_at && nowMs - Date.parse(chat.referral_at) < 72 * 3600_000);
    if (cfg.greetScope === "ads" && !hasAd) return silent("greet_ads_only");
    if (chat.last_greet_at && nowMs - Date.parse(chat.last_greet_at) < cfg.greetWindowHours * 3600_000) {
      return silent("already_greeted", { resumeAt: iso(Date.parse(chat.last_greet_at) + cfg.greetWindowHours * 3600_000) });
    }
  }
  const wasUnknown = key === "unknown";
  if (key === "unknown" && Number(chat.unknown_streak) >= 1) { key = "human"; handoff = ["not_understood_twice", "normal"]; }
  if (!optout && ctx.repliesLastHour >= cfg.maxRepliesPerHour) return silent("rate_limited");
  if (!optout && ctx.repliesLastHour === cfg.maxRepliesPerHour - 1 && !HANDOFF_KEYS[key]) { key = "rate"; handoff = ["rate_limit", "normal"]; }
  if (ctx.lastSame && ctx.lastSame.key === key && key !== "status" && nowMs - Date.parse(ctx.lastSame.at) < cfg.duplicateSeconds * 1000) return silent("duplicate", { key });
  // ٥) في الدوام: الغير مفهوم يستنى الموظف قبل القائمة. مقفول: فوراً.
  if (wasUnknown && key !== "rate" && open !== false && !ctx.afterWait && cfg.unknownWaitMin > 0) {
    const due = nowMs + cfg.unknownWaitMin * 60_000;
    return { act: "wait", waitKind: "unknown_wait", dueAt: iso(due), resumeAt: iso(due), reason: "unknown_wait", ...base };
  }
  if (HANDOFF_KEYS[key] && !handoff) handoff = HANDOFF_KEYS[key];

  const interactive = cfg.interactive && ctx.interactive !== false;
  const bc = { cfg, lang: c.lang, data: ctx.data, referral: ev.referral || null, factual };
  let reply, problem = null;
  try { reply = buildReply(key, bc); }
  catch (e) { problem = e instanceof DataMissing ? e.what : `error:${e.message}`; }
  if (problem) {
    try { reply = buildReply("data_missing", bc); handoff = ["data_missing", "normal"]; key = "data_missing"; }
    catch (e2) { return { act: "silent", reason: "build_failed", ...base, key, detail: problem, handoff: ["data_missing", "normal"] }; }
  }
  if (reply.handoff) handoff = reply.handoff;
  // تحويل مفتوح أصلاً ⇒ مفيش تنبيه تاني للفريق على نفس المحادثة (إلا لو الجديد أخطر من القديم)
  if (handoff && ho && !(SERIOUS.has(handoff[0]) && !SERIOUS.has(ho))) handoff = null;
  // ٧) التعريف: أول رسالة من البوت في المحادثة (مرة كل ٢٤ ساعة)
  const disclose = !chat.last_disclosed_at || nowMs - Date.parse(chat.last_disclosed_at) >= 24 * 3600_000;
  if (disclose) {
    try { reply = { ...reply, body: `${disclosureLine(cfg, c.lang, ctx.data?.settings)}\n${reply.body}` }; }
    catch { /* نص التعريف اتعدّل غلط ⇒ الرد يطلع من غيره أحسن ما مايطلعش */ }
  }
  const payload = toPayload(reply, { cfg, lang: c.lang, interactive });
  const fallback = toPayload(reply, { cfg, lang: c.lang, interactive: false });
  const pp = payloadProblem(payload) || payloadProblem(fallback);
  if (pp) return { act: "silent", reason: "payload_invalid", ...base, key, detail: pp, handoff: handoff || ["data_missing", "normal"] };
  return { act: "reply", reason: problem ? `data_missing:${problem}` : (ctx.afterWait ? `after_${ctx.afterWait}` : null), ...base, key, payloads: [payload], fallback: [fallback], handoff,
    greet: key === "greet", optout, link: reply.link || null, unknown: key === "unknown", disclose, factual };
}

/* نص تنبيه الفريق — رسالة SMS واحدة (fitOneSms حارس أخير). مفيش اسم العميل ولا نص رسالته. */
const REASON_EN = { complaint: "complaint", problem: "payment/site problem", order_change: "change/cancel order", asked_human: "asked for staff", needs_staff: "question for staff",
  media: "sent photo/voice", not_understood_twice: "not understood", rate_limit: "many messages", data_missing: "bot could not answer", order_not_found: "order not found",
  order_late: "LATE order", order_issue: "order issue", send_failed: "bot reply failed" };
const REASON_AR = { complaint: "شكوى", problem: "مشكلة دفع/موقع", order_change: "تعديل/الغاء طلب", asked_human: "طلب موظف", needs_staff: "سؤال", media: "صورة/صوت",
  not_understood_twice: "غير مفهوم", rate_limit: "رسائل كثيرة", data_missing: "البوت لم يجب", order_not_found: "طلب غير موجود", order_late: "طلب متاخر", order_issue: "مشكلة طلب", send_failed: "فشل رد البوت" };
export function alertText({ phone, reason, orderNo = null }, lang = "en") {
  const ph = `0${phone}`;
  if (lang === "ar") return fitOneSms(`فريش كاتس واتساب: ${ph} يحتاج موظف (${REASON_AR[reason] || "تحويل"})`);
  return fitOneSms(`Fresh Cuts WhatsApp: customer ${ph} needs staff (${REASON_EN[reason] || "handover"})${orderNo ? ` order ${orderNo}` : ""}. Reply from the restaurant phone.`);
}

/* ═══ التشغيل ═════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const isOwner = ctx.isOwner || (() => true);
  const wa = deps.wa;
  const sendSms = deps.sendSms || null;
  const clock = deps.now || (() => new Date());
  const self = deps.app || app;
  const fetchBundles = deps.fetchBundles || (async () => {
    const r = await self.request("/api/shop/bundles");
    if (!r.ok) throw new Error(`bundles HTTP ${r.status}`);
    return (await r.json())?.bundles || [];
  });

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_bot_chats (
        phone_norm TEXT PRIMARY KEY,
        muted_until TIMESTAMPTZ, mute_reason TEXT,
        last_greet_at TIMESTAMPTZ,
        unknown_streak INT NOT NULL DEFAULT 0,
        last_key TEXT, last_key_at TIMESTAMPTZ,
        referral JSONB, referral_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wa_bot_log (
        id BIGSERIAL PRIMARY KEY,
        wamid TEXT UNIQUE,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        msg_at TIMESTAMPTZ,
        phone_norm TEXT, mode TEXT, msg_type TEXT, text TEXT,
        intent TEXT, reply_key TEXT, score REAL, lang TEXT,
        decision TEXT,                 -- pending | replied | dry | silent | failed
        reason TEXT, detail TEXT,
        replies JSONB, sent INT NOT NULL DEFAULT 0, error TEXT,
        handoff TEXT, alert TEXT, link_slug TEXT, referral BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS wa_bot_log_phone_idx ON wa_bot_log(phone_norm, at DESC);
      -- ١٢/١٠ (قواعد السكوت): التحويل المفتوح + آخر تعريف + مين كتم؛ وامتى البوت هيرد تاني؛ والردود المؤجّلة
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS handoff_reason TEXT;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS last_disclosed_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS muted_by TEXT;
      ALTER TABLE wa_bot_log ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS wa_bot_jobs (
        id BIGSERIAL PRIMARY KEY,
        wamid TEXT UNIQUE,                 -- رسالة العميل اللي الرد المؤجّل ده ليها (رد واحد لكل رسالة)
        phone_norm TEXT, kind TEXT,        -- staff_wait | unknown_wait
        due_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | cancelled
        reason TEXT, ev JSONB, log_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), done_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS wa_bot_jobs_due_idx ON wa_bot_jobs(due_at) WHERE status = 'pending';
      -- السكوت القديم (١٢ ساعة بعد التحويل) اتلغى: muted_until بقى للكتم اليدوي بس
      UPDATE wa_bot_chats SET handoff_at = COALESCE(handoff_at, updated_at), handoff_reason = COALESCE(handoff_reason, mute_reason), muted_until = NULL, mute_reason = NULL
       WHERE muted_until IS NOT NULL AND mute_reason IS DISTINCT FROM 'manual';
      CREATE INDEX IF NOT EXISTS wa_bot_log_at_idx ON wa_bot_log(at DESC);
    `);
    for (const l of SEED_LINKS) {
      await pool.query(
        `INSERT INTO cms_links(slug, label, target_type, target_id, coupon, utm_source, utm_medium, utm_campaign, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'wabot') ON CONFLICT (slug) DO NOTHING`,
        [l.slug, l.label, l.target_type, l.target_id, l.coupon, l.utm_source, l.utm_medium, l.utm_campaign]).catch(() => {});
    }
    // الخصوصية: سجل البوت ٩٠ يوم
    await pool.query("DELETE FROM wa_bot_log WHERE at < NOW() - INTERVAL '90 days'").catch(() => {});
  }
  const ready = ensureSchema().then(() => console.log("[wabot] runtime ready")).catch((e) => console.error("[wabot] init failed:", e.message));

  let bundleCache = { at: 0, rows: null };
  async function bundles() {
    if (bundleCache.rows && Date.now() - bundleCache.at < 5 * 60_000) return bundleCache.rows;
    try { const rows = await fetchBundles(); if (Array.isArray(rows) && rows.length) bundleCache = { at: Date.now(), rows }; }
    catch (e) { console.error("[wabot] bundles:", e.message); }
    return bundleCache.rows && Date.now() - bundleCache.at < 60 * 60_000 ? bundleCache.rows : [];   // كاش أقدم من ساعة مايتعرضش
  }
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { console.error("[wabot] db:", e.message); return null; } };

  /* البيانات الحية لرسالة واحدة. أي مصدر وقع ⇒ قيمته null/فاضية ⇒ الرد اللي محتاجه بيتحوّل لموظف. */
  async function loadData({ settings, cfg, phone, orderNo, key, now }) {
    const data = { settings, now, bundles: [], policy: null, first: null, loyalty: null, order: null, links: {}, open: null, chat: null };
    try { data.open = settings?.hours ? openState(settings, now) : null; } catch { data.open = null; }
    try { data.loyalty = loyaltyCfgOf(settings); } catch { data.loyalty = null; }
    const need = (...ks) => ks.includes(key);
    if (need("greet", "menu", "offers")) data.bundles = await bundles();
    if (need("delivery")) { const r = await q("SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1", []); data.policy = r && r[0] ? r[0].config : null; }
    if (need("greet", "order", "offers", "delivery")) {
      const r = await q(`SELECT code, min_total, free_delivery, once_per_customer, active, expires_at FROM shop_coupons WHERE code=$1 AND active AND phone_norm IS NULL LIMIT 1`, [cfg.firstCode]);
      data.first = r && r[0] ? r[0] : null;
    }
    if (need("status", "complaint")) {
      const cols = `order_no, status, option, total, created_at, pos_ready_at, refund_id, to_jsonb(shop_orders)->>'handed_at' AS handed_at, NULLIF(to_jsonb(shop_orders)->>'table_no','')::int AS table_no`;
      const r = orderNo
        ? await q(`SELECT ${cols} FROM shop_orders WHERE order_no=$1 AND phone_norm=$2 AND status NOT IN ('expired','pending_payment') LIMIT 1`, [orderNo, phone])
        : await q(`SELECT ${cols} FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment')
                    AND created_at > NOW() - make_interval(hours => $2::int) ORDER BY created_at DESC LIMIT 1`, [phone, Math.ceil(cfg.orderLookbackHours)]);
      if (r === null) data.orderDbFailed = true;        // القاعدة ماردّتش ⇒ مانقولش «مافيه طلب» — نحوّل لموظف
      data.order = r && r[0] ? r[0] : null;
    }
    const slugs = [...new Set([cfg.links.organic, cfg.links.ads, ...Object.values(cfg.links.adMap)])];
    const lr = await q("SELECT slug FROM cms_links WHERE slug = ANY($1::text[]) AND active", [slugs]);
    for (const x of lr || []) data.links[x.slug] = true;
    return data;
  }

  async function chatOf(phone) { const r = await q("SELECT * FROM wa_bot_chats WHERE phone_norm=$1", [phone]); return (r && r[0]) || {}; }
  const isoOf = (v) => (v ? new Date(v).toISOString() : null);
  async function recent(phone, key) {
    const r = await q(`SELECT count(*) FILTER (WHERE decision IN ('replied','dry') AND at > NOW() - INTERVAL '1 hour')::int AS n,
                              max(at) FILTER (WHERE decision IN ('replied','dry') AND reply_key=$2) AS same_at,
                              max(at) FILTER (WHERE decision='failed' AND error NOT LIKE 'skipped:%' AND at > NOW() - INTERVAL '10 minutes') AS failed_at
                         FROM wa_bot_log WHERE phone_norm=$1 AND at > NOW() - INTERVAL '1 hour'`, [phone, key]);
    const x = (r && r[0]) || {};
    return { n: Number(x.n) || 0, lastSame: x.same_at ? { key, at: isoOf(x.same_at) } : null, failedRecently: Boolean(x.failed_at) };
  }
  /* آخر رسالة بعتها الموظف من موبايل المطعم للعميل ده (صدى) — بالثانية، مش «فيه/مافيش» */
  async function lastEcho(phone) {
    const r = await q(`SELECT max(created_at) AS at FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > NOW() - INTERVAL '24 hours'`, [phone]);
    return r && r[0] && r[0].at ? isoOf(r[0].at) : null;
  }

  async function alertStaff(settings, cfg, { phone, reason, orderNo }) {
    if (!cfg.staffAlert) return "off";
    if (!sendSms) return "no_sender";
    const sc = staffConfig(settings);
    const phones = cfg.alertPhones.length ? cfg.alertPhones : sc.alertPhones;
    if (!phones.length) return "no_phones";
    const cap = await q("SELECT count(*)::int AS n FROM wa_bot_log WHERE alert='sent' AND at > NOW() - INTERVAL '1 hour'", []);
    if (cfg.maxAlertsPerHour && cap && Number(cap[0]?.n) >= cfg.maxAlertsPerHour) return "capped";
    const body = alertText({ phone, reason, orderNo }, sc.lang);
    let sent = 0;
    for (const p of phones) {
      try { const r = await sendSms({ phoneNorm: p, body, kind: "staff", ref: `wabot ${reason}` }); if (!(r && r.suppressed)) sent++; }
      catch (e) { console.error(`[wabot] alert → ${p.slice(-4)} failed:`, e.message); }
    }
    return sent ? "sent" : "failed";
  }

  const finishLog = (logId, d) => q(
    `UPDATE wa_bot_log SET decision=$2, reason=$3, detail=$4, reply_key=COALESCE($5, reply_key), replies=$6, sent=$7, error=$8, handoff=$9, alert=$10, link_slug=$11, resume_at=$12 WHERE id=$1`,
    [logId, d.decision, d.reason || null, d.detail ? String(d.detail).slice(0, 200) : null, d.key || null, d.replies ? jb(d.replies) : null,
      d.sent || 0, d.error ? String(d.error).slice(0, 200) : null, d.handoff || null, d.alert || null, d.link || null, d.resumeAt || null]);

  /* رسالة واردة واحدة. بترجّع true لو البوت «ماسك» (أي وضع غير off). عمرها ما بترمي. */
  async function handle(ev) {
    let settings;
    try { settings = (await getSettingsData()) || {}; } catch { return false; }
    const cfg = botConfig(settings);
    if (cfg.mode === "off") return false;
    if (ev.isEcho) return true;
    await ready;
    const phone = String(ev.phone || "");
    const cls = classify(ev);
    // ١) احجز الـwamid — ويب هوك مكرر مايتعالجش مرتين
    const claim = await q(
      `INSERT INTO wa_bot_log(wamid, msg_at, phone_norm, mode, msg_type, text, intent, reply_key, score, lang, decision, referral)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [ev.wamid || null, ev.at || null, phone || null, cfg.mode, String(ev.type || "text").slice(0, 20), String(ev.text || "").slice(0, 300),
        String(cls.rawIntent || "").slice(0, 40), cls.key, Number(cls.score) || 0, cls.lang, Boolean(ev.referral)]);
    if (!claim || !claim.length) return true;                // مكرر، أو القاعدة واقعة ⇒ مانردّش على حاجة مش متسجّلة
    await work(ev, claim[0].id, settings, cfg, null);
    return true;
  }

  /* القرار والتنفيذ لرسالة واحدة. afterWait = نوع الرد المؤجّل لما وقته ييجي (وإلا null). عمرها ما بترمي. */
  async function work(ev, logId, settings, cfg, afterWait) {
    const phone = String(ev.phone || "");
    const now = clock();
    const cls = classify(ev);
    const finish = (d) => finishLog(logId, d);
    try {
      // ٢) الإعلان: نحفظ مصدره على المحادثة من أول رسالة (حتى لو هنسكت)
      if (!afterWait && ev.referral && /^5\d{8}$/.test(phone)) {
        const r = ev.referral;
        const ref = { source_id: r.source_id || null, source_type: r.source_type || null, source_url: r.source_url || null, headline: r.headline ? String(r.headline).slice(0, 120) : null, ctwa_clid: r.ctwa_clid || null };
        await q(`INSERT INTO wa_bot_chats(phone_norm, referral, referral_at) VALUES ($1,$2,NOW())
                 ON CONFLICT (phone_norm) DO UPDATE SET referral=$2, referral_at=NOW(), updated_at=NOW()`, [phone, jb(ref)]);
      }
      const ok = /^5\d{8}$/.test(phone);
      const chat = await chatOf(phone);
      const echoAt = ok ? await lastEcho(phone) : null;
      const rc = cls.key ? await recent(phone, cls.key) : { n: 0, lastSame: null, failedRecently: false };
      let data;
      try { data = await loadData({ settings, cfg, phone, orderNo: cls.entities?.orderNo || null, key: cls.key, now }); }
      catch (e) {   // مصدر بيانات وقع كله ⇒ بيانات فاضية: أي رد محتاج بيانات هيتحوّل لموظف من نفسه (DataMissing)
        console.error("[wabot] data:", e.message);
        data = { settings, now, bundles: [], policy: null, first: null, loyalty: null, order: null, orderDbFailed: true, links: {}, open: null };
      }
      data.chat = chat;
      const d = decide(ev, { cfg, now, chat, lastEchoAt: echoAt, repliesLastHour: rc.n, lastSame: rc.lastSame, failedRecently: rc.failedRecently, data, cls, afterWait });

      // «إيقاف/اشتراك» بصياغة أوسع من اللي whatsapp.js بيمسكها ⇒ نطبّقها هنا (حتى لو هنسكت)
      if (d.optout && !ev.intent && !afterWait && typeof wa.applyIntent === "function") { try { await wa.applyIntent(phone, d.optout); } catch (e) { console.error("[wabot] optout:", e.message); } }

      if (d.act === "wait") {
        // رد مؤجّل: صف في القاعدة (بيعيش بعد إعادة التشغيل). وقت التنفيذ كل الشروط بتتراجع من جديد.
        const evLite = { phone, phoneNorm: phone, wamid: ev.wamid || null, text: String(ev.text || "").slice(0, 1000), type: ev.type || "text",
          interactiveId: ev.interactiveId || null, referral: ev.referral || null, at: ev.at || now.toISOString(), intent: ev.intent || null };
        const j = await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
          [ev.wamid || null, phone, d.waitKind, d.dueAt, jb(evLite), logId]);
        await finish({ decision: j && j.length ? "waiting" : "silent", reason: j && j.length ? d.reason : "job_not_saved", key: d.key, resumeAt: d.resumeAt });
        return;
      }
      if (d.act === "silent") {
        let alert = null;
        if (d.handoff) alert = await handoffNow(settings, cfg, phone, d.handoff, data.order?.order_no);
        await finish({ decision: "silent", reason: d.reason, detail: d.detail, key: d.key, handoff: d.handoff ? d.handoff[0] : null, alert, resumeAt: d.resumeAt });
        return;
      }
      // ٣) الإرسال: dry = مفيش. test = قايمة التجربة بس. live = الأقفال الكاملة. محاولة واحدة (+ نص عادي لو التفاعلي فشل).
      let sent = 0, error = null, used = d.payloads;
      if (cfg.mode !== "dry") {
        const allowList = cfg.mode === "test" ? cfg.testPhones : null;
        let r = await wa.sendFreeform({ phoneNorm: phone, payload: d.payloads[0], source: "bot", allowList });
        if (!r.ok && !r.skipped && d.payloads[0].type === "interactive") {
          used = d.fallback;
          r = await wa.sendFreeform({ phoneNorm: phone, payload: d.fallback[0], source: "bot", allowList });
        }
        if (r.ok) sent = 1; else error = r.skipped ? `skipped:${r.skipped}` : `${r.error || "send_failed"}${r.message ? ` ${r.message}` : ""}`;
      }
      const okSent = cfg.mode === "dry" || sent > 0;
      // ٤) الحالة: التحية، التعريف، عدّاد «غير مفهوم»، آخر رد
      if (okSent) {
        await q(`INSERT INTO wa_bot_chats(phone_norm, last_greet_at, unknown_streak, last_key, last_key_at, last_disclosed_at)
                 VALUES ($1, CASE WHEN $2 THEN NOW() END, CASE WHEN $3 THEN 1 ELSE 0 END, $4, NOW(), CASE WHEN $5 THEN NOW() END)
                 ON CONFLICT (phone_norm) DO UPDATE SET
                   last_greet_at = CASE WHEN $2 THEN NOW() ELSE wa_bot_chats.last_greet_at END,
                   unknown_streak = CASE WHEN $3 THEN wa_bot_chats.unknown_streak + 1 ELSE 0 END,
                   last_disclosed_at = CASE WHEN $5 THEN NOW() ELSE wa_bot_chats.last_disclosed_at END,
                   last_key = $4, last_key_at = NOW(), updated_at = NOW()`, [phone, d.greet === true, d.unknown === true, d.key, d.disclose === true]);
      }
      // ٥) التحويل: يتسجّل «مفتوح» على المحادثة + تنبيه. فشل الإرسال نفسه = تحويل (العميل ماوصلوش حاجة) من غير محاولة تانية.
      let handoff = d.handoff, alert = null;
      if (!okSent && /^skipped:/.test(error || "")) handoff = null;      // الأقفال مقفولة (وضع live من غير مفاتيح واتساب) ⇒ البوت عملياً مقفول: لا تسجيل ولا تنبيه
      else if (!okSent) handoff = ["send_failed", "urgent"];
      if (handoff) alert = await handoffNow(settings, cfg, phone, handoff, data.order?.order_no);
      await finish({ decision: cfg.mode === "dry" ? "dry" : sent ? "replied" : "failed", reason: d.reason, key: d.key, replies: used, sent, error,
        handoff: handoff ? handoff[0] : null, alert, link: d.link });
    } catch (e) {
      console.error("[wabot] work:", e.message);
      await finish({ decision: "failed", reason: "exception", error: e.message });
    }
  }
  async function handoffNow(settings, cfg, phone, handoff, orderNo) {
    if (/^5\d{8}$/.test(phone)) {
      await q(`INSERT INTO wa_bot_chats(phone_norm, handoff_at, handoff_reason) VALUES ($1, NOW(), $2)
               ON CONFLICT (phone_norm) DO UPDATE SET handoff_at = NOW(), handoff_reason = $2, unknown_streak = 0, updated_at = NOW()`, [phone, handoff[0]]);
    }
    if (cfg.mode === "dry") return "would";
    if (cfg.mode === "test" && !cfg.alertInTest) return "would";
    return alertStaff(settings, cfg, { phone, reason: handoff[0], orderNo });
  }

  /* ── الردود المؤجّلة (قواعد ٢ و٥) ─────────────────────────────────────────
     كل ١٥ ثانية: الصفوف اللي وقتها جه. الحجز بـUPDATE … WHERE status='pending' ⇒ نسخة واحدة بس بتنفّذ، وصف اتحجز
     ووقع السيرفر في نصه بيفضل running وعمره ما يتبعت تاني (الأمان قبل الاكتمال). وقت التنفيذ بنراجع من جديد:
     الوضع (off ⇒ إلغاء)، الموظف رد بعد رسالة العميل (⇒ إلغاء)، التأخير عن الميعاد (⇒ إلغاء)، وبعدها decide كاملة
     (قايمة التجربة، الكتم اليدوي، نافذة الـ٢٤ ساعة، الحدود…). */
  async function runDueJobs() {
    await ready;
    const due = await q(`SELECT id FROM wa_bot_jobs WHERE status='pending' AND due_at <= $1 ORDER BY due_at LIMIT 25`, [clock().toISOString()]);
    let ran = 0;
    for (const row of due || []) {
      const got = await q(`UPDATE wa_bot_jobs SET status='running' WHERE id=$1 AND status='pending' RETURNING id, wamid, phone_norm, kind, due_at, ev, log_id`, [row.id]);
      if (!got || !got.length) continue;
      const j = got[0];
      const end = (status, reason) => q(`UPDATE wa_bot_jobs SET status=$2, reason=$3, done_at=NOW() WHERE id=$1`, [j.id, status, reason || null]);
      const cancel = async (reason) => { await end("cancelled", reason); await finishLog(j.log_id, { decision: "silent", reason }); };
      try {
        const settings = (await getSettingsData()) || {};
        const cfg = botConfig(settings);
        const ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
        const now = clock();
        if (cfg.mode === "off") { await cancel("mode_off"); continue; }
        if (now.getTime() - new Date(j.due_at).getTime() > cfg.maxAgeMinutes * 60_000) { await cancel("stale"); continue; }
        const echo = await q(`SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > $2 LIMIT 1`, [j.phone_norm, ev.at || new Date(j.due_at).toISOString()]);
        if (echo === null) { await cancel("echo_check_failed"); continue; }      // مانعرفش الموظف رد ولا لأ ⇒ مانردّش
        if (echo.length) { await cancel("staff_answered"); continue; }
        await work(ev, j.log_id, settings, cfg, j.kind === "unknown_wait" ? "unknown_wait" : "staff_wait");
        await end("done", null);
        ran++;
      } catch (e) { console.error("[wabot] job:", e.message); await end("cancelled", "exception"); }
    }
    return ran;
  }
  let timer = null;
  if (!deps.noTimer) { timer = setInterval(() => { runDueJobs().catch((e) => console.error("[wabot] jobs:", e.message)); }, 15_000); if (timer.unref) timer.unref(); }

  /* كتم يدوي: الموظف ماسك المحادثة بنفسه. بيفضل ماسك حتى والمطعم مقفول، وبينتهي لوحده. */
  async function muteChat(phone, hours, by) {
    const h = Math.min(168, Math.max(1, Math.ceil(Number(hours) || 0)));
    await ready;
    await q(`INSERT INTO wa_bot_chats(phone_norm, muted_until, mute_reason, muted_by) VALUES ($1, NOW() + make_interval(hours => $2::int), 'manual', $3)
             ON CONFLICT (phone_norm) DO UPDATE SET muted_until = NOW() + make_interval(hours => $2::int), mute_reason='manual', muted_by=$3, updated_at=NOW()`, [phone, h, by ? String(by).slice(0, 60) : null]);
    await q(`UPDATE wa_bot_jobs SET status='cancelled', reason='manual_mute', done_at=NOW() WHERE phone_norm=$1 AND status='pending'`, [phone]);
    return { ok: true, hours: h };
  }
  /* رجّع البوت: بيشيل الكتم اليدوي والتحويل المفتوح وعدّاد «غير مفهوم» */
  async function unmuteChat(phone) {
    await ready;
    await q("UPDATE wa_bot_chats SET muted_until=NULL, mute_reason=NULL, muted_by=NULL, handoff_at=NULL, handoff_reason=NULL, unknown_streak=0, updated_at=NOW() WHERE phone_norm=$1", [phone]);
    return { ok: true };
  }
  if (wa && typeof wa.setBotRuntime === "function") wa.setBotRuntime(handle);

  /* ── مسارات اللوحة ───────────────────────────────────────────────────── */
  const ownerOnly = (c) => (isOwner(c) ? null : c.json({ ok: false, error: "owner_only", message: "التعديل ده للمالك بس" }, 403));
  const textsMeta = () => TEXT_KEYS.map((k) => ({ key: k, label: TEXTS[k].label, ar: TEXTS[k].ar, en: TEXTS[k].en, vars: TEXTS[k].vars, opt: TEXTS[k].opt, max: TEXTS[k].max }));

  app.get("/api/cms/wabot/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const settings = (await getSettingsData()) || {};
    const cfg = botConfig(settings);
    const gate = wa && wa.gate ? await wa.gate() : "no_wa";
    const slugs = [...new Set([cfg.links.organic, cfg.links.ads, ...Object.values(cfg.links.adMap)])];
    const lr = (await q("SELECT slug, active, clicks, target_type, target_id, utm_campaign, coupon FROM cms_links WHERE slug = ANY($1::text[])", [slugs])) || [];
    return c.json({ ok: true, config: cfg, defaults: DEFAULTS, texts: textsMeta(), replyKeys: REPLY_KEYS, modes: MODES,
      state: { configured: wa?.configured ? wa.configured() : false, liveGate: gate,   // null = الأقفال مفتوحة؛ غير كده اسم القفل اللي مانع وضع live
        liveReady: !gate, staffLang: staffConfig(settings).lang, publicPhone: publicPhoneOf(cfg, settings),
        open: (() => { try { return settings?.hours ? openState(settings, clock()).open : null; } catch { return null; } })(), defaultAlertPhones: staffConfig(settings).alertPhones.map((p) => `0${p}`) },
      links: slugs.map((s) => lr.find((x) => x.slug === s) || { slug: s, missing: true }) });
  });

  app.put("/api/cms/wabot/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const settings = (await getSettingsData()) || {};
    const prev = settings.waBot && typeof settings.waBot === "object" ? settings.waBot : {};
    const v = configFromBody(b, prev);
    if (!v.ok) return c.json({ ok: false, error: "invalid", errors: v.errors }, 400);
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waBot}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify(v.value)]);
    if (ctx.auditNote) { try { await ctx.auditNote(c, `🤖 بوت واتساب: ${prev.mode || "off"} → ${v.value.mode || "off"}${"testPhones" in (b || {}) ? ` · أرقام التجربة ${(v.value.testPhones || []).length}` : ""}`); } catch { /* سجل النشاط اختياري */ } }
    return c.json({ ok: true, config: botConfig({ waBot: v.value }) });
  });

  app.get("/api/cms/wabot/log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const limit = Math.min(300, Math.max(1, Number(c.req.query("limit")) || 100));
    const phone = String(c.req.query("phone") || "").replace(/\D/g, "").replace(/^(966|0)/, "");
    const decision = String(c.req.query("decision") || "");
    const where = [], p = [];
    if (/^5\d{8}$/.test(phone)) { p.push(phone); where.push(`l.phone_norm=$${p.length}`); }
    if (["replied", "dry", "silent", "failed", "waiting"].includes(decision)) { p.push(decision); where.push(`l.decision=$${p.length}`); }
    if (c.req.query("handoff") === "1") where.push("l.handoff IS NOT NULL");
    p.push(limit);
    const rows = (await q(`SELECT l.id, l.at, l.phone_norm, l.mode, l.msg_type, l.text, l.intent, l.reply_key, l.lang, l.decision, l.reason, l.detail, l.replies, l.sent, l.error,
        l.handoff, l.alert, l.link_slug, l.referral, l.resume_at FROM wa_bot_log l ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY l.at DESC LIMIT $${p.length}`, p)) || [];
    return c.json({ ok: true, rows });
  });

  app.get("/api/cms/wabot/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
    const cfg = botConfig((await getSettingsData()) || {});
    const [tot] = (await q(`SELECT count(*)::int AS inbound, count(DISTINCT phone_norm)::int AS chats,
        count(*) FILTER (WHERE decision='replied')::int AS replied, count(*) FILTER (WHERE decision='dry')::int AS dry,
        count(*) FILTER (WHERE decision='silent')::int AS silent, count(*) FILTER (WHERE decision='failed')::int AS failed,
        count(*) FILTER (WHERE handoff IS NOT NULL)::int AS handoffs, count(*) FILTER (WHERE alert='sent')::int AS alerts,
        count(DISTINCT phone_norm) FILTER (WHERE referral)::int AS ad_chats
      FROM wa_bot_log WHERE at > NOW() - make_interval(days => $1::int)`, [days])) || [{}];
    const byKey = (await q(`SELECT COALESCE(reply_key,'—') AS key, decision, count(*)::int AS n FROM wa_bot_log WHERE at > NOW() - make_interval(days => $1::int) GROUP BY 1,2 ORDER BY 3 DESC`, [days])) || [];
    const byReason = (await q(`SELECT reason, count(*)::int AS n FROM wa_bot_log WHERE decision='silent' AND at > NOW() - make_interval(days => $1::int) GROUP BY 1 ORDER BY 2 DESC`, [days])) || [];
    // طلبات بعد رد البوت: نفس الجوال، طلب مدفوع من الموقع خلال ٢٤ ساعة من رد فعلي (replied)
    const [ord] = (await q(`
      WITH r AS (SELECT phone_norm, min(at) AS first_at FROM wa_bot_log WHERE decision='replied' AND at > NOW() - make_interval(days => $1::int) GROUP BY 1)
      SELECT count(*)::int AS orders, COALESCE(sum(o.total),0)::float AS revenue, count(DISTINCT o.phone_norm)::int AS customers
        FROM r JOIN shop_orders o ON o.phone_norm = r.phone_norm AND o.created_at > r.first_at AND o.created_at < r.first_at + INTERVAL '24 hours'
       WHERE NOT COALESCE(o.is_test,false) AND o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')`, [days])) || [{}];
    const slugs = [...new Set([cfg.links.organic, cfg.links.ads, ...Object.values(cfg.links.adMap)])];
    const links = (await q(`SELECT l.slug, l.clicks, (SELECT count(*)::int FROM shop_orders o WHERE o.attribution->>'fc_link' = l.slug AND NOT COALESCE(o.is_test,false)
          AND o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed') AND o.created_at > NOW() - make_interval(days => $2::int)) AS orders
        FROM cms_links l WHERE l.slug = ANY($1::text[])`, [slugs, days])) || [];
    const muted = (await q("SELECT count(*)::int AS n FROM wa_bot_chats WHERE muted_until > NOW()", [])) || [{ n: 0 }];
    // ردود الشهر (بتوقيت الرياض) والتكلفة: أول freeRepliesPerMonth ببلاش، وبعدها replyRateSar للرد (من الإعدادات)
    const mo = (await q(`SELECT count(*)::int AS n FROM wa_bot_log WHERE decision='replied' AND at >= (date_trunc('month', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')`, [])) || [{ n: 0 }];
    const monthReplies = Number(mo[0]?.n) || 0;
    const billable = Math.max(0, monthReplies - cfg.freeRepliesPerMonth);
    const waiting = (await q("SELECT count(*)::int AS n FROM wa_bot_jobs WHERE status='pending'", [])) || [{ n: 0 }];
    return c.json({ ok: true, days, mode: cfg.mode, totals: tot || {}, byKey, byReason, ordersAfterReply: ord || {}, links, mutedNow: muted[0]?.n || 0, waitingNow: waiting[0]?.n || 0,
      month: { replies: monthReplies, free: cfg.freeRepliesPerMonth, billable, rateSar: cfg.replyRateSar, costSar: Math.round(billable * cfg.replyRateSar * 100) / 100 } });
  });

  const normPh = (v) => String(v || "").replace(/\D/g, "").replace(/^(00966|966|0)/, "");
  async function chatRows() {
    await ready;
    const cfg = botConfig((await getSettingsData()) || {});
    const rows = (await q(`SELECT c.phone_norm, c.muted_until, c.muted_by, c.handoff_at, c.handoff_reason, c.last_key, c.last_key_at, c.referral_at, c.updated_at,
        (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = c.phone_norm AND m.source='echo' AND m.created_at > NOW() - INTERVAL '24 hours') AS last_echo_at,
        l.text AS last_text, l.at AS last_at, l.decision AS last_decision, l.reason AS last_reason, l.resume_at AS last_resume_at
      FROM wa_bot_chats c LEFT JOIN LATERAL (SELECT text, at, decision, reason, resume_at FROM wa_bot_log x WHERE x.phone_norm = c.phone_norm ORDER BY x.at DESC LIMIT 1) l ON TRUE
      WHERE c.muted_until > NOW() OR c.updated_at > NOW() - INTERVAL '48 hours' ORDER BY c.updated_at DESC LIMIT 200`, [])) || [];
    const now = Date.now();
    return rows.map((r) => ({ ...r, manual_muted: Boolean(r.muted_until && new Date(r.muted_until).getTime() > now),
      handoff_open: Boolean(r.handoff_at && now - new Date(r.handoff_at).getTime() < cfg.handoffOpenHours * 3600_000),
      handoff_until: r.handoff_at ? new Date(new Date(r.handoff_at).getTime() + cfg.handoffOpenHours * 3600_000).toISOString() : null }));
  }
  const whoOf = (c) => { try { return (ctx.whoami && ctx.whoami(c)) || null; } catch { return null; } };
  async function muteRoute(c) {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { /* الكل */ }
    const phone = normPh(b.phone);
    if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "bad_phone", message: "اكتب جوال سعودي 05XXXXXXXX" }, 400);
    const cfg = botConfig((await getSettingsData()) || {});
    const r = await muteChat(phone, b.hours || cfg.manualMuteHours, b.by || whoOf(c) || "dashboard");
    if (ctx.auditNote) { try { await ctx.auditNote(c, `🤖 كتم بوت واتساب في محادثة 0${phone} لمدة ${r.hours} ساعة`); } catch { /* اختياري */ } }
    return c.json({ ...r, phone: `0${phone}` });
  }
  async function unmuteRoute(c) {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { /* الكل */ }
    if (b.all === true) {
      const no = ownerOnly(c); if (no) return no;
      await q("UPDATE wa_bot_chats SET muted_until=NULL, mute_reason=NULL, muted_by=NULL, handoff_at=NULL, handoff_reason=NULL, unknown_streak=0, last_greet_at=NULL, last_disclosed_at=NULL, updated_at=NOW()", []);
      return c.json({ ok: true, all: true });
    }
    const phone = normPh(b.phone);
    if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "bad_phone" }, 400);
    return c.json(await unmuteChat(phone));
  }
  // صفحة المالك (#wa-bot)
  app.get("/api/cms/wabot/chats", async (c) => { const err = await requireAdmin(c); if (err) return err; return c.json({ ok: true, rows: await chatRows() }); });
  app.post("/api/cms/wabot/chats/mute", muteRoute);
  app.post("/api/cms/wabot/chats/unmute", unmuteRoute);
  /* نفس التلاتة للفريق (مدير/كاشير): مسارهم تحت /api/cms/ops ⇒ قسم «الطلبات» في صلاحيات الأدوار (cms.sectionOf)،
     فاللي عنده تعديل الطلبات يقدر يكتم/يرجّع البوت في محادثة من غير ما يشوف إعدادات البوت. */
  app.get("/api/cms/ops/wabot/chats", async (c) => { const err = await requireAdmin(c); if (err) return err; return c.json({ ok: true, rows: await chatRows() }); });
  app.post("/api/cms/ops/wabot/mute", muteRoute);
  app.post("/api/cms/ops/wabot/unmute", unmuteRoute);

  /* تجربة على الورق: نص ⇒ القرار والرد بالبيانات الحيّة. لا إرسال، لا سجل، لا تغيير حالة. */
  app.post("/api/cms/wabot/simulate", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const settings = (await getSettingsData()) || {};
    const cfg = { ...botConfig(settings), mode: "dry" };
    const phone = String(b.phone || "500000000").replace(/\D/g, "").replace(/^(966|0)/, "");
    const now = clock();
    const ev = { phone, text: String(b.text || ""), type: b.type || "text", interactiveId: b.interactiveId || null, referral: b.referral || null, at: now.toISOString(), intent: null };
    const cls = classify(ev);
    let data;
    try { data = await loadData({ settings, cfg, phone, orderNo: cls.entities?.orderNo || null, key: cls.key, now }); }
    catch (e) { return c.json({ ok: true, classified: cls, decision: { act: "silent", reason: `data_failed:${e.message}` } }); }
    data.chat = {};
    // المحاكاة = «لو الرد هيطلع دلوقتي»: من غير سكوت موظف، ومن غير انتظار الـ٣ دقايق، ومع سطر التعريف (أول رسالة)
    const d = decide(ev, { cfg, now, chat: {}, lastEchoAt: null, repliesLastHour: 0, lastSame: null, failedRecently: false, data, cls, afterWait: "unknown_wait" });
    return c.json({ ok: true, classified: { key: cls.key, intent: cls.rawIntent, lang: cls.lang, score: cls.score }, open: data.open ? data.open.open : null,
      decision: { act: d.act, reason: /^after_/.test(d.reason || "") ? null : d.reason, key: d.key, handoff: d.handoff || null, link: d.link || null },
      payloads: d.payloads || [], textFallback: d.fallback || [] });
  });

  /* إرسال تجربة لقالب معتمد — لأرقام قايمة التجربة **فقط** (المالك). مابيحتاجش WHATSAPP_ENABLED ولا مفتاح اللوحة.
     القيم = أمثلة القالب نفسها (اللي اتقدّمت لميتا)، فالرسالة واضح إنها تجربة: رقم الطلب/الكود فيها مش حقيقيين. */
  app.post("/api/cms/wabot/test-template", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const cfg = botConfig((await getSettingsData()) || {});
    const phone = String(b.phone || "").replace(/\D/g, "").replace(/^(966|0)/, "");
    if (!cfg.testPhones.includes(phone)) return c.json({ ok: false, error: "not_in_allow_list", message: "الرقم مش في قايمة أرقام التجربة" }, 400);
    const C = await import("./watemplates.js");
    const lang = b.language === "en" ? "en" : "ar";
    const tpl = C.findTemplate(String(b.name || ""), lang);
    if (!tpl) return c.json({ ok: false, error: "unknown_template" }, 404);
    if (tpl.meta.needsUpload && !/^https:\/\//.test(String(b.imageUrl || ""))) return c.json({ ok: false, error: "image_required" }, 400);
    const data = {};
    const set = (path, v) => { const ks = path.split("."); let o = data; ks.slice(0, -1).forEach((k) => { o = o[k] = o[k] || {}; }); o[ks.at(-1)] = v; };
    if (tpl.category === "AUTHENTICATION") set("otp.code", "4821");
    for (const v of tpl.meta.vars) set(v.path, v.example);
    for (const v of tpl.meta.buttonVars) set(v.path, v.example);
    const bound = C.bindTemplate(tpl, data);
    const params = { body: bound.body, button: bound.buttons.map((x) => x.text), missing: bound.missing, ...(tpl.meta.needsUpload ? { header: { image: String(b.imageUrl) } } : {}) };
    if (b.dryRun === true) return c.json({ ok: true, dryRun: true, to: `0${phone}`, template: tpl.name, language: lang, text: C.previewText(tpl, data), params });
    const r = await wa.sendTemplate({ phoneNorm: phone, template: tpl.name, params, lang, requireOptIn: false, source: "test", allowList: cfg.testPhones, body: C.previewText(tpl, data) });
    return c.json({ ok: r.ok === true, result: r, to: `0${phone}`, template: tpl.name, language: lang });
  });

  return { handle, ready, loadData, runDueJobs, muteChat, unmuteChat, stop: () => { if (timer) clearInterval(timer); }, botConfig: async () => botConfig((await getSettingsData()) || {}) };
}
