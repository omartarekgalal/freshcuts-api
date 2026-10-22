/* ═══════════════════════════════════════════════════════════════════════════
   MJ1 (٢٢/١٠/٢٠٢٦) — مجموعة تقييم «ماجد فاهم المحادثة؟» من محادثات حقيقية (١٢/١٠ ← ٢٢/١٠، قراية بس من wa_messages / wa_assist_turns / wa_bot_log).
   الأرقام مقنّعة 5000000xx، والأسماء اتشالت. كل حالة = الأحداث بالترتيب (رسالة العميل، رسالة الموظف من الموبايل، رسالة نظام، وقت بيعدّي، رسايل في نفس اللحظة)
   + ردود موديل مكتوبة مسبقاً (الموديل نفسه مش بيتجرّب هنا — ده في live.mjs) + السلوك المتوقع.

   بيشتغل في CI جوّه wabotrun.test.mjs (قسم «MJ1 eval»): من الويب هوك الحقيقي لطلب Graph، والقاعدة في الذاكرة. اللي بيتقاس هو منطق القرار حوالين ماجد:
   مين يرد (ماجد / القواعد / سكوت / للموظف)، ماجد شايف إيه من المحادثة، كام نداء للموديل وهل اتنين بالتوازي، والنص اللي طلع للعميل.

   DSL:
     events: { say } · { press: [id, title] } · { button: نص زر قالب } · { cashier } (موظف من موبايل المطعم) · { push: { source, body, order_no, minAgo, direction } } (رسالة اتبعتت قبل كده)
             · { chat: { handoff_reason, handoffMinAgo | handoffSecAgo, releasedAfterEcho } } · { advance: دقايق } · { advanceSec } · { par: [نص | {press}] } (في نفس اللحظة) · { tick: دقايق }
     expect.at[i] (رقم الحدث): { key, decision, reason, body (بالظبط، أول رسالة), has: [regex], lacks: [regex], handoff, sent } — لـ par: مصفوفة بنفس الترتيب
     expect: { model: عدد نداءات الموديل, maxLive: أقصى نداءات في نفس اللحظة, oneSession, neverSent: [regex], introCount,
               call: { k: { ctxHas, ctxLacks, chatHas: [regex], noChat, msgHas: [regex], msgLacks: [regex] } } } (k = رقم نداء الموديل من صفر)
═══════════════════════════════════════════════════════════════════════════ */
const ETA = "طلبك رقم W1792611609387 مع المندوب وفي الطريق إليك 🛵\nخلّ جوالك قريب، ممكن يتصل عليك المندوب عند الوصول.\n⏱ يوصلك خلال 21~31 دقيقة · قبل 11:40 م";
const STAFF_ACK = "وصلت ✅ بلّغت الموظف اللي يتابع معك، ويرد عليك هنا 🙏";
const DETAIL_ACK = "وصلت ملاحظتك ✅ والمدير يتابعها معك هنا في أقرب وقت 🙏";
const C = [];
const S = (id, src, what, o) => C.push({ id, src, what, ...o });

/* ── أ) ماجد بيشوف المحادثة (majedSeesChat / etaFromChat) ── */
S("eta-0450", "…0450 ٢١/١٠ 23:17", "«كم باقي ويوصل» بعد رسالة «في الطريق ⏱ يوصلك خلال 21~31 دقيقة» بـ٩ دقايق ⇒ نفس الوقت بالحرف من غير موديل (مش ماجد «ما عندي وقت وصول محدد»)", {
  n: 71, majed: true, orders: [{ order_no: "W1792611609387", status: "on_the_way", minAgo: 37 }], model: [],
  events: [{ push: { source: "window", order_no: "W1792611609387", body: ETA, minAgo: 9, stage: "on_the_way" } }, { say: "كم باقي ويوصل" }],
  expect: { model: 0, at: { 1: { key: "eta_told", body: "طلبك مع المندوب في الطريق إليك 🛵\nحسب آخر تحديث: يوصلك خلال 21~31 دقيقة · قبل 11:40 م", handoff: null, lacks: ["ما عندي وقت وصول"] } } } });
