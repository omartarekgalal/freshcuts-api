/* RV6 (عمر ١٧/١٠/٢٠٢٦ ٢١:٣٠) — «قيّمت على جوجل خلاص»: مانطلبش تقييم جوجل تاني من اللي قيّم.
     «نفتح رسالة «بالهنا والشفا» بعد الاستلام، بس العملاء اللي قيّموا على جوجل مانبعتلهمش تاني يقيّموا جوجل.
      هنعرف منين؟ بعد ما نطلب منهم نعملهم اختيار معناه إنه قيّم خلاص.»
   هنا: القواعد الصافية (wareviews.js) + المسح في reviews.js + صفحة التقييم + رابط جوجل المتتبَّع + مسار الفريق (customer360.js) + الإحصائيات.
   رحلة واتساب نفسها (السؤال الوحيد والزرّين والنجوم بعده) في wabotrun.test.mjs «RV6: …».
   node --test rv6-google-rated.test.mjs — قاعدة مزيّفة، أرقام مزيّفة، من غير شبكة ولا رسايل. */
import test from "node:test";
import assert from "node:assert/strict";

process.env.REVIEW_INVITE_MINUTES = "0";
process.env.REVIEWS_GOOGLE_JOB = "0";
const RV = await import("./wareviews.js");
const reviews = await import("./reviews.js");
const C360 = await import("./customer360.js");
const R = await import("./wabotrun.js");
const { LIMITS } = await import("./wabot.js");

