/* Set "m3" (13/10, expert review M3): dishes sold by weight carry their weights and prices; a cart by weight.
   Prices in the expectations are the fixture's (fixtures/variants.json): mashakel 53 / 78 / 155, kebab 47 / 70 / 140, kofta 40 / 60 / 120. */
const out = [];
const S = (id, group, turns, expect = {}, world = { profile: "new" }) => out.push({ id, group, sets: ["m3", "full"], world, turns, expect });
const NO = { noCart: true, noHandover: true };
const SERVES = ["\\d+ ?(اشخاص|أشخاص|شخص|افراد|أفراد|people|persons)", "يكفي \\d", "قطع", "ريش\\b.*كباب"];
/* the reviewer's defect: «by the kilo … at <third-kilo price>» — the smallest weight's price said as the kilo price */
const kiloAt = (n) => [`by the kilo[^\\n]{0,12}(at|for|is|costs)[^\\n]{0,10}\\b${n}\\b`, `\\b${n}\\b[^\\n]{0,12}(per|a|the) kilo`, `الكيلو[^\\n]{0,8}\\b${n}\\b`];
S("m3-price-mashakel", "by weight: price", ["كم كيلو المشكل المخصوص؟"], { ...NO, mustContain: ["53", "78", "155"], mustNotContain: SERVES });
S("m3-price-kebab-en", "by weight: price", ["how much is the grilled kebab by the kilo?"], { ...NO, mustContain: ["140"], mustNotContain: kiloAt(47) });
S("m3-price-fast-en", "by weight: price", ["what's the price of the special mixed grill?"], { ...NO, mustContain: ["155"], mustNotContain: kiloAt(53) });
S("m3-cart-two-kilos", "by weight: cart", ["ابي ٢ كيلو مشكل مخصوص استلام", "لا شكرا بس كذا"], { noHandover: true, mustContain: ["310"], cart: { option: "pickup", items: [{ id: 103, qty: 2 }] } });
S("m3-cart-kilo-and-half", "by weight: cart", ["ابي كيلو ونص كباب مشوي استلام", "لا بس كذا"], { noHandover: true, mustContain: ["210"], cart: { option: "pickup" } });
S("m3-ask-weight", "by weight: cart", ["ابي كفتة مشوية بالوزن توصيل"], { ...NO, mustContain: ["كيلو"] });
S("m3-then-weight", "by weight: cart", ["ابي كفتة مشوية بالوزن استلام", "نص كيلو", "لا شكرا"], { noHandover: true, mustContain: ["60"], cart: { option: "pickup", items: [{ id: 91, qty: 1 }] } });
S("m3-serves-how-many", "by weight: owner rule", ["المشكل المخصوص الكيلو يكفي كم شخص؟"], { ...NO, mustNotContain: SERVES });
S("m3-ad-mashakel", "by weight: ad", ["مرحبا", "نص كيلو استلام"], { noHandover: true, mustContain: ["53", "78", "155"], cart: { option: "pickup", items: [{ id: 103, qty: 1 }] } },
  { profile: "new", ad: { ad_text: "مشكل مخصوص على الفحم — راسلنا واتساب", advertised: { kind: "item", id: "103", name: "مشكل مخصوص بالوزن", name_en: "Special Mixed Grill (by the kilo)", by_weight: true,
    weights: [{ label: "ثلث كيلو", label_en: "1/3 Kilo", price: 53, variant_option_id: 56 }, { label: "نصف كيلو", label_en: "1/2 Kilo", price: 78, variant_option_id: 57 }, { label: "كيلو", label_en: "Kilo", price: 155, variant_option_id: 58 }] } } });
export const M3 = out;
