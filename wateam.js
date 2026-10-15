/* ═══════════════════════════════════════════════════════════════════════════
   👥 تواصل الفريق على واتساب (ST1 — ١٢/١٠، طلبات عمر بنصها):
     ١) «خلي التواصل مع الفريق يكون عن طريق الواتس»
     ٢) «خلي الموظفين دايما يضغطوا زرار عشان رسايلهم تكون مجانية… يتبعتلهم حر دايما قبل ال٢٠ ساعة ما يعدوا زرار يضغطوا عليه»
     ٣) «دايما عايز في حاجات غريبة تتبعت للمدير وللملاك»
     ٤) رد «أسرارنا» يبقى سطر مهني + رسالة للملاك والمدير بالمحادثة (في الحر)

   اللي في الملف ده:
     • دليل الفريق (settings.waTeam.members: رقم + اسم + دور cashier / manager / owner) وتوزيع المواضيع على الأدوار
       (routing): handover = كل التحويلات · urgent = التحويلات العاجلة بس · odd = «حاجات غريبة» · digest = الملخص اليومي.
     • الإرسال لموظف واحد (sendToStaff) — بالترتيب: رسالة حرة لو نافذة الـ٢٤ ساعة بتاعته مفتوحة (ببلاش) ⇒ قالب فريق UTILITY
       معتمد لو مقفولة ⇒ SMS كآخر حل (ومتسجّل إنه SMS). **كل** إرسال واتساب من هنا بيعدّي من حارس whatsapp.js
       (sendFreeform / sendStaffTemplate ⇒ guardSend ⇒ deliver). مفيش نداء Graph هنا. ومفيش أي إرسال لعميل من الملف ده:
       المستلم لازم يكون في دليل الفريق (والحارس بيتأكد بنفسه للقوالب: not_staff).
     • حارس النافذة (keeper): لكل موظف، عند الساعة ٢٠ من آخر رسالة منه ⇒ رسالة حرة بزر واحد «✅ جدّد التنبيهات» (الضغطة رسالة واردة ⇒
       النافذة بتتجدد). لو النافذة قفلت ⇒ قالب التجديد مرة واحدة وبعدها نستنى ضغطته. ساعات الهدوء (٠٢:٠٠–١٠:٠٠ الرياض افتراضياً): لو
       الساعة ٢٠ هتيجي جوّه الهدوء، التجديد بيتبعت قبل بداية الهدوء.
     • «حاجات غريبة» (odd): لكل نوع مفتاح، سقف في الساعة، ووضع ملخص (digest) بيجمّع بدل ما يبعت واحدة واحدة. الرسالة فيها مقتطف
       آخر ٦ رسايل (نص العميل مقنّع بـmaskText، والرقم آخر ٤ أرقام بس) ورابط المحادثة في اللوحة.
     • أرقام الفريق مش عملاء: الوارد منهم بيتمسك هنا (inbound) قبل البوت — ضغطة الزر وكام أمر (حالة / مساعدة / تنبيهات / ملخص)، وأي
       حاجة تانية بتتسجّل وتعدّي في صمت (مفيش ترحيب ولا بيع ولا تحويل عن نفسهم).

   الجداول: wa_team_state (حالة حارس النافذة لكل رقم) · wa_team_log (كل محاولة إرسال: القناة والنتيجة) · wa_team_odd (طابور الحاجات الغريبة).
   المسارات:
     GET  /api/cms/wabot/team            الإعدادات + حالة نافذة كل موظف + القوالب + العدّادات (الأرقام كاملة للمالك بس)
     PUT  /api/cms/wabot/team            حفظ الإعدادات (المالك بس)
     POST /api/cms/wabot/team/test       {phone} رسالة تجربة لموظف **من الدليل بس** (المالك بس)
     GET  /api/portal/wa/team-status     حالة نوافذ الفريق للبورتال (كاشير / مدير) — من غير أرقام

   PO1 (١٤/١٠ مساءً — «البورتال مقفول» راح للكاشير ٣٢ مرة في ٣.٥ ساعة، والمدير ٥ + «رجع» ٣) — بعد المراجعة:
     • «مقفول» = مفيش إشارة من البورتال على أي جهاز كاشير لمدة afterMin. الافتراضي (countBackground مقفول، زي RG1): الإشارات
       «الظاهرة» بس (نبضة البوابة / قايمة التحويلات / داس على حاجة) — البورتال في الخلفية ممكن مايرنّش. لو المالك شغّله: أي طلب من
       البوابة نفسها (حتى من الخلفية) بيتحسب. نبضة البث اللي السيرفر بيبعتها عمرها ما بتتحسب (wahandover.js).
     • «الحلقة» (المرة) = من أول ما يتقفل لحد ما جهاز كاشير يفضل مفتوح backStableMin دقيقة ورا بعض. بصّة سريعة مابتنهيش الحلقة.
     • السلّم جوّه الحلقة: الكاشير ياخد لحد managerAfter تنبيه في الحلقة دي؛ بعدها (في ميعاد التنبيه اللي عليه) الدور على المدير، وياخد
       تذكير كل repeatMin طول ما هو مقفول. الكاشير وصل للسقف اليومي ⇒ المدير على طول. المدير وصل للسقف (أو مفيش مدير) ⇒ الكاشير يكمّل
       لحد سقفه. يعني الرسايل ماتقفش وفيه حد لسه ليه رصيد.
     • التكرار والسقف لكل رقم مش لكل حلقة: مفيش رسالة «مقفول» (كاشير أو مدير) لنفس الموظف قبل repeatMin من آخر واحدة، حتى لو البورتال
       فتح وقفل (wa_team_portal_to، الحجز قبل الإرسال)، وdailyCap في اليوم التشغيلي (٤ الفجر).
     • «رجع» للمدير على طول لما الحلقة تخلص، مرة واحدة (مسح الحلقة هو الحجز)، بس للمدير اللي اتبلّغ فيها. خبر حلو: مابياخدش من التكرار
       ولا من السقف، فرسالة «مقفول» الجاية مابتتأخرش بسببه.
     • المدة في الرسايل = من آخر إشارة (مش من أول الحلقة)، ولو آخر إشارة كانت قبل بداية الشغل ⇒ «من أول الشغل».
   المراجعة التانية (١٤/١٠ بالليل):
     • الحلقة بتخلص برضه لو البورتال «مااتقفلش» بقاعدة التنبيه (إشارة كل أقل من afterMin) مدة keepMin = max(repeatMin, afterMin+backStableMin)
       ورا بعض (reopened_at = بداية الفترة دي). بصّات كل ٤ دقايق كانت بتخلّي حلقة الصبح عايشة لحد العصر بعدّادها و«المدير اتبلّغ»، فأول قفلة
       حقيقية كانت بتروح للمدير «تذكير: لسه مقفول من ١٠ دقايق» والكاشير مايعرفش لساعات. «رجع» هنا بنص صادق («بيتفتح كل شوية»).
     • اتقفل تاني بعد رسالة للكاشير بشوية (الكاشير محجوز بالتكرار، ولسه مفيش تنبيه في الحلقة دي): الافتراضي زي ما هو — الرسالة الجاية للكاشير بعد
       repeatMin من آخر رسالة (الحجز لكل رقم = اللي اتوافق عليه)، والدورة واللوحة بيقولوا إمتى. managerOnHold (مقفول افتراضي) ⇒ المدير يتبلّغ
       مرة في الحلقة دي على طول بالحقيقة («اتبعتله الساعة … وفتحه بعدها وقفله، ورسالته الجاية …»).
     • اللي وصل بس هو اللي بيتقال وبيتحسب: السقف اليومي وsentToday = رسايل وصلت. جولة للكاشير فشلت بتمشّي السلّم (رقم مش بيوصله واتساب لازم
       يوصل للمدير) بس رسالة المدير بتقول الحقيقة («رغم N» = N وصلوا، و«مش قادرين نوصل للكاشير» لو ولا واحد)، و«المدير اتبلّغ» بس لو رسالته وصلت.
     • المهلة بعد رجوع الشغل: service.resumedAt بيتقري مرة واحدة أول دورة بعد التشغيل (مش كل دورة)، والمهلة نفسها مابتمسحش الحلقة — بره الشغل بس.
     • الرسايل: نص المدير من غير تكرار ومن غير «مش بترن» (ممكن ماترنّش — إشعار البوابة لسه بيرن)، وسطر القالب ≤١٢٠ من غير قص في نص كلمة.
═══════════════════════════════════════════════════════════════════════════ */
import { staffPhones, fitOneSms, staffConfig } from "./staffalerts.js";
import { bizDay, bizStart } from "./bizday.js";
import { maskText } from "./wabotllm.js";
import { openState } from "./wabot.js";
import { isReviewHandover } from "./reviewaudience.js";

export const ROLES = Object.freeze(["cashier", "manager", "owner"]);
export const ROLE_AR = Object.freeze({ cashier: "كاشير", manager: "مدير", owner: "مالك" });
export const TOPICS = Object.freeze(["handover", "urgent", "odd", "digest"]);
export const TOPIC_AR = Object.freeze({ handover: "كل التحويلات لموظف", urgent: "التحويلات العاجلة بس", odd: "حاجات غريبة", digest: "الملخص اليومي" });
export const INBOX_URL = "https://freshcuts-invite.o2m8.me/#store/wa/inbox";
export const PORTAL_URL = "https://freshcuts-invite.o2m8.me/portal/";
export const RENEW_ID = "team:renew";
export const RENEW_TITLE = "✅ جدّد التنبيهات";            // زر الرسالة الحرة (≤٢٠ حرف)
export const RENEW_TITLE_TPL = "جدّد التنبيهات";           // زر القالب: ميتا بترفض الإيموجي في أزرار القوالب
export const TPL_RENEW = "fc_staff_alerts_renew";
export const TPL_NOTICE = "fc_staff_team_notice";
export const TPL_HANDOFF = "fc_staff_wa_handoff";          // قالب قديم في الكتالوج (سبب + ملخص) — بديل للتحويلات لو الجديد لسه مااتعتمدش

/* أنواع «الحاجات الغريبة» — كل نوع مفتاح لوحده (settings.waTeam.odd.kinds) */
export const ODD_KINDS = Object.freeze({
  secret: "سؤال عن وصفة / مقادير / مورّد",
  non_customer: "رسالة شكلها مش من عميل (مورّد / طالب شغل)",
  loop_guard: "حلقة رسايل آلية — البوت اتكتم",
  media_flood: "سيل صور وملفات — البوت اتكتم",
  auto_inbound: "رد آلي من نشاط تجاري تاني",
  complaint: "شكوى",
  payment_problem: "مشكلة دفع / موقع",
  repeated_card: "البوت كرر نفس الرد والعميل لسه بيسأل",
  unsupported_opener: "رسالة مش مدعومة فتحت محادثة",
  customer_stopped: "عميل وقّف الرسايل",
  assist_refused: "رد للمساعد اترفض قبل ما يتبعت",
  budget_cap: "سقف المصروف / السقف اليومي اتوصل له",
  send_failures: "رسايل ورا بعض فشلت في الإرسال",
  followup_brake: "فرامل «متابعة اللي ردّ» وقّفتها («إيقاف» / حظر فوق الحد)",      // FU1 (١٥/١٠)
});
export const ODD_KEYS = Object.keys(ODD_KINDS);
/* أنواع بتتعدّ في الملخص اليومي ولوحة الفريق بس — مابتبعتش تنبيه لحظي (رسالة واتساب مابيعرضهاش، غالباً من إعلان: ١٤/١٠ عمر «مش منطقي يجي إشعار كل مرة») */
export const ODD_QUIET_DEFAULT = Object.freeze({ unsupported_opener: true });
/* ST2 — أسماء الأفعال (نفس الكلام في البورتال واللوحة ورسايل وأزرار واتساب الفريق) ونتايج قفل المحادثة */
export const ACTIONS = Object.freeze({ take: "استلم المحادثة", release: "رجّعها للبوت", done: "خلصت — اقفل", transfer: "حوّل للمدير" });
export const OUTCOMES = Object.freeze([
  { id: "ordered", label: "تم الطلب", hint: "العميل طلب أو هيطلب من الرابط — مفيش حاجة تانية مطلوبة" },
  { id: "answered", label: "استفسار واترد عليه", hint: "سأل واتجاوب عليه" },
  { id: "complaint_solved", label: "شكوى اتحلت", hint: "الشكوى اتحلت والعميل عرف الحل" },
  { id: "follow_up", label: "محتاج متابعة", hint: "لسه فيه حاجة مطلوبة للعميل — اكتبها في الملاحظة" },
  { id: "not_customer", label: "مش عميل", hint: "مورّد / طالب شغل / رقم غلط" },
]);
export const OUTCOME_IDS = OUTCOMES.map((o) => o.id);

export const DEFAULTS = Object.freeze({
  enabled: true,                 // تنبيهات الفريق على واتساب (مقفول ⇒ SMS زي الأول بالظبط)
  routing: Object.freeze({ cashier: ["handover"], manager: ["handover", "odd"], owner: ["urgent", "odd", "digest"] }),
  smsFallback: true,             // تحويل ماقدرش يوصل واتساب (نافذة مقفولة ومفيش قالب معتمد / فشل) ⇒ SMS
  templatesApproved: [],         // أسماء قوالب المالك أكّد إنها معتمدة عند ميتا (لو حدث الاعتماد مااتسجّلش عندنا)
  staffAsTesters: false,         // true ⇒ رقم فريق موجود في أرقام التجربة بيفضل البوت يرد عليه كعميل تجربة (الأزرار والأوامر شغّالة برضه)
  keeper: Object.freeze({ enabled: true, renewAtHour: 20, quietFrom: "02:00", quietTo: "10:00", leadMin: 15, smsNudge: true }),
  odd: Object.freeze({ enabled: true, perHour: 12, digest: false, digestEveryMin: 30, repeatMin: 30, excerpt: 6, smsFallback: false, failStreak: 3, failWindowMin: 15 }),
  daily: Object.freeze({ enabled: true, at: "11:00" }),
  /* ST2 — سلّم التصعيد، قفل المحادثة بنتيجة، وتحويل الكاشير للمدير (waflow.js) */
  ladder: Object.freeze({ enabled: true, managerAfterMin: 5, ownersAfterMin: 10, managerPush: true, managerDirect: true }),
  /* RG1 (١٤/١٠) — رنّة البوابة لحد ما حد يستلم، وتنبيه «البورتال مقفول وقت الشغل» */
  portalRing: Object.freeze({ enabled: true, everyMin: 3, capMin: 45 }),
  /* PO1: القيم اللي اتظبطت على اللايف ١٤/١٠ (١٠ / ٤٥ / ٣) بقت الافتراضي + المفاتيح الجديدة. countBackground مقفول = قاعدة RG1 (اللي في الخلفية مش بيرن) */
  portalOffline: Object.freeze({ enabled: true, afterMin: 10, repeatMin: 45, managerAfter: 3, backStableMin: 2, dailyCap: 6, countBackground: false, managerOnHold: false, backNotice: true }),
  close: Object.freeze({ requireOutcome: true, remindAfterMin: 20 }),
  transfer: Object.freeze({ enabled: true }),
});
export const LIMITS = Object.freeze({
  members: 30, name: 40,
  "keeper.renewAtHour": [12, 23], "keeper.leadMin": [5, 60],
  "ladder.managerAfterMin": [1, 60], "ladder.ownersAfterMin": [1, 120], "close.remindAfterMin": [0, 240],
  /* afterMin من ٣: الحضور بيتكتب مرة في الدقيقة (+ flush كل ١٥ ث) ⇒ آخر إشارة في القاعدة ممكن تتأخر لحد ~٧٥ ث؛ بدقيقة واحدة بوابة ظاهرة طول الوقت
     كانت بتطلع «مقفولة» في ~١٢٪ من الدورات (محاكاة المراجعة)، وبـ٢–٣ صفر. ٣ = قيمة RG1 اللي اشتغلت. */
  "portalRing.everyMin": [1, 30], "portalRing.capMin": [5, 180], "portalOffline.afterMin": [3, 60], "portalOffline.repeatMin": [5, 120], "portalOffline.managerAfter": [1, 10],
  "portalOffline.backStableMin": [1, 30], "portalOffline.dailyCap": [1, 30],
  "odd.perHour": [1, 60], "odd.digestEveryMin": [5, 240], "odd.repeatMin": [5, 720], "odd.excerpt": [0, 10], "odd.failStreak": [2, 20], "odd.failWindowMin": [5, 120],
});

