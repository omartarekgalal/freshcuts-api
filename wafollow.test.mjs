/* FU1 (١٥/١٠) — «متابعة اللي ردّ وماطلبش» (wafollow.js): الساعات المسموحة (بتعدّي نص الليل)، يوم الشغل، الفرامل، الزناد، المحادثة،
   «اللي شافه»، سطر العرض القصير، الإعدادات، والـSQL. المسار الكامل (الويب هوك ⇒ الشغلة ⇒ Graph) في wabotrun.test.mjs («FU1 …»).
   node --test wafollow.test.mjs — صافي: مفيش قاعدة ولا شبكة. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const U = await import("./wafollow.js");
const WB = await import("./wabot.js");
const LIVE = JSON.parse(fs.readFileSync(new URL("./wabot-live.fixture.json", import.meta.url), "utf8"));
const C = U.fuConfig({});
const at = (riyadh) => new Date(Date.parse(`${riyadh}+03:00`));

test("الإعدادات: الافتراضي شغّال (٤٠ دقيقة، ١٢:٠٠–١:٣٠، ٧٢ ساعة للحملة، ٣ ساعات للضغطة، ٧ أيام بعد «لا»، متابعتين في ٧ أيام، ١٠٠ في اليوم، ٢٪)؛ الغلط ⇒ الافتراضي، بره الحدود ⇒ للحد", () => {
  assert.deepEqual(C, { replyFollowUp: true, replyFollowUpOffer: true, replyFollowUpLooked: true, replyFollowUpFav: true, replyFollowUpMin: 40, replyFollowUpFromHour: 12, replyFollowUpFromMinute: 0, replyFollowUpToHour: 1, replyFollowUpToMinute: 30,
    replyFollowUpCampaignHours: 72, replyFollowUpTapHours: 3, replyFollowUpDeclineDays: 7, replyFollowUpIgnoredMax: 2, replyFollowUpIgnoredDays: 7, replyFollowUpDailyCap: 100, replyFollowUpBrakePct: 2 });
  const x = U.fuConfig({ replyFollowUp: false, replyFollowUpMin: 2, replyFollowUpToHour: 30, replyFollowUpBrakePct: "abc", replyFollowUpDailyCap: -5, replyFollowUpFav: "no" });
  assert.deepEqual([x.replyFollowUp, x.replyFollowUpMin, x.replyFollowUpToHour, x.replyFollowUpBrakePct, x.replyFollowUpDailyCap, x.replyFollowUpFav], [false, 10, 23, 2, 0, true]);
  /* كل إعداد له صف في مخطط اللوحة بنفس الحدود، وبالعربي */
  assert.deepEqual(Object.keys(U.FU_SCHEMA).sort(), Object.keys(U.FU_DEFAULTS).sort());
  for (const [k, s] of Object.entries(U.FU_SCHEMA)) {
    assert.equal(s.group, U.FU_GROUP, k); assert.match(s.ar, /[؀-ۿ]/, k);
    if (s.type === "number") { assert.deepEqual([s.min, s.max], U.FU_NUMS[k], k); assert.ok(U.FU_DEFAULTS[k] >= s.min && U.FU_DEFAULTS[k] <= s.max, k); }
    else assert.equal(typeof U.FU_DEFAULTS[k], "boolean", k);
  }
});

test("الساعات المسموحة (الرياض): ١٢:٠٠ داخلة و١:٣٠ لأ، بتعدّي نص الليل، ونفس البداية والنهاية = ولا مرة", () => {
  const cases = [["2026-10-12T11:59:00", false], ["2026-10-12T12:00:00", true], ["2026-10-12T18:41:00", true], ["2026-10-12T23:59:00", true], ["2026-10-13T00:00:00", true],
    ["2026-10-13T01:29:00", true], ["2026-10-13T01:30:00", false], ["2026-10-13T01:57:00", false], ["2026-10-13T03:00:00", false], ["2026-10-13T09:00:00", false]];
  for (const [t, want] of cases) assert.equal(U.inFollowHours(at(t), C), want, t);
  const day = { ...C, replyFollowUpFromHour: 9, replyFollowUpToHour: 17, replyFollowUpToMinute: 0 };
  assert.equal(U.inFollowHours(at("2026-10-12T16:59:00"), day), true); assert.equal(U.inFollowHours(at("2026-10-12T17:00:00"), day), false); assert.equal(U.inFollowHours(at("2026-10-12T08:59:00"), day), false);
  assert.equal(U.inFollowHours(at("2026-10-12T18:00:00"), { ...C, replyFollowUpToHour: 12, replyFollowUpToMinute: 0 }), false, "same start and end ⇒ never");
});

