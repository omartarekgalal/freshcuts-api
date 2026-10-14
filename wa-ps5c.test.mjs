/* PS5 (part 4) — أول سلة حقيقية بناها ماجد (…٦٨٦٩، ٩٤ ر.س) كانت غلط: العميل بعت صور «طرب مشوي بالوزن» و«شيش طاووق مشوي بالوزن» و«فرايد موتزاريلا» و«تشيلي تشيز فرايز» و«بيبسي زجاج»،
   والمحادثة كانت مكتومة فالصور مااتشافتش، والسلة اتبنت من الكلام: «شيش طاووق مشوي على الفحم» ⇒ وجبة شيش طاووق، «وضيف طرب» ⇒ وجبة طرب، «ثلاثه ببسي» ⇒ ٣ مشروبات غازية بملاحظة «ببسي».
   كل اختبار هنا من السطور دي بالحرف. من غير أي نداء موديل ولا شبكة.      node --test wa-ps5c.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import { LOOK_SYSTEM } from "./waassistmedia.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } });
const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (...u) => ({ ok: true, content: u.map(([name, input], i) => ({ type: "tool_use", id: `u${i}${name}`, name, input })), stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
function chat(steps, acfg = {}) { let i = 0; const W = makeWorld({}, { callModel: async () => steps[i++], onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg: { pairingEnabled: false, forceSuggestion: false, feeMoment: false, ...acfg } });
  let session = null; const turn = async (text, extra = {}) => { const hours = await W.tools.get_hours(); const fresh = !session; if (fresh) session = AR.newSession(W.now());
    const r = await W.loop.runTurn({ phone: PHONE, text, lang: "ar", session, acfg: { ...W.acfg, routing: "strong", salesBrain: false }, context: AR.buildContext({ first: fresh, hours, boxes: W.boxes }), ...extra }); if (r.ok) session = r.session; return r; };
  return { W, turn }; }
const ASK = "تبيها وجبة مع الأرز والسلطة والطحينة بـ 27 ر.س، ولا بالوزن (ثلث كيلو: 37 ر.س · نصف كيلو: 55 ر.س · كيلو: 110 ر.س)؟";

test("(1) meal or by weight is never decided for the customer: «شيش طاووق مشوي على الفحم» and «وضيف طرب» cannot be priced as meals until he says which", async () => {
  const a = chat([use(["preview_cart", { option: "delivery", items: [{ id: "90", qty: 1 }] }]), say(ASK),
    use(["preview_cart", { option: "delivery", items: [{ id: "90", qty: 1 }] }]), say(ASK),
    use(["preview_cart", { option: "delivery", items: [{ id: "114", qty: 1, variant_option_id: 0 }] }]), say("أي وزن تبيه: ثلث كيلو بـ 37 ر.س، نصف كيلو بـ 55 ر.س، ولا كيلو بـ 110 ر.س؟"),
    use(["preview_cart", { option: "delivery", items: [{ id: "16", qty: 1 }] }]), say("والطرب: وجبة مع الأرز والسلطة والطحينة بـ 27 ر.س، ولا بالوزن (ثلث كيلو: 47 ر.س · نصف كيلو: 70 ر.س · كيلو: 140 ر.س)؟")]);
  const t1 = await a.turn("شيش طاووق مشوي على الفحم");
  const g = t1.trace.tools[0].result;
  assert.deepEqual([g.ok, g.error, g.ask_which.meal.id, g.ask_which.by_weight.id, g.ask_which.by_weight.weights.map((w) => w.price)], [false, "ask_meal_or_weight", "90", "114", [37, 55, 110]]);
  assert.match(g.rule, /Never choose for them/); assert.deepEqual(t1.buttons, { kind: "family", meal: { id: "90" }, weight: { id: "114" } }); assert.equal(t1.text, ASK);
  // he answers «بالوزن»: the meal is now the WRONG item — refused again; the by-weight dish goes through (and then needs its weight)
  const t2 = await a.turn("بالوزن");
  assert.deepEqual([t2.trace.tools[0].result.error, t2.trace.tools[0].result.use.id], ["meal_or_weight_mismatch", "114"], "he said by weight: the meal cannot be put in the cart, and the tool names the right dish");
  const t3 = await a.turn("بالوزن");
  assert.notEqual(t3.trace.tools[0].result.error, "ask_meal_or_weight");
  // «وضيف طرب»: what he said about the shish does not decide the tarb
  const t4 = await a.turn("وضيف طرب");
  assert.deepEqual([t4.trace.tools[0].result.error, t4.trace.tools[0].result.ask_which.by_weight.weights.map((w) => w.price)], ["ask_meal_or_weight", [47, 70, 140]]);
  // said in the same message: no question
  const b = chat([use(["preview_cart", { option: "delivery", items: [{ id: "16", qty: 1 }] }]), say("وجبة طرب بـ 27 ر.س. شي ثاني؟")]);
  assert.equal((await b.turn("ابي وجبة طرب")).trace.tools[0].result.ok, true);
  const off = chat([use(["preview_cart", { option: "delivery", items: [{ id: "90", qty: 1 }] }]), say("وجبة شيش طاووق بـ 27 ر.س.")], { grillFamilies: false });
  assert.equal((await off.turn("شيش طاووق مشوي على الفحم")).trace.tools[0].result.ok, true, "the setting off: as before");
});

test("(2) pictures the customer sent earlier are part of the turn: a storefront sheet of «طرب مشوي بالوزن» decides the item, and a meal built against it is refused", async () => {
  const pics = "صورة 1: صفحة صنف «طرب مشوي بالوزن» من قسم مشاوي بالوزن، الأوزان: ثلث كيلو 47، نصف كيلو 70، كيلو 140\nصورة 2: صفحة صنف «شيش طاووق مشوي بالوزن»، الأوزان: ثلث كيلو 37، نصف كيلو 55، كيلو 110\nصورة 3: صفحة صنف «بيبسي زجاج» بسعر 4";
  const a = chat([use(["preview_cart", { option: "delivery", items: [{ id: "16", qty: 1 }] }]), say("الطرب تبيه أي وزن: ثلث كيلو بـ 47 ر.س، نصف كيلو بـ 70 ر.س، ولا كيلو بـ 140 ر.س؟")]);
  const t = await a.turn("وضيف طرب", { earlierPictures: pics });
  assert.deepEqual([t.trace.tools[0].result.error, t.trace.tools[0].result.use.name], ["meal_or_weight_mismatch", "طرب مشوي بالوزن"], "the picture says by weight: «وجبة طرب» is not what he meant");
  const ctx = JSON.parse(/<context[^>]*>([\s\S]*?)<\/context>/.exec(t.session.messages[0].content[0].text)[1]);
  assert.match(ctx.pictures_the_customer_sent_earlier.seen, /طرب مشوي بالوزن/); assert.match(ctx.pictures_the_customer_sent_earlier.rule, /before you price or build anything/);
  const b = chat([use(["search_menu", { query: "طرب" }], ["preview_cart", { option: "delivery", items: [{ id: "94", qty: 1, variant_option_id: 0 }] }]), say("الطرب أي وزن: ثلث كيلو بـ 47 ر.س، نصف كيلو بـ 70 ر.س، ولا كيلو بـ 140 ر.س؟")]);
  const t2 = await b.turn("وضيف طرب", { earlierPictures: pics });
  assert.equal(t2.trace.tools[0].result.ask_which, undefined, "the picture already said which: no meal-or-weight question"); assert.notEqual(t2.trace.tools[1].result.error, "ask_meal_or_weight");
  assert.match(AR.CTX_RULES.picture, /wins over a loose match on their words/); assert.match(AR.CTX_RULES.picture, /ask which one/);
  assert.match(LOOK_SYSTEM, /the size or weight that is selected or highlighted/);
});

test("(3) «ثلاثه ببسي» is «بيبسي زجاج» × 3 — a generic drink with «ببسي» in a note is refused", async () => {
  const W = makeWorld({}, {});
  for (const q of ["ببسي", "ثلاثه ببسي", "بيبسي", "pepsi"]) assert.equal((await W.tools.search_menu(PHONE, { query: q })).results[0].name, "بيبسي زجاج", q);
  const wrong = await W.tools.build_cart(PHONE, { option: "delivery", items: [{ id: "82", qty: 3, note: "ببسي" }] }, { save: false });
  assert.deepEqual([wrong.ok, wrong.error, wrong.problems[0].error, wrong.problems[0].product.name, wrong.problems[0].product.price], [false, "empty_cart", "note_names_a_product", "بيبسي زجاج", 4]);
  const right = await W.tools.build_cart(PHONE, { option: "delivery", items: [{ id: "86", qty: 3 }] }, { save: false });
  assert.deepEqual([right.lines[0].name, right.lines[0].qty, right.subtotal], ["بيبسي زجاج", 3, 12]);
  // real kitchen notes are still notes
  for (const note of ["بدون مويه", "صوص سبايسي", "اكسترا سبايسي", "طحينة علبتين كبار فقط", "جزء مقمر وجزء مستوي عادي"]) { const c = await W.tools.build_cart(PHONE, { option: "delivery", items: [{ id: "76", qty: 1, note }] }, { save: false }); assert.deepEqual([c.ok, c.lines[0].note], [true, note], note); }
  assert.match(AR.SYSTEM_PROMPT, /A note never replaces a product/);
});

test("(4) the recap before the cart link names every line as on the menu, with its weight and its kitchen note — built by code when the model's own summary leaves something out", async () => {
  const W0 = makeWorld({}, {}), tarb = W0.menu.items.find((i) => i.id === "94"), half = tarb.weights.find((w) => /نصف/.test(w.label_ar));
  const items = [{ id: "94", qty: 1, variant_option_id: half.variant_option_id, note: "جزء مقمر وجزء مستوي عادي" }, { id: "74", qty: 1 }, { id: "76", qty: 1, note: "اكسترا سبايسي" }, { id: "86", qty: 3 }];
  const a = chat([use(["build_cart", { option: "delivery", items }]), say("سلتك جاهزة: طرب، موتزاريلا، تشيلي فرايز وبيبسي = 113 ر.س 👇")]);
  const t = await a.turn("طرب بالوزن نص كيلو جزء مقمر وجزء مستوي عادي، وفرايد موتزاريلا، وتشيلي تشيز فرايز اكسترا سبايسي، وثلاثه ببسي، توصيل");
  assert.equal(t.trace.cartRecapRestored, true);
  assert.equal(t.text, "🛒 سلتك (توصيل):\n• طرب مشوي بالوزن — نصف كيلو × 1 = 70 ر.س\n↳ ملاحظة للمطبخ: جزء مقمر وجزء مستوي عادي\n• فرايد موتزاريلا × 1 = 16 ر.س\n• تشيلي تشيز فرايز × 1 = 15 ر.س\n↳ ملاحظة للمطبخ: اكسترا سبايسي\n• بيبسي زجاج × 3 = 12 ر.س\nالمجموع: 113 ر.س\nراجع السلة، ولو كل شي تمام اضغط الزر وأكمل الدفع 👇");
  assert.equal(t.cart.subtotal, 113);
  // a summary that already names every line, weight and note is left alone
  const full = "سلتك: طرب مشوي بالوزن نصف كيلو (جزء مقمر وجزء مستوي عادي) 70 ر.س، فرايد موتزاريلا 16 ر.س، تشيلي تشيز فرايز (اكسترا سبايسي) 15 ر.س، بيبسي زجاج × 3 = 12 ر.س. المجموع 113 ر.س 👇";
  const b = chat([use(["build_cart", { option: "delivery", items }]), say(full)]);
  const t2 = await b.turn("طرب بالوزن نص كيلو جزء مقمر وجزء مستوي عادي، وفرايد موتزاريلا، وتشيلي تشيز فرايز اكسترا سبايسي، وثلاثه ببسي، توصيل");
  assert.equal(t2.text, full); assert.equal(t2.trace.cartRecapRestored, undefined);
});

test("(5) the kitchen notes survive a corrected cart: a note given on the tarb meal must be on the tarb that replaces it", async () => {
  const W0 = makeWorld({}, {}), half = W0.menu.items.find((i) => i.id === "94").weights.find((w) => /نصف/.test(w.label_ar));
  const a = chat([use(["preview_cart", { option: "delivery", items: [{ id: "16", qty: 1, note: "جزء مقمر وجزء مستوي عادي" }, { id: "76", qty: 1, note: "اكسترا سبايسي" }] }]), say("تمام، أضفت وجبة طرب ✅ المجموع 42 ر.س. شي ثاني؟"),
    use(["build_cart", { option: "delivery", items: [{ id: "94", qty: 1, variant_option_id: half.variant_option_id }, { id: "76", qty: 1 }] }]), say("لحظة، أضيف الملاحظات."),
    use(["build_cart", { option: "delivery", items: [{ id: "94", qty: 1, variant_option_id: half.variant_option_id, note: "جزء مقمر وجزء مستوي عادي" }, { id: "76", qty: 1, note: "اكسترا سبايسي" }] }]), say("تم.")]);
  await a.turn("ابي وجبة طرب جزء مقمر وجزء مستوي عادي وتشيلي تشيز فرايز اكسترا سبايسي");
  const fix = await a.turn("لا الطرب بالوزن نص كيلو مو وجبة، ارسل السلة");
  const g = fix.trace.tools[0].result;
  assert.deepEqual([g.ok, g.error, g.missing], [false, "kitchen_notes_missing", ["جزء مقمر وجزء مستوي عادي", "اكسترا سبايسي"]]); assert.equal(fix.cart, null);
  const done = await a.turn("ايوه نفس الملاحظات");
  assert.equal(done.cart.subtotal, 85); assert.deepEqual(done.cart.lines.map((l) => l.note), ["جزء مقمر وجزء مستوي عادي", "اكسترا سبايسي"]);
  assert.match(done.text, /طرب مشوي بالوزن — نصف كيلو/); assert.match(done.text, /↳ ملاحظة للمطبخ: جزء مقمر وجزء مستوي عادي/);
  assert.equal(R.cartRecapOf(cfg, { option: "pickup", lines: [{ name: "بيبسي زجاج", qty: 2, total: 8 }], subtotal: 8 }, "ar").split("\n")[0], "🛒 سلتك (استلام من الفرع):");
});

test("a grill the customer names in his message must be in the cart: «والطرب ابغا وجبة، جزء منه مقمر…» priced without the tarb is refused (the note had gone to the shish)", async () => {
  const a = chat([use(["preview_cart", { option: "pickup", items: [{ id: "90", qty: 1 }] }]), say("وجبة شيش طاووق بـ 27 ر.س. شي ثاني؟"),
    use(["preview_cart", { option: "pickup", items: [{ id: "90", qty: 1, note: "جزء مقمر وجزء مستوي عادي" }] }]),
    use(["preview_cart", { option: "pickup", items: [{ id: "90", qty: 1 }, { id: "16", qty: 1, note: "جزء مقمر وجزء مستوي عادي" }] }]), say("تمام، أضفت وجبة طرب ✅ وكتبت للمطبخ: جزء مقمر وجزء مستوي عادي. المجموع 54 ر.س. شي ثاني؟")]);
  await a.turn("ابي وجبة شيش طاووق");
  const t = await a.turn("والطرب ابغا وجبة، جزء منه مقمر وجزء مستوي عادي");
  assert.deepEqual([t.trace.tools[0].result.error, t.trace.tools[0].result.named_in_this_message], ["named_dish_missing", ["وجبة طرب", "طرب مشوي بالوزن"]]);
  assert.equal(t.trace.tools[1].result.ok, true); assert.deepEqual(t.trace.tools[1].result.lines.map((l) => [l.name, l.note || null]), [["وجبة شيش طاووق", null], ["وجبة طرب", "جزء مقمر وجزء مستوي عادي"]]);
  assert.equal(t.trace.tools[1].result.subtotal, 54);
  const b = chat([use(["preview_cart", { option: "pickup", items: [{ id: "90", qty: 1 }] }]), say("وجبة شيش طاووق بـ 27 ر.س، بدون طرب. شي ثاني؟")]);
  assert.equal((await b.turn("ابي وجبة شيش طاووق بدون طرب")).trace.tools[0].result.ok, true, "«بدون طرب» is not an order for tarb");
});

test("the recap in English never carries Arabic names: a correct English summary of a box is left alone, and plain dishes use their English names", async () => {
  const cart = { option: "pickup", subtotal: 29, lines: [{ name: "كريب زنجر سوبريم", name_en: "Zinger Supreme Crepe", qty: 1, total: 25 }, { name: "بيبسي زجاج", name_en: "Pepsi Glass", qty: 1, total: 4, note: "cold" }] };
  const en = R.cartRecapOf(cfg, cart, "en");
  assert.equal(en, "🛒 Your cart (Pickup):\n• Zinger Supreme Crepe × 1 = SAR 25\n• Pepsi Glass × 1 = SAR 4\n↳ Kitchen note: cold\nTotal: SAR 29\nCheck the cart, and if it is all right tap the button to pay 👇");
  assert.doesNotMatch(R.cartRecapOf(cfg, { option: "pickup", subtotal: 90, lines: [{ name: "بوكس سهرة البيتزا", name_en: "Pizza Night Box", qty: 1, total: 90, picks: [{ name: "بيتزا تشيكن رانش", note: "no olives" }, { name: "بيتزا بيبروني" }] }] }, "en"), /[\u0600-\u06FF]/);
});
