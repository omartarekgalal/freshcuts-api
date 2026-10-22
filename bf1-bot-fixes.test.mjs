/* ════════════════════════════════════════════════════════════════════════════
   BF1 (١٩/١٠/٢٠٢٦) — اختبارات الوحدات لحرّاس مراجعة ١٩/١٠ والتعلّم من الأخطاء
   (waguard.js · waorders.js · walearn.js · decide). الإعادة الكاملة للمحادثات (من الويب هوك لطلب Graph) في wabotrun.test.mjs، قسم «BF1».
   الأرقام كلها مقنّعة 5000000xx. node --test bf1-bot-fixes.test.mjs
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "./waguard.js";
import * as O from "./waorders.js";
import * as L from "./walearn.js";
const R = await import("./wabotrun.js");

/* ── D: حارس الوعود ───────────────────────────────────────────────────────── */
test("D promise guard: the review's exact sentences are caught; questions, conditionals and real carts are not", () => {
  const kinds = (t, a = {}) => G.promiseProblems(t, a).map((p) => p.kind);
  assert.deepEqual(kinds("أضفت كريب زنجر سوبريم وكتبت للمطبخ ملاحظة حار زيادة 🌶️"), ["kitchen", "added"], "…6102 18/10");
  assert.deepEqual(kinds("أضفت كريب زنجر سوبريم وكتبت للمطبخ ملاحظة حار زيادة", { cartTouched: true }), ["kitchen"], "even with a priced cart, nothing reaches the kitchen");
  assert.deepEqual(kinds("مقفلين الحين، ونفتح الساعة 12، وأجهّز لك السلة من الحين تكملها وقت ما نفتح."), ["prepared"], "…6102 19/10");
  assert.deepEqual(kinds("أبشر، نجهّز لك الطلب. تبي نفس الطلب السابق؟"), ["prepared"], "…0558");
  assert.deepEqual(kinds("طلبك جاهز للاستلام"), ["order_state"]);
  assert.deepEqual(kinds("تم تأكيد طلبك ✅"), ["order_state"]);
  assert.deepEqual(kinds("وصل طلبك للمطبخ"), ["kitchen"]);
  for (const ok of ["بوكس التشكيلة بـ 105 ر.س. أجهّزه لك؟", "تحب أضيف لك أرز؟", "وإذا زدت عليه 20 ر.س يصير التوصيل 15 ر.س.", "لو عرض من إعلاننا قل لي اسمه وأجهّزه لك."]) assert.deepEqual(kinds(ok), [], ok);
  assert.deepEqual(kinds("أضفت البيبسي، المجموع 56 ر.س. شي ثاني؟", { cartTouched: true }), [], "added to a priced cart");
  assert.deepEqual(kinds("سلتك جاهزة: نص دجاجة = 28 ر.س. اضغط الزر", { cartBuilt: true }), []);
  assert.deepEqual(kinds("سلتك جاهزة: نص دجاجة = 28 ر.س. اضغط الزر"), ["prepared"], "no cart built ⇒ refused");
  assert.deepEqual(kinds("I've added it and sent it to the kitchen"), ["kitchen", "added"]);
});

test("H go-ahead: «جهّزه / جهزها علي ما اوصل / أبغى أطلب / اطلب لي / اعتمد» and the «أبغى أطلب» tap; an extra item or a note is not a go-ahead", () => {
  for (const t of ["إيه، جهّزه ✅", "جهزها علي ما اوصل", "أبغى أطلب", "اطلب لي", "تمام اعتمد", "يلا كمل الطلب", "ok go ahead"]) assert.equal(G.isGoAhead(t), true, t);
  for (const t of ["وكريب سوبر زنجر حراق", "جهزه بس بدون بصل", "كم سعر الكريب؟", "", null]) assert.equal(G.isGoAhead(t), false, String(t));
  assert.equal(G.isGoAhead("", "أبغى أطلب"), true); assert.equal(G.isGoAhead("", "as:yes"), true); assert.equal(G.isGoAhead("", "bot:menu"), false);
});

