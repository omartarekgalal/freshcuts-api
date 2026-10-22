/* ════════════════════════════════════════════════════════════════════════════
   BF3 (٢٠/١٠/٢٠٢٦) — غلطتين حقيقيتين لماجد يوم ٢٠/١٠ (wa_assist_turns، قراية بس):
   ١) 20:45 «Online» و20:46 «Offers» (…4268، غالباً نص زر من إعلان) ⇒ ماجد رد إنجليزي كامل
      («I'm Majed, Fresh Cuts' digital assistant. Ordering is simple…» · «Here's what we have right now: … Crepe Solo Box — SAR 29»).
      القاعدة: كلمة إنجليزي لوحدها / نص زر ⇒ عربي؛ الإنجليزي بس لجملة إنجليزي حقيقية (أو محادثة إنجليزي قبلها).
   ٢) 18:18 «الشوي انهارده احسن من امبارح» (…5082، مدح) ⇒ «سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم» — غلط: المدح = شكر قصير، مش تحويل.
   الإعادة الكاملة (من الويب هوك لطلب Graph) في wabotrun.test.mjs قسم «BF3». الأرقام مقنّعة 5000000xx. node --test bf3-majed-tone.test.mjs
═════════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "./waguard.js";
import * as L from "./walearn.js";
import { detectLang, latinShort } from "./wabot.js";
const A = await import("./waassistrun.js");

const P = { r4268: "500000061", r5082: "500000062", en: "500000063", ok: "500000064", neg: "500000065" };

/* ── ١) اللغة ─────────────────────────────────────────────────────────────── */
test("BF3 language: «Online» / «Offers» and other lone English words or button texts are NOT the customer's language ⇒ Arabic", () => {
  for (const t of ["Online", "Offers", "Menu", "Hi", "Order", "hello", "Order now", "Order online", "See the menu", "View menu", "Get offer", "Send message", "Learn more", "More info", "Menu please", "I'm interested", "Hello! Can I get more info on this?", "ok thanks", "Pickup"]) {
    assert.equal(G.notRealEnglish(t), true, t);
    assert.equal(detectLang(t), "ar", `rules bot: ${t}`);
    assert.equal(A.turnLang(t, null), "ar", `Majed, first message: ${t}`);
    assert.equal(A.turnLang(t, "ar"), "ar", `Majed, Arabic chat: ${t}`);
  }
  /* الحادثة بالظبط: «Online» أول رسالة ⇒ عربي، و«Offers» بعدها (lang المحادثة اتسجّلت ar) ⇒ عربي — مش en من «Online» */
  const l1 = A.turnLang("Online", null); assert.equal(l1, "ar"); assert.equal(A.turnLang("Offers", l1), "ar");
});

test("BF3 language: a real English sentence still gets English, and an English chat keeps English on a short word after it", () => {
  for (const t of ["Do you deliver to Obhur?", "I want a family box for 5 people", "Can I see the menu please", "What time do you open today"]) {
    assert.equal(latinShort(t), false, t); assert.equal(detectLang(t), "en", t); assert.equal(A.turnLang(t, null), "en", t);
  }
  assert.equal(A.turnLang("Offers", "en"), "en", "English conversation ⇒ «Offers» stays English");
  assert.equal(A.turnLang("ok", "en"), "en");
  /* فرانكو وعربي زي ما هم */
  assert.equal(A.turnLang("abi menu", null), "ar"); assert.equal(A.turnLang("ابي المنيو", "en"), "ar");
  /* مش كلام: إيموجي / رقم ⇒ لغة الدور اللي قبله (زي قبل BF3) */
  assert.equal(A.turnLang("👍", "en"), "en"); assert.equal(A.turnLang("2", "ar"), "ar");
});

test("BF3 language: the dashboard switch off (shortEnglishArabic=false) ⇒ the old judgement (one word «Menu» ⇒ English), BF1 «Hello» stays Arabic", () => {
  assert.equal(detectLang("Menu", { shortAr: false }), "en");
  assert.equal(A.turnLang("Online", null, "ar", { shortAr: false }), "en");
  assert.equal(detectLang("Hello", { shortAr: false }), "ar", "BF1 J is not behind this switch");
  assert.equal(A.turnLang("Hello", null, "ar", { shortAr: false }), "ar");
});

