/* SB1 — «عقل البيع» لماجد (١٤/١٠). عمر: «ليه العروض مش بتتعرض… ليه مش بيقولهم ان اول توصيل مجاني… ليه لو طلب قبل كذا مش بيشجعه ببرنامج الولاء… ليه الردود مش تفاعلية… ليه التنسيق مش أفضل حاجة».
   محادثات ١٣/١٠ الحقيقية (٢٧ محادثة، صفر سلة) هي مصدر السطور. من غير أي نداء موديل ولا شبكة.      node --test wa-sb1.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import * as S from "./wasales.js";
import { LIMITS } from "./wabot.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } });
const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (...u) => ({ ok: true, content: u.map(([name, input], i) => ({ type: "tool_use", id: `u${i}${name}`, name, input })), stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
function chat(steps, { world = {}, acfg = {} } = {}) {
  let i = 0; const W = makeWorld(world, { callModel: async () => steps[i++] || say("تمام."), onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg: { forceSuggestion: false, ...acfg } });
  let session = null, first = true;
  const turn = async (text, extra = {}) => { const hours = await W.tools.get_hours(); const fresh = !session; if (fresh) session = AR.newSession(W.now());
    let profile = null, offers = null; if (first) { const p = await W.tools.customer_profile(PHONE); profile = p.profile; offers = await W.tools.get_offers(PHONE); first = false; }
    const r = await W.loop.runTurn({ phone: PHONE, text, lang: "ar", session, acfg: { ...W.acfg, routing: "strong" }, context: AR.buildContext({ first: fresh, hours, boxes: W.boxes, profile, offers, reorder: fresh && world.reorder ? W.reorder : null, ...(extra.ctx || {}) }), profile });
    if (r.ok) session = r.session; return r; };
  return { W, turn, get session() { return session; } };
}
const ctxOf = (r, k = 0) => JSON.parse(/<context[^>]*>([\s\S]*?)<\/context>/.exec(r.session.messages.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "text" && /^<customer_message>/.test(b.text || "")))[k].content[0].text)[1]);

test("(1) the customer card: first-timer, returning with 2 of 3, holder of a reward, regular with a ready cart", async () => {
  const W = makeWorld({ profile: "new" }, {});
  const pNew = (await W.tools.customer_profile(PHONE)).profile, oNew = await W.tools.get_offers(PHONE);
  const c1 = S.salesCard({ profile: pNew, offers: oNew });
  assert.deepEqual([c1.segment, c1.first.eligible, c1.first.from, c1.first.code, c1.loyalty.left], ["first_timer", true, 60, "FIRST", 3]);
  const W2 = makeWorld({ profile: "returning", loyaltyN: 2, rewards: [] }, {});
  const c2 = S.salesCard({ profile: (await W2.tools.customer_profile(PHONE)).profile, offers: await W2.tools.get_offers(PHONE) });
  assert.deepEqual([c2.segment, c2.first.eligible, c2.loyalty.progress, c2.loyalty.left, c2.reward], ["returning", false, 2, 1, null]);
  const W3 = makeWorld({ profile: "returning", loyaltyN: 3, rewards: [{ code: "LOY-7K2M", expires: "2026-10-18" }] }, {});
  const c3 = S.salesCard({ profile: (await W3.tools.customer_profile(PHONE)).profile, offers: await W3.tools.get_offers(PHONE), reorder: W3.reorder });
  assert.deepEqual([c3.reward.code, c3.reward.expires, c3.segment], ["LOY-7K2M", "2026-10-18", "returning"], "no reorder plan ⇒ not «regular»");
  const c4 = S.salesCard({ profile: (await W3.tools.customer_profile(PHONE)).profile, offers: await W3.tools.get_offers(PHONE), reorder: { lines: [{ name: "وجبة كفتة", qty: 2 }], day: "الثلاثاء" } });
  assert.equal(c4.segment, "regular"); assert.deepEqual(c4.same_order.lines, [{ name: "وجبة كفتة", qty: 2 }]);
  const m = S.cardForModel(c1); assert.deepEqual(m.first_order_free_delivery, { from: 60, code: "FIRST" }); assert.equal(JSON.stringify(m).includes("05"), false, "no phone in the model card");
});

test("(2) the proactive line is said ONCE, at its moment — never as a reply to «وش عرض أول طلب؟» (the model answers that from get_offers)", () => {
  const card = { segment: "first_timer", orders: 0, first: { eligible: true, from: 60, code: "FIRST" }, loyalty: { every: 3, progress: 0, left: 3, reward: "free_delivery", min_total: 60 }, reward: null, same_order: null };
  assert.equal(S.proactiveLine(card, {}, { greeting: true }), null, "a bare greeting: nothing yet");
  assert.equal(S.proactiveLine(card, {}, S.topicsOf("وش عرض أول طلب؟")), null, "the 13/10 ad question: the model answers it, the code does not repeat it");
  const d = S.proactiveLine(card, {}, S.topicsOf("توصلون حيّنا؟ وكم التوصيل؟"));
  assert.deepEqual([d.kind, d.key, d.vars.from], ["first", "sb_first", 60]);
  assert.equal(S.proactiveLine(card, { proactive: "first" }, S.topicsOf("كيف أطلب من الموقع؟")), null, "once per conversation");
  assert.equal(S.proactiveLine(card, {}, S.topicsOf("كيف أطلب من الموقع؟")).kind, "first", "«كيف أطلب» is an ordering moment");
  const ret = { ...card, segment: "returning", orders: 4, first: { eligible: false }, loyalty: { every: 3, progress: 2, left: 1, reward: "free_delivery", min_total: 60 } };
  assert.equal(S.proactiveLine(ret, {}, { preview: true }).kind, "loyalty_one");
  assert.equal(R.salesTextOf(cfg, "sb_loyalty_one", { from: 60 }, "ar"), "⭐ باقي لك طلب واحد من الموقع وتاخذ توصيل مجاني على طلبك اللي بعده (للطلبات من 60 ر.س).");
  const rw = { ...ret, reward: { code: "LOY-7K2M", free_delivery: true, min_total: 60, expires: "2026-10-18" } };
  const r = S.proactiveLine(rw, {}, { order: true });
  assert.equal(R.salesTextOf(cfg, r.key, r.vars, "ar"), "🎁 عندك مكافأة توصيل مجاني بكود LOY-7K2M للطلبات من 60 ر.س، صالحة لين 18/10. اكتبه في خانة الكود وقت الدفع.");
  const reg = { ...ret, segment: "regular", same_order: { lines: [{ name: "كريب زنجر سوبريم", qty: 2 }, { name: "وجبة كفتة", qty: 1 }] } };
  const s = S.proactiveLine(reg, {}, { opening: true, named: false });
  assert.deepEqual([s.kind, s.question, R.salesTextOf(cfg, s.key, s.vars, "ar")], ["same", true, "آخر طلب لك كان 2 × كريب زنجر سوبريم + وجبة كفتة. تبيه نفسه؟"]);
  assert.equal(S.proactiveLine(reg, {}, { opening: true, named: true }), null, "he already named a dish: no «same as last time?»");
  assert.equal(S.placeLine("نعم نوصل داخل جدة 👍\nشاركني موقعك هنا؟", "🎁 سطر"), "نعم نوصل داخل جدة 👍\n🎁 سطر\nشاركني موقعك هنا؟", "an information line goes before the closing question");
  assert.equal(S.placeLine("هلا والله أحمد 👋 وش تحب تطلب اليوم؟", "آخر طلب لك كان X. تبيه نفسه؟", { question: true }), "هلا والله أحمد 👋\nآخر طلب لك كان X. تبيه نفسه؟", "a question line replaces the closing question: one question per message");
});

test("(3) the next fee step with ONE concrete item that closes it — exact gap, real totals, FIRST for a first-timer", () => {
  const ladder = [{ over: 0, fee: 20 }, { over: 60, fee: 15 }, { over: 80, fee: 10 }, { over: 100, fee: 5 }, { over: 150, fee: 0 }];
  const cand = [{ id: "123", name: "طبق أرز بسمتي", price: 6 }, { id: "70", name: "مياه", price: 1 }, { id: "75", name: "دوريتوس", price: 5 }, { id: "80", name: "تشيز فرايز", price: 10 }];
  const a = S.thresholdPlan({ cart: { subtotal: 54, option: "delivery" }, ladder, first: { eligible: true, from: 60, code: "FIRST" }, candidates: cand });
  assert.deepEqual([a.add_sar, a.item.name, a.fee_now, a.fee_then, a.with_code, a.total_now, a.total_then], [6, "طبق أرز بسمتي", 20, 0, "FIRST", 74, 60]);
  assert.equal(R.salesTextOf(cfg, "sb_tier_first", { item: a.item.name, price: a.item.price, from: a.order_from, code: a.with_code, total_then: a.total_then, total_now: a.total_now }, "ar"),
    "لو أضفت طبق أرز بسمتي بـ 6 ر.س، يوصل طلبك 60 ر.س ويصير توصيله مجاني بكود FIRST: الإجمالي 60 ر.س بدل 74 ر.س. أضيفه؟");
  const b = S.thresholdPlan({ cart: { subtotal: 145, option: "delivery" }, ladder, candidates: cand });
  assert.deepEqual([b.add_sar, b.item.name, b.fee_then, b.free, b.total_then], [5, "طبق أرز بسمتي", 0, true, 151], "the playbook's own example: 145 + 5 ⇒ free from 150 (the first candidate that covers the gap)");
  assert.equal(S.thresholdPlan({ cart: { subtotal: 54, option: "pickup" }, ladder, candidates: cand }), null, "pickup has no fee");
  assert.equal(S.thresholdPlan({ cart: { subtotal: 30, option: "delivery" }, ladder, candidates: cand, maxGap: 20 }), null, "gap over the setting: no push");
  assert.equal(S.thresholdPlan({ cart: { subtotal: 62, option: "delivery" }, ladder, first: { eligible: true, from: 60, code: "FIRST" }, candidates: cand }), null, "already free with the first-order code");
  assert.equal(S.thresholdPlan({ cart: { subtotal: 75, option: "delivery" }, ladder, candidates: cand, inCart: new Set(["123", "75"]) }).item.name, "تشيز فرايز", "an item already in the cart is skipped");
  const far = S.thresholdPlan({ cart: { subtotal: 75, option: "delivery" }, ladder, quote: { ok: true, deliverable: true, fee: 24, far_zone_extra: 9 }, candidates: cand });
  assert.deepEqual([far.fee_now, far.fee_then, far.located], [24, 19, true], "a far-zone pin pays the extra on both sides");
});

test("(4) a first-timer asks «توصلون حيّنا؟ وكم التوصيل؟» (13/10, twice): the first-order line is added once, before the closing question; never again", async () => {
  const c = chat([say("نعم نوصل داخل جدة 👍 شاركني موقعك هنا في واتساب (📎 ثم «الموقع») عشان أتأكد من التغطية والرسوم؟"), say("تمام. وش تحب تطلب؟")], { world: { profile: "new" } });
  const r = await c.turn("توصلون حيّنا؟ وكم التوصيل؟");
  assert.match(r.text, /🎁 أول طلب توصيل لك من موقعنا مجاني للطلبات من 60 ر.س بكود FIRST\.\n.*؟$/s);
  assert.equal(r.trace.proactive, "first");
  const r2 = await c.turn("ابي اطلب");
  assert.doesNotMatch(r2.text, /FIRST/, "said once");
  const off = chat([say("نعم نوصل داخل جدة 👍 شاركني موقعك؟")], { world: { profile: "new" }, acfg: { salesBrain: false } });
  assert.doesNotMatch((await off.turn("توصلون حيّنا؟")).text, /FIRST/, "switch off: as before");
  const asked = chat([say("عرض أول طلب: توصيل مجاني بكود FIRST للطلبات من 60 ر.س. وش تحب تطلب؟")], { world: { profile: "new" } });
  const ra = await asked.turn("وش عرض أول طلب؟");
  assert.equal((ra.text.match(/FIRST/g) || []).length, 1, "the model already said it: not twice");
});

test("(5) returning customer with 2 of 3: the loyalty line comes with his order; a reward holder hears how to use the code", async () => {
  const c = chat([use(["preview_cart", { option: "delivery", items: [{ id: "8", qty: 1 }] }]), say("كريب زنجر سوبريم بـ 25 ر.س. شي ثاني؟")], { world: { profile: "returning", loyaltyN: 2 }, acfg: { maxOffersPerChat: 0 } });
  const r = await c.turn("ابي كريب زنجر سوبريم");
  assert.match(r.text, /⭐ باقي لك طلب واحد من الموقع وتاخذ توصيل مجاني على طلبك اللي بعده \(للطلبات من 60 ر.س\)\.\n.*شي ثاني؟$/s);
  const c2 = chat([say("أبشر. وش تحب تطلب اليوم؟")], { world: { profile: "returning", loyaltyN: 3, rewards: [{ code: "LOY-7K2M", expires: "2026-10-18" }] } });
  const r2 = await c2.turn("ابي اطلب توصيل");
  assert.match(r2.text, /بكود LOY-7K2M للطلبات من 60 ر.س، صالحة لين 18\/10/);
});

test("(6) the regular customer: «نفس طلبك؟» with a one-tap ready-cart button, in place of the generic closing question", async () => {
  const c = chat([say("هلا والله أحمد 👋 وش تحب تطلب اليوم؟")], { world: { profile: "returning", reorder: true, loyaltyN: 4 } });
  const r = await c.turn("هلا");
  assert.equal(r.text.split("\n").pop(), "آخر طلب لك كان 2 × *كريب زنجر سوبريم* + *وجبة كفتة*. تبيه نفسه؟");
  assert.equal(r.text.split("\n")[0], "هلا والله أحمد 👋", "the generic closing question gave way to it");
  assert.equal((r.text.match(/[؟?]/g) || []).length, 1);
  assert.deepEqual(r.buttons, { kind: "same" });
  const ex = R.assistExtras(cfg, "ar", r);
  assert.deepEqual(ex.buttons.map((b) => b.id), ["re:last", "as:other"], "the existing reorder button: a ready cart from his last order");
});

test("(7) basket builder: a by-weight grill gets rice (now orderable, 6 SAR) with «أضفه ✅ / لا شكراً»; «لا شكراً» = no more suggestions; at most 2 per chat", async () => {
  const c = chat([use(["preview_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 45 }] }]), say("كفتة مشوية بالوزن، نصف كيلو بـ 60 ر.س."),
    use(["preview_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 45 }, { id: "8", qty: 1 }] }]), say("أضفت كريب زنجر سوبريم. المجموع 85 ر.س. شي ثاني؟")], { world: { profile: "new" } });
  const r = await c.turn("نص كيلو كفتة بالوزن");
  const sg = r.trace.tools[0].result.suggestion;
  assert.deepEqual([sg.kind, sg.item.name, sg.item.price], ["pair", "طبق أرز بسمتي", 6]);
  assert.match(r.text, /تحب أضيف لك \*طبق أرز بسمتي\* بـ 6 ر.س؟$/, "the model left it out: the code line is added (and the name in bold)");
  assert.equal(r.trace.sgLineByCode, true);
  assert.deepEqual(r.buttons, { kind: "sg" });
  assert.deepEqual(R.assistExtras(cfg, "ar", r).buttons.map((b) => b.title), ["أضفه ✅", "لا شكراً"]);
  const r2 = await c.turn("لا شكراً");
  assert.equal(ctxOf(r2, 1).suggestion_answer.declined, "طبق أرز بسمتي");
  assert.equal(r2.trace.tools[0].result.suggestion, null, "after «لا شكراً»: no suggestion for the rest of the chat");
  assert.equal(r2.session.state.declined.includes("pair"), true);
});

test("(8) accept by tap: «أضفه ✅» is recorded by code and the model is told to add exactly that", async () => {
  const c = chat([use(["preview_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 45 }] }]), say("كفتة مشوية بالوزن، نصف كيلو بـ 60 ر.س. تحب أضيف لك طبق أرز بسمتي بـ 6 ر.س؟"), say("تمام، أضفته.")], { world: { profile: "new" } });
  await c.turn("نص كيلو كفتة بالوزن");
  const r = await c.turn("أضفه ✅");
  assert.equal(ctxOf(r, 1).suggestion_answer.accepted, "طبق أرز بسمتي");
  assert.ok(r.trace.suggestions.some((s) => s.outcome === "accepted" && s.by === "reply"));
});

test("(9) the threshold beats a weak add-on: 50 SAR delivery basket of a first-timer ⇒ one item that makes it 60 and free delivery with FIRST", async () => {
  const c = chat([use(["preview_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 44 }, { id: "79", qty: 1 }, { id: "86", qty: 1 }] }]), say("كفتة مشوية بالوزن ثلث كيلو 40 ر.س، بطاطس محمرة 6 ر.س، بيبسي زجاج 4 ر.س: المجموع 50 ر.س.")], { world: { profile: "new" } });
  const r = await c.turn("ثلث كيلو كفتة وبطاطس وبيبسي، توصيل");
  const sg = r.trace.tools[0].result.suggestion;
  assert.deepEqual([sg.kind, sg.add_sar, sg.item.price, sg.fee_now, sg.fee_then, sg.with_code, sg.total_then, sg.total_now], ["next_tier", 10, 10, 20, 0, "FIRST", 60, 70]);
  assert.match(r.text, /لو أضفت \*.+\* بـ 10 ر.س، يوصل طلبك 60 ر.س ويصير توصيله مجاني بكود FIRST: الإجمالي 60 ر.س بدل 70 ر.س\. أضيفه؟$/);
  /* eval sb1-a: the model said the line itself beside «ثلث كيلو كفتة 40» and the by-weight check read «60 ر.س» as the kofta's half-kilo price ⇒ the turn fell to the rules bot. The code line is exempt now. */
  const line = sg && R.salesTextOf(cfg, "sb_tier_first", { item: sg.item.name, price: 10, from: 60, code: "FIRST", total_then: 60, total_now: 70 }, "ar");
  const c2 = chat([use(["preview_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 44 }, { id: "79", qty: 1 }, { id: "86", qty: 1 }] }]), say(`أبشر، ثلث كيلو كفتة مشوية بالوزن 40 ر.س، وبطاطس محمرة 6 ر.س، وبيبسي زجاج 4 ر.س. المجموع 50 ر.س.
${line}`)], { world: { profile: "new" } });
  const r2 = await c2.turn("ابي ثلث كيلو كفتة مشوية بالوزن وبطاطس محمرة وبيبسي زجاج توصيل");
  assert.equal(r2.ok, true, JSON.stringify(r2.trace.verdicts.map((v) => v.problems)));
  assert.equal(r2.trace.verdicts.length, 1, "no retry");
  const c3 = chat([use(["preview_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 44 }, { id: "79", qty: 1 }, { id: "86", qty: 1 }] }]), say("المجموع 50 ر.س.")], { world: { profile: "new" } });
  assert.notEqual((await c3.turn("ثلث كيلو كفتة وبطاطس وبيبسي")).trace.tools[0].result.suggestion?.kind, "next_tier", "delivery not said yet: no fee talk (the playbook: the add-on comes with «توصيل ولا استلام؟» or after it)");
});

test("(10) interactive by default: weight, delivery-or-pickup, how many people, «أعتمده؟» — WhatsApp limits respected", async () => {
  const w = [{ label: "ثلث كيلو", label_en: "1/3 kg", price: 53, variant_option_id: 56 }, { label: "نصف كيلو", label_en: "1/2 kg", price: 78, variant_option_id: 57 }, { label: "كيلو", label_en: "1 kg", price: 155, variant_option_id: 58 }];
  assert.deepEqual(S.choiceButtons("المشكل المخصوص بالوزن: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س.\nتبيه نصف كيلو ولا كيلو؟", { weights: w }).kind, "weights");
  assert.equal(S.choiceButtons("تمام. توصيل ولا استلام؟").kind, "mode");
  assert.equal(S.choiceButtons("أبشر. لكم شخص؟").kind, "people");
  assert.equal(S.choiceButtons("أجهّزه بوجبة نصف دجاجة ووجبة كفتة، الأكثر طلباً. أعتمده؟").kind, "confirm");
  assert.equal(S.choiceButtons("العفو، حيّاك الله في أي وقت 🌟"), null, "no question, no buttons");
  for (const b of [{ kind: "weights", weights: w }, { kind: "mode" }, { kind: "confirm" }, { kind: "sg" }, { kind: "same" }]) for (const L of ["ar", "en"]) {
    const ex = R.assistExtras(cfg, L, { buttons: b });
    assert.ok(ex.buttons.length >= 2 && ex.buttons.length <= LIMITS.btns, `${b.kind} ${L}`);
    for (const x of ex.buttons) { assert.ok([...x.title].length <= LIMITS.btnTitle, `${b.kind} ${L} «${x.title}»`); assert.match(x.id, /^(as:|re:last$)/); }
    const pl = R.toPayload({ body: "سؤال؟", ...ex }, { cfg, lang: L, interactive: true, footer: false }); assert.equal(R.payloadProblem(pl), null, `${b.kind} ${L}`);
  }
  assert.deepEqual(R.assistExtras(cfg, "ar", { buttons: { kind: "weights", weights: w } }).buttons.map((x) => x.title), ["ثلث كيلو · 53 ر.س", "نصف كيلو · 78 ر.س", "كيلو · 155 ر.س"]);
  const pe = R.assistExtras(cfg, "ar", { buttons: { kind: "people" } });
  assert.equal(pe.list.rows.length, 5); for (const x of pe.list.rows) assert.ok([...x.title].length <= LIMITS.rowTitle);
  assert.equal(R.payloadProblem(R.toPayload({ body: "لكم شخص؟", ...pe }, { cfg, lang: "ar", interactive: true, footer: false })), null);
  // in the loop: a reply asking the weight of a dish the customer named gets its three weights as buttons
  const c = chat([use(["search_menu", { query: "مشكل" }]), say("مشكل مخصوص بالوزن: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س.\nتبيه نصف كيلو ولا كيلو؟")], { world: { profile: "new" } });
  const r = await c.turn("كم المشكل؟");
  assert.equal(r.buttons.kind, "weights"); assert.deepEqual(r.buttons.weights.map((x) => x.price), [53, 78, 155]);
});

test("(11) the cart recap is the fixed code template: one line per item with weight and note, subtotal, delivery, total, button", async () => {
  const c = chat([use(["build_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 45, note: "مستوية زيادة" }, { id: "123", qty: 1 }] }]), say("سلتك جاهزة 👍")], { world: { profile: "new" }, acfg: { feeMoment: false } });
  const r = await c.turn("نص كيلو كفتة وطبق أرز، توصيل");
  assert.ok(r.cart);
  assert.equal(r.text, ["🛒 سلتك (توصيل):", "• *كفتة مشوية بالوزن* — نصف كيلو × 1 = 60 ر.س", "↳ ملاحظة للمطبخ: مستوية زيادة", "• *طبق أرز بسمتي* × 1 = 6 ر.س", "المجموع: 66 ر.س", "التوصيل: مجاني بكود FIRST 🎁", "الإجمالي: 66 ر.س", "راجع السلة، ولو كل شي تمام اضغط الزر وأكمل الدفع 👇"].join("\n"));
  const c2 = chat([use(["build_cart", { option: "delivery", items: [{ id: "8", qty: 3 }] }]), say("تمام")], { world: { profile: "returning", loc: "in", loyaltyN: 0 }, acfg: { feeMoment: false } });
  c2.W.state.loc = { lat: 21.58, lng: 39.16 };
  const r2 = await c2.turn("ثلاث كريب زنجر سوبريم توصيل");
  assert.match(r2.text, /المجموع: 75 ر.س\nالتوصيل: 15 ر.س\nالإجمالي: 90 ر.س/);
  const c3 = chat([use(["build_cart", { option: "pickup", items: [{ id: "8", qty: 1 }] }]), say("تمام")], { world: { profile: "returning" } });
  assert.match((await c3.turn("كريب زنجر استلام")).text, /استلام من الفرع: بدون رسوم توصيل/);
});

test("(12) «وش العروض؟»: the live offers block from code (dated offers, one box per tier, the first-order line) — restored word for word if the model rewrites it", async () => {
  const c = chat([say("عندنا عروض حلوة! وش تحب؟")], { world: { profile: "new", at: "2026-10-13T15:00:00Z" } });
  const r = await c.turn("وش العروض اللي عندكم؟");
  assert.equal(r.trace.blockRestored, true);
  assert.match(r.text, /🔥 عروضنا الحين:\n/);
  assert.match(r.text, /• \*بوكس الكريب الفردي\* — 29 ر.س/);
  assert.match(r.text, /🎁 أول طلب توصيل لك من موقعنا مجاني للطلبات من 60 ر.س بكود FIRST\./);
  assert.match(r.text, /؟$/);
  assert.equal(r.session.state.proactive, "first", "the first-order line was in the block: not repeated later");
});

test("(13) formatting: dish names in bold once, a long paragraph becomes short lines, «ريال» ⇒ «ر.س»", () => {
  assert.equal(S.boldNames("كريب زنجر سوبريم بـ 25 ر.س، وكريب زنجر سوبريم مرة ثانية", ["كريب زنجر سوبريم"]), "*كريب زنجر سوبريم* بـ 25 ر.س، وكريب زنجر سوبريم مرة ثانية");
  assert.equal(S.boldNames("عندنا «بوكس المشاوي نص ونص» بـ 125 ر.س", ["بوكس المشاوي نص ونص"]), "عندنا *بوكس المشاوي نص ونص* بـ 125 ر.س");
  assert.equal(S.boldNames("وجبة كفتة وطرب", ["وجبة كفتة", "وجبة كفتة وطرب"]), "*وجبة كفتة وطرب*", "the longer name wins");
  assert.equal(S.boldNames("• *وجبة كفتة* × 1", ["وجبة كفتة"]), "• *وجبة كفتة* × 1", "already bold: unchanged");
  assert.equal(S.formatReply("السعر 25 ريال"), "السعر 25 ر.س");
  const long = "بوكس المشاوي نص ونص فيه كيلو مشاوي من نوعين تختارهم مع طبقين أرز وبطاطس وكولسلو والسلطة والطحينة والخبز. وإذا تبي شي أخف عندنا ميكس جريل لشخصين بسعر أقل. أي واحد يناسبك؟";
  assert.equal(S.formatReply(long).split("\n").length, 3);
});

test("(14) settings: every SB1 switch is in the dashboard schema, on by default; off = the old behaviour", () => {
  const d = AR.assistConfig({});
  for (const k of ["salesBrain", "proactiveLines", "thresholdNudge", "offerButtons", "choiceButtons", "codeRecap", "offersBlock", "boldNames"]) { assert.equal(d[k], true, k); assert.ok(AR.ASSIST_SCHEMA[`assist.${k}`], k); }
  assert.equal(d.maxOffersPerChat, 2); assert.ok(AR.ASSIST_SCHEMA["assist.maxOffersPerChat"]);
  assert.deepEqual(AR.assistFromBody({ maxOffersPerChat: 5 }, {}).ok, false, "range 0–3");
  for (const k of Object.keys(R.TEXTS).filter((x) => /^(sb_|btn_sg_|btn_confirm_|row_people_|list_people_btn|cart_recap_(fee|pickup|grand))/.test(x))) for (const L of ["ar", "en"]) assert.equal(R.textProblem(k, L, R.TEXTS[k][L]), null, `${k} ${L}`);
});

test("(15) eval sb1-b regressions: the code's own recap «المجموع: 60 ر.س» in a kofta cart is not «a weight price without its weight»; the question is the LAST sentence of a one-line reply", async () => {
  const c = chat([use(["build_cart", { option: "delivery", items: [{ id: "91", qty: 1, variant_option_id: 44 }, { id: "79", qty: 1 }, { id: "86", qty: 1 }, { id: "73", qty: 1 }] }]), say("تمام 👍")], { world: { profile: "new" }, acfg: { feeMoment: false } });
  const r = await c.turn("ثلث كيلو كفتة بالوزن وبطاطس وبيبسي وفرايد تشيكن، ارسل السلة توصيل");
  assert.equal(r.ok, true, JSON.stringify(r.trace.verdicts.map((v) => v.problems)));
  assert.match(r.text, /المجموع: 60 ر.س\nالتوصيل: مجاني بكود FIRST 🎁\nالإجمالي: 60 ر.س/);
  const w = [{ label: "ثلث كيلو", price: 53, variant_option_id: 56 }, { label: "نصف كيلو", price: 78, variant_option_id: 57 }];
  assert.equal(S.choiceButtons("أبشر، ويُباع بالوزن: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س. كم شخص أنتم؟", { weights: w }).kind, "people");
  assert.equal(S.choiceButtons("مشكل مخصوص، الكيلو بـ 155 ر.س. تجهّزه لك كيلو؟").kind, "confirm");
});
