/* PK1 (١٤/١٠/٢٠٢٦) — «ملف معرفة البيزنس» وسلوك البيع. عمر (١٣/١٠ بالليل): «حاسس انه مش بالذكاء الكافي ولا عنده علم كافي بالبيزنس والمبيعات».
   يوم ١٣/١٠: ٢٧ محادثة، ٨٥ رد من المساعد، ولا سلة. كل اختبار هنا من سطر حقيقي في محادثات اليوم ده، بالحرف. من غير أي نداء موديل ولا شبكة.
       node --test wa-pk1.test.mjs
   (المتابعة بعد السكوت، رسالة revoke، الصوت، مسارات اللوحة: في wabotrun.test.mjs تحت «PK1».) */
import test from "node:test";
import assert from "node:assert/strict";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import { servingClaim } from "./waassist.js";
import { BRIEF_FIELDS, BRIEF_LIMITS, briefOf, briefBlock, briefFromBody, briefFieldProblem, briefForDashboard, menuDigest, livePricesIn } from "./wabrief.js";
import { buildMajedReport, businessDay } from "./wamajed.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (...u) => ({ ok: true, content: u.map(([name, input], i) => ({ type: "tool_use", id: `u${i}${name}`, name, input })), stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
function chat(steps, acfg = {}, world = {}) { let i = 0; const seen = [];
  const W = makeWorld(world, { callModel: async (a) => { seen.push({ system: a.system, brief: a.brief ?? null }); const s = steps[i++]; if (!s) throw new Error("no step left"); return s; }, onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg: { pairingEnabled: false, forceSuggestion: false, feeMoment: false, ...acfg } });
  let session = null; const turn = async (text) => { const hours = await W.tools.get_hours(); const fresh = !session; if (fresh) session = AR.newSession(W.now());
    const cls = R.classify({ phone: PHONE, text, type: "text" }, W.know);
    const r = await W.loop.runTurn({ phone: PHONE, text, lang: "ar", session, acfg: { ...W.acfg, routing: "strong", salesBrain: false }, context: AR.buildContext({ first: fresh, hours, boxes: W.boxes, hint: AR.hintOf(cls) }) }); if (r.ok) session = r.session; return r; };
  return { W, turn, seen, used: () => i }; }
