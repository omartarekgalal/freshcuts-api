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

import { matchIntent, detectLang, normalize, msgText, msgButtons, msgCta, msgList, LIMITS, openState, openingText, hoursLines, fmtTime, ORDER_NO_RE, indexMenu, closingToday } from "./wabot.js";
import { staffPhones, fitOneSms, staffConfig } from "./staffalerts.js";
import { loyaltyCfgOf } from "./loyalty.js";
import { MAPS_URL } from "./watemplates.js";
import { isOpenNow } from "./carts.js";
import { makeBotCarts, reorderPlan, planSummary, orderDay, chatLocation } from "./wabotcart.js";
import { makeAssistTools, validateReply, profileSummaryAr } from "./waassist.js";
import { lookupFact, groupsIn, SEVERE_RE, factsCoverage, pickDish, factNote } from "./wadishfacts.js";
import { makeAiCost, pricesOf, waRatesOf, pricesFromBody, waRatesFromBody, BUDGET_DEFAULTS } from "./waaicost.js";
import { providerInfo, maskText } from "./wabotllm.js";
import { kbTokens } from "./wakb.js";
import { ASSIST_CFG_DEFAULTS, ASSIST_SCHEMA, PROMPT_HASH, assistConfig, assistFromBody, assistEligible, makeAssistLoop, makeAssistStore, makeModelCaller, newSession, noteRulesTurn, buildContext, hintOf } from "./waassistrun.js";
import { WA_UPDATES_TEXTS, WA_UPDATES_CURRENT, recordWaUpdatesBot, recordWaMarketingBot, ensureWaConsentSchema } from "./waconsent.js";

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
  handoverRealertMin: 5,       // تحويل ومحدش من الفريق رد: تنبيه تاني بعد المدة دي (٠ = مفيش)
  handoverCustomerNoteMin: 10, // ولسه محدش رد: رسالة واحدة صادقة للعميل بعد المدة دي من التحويل (٠ = مفيش)
  manualMuteHours: 24,         // «كتم البوت في المحادثة دي» من الموظف — المدة الافتراضية
  handoffOpenHours: 24,        // التحويل لموظف «مفتوح» المدة دي: شكوى ⇒ معلومات بس، ومفيش تنبيه مكرر
  publicPhone: "",             // رقم المطعم في رسالة التعريف؛ فاضي = من سؤال «كيف أتواصل» في الأسئلة الشائعة
  faq: {},                     // { key: { ar, en } } — إجابات يوافق عليها المالك (FAQ_DEFS). الفاضي = «أحوّلك لموظف»، مش تخمين
  llm: { enabled: false, minConfidence: 0.75, timeoutMs: 2500, model: "claude-haiku-5-5", budgetMonthSar: BUDGET_DEFAULTS.budgetMonthSar, budgetDaySar: BUDGET_DEFAULTS.budgetDaySar, alertPhones: [], prices: null },   // تصنيف بس للرسالة الغير مفهومة — مايكتبش ولا كلمة للعميل
  optin: { enabled: false, askAfterHours: 720 },   // سؤال «نبلّغك بتحديثات طلباتك على واتساب؟» بعد رد حالة الطلب — مرة كل askAfterHours
  assist: { ...ASSIST_CFG_DEFAULTS },   // مساعد الطلبات (waassistrun.js): مقفول افتراضياً؛ «test» = أرقام التجربة بس. طول ما هو واقف لأي سبب، القواعد اللي بترد
  freeRepliesPerMonth: 1000,   // تسعيرة ميتا ١/١٠/٢٠٢٦: أول ١٠٠٠ رد حر في الشهر ببلاش…
  replyRateSar: 0.0401,        // …وبعدها بالريال للرد
  greetWindowHours: 24,        // تحية واحدة لكل عميل في المدة دي
  disclosureHours: 24,         // التعريف بالمساعد الآلي: مرة كل المدة دي
  footerMode: "smart",         // always | smart | first — سطر «للرجوع… أو موظف» تحت الرسايل (طلب عمر ١٢/١٠: مش على كل رسالة)
  unknownHandoverAfter: 2,     // كام رسالة مش مفهومة ورا بعض قبل التحويل
  adWindowHours: 72,           // المحادثة تفضل محسوبة على الإعلان المدة دي
  optinAnswerWindowMin: 60,    // «تمام/لا» مكتوبة تتحسب إجابة على سؤال الموافقة خلالها
  offerEndWithinDays: 7,       // تاريخ نهاية العرض يتذكر لو باقي عليه كده أو أقل
  boxesCacheMin: 5, menuCacheMin: 5, offersCacheMin: 2, staleCacheMin: 60,   // كاش المصادر الحيّة بالدقايق
  logKeepDays: 90,             // سجل البوت بيتمسح بعدها
  dishFactsEnabled: false,     // «هل الصنف فيه كذا؟» من حقايق الأصناف المعتمدة (الأصناف المغطّاة بس) — مقفول = موظف
  reorderEnabled: true,        // «نفس طلبي الأخير» بضغطة: رابط سلة جاهزة من لقطة سلة آخر طلب (طلب عمر ١٢/١٠)
  reorderMaxDays: 90,          // آخر طلب أقدم من كده مايتعرضش
  reorderLinkDays: 7,          // صلاحية رابط السلة الجاهزة
  reorderMinTotal: 10,         // طلب أصنافه أقل من كده (ر.س) مايتعرضش — طلبات التجربة الصغيرة
  reorderLookback: 5,          // لو آخر طلب مايتجهّزش، نجرّب اللي قبله لحد العدد ده
  maxAgeMinutes: 20,           // رسالة أقدم من كده (ويب هوك متأخر) مابيتردش عليها
  duplicateSeconds: 120,       // نفس الرد لنفس العميل مايتكررش خلالها
  /* حارس الحلقات (مش سبب لتحويل لموظف — عطل ١٢/١٠: ٨ ردود كانت بتقطع عميل بيتصفّح القائمة وتحوّله لموظف):
     رسايل مكتوبة ورا بعض ليها حد في الساعة، ضغطات القائمة/الأزرار ليها حد أوسع لوحدها، وحد قصير للدقيقة. عند الحد: سطر هادي مرة واحدة،
     من غير تحويل ولا تنبيه، والبوت يرجع لوحده لما المدة تعدّي. */
  maxRepliesPerHour: 40,       // ردود على رسايل **مكتوبة** لكل عميل في الساعة
  maxTapsPerHour: 150,         // ردود على ضغطات القائمة/الأزرار في الساعة (التصفّح مايتقطعش)
  maxRepliesPerMinute: 6,      // أي ردود في الدقيقة (حلقة سريعة)
  orderLookbackHours: 72,
  lateAfterMinutes: 70,        // «وين طلبي» على طلب نشط أقدم من كده ⇒ الحالة + تحويل
  interactive: true,           // أزرار/رابط بزر؛ false = نص عادي والرابط في آخره
  staffAlert: true,            // SMS للفريق عند التحويل (live؛ وفي test لو alertInTest)
  alertInTest: false,
  alertPhones: [],             // فاضي = أرقام الإنذارات (settings.delivery.alertPhones)
  maxAlertsPerHour: 6,
  firstCode: "FIRST",
  links: { organic: "wab-boxes", ads: "wa-boxes", packs: "wab-packs", adMap: {} },   // adMap: { "<ad source_id>": "<slug>" } · packs = رابط رد «باقات التجمعات»
  intentsOff: [],              // مفاتيح ردود مقفولة ⇒ تحويل لموظف بدل الرد
  texts: {},                   // { key: { ar, en } } — الفاضي = الافتراضي
});

/* روابط البوت الأساسية — بتتعمل لو مش موجودة (cms_links)، وتتعدّل بعدها من «روابط الحملات» زي أي رابط. */
export const SEED_LINKS = Object.freeze([
  { slug: "wab-boxes", label: "بوت واتساب — البوكسات (محادثات عادية)", target_type: "collection", target_id: "offers",
    coupon: "FIRST", utm_source: "whatsapp", utm_medium: "bot", utm_campaign: "wa-bot" },
  // رابط أجوبة الأصناف: الرئيسية + ‎#item-<id> (المتصفح بيحتفظ بالـ# بعد تحويل ‎/l/، والمتجر بيفتح الصنف)
  { slug: "wab-menu", label: "بوت واتساب — صنف من المنيو", target_type: "home", target_id: null,
    coupon: "FIRST", utm_source: "whatsapp", utm_medium: "bot", utm_campaign: "wa-bot" },
  // باقات التجمعات (طلب عمر ١٢/١٠: زر رد «الباقات» كان بينزّل على أول قسم العروض = البوكسات). النوع gather ⇒ ‎?go=offers&gather=1‎:
  // المتجر الحالي بينزل على قسم العروض، ولما المتجر يدعم gather=1 ينزل على عنوان «باقات التجمّعات» نفسه.
  { slug: "wab-packs", label: "بوت واتساب — باقات التجمعات", target_type: "gather", target_id: null,
    coupon: null, utm_source: "whatsapp", utm_medium: "bot", utm_campaign: "wa-bot" },
]);

/* أسئلة مالهاش إجابة في البيانات (نوع اللحم، الحلال، الحساسية…): الإجابة يكتبها ويوافق عليها المالك من اللوحة.
   **مفيش إجابة افتراضية هنا عن قصد** — الفاضي = البوت يقول «أحوّلك لموظف» ومايخمّنش. */
export const FAQ_DEFS = Object.freeze({
  meat: { q: "ايش نوع اللحم؟ (بلدي/مستورد، بقري/غنم، المصدر)", needs: "نوع ومصدر اللحم والدجاج بالظبط" },
  halal: { q: "الأكل حلال؟", needs: "صيغة الإجابة (وهل فيه شهادة تتذكر)" },
  allergens: { q: "عندي حساسية (مكسرات/جلوتين/سمسم/لاكتوز…)", needs: "هل نقدر نضمن خلو صنف من مسبّب حساسية؟ ولا نقول «مانقدرش نضمن»؟" },
  vegetarian: { q: "فيه أكل نباتي / صيامي؟", needs: "الأصناف اللي تتقال عليها نباتية فعلاً (والزيت/الشواية المشتركة)" },
  kids: { q: "عندكم شي للأطفال؟", needs: "هل فيه وجبة أطفال؟ ولا نرشّح أصناف معيّنة؟" },
  stuffed_crust: { q: "في حشو أطراف للبيتزا؟", needs: "متاح لأي بيتزا؟ وبكام؟" },
  calories: { q: "السعرات / أكل دايت؟", needs: "هل فيه بيانات سعرات نقولها؟" },
  dine_in: { q: "عندكم جلسات / صالة / قسم عوائل؟", needs: "عدد الطاولات، قسم عوائل ولا لا، الطلب من الطاولة بالـQR" },
  parking: { q: "فيه مواقف؟", needs: "وصف المواقف" },
  reservation: { q: "أقدر أحجز طاولة؟", needs: "فيه حجز ولا لا، وإزاي" },
  apps: { q: "انتم على هنقرستيشن / كيتا / نينجا؟", needs: "الصيغة المعتمدة (من غير مقارنة أسعار)" },
});
export const FAQ_KEYS = Object.keys(FAQ_DEFS);

/* ── النصوص ──────────────────────────────────────────────────────────────────
   كل نص: عربي أبيض + إنجليزي، والمتغيّرات المسموحة له. متغيّر بين [] = اختياري (لو مالوش قيمة سطره بيتشال).
   متغيّر إجباري مالوش قيمة ⇒ الرد كله مايتبعتش (DataMissing) ويتحوّل لموظف. */
