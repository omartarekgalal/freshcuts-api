/* Set "m45" (13/10, expert review M4/M5 + the "serious" assistant items): another city, «جهزه» after a box-choice question,
   a coupon statement only after get_offers, and the wordings that used to end in «ما فهمت». */
const out = [];
const S = (id, group, turns, expect = {}, world = { profile: "new" }) => out.push({ id, group, sets: ["m45", "full"], world, turns, expect });
const NO = { noCart: true, noHandover: true };
S("m45-mecca", "another city", ["انا في مكة توصلون لي؟"], { ...NO, owner: { 0: "rules" } });      // the fixed owner text (its wording is in the unit tests)
S("m45-city-mid-order", "another city", ["ابي بيتزا تشكن رانش", "توصيل لو سمحت، انا ساكن في عنيزة"], { noCart: true, mustContain: ["جدة"], mustNotContain: ["📎"] });      // a city the rules do not list: the assistant itself says it
S("m45-jahzo", "no repeated question", ["ابغى بوكس الكريب لشخصين استلام", "جهزه", "لا شكرا بس كذا"], { noHandover: true, cart: { option: "pickup", boxes: [{ slug: "box-crepe-duo" }] } });
S("m45-coupon-where", "coupon only after get_offers", ["عندي كود خصم، وين اكتبه؟"], { ...NO });
S("m45-who-are-you", "who are you", ["انت بوت؟"], { ...NO, owner: { 0: "rules" } });
S("m45-pay-transfer", "payment by transfer", ["ابي ادفع تحويل"], { ...NO, owner: { 0: "rules" } });
export const M45 = out;