test("أول بداية بعد اللحظة دي: المثال الحي ١:٥٧ ⇒ ١٢:٠٠ نفس اليوم؛ وإحنا جوّه الساعات ⇒ ١٢:٠٠ بكرة", () => {
  assert.equal(U.nextFollowStart(at("2026-10-13T01:57:00"), C).toISOString(), "2026-10-13T09:00:00.000Z");
  assert.equal(U.nextFollowStart(at("2026-10-12T13:00:00"), C).toISOString(), "2026-10-13T09:00:00.000Z");
  assert.equal(U.nextFollowStart(at("2026-10-12T11:59:00"), C).toISOString(), "2026-10-12T09:00:00.000Z");
});

test("يوم الشغل بيبدأ ٤ الفجر بتوقيت الرياض (نفس «تقرير ماجد»)", () => {
  assert.equal(U.bizDayStart(at("2026-10-13T03:59:00")).toISOString(), "2026-10-12T01:00:00.000Z");
  assert.equal(U.bizDayStart(at("2026-10-13T04:00:00")).toISOString(), "2026-10-13T01:00:00.000Z");
  assert.equal(U.bizDayStart(at("2026-10-12T18:41:00")).toISOString(), "2026-10-12T01:00:00.000Z");
});

test("الفرامل: «فوق» الحد بالظبط — ١ من ٥٠ (٢٪) لأ، ١ من ٤٩ آه، ١ من ١ آه، ومن غير متابعات أو من غير إيقاف لأ", () => {
  assert.deepEqual(U.brakeVerdict({ sent: 0, bad: 0 }), { trip: false, pct: 0 });
  assert.deepEqual(U.brakeVerdict({ sent: 10, bad: 0 }), { trip: false, pct: 0 });
  assert.deepEqual(U.brakeVerdict({ sent: 50, bad: 1 }), { trip: false, pct: 2 });
  assert.deepEqual(U.brakeVerdict({ sent: 49, bad: 1 }), { trip: true, pct: 2 });
  assert.deepEqual(U.brakeVerdict({ sent: 1, bad: 1 }), { trip: true, pct: 100 });
  assert.equal(U.brakeVerdict({ sent: 10, bad: 1 }, 10).trip, false); assert.equal(U.brakeVerdict({ sent: 10, bad: 2 }, 10).trip, true);
});

test("الزناد: الحملة أولاً، وبعدها الضغطة؛ ولا واحدة ⇒ مفيش", () => {
  assert.deepEqual(U.followTrigger({ campAt: "2026-10-12T14:50:00Z", tapAt: "2026-10-12T15:00:00Z" }), { trigger: "campaign", at: "2026-10-12T14:50:00.000Z" });
  assert.deepEqual(U.followTrigger({ tapAt: new Date("2026-10-12T15:00:00Z") }), { trigger: "tap", at: "2026-10-12T15:00:00.000Z" });
  assert.equal(U.followTrigger({}), null);
});

test("المحادثة من سجل البوت: آخر مفتاح للعميل ولغته، «لا» في أي رسالة، والكروت اللي عرضناها من الأحدث", () => {
  const rows = [
    { wamid: null, reply_key: "reply_followup", decision: "replied", lang: "ar" },
    { wamid: "w3", reply_key: "item", reply_arg: "8", decision: "replied", lang: "en" },
    { wamid: "w2", reply_key: "cat", reply_arg: "23", decision: "replied", lang: "ar" },
    { wamid: "w1", reply_key: "cats", decision: "replied", lang: "ar" },
  ];
  const f = U.convFacts(rows);
  assert.deepEqual([f.lastKey, f.lang, f.saidNo], ["item", "en", false]);
  assert.deepEqual(f.looked, [{ key: "item", arg: "8" }, { key: "cat", arg: "23" }]);
  assert.equal(U.convFacts([{ wamid: "w9", reply_key: "unknown" }, { wamid: "w8", reply_key: "nack" }]).saidNo, true);
  assert.equal(U.convFacts([{ wamid: "w9", reply_key: "rf_no", decision: "replied" }]).lastKey, "rf_no");
  assert.deepEqual(U.convFacts([]), { lastKey: null, lang: "ar", saidNo: false, looked: [] });
});