S("eta-0450-late", "…0450 (لو الوقت عدّى)", "الوقت اللي اتقال عدّى (رسالة «في الطريق» من ٤٥ دقيقة، والمدى لحد ٣١) ⇒ اعتذار + «طلب متأخر» للفريق، مش تكرار وقت فات", {
  n: 70, majed: true, orders: [{ order_no: "W1792611609387", status: "on_the_way", minAgo: 70 }], model: [],
  events: [{ push: { source: "window", order_no: "W1792611609387", body: ETA, minAgo: 45, stage: "on_the_way" } }, { say: "كم باقي ويوصل" }],
  expect: { model: 0, at: { 1: { key: "eta_told", body: "نعتذر عن التأخير 🙏 طلبك مع المندوب في الطريق، وبلّغت الفريق يتابعه معك الحين.", handoff: "order_late" } } } });
S("eta-0450-tool", "…0450 (سؤال تاني عن الوقت لماجد)", "سؤال عن الوقت بصيغة تانية بيروح لماجد ⇒ order_status بيرجّع eta_we_told، وماجد بيكرره بنصه والمراجِع بيعدّيه (حارس «وعد بوقت» بيستثني الوقت اللي اتقال بس)", {
  n: 69, majed: true, orders: [{ order_no: "W1792611609387", status: "on_the_way", minAgo: 37 }],
  model: [{ use: [["order_status", {}]] }, "حسب آخر تحديث يوصلك خلال 21~31 دقيقة · قبل 11:40 م 🛵"],
  events: [{ push: { source: "window", order_no: "W1792611609387", body: ETA, minAgo: 9, stage: "on_the_way" } }, { say: "ممكن يوصلني قبل الساعه 11؟" }],
  expect: { model: 2, at: { 1: { key: "assist", has: ["يوصلك خلال 21~31 دقيقة · قبل 11:40 م"] } },
    call: { 0: { chatHas: ["order_update .*⏱ يوصلك خلال 21~31 دقيقة"], ctxHas: ["\"arrival_time_we_told\":{\"said\":\"يوصلك خلال 21~31 دقيقة · قبل 11:40 م\""] }, 1: { msgHas: ["eta_we_told.{0,20}يوصلك خلال 21~31 دقيقة · قبل 11:40 م"] } } } });
S("eta-0450-off", "…0450 ٢١/١٠", "المفتاح etaFromChat مقفول ⇒ مفيش رد الوقت الثابت ولا eta_we_told (زي قبل MJ1)", {
  n: 72, majed: true, waBot: { etaFromChat: false }, orders: [{ order_no: "W1792611609387", status: "on_the_way", minAgo: 37 }],
  model: [{ use: [["order_status", {}]] }, "طلبك رقم W1792611609387 في الطريق لك 🛵"],
  events: [{ push: { source: "window", order_no: "W1792611609387", body: ETA, minAgo: 9, stage: "on_the_way" } }, { say: "ممكن يوصلني قبل الساعه 11؟" }],
  expect: { at: { 1: { lacks: ["حسب آخر تحديث"] } }, call: { 1: { msgLacks: ["eta_we_told"] } } } });
S("staff-said-6545", "…6545 ١٣/١٠ 13:30–13:50", "الموظف قال مكوّنات المشكل وسعر النص كيلو؛ «بهذا المبلغ كم سيخ؟» بعدها ⇒ ماجد شايف كلام الموظف (سطر staff) — مش «ما عندي معلومة… اكتب موظف»", {
  n: 73, majed: true, model: ["أي صنف تبي أسعاره؟", "حسب كلام زميلي 🙏 الثلث فيه ريشة وأوصال وكفتة وطرب. تبيه؟"],
  events: [{ say: "الاسعار" }, { advance: 1 }, { cashier: "بتيجى واحده ريشه . اتنين اوصال ..اتنين كفته لحم ... حبه طرب" }, { cashier: "النص ك 78" }, { advance: 35 }, { say: "بهذا المبلغ كم سيخ سوف احصل عليه !!" }],
  expect: { model: 2, at: { 5: { key: "assist" } }, call: { 1: { chatHas: ["staff \\(\\d+ min ago\\): بتيجى واحده ريشه", "staff \\(\\d+ min ago\\): النص ك 78"] } } } });