test("I spam · A/D «أنا جاي» · J language · E location confirm · F staff by name · …7858 social link · …3214 praise", () => {
  assert.equal(G.spamKind("https://temu.to/k/eabc123 Join me"), "link"); assert.equal(G.spamKind("اربح هدية مجانية سجل الان واحصل"), "promo"); assert.equal(G.spamKind("ابي كريب"), null);
  for (const t of ["انا جاي", "أنا في الطريق", "٢ دقيقة وأكون عندكم", "وصلت", "جاي استلم"]) assert.equal(G.comingKind(t), "coming", t);
  for (const t of ["جاي معاه رز؟", "ابي اطلب"]) assert.equal(G.comingKind(t), null, t);
  for (const t of ["Hello", "hi", "Hey there", "good evening"]) assert.equal(G.loneLatinGreeting(t), true, t);
  assert.equal(G.loneLatinGreeting("hello where is my order"), false);
  assert.equal(G.adPrefillEn("Hello! Can I get more info on this?"), true); assert.equal(G.adPrefill("أبغى أعرف أكثر"), true);
  assert.equal(G.locationConfirm("ده الموقع مظبوط"), true); assert.equal(G.locationConfirm("هذا موقعي صح"), true);
  for (const t of ["ارسل موقع المحل", "وين موقعكم؟", "الموقع فين"]) assert.equal(G.locationConfirm(t), false, t);
  assert.equal(G.asksStaffByName("استاذ محمد حضرتك؟"), true); assert.equal(G.asksStaffByName("ابي محمد مشوي"), false);
  assert.equal(G.socialLink("https://www.facebook.com/reel/123"), true); assert.equal(G.socialLink("https://freshcuts.sa/menu"), false);
  assert.equal(G.praiseOnly("طلبت خلاص… مطعمكم الأفضل عندي"), true); assert.equal(G.praiseOnly("شكرا، كم سعر الكريب؟"), false);
});

test("G expired campaign: party size from the offer name, then the closest live box for that size", () => {
  assert.equal(G.partySizeOf("جمعتكم الليلة أو بكره؟ باقة التجمّع لـ4 إلى 6 أشخاص"), 5);
  assert.equal(G.partySizeOf("بوكس الكريب لشخصين"), 2); assert.equal(G.partySizeOf("اخترنا لك بوكس الميكس جريل الفردي"), 1); assert.equal(G.partySizeOf("بوكس العائلة"), 4); assert.equal(G.partySizeOf("عرض اليوم"), null);
  const B = [{ slug: "solo-a", price: 29, section: "بوكسات فردية" }, { slug: "duo-a", price: 65, section: "بوكسات لشخصين" }, { slug: "fam-a", price: 179, section: "بوكسات المشاركة والعائلة" }, { slug: "fam-b", price: 105, section: "بوكسات المشاركة والعائلة" }, { slug: "pack-10", price: 395, section: "" }];
  assert.equal(G.altBoxFor({ people: 5, price: 225, bundles: B }).slug, "fam-a", "…4333: 4–6 people, 225 ⇒ the family box closest in price (179)");
  assert.equal(G.altBoxFor({ people: 5, price: null, bundles: B }).slug, "fam-a", "no price ⇒ the biggest family box");
  assert.equal(G.altBoxFor({ people: 2, price: 70, bundles: B }).slug, "duo-a");
  assert.equal(G.altBoxFor({ people: 10, price: 400, bundles: B }).slug, "pack-10", "7+ ⇒ a gathering pack");
  assert.equal(G.altBoxFor({ people: null, price: 50, bundles: B }), null);
});

/* ── A: «العميل طلب خلاص؟» من كل القنوات ─────────────────────────────────── */
test("A orders from every channel: site + POS (order_sources / ts_customers) in one query; db failure ⇒ null (callers do not sell blind)", async () => {
  const P = "500000041", seen = [];
  const q = async (sql, p) => { seen.push([sql, p]); return [{ channel: "pos", ref: "TS-9", at: "2026-10-18T14:58:00Z", status: "1", option: "dinein", total: 95, items: null }, { channel: "site", ref: "W17900", at: "2026-10-18T14:30:00Z", status: "paid", option: "delivery", total: 48, items: [{ name: "كريب زنجر سوبريم", quantity: 2, note: "حار" }, { product_name: "مشكل مخصوص بالوزن", variant_name: "نصف كيلو", quantity: 1 }] }]; };
  const r = await O.ordersSince(q, P, "2026-10-18T12:00:00Z");
  assert.match(seen[0][0], /FROM shop_orders so[\s\S]*UNION ALL[\s\S]*FROM ts_orders o LEFT JOIN order_sources s[\s\S]*LEFT JOIN ts_customers tc/);
  assert.deepEqual(seen[0][1].slice(0, 2), [P, "2026-10-18T12:00:00.000Z"]); assert.ok(seen[0][1][2].includes("pending_payment") && seen[0][1][2].includes("expired"));
  assert.deepEqual(r.map((x) => [x.channel, x.ref]), [["pos", "TS-9"], ["site", "W17900"]]);
  assert.deepEqual(r[1].items, [{ name: "كريب زنجر سوبريم", qty: 2, note: "حار" }, { name: "مشكل مخصوص بالوزن — نصف كيلو", qty: 1 }]);
  assert.equal(await O.ordersSince(async () => null, P, "2026-10-18T12:00:00Z"), null);
  assert.deepEqual(await O.ordersSince(q, "123", "2026-10-18T12:00:00Z"), [], "not a Saudi mobile ⇒ nothing");
  const b = O.existingOrderBrief(r, new Date("2026-10-18T15:00:00Z"), [{ name: "مشكل مخصوص بالوزن", qty: 1 }]);
  assert.deepEqual(b, { placed: "at the branch (cashier / dine-in / phone)", minutes_ago: 2, items: [{ name: "مشكل مخصوص بالوزن", qty: 1 }], count_last_hours: 2 });
});

