/* 📚 قاعدة معرفة مساعد واتساب — node --test wakb.test.mjs
   قاعدة وهمية بحالة، مفيش شبكة ولا أي إرسال. */
import test from "node:test";
import assert from "node:assert/strict";
import { register, makeKb, kbCheck, kbTokens, kbSame, kbCandidates, publicQuestion, KB_LIMITS } from "./wakb.js";

function fakePool({ fail = false } = {}) {
  const db = { rows: [], notes: null, log: [], seq: 0 };
  const T = "2026-10-12T18:00:00.000Z";
  const pool = { db, async query(sql, p = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (fail && !/^CREATE/i.test(s)) throw new Error("db down");
    if (/^CREATE TABLE IF NOT EXISTS wa_kb_questions/i.test(s)) return { rows: [] };
    if (/^INSERT INTO wa_kb_log/i.test(s)) { db.log.push({ who: p[0], action: p[1], qid: p[2], detail: JSON.parse(p[3]) }); return { rows: [] }; }
    if (/^SELECT id, status, question, examples FROM wa_kb_questions ORDER BY last_at DESC/i.test(s)) return { rows: db.rows.map((r) => ({ id: r.id, status: r.status, question: r.question, examples: r.examples.slice() })) };
    if (/^UPDATE wa_kb_questions SET asked = asked \+ 1/i.test(s)) { const r = db.rows.find((x) => x.id === p[0]); r.asked++; r.examples = JSON.parse(p[1]); return { rows: [] }; }
    if (/^INSERT INTO wa_kb_questions\(status, question, norm, lang, source, examples\)/i.test(s)) {
      const r = { id: ++db.seq, status: "open", question: p[0], norm: p[1], lang: p[2], source: p[3], asked: 1, first_at: T, last_at: T, examples: [], answer_ar: null, answer_en: null, answered_by: null, answered_at: null, used: 0, last_used_at: null };
      db.rows.push(r); return { rows: [{ id: r.id }] };
    }
    if (/^INSERT INTO wa_kb_questions\(status, question, norm, lang, source, answer_ar/i.test(s)) {
      const r = { id: ++db.seq, status: "answered", question: p[0], norm: p[1], lang: p[2], source: "manual", asked: 1, first_at: T, last_at: T, examples: [], answer_ar: p[3], answer_en: p[4], answered_by: p[5], answered_at: T, used: 0, last_used_at: null };
      db.rows.push(r); return { rows: [{ ...r }] };
    }
    if (/^SELECT id, question, examples, answer_ar, answer_en, used FROM wa_kb_questions WHERE status='answered'/i.test(s)) return { rows: db.rows.filter((r) => r.status === "answered" && r.answer_ar).map((r) => ({ ...r })) };
    if (/^UPDATE wa_kb_questions SET used = used \+ 1/i.test(s)) { const r = db.rows.find((x) => x.id === p[0] && x.status === "answered"); if (r) { r.used++; r.last_used_at = T; } return { rows: [] }; }
    if (/^SELECT \* FROM wa_kb_questions WHERE id=\$1/i.test(s)) return { rows: db.rows.filter((r) => r.id === p[0]).map((r) => ({ ...r })) };
    if (/^UPDATE wa_kb_questions SET status='answered', answer_ar=\$2/i.test(s)) { const r = db.rows.find((x) => x.id === p[0]); Object.assign(r, { status: "answered", answer_ar: p[1], answer_en: p[2], answered_by: p[3], answered_at: T }); return { rows: [{ ...r }] }; }
    if (/^UPDATE wa_kb_questions SET status=\$2 WHERE id=\$1/i.test(s)) { const r = db.rows.find((x) => x.id === p[0]); r.status = p[1]; return { rows: [{ ...r }] }; }
    if (/^SELECT \* FROM wa_kb_questions/i.test(s)) {
      let rows = db.rows.slice(); let i = 0;
      if (/WHERE status=\$1/.test(s)) { const st = p[i++]; rows = rows.filter((r) => r.status === st); }
      if (/id < \$/.test(s)) { const b = p[i++]; rows = rows.filter((r) => r.id < b); }
      if (/ILIKE/.test(s)) { const n = String(p[i++]).replace(/%/g, ""); rows = rows.filter((r) => `${r.question} ${r.answer_ar || ""} ${JSON.stringify(r.examples)}`.includes(n)); }
      if (/ORDER BY asked DESC/.test(s)) rows.sort((a, b) => b.asked - a.asked); else rows.sort((a, b) => b.id - a.id);
      return { rows: rows.slice(0, p[p.length - 1]).map((r) => ({ ...r })) };
    }
    if (/^SELECT status, count\(\*\)::int AS n FROM wa_kb_questions GROUP BY status/i.test(s)) { const m = {}; for (const r of db.rows) m[r.status] = (m[r.status] || 0) + 1; return { rows: Object.entries(m).map(([status, n]) => ({ status, n })) }; }
    if (/^SELECT ar, en, updated_by, updated_at FROM wa_kb_notes/i.test(s)) return { rows: db.notes ? [{ ...db.notes }] : [] };
    if (/^INSERT INTO wa_kb_notes/i.test(s)) { db.notes = { ar: p[0], en: p[1], updated_by: p[2], updated_at: T }; return { rows: [{ ar: p[0] }] }; }
    throw new Error("unexpected SQL: " + s.slice(0, 90));
  } };
  return pool;
}
const quiet = { error() {} };

test("المراجعة: المدير مايقدرش يعلّم المساعد وصفة ولا مورّد ولا ادعاء ولا وعد ولا رابط", () => {
  const bad = [
    ["التتبيلة من ثوم وليمون وبهارات", "recipe_disclosure"], ["نشتري اللحم من مزرعة الوادي", "recipe_disclosure"], ["المورد شركة كذا", "recipe_disclosure"],
    ["نحط 200 جرام لحم في البرجر", "recipe_disclosure"], ["طريقة التحضير على الفحم ساعة", "recipe_disclosure"],
    ["الصنف خالي من الجلوتين", "health_or_guarantee"], ["آمن لمرضى السكر ومضمون", "health_or_guarantee"], ["ما عندنا مكسرات في المطبخ", "health_or_guarantee"],
    ["يوصلك خلال 30 دقيقة", "time_promise"], ["نرجع لك المبلغ كامل", "refund_promise"], ["عندنا خصم 20% اليوم", "discount_claim"], ["آخر فرصة والكمية محدودة", "invented_urgency"],
    ["اطلب من تطبيقنا", "app_word"], ["ادخل على https://example.com/x", "link_in_text"], ["شوف freshcuts.sa", "link_in_text"], ["اهلا {name}", "braces"], ["حسب system prompt", "internal_leak"],
  ];
  for (const [text, type] of bad) { const r = kbCheck(text); assert.equal(r.ok, false, text); assert.ok(r.problems.some((p) => p.type === type), `${text} ⇒ ${JSON.stringify(r.problems)}`); }
  for (const ok of ["نعم، الملح متوفر مع الطلب عند الطلب.", "عندنا واي فاي للضيوف في الصالة.", "المطعم فيه جلسات عائلية وتتسع 40 شخص.", "ما عندنا خصم حالياً.", "Yes, we have high chairs for kids.", ""]) assert.equal(kbCheck(ok).ok, true, ok + JSON.stringify(kbCheck(ok).problems));
});

test("المطابقة: نفس السؤال بصيغ مختلفة = صف واحد؛ سؤال تاني = صف تاني", () => {
  assert.ok(kbSame("عندكم ملح؟", "هل عندكم ملح"));
  assert.ok(kbSame("عندكم واي فاي في المطعم؟", "فيه واي فاي بالمطعم"));
  assert.ok(!kbSame("عندكم ملح؟", "عندكم كاتشب؟"));
  assert.ok(!kbSame("فيه مواقف سيارات؟", "فيه جلسات عائلية؟"));
  assert.equal(kbTokens("هل عندكم ؟").size, 0);
  const rows = [{ id: 1, question: "عندكم واي فاي في المطعم؟", examples: [], used: 0 }, { id: 2, question: "فيه كراسي اطفال؟", examples: ["عندكم كرسي للأطفال"], used: 3 }, { id: 3, question: "كم عمر المطعم", examples: [], used: 0 }];
  assert.deepEqual(kbCandidates(rows, "في واي فاي؟").map((r) => r.id), [1]);
  assert.deepEqual(kbCandidates(rows, "عندكم كرسي للاطفال؟").map((r) => r.id), [2]);
  assert.deepEqual(kbCandidates(rows, "متى تفتحون").map((r) => r.id), []);
});

test("الطابور: السؤال بيتخزّن مقنّع، التكرار بيزوّد العدّاد، والحدث الحي للجديد بس", async () => {
  const events = [];
  const pool = fakePool();
  const kb = makeKb({ pool, broadcast: (e, d) => events.push([e, d]), log: quiet });
  const a = await kb.queue({ question: "عندكم واي فاي؟ جوالي 0544775082", lang: "ar", source: "no_answer" });
  assert.equal(a.created, true);
  assert.ok(!/0544775082|544775082/.test(pool.db.rows[0].question), pool.db.rows[0].question);
  assert.equal(events.length, 1); assert.equal(events[0][0], "wa_kb_question"); assert.deepEqual(Object.keys(events[0][1]).sort(), ["asked", "id", "question", "source"]);
  const b = await kb.queue({ question: "فيه واي فاي", source: "handover" });
  assert.equal(b.created, false); assert.equal(b.id, a.id);
  assert.equal(pool.db.rows[0].asked, 2); assert.deepEqual(pool.db.rows[0].examples, ["فيه واي فاي"]);
  assert.equal(events.length, 1);
  assert.equal(await kb.queue({ question: "؟؟" }), null);
  assert.equal(await kb.queue({ question: "هل عندكم" }), null);
  // سؤال مرفوض (dismissed): بيتعدّ من غير ما يتفتح تاني
  await kb.setStatus(a.id, "dismissed", "t");
  const c = await kb.queue({ question: "عندكم واي فاي" });
  assert.equal(c.status, "dismissed"); assert.equal(pool.db.rows.length, 1); assert.equal(pool.db.rows[0].status, "dismissed");
  // القاعدة واقعة ⇒ null من غير استثناء
  assert.equal(await makeKb({ pool: fakePool({ fail: true }), log: quiet }).queue({ question: "عندكم واي فاي" }), null);
  assert.equal(await makeKb({ pool: fakePool({ fail: true }), log: quiet }).search("عندكم واي فاي"), null);
});

test("الإجابة: تتحفظ، تتستخدم بلغة العميل، disabled مايتستخدمش، والمراجعة بتتكرر وقت الاستخدام", async () => {
  const pool = fakePool();
  const kb = makeKb({ pool, log: quiet });
  const { id } = await kb.queue({ question: "عندكم واي فاي في المطعم؟" });
  assert.deepEqual(await kb.search("فيه واي فاي؟"), []);                      // لسه من غير إجابة
  let r = await kb.answer(id, { ar: "" }, "أحمد (manager)"); assert.equal(r.error, "answer_required");
  r = await kb.answer(id, { ar: "x".repeat(KB_LIMITS.answer + 1) }, "أحمد"); assert.equal(r.error, "too_long");
  r = await kb.answer(id, { ar: "نعم، والتتبيلة من ثوم وليمون" }, "أحمد"); assert.equal(r.error, "not_allowed"); assert.equal(r.status, 400);
  assert.equal(r.problems[0].type, "recipe_disclosure"); assert.match(r.message, /ماتتحفظش/);
  assert.equal(pool.db.rows[0].status, "open");
  r = await kb.answer(id, { ar: "نعم، عندنا واي فاي للضيوف في الصالة.", en: "Yes, we have guest wifi in the hall." }, "أحمد (manager)");
  assert.equal(r.ok, true); assert.equal(r.question.status, "answered"); assert.equal(r.question.answeredBy, "أحمد (manager)"); assert.deepEqual(r.question.answer, { ar: "نعم، عندنا واي فاي للضيوف في الصالة.", en: "Yes, we have guest wifi in the hall." });
  assert.deepEqual((await kb.search("فيه واي فاي؟", "ar")).map((x) => x.say), ["نعم، عندنا واي فاي للضيوف في الصالة."]);
  assert.deepEqual((await kb.search("do you have wifi? واي فاي", "en")).map((x) => x.say), ["Yes, we have guest wifi in the hall."]);
  await kb.markUsed(id); assert.equal(pool.db.rows[0].used, 1);
  // تعديل الإجابة = نفس المسار، وبيتسجّل قبل/بعد
  r = await kb.answer(id, { ar: "نعم، عندنا واي فاي للضيوف." }, "منى");
  assert.equal(pool.db.log.filter((l) => l.action === "edit_answer").length, 1);
  assert.equal((await kb.search("واي فاي", "en"))[0].say, "نعم، عندنا واي فاي للضيوف.");          // مفيش ترجمة ⇒ العربي
  // disabled: الإجابة محفوظة بس مابتطلعش؛ answered ترجّعها
  r = await kb.setStatus(id, "disabled", "منى"); assert.equal(r.question.status, "disabled"); assert.ok(r.question.answer);
  assert.deepEqual(await kb.search("واي فاي"), []);
  r = await kb.setStatus(id, "answered", "منى"); assert.equal((await kb.search("واي فاي")).length, 1);
  assert.equal((await kb.setStatus(id, "nope", "منى")).error, "bad_status");
  assert.equal((await kb.setStatus(999, "open", "منى")).error, "not_found");
  // إجابة اتخزّنت قبل ما القاعدة تتشدد (أو اتعدّلت في القاعدة بإيد): بتتراجع وقت الاستخدام ومابتطلعش
  pool.db.rows[0].answer_ar = "نعم، ونشتريه من مورد كذا";
  assert.deepEqual(await kb.search("واي فاي"), []);
  // سؤال من غير إجابة مايتحوّلش answered
  const q2 = await kb.queue({ question: "كم عمر المطعم" });
  assert.equal((await kb.setStatus(q2.id, "answered", "منى")).error, "needs_answer");
});

test("المدير يضيف سؤال وإجابته، والملاحظات بتتراجع قبل الحفظ وقبل ما توصل للمساعد", async () => {
  const pool = fakePool();
  const kb = makeKb({ pool, log: quiet });
  let r = await kb.add({ question: "فيه كراسي اطفال؟", ar: "نعم، عندنا كراسي أطفال في الصالة." }, "أحمد");
  assert.equal(r.ok, true); assert.equal(r.question.source, "manual"); assert.equal(r.question.status, "answered");
  assert.equal((await kb.add({ question: "", ar: "نعم" }, "أحمد")).error, "answer_required");
  assert.equal((await kb.add({ question: "ايش المورد؟", ar: "نشتري من شركة كذا" }, "أحمد")).error, "not_allowed");
  assert.deepEqual(await kb.notes(), { ar: "", en: "", updatedBy: null, updatedAt: null });
  assert.equal(await kb.notesFor("ar"), null);
  r = await kb.setNotes({ ar: "الصالة تتسع 40 شخص، وفيه قسم عائلات." }, "أحمد");
  assert.equal(r.ok, true); assert.equal(r.notes.updatedBy, "أحمد");
  assert.equal(await kb.notesFor("ar"), "الصالة تتسع 40 شخص، وفيه قسم عائلات.");
  assert.equal(await kb.notesFor("en"), "الصالة تتسع 40 شخص، وفيه قسم عائلات.");
  r = await kb.setNotes({ ar: "اللحم من المورد الفلاني" }, "أحمد"); assert.equal(r.error, "not_allowed"); assert.match(r.message, /الملاحظات ماتتحفظش/);
  assert.equal((await kb.setNotes({ ar: "x".repeat(KB_LIMITS.notes + 1) }, "أحمد")).error, "too_long");
  pool.db.notes.ar = "الخلطة فيها كذا وكذا";                              // اتعدّلت من بره المسار ⇒ ماتوصلش للمساعد
  assert.equal(await kb.notesFor("ar"), null);
  r = await kb.setNotes({ ar: "" }, "أحمد"); assert.equal(r.ok, true); assert.equal(r.notes.ar, "");
});

test("المسارات: نفس الأجسام تحت البادئتين، المدير بس في البورتال، ومفيش جوال في أي سؤال", async () => {
  const pool = fakePool();
  const routes = {};
  const add = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  const app = { get: add("GET"), post: add("POST"), put: add("PUT") };
  let role = "manager", admin = true;
  const kb = register(app, { pool, requireAdmin: async (c) => (admin ? null : c.json({ ok: false, error: "unauthorized" }, 401)) }, { log: quiet, actor: async () => "omar",
    requirePortal: async (c, need) => (need === "manager" && role !== "manager" ? { res: c.json({ ok: false, error: "forbidden" }, 403) } : { user: { id: "s1", name: "أحمد", role } }) });
  const call = async (key, { body = null, query = {}, params = {} } = {}) => {
    let out = null;
    const c = { req: { json: async () => { if (body === null) throw new Error("no body"); return body; }, query: (k) => query[k], param: (k) => params[k] }, json: (b, s = 200) => { out = { status: s, body: b }; return out; } };
    await routes[key](c); return out;
  };
  const paths = Object.keys(routes).sort();
  for (const p of ["GET /questions", "POST /questions", "POST /questions/:id/answer", "POST /questions/:id/status", "GET /notes", "PUT /notes"]) {
    const [m, rest] = p.split(" ");
    assert.ok(paths.includes(`${m} /api/portal/wa-kb${rest}`), p); assert.ok(paths.includes(`${m} /api/cms/ops/wabot/kb${rest}`), p);
  }
  await kb.queue({ question: "عندكم واي فاي؟" }); await kb.queue({ question: "فيه واي فاي" }); await kb.queue({ question: "كم عمر المطعم؟" });
  let r = await call("GET /api/portal/wa-kb/questions");
  assert.equal(r.status, 200); assert.deepEqual(r.body.counts, { open: 2, answered: 0, disabled: 0, dismissed: 0 });
  assert.deepEqual(r.body.questions.map((x) => x.asked), [2, 1]);                         // الأكتر سؤالاً أولاً
  assert.deepEqual(Object.keys(r.body.questions[0]).sort(), ["answer", "answeredAt", "answeredBy", "asked", "examples", "firstAt", "id", "lang", "lastAt", "lastUsedAt", "question", "source", "status", "used"]);
  assert.ok(!/phone|hash|chat/i.test(JSON.stringify(r.body)));
  const id = r.body.questions[0].id;
  r = await call("POST /api/portal/wa-kb/questions/:id/answer", { params: { id: String(id) }, body: { ar: "خالي من الجلوتين" } });
  assert.equal(r.status, 400); assert.equal(r.body.error, "not_allowed"); assert.equal(r.body.problems[0].type, "health_or_guarantee"); assert.ok(!("status" in r.body));
  r = await call("POST /api/portal/wa-kb/questions/:id/answer", { params: { id: String(id) }, body: { ar: "نعم، عندنا واي فاي للضيوف." } });
  assert.equal(r.status, 200); assert.equal(r.body.question.answeredBy, "أحمد (manager)");
  r = await call("POST /api/cms/ops/wabot/kb/questions/:id/status", { params: { id: String(id) }, body: { status: "disabled" } });
  assert.equal(r.body.question.status, "disabled"); assert.equal(pool.db.log.at(-1).who, "omar");
  r = await call("GET /api/cms/ops/wabot/kb/questions", { query: { status: "all", q: "واي" } });
  assert.equal(r.body.questions.length, 1);
  r = await call("POST /api/portal/wa-kb/questions/:id/answer", { params: { id: "abc" }, body: { ar: "نعم" } }); assert.equal(r.status, 404);
  r = await call("PUT /api/portal/wa-kb/notes", { body: { ar: "فيه قسم عائلات." } }); assert.equal(r.body.notes.ar, "فيه قسم عائلات.");
  r = await call("GET /api/cms/ops/wabot/kb/notes"); assert.equal(r.body.notes.updatedBy, "أحمد (manager)");
  role = "cashier";
  for (const k of paths.filter((p) => p.includes("/api/portal/"))) { r = await call(k, { params: { id: "1" }, body: {} }); assert.equal(r.status, 403, k); }
  admin = false;
  for (const k of paths.filter((p) => p.includes("/api/cms/"))) { r = await call(k, { params: { id: "1" }, body: {} }); assert.equal(r.status, 401, k); }
  assert.equal(publicQuestion(null), null);
});