S("coming-1838", "…1838 ١٤/١٠ 16:45", "الكاشير «الاوردر جاهز ي فندم» ⇒ «جاي في الطريق يابشمهندس» ⇒ «حيّاك الله، نستناك» من القواعد — مش ماجد «تبي نجهّز لك طلبك؟ نفس الطلب؟»", {
  n: 74, majed: true, model: [],
  events: [{ cashier: "الاوردر جاهز ي فندم" }, { advance: 40 }, { say: "جاي في الطريق يابشمهندس" }],
  expect: { model: 0, at: { 2: { key: "coming", lacks: ["نفس الطلب", "آخر طلب"] } } } });
S("rules-text-in-session", "…6390 ١٥/١٠ 22:56 / …1634 ٢١/١٠", "رد البوت (القواعد) وسط محادثة ماجد بيتسجّل في جلسته **بنصه** («[our fixed menu bot replied (…): …]») — مش اسم المفتاح بس", {
  n: 75, majed: true, model: ["هلا والله 👋 وش تحب تطلب اليوم؟", "أبشر 👍 أي وزن تبي من المشكل؟"],
  events: [{ say: "هلا" }, { advance: 1 }, { say: "عندكم فرع في الرياض؟" }, { advance: 1 }, { say: "ابي اطلب مشكل" }],
  expect: { model: 2, at: { 2: { key: "other_city" } }, call: { 1: { msgHas: ["\\[our fixed menu bot replied \\(other_city\\): "] } } } });
S("expired-session-sees-earlier", "…3588 ١٣/١٠ 16:05 ⇒ 18:29 «نعم بكم سعر»", "الجلسة قفلت (٩٠ دقيقة) والعميل رجع يكمّل ⇒ أول دور في الجلسة الجديدة بيشوف كلامه اللي فات ورد ماجد (مش «أي صنف تقصد بالضبط؟»)", {
  n: 76, majed: true, model: ["عندنا صدور مشوية وجبة أو بالوزن. تبيها وجبة ولا بالوزن؟", "الوجبة تجي مع الأرز والسلطة والطحينة. أجهّزها لك؟"],
  events: [{ say: "بكم صدور الفحم" }, { advance: 140 }, { say: "نعم بكم سعر" }],
  expect: { model: 2, call: { 1: { chatHas: ["customer \\(\\d+ min ago\\): بكم صدور الفحم", "our_bot \\(\\d+ min ago\\): عندنا صدور مشوية"] } } } });
S("campaign-seen", "…0494 ١٨/١٠ «محتاج أطلب العرض» (حملة ١٥/١٠)", "رسالة الحملة اللي وصلت العميل من ساعتين بتظهر لماجد (سطر campaign) وهو بيرد", {
  n: 77, majed: true, model: ["أبشر 👍 تبيه لكم شخص؟"],
  events: [{ push: { source: "campaign", template: "fc_frame_ask_text", body: "جديد من فريش كاتس 👋 بوكس فيه طبقك المفضل: بوكس الكريب لشخصين بـ65 ر.س", minAgo: 120 } }, { say: "طيب ابي اعرف تفاصيل اكثر عن البوكس" }],
  expect: { model: 1, call: { 0: { chatHas: ["campaign \\(120 min ago\\): جديد من فريش كاتس"] } } } });
S("no-chat-when-off", "—", "المفتاح majedSeesChat مقفول ⇒ مفيش سطور (زي قبل MJ1)", {
  n: 78, majed: true, waBot: { majedSeesChat: false }, model: ["أبشر 👍 تبيه لكم شخص؟"],
  events: [{ push: { source: "campaign", template: "fc_frame_ask_text", body: "جديد من فريش كاتس 👋 بوكس الكريب لشخصين بـ65 ر.س", minAgo: 120 } }, { say: "طيب ابي اعرف تفاصيل اكثر عن البوكس" }],
  expect: { model: 1, call: { 0: { noChat: true, ctxLacks: ["chat_since_your_last_reply"] } } } });
