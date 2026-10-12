/* PS5 — محادثة …٦٨٦٩ (١٣/١٠، ٠١:٢٠ الرياض): «يعني لو طلبي فوق ال٦٠ يصير ١٥ ريال فقط ؟؟» ردّ عليها بوت القواعد بـ«ما فيه طلب مفتوح»؛ وبعد الموقع ماتقالش «أول طلب توصيله مجاني»؛ و«في توصيل؟» خدت طلب الموقع بس.
   من غير أي نداء موديل ولا شبكة.      node --test wa-ps5.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } }), A0 = AR.assistConfig({ mode: "test" });
const W0 = makeWorld({}, {});
const E = (text, over = {}) => { const cls = R.classify({ phone: PHONE, text, type: "text" }, W0.know); return { cls: cls.key, ...AR.assistEligible({ acfg: A0, cfg, phone: PHONE, ev: { text }, cls, d: { act: "reply", key: cls.key }, ...over }) }; };

test("order status is the rules bot's only for a real question about an existing order; a hypothetical or a fee question that contains «طلبي» is the assistant's — in a session and outside one", () => {
  // the real line, and its cousins
  for (const t of ["يعني لو طلبي فوق ال٦٠ يصير ١٥ ريال فقط ؟؟", "كم باقي على طلبي يصير مجاني", "طلبي كم صار المجموع", "طلبي يوصل كم دقيقة لو طلبت الحين", "اذا طلبي اقل من 60 كم التوصيل"])
    for (const s of [true, false]) { const r = E(t, { sessionActive: s, openOrder: true }); assert.equal(r.run, true, `${t} (session ${s}) → ${r.cls} ${r.why}`); }
  // real status questions with an open order (or when we could not check): the rules bot, also mid-conversation
  for (const t of ["وين طلبي", "طلبي وصل؟", "متى يوصل طلبي", "فين الاوردر", "حالة الطلب", "طلبي رقم W1790011111111"]) {
    for (const oo of [true, null]) assert.deepEqual([E(t, { sessionActive: true, openOrder: oo }).run, E(t, { openOrder: oo }).why], [false, "rules:status"], `${t} open=${oo}`);
    assert.equal(E(t, { openOrder: false }).run, true, `${t}: no open order ⇒ the assistant says so (its order_status tool) and offers to order`);
  }
  assert.equal(AR.assistEligible({ acfg: A0, cfg, phone: PHONE, ev: { text: "📦 وين طلبي؟", interactiveId: "bot:status" }, cls: { key: "status", rawIntent: "button:bot:status" }, d: { act: "reply", key: "status" } }).why, "tap", "the status button is always the rules bot's");
});

test("the same trap in the other keys the rules own: what changed and what did not", () => {
  // changed: a cold drink or a temperature question is not a complaint (no past tense, no complaint word, no recent order)
  for (const t of ["ابي بيبسي بارد", "الاكل يوصل حار ولا بارد"]) { assert.equal(E(t).cls, "complaint"); assert.equal(E(t).run, true, t); assert.equal(E(t, { recentOrder: true }).run, false, `${t}: with a recent order it stays a complaint`); }
  for (const t of ["الطلب وصل بارد وناقص", "الاكل جاني بارد", "طلبي امس كان بارد"]) assert.deepEqual([E(t).run, E(t).why], [false, "rules:complaint"], t);
  // changed: «الغي البطاطس من الطلب» while a cart is being built (no paid order) is a cart edit
  assert.equal(E("الغي البطاطس من الطلب", { sessionActive: true }).run, true); assert.equal(E("الغي البطاطس من الطلب", { sessionActive: true, recentOrder: true }).run, false); assert.equal(E("الغي البطاطس من الطلب").run, false, "outside a conversation: the rules bot's cancel flow");
  // already right (PS1–PS4): information questions inside a conversation, a note on the cart
  for (const t of ["الدفع كاش ولا شبكة", "اقدر ادفع عند الاستلام", "تقفلون متى لو طلبت الحين", "شكرا بس ابي اضيف بيبسي", "ابي اغير الطلب اخليه استلام", "كم التوصيل لطلبي"]) assert.equal(E(t, { sessionActive: true }).run, true, t);
  // unchanged on purpose: a website problem, a request for a person, «إيقاف», the previous order
  for (const [t, why] of [["الموقع ما يفتح معي", "rules:problem"], ["ابي اكلم موظف", "rules:human"], ["اتصل عليكم ولا اطلب من هنا", "rules:human"], ["إيقاف", "rules:stop"], ["ابي نفس الطلب بس توصيل", "rules:reorder"]]) assert.equal(E(t, { sessionActive: true }).why, why, t);
});

const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
const use = (name, input) => ({ ok: true, content: [{ type: "tool_use", id: `t_${name}`, name, input }], stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
async function pinTurn(world, steps) { let i = 0; const W = makeWorld({ loc: "in", ...world }, { callModel: async () => steps[i++], onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }) }); W.state.loc = { lat: 21.58, lng: 39.16 };
  const hours = await W.tools.get_hours(); return W.loop.runTurn({ phone: PHONE, text: "📍", lang: "ar", session: AR.newSession(W.now()), acfg: { ...W.acfg, routing: "fast" }, context: AR.buildContext({ first: true, hours, locationShared: true, justShared: true }) }); }

test("after the pin with no basket: a number that has never had a delivery order gets the first-order line, word for word and with its code; one that has gets the fees only", async () => {
  const fresh = await pinTurn({ profile: "new" }, [use("quote_delivery", { total: 0 }), say("نعم نوصل لك 👍\nأول طلب توصيل لك من موقعنا توصيله مجاني للطلبات من 60 ر.س بكود FIRST.\nوالطلب الأقل رسوم توصيله 20 ر.س. وش تحب تطلب؟")]);
  const q = fresh.trace.tools[0].result;
  assert.deepEqual([q.fee, q.first_order.free_delivery_from_total, q.first_order.code, q.first_order.say], [20, 60, "FIRST", "أول طلب توصيل لك من موقعنا توصيله مجاني للطلبات من 60 ر.س بكود FIRST."]);
  assert.match(q.first_order.rule, /start «نعم نوصل لك 👍»/); assert.equal(fresh.ok, true); assert.ok(fresh.text.includes(q.first_order.say));
  // the line without its code is refused (the customer would not know how to get it)
  const noCode = await pinTurn({ profile: "new" }, [use("quote_delivery", { total: 0 }), say("نعم نوصل لك 👍 وأول طلب توصيله مجاني من 60 ر.س. وش تحب تطلب؟"), say("نعم نوصل لك 👍\nأول طلب توصيل لك من موقعنا توصيله مجاني للطلبات من 60 ر.س بكود FIRST.\nوش تحب تطلب؟")]);
  assert.deepEqual(noCode.trace.verdicts.map((v) => v.problems.map((p) => p.type)), [["free_delivery_without_code"], []]);
  // a customer who ordered before: no first-order line; the fees as the quote gives them
  const old = await pinTurn({ profile: "returning" }, [use("quote_delivery", { total: 0 }), say("نعم نوصل لك 👍 رسوم التوصيل 20 ر.س، وتنزل إلى 15 ر.س من طلب 60 ر.س. وش تحب تطلب؟")]);
  assert.equal(old.trace.tools[0].result.first_order, undefined); assert.equal(old.ok, true);
  // switched off
  let i = 0; const steps = [use("quote_delivery", { total: 0 }), say("نعم نوصل لك 👍 رسوم التوصيل 20 ر.س. وش تحب تطلب؟")];
  const W = makeWorld({ profile: "new", loc: "in" }, { callModel: async () => steps[i++], onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }) }); W.state.loc = { lat: 21.58, lng: 39.16 };
  const off = await W.loop.runTurn({ phone: PHONE, text: "📍", lang: "ar", session: AR.newSession(W.now()), acfg: { ...W.acfg, routing: "fast", firstLead: false }, context: AR.buildContext({ first: true, hours: await W.tools.get_hours(), locationShared: true, justShared: true }) });
  assert.equal(off.trace.tools[0].result.first_order, undefined);
  assert.equal(AR.assistConfig({}).firstLead, true); assert.ok(R.schemaFor(cfg).some((r) => r.key === "assist.firstLead")); assert.doesNotMatch(R.TEXTS.first_lead.ar.replace(/\{[a-z_]+\}/g, ""), /\d/);
});

test("«في توصيل؟» without a pin: the tool and the prompt both say «yes, inside Jeddah» first and the pin request in the same message, and no fee before the pin", async () => {
  const W = makeWorld({ profile: "new" }, {});
  const r = await W.tools.quote_delivery(PHONE, { total: 0 });
  assert.equal(r.error, "need_location"); assert.match(r.hint, /«نعم نوصل داخل جدة 👍»/); assert.match(r.hint, /State no fee before the pin/);
  assert.match(AR.SYSTEM_PROMPT, /first that yes, we deliver inside Jeddah \(«نعم نوصل داخل جدة 👍»\), then ask them to share their location/);
  assert.match(AR.SYSTEM_PROMPT, /starting with «نعم نوصل لك 👍»; if the result has "first_order", lead with its "say" text/);
  assert.ok(AR.SYSTEM_PROMPT.length < 24000);
});