const t = (label, ar, en, vars = [], opt = [], max = 900) => ({ label, ar, en, vars, opt, max });
export const TEXTS = Object.freeze({
  /* التحية قصيرة (طلب عمر ١٢/١٠: «رسالة طويلة فيها البوكسات»): ترحيب + القائمة. البوكسات والرسوم والعروض في فروعها. */
  greet: t("التحية (أول رسالة)", "حيّاك الله في فريش كاتس 👋 اختر من القائمة.\n{paused}\n{closed}", "Welcome to Fresh Cuts 👋 Pick from the menu.\n{paused}\n{closed}", [], ["paused", "closed"], 300),
  greet_back: t("تحية عميل طلب قبل كده (بالاسم)", "حيّاك الله {name} 👋 اختر من القائمة.\n{paused}\n{closed}", "Welcome back {name} 👋 Pick from the menu.\n{paused}\n{closed}", ["name"], ["paused", "closed"], 300),
  closed_short: t("سطر «مقفل الحين» القصير (في التحية)", "🌙 المطعم مقفل الحين ونفتح {opens}.", "🌙 We're closed now and open {opens}.", ["opens"], [], 200),
  menu: t("المنيو / الأسعار", "{boxes}\nوالمنيو كامل بالصور والأسعار في موقعنا 👇\n{closed}",
    "{boxes}\nThe full menu with photos and prices is on our website 👇\n{closed}", ["boxes"], ["closed"]),
  order: t("أبي أطلب", "الطلب من موقعنا يأخذ دقيقة 👇\nاختر طلبك، حدّد موقعك على الخريطة وادفع إلكترونياً، ونبلّغك بكل تحديث.\n{first}\n{paused}\n{closed}",
    "Ordering on our website takes a minute 👇\nPick your order, drop your pin on the map and pay online. We keep you updated.\n{first}\n{paused}\n{closed}", [], ["first", "paused", "closed"]),
  offers: t("العروض / أول طلب", "{first}\n{loyalty}\n{timed}\n{boxes}", "{first}\n{loyalty}\n{timed}\n{boxes}", ["boxes"], ["first", "loyalty", "timed"]),
  hours_open: t("المواعيد (مفتوح)", "⏰ مواعيدنا:\n{hours}\n🟢 مفتوحين الحين لين {closes}.", "⏰ Our hours:\n{hours}\n🟢 Open now until {closes}.", ["hours", "closes"]),
  hours_closed: t("المواعيد (مقفل)", "⏰ مواعيدنا:\n{hours}\n🌙 مقفلين الحين، ونفتح {opens}.\nجهّز سلتك من الرابط واضغط «نبّهني أول ما نفتح» ونذكّرك.",
    "⏰ Our hours:\n{hours}\n🌙 We're closed now and open {opens}.\nBuild your cart from the link and tap “Notify me when we open”.", ["hours", "opens"]),
  delivery: t("التوصيل والرسوم", "🛵 نوصّل لمسافة {km} كم من فرعنا في حي السلامة بجدة.\n{far}\nرسوم التوصيل حسب قيمة الطلب:\n{fees}\n{first}\n{paused}\nحدّد موقعك على الخريطة في صفحة الطلب وتظهر لك الرسوم قبل الدفع، أو أرسل موقعك 📍 هنا وأتأكد لك.",
    "🛵 We deliver up to {km} km from our branch in Al Salamah, Jeddah.\n{far}\nDelivery fee by order total:\n{fees}\n{first}\n{paused}\nDrop your pin on the order page to see the exact fee before you pay, or share your location 📍 here and I'll check.", ["km", "fees"], ["far", "first", "paused"]),
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
  rate: t("حد الرسائل الآلية في الساعة", "وصلنا حد الرسائل الآلية لهذه الساعة 🙏 اكتب «موظف» لو تحتاج مساعدة.", "We have reached the automated message limit for this hour 🙏 Type “staff” if you need help.", [], [], 300),
  rate_burst: t("رسائل كثيرة في دقيقة", "لحظة من فضلك 🙏 وصلتنا رسائل كثيرة متتالية، ونكمل معك بعد دقيقة.", "One moment 🙏 We received many messages in a row and will continue in a minute.", [], [], 300),
  /* «نفس طلبي الأخير» (١٢/١٠) */
  row_reorder: t("صف: نفس طلبي السابق", "🔁 نفس طلبي السابق", "🔁 Same as before", [], [], LIMITS.rowTitle),
  reorder_body: t("نفس الطلب السابق: السلة جاهزة", "جهّزنا لك نفس طلبك {day} 🛒\n{lines}\n{changes}\n{closed}\nراجع السلة وكمّل الدفع من الرابط 👇", "Your order of {day} is ready in the cart 🛒\n{lines}\n{changes}\n{closed}\nReview the cart and pay from the link 👇", ["lines"], ["day", "changes", "closed"]),
  reorder_none: t("نفس الطلب الأخير: مش متاح تلقائياً", "ما قدرنا نجهّز نفس طلبك الأخير تلقائياً 🙏 تقدر تطلب من الرابط 👇", "We couldn't rebuild your last order automatically 🙏 You can order from the link 👇", [], [], 300),
  re_gone: t("سطر: صنف مش متاح", "غير متاح الآن وشلناه من السلة: {names}", "Not available now and removed from the cart: {names}", ["names"], [], 400),
  re_sold: t("سطر: صنف خلص اليوم", "خلص اليوم وشلناه من السلة: {names}", "Sold out today and removed from the cart: {names}", ["names"], [], 400),
  re_price: t("سطر: سعر اتغيّر", "سعر {name} الآن {now} ر.س (كان {was} ر.س)", "{name} is now SAR {now} (was SAR {was})", ["name", "now", "was"], [], 300),
  re_review: t("سطر: راجع الإضافات", "راجع الإضافات والسعر في السلة قبل الدفع: {names}", "Please check the add-ons and price in the cart before paying: {names}", ["names"], [], 400),
  cta_reorder: t("زر: كمّل طلبك", "كمّل طلبك", "Complete order", [], [], LIMITS.ctaText),
  /* مساعد الطلبات: المتابعة الواحدة بعد رابط السلة (نص ثابت + نفس الرابط بزر «كمّل طلبك») */
  assist_followup: t("مساعد الطلبات: متابعة بعد رابط السلة", "سلتك ما زالت جاهزة 🛒 تقدر تكمّل طلبك من الزر 👇\nوإذا تحتاج شي ثاني اكتب لي.", "Your cart is still ready 🛒 You can complete your order from the button 👇\nIf you need anything else, just write.", [], [], 300),
  handoff_remind: t("تذكير: المحادثة عند الموظف (مرة واحدة)", "محادثتك عند الموظف 🙏\n{wait}", "Your chat is with our staff 🙏\n{wait}", [], ["wait"]),
  thanks: t("شكر / وداع", "العفو، حيّاك الله 🌟", "You're welcome 🌟"),
  /* «إيقاف» = كل رسايلنا المبادِرة (العروض وتحديثات الطلب) — حارس الإرسال بيسكّت كل القوالب. الرد على سؤاله في المحادثة شغّال. */
  stop: t("تأكيد الإيقاف (ومعاه زرارين للرجوع)", "تم إيقاف رسائلنا لك على واتساب ✅ (العروض وتحديثات الطلب)\nلو سألت عن طلبك هنا نرد عليك عادي.\nضغطت بالغلط؟ اختر من الأزرار 👇",
    "We've stopped our WhatsApp messages to you ✅ (offers and order updates)\nIf you ask about your order here we still answer.\nStopped by mistake? Use the buttons 👇", [], [], 500),
  btn_resume_all: t("زر: رجّع كل الرسائل", "كل الرسائل والعروض", "All messages", [], [], LIMITS.btnTitle),
  btn_resume_updates: t("زر: تحديثات الطلب فقط", "تحديثات طلبي فقط", "Order updates only", [], [], LIMITS.btnTitle),
  resume_all: t("رجّع كل الرسائل", "تم ✅ رجّعنا لك رسائلنا: تحديثات طلباتك والعروض.\nللإيقاف في أي وقت اكتب: إيقاف", "Done ✅ Our messages are back on: your order updates and offers.\nTo stop at any time type: stop", [], [], 300),
  resume_updates: t("رجّع تحديثات الطلب فقط", "تم ✅ رجّعنا تحديثات طلباتك فقط، والعروض موقوفة.\nللإيقاف في أي وقت اكتب: إيقاف", "Done ✅ Order updates only are back on; offers stay off.\nTo stop at any time type: stop", [], [], 300),
  start: t("رجوع الاشتراك", "تم تفعيل رسائل العروض ✅\nللإيقاف اكتب: إيقاف", "Offer messages are on ✅\nTo stop, type: stop"),
  // ── القائمة والشجرة (١٢/١٠)
  main_body: t("القائمة الرئيسية", "القائمة الرئيسية 👇 اختر اللي تبيه.", "Main menu 👇 pick what you need.", [], [], 300),
  greet_more: t("بعد التحية: القائمة", "أو اختر من القائمة 👇", "Or pick from the menu 👇", [], [], 300),
  boxes_body: t("البوكسات: الأنواع", "بوكساتنا 👇 اختر النوع وأعرض لك البوكسات بأسعارها.", "Our boxes 👇 pick a type to see the boxes and prices.", [], [], 300),
  tier_body: t("بوكسات نوع واحد", "{section} 👇 اختر البوكس لمحتواه وسعره.", "{section} 👇 pick a box for its contents and price.", ["section"], [], 300),
  box_body: t("بوكس: المحتوى والسعر", "*{name}* — {price} ر.س\n{desc}\n{online}", "*{name}* — SAR {price}\n{desc}\n{online}", ["name", "price"], ["desc", "online"]),
  online_line: t("سطر «البوكسات من الموقع بس»", "البوكسات للطلب من الموقع فقط: توصيل، استلام، أو من الطاولة عبر الموقع.", "Boxes are ordered on the website only: delivery, pickup, or from your table through the site.", [], [], 200),
  timed_head: t("عنوان العروض المحدودة بوقت", "⏳ لفترة محدودة:", "⏳ For a limited time:", [], [], 60),
  cats_body: t("المنيو: الأقسام", "أقسام المنيو 👇 اختر القسم وأعرض لك الأصناف بأسعارها.", "Menu sections 👇 pick one to see its dishes and prices.", [], [], 300),
  cat_body: t("أصناف قسم", "{cat} 👇 اختر الصنف لتفاصيله.\n{more}", "{cat} 👇 pick a dish for details.\n{more}", ["cat"], ["more"], 300),
  more_line: t("سطر «وأصناف ثانية»", "وباقي أصناف القسم في الموقع.", "The rest of this section is on the website.", [], [], 200),
  item_body: t("صنف: التفاصيل والسعر", "*{name}* — {price}\n{desc}\n{note}", "*{name}* — {price}\n{desc}\n{note}", ["name", "price"], ["desc", "note"]),
  sold_line: t("سطر «خلص اليوم»", "⚠️ خلص اليوم.", "⚠️ Sold out today.", [], [], 120),
  items_body: t("أسعار كذا صنف", "{lines}", "{lines}", ["lines"]),
  notmenu: t("صنف مش عندنا", "ما عندنا {what} في المنيو 🙏 تقدر تشوف الأقسام من هنا:", "We don't have {what} on the menu 🙏 Browse the sections here:", ["what"], [], 300),
  packs_body: t("باقات التجمعات", "باقات التجمعات 👥\n{lines}", "Gathering packs 👥\n{lines}", ["lines"]),
  packs_custom: t("التجمعات: عرض مخصص (رسالة بزر)", "وعندنا عروض مخصصة للتجمعات والمناسبات وطلبات الشركات 👇", "We also make tailored offers for gatherings, events and company orders 👇", [], [], 300),
  btn_custom: t("زر: أبغى عرض مخصص", "أبغى عرض مخصص", "Tailored offer", [], [], LIMITS.btnTitle),
  custom_offer: t("طلب عرض مخصص (تحويل لموظف)", "أبشر 🙏 عشان نجهّز لك عرض مخصص اكتب لنا هنا: عدد الأشخاص، اليوم والوقت، وتوصيل أو استلام.\nحوّلت طلبك لموظف.\n{wait}", "Sure 🙏 To prepare a tailored offer please write here: how many people, the day and time, and delivery or pickup.\nI've passed your request to a staff member.\n{wait}", [], ["wait"]),
  /* حقايق الأصناف (١٢/١٠): إجابة على قد السؤال — من غير قايمة مكونات، من غير «خالٍ من / آمن» */
  df_removable: t("الصنف فيه المسبّب، وجزؤه يتشال", "نعم، يوجد {asked} في «{dish}»، وذلك في {part}. يمكن تجهيز الطلب بدون {part}: اكتبها في ملاحظة الصنف عند الطلب.\n{kitchen}\n{fryer}",
    "Yes, {dish} has {asked} in the {part}. We can make it without the {part}: write it in the item note when you order.\n{kitchen}\n{fryer}", ["dish", "asked", "part"], ["kitchen", "fryer"], 600),
  df_removable_item: t("الصنف فيه المكوّن، ويتشال", "نعم، {part} ضمن «{dish}». يمكن تجهيز الطلب بدون {part}: اكتبها في ملاحظة الصنف عند الطلب.", "Yes, {dish} comes with {part}. We can make it without the {part}: write it in the item note when you order.", ["dish", "part"], [], 400),
  df_can_remove: t("ممكن الصنف بدون كذا؟ — أيوه", "أكيد، يمكن تجهيز «{dish}» بدون {part}. اكتبها في ملاحظة الصنف عند الطلب.", "Sure, we can make {dish} without the {part}. Write it in the item note when you order.", ["dish", "part"], [], 400),
  df_cannot_remove: t("ممكن الصنف بدون كذا؟ — لأ", "لا يمكن تجهيز «{dish}» بدون {asked}.", "We cannot make {dish} without {asked}.", ["dish", "asked"], [], 400),
  df_fixed: t("الصنف فيه المكوّن، ومايتشالش (جوّه خلطة/عجينة: من غير مكان)", "نعم، يوجد {asked} في «{dish}»، ولا يمكن تجهيز الطلب بدون {asked}.", "Yes, {dish} contains {asked}, and we cannot make it without {asked}.", ["dish", "asked"], [], 400),
  /* مسبّب في جزء ظاهر العميل عارفه (الخبز، صوص، جبن، طحينة، إضافة فوق): المكان بيتقال في كلمتين — مش سر وصفة. بيتبعت بس لو بيانات الشيف علّمت الجزء «ظاهر». */
  df_fixed_visible: t("الصنف فيه المسبّب في جزء ظاهر", "نعم، يوجد {asked} في «{dish}»، وذلك في {part}.\nللتأكد من إمكانية بديل عن {part} اكتب: موظف\n{kitchen}", "Yes, {dish} has {asked}, in the {part}.\nTo check whether another {part} is possible, type: staff\n{kitchen}", ["dish", "asked", "part"], ["kitchen"], 500),
  df_not_found: t("حسب بياناتنا الصنف مافيهوش", "حسب بياناتنا لا يوجد {asked} في «{dish}».\n{kitchen}\n{fryer}\nوإذا كانت الحساسية شديدة اكتب «موظف» قبل الطلب.", "According to our data, {dish} does not contain {asked}.\n{kitchen}\n{fryer}\nIf your allergy is severe, type “staff” before ordering.", ["dish", "asked"], ["kitchen", "fryer"], 600),
  /* مش متأكدين (قرار عمر ١٢/١٠: «نرد بكل شفافية… بلغنا في الملاحظات وهناخد بالنا»): بنقول بصراحة إن مفيش معلومة مؤكدة، نعرض الملاحظة، والموظف لو العميل عايز تأكيد — من غير تحويل تلقائي. */
  df_unknown: t("مش متأكدين: نقولها بصراحة (من غير تحويل)", "ما عندي معلومة مؤكدة عن هذا المكوّن في الصنف.\n{note}\nولو تبي تأكيد من المطبخ اكتب: موظف", "I don't have confirmed information about that ingredient in this dish.\n{note}\nIf you want the kitchen to confirm, type: staff", [], ["note"], 500),
  df_note_line: t("سطر «اكتب حساسيتك في الملاحظة»", "واكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.", "Write your allergy in the order note and we will take care.", [], [], 200),
  df_maybe_removable: t("المسبّب ممكن يكون في صوص جاهز، ويتشال", "قد يوجد {asked} في {part} المستخدم مع «{dish}». يمكن تجهيز الطلب بدون {part}: اكتبها في ملاحظة الصنف عند الطلب.\n{kitchen}",
    "{dish} may contain {asked}, in the {part}. We can make it without the {part}: write it in the item note when you order.\n{kitchen}", ["dish", "asked", "part"], ["kitchen"], 600),
  df_removable_only: t("المسبّب في الجزء اللي بيتشال بس", "نعم، يوجد {asked} في «{dish}»، وذلك في {part} فقط، و{rest} بدون {asked}. يمكن تجهيز الطلب بدون {part}: اكتبها في ملاحظة الصنف عند الطلب.\n{kitchen}",
    "Yes, {dish} has {asked}, in the {part} only; {rest} has no {asked}. We can make it without the {part}: write it in the item note when you order.\n{kitchen}", ["dish", "asked", "part", "rest"], ["kitchen"], 600),
  df_alt: t("الصنف من غير كذا = صنف تاني في المنيو", "«{dish}» فيه {asked}. بدون {asked} عندنا «{alt}».", "{dish} comes with {asked}. Without it, we have {alt}.", ["dish", "asked", "alt"], [], 400),
  df_bread: t("تغيير خبز البرجر ⇒ موظف", "تغيير خبز «{dish}» يحتاج تأكيد من موظف 🙏 حوّلت طلبك له.\n{wait}", "Changing the bread of {dish} needs a staff member 🙏 I've passed it on.\n{wait}", ["dish"], ["wait"], 400),
  df_severe: t("حساسية شديدة ⇒ موظف", "سلامتك أهم 🙏 ما دام الحساسية شديدة، حوّلت محادثتك لموظف يتأكد من المطبخ بنفسه قبل أي طلب.\n{wait}", "Your safety comes first 🙏 Since the allergy is severe, I've passed your chat to a team member who will check with the kitchen before any order.\n{wait}", [], ["wait"]),
  kitchen_line: t("سطر المطبخ الواحد", "مطبخنا واحد لكل الأصناف وقد يحصل تلامس بين المكونات أثناء التحضير.", "We have one kitchen for all dishes, so ingredients can touch during preparation.", [], [], 300),
  fryer_line: t("سطر القلاية المشتركة", "ونوضّح لك أن البطاطس تُقلى في نفس القلاية مع أصناف مقرمشة أخرى.", "Note that the fries share a fryer with other crispy items.", [], [], 300),
  /* أسرار الشغل (قرار عمر ١٢/١٠): المقادير والتتبيلة وطريقة التحضير والمورّدين مابتتقالش — رد واحد مهذب من غير تحويل */
  secret: t("سؤال عن الوصفة / المقادير / طريقة التحضير", "تفاصيل التحضير والمقادير من أسرار مطبخنا 🙂 أقدر أساعدك في المنيو والأسعار والطلب.", "How we prepare our dishes is our kitchen's secret 🙂 I can help with the menu, prices and ordering.", [], [], 300),
  pickup_body: t("الاستلام من الفرع", "🏃 {pickup}", "🏃 {pickup}", ["pickup"]),
  spicy_body: t("الأصناف الحارة (من الوصف)", "أصناف مكتوب في وصفها إنها حارة 🌶️ اختر الصنف لتفاصيله.", "Dishes described as spicy 🌶️ pick one for details.", [], [], 300),
  faq_body: t("إجابة سؤال شائع", "{answer}", "{answer}", ["answer"]),
  area_in: t("الموقع داخل النطاق", "✅ موقعك داخل نطاق التوصيل.\nرسوم التوصيل حسب قيمة الطلب:\n{fees}\n{first}", "✅ Your location is inside our delivery zone.\nDelivery fee by order total:\n{fees}\n{first}", [], ["fees", "first"], 700),
  area_far: t("الموقع في النطاق البعيد", "موقعك خارج النطاق الأساسي: نوصّل له برسوم مسافة إضافية{extra} فوق رسوم التوصيل، أو تقدر تستلم من الفرع.\nرسوم التوصيل حسب قيمة الطلب:\n{fees}",
    "Your location is outside the main zone: we deliver with an extra distance charge{extra} on top of the delivery fee, or you can pick up.\nDelivery fee by order total:\n{fees}", [], ["extra", "fees"], 700),
  area_out: t("الموقع خارج النطاق", "موقعك خارج نطاق التوصيل حالياً 🙏 تقدر تطلب استلام من الفرع.", "Your location is outside our delivery range for now 🙏 You can order for pickup.", [], [], 400),
  optin_ask: t("سؤال الموافقة على تحديثات الطلب (نفس نص المتجر — waconsent.js)", WA_UPDATES_TEXTS[WA_UPDATES_CURRENT].ar, WA_UPDATES_TEXTS[WA_UPDATES_CURRENT].en, [], [], 400),
  optin_yes: t("رد «نعم» على الموافقة", "تم ✅ نبلّغك بتحديثات طلباتك هنا. للإيقاف في أي وقت اكتب: إيقاف", "Done ✅ You'll get your order updates here. To stop at any time type: stop", [], [], 300),
  optin_no: t("رد «لا» على الموافقة", "تمام، ما نرسل لك تحديثات على واتساب.", "No problem, we won't send updates on WhatsApp.", [], [], 300),
  btn_yes: t("زر: نعم", "نعم، بلّغوني", "Yes, notify me", [], [], LIMITS.btnTitle),
  btn_no: t("زر: لا", "لا، شكراً", "No, thanks", [], [], LIMITS.btnTitle),
  list_btn: t("زر فتح القائمة", "القائمة", "Menu", [], [], LIMITS.listButton),
  row_boxes: t("صف: البوكسات", "🎁 البوكسات", "🎁 Boxes", [], [], LIMITS.rowTitle),
  row_cats: t("صف: المنيو بالأقسام", "📋 المنيو بالأقسام", "📋 Menu by section", [], [], LIMITS.rowTitle),
  row_offers: t("صف: العروض", "🔥 العروض وأول طلب", "🔥 Offers & first order", [], [], LIMITS.rowTitle),
  row_delivery: t("صف: التوصيل", "🛵 التوصيل والرسوم", "🛵 Delivery & fees", [], [], LIMITS.rowTitle),
  row_pickup: t("صف: الاستلام", "🏃 الاستلام من الفرع", "🏃 Pickup", [], [], LIMITS.rowTitle),
  row_status: t("صف: حالة الطلب", "📦 حالة طلبي", "📦 My order status", [], [], LIMITS.rowTitle),
  row_hours: t("صف: المواعيد والموقع", "⏰ المواعيد والموقع", "⏰ Hours & location", [], [], LIMITS.rowTitle),
  row_packs: t("صف: باقات التجمعات", "👥 باقات التجمعات", "👥 Gathering packs", [], [], LIMITS.rowTitle),
  row_pay: t("صف: الدفع", "💳 طرق الدفع", "💳 Payment methods", [], [], LIMITS.rowTitle),
  row_human: t("صف: موظف", "👤 كلّم موظف", "👤 Talk to staff", [], [], LIMITS.rowTitle),
  row_back: t("صف: رجوع", "↩️ القائمة الرئيسية", "↩️ Main menu", [], [], LIMITS.rowTitle),
  cta_item: t("زر: اطلب الصنف", "اطلبه الآن", "Order it", [], [], LIMITS.ctaText),
  cta_box: t("زر: اطلب البوكس", "اطلب البوكس", "Order this box", [], [], LIMITS.ctaText),
  btn_main: t("زر رد: القائمة", "📋 القائمة", "📋 Menu", [], [], LIMITS.btnTitle),
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
  when_open_assist: t("سطر «الرد قريب» والمساعد مكمل معاه", "يرد عليك موظف هنا في أقرب وقت، وأنا معك لو تحتاج شي ثاني.", "A staff member will reply here shortly, and I'm here if you need anything else.", [], [], 200),
  wait_line_assist: t("سطر «الرد لما نفتح» والمساعد مكمل معاه", "المطعم مقفل الحين. يرد عليك موظف هنا أول ما نفتح {opens}، وأنا معك لو تحتاج شي ثاني.", "We're closed now. A staff member will reply here once we open {opens}, and I'm here if you need anything else.", ["opens"], [], 300),
  handover_note: t("متابعة للعميل: الموظف اتأخر (مرة واحدة)", "نعتذر عن التأخير 🙏 نبّهنا الفريق مرة ثانية ويرد عليك موظف هنا.", "Sorry for the wait 🙏 We've alerted the team again and a staff member will reply here.", [], [], 300),
  handover_note_assist: t("متابعة للعميل: الموظف اتأخر، والمساعد معاه", "نعتذر عن التأخير 🙏 نبّهنا الفريق مرة ثانية ويرد عليك موظف هنا.\nوأنا معك لو تحتاج شي في المنيو أو الطلب.", "Sorry for the wait 🙏 We've alerted the team again and a staff member will reply here.\nMeanwhile I'm here for anything about the menu or your order.", [], [], 300),
  when_open: t("سطر «الرد قريب» (في الدوام بس)", "يرد عليك موظف هنا في أقرب وقت، والمساعد الآلي يترك المحادثة له.", "A staff member will reply here shortly, and the automated assistant leaves the chat to them.", [], [], 200),
  wait_line: t("سطر «الرد لما نفتح»", "المطعم مقفل الحين. يرد عليك موظف هنا أول ما نفتح {opens}، والمساعد الآلي يترك المحادثة له.", "We're closed now. A staff member will reply here once we open {opens}, and the automated assistant leaves the chat to them.", ["opens"], [], 200),
  paused_delivery: t("سطر «التوصيل متوقف»", "⚠️ التوصيل متوقف مؤقتاً، والاستلام من الفرع متاح.", "⚠️ Delivery is paused for now; pickup from the branch is available.", [], [], 200),
  footer: t("تذييل الرسائل بزر", "رد آلي · اكتب «القائمة» للرجوع أو «موظف»", "Automated · type “menu” to go back or “staff”", [], [], LIMITS.footer),
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
  greeting: "greet", menu: "cats", item_price: "cats", item_info: "cats", recommend: "best", servings: "boxes", kids_menu: "faq:kids",
  catering: "packs", dine_in: "faq:dine_in", parking: "faq:parking", reservation: "faq:reservation", delivery_apps: "faq:apps",
  offers: "offers", how_to_order: "order",
  delivery: "delivery", delivery_area: "delivery", delivery_fee: "delivery", min_order: "delivery", delivery_time: "delivery",
  hours: "hours", open_now: "hours", special_hours: "hours", waitlist_join: "hours",
  location: "location", payment: "payment", order_status: "status",
  complaint: "complaint", refund: "complaint",
  payment_issue: "problem", site_issue: "problem", coupon_help: "problem",
  cancel_order: "change", modify_order: "change", cancel_or_stop: "change", special_request: "change",
  human: "human", thanks: "thanks", bye: "thanks", stop: "stop", start: "start", media: "media", unknown: "unknown",
});
export const TREE_KEYS = ["main", "boxes", "tier", "box", "cats", "cat", "item", "items", "best", "notmenu", "packs", "pickup", "spicy", "faq", "area", "hoursloc", "optin_yes", "optin_no", "resume_all", "resume_updates", "reorder", "custom_offer", "secret", "dishfact"];
export const REPLY_KEYS = ["greet", "menu", "order", "offers", "delivery", "hours", "location", "payment", "status", "complaint", "problem", "change", "human", "staff", "media", "unknown", "thanks", "stop", "start"];
const HANDOFF_KEYS = { custom_offer: ["custom_offer", "normal"], complaint: ["complaint", "urgent"], problem: ["problem", "urgent"], change: ["order_change", "urgent"], human: ["asked_human", "normal"], staff: ["needs_staff", "normal"], media: ["media", "normal"] };
const BUTTON_IDS = { "bot:menu": "main", "bot:status": "status", "bot:human": "human", "optin:yes": "optin_yes", "optin:no": "optin_no", "resume:all": "resume_all", "resume:updates": "resume_updates", "re:last": "reorder", "bot:custom": "custom_offer" };
const MENU_IDS = { main: "main", boxes: "boxes", cats: "cats", offers: "offers", delivery: "delivery", pickup: "pickup", status: "status", hours: "hoursloc", location: "location", packs: "packs", pay: "payment", human: "human" };
const IGNORED_TYPES = new Set(["reaction", "sticker", "unsupported", "system", "ephemeral", "request_welcome", "order"]);
const MEDIA_TYPES = new Set(["image", "audio", "voice", "video", "document", "contacts", "location"]);
/* intents اللي مايتعدّاش عليها بحث المنيو/البوكس/الأسئلة الشائعة */
const HARD_INTENTS = new Set(["complaint", "refund", "payment_issue", "site_issue", "cancel_order", "modify_order", "cancel_or_stop", "coupon_help", "human", "stop", "start", "order_status", "special_request"]);
const NAV_RE = /^(?:القايمه|القايمه الرييسيه|الرييسيه|رجوع|ارجع|menu|main menu|main|back|0)$/;      // بعد التطبيع: ئ ⇒ ي
const ACK_RE = /^(?:تمام|تمم|اوكي|اوك|ok|okay|k|طيب|زين|ماشي|حلو|اها|اه|ايوه|ايوا|نعم|yes|yep|👍|👌|🙏)$/;
const NACK_RE = /^(?:لا|لا شكرا|لا مشكور|no|nope|no thanks|مو لازم)$/;
const TIME_RE = /(?:^| )(?:الساعه كم|كم الساعه|ساعه كم|(?:الى|لين|لحد|لغايه|حتى) (?:الساعه )?(?:كم|متى)|تقفلون الساعه كم|تفتحون الساعه كم)(?: |$)/;
const FAQ_RULES = [
  ["meat", /نوع (?:ال)?لح(?:م|وم)|(?:ال)?لح(?:م|وم)(?:كم)? (?:ايش|وش|شنو|ايه|بلدي|مستورد|من وين|منين|بقري|غنم|ضاني|عجل|طازج)|(?:بلدي|مستورد) (?:ولا|او|و?لا) (?:بلدي|مستورد)|meat (?:type|origin|kind)|kind of meat|what meat|دجاج(?:كم)? (?:بلدي|مستورد|مبرد|مجمد)/],
  ["stuffed_crust", /حشو (?:ال)?اطراف|اطراف محشيه|محشي(?:ه)? الاطراف|stuffed crust/],
  ["halal", /(?:^| )حلال(?: |$)|halal/],
  ["allergens", /حساسيه|allerg|مكسرات|(?:^| )nuts?(?: |$)|جلوتين|قلوتين|غلوتين|gluten|لاكتوز|lactose|سمسم|sesame/],
  ["vegetarian", /نباتي|vegan|vegetarian|veggie|صيامي/],
  ["calories", /سعرات|calories|كالوري|(?:^| )دايت(?: |$)|keto|كيتو/],
  ["kids", /اطفال|بزران|بزارين|(?:^| )kids?(?: |$)|children|للصغار/],
];
const SPICY_RE = /(?:^| )(?:حار|حاره|سبايسي|حراق|حراقه|spicy|hot)(?: |$)/;
const SPICY_DESC = /حار|هالابينو|ديناميت|تشيلي|spicy|jalape/i;
const BOX_RE = /بوكس|بوكسات|box/;
/* «طلب لخمسين شخص»: العدد مكتوب بالحروف برضه (عطل تحقق B12: الرقم بالحروف ماكانش بيتفهم) */
const PACK_RE = /باقه|باقات|تجمع|تجمعات|عزيمه|عزومه|catering|gathering|(عشره|عشرين|ثلاثين|تلاتين|اربعين|خمسين|ستين|سبعين|ثمانين|تمانين|تسعين|ميه|مئه|مايه) (شخص|نفر|ضيف|واحد)/;
const TIER_RES = [/فردي|فرديه|لشخص واحد|لواحد|لي انا|لوحدي|solo|single|for one/, /شخصين|لاثنين|اثنين|نفرين|two|couple/, /عائل|عايل|مشارك|للجمعه|شله|ربع|family|sharing|group/];
const BOX_STOP = new Set(["بوكس", "بوكسات", "لشخصين", "شخصين", "الفردي", "فردي", "من", "مع", "و", "وجبه", "وجبتين", "العائله", "box"]);
const ntok = (s2) => normalize(s2).split(" ").map((w) => w.replace(/^(?:وال|بال|لل|ال)(?=.{3,})/, "")).filter((w) => w.length >= 3);
/* بوكس من الاسم: كلمة مميزة من اسم البوكس موجودة في الرسالة (+ النوع لو اتقال). واحد بس ⇒ هو؛ أكتر ⇒ القائمة. */
export function findBoxes(n, bundles) {
  const words = new Set(ntok(n));
  const tier = TIER_RES.findIndex((re) => re.test(n));
  const tiers = boxTiers(bundles);
  const boxes = (Array.isArray(bundles) ? bundles : []).filter((b2) => String(b2?.section || "").trim() && Number(b2.price) > 0);
  const scored = boxes.filter((b2) => tier < 0 || !tiers[tier] || String(b2.section).trim() === tiers[tier].section).map((b2) => {
    const toks = ntok(b2.name).filter((w) => !BOX_STOP.has(w));
    const hit = toks.filter((w) => words.has(w)).length;
    return { b2, hit, full: toks.length > 0 && hit === toks.length };
  }).filter((x) => x.hit > 0);
  // الأقرب: اللي كل كلمات اسمه في الرسالة، وبعده الأكتر تطابقاً. تعادل ⇒ مايتخمّنش (القائمة).
  const top = Math.max(0, ...scored.map((x) => x.hit));
  const fulls = scored.filter((x) => x.full), best = scored.filter((x) => x.hit === top);
  const hits = (fulls.length === 1 ? fulls : best).map((x) => x.b2);
  return { tier: tier >= 0 && tiers[tier] ? tier : -1, hits };
}

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
    handoverRealertMin: num(x.handoverRealertMin, 0, 60, DEFAULTS.handoverRealertMin), handoverCustomerNoteMin: num(x.handoverCustomerNoteMin, 0, 120, DEFAULTS.handoverCustomerNoteMin),
    handoffOpenHours: num(x.handoffOpenHours, 1, 168, DEFAULTS.handoffOpenHours),
    publicPhone: /^0\d{8,9}$/.test(String(x.publicPhone || "")) ? String(x.publicPhone) : "",
    faq: x.faq && typeof x.faq === "object" ? x.faq : {},
    llm: { enabled: x.llm?.enabled === true, minConfidence: num(x.llm?.minConfidence, 0.5, 0.99, DEFAULTS.llm.minConfidence),
      timeoutMs: num(x.llm?.timeoutMs, 500, 8000, DEFAULTS.llm.timeoutMs), model: /^[a-z0-9./-]{3,60}$/.test(String(x.llm?.model || "")) ? String(x.llm.model) : DEFAULTS.llm.model,
      /* سقف مصروف الذكاء بالريال (٠ = مقفول): أول ما يتوصل له ⇒ قواعد بس + SMS واحد. */
      budgetMonthSar: num(x.llm?.budgetMonthSar, 0, 10000, DEFAULTS.llm.budgetMonthSar), budgetDaySar: num(x.llm?.budgetDaySar, 0, 1000, DEFAULTS.llm.budgetDaySar),
      alertPhones: staffPhones(x.llm?.alertPhones), prices: pricesOf(x.llm?.prices) },
    waRates: waRatesOf(x.waRates),
    optin: { enabled: x.optin?.enabled === true, askAfterHours: num(x.optin?.askAfterHours, 24, 8760, DEFAULTS.optin.askAfterHours) },
    assist: assistConfig(x.assist),
    freeRepliesPerMonth: num(x.freeRepliesPerMonth, 0, 100000, DEFAULTS.freeRepliesPerMonth),
    replyRateSar: num(x.replyRateSar, 0, 5, DEFAULTS.replyRateSar),
    greetWindowHours: num(x.greetWindowHours, 1, 168, DEFAULTS.greetWindowHours),
    disclosureHours: num(x.disclosureHours, 1, 168, DEFAULTS.disclosureHours),
    footerMode: ["always", "smart", "first"].includes(x.footerMode) ? x.footerMode : DEFAULTS.footerMode,
    unknownHandoverAfter: num(x.unknownHandoverAfter, 1, 5, DEFAULTS.unknownHandoverAfter),
    adWindowHours: num(x.adWindowHours, 1, 168, DEFAULTS.adWindowHours),
    optinAnswerWindowMin: num(x.optinAnswerWindowMin, 5, 1440, DEFAULTS.optinAnswerWindowMin),
    offerEndWithinDays: num(x.offerEndWithinDays, 0, 60, DEFAULTS.offerEndWithinDays),
    boxesCacheMin: num(x.boxesCacheMin, 1, 60, DEFAULTS.boxesCacheMin), menuCacheMin: num(x.menuCacheMin, 1, 60, DEFAULTS.menuCacheMin),
    offersCacheMin: num(x.offersCacheMin, 1, 30, DEFAULTS.offersCacheMin), staleCacheMin: num(x.staleCacheMin, 5, 720, DEFAULTS.staleCacheMin),
    logKeepDays: num(x.logKeepDays, 7, 730, DEFAULTS.logKeepDays),
    dishFactsEnabled: x.dishFactsEnabled === true,
    reorderEnabled: x.reorderEnabled !== false, reorderMaxDays: num(x.reorderMaxDays, 1, 365, DEFAULTS.reorderMaxDays), reorderLinkDays: num(x.reorderLinkDays, 1, 30, DEFAULTS.reorderLinkDays),
    reorderMinTotal: num(x.reorderMinTotal, 0, 500, DEFAULTS.reorderMinTotal), reorderLookback: num(x.reorderLookback, 1, 10, DEFAULTS.reorderLookback),
    maxAgeMinutes: num(x.maxAgeMinutes, 1, 120, DEFAULTS.maxAgeMinutes),
    duplicateSeconds: num(x.duplicateSeconds, 0, 3600, DEFAULTS.duplicateSeconds),
    maxRepliesPerHour: num(x.maxRepliesPerHour, 5, 300, DEFAULTS.maxRepliesPerHour),
    maxTapsPerHour: num(x.maxTapsPerHour, 20, 1000, DEFAULTS.maxTapsPerHour),
    maxRepliesPerMinute: num(x.maxRepliesPerMinute, 3, 30, DEFAULTS.maxRepliesPerMinute),
    orderLookbackHours: num(x.orderLookbackHours, 1, 336, DEFAULTS.orderLookbackHours),
    lateAfterMinutes: num(x.lateAfterMinutes, 20, 600, DEFAULTS.lateAfterMinutes),
    interactive: x.interactive !== false,
    staffAlert: x.staffAlert !== false,
    alertInTest: x.alertInTest === true,
    alertPhones: staffPhones(x.alertPhones),
    maxAlertsPerHour: num(x.maxAlertsPerHour, 0, 60, DEFAULTS.maxAlertsPerHour),
    firstCode: /^[A-Z0-9-]{2,20}$/.test(String(x.firstCode || "")) ? String(x.firstCode) : DEFAULTS.firstCode,
    links: { organic: slugOk(L.organic) ? L.organic : DEFAULTS.links.organic, ads: slugOk(L.ads) ? L.ads : DEFAULTS.links.ads, packs: slugOk(L.packs) ? L.packs : DEFAULTS.links.packs, adMap },
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
  if ("footerMode" in src) { if (["always", "smart", "first"].includes(src.footerMode)) out.footerMode = src.footerMode; else errors.push("footerMode"); }
  errors.push(...rangeErrors(src));
  delete out.humanWindowHours;      // اتلغى (١٢/١٠) — أي حفظ بينضّف المخزّن القديم
  for (const k of ["humanPauseMin", "staffWaitMin", "closedEchoPauseMin", "unknownWaitMin", "manualMuteHours", "handoffOpenHours", "freeRepliesPerMonth", "replyRateSar", "disclosureHours", "unknownHandoverAfter", "adWindowHours", "optinAnswerWindowMin",
    "offerEndWithinDays", "boxesCacheMin", "menuCacheMin", "offersCacheMin", "staleCacheMin", "logKeepDays", "reorderMaxDays", "reorderLinkDays", "reorderMinTotal", "reorderLookback",
    "handoverRealertMin", "handoverCustomerNoteMin", "greetWindowHours", "maxAgeMinutes", "duplicateSeconds", "maxRepliesPerHour", "maxTapsPerHour", "maxRepliesPerMinute", "orderLookbackHours", "lateAfterMinutes", "maxAlertsPerHour"]) {
    if (k in src) { if (Number.isFinite(Number(src[k])) && src[k] !== "" && src[k] !== null) out[k] = Number(src[k]); else errors.push(k); }
  }
  for (const k of ["interactive", "staffAlert", "alertInTest", "reorderEnabled", "dishFactsEnabled"]) if (k in src) out[k] = src[k] === true;
  if ("llm" in src) {
    const L = src.llm || {}, cur = { ...(prev.llm || {}) };
    if ("enabled" in L) cur.enabled = L.enabled === true;
    for (const k of ["minConfidence", "timeoutMs"]) if (k in L) { if (Number.isFinite(Number(L[k])) && L[k] !== "") cur[k] = Number(L[k]); else errors.push(`llm.${k}`); }
    if ("model" in L) { if (/^[a-z0-9./-]{3,60}$/.test(String(L.model || ""))) cur.model = String(L.model); else errors.push("llm.model"); }
    for (const [k, hi] of [["budgetMonthSar", 10000], ["budgetDaySar", 1000]]) if (k in L) { const n = Number(L[k]); if (Number.isFinite(n) && L[k] !== "" && L[k] !== null && n >= 0 && n <= hi) cur[k] = n; else errors.push(`llm.${k}`); }
    if ("alertPhones" in L) cur.alertPhones = staffPhones(Array.isArray(L.alertPhones) ? L.alertPhones : String(L.alertPhones || "").split(/[\s,،;]+/));
    if ("prices" in L) { const pr = pricesFromBody(L.prices, cur.prices); if (pr.ok) cur.prices = pr.value; else errors.push(...pr.errors); }
    out.llm = cur;
  }
  if ("waRates" in src) { const wr = waRatesFromBody(src.waRates, prev.waRates); if (wr.ok) out.waRates = wr.value; else errors.push(...wr.errors);
  }
  if ("optin" in src) {
    const O = src.optin || {}, cur = { ...(prev.optin || {}) };
    if ("enabled" in O) cur.enabled = O.enabled === true;
    if ("askAfterHours" in O) { if (Number.isFinite(Number(O.askAfterHours)) && O.askAfterHours !== "") cur.askAfterHours = Number(O.askAfterHours); else errors.push("optin.askAfterHours"); }
    out.optin = cur;
  }
  if ("assist" in src) { const av = assistFromBody(src.assist, prev.assist); if (av.ok) out.assist = av.value; else errors.push(...av.errors); }
  if ("faq" in src) {
    const cur = { ...(prev.faq || {}) };
    for (const [key, v] of Object.entries(src.faq || {})) {
      if (!FAQ_DEFS[key]) { errors.push(`faq.${key}: unknown`); continue; }
      const row = { ...(cur[key] || {}) };
      for (const lang of ["ar", "en"]) {
        if (!v || !(lang in v)) continue;
        const t = String(v[lang] ?? "").replace(/\r\n/g, "\n").trim();
        if ([...t].length > 600) { errors.push(`faq.${key}.${lang}: too_long:600`); continue; }
        if (/[{}]/.test(t)) { errors.push(`faq.${key}.${lang}: braces`); continue; }
        if (t) row[lang] = t; else delete row[lang];
      }
      if (Object.keys(row).length) cur[key] = row; else delete cur[key];
    }
    out.faq = cur;
  }
  if ("publicPhone" in src) {
    const d = String(src.publicPhone || "").replace(/[^\d]/g, "").replace(/^(00966|966)/, "0");
    if (!String(src.publicPhone || "").trim()) out.publicPhone = ""; else if (/^0\d{8,9}$/.test(d)) out.publicPhone = d; else errors.push("publicPhone: رقم غير صحيح");
  }
  if ("firstCode" in src) { if (/^[A-Z0-9-]{2,20}$/.test(String(src.firstCode || ""))) out.firstCode = String(src.firstCode); else errors.push("firstCode"); }
  if ("links" in src) {
    const L = src.links || {}, cur = { ...(prev.links || {}) };
    for (const k of ["organic", "ads", "packs"]) if (k in L) { if (slugOk(L[k])) cur[k] = String(L[k]); else errors.push(`links.${k}`); }
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
  if (out.assist && out.assist.mode === "test" && !(out.testPhones || []).length) errors.push("assist.mode=test يحتاج رقم تجربة واحد على الأقل");
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

/* ── مخطط الإعدادات (١٢/١٠): كل ثابت سلوكي في البوت = إعداد في اللوحة ─────────────────────────────
   لكل إعداد: النوع، الافتراضي، الحدود، المجموعة، اسم عربي، وسطر شرح. نفس الجدول بيتحقق من الحفظ (configFromBody)
   وبيتبعت للّوحة (/api/cms/wabot/schema) عشان أي شاشة تبني نفسها منه. اختبار بيفشل لو إعداد في DEFAULTS مالوش صف هنا. */
const S = (group, type, ar, help, extra = {}) => Object.freeze({ group, type, ar, help, ...extra });
export const SCHEMA = Object.freeze({
  mode: S("mode", "enum", "وضع البوت", "مقفول / تجربة صامتة / أرقام التجربة / شغّال للكل.", { options: ["off", "dry", "test", "live"] }),
  testPhones: S("mode", "phones", "أرقام التجربة", "الأرقام الوحيدة اللي البوت يرد عليها في وضع التجربة."),
  greetScope: S("greeting", "enum", "مين يتحيّى", "كل محادثة جديدة، أو محادثات الإعلانات بس.", { options: ["all", "ads"] }),
  greetWindowHours: S("greeting", "number", "تحية واحدة كل", "العميل مايتحيّاش تاني قبل المدة دي.", { min: 1, max: 168, unit: "ساعة" }),
  disclosureHours: S("greeting", "number", "التعريف بالمساعد الآلي كل", "أول رد في المحادثة بيقول إنه مساعد آلي وإزاي توصل لموظف؛ يتكرر بعد المدة دي.", { min: 1, max: 168, unit: "ساعة" }),
  footerMode: S("greeting", "enum", "سطر «للرجوع… أو موظف» تحت الرسايل", "كل رسالة / ذكي: الرسالة الغير مفهومة والأزرار اللي مافيهاش زر رجوع أو موظف (أول رسالة فيها التعريف فمش محتاجاه) / أول رسالة بس.", { options: ["always", "smart", "first"] }),
  publicPhone: S("greeting", "phone", "رقم المطعم في التعريف", "فاضي = الرقم المكتوب في سؤال «كيف أتواصل» في الأسئلة الشائعة."),
  humanPauseMin: S("staff", "number", "سكوت البوت بعد رد الموظف", "من آخر رسالة للموظف من موبايل المطعم، في وقت الدوام.", { min: 1, max: 720, unit: "دقيقة" }),
  staffWaitMin: S("staff", "number", "انتظار الموظف قبل ما البوت يرد", "العميل كتب وقت السكوت والموظف ماردّش: البوت يرد بعد المدة دي (أسئلة مفهومة بس).", { min: 1, max: 15, unit: "دقيقة" }),
  closedEchoPauseMin: S("staff", "number", "سكوت البوت لو الموظف رد والمطعم مقفول", "سكوت قصير بس.", { min: 0, max: 120, unit: "دقيقة" }),
  unknownWaitMin: S("staff", "number", "رسالة مش مفهومة: انتظار الموظف", "في الدوام بس. صفر = القائمة فوراً.", { min: 0, max: 15, unit: "دقيقة" }),
  handoverRealertMin: S("staff", "number", "تحويل ومحدش رد: نبّه الفريق تاني بعد", "من وقت التحويل، لو مفيش موظف كتب للعميل ولا ضغط «تم». صفر = مفيش تنبيه تاني.", { min: 0, max: 60, unit: "دقيقة" }),
  handoverCustomerNoteMin: S("staff", "number", "ولسه محدش رد: رسالة اعتذار واحدة للعميل بعد", "من وقت التحويل. مرة واحدة لكل تحويل، في وقت الدوام بس. صفر = مفيش.", { min: 0, max: 120, unit: "دقيقة" }),
  unknownHandoverAfter: S("staff", "number", "تحويل لموظف بعد كام رسالة مش مفهومة ورا بعض", "٢ = أول مرة القائمة، تاني مرة تحويل.", { min: 1, max: 5, unit: "رسالة" }),
  manualMuteHours: S("staff", "number", "مدة الكتم اليدوي", "المدة الافتراضية لزر «كتم البوت في المحادثة دي».", { min: 1, max: 168, unit: "ساعة" }),
  handoffOpenHours: S("staff", "number", "التحويل لموظف يفضل مفتوح", "طول المدة دي البوت بيرد على المواعيد والموقع وحالة الطلب بس، ومفيش تنبيه مكرر.", { min: 1, max: 168, unit: "ساعة" }),
  staffAlert: S("alerts", "boolean", "SMS للفريق عند التحويل", "في وضع «شغّال»؛ وفي التجربة لو المفتاح اللي بعده مفتوح."),
  alertInTest: S("alerts", "boolean", "ابعت التنبيه في وضع التجربة", ""),
  alertPhones: S("alerts", "phones", "أرقام تنبيه التحويل", "فاضي = أرقام الإنذارات في إعدادات التوصيل."),
  maxAlertsPerHour: S("alerts", "number", "أقصى تنبيهات في الساعة", "", { min: 1, max: 30, unit: "تنبيه" }),
  maxAgeMinutes: S("limits", "number", "عمر الرسالة الأقصى", "رسالة وصلت متأخر أكتر من كده مابيتردش عليها.", { min: 1, max: 120, unit: "دقيقة" }),
  duplicateSeconds: S("limits", "number", "عدم تكرار نفس الرد", "نفس الرد لنفس العميل مايتبعتش تاني خلال المدة دي.", { min: 0, max: 3600, unit: "ثانية" }),
  maxRepliesPerHour: S("limits", "number", "أقصى ردود على رسايل مكتوبة في الساعة", "حارس حلقات. عند الحد: سطر واحد هادي، من غير تحويل لموظف، والبوت يرجع لوحده.", { min: 5, max: 300, unit: "رد" }),
  maxTapsPerHour: S("limits", "number", "أقصى ردود على ضغطات القائمة في الساعة", "ضغطات الأزرار والقوايم بتتعدّ لوحدها عشان اللي بيتصفّح مايتقطعش.", { min: 20, max: 1000, unit: "رد" }),
  maxRepliesPerMinute: S("limits", "number", "أقصى ردود في الدقيقة", "حلقة سريعة: البوت يهدّي دقيقة.", { min: 3, max: 30, unit: "رد" }),
  interactive: S("limits", "boolean", "أزرار وقوايم", "مقفول = نص عادي والرابط في آخره."),
  intentsOff: S("limits", "keys", "ردود مقفولة", "أي رد هنا بيتحوّل لموظف بدل ما البوت يجاوب."),
  orderLookbackHours: S("orders", "number", "«وين طلبي» بيدوّر في آخر", "طلبات رقم المرسل نفسه بس.", { min: 1, max: 336, unit: "ساعة" }),
  lateAfterMinutes: S("orders", "number", "الطلب يعتبر متأخر بعد", "طلب نشط أقدم من كده: الحالة + تحويل لموظف.", { min: 20, max: 600, unit: "دقيقة" }),
  reorderEnabled: S("orders", "boolean", "«نفس طلبي الأخير» بضغطة", "للعميل اللي طلب من الموقع قبل كده: صف في التحية، وبضغطة يوصله رابط سلة جاهزة بنفس طلبه (بعد التأكد إن الأصناف متاحة)."),
  reorderMaxDays: S("orders", "number", "آخر طلب يتعرض لو عمره أقل من", "", { min: 1, max: 365, unit: "يوم" }),
  reorderLinkDays: S("orders", "number", "صلاحية رابط السلة الجاهزة", "", { min: 1, max: 30, unit: "يوم" }),
  reorderMinTotal: S("orders", "number", "أقل قيمة أصناف لطلب يتعرض", "طلبات التجربة الصغيرة بتتخطّى.", { min: 0, max: 500, unit: "ر.س" }),
  reorderLookback: S("orders", "number", "لو آخر طلب مايتجهّزش: نجرّب اللي قبله لحد", "أول طلب يتجهّز على المنيو الحالي هو اللي بيتعرض، والرد بيقول يوم الطلب.", { min: 1, max: 10, unit: "طلب" }),
  firstCode: S("orders", "code", "كود أول طلب", "الكود اللي سطر «أول طلب» بيقرا شروطه من الكوبونات."),
  "links.organic": S("links", "slug", "رابط المحادثات العادية", "من «روابط الحملات»."),
  "links.ads": S("links", "slug", "رابط محادثات الإعلانات", ""),
  "links.packs": S("links", "slug", "رابط رد «باقات التجمعات»", "الزر تحت قايمة الباقات بيفتح الرابط ده. لو الرابط مقفول أو مش موجود، الزر يرجع للرابط العادي."),
  "links.adMap": S("links", "map", "رابط لكل إعلان", "رقم الإعلان ← الرابط."),
  adWindowHours: S("links", "number", "المحادثة تفضل محسوبة على الإعلان", "بعدها ترجع للرابط العادي.", { min: 1, max: 168, unit: "ساعة" }),
  offerEndWithinDays: S("data", "number", "اذكر تاريخ نهاية العرض لو باقي عليه", "عرض بينتهي بعد أكتر من كده: مايتذكرش تاريخ.", { min: 0, max: 60, unit: "يوم" }),
  boxesCacheMin: S("data", "number", "تحديث البوكسات كل", "أقصى تأخير بين تعديل بوكس وظهوره في ردود البوت.", { min: 1, max: 60, unit: "دقيقة" }),
  menuCacheMin: S("data", "number", "تحديث المنيو كل", "", { min: 1, max: 60, unit: "دقيقة" }),
  offersCacheMin: S("data", "number", "تحديث العروض كل", "", { min: 1, max: 30, unit: "دقيقة" }),
  staleCacheMin: S("data", "number", "لو المصدر واقع: استخدم آخر نسخة لحد", "بعدها البوت يقول أقل أو يحوّل لموظف.", { min: 5, max: 720, unit: "دقيقة" }),
  logKeepDays: S("data", "number", "الاحتفاظ بسجل البوت", "الأقدم بيتمسح تلقائي.", { min: 7, max: 730, unit: "يوم" }),
  dishFactsEnabled: S("faq", "boolean", "الرد على «هل الصنف فيه كذا؟» من حقايق الأصناف", "للأصناف اللي بياناتها كاملة بس: نعم/لا للمكوّن المسؤول عنه، وهل يتشال، وسطر المطبخ الواحد. أي صنف تاني أو حساسية شديدة: موظف. مقفول = كل الأسئلة دي لموظف."),
  faq: S("faq", "faq", "إجابات الأسئلة الشائعة", "الفاضي = البوت يحوّل السؤال لموظف."),
  texts: S("texts", "texts", "نصوص الردود", "الفاضي = النص الافتراضي."),
  "optin.enabled": S("optin", "boolean", "سؤال تحديثات الطلب على واتساب", "بعد رد «وين طلبي»: سؤال واحد بزرارين."),
  "optin.askAfterHours": S("optin", "number", "لو ماجاوبش: مايتسألش تاني قبل", "اللي جاوب نعم أو لا مايتسألش تاني أبداً.", { min: 24, max: 8760, unit: "ساعة" }),
  optinAnswerWindowMin: S("optin", "number", "«تمام/لا» مكتوبة تتحسب إجابة خلال", "بعد السؤال بالمدة دي؛ بعدها تبقى كلام عادي.", { min: 5, max: 1440, unit: "دقيقة" }),
  "llm.enabled": S("ai", "boolean", "الفهم بالذكاء الاصطناعي", "للرسالة اللي القواعد مافهمتهاش بس. الرد يفضل نصّنا."),
  "llm.model": S("ai", "model", "الموديل", ""),
  "llm.minConfidence": S("ai", "number", "أقل درجة ثقة تتقبل", "أقل منها: الرسالة تتعامل كغير مفهومة.", { min: 0.5, max: 0.99, step: 0.01 }),
  "llm.timeoutMs": S("ai", "number", "مهلة الموديل", "بعدها البوت يكمل بالقواعد.", { min: 500, max: 8000, unit: "مللي ثانية" }),
  "llm.budgetDaySar": S("ai", "number", "السقف اليومي", "صفر = الموديل مقفول.", { min: 0, max: 1000, unit: "ر.س" }),
  "llm.budgetMonthSar": S("ai", "number", "ميزانية الشهر", "", { min: 0, max: 10000, unit: "ر.س" }),
  "llm.alertPhones": S("ai", "phones", "أرقام تنبيه السقف", "فاضي = أرقام تنبيه التحويل."),
  "llm.prices": S("ai", "prices", "جدول أسعار الموديلات", "بالدولار لكل مليون توكن + سعر الصرف + تاريخ الجدول."),
  freeRepliesPerMonth: S("cost", "number", "ردود واتساب المجانية في الشهر", "", { min: 0, max: 100000, unit: "رد" }),
  replyRateSar: S("cost", "number", "سعر الرد بعد المجاني", "", { min: 0, max: 5, unit: "ر.س", step: 0.0001 }),
  waRates: S("cost", "rates", "بطاقة أسعار قوالب واتساب", "تسويقي / خدمي / رمز تحقق + تاريخ البطاقة."),
  ...ASSIST_SCHEMA,
});
export const SCHEMA_GROUPS = Object.freeze({ mode: "الوضع", greeting: "التحية والتعريف", staff: "البوت والموظف", alerts: "التنبيهات", limits: "الحدود", orders: "الطلبات", links: "الروابط", data: "البيانات الحيّة",
  faq: "الأسئلة الشائعة", texts: "النصوص", optin: "موافقة التحديثات", ai: "الذكاء الاصطناعي", cost: "التكلفة", assist: "مساعد الطلبات" });
const getPath = (o, p) => p.split(".").reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), o);
/* للّوحة: كل إعداد بقيمته الحالية والافتراضية وحدوده وشرحه. */
export function schemaFor(cfg) {
  const def = botConfig({});
  return Object.entries(SCHEMA).map(([key, s]) => ({ key, ...s, groupAr: SCHEMA_GROUPS[s.group] || s.group, default: getPath(def, key), value: cfg ? getPath(cfg, key) : undefined }));
}
/* رقم بره حدود المخطط ⇒ خطأ حفظ (مش تصحيح صامت). */
function rangeErrors(src) {
  const errors = [];
  for (const [key, s] of Object.entries(SCHEMA)) {
    if (s.type !== "number") continue;
    const v = getPath(src, key);
    if (v === undefined) continue;
    const n = Number(v);
    if (v === "" || v === null || !Number.isFinite(n) || n < s.min || n > s.max) errors.push(key);
  }
  return errors;
}
/* الفرق بين إعدادين (مسارات مسطّحة) ⇒ [{ path, from, to }] — لسجل «مين غيّر إيه». */
export function configDiff(a, b) {
  const flat = (o, pre = "", out = {}) => { for (const [k, v] of Object.entries(o || {})) { const p = pre ? `${pre}.${k}` : k; if (v && typeof v === "object" && !Array.isArray(v)) flat(v, p, out); else out[p] = v; } return out; };
  const A = flat(a), B = flat(b), out = [];
  for (const p of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) if (JSON.stringify(A[p]) !== JSON.stringify(B[p])) out.push({ path: p, from: A[p] ?? null, to: B[p] ?? null });
  return out;
}

