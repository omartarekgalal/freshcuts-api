/* Set "ps4" (13/10): the sell-more playbook's starred rows, with the real lines of the night of 12/10 (39 assistant replies in 12 chats, no cart).
   Row 3  the fee moment: three computed options with the arithmetic + two buttons, on a fee objection and before a small delivery cart; FIRST only when this number is eligible.
   Row 2  «المنيو» = the rules bot's sections list + the menu link, not a paragraph.
   Row 5  a big box: price + a lighter option before the choices; choices as a list; «جهزه» = the most ordered + «أعتمده؟».
   Row 4  the pairing table: a crepe → the solo box, two crepes → the box for two, a kilo → the half-and-half box; no drink first for grills.
   Row 6  the first reply of an ad chat: the advertised dish with its weight prices + buttons; a weight + a grill goes to the assistant.
   Row 10 a short question gets the short part of the answer.
   Fixture numbers: fees 20 / 15 from 60 / 10 from 80 / 5 from 100 / 0 from 150; FIRST = free delivery from 60 on the first order; kofta by weight 40 / 60 / 120. */
const out = [];
const S = (id, group, turns, expect = {}, world = {}) => out.push({ id, group, sets: ["ps4"], world: { profile: "new", ...world }, turns, expect });
const AD = { ad_text: "مشكل مخصوص على الفحم", advertised: { kind: "item", id: "103", name: "مشكل مخصوص بالوزن", name_en: "Special Mixed Grill (by the kilo)", by_weight: true,
  weights: [{ label: "ثلث كيلو", label_en: "1/3 Kilo", price: 53, variant_option_id: 56 }, { label: "نصف كيلو", label_en: "1/2 Kilo", price: 78, variant_option_id: 57 }, { label: "كيلو", label_en: "Kilo", price: 155, variant_option_id: 58 }] } };

/* row 3 — …0930 (four orders before, so no FIRST): the real lines */
S("ps4-fee-real-0930", "fee moment", ["السعر اغلي من كيتا", "يعني طلب ب 40 ريال تدفع علي رسوم 20 ريال و في الابلكيشن ببلاش", "لا"],
  { noCart: true, noHandover: true, turnTool: { 1: "delivery_savers" }, turnMustContain: { 1: "40 ر.س \\+ توصيل 20 = 60 ر.س" }, mustContain: ["75", "استلام من الفرع بدون رسوم توصيل = 40"], turnButtons: { 1: "استلام" },
    turnMustNotContain: { 1: "FIRST", 2: "[؟?]" }, mustNotContain: ["تبي أجهز لك طلب\\؟$"] }, { profile: "returning" });
/* row 3 — the golden case: a first delivery order, 40 in the basket: the same total with more food */
S("ps4-fee-first-order-same-total", "fee moment", ["ابي ثلث كيلو كفتة مشوية توصيل", { location: "in" }, "استلام من الفرع"],
  { cart: { option: "pickup", subtotal: 40 }, noHandover: true, mustContain: ["40 ر.س \\+ توصيل 20 = 60 ر.س", "بكود FIRST = 60", "نفس المبلغ"], turnButtons: { 1: "60" } }, { loc: "in" });
/* row 2 + row 10 — «محمد» */
S("ps4-menu-then-chicken", "menu / short answer", ["احتاج اعمل اوردر", "ابي المنيو", "نوع الدجاج ايه"],
  { noCart: true, noHandover: true, owner: { 1: "rules" }, turnMustContain: { 2: "دجاج" }, turnMustNotContain: { 2: "برازيلي|استرالي|أسترالي|الكفتة والطرب" } });
/* row 5 — إسراء: the family box */
S("ps4-big-box-family", "big box / pick for me", ["اى البوكس العائلى", "بوكس العائلة", "تمام جهزه"],
  { noHandover: true, turnMustContain: { 0: "179", 2: "اعتمد|أعتمد" }, mustContain: ["125"], turnMustNotContain: { 0: "المشوي الأول|المشوي الاول" }, turnButtons: { 0: "نص ونص|العائل", 1: "كفت" } });
S("ps4-pick-for-me-meals", "big box / pick for me", ["ابي بوكس وجبتين مشاوي لشخصين", "تمام جهزه"],
  { noHandover: true, turnMustContain: { 0: "65", 1: "اعتمد|أعتمد" }, turnButtons: { 0: "." } });
/* row 4 — the pairing table */
S("ps4-pair-crepe-solo-box", "pairing", ["ابي كريب زنجر سوبريم"], { noHandover: true, turnMustContain: { 0: "29" }, turnMustNotContain: { 0: "مشروبات غازية" } });
S("ps4-pair-two-crepes", "pairing", ["ابي ٢ كريب زنجر سوبريم"], { noHandover: true, turnMustContain: { 0: "65" } });
S("ps4-pair-kilo-half-and-half", "pairing", ["ابي كيلو كفتة مشوية"], { noHandover: true, turnMustContain: { 0: "120" }, mustContain: ["125"], mustNotContain: ["بيبسي|مشروبات غازية"], owner: { 0: "assistant" } });
/* row 6 — the ad chat, the customer's real first message */
S("ps4-ad-first-reply", "ad chat", ["مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟"],
  { noCart: true, noHandover: true, turnMustContain: { 0: "53" }, mustContain: ["78", "155", "ماجد"], turnButtons: { 0: "توصيل" } }, { ad: AD });
export const PS4 = out;
