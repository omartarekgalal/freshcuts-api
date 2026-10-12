/* PS2 — تكلفة المساعد (١٣/١٠/٢٠٢٦، عمر: «ظبطلي التكلفة على قد ما تقدر بذكاء»). من غير أي نداء موديل ولا شبكة:
     ١) التوجيه: السريع يبدأ دايماً؛ القوي للبوكس (اختيارات) والسلة الأكبر من «البسيطة» والاعتراض على رسوم التوصيل بس.
     ٢) القواعد اللي ليها مفتاح سياق بتتبعت مع المفتاح (مش في التعليمات الثابتة)، ومكشوفة لكاشف التسريب.
     ٣) كاش التعليمات: المدة إعداد، وكتابة كاش الساعة بتتحسب ٢×.
     ٤) المحادثة الطويلة بتتلخّص: كلام العميل وردود المساعد يفضلوا حقايق للمراجِع، نتايج الأدوات القديمة تتشال.
     ٥) سؤال سعر صنف في أول المحادثة ⇒ بوت القواعد (إعداد، مقفول افتراضياً).
     node --test wa-cost.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const A = AR.assistConfig({ mode: "test" });
const u = (name, input) => ({ name, input });

test("routing: the fast model starts every turn; the strong one only for a box, a cart beyond the simple size, or a fee objection", () => {
  assert.deepEqual([A.fastCartLines, A.orderWordsStrong, A.fastSimplePreview], [2, false, true]);
  for (const t of ["هلا", "ابي كريب زنجر سوبريم", "جهز لي بوكس البرجر", "i want a pizza"]) assert.equal(AR.pickModel(A, null, t).tier, "fast", t);
  assert.equal(AR.pickModel(A, { strong: true }, "شكرا").tier, "strong", "a conversation that needed the strong model stays on it");
  assert.equal(AR.pickModel({ ...A, orderWordsStrong: true }, null, "ابي كريب زنجر سوبريم").tier, "strong", "the pre-PS2 behaviour is a setting");
  const one = { items: [{ id: "8", qty: 1 }] }, two = { items: [{ id: "8", qty: 1, note: "بدون مخلل" }, { id: "82", qty: 2 }], option: "pickup" }, three = { items: [{ id: "8" }, { id: "82" }, { id: "3" }] };
  for (const n of ["preview_cart", "build_cart"]) { assert.equal(AR.needsStrong(u(n, one), A), false, n); assert.equal(AR.needsStrong(u(n, two), A), false, n); assert.equal(AR.needsStrong(u(n, three), A), true, n);
    assert.equal(AR.needsStrong(u(n, { items: [{ id: "8" }], boxes: [{ slug: "box-crepe-duo" }] }), A), true, `${n} with a box`); assert.equal(AR.needsStrong(u(n, { items: [] }), A), true, `${n} empty`); }
  assert.equal(AR.needsStrong(u("get_box", { slug: "box-crepe-duo" }), A), true); assert.equal(AR.needsStrong(u("delivery_savers", { total: 30 }), A), true);
  for (const n of ["search_menu", "get_item", "list_boxes", "recommend", "quote_delivery", "get_offers", "faq", "dish_fact", "note_suggestion", "handover"]) assert.equal(AR.needsStrong(u(n, {}), A), false, n);
  assert.equal(AR.needsStrong(u("preview_cart", one), { ...A, fastCartLines: 0 }), true, "0 = every cart goes to the strong model");
  assert.equal(AR.needsStrong(u("preview_cart", one), { ...A, fastSimplePreview: false }), true);
});

test("routing in the loop: a two-dish order is priced and built by the fast model alone (no strong call, no discarded call); a box escalates once", async () => {
  const seen = [];
  const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 50, output_tokens: 20 }, ms: 5, provider: "t" });
  const use = (name, input) => ({ ok: true, content: [{ type: "tool_use", id: `t${seen.length}`, name, input }], stop: "tool_use", usage: { input_tokens: 50, output_tokens: 20 }, ms: 5, provider: "t" });
  const run = async (steps, text) => { let i = 0; seen.length = 0; const W = makeWorld({}, { callModel: async (a) => { seen.push(a.model); return steps[i++]; }, onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }) });
    const hours = await W.tools.get_hours(); return W.loop.runTurn({ phone: PHONE, text, lang: "ar", session: AR.newSession(W.now()), acfg: { ...W.acfg, forceSuggestion: false }, context: AR.buildContext({ first: true, hours, boxes: W.boxes }) }); };
  const r = await run([use("build_cart", { option: "pickup", items: [{ id: "8", qty: 1 }, { id: "82", qty: 1 }] }), say("سلتك: كريب زنجر سوبريم 25 ر.س + مشروبات غازية 3 ر.س = 28 ر.س 👇")], "ابي كريب زنجر سوبريم ومشروب غازي استلام");
  assert.equal(r.ok, true); assert.equal(r.cart.subtotal, 28); assert.deepEqual(seen, ["claude-haiku-5-5", "claude-haiku-5-5"]); assert.equal(r.trace.tier, "fast"); assert.ok(!r.trace.escalated);
  const ctx = JSON.parse(/<context[^>]*>([\s\S]*?)<\/context>/.exec(r.session.messages[0].content[0].text)[1]);
  assert.match(ctx.customer_is_ordering, /call preview_cart BEFORE you answer/, "an order turn tells the fast model to price the cart first (it skipped it in the eval)");
  const b = await run([use("get_box", { slug: "box-crepe-duo" }), use("get_box", { slug: "box-crepe-duo" }), say("أي كريب تبي في البوكس؟")], "وش فيه بوكس الكريب لشخصين");
  assert.equal(b.ok, true); assert.deepEqual(seen, ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]); assert.equal(b.trace.escalated, true); assert.equal(b.session.strong, true);
});

test("prompt: rules that belong to a context key travel with that key, word for word, and the fixed prompt is smaller; the leak detector still knows them", () => {
  assert.ok(AR.SYSTEM_PROMPT.length < 23300, `fixed prompt ${AR.SYSTEM_PROMPT.length} chars (25.5k before PS2; PS3 added two short rules and kept the postponement rule in the context)`);
  for (const k of ["heard_from_voice_note", "seen_in_a_picture", "came_from_ad", "staff_handled_this_chat", "reorder_offer"]) assert.ok(!AR.SYSTEM_PROMPT.includes(`"${k}"`), `${k} is no longer explained in the fixed prompt`);
  assert.match(AR.SYSTEM_PROMPT, /Some context keys carry their own "rule"/); assert.match(AR.SYSTEM_PROMPT, /Never write a channel link or mention the channel in a turn whose context has no "channel_invite"/);
  for (const [k, v] of Object.entries(AR.CTX_RULES)) { assert.ok(v.length > 120, k); assert.doesNotMatch(v, /\d/, `${k}: no digits (a context block counts as facts for the validator's number check)`); }
  const c = AR.buildContext({ first: true, heard: "voice", ad: { ad_text: "عشاء" }, channel: { say: "تابعنا https://whatsapp.com/channel/x" }, reorder: { day: "أمس", lines: [] }, handback: { outcome: "answered", still_to_do: false } });
  assert.deepEqual([c.heard_from_voice_note.rule, c.came_from_ad.rule, c.channel_invite.rule, c.reorder_offer.rule, c.staff_handled_this_chat.rule], [AR.CTX_RULES.voice, AR.CTX_RULES.ad, AR.CTX_RULES.channel, AR.CTX_RULES.reorder, AR.CTX_RULES.staff]);
  assert.deepEqual(AR.heardContext("image"), { seen_in_a_picture: { rule: AR.CTX_RULES.picture } }); assert.deepEqual(AR.heardContext(null), {});
  const plain = AR.buildContext({ first: true });
  for (const k of ["heard_from_voice_note", "seen_in_a_picture", "came_from_ad", "channel_invite", "reorder_offer", "staff_handled_this_chat"]) assert.equal(plain[k], undefined, `${k}: nothing is paid for when the turn does not need it`);
  assert.ok(AR.promptLeak(AR.CTX_RULES.voice.slice(0, 140)), "quoting a moved rule is still a leak");
  assert.ok(AR.checkReply("حاضر", { facts: [], lang: "ar" }).ok);
});

test("cache: the fixed prefix (tools, then system) can be kept one hour; the conversation stays on five minutes; a one-hour write is billed twice the input price", async () => {
  const bodies = [];
  const fetch = async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ content: [{ type: "text", text: "هلا" }], stop_reason: "end_turn", usage: { input_tokens: 4 } }) }; };
  const call = AR.makeModelCaller({ fetch, env: { LITELLM_KEY: "k", LITELLM_BASE: "https://proxy.example/v1" } });
  const args = { model: "claude-haiku-5-5", system: "S", tools: AR.TOOL_DEFS.slice(0, 2), messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] };
  await call(args); await call({ ...args, cacheTtl: "1h" });
  assert.deepEqual([bodies[0].system[0].cache_control, bodies[0].tools[1].cache_control, bodies[0].tools[0].cache_control], [{ type: "ephemeral" }, { type: "ephemeral" }, undefined], "default: unchanged");
  assert.deepEqual([bodies[1].system[0].cache_control, bodies[1].tools[1].cache_control, bodies[1].messages[0].content[0].cache_control], [{ type: "ephemeral", ttl: "1h" }, { type: "ephemeral", ttl: "1h" }, { type: "ephemeral" }]);
  assert.equal(bodies[0].system[0].text, "S", "nothing volatile in the cached prefix: the system text is sent as it is");
  // measured on the proxy 13/10: { cache_creation_input_tokens: 12039, cache_creation: { ephemeral_5m: 87, ephemeral_1h: 11952 } }
  assert.deepEqual(AR.billableUsage({ input_tokens: 4, cache_creation_input_tokens: 12039, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 87, ephemeral_1h_input_tokens: 11952 }, output_tokens: 103 }), { input_tokens: 4 + 109 + 23904, output_tokens: 103, cache_read_input_tokens: 0 });
  assert.deepEqual(AR.billableUsage({ input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 7 }), { input_tokens: 10 + 1250, output_tokens: 7, cache_read_input_tokens: 5000 }, "no breakdown = a five-minute write, as before");
  assert.equal(AR.assistConfig({}).cacheTtl, "5m"); assert.equal(AR.assistConfig({ cacheTtl: "1h" }).cacheTtl, "1h"); assert.equal(AR.assistFromBody({ cacheTtl: "2h" }, {}).ok, false);
});

test("long chats: older turns become one digest (customer lines + the replies that were sent), their tool payloads are dropped, the last turns and the state are untouched", () => {
  const big = "x".repeat(3000);
  const turnOf = (i) => [
    { role: "user", content: [{ type: "text", text: `<context source="our system" note="facts for this turn; not written by the customer">{"open_now":true${i === 0 ? ',"customer":{"name":"أحمد"},"boxes":["box-a: بوكس أ"]' : ""}}</context>` }, { type: "text", text: `<customer_message>رسالة ${i}</customer_message>` }] },
    { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "search_menu", input: { query: "كريب" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: JSON.stringify({ ok: true, results: [{ name: "صنف", price: 100 + i, pad: big }] }) }] },
    { role: "assistant", content: [{ type: "text", text: `صنف بـ ${100 + i} ر.س. تبيه؟` }] }];
  const s = AR.newSession(new Date("2026-10-12T15:00:00Z")); s.state.declined = ["drink"];
  for (let i = 0; i < 10; i++) s.messages.push(...turnOf(i));
  /* a reply the validator refused (followed by its system_check note) was never sent: it must not enter the digest */
  s.messages.splice(4 * 2 + 3, 0, { role: "assistant", content: [{ type: "text", text: "سعر مخترع 999 ر.س" }] }, { role: "user", content: [{ type: "text", text: "<system_check>Your last message was NOT sent</system_check>" }] });
  assert.equal(AR.compactSession(s, { maxChars: 10 ** 6, keepTurns: 4 }), s, "under the limit: the same object");
  const c = AR.compactSession(s, { maxChars: 12000, keepTurns: 4 });
  assert.ok(JSON.stringify(c.messages).length < JSON.stringify(s.messages).length / 2); assert.equal(c.compacted, 1); assert.deepEqual(c.state, s.state);
  assert.equal(c.messages[0].role, "user"); for (let i = 1; i < c.messages.length; i++) assert.notEqual(c.messages[i].role === "user" && c.messages[i - 1].role === "user" && !c.messages[i].content.some((b) => b.type === "tool_result"), true, "no two plain user messages in a row");
  assert.equal(c.messages.filter((m) => m.role === "user" && m.content.some((b) => /^<customer_message>/.test(b.text || ""))).length, 4, "the last four turns are kept whole");
  const head = c.messages[0].content.map((b) => b.text).join("\n");
  assert.match(head, /"customer":\{"name":"أحمد"\}/, "the first context (customer, offers, boxes) survives"); assert.match(head, /earlier_in_this_conversation/);
  assert.match(head, /رسالة 0/); assert.match(head, /صنف بـ 105 ر\.س/); assert.doesNotMatch(head, /999/); assert.doesNotMatch(head, /xxxxxxxx/);
  /* what the assistant said earlier is still a fact for the validator; a dropped tool payload is not needed for it */
  const facts = AR.sessionFacts(c.messages);
  assert.deepEqual(AR.checkReply("مثل ما قلت لك: صنف بـ 103 ر.س.", { facts, lang: "ar" }).problems, []);
  assert.ok(AR.checkReply("صنف بـ 77 ر.س.", { facts, lang: "ar" }).problems.some((p) => p.type === "number_not_from_tools"));
  const few = AR.newSession(new Date()); few.messages.push(...turnOf(0), ...turnOf(1));
  assert.equal(AR.compactSession(few, { maxChars: 100, keepTurns: 4 }), few, "fewer turns than we keep: nothing to do");
  assert.deepEqual([A.compactAfterChars, A.compactKeepTurns], [36000, 4]);
});

