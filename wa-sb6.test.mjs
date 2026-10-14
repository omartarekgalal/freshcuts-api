/* S1 — «البيع الشخصي» لماجد (١٤/١٠). التصميم: docs/designs-2026-10/whatsapp/personal-upsell-design-2026-10-14.txt (S1).
   عادة العميل («زي العادة»)، البوكس اللي فيه طبقه قبل الإضافات (بفحص القيمة)، الأرز مع المشاوي بالوزن بس، مشروب لكل شخص، بوكس العيلة، الكومبو، الرسوم بالأهمية
   مع tierNetOnly، ذاكرة الرفض بين المحادثات، الرد بالكود على «أضفه» بالكمية وسطر التوصيل المجاني، والقياس (المحسوب اللي ماتعرضش بسببه).
   على منيو وبوكسات ١٢/١٠ (نفس المنيو الحي النهارده بالأسعار والخانات). من غير أي نداء موديل ولا شبكة.      node --test wa-sb6.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "./waassist.js";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import * as S from "./wasales.js";
import * as P from "./wapersonal.js";
import { LIMITS } from "./wabot.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const W0 = makeWorld({}, {});
const ON = AR.assistConfig({ mode: "test" });      // إعدادات اللوحة الافتراضية: كل بنود S1 شغّالة
const botCfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } });
const item = (id) => W0.menu.items.find((i) => i.id === String(id));
const L = (id, qty = 1) => { const it = item(id); return { id: it.id, name: it.name, price: it.price, qty, kind: A.kindOf(it) }; };
const WL = (id, label) => { const it = item(id), w = it.weights.find((x) => x.label_ar === label); return { id: it.id, name: it.name, price: w.price, qty: 1, kind: "main", weight: w.label_ar, variant_option_id: w.variant_option_id }; };
const BOX = (slug, contains) => { const b = W0.boxes.find((x) => x.slug === slug); return { slug, name: b.name, price: b.price, qty: 1, kind: "box", contains }; };
const TOPS = ["79", "18", "8", "59", "13", "3", "71"];
const S1 = (lines, ctx = {}, c = ON) => A.suggestOne({ lines, subtotal: lines.reduce((a, l) => a + l.price * l.qty, 0), option: "pickup" }, { menu: W0.menu, boxes: W0.boxes, topSellers: TOPS, pairing: A.PAIRING_DEFAULT, ...ctx }, c);
const brief = (s) => (s ? { kind: s.kind, rule: s.rule, ref: s.box ? s.box.slug : s.item ? s.item.id : s.slug, qty: s.qty, total: s.total } : null);
const line = (s, lang = "ar") => { const v = S.suggestionVars(s); return v ? R.salesTextOf(botCfg, v.key, v.vars, lang) : null; };
const REC = { v: 1, orders: 5, usual: { crepe: [{ id: "86", qty: 1, pct: 80 }] }, sd: [], drink: { id: "86", qty: 1 }, neverSide: false, neverDrink: false, avoid: [] };
const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (...u) => ({ ok: true, content: u.map(([name, input], i) => ({ type: "tool_use", id: `u${i}${name}`, name, input })), stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
function chat(steps, { world = {}, acfg = {}, personal = null, mem = null } = {}) {
  let i = 0; const seen = [];
  const W = makeWorld(world, { callModel: async (a) => { seen.push(JSON.parse(JSON.stringify(a))); return steps[i++] || say("تمام."); }, onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg: { forceSuggestion: false, ...acfg } });
  let session = null, first = true;
  const turn = async (text, { tap = null, ctx = {} } = {}) => { const hours = await W.tools.get_hours(); const fresh = !session; if (fresh) session = AR.newSession(W.now());
    let profile = null, offers = null; if (first) { profile = (await W.tools.customer_profile(PHONE)).profile; offers = await W.tools.get_offers(PHONE); }
    const r = await W.loop.runTurn({ phone: PHONE, text, lang: "ar", session, acfg: { ...W.acfg, routing: "strong" }, context: AR.buildContext({ first: fresh, hours, boxes: W.boxes, profile, offers, ...ctx }), profile, ...(first ? { personal, mem } : {}), tap });
    first = false; if (r.ok) session = r.session; return r; };
  return { W, turn, seen, calls: () => seen.length };
}

test("(1) «إضافة كومبو» is an add-on that covers a side and a drink, not a crepe; what a box holds is read from its live slots", () => {
  const combo = item(118);
  assert.deepEqual([A.kindOf(combo), P.coversOf(combo), P.dishType(combo)], ["side", ["side", "drink"], null]);
  assert.deepEqual([...A.cartFamilies({ lines: [L(8), L(118)] }, W0.menu)], ["crepe_x1"], "crepe + combo = ONE crepe (before S1: crepe_x2 ⇒ the box for two)");
  assert.deepEqual((({ mains, side, drink }) => [mains, side, drink])(A.cartCover({ lines: [L(8), L(118)] }, { menu: W0.menu, boxes: W0.boxes })), [1, 1, 1]);
  assert.equal(S1([L(8), L(118)], { pairing: null }, { ...ON, boxForDish: false }), null, "no drink on top of the combo's can, no side on top of its fries");
  const half = A.cartCover({ lines: [BOX("box-grill-half-half", ["91", "94", "123", "79", "72"])] }, { menu: W0.menu, boxes: W0.boxes });
  assert.deepEqual([half.mains, half.drink, half.side > 0, half.rice], [2, 0, true, true], "نص ونص holds rice, fries and coleslaw — no drinks (before S1 every box «had a drink»)");
  const mash = A.cartCover({ lines: [BOX("box-mashakel", ["103", "91", "123", "79", "72"])] }, { menu: W0.menu, boxes: W0.boxes });
  assert.deepEqual([mash.drink, mash.rice], [0, true]);
  const duo = A.cartCover({ lines: [BOX("box-crepe-duo", ["9", "8", "78", "79", "82"])] }, { menu: W0.menu, boxes: W0.boxes });
  assert.deepEqual([duo.mains, duo.drink], [2, 2], "slot quantities count: the crepe box for two holds two drinks");
  assert.equal(A.cartCover({ lines: [{ slug: "box-gone", qty: 1, kind: "box" }] }, { menu: W0.menu, boxes: W0.boxes }).known, false, "a box whose slots are unknown is assumed to hold a drink and a side, as before");
});

test("(2) the per-phone record: habits per dish type at ≥60% and ≥2 orders, POS spellings mapped to live ids, zero-price and box lines are not add-ons, staff numbers get nothing", () => {
  const NOW = new Date("2026-10-14T18:00:00Z"), day = (d) => new Date(NOW.getTime() - d * 86400_000).toISOString();
  const res = P.resolverFor(W0.menu.items);
  assert.deepEqual(["كلوسلو", "تشيكن بينا الفريدو", "حواوشي موتزريلا", "فرايد موتزريلا", "ارز ساده", "pepsi - can", "مشروبات غازية - كان", "كفتة مشوية بالوزن - كيلو", "بيتزا تشيكن رانش 1.0 بدون حشو اطراف"].map(res), ["72", "56", "19", "74", "123", "82", "82", "91", "43"]);
  const prof = { identity: { name: "x" }, orders: [
    { source: "pos", at: day(3), items: [{ name: "كريب زنجر سوبريم", qty: 1, amount: 25 }, { name: "بيبسي زجاج", qty: 1, amount: 4 }] },
    { source: "pos", at: day(10), items: [{ name: "كريب سوبر كرانشي", qty: 1, amount: 28 }, { name: "بيبسي زجاج", qty: 2, amount: 8 }, { name: "كلوسلو", qty: 1, amount: 6 }] },
    { source: "pos", at: day(20), items: [{ name: "كريب ميكس دجاج", qty: 1, amount: 29 }, { name: "بيبسي زجاج", qty: 1, amount: 4 }] },
    { source: "pos", at: day(30), items: [{ name: "كفتة مشوية بالوزن - نصف كيلو", qty: 1, amount: 60 }, { name: "ارز ساده", qty: 1, amount: 0 }] },
    { source: "pos", at: day(31), items: [{ name: "كفتة مشوية بالوزن - نصف كيلو", qty: 1, amount: 60 }, { name: "ارز ساده", qty: 1, amount: 0 }] },
    { source: "web", orderNo: "W1790000000001", at: day(40), items: [{ name: "كريب زنجر سوبريم", qty: 1, amount: 22, box: true }, { name: "كولسلو", qty: 1, amount: 4, box: true }, { name: "مشروبات غازية", qty: 1, amount: 2, box: true }] },
    { source: "pos", at: day(5), void: true, items: [{ name: "كريب زنجر سوبريم", qty: 1, amount: 25 }, { name: "مياه", qty: 1, amount: 1 }] },
    { source: "pos", at: day(400), items: [{ name: "كريب زنجر سوبريم", qty: 1, amount: 25 }, { name: "مياه", qty: 1, amount: 1 }] },
  ], reviews: [{ rating: 2, orderNo: "W1790000000001", at: day(39) }, { rating: 5, orderNo: "W1", at: day(2) }] };
  const r = P.personalOf(prof, { menu: W0.menu, now: NOW });
  assert.deepEqual(r.usual, { crepe: [{ id: "86", qty: 1, pct: 75 }] }, "بيبسي زجاج in 3 of 4 crepe orders; the boxed crepe counts as a crepe order, its contents are not add-ons");
  assert.equal(r.usual.weight, undefined, "the free rice of the offer (0 SAR) is not a habit");
  assert.deepEqual([r.orders, r.sd, r.drink, r.neverSide, r.neverDrink], [6, [], { id: "86", qty: 1 }, false, false], "the void order and the one older than habitDays are out");
  assert.deepEqual(r.avoid.sort(), ["72", "8", "82"], "the items of an order rated 2 are never suggested to him");
  assert.ok(JSON.stringify(r).length < 1024);
  assert.equal(P.personalOf({ ...prof, identity: { isStaff: true } }, { menu: W0.menu, now: NOW }), null, "staff numbers: no record");
  assert.equal(P.personalOf(prof, { menu: null, now: NOW }), null, "no live menu: no record (nothing is guessed)");
  assert.equal(Object.keys(P.personalOf(prof, { menu: W0.menu, now: NOW, cfg: { habitMinShare: 80 } }).usual).length, 0, "the threshold is the dashboard setting");
  const combo = P.personalOf({ orders: [1, 2, 3].map((d) => ({ source: "pos", at: day(d), items: [{ name: "كريب زنجر سوبريم", qty: 1, amount: 25 }, { name: "إضافة كومبو", qty: 1, amount: 6 }] })) }, { menu: W0.menu, now: NOW });
  assert.deepEqual([combo.usual.crepe[0].id, combo.sd], ["118", ["crepe"]], "a combo regular: his usual is a side and a drink together ⇒ the box comes first");
  const never = P.personalOf({ orders: [1, 2, 3].map((d) => ({ source: "pos", at: day(d), items: [{ name: "باستا بشاميل", qty: 1, amount: 25 }] })) }, { menu: W0.menu, now: NOW });
  assert.deepEqual([never.neverSide, never.neverDrink], [true, true]);
});

test("(3) the order of the rules: box_saves ⇒ his usual («زي العادة») ⇒ the box for the dish ⇒ rice with by-weight grills ⇒ drinks per person ⇒ table items ⇒ combo ⇒ general", () => {
  assert.deepEqual(brief(S1([L(17), L(79), L(82)], { personal: REC })), { kind: "box_saves", rule: "box_saves", ref: "box-solo-meal", qty: undefined, total: undefined }, "the same items as a cheaper box always come first");
  const h = S1([L(8)], { personal: REC });
  assert.deepEqual([brief(h), h.personal], [{ kind: "drink", rule: "habit", ref: "86", qty: 1, total: 4 }, true], "his usual beats the owner's box");
  assert.equal(line(h), "زي العادة، أضيف لك بيبسي زجاج بـ 4 ر.س؟");
  assert.deepEqual(brief(S1([L(8)], { personal: { ...REC, usual: { crepe: [{ id: "118", qty: 1 }] }, sd: ["crepe"] } })), { kind: "pair", rule: "habit_box", ref: "box-solo-crepe", qty: undefined, total: undefined }, "his usual is a side and a drink together ⇒ the box first");
  assert.deepEqual(brief(S1([L(8)])), { kind: "pair", rule: "owner_box", ref: "box-solo-crepe", qty: undefined, total: undefined }, "no record ⇒ the owner's table");
  assert.equal(S1([L(8)], { personal: { ...REC, usual: { pasta: [{ id: "86", qty: 1 }] } } }).rule, "owner_box", "a habit of another dish type does not apply");
  assert.equal(S1([WL(91, "نصف كيلو")]).rule, "rice_weight");
  assert.deepEqual(brief(S1([L(8), L(61)])), { kind: "drink", rule: "drinks_people", ref: "82", qty: 2, total: 6 }, "two mains of different kinds, no drink: one each");
  assert.deepEqual(brief(S1([L(4)])), { kind: "side", rule: "combo", ref: "118", qty: 1, total: 6 }, "a crepe that is no box choice: the combo");
  assert.equal(S1([L(70)]).rule, "combo", "the same for a burger that is no box choice");
  assert.equal(S1([L(8)]).rule, "owner_box", "a crepe that IS a box choice: never the combo");
  const water = { ...W0.menu, items: W0.menu.items.map((i) => (["82", "86"].includes(i.id) ? { ...i, soldOut: true } : i)) };
  assert.deepEqual(brief(S1([L(66)], { menu: water, pairing: null }, { ...ON, boxForDish: false })), { kind: "side", rule: "general".replace("general", "generic"), ref: "79", qty: 1, total: 6 }, "water (1 SAR) is never the one question: below addonMinSar");
  assert.equal(S1([L(66)], { menu: water, pairing: null }, A.ASSIST_DEFAULTS).item.id, "81", "without the S1 settings (old callers): as before");
  assert.equal(S1([L(8), L(61)], { pairing: null }, { ...ON, salesBrain: true, drinksPerPerson: false }).rule, "generic");
});

test("(4) one dish ⇒ the box that holds it, even with the old stored table (pasta, hawawshi, mixgrill, two mixgrill meals, two half kilos), with the value check", () => {
  assert.deepEqual([A.PAIRING_DEFAULT.filter((r) => r.box && ["pasta", "pasta_x1", "hawawshi", "hawawshi_x1"].includes(r.when)).length, A.PAIRING_DEFAULT.some((r) => /mixgrill/.test(r.box || ""))], [0, false], "the stored table has no pasta / hawawshi / mixgrill box rows");
  for (const [lines, slug, price, rule] of [[[L(61)], "box-solo-pasta", 29, "box_for_dish"], [[L(21)], "box-solo-hawawshi", 29, "box_for_dish"], [[L(18)], "box-solo-mixgrill", 39, "box_for_dish"], [[L(18, 2)], "box-mixgrill-duo", 85, "box_for_dish"],
    [[WL(91, "نصف كيلو"), WL(94, "نصف كيلو")], "box-grill-half-half", 125, "box_for_dish"], [[L(17)], "box-solo-meal", 29, "owner_box"], [[L(71)], "box-solo-burger", 29, "owner_box"], [[WL(91, "كيلو")], "box-grill-half-half", 125, "owner_box"]]) {
    const s = S1(lines); assert.deepEqual([s.kind, s.rule, s.box.slug, s.box.price], ["pair", rule, slug, price], lines.map((l) => l.name).join(" + "));
  }
  assert.equal(line(S1([L(18)])), "وبـ 39 ر.س يصير بوكس الميكس جريل الفردي. أحوّله بوكس؟", "the existing template");
  const sur = S1([L(59)]);      // بنا تشيكن كازرول: +4 inside the box
  assert.deepEqual([sur.box.price, sur.box.base_price, sur.box.their_choice_extra, sur.replaces], [33, 29, 4, 28], "the stated price includes the customer's own choice");
  assert.equal(S1([L(21)], {}, { ...ON, boxUpgradeMaxPerMainSar: 1 }).rule, "pair_item", "more than the allowed extra per dish (29 − 20 = 9 > 1) ⇒ no box; the old table row instead");
  assert.equal(S1([L(18)], {}, { ...ON, valueMinGainSar: 50 }).rule, "generic", "the box must add more than it costs");
  assert.equal(S1([L(43), L(41)]).rule, "drinks_people", "two pizzas ⇒ the pizza night box is 13 SAR per pizza more (> 10): not offered");
  assert.equal(S1([L(43), L(41)], {}, { ...ON, boxUpgradeMaxPerMainSar: 14 }).box.slug, "box-pizza-night", "…the limit is a dashboard setting");
  assert.equal(S1([L(61)], {}, { ...ON, boxForDish: false }).rule, "pair_item", "switched off: the old table (pasta ⇒ coleslaw)");
  assert.equal(S1([L(8)], { personal: { ...REC, usual: {}, drink: null, neverSide: true } }).rule, "generic", "3+ orders and never a side ⇒ no box for him");
});

test("(5) rice only with a by-weight grill: never with a meal, never when the cart or a box already holds rice; his usual rice is «زي العادة»", () => {
  const r = S1([WL(91, "نصف كيلو")]);
  assert.deepEqual([r.kind, r.rule, r.item.name, r.qty, r.total], ["pair", "rice_weight", "طبق أرز بسمتي", 1, 6]);
  assert.equal(line(r), "الأرز ما يجي مع المشاوي بالوزن، أضيف لك طبق أرز بسمتي بـ 6 ر.س؟");
  assert.notEqual(S1([WL(91, "نصف كيلو"), L(123)]).rule, "rice_weight", "rice already in the cart");
  assert.notEqual((S1([BOX("box-mashakel", ["103", "91", "123", "79", "72"])]) || {}).rule, "rice_weight", "a box with rice");
  const meal = S1([L(17)], { pairing: A.PAIRING_DEFAULT.filter((x) => x.when !== "meal_x1") }, { ...ON, boxForDish: false });
  assert.notEqual(meal.rule, "rice_weight", "a meal comes with rice"); assert.notEqual(meal.item && meal.item.id, "123");
  const usual = S1([WL(91, "نصف كيلو")], { personal: { ...REC, usual: { weight: [{ id: "123", qty: 1 }] }, drink: null } });
  assert.deepEqual([usual.rule, usual.personal, line(usual)], ["habit", true, "زي العادة، أضيف لك طبق أرز بسمتي بـ 6 ر.س؟"]);
});

test("(6) quantities: never more than the people (or mains) minus the drinks already there; a sharing box without drinks gets drinks for the head count", () => {
  const big = { ...REC, usual: { crepe: [{ id: "86", qty: 3 }] } };
  assert.equal(S1([L(8)], { personal: big }).qty, 1, "usual ×3, one crepe and no head count ⇒ 1");
  const two = S1([L(8)], { personal: big, people: 2 });
  assert.deepEqual([two.qty, two.total, line(two)], [2, 8, "زي العادة، أضيف لكم بيبسي زجاج × 2 بـ 8 ر.س؟"]);
  assert.deepEqual(brief(S1([L(8), L(61), L(82)], { people: 3 })), { kind: "drink", rule: "drinks_people", ref: "86", qty: 2, total: 8 }, "3 people, one drink already ⇒ 2 (of a drink that is not in the cart yet)");
  assert.equal(line(S1([L(8), L(61)], { people: 3 })), "أضيف لكم مشروبات غازية × 3 (واحد لكل شخص) بـ 9 ر.س؟");
  const pd = S1([L(8), L(61)], { personal: { ...REC, usual: {} } });
  assert.deepEqual([pd.item.id, pd.qty, pd.personal, line(pd)], ["86", 2, true, "زي العادة، أضيف لكم بيبسي زجاج × 2 بـ 8 ر.س؟"], "his usual drink, one each");
  assert.equal(S1([L(8), L(61)], { personal: { ...REC, usual: {}, drink: null, neverDrink: true } }).rule, "pair_item", "3+ orders and never a drink ⇒ no drinks for him");
  const nn = [BOX("box-grill-half-half", ["91", "94", "123", "79", "72"])];
  const unknown = S1(nn), four = S1(nn, { people: 4 });
  assert.deepEqual([unknown.rule, unknown.qty_open, line(unknown)], ["box_drinks", true, "بوكس المشاوي نص ونص ما فيه مشروبات، ومشروبات غازية الواحد بـ 3 ر.س. أضيف لكم؟"], "head count unknown: the price of one and one question");
  assert.deepEqual([four.qty, four.total, line(four)], [4, 12, "بوكس المشاوي نص ونص ما فيه مشروبات، أضيف لكم مشروبات غازية × 4 بـ 12 ر.س؟"]);
  const fam = S1([BOX("box-family", ["91", "94", "43", "59", "123", "79", "72", "82"])]);
  assert.deepEqual([fam.kind, fam.rule, ["123", "79", "72"].includes(fam.item.id)], ["side", "box_drinks", false], "a family box with drinks: ONE side that is not in it");
  assert.deepEqual(brief(S1(nn, {}, { ...ON, familyOutside: false })), { kind: "drink", rule: "generic", ref: "82", qty: 1, total: 3 }, "switched off: the general one drink (the box holds none); its two grills are never read as «two people»");
  assert.equal(S1(nn, { people: 3 }, { ...ON, familyOutside: false }).qty, 3, "…but a head count the customer gave does count");
});

test("(7) the fee: the picked item that crosses a step says so; free delivery in reach replaces it with the most relevant item; a step that is not free only pays for itself (tierNetOnly); his usual is never swapped for a fee step", () => {
  const ladder = [{ over: 0, fee: 20 }, { over: 60, fee: 15 }, { over: 80, fee: 10 }, { over: 100, fee: 5 }, { over: 150, fee: 0 }];
  const pep = { id: "86", name: "بيبسي زجاج", price: 4, qty: 1, total: 4, via: "rank" }, fries = { id: "79", name: "بطاطس محمرة", price: 6, qty: 1, total: 6, via: "rank" };
  const at96 = { cart: { subtotal: 96, option: "delivery" }, ladder, candidates: [pep, fries] };
  assert.deepEqual([S.feePlan({ ...at96, netOnly: true }).item.name, S.feePlan({ ...at96, netOnly: false }).item.name], ["بطاطس محمرة", "بيبسي زجاج"], "96 SAR: a 4-SAR Pepsi for a 10 → 5 drop loses 1 SAR — with tierNetOnly the fries (6) instead");
  assert.equal(S.feePlan({ ...at96, netOnly: true, candidates: [pep] }), null, "nothing pays for itself ⇒ no fee step");
  assert.equal(S.feePlan({ ...at96, allowStep: false }), null, "his usual was picked ⇒ not swapped for a non-free step");
  const usual = { ...fries, via: "habit" };
  const free = S.feePlan({ cart: { subtotal: 145, option: "delivery" }, ladder, candidates: [pep, usual], allowStep: false });
  assert.deepEqual([free.free, free.item.name, free.usual, free.total_then, S.suggestionVars(free).key], [true, "بطاطس محمرة", true, 151, "sb_tier_usual_free"], "free delivery from 150: the first candidate that reaches it, in relevance order");
  assert.equal(R.salesTextOf(botCfg, "sb_tier_usual_free", S.suggestionVars(free).vars, "ar"), "زي العادة بطاطس محمرة بـ 6 ر.س، ومعه يصير التوصيل مجاني بدل 5 ر.س، والإجمالي 151 ر.س. أضيفه؟");
  const cross = S.feePlan({ cart: { subtotal: 76, option: "delivery" }, ladder, pick: { item: { id: "86", name: "بيبسي زجاج", price: 4 }, qty: 1, total: 4 } });
  assert.deepEqual([cross.cross, cross.fee_now, cross.fee_then, cross.total_then], [true, 15, 10, 90]);
  const s = { kind: "drink", rule: "habit", personal: true, item: { id: "86", name: "بيبسي زجاج", price: 4 }, qty: 1, total: 4, tier: cross };
  assert.equal(line(s), "زي العادة بيبسي زجاج بـ 4 ر.س، ومعه ينزل التوصيل من 15 إلى 10 ر.س. أضيفه؟");
  const first = S.feePlan({ cart: { subtotal: 55, option: "delivery" }, ladder, first: { eligible: true, from: 60, code: "FIRST" }, pick: { item: { id: "79", name: "بطاطس محمرة", price: 6 }, qty: 1, total: 6 } });
  assert.deepEqual([first.cross, first.free, first.with_code], [true, true, "FIRST"]);
  assert.equal(S.suggestionVars({ ...s, tier: first }).key, "sb_tier_first", "free with a code: the code is always said");
  assert.equal(S.feePlan({ cart: { subtotal: 62, option: "delivery" }, ladder, first: { eligible: true, from: 60, code: "FIRST" }, candidates: [pep] }), null, "already free with his code");
  assert.equal(S.feePlan({ cart: { subtotal: 40, option: "pickup" }, ladder, candidates: [pep] }), null, "pickup: no fee talk");
  const rw = S.feePlan({ cart: { subtotal: 56, option: "delivery" }, ladder, reward: { free: true, from: 60, code: "LOY-7K2M" }, candidates: [fries] });
  assert.deepEqual([rw.free, rw.with_code, rw.order_from], [true, "LOY-7K2M", 60], "his reward code counts as free delivery in reach");
});

test("(8) decline memory across chats: a declined item rests 14 days; a kind declined in 2 chats within 60 days rests 60; ignored in 2 chats = one decline; accepted later = forgiven", () => {
  const NOW = new Date("2026-10-14T18:00:00Z"), ago = (d) => new Date(NOW.getTime() - d * 86400_000).toISOString();
  const rows = [{ kind: "drink", rule: "habit", ref: "86", outcome: "declined", at: ago(3), session_id: "s1" }, { kind: "side", rule: "generic", ref: "79", outcome: "declined", at: ago(20), session_id: "s2" },
    { kind: "pair", rule: "rice_weight", ref: "123", outcome: "offered", at: ago(5), session_id: "s3" }, { kind: "pair", rule: "rice_weight", ref: "123", outcome: "offered", at: ago(9), session_id: "s4" },
    { kind: "drink", rule: "drinks_people", ref: "82", outcome: "declined", at: ago(30), session_id: "s5" }, { kind: "drink", rule: "drinks_people", ref: "82", outcome: "declined", at: ago(50), session_id: "s6" },
    { kind: "side", rule: "combo", ref: "118", outcome: "declined", at: ago(10), session_id: "s7" }, { kind: "side", rule: "combo", ref: "118", outcome: "accepted", at: ago(2), session_id: "s8" }];
  const m = P.declineMemory(rows, NOW, {});
  assert.deepEqual(m.items.sort(), ["123", "86"], "3 days ago: rests; 20 days: free again; ignored twice: one decline; the combo was accepted after");
  assert.deepEqual(m.rules, ["drinks_people"], "declined in two chats 20 days apart");
  assert.deepEqual(P.declineMemory(rows, NOW, { declineCoolDays: 0 }).items, [], "0 = no memory");
  assert.deepEqual(P.declineMemory(rows, new Date(NOW.getTime() + 40 * 86400_000), {}).rules, [], "the mute ends 60 days after the decline that triggered it");
  const sk = [];
  assert.equal(S1([L(8)], { personal: REC, mem: { items: ["86"], rules: [] }, skipped: sk }).rule, "owner_box", "his usual Pepsi was declined: the next rule");
  assert.deepEqual(sk, [{ rule: "habit", kind: "drink", ref: "86", name: "بيبسي زجاج", reason: "remembered_decline" }], "…and the skipped one is recorded with its reason");
  assert.equal(S1([L(8)], { personal: REC, mem: { items: [], rules: ["habit"] } }).rule, "owner_box", "a muted kind");
  const sk2 = [];
  assert.equal(S1([L(61)], { mem: { items: ["box-solo-pasta"], rules: [] }, skipped: sk2 }).rule, "pair_item", "a box declined in an earlier chat rests too");
  assert.deepEqual(sk2.map((x) => [x.rule, x.ref, x.reason]), [["box_for_dish", "box-solo-pasta", "remembered_decline"]]);
});

test("(9) people: from the «كم شخص» list, «لشخصين», «٣–٤ أشخاص» (the lower number), «احنا 4»; a number of dishes is not a head count", () => {
  assert.deepEqual(["شخصين", "ثلاثة أو أربعة", "خمسة أو ستة", "سبعة وأكثر", "Two", "ابي عشا لشخصين", "احنا ٣-٤ اشخاص", "احنا 4", "3 أشخاص"].map((t) => P.peopleOf([t])), [2, 3, 5, 7, 2, 2, 3, 4, 3]);
  assert.deepEqual(["ثلاث كريب", "يكفي كم شخص؟", "ابي وجبتين", ""].map((t) => P.peopleOf([t])), [null, null, null, null]);
  assert.equal(P.peopleOf(["لشخصين", "ابي كريب"]), 2, "the latest message that says it");
});

test("(10) the loop: the record stays in code (never in the model's context); «أضفه ✅» read from the button id with its quantity; free delivery is said once the total passes it", async () => {
  const rec = { ...REC, usual: {}, drink: null };
  const c = chat([use(["preview_cart", { option: "delivery", items: [{ id: "8", qty: 1 }, { id: "61", qty: 1 }] }]), say("كريب زنجر سوبريم وباستا بشاميل: المجموع 50 ر.س.")], { world: { profile: "new" }, personal: rec, mem: { items: [], rules: [] } });
  const r1 = await c.turn("ابي كريب زنجر سوبريم وباستا بشاميل");
  const sg = r1.trace.tools[0].result.suggestion;
  assert.deepEqual([sg.rule, sg.qty, sg.total, "pct" in sg], ["drinks_people", 2, 6, false], "the model sees a quantity and a total, no evidence fields");
  assert.match(r1.text, /أضيف لكم \*مشروبات غازية\* × 2 \(واحد لكل شخص\) بـ 6 ر.س؟$/);
  assert.deepEqual(r1.buttons, { kind: "sg" });
  assert.deepEqual(r1.session.state.personal, rec, "the record is kept in the conversation state for the code");
  assert.ok(!/neverSide|"usual"|"avoid"/.test(JSON.stringify(c.seen)), "…and never sent to the model");
  assert.deepEqual(r1.session.state.offered.map((o) => [o.kind, o.ref, o.qty]), [["drink", "82", 2]]);
  const before = c.calls();
  const r2 = await c.turn("تمام", { tap: "as:sg:yes" });      // the button title was edited in the dashboard: the id still counts
  assert.equal(c.calls(), before, "no model call");
  assert.equal(r2.text, "تمام، أضفت *مشروبات غازية* × 2 ✅ المجموع 56 ر.س.\nتوصيل ولا استلام؟");
  assert.deepEqual([r2.buttons, r2.trace.fastPath, r2.session.state.offered[0].outcome], [{ kind: "mode" }, "accepted:ask_mode", "accepted"]);
  assert.ok(r2.trace.suggestions.some((s) => s.outcome === "accepted" && s.by === "tap"));
  // 55 SAR + 2 drinks = 61 ⇒ his first delivery order is free (FIRST from 60): said in the confirmation
  const f = chat([use(["preview_cart", { option: "delivery", items: [{ id: "1", qty: 1 }, { id: "61", qty: 1 }] }]), say("كريب ميكس لحوم وباستا بشاميل: المجموع 55 ر.س.")], { world: { profile: "new" }, personal: rec });
  const f1 = await f.turn("ابي كريب ميكس لحوم وباستا بشاميل");
  assert.equal(f1.session.state.proactive, "first", "the first-order line was already said with the offer");
  const f2 = await f.turn("أضفه ✅", { tap: "as:sg:yes" });
  assert.equal(f2.text, "تمام، أضفت *مشروبات غازية* × 2 ✅ المجموع 61 ر.س، ولو توصيل يصير مجاني 🎁\nتوصيل ولا استلام؟");
  assert.equal(f2.trace.freeLine, "first");
  // «لا شكراً» from the button id
  const n = chat([use(["preview_cart", { option: "delivery", items: [{ id: "8", qty: 1 }, { id: "61", qty: 1 }] }]), say("المجموع 50 ر.س.")], { world: { profile: "new" } });
  await n.turn("ابي كريب زنجر سوبريم وباستا بشاميل");
  const n2 = await n.turn("x", { tap: "as:sg:no" });
  assert.deepEqual([n2.text, n2.session.state.declined], ["تمام 👍 توصيل ولا استلام؟", ["drink"]]);
});

test("(11) the loop: his usual that crosses a fee step says it in the same line; «غالي», a pending handover or a complaint ⇒ no offer, recorded as worked out with the reason", async () => {
  const c = chat([use(["preview_cart", { option: "delivery", items: [{ id: "8", qty: 1 }, { id: "9", qty: 1 }, { id: "4", qty: 1 }] }]), say("ثلاث كريبات: المجموع 76 ر.س.")], { world: { profile: "returning" }, personal: REC });
  const r = await c.turn("ابي كريب زنجر سوبريم وكريب سوبر كرانشي وكريب هوت دوج توصيل");
  const sg = r.trace.tools[0].result.suggestion;
  /* مراجعة ١٥/١٠: ٤ ر.س بيبسي تنزّل الرسوم ١٥ ⇒ ١٠ (٥ ر.س) = خسارة ⇒ «زي العادة» من غير سطر الرسوم (tierNetOnly) */
  assert.deepEqual([sg.rule, sg.personal, Boolean(sg.tier && sg.tier.cross)], ["habit", true, false]);
  assert.match(r.text, /زي العادة، أضيف لك \*بيبسي زجاج\* بـ 4 ر.س؟$/);
  assert.doesNotMatch(r.text, /ينزل التوصيل/);
  const g = chat([use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }, { id: "61", qty: 1 }] }]), say("المجموع 50 ر.س.")], { world: { profile: "new" } });
  const gr = await g.turn("غالي شوي، بس ابي كريب زنجر سوبريم وباستا بشاميل");
  assert.equal(gr.trace.tools[0].result.suggestion, null, "«غالي»: no add-on (the model offers one cheaper option of the same kind)");
  assert.deepEqual(gr.trace.suggestions.map((s) => [s.outcome, s.reason]), [["computed", "pricey"]]);
  assert.equal(gr.session.state.pricey, true, "…for the rest of the chat");
  const h = chat([use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }, { id: "61", qty: 1 }] }]), say("المجموع 50 ر.س.")], { world: { profile: "new" } });
  const hr = await h.turn("ابي كريب زنجر سوبريم وباستا بشاميل", { ctx: { handover: { reason: "asked_human", minutes_ago: 2 } } });
  assert.deepEqual([hr.trace.tools[0].result.suggestion, hr.trace.suggestions[0].reason], [null, "handover"]);
  const k = chat([use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }, { id: "61", qty: 1 }] }]), say("المجموع 50 ر.س.")], { world: { profile: "new" } });
  assert.equal((await k.turn("الطلب وصل بارد، ابي كريب زنجر سوبريم وباستا بشاميل")).trace.suggestions[0].reason, "complaint");
});

