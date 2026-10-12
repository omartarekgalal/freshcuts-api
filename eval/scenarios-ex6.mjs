/* Set "ex6" (13/10): by-weight lines. "ex6" = one message that opens the chat (the live case «عايزه نص كيلو كفته»: 7.5 s, 0.138 SAR,
   fast → strong, 4 calls); "ex6s" = the same kind of line inside an assistant conversation (routing: a one-line preview stays on the fast model).
   Prices are the fixture's (fixtures/variants.json): kofta 40 / 60 / 120, kebab 47 / 70 / 140, mashakel 53 / 78 / 155, shish tawook 37 / 55 / 110. */
const out = [];
const S = (set, id, turns, expect = {}) => out.push({ id, group: "by weight", sets: [set, "full"], world: { profile: "new" }, turns, expect });
S("ex6", "ex6-half-kofta", ["عايزه نص كيلو كفته"], { noHandover: true, noCart: true, owner: { 0: "rules" } });      // answered by the rules (wording and cart are in the unit tests)
S("ex6", "ex6-kilo-mashakel", ["ابي كيلو مشكل مخصوص"], { noHandover: true, noCart: true, owner: { 0: "rules" } });      // answered by the rules (wording and cart are in the unit tests)
S("ex6", "ex6-third-tawook", ["ثلث كيلو شيش طاووق لو سمحت"], { noHandover: true, noCart: true, owner: { 0: "rules" } });      // answered by the rules (wording and cart are in the unit tests)
S("ex6", "ex6-two-kilos-kebab", ["٢ كيلو كباب مشوي"], { noHandover: true, noCart: true, owner: { 0: "rules" } });      // answered by the rules (wording and cart are in the unit tests)
S("ex6", "ex6-half-kofta-en", ["half kilo kofta please"], { noHandover: true, noCart: true, owner: { 0: "rules" } });      // answered by the rules (wording and cart are in the unit tests)
S("ex6s", "ex6s-half-kofta", ["السلام عليكم ابي اطلب عشاء وش تنصحني", "خلاص ابي نص كيلو كفته"], { noHandover: true, mustContain: ["60"] });
S("ex6s", "ex6s-kilo-kebab", ["وش عندكم مشاوي؟", "عطني كيلو كباب مشوي"], { noHandover: true, mustContain: ["140"] });
S("ex6s", "ex6s-third-mashakel", ["ابي شي مشوي لشخص واحد", "ثلث كيلو مشكل مخصوص"], { noHandover: true, mustContain: ["53"] });
export const EX6 = out;
