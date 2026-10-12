/* PS4 — كتاب البيع (١٣/١٠/٢٠٢٦): البنود ٣، ٢، ٥، ٤، ٦، ١٠ — كل بند بإعداده. من غير أي نداء موديل ولا شبكة.
     node --test wa-ps4.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "./waassist.js";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import { makeWorld, PHONE, POLICY } from "./eval/world.mjs";

const cfg0 = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } });
const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (...u) => ({ ok: true, content: u.map(([name, input], i) => ({ type: "tool_use", id: `t${i}${name}`, name, input })), stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
function loop(world, steps, acfg = {}) { let i = 0; const W = makeWorld(world, { callModel: async () => steps[i++], onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg });
  let session = null; const turn = async (text, ctx = {}) => { const hours = await W.tools.get_hours(); const fresh = !session; if (fresh) session = AR.newSession(W.now());
    const r = await W.loop.runTurn({ phone: PHONE, text, lang: "ar", session, acfg: { ...W.acfg, routing: "strong" }, context: AR.buildContext({ first: fresh, hours, boxes: W.boxes, locationShared: Boolean(W.state.loc), ...ctx }) }); if (r.ok) session = r.session; return r; };
  return { W, turn, used: () => i }; }

test("all the PS4 rows are settings (on by default), and the pairing table is validated", () => {
  const a = AR.assistConfig({});
  assert.deepEqual([a.feeMoment, a.menuToRules, a.pickForMe, a.choiceList, a.bigBoxSar, a.pairingEnabled, a.adButtons, a.weightToAssistant, a.faqShort], [true, true, true, true, 140, true, true, true, true]);
  assert.deepEqual(a.pairing, A.PAIRING_DEFAULT);
  const keys = R.schemaFor(cfg0).map((r) => r.key);
  for (const k of ["feeMoment", "menuToRules", "pickForMe", "choiceList", "bigBoxSar", "pairingEnabled", "pairing", "adButtons", "weightToAssistant", "faqShort"]) assert.ok(keys.includes(`assist.${k}`), k);
  assert.deepEqual(AR.assistFromBody({ pairing: '[{"when":"crepe_x1","box":"box-solo-crepe"},{"when":"pasta","item":"كولسلو"}]' }, {}).value.pairing, [{ when: "crepe_x1", box: "box-solo-crepe" }, { when: "pasta", item: "كولسلو" }], "the dashboard may send it as JSON text");
  for (const bad of ["not json", '{"when":"x"}', '[{"when":"nope","box":"b-1"}]', '[{"when":"pasta","item":"كولسلو 6 ر.س"}]', '[{"when":"pasta","box":"Bad Slug"}]']) assert.equal(AR.assistFromBody({ pairing: bad }, {}).ok, false, bad);
  assert.deepEqual(AR.assistConfig({ pairing: "garbage" }).pairing, A.PAIRING_DEFAULT, "a stored value that does not parse falls back to the default");
  for (const k of ["fee_asis", "fee_first", "fee_reward", "fee_same", "fee_step", "fee_step_free", "fee_pickup", "fee_unlocated", "btn_fee_reach", "btn_fee_pickup", "btn_delivery", "btn_other", "menu_link_line"]) { assert.ok(R.TEXTS[k], k); assert.doesNotMatch(R.TEXTS[k].ar.replace(/\{[a-z_]+\}/g, ""), /\d/, `${k}: no number is written in a text`); }
});

test("row 3 — the fee moment: three options with the arithmetic computed by code; FIRST only for an eligible number; the same-total line only when it is the same total", () => {
  const boxes = [{ slug: "duo", name: "بوكس لشخصين", price: 65, section: "لشخصين" }];
  const first = { first_order: { eligible: true, code: "FIRST", free_delivery: true, min_total: 60 }, rewards: [] }, none = { first_order: { eligible: false }, rewards: [] };
  const q = (fee) => ({ ok: true, deliverable: true, fee, far_zone_extra: 0 });
  const sv = A.deliverySavers({ total: 40, offers: first, quote: q(20), ladder: POLICY.feeByTotal, boxes });
  assert.deepEqual(sv.options, { as_is: { order: 40, delivery: 20, total: 60 }, pickup: { order: 40, delivery: 0, total: 40 }, reach: { order: 60, delivery: 0, total: 60, extra_food: 20, with_code: "FIRST", condition: "the customer's first delivery order on our website", vs_as_is: 0 } });
  assert.equal(sv.below_first_step, true);
  assert.equal(R.feeSayOf(cfg0, sv.options, "ar").text, "طلبك 40 ر.س + توصيل 20 = 60 ر.س.\nوإذا وصل طلبك 60 ر.س، أول طلب توصيله مجاني بكود FIRST = 60 ر.س. نفس المبلغ، وأكل بزيادة 20 ر.س.\nأو استلام من الفرع بدون رسوم توصيل = 40 ر.س.");
  // a customer who has ordered before: the next step of the ladder, no FIRST anywhere
  const old = A.deliverySavers({ total: 40, offers: none, quote: q(20), ladder: POLICY.feeByTotal, boxes });
  assert.deepEqual(old.options.reach, { order: 60, delivery: 15, total: 75, extra_food: 20, vs_as_is: 15 });
  assert.equal(R.feeSayOf(cfg0, old.options, "ar").text, "طلبك 40 ر.س + توصيل 20 = 60 ر.س.\nوإذا زدت عليه 20 ر.س يصير التوصيل 15 ر.س، والإجمالي 75 ر.س.\nأو استلام من الفرع بدون رسوم توصيل = 40 ر.س.");
  assert.doesNotMatch(R.feeSayOf(cfg0, old.options, "ar").text, /FIRST|نفس المبلغ/);
  // 39 + 20 = 59 against 60 with the code: not the same total, so the line is not said
  assert.doesNotMatch(R.feeSayOf(cfg0, A.deliverySavers({ total: 39, offers: first, quote: q(20), ladder: POLICY.feeByTotal, boxes }).options, "ar").text, /نفس المبلغ/);
  // no pin: the standard fees, and the customer is told so
  const nl = A.deliverySavers({ total: 40, offers: first, quote: { ok: false, error: "need_location" }, ladder: POLICY.feeByTotal, boxes });
  assert.equal(nl.deliverable, null); assert.match(R.feeSayOf(cfg0, nl.options, "ar", { located: false }).text, /\nالرسوم هذي حسب قيمة الطلب، وتتأكد لموقعك في موقعنا قبل الدفع\.$/);
  // nothing to say when delivery is already free, or there is no basket
  assert.equal(R.feeSayOf(cfg0, A.deliverySavers({ total: 160, offers: none, quote: q(0), ladder: POLICY.feeByTotal, boxes }).options, "ar"), null);
  assert.equal(A.deliverySavers({ total: 0, offers: first, quote: q(20), ladder: POLICY.feeByTotal, boxes }).options, undefined);
  assert.equal(A.deliverySavers({ total: 70, offers: none, quote: q(15), ladder: POLICY.feeByTotal, boxes }).below_first_step, false);
  assert.equal(R.feeSayOf(cfg0, sv.options, "en").text.split("\n")[0], "Your order SAR 40 + delivery 20 = SAR 60.");
  assert.deepEqual(R.assistExtras(cfg0, "ar", { buttons: { kind: "fee", reach: 60 } }).buttons, [{ id: "as:reach", title: "أكمّلها 60 ر.س" }, { id: "as:pickup", title: "استلام من الفرع" }]);
});

test("row 3 in the loop: an objection gets the text word for word (restored if the model rewrites it) with two buttons; a small delivery cart is stopped once for it; the validator refuses a number that is not the tool's", async () => {
  // the real objection of …0930 (ordered before: no FIRST)
  const a = loop({ profile: "returning" }, [use(["delivery_savers", { total: 40 }]), say("معك حق.\nالطلب 40 ر.س + توصيل 20 ر.س = 60 ر.س، ولو زدت 20 يصير 75.\nأيهم يناسبك؟")]);
  const r = await a.turn("يعني طلب ب 40 ريال تدفع علي رسوم 20 ريال و في الابلكيشن ببلاش");
  assert.equal(r.ok, true); assert.equal(r.trace.feeTextRestored, true);
  assert.equal(r.text, "معك حق.\nطلبك 40 ر.س + توصيل 20 = 60 ر.س.\nوإذا زدت عليه 20 ر.س يصير التوصيل 15 ر.س، والإجمالي 75 ر.س.\nأو استلام من الفرع بدون رسوم توصيل = 40 ر.س.\nالرسوم هذي حسب قيمة الطلب، وتتأكد لموقعك في موقعنا قبل الدفع.\nأيهم يناسبك؟");
  assert.deepEqual(r.buttons, { kind: "fee", reach: 60 }); assert.doesNotMatch(r.text, /FIRST/, "FIRST is checked for this number, not assumed");
  // a small delivery cart: build_cart is refused once with the options; the second call builds it
  const b = loop({ profile: "new" }, [use(["build_cart", { option: "delivery", items: [{ id: "8", qty: 1 }] }]), say("أيهم يناسبك؟"), use(["build_cart", { option: "delivery", items: [{ id: "8", qty: 1 }] }]), say("سلتك: كريب زنجر سوبريم = 25 ر.س. اضغط الزر 👇")], { forceSuggestion: true });
  const g = await b.turn("ابي كريب زنجر سوبريم توصيل");
  assert.equal(g.cart, null); assert.equal(g.trace.tools[0].result.error, "fee_options_first"); assert.match(g.text, /^طلبك 25 ر\.س \+ توصيل 20 = 45 ر\.س\.\nوإذا وصل طلبك 60 ر\.س، أول طلب توصيله مجاني بكود FIRST = 60 ر\.س\.\nأو استلام من الفرع/);
  assert.deepEqual(g.buttons, { kind: "fee", reach: 60 }); assert.equal(b.W.carts.length, 0);
  const g2 = await b.turn("خلها زي ما هي");
  assert.equal(g2.cart.subtotal, 25); assert.equal(g2.trace.tools[0].result.ok, true, "once per conversation, and it counts as the one suggestion step");
  // switched off: the cart is built at once
  const off = loop({ profile: "new" }, [use(["build_cart", { option: "delivery", items: [{ id: "8", qty: 1 }] }]), say("سلتك: كريب زنجر سوبريم = 25 ر.س 👇")], { feeMoment: false, forceSuggestion: false });
  assert.equal((await off.turn("ابي كريب زنجر سوبريم توصيل")).cart.subtotal, 25);
  // a pickup cart, or a cart above the first step, is never stopped for it
  const pk = loop({ profile: "new" }, [use(["build_cart", { option: "pickup", items: [{ id: "8", qty: 1 }] }]), say("سلتك: كريب زنجر سوبريم = 25 ر.س 👇")], { forceSuggestion: false });
  assert.equal((await pk.turn("ابي كريب زنجر سوبريم استلام")).cart.subtotal, 25);
  // a number that is not in the tool's result is refused, as everywhere
  const facts = [JSON.stringify(A.deliverySavers({ total: 40, offers: { first_order: { eligible: false }, rewards: [] }, quote: { ok: true, deliverable: true, fee: 20 }, ladder: POLICY.feeByTotal, boxes: [] }))];
  assert.ok(AR.checkReply("طلبك 40 ر.س + توصيل 20 = 60 ر.س، يعني توفّر 35 ر.س.", { facts, lang: "ar" }).problems.some((p) => p.type === "number_not_from_tools" && p.value === "35"));
});

test("row 3 — with a shared pin the moment comes with the real quote, in the reply that would only have stated the fee", async () => {
  const a = loop({ profile: "new", loc: "in" }, [use(["quote_delivery", { total: 40 }]), say("نوصل لك.\nأيهم يناسبك؟")]);
  a.W.state.loc = { lat: 21.58, lng: 39.16 };
  const r = await a.turn("📍", { justShared: true });
  const q = r.trace.tools[0].result;
  assert.equal(q.fee, 20); assert.match(q.fee_moment.say, /^طلبك 40 ر\.س \+ توصيل 20 = 60 ر\.س\.\n.*نفس المبلغ، وأكل بزيادة 20 ر\.س\.\nأو استلام من الفرع بدون رسوم توصيل = 40 ر\.س\.$/s);
  assert.doesNotMatch(q.fee_moment.say, /تتأكد لموقعك/, "the pin is known: no «standard fees» caveat"); assert.ok(r.text.includes(q.fee_moment.say)); assert.deepEqual(r.buttons, { kind: "fee", reach: 60 });
  const big = loop({ profile: "new", loc: "in" }, [use(["quote_delivery", { total: 70 }]), say("نوصل لك، ورسوم التوصيل 15 ر.س.")]); big.W.state.loc = { lat: 21.58, lng: 39.16 };
  assert.equal((await big.turn("📍", { justShared: true })).trace.tools[0].result.fee_moment, undefined, "above the first step: just the fee");
});

test("row 2 — «المنيو» is the rules bot's: the sections list, then the menu link; a browsing question stays with the assistant", () => {
  const A0 = AR.assistConfig({ mode: "test" });
  const E = (text, cls, acfg = {}, extra = {}) => AR.assistEligible({ acfg: { ...A0, ...acfg }, cfg: cfg0, phone: PHONE, ev: { text }, cls, d: { act: "reply", key: cls.key }, ...extra });
  const menu = { key: "cats", rawIntent: "menu" };
  for (const t of ["ابي المنيو", "المنيو", "ممكن المنيو", "menu please", "ارسل المنيو لو سمحت"]) { assert.deepEqual(E(t, menu), { run: false, why: "rules:menu" }, t); assert.equal(E(t, menu, {}, { sessionActive: true }).run, false, `${t} (mid-conversation too)`); }
  assert.equal(E("وش عندكم للعشا؟", menu).run, true); assert.equal(E("ابي المنيو", menu, { menuToRules: false }).run, true);
  const W = makeWorld({}, {});
  const reply = (waBot) => R.buildReply("cats", { cfg: R.botConfig({ waBot: { mode: "live", ...waBot } }), lang: "ar", data: { settings: {}, menu: W.menu, now: new Date(), links: { [cfg0.links.organic]: true } }, referral: null, factual: false, arg: null });
  const on = reply({});
  assert.ok(on.list.rows.length >= 5); assert.equal(on.extra.length, 1); assert.equal(on.extra[0].body, "وهذا المنيو كامل بالصور والأسعار 👇"); assert.match(on.extra[0].cta.url, /^https:\/\/freshcuts\.sa\/l\//);
  assert.equal(reply({ assist: { menuToRules: false } }).extra, undefined);
});

test("row 5 — «اختار لي»: get_box marks the most ordered choice of every slot (two different ones for twin slots); a big box comes with a lighter option first; the choice question carries a list and is not asked twice", async () => {
  const a = loop({}, [use(["get_box", { slug: "box-meals-duo" }]), say("بوكس «وجبتين مشاوي لشخصين» بـ 65 ر.س. الوجبة الأولى: وجبة كفتة، وجبة صدور مشوية، ولا وجبة طرب؟"),
    say("الوجبة الأولى تبيها: وجبة كفتة، وجبة صدور مشوية، ولا وجبة طرب؟"), say("أجهّزه بوجبة نصف دجاجة على الفحم ووجبة كفتة، الأكثر طلباً عندنا. أعتمده؟")]);
  const r = await a.turn("ابي بوكس وجبتين مشاوي لشخصين");
  const slots = r.trace.tools[0].result.box.slots.filter((s) => s.type === "choice");
  assert.ok(slots.every((s) => s.most_ordered && s.most_ordered.name)); assert.notEqual(slots[0].most_ordered.product_id, slots[1].most_ordered.product_id, "twin slots: the two most ordered, not one dish twice");
  assert.equal(slots[0].most_ordered.name, "وجبة نصف دجاجة على الفحم", "the fixture's real sales order");
  assert.ok(r.list && r.list.rows.length >= 4 && r.list.rows.every((x) => /^as:c:\d+$/.test(x.id)), "the choice question carries the choices as a list");
  assert.deepEqual(Object.keys(R.assistExtras(cfg0, "ar", r)), ["list"]);
  // «جهزه»: the model repeats the question ⇒ refused; the proposal with «أعتمده؟» passes and carries no list
  const p = await a.turn("تمام جهزه");
  assert.equal(p.ok, true); assert.deepEqual(p.trace.verdicts.map((v) => v.problems.map((x) => x.type)), [["repeated_choice_question"], []]);
  assert.equal(p.text, "أجهّزه بوجبة نصف دجاجة على الفحم ووجبة كفتة، الأكثر طلباً عندنا. أعتمده؟"); assert.equal(p.list, null);
  // the family box: price + the lighter option, two buttons, no list yet
  const b = loop({}, [use(["get_box", { slug: "box-family" }]), say("بوكس العائلة بـ 179 ر.س. وإذا تبون أخف، بوكس المشاوي نص ونص بـ 125 ر.س. أي واحد أجهّزه؟")]);
  const f = await b.turn("اى البوكس العائلى");
  const box = f.trace.tools[0].result.box;
  assert.deepEqual([box.lighter_option.slug, box.lighter_option.price], ["box-grill-half-half", 125]); assert.match(box.before_the_choices, /Do NOT ask for the choices/);
  assert.deepEqual(R.assistExtras(cfg0, "ar", f).buttons, [{ id: "as:box:box-family", title: "بوكس العائلة" }, { id: "as:box:box-grill-half-half", title: "بوكس المشاوي نص ونص" }]);
  const small = loop({}, [use(["get_box", { slug: "box-crepe-duo" }]), say("تمام.")]);
  assert.equal((await small.turn("بوكس الكريب لشخصين")).trace.tools[0].result.box.lighter_option, undefined, "65 is not a big box");
  assert.equal(AR.askedSlot("أجهّزه بوجبة كفتة ووجبة طرب. أعتمده؟", r.session.state.lastBox), null);
  assert.equal(AR.askedSlot("وجبة كفتة ولا وجبة طرب؟", r.session.state.lastBox), slots[0].key);
  // a tap on one of the assistant's own buttons or rows goes back to it
  const E = (id) => AR.assistEligible({ acfg: AR.assistConfig({ mode: "test" }), cfg: cfg0, phone: PHONE, ev: { text: "وجبة كفتة", interactiveId: id }, cls: { key: "item", rawIntent: "item_info" }, d: { act: "reply", key: "item" }, sessionActive: true });
  assert.equal(E("as:c:17").run, true); assert.deepEqual(E("cat:12"), { run: false, why: "tap" });
});

test("row 4 — the pairing table: the first suggestion by family, the box price includes the customer's own choice, a box that cannot hold their dish is skipped, and a drink is not first for grills", async () => {
  const W = makeWorld({}, {});
  const line = (id, qty = 1, extra = {}) => { const it = W.menu.items.find((i) => i.id === String(id)); return { id: it.id, name: it.name, price: it.price, qty, kind: "main", ...extra }; };
  const S = (lines, over = {}) => A.suggestOne({ lines, subtotal: lines.reduce((a, l) => a + l.price * l.qty, 0), option: "pickup" }, { menu: W.menu, boxes: W.boxes, topSellers: ["79", "82"], pairing: A.PAIRING_DEFAULT, ...over });
  const one = S([line(8)]);      // كريب زنجر سوبريم
  assert.deepEqual([one.kind, one.when, one.box.slug, one.box.price], ["pair", "crepe_x1", "box-solo-crepe", 29]);
  const plus = S([line(1)]);     // كريب ميكس لحوم: +4 جوّه البوكس
  assert.deepEqual([plus.box.price, plus.box.base_price, plus.box.their_choice_extra], [33, 29, 4], "«وبـ 29 يصير بوكس» would have been wrong for this crepe");
  assert.deepEqual([S([line(8, 2)]).when, S([line(8, 2)]).box.slug], ["crepe_x2", "box-crepe-duo"]);
  const kilo = S([{ ...line(91), weight: "كيلو", price: 120 }]);
  assert.deepEqual([kilo.when, kilo.box.slug], ["grill_kilo", "box-grill-half-half"]);
  const half = S([{ ...line(91), weight: "نصف كيلو", price: 60 }]);
  assert.equal(half.kind, "side", "no rice on the online menu ⇒ the rice line is skipped; for a grill the side comes before the drink"); assert.notEqual(half.item.kind, "drink");
  assert.equal(S([line(8)], { pairing: null }).kind, "drink", "table off: the old order, drink first");
  assert.equal(S([line(8)], { declined: ["pair"] }).kind, "drink"); assert.notEqual((S([line(8), { slug: "box-solo-burger", name: "x", price: 29, qty: 1 }]) || {}).kind, "pair", "a box is already in the cart: no pairing");
  assert.deepEqual([...A.cartFamilies({ lines: [line(8), line(71)] }, W.menu)], [], "a crepe and a burger: no family, so no «switch to a box» that would not hold both");
  // in the loop the model is told it REPLACES the items
  const a = loop({}, [use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }] }]), say("كريب زنجر سوبريم بـ 25 ر.س. وبـ 29 ر.س يصير بوكس الكريب الفردي مع جانبي ومشروب. أحوّله بوكس؟")]);
  const r = await a.turn("ابي كريب زنجر سوبريم");
  assert.match(r.trace.tools[0].result.suggestion_say, /REPLACES the items/); assert.deepEqual(r.session.state.offered.map((o) => [o.kind, o.ref]), [["pair", "box-solo-crepe"]]);
});

test("row 6 — an ad chat's first reply gets the three buttons; a weight + a grill is the assistant's (a setting); the picture is a hook that sends nothing", async () => {
  const ad = { ad_text: "مشكل مخصوص", advertised: { kind: "item", id: "103", name: "مشكل مخصوص بالوزن", by_weight: true, weights: [{ label: "ثلث كيلو", price: 53, variant_option_id: 56 }, { label: "نصف كيلو", price: 78, variant_option_id: 57 }, { label: "كيلو", price: 155, variant_option_id: 58 }] } };
  const a = loop({}, [say("هلا والله 👋 مشكل مخصوص بالوزن: ثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س. أي وزن تبيه؟"), say("تمام.")]);
  const r = await a.turn("مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟", { ad });
  assert.deepEqual(R.assistExtras(cfg0, "ar", r).buttons.map((b) => [b.id, b.title]), [["as:delivery", "توصيل"], ["as:pickup", "استلام من الفرع"], ["as:other", "أبغى شي ثاني"]]);
  assert.equal((await a.turn("نص كيلو")).buttons, null, "the first reply only");
  const plain = loop({}, [say("هلا والله 👋 وش تحب تطلب اليوم؟")]);
  assert.equal((await plain.turn("مرحبا")).buttons, null, "not an ad chat: no buttons");
  assert.equal(R.adPictureFor(cfg0, ad.advertised), null);
  const A0 = AR.assistConfig({ mode: "test" }), w = { key: "weight", rawIntent: "weight_order" };
  const E = (acfg) => AR.assistEligible({ acfg: { ...A0, ...acfg }, cfg: cfg0, phone: PHONE, ev: { text: "نص كيلو كفته" }, cls: w, d: { act: "reply", key: "weight" } });
  assert.equal(E({}).run, true); assert.deepEqual(E({ weightToAssistant: false }), { run: false, why: "rules:weight" });
});

test("row 10 — a short question gets the part of the approved answer it asked about, word for word", async () => {
  const meat = "نشوي على فحم طبيعي ونحضّر كل طلب بعد استلامه.\nالكفتة والطرب: لحم غنم مع لحم بقري برازيلي مبرّد.\nالبرجر والحواوشي والسجق: لحم بقري برازيلي مبرّد مع لحم بلدي بقري وغنم.\nالريش والكباب: لحم غنم أسترالي. والدجاج مبرّد.\nوكل لحومنا ودجاجنا حلال.";
  assert.equal(AR.faqPart(meat, "الدجاج"), "الدجاج مبرّد.\nكل لحومنا ودجاجنا حلال.");
  assert.equal(AR.faqPart(meat, "فراخ"), "الدجاج مبرّد.\nكل لحومنا ودجاجنا حلال.");
  assert.match(AR.faqPart(meat, "البرجر"), /^البرجر والحواوشي والسجق/);
  assert.equal(AR.faqPart(meat, "سمك"), null, "nothing about it: the whole answer"); assert.equal(AR.faqPart("سطر واحد عن الدجاج.", "دجاج"), null); assert.equal(AR.faqPart(meat, ""), null);
  const a = loop({ faq: { meat: { ar: meat } } }, [use(["faq", { topic: "meat", about: "دجاج" }]), say("الدجاج مبرّد.\nكل لحومنا ودجاجنا حلال.\nتبي شيش طاووق ولا نصف دجاجة على الفحم؟")]);
  const r = await a.turn("نوع الدجاج ايه");
  assert.equal(r.trace.tools[0].result.say, "الدجاج مبرّد.\nكل لحومنا ودجاجنا حلال."); assert.match(r.trace.tools[0].result.rule, /leads back to their order/);
  const off = loop({ faq: { meat: { ar: meat } } }, [use(["faq", { topic: "meat", about: "دجاج" }]), say(meat)], { faqShort: false });
  assert.equal((await off.turn("نوع الدجاج ايه")).trace.tools[0].result.say, meat);
});

test("the model's notes to itself in Arabic are refused (seen in the eval: «وعليكم... لا، الرسالة ما فيها تحية. نبدأ: …»)", () => {
  const C = (t) => AR.checkReply(t, { facts: [], lang: "ar" }).problems.map((p) => p.type);
  assert.ok(C("وعليكم... لا، الرسالة ما فيها تحية. نبدأ: معك ماجد، المساعد الرقمي لفريش كاتس.").includes("self_talk"));
  assert.ok(C("الرد: أبشر، وش تحب تطلب؟").includes("self_talk"));
  assert.deepEqual(C("أبشر، نبدأ بالطلب. وش تحب؟"), []); assert.deepEqual(C("لا، ما عندي معلومة مؤكدة عن هذا."), []);
});