/* RG1 — أسماء المفاتيح الجديدة بالعربي (اللوحة بتعرضها من هنا؛ مفيش مفتاح في الكود أو الـenv) */
export const KNOBS = Object.freeze([
  { key: "ladder.managerPush", type: "bool", label: "إشعار البوابة لأجهزة المدير عند التصعيد", hint: "لما التحويل يتصعّد للمدير: إشعار «⬆️ تصعيد للمدير» على موبايل/كمبيوتر المدير، وبوابته بترنّ ببانر." },
  { key: "ladder.managerDirect", type: "bool", label: "العميل يطلب «مسؤول / مدير» ⇒ المدير على طول", hint: "مع الكاشير من أول لحظة (واتساب + إشعار البوابة) من غير ما يستنى السلّم." },
  { key: "portalRing.enabled", type: "bool", label: "البوابة تفضل ترنّ لحد ما حد يستلم", hint: "إشعار تاني لأجهزة البوابة طول ما العميل مستني ومحدش استلم ولا رد." },
  { key: "portalRing.everyMin", type: "num", label: "الرنّة تتكرر كل", unit: "دقيقة" },
  { key: "portalRing.capMin", type: "num", label: "الرنّة تقف بعد", unit: "دقيقة من التحويل" },
  { key: "portalOffline.enabled", type: "bool", label: "البورتال مقفول وقت الشغل ⇒ واتساب للكاشير", hint: "لو مفيش ولا جهاز كاشير فاتح البورتال وقت الشغل، الكاشير ياخد رسالة يفتحه، ولو مااتفتحش يتبلّغ المدير." },
  { key: "portalOffline.countBackground", type: "bool", label: "البورتال في الخلفية يتحسب مفتوح", hint: "مقفول (الأضمن): لازم البورتال يبقى ظاهر على شاشة جهاز الكاشير، لأنه في الخلفية ممكن مايرنّش. لو شغّلته: أي طلب بيعمله البورتال وهو في الخلفية بيتحسب «مفتوح» حتى لو مش هيرن." },
  { key: "portalOffline.afterMin", type: "num", label: "يتبعت لما البورتال يبقى مقفول", unit: "دقيقة", hint: "مقفول = مفيش إشارة من البورتال على أي جهاز كاشير طول المدة دي (ظاهر على الشاشة، أو في الخلفية لو المفتاح اللي فوق شغّال)." },
  { key: "portalOffline.backStableMin", type: "num", label: "يتحسب رجع لما يفضل مفتوح", unit: "دقيقة ورا بعض", hint: "فتحة سريعة (بصّة) مابتنهيش التنبيه. ولو بيتفتح كل شوية ومابيفضلش مقفول المدة اللي فوق، طول مدة التكرار، التنبيه بيخلص برضه." },
  { key: "portalOffline.repeatMin", type: "num", label: "الموظف مايوصلوش أكتر من رسالة كل", unit: "دقيقة", hint: "للكاشير والمدير، حتى لو البورتال فتح وقفل كذا مرة: لو اتقفل تاني بعد رسالة بشوية، الرسالة الجاية بتستنى لحد ما المدة دي تخلص. «تمام، رجع» مابتتحسبش." },
  { key: "portalOffline.dailyCap", type: "num", label: "أقصى رسايل «البورتال مقفول» للموظف في اليوم", unit: "رسالة", hint: "بعدها مفيش رسايل «مقفول» تانية للموظف ده لحد اليوم الجاي (٤ الفجر)، والدور بيروح على اللي لسه ليه رصيد. «تمام، رجع» مابتتحسبش، والرسالة اللي ماوصلتش مابتتحسبش." },
  { key: "portalOffline.managerAfter", type: "num", label: "المدير يتبلّغ بعد", unit: "تنبيهات للكاشير من غير ما يتفتح", hint: "في نفس المرة (من ساعة ما يتقفل لحد ما يرجع). بعدها الدور على المدير في ميعاد رسالة الكاشير الجاية، وياخد تذكير كل مدة التكرار لحد ما يتفتح أو يوصل لأقصى عدد في اليوم. مفيش مدير، أو المدير وصل لأقصى عدد ⇒ الكاشير ياخد تاني. الكاشير وصل لأقصى عدد ⇒ الدور على المدير في ميعاد رسالة الكاشير الجاية. واتساب المدير مش بيوصله (آخر محاولتين فشلوا) ⇒ الكاشير ياخد تاني، والمدير بيتجرّب كل مدة التكرار لحد ما رسالة توصله فيرجعله الدور." },
  { key: "portalOffline.managerOnHold", type: "bool", label: "اتقفل تاني بعد رسالة للكاشير بشوية ⇒ المدير يعرف على طول", hint: "الكاشير مايوصلوش رسالة تانية قبل مدة التكرار، فلو قفل البورتال تاني بعد رسالة بشوية محدش بيعرف لحد ما المدة تخلص. شغّله لو عايز المدير ياخد رسالة واحدة ساعتها (من رصيده اليومي)." },
  { key: "portalOffline.backNotice", type: "bool", label: "«تمام، البورتال رجع» للمدير", hint: "أول ما يرجع ويفضل مفتوح (أو يفضل يتفتح كل شوية من غير ما يتقفل) — للمدير اللي اتبلّغ في المرة دي بس." },
]);

const H = 3600_000;
const clip = (v, n) => String(v ?? "").slice(0, n);
const last4 = (p) => `…${String(p || "").slice(-4)}`;
const normPh = (p) => staffPhones([p])[0] || "";
const hhmmOk = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
const minOf = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
const num = (v, [lo, hi], def) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : def; };
/* دقيقة اليوم بتوقيت الرياض (UTC+3 ثابت) */
export const riyadhMin = (d) => { const t = new Date(d).getTime() + 3 * H; return Math.floor((((t % (24 * H)) + 24 * H) % (24 * H)) / 60_000); };
export const riyadhHHMM = (d) => { const m = riyadhMin(d); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
export const riyadhDay = (d) => new Date(new Date(d).getTime() + 3 * H).toISOString().slice(0, 10);

/* ── الإعدادات: settings.waTeam ⇒ شكل ثابت بحدود ────────────────────────────
   members مش مكتوبة خالص ⇒ دليل مؤقت من أرقام تنبيهات البوت (waBot.alertPhones وإلا delivery.alertPhones) بدور «كاشير»
   (= كل التحويلات، زي ما كانوا بياخدوها SMS) ومتعلّم fallback — لحد ما الدليل يتكتب بالأدوار. */
export function teamConfig(settings) {
  const x = (settings && settings.waTeam && typeof settings.waTeam === "object") ? settings.waTeam : {};
  const seen = new Set(), members = [];
  let fallback = false;
  if (Array.isArray(x.members)) {
    for (const m of x.members.slice(0, LIMITS.members)) {
      const phone = normPh(m && m.phone);
      if (!phone || seen.has(phone) || !ROLES.includes(m.role)) continue;
      seen.add(phone);
      members.push({ phone, name: clip(String(m.name || "").trim(), LIMITS.name), role: m.role, active: m.active !== false });
    }
  } else {
    fallback = true;
    const bot = staffPhones(settings && settings.waBot && settings.waBot.alertPhones);
    for (const phone of (bot.length ? bot : staffConfig(settings).alertPhones).slice(0, LIMITS.members)) members.push({ phone, name: "", role: "cashier", active: true });
  }
  const routing = {};
  for (const r of ROLES) {
    const v = x.routing && Array.isArray(x.routing[r]) ? x.routing[r] : DEFAULTS.routing[r];
    routing[r] = [...new Set(v.filter((t) => TOPICS.includes(t)))];
  }
  const k = x.keeper && typeof x.keeper === "object" ? x.keeper : {}, o = x.odd && typeof x.odd === "object" ? x.odd : {}, d = x.daily && typeof x.daily === "object" ? x.daily : {};
  const pr = x.portalRing && typeof x.portalRing === "object" ? x.portalRing : {}, po = x.portalOffline && typeof x.portalOffline === "object" ? x.portalOffline : {};
  const la = x.ladder && typeof x.ladder === "object" ? x.ladder : {}, cl = x.close && typeof x.close === "object" ? x.close : {}, tr = x.transfer && typeof x.transfer === "object" ? x.transfer : {};
  const kinds = {};
  for (const key of ODD_KEYS) kinds[key] = !(o.kinds && o.kinds[key] === false);
  const quiet = {};
  for (const key of ODD_KEYS) quiet[key] = o.quiet && typeof o.quiet[key] === "boolean" ? o.quiet[key] : ODD_QUIET_DEFAULT[key] === true;
  return {
    enabled: x.enabled !== false, members, fallback, routing,
    smsFallback: x.smsFallback !== false,
    templatesApproved: [...new Set((Array.isArray(x.templatesApproved) ? x.templatesApproved : []).map(String).filter((n) => /^fc_staff_[a-z0-9_]{1,60}$/.test(n)))].slice(0, 20),
    staffAsTesters: x.staffAsTesters === true,
    keeper: { enabled: k.enabled !== false, renewAtHour: num(k.renewAtHour, LIMITS["keeper.renewAtHour"], DEFAULTS.keeper.renewAtHour),
      quietFrom: hhmmOk(k.quietFrom) ? k.quietFrom : DEFAULTS.keeper.quietFrom, quietTo: hhmmOk(k.quietTo) ? k.quietTo : DEFAULTS.keeper.quietTo,
      leadMin: num(k.leadMin, LIMITS["keeper.leadMin"], DEFAULTS.keeper.leadMin), smsNudge: k.smsNudge !== false },
    odd: { enabled: o.enabled !== false, perHour: num(o.perHour, LIMITS["odd.perHour"], DEFAULTS.odd.perHour), digest: o.digest === true,
      digestEveryMin: num(o.digestEveryMin, LIMITS["odd.digestEveryMin"], DEFAULTS.odd.digestEveryMin), repeatMin: num(o.repeatMin, LIMITS["odd.repeatMin"], DEFAULTS.odd.repeatMin),
      excerpt: num(o.excerpt, LIMITS["odd.excerpt"], DEFAULTS.odd.excerpt), smsFallback: o.smsFallback === true,
      failStreak: num(o.failStreak, LIMITS["odd.failStreak"], DEFAULTS.odd.failStreak), failWindowMin: num(o.failWindowMin, LIMITS["odd.failWindowMin"], DEFAULTS.odd.failWindowMin), kinds, quiet },
    daily: { enabled: d.enabled !== false, at: hhmmOk(d.at) ? d.at : DEFAULTS.daily.at },
    ladder: { enabled: la.enabled !== false, managerAfterMin: num(la.managerAfterMin, LIMITS["ladder.managerAfterMin"], DEFAULTS.ladder.managerAfterMin), ownersAfterMin: num(la.ownersAfterMin, LIMITS["ladder.ownersAfterMin"], DEFAULTS.ladder.ownersAfterMin),
      managerPush: la.managerPush !== false, managerDirect: la.managerDirect !== false },
    portalRing: { enabled: pr.enabled !== false, everyMin: num(pr.everyMin, LIMITS["portalRing.everyMin"], DEFAULTS.portalRing.everyMin), capMin: num(pr.capMin, LIMITS["portalRing.capMin"], DEFAULTS.portalRing.capMin) },
    portalOffline: { enabled: po.enabled !== false, afterMin: num(po.afterMin, LIMITS["portalOffline.afterMin"], DEFAULTS.portalOffline.afterMin), repeatMin: num(po.repeatMin, LIMITS["portalOffline.repeatMin"], DEFAULTS.portalOffline.repeatMin),
      managerAfter: num(po.managerAfter, LIMITS["portalOffline.managerAfter"], DEFAULTS.portalOffline.managerAfter),
      backStableMin: num(po.backStableMin, LIMITS["portalOffline.backStableMin"], DEFAULTS.portalOffline.backStableMin),
      dailyCap: num(po.dailyCap, LIMITS["portalOffline.dailyCap"], DEFAULTS.portalOffline.dailyCap),
      countBackground: po.countBackground === true, managerOnHold: po.managerOnHold === true, backNotice: po.backNotice !== false },
    close: { requireOutcome: cl.requireOutcome !== false, remindAfterMin: num(cl.remindAfterMin, LIMITS["close.remindAfterMin"], DEFAULTS.close.remindAfterMin) },
    transfer: { enabled: tr.enabled !== false },
  };
}
/* دور الرقم في دليل الفريق (الأعضاء الشغّالين بس) أو null. الدليل المؤقت (fallback) بيتحسب برضه: الأرقام دي أصلاً «مش عملاء» عند البوت. */
export function staffRoleOf(settings, phone) {
  const p = normPh(phone); if (!p) return null;
  const m = teamConfig(settings).members.find((x) => x.phone === p && x.active);
  return m ? m.role : null;
}
export function recipientsFor(cfg, topics) {
  const want = Array.isArray(topics) ? topics : [topics];
  return cfg.members.filter((m) => m.active && (cfg.routing[m.role] || []).some((t) => want.includes(t)));
}

/* جسم الحفظ ⇒ { ok, value } أو { ok:false, errors[] }. اللي مش مبعوت بيفضل على القديم. */
export function configFromBody(b, prev = {}) {
  const src = b && typeof b === "object" ? b : {}, errors = [];
  const out = { ...(prev && typeof prev === "object" ? prev : {}) };
  for (const k of ["enabled", "smsFallback", "staffAsTesters"]) if (k in src) { if (typeof src[k] === "boolean") out[k] = src[k]; else errors.push(`${k}: true أو false`); }
  if ("members" in src) {
    if (!Array.isArray(src.members) || src.members.length > LIMITS.members) errors.push(`members: قايمة لحد ${LIMITS.members} عضو`);
    else {
      const seen = new Set(), list = [];
      for (const m of src.members) {
        const phone = normPh(m && m.phone);
        if (!phone) { errors.push("members: جوال سعودي 05XXXXXXXX لكل عضو"); break; }
        if (seen.has(phone)) { errors.push(`members: الرقم ${last4(phone)} مكرر`); break; }
        if (!ROLES.includes(m.role)) { errors.push(`members: الدور cashier أو manager أو owner (${last4(phone)})`); break; }
        seen.add(phone);
        list.push({ phone, name: clip(String(m.name || "").trim(), LIMITS.name), role: m.role, active: m.active !== false });
      }
      if (!errors.length) out.members = list;
    }
  }
  if ("routing" in src) {
    const r = src.routing && typeof src.routing === "object" ? src.routing : null, next = { ...(out.routing || {}) };
    if (!r) errors.push("routing: كائن { cashier, manager, owner }");
    else for (const role of Object.keys(r)) {
      if (!ROLES.includes(role) || !Array.isArray(r[role]) || r[role].some((t) => !TOPICS.includes(t))) { errors.push(`routing.${role}: مواضيع من ${TOPICS.join(" / ")}`); continue; }
      next[role] = [...new Set(r[role])];
    }
    out.routing = next;
  }
  if ("templatesApproved" in src) {
    if (!Array.isArray(src.templatesApproved) || src.templatesApproved.some((n) => !/^fc_staff_[a-z0-9_]{1,60}$/.test(String(n)))) errors.push("templatesApproved: أسماء قوالب فريق fc_staff_…");
    else out.templatesApproved = [...new Set(src.templatesApproved.map(String))].slice(0, 20);
  }
  const group = (name, bools, nums, times) => {
    if (!(name in src)) return;
    const g = src[name] && typeof src[name] === "object" ? src[name] : null;
    if (!g) { errors.push(`${name}: كائن`); return; }
    const next = { ...(out[name] && typeof out[name] === "object" ? out[name] : {}) };
    for (const k of bools) if (k in g) { if (typeof g[k] === "boolean") next[k] = g[k]; else errors.push(`${name}.${k}: true أو false`); }
    for (const k of nums) if (k in g) { const [lo, hi] = LIMITS[`${name}.${k}`]; const n = Number(g[k]); if (Number.isFinite(n) && n >= lo && n <= hi) next[k] = Math.round(n); else errors.push(`${name}.${k}: من ${lo} لـ${hi}`); }
    for (const k of times) if (k in g) { if (hhmmOk(g[k])) next[k] = g[k]; else errors.push(`${name}.${k}: وقت بصيغة HH:MM`); }
    if (name === "odd" && "kinds" in g) {
      const kk = g.kinds && typeof g.kinds === "object" ? g.kinds : null;
      if (!kk || Object.keys(kk).some((x) => !ODD_KEYS.includes(x) || typeof kk[x] !== "boolean")) errors.push(`odd.kinds: مفاتيح من ${ODD_KEYS.join(" / ")} بقيمة true أو false`);
      else next.kinds = { ...(next.kinds || {}), ...kk };
    }
    if (name === "odd" && "quiet" in g) {
      const kk = g.quiet && typeof g.quiet === "object" ? g.quiet : null;
      if (!kk || Object.keys(kk).some((x) => !ODD_KEYS.includes(x) || typeof kk[x] !== "boolean")) errors.push(`odd.quiet: مفاتيح من ${ODD_KEYS.join(" / ")} بقيمة true أو false`);
      else next.quiet = { ...(next.quiet || {}), ...kk };
    }
    out[name] = next;
  };
  group("keeper", ["enabled", "smsNudge"], ["renewAtHour", "leadMin"], ["quietFrom", "quietTo"]);
  group("odd", ["enabled", "digest", "smsFallback"], ["perHour", "digestEveryMin", "repeatMin", "excerpt", "failStreak", "failWindowMin"], []);
  group("daily", ["enabled"], [], ["at"]);
  group("ladder", ["enabled", "managerPush", "managerDirect"], ["managerAfterMin", "ownersAfterMin"], []);
  group("portalRing", ["enabled"], ["everyMin", "capMin"], []);
  group("portalOffline", ["enabled", "backNotice", "countBackground", "managerOnHold"], ["afterMin", "repeatMin", "managerAfter", "backStableMin", "dailyCap"], []);
  group("close", ["requireOutcome"], ["remindAfterMin"], []);
  group("transfer", ["enabled"], [], []);
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/* ── نافذة الـ٢٤ ساعة وحارسها (صافي) ─────────────────────────────────────── */
export function windowState(lastInAt, now) {
  const li = lastInAt ? new Date(lastInAt).getTime() : NaN, t = new Date(now).getTime();
  if (!Number.isFinite(li)) return { open: false, lastInAt: null, until: null, closedSince: null, minutesLeft: 0 };
  const until = li + 24 * H;
  return t < until ? { open: true, lastInAt: new Date(li).toISOString(), until: new Date(until).toISOString(), closedSince: null, minutesLeft: Math.floor((until - t) / 60_000) }
    : { open: false, lastInAt: new Date(li).toISOString(), until: null, closedSince: new Date(until).toISOString(), minutesLeft: 0 };
}
/* اللحظة دي جوّه ساعات الهدوء؟ ⇒ بداية فترة الهدوء اللي هي فيها (ms) أو null. from = to ⇒ مفيش هدوء. */
export function quietStartOf(ms, from, to) {
  const f = minOf(from), t = minOf(to); if (f === t) return null;
  const m = riyadhMin(ms), inside = f < t ? (m >= f && m < t) : (m >= f || m < t);
  if (!inside) return null;
  return ms - (((m - f) + 1440) % 1440) * 60_000 - (ms % 60_000);
}
/* قرار حارس النافذة لموظف واحد ⇒ { action: "none" | "free" | "closed", why, dueAt? }.
   state: { freeNudgeAt, closedNudgeAt } (آخر مرة اتبعت له كل نوع). free = رسالة حرة بالزر · closed = قالب التجديد (مرة واحدة لكل قفلة). */
export function keeperPlan({ now, lastInAt, state = {}, keeper }) {
  const none = (why, dueAt = null) => ({ action: "none", why, ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}) });
  if (!keeper || !keeper.enabled) return none("off");
  const t = new Date(now).getTime(), li = lastInAt ? new Date(lastInAt).getTime() : NaN;
  const ms = (v) => (v ? new Date(v).getTime() : NaN);
  const quietNow = quietStartOf(t, keeper.quietFrom, keeper.quietTo) !== null;
  if (Number.isFinite(li) && t - li < 24 * H) {
    if (Number.isFinite(ms(state.freeNudgeAt)) && ms(state.freeNudgeAt) >= li) return none("already_nudged");
    let due = li + keeper.renewAtHour * H;
    const qs = quietStartOf(due, keeper.quietFrom, keeper.quietTo);
    if (qs !== null) due = Math.max(li, qs - keeper.leadMin * 60_000);      // الساعة ٢٠ جوّه الهدوء ⇒ قبل بداية الهدوء
    if (t < due) return none("not_due", due);
    if (quietNow) return none("quiet");
    return { action: "free", why: "renew_due", dueAt: new Date(due).toISOString() };
  }
  const closedNudge = ms(state.closedNudgeAt);
  if (Number.isFinite(closedNudge) && (!Number.isFinite(li) || closedNudge >= li)) return none("waiting_tap");
  if (quietNow) return none("quiet");
  return { action: "closed", why: Number.isFinite(li) ? "window_closed" : "never_wrote" };
}