test("(12) measurement: worked-out rows are recorded with their reason; stats() counts only shown rows as offered and splits by rule with the SAR added", async () => {
  const seen = [];
  const pool = { async query(sql, p = []) { const s = String(sql); seen.push([s, p]); const max = Math.max(0, ...[...s.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))); assert.equal(max, p.length, `placeholders vs parameters: ${s.slice(0, 70)}`);
    if (/^\s*UPDATE wa_assist_suggestions/.test(s)) return { rows: [{ id: 1 }] }; return { rows: [] }; } };
  const st = AR.makeAssistStore({ pool, log: () => {} });
  await st.ensure(); assert.match(seen[0][0], /CREATE INDEX IF NOT EXISTS wa_assist_sugg_phone_idx ON wa_assist_suggestions\(phone_norm, at DESC\)/);
  const offered = { kind: "drink", ref: "82", name: "مشروبات غازية", numbers: { rule: "drinks_people", qty: 2, added_sar: 6 }, outcome: "offered" };
  await st.recordSuggestions(PHONE, "s1", 7, [{ kind: "drink", ref: "82", outcome: "computed", numbers: {} }, offered, { kind: "pair", ref: "box-solo-crepe", outcome: "computed", reason: "fee_options", numbers: { rule: "owner_box" } },
    { kind: "pair", ref: "box-solo-crepe", outcome: "computed", reason: "fee_options", numbers: { rule: "owner_box" } }]);
  const ins = seen.filter(([q]) => /INSERT INTO wa_assist_suggestions/.test(q));
  assert.deepEqual(ins.map(([q, p]) => [/'computed'/.test(q) ? "computed" : "offered", p[5], q.includes("'computed'") ? JSON.parse(p[7]).reason : null]), [["offered", "82", null], ["computed", "box-solo-crepe", "fee_options"]], "the computed twin of an offered row and a duplicate are not written twice");
  seen.length = 0;
  const rows = await st.declinesOf(PHONE, 120);
  assert.deepEqual(rows, []); assert.match(seen[0][0], /outcome IN \('offered','accepted','declined'\)/); assert.deepEqual(seen[0][1], [PHONE, 120]);
  seen.length = 0;
  const out = await st.stats(7);
  const byKind = seen.find(([q]) => /SELECT kind, count\(\*\)::int AS offered/.test(q))[0];
  assert.match(byKind, /AND outcome IN \('offered','accepted','declined'\) GROUP BY 1/, "offered = shown only (before S1 a computed row would have counted)");
  assert.ok(seen.some(([q]) => /COALESCE\(numbers->>'rule', kind\) AS rule/.test(q)) && seen.some(([q]) => /numbers->>'reason'/.test(q)) && seen.some(([q]) => /added_sar_paid/.test(q) && /it->>'product_id' = s.ref OR it->>'bundle' = s.ref/.test(q)));
  assert.deepEqual(Object.keys(out).filter((k) => ["suggestions", "rules", "blocked", "upsell", "orders"].includes(k)).sort(), ["blocked", "orders", "rules", "suggestions", "upsell"]);
  // the numbers JSON of a recorded suggestion
  const c = chat([use(["preview_cart", { option: "pickup", items: [{ id: "18", qty: 1 }] }]), say("وجبة ميكس جريل بـ 37 ر.س.")], { world: { profile: "new" } });
  const r = await c.turn("ابي وجبة ميكس جريل");
  const n = r.trace.suggestions.find((s) => s.outcome === "offered").numbers;
  assert.deepEqual([n.rule, n.moment, n.seg, n.price, n.added_sar, n.personal], ["box_for_dish", "preview", "first_timer", 39, 2, false], "box price minus the dish it replaces");
});

