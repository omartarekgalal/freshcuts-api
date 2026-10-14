/* SB4 — قرار عمر ١٤/١٠: «الثلث يكفي شخص تقريباً» مسموحة في المحادثة الفردية، لما العميل يسأل بس، لكل المشاوي بالوزن ومنها المشكل المخصوص، بأرقام ملف المعرفة.
   السطور من محادثات ١٣/١٠ بالحرف. من غير أي نداء موديل.      node --test wa-sb4.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as AR from "./waassistrun.js";
import * as A from "./waassist.js";
import { briefFieldProblem, briefOf } from "./wabrief.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
async function turn1(text, replies, acfg = {}, world = {}) {
  let i = 0; const W = makeWorld({ profile: "new", ...world }, { callModel: async () => replies[i++] || say("تمام."), onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }), acfg });
  return W.loop.runTurn({ phone: PHONE, text, lang: "ar", session: AR.newSession(W.now()), acfg: { ...W.acfg, routing: "strong" }, context: AR.buildContext({ first: true, hours: await W.tools.get_hours(), boxes: W.boxes }) });
}
const Q1 = "التلت والنص والكيلوا مكون من اية ويكفي كام شخص", Q2 = "بهذا المبلغ كم سيخ سوف احصل عليه !!";
const PRICES = "مشكل مخصوص: تشكيلة من مشاوينا على الفحم، تُباع بالوزن وتُقدَّم مع السلطة والطحينة والخبز: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س.";
const GOOD = `${PRICES}\nالثلث يكفي شخص تقريباً، والنص شخصين، والكيلو ٣–٤ أشخاص.\nكم شخص أنتم؟`;

test("the guidance numbers come from the brief field «المشاوي بالوزن», not from code; the questions of 13/10 are recognised", () => {
  const v = briefOf({}).values.grill_weight;
  assert.deepEqual(A.servingGuide(v), { third: [1, 1], half: [2, 2], kilo: [3, 4] });
  assert.deepEqual(A.servingGuide("تقريباً: الثلث يكفي شخص، والكيلو يكفي ٤–٥ أشخاص"), { third: [1, 1], kilo: [4, 5] }, "the owner changes the field ⇒ the numbers change");
  assert.equal(A.servingAsked(Q1), true);
  assert.equal(A.servingAsked(Q2), false, "skewers are not a «how many people» question");
  assert.equal(A.servingAsked("المشكل يكفي كم شخص؟"), true); assert.equal(A.servingAsked("كم شخص يكفي الكيلو"), true);
  assert.equal(briefFieldProblem("grill_weight", v), null, "the default field passes its own review");
  assert.match(briefFieldProblem("mashakel_line", "مشكل مخصوص: الكيلو يكفي ٤ أشخاص") || "", /عدد أشخاص/, "the always-sent mashakel line still may not carry a serving count");
});

test("«التلت والنص والكيلوا مكون من اية ويكفي كام شخص» (13/10): the guidance is in the context and a reply with the brief's numbers goes out first time", async () => {
  const r = await turn1(Q1, [say(GOOD)]);
  assert.equal(r.ok, true, JSON.stringify(r.trace.verdicts.map((x) => x.problems)));
  assert.equal(r.trace.verdicts.length, 1);
  const ctx = r.session.messages[0].content.map((b) => b.text || "").join("\n");
  assert.match(ctx, /serving_guidance/); assert.match(ctx, /ثلث كيلو ≈ 1 · نصف كيلو ≈ 2 · كيلو ≈ 3–4/);
  const bad = await turn1(Q1, [say(`${PRICES}\nالكيلو يكفي ٦ أشخاص.\nكم شخص أنتم؟`), say(GOOD)]);
  assert.equal(bad.ok, true); assert.equal(bad.trace.verdicts[0].problems.some((p) => p.type === "serving_count"), true, "a number outside the brief is refused, then corrected");
  const pieces = await turn1(Q1, [say(`${PRICES}\nالكيلو فيه 12 سيخ تقريباً. كم شخص أنتم؟`), say(GOOD)]);
  assert.equal(pieces.trace.verdicts[0].problems.some((p) => p.type === "serving_count"), true, "pieces / skewers of the mashakel: still never");
});

test("«بهذا المبلغ كم سيخ سوف احصل عليه» (13/10): no skewer count, and no serving count volunteered — «sold by weight, how many are you?» passes", async () => {
  const sk = await turn1(Q2, [say(`${PRICES}\nالكيلو تقريباً 12 سيخ مشكل. كم شخص أنتم؟`), say(`${PRICES}\nيُباع بالوزن مو بالسيخ. كم شخص أنتم؟`)]);
  assert.equal(sk.trace.verdicts[0].problems.some((p) => p.type === "serving_count"), true);
  assert.equal(sk.ok, true); assert.match(sk.text, /يُباع بالوزن مو بالسيخ/);
  const vol = await turn1(Q2, [say(`${PRICES}\nالثلث يكفي شخص تقريباً. كم شخص أنتم؟`), say(`${PRICES}\nيُباع بالوزن مو بالسيخ. كم شخص أنتم؟`)]);
  assert.equal(vol.trace.verdicts[0].problems.some((p) => p.type === "serving_unasked"), true, "not asked ⇒ not said");
  const ctx = vol.session.messages[0].content.map((b) => b.text || "").join("\n");
  assert.doesNotMatch(ctx, /serving_guidance/);
});

test("setting: assist.servingGuidance «asked» (default) | «never» (the old rule: no serving count for the mashakel at all)", async () => {
  assert.equal(AR.assistConfig({}).servingGuidance, "asked"); assert.equal(AR.assistConfig({ servingGuidance: "x" }).servingGuidance, "asked");
  assert.deepEqual(AR.ASSIST_SCHEMA["assist.servingGuidance"].options, ["asked", "never"]);
  assert.equal(AR.assistFromBody({ servingGuidance: "always" }, {}).ok, false);
  const never = await turn1(Q1, [say(GOOD), say(`${PRICES}\nكم شخص أنتم؟`)], { servingGuidance: "never" });
  assert.equal(never.trace.verdicts[0].problems.some((p) => p.type === "serving_count"), true);
  assert.doesNotMatch(never.session.messages[0].content.map((b) => b.text || "").join("\n"), /serving_guidance/);
  assert.match(AR.SYSTEM_PROMPT, /never volunteered; only if the customer asks/);
});
