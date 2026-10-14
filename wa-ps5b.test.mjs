/* PS5 (part 3) — عمر ١٣/١٠: «المشاوي عندنا نوعين (وجبات معاها رز، وبالوزن) — لازم ماجد يبقى فاهم هو بيبيع إيه ويخلّي العميل يختار»؛ ومن أول محادثة طلب حقيقية (…٦٨٦٩):
   عرض البوكس اتكرر في ٣ ردود، والردود طالت بشرح محدش طلبه، و«ممكن تصورلي الصوص؟». من غير أي نداء موديل ولا شبكة.      node --test wa-ps5b.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "./waassist.js";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } });
const W0 = makeWorld({}, {});
const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (...u) => ({ ok: true, content: u.map(([name, input], i) => ({ type: "tool_use", id: `u${i}${name}`, name, input })), stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
function chat(world, steps, acfg = {}) { let i = 0; const W = makeWorld(world, { callModel: async () => steps[i++], onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg });
  let session = null; const turn = async (text) => { const hours = await W.tools.get_hours(); const fresh = !session; if (fresh) session = AR.newSession(W.now());
    const r = await W.loop.runTurn({ phone: PHONE, text, lang: "ar", session, acfg: { ...W.acfg, routing: "strong", salesBrain: false }, context: AR.buildContext({ first: fresh, hours, boxes: W.boxes }) }); if (r.ok) session = r.session; return r; };
  return { W, turn }; }

test("the two grill families come from the live menu: a meal (as its description says) and by weight; a grill named without saying which gets ONE question with both and two buttons", async () => {
  const fam = A.grillFamilies(W0.menu);
  assert.deepEqual([...new Set([...fam.values()].map((p) => `${p.meal.name} ↔ ${p.weight.name}`))].sort(), ["وجبة شيش طاووق ↔ شيش طاووق مشوي بالوزن", "وجبة صدور مشوية ↔ صدور مشوية بالوزن", "وجبة طرب ↔ طرب مشوي بالوزن", "وجبة كفتة ↔ كفتة مشوية بالوزن"]);
  assert.equal(fam.get("103"), undefined, "مشكل مخصوص: by weight only"); assert.equal(fam.get("18"), undefined, "وجبة ميكس جريل: a meal only");
  const r = await W0.tools.search_menu(PHONE, { query: "شيش طاووق" });
  const meal = r.results.find((x) => x.id === "90"), bw = r.results.find((x) => x.id === "114");
  assert.deepEqual([meal.also_as.by_weight.id, meal.also_as.by_weight.weights.map((w) => w.price), meal.description], ["114", [37, 55, 110], "وجبة شيش طاووق مشوية تُقدَّم مع الأرز والسلطة والطحينة"], "what the meal comes with is read from the menu, not assumed");
  assert.deepEqual([bw.also_as.meal.id, bw.also_as.meal.price], ["90", 27]);
  // in the loop: «شيش طاووق مشوي على الفحم» (on 13/10 it silently became the meal)
  const a = chat({}, [use(["search_menu", { query: "شيش طاووق" }]), say("تبيها وجبة شيش طاووق مع الأرز والسلطة والطحينة بـ 27 ر.س، ولا بالوزن (ثلث كيلو: 37 ر.س · نصف كيلو: 55 ر.س · كيلو: 110 ر.س)؟")]);
  const t = await a.turn("شيش طاووق مشوي على الفحم");
  assert.equal(t.ok, true); assert.match(t.trace.tools[0].result.ask_which.rule, /Never choose for them/); assert.deepEqual(t.buttons, { kind: "family", meal: { id: "90" }, weight: { id: "114" } });
  assert.deepEqual(R.assistExtras(cfg, "ar", t).buttons, [{ id: "as:meal:90", title: "وجبة" }, { id: "as:weight:114", title: "بالوزن" }]);
  // the customer said which: no question, no buttons
  for (const said of ["نص كيلو كفتة", "ابي وجبة كفتة", "كيلو شيش طاووق"]) { const b = chat({}, [use(["search_menu", { query: said }]), say("تمام.")]);
    const x = await b.turn(said); assert.equal(x.trace.tools[0].result.ask_which, undefined, said); assert.equal(x.buttons, null, said); }
  const off = chat({}, [use(["search_menu", { query: "كفتة" }]), say("تمام.")], { grillFamilies: false });
  assert.equal((await off.turn("كفتة")).trace.tools[0].result.results.some((x) => x.also_as), false, "switched off: the search is as before");
  // the rules bot's card for such a dish: both ways and two buttons; a message that says which, or a dish with no twin, gets the ordinary card
  const data = { settings: {}, menu: W0.menu, now: new Date(), links: { [cfg.links.organic]: true, "wab-menu": true } };
  const card = (asked, id = "17") => R.buildReply("item", { cfg, lang: "ar", data, referral: null, factual: false, arg: id, asked });
  const two = card("كفتة");
  assert.equal(two.body, "*وجبة كفتة* — 24 ر.س\nوجبة كفتة مشوية تُقدَّم مع الأرز والسلطة والطحينة\n*كفتة مشوية بالوزن* — ثلث كيلو: 40 ر.س · نصف كيلو: 60 ر.س · كيلو: 120 ر.س\nتبيها وجبة ولا بالوزن؟");
  assert.deepEqual(two.buttons, [{ id: "item:17", title: "وجبة" }, { id: "item:91", title: "بالوزن" }]);
  assert.ok(card("وجبة كفتة").cta, "said «وجبة»: the dish card"); assert.ok(card("بالوزن", "91").cta); assert.ok(card("مشكل مخصوص", "103").cta, "no family: the dish card");
  // rice is the pairing of a by-weight grill only — never offered on a meal (the meal already comes with rice)
  assert.deepEqual(A.PAIRING_DEFAULT.filter((p) => /أرز/.test(p.item || "")).map((p) => p.when), ["grill_weight"]);
});

test("an offer is made once per conversation: a second preview carries no suggestion and the model repeating it from memory is refused; while the customer dictates, the acknowledgement is one short line", async () => {
  const long = "وبالمناسبة هذا شرح طويل عن طريقة تسجيل الملاحظات في السلة وليش الصوص مو إضافة مسعّرة. ".repeat(4);
  const a = chat({}, [use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }] }]), say("كريب زنجر سوبريم بـ 25 ر.س. وبـ 29 ر.س يصير بوكس الكريب الفردي مع جانبي ومشروب. أحوّله بوكس؟"),
    use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }, { id: "82", qty: 2 }] }]), say("تمام، أضفت مشروبات غازية ×2 ✅ المجموع 31 ر.س. وبـ 29 ر.س يصير بوكس الكريب الفردي. أحوّله بوكس؟"), say("تمام، أضفت مشروبات غازية ×2 ✅ المجموع 31 ر.س. شي ثاني؟"),
    use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }, { id: "82", qty: 2 }, { id: "79", qty: 1 }] }]), say(`تمام، أضفت بطاطس محمرة ✅ ${long}المجموع 37 ر.س. شي ثاني؟`), say("تمام، أضفت بطاطس محمرة ✅ المجموع 37 ر.س. شي ثاني؟")]);
  const t1 = await a.turn("ابي كريب زنجر سوبريم"); assert.equal(t1.trace.tools[0].result.suggestion.kind, "pair");
  const t2 = await a.turn("والبيبسي اثنين");
  assert.equal(t2.trace.tools[0].result.suggestion, null, "ignored once ⇒ dropped, and no other upgrade"); assert.match(t2.trace.tools[0].result.reply_rule, /ONE short line/);
  assert.deepEqual(t2.trace.verdicts.map((v) => v.problems.map((p) => p.type)), [["repeated_offer"], []]); assert.equal(t2.text, "تمام، أضفت مشروبات غازية ×2 ✅ المجموع 31 ر.س. شي ثاني؟");
  const t3 = await a.turn("وبطاطس");
  assert.deepEqual(t3.trace.verdicts.map((v) => v.problems.map((p) => p.type)), [["ack_too_long"], []]); assert.equal(t3.text, "تمام، أضفت بطاطس محمرة ✅ المجموع 37 ر.س. شي ثاني؟");
  // the customer comes back to the offer himself: answering about it is not a repeat
  const b = chat({}, [use(["preview_cart", { option: "pickup", items: [{ id: "8", qty: 1 }] }]), say("كريب زنجر سوبريم بـ 25 ر.س. وبـ 29 ر.س يصير بوكس الكريب الفردي. أحوّله بوكس؟"), say("بوكس الكريب الفردي بـ 29 ر.س فيه الكريب مع جانبي ومشروب. أحوّله بوكس؟")]);
  await b.turn("ابي كريب زنجر سوبريم"); assert.equal((await b.turn("وش فيه بوكس الكريب الفردي؟")).ok, true);
  assert.deepEqual([AR.assistConfig({}).oneOfferPerChat, AR.assistConfig({}).ackMaxChars, AR.assistConfig({}).grillFamilies, AR.assistConfig({}).imageBurstSec], [true, 260, true, 6]);
});

test("«ممكن تصورلي الصوص؟»: the assistant cannot take photos — the tool says what is true; a note for the kitchen is recorded as written and never promised", async () => {
  const T = { phone: PHONE, lang: "ar", session: AR.newSession(W0.now()), trace: { suggestions: [], unanswered: [] }, acfg: W0.acfg, factSay: [], kbSay: [] };
  const sauce = await W0.loop.exec("dish_photo", {}, T);
  assert.deepEqual([sauce.ok, sauce.has_menu_photo], [true, false]); assert.match(sauce.rule, /cannot take or send photos/); assert.match(sauce.rule, /«موظف»/); assert.equal(T.photoItem, undefined);
  const withPhoto = W0.menu.items.find((i) => i.image);
  if (withPhoto) { const p = await W0.loop.exec("dish_photo", { id: withPhoto.id }, T); assert.equal(p.has_menu_photo, true); assert.equal(T.photoItem, String(withPhoto.id)); }
  assert.match(AR.SYSTEM_PROMPT, /You cannot take, send or forward photos/); assert.match(AR.SYSTEM_PROMPT, /«جزء مقمر وجزء مستوي عادي»/); assert.match(AR.SYSTEM_PROMPT, /never promise the result; say that you wrote it as a note for the kitchen/);
  const c = await W0.tools.build_cart(PHONE, { option: "pickup", items: [{ id: "16", qty: 1, note: "جزء مقمر وجزء مستوي عادي" }] }, { save: false });
  assert.equal(c.lines[0].note, "جزء مقمر وجزء مستوي عادي");
  assert.ok(AR.checkReply("ما أقدر أصوّر، بس كتبتها ملاحظة للمطبخ: جزء مقمر وجزء مستوي عادي.", { facts: [], lang: "ar", recentCustomer: "والطرب ابغا جزء منه مقمر وجزء مستوي عادي" }).ok);
});