/* ── نصوص رسايل الفريق (مصري) ─────────────────────────────────────────────── */
const STAGE_HEAD = {
  new: (u) => (u ? "🚨 تحويل عاجل لموظف" : "💬 تحويل لموظف"),
  reminder: (u, w) => `🔔 تذكير${u ? " عاجل" : ""}: العميل مستني${w ? ` من ${w} دقيقة` : ""} ومحدش رد`,
  reopened: (u) => `♻️ ${u ? "عاجل — " : ""}التحويل اتقفل بـ«تم» من غير رد للعميل`,
};
export function handoverText({ phone, reasonAr, urgent = false, orderNo = null, stage = "new", waitedMin = null, lastText = null }) {
  const head = (STAGE_HEAD[stage] || STAGE_HEAD.new)(urgent, waitedMin);
  return [`${head} — ${reasonAr || "تحويل"}`, `العميل: ${last4(phone)}${orderNo ? ` · طلب ${orderNo}` : ""}`,
    lastText ? `آخر رسالة منه: «${clip(lastText, 200)}»` : null, `رد عليه من البورتال: ${PORTAL_URL}`].filter(Boolean).join("\n").slice(0, 1000);
}
export function excerptLines(rows) {
  return (rows || []).map((r) => `${r.direction === "in" ? "‹ العميل" : "› إحنا"}: ${clip(maskText(r.body) || "[من غير نص]", 140)}`);
}
export function oddText({ kind, phone = null, detail = null, tried = null, excerpt = [] }) {
  const lines = [`👀 حاجة غريبة — ${ODD_KINDS[kind] || kind}`];
  if (phone) lines.push(`العميل: ${last4(phone)}`);
  if (detail) lines.push(clip(detail, 200));
  if (tried) lines.push(`المساعد كان هيقول: «${clip(tried, 300)}»`);
  if (excerpt.length) lines.push("آخر الرسايل:", ...excerpt);
  if (phone) lines.push(`المحادثة: ${INBOX_URL}`);
  return lines.join("\n").slice(0, 1000);
}
export function oddDigestText(rows, { held = false } = {}) {
  const head = held ? `👀 ${rows.length} حاجة غريبة اتأجّلت بسبب سقف الساعة` : `👀 ملخص الحاجات الغريبة (${rows.length})`;
  const body = rows.slice(0, 12).map((r) => `• ${ODD_KINDS[r.kind] || r.kind}${r.phone_norm ? ` — ${last4(r.phone_norm)}` : ""}${r.at ? ` · ${riyadhHHMM(r.at)}` : ""}`);
  if (rows.length > 12) body.push(`… و${rows.length - 12} كمان`);
  return [head, ...body, `التفاصيل: ${INBOX_URL}`].join("\n").slice(0, 1000);
}
export const oddSummary = ({ kind, phone }) => clip(`${ODD_KINDS[kind] || kind}${phone ? ` — عميل ${last4(phone)}` : ""}`, 120);
export function keeperFreeText({ minutesLeft }) {
  const h = Math.max(1, Math.round(minutesLeft / 60));
  return `⏰ تنبيهات واتساب المجانية هتقف كمان ${h === 1 ? "ساعة" : h === 2 ? "ساعتين" : `${h} ساعات`}.\nاضغط الزر تحت عشان التنبيهات تفضل توصلك هنا ببلاش.`;
}
export const renewedText = ({ name, until }) => `✅ تمام${name ? ` يا ${name}` : ""} — التنبيهات هتوصلك هنا ببلاش لحد بكرة ${riyadhHHMM(until)}.`;
export function keeperSms(lang = "en") {
  return fitOneSms(lang === "ar" ? "فريش كاتس: اكتب «تنبيهات» على واتساب المطعم عشان التنبيهات توصلك"
    : "Fresh Cuts: your WhatsApp alerts are paused. Send the word ALERTS to the restaurant WhatsApp number to turn them back on (free).");
}
export const HELP_TEXT = ["أوامر الفريق (اكتبها هنا):", "• حالة — نافذة التنبيهات بتاعتك والمواضيع اللي بتوصلك", "• تنبيهات — تجديد التنبيهات المجانية (زي الزر)", "• ملخص — ملخص آخر ٢٤ ساعة (مدير / مالك)", "• مساعدة — القايمة دي"].join("\n");
export function dailyText({ handovers = 0, urgent = 0, odd = [], bySms = 0, closed = [], staffFlags = 0, staffReview = 0 }) {
  const lines = ["🗒 ملخص واتساب — آخر ٢٤ ساعة", `تحويلات لموظف: ${handovers}${urgent ? ` (منها ${urgent} عاجل)` : ""}`];
  const total = odd.reduce((a, r) => a + Number(r.n || 0), 0);
  lines.push(`حاجات غريبة: ${total}`);
  for (const r of odd.slice(0, 8)) lines.push(`• ${ODD_KINDS[r.kind] || r.kind}: ${r.n}`);
  if (bySms) lines.push(`تنبيهات راحت SMS (النافذة كانت مقفولة): ${bySms}`);
  if (closed.length) lines.push(`نافذتهم مقفولة دلوقتي: ${closed.join("، ")}`);
  /* SX1: الفحص اليومي لقايمة الموظفين — عدد بس، سطر واحد في اليوم (مفيش رسالة لكل رقم) */
  if (staffFlags > 0) lines.push(`⚠️ أرقام في قايمة الموظفين بتتصرف زي عملاء: ${staffFlags} — راجعها: الفريق والتنبيهات ← قوايم الأرقام`);
  if (staffReview > 0) lines.push(`📋 أرقام مستنية قرارك (موظف ولا عميل؟): ${staffReview}`);
  lines.push(`اللوحة: ${INBOX_URL}`);
  return lines.join("\n").slice(0, 1000);
}