/* أسئلة العملاء المتكررة اللي البوت مافهمهاش أو حوّلها لموظف — مجمّعة بالتشابه (كلمات مشتركة بعد التنضيف)، بعدد وأمثلة.
   rows: [{ text, key, handoff, phone }] (النص زي ما في السجل). قواعد بس: من غير موديل ومن غير تكلفة. */
const MINE_STOP = new Set("في من على عن الى إلى ما هل لو يا و او أو انا انت انتم عندكم عندك فيه فيها هذا هذي ذا ده دي اللي الي كم كيف وش ايش إيش شنو ليش متى وين فين ابي ابغى ابغا اريد عايز ممكن لو سمحت سمحتوا الله يعطيكم العافيه العافية السلام عليكم مرحبا هلا شكرا the a is do you have i to and of for".split(" "));
/* جذر تقريبي للتجميع بس (مش للعرض): شيل السوابق واللواحق الشائعة وحروف المد — «توصلون/توصيل» و«لمكة/مكة» يتقابلوا. */
export function mineStem(w) {
  let x = String(w || "");
  const p = /^(وال|بال|لل|ال|و|ب|ل|ف)(?=.{3,})/.exec(x); if (p) x = x.slice(p[0].length);
  const q = /(ون|ين|ات|كم|ها)$/.exec(x); if (q && x.length - q[0].length >= 3) x = x.slice(0, -q[0].length);
  const y = x.replace(/[اويى]/g, "");
  return y.length >= 2 ? y : x;
}
export function mineQuestions(rows, { minCount = 2, max = 30, similarity = 0.6 } = {}) {
  const words = (t) => [...new Set(normalize(String(t || "")).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !MINE_STOP.has(w) && !MINE_STOP.has(w.replace(/^(ال|لل)/, "")) && !/^\d+$/.test(w)))];
  const groups = [];
  for (const r of rows || []) {
    const ws = words(r.text), st = [...new Set(ws.map(mineStem))];
    if (!st.length) continue;
    let best = null, bs = 0;
    for (const g of groups) {
      const inter = st.filter((x) => g.set.has(x)).length, small = Math.min(st.length, g.set.size), big = Math.max(st.length, g.set.size);
      const sim = small ? inter / small : 0;
      if (sim >= similarity && (inter >= 2 || (small === 1 && big <= 2)) && sim > bs) { bs = sim; best = g; }
    }
    if (best) { best.count++; best.phones.add(r.phone || ""); if (r.handoff) best.handoffs++; if (best.examples.length < 4 && !best.examples.includes(r.text)) best.examples.push(r.text);
      for (const w of ws) { const k = mineStem(w); best.freq[k] = (best.freq[k] || 0) + 1; best.show[k] ||= w; } }
    else groups.push({ set: new Set(st), freq: Object.fromEntries(st.map((x) => [x, 1])), show: Object.fromEntries(ws.map((w) => [mineStem(w), w])), count: 1, handoffs: r.handoff ? 1 : 0, phones: new Set([r.phone || ""]), examples: [r.text], key: r.key || null });
  }
  return groups.filter((g) => g.count >= minCount).sort((a, b) => b.count - a.count).slice(0, max)
    .map((g) => ({ count: g.count, customers: g.phones.size, handoffs: g.handoffs, lastKey: g.key, words: Object.entries(g.freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => g.show[x[0]] || x[0]), examples: g.examples }));
}

/* اسم العميل للتحية: أول كلمة من الاسم اللي كتبه في طلب سابق — حروف بس، ٢ إلى ١٥ حرف. أي حاجة تانية ⇒ من غير اسم. */
export function greetName(raw) {
  const first = String(raw || "").trim().split(/\s+/)[0] || "";
  return /^[\p{L}]{2,15}$/u.test(first) && !/^(test|تجربة|عميل|customer|guest|زائر)$/i.test(first) ? first : "";
}
/* إحداثيات من نص لصقه العميل (رابط خرايط جوجل أو «lat,lng»). رابط مختصر (maps.app.goo.gl) مافيهوش إحداثيات ⇒ null (بيتحلّ في الـruntime). */
export function coordsFromText(text) {
  const t = String(text || "");
  const ok = (a, b) => { const lat = Number(a), lng = Number(b); return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? { lat, lng } : null; };
  let m = /[?&](?:q|query|ll|destination|daddr)=(?:loc:)?(-?\d{1,2}\.\d{3,})(?:,|%2C)\s*(-?\d{1,3}\.\d{3,})/i.exec(t); if (m) return ok(m[1], m[2]);
  m = /!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/.exec(t); if (m) return ok(m[1], m[2]);
  m = /@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/.exec(t); if (m) return ok(m[1], m[2]);
  if (/google\.[a-z.]+\/maps|maps\.google\./i.test(t)) { m = /(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/.exec(t); if (m) return ok(m[1], m[2]); }
  m = /^\s*(-?\d{1,2}\.\d{4,})\s*[,،]\s*(-?\d{1,3}\.\d{4,})\s*$/.exec(t); if (m) return ok(m[1], m[2]);
  return null;
}
export const shortMapsLink = (text) => (/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\/[A-Za-z0-9_\-\/?=&%.]+/i.exec(String(text || "")) || [null])[0];

/* ── بناء الرد (مجرّد): { body, footer?, cta?:{title,url}, buttons?:[{id,title}] } ───────── */
const linkUrl = (slug) => `${STORE}/l/${slug}`;
export function pickLink(cfg, data, referral) {
  const ref = referral || data.chat?.referral || null;
  const fresh = referral || (data.chat?.referral_at && data.now.getTime() - Date.parse(data.chat.referral_at) < cfg.adWindowHours * 3600_000);
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
  /* مع مساعد الطلبات شغّال للعميل ده (data.assistOn) والتحويل مش شكوى/مشكلة/تعديل: المساعد مابيسيبش المحادثة — «وأنا معك لو تحتاج شي ثاني». */
  const softWait = Boolean(data.assistOn) && !["complaint", "problem", "change"].includes(key) && !(key === "dishfact" && c.arg && c.arg.id == null);
  const wait = () => (data.open && data.open.open === true ? T(softWait ? "when_open_assist" : "when_open") : closedLine(cfg, lang, data, softWait ? "wait_line_assist" : "wait_line"));
  const order = data.order || null;
  const withLink = (k, vars, ctaKey) => { const slug = pickLink(cfg, data, c.referral); return { body: F(k, vars), cta: { title: T(ctaKey), url: linkUrl(slug) }, link: slug }; };
  switch (key) {
    case "main": {
      const tiers = boxTiers(data.bundles);
      const boxDesc = tiers.length ? tiers.map((x) => (lang === "en" ? `${x.section_en} from ${money(x.min)}` : `${x.section.replace(/^بوكسات /, "")} من ${money(x.min)}`)).join(" · ") : "";
      const rows = [["m:boxes", "row_boxes", boxDesc], ["m:cats", "row_cats"], ["m:offers", "row_offers"], ["m:delivery", "row_delivery"], ["m:pickup", "row_pickup"], ["m:status", "row_status"],
        ["m:hours", "row_hours"], ["m:packs", "row_packs"], ["m:pay", "row_pay"], ["m:human", "row_human"]].map(([id, k, d]) => ({ id, title: T(k), ...(d ? { description: d } : {}) }));
      return { body: T("main_body"), list: { button: T("list_btn"), rows } };
    }
    case "boxes": {
      const tiers = boxTiers(data.bundles);
      if (!tiers.length) throw new DataMissing("bundles");
      const rows = tiers.map((x, i) => ({ id: `tier:${i}`, title: lang === "en" ? x.section_en : x.section, description: lang === "en" ? `${x.n} boxes · from SAR ${money(x.min)}` : `${x.n} بوكسات · من ${money(x.min)} ر.س` }));
      return { body: T("boxes_body"), list: { button: T("list_btn"), rows: [...rows, { id: "m:main", title: T("row_back") }, { id: "m:human", title: T("row_human") }] } };
    }
    case "tier": {
      const tiers = boxTiers(data.bundles), tr = tiers[Number(c.arg)];
      if (!tr) throw new DataMissing("tier");
      const boxes = data.bundles.filter((b2) => String(b2.section || "").trim() === tr.section && Number(b2.price) > 0).sort((a, b2) => Number(a.price) - Number(b2.price)).slice(0, 8);
      const rows = boxes.map((b2) => ({ id: `box:${b2.slug}`, title: String((lang === "en" && b2.name_en) || b2.name).replace(/^بوكس /, ""), description: lang === "en" ? `SAR ${money(b2.price)}` : `${money(b2.price)} ر.س` }));
      return { body: F("tier_body", { section: lang === "en" ? tr.section_en : tr.section }), list: { button: T("list_btn"), rows: [...rows, { id: "m:boxes", title: T("row_boxes") }, { id: "m:human", title: T("row_human") }] } };
    }
    case "box": {
      const b2 = (data.bundles || []).find((x) => x.slug === String(c.arg) && String(x.section || "").trim() && Number(x.price) > 0);
      if (!b2) throw new DataMissing("box");
      const slug = data.links && data.links[b2.slug] === true ? b2.slug : pickLink(cfg, data, c.referral);
      return { body: F("box_body", { name: (lang === "en" && b2.name_en) || b2.name, price: money(b2.price), desc: String((lang === "en" && b2.description_en) || b2.description || "").trim(), online: T("online_line") }),
        cta: { title: T("cta_box"), url: linkUrl(slug) }, link: slug };
    }
    case "cats": case "best": {
      const menu = data.menu;
      if (!menu || !menu.categories || !menu.categories.length) throw new DataMissing("menu");
      if (key === "best") { const bs = menu.categories.find((x) => x.title === "Best Sellers"); if (bs) return buildReply("cat", { ...c, arg: bs.id }); }
      const ordered = [...menu.categories].sort((a, b2) => (b2.title === "Best Sellers") - (a.title === "Best Sellers"));
      const rows = ordered.slice(0, 10).map((x) => {
        const real = x.items.filter((i) => !/إضافة|اضافه/.test(i.name));
        const min = Math.min(...(real.length ? real : x.items).map((i) => i.price));
        const cnt = x.items.length;
        return { id: `cat:${x.id}`, title: lang === "en" ? x.title : x.titleAr,
          description: lang === "en" ? `${cnt} items · from SAR ${money(min)}` : `${cnt} ${cnt >= 3 && cnt <= 10 ? "أصناف" : "صنف"} · من ${money(min)} ر.س` };
      });
      return { body: T("cats_body"), list: { button: T("list_btn"), rows } };
    }
    case "cat": case "spicy": {
      const menu = data.menu;
      if (!menu || !menu.items || !menu.items.length) throw new DataMissing("menu");
      const cat = key === "cat" ? menu.categories.find((x) => x.id === String(c.arg)) : null;
      const all = key === "cat" ? (cat ? cat.items : []) : menu.items.filter((i) => SPICY_DESC.test(`${i.name} ${i.desc}`));
      if (!all.length) throw new DataMissing(key === "cat" ? "category" : "spicy");
      const rows = all.slice(0, 9).map((i) => ({ id: `item:${i.id}`, title: lang === "en" ? (i.nameEn || i.name) : i.name,
        description: `${priceText(lang, i)}${i.soldOut ? (lang === "en" ? " · sold out today" : " · خلص اليوم") : ""}${i.desc && lang !== "en" && !isMashakel(i) ? ` · ${i.desc}` : ""}` }));
      const body = key === "spicy" ? T("spicy_body") : F("cat_body", { cat: lang === "en" ? cat.title : cat.titleAr, more: all.length > 9 ? T("more_line") : "" });
      return { body, list: { button: T("list_btn"), rows: [...rows, { id: "m:cats", title: T("row_cats") }] } };
    }
    case "item": {
      const it = data.menu && data.menu.items ? data.menu.items.find((i) => i.id === String(c.arg)) : null;
      if (!it) throw new DataMissing("item");
      const slug = data.links && data.links["wab-menu"] === true ? "wab-menu" : pickLink(cfg, data, c.referral);
      return { body: F("item_body", { name: lang === "en" ? (it.nameEn || it.name) : it.name, price: priceText(lang, it), desc: lang === "en" || isMashakel(it) ? "" : it.desc, note: it.soldOut ? T("sold_line") : "" }),
        cta: { title: T("cta_item"), url: `${linkUrl(slug)}#item-${it.id}` }, link: slug };
    }
    case "items": {
      const its = (Array.isArray(c.arg) ? c.arg : []).map((id) => data.menu && data.menu.items ? data.menu.items.find((i) => i.id === String(id)) : null).filter(Boolean);
      if (!its.length) throw new DataMissing("items");
      const rows = its.slice(0, 9).map((i) => ({ id: `item:${i.id}`, title: lang === "en" ? (i.nameEn || i.name) : i.name, description: priceText(lang, i) }));
      return { body: F("items_body", { lines: its.map((i) => `• ${lang === "en" ? (i.nameEn || i.name) : i.name}: ${priceText(lang, i)}`).join("\n") }), list: { button: T("list_btn"), rows: [...rows, { id: "m:cats", title: T("row_cats") }] } };
    }
    case "notmenu": return { body: F("notmenu", { what: String(c.arg || "") }), buttons: [{ id: "m:cats", title: T("btn_main") }, { id: "m:boxes", title: T("row_boxes") }, { id: "bot:human", title: T("btn_human") }] };
    case "packs": {
      /* الباقة المربوطة بعرض: بتتذكر بس لو العرض شغّال **الحين** في سجل العروض (مش منتهي ولا لسه مابدأش)، ومعاها آخر يوم لو قرّب.
         سجل العروض مش متاح ⇒ الباقات اللي المتجر عارضها من غير تاريخ (نقول أقل، مانخمّنش). */
      const act = Array.isArray(data.offers) ? new Map(data.offers.map((o) => [String(o.id), o])) : null;
      const packs = (data.bundles || []).filter((b2) => !String(b2.section || "").trim() && Number(b2.price) > 0)
        .filter((b2) => !b2.offer_id || !act || act.has(String(b2.offer_id))).sort((a, b2) => Number(a.price) - Number(b2.price));
      if (!packs.length) throw new DataMissing("packs");
      /* زر الباقات بيفتح رابط الباقات (links.packs) لو شغّال؛ غير كده الرابط العادي زي الأول. */
      const packsCta = data.links && data.links[cfg.links.packs] === true ? { cta: { title: T("cta_order"), url: linkUrl(cfg.links.packs) }, link: cfg.links.packs } : {};
      return { ...withLink("packs_body", { lines: packs.map((b2) => `• ${(lang === "en" && b2.name_en) || b2.name}: ${lang === "en" ? `SAR ${money(b2.price)}` : `${money(b2.price)} ر.س`}${
        b2.offer_id && act ? endsSoon(act.get(String(b2.offer_id))?.until, data.now, lang, cfg.offerEndWithinDays) : ""}`).join("\n") }, "cta_order"),
        /* رسالة تانية: عروض مخصصة للتجمعات + زر بيحوّل لموظف بعد ما يطلب التفاصيل (عدد الأشخاص، الوقت، توصيل/استلام) */
        ...packsCta, ...(c.factual ? {} : { extra: [{ body: T("packs_custom"), buttons: [{ id: "bot:custom", title: T("btn_custom") }, { id: "bot:menu", title: T("btn_main") }] }] }) };
    }
    case "pickup": {
      const f = (data.settings?.storefront?.seo?.faq || []).find((x) => /الاستلام|استلام/.test(String(x?.q || "")));
      const ans = f && (lang === "en" ? (f.a_en || "") : (f.a || ""));
      return withLink("pickup_body", { pickup: String(ans || "").trim() }, "cta_order");
    }
    case "faq": {
      const row = cfg.faq?.[String(c.arg)] || {};
      const ans = String((lang === "en" ? row.en || row.ar : row.ar) || "").trim();      // مفيش ترجمة ⇒ العربي المعتمد
      if (!ans) throw new FaqMissing(String(c.arg));
      return { body: F("faq_body", { answer: ans }) };
    }
    case "area": {
      const qv = data.quote;
      if (!qv || typeof qv.deliverable !== "boolean") throw new DataMissing("quote");
      /* جوّه النطاق: سلّم الرسوم الحقيقي (البوت مامعاهوش سلة، فالرسم بيتحدد بقيمة الطلب). النطاق البعيد: قيمة الرسم الإضافي لموقعه لو النظام رجّعها. */
      const fees = data.policy ? feeLines(data.policy, lang) : "";
      if (qv.deliverable) return withLink("area_in", { fees, first: fees ? firstLine(cfg, lang, data) : "" }, "cta_order");
      if (qv.farZoneOffer) { const x = Number(qv.farZoneOffer.surcharge); return withLink("area_far", { fees, extra: Number.isFinite(x) && x > 0 ? (lang === "en" ? ` of SAR ${money(x)}` : ` ${money(x)} ر.س`) : "" }, "cta_order"); }
      if (qv.reason === "out_of_range" || qv.reason === "out_of_zone") return withLink("area_out", {}, "cta_order");
      throw new DataMissing(`quote:${qv.reason}`);
    }
    case "hoursloc": { const h = buildReply("hours", c); return { ...h, extra: [buildReply("location", c)] }; }
    case "optin_yes": case "optin_no": return { body: T(key) };
    case "greet": {
      const rows = [["m:boxes", "row_boxes"], ["m:cats", "row_cats"], ["m:offers", "row_offers"], ["m:delivery", "row_delivery"], ["m:status", "row_status"], ["m:human", "row_human"]].map(([id, k]) => ({ id, title: T(k) }));
      const vars = { paused: pausedLine(cfg, lang, data), closed: closedLine(cfg, lang, data, "closed_short") };
      const name = greetName(data.customerName);
      if (cfg.reorderEnabled && data.reorder && data.reorder.plan && data.reorder.plan.ok) rows.unshift({ id: "re:last", title: T("row_reorder"), description: `${orderDay(data.reorder.at, "en").split(" ").pop()}: ${planSummary(data.reorder.plan, lang, LIMITS.rowDesc - 7)}` });
      return { body: name ? F("greet_back", { ...vars, name }) : F("greet", vars), list: { button: T("list_btn"), rows } };
    }
    case "resume_all": case "resume_updates": return { body: T(key) };
    case "reorder": {
      const ro = cfg.reorderEnabled ? data.reorder : null;
      if (!ro || !ro.plan || !ro.plan.ok || !ro.url) return withLink("reorder_none", {}, "cta_order");
      const p = ro.plan, nm = (x) => (lang === "en" ? x.nameEn || x.name : x.name), sep = lang === "en" ? ", " : "، ";
      const lines = p.lines.map((l) => `• ${l.q > 1 ? `${l.q}× ` : ""}${nm(l)}`).join("\n");
      const gone = p.removed.filter((x) => x.why !== "sold_out").map((x) => x.name), sold = p.removed.filter((x) => x.why === "sold_out").map((x) => x.name);
      const changes = [gone.length ? F("re_gone", { names: gone.join(sep) }) : "", sold.length ? F("re_sold", { names: sold.join(sep) }) : "",
        ...p.repriced.map((x) => F("re_price", { name: x.name, now: money(x.now), was: money(x.was) })), p.review.length ? F("re_review", { names: p.review.join(sep) }) : ""].filter(Boolean).join("\n");
      return { body: F("reorder_body", { day: orderDay(ro.at, lang), lines, changes, closed: closedLine(cfg, lang, data, "closed_short") }), cta: { title: T("cta_reorder"), url: ro.url }, link: "wa-reorder" };
    }
    case "menu": return withLink("menu", { boxes: boxesBlock(cfg, lang, data), closed: closedLine(cfg, lang, data) }, "cta_menu");
    case "order": return withLink("order", { first: firstLine(cfg, lang, data), paused: pausedLine(cfg, lang, data), closed: closedLine(cfg, lang, data) }, "cta_order");
    case "offers": return withLink("offers", { first: firstLine(cfg, lang, data), loyalty: loyaltyLine(cfg, lang, data), timed: timedBlock(cfg, lang, data), boxes: boxesBlock(cfg, lang, data) }, "cta_order");
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
    case "dishfact": {
      /* إجابة السؤال الواحد من حقايق الأصناف. مقفول من اللوحة، أو الحالة مش مؤكدة ⇒ موظف. حساسية شديدة ⇒ موظف (عاجل) من غير أي كلام عن صنف. */
      const a = c.arg && typeof c.arg === "object" ? c.arg : {};
      const f = lookupFact(a.id, a.text, { remove: a.remove === true });
      if (f.status === "severe") return { body: F("df_severe", { wait: wait() }), handoff: ["allergy_severe", "urgent"], fact: "severe" };
      if (!cfg.dishFactsEnabled) return { ...buildReply("staff", c), handoff: HANDOFF_KEYS.staff, fact: "off" };
      const nm = lang === "en" ? f.dishEn : f.dish, part = lang === "en" ? f.partEn : f.part;
      const kitchen = f.kind === "allergen" ? T("kitchen_line") : "", fryer = f.fryer ? T("fryer_line") : "";
      /* سؤال حساسية ⇒ بعد الإجابة سطر «اكتب حساسيتك في ملاحظة الطلب وننتبه لها» (قرار عمر ١٢/١٠). سؤال مكوّن عادي من غيره. */
      const withNote = (body) => (f.kind === "allergen" ? `${body}\n${T("df_note_line")}` : body);
      const rest = lang === "en" ? f.restEn : f.rest;
      if (f.status === "present_removable" && f.kind === "allergen" && f.may) return { body: withNote(F("df_maybe_removable", { dish: nm, asked: f.asked, part, kitchen })), fact: "present_maybe_removable" };
      if (f.status === "present_removable" && f.kind === "allergen" && rest) return { body: withNote(F("df_removable_only", { dish: nm, asked: f.asked, part, rest, kitchen })), fact: "present_removable_only" };
      if (f.status === "present_removable") return { body: f.kind === "allergen" ? withNote(F("df_removable", { dish: nm, asked: f.asked, part, kitchen, fryer })) : F("df_removable_item", { dish: nm, part }), fact: f.status };
      if (f.status === "present_fixed" && part) return { body: withNote(F("df_fixed_visible", { dish: nm, asked: f.asked, part, kitchen: f.kind === "allergen" ? T("kitchen_line") : "" })), fact: "present_fixed_visible" };
      if (f.status === "present_fixed") return { body: withNote(F("df_fixed", { dish: nm, asked: f.asked })), fact: f.status };
      if (f.status === "can_remove") return { body: F("df_can_remove", { dish: nm, part }), fact: f.status };
      if (f.status === "cannot_remove") return { body: F("df_cannot_remove", { dish: nm, asked: f.asked }), fact: f.status };
      if (f.status === "alternative") return { body: F("df_alt", { dish: nm, asked: f.asked, alt: lang === "en" ? f.altEn : f.alt }), fact: f.status };
      if (f.status === "not_found") return { body: withNote(F("df_not_found", { dish: nm, asked: f.asked, kitchen, fryer })), fact: f.status };
      /* خبز تاني للبرجر: الحالة الوحيدة هنا اللي لسه بتتحوّل لموظف (غير الحساسية الشديدة) */
      if (f.why === "other_bread") return { body: F("df_bread", { dish: nm, wait: wait() }), handoff: HANDOFF_KEYS.staff, fact: "unknown:other_bread" };
      return { body: F("df_unknown", { note: T("df_note_line") }), fact: `unknown:${f.why || ""}` };
    }
    case "secret": return { body: T("secret"), buttons: [{ id: "bot:menu", title: T("btn_main") }, { id: "bot:human", title: T("btn_human") }] };
    case "problem": case "change": case "human": case "staff": case "media": case "data_missing": case "handoff_remind": case "custom_offer":
      return { body: F(key, { wait: wait() }) };
    case "rate": case "rate_burst": return { body: T(key) };
    case "unknown": return { body: T("unknown"), buttons: [{ id: "bot:menu", title: T("btn_main") }, { id: "bot:status", title: T("btn_status") }, { id: "bot:human", title: T("btn_human") }] };
    case "stop": return { body: T("stop"), buttons: [{ id: "resume:updates", title: T("btn_resume_updates") }, { id: "resume:all", title: T("btn_resume_all") }] };
    case "thanks": case "start": return { body: T(key) };
    default: throw new DataMissing(`key:${key}`);
  }
}
/* حقيقة صنف لمساعد الطلبات: **نفس النص المعتمد** اللي بوت القواعد بيرد بيه (df_*)، والمساعد بيبعته زي ما هو — مفيش صياغة من الموديل في سؤال حساسية.
   ⇒ { status, say } أو { status, handover: "allergy_severe" | "needs_staff" } (حساسية شديدة، مقفول من اللوحة، أو مش مؤكد). */
export function dishFactSay(cfg, data, { id, question, remove = false, lang = "ar" } = {}) {
  try {
    const r = buildReply("dishfact", { cfg, lang: lang === "en" ? "en" : "ar", data: data || {}, referral: null, factual: false, arg: { id: String(id || ""), text: String(question || ""), remove: remove === true } });
    if (r.handoff) return { status: String(r.fact || "unknown"), handover: r.handoff[0] === "allergy_severe" ? "allergy_severe" : "needs_staff" };
    return { status: String(r.fact || ""), say: String(r.body || "").trim() };
  } catch { return { status: "unknown", handover: "needs_staff" }; }
}
/* «لين ١٥/١٠» لو العرض بينتهي خلال ٧ أيام (بتوقيت الرياض)؛ غير كده ولا كلمة */
export function endsSoon(until, now, lang, within = DEFAULTS.offerEndWithinDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(until || ""));
  if (!m) return "";
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 21, 0, 0);       // نهاية اليوم بتوقيت الرياض = 21:00 UTC
  const days = (end - now.getTime()) / 86400000;
  if (days < 0 || days > within) return "";
  return lang === "en" ? ` (until ${Number(m[3])}/${Number(m[2])})` : ` (لين ${Number(m[3])}/${Number(m[2])})`;
}
/* عروض السجل الشغّالة الحين واللي ليها تاريخ انتهاء — للتوصيل/الاستلام بس */
function timedBlock(cfg, lang, data) {
  const list = (Array.isArray(data.offers) ? data.offers : []).filter((o) => o.until && o.title && Number(o.price) > 0);
  if (!list.length) return "";
  return [textOf(cfg, "timed_head", lang), ...list.slice(0, 4).map((o) => `• ${o.title}: ${lang === "en" ? `SAR ${money(o.price)}` : `${money(o.price)} ر.س`}${endsSoon(o.until, data.now, lang, cfg.offerEndWithinDays)}`)].join("\n");
}
export class FaqMissing extends DataMissing { constructor(k) { super(`faq:${k}`); this.faq = k; } }
const isMashakel = (i) => /مشكل مخصوص/.test(i.name);       // قاعدة عمر: مشكل مخصوص من غير أوزان ولا عدد أشخاص ⇒ الاسم والسعر بس
const priceText = (lang, i) => (i.byWeight ? (lang === "en" ? `from SAR ${money(i.price)}` : `من ${money(i.price)} ر.س`) : (lang === "en" ? `SAR ${money(i.price)}` : `${money(i.price)} ر.س`));
const fitTitle = (s2, n2) => { const a = [...String(s2 || "").trim()]; return a.length <= n2 ? a.join("") : a.slice(0, n2 - 1).join("").trim() + "…"; };