test("(13) every new text: valid for the dashboard, passes the reply checks with the numbers and names of its own suggestion, white dialect; buttons fit WhatsApp", () => {
  const NEW = ["sb_usual", "sb_usual_qty", "sb_tier_usual", "sb_tier_usual_free", "sb_rice_weight", "sb_drinks_people", "sb_box_drinks", "sb_drink_each", "sb_combo", "sb_added_free"];
  for (const k of NEW) for (const lg of ["ar", "en"]) { assert.ok(R.TEXTS[k], k); assert.equal(R.textProblem(k, lg, R.TEXTS[k][lg]), null, `${k} ${lg}`); assert.doesNotMatch(R.TEXTS[k][lg].replace(/\{[a-z_]+\}/g, ""), /\d/, `${k}: no number written in a text`); }
  const ladder = [{ over: 0, fee: 20 }, { over: 60, fee: 15 }, { over: 80, fee: 10 }, { over: 100, fee: 5 }, { over: 150, fee: 0 }];
  const habit = S1([L(8)], { personal: REC }), cross = S.feePlan({ cart: { subtotal: 76, option: "delivery" }, ladder, pick: habit });
  const free = S.feePlan({ cart: { subtotal: 145, option: "delivery" }, ladder, candidates: [{ id: "79", name: "بطاطس محمرة", price: 6, qty: 1, total: 6, via: "habit" }] });
  const cases = [habit, S1([L(8)], { personal: { ...REC, usual: { crepe: [{ id: "86", qty: 2 }] } }, people: 2 }), { ...habit, tier: cross }, free, S1([WL(91, "نصف كيلو")]), S1([L(8), L(61)]),
    S1([BOX("box-grill-half-half", ["91", "94", "123", "79", "72"])], { people: 4 }), S1([BOX("box-grill-half-half", ["91", "94", "123", "79", "72"])]), S1([L(4)])];
  const keys = new Set();
  for (const s of cases) for (const lg of ["ar", "en"]) {
    const v = S.suggestionVars(s); keys.add(v.key);
    const text = R.salesTextOf(botCfg, v.key, v.vars, lg); assert.ok(text, `${v.key} ${lg}`);
    const chk = AR.checkReply(text, { facts: [{ suggestion: s }], know: { menu: W0.menu, boxes: W0.boxes }, lang: lg });
    assert.deepEqual(chk.problems, [], `${v.key} ${lg}: «${text}»`);
  }
  assert.deepEqual(NEW.filter((k) => k !== "sb_added_free" && !keys.has(k)), [], "every suggestion text is reached by a rule");
  const added = R.salesTextOf(botCfg, "sb_added_free", { item: "مشروبات غازية × 2", total: 61, note: "" }, "ar");
  assert.equal(added, "تمام، أضفت مشروبات غازية × 2 ✅ المجموع 61 ر.س، ولو توصيل يصير مجاني 🎁\nتوصيل ولا استلام؟", "no code to add ⇒ the line goes");
  assert.deepEqual(AR.checkReply(added, { facts: [{ subtotal: 61, qty: 2, item: { name: "مشروبات غازية" } }], know: { menu: W0.menu, boxes: W0.boxes }, lang: "ar" }).problems, []);
  for (const lg of ["ar", "en"]) { const ex = R.assistExtras(botCfg, lg, { buttons: { kind: "sg" } });
    assert.deepEqual(ex.buttons.map((b) => b.id), ["as:sg:yes", "as:sg:no"]); for (const b of ex.buttons) assert.ok([...b.title].length <= LIMITS.btnTitle, b.title);
    assert.equal(R.payloadProblem(R.toPayload({ body: "سؤال؟", ...ex }, { cfg: botCfg, lang: lg, interactive: true, footer: false })), null); }
});