const CUST = "534781260", OTHER = "542689137";      // أرقام شكلها حقيقي (مش حشو — phonecheck.js)
const norm = (x) => String(x || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
const fakeApp = () => { const routes = {}; const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; }; return { routes, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") }; };
const ORDER_T = Date.parse("2026-10-15T15:00:00Z");      // 18:00 الرياض — بره ساعات الهدوء
const ago = (min) => new Date(ORDER_T - min * 60_000).toISOString();
const F0 = RV.reviewFlowConfig({});
/* q مزيّفة بتسجّل الاستعلامات وبترجّع حسب جدول ردود */
const fakeQ = (answers = []) => { const log = []; const q = async (sql, p = []) => { const s = String(sql).replace(/\s+/g, " ").trim(); log.push([s, p]); for (const [re, v] of answers) if (re.test(s)) return typeof v === "function" ? v(s, p) : v; return []; }; q.log = log; return q; };
const T = (k) => RV.REVIEW_TEXTS[k].ar, F = (k, v) => RV.REVIEW_TEXTS[k].ar.replace(/\{(\w+)\}/g, (m, n) => v[n] ?? m);

/* ═══ ١) الإعدادات: ٣ مفاتيح في اللوحة بتسمياتها وافتراضياتها وحدودها ═══ */
test("settings: googleClickCountsAsRated=true, googleRatedPolicy=internal_only, googleRatedCooldownDays=30 by default; the dashboard body is typed (enum rejects anything but the two values); every row has an Arabic label + help + default, and the enum row carries its Arabic option labels", () => {
  assert.deepEqual([F0.googleClickCountsAsRated, F0.googleRatedPolicy, F0.googleRatedCooldownDays], [true, "internal_only", 30]);
  assert.deepEqual(RV.GOOGLE_RATED_POLICIES, ["internal_only", "skip"]);
  assert.equal(RV.reviewFlowConfig({ googleRatedPolicy: "skip", googleClickCountsAsRated: false, googleRatedCooldownDays: 0 }).googleRatedPolicy, "skip");
  assert.equal(RV.reviewFlowConfig({ googleRatedPolicy: "whatever" }).googleRatedPolicy, "internal_only", "unknown value ⇒ default (never throws)");
  assert.equal(RV.reviewFlowConfig({ googleRatedCooldownDays: 999 }).googleRatedCooldownDays, 30, "out of range ⇒ default");
  assert.deepEqual(RV.reviewFlowFromBody({ googleRatedPolicy: "skip", googleClickCountsAsRated: false, googleRatedCooldownDays: 14 }, { enabled: true }), { ok: true, value: { enabled: true, googleRatedPolicy: "skip", googleClickCountsAsRated: false, googleRatedCooldownDays: 14 } });
  assert.equal(RV.reviewFlowFromBody({ googleRatedPolicy: "sometimes" }).ok, false);
  assert.match(RV.reviewFlowFromBody({ googleRatedPolicy: "sometimes" }).errors[0], /internal_only أو skip/);
  assert.equal(RV.reviewFlowFromBody({ googleClickCountsAsRated: "no" }).ok, false);
  assert.equal(RV.reviewFlowFromBody({ googleRatedCooldownDays: 366 }).ok, false);
  assert.equal(RV.reviewFlowFromBody({ googleRatedCooldownDays: 0 }).ok, true, "0 = the global cap only");
  for (const k of ["googleClickCountsAsRated", "googleRatedPolicy", "googleRatedCooldownDays"]) {
    const row = RV.REVIEW_FLOW_SCHEMA[`reviewFlow.${k}`];
    assert.ok(row && row.group === "reviews" && /[؀-ۿ]/.test(row.ar) && /[؀-ۿ]/.test(row.help), k);
    assert.match(row.help, /١٧\/١٠|قرار المالك|المعلَّم/, `${k}: the help names the owner's reason`);
  }
  const pol = RV.REVIEW_FLOW_SCHEMA["reviewFlow.googleRatedPolicy"];
  assert.deepEqual([pol.type, [...pol.options], pol.optionsAr], ["enum", ["internal_only", "skip"], { internal_only: "النجوم الداخلية بس (من غير جوجل)", skip: "مفيش طلب تقييم خالص" }]);
  const cd = RV.REVIEW_FLOW_SCHEMA["reviewFlow.googleRatedCooldownDays"];
  assert.deepEqual([cd.type, cd.min, cd.max, cd.unit], ["number", 0, 365, "يوم"]);
  assert.equal(RV.REVIEW_FLOW_SCHEMA["reviewFlow.googleClickCountsAsRated"].type, "boolean");
  // served by the bot schema with the defaults (what the dashboard renders and what verify.py checks)
  const rows = Object.fromEntries(R.schemaFor(R.botConfig({})).map((x) => [x.key, x]));
  assert.deepEqual([rows["reviewFlow.googleClickCountsAsRated"].default, rows["reviewFlow.googleRatedPolicy"].default, rows["reviewFlow.googleRatedCooldownDays"].default], [true, "internal_only", 30]);
  assert.deepEqual(rows["reviewFlow.googleRatedPolicy"].optionsAr, pol.optionsAr, "optionsAr reaches the schema endpoint");
  assert.equal(rows["reviewFlow.googleRatedPolicy"].groupAr, "التقييمات على واتساب (النجوم وجوجل)");
  // the live config parses the three keys from settings.waBot.reviewFlow
  const cfg = R.botConfig({ waBot: { reviewFlow: { googleRatedPolicy: "skip", googleClickCountsAsRated: false, googleRatedCooldownDays: 7 } } });
  assert.deepEqual([cfg.reviewFlow.googleRatedPolicy, cfg.reviewFlow.googleClickCountsAsRated, cfg.reviewFlow.googleRatedCooldownDays], ["skip", false, 7]);
});

/* ═══ ٢) التوجيه ═══ */
test("routeOf: 4–5★ ⇒ google only when a Google URL exists AND the customer is not flagged; flagged ⇒ thanks; low stays low; «يحتاج تحسين» stays low", () => {
  const G = "https://g.page/r/CSG0gPAqlvHMEBM/review";
  assert.equal(RV.routeOf({ stars: 5, googleUrl: G }), "google");
  assert.equal(RV.routeOf({ stars: 5, googleUrl: G, googleRated: true }), "thanks");
  assert.equal(RV.routeOf({ stars: 4, googleUrl: G, googleRated: true }), "thanks");
  assert.equal(RV.routeOf({ stars: 5, googleUrl: "", googleRated: false }), "thanks");
  assert.equal(RV.routeOf({ stars: 3, googleUrl: G, googleRated: true }), "low");
  assert.equal(RV.routeOf({ stars: 5, exact: false, googleUrl: G }), "low");
});

/* ═══ ٣) حالة العميل: الصف + الضغطة القديمة + المفتاح ═══ */
const STATE_SQL = /^SELECT google_rated_at, google_rated_source, google_asked_at FROM review_customer_state WHERE phone_norm=\$1$/;
const CLICK_SQL = /^SELECT min\(google_clicked_at\) AS at FROM review_invites WHERE phone_norm=\$1 AND google_clicked_at IS NOT NULL AND order_no NOT LIKE 'TEST-%'$/;
const OFFER_SQL = /^SELECT 1 FROM review_invites WHERE phone_norm=\$1 AND google_sent_at IS NOT NULL AND order_no NOT LIKE 'TEST-%' LIMIT 1$/;
test("googleRatedState: row by reply/staff ⇒ rated (knob irrelevant); row by click ⇒ rated only while the click knob is on; no row + an old click on our link ⇒ rated while the knob is on (legacy, before RV6); offered = a Google button was ever sent; a bad phone ⇒ plain not-rated without touching the database; a failed read ⇒ null", async () => {
  const on = F0, off = RV.reviewFlowConfig({ googleClickCountsAsRated: false });
  const row = (x) => [STATE_SQL, [x]];
  let st = await RV.googleRatedState(fakeQ([row({ google_rated_at: "2026-10-01T10:00:00Z", google_rated_source: "reply", google_asked_at: "2026-10-01T09:00:00Z" })]), CUST, off);
  assert.deepEqual(st, { rated: true, at: "2026-10-01T10:00:00Z", source: "reply", askedAt: "2026-10-01T09:00:00Z", offered: false });
  st = await RV.googleRatedState(fakeQ([row({ google_rated_at: "2026-10-01T10:00:00Z", google_rated_source: "staff", google_asked_at: null })]), CUST, off);
  assert.deepEqual([st.rated, st.source], [true, "staff"]);
  st = await RV.googleRatedState(fakeQ([row({ google_rated_at: "2026-10-01T10:00:00Z", google_rated_source: "click", google_asked_at: null })]), CUST, on);
  assert.deepEqual([st.rated, st.source], [true, "click"]);
  st = await RV.googleRatedState(fakeQ([row({ google_rated_at: "2026-10-01T10:00:00Z", google_rated_source: "click", google_asked_at: null }), [OFFER_SQL, [{}]]]), CUST, off);
  assert.deepEqual(st, { rated: false, at: null, source: null, askedAt: null, offered: true }, "knob off ⇒ the click row does not count (and no legacy lookup when a row exists)");
  const legacyOn = fakeQ([[STATE_SQL, []], [CLICK_SQL, [{ at: "2026-09-20T15:05:00Z" }]]]);
  st = await RV.googleRatedState(legacyOn, CUST, on);
  assert.deepEqual([st.rated, st.source, st.at], [true, "click", "2026-09-20T15:05:00Z"]);
  const legacyOff = fakeQ([[STATE_SQL, []], [CLICK_SQL, [{ at: "2026-09-20T15:05:00Z" }]], [OFFER_SQL, [{}]]]);
  st = await RV.googleRatedState(legacyOff, CUST, off);
  assert.deepEqual([st.rated, st.offered], [false, true]);
  assert.ok(!legacyOff.log.some(([s]) => CLICK_SQL.test(s)), "knob off ⇒ the legacy click is not even looked up");
  st = await RV.googleRatedState(fakeQ([[STATE_SQL, []], [CLICK_SQL, [{ at: null }]], [OFFER_SQL, []]]), CUST, on);
  assert.deepEqual(st, { rated: false, at: null, source: null, askedAt: null, offered: false });
  const bad = fakeQ();
  assert.deepEqual(await RV.googleRatedState(bad, "0512345678", on), { rated: false, at: null, source: null, askedAt: null, offered: false });
  assert.equal(bad.log.length, 0, "not a normalised 5XXXXXXXX ⇒ no query");
  assert.equal(await RV.googleRatedState(fakeQ([[STATE_SQL, null]]), CUST, on), null, "database down ⇒ null (callers decide)");
  assert.equal(await RV.googleRatedState(fakeQ([[STATE_SQL, []], [CLICK_SQL, null]]), CUST, on), null);
  // the one-time question: not rated + never asked + offered
  assert.equal(RV.shouldAskGoogleRated({ rated: false, askedAt: null, offered: true }), true);
  assert.equal(RV.shouldAskGoogleRated({ rated: true, askedAt: null, offered: true }), false);
  assert.equal(RV.shouldAskGoogleRated({ rated: false, askedAt: "2026-10-01T09:00:00Z", offered: true }), false);
  assert.equal(RV.shouldAskGoogleRated({ rated: false, askedAt: null, offered: false }), false);
  assert.equal(RV.shouldAskGoogleRated(null), false);
});

test("markGoogleRated / clearGoogleRated / markGoogleAsked: one upsert each on review_customer_state; a click never overwrites a stronger source; sources outside reply|click|staff become staff; bad phones write nothing; a failed write ⇒ false", async () => {
  const q = fakeQ([[/^INSERT INTO review_customer_state/, (s, p) => [{ phone_norm: p[0] }]]]);
  assert.equal(await RV.markGoogleRated(q, { phone: CUST, source: "reply" }), true);
  assert.equal(await RV.markGoogleRated(q, { phone: CUST, source: "staff", by: "عمر" }), true);
  assert.equal(await RV.markGoogleRated(q, { phone: CUST, source: "click" }), true);
  assert.equal(await RV.markGoogleRated(q, { phone: CUST, source: "bogus" }), true);
  assert.equal(await RV.clearGoogleRated(q, { phone: CUST, by: "عمر" }), true);
  assert.equal(await RV.markGoogleAsked(q, { phone: CUST, code: "ab12cd34" }), true);
  assert.deepEqual(q.log.map(([, p]) => p), [[CUST, "reply", null], [CUST, "staff", "عمر"], [CUST, "click", null], [CUST, "staff", null], [CUST, "عمر"], [CUST, "ab12cd34"]]);
  assert.match(q.log[0][0], /ON CONFLICT \(phone_norm\) DO UPDATE SET google_rated_at = CASE WHEN \$2 = 'staff' THEN NOW\(\) ELSE COALESCE\(review_customer_state\.google_rated_at, NOW\(\)\) END/, "RV6 review: only staff re-stamps; a second «✅ قيّمت» keeps the first date");
  assert.match(q.log[4][0], /VALUES \(\$1, NULL, NULL, \$2, NOW\(\)\) ON CONFLICT \(phone_norm\) DO UPDATE SET google_rated_at = NULL, google_rated_source = NULL/);
  assert.match(q.log[5][0], /google_asked_at = COALESCE\(review_customer_state\.google_asked_at, NOW\(\)\)/, "asked once: the first ask stays");
  const none = fakeQ();
  assert.equal(await RV.markGoogleRated(none, { phone: "05347812", source: "reply" }), false);
  assert.equal(await RV.clearGoogleRated(none, { phone: "" }), false);
  assert.equal(await RV.markGoogleAsked(none, { phone: "x", code: "ab12cd34" }), false);
  assert.equal(none.log.length, 0);
  assert.equal(await RV.markGoogleRated(fakeQ([[/INSERT/, null]]), { phone: CUST }), false, "database down ⇒ false (the caller does not pretend)");
  assert.equal(await RV.markGoogleAsked(fakeQ([[/INSERT/, (s, p) => { assert.equal(p[1], null); return [{}]; }]]), { phone: CUST, code: "bad code!" }), true, "a bad code is stored as NULL, the ask is still recorded");
});

/* ═══ ٤) السؤال الوحيد: الأزرار والنصوص والردود ═══ */
test("one-time question: button ids gq:yes/no:<code>; typed «قيّمت/نعم/ايوه/سبق» = yes, «لسه/لا/ما قيمت/مو بعد» = no, anything else = not an answer; the reply texts fit WhatsApp limits in both languages and the customer copy is white dialect", () => {
  assert.deepEqual(RV.gqOfButtonId("gq:yes:ab12cd34"), { yes: true, code: "ab12cd34" });
  assert.deepEqual(RV.gqOfButtonId("gq:no:AB12CD34"), { yes: false, code: "ab12cd34" });
  for (const bad of ["gq:maybe:ab12cd34", "gq:yes:ab", "gq:yes:", "rs:5:ab12cd34", "", null]) assert.equal(RV.gqOfButtonId(bad), null, JSON.stringify(bad));
  for (const t of ["قيّمت", "قيمت", "✅ قيّمت", "نعم", "ايوه", "أيوه", "اي", "سبق", "yes", "Done", "already"]) assert.equal(RV.typedGoogleAnswer(t), "yes", t);
  for (const t of ["لسه", "لسا", "لا", "لأ", "ما قيمت", "ماقيمت", "مو بعد", "no", "not yet", "لم اقيم"]) assert.equal(RV.typedGoogleAnswer(t), "no", t);
  for (const t of ["5", "تمام", "نعم قيمت امبارح على جوجل وكان حلو", "", "شكرا", "لا ابي اطلب"]) assert.equal(RV.typedGoogleAnswer(t), null, JSON.stringify(t));
  const ask = RV.gqAskReply({ T, code: "ab12cd34" });
  assert.deepEqual(ask.buttons, [{ id: "gq:yes:ab12cd34", title: "✅ قيّمت" }, { id: "gq:no:ab12cd34", title: "ما قيّمت بعد" }]);
  assert.match(ask.body, /سبق وقيّمت فريش كاتس على جوجل؟/);
  assert.throws(() => RV.gqAskReply({ T, code: "bad!" }), /review_code/);
  for (const k of ["gq_ask", "btn_gq_yes", "btn_gq_no", "gq_thanks", "gq_then_ask", "gq_noted"]) {
    const x = RV.REVIEW_TEXTS[k];
    assert.ok(x && [...x.ar].length <= x.max && [...x.en].length <= x.max, `${k} fits its max`);
    assert.doesNotMatch(x.ar, /دلوقتي|عايز|عاوز|بتاع|إزاي|ازاي|كده|مفيش|\sمش\s|لسه|بأسرع وقت/, `${k}: white dialect for the customer`);
    assert.doesNotMatch(x.ar, /خصم|كود|هدية|مجان/, `${k}: no incentive next to a Google question`);
  }
  for (const k of ["btn_gq_yes", "btn_gq_no"]) assert.ok([...RV.REVIEW_TEXTS[k].ar].length <= LIMITS.btnTitle && [...RV.REVIEW_TEXTS[k].en].length <= LIMITS.btnTitle, k);
  // replies
  const yesList = RV.gqAnswerReply({ T, F, yes: true, policy: "internal_only", kind: "delivery", orderNo: "W1790012345678", code: "ab12cd34" });
  assert.equal(yesList.body, "شكراً لك 🌟 ما راح نطلب منك تقييم جوجل مرة ثانية.\nوكيف كانت تجربتك هذه المرة؟ اختر من القائمة 👇");
  assert.equal(yesList.list.rows[0].id, "rs:5:ab12cd34");
  assert.deepEqual(RV.gqAnswerReply({ T, F, yes: true, policy: "skip", kind: "delivery", orderNo: "W1790012345678", code: "ab12cd34" }), { body: "شكراً لك 🌟 ما راح نطلب منك تقييم جوجل مرة ثانية." });
  assert.deepEqual(RV.gqAnswerReply({ T, F, yes: true, policy: "internal_only", code: "ab12cd34", rated: true }), { body: "شكراً لك 🌟 ما راح نطلب منك تقييم جوجل مرة ثانية." }, "already rated ⇒ thanks only");
  assert.deepEqual(RV.gqAnswerReply({ T, F, yes: true, policy: "internal_only", code: null }), { body: "شكراً لك 🌟 ما راح نطلب منك تقييم جوجل مرة ثانية." }, "no invite ⇒ thanks only");
  const noList = RV.gqAnswerReply({ T, F, yes: false, kind: "dinein", orderNo: null, code: "ab12cd34" });
  assert.match(noList.body, /^شكراً لزيارتك فريش كاتس 🌟/);
  assert.equal(noList.list.rows[4].id, "rs:1:ab12cd34");
  assert.deepEqual(RV.gqAnswerReply({ T, F, yes: false, code: "ab12cd34", rated: true }), { body: "وصلنا تقييمك، شكراً لك 🌟" });
  assert.deepEqual(RV.gqAnswerReply({ T, F, yes: false, code: null }), { body: "تمام، شكراً لك 🙏" });
});

test("pendingGoogleAsk: the typed answer counts only while OUR question is the open one — asked, not rated, same invite code on the chat, not answered since, within the reply window", async () => {
  const S = /^SELECT google_asked_at, google_asked_code, google_rated_at FROM review_customer_state WHERE phone_norm=\$1$/;
  const CH = /^SELECT review_code, review_order, review_asked_at, review_answered_at FROM wa_bot_chats WHERE phone_norm=\$1$/;
  const now = new Date("2026-10-15T16:00:00Z");
  const rig = (st, ch) => fakeQ([[S, st ? [st] : []], [CH, ch ? [ch] : []]]);
  const asked = { google_asked_at: "2026-10-15T15:00:00Z", google_asked_code: "ab12cd34", google_rated_at: null };
  assert.deepEqual(await RV.pendingGoogleAsk(rig(asked, { review_code: "ab12cd34", review_asked_at: "2026-10-15T15:00:00Z", review_answered_at: null }), CUST, now, 24), { code: "ab12cd34" });
  assert.equal(await RV.pendingGoogleAsk(rig(asked, { review_code: "ab12cd34", review_asked_at: "2026-10-15T15:00:00Z", review_answered_at: "2026-10-15T15:30:00Z" }), CUST, now, 24), null, "answered since");
  assert.equal(await RV.pendingGoogleAsk(rig(asked, { review_code: "zz99yy88", review_asked_at: "2026-10-15T15:00:00Z", review_answered_at: null }), CUST, now, 24), null, "a newer ask replaced it");
  assert.equal(await RV.pendingGoogleAsk(rig({ ...asked, google_rated_at: "2026-10-15T15:10:00Z" }, { review_code: "ab12cd34", review_asked_at: "2026-10-15T15:00:00Z", review_answered_at: null }), CUST, now, 24), null, "already flagged");
  assert.equal(await RV.pendingGoogleAsk(rig(asked, { review_code: "ab12cd34", review_asked_at: "2026-10-15T15:00:00Z", review_answered_at: null }), CUST, new Date("2026-10-17T16:00:00Z"), 24), null, "expired");
  assert.equal(await RV.pendingGoogleAsk(rig(null, null), CUST, now, 24), null);
  assert.equal(await RV.pendingGoogleAsk(fakeQ(), "123", now, 24), null);
});

/* ═══ ٥) الإحصائيات ═══ */
test("googleRatedStats: total/week/bySource from the table, legacy clicks (no row) added while the knob is on, the one-time asks, and invites closed by the flag (google_rated* and wa_google_rated*)", async () => {
  const agg = [{ total: 2, week: 1, reply: 1, click: 1, staff: 0, asked: 3 }];
  const q = fakeQ([[/^SELECT count\(\*\) FILTER/, agg], [/count\(DISTINCT iv\.phone_norm\)/, [{ n: 4 }]], [/skip_reason LIKE 'google_rated%' OR skip_reason LIKE 'wa_google_rated%'/, [{ n: 5 }]]]);
  assert.deepEqual(await RV.googleRatedStats(q, { flow: F0, days: 30 }), { total: 6, week: 1, bySource: { reply: 1, click: 5, staff: 0 }, asked: 3, skipped: 5, clickCounts: true, policy: "internal_only", cooldownDays: 30 });
  const off = RV.reviewFlowConfig({ googleClickCountsAsRated: false, googleRatedPolicy: "skip", googleRatedCooldownDays: 0 });
  const q2 = fakeQ([[/^SELECT count\(\*\) FILTER/, [{ total: 1, week: 0, reply: 1, click: 1, staff: 0, asked: 3 }]], [/skip_reason LIKE/, [{ n: 0 }]]]);
  assert.deepEqual(await RV.googleRatedStats(q2, { flow: off, days: 7 }), { total: 1, week: 0, bySource: { reply: 1, click: 1, staff: 0 }, asked: 3, skipped: 0, clickCounts: false, policy: "skip", cooldownDays: 0 });
  assert.ok(!q2.log.some(([s]) => /count\(DISTINCT iv\.phone_norm\)/.test(s)), "knob off ⇒ no legacy count");
  assert.equal(q2.log.find(([s]) => /skip_reason LIKE/.test(s))[1][0], 7);
  const down = await RV.googleRatedStats(fakeQ([[/^SELECT count\(\*\) FILTER/, null], [/count\(DISTINCT iv\.phone_norm\)/, null], [/skip_reason/, null]]), { flow: F0 });
  assert.deepEqual([down.total, down.skipped], [0, 0], "database down ⇒ zeros, never throws");
});

/* ═══ ٦) الجدول: idempotent ═══ */
test("DDL: every statement is IF NOT EXISTS and runs twice without error; the table has the flag (at/source/by) and the one-time ask (at/code)", async () => {
  assert.equal(RV.GOOGLE_RATED_DDL.length, 2);
  for (const d of RV.GOOGLE_RATED_DDL) assert.match(d, /IF NOT EXISTS/);
  assert.match(RV.GOOGLE_RATED_DDL[0], /CREATE TABLE IF NOT EXISTS review_customer_state \(\s*phone_norm TEXT PRIMARY KEY/);
  for (const col of ["google_rated_at TIMESTAMPTZ", "google_rated_source TEXT", "google_rated_by TEXT", "google_asked_at TIMESTAMPTZ", "google_asked_code TEXT", "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"]) assert.match(RV.GOOGLE_RATED_DDL[0], new RegExp(col.replace(/[()]/g, "\\$&")));
  const ran = [];
  const pool = { async query(sql) { ran.push(String(sql)); return { rows: [], rowCount: 0 }; } };
  for (let i = 0; i < 2; i++) for (const d of RV.GOOGLE_RATED_DDL) await pool.query(d);
  assert.equal(ran.length, 4);
});

/* ═══ ٧) المسح (reviews.js): مين يتسأل ومين لأ ═══ */
function pgParamsCheck(sql, params = []) {
  const used = new Set([...String(sql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  for (let i = 1; i <= params.length; i++) if (!used.has(i)) throw Object.assign(new Error("could not determine data type of parameter $" + i), { code: "42P18" });
  for (const i of used) if (i > params.length) throw Object.assign(new Error("bind message supplies " + params.length + " parameters"), { code: "08P01" });
}
function sweepRig({ invites = [], flow = {}, waReply = { ok: true, channel: "wa_list" }, gstate = {}, stateFail = false, settingsExtra = {} } = {}) {
  const db = { invites: invites.map((x) => ({ ...x })), sms: [], asked: [], sql: [] };
  const inv = (no) => db.invites.find((x) => x.order_no === no);
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); db.sql.push(s);
    pgParamsCheck(s, p);
    if (/FROM review_invites WHERE sent_at IS NULL AND skip_reason IS NULL AND due_at <=/i.test(s)) return { rows: db.invites.filter((iv) => !iv.sent_at && !iv.skip_reason && Date.parse(iv.due_at) <= Date.parse(p[0])) };
    if (/^UPDATE review_invites SET sent_at=NOW\(\), channel=\$2 WHERE order_no=\$1/i.test(s)) { Object.assign(inv(p[0]), { sent_at: new Date(ORDER_T).toISOString(), channel: p[1] }); return { rows: [], rowCount: 1 }; }
    const m = /^UPDATE review_invites SET (\w+)=\$2 WHERE order_no=\$1/i.exec(s); if (m) { inv(p[0])[m[1]] = p[1]; return { rows: [], rowCount: 1 }; }
    /* طلب تقييم واحد كل N يوم (نفس الاستعلام للحد العام وحد المعلَّم — بيختلف في $4) */
    if (/^SELECT 1 FROM review_invites WHERE phone_norm=\$1 AND order_no <> \$2 AND sent_at IS NOT NULL/i.test(s)) {
      return { rows: db.invites.filter((x) => x.phone_norm === p[0] && x.order_no !== p[1] && x.sent_at && !/^TEST-/.test(x.order_no) && Date.parse(x.sent_at) > Date.parse(p[2]) - p[3] * 86400_000).slice(0, 1).map(() => ({})) };
    }
    if (STATE_SQL.test(s)) { if (stateFail) throw new Error("db down"); const g = gstate[p[0]]; return { rows: g ? [g] : [] }; }
    if (CLICK_SQL.test(s)) return { rows: [{ at: null }] };
    if (OFFER_SQL.test(s)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  } };
  const settings = { reviews: { threshold: 4, googleUrl: "https://g.page/r/CSG0gPAqlvHMEBM/review", askMaxAgeHours: 20 }, delivery: { alertPhones: [] }, waBot: { testPhones: [], reviewFlow: flow }, ...settingsExtra };
  const api = reviews.register(fakeApp(), { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: norm },
    { notify: () => ({ sendSmsTo: async (phone, body) => { db.sms.push({ phone, body }); return true; } }),
      waReview: () => ({ reviewAsk: async (x) => { db.asked.push(x); return typeof waReply === "function" ? waReply(x) : waReply; } }) });
  return { api, db, run: (isoT = "2026-10-15T15:00:00Z") => api.runInvites(new Date(isoT)) };
}
const WEB = (over = {}) => ({ order_no: "W1790012345678", code: "ab12cd34", phone_norm: CUST, option: "delivery", kind: "delivery", due_at: ago(5), ref: "W1790012345678", ...over });
const RATED = { [CUST]: { google_rated_at: "2026-10-01T10:00:00Z", google_rated_source: "reply", google_asked_at: "2026-10-01T09:00:00Z" } };

test("sweep: a flagged customer under «مفيش طلب تقييم» (skip) ⇒ the invite closes google_rated — no WhatsApp, no SMS; under «النجوم الداخلية بس» ⇒ asked as usual (the Google button is dropped at tap time, not here)", async () => {
  const skip = sweepRig({ invites: [WEB()], flow: { googleRatedPolicy: "skip" }, gstate: RATED });
  await skip.run();
  assert.deepEqual([skip.db.invites[0].skip_reason, skip.db.asked.length, skip.db.sms.length], ["google_rated", 0, 0]);
  const internal = sweepRig({ invites: [WEB()], gstate: RATED });
  await internal.run();
  assert.deepEqual([internal.db.invites[0].channel, internal.db.asked.length, internal.db.sms.length], ["wa_list", 1, 0]);
  const plain = sweepRig({ invites: [WEB()], flow: { googleRatedPolicy: "skip" } });
  await plain.run();
  assert.deepEqual([plain.db.invites[0].channel, plain.db.asked.length], ["wa_list", 1], "not flagged ⇒ skip policy changes nothing");
});

test("sweep cooldown: a flagged customer asked 10 days ago ⇒ google_rated:cooldown (30-day default, above the 7-day global cap); cooldown 0 ⇒ the global cap only ⇒ asked; 40 days ago ⇒ asked", async () => {
  const older = (daysAgo) => WEB({ order_no: "W1790000000001", code: "old00001", due_at: ago(daysAgo * 1440 + 60), sent_at: ago(daysAgo * 1440), channel: "wa_list", rating: 5 });
  const cool = sweepRig({ invites: [older(10), WEB()], gstate: RATED });
  await cool.run();
  assert.deepEqual([cool.db.invites[1].skip_reason, cool.db.asked.length], ["google_rated:cooldown", 0]);
  const zero = sweepRig({ invites: [older(10), WEB()], gstate: RATED, flow: { googleRatedCooldownDays: 0 } });
  await zero.run();
  assert.deepEqual([zero.db.invites[1].channel, zero.db.asked.length], ["wa_list", 1]);
  const old = sweepRig({ invites: [older(40), WEB()], gstate: RATED });
  await old.run();
  assert.deepEqual([old.db.invites[1].channel, old.db.asked.length], ["wa_list", 1]);
  const notFlagged = sweepRig({ invites: [older(10), WEB()] });
  await notFlagged.run();
  assert.deepEqual([notFlagged.db.invites[1].channel, notFlagged.db.asked.length], ["wa_list", 1], "not flagged: only the 7-day global cap, and 10 days ago is outside it");
  const everyone = sweepRig({ invites: [older(3), WEB()] });
  await everyone.run();
  assert.deepEqual([everyone.db.invites[1].skip_reason, everyone.db.asked.length], ["cap_days", 0], "the global cap still applies to everyone");
});

test("sweep: the flag read fails ⇒ the invite waits for the next sweep (no decision, no message); reviewAsk refusing with google_rated (final) ⇒ wa_google_rated and NO SMS fallback", async () => {
  const down = sweepRig({ invites: [WEB()], stateFail: true });
  const out = await down.run();
  assert.deepEqual([down.db.invites[0].skip_reason, down.db.invites[0].sent_at, down.db.asked.length, down.db.sms.length, out.retry], [undefined, undefined, 0, 0, 1]);
  const refused = sweepRig({ invites: [WEB()], waReply: { ok: false, skipped: "google_rated", final: true } });
  await refused.run();
  assert.deepEqual([refused.db.invites[0].skip_reason, refused.db.sms.length], ["wa_google_rated", 0]);
});

/* ═══ ٨) صفحة التقييم + رابط جوجل المتتبَّع ═══ */
function pageRig({ gstate = {}, flow = {}, invite = { order_no: "W1790012345678", option: "delivery", kind: "delivery", phone_norm: CUST, code: "ab12cd34" } } = {}) {
  const db = { sql: [], marks: [], reviews: [] };
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); db.sql.push([s, p]);
    if (/^UPDATE review_codes SET scans/i.test(s)) return { rows: [] };
    if (/^UPDATE review_invites SET opened_at/i.test(s)) return { rows: p[0] === invite.code ? [invite] : [] };
    if (/^SELECT label, kind FROM review_codes/i.test(s)) return { rows: [] };
    if (/FROM review_invites iv LEFT JOIN shop_orders so/i.test(s)) return { rows: p[0] === invite.code ? [invite] : [] };
    if (/^INSERT INTO reviews\(/i.test(s)) { db.reviews.push(p); return { rows: [{ id: db.reviews.length }] }; }
    if (/^UPDATE review_invites SET went_google=TRUE/i.test(s)) return { rows: p[0] === invite.code ? [{ review_id: null, phone_norm: invite.phone_norm, order_no: invite.order_no }] : [] };
    if (/^INSERT INTO review_customer_state/i.test(s)) { db.marks.push(p); return { rows: [{ phone_norm: p[0] }] }; }
    if (STATE_SQL.test(s)) { const g = gstate[p[0]]; return { rows: g ? [g] : [] }; }
    if (CLICK_SQL.test(s)) return { rows: [{ at: null }] };
    if (OFFER_SQL.test(s)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  } };
  const settings = { reviews: { threshold: 4, googleUrl: "https://g.page/r/CSG0gPAqlvHMEBM/review" }, waBot: { testPhones: [], reviewFlow: flow } };
  const app = fakeApp();
  reviews.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => settings, jb: JSON.stringify, normPhone: norm }, { notify: () => ({}) });
  let headers = {}, redirect = null;
  const call = (method, path, { json = {}, query = {}, params = {} } = {}) => app.routes[`${method} ${path}`]({
    req: { json: async () => json, query: (k) => query[k], param: (k) => params[k], header: (h) => (h === "cf-connecting-ip" ? `10.0.0.${Math.floor(Math.random() * 250)}` : undefined), text: async () => "" },
    json: (body, status = 200) => ({ body, status }), header: (k, v) => { headers[k] = v; }, redirect: (url, status) => { redirect = { url, status }; return { redirect }; } });
  return { db, call, headers: () => headers, redirected: () => redirect };
}
test("rating page: config for a flagged customer's invite hides Google (hasGoogle=false, googleUrl empty, googleRated=true); rating 5 via the page ⇒ route internal, no Google URL; an unflagged customer keeps route google", async () => {
  const flagged = pageRig({ gstate: RATED });
  const cf = await flagged.call("GET", "/api/reviews/config", { query: { c: "ab12cd34" } });
  assert.deepEqual([cf.body.hasGoogle, cf.body.googleUrl, cf.body.googleRated, cf.body.codeLabel], [false, "", true, "توصيل"]);
  const r5 = await flagged.call("POST", "/api/reviews/rate", { json: { rating: 5, code: "ab12cd34" } });
  assert.deepEqual([r5.body.ok, r5.body.route, r5.body.googleUrl, r5.body.googleRated], [true, "internal", "", true]);
  assert.equal(flagged.db.reviews.length, 1, "the rating is still saved");
  const r3 = await flagged.call("POST", "/api/reviews/rate", { json: { rating: 3, code: "ab12cd34" } });
  assert.equal(r3.body.route, "internal");
  const plain = pageRig();
  const cf2 = await plain.call("GET", "/api/reviews/config", { query: { c: "ab12cd34" } });
  assert.deepEqual([cf2.body.hasGoogle, cf2.body.googleRated], [true, undefined]);
  const p5 = await plain.call("POST", "/api/reviews/rate", { json: { rating: 5, code: "ab12cd34" } });
  assert.deepEqual([p5.body.route, Boolean(p5.body.googleUrl)], ["google", true]);
  const noCode = await plain.call("GET", "/api/reviews/config", { query: {} });
  assert.equal(noCode.body.hasGoogle, true, "no invite ⇒ nothing changes");
});

test("tracked Google link /api/reviews/g/<code>: the click still redirects to Google and now marks the customer with source click (a TEST- order does not); an unknown code redirects without marking", async () => {
  const w = pageRig();
  const r = await w.call("GET", "/api/reviews/g/:code", { params: { code: "ab12cd34" } });
  assert.deepEqual([w.redirected().url, w.redirected().status, w.headers()["Cache-Control"]], ["https://g.page/r/CSG0gPAqlvHMEBM/review", 302, "no-store"]);
  assert.deepEqual(w.db.marks, [[CUST, "click", null]]);
  assert.ok(r);
  const t = pageRig({ invite: { order_no: "TEST-1", option: "delivery", kind: "delivery", phone_norm: CUST, code: "ab12cd34" } });
  await t.call("GET", "/api/reviews/g/:code", { params: { code: "ab12cd34" } });
  assert.deepEqual(t.db.marks, [], "test orders never flag a real phone");
  const u = pageRig();
  await u.call("GET", "/api/reviews/g/:code", { params: { code: "zz99yy88" } });
  assert.deepEqual([u.redirected().url, u.db.marks.length], ["https://g.page/r/CSG0gPAqlvHMEBM/review", 0]);
});

/* ═══ ٩) مسار الفريق: POST /api/cms/customers/:ref/google-rated ═══ */
function staffRig({ auth = null, user = { name: "ماجد", role: "owner" }, refs = {}, gstate = {}, flow = {} } = {}) {
  const db = { sql: [], state: new Map(Object.entries(gstate)), notes: [], audits: [] };
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim(); db.sql.push([s, p]);
    if (/^SELECT phone_norm FROM c360_refs WHERE ref=\$1/i.test(s)) return { rows: refs[p[0]] ? [{ phone_norm: refs[p[0]] }] : [] };
    if (/^INSERT INTO review_customer_state\(phone_norm, google_rated_at, google_rated_source, google_rated_by, updated_at\) VALUES \(\$1, NOW\(\), \$2, \$3, NOW\(\)\)/i.test(s)) {
      const g = db.state.get(p[0]) || {}; if (p[1] === "click") { g.google_rated_at = g.google_rated_at || "now"; g.google_rated_source = g.google_rated_source || "click"; } else { g.google_rated_at = "2026-10-17T18:30:00Z"; g.google_rated_source = p[1]; g.google_rated_by = p[2]; }
      db.state.set(p[0], g); return { rows: [{ phone_norm: p[0] }] };
    }
    if (/^INSERT INTO review_customer_state\(phone_norm, google_rated_at, google_rated_source, google_rated_by, updated_at\) VALUES \(\$1, NULL, NULL, \$2, NOW\(\)\)/i.test(s)) {
      const g = db.state.get(p[0]) || {}; Object.assign(g, { google_rated_at: null, google_rated_source: null, google_rated_by: p[1] }); db.state.set(p[0], g); return { rows: [{ phone_norm: p[0] }] };
    }
    if (STATE_SQL.test(s)) { const g = db.state.get(p[0]); return { rows: g ? [g] : [] }; }
    if (/^SELECT google_rated_at, google_rated_source, google_rated_by, google_asked_at FROM review_customer_state/i.test(s)) { const g = db.state.get(p[0]); return { rows: g ? [g] : [] }; }
    if (CLICK_SQL.test(s)) return { rows: [{ at: null }] };
    if (OFFER_SQL.test(s)) return { rows: [{}] };
    if (/^INSERT INTO c360_notes/i.test(s)) { db.notes.push(p); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  } };
  const settings = { waBot: { reviewFlow: flow } };
  const app = fakeApp();
  C360.register(app, { pool, requireAdmin: async () => auth, getSettingsData: async () => settings, normPhone: norm, auditNote: async (c, note) => { db.audits.push(note); }, jb: JSON.stringify }, { whoami: async () => user });
  const call = (method, path, { json = {}, params = {} } = {}) => app.routes[`${method} ${path}`]({
    req: { json: async () => json, param: (k) => params[k], query: () => undefined, header: () => undefined },
    json: (body, status = 200) => ({ body, status }) });
  return { db, call };
}
test("staff route: anonymous ⇒ whatever requireAdmin returns (401), nothing written; owner marks by phone or by c360 ref ⇒ source staff + who, an audit note «google-rated: on …» and a note on the card; rated:false clears it; bad ref ⇒ 404; rated must be boolean", async () => {
  const anon = staffRig({ auth: { body: { error: "Unauthorized" }, status: 401 } });
  const r0 = await anon.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: CUST } });
  assert.deepEqual([r0.status, anon.db.state.size, anon.db.audits.length], [401, 0, 0]);
  const w = staffRig({ refs: { c0123456789abcde: OTHER } });
  const r1 = await w.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: "0534781260" }, json: { rated: true } });
  assert.equal(r1.body.ok, true, JSON.stringify(r1.body));
  assert.deepEqual([r1.body.googleRated.rated, r1.body.googleRated.source, r1.body.googleRated.by, r1.body.googleRated.policy, r1.body.googleRated.clickCounts], [true, "staff", "ماجد", "internal_only", true]);
  assert.deepEqual([w.db.state.get(CUST).google_rated_source, w.db.state.get(CUST).google_rated_by], ["staff", "ماجد"]);
  assert.match(w.db.audits[0], /^google-rated: on 05•••••60 by ماجد$/, "masked phone in the audit note, never the full number");
  assert.deepEqual(w.db.notes.map((n) => [n[0], n[2]]), [[CUST, "ماجد"]]);
  assert.match(w.db.notes[0][1], /قيّم على جوجل/);
  const r2 = await w.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: "c0123456789abcde" }, json: {} });
  assert.deepEqual([r2.body.ok, r2.body.googleRated.rated, w.db.state.get(OTHER).google_rated_source], [true, true, "staff"], "default rated=true; the c360 ref resolves to its phone");
  const r3 = await w.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: CUST }, json: { rated: false } });
  assert.deepEqual([r3.body.ok, r3.body.googleRated.rated, w.db.state.get(CUST).google_rated_at], [true, false, null]);
  assert.match(w.db.audits[2], /^google-rated: off /);
  assert.equal(w.db.notes.length, 3);
  assert.equal((await w.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: "c0000000000000ff" } })).status, 404);
  assert.equal((await w.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: "12" } })).status, 404);
  assert.equal((await w.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: CUST }, json: { rated: "yes" } })).status, 400);
  // a click-sourced row while the knob is off: the card says not rated but clickIgnored so staff can see why
  const k = staffRig({ flow: { googleClickCountsAsRated: false }, gstate: { [CUST]: { google_rated_at: "2026-10-01T10:00:00Z", google_rated_source: "click" } } });
  const r4 = await k.call("POST", "/api/cms/customers/:ref/google-rated", { params: { ref: CUST }, json: { rated: false } });
  assert.deepEqual([r4.body.googleRated.rated, r4.body.googleRated.clickCounts], [false, false]);
});