const W0 = makeWorld({}, { callModel: async () => say("x"), onCall: async () => ({}) });
const know = { menu: W0.menu, boxes: W0.boxes };
const BLOCK = `${AR.SELLING_RULES}\n\n${W0.brief}`;
const MF = { text: BLOCK, owner: BLOCK.split("## Live menu")[0].split("\n").filter((l) => !/^\(live prices/.test(l)).join("\n") };
const problems = (t, o = {}) => AR.checkReply(t, { facts: [], know, lang: "ar", menuFacts: MF, ...o }).problems.map((p) => p.type);

/* ── A) ملف معرفة البيزنس ─────────────────────────────────────────────────── */
test("brief: every pre-filled value passes its own review, the owner-only fields are empty and marked, and nothing in it states a serving count, a recipe or a supplier", () => {
  for (const f of BRIEF_FIELDS) assert.equal(briefFieldProblem(f.key, f.def), null, f.key);
  assert.deepEqual(BRIEF_FIELDS.filter((f) => f.owner).map((f) => [f.key, f.def]), [["car_pickup", ""], ["mashakel_kinds", ""], ["extra", ""]]);
  const d = briefForDashboard({});
  assert.ok(d.every((x) => x.label && x.source && x.isDefault && !x.problem)); assert.deepEqual(d.filter((x) => x.needsOwner).map((x) => x.key), ["car_pickup", "mashakel_kinds", "extra"]);
  assert.deepEqual(d.filter((x) => x.needsConfirm).map((x) => x.key), ["desserts", "drinks", "not_sold"], "taken from what the live menu does NOT have: shown to the owner as «confirm»");
  assert.deepEqual(briefOf({}).dropped, []);
  assert.ok(BRIEF_FIELDS.reduce((a, f) => a + [...f.def].length, 0) < BRIEF_LIMITS.total);
});
test("brief: the block the model gets — the owner's sections, live prices beside the box names the owner wrote, the live menu with every weight and price; the same input gives the same text (provider cache)", () => {
  const b = briefBlock({}, { menu: W0.menu, boxes: W0.boxes, live: { cash: false } });
  assert.match(b, /^<business_brief /); assert.match(b, /<\/business_brief>$/);
  for (const re of [/## How ordering works\n١\) تكتب لي هنا اللي تبيه/, /تضغط زر «كمّل طلبك»/, /ما فيه دفع كاش عند الاستلام أو التوصيل/, /المشاوي بالوزن: ثلث كيلو أو نصف كيلو أو كيلو[^\n]*السلطة والطحينة والخبز/, /مشكل مخصوص: تشكيلة من مشاوينا على الفحم/,
    /\(live prices of the names above — [^\n]*بوكس المشاوي نص ونص: 125 ر\.س/, /ما عندنا حلى في المنيو حالياً/, /خانة «عندك كود؟»/, /## Live menu/, /Menu sections: وجبات، مشاوي بالوزن، كريبات، بيتزا، طاسات، باستا، برجر، حواوشي، إضافات/,
    /وجبة ميكس جريل 37 — وجبة مشوية تحتوي على كفتة، طرب، صدور دجاج، شيش طاووق/, /مشكل مخصوص بالوزن: ثلث كيلو 53 · نصف كيلو 78 · كيلو 155/, /\[بوكسات لشخصين\] ميكس جريل لشخصين 85 — /, /باقة تجمّع ٤–٦ أشخاص 225/]) assert.match(b, re);
  assert.doesNotMatch(b, /الأنواع|mashakel_kinds/, "an empty owner field adds nothing");
  assert.equal(b, briefBlock({}, { menu: W0.menu, boxes: W0.boxes, live: { cash: false } }));
  assert.match(briefBlock({}, { menu: W0.menu, boxes: W0.boxes, live: { cash: true } }), /Cash is accepted on website orders/);
  assert.equal(briefBlock({}, { menu: null, boxes: null }).includes("## Live menu"), false, "menu down: the owner's fields alone");
  // a price is never written into a field: it is attached from the live menu, and it follows the menu
  const dg = menuDigest(W0.menu, W0.boxes); assert.deepEqual(livePricesIn("مشاوي: «ميكس جريل لشخصين» أو وجبة كفتة وطرب", dg.names), ["ميكس جريل لشخصين: 85 ر.س", "وجبة كفتة وطرب: 37 ر.س"]);
  const dearer = { ...W0.menu, items: W0.menu.items.map((i) => (i.id === "87" ? { ...i, price: 39 } : i)) };
  assert.deepEqual(livePricesIn("وجبة كفتة وطرب", menuDigest(dearer, W0.boxes).names), ["وجبة كفتة وطرب: 39 ر.س"]);
});
test("brief: what the owner types is reviewed when saved AND when read — a serving count for «مشكل مخصوص», pieces, a recipe, a supplier, a health claim, a time promise, a link never reach the model", () => {
  const bad = [["mashakel_line", "مشكل مخصوص تشكيلة مشاوي والكيلو يكفي ٤ أشخاص"], ["mashakel_steer", "النص كيلو لشخصين والكيلو لأربعة"], ["mashakel_kinds", "٣ أسياخ كفتة وسيخين طرب"], ["mashakel_kinds", "كفتة 100 جرام وطرب 100 جرام"],
    ["grill_weight", "نتبلها بالثوم والليمون"], ["extra", "نشتري اللحم من مورد محلي"], ["extra", "كل أصنافنا خالية من الجلوتين"], ["delivery_area", "التوصيل خلال 30 دقيقة"], ["extra", "شوف freshcuts.sa/menu"], ["extra", "خصم 20% على كل شي"]];
  for (const [k, v] of bad) { assert.ok(briefFieldProblem(k, v), v); const r = briefFromBody({ fields: { [k]: v } }, {}); assert.equal(r.ok, false, v); assert.equal(r.errors.length, 1);
    const o = briefOf({ [k]: v }); assert.deepEqual(o.dropped, [k], "stored by another route: dropped when read"); assert.equal(o.values[k], ""); assert.equal(briefBlock({ [k]: v }, {}).includes(v), false); }
  // what a good seller may say is accepted
  const good = briefFromBody({ fields: { mashakel_kinds: "كفتة، طرب، كباب، وريش", mashakel_line: "مشكل مخصوص: تشكيلة مشاوي على الفحم تُباع بالوزن، ومعها سلطة وطحينة وخبز.", sell_family: "للعائلة: «بوكس المشكل المخصوص» أو «بوكس المشاوي نص ونص».", car_pickup: null } }, { car_pickup: "قديم" });
  assert.equal(good.ok, true); assert.deepEqual(Object.keys(good.value).sort(), ["mashakel_kinds", "mashakel_line", "sell_family"], "null = back to the pre-filled value");
  assert.match(briefBlock(good.value, {}), /كفتة، طرب، كباب، وريش/);
  assert.deepEqual(briefFromBody({ fields: { nope: "x" } }, {}).errors, ["nope: حقل غير معروف"]); assert.equal(briefFromBody({}, {}).ok, false);
  assert.equal(briefFromBody({ fields: { extra: "ا".repeat(BRIEF_LIMITS.field + 1) } }, {}).ok, false);
  assert.deepEqual(briefFromBody({ fields: { order_steps: BRIEF_FIELDS.find((f) => f.key === "order_steps").def } }, { order_steps: "قديم" }).value, {}, "saving the pre-filled text stores nothing");
});

/* ── المراجِع: المشكل، القفلة، وسعر المنيو الحي جنب صنفه ─────────────────────── */
test("validator: «مشكل مخصوص» never gets a number of people or of pieces — even when the brief would say so — while the honest ways to answer pass", () => {
  for (const t of ["نصف كيلو مشكل مخصوص يكفي شخصين", "المشكل المخصوص الكيلو يكفي ٤ أشخاص", "مشكل مخصوص: كيلو لـ 4 أشخاص", "لشخصين أنصحك بنصف كيلو من المشكل المخصوص", "المشكل المخصوص مناسب لشخص واحد", "Special Mix: half a kilo serves two"]) assert.ok(servingClaim(t), t);
  for (const t of ["المشكل المخصوص يُباع بالوزن. كم شخص أنتم؟", "مشكل مخصوص بالوزن: ثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س. تبيه نصف كيلو ولا كيلو؟", "لـ 3 أشخاص أنسب لكم «بوكس المشكل المخصوص» بـ 145 ر.س", "وجبة ميكس جريل لشخص واحد بـ 37 ر.س", "بوكس الكريب لشخصين بـ 65 ر.س"]) assert.equal(servingClaim(t), null, t);
  assert.ok(problems("المشكل المخصوص تشكيلة مشاوي على الفحم، والنص كيلو يكفي شخصين. تبيه؟").includes("serving_count"));
  assert.ok(problems("المشكل المخصوص فيه 4 أسياخ في الثلث كيلو. كم شخص أنتم؟").includes("serving_count"), "«بهذا المبلغ كم سيخ سوف احصل عليه» is not answered with a count");
  // the real question of the day, answered the way the rule says
  assert.deepEqual(problems("المشكل المخصوص تشكيلة من مشاوينا على الفحم، يُباع بالوزن ومعه السلطة والطحينة والخبز: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س.\nكم شخص أنتم؟"), []);
  assert.deepEqual(problems("يُباع بالوزن مو بالسيخ: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س للمشكل المخصوص.\nكم شخص أنتم؟"), []);
  assert.match(AR.retryNote([{ type: "serving_count", value: "يكفي شخصين" }]), /ask «كم شخص أنتم؟»/);
});
test("validator: a price that only the live menu justifies must stand beside its own dish — «كريب زنجر سوبريم بـ 19» (another dish's price) and «بيتزا مارجريتا بـ 8» (a pack size the owner wrote) are still refused", () => {
  assert.deepEqual(problems("وجبة ميكس جريل بـ 37 ر.س: كفتة وطرب وصدور دجاج وشيش طاووق مع الأرز والسلطة والطحينة. أجهّزها لك؟"), [], "named with its own price, no tool call needed");
  assert.deepEqual(problems("لشخصين: «ميكس جريل لشخصين» بـ 85 ر.س، وجبتين مع بطاطس وكولسلو ومشروبين. أجهّزه لك؟"), []);
  assert.deepEqual(problems("عندنا «باقة تجمّع ٨–١٠ أشخاص» بـ 395 ر.س. تناسبكم؟"), [], "digits inside a pack's name are not prices");
  assert.deepEqual(problems("الريش المشوية بالوزن: ثلث كيلو 62 ر.س · نصف كيلو 93 ر.س · كيلو 185 ر.س. أي وزن تبي؟"), []);
  assert.ok(problems("كريب زنجر سوبريم بـ 19 ر.س فقط!").includes("number_not_from_tools"));
  assert.ok(problems("بيتزا مارجريتا بـ 8 ر.س").includes("number_not_from_tools"));
  assert.ok(problems("التوصيل 12 ر.س").includes("number_not_from_tools"), "a fee is never in the brief");
  // without the brief nothing changes: the name itself must come from a tool
  assert.ok(AR.checkReply("وجبة ميكس جريل بـ 37 ر.س", { facts: [], know, lang: "ar" }).problems.some((p) => p.type === "name_not_from_tools"));
});
test("validator: «تحب أجهّز لك طلب؟» as the last line is sent back once (the 7 one-message ad chats ended on it); a second weak close goes out — a right answer is never lost for its closing line", async () => {
  for (const t of ["عرض أول طلب: توصيل مجاني بكود FIRST. تحب أجهّز لك طلب؟", "توصيل مجاني باستخدام الكود FIRST.\n\nتبي تبدأ طلبك؟", "تحب نجهّز لك طلب؟"]) assert.ok(AR.WEAK_CLOSE_RE.test(t), t);
  for (const t of ["كم شخص أنتم؟", "تبيه نصف كيلو ولا كيلو؟", "وش تحب تطلب؟", "أجهّزه لك؟", "تحب أجهّز لك بوكس المشاوي نص ونص؟"]) assert.equal(AR.WEAK_CLOSE_RE.test(t), false, t);
  const a = chat([say("هلا والله 👋 تحب أجهّز لك طلب؟"), say("هلا والله 👋 كم شخص أنتم؟")]);
  const r = await a.turn("مرحبا"); assert.equal(r.text, "هلا والله 👋 كم شخص أنتم؟"); assert.deepEqual(r.trace.verdicts[0].problems.map((p) => p.type), ["weak_close"]);
  const b = chat([say("هلا والله 👋 تحب أجهّز لك طلب؟"), say("هلا والله 👋 تبي تبدأ طلبك؟")]);
  const r2 = await b.turn("مرحبا"); assert.equal(r2.ok, true); assert.equal(r2.text, "هلا والله 👋 تبي تبدأ طلبك؟"); assert.equal(r2.trace.softAccepted, true);
  const c = chat([say("هلا والله 👋 تحب أجهّز لك طلب؟")], { sellerClose: false }); assert.equal((await c.turn("مرحبا")).text, "هلا والله 👋 تحب أجهّز لك طلب؟");
  // a hard problem is still a hard problem
  const d = chat([say("كريب زنجر سوبريم بـ 19 ر.س. تحب أجهّز لك طلب؟"), say("كريب زنجر سوبريم بـ 19 ر.س. تحب أجهّز لك طلب؟")]); assert.equal((await d.turn("بكم الزنجر")).reason, "validator");
});

/* ── الحلقة: الكتلة التانية، الأدوات الجديدة، والأسئلة اللي من غير إجابة ─────── */
test("loop: the brief travels as a second instructions block (selling rules + the owner's brief + the live menu); the fixed instructions stay as they were and under their size limit; off = no block", async () => {
  assert.ok(AR.SYSTEM_PROMPT.length < 24000); assert.doesNotMatch(AR.SELLING_RULES, /\d/, "no digits: the block counts as facts for the number check");
  const a = chat([say("هلا والله 👋 كم شخص أنتم؟")]); const r = await a.turn("مرحبا");
  assert.equal(a.seen[0].system, AR.SYSTEM_PROMPT); assert.ok(a.seen[0].brief.startsWith(AR.SELLING_RULES)); assert.match(a.seen[0].brief, /<business_brief [\s\S]*## Live menu[\s\S]*<\/business_brief>$/);
  assert.ok(r.trace.briefChars > 9000);
  for (const re of [/How to order \(«كيف أطلب؟»/, /three short steps/, /call menu_button/, /ONE narrowing question/, /propose ONE concrete order/, /sold by weight, not by the piece/, /dish_fact with list: true/, /never «اكتب موظف» for this/, /Never end with a bare «تحب أجهّز لك طلب؟»/]) assert.match(AR.SELLING_RULES, re);
  const off = chat([say("هلا والله 👋 كم شخص أنتم؟")], { briefEnabled: false }); await off.turn("مرحبا"); assert.equal(off.seen[0].brief, null);
  // the request body: two system blocks, each with its cache point
  let body = null; const call = AR.makeModelCaller({ env: { ANTHROPIC_API_KEY: "k" }, fetch: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ content: [], stop_reason: "end_turn", usage: {} }) }; } });
  await call({ model: "claude-sonnet-5-5", system: "S", brief: "B", tools: AR.TOOL_DEFS, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
  assert.deepEqual(body.system, [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }, { type: "text", text: "B", cache_control: { type: "ephemeral" } }]);
  await call({ model: "claude-sonnet-5-5", system: "S", tools: AR.TOOL_DEFS, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }); assert.equal(body.system.length, 1);
});
test("«كيف أطلب من الموقع؟» (the ad's canned question, 6 times that day): the classifier's hint tells the assistant to answer the three steps; the day's real non-answer now lands in the manager's queue", async () => {
  const cls = R.classify({ phone: PHONE, text: "كيف أطلب من الموقع؟", type: "text" }, W0.know);
  assert.equal(AR.hintOf(cls).intent, "how_to_order_or_wants_to_order"); assert.match(AR.hintOf(cls).do, /three steps from the brief/);
  assert.equal(AR.hintOf(R.classify({ phone: PHONE, text: "التلت والنص والكيلوا مكون من اية ويكفي كام شخص", type: "text" }, W0.know)).intent, "how_many_people_is_it_enough_for");
  const good = chat([say("سهلة: تكتب لي اللي تبيه وأجهّز لك السلة، تضغط الزر، وعلى موقعنا تحدد موقعك وتدفع. وش تحب تطلب؟")]);
  const g = await good.turn("كيف أطلب من الموقع؟"); assert.equal(g.ok, true); assert.deepEqual(g.trace.unanswered, []);
  const OLD = "ما عندي تفاصيل مؤكدة عن خطوات الطلب من الموقع، وتقدر تكتب «موظف» وأحد من الفريق يرد عليك. وش تحب تطلب؟";
  const bad = chat([say(OLD)]); const b = await bad.turn("كيف أطلب من الموقع؟");
  assert.deepEqual(b.trace.unanswered, [{ source: "no_answer", question: "كيف أطلب من الموقع؟", by: "reply_text" }], "a «ما عندي معلومة» reply queues the customer's question for the manager");
  for (const t of [OLD, "ما أقدر أفصّل مكونات الصنف ولا الكمية", "ما عندي معلومة مؤكدة عن عدد الأسياخ", "أما الأوصال فما لقيتها في المنيو عندنا", "ما عندي تأكيد أن فيه حمص ومتبل"]) assert.ok(AR.NON_ANSWER_RE.test(t), t);
  assert.equal(AR.NON_ANSWER_RE.test("ما عندنا حمص ومتبل، ومع المشاوي سلطة وطحينة وخبز"), false, "a plain «we do not have it» is an answer");
});
test("«بكم على الفحم» / «لحم»: a vague grill wish is no longer turned into «صدور: وجبة ولا بالوزن؟» — the meal-or-weight question is asked only for a grill the customer named", async () => {
  const a = chat([use(["search_menu", { query: "مشوي على الفحم" }]), say("أبشر. لكم شخص؟")]);
  const r = await a.turn("بكم على الفحم");
  assert.equal(r.trace.tools[0].result.ok, true); assert.equal("ask_which" in r.trace.tools[0].result, false); assert.equal(r.buttons, null); assert.equal(r.text, "أبشر. لكم شخص؟");
  const b = chat([use(["search_menu", { query: "كفتة" }]), say("أبشر. لكم شخص؟")]);
  const r2 = await b.turn("لحم"); assert.equal("ask_which" in r2.trace.tools[0].result, false, "«لحم» is not «كفتة»");
  const c = chat([use(["search_menu", { query: "كفتة" }]), say("تبيها وجبة كفتة بـ 24 ر.س مع الأرز والسلطة والطحينة، ولا بالوزن (ثلث كيلو: 40 ر.س · نصف كيلو: 60 ر.س · كيلو: 120 ر.س)؟")]);
  const r3 = await c.turn("ابي كفتة"); assert.ok(r3.trace.tools[0].result.ask_which, "named ⇒ asked, as before"); assert.equal(r3.buttons.kind, "family");
});
test("«يسبب الحساسية» → «برجر لحم كلاسيك»: the recorded allergens of the dish at once, with the kitchen line and the order-note line — the text is the approved one, word for word", async () => {
  const a = chat([use(["dish_fact", { id: "71", list: true }]), say("أبشر، أشيّك لك.")], {}, { waBot: { dishFactsEnabled: true } });
  const r = await a.turn("برجر لحم كلاسيك يسبب الحساسية");
  const res = r.trace.tools[0].result; assert.equal(res.status, "list");
  assert.match(res.say, /^حسب بيانات مطبخنا، «برجر لحم كلاسيك» يحتوي على: /); assert.match(res.say, /ملاحظة الطلب/); assert.equal(r.text, res.say, "the model's own wording is replaced by the approved text");
  // «حساسية» as the question, or no question at all, means the same; a named allergen keeps the one-question answer; off = as before
  const b = chat([use(["dish_fact", { id: "71", question: "حساسية" }]), say("x")], {}, { waBot: { dishFactsEnabled: true } }); assert.equal((await b.turn("برجر لحم كلاسيك")).trace.tools[0].result.status, "list");
  const c = chat([use(["dish_fact", { id: "71", question: "سمسم" }]), say("x")], {}, { waBot: { dishFactsEnabled: true } }); assert.notEqual((await c.turn("البرجر الكلاسيك فيه سمسم؟")).trace.tools[0].result.status, "list");
  const d = chat([use(["dish_fact", { id: "71", list: true }]), say("x")], { allergenList: false }, { waBot: { dishFactsEnabled: true } }); assert.notEqual((await d.turn("برجر لحم كلاسيك يسبب الحساسية")).trace.tools[0].result.status, "list");
  assert.deepEqual(AR.TOOL_DEFS.find((t) => t.name === "dish_fact").input_schema.required, ["id"]);
});
test("«ايش عندكم اليوم»: the sections in one line and a button that opens the whole menu (it had answered with four unrelated best sellers)", async () => {
  const a = chat([use(["menu_button", {}]), say("عندنا مشاوي على الفحم (وجبات وبالوزن)، كريبات، بيتزا، باستا، برجر، حواوشي وطاسات. وش تشتهي؟")]);
  const r = await a.turn("ايش عندكم اليوم");
  assert.equal(r.ok, true); assert.equal(r.menu, true); assert.match(r.trace.tools[0].result.rule, /sections in ONE line/);
  const off = chat([use(["menu_button", {}]), say("عندنا مشاوي وكريبات وبيتزا. وش تشتهي؟")], { menuButton: false }); const r2 = await off.turn("ايش عندكم اليوم"); assert.equal(r2.menu, false);
  assert.ok(problems("اضغط menu_button").includes("internal_leak"));
});
test("rules: «ابغي أشوف المنيو كامل وكل وجبه وسعرها» is the whole menu (sections + link, no model); a deleted message is nobody's; a voice note is «media» with its own line", () => {
  const acfg = AR.assistConfig({ mode: "test" }), cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } });
  const el = (text, type = "text") => { const ev = { phone: PHONE, text, type }, cls = R.classify(ev, W0.know); return [cls.key, cls.rawIntent, AR.assistEligible({ acfg, cfg, phone: PHONE, ev, cls, d: cls.key ? { act: "reply", key: cls.key } : null, allowed: true }).why]; };
  assert.deepEqual(el("ابغي أشوف المنيو كامل وكل وجبه وسعرها"), ["cats", "menu", "rules:menu"]);
  for (const t of ["ابي المنيو كله", "ممكن المنيو كامل", "send me the full menu"]) assert.equal(el(t)[2], "rules:menu", t);
  assert.equal(el("ابي وجبة كفتة")[2] === "rules:menu", false); assert.equal(R.WHOLE_MENU_RE.test("كم سعر الكامل"), false);
  assert.deepEqual(el("[رسالة اتمسحت]", "revoke"), [null, "type:revoke", "no_class"]);
  const v = R.classify({ phone: PHONE, text: "[رسالة صوتية]", type: "audio" }, W0.know); assert.deepEqual([v.key, v.arg], ["media", "voice"]);
  assert.match(R.buildReply("media", { cfg, lang: "ar", data: { settings: {} }, referral: null, factual: false, arg: "voice" }).body, /^ما أقدر أسمع المقاطع الصوتية 🙏 اكتب لي طلبك هنا/);
  assert.match(R.buildReply("media", { cfg, lang: "ar", data: { settings: {} }, referral: null, factual: false, arg: null }).body, /^ما أقدر أفتح الصور والمقاطع الصوتية/);
});