/* ── B: الضغطة المتأخرة ───────────────────────────────────────────────────── */
test("B decide: a message older than maxAgeMinutes goes to staff only when TYPED; a tap is executed", () => {
  const cfg = R.botConfig({ waBot: { mode: "live" } }), now = new Date("2026-10-18T14:37:00Z");
  const ctx = { cfg, now, chat: {}, data: { settings: {} }, rate: { text: 0, taps: 0, minute: 0 } };
  const typed = R.decide({ phone: "500000042", text: "وين طلبي", type: "text", at: "2026-10-18T14:03:00Z" }, ctx);
  assert.deepEqual([typed.key, typed.handoff && typed.handoff[0]], ["staff", "late_message"]);
  const tap = R.decide({ phone: "500000042", text: "تابع طلبي", type: "button", interactiveId: "تابع طلبي", at: "2026-10-18T14:03:00Z" }, { ...ctx, cls: { key: "main", rawIntent: "menu", lang: "ar", score: 9 } });
  assert.notEqual(tap.handoff && tap.handoff[0], "late_message"); assert.notEqual(tap.key, "staff");
});

/* ── أ/ب/ج: سجل الأخطاء والدروس والفحص الليلي ─────────────────────────────── */
test("أ registry seed: every finding of the 19/10 review is a confirmed row with a known type, a masked phone, the wrong reply, the correct behaviour and the guard", () => {
  assert.ok(L.REVIEW_SEED.length >= 31);
  for (const r of L.REVIEW_SEED) {
    assert.ok(L.MISTAKE_TYPES[r.type], r.mkey); assert.match(r.mkey, /^rev1910:[A-L]:|^rev2010:[JP]:|^rev2210:[ACDRSX]:/);      /* BF3: + مراجعة ٢٠/١٠ · MJ1: + مراجعة ٢٢/١٠ */ assert.match(r.phone_masked, /^…\d{4}$/);
    assert.ok(r.example && r.correct && r.guard, r.mkey); assert.doesNotMatch(`${r.example} ${r.wrong_reply || ""}`, /05\d{8}|9665\d{8}|\b5\d{8}\b/, `${r.mkey}: no full phone`);
  }
  for (const letter of "ABCDEFGHIJKL") assert.ok(L.REVIEW_SEED.some((r) => r.mkey.startsWith(`rev1910:${letter}:`)), `finding ${letter} is in the registry`);
  assert.ok(L.REVIEW_SEED.filter((r) => r.lesson_on).length >= 6, "the wording findings carry a lesson for Majed");
});

