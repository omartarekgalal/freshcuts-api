/* Set "ps5" (13/10): the real chat …6869, 01:20–01:32 Riyadh, line for line.
   A) «في توصيل؟» → pin → «يعني لو طلبي فوق ال٦٠ يصير ١٥ ريال فقط ؟؟»: yes-first answers, the first-order line for a number that has it, and the hypothetical «طلبي» question answered by the assistant
      (the rules bot had answered «ما فيه طلب مفتوح»).
   B) the order he then dictated: a grill that exists as a meal and by weight is asked once with both; notes are recorded and confirmed, never promised; one offer in the whole conversation;
      short acknowledgements; «ممكن تصورلي؟» gets an honest no. */
const out = [];
const S = (id, group, turns, expect = {}, world = {}) => out.push({ id, group, sets: ["ps5"], world: { profile: "new", ...world }, turns, expect });
S("ps5-6869-delivery-first-order", "the real chat", ["في توصيل؟", { location: "in" }, "يعني لو طلبي فوق ال٦٠ يصير ١٥ ريال فقط ؟؟"],
  { noCart: true, noHandover: true, owner: { 2: "assistant" }, turnMustContain: { 0: "نعم نوصل", 1: "نعم نوصل لك", 2: "مجاني" }, mustContain: ["الموقع|موقعك", "بكود FIRST", "60"], turnMustNotContain: { 0: "\\d+ ?ر\\.س", 2: "ما فيه طلب مفتوح" } }, { loc: "in" });
S("ps5-6869-delivery-ordered-before", "the real chat", ["في توصيل؟", { location: "in" }, "يعني لو طلبي فوق ال٦٠ يصير ١٥ ريال فقط ؟؟"],
  { noCart: true, noHandover: true, owner: { 2: "assistant" }, turnMustContain: { 0: "نعم نوصل", 1: "20", 2: "15" }, mustNotContain: ["FIRST", "ما فيه طلب مفتوح"] }, { loc: "in", profile: "returning" });
S("ps5-6869-the-order", "the real chat", ["شيش طاووق مشوي على الفحم", "وجبة", "والطرب ابغا وجبة، جزء منه مقمر وجزء مستوي عادي", "البيبسي اثنين", "في صوصات؟", "كيف شكل الصوص ممكن تصورلي هوا؟"],
  { noHandover: true, turnMustContain: { 0: "27", 2: "مقمر", 5: "ما [أا]قدر|ما نقدر|لا [أا]قدر" }, mustContain: ["110"], turnButtons: { 0: "وجبة" }, turnMustNotContain: { 5: "[أا]رسل لك صور|بصو[ّ]?ر|أصو[ّ]?ر لك" },
    maxCount: [["[أا]حو[ّ]?له بوكس|يصير بوكس|بوكس لشخصين", 1]], maxLen: { 3: 260 } });
S("ps5-status-real-open-order", "status", ["وين طلبي"], { noCart: true, owner: { 0: "rules" } }, { orders: [{ order_no: "W1790011111111", status: "accepted", option: "delivery", total: 74, created_at: "2026-10-12T14:30:00Z" }] });
/* the first real cart (94 SAR, wrong): the exact lines, with the five pictures as the assistant now gets them */
const PICS = `صورة 1: صفحة صنف «طرب مشوي بالوزن»، الأوزان: ثلث كيلو 47، نصف كيلو 70، كيلو 140
صورة 2: صفحة صنف «شيش طاووق مشوي بالوزن»، الأوزان: ثلث كيلو 37، نصف كيلو 55، كيلو 110
صورة 3: صفحة صنف «فرايد موتزاريلا» بسعر 16
صورة 4: صفحة صنف «تشيلي تشيز فرايز» بسعر 15
صورة 5: صفحة صنف «بيبسي زجاج» بسعر 4`;
S("ps5-6869-wrong-cart-text-only", "the wrong cart", ["شيش طاووق مشوي على الفحم", "وضيف طرب", "ثلاثه ببسي"],
  { noHandover: true, noCart: true, turnMustContain: { 0: "27", 2: "بيبسي زجاج" }, mustContain: ["110", "وجبة", "بالوزن"], turnButtons: { 0: "وجبة" }, mustNotContain: ["مشروبات غازية"] });
S("ps5-6869-wrong-cart-with-pictures", "the wrong cart", [{ text: "شيش طاووق مشوي على الفحم", pictures: PICS }, "نص كيلو من كل واحد، والطرب جزء منه مقمر وجزء مستوي عادي", "ثلاثه ببسي وبدون مويه، توصيل", "خلها زي ما هي وارسل السلة"],
  { noHandover: true, cart: { option: "delivery", items: [{ id: 114, qty: 1 }, { id: 94, qty: 1, note: "مقمر" }, { id: 86, qty: 3 }] }, mustContain: ["طرب مشوي بالوزن.{0,5}نصف كيلو", "بيبسي زجاج"], mustNotContain: ["وجبة طرب", "وجبة شيش طاووق", "مشروبات غازية"], closing: false });
export const PS5 = out;