/* ── C) تقرير ماجد ───────────────────────────────────────────────────────── */
test("daily report: chats → carts → paid orders, the questions it could not answer grouped with counts, where customers stopped, the cost, and the worst replies — built from the real lines of 13/10, with no phone number in it", () => {
  let id = 0; const T = (chat, min, customer, reply, o = {}) => ({ id: ++id, at: new Date(Date.parse("2026-10-13T10:00:00Z") + min * 60_000).toISOString(), phone_norm: `5000000${chat}`.slice(0, 9), chat_hash: `h${chat}`, handled_by: "assistant", outcome: "sent", customer_masked: customer, final_text: reply, lang: "ar", tool_calls: [], verdicts: [{ ok: true }], cost_sar: 0.02, cart_code: null, ...o });
  const turns = [
    T(1, 0, "كيف أطلب من الموقع؟", "ما عندي تفاصيل مؤكدة عن خطوات الطلب من الموقع، وتقدر تكتب «موظف» وأحد من الفريق يرد عليك."),
    T(1, 1, "موظف", null, { handled_by: "rules_owned", outcome: "rules:human", cost_sar: 0 }),
    T(1, 2, "التلت والنص والكيلوا مكون من اية ويكفي كام شخص", "ما أقدر أفصّل مكونات الصنف ولا الكمية أو عدد الأشخاص اللي يكفيهم، لكن أقدر أساعدك في الأسعار والطلب. تبي تطلب منه ثلث كيلو ولا نصف كيلو ولا كيلو؟"),
    T(1, 3, "شكرا لك", "العفو، حيّاك الله في أي وقت 🌟"),
    T(2, 5, "بهذا المبلغ كم سيخ سوف احصل عليه !!", "ما عندي معلومة مؤكدة عن عدد الأسياخ، وما أقدر أخمّن. اكتب «موظف» وأحوّلك للفريق يردون عليك."),
    T(2, 6, "ولا واحد وأسعاركم عاليه", "حاضر، إذا تبي شي أخف في السعر: حواوشي سادة بـ 20 ر.س. تحب أجهّز لك أيهم؟"),
    T(3, 10, "وش عرض أول طلب؟", "عرض أول طلب: توصيل مجاني بكود FIRST. تحب أجهّز لك طلب؟"),
    T(4, 12, "وش عرض أول طلب؟", "عرض أول طلب: توصيل مجاني بكود FIRST.\n\nتبي تبدأ طلبك؟"),
    T(5, 15, "كيف اطلب من الموقع", "ما عندي تفاصيل مؤكدة عن خطوات الطلب. اكتب «موظف»."),
    T(6, 20, "[revoke]", "Hi, I'm ماجد. I'm not sure what you mean by \"[revoke]\". Are you asking to stop our offer messages, or do you want to order something?"),
    T(7, 30, "ابي نص كيلو كفته استلام", "سلتك (استلام): كفتة مشوية بالوزن (نصف كيلو) × 1 = 60 ر.س", { cart_code: "rc000001" }),
    T(8, 40, "ابي بيتزا", null, { handled_by: "rules", outcome: "fallback:validator", cost_sar: 0.03 }),
  ];
  const rep = buildMajedReport({ day: "2026-10-13", turns, orders: [{ phone_norm: "50000007", total: 60, link: "wa-assistant" }, { phone_norm: "599999999", total: 200, link: null }], kbRows: [{ id: 4, status: "open", question: "كيف أطلب من الموقع؟" }] });
  assert.deepEqual([rep.chats, rep.customer_messages, rep.assistant_replies], [8, 12, 10]);
  assert.deepEqual(rep.funnel, { chats: 8, carts: 1, chats_with_cart: 1, paid_orders: 1, chats_with_paid_order: 1, paid_orders_through_cart_link: 1, paid_revenue_sar: 60, cart_rate: 0.125, order_rate: 0.125 }, "an order from a number that did not chat is not counted");
  assert.equal(rep.cost.total_sar, 0.23); assert.equal(rep.cost.per_paid_order_sar, 0.23);
  // «كيف أطلب» twice in two spellings = one row, already in the manager's queue; the mashakel and skewer questions each on their own
  const how = rep.unanswered.find((u) => /كيف/.test(u.question)); assert.deepEqual([how.count, how.kb], [2, { id: 4, status: "open" }]); assert.equal(rep.unanswered[0], how, "most asked first");
  assert.ok(rep.unanswered.some((u) => /يكفي كام شخص/.test(u.question))); assert.ok(rep.unanswered.some((u) => /كم سيخ/.test(u.question))); assert.ok(rep.unanswered.some((u) => u.why === "fallback:validator"));
  assert.equal(rep.unanswered.some((u) => u.question === "موظف"), false, "asking for a person is not an unanswered question");
  // where they stopped: the canned ad question twice as one line; the thanks; the objection
  assert.equal(rep.dropped.chats, 7); const first = rep.dropped.lines.find((l) => l.last_customer_line === "وش عرض أول طلب؟"); assert.deepEqual([first.count, first.kind], [2, "one_message"]);
  assert.deepEqual(rep.dropped.by_kind, { thanked_and_left: 1, objected: 1, one_message: 5 });
  // the worst replies: the non-answers and the English reply to a deleted message come before the weak closings
  assert.equal(rep.worst_replies.length, 5); assert.ok(rep.worst_replies.slice(0, 3).every((w) => w.reasons.includes("non_answer") || w.reasons.includes("wrong_language")));
  assert.ok(rep.worst_replies.find((w) => /كم سيخ/.test(w.customer)).reasons.includes("left_after"), "the customer objected right after it");
  assert.ok(rep.worst_replies.every((w) => w.reasons_ar.length === w.reasons.length && w.reply !== undefined));
  assert.doesNotMatch(JSON.stringify(rep), /5000000\d|599999999/, "no phone numbers");
  // the business day: 04:00 → 04:00 Riyadh; no day = yesterday's
  assert.deepEqual(businessDay("2026-10-13"), { day: "2026-10-13", from: "2026-10-13T01:00:00.000Z", to: "2026-10-14T01:00:00.000Z" });
  assert.equal(businessDay(null, new Date("2026-10-14T00:30:00Z")).day, "2026-10-12", "03:30 Riyadh on the 14th is still the business day of the 13th: yesterday's is the 12th");
  assert.equal(businessDay(null, new Date("2026-10-14T09:00:00Z")).day, "2026-10-13");
  assert.deepEqual(buildMajedReport({}).funnel.chats, 0);
});