S("chat-not-facts", "—", "سطور المحادثة كتلة لوحدها (<chat_since_your_last_reply>) مش جوّه <context>: سعر قاله العميل مايبقاش «حقيقة» مسموحة للمراجِع", {
  n: 79, majed: true, model: ["أي صنف تقصد؟"],
  events: [{ push: { direction: "in", source: "api", body: "سمعت ان المشكل الكيلو بـ 96", minAgo: 30 } }, { say: "صح الكلام ده؟" }],
  expect: { model: 1, call: { 0: { chatHas: ["customer \\(30 min ago\\): سمعت ان المشكل الكيلو بـ 96"], ctxLacks: ["سمعت ان المشكل"] } } } });

/* ── ب) رد العميل على سؤال الموظف (answerToStaff) ── */
S("answer-staff-0340", "…0340 ٢٢/١٠ 12:47 ⇒ 13:20", "الموظف سأل «حضرتك الطلب كان الساعه كام» وعدّت ٣٣ دقيقة ⇒ «الطلب كان مبارح بالليل الساعة ١١» = رد للموظف: تأكيد + تنبيه، مش ماجد «سؤالك يحتاج واحد من الفريق»", {
  n: 80, majed: true, model: [],
  events: [{ cashier: "السلام عليكم استاذه" }, { cashier: "حضرتك الطلب كان الساعه كام" }, { advance: 33 }, { say: "الطلب كان مبارح بالليل الساعة ١١" }, { advanceSec: 20 }, { say: "والطلب كان بيتزا تشيكن" }],
  expect: { model: 0, at: { 3: { key: "staff_answer", body: STAFF_ACK, handoff: "staff_answer", lacks: ["سؤالك يحتاج واحد من الفريق"] }, 5: { decision: "silent", reason: "staff_answer_repeat" } } } });
S("answer-staff-thanks", "…0340 ٢٢/١٠ 13:20:54", "بعد رد العميل على الموظف «شكرا» ⇒ شكر عادي من القواعد (مش تحويل تاني)", {
  n: 81, majed: true, model: [],
  events: [{ cashier: "حضرتك الطلب كان الساعه كام" }, { advance: 33 }, { say: "الطلب كان مبارح بالليل الساعة ١١" }, { advanceSec: 5 }, { say: "شكرا" }],
  expect: { model: 0, at: { 2: { key: "staff_answer" }, 4: { key: "thanks" } } } });
S("answer-staff-name-9734", "…9734 ١٤/١٠ 16:19 ⇒ 16:24", "الموظف «اتشرف بأسم حضرتك» ⇒ العميل «شادي» بعد ٣١ دقيقة ⇒ للموظف (مش ماجد «ما أعرف هالاسم كأنه خطأ مني»)", {
  n: 82, majed: true, model: [],
  events: [{ cashier: "احمد معاك من مطعم فريش كاتس" }, { cashier: "اتشرف بأسم حضرتك" }, { advance: 31 }, { say: "شادي" }],
  expect: { model: 0, at: { 3: { key: "staff_answer", body: STAFF_ACK } } } });
S("answer-staff-floor-5960", "…5960 ١٩/١٠ 20:02", "الموظف «الدور كام شقه كام» ⇒ «الدور ٢» ⇒ للموظف", {
  n: 83, majed: true, model: [],
  events: [{ cashier: "الدور كام شقه كام" }, { advance: 31 }, { say: "الدور ٢" }],
  expect: { model: 0, at: { 2: { key: "staff_answer" } } } });
S("generic-opener-not-staff", "مراجعة ١٢/١٠ (اختبار «rule 1+2»)", "سؤال عام من الموظف («حياك الله، كيف أخدمك؟») مش سؤال محدد ⇒ «كم رسوم التوصيل» بعدها بيتجاوب عادي", {
  n: 84, majed: false,
  events: [{ cashier: "حياك الله، كيف أخدمك؟" }, { advance: 31 }, { say: "كم رسوم التوصيل" }],
  expect: { at: { 2: { key: "delivery", lacks: [STAFF_ACK] } } } });