/* المجرّد ⇒ جسم Cloud API. interactive=false ⇒ نص عادي (الرابط في آخره؛ الأزرار تتحوّل لتعليمات مكتوبة). */
export function toPayload(r, { cfg, lang, interactive = true, footer: withFooter = true } = {}) {
  const footer = withFooter ? textOf(cfg, "footer", lang) : undefined;
  if (r.list) {
    const rows = r.list.rows.slice(0, LIMITS.rows).map((x) => ({ id: x.id, title: fitTitle(x.title, LIMITS.rowTitle), ...(x.description ? { description: fitTitle(x.description, LIMITS.rowDesc) } : {}) }));
    if (interactive) return msgList(r.body, r.list.button, rows, { footer });
    // نص عادي: نفس الصفوف مكتوبة (العميل يكتب اسم الصف)
    return msgText(`${r.body}\n${rows.filter((x) => !/^m:(main|human|cats|boxes)$/.test(x.id)).map((x) => `• ${x.title}${x.description ? ` — ${x.description}` : ""}`).join("\n")}`, false);
  }
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
    if (!/^https:\/\/(freshcuts\.sa\/(l\/[a-z0-9-]+(#item-\d{1,6})?|track\/W\d{6,20}|c\/[a-z0-9]{6,16})$|maps\.google\.com\/|www\.google\.com\/maps|maps\.app\.goo\.gl\/|g\.page\/)/.test(String(a.url || ""))) return "cta_url";
    return null;
  }
  if (i.type === "list") {
    const a = i.action || {}, rows = (a.sections || []).flatMap((x) => x.rows || []);
    if (!a.button || [...a.button].length > LIMITS.listButton) return "list_button";
    if (!rows.length || rows.length > LIMITS.rows) return "list_rows";
    if (rows.some((x) => !x.id || !x.title || [...x.title].length > LIMITS.rowTitle || (x.description && [...x.description].length > LIMITS.rowDesc))) return "list_row";
    if (new Set(rows.map((x) => x.id)).size !== rows.length) return "list_dup";
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
  [/(?:^| )عند(?:كم|كو|ك) (?:ايه|اي|شنو|شو)(?: |$)|(?:^| )ايه (?:الاكل|المنيو|الاصناف)|(?:^| )(?:الاكل|الاصناف) (?:ايه|ايش|وش)(?: |$)/, "cats"],
  [/(?:^| )(?:عايز|عاوز|عايزه|عاوزه|بدي|ابي|ابغى|اريد) (?:اكل|وجبه|بوكس|اشوف)/, "cats"],
  [/(?:^| )(?:فين|وين|فينه|وينه) (?:الاوردر|اوردري|الاوردر بتاعي)|(?:^| )الاوردر (?:فين|وين|اتاخر)/, "status"],
];

/* ── القرار (صافي) ──────────────────────────────────────────────────────────
   ev   = { phone, text, type, interactiveId, referral, at, intent(stop|start من whatsapp.js) }
   ctx  = { cfg, now, chat, humanActive, repliesLastHour, lastSame:{key, at}, data }
   ⇒ { act: "reply"|"silent", reason, key, rawIntent, lang, score, reply?, payloads?, handoff?, mute?, greet?, optout?, link? } */
/* know = { menu (wabot.indexMenu من المنيو الحي), bundles } — من غيرهم التصنيف شغّال بس من غير أصناف/بوكسات بالاسم.
   ⇒ { key, arg, rawIntent, lang, score, entities }. arg: رقم القسم/الصنف، slug البوكس، رقم النوع، مفتاح السؤال الشائع… */
/* سؤال عن مكونات صنف (بعد التطبيع). الجزء الأخير: «… فيه/فيها <كلمة>؟» بعلامة استفهام أو «هل …» — مش «شي فيه دجاج» اللي هو طلب اقتراح. */
const INGR_RE = /(^هل .*(فيه|فيها|فيهم) (?!ايش|ايه|شنو)\S+)|((فيه|فيها|فيهم) (ال)?(?!ايش|ايه|شنو)[^\s؟?]+ ?[؟?]\s*$)|\bcontains?\b|\bdoes .* have\b|\bwithout\b.*\?/i;
/* الوصفة والمقادير وطريقة التحضير والتتبيلة والمورّد: أسرار شغل (قرار عمر ١٢/١٠) ⇒ رد «secret»، من غير تحويل ومن غير أي تفصيلة */
const RECIPE_RE = /تتبيل|متبل ب|مقادير|المقدار|كم (جرام|غرام|جم)|بالجرام|جرامات|طريقه (ال)?(عمل|تحضير|طبخ|تسويه|كفته|شوي)|كيف (تسوون|تسووا|تعملون|تعملوا|تحضرون|تطبخون|تتبلون)|اعطني طريقه|عطني طريقه|ريسبي|الوصفه|وصفه (ال)?|خلطه|الخلطه|سر (ال)?(طعم|نكهه|خلطه)|المورد|موردكم|recipe|marinade|how (do|did) you (make|cook|prepare|marinate)|how many grams|supplier/i;
const REMOVE_RE = /(^| )(بدون|من غير|بلا) \S+|\bwithout \S+|\bno [a-z]+ (please|pls)\b/i;
/* صنف واحد من النص: الاسم الكامل أولاً (wadishfacts.pickDish)، وإلا المرشّح الوحيد اللي المصنّف لقاه. */
function dishOf(text, e, know) {
  const ids = e.itemId ? [String(e.itemId)] : (e.items || []).map(String);
  const all = (know.menu && know.menu.items) || [];
  const cands = ids.length ? all.filter((i) => ids.includes(String(i.id))) : all;
  const hit = pickDish(text, cands.map((i) => ({ id: i.id, name: i.name })));
  return hit || (ids.length === 1 ? ids[0] : null);
}
/* «نفس الطلب / زي آخر مرة / كرر الطلب / المعتاد» — بعد التطبيع (ة⇒ه، أ⇒ا) */
const REORDER_RE = /(نفس|زي|مثل) (ال)?(طلب|طلبي|طلبنا|اخر مره|المره اللي فاتت|المره الماضيه)|كرر(وا|و)? ?(لي )?(ال)?(طلب|طلبي)|(ال)?معتاد|same (order|as last)|re-?order|the usual/i;
export function classify(ev, know = {}) {
  const type = String(ev.type || "text");
  const rawText = String(ev.text || "");
  const placeholder = /^\[[^\]]*\]$/.test(rawText.trim());
  const text = placeholder ? "" : rawText;
  const lang = detectLang(text);
  const out = (key, arg = null, rawIntent = key, score = 10, entities = {}) => ({ key, arg, rawIntent, lang, score, entities });
  if (ev.interactiveId) {
    const id = String(ev.interactiveId);
    if (BUTTON_IDS[id]) return out(BUTTON_IDS[id], null, `button:${id}`);
    const i = id.indexOf(":"), k = i > 0 ? id.slice(0, i) : "", v = i > 0 ? id.slice(i + 1) : "";
    if (k === "m" && MENU_IDS[v]) return out(MENU_IDS[v], null, `list:${id}`);
    if (["tier", "box", "cat", "item"].includes(k) && /^[a-z0-9-]{1,60}$/i.test(v)) return out(k, v, `list:${id}`);
  }
  if (IGNORED_TYPES.has(type)) return out(null, null, `type:${type}`, 0);
  if (ev.location && Number.isFinite(ev.location.lat) && Number.isFinite(ev.location.lng)) return out("area", { lat: ev.location.lat, lng: ev.location.lng }, "location");
  { const co = coordsFromText(text); if (co) return out("area", co, "maps_link"); }
  if (MEDIA_TYPES.has(type) && !text.trim()) return out("media", null, `media:${type}`);
  if (ev.intent === "stop" || ev.intent === "start") return out(ev.intent, null, ev.intent, 12);
  const n = normalize(text);
  const om = text.match(ORDER_NO_RE);
  const orderNo = om ? om[1].toUpperCase() : null;
  if (NAV_RE.test(n)) return out("main", null, "nav");
  if (ACK_RE.test(n) || (!n && text.trim() && /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(text.trim()))) return out("ack", null, "ack");
  if (NACK_RE.test(n)) return out("nack", null, "nack");
  const m = matchIntent(text, { type: "text", menu: know.menu || null });
  let intent = m.intent;
  const e = { ...(m.entities || {}), orderNo };
  const done = (key, arg = null, raw = intent) => ({ key, arg, rawIntent: raw, lang: m.lang || lang, score: m.score, entities: e });
  /* ١٢/١٠ — «الساعة كم» اتصنّفت شكوى: كلمة مدة لوحدها (درجة ٣) كانت كفاية. الشكوى لازم لها إشارة شكوى فعلية
     (بارد/ناقص/غلط/متأخر… ⇒ درجة ٥+). إشارة ضعيفة + كلام عن الطلب ⇒ «وين طلبي» (حالة حقيقية، وبتحوّل لو متأخر فعلاً). */
  if (intent === "complaint" && m.score < 5) intent = orderNo || /طلب|اوردر|order|مندوب|driver/.test(n) ? "order_status" : "unknown";
  if (RECIPE_RE.test(n) && !HARD_INTENTS.has(intent)) return done("secret", null, "recipe");
  if (TIME_RE.test(n) && !HARD_INTENTS.has(intent)) return done("hours", null, "time_question");
  if (REORDER_RE.test(n) && (!HARD_INTENTS.has(intent) || intent === "order_status")) return done("reorder", null, "reorder");
  /* حساسية: «شديدة» ⇒ موظف عاجل مهما كان الصنف. سؤال حساسية عن صنف واحد محدد ⇒ حقايق الأصناف. غير كده ⇒ مدخل «allergens» (فاضي عمداً ⇒ موظف). */
  if (!HARD_INTENTS.has(intent) && groupsIn(text).length) {
    if (SEVERE_RE.test(n) || SEVERE_RE.test(text)) return done("dishfact", { id: null, text }, "allergy_severe");
    const one = dishOf(text, e, know);
    if (one) return done("dishfact", { id: one, text }, "allergy_dish");
  }
  /* «ممكن وجبة الكفتة بدون طحينة؟»: سؤال تخصيص قبل الطلب عن صنف محدد ⇒ حقايق الأصناف. كلام عن طلب موجود («طلبي بدون بصل») بيفضل تعديل طلب ⇒ موظف. */
  if (REMOVE_RE.test(n) && !/طلبي|الطلب|طلبنا|اوردر|\border\b/.test(n) && !["complaint", "refund", "cancel_order", "human", "stop", "start"].includes(intent)) {
    /* الصنف لازم يكون مذكور باسمه الكامل **قبل** «بدون» — «بدون بصل لو سمحت» لوحدها مش سؤال عن صنف (و«بصل» مش «حلقات بصل»). */
    const menuAll = (know.menu && know.menu.items) || [];
    const one = menuAll.length > 1 ? pickDish(text.split(/بدون|من غير|بلا |without|no /i)[0], menuAll.map((i) => ({ id: i.id, name: i.name }))) : null;
    if (one) return done("dishfact", { id: one, text: text.replace(/^.*?(بدون|من غير|بلا|without|no )/i, "$1"), remove: true }, "remove_question");
  }
  if (!HARD_INTENTS.has(intent)) {
    const fq = FAQ_RULES.find(([, re]) => re.test(n));
    if (fq) return done("faq", fq[0], `faq:${fq[0]}`);
    if (SPICY_RE.test(n) && !(e.items || []).length) return done("spicy", null, "spicy");
    if (BOX_RE.test(n)) {
      const f = findBoxes(n, know.bundles);
      if (f.hits.length === 1) return done("box", f.hits[0].slug, "box");
      if (f.tier >= 0) return done("tier", String(f.tier), "box_tier");
      return done("boxes", null, "boxes");
    }
    if (PACK_RE.test(n) && intent !== "order_status") return done("packs", null, "packs");
  }
  if (intent === "dietary") {
    if (e.topic === "spicy") return done("spicy");
    return done("faq", { halal: "halal", vegetarian: "vegetarian", gluten: "allergens", allergy: "allergens", calories: "calories" }[e.topic] || "allergens", `faq:${e.topic}`);
  }
  if (intent === "menu" || intent === "item_price" || intent === "item_info") {
    if (e.notOnMenu) return done("notmenu", e.notOnMenu);
    /* سؤال مكونات عن صنف («ايش مكونات…»، «… فيه جبن؟»): وصف المنيو مش قايمة مكونات كاملة (ملاحظة الشيف ١٢/١٠: وصف البرجر الكلاسيك
       مافيهوش صوص الشيدر ولا الثاوزند آيلاند) ⇒ مانردّش بالوصف كأنه المكونات؛ نحوّل لموظف لحد ما ملف حقايق الأصناف يتوافق عليه. */
    if ((INGR_RE.test(n) || INGR_RE.test(text)) && (e.itemId || (e.items || []).length || e.categoryId)) {
      const one = dishOf(text, e, know);
      return one ? done("dishfact", { id: one, text }, "ingredients") : done("staff", null, "ingredients");      // صنف واحد محدد ⇒ حقايق الأصناف؛ غير كده موظف
    }      // «… فيه جبن؟»: نعم/لا من ملف الحقايق المعتمد — لحد ما يتوافق عليه: موظف
    /* «ايش مكونات X / وش فيه X»: وصف المنيو العام وبس (الرد العادي للصنف تحت) — مش قايمة مكونات ومش وصفة. */
    const ids = e.itemId ? [String(e.itemId)] : (e.items || []).map(String);
    if (ids.length === 1) return done("item", ids[0]);
    // «عندكم برجر دجاج»: الأصناف اللي فيها الكلمة مبعثرة على أقسام تانية ⇒ قسم البرجر نفسه أوضح. «وجبة كفتة»: كلهم من نفس القسم ⇒ هم.
    if (ids.length > 1 && e.categoryId && know.menu && !ids.every((id) => (know.menu.categories.find((x) => x.id === String(e.categoryId))?.items || []).some((i) => i.id === id))) return done("cat", String(e.categoryId));
    if (ids.length > 1) return done("items", ids.slice(0, 6));
    if (e.categoryId) return done("cat", String(e.categoryId));
    return done("cats");
  }
  if (intent === "recommend") return e.sub === "family" ? done("tier", "2") : done("best");
  if (intent === "how_to_order" && e.sub === "pickup") return done("pickup");
  let key = INTENT_MAP[intent] || "staff";
  // صياغات شائعة (مصرية/شامية) قاموس wabot ما يعرفها — تتجرّب بس لو النتيجة «غير مفهوم»
  if (key === "unknown") { const x = EXTRA.find(([re]) => re.test(n)); if (x) key = x[1]; }
  if (key.startsWith("faq:")) return done("faq", key.slice(4), `faq:${key.slice(4)}`);
  return done(key);
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
const FACTUAL_KEYS = new Set(["hours", "hoursloc", "location", "status", "thanks", "stop", "start", "optin_yes", "optin_no", "resume_all", "resume_updates"]);
/* أسئلة المنيو والأسعار والتوصيل: معلومات. بتتجاوب حتى والمحادثة عند الموظف — إلا لو التحويل شكوى/مشكلة (SERIOUS). */
const MENU_KEYS = new Set(["main", "menu", "cats", "cat", "item", "items", "boxes", "tier", "box", "best", "spicy", "notmenu", "packs", "payment", "pickup", "delivery", "area", "faq", "dishfact"]);
const SERIOUS = new Set(["allergy_severe", "complaint", "problem", "order_change", "order_late", "order_issue", "send_failed"]);
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
    if (c.key === "ack" || c.key === "nack") return silent("ack");
    /* مع مساعد الطلبات (ctx.assistOn): الرسالة الغير مفهومة بتستنى الموظف زي غيرها وبعدين المساعد يرد عليها — مابتتسابش من غير رد (عطل ١٢/١٠: «انت بطيء اوي» فضلت من غير رد). */
    if (c.key === "unknown" && !ctx.assistOn) return silent(ps.kind, { resumeAt: iso(ps.until), detail: "unknown_left_to_staff" });
    const due = Math.min(nowMs + cfg.staffWaitMin * 60_000, ps.until);
    return { act: "wait", waitKind: "staff_wait", dueAt: iso(due), resumeAt: iso(due), reason: ps.kind, ...base };
  }

  let key = c.key, handoff = null;
  if (cfg.intentsOff.includes(key) && !optout) { key = "staff"; }

  // ٤ب) تحويل مفتوح: شكوى ⇒ معلومات بس. طلب موظف اتكرر ⇒ الفريق اتنبّه خلاص، مفيش رسالة ولا تنبيه تاني.
  /* قلنا للعميل «المساعد الآلي يترك المحادثة للموظف» ⇒ لازم يكون ده اللي بيحصل، وبنفس الشكل كل مرة:
     طول ما التحويل مفتوح البوت بيرد على المعلومات بس (مواعيد/موقع/حالة طلب). التحويل العادي (طلب موظف، سؤال…) بيتقفل
     أول ما موظف يرد بعده؛ تحويل الشكوى بيفضل مفتوح لحد handoffOpenHours (قاعدة ٤ب) أو «رجّع البوت». */
  const hoAt = chat.handoff_at ? Date.parse(chat.handoff_at) : NaN;
  const hoReason = Number.isFinite(hoAt) && nowMs - hoAt < cfg.handoffOpenHours * 3600_000 ? String(chat.handoff_reason || "handover") : null;
  const staffTook = Boolean(hoReason && ctx.lastEchoAt && Date.parse(ctx.lastEchoAt) > hoAt);
  const ho = hoReason && !(staffTook && !SERIOUS.has(hoReason)) ? hoReason : null;
  const hoUntil = ho ? iso(hoAt + cfg.handoffOpenHours * 3600_000) : null;
  let factual = Boolean(ho);
  /* قرار عمر ١٢/١٠: شكوى والموظف رد عليها ⇒ البوت «يسكت خالص» (ولا معلومات ولا تذكير) لحد ما التحويل يخلص أو «رجّع البوت».
     «إيقاف» وزرار الرجوع بيتنفّذوا ويتأكدوا للعميل برضه (ده حقه). */
  if (ho && SERIOUS.has(ho) && staffTook && !["stop", "start", "resume_all", "resume_updates"].includes(key)) return silent("complaint_with_staff", { key, resumeAt: hoUntil, detail: ho });
  const escalates = Boolean(ho && HANDOFF_KEYS[key] && SERIOUS.has(HANDOFF_KEYS[key][0]) && !SERIOUS.has(ho));
  // «تمام/لا»: إجابة على سؤال الموافقة لو لسه مطروح، وإلا مفيش رد (العميل بيقفل الكلام)
  if (key === "ack" || key === "nack") {
    const asked = chat.optin_asked_at ? Date.parse(chat.optin_asked_at) : NaN;
    const answered = chat.optin_answered_at ? Date.parse(chat.optin_answered_at) : NaN;
    const pending = Number.isFinite(asked) && nowMs - asked < cfg.optinAnswerWindowMin * 60_000 && !(Number.isFinite(answered) && answered >= asked);
    if (!pending) return silent("ack");
    key = key === "ack" ? "optin_yes" : "optin_no";
  }
  if (factual && !FACTUAL_KEYS.has(key) && !escalates) {
    if (!SERIOUS.has(ho) && MENU_KEYS.has(key)) factual = false;          // تحويل عادي: المنيو والأسعار بتتجاوب عادي
    else {
      /* العميل لسه بيكتب والمحادثة عند الموظف: نقول له مرة واحدة (بميعاد الفتح لو مقفول)، وبعدها سكوت. */
      const reminded = chat.handoff_reminded_at && Date.parse(chat.handoff_reminded_at) >= hoAt;
      if (reminded || optout) return silent("handoff_open", { key, resumeAt: hoUntil, detail: ho });
      key = "handoff_remind";
    }
  }

  let regreet = false;
  if (key === "greet") {
    const hasAd = Boolean(ev.referral) || Boolean(chat.referral_at && nowMs - Date.parse(chat.referral_at) < cfg.adWindowHours * 3600_000);
    /* عميل قال «هلا» مايتردّش عليه بسكوت أبداً (عطل ١٢/١٠: «السلام عليكم» بعد ٣ ساعات من التحية ⇒ ولا حرف).
       جوّه مدة التحية، أو تحية غير محادثات الإعلانات لما التحية للإعلانات بس ⇒ القائمة الرئيسية القصيرة (من غير اسم ولا ترحيب مكرر). */
    if ((cfg.greetScope === "ads" && !hasAd) || (chat.last_greet_at && nowMs - Date.parse(chat.last_greet_at) < cfg.greetWindowHours * 3600_000)) { key = "main"; regreet = true; }
  }
  const wasUnknown = key === "unknown";
  if (key === "unknown" && Number(chat.unknown_streak) >= cfg.unknownHandoverAfter - 1) { key = "human"; handoff = ["not_understood_twice", "normal"]; }
  /* حارس الحلقات: مش تحويل لموظف. طلب موظف/شكوى بيعدّوا دايماً. عند الحد: سطر هادي مرة واحدة في الساعة، وبعدها سكوت لحد ما المدة تعدّي. */
  const rt = ctx.rate || { text: Number(ctx.repliesLastHour) || 0, taps: 0, minute: 0 };
  if (!optout && !HANDOFF_KEYS[key] && key !== "handoff_remind" && key !== "resume_all" && key !== "resume_updates") {
    const isTap = Boolean(ev.interactiveId);
    const cap = rt.minute >= cfg.maxRepliesPerMinute ? "burst" : (isTap ? rt.taps >= cfg.maxTapsPerHour : rt.text >= cfg.maxRepliesPerHour) ? "hour" : null;
    if (cap) {
      const oldest = cap === "burst" ? rt.oldestMinute : isTap ? rt.oldestTap : rt.oldestText;
      const resume = (oldest ? Date.parse(oldest) : nowMs) + (cap === "burst" ? 60_000 : 3600_000);
      const toldAt = cap === "burst" ? rt.burstAt : rt.rateAt;
      if (toldAt && nowMs - Date.parse(toldAt) < 3600_000) return silent("rate_limited", { key, resumeAt: iso(resume), detail: cap === "burst" ? "minute" : isTap ? "taps" : "hour" });
      key = cap === "burst" ? "rate_burst" : "rate";
    }
  }
  if (ctx.lastSame && ctx.lastSame.key === key && key !== "status" && nowMs - Date.parse(ctx.lastSame.at) < cfg.duplicateSeconds * 1000) return silent("duplicate", { key });
  // ٥) في الدوام: الغير مفهوم يستنى الموظف قبل القائمة. مقفول: فوراً.
  if (wasUnknown && key !== "rate" && key !== "rate_burst" && open !== false && !ctx.afterWait && cfg.unknownWaitMin > 0) {
    const due = nowMs + cfg.unknownWaitMin * 60_000;
    return { act: "wait", waitKind: "unknown_wait", dueAt: iso(due), resumeAt: iso(due), reason: "unknown_wait", ...base };
  }
  if (HANDOFF_KEYS[key] && !handoff) handoff = HANDOFF_KEYS[key];

  const interactive = cfg.interactive && ctx.interactive !== false;
  const bc = { cfg, lang: c.lang, data: ctx.data, referral: ev.referral || null, factual, arg: c.arg ?? null };
  let reply, problem = null, faqGap = null;
  try { reply = buildReply(key, bc); }
  catch (e) {
    if (e instanceof FaqMissing) faqGap = e.faq;      // سؤال مالوش إجابة معتمدة ⇒ «أحوّلك لموظف» (مش «معلومة ناقصة») والسجل بيقول أنهي سؤال
    else problem = e instanceof DataMissing ? e.what : `error:${e.message}`;
  }
  if (faqGap && ho) {            // سؤال مالوش إجابة والمحادثة عند الموظف أصلاً ⇒ مانفتحش تحويل تاني: تذكير مرة واحدة ثم سكوت
    const reminded = chat.handoff_reminded_at && Date.parse(chat.handoff_reminded_at) >= hoAt;
    if (reminded) return silent("handoff_open", { key, resumeAt: hoUntil, detail: ho });
    try { key = "handoff_remind"; reply = buildReply(key, bc); faqGap = null; } catch (e2) { return silent("handoff_open", { key, resumeAt: hoUntil, detail: ho }); }
  }
  if (faqGap) {
    try { reply = buildReply("staff", bc); handoff = HANDOFF_KEYS.staff; key = "staff"; }
    catch (e2) { problem = `faq:${faqGap}`; }
  }
  if (problem) {
    try { reply = buildReply("data_missing", bc); handoff = ["data_missing", "normal"]; key = "data_missing"; }
    catch (e2) { return { act: "silent", reason: "build_failed", ...base, key, detail: problem, handoff: ["data_missing", "normal"] }; }
  }
  if (reply.handoff) handoff = reply.handoff;
  // تحويل مفتوح أصلاً ⇒ مفيش تنبيه تاني للفريق على نفس المحادثة (إلا لو الجديد أخطر من القديم)
  if (handoff && ho && !(SERIOUS.has(handoff[0]) && !SERIOUS.has(ho))) handoff = null;
  // ٧) التعريف: أول رسالة من البوت في المحادثة (مرة كل ٢٤ ساعة)
  const disclose = !chat.last_disclosed_at || nowMs - Date.parse(chat.last_disclosed_at) >= cfg.disclosureHours * 3600_000;
  let disclosed = false;       // سطر التعريف اتحط فعلاً فوق الرد
  if (disclose) {
    try { reply = { ...reply, body: `${disclosureLine(cfg, c.lang, ctx.data?.settings)}\n${reply.body}` }; disclosed = true; }
    catch { /* نص التعريف اتعدّل غلط ⇒ الرد يطلع من غيره أحسن ما مايطلعش */ }
  }
  // رسالة تانية (اختيارية): بعد التحية القائمة الرئيسية؛ بعد حالة الطلب سؤال الموافقة على تحديثات الطلب
  const replies = [reply, ...(Array.isArray(reply.extra) ? reply.extra : [])];
  let optinAsk = null;
  if (!factual && !problem) {
    try {
      const askedAt = chat.optin_asked_at ? Date.parse(chat.optin_asked_at) : NaN;
      if (key === "status" && !handoff && cfg.optin.enabled && ctx.data?.order && ctx.data.optinUpdates === false
        && !(Number.isFinite(askedAt) && nowMs - askedAt < cfg.optin.askAfterHours * 3600_000)) {
        optinAsk = textOf(cfg, "optin_ask", c.lang);
        replies.push({ body: optinAsk, buttons: [{ id: "optin:yes", title: textOf(cfg, "btn_yes", c.lang) }, { id: "optin:no", title: textOf(cfg, "btn_no", c.lang) }] });
      }
    } catch { /* الرسالة التانية إضافة — الرد الأساسي يطلع من غيرها */ }
  }
  /* سطر «للرجوع… أو موظف» (طلب عمر ١٢/١٠: مش تحت كل رسالة). always = كل رسالة بزر؛ first = أول رسالة في المحادثة بس؛
     smart = الرسالة الغير مفهومة + أي أزرار/قايمة مافيهاش زر «القائمة» أو «موظف». أول رسالة في smart من غير السطر: سطر التعريف
     فوقها بيقول «للتحدث مع موظف اكتب: موظف» أصلاً، فمايتكررش مرتين في نفس الرسالة (لو التعريف ماطلعش لأي سبب، السطر يرجع).
     رسالة الرابط (زر واحد يفتح الموقع) من غير السطر في smart: كلمة «موظف» شغّالة دايماً. */
  const wayBack = (r) => [...(r.buttons || []), ...((r.list && r.list.rows) || [])].some((b) => /^(bot:human|m:human|bot:menu|m:main)$/.test(String(b.id)));
  const showFooter = (r, i) => Boolean(cfg.footerMode === "always" || (cfg.footerMode === "first" && disclose && i === 0) || (cfg.footerMode === "smart" && disclose && !disclosed && i === 0) || (cfg.footerMode === "smart" && (key === "unknown" || ((r.buttons || r.list) && !wayBack(r)))));
  const payloads = replies.map((r, i) => toPayload(r, { cfg, lang: c.lang, interactive, footer: showFooter(r, i) }));
  const fallback = replies.map((r) => toPayload(r, { cfg, lang: c.lang, interactive: false }));
  const pp = [...payloads, ...fallback].map(payloadProblem).find(Boolean);
  if (pp) {   // الرد اتبنى غلط (نص اتعدّل، حد واتساب…) ⇒ العميل مايتسابش من غير رد: سطر «حوّلت سؤالك لموظف» + تنبيه. لو ده كمان مايتبنيش ⇒ سكوت + تنبيه.
    try {
      const safe = toPayload(buildReply("data_missing", bc), { cfg, lang: c.lang, interactive: false });
      if (!payloadProblem(safe)) return { act: "reply", reason: `payload_invalid:${pp}`, ...base, key: "data_missing", payloads: [safe], fallback: [safe], handoff: handoff || ["data_missing", "normal"], detail: `${key}:${pp}`, greet: false, resume: null, optout, link: null, unknown: false, disclose: false, factual, optinAsk: null, optinAnswer: null };
    } catch { /* تحت */ }
    return { act: "silent", reason: "payload_invalid", ...base, key, detail: pp, handoff: handoff || ["data_missing", "normal"] };
  }
  return { act: "reply", reason: problem ? `data_missing:${problem}` : (ctx.afterWait ? `after_${ctx.afterWait}` : null), ...base, key, payloads, fallback, handoff,
    detail: faqGap ? `faq:${faqGap}` : regreet ? "regreet" : reply.fact ? `fact:${reply.fact}` : null, greet: key === "greet", resume: key === "resume_all" ? "all" : key === "resume_updates" ? "updates" : null, optout, link: reply.link || null, unknown: key === "unknown", disclose, factual,
    optinAsk, optinAnswer: key === "optin_yes" ? "yes" : key === "optin_no" ? "no" : null };
}

/* نص تنبيه الفريق — رسالة SMS واحدة (fitOneSms حارس أخير). مفيش اسم العميل ولا نص رسالته. */
const REASON_EN = { complaint: "complaint", problem: "payment/site problem", order_change: "change/cancel order", asked_human: "asked for staff", needs_staff: "question for staff",
  media: "sent photo/voice", not_understood_twice: "not understood", rate_limit: "many messages", data_missing: "bot could not answer", order_not_found: "order not found",
  allergy_severe: "SEVERE ALLERGY question", custom_offer: "wants a tailored group offer", order_late: "LATE order", order_issue: "order issue", send_failed: "bot reply failed" };
const REASON_AR = { allergy_severe: "حساسية شديدة", custom_offer: "عرض مخصص لتجمع", complaint: "شكوى", problem: "مشكلة دفع/موقع", order_change: "تعديل/الغاء طلب", asked_human: "طلب موظف", needs_staff: "سؤال", media: "صورة/صوت",
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
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;   -- SR2: الموظف ساب المحادثة للبوت ⇒ ردوده اللي قبل كده مابتسكّتش البوت
      ALTER TABLE wa_bot_log ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_log ADD COLUMN IF NOT EXISTS reply_arg TEXT;       -- صنف/قسم/بوكس الرد — «نفس الرد» = نفس المفتاح ونفس الهدف
      -- ١٢/١٠: سؤال الموافقة على تحديثات الطلب (مرة كل فترة) + إثبات الإجابة بنص السؤال اللي اتعرض
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS optin_asked_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS optin_answered_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS handoff_reminded_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS last_loc JSONB;        -- آخر موقع شاركه العميل { lat, lng, at, via } — لفحص النطاق ولمساعد الطلبات
      CREATE TABLE IF NOT EXISTS wa_optin_proofs (
        id BIGSERIAL PRIMARY KEY,
        phone_norm TEXT NOT NULL, kind TEXT NOT NULL,        -- updates (تحديثات الطلب). التسويق سؤال منفصل لاحقاً.
        answer TEXT NOT NULL,                                -- yes | no
        wording TEXT, lang TEXT,                             -- نص السؤال اللي العميل شافه
        asked_at TIMESTAMPTZ, answer_wamid TEXT, source TEXT NOT NULL DEFAULT 'wa_bot',
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS wa_optin_proofs_phone_idx ON wa_optin_proofs(phone_norm, at DESC);
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
      -- محادثات الإعلانات (١٢/١٠): صف لكل (رقم، إعلان) من أول رسالة جاية من إعلان — لتقرير «كل إعلان: محادثات / سلات / طلبات مدفوعة».
      -- wa_bot_chats.referral بيحتفظ بآخر إعلان بس (بيتكتب فوقه)، و wa_bot_log.referral علامة نعم/لا من غير رقم الإعلان.
      CREATE TABLE IF NOT EXISTS wa_ad_chats (
        phone_norm TEXT NOT NULL, ad_id TEXT NOT NULL DEFAULT '', headline TEXT, source_type TEXT,
        first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), clicks INT NOT NULL DEFAULT 1,
        PRIMARY KEY (phone_norm, ad_id)
      );
      CREATE INDEX IF NOT EXISTS wa_ad_chats_first_idx ON wa_ad_chats(first_at DESC);
    `);
    for (const l of SEED_LINKS) {
      await pool.query(
        `INSERT INTO cms_links(slug, label, target_type, target_id, coupon, utm_source, utm_medium, utm_campaign, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'wabot') ON CONFLICT (slug) DO NOTHING`,
        [l.slug, l.label, l.target_type, l.target_id, l.coupon, l.utm_source, l.utm_medium, l.utm_campaign]).catch(() => {});
    }
    // الخصوصية: سجل البوت ٩٠ يوم
    { const keep = botConfig((await getSettingsData().catch(() => null)) || {}).logKeepDays; await pool.query("DELETE FROM wa_bot_log WHERE at < NOW() - make_interval(days => $1::int)", [keep]).catch(() => {}); }
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_bot_config_log (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), who TEXT, changes JSONB NOT NULL)`).catch((e) => console.error("[wabot] config log:", e.message));
  }
  const ready = ensureSchema().then(() => botCarts.ensure().catch((e) => console.error('[wabot] cart schema:', e.message))).then(() => aicost.ensure().catch((e) => console.error('[wabot] ai-cost schema:', e.message))).then(() => assistStore.ensure().then(async () => assistStore.purge(botConfig((await getSettingsData().catch(() => null)) || {}).assist.keepDays)).catch((e) => console.error('[wabot] assist schema:', e.message))).then(() => ensureWaConsentSchema(pool).catch((e) => console.error('[wabot] consent schema:', e.message))).then(() => console.log("[wabot] runtime ready")).catch((e) => console.error("[wabot] init failed:", e.message));

  let tune = botConfig({});          // آخر إعدادات اتقرت — مدد الكاش بتتاخد منها (بتتحدّث مع كل رسالة وكل قراءة للإعدادات)
  let bundleCache = { at: 0, rows: null };
  async function bundles() {
    if (bundleCache.rows && Date.now() - bundleCache.at < tune.boxesCacheMin * 60_000) return bundleCache.rows;
    try { const rows = await fetchBundles(); if (Array.isArray(rows) && rows.length) bundleCache = { at: Date.now(), rows }; }
    catch (e) { console.error("[wabot] bundles:", e.message); }
    return bundleCache.rows && Date.now() - bundleCache.at < tune.staleCacheMin * 60_000 ? bundleCache.rows : [];   // كاش أقدم من ساعة مايتعرضش
  }
  /* المنيو الحي (نفس اللي المتجر بيعرضه) ⇒ فهرس wabot.indexMenu. كاش ١٠ دقايق؛ كاش أقدم من ساعة مايتعرضش. */
  const storeBase = (process.env.STOREFRONT_PUBLIC_URL || STORE).split(",")[0].replace(/\/+$/, "");
  const fetchMenuPages = deps.fetchMenuPages || (async () => {
    const r = await fetch(`${storeBase}/api/menu?branch_id=1`, { headers: { "User-Agent": "freshcuts-wabot" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`menu HTTP ${r.status}`);
    return (await r.json())?.data?.pages || [];
  });
  let menuCache = { at: 0, pages: null };
  async function menuIndex(settings, now) {
    if (!menuCache.pages || Date.now() - menuCache.at > tune.menuCacheMin * 60_000) {
      try { const pg = await fetchMenuPages(); if (Array.isArray(pg) && pg.length) menuCache = { at: Date.now(), pages: pg }; }
      catch (e) { console.error("[wabot] menu:", e.message); }
    }
    if (!menuCache.pages || Date.now() - menuCache.at > tune.staleCacheMin * 60_000) return null;
    const soldOut = {};
    for (const [k, v] of Object.entries(settings?.catalog?.soldOut || {})) if (!v?.until || Date.parse(v.until) > now.getTime()) soldOut[k] = true;
    try { return indexMenu(menuCache.pages, { hiddenIds: settings?.catalog?.hiddenIds || [], soldOut }); } catch { return null; }
  }
  /* العروض الشغّالة الحين من سجل العروض (نفس اللي المتجر بيعرضه) — كاش دقيقتين؛ وقع ⇒ null (نقول أقل) */
  const fetchOffers = deps.fetchOffers || (async () => { const r = await self.request("/api/offers"); if (!r.ok) throw new Error(`offers HTTP ${r.status}`); return (await r.json())?.offers || []; });
  let offersCache = { at: 0, rows: null };
  async function liveOffers(settings, now) {
    if (!offersCache.rows || Date.now() - offersCache.at > tune.offersCacheMin * 60_000) {
      try { const rows = await fetchOffers(); if (Array.isArray(rows)) offersCache = { at: Date.now(), rows }; }
      catch (e) { console.error("[wabot] offers:", e.message); if (Date.now() - offersCache.at > tune.staleCacheMin * 60_000) offersCache = { at: 0, rows: null }; }
    }
    if (!offersCache.rows) return null;
    const paused = settings?.catalog?.pausedOffers || {};
    const day = new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    return offersCache.rows.filter((o) => o && o.id && (o.channels?.delivery || o.channels?.takeaway) && !o.dineInOnly)
      .filter((o) => (!o.from || String(o.from).slice(0, 10) <= day) && (!o.until || String(o.until).slice(0, 10) >= day))       // مش منتهي ولا لسه مابدأش
      .filter((o) => { const pz = paused[o.id] || paused[o.bundleSlug]; return !(pz && (!pz.until || Date.parse(pz.until) > now.getTime())); })
      .map((o) => ({ id: String(o.id), title: String(o.title || ""), price: Number(o.price) || 0, from: o.from || null, until: o.until || null }));
  }
  const quoteAt = deps.quote || (async (lat, lng) => { const r = await self.request(`/api/delivery/quote?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`); return r.ok ? r.json() : null; });
  /* مين اللي عمل التعديل (لسجل الإعدادات والكتم): مستخدم اللوحة باسمه ودوره، أو «owner token» لو الطلب جه بمفتاح المالك (سكربت/وكيل).
     مفيش هوية معروفة ⇒ "unknown" (مش فاضي): السجل دايماً بيقول مين. */
  const whoami = deps.whoami || ctx.whoami || null;
  async function actorOf(c) {
    try {
      const u = whoami ? await whoami(c) : null;
      if (u && typeof u === "object") return u.adminKey ? "owner token" : `${String(u.name || u.username || "user").slice(0, 40)} (${String(u.role || "?").slice(0, 20)})`;
      if (u) return String(u).slice(0, 60);
    } catch (e) { console.error("[wabot] whoami:", e.message); }
    return "unknown";
  }
  /* رابط خرايط مختصر ⇒ إحداثيات: طلب واحد من غير متابعة تلقائية، للنطاقات المسموحة بس، ٣ قفزات، ٣ ثواني. فشل ⇒ null (الرسالة تتعامل كنص عادي). */
  const resolveMapsLink = deps.resolveMapsLink || (async (url) => {
    let u = url;
    for (let i = 0; i < 3; i++) {
      if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co|www\.google\.com|maps\.google\.com|google\.com)\//i.test(u)) return null;
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 3000);
      try { const r = await fetch(u, { method: "GET", redirect: "manual", signal: ctl.signal }); const loc = r.headers.get("location"); if (!loc) return null; const co = coordsFromText(loc); if (co) return co; u = loc; }
      catch { return null; } finally { clearTimeout(tm); }
    }
    return null;
  });
  const botCarts = deps.botCarts || makeBotCarts({ pool, now: deps.now || (() => new Date()), locationHours: async () => botConfig((await getSettingsData()) || {}).assist.locationHours });      // السلات الجاهزة (نفس الطلب الأخير؛ ومساعد الطلبات بعدين)
  const llm = deps.llm || null;      // wabotllm.classify — تصنيف بس
  const aicost = makeAiCost({ pool, sendSms: deps.sendSms || null, now: deps.now || (() => new Date()) });   // كل نداء للموديل بيتسجّل بتكلفته + السقف
  /* مساعد الطلبات: المخزن (الجلسة، سجل الأدوار، الاقتراحات) ونداء الموديل. الحلقة نفسها بتتركّب تحت بعد الأدوات. */
  const assistStore = deps.assistStore || makeAssistStore({ pool, jb: (v) => JSON.stringify(v) });
  const assistCall = deps.assistCallModel || makeModelCaller();
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { console.error("[wabot] db:", e.message); return null; } };

  /* البيانات الحية لرسالة واحدة. أي مصدر وقع ⇒ قيمته null/فاضية ⇒ الرد اللي محتاجه بيتحوّل لموظف. */
  async function loadData({ settings, cfg, phone, orderNo, key, now, know = null, arg = null }) {
    const data = { settings, now, bundles: [], policy: null, first: null, loyalty: null, order: null, links: {}, open: null, chat: null, menu: know?.menu || null, quote: null, optinUpdates: null };
    try { data.open = settings?.hours ? openState(settings, now) : null; } catch { data.open = null; }
    try { data.loyalty = loyaltyCfgOf(settings); } catch { data.loyalty = null; }
    const need = (...ks) => ks.includes(key);
    data.bundles = know?.bundles || (await bundles());
    if (need("offers", "packs")) data.offers = await liveOffers(settings, now);
    if (need("area") && arg && Number.isFinite(arg.lat)) { try { data.quote = await quoteAt(arg.lat, arg.lng); } catch { data.quote = null; } }
    if (need("status") && /^5\d{8}$/.test(String(phone || ""))) { /* false = الرقم ده ماجاوبش على السؤال قبل كده (لا في المتجر ولا هنا) ⇒ ينفع يتسأل. جاوب «نعم» أو «لا» ⇒ مايتسألش تاني. */
      const o = await q("SELECT updates, updates_answered_at FROM wa_optins WHERE phone_norm=$1", [phone]); data.optinUpdates = o === null ? null : Boolean(o[0] && (o[0].updates === true || o[0].updates_answered_at)); }
    if (need("greet") && /^5\d{8}$/.test(String(phone || ""))) {   // عميل طلب من الموقع قبل كده ⇒ نحيّيه باسمه (الاسم اللي كتبه هو في آخر طلب)
      const r = await q(`SELECT customer->>'name' AS name FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment') ORDER BY created_at DESC LIMIT 1`, [phone]);
      data.customerName = r && r[0] ? r[0].name : null;
    }
    if (need("greet", "reorder") && cfg.reorderEnabled) {   // لقطة سلة آخر طلب ⇒ خطة على المنيو والباقات الحيّة (مصدر ناقص ⇒ مفيش عرض)
      try {   // أحدث طلب **يتجهّز**: الأحدث أولاً، وأول واحد خطته تنفع على المنيو الحي هو اللي بيتعرض
        const snaps = await botCarts.lastOrderCarts(phone, cfg.reorderMaxDays, { limit: cfg.reorderLookback, minTotal: cfg.reorderMinTotal });
        data.reorder = null;
        for (const snap of snaps || []) {
          const plan = reorderPlan(snap, { menu: data.menu, bundles: data.bundles && data.bundles.length ? data.bundles : null });
          if (plan && plan.ok) { data.reorder = { plan, orderNo: snap.orderNo, option: snap.option, at: snap.at, url: null }; break; }
        }
      }
      catch (e) { console.error("[wabot] reorder:", e.message); data.reorder = null; }
    }
    if (need("delivery", "area")) { const r = await q("SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1", []); data.policy = r && r[0] ? r[0].config : null; }
    if (need("order", "offers", "delivery", "main", "area")) {
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
    const slugs = [...new Set([cfg.links.organic, cfg.links.ads, cfg.links.packs, "wab-menu", ...(key === "box" && arg ? [String(arg)] : []), ...Object.values(cfg.links.adMap)])];
    const lr = await q("SELECT slug FROM cms_links WHERE slug = ANY($1::text[]) AND active", [slugs]);
    for (const x of lr || []) data.links[x.slug] = true;
    return data;
  }

  async function chatOf(phone) { const r = await q("SELECT * FROM wa_bot_chats WHERE phone_norm=$1", [phone]); return (r && r[0]) || {}; }
  const isoOf = (v) => (v ? new Date(v).toISOString() : null);
  const argOf = (a) => (a == null ? "" : typeof a === "string" ? a : JSON.stringify(a)).slice(0, 120);
  async function recent(phone, key, arg = null) {
    /* الإشعارات نفسها (rate / rate_burst / handoff_remind) مابتتعدّش. ضغطات القائمة (msg_type=interactive) بتتعدّ لوحدها. */
    const NOT_NOTICE = `COALESCE(reply_key,'') NOT IN ('rate','rate_burst','handoff_remind')`, OKD = `decision IN ('replied','dry')`, TAP = `COALESCE(msg_type,'') = 'interactive'`;
    const r = await q(`SELECT count(*) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND NOT ${TAP})::int AS n_text, min(at) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND NOT ${TAP}) AS oldest_text,
                              count(*) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND ${TAP})::int AS n_tap, min(at) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND ${TAP}) AS oldest_tap,
                              count(*) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND at > NOW() - INTERVAL '1 minute')::int AS n_min, min(at) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND at > NOW() - INTERVAL '1 minute') AS oldest_min,
                              max(at) FILTER (WHERE ${OKD} AND reply_key='rate') AS rate_at, max(at) FILTER (WHERE ${OKD} AND reply_key='rate_burst') AS burst_at,
                              count(*) FILTER (WHERE decision IN ('replied','dry') AND at > NOW() - INTERVAL '1 hour')::int AS n,
                              max(at) FILTER (WHERE decision IN ('replied','dry') AND reply_key=$2 AND COALESCE(reply_arg,'')=$3) AS same_at,
                              max(at) FILTER (WHERE decision='failed' AND error NOT LIKE 'skipped:%' AND at > NOW() - INTERVAL '10 minutes') AS failed_at
                         FROM wa_bot_log WHERE phone_norm=$1 AND at > NOW() - INTERVAL '1 hour'`, [phone, key, argOf(arg)]);
    const x = (r && r[0]) || {};
    const at = (v) => (v ? isoOf(v) : null);
    return { n: Number(x.n) || 0, rate: { text: Number(x.n_text) || 0, taps: Number(x.n_tap) || 0, minute: Number(x.n_min) || 0, oldestText: at(x.oldest_text), oldestTap: at(x.oldest_tap), oldestMinute: at(x.oldest_min), rateAt: at(x.rate_at), burstAt: at(x.burst_at) }, lastSame: x.same_at ? { key, at: isoOf(x.same_at) } : null, failedRecently: Boolean(x.failed_at) };
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
    `UPDATE wa_bot_log SET decision=$2, reason=$3, detail=COALESCE($4, detail), reply_key=COALESCE($5, reply_key), replies=$6, sent=$7, error=$8, handoff=$9, alert=$10, link_slug=$11, resume_at=$12 WHERE id=$1`,
    [logId, d.decision, d.reason || null, d.detail ? String(d.detail).slice(0, 200) : null, d.key || null, d.replies ? jb(d.replies) : null,
      d.sent || 0, d.error ? String(d.error).slice(0, 200) : null, d.handoff || null, d.alert || null, d.link || null, d.resumeAt || null]);

  /* رسالة واردة واحدة. بترجّع true لو البوت «ماسك» (أي وضع غير off). عمرها ما بترمي. */
  async function handle(ev) {
    let settings;
    try { settings = (await getSettingsData()) || {}; } catch { return false; }
    const cfg = botConfig(settings); tune = cfg;
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
    const know = { menu: await menuIndex(settings, now), bundles: await bundles() };
    /* رابط خرايط مختصر ملصوق كنص ⇒ نحلّه لإحداثيات (زي ما لو شارك موقعه) */
    if (!afterWait && !ev.location && !ev.interactiveId) { const sl = shortMapsLink(ev.text); if (sl) { let co = null; try { co = await resolveMapsLink(sl); } catch { co = null; } if (co) ev = { ...ev, location: co }; } }
    let cls = classify(ev, know);
    /* آخر موقع شاركه العميل بيتحفظ على محادثته (لفحص النطاق، ولمساعد الطلبات عشان مايسألش عن العنوان تاني) */
    if (!afterWait && cls.key === "area" && cls.arg && /^5\d{8}$/.test(phone)) {
      await q(`INSERT INTO wa_bot_chats(phone_norm, last_loc) VALUES ($1,$2) ON CONFLICT (phone_norm) DO UPDATE SET last_loc=$2, updated_at=NOW()`, [phone, jb({ lat: cls.arg.lat, lng: cls.arg.lng, at: now.toISOString(), via: cls.rawIntent })]);
    }
    const finish = (d) => finishLog(logId, d);
    try {
      // ٢) الإعلان: نحفظ مصدره على المحادثة من أول رسالة (حتى لو هنسكت)
      if (!afterWait && ev.referral && /^5\d{8}$/.test(phone)) {
        const r = ev.referral;
        const ref = { source_id: r.source_id || null, source_type: r.source_type || null, source_url: r.source_url || null, headline: r.headline ? String(r.headline).slice(0, 120) : null, ctwa_clid: r.ctwa_clid || null };
        await q(`INSERT INTO wa_bot_chats(phone_norm, referral, referral_at) VALUES ($1,$2,NOW())
                 ON CONFLICT (phone_norm) DO UPDATE SET referral=$2, referral_at=NOW(), updated_at=NOW()`, [phone, jb(ref)]);
        await q(`INSERT INTO wa_ad_chats(phone_norm, ad_id, headline, source_type) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (phone_norm, ad_id) DO UPDATE SET last_at=NOW(), clicks = wa_ad_chats.clicks + 1, headline = COALESCE(EXCLUDED.headline, wa_ad_chats.headline)`,
          [phone, String(ref.source_id || "").slice(0, 40), ref.headline, ref.source_type ? String(ref.source_type).slice(0, 20) : null]);
      }
      const ok = /^5\d{8}$/.test(phone);
      const chat = await chatOf(phone);
      let echoAt = ok ? await lastEcho(phone) : null;
      /* SR2 (١٣/١٠): الموظف ساب المحادثة للبوت (unmuteChat بـrelease) ⇒ رسايله اللي قبل اللحظة دي مابتسكّتش البوت ولا المساعد. */
      if (echoAt && chat.released_at && Date.parse(echoAt) <= Date.parse(chat.released_at)) echoAt = null;
      /* هجين (اختياري، من اللوحة): الرسالة اللي القواعد مافهمتهاش تتصنّف بموديل — **تصنيف بس**: بيرجّع اسم نية من قايمتنا
         (+ صنف/قسم/بوكس من البيانات) بدرجة ثقة، والرد نفسه نص ثابت بيتعبّى من البيانات الحيّة زي أي رد. فشل/تأخر/ثقة قليلة ⇒ «غير مفهوم». */
      if (cls.key === "unknown" && cfg.llm.enabled && llm && !afterWait && String(ev.text || "").trim().length >= 2) {
        /* السقف أولاً: مصروف اليوم/الشهر وصل الحد (أو مانعرفش نعدّه) ⇒ مفيش نداء، والبوت يكمل بالقواعد. SMS واحد أول مرة. */
        const sc0 = staffConfig(settings);
        const stop = await aicost.gate({ purpose: "classify", budget: cfg.llm, phones: cfg.llm.alertPhones.length ? cfg.llm.alertPhones : (cfg.alertPhones.length ? cfg.alertPhones : sc0.alertPhones), lang: sc0.lang, alert: cfg.mode !== "dry" });
        if (stop) await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `llm off: ${stop}`]);
        else {
          const metas = []; let g = null, threw = null; const t0 = Date.now();
          try { g = await llm({ text: String(ev.text || ""), menu: know.menu, bundles: know.bundles, cfg: { ...cfg.llm, onCall: (m) => metas.push(m) } }); }
          catch (e) { threw = e; console.error("[wabot] llm:", e.message); }
          const accepted = Boolean(g && g.key && g.confidence >= cfg.llm.minConfidence);
          if (accepted) cls = { ...cls, key: g.key, arg: g.arg ?? null, rawIntent: `llm:${g.key}`, score: g.confidence };
          await q("UPDATE wa_bot_log SET intent=$2, reply_key=$3, detail=$4 WHERE id=$1", [logId, g && g.key ? `llm:${g.key}` : "llm:none", cls.key, g ? `llm ${Math.round((g.confidence || 0) * 100)}% ${g.ms || 0}ms` : "llm failed"]);
          /* المصنّف مابلّغش عن النداء (حقنة اختبار أو مزوّد قديم) ⇒ صف تقديري برضه: مفيش نداء من غير أثر. */
          if (!metas.length) metas.push({ provider: null, model: cfg.llm.model, usage: null, ms: (g && g.ms) || Date.now() - t0, outcome: threw ? "error" : g ? "ok" : "none", sent: null, promptChars: 0 });
          for (const m of metas) {
            const outcome = m.outcome !== "ok" ? m.outcome : accepted ? "accepted" : g && g.key ? "low_confidence" : "no_intent";
            try { await aicost.record({ ...m, purpose: "classify", phone, outcome, detail: g && g.key ? `${g.key} ${Math.round((g.confidence || 0) * 100)}%` : null, logId }, cfg.llm.prices); } catch (e) { console.error("[wabot] ai-cost:", e.message); }
          }
        }
      } else if (afterWait && ev.cls && ev.cls.key) cls = { ...cls, ...ev.cls };   // الرد المؤجّل بيكمل بنفس التصنيف اللي اتحسب وقت وصول الرسالة
      const rc = cls.key ? await recent(phone, cls.key, cls.arg) : { n: 0, lastSame: null, failedRecently: false };
      await q("UPDATE wa_bot_log SET reply_arg=$2 WHERE id=$1", [logId, argOf(cls.arg)]);
      let data;
      try { data = await loadData({ settings, cfg, phone, orderNo: cls.entities?.orderNo || null, key: cls.key, now, know, arg: cls.arg }); }
      catch (e) {   // مصدر بيانات وقع كله ⇒ بيانات فاضية: أي رد محتاج بيانات هيتحوّل لموظف من نفسه (DataMissing)
        console.error("[wabot] data:", e.message);
        data = { settings, now, bundles: [], policy: null, first: null, loyalty: null, order: null, orderDbFailed: true, links: {}, open: null };
      }
      /* «نفس طلبي الأخير»: السلة الجاهزة بتتعمل هنا (الرابط لازم يكون حقيقي قبل ما الرد يتبني). التجربة الصامتة مابتعملش صف. */
      if (cls.key === "reorder" && data.reorder && data.reorder.plan) {
        if (cfg.mode === "dry") data.reorder.url = `${STORE}/c/dryrun00`;
        else { const made = await botCarts.create({ phone, source: "reorder", fromOrder: data.reorder.orderNo, plan: data.reorder.plan, option: data.reorder.option, days: cfg.reorderLinkDays }); data.reorder = made ? { ...data.reorder, url: `${STORE}/c/${made.code}`, code: made.code } : null; }
      }
      data.chat = chat;
      /* مساعد الطلبات شغّال للعميل ده (١٢/١٠، بعد تجربة عمر: المساعد ماردّش ولا مرة عشان التحويل والرد المؤجّل كانوا للقواعد):
         • الموظف كتب ⇒ المساعد يتراجع assist.staffStepBackMin (٥ د) بدل humanPauseMin (٣٠ د)، وبعدها يرجع لوحده.
         • تحويل عادي (طلب موظف، سؤال، عرض مخصص، صورة) مابيمسكش المحادثة: المساعد يكمل يرد على اللي يعرفه.
         • تحويل جدّي (شكوى، مشكلة دفع، تعديل طلب مدفوع، حساسية شديدة) بيمسكها assist.seriousHoldMin (١٥ د) بس، مش ٢٤ ساعة. */
      const assistOn = cfg.assist.mode === "test" && (cfg.mode === "test" || cfg.mode === "live") && cfg.testPhones.includes(phone);
      const held = assistOn && seriousHeld(chat, cfg, now);
      data.assistOn = assistOn;
      let d = decide(ev, { cfg: assistOn ? { ...cfg, humanPauseMin: cfg.assist.staffStepBackMin } : cfg, now, chat: assistOn && !held ? { ...chat, handoff_at: null, handoff_reason: null } : chat,
        lastEchoAt: echoAt, repliesLastHour: rc.n, rate: rc.rate, lastSame: rc.lastSame, failedRecently: rc.failedRecently, data, cls, afterWait, assistOn });
      /* مساعد الطلبات (وضع التجربة، أرقام التجربة بس): لو الرسالة من نصيبه ومفيش مانع، ردّه بيبدّل قرار القواعد. أي فشل (مهلة، سقف، خطأ، رد اترفض
         مرتين) ⇒ ar.d = null ⇒ قرار القواعد زي ما هو. ar.done بيتنادى بعد التنفيذ عشان الجلسة والسجل والمتابعة يتكتبوا **بعد** ما الرسالة تتبعت فعلاً. */
      let ar = null;
      if (assistOn) { try { ar = await assistTurn({ ev, logId, settings, cfg, d, cls, chat, data, know, now, echoAt, phone, held }); } catch (e) { console.error("[assist] turn:", e.message); ar = null; } }
      if (ar && ar.d) d = ar.d;
      const assistDone = async (x) => { if (ar && ar.done) { try { await ar.done(x); } catch (e) { console.error("[assist] done:", e.message); } } };
      /* رسالة القواعد مافهمتهاش (هترد «ما فهمت» الحين أو بعد انتظار الموظف) ⇒ تنزل في طابور أسئلة المدير لو فيها كلمتين معنى على الأقل
         (مش «؟؟» ولا «تمام»). مرة واحدة: مش في الرد المؤجّل، وبس للمحادثات اللي البوت بيرد فيها فعلاً (live، أو رقم تجربة في وضع test)، ومش لو المساعد هو اللي رد. */
      if (!afterWait && (cfg.mode === "live" || (cfg.mode === "test" && cfg.testPhones.includes(phone))) && d.key === "unknown" && (d.act === "reply" || d.act === "wait") && ev.type === "text" && String(ev.text || "").trim()) {
        const kb = kbApi();
        if (kb && kbTokens(maskText(ev.text)).size >= 2) { try { await kb.queue({ question: ev.text, lang: d.lang === "en" ? "en" : "ar", source: "rules_unknown" }); } catch (e) { console.error("[wabot] kb:", e.message); } }
      }

      /* زرار الرجوع تحت رسالة الإيقاف: اختيار صريح من العميل بنفسه. «تحديثات طلبي فقط» ⇒ موافقة تحديثات عن طريق waconsent (بتتغلب على الإيقاف
         للتحديثات بس). «كل الرسائل والعروض» ⇒ نفس «اشتراك» (applyIntent start) + صف إثبات تسويقي. التجربة الصامتة مابتسجّلش حاجة. */
      if (d.resume && d.act === "reply" && cfg.mode !== "dry" && !afterWait) {
        const shown = textOf(cfg, "stop", d.lang === "en" ? "en" : "ar");
        try {
          if (d.resume === "updates") await recordWaUpdatesBot(pool, { phoneNorm: phone, value: true, text: `${shown}\n[${textOf(cfg, "btn_resume_updates", d.lang === "en" ? "en" : "ar")}]`, wamid: ev.wamid || null });
          else { if (typeof wa.applyIntent === "function") await wa.applyIntent(phone, "start"); await recordWaMarketingBot(pool, { phoneNorm: phone, value: true, text: `${shown}\n[${textOf(cfg, "btn_resume_all", d.lang === "en" ? "en" : "ar")}]`, wamid: ev.wamid || null }); }
        } catch (e) { console.error("[wabot] resume:", e.message); }
      }
      // «إيقاف/اشتراك» بصياغة أوسع من اللي whatsapp.js بيمسكها ⇒ نطبّقها هنا (حتى لو هنسكت)
      if (d.optout && !ev.intent && !afterWait && typeof wa.applyIntent === "function") { try { await wa.applyIntent(phone, d.optout); } catch (e) { console.error("[wabot] optout:", e.message); } }

      if (d.act === "wait") {
        // رد مؤجّل: صف في القاعدة (بيعيش بعد إعادة التشغيل). وقت التنفيذ كل الشروط بتتراجع من جديد.
        const evLite = { phone, phoneNorm: phone, wamid: ev.wamid || null, text: String(ev.text || "").slice(0, 1000), type: ev.type || "text",
          interactiveId: ev.interactiveId || null, referral: ev.referral || null, location: ev.location || null, at: ev.at || now.toISOString(), intent: ev.intent || null,
          cls: /^llm:/.test(String(cls.rawIntent || "")) ? { key: cls.key, arg: cls.arg ?? null, rawIntent: cls.rawIntent, score: cls.score } : null };
        const j = await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
          [ev.wamid || null, phone, d.waitKind, d.dueAt, jb(evLite), logId]);
        await finish({ decision: j && j.length ? "waiting" : "silent", reason: j && j.length ? d.reason : "job_not_saved", key: d.key, resumeAt: d.resumeAt });
        await assistDone({ okSent: false });
        return;
      }
      if (d.act === "silent") {
        let alert = null;
        if (d.handoff) alert = await handoffNow(settings, cfg, phone, d.handoff, data.order?.order_no, null, d.lang);
        await finish({ decision: "silent", reason: d.reason, detail: d.detail, key: d.key, handoff: d.handoff ? d.handoff[0] : null, alert, resumeAt: d.resumeAt });
        await assistDone({ okSent: false });
        return;
      }
      // ٣) الإرسال: dry = مفيش. test = قايمة التجربة بس. live = الأقفال الكاملة. محاولة واحدة (+ نص عادي لو التفاعلي فشل).
      let sent = 0, error = null;
      const used = [];
      if (cfg.mode !== "dry") {
        const allowList = cfg.mode === "test" ? cfg.testPhones : null;
        for (let i = 0; i < d.payloads.length; i++) {       // رسالة أو اتنين بالترتيب؛ أول فشل نهائي بيوقّف الباقي
          let pl = d.payloads[i];
          let r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList });
          if (!r.ok && !r.skipped && pl.type === "interactive") { pl = d.fallback[i]; r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList }); }
          if (r.ok) { sent++; used.push(pl); continue; }
          error = r.skipped ? `skipped:${r.skipped}` : `${r.error || "send_failed"}${r.message ? ` ${r.message}` : ""}`;
          break;
        }
      } else used.push(...d.payloads);
      const okSent = cfg.mode === "dry" || sent > 0;
      const askSent = Boolean(d.optinAsk) && (cfg.mode === "dry" || sent === d.payloads.length);
      // ٤) الحالة: التحية، التعريف، عدّاد «غير مفهوم»، آخر رد
      if (okSent) {
        await q(`INSERT INTO wa_bot_chats(phone_norm, last_greet_at, unknown_streak, last_key, last_key_at, last_disclosed_at)
                 VALUES ($1, CASE WHEN $2 THEN NOW() END, CASE WHEN $3 THEN 1 ELSE 0 END, $4, NOW(), CASE WHEN $5 THEN NOW() END)
                 ON CONFLICT (phone_norm) DO UPDATE SET
                   last_greet_at = CASE WHEN $2 THEN NOW() ELSE wa_bot_chats.last_greet_at END,
                   unknown_streak = CASE WHEN $3 THEN wa_bot_chats.unknown_streak + 1 ELSE 0 END,
                   last_disclosed_at = CASE WHEN $5 THEN NOW() ELSE wa_bot_chats.last_disclosed_at END,
                   last_key = $4, last_key_at = NOW(), updated_at = NOW()`, [phone, d.greet === true, d.unknown === true, d.key, d.disclose === true]);
        if (askSent) await q("UPDATE wa_bot_chats SET optin_asked_at=NOW() WHERE phone_norm=$1", [phone]);
        if (d.key === "handoff_remind") await q("UPDATE wa_bot_chats SET handoff_reminded_at=NOW() WHERE phone_norm=$1", [phone]);
        /* إجابة سؤال الموافقة: «نعم» ⇒ wa_optins.updates (نفس الجدول اللي الشيك أوت بيكتب فيه) + إثبات بنص السؤال والوقت.
           التسويق مابيتلمسش هنا — سؤال منفصل وصريح بعدين. dry: مفيش حاجة بتتسجّل (محدش اتسأل فعلاً). */
        if (d.optinAnswer && cfg.mode !== "dry") {
          const lang2 = d.lang === "en" ? "en" : "ar";
          await q(`INSERT INTO wa_optin_proofs(phone_norm, kind, answer, wording, lang, asked_at, answer_wamid) VALUES ($1,'updates',$2,$3,$4,$5,$6)`,
            [phone, d.optinAnswer, textOf(cfg, "optin_ask", lang2), lang2, chat.optin_asked_at || null, ev.wamid || null]);
          await q("UPDATE wa_bot_chats SET optin_answered_at=NOW() WHERE phone_norm=$1", [phone]);
          /* نفس التخزين والسجل بتوع الشيك أوت (waconsent.js): الرقم = مُرسِل الرسالة، المصدر bot، والنص اللي اتعرض بنسخته. «لا» بتتسجّل برضه. */
          try { await recordWaUpdatesBot(pool, { phoneNorm: phone, value: d.optinAnswer === "yes", text: textOf(cfg, "optin_ask", lang2), wamid: ev.wamid || null }); } catch (e) { console.error("[wabot] optin:", e.message); }
        }
      }
      // ٥) التحويل: يتسجّل «مفتوح» على المحادثة + تنبيه. فشل الإرسال نفسه = تحويل (العميل ماوصلوش حاجة) من غير محاولة تانية.
      let handoff = d.handoff, alert = null;
      if (!okSent && /^skipped:/.test(error || "")) handoff = null;      // الأقفال مقفولة (وضع live من غير مفاتيح واتساب) ⇒ البوت عملياً مقفول: لا تسجيل ولا تنبيه
      else if (!okSent) handoff = ["send_failed", "urgent"];
      if (handoff) alert = await handoffNow(settings, cfg, phone, handoff, data.order?.order_no, d.note || null, d.lang);
      await finish({ decision: cfg.mode === "dry" ? "dry" : sent ? "replied" : "failed", reason: d.reason, detail: d.detail, key: d.key, replies: used, sent, error,
        handoff: handoff ? handoff[0] : null, alert, link: d.link });
      await assistDone({ okSent: okSent && cfg.mode !== "dry", error });
    } catch (e) {
      console.error("[wabot] work:", e.message);
      await finish({ decision: "failed", reason: "exception", error: e.message });
    }
  }
  async function handoffNow(settings, cfg, phone, handoff, orderNo, note = null, lang = "ar") {
    /* نفس السبب اتحوّل قبل شوية (العميل كتب «موظف» تاني والمساعد شغّال فالتحويل مابيمسكش المحادثة) ⇒ مفيش تنبيه مكرر ولا عدّاد جديد. */
    if (/^5\d{8}$/.test(phone) && cfg.mode !== "dry") {
      const was = await chatOf(phone), at0 = was.handoff_at ? Date.parse(was.handoff_at) : NaN;
      if (Number.isFinite(at0) && String(was.handoff_reason || "") === handoff[0] && clock().getTime() - at0 < Math.max(5, cfg.handoverRealertMin, cfg.handoverCustomerNoteMin) * 60_000) return "already_open";
    }
    if (/^5\d{8}$/.test(phone)) {
      await q(`INSERT INTO wa_bot_chats(phone_norm, handoff_at, handoff_reason) VALUES ($1, NOW(), $2)
               ON CONFLICT (phone_norm) DO UPDATE SET handoff_at = NOW(), handoff_reason = $2, unknown_streak = 0, updated_at = NOW()`, [phone, handoff[0]]);
    }
    if (cfg.mode === "dry") return "would";
    /* البوابة (الكاشير): حدث حيّ wa_handover على نفس قناة الطلبات — بيتبعت في وضع التجربة كمان (الكاشير هو اللي بيرد). الواجهة والصوت عند صاحب البورتال. */
    if (typeof deps.portalEmit === "function") { try { deps.portalEmit("wa_handover", { phone: `0${phone}`, phoneMasked: `…${String(phone).slice(-4)}`, reason: handoff[0], reasonAr: REASON_AR[handoff[0]] || handoff[0], urgent: handoff[1] === "urgent", orderNo: orderNo || null, at: clock().toISOString(), test: cfg.mode === "test", ...(note ? { note: String(note).slice(0, 200) } : {}) }); } catch (e) { console.error("[wabot] portal:", e.message); } }
    /* المتابعة: لو محدش من الفريق رد — تنبيه تاني، وبعدها رسالة واحدة صادقة للعميل (صف في wa_bot_jobs، كل الشروط بتتراجع وقت التنفيذ). */
    if (/^5\d{8}$/.test(phone) && (cfg.handoverRealertMin > 0 || cfg.handoverCustomerNoteMin > 0)) {
      const cur = await chatOf(phone), hoAt = cur.handoff_at ? new Date(cur.handoff_at).toISOString() : null;
      if (hoAt) await scheduleHandoverCheck(phone, { hoAt, reason: handoff[0], urgent: handoff[1] === "urgent", orderNo: orderNo || null, lang: lang === "en" ? "en" : "ar", stage: cfg.handoverRealertMin > 0 ? "realert" : "note" }, cfg);
    }
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
        const cfg = botConfig(settings); tune = cfg;
        const ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
        const now = clock();
        if (cfg.mode === "off") { await cancel("mode_off"); continue; }
        if (j.kind === "assist_followup") { await runFollowUp(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "handover_check") { await runHandoverCheck(j, settings, cfg, now, end); ran++; continue; }
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
  /* ── مساعد الطلبات: دور واحد ───────────────────────────────────────────────
     ⇒ null (المساعد مالوش دعوة بالرسالة دي) أو { d, done }. d = قرار بديل لقرار القواعد (رد المساعد أو تحويله لموظف)، أو null ⇒ القواعد ترد.
     done({ okSent }) بيتنادى بعد التنفيذ: الجلسة، سجل الأدوار، الاقتراحات، وسم السلة، وجدولة المتابعة — كله بعد ما الرسالة تتبعت فعلاً. */
  const ASSIST_HANDOVER = { allergy_severe: ["dishfact", ["allergy_severe", "urgent"]], complaint: ["complaint", HANDOFF_KEYS.complaint], problem: ["problem", HANDOFF_KEYS.problem], order_change: ["change", HANDOFF_KEYS.change],
    custom_offer: ["human", ["custom_offer", "normal"]], needs_staff: ["staff", HANDOFF_KEYS.staff] };
  /* تحويل جدّي لسه ماسك المحادثة (المساعد ساكت والقواعد بترد بالمعلومات بس): خلال assist.seriousHoldMin من التحويل. */
  const seriousHeld = (chat, cfg, now) => { const at = chat.handoff_at ? Date.parse(chat.handoff_at) : NaN;
    return Number.isFinite(at) && SERIOUS.has(String(chat.handoff_reason || "")) && now.getTime() - at < cfg.assist.seriousHoldMin * 60_000; };
  /* ── متابعة التحويل: تنبيه تاني للفريق ثم رسالة واحدة للعميل ─────────────────────
     stage «realert» بعد handoverRealertMin من التحويل، و«note» بعد handoverCustomerNoteMin. مابيحصلش أي منهم لو: التحويل اتغيّر أو اتقفل، موظف كتب للعميل
     أو ضغط «تم» في البوابة، المحادثة مكتومة، الوضع اتقفل، أو (للرسالة) المطعم مقفل / بره نافذة الـ٢٤ ساعة / العميل وقّف الرسايل. */
  async function scheduleHandoverCheck(phone, ev, cfg) {
    const base = Date.parse(ev.hoAt), min = ev.stage === "realert" ? cfg.handoverRealertMin : cfg.handoverCustomerNoteMin;
    return q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [`ho:${phone}:${base}:${ev.stage}`, phone, "handover_check", new Date(Math.max(base + min * 60_000, clock().getTime() + 1000)).toISOString(), jb(ev), null]);
  }
  async function runHandoverCheck(j, settings, cfg, now, end) {
    const phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (cfg.mode !== "test" && cfg.mode !== "live") return no("mode_off");
    if (cfg.mode === "test" && !cfg.testPhones.includes(phone)) return no("not_test_phone");
    if (now.getTime() - new Date(j.due_at).getTime() > cfg.maxAgeMinutes * 60_000) return no("stale");
    const chat = await chatOf(phone);
    if (!chat.handoff_at || new Date(chat.handoff_at).toISOString() !== ev.hoAt) return no("handover_changed");
    if (chat.muted_until && Date.parse(chat.muted_until) > now.getTime()) return no("muted");
    const echo = await q(`SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > $2 LIMIT 1`, [phone, ev.hoAt]);
    if (echo === null) return no("echo_check_failed"); if (echo.length) return no("staff_answered");
    const ack = await q(`SELECT acked_at FROM wa_handovers WHERE phone_norm=$1 AND at >= $2 ORDER BY at DESC LIMIT 1`, [phone, ev.hoAt]);      // «تم» في البوابة = حد مسكها
    if (ack && ack[0] && ack[0].acked_at) return no("staff_acked");
    const assistOn = cfg.assist.mode === "test" && cfg.testPhones.includes(phone);
    if (ev.stage === "realert") {
      const waited = Math.round((now.getTime() - Date.parse(ev.hoAt)) / 60_000);
      if (typeof deps.portalEmit === "function") { try { deps.portalEmit("wa_handover", { phone: `0${phone}`, phoneMasked: `…${phone.slice(-4)}`, reason: ev.reason, reasonAr: REASON_AR[ev.reason] || ev.reason, urgent: ev.urgent === true, orderNo: ev.orderNo || null,
        at: ev.hoAt, test: cfg.mode === "test", reminder: true, waitedMin: waited }); } catch (e) { console.error("[wabot] portal:", e.message); } }
      let alert = "would";
      if (cfg.mode === "live" || cfg.alertInTest) alert = await alertStaff(settings, cfg, { phone, reason: ev.reason, orderNo: ev.orderNo });
      if (cfg.handoverCustomerNoteMin > 0) await scheduleHandoverCheck(phone, { ...ev, stage: "note" }, cfg);
      return end("done", `realert:${alert}`);
    }
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    if (!open || open.open !== true) return no("closed");
    const m = await q(`SELECT max(created_at) FILTER (WHERE direction='in' AND COALESCE(source,'api') <> 'history') AS last_in,
                              count(*) FILTER (WHERE direction='in' AND created_at > $2)::int AS wrote, count(*) FILTER (WHERE source='echo' AND created_at > $2)::int AS staff
                         FROM wa_messages WHERE phone_norm=$1 AND created_at > NOW() - INTERVAL '25 hours'`, [phone, ev.hoAt]);
    if (m === null || !m[0]) return no("window_check_failed");
    if (!m[0].last_in || now.getTime() - new Date(m[0].last_in).getTime() > (24 * 60 - 10) * 60_000) return no("window_closed");
    const op = await q("SELECT stopped_at FROM wa_optins WHERE phone_norm=$1", [phone]);
    if (op === null) return no("optout_check_failed"); if (op[0] && op[0].stopped_at) return no("stopped");
    const lang = ev.lang === "en" ? "en" : "ar";
    let pl; try { pl = msgText(textOf(cfg, assistOn && !SERIOUS.has(String(ev.reason)) ? "handover_note_assist" : "handover_note", lang), false); } catch { return no("text_invalid"); }
    if (payloadProblem(pl)) return no("payload_invalid");
    const r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: cfg.mode === "test" ? cfg.testPhones : null });
    const err = r.ok ? null : (r.skipped ? `skipped:${r.skipped}` : String(r.error || "send_failed"));
    const lg = await q(
      `INSERT INTO wa_bot_log(wamid, msg_at, phone_norm, mode, msg_type, text, intent, reply_key, score, lang, decision, referral)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [null, now.toISOString(), phone, cfg.mode, "followup", "", "handover_note", "handover_note", 0, lang, false]);
    if (lg && lg[0]) await finishLog(lg[0].id, { decision: r.ok ? "replied" : "failed", reason: "handover_note", key: "handover_note", replies: r.ok ? [pl] : null, sent: r.ok ? 1 : 0, error: err, detail: `handover ${ev.reason}` });
    return end(r.ok ? "done" : "cancelled", r.ok ? "note_sent" : `send_failed:${err}`.slice(0, 80));
  }
  const handoverOpenOf = (chat, cfg, echoAt, now) => {      // نفس قاعدة decide (٤ب): تحويل مفتوح، والعادي بيتقفل أول ما موظف يرد بعده
    const hoAt = chat.handoff_at ? Date.parse(chat.handoff_at) : NaN;
    if (!Number.isFinite(hoAt) || now.getTime() - hoAt >= cfg.handoffOpenHours * 3600_000) return false;
    const reason = String(chat.handoff_reason || "handover"), staffTook = Boolean(echoAt && Date.parse(echoAt) > hoAt);
    return !(staffTook && !SERIOUS.has(reason));
  };
  /* «زنجر بدون حار» = صنف تاني في المنيو (حقايق المالك): التصنيف بياخد اسم الصنف البديل عشان المساعد يعرضه بدل ما يكتب ملاحظة. */
  const withAlt = (cls) => { if (!cls || cls.key !== "dishfact" || cls.rawIntent !== "remove_question" || !cls.arg || !cls.arg.id) return cls;
    const f = lookupFact(cls.arg.id, cls.arg.text, { remove: true }); return f.status === "alternative" ? { ...cls, alt: { id: f.altId, name: f.alt, name_en: f.altEn } } : cls; };
  const locFresh = (loc, now) => Boolean(chatLocation(loc, now, tune.assist.locationHours));      // نفس القاعدة اللي بتتبعت للمتجر مع السلة: موقع بوقته وعمره أقل من الإعداد
  /* قاعدة معرفة المدير (wakb.js): بتتسجّل بعد البورتال، فبنوصل لها وقت الاستخدام. مش موجودة ⇒ المساعد يشتغل من غيرها. */
  const kbApi = () => { try { return typeof deps.kb === "function" ? deps.kb() : deps.kb || null; } catch { return null; } };
  /* العميل جاي من إعلان (الرسالة دي معاها referral، أو محادثته لسه جوّه مدة الإعلان): عنوان الإعلان من غير أرقام (السعر من الأدوات بس)،
     والعرض المُعلن لو الإعلان مربوط برابط (links.adMap) هدفه بوكس أو عرض شغّال. */
  async function adContext({ ev, chat, cfg, know, settings, now }) {
    const ref = (ev && ev.referral) || (chat.referral && chat.referral_at && now.getTime() - Date.parse(chat.referral_at) < cfg.adWindowHours * 3600_000 ? chat.referral : null);
    if (!ref) return null;
    const headline = String(ref.headline || "").replace(/[0-9٠-٩%٪]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    const slug = ref.source_id ? cfg.links.adMap[String(ref.source_id)] || null : null;
    let advertised = null;
    if (slug) {
      const r = await q("SELECT target_type, target_id FROM cms_links WHERE slug=$1 AND active", [slug]);
      const l = r && r[0] ? r[0] : null;
      if (l && l.target_type === "box") { const b = (know.bundles || []).find((x) => String(x.slug) === String(l.target_id)); if (b) advertised = { kind: "box", slug: String(b.slug), name: b.name, ...(b.name_en ? { name_en: b.name_en } : {}), price: Number(b.price) }; }
      else if (l && l.target_type === "offer") { let list = null; try { list = await liveOffers(settings, now); } catch { list = null; } const o = (list || []).find((x) => String(x.id) === String(l.target_id)); if (o) advertised = { kind: "offer", title: o.title, price: Number(o.price), ...(o.until ? { until: o.until } : {}) }; }
    }
    return headline || advertised ? { ...(headline ? { ad_text: headline } : {}), ...(advertised ? { advertised } : {}) } : null;
  }
  async function assistContext({ fresh, phone, cfg, lang, chat, know, data, now, cls, pending = null, ev = null, settings = null }) {
    const hours = await assist.get_hours();
    let profile = null, offers = null, reorder = null, notes = null, ad = null;
    if (fresh || (ev && ev.referral)) { try { ad = await adContext({ ev, chat, cfg, know, settings, now }); } catch (e) { console.error("[assist] ad:", e.message); ad = null; } }
    if (fresh) { const kb = kbApi(); if (kb) { try { notes = await kb.notesFor(lang); } catch { notes = null; } } }
    if (fresh) {
      const [p, o] = await Promise.all([assist.customer_profile(phone), assist.get_offers(phone)]);
      profile = p && p.ok ? p.profile : null; offers = o && o.ok ? o : null;
      let ro = data && data.reorder && data.reorder.plan ? data.reorder : null;
      if (!ro && cfg.reorderEnabled) {
        try { const snaps = await botCarts.lastOrderCarts(phone, cfg.reorderMaxDays, { limit: cfg.reorderLookback, minTotal: cfg.reorderMinTotal });
          for (const snap of snaps || []) { const plan = reorderPlan(snap, { menu: know.menu, bundles: know.bundles && know.bundles.length ? know.bundles : null }); if (plan && plan.ok) { ro = { plan, at: snap.at }; break; } } }
        catch (e) { console.error("[assist] reorder:", e.message); }
      }
      if (ro) reorder = { day: orderDay(ro.at, lang), lines: ro.plan.lines.map((l) => ({ name: lang === "en" ? l.nameEn : l.name, qty: l.q })), note: "a one-tap button for the same order is attached under your message" };
    }
    let branch = null; try { branch = fresh ? textOf(cfg, "location", lang) : null; } catch { branch = null; }
    return { profile, reorder, context: buildContext({ first: fresh, hours: hours && hours.ok ? hours : null, profile, offers, reorder, locationShared: locFresh(chat.last_loc, now), justShared: cls.key === "area", branch, boxes: fresh ? know.bundles : null, hint: hintOf(withAlt(cls)), handover: pending, notes, ad }) };
  }
  const assistDeps = (cfg, settings, logId) => ({ tools: assist, callModel: assistCall, now: clock,
    knowOf: async () => ({ menu: await menuIndex(settings, clock()), boxes: (await bundles()) || [] }),
    faq: async (topic, lang) => {
      const pick = (o) => String((o && (lang === "en" ? o.en || "" : o.ar || "")) || "").trim() || null;
      if (topic === "payment") { const f = (settings?.storefront?.seo?.faq || []).find((x) => /دفع/.test(String(x?.q || ""))); return f ? String((lang === "en" ? f.a_en : f.a) || f.a || "").trim() || null : null; }
      if (topic === "branch_location") { try { return textOf(cfg, "location", lang); } catch { return null; } }
      return FAQ_DEFS[topic] ? pick(cfg.faq && cfg.faq[topic]) : null;
    },
    dishFactSay: async (a) => { let open = null; try { open = settings?.hours ? openState(settings, clock()) : null; } catch { open = null; } return dishFactSay(cfg, { settings, now: clock(), open }, a); },
    kbSearch: async (question, lang) => { const kb = kbApi(); return kb ? kb.search(question, lang) : null; },
    deliveryInfo: async () => { const r = await q("SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1", []); const pol = r && r[0] ? r[0].config : null; const fees = pol ? feeLines(pol, "ar") : "";
      return pol && fees ? { ok: true, delivers_up_to_km: Number(pol.maxKm) || null, far_zone_up_to_km: pol.farZoneEnabled !== false ? Number(pol.farZoneMaxKm) || null : null, far_zone_extra_per_km: pol.farZoneEnabled !== false ? Number(pol.farZonePerKm) || null : null,
        fee_by_order_total: fees.split("\n"), note: "the exact fee for the customer is shown on the website before payment" } : null; },
    onCall: async (m) => { const rec = await aicost.record({ ...m, purpose: "assistant", logId }, cfg.llm.prices); return { costSar: rec.costSar, in: rec.in, out: rec.out, cached: rec.cached }; } });
  async function assistTurn({ ev, logId, settings, cfg, d, cls, chat, data, know, now, echoAt, phone, held = false }) {
    const acfg = cfg.assist;
    if (!assist || acfg.mode !== "test" || !cfg.testPhones.includes(phone)) return null;
    await ready;
    let session = await assistStore.loadSession(phone, now, acfg.sessionMin);
    /* «بدون بصل» وهو بيجهّز سلة = ملاحظة للمساعد؛ بس لو له طلب حديث من الموقع تبقى «تعديل طلب» للموظف زي النهارده (ومانعرفش ⇒ نفترض إن له طلب). */
    let recentOrder = false;
    if (cls.key === "change") { const ro = await q(`SELECT 1 FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment') AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [phone]); recentOrder = ro === null || ro.length > 0; }
    const el = assistEligible({ acfg, cfg, phone, ev, cls, d, afterWait: null, sessionActive: Boolean(session), handoverOpen: held, recentOrder });
    const lang = cls.lang === "en" ? "en" : "ar";
    const ruleKey = () => String((d && d.key) || cls.key || "reply");
    const turnRow = (x) => assistStore.addTurn({ phone, sessionId: session ? session.id : null, logId, wamid: ev.wamid || null, lang, ...x });
    if (!el.run) {
      return { d: null, done: async ({ okSent }) => {       // القواعد ماسكة الرسالة: لو ردّت وسط محادثة المساعد، تتسجّل عشان المساعد يفضل فاهم السياق
        if (!okSent) return;
        if (session) await assistStore.saveSession(phone, noteRulesTurn(session, ev.text, ruleKey()), now);
        await turnRow({ handledBy: "rules_owned", outcome: `rules:${el.why.replace(/^rules:/, "")}`, masked: maskText(ev.text), trace: {} });
      } };
    }
    const fallback = async (reason, trace = {}) => {
      await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `assist off: ${reason}`]);
      return { d: null, done: async ({ okSent }) => {
        if (okSent && session) await assistStore.saveSession(phone, noteRulesTurn(session, ev.text, ruleKey()), now);
        await turnRow({ handledBy: "rules", outcome: `fallback:${reason}`, masked: trace.sent ?? maskText(ev.text), trace });
      } };
    };
    const n = await assistStore.repliesToday(phone);
    if (n === null) return fallback("db");
    if (n >= acfg.maxRepliesPerChatDay) return fallback("daily_replies");
    /* السقف: مصروف اليوم/الشهر للمساعد وصل الحد ⇒ القواعد ترد + SMS واحد للمالك. */
    const sc0 = staffConfig(settings);
    const stop = await aicost.gate({ purpose: "assistant", budget: { budgetMonthSar: acfg.budgetMonthSar, budgetDaySar: acfg.budgetDaySar }, phones: cfg.llm.alertPhones.length ? cfg.llm.alertPhones : (cfg.alertPhones.length ? cfg.alertPhones : sc0.alertPhones), lang: sc0.lang });
    if (stop) return fallback(stop);
    /* «مقروء + جاري الكتابة» من غير انتظار: لو فشل، الرد نفسه مايتأثرش. */
    if (acfg.typing && ev.wamid && typeof wa.sendTyping === "function") wa.sendTyping({ phoneNorm: phone, wamid: ev.wamid, allowList: cfg.testPhones }).catch((e) => console.error("[assist] typing:", e.message));
    const fresh = !session;
    if (fresh) session = newSession(now);
    /* تحويل عادي لسه مستني موظف: المساعد يعرف (مايحوّلش نفس الحاجة تاني، ويقول للعميل إن الموظف هيرد) ويكمل يساعد. */
    const pending = handoverOpenOf(chat, cfg, echoAt, now) ? { reason: String(chat.handoff_reason || "handover"), minutes_ago: Math.max(0, Math.round((now.getTime() - Date.parse(chat.handoff_at)) / 60_000)) } : null;
    const cx = await assistContext({ fresh, phone, cfg, lang, chat, know, data, now, cls, pending, ev, settings });
    const loop = makeAssistLoop(assistDeps(cfg, settings, logId));
    const text = cls.key === "area" ? "📍" : String(ev.text || "");      // الموقع نفسه مابيتبعتش للموديل: علامة بس، والسياق بيقول إنه شارك موقعه
    const r = await loop.runTurn({ phone, text, lang, session, acfg, context: cx.context, profile: cx.profile });
    if (!r.ok) { if (fresh) session = null; if (/^model_http_400/.test(r.reason)) { await assistStore.dropSession(phone); session = null; } return fallback(r.reason, r.trace); }
    const tr = r.trace, nowMs = now.getTime(), L = tr.lang === "en" ? "en" : tr.lang === "ar" ? "ar" : lang;      // لغة الدور زي ما المساعد حدّدها («Pickup» وسط محادثة إنجليزية = إنجليزي)
    const bc = { cfg, lang: L, data, referral: null, factual: false, arg: null };
    let reply, handoff = null;
    try {
      if (r.handover) { const [k, tuple] = ASSIST_HANDOVER[r.handover.reason] || ASSIST_HANDOVER.needs_staff; reply = buildReply(k, k === "dishfact" ? { ...bc, arg: { id: null, text: "حساسية شديدة" } } : bc); handoff = tuple; reply = { body: reply.body }; }
      else reply = { body: r.text, ...(r.cart ? { cta: { title: textOf(cfg, "cta_reorder", L), url: r.cart.link } } : fresh && cx.reorder ? { buttons: [{ id: "re:last", title: textOf(cfg, "row_reorder", L) }] } : {}) };
    } catch (e) { if (fresh) session = null; return fallback("reply_build", tr); }
    const disclose = !chat.last_disclosed_at || nowMs - Date.parse(chat.last_disclosed_at) >= cfg.disclosureHours * 3600_000;
    if (disclose) { try { reply = { ...reply, body: `${disclosureLine(cfg, L, settings)}\n${reply.body}` }; } catch { /* من غير التعريف أحسن من مفيش رد */ } }
    const payloads = [toPayload(reply, { cfg, lang: L, interactive: cfg.interactive, footer: false })], fb = [toPayload(reply, { cfg, lang: L, interactive: false, footer: false })];
    if ([...payloads, ...fb].map(payloadProblem).find(Boolean)) { if (fresh) session = null; return fallback("payload", tr); }
    const outcome = r.handover ? `handover:${r.handover.reason}` : "sent";
    const nd = { act: "reply", reason: "assistant", key: "assist", rawIntent: cls.rawIntent, lang: cls.lang, score: cls.score, payloads, fallback: fb, handoff, note: r.handover ? r.handover.note : null,
      detail: `assist ${tr.tier}${tr.escalated ? "↑" : ""} ${tr.calls.length} calls ${tr.ms}ms ${Math.round(tr.costSar * 10000) / 10000} SAR${r.handover ? ` → ${r.handover.reason}` : ""}`,
      greet: cls.key === "greet", resume: null, optout: null, link: null, unknown: false, disclose, factual: false, optinAsk: null, optinAnswer: null };
    return { d: nd, done: async ({ okSent, error }) => {
      if (!okSent) { await turnRow({ handledBy: "assistant", outcome: `send_failed${error ? `:${String(error).slice(0, 60)}` : ""}`, masked: tr.sent, text: r.text, trace: tr, handover: r.handover ? r.handover.reason : null }); return; }
      session = r.session;
      await assistStore.saveSession(phone, session, now);
      const turnId = await turnRow({ handledBy: "assistant", outcome, masked: tr.sent, text: r.handover ? reply.body : r.text, trace: tr, cartCode: r.cart ? r.cart.code : null, handover: r.handover ? r.handover.reason : null });
      await assistStore.recordSuggestions(phone, session.id, turnId, tr.suggestions.filter((s) => s.outcome !== "computed"), r.cart ? r.cart.code : null);
      /* قاعدة المعرفة: الإجابة اللي اتستخدمت تتعدّ، والسؤال اللي المساعد ماعرفش يجاوبه (أو حوّله لموظف) ينزل في طابور المدير — مقنّع ومن غير أي ربط بالعميل. */
      { const kb = kbApi();
        if (kb) { try {
          if (tr.kb && tr.kb.used) await kb.markUsed(tr.kb.used);
          for (const u of tr.unanswered || []) await kb.queue({ question: u.question, lang: L, source: u.source === "dish_fact" ? "dish_fact" : "no_answer" });
          if (r.handover && r.handover.reason === "needs_staff" && !(tr.unanswered || []).length && !/موظف|انسان|إنسان|شخص|بشري|staff|human|agent|person/i.test(String(ev.text || ""))) await kb.queue({ question: tr.sent || maskText(ev.text), lang: L, source: "handover" });
        } catch (e) { console.error("[assist] kb:", e.message); } } }
      if (r.cart) {
        await assistStore.tagCart(r.cart.code, (session.state.lastCart && session.state.lastCart.accepted) || [], session.id);
        if (acfg.followUpEnabled) await scheduleFollowUp(phone, { code: r.cart.code, sentAt: clock().toISOString(), lang: L }, acfg);
      }
    } };
  }
  /* ── المتابعة الواحدة بعد رابط السلة ─────────────────────────────────────────
     صف في wa_bot_jobs (بيعيش بعد إعادة التشغيل). سلة جديدة بتلغي متابعة السلة اللي قبلها. وقت التنفيذ **كل** الشروط بتتراجع من جديد (runFollowUp). */
  async function scheduleFollowUp(phone, ev, acfg) {
    await q(`UPDATE wa_bot_jobs SET status='cancelled', reason='replaced', done_at=NOW() WHERE phone_norm=$1 AND kind='assist_followup' AND status='pending'`, [phone]);
    return q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [`fu:${ev.code}`, phone, "assist_followup", new Date(Date.parse(ev.sentAt) + acfg.followUpMin * 60_000).toISOString(), jb(ev), null]);
  }
  const minutesToClose = (hours, now) => { const c = closingToday(hours, now); if (!c) return null; const [h, m] = String(c).split(":").map(Number); const r = new Date(now.getTime() + 3 * 3600_000);
    return ((h * 60 + (m || 0)) - (r.getUTCHours() * 60 + r.getUTCMinutes()) + 1440) % 1440; };
  /* مايتبعتش لو: الوضع اتقفل، الرقم مش في قايمة التجربة، الميعاد فات، السلة انتهت، العميل طلب (أو بدأ دفع)، العميل كتب بعد الرابط، موظف دخل المحادثة،
     العميل وقّف الرسايل، المحادثة مكتومة أو عند موظف، بره نافذة الـ٢٤ ساعة (بنتأكد منها هنا **وكمان** الحارس)، المطعم مقفل أو قرّب يقفل، أو اتبعتت له متابعة في آخر ٢٤ ساعة.
     أي فحص مانعرفش نتيجته (القاعدة ماردّتش) ⇒ مانبعتش. */
  async function runFollowUp(j, settings, cfg, now, end) {
    const acfg = cfg.assist, phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (cfg.mode !== "test" && cfg.mode !== "live") return no("mode_off");
    if (acfg.mode !== "test" || !acfg.followUpEnabled) return no("assist_off");
    if (!cfg.testPhones.includes(phone)) return no("not_test_phone");
    if (now.getTime() - new Date(j.due_at).getTime() > cfg.maxAgeMinutes * 60_000) return no("stale");
    if (!ev.code || !ev.sentAt) return no("bad_job");
    const cart = await q("SELECT (expires_at > NOW()) AS live FROM wa_bot_carts WHERE code=$1 AND phone_norm=$2", [ev.code, phone]);
    if (cart === null) return no("cart_check_failed"); if (!cart[0] || !cart[0].live) return no("cart_gone");
    const ord = await q("SELECT 1 FROM shop_orders WHERE phone_norm=$1 AND created_at > $2 AND status <> 'expired' LIMIT 1", [phone, ev.sentAt]);
    if (ord === null) return no("order_check_failed"); if (ord.length) return no("ordered");
    const m = await q(`SELECT max(created_at) FILTER (WHERE direction='in' AND COALESCE(source,'api') <> 'history') AS last_in,
                              count(*) FILTER (WHERE direction='in' AND created_at > $2)::int AS wrote, count(*) FILTER (WHERE source='echo' AND created_at > $2)::int AS staff
                         FROM wa_messages WHERE phone_norm=$1 AND created_at > NOW() - INTERVAL '25 hours'`, [phone, ev.sentAt]);
    if (m === null || !m[0]) return no("window_check_failed");
    if (Number(m[0].wrote) > 0) return no("customer_wrote"); if (Number(m[0].staff) > 0) return no("staff_in_chat");
    if (!m[0].last_in || now.getTime() - new Date(m[0].last_in).getTime() > (24 * 60 - 10) * 60_000) return no("window_closed");
    const op = await q("SELECT stopped_at FROM wa_optins WHERE phone_norm=$1", [phone]);
    if (op === null) return no("optout_check_failed"); if (op[0] && op[0].stopped_at) return no("stopped");
    const chat = await chatOf(phone);
    if (chat.muted_until && Date.parse(chat.muted_until) > now.getTime()) return no("muted");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return no("handover_open");
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    if (!open) return no("hours_unknown"); if (open.open !== true) return no("closed");
    const left = minutesToClose(settings.hours, now);
    if (left === null || left < acfg.followUpCloseGuardMin) return no("near_closing");
    const prior = await q(`SELECT 1 FROM wa_bot_jobs WHERE phone_norm=$1 AND kind='assist_followup' AND status='done' AND done_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [phone]);
    if (prior === null) return no("prior_check_failed"); if (prior.length) return no("already_followed_up");
    const lang = ev.lang === "en" ? "en" : "ar";
    let pl, plain;
    try { const rep = { body: textOf(cfg, "assist_followup", lang), cta: { title: textOf(cfg, "cta_reorder", lang), url: `${STORE}/c/${ev.code}` } };
      pl = toPayload(rep, { cfg, lang, interactive: cfg.interactive, footer: false }); plain = toPayload(rep, { cfg, lang, interactive: false, footer: false }); } catch { return no("text_invalid"); }
    if (payloadProblem(pl) || payloadProblem(plain)) return no("payload_invalid");
    let r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: cfg.testPhones });      // المساعد تجربة بس ⇒ دايماً بقايمة التجربة
    if (!r.ok && !r.skipped && pl.type === "interactive") { pl = plain; r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: cfg.testPhones }); }
    const err = r.ok ? null : (r.skipped ? `skipped:${r.skipped}` : String(r.error || "send_failed"));
    /* صف في سجل البوت زي أي رد (من غير wamid: مفيش رسالة عميل وراه) — عشان يظهر في السجل وفي حارس الحلقات */
    const lg = await q(
      `INSERT INTO wa_bot_log(wamid, msg_at, phone_norm, mode, msg_type, text, intent, reply_key, score, lang, decision, referral)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [null, now.toISOString(), phone, cfg.mode, "followup", "", "assist_followup", "assist_followup", 0, lang, false]);
    if (lg && lg[0]) await finishLog(lg[0].id, { decision: r.ok ? "replied" : "failed", reason: "assist_followup", key: "assist_followup", replies: r.ok ? [pl] : null, sent: r.ok ? 1 : 0, error: err, detail: `cart ${ev.code}` });
    await assistStore.addTurn({ phone, sessionId: null, handledBy: "assistant", outcome: r.ok ? "followup_sent" : `followup_failed:${err}`, masked: null, text: r.ok ? textOf(cfg, "assist_followup", lang) : null, lang, trace: {}, cartCode: ev.code });
    return end(r.ok ? "done" : "cancelled", r.ok ? null : `send_failed:${err}`.slice(0, 80));
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
  /* SR2 (١٣/١٠): الموظف سحب المحادثة — نفس أعمدة الكتم اليدوي بس بالدقايق (المهلة بتتجدد مع كل رد للموظف، من wastaff.js). */
  async function holdChat(phone, minutes, by) {
    const m = Math.min(1440, Math.max(1, Math.ceil(Number(minutes) || 0)));
    await ready;
    await q(`INSERT INTO wa_bot_chats(phone_norm, muted_until, mute_reason, muted_by) VALUES ($1, NOW() + make_interval(mins => $2::int), 'manual', $3)
             ON CONFLICT (phone_norm) DO UPDATE SET muted_until = NOW() + make_interval(mins => $2::int), mute_reason='manual', muted_by=$3, updated_at=NOW()`, [phone, m, by ? String(by).slice(0, 60) : null]);
    await q(`UPDATE wa_bot_jobs SET status='cancelled', reason='manual_mute', done_at=NOW() WHERE phone_norm=$1 AND status='pending'`, [phone]);
    return { ok: true, minutes: m };
  }
  /* رجّع البوت: بيشيل الكتم اليدوي والتحويل المفتوح وعدّاد «غير مفهوم».
     SR2: release=true ⇒ «سيبها للبوت» فوراً (released_at)؛ keepHandover=true ⇒ فك تلقائي لمحادثة منسية: التحويل المفتوح بيفضل. */
  async function unmuteChat(phone, { release = false, keepHandover = false } = {}) {
    await ready;
    if (keepHandover) await q("UPDATE wa_bot_chats SET muted_until=NULL, mute_reason=NULL, muted_by=NULL, updated_at=NOW() WHERE phone_norm=$1 AND mute_reason='manual'", [phone]);
    else if (release) await q("UPDATE wa_bot_chats SET muted_until=NULL, mute_reason=NULL, muted_by=NULL, handoff_at=NULL, handoff_reason=NULL, unknown_streak=0, released_at=NOW(), updated_at=NOW() WHERE phone_norm=$1", [phone]);
    else await q("UPDATE wa_bot_chats SET muted_until=NULL, mute_reason=NULL, muted_by=NULL, handoff_at=NULL, handoff_reason=NULL, unknown_streak=0, updated_at=NOW() WHERE phone_norm=$1", [phone]);
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
    const cfg = botConfig(settings); tune = cfg;
    const gate = wa && wa.gate ? await wa.gate() : "no_wa";
    const slugs = [...new Set([cfg.links.organic, cfg.links.ads, ...Object.values(cfg.links.adMap)])];
    const lr = (await q("SELECT slug, active, clicks, target_type, target_id, utm_campaign, coupon FROM cms_links WHERE slug = ANY($1::text[])", [slugs])) || [];
    const llmReady = Boolean(process.env.ANTHROPIC_API_KEY || process.env.LITELLM_KEY);
    return c.json({ ok: true, config: cfg, defaults: DEFAULTS, texts: textsMeta(), replyKeys: REPLY_KEYS, modes: MODES, llmReady, llmProvider: providerInfo(), dishFacts: factsCoverage(),
      faq: FAQ_KEYS.map((k) => ({ key: k, q: FAQ_DEFS[k].q, needs: FAQ_DEFS[k].needs, ar: cfg.faq?.[k]?.ar || "", en: cfg.faq?.[k]?.en || "" })),
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
    /* مين غيّر إيه: كل حفظ صف بالفرق (من ← إلى) واسم اللي حفظ */
    { const changes = configDiff(prev, v.value); if (changes.length) await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [await actorOf(c), JSON.stringify(changes)]); }
    if (ctx.auditNote) { try { await ctx.auditNote(c, `🤖 بوت واتساب: ${prev.mode || "off"} → ${v.value.mode || "off"}${"testPhones" in (b || {}) ? ` · أرقام التجربة ${(v.value.testPhones || []).length}` : ""}`); } catch { /* سجل النشاط اختياري */ } }
    return c.json({ ok: true, config: botConfig({ waBot: v.value }) });
  });

  /* «اللي البوت عارفه دلوقتي»: نفس الحقايق اللي هيقولها لو اتسأل الحين، من نفس المصادر وبنفس الكاش — عشان المالك يتأكد
     إن تعديل في اللوحة (سعر، إيقاف صنف، مواعيد، عرض) وصل للبوت. قراءة بس. */
  app.get("/api/cms/wabot/facts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const settings = (await getSettingsData()) || {};
    const cfg = botConfig(settings); tune = cfg;
    const now = clock();
    const menu = await menuIndex(settings, now);
    const bs = await bundles();
    const offers = await liveOffers(settings, now);
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    const pol = await q("SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1", []);
    const policy = pol && pol[0] ? pol[0].config : null;
    const fr = await q(`SELECT code, min_total, free_delivery, once_per_customer, active, expires_at FROM shop_coupons WHERE code=$1 AND active AND phone_norm IS NULL LIMIT 1`, [cfg.firstCode]);
    let loyalty = null; try { loyalty = loyaltyCfgOf(settings); } catch { loyalty = null; }
    const data = { settings, now, open, bundles: bs, policy, first: fr && fr[0] ? fr[0] : null, loyalty, offers };
    const safe = (fn) => { try { return fn() || null; } catch { return null; } };
    return c.json({ ok: true, at: now.toISOString(),
      hours: { known: Boolean(open), open: open ? open.open : null, closesAt: open && open.open && open.closesAt ? fmtTime(open.closesAt, "ar") : null, opens: open && !open.open ? safe(() => openingText(settings.hours, now, "ar")) : null,
        lines: safe(() => hoursLines(settings.hours, "ar")) || [], deliveryPaused: Boolean(open && open.svc?.delivery?.paused), pickupPaused: Boolean(open && open.svc?.pickup?.paused) },
      boxes: { known: bs.length > 0, tiers: boxTiers(bs).map((x) => ({ section: x.section, from: x.min, count: x.n })), packs: bs.filter((x) => !String(x.section || "").trim()).map((x) => ({ name: x.name, price: Number(x.price) })) },
      menu: { known: Boolean(menu), categories: menu ? menu.categories.length : 0, items: menu ? menu.items.length : 0, soldOut: menu ? menu.items.filter((i) => i.soldOut).map((i) => i.name) : [],
        hidden: (settings?.catalog?.hiddenIds || []).length, ageSeconds: menuCache.at ? Math.round((Date.now() - menuCache.at) / 1000) : null },
      first: safe(() => firstLine(cfg, "ar", data)), loyalty: safe(() => loyaltyLine(cfg, "ar", data)),
      delivery: { known: Boolean(policy), km: policy ? Number(policy.maxKm) || null : null, farKm: policy && policy.farZoneEnabled !== false ? Number(policy.farZoneMaxKm) || null : null, fees: policy ? feeLines(policy, "ar").split("\n").filter(Boolean) : [] },
      offers: { known: offers !== null, list: (offers || []).map((o) => ({ title: o.title, price: o.price, until: o.until, ends: endsSoon(o.until, now, "ar", cfg.offerEndWithinDays).trim() || null })) },
      contact: { phone: publicPhoneOf(cfg, settings) || null, maps: String(settings?.googlePlace?.mapsUrl || "") || null },
      faq: { answered: FAQ_KEYS.filter((k) => String(cfg.faq?.[k]?.ar || "").trim()), missing: FAQ_KEYS.filter((k) => !String(cfg.faq?.[k]?.ar || "").trim()) },
      caches: { menuSeconds: 300, boxesSeconds: 300, offersSeconds: 120, everythingElse: "read on every message" } });
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

  async function muteRoute(c) {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { /* الكل */ }
    const phone = normPh(b.phone);
    if (!/^5\d{8}$/.test(phone)) return c.json({ ok: false, error: "bad_phone", message: "اكتب جوال سعودي 05XXXXXXXX" }, 400);
    const cfg = botConfig((await getSettingsData()) || {});
    const r = await muteChat(phone, b.hours || cfg.manualMuteHours, b.by || (await actorOf(c)));
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
    const know = { menu: await menuIndex(settings, now), bundles: await bundles() };
    const cls = classify(ev, know);
    let data;
    try { data = await loadData({ settings, cfg, phone, orderNo: cls.entities?.orderNo || null, key: cls.key, now, know, arg: cls.arg }); }
    catch (e) { return c.json({ ok: true, classified: cls, decision: { act: "silent", reason: `data_failed:${e.message}` } }); }
    // المحاكاة = «لو الرد هيطلع دلوقتي»: من غير سكوت موظف، ومن غير انتظار الـ٣ دقايق. الافتراضي: أول رسالة في المحادثة (بسطر التعريف)؛
    // first:false ⇒ رسالة تانية في نفس المحادثة (من غير التعريف) — عشان يتشاف شكل الرد العادي.
    const simChat = b.first === false ? { last_disclosed_at: now.toISOString() } : {};
    data.chat = simChat;
    if (data.reorder) data.reorder.url = `${STORE}/c/preview0`;      // المحاكاة مابتعملش سلة
    const d = decide(ev, { cfg, now, chat: simChat, lastEchoAt: null, repliesLastHour: 0, lastSame: null, failedRecently: false, data, cls, afterWait: "unknown_wait" });
    return c.json({ ok: true, classified: { key: cls.key, intent: cls.rawIntent, lang: cls.lang, score: cls.score }, open: data.open ? data.open.open : null,
      decision: { act: d.act, reason: /^after_/.test(d.reason || "") ? null : d.reason, key: d.key, handoff: d.handoff || null, link: d.link || null },
      payloads: d.payloads || [], textFallback: d.fallback || [] });
  });

  /* إعادة تشغيل على الورق: الرسايل الواردة الحقيقية المخزّنة (wa_messages، direction=in) تعدّي على المصنّف الحالي ونشوف
     كان هيرد بإيه — قبل ما نشغّل على العملاء. قراءة بس: لا إرسال، لا سجل، لا حالة، ولا موديل (القواعد بس).
     كل رسالة لوحدها («أول رسالة»): من غير سكوت موظف ولا انتظار. الجوال بيتعرض آخر ٤ أرقام بس. */
  app.get("/api/cms/wabot/replay", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    await ready;
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 200));
    const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 60));
    const settings = (await getSettingsData()) || {};
    const cfg = { ...botConfig(settings), mode: "dry", optin: { enabled: false, askAfterHours: 720 } };
    const now = clock();
    const know = { menu: await menuIndex(settings, now), bundles: await bundles() };
    const msgs = (await q(`SELECT wamid, phone_norm, body, msg_type, created_at FROM wa_messages
                            WHERE direction='in' AND created_at > NOW() - make_interval(days => $1::int) AND COALESCE(body,'') <> ''
                            ORDER BY created_at DESC LIMIT $2`, [days, limit])) || [];
    const rows = [], tally = {};
    for (const m of msgs) {
      const ev = { phone: "500000000", text: String(m.body || ""), type: m.msg_type || "text", interactiveId: null, referral: null, at: now.toISOString(), intent: null };
      const cls = classify(ev, know);
      let out = { act: "silent", reason: "ignored_type", key: cls.key };
      if (cls.key) {
        let data;
        try { data = await loadData({ settings, cfg, phone: "500000000", orderNo: null, key: cls.key, now, know, arg: cls.arg }); data.chat = { last_disclosed_at: now.toISOString() }; if (data.reorder) data.reorder.url = `${STORE}/c/preview0`; out = decide(ev, { cfg, now, chat: data.chat, lastEchoAt: null, repliesLastHour: 0, lastSame: null, failedRecently: false, data, cls, afterWait: "unknown_wait" }); }
        catch (e) { out = { act: "silent", reason: `data_failed:${e.message}`, key: cls.key }; }
      }
      const key = out.key || cls.key || "—";
      tally[key] = (tally[key] || 0) + 1;
      const first = out.payloads && out.payloads[0];
      rows.push({ at: m.created_at, phone: `…${String(m.phone_norm || "").slice(-4)}`, text: String(m.body || "").slice(0, 200), type: m.msg_type || "text", intent: cls.rawIntent, key,
        act: out.act, reason: /^after_/.test(out.reason || "") ? null : (out.reason || null), handoff: out.handoff ? out.handoff[0] : null,
        would: first ? String(first.text?.body || first.interactive?.body?.text || "").slice(0, 400) : null, messages: out.payloads ? out.payloads.length : 0 });
    }
    return c.json({ ok: true, days, count: rows.length, menuItems: know.menu ? know.menu.items.length : 0, tally, rows });
  });

  /* «نفس طلبي الأخير»: تشخيص للمالك (قراءة بس). من غير phone ⇒ أرقام التغطية (كام طلب له لقطة سلة تنفع). مع phone ⇒ اللي العميل ده
     هيشوفه لو ضغط دلوقتي (الخطة من غير ما تتعمل سلة). */
  app.get("/api/cms/wabot/reorder-check", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const settings = (await getSettingsData()) || {};
    const cfg = botConfig(settings);
    const out = { ok: true, enabled: cfg.reorderEnabled, maxDays: cfg.reorderMaxDays, coverage: typeof botCarts.coverage === "function" ? await botCarts.coverage(Number(c.req.query("days")) || 30) : null };
    const ph = String(c.req.query("phone") || "").replace(/\D/g, "").replace(/^(00966|966|0)/, "");
    if (/^5\d{8}$/.test(ph)) {
      const snaps = await botCarts.lastOrderCarts(ph, cfg.reorderMaxDays, { limit: cfg.reorderLookback, minTotal: cfg.reorderMinTotal });
      const now = clock(), menu = await menuIndex(settings, now), bs = await bundles();
      const tried = snaps.map((snap) => { const plan = reorderPlan(snap, { menu, bundles: bs && bs.length ? bs : null }); return { fromOrder: snap.orderNo, day: orderDay(snap.at, "ar"), latest: snap.latest, ok: plan.ok, why: plan.why || null, lines: plan.lines, removed: plan.removed, repriced: plan.repriced, review: plan.review }; });
      const pick = tried.find((t) => t.ok) || null;
      out.customer = { hasSnapshot: snaps.length > 0, candidates: snaps.length, fromOrder: pick ? pick.fromOrder : null, plan: pick, tried: tried.map((t) => ({ fromOrder: t.fromOrder, day: t.day, ok: t.ok, why: t.why })) };
    }
    return c.json(out);
  });

  /* ── مساعد الطلبات: القلب (الشريحة ١) ─────────────────────────────────────────
     الأدوات بتتركّب هنا على مصادر النظام الحيّة، **من غير أي موديل ومن غير أي إرسال ومن غير أي تغيير في ردود البوت**.
     المسار ده للمالك بس وللتجربة: ينده أداة واحدة ويرجّع نتيجتها زي ما الموديل هيشوفها. بنّاء السلة هنا معاينة دايماً (مابيعملش رابط). */
  const ax = deps.assist || null;
  const assist = ax ? makeAssistTools({
    pool, now: clock,
    menuIndex: async () => menuIndex((await getSettingsData()) || {}, clock()),
    boxes: async () => bundles(),
    expandBundle: ax.expandBundle,
    modifiers: { catalogItems: async () => { const r = await ax.modifiersCatalog(); return r && r.cfg && r.cfg.enabled === false ? {} : (r && r.catalog) || null; }, resolve: ax.modifiersResolve },
    quote: ax.quote, buildProfile: ax.buildProfile,
    /* حقايق الأصناف للمساعد: نفس المطابقة بتاعة البوت، وبترجّع «فيه / مافيهوش / يتشال» بس. مقفولة من اللوحة أو مش مؤكدة أو حساسية شديدة ⇒ null ⇒ موظف. */
    dishFact: async ({ id, ask }) => { if (!botConfig((await getSettingsData()) || {}).dishFactsEnabled) return null; const f = lookupFact(id, ask); return f.status === "present_removable" ? { contains: true, removable: true } : f.status === "present_fixed" ? { contains: true, removable: false } : f.status === "not_found" ? { contains: false } : null; },
    offers: async () => liveOffers((await getSettingsData()) || {}, clock()),
    settings: async () => (await getSettingsData()) || {},
    openState: async () => { const st = (await getSettingsData()) || {}; if (!st.hours) return null; const now = clock(), o = openState(st, now);
      let opens = null; try { opens = o.open ? null : openingText(st.hours, now, "ar"); } catch { opens = null; }
      return { open: o.open, closesText: o.closesAt ? fmtTime(o.closesAt, "ar") : null, opensText: opens, deliveryPaused: Boolean(o.open && o.svc && o.svc.delivery && o.svc.delivery.paused) }; },
    lastLocation: async (ph) => { const r = await q("SELECT last_loc FROM wa_bot_chats WHERE phone_norm=$1", [ph]); const l = r && r[0] ? r[0].last_loc : null; return locFresh(l, clock()) ? l : null; },      // موقع أقدم من ٢٤ ساعة مايتحسبش
    tune: async () => botConfig((await getSettingsData()) || {}).assist,
    dishNote: async (id) => { const ar = factNote(id, "ar"), en = factNote(id, "en"); return ar ? { ar, en: en || ar } : null; },
    botCarts,
  }) : null;
  const ASSIST_TRY = ["search_menu", "get_item", "get_box", "list_boxes", "check_availability", "quote_delivery", "get_offers", "get_hours", "order_status", "customer_profile", "build_cart", "top_sellers", "suggest"];
  app.post("/api/cms/wabot/assist/try", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    if (!assist) return c.json({ ok: false, error: "assist_not_wired" }, 503);
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const tool = String(b.tool || ""), args = b.args && typeof b.args === "object" ? b.args : {};
    if (!ASSIST_TRY.includes(tool)) return c.json({ ok: false, error: "unknown_tool", tools: ASSIST_TRY }, 400);
    const ph = String(b.phone || "").replace(/\D/g, "").replace(/^(00966|966|0)/, "");
    await ready;
    const t0 = Date.now();
    let result;
    try {
      if (tool === "build_cart") result = await assist.build_cart(ph, args, { save: false });
      else if (tool === "suggest") { const cart = await assist.build_cart(ph, args.cart || {}, { save: false }); result = { cart, ...(await assist.suggest(ph, { cart, declined: args.declined || [] })) }; }
      else if (tool === "top_sellers" || tool === "list_boxes" || tool === "get_hours") result = await assist[tool]();
      else result = await assist[tool](ph, args);
    } catch (e) { return c.json({ ok: false, error: "tool_threw", message: e.message }, 500); }
    const out = { ok: true, tool, ms: Date.now() - t0, result };
    if (tool === "customer_profile" && result && result.profile) out.told_to_customer = profileSummaryAr(result.profile);
    if (typeof b.reply === "string") out.validation = validateReply(b.reply, { facts: [result], customerText: String(b.customerText || ""), know: { menu: await menuIndex((await getSettingsData()) || {}, clock()), boxes: (await bundles()) || [] } });
    return c.json(out);
  });

  /* ── مساعد الطلبات: مسارات المالك (قراءة) ─────────────────────────────────────
     chats  = قايمة المحادثات (آخر دور، عدد الأدوار، التكلفة). turns = أدوار محادثة واحدة بكل تفاصيلها: نص العميل بعد الإخفاء (زي ما اتبعت للمزوّد)،
     نداءات الأدوات بمدخلاتها ونتايجها، حكم المراجِع، الرد النهائي، الموديل، التوكنز، التكلفة، الزمن. stats = البيع الإضافي (اتعرض/اتقبل/اترفض بالنوع)،
     وإيراد الطلبات اللي جت من سلة المساعد واللي سلتها فيها اقتراح اتقبل، والسرعة p50/p90، وأسباب الرجوع للقواعد. */
  app.get("/api/cms/wabot/assist/chats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    await ready;
    const rows = await assistStore.chats({ days: Number(c.req.query("days")) || 7, limit: Number(c.req.query("limit")) || 100 });
    return c.json({ ok: true, rows: rows.map((r) => ({ ...r, phone: `0${r.phone_norm}` })) });
  });
  app.get("/api/cms/wabot/assist/turns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    await ready;
    const ph = String(c.req.query("phone") || "").replace(/\D/g, "").replace(/^(00966|966|0)/, ""), hash = String(c.req.query("hash") || "");
    const before = Number(c.req.query("before")) || null;
    const rows = await assistStore.turns({ phone: /^5\d{8}$/.test(ph) ? ph : null, hash: /^[0-9a-f]{16}$/.test(hash) ? hash : null, limit: Number(c.req.query("limit")) || 100, before });
    return c.json({ ok: true, rows });
  });
  /* تجربة المساعد على الورق (المالك بس، ولرقم من قايمة التجربة): دور حقيقي بالموديل وبالبيانات الحيّة — **من غير أي إرسال ومن غير رابط سلة حقيقي**،
     وبيشتغل حتى والوضع «مقفول» عشان يتجرّب قبل الفتح. بيتحسب على سقف المساعد وبيتسجّل في سجل الأدوار (handled_by = simulate).
     reset:true = محادثة جديدة. الجلسة في الذاكرة بس (بتروح مع إعادة التشغيل) ومالهاش علاقة بمحادثة الرقم الحقيقية. */
  const simSessions = new Map();
  app.post("/api/cms/wabot/assist/simulate", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    if (!assist) return c.json({ ok: false, error: "assist_not_wired" }, 503);
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    await ready;
    const settings = (await getSettingsData()) || {};
    const cfg = botConfig(settings), acfg = cfg.assist, now = clock();
    const phone = String(b.phone || "").replace(/\D/g, "").replace(/^(00966|966|0)/, "");
    if (!cfg.testPhones.includes(phone)) return c.json({ ok: false, error: "not_in_allow_list", message: "الرقم مش في قايمة أرقام التجربة" }, 403);
    const text = String(b.text || "").trim();
    if (!text) return c.json({ ok: false, error: "text_required" }, 400);
    const sc0 = staffConfig(settings);
    const stop = await aicost.gate({ purpose: "assistant", budget: { budgetMonthSar: acfg.budgetMonthSar, budgetDaySar: acfg.budgetDaySar }, phones: cfg.llm.alertPhones.length ? cfg.llm.alertPhones : (cfg.alertPhones.length ? cfg.alertPhones : sc0.alertPhones), lang: sc0.lang });
    if (stop) return c.json({ ok: false, error: stop, message: "سقف المساعد اتوصل له" });
    const know = { menu: await menuIndex(settings, now), bundles: await bundles() };
    const ev = { phone, text, type: "text", interactiveId: null, at: now.toISOString() };
    const cls = classify(ev, know), lang = cls.lang === "en" ? "en" : "ar";
    const prev = b.reset === true ? null : simSessions.get(phone);
    let session = prev && now.getTime() - prev.at < acfg.sessionMin * 60_000 ? prev.session : null;
    const fresh = !session; if (fresh) session = newSession(now);
    const owns = assistEligible({ acfg: { ...acfg, mode: "test" }, cfg: { ...cfg, mode: cfg.mode === "live" ? "live" : "test" }, phone, ev, cls, d: cls.key === "unknown" ? { act: "wait", waitKind: "unknown_wait" } : cls.key === "ack" || cls.key === "nack" ? { act: "silent", reason: "ack" } : { act: "reply", key: cls.key }, sessionActive: !fresh, handoverOpen: false });
    const cx = await assistContext({ fresh, phone, cfg, lang, chat: await chatOf(phone), know, data: {}, now, cls });
    const dry = { ...assist, build_cart: async (ph, input, o = {}) => { const r = await assist.build_cart(ph, input, { save: false }); return o.save === false || !r || !r.ok ? r : { ...r, saved: true, link: `${STORE}/c/preview0`, code: "preview0" }; } };
    const r = await makeAssistLoop({ ...assistDeps(cfg, settings, null), tools: dry }).runTurn({ phone, text, lang, session, acfg, context: cx.context, profile: cx.profile });
    if (r.ok) simSessions.set(phone, { session: r.session, at: now.getTime() });
    const tr = r.trace;
    await assistStore.addTurn({ phone, sessionId: session.id, handledBy: "simulate", outcome: r.ok ? (r.handover ? `handover:${r.handover.reason}` : "sent") : `fallback:${r.reason}`, masked: tr.sent, text: r.ok ? r.text : null, lang, trace: tr, handover: r.ok && r.handover ? r.handover.reason : null });
    return c.json({ ok: r.ok, classified: cls.key, wouldAnswer: owns.run ? "assistant" : `rules (${owns.why})`, reply: r.ok ? r.text : null, cart: r.ok && r.cart ? { subtotal: r.cart.subtotal, option: r.cart.option, lines: r.cart.lines } : null,
      handover: r.ok ? r.handover : null, reason: r.ok ? null : r.reason, reorderOffered: Boolean(fresh && cx.reorder),
      trace: { model: tr.model, tier: tr.tier, escalated: Boolean(tr.escalated), ms: tr.ms, costSar: Math.round(tr.costSar * 1e6) / 1e6, calls: tr.calls, tools: tr.tools, verdicts: tr.verdicts, suggestions: tr.suggestions, sentToModel: tr.sent } });
  });  app.get("/api/cms/wabot/assist/stats", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const cfg = botConfig((await getSettingsData()) || {});
    const followups = (await q(`SELECT status, COALESCE(reason,'sent') AS reason, count(*)::int AS n FROM wa_bot_jobs WHERE kind='assist_followup' AND created_at > NOW() - make_interval(days => $1::int) GROUP BY 1,2 ORDER BY 3 DESC`, [Math.min(90, Math.max(1, Number(c.req.query("days")) || 7))])) || [];
    return c.json({ ok: true, mode: cfg.assist.mode, botMode: cfg.mode, testPhones: cfg.testPhones.length, promptVersion: PROMPT_HASH, provider: providerInfo(), models: { strong: cfg.assist.model, simple: cfg.assist.modelSimple, routing: cfg.assist.routing },
      storeReady: (await q("SELECT 1 FROM wa_assist_turns LIMIT 1", [])) !== null && (await q("SELECT 1 FROM wa_assist_suggestions LIMIT 1", [])) !== null && (await q("SELECT 1 FROM wa_assist_chats LIMIT 1", [])) !== null,
      ...(await assistStore.stats(Number(c.req.query("days")) || 7)), followups });
  });
  /* تقرير الإعلانات (قراءة بس): لكل إعلان — كام محادثة فتحها، كام واحد منهم اتجهّزت له سلة (واتفتحت)، وكام طلب مدفوع من الموقع ومبلغه.
     «طلب من الإعلان» = طلب مدفوع من نفس الرقم خلال adWindowHours من أول رسالته من الإعلان (نفس مدة «المحادثة محسوبة على الإعلان»). أرقام التجربة برّه العدّ. */
  app.get("/api/cms/wabot/ads", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const cfg = botConfig((await getSettingsData()) || {});
    const days = Math.min(180, Math.max(1, Math.round(Number(c.req.query("days")) || 30)));
    const win = Math.max(1, Math.ceil(cfg.adWindowHours));
    const rows = await q(
      `SELECT a.ad_id, max(a.headline) AS headline, count(*)::int AS chats, COALESCE(sum(a.clicks),0)::int AS clicks, min(a.first_at) AS first_at, max(a.last_at) AS last_at,
              count(*) FILTER (WHERE cr.n > 0)::int AS carts, count(*) FILTER (WHERE cr.opened > 0)::int AS carts_opened,
              count(*) FILTER (WHERE od.n > 0)::int AS buyers, COALESCE(sum(od.n),0)::int AS orders, COALESCE(sum(od.total),0)::float AS revenue
         FROM wa_ad_chats a
         LEFT JOIN LATERAL (SELECT count(*)::int AS n, count(*) FILTER (WHERE k.opens > 0)::int AS opened FROM wa_bot_carts k
                             WHERE k.phone_norm = a.phone_norm AND k.created_at >= a.first_at AND k.created_at < a.first_at + make_interval(hours => $2::int)) cr ON TRUE
         LEFT JOIN LATERAL (SELECT count(*)::int AS n, COALESCE(sum(o.total),0) AS total FROM shop_orders o
                             WHERE o.phone_norm = a.phone_norm AND NOT COALESCE(o.is_test,false)
                               AND o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')
                               AND o.created_at >= a.first_at AND o.created_at < a.first_at + make_interval(hours => $2::int)) od ON TRUE
        WHERE a.first_at > NOW() - make_interval(days => $1::int) AND a.phone_norm <> ALL($3::text[])
        GROUP BY a.ad_id ORDER BY count(*) DESC, a.ad_id LIMIT 200`, [days, win, cfg.testPhones]);
    if (rows === null) return c.json({ ok: false, error: "unavailable" }, 503);
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const ads = rows.map((r) => ({ adId: r.ad_id || null, headline: r.headline || null, link: (r.ad_id && cfg.links.adMap[String(r.ad_id)]) || cfg.links.ads, mapped: Boolean(r.ad_id && cfg.links.adMap[String(r.ad_id)]),
      chats: r.chats, clicks: r.clicks, carts: r.carts, cartsOpened: r.carts_opened, buyers: r.buyers, orders: r.orders, revenue: r2(r.revenue),
      firstAt: r.first_at ? new Date(r.first_at).toISOString() : null, lastAt: r.last_at ? new Date(r.last_at).toISOString() : null }));
    const sum = (k) => ads.reduce((s, a) => s + (Number(a[k]) || 0), 0);
    return c.json({ ok: true, days, windowHours: win, since: "2026-10-12: محادثات الإعلانات بتتسجّل بالإعلان من تاريخ تشغيل الشريحة دي؛ اللي قبلها مالوش رقم إعلان محفوظ",
      totals: { ads: ads.length, chats: sum("chats"), carts: sum("carts"), cartsOpened: sum("cartsOpened"), buyers: sum("buyers"), orders: sum("orders"), revenue: r2(sum("revenue")) }, ads });
  });
  /* مخطط الإعدادات للّوحة: كل إعداد بنوعه وحدوده وافتراضيه وقيمته واسمه وشرحه بالعربي (قراءة بس). */
  app.get("/api/cms/wabot/schema", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = botConfig((await getSettingsData()) || {});
    return c.json({ ok: true, groups: SCHEMA_GROUPS, settings: schemaFor(cfg), texts: textsMeta(), faq: FAQ_KEYS.map((k) => ({ key: k, ...FAQ_DEFS[k], ar: cfg.faq?.[k]?.ar || "", en: cfg.faq?.[k]?.en || "" })) });
  });
  /* سجل تعديلات الإعدادات: مين، إمتى، وإيه اللي اتغيّر (من ← إلى). */
  app.get("/api/cms/wabot/config-log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    await ready;
    return c.json({ ok: true, rows: (await q("SELECT id, at, who, changes FROM wa_bot_config_log ORDER BY id DESC LIMIT $1", [Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50))])) || [] });
  });
  /* تنقيب الأسئلة: أكتر النوايا، وأكتر الأسئلة اللي اتحوّلت لموظف أو مااتفهمتش مجمّعة بالتشابه بأمثلتها — عشان تتحوّل لإجابات أو فروع. */
  app.get("/api/cms/wabot/faq-mining", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 30));
    const rows = (await q(`SELECT text, reply_key AS key, handoff, phone_norm AS phone, detail FROM wa_bot_log WHERE at > NOW() - make_interval(days => $1::int) AND text IS NOT NULL AND text <> '' ORDER BY id DESC LIMIT 5000`, [days])) || [];
    const byKey = {};
    for (const r of rows) byKey[r.key || "-"] = (byKey[r.key || "-"] || 0) + 1;
    const hard = rows.filter((r) => r.key === "unknown" || r.key === "staff" || r.key === "data_missing" || ["needs_staff", "not_understood_twice"].includes(r.handoff));
    const faqGaps = {};
    for (const r of rows) { const m = /^faq:(\w+)/.exec(String(r.detail || "")); if (m) faqGaps[m[1]] = (faqGaps[m[1]] || 0) + 1; }
    return c.json({ ok: true, days, messages: rows.length, intents: Object.entries(byKey).map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
      unanswered: { messages: hard.length, groups: mineQuestions(hard, { minCount: Number(c.req.query("min")) || 2 }), singles: mineQuestions(hard, { minCount: 1, max: 200 }).filter((g) => g.count === 1).slice(0, 40).map((g) => g.examples[0]) },
      faqWaiting: Object.entries(faqGaps).map(([key, n]) => ({ key, q: FAQ_DEFS[key]?.q || key, n })).sort((a, b) => b.n - a.n) });
  });

  /* كارت التكلفة: الذكاء (اليوم/٧ أيام/الشهر، لكل محادثة ولكل رسالة، نسبة الرسايل اللي احتاجت الموديل، توقّع الشهر، السقف)
     + تكلفة واتساب نفسها (الردود الحرة مقابل المجاني، والقوالب بالفئة بسعر البطاقة المخزّنة). قراءة بس. */
  app.get("/api/cms/wabot/cost", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const cfg = botConfig((await getSettingsData()) || {});
    const budget = { budgetMonthSar: cfg.llm.budgetMonthSar, budgetDaySar: cfg.llm.budgetDaySar };
    const [ai, wside, asst] = await Promise.all([aicost.summary({ purpose: "classify", budget, prices: cfg.llm.prices }), aicost.waSide({ freeReplies: cfg.freeRepliesPerMonth, replyRateSar: cfg.replyRateSar, rates: cfg.waRates }),
      aicost.summary({ purpose: "assistant", budget: { budgetMonthSar: cfg.assist.budgetMonthSar, budgetDaySar: cfg.assist.budgetDaySar }, prices: cfg.llm.prices })]);
    /* assistant = نفس شكل ai بس لمساعد الطلبات (غرض «assistant»، سقفه 10/100 لوحده). ai فضل زي ما هو («الفهم بالذكاء»). */
    return c.json({ ok: true, enabled: cfg.llm.enabled, mode: cfg.mode, model: cfg.llm.model, provider: providerInfo(), ai, wa: wside,
      assistant: { mode: cfg.assist.mode, model: cfg.assist.model, modelSimple: cfg.assist.modelSimple, routing: cfg.assist.routing, summary: asst } });
  });
  /* سجل نداءات الموديل للمراجعة: إيه اللي اتبعت بالظبط (بعد الإخفاء)، التوكنز، التكلفة، النتيجة. المالك بس. */
  app.get("/api/cms/wabot/ai-calls", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    await ready;
    return c.json({ ok: true, rows: await aicost.calls({ limit: Number(c.req.query("limit")) || 100 }) });
  });

  /* إثباتات الموافقة على تحديثات الطلب (من سؤال البوت) */
  app.get("/api/cms/wabot/optins", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const rows = (await q("SELECT phone_norm, kind, answer, wording, lang, asked_at, at, source FROM wa_optin_proofs ORDER BY at DESC LIMIT 200", [])) || [];
    const tot = (await q("SELECT count(*) FILTER (WHERE answer='yes')::int AS yes, count(*) FILTER (WHERE answer='no')::int AS no FROM wa_optin_proofs", [])) || [{}];
    return c.json({ ok: true, totals: tot[0] || {}, rows });
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

  return { carts: botCarts, handle, ready, loadData, runDueJobs, muteChat, holdChat, unmuteChat, stop: () => { if (timer) clearInterval(timer); }, botConfig: async () => botConfig((await getSettingsData()) || {}) };
}
