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

import { matchIntent, detectLang, normalize, msgText, msgButtons, msgCta, msgList, LIMITS, openState, openingText, hoursLines, fmtTime, ORDER_NO_RE, indexMenu, closingToday, findItems } from "./wabot.js";
import { staffPhones, fitOneSms, staffConfig } from "./staffalerts.js";
import { loyaltyCfgOf } from "./loyalty.js";
import { MAPS_URL, ORDER_BUTTON, ORDER_BUTTON_EN } from "./watemplates.js";
import { CR_DEFAULTS, makeCampaignReply } from "./wacampreply.js";      // CR2 (١٦/١٠): «أبغى أطلب» على رسالة حملة ⇒ عرض الحملة نفسها
import { isOpenNow } from "./carts.js";
import { preorderCfg } from "./preorder.js";
import { makeBotCarts, reorderPlan, planSummary, orderDay, chatLocation } from "./wabotcart.js";
import { makeAssistTools, validateReply, profileSummaryAr, grillFamilies } from "./waassist.js";
import { lookupFact, groupsIn, SEVERE_RE, factsCoverage, pickDish, factNote, dishAllergens } from "./wadishfacts.js";
import { briefBlock, briefFromBody, briefForDashboard, menuDigest, BRIEF_SECTIONS, BRIEF_LIMITS } from "./wabrief.js";
import { buildMajedReport, businessDay } from "./wamajed.js";
import { makeAiCost, pricesOf, waRatesOf, pricesFromBody, waRatesFromBody, BUDGET_DEFAULTS } from "./waaicost.js";
import { dayMonth } from "./wasales.js";      // SB4
import { WA_POLICY_DEFAULTS, waPolicyCfg, FOLLOW_RE, reviewDecision, orderMessagesReport, FOLLOW_SQL, followLinkReport } from "./wapolicy.js";      // ١٤/١٠: زر «تابع طلبك» + سياسة النافذة المقفولة
import { providerInfo, maskText } from "./wabotllm.js";
import { kbTokens } from "./wakb.js";
import { teamConfig, staffRoleOf, nonCustomerKind } from "./wateam.js";
import { silentMap as listSilentMap, listsOf as phoneListsOf, whereIs as phoneListOf, reasonLabel as phoneReasonAr } from "./phonelists.js";      // SX1: قايمة «موظفين / فريق» (عمرها ما فيها المستثنين من الإعلانات)
import { ECHO, STAFF_ECHO_SQL } from "./waecho.js";
import { makeStt, STT_PROVIDERS } from "./wasttkey.js";
import { emitOrder } from "./order-events.js";      // MJ1 (١٧/١٠): ملاحظة العميل على طلبه الشغّال ⇒ سطر في سجل الطلب
const STT_LABEL = Object.fromEntries(STT_PROVIDERS.map((p) => [p.id, p.label]));
import { lookImage, makeTranscriber, voiceSeconds, transcriptUsable, IMAGE_MAX_BYTES, VOICE_MAX_BYTES } from "./waassistmedia.js";
import { ASSIST_CFG_DEFAULTS, ASSIST_SCHEMA, PROMPT_HASH, LIVE_AUDIENCES, assistConfig, assistFromBody, assistEligible, makeAssistLoop, makeAssistStore, makeModelCaller, billableUsage, newSession, noteRulesTurn, noteCampaignTurn, buildContext, hintOf, introSay, ensureIntro, hasIntro, heardContext, planReminder } from "./waassistrun.js";
import { declineMemory } from "./wapersonal.js";      // S1: ذاكرة الرفض بين المحادثات
import { FU_KIND, FU_GROUP, FU_GROUP_AR, FU_DEFAULTS, FU_NUMS, FU_BOOLS, FU_SCHEMA, FU_TAP_KEYS, FU_CLOSING_KEYS, FU_PROACTIVE_KEYS, FU_OTHER_JOBS, FU_SQL, FU_DDL,
  fuConfig, inFollowHours, nextFollowStart, bizDayStart, brakeVerdict, followTrigger, convFacts, pickLooked, offerPhrase } from "./wafollow.js";      // FU1 (١٥/١٠): متابعة اللي ردّ وماطلبش
import { WA_UPDATES_TEXTS, WA_UPDATES_CURRENT, recordWaUpdatesBot, recordWaMarketingBot, ensureWaConsentSchema } from "./waconsent.js";
import { JOURNEY_GROUP, JOURNEY_GROUP_AR, JOURNEY_DEFAULTS, JOURNEY_NUMS, JOURNEY_BOOLS, JOURNEY_SCHEMA, journeyCfg, holdUntil, deferDecision, PROACTIVE_KEYS, PROACTIVE_JOB_KINDS, PAID_CONFIRM_SQL } from "./wajourney.js";      // CJ1a (١٧/١٠): مفيش رسايل ورا بعض
import { COURIER_JOB_DEFAULTS, COURIER_JOB_SCHEMA, COURIER_JOB_SCHEMA_GROUP, courierJobConfig, courierJobFromBody } from "./courierwa-cfg.js";      // CW1
import { REVIEW_FLOW_DEFAULTS, REVIEW_FLOW_SCHEMA, REVIEW_SCHEMA_GROUP, REVIEW_TEXTS, reviewFlowConfig, reviewFlowFromBody, starOfListId, starOfQr, typedStar, reasonOfListId, reviewsCfgOf,
  starsAskReply, starsSubject, starReply, applyStar, applyReason, captureLowComment, pendingStars, markGoogleSent, reviewCtaOk, reviewsDaily, WEB_KINDS, VISIT_KINDS } from "./wareviews.js";      // RV1: النجوم جوّه واتساب

export const STORE = "https://freshcuts.sa";
export const UNSUPPORTED_OPENER_BODY = "[فتح المحادثة برسالة واتساب مابيعرضهاش — غالباً ضغطة «راسلنا» من إعلان]";
export const MODES = ["off", "dry", "test", "live"];

export const DEFAULTS = Object.freeze({
  mode: "off",
  testPhones: [],              // 5XXXXXXXX — من اللوحة فقط
  openerHours: 12,             // EX6: رسالة نوعها مش مدعوم من رقم مابعتناش له حاجة في الساعات دي = بداية محادثة ⇒ تاخد الترحيب (مش سكوت)
  reviewWhatsApp: true,        // SB2: طلب التقييم بعد التوصيل على واتساب (رسالة حرة بزرّين جوّه النافذة، وإلا القالب المعتمد fc_review_request) بدل الـSMS؛ الـSMS احتياطي بس
  /* SB4 — نوافذ الـ٢٤ ساعة (عمر ١٤/١٠: «حاول نفتح مع العملاء نوافذ ٢٤ ساعة باي طريقة ذكية… من غير ما نضايق العميل… وتوفر علينا») */
  courierContact: true,        // SB5: رسالة «طلبك مع المندوب» فيها اسمه وزر «راسل المندوب» (رسالة حرة جوّه النافذة — شغّال من غير اعتماد)
  courierTemplate: false,      // SB5: القالب الجديد fc_order_on_the_way_courier بدل القديم بره النافذة — يتفتح بعد ما ميتا تعتمده
  /* ١٤/١٠ — «مانبعتش قالب بفلوس لكل مرحلة» (wapolicy.js) */
  followLink: WA_POLICY_DEFAULTS.followLink,                   // زر «📲 تابع طلبك على واتساب» في صفحة الشكر/التتبع ⇒ «تابع طلبي W…» ⇒ البوت يرد بالحالة والنافذة تتفتح
  followNumber: WA_POLICY_DEFAULTS.followNumber,               // الرقم اللي الزر بيفتحه
  followBanner: WA_POLICY_DEFAULTS.followBanner,               // TRK6: بانر «تابع طلبك على واتساب» في المتجر بعد الطلب
  followBannerSkipHours: WA_POLICY_DEFAULTS.followBannerSkipHours, // TRK6: …مابيظهرش لو العميل كاتب لنا من أقل من كده
  closedPolicy: WA_POLICY_DEFAULTS.closedPolicy,               // النافذة مقفولة ⇒ القواعد اللي تحت
  closedSkipPreparing: WA_POLICY_DEFAULTS.closedSkipPreparing, // …«بنجهّز» مابتطلعش قالب
  mergeDeliveredReview: WA_POLICY_DEFAULTS.mergeDeliveredReview, // …التوصيل بزرّين التقييم ⇒ مفيش قالب تقييم تاني للطلب
  reviewPaidGapMin: WA_POLICY_DEFAULTS.reviewPaidGapMin,       // …ومفيش قالبين بفلوس لنفس الطلب في أقل من كده (التقييم بيتأجل)
  windowFreeUpdates: true,     // تحديث الطلب والنافذة مفتوحة (العميل كلّمنا آخر ٢٤ ساعة) ⇒ رسالة حرة ببلاش بنفس النص بدل القالب (whatsapp.js sendOrderUpdate)
  windowV2Stages: [],          // المراحل اللي نسختها v2 (بزر رد سريع يفتح نافذة) اتعتمدت عند ميتا ⇒ تتبعت بدل القديمة. «review» = طلب التقييم
  windowSell: true,            // ضغطة «تمام 👍» على التوصيل/التقييم ⇒ ردها فيه سطر الولاء (مرة في النافذة، جوّه نفس الرسالة)
  windowKeeper: true,          // قبل ما النافذة تقفل: رسالة حرة واحدة بس لو مفيدة فعلاً (طلب شغّال / مكافأة قربت تنتهي / سلة ماكمّلتش) — وإلا ولا حاجة
  windowKeeperHour: 20,        // …بعد الساعات دي من آخر رسالة للعميل (والنافذة لسه مفتوحة)
  windowKeeperDailyCap: 40,    // …أقصى عدد في اليوم كله
  windowKeeperWeekly: 1,       // …وأقصى عدد للعميل الواحد في ٧ أيام
  windowKeeperQuietStart: 2, windowKeeperQuietEnd: 11,      // …ومفيش في الساعات دي (الرياض)
  reviewReplyHours: 24,        // SB2: «تمام» / «عندي ملاحظة» مكتوبة (مش ضغطة) بتتحسب رد على رسالة التقييم لحد المدة دي
  courierJob: { ...COURIER_JOB_DEFAULTS },      // CW1 (عمر ١٦/١٠): أزرار المندوب الخارجي على واتساب (courierwa.js)
  reviewFlow: { ...REVIEW_FLOW_DEFAULTS },      // RV1 (عمر ١٥/١٠): النجوم جوّه واتساب + مواعيد كل نوع طلب + الحدود (wareviews.js)
  paidNoteEnabled: true,       // EX6: العميل دفع طلب بعد ما كلّم البوت/المساعد والنافذة مفتوحة ⇒ سطر تأكيد برقم الطلب
  leadFollowUpMin: 20,         // EX6: «متابعة المحادثة» — رسالة عميل ماخدتش رد مفيد (سكوت، بره النطاق، «ما فهمت») ومحدش رد ⇒ متابعة واحدة بعد الدقايق دي. صفر = مقفول. مرة في اليوم للمحادثة
  ...FU_DEFAULTS,              // FU1 (١٥/١٠): متابعة واحدة جوّه النافذة للي ردّ على حملة أو ضغط زر وماطلبش (wafollow.js)
  ...JOURNEY_DEFAULTS,         // CJ1a (١٧/١٠): مفيش رسايل ورا بعض — هدوء بعد آخر رسالة، تأكيد مرة واحدة، SMS المندوب مش مع واتساب، سقف رسايل الطلب (wajourney.js)
  autoInboundPatterns: true,   // EX5: رسالة واردة شكلها رد آلي من نشاط تجاري («شكراً لتواصلك»، «لسنا متوفرين»، thank you for contacting…) ⇒ auto_inbound: لا رد ولا مساعد ولا تحويل
  autoInboundSec: 15,          // EX5: نص ٢٥ حرف+ وصل خلال الثواني دي من **قالب** إحنا بعتناه للرقم ⇒ auto_inbound (محدش بيقرا ويكتب بالسرعة دي). صفر = مقفول
  loopGuardCount: 3,           // EX5: حارس الحلقات — العدد ده من الرسايل «السريعة» ورا بعض (كل واحدة وصلت خلال loopGuardFastSec من ردّنا، ونصها ٢٥ حرف+ أو مكرر) ⇒ كتم. صفر = مقفول
  loopGuardFastSec: 5, loopGuardSeconds: 120, loopGuardMuteHours: 12,
  autoEchoSkipCovered: false,  // EX4 (عمر ١٣/١٠): true = البوت مايردش على تحية/«كيف أطلب»/عروض لو رد التطبيق الآلي غطّاها (وبيستنى autoEchoMaxSec). الافتراضي: البوت يرد عادي وفوراً
  autoEchoMaxSec: 8,           // M1: صدى من موبايل المطعم خلال الثواني دي من رسالة العميل (ونصه ٢٥ حرف+) = رد آلي من تطبيق واتساب بزنس، مش موظف. ٠ = كل صدى موظف
  neverReplyPhones: [],        // M5: أرقام البوت مايردش عليها أبداً (مش عملاء: موظف، مورّد، مندوب، طالب وظيفة) — 5XXXXXXXX
  liveScope: "all",            // M5: في وضع live — ads = محادثات الإعلانات بس · new = الإعلانات + الأرقام الجديدة (مالهاش رسايل قبل liveSince) · all = الكل. أرقام التجربة دايماً جوّه
  liveSince: "",               // لحظة أول تشغيل للعملاء (ISO) — بتتسجّل لوحدها أول ما الوضع يبقى live وهي فاضية
  mediaFloodBuyerCount: 20,    // PS5: والمساعد بيشوف الصور: الكتم بس بعد العدد ده من الصور من غير ولا كلمة ومن غير محادثة طلب شغّالة (صور ورا بعض = طلب، مش سيل)
  mediaFloodCount: 5, mediaFloodMinutes: 2, mediaFloodMuteHours: 24,      // M5: الرقم ده من الصور/الملفات من غير نص خلال الدقايق دي ⇒ كتم بالساعات دي + تحويل واحد
  autoEchoTexts: [],           // نصوص ردود آلية يحددها المالك بالحرف: بتتحسب آلية لحد ٦٠ ثانية حتى لو قصيرة
  greetScope: "all",           // all | ads (تحية لمحادثات الإعلانات بس)
  humanPauseMin: 30,           // سكوت بعد **آخر** رد للموظف من الموبايل (في الدوام)
  staffWaitMin: 5,             // العميل كتب وقت السكوت: نستنى الموظف المدة دي وبعدها البوت يرد (نية معروفة بس)
  closedEchoPauseMin: 10,      // موظف رد والمطعم مقفول: سكوت قصير بس
  handoverRealertMin: 5,       // تحويل ومحدش من الفريق رد: تنبيه تاني بعد المدة دي (٠ = مفيش)
  handoverCustomerNoteMin: 10, // ولسه محدش رد: رسالة واحدة صادقة للعميل بعد المدة دي من التحويل (٠ = مفيش)
  manualMuteHours: 24,         // «كتم البوت في المحادثة دي» من الموظف — المدة الافتراضية
  handoffOpenHours: 24,        // التحويل لموظف «مفتوح» المدة دي: شكوى ⇒ معلومات بس، ومفيش تنبيه مكرر
  publicPhone: "",             // رقم المطعم في رسالة التعريف؛ فاضي = من سؤال «كيف أتواصل» في الأسئلة الشائعة
  faq: {},                     // { key: { ar, en } } — إجابات يوافق عليها المالك (FAQ_DEFS). الفاضي = «أحوّلك لموظف»، مش تخمين
  llm: { enabled: false, minConfidence: 0.75, timeoutMs: 4000, model: "claude-haiku-5-5", budgetMonthSar: BUDGET_DEFAULTS.budgetMonthSar, budgetDaySar: BUDGET_DEFAULTS.budgetDaySar, alertPhones: [], prices: null },   // تصنيف بس للرسالة الغير مفهومة — مايكتبش ولا كلمة للعميل
  optin: { enabled: false, askAfterHours: 720 },   // سؤال «نبلّغك بتحديثات طلباتك على واتساب؟» بعد رد حالة الطلب — مرة كل askAfterHours
  assist: { ...ASSIST_CFG_DEFAULTS },   // مساعد الطلبات (waassistrun.js): مقفول افتراضياً؛ «test» = أرقام التجربة بس. طول ما هو واقف لأي سبب، القواعد اللي بترد
  freeRepliesPerMonth: 1000,   // تسعيرة ميتا ١/١٠/٢٠٢٦: أول ١٠٠٠ رد حر في الشهر ببلاش…
  replyRateSar: 0.0401,        // …وبعدها بالريال للرد
  greetWindowHours: 24,        // تحية واحدة لكل عميل في المدة دي
  disclosureHours: 24,         // التعريف بالمساعد الآلي: مرة كل المدة دي
  disclosureMode: "persona",   // PS1 (طلب عمر ١٣/١٠: «مش مقدمة روبوت»): persona = المساعد بيعرّف نفسه باسمه مرة في أول المحادثة («معك … المساعد الرقمي لفريش كاتس») ومفيش سطر تحت الرسايل · classic = السطر القديم «معك المساعد الآلي … اكتب: موظف» + footerMode
  footerMode: "smart",         // (في وضع classic بس) always | smart | first — سطر «للرجوع… أو موظف» تحت الرسايل (طلب عمر ١٢/١٠: مش على كل رسالة)
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
  campaignCart: true,          // FD1 (١٤/١٠): «أبغى أطلب» على رسالة حملة «طبقك المفضل» ⇒ سلة جاهزة بالعرض اللي وصله بالظبط (بسعره وتوصيله الحين)
  campaignOfferHours: 72,      // …العرض المخزّن بيفضل يتقرا للضغطة/«نعم» لحد المدة دي من الإرسال
  ...CR_DEFAULTS,              // CR2 (١٦/١٠): campaignReply (مفتوح) + campaignReplyHours (72) — «أبغى أطلب» على رسالة حملة ⇒ عرضها هي برابطها، مش الرد العام
  campaignYesQuietMin: 60,     // FD1 مراجعة ٣: «نعم» المكتوبة مابتتحسبش موافقة على الحملة لو المحادثة كان فيها كلام في المدة دي قبل الرسالة (رد على سؤال تاني)
  maxAgeMinutes: 20,           // رسالة أقدم من كده (ويب هوك متأخر) مابيتردش عليها
  sameTextSeconds: 8,          // نفس النص من نفس العميل خلال الثواني دي = تكرار ويب هوك/ضغطة مرتين ⇒ مايتردّش عليه تاني. عميل بيكرر سؤاله بعدها بيترد عليه (١٢/١٠)
  /* حارس الحلقات (مش سبب لتحويل لموظف — عطل ١٢/١٠: ٨ ردود كانت بتقطع عميل بيتصفّح القائمة وتحوّله لموظف):
     رسايل مكتوبة ورا بعض ليها حد في الساعة، ضغطات القائمة/الأزرار ليها حد أوسع لوحدها، وحد قصير للدقيقة. عند الحد: سطر هادي مرة واحدة،
     من غير تحويل ولا تنبيه، والبوت يرجع لوحده لما المدة تعدّي. */
  maxRepliesPerHour: 40,       // ردود على رسايل **مكتوبة** لكل عميل في الساعة
  maxTapsPerHour: 150,         // ردود على ضغطات القائمة/الأزرار في الساعة (التصفّح مايتقطعش)
  maxRepliesPerMinute: 6,      // أي ردود في الدقيقة (حلقة سريعة)
  orderLookbackHours: 72,
  lateAfterMinutes: 70,        // «وين طلبي» على طلب نشط أقدم من كده ⇒ الحالة + تحويل
  /* MJ1 (١٧/١٠ — تقرير ماجد ١٦/١٠: ٣ عملاء عندهم طلب شغّال اتعاملوا كطلب جديد: عنوان للمندوب ×٢ و«زود الخبز») — الطلب الشغّال أولاً */
  activeOrderFirst: true,      // عميل عنده طلب شغّال وبعت موقع / عنوان / صورة / «زوّد-بدون-ملاحظة» ⇒ ملاحظة على الطلب ده (سجل الطلب + كارت البوابة + المندوب لو في الطريق) وتأكيد قصير — مش طلب جديد ولا بيع ولا مساعد
  activeOrderHours: 4,         // …«شغّال» = مدفوع / في نقطة البيع / في المطبخ / جاهز / مع المندوب خلال الساعات دي (مش متسلّم ولا مسترجع)
  activeOrderMergeSec: 120,    // …موقع + عنوان + صورة ورا بعض = تأكيد واحد للعميل خلال الثواني دي (الباقي بيتسجّل على الطلب من غير رسالة). صفر = تأكيد لكل رسالة
  handoverBurstSec: 60,        // MJ1 #٥: بعد تحويل شكوى/ملاحظة، أي صورة أو نص أو «عندي ملاحظة» خلال الثواني دي = نفس الشكوى: بتوصل للموظف في المحادثة من غير رسالة تانية من البوت ولا تنبيه تاني. صفر = مقفول
  interactive: true,           // أزرار/رابط بزر؛ false = نص عادي والرابط في آخره
  staffAlert: true,            // SMS للفريق عند التحويل (live؛ وفي test لو alertInTest)
  alertInTest: false,
  handoverAckNeedsReply: true, // «تم» في البورتال من غير أي رد للعميل مابتلغيش رسالة الاعتذار له (ولا تنبيهها). false = السلوك القديم: «تم» بتقفل كل حاجة
  alertPhones: [],             // فاضي = أرقام الإنذارات (settings.delivery.alertPhones)
  maxAlertsPerHour: 6,
  firstCode: "FIRST",
  links: { organic: "wab-boxes", ads: "wa-boxes", packs: "wab-packs", adMap: {}, channel: { url: "", enabled: false, everyDays: 30 } },   // adMap: { "<ad source_id>": "<slug>" } · packs = رابط رد «باقات التجمعات»
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
  greet: t("التحية (أول رسالة)", "حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.\n{paused}\n{closed}", "Welcome 👋 What would you like today? Type it or pick from the menu.\n{paused}\n{closed}", [], ["paused", "closed"], 300),
  greet_back: t("تحية عميل طلب قبل كده (بالاسم)", "هلا {name}، حيّاك الله 👋 وش تحب تطلب اليوم؟ اكتب لي أو اختر من القائمة.\n{paused}\n{closed}", "Welcome back {name} 👋 What would you like today? Type it or pick from the menu.\n{paused}\n{closed}", ["name"], ["paused", "closed"], 300),
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
  status_follow: t("رد زر «تابع طلبك» (تحت الحالة)", "✅ تم — سنرسل لك هنا كل تحديث على طلبك.", "✅ Done — we'll send every update on your order here."),
  status_no_open: t("سأل عن طلبه ومافيش طلب مفتوح على رقمه", "ما فيه طلب مفتوح على رقمك هذا الحين.\nتبي تطلب، أو أحوّلك لموظف؟", "There is no open order under this number right now.\nWould you like to order, or talk to a staff member?"),
  status_last_closed: t("سطر آخر طلب مقفول (تحت «ما فيه طلب مفتوح»)", "آخر طلب لك {order_no}: {status}", "Your last order {order_no}: {status}", ["order_no", "status"]),
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
  media_payment: t("صورة دفع أو إيصال (المساعد شافها) ⇒ موظف", "وصلتني صورة عن الدفع 🙏 حوّلتها لموظف يراجعها معك.\n{wait}", "I got your payment screenshot 🙏 I passed it to a staff member to check it with you.\n{wait}", [], ["wait"], 400),
  media_order: t("صورة طلب فيه مشكلة (المساعد شافها) ⇒ موظف", "نعتذر منك 🙏 وصلتني صورة الطلب وحوّلتها لموظف يتابعها معك.\n{wait}", "We're sorry 🙏 I got the photo of your order and passed it to a staff member.\n{wait}", [], ["wait"], 400),
  media_location: t("صورة موقع (المساعد شافها)", "وصلتني صورة موقع 📍 عشان أتأكد من التوصيل والرسوم لموقعك أرسل الموقع نفسه من واتساب: 📎 ثم «الموقع».", "I got a location screenshot 📍 To check delivery and the fee, please share the location itself from WhatsApp: 📎 then “Location”.", [], [], 400),
  media: t("صورة / صوت / ملف", "ما أقدر أفتح الصور والمقاطع الصوتية 🙏 حوّلت محادثتك لموظف.\n{wait}",
    "I can't open photos or voice notes 🙏 I've passed your chat to a staff member.\n{wait}", [], ["wait"]),
  unknown: t("غير مفهوم (أول مرة)", "المعذرة، ما وضح لي طلبك 🙏 اكتبه لي بكلمات ثانية أو اختر من الأزرار، وإذا تبي أحد من الفريق اكتب: موظف", "Sorry, I didn't quite get that 🙏 Say it another way or pick a button, and if you'd like someone from the team type: staff"),
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
  /* FD1 (١٤/١٠) — حملة «طبقك المفضل»: الرد على «أبغى أطلب» / «نعم». {offer} = نفس سطر الرسالة (العرض بسعره وسطر التوصيل) محسوب تاني الحين. */
  camp_order_body: t("حملة «طبقك المفضل»: رد «أبغى أطلب» (السلة جاهزة بالعرض)", "جهّزنا لك طلبك في السلة 🛒\n{offer}.\n{picks}\n{paused}\n{closed}\nراجع السلة وكمّل الدفع من الزر 👇 ولو تبي تغيّر شي اكتب لي هنا.",
    "Your order is ready in the cart 🛒\n{offer}.\n{picks}\n{paused}\n{closed}\nReview the cart and pay from the button 👇 If you'd like to change anything, write to me here.", ["offer"], ["picks", "paused", "closed"], 900),
  camp_picks: t("حملة «طبقك المفضل»: سطر اختيارات البوكس في السلة", "اخترنا لك في البوكس: {names}.", "In the box we picked: {names}.", ["names"], [], 300),
  camp_box_body: t("حملة «طبقك المفضل»: رد «أبغى أطلب» لبوكس من نوع أكله (يختار هو)", "{offer}.\n{paused}\n{closed}\nاختر اللي يعجبك في البوكس وكمّل طلبك من الزر 👇",
    "{offer}.\n{paused}\n{closed}\nPick what you like in the box and complete your order from the button 👇", ["offer"], ["paused", "closed"], 900),
  /* CR2 (١٦/١٠) — «أبغى أطلب» على رسالة أي حملة تانية: {offer} = اسم العرض + سطر السعر + سطر آخر يوم (من قيم الحملة نفسها).
     مراجعة ١٦/١٠: الرد مابيسألش سؤال «نعم/لا» («تبي نجهزه لك هنا؟» كانت بتجيب «نعم» = شكر ⇒ سكوت). «نعم / ايوه / ابغاه» بعده بتروح للمساعد وهو عارف العرض (noteCampaignTurn). */
  camp_reply_body: t("رد «أبغى أطلب» على رسالة حملة (العرض اللي وصله + رابط الحملة)", "أبشر 🌟 هذا العرض اللي وصلك:\n{offer}.\n{paused}\n{closed}\nاطلبه مباشرة من الزر 👇، أو اكتب لي وش تبي وأجهزه لك",
    "Sure 🌟 Here's the offer you received:\n{offer}.\n{paused}\n{closed}\nOrder it directly from the button 👇, or write what you'd like and I'll prepare it for you", ["offer"], ["paused", "closed"], 900),
  camp_reply_price: t("رد الحملة: سطر السعر", "بـ{price} ر.س", "for SAR {price}", ["price"], [], 80),
  camp_reply_until: t("رد الحملة: سطر آخر يوم", "والعرض لين {until}", "valid until {until}", ["until"], [], 160),
  /* مساعد الطلبات: المتابعة الواحدة بعد رابط السلة (نص ثابت + نفس الرابط بزر «كمّل طلبك») */
  assist_followup: t("مساعد الطلبات: متابعة بعد رابط السلة", "سلتك ما زالت جاهزة 🛒 تقدر تكمّل طلبك من الزر 👇\nوإذا تحتاج شي ثاني اكتب لي.", "Your cart is still ready 🛒 You can complete your order from the button 👇\nIf you need anything else, just write.", [], [], 300),
  /* PS3 — التذكير اللي العميل طلبه: بيفتح الكلام تاني باسم ماجد وبالصنف اللي كان بيسأل عنه (لو معروف ولسه متاح). مش رسالة تسويق: بتتبعت بس لعميل قال «فكّرني» وحدد الوقت. */
  assist_reminder: t("مساعد الطلبات: التذكير اللي العميل طلبه", "هلا 👋 معك {name}، المساعد الرقمي لفريش كاتس، وهذا تذكيرك مثل ما اتفقنا.\n{about}\nأجهّز لك طلبك الحين؟", "Hi 👋 This is {name}, Fresh Cuts' digital assistant, with the reminder you asked for.\n{about}\nShall I get your order ready now?", ["name"], ["about"], 400),
  assist_reminder_about: t("التذكير: سطر الصنف اللي كان بيسأل عنه", "كنت تفكّر في {dish}.", "You were looking at {dish}.", ["dish"], [], 200),
  /* PS4 — لحظة الرسوم: الحساب جاهز من النظام (كل {…} رقم محسوب: مفيش رقم مكتوب في النص). السطور بتتركّب بالترتيب: زي ما هو ← أقرب حد ← الاستلام. */
  fee_asis: t("لحظة الرسوم: طلبك + التوصيل", "طلبك {order} ر.س + توصيل {fee} = {total} ر.س.", "Your order SAR {order} + delivery {fee} = SAR {total}.", ["order", "fee", "total"], [], 200),
  fee_first: t("لحظة الرسوم: التوصيل المجاني بكود أول طلب", "وإذا وصل طلبك {from} ر.س، أول طلب توصيله مجاني بكود {code} = {from} ر.س.", "If your order reaches SAR {from}, your first delivery is free with code {code} = SAR {from}.", ["from", "code"], [], 200),
  fee_reward: t("لحظة الرسوم: التوصيل المجاني بكود المكافأة", "وإذا وصل طلبك {from} ر.س، توصيله مجاني بكود مكافأتك {code} = {from} ر.س.", "If your order reaches SAR {from}, delivery is free with your reward code {code} = SAR {from}.", ["from", "code"], [], 200),
  fee_same: t("لحظة الرسوم: نفس المبلغ", "نفس المبلغ، وأكل بزيادة {extra} ر.س.", "The same total, with SAR {extra} more food.", ["extra"], [], 200),
  fee_step: t("لحظة الرسوم: الدرجة الجاية", "وإذا زدت عليه {extra} ر.س يصير التوصيل {fee} ر.س، والإجمالي {total} ر.س.", "Add SAR {extra} and delivery becomes SAR {fee}, SAR {total} in total.", ["extra", "fee", "total"], [], 200),
  fee_step_free: t("لحظة الرسوم: الدرجة الجاية مجانية", "وإذا زدت عليه {extra} ر.س يصير التوصيل مجاني، والإجمالي {total} ر.س.", "Add SAR {extra} and delivery is free, SAR {total} in total.", ["extra", "total"], [], 200),
  first_lead: t("بعد الموقع: أول طلب توصيله مجاني", "أول طلب توصيل لك من موقعنا توصيله مجاني للطلبات من {from} ر.س بكود {code}.", "Your first delivery order on our website has free delivery on orders from SAR {from} with code {code}.", ["from", "code"], [], 250),
  fee_unlocated: t("لحظة الرسوم: من غير موقع", "الرسوم هذي حسب قيمة الطلب، وتتأكد لموقعك في موقعنا قبل الدفع.", "These fees go by the order total; the exact fee for your location shows on our website before payment.", [], [], 200),
  fee_pickup: t("لحظة الرسوم: الاستلام", "أو استلام من الفرع بدون رسوم توصيل = {order} ر.س.", "Or pickup from the branch with no delivery fee = SAR {order}.", ["order"], [], 200),
  btn_fee_reach: t("زر: أكمّل للحد", "أكمّلها {from} ر.س", "Make it SAR {from}", ["from"], [], LIMITS.btnTitle),
  btn_fee_pickup: t("زر: استلام من الفرع", "استلام من الفرع", "Pickup", [], [], LIMITS.btnTitle),
  cart_recap_head: t("ملخص السلة: العنوان", "🛒 سلتك ({mode}):", "🛒 Your cart ({mode}):", ["mode"], [], 100),
  cart_recap_line: t("ملخص السلة: سطر", "• {name} × {qty} = {total} ر.س", "• {name} × {qty} = SAR {total}", ["name", "qty", "total"], [], 300),
  cart_recap_note: t("ملخص السلة: ملاحظة السطر", "↳ ملاحظة للمطبخ: {note}", "↳ Kitchen note: {note}", ["note"], [], 300),
  cart_recap_total: t("ملخص السلة: المجموع", "المجموع: {total} ر.س", "Total: SAR {total}", ["total"], [], 100),
  cart_recap_close: t("ملخص السلة: القفلة", "راجع السلة، ولو كل شي تمام اضغط الزر وأكمل الدفع 👇", "Check the cart, and if it is all right tap the button to pay 👇", [], [], 200),
  /* SB1 — ملخص السلة: التوصيل والإجمالي (القيم من النظام وقت بناء السلة) */
  cart_recap_fee: t("ملخص السلة: رسوم التوصيل لموقعه", "التوصيل: {fee} ر.س", "Delivery: SAR {fee}", ["fee"], [], 100),
  cart_recap_fee_free: t("ملخص السلة: التوصيل مجاني بكود", "التوصيل: مجاني بكود {code} 🎁", "Delivery: free with code {code} 🎁", ["code"], [], 100),
  cart_recap_fee_zero: t("ملخص السلة: التوصيل مجاني (حد الطلب)", "التوصيل: مجاني 🎁", "Delivery: free 🎁", [], [], 100),
  cart_recap_fee_later: t("ملخص السلة: الرسوم تظهر قبل الدفع (من غير موقع)", "التوصيل: يظهر لموقعك قبل الدفع", "Delivery: shown for your location before payment", [], [], 120),
  cart_recap_pickup: t("ملخص السلة: استلام", "استلام من الفرع: بدون رسوم توصيل", "Pickup from the branch: no delivery fee", [], [], 120),
  cart_recap_grand: t("ملخص السلة: الإجمالي", "الإجمالي: {total} ر.س", "Total: SAR {total}", ["total"], [], 100),
  /* SB1 — «عقل البيع»: السطر المبادِر (مرة في المحادثة) والاقتراح الواحد — كل {…} رقم أو اسم من النظام */
  sb_first: t("عقل البيع: أول طلب توصيله مجاني", "🎁 أول طلب توصيل لك من موقعنا مجاني للطلبات من {from} ر.س بكود {code}.", "🎁 Your first delivery order on our website is free on orders from SAR {from} with code {code}.", ["from", "code"], [], 250),
  sb_reward: t("عقل البيع: عنده مكافأة مااستخدمهاش", "🎁 عندك مكافأة توصيل مجاني بكود {code} للطلبات من {from} ر.س، اكتبه في خانة الكود وقت الدفع.", "🎁 You have a free-delivery reward, code {code}, on orders from SAR {from}: enter it in the code box at checkout.", ["code", "from"], [], 250),
  sb_reward_until: t("عقل البيع: مكافأة مااستخدمهاش (بتاريخها)", "🎁 عندك مكافأة توصيل مجاني بكود {code} للطلبات من {from} ر.س، صالحة لين {until}. اكتبه في خانة الكود وقت الدفع.", "🎁 You have a free-delivery reward, code {code}, on orders from SAR {from}, valid until {until}: enter it in the code box at checkout.", ["code", "from", "until"], [], 250),
  sb_loyalty_one: t("عقل البيع: باقي طلب واحد على المكافأة", "⭐ باقي لك طلب واحد من الموقع وتاخذ توصيل مجاني على طلبك اللي بعده (للطلبات من {from} ر.س).", "⭐ One more order on our website and your next one gets free delivery (orders from SAR {from}).", ["from"], [], 250),
  sb_loyalty_left: t("عقل البيع: تقدّم الولاء", "⭐ كل {every} طلبات من الموقع لك توصيل مجاني، وباقي لك {left} على المكافأة.", "⭐ Every {every} orders on our website earn free delivery: {left} to go.", ["every", "left"], [], 250),
  sb_same: t("عقل البيع: نفس طلبك؟ (العميل الدايم)", "آخر طلب لك كان {items}. تبيه نفسه؟", "Your last order was {items}. Same again?", ["items"], [], 300),
  sb_tier: t("الاقتراح: الحد الجاي للرسوم", "لو أضفت {item} بـ {price} ر.س، ينزل التوصيل من {fee_now} إلى {fee_then} ر.س، والإجمالي {total_then} ر.س. أضيفه؟", "Add {item} for SAR {price} and delivery drops from SAR {fee_now} to SAR {fee_then}, SAR {total_then} in total. Add it?", ["item", "price", "fee_now", "fee_then", "total_then"], ["total_now", "code"], 300),
  sb_tier_free: t("الاقتراح: الحد الجاي = توصيل مجاني", "لو أضفت {item} بـ {price} ر.س، يصير التوصيل مجاني بدل {fee_now} ر.س، والإجمالي {total_then} ر.س. أضيفه؟", "Add {item} for SAR {price} and delivery is free instead of SAR {fee_now}, SAR {total_then} in total. Add it?", ["item", "price", "fee_now", "total_then"], ["fee_then", "total_now", "code"], 300),
  sb_tier_first: t("الاقتراح: يوصل حد أول طلب (توصيل مجاني بكود)", "لو أضفت {item} بـ {price} ر.س، يوصل طلبك {from} ر.س ويصير توصيله مجاني بكود {code}: الإجمالي {total_then} ر.س بدل {total_now} ر.س. أضيفه؟", "Add {item} for SAR {price}: your order reaches SAR {from} and delivery is free with code {code}, SAR {total_then} in total instead of SAR {total_now}. Add it?", ["item", "price", "from", "code", "total_then", "total_now"], ["fee_now", "fee_then"], 300),
  sb_box_saves: t("الاقتراح: بوكس فيه نفس الأصناف أرخص", "ونفس الأصناف تجي في {box} بـ {price} ر.س بدل {separate} ر.س. أحوّلها بوكس؟", "The same items come as {box} for SAR {price} instead of SAR {separate}. Switch to the box?", ["box", "price", "separate"], [], 300),
  sb_pair_box: t("الاقتراح: بوكس من نفس الطلب", "وبـ {price} ر.س يصير {box}. أحوّله بوكس؟", "For SAR {price} it becomes {box}. Make it a box?", ["box", "price"], [], 300),
  sb_add_item: t("الاقتراح: صنف واحد معاه", "تحب أضيف لك {item} بـ {price} ر.س؟", "Shall I add {item} for SAR {price}?", ["item", "price"], [], 300),
  sb_ask_mode: t("رد الكود بعد «لا شكراً» على الاقتراح", "تمام 👍 توصيل ولا استلام؟", "Sure 👍 Delivery or pickup?", [], [], 200),
  sb_added_mode: t("رد الكود بعد «أضفه ✅»", "تمام، أضفت {item} ✅ المجموع {total} ر.س.\nتوصيل ولا استلام؟", "Done, I added {item} ✅ Total SAR {total}.\nDelivery or pickup?", ["item", "total"], [], 300),
  /* S1 — البيع الشخصي (١٤/١٠): «زي العادة» من طلبات العميل نفسه، الأرز مع المشاوي بالوزن، مشروب لكل شخص، بوكس العيلة من غير مشروبات، الكومبو، والتوصيل المجاني بعد «أضفه».
     كل {…} اسم أو رقم من النظام (المنيو الحي، البوكسات، سلّم الرسوم)؛ «زي العادة» بيتقال بس لو العادة متحققة (الإعدادات: «العادة: …»). */
  sb_usual: t("الاقتراح: عادة العميل («زي العادة»)", "زي العادة، أضيف لك {item} بـ {price} ر.س؟", "As usual, shall I add {item} for SAR {price}?", ["item", "price"], [], 300),
  sb_usual_qty: t("الاقتراح: عادة العميل بكمية", "زي العادة، أضيف لكم {item} × {qty} بـ {total} ر.س؟", "As usual, shall I add {item} × {qty} for SAR {total}?", ["item", "qty", "total"], [], 300),
  sb_tier_usual: t("الاقتراح: عادته، وبها تنزل رسوم التوصيل", "زي العادة {item} بـ {price} ر.س، ومعه ينزل التوصيل من {fee_now} إلى {fee_then} ر.س. أضيفه؟", "{item} as usual for SAR {price}, and delivery drops from SAR {fee_now} to SAR {fee_then}. Add it?", ["item", "price", "fee_now", "fee_then"], ["total_now", "total_then", "code", "from"], 300),
  sb_tier_usual_free: t("الاقتراح: عادته، وبها يصير التوصيل مجاني", "زي العادة {item} بـ {price} ر.س، ومعه يصير التوصيل مجاني بدل {fee_now} ر.س، والإجمالي {total_then} ر.س. أضيفه؟", "{item} as usual for SAR {price}, and delivery becomes free instead of SAR {fee_now}, SAR {total_then} in total. Add it?", ["item", "price", "fee_now", "total_then"], ["fee_then", "total_now", "code", "from"], 300),
  sb_rice_weight: t("الاقتراح: الأرز مع المشاوي بالوزن", "الأرز ما يجي مع المشاوي بالوزن، أضيف لك {item} بـ {price} ر.س؟", "Rice doesn't come with grills by weight. Shall I add {item} for SAR {price}?", ["item", "price"], [], 300),
  sb_drinks_people: t("الاقتراح: مشروب لكل شخص", "أضيف لكم {item} × {qty} (واحد لكل شخص) بـ {total} ر.س؟", "Shall I add {item} × {qty} (one each) for SAR {total}?", ["item", "qty", "total"], [], 300),
  sb_box_drinks: t("الاقتراح: بوكس العيلة ما فيه مشروبات (عدد الأشخاص معروف)", "{box} ما فيه مشروبات، أضيف لكم {item} × {qty} بـ {total} ر.س؟", "{box} has no drinks. Shall I add {item} × {qty} for SAR {total}?", ["box", "item", "qty", "total"], [], 300),
  sb_drink_each: t("الاقتراح: بوكس العيلة ما فيه مشروبات (العدد مش معروف: سعر الواحد)", "{box} ما فيه مشروبات، و{item} الواحد بـ {price} ر.س. أضيف لكم؟", "{box} has no drinks; {item} is SAR {price} each. Shall I add some?", ["box", "item", "price"], [], 300),
  sb_combo: t("الاقتراح: الكومبو مع الكريب أو البرجر ({contents} = وصفه في المنيو)", "أضيف لك {item} ({contents}) بـ {price} ر.س؟", "Shall I add {item} for SAR {price}?", ["item", "price"], ["contents"], 300),
  sb_added_free: t("رد الكود بعد «أضفه ✅» والمجموع وصل التوصيل المجاني ({note} = سطر الكود لو لسه ماتقالش)", "تمام، أضفت {item} ✅ المجموع {total} ر.س، ولو توصيل يصير مجاني 🎁\n{note}\nتوصيل ولا استلام؟", "Done, I added {item} ✅ Total SAR {total}, and delivery would be free 🎁\n{note}\nDelivery or pickup?", ["item", "total"], ["note"], 600),
  sb_offers_head: t("العروض الحية: العنوان", "🔥 عروضنا الحين:", "🔥 Our offers now:", [], [], 100),
  sb_offer_line: t("العروض الحية: سطر", "• {name} — {price} ر.س", "• {name} — SAR {price}", ["name", "price"], [], 200),
  sb_offer_line_until: t("العروض الحية: سطر بتاريخ نهاية", "• {name} — {price} ر.س (لين {until})", "• {name} — SAR {price} (until {until})", ["name", "price", "until"], [], 200),
  sb_offers_more: t("العروض الحية: سطر «بوكسات تانية»", "📦 وعندنا {n} بوكسات ثانية — قل لي كم شخص أنتم وأرشّح لك الأنسب.", "📦 We have {n} more boxes — tell me how many of you and I'll suggest the best fit.", ["n"], [], 200),
  btn_sg_add: t("زر: أضف الاقتراح", "أضفه ✅", "Add it ✅", [], [], LIMITS.btnTitle),
  btn_sg_no: t("زر: لا شكراً (الاقتراح)", "لا شكراً", "No thanks", [], [], LIMITS.btnTitle),
  btn_confirm_yes: t("زر: أعتمد الاقتراح", "إيه، جهّزه ✅", "Yes, prepare it ✅", [], [], LIMITS.btnTitle),
  btn_confirm_no: t("زر: شي ثاني", "أبغى شي ثاني", "Something else", [], [], LIMITS.btnTitle),
  list_people_btn: t("قايمة: كام شخص (زر القايمة)", "اختر العدد", "Choose", [], [], LIMITS.listButton),
  row_people_1: t("قايمة كام شخص: ١", "شخص واحد", "Just me", [], [], LIMITS.rowTitle),
  row_people_2: t("قايمة كام شخص: ٢", "شخصين", "Two", [], [], LIMITS.rowTitle),
  row_people_3: t("قايمة كام شخص: ٣–٤", "ثلاثة أو أربعة", "Three or four", [], [], LIMITS.rowTitle),
  row_people_5: t("قايمة كام شخص: ٥–٦", "خمسة أو ستة", "Five or six", [], [], LIMITS.rowTitle),
  row_people_7: t("قايمة كام شخص: ٧+", "سبعة وأكثر", "Seven or more", [], [], LIMITS.rowTitle),
  /* SB2 — طلب التقييم بعد التوصيل على واتساب، ومسار الرد */
  rv_ask: t("طلب التقييم بعد التوصيل (واتساب، جوّه النافذة)", "كيف كان طلبك رقم {order_no}؟ 🌟\nرأيك يهمنا، اختر من الأزرار 👇", "How was your order {order_no}? 🌟\nYour opinion matters, pick below 👇", ["order_no"], [], 300),
  btn_rv_ok: t("زر التقييم: تمام", "تمام 👍", "All good 👍", [], [], LIMITS.btnTitle),
  btn_rv_note: t("زر التقييم: عندي ملاحظة", "عندي ملاحظة", "I have a note", [], [], LIMITS.btnTitle),
  rv_ok: t("رد «تمام» على طلب التقييم", "يسعدنا ذلك 🌟 وإذا تحب تقيّمنا، التقييم ياخذ أقل من دقيقة 👇", "Glad to hear it 🌟 If you'd like to rate us, it takes less than a minute 👇", [], [], 300),
  rv_ok_nolink: t("رد «تمام 👍» من غير دعوة تقييم للطلب", "يسعدنا ذلك 🌟 بالعافية عليك.", "Glad to hear it 🌟 Enjoy your meal.", [], [], 200),
  wk_order: t("قبل قفل النافذة: طلبه شغّال", "طلبك رقم {order_no} ما زال معنا 🛵 تقدر تتابعه من الزر 👇", "Your order {order_no} is still on its way with us 🛵 You can follow it from the button 👇", ["order_no"], [], 300),
  wk_cart: t("قبل قفل النافذة: سلة ماكمّلهاش", "سلتك ما زالت جاهزة 🛒 تكمّلها من الزر متى ما حبيت 👇", "Your cart is still ready 🛒 Complete it from the button whenever you like 👇", [], [], 300),
  cta_rate: t("زر: قيّم طلبك", "قيّم طلبك", "Rate your order", [], [], LIMITS.ctaText),
  rv_note: t("رد «عندي ملاحظة» على طلب التقييم (تحويل للمدير)", "آسفين لو فيه شي ما كان مثل ما تبي 🙏 حوّلت ملاحظتك للمدير ويرد عليك هنا.\nطلب رقم {order_no}\nاكتب لنا وش صار.\n{wait}", "Sorry if something was not right 🙏 I have passed your note to the manager, who will reply here.\nOrder {order_no}\nTell us what happened.\n{wait}", [], ["order_no", "wait"], 500),
  ...REVIEW_TEXTS,      // RV1: نصوص التقييم بالنجوم (wareviews.js) — بتتعدّل من نفس شاشة النصوص
  btn_meal: t("زر: وجبة", "وجبة", "Meal", [], [], LIMITS.btnTitle),
  btn_weight: t("زر: بالوزن", "بالوزن", "By weight", [], [], LIMITS.btnTitle),
  item_two_ways: t("بطاقة مشوي له وجبة وبالوزن", "*{meal}* — {meal_price}\n{meal_desc}\n*{weight}* — {weight_prices}\nتبيها وجبة ولا بالوزن؟", "*{meal}* — {meal_price}\n{meal_desc}\n*{weight}* — {weight_prices}\nAs a meal or by weight?", ["meal", "meal_price", "weight", "weight_prices"], ["meal_desc"], 900),
  btn_delivery: t("زر: توصيل", "توصيل", "Delivery", [], [], LIMITS.btnTitle),
  btn_other: t("زر: أبغى شي ثاني", "أبغى شي ثاني", "Something else", [], [], LIMITS.btnTitle),
  menu_link_line: t("تحت قايمة الأقسام: رابط المنيو", "وهذا المنيو كامل بالصور والأسعار 👇", "And here is the full menu with photos and prices 👇", [], [], 200),
  unsupported_line: t("رسالة نوعها مش مدعوم جوّه محادثة شغّالة", "ما وصلتني رسالتك بشكل واضح، اكتبها نص لو سمحت 🙏", "Your message did not come through clearly. Please type it as text 🙏"),
  paid_note: t("تأكيد الطلب بعد الدفع", "وصلنا طلبك رقم {order_no} ✅ نبدأ نجهّزه الحين.\nتقدر تتابعه من الزر 👇", "We received your order {order_no} ✅ We are starting on it now.\nYou can follow it from the button 👇", ["order_no"], [], 400),
  lead_followup: t("متابعة محادثة ماخدتش رد مفيد", "{who}\nوصلتنا رسالتك وما قدرنا نخدمك وقتها، نعتذر منك 🙏\nوش تحب تطلب؟ اكتب لي الصنف وأجهّز لك طلبك.", "{who}\nWe got your message and could not help you at the time, sorry 🙏\nWhat would you like to order? Tell me the dish and I will get your order ready.", ["who"], [], 600),
  handoff_remind: t("تذكير: المحادثة عند الموظف (مرة واحدة)", "محادثتك عند الموظف 🙏\n{wait}", "Your chat is with our staff 🙏\n{wait}", [], ["wait"]),
  lead_nudge_ad_weight: t("متابعة محادثة وقفت عند سؤال المساعد: إعلان صنف بالوزن", "بخصوص {dish}: {prices}.\nكم شخص أنتم؟ أرشّح لك الأنسب وأجهّز سلتك.", "About {dish}: {prices}.\nHow many of you are there? I will suggest what fits and get your cart ready.", ["dish", "prices"], [], 500),
  lead_nudge_ad: t("متابعة محادثة وقفت عند سؤال المساعد: إعلان بوكس / صنف / عرض", "بخصوص {dish}: بـ {price} ر.س.\nأجهّزه لك توصيل ولا استلام؟", "About {dish}: SAR {price}.\nShall I get it ready for delivery or pickup?", ["dish", "price"], [], 400),
  lead_nudge: t("متابعة محادثة وقفت عند سؤال المساعد: من غير إعلان", "أنا معك 🙂 قل لي كم شخص أنتم، وأرشّح لك طلب جاهز بسعره وأجهّز سلتك.", "Still with you 🙂 Tell me how many of you there are and I will suggest a ready order with its price and prepare your cart.", [], [], 400),
  /* FU1 (١٥/١٠) — «متابعة اللي ردّ وماطلبش» (رسالة حرة واحدة جوّه النافذة): سطرين بالكتير + «أبغى أطلب» / «لا شكراً». كل {…} من النظام وقت الإرسال
     (عرض الحملة المخزّن محسوب تاني الحين، المنيو الحي، السلة الجاهزة) — مفيش رقم مكتوب في النص. */
  rf_hi: t("متابعة اللي ردّ: التحية بالاسم (أول الرسالة)", "هلا {name}،", "Hi {name}!", ["name"], [], 60),
  rf_offer: t("متابعة اللي ردّ: عرض الحملة بنفس السعر + السلة الجاهزة", "{hi} العرض اللي وصلك ما زال متاح: {offer} 🛒\nسلتك جاهزة بنفس السعر: {link}", "{hi} The offer we sent you is still on: {offer} 🛒\nYour cart is ready at the same price: {link}", ["offer", "link"], ["hi"], 500),
  rf_offer_box: t("متابعة اللي ردّ: عرض الحملة (بوكس يختار فيه)", "{hi} العرض اللي وصلك ما زال متاح: {offer} 🛒\nاختر اللي يعجبك وكمّل من هنا: {link}", "{hi} The offer we sent you is still on: {offer} 🛒\nPick what you like and finish here: {link}", ["offer", "link"], ["hi"], 500),
  rf_cart: t("متابعة اللي ردّ: سلة اتجهّزت في المحادثة", "{hi} سلتك ما زالت جاهزة 🛒\nتكمّلها من هنا: {link}", "{hi} Your cart is still ready 🛒\nFinish it here: {link}", ["link"], ["hi"], 300),
  rf_item: t("متابعة اللي ردّ: الصنف اللي سأل عنه في السلة", "{hi} جهّزنا لك {dish} بـ{price} ر.س في السلة 🛒\nتكمّل طلبك من هنا: {link}", "{hi} We put {dish} (SAR {price}) in your cart 🛒\nFinish your order here: {link}", ["dish", "price", "link"], ["hi"], 400),
  rf_item_page: t("متابعة اللي ردّ: صنف بالوزن (يختار الوزن)", "{hi} تبي تكمّل طلب {dish}؟ اختر الوزن من هنا 👇\n{link}", "{hi} Shall we finish your {dish} order? Pick the weight here 👇\n{link}", ["dish", "link"], ["hi"], 400),
  rf_box: t("متابعة اللي ردّ: البوكس اللي شافه", "{hi} {box} بـ{price} ر.س 🛒\nاختر اللي يعجبك وكمّل من هنا: {link}", "{hi} {box} for SAR {price} 🛒\nPick what you like and finish here: {link}", ["box", "price", "link"], ["hi"], 400),
  rf_box_from: t("متابعة اللي ردّ: البوكس اللي شافه (فيه اختيارات بزيادة)", "{hi} {box} بسعر يبدأ من {price} ر.س 🛒\nاختر اللي يعجبك وكمّل من هنا: {link}", "{hi} {box} from SAR {price} 🛒\nPick what you like and finish here: {link}", ["box", "price", "link"], ["hi"], 400),
  rf_section: t("متابعة اللي ردّ: القسم اللي فتحه", "{hi} تبي تطلب من «{section}»؟ الأصناف بأسعارها هنا 👇\n{link}", "{hi} Want to order from {section}? All the dishes with prices are here 👇\n{link}", ["section", "link"], ["hi"], 400),
  rf_fav: t("متابعة اللي ردّ: طبقه المفضل في السلة", "{hi} جهّزنا لك طبقك المفضل {dish} بـ{price} ر.س في السلة 🛒\nتكمّل طلبك من هنا: {link}", "{hi} We put your favourite {dish} (SAR {price}) in your cart 🛒\nFinish your order here: {link}", ["dish", "price", "link"], ["hi"], 400),
  rf_neutral: t("متابعة اللي ردّ: سطر محايد (من غير أرقام)", "{hi} تبي أجهّز لك طلبك؟ 🙂", "{hi} Shall I get your order ready? 🙂", [], ["hi"], 200),
  rf_yes_cart: t("رد «أبغى أطلب» على المتابعة (السلة جاهزة)", "تمام 👍 سلتك جاهزة، كمّل الدفع من الزر 👇", "Great 👍 Your cart is ready, pay from the button 👇", [], [], 200),
  rf_no: t("رد «لا شكراً» على المتابعة", "أبشر، حيّاك الله في أي وقت 🌟", "Sure, you're welcome any time 🌟", [], [], 200),
  btn_rf_yes: t("زر المتابعة: أبغى أطلب", "أبغى أطلب", "I want to order", [], [], LIMITS.btnTitle),
  btn_rf_no: t("زر المتابعة: لا شكراً", "لا شكراً", "No thanks", [], [], LIMITS.btnTitle),
  media_voice: t("رسالة صوتية والمساعد مابيسمعش ⇒ موظف + «اكتبها»", "ما أقدر أسمع المقاطع الصوتية 🙏 اكتب لي طلبك هنا وأجهّزه لك على طول.\nوحوّلت محادثتك لموظف يسمعها.\n{wait}", "I cannot listen to voice notes 🙏 Type your order here and I will get it ready right away.\nI have also passed your chat to a staff member who will listen to it.\n{wait}", [], ["wait"], 400),
  thanks: t("شكر / وداع", "العفو، حيّاك الله في أي وقت 🌟", "You're welcome, any time 🌟"),
  /* «إيقاف» = كل رسايلنا المبادِرة (العروض وتحديثات الطلب) — حارس الإرسال بيسكّت كل القوالب. الرد على سؤاله في المحادثة شغّال. */
  stop: t("تأكيد إيقاف العروض (ومعاه زر الرجوع وزر إيقاف تحديثات الطلب)", "تم إيقاف العروض ✅ تحديثات طلباتك مستمرة.\nضغطت بالغلط؟ اضغط «رجّع العروض». وللرجوع في أي وقت اكتب: اشتراك", "Offers stopped ✅ Your order updates continue.\nTapped by mistake? Press «Offers back on». To come back any time, type: start"),
  btn_stop_undo: t("زر: رجّع العروض (تراجع عن الإيقاف)", "↩️ رجّع العروض", "↩️ Offers back on", [], [], LIMITS.btnTitle),
  stop_updates: t("تأكيد إيقاف تحديثات الطلب كمان (ومعاه زرارين للرجوع)", "تم ✅ أوقفنا تحديثات الطلب أيضاً.\nلو سألت عن طلبك هنا نرد عليك عادي.\nغيّرت رأيك؟ اختر من الأزرار 👇", "Done ✅ Order updates are stopped too.\nIf you ask about your order here we still answer.\nChanged your mind? Pick below 👇"),
  btn_stop_updates: t("زر: أوقف تحديثات الطلب", "أوقف تحديثات الطلب", "Stop order updates", [], [], LIMITS.btnTitle),
  btn_ok: t("زر: تمام", "تمام", "OK", [], [], LIMITS.btnTitle),
  cancel_what: t("«الغاء / وقف» لوحدها: نسأل قصده إيه", "تبي تلغي طلبك، ولا توقف رسائلنا؟ اختر 👇", "Do you want to cancel your order, or stop our messages? Pick below 👇"),
  repeat_short: t("نفس السؤال اتكرر فوراً: رد قصير بزر موظف", "نفس المعلومة 👆 تبي أحوّلك لموظف؟", "Same answer as above 👆 Shall I pass you to a staff member?"),
  other_city: t("عميل من مدينة تانية", "نحن في جدة، حي السلامة، والتوصيل داخل جدة فقط.", "We are in Jeddah (Al Salamah) and deliver inside Jeddah only."),
  delivery_time: t("مدة التوصيل (من غير دقايق)", "الوقت يختلف حسب المسافة والزحمة. أرسل موقعك 📍 وأتأكد لك من التغطية والرسوم.", "The time depends on distance and traffic. Share your location 📍 and I will check coverage and the fee for you."),
  payment_no_cash_transfer: t("سؤال «ادفع تحويل / كاش؟»: السطر الأول (قرار المالك)", "الدفع أونلاين من موقعنا عند إتمام الطلب، وما نستقبل تحويل بنكي أو كاش عبر المحادثة.", "Payment is online on our website when you place the order; we do not take bank transfers or cash through the chat."),
  whoami: t("«انت بوت؟ / مين معي»: سطر التعريف + القائمة (وضع classic)", "{who}\nاختر اللي تبيه 👇", "{who}\nPick what you need 👇", ["who"]),
  /* PS1 — الصدق: الشخصية لها اسم، بس «انت بوت؟ / مع مين اتكلم؟ / انت شخص حقيقي؟» بتاخد إجابة صريحة في سطر واحد: مساعد رقمي، والفريق موجود بكلمة «موظف». */
  whoami_persona: t("«انت بوت؟ / مين معي»: الإجابة الصريحة باسم المساعد", "أنا {name}، المساعد الرقمي لفريش كاتس 🙂 وأي وقت تبي أحد من الفريق اكتب: موظف\nوش تحب أساعدك فيه؟ 👇", "I'm {name}, Fresh Cuts' digital assistant 🙂 Any time you'd like someone from the team, type: staff\nWhat can I help you with? 👇", ["name"], [], 300),
  intro: t("التعريف بالاسم (أول رسالة في المحادثة)", "معك {name}، المساعد الرقمي لفريش كاتس.", "This is {name}, Fresh Cuts' digital assistant.", ["name"], [], 200),
  btn_cancel_order: t("زر: إلغاء طلبي", "إلغاء طلبي", "Cancel my order", [], [], LIMITS.btnTitle),
  btn_stop_msgs: t("زر: إيقاف الرسائل", "إيقاف الرسائل", "Stop messages", [], [], LIMITS.btnTitle),
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
  item_weights: t("صنف بالوزن: الاسم ثم الأوزان بأسعارها", "*{name}*\n{prices}\n{desc}\n{note}", "*{name}*\n{prices}\n{desc}\n{note}", ["name", "prices"], ["desc", "note"]),
  weight_one: t("طلب صنف بوزن محدد: الوزن وسعره + زر سلة جاهزة", "*{name}* — {weight}: {price}\nاضغط الزر تلقاه في سلتك بهذا الوزن، وتقدر تزيد عليه من المنيو.\n{note}", "*{name}* — {weight}: {price}\nTap the button: it is in your cart at this weight, and you can add more from the menu.\n{note}", ["name", "weight", "price"], ["note"], 600),
  weight_many: t("طلب صنف بأكتر من وزن / كمية", "*{name}*\n{lines}\nالمجموع: {total}\nاضغط الزر تلقاها في سلتك، وتقدر تزيد عليها من المنيو.", "*{name}*\n{lines}\nTotal: {total}\nTap the button: they are in your cart, and you can add more from the menu.", ["name", "lines", "total"], [], 800),
  df_list: t("مسببات الحساسية المسجّلة لصنف", "حسب بيانات مطبخنا، «{dish}» يحتوي على: {list}.\n{kitchen}\n{fryer}\n{note}\nولو حساسيتك من شي آخر اكتب اسمه وأتأكد لك.", "According to our kitchen data, {dish} contains: {list}.\n{kitchen}\n{fryer}\n{note}\nIf your allergy is to something else, name it and I will check.", ["dish", "list"], ["kitchen", "fryer", "note"], 700),
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
  /* أسرار الشغل (قرار عمر ١٢/١٠): المقادير والتتبيلة وطريقة التحضير والمورّدين مابتتقالش — رد واحد مهذب من غير تحويل.
     ST1 (طلب عمر): الصياغة القديمة «من أسرار مطبخنا» اتشالت — سطر مهني قصير من غير أي شرح، ومعاه زر «موظف»؛ ومفيش تحويل لوحده
     (العميل لو عايز موظف يكتب «موظف» أو يضغط الزر)، وتنبيه «حاجة غريبة» بالمحادثة للمدير والملاك (wateam.js). */
  secret: t("سؤال عن الوصفة / المقادير / طريقة التحضير", "عذراً، هذي المعلومة ما أقدر أزوّدك بها 🙏 أقدر أساعدك في المنيو والطلب، أو اكتب «موظف» وأحوّلك.", "Sorry, I can't share that information 🙏 I can help with the menu and ordering, or type \"staff\" and I'll connect you.", [], [], 300),
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
  row_channel: t("صف: قناة العروض", "🔔 قناة العروض", "🔔 Offers channel", [], [], LIMITS.rowTitle),
  channel_body: t("قناة واتساب: رد صف «قناة العروض»", "قناتنا على واتساب: عروض الطلب من موقعنا وجديد المنيو أول بأول 👇", "Our WhatsApp channel: website offers and new menu items as they come 👇", [], [], 300),
  channel_line: t("قناة واتساب: السطر بعد نهاية المحادثة", "وتابع قناتنا على واتساب لعروض الطلب من موقعنا 👇", "Follow our WhatsApp channel for our website offers 👇", [], [], 300),
  channel_assist: t("قناة واتساب: سطر المساعد (الرابط بيتحط بعده)", "وتابع قناتنا على واتساب لعروض الطلب من موقعنا:", "Follow our WhatsApp channel for our website offers:", [], [], 200),
  cta_channel: t("زر: تابع القناة", "تابع القناة", "Follow channel", [], [], LIMITS.ctaText),
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
  transfer_note: t("سطر للعميل: الكاشير حوّل المحادثة للمدير (ST2)", "حوّلت محادثتك لمدير الفرع، ويكمل معك هنا 🙏", "I've passed your chat to the branch manager, who will continue with you here 🙏", [], [], 300),
  /* MJ1: ملاحظة على طلب شغّال — التأكيد للعميل (لهجة بيضاء) */
  order_note: t("ملاحظة على طلب شغّال: وصلت (موقع / عنوان / صورة / «زوّد…»)", "وصلتنا ملاحظتك على طلبك رقم {order_no} ✅ وبلّغنا {who}.", "Got your note on order {order_no} ✅ and passed it on to {who}.", ["order_no", "who"], [], 300),
  note_who_kitchen: t("…«بلّغنا»: الطلب في المطبخ", "المطبخ", "the kitchen", [], [], 60),
  note_who_courier: t("…«بلّغنا»: الطلب في الطريق والمندوب وصلته على واتساب", "المندوب", "the courier", [], [], 60),
  note_who_team: t("…«بلّغنا»: الطلب في الطريق والفريق يوصّلها للمندوب", "الفريق ويوصّلها للمندوب", "the team, who will pass it to the courier", [], [], 60),
  handover_note: t("متابعة للعميل: الموظف اتأخر (مرة واحدة)", "نعتذر عن التأخير 🙏 نبّهنا الفريق مرة ثانية ويرد عليك موظف هنا.", "Sorry for the wait 🙏 We've alerted the team again and a staff member will reply here.", [], [], 300),
  handover_note_assist: t("متابعة للعميل: الموظف اتأخر، والمساعد معاه", "نعتذر عن التأخير 🙏 نبّهنا الفريق مرة ثانية ويرد عليك موظف هنا.\nوأنا معك لو تحتاج شي في المنيو أو الطلب.", "Sorry for the wait 🙏 We've alerted the team again and a staff member will reply here.\nMeanwhile I'm here for anything about the menu or your order.", [], [], 300),
  media_flood_line: t("سيل صور: سطر للعميل قبل الكتم", "وصلتنا صورك 🙏 حوّلتها لواحد من الفريق يراجعها ويرد عليك هنا.", "We got your pictures 🙏 I passed them to someone from the team, who will reply here.", [], [], 300),
  call_line: t("رقم المطعم تحت سطر التحويل لموظف", "أو اتصل على {phone}", "Or call us on {phone}", ["phone"], [], 100),
  when_open: t("سطر «الرد قريب» (في الدوام بس)", "يرد عليك موظف هنا في أقرب وقت، وأنا أترك المحادثة له.", "A staff member will reply here shortly, and I'll leave the chat to them.", [], [], 200),
  wait_line: t("سطر «الرد لما نفتح»", "المطعم مقفل الحين. يرد عليك موظف هنا أول ما نفتح {opens}، وأنا أترك المحادثة له.", "We're closed now. A staff member will reply here once we open {opens}, and I'll leave the chat to them.", ["opens"], [], 200),
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
  delivery: "delivery", delivery_area: "delivery", delivery_fee: "delivery", min_order: "delivery", delivery_time: "eta",
  hours: "hours", open_now: "hours", special_hours: "hours", waitlist_join: "hours",
  location: "location", payment: "payment", order_status: "status",
  complaint: "complaint", refund: "complaint",
  payment_issue: "problem", site_issue: "problem", coupon_help: "problem",
  cancel_order: "change", modify_order: "change", cancel_or_stop: "change", special_request: "change",
  human: "human", thanks: "thanks", bye: "thanks", stop: "stop", start: "start", media: "media", unknown: "unknown",
});
export const TREE_KEYS = ["repeat_short", "other_city", "delivery_time", "whoami", "cancel_what", "stop_updates", "channel", "main", "boxes", "tier", "box", "cats", "cat", "item", "items", "best", "notmenu", "packs", "pickup", "spicy", "faq", "area", "hoursloc", "optin_yes", "optin_no", "resume_all", "resume_updates", "reorder", "custom_offer", "secret", "dishfact"];
export const REPLY_KEYS = ["greet", "menu", "order", "offers", "delivery", "hours", "location", "payment", "status", "complaint", "problem", "change", "human", "staff", "media", "unknown", "thanks", "stop", "start"];
const HANDOFF_KEYS = { review_note: ["review_note", "urgent"], review_low: ["review_low", "urgent"], custom_offer: ["custom_offer", "normal"], complaint: ["complaint", "urgent"], problem: ["problem", "urgent"], change: ["order_change", "urgent"], human: ["asked_human", "normal"], staff: ["needs_staff", "normal"], media: ["media", "normal"] };
const BUTTON_IDS = { "bot:menu": "main", "bot:status": "status", "bot:human": "human", "optin:yes": "optin_yes", "optin:no": "optin_no", "resume:all": "resume_all", "resume:updates": "resume_updates", "re:last": "reorder", "bot:custom": "custom_offer",
  "cw:order": "change", "cw:stop": "stop", "stop:updates": "stop_updates", "stop:ok": "ack", "stop:undo": "start",      // M2: «الغاء» لوحدها ⇒ سؤال بزرارين؛ الإيقاف ⇒ العروض بس + زر تحديثات الطلب
  "rf:yes": "rf_yes", "rf:no": "rf_no" };      // FU1: زرّين رسالة «متابعة اللي ردّ»
const MENU_IDS = { main: "main", boxes: "boxes", cats: "cats", offers: "offers", delivery: "delivery", pickup: "pickup", status: "status", hours: "hoursloc", location: "location", packs: "packs", pay: "payment", human: "human", channel: "channel" };
const IGNORED_TYPES = new Set(["reaction", "sticker", "system", "ephemeral", "request_welcome", "order", "revoke"]);      // PK1: رسالة العميل مسحها (revoke) كانت بتوصل للمساعد كنص «[revoke]» وبيرد عليها بالإنجليزي (١٣/١٠)
const MEDIA_TYPES = new Set(["image", "audio", "voice", "video", "document", "contacts", "location"]);
/* ═══ MJ1 (١٧/١٠) — الطلب الشغّال أولاً ═══
   يوم ١٦/١٠: صلاح (طلبه في الطريق: موقع + «دور 3. شقه 9» + صورة ⇒ «تبيه نفسه؟» و«نعم نوصل لك 👍 الرسوم…») · حماده (دفع وبعدها بثواني موقع + «زود الخبز» ⇒ «نفس طلبك السابق؟»).
   الطلب الشغّال = مدفوع / في نقطة البيع / في المطبخ / جاهز / مع المندوب (ACTIVE_ORDER_STATUSES) خلال activeOrderHours. الرسالة اللي بتتحسب ملاحظة عليه: موقع (pin أو رابط خرايط)،
   نص عنوان، صورة/ملف، أو نص تعديل/ملاحظة. مش ملاحظة (بتمشي في طريقها العادي): شكوى، مشكلة دفع، إلغاء، «وين طلبي»، إيقاف، موظف، التقييم، الشكر، المواعيد، الضغطات، والأسئلة. */
export const ACTIVE_ORDER_STATUSES = Object.freeze(["paid", "pos_created", "accepted", "preparing", "ready", "courier_requested", "courier_assigned", "on_the_way"]);
export const NOTE_MOD_RE = /(^| )(زود|زودوا|زودو|زودلي|زودولي|زيد|زيدوا|زيدو|زياده|اكسترا|extra|بدون|من غير|بلا|ما ابي|ما ابغى|ما ابغا|مابي|مابغى|مابغا|لا تحط|لا تحطوا|لا تحطو|ماتحط|ماتحطوا|حطوا|حطو|حطولي|حطلي|ضيفوا|ضيفو|ضيف|ضيفلي|ضيفولي|اضيفوا|اضف|اضيف|خلوها|خليها|خلها|خلوه|خليه|خله|بدلوا|بدلو|بدل|ملاحظه|ملاحظات|ملاحظتي|تنبيه|نسيت|without|add|more|less)( |$)/;
export const NOTE_ADDR_RE = /(^| )(دور|الدور|طابق|الطابق|شقه|شقتي|عماره|عمارتي|فيلا|بيت|بيتي|مبنى|مبني|المبنى|بوابه|البوابه|مدخل|المدخل|مكتب|برج|حي|شارع|عنوان|عنواني|العنوان|موقعي|لوكيشن|الموقع|بجوار|بجنب|جنب|جمب|قدام|مقابل|وراء|ورا|خلف|قريب|المجمع|مجمع|سكن|استراحه|فندق|شاليه|الرقم الاضافي|رقم المبنى|floor|flat|apartment|apt|building|villa|gate|entrance|next to|behind|opposite)( |$)/;
const NOTE_HARD_KEYS = new Set(["complaint", "problem", "status", "eta", "stop", "start", "stop_updates", "cancel_what", "human", "reorder", "thanks", "greet", "hours", "hoursloc", "location", "payment", "secret", "whoami", "main", "nack", "rf_yes", "rf_no", "optin_yes", "optin_no",
  "resume_all", "resume_updates", "review_ok", "review_note", "review_star", "review_reason", "channel", "custom_offer", "delivery_time", "other_city", "repeat_short", "unsupported"]);
const CANCEL_WORD_RE = /(^| )(الغ|الغي|الغيه|الغاء|كنسل|كانسل|cancel|استرجاع|استرداد|refund)/;
/* ⇒ "location" | "address" | "photo" | "note" | null — بعد التصنيف. الضغطات والأسئلة (؟) مش ملاحظات (إلا لو فيها عنوان). */
export function noteKindOf(ev, cls) {
  if (!ev || ev.interactiveId || !cls || !cls.key || NOTE_HARD_KEYS.has(cls.key)) return null;
  if (cls.key === "area") return "location";
  const raw = String(ev.text || "").trim(), text = /^\[[^\]]*\]$/.test(raw) ? "" : raw, n = normalize(text);      // «[صورة]» / «[موقع]» = نوع الرسالة مش كلام العميل (زي classify)
  if (cls.key === "change" && cls.rawIntent === "cancel_order") return null;
  if (CANCEL_WORD_RE.test(n) || (/[?؟]/.test(text) && !NOTE_ADDR_RE.test(n))) return null;
  if (REVIEW_NOTE_RE.test(n)) return null;      // «عندي ملاحظة» لوحدها = لسه ماقالهاش (مسار التقييم / الموظف)
  const media = ev.media && typeof ev.media === "object" ? ev.media : null;
  if (media && ["image", "video", "document"].includes(String(media.kind || "")) && (!text || NOTE_MOD_RE.test(n) || NOTE_ADDR_RE.test(n))) return "photo";
  if (!text) return null;
  if (NOTE_ADDR_RE.test(n)) return "address";
  if (NOTE_MOD_RE.test(n)) return "note";
  return null;
}
/* MJ1 #٥: التحويلات اللي اللي بعدها بثواني = نفس الشكوى (مش رسالة تانية) */
const BURST_REASONS = new Set(["complaint", "problem", "order_change", "order_late", "order_issue", "allergy_severe", "review_note", "review_low"]);
/* intents اللي مايتعدّاش عليها بحث المنيو/البوكس/الأسئلة الشائعة */
const HARD_INTENTS = new Set(["complaint", "refund", "payment_issue", "site_issue", "cancel_order", "modify_order", "cancel_or_stop", "coupon_help", "human", "stop", "start", "order_status", "special_request"]);
/* RG1 (١٤/١٠): «ابغي اتواصل مع احد المسؤولين» ⇒ مش «طلب موظف» عادي: طلب مسؤول (asked_manager) — بيروح للمدير على طول مع الكاشير
   (waTeam.ladder.managerDirect). بعد normalize (ؤ ⇒ و، ة ⇒ ه، أ ⇒ ا). بيتطبّق بس لما النية أصلاً «موظف» (human). */
export const MANAGER_ASK_RE = /(?:^| )[وف]?(?:لل|[بلك])?(?:ال)?(?:مسوول|مسوولين|مسوولي|مسوولون|مسووله|مدير|مديره|مديرين|مديركم|مدراء|مدرا|اداره|ادارتكم|مشرف|مشرفين|مشرفه)(?= |$)|(?:^| )(?:manager|managers|supervisor|supervisors|management)(?= |$)/;
export const asksManager = (text) => MANAGER_ASK_RE.test(normalize(String(text || "")));
const NAV_RE = /^(?:القايمه|القايمه الرييسيه|الرييسيه|رجوع|ارجع|menu|main menu|main|back|0)$/;      // بعد التطبيع: ئ ⇒ ي
const ACK_RE = /^(?:تمام|تمم|اوكي|اوك|ok|okay|k|طيب|زين|ماشي|حلو|اها|اه|ايوه|ايوا|نعم|yes|yep|👍|👌|🙏)$/;
/* FD1 (مراجعة ١٤/١٠): رد مكتوب على سؤال رسالة «طبقك المفضل» («تبي نجهز لك الطلب هنا؟») يتحسب «أبغى أطلب» بس لو موافقة صريحة:
   نعم / ايوه / اي / اكيد / yes …، أو «أبغى / أبي / أريد (أطلب / العرض / البوكس)». مش «تمام / اوكي / 👍 / طيب / ماشي / حلو / اها / ايه» ولا
   أي إيموجي (ممكن تبقى «وصلت» أو زعل) — ولا سؤال («نعم؟»)، ولا طلب صنف تاني («ابغى اطلب برجر» بتمشي في طريقها العادي).
   «تمام/اوكي/ok» قبل فعل الطلب نفسه («تمام ابغى») = موافقة. النص بعد normalize (ى ⇒ ي، علامات الترقيم ⇒ مسافة). */
const YES_LEAD = "(?:نعم|ايوه|ايوا|اي|اكيد|اكيدا|يب|yes|yeah|yep|yup|sure)";
const YES_OK = "(?:تمام|اوكي|اوك|ok|okay|طيب|ماشي)";
const YES_WANT = "(?:ابغي|ابغا|ابي|اريد|ودي|نبغي|نبي|حاب|حابب)";
const YES_OBJ = "(?:اطلب|نطلب|اطلبه|اطلبها|الطلب|العرض|البوكس|هذا|هذي|ذا)";
const YES_POLITE = "(?:لو سمحت|من فضلك|الله يعافيك|please|pls|plz)";
export const CAMPAIGN_YES_RE = new RegExp(`^(?:${YES_LEAD}(?: ${YES_WANT}(?: ${YES_OBJ})?)?|${YES_OK} ${YES_WANT}(?: ${YES_OBJ})?|${YES_WANT}(?: ${YES_OBJ})?|i want(?: to order| it| this)?)(?: ${YES_POLITE})?$`);
export const isCampaignYes = (text) => { const raw = String(text || ""); return !/[?؟]/.test(raw) && CAMPAIGN_YES_RE.test(normalize(raw)); };
/* ضغطة زر الرد «أبغى أطلب» في قوالب «الرد أولاً» (الـpayload = نص الزر) */
const CAMPAIGN_TAP_IDS = new Set([ORDER_BUTTON, ORDER_BUTTON_EN]);
/* كود سلة مؤقت في الرد لحد ما السلة تتحفظ فعلاً (بعد القرار) — بيتبدّل بالكود الحقيقي قبل الإرسال، وعمره ما بيطلع لعميل */
const CAMP_CART_PENDING = "fdpending0";
const NACK_RE = /^(?:لا|لا شكرا|لا مشكور|no|nope|no thanks|مو لازم)$/;
export const WINDOW_V2_STAGES = Object.freeze(["pos_created", "accepted", "on_the_way", "delivered", "rejected_refunded", "refund_failed", "review"]);
/* SB4: الردود السريعة في القوالب (v2) والأزرار في تحديثات الطلب الحرة بتوصل بنصها كمعرّف ⇒ الرد المفيد */
export const QR_IDS = Object.freeze({ "تابع طلبي": "status", "track my order": "status", "تمام 👍": "review_ok", "تمام": "review_ok", "all good 👍": "review_ok", "عندي ملاحظة": "review_note", "i have a note": "review_note", "عندي سؤال": "human", "نفس الطلب مرة ثانية": "reorder" });
export const REVIEW_NOTE_RE = /^(?:عندي ملاحظه|عندي ملاحظات|ملاحظه|ملاحظات|فيه ملاحظه|في ملاحظه|i have a note|a note)$/;      // SB2: بعد normalize (ة ⇒ ه)
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
/* قناة واتساب (قرار عمر ١٢/١٠): الرابط لازم يكون رابط قناة واتساب بالظبط. فاضي أو مقفول ⇒ ولا سطر ولا صف (نايمة). */
export const channelUrlOk = (u) => /^https:\/\/(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9]{8,64}$/.test(String(u || ""));
const channelCfg = (x) => { const c = x && typeof x === "object" ? x : {}; const d = Math.round(Number(c.everyDays));
  return { url: channelUrlOk(c.url) ? String(c.url) : "", enabled: c.enabled === true, everyDays: Number.isFinite(d) && d >= 1 && d <= 365 ? d : 30 }; };
const phNorm = (v) => String(v || "").replace(/\D/g, "").replace(/^(00966|966|0)/, "");
export const LIVE_SCOPES = Object.freeze(["ads", "new", "all"]);
export const DISCLOSURE_MODES = Object.freeze(["persona", "classic"]);
export const channelOn = (cfg) => Boolean(cfg && cfg.links && cfg.links.channel && cfg.links.channel.enabled === true && channelUrlOk(cfg.links.channel.url));
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
    brief: x.brief && typeof x.brief === "object" && !Array.isArray(x.brief) ? x.brief : {},      // PK1: «ملف معرفة البيزنس» — اللي المالك غيّره بس (wabrief.js؛ بيتحفظ من /api/cms/wabot/brief)
    freeRepliesPerMonth: num(x.freeRepliesPerMonth, 0, 100000, DEFAULTS.freeRepliesPerMonth),
    replyRateSar: num(x.replyRateSar, 0, 5, DEFAULTS.replyRateSar),
    greetWindowHours: num(x.greetWindowHours, 1, 168, DEFAULTS.greetWindowHours),
    disclosureHours: num(x.disclosureHours, 1, 168, DEFAULTS.disclosureHours),
    disclosureMode: DISCLOSURE_MODES.includes(x.disclosureMode) ? x.disclosureMode : DEFAULTS.disclosureMode,
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
    campaignCart: x.campaignCart !== false, campaignOfferHours: num(x.campaignOfferHours, 1, 168, DEFAULTS.campaignOfferHours),      // FD1
    campaignYesQuietMin: num(x.campaignYesQuietMin, 0, 720, DEFAULTS.campaignYesQuietMin),
    campaignReply: x.campaignReply !== false, campaignReplyHours: num(x.campaignReplyHours, 1, 168, DEFAULTS.campaignReplyHours),      // CR2
    maxAgeMinutes: num(x.maxAgeMinutes, 1, 120, DEFAULTS.maxAgeMinutes),
    sameTextSeconds: num(x.sameTextSeconds, 0, 120, DEFAULTS.sameTextSeconds),
    autoEchoSkipCovered: x.autoEchoSkipCovered === true,
    openerHours: num(x.openerHours, 1, 72, DEFAULTS.openerHours), paidNoteEnabled: x.paidNoteEnabled !== false, reviewWhatsApp: x.reviewWhatsApp !== false, reviewReplyHours: num(x.reviewReplyHours, 1, 72, DEFAULTS.reviewReplyHours),
    reviewFlow: reviewFlowConfig(x.reviewFlow),      // RV1
    courierJob: courierJobConfig(x.courierJob),      // CW1
    courierContact: x.courierContact !== false, courierTemplate: x.courierTemplate === true,
    windowFreeUpdates: x.windowFreeUpdates !== false, windowSell: x.windowSell !== false, windowKeeper: x.windowKeeper !== false,
    ...(({ followLink, followNumber, closedPolicy, closedSkipPreparing, mergeDeliveredReview, reviewPaidGapMin, followBanner, followBannerSkipHours }) => ({ followLink, followNumber, closedPolicy, closedSkipPreparing, mergeDeliveredReview, reviewPaidGapMin, followBanner, followBannerSkipHours }))(waPolicyCfg({ waBot: x })),
    windowV2Stages: (Array.isArray(x.windowV2Stages) ? x.windowV2Stages : []).filter((k) => WINDOW_V2_STAGES.includes(k)),
    windowKeeperHour: num(x.windowKeeperHour, 12, 23, DEFAULTS.windowKeeperHour), windowKeeperDailyCap: num(x.windowKeeperDailyCap, 0, 500, DEFAULTS.windowKeeperDailyCap), windowKeeperWeekly: num(x.windowKeeperWeekly, 0, 7, DEFAULTS.windowKeeperWeekly),
    windowKeeperQuietStart: num(x.windowKeeperQuietStart, 0, 23, DEFAULTS.windowKeeperQuietStart), windowKeeperQuietEnd: num(x.windowKeeperQuietEnd, 0, 23, DEFAULTS.windowKeeperQuietEnd), leadFollowUpMin: num(x.leadFollowUpMin, 0, 180, DEFAULTS.leadFollowUpMin),
    ...fuConfig(x),      // FU1
    ...journeyCfg(x),    // CJ1a
    autoInboundPatterns: x.autoInboundPatterns !== false, autoInboundSec: num(x.autoInboundSec, 0, 120, DEFAULTS.autoInboundSec),
    loopGuardCount: num(x.loopGuardCount, 0, 20, DEFAULTS.loopGuardCount), loopGuardFastSec: num(x.loopGuardFastSec, 1, 30, DEFAULTS.loopGuardFastSec),
    loopGuardSeconds: num(x.loopGuardSeconds, 10, 600, DEFAULTS.loopGuardSeconds), loopGuardMuteHours: num(x.loopGuardMuteHours, 1, 168, DEFAULTS.loopGuardMuteHours),
    autoEchoMaxSec: num(x.autoEchoMaxSec, 0, ECHO.maxSecLimit, DEFAULTS.autoEchoMaxSec),
    neverReplyPhones: [...new Set((Array.isArray(x.neverReplyPhones) ? x.neverReplyPhones : []).map(phNorm).filter((p) => /^5\d{8}$/.test(p)))].slice(0, 500),
    liveScope: LIVE_SCOPES.includes(x.liveScope) ? x.liveScope : DEFAULTS.liveScope,
    liveSince: Number.isFinite(Date.parse(x.liveSince)) ? new Date(x.liveSince).toISOString() : "",
    mediaFloodBuyerCount: num(x.mediaFloodBuyerCount, 5, 200, DEFAULTS.mediaFloodBuyerCount),
    mediaFloodCount: num(x.mediaFloodCount, 0, 50, DEFAULTS.mediaFloodCount), mediaFloodMinutes: num(x.mediaFloodMinutes, 1, 30, DEFAULTS.mediaFloodMinutes), mediaFloodMuteHours: num(x.mediaFloodMuteHours, 1, 168, DEFAULTS.mediaFloodMuteHours),
    autoEchoTexts: (Array.isArray(x.autoEchoTexts) ? x.autoEchoTexts : []).map((t) => String(t || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, ECHO.maxTexts),
    maxRepliesPerHour: num(x.maxRepliesPerHour, 5, 300, DEFAULTS.maxRepliesPerHour),
    maxTapsPerHour: num(x.maxTapsPerHour, 20, 1000, DEFAULTS.maxTapsPerHour),
    maxRepliesPerMinute: num(x.maxRepliesPerMinute, 3, 30, DEFAULTS.maxRepliesPerMinute),
    orderLookbackHours: num(x.orderLookbackHours, 1, 336, DEFAULTS.orderLookbackHours),
    lateAfterMinutes: num(x.lateAfterMinutes, 20, 600, DEFAULTS.lateAfterMinutes),
    activeOrderFirst: x.activeOrderFirst !== false, activeOrderHours: num(x.activeOrderHours, 1, 24, DEFAULTS.activeOrderHours), activeOrderMergeSec: num(x.activeOrderMergeSec, 0, 600, DEFAULTS.activeOrderMergeSec),      // MJ1
    handoverBurstSec: num(x.handoverBurstSec, 0, 600, DEFAULTS.handoverBurstSec),      // MJ1 #٥
    interactive: x.interactive !== false,
    staffAlert: x.staffAlert !== false,
    alertInTest: x.alertInTest === true,
    handoverAckNeedsReply: x.handoverAckNeedsReply !== false,
    alertPhones: staffPhones(x.alertPhones),
    maxAlertsPerHour: num(x.maxAlertsPerHour, 0, 60, DEFAULTS.maxAlertsPerHour),
    firstCode: /^[A-Z0-9-]{2,20}$/.test(String(x.firstCode || "")) ? String(x.firstCode) : DEFAULTS.firstCode,
    links: { organic: slugOk(L.organic) ? L.organic : DEFAULTS.links.organic, ads: slugOk(L.ads) ? L.ads : DEFAULTS.links.ads, packs: slugOk(L.packs) ? L.packs : DEFAULTS.links.packs, adMap, channel: channelCfg(L.channel) },
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
  if ("neverReplyPhones" in src) {
    const list = Array.isArray(src.neverReplyPhones) ? src.neverReplyPhones.map(phNorm) : null;
    if (!list || list.length > 500 || list.some((p) => !/^5\d{8}$/.test(p))) errors.push("neverReplyPhones: أرقام سعودية 05XXXXXXXX (لحد ٥٠٠)"); else out.neverReplyPhones = [...new Set(list)];
  }
  if ("liveScope" in src) { if (LIVE_SCOPES.includes(src.liveScope)) out.liveScope = src.liveScope; else errors.push("liveScope: ads أو new أو all"); }
  if ("liveSince" in src) { if (src.liveSince === "" || src.liveSince === null) out.liveSince = ""; else if (Number.isFinite(Date.parse(src.liveSince))) out.liveSince = new Date(src.liveSince).toISOString(); else errors.push("liveSince: تاريخ غير صحيح"); }
  if ("autoEchoTexts" in src) {
    const list = Array.isArray(src.autoEchoTexts) ? src.autoEchoTexts.map((t) => String(t ?? "").replace(/\s+/g, " ").trim()).filter(Boolean) : null;
    if (!list || list.length > ECHO.maxTexts || list.some((t) => [...t].length > 1000)) errors.push(`autoEchoTexts: قايمة نصوص (لحد ${ECHO.maxTexts} نص، كل نص لحد ١٠٠٠ حرف)`); else out.autoEchoTexts = [...new Set(list)];
  }
  if ("testPhones" in src) {
    const raw = Array.isArray(src.testPhones) ? src.testPhones : String(src.testPhones || "").split(/[\s,،;]+/).filter(Boolean);
    const ok = staffPhones(raw);
    if (ok.length !== new Set(raw.map((x) => String(x).trim()).filter(Boolean)).size) errors.push("testPhones: رقم غير صحيح (المطلوب جوال سعودي 05XXXXXXXX)");
    out.testPhones = ok;
  }
  if ("alertPhones" in src) out.alertPhones = staffPhones(Array.isArray(src.alertPhones) ? src.alertPhones : String(src.alertPhones || "").split(/[\s,،;]+/));
  if ("greetScope" in src) { if (["all", "ads"].includes(src.greetScope)) out.greetScope = src.greetScope; else errors.push("greetScope"); }
  if ("disclosureMode" in src) { if (DISCLOSURE_MODES.includes(src.disclosureMode)) out.disclosureMode = src.disclosureMode; else errors.push("disclosureMode: persona أو classic"); }
  if ("footerMode" in src) { if (["always", "smart", "first"].includes(src.footerMode)) out.footerMode = src.footerMode; else errors.push("footerMode"); }
  errors.push(...rangeErrors(src));
  delete out.humanWindowHours;      // اتلغى (١٢/١٠) — أي حفظ بينضّف المخزّن القديم
  for (const k of ["humanPauseMin", "staffWaitMin", "closedEchoPauseMin", "manualMuteHours", "handoffOpenHours", "freeRepliesPerMonth", "replyRateSar", "disclosureHours", "unknownHandoverAfter", "adWindowHours", "optinAnswerWindowMin",
    "offerEndWithinDays", "boxesCacheMin", "menuCacheMin", "offersCacheMin", "staleCacheMin", "logKeepDays", "reorderMaxDays", "reorderLinkDays", "reorderMinTotal", "reorderLookback", "campaignReplyHours",
    "handoverRealertMin", "handoverCustomerNoteMin", "greetWindowHours", "maxAgeMinutes", "sameTextSeconds", "autoEchoMaxSec", "autoInboundSec", "openerHours", "leadFollowUpMin", "reviewReplyHours", "reviewPaidGapMin", "followBannerSkipHours", "windowKeeperHour", "windowKeeperDailyCap", "windowKeeperWeekly", "windowKeeperQuietStart", "windowKeeperQuietEnd", "loopGuardCount", "loopGuardFastSec", "loopGuardSeconds", "loopGuardMuteHours", "mediaFloodBuyerCount", "mediaFloodCount", "mediaFloodMinutes", "mediaFloodMuteHours", "maxRepliesPerHour", "maxTapsPerHour", "maxRepliesPerMinute", "orderLookbackHours", "lateAfterMinutes", "activeOrderHours", "activeOrderMergeSec", "handoverBurstSec", "maxAlertsPerHour", "campaignOfferHours", "campaignYesQuietMin", ...Object.keys(FU_NUMS), ...Object.keys(JOURNEY_NUMS)]) {
    if (k in src) { if (Number.isFinite(Number(src[k])) && src[k] !== "" && src[k] !== null) out[k] = Number(src[k]); else errors.push(k); }
  }
  for (const k of ["interactive", "staffAlert", "alertInTest", "autoEchoSkipCovered", "autoInboundPatterns", "paidNoteEnabled", "reviewWhatsApp", "windowFreeUpdates", "windowSell", "windowKeeper", "courierContact", "courierTemplate", "followLink", "followBanner", "closedPolicy", "closedSkipPreparing", "mergeDeliveredReview", "handoverAckNeedsReply", "reorderEnabled", "dishFactsEnabled", "campaignCart", "campaignReply", "activeOrderFirst", ...FU_BOOLS, ...JOURNEY_BOOLS]) if (k in src) out[k] = src[k] === true;
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
  if ("reviewFlow" in src) { const rv = reviewFlowFromBody(src.reviewFlow, prev.reviewFlow); if (rv.ok) out.reviewFlow = rv.value; else errors.push(...rv.errors); }      // RV1
  if ("courierJob" in src) { const cj = courierJobFromBody(src.courierJob, prev.courierJob); if (cj.ok) out.courierJob = cj.value; else errors.push(...cj.errors); }      // CW1
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
  if ("followNumber" in src) {      // ١٤/١٠: رقم زر «تابع طلبك» — دولي من غير + (٠٥… / ٥… بيتحوّل لـ٩٦٦…)
    let d = String(src.followNumber || "").replace(/[^\d]/g, ""); if (/^05\d{8}$/.test(d)) d = `966${d.slice(1)}`; else if (/^5\d{8}$/.test(d)) d = `966${d}`; else if (/^00/.test(d)) d = d.slice(2);
    if (/^\d{9,15}$/.test(d)) out.followNumber = d; else errors.push("followNumber: رقم غير صحيح (مثال 966546715683)");
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
    if ("channel" in L) {
      const C = L.channel && typeof L.channel === "object" ? L.channel : {}, ch = { ...channelCfg(cur.channel) };
      if ("url" in C) { const u = String(C.url || "").trim().replace(/\/+$/, ""); if (!u) ch.url = ""; else if (channelUrlOk(u)) ch.url = u; else errors.push("links.channel.url: لازم يكون رابط قناة واتساب (https://whatsapp.com/channel/…)"); }
      if ("enabled" in C) ch.enabled = C.enabled === true;
      if ("everyDays" in C) { const d = Number(C.everyDays); if (Number.isInteger(d) && d >= 1 && d <= 365) ch.everyDays = d; else errors.push("links.channel.everyDays: من 1 إلى 365"); }
      cur.channel = ch;
    }
    out.links = cur;
  }
  if ("windowV2Stages" in src) { const v = Array.isArray(src.windowV2Stages) ? src.windowV2Stages : []; const bad = v.filter((k) => !WINDOW_V2_STAGES.includes(k)); if (bad.length) errors.push(`windowV2Stages: ${bad.join(",")}`); else out.windowV2Stages = [...new Set(v)]; }
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
  neverReplyPhones: S("mode", "phones", "أرقام البوت مايردش عليها أبداً", "مش عملاء: موظف، مورّد، مندوب، طالب وظيفة. أرقام تنبيهات الفريق وأرقام المناديب بتتستبعد لوحدها (إلا لو الرقم في أرقام التجربة)."),
  liveScope: S("mode", "enum", "نطاق التشغيل للعملاء", "الإعلانات بس / الإعلانات + الأرقام الجديدة / الكل. بره النطاق: البوت يسكت ويسجّل الرد اللي كان هيطلع. أرقام التجربة دايماً جوّه. لازم يتحدد وقت تحويل الوضع لـ«شغّال».", { options: ["ads", "new", "all"] }),
  liveSince: S("mode", "datetime", "بداية التشغيل للعملاء", "بتتسجّل لوحدها أول مرة الوضع يبقى «شغّال». «الأرقام الجديدة» = اللي مالهاش أي رسالة قبل اللحظة دي."),
  mediaFloodBuyerCount: S("limits", "number", "سيل صور والمساعد بيشوف الصور: العدد", "لما المساعد بيشوف الصور، كذا صورة ورا بعض بتتحسب طلب مش سيل. الكتم بيحصل بس بعد العدد ده من غير ولا رسالة نصية ومن غير محادثة طلب شغّالة — وساعتها العميل بياخد سطر واحد والفريق بيتنبّه كعاجل.", { min: 5, max: 200, unit: "صورة" }),
  mediaFloodCount: S("limits", "number", "سيل صور/ملفات من غير نص: العدد", "العدد ده خلال المدة ⇒ البوت يكتم المحادثة ويحوّلها لموظف مرة واحدة. صفر = مقفول.", { min: 0, max: 50, unit: "ملف" }),
  mediaFloodMinutes: S("limits", "number", "سيل صور/ملفات: خلال", "", { min: 1, max: 30, unit: "دقيقة" }),
  mediaFloodMuteHours: S("limits", "number", "سيل صور/ملفات: مدة الكتم", "", { min: 1, max: 168, unit: "ساعة" }),
  openerHours: S("limits", "number", "رسالة مش مدعومة: بداية محادثة لو مابعتناش للرقم خلال", "رسالة واتساب مابيوصّلش محتواها (نوع مش مدعوم) من رقم مابعتناش له حاجة في المدة دي بتاخد الترحيب العادي. جوّه محادثة شغّالة بتاخد سطر «اكتبها نص لو سمحت».", { min: 1, max: 72, unit: "ساعة" }),
  paidNoteEnabled: S("mode", "boolean", "تأكيد الطلب في المحادثة بعد الدفع", "العميل اللي كلّم البوت أو المساعد ودفع طلبه خلال ٢٤ ساعة ونافذة المحادثة لسه مفتوحة: سطر واحد برقم الطلب وزر التتبع. رسالة حرة جوّه النافذة، مش قالب."),
  reviewWhatsApp: S("mode", "boolean", "طلب التقييم بعد التوصيل على واتساب", "بعد التوصيل بالمدة المضبوطة في «التقييمات»: لو العميل كلّمنا في آخر ٢٤ ساعة ⇒ رسالة بزرّين «تمام 👍 / عندي ملاحظة»، وإلا القالب المعتمد «fc_review_request» برابط التقييم. الـSMS بيتبعت بس لو واتساب ماوصلش (القالب اترفض، القناة مقفولة، البوت مش شغّال للعملاء). رسالة واحدة للطلب، ومابتتبعتش أبداً لعميل كتب «إيقاف». مقفول = SMS زي الأول. «تمام» ⇒ رابط التقييم؛ «ملاحظة» ⇒ تحويل للمدير برقم الطلب."),
  courierContact: S("mode", "boolean", "«طلبك مع المندوب»: اسمه وزر «راسل المندوب»", "لو عندنا جوال المندوب (لاجلك / Cervo / خارجي): الرسالة الحرة (والعميل كلّمنا آخر ٢٤ ساعة) فيها اسمه الأول وزر يفتح واتساب المندوب برسالة جاهزة فيها رقم الطلب، ورابط التتبع. الزر رابطنا (مش رقم المندوب) وبيموت بعد التسليم. من غير جوال: زي الأول."),
  courierTemplate: S("mode", "boolean", "«طلبك مع المندوب» بره النافذة: القالب الجديد", "افتحه بعد ما ميتا تعتمد fc_order_on_the_way_courier: بره نافذة الـ٢٤ ساعة يتبعت هو بدل fc_order_on_the_way (لو للمندوب اسم وجوال؛ غير كده القديم)."),
  followLink: S("orderMsgs", "boolean", "زر «📲 تابع طلبك على واتساب» في صفحة الشكر والتتبع", "العميل يضغط ⇒ واتساب يفتح على رقمنا برسالة جاهزة «تابع طلبي W…» ⇒ البوت يرد بحالة الطلب. رسالته دي بتفتح نافذة ٢٤ ساعة، فكل تحديث بعدها بيطلع ببلاش بدل قالب بفلوس. الزر بيظهر بس والبوت «شغّال للعملاء» والطلب لسه ماتسلّمش."),
  followNumber: S("orderMsgs", "phone", "رقم واتساب زر «تابع طلبك»", "الرقم اللي الزر بيفتحه — دولي من غير + (966546715683)."),
  followBanner: S("orderMsgs", "boolean", "بانر «تابع طلبك على واتساب» في الموقع بعد الطلب", "بعد ما العميل يدفع: كارت صغير تحت في صفحة التتبّع (مرة واحدة للطلب) + شريط صغير لو كمّل يتصفّح الموقع، بزرار «افتح واتساب» ⇒ نفس رسالة «مرحبا، أبي أتابع طلبي رقم W…» ⇒ البوت يرد بالحالة والنافذة تتفتح والتحديثات بعدها ببلاش. بيظهر بس والزر نفسه شغّال (المفتاح اللي فوق + البوت «شغّال للعملاء»). أرقامه في «تقرير ماجد»."),
  followBannerSkipHours: S("orderMsgs", "number", "البانر: مايظهرش لو العميل كاتب لنا من أقل من", "العميل اللي كلّمنا على واتساب في المدة دي نافذته مفتوحة والتحديثات هتوصله ببلاش من غير ما يضغط — فمانزعجهوش بالبانر. صفر = يظهر دايماً.", { min: 0, max: 23, unit: "ساعة" }),
  closedPolicy: S("orderMsgs", "boolean", "توفير القوالب والنافذة مقفولة", "العميل ماكلّمناش آخر ٢٤ ساعة: أول رسالة (استلمنا طلبك) قالب، و«مع المندوب» قالب، والتوصيل والتقييم رسالة واحدة — والباقي حسب الخيارات اللي تحت. النافذة مفتوحة ⇒ كل المراحل ببلاش زي ما هي. مقفول = كل مرحلة قالب زي الأول."),
  closedSkipPreparing: S("orderMsgs", "boolean", "النافذة مقفولة: من غير رسالة «بنجهّز طلبك»", "رسالة «استلمنا طلبك» بتقول إننا هنبلّغه بكل تحديث، و«بنجهّز» قالب بفلوس مالوش لازمة. الإشعار (Push) وصفحة التتبع بيفضلوا شغّالين، ومفيش SMS بدلها لو المرحلة «تغني عن الـSMS»."),
  mergeDeliveredReview: S("orderMsgs", "boolean", "النافذة مقفولة: التوصيل والتقييم رسالة واحدة", "رسالة التوصيل الجديدة (v2) فيها زرّين «تمام 👍 / عندي ملاحظة» = نفس سؤال التقييم، فمفيش قالب تقييم تاني لنفس الطلب. ضغطة «تمام» بتبعت رابط التقييم ببلاش."),
  reviewPaidGapMin: S("orderMsgs", "number", "النافذة مقفولة: أقل مدة بين قالبين بفلوس لنفس الطلب", "لو التقييم لسه هيطلع قالب (التوصيل اتبعت من غير الزرّين)، بيستنى المدة دي بعد آخر قالب للطلب. صفر = من غير انتظار.", { min: 0, max: 240, unit: "دقيقة" }),
  windowFreeUpdates: S("mode", "boolean", "نوافذ ٢٤ ساعة: تحديث الطلب ببلاش والنافذة مفتوحة", "العميل كلّمنا (أو ضغط زر) في آخر ٢٤ ساعة: تحديث الطلب بيطلع رسالة حرة ببلاش بنفس نص القالب وزر التتبع (والتوصيل بزرّين «تمام 👍 / عندي ملاحظة») بدل القالب المدفوع. نفس الأقفال والموافقة. مقفول = القالب دايماً."),
  windowV2Stages: S("mode", "keys", "نوافذ ٢٤ ساعة: المراحل اللي نسختها بزر رد سريع اتعتمدت", "بعد ما ميتا تعتمد القالب v2 (نفس النص + زر «تابع طلبي» / «تمام 👍» / «عندي سؤال»)، حط مرحلته هنا فيتبعت بداله. الضغطة على الزر بتفتح نافذة ٢٤ ساعة ببلاش. review = طلب التقييم.", { options: ["pos_created", "accepted", "on_the_way", "delivered", "rejected_refunded", "refund_failed", "review"] }),
  windowSell: S("mode", "boolean", "نوافذ ٢٤ ساعة: سطر الولاء في رد «تمام 👍»", "العميل ضغط «تمام 👍» بعد التوصيل أو التقييم: الرد (رابط التقييم) فيه سطر تقدّم الولاء أو المكافأة، مرة في النافذة، في نفس الرسالة — مش رسالة زيادة."),
  windowKeeper: S("mode", "boolean", "نوافذ ٢٤ ساعة: رسالة واحدة قبل ما تقفل لو مفيدة", "بعد الساعات المضبوطة من آخر رسالة للعميل: رسالة حرة واحدة بس لو فيه سبب مفيد له (طلبه شغّال، مكافأته بتنتهي خلال ٣ أيام، سلة ماكمّلهاش) — غير كده ولا حاجة. مش في ساعات الهدوء، ومش لو اتبعتله رسالة من غير ما يطلب في نفس النافذة، وبسقف يومي وأسبوعي. كل إرسال ونتيجته (رد؟ طلب؟) في التقرير اليومي."),
  windowKeeperHour: S("mode", "number", "رسالة قبل قفل النافذة: بعد", "", { min: 12, max: 23, unit: "ساعة من آخر رسالة للعميل" }),
  windowKeeperDailyCap: S("mode", "number", "رسالة قبل قفل النافذة: أقصى عدد في اليوم", "صفر = مقفول.", { min: 0, max: 500, unit: "رسالة" }),
  windowKeeperWeekly: S("mode", "number", "رسالة قبل قفل النافذة: أقصى عدد للعميل في ٧ أيام", "", { min: 0, max: 7, unit: "رسالة" }),
  windowKeeperQuietStart: S("mode", "number", "رسالة قبل قفل النافذة: ساعات الهدوء من", "بتوقيت الرياض.", { min: 0, max: 23, unit: "س" }),
  windowKeeperQuietEnd: S("mode", "number", "رسالة قبل قفل النافذة: ساعات الهدوء لحد", "", { min: 0, max: 23, unit: "س" }),
  reviewReplyHours: S("mode", "number", "رسالة التقييم: الرد المكتوب بيتحسب لحد", "«تمام» أو «عندي ملاحظة» مكتوبة بإيد العميل (مش ضغطة زرار) خلال المدة دي من رسالة التقييم بتتعامل كأنها الزرار.", { min: 1, max: 72, unit: "ساعة" }),
  leadFollowUpMin: S("mode", "number", "متابعة المحادثة اللي ماخدتش رد مفيد: بعد", "عميل كتب وماخدش رد مفيد (البوت سكت، كان بره النطاق، أو «ما فهمت») ومحدش من الفريق رد: رسالة متابعة واحدة بعد المدة دي. مرة في اليوم للمحادثة، ومابتتبعتش بعد إيقاف أو شكوى أو تحويل مفتوح أو والمطعم مقفل. صفر = مقفول.", { min: 0, max: 180, unit: "دقيقة" }),
  autoInboundPatterns: S("limits", "boolean", "تجاهل الردود الآلية الواردة (بالنص)", "رسالة من رقم نشاط تجاري شكلها رد آلي («شكراً لتواصلك»، «لسنا متوفرين حالياً»، thank you for contacting us…): البوت والمساعد مايردّوش عليها، مفيش تحويل، ومابتتحسبش رد على الحملة."),
  autoInboundSec: S("limits", "number", "رد آلي وارد: خلال كام ثانية من قالبنا", "نص ٢٥ حرف أو أكتر وصل خلال الثواني دي من قالب (حملة / تحديث) بعتناه للرقم = رد آلي، مش عميل بيكتب. صفر = مقفول.", { min: 0, max: 120, unit: "ثانية" }),
  loopGuardCount: S("limits", "number", "حارس الحلقات: كام رسالة سريعة ورا بعض", "رسالة «سريعة» = وصلت خلال الثواني اللي تحت من ردّنا ونصها ٢٥ حرف+ أو نفس اللي قبلها. لما العدد ده يتكرر ورا بعض البوت يكتم المحادثة ويظهر تنبيه واحد في البورتال. صفر = مقفول.", { min: 0, max: 20, unit: "رسالة" }),
  loopGuardFastSec: S("limits", "number", "حارس الحلقات: «سريعة» = خلال", "", { min: 1, max: 30, unit: "ثانية" }),
  loopGuardSeconds: S("limits", "number", "حارس الحلقات: السلسلة بتتصفّر بعد", "", { min: 10, max: 600, unit: "ثانية" }),
  loopGuardMuteHours: S("limits", "number", "حارس الحلقات: مدة الكتم", "", { min: 1, max: 168, unit: "ساعة" }),
  autoEchoSkipCovered: S("staff", "boolean", "اسكت لو الرد الآلي بتاع تطبيق واتساب رد", "مقفول (الافتراضي): البوت يرد على العميل عادي وفوراً حتى لو تطبيق واتساب بزنس بعت رده الآلي. مفتوح: التحية / «كيف أطلب» / العروض تستنى ثواني، ولو التطبيق رد البوت مايردّش فوقه. في الحالتين الرد الآلي مش بيتحسب «موظف»."),
  autoEchoMaxSec: S("staff", "number", "رد آلي من تطبيق واتساب: خلال كام ثانية", "رسالة طالعة من موبايل المطعم خلال الثواني دي من رسالة العميل (ونصها ٢٥ حرف أو أكتر) بتتحسب رد آلي من التطبيق، مش موظف: البوت مايسكتش بسببها. صفر = كل رسالة من الموبايل = موظف.", { min: 0, max: ECHO.maxSecLimit, unit: "ثانية" }),
  autoEchoTexts: S("staff", "texts", "نصوص الردود الآلية بتاعة التطبيق", "نص مكتوب هنا بالحرف بيتحسب رد آلي لو طلع خلال دقيقة من رسالة العميل، حتى لو قصير."),
  greetScope: S("greeting", "enum", "مين يتحيّى", "كل محادثة جديدة، أو محادثات الإعلانات بس.", { options: ["all", "ads"] }),
  greetWindowHours: S("greeting", "number", "تحية واحدة كل", "العميل مايتحيّاش تاني قبل المدة دي.", { min: 1, max: 168, unit: "ساعة" }),
  disclosureMode: S("greeting", "enum", "طريقة التعريف في أول المحادثة", "persona = المساعد بيعرّف نفسه باسمه مرة واحدة في أول رسالة («معك … المساعد الرقمي لفريش كاتس») ومفيش سطر «رد آلي» تحت الرسايل؛ كلمة «موظف» شغّالة دايماً وبتتذكر وقت ما تفيد. classic = السطر القديم «معك المساعد الآلي… اكتب: موظف» وسطر التذييل حسب الإعداد اللي تحت. في الحالتين: لو العميل سأل «انت بوت؟» بيتقال له بصراحة.", { options: ["persona", "classic"] }),
  disclosureHours: S("greeting", "number", "التعريف يتكرر كل", "التعريف بيتقال في أول رد في المحادثة، ويتكرر بعد المدة دي.", { min: 1, max: 168, unit: "ساعة" }),
  footerMode: S("greeting", "enum", "سطر «للرجوع… أو موظف» تحت الرسايل (وضع classic بس)", "كل رسالة / ذكي: الرسالة الغير مفهومة والأزرار اللي مافيهاش زر رجوع أو موظف (أول رسالة فيها التعريف فمش محتاجاه) / أول رسالة بس.", { options: ["always", "smart", "first"] }),
  publicPhone: S("greeting", "phone", "رقم المطعم (بيتقال عند التحويل لموظف)", "بيتكتب تحت سطر «يرد عليك موظف…» في أي تحويل لموظف، ومش في أي رسالة تانية (وفي وضع classic في سطر التعريف كمان). فاضي = الرقم المكتوب في سؤال «كيف أتواصل» في الأسئلة الشائعة."),
  humanPauseMin: S("staff", "number", "سكوت البوت بعد رد الموظف", "من آخر رسالة للموظف من موبايل المطعم، في وقت الدوام.", { min: 1, max: 720, unit: "دقيقة" }),
  staffWaitMin: S("staff", "number", "انتظار الموظف قبل ما البوت يرد", "العميل كتب وقت السكوت والموظف ماردّش: البوت يرد بعد المدة دي (أسئلة مفهومة بس).", { min: 1, max: 15, unit: "دقيقة" }),
  closedEchoPauseMin: S("staff", "number", "سكوت البوت لو الموظف رد والمطعم مقفول", "سكوت قصير بس.", { min: 0, max: 120, unit: "دقيقة" }),
  handoverRealertMin: S("staff", "number", "تحويل ومحدش رد: نبّه الفريق تاني بعد", "من وقت التحويل، لو مفيش موظف كتب للعميل ولا ضغط «تم». صفر = مفيش تنبيه تاني.", { min: 0, max: 60, unit: "دقيقة" }),
  handoverCustomerNoteMin: S("staff", "number", "ولسه محدش رد: رسالة اعتذار واحدة للعميل بعد", "من وقت التحويل. مرة واحدة لكل تحويل، في وقت الدوام بس. صفر = مفيش.", { min: 0, max: 120, unit: "دقيقة" }),
  handoverBurstSec: S("staff", "number", "رسالة تحويل واحدة للشكوى: اللي بعدها خلال", "بعد تحويل شكوى أو «عندي ملاحظة»: الصورة أو النص أو الضغطة اللي بتيجي خلال الثواني دي = نفس الشكوى، بتوصل للموظف في المحادثة من غير رد تاني من البوت ولا تنبيه تاني («محادثتك عند الموظف» ×٣ يوم ١٦/١٠). حالة الطلب والمواعيد و«إيقاف» بيتردّ عليهم عادي. صفر = مقفول.", { min: 0, max: 600, unit: "ثانية" }),
  unknownHandoverAfter: S("staff", "number", "تحويل لموظف بعد كام رسالة مش مفهومة ورا بعض", "٢ = أول مرة القائمة، تاني مرة تحويل.", { min: 1, max: 5, unit: "رسالة" }),
  manualMuteHours: S("staff", "number", "مدة الكتم اليدوي", "المدة الافتراضية لزر «كتم البوت في المحادثة دي».", { min: 1, max: 168, unit: "ساعة" }),
  handoffOpenHours: S("staff", "number", "التحويل لموظف يفضل مفتوح", "طول المدة دي البوت بيرد على المواعيد والموقع وحالة الطلب بس، ومفيش تنبيه مكرر.", { min: 1, max: 168, unit: "ساعة" }),
  staffAlert: S("alerts", "boolean", "SMS للفريق عند التحويل", "في وضع «شغّال»؛ وفي التجربة لو المفتاح اللي بعده مفتوح."),
  alertInTest: S("alerts", "boolean", "ابعت التنبيه في وضع التجربة", ""),
  handoverAckNeedsReply: S("staff", "boolean", "«تم» من غير رد مايقفلش متابعة العميل", "لو الموظف ضغط «تم» في البورتال ومحدش كتب للعميل: التنبيه التاني بيتلغي، بس بعد مدة «رسالة العميل» العميل ياخد رسالة الاعتذار والكارت يرجع يظهر. اقفلها لو الفريق بيرد على العملاء بالتليفون. (تحويل «رقم في قايمة الموظفين» مالوش رسالة عميل، فـ«تم» بتقفله على طول.)"),
  alertPhones: S("alerts", "phones", "أرقام تنبيه التحويل", "فاضي = أرقام الإنذارات في إعدادات التوصيل."),
  maxAlertsPerHour: S("alerts", "number", "أقصى تنبيهات في الساعة", "", { min: 1, max: 30, unit: "تنبيه" }),
  maxAgeMinutes: S("limits", "number", "عمر الرسالة الأقصى", "رسالة وصلت متأخر أكتر من كده مابيتردش عليها.", { min: 1, max: 120, unit: "دقيقة" }),
  sameTextSeconds: S("limits", "number", "تجاهل نفس الرسالة لو اتكررت خلال", "نفس النص من نفس العميل خلال الثواني دي بيتعتبر تكرار (ضغطتين أو إعادة إرسال) ومابيتردّش عليه تاني. بعدها أي تكرار بيترد عليه عادي. صفر = مقفول.", { min: 0, max: 120, unit: "ثانية" }),
  maxRepliesPerHour: S("limits", "number", "أقصى ردود على رسايل مكتوبة في الساعة", "حارس حلقات. عند الحد: سطر واحد هادي، من غير تحويل لموظف، والبوت يرجع لوحده.", { min: 5, max: 300, unit: "رد" }),
  maxTapsPerHour: S("limits", "number", "أقصى ردود على ضغطات القائمة في الساعة", "ضغطات الأزرار والقوايم بتتعدّ لوحدها عشان اللي بيتصفّح مايتقطعش.", { min: 20, max: 1000, unit: "رد" }),
  maxRepliesPerMinute: S("limits", "number", "أقصى ردود في الدقيقة", "حلقة سريعة: البوت يهدّي دقيقة.", { min: 3, max: 30, unit: "رد" }),
  interactive: S("limits", "boolean", "أزرار وقوايم", "مقفول = نص عادي والرابط في آخره."),
  intentsOff: S("limits", "keys", "ردود مقفولة", "أي رد هنا بيتحوّل لموظف بدل ما البوت يجاوب."),
  orderLookbackHours: S("orders", "number", "«وين طلبي» بيدوّر في آخر", "طلبات رقم المرسل نفسه بس.", { min: 1, max: 336, unit: "ساعة" }),
  lateAfterMinutes: S("orders", "number", "الطلب يعتبر متأخر بعد", "طلب نشط أقدم من كده: الحالة + تحويل لموظف.", { min: 20, max: 600, unit: "دقيقة" }),
  activeOrderFirst: S("orders", "boolean", "الطلب الشغّال أولاً: موقع / عنوان / صورة / «زوّد-بدون-ملاحظة» = ملاحظة على طلبه", "العميل اللي عنده طلب مدفوع أو في المطبخ أو مع المندوب وبعت موقعه أو عنوانه («دور 3 شقة 9») أو صورة أو تعديل («زود الخبز»، «بدون بصل»): البوت مايتعاملش معاها كطلب جديد ولا يفتح المساعد — بيسجّلها ملاحظة على الطلب ده (سجل الطلب في اللوحة)، كارت على بوابة الكاشير والمدير، وللمندوب الخارجي على واتساب لو الطلب في الطريق، ويرد للعميل بسطر واحد «وصلتنا ملاحظتك على طلبك رقم … وبلّغنا المطبخ/المندوب». الشكوى والإلغاء و«وين طلبي» بيمشوا في طريقهم العادي. (١٦/١٠: ٣ حالات)"),
  activeOrderHours: S("orders", "number", "الطلب الشغّال: خلال", "طلب أقدم من كده (أو اتسلّم / اتسترجع) مابيتحسبش شغّال، والرسالة بتمشي عادي.", { min: 1, max: 24, unit: "ساعة" }),
  activeOrderMergeSec: S("orders", "number", "ملاحظات ورا بعض على نفس الطلب: تأكيد واحد خلال", "موقع + عنوان + صورة في دقيقة = رسالة تأكيد واحدة؛ الباقي بيتسجّل على الطلب ويوصل للفريق من غير رسالة للعميل. صفر = تأكيد لكل رسالة.", { min: 0, max: 600, unit: "ثانية" }),
  reorderEnabled: S("orders", "boolean", "«نفس طلبي الأخير» بضغطة", "للعميل اللي طلب من الموقع قبل كده: صف في التحية، وبضغطة يوصله رابط سلة جاهزة بنفس طلبه (بعد التأكد إن الأصناف متاحة)."),
  reorderMaxDays: S("orders", "number", "آخر طلب يتعرض لو عمره أقل من", "", { min: 1, max: 365, unit: "يوم" }),
  reorderLinkDays: S("orders", "number", "صلاحية رابط السلة الجاهزة", "", { min: 1, max: 30, unit: "يوم" }),
  reorderMinTotal: S("orders", "number", "أقل قيمة أصناف لطلب يتعرض", "طلبات التجربة الصغيرة بتتخطّى.", { min: 0, max: 500, unit: "ر.س" }),
  reorderLookback: S("orders", "number", "لو آخر طلب مايتجهّزش: نجرّب اللي قبله لحد", "أول طلب يتجهّز على المنيو الحالي هو اللي بيتعرض، والرد بيقول يوم الطلب.", { min: 1, max: 10, unit: "طلب" }),
  campaignCart: S("orders", "boolean", "حملة «طبقك المفضل»: «أبغى أطلب» ⇒ سلة جاهزة بالعرض", "العميل وصلته رسالة الحملة (بوكس فيه طبقه المفضل أو طبقه نفسه بسعره وسعر التوصيل لعنوانه) وضغط «أبغى أطلب» أو رد «نعم»: البوت بيحسب نفس العرض تاني بالسعر والتوصيل الحين ويبعت رابط سلة جاهزة بيه. العرض اتغيّر أو خلص أو المفتاح مقفول ⇒ رد «أبي أطلب» العادي."),
  campaignOfferHours: S("orders", "number", "حملة «طبقك المفضل»: العرض المخزّن بيتقرا لحد", "من وقت إرسال رسالة الحملة للعميل.", { min: 1, max: 168, unit: "ساعة" }),
  campaignYesQuietMin: S("orders", "number", "حملة «طبقك المفضل»: «نعم» المكتوبة مش موافقة لو المحادثة كانت شغّالة قبل الرسالة بـ", "رد «نعم» على سؤال من البوت أو المساعد أو الموظف اتسأل قبل الحملة بالمدة دي بيمشي في طريقه العادي (ضغطة زر «أبغى أطلب» نفسه مش داخلة في الشرط ده). ٠ = من غير الشرط.", { min: 0, max: 720, unit: "دقيقة" }),
  campaignReply: S("orders", "boolean", "«أبغى أطلب» على رسالة حملة ⇒ عرض الحملة نفسها", "العميل ضغط زر «أبغى أطلب» تحت رسالة حملة واتساب (أو كتب «أبغى أطلب» من غير ما يحدد حاجة) والحملة وصلته في المدة اللي تحت: البوت بيرد بسطر فيه العرض ده باسمه وسعره وآخر يوم، ورابط الحملة نفسها (الضغطة بتتحسب على الحملة)، و«اطلبه من الزر أو اكتب لي وش تبي». لو المساعد شغّال للرقم ده، «نعم / ايوه / ابغاه» بعدها بتروح له وهو عارف العرض فيكمّل للسلة. طلب مكتوب فيه صنف أو عدد («ابي اطلب كيلو مشكل») بيمشي في طريقه العادي. حملة «طبقك المفضل» ليها ردها (سلة جاهزة). العرض خلص، أو رابطه موقوف، أو البوكس اتشال ⇒ رد «أبي أطلب» العادي. لو سعر البوكس اتغيّر من ساعة الرسالة ⇒ العرض من غير رقم. مقفول ⇒ رد «أبي أطلب» العادي زي الأول."),
  campaignReplyHours: S("orders", "number", "رسالة الحملة بتتقرا للرد ده لحد", "من وقت وصول رسالة الحملة للعميل. أقدم من كده ⇒ رد «أبي أطلب» العادي.", { min: 1, max: 168, unit: "ساعة" }),
  firstCode: S("orders", "code", "كود أول طلب", "الكود اللي سطر «أول طلب» بيقرا شروطه من الكوبونات."),
  "links.organic": S("links", "slug", "رابط المحادثات العادية", "من «روابط الحملات»."),
  "links.ads": S("links", "slug", "رابط محادثات الإعلانات", ""),
  "links.packs": S("links", "slug", "رابط رد «باقات التجمعات»", "الزر تحت قايمة الباقات بيفتح الرابط ده. لو الرابط مقفول أو مش موجود، الزر يرجع للرابط العادي."),
  "links.adMap": S("links", "map", "رابط لكل إعلان", "رقم الإعلان ← الرابط."),
  "links.channel.enabled": S("links", "boolean", "دعوة قناة واتساب", "صف «قناة العروض» في قايمة الترحيب + سطر واحد بعد ما المحادثة تخلص. من غير رابط القناة مفيش حاجة بتظهر."),
  "links.channel.url": S("links", "url", "رابط القناة", "لازم يبدأ بـ https://whatsapp.com/channel/ (من «معلومات القناة» ← «رابط القناة»). فاضي = الدعوة نايمة."),
  "links.channel.everyDays": S("links", "number", "الدعوة مرة واحدة للعميل كل", "البوت والمساعد بيعدّوا على نفس العدّاد.", { min: 1, max: 365, unit: "يوم" }),
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
  ...FU_SCHEMA,      // FU1 (١٥/١٠): متابعة اللي ردّ وماطلبش — مجموعتها لوحدها في اللوحة
  ...JOURNEY_SCHEMA, // CJ1a (١٧/١٠): «رحلة العميل في النافذة: مفيش رسايل ورا بعض» — بتظهر في «كل إعدادات البوت» من غير تعديل في اللوحة
  ...ASSIST_SCHEMA,
  ...COURIER_JOB_SCHEMA,      // CW1: «🛵 المندوب الخارجي: الأزرار على واتساب» — بتظهر في «كل إعدادات البوت» من غير تعديل في اللوحة
  ...REVIEW_FLOW_SCHEMA,      // RV1: «التقييمات على واتساب» — بتظهر في «كل إعدادات البوت» من غير تعديل في اللوحة
});
export const SCHEMA_GROUPS = Object.freeze({ mode: "الوضع", orderMsgs: "رسايل الطلب: توفير القوالب وزر «تابع طلبك»", [FU_GROUP]: FU_GROUP_AR, [JOURNEY_GROUP]: JOURNEY_GROUP_AR, greeting: "التحية والتعريف", staff: "البوت والموظف", alerts: "التنبيهات", limits: "الحدود", orders: "الطلبات", links: "الروابط", data: "البيانات الحيّة",
  faq: "الأسئلة الشائعة", texts: "النصوص", optin: "موافقة التحديثات", ai: "الذكاء الاصطناعي", cost: "التكلفة", assist: "مساعد الطلبات", ...REVIEW_SCHEMA_GROUP, ...COURIER_JOB_SCHEMA_GROUP });
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
  /* PS1b (عمر ١٣/١٠: «الرقم يتقال عند التحويل لموظف بس»): سطر الانتظار في أي تحويل لموظف بينتهي برقم المطعم — من إعداد الرقم (publicPhone، وإلا رقم «كيف أتواصل» في الأسئلة الشائعة). مفيش رقم ⇒ مفيش سطر. */
  const callLine = () => { try { const phone = publicPhoneOf(cfg, data.settings); return phone ? `\n${fill("call_line", textOf(cfg, "call_line", lang), { phone })}` : ""; } catch { return ""; } };
  const wait = () => `${data.open && data.open.open === true ? T(softWait ? "when_open_assist" : "when_open") : closedLine(cfg, lang, data, softWait ? "wait_line_assist" : "wait_line")}${callLine()}`;
  const order = data.order || null;
  const withLink = (k, vars, ctaKey) => { const slug = pickLink(cfg, data, c.referral); return { body: F(k, vars), cta: { title: T(ctaKey), url: linkUrl(slug) }, link: slug }; };
  switch (key) {
    /* صف «قناة العروض»: العميل هو اللي ضغط. القناة اتقفلت بعد ما القايمة اتبعتت ⇒ القائمة الرئيسية بدل رابط ميت. */
    case "channel": {
      if (!channelOn(cfg)) return buildReply("main", c);
      return { body: T("channel_body"), cta: { title: T("cta_channel"), url: cfg.links.channel.url }, channel: "rules_menu" };
    }
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
      let more = null; if (cfg.assist && cfg.assist.menuToRules && key === "cats") { try { more = withLink("menu_link_line", {}, "cta_menu"); } catch { more = null; } }      // PS4: «المنيو» = قايمة الأقسام + زر رابط المنيو
      return { body: T("cats_body"), list: { button: T("list_btn"), rows }, ...(more ? { extra: [more], link: more.link } : {}) };
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
      /* PS5: مشوي له وجبة وبالوزن، والعميل ماحددش (مفيش «وجبة» ولا وزن في رسالته، ومش ضغطة على صنف بعينه) ⇒ الاتنين بأسعارهم وزرّين. */
      if (cfg.assist && cfg.assist.grillFamilies && !it.soldOut && c.asked != null && !/(^| )(وجبه|وجبات|بالوزن|كيلو|نص|نصف|ثلث|تلت|kilo|kg|half|meal)( |$)/i.test(normalize(String(c.asked)))) {
        const pair = grillFamilies(data.menu).get(String(it.id));
        if (pair && !pair.meal.soldOut && !pair.weight.soldOut && weightsLine(lang, pair.weight)) { const en = lang === "en";
          return { body: F("item_two_ways", { meal: en ? pair.meal.nameEn || pair.meal.name : pair.meal.name, meal_price: priceText(lang, pair.meal), meal_desc: en ? "" : pair.meal.desc, weight: en ? pair.weight.nameEn || pair.weight.name : pair.weight.name, weight_prices: weightsLine(lang, pair.weight) }),
            buttons: [{ id: `item:${pair.meal.id}`, title: T("btn_meal") }, { id: `item:${pair.weight.id}`, title: T("btn_weight") }] }; } }
      const nm = lang === "en" ? (it.nameEn || it.name) : it.name, desc = lang === "en" || isMashakel(it) ? "" : it.desc;
      const wl = weightsLine(lang, it);
      const body = wl ? F("item_weights", { name: nm, prices: wl, desc, note: it.soldOut ? T("sold_line") : "" }) : F("item_body", { name: nm, price: priceText(lang, it), desc, note: it.soldOut ? T("sold_line") : "" });
      /* خلص اليوم ⇒ من غير زر «اطلبه الآن»: نعرض الأقسام بدله (M3). */
      if (it.soldOut) return { body, buttons: [{ id: "m:cats", title: T("row_cats") }, { id: "m:boxes", title: T("row_boxes") }, { id: "bot:menu", title: T("btn_main") }] };
      return { body, cta: { title: T("cta_item"), url: `${linkUrl(slug)}#item-${it.id}` }, link: slug };
    }
    case "weight": {
      /* الوزن وسعره من المنيو الحي وقت الرد (مش من الرسالة). الزر: سلة جاهزة فيها السطر بالوزن (اتعملت قبل البناء)، ولو ماتعملتش ⇒ صفحة الصنف. */
      const a = c.arg && typeof c.arg === "object" ? c.arg : {};
      const it = data.menu && data.menu.items ? data.menu.items.find((i) => i.id === String(a.id)) : null;
      if (!it || !Array.isArray(it.weights)) throw new DataMissing("item");
      if (it.soldOut) return buildReply("item", { ...c, arg: String(it.id) });
      const rows = (Array.isArray(a.parts) ? a.parts : []).map(([vid, qty]) => ({ w: it.weights.find((x) => String(x.variant_option_id) === String(vid)), qty: Math.max(1, Math.round(Number(qty) || 1)) }));
      if (!rows.length || rows.some((r) => !r.w)) return buildReply("item", { ...c, arg: String(it.id) });
      const nm = lang === "en" ? (it.nameEn || it.name) : it.name, sar = (v) => (lang === "en" ? `SAR ${money(v)}` : `${money(v)} ر.س`), wn = (w) => (lang === "en" ? w.label_en : w.label_ar);
      const slug = data.links && data.links["wab-menu"] === true ? "wab-menu" : pickLink(cfg, data, c.referral);
      const cart = data.weightCart && data.weightCart.url ? data.weightCart.url : null;
      const body = rows.length === 1 && rows[0].qty === 1 ? F("weight_one", { name: nm, weight: wn(rows[0].w), price: sar(rows[0].w.price), note: "" })
        : F("weight_many", { name: nm, lines: rows.map((r) => `• ${wn(r.w)} × ${r.qty}: ${sar(r.w.price * r.qty)}`).join("\n"), total: sar(rows.reduce((t0, r) => t0 + r.w.price * r.qty, 0)) });
      return cart ? { body, cta: { title: T("cta_reorder"), url: cart } } : { body, cta: { title: T("cta_item"), url: `${linkUrl(slug)}#item-${it.id}` }, link: slug };
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
      const ans = faqAnswer(String((lang === "en" ? row.en || row.ar : row.ar) || ""), c.asked || "");      // مفيش ترجمة ⇒ العربي المعتمد. السطور المشروطة: بس لو العميل سأل عنها (PS3)
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
      const rows = [["m:boxes", "row_boxes"], ["m:cats", "row_cats"], ["m:offers", "row_offers"], ["m:delivery", "row_delivery"], ["m:status", "row_status"], ...(channelOn(cfg) ? [["m:channel", "row_channel"]] : []), ["m:human", "row_human"]].map(([id, k]) => ({ id, title: T(k) }));
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
    case "order": {
      /* FD1: «أبغى أطلب» على رسالة حملة «طبقك المفضل» ⇒ نفس العرض اللي وصله (محسوب تاني الحين) + رابط سلة جاهزة بيه (اتعملت قبل البناء في work).
         بوكس «من نوع أكله» من غير طبقه ⇒ البوكس نفسه يختار هو. العرض اتغيّر/خلص ⇒ data.campaign فاضي ⇒ الرد العادي تحت. */
      const cp = data.campaign && data.campaign.ok ? data.campaign : null;
      const vars = { offer: cp ? cp.line : "", paused: pausedLine(cfg, lang, data), closed: closedLine(cfg, lang, data, "closed_short") };
      /* CR2: «أبغى أطلب» على رسالة حملة تانية ⇒ عرض الحملة دي (اسمه + سعره + آخر يوم) ورابطها لنفس المستلم — الضغطة بتتحسب على الحملة */
      const cr = !cp && data.campReply && data.campReply.ok ? data.campReply : null;
      if (cr) {
        const head = [`*${cr.title}*`, cr.price != null ? F("camp_reply_price", { price: money(cr.price) }) : ""].filter(Boolean).join(" ") + (cr.until ? `${lang === "en" ? ", " : "، "}${F("camp_reply_until", { until: cr.until })}` : "");
        return { body: F("camp_reply_body", { ...vars, offer: head }), cta: { title: T("cta_order"), url: cr.url }, link: cr.slug };
      }
      if (cp && cp.url) return { body: F("camp_order_body", { ...vars, picks: cp.picks && cp.picks.length ? F("camp_picks", { names: cp.picks.join(lang === "en" ? ", " : "، ") }) : "" }), cta: { title: T("cta_reorder"), url: cp.url }, link: "wa-campaign" };
      if (cp && cp.boxSlug) {
        if (data.links && data.links[cp.boxSlug] === true) return { body: F("camp_box_body", vars), cta: { title: T("cta_box"), url: linkUrl(cp.boxSlug) }, link: cp.boxSlug };
        return withLink("camp_box_body", vars, "cta_box");
      }
      return withLink("order", { first: firstLine(cfg, lang, data), paused: pausedLine(cfg, lang, data), closed: closedLine(cfg, lang, data) }, "cta_order");
    }
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
      /* M4: «ادفع تحويل / كاش؟» ⇒ السطر المباشر (نص المالك payment_no_cash_transfer) أولاً، وبعده طرق الدفع. */
      let first = ""; if (c.arg === "no_cash_transfer") { try { first = T("payment_no_cash_transfer"); } catch { first = ""; } }
      const pay = F("payment", { payment: String(ans || "").trim() });
      return { body: first ? `${first}\n${pay}` : pay };
    }
    case "status": {
      if (data.orderDbFailed) throw new DataMissing("orders_db");
      /* EX4 (عمر ١٣/١٠): حالة الطلب للطلب **المفتوح** بس. مفيش طلب، أو آخر طلب اتسلّم/اتلغى ⇒ سطر صريح + زرارين (القائمة / موظف)، من غير تحويل تلقائي.
         طلب اترفض واترجّع فلوسه (أو الاسترجاع لسه معلّق) بياخد حالته الحقيقية: ده اللي العميل بيسأل عنه. */
      if (!order || (ORDER_DONE.has(String(order.status || "")) && !["rejected_refunded", "refund_failed"].includes(String(order.status)))) {
        const sk0 = order ? orderStatusKey(order) : null, lines0 = T("status_no_open").split("\n");
        const last = sk0 ? F("status_last_closed", { order_no: order.order_no, status: T(sk0.key) }) : "";
        return { body: last ? [lines0[0], last, ...lines0.slice(1)].join("\n") : lines0.join("\n"), buttons: [{ id: "bot:menu", title: T("btn_menu") }, { id: "bot:human", title: T("btn_human") }] };
      }
      const sk = orderStatusKey(order);
      if (!sk) throw new DataMissing(`status:${order.status}`);
      const mins = (data.now.getTime() - Date.parse(order.created_at)) / 60000;
      const late = ACTIVE.has(String(order.status)) && Number.isFinite(mins) && mins > cfg.lateAfterMinutes;
      const vars = { order_no: order.order_no, status: T(sk.key), wait: late ? wait() : "" };
      const r = { body: F(late ? "status_late" : "status_found", vars), cta: { title: T("cta_track"), url: `${STORE}/track/${encodeURIComponent(order.order_no)}` } };
      if (c.follow && !late) r.body = `${r.body}\n${T("status_follow")}`;      // ١٤/١٠: جاي من زر «تابع طلبك» ⇒ سطر إن التحديثات هتيجي هنا
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
      /* EX6: «مسببات الحساسية» للصنف (من غير مسبّب محدد) ⇒ المسجّل في بياناته بس + سطر المطبخ + سطر ملاحظة الطلب. مفيش بيانات ⇒ الصراحة (df_unknown). */
      if (a.list) {
        const al = dishAllergens(a.id);
        if (!al) return { body: F("df_unknown", { note: T("df_note_line") }), fact: "unknown:no_list" };
        return { body: F("df_list", { dish: lang === "en" ? al.dishEn : al.dish, list: al.groups.map((g) => (lang === "en" ? g.en : g.ar)).join(lang === "en" ? ", " : "، "), kitchen: T("kitchen_line"), fryer: al.fryer ? T("fryer_line") : "", note: T("df_note_line") }), fact: "list" };
      }
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
    case "media_location": return { body: T(key) };
    case "problem": case "change": case "human": case "staff": case "media": case "media_payment": case "media_order": case "data_missing": case "handoff_remind": case "custom_offer":
      return { body: F(key === "media" && c.arg === "voice" ? "media_voice" : key, { wait: wait() }) };      // PK1: الصوت ⇒ سطر «اكتب لي طلبك» + التحويل زي ما هو
    case "rate": case "rate_burst": return { body: T(key) };
    case "unknown": return { body: T("unknown"), buttons: [{ id: "bot:menu", title: T("btn_main") }, { id: "bot:status", title: T("btn_status") }, { id: "bot:human", title: T("btn_human") }] };
    case "stop": return { body: T("stop"), buttons: [{ id: "stop:undo", title: T("btn_stop_undo") }, { id: "stop:updates", title: T("btn_stop_updates") }, { id: "stop:ok", title: T("btn_ok") }] };
    case "stop_updates": return { body: T("stop_updates"), buttons: [{ id: "resume:updates", title: T("btn_resume_updates") }, { id: "resume:all", title: T("btn_resume_all") }] };
    case "unsupported": return { body: T("unsupported_line") };
    case "repeat_short": return { body: T("repeat_short"), buttons: [{ id: "bot:human", title: T("btn_human") }] };
    case "other_city": return { body: T("other_city") };
    case "delivery_time": return { body: T("delivery_time") };
    case "whoami": { const m = buildReply("main", c); return { ...m, body: personaOn(cfg) ? honestText(cfg, "whoami_persona", lang) : F("whoami", { who: disclosureLine(cfg, lang, data.settings) }) }; }
    case "cancel_what": return { body: T("cancel_what"), buttons: [{ id: "cw:order", title: T("btn_cancel_order") }, { id: "cw:stop", title: T("btn_stop_msgs") }] };
    case "thanks": case "start": return { body: T(key) };
    /* SB2 — الرد على رسالة التقييم: «تمام» ⇒ رابط صفحة التقييم بتاعة الطلب (نفس التوجيه المعروف)، «ملاحظة» ⇒ المدير برقم الطلب */
    case "review_ok": { const code = c.arg && c.arg.code, extra = c.arg && c.arg.extra ? `\n${c.arg.extra}` : "";      // SB4: سطر الولاء (مرة في النافذة) في نفس الرسالة
      if (!/^[a-z0-9]{4,16}$/i.test(String(code || ""))) return { body: `${T("rv_ok_nolink")}${extra}` };
      /* RV1: النجوم جوّه المحادثة بدل رابط الصفحة (الضغطة فتحت النافذة ⇒ القايمة ببلاش). الطلب اتقيّم قبل كده ⇒ شكر بس. */
      if (cfg.reviewFlow && cfg.reviewFlow.enabled) return c.arg.rated ? { body: T("rs_already") } : starsAskReply({ T, F, kind: c.arg.kind || null, orderNo: c.arg.ref || c.arg.order || null, code, lead: "ok" });
      return { body: `${T("rv_ok")}${extra}`, cta: { title: T("cta_rate"), url: `${STORE}/r?c=${encodeURIComponent(code)}` } }; }
    /* RV1: ضغطة نجوم (arg من wareviews.applyStar في work: route/link/ref/reviewId) ⇒ جوجل للعالي، اعتذار + الأسباب + المدير للواطي */
    case "review_star": return starReply({ T, F, arg: c.arg || {}, callLine: c.arg && c.arg.route === "low" ? callLine() : "" });
    case "review_reason": return { body: T("rs_reason_ok") };
    /* RV1: رقم الطلب في الرد = رقم طلب موقع بس (دعوة الكاشير «pos:…» رقم داخلي)؛ من غير رقم ⇒ سطر «طلب رقم» بيتشال بدل ما يفضل فاضي */
    case "review_note": { const no = /^W\d{6,20}$/.test(String((c.arg && c.arg.order) || "")) ? String(c.arg.order) : "";
      const body = F("rv_note", { order_no: no, wait: wait() });
      return { body: no ? body : body.split("\n").filter((l) => !/^(طلب رقم|Order)$/.test(l.trim())).join("\n"), handoff: HANDOFF_KEYS.review_note }; }
    /* FU1 — الرد على رسالة «متابعة اللي ردّ»: «أبغى أطلب» والمتابعة كان فيها سلة جاهزة لسه صالحة (work بيتأكد) ⇒ نفس السلة بزر؛ من غير سلة ⇒ رد «أبي أطلب» العادي.
       «لا شكراً» ⇒ سطر واحد (والـ٧ أيام بتتسجّل في work). */
    case "rf_yes": {
      const url = c.arg && typeof c.arg === "object" ? String(c.arg.url || "") : "";
      if (!/^https:\/\/freshcuts\.sa\/c\/[a-z0-9]{6,16}$/.test(url)) return buildReply("order", c);
      return { body: T("rf_yes_cart"), cta: { title: T("cta_reorder"), url }, link: "wa-followup" };
    }
    case "rf_no": return { body: T("rf_no") };
    default: throw new DataMissing(`key:${key}`);
  }
}
/* حقيقة صنف لمساعد الطلبات: **نفس النص المعتمد** اللي بوت القواعد بيرد بيه (df_*)، والمساعد بيبعته زي ما هو — مفيش صياغة من الموديل في سؤال حساسية.
   ⇒ { status, say } أو { status, handover: "allergy_severe" | "needs_staff" } (حساسية شديدة، مقفول من اللوحة، أو مش مؤكد). */
export function dishFactSay(cfg, data, { id, question, remove = false, list = false, lang = "ar" } = {}) {
  try {
    const r = buildReply("dishfact", { cfg, lang: lang === "en" ? "en" : "ar", data: data || {}, referral: null, factual: false, arg: { id: String(id || ""), text: String(question || ""), remove: remove === true, ...(list === true ? { list: true } : {}) } });
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
/* M3: الصنف بالوزن بيتقال بأوزانه وأسعارها الحقيقية («ثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س»). «من X» بس لو الأوزان مش متاحة الحين. */
export const weightsLine = (lang, i) => (i && Array.isArray(i.weights) && i.weights.length ? i.weights.map((w) => (lang === "en" ? `${w.label_en}: SAR ${money(w.price)}` : `${w.label_ar}: ${money(w.price)} ر.س`)).join(" · ") : "");
const priceText = (lang, i) => (i.byWeight ? (weightsLine(lang, i) || (lang === "en" ? `from SAR ${money(i.price)}` : `من ${money(i.price)} ر.س`)) : (lang === "en" ? `SAR ${money(i.price)}` : `${money(i.price)} ر.س`));
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
    if (!/^https:\/\/(freshcuts\.sa\/(l\/[a-z0-9-]+(#item-\d{1,6})?|track\/W\d{6,20}|c\/[a-z0-9]{6,16}|r\?c=[a-z0-9]{4,16})$|maps\.google\.com\/|www\.google\.com\/maps|maps\.app\.goo\.gl\/|g\.page\/|(www\.)?whatsapp\.com\/channel\/[A-Za-z0-9]{8,64}$)/.test(String(a.url || ""))
      && !reviewCtaOk(a.url)) return "cta_url";      // آخر نمط: رابط قناة واتساب (links.channel.url) بشكله المضبوط بس · RV1: زر جوجل (عدّادنا /api/reviews/g/<كود> أو رابط «اكتب تقييم» بتاع جوجل)
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
const ALLERGY_ASK_RE = /حساسي|allerg/;
function dishOf(text, e, know) {
  const ids = e.itemId ? [String(e.itemId)] : (e.items || []).map(String);
  const all = (know.menu && know.menu.items) || [];
  const cands = ids.length ? all.filter((i) => ids.includes(String(i.id))) : all;
  const hit = pickDish(text, cands.map((i) => ({ id: i.id, name: i.name })));
  return hit || (ids.length === 1 ? ids[0] : null);
}
/* «نفس الطلب / زي آخر مرة / كرر الطلب / المعتاد» — بعد التطبيع (ة⇒ه، أ⇒ا) */
const REORDER_RE = /(نفس|زي|مثل) (ال)?(طلب|طلبي|طلبنا|اخر مره|المره اللي فاتت|المره الماضيه)|كرر(وا|و)? ?(لي )?(ال)?(طلب|طلبي)|(ال)?معتاد|same (order|as last)|re-?order|the usual/i;
const CITY_RE = /(?<![\p{L}])(?:(?:ب|ل|في )?(?:مكه|ينبع|رابغ|تبوك|نجران|جازان|جيزان|بريده|خميس مشيط|المدينه المنوره)|(?:ال|لل|بال)(?:رياض|طايف|طائف|دمام|ظهران|قصيم|جبيل|احساء|قنفذه|ليث|خبر الشرقيه)|makkah|mecca|taif|riyadh|dammam|khobar|madinah|medina|yanbu|abha|tabuk)(?![\p{L}])/u;
const CITY_STREET_RE = /(?:طريق|شارع|حي|خط|كوبري|دوار|مخرج|جسر|مخطط|سوق|street|road|rd) (?:ال)?(?:مكه|مدينه|رياض|طايف|طائف|makkah|mecca|madinah|medina)/;
const EXTRA_INTENTS = [
  /* شكوى على الطلب / المندوب ⇒ موظف عاجل برقم الطلب */
  [/(جاني|وصلني|جابو لي|جابوا لي|جاب لي|استلمت) طلب (غيري|غلط|ثاني|مو طلبي|مش طلبي)|(مو|مش|ما هو) طلبي|طلب غيري|(المندوب|السواق|السايق|الكابتن|الدليفري) (ما|مو|مش|لا|لسه ما|لسا ما) ?(يرد|رد|وصل|جا|جاء|لقاني|يلقاني|جاني)|المندوب مايرد|wrong order|driver (is not|isn't|not) (answering|here)/, "complaint", null, "order_issue"],
  /* مصدر اللحم ⇒ إجابة المالك المعتمدة faq:meat (مش قايمة أصناف ولا أي تفصيلة مننا). «مين المورد» بيفضل secret: اسم المورّد سر تجاري (قاعدة عمر ١٢/١٠). */
  [/من (وين|فين|اين) (تجيبون|تجيبوا|تجيبو|تاخذون|تشترون|تشتروا|جايبين) (ال)?(لحم|لحمه|لحوم|دجاج|فراخ)|مصدر (ال)?(لحم|لحوم|دجاج)|لحمكم (من وين|بلدي|مستورد)|where (do you get|is) (the|your) meat( from)?/, "faq", "meat", "meat_source"],
  /* «انت بوت؟ / مين معي» ⇒ سطر التعريف + القائمة */
  [/^(انت|انتي|انتم|هل انت|هل انتم) (بوت|روبوت|انسان|بشر|الي|رد الي|شخص حقيقي|موظف)( ولا (انسان|بوت|بشر|موظف))?$|^(مين|من|منو) (معي|معايا|يكلمني|بيكلمني|انت|انتم)$|^(اكلم|بكلم) مين$|^(مع )?(مين|من|منو) (اتكلم|بتكلم|اكلم|بكلم|احكي|اللي يرد علي|يرد علي)( معه| معاه)?$|^(انت|انتي|هل انت) (حقيقي|حقيقيه|شخص|ادمي)$|are you (a |an )?(bot|robot|human|real|ai|person)|is this (a |an )?(bot|robot|real person|human|person|ai)|am i (talking|speaking|chatting) (to|with) (a |an )?(bot|robot|human|real person|person|machine|ai)|who (is this|am i (talking|speaking) (to|with))/, "whoami", null, "who_are_you"],
  /* الدفع تحويل / كاش / حساب بنكي ⇒ السطر المباشر + طرق الدفع */
  [/(ادفع|دفع|الدفع|احاسب|احاسبكم) (ب)?(تحويل|كاش|نقد|نقدي|عند الاستلام)|تحويل بنكي|(ابي|ابغى|عايز|عايزه|عاوز|عاوزه|ودي|ممكن|اعطني|عطني|ارسل|ارسلي|ابعت|ابعتي) (لي )?(رقم )?(ال)?(حساب|ايبان)|حساب عشان (احول|احولك|احولكم)|احول (لك|لكم|عليكم|على حسابكم)|احولك|احولكم|pay (by|with|in) (cash|transfer)|bank transfer|cash on delivery/, "payment", "no_cash_transfer", "payment_method_q"],
  /* «كم الحساب / المجموع» ⇒ حالة الطلب لو له طلب مفتوح، وإلا «كيف أطلب» (resolveByOrder بعد تحميل الطلب) */
  [/^(كم|بكم|ايش|وش) (صار )?(ال)?(حساب|مجموع|اجمالي|توتال)( كله| الكلي)?$|^(ال)?(حساب|مجموع|اجمالي) (كم|بكم)$|^how much is (the|my) (total|bill)$/, "bill", null, "bill_question"],
  /* «كم باقي / متى يوصل» ⇒ حالة الطلب لو له طلب مفتوح، وإلا رد مدة التوصيل القصير */
  [/^(كم|قد ايش|قديش) (باقي|فاضل|بقى|يبقى)( له| عليه| على الطلب| ويوصل)?$|^باقي كم$|^(متى|امتى|امتا) (يوصل|يوصلني|توصل|يجي|يجيني|يجهز|بيوصل|هيوصل)( الطلب| طلبي)?$|^(كم|قد ايش) (ياخذ|ياخد|يستغرق|مده|وقت) (ال)?توصيل( تقريبا)?$|^how long (does|will) (the )?delivery take$|^when will it arrive$/, "eta", null, "eta_question"],
  /* صيغ عامة من سجل الإعادة كانت «ما فهمت»: «الو / اخبارك / كيف حالك» ⇒ ترحيب · «اشكرك» ⇒ شكر · «ثواني / لحظة» ⇒ تمام (مفيش رد) · «ما اسمك» ⇒ تعريف · «مش عارف آكل إيه / جوعان / ايش تقترح» ⇒ الأكثر طلباً */
  [/^(الو+|هالو|اخبارك|اخبارك ايه|ايش اخبارك|وش اخبارك|كيف حالك|كيف الحال|كيفك|شلونك|عامل ايه|ازيك)( يا [\p{L}]+)?$/u, "greet", null, "greet"],
  [/^(اشكرك|اشكركم|نشكركم|شاكر لك|شاكره لك|ممنون|ممنونك)( جدا| كثير| جزيلا)?$/, "thanks", null, "thanks"],
  [/^(ثواني|ثانيه|ثانيه بس|لحظه|لحظات|دقيقه|دقيقه بس|لحظه بس|ثواني بس|sec|one sec|one moment|wait)$/, "ack", null, "ack"],
  /* PS3: صيغ «فين المكان» القصيرة والمصرية. «في المكان» لوحدها = «فين المكان» (rawIntent where_typo: جوّه محادثة المساعد بعد سؤال «توصيل ولا استلام» ممكن تبقى «آكل عندكم» — التلميح بيقول له). */
  [/^(في|فى) (ال)?(مكان|مكانكم)$/, "location", null, "where_typo"],
  [/^(فين|وين|اين|فينكم|وينكم)( (ال)?(مكان|مكانكم|موقع|موقعكم|محل|محلكم|مطعم|مطعمكم|فرع|فرعكم|عنوان|عنوانكم|لوكيشن))?( بالضبط| بالظبط)?$|^(ال)?(مكان|مكانكم|موقع|موقعكم|محل|محلكم|مطعم|مطعمكم|فرع|فرعكم|عنوان|عنوانكم|لوكيشن) (فين|وين|اين)( بالضبط| بالظبط)?$|^(انتو|انتوا|انتم|انت) (فين|وين)( بالضبط| بالظبط)?$|^(فين|وين) [^ ]+( [^ ]+)? ولا (فين|وين)$|^(ابعت|ابعتلي|ارسل|ارسلي|ارسل لي|عطني) (ال)?(لوكيشن|موقع|موقعكم|عنوان)$/, "location", null, "where"],
  [/^(ما|وش|ايش|ايه|شنو) ?(هو )?اسمك$|^اسمك (ايه|ايش|وش)$|^what('s| is) your name$/, "whoami", null, "who_are_you"],
  [/(مش|مو|ماني|مب|ما) (عارف|عارفه|ادري) (اكل|اطلب|اخذ|اختار) (ايه|ايش|وش|شنو)|^(انا )?(جوعان|جوعانه|جعان|جعانه)$|^(ايش|وش|ايه|شنو) (تقترح|تقترحون|تقترحوا|ترشح|ترشحون|ترشحلي|تنصح|تنصحون)( لي| علي)?$|^(اقترح|رشح|انصحني|اقترحلي|رشحلي)( لي| علي)?( شي| حاجه)?$/, "best", null, "recommend"],
  /* EX4 (عمر ١٣/١٠: «عملت ايقاف وملقيتش تشغيل»): طلب صريح برجوع العروض ⇒ نفس «اشتراك». الصيغ القصيرة المبهمة («استمرار»، «تشغيل»، «غلطت») في RESUME_SOFT_RE: بس لو هو موقّف فعلاً. */
  [/^(?:ممكن |لو سمحت )?(?:شغل|شغلو|شغلوا|شغلي|رجع|رجعو|رجعوا|رجعي|رجعلي|رجعولي|ارجع|فعل|فعلو|فعلوا|فعلي|كمل|كملو|كملوا|استمر|استمرو|استمروا)(?: لي| لنا)? (?:ارسال |رسايل |رسائل )?(?:ال)?(?:عروض|اعلانات|رسايل|رسائل|اشتراك|اشعارات)(?: و(?:ال)?(?:عروض|اعلانات|رسايل|رسائل))?(?: لو سمحت)?$|^(?:اشترك|اشتركت|ابي اشترك|ابغى اشترك|عايز اشترك|عاوز اشترك|رجعوني|رجع اشتراكي|subscribe|resubscribe|opt in|turn offers (?:back )?on)$/, "start", null, "resume_request"],
  /* «وقف العروض / الغوا الرسايل» كانت بتترد عليها بقايمة العروض (اتلقت في EX4): إيقاف صريح. */
  [/^(?:ممكن |لو سمحت )?(?:وقف|وقفو|وقفوا|وقفي|اوقف|اوقفو|اوقفوا|الغ|الغي|الغو|الغوا|شيل|شيلو|شيلوا|اقفل|اقفلو|اقفلوا|قفل|قفلو|قفلوا)(?: لي| عني)? (?:ارسال )?(?:ال)?(?:عروض|اعلانات|رسايل|رسائل|اشعارات)(?: و(?:ال)?(?:عروض|اعلانات|رسايل|رسائل))?(?: لو سمحت)?$/, "stop", null, "stop_request"],
  /* «محتاجه اعمل اوردر / عايز اطلب / ممكن اطلب» ⇒ كيف أطلب */
  [/^(لو سمحت )?(محتاج|محتاجه|عايز|عايزه|عاوز|عاوزه|ابي|ابغى|ابغي|ودي|حاب|حابه|ممكن|اقدر|كيف) (اعمل|اسوي|اطلب|نطلب|اطلب منكم) ?(اوردر|طلب|order)?( لو سمحت)?$|^(اعمل|اسوي) (اوردر|طلب)$/, "order", null, "how_to_order"],
];
/* n = النص بعد التطبيع ⇒ [key, arg, rawIntent] أو null. مدينة غير جدة ⇒ other_city (إلا لو اسم شارع/حي في جدة: «طريق المدينة»، «شارع مكة»، «حي الرياض»). */
export function extraIntent(n) {
  const s = String(n || "").replace(/[؟?!.،,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  for (const [re, key, arg, raw] of EXTRA_INTENTS) if (re.test(s)) return [key, arg, raw];
  if (CITY_RE.test(s) && !CITY_STREET_RE.test(s)) return ["other_city", null, "other_city"];
  return null;
}
/* EX6 (١٣/١٠، عميلة كتبت «عايزه تلت كيلو كفته» ٨ مرات ومااتفهمتش): وزن + صنف بالوزن في رسالة واحدة.
   ⇒ null (مش طلب بالوزن) | { id, parts: [[variant_option_id, qty], …] } | { id, ask: true } (الوزن ده مش معروض ⇒ كارت الصنف بأوزانه) | { ids: [...] } (أكتر من صنف بالوزن ينطبق).
   ctxItemId = الصنف اللي كارته لسه طالع للعميل: «خليها نص كيلو» من غير اسم صنف بتتطبّق عليه. صنف مش بالوزن اتذكر بالاسم ⇒ null. */
const NUM_WORDS = { واحد: 1, اثنين: 2, اتنين: 2, ثنتين: 2, اثنان: 2, ثلاثه: 3, تلاته: 3, ثلاث: 3, تلات: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5 };
const KILO = "(?:كيلو(?:ا|هات)?|كجم|كغم|كغ|kg|kilos?)", THIRD = "(?:ثلث|تلت|تلث|ثلت)", HALF = "(?:نصف|نص)", NUM = `(?:\\d+(?:\\.\\d+)?|${Object.keys(NUM_WORDS).join("|")})`;
export function weightOrder(text, menu, ctxItemId = null) {
  if (!menu || !Array.isArray(menu.items) || !menu.items.length) return null;
  /* إنجليزي ⇒ نفس الصيغة العربي قبل التطبيع (التطبيع بيشيل «/»). */
  const pre = String(text || "").toLowerCase().replace(/\b(?:half|1\/2)(?: a| of a)? ?(?:kilo|kg)\b/g, " نصف كيلو ").replace(/\b(?:(?:a |one )?third(?: of a)?|1\/3) ?(?:kilo|kg)\b/g, " ثلث كيلو ").replace(/\b(?:(?:a )?quarter(?: of a)?|1\/4) ?(?:kilo|kg)\b/g, " ربع كيلو ");
  let s = ` ${normalize(pre)} `;
  const want = { third: 0, half: 0, kilo: 0 }; let quarter = false, named = false, mentions = 0;
  /* سؤال سعر («كم كيلو المشكل؟») ⇒ كارت الصنف بكل أوزانه، مش سلة. */
  const priceQ = /(?:^| )(?:كم|بكم|بكام|سعر|اسعار|price|how much)(?: |$)/.test(s);
  const numOf = (v) => (v == null || v === "" ? 1 : NUM_WORDS[v] != null ? NUM_WORDS[v] : Number(v));
  const take = (re, fn) => { s = s.replace(re, (...m) => { mentions++; fn(m); return " "; }); };
  take(new RegExp(` ربع(?: ال)? ?${KILO}? `, "g"), () => { quarter = true; });
  take(new RegExp(` كيلوين و ?${HALF} `, "g"), () => { want.kilo += 2; want.half += 1; named = true; });
  take(new RegExp(` (${NUM})? ?${KILO} و ?(${HALF}|${THIRD}) `, "g"), (m) => { want.kilo += Math.floor(numOf(m[1])); if (new RegExp(HALF).test(m[2])) want.half += 1; else want.third += 1; named = true; });
  take(new RegExp(` و?${THIRD}(?: (?:ال)?${KILO})? `, "g"), (m) => { want.third += 1; if (/ك|k/.test(m[0])) named = true; });
  take(new RegExp(` و?${HALF}(?: (?:ال)?${KILO})? `, "g"), (m) => { want.half += 1; if (/ك|k/.test(m[0])) named = true; });
  take(/ و?كيلوين /g, () => { want.kilo += 2; named = true; });
  take(new RegExp(` و?(${NUM})? ?(?:ال)?${KILO} `, "g"), (m) => { const x = numOf(m[1]); want.kilo += Math.floor(x); if (x % 1 >= 0.5) want.half += 1; named = true; });
  const any = want.third + want.half + want.kilo;
  if (!any && !quarter) return null;
  if (!Number.isFinite(any) || any > 20) return null;
  if (mentions > 1) return null;      // أكتر من وزن في الرسالة (غالباً أكتر من صنف) ⇒ مش هنا: المساعد أو الموظف
  /* «نص» / «ثلث» من غير كلمة كيلو ومعاها دجاج ⇒ «نص دجاجة» (وجبة)، مش وزن. */
  if (!named && !quarter && /دجاج|فرخ|فراخ|chicken/.test(s)) return null;
  const found = findItems(menu, s).items || [];
  const bw = found.filter((i) => i.byWeight && Array.isArray(i.weights) && i.weights.length);
  let it = null;
  if (bw.length === 1) it = bw[0];
  else if (bw.length > 1) return { ids: bw.slice(0, 9).map((i) => String(i.id)) };
  else if (found.length) return null;      // صنف مش بالوزن اتذكر بالاسم
  else if (ctxItemId == null && named) { const all = menu.items.filter((i) => i.byWeight && Array.isArray(i.weights) && i.weights.length && !i.soldOut); return all.length ? { ids: all.slice(0, 9).map((i) => String(i.id)) } : null; }      // «ابي نص كيلو» من غير صنف ولا كارت ⇒ أصناف الوزن يختار منها
  else if (ctxItemId != null) { const c = menu.items.find((i) => String(i.id) === String(ctxItemId)); if (c && c.byWeight && Array.isArray(c.weights) && c.weights.length) it = c; }
  if (!it) return null;
  if (it.soldOut || quarter || priceQ) return { id: String(it.id), ask: true };
  const kind = (w) => { const l = normalize(w.label_ar || ""); return /ثلث|تلت/.test(l) ? "third" : /نصف|نص/.test(l) ? "half" : /كيلو/.test(l) ? "kilo" : null; };
  const parts = [];
  for (const k of ["kilo", "half", "third"]) { if (!want[k]) continue; const w = it.weights.find((x) => kind(x) === k); if (!w) return { id: String(it.id), ask: true }; parts.push([w.variant_option_id, want[k]]); }
  return { id: String(it.id), parts };
}
/* EX5 (١٣/١٠، أول رد «عميل» بعد الحملة كان رد آلي من نشاط تجاري والمساعد رد عليه): الرسالة الواردة رد آلي؟
   text = النص الخام. sinceTemplateSec = ثواني من آخر **قالب** بعتناه للرقم (null لو مفيش). ⇒ "pattern" | "after_template" | null.
   القاعدة الزمنية للقوالب بس (رسالة إحنا اللي بدأناها): عميل في نص محادثة مع البوت بيرد بسرعة عادي، فالوقت بعد رد البوت مش دليل. */
export const AUTO_INBOUND_MIN_CHARS = 25;
const AUTO_INBOUND_RE = [
  /شكرا(?: لك| لكم| جزيلا)? (?:على |ل)(?:تواصلك|تواصلكم|اتصالك|اتصالكم|رسالتك|رسالتكم|مراسلتك|مراسلتكم|مراسلتنا|اهتمامك|اهتمامكم)/,
  /(?:لسنا|غير) (?:متوفرين|متواجدين|متاحين|موجودين)/,
  /(?:سنرد|سنقوم بالرد|سوف نرد|سيتم الرد|سنعاود الاتصال|سنتواصل معك|سنتواصل معكم|وسنرد)[^\n]{0,40}(?:اقرب|اسرع|قريبا|لاحقا|خلال)/,
  /خارج (?:اوقات|ساعات|وقت) (?:العمل|الدوام)|(?:اوقات|ساعات) (?:عملنا|دوامنا|العمل لدينا)/,
  /يرجي (?:اخبارنا|ترك رسالتك|ترك رساله|الانتظار)|نرجو (?:ترك رسالتك|ترك رساله|الانتظار)/,
  /(?:رد|رساله) (?:الي|تلقائي|تلقائيه|اليه)(?: |$)/,
  /كيف (?:يمكننا|يمكنني) (?:مساعدتك|مساعدتكم|خدمتك|خدمتكم)/,
  /thank(?:s| you) for (?:contacting|reaching out|your message|getting in touch|messaging|writing|your interest|your inquiry|your enquiry)/,
  /we(?: are| re|re)? (?:currently |now |presently )?(?:away|unavailable|closed|not available|out of (?:the )?office)/,
  /(?:will|we ll|well) (?:get back|reply|respond|be in touch|contact you)[^\n]{0,30}(?:as soon as|shortly|soon|within)/,
  /outside (?:of )?(?:our )?(?:business|working|office|opening) hours|our (?:business|working|office|opening) hours are/,
  /auto(?:matic|mated)? ?(?:reply|response|message)|out of office/,
  /how (?:can|may) (?:we|i) (?:help|assist) you/,
];
export function autoInboundKind({ text, sinceTemplateSec = null, cfg = DEFAULTS } = {}) {
  const raw = String(text || "").trim(); if (!raw) return null;
  /* TRK6: نصّنا الجاهز من بانر «تابع طلبك على واتساب» (٤٠ حرف، بيوصل بعد قالب fc_order_received بثواني) = عميل ضغط الزرار، مش رد آلي */
  if (FOLLOW_RE.test(raw)) return null;
  if (cfg.autoInboundPatterns !== false) { const n = normalize(raw); if (AUTO_INBOUND_RE.some((re) => re.test(n))) return "pattern"; }
  if (cfg.autoInboundSec > 0 && sinceTemplateSec != null && sinceTemplateSec >= -3 && sinceTemplateSec <= cfg.autoInboundSec && [...raw].length >= AUTO_INBOUND_MIN_CHARS) return "after_template";
  return null;
}
/* صيغ قصيرة معناها «رجّع» بس من حد لسه موقّف (خلال ٢٤ ساعة من الإيقاف) — غير كده بتتفهم عادي. */
export const RESUME_SOFT_RE = /^(?:لا )?(?:استمرار|استمر|استمروا|كمل|كملوا|تشغيل|شغل|شغله|شغلها|شغلوها|غلطت|غلط|بالغلط|ضغطت بالغلط|ضغطت غلط|ضغطت بالخطا|بالخطا|رجعها|رجعه|رجعوها|رجعوه|تراجعت|تراجع|undo|by mistake|continue|resume)(?: لو سمحت)?$/;
const BARE_CANCEL = new Set(["الغاء", "الغ", "الغي", "الغو", "الغوا", "وقف", "اوقف", "وقفوا", "وقفو", "قف", "كنسل", "كانسل", "كنسلوا", "cancel", "cancel it", "الغاء لو سمحت", "الغي لو سمحت", "ابي الغي", "ابغى الغي"].map((w) => normalize(w)));
/* الطلب «شغّال» (لسه ممكن يتلغي): مدفوع ولسه ماتسلّمش. */
const ORDER_DONE = new Set(["delivered", "rejected_refunded", "refund_failed", "expired", "pending_payment", "cancelled", "canceled"]);
/* بعد تحميل الطلب: «الغاء» لوحدها وله طلب شغّال (أو مانعرفش: القاعدة ماردّتش) ⇒ إلغاء طلب لموظف عاجل. غير كده السؤال بزرارين زي ما هو. */
const argKey = (a) => (a == null ? "" : typeof a === "string" ? a : JSON.stringify(a)).slice(0, 120);
export function resolveCancel(cls, data) {
  /* M4: «كم الحساب» و«كم باقي / متى يوصل»: له طلب شغّال ⇒ حالة الطلب. مالوش ⇒ «كيف أطلب» للأولى ورد مدة التوصيل القصير للتانية. */
  if (cls && (cls.key === "bill" || cls.key === "eta")) {
    const o2 = data && data.order ? data.order : null;
    if ((o2 && !ORDER_DONE.has(String(o2.status || ""))) || (data && data.orderDbFailed)) return { ...cls, key: "status" };
    return { ...cls, key: cls.key === "bill" ? "order" : "delivery_time" };      // مفيش طلب مفتوح ⇒ مفيش حالة طلب (نفس قاعدة status_no_open)
  }
  if (!cls || cls.key !== "cancel_what") return cls;
  const o = data && data.order ? data.order : null;
  if ((o && !ORDER_DONE.has(String(o.status || ""))) || (data && data.orderDbFailed)) return { ...cls, key: "change", rawIntent: "cancel_order", entities: { ...(cls.entities || {}), ...(o ? { orderNo: o.order_no } : {}) } };
  return cls;
}
export const WHOLE_MENU_RE = /(?:منيو|مينيو|قائمه|قايمه)(?: \S+){0,2} (?:كامل|كامله|كله|كلها)|(?:كامل|كل) (?:ال)?(?:منيو|مينيو)|كل (?:وجبه|صنف|الاصناف|الوجبات) و?(?:سعرها|سعره|اسعارها|باسعارها|بسعرها)|\b(?:full|whole|entire) menu\b/;
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
    /* RV1: زر نجوم من القالب fc_review_stars (الـpayload = نص الزر) ⇒ الدعوة بتتعرف بعدين (رسالة القالب / آخر سؤال للرقم) */
    { const sq = starOfQr(id); if (sq) return out("review_star", { stars: sq.stars, exact: sq.exact, code: null }, "qr:review_star"); }
    { const qk = QR_IDS[id.trim().toLowerCase()] || QR_IDS[id.trim()]; if (qk) return out(qk, qk.startsWith("review") ? { code: null, order: null } : null, `qr:${qk}`); }
    const i = id.indexOf(":"), k = i > 0 ? id.slice(0, i) : "", v = i > 0 ? id.slice(i + 1) : "";
    if (k === "m" && MENU_IDS[v]) return out(MENU_IDS[v], null, `list:${id}`);
    if (["tier", "box", "cat", "item"].includes(k) && /^[a-z0-9-]{1,60}$/i.test(v)) return out(k, v, `list:${id}`);
    /* SB2: زرّين رسالة التقييم: rv:ok:<كود الدعوة> / rv:note:<الكود>:<رقم الطلب> */
    if (k === "rv") { const [kind, code, order] = v.split(":"); if ((kind === "ok" || kind === "note") && /^[a-z0-9]{4,16}$/i.test(String(code || ""))) return out(kind === "ok" ? "review_ok" : "review_note", { code, order: /^[A-Za-z0-9-]{3,30}$/.test(String(order || "")) ? order : null }, `button:rv:${kind}`); }
    /* RV1: صف نجوم rs:<نجوم>:<الكود> · صف سبب التقييم الواطي rr:<السبب>:<رقم التقييم> */
    if (k === "rs") { const st = starOfListId(id); if (st) return out("review_star", st, "list:review_star"); }
    if (k === "rr") { const rr = reasonOfListId(id); if (rr) return out("review_reason", rr, "list:review_reason"); }
  }
  /* EX6 (١٣/١٠: أول رسالة من إعلان وصلت «unsupported» واتسابت من غير رد): مابتتجاهلش. بداية محادثة ⇒ ترحيب (work)، جوّه محادثة ⇒ سطر «اكتبها نص». */
  if (type === "unsupported" && !ev.interactiveId) return out("unsupported", null, "type:unsupported", 0);
  if (IGNORED_TYPES.has(type)) return out(null, null, `type:${type}`, 0);
  if (ev.location && Number.isFinite(ev.location.lat) && Number.isFinite(ev.location.lng)) return out("area", { lat: ev.location.lat, lng: ev.location.lng }, "location");
  { const co = coordsFromText(text); if (co) return out("area", co, "maps_link"); }
  if (MEDIA_TYPES.has(type) && !text.trim()) return out("media", type === "audio" || type === "voice" ? "voice" : null, `media:${type}`);
  if (ev.intent === "stop" || ev.intent === "start") return out(ev.intent, null, ev.intent, 12);
  /* M2: «الغاء / وقف / كنسل / cancel» لوحدها (كلمة أو كلمتين من غير مفعول) مش إيقاف رسايل ومش إلغاء طلب لحد ما نعرف: لو له طلب شغّال ⇒ تحويل عاجل لإلغاء الطلب
     (resolveCancel بعد تحميل الطلب)، وإلا سؤال بزرارين. مفيش أي تغيير في موافقاته قبل ما يضغط. */
  if (BARE_CANCEL.has(normalize(text).replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim())) return out("cancel_what", null, "bare_cancel", 10);
  /* ١٤/١٠: الرسالة الجاهزة من زر «تابع طلبك على واتساب» (wapolicy.FOLLOW_RE) ⇒ حالة الطلب ده بالظبط، من القواعد (مش المساعد) */
  { const fm = FOLLOW_RE.exec(text); if (fm) return out("status", null, "follow_link", 12, { orderNo: fm[1].toUpperCase() }); }
  const n = normalize(text);
  const om = text.match(ORDER_NO_RE);
  const orderNo = om ? om[1].toUpperCase() : null;
  if (NAV_RE.test(n)) return out("main", null, "nav");
  if (ACK_RE.test(n) || (!n && text.trim() && /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\s]+$/u.test(text.trim()))) return out("ack", null, "ack");
  if (NACK_RE.test(n)) return out("nack", null, "nack");
  const m = matchIntent(text, { type: "text", menu: know.menu || null });
  let intent = m.intent;
  const e = { ...(m.entities || {}), orderNo };
  const done = (key, arg = null, raw = intent) => ({ key, arg, rawIntent: raw, lang: m.lang || lang, score: m.score, entities: e });
  /* ١٢/١٠ — «الساعة كم» اتصنّفت شكوى: كلمة مدة لوحدها (درجة ٣) كانت كفاية. الشكوى لازم لها إشارة شكوى فعلية
     (بارد/ناقص/غلط/متأخر… ⇒ درجة ٥+). إشارة ضعيفة + كلام عن الطلب ⇒ «وين طلبي» (حالة حقيقية، وبتحوّل لو متأخر فعلاً). */
  if (intent === "complaint" && m.score < 5) intent = orderNo || /طلب|اوردر|order|مندوب|driver/.test(n) ? "order_status" : "unknown";
  /* M4 (مراجعة الخبير، من سجل المحادثات الحي): صيغ كانت بتقع «ما فهمت» أو في رد غلط. كل صيغة ليها مثالها في الاختبارات.
     مابتغلبش نية صريحة (إيقاف، موظف، مشكلة دفع، استرجاع…)؛ الاستثناء الوحيد: شكوى المندوب/الطلب بتغلب «وين طلبي». */
  { const x = extraIntent(n); if (x && (!HARD_INTENTS.has(intent) || (x[0] === "complaint" && intent === "order_status") || (x[0] === "whoami" && intent === "human"))) return done(x[0], x[1] ?? null, x[2]); }
  /* EX6: وزن + صنف بالوزن ⇒ سعر الوزن ده وسلة جاهزة. */
  if (!HARD_INTENTS.has(intent)) { const wo = weightOrder(text, know.menu || null, null); if (wo) return wo.ids ? done("items", wo.ids, "weight_which") : wo.ask ? done("item", wo.id, "weight_not_offered") : done("weight", wo, "weight_order"); }
  if (RECIPE_RE.test(n) && !HARD_INTENTS.has(intent)) return done("secret", null, "recipe");
  if (TIME_RE.test(n) && !HARD_INTENTS.has(intent)) return done("hours", null, "time_question");
  if (REORDER_RE.test(n) && (!HARD_INTENTS.has(intent) || intent === "order_status")) return done("reorder", null, "reorder");
  /* حساسية: «شديدة» ⇒ موظف عاجل مهما كان الصنف. سؤال حساسية عن صنف واحد محدد ⇒ حقايق الأصناف. غير كده ⇒ مدخل «allergens» (فاضي عمداً ⇒ موظف). */
  if (!HARD_INTENTS.has(intent) && groupsIn(text).length) {
    if (SEVERE_RE.test(n) || SEVERE_RE.test(text)) return done("dishfact", { id: null, text }, "allergy_severe");
    const one = dishOf(text, e, know);
    if (one) return done("dishfact", { id: one, text }, "allergy_dish");
  }
  /* EX6: «مسببات الحساسية في <صنف>» من غير مسبّب محدد ⇒ قايمة المسببات المسجّلة للصنف ده. */
  if (!HARD_INTENTS.has(intent) && ALLERGY_ASK_RE.test(n) && !groupsIn(text).length) {
    if (SEVERE_RE.test(n) || SEVERE_RE.test(text)) return done("dishfact", { id: null, text }, "allergy_severe");
    const one = (e.itemId || (e.items || []).length) ? dishOf(text, e, know) : null;
    if (one) return done("dishfact", { id: one, text, list: true }, "allergy_dish_list");
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
    /* PK1 («ابغي أشوف المنيو كامل وكل وجبه وسعرها» اتصنّفت صنف واحد، والمساعد رد «الكامل ما أقدر أعرضه هنا»): طلب المنيو كله ⇒ قايمة الأقسام + زر المنيو فوراً. */
    if (WHOLE_MENU_RE.test(n)) return done("cats", null, "menu");
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
/* PS1 — اسم الشخصية بلغة الرد، وهل الوضع persona. نصوص intro / whoami_persona لازم يفضل فيها الاسم و«المساعد الرقمي» (لو المالك عدّلها وشالهم، الافتراضي هو اللي يتبعت: الصدق مايتشالش بتعديل نص). */
export const personaOn = (cfg) => cfg.disclosureMode !== "classic";
export const personaNameOf = (cfg, lang) => (lang === "en" ? cfg.assist.personaNameEn : cfg.assist.personaName);
const honestText = (cfg, key, lang) => { const name = personaNameOf(cfg, lang), L = lang === "en" ? "en" : "ar"; const own = fill(key, textOf(cfg, key, L), { name }); return hasIntro(own, name) ? own : fill(key, TEXTS[key][L], { name }); };
export const introLine = (cfg, lang) => honestText(cfg, "intro", lang);
/* PS3 (عمر ١٣/١٠: «مش حابب نقول معندناش إلا لو كان سأل»): سطر في إجابة سؤال شائع ممكن يبقى مشروط:
     [لو سأل: خارجي، خارجية، برا] لا توجد جلسات خارجية.        ·        [if asked: outdoor, outside] There is no outdoor seating.
   السطر ده بيتبعت بس لو كلام العميل فيه واحدة من الكلمات (بعد التوحيد). أي سطر بادئ بالقوس ومش مفهوم ⇒ مايتبعتش (عمر العميل ما يشوف القوس). */
const FAQ_IF = /^\s*\[\s*(?:لو س[أا]ل|اذا س[أا]ل|إذا س[أا]ل|if asked)\s*[:：]?\s*([^\]]*)\]\s*(.*)$/i;
export function faqAnswer(raw, asked = "") {
  const n = normalize(String(asked || "")), low = String(asked || "").toLowerCase();
  const out = [];
  for (const line of String(raw || "").split("\n")) {
    if (!/^\s*\[/.test(line)) { out.push(line); continue; }
    const m = FAQ_IF.exec(line); if (!m) continue;
    const keys = m[1].split(/[,،;]+/).map((k) => k.trim()).filter(Boolean);
    if (m[2].trim() && keys.some((k) => (normalize(k) && n.includes(normalize(k))) || low.includes(k.toLowerCase()))) out.push(m[2].trim());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/* PS4 — نص لحظة الرسوم من الاختيارات المحسوبة (waassist.deliverySavers ⇒ options). ⇒ { text, reach } أو null لو مفيش «زي ما هو». كل رقم من options. */
/* PS5 — ملخص السلة من السلة نفسها (مش من الموديل): كل سطر باسمه في المنيو، الوزن، اختيارات البوكس، وملاحظة المطبخ. */
export function cartRecapOf(cfg, cart, lang) {
  const L = lang === "en" ? "en" : "ar", T2 = (k, v = {}) => fill(k, textOf(cfg, k, L), v), en = L === "en";
  const out = [T2("cart_recap_head", { mode: cart.option === "pickup" ? T2("btn_fee_pickup") : T2("btn_delivery") })];
  const f = cart.fees || null;      // SB1: التوصيل والإجمالي (عقل البيع) — من غيرها: الملخص القديم
  for (const l of cart.lines || []) { const nm = en ? l.name_en || l.name : l.name, w = l.weight ? (en ? l.weight_en || l.weight : l.weight) : "";
    const picks = en ? (l.picks || []).filter((p) => p.note).map((p) => p.note).join(", ") : (l.picks || []).map((p) => `${p.name}${p.note ? ` (${p.note})` : ""}`).join("، ");      // إنجليزي: أسماء الاختيارات عربي بس ⇒ الملاحظات فقط
    out.push(T2("cart_recap_line", { name: `${f ? `*${nm}*` : nm}${w ? ` — ${w}` : ""}${picks ? ` (${picks})` : ""}`, qty: String(l.qty), total: money(l.total) }));
    if (l.note) out.push(T2("cart_recap_note", { note: l.note })); }
  out.push(T2("cart_recap_total", { total: money(cart.subtotal) }));
  if (f) {
    if (f.pickup) out.push(T2("cart_recap_pickup"));
    else if (f.free) out.push(f.code ? T2("cart_recap_fee_free", { code: f.code }) : T2("cart_recap_fee_zero"));
    else if (Number.isFinite(Number(f.fee))) out.push(T2("cart_recap_fee", { fee: money(f.fee) }));
    else out.push(T2("cart_recap_fee_later"));
    if (!f.pickup && (f.free || Number.isFinite(Number(f.fee)))) out.push(T2("cart_recap_grand", { total: money(Math.round((Number(cart.subtotal) + (f.free ? 0 : Number(f.fee))) * 100) / 100) }));
  }
  out.push(T2("cart_recap_close"));
  return out.join("\n");
}
/* SB1 — نص من نصوص عقل البيع بأرقام النظام (الأرقام بتتكتب بـ money: «27» مش «27.00»). مفيش نص ⇒ null (السطر مابيتقالش). */
export function salesTextOf(cfg, key, vars = {}, lang = "ar") {
  const L = lang === "en" ? "en" : "ar", v = {};
  for (const [k, x] of Object.entries(vars || {})) v[k] = typeof x === "number" ? money(x) : x;
  try { return fill(key, textOf(cfg, key, L), v); } catch { return null; }
}
export function feeSayOf(cfg, options, lang, { located = true } = {}) {
  const o = options || {}, L = lang === "en" ? "en" : "ar", a = o.as_is, r = o.reach, p = o.pickup;
  if (!a || !(Number(a.delivery) > 0) || !p) return null;
  const T2 = (k, v) => fill(k, textOf(cfg, k, L), v);
  const lines = [T2("fee_asis", { order: money(a.order), fee: money(a.delivery), total: money(a.total) })];
  if (r && Number(r.extra_food) > 0) {
    if (r.with_code) lines.push(T2(/first/i.test(String(r.condition || "")) ? "fee_first" : "fee_reward", { from: money(r.order), code: String(r.with_code) }) + (Number(r.vs_as_is) === 0 ? ` ${T2("fee_same", { extra: money(r.extra_food) })}` : ""));
    else lines.push(Number(r.delivery) === 0 ? T2("fee_step_free", { extra: money(r.extra_food), total: money(r.total) }) : T2("fee_step", { extra: money(r.extra_food), fee: money(r.delivery), total: money(r.total) }));
  }
  lines.push(T2("fee_pickup", { order: money(p.order) }));
  if (!located) lines.push(T2("fee_unlocated"));      // من غير دبوس موقع: الأرقام من سلّم الرسوم العام، والعميل بيتقال له
  return { text: lines.join("\n"), reach: r && Number(r.extra_food) > 0 ? Number(r.order) : null };
}
/* PS4 — أزرار وقوايم ردود المساعد (المعرّف as:… بيرجّع الضغطة للمساعد بعنوانها كنص). ⇒ { buttons } | { list } | {} */
export function assistExtras(cfg, lang, r) {
  const L = lang === "en" ? "en" : "ar", T2 = (k, v = {}) => fill(k, textOf(cfg, k, L), v), fit = (s) => { const a = [...String(s || "").trim()]; return a.length <= LIMITS.btnTitle ? a.join("") : a.slice(0, LIMITS.btnTitle - 1).join("").trim() + "…"; };
  const b = r && r.buttons;
  if (b && b.kind === "fee") return { buttons: [...(b.reach ? [{ id: "as:reach", title: fit(T2("btn_fee_reach", { from: money(b.reach) })) }] : []), { id: "as:pickup", title: T2("btn_fee_pickup") }] };
  if (b && b.kind === "bigbox" && b.a && b.b) return { buttons: [{ id: `as:box:${b.a.slug}`, title: fit(b.a.name) }, { id: `as:box:${b.b.slug}`, title: fit(b.b.name) }] };
  if (b && b.kind === "family" && b.meal && b.weight) return { buttons: [{ id: `as:meal:${b.meal.id}`, title: T2("btn_meal") }, { id: `as:weight:${b.weight.id}`, title: T2("btn_weight") }] };
  if (b && b.kind === "ad") return { buttons: [{ id: "as:delivery", title: T2("btn_delivery") }, { id: "as:pickup", title: T2("btn_fee_pickup") }, { id: "as:other", title: T2("btn_other") }] };
  /* SB1 — أزرار عقل البيع: الاقتراح، نفس الطلب، والأسئلة: الوزن، التأكيد، توصيل/استلام، كام شخص (الضغطة بترجع للمساعد بعنوانها كنص) */
  if (b && b.kind === "sg") return { buttons: [{ id: "as:sg:yes", title: T2("btn_sg_add") }, { id: "as:sg:no", title: T2("btn_sg_no") }] };
  if (b && b.kind === "same") return { buttons: [{ id: "re:last", title: fit(T2("row_reorder")) }, { id: "as:other", title: T2("btn_other") }] };
  if (b && b.kind === "weights" && Array.isArray(b.weights) && b.weights.length >= 2) return { buttons: b.weights.slice(0, LIMITS.btns).map((w) => ({ id: `as:w:${w.variant_option_id}`, title: fit(L === "en" ? `${w.label_en || w.label} · SAR ${money(w.price)}` : `${w.label} · ${money(w.price)} ر.س`) })) };
  if (b && b.kind === "confirm") return { buttons: [{ id: "as:yes", title: T2("btn_confirm_yes") }, { id: "as:no", title: T2("btn_confirm_no") }] };
  if (b && b.kind === "mode") return { buttons: [{ id: "as:delivery", title: T2("btn_delivery") }, { id: "as:pickup", title: T2("btn_fee_pickup") }] };
  if (b && b.kind === "people") return { list: { button: T2("list_people_btn"), rows: ["row_people_1", "row_people_2", "row_people_3", "row_people_5", "row_people_7"].map((k, i) => ({ id: `as:p:${i + 1}`, title: T2(k) })) } };
  if (r && r.list && Array.isArray(r.list.rows) && r.list.rows.length >= 2) return { list: { button: T2("list_btn"), rows: r.list.rows.slice(0, LIMITS.rows).map((x) => ({ id: x.id, title: x.title, ...(Number(x.extra) > 0 ? { description: L === "en" ? `+ SAR ${money(x.extra)}` : `+ ${money(x.extra)} ر.س` } : {}) })) } };
  return {};
}
/* PS4 — صورة الصنف المُعلن في أول رد لمحادثة الإعلان: **الخطّاف بس**. مفيش صورة بتتبعت لحد ما عمر يعتمد مكتبة الصور (كتاب البيع، بند ٦: «الميكس جريل بقطعتين طرب»). */
export const adPictureFor = (_cfg, _advertised) => null;
export function disclosureLine(cfg, lang, settings) {
  if (personaOn(cfg)) return introLine(cfg, lang);
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
const FACTUAL_KEYS = new Set(["other_city", "whoami", "delivery_time", "hours", "hoursloc", "location", "status", "thanks", "stop", "stop_updates", "cancel_what", "start", "optin_yes", "optin_no", "resume_all", "resume_updates", "rf_no",
  "review_reason"]);      // RV1: سبب التقييم الواطي = رد على سؤالنا وهو عند المدير ⇒ «وصلت ملاحظتك» (مش «محادثتك عند الموظف»)
/* أسئلة المنيو والأسعار والتوصيل: معلومات. بتتجاوب حتى والمحادثة عند الموظف — إلا لو التحويل شكوى/مشكلة (SERIOUS). */
const MENU_KEYS = new Set(["main", "menu", "cats", "cat", "item", "items", "boxes", "tier", "box", "best", "spicy", "notmenu", "packs", "payment", "pickup", "delivery", "area", "faq", "dishfact", "rf_yes"]);
const SERIOUS = new Set(["allergy_severe", "complaint", "problem", "order_change", "order_late", "order_issue", "send_failed", "review_low"]);      // RV1: تقييم واطي = شكوى (معلومات بس، ومفيش تنبيه تاني لو كتب شكوى بعده)
/* مراجعة RV1: «تقييم واطي» عند المدير رأي على طلب خلص — مايمسكش المحادثة زي الشكوى. طول ما هو مفتوح:
     • المنيو والأسعار والطلب الجديد / «نفس طلبي» / العروض بيتخدموا عادي (REVIEW_SOFT_KEYS).
     • طلب تشغيلي جديد (تعديل/إلغاء طلب، تأخير، مشكلة طلب، حساسية — OPS_SERIOUS) بيفتح تحويل جديد بتنبيهه العادي للفريق، حتى لو المدير رد.
     • الشكوى أو «موظف» المكتوبين بعده بيفضلوا عند المدير زي ما هم (من غير تنبيه تاني) — والمدير رد ⇒ البوت ساكت زي الشكوى.
   وقفل التقييم بنتيجة بتقفله (البورتال أو «تم الحل») بيرجّع المحادثة للبوت (portalreviews.releaseLowChat) — «متابعة» لأ. الرسايل الآلية فرامل تانية: COMPLAINT_24H_SQL. */
const REVIEW_SOFT = new Set(["review_low"]);
/* مراجعة RV1 (التالتة): «شكوى في آخر ٢٤ ساعة» = الفرامل المشتركة للرسايل اللي البوت بيبدأها من نفسه (FU1 متابعة اللي ردّ، SB4 قبل ما النافذة تقفل،
   EX6 متابعة اللي ماتردّش عليه، متابعة المساعد). التقييم الواطي من واتساب (wa_bot_log.handoff = review_low) بيتعدّ زي الشكوى: قفل التقييم بيرجّع
   المحادثة للبوت (handoff_at بيتمسح)، بس ده مايفتحش الباب لرسالة بيع لعميل زعلان قبل ما يعدّي ٢٤ ساعة على تقييمه — نفس حماية «التحويل المفتوح» قبل كده. */
export const COMPLAINT_24H_SQL = "SELECT 1 FROM wa_bot_log WHERE phone_norm=$1 AND at > NOW() - INTERVAL '24 hours' AND (reply_key IN ('complaint','problem','change') OR handoff IN ('complaint','problem','order_change','allergy_severe','review_low')) LIMIT 1";
const REVIEW_SOFT_KEYS = new Set([...MENU_KEYS, "order", "reorder", "offers"]);
const OPS_SERIOUS = new Set(["order_change", "order_late", "order_issue", "allergy_severe", "send_failed"]);
/* سطر التعريف بالمساعد مابيتحطش فوق رد رحلة التقييم (رد على زر إحنا بعتناه، مش بداية محادثة) */
const NO_DISCLOSE = new Set(["whoami", "review_ok", "review_star", "review_reason"]);
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
  /* M5: رقم مش عميل (قايمة المالك، أو مستبعد لوحده: تنبيهات الفريق / مندوب) ⇒ ولا رد أبداً. بره نطاق التشغيل (liveScope) ⇒ سكوت والرد اللي كان هيطلع بيتسجّل (key). */
  if (ctx.neverReply) return silent("never_reply", { detail: ctx.neverReply });
  if (ctx.outOfScope) return silent("out_of_scope", { key: c.key, detail: `scope:${cfg.liveScope}` });
  if (!c.key) return silent("ignored_type");
  const at = ev.at ? Date.parse(ev.at) : now.getTime();
  const ageMin = (now.getTime() - (Number.isFinite(at) ? at : now.getTime())) / 60000;
  if (ageMin >= 24 * 60) return silent("outside_window");
  const waited = ctx.afterWait === "staff_wait" ? cfg.staffWaitMin : ctx.afterWait === "unknown_wait" ? cfg.unknownWaitMin : 0;
  /* M4: رسالة وصلتنا متأخرة (ويب هوك اتأخر) مابتتسابش من غير رد: بتتحوّل لموظف والعميل بيتقال له. (الرد المؤجّل اللي فات ميعاده بيتلغي من منفّذ الردود المؤجّلة، مش هنا.) */
  const stale = ageMin > cfg.maxAgeMinutes + waited;
  if (stale && (ctx.afterWait || c.key === "ack" || c.key === "nack" || c.key === "rf_no")) return silent("stale");      // FU1: «لا شكراً» المتأخرة بتتسجّل (work) من غير رد ولا تحويل
  const optout = c.key === "stop" || c.key === "start" ? c.key : c.key === "stop_updates" ? "stop_all" : null;
  const chat = ctx.chat || {};
  const nowMs = now.getTime();

  // ٤أ) كتم يدوي من الموظف — بيفضل ماسك حتى والمطعم مقفول
  if (chat.muted_until && Date.parse(chat.muted_until) > nowMs) return silent("manual_mute", { optout, resumeAt: new Date(chat.muted_until).toISOString(), ...(["media_flood", "loop_guard"].includes(String(chat.muted_by || "")) ? { detail: chat.muted_by } : {}) });
  if (ctx.failedRecently && !optout) return silent("recent_send_failure");

  // ١/٣/٤ج/٦) سكوت الموظف
  const open = ctx.data && ctx.data.open ? ctx.data.open.open === true : null;
  const ps = pauseState({ cfg, now, open, lastEchoAt: ctx.lastEchoAt, hours: ctx.data?.settings?.hours });
  if (ps.paused && !ctx.afterWait) {
    if (optout) return silent(ps.kind, { optout, resumeAt: iso(ps.until) });
    // ٢) نية معروفة: نستنى الموظف staffWaitMin وبعدها نرد. غير مفهوم: للموظف (هو في المحادثة).
    if (c.key === "ack" || c.key === "nack") return silent("ack");
    /* مع مساعد الطلبات (ctx.assistOn): الرسالة الغير مفهومة بتستنى الموظف زي غيرها وبعدين المساعد يرد عليها — مابتتسابش من غير رد (عطل ١٢/١٠: «انت بطيء اوي» فضلت من غير رد). */
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
  /* مراجعة RV1: تقييم واطي مفتوح ⇒ الطلب التشغيلي الجديد بيعدّي (escalates) — شوف REVIEW_SOFT فوق */
  const softHo = Boolean(ho && REVIEW_SOFT.has(ho));
  const escalates = Boolean(ho && HANDOFF_KEYS[key] && SERIOUS.has(HANDOFF_KEYS[key][0]) && (!SERIOUS.has(ho) || (softHo && OPS_SERIOUS.has(HANDOFF_KEYS[key][0]))));
  /* قرار عمر ١٢/١٠: شكوى والموظف رد عليها ⇒ البوت «يسكت خالص» (ولا معلومات ولا تذكير) لحد ما التحويل يخلص أو «رجّع البوت».
     «إيقاف» وزرار الرجوع بيتنفّذوا ويتأكدوا للعميل برضه (ده حقه). */
  if (ho && SERIOUS.has(ho) && staffTook && !escalates && !["stop", "start", "resume_all", "resume_updates"].includes(key)) return silent("complaint_with_staff", { key, resumeAt: hoUntil, detail: ho });
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
    else if (softHo && REVIEW_SOFT_KEYS.has(key)) factual = false;         // مراجعة RV1: تقييم واطي مفتوح ⇒ المنيو والطلب الجديد بيتخدموا
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
  /* التكرار = نفس نص الرسالة (أو نفس الضغطة) من نفس العميل خلال sameTextSeconds — ضغطتين ورا بعض أو إعادة إرسال. الويب هوك المكرر نفسه بيتمسك بالـwamid قبل كده.
     عميل بيكرر سؤاله بعد كده (حتى لو نفس الكلام) بيترد عليه: السكوت عليه كان بيبان إن البوت واقف (١٢/١٠). */
  /* M4: نفس النص جوّه المدة مابيتسكتش عليه: أول تكرار ⇒ رد قصير «نفس المعلومة 👆 تبي أحوّلك لموظف؟» بزر؛ التكرار اللي بعده ⇒ تحويل عادي لموظف. */
  if (ctx.sameTextAt && cfg.sameTextSeconds > 0 && nowMs - Date.parse(ctx.sameTextAt) < cfg.sameTextSeconds * 1000 && !optout && !HANDOFF_KEYS[key] && key !== "handoff_remind") {
    if (ctx.sameTextKey === "repeat_short") { key = "human"; handoff = ["repeated_question", "normal"]; }
    else key = "repeat_short";
  }
  /* EX6: نفس الكارت (صنف / قسم / قايمة أصناف) طلع مرتين ورا بعض على رسايل مكتوبة والعميل لسه بيكتب ⇒ مانكررهوش تالت مرة: موظف. (المساعد لو شغّال بياخد الرسايل دي قبل ما توصل هنا.) */
  if (!ev.interactiveId && !optout && ctx.cardRun && ["item", "items", "cat"].includes(key) && ctx.cardRun.key === key && ctx.cardRun.arg === argKey(c.arg)) { key = "staff"; handoff = ["repeated_card", "normal"]; }
  if (stale && !optout && !HANDOFF_KEYS[key]) { key = "staff"; handoff = ["late_message", "normal"]; }      // إيقاف/رجوع وشكوى متأخرين بياخدوا ردهم العادي
  // ٥) الرسالة الغير مفهومة بيترد عليها فوراً (سطر صريح + القائمة + «موظف»): مفيش «انتظار الموظف ٣ دقايق» — كان بيبان إن البوت مابيردّش (١٢/١٠).
  //    اللي لسه مستني من قبل التحديث (afterWait = unknown_wait) بيتنفّذ عادي.
  if (HANDOFF_KEYS[key] && !handoff) handoff = HANDOFF_KEYS[key];
  if (key === "human" && handoff && handoff[0] === "asked_human" && !ev.interactiveId && asksManager(ev.text)) handoff = ["asked_manager", "normal"];      // RG1: طلب مسؤول

  const interactive = cfg.interactive && ctx.interactive !== false;
  const bc = { cfg, lang: c.lang, data: ctx.data, referral: ev.referral || null, factual, arg: c.arg ?? null, asked: ev.text || "", follow: c.rawIntent === "follow_link" };
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
  if (handoff && ho && !(SERIOUS.has(handoff[0]) && (!SERIOUS.has(ho) || (softHo && OPS_SERIOUS.has(handoff[0]))))) handoff = null;      // مراجعة RV1: تقييم واطي ⇒ الطلب التشغيلي بيتنبّه
  // ٧) التعريف: أول رسالة من البوت في المحادثة (مرة كل ٢٤ ساعة)
  const disclose = !NO_DISCLOSE.has(key) && (!chat.last_disclosed_at || nowMs - Date.parse(chat.last_disclosed_at) >= cfg.disclosureHours * 3600_000);
  let disclosed = false;       // سطر التعريف اتحط فعلاً فوق الرد
  if (disclose) {
    try { reply = { ...reply, body: `${disclosureLine(cfg, c.lang, ctx.data?.settings)}\n${reply.body}` }; disclosed = true; }
    catch { /* نص التعريف اتعدّل غلط ⇒ الرد يطلع من غيره أحسن ما مايطلعش */ }
  }
  // رسالة تانية (اختيارية): بعد التحية القائمة الرئيسية؛ بعد حالة الطلب سؤال الموافقة على تحديثات الطلب
  const replies = [reply, ...(Array.isArray(reply.extra) ? reply.extra : [])];
  /* دعوة القناة: رسالة تانية بعد «شكراً / مع السلامة» بس (محادثة خلصت عادي)، ولو العميل مستحقها (ctx.data.channelOk: القناة شغّالة، مااتعرضتش عليه
     في آخر everyDays، مفيش تحويل مفتوح، وماكتبش «إيقاف»). مش في رد «حقايق بس» (محادثة عند موظف) ولا مع أي تحويل. */
  let channel = reply.channel || null;
  if (key === "thanks" && !factual && !problem && !handoff && ctx.data?.channelOk === true && channelOn(cfg)) {
    try { replies.push({ body: textOf(cfg, "channel_line", c.lang), cta: { title: textOf(cfg, "cta_channel", c.lang), url: cfg.links.channel.url } }); channel = "rules_close"; } catch { /* الدعوة إضافة */ }
  }
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
  const showFooter = (r, i) => !personaOn(cfg) && Boolean(cfg.footerMode === "always" || (cfg.footerMode === "first" && disclose && i === 0) || (cfg.footerMode === "smart" && disclose && !disclosed && i === 0) || (cfg.footerMode === "smart" && (key === "unknown" || ((r.buttons || r.list) && !wayBack(r)))));
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
    optinAsk, optinAnswer: key === "optin_yes" ? "yes" : key === "optin_no" ? "no" : null, channel,
    ...(reply.note ? { note: String(reply.note).slice(0, 200) } : {}), ...(reply.orderNo ? { orderNo: String(reply.orderNo).slice(0, 30) } : {}) };      // RV1: كارت البوابة للتقييم الواطي (النجوم + رقم الطلب)
}

/* نص تنبيه الفريق — رسالة SMS واحدة (fitOneSms حارس أخير). مفيش اسم العميل ولا نص رسالته. */
const REASON_EN = { order_note: "note on an active order", review_low: "LOW RATING, please call", review_note: "note on their order", repeated_card: "the bot repeated the same card and the customer kept asking", loop_guard: "automatic messages in a loop, bot muted", repeated_question: "repeated the same question", late_message: "message arrived late", media_flood: "many files with no text", complaint: "complaint", problem: "payment/site problem", order_change: "change/cancel order", asked_human: "asked for staff", asked_manager: "asked for a MANAGER", needs_staff: "question for staff",
  media: "sent photo/voice", not_understood_twice: "not understood", rate_limit: "many messages", data_missing: "bot could not answer", order_not_found: "order not found",
  allergy_severe: "SEVERE ALLERGY question", custom_offer: "wants a tailored group offer", order_late: "LATE order", order_issue: "order issue", send_failed: "bot reply failed" };
const REASON_AR = { order_note: "ملاحظة على طلب شغّال", staff_silent: "رقم في قايمة الموظفين كتب ومحدش رد", review_low: "تقييم منخفض", review_note: "ملاحظة على طلب", repeated_card: "البوت كرر نفس الرد والعميل لسه بيسأل", loop_guard: "رسايل آلية متكررة من الرقم — البوت اتكتم", repeated_question: "كرر نفس السؤال", late_message: "رسالة وصلت متأخرة", media_flood: "صور/ملفات كتير من غير نص", allergy_severe: "حساسية شديدة", custom_offer: "عرض مخصص لتجمع", complaint: "شكوى", problem: "مشكلة دفع/موقع", order_change: "تعديل/الغاء طلب", asked_human: "طلب موظف", asked_manager: "طلب مسؤول", needs_staff: "سؤال", media: "صورة/صوت",
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
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS review_code TEXT;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS window_sell_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS follow_order TEXT;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS follow_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS review_order TEXT;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS review_asked_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS review_answered_at TIMESTAMPTZ;
      -- RV1: سؤال النجوم اتبعت امتى (النجوم المكتوبة بتتحسب عليه) + آخر تقييم واطي (أول نص بعده = تعليقه في الوارد)
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS review_stars_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS review_low_id BIGINT;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS review_low_at TIMESTAMPTZ;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS loop_streak INT NOT NULL DEFAULT 0;
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS loop_at TIMESTAMPTZ;
      -- دعوة قناة واتساب: آخر مرة اتعرضت على العميل (عدّاد واحد للبوت والمساعد) + سجل لكل عرض (للعدّ اليومي)
      ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS channel_offered_at TIMESTAMPTZ;
      -- وضع العملاء للمساعد: العملاء (غير أرقام التجربة) اللي المساعد بدأ يرد عليهم في اليوم ده (بتوقيت الرياض) — للسقف اليومي
      CREATE TABLE IF NOT EXISTS wa_assist_live_day (day DATE NOT NULL, phone_norm TEXT NOT NULL, why TEXT, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (day, phone_norm));
      CREATE TABLE IF NOT EXISTS wa_channel_offers (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), phone_norm TEXT NOT NULL, via TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS wa_channel_offers_at_idx ON wa_channel_offers(at DESC);
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
    /* FU1 (١٥/١٠): دفتر «متابعة اللي ردّ» + الفرامل + «لا شكراً» على المحادثة (wafollow.js). فشل هنا مايوقّفش البوت: المتابعة بس هي اللي مابتشتغلش. */
    await pool.query(FU_DDL).catch((e) => console.error("[wabot] followup schema:", e.message));
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
  /* strict (FD1 — أسعار رسالة «طبقك المفضل»): الكاش لازم يكون اتحدّث في مدته العادية؛ التحديث فشل ⇒ [] (مش كاش لحد ساعة) */
  async function bundles(strict = false) {
    if (bundleCache.rows && Date.now() - bundleCache.at < tune.boxesCacheMin * 60_000) return bundleCache.rows;
    try { const rows = await fetchBundles(); if (Array.isArray(rows) && rows.length) bundleCache = { at: Date.now(), rows }; }
    catch (e) { console.error("[wabot] bundles:", e.message); }
    return bundleCache.rows && Date.now() - bundleCache.at < (strict ? tune.boxesCacheMin + 1 : tune.staleCacheMin) * 60_000 ? bundleCache.rows : [];   // كاش أقدم من ساعة مايتعرضش
  }
  /* المنيو الحي (نفس اللي المتجر بيعرضه) ⇒ فهرس wabot.indexMenu. كاش ١٠ دقايق؛ كاش أقدم من ساعة مايتعرضش. */
  const storeBase = (process.env.STOREFRONT_PUBLIC_URL || STORE).split(",")[0].replace(/\/+$/, "");
  const fetchMenuPages = deps.fetchMenuPages || (async () => {
    const r = await fetch(`${storeBase}/api/menu?branch_id=1`, { headers: { "User-Agent": "freshcuts-wabot" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`menu HTTP ${r.status}`);
    return (await r.json())?.data?.pages || [];
  });
  /* M3: أوزان الأصناف اللي بتتباع بالوزن — نفس مصدر صفحة الصنف في المتجر (‎/api/product/<id>‎ ⇒ data.variant.options). بتتجاب مع تحديث المنيو وتتخزّن معاه.
     صنف ماجاش ⇒ بيفضل بآخر أوزان معروفة له (لحد ما كاش المنيو نفسه يقدم)، أو من غير أوزان. */
  /* لو المنيو نفسه متبدّل (اختبارات) ومفيش محمّل أوزان متبعت ⇒ مفيش أي نداء شبكة للأوزان. */
  const fetchVariants = deps.fetchVariants || (deps.fetchMenuPages ? null : async (id) => {
    const r = await fetch(`${storeBase}/api/product/${encodeURIComponent(id)}?branch_id=1`, { headers: { "User-Agent": "freshcuts-wabot" }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`product HTTP ${r.status}`);
    return (await r.json())?.data?.variant?.options || [];
  });
  const isByWeight = (p, it) => p.title === "Grills by the Kilo" || /بالوزن/.test(String(it.name || it.local_name || ""));
  /* FD1 مراجعة ٣: وقت آخر جلب ناجح لكل صنف (variantsAt) — الصنف اللي جلبه فشل بيفضل بأوزانه القديمة للبوت، بس الحملة (strict) مابتاخدهاش:
     كاش المنيو نفسه كان بيتختم «جديد» حتى لو أوزان صنف فضلت قديمة، فسعر «كباب نص كيلو» القديم كان ممكن يطلع في رسالة. */
  async function loadVariants(pages, prev, prevAt = {}) {
    if (!fetchVariants) return { variants: prev || {}, at: prevAt || {} };
    const ids = [...new Set(pages.flatMap((p) => (p.items || []).filter((it) => isByWeight(p, it)).map((it) => String(it.id))))].slice(0, 40);
    const out = {}, at = {}, t = Date.now();
    const keep = (id) => { if (prev && prev[id]) { out[id] = prev[id]; if (prevAt && prevAt[id]) at[id] = prevAt[id]; } };
    await Promise.all(ids.map(async (id) => { try { const o = await fetchVariants(id); if (Array.isArray(o) && o.length) { out[id] = o; at[id] = t; } else keep(id); } catch (e) { keep(id); } }));
    return { variants: out, at };
  }
  let menuCache = { at: 0, pages: null, variants: {}, variantsAt: {} };
  async function menuIndex(settings, now, strict = false) {
    if (!menuCache.pages || Date.now() - menuCache.at > tune.menuCacheMin * 60_000) {
      try { const pg = await fetchMenuPages(); if (Array.isArray(pg) && pg.length) { const lv = await loadVariants(pg, menuCache.variants, menuCache.variantsAt); menuCache = { at: Date.now(), pages: pg, variants: lv.variants, variantsAt: lv.at }; } }
      catch (e) { console.error("[wabot] menu:", e.message); }
    }
    if (!menuCache.pages || Date.now() - menuCache.at > (strict ? tune.menuCacheMin + 1 : tune.staleCacheMin) * 60_000) return null;      // strict (FD1): التحديث فشل ⇒ مفيش أسعار
    const soldOut = {};
    for (const [k, v] of Object.entries(settings?.catalog?.soldOut || {})) if (!v?.until || Date.parse(v.until) > now.getTime()) soldOut[k] = true;
    /* strict: أوزان الصنف اللي ماتجابتش في مدة الكاش ⇒ مش موجودة (الحملة مابتقولش سعر وزن قديم) — الأصناف التانية زي ما هي */
    let variants = menuCache.variants;
    if (strict && fetchVariants) { variants = {}; const lim = (tune.menuCacheMin + 1) * 60_000; for (const [id, o] of Object.entries(menuCache.variants || {})) if (Date.now() - (Number((menuCache.variantsAt || {})[id]) || 0) <= lim) variants[id] = o; }
    try { return indexMenu(menuCache.pages, { hiddenIds: settings?.catalog?.hiddenIds || [], soldOut, variants }); } catch { return null; }
  }
  /* العروض الشغّالة الحين من سجل العروض (نفس اللي المتجر بيعرضه) — كاش دقيقتين؛ وقع ⇒ null (نقول أقل) */
  const fetchOffers = deps.fetchOffers || (async () => { const r = await self.request("/api/offers"); if (!r.ok) throw new Error(`offers HTTP ${r.status}`); return (await r.json())?.offers || []; });
  let offersCache = { at: 0, rows: null };
  async function liveOffers(settings, now, strict = false) {
    if (!offersCache.rows || Date.now() - offersCache.at > tune.offersCacheMin * 60_000) {
      try { const rows = await fetchOffers(); if (Array.isArray(rows)) offersCache = { at: Date.now(), rows }; }
      catch (e) { console.error("[wabot] offers:", e.message); if (Date.now() - offersCache.at > tune.staleCacheMin * 60_000) offersCache = { at: 0, rows: null }; }
    }
    if (!offersCache.rows) return null;
    if (strict && Date.now() - offersCache.at > (tune.offersCacheMin + 1) * 60_000) return null;      // FD1: العروض مااتحدّثتش ⇒ مانعرفش (مفيش باقات)
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
  const botCarts = deps.botCarts || makeBotCarts({ pool, now: deps.now || (() => new Date()), locationHours: async () => botConfig((await getSettingsData()) || {}).assist.locationHours,
    /* أوزان الأصناف بالوزن الحين (من فهرس المنيو الحي) — لتحديث سعر سطر الوزن وقت فتح رابط السلة */
    weightsNow: async () => { const m = await menuIndex((await getSettingsData()) || {}, clock()); if (!m) return null; const by = {}; for (const i of m.items) if (i.byWeight && Array.isArray(i.weights) && i.weights.length) by[String(i.id)] = i.weights; return by; } });      // السلات الجاهزة (نفس الطلب الأخير؛ ومساعد الطلبات بعدين)
  const llm = deps.llm || null;      // wabotllm.classify — تصنيف بس
  const aicost = makeAiCost({ pool, sendSms: deps.sendSms || null, now: deps.now || (() => new Date()) });   // كل نداء للموديل بيتسجّل بتكلفته + السقف
  /* مساعد الطلبات: المخزن (الجلسة، سجل الأدوار، الاقتراحات) ونداء الموديل. الحلقة نفسها بتتركّب تحت بعد الأدوات. */
  const assistStore = deps.assistStore || makeAssistStore({ pool, jb: (v) => JSON.stringify(v) });
  const assistCall = deps.assistCallModel || makeModelCaller();
  /* مفتاح تحويل الصوت (wasttkey.js): محفوظ متشفّر، ومفتاح «المساعد يسمع» مربوط بآخر اختبار ناجح. deps.transcribe = محوّل وهمي للاختبارات (من غير بوابة الاختبار). */
  const stt = deps.stt || makeStt({ pool, fetch: deps.sttFetch, now: clock });
  const transcribe = deps.transcribe || makeTranscriber();      // الصوت ⇒ نص (waassistmedia.js). في الاختبارات بيتبدّل بمحوّل وهمي.
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { console.error("[wabot] db:", e.message); return null; } };
  /* FD1 (١٤/١٠): حملة «طبقك المفضل» (wafavpick.js) — العرض اللي وصل لكل رقم + حسابه تاني الحين + مدخلات السلة. مش متوصّلة ⇒ الرد العادي. */
  const favApi = () => { try { return (typeof deps.fav === "function" ? deps.fav() : deps.fav) || null; } catch { return null; } };
  /* CR2 (١٦/١٠): آخر رسالة حملة Cloud للرقم (أو الرسالة اللي اتضغط زرها) ⇒ عرضها باسمه وسعره ورابطها (wacampreply.js) */
  const campReplyApi = deps.campReply || makeCampaignReply({ pool });

  /* البيانات الحية لرسالة واحدة. أي مصدر وقع ⇒ قيمته null/فاضية ⇒ الرد اللي محتاجه بيتحوّل لموظف. */
  async function loadData({ settings, cfg, phone, orderNo, key, now, know = null, arg = null, campaign = null, campReply = null }) {
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
    if (need("status", "complaint", "cancel_what", "change", "bill", "eta")) {
      const cols = `order_no, status, option, total, created_at, pos_ready_at, refund_id, to_jsonb(shop_orders)->>'handed_at' AS handed_at, NULLIF(to_jsonb(shop_orders)->>'table_no','')::int AS table_no`;
      const r = orderNo
        ? await q(`SELECT ${cols} FROM shop_orders WHERE order_no=$1 AND phone_norm=$2 AND status NOT IN ('expired','pending_payment') LIMIT 1`, [orderNo, phone])
        : await q(`SELECT ${cols} FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment')
                    AND created_at > NOW() - make_interval(hours => $2::int) ORDER BY created_at DESC LIMIT 1`, [phone, Math.ceil(cfg.orderLookbackHours)]);
      if (r === null) data.orderDbFailed = true;        // القاعدة ماردّتش ⇒ مانقولش «مافيه طلب» — نحوّل لموظف
      data.order = r && r[0] ? r[0] : null;
      /* MJ1 #٥ (سالم ١٦/١٠: «لو تكرّمت اكتب رقم الطلب» ورقمه في رسالة التقييم اللي قبلها): مفيش طلب على رقم المرسل ⇒ رقم الطلب من المحادثة نفسها —
         آخر رسالة طلب بعتناها له (تحديث / تقييم) أو طلب رسالة التقييم أو زر «تابع طلبك»، خلال ٧ أيام. الطلب نفسه بيتقري برقمه (الرسالة راحت للرقم ده أصلاً). */
      if (!data.order && !orderNo && !data.orderDbFailed && need("complaint", "change") && /^5\d{8}$/.test(String(phone || ""))) {
        const th = await q(`/*mj1:thread_order*/ SELECT order_no FROM (
            SELECT order_no, created_at AS at FROM wa_messages WHERE phone_norm=$1 AND direction='out' AND order_no IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
            UNION ALL SELECT review_order, review_asked_at FROM wa_bot_chats WHERE phone_norm=$1 AND review_order IS NOT NULL AND review_asked_at > NOW() - INTERVAL '7 days'
            UNION ALL SELECT follow_order, follow_at FROM wa_bot_chats WHERE phone_norm=$1 AND follow_order IS NOT NULL AND follow_at > NOW() - INTERVAL '7 days') x
          ORDER BY at DESC NULLS LAST LIMIT 1`, [phone]);
        const tno = th && th[0] && /^[A-Za-z0-9-]{3,30}$/.test(String(th[0].order_no || "")) ? String(th[0].order_no) : null;
        if (tno) { const r2 = await q(`/*mj1:order_by_no*/ SELECT ${cols} FROM shop_orders WHERE order_no=$1 AND status NOT IN ('expired','pending_payment') LIMIT 1`, [tno]); if (r2 && r2[0]) { data.order = r2[0]; data.orderFromThread = true; } }
      }
    }
    /* FD1: رد على رسالة «طبقك المفضل» (الضغطة أو «نعم» أول رد — القرار في work) ⇒ العرض المخزّن للرقم ده بس */
    data.campaign = key === "order" && campaign && campaign.fav ? campaign : null;
    data.campReply = key === "order" && !data.campaign && campReply && campReply.ok ? campReply : null;      // CR2: عرض الحملة اللي العميل رد عليها
    const campSlug = data.campaign && data.campaign.fav.slug ? [String(data.campaign.fav.slug)] : [];
    const slugs = [...new Set([cfg.links.organic, cfg.links.ads, cfg.links.packs, "wab-menu", ...(key === "box" && arg ? [String(arg)] : []), ...campSlug, ...Object.values(cfg.links.adMap)])];
    const lr = await q("SELECT slug FROM cms_links WHERE slug = ANY($1::text[]) AND active", [slugs]);
    for (const x of lr || []) data.links[x.slug] = true;
    return data;
  }

  const OUT_AFTER_SQL = "SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND direction='out' AND COALESCE(source,'api') <> 'echo' AND created_at > $2 LIMIT 1";
  const tuneOr = (cfg) => cfg || DEFAULTS;
  async function chatOf(phone) { const r = await q("SELECT * FROM wa_bot_chats WHERE phone_norm=$1", [phone]); return (r && r[0]) || {}; }
  const isoOf = (v) => (v ? new Date(v).toISOString() : null);
  const argOf = (a) => (a == null ? "" : typeof a === "string" ? a : JSON.stringify(a)).slice(0, 120);
  async function recent(phone, key, arg = null, text = null) {
    /* الإشعارات نفسها (rate / rate_burst / handoff_remind) مابتتعدّش. ضغطات القائمة (msg_type=interactive) بتتعدّ لوحدها. */
    const NOT_NOTICE = `COALESCE(reply_key,'') NOT IN ('rate','rate_burst','handoff_remind')`, OKD = `decision IN ('replied','dry')`, TAP = `COALESCE(msg_type,'') = 'interactive'`;
    const r = await q(`SELECT count(*) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND NOT ${TAP})::int AS n_text, min(at) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND NOT ${TAP}) AS oldest_text,
                              count(*) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND ${TAP})::int AS n_tap, min(at) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND ${TAP}) AS oldest_tap,
                              count(*) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND at > NOW() - INTERVAL '1 minute')::int AS n_min, min(at) FILTER (WHERE ${OKD} AND ${NOT_NOTICE} AND at > NOW() - INTERVAL '1 minute') AS oldest_min,
                              max(at) FILTER (WHERE ${OKD} AND reply_key='rate') AS rate_at, max(at) FILTER (WHERE ${OKD} AND reply_key='rate_burst') AS burst_at,
                              count(*) FILTER (WHERE decision IN ('replied','dry') AND at > NOW() - INTERVAL '1 hour')::int AS n,
                              max(at) FILTER (WHERE decision IN ('replied','dry') AND reply_key=$2 AND COALESCE(reply_arg,'')=$3) AS same_at,
                              max(at) FILTER (WHERE decision IN ('replied','dry') AND $4::text <> '' AND COALESCE(text,'') = $4) AS same_text_at,
                              (array_agg(reply_key ORDER BY at DESC) FILTER (WHERE decision IN ('replied','dry') AND $4::text <> '' AND COALESCE(text,'') = $4))[1] AS same_text_key,
                              max(at) FILTER (WHERE decision='failed' AND error NOT LIKE 'skipped:%' AND at > NOW() - INTERVAL '10 minutes') AS failed_at
                         FROM wa_bot_log WHERE phone_norm=$1 AND at > NOW() - INTERVAL '1 hour'`, [phone, key, argOf(arg), String(text || "")]);
    const x = (r && r[0]) || {};
    const at = (v) => (v ? isoOf(v) : null);
    return { n: Number(x.n) || 0, rate: { text: Number(x.n_text) || 0, taps: Number(x.n_tap) || 0, minute: Number(x.n_min) || 0, oldestText: at(x.oldest_text), oldestTap: at(x.oldest_tap), oldestMinute: at(x.oldest_min), rateAt: at(x.rate_at), burstAt: at(x.burst_at) }, lastSame: x.same_at ? { key, at: isoOf(x.same_at) } : null, sameTextAt: x.same_text_at ? isoOf(x.same_text_at) : null, sameTextKey: x.same_text_key || null, failedRecently: Boolean(x.failed_at) };
  }
  /* M1 — الردود الآلية بتاعة تطبيق واتساب بزنس. autoRepliesActive: فيه صدى آلي اتسجّل في آخر ٧ أيام (كاش ٥ دقايق). autoEchoAfter: صدى آلي للعميل ده بعد اللحظة دي
     ⇒ true / false / null (القاعدة ماردّتش ⇒ مانأجّلش ومانسكتش: الرد يطلع عادي). */
  const AUTO_COVERED = new Set(["greet", "order", "offers"]);
  let autoSeen = { at: -1e15, on: false };
  async function autoRepliesActive() {
    const t = clock().getTime();
    if (t - autoSeen.at < (autoSeen.on ? 300_000 : 30_000) && t >= autoSeen.at) return autoSeen.on;      // «شغّال» بيتخزّن ٥ دقايق، «مش شغّال» نص دقيقة بس
    const r = await q("SELECT 1 FROM wa_messages WHERE echo_kind='auto' AND created_at > NOW() - INTERVAL '7 days' LIMIT 1", []);
    if (r === null) return false;
    autoSeen = { at: t, on: r.length > 0 };
    return autoSeen.on;
  }
  async function autoEchoAfter(phone, at) {
    const r = await q("SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND echo_kind='auto' AND created_at >= $2::timestamptz - INTERVAL '5 seconds' LIMIT 1", [phone, at]);
    return r === null ? null : r.length > 0;
  }
  /* تنفيذ الردود المؤجّلة لثواني في ميعادها (المؤقّت العام كل ١٥ ثانية). في الاختبارات deps.noTimer ⇒ مفيش مؤقّتات. */
  const soon = (ms) => { if (deps.noTimer) return; const t = setTimeout(() => { runDueJobs().catch((e) => console.error("[wabot] jobs:", e.message)); }, Math.max(250, ms)); if (t.unref) t.unref(); };
  /* آخر رسالة بعتها الموظف من موبايل المطعم للعميل ده (صدى) — بالثانية، مش «فيه/مافيش» */
  async function lastEcho(phone) {
    const r = await q(`SELECT max(created_at) AS at FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > NOW() - INTERVAL '24 hours' AND ${STAFF_ECHO_SQL}`, [phone]);
    return r && r[0] && r[0].at ? isoOf(r[0].at) : null;
  }

  /* ST1: تنبيه الفريق بقى على واتساب أولاً (wateam.js: حر لو نافذة الموظف مفتوحة ⇒ قالب فريق معتمد ⇒ SMS كآخر حل). stage = new | reminder | reopened.
     واتساب الفريق مقفول من اللوحة، أو مفيش ولا مستلم للموضوع ده في الدليل ⇒ المسار القديم (SMS لأرقام التنبيهات) زي ما هو بالظبط. */
  const teamApi = () => { try { return typeof deps.team === "function" ? deps.team() : deps.team || null; } catch { return null; } };
  async function alertStaff(settings, cfg, { phone, reason, orderNo, urgent = null, stage = "new", waitedMin = null }) {
    if (!cfg.staffAlert) return "off";
    const sc = staffConfig(settings);
    const cap = await q("SELECT count(*)::int AS n FROM wa_bot_log WHERE alert='sent' AND at > NOW() - INTERVAL '1 hour'", []);
    /* السقف في الساعة للتنبيهات العادية. العاجل (شكوى، مشكلة دفع، تعديل طلب، حساسية شديدة…) مابيتقفلش بيه — له حد أعلى بكتير ضد السيل بس (٥ أضعاف). */
    const capped = Boolean(cfg.maxAlertsPerHour && cap && Number(cap[0]?.n) >= cfg.maxAlertsPerHour * (SERIOUS.has(String(reason)) ? 5 : 1));
    const body = alertText({ phone, reason, orderNo }, sc.lang);
    const team = teamApi();
    if (team && typeof team.handover === "function" && teamConfig(settings).enabled) {
      if (capped) return "capped";
      let r = null;
      try { r = await team.handover({ settings, phone, reason, reasonAr: REASON_AR[reason] || reason, urgent: urgent === null ? SERIOUS.has(String(reason)) : urgent === true, orderNo: orderNo || null, stage, waitedMin, sms: sendSms ? body : null }); }
      catch (e) { console.error("[wabot] team alert:", e.message); r = null; }
      if (r) return r.sent ? "sent" : "failed";
    }
    if (!sendSms) return "no_sender";
    const phones = cfg.alertPhones.length ? cfg.alertPhones : sc.alertPhones;
    if (!phones.length) return "no_phones";
    if (capped) return "capped";
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

  /* ST1 — «حاجات غريبة» للمدير والملاك (wateam.js: مفتاح لكل نوع + سقف في الساعة + وضع ملخص). بتتبعت بس في وضع العملاء (أو التجربة لو alertInTest)،
     زي تنبيهات التحويل. عمرها ما بترمي ومابتوقّفش رد العميل. */
  async function oddThing(settings, cfg, kind, phone, x = {}) {
    if (!(cfg.mode === "live" || (cfg.mode === "test" && cfg.alertInTest))) return null;
    const team = teamApi();
    if (!team || typeof team.odd !== "function") return null;
    try { return await team.odd({ kind, phone: /^5\d{8}$/.test(String(phone || "")) ? phone : null, settings, ...x }); } catch (e) { console.error("[wabot] odd:", e.message); return null; }
  }

  /* رسالة واردة واحدة. بترجّع true لو البوت «ماسك» (أي وضع غير off). عمرها ما بترمي. */
  async function handle(ev) {
    let settings;
    try { settings = (await getSettingsData()) || {}; } catch { return false; }
    /* ST1: رقم من دليل الفريق مش عميل — ضغطة «جدّد التنبيهات» وأوامر الفريق بتتنفّذ في wateam، وأي رسالة تانية منه بتعدّي في صمت
       (لا ترحيب ولا بيع ولا تحويل عن نفسه) — في أي وضع للبوت، حتى off. */
    if (!ev.isEcho) { const team = teamApi(); if (team && typeof team.inbound === "function") { let mine = false; try { mine = (await team.inbound(ev, settings)) === true; } catch (e) { console.error("[wabot] team inbound:", e.message); } if (mine) return true; } }
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
    if (!afterWait && cls.key === "unsupported" && /^5\d{8}$/.test(phone)) {
      const prior = await q(OUT_AFTER_SQL, [phone, new Date(now.getTime() - tuneOr(cfg).openerHours * 3600_000).toISOString()]);
      if (prior && prior.length === 0) {
        ev = { ...ev, type: "text", text: "مرحبا", opener: "unsupported" }; cls = { ...classify(ev, know), rawIntent: "unsupported_opener" };
        /* ١٤/١٠: أول رسالة نوعها مش مدعوم (ميتا 131060/131051) = غالباً ضغطة «راسلنا» من إعلان. صندوق المحادثات يقول كده بدل «[رسالة مش مدعومة]»، والمحادثة تتعلّم «من إعلان (غالباً)» لو مالهاش مصدر. */
        if (ev.wamid) await q("UPDATE wa_messages SET body=$2 WHERE wamid=$1 AND msg_type='unsupported'", [ev.wamid, UNSUPPORTED_OPENER_BODY]);
        await q(`INSERT INTO wa_bot_chats(phone_norm, referral, referral_at) VALUES ($1,$2,NOW())
                 ON CONFLICT (phone_norm) DO UPDATE SET referral=COALESCE(wa_bot_chats.referral, $2), referral_at=COALESCE(wa_bot_chats.referral_at, NOW()), updated_at=NOW()`, [phone, jb({ source_type: "unsupported_opener", guess: true, headline: null })]);
      }
    }
    /* ١٤/١٠: الرسالة الجاهزة من زر «تابع طلبك» ⇒ المحادثة «متابعة طلب» (follow_order/follow_at) — للتقرير والمتابعة. رسالته نفسها فتحت النافذة. */
    if (!afterWait && cls.rawIntent === "follow_link" && /^5\d{8}$/.test(phone) && cls.entities && cls.entities.orderNo)
      await q("INSERT INTO wa_bot_chats(phone_norm, follow_order, follow_at) VALUES ($1,$2,NOW()) ON CONFLICT (phone_norm) DO UPDATE SET follow_order=$2, follow_at=NOW(), updated_at=NOW()", [phone, String(cls.entities.orderNo).slice(0, 30)]);
    /* SB2: «تمام» / «عندي ملاحظة» مكتوبة بعد رسالة التقييم (خلال reviewReplyHours ولسه مااتردّش عليها) = نفس الزرار. الضغطة نفسها بتوصل بمعرّفها (classify). */
    if (!afterWait && cfg.reviewWhatsApp && /^5\d{8}$/.test(phone) && !ev.interactiveId && (cls.key === "ack" || REVIEW_NOTE_RE.test(normalize(String(ev.text || ""))))) {
      const rv = await q("SELECT review_code, review_order, review_asked_at, review_answered_at FROM wa_bot_chats WHERE phone_norm=$1", [phone]), c0 = rv && rv[0];
      /* RV1: السؤال المستني سؤال نجوم (قايمة/قالب النجوم) ⇒ «تمام» المكتوبة مش إجابة عليه (ماترجّعش القايمة تاني) */
      const sa = c0 && c0.review_code ? ((await q("SELECT review_stars_at FROM wa_bot_chats WHERE phone_norm=$1", [phone])) || [])[0] : null;
      const starsPending = Boolean(sa && sa.review_stars_at && c0.review_asked_at && Date.parse(sa.review_stars_at) >= Date.parse(c0.review_asked_at));
      if (c0 && c0.review_code && c0.review_asked_at && !c0.review_answered_at && !starsPending && now.getTime() - Date.parse(c0.review_asked_at) < cfg.reviewReplyHours * 3600_000)
        cls = { ...cls, key: REVIEW_NOTE_RE.test(normalize(String(ev.text || ""))) ? "review_note" : "review_ok", arg: { code: c0.review_code, order: c0.review_order || null }, rawIntent: "review_typed" };
    }
    /* SB4: «تمام 👍 / عندي ملاحظة» من قالب أو تحديث حر (من غير كود) ⇒ دعوة التقييم المستنية، وإلا آخر دعوة للرقم (٤٨ ساعة) — وبتتعلّم «اتبعتت» عشان طلب التقييم مايتبعتش تاني */
    if (!afterWait && (cls.key === "review_ok" || cls.key === "review_note") && (!cls.arg || !cls.arg.code) && /^5\d{8}$/.test(phone)) {
      const c1 = ((await q("SELECT review_code, review_order, review_asked_at FROM wa_bot_chats WHERE phone_norm=$1", [phone])) || [])[0];
      let code = c1 && c1.review_code && c1.review_asked_at && now.getTime() - Date.parse(c1.review_asked_at) < 48 * 3600_000 ? c1.review_code : null, order = code ? c1.review_order || null : null;
      if (!code) { const iv = ((await q("SELECT code, order_no FROM review_invites WHERE phone_norm=$1 AND created_at > NOW() - INTERVAL '48 hours' ORDER BY created_at DESC LIMIT 1", [phone])) || [])[0];
        if (iv) { code = iv.code; order = iv.order_no; await q("UPDATE review_invites SET sent_at=COALESCE(sent_at, NOW()), channel=COALESCE(channel, 'wa_tap') WHERE code=$1", [code]); } }
      cls = { ...cls, arg: { code, order } };
    }
    /* RV1: «تمام» ⇒ قايمة النجوم لنفس الطلب: نوعه ورقمه، ولو اتقيّم قبل كده ⇒ شكر بس */
    if (!afterWait && cls.key === "review_ok" && cfg.reviewFlow.enabled && cls.arg && cls.arg.code && /^5\d{8}$/.test(phone)) {
      const iv = ((await q("SELECT kind, option, ref, rating, skip_reason FROM review_invites WHERE code=$1 AND phone_norm=$2", [cls.arg.code, phone])) || [])[0];
      /* دعوة اتقفلت لأن الرقم موظف / موقِّف الرسايل ⇒ سطر شكر بس، من غير سؤال نجوم (مانسجّلش تقييم موظف، ومانطلبش من اللي وقّف) */
      if (iv && /^(staff|opted_out|wa_)/.test(String(iv.skip_reason || ""))) cls = { ...cls, arg: { ...cls.arg, code: null } };
      else if (iv) cls = { ...cls, arg: { ...cls.arg, kind: iv.kind || (iv.option === "pickup" ? "pickup" : "delivery"), ref: iv.ref || null, rated: iv.rating != null } };
    }
    /* SB4 سطر الولاء مع «تمام»: مش مع سؤال التقييم الجديد (RV1) — مايبانش إنه مقابل التقييم */
    if (!afterWait && cls.key === "review_ok" && cfg.windowSell && !cfg.reviewFlow.enabled && assist && /^5\d{8}$/.test(phone)) {
      try { const c2 = ((await q("SELECT window_sell_at FROM wa_bot_chats WHERE phone_norm=$1", [phone])) || [])[0];
        if (!(c2 && c2.window_sell_at && now.getTime() - Date.parse(c2.window_sell_at) < 24 * 3600_000)) {
          const of = await assist.get_offers(phone), lo = of && of.loyalty, rw = ((of && of.rewards) || []).find((r) => r.freeDelivery), L = cls.lang === "en" ? "en" : "ar";
          const line = rw ? salesTextOf(cfg, rw.expires ? "sb_reward_until" : "sb_reward", { code: rw.code, from: rw.minTotal, until: rw.expires ? dayMonth(rw.expires) : "" }, L)
            : lo && lo.reward === "free_delivery" && lo.progress > 0 ? salesTextOf(cfg, lo.left === 1 ? "sb_loyalty_one" : "sb_loyalty_left", { from: lo.min_total, every: lo.every, left: lo.left }, L) : null;
          if (line) { cls = { ...cls, arg: { ...(cls.arg || {}), extra: line } }; await q("UPDATE wa_bot_chats SET window_sell_at=NOW() WHERE phone_norm=$1", [phone]); }
        } } catch (e) { console.error("[wabot] window sell:", e.message); }
    }
    if (!afterWait && (cls.key === "review_ok" || cls.key === "review_note") && cls.arg && /^5\d{8}$/.test(phone)) {
      await q("UPDATE wa_bot_chats SET review_answered_at=NOW() WHERE phone_norm=$1", [phone]);
      await q("UPDATE review_invites SET wa_answer=$2, wa_answered_at=NOW() WHERE code=$1 AND wa_answer IS NULL", [cls.arg.code, cls.key === "review_ok" ? "ok" : "note"]);
    }
    /* ═══ RV1 — النجوم جوّه واتساب (wareviews.js) ═══
       • «٥» / «⭐⭐⭐⭐» مكتوبة بعد سؤال نجوم مستني ⇒ نفس ضغطة النجمة.
       • أول نص بعد تقييم واطي (lowCommentMin) ⇒ تعليقه في «التقييمات ← الوارد» (والمحادثة نفسها عند المدير).
       • ضغطة نجمة ⇒ صف في reviews + الدعوة بتتقفل + التوجيه (جوجل / شكر / اعتذار + المدير) قبل القرار، عشان buildReply يبني الرد منه.
       • ضغطة سبب ⇒ بيتضاف لتصنيفات التقييم. «تمام» والمسار شغّال ⇒ سؤال النجوم اتعرض (review_stars_at). */
    if (!afterWait && /^5\d{8}$/.test(phone)) {
      if (cls.key !== "review_star" && cls.key !== "review_reason" && !ev.interactiveId && String(ev.type || "text") === "text" && String(ev.text || "").trim()) {
        const n = typedStar(ev.text);
        const pend = n ? await pendingStars(q, phone, now, cfg.reviewReplyHours) : null;
        if (pend) cls = { ...cls, key: "review_star", arg: { stars: n, exact: true, code: pend.code }, rawIntent: "review_star_typed" };
        else { try { await captureLowComment(q, { phone, text: ev.text, flow: cfg.reviewFlow, now }); } catch (e) { console.error("[wabot] review comment:", e.message); } }
      }
      if (cls.key === "review_star") { try { cls = await applyStar(q, { phone, cls, flow: cfg.reviewFlow, rcfg: reviewsCfgOf(settings), contextId: ev.contextId || null }); } catch (e) { console.error("[wabot] review star:", e.message); } }
      else if (cls.key === "review_reason") { try { cls = await applyReason(q, { phone, cls }); } catch (e) { console.error("[wabot] review reason:", e.message); } }
      else if (cls.key === "review_ok" && cfg.reviewFlow.enabled && cls.arg && cls.arg.code && !cls.arg.rated) {
        await q(`INSERT INTO wa_bot_chats(phone_norm, review_code, review_order, review_stars_at) VALUES ($1,$2,$3,NOW())
                 ON CONFLICT (phone_norm) DO UPDATE SET review_code=$2, review_order=$3, review_stars_at=NOW(), updated_at=NOW()`, [phone, String(cls.arg.code), String(cls.arg.order || "").slice(0, 30) || null]);
      }
    }
    /* آخر موقع شاركه العميل بيتحفظ على محادثته (لفحص النطاق، ولمساعد الطلبات عشان مايسألش عن العنوان تاني) */
    if (!afterWait && cls.key === "area" && cls.arg && /^5\d{8}$/.test(phone)) {
      await q(`INSERT INTO wa_bot_chats(phone_norm, last_loc) VALUES ($1,$2) ON CONFLICT (phone_norm) DO UPDATE SET last_loc=$2, updated_at=NOW()`, [phone, jb({ lat: cls.arg.lat, lng: cls.arg.lng, at: now.toISOString(), via: cls.rawIntent })]);
    }
    const finish = (d) => finishLog(logId, d);
    /* ST1 — الحاجات الغريبة اللي بتتعرف بعد القرار (بعد ما رد العميل اتبعت): سؤال الأسرار، مش عميل، شكوى، مشكلة دفع، البوت كرر نفس الكارت،
       رسالة مش مدعومة فتحت محادثة، عميل وقّف. كل نوع له مفتاحه في اللوحة؛ التكرار لنفس العميل ونفس النوع بيتمسك في wateam (repeatMin). */
    const oddAfter = async ({ d, handoff, okSent }) => {
      const ho = handoff ? handoff[0] : null, typed = !ev.interactiveId && ev.opener !== "unsupported" && String(ev.type || "text") === "text" ? String(ev.text || "") : "";
      if (d.key === "secret" && okSent) await oddThing(settings, cfg, "secret", phone, { detail: "سأل عن وصفة / مقادير / مورّد — خد الرد المهني من غير أي تفصيلة" });
      const nc = typed ? nonCustomerKind(typed) : null;
      if (nc) await oddThing(settings, cfg, "non_customer", phone, { detail: nc === "job_seeker" ? "شكله بيدوّر على شغل" : "شكله عرض من مورّد / شركة" });
      if (ho === "complaint") await oddThing(settings, cfg, "complaint", phone);
      if (ho === "problem") await oddThing(settings, cfg, "payment_problem", phone);
      if (ho === "repeated_card") await oddThing(settings, cfg, "repeated_card", phone);
      if (ev.opener === "unsupported" && okSent) await oddThing(settings, cfg, "unsupported_opener", phone, { detail: "أول رسالة نوعها مش مدعوم — اترد عليها بالترحيب" });
      if (d.optout === "stop" || d.optout === "stop_all") await oddThing(settings, cfg, "customer_stopped", phone, { detail: d.optout === "stop_all" ? "وقّف كل الرسايل (العروض وتحديثات الطلب)" : "وقّف العروض" });
    };
    try {
      // ٢) الإعلان: نحفظ مصدره على المحادثة من أول رسالة (حتى لو هنسكت)
      if (!afterWait && !ev.autoWaited && ev.referral && /^5\d{8}$/.test(phone)) {
        const r = ev.referral;
        const ref = { source_id: r.source_id || null, source_type: r.source_type || null, source_url: r.source_url || null, headline: r.headline ? String(r.headline).slice(0, 120) : null, ctwa_clid: r.ctwa_clid || null };
        await q(`INSERT INTO wa_bot_chats(phone_norm, referral, referral_at) VALUES ($1,$2,NOW())
                 ON CONFLICT (phone_norm) DO UPDATE SET referral=$2, referral_at=NOW(), updated_at=NOW()`, [phone, jb(ref)]);
        await q(`INSERT INTO wa_ad_chats(phone_norm, ad_id, headline, source_type) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (phone_norm, ad_id) DO UPDATE SET last_at=NOW(), clicks = wa_ad_chats.clicks + 1, headline = COALESCE(EXCLUDED.headline, wa_ad_chats.headline)`,
          [phone, String(ref.source_id || "").slice(0, 40), ref.headline, ref.source_type ? String(ref.source_type).slice(0, 20) : null]);
      }
      const ok = /^5\d{8}$/.test(phone);
      /* M1 — من غير رد مكرر: تطبيق واتساب بزنس بيرد لوحده على التحية / «كيف أطلب» / «وش العرض». لو رده الآلي غطّى الرسالة دي (صدى auto بعدها)، البوت مايردّش فوقه
         (auto_reply_covered). وعشان الصدى ممكن يوصل بعد ويب هوك الرسالة: الرد على التلاتة دول بيتأجّل autoEchoMaxSec ثانية ويتراجع قبل الإرسال.
         بيتطبّق بس لو التطبيق فعلاً بيرد آلي (فيه صدى آلي في آخر ٧ أيام) — غير كده مفيش أي تأخير. الضغطات والأسئلة التانية بتتجاوب فوراً. */
      if (ok && cfg.autoEchoSkipCovered && !afterWait && !ev.autoWaited && !ev.interactiveId && AUTO_COVERED.has(cls.key) && cfg.autoEchoMaxSec > 0 && (cfg.mode === "live" || cfg.mode === "test") && (await autoRepliesActive())) {
        const at = ev.at || now.toISOString();
        const cov = await autoEchoAfter(phone, at);
        if (cov === true) { await finish({ decision: "silent", reason: "auto_reply_covered", key: cls.key }); return; }
        const due = Date.parse(at) + cfg.autoEchoMaxSec * 1000;
        if (cov === false && due > now.getTime()) {
          const evLite = { phone, phoneNorm: phone, wamid: ev.wamid || null, text: String(ev.text || "").slice(0, 1000), type: ev.type || "text", interactiveId: null, referral: ev.referral || null, location: null, media: null, at, intent: ev.intent || null, autoWaited: true, cls: null };
          const j = await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`aw:${ev.wamid || logId}`, phone, "auto_wait", new Date(due).toISOString(), jb(evLite), logId]);
          if (j && j.length) { await finish({ decision: "waiting", reason: "auto_wait", key: cls.key, resumeAt: new Date(due).toISOString() }); soon(due - now.getTime() + 250); return; }
        }
      }
      const chat = await chatOf(phone);
      /* EX5 — رد آلي وارد + حارس الحلقات. للنص المكتوب بس (الضغطات والمواقع والصور لأ)، وعمره ما بيمسك «إيقاف / اشتراك». */
      if (ok && !afterWait && !ev.autoWaited && !ev.interactiveId && !ev.intent && String(ev.type || "text") === "text" && String(ev.text || "").trim() && !["stop", "start", "stop_updates"].includes(cls.key)) {
        const outs = await q(`SELECT max(created_at) FILTER (WHERE template IS NOT NULL) AS tpl_at, max(created_at) AS out_at FROM wa_messages
                               WHERE phone_norm=$1 AND direction='out' AND COALESCE(source,'api') <> 'echo' AND COALESCE(status,'') NOT IN ('failed','skipped') AND created_at > NOW() - INTERVAL '10 minutes'`, [phone]);
        const msgAt = Number.isFinite(Date.parse(ev.at)) ? Date.parse(ev.at) : now.getTime();
        const since = (v) => (v ? (msgAt - new Date(v).getTime()) / 1000 : null);
        const sinceTpl = outs && outs[0] ? since(outs[0].tpl_at) : null, sinceOut = outs && outs[0] ? since(outs[0].out_at) : null;
        const kind = autoInboundKind({ text: ev.text, sinceTemplateSec: sinceTpl, cfg });
        if (kind) {
          /* مش رد عميل على الحملة: صف الرد اللي wasender سجّله من الويب هوك بيتشال (إلا لو إيقاف)، وعلامة «رد» على صف الإرسال بترجع لو مالهاش رد تاني. */
          if (ev.wamid) {
            const del = await q("DELETE FROM wa_replies WHERE phone_norm=$1 AND ext_id=$2 AND NOT is_optout RETURNING queue_id", [phone, String(ev.wamid).slice(0, 200)]);
            for (const d0 of del || []) if (d0.queue_id != null) await q("UPDATE wa_send_queue SET replied_at=NULL WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM wa_replies WHERE queue_id=$1)", [d0.queue_id]);
          }
          await finish({ decision: "silent", reason: "auto_inbound", key: cls.key, detail: kind === "pattern" ? "pattern" : `after_template:${Math.max(0, Math.round(sinceTpl))}s` });
          await oddThing(settings, cfg, "auto_inbound", phone, { detail: kind === "pattern" ? "نص شكله رد آلي من نشاط تجاري" : "رد وصل بعد قالبنا بثواني" });
          return;
        }
        /* حارس الحلقات (مستقل عن اللي فوق): رسالة «سريعة» = وصلت خلال loopGuardFastSec من آخر رسالة طالعة مننا للرقم، ونصها ٢٥ حرف+ أو نفس نص رسالته اللي قبلها.
           loopGuardCount منها ورا بعض (السلسلة بتتصفّر بعد loopGuardSeconds أو بأي رسالة بإيقاع بشري) ⇒ كتم + تنبيه واحد في البورتال، من غير رد ومن غير SMS. */
        if (cfg.loopGuardCount > 0 && (cfg.mode === "live" || (cfg.mode === "test" && cfg.testPhones.includes(phone))) && !(chat.muted_until && Date.parse(chat.muted_until) > now.getTime())) {
          const txt = String(ev.text).trim();
          let fast = sinceOut != null && sinceOut >= -3 && sinceOut <= cfg.loopGuardFastSec;
          if (fast && [...txt].length < AUTO_INBOUND_MIN_CHARS) {
            const prev = await q("SELECT text FROM wa_bot_log WHERE phone_norm=$1 AND id <> $2 AND at > NOW() - make_interval(secs => $3::int) ORDER BY at DESC LIMIT 1", [phone, logId, Math.ceil(cfg.loopGuardSeconds)]);
            fast = Boolean(prev && prev[0] && String(prev[0].text || "").trim() === txt);
          }
          if (fast) {
            const st = await q(`INSERT INTO wa_bot_chats(phone_norm, loop_streak, loop_at) VALUES ($1, 1, NOW())
                                ON CONFLICT (phone_norm) DO UPDATE SET loop_streak = CASE WHEN wa_bot_chats.loop_at > NOW() - make_interval(secs => $2::int) THEN wa_bot_chats.loop_streak + 1 ELSE 1 END, loop_at = NOW(), updated_at = NOW()
                                RETURNING loop_streak`, [phone, Math.ceil(cfg.loopGuardSeconds)]);
            if (st && st[0] && Number(st[0].loop_streak) >= cfg.loopGuardCount) {
              await muteChat(phone, cfg.loopGuardMuteHours, "loop_guard");
              await q("UPDATE wa_bot_chats SET loop_streak=0 WHERE phone_norm=$1", [phone]);
              if (typeof deps.portalEmit === "function") { try { deps.portalEmit("wa_handover", { phone: `0${phone}`, phoneMasked: `…${phone.slice(-4)}`, reason: "loop_guard", reasonAr: REASON_AR.loop_guard, urgent: false, orderNo: null, at: now.toISOString(), test: cfg.mode === "test", note: true }); } catch (e) { console.error("[wabot] portal:", e.message); } }
              await finish({ decision: "silent", reason: "loop_guard", key: cls.key, detail: `${st[0].loop_streak} fast in a row`, resumeAt: new Date(now.getTime() + cfg.loopGuardMuteHours * 3600_000).toISOString() });
              await oddThing(settings, cfg, "loop_guard", phone, { detail: `${st[0].loop_streak} رسايل سريعة ورا بعض — البوت اتكتم ${cfg.loopGuardMuteHours} ساعة` });
              return;
            }
          } else if (Number(chat.loop_streak) > 0) await q("UPDATE wa_bot_chats SET loop_streak=0 WHERE phone_norm=$1", [phone]);
        }
      }
      let echoAt = ok ? await lastEcho(phone) : null;
      /* SR2 (١٣/١٠): الموظف ساب المحادثة للبوت (unmuteChat بـrelease) ⇒ رسايله اللي قبل اللحظة دي مابتسكّتش البوت ولا المساعد. */
      if (echoAt && chat.released_at && Date.parse(echoAt) <= Date.parse(chat.released_at)) echoAt = null;
      /* FD1 — رد على رسالة حملة «طبقك المفضل» («تبي نجهز لك الطلب هنا؟») ⇒ سلة جاهزة بالعرض اللي وصله. بيتحسب كده في حالتين بس (مراجعة ١٤/١٠):
         (١) ضغطة زر الرد «أبغى أطلب» نفسه (الـpayload = نص الزر)، طول ما آخر رسالة حملة للرقم هي «طبقك المفضل» (campaignOfferHours).
         (٢) موافقة مكتوبة صريحة (isCampaignYes: «نعم / ايوه / أبغى أطلب»، مش «تمام / 👍 / طيب / ماشي» ولا إيموجي) لو هي أول حاجة حصلت بعد الرسالة:
             مش متأخرة، مفيش سؤال موافقة مستني، ولا رسالة تانية من العميل، ولا أي رسالة طلعت له (بوت/موظف/تحديث طلب)، ولا طلب من ساعتها (yesGate).
         أي رسالة تانية في الـ٧٢ ساعة دي («أبغى أطلب برجر»، «كيف أطلب»، سؤال…) بتمشي في طريقها العادي (القواعد أو المساعد). مش بيتحفظ مع الانتظار. */
      let campOffer = null;
      if (ok && cfg.campaignCart && favApi()) {
        const tap = Boolean(ev.interactiveId) && CAMPAIGN_TAP_IDS.has(String(ev.interactiveId).trim()) && cls.key === "order";
        const typed = !tap && !afterWait && !ev.interactiveId && String(ev.type || "text") === "text" && ["ack", "order", "unknown", "offers"].includes(cls.key) && isCampaignYes(ev.text);      // «ابي العرض» بتتصنّف «عروض»؛ «تمام» على رسالة التقييم (review_ok) وغيره من التصنيفات المحددة مابيتلمسوش
        if (tap || typed) {
          /* مراجعة FD1 ٣: كل قوالب الحملات فيها نفس زر «أبغى أطلب» — الضغطة بتتقرا على الرسالة اللي اتضغط زرها نفسها (context.id من ميتا)،
             فضغطة تحت إطار حملة تانية قديمة مابتجيبش سلة «طبقك المفضل». ردّ مكتوب «نعم» مقتبس على رسالة تانية (context.id غير رسالة الحملة) مش موافقة عليها. */
          const ctxId = ev.contextId ? String(ev.contextId) : null;
          let camp = null; try { camp = await favApi().lastOffer(phone, cfg.campaignOfferHours, tap && ctxId ? { wamid: ctxId } : {}); } catch (e) { console.error("[wabot] campaign offer:", e.message); camp = null; }
          if (camp && typed) {
            const asked = chat.optin_asked_at ? Date.parse(chat.optin_asked_at) : NaN, answered = chat.optin_answered_at ? Date.parse(chat.optin_answered_at) : NaN;
            const optinPending = Number.isFinite(asked) && now.getTime() - asked < cfg.optinAnswerWindowMin * 60_000 && !(Number.isFinite(answered) && answered >= asked);
            const at0 = Date.parse(ev.at || ""), late = Number.isFinite(at0) && (now.getTime() - at0) / 60000 > cfg.maxAgeMinutes;
            let why = optinPending ? "optin_pending" : late ? "late" : ctxId && ctxId !== String(camp.wamid || "") ? "replied_to_other" : null;
            /* «نعم» مقتبسة على رسالة الحملة نفسها = رد عليها أكيد ⇒ من غير شرط الهدوء قبلها */
            if (!why) { try { why = await favApi().yesGate(phone, camp, { logId, quietMin: ctxId && ctxId === String(camp.wamid || "") ? 0 : cfg.campaignYesQuietMin }); } catch (e) { console.error("[wabot] campaign yes:", e.message); why = "gate_failed"; } }
            if (why) { await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `campaign_yes:${String(why).slice(0, 40)}`]); camp = null; }
          }
          if (camp) { campOffer = camp; cls = { ...cls, key: "order", rawIntent: tap ? "campaign_tap" : "campaign_yes" }; }
        }
      }
      /* FU1 — رد على رسالة «متابعة اللي ردّ» (آخر متابعة للرقم في ٢٤ ساعة):
         • زر «أبغى أطلب» (rf:yes) — أو «نعم / أبغى أطلب» مكتوبة كأول رسالة بعد المتابعة — والمتابعة كان فيها سلة جاهزة لسه صالحة ⇒ نفس السلة بزر (rf_yes)؛ من غير سلة ⇒ «أبي أطلب» العادي.
         • زر «لا شكراً» (rf:no) — أو «لا / لا شكراً» مكتوبة كأول رسالة بعدها ⇒ rf_no + مفيش متابعات replyFollowUpDeclineDays يوم.
         • أي رسالة بعد المتابعة ⇒ «اتردّ عليها» في الدفتر (التقرير والفرامل). مش في الرد المؤجّل (اتسجّل وقت وصول الرسالة). */
      if (ok && !afterWait && cfg.replyFollowUp) {
        const tapId = ev.interactiveId ? String(ev.interactiveId) : "";
        const plain = !ev.interactiveId && String(ev.type || "text") === "text" ? String(ev.text || "") : "";
        const typedYes = Boolean(plain) && isCampaignYes(plain), typedNo = Boolean(plain) && NACK_RE.test(normalize(plain));
        if (!campOffer && (tapId === "rf:yes" || tapId === "rf:no" || typedYes || typedNo)) {
          const fu = ((await q(FU_SQL.latest, [phone])) || [])[0] || null;
          /* المكتوبة بتتحسب رد على المتابعة بس لو مفيش ولا رسالة تانية من العميل بعدها (الضغطة على زرّها نفسه بتتحسب دايماً) */
          let first = false;
          if (fu && !fu.answered_at && !tapId) { const other = await q(FU_SQL.otherReply, [phone, logId, new Date(fu.sent_at).toISOString()]); first = other !== null && other.length === 0; }
          if (tapId === "rf:no" || (typedNo && first)) {
            cls = { ...cls, key: "rf_no", arg: null, rawIntent: "followup_no" };
            if (cfg.mode !== "dry") await q(FU_SQL.decline, [phone]);
          } else if (tapId === "rf:yes" || (typedYes && first)) {
            let url = null;
            if (fu && fu.cart_code) { const ck = await q(FU_SQL.cartOk, [String(fu.cart_code), phone]); if (ck && ck.length) url = `${STORE}/c/${fu.cart_code}`; }
            cls = url ? { ...cls, key: "rf_yes", arg: { url }, rawIntent: "followup_yes" } : { ...cls, key: "order", arg: null, rawIntent: "followup_yes" };
          }
        }
        /* «أبغى أطلب» على رسالة الحملة نفسها بعد المتابعة (campOffer) = «أبغى» برضه */
        if (cfg.mode !== "dry") await q(FU_SQL.answer, [phone, campOffer || cls.rawIntent === "followup_yes" ? "yes" : cls.key === "rf_no" ? "no" : ["stop", "stop_updates"].includes(cls.key) ? "stop" : "text"]);
      }
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
      /* CR2 (١٦/١٠) — «أبغى أطلب» على رسالة حملة تانية غير «طبقك المفضل» (الحالة: ١٦/١٠ 17:18، باقات التجمّع ١٥/١٠ ⇒ البوت رد بالرد العام ورابط wab-boxes):
         • ضغطة زر «أبغى أطلب» تحت القالب ⇒ صف الرسالة اللي اتضغط زرها نفسها (context.id = wamid الصف)؛ من غير context ⇒ آخر حملة للرقم.
         • نية طلب مكتوبة «فاضية» (تصنيف «order» + isCampaignYes: «أبغى أطلب» / «ابي اطلب»، مش «ابي اطلب كيلو مشكل») ⇒ آخر حملة للرقم، بس لو: مش مقتبسة على رسالة تانية، مفيش طلب من الموقع من ساعتها، مفيش موظف كتب له بعد الحملة،
           ومفيش محادثة مساعد شغّالة (ده كلام في سياق تاني). مش في الرد المؤجّل (الضغطة بتتقرا تاني من زرها).
         الأحدث «طبقك المفضل» والـFD1 رفض ⇒ مفيش عرض هنا (مانرجعش لحملة أقدم). «نعم» على متابعة FU1 (followup_yes) ليها ردها. العرض خلص/الرابط موقوف ⇒ الرد العام.
         rawIntent campaign_reply ⇒ القواعد دايماً (assistEligible: /^campaign_/) عشان رابط الحملة يطلع مضمون. */
      let campReply = null;
      if (ok && cfg.campaignReply && !campOffer && cls.key === "order" && cls.rawIntent !== "followup_yes") {
        const tapId = ev.interactiveId ? String(ev.interactiveId).trim() : "";
        const tap = Boolean(tapId) && CAMPAIGN_TAP_IDS.has(tapId);
        /* مراجعة CR2 (١٦/١٠): المكتوبة لازم تكون نية طلب «فاضية» (isCampaignYes: «أبغى أطلب» / «ابي اطلب» / «ابي العرض»). طلب فيه حاجة بعينها
           («ابي اطلب كيلو مشكل توصيل»، «ابي اطلب مشويات ل ٥ اشخاص») أو سؤال («كيف أطلب») بيمشي في طريقه العادي (المساعد/القواعد) — نفس قاعدة FD1. */
        const typed = !tapId && !afterWait && String(ev.type || "text") === "text" && isCampaignYes(ev.text);
        if (tap || typed) {
          const ctxId = ev.contextId ? String(ev.contextId) : null;
          let r = null;
          try { r = await campReplyApi.lastCampaign(phone, { hours: cfg.campaignReplyHours, wamid: ctxId, typed, now: now.getTime(), bundles: (know && Array.isArray(know.bundles) && know.bundles.length ? know.bundles : await bundles()), store: STORE }); }
          catch (e) { console.error("[wabot] campaign reply:", e.message); r = null; }
          let why = r && r.offer ? (r.offer.ok ? null : r.offer.why) : "failed";
          if (!why && typed) {
            if (echoAt && r.offer.sentAt && Date.parse(echoAt) > Date.parse(r.offer.sentAt)) why = "staff_since";
            else { let sess = null; try { sess = await assistStore.loadSession(phone, now, cfg.assist.sessionMin); } catch { sess = null; } if (sess && !(sess.state && sess.state.seed)) why = "assist_session"; }
          }
          if (!why) { campReply = r.offer; cls = { ...cls, arg: `camp:${r.offer.jobId || 0}`, rawIntent: "campaign_reply", lang: "ar" };      /* arg: «نفس المعلومة» بيتحسب على نفس الحملة بس، مش على رد «أبي أطلب» العام */
            await q("UPDATE wa_bot_log SET intent=$2, detail=$3 WHERE id=$1", [logId, "campaign_reply", `campaign_reply:job${r.offer.jobId || "?"}`]); }
          else if (!["no_campaign", "bad_phone"].includes(why)) await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `campaign_reply:${String(why).slice(0, 40)}`]);
        }
      }
      const rc = cls.key ? await recent(phone, cls.key, cls.arg, ["text", "interactive", "button"].includes(String(ev.type || "text")) ? String(ev.text || "").slice(0, 300) : "") : { n: 0, lastSame: null, sameTextAt: null, sameTextKey: null, failedRecently: false };
      await q("UPDATE wa_bot_log SET reply_arg=$2 WHERE id=$1", [logId, argOf(cls.arg)]);
      let data;
      try { data = await loadData({ settings, cfg, phone, orderNo: cls.entities?.orderNo || null, key: cls.key, now, know, arg: cls.arg, campaign: campOffer, campReply }); }
      catch (e) {   // مصدر بيانات وقع كله ⇒ بيانات فاضية: أي رد محتاج بيانات هيتحوّل لموظف من نفسه (DataMissing)
        console.error("[wabot] data:", e.message);
        data = { settings, now, bundles: [], policy: null, first: null, loyalty: null, order: null, orderDbFailed: true, links: {}, open: null };
      }
      /* EX6 — سياق آخر رد: (١) «خليها نص كيلو» بعد كارت صنف بالوزن ⇒ الوزن ده للصنف ده. (٢) «مسببات الحساسية» بعد كارت صنف ⇒ مسببات الصنف ده، واسم صنف بعد الإجابة العامة ⇒ مسبباته.
         (٣) نفس الكارت طلع مرتين ورا بعض على رسايل مكتوبة ⇒ cardRun (decide بيحوّل بدل ما يكرره). */
      let cardRun = null;
      if (ok && !afterWait && !ev.interactiveId && !ev.intent && String(ev.text || "").trim()) {
        const lr = (await q(`SELECT reply_key, reply_arg, msg_type FROM wa_bot_log WHERE phone_norm=$1 AND id <> $2 AND decision IN ('replied','dry') AND at > NOW() - INTERVAL '15 minutes' ORDER BY at DESC, id DESC LIMIT 2`, [phone, logId])) || [];
        const last = lr[0] || null, idOf = (r) => (r && r.reply_key === "item" ? String(r.reply_arg || "") : r && r.reply_key === "weight" ? (/"id":"?(\d+)/.exec(String(r.reply_arg || "")) || [])[1] || null : null);
        const ctxItem = idOf(last) || null;
        const SOFT = new Set(["unknown", "item", "items", "cat", "cats", "notmenu", "order", "ack", "nack", "best"]);
        if (ctxItem && cls.key !== "weight" && SOFT.has(cls.key)) {
          const wo = weightOrder(ev.text, know.menu, ctxItem);
          if (wo && wo.id === ctxItem) cls = wo.ask ? { ...cls, key: "item", arg: wo.id, rawIntent: "weight_not_offered" } : { ...cls, key: "weight", arg: wo, rawIntent: "weight_for_card" };
        }
        if (cls.key === "faq" && cls.arg === "allergens" && ctxItem && !SEVERE_RE.test(normalize(String(ev.text)))) cls = { ...cls, key: "dishfact", arg: { id: ctxItem, text: String(ev.text), list: true }, rawIntent: "allergy_for_card" };
        else if (cls.key === "item" && last && ((last.reply_key === "faq" && last.reply_arg === "allergens") || (last.reply_key === "dishfact" && /"list":true/.test(String(last.reply_arg || ""))))) cls = { ...cls, key: "dishfact", arg: { id: String(cls.arg), text: String(ev.text), list: true }, rawIntent: "allergy_dish_named" };
        if (lr.length === 2 && lr.every((r) => r.msg_type !== "interactive") && lr[0].reply_key === lr[1].reply_key && String(lr[0].reply_arg || "") === String(lr[1].reply_arg || "")) cardRun = { key: lr[0].reply_key, arg: String(lr[0].reply_arg || "") };
      }
      /* EX4: «استمرار / تشغيل / غلطت» من عميل وقّف العروض (أو كل الرسايل) خلال آخر ٢٤ ساعة ⇒ رجوع (نفس «اشتراك»). */
      if (ok && !afterWait && !ev.interactiveId && !ev.intent && cls.key !== "stop" && RESUME_SOFT_RE.test(normalize(String(ev.text || "")).replace(/[؟?!.،,]+/g, " ").replace(/\s+/g, " ").trim())) {
        const so = await q("SELECT stopped_at, marketing_off_at FROM wa_optins WHERE phone_norm=$1", [phone]);
        const offAt = so && so[0] ? Math.max(so[0].marketing_off_at ? new Date(so[0].marketing_off_at).getTime() : 0, so[0].stopped_at ? new Date(so[0].stopped_at).getTime() : 0) : 0;
        if (offAt && now.getTime() - offAt < 24 * 3600_000) cls = { ...cls, key: "start", arg: null, rawIntent: "resume_after_stop" };
      }
      cls = resolveCancel(cls, data);      // M2: «الغاء» لوحدها + طلب شغّال ⇒ إلغاء طلب (موظف عاجل)
      /* «نفس طلبي الأخير»: السلة الجاهزة بتتعمل هنا (الرابط لازم يكون حقيقي قبل ما الرد يتبني). التجربة الصامتة مابتعملش صف. */
      if (cls.key === "reorder" && data.reorder && data.reorder.plan) {
        if (cfg.mode === "dry") data.reorder.url = `${STORE}/c/dryrun00`;
        else { const made = await botCarts.create({ phone, source: "reorder", fromOrder: data.reorder.orderNo, plan: data.reorder.plan, option: data.reorder.option, days: cfg.reorderLinkDays }); data.reorder = made ? { ...data.reorder, url: `${STORE}/c/${made.code}`, code: made.code } : null; }
      }
      /* EX6: سلة جاهزة فيها الصنف بالوزن المطلوب (نفس شكل سطر الوزن بتاع المساعد). التجربة الصامتة مابتعملش صف. فشل ⇒ الرد بيفتح صفحة الصنف. */
      if (cls.key === "weight" && cls.arg && data.menu) {
        const it = data.menu.items.find((i) => i.id === String(cls.arg.id));
        const rows = it && Array.isArray(it.weights) && !it.soldOut ? (cls.arg.parts || []).map(([vid, qty]) => ({ w: it.weights.find((x) => String(x.variant_option_id) === String(vid)), qty: Math.max(1, Math.round(Number(qty) || 1)) })) : [];
        if (rows.length && rows.every((r) => r.w)) {
          if (cfg.mode === "dry") data.weightCart = { url: `${STORE}/c/dryrun00` };
          else {
            const raw = {}, items = [], lines = [];
            for (const r of rows) {
              raw[`${it.id}:v${r.w.variant_option_id}`] = { item: { id: Number(it.id) }, qty: r.qty, variant: { id: r.w.variant_option_id, name: r.w.label_ar, local_name: r.w.label_en, retail_price: r.w.price, ...(r.w.price_ex != null ? { price: r.w.price_ex } : {}) } };
              items.push({ id: it.id, n: `${it.name} (${r.w.label_ar})`.slice(0, 60), q: r.qty, p: r.w.price, v: r.w.variant_option_id });
              lines.push({ name: it.name, nameEn: it.nameEn || it.name, q: r.qty });
            }
            const made = await botCarts.create({ phone, source: "weight", plan: { ok: true, raw, items, lines }, option: null, days: cfg.reorderLinkDays });
            if (made) data.weightCart = { url: `${STORE}/c/${made.code}`, code: made.code };
          }
        }
      }
      /* FD1: رد على حملة «طبقك المفضل» (ضغطة «أبغى أطلب» أو «نعم» أول رد) ⇒ نفس العرض اللي اتبعت **بالحرف** محسوب الحين (سعر + توصيل + FIRST)
         + سلة جاهزة بيه (نفس بنّاء سلة المساعد، مصدرها campaign). أي اختلاف عن الرسالة (السعر اتغيّر، التوصيل، خلص، السلة بسعر تاني) ⇒ الرد العادي
         (مفيش سعر غير اللي اتقال). السلة هنا متجرّبة بس؛ بتتحفظ تحت بعد القرار لو الرد هيطلع فعلاً (مش سكوت/انتظار). الرد بالعربي (سطر العرض عربي).
         للقواعد دايماً (rawIntent campaign_*) عشان الرابط يبقى مضمون. */
      if (cls.key === "order" && data.campaign && data.campaign.fav && cfg.campaignCart && favApi()) {
        let t = null;
        try { t = await favApi().tapOffer(phone, data.campaign.fav, { assist, sent: data.campaign.values }); } catch (e) { console.error("[wabot] campaign cart:", e.message); t = null; }
        data.campaign = t && t.ok ? { ...data.campaign, ...t, url: t.cart ? `${STORE}/c/${cfg.mode === "dry" ? "dryrun00" : CAMP_CART_PENDING}` : null, pending: Boolean(t.cart) && cfg.mode !== "dry" } : null;
        if (!data.campaign && t && t.why) await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `campaign:${String(t.why).slice(0, 60)}`]);
        if (data.campaign) cls = { ...cls, rawIntent: "campaign_order", lang: "ar" };
      } else if (data.campaign) data.campaign = null;
      data.chat = chat;
      /* مساعد الطلبات شغّال للعميل ده (١٢/١٠، بعد تجربة عمر: المساعد ماردّش ولا مرة عشان التحويل والرد المؤجّل كانوا للقواعد):
         • الموظف كتب ⇒ المساعد يتراجع assist.staffStepBackMin (٥ د) بدل humanPauseMin (٣٠ د)، وبعدها يرجع لوحده.
         • تحويل عادي (طلب موظف، سؤال، عرض مخصص، صورة) مابيمسكش المحادثة: المساعد يكمل يرد على اللي يعرفه.
         • تحويل جدّي (شكوى، مشكلة دفع، تعديل طلب مدفوع، حساسية شديدة) بيمسكها assist.seriousHoldMin (١٥ د) بس، مش ٢٤ ساعة. */
      /* M5: مين البوت يرد عليه أصلاً. أرقام التجربة دايماً جوّه. قايمة المالك بتغلب أي حاجة. */
      const gate5 = ok ? await liveGate5({ cfg, settings, phone, chat, ev, now }) : { never: null, out: false };
      /* M5: سيل صور/ملفات من غير نص ⇒ كتم + تحويل واحد (مش ٣٨ رد «ما أقدر أفتح الصور»). */
      if (ok && !afterWait && cls.key === "media" && !gate5.never && !gate5.out && cfg.mediaFloodCount > 0 && (cfg.mode === "live" || (cfg.mode === "test" && cfg.testPhones.includes(phone))) && !(chat.muted_until && Date.parse(chat.muted_until) > now.getTime())) {
const fl = await q(`SELECT count(*)::int AS n FROM wa_bot_log WHERE phone_norm=$1 AND msg_type IN ('image','video','document','audio','voice','sticker') AND at > NOW() - make_interval(mins => $2::int)`, [phone, Math.ceil(cfg.mediaFloodMinutes)]);
        /* PS5 (…٦٨٦٩: خمس صور للي عايز يطلبه ⇒ كتم ٢٤ ساعة وسكوت على كل رسالة بعدها): والمساعد بيشوف الصور، الصور ورا بعض طلب. الكتم بعد mediaFloodBuyerCount بس، ولو مفيش ولا رسالة نصية
           في المدة ومفيش محادثة مساعد شغّالة. ولما يحصل: سطر واحد للعميل + تنبيه عاجل للفريق — مش سكوت. */
        const sees = cfg.assist.imagesEnabled === true && ["test", "live"].includes(cfg.assist.mode) && ev.media && ev.media.kind === "image";
        let buyer = false;
        if (sees && fl && fl[0] && Number(fl[0].n) >= cfg.mediaFloodCount) {
          const tx = await q(`SELECT count(*)::int AS n FROM wa_bot_log WHERE phone_norm=$1 AND msg_type='text' AND at > NOW() - make_interval(mins => $2::int)`, [phone, Math.ceil(cfg.mediaFloodMinutes) + 30]);
          let sess = null; try { sess = assistStore ? await assistStore.loadSession(phone, now, cfg.assist.sessionMin) : null; } catch { sess = null; }
          buyer = Number(fl[0].n) < cfg.mediaFloodBuyerCount || Boolean(tx && tx[0] && Number(tx[0].n) > 0) || Boolean(sess);
        }
        if (fl && fl[0] && Number(fl[0].n) >= cfg.mediaFloodCount && !buyer) {
          await muteChat(phone, cfg.mediaFloodMuteHours, "media_flood");
          const alert = await handoffNow(settings, cfg, phone, ["media_flood", "urgent"], null, null, cls.lang);
          let told = null; try { const L5 = cls.lang === "en" ? "en" : "ar", ph = publicPhoneOf(cfg, settings); told = await sendOwn(phone, cfg, now, { body: `${textOf(cfg, "media_flood_line", L5)}${ph ? `\n${fill("call_line", textOf(cfg, "call_line", L5), { phone: ph })}` : ""}` }, L5, "media_flood_line", null); } catch (e) { told = String(e.message).slice(0, 40); }
          await finish({ decision: "silent", reason: "media_flood", key: "media", handoff: "media_flood", alert, detail: told ? `line not sent: ${told}` : "customer told once", resumeAt: new Date(now.getTime() + cfg.mediaFloodMuteHours * 3600_000).toISOString() });
          await oddThing(settings, cfg, "media_flood", phone, { detail: `${fl[0].n} ملف في ${cfg.mediaFloodMinutes} دقيقة — البوت اتكتم ${cfg.mediaFloodMuteHours} ساعة` });
          return;
        }
      }
      const aud = (cfg.mode === "test" || cfg.mode === "live") && ok ? await assistAudience({ cfg, phone, chat, now, hasReferral: Boolean(ev.referral), count: !afterWait }) : { on: false, why: "bot_mode" };
      const assistOn = aud.on;
      data.assistWhy = aud.why;
      if (!afterWait && aud.why === "daily_cap" && cfg.assist.liveDailyCustomers > 0) await oddThing(settings, cfg, "budget_cap", null, { detail: `سقف عملاء المساعد اليومي (${cfg.assist.liveDailyCustomers}) اتوصل له — الباقي بيرد عليهم بوت القواعد`, repeatMin: 1440 });
      const held = assistOn && seriousHeld(chat, cfg, now);
      data.assistOn = assistOn;
      /* دعوة القناة: مرة لكل عميل كل everyDays (نفس العدّاد للبوت والمساعد)، مش مع تحويل مفتوح ولا محادثة مكتومة ولا لعميل كتب «إيقاف».
         مانعرفش (القاعدة ماردّتش) ⇒ مانعرضش. */
      data.channelOk = false;
      if (channelOn(cfg) && ok && !afterWait && !chat.handoff_at && !(chat.muted_until && Date.parse(chat.muted_until) > now.getTime())
        && !(chat.channel_offered_at && now.getTime() - Date.parse(chat.channel_offered_at) < cfg.links.channel.everyDays * 86400_000)) {
        const so = await q("SELECT stopped_at, marketing_off_at FROM wa_optins WHERE phone_norm=$1", [phone]);
        data.channelOk = so !== null && !(so[0] && (so[0].stopped_at || so[0].marketing_off_at));
      }
      const dctx = { cfg: assistOn ? { ...cfg, humanPauseMin: cfg.assist.staffStepBackMin } : cfg, now, chat: assistOn && !held ? { ...chat, handoff_at: null, handoff_reason: null } : chat,
        lastEchoAt: echoAt, repliesLastHour: rc.n, rate: rc.rate, lastSame: rc.lastSame, sameTextAt: afterWait ? null : rc.sameTextAt, sameTextKey: rc.sameTextKey, failedRecently: rc.failedRecently, data, cls, afterWait, assistOn, cardRun, neverReply: gate5.never, outOfScope: gate5.out };
      let d = decide(ev, dctx);
      /* ═══ MJ1 #٥ — رسالة تحويل واحدة للشكوى (١٦/١٠: سالم ٣ رسايل في دقيقتين، حسام ٣ رسايل في ٤٠ ثانية) ═══
         تحويل شكوى/ملاحظة اتفتح من ثواني (handoverBurstSec) ⇒ الصورة أو النص أو «عندي ملاحظة» اللي بعده = نفس الشكوى: بتوصل للموظف في المحادثة من غير رد تاني ولا تنبيه تاني،
         والمساعد مابيشوفهاش. الحقايق (حالة الطلب / المواعيد / إيقاف) ونجوم التقييم بيتردّ عليهم عادي. */
      if (ok && !afterWait && cfg.handoverBurstSec > 0 && chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoverBurstSec * 1000 && BURST_REASONS.has(String(chat.handoff_reason || ""))
        && !FACTUAL_KEYS.has(cls.key) && !["review_star", "review_reason", "review_ok"].includes(cls.key) && d.act !== "silent") {
        await finish({ decision: "silent", reason: "handover_burst", key: cls.key, detail: `${chat.handoff_reason} ${Math.round((now.getTime() - Date.parse(chat.handoff_at)) / 1000)}s ago — same complaint, staff see it in the chat` });
        return;
      }
      /* ═══ MJ1 — الطلب الشغّال أولاً: موقع / عنوان / صورة / «زوّد-بدون-ملاحظة» من عميل عنده طلب شغّال = ملاحظة على الطلب ده (مش طلب جديد ولا بيع ولا مساعد) ═══ */
      let noteDone = false;
      if (ok && cfg.activeOrderFirst && !afterWait && !ev.autoWaited && !ev.burstSeen && !ev.heard && !gate5.never && !gate5.out
        && (cfg.mode === "live" || cfg.mode === "dry" || (cfg.mode === "test" && cfg.testPhones.includes(phone))) && !(d.act === "silent" && ["outside_window", "stale", "recent_send_failure", "test_mode_not_listed"].includes(d.reason))) {
        const kind = noteKindOf(ev, cls);
        const ao = kind ? await activeOrderOf(phone, cfg) : null;
        if (ao) {
          const nr = await noteOnActiveOrder({ ev, cls, kind, order: ao, cfg, phone, now, d });
          if (nr.silent) { await finish({ decision: "silent", reason: nr.reason, key: "order_note", detail: nr.detail }); return; }
          d = nr.d; noteDone = true;
        }
      }
      /* «يشوف ويسمع» (١٢/١٠): صورة أو رسالة صوتية كانت هتاخد رد «ما أقدر أفتح الصور…» + تحويل. لو المساعد شغّال للرقم ده والمفتاح مفتوح والسقف يسمح:
         - الصوت بيتحوّل لنص، والصورة (منيو/إعلان) لملخص مقنّع ⇒ الرسالة بتتعالج من الأول كأنها نص (ومعاها علامة heard للمساعد).
         - صورة دفع / طلب فيه مشكلة ⇒ تحويل لموظف بنص ثابت + اللي اتفهم في ملاحظة الموظف. صورة موقع ⇒ نطلب الموقع نفسه.
         - أي حاجة تانية أو أي فشل (مقفول، سقف، طويلة، مش واضحة، المزوّد واقع) ⇒ القرار زي ما هو (تحويل لموظف). */
      let mediaDone = false, seenEv = null;
      /* PS5 — كذا صورة ورا بعض: كل صورة بتتسجّل «مستنية» وبتتعمل لها شغلة media_burst؛ آخر شغلة في السلسلة بتشوفهم كلهم وتبعت للمساعد وصف واحد (runMediaBurst ⇒ ev.burstSeen). */
      if (ev.burstSeen) seenEv = { ...ev, text: String(ev.burstSeen), type: "text", media: null, heard: "image" };
      else if (assistOn && !held && !noteDone && !afterWait && !ev.heard && !ev.noBurst && ev.media && ev.media.kind === "image" && ev.type === "image" && cfg.assist.imagesEnabled && cfg.assist.imageBurstSec > 0 && (d.act === "reply" || (d.act === "wait" && d.waitKind === "unknown_wait"))) {
        const due = now.getTime() + cfg.assist.imageBurstSec * 1000;
        const evLite = { phone, phoneNorm: phone, wamid: ev.wamid || null, text: String(ev.text || "").slice(0, 1000), type: "image", interactiveId: null, referral: ev.referral || null, location: null, media: { id: ev.media.id, kind: "image", mime: ev.media.mime || null, caption: ev.media.caption || null }, at: ev.at || now.toISOString(), intent: null };
        const jb2 = await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`mb:${ev.wamid || logId}`, phone, "media_burst", new Date(due).toISOString(), jb(evLite), logId]);
        if (jb2 && jb2.length) { await finish({ decision: "waiting", reason: "media_burst", key: "media", resumeAt: new Date(due).toISOString() }); soon(cfg.assist.imageBurstSec * 1000 + 250); return; }
      }
      /* صورة معاها تعليق: التعليق اتصنّف كنص عادي، بس الصورة لازم تتشاف برضه (الفشل ⇒ الرد على التعليق لوحده زي الأول). */
      if (!seenEv && assistOn && !held && !noteDone && !ev.heard && ev.media && (d.act === "reply" || (d.act === "wait" && d.waitKind === "unknown_wait")) && (d.key === "media" || (ev.media.kind === "image" && ev.type === "image"))) {
        let mu = null;
        try { mu = await understandMedia({ ev, cfg, phone, logId, lang: cls.lang === "en" ? "en" : "ar", data }); } catch (e) { console.error("[assist] media:", e.message); mu = null; }
        if (mu && mu.ev) return work(mu.ev, logId, settings, cfg, afterWait);
        if (mu && mu.seen) seenEv = mu.seen;      // صورة منيو/إعلان: الوصف بيروح للمساعد مباشرة (مش لتصنيف القواعد: ده مش كلام العميل). فشل المساعد ⇒ القرار الأصلي زي ما هو.
        if (mu && mu.d) { d = { ...d, ...mu.d }; mediaDone = true; }
      }
      /* مساعد الطلبات (وضع التجربة، أرقام التجربة بس): لو الرسالة من نصيبه ومفيش مانع، ردّه بيبدّل قرار القواعد. أي فشل (مهلة، سقف، خطأ، رد اترفض
         مرتين) ⇒ ar.d = null ⇒ قرار القواعد زي ما هو. ar.done بيتنادى بعد التنفيذ عشان الجلسة والسجل والمتابعة يتكتبوا **بعد** ما الرسالة تتبعت فعلاً. */
      let ar = null;
      if (assistOn && !mediaDone && !noteDone) { try { ar = await assistTurn({ ev: seenEv || ev, logId, settings, cfg, d, cls: seenEv ? { ...cls, key: "seen", rawIntent: "picture", arg: null, entities: {} } : cls, chat, data, know, now, echoAt, phone, held, allowed: assistOn }); } catch (e) { console.error("[assist] turn:", e.message); ar = null; } }
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
        const shown = textOf(cfg, "stop_updates", d.lang === "en" ? "en" : "ar");      // الزرارين دول بقوا تحت رسالة «أوقفنا تحديثات الطلب أيضاً» (M2)
        try {
          if (d.resume === "updates") await recordWaUpdatesBot(pool, { phoneNorm: phone, value: true, text: `${shown}\n[${textOf(cfg, "btn_resume_updates", d.lang === "en" ? "en" : "ar")}]`, wamid: ev.wamid || null });
          else { if (typeof wa.applyIntent === "function") await wa.applyIntent(phone, "start"); await recordWaMarketingBot(pool, { phoneNorm: phone, value: true, text: `${shown}\n[${textOf(cfg, "btn_resume_all", d.lang === "en" ? "en" : "ar")}]`, wamid: ev.wamid || null }); }
        } catch (e) { console.error("[wabot] resume:", e.message); }
      }
      // «إيقاف/اشتراك» بصياغة أوسع من اللي whatsapp.js بيمسكها ⇒ نطبّقها هنا (حتى لو هنسكت)
      if (d.optout && !ev.intent && !afterWait && typeof wa.applyIntent === "function") { try { await wa.applyIntent(phone, d.optout); } catch (e) { console.error("[wabot] optout:", e.message); } }
      /* EX4: الرجوع من البوت (زر «رجّع العروض» أو صيغة مكتوبة) طلب صريح من العميل ⇒ صف إثبات تسويقي، زي زر «كل الرسائل والعروض». */
      if (d.optout === "start" && !ev.intent && !afterWait && d.act === "reply" && cfg.mode !== "dry") {
        try { await recordWaMarketingBot(pool, { phoneNorm: phone, value: true, text: ev.interactiveId ? `${textOf(cfg, "stop", d.lang === "en" ? "en" : "ar")}\n[${textOf(cfg, "btn_stop_undo", d.lang === "en" ? "en" : "ar")}]` : String(ev.text || "").slice(0, 300), wamid: ev.wamid || null }); } catch (e) { console.error("[wabot] start proof:", e.message); }
      }

      /* FD1: سلة الحملة بتتحفظ (صف wa_bot_carts + كود) بس لما الرد هيطلع بيها فعلاً — مش لسكوت/انتظار/كتم/بره النطاق (مراجعة ١٤/١٠: كانت بتتعمل
         قبل القرار فبتطلع سلات يتيمة، وسلة تانية بعد انتظار الموظف). نفس القرار بيتبني تاني بالرابط الحقيقي؛ الحفظ فشل ⇒ الرد العادي. */
      if (d.act === "reply" && d.link === "wa-campaign" && data.campaign && data.campaign.pending && !(ar && ar.d) && !mediaDone) {
        let sv = null;
        try { sv = await favApi().saveCart(phone, data.campaign, { assist }); } catch (e) { console.error("[wabot] campaign cart save:", e.message); sv = null; }
        if (sv && sv.ok) data.campaign = { ...data.campaign, url: sv.url, code: sv.code, pending: false };
        else { await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `campaign:${String((sv && sv.why) || "cart_save_failed").slice(0, 60)}`]); data.campaign = null; }
        d = decide(ev, dctx);
      }
      if (d.act === "wait") {
        // رد مؤجّل: صف في القاعدة (بيعيش بعد إعادة التشغيل). وقت التنفيذ كل الشروط بتتراجع من جديد.
        /* FD1: تصنيف «رد على الحملة» مابيتحفظش مع الانتظار — الضغطة بتتقرا تاني من زرها وقت التنفيذ، و«نعم» المكتوبة بعد انتظار الموظف بترجع «تمام» عادية */
        const evLite = { phone, phoneNorm: phone, wamid: ev.wamid || null, text: String(ev.text || "").slice(0, 1000), type: ev.type || "text",
          interactiveId: ev.interactiveId || null, referral: ev.referral || null, location: ev.location || null, media: ev.media || null, at: ev.at || now.toISOString(), intent: ev.intent || null,
          ...(ev.contextId ? { contextId: String(ev.contextId).slice(0, 200) } : {}),      // FD1 مراجعة ٣: الضغطة بعد الانتظار بتتقرا على نفس الرسالة
          cls: /^llm:/.test(String(cls.rawIntent || "")) ? { key: cls.key, arg: cls.arg ?? null, rawIntent: cls.rawIntent, score: cls.score } : null };
        const j = await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
          [ev.wamid || null, phone, d.waitKind, d.dueAt, jb(evLite), logId]);
        await finish({ decision: j && j.length ? "waiting" : "silent", reason: j && j.length ? d.reason : "job_not_saved", key: d.key, resumeAt: d.resumeAt });
        await assistDone({ okSent: false });
        return;
      }
      if (d.act === "silent") {
        let alert = null;
        if (d.handoff) alert = await handoffNow(settings, cfg, phone, d.handoff, d.orderNo || data.order?.order_no, d.note || null, d.lang);
        await finish({ decision: "silent", reason: d.reason, detail: d.detail, key: d.key, handoff: d.handoff ? d.handoff[0] : null, alert, resumeAt: d.resumeAt });
        await assistDone({ okSent: false });
        if (!afterWait && !gate5.never) await oddAfter({ d, handoff: d.handoff, okSent: false });
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
        /* الدعوة اتبعتت فعلاً (كل الرسايل وصلت) ⇒ العدّاد + سطر في السجل اليومي. التجربة الصامتة مابتعدّش. */
        if (d.channel && cfg.mode !== "dry" && sent === d.payloads.length) {
          await q(`INSERT INTO wa_bot_chats(phone_norm, channel_offered_at) VALUES ($1, NOW()) ON CONFLICT (phone_norm) DO UPDATE SET channel_offered_at=NOW(), updated_at=NOW()`, [phone]);
          await q("INSERT INTO wa_channel_offers(phone_norm, via) VALUES ($1,$2)", [phone, String(d.channel).slice(0, 20)]);
        }
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
      if (handoff) alert = await handoffNow(settings, cfg, phone, handoff, d.orderNo || data.order?.order_no, d.note || null, d.lang);      // RV1: التقييم الواطي بيحوّل برقم طلبه هو
      await finish({ decision: cfg.mode === "dry" ? "dry" : sent ? "replied" : "failed", reason: d.reason, detail: d.detail, key: d.key, replies: used, sent, error,
        handoff: handoff ? handoff[0] : null, alert, link: d.link });
      await assistDone({ okSent: okSent && cfg.mode !== "dry", error, sentText: used.map((pl) => String((pl && (pl.text?.body || pl.interactive?.body?.text)) || "")).filter(Boolean).join("\n").slice(0, 1500) });
      /* RV1: زر جوجل وصل فعلاً ⇒ «رابط جوجل اتبعت» على الدعوة (التقرير اليومي: اتبعت ↔ اتضغط) */
      if (okSent && cfg.mode !== "dry" && d.key === "review_star" && cls.arg && cls.arg.route === "google") await markGoogleSent(q, cls.arg.code);
      if (!afterWait) await oddAfter({ d, handoff, okSent: okSent && cfg.mode !== "dry" });
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
    return alertStaff(settings, cfg, { phone, reason: handoff[0], orderNo, urgent: handoff[1] === "urgent", stage: "new" });
  }

  /* ═══ MJ1 (١٧/١٠) — الطلب الشغّال أولاً ═══════════════════════════════════════
     الطلب الشغّال للرقم (أحدث طلب مدفوع/في المطبخ/جاهز/مع المندوب خلال activeOrderHours، مش تجربة). */
  const ACTIVE_ORDER_SQL = `/*mj1:active*/ SELECT order_no, status, option, total, created_at, pos_ready_at, to_jsonb(shop_orders)->>'handed_at' AS handed_at FROM shop_orders
    WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status = ANY($2::text[]) AND created_at > NOW() - make_interval(hours => $3::int) ORDER BY created_at DESC LIMIT 1`;
  async function activeOrderOf(phone, cfg) {
    if (!/^5\d{8}$/.test(String(phone || ""))) return null;
    const r = await q(ACTIVE_ORDER_SQL, [phone, [...ACTIVE_ORDER_STATUSES], Math.max(1, Math.ceil(cfg.activeOrderHours))]);
    return r && r[0] ? r[0] : null;
  }
  const courierWaApi = () => { try { return (typeof deps.courierWa === "function" ? deps.courierWa() : deps.courierWa) || null; } catch { return null; } };
  const NOTE_KIND_AR = { location: "موقع", address: "عنوان", photo: "صورة", note: "ملاحظة" };
  function noteTextOf(ev, cls, kind) {
    const text = String(ev.text || "").replace(/^\[[^\]]*\]$/, "").replace(/\s+/g, " ").trim().slice(0, 300);      // «[موقع]» / «[صورة]» = نوع الرسالة مش كلام العميل
    if (kind === "location") { const a = cls.arg || {}; return `📍 موقع من العميل: https://maps.google.com/?q=${Number(a.lat).toFixed(5)},${Number(a.lng).toFixed(5)}${text && !coordsFromText(text) && !shortMapsLink(text) ? ` — «${text}»` : ""}`; }
    if (kind === "photo") return `🖼 صورة من العميل في محادثة واتساب${text ? ` — «${text}»` : ""}`;
    return `${kind === "address" ? "🏠 عنوان" : "📝 ملاحظة"} من العميل: «${text}»`;
  }
  /* الملاحظة بتتسجّل على الطلب (سجل الطلب: customer_note) + كارت على البوابة (نفس كارت التحويل، سبب order_note، من غير فتح تحويل على المحادثة: البوت مابيسكتش بعدها
     ومفيش «نبّهنا الفريق مرة ثانية») + للمندوب الخارجي على واتساب لو الطلب في الطريق وله تشغيلة حيّة (courierwa.noteToCourier). التجربة الصامتة: ولا حاجة بتتكتب.
     ⇒ { d } (رد التأكيد بيبدّل قرار القواعد) أو { silent: true, reason, detail } (اتسجّلت من غير رسالة: موظف في المحادثة / كتم / تأكيد اتبعت من ثواني). */
  async function noteOnActiveOrder({ ev, cls, kind, order, cfg, phone, now, d }) {
    const L = cls.lang === "en" ? "en" : "ar", orderNo = String(order.order_no), text = noteTextOf(ev, cls, kind), onWay = String(order.status) === "on_the_way", dry = cfg.mode === "dry";
    let courier = { sent: false, reason: onWay ? "no_courier_api" : "not_on_the_way" }, portal = "skipped", timeline = "skipped";
    if (!dry) {
      try { emitOrder("customer_note", { orderNo, source: "whatsapp", channel: "wa", ok: true, summary: `${NOTE_KIND_AR[kind]} من العميل على واتساب: ${text}`.slice(0, 280),
        data: { kind, text, via: "wa_bot", wamid: ev.wamid || null, status: String(order.status), ...(kind === "location" && cls.arg ? { lat: cls.arg.lat, lng: cls.arg.lng } : {}), ...(ev.media && ev.media.id ? { media_id: String(ev.media.id) } : {}) } }); timeline = "ok"; }
      catch (e) { console.error("[wabot] order note event:", e.message); timeline = "failed"; }
      if (typeof deps.portalEmit === "function") {
        try { deps.portalEmit("wa_handover", { phone: `0${phone}`, phoneMasked: `…${phone.slice(-4)}`, reason: "order_note", reasonAr: `${REASON_AR.order_note} — ${NOTE_KIND_AR[kind]}`, urgent: false, orderNo, at: now.toISOString(), test: cfg.mode === "test", note: text.slice(0, 200) }); portal = "ok"; }
        catch (e) { console.error("[wabot] portal:", e.message); portal = "failed"; }
      }
      if (onWay) { const cw = courierWaApi(); if (cw && typeof cw.noteToCourier === "function") { try { courier = (await cw.noteToCourier(orderNo, text)) || { sent: false, reason: "no_answer" }; } catch (e) { courier = { sent: false, reason: String(e.message).slice(0, 60) }; } } }
    }
    const detail = `order_note:${kind} ${orderNo} ${order.status} · timeline ${timeline} · portal ${portal} · courier ${courier.sent ? "sent" : courier.reason || "no"}`.slice(0, 200);
    if (d.act !== "reply") return { silent: true, reason: `order_note_${d.act === "wait" ? d.waitKind : d.reason}`.slice(0, 40), detail };      // سكوت القواعد (موظف في المحادثة، كتم…) بيفضل سكوت: اتسجّلت ومفيش كلام فوق إنسان
    if (cfg.activeOrderMergeSec > 0) {      // تأكيد واحد للسلسلة: موقع + عنوان + صورة ورا بعض
      const rc = await q(`/*mj1:recent*/ SELECT 1 FROM wa_bot_log WHERE phone_norm=$1 AND reply_key='order_note' AND decision IN ('replied','dry') AND at > NOW() - make_interval(secs => $2::int) LIMIT 1`, [phone, Math.ceil(cfg.activeOrderMergeSec)]);
      if (rc && rc.length) return { silent: true, reason: "order_note_merged", detail };
    }
    let pl;
    try { const who = textOf(cfg, onWay ? (courier.sent ? "note_who_courier" : "note_who_team") : "note_who_kitchen", L); pl = toPayload({ body: fill("order_note", textOf(cfg, "order_note", L), { order_no: orderNo, who }) }, { cfg, lang: L, interactive: false, footer: false }); }
    catch (e) { return { silent: true, reason: "order_note_text", detail: `${detail} · ${String(e.message).slice(0, 40)}`.slice(0, 200) }; }
    if (payloadProblem(pl)) return { silent: true, reason: "order_note_payload", detail };
    return { d: { act: "reply", reason: "active_order_first", key: "order_note", rawIntent: cls.rawIntent, lang: L, score: cls.score, payloads: [pl], fallback: [pl], handoff: null, detail, greet: false, resume: null, optout: null, link: null, unknown: false, disclose: false, factual: false, optinAsk: null, optinAnswer: null, channel: null, orderNo } };
  }

  /* ── الردود المؤجّلة (قواعد ٢ و٥) ─────────────────────────────────────────
     كل ١٥ ثانية: الصفوف اللي وقتها جه. الحجز بـUPDATE … WHERE status='pending' ⇒ نسخة واحدة بس بتنفّذ، وصف اتحجز
     ووقع السيرفر في نصه بيفضل running وعمره ما يتبعت تاني (الأمان قبل الاكتمال). وقت التنفيذ بنراجع من جديد:
     الوضع (off ⇒ إلغاء)، الموظف رد بعد رسالة العميل (⇒ إلغاء)، التأخير عن الميعاد (⇒ إلغاء)، وبعدها decide كاملة
     (قايمة التجربة، الكتم اليدوي، نافذة الـ٢٤ ساعة، الحدود…). */
  /* EX6 — مسحتين كل دقيقة (جوّه منفّذ الردود المؤجّلة). كل واحدة بتسجّل صف في wa_bot_jobs بمفتاح ثابت (paid:<رقم الطلب> / lead:<الرقم>:<اليوم>) ⇒ مرة واحدة بس، وبيعيش بعد إعادة التشغيل.
     الإرسال نفسه في runPaidNote / runLeadFollowUp وكل الشروط بتتراجع هناك. */
  let sweepAt = -1e15;
  const WINDOW_SQL = `SELECT max(created_at) FILTER (WHERE direction='in' AND COALESCE(source,'api') <> 'history') AS last_in,
                              count(*) FILTER (WHERE direction='in' AND created_at > $2)::int AS wrote, count(*) FILTER (WHERE source='echo' AND created_at > $2 AND COALESCE(echo_kind,'staff') <> 'auto')::int AS staff
                         FROM wa_messages WHERE phone_norm=$1 AND created_at > NOW() - INTERVAL '25 hours'`;
  const riyadhDay = (d) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
  async function sweeps() {
    const now = clock(), t = now.getTime();
    if (t - sweepAt < 60_000 && t >= sweepAt) return; sweepAt = t;
    const settings = (await getSettingsData()) || {}, cfg = botConfig(settings);
    if (cfg.mode !== "live" && cfg.mode !== "test") return;
    if (cfg.paidNoteEnabled) {
      const os = await q(`SELECT o.order_no, o.phone_norm FROM shop_orders o
                           WHERE o.created_at > NOW() - INTERVAL '2 hours' AND NOT COALESCE(o.is_test,false) AND o.status IN ('paid','pos_created','accepted','courier_requested','courier_assigned','on_the_way')
                             AND EXISTS (SELECT 1 FROM wa_bot_log l WHERE l.phone_norm = o.phone_norm AND l.decision = 'replied' AND l.at < o.created_at + INTERVAL '10 minutes' AND l.at > o.created_at - INTERVAL '24 hours')
                             AND NOT EXISTS (SELECT 1 FROM wa_bot_jobs j WHERE j.wamid = 'paid:' || o.order_no)
                           ORDER BY o.created_at LIMIT 10`, []);
      for (const o of os || []) await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`paid:${o.order_no}`, o.phone_norm, "paid_note", now.toISOString(), jb({ orderNo: o.order_no }), null]);
    }
    /* SB4: النوافذ اللي هتقفل قريب (آخر رسالة للعميل من windowKeeperHour لـ٢٣٫٥ ساعة) ⇒ شغلة فحص واحدة لكل نافذة (wk:<الرقم>:<وقت آخر رسالة>). الإرسال والشروط في runWindowKeep. */
    if (cfg.windowKeeper && cfg.windowKeeperDailyCap > 0 && cfg.windowKeeperWeekly > 0) {
      const ws = await q(`SELECT phone_norm, max(created_at) AS last_in FROM wa_messages WHERE direction='in' AND COALESCE(source,'api') <> 'history' AND created_at > NOW() - INTERVAL '24 hours'
                           GROUP BY 1 HAVING max(created_at) <= NOW() - make_interval(hours => $1::int) AND max(created_at) > NOW() - INTERVAL '23 hours 30 minutes' LIMIT 50`, [Math.round(cfg.windowKeeperHour)]);
      for (const w of ws || []) await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`wk:${w.phone_norm}:${Date.parse(w.last_in)}`, w.phone_norm, "window_keep", now.toISOString(), jb({ lastIn: new Date(w.last_in).toISOString() }), null]);
    }
    if (cfg.leadFollowUpMin > 0) {
      const ls = await q(`SELECT l.phone_norm, l.at, l.lang FROM wa_bot_log l
                           WHERE l.at > NOW() - make_interval(mins => $1::int + 60) AND l.at <= NOW() - make_interval(mins => $1::int)
                             AND l.id = (SELECT max(x.id) FROM wa_bot_log x WHERE x.phone_norm = l.phone_norm)
                             AND l.decision = 'silent' AND l.reason IN ('out_of_scope','ignored_type','auto_reply_covered') AND COALESCE(l.msg_type,'') <> 'revoke'
                           ORDER BY l.at LIMIT 20`, [Math.ceil(cfg.leadFollowUpMin)]);
      for (const l of ls || []) await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`lead:${l.phone_norm}:${riyadhDay(now)}`, l.phone_norm, "lead_followup", now.toISOString(), jb({ at: new Date(l.at).toISOString(), lang: l.lang === "en" ? "en" : "ar" }), null]);
    }
    /* SX1 — شبكة الأمان: رقم البوت ساكت عليه بسبب قايمة «موظفين / فريق» — مش عضو في دليل الفريق — كتب ومحدش رد خلال
       phoneLists.staffSilent.afterMin ⇒ تحويل عادي «رقم في قايمة الموظفين كتب ومحدش رد». «الحلقة» = أول رسالة ساكتة بعد آخر رد بشري وبعد آخر تحويل
       للرقم ⇒ شغلة واحدة (ss:<الرقم>:<وقتها>)، وكل الشروط بتتراجع وقت التنفيذ (runStaffSilent). */
    { const ss = phoneListsOf(settings).cfg.staffSilent;
      if (cfg.mode === "live" && ss.enabled && ss.afterMin > 0) {
        const cs = await q(STAFF_SILENT_SQL, [Math.ceil(ss.afterMin), [...STAFF_SILENT_WHY]]);
        for (const c of cs || []) {
          const fa = new Date(c.first_at);
          if (!Number.isFinite(fa.getTime())) continue;
          await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`ss:${c.phone_norm}:${fa.getTime()}`, c.phone_norm, "staff_silent", now.toISOString(), jb({ firstAt: fa.toISOString() }), null]);
        }
      }
    }
    /* FU1 — «متابعة اللي ردّ وماطلبش»: الفرامل الأول (نسبة «إيقاف» / حظر في متابعات اليوم)، وبعدها المرشّحين — جوّه الساعات المسموحة بس: بره الساعات مفيش شغلة،
       وأول دقيقة جوّاها بتلقط اللي سكتوا بالليل طول ما نافذتهم مفتوحة. شغلة واحدة لكل نافذة (rf:<الرقم>:<وقت آخر رسالة ليه>)، وكل الشروط بتتراجع في runReplyFollowUp. */
    if (cfg.replyFollowUp && cfg.replyFollowUpDailyCap > 0) {
      let br = null; try { br = await brakeTick(settings, cfg, now); } catch (e) { console.error("[wabot] followup brake:", e.message); br = null; }
      if (br && !br.on && inFollowHours(now, cfg)) {
        const cs = await q(FU_SQL.candidates, [Math.ceil(cfg.replyFollowUpMin), 24 * 60 - 10, Math.ceil(cfg.replyFollowUpCampaignHours), [...FU_TAP_KEYS], Math.ceil(cfg.replyFollowUpTapHours), cfg.mode === "test" ? cfg.testPhones : null, 30]);
        for (const c of cs || []) {
          const li = new Date(c.last_in);
          if (!Number.isFinite(li.getTime())) continue;
          await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`rf:${c.phone_norm}:${li.getTime()}`, c.phone_norm, FU_KIND, now.toISOString(), jb({ lastIn: li.toISOString() }), null]);
        }
      }
    }
  }
  /* رسالة من البوت من غير رسالة عميل وراها: إرسال + صف في السجل (زي متابعة السلة). ⇒ خطأ الإرسال أو null */
  /* FU1: نفس الإرسال بس بيرجّع رقم الرسالة كمان (wamid) — دفتر المتابعة محتاجه عشان يعرف لو الرسالة فشلت بعدين (حظر / ماوصلتش) للفرامل */
  async function sendOwnX(phone, cfg, now, rep, lang, key, detail) {
    let pl, plain;
    try { pl = toPayload(rep, { cfg, lang, interactive: cfg.interactive, footer: false }); plain = toPayload(rep, { cfg, lang, interactive: false, footer: false }); } catch { return { err: "text_invalid", wamid: null }; }
    if (payloadProblem(pl) || payloadProblem(plain)) return { err: "payload_invalid", wamid: null };
    const allow = cfg.mode === "test" ? cfg.testPhones : null;
    const proactive = PROACTIVE_KEYS.has(String(key || ""));      // CJ1a: الرسالة المبادِرة بتستنى الهدوء بعد آخر رسالة للعميل (guardSend burst_hold) — سطر التحويل وسطر السيل مش منها
    let r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: allow, proactive });
    if (!r.ok && !r.skipped && pl.type === "interactive") { pl = plain; r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: allow, proactive }); }
    const err = r.ok ? null : (r.skipped ? `skipped:${r.skipped}` : String(r.error || "send_failed"));
    /* CJ1a: الهدوء مش فشل — مفيش صف «failed» في السجل؛ المنادي بيأجّل (until) ويتسجّل لما يتبعت فعلاً */
    if (r.skipped === "burst_hold") return { err, wamid: null, until: r.until || null };
    const lg = await q(
      `INSERT INTO wa_bot_log(wamid, msg_at, phone_norm, mode, msg_type, text, intent, reply_key, score, lang, decision, referral)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [null, now.toISOString(), phone, cfg.mode, "followup", "", key, key, 0, lang, false]);
    if (lg && lg[0]) await finishLog(lg[0].id, { decision: r.ok ? "replied" : "failed", reason: key, key, replies: r.ok ? [pl] : null, sent: r.ok ? 1 : 0, error: err, detail });
    return { err, wamid: r.ok ? r.wamid || null : null };
  }
  async function sendOwn(phone, cfg, now, rep, lang, key, detail) { return (await sendOwnX(phone, cfg, now, rep, lang, key, detail)).err; }
  /* شروط مشتركة للرسالتين: الوضع، رقم التجربة، «مش عميل»، نافذة الـ٢٤ ساعة، الإيقاف، الكتم. ⇒ سبب المنع أو null (+ m = صف النافذة). */
  /* ST2: سطر ثابت واحد للعميل من حركة الفريق (حوّل للمدير). نفس أقفال رسايل البوت: الوضع، أرقام التجربة، نافذة الـ٢٤ ساعة، «إيقاف». المحادثة المكتومة مش مانع هنا
     (التحويل نفسه هو اللي كاتمها). ⇒ "sent" أو سبب المنع. */
  async function sendFlowLine(rawPhone, key) {
    if (key !== "transfer_note") return "bad_key";
    const phone = normPh(rawPhone); if (!/^5\d{8}$/.test(phone)) return "bad_phone";
    const settings = (await getSettingsData()) || {}, cfg = botConfig(settings), now = clock();
    if (cfg.mode !== "test" && cfg.mode !== "live") return "mode_off";
    if (cfg.mode === "test" && !cfg.testPhones.includes(phone)) return "not_test_phone";
    const m = await q(WINDOW_SQL, [phone, now.toISOString()]);
    if (m === null || !m[0]) return "window_check_failed";
    if (!m[0].last_in || now.getTime() - new Date(m[0].last_in).getTime() > (24 * 60 - 10) * 60_000) return "window_closed";
    const op = await q("SELECT stopped_at FROM wa_optins WHERE phone_norm=$1", [phone]);
    if (op === null) return "optout_check_failed"; if (op[0] && op[0].stopped_at) return "stopped";
    const lg = await q("SELECT lang FROM wa_bot_log WHERE phone_norm=$1 AND lang IS NOT NULL ORDER BY id DESC LIMIT 1", [phone]);
    const lang = lg && lg[0] && lg[0].lang === "en" ? "en" : "ar";
    let rep; try { rep = { body: textOf(cfg, key, lang) }; } catch { return "text_invalid"; }
    const err = await sendOwn(phone, cfg, now, rep, lang, key, null);
    return err ? `failed:${err}`.slice(0, 80) : "sent";
  }
  /* ── SB2 — طلب التقييم بعد التوصيل على واتساب (reviews.js بيناديها بدل الـSMS) ─────────────────
     جوّه النافذة ⇒ رسالة حرة بزرّين (تمام / عندي ملاحظة)؛ بره النافذة ⇒ القالب المعتمد fc_review_request (زرار رابط التقييم). أي سبب منع ⇒ { ok:false, skipped }
     وreviews.js يبعت SMS — إلا final:true (العميل وقّف): مفيش أي رسالة. ⇒ { ok, channel?, skipped?, final? }. عمرها ما بترمي. */
  /* RV1 (عمر ١٥/١٠): kind = نوع الطلب (delivery/pickup/table = موقع، dinein/takeaway/app = كاشير)، ref = الرقم اللي العميل يعرفه.
     المسار الجديد (waBot.reviewFlow.enabled): جوّه النافذة ⇒ قايمة نجوم (channel wa_list). بره النافذة ⇒ قالب النجوم fc_review_stars لو اتفتح بعد اعتماده
     (wa_stars)، وإلا القالب المعتمد القديم لطلبات الموقع بس؛ طلب الكاشير من غير قالب نجوم ⇒ { skipped: "no_visit_template" } (reviews.js يقرر SMS ولا لأ). */
  async function reviewAsk({ phone: raw, orderNo, code, kind = null, ref = null }) {
    try {
      const phone = normPh(raw); if (!/^5\d{8}$/.test(phone)) return { ok: false, skipped: "bad_phone" };
      if (!/^[a-z0-9]{4,16}$/i.test(String(code || "")) || !orderNo) return { ok: false, skipped: "bad_invite" };
      const settings = (await getSettingsData()) || {}, cfg = botConfig(settings), now = clock();
      if (!cfg.reviewWhatsApp) return { ok: false, skipped: "off" };
      if (cfg.mode !== "live" && !(cfg.mode === "test" && cfg.testPhones.includes(phone))) return { ok: false, skipped: "bot_not_live" };      // الرد على الزرّين محتاج البوت شغّال للرقم ده
      const op = await q("SELECT stopped_at FROM wa_optins WHERE phone_norm=$1", [phone]);
      if (op === null) return { ok: false, skipped: "optout_check_failed" };
      if (op[0] && op[0].stopped_at) return { ok: false, skipped: "stopped", final: true };
      if (await neverReplyOf(phone)) return { ok: false, skipped: "never_reply" };
      const lg = await q("SELECT lang FROM wa_bot_log WHERE phone_norm=$1 AND lang IS NOT NULL ORDER BY id DESC LIMIT 1", [phone]);
      const lang = lg && lg[0] && lg[0].lang === "en" ? "en" : "ar";
      const m = await q(WINDOW_SQL, [phone, now.toISOString()]);
      const open = Boolean(m && m[0] && m[0].last_in && now.getTime() - new Date(m[0].last_in).getTime() <= (24 * 60 - 10) * 60_000);
      const flow = cfg.reviewFlow, k = WEB_KINDS.has(kind) || VISIT_KINDS.has(kind) ? kind : "delivery", web = WEB_KINDS.has(k);
      const shown = /^W\d{6,20}$/.test(String(ref || "")) ? String(ref) : /^W\d{6,20}$/.test(String(orderNo)) ? String(orderNo) : null;
      const T = (kk) => textOf(cfg, kk, lang), F = (kk, v) => fill(kk, textOf(cfg, kk, lang), v);
      const mark = async (stars = false) => {
        await q(`INSERT INTO wa_bot_chats(phone_norm, review_code, review_order, review_asked_at, review_answered_at) VALUES ($1,$2,$3,NOW(),NULL)
                 ON CONFLICT (phone_norm) DO UPDATE SET review_code=$2, review_order=$3, review_asked_at=NOW(), review_answered_at=NULL, updated_at=NOW()`, [phone, String(code), String(orderNo).slice(0, 30)]);
        await q("UPDATE wa_bot_chats SET review_stars_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END WHERE phone_norm=$1", [phone, Boolean(stars)]);      // RV1: سؤال نجوم ولا سؤال «تمام / ملاحظة» (نفس ساعة القاعدة)
      };
      if (open) {
        let rep; try {
          rep = flow.enabled ? starsAskReply({ T, F, kind: k, orderNo: shown, code })
            : { body: fill("rv_ask", textOf(cfg, "rv_ask", lang), { order_no: orderNo }), buttons: [{ id: `rv:ok:${code}`, title: textOf(cfg, "btn_rv_ok", lang) }, { id: `rv:note:${code}:${String(orderNo).slice(0, 30)}`, title: textOf(cfg, "btn_rv_note", lang) }] };
        } catch { rep = null; }
        if (rep) { const sx = await sendOwnX(phone, cfg, now, rep, lang, flow.enabled ? "review_stars_ask" : "review_ask", `order ${orderNo}`), err = sx.err; if (!err) { await mark(flow.enabled); return { ok: true, channel: flow.enabled ? "wa_list" : "wa" }; } if (/opted_out|stopped/.test(err)) return { ok: false, skipped: err, final: true };
          if (/burst_hold/.test(err)) return { ok: false, skipped: "burst_hold", defer: true, until: sx.until || new Date(now.getTime() + 5 * 60_000).toISOString() }; }      // CJ1a: العميل لسه واصلته رسالة ⇒ reviews.js بيأجّل due_at
      }
      /* ١٤/١٠ — النافذة مقفولة ⇒ سياسة القوالب (wapolicy.reviewDecision): التوصيل اتبعت بزرّين «تمام / عندي ملاحظة» (v2 أو حر) ⇒ ده نفس سؤال التقييم، مفيش قالب تاني
         (الدعوة بتتعلّم اتبعتت، و«تمام» المكتوبة بتتحسب رد). قالب بفلوس لنفس الطلب من أقل من reviewPaidGapMin ⇒ تأجيل (reviews.js بيأخّر due_at). القاعدة ماردّتش ⇒ زي الأول.
         RV1: طلبات الموقع بس (طلب الكاشير مالوش رسايل طلب على واتساب). */
      /* RV1: قالب النجوم (بعد اعتماد ميتا والمالك يفتحه): كل الأنواع. فشل حقيقي (مش منع) ⇒ القالب القديم لطلب الموقع. */
      const starsTpl = async () => {
        let subj = null; try { subj = starsSubject({ T, F, kind: k, orderNo: shown }); } catch { subj = null; }
        if (!subj) return null;
        const r = await wa.sendTemplate({ phoneNorm: phone, template: "fc_review_stars", params: { body: [subj] }, orderNo: String(orderNo), stage: "review", source: "review", allowList: cfg.mode === "test" ? cfg.testPhones : null });
        if (r && r.ok) { await mark(true); return { ok: true, channel: "wa_stars", wamid: r.wamid || null }; }
        if (r && r.skipped === "opted_out") return { ok: false, skipped: "opted_out", final: true };
        if (r && r.skipped === "burst_hold") return { ok: false, skipped: "burst_hold", defer: true, until: r.until || new Date(now.getTime() + 5 * 60_000).toISOString() };      // CJ1a
        if (r && r.skipped) return { ok: false, skipped: String(r.skipped).slice(0, 60) };
        return null;
      };
      if (!web) {
        if (flow.enabled && flow.starsTemplate) { const s = await starsTpl(); if (s) return s; }
        return { ok: false, skipped: "no_visit_template" };
      }
      if (cfg.closedPolicy) {
        const sent = await q(`SELECT template, source, stage, created_at AS at FROM wa_messages WHERE order_no=$1 AND direction='out' AND COALESCE(status,'') NOT IN ('failed','skipped') ORDER BY created_at DESC LIMIT 20`, [String(orderNo)]);
        if (sent !== null) {
          const dec = reviewDecision({ sent, cfg, now: now.getTime() });
          if (dec.reason === "merged_delivered") { await mark(); await q("INSERT INTO wa_policy_skips(order_no, phone_norm, stage, reason) VALUES ($1,$2,'review','review_merged')", [String(orderNo).slice(0, 30), phone]); return { ok: true, channel: "wa_merged" }; }
          if (dec.defer) return { ok: false, skipped: "paid_gap", defer: true, until: dec.until };
        }
      }
      if (flow.enabled && flow.starsTemplate) { const s = await starsTpl(); if (s) return s; }
      const r = await wa.sendTemplate({ phoneNorm: phone, template: cfg.windowV2Stages.includes("review") ? "fc_review_request_v2" : "fc_review_request", params: { body: [String(orderNo)], button: [String(code)] }, orderNo: String(orderNo), stage: "review", source: "review", allowList: cfg.mode === "test" ? cfg.testPhones : null });
      if (r && r.ok) { await mark(); return { ok: true, channel: "wa_template" }; }
      if (r && r.skipped === "opted_out") return { ok: false, skipped: "opted_out", final: true };
      if (r && r.skipped === "burst_hold") return { ok: false, skipped: "burst_hold", defer: true, until: r.until || new Date(now.getTime() + 5 * 60_000).toISOString() };      // CJ1a
      return { ok: false, skipped: String((r && (r.skipped || r.error)) || "template_failed").slice(0, 60) };
    } catch (e) { return { ok: false, skipped: `error:${String(e.message || e).slice(0, 40)}` }; }
  }
  async function ownGate(phone, settings, cfg, now, since) {
    if (cfg.mode !== "test" && cfg.mode !== "live") return ["mode_off"];
    if (cfg.mode === "test" && !cfg.testPhones.includes(phone)) return ["not_test_phone"];
    if (await neverReplyOf(phone)) return ["never_reply"];
    const m = await q(WINDOW_SQL, [phone, since]);
    if (m === null || !m[0]) return ["window_check_failed"];
    if (!m[0].last_in || now.getTime() - new Date(m[0].last_in).getTime() > (24 * 60 - 10) * 60_000) return ["window_closed"];
    const op = await q("SELECT stopped_at, marketing_off_at FROM wa_optins WHERE phone_norm=$1", [phone]);
    if (op === null) return ["optout_check_failed"]; if (op[0] && op[0].stopped_at) return ["stopped"];
    const chat = await chatOf(phone);
    if (chat.muted_until && Date.parse(chat.muted_until) > now.getTime()) return ["muted"];
    return [null, m[0], chat, op[0] || {}];
  }
  /* ── SB4 — رسالة واحدة قبل ما النافذة تقفل، بس لو مفيدة للعميل ده ─────────────────────────────────────────
     الترتيب: طلبه شغّال (زر التتبع) ⇒ مكافأة بتنتهي خلال ٣ أيام (ومش موقِّف العروض) ⇒ سلة من المحادثة ماكمّلهاش (زر السلة). مفيش سبب ⇒ ولا حاجة (nothing_useful).
     مايتبعتش: الوضع / التجربة / «مش عميل» / النافذة قفلت / «إيقاف» / مكتوم (ownGate) · ساعات الهدوء · اتبعتله رسالة من غير ما يطلب في نفس النافذة · سقف اليوم / الأسبوع ·
     تحويل مفتوح أو شكوى النهارده. كل شغلة بتتقفل بسببها (done sent:<السبب> أو cancelled <السبب>) والتقرير اليومي بيعدّ: اتبعت كام، رد كام، طلب كام. */
  async function runWindowKeep(j, settings, cfg, now, end) {
    const phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (!cfg.windowKeeper) return no("off"); if (!ev.lastIn) return no("bad_job");
    /* SB5 (١٦/١٠): +١ مللي ثانية زي FU1 — lastIn في الشغلة متقطّع للمللي (Postgres بالميكرو)، فرسالته الأخيرة نفسها (12:00:00.123456 > 12:00:00.123) كانت بتتعدّ «كتب تاني»
       وكل شغلة تقريباً بتتلغي customer_wrote. فحص «اتبعتله رسالة في النافذة دي» (done_at > lastIn) فاضل على lastIn زي ما هو: التقطيع هناك بيغلط ناحية «مانبعتش». */
    const lastInMs = Date.parse(ev.lastIn);
    if (!Number.isFinite(lastInMs)) return no("bad_job");
    const [why, m, chat, op] = await ownGate(phone, settings, cfg, now, new Date(lastInMs + 1).toISOString());
    if (why) return no(why);
    if (Number(m.wrote) > 0) return no("customer_wrote");
    const hr = new Date(now.getTime() + 3 * 3600_000).getUTCHours(), qs = Math.round(cfg.windowKeeperQuietStart), qe = Math.round(cfg.windowKeeperQuietEnd);
    if (qs !== qe && (qs < qe ? hr >= qs && hr < qe : hr >= qs || hr < qe)) return no("quiet_hours");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return no("handover_open");
    /* SB5: window_sell_at جاية من pg كـDate، و Date.parse(Date) بيعدّي على toString فبيقطّع للثانية (سطر بيع في نفس ثانية رسالته كان بيتشاف «قبلها» ⇒ رسالة تانية في نفس النافذة).
       getTime() بالمللي، و >= : نفس المللي يتحسب «اتبعت» — يغلط ناحية «مانبعتش» زي done_at تحت. */
    if (chat.window_sell_at && new Date(chat.window_sell_at).getTime() >= lastInMs) return no("window_used");
    const used = await q(`SELECT 1 FROM wa_bot_jobs WHERE phone_norm=$1 AND kind IN ('assist_followup','assist_nudge','lead_followup','window_keep','assist_reminder','${FU_KIND}') AND status='done' AND done_at > $2 LIMIT 1`, [phone, ev.lastIn]);      // FU1: + متابعة اللي ردّ
    if (used === null) return no("used_check_failed"); if (used.length) return no("window_used");
    const caps = await q(`SELECT count(*) FILTER (WHERE done_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'))::int AS today,
                                 count(*) FILTER (WHERE phone_norm=$1 AND done_at > NOW() - INTERVAL '7 days')::int AS week
                            FROM wa_bot_jobs WHERE kind='window_keep' AND status='done' AND done_at > NOW() - INTERVAL '7 days'`, [phone]);
    if (caps === null || !caps[0]) return no("cap_check_failed");
    if (Number(caps[0].today) >= cfg.windowKeeperDailyCap) return no("daily_cap"); if (Number(caps[0].week) >= cfg.windowKeeperWeekly) return no("weekly_cap");
    const cmp = await q(COMPLAINT_24H_SQL, [phone]);
    if (cmp === null) return no("complaint_check_failed"); if (cmp.length) return no("complaint_today");
    const lg = await q("SELECT lang FROM wa_bot_log WHERE phone_norm=$1 AND lang IS NOT NULL ORDER BY id DESC LIMIT 1", [phone]);
    const lang = lg && lg[0] && lg[0].lang === "en" ? "en" : "ar";
    let rep = null, reason = null;
    const ord = await q(`SELECT order_no FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status IN ('pos_created','accepted','courier_requested','courier_assigned','on_the_way') AND created_at > NOW() - INTERVAL '12 hours' ORDER BY created_at DESC LIMIT 1`, [phone]);
    if (ord && ord[0]) { reason = "open_order"; rep = { body: fill("wk_order", textOf(cfg, "wk_order", lang), { order_no: ord[0].order_no }), cta: { title: textOf(cfg, "cta_track", lang), url: `${STORE}/track/${encodeURIComponent(ord[0].order_no)}` } }; }
    /* FU1: «لا شكراً» على متابعة خلال replyFollowUpDeclineDays ⇒ مفيش رسايل بيع (مكافأة / سلة) — تتبّع طلبه الشغّال بس */
    const declinedFu = Boolean(chat.follow_declined_at && now.getTime() - Date.parse(chat.follow_declined_at) < cfg.replyFollowUpDeclineDays * 86400_000);
    if (!rep && declinedFu) return no("declined");
    if (!rep && assist && !op.marketing_off_at) { try { const of = await assist.get_offers(phone), soon = ((of && of.rewards) || []).find((r) => r.freeDelivery && r.expires && Date.parse(`${r.expires}T23:59:59+03:00`) - now.getTime() < 3 * 86400_000);
      if (soon) { const line = salesTextOf(cfg, "sb_reward_until", { code: soon.code, from: soon.minTotal, until: dayMonth(soon.expires) }, lang); if (line) { reason = "reward_expiring"; rep = { body: line }; } } } catch { /* من غير المكافأة */ } }
    if (!rep) { const cart = await q(`SELECT b.code FROM wa_bot_carts b WHERE b.phone_norm=$1 AND b.created_at > $2::timestamptz - INTERVAL '2 hours' AND b.expires_at > NOW()
                                        AND NOT EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm=b.phone_norm AND o.created_at > b.created_at AND o.status <> 'expired') ORDER BY b.created_at DESC LIMIT 1`, [phone, ev.lastIn]);
      if (cart && cart[0]) { reason = "open_cart"; rep = { body: textOf(cfg, "wk_cart", lang), cta: { title: textOf(cfg, "cta_reorder", lang), url: `${STORE}/c/${cart[0].code}` } }; } }
    if (!rep) return no("nothing_useful");
    const err = await sendOwn(phone, cfg, now, rep, lang, "window_keep", reason);
    return end(err ? "cancelled" : "done", err ? `send_failed:${err}`.slice(0, 80) : `sent:${reason}`);
  }
  async function runPaidNote(j, settings, cfg, now, end) {
    const phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (!cfg.paidNoteEnabled) return no("off"); if (!ev.orderNo) return no("bad_job");
    const [why] = await ownGate(phone, settings, cfg, now, now.toISOString());
    if (why) return no(why);
    /* CJ1a (٢): قالب الاستلام (fc_order_received / _v2 أو رسالة pos_created الحرة) طلع لنفس الطلب خلال paidNoteDedupeMin ⇒ «وصلنا طلبك» تأكيد تاني — مايتبعتش (٨ من ٢٢ يوم ١٦/١٠) */
    if (cfg.journeyBursts && cfg.paidNoteDedupeMin > 0) {
      const dup = await q(PAID_CONFIRM_SQL, [String(ev.orderNo), Math.round(cfg.paidNoteDedupeMin)]);
      if (dup === null) return no("confirm_check_failed");
      if (dup.length) return no("already_confirmed");
    }
    const lang = "ar";
    let rep; try { rep = { body: fill("paid_note", textOf(cfg, "paid_note", lang), { order_no: ev.orderNo }), cta: { title: textOf(cfg, "cta_track", lang), url: `${STORE}/track/${encodeURIComponent(ev.orderNo)}` } }; } catch { return no("text_invalid"); }
    const err = await sendOwn(phone, cfg, now, rep, lang, "paid_note", `order ${ev.orderNo}`);
    return end(err ? "cancelled" : "done", err ? `send_failed:${err}`.slice(0, 80) : null);
  }
  async function runLeadFollowUp(j, settings, cfg, now, end) {
    const phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (!(cfg.leadFollowUpMin > 0)) return no("off"); if (!ev.at) return no("bad_job");
    const [why, m, chat, op] = await ownGate(phone, settings, cfg, now, ev.at);
    if (why) return no(why);
    if (Number(m.wrote) > 0) return no("customer_wrote"); if (Number(m.staff) > 0) return no("staff_in_chat");
    if (op.marketing_off_at) return no("stopped");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return no("handover_open");
    if (chat.follow_declined_at && now.getTime() - Date.parse(chat.follow_declined_at) < cfg.replyFollowUpDeclineDays * 86400_000) return no("declined");      // FU1: «لا شكراً» = مفيش متابعات
    const g5 = await liveGate5({ cfg, settings, phone, chat, ev: {}, now });
    if (g5.never || g5.out) return no(g5.never ? "never_reply" : "out_of_scope");
    const out = await q(OUT_AFTER_SQL, [phone, ev.at]);
    if (out === null) return no("out_check_failed"); if (out.length) return no("already_answered");      // حد رد عليه (اللوحة / البوت) بعد رسالته
    const cmp = await q(COMPLAINT_24H_SQL, [phone]);
    if (cmp === null) return no("complaint_check_failed"); if (cmp.length) return no("complaint_today");
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    if (!open || open.open !== true) return no("closed");
    const lang = ev.lang === "en" ? "en" : "ar";
    let rep; try { rep = { body: fill("lead_followup", textOf(cfg, "lead_followup", lang), { who: disclosureLine(cfg, lang, settings) }), buttons: [{ id: "bot:menu", title: textOf(cfg, "btn_menu", lang) }, { id: "bot:human", title: textOf(cfg, "btn_human", lang) }] }; } catch { return no("text_invalid"); }
    const err = await sendOwn(phone, cfg, now, rep, lang, "lead_followup", null);
    if (!err) await q("UPDATE wa_bot_chats SET last_disclosed_at=NOW() WHERE phone_norm=$1", [phone]);
    return end(err ? "cancelled" : "done", err ? `send_failed:${err}`.slice(0, 80) : null);
  }

  /* ══ FU1 (١٥/١٠) — «متابعة اللي ردّ وماطلبش» (wafollow.js) ═══════════════════════════════════════════════
     الفرامل: صف واحد (wa_followup_brake). مشدودة = اتشدّت ومااتفكّتش بعدها. ⇒ { on, at, … } أو null (القاعدة ماردّتش ⇒ المتابعة مابتتبعتش). */
  async function brakeState() {
    const r = await q(FU_SQL.brakeGet, []);
    if (r === null) return null;
    const x = r[0] || null;
    const on = Boolean(x && x.on_at && !(x.cleared_at && Date.parse(x.cleared_at) >= Date.parse(x.on_at)));
    return { on, at: x && x.on_at ? isoOf(x.on_at) : null, clearedAt: x && x.cleared_at ? isoOf(x.cleared_at) : null, clearedBy: (x && x.cleared_by) || null,
      sent: x ? Number(x.sent) || 0 : 0, bad: x ? Number(x.bad) || 0 : 0, pct: x ? Number(x.pct) || 0 : 0, detail: (x && x.detail) || null };
  }
  /* كل دقيقة (sweeps): متابعات يوم الشغل (من آخر فكّ للفرامل لو بعد بدايته) — «إيقاف» بعد المتابعة أو رسالتها فشلت فوق الحد ⇒ تتشدّ مرة واحدة،
     الشغلات المستنية تتلغي، ويتبعت تنبيه للمالك. مابتتفكّش لوحدها: المالك بيفكّها من اللوحة (POST /api/cms/wabot/followups/brake). */
  async function brakeTick(settings, cfg, now) {
    const st = await brakeState();
    if (!st || st.on) return st;
    const from = Math.max(bizDayStart(now).getTime(), st.clearedAt ? Date.parse(st.clearedAt) : 0);
    const r = await q(FU_SQL.dayStats, [new Date(from).toISOString()]);
    if (!r || !r[0]) return st;
    const x = r[0], v = brakeVerdict({ sent: x.sent, bad: x.bad }, cfg.replyFollowUpBrakePct);
    if (!v.trip) return st;
    const detail = `${Number(x.bad) || 0} من ${Number(x.sent) || 0} متابعة النهارده (${Number(x.stopped) || 0} إيقاف، ${Number(x.blocked) || 0} ماوصلتش) = ${v.pct}٪، والحد ${cfg.replyFollowUpBrakePct}٪`;
    const set = await q(FU_SQL.brakeSet, [Number(x.sent) || 0, Number(x.bad) || 0, v.pct, detail]);
    if (!set || !set.length) return { ...st, on: true };      // اتشدّت من نسخة تانية قبلنا ⇒ التنبيه بتاعها
    await q(FU_SQL.cancelPending, ["braked"]);
    try { await brakeAlert(settings, cfg, detail); } catch (e) { console.error("[wabot] brake alert:", e.message); }
    return { ...st, on: true, detail };
  }
  /* التنبيه: «حاجة غريبة» للمدير والملاك (wateam)، ولو مااتبعتتش من هناك ⇒ SMS واحد لأرقام التنبيه — في وضع العملاء (أو التجربة مع alertInTest) بس */
  async function brakeAlert(settings, cfg, detail) {
    const res = await oddThing(settings, cfg, "followup_brake", null, { detail: `متابعات الردود وقفت لوحدها: ${detail}. فكّ الفرامل من إعدادات البوت بعد ما تراجع.`, repeatMin: 60 });
    if (["sent", "queued", "quiet", "held", "repeat"].includes(res)) return res;
    if (!(cfg.mode === "live" || (cfg.mode === "test" && cfg.alertInTest)) || !sendSms) return res || "off";
    const sc = staffConfig(settings);
    const phones = cfg.llm.alertPhones.length ? cfg.llm.alertPhones : cfg.alertPhones.length ? cfg.alertPhones : sc.alertPhones;
    const body = fitOneSms(sc.lang === "ar" ? "فريش كاتس: متابعات واتساب وقفت لوحدها (إيقاف/حظر فوق الحد). فكّها من اللوحة." : "Fresh Cuts WhatsApp: reply follow-ups paused automatically (too many stops/blocks today). Clear the brake in the dashboard.");
    let sent = 0;
    for (const p of phones) { try { const r = await sendSms({ phoneNorm: p, body, kind: "staff", ref: "wabot followup_brake" }); if (!(r && r.suppressed)) sent++; } catch (e) { console.error("[wabot] brake sms:", e.message); } }
    return sent ? "sms" : "failed";
  }
  /* المحتوى بالترتيب (wafollow.js): عرض الحملة المخزّن بنفس سعره وتوصيله ⇒ سلة اتعملت في المحادثة ⇒ اللي شافه ⇒ طبقه المفضل ⇒ سطر محايد.
     كل سعر من النظام الحين (العرض = tapOffer بالحرف، الصنف/البوكس = المنيو والبوكسات بالكاش المحدّث بس، والسلة لازم تطلع بنفس السعر وإلا مفيش).
     ⇒ { via, ref, lang, rep: { body, buttons }, cart_code?, cart_total? } */
  async function followContent({ phone, cfg, settings, now, tg, conv, lastIn, name }) {
    const L = conv.lang === "en" ? "en" : "ar";
    const hiOf = (LL) => { if (!name) return ""; try { return fill("rf_hi", textOf(cfg, "rf_hi", LL), { name }).trim(); } catch { return ""; } };
    const make = (key, LL, vars, extra) => ({ ...extra, lang: LL, rep: { body: fill(key, textOf(cfg, key, LL), { hi: hiOf(LL), ...vars }), buttons: [{ id: "rf:yes", title: textOf(cfg, "btn_rf_yes", LL) }, { id: "rf:no", title: textOf(cfg, "btn_rf_no", LL) }] } });
    const neutral = (ref) => make("rf_neutral", L, {}, { via: "neutral", ref: ref || null });
    const CART_URL = /^https:\/\/freshcuts\.sa\/c\/[a-z0-9]{6,16}$/;
    const linksOn = async (slugs) => { const r = await q("SELECT slug FROM cms_links WHERE slug = ANY($1::text[]) AND active", [[...new Set(slugs.filter(Boolean))]]); return new Set((r || []).map((x) => x.slug)); };
    const liveCart = async () => { const r = await q(FU_SQL.cartLive, [phone, tg.at]); return r && r[0] ? String(r[0].code) : null; };
    /* سلة بسعر معروف: معاينة الأول (من غير صف) ولو السعر نفس اللي هيتقال بيتحفظ — مفيش سلات يتيمة ولا سلة بسعر غير اللي في الرسالة */
    const cartFor = async (input, price, what) => {
      if (!assist) return null;
      try {
        const pre = await assist.build_cart(phone, input, { save: false, source: "followup" });
        if (!pre || !pre.ok || Math.abs((Number(pre.subtotal) || 0) - Number(price)) >= 0.01) return null;
        const made = await assist.build_cart(phone, input, { save: true, source: "followup" });
        return made && made.ok && CART_URL.test(String(made.link || "")) && Math.abs((Number(made.subtotal) || 0) - Number(price)) < 0.01 ? made : null;
      } catch (e) { console.error(`[wabot] followup ${what} cart:`, e.message); return null; }
    };
    /* ١) عرض الحملة: آخر رسالة حملة للرقم ده «طبقك المفضل» (FD1) وردّه جه بعدها ⇒ نفس العرض بالحرف محسوب الحين + سلة جاهزة بنفس السعر. اتغيّر أي حاجة ⇒ سطر من غير أرقام. */
    if (cfg.replyFollowUpOffer && tg.trigger === "campaign" && favApi()) {
      let camp = null; try { camp = await favApi().lastOffer(phone, cfg.campaignOfferHours); } catch (e) { console.error("[wabot] followup offer:", e.message); camp = null; }
      if (camp && camp.fav && Date.parse(camp.sentAt) <= Date.parse(lastIn)) {
        let t = null; try { t = await favApi().tapOffer(phone, camp.fav, { assist, sent: camp.values }); } catch (e) { console.error("[wabot] followup offer check:", e.message); t = null; }
        const phrase = t && t.ok ? offerPhrase(t) : null;
        const ref = String(camp.fav.slug || camp.fav.pid || "").slice(0, 60);
        if (phrase && t.cart) {
          let sv = null; try { sv = await favApi().saveCart(phone, t, { assist, source: "followup" }); } catch (e) { console.error("[wabot] followup offer cart:", e.message); sv = null; }
          if (sv && sv.ok && CART_URL.test(String(sv.url || ""))) return make("rf_offer", "ar", { offer: phrase, link: sv.url }, { via: "offer", ref, cart_code: sv.code || String(sv.url).split("/").pop(), cart_total: t.price });
        } else if (phrase && t.boxSlug) {
          const on = await linksOn([t.boxSlug, cfg.links.organic]);
          const slug = on.has(t.boxSlug) ? t.boxSlug : on.has(cfg.links.organic) ? cfg.links.organic : null;
          if (slug) return make("rf_offer_box", "ar", { offer: phrase, link: `${STORE}/l/${slug}` }, { via: "offer_box", ref: t.boxSlug });
        }
        const why = `offer_changed:${String((t && t.why) || (t && t.ok ? "cart_not_saved" : "failed")).slice(0, 40)}`;
        const code = await liveCart();
        return code ? make("rf_cart", L, { link: `${STORE}/c/${code}` }, { via: "cart", ref: why, cart_code: code }) : neutral(why);
      }
    }
    /* ٢) سلة جاهزة اتعملت في المحادثة (المساعد / الوزن / نفس الطلب / الحملة) ولسه صالحة ⇒ نفس الرابط، من غير أرقام */
    { const code = await liveCart(); if (code) return make("rf_cart", L, { link: `${STORE}/c/${code}` }, { via: "cart", ref: null, cart_code: code }); }
    /* ٣) اللي شافه: أحدث صنف / بوكس / قسم البوت عرضه في المحادثة ولسه متاح */
    if (cfg.replyFollowUpLooked) {
      const menu = await menuIndex(settings, now, true), bl = await bundles(true);
      const lk = menu ? pickLooked(conv.looked, { menu, bundles: bl }) : null;
      if (lk) {
        const on = await linksOn([lk.kind === "box" ? lk.slug : null, "wab-menu", cfg.links.organic]);
        const fallback = on.has(cfg.links.organic) ? cfg.links.organic : null;
        const nm = L === "en" ? lk.nameEn : lk.name;
        if (lk.kind === "item" && !lk.byWeight) {
          const made = await cartFor({ option: "delivery", items: [{ id: lk.id, qty: 1 }] }, lk.price, "item");
          if (made) return make("rf_item", L, { dish: nm, price: money(lk.price), link: made.link }, { via: "item", ref: lk.id, cart_code: made.code, cart_total: lk.price });
        } else if (lk.kind === "item" && lk.byWeight) {
          const slug = on.has("wab-menu") ? "wab-menu" : fallback;
          if (slug) return make("rf_item_page", L, { dish: nm, link: `${STORE}/l/${slug}#item-${lk.id}` }, { via: "item_page", ref: lk.id });
        } else if (lk.kind === "box") {
          const slug = on.has(lk.slug) ? lk.slug : fallback;
          if (slug) return make(lk.from ? "rf_box_from" : "rf_box", L, { box: nm, price: money(lk.price), link: `${STORE}/l/${slug}` }, { via: "box", ref: lk.slug });
        } else if (lk.kind === "section") {
          const slug = on.has("wab-menu") ? "wab-menu" : fallback;
          if (slug) return make("rf_section", L, { section: nm, link: `${STORE}/l/${slug}` }, { via: "section", ref: lk.id });
        }
      }
    }
    /* ٤) طبقه المفضل (نفس ترتيب الحملة) في سلة جاهزة بسعره الحين */
    if (cfg.replyFollowUpFav && favApi() && assist && typeof favApi().favDishFor === "function") {
      let fd = null; try { fd = await favApi().favDishFor(phone); } catch (e) { console.error("[wabot] followup fav:", e.message); fd = null; }
      if (fd && fd.ok) {
        const made = await cartFor(fd.input, fd.price, "fav");
        if (made) return make("rf_fav", L, { dish: fd.name, price: money(fd.price), link: made.link }, { via: "fav", ref: String(fd.spec.pid), cart_code: made.code, cart_total: Number(fd.price) });
      }
    }
    return neutral(null);
  }
  /* الشغلة نفسها: كل الشروط بتتراجع وقت التنفيذ (أي فحص مانعرفش نتيجته ⇒ مانبعتش). الحاجات المؤقتة (لسه في وقت السكوت، بره الساعات المسموحة، المطعم مقفول،
     سقف اليوم، متابعة تانية مستنية ميعادها) ⇒ الشغلة بتستنى (due_at جديد) طول ما النافذة هتفضل مفتوحة، وإلا بتتلغي. */
  async function runReplyFollowUp(j, settings, cfg, now, end) {
    const phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (!cfg.replyFollowUp || !(cfg.replyFollowUpDailyCap > 0)) return no("off");
    const lastInMs = Date.parse(ev.lastIn || "");
    if (!Number.isFinite(lastInMs)) return no("bad_job");
    const windowEnd = lastInMs + (24 * 60 - 10) * 60_000;
    const later = async (atMs, reason) => {
      if (!(atMs < windowEnd)) return no(`window_would_close:${reason}`);
      await q(FU_SQL.defer, [j.id, new Date(Math.max(atMs, now.getTime() + 1000)).toISOString(), `wait:${reason}`]);
      return "deferred";
    };
    const br = await brakeState();
    if (br === null) return no("brake_check_failed"); if (br.on) return no("braked");
    /* +١ مللي ثانية: الوقت المخزّن في الشغلة متقطّع للمللي (Postgres بالميكرو) — من غيرها رسالته الأخيرة نفسها كانت هتتعدّ «كتب تاني» */
    const [why, m, chat, op] = await ownGate(phone, settings, cfg, now, new Date(lastInMs + 1).toISOString());
    if (why) return no(why);
    if (Number(m.wrote) > 0) return no("customer_wrote");
    if (Number(m.staff) > 0) return no("staff_in_chat");
    if (op.marketing_off_at) return no("stopped");
    const oo = await q(FU_SQL.optedOut, [phone]);
    if (oo === null) return no("optout_check_failed"); if (oo.length) return no("opted_out");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return no("handover_open");
    if (chat.follow_declined_at && now.getTime() - Date.parse(chat.follow_declined_at) < cfg.replyFollowUpDeclineDays * 86400_000) return no("declined");
    const g5 = await liveGate5({ cfg, settings, phone, chat, ev: {}, now });
    if (g5.never || g5.out) return no(g5.never ? "never_reply" : "out_of_scope");
    const lo = await q(FU_SQL.lastOut, [phone, ev.lastIn]);
    if (lo === null || !lo[0]) return no("out_check_failed");
    if (!lo[0].at) return no("not_answered");      // البوت سكت على رسالته ⇒ دي متابعة EX6 (leadFollowUpMin) مش دي
    if (Number(lo[0].mkt) > 0) return no("campaign_after");
    const quietFrom = Date.parse(isoOf(lo[0].at)) + cfg.replyFollowUpMin * 60_000;
    if (quietFrom > now.getTime()) return later(quietFrom, "silence");
    const tr = await q(FU_SQL.trigger, [phone, ev.lastIn, Math.ceil(cfg.replyFollowUpCampaignHours), [...FU_TAP_KEYS], Math.ceil(cfg.replyFollowUpTapHours)]);
    if (tr === null) return no("trigger_check_failed");
    const tg = followTrigger({ campAt: tr[0] ? tr[0].camp_at : null, tapAt: tr[0] ? tr[0].tap_at : null });
    if (!tg) return no("no_trigger");
    /* موظف كلّمه في أي وقت من الزناد: صدى الموبايل / الرد من اللوحة (lastEcho — إلا لو الموظف ساب المحادثة للبوت بعدها، SR2)، أو رد من الصندوق/البورتال القديم (source api) */
    { let ea = await lastEcho(phone); if (ea && chat.released_at && Date.parse(ea) <= Date.parse(chat.released_at)) ea = null;
      if (ea && Date.parse(ea) > Date.parse(tg.at)) return no("staff_in_chat");
      const mn = await q(FU_SQL.manual, [phone, tg.at]); if (mn === null || !mn[0]) return no("staff_check_failed"); if (Number(mn[0].n) > 0) return no("staff_in_chat"); }
    const cv = await q(FU_SQL.conv, [phone, tg.at]);
    if (cv === null) return no("conv_check_failed");
    const conv = convFacts(cv);
    if (conv.lastKey && FU_CLOSING_KEYS.includes(conv.lastKey)) return no(`closing:${conv.lastKey}`);
    if (conv.saidNo) return no("said_no");
    const cmp = await q(COMPLAINT_24H_SQL, [phone]);
    if (cmp === null) return no("complaint_check_failed"); if (cmp.length) return no("complaint_today");
    const ord = await q(FU_SQL.ordered, [phone, new Date(Math.min(Date.parse(tg.at), now.getTime() - 24 * 3600_000)).toISOString()]);
    if (ord === null) return no("order_check_failed"); if (ord.length) return no("ordered");
    const rc = await q(FU_SQL.recent, [phone, ev.lastIn, [...FU_OTHER_JOBS]]);
    if (rc === null || !rc[0]) return no("recent_check_failed");
    if (Number(rc[0].mine) > 0 || Number(rc[0].others) > 0) return no("window_used");
    if (Number(rc[0].pending) > 0) return later(now.getTime() + 5 * 60_000, "other_followup_pending");
    const ig = await q(FU_SQL.ignored, [phone, [...FU_PROACTIVE_KEYS], Math.ceil(cfg.replyFollowUpIgnoredDays)]);
    if (ig === null || !ig[0]) return no("ignored_check_failed");
    if (Number(ig[0].n) >= cfg.replyFollowUpIgnoredMax) return no("ignored");
    if (!inFollowHours(now, cfg)) return later(nextFollowStart(now, cfg).getTime(), "quiet_hours");
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    if (!open) return no("hours_unknown");
    if (open.open !== true) { const nx = now.getTime() + 15 * 60_000; return later(inFollowHours(new Date(nx), cfg) ? nx : nextFollowStart(now, cfg).getTime(), "closed"); }
    const dc = await q(FU_SQL.dayCount, [bizDayStart(now).toISOString()]);
    if (dc === null || !dc[0]) return no("cap_check_failed");
    if (Number(dc[0].n) >= cfg.replyFollowUpDailyCap) return later(nextFollowStart(now, cfg).getTime(), "daily_cap");
    const nmRow = ((await q(`SELECT customer->>'name' AS name FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment') ORDER BY created_at DESC LIMIT 1`, [phone])) || [])[0];
    let pick = null;
    try { pick = await followContent({ phone, cfg, settings, now, tg, conv, lastIn: ev.lastIn, name: greetName(nmRow && nmRow.name) }); } catch (e) { console.error("[wabot] followup content:", e.message); pick = null; }
    if (!pick) { try { pick = { via: "neutral", ref: "content_failed", lang: conv.lang, rep: { body: fill("rf_neutral", textOf(cfg, "rf_neutral", conv.lang), {}), buttons: [{ id: "rf:yes", title: textOf(cfg, "btn_rf_yes", conv.lang) }, { id: "rf:no", title: textOf(cfg, "btn_rf_no", conv.lang) }] } }; } catch { return no("text_invalid"); } }
    let rep = pick.rep, disclosed = false;
    /* رسالة بنبدأها إحنا: لو التعريف مستحق (مااتقالش في آخر disclosureHours) بيتقال فوقها */
    if (!chat.last_disclosed_at || now.getTime() - Date.parse(chat.last_disclosed_at) >= cfg.disclosureHours * 3600_000) { try { rep = { ...rep, body: `${disclosureLine(cfg, pick.lang, settings)}\n${rep.body}` }; disclosed = true; } catch { /* من غير التعريف */ } }
    /* الحجز قبل الإرسال: صف واحد للنافذة — مستحيل متابعتين لنفس النافذة */
    const rs = await q(FU_SQL.reserve, [String(j.wamid || `rf:${phone}:${lastInMs}`), phone, tg.trigger, tg.at, ev.lastIn, pick.via, pick.ref ? String(pick.ref).slice(0, 80) : null, pick.lang, pick.cart_code || null, pick.cart_total ?? null]);
    if (rs === null) return no("reserve_failed"); if (!rs.length) return no("already_reserved");
    const sx = await sendOwnX(phone, cfg, now, rep, pick.lang, FU_KIND, `${pick.via}${pick.ref ? `:${String(pick.ref).slice(0, 60)}` : ""}`);
    await q(FU_SQL.mark, [rs[0].id, sx.err ? "failed" : "sent", sx.wamid || null, sx.err ? String(sx.err).slice(0, 120) : null]);
    if (sx.err) return end("cancelled", `send_failed:${sx.err}`.slice(0, 80));
    if (disclosed) await q("UPDATE wa_bot_chats SET last_disclosed_at=NOW() WHERE phone_norm=$1", [phone]);
    /* المساعد لو له جلسة شغّالة مع العميل: الرسالة بتتلحق بيها عشان ردّه المكتوب يتفهم (زي متابعة المساعد نفسه) */
    if (assistStore && cfg.assist) { try { const s0 = await assistStore.loadSession(phone, now, cfg.assist.sessionMin); if (s0) { const s1 = JSON.parse(JSON.stringify(s0)); s1.messages.push({ role: "assistant", content: [{ type: "text", text: rep.body }] }); s1.state.say = [...(s1.state.say || []), rep.body].slice(-20); await assistStore.saveSession(phone, s1, now); } } catch (e) { console.error("[assist] followup session:", e.message); } }
    return end("done", `sent:${pick.via}`);
  }
  /* ── SX1: شبكة أمان قايمة الموظفين ───────────────────────────────────────────────────────────────
     رد بشري = صدى موظف (مش الصدى الآلي) أو رسالة حرة طلعت من الصندوق/البورتال (مش البوت ولا قالب). */
  const STAFF_SILENT_WHY = ["staff_list"];      // قايمة «موظفين / فريق» بس — «مستني قرار المالك» البوت بيرد عليه أصلاً
  const HUMAN_OUT = `m.direction = 'out' AND COALESCE(m.status,'') NOT IN ('failed','skipped') AND ((m.source = 'echo' AND COALESCE(m.echo_kind,'staff') <> 'auto') OR (m.template IS NULL AND COALESCE(m.source,'api') NOT IN ('bot','window','echo')))`;
  /* $1 الدقايق · $2 أسباب السكوت. أول رسالة ساكتة بعد آخر رد بشري وبعد آخر تحويل، عدّى عليها $1 دقيقة (ولسه جوّه ساعة بعدها) */
  const STAFF_SILENT_SQL = `/*ss:candidates*/ SELECT l.phone_norm, min(l.at) AS first_at FROM wa_bot_log l
     WHERE l.decision = 'silent' AND l.reason = 'never_reply' AND l.detail = ANY($2::text[]) AND COALESCE(l.msg_type,'') NOT IN ('revoke','reaction')
       AND l.at > NOW() - make_interval(mins => $1::int + 60)
       AND l.at > COALESCE((SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = l.phone_norm AND ${HUMAN_OUT}), '-infinity'::timestamptz)
       AND l.at > COALESCE((SELECT max(h.at) FROM wa_handovers h WHERE h.phone_norm = l.phone_norm), '-infinity'::timestamptz)
     GROUP BY l.phone_norm HAVING min(l.at) <= NOW() - make_interval(mins => $1::int) LIMIT 20`;
  async function runStaffSilent(j, settings, cfg, now, end) {
    const phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    const ss = phoneListsOf(settings).cfg.staffSilent;
    if (!ss.enabled) return no("off"); if (!ev.firstAt) return no("bad_job");
    if (cfg.mode !== "live") return no("mode_not_live");
    if (now.getTime() - Date.parse(ev.firstAt) > (ss.afterMin + 120) * 60_000) return no("stale");
    if (teamStaff(settings, phone)) return no("team_member");      // عضو في دليل الفريق ⇒ رسايله للفريق نفسه (wateam) مش لعميل
    const why = await neverReplyOf(phone);
    if (!STAFF_SILENT_WHY.includes(why)) return no(why ? `never:${why}` : "not_listed_anymore");      // اتنقل / اتشال من القايمة ⇒ البوت بيرد عليه عادي
    const hu = await q(`SELECT 1 FROM wa_messages m WHERE m.phone_norm = $1 AND m.created_at > $2 AND ${HUMAN_OUT} LIMIT 1`, [phone, ev.firstAt]);
    if (hu === null) return no("reply_check_failed"); if (hu.length) return no("staff_answered");
    const ho = await q("SELECT 1 FROM wa_handovers WHERE phone_norm = $1 AND at >= $2 LIMIT 1", [phone, ev.firstAt]);
    if (ho && ho.length) return no("handover_exists");
    const lt = await q(`SELECT text FROM wa_bot_log WHERE phone_norm = $1 AND at >= $2 AND decision = 'silent' ORDER BY at DESC, id DESC LIMIT 1`, [phone, ev.firstAt]);
    const where = phoneListOf(settings, phone);
    const note = `البوت مابيردش على الرقم ده — في قايمة «موظفين / فريق»${where.entry ? ` (السبب: ${phoneReasonAr(where.entry.reason)}${where.entry.name ? ` · ${where.entry.name}` : ""})` : ""}. رد عليه إنت، ولو عميل انقله من اللوحة ← الفريق والتنبيهات ← قوايم الأرقام.${lt && lt[0] && lt[0].text ? ` آخر رسالة: «${String(lt[0].text).slice(0, 60)}»` : ""}`;
    const alert = await handoffNow(settings, cfg, phone, ["staff_silent", "normal"], null, note.slice(0, 200), "ar");
    return end("done", `handover:${alert || "?"}`.slice(0, 80));
  }
  async function runDueJobs() {
    await ready;
    try { await sweeps(); } catch (e) { console.error("[wabot] sweeps:", e.message); }
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
        /* CJ1a (١٧/١٠): الشغلة المبادِرة والعميل لسه واصلته رسالة من أقل من burstHoldMin (من أي نظام) ⇒ ترجع pending لحد ما الهدوء يخلص («ندمج بدل ما نكدّس»)،
           وشروطها كلها بتتراجع وقتها زي ما هي. لو فضلت مستنية أكتر من burstHoldMaxMin من أول تأجيل ⇒ بتتلغي (العميل بيتكلّم معانا طول الوقت = مش محتاجها). */
        if (PROACTIVE_JOB_KINDS.includes(j.kind)) {
          const until = await holdUntil(q, { phone: String(j.phone_norm || ""), cfg: settings.waBot, now: now.getTime() });
          if (until) {
            const dd = deferDecision({ until, firstHold: ev.holdSince || null, now: now.getTime(), maxMin: cfg.burstHoldMaxMin });
            if (dd.expired) { await end("cancelled", "burst_hold_expired"); continue; }
            await q(`UPDATE wa_bot_jobs SET status='pending', due_at=$2, reason='burst_hold', ev=$3 WHERE id=$1`,
              [j.id, dd.until.toISOString(), jb({ ...ev, holdSince: dd.firstHold.toISOString(), holds: (Number(ev.holds) || 0) + 1 })]);
            continue;
          }
        }
        if (j.kind === "assist_followup") { await runFollowUp(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "paid_note") { await runPaidNote(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "window_keep") { await runWindowKeep(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "lead_followup") { await runLeadFollowUp(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === FU_KIND) { await runReplyFollowUp(j, settings, cfg, now, end); ran++; continue; }      // FU1
        if (j.kind === "assist_nudge") { await runNudge(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "assist_reminder") { await runReminder(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "media_burst") { await runMediaBurst(j, ev, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "handover_check") { await runHandoverCheck(j, settings, cfg, now, end); ran++; continue; }
        if (j.kind === "staff_silent") { await runStaffSilent(j, settings, cfg, now, end); ran++; continue; }      // SX1
        if (now.getTime() - new Date(j.due_at).getTime() > cfg.maxAgeMinutes * 60_000) { await cancel("stale"); continue; }
        const echo = await q(`SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > $2 AND ${STAFF_ECHO_SQL} LIMIT 1`, [j.phone_norm, ev.at || new Date(j.due_at).toISOString()]);
        if (echo === null) { await cancel("echo_check_failed"); continue; }      // مانعرفش الموظف رد ولا لأ ⇒ مانردّش
        if (echo.length) { await cancel("staff_answered"); continue; }
        if (j.kind === "auto_wait") {      // M1: استنينا الرد الآلي بتاع التطبيق. جه ⇒ مانردّش فوقه. ماجاش ⇒ الرسالة تتعالج عادي من الأول (ev.autoWaited بيمنع انتظار تاني).
          const cov = await autoEchoAfter(j.phone_norm, ev.at || new Date(j.due_at).toISOString());
          if (cov === true && cfg.autoEchoSkipCovered) { await cancel("auto_reply_covered"); continue; }
          await work({ ...ev, autoWaited: true }, j.log_id, settings, cfg, null);
          await end("done", null); ran++; continue;
        }
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
    const echo = await q(`SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > $2 AND ${STAFF_ECHO_SQL} LIMIT 1`, [phone, ev.hoAt]);
    if (echo === null) return no("echo_check_failed"); if (echo.length) return no("staff_answered");
    /* MJ1 مراجعة: كارت «ملاحظة على طلب شغّال» (order_note) صف في wa_handovers من غير تحويل — مايتحسبش «آخر تحويل» وإلا شكوى اتقفلت بـ«تم» تتعامل كمفتوحة */
    const ack = await q(`SELECT acked_at FROM wa_handovers WHERE phone_norm=$1 AND at >= $2 AND COALESCE(reason,'') <> 'order_note' ORDER BY at DESC LIMIT 1`, [phone, ev.hoAt]);      // «تم» في البوابة = حد مسكها
    /* «تم» في البورتال من غير أي رد للعميل (مراجعة الخبير): كانت بتلغي التنبيه التاني **و** رسالة العميل، فالعميل يفضل من غير رد خالص. دلوقتي: التنبيه التاني بيتلغي
       (الكارت اتقفل)، بس لو ميعاد رسالة العميل جه ولسه محدش رد عليه ⇒ كارت جديد على البورتال + التنبيه، والعميل ياخد رسالته. */
    const acked = Boolean(ack && ack[0] && ack[0].acked_at);
    if (acked && !cfg.handoverAckNeedsReply) return no("staff_acked");
    /* SX1: تحويل «رقم في قايمة الموظفين» (staff_silent) — البوت ساكت على الرقم ده، فمفيش مرحلة «رسالة للعميل» خالص: ولا بتتجدول، ولا الكارت بيرجع يتفتح
       («تم» من غير رد هنا العادي — الرقم غالباً بتاع زميل) ⇒ التنبيه التاني للفريق بس، ولو حد ضغط «تم» قبله يتلغي. */
    if (ev.stage !== "realert" && ev.reason === "staff_silent") return no("staff_list_no_note");
    const assistOn = (await assistAudience({ cfg, phone, chat, now, hasReferral: false, count: false })).on;
    if (ev.stage === "realert" && acked) { if (cfg.handoverCustomerNoteMin > 0 && ev.reason !== "staff_silent") await scheduleHandoverCheck(phone, { ...ev, stage: "note" }, cfg); return end("done", "realert:skipped_acked"); }
    if (ev.stage !== "realert" && acked) {
      if (typeof deps.portalEmit === "function") { try { deps.portalEmit("wa_handover", { phone: `0${phone}`, phoneMasked: `…${phone.slice(-4)}`, reason: ev.reason, reasonAr: REASON_AR[ev.reason] || ev.reason, urgent: ev.urgent === true, orderNo: ev.orderNo || null, at: now.toISOString(), test: cfg.mode === "test", reopened: true }); } catch (e) { console.error("[wabot] portal:", e.message); } }
      if (cfg.mode === "live" || cfg.alertInTest) await alertStaff(settings, cfg, { phone, reason: ev.reason, orderNo: ev.orderNo, urgent: ev.urgent === true, stage: "reopened" });
    }
    if (ev.stage === "realert") {
      const waited = Math.round((now.getTime() - Date.parse(ev.hoAt)) / 60_000);
      if (typeof deps.portalEmit === "function") { try { deps.portalEmit("wa_handover", { phone: `0${phone}`, phoneMasked: `…${phone.slice(-4)}`, reason: ev.reason, reasonAr: REASON_AR[ev.reason] || ev.reason, urgent: ev.urgent === true, orderNo: ev.orderNo || null,
        at: ev.hoAt, test: cfg.mode === "test", reminder: true, waitedMin: waited }); } catch (e) { console.error("[wabot] portal:", e.message); } }
      let alert = "would";
      if (cfg.mode === "live" || cfg.alertInTest) alert = await alertStaff(settings, cfg, { phone, reason: ev.reason, orderNo: ev.orderNo, urgent: ev.urgent === true, stage: "reminder", waitedMin: waited });
      if (cfg.handoverCustomerNoteMin > 0 && ev.reason !== "staff_silent") await scheduleHandoverCheck(phone, { ...ev, stage: "note" }, cfg);
      return end("done", `realert:${alert}`);
    }
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    if (!open || open.open !== true) return no("closed");
    const m = await q(`SELECT max(created_at) FILTER (WHERE direction='in' AND COALESCE(source,'api') <> 'history') AS last_in,
                              count(*) FILTER (WHERE direction='in' AND created_at > $2)::int AS wrote, count(*) FILTER (WHERE source='echo' AND created_at > $2 AND COALESCE(echo_kind,'staff') <> 'auto')::int AS staff
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
  /* ── «يشوف ويسمع» ─────────────────────────────────────────────────────────
     ⇒ { ev } (الرسالة بقت نص: تتعالج من الأول) أو { d } (حقول قرار جاهزة: رد ثابت ± تحويل) أو null (القرار الأصلي: «ما أقدر أفتح…» + تحويل).
     مصروف الصور والصوت بيتسجّل على غرض المساعد نفسه (فبيتحسب في سقفه اليومي) ومتعلّم بـ‎detail = media:…‎ عشان سطر السقف الخاص بيه. */
  const MEDIA_DAY = `(date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')`;
  const mediaSpentToday = async () => { const r = await q(`SELECT COALESCE(sum(cost_sar),0)::float AS s FROM ai_calls WHERE purpose='assistant' AND detail LIKE 'media:%' AND at >= ${MEDIA_DAY}`, []); return r === null ? null : Number(r[0] && r[0].s) || 0; };
  /* سطر الصور والصوت في كارت سقف المساعد: مصروف النهارده وحدّه، وعدد ومصروف كل نوع. */
  async function mediaStats(cfg) {
    const r = await q(`SELECT CASE WHEN detail LIKE 'media:stt%' THEN 'voice' ELSE 'images' END AS kind, count(*)::int AS n, count(*) FILTER (WHERE outcome='ok')::int AS ok, COALESCE(sum(cost_sar),0)::float AS sar
                         FROM ai_calls WHERE purpose='assistant' AND detail LIKE 'media:%' AND at >= ${MEDIA_DAY} GROUP BY 1`, []);
    const a = cfg.assist, out = { imagesEnabled: a.imagesEnabled, voiceEnabled: a.voiceEnabled, budgetDaySar: a.mediaBudgetDaySar, daySar: 0, voice: { n: 0, ok: 0, sar: 0 }, images: { n: 0, ok: 0, sar: 0 }, known: r !== null };
    for (const x of r || []) { out[x.kind] = { n: x.n, ok: x.ok, sar: Math.round(x.sar * 1e4) / 1e4 }; out.daySar += x.sar; }
    out.daySar = Math.round(out.daySar * 1e4) / 1e4;
    return out;
  }
  async function understandMedia({ ev, cfg, phone, logId, lang, data }) {
    const acfg = cfg.assist, m = ev.media || {};
    const kind = m.kind === "image" ? "image" : m.kind === "audio" ? "voice" : null;
    if (!kind || !m.id) return null;
    if (kind === "image" ? !acfg.imagesEnabled : !acfg.voiceEnabled) return null;
    const why = async (t) => { await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `media off: ${t}`.slice(0, 200)]); return null; };
    const spent = await mediaSpentToday();
    if (spent === null) return why("cost_db_down");
    if (!(acfg.mediaBudgetDaySar > 0) || spent >= acfg.mediaBudgetDaySar) return why("media_budget_day");
    const stop = await aicost.gate({ purpose: "assistant", budget: { budgetMonthSar: acfg.budgetMonthSar, budgetDaySar: acfg.budgetDaySar }, alert: false });
    if (stop) return why(stop);
    /* الصوت: المفتاح لازم يكون متجرّب وناجح للمزوّد والموديل الحاليين (نفس شرط فتح المفتاح من اللوحة) — قبل ما أي ملف يتجاب. */
    if (kind === "voice" && !deps.transcribe) { const ce = await stt.canEnable(acfg); if (!ce.ok) return why(`stt_${ce.reason}`); }
    if (typeof wa.fetchMedia !== "function") return why("no_fetch");
    let f = null; try { f = await wa.fetchMedia(String(m.id), { maxBytes: kind === "image" ? IMAGE_MAX_BYTES : VOICE_MAX_BYTES }); } catch (e) { f = null; }
    if (!f || !f.ok || !f.buf) return why(`fetch_${(f && f.error) || "failed"}`);
    const mime = f.mime || m.mime || "";
    if (kind === "voice") {
      const dur = voiceSeconds(f.buf);
      if (dur.sec > acfg.voiceMaxSec) return why(`voice_too_long_${Math.round(dur.sec)}s`);
      const r = deps.transcribe ? await transcribe({ buf: f.buf, mime, model: acfg.sttModel, timeoutMs: acfg.timeoutMs }) : await stt.transcribe({ acfg, buf: f.buf, mime, timeoutMs: acfg.timeoutMs });
      const cost = r && r.ok ? Math.round((Math.max(1, dur.sec) / 60) * acfg.sttSarPerMin * 1e6) / 1e6 : 0;
      await q(`INSERT INTO ai_calls(purpose, provider, model, in_tokens, out_tokens, cached_tokens, estimated, cost_sar, priced, price_date, ms, chat_hash, outcome, detail, sent_text, prompt_chars, prompt_hash, log_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        ["assistant", (r && r.provider) || null, String(acfg.sttModel).slice(0, 60), 0, 0, 0, !dur.exact, cost, true, null, Math.round(Number(r && r.ms) || 0), null, r && r.ok ? "ok" : String((r && r.reason) || "error").slice(0, 40), `media:stt ${Math.round(dur.sec)}s`, null, null, null, logId]);
      if (!r || !r.ok) return why(`stt_${(r && r.reason) || "error"}`);
      if (!transcriptUsable(r.text)) return why("stt_unclear");
      await q("UPDATE wa_bot_log SET text=$2 WHERE id=$1", [logId, `🎤 ${maskText(r.text)}`.slice(0, 500)]);
      return { ev: { ...ev, text: r.text, type: "text", media: null, referral: null, heard: "voice" } };
    }
    const r = await lookImage({ buf: f.buf, mime, callModel: assistCall, model: acfg.visionModel, timeoutMs: acfg.timeoutMs });
    if (r && r.usage) { try { await aicost.record({ purpose: "assistant", provider: r.provider, model: acfg.visionModel, usage: billableUsage(r.usage), usageKind: "anthropic", ms: r.ms, phone, outcome: r.ok ? "ok" : String(r.reason).slice(0, 40), detail: `media:vision ${r.ok ? r.kind : ""}`.trim(), sent: null, logId }, cfg.llm.prices); } catch (e) { console.error("[assist] media cost:", e.message); } }
    if (!r || !r.ok) return why(`vision_${(r && r.reason) || "error"}`);
    if (!r.clear || r.kind === "other") return why(`vision_${r.clear ? "other" : "unclear"}`);
    await q("UPDATE wa_bot_log SET text=$2 WHERE id=$1", [logId, `🖼 ${r.summary}`.slice(0, 500)]);
    if (r.kind === "menu_or_ad") {
      const cap = String(m.caption || "").replace(/\s+/g, " ").trim().slice(0, 300);
      return { seen: { ...ev, text: `${cap ? `${cap}\n` : ""}[صورة من العميل] ${r.summary}`, type: "text", media: null, heard: "image" } };
    }
    /* رد ثابت (نص قابل للتعديل) — الموديل مابيكتبش حاجة للعميل هنا. */
    const key = r.kind === "payment" ? "media_payment" : r.kind === "order_problem" ? "media_order" : "media_location";
    let reply; try { reply = buildReply(key, { cfg, lang, data: data || {}, referral: null, factual: false, arg: null }); } catch (e) { return why(`reply_${key}`); }
    const p = toPayload({ body: reply.body }, { cfg, lang, interactive: false, footer: false });
    if (payloadProblem(p)) return why(`payload_${key}`);
    return { d: { key, payloads: [p], fallback: [p], handoff: key === "media_payment" ? ["problem", "urgent"] : key === "media_order" ? ["complaint", "urgent"] : null,
      note: key === "media_location" ? null : `صورة: ${r.summary}`.slice(0, 200), detail: `media:vision ${r.kind}`, disclose: false, unknown: false, link: null, channel: null } };
  }
  /* ── M5: مين البوت نفسه يرد عليه ───────────────────────────────────────────────
     never: سبب إن الرقم ده مش عميل (never_list / alert_phone / courier / staff) أو null. out: بره نطاق التشغيل (liveScope) في وضع live.
     المستبعدين لوحدهم (كاش ١٠ دقايق): أرقام تنبيهات الفريق، أرقام فريق البورتال لو متسجّلة، وأرقام المناديب على طلبات آخر ٣٠ يوم. رقم في أرقام التجربة مابيتستبعدش لوحده. */
  /* ST1: رقم في دليل الفريق (settings.waTeam.members) عمره ما يتعامل كعميل — حتى لو في أرقام التجربة. الاستثناء الوحيد بمفتاح من اللوحة
     (waTeam.staffAsTesters): رقم فريق موجود في أرقام التجربة بيفضل يجرّب البوت. الدليل المؤقت (أرقام التنبيهات قبل ما الدليل يتكتب) على القاعدة القديمة:
     مستبعد لوحده إلا لو رقم تجربة. */
  const teamStaff = (settings, phone) => { const tc = teamConfig(settings); return !tc.fallback && Boolean(staffRoleOf(settings, phone)) && !(tc.staffAsTesters && staffPhones(settings?.waBot?.testPhones).includes(phone)); };
  /* SX1 (١٥/١٠ — عميل 0568•••14 كتب «عندي ملاحظات» والبوت سكت): كان هنا «cms_contacts.is_staff» = قايمة استبعاد الحملات (السفراء) ⇒ عميل
     في قايمة «مايوصلوش حملات» بقى «موظف» والبوت ساكت عليه. دلوقتي البوت بيقرا **قايمة «موظفين / فريق» بس** (phonelists.silentMap:
     staff_list) — عمره ما بيقرا «مستثنين من الإعلانات بس» ولا «مستني قرار المالك» (دول شكلهم عملاء ⇒ البوت بيرد). الإعدادات بتتقري كل مرة (تعديل القايمة بيمسك على طول)،
     والكاش (١٠ دقايق) للمناديب بس (من القاعدة). */
  let autoNever = { at: -1e15, map: new Map() };      // المناديب بس
  async function autoNeverMap(settings, cfg) {
    const m = new Map();
    const sc = staffConfig(settings);
    for (const p of [...cfg.alertPhones, ...sc.alertPhones, ...(sc.newOrderPhones || [])].map(normPh)) if (/^5\d{8}$/.test(p)) m.set(p, "alert_phone");
    for (const s of Array.isArray(settings?.portal?.staff) ? settings.portal.staff : []) { const p = normPh(s && (s.phone || s.mobile)); if (/^5\d{8}$/.test(p)) m.set(p, "staff"); }
    for (const tm of teamConfig(settings).members) if (tm.active && !m.has(tm.phone)) m.set(tm.phone, "staff");      // ST1: دليل الفريق
    for (const [p, why] of listSilentMap(settings || {})) if (!m.has(p)) m.set(p, why);      // SX1: قايمة «موظفين / فريق» بس (المستنيين قرار المالك البوت بيرد عليهم)
    const t = clock().getTime();
    if (!(t - autoNever.at < 600_000 && t >= autoNever.at)) {
      const dm = new Map();
      const dr = await q(`SELECT DISTINCT driver->>'phone' AS phone FROM dl_shipments WHERE driver IS NOT NULL AND updated_at > NOW() - INTERVAL '30 days' AND COALESCE(driver->>'phone','') <> '' LIMIT 500`, []);
      for (const r of dr || []) { const p = normPh(r.phone); if (/^5\d{8}$/.test(p)) dm.set(p, "courier"); }
      autoNever = { at: t, map: dm };
    }
    for (const [p, why] of autoNever.map) if (!m.has(p)) m.set(p, why);
    return m;
  }
  async function liveGate5({ cfg, settings, phone, chat, ev, now }) {
    if (cfg.neverReplyPhones.includes(phone)) return { never: "never_list", out: false };
    if (teamStaff(settings, phone)) return { never: "staff", out: false };
    if (cfg.testPhones.includes(phone)) return { never: null, out: false };
    let auto = null; try { auto = (await autoNeverMap(settings, cfg)).get(phone) || null; } catch { auto = null; }
    if (auto) return { never: auto, out: false };
    if (cfg.mode !== "live" || cfg.liveScope === "all") return { never: null, out: false };
    const fromAd = Boolean(ev && ev.referral) || Boolean(chat && chat.referral_at && now.getTime() - Date.parse(chat.referral_at) < cfg.adWindowHours * 3600_000);
    if (fromAd) return { never: null, out: false };
    if (cfg.liveScope === "new" && cfg.liveSince) {
      const old = await q("SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND created_at < $2::timestamptz LIMIT 1", [phone, cfg.liveSince]);
      if (old !== null && old.length === 0) return { never: null, out: false };
    }
    return { never: null, out: true };
  }
  /* ── مين ياخد المساعد (١٢/١٠: وضع العملاء على مراحل) ───────────────────────────
     off ⇒ محدش. test ⇒ أرقام التجربة. live ⇒ أرقام التجربة + جمهور assist.liveAudience، لحد assist.liveDailyCustomers عميل مختلف في اليوم.
     العميل اللي بدأ مع المساعد النهارده بيكمل معاه حتى لو السقف اتوصل له بعد كده (السقف على العملاء مش على الرسايل).
     count=false (المتابعة / تنبيه التحويل): مابتبدأش عميل جديد — بس اللي المساعد كان معاه (النهارده أو امبارح).
     الحجز ذرّي: الصف بيتضاف بس لو عدد عملاء اليوم أقل من السقف. القاعدة ماردّتش ⇒ بوت القواعد (مانخمّنش). أقفال الحارس وقايمة «إيقاف» زي ما هي على الإرسال نفسه. */
  const LIVE_DAY = `((NOW() AT TIME ZONE 'Asia/Riyadh')::date)`;
  async function assistAudience({ cfg, phone, chat, now, hasReferral = false, count = true }) {
    const acfg = cfg.assist;
    if (!assist || !["test", "live"].includes(acfg.mode)) return { on: false, why: "assist_off" };
    if (cfg.testPhones.includes(phone)) return { on: true, why: "test_phone" };
    if (acfg.mode !== "live") return { on: false, why: "test_only" };
    if (cfg.mode !== "live") return { on: false, why: "bot_not_live" };
    const mine = await q(`SELECT 1 FROM wa_assist_live_day WHERE phone_norm=$1 AND day >= ${LIVE_DAY} - $2::int LIMIT 1`, [phone, count ? 0 : 1]);
    if (mine === null) return { on: false, why: "db" };
    if (mine.length) return { on: true, why: "live_today" };
    if (!count) return { on: false, why: "not_started" };
    const A = acfg.liveAudience;
    if (A === "test") return { on: false, why: "audience_test" };
    let match = A === "all";
    if (!match && (A === "ads" || A === "ads_campaign")) match = hasReferral || Boolean(chat && chat.referral_at && now.getTime() - Date.parse(chat.referral_at) < cfg.adWindowHours * 3600_000);
    if (!match && (A === "campaign" || A === "ads_campaign")) {
      const r = await q(`SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND direction='out' AND category='MARKETING' AND COALESCE(status,'') NOT IN ('failed','skipped')
                           AND created_at > NOW() - make_interval(hours => $2::int) LIMIT 1`, [phone, Math.ceil(cfg.adWindowHours)]);
      match = Boolean(r && r.length);
    }
    if (!match) return { on: false, why: "not_in_audience" };
    if (!(acfg.liveDailyCustomers > 0)) return { on: false, why: "daily_cap" };
    const ins = await q(`INSERT INTO wa_assist_live_day(day, phone_norm, why) SELECT ${LIVE_DAY}, $1, $2 WHERE (SELECT count(*) FROM wa_assist_live_day WHERE day = ${LIVE_DAY}) < $3::int
                         ON CONFLICT (day, phone_norm) DO NOTHING RETURNING phone_norm`, [phone, A, Math.round(acfg.liveDailyCustomers)]);
    if (ins === null) return { on: false, why: "db" };
    return ins.length ? { on: true, why: "live_new" } : { on: false, why: "daily_cap" };
  }
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
      else if (l && l.target_type === "product") {      // M3: إعلان عن صنف (مثلاً مشكل مخصوص بالوزن): الاسم والأوزان بأسعارها
        const it = know.menu && know.menu.items ? know.menu.items.find((x) => String(x.id) === String(l.target_id)) : null;
        if (it && !it.soldOut) advertised = { kind: "item", id: String(it.id), name: it.name, ...(it.nameEn ? { name_en: it.nameEn } : {}), ...(it.byWeight && it.weights ? { by_weight: true, weights: it.weights.map((w) => ({ label: w.label_ar, label_en: w.label_en, price: w.price, variant_option_id: w.variant_option_id })) } : { price: it.price }) };
      }
      else if (l && l.target_type === "offer") { let list = null; try { list = await liveOffers(settings, now); } catch { list = null; } const o = (list || []).find((x) => String(x.id) === String(l.target_id)); if (o) advertised = { kind: "offer", title: o.title, price: Number(o.price), ...(o.until ? { until: o.until } : {}) }; }
    }
    return headline || advertised ? { ...(headline ? { ad_text: headline } : {}), ...(advertised ? { advertised } : {}) } : null;
  }
  /* ST2: الموظف قفل المحادثة ⇒ أول دور للمساعد بعدها بياخد ملخص اللي الموظف قاله + النتيجة والملاحظة (waflow.handbackFor). مرة واحدة: بيتشال بعد ما رد المساعد يتبعت. */
  const flowApi = () => { try { return (typeof deps.flow === "function" ? deps.flow() : deps.flow) || null; } catch { return null; } };
  /* PS3: «اطلب لوقت لاحق» متاح في المتجر؟ (settings.preorder) — المساعد يعرضه على اللي أجّل بس لو متاح فعلاً. */
  const laterOk = (settings) => { try { const p = preorderCfg(settings || {}); return p.enabled === true && Array.isArray(p.slots) && p.slots.length > 0; } catch { return false; } };
  async function assistContext({ fresh, phone, cfg, lang, chat, know, data, now, cls, pending = null, ev = null, settings = null }) {
    const hours = await assist.get_hours();
    let handback = null; { const fl = flowApi(); if (fl && typeof fl.handbackFor === "function") { try { handback = await fl.handbackFor(phone); } catch (e) { console.error("[assist] handback:", e.message); handback = null; } } }
    let profile = null, offers = null, reorder = null, notes = null, ad = null, personal = undefined, mem = null;
    if (fresh || (ev && ev.referral)) { try { ad = await adContext({ ev, chat, cfg, know, settings, now }); } catch (e) { console.error("[assist] ad:", e.message); ad = null; } }
    if (fresh) { const kb = kbApi(); if (kb) { try { notes = await kb.notesFor(lang); } catch { notes = null; } } }
    /* دعوة القناة للمساعد: نفس شرط البوت (data.channelOk) + مش في سؤال حساسية/مكوّن ولا مع تحويل مستني موظف. النص المعتمد + الرابط المضبوط بالظبط. */
    let channel = null;
    if (data && data.channelOk === true && channelOn(cfg) && !pending && cls.key !== "dishfact") { try { channel = { say: `${textOf(cfg, "channel_assist", lang)} ${cfg.links.channel.url}`, url: cfg.links.channel.url }; } catch { channel = null; } }
    if (fresh) {
      /* S1: السجل الشخصي (عادته…) من نفس نداء ملف العميل، وذاكرة الرفض (قراية واحدة لأول دور) — للكود بس، مابيدخلوش سياق الموديل */
      const a0 = cfg.assist || {}, memDays = Math.max(Number(a0.declineCoolDays) || 0, 60 + (Number(a0.declineMuteDays) || 0));
      const [p, o, rows] = await Promise.all([assist.customer_profile(phone), assist.get_offers(phone), typeof assistStore.declinesOf === "function" ? assistStore.declinesOf(phone, memDays).catch(() => []) : []]);
      profile = p && p.ok ? p.profile : null; offers = o && o.ok ? o : null; personal = p && p.ok ? p.personal || null : null;
      try { mem = declineMemory(rows || [], now, a0); } catch (e) { console.error("[assist] decline memory:", e.message); mem = null; }
      let ro = data && data.reorder && data.reorder.plan ? data.reorder : null;
      if (!ro && cfg.reorderEnabled) {
        try { const snaps = await botCarts.lastOrderCarts(phone, cfg.reorderMaxDays, { limit: cfg.reorderLookback, minTotal: cfg.reorderMinTotal });
          for (const snap of snaps || []) { const plan = reorderPlan(snap, { menu: know.menu, bundles: know.bundles && know.bundles.length ? know.bundles : null }); if (plan && plan.ok) { ro = { plan, at: snap.at }; break; } } }
        catch (e) { console.error("[assist] reorder:", e.message); }
      }
      if (ro) reorder = { day: orderDay(ro.at, lang), lines: ro.plan.lines.map((l) => ({ name: lang === "en" ? l.nameEn : l.name, qty: l.q })), note: "a one-tap button for the same order is attached under your message" };
    }
    /* MJ1 (١٦/١٠: «تبي نفس طلبك السابق؟» لعميل طلبه لسه في المطبخ ×٢): طلب شغّال ⇒ مفيش عرض إعادة طلب، والموديل عارف إن له طلب ماشي */
    let activeOrder = null;
    if (cfg.activeOrderFirst) { try { const ao = await activeOrderOf(phone, cfg); if (ao) { activeOrder = { order_no: String(ao.order_no), status: String(ao.status) }; reorder = null; } } catch (e) { console.error("[assist] active order:", e.message); } }
    let branch = null; try { branch = fresh ? textOf(cfg, "location", lang) : null; } catch { branch = null; }
    return { profile, personal, mem, reorder, context: buildContext({ first: fresh, hours: hours && hours.ok ? hours : null, profile, offers, reorder, locationShared: locFresh(chat.last_loc, now), justShared: cls.key === "area", branch, boxes: fresh ? know.bundles : null, hint: hintOf(withAlt(cls)), handover: pending, notes, ad, channel, handback, later: laterOk(settings), activeOrder }), handback: Boolean(handback) };
  }
  const assistDeps = (cfg, settings, logId) => ({ tools: assist, callModel: assistCall, now: clock,
    knowOf: async () => ({ menu: await menuIndex(settings, clock()), boxes: (await bundles()) || [] }),
    faq: async (topic, lang, asked = "") => {
      const pick = (o) => faqAnswer(String((o && (lang === "en" ? o.en || "" : o.ar || "")) || ""), asked) || null;
      if (topic === "payment") { const f = (settings?.storefront?.seo?.faq || []).find((x) => /دفع/.test(String(x?.q || ""))); return f ? String((lang === "en" ? f.a_en : f.a) || f.a || "").trim() || null : null; }
      if (topic === "branch_location") { try { return textOf(cfg, "location", lang); } catch { return null; } }
      return FAQ_DEFS[topic] ? pick(cfg.faq && cfg.faq[topic]) : null;
    },
    dishFactSay: async (a) => { let open = null; try { open = settings?.hours ? openState(settings, clock()) : null; } catch { open = null; } return dishFactSay(cfg, { settings, now: clock(), open }, a); },
    kbSearch: async (question, lang) => { const kb = kbApi(); return kb ? kb.search(question, lang) : null; },
    brief: async () => briefBlock(cfg.brief, { menu: await menuIndex(settings, clock()), boxes: (await bundles()) || [], live: { cash: settings?.shop?.allowCash === true } }),      // PK1
    deliveryInfo: async () => { const r = await q("SELECT config FROM dl_policies WHERE active ORDER BY priority DESC, id LIMIT 1", []); const pol = r && r[0] ? r[0].config : null; const fees = pol ? feeLines(pol, "ar") : "";
      return pol && fees ? { ok: true, delivers_up_to_km: Number(pol.maxKm) || null, far_zone_up_to_km: pol.farZoneEnabled !== false ? Number(pol.farZoneMaxKm) || null : null, far_zone_extra_per_km: pol.farZoneEnabled !== false ? Number(pol.farZonePerKm) || null : null,
        fee_by_order_total: fees.split("\n"), ladder: Array.isArray(pol.feeByTotal) ? pol.feeByTotal.map((x) => ({ over: Number(x.over), fee: Number(x.fee) })) : null, note: "the exact fee for the customer is shown on the website before payment" } : null; },
    feeSay: async (options, lang, o) => feeSayOf(cfg, options, lang, o),
    cartRecap: async (cart, lang) => cartRecapOf(cfg, cart, lang),      // PS5
    sales: (key, vars, lang) => salesTextOf(cfg, key, vars, lang),      // SB1: نصوص عقل البيع (من اللوحة) بأرقام النظام
    firstLead: async (v, lang) => fill("first_lead", textOf(cfg, "first_lead", lang === "en" ? "en" : "ar"), { from: money(v.from), code: v.code }),      // PS5      // PS4: نص لحظة الرسوم من نصوص اللوحة
    /* PS3: خطة التذكير — آخر رسالة للعميل = الرسالة دي (النافذة ٢٤ ساعة منها)، ساعات الهدوء من الإعدادات، والمطعم لازم يكون فاتح في الميعاد. */
    reminder: async ({ day, time, lang }) => planReminder({ now: clock(), day, time, lastInMs: clock().getTime(), quietStart: cfg.assist.reminderQuietStart, quietEnd: cfg.assist.reminderQuietEnd, lang,
      isOpenAt: (dt) => { try { return settings?.hours ? isOpenNow(settings.hours, dt) : null; } catch { return null; } } }),
    onCall: async (m) => { const rec = await aicost.record({ ...m, purpose: "assistant", logId }, cfg.llm.prices); return { costSar: rec.costSar, in: rec.in, out: rec.out, cached: rec.cached }; } });
  async function assistTurn({ ev, logId, settings, cfg, d, cls, chat, data, know, now, echoAt, phone, held = false, allowed = false }) {
    const acfg = cfg.assist;
    if (!assist || !allowed) return null;
    await ready;
    let session = await assistStore.loadSession(phone, now, acfg.sessionMin);
    /* PS2: «جلسة بذرة» = بوت القواعد رد على سؤال سعر صنف في أول المحادثة (rulesFirstPrice) وسجّل السؤال، والمساعد لسه مادخلش. مش محادثة مساعد شغّالة (المواعيد والموقع والشكر
       يفضلوا مع القواعد ببلاش)، وأول دور للمساعد بعدها بياخد سياق أول دور كامل (ملف العميل، العروض، البوكسات) وهو شايف سؤال العميل اللي فات. */
    const seeded = Boolean(session && session.state && (session.state.seed === true || session.state.seed === "reminder" || session.state.seed === "campaign")), cardSeed = Boolean(session && session.state && session.state.seed === true);
    /* «بدون بصل» وهو بيجهّز سلة = ملاحظة للمساعد؛ بس لو له طلب حديث من الموقع تبقى «تعديل طلب» للموظف زي النهارده (ومانعرفش ⇒ نفترض إن له طلب). */
    let recentOrder = false;
    if (cls.key === "change" || cls.key === "complaint") { const ro = await q(`SELECT 1 FROM shop_orders WHERE phone_norm=$1 AND NOT COALESCE(is_test,false) AND status NOT IN ('expired','pending_payment') AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [phone]); recentOrder = ro === null || ro.length > 0; }
    /* PS5: «حالة الطلب» للقواعد بس لو للعميل طلب مفتوح فعلاً (نفس قراءة أداة المساعد). مانعرفش ⇒ null ⇒ القواعد. */
    let openOrder = null;
    if (cls.key === "status" && assist) { try { const os = await assist.order_status(phone); openOrder = os && os.ok ? os.has_open_order === true : null; } catch { openOrder = null; } }
    const el = assistEligible({ acfg, cfg, phone, ev, cls, d, afterWait: null, sessionActive: Boolean(session) && !cardSeed, handoverOpen: held, recentOrder, openOrder, allowed });
    const lang = cls.lang === "en" ? "en" : "ar";
    const ruleKey = () => String((d && d.key) || cls.key || "reply");
    const turnRow = (x) => assistStore.addTurn({ phone, sessionId: session ? session.id : null, logId, wamid: ev.wamid || null, lang, ...x });
    if (!el.run) {
      return { d: null, done: async ({ okSent, sentText = "" }) => {       // القواعد ماسكة الرسالة: لو ردّت وسط محادثة المساعد، تتسجّل عشان المساعد يفضل فاهم السياق
        if (!okSent) return;
        /* مراجعة CR2: رد «أبغى أطلب» على رسالة حملة (عرضها + رابطها) ⇒ المساعد يعرف العرض والرد بالحرف، و«نعم / ايوه» بعده توصل له (مش سكوت) */
        const campTurn = cls.rawIntent === "campaign_reply" && d && d.key === "order" && data && data.campReply && data.campReply.ok && ["tap", "rules:campaign_order"].includes(el.why);
        if (campTurn) await assistStore.saveSession(phone, noteCampaignTurn(session, now, { text: ev.text, offer: data.campReply, sent: sentText }), now);
        else if (session) await assistStore.saveSession(phone, noteRulesTurn(session, ev.text, ruleKey()), now);
        else if (el.seed) { const s0 = newSession(now); s0.state.seed = true; await assistStore.saveSession(phone, noteRulesTurn(s0, ev.text, "dish card: price + order button"), now); }
        await turnRow({ handledBy: "rules_owned", outcome: `rules:${el.why.replace(/^rules:/, "")}`, masked: maskText(ev.text), trace: {} });
      } };
    }
    const fallback = async (reason, trace = {}) => {
      await q("UPDATE wa_bot_log SET detail=$2 WHERE id=$1", [logId, `assist off: ${reason}`]);
      /* ST1: رد للمساعد اترفض من المراجِع مرتين ⇒ «حاجة غريبة» ومعاها اللي كان هيقوله؛ وسقف المصروف / حد الردود اليومي ⇒ مرة في اليوم. */
      if (reason === "validator") { const v = Array.isArray(trace.verdicts) ? trace.verdicts[trace.verdicts.length - 1] : null;
        await oddThing(settings, cfg, "assist_refused", phone, { tried: v && v.text ? String(v.text) : null, detail: v && Array.isArray(v.problems) ? `سبب الرفض: ${v.problems.map((p) => p.type).slice(0, 4).join("، ")}` : null }); }
      else if (reason === "budget_day" || reason === "budget_month") await oddThing(settings, cfg, "budget_cap", null, { detail: reason === "budget_day" ? "سقف مصروف المساعد اليومي اتوصل له — بوت القواعد مكمل" : "ميزانية المساعد الشهرية خلصت — بوت القواعد مكمل", repeatMin: 1440 });
      else if (reason === "daily_replies") await oddThing(settings, cfg, "budget_cap", phone, { detail: `العميل وصل حد ردود المساعد في اليوم (${acfg.maxRepliesPerChatDay})`, repeatMin: 1440 });
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
    if (acfg.typing && ev.wamid && typeof wa.sendTyping === "function") wa.sendTyping({ phoneNorm: phone, wamid: ev.wamid, allowList: cfg.mode === "test" || acfg.mode !== "live" ? cfg.testPhones : null }).catch((e) => console.error("[assist] typing:", e.message));
    const fresh = !session || seeded;
    if (!session) session = newSession(now);
    if (seeded) { session = JSON.parse(JSON.stringify(session)); delete session.state.seed; }
    /* تحويل عادي لسه مستني موظف: المساعد يعرف (مايحوّلش نفس الحاجة تاني، ويقول للعميل إن الموظف هيرد) ويكمل يساعد. */
    const pending = handoverOpenOf(chat, cfg, echoAt, now) ? { reason: String(chat.handoff_reason || "handover"), minutes_ago: Math.max(0, Math.round((now.getTime() - Date.parse(chat.handoff_at)) / 60_000)) } : null;
    const cx = await assistContext({ fresh, phone, cfg, lang, chat, know, data, now, cls, pending, ev, settings });
    if (ev.heard) cx.context = { ...cx.context, ...heardContext(ev.heard === "voice" ? "voice" : "image") };      // PS2: القاعدة بتيجي مع المفتاح
    /* PS1 — الشخصية: الاسم في سياق أول دور، وجملة التعريف في الدور اللي التعريف مستحق فيه بس (أول رد في المحادثة / مرة كل disclosureHours). */
    const discloseDue = !chat.last_disclosed_at || now.getTime() - Date.parse(chat.last_disclosed_at) >= cfg.disclosureHours * 3600_000;
    const persona = personaOn(cfg);
    if (fresh || (persona && discloseDue)) cx.context = { ...cx.context, you: { name: cfg.assist.personaName, name_en: cfg.assist.personaNameEn, what: "Fresh Cuts' digital assistant (not a human)" } };
    if (persona && discloseDue) cx.context = { ...cx.context, introduce_yourself: { say: introSay(personaNameOf(cfg, lang), lang), rule: "use this phrase once in this message, exactly as it is" } };
    /* PS5 (…٦٨٦٩: خمس صور للأصناف وصلت والمحادثة مكتومة، والمساعد بنى السلة من الكلام بس): صور العميل في آخر sessionMin دقيقة اللي لسه محدش شافها بتتشاف دلوقتي (نفس السقف والإخفاء)،
       ووصفها بيدخل سياق الدور ده قبل أي تسعير. */
    let earlierPictures = null;
    if (acfg.imagesEnabled && !ev.burstSeen && !ev.heard) { try {
      const pics = await q(`SELECT m.wamid, m.media, l.id AS log_id FROM wa_messages m JOIN wa_bot_log l ON l.wamid = m.wamid
                             WHERE m.phone_norm=$1 AND m.direction='in' AND m.media->>'kind'='image' AND m.created_at > NOW() - make_interval(mins => $2::int) AND COALESCE(l.text,'') NOT LIKE '🖼%' AND l.id <> $4 ORDER BY m.id DESC LIMIT $3`, [phone, Math.ceil(acfg.sessionMin), Math.round(acfg.imageBurstMax), logId]);
      const seen = [];
      for (const pz of (pics || []).reverse()) { const md = typeof pz.media === "string" ? JSON.parse(pz.media) : (pz.media || {}); if (!md.id) continue;
        const mu = await understandMedia({ ev: { phone, wamid: pz.wamid, text: "", type: "image", media: { id: md.id, kind: "image", mime: md.mime || null, caption: md.caption || null } }, cfg, phone, logId: pz.log_id, lang, data: {} });
        if (mu && mu.seen) seen.push(String(mu.seen.text || "").replace(/^\[صورة من العميل\]\s*/, "").trim()); }
      if (seen.length) earlierPictures = seen.map((s, i) => `صورة ${i + 1}: ${s}`).join("\n");
    } catch (e) { console.error("[assist] earlier pictures:", e.message); earlierPictures = null; } }
    const loop = makeAssistLoop(assistDeps(cfg, settings, logId));
    const text = cls.key === "area" ? "📍" : String(ev.text || "");      // الموقع نفسه مابيتبعتش للموديل: علامة بس، والسياق بيقول إنه شارك موقعه
    const r = await loop.runTurn({ phone, text, lang, session, acfg, context: cx.context, profile: cx.profile, earlierPictures, personal: cx.personal, mem: cx.mem, tap: ev.interactiveId || null });      // S1: السجل الشخصي + ذاكرة الرفض (أول دور) + معرّف الزر
    if (!r.ok) { if (fresh) session = null; if (/^model_http_400/.test(r.reason)) { await assistStore.dropSession(phone); session = null; } return fallback(r.reason, r.trace); }
    const tr = r.trace, nowMs = now.getTime(), L = tr.lang === "en" ? "en" : tr.lang === "ar" ? "ar" : lang;      // لغة الدور زي ما المساعد حدّدها («Pickup» وسط محادثة إنجليزية = إنجليزي)
    const bc = { cfg, lang: L, data, referral: null, factual: false, arg: null };
    let reply, handoff = null;
    try {
      if (r.handover) { const [k, tuple] = ASSIST_HANDOVER[r.handover.reason] || ASSIST_HANDOVER.needs_staff; reply = buildReply(k, k === "dishfact" ? { ...bc, arg: { id: null, text: "حساسية شديدة" } } : bc); handoff = tuple; reply = { body: reply.body }; }
      else { let map = null; if (r.photoItem && !r.cart && !r.location) { try { map = { title: textOf(cfg, "cta_menu", L), url: `${STORE}/l/wab-menu#item-${r.photoItem}` }; } catch { map = null; } }      // PS5: «كيف شكله؟» ⇒ زر يفتح صورة الصنف في المنيو
        if (r.location && !r.cart) { try { map = buildReply("location", bc).cta || null; } catch { map = null; } }      // PS3: رد الموقع ⇒ زر «افتح الخريطة» (نفس رابط بوت القواعد). السلة لها الأولوية (زر واحد في الرسالة)
        if (r.menu && !r.cart && !map) { try { map = { title: textOf(cfg, "cta_menu", L), url: `${STORE}/l/wab-menu` }; } catch { map = null; } }      // PK1: «وش عندكم؟» ⇒ زر يفتح المنيو كامل
        let extras = {}; if (!r.cart && !map) { try { extras = assistExtras(cfg, L, r); } catch { extras = {}; } }      // PS4: زرّين لحظة الرسوم / بوكس كبير وبديله / أزرار الإعلان / قايمة اختيارات البوكس
        reply = { body: r.text, ...(r.cart ? { cta: { title: textOf(cfg, "cta_reorder", L), url: r.cart.link } } : map ? { cta: map } : extras.buttons || extras.list ? extras : fresh && cx.reorder ? { buttons: [{ id: "re:last", title: textOf(cfg, "row_reorder", L) }] } : {}) }; }
    } catch (e) { if (fresh) session = null; return fallback("reply_build", tr); }
    const disclose = discloseDue;
    /* persona: المساعد قال التعريف في مكانه الطبيعي؛ لو ماقالوش (أو الرد نص تحويل ثابت) الكود بيحطه — التعريف مضمون بالكود مش بالموديل. classic: السطر القديم فوق الرد. */
    if (disclose) { try { reply = { ...reply, body: persona ? ensureIntro(reply.body, introSay(personaNameOf(cfg, L), L), personaNameOf(cfg, L)) : `${disclosureLine(cfg, L, settings)}\n${reply.body}` }; } catch { /* من غير التعريف أحسن من مفيش رد */ } }
    const payloads = [toPayload(reply, { cfg, lang: L, interactive: cfg.interactive, footer: false })], fb = [toPayload(reply, { cfg, lang: L, interactive: false, footer: false })];
    if ([...payloads, ...fb].map(payloadProblem).find(Boolean)) { if (fresh) session = null; return fallback("payload", tr); }
    const outcome = r.handover ? `handover:${r.handover.reason}` : "sent";
    const nd = { act: "reply", reason: "assistant", key: "assist", rawIntent: cls.rawIntent, lang: cls.lang, score: cls.score, payloads, fallback: fb, handoff, note: r.handover ? r.handover.note : null,
      detail: `assist ${tr.tier}${tr.escalated ? "↑" : ""} ${tr.calls.length} calls ${tr.ms}ms ${Math.round(tr.costSar * 10000) / 10000} SAR${r.handover ? ` → ${r.handover.reason}` : ""}`,
      greet: cls.key === "greet", resume: null, optout: null, link: null, unknown: false, disclose, factual: false, optinAsk: null, optinAnswer: null, channel: tr.channelOffered && !r.handover ? "assistant" : null };
    return { d: nd, done: async ({ okSent, error }) => {
      if (!okSent) { await turnRow({ handledBy: "assistant", outcome: `send_failed${error ? `:${String(error).slice(0, 60)}` : ""}`, masked: tr.sent, text: r.text, trace: tr, handover: r.handover ? r.handover.reason : null }); return; }
      session = r.session;
      await assistStore.saveSession(phone, session, now);
      if (cx.handback) { const fl = flowApi(); if (fl && typeof fl.handbackUsed === "function") { try { await fl.handbackUsed(phone); } catch (e) { console.error("[assist] handback used:", e.message); } } }
      const turnId = await turnRow({ handledBy: "assistant", outcome, masked: tr.sent, text: r.handover ? reply.body : r.text, trace: tr, cartCode: r.cart ? r.cart.code : null, handover: r.handover ? r.handover.reason : null, lang: L });      // MJ1 #٣: لغة الدور زي ما اتردّ بيها فعلاً
      await assistStore.recordSuggestions(phone, session.id, turnId, tr.suggestions, r.cart ? r.cart.code : null);      // S1: المحسوب اللي ماتعرضش بيتسجّل كمان (بسببه)
      /* قاعدة المعرفة: الإجابة اللي اتستخدمت تتعدّ، والسؤال اللي المساعد ماعرفش يجاوبه (أو حوّله لموظف) ينزل في طابور المدير — مقنّع ومن غير أي ربط بالعميل. */
      { const kb = kbApi();
        if (kb) { try {
          if (tr.kb && tr.kb.used) await kb.markUsed(tr.kb.used);
          for (const u of tr.unanswered || []) await kb.queue({ question: u.question, lang: L, source: u.source === "dish_fact" ? "dish_fact" : "no_answer" });
          if (r.handover && r.handover.reason === "needs_staff" && !(tr.unanswered || []).length && !/موظف|انسان|إنسان|شخص|بشري|staff|human|agent|person/i.test(String(ev.text || ""))) await kb.queue({ question: tr.sent || maskText(ev.text), lang: L, source: "handover" });
        } catch (e) { console.error("[assist] kb:", e.message); } } }
      if (r.reminder) { try { if (r.reminder.cancel) await cancelReminder(phone, "customer_cancelled"); else if (r.reminder.at) await scheduleReminder(phone, { at: r.reminder.at, ref: r.reminder.ref || null, lang: L, setAt: clock().toISOString() }); } catch (e) { console.error("[assist] reminder:", e.message); } }
      /* PK1: الرد خلص بسؤال ومفيش سلة ولا تحويل ⇒ متابعة واحدة محددة لو العميل سكت (runNudge بيراجع كل الشروط وقتها). كل رد جديد بيأجّلها. */
      if (acfg.nudgeMin > 0 && !r.cart && !r.handover && /[؟?]\s*$/.test(String(r.text || "").trim())) { try { await scheduleNudge(phone, { at: clock().toISOString(), lang: L }, acfg); } catch (e) { console.error("[assist] nudge:", e.message); } }
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
  /* ── PK1 — متابعة المحادثة اللي وقفت عند سؤال المساعد ──────────────────────────
     يوم ١٣/١٠: ١١ محادثة بدأت بسؤال الإعلان الجاهز («وش عرض أول طلب؟»، «كيف أطلب من الموقع؟»)، ٧ منهم رسالة واحدة: اتردّ عليهم وماحصلش بعدها حاجة — متابعة الـ٢٠ دقيقة
     (lead_followup) بتشتغل بس لما البوت يسكت، ونصها اعتذار عام. دي متابعة تانية: صف واحد للعميل في اليوم (nudge:<الرقم>:<اليوم>)، كل رد جديد من المساعد بسؤال بيأجّله،
     ووقت التنفيذ كل الشروط بتتراجع من جديد. النص محدد: الصنف المعلن بأسعاره من المنيو الحي + سؤال واحد. */
  async function scheduleNudge(phone, ev, acfg) {
    const key = `nudge:${phone}:${riyadhDay(clock())}`, due = new Date(Date.parse(ev.at) + acfg.nudgeMin * 60_000).toISOString();
    const u = await q(`UPDATE wa_bot_jobs SET status='pending', reason=NULL, done_at=NULL, due_at=$2, ev=$3 WHERE wamid=$1 AND status IN ('pending','cancelled') RETURNING id`, [key, due, jb(ev)]);
    if (u && !u.length) await q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [key, phone, "assist_nudge", due, jb(ev), null]);
  }
  /* نص المتابعة (صافي من ناحية الإرسال): من الإعلان اللي العميل جه منه لو مربوط بصنف، وإلا السؤال العام. ⇒ { body, buttons? } */
  function nudgeReply(cfg, lang, ad) {
    const L = lang === "en" ? "en" : "ar", a = ad && ad.advertised ? ad.advertised : null, nm = a ? ((L === "en" && a.name_en) || a.name || a.title) : null;
    if (a && a.by_weight && Array.isArray(a.weights) && a.weights.length) return { body: fill("lead_nudge_ad_weight", textOf(cfg, "lead_nudge_ad_weight", L), { dish: nm, prices: a.weights.map((w) => (L === "en" ? `${w.label_en || w.label} SAR ${money(w.price)}` : `${w.label} ${money(w.price)} ر.س`)).join(" · ") }) };
    if (a && nm && Number(a.price) > 0) return { body: fill("lead_nudge_ad", textOf(cfg, "lead_nudge_ad", L), { dish: nm, price: money(a.price) }), ...assistExtras(cfg, L, { buttons: { kind: "ad" } }) };
    return { body: textOf(cfg, "lead_nudge", L) };
  }
  async function runNudge(j, settings, cfg, now, end) {
    const acfg = cfg.assist, phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (!["test", "live"].includes(acfg.mode) || !(acfg.nudgeMin > 0)) return no("off"); if (!ev.at) return no("bad_job");
    if (now.getTime() - new Date(j.due_at).getTime() > cfg.maxAgeMinutes * 60_000) return no("stale");
    if (!(await assistAudience({ cfg, phone, chat: {}, now, hasReferral: false, count: false })).on) return no("not_in_audience");
    const [why, m, chat, op] = await ownGate(phone, settings, cfg, now, ev.at);
    if (why) return no(why);
    if (Number(m.wrote) > 0) return no("customer_wrote"); if (Number(m.staff) > 0) return no("staff_in_chat");
    if (op.marketing_off_at) return no("stopped");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return no("handover_open");
    if (chat.follow_declined_at && now.getTime() - Date.parse(chat.follow_declined_at) < cfg.replyFollowUpDeclineDays * 86400_000) return no("declined");      // FU1: «لا شكراً» = مفيش متابعات
    const out = await q(OUT_AFTER_SQL, [phone, ev.at]);
    if (out === null) return no("out_check_failed"); if (out.length) return no("already_answered");
    const cmp = await q(COMPLAINT_24H_SQL, [phone]);
    if (cmp === null) return no("complaint_check_failed"); if (cmp.length) return no("complaint_today");
    const since = new Date(now.getTime() - 6 * 3600_000).toISOString();      // سلة أو طلب في آخر ٦ ساعات ⇒ مفيش متابعة (متابعة السلة لها رسالتها)
    const cart = await q("SELECT 1 FROM wa_bot_carts WHERE phone_norm=$1 AND created_at > $2 LIMIT 1", [phone, since]);
    if (cart === null) return no("cart_check_failed"); if (cart.length) return no("has_cart");
    const ord = await q("SELECT 1 FROM shop_orders WHERE phone_norm=$1 AND created_at > $2 AND status <> 'expired' LIMIT 1", [phone, since]);
    if (ord === null) return no("order_check_failed"); if (ord.length) return no("ordered");
    const prior = await q(`SELECT 1 FROM wa_bot_jobs WHERE phone_norm=$1 AND kind IN ('assist_nudge','lead_followup','assist_followup','${FU_KIND}') AND status='done' AND done_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [phone]);      // FU1: + متابعة اللي ردّ
    if (prior === null) return no("prior_check_failed"); if (prior.length) return no("already_followed_up");
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    if (!open || open.open !== true) return no("closed");
    const left = minutesToClose(settings.hours, now);
    if (left === null || left < acfg.followUpCloseGuardMin) return no("near_closing");
    const lang = ev.lang === "en" ? "en" : "ar";
    let rep, ad = null;
    try { const know = { menu: await menuIndex(settings, now), bundles: await bundles() }; ad = await adContext({ ev: {}, chat, cfg, know, settings, now }); } catch { ad = null; }
    try { rep = nudgeReply(cfg, lang, ad); } catch { return no("text_invalid"); }
    const err = await sendOwn(phone, cfg, now, rep, lang, "lead_nudge", ad && ad.advertised ? `ad: ${String(ad.advertised.name || ad.advertised.title || "").slice(0, 60)}` : null);
    if (!err) {
      /* المساعد لازم يعرف إنه قال كده: الرسالة بتتلحق بجلسته (لو لسه شغّالة) عشان رد العميل («٣ أشخاص») يتفهم */
      try { const s0 = await assistStore.loadSession(phone, now, acfg.sessionMin); if (s0) { const s1 = JSON.parse(JSON.stringify(s0)); s1.messages.push({ role: "assistant", content: [{ type: "text", text: rep.body }] }); s1.state.say = [...(s1.state.say || []), rep.body].slice(-20); await assistStore.saveSession(phone, s1, now); } } catch (e) { console.error("[assist] nudge session:", e.message); }
      await assistStore.addTurn({ phone, sessionId: null, handledBy: "assistant", outcome: "nudge_sent", masked: null, text: rep.body, lang, trace: {} });
    }
    return end(err ? "cancelled" : "done", err ? `send_failed:${err}`.slice(0, 80) : null);
  }
  /* ── PS3 — التذكير اللي العميل طلبه ─────────────────────────────────────────
     صف واحد «pending» للعميل في wa_bot_jobs (الجديد بيلغي القديم). وقت التنفيذ كل الشروط بتتراجع من جديد (runReminder): أي فحص مانعرفش نتيجته ⇒ مانبعتش. */
  const cancelReminder = (phone, reason) => q(`UPDATE wa_bot_jobs SET status='cancelled', reason=$2, done_at=NOW() WHERE phone_norm=$1 AND kind='assist_reminder' AND status='pending'`, [phone, String(reason).slice(0, 80)]);
  async function scheduleReminder(phone, ev) {
    await cancelReminder(phone, "replaced");
    return q(`INSERT INTO wa_bot_jobs(wamid, phone_norm, kind, due_at, ev, log_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [`rm:${phone}:${Date.parse(ev.at)}`, phone, "assist_reminder", ev.at, jb(ev), null]);
  }
  /* مايتبعتش لو: الوضع أو المساعد أو التذكير اتقفل، الرقم بره الجمهور، الميعاد فات بكتير، العميل طلب من ساعة ما اتفقنا، وقّف الرسايل، المحادثة مكتومة أو عند موظف أو موظف كتب له،
     بره نافذة الـ٢٤ ساعة (هنا وكمان الحارس)، ساعة هدوء، أو المطعم مقفول. */
  async function runReminder(j, settings, cfg, now, end) {
    const acfg = cfg.assist, phone = String(j.phone_norm || ""), ev = typeof j.ev === "string" ? JSON.parse(j.ev) : (j.ev || {});
    const no = (reason) => end("cancelled", reason);
    if (cfg.mode !== "test" && cfg.mode !== "live") return no("mode_off");
    if (!["test", "live"].includes(acfg.mode) || !acfg.remindersEnabled) return no("assist_off");
    if (!(await assistAudience({ cfg, phone, chat: {}, now, hasReferral: false, count: false })).on) return no("not_in_audience");
    if (now.getTime() - new Date(j.due_at).getTime() > cfg.maxAgeMinutes * 60_000) return no("stale");
    if (!ev.at || !ev.setAt) return no("bad_job");
    const ord = await q("SELECT 1 FROM shop_orders WHERE phone_norm=$1 AND created_at > $2 AND status <> 'expired' LIMIT 1", [phone, ev.setAt]);
    if (ord === null) return no("order_check_failed"); if (ord.length) return no("ordered");
    const m = await q(`SELECT max(created_at) FILTER (WHERE direction='in' AND COALESCE(source,'api') <> 'history') AS last_in,
                              count(*) FILTER (WHERE source='echo' AND created_at > $2 AND COALESCE(echo_kind,'staff') <> 'auto')::int AS staff
                         FROM wa_messages WHERE phone_norm=$1 AND created_at > NOW() - INTERVAL '25 hours'`, [phone, ev.setAt]);
    if (m === null || !m[0]) return no("window_check_failed");
    if (Number(m[0].staff) > 0) return no("staff_in_chat");
    if (!m[0].last_in || now.getTime() - new Date(m[0].last_in).getTime() > (24 * 60 - 5) * 60_000) return no("window_closed");
    /* «إيقاف» بعد ما اتفقنا على التذكير (حتى لو وقّف العروض بس) ⇒ مفيش تذكير: العميل قال مش عايز رسايل مننا. */
    const op = await q("SELECT stopped_at, marketing_off_at FROM wa_optins WHERE phone_norm=$1", [phone]);
    if (op === null) return no("optout_check_failed");
    if (op[0] && (op[0].stopped_at || (op[0].marketing_off_at && new Date(op[0].marketing_off_at).getTime() >= Date.parse(ev.setAt)))) return no("stopped");
    const chat = await chatOf(phone);
    if (chat.muted_until && Date.parse(chat.muted_until) > now.getTime()) return no("muted");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return no("handover_open");
    const hr = new Date(now.getTime() + 3 * 3600_000).getUTCHours(), qs = Math.round(acfg.reminderQuietStart), qe = Math.round(acfg.reminderQuietEnd);
    if (qs !== qe && (qs < qe ? hr >= qs && hr < qe : hr >= qs || hr < qe)) return no("quiet_hours");
    let open = null; try { open = settings?.hours ? openState(settings, now) : null; } catch { open = null; }
    if (!open) return no("hours_unknown"); if (open.open !== true) return no("closed");
    const lang = ev.lang === "en" ? "en" : "ar";
    /* الصنف اللي كان بيسأل عنه: من المنيو / البوكسات الحيّة وقت الإرسال (اتشال أو خلص ⇒ التذكير يطلع من غير السطر ده) */
    let dish = null;
    try { if (ev.ref && ev.ref.slug) { const b = ((await bundles()) || []).find((x) => String(x.slug) === String(ev.ref.slug)); if (b) dish = { slug: String(b.slug), name: lang === "en" ? b.name_en || b.name : b.name }; }
      else if (ev.ref && ev.ref.id) { const mi = await menuIndex(settings, now); const it = mi && mi.items ? mi.items.find((x) => String(x.id) === String(ev.ref.id)) : null; if (it && !it.soldOut) dish = { id: String(it.id), name: lang === "en" ? it.nameEn || it.name : it.name }; } }
    catch { dish = null; }
    let body, pl;
    try { body = fill("assist_reminder", textOf(cfg, "assist_reminder", lang), { name: personaNameOf(cfg, lang), about: dish ? fill("assist_reminder_about", textOf(cfg, "assist_reminder_about", lang), { dish: dish.name }) : "" });
      if (!hasIntro(body, personaNameOf(cfg, lang))) body = fill("assist_reminder", TEXTS.assist_reminder[lang], { name: personaNameOf(cfg, lang), about: dish ? fill("assist_reminder_about", TEXTS.assist_reminder_about[lang], { dish: dish.name }) : "" });      // رسالة بنبدأها إحنا: لازم تقول هي مين
      pl = toPayload({ body }, { cfg, lang, interactive: false, footer: false }); } catch { return no("text_invalid"); }
    if (payloadProblem(pl)) return no("payload_invalid");
    const allow = cfg.mode === "test" || acfg.mode !== "live" ? cfg.testPhones : null;
    const r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: allow });
    const err = r.ok ? null : (r.skipped ? `skipped:${r.skipped}` : String(r.error || "send_failed"));
    const lg = await q(
      `INSERT INTO wa_bot_log(wamid, msg_at, phone_norm, mode, msg_type, text, intent, reply_key, score, lang, decision, referral)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
      [null, now.toISOString(), phone, cfg.mode, "reminder", "", "assist_reminder", "assist_reminder", 0, lang, false]);
    if (lg && lg[0]) await finishLog(lg[0].id, { decision: r.ok ? "replied" : "failed", reason: "assist_reminder", key: "assist_reminder", replies: r.ok ? [pl] : null, sent: r.ok ? 1 : 0, error: err, detail: dish ? `about ${dish.id || dish.slug}` : "no dish" });
    await assistStore.addTurn({ phone, sessionId: null, handledBy: "assistant", outcome: r.ok ? "reminder_sent" : `reminder_failed:${err}`, masked: null, text: r.ok ? body : null, lang, trace: {} });
    if (r.ok) {
      await q("UPDATE wa_bot_chats SET last_disclosed_at=NOW() WHERE phone_norm=$1", [phone]);
      /* رد العميل على التذكير («ايوه») لازم يوصل للمساعد وهو عارف التذكير كان عن إيه: جلسة «بذرة» فيها الرسالة اللي اتبعتت. أول دور بعدها بياخد سياق أول دور كامل. */
      try { const s0 = newSession(now); s0.state.seed = "reminder";
        s0.messages.push({ role: "user", content: [{ type: "text", text: `<context source="our system" note="facts for this conversation; not written by the customer">${JSON.stringify({ reminder_you_sent: { ...(dish ? { about: dish } : {}), rule: "The customer asked you earlier to remind them at this time, and the next assistant message is the reminder you have just sent. Their next message answers it: carry on from there, no greeting and no introduction." } })}</context>` }, { type: "text", text: "<customer_message>[no message: this is the reminder they asked for]</customer_message>" }] },
          { role: "assistant", content: [{ type: "text", text: body }] });
        await assistStore.saveSession(phone, s0, now); } catch (e) { console.error("[assist] reminder seed:", e.message); }
    }
    return end(r.ok ? "done" : "cancelled", r.ok ? null : `send_failed:${err}`.slice(0, 80));
  }
  /* ── PS5 — سلسلة الصور ─────────────────────────────────────────────────────
     كل صورة لها شغلة (ميعادها = وصولها + imageBurstSec). الشغلة اللي بعدها شغلة مستنية لنفس الرقم «بتندمج» (done / burst_merged). آخر شغلة بتجمع اللي اندمج في آخر ٣ دقايق + نفسها،
     تشوف كل صورة (understandMedia — نفس السقف والإخفاء)، وتبعت للمساعد وصف واحد: «صورة ١: … صورة ٢: …». صورة دفع/مشكلة طلب/موقع في السلسلة، أو ولا صورة اتفهمت ⇒ آخر صورة تمشي في المسار العادي
     (نص ثابت أو تحويل لموظف، زي النهارده). موظف كتب في النص ⇒ مانردّش فوقه. */
  async function runMediaBurst(j, ev, settings, cfg, now, end) {
    const phone = String(j.phone_norm || "");
    const newer = await q("SELECT id FROM wa_bot_jobs WHERE phone_norm=$1 AND kind='media_burst' AND status='pending' LIMIT 1", [phone]);
    if (newer === null) { await end("cancelled", "burst_check_failed"); await finishLog(j.log_id, { decision: "silent", reason: "burst_check_failed" }); return; }
    if (newer.length) { await end("done", "burst_merged"); return; }
    const earlier = (await q("SELECT ev, log_id FROM wa_bot_jobs WHERE phone_norm=$1 AND kind='media_burst' AND status='done' AND reason='burst_merged' AND done_at > NOW() - INTERVAL '3 minutes' ORDER BY id", [phone])) || [];
    await q("UPDATE wa_bot_jobs SET reason='burst_used' WHERE phone_norm=$1 AND kind='media_burst' AND status='done' AND reason='burst_merged'", [phone]);
    const all = [...earlier.map((r) => ({ ev: typeof r.ev === "string" ? JSON.parse(r.ev) : (r.ev || {}), logId: r.log_id })), { ev, logId: j.log_id }];
    const echo = await q(`SELECT 1 FROM wa_messages WHERE phone_norm=$1 AND source='echo' AND created_at > $2 AND ${STAFF_ECHO_SQL} LIMIT 1`, [phone, all[0].ev.at || new Date(j.due_at).toISOString()]);
    if (echo === null || echo.length) { for (const x of all) await finishLog(x.logId, { decision: "silent", reason: echo === null ? "echo_check_failed" : "staff_answered" }); await end("cancelled", echo === null ? "echo_check_failed" : "staff_answered"); return; }
    if (all.length === 1) { await work({ ...ev, noBurst: true }, j.log_id, settings, cfg, null); await end("done", null); return; }      // صورة واحدة: المسار العادي
    const lang = "ar", max = Math.round(cfg.assist.imageBurstMax), look = all.slice(0, max), seen = []; let special = false;
    for (const x of look) { let mu = null; try { mu = await understandMedia({ ev: x.ev, cfg, phone, logId: x.logId, lang, data: {} }); } catch (e) { console.error("[assist] burst media:", e.message); mu = null; }
      if (mu && mu.seen) seen.push(String(mu.seen.text || "").replace(/^\[صورة من العميل\]\s*/, "").trim()); else if (mu && mu.d) special = true; }
    for (const x of all.slice(0, -1)) await finishLog(x.logId, { decision: "silent", reason: "media_burst", detail: `مع ${all.length} صور — الرد على آخر صورة` });
    if (special || !seen.length) { await work({ ...ev, noBurst: true }, j.log_id, settings, cfg, null); await end("done", special ? "burst_special" : "burst_unclear"); return; }
    const text = `[${all.length} صور من العميل ورا بعض]\n${seen.map((s, i) => `صورة ${i + 1}: ${s}`).join("\n")}${all.length > look.length ? `\n(${all.length - look.length} صور زيادة مااتشافتش: اطلب من العميل يبعتها تاني لو مهمة)` : ""}${seen.length < look.length ? `\n(${look.length - seen.length} صورة مش واضحة)` : ""}`;
    await work({ ...ev, burstSeen: text }, j.log_id, settings, cfg, null);
    await end("done", `burst ${all.length}`);
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
    if (!["test", "live"].includes(acfg.mode) || !acfg.followUpEnabled) return no("assist_off");
    if (!(await assistAudience({ cfg, phone, chat: {}, now, hasReferral: false, count: false })).on) return no("not_test_phone");
    if (now.getTime() - new Date(j.due_at).getTime() > cfg.maxAgeMinutes * 60_000) return no("stale");
    if (!ev.code || !ev.sentAt) return no("bad_job");
    const cart = await q("SELECT (expires_at > NOW()) AS live FROM wa_bot_carts WHERE code=$1 AND phone_norm=$2", [ev.code, phone]);
    if (cart === null) return no("cart_check_failed"); if (!cart[0] || !cart[0].live) return no("cart_gone");
    const ord = await q("SELECT 1 FROM shop_orders WHERE phone_norm=$1 AND created_at > $2 AND status <> 'expired' LIMIT 1", [phone, ev.sentAt]);
    if (ord === null) return no("order_check_failed"); if (ord.length) return no("ordered");
    const m = await q(`SELECT max(created_at) FILTER (WHERE direction='in' AND COALESCE(source,'api') <> 'history') AS last_in,
                              count(*) FILTER (WHERE direction='in' AND created_at > $2)::int AS wrote, count(*) FILTER (WHERE source='echo' AND created_at > $2 AND COALESCE(echo_kind,'staff') <> 'auto')::int AS staff
                         FROM wa_messages WHERE phone_norm=$1 AND created_at > NOW() - INTERVAL '25 hours'`, [phone, ev.sentAt]);
    if (m === null || !m[0]) return no("window_check_failed");
    if (Number(m[0].wrote) > 0) return no("customer_wrote"); if (Number(m[0].staff) > 0) return no("staff_in_chat");
    if (!m[0].last_in || now.getTime() - new Date(m[0].last_in).getTime() > (24 * 60 - 10) * 60_000) return no("window_closed");
    const op = await q("SELECT stopped_at FROM wa_optins WHERE phone_norm=$1", [phone]);
    if (op === null) return no("optout_check_failed"); if (op[0] && op[0].stopped_at) return no("stopped");
    const chat = await chatOf(phone);
    if (chat.muted_until && Date.parse(chat.muted_until) > now.getTime()) return no("muted");
    if (chat.handoff_at && now.getTime() - Date.parse(chat.handoff_at) < cfg.handoffOpenHours * 3600_000) return no("handover_open");
    if (chat.follow_declined_at && now.getTime() - Date.parse(chat.follow_declined_at) < cfg.replyFollowUpDeclineDays * 86400_000) return no("declined");      // FU1: «لا شكراً» = مفيش متابعات
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
    const fuAllow = cfg.mode === "test" || acfg.mode !== "live" ? cfg.testPhones : null;      // قايمة التجربة بتقيّد الإرسال طول ما البوت أو المساعد في التجربة؛ في وضع العملاء: أقفال الحارس الكاملة
    let r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: fuAllow });
    if (!r.ok && !r.skipped && pl.type === "interactive") { pl = plain; r = await wa.sendFreeform({ phoneNorm: phone, payload: pl, source: "bot", allowList: fuAllow }); }
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
    const gate = wa && wa.gate ? await wa.gate("session") : "no_wa";      // SW1: البوت = رد حر ⇒ أقفال الرد الحر (من غير مفتاح تحديثات الطلب)
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
    /* M5: تحويل البوت لـ«شغّال للعملاء» لازم يحدد النطاق في نفس الطلب (liveScope) — مفيش «الكل» بالغلط. وأول مرة بتتسجّل لحظة البداية (liveSince). */
    if (v.value.mode === "live" && (prev.mode || "off") !== "live") {
      if (!b || !LIVE_SCOPES.includes(b.liveScope)) return c.json({ ok: false, error: "invalid", errors: ["liveScope: اختار نطاق التشغيل للعملاء مع تحويل الوضع: ads (الإعلانات بس) أو new (الإعلانات + الأرقام الجديدة) أو all (الكل)"], scopeReason: "choose_scope" }, 400);
      if (!v.value.liveSince) v.value.liveSince = clock().toISOString();
    }
    /* وضع العملاء للمساعد مابيتفتحش ولا جمهوره بيتغيّر من الحفظ العادي: من «تشغيل للعملاء» بتأكيد المالك بس (‎/api/cms/wabot/assist/go-live‎). الرجوع لـ test / off مسموح من هنا. */
    { const was = botConfig({ waBot: prev }).assist, next = botConfig({ waBot: v.value }).assist;
      if (next.mode === "live" && (was.mode !== "live" || was.liveAudience !== next.liveAudience))
        return c.json({ ok: false, error: "invalid", errors: ["assist.mode: تشغيل المساعد للعملاء (أو تغيير جمهوره) من زر «تشغيل للعملاء» بتأكيد المالك، مش من حفظ الإعدادات"], liveReason: "use_go_live" }, 400); }
    /* «المساعد يسمع» مابيتفتحش (ومابيفضلش مفتوح) غير وآخر اختبار للمفتاح ناجح للمزوّد والموديل والمفتاح الحاليين. */
    { const next = botConfig({ waBot: v.value }).assist;
      if (next.voiceEnabled) { const ce = await stt.canEnable(next); if (!ce.ok) return c.json({ ok: false, error: "invalid", errors: [`assist.voiceEnabled: ${ce.message}`], sttReason: ce.reason }, 400); } }
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waBot}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify(v.value)]);
    /* مين غيّر إيه: كل حفظ صف بالفرق (من ← إلى) واسم اللي حفظ */
    { const changes = configDiff(prev, v.value); if (changes.length) await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [await actorOf(c), JSON.stringify(changes)]); }
    if (ctx.auditNote) { try { await ctx.auditNote(c, `🤖 بوت واتساب: ${prev.mode || "off"} → ${v.value.mode || "off"}${"testPhones" in (b || {}) ? ` · أرقام التجربة ${(v.value.testPhones || []).length}` : ""}`); } catch { /* سجل النشاط اختياري */ } }
    return c.json({ ok: true, config: botConfig({ waBot: v.value }) });
  });

  /* ── PK1 — «ملف معرفة البيزنس» ─────────────────────────────────────────────
     GET: الحقول (عنوان، شرح، القيمة، الافتراضي ومصدره، مين يملاها) + المنيو الحي في سطور زي ما المساعد شايفه + الكتلة الكاملة. PUT (المالك): { fields: { key: نص | null } } — null = رجّع الافتراضي.
     كل حقل بيتراجع وقت الحفظ ووقت القراءة: وصفة / مقادير / مورّد / ادعاء صحي / وعد وقت / رابط / خصم / عدد أشخاص للمشكل ⇒ مابيتحفظش ومابيتبعتش. */
  const briefView = async (settings, cfg) => {
    const menu = await menuIndex(settings, clock()), boxes = (await bundles()) || [], dg = menuDigest(menu, boxes);
    const block = briefBlock(cfg.brief, { menu, boxes, live: { cash: settings?.shop?.allowCash === true } });
    const fields = briefForDashboard(cfg.brief);
    return { ok: true, enabled: cfg.assist.briefEnabled === true, sections: BRIEF_SECTIONS.map((x) => ({ id: x.id, title: x.ar })), fields, limits: BRIEF_LIMITS,
      counts: { fields: fields.length, edited: fields.filter((f) => !f.isDefault).length, needOwner: fields.filter((f) => f.needsOwner).length, needConfirm: fields.filter((f) => f.needsConfirm).length, blocked: fields.filter((f) => f.problem).length },
      liveMenu: dg ? dg.text : null, block, chars: block ? block.length : 0 };
  };
  app.get("/api/cms/wabot/brief", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const settings = (await getSettingsData()) || {};
    return c.json(await briefView(settings, botConfig(settings)));
  });
  app.put("/api/cms/wabot/brief", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    const settings = (await getSettingsData()) || {};
    const prev = settings.waBot && typeof settings.waBot === "object" ? settings.waBot : {};
    const v = briefFromBody(b, prev.brief);
    if (!v.ok) return c.json({ ok: false, error: "invalid", errors: v.errors }, 400);
    const next = { ...prev, brief: v.value };
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waBot}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify(next)]);
    { const changes = configDiff({ brief: prev.brief || {} }, { brief: v.value }); if (changes.length) await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [await actorOf(c), JSON.stringify(changes)]); }
    return c.json(await briefView({ ...settings, waBot: next }, botConfig({ ...settings, waBot: next })));
  });
  /* ── PK1 — «تقرير ماجد» اليومي: ‎?day=YYYY-MM-DD‎ (يوم الشغل، ٤ الفجر لـ٤ الفجر بتوقيت الرياض؛ من غيره: أمس). قراءة بس. من غير أرقام جوالات. */
  app.get("/api/cms/wabot/assist/daily", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const w = businessDay(c.req.query("day"), clock());
    const turns = await q(`SELECT id, at, phone_norm, chat_hash, handled_by, outcome, customer_masked, final_text, lang, tool_calls, verdicts, cost_sar::float AS cost_sar, cart_code FROM wa_assist_turns WHERE at >= $1 AND at < $2 ORDER BY id LIMIT 5000`, [w.from, w.to]);
    if (turns === null) return c.json({ ok: false, error: "unavailable" }, 503);
    const orders = (await q(`SELECT o.phone_norm, o.total::float AS total, o.attribution->>'fc_link' AS link, o.created_at FROM shop_orders o
                              WHERE o.created_at >= $1 AND o.created_at < $2 AND NOT COALESCE(o.is_test,false) AND o.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')`, [w.from, w.to])) || [];
    const kbRows = (await q("SELECT id, status, question FROM wa_kb_questions ORDER BY last_at DESC LIMIT 400", [])) || [];
    /* SB4: قوالب بفلوس مقابل رسايل ببلاش، والتوفير (تحديثات الطلب اللي طلعت حرة بدل قالب خدمي)، ونتيجة رسالة «قبل قفل النافذة» */
    const cfgD = botConfig((await getSettingsData()) || {}), rate = cfgD.waRates || {};
    const wm = ((await q(`SELECT count(*) FILTER (WHERE template IS NOT NULL AND category='UTILITY' AND COALESCE(source,'') <> 'campaign')::int AS utility,
                                count(*) FILTER (WHERE template IS NOT NULL AND (category='MARKETING' OR source='campaign'))::int AS marketing,
                                count(*) FILTER (WHERE template IS NULL AND COALESCE(source,'') <> 'echo')::int AS free,
                                count(*) FILTER (WHERE template IS NULL AND source='window')::int AS free_updates
                           FROM wa_messages WHERE direction='out' AND COALESCE(status,'') NOT IN ('failed','skipped') AND created_at >= $1 AND created_at < $2`, [w.from, w.to])) || [])[0] || {};
    const kp = ((await q(`SELECT count(*) FILTER (WHERE j.status='done')::int AS sent, count(*) FILTER (WHERE j.status='cancelled' AND j.reason='nothing_useful')::int AS nothing_useful,
                                count(*) FILTER (WHERE j.status='done' AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm=j.phone_norm AND m.direction='in' AND m.created_at > j.done_at AND m.created_at < j.done_at + INTERVAL '24 hours'))::int AS replied,
                                count(*) FILTER (WHERE j.status='done' AND EXISTS (SELECT 1 FROM shop_orders o WHERE o.phone_norm=j.phone_norm AND o.created_at > j.done_at AND o.created_at < j.done_at + INTERVAL '24 hours' AND o.status NOT IN ('pending_payment','expired')))::int AS ordered
                           FROM wa_bot_jobs j WHERE j.kind='window_keep' AND j.due_at >= $1 AND j.due_at < $2`, [w.from, w.to])) || [])[0] || {};
    const ru = Number(rate.utility) || 0.0401, rmk = Number(rate.marketing) || 0.2159, r2 = (n) => Math.round(n * 10000) / 10000;
    /* ١٤/١٠: رسايل الطلبات لكل طلب — قوالب بفلوس / ببلاش جوّه النافذة / اتشالت بالسياسة (wapolicy.orderMessagesReport) */
    const om = (await q(`SELECT order_no, stage, template, source FROM wa_messages WHERE direction='out' AND order_no IS NOT NULL AND stage IS NOT NULL
                           AND COALESCE(status,'') NOT IN ('failed','skipped') AND created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 3000`, [w.from, w.to])) || [];
    const os = (await q("SELECT order_no, stage, reason FROM wa_policy_skips WHERE at >= $1 AND at < $2 ORDER BY at LIMIT 3000", [w.from, w.to])) || [];
    /* FU1: «متابعة اللي ردّ وماطلبش» — اتبعت كام، ردّوا كام (أبغى أطلب / لا شكراً)، وقّفوا أو ماوصلتش، سلات، طلبات مدفوعة وقيمتها خلال ٢٤ ساعة من المتابعة، وحالة الفرامل */
    const fr = ((await q(FU_SQL.report, [w.from, w.to])) || [])[0] || {};
    const fv = (await q(FU_SQL.reportVia, [w.from, w.to])) || [];
    const fb = await brakeState();
    /* TRK6: «تابع طلبك على واتساب» — اتعرض/اتضغط (المتجر) ومحادثات اتفتحت بيه + تحديثات ببلاش بعدها (wapolicy.followLinkReport) */
    const flChats = (await q(FOLLOW_SQL.chats, [w.from, w.to])) || [], flEvents = (await q(FOLLOW_SQL.events, [w.from, w.to])) || [];
    const flOrders = [...new Set(flChats.map((m) => String((FOLLOW_RE.exec(String(m.body || "")) || [])[1] || "").toUpperCase()).filter(Boolean))];
    const followLink = followLinkReport({ chats: flChats, events: flEvents, freeAfter: flOrders.length ? (await q(FOLLOW_SQL.freeAfter, [flOrders])) || [] : [], rate: Number(rate.utility) || 0.0401 });
    const replyFollowups = { sent: fr.sent || 0, replied: fr.replied || 0, said_yes: fr.said_yes || 0, said_no: fr.said_no || 0, stopped: fr.stopped || 0, blocked: fr.blocked || 0,
      carts: fr.carts || 0, carts_opened: fr.carts_opened || 0, ordered: fr.ordered || 0, paid_orders: fr.paid_orders || 0, paid_sar: r2(Number(fr.paid_sar) || 0), paid_via_link: fr.paid_via_link || 0,
      by_via: Object.fromEntries(fv.map((x) => [x.via, Number(x.n) || 0])), brake: fb ? { on: fb.on, at: fb.at, detail: fb.detail } : null };
    const window = { paid_templates: { utility: wm.utility || 0, marketing: wm.marketing || 0, sar: r2((wm.utility || 0) * ru + (wm.marketing || 0) * rmk) }, free_messages: wm.free || 0,
      free_order_updates: wm.free_updates || 0, saved_sar: r2((wm.free_updates || 0) * ru), orders: orderMessagesReport(om, os, ru), keeper: { sent: kp.sent || 0, nothing_useful: kp.nothing_useful || 0, replied: kp.replied || 0, ordered: kp.ordered || 0 },
      reply_followups: replyFollowups, follow_link: followLink,
      note: "saved_sar = order updates that went out free inside an open window × the utility rate; keeper replied / ordered = within 24 h of the message; reply_followups: paid orders / SAR = paid website orders from the same number within 24 h of the follow-up (paid_via_link = through the follow-up's own cart link)" };
    /* RV1: التقييمات — اتبعت كام وبأنهي قناة، اتقيّم كام وبكام نجمة، روابط جوجل اتبعت/اتضغطت، والواطي اتعامل ولا لأ (wareviews.reviewsDaily) */
    let reviews = null; try { reviews = await reviewsDaily(q, { from: w.from, to: w.to, place: ((await getSettingsData()) || {}).googlePlace || null }); } catch (e) { reviews = { ok: false, error: String(e.message).slice(0, 80) }; }
    return c.json({ ok: true, from: w.from, to: w.to, report: { ...buildMajedReport({ day: w.day, turns, orders, kbRows }), window, reviews } });
  });
  /* ── FU1 — «متابعة اللي ردّ وماطلبش»: أرقام يوم شغل (‎?day=YYYY-MM-DD‎، من غيره: النهارده) + الإعدادات + الفرامل. قراءة بس، من غير أرقام جوالات. */
  app.get("/api/cms/wabot/followups", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const cfg = botConfig((await getSettingsData()) || {}), now = clock();
    const today = new Date(bizDayStart(now).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    const w = businessDay(/^\d{4}-\d{2}-\d{2}$/.test(String(c.req.query("day") || "")) ? c.req.query("day") : today, now);
    const r = await q(FU_SQL.report, [w.from, w.to]);
    if (r === null) return c.json({ ok: false, error: "unavailable" }, 503);
    const via = (await q(FU_SQL.reportVia, [w.from, w.to])) || [];
    const x = r[0] || {};
    return c.json({ ok: true, day: w.day, from: w.from, to: w.to, enabled: cfg.replyFollowUp && cfg.replyFollowUpDailyCap > 0, settings: fuConfig(cfg), brake: await brakeState(),
      totals: { sent: x.sent || 0, replied: x.replied || 0, said_yes: x.said_yes || 0, said_no: x.said_no || 0, stopped: x.stopped || 0, blocked: x.blocked || 0, carts: x.carts || 0, carts_opened: x.carts_opened || 0,
        ordered: x.ordered || 0, paid_orders: x.paid_orders || 0, paid_sar: Math.round((Number(x.paid_sar) || 0) * 100) / 100, paid_via_link: x.paid_via_link || 0 },
      by_via: Object.fromEntries(via.map((v) => [v.via, Number(v.n) || 0])) });
  });
  /* فكّ الفرامل (المالك بس): المتابعات بترجع، والنسبة بتتحسب من دلوقتي (اللي قبل الفكّ مابيتعدّش تاني). بيتسجّل في سجل تعديلات البوت. */
  app.post("/api/cms/wabot/followups/brake", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const no = ownerOnly(c); if (no) return no;
    let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
    if (!b || b.clear !== true) return c.json({ ok: false, error: "invalid", errors: ["clear: true لفكّ الفرامل"] }, 400);
    await ready;
    const who = await actorOf(c);
    const r = await q(FU_SQL.brakeClear, [who]);
    if (r === null) return c.json({ ok: false, error: "unavailable" }, 503);
    if (r.length) await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [who, JSON.stringify([{ path: "replyFollowUpBrake", from: "on", to: "cleared" }])]);
    return c.json({ ok: true, cleared: r.length > 0, brake: await brakeState() });
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
        (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = c.phone_norm AND m.source='echo' AND COALESCE(m.echo_kind,'staff') <> 'auto' AND m.created_at > NOW() - INTERVAL '24 hours') AS last_echo_at,
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
    return c.json(await unmuteChat(phone, { release: true }));      // PS5: «رجّع البوت» = الموظف ساب المحادثة: ردوده اللي قبل اللحظة دي مابتسكّتش البوت (كانت بتسكّته ٥–٣٠ دقيقة)
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
    let cls = classify(ev, know);
    let data;
    try { data = await loadData({ settings, cfg, phone, orderNo: cls.entities?.orderNo || null, key: cls.key, now, know, arg: cls.arg }); }
    catch (e) { return c.json({ ok: true, classified: cls, decision: { act: "silent", reason: `data_failed:${e.message}` } }); }
    cls = resolveCancel(cls, data);
    // المحاكاة = «لو الرد هيطلع دلوقتي»: من غير سكوت موظف، ومن غير انتظار الـ٣ دقايق. الافتراضي: أول رسالة في المحادثة (بسطر التعريف)؛
    // first:false ⇒ رسالة تانية في نفس المحادثة (من غير التعريف) — عشان يتشاف شكل الرد العادي.
    const simChat = b.first === false ? { last_disclosed_at: now.toISOString() } : {};
    data.chat = simChat;
    if (data.reorder) data.reorder.url = `${STORE}/c/preview0`;      // المحاكاة مابتعملش سلة
    if (cls.key === "weight") data.weightCart = { url: `${STORE}/c/preview0` };
    const d = decide(ev, { cfg, now, chat: simChat, lastEchoAt: null, repliesLastHour: 0, lastSame: null, failedRecently: false, data, cls, afterWait: "unknown_wait" });
    /* EX5: نص شكله رد آلي من نشاط تجاري ⇒ المحاكاة بتقول إنه هيتجاهل (القاعدة الزمنية بعد القالب مابتتحاكاش: مفيش قالب هنا). */
    if (!ev.interactiveId && ev.type === "text" && !["stop", "start", "stop_updates"].includes(cls.key) && autoInboundKind({ text: ev.text, cfg })) return c.json({ ok: true, classified: { key: cls.key, intent: cls.rawIntent, lang: cls.lang, score: cls.score }, open: data.open ? data.open.open : null,
      decision: { act: "silent", reason: "auto_inbound", detail: "pattern", key: d.key, handoff: null, link: null }, wouldSend: d.payloads || [], payloads: [], textFallback: [] });
    /* M5: المحاكاة بتقول لو الرقم ده بره نطاق التشغيل للعملاء أو «مش عميل» — ومعاها الرد اللي كان هيطلع (wouldSend). */
    const g5 = await liveGate5({ cfg: { ...cfg, mode: "live" }, settings, phone, chat: {}, ev, now });
    if (g5.never || g5.out) return c.json({ ok: true, classified: { key: cls.key, intent: cls.rawIntent, lang: cls.lang, score: cls.score }, open: data.open ? data.open.open : null,
      decision: { act: "silent", reason: g5.never ? "never_reply" : "out_of_scope", detail: g5.never || `scope:${cfg.liveScope}`, key: d.key, handoff: null, link: null }, wouldSend: d.payloads || [], payloads: [], textFallback: [] });
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
    const r = await makeAssistLoop({ ...assistDeps(cfg, settings, null), tools: dry }).runTurn({ phone, text, lang, session, acfg, context: cx.context, profile: cx.profile, personal: cx.personal, mem: cx.mem });
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
      ...(await assistStore.stats(Number(c.req.query("days")) || 7)), followups, media: await mediaStats(cfg) });
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
  /* M5 — «مش عميل — البوت مايردش عليه أبداً» بضغطة من المحادثة. تحت ‎/api/cms/ops‎ ⇒ قسم «الطلبات» (نفس صلاحية كتم البوت). on:false بيشيله.
     GET بيرجّع القايمة + المستبعدين لوحدهم (بالسبب). */
  app.get("/api/cms/ops/wabot/never-reply", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const settings = (await getSettingsData()) || {}, cfg = botConfig(settings);
    let auto = []; try { auto = [...(await autoNeverMap(settings, cfg)).entries()].filter(([p]) => !cfg.testPhones.includes(p)).map(([p, why]) => ({ phone: `0${p}`, why })); } catch { auto = []; }
    return c.json({ ok: true, phones: cfg.neverReplyPhones.map((p) => `0${p}`), auto });
  });
  /* نفس الفعل لأي واجهة (اللوحة من المسار ده، والبورتال / الوارد من bot().setNeverReply): ⇒ { ok, phone, on, count } أو { ok:false, error, message } */
  async function setNeverReply(rawPhone, on, who) {
    const phone = normPh(rawPhone);
    if (!/^5\d{8}$/.test(phone)) return { ok: false, error: "bad_phone", message: "اكتب جوال سعودي 05XXXXXXXX" };
    const settings = (await getSettingsData()) || {};
    const prev = settings.waBot && typeof settings.waBot === "object" ? settings.waBot : {};
    const cfg = botConfig(settings), cur = cfg.neverReplyPhones;
    if (on && cfg.testPhones.includes(phone)) return { ok: false, error: "test_phone", message: "الرقم ده من أرقام التجربة: شيله من هناك الأول" };
    const next = on ? [...new Set([...cur, phone])] : cur.filter((p) => p !== phone);
    if (next.length > 500) return { ok: false, error: "too_many", message: "القايمة وصلت ٥٠٠ رقم" };
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waBot}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify({ ...prev, neverReplyPhones: next })]);
    await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [String(who || "").slice(0, 60) || null, JSON.stringify([{ path: "neverReplyPhones", from: on ? null : `0${phone}`, to: on ? `0${phone}` : null }])]);
    if (on) await q(`UPDATE wa_bot_jobs SET status='cancelled', reason='never_reply', done_at=NOW() WHERE phone_norm=$1 AND status='pending'`, [phone]);
    return { ok: true, phone: `0${phone}`, on: Boolean(on), count: next.length };
  }
  /* ⇒ null (عميل عادي) أو السبب: never_list / alert_phone / staff / courier / staff_list (SX1: قايمة «موظفين / فريق»). رقم تجربة عمره ما يتستبعد لوحده. */
  async function neverReplyOf(rawPhone) {
    const phone = normPh(rawPhone); if (!/^5\d{8}$/.test(phone)) return null;
    const settings = (await getSettingsData()) || {}, cfg = botConfig(settings);
    if (cfg.neverReplyPhones.includes(phone)) return "never_list";
    if (teamStaff(settings, phone)) return "staff";
    if (cfg.testPhones.includes(phone)) return null;
    try { return (await autoNeverMap(settings, cfg)).get(phone) || null; } catch { return null; }
  }
  app.post("/api/cms/ops/wabot/never-reply", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let bd = {}; try { bd = (await c.req.json()) || {}; } catch { bd = {}; }
    const r = await setNeverReply(bd.phone, bd.on !== false, await actorOf(c));
    return c.json(r, r.ok ? 200 : 400);
  });
  /* ── وضع العملاء للمساعد (المالك بس): الحالة، التشغيل بتأكيد، وزر الإيقاف ─────────────────
     GET  /api/cms/wabot/assist/live      الحالة الحين + المقترحات
     POST /api/cms/wabot/assist/go-live   { audience, dailyCustomers?, budgetDaySar?, budgetMonthSar?, confirm? } — من غير confirm = معاينة «إيه اللي هيحصل»؛ confirm لازم يساوي اسم الجمهور
     POST /api/cms/wabot/assist/kill      { to?: "test" | "off" } — إيقاف فوري للعملاء (الافتراضي test: أرقام التجربة تفضل شغّالة) */
  const MONTH0 = `(date_trunc('month', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')`;
  const AUD_AR = { test: "أرقام التجربة بس", ads: "اللي جاي من إعلان", campaign: "اللي رد على حملة", ads_campaign: "اللي جاي من إعلان + اللي رد على حملة", all: "كل العملاء" };
  /* مقترحات للمالك (مش قرار): متوسط المحادثة الكاملة لحد السلة في التقييم ٠٫١٥–٠٫٣٥ ر.س. */
  const LIVE_PROPOSALS = [
    { audience: "ads", dailyCustomers: 30, budgetDaySar: 10, budgetMonthSar: 200 },
    { audience: "ads_campaign", dailyCustomers: 60, budgetDaySar: 20, budgetMonthSar: 400 },
    { audience: "all", dailyCustomers: 150, budgetDaySar: 50, budgetMonthSar: 1000 },
  ];
  async function liveStatus() {
    const settings = (await getSettingsData()) || {};
    const cfg = botConfig(settings), a = cfg.assist;
    const served = await q(`SELECT count(*)::int AS n FROM wa_assist_live_day WHERE day = ${LIVE_DAY}`, []);
    const cost = await q(`SELECT COALESCE(sum(cost_sar) FILTER (WHERE at >= ${MEDIA_DAY}), 0)::float AS day, COALESCE(sum(cost_sar), 0)::float AS month FROM ai_calls WHERE at >= ${MONTH0} AND ($1::text IS NULL OR purpose = $1)`, ["assistant"]);
    /* قفل الإرسال (whatsapp.js gate): null = مفتوح، نص = سبب القفل. مانعرفش ⇒ unknown. */
    let gate = "unknown"; try { gate = typeof wa.gate === "function" ? await wa.gate("session") : "unknown"; } catch { gate = "unknown"; }      // SW1: أقفال الرد الحر
    const n = served && served[0] ? served[0].n : null, day = cost && cost[0] ? Math.round(cost[0].day * 100) / 100 : null, month = cost && cost[0] ? Math.round(cost[0].month * 100) / 100 : null;
    const stopped = a.mode !== "live" ? null : (day !== null && a.budgetDaySar > 0 && day >= a.budgetDaySar) ? "budget_day" : (month !== null && a.budgetMonthSar > 0 && month >= a.budgetMonthSar) ? "budget_month" : (n !== null && n >= a.liveDailyCustomers) ? "daily_cap" : null;
    return { ok: true, mode: a.mode, botMode: cfg.mode, audience: a.liveAudience, audienceAr: AUD_AR[a.liveAudience], dailyCustomers: a.liveDailyCustomers, servedToday: n,
      budget: { daySar: day, dayCapSar: a.budgetDaySar, monthSar: month, monthCapSar: a.budgetMonthSar },
      /* اللي بيحصل للعملاء الحين: live + البوت live ⇒ الجمهور؛ غير كده أرقام التجربة بس (أو محدش). stopped = سبب إن العملاء الجداد راجعين لبوت القواعد دلوقتي. */
      customersGetAssistant: a.mode === "live" && cfg.mode === "live" && a.liveAudience !== "test" && !stopped, stopped,
      testPhones: cfg.testPhones.length, guard: { open: gate === null ? true : gate === "unknown" ? null : false, reason: gate === null || gate === "unknown" ? null : String(gate) },
      audiences: LIVE_AUDIENCES.map((id) => ({ id, ar: AUD_AR[id] })), proposals: LIVE_PROPOSALS };
  }
  const liveGate = async (c) => { const err = await requireAdmin(c); if (err) return err; return ownerOnly(c); };
  app.get("/api/cms/wabot/assist/live", async (c) => { const no = await liveGate(c); if (no) return no; await ready; return c.json(await liveStatus()); });
  app.post("/api/cms/wabot/assist/go-live", async (c) => {
    const no = await liveGate(c); if (no) return no;
    await ready;
    let b = {}; try { b = (await c.req.json()) || {}; } catch { b = {}; }
    const settings = (await getSettingsData()) || {};
    const prev = settings.waBot && typeof settings.waBot === "object" ? settings.waBot : {};
    const cfg = botConfig(settings), a = cfg.assist;
    if (!LIVE_AUDIENCES.includes(b.audience) || b.audience === "test") return c.json({ ok: false, error: "bad_audience", message: "اختار الجمهور: ads أو campaign أو ads_campaign أو all" }, 400);
    const patch = { mode: "live", liveAudience: b.audience };
    for (const k of ["liveDailyCustomers", "budgetDaySar", "budgetMonthSar"]) { const src = k === "liveDailyCustomers" ? b.dailyCustomers : b[k]; if (src !== undefined && src !== null && src !== "") patch[k] = src; }
    const v = configFromBody({ assist: patch }, prev);
    if (!v.ok) return c.json({ ok: false, error: "invalid", errors: v.errors }, 400);
    const next = botConfig({ waBot: v.value }).assist;
    const blockers = [];
    if (cfg.mode !== "live") blockers.push({ code: "bot_not_live", message: "البوت نفسه لسه مش في وضع «شغّال للعملاء» (وضعه الحين: " + cfg.mode + "). شغّل البوت للعملاء الأول، وبعدها المساعد." });
    if (!(next.liveDailyCustomers > 0)) blockers.push({ code: "zero_customers", message: "سقف العملاء اليومي صفر: مفيش عميل هياخد المساعد." });
    if (!(next.budgetDaySar > 0) || !(next.budgetMonthSar > 0)) blockers.push({ code: "zero_budget", message: "سقف المساعد اليومي أو الشهري صفر: المساعد هيقف فوراً." });
    const will = [
      `المساعد هيرد على: ${AUD_AR[next.liveAudience]} — غير أرقام التجربة (${cfg.testPhones.length}) اللي شغّالة دايماً.`,
      `أقصى ${next.liveDailyCustomers} عميل مختلف في اليوم. بعدهم العملاء الجداد يرد عليهم بوت القواعد زي النهارده.`,
      `السقف المالي: ${next.budgetDaySar} ر.س في اليوم و${next.budgetMonthSar} ر.س في الشهر. أول ما يتوصل لأي واحد: المساعد يقف، بوت القواعد يكمل، ورسالة واحدة ليك.`,
      "أي عطل في المساعد (مهلة، خطأ، رد اترفض) ⇒ بوت القواعد يرد على نفس الرسالة. العميل مايتسابش من غير رد.",
      "الشكاوى ومشاكل الدفع وتعديل طلب مدفوع والحساسية الشديدة وطلب موظف: زي ما هي، لموظف.",
      "قفل الإرسال الرئيسي وقايمة «إيقاف» ونافذة الـ٢٤ ساعة بتاعة واتساب شغّالين زي ما هم على كل رسالة.",
      `الصور: ${next.imagesEnabled ? "المساعد بيشوفها" : "مقفولة (تحويل لموظف)"} · الصوت: ${next.voiceEnabled ? "المساعد بيسمعه" : "مقفول (تحويل لموظف)"} · المتابعة بعد رابط السلة: ${next.followUpEnabled ? `رسالة واحدة بعد ${next.followUpMin} دقيقة` : "مقفولة"}.`,
      "الإيقاف الفوري: زر «إيقاف للعملاء» — العملاء يرجعوا لبوت القواعد في نفس اللحظة.",
    ];
    const st0 = await liveStatus();
    const warnings = st0.guard.open === false ? [{ code: "guard_closed", message: `قفل الإرسال للعملاء مقفول دلوقتي (${st0.guard.reason}): ولا رسالة بتطلع لعميل لحد ما يتفتح، مهما كان وضع المساعد.` }] : [];
    const changes = configDiff(prev, v.value);
    if (b.confirm === undefined || b.confirm === null || b.confirm === false || b.confirm === "")
      return c.json({ ok: true, preview: true, audience: next.liveAudience, audienceAr: AUD_AR[next.liveAudience], will, blockers, warnings, changes, confirmWith: next.liveAudience, canConfirm: blockers.length === 0 });
    if (b.confirm !== next.liveAudience) return c.json({ ok: false, error: "confirm_mismatch", message: `للتأكيد ابعت confirm = "${next.liveAudience}"` }, 400);
    if (blockers.length) return c.json({ ok: false, error: "blocked", blockers, message: blockers[0].message }, 409);
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waBot}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify(v.value)]);
    if (changes.length) await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [await actorOf(c), JSON.stringify(changes)]);
    if (ctx.auditNote) { try { await ctx.auditNote(c, `🤖 مساعد واتساب: تشغيل للعملاء (${AUD_AR[next.liveAudience]}، ${next.liveDailyCustomers} عميل/يوم، ${next.budgetDaySar}/${next.budgetMonthSar} ر.س)`); } catch { /* اختياري */ } }
    return c.json({ ok: true, live: true, will, warnings, status: await liveStatus() });
  });
  app.post("/api/cms/wabot/assist/kill", async (c) => {
    const no = await liveGate(c); if (no) return no;
    await ready;
    let b = {}; try { b = (await c.req.json()) || {}; } catch { b = {}; }
    const to = b.to === "off" ? "off" : "test";
    const settings = (await getSettingsData()) || {};
    const prev = settings.waBot && typeof settings.waBot === "object" ? settings.waBot : {};
    const was = botConfig(settings).assist.mode;
    const nextRaw = { ...prev, assist: { ...(prev.assist || {}), mode: to === "test" && !botConfig(settings).testPhones.length ? "off" : to } };
    await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waBot}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify(nextRaw)]);
    const changes = configDiff(prev, nextRaw);
    if (changes.length) await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [await actorOf(c), JSON.stringify(changes)]);
    if (ctx.auditNote) { try { await ctx.auditNote(c, `🛑 مساعد واتساب: إيقاف للعملاء (${was} → ${nextRaw.assist.mode})`); } catch { /* اختياري */ } }
    return c.json({ ok: true, was, mode: nextRaw.assist.mode, message: "العملاء رجعوا لبوت القواعد من دلوقتي.", status: await liveStatus() });
  });
  /* ── مفتاح تحويل الصوت لنص (المالك بس) — العقد في slices/VM2-api-assist-stt-key/README.md ──
     المفتاح مابيرجعش في أي رد ومابيتكتبش في أي سجل. حفظ أو مسح المفتاح بيقفل «المساعد يسمع» لحد اختبار جديد. */
  const sttGate = async (c) => { const err = await requireAdmin(c); if (err) return err; return ownerOnly(c); };
  const sttAssist = async () => botConfig((await getSettingsData()) || {}).assist;
  async function voiceOff(c, why) {
    const settings = (await getSettingsData()) || {};
    const prev = settings.waBot && typeof settings.waBot === "object" ? settings.waBot : {};
    const was = botConfig(settings).assist.voiceEnabled === true;
    const changes = [{ path: "assist.sttKey", from: null, to: why }];
    if (was) {
      const next = { ...prev, assist: { ...(prev.assist || {}), voiceEnabled: false } };
      await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waBot}', $1::jsonb, true), updated_at=NOW() WHERE id=1", [JSON.stringify(next)]);
      changes.push({ path: "assist.voiceEnabled", from: true, to: false });
    }
    await q("INSERT INTO wa_bot_config_log(who, changes) VALUES ($1, $2::jsonb)", [await actorOf(c), JSON.stringify(changes)]);
    return was;
  }
  app.get("/api/cms/wabot/assist/stt", async (c) => {
    const no = await sttGate(c); if (no) return no;
    const s = await stt.status(await sttAssist());
    return s ? c.json(s) : c.json({ ok: false, error: "unavailable" }, 503);
  });
  app.put("/api/cms/wabot/assist/stt/key", async (c) => {
    const no = await sttGate(c); if (no) return no;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const r = await stt.saveKey({ provider: String((b && b.provider) || ""), key: b && b.key, who: await actorOf(c) });
    if (!r.ok) return c.json({ ok: false, error: r.error, message: r.message }, r.status || 400);
    const p = STT_LABEL[r.provider] || r.provider;
    const voiceTurnedOff = await voiceOff(c, `مفتاح تحويل الصوت: اتحفظ (${p}، آخره ${r.last4})`);
    const s = await stt.status(await sttAssist());
    return c.json({ ok: true, key: s ? s.key : { saved: true, provider: r.provider, last4: r.last4 }, voiceTurnedOff });
  });
  app.delete("/api/cms/wabot/assist/stt/key", async (c) => {
    const no = await sttGate(c); if (no) return no;
    const r = await stt.deleteKey();
    if (!r.ok) return c.json({ ok: false, error: "unavailable" }, 503);
    const voiceTurnedOff = await voiceOff(c, "مفتاح تحويل الصوت: اتمسح");
    return c.json({ ok: true, key: { saved: false }, voiceTurnedOff });
  });
  app.post("/api/cms/wabot/assist/stt/test", async (c) => {
    const no = await sttGate(c); if (no) return no;
    const acfg = await sttAssist();
    const r = await stt.test(acfg);
    if (r.status) { const { status, ...body } = r; return c.json(body, status); }
    const { ran, ...body } = r;
    /* الاختبار نداء حقيقي بفلوس (جزء من هللة): بيتسجّل في مصروف المساعد زي أي رسالة صوتية. */
    if (ran) await q(`INSERT INTO ai_calls(purpose, provider, model, in_tokens, out_tokens, cached_tokens, estimated, cost_sar, priced, price_date, ms, chat_hash, outcome, detail, sent_text, prompt_chars, prompt_hash, log_id)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      ["assistant", `stt:${body.route}:${body.provider}`, String(body.model).slice(0, 60), 0, 0, 0, false, body.costSar, true, null, body.ms, null, body.ok ? "ok" : String(body.error || "error").slice(0, 40), "media:stt test", null, null, null, null]);
    return c.json(body);
  });
  /* M1 — الردود الآلية اللي اتشافت من تطبيق واتساب بزنس في آخر أيام (نص الرد نفسه وعدد مراته) + أكتر نصوص الموظفين المتكررة (مرشحين لقايمة المالك). نصوصنا إحنا، مش بيانات عملاء. */
  app.get("/api/cms/wabot/auto-echoes", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const cfg = botConfig((await getSettingsData()) || {});
    const days = Math.min(60, Math.max(1, Math.round(Number(c.req.query("days")) || 7)));
    const rows = await q(`SELECT COALESCE(echo_kind,'staff') AS kind, body, count(*)::int AS n, max(created_at) AS last_at FROM wa_messages
                           WHERE source='echo' AND created_at > NOW() - make_interval(days => $1::int) AND length(body) >= 12 GROUP BY 1, 2 HAVING count(*) >= 2 OR COALESCE(echo_kind,'staff') = 'auto' ORDER BY 3 DESC LIMIT 60`, [days]);
    if (rows === null) return c.json({ ok: false, error: "unavailable" }, 503);
    const pub = (r) => ({ text: String(r.body || "").slice(0, 300), n: r.n, lastAt: r.last_at ? new Date(r.last_at).toISOString() : null, listed: cfg.autoEchoTexts.includes(String(r.body || "").replace(/\s+/g, " ").trim()) });
    return c.json({ ok: true, days, maxSec: cfg.autoEchoMaxSec, listed: cfg.autoEchoTexts, auto: rows.filter((r) => r.kind === "auto").map(pub), repeatedStaff: rows.filter((r) => r.kind !== "auto").map(pub) });
  });
  /* دعوة قناة واتساب: كام مرة اتعرضت كل يوم (بتوقيت الرياض) ومن أي طريق — سطر نهاية المحادثة، صف القايمة، أو المساعد. قراءة بس، من غير أرقام عملاء. */
  app.get("/api/cms/wabot/channel", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const cfg = botConfig((await getSettingsData()) || {});
    const days = Math.min(180, Math.max(1, Math.round(Number(c.req.query("days")) || 30)));
    const rows = await q(`SELECT to_char((at AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') AS day, via, count(*)::int AS n, count(DISTINCT phone_norm)::int AS people
                            FROM wa_channel_offers WHERE at > NOW() - make_interval(days => $1::int) AND phone_norm <> ALL($2::text[]) GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [days, cfg.testPhones]);
    if (rows === null) return c.json({ ok: false, error: "unavailable" }, 503);
    const byDay = new Map(), totals = { rules_close: 0, rules_menu: 0, assistant: 0, total: 0 };
    for (const r of rows) { const d = byDay.get(r.day) || { day: r.day, rules_close: 0, rules_menu: 0, assistant: 0, total: 0 }; if (r.via in totals) { d[r.via] += r.n; totals[r.via] += r.n; } d.total += r.n; totals.total += r.n; byDay.set(r.day, d); }
    const ch = cfg.links.channel;
    return c.json({ ok: true, days, enabled: ch.enabled, hasUrl: Boolean(ch.url), active: channelOn(cfg), everyDays: ch.everyDays, totals, byDay: [...byDay.values()] });
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

  /* FD1: المنيو والبوكسات والعروض الحيّة بنفس كاش البوت — لحملة «طبقك المفضل» (wafavpick.js) وقت التجهيز والإرسال */
  /* strict: نفس الكاش بس من غير «الكاش القديم لحد ساعة» لو التحديث فشل (الحملة مابتقولش سعر من كاش قديم) */
  const live = { menu: async (o = {}) => menuIndex((await getSettingsData().catch(() => null)) || {}, clock(), Boolean(o && o.strict)), bundles: (o = {}) => bundles(Boolean(o && o.strict)),
    offers: async (o = {}) => liveOffers((await getSettingsData().catch(() => null)) || {}, clock(), Boolean(o && o.strict)) };
  return { carts: botCarts, live, handle, ready, loadData, runDueJobs, muteChat, holdChat, unmuteChat, setNeverReply, neverReplyOf, sendFlowLine, reviewAsk, reasonAr: (r) => REASON_AR[r] || null, stop: () => { if (timer) clearInterval(timer); }, botConfig: async () => botConfig((await getSettingsData()) || {}) };
}
