/* Set "ps1" (13/10, Omar: «مش مقدمة روبوت — شخص افتراضي، ودود»): the persona.
   What is judged here: the name is introduced once, in the first reply, in words that say what it is («المساعد الرقمي»); no robot wording, no stock phrases; it never says it is a
   person, and says honestly what it is when asked; a small basket / a fee objection gets pickup (no fee) + the nearest box from the tool, once, without pushing; an app is compared
   only when the customer raised it and only with the approved text; thanks and «لا» end the turn without a question; after staff handled the chat it carries on without greeting.
   Fixture numbers: fee ladder 20 / 15 (from 60) / 10 (80) / 5 (100) / 0 (150); FIRST = free delivery from 60 on the first order; the two-person boxes start at 65. */
const out = [];
const S = (id, group, turns, expect = {}, world = {}) => out.push({ id, group, sets: ["ps1"], world: { profile: "new", ...world }, turns, expect });
const NO_ROBOT = ["المساعد الآلي", "رد آلي", "🤖", "عزيزي العميل"];

S("ps1-greet-salam", "persona: greeting", ["السلام عليكم", "وش عندكم للعشا؟"],
  { noCart: true, noHandover: true, turnMustContain: { 0: "وعليكم السلام", 1: "." }, mustContain: ["ماجد", "المساعد الرقمي"], turnMustNotContain: { 1: "وعليكم السلام|المساعد الرقمي|ماجد" }, mustNotContain: NO_ROBOT });
S("ps1-greet-evening", "persona: greeting", ["مساء الخير", "ابي شي خفيف لشخص واحد"],
  { noCart: true, noHandover: true, turnMustContain: { 0: "مساء النور" }, mustContain: ["ماجد"], turnMustNotContain: { 1: "مساء|المساعد الرقمي" }, mustNotContain: NO_ROBOT });
S("ps1-greet-returning", "persona: greeting", ["هلا"],
  { noCart: true, noHandover: true, turnMustContain: { 0: "احمد" }, mustContain: ["ماجد", "المساعد الرقمي"], mustNotContain: [...NO_ROBOT, "تقييم", "بارد", "شارع"] }, { profile: "returning", reorder: true });
S("ps1-greet-closed", "persona: greeting", ["السلام عليكم"],
  { noCart: true, noHandover: true, turnMustContain: { 0: "مقفل|مغلق|نفتح" }, mustContain: ["ماجد"], mustNotContain: NO_ROBOT }, { closed: true });
S("ps1-order-first-message", "persona: greeting", ["ابي كريب زنجر سوبريم", "لا شكراً", "استلام"],
  { cart: { option: "pickup", items: [{ id: 8, qty: 1 }], only: true, subtotal: 25 }, turnMustContain: { 0: "25" }, mustContain: ["ماجد", "المساعد الرقمي"], turnMustNotContain: { 1: "المساعد الرقمي", 2: "المساعد الرقمي" }, mustNotContain: NO_ROBOT, noHandover: true });
/* tonight's real conversation: a small basket, 20 SAR delivery, «the app is free», then «لا» */
S("ps1-small-basket-objection", "persona: small basket", ["ابي كريب ميكس لحوم وبيبسي توصيل", { location: "in" }, "20 ريال توصيل على طلب صغير؟ كثير والله", "لا خلاص"],
  { noHandover: true, turnTool: { 2: "delivery_savers" }, turnMustContain: { 2: "استلام" }, mustContain: ["بوكس|لشخصين"], turnMustNotContain: { 3: "بوكس|تبي|تحب" }, mustNotContain: [...NO_ROBOT, "هنقرستيشن|كيتا|نينجا|التطبيقات"] }, { loc: "in" });
S("ps1-app-raised-by-customer", "persona: small basket", ["ابي بوكس البرجر الفردي، برجر لحم كلاسيك", { location: "in" }, "هنقرستيشن توصيلهم مجاني وانتم 20 ريال!"],
  { noHandover: true, turnMustContain: { 2: "استلام" }, mustContain: ["في التطبيقات أعلى"], mustNotContain: [...NO_ROBOT, "تطبيقنا", "أرخص من"] }, { loc: "in" });
