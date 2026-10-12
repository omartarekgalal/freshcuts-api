/* Set "as3" (12/10, after Omar's live test): fewer handovers, the assistant beside a pending handover, and the owner's dish facts of the day.
   Several first lines are the exact messages Omar typed in his test (from the bot log). Same format as scenarios.mjs. */
const out = [];
const S = (id, group, turns, expect = {}, world = { profile: "new" }) => out.push({ id, group, sets: ["as3", "full"], world, turns, expect });
const NO = { noCart: true, noHandover: true };
// questions that went to staff in the live test and should not
S("as3-salt", "fewer handovers", ["عندكم ملح ؟"], NO);
S("as3-name", "fewer handovers", ["ما اسمك"], NO);
S("as3-wifi-age", "fewer handovers", ["عندكم واي فاي في المطعم؟", "وكم عمر المطعم؟"], { ...NO, mustNotContain: ["منذ \\d+", "\\d+ (سنة|سنوات|سنين)"] });
S("as3-beef-allergy-general", "allergy, open answers", ["عندي حساسية من اللحم البقري", "طيب كريب هوت دوج فيه لحم؟"], { ...NO, mustNotContain: ["خالي من", "آمن", "مضمون"] });
S("as3-do-dishes-cause-allergy", "allergy, open answers", ["هل الاصناف تسبب الحساسية"], { ...NO, mustNotContain: ["خالي من", "آمن", "مضمون", "ما عندنا مكسرات"] });
// the owner's facts of 12/10, through the approved texts
S("as3-burger-egg", "owner facts", ["هل البرجر الكلاسيك فيه بيض"], { ...NO, mustContain: ["قد يوجد بيض", "الصوص", "ملاحظة"] });
S("as3-kofta-sesame", "owner facts", ["هل وجبة الكفتة فيها سمسم حساسية ؟"], { ...NO, mustContain: ["الطحينة فقط", "الكفتة نفسها بدون سمسم", "ملاحظة"] });
S("as3-hawawshi-sesame", "owner facts", ["حواوشي موتزاريلا فيه سمسم؟"], { ...NO, mustContain: ["خبز الحواوشي بدون سمسم"] });
S("as3-celery-skillet", "owner facts", ["طاسة الأكيلة فيها كرفس؟"], { ...NO, mustContain: ["كرفس", "الصوص"] });
S("as3-burger-other-bread", "owner facts", ["ابي برجر لحم كلاسيك بس بخبز توست بدل خبز البرجر"], { handover: "needs_staff", noCart: true });
S("as3-zinger-not-spicy", "owner facts", ["ابي كريب زنجر سوبريم بس بدون حار"], { noHandover: true, mustContain: ["كريب ستربس"] });
S("as3-skillet-sauce", "owner facts", ["طاسة برجر الصوص يجي عليها ولا جنبها؟"], { ...NO, mustContain: ["جانب"] });
S("as3-fried-chicken-what", "owner facts", ["فرايد تشيكن ايش هو بالضبط؟"], { ...NO, mustContain: ["ثاوزند|مقرمش"] });
S("as3-crunchy-fries-beef", "owner facts", ["كرانشي فرايز تشيز فيها لحم بقري؟"], { ...NO, mustContain: ["نعم"] });
// beside a pending handover: the assistant keeps helping and does not hand over again
S("as3-while-waiting-for-staff", "pending handover", ["ابي اكلم موظف", "طيب على ما يرد، عندكم عروض؟", "ومتى يرد الموظف؟"], { handover: "asked_human", noAssistantHandover: true, owner: { 0: "rules", 1: "assistant" }, mustNotContain: ["خلال \\d+", "\\d+ ?دقيق", "بعد شوي يرد", "حالاً"] });
S("as3-custom-offer-then-order", "pending handover", ["عندنا عزيمة خمسين شخص وابي عرض مخصص", "ابي عرض مخصص: 50 شخص، السبت 8 مساء، توصيل", "وعلى ما يردون علي ابي لنفسي الحين كريب ستربس استلام"], { handover: "custom_offer", cart: { option: "pickup", items: [{ id: 83, qty: 1 }] } });
// real handovers stay handovers
S("as3-asks-for-person-mid-order", "real handovers", ["ابي بيتزا", "لا خلاص ابي اكلم موظف"], { handover: "asked_human", owner: { 1: "rules" } });
S("as3-complaint", "real handovers", ["الاكل وصل بارد وناقص"], { handover: "complaint", owner: { 0: "rules" }, noCart: true });
export const AS3 = out;