S("staff-question-too-old", "—", "سؤال الموظف من أكتر من ساعتين (staffQuestionHours) ⇒ كلام العميل جديد عادي", {
  n: 85, majed: false,
  events: [{ cashier: "الاوردر بأسم مين" }, { advance: 150 }, { say: "كم رسوم التوصيل" }],
  expect: { at: { 2: { key: "delivery" } } } });
S("answer-staff-off", "—", "المفتاح answerToStaff مقفول ⇒ ماجد بياخد الرسالة زي قبل MJ1", {
  n: 86, majed: true, waBot: { answerToStaff: false }, model: ["أهلاً 👋 وش تحب تطلب اليوم؟"],
  events: [{ cashier: "اتشرف بأسم حضرتك" }, { advance: 31 }, { say: "شادي" }],
  expect: { model: 1, at: { 2: { key: "assist" } } } });
S("answer-staff-after-wait", "…9734 (جوّه سكوت الموظف)", "رد العميل جوّه مدة سكوت البوت ⇒ استنى الموظف ٥ دقايق (زي قبل) ولو ماردّش ⇒ تأكيد + تنبيه للموظف، مش رد بوت على الكلام", {
  n: 87, majed: false,
  events: [{ cashier: "الاوردر بأسم مين" }, { advance: 2 }, { say: "اسراء" }, { tick: 5 }],
  expect: { at: { 2: { decision: "replied", key: "staff_answer" } } } });
S("answer-staff-complaint", "…0340 (الشكوى لسه مفتوحة والموظف رد عليها)", "تقييم واطي مفتوح والمدير سأل سؤال ⇒ رد العميل: سكوت للعميل (قرار ١٢/١٠: الشكوى مع الموظف = البوت ساكت) **بس** الموظف بيتنبّه (staff_answer)", {
  n: 68, majed: false,
  events: [{ chat: { handoff_reason: "review_low", handoffMinAgo: 60 } }, { cashier: "حضرتك الطلب كان الساعه كام" }, { advance: 33 }, { say: "الطلب كان مبارح بالليل الساعة ١١" }],
  expect: { at: { 3: { decision: "silent", reason: "complaint_with_staff", key: "staff_answer", handoff: "staff_answer", sent: 0 } } } });
S("staff-released-chat", "SR2 (١٣/١٠)", "الموظف ساب المحادثة للبوت بنفسه («خلصت») بعد سؤاله ⇒ سؤاله القديم مايتحسبش", {
  n: 88, majed: false,
  events: [{ cashier: "الاوردر بأسم مين" }, { advance: 31 }, { chat: { releasedAfterEcho: true } }, { say: "كم رسوم التوصيل" }],
  expect: { at: { 3: { key: "delivery" } } } });

/* ── ج) تفاصيل الشكوى (complaintDetailAck) ── */
S("complaint-detail-0340", "…0340 ٢٢/١٠ 11:55", "بعد «يحتاج تحسين» (تقييم واطي مفتوح) العميلة كتبت وش صار ⇒ «وصلت ملاحظتك» — مش كارت «كريب ميكس جبن 20 ر.س»", {
  n: 89, majed: false,
  events: [{ chat: { handoff_reason: "review_low", handoffSecAgo: 70 } }, { say: "طلبت بيتزا مع حشوة جبنة عالاطراف لكن استلمت الطلب والبيت اكتشفت انها خالية من الجبنة" }, { advanceSec: 40 }, { say: "والعجينة كمان كانت ناشفة مش زي كل مرة" }],
  expect: { at: { 1: { key: "complaint_detail", body: DETAIL_ACK, lacks: ["كريب ميكس جبن", "ر.س"] }, 3: { decision: "silent", reason: "complaint_detail_repeat" } }, neverSent: ["كريب ميكس جبن"] } });
S("complaint-detail-burst", "MJ1 #٥ (١٦/١٠)", "جوّه نافذة الـburst (ثواني بعد التحويل) ⇒ سكوت زي قبل (الموظف شايفها)", {
  n: 90, majed: false,
  events: [{ chat: { handoff_reason: "review_note", handoffSecAgo: 20 } }, { say: "الريش كلها جايه عبارة عن دهون" }],
  expect: { at: { 1: { decision: "silent", reason: "handover_burst" } } } });