test("(14) settings: every S1 knob is in the dashboard schema with an Arabic label, at the design's defaults and ranges; off = the old behaviour", () => {
  const d = AR.assistConfig({});
  const want = { personalSell: true, habitMinShare: 60, habitMinOrders: 2, habitDays: 180, addonMinSar: 3, addonMaxSar: 20, boxForDish: true, boxUpgradeMaxPerMainSar: 10, valueMinGainSar: 2, drinksPerPerson: true, familyOutside: true, comboFallback: true, skipNeverTakes: true, tierNetOnly: true, declineCoolDays: 14, declineMuteAfter: 2, declineMuteDays: 60 };
  for (const [k, v] of Object.entries(want)) { assert.equal(d[k], v, k); const row = AR.ASSIST_SCHEMA[`assist.${k}`]; assert.ok(row && /[؀-ۿ]/.test(row.ar) && row.group === "assist", k); }
  const ranges = { habitMinShare: [30, 100], habitMinOrders: [2, 10], habitDays: [30, 365], addonMinSar: [0, 20], addonMaxSar: [3, 100], boxUpgradeMaxPerMainSar: [0, 40], valueMinGainSar: [0, 20], declineCoolDays: [0, 90], declineMuteAfter: [1, 5], declineMuteDays: [7, 180] };
  for (const [k, [lo, hi]] of Object.entries(ranges)) { assert.deepEqual([AR.ASSIST_SCHEMA[`assist.${k}`].min, AR.ASSIST_SCHEMA[`assist.${k}`].max], [lo, hi], k); assert.equal(AR.assistFromBody({ [k]: hi + 1 }, {}).ok, false, k); assert.equal(AR.assistFromBody({ [k]: lo }, {}).ok, true, k); }
  const keys = R.schemaFor(botCfg).map((r) => r.key);
  for (const k of Object.keys(want)) assert.ok(keys.includes(`assist.${k}`), `${k}: rendered from the server schema (no dashboard deploy)`);
  assert.ok(A.PAIR_WHENS.includes("pasta_x1") && A.PAIR_WHENS.includes("hawawshi_x1"));
  assert.deepEqual(AR.assistFromBody({ pairing: '[{"when":"pasta_x1","box":"box-solo-pasta"}]' }, {}).value.pairing, [{ when: "pasta_x1", box: "box-solo-pasta" }], "the new families are accepted in the table");
  assert.ok(A.cartFamilies({ lines: [L(61)] }, W0.menu).has("pasta_x1") && A.cartFamilies({ lines: [L(21)] }, W0.menu).has("hawawshi_x1") && !A.cartFamilies({ lines: [L(21), L(61)] }, W0.menu).has("pasta_x1"));
});

test("(review 15/10) a non-free fee step is never mentioned when the add-on costs less than the fee drop", () => {
  const ladder = [{ over: 0, fee: 20 }, { over: 60, fee: 15 }, { over: 80, fee: 10 }, { over: 100, fee: 5 }, { over: 150, fee: 0 }];
  const pep = { item: { id: "86", name: "بيبسي زجاج", price: 4 }, qty: 1, total: 4 };
  const lose = S.feePlan({ cart: { subtotal: 76, option: "delivery" }, ladder, pick: pep, netOnly: true });
  assert.ok(!lose || !lose.cross, "76 + 4 = 80 drops the fee 15 → 10: 4 SAR in, 5 given up ⇒ no fee line");
  const ok = S.feePlan({ cart: { subtotal: 76, option: "delivery" }, ladder, pick: { item: { id: "79", name: "بطاطس محمرة", price: 6 }, qty: 1, total: 6 }, netOnly: true });
  assert.equal(ok && ok.cross, true, "a 6-SAR item covers the 5-SAR drop ⇒ the fee line stays");
});