test("ب lessons block: confirmed rows with a lesson only, deduplicated, capped, newest first", () => {
  const rows = [{ id: 1, status: "confirmed", lesson_on: true, lesson_dont: "تقول «كتبت للمطبخ»", lesson_do: "«كتبتها ملاحظة في سلتك»" }, { id: 2, status: "suspected", lesson_on: true, lesson_dont: "x" },
    { id: 3, status: "confirmed", lesson_on: false, lesson_dont: "y" }, { id: 4, status: "fixed", lesson_on: true, lesson_dont: "تقول «كتبت للمطبخ»", lesson_do: "«كتبتها ملاحظة في سلتك»" }, { id: 5, status: "confirmed", lesson_on: true, lesson_do: "ترد «حيّاك الله، نستناك 🌟» وتسكت" }];
  const t = L.lessonsText(rows, 4000);
  assert.deepEqual(t.ids, [1, 5]); assert.match(t.text, /^# Lessons from real mistakes/); assert.match(t.text, /- Never: تقول «كتبت للمطبخ»\. Instead: «كتبتها ملاحظة في سلتك»\./);
  assert.equal(L.lessonsText(rows, 200).ids.length, 1, "capped");
  assert.deepEqual(L.lessonsText([], 1500), { text: "", ids: [] });
  const seeded = L.lessonsText(L.REVIEW_SEED.map((r, i) => ({ ...r, id: i + 1, status: "confirmed" })), L.LEARN_DEFAULTS.lessonsMaxChars);
  assert.ok(seeded.text.length <= L.LEARN_DEFAULTS.lessonsMaxChars && seeded.ids.length >= 4);
});

test("أ registry edits: only known fields, values and lengths; the example is masked", () => {
  assert.deepEqual(L.mistakeFromBody({ status: "nope" }), { ok: false, errors: ["status"] });
  assert.equal(L.mistakeFromBody({ type: "broken_promise" }, { create: true }).ok, true);
  assert.deepEqual(L.mistakeFromBody({}, { create: true }), { ok: false, errors: ["type"] });
  const v = L.mistakeFromBody({ status: "confirmed", example: "العميل 0500000043 قال جهزها", lesson_on: true, phone_masked: "0500000043" });
  assert.equal(v.ok, true); assert.doesNotMatch(v.value.example, /0500000043/); assert.equal(v.value.phone_masked, "…0043"); assert.equal(v.value.lesson_on, true);
  assert.equal(L.mistakeFromBody({ lesson_dont: "x".repeat(300) }).ok, false);
});

test("ج self-review: deterministic checks over the day file «suspected» rows once (read-only on conversations); D guard hits, sales after an order, claimed-no-reply, late taps, unanswered handovers, price, dialect, recipe, out of hours, double replies", async () => {
  const P = "500000044", day = "2026-10-18", filed = [], writes = [];
  const menu = { items: [{ id: "13", name: "وجبة نصف دجاجة على الفحم", price: 28 }, { id: "103", name: "مشكل مخصوص بالوزن", weights: [{ price: 53 }, { price: 78 }, { price: 155 }] }] };
  const rep = (t) => [{ type: "text", text: { body: t } }];
  const q = async (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, " ");
    if (/^INSERT INTO wa_bot_mistakes/.test(s)) { if (filed.some((f) => f.mkey === p[0])) return [{ inserted: false }]; filed.push({ mkey: p[0], type: p[1], day: p[2], phone: p[3], example: p[4], wrong: p[5] }); return [{ inserted: true }]; }
    if (/^(INSERT|UPDATE|DELETE)/.test(s)) { writes.push(s.slice(0, 40)); return []; }
    if (/FROM wa_bot_guard_hits/.test(s)) return [{ id: 7, phone_norm: P, guard: "promise", kind: "kitchen", value: "وكتبت للمطبخ", text: "أضفت كريب وكتبت للمطبخ" }];
    if (/\/\*sr:sales\*\//.test(s)) return [{ id: 70, phone_norm: P, at: "2026-10-18T22:42:00Z", reply_key: "lead_nudge", replies: rep("أنا معك 🙂 قل لي كم شخص أنتم") }, { id: 71, phone_norm: P, at: "2026-10-18T22:53:00Z", reply_key: "lead_followup", replies: rep("وصلتنا رسالتك وما قدرنا نخدمك وقتها، نعتذر") }];
    if (/\/\*sr:claims\*\//.test(s)) return [{ id: 9, phone_norm: P, at: "2026-10-18T14:38:00Z", by_name: "كاشير" }];
    if (/\/\*sr:latetap\*\//.test(s)) return [{ id: 72, phone_norm: P, text: "تابع طلبي" }];
    if (/\/\*sr:unanswered\*\//.test(s)) return [{ id: 11, phone_norm: P, reason: "review_low", at: "2026-10-19T06:11:00Z" }];
    if (/\/\*sr:replies\*\//.test(s)) return [
      { id: 80, phone_norm: P, at: "2026-10-18T15:00:00Z", reply_key: "assist", replies: rep("وجبة نصف دجاجة على الفحم بـ 30 ر.س") },
      { id: 81, phone_norm: P, at: "2026-10-18T15:01:00Z", reply_key: "assist", replies: rep("عايز تضيف بطاطس؟") },
      { id: 82, phone_norm: P, at: "2026-10-18T15:02:00Z", reply_key: "assist", replies: rep("نتبلها بخلطة خاصة فيها 20 جرام بهارات") },
      { id: 83, phone_norm: P, at: "2026-10-18T05:30:00Z", reply_key: "lead_followup", replies: rep("وش تحب تطلب؟") },
      { id: 84, phone_norm: P, at: "2026-10-18T15:03:00Z", reply_key: "assist", replies: rep("مشكل مخصوص بالوزن: نصف كيلو 78 ر.س") }];
    if (/\/\*sr:double\*\//.test(s)) return [{ id: 85, phone_norm: P, at: "2026-10-18T15:53:00Z" }];
    return [];
  };
  const settings = { hours: { enabled: true, days: Object.fromEntries(["sat", "sun", "mon", "tue", "wed", "thu", "fri"].map((d) => [d, { open: "12:00", close: "02:00" }])) } };
  const learn = L.makeLearn({ q, jb: JSON.stringify, now: () => new Date("2026-10-19T01:30:00Z"), menuIndex: async () => menu, bundles: async () => [], getSettings: async () => settings });
  const r = await learn.runSelfReview(day, { max: 60 });
  const types = filed.map((f) => f.type);
  for (const t of ["broken_promise", "sold_after_order", "apology_after_order", "staff_claim_silent", "late_tap_handover", "handover_unanswered", "wrong_price", "dialect_egyptian", "recipe_disclosure", "out_of_hours_send", "double_reply"]) assert.ok(types.includes(t), `${t} filed (${types.join(",")})`);
  assert.equal(types.filter((t) => t === "wrong_price").length, 1, "the right weight price (78) is not a mistake");
  assert.ok(filed.every((f) => f.phone === "…0044" && f.day === day), "masked phone, the day");
  assert.equal(r.filed, filed.length); assert.ok(!writes.some((w) => /wa_messages|wa_bot_log|shop_orders/.test(w)), "read-only on conversations");
  const again = await learn.runSelfReview(day, { max: 60 });
  assert.equal(again.filed, 0, "a second run files nothing new (same keys)");
});

test("ج nightly gate: after selfReviewHour:selfReviewMinute Riyadh, once per business day (claimed in wa_selfreview_runs), off ⇒ nothing", async () => {
  const runs = new Set(); let ran = 0;
  const q = async (sql, p = []) => { const s = String(sql);
    if (/INSERT INTO wa_selfreview_runs/.test(s)) { if (runs.has(p[0])) return []; runs.add(p[0]); return [{ day: p[0] }]; }
    if (/sr:replies/.test(s)) { ran++; return []; } return []; };
  const learn = L.makeLearn({ q, jb: JSON.stringify });
  const lc = L.learnConfig({});
  assert.equal(await learn.maybeNightly(new Date("2026-10-19T01:20:00Z"), lc), null, "04:20 Riyadh: not yet");
  const a = await learn.maybeNightly(new Date("2026-10-19T01:31:00Z"), lc);
  assert.equal(a.day, "2026-10-18"); assert.equal(ran, 1);
  assert.equal(await learn.maybeNightly(new Date("2026-10-19T01:45:00Z"), lc), null, "once");
  assert.equal(await learn.maybeNightly(new Date("2026-10-20T01:31:00Z"), { ...lc, selfReview: false }), null, "switch off");
});

test("settings: every BF1 knob is a dashboard setting with a schema row, safe defaults, and range checks on save", () => {
  const def = R.botConfig({});
  assert.deepEqual([def.orderAwareHours, def.promiseGuard, def.goAheadCart, def.campExpiredAlt, def.staffStopsMajed, def.claimSilentMin, def.claimEscalate, def.closedComplaintAtOpen, def.spamQuiet, def.lessonsEnabled, def.lessonsMaxChars, def.selfReview, def.selfReviewHour, def.selfReviewMinute],
    [3, true, true, true, true, 3, true, true, true, true, 2000, true, 4, 30]);      // MJ1: الدروس ١٥٠٠ ⇒ ٢٠٠٠ حرف
  for (const k of Object.keys(L.LEARN_DEFAULTS)) assert.ok(R.SCHEMA[k], `${k} has a schema row`);
  const bad = R.configFromBody({ claimSilentMin: 99 }, {}); assert.equal(bad.ok, false); assert.ok(bad.errors.includes("claimSilentMin"));
  const ok = R.configFromBody({ claimSilentMin: 5, selfReview: false, orderAwareHours: 6 }, {}); assert.equal(ok.ok, true);
  assert.deepEqual([R.botConfig({ waBot: ok.value }).claimSilentMin, R.botConfig({ waBot: ok.value }).selfReview, R.botConfig({ waBot: ok.value }).orderAwareHours], [5, false, 6]);
  for (const k of ["coming", "loc_ok", "spam_line", "camp_alt_body", "bf_sg_after", "location_map"]) { assert.ok(R.TEXTS[k], k); assert.doesNotMatch(R.TEXTS[k].ar, /\d/, `${k}: no digit in the text`); assert.doesNotMatch(R.TEXTS[k].ar, L.DIALECT_EG_RE, `${k}: not Egyptian`); }
});