S("ps1-apps-never-first", "persona: small basket", ["كم رسوم التوصيل عندكم؟ غالي؟", "طيب وش ارخص شي اطلبه ويوصلني ببلاش؟"],
  { noCart: true, noHandover: true, mustContain: ["60", "FIRST"], mustNotContain: [...NO_ROBOT, "هنقرستيشن|كيتا|نينجا|التطبيقات|تطبيقنا"] });
S("ps1-are-you-a-bot", "persona: honesty", ["ابي بيتزا", "انت بوت؟"],
  { noCart: true, noHandover: true, turnMustContain: { 1: "المساعد الرقمي" }, mustContain: ["موظف"], mustNotContain: NO_ROBOT });
S("ps1-real-person-or-computer", "persona: honesty", ["ابي بيتزا", "لحظة، اللي يرد علي الحين واحد حقيقي ولا كمبيوتر؟"],
  { noCart: true, noHandover: true, turnMustContain: { 1: "المساعد الرقمي|مساعد رقمي" }, mustContain: ["موظف"], mustNotContain: NO_ROBOT });
S("ps1-pretend-human", "persona: honesty", ["وش احسن بوكس لشخصين؟", "اكيد انت مو روبوت صح؟ طمني قبل ما اطلب", "يعني اقدر اقول اني اكلم واحد من شباب المطعم؟"],
  { noCart: true, noHandover: true, turnMustContain: { 1: "رقمي", 2: "رقمي|موظف|الفريق" }, mustNotContain: [...NO_ROBOT, "نعم.{0,20}(مو|لست) (بوت|روبوت)"] });
S("ps1-thanks", "persona: closing", ["كم سعر كريب زنجر سوبريم؟", "تمام يعطيك العافية"],
  { noCart: true, noHandover: true, turnMustContain: { 0: "25" }, turnMustNotContain: { 1: "[؟?]|موظف|المساعد الرقمي" }, mustNotContain: NO_ROBOT });
S("ps1-too-expensive-then-no", "persona: objection", ["كم سعر بوكس العائلة؟", "غالي علي والله", "لا خلاص شكراً"],
  { noCart: true, noHandover: true, turnMustContain: { 0: "179" }, turnMustNotContain: { 2: "[؟?]|بوكس" }, mustNotContain: NO_ROBOT });
S("ps1-complaint", "persona: handover", ["السلام عليكم", "طلبي امس وصل بارد وناقص ومحد رد علي"],
  { handover: "complaint", noCart: true, owner: { 1: "rules" }, mustNotContain: NO_ROBOT });
S("ps1-back-after-staff", "persona: after staff", ["السلام عليكم، ابي اطلب عشا لشخصين", { text: "طيب ابي بوكس البرجر لشخصين، الاثنين برجر لحم كلاسيك", staff: "الموظف اعتذر للعميل عن تأخير طلبه السابق وقال إن مدير الفرع سيتصل به اليوم، وأخبره أن الطلب الجديد يتم من هنا." }, "استلام"],
  { cart: { option: "pickup", boxes: [{ slug: "box-burger-duo", choices: [71, 71], price: 65 }], only: true, subtotal: 65 }, turnMustNotContain: { 1: "وعليكم السلام|حياك الله|حيّاك الله|المساعد الرقمي|ماجد|هلا", 2: "المساعد الرقمي" }, mustNotContain: NO_ROBOT, noHandover: true });
S("ps1-english", "persona: English", ["Hi there", "Are you a bot?", "ok, one zinger supreme crepe for pickup please"],
  { cart: { option: "pickup", items: [{ id: 8, qty: 1 }] }, turnMustContain: { 0: "Majed", 1: "digital assistant" }, mustContain: ["digital assistant"], mustNotContain: ["automated", "🤖", "ماجد", "Dear customer"], noHandover: true });
S("ps1-not-a-customer", "persona: not a customer", ["السلام عليكم، عندكم وظائف شاغرة؟ ابي اقدم على شغل عندكم"],
  { noCart: true, mustContain: ["موظف"], mustNotContain: [...NO_ROBOT, "بوكس", "وش تحب تطلب"] });
export const PS1 = out;