test("اللي شافه: الأحدث اللي لسه متاح — صنف (مش خلص، مش إضافات) / بوكس بقسم وسعر / قسم أكل (مش الأكثر طلباً ولا الإضافات)؛ الوزن ⇒ الصنف بالوزن", () => {
  const menu = WB.indexMenu(LIVE.pages, {});
  const bundles = LIVE.bundles;
  assert.deepEqual(U.pickLooked([{ key: "item", arg: "8" }, { key: "cat", arg: "23" }], { menu, bundles }), { kind: "item", id: "8", name: "كريب زنجر سوبريم", nameEn: menu.items.find((i) => i.id === "8").nameEn || "كريب زنجر سوبريم", price: 25, byWeight: false });
  const sold = WB.indexMenu(LIVE.pages, { soldOut: { 8: true } });
  assert.equal(U.pickLooked([{ key: "item", arg: "8" }, { key: "cat", arg: "23" }], { menu: sold, bundles }).kind, "section", "sold out today ⇒ the next thing he looked at");
  assert.deepEqual(U.pickLooked([{ key: "cat", arg: "23" }], { menu, bundles }), { kind: "section", id: "23", name: "كريبات", nameEn: "Crepes" });
  assert.equal(U.pickLooked([{ key: "cat", arg: "38" }], { menu, bundles }), null, "Best Sellers is not a section to follow up on");
  assert.equal(U.pickLooked([{ key: "cat", arg: "26" }], { menu, bundles }), null, "sides and drinks: no");
  const side = (LIVE.pages.find((p) => p.title === "Sides & Drinks").items[0] || {}).id;
  assert.equal(U.pickLooked([{ key: "item", arg: String(side) }], { menu, bundles }), null);
  const box = U.pickLooked([{ key: "box", arg: "box-solo-crepe" }], { menu, bundles });
  assert.deepEqual([box.kind, box.slug, box.name, box.price], ["box", "box-solo-crepe", "بوكس الكريب الفردي", 29]);
  assert.equal(U.pickLooked([{ key: "box", arg: "gathering-4" }], { menu, bundles }), null, "a gathering pack has no section: not a box card");
  const wt = U.pickLooked([{ key: "weight", arg: JSON.stringify({ id: "97", parts: [[51, 1]] }) }], { menu, bundles });
  assert.deepEqual([wt.kind, wt.id, wt.byWeight], ["item", "97", true]);
  assert.equal(U.pickLooked([{ key: "item", arg: "999999" }], { menu, bundles }), null);
  assert.equal(U.pickLooked([{ key: "item", arg: "8" }], { menu: null, bundles }), null);
});

test("سطر العرض القصير: «الاسم بـX ر.س» + سطر التوصيل زي ما اتقال في الحملة بالظبط لو كان رسم مؤكد لعنوانه؛ من غير عنوان ⇒ السعر بس", () => {
  assert.equal(U.offerPhrase({ shortMain: "بوكس الكريب لشخصين بـ65 ر.س", delivery: "no_location", dlText: "وأول طلب من الموقع توصيله مجاني بكود FIRST داخل نطاق التوصيل" }), "بوكس الكريب لشخصين بـ65 ر.س");
  assert.equal(U.offerPhrase({ shortMain: "بوكس الكريب لشخصين بـ65 ر.س", delivery: "fee", dlText: "والتوصيل لعنوانك 15 ر.س" }), "بوكس الكريب لشخصين بـ65 ر.س، والتوصيل لعنوانك 15 ر.س");
  assert.equal(U.offerPhrase({ delivery: "fee" }), null); assert.equal(U.offerPhrase(null), null);
});

test("الـSQL: كل جملة بعلامتها /*fu:…*/ في أولها، والمرشّحين بيستبعدوا اللي طلعله قالب تسويقي بعد رسالته ومش بيبعتوا لنافذة ليها شغلة", () => {
  for (const [k, s] of Object.entries(U.FU_SQL)) assert.match(s, /^\/\*fu:[a-z_]+\*\//, k);
  const c = U.FU_SQL.candidates;
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.ok(c.includes(`$${n}`), `candidates uses $${n}`);
  assert.match(c, /c\.created_at > w\.last_in\)/, "a newer marketing template after his message ⇒ not a candidate");
  assert.match(c, /j\.kind = 'reply_followup' AND j\.created_at >= w\.last_in/);
  assert.match(U.FU_SQL.ordered, /FROM shop_orders so[\s\S]*ts_orders/, "an order on the website OR at the till counts");
  assert.ok(U.FU_TAP_KEYS.includes("cats") && U.FU_TAP_KEYS.includes("cat") && !U.FU_TAP_KEYS.includes("status") && !U.FU_TAP_KEYS.includes("review_ok"));
  assert.ok(U.FU_CLOSING_KEYS.includes("thanks") && U.FU_CLOSING_KEYS.includes("stop") && U.FU_CLOSING_KEYS.includes("complaint"));
  assert.match(U.FU_DDL, /job_key TEXT UNIQUE/, "one ledger row per window");
});