/* ── ٢) المدح ─────────────────────────────────────────────────────────────── */
test("BF3 praise: «الشوي انهارده احسن من امبارح» and other compliments are praise; the thing praised fills the thank-you", () => {
  for (const [t, what] of [["الشوي انهارده احسن من امبارح", "الشوي"], ["الاكل انهارده احسن من امبارح", "الأكل"], ["الشوي اليوم احسن", "الشوي"], ["الطعم رهيب", "الأكل"],
    ["تحفه", "الأكل"], ["تخفه", "الأكل"], ["ما شاء الله تبارك الله", "الأكل"], ["تسلم ايدكم", "الأكل"], ["الكريب اليوم ممتاز", "الكريب"], ["الخدمه ممتازه", "التعامل"],
    ["وصل الطلب والاكل لذيذ", "الأكل"], ["The food was amazing", "الأكل"], ["مطعمكم الأفضل عندي", "الأكل"]]) {
    assert.equal(G.complimentOnly(t), true, t); assert.equal(G.praiseWhat(t).ar, what, t);
  }
  assert.deepEqual(G.praiseWhat("الشوي انهارده احسن من امبارح"), { ar: "الشوي", en: "the grill" });
});

test("BF3 praise: negative feedback, a question, an order or a bare «حلو / طيب / ممتاز» is NOT praise (complaint / Majed / ack paths stay)", () => {
  for (const t of ["بس مجاش سبايسي", "الشوي احسن من امبارح بس بارد", "امبارح كان احسن", "اللحم كان احسن الاسبوع اللي فات", "الشوي مو احسن من امبارح", "الاكل حلو بس متأخر", "طلبي وصل بارد",
    "الاكل حلو؟", "اي افضل وجبه", "الدجاج اليوم احسن ولا اللحم", "وش احسن شي عندكم", "ابي اطلب الشوي اللي احسن", "حلو", "طيب", "زين", "ممتاز", "تمام", "شكرا", "Online"]) assert.equal(G.complimentOnly(t), false, t);
});

/* ── ٣) سجل الأخطاء والدروس ───────────────────────────────────────────────── */
test("BF3 registry: the 20/10 mistakes are confirmed review rows (masked phones), with a lesson for Majed on each pattern", () => {
  const rows = L.REVIEW_SEED.filter((r) => r.mkey.startsWith("rev2010:"));
  assert.deepEqual(rows.map((r) => [r.mkey, r.type, r.phone_masked, r.day]), [
    ["rev2010:J:4268a", "wrong_language", "…4268", "2026-10-20"], ["rev2010:J:4268b", "wrong_language", "…4268", "2026-10-20"], ["rev2010:P:5082", "misunderstood", "…5082", "2026-10-20"]]);
  for (const r of rows) { assert.ok(r.example && r.wrong_reply && r.correct && r.guard, r.mkey); assert.doesNotMatch(`${r.example} ${r.wrong_reply}`, /05\d{8}|9665\d{8}|\b5\d{8}\b/); }
  assert.match(rows[0].example, /Online/); assert.match(rows[1].example, /Offers/); assert.match(rows[2].example, /الشوي انهارده احسن من امبارح/);
  assert.match(rows[2].wrong_reply, /سؤالك يحتاج واحد من الفريق/); assert.match(rows[2].correct, /تسلم، يسعدنا إن الشوي عجبك 🙏 ننتظرك دايماً/);
  assert.deepEqual(rows.map((r) => r.lesson_on), [true, false, true], "one lesson per pattern (no duplicate line)");
  /* كل الدروس (١٩/١٠ + ٢٠/١٠) بتدخل في الحد الافتراضي ١٥٠٠ حرف، والأحدث (٢٠/١٠) أول */
  const all = L.REVIEW_SEED.filter((r) => r.lesson_on).map((r, i) => ({ ...r, id: i + 1, status: "confirmed" })).reverse();
  const t = L.lessonsText(all, L.LEARN_DEFAULTS.lessonsMaxChars);
  assert.equal(t.ids.length, all.length, `all ${all.length} lessons fit in ${L.LEARN_DEFAULTS.lessonsMaxChars} chars (${t.text.length})`);
  const lines = t.text.split("\n");
  /* MJ1: دروس ٢٢/١٠ بقت الأحدث (أول) — درسين BF3 لسه موجودين ومش مقصوصين */
  assert.ok(lines.some((l) => /تحوّل مدح الأكل/.test(l))); assert.ok(lines.some((l) => /ترد بالإنجليزي على كلمة إنجليزي لوحدها/.test(l)));
  assert.equal(lines.length, all.length + 1, "one line per lesson");
});

test("BF3 settings: two new dashboard switches (on by default) with Arabic label + help; the group now has 17", () => {
  const ar = (s) => /[؀-ۿ]/.test(String(s || ""));
  for (const k of ["shortEnglishArabic", "praiseThanks"]) {
    assert.equal(L.LEARN_DEFAULTS[k], true, k); assert.ok(L.LEARN_BOOLS.includes(k), k); assert.ok(ar(L.LEARN_SCHEMA[k].ar) && ar(L.LEARN_SCHEMA[k].help), k);
    assert.equal(L.learnConfig({})[k], true); assert.equal(L.learnConfig({ [k]: false })[k], false);
  }
  assert.equal(Object.keys(L.LEARN_SCHEMA).length, 28);      // MJ1: + ١١
});