/* أوامر الفريق المكتوبة (بعد تنضيف بسيط) */
const cmdNorm = (t) => String(t || "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
export function staffCommand(ev) {
  if (ev && ev.interactiveId && String(ev.interactiveId) === RENEW_ID) return "renew";
  const n = cmdNorm(ev && ev.text);
  if (!n) return null;
  if (/^(جدد التنبيهات|تنبيهات|التنبيهات|جدد|تجديد|renew alerts|alerts|renew)$/.test(n)) return "renew";
  if (/^(حاله|الحاله|حالتي|status)$/.test(n)) return "status";
  if (/^(مساعده|اوامر|الاوامر|help)$/.test(n)) return "help";
  if (/^(ملخص|الملخص|digest|summary)$/.test(n)) return "digest";
  return null;
}
/* «مش عميل» بحذر: طالب شغل أو عرض من مورّد/شركة. جملة صريحة بس — كلمة «وظيفة» لوحدها في سؤال مش كفاية للمورّد، وسؤال العميل «عندكم توصيل؟» مايتمسكش. */
const JOB_RE = /(سيرتي الذاتيه|السيره الذاتيه|ارفقت (لكم )?(ال)?سيره|ابحث عن (عمل|وظيفه)|ابي وظيفه|ابغي وظيفه|ابغا وظيفه|عايز اشتغل عندكم|ابي اشتغل عندكم|ابغي اشتغل عندكم|هل (يوجد|عندكم|لديكم) (وظائف|وظايف|شواغر|وظيفه)|تقديم علي وظيفه|looking for a job|job vacancy|my (cv|resume)\b)/;
const SUPPLIER_RE = /(نحن (شركه|مؤسسه|مصنع|وكاله)|معكم (شركه|مؤسسه|مصنع|وكاله)|نقدم لكم (خدمات|عروض|اسعار)|نوفر لكم|عرض سعر|عروض اسعار للمطاعم|مورد (لحوم|دواجن|خضار|فحم|عبوات|تغليف)|مندوب مبيعات|نود التعاون معكم|we are a (company|supplier|agency)|our company (offers|provides)|business proposal)/;
export function nonCustomerKind(text) {
  const n = cmdNorm(text);
  if (!n || [...n].length < 12) return null;
  if (JOB_RE.test(n)) return "job_seeker";
  if (SUPPLIER_RE.test(n)) return "supplier";
  return null;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS wa_team_state (
    phone_norm TEXT PRIMARY KEY, free_nudge_at TIMESTAMPTZ, closed_nudge_at TIMESTAMPTZ, closed_nudge_via TEXT, renewed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS wa_team_log (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), phone_norm TEXT NOT NULL, role TEXT, topic TEXT NOT NULL, kind TEXT,
    via TEXT NOT NULL, ok BOOLEAN NOT NULL DEFAULT FALSE, error TEXT, ref4 TEXT, urgent BOOLEAN NOT NULL DEFAULT FALSE);
  CREATE INDEX IF NOT EXISTS wa_team_log_at_idx ON wa_team_log(at DESC);
  CREATE TABLE IF NOT EXISTS wa_team_odd (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), kind TEXT NOT NULL, phone_norm TEXT, detail TEXT, tried TEXT,
    status TEXT NOT NULL DEFAULT 'pending', sent_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS wa_team_odd_at_idx ON wa_team_odd(at DESC);
  CREATE TABLE IF NOT EXISTS wa_team_portal (id TEXT PRIMARY KEY, since TIMESTAMPTZ, alerts INT NOT NULL DEFAULT 0, last_alert_at TIMESTAMPTZ, manager_told BOOLEAN NOT NULL DEFAULT FALSE);
  ALTER TABLE wa_team_portal ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
  ALTER TABLE wa_team_portal ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS wa_team_portal_to (phone_norm TEXT PRIMARY KEY, last_at TIMESTAMPTZ, last_mgr_at TIMESTAMPTZ, last_back_at TIMESTAMPTZ);
`;
/* PO1: كل تشغيل ⇒ حجز كل رقم بيلحق آخر رسالة «مقفول» في السجل (كاشير أو مدير؛ «رجع» مابتحجزش) — حتى لو كود تاني بعتها (حاوية RG1
   القديمة وقت التبديل، أو بعد rollback وdeploy تاني): GREATEST ⇒ الحجز عمره ما بيرجع لورا. مفيش رسالة على طول بعد الـdeploy لحد اتبعتله من دقيقتين.
   استعلام لوحده بعد الجداول: لو فشل مايرجّعش إنشاء الجداول معاه. */
const PORTAL_TO_SEED = `INSERT INTO wa_team_portal_to(phone_norm, last_at, last_mgr_at, last_back_at)
  SELECT phone_norm, max(at) FILTER (WHERE kind IN ('cashier','manager')), max(at) FILTER (WHERE kind='manager'), max(at) FILTER (WHERE kind='back') FROM wa_team_log
   WHERE topic='portal_offline' AND at > NOW() - INTERVAL '1 day' GROUP BY phone_norm
  ON CONFLICT (phone_norm) DO UPDATE SET last_at = GREATEST(wa_team_portal_to.last_at, EXCLUDED.last_at),
    last_mgr_at = GREATEST(wa_team_portal_to.last_mgr_at, EXCLUDED.last_mgr_at), last_back_at = GREATEST(wa_team_portal_to.last_back_at, EXCLUDED.last_back_at)`;

/* ── RG1: «البورتال مقفول وقت الشغل» (صافي) ──────────────────────────────────
   وقت الشغل = مواعيد المطعم (settings.hours) والمطعم فاتح وفيه توصيل أو استلام شغّال (مش متوقف)؛ من غير مواعيد ⇒ اليوم التشغيلي ١١:٠٠→٠٣:٠٠ الرياض.
   لازم يكون فاتح من afterMin دقيقة على الأقل (أول ما يفتح الكاشير لسه بيفتح البوابة). workSince = إمتى الدورة شافت الشغل بدأ (مثلاً بعد
   إيقاف يدوي): الإيقاف مالوش تاريخ في الإعدادات، فالساعة لوحدها كانت بتعدّي المهلة أول ما المالك يرجّع التوصيل. */
const workAt = (settings, d) => {
  if (settings && settings.hours) { try { const o = openState(settings, d); return o.open === true && (o.delivery === true || o.pickup === true); } catch { return false; } }
  const m = riyadhMin(d); return m >= 11 * 60 || m < 3 * 60;
};
export function workingNow(settings, now, afterMin = 0, workSince = null) {
  const t = new Date(now).getTime();
  if (!(workAt(settings, new Date(t)) && workAt(settings, new Date(t - afterMin * 60_000)))) return false;
  const ws = workSince == null ? NaN : new Date(workSince).getTime();
  return !Number.isFinite(ws) || t - ws >= afterMin * 60_000;
}
/* بداية فترة الشغل الحالية بالمواعيد (أول دقيقة متصلة لحد دلوقتي، لحد maxMin لورا) ⇒ ISO أو null بره الشغل.
   خطوة ربع ساعة لورا لحد ما يبقى بره الشغل، وبعدين دقيقة دقيقة جوّه الربع ده (المواعيد بالدقيقة). */
export function workStartOf(settings, now, maxMin = 18 * 60) {
  const t = new Date(now).getTime(), M = 60_000;
  if (!workAt(settings, new Date(t))) return null;
  let ok = t;
  for (let i = 15; i <= maxMin && workAt(settings, new Date(t - i * M)); i += 15) ok = t - i * M;
  for (let u = ok - M; u > ok - 15 * M && t - u <= maxMin * M; u -= M) { if (!workAt(settings, new Date(u))) break; ok = u; }
  return new Date(ok).toISOString();
}
/* PO1 — حالة بوابة الكاشير من قايمة الحضور (wahandover.presence) ⇒
     { lastSeen (آخر إشارة بتتحسب), offMin, closed (مفيش إشارة من afterMin دقيقة — بالمللي، من غير تقريب), stable (جهاز «فتحته» الحالية
       طولها ≥ backStableMin وآخر إشارة فيها لسه طازة), streakStart, lastAny (آخر إشارة من أي نوع), hidden (مقفول بالقاعدة بس البوابة شغّالة
       في الخلفية — countBackground مقفول) }. countBackground=false (الافتراضي) ⇒ الإشارات «الظاهرة» بس (last_visible / visible_since). */
export const PORTAL_FRESH_MS = 150_000;      // = STREAK_GAP_MS في wahandover.js: الجهاز المفتوح بيكتب كل ~٦٠–٧٥ ث
export const MGR_FAIL_MAX = 2;               // آخر محاولتين للمدير في المرة دي فشلوا (مفيش رسالة وصلتله بعدهم) ⇒ الدور للكاشير، والمدير بيتجرّب تاني كل repeatMin
export const PORTAL_SLACK_MS = 30_000;       // تذبذب الدورة: التكرار كل ٤٥ مايبقاش ٤٦
/* المراجعة التانية — الحلقة بتخلص لو البورتال مااتقفلش (بقاعدة التنبيه) المدة دي ورا بعض، حتى من غير ما يفضل ظاهر backStableMin.
   أكبر من afterMin دايماً ⇒ بصّة واحدة (بتخلّيه «مش مقفول» afterMin بالظبط) عمرها ما بتنهي الحلقة؛ ومش أقل من repeatMin ⇒ اللي بيتشاف
   كل شوية طول فترة تكرار كاملة مابقاش «لسه مقفول». */
export const keepMinOf = (po) => Math.max(Number(po && po.repeatMin) || DEFAULTS.portalOffline.repeatMin,
  (Number(po && po.afterMin) || DEFAULTS.portalOffline.afterMin) + (Number(po && po.backStableMin) || DEFAULTS.portalOffline.backStableMin));
export function portalSignal(list, now, { afterMin = DEFAULTS.portalOffline.afterMin, backStableMin = DEFAULTS.portalOffline.backStableMin, countBackground = false } = {}) {
  const t = new Date(now).getTime(), ms = (v) => (v ? new Date(v).getTime() : NaN);
  const fresh = Math.min(PORTAL_FRESH_MS, afterMin * 60_000);
  let last = null, any = null, streakStart = null, openSince = null;
  for (const x of list || []) {
    if (!x || x.role !== "cashier") continue;
    const a = ms(x.lastSeen);
    if (Number.isFinite(a) && (any === null || a > any)) any = a;
    const ls = ms(countBackground ? x.lastSeen : x.lastVisible);
    if (!Number.isFinite(ls)) continue;
    const ss0 = ms(countBackground ? x.seenSince : x.visibleSince), ss = Number.isFinite(ss0) && ss0 <= ls ? ss0 : ls;      // صف قديم من غير بداية ⇒ إشارة واحدة
    if (last === null || ls > last) last = ls;
    if (t - ls < fresh && ls - ss >= backStableMin * 60_000) streakStart = streakStart === null ? ss : Math.min(streakStart, ss);
    if (t - ls < afterMin * 60_000) openSince = openSince === null ? ss : Math.min(openSince, ss);      // الجهاز ده مخلّيه «مش مقفول» من بداية فتحته
  }
  const off = last === null ? null : Math.max(0, t - last), closed = off === null || off >= afterMin * 60_000;
  return { lastSeen: last === null ? null : new Date(last).toISOString(), offMin: off === null ? null : Math.floor(off / 60_000),
    closed, stable: streakStart !== null, streakStart: streakStart === null ? null : new Date(streakStart).toISOString(),
    openSince: closed || openSince === null ? null : new Date(openSince).toISOString(),
    lastAny: any === null ? null : new Date(any).toISOString(), hidden: closed && !countBackground && any !== null && t - any < afterMin * 60_000 };
}
/* حضور البوابة ⇒ آخر ظهور لبوابة كاشير، ومن كام دقيقة (null = ماظهرتش خالص في آخر ٧ أيام) */
export function cashierPortal(list, now) {
  const t = new Date(now).getTime();
  const last = (list || []).filter((x) => x && x.role === "cashier" && x.lastSeen).map((x) => new Date(x.lastSeen).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return last ? { lastSeen: new Date(last).toISOString(), offMin: Math.max(0, Math.floor((t - last) / 60_000)) } : { lastSeen: null, offMin: null };
}
/* المدة بالكلام: دقيقة / دقيقتين / 7 دقايق / 25 دقيقة / ساعة / ساعة و20 دقيقة / ساعتين / 3 ساعات / 11 ساعة */
export function durAr(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m <= 1) return "دقيقة";
  if (m === 2) return "دقيقتين";
  if (m <= 10) return `${m} دقايق`;
  if (m < 60) return `${m} دقيقة`;
  const h = Math.floor(m / 60), r = m % 60, hs = h === 1 ? "ساعة" : h === 2 ? "ساعتين" : h <= 10 ? `${h} ساعات` : `${h} ساعة`;
  return r >= 5 ? `${hs} و${r <= 10 ? `${r} دقايق` : `${r} دقيقة`}` : hs;
}
/* من إمتى: آخر إشارة (مش أول الحلقة)، ولو آخر إشارة قبل بداية الشغل ⇒ «من أول الشغل» (مش «من 520 دقيقة» بالليل كله) */
const sinceAr = ({ offMin = null, fromStart = false } = {}) => (fromStart || offMin == null ? "من أول الشغل" : `من ${durAr(offMin)}`);
/* hidden = البوابة شغّالة في الخلفية بس (countBackground مقفول) ⇒ «مش ظاهر على الشاشة» بدل «مقفول» */
export const portalOfflineText = ({ offMin = null, fromStart = false, hidden = false } = {}) => `${hidden
  ? `⚠️ البورتال مش ظاهر على الشاشة ${sinceAr({ offMin, fromStart })} — خليه مفتوح قدامك عشان الطلبات ومحادثات العملاء ترن عندك.`
  : `⚠️ البورتال مقفول ${sinceAr({ offMin, fromStart })} — افتحه عشان الطلبات ومحادثات العملاء ترن عندك.`}
افتح البورتال ↗ ${PORTAL_URL}`;
/* سطر قالب (سطر واحد ≤ n حرف — قالب fc_staff_team_notice): أطول ⇒ قص عند آخر مسافة + «…»، مش في نص كلمة (المراجعة التانية: نص المدير
   كان بيتقص عند ١٢٠ بالظبط «… ومش هيوصله تاني النهارد»). النصوص تحت معمولة تكفي من غير قص أصلاً؛ ده أمان بس. */
export function fitLine(s, n = 120) {
  const v = String(s ?? "").replace(/\s+/g, " ").trim();
  if (v.length <= n) return v;
  const cut = v.slice(0, n - 1), sp = cut.lastIndexOf(" ");
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s،,—–-]+$/, "")}…`;
}
/* نص قالب الفريق (سطر واحد ≤ ١٢٠ حرف، من غير إيموجي) */
export const portalOfflineNotice = (x) => fitLine(portalOfflineText(x).split("\n")[0].replace(/^⚠️ /, "").replace(/\.$/, ""), 120);
const tanbihAr = (n) => (n === 1 ? "تنبيه واحد" : n === 2 ? "تنبيهين" : n <= 10 ? `${n} تنبيهات` : `${n} تنبيه`);
const tryAr = (n) => (n === 1 ? "محاولة واحدة" : n === 2 ? "محاولتين" : n <= 10 ? `${n} محاولات` : `${n} محاولة`);
/* رسالة المدير — full (واتساب حر) و short (سطر القالب ≤ ١٢٠). كل جملة صحيحة لحظة الإرسال:
     reason "ignored" = اتبعت للكاشير alerts جولة في المرة دي، وصل منهم delivered (الفشل بيتقال: «مش قادرين نوصل للكاشير») ·
     "cap" = الكاشير وصل لأقصى عدد (cap = اللي وصله فعلاً النهارده) ·
     "hold" = لسه مفيش تنبيه في المرة دي لأن الكاشير اتبعتله من شوية (held = { lastAt, until, opened: اتفتح بعد رسالته؟ }) ·
     reminder = المدير اتبلّغ قبل كده في نفس المرة (reopened = البورتال اتفتح بعد رسالته واتقفل تاني ⇒ «اتقفل تاني» مش «لسه مقفول»).
   مفيش «مش بترن»: إشعار البوابة (push) لسه بيرن حتى والصفحة مقفولة ⇒ «ممكن ماترنّش». */
function managerLines({ offMin = null, fromStart = false, hidden = false, alerts = 0, delivered = null, reason = "ignored", cap = null, reminder = false, reopened = false, held = null } = {}) {
  const state = hidden ? "مش ظاهر على الشاشة" : "مقفول", again = hidden ? "اختفى من على الشاشة تاني" : "اتقفل تاني", since = sinceAr({ offMin, fromStart });
  const one = (s) => ({ full: s, short: s });
  if (reminder) return one(reopened ? `تذكير: بورتال الكاشير ${again} — ${state} ${since}` : `تذكير: بورتال الكاشير لسه ${state} ${since}`);
  if (reason === "hold" && held && held.lastAt && held.until) {
    const t1 = riyadhHHMM(held.lastAt), t2 = riyadhHHMM(held.until);
    return held.opened
      ? { full: `بورتال الكاشير ${again} ${since} — الكاشير اتبعتله الساعة ${t1} وفتحه بعدها وقفله، ورسالته الجاية ${t2}`, short: `بورتال الكاشير ${again} ${since} — الكاشير اتبعتله ${t1} وفتحه وقفله، رسالته الجاية ${t2}` }
      : { full: `بورتال الكاشير ${state} ${since} — الكاشير اتبعتله الساعة ${t1} ولسه مافتحوش، ورسالته الجاية ${t2}`, short: `بورتال الكاشير ${state} ${since} — الكاشير اتبعتله ${t1} ولسه مافتحوش، رسالته الجاية ${t2}` };
  }
  if (reason === "cap") {
    const n = tanbihAr(Number(cap) || 0);
    return { full: `بورتال الكاشير ${state} ${since} — الكاشير خد ${n} النهارده (أقصى عدد) ومش هيوصله تاني النهارده`, short: `بورتال الكاشير ${state} ${since} — الكاشير خد ${n} النهارده (أقصى عدد)` };
  }
  const n = Number(alerts) || 0, d = delivered == null ? n : Math.max(0, Math.min(n, Number(delivered) || 0));
  if (d >= n) return one(`بورتال الكاشير ${state} ${since} رغم ${tanbihAr(n)} للكاشير`);
  if (d === 0) return one(`بورتال الكاشير ${state} ${since} — ومش قادرين نوصل للكاشير على واتساب (${tryAr(n)})`);
  return one(`بورتال الكاشير ${state} ${since} رغم ${tanbihAr(d)} ${d === 1 ? "وصل" : "وصلوا"} للكاشير (من ${tryAr(n)})`);
}
export const portalOfflineManagerText = (x) => `⚠️ ${managerLines(x).full}. الطلبات ومحادثات واتساب ممكن ماترنّش في المطعم.
البورتال ↗ ${PORTAL_URL}`;
export const portalOfflineManagerNotice = (x) => fitLine(managerLines(x).short, 120);
/* «رجع»: stable ⇒ at = بداية الفتحة اللي فضلت ظاهرة · kept (المراجعة التانية) ⇒ at = من إمتى مااتقفلش، بنص مايدّعيش إنه ثابت على الشاشة */
export const portalBackText = ({ at = null, kept = false, afterMin = null } = {}) => (kept
  ? `✅ بورتال الكاشير رجع يتفتح${at ? ` من ${riyadhHHMM(at)}` : ""} — كل كام دقيقة، ومافضلش مقفول${afterMin ? ` ${durAr(afterMin)}` : ""} ورا بعض (بس مش فاضل مفتوح على طول).`
  : `✅ تمام، بورتال الكاشير اتفتح تاني${at ? ` ومفتوح من ${riyadhHHMM(at)}` : ""}.`);

/* ═══ التشغيل ═════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const isOwner = ctx.isOwner || (async () => true);
  const wa = deps.wa || null;
  const sendSms = deps.sendSms || null;
  const clock = deps.now || (() => new Date());
  const log = deps.log || console;
  const q = async (sql, p = []) => { try { return (await pool.query(sql, p)).rows || []; } catch (e) { log.error("[wa-team] db:", e.message); return null; } };
  const ready = pool.query(DDL).then(() => pool.query(PORTAL_TO_SEED).catch((e) => log.error("[wa-team] portal seed:", e.message)))
    .then(() => pool.query("DELETE FROM wa_team_log WHERE at < NOW() - INTERVAL '90 days'").catch(() => {}))
    .then(() => pool.query("DELETE FROM wa_team_odd WHERE at < NOW() - INTERVAL '90 days'").catch(() => {})).then(() => true)
    .catch((e) => { log.error("[wa-team] schema:", e.message); return false; });
  const settingsNow = async () => { try { return (await getSettingsData()) || {}; } catch { return null; } };
  const flowApi = () => { try { return (typeof deps.flow === "function" ? deps.flow() : deps.flow) || null; } catch { return null; } };      // ST2: waflow.js
  const presenceApi = () => { try { return (typeof deps.presence === "function" ? deps.presence() : deps.presence) || null; } catch { return null; } };      // RG1: wahandover.js (حضور البوابة)

  const lastInOf = async (phone) => {
    const r = await q(`SELECT max(created_at) AS at FROM wa_messages WHERE phone_norm=$1 AND direction='in' AND COALESCE(source,'api') <> 'history'`, [phone]);
    return r && r[0] && r[0].at ? new Date(r[0].at).toISOString() : null;
  };
  const stateOf = async (phone) => { const r = await q("SELECT free_nudge_at, closed_nudge_at, closed_nudge_via, renewed_at FROM wa_team_state WHERE phone_norm=$1", [phone]); return (r && r[0]) || {}; };
  /* القالب معتمد؟ آخر حدث اعتماد من ميتا لنسخته العربي (wa_template_events) أو المالك أكّده في الإعدادات. مانعرفش ⇒ مش معتمد (مفيش نداء على الأعمى). */
  async function approved(cfg, name) {
    if (cfg.templatesApproved.includes(name)) return "owner";
    const r = await q("SELECT event FROM wa_template_events WHERE name=$1 AND COALESCE(language,'ar') LIKE 'ar%' ORDER BY at DESC, id DESC LIMIT 1", [name]);
    return r && r[0] && String(r[0].event || "").toUpperCase() === "APPROVED" ? "meta" : null;
  }
  const record = (m, x) => q("INSERT INTO wa_team_log(phone_norm, role, topic, kind, via, ok, error, ref4, urgent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [m.phone, m.role || null, clip(x.topic, 20), x.kind ? clip(x.kind, 40) : null, x.via, x.ok === true, x.error ? clip(x.error, 120) : null, x.ref4 || null, x.urgent === true]);
  /* ST2: أزرار إضافية قبل زر التجديد (لحد ٣ أزرار في الرسالة)، أو قايمة اختيارات (نتيجة القفل) */
  const freePayload = (body, button = true, extra = null, list = null) => {
    if (list && Array.isArray(list.rows) && list.rows.length) return { type: "interactive", interactive: { type: "list", body: { text: clip(body, 1024) },
      action: { button: clip(list.button, 20), sections: [{ title: clip(list.button, 24), rows: list.rows.slice(0, 10).map((r) => ({ id: clip(r.id, 200), title: clip(r.title, 24) })) }] } } };
    const btns = [...(Array.isArray(extra) ? extra : []).map((b) => ({ type: "reply", reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })), ...(button ? [{ type: "reply", reply: { id: RENEW_ID, title: RENEW_TITLE } }] : [])].slice(0, 3);
    return btns.length ? { type: "interactive", interactive: { type: "button", body: { text: clip(body, 1024) }, action: { buttons: btns } } }
      : { type: "text", text: { body: clip(body, 4096), preview_url: false } };
  };

  /* إرسال لموظف واحد. msg: { topic, kind, body, button?, templates?: [{ name, data }], sms?: string|null, ref4?, urgent? }
     ⇒ { ok, via: "wa_free" | "wa_template" | "sms" | "none", error? }. عمرها ما بترمي، وكل محاولة بتتسجّل في wa_team_log. */
  async function sendToStaff(cfg, member, msg) {
    const m = { phone: normPh(member && member.phone), role: member && member.role };
    const meta = { topic: msg.topic, kind: msg.kind || null, ref4: msg.ref4 || null, urgent: msg.urgent === true };
    const done = async (via, ok, error = null) => { await record(m, { ...meta, via, ok, error }); return { ok, via, ...(error ? { error } : {}) }; };
    if (!m.phone || !cfg.members.some((x) => x.phone === m.phone && x.active)) return { ok: false, via: "none", error: "not_staff" };      // مش في الدليل ⇒ ولا محاولة
    let why = "wa_off";
    if (cfg.enabled && wa && typeof wa.sendFreeform === "function") {
      await ready;
      const win = windowState(await lastInOf(m.phone), clock());
      why = "window_closed";
      if (win.open) {
        const rich = freePayload(msg.body, msg.button !== false, msg.buttons || null, msg.list || null);
        let r = await wa.sendFreeform({ phoneNorm: m.phone, payload: rich, source: "team", preview: clip(msg.body, 500) });
        if (!r.ok && !r.skipped && rich.type === "interactive") r = await wa.sendFreeform({ phoneNorm: m.phone, payload: freePayload(msg.body, false), source: "team", preview: clip(msg.body, 500) });
        if (r.ok) return done("wa_free", true);
        why = r.skipped || r.error || "send_failed";
      }
      /* النافذة مقفولة (أو الحر اترفض): قالب فريق معتمد — أول واحد معتمد من القايمة */
      if (typeof wa.sendStaffTemplate === "function" && ["window_closed", "WA_131047"].includes(String(why))) {
        for (const t of msg.templates || []) {
          if (!(await approved(cfg, t.name))) continue;
          const r = await wa.sendStaffTemplate({ phoneNorm: m.phone, template: t.name, data: t.data || {}, lang: "ar" });
          if (r.ok) return done("wa_template", true);
          why = `template:${r.skipped || r.error || "send_failed"}`;
          break;
        }
      }
    }
    if (msg.sms && sendSms) {
      try { const r = await sendSms({ phoneNorm: m.phone, body: fitOneSms(msg.sms), kind: "staff", ref: msg.smsRef || `wabot ${msg.kind || msg.topic}` }); return done("sms", !(r && r.suppressed), r && r.suppressed ? `suppressed after ${why}` : `fallback after ${why}`); }
      catch (e) { log.error(`[wa-team] sms → ${last4(m.phone)} failed:`, e.message); return done("sms", false, `sms_failed after ${why}`); }
    }
    return done("none", false, why);
  }
  const fanOut = async (cfg, members, build) => {
    const out = { sent: 0, wa: 0, sms: 0, failed: 0, to: members.length };
    for (const m of members) { const r = await sendToStaff(cfg, m, build(m)); if (r.ok) { out.sent++; if (r.via === "sms") out.sms++; else out.wa++; } else out.failed++; }
    return out;
  };
  const lastCustomerText = async (phone) => { const r = await q("SELECT body FROM wa_messages WHERE phone_norm=$1 AND direction='in' ORDER BY created_at DESC LIMIT 1", [phone]); return r && r[0] ? maskText(r[0].body) : null; };
  const excerptOf = async (phone, n) => {
    if (!phone || !(n > 0)) return [];
    const r = await q("SELECT direction, body FROM wa_messages WHERE phone_norm=$1 AND COALESCE(source,'api') <> 'history' ORDER BY created_at DESC, id DESC LIMIT $2", [phone, n]);
    return excerptLines((r || []).reverse());
  };

  /* ── ١) تحويل لموظف (جديد / تذكير / اتفتح تاني) ───────────────────────────
     ⇒ null لو واتساب الفريق مقفول أو مفيش مستلمين (المنادي يكمل بالـSMS القديم) · وإلا { sent, wa, sms, failed, to }. */
  async function handover({ settings, phone, reason, reasonAr = null, urgent = false, orderNo = null, stage = "new", waitedMin = null, sms = null }) {
    const cfg = teamConfig(settings || (await settingsNow()) || {});
    if (!cfg.enabled) return null;
    /* ST2: سلّم التصعيد شغّال ⇒ waflow هو اللي بيقرر مين يتبلّغ دلوقتي (الكاشير أولاً) وبيصعّد بعدين */
    { const fl = flowApi(); if (fl && cfg.ladder.enabled && typeof fl.onHandover === "function") return fl.onHandover({ cfg, phone, reason, reasonAr, urgent, orderNo, stage, waitedMin, sms }); }
    /* RV1: «تقييم واطي» للمدير والملاك بس — الكاشير مابيتبلّغش (التقييمات الواطية «عند المدير»، reviewaudience.js) */
    const to = recipientsFor(cfg, urgent ? ["handover", "urgent"] : ["handover"]).filter((m) => !isReviewHandover(reason) || m.role !== "cashier");
    if (!to.length) return null;
    const body = handoverText({ phone, reasonAr: reasonAr || reason, urgent, orderNo, stage, waitedMin, lastText: await lastCustomerText(phone) });
    const summary = clip(`عميل ${last4(phone)} محتاج موظف (${reasonAr || reason})${stage === "reminder" ? " — تذكير" : ""}`, 120);
    return fanOut(cfg, to, () => ({ topic: urgent ? "urgent" : "handover", kind: reason, body, ref4: String(phone || "").slice(-4), urgent,
      templates: [{ name: TPL_NOTICE, data: { notice: { text: summary } } }, { name: TPL_HANDOFF, data: { handoff: { reasonText: reasonAr || reason, summary: `عميل ${last4(phone)}${orderNo ? ` طلب ${orderNo}` : ""}` } } }],
      sms: cfg.smsFallback ? sms : null, smsRef: `wabot ${reason}` }));
  }

  /* ── ٣) حاجات غريبة ─────────────────────────────────────────────────────────
     ⇒ "off" | "kind_off" | "repeat" | "queued" (ملخص) | "held" (سقف الساعة) | "sent" | "failed" | "no_recipients". عمرها ما بترمي. */
  async function odd({ kind, phone = null, detail = null, tried = null, settings = null, repeatMin = null } = {}) {
    try {
      if (!ODD_KEYS.includes(kind)) return "kind_off";
      const cfg = teamConfig(settings || (await settingsNow()) || {});
      if (!cfg.enabled || !cfg.odd.enabled) return "off";
      if (!cfg.odd.kinds[kind]) return "kind_off";
      const p = phone ? normPh(phone) : null;
      if (p && cfg.members.some((m) => m.phone === p)) return "off";      // موظف مش «عميل غريب»
      await ready;
      const now = clock();
      const rep = await q(`SELECT 1 FROM wa_team_odd WHERE kind=$1 AND COALESCE(phone_norm,'') = $2 AND at > $3 LIMIT 1`, [kind, p || "", new Date(now.getTime() - Math.max(cfg.odd.repeatMin, Math.min(Number(repeatMin) || 0, 1440)) * 60_000).toISOString()]);
      if (rep === null) return "failed";
      if (rep.length) return "repeat";
      const ins = await q("INSERT INTO wa_team_odd(at, kind, phone_norm, detail, tried, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id", [now.toISOString(), kind, p, detail ? clip(maskText(detail), 200) : null, tried ? clip(tried, 300) : null]);
      if (!ins || !ins.length) return "failed";
      const id = ins[0].id;
      if (cfg.odd.quiet && cfg.odd.quiet[kind]) { await q("UPDATE wa_team_odd SET status='quiet' WHERE id=$1", [id]); return "quiet"; }      // بيتعدّ بس (الملخص اليومي + اللوحة)
      if (cfg.odd.digest) return "queued";
      const n = await q("SELECT count(*)::int AS n FROM wa_team_odd WHERE status='sent' AND sent_at > $1", [new Date(now.getTime() - H).toISOString()]);
      if (n === null || Number(n[0] && n[0].n) >= cfg.odd.perHour) { await q("UPDATE wa_team_odd SET status='held' WHERE id=$1", [id]); return "held"; }
      const to = recipientsFor(cfg, "odd");
      if (!to.length) { await q("UPDATE wa_team_odd SET status='no_recipients' WHERE id=$1", [id]); return "no_recipients"; }
      const row = { kind, phone: p, detail: detail ? clip(maskText(detail), 200) : null, tried: tried ? clip(tried, 300) : null };
      const body = oddText({ ...row, excerpt: await excerptOf(p, cfg.odd.excerpt) });
      const r = await fanOut(cfg, to, () => ({ topic: "odd", kind, body, ref4: p ? p.slice(-4) : null, templates: [{ name: TPL_NOTICE, data: { notice: { text: oddSummary(row) } } }],
        sms: cfg.odd.smsFallback ? `Fresh Cuts WhatsApp: ${kind.replace(/_/g, " ")}${p ? ` (customer ${last4(p).slice(1)})` : ""}. Open the dashboard inbox.` : null, smsRef: `wabot odd_${kind}` }));
      await q("UPDATE wa_team_odd SET status=$2, sent_at=$3 WHERE id=$1", [id, r.sent ? "sent" : "failed", now.toISOString()]);
      return r.sent ? "sent" : "failed";
    } catch (e) { log.error("[wa-team] odd:", e.message); return "failed"; }
  }
  /* الملخص: وضع digest كل digestEveryMin، واللي اتأجّل بالسقف أول ما السقف يفك — رسالة واحدة تجمعهم (وبتتحسب واحدة في السقف). */
  let digestAt = -1e15;
  async function flushOdd(cfg, now) {
    const want = cfg.odd.digest ? ["pending", "held"] : ["held"];
    if (cfg.odd.digest && now.getTime() - digestAt < cfg.odd.digestEveryMin * 60_000 && now.getTime() >= digestAt) return 0;
    const rows = await q("SELECT id, at, kind, phone_norm, status FROM wa_team_odd WHERE status = ANY($1::text[]) AND at > $2 ORDER BY at LIMIT 40", [want, new Date(now.getTime() - 24 * H).toISOString()]);
    if (!rows || !rows.length) { if (cfg.odd.digest) digestAt = now.getTime(); return 0; }
    const n = await q("SELECT count(*)::int AS n FROM wa_team_odd WHERE status='sent' AND sent_at > $1", [new Date(now.getTime() - H).toISOString()]);
    if (n === null || Number(n[0] && n[0].n) >= cfg.odd.perHour) return 0;
    const ids = rows.map((r) => r.id);
    const claim = await q("UPDATE wa_team_odd SET status='sending' WHERE id = ANY($1::bigint[]) AND status = ANY($2::text[]) RETURNING id", [ids, want]);
    if (!claim || !claim.length) return 0;
    digestAt = now.getTime();
    const to = recipientsFor(cfg, "odd");
    const body = oddDigestText(rows, { held: !cfg.odd.digest });
    const r = to.length ? await fanOut(cfg, to, () => ({ topic: "odd", kind: "digest", body, templates: [{ name: TPL_NOTICE, data: { notice: { text: `${rows.length} حاجة غريبة في محادثات واتساب` } } }], sms: null })) : { sent: 0 };
    /* صف واحد بس بيتحسب «sent» في سقف الساعة؛ الباقي digest */
    await q("UPDATE wa_team_odd SET status = CASE WHEN id=$2 THEN $3 ELSE 'digest' END, sent_at=$4 WHERE id = ANY($1::bigint[])", [ids, ids[0], r.sent ? "sent" : "failed", now.toISOString()]);
    return rows.length;
  }

  /* ── ٢) حارس النافذة ─────────────────────────────────────────────────────── */
  async function keeperFor(cfg, m, now, sc) {
    const lastIn = await lastInOf(m.phone), st = await stateOf(m.phone);
    const plan = keeperPlan({ now, lastInAt: lastIn, state: { freeNudgeAt: st.free_nudge_at, closedNudgeAt: st.closed_nudge_at }, keeper: cfg.keeper });
    if (plan.action === "none") return plan;
    /* الحجز قبل الإرسال: لو السيرفر وقع في النص، مفيش رسالة تانية (الأمان قبل الاكتمال) */
    const col = plan.action === "free" ? "free_nudge_at" : "closed_nudge_at";
    const claim = await q(`INSERT INTO wa_team_state(phone_norm, ${col}, updated_at) VALUES ($1,$2,NOW())
                           ON CONFLICT (phone_norm) DO UPDATE SET ${col}=$2, updated_at=NOW() RETURNING phone_norm`, [m.phone, now.toISOString()]);
    if (!claim || !claim.length) return { action: "none", why: "state_db" };
    if (plan.action === "free") {
      const win = windowState(lastIn, now);
      const r = await sendToStaff(cfg, m, { topic: "keeper", kind: "renew_free", body: keeperFreeText({ minutesLeft: win.minutesLeft }), templates: [], sms: null });
      return { ...plan, sent: r };
    }
    const r = await sendToStaff(cfg, m, { topic: "keeper", kind: "renew_closed", body: "", templates: [{ name: TPL_RENEW, data: {} }], sms: cfg.keeper.smsNudge ? keeperSms(sc.lang) : null, smsRef: "wabot team_renew" });
    await q("UPDATE wa_team_state SET closed_nudge_via=$2 WHERE phone_norm=$1", [m.phone, r.via]);
    return { ...plan, sent: r };
  }
  async function dailyData(cfg, now) {
    const since = new Date(now.getTime() - 24 * H).toISOString();
    const ho = await q(`SELECT count(DISTINCT (ref4, kind, date_trunc('minute', at)))::int AS n, count(DISTINCT (ref4, kind, date_trunc('minute', at))) FILTER (WHERE urgent)::int AS u,
                               count(*) FILTER (WHERE via='sms' AND ok)::int AS sms FROM wa_team_log WHERE topic IN ('handover','urgent') AND at > $1`, [since]);
    const od = await q("SELECT kind, count(*)::int AS n FROM wa_team_odd WHERE at > $1 GROUP BY 1 ORDER BY 2 DESC", [since]);
    const closed = [];
    for (const m of cfg.members.filter((x) => x.active)) if (!windowState(await lastInOf(m.phone), now).open) closed.push(m.name || last4(m.phone));
    let pl = null; try { const api = typeof deps.phoneLists === "function" ? deps.phoneLists() : deps.phoneLists; pl = api && typeof api.flagCount === "function" ? await api.flagCount() : null; } catch { pl = null; }      // SX1
    return { handovers: Number(ho && ho[0] && ho[0].n) || 0, urgent: Number(ho && ho[0] && ho[0].u) || 0, bySms: Number(ho && ho[0] && ho[0].sms) || 0, odd: od || [], closed,
      staffFlags: Number(pl && pl.flagged) || 0, staffReview: Number(pl && pl.review) || 0 };
  }
  async function dailyDigest(cfg, now, { only = null } = {}) {
    const to = only ? [only] : recipientsFor(cfg, "digest");
    if (!to.length) return { sent: 0, to: 0 };
    const d = await dailyData(cfg, now), body = dailyText(d);
    const total = d.odd.reduce((a, r) => a + Number(r.n || 0), 0);
    return fanOut(cfg, to, () => ({ topic: "digest", kind: "daily", body, templates: [{ name: TPL_NOTICE, data: { notice: { text: `ملخص آخر ٢٤ ساعة: ${d.handovers} تحويل لموظف و${total} حاجة غريبة` } } }], sms: null }));
  }
  /* ── RG1 + PO1: البورتال مقفول وقت الشغل ⇒ واتساب للكاشير، وبعدها المدير ──────────────────────────────
     الحلقة (صف wa_team_portal id='cashier'): بتبدأ أول دورة البورتال فيها «مقفول» وقت الشغل (opened_at = وقت الدورة دي)، وبتخلص لما:
       • stable: جهاز كاشير يفضل مفتوح backStableMin ورا بعض، أو
       • kept (المراجعة التانية): البورتال مايتقفلش بقاعدة التنبيه keepMinOf دقيقة ورا بعض (reopened_at = بداية الفترة دي، بتتمسح أول دورة مقفولة)
     ⇒ مسح الصف (هو الحجز) و«رجع» على طول للمدير اللي اتبلّغ فيها. بره وقت الشغل ⇒ الصف بيتمسح في صمت. مهلة afterMin بعد بداية الشغل أو رجوعه
     ⇒ مفيش حلقة جديدة ولا رسايل، بس الحلقة اللي موجودة بتفضل (كانت بتتمسح من غير «رجع»).
     كل رسالة «مقفول» بتتحجز للرقم قبل الإرسال (wa_team_portal_to): التكرار والسقف اليومي لكل موظف مش لكل حلقة. ⇒ وصف اللي حصل (للاختبار والسجل). */
  const MIN = 60_000;
  const tms = (v) => (v ? new Date(v).getTime() : NaN);
  const isoOf = (v) => { if (v == null || v === "") return null; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };
  /* حجز رسالة «مقفول» لرقم: مفيش رسالة كاشير/مدير قبل repeatMin من آخر واحدة (بسماح PORTAL_SLACK_MS لتذبذب الدورة). «رجع» مابتحجزش.
     ⇒ { ok: true } أو { ok: false, lastAt, until (إمتى الرقم ده يقدر ياخد تاني), db (القاعدة ماردّتش) } */
  async function claimTo(phone, now, po, kind) {
    const at = now.toISOString(), cut = new Date(now.getTime() - po.repeatMin * MIN + PORTAL_SLACK_MS).toISOString();
    const r = await q(`INSERT INTO wa_team_portal_to(phone_norm, last_at, last_mgr_at) VALUES ($1,$2::timestamptz,$4::timestamptz)
        ON CONFLICT (phone_norm) DO UPDATE SET last_at=$2::timestamptz, last_mgr_at=COALESCE($4::timestamptz, wa_team_portal_to.last_mgr_at)
        WHERE wa_team_portal_to.last_at IS NULL OR wa_team_portal_to.last_at <= $3::timestamptz RETURNING phone_norm`, [phone, at, cut, kind === "manager" ? at : null]);
    if (r && r.length) return { ok: true };
    if (r === null) return { ok: false, db: true, lastAt: null, until: null };
    const s = await q("SELECT last_at FROM wa_team_portal_to WHERE phone_norm=$1", [phone]);
    const last = tms(s && s[0] && s[0].last_at);
    return Number.isFinite(last) ? { ok: false, lastAt: isoOf(last), until: isoOf(last + po.repeatMin * MIN - PORTAL_SLACK_MS) } : { ok: false, lastAt: null, until: null };
  }
  /* رسايل «مقفول» من السجل لكل رقم: day = كاشير + مدير **وصلوا** في اليوم التشغيلي (السقف — «رجع» واللي ماوصلش مابيتحسبوش) ·
     lastMgr = آخر رسالة مدير وصلت من from (بداية الحلقة) ⇒ المدير اتبلّغ في المرة دي؟ · cashOk = تنبيهات كاشير وصلت للرقم ده من from ·
     mgrFail = محاولات مدير فشلت من from **بعد آخر رسالة مدير وصلت** (مراجعة ١٥/١٠: مش كل فشل المرة — فشل ⇐ وصل ⇐ فشل = ١، مش ٢) */
  async function portalLog(now, from = null) {
    const day = bizStart(bizDay(now)).toISOString();
    const rows = await q(`SELECT phone_norm, count(*) FILTER (WHERE kind IN ('cashier','manager') AND ok AND at >= $1::timestamptz)::int AS day,
        max(at) FILTER (WHERE kind='manager' AND ok AND at >= $2::timestamptz) AS last_mgr,
        count(*) FILTER (WHERE kind='cashier' AND ok AND at >= $2::timestamptz)::int AS cash_ok,
        array_agg(at ORDER BY at) FILTER (WHERE kind='manager' AND NOT ok AND at >= $2::timestamptz) AS mgr_fails FROM wa_team_log
        WHERE topic='portal_offline' AND at >= LEAST($1::timestamptz, $2::timestamptz) GROUP BY phone_norm`, [day, from || day]);
    if (rows === null) return null;
    const m = new Map();
    for (const r of rows) {
      const lastMgr = tms(r.last_mgr), fails = (Array.isArray(r.mgr_fails) ? r.mgr_fails : []).map(tms).filter(Number.isFinite);
      m.set(r.phone_norm, { day: Number(r.day) || 0, lastMgr, cashOk: Number(r.cash_ok) || 0, mgrFail: fails.filter((f) => !(f <= lastMgr)).length });
    }
    return m;
  }
  /* وقت الشغل زي ما الدورة شافته (في الذاكرة): open = المواعيد + المطعم مش متوقف (من غير مهلة) · work = عدّت مهلة afterMin من بداية الشغل أو من
     رجوعه بعد إيقاف شافته الدورة. أول دورة بعد تشغيل جديد بس (on === null) بتقرا آخر رجوع متسجّل (settings.service.resumedAt) لو لسه جوّه
     المهلة — مرة واحدة: resumedAt بيتكتب مع أي رجوع (حتى التوصيل لوحده والاستلام شغّال طول الوقت، أو إيقاف بميعاد خلص)، فقرايته كل دورة بعد
     التشغيل كانت بتعمل «مهلة» afterMin بعد كل رجوع جزئي (المراجعة التانية). */
  let workSeen = { on: null, since: null };
  function workState(settings, now, afterMin) {
    const t = now.getTime();
    if (!workingNow(settings, now)) { workSeen = { on: false, since: null }; return { open: false, work: false, since: null }; }
    if (workSeen.on === false) workSeen = { on: true, since: t };
    else if (workSeen.on === null) {
      const r = tms(settings && settings.service && settings.service.resumedAt);
      workSeen = { on: true, since: Number.isFinite(r) && r <= t && t - r < afterMin * MIN ? r : null };
    }
    return { open: true, work: workingNow(settings, now, afterMin, workSeen.since), since: workSeen.since };
  }
  /* المدة اللي في الرسالة: من آخر إشارة؛ ولو آخر إشارة قبل بداية الشغل (بالمواعيد أو الرجوع من إيقاف) ⇒ «من أول الشغل». startAt = بداية القفلة دي */
  function closureOf(settings, now, sig, ws) {
    const t = now.getTime(), ls = tms(sig.lastSeen);
    const start = Math.max(tms(workStartOf(settings, now)) || -Infinity, Number.isFinite(ws.since) ? ws.since : -Infinity);
    if (!Number.isFinite(ls) || (Number.isFinite(start) && ls < start)) {
      return { offMin: Number.isFinite(start) ? Math.max(0, Math.floor((t - start) / MIN)) : null, fromStart: true, hidden: sig.hidden === true, startAt: Number.isFinite(start) ? isoOf(start) : null };
    }
    return { offMin: Math.max(0, Math.floor((t - ls) / MIN)), fromStart: false, hidden: sig.hidden === true, startAt: isoOf(ls) };
  }
  /* الحلقة خلصت (how = { kind: "stable" | "kept", at }): مسح الصف هو الحجز (دورتين مع بعض ⇒ واحدة بس تبعت)، و«رجع» على طول للمدير اللي اتبلّغ
     فيها (رسالة مدير وصلت من opened_at). مابتستناش التكرار ولا بتاخد منه، ومفتاح backNotice بيتشاف لحظة الإرسال. */
  async function endEpisode(cfg, managers, ep, now, po, how) {
    const del = await q("DELETE FROM wa_team_portal WHERE id='cashier' RETURNING since", []);
    if (del === null) return { error: "state_db" };
    if (!del.length) return { owed: 0, sent: [] };
    const opened = ep.opened_at || ep.since || null;
    if (!po.backNotice) return { owed: 0, sent: [], off: true };
    if (!managers.length || !opened) return { owed: 0, sent: [] };
    const log = await portalLog(now, isoOf(opened));
    if (log === null) return { error: "log_db" };
    const owed = managers.filter((m) => { const r = log.get(m.phone); return r && Number.isFinite(r.lastMgr) && r.lastMgr >= tms(opened); });
    const body = portalBackText({ at: how.at || now.toISOString(), kept: how.kind === "kept", afterMin: po.afterMin });
    const sent = [];
    for (const m of owed) {
      await q("UPDATE wa_team_portal_to SET last_back_at=$2 WHERE phone_norm=$1", [m.phone, now.toISOString()]);
      const r = await sendToStaff(cfg, m, { topic: "portal_offline", kind: "back", body, button: false, templates: [], sms: null });
      sent.push({ to: last4(m.phone), via: r.via, ok: r.ok });
    }
    return { owed: owed.length, sent };
  }
  /* القاعدة مش بتتقري ⇒ التنبيه واقف: يتسجّل في اللوج (أول مرة وبعدها كل ١٠ دقايق)، واللوحة بتقوله من portalStatus.error (المراجعة التانية) */
  let troubleAt = -Infinity;
  const dbTrouble = (kind) => { const t = clock().getTime(); if (t - troubleAt >= 10 * MIN) { troubleAt = t; try { log.error(`[wa-team] portal watch: ${kind} — «البورتال مقفول» واقف لحد ما القاعدة تتقري`); } catch { /* */ } } };
  async function portalWatch(cfg, settings, now) {
    const po = cfg.portalOffline;
    if (!po.enabled) return { skipped: "off" };
    const pres = presenceApi();
    if (!pres || typeof pres.presence !== "function") return { skipped: "no_presence" };
    const cashiers = cfg.members.filter((m) => m.active && m.role === "cashier"), managers = cfg.members.filter((m) => m.active && m.role === "manager");
    if (!cashiers.length) return { skipped: "no_cashier" };
    const list = await pres.presence();
    if (list === null) { dbTrouble("presence_db"); return { skipped: "presence_db" }; }
    const sig = portalSignal(list, now, po), ws = workState(settings, now, po.afterMin), work = ws.work;
    const st0 = await q("SELECT since, alerts, last_alert_at, manager_told, opened_at, reopened_at FROM wa_team_portal WHERE id='cashier'", []);
    if (st0 === null) { dbTrouble("state_db"); return { skipped: "state_db" }; }
    const ep = st0[0] || null, base = { offline: sig.closed, stable: sig.stable, work, offMin: sig.offMin, ...(sig.hidden ? { hidden: true } : {}) };
    if (!ws.open) {
      if (ep) await q("DELETE FROM wa_team_portal WHERE id='cashier'", []);
      return { ...base, cleared: Boolean(ep) };
    }
    const t = now.getTime();
    if (!sig.closed) {
      if (!ep) return base;
      if (sig.stable) return { ...base, ended: "stable", back: await endEpisode(cfg, managers, ep, now, po, { kind: "stable", at: sig.streakStart }) };
      /* مش ثابت (بصّة أو بصّات): الحلقة مكمّلة من غير رسايل — إلا لو مااتقفلش keepMinOf دقيقة ورا بعض */
      const keep = keepMinOf(po) * MIN, ro = tms(ep.reopened_at);
      if (!Number.isFinite(ro)) {
        const at = sig.openSince || sig.lastSeen || now.toISOString();
        await q("UPDATE wa_team_portal SET reopened_at=$1 WHERE id='cashier' AND reopened_at IS NULL", [at]);
        return { ...base, waitingStable: true, reopenedAt: at, endsAt: isoOf(tms(at) + keep) };
      }
      if (t - ro >= keep) return { ...base, ended: "kept", back: await endEpisode(cfg, managers, ep, now, po, { kind: "kept", at: isoOf(ro) }) };
      return { ...base, waitingStable: true, reopenedAt: isoOf(ro), endsAt: isoOf(ro + keep) };
    }
    /* مقفول */
    if (ep && ep.reopened_at) await q("UPDATE wa_team_portal SET reopened_at=NULL WHERE id='cashier'", []);
    if (!work) return { ...base, grace: true };      // مهلة afterMin بعد بداية الشغل / رجوعه: مفيش حلقة جديدة ولا رسايل، واللي موجودة بتفضل
    let clv = null;
    const clo = () => clv || (clv = closureOf(settings, now, sig, ws));
    let e = ep;
    if (!e) {
      e = { since: clo().startAt || now.toISOString(), alerts: 0, last_alert_at: null, manager_told: false, opened_at: now.toISOString() };
      await q("INSERT INTO wa_team_portal(id, since, alerts, manager_told, opened_at) VALUES ('cashier', $1, 0, FALSE, $2) ON CONFLICT (id) DO NOTHING", [e.since, e.opened_at]);
    }
    const opened = e.opened_at || e.since || null;
    const log = await portalLog(now, isoOf(opened));
    if (log === null) { dbTrouble("log_db"); return { ...base, skipped: "log_db" }; }
    const of = (m) => log.get(m.phone) || { day: 0, lastMgr: NaN, cashOk: 0, mgrFail: 0 };
    const capped = (m) => of(m).day >= po.dailyCap;
    /* alerts = جولات اتبعتت للكاشير في المرة دي (السلّم بيمشي بيها حتى لو الإرسال فشل — رقم كاشير مش بيوصله واتساب لازم يوصل للمدير برضه)،
       delivered = جولات وصلت لكاشير واحد على الأقل (من السجل) ⇒ رسالة المدير بتقول اللي وصل بس */
    const alerts = Number(e.alerts) || 0, delivered = Math.min(alerts, Math.max(0, ...cashiers.map((m) => of(m).cashOk)));
    /* الدور على مين؟ الكاشير لحد managerAfter جولة في المرة دي؛ بعدها — أو لو الكاشير وصل للسقف اليومي — المدير. المدير وصل للسقف (أو
       مفيش مدير) ⇒ الكاشير يكمّل لحد سقفه: الرسايل ماتقفش طول ما فيه حد ليه رصيد. */
    const reason = !cashiers.some((m) => !capped(m)) ? "cap" : alerts >= po.managerAfter ? "ignored" : null;
    /* مدير واتساب مش بيوصله = آخر MGR_FAIL_MAX محاولات ليه في المرة دي فشلوا (الفشل بعد آخر رسالة وصلتله بس): مايمسكش الدور — الكاشير ياخد
       بدل ما الكل يسكت (الفشل مابيتحسبش في السقف، فكان بيمسك الدور طول القفلة). وطول ما الدور كان هيبقى عليه (reason) بنفضل نجرّبه: الحجز
       بيخلّيها محاولة كل repeatMin للرقم، والفشل مابياخدش من رصيده، وأول رسالة توصله بترجّعله الدور (مراجعة ١٥/١٠: كان بيتساب للآخر، فمدير
       رجع واتساب بتاعه يشتغل كان بيتعدّى، والكل يسكت أول ما الكاشير يخلّص رصيده). */
    const unreachable = (m) => of(m).mgrFail >= MGR_FAIL_MAX;
    const managerTurn = reason !== null && managers.some((m) => !capped(m) && !unreachable(m));
    const retry = reason !== null && !managerTurn && managers.some((m) => !capped(m));      // كل مدير ليه رصيد هنا مش بيوصله
    const heldOf = (m, c) => ({ to: last4(m.phone), why: c.db ? "state_db" : "repeat", ...(c.until ? { lastAt: c.lastAt, until: c.until } : {}) });
    const sent = [], held = [];
    if (managerTurn) for (const m of cashiers) held.push({ to: last4(m.phone), why: capped(m) ? "daily_cap" : "manager_turn" });
    else {
      for (const m of cashiers) {
        if (capped(m)) { held.push({ to: last4(m.phone), why: "daily_cap" }); continue; }
        const c = await claimTo(m.phone, now, po, "cashier");
        if (!c.ok) { held.push(heldOf(m, c)); continue; }
        const r = await sendToStaff(cfg, m, { topic: "portal_offline", kind: "cashier", body: portalOfflineText(clo()), button: true,
          templates: [{ name: TPL_NOTICE, data: { notice: { text: portalOfflineNotice(clo()) } } }], sms: null });
        sent.push({ to: last4(m.phone), via: r.via, ok: r.ok });
      }
      /* الجولة بتتعدّ في السلّم حتى لو فشلت (الحجز اتاخد ⇒ المحاولة الجاية بعد repeatMin)، بس مابتاخدش من السقف (portalLog بيعدّ ok بس) */
      if (sent.length) await q("UPDATE wa_team_portal SET alerts=alerts+1, last_alert_at=$1 WHERE id='cashier'", [now.toISOString()]);
    }
    /* اتقفل تاني والكاشير لسه واخد رسالة (managerOnHold، مقفول افتراضي): لسه مفيش تنبيه في المرة دي، وكل كاشير ليه رصيد محجوز بالتكرار ⇒ المدير
       مرة واحدة في المرة دي على طول، بالحقيقة: الكاشير اتبعتله إمتى، فتحه بعدها ولا لأ، ورسالته الجاية إمتى. */
    const repeatHeld = held.filter((h) => h.why === "repeat");
    const hold = !managerTurn && po.managerOnHold === true && alerts === 0 && e.manager_told !== true && !sent.length
      && repeatHeld.length > 0 && repeatHeld.every((h) => h.until) && held.every((h) => h.why === "repeat" || h.why === "daily_cap");
    let mgr = null;
    if (managerTurn || hold || retry) {
      /* أول رسالة مدير بعد السلّم: في ميعاد التنبيه اللي كان على الكاشير (مش على طول بعد آخر تنبيه ليه في المرة دي). hold ⇒ على طول. بعدها التكرار لكل رقم هو اللي بيظبط.
         retry (المدير مش بيوصله والتنبيهات رجعت للكاشير) ⇒ الحجز لوحده: محاولة كل repeatMin من آخر محاولة ليه — بس مش في نفس دورة جولة كاشير:
         بيستنى الدورة الجاية (دقيقة)، فمفيش رسالتين في نفس الثانية، و«رغم N» بتعدّ الجولة دي (كانت بتقول ٥ والجولة السادسة لسه طالعة) */
      const due = hold || (retry ? !sent.length : (!Number.isFinite(tms(e.last_alert_at)) || t - tms(e.last_alert_at) >= po.repeatMin * MIN - PORTAL_SLACK_MS));
      const lastCash = hold ? Math.max(...repeatHeld.map((h) => tms(h.lastAt))) : NaN;
      const heldInfo = hold ? { lastAt: isoOf(lastCash), until: isoOf(Math.min(...repeatHeld.map((h) => tms(h.until)))), opened: tms(sig.lastSeen) > lastCash } : null;
      const out = [];
      for (const m of managers) {
        if (capped(m)) { held.push({ to: last4(m.phone), why: "daily_cap" }); continue; }
        if (!due) { held.push({ to: last4(m.phone), why: "not_due" }); continue; }
        const c = await claimTo(m.phone, now, po, "manager");
        if (!c.ok) { held.push(heldOf(m, c)); continue; }
        const reminder = !hold && of(m).lastMgr >= tms(opened);
        const x = { ...clo(), alerts, delivered, reason: hold ? "hold" : reason, cap: Math.max(po.dailyCap, ...cashiers.map((k) => of(k).day)), reminder,
          reopened: reminder && tms(sig.lastSeen) > of(m).lastMgr, held: heldInfo };      // cap = اللي الكاشير خده فعلاً النهارده
        const r = await sendToStaff(cfg, m, { topic: "portal_offline", kind: "manager", body: portalOfflineManagerText(x), button: true,
          templates: [{ name: TPL_NOTICE, data: { notice: { text: portalOfflineManagerNotice(x) } } }], sms: null });
        out.push({ to: last4(m.phone), via: r.via, ok: r.ok, reminder, ...(hold ? { hold: true } : {}), ...(retry ? { retry: true } : {}) });
      }
      /* «المدير اتبلّغ» = رسالة وصلت بس (لو فشلت، رسالة المدير الجاية مش «تذكير» و«رجع» مش مستحقة) */
      if (out.some((x) => x.ok)) await q("UPDATE wa_team_portal SET manager_told=TRUE WHERE id='cashier'", []);
      if (out.length) mgr = { sent: out.filter((x) => x.ok).length, to: out, reason: hold ? "hold" : reason };
    }
    const gone = managers.filter((m) => !capped(m) && unreachable(m)).map((m) => last4(m.phone));
    return { ...base, stage: managerTurn ? "manager" : "cashier", round: sent.length ? alerts + 1 : 0, cashiers: sent, held, manager: mgr, ...(gone.length ? { unreachable: gone } : {}) };
  }

  /* دورة كل دقيقة: حارس النافذة لكل عضو، ملخص الحاجات الغريبة، سلسلة فشل الإرسال، والملخص اليومي. عمرها ما بترمي. */
  let ticking = false;
  async function tick() {
    if (ticking) return { skipped: "busy" };
    ticking = true;
    const out = { keeper: [], odd: 0, daily: null, portal: null };
    try {
      await ready;
      const settings = await settingsNow();
      if (!settings) return { skipped: "settings_unreadable" };
      const cfg = teamConfig(settings), now = clock(), sc = staffConfig(settings);
      if (!cfg.enabled) return { skipped: "off" };
      if (cfg.keeper.enabled) for (const m of cfg.members.filter((x) => x.active)) {
        try { const p = await keeperFor(cfg, m, now, sc); if (p.action !== "none") out.keeper.push({ to: last4(m.phone), action: p.action, via: p.sent && p.sent.via, ok: p.sent && p.sent.ok }); }
        catch (e) { log.error("[wa-team] keeper:", e.message); }
      }
      if (cfg.odd.enabled) {
        if (cfg.odd.kinds.send_failures) {
          const f = await q("SELECT count(*)::int AS n FROM wa_bot_log WHERE decision='failed' AND at > $1", [new Date(now.getTime() - cfg.odd.failWindowMin * 60_000).toISOString()]);
          if (f && Number(f[0] && f[0].n) >= cfg.odd.failStreak) await odd({ kind: "send_failures", detail: `${f[0].n} رد فشل إرساله في آخر ${cfg.odd.failWindowMin} دقيقة`, settings });
        }
        out.odd = await flushOdd(cfg, now);
      }
      try { out.portal = await portalWatch(cfg, settings, now); } catch (e) { log.error("[wa-team] portal watch:", e.message); }
      if (cfg.daily.enabled && riyadhMin(now) >= minOf(cfg.daily.at) && riyadhMin(now) < minOf(cfg.daily.at) + 30) {
        const key = "_daily", day = riyadhDay(now);
        const claim = await q(`INSERT INTO wa_team_state(phone_norm, closed_nudge_via, updated_at) VALUES ($1,$2,NOW())
                               ON CONFLICT (phone_norm) DO UPDATE SET closed_nudge_via=$2, updated_at=NOW() WHERE wa_team_state.closed_nudge_via IS DISTINCT FROM $2 RETURNING phone_norm`, [key, day]);
        if (claim && claim.length) out.daily = await dailyDigest(cfg, now);
      }
      return out;
    } catch (e) { log.error("[wa-team] tick:", e.message); return out; }
    finally { ticking = false; }
  }
  const timer = deps.noTimer ? null : setInterval(() => { tick().catch(() => {}); }, 60_000);
  if (timer && typeof timer.unref === "function") timer.unref();

  /* ── الوارد من رقم فريق ─────────────────────────────────────────────────────
     ⇒ false: مش رقم فريق (أو رقم تجربة والمالك سايبه يجرّب، والرسالة مش أمر) ⇒ البوت يكمل عادي.
     ⇒ true: اتمسكت هنا — البوت والمساعد والرد الآلي القديم مايشوفوهاش. */
  async function inbound(ev, settings = null) {
    try {
      if (!ev || ev.isEcho) return false;
      const s = settings || (await settingsNow());
      if (!s) return false;
      const cfg = teamConfig(s), phone = normPh(ev.phone || ev.phoneNorm);
      const m = cfg.members.find((x) => x.phone === phone && x.active);
      if (!m) return false;
      /* ST2: أزرار المحادثة («استلم المحادثة / رجّعها للبوت / خلصت — اقفل / حوّل للمدير»)، اختيار نتيجة القفل، وملاحظة التحويل المكتوبة */
      { const fl = flowApi(); if (fl && typeof fl.staffInbound === "function") { let took = false; try { took = (await fl.staffInbound(ev, m, cfg)) === true; } catch (e) { log.error("[wa-team] flow inbound:", e.message); } if (took) return true; } }
      const cmd = staffCommand(ev);
      const tester = cfg.staffAsTesters && staffPhones(s.waBot && s.waBot.testPhones).includes(phone);
      if (!cmd) return !tester;
      await ready;
      const now = clock();
      const say = (body, button = false) => sendToStaff(cfg, m, { topic: "reply", kind: cmd, body, button, templates: [], sms: null });
      if (cmd === "renew") {
        await q(`INSERT INTO wa_team_state(phone_norm, renewed_at, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (phone_norm) DO UPDATE SET renewed_at=$2, updated_at=NOW()`, [phone, now.toISOString()]);
        await say(renewedText({ name: m.name, until: new Date(now.getTime() + 24 * H) }));
      } else if (cmd === "status") {
        const topics = (cfg.routing[m.role] || []).map((t) => TOPIC_AR[t]).join("، ") || "ولا موضوع";
        await say(`👤 ${m.name || last4(phone)} — ${ROLE_AR[m.role]}\nبيوصلك: ${topics}\nالتنبيهات المجانية شغّالة لحد ${riyadhHHMM(new Date(now.getTime() + 24 * H))} بكرة.`, true);
      } else if (cmd === "help") await say(HELP_TEXT, true);
      else if (cmd === "digest") {
        if (m.role === "cashier") await say("الملخص للمدير والملاك بس.");
        else await dailyDigest(cfg, now, { only: m });
      }
      return true;
    } catch (e) { log.error("[wa-team] inbound:", e.message); return true; }      // رقم فريق + عطل ⇒ برضه مايتعاملش كعميل
  }

  /* RG1 + PO1: حضور البوابة للوحة — كل موظف بوابة/جهاز وحالة المرة الحالية ورصيد كل موظف النهارده. null = مفيش مصدر حضور خالص.
     القاعدة مش بتتقري ⇒ نفس الشكل ومعاه error ("presence_db" / "state_db") وصحة الكتابة/القراية — اللوحة بتقول إن التنبيه واقف (المراجعة
     التانية: كانت بترجع null ⇒ لا كارت ولا تحذير، والتنبيه نفسه واقف في صمت).
     جهاز: visible = على الشاشة دلوقتي (آخر إشارة ظاهرة من أقل من ~٢.٥ دقيقة، مش آخر afterMin) · background = بيكلّم السيرفر دلوقتي من غير
     ما يبقى ظاهر · open = مفتوح بقاعدة التنبيه (آخر إشارة بتتحسب من أقل من afterMin) · offMin = من آخر إشارة بتتحسب، ولو الجهاز ماعندوش ولا
     إشارة بتتحسب (في الخلفية بس والمفتاح مقفول) ⇒ من آخر إشارة أصلاً («مقفول من X» مش «ماتفتحش»).
     recipients[]: رصيد كل موظف النهارده (اللي وصل بس) + lastAt / nextAt (التكرار لكل رقم: إمتى يقدر ياخد تاني).
     alerts.hold = لسه مفيش تنبيه في المرة دي لأن كل كاشير ليه رصيد محجوز بالتكرار ⇒ { lastAt, until } · alerts.reopenedAt / endsAt = البورتال
     مش مقفول دلوقتي بس مش ثابت، والحلقة بتخلص لوحدها endsAt لو فضل كده (أو أول ما يفضل ظاهر backStableMin). */
  async function portalStatus(cfg, now, settingsIn = null) {
    const pres = presenceApi();
    if (!pres || typeof pres.presence !== "function") return null;
    const po = cfg.portalOffline, t = now.getTime(), lim = po.afterMin * MIN, fresh = Math.min(PORTAL_FRESH_MS, lim), keep = keepMinOf(po);
    const health = () => (typeof pres.health === "function" ? pres.health() : null);
    const head = { afterMin: po.afterMin, repeatMin: po.repeatMin, backStableMin: po.backStableMin, keepMin: keep, countBackground: po.countBackground, managerOnHold: po.managerOnHold,
      freshSec: fresh / 1000, dailyCap: po.dailyCap, managerAfter: po.managerAfter };
    const settings = settingsIn || (await settingsNow()) || {};
    const list = await pres.presence();
    if (list === null) return { ...head, error: "presence_db", working: workingNow(settings, now, 0), cashier: null, alerts: null, sentToday: null, recipients: [], muted: false, presence: health(), devices: [] };
    const devices = list.map((x) => {
      const ls = tms(x.lastSeen), lv = tms(x.lastVisible), ref = po.countBackground ? ls : lv, ago = Number.isFinite(ref) ? ref : ls;
      const visible = Number.isFinite(lv) && t - lv < fresh, background = !visible && Number.isFinite(ls) && t - ls < fresh;
      return { name: x.name, role: x.role, device: x.device, lastSeen: x.lastSeen, lastVisible: x.lastVisible || null, via: x.via || null,
        open: Number.isFinite(ref) && t - ref < lim, visible, background, offMin: Number.isFinite(ago) ? Math.max(0, Math.floor((t - ago) / MIN)) : null };
    });
    const st = await q("SELECT since, alerts, last_alert_at, manager_told, opened_at, reopened_at FROM wa_team_portal WHERE id='cashier'", []);
    const e = st && st[0];
    /* السجل مش بيتقري ⇒ الدورة واقفة (log_db) ⇒ error هنا كمان، فاللوحة وverify.py يقولوا إن التنبيه واقف بدل «كله تمام» */
    const log0 = await portalLog(now, e ? isoOf(e.opened_at || e.since) : null), log = log0 || new Map();
    const today = await q("SELECT count(*) FILTER (WHERE ok)::int AS n, count(*) FILTER (WHERE NOT ok)::int AS failed FROM wa_team_log WHERE topic='portal_offline' AND kind IN ('cashier','manager') AND at >= $1",
      [bizStart(bizDay(now)).toISOString()]);
    const sig = portalSignal(list, now, po);
    /* رصيد كل موظف النهارده (السقف اليومي) وإمتى يقدر ياخد تاني (التكرار لكل رقم) — اللوحة بتقول مين وصل للسقف، ومستنيين إيه */
    const team = cfg.members.filter((m) => m.active && (m.role === "cashier" || m.role === "manager"));
    const claims = team.length ? await q("SELECT phone_norm, last_at FROM wa_team_portal_to WHERE phone_norm = ANY($1::text[])", [team.map((m) => m.phone)]) : [];
    const lastAtOf = new Map((claims || []).map((r) => [r.phone_norm, tms(r.last_at)]));
    const recipients = team.map((m) => {
      const lg = log.get(m.phone) || { day: 0, mgrFail: 0 }, n = lg.day, la = lastAtOf.get(m.phone), next = Number.isFinite(la) ? la + po.repeatMin * MIN - PORTAL_SLACK_MS : NaN;
      return { name: m.name || null, role: m.role, today: n, capped: n >= po.dailyCap, lastAt: isoOf(la), nextAt: next > t ? isoOf(next) : null,
        ...(m.role === "manager" ? { unreachable: Boolean(e) && lg.mgrFail >= MGR_FAIL_MAX } : {}) };      // نفس قاعدة الدورة: آخر محاولتين في المرة دي فشلوا
    });
    const cashLeft = recipients.some((r) => r.role === "cashier" && !r.capped), mgrLeft = recipients.some((r) => r.role === "manager" && !r.capped);
    /* الدور زي الدورة بالظبط (managerTurn): مدير ليه رصيد **وبيوصله واتساب**. المدير اللي مش بيوصله بيتجرّب كل repeatMin والتنبيهات للكاشير ⇒
       stage «cashier» (كانت «manager» واللوحة تقول «الدور على المدير» والكاشير هو اللي بياخد). muted = كله وصل للسقف بس: مدير مش بيوصله ولسه ليه
       رصيد لسه بيتجرّب، فمش «مفيش رسايل تانية النهارده». */
    const mgrReach = recipients.some((r) => r.role === "manager" && !r.capped && !r.unreachable);
    const alerts = e ? Number(e.alerts) || 0 : 0;
    const delivered = Math.min(alerts, Math.max(0, ...team.filter((m) => m.role === "cashier").map((m) => (log.get(m.phone) || { cashOk: 0 }).cashOk)));
    const waiting = recipients.filter((r) => r.role === "cashier" && !r.capped);
    const hold = e && alerts === 0 && waiting.length > 0 && waiting.every((r) => r.nextAt)
      ? { lastAt: isoOf(Math.max(...waiting.map((r) => tms(r.lastAt)))), until: isoOf(Math.min(...waiting.map((r) => tms(r.nextAt)))) } : null;
    const ro = e ? tms(e.reopened_at) : NaN;
    return { ...head, working: workingNow(settings, now, 0),
      cashier: { open: !sig.closed, stable: sig.stable, lastSeen: sig.lastSeen, offMin: sig.offMin, hidden: sig.hidden },
      alerts: e ? { count: alerts, delivered, lastAt: e.last_alert_at || null, managerTold: e.manager_told === true, since: e.since || null, openedAt: e.opened_at || null,
        stage: (!cashLeft || alerts >= po.managerAfter) && mgrReach ? "manager" : "cashier", managerLeft: mgrLeft, cashierLeft: cashLeft,
        reopenedAt: isoOf(ro), endsAt: Number.isFinite(ro) ? isoOf(ro + keep * MIN) : null, hold } : null,
      sentToday: Number(today && today[0] && today[0].n) || 0, failedToday: Number(today && today[0] && today[0].failed) || 0, recipients,
      muted: recipients.some((r) => r.role === "cashier") && !cashLeft && !mgrLeft,
      ...(st === null ? { error: "state_db" } : log0 === null ? { error: "log_db" } : {}), presence: health(), devices };
  }

  /* ── الحالة (اللوحة والبورتال) ───────────────────────────────────────────── */
  async function status({ full = false, settings: settingsIn = null } = {}) {
    await ready;
    const settings = settingsIn || (await settingsNow()) || {}, cfg = teamConfig(settings), now = clock();
    const tests = staffPhones(settings.waBot && settings.waBot.testPhones);
    const members = [];
    for (const m of cfg.members) {
      const lastIn = await lastInOf(m.phone), st = await stateOf(m.phone), win = windowState(lastIn, now);
      const plan = keeperPlan({ now, lastInAt: lastIn, state: { freeNudgeAt: st.free_nudge_at, closedNudgeAt: st.closed_nudge_at }, keeper: cfg.keeper });
      const la = await q("SELECT at, topic, kind, via, ok FROM wa_team_log WHERE phone_norm=$1 ORDER BY at DESC, id DESC LIMIT 1", [m.phone]);
      members.push({ ...(full ? { phone: `0${m.phone}` } : {}), last4: m.phone.slice(-4), name: m.name || null, role: m.role, roleAr: ROLE_AR[m.role], active: m.active, topics: cfg.routing[m.role] || [],
        window: { open: win.open, until: win.until, closedSince: win.closedSince, lastInAt: win.lastInAt, minutesLeft: win.minutesLeft },
        keeper: { next: plan.action, why: plan.why, dueAt: plan.dueAt || null, freeNudgeAt: st.free_nudge_at || null, closedNudgeAt: st.closed_nudge_at || null, closedNudgeVia: st.closed_nudge_via || null },
        testPhone: tests.includes(m.phone), lastAlert: la && la[0] ? la[0] : null });
    }
    return { cfg, members, now: now.toISOString() };
  }

  if (app && typeof app.get === "function") {
    /* جسم «الفريق والتنبيهات» كله (GET، وبرضه رد الحفظ: اللوحة بتستبدل الحالة بالرد — من غير schema/portal كانت الكروت بتختفي لحد الريفريش) */
    const teamPayload = async ({ owner, settings = null }) => {
      const st = await status({ full: owner, settings }), cfg = st.cfg, now = clock();
      const templates = {};
      for (const n of [TPL_RENEW, TPL_NOTICE, TPL_HANDOFF]) templates[n] = { approved: Boolean(await approved(cfg, n)), source: await approved(cfg, n) };
      const hour = new Date(now.getTime() - H).toISOString(), day = new Date(now.getTime() - 24 * H).toISOString();
      const oc = await q(`SELECT count(*) FILTER (WHERE status='sent' AND sent_at > $1)::int AS sent_hour, count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='held')::int AS held FROM wa_team_odd WHERE at > $2`, [hour, day]);
      const byKind = await q("SELECT kind, count(*)::int AS n FROM wa_team_odd WHERE at > $1 GROUP BY 1 ORDER BY 2 DESC", [day]);
      const via = await q("SELECT via, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok FROM wa_team_log WHERE at > $1 GROUP BY 1", [day]);
      const recent = await q("SELECT at, right(phone_norm, 4) AS to4, role, topic, kind, via, ok, error, ref4, urgent FROM wa_team_log ORDER BY at DESC, id DESC LIMIT 40", []);
      const portal = await portalStatus(cfg, now, settings);
      return { ok: true, now: st.now, owner, config: { ...cfg, members: undefined }, fallbackDirectory: cfg.fallback, members: st.members, templates, portal,
        odd: { sentLastHour: Number(oc && oc[0] && oc[0].sent_hour) || 0, cap: cfg.odd.perHour, pending: Number(oc && oc[0] && oc[0].pending) || 0, held: Number(oc && oc[0] && oc[0].held) || 0, byKind24h: byKind || [] },
        sends24h: via || [], recent: recent || [],
        schema: { knobs: KNOBS, roles: ROLES.map((id) => ({ id, label: ROLE_AR[id] })), topics: TOPICS.map((id) => ({ id, label: TOPIC_AR[id] })), oddKinds: ODD_KEYS.map((id) => ({ id, label: ODD_KINDS[id], quietDefault: ODD_QUIET_DEFAULT[id] === true })), limits: LIMITS, defaults: DEFAULTS, renewButton: RENEW_TITLE,
          actions: Object.entries(ACTIONS).map(([id, label]) => ({ id, label })), outcomes: OUTCOMES.map((o) => ({ id: o.id, label: o.label, hint: o.hint })) } };
    };
    app.get("/api/cms/wabot/team", async (c) => {
      const err = await requireAdmin(c); if (err) return err;
      try { return c.json(await teamPayload({ owner: Boolean(await isOwner(c)) })); }
      catch (e) { log.error("[wa-team] status:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
    });
    app.put("/api/cms/wabot/team", async (c) => {
      const err = await requireAdmin(c); if (err) return err;
      if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "إعدادات تواصل الفريق للمالك بس" }, 403);
      let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
      const settings = await settingsNow();
      if (!settings) return c.json({ ok: false, error: "settings_unreadable" }, 503);
      const r = configFromBody(b, settings.waTeam);
      if (!r.ok) return c.json({ ok: false, error: "invalid", errors: r.errors }, 400);
      await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waTeam}', $1::jsonb, true), updated_at=NOW() WHERE id=1`, [JSON.stringify(r.value)]);
      const next = { ...settings, waTeam: r.value };
      try { return c.json(await teamPayload({ owner: true, settings: next })); }
      catch (e) {
        log.error("[wa-team] status after save:", e.message);      // اتحفظ خلاص — الرد المختصر (اللوحة بتعمل ريفريش)
        const cfg = teamConfig(next);
        return c.json({ ok: true, config: { ...cfg, members: undefined }, members: cfg.members.map((m) => ({ phone: `0${m.phone}`, name: m.name || null, role: m.role, active: m.active })) });
      }
    });
    app.post("/api/cms/wabot/team/test", async (c) => {
      const err = await requireAdmin(c); if (err) return err;
      if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only" }, 403);
      let b; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_json" }, 400); }
      const cfg = teamConfig((await settingsNow()) || {}), phone = normPh(b && b.phone);
      const m = cfg.members.find((x) => x.phone === phone && x.active);
      if (!m) return c.json({ ok: false, error: "not_staff", message: "الرقم مش في دليل الفريق" }, 400);
      const r = await sendToStaff(cfg, m, { topic: "test", kind: "test", body: "🧪 رسالة تجربة من نظام تنبيهات فريش كاتس — لو وصلتك، التنبيهات شغّالة على واتساب.", templates: [{ name: TPL_NOTICE, data: { notice: { text: "رسالة تجربة لتنبيهات الفريق" } } }], sms: null });
      return c.json({ ok: r.ok, via: r.via, error: r.error || null });
    });
    if (deps.requirePortal) app.get("/api/portal/wa/team-status", async (c) => {
      const a = await deps.requirePortal(c); if (a.res) return a.res;
      if (!["cashier", "manager"].includes(a.user && a.user.role)) return c.json({ ok: false, error: "forbidden" }, 403);
      try {
        const st = await status({ full: false });
        return c.json({ ok: true, now: st.now, enabled: st.cfg.enabled, renewButton: RENEW_TITLE,
          members: st.members.filter((m) => m.active).map((m) => ({ last4: m.last4, name: m.name, role: m.role, roleAr: m.roleAr, window: m.window })) });
      } catch (e) { log.error("[wa-team] portal status:", e.message); return c.json({ ok: false, error: "unavailable" }, 500); }
    });
  }

  return { ready, handover, odd, inbound, tick, status, portalWatch, portalStatus, sendToStaff, fanOut, lastCustomerText, dailyDigest, flushOdd, stop: () => { if (timer) clearInterval(timer); } };
}
