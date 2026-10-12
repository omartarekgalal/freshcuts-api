/* PS3 — تصحيحات عمر على أول محادثة حقيقية مع ماجد (١٣/١٠/٢٠٢٦)، من غير أي نداء موديل ولا شبكة:
     ١) «مش حابب نقول معندناش إلا لو كان سأل»: سطور مشروطة في إجابات الأسئلة الشائعة + المراجِع بيرفض نفي ماحدش سأل عنه.
     ٢) «في المكان» = «فين المكان»، وباقي صيغ «انتو فين» ⇒ الموقع.
     ٣) التأجيل: خطة التذكير (جوّه نافذة الـ٢٤ ساعة، مش في ساعات الهدوء ولا والمطعم مقفول)، ووعد بتذكير من غير جدولة مرفوض.
   (زر الخريطة، الجدولة، الإرسال والإلغاء: في wabotrun.test.mjs.)      node --test wa-ps3.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import * as AR from "./waassistrun.js";
import * as R from "./wabotrun.js";
import { normalize } from "./wabot.js";
import { makeWorld, PHONE } from "./eval/world.mjs";

test("FAQ answers: a conditional line is sent only when the customer's words contain one of its keywords; a broken marker is never shown", () => {
  const ar = "نعم، عندنا جلسات داخلية وفيها قسم للعائلات، والجلوس متاح طوال ساعات العمل.\n[لو سأل: خارجي، خارجية، برا، outdoor] لا توجد جلسات خارجية.";
  assert.equal(R.faqAnswer(ar, "في المكان"), "نعم، عندنا جلسات داخلية وفيها قسم للعائلات، والجلوس متاح طوال ساعات العمل.");
  assert.equal(R.faqAnswer(ar, "عندكم جلسات؟"), "نعم، عندنا جلسات داخلية وفيها قسم للعائلات، والجلوس متاح طوال ساعات العمل.");
  for (const q of ["عندكم جلسات خارجية؟", "فيه قعدة برا؟", "جلسات خارجيه", "outdoor seating?"]) assert.match(R.faqAnswer(ar, q), /\nلا توجد جلسات خارجية\.$/, q);
  assert.equal(R.faqAnswer("Yes, indoor seating.\n[if asked: outdoor, terrace] There is no outdoor seating.", "do you have a TERRACE"), "Yes, indoor seating.\nThere is no outdoor seating.");
  assert.equal(R.faqAnswer("سطر أول\n[ملاحظة داخلية\nسطر ثاني\n[لو سأل] من غير كلمات", "أي شي"), "سطر أول\nسطر ثاني", "a line that starts with a bracket and is not a valid condition is dropped, never sent");
  assert.equal(R.faqAnswer("إجابة عادية من غير شروط", ""), "إجابة عادية من غير شروط");
  // the rules bot's FAQ reply uses it with the customer's own message
  const cfg = R.botConfig({ waBot: { mode: "live", faq: { dine_in: { ar } } } });
  const body = (asked) => R.buildReply("faq", { cfg, lang: "ar", data: { settings: {} }, referral: null, factual: false, arg: "dine_in", asked }).body;
  assert.doesNotMatch(body("عندكم جلسات"), /خارجية/); assert.match(body("عندكم جلسات خارجية"), /لا توجد جلسات خارجية/);
});

test("the validator refuses a negative nobody asked for, and lets through the ones that answer the customer", () => {
  const C = (t, cust) => AR.checkReply(t, { facts: [], lang: "ar", recentCustomer: cust, turnText: cust }).problems.map((p) => p.type);
  assert.deepEqual(C("نعم، عندنا جلسات داخلية وقسم للعائلات. لا توجد جلسات خارجية.", "في المكان"), ["unsolicited_negative"]);
  assert.deepEqual(C("فرعنا في حي السلامة. ما عندنا فروع ثانية.", "فين المكان"), ["unsolicited_negative"]);
  for (const [t, cust] of [["لا توجد جلسات خارجية، عندنا جلسات داخلية.", "عندكم جلسات خارجية؟"], ["ما عندنا ستيك، لكن عندنا مشاوي على الفحم.", "ابي ستيك"], ["ما عندي معلومة مؤكدة عن هذا. اكتب «موظف» ويرد عليك الفريق.", "تطلعون الطلب للسيارة"],
    ["ما عندنا خصم حالياً.", "ابي كريب"], ["ما عندنا توصيل خارج جدة.", "توصلون مكة؟"], ["تمام. توصيل ولا استلام؟", "لا شكراً"]]) assert.deepEqual(C(t, cust), [], t);
  assert.equal(AR.unsolicitedNegative("We do not have outdoor seating.", "where are you"), "We do not have outdoor seating");
  assert.equal(AR.unsolicitedNegative("We do not have outdoor seating.", "do you have outdoor seating?"), null);
  assert.equal(AR.checkReply("لا توجد جلسات خارجية.", { facts: [], lang: "ar" }).ok, true, "callers that do not pass the customer's words are not judged (older call sites)");
  assert.match(AR.SYSTEM_PROMPT, /Never volunteer what we do NOT have/);
});

test("«في المكان» and the other short spellings are a where-are-you question; a location reaches the assistant with the hint", () => {
  const cls = (text) => R.classify({ phone: PHONE, text, type: "text" }, {});
  for (const t of ["في المكان", "فى المكان؟", "فين المكان", "المكان فين", "وين المكان", "فين جده ولا فين", "انتو فين", "فين", "وين موقعكم", "ابعتلي اللوكيشن", "العنوان فين بالظبط"]) assert.equal(cls(t).key, "location", t);
  assert.equal(cls("في المكان").rawIntent, "where_typo");
  for (const t of ["فين طلبي", "وين الطلب", "اكل في المكان", "عندكم جلسات", "وين اطلب"]) assert.notEqual(cls(t).key, "location", t);
  assert.deepEqual(AR.hintOf(cls("فين المكان")), { intent: "where_are_we", do: "faq branch_location" });
  assert.match(AR.hintOf(cls("في المكان")).unless, /delivery or pickup/);
  assert.match(AR.SYSTEM_PROMPT, /faq\("branch_location"\) only: the map button is attached/);
});

test("the reminder plan: only inside the 24-hour window, never in quiet hours or while closed, and it says so when the time had to move", () => {
  const open = (d) => { const h = new Date(d.getTime() + 3 * 3600_000).getUTCHours(); return h >= 12 || h < 2; };
  const P = (nowIso, day, time, extra = {}) => AR.planReminder({ now: new Date(nowIso), day, time, lastInMs: Date.parse(nowIso), isOpenAt: open, ...extra });
  // the real chat: 00:13 Riyadh, «بكره» = the coming evening (the same calendar date)
  assert.deepEqual((({ ok, at, when, moved }) => ({ ok, at, when, moved }))(P("2026-10-12T21:13:00Z", "tomorrow", "20:00")), { ok: true, at: "2026-10-13T17:00:00.000Z", when: "بكرة الساعة 8 مساءً", moved: false });
  assert.equal(P("2026-10-12T21:13:00Z", "tomorrow", "01:00").at, "2026-10-13T20:50:00.000Z", "«بكرة ١ الفجر» after midnight is the NEXT night: outside the window, so the latest allowed time");
  // 18:00 Monday, «بكرة ٨ بالليل» is 26 h away: moved to the last allowed moment, and the rule says to tell the customer
  const m = P("2026-10-12T15:00:00Z", "tomorrow", "20:00");
  assert.deepEqual([m.ok, m.at, m.when, m.moved], [true, "2026-10-13T14:40:00.000Z", "بكرة الساعة 5:40 عصراً", true]); assert.match(m.rule, /honestly/);
  assert.deepEqual([P("2026-10-12T15:00:00Z", "today", "20:30").when, P("2026-10-12T15:00:00Z", "today", "20:30", { lang: "en" }).when], ["اليوم الساعة 8:30 مساءً", "today at 8:30 pm"]);
  // closed / quiet hour asked by the customer: another time; the moved time falling there: an honest «cannot»
  assert.deepEqual([P("2026-10-12T15:00:00Z", "tomorrow", "09:00").error, P("2026-10-12T15:00:00Z", "tomorrow", "13:00", { quietStart: 2, quietEnd: 14 }).error], ["closed_then", "quiet_hours"]);
  assert.equal(P("2026-10-12T05:00:00Z", "tomorrow", "20:00").error, "cannot_send", "08:00 Monday → the window closes 07:40 Tuesday, while we are closed: nothing is promised");
  assert.deepEqual([P("2026-10-12T15:00:00Z", "today", "17:00").error, P("2026-10-12T15:00:00Z", "today", "8pm").error, P("2026-10-12T15:00:00Z", "today", "").error], ["time_passed", "need_time", "need_time"]);
  assert.equal(P("2026-10-12T15:00:00Z", "today", "23:30", { quietStart: 23, quietEnd: 12 }).error, "quiet_hours", "quiet hours may wrap past midnight");
  for (const bad of ["cannot_send", "closed_then"]) assert.doesNotMatch(JSON.stringify(P("2026-10-12T05:00:00Z", "tomorrow", bad === "cannot_send" ? "20:00" : "09:00")), /"at"/, "a refused plan carries no time to schedule");
  assert.deepEqual([AR.assistConfig({}).remindersEnabled, AR.assistConfig({}).reminderQuietStart, AR.assistConfig({}).reminderQuietEnd], [true, 2, 12]);
});

test("a postponement carries its rule in that turn's context; a reminder promise without a confirmed schedule is refused; an offer as a question is fine", async () => {
  for (const t of ["لا انشالله بكره", "بكرة ان شاء الله", "بعدين", "خليها الليلة", "بعد الصلاة", "مو الحين", "maybe tomorrow", "later"]) assert.ok(AR.POSTPONE_RE.test(normalize(t)), t);
  for (const t of ["ابي كريب", "شكرا", "كم السعر"]) assert.ok(!AR.POSTPONE_RE.test(normalize(t)), t);
  assert.ok(!AR.SYSTEM_PROMPT.includes("puts it off"), "the postponement rule is not in the always-paid prompt");
  assert.match(AR.CTX_RULES.postpone, /offer to remind them/); assert.match(AR.CTX_RULES.postpone, /do not wish them luck/); assert.doesNotMatch(AR.CTX_RULES.postpone, /\d/);
  const C = (t, o = {}) => AR.checkReply(t, { facts: ['{"when":"بكرة الساعة 8 مساءً"}'], lang: "ar", ...o }).problems.map((p) => p.type);
  assert.deepEqual(C("على راحتك 🌟 تحب أذكّرك بكرة؟ أي وقت يناسبك؟", { reminderSet: false }), []);
  assert.deepEqual(C("تمام، بذكّرك بكرة الساعة 8 مساءً.", { reminderSet: false }), ["reminder_not_scheduled"]);
  assert.deepEqual(C("تمام، بذكّرك بكرة الساعة 8 مساءً.", { reminderSet: true }), []);
  assert.deepEqual(AR.checkReply("Done, I'll remind you tomorrow at 8 pm.", { facts: ['{"when":"tomorrow at 8 pm"}'], lang: "en", reminderSet: false }).problems.map((p) => p.type), ["reminder_not_scheduled"]);
  // in the loop: the turn of «بكره» gets the rule; remind_me answers the plan and the turn returns it for scheduling; switched off = nothing is promised
  const say = (text) => ({ ok: true, content: [{ type: "text", text }], stop: "end_turn", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
  const use = (name, input) => ({ ok: true, content: [{ type: "tool_use", id: "t1", name, input }], stop: "tool_use", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1, provider: "t" });
  const run = async (steps, text, over = {}, session = null) => { let i = 0; const W = makeWorld({ at: "2026-10-12T21:13:00Z" }, { callModel: async () => steps[i++], onCall: async () => ({ costSar: 0, in: 0, out: 0, cached: 0 }) });
    const hours = await W.tools.get_hours(); return W.loop.runTurn({ phone: PHONE, text, lang: "ar", session: session || AR.newSession(W.now()), acfg: { ...W.acfg, ...over }, context: AR.buildContext({ first: !session, hours }) }); };
  const a = await run([say("على راحتك 🌟 تحب أذكّرك بكرة؟ أي وقت يناسبك؟")], "لا انشالله بكره");
  assert.equal(a.ok, true); assert.equal(a.reminder, null); assert.match(a.session.messages[0].content[0].text, /customer_is_postponing/);
  const b = await run([use("remind_me", { day: "tomorrow", time: "20:00", dish_id: "8" }), say("تمام، بذكّرك بكرة الساعة 8 مساءً.")], "ايوه الساعة ٨ مساء", {}, a.session);
  assert.equal(b.ok, true); assert.deepEqual(b.reminder, { at: "2026-10-13T17:00:00.000Z", ref: { id: "8" }, lang: "ar" });
  assert.doesNotMatch(JSON.stringify(b.trace.tools[0].result), /"at"/, "the model sees the words, not the timestamp");
  const off = await run([use("remind_me", { day: "tomorrow", time: "20:00" }), say("حيّاك الله في أي وقت، اكتب لي متى ما حبيت.")], "ذكرني بكره الساعة ٨", { remindersEnabled: false });
  assert.equal(off.reminder, null); assert.equal(off.trace.tools[0].result.error, "unavailable"); assert.doesNotMatch(off.session.messages[0].content[0].text, /customer_is_postponing/);
  const cancel = await run([use("remind_me", { cancel: true }), say("تم، لغيت التذكير.")], "خلاص لا تذكرني");
  assert.deepEqual(cancel.reminder, { cancel: true });
});

test("a reminder request is the assistant's even when the classifier files it under «hours»; «نبّهني لما تفتحوا» stays with the rules bot's waitlist; a tailored offer is handed over only after the packs were shown", async () => {
  const cfg = R.botConfig({ waBot: { mode: "test", testPhones: [`0${PHONE}`] } }), A = AR.assistConfig({ mode: "test" });
  const E = (text, acfg = {}) => AR.assistEligible({ acfg: { ...A, ...acfg }, cfg, phone: PHONE, ev: { text }, cls: { key: "hours", rawIntent: "waitlist_join" }, d: { act: "reply", key: "hours" } });
  assert.equal(E("ذكرني بكرة الساعة ٨ بالليل").run, true); assert.equal(E("فكرني بعدين الساعة ٩").run, true);
  assert.equal(E("نبهني لما تفتحوا").run, false); assert.equal(E("متى تفتحون").run, false); assert.equal(E("ذكرني بكرة الساعة ٨", { remindersEnabled: false }).run, false);
  const W = makeWorld({}, { callModel: async () => ({ ok: false, error: "none" }), onCall: async () => ({}) });
  const T = { phone: PHONE, lang: "ar", session: AR.newSession(W.now()), trace: { suggestions: [], unanswered: [] }, acfg: W.acfg, factSay: [], kbSay: [] };
  const early = await W.loop.exec("handover", { reason: "custom_offer", note: "25 people" }, T);
  assert.deepEqual([early.ok, early.error, T.handover], [false, "show_packs_first", undefined]);
  T.session.state.packs = true;
  assert.equal((await W.loop.exec("handover", { reason: "custom_offer", note: "25 people" }, T)).ok, true); assert.equal(T.handover.reason, "custom_offer");
  assert.equal((await W.loop.exec("handover", { reason: "complaint" }, { ...T, handover: null, session: AR.newSession(W.now()) })).ok, true, "every other handover is immediate");
});