/* ── ٤) الفحص الليلي بيمسك النوعين دول من نفسه ───────────────────────────── */
test("BF3 self-review: an English reply to a lone English word, and a compliment handed to staff, are filed as suspected; correct replies are not", async () => {
  const day = "2026-10-20", filed = [];
  const rep = (body) => [{ type: "text", text: { body } }];
  const rows = [
    /* …4268 بالنص */
    { id: 944, phone_norm: P.r4268, at: "2026-10-20T17:45:00Z", reply_key: "assist", text: "Online", lang: "ar", handoff: null, replies: rep("I'm Majed, Fresh Cuts' digital assistant.\nOrdering is simple: tell me what you'd like and I can set up a cart with the prices.\nYou tap the button, then choose delivery or pickup on our website and pay there.\n\nWhat would you like to order, Mohammed?") },
    { id: 945, phone_norm: P.r4268, at: "2026-10-20T17:46:00Z", reply_key: "assist", text: "Offers", lang: "ar", handoff: null, replies: rep("Here's what we have right now:\n\n🔥 Our offers now:\n• *Crepe Solo Box* — SAR 29\n• *Crepe Box for Two* — SAR 65\n• *Variety Box* — SAR 105") },
    /* …5082 بالنص */
    { id: 937, phone_norm: P.r5082, at: "2026-10-20T15:18:00Z", reply_key: "assist", text: "الشوي انهارده احسن من امبارح", lang: "ar", handoff: "needs_staff", replies: rep("سؤالك يحتاج واحد من الفريق 🙏 حوّلته لهم.\nيرد عليك موظف هنا في أقرب وقت، وأنا معك لو تحتاج شي ثاني.") },
    /* عميل إنجليزي حقيقي: جملة ثم «Offers» ⇒ الإنجليزي صح */
    { id: 950, phone_norm: P.en, at: "2026-10-20T18:00:00Z", reply_key: "assist", text: "Do you have a family box for 5 people?", lang: "en", handoff: null, replies: rep("Yes, we have family boxes from SAR 85, tell me what you like and I will set it up.") },
    { id: 951, phone_norm: P.en, at: "2026-10-20T18:01:00Z", reply_key: "assist", text: "Offers", lang: "en", handoff: null, replies: rep("Here is what we have right now for you today:\n• Crepe Solo Box — SAR 29") },
    /* رد صح: «Online» ⇒ عربي، والمدح ⇒ شكر */
    { id: 952, phone_norm: P.ok, at: "2026-10-20T18:05:00Z", reply_key: "assist", text: "Online", lang: "ar", handoff: null, replies: rep("هلا 👋 معك ماجد، المساعد الرقمي لفريش كاتس. وش تحب تطلب اليوم؟") },
    { id: 953, phone_norm: P.ok, at: "2026-10-20T18:06:00Z", reply_key: "praise", text: "تخفه", lang: "ar", handoff: null, replies: rep("تسلم، يسعدنا إن الأكل عجبك 🙏 ننتظرك دايماً") },
    /* شكوى فيها كلمة حلوة ⇒ التحويل صح */
    { id: 954, phone_norm: P.neg, at: "2026-10-20T18:10:00Z", reply_key: "complaint", text: "الشوي احسن من امبارح بس بارد", lang: "ar", handoff: "complaint", replies: rep("نعتذر منك على اللي صار 🙏 حوّلت محادثتك لمدير الفرع") },
  ];
  const q = async (sql, p = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^INSERT INTO wa_bot_mistakes/.test(s)) { filed.push({ type: p[1], phone: p[3], example: p[4] }); return [{ inserted: true }]; }
    if (/^(INSERT|UPDATE|DELETE)/.test(s)) throw new Error("self-review must not write: " + s.slice(0, 40));
    if (/\/\*sr:replies\*\//.test(s)) { assert.match(s, /SELECT id, phone_norm, at, reply_key, replies, text, lang, handoff FROM wa_bot_log/); return rows; }
    return [];
  };
  const learn = L.makeLearn({ q, jb: JSON.stringify, menuIndex: async () => ({ items: [] }), bundles: async () => [], getSettings: async () => null });
  const r = await learn.runSelfReview(day, { max: 60 });
  assert.deepEqual(filed.map((f) => [f.type, f.phone, f.example]), [
    ["wrong_language", "…0061", "«Online»"], ["wrong_language", "…0061", "«Offers»"],
    ["misunderstood", "…0062", "مدح: «الشوي انهارده احسن من امبارح»"]]);
  assert.equal(r.filed, 3);
});