S("complaint-detail-off", "—", "المفتاح complaintDetailAck مقفول ⇒ مش complaint_detail (زي قبل MJ1)", {
  n: 91, majed: false, waBot: { complaintDetailAck: false },
  events: [{ chat: { handoff_reason: "review_low", handoffSecAgo: 70 } }, { say: "طلبت بيتزا مع حشوة جبنة عالاطراف لكن استلمت الطلب والبيت اكتشفت انها خالية من الجبنة" }],
  expect: { at: { 1: { lacks: [DETAIL_ACK] } } } });
S("complaint-open-new-order", "RV1 (تقييم واطي مفتوح)", "تقييم واطي مفتوح والعميل طلب حاجة جديدة («ابي بيتزا بالجبنة») ⇒ مش تفاصيل شكوى", {
  n: 92, majed: false,
  events: [{ chat: { handoff_reason: "review_low", handoffSecAgo: 90 } }, { say: "ابي بيتزا بالجبنة" }],
  expect: { at: { 1: { lacks: [DETAIL_ACK] } } } });
S("praise-after-note-1244", "…1244 ٢١/١٠ 00:51", "مدح بعد «عندي ملاحظة» ⇒ مش تفاصيل شكوى", {
  n: 93, majed: false,
  events: [{ chat: { handoff_reason: "review_note", handoffSecAgo: 90 } }, { say: "ان الاكل جميل وتسلم ايدكو بجد ماشاء الله عليكو" }],
  expect: { at: { 1: { lacks: [DETAIL_ACK] } } } });

/* ── د) الأدوار المتوازية والدمج (serialChat / mergeBurst) ── */
S("three-in-a-row-5960", "…5960 ٢٠/١٠ 14:52:58–14:53:02", "«تخفه» + «بجد» + «كريب» في نفس اللحظة ⇒ مفيش نداءين للموديل في نفس الوقت، جلسة واحدة، و«بجد» و«كريب» دور واحد (مش ٣ ردود متناقضة من ٣ جلسات)", {
  n: 94, majed: true, delayMs: 25, model: ["هلا والله 👋 وش تحب تطلب اليوم؟", "الله يسلمك، يسعدنا إن الطلب عجبك 🌟", "أبشر، كريب 👍 لكم شخص؟"],
  events: [{ say: "هلا" }, { advance: 1 }, { par: ["تخفه", "بجد", "كريب"] }],
  expect: { model: 3, maxLive: 1, oneSession: true, at: { 2: [{ decision: "replied" }, { decision: "silent", reason: "merged_next" }, { decision: "replied", key: "assist" }] },
    call: { 2: { msgHas: ["<customer_message>بجد كريب</customer_message>"] } } } });
S("go-pickup-1139", "…1139 ٢٠/١٠ 17:45:49–51", "«انا هاجي الفرع» + «استلم» في نفس اللحظة ⇒ بالترتيب: «حيّاك، نستناك» من القواعد ثم دور واحد لماجد وهو شايف الرد اللي قبله (مش ردّين متكررين وسلتين)", {
  n: 95, majed: true, delayMs: 25, model: ["هلا والله 👋 وش تحب تطلب اليوم؟", "أبشر 👍 استلام من الفرع. وش أجهّز لك؟"],
  events: [{ say: "هلا" }, { advance: 1 }, { par: ["انا هاجي الفرع الحين", "استلم"] }],
  expect: { maxLive: 1, at: { 2: [{ key: "coming" }, { key: "assist" }] }, call: { 1: { msgHas: ["\\[our fixed menu bot replied \\(coming\\): "] } } } });
S("greet-menu-1634", "…1634 ٢١/١٠ 16:51:14–20", "«السلام عليكم» + «المنيو» ⇒ رد ماجد الأول ثم المنيو، والتعريف «معك ماجد» مرة واحدة بس (مش مرتين في ثانيتين)", {
  n: 96, majed: true, disclosure: true, delayMs: 25, model: ["وعليكم السلام، حيّاك الله 👋 وش تحب تطلب اليوم؟"],
  events: [{ par: ["السلام عليكم", "المنيو"] }],
  expect: { maxLive: 1, introCount: 1 } });