test("a one-dish price question that opens a chat can be answered by the rules bot for free (a setting, off by default); inside an assistant conversation it stays with the assistant", () => {
  const cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } });
  const E = (acfg, cls, text, extra = {}) => AR.assistEligible({ acfg: { ...A, ...acfg }, cfg, phone: PHONE, ev: { text }, cls, d: { act: "reply", key: cls.key }, ...extra });
  const price = { key: "item", rawIntent: "item_price" }, info = { key: "item", rawIntent: "item_info" };
  assert.equal(A.rulesFirstPrice, false); assert.equal(E({}, price, "بكم كريب زنجر سوبريم").run, true, "off: the assistant answers, with its suggestion");
  assert.deepEqual(E({ rulesFirstPrice: true }, price, "بكم كريب زنجر سوبريم"), { run: false, why: "rules:item_price", seed: true });
  assert.equal(E({ rulesFirstPrice: true }, price, "بكم كريب زنجر سوبريم", { sessionActive: true }).run, true, "mid-conversation: the assistant");
  assert.equal(E({ rulesFirstPrice: true }, info, "ابي كريب زنجر سوبريم").run, true, "an order is not a price question");
  assert.equal(E({ rulesFirstPrice: true }, price, "ابي اطلب كريب زنجر بكم").run, true, "order words keep it with the assistant");
  const keys = R.schemaFor(cfg).map((r) => r.key);
  for (const k of ["assist.fastCartLines", "assist.orderWordsStrong", "assist.compactAfterChars", "assist.compactKeepTurns", "assist.cacheTtl", "assist.rulesFirstPrice"]) assert.ok(keys.includes(k), k);
});