/* ═══ ١٠) إحصائيات اللوحة بتشيل googleRated ═══ */
test("GET /api/cms/reviews/stats carries googleRated {total, week, bySource, asked, skipped, policy} next to the old numbers", async () => {
  const pool = { async query(q, p = []) {
    const s = String(q).replace(/\s+/g, " ").trim();
    if (/FROM reviews WHERE/i.test(s) && /count\(\*\)::int AS n, \(avg\(rating\)/i.test(s)) return { rows: [{ n: 10, avg: 4.4, positive: 8, negative: 2, to_google: 3, needs_improvement: 0, via_whatsapp: 6 }] };
    if (/^SELECT rating, count\(\*\)::int AS n FROM reviews/i.test(s)) return { rows: [{ rating: 5, n: 6 }, { rating: 4, n: 2 }, { rating: 2, n: 2 }] };
    if (/resolved=FALSE AND rating < 4/i.test(s)) return { rows: [{ n: 1 }] };
    if (/FROM review_invites WHERE created_at >/i.test(s) && /AS waiting/i.test(s)) return { rows: [{ sent: 20, opened: 5, rated: 8, avg: 4.3, to_google: 3, waiting: 2, skipped: 4 }] };
    if (/count\(DISTINCT iv\.phone_norm\)/i.test(s)) return { rows: [{ n: 1 }] };
    if (/^SELECT count\(\*\) FILTER/i.test(s) && /FROM review_customer_state/i.test(s)) return { rows: [{ total: 2, week: 1, reply: 2, click: 0, staff: 0, asked: 4 }] };
    if (/skip_reason LIKE 'google_rated%'/i.test(s)) return { rows: [{ n: 3 }] };
    if (/FROM reviews_place_cache|place_cache|FROM playbook/i.test(s)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  } };
  const app = fakeApp();
  reviews.register(app, { pool, requireAdmin: async () => null, getSettingsData: async () => ({ reviews: { threshold: 4 }, waBot: { reviewFlow: {} } }), jb: JSON.stringify, normPhone: norm }, { notify: () => ({}) });
  const r = await app.routes["GET /api/cms/reviews/stats"]({ req: { query: () => undefined, header: () => undefined }, json: (body, status = 200) => ({ body, status }) });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.googleRated, { total: 3, week: 1, bySource: { reply: 2, click: 1, staff: 0 }, asked: 4, skipped: 3, clickCounts: true, policy: "internal_only", cooldownDays: 30 });
  assert.deepEqual([r.body.total, r.body.toGoogle, r.body.invites.sent], [10, 3, 20], "the old numbers are untouched");
});