S("tap-not-merged", "—", "نص + ضغطة زر في نفس اللحظة ⇒ مايندمجوش (كل واحدة ليها ردها)", {
  n: 97, majed: false,
  events: [{ par: ["ابي بيتزا", { press: ["bot:menu", "القائمة"] }] }],
  expect: { at: { 0: [{ decision: "replied" }, { decision: "replied", key: "main" }] } } });
S("thanks-not-merged-0340", "…0340 ٢٢/١٠ 13:20:49 + 13:20:54", "«الطلب كان…» + «شكرا» ⇒ مايندمجوش («شكرا» إقفال كلام) والردود بالترتيب: التأكيد الأول ثم الشكر", {
  n: 98, majed: true, delayMs: 10, model: [],
  events: [{ cashier: "حضرتك الطلب كان الساعه كام" }, { advance: 33 }, { par: ["الطلب كان مبارح بالليل الساعة ١١", "شكرا"] }],
  expect: { model: 0, at: { 2: [{ key: "staff_answer", body: STAFF_ACK }, { key: "thanks" }] } } });
S("serial-off-races", "قبل MJ1", "المفتاح serialChat مقفول ⇒ الأدوار بتشتغل بالتوازي زي الأول (ده اللي كان بيحصل)", {
  n: 99, majed: true, delayMs: 25, waBot: { serialChat: false, mergeBurst: false }, model: ["هلا والله 👋 وش تحب تطلب؟", "أبشر 👍 وش تحب؟"],
  events: [{ par: ["هلا", "بجد"] }],
  expect: { model: 2, maxLiveAtLeast: 2 } });

/* ── هـ) نص زر إعلان ميتا الجاهز (adPrefillOffers) ── */
S("ad-prefill-ar-9131", "…9131 ٢٠/١٠ 02:53", "«مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟» ⇒ سياق ad_button_text (العروض بأسعارها) — مش «وش تقصد بـ«هذا»؟»", {
  n: 10, majed: true, model: ["أهلاً 👋 قل لي أي عرض شفته، أو كم شخص أنتم وأرشّح لك."],
  events: [{ say: "مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟" }],
  expect: { model: 1, call: { 0: { ctxHas: ["ad_button_text"] } } } });
S("ad-prefill-en-3466", "…3466 ١٩/١٠ 09:42", "«Hello! Can I get more info on this?» ⇒ نفس السياق والرد بالعربي", {
  n: 11, majed: true, model: ["أهلاً 👋 قل لي أي عرض شفته، أو كم شخص أنتم وأرشّح لك."],
  events: [{ say: "Hello! Can I get more info on this?" }],
  expect: { model: 1, call: { 0: { ctxHas: ["ad_button_text", "\"reply_language\":\"Arabic\""] } } } });
S("ad-prefill-off", "—", "المفتاح adPrefillOffers مقفول ⇒ مفيش ad_button_text", {
  n: 12, majed: true, waBot: { adPrefillOffers: false }, model: ["أهلاً 👋"],
  events: [{ say: "مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟" }],
  expect: { model: 1, call: { 0: { ctxLacks: ["ad_button_text"] } } } });
S("real-question-not-prefill", "—", "سؤال حقيقي فيه «معلومات» مش نص الزر ⇒ مفيش ad_button_text", {
  n: 13, majed: true, model: ["عندنا بيتزا بأنواع كثيرة 🍕 تبي أعرض لك الأنواع؟"],
  events: [{ say: "ابي معلومات عن البيتزا عندكم ايش انواعها" }],
  expect: { model: 1, call: { 0: { ctxLacks: ["ad_button_text"] } } } });

/* ── و) سلوك قديم لازم يفضل زي ما هو ── */
S("review-tap-untouched", "…0341 / …9601 (٢٠–٢١/١٠)", "ضغطة «ممتاز» على قالب التقييم ⇒ رد القواعد زي ما هو (ولا ماجد ولا دمج)", {
  n: 14, majed: true, model: [],
  events: [{ button: "ممتاز" }],
  expect: { model: 0, at: { 0: { decision: "replied" } } } });

export const CASES = Object.freeze(C);
