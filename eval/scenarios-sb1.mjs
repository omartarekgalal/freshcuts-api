/* Set "sb1" (14/10): «عقل البيع» — Omar's questions of 14/10 on the real lines of 13/10 (27 chats, no cart) plus three scripted customers who DO order.
   A) real lines (word for word from majed_day.txt): the first-order line said when delivery / ordering comes up (it was said only when asked), choice questions as buttons.
   B) buyers: a first-timer whose basket is 10 SAR short of free delivery, a returning customer one order away from his reward, a regular who gets «نفس طلبك؟».
   Every number the assistant says must come from the system (grader: wrong_price); the code lines are checked word for word. */
const out = [];
const AD = { adItem: 103, adText: "مشكل مخصوص على الفحم" };
const FIRST_LINE = "أول طلب توصيل لك من موقعنا مجاني للطلبات من 60 ر.س بكود FIRST";
const S = (id, group, turns, expect = {}, world = {}, closing = false) => out.push({ id: `sb1-${id}`, group, sets: ["sb1"], world: { profile: "new", ...world }, turns, expect, closing });

/* A — the real lines of 13/10 */
S("real-delivery-question", "13/10 8dec0195e90f + 3a538ac59f35 (ad canned question)", ["توصلون حيّنا؟ وكم التوصيل؟"],
  { noCart: true, turnMustContain: { 0: FIRST_LINE }, turnMustNotContain: { 0: "\\b(20|15|10|5) ر\\.س" } }, AD);
S("real-how-to-order", "13/10 bec5953428fb (ad canned question)", ["كيف أطلب من الموقع؟"],
  { noCart: true, turnMustContain: { 0: FIRST_LINE } }, AD);
S("real-grills-for-how-many", "13/10 76dc5d108035 (left after 8 replies)", ["وش عرض أول طلب؟", "أنا تفسي بالمشاوى اليوم", "مشاوى لحم وطرب ودجاج"],
  { noCart: true, turnMustContain: { 0: "FIRST" }, turnButtons: { 1: "شخص واحد|شخصين" }, maxCount: [["FIRST", 1]] }, AD);
S("real-returning-lahm-delivery", "13/10 fe4f85e6c2fd (returning customer, «وأنت طلبتها قبل»)", ["السلام عليكم", "لحم", "عندك توصيل"],
  { noCart: true, mustContain: ["باقي لك|على المكافأة"], mustNotContain: ["FIRST"] }, { profile: "returning", loyaltyN: 1 });
S("real-mashakel-kilo", "13/10 9f74e6d5554b", ["وش عرض أول طلب؟", "موقعكم وين", "مشكل كيلو كم"],
  { noCart: true, turnMustContain: { 2: "155" }, turnButtons: { 2: "توصيل|جهّزه" }, maxCount: [["FIRST", 1]] }, AD);

/* B — customers who order */
S("buyer-first-timer-threshold", "first-timer, 50 SAR delivery basket ⇒ one item to 60 = free delivery with FIRST", ["السلام عليكم", "ابي ثلث كيلو كفتة مشوية بالوزن وبطاطس محمرة وبيبسي زجاج توصيل", "أضفه ✅", "ارسل السلة"],
  { cart: { option: "delivery", items: [{ id: 91, qty: 1 }, { id: 79, qty: 1 }, { id: 86, qty: 1 }], subtotal: 60 }, turnButtons: { 1: "أضفه" }, mustContain: ["يوصل طلبك 60 ر.س ويصير توصيله مجاني بكود FIRST", "التوصيل: مجاني بكود FIRST", "الإجمالي: 60 ر.س"], noHandover: true }, {}, true);
S("buyer-returning-one-to-reward", "returning, 2 of 3 orders: loyalty line with the order; two meals ⇒ the box for two offered once, declined", ["هلا", "ابي وجبة كفتة ووجبة طرب", "لا شكراً", "استلام"],
  { cart: { option: "pickup", items: [{ id: 17, qty: 1 }, { id: 16, qty: 1 }] }, mustContain: ["باقي لك طلب واحد من الموقع", "استلام من الفرع: بدون رسوم توصيل"], turnButtons: { 1: "أضفه|لا شكراً" }, maxCount: [["وجبتين مشاوي لشخصين", 1]], noHandover: true }, { profile: "returning", loyaltyN: 2 }, true);
S("buyer-regular-same-then-mashakel", "regular: «نفس طلبك؟» with the ready-cart button; then the mashakel by weight with rice (6 SAR, now on the menu)", ["هلا", "لا، اليوم ابي مشكل مخصوص", "نص كيلو", "أضفه ✅", "استلام"],
  { cart: { option: "pickup", items: [{ id: 103, qty: 1 }, { id: 123, qty: 1 }] }, turnMustContain: { 0: "نفس(ه| (ال)?طلب)" }, turnButtons: { 0: "نفس طلبي السابق", 1: "شخص واحد" }, noHandover: true }, { profile: "returning", reorder: true, loyaltyN: 4, firstUsed: true }, true);
S("buyer-offers-then-box", "first-timer asks for the offers ⇒ the live block; orders the crepe box for two", ["وش العروض عندكم؟", "ابغى بوكس الكريب لشخصين", "كريب زنجر سوبريم وكريب ميكس دجاج، والجانبي دوريتوس", "استلام"],
  { cart: { option: "pickup", boxes: [{ slug: "box-crepe-duo", choices: [8, 3, 119], price: 65 }] }, turnMustContain: { 0: "عروضنا الحين" }, noHandover: true }, { at: "2026-10-13T15:00:00Z" }, true);
export const SB1 = out;
