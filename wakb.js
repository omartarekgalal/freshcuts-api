/* ═══════════════════════════════════════════════════════════════════════════
   wakb.js — قاعدة معرفة مساعد واتساب (طلب عمر ١٢/١٠)

   سؤال المساعد ماعرفش يجاوبه (أو اتحوّل لموظف) بينزل في طابور. المدير يكتب الإجابة مرة واحدة،
   وتتحفظ وتتستخدم المرة الجاية. ومعاها خانة ملاحظات عامة.

   العقد المكتوب قبل البناء: docs/designs-2026-10/whatsapp/assistant-kb-contract.md
   (نفس المسارات تحت ‎/api/portal/wa-kb/…‎ للمدير في البورتال، و‎/api/cms/ops/wabot/kb/…‎ للوحة).

   قواعد ثابتة:
   - السؤال بيتخزّن **مقنّع** (من غير جوال ولا اسم ولا عنوان) ومن غير أي ربط بالعميل.
   - الإجابة بتتراجع وقت الحفظ **وكمان** وقت الاستخدام: ولا وصفة ولا مقادير ولا مورّد ولا «خالي من/آمن/مضمون»
     ولا وعد وقت ولا استرجاع ولا رابط — حتى لو المدير كتبها بإيده.
   - disabled / dismissed مابيتستخدموش أبداً. التعديل بيسري من الرسالة الجاية.
   - الموديول ده مابيبعتش أي رسالة لأي حد.
   ═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";
import { validateReply } from "./waassist.js";
import { maskText } from "./wabotllm.js";
import { hubRoles } from "./wahub.js";      // IBX1a: مين يشوف رابط الرسالة (نفس أدوار المحادثات)
import { tokenSecret } from "./portal-core.js";

export const KB_LIMITS = Object.freeze({ question: 300, answer: 600, notes: 1500, examples: 3, candidates: 3 });
export const KB_STATUSES = Object.freeze(["open", "answered", "disabled", "dismissed"]);
export const KB_SOURCES = Object.freeze(["no_answer", "handover", "dish_fact", "rules_unknown", "manual"]);

export const KB_DDL = `
  CREATE TABLE IF NOT EXISTS wa_kb_questions (
    id BIGSERIAL PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open',
    question TEXT NOT NULL,
    norm TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'ar',
    source TEXT NOT NULL DEFAULT 'no_answer',
    asked INT NOT NULL DEFAULT 1,
    first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    examples JSONB NOT NULL DEFAULT '[]'::jsonb,
    answer_ar TEXT,
    answer_en TEXT,
    answered_by TEXT,
    answered_at TIMESTAMPTZ,
    used INT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS wa_kb_questions_status_idx ON wa_kb_questions(status, last_at DESC);
  -- IBX1a (عمر ١٧/١٠: «في أسئلة العملاء لازم نضغط على الرسالة يودينا ليها على طول»): آخر ٥ رسايل سأل فيها السؤال ده
  -- [{ pn, wamid, at }] — الرقم بيفضل جوّه السيرفر؛ اللوحة بتاخد مفتاح المحادثة (md5 بالملح) + wamid بس، وللأدوار اللي بتشوف المحادثات بس.
  ALTER TABLE wa_kb_questions ADD COLUMN IF NOT EXISTS refs JSONB NOT NULL DEFAULT '[]'::jsonb;
  CREATE TABLE IF NOT EXISTS wa_kb_notes (
    id INT PRIMARY KEY,
    ar TEXT NOT NULL DEFAULT '',
    en TEXT NOT NULL DEFAULT '',
    updated_by TEXT,
    updated_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS wa_kb_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    who TEXT,
    action TEXT NOT NULL,
    qid BIGINT,
    detail JSONB
  );
`;

/* ── نص ⇒ كلمات المعنى (للمطابقة) ─────────────────────────────────────────── */
const STOP = new Set(("هل في فيه فيها عندكم عندك عندنا لو ممكن ابي ابغى ابغي اريد بغيت وش ايش ايه شنو كم متى وين فين كيف ليش هو هي هذا هذي ذا دي اللي الي من على عن الى او ام " +
  "يا طيب لو سمحت سمحتوا الله يعطيكم العافيه مرحبا السلام عليكم هلا شكرا انا انت انتم لي لكم لك ما لا مع بس و ولا ان اذا كان يكون " +
  "مطعم مطعمكم عندكم فريش كاتس restaurant fresh cuts " +
  "do you have is are the a an of in on for to can i we you it there what when where how much many please hi hello thanks any").split(/\s+/));
export function kbNorm(text) {
  return String(text || "").toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[ً-ْـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/\[[^\]]{1,12}\]/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
const stem = (w) => { let s = w; if (s.length > 4 && s.startsWith("وال")) s = s.slice(3); else if (s.length > 3 && s.startsWith("ال")) s = s.slice(2); else if (s.length > 4 && /^[وبلف]ال/.test(s)) s = s.slice(3); return s; };
export function kbTokens(text) {
  const out = new Set();
  for (const w of kbNorm(text).split(" ")) { if (!w || STOP.has(w)) continue; const s = stem(w); if (s.length < 2 || STOP.has(s)) continue; out.add(s); }
  return out;
}
const tokKey = (set) => [...set].sort().join(" ");
/* ⇒ { shared, jaccard, cover } — cover = نسبة كلمات الأقصر الموجودة في التاني */
export function kbOverlap(a, b) {
  const A = a instanceof Set ? a : kbTokens(a), B = b instanceof Set ? b : kbTokens(b);
  if (!A.size || !B.size) return { shared: 0, jaccard: 0, cover: 0 };
  let shared = 0; for (const x of A) if (B.has(x)) shared++;
  return { shared, jaccard: shared / (A.size + B.size - shared), cover: shared / Math.min(A.size, B.size) };
}
/* «نفس السؤال» للعدّ على صف واحد: نفس كلمات المعنى بالظبط، أو تطابق عالي (٢ كلمة مشتركة على الأقل). */
export function kbSame(a, b) {
  const A = a instanceof Set ? a : kbTokens(a), B = b instanceof Set ? b : kbTokens(b);
  if (!A.size || !B.size) return false;
  if (tokKey(A) === tokKey(B)) return true;
  const o = kbOverlap(A, B);
  return o.shared >= 2 && o.jaccard >= 0.6;
}
/* مرشحين للإجابة: أي صف معتمد بيشترك مع السؤال في كلمة معنى على الأقل، مترتبين. المساعد هو اللي بيقرر لو ده **نفس** السؤال فعلاً. */
export function kbCandidates(rows, question, max = KB_LIMITS.candidates) {
  const Q = kbTokens(question);
  if (!Q.size) return [];
  const scored = [];
  for (const r of rows || []) {
    let best = { shared: 0, jaccard: 0, cover: 0 };
    for (const t of [r.question, ...(Array.isArray(r.examples) ? r.examples : [])]) { const o = kbOverlap(Q, kbTokens(t)); if (o.jaccard > best.jaccard || (o.jaccard === best.jaccard && o.shared > best.shared)) best = o; }
    if (best.shared >= 2 || (best.shared >= 1 && best.jaccard >= 0.5)) scored.push({ row: r, score: best.jaccard, shared: best.shared });
  }
  scored.sort((x, y) => y.score - x.score || y.shared - x.shared || Number(y.row.used || 0) - Number(x.row.used || 0));
  return scored.slice(0, Math.max(1, max)).map((s) => s.row);
}

/* ── مراجعة نص كتبه المدير ─────────────────────────────────────────────────
   نفس قواعد رد المساعد (أسرار الشغل، ادعاءات الصحة والضمان، وعود الوقت والاسترجاع، استعجال مختلق، «تطبيقنا»، تسريب داخلي)
   + رابط + أقواس متغيرات. الأرقام اللي في النص نفسه مسموحة (المدير هو المصدر)، والخصم ممنوع (العروض مصدرها أداة العروض). */
const KB_EXTRA = [
  [/https?:\/\/|www\.|\b[a-z0-9-]+\.(sa|com|net|me|app|io)\b/i, "link_in_text"],
  [/[{}]|\$\{|<[a-z/!][^>]*>/i, "braces"],
  /* المورّد ومصدر الشراء بأي صيغة («نشتري اللحم من…»، «المورد…»): قاعدة رد المساعد بتمسك «نشتري من» بس */
  [/مور[ّ]?د|supplier|(نشتري|نشتريه|نشتريها|نستورد|نستورده|نستوردها|نجيب|نجيبه|نجيبها)[^.،,]{0,30}\sمن\s|we (buy|source|import)[^.,]{0,30} from /i, "recipe_disclosure"],
  [/سعرات|سعر[ةه] حراري|calorie|كالوري/i, "health_or_guarantee"],
  [/(ما|لا|مافي|ما في) ?(عندنا|يوجد|فيه)? ?مكسرات (في |ب)(ال)?مطبخ|مطبخنا (ما|لا|خالي)|no nuts in (the|our) kitchen|nut[- ]free/i, "health_or_guarantee"],
  [/(بيوصلك|يوصلك|راح يوصلك|بنوصله|نوصله لك) (بسرعه|بسرعة|سريع|قريب|حالا|حالاً)|توصيل سريع|fast delivery|quick delivery/i, "time_promise"],
  [/anthropic|claude|openai|chatgpt|\bgpt\b|language model|نموذج لغوي/i, "internal_leak"],
];
const KB_TYPES = new Set(["recipe_disclosure", "health_or_guarantee", "time_promise", "refund_promise", "discount_claim", "invented_urgency", "app_word", "link_in_text", "internal_leak", "braces"]);
export const KB_PROBLEM_AR = Object.freeze({
  recipe_disclosure: "فيها وصفة أو مقادير أو تتبيلة أو طريقة تحضير أو اسم مورّد، والمساعد مايقولش ده لأي عميل",
  health_or_guarantee: "فيها ادعاء صحي أو ضمان («خالي من»، «آمن»، «مضمون»، سعرات)",
  time_promise: "فيها وعد بوقت توصيل أو تحضير",
  refund_promise: "فيها وعد باسترجاع أو تعويض",
  discount_claim: "فيها خصم أو نسبة: العروض بتتقال من العروض الشغّالة بس",
  invented_urgency: "فيها استعجال («آخر فرصة»، «الكمية محدودة»)",
  app_word: "اكتب «موقعنا» بدل «تطبيقنا»",
  link_in_text: "فيها رابط: المساعد مابيكتبش روابط",
  internal_leak: "فيها كلام عن النظام أو الأدوات",
  braces: "فيها أقواس أو رموز برمجة",
});
export function kbCheck(text) {
  const t = String(text || "");
  if (!t.trim()) return { ok: true, problems: [] };
  const problems = [];
  const seen = new Set();
  const add = (type, value) => { const k = `${type}:${value}`; if (KB_TYPES.has(type) && !seen.has(k)) { seen.add(k); problems.push({ type, value: String(value).slice(0, 60) }); } };
  for (const p of validateReply(t, { facts: [t], customerText: t, know: {} }).problems) add(p.type === "link_not_from_tools" ? "link_in_text" : p.type, p.value);
  for (const [re, type] of KB_EXTRA) { const m = re.exec(t); if (m) add(type, m[0]); }
  return { ok: problems.length === 0, problems };
}
const messageOf = (problems) => (problems[0] ? `الإجابة ماتتحفظش: ${KB_PROBLEM_AR[problems[0].type] || problems[0].type} («${problems[0].value}»).` : "");

const clean = (s, max) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max + 1);
const langOf = (s) => (/[؀-ۿ]/.test(String(s || "")) ? "ar" : "en");
const iso = (v) => (v ? new Date(v).toISOString() : null);
export const KB_REFS_MAX = 5;
const jsonArr = (v) => (Array.isArray(v) ? v : (() => { try { const x = JSON.parse(v || "[]"); return Array.isArray(x) ? x : []; } catch { return []; } })());
/* مرجع رسالة من المحادثة ⇒ { pn, wamid, at } أو null (رقم مش سعودي / من غير wamid ⇒ مفيش مرجع) */
export function kbRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  const pn = String(ref.phone || ref.pn || "").replace(/\D/g, "").replace(/^(00966|966)/, "").replace(/^0/, "");
  const wamid = ref.wamid ? String(ref.wamid).slice(0, 200) : null;
  if (!/^5\d{8}$/.test(pn) || !wamid) return null;
  const at = ref.at ? iso(ref.at) : null;
  return { pn, wamid, at: at || new Date().toISOString() };
}
export const mergeRefs = (old, add) => [...(add ? [add] : []), ...jsonArr(old).filter((x) => x && x.wamid && (!add || x.wamid !== add.wamid))].slice(0, KB_REFS_MAX);
/* opts.keyOf(pn) ⇒ مفتاح المحادثة: لو موجود، السؤال بيطلع ومعاه refs [{ key, wamid, at }] (من غير رقم). من غيره: ولا مرجع (زي الأول). */
export function publicQuestion(r, opts = {}) {
  if (!r) return null;
  const ex = jsonArr(r.examples);
  const keyOf = typeof opts.keyOf === "function" ? opts.keyOf : null;
  return { id: Number(r.id), status: r.status, question: r.question, lang: r.lang === "en" ? "en" : "ar", source: r.source, asked: Number(r.asked) || 1,
    firstAt: iso(r.first_at), lastAt: iso(r.last_at), examples: ex.slice(0, KB_LIMITS.examples),
    answer: r.answer_ar ? { ar: r.answer_ar, en: r.answer_en || "" } : null, answeredBy: r.answered_by || null, answeredAt: iso(r.answered_at),
    used: Number(r.used) || 0, lastUsedAt: iso(r.last_used_at),
    ...(keyOf ? { refs: jsonArr(r.refs).filter((x) => x && x.pn && x.wamid).slice(0, KB_REFS_MAX).map((x) => ({ key: keyOf(x.pn), wamid: x.wamid, at: x.at || null })) } : {}) };
}

/* ── المخزن ─────────────────────────────────────────────────────────────────
   deps: { pool, broadcast?(event, data), log?, now? } — كل دالة بترجع null لو القاعدة ماردّتش (مفيش استثناء بيطلع للمساعد). */
export function makeKb(deps = {}) {
  const { pool } = deps;
  const log = deps.log || console;
  const ready = pool ? pool.query(KB_DDL).then(() => true).catch((e) => { log.error("[wa-kb] schema:", e.message); return false; }) : Promise.resolve(false);
  const q = async (sql, params = []) => { try { if (!(await ready)) return null; return (await pool.query(sql, params)).rows; } catch (e) { log.error("[wa-kb]", e.message); return null; } };
  const note = (who, action, qid, detail) => q("INSERT INTO wa_kb_log(who, action, qid, detail) VALUES ($1,$2,$3,$4::jsonb)", [who ? String(who).slice(0, 80) : null, action, qid ?? null, JSON.stringify(detail || {})]);

  /* سؤال من محادثة ⇒ الطابور. نفس السؤال موجود (بأي حالة) ⇒ asked + 1 على نفس الصف (ومثال جديد لو مختلف) من غير ما يتفتح تاني. */
  async function queue({ question, lang = null, source = "no_answer", ref = null } = {}) {
    const masked = maskText(String(question || "")).slice(0, KB_LIMITS.question);
    const T = kbTokens(masked);
    if (!masked || !T.size) return null;
    const src = KB_SOURCES.includes(source) && source !== "manual" ? source : "no_answer";
    const r0 = kbRef(ref);      // IBX1a: الرسالة اللي اتسأل فيها (الرقم جوّه السيرفر بس)
    const rows = await q("SELECT id, status, question, examples, to_jsonb(wa_kb_questions)->'refs' AS refs FROM wa_kb_questions ORDER BY last_at DESC LIMIT 800");
    if (rows === null) return null;
    const hit = rows.find((r) => [r.question, ...(Array.isArray(r.examples) ? r.examples : [])].some((t) => kbSame(T, kbTokens(t))));
    if (hit) {
      const ex = Array.isArray(hit.examples) ? hit.examples.slice() : [];
      if (masked !== hit.question && !ex.includes(masked) && ex.length < KB_LIMITS.examples) ex.push(masked);
      await q("UPDATE wa_kb_questions SET asked = asked + 1, last_at = NOW(), examples = $2::jsonb, refs = $3::jsonb WHERE id=$1", [hit.id, JSON.stringify(ex), JSON.stringify(mergeRefs(hit.refs, r0))]);
      return { id: Number(hit.id), created: false, status: hit.status };
    }
    const r = await q(`INSERT INTO wa_kb_questions(status, question, norm, lang, source, examples, refs) VALUES ('open',$1,$2,$3,$4,'[]'::jsonb,$5::jsonb) RETURNING id`,
      [masked, tokKey(T), lang === "en" || lang === "ar" ? lang : langOf(masked), src, JSON.stringify(mergeRefs([], r0))]);
    if (!r || !r[0]) return null;
    const id = Number(r[0].id);
    try { deps.broadcast?.("wa_kb_question", { id, question: masked, asked: 1, source: src }); } catch (e) { log.error("[wa-kb] broadcast:", e.message); }
    return { id, created: true, status: "open" };
  }

  /* للمساعد: مرشحين من الإجابات المعتمدة. كل إجابة بتتراجع تاني هنا؛ اللي ماتعدّيش مابتطلعش. ⇒ [{ id, question, say }] أو null (القاعدة ماردّتش). */
  async function search(question, lang = "ar") {
    const rows = await q("SELECT id, question, examples, answer_ar, answer_en, used FROM wa_kb_questions WHERE status='answered' AND answer_ar IS NOT NULL ORDER BY used DESC, id DESC LIMIT 500");
    if (rows === null) return null;
    const out = [];
    for (const r of kbCandidates(rows, question, KB_LIMITS.candidates + 2)) {
      const say = String((lang === "en" && r.answer_en ? r.answer_en : r.answer_ar) || "").trim();
      if (!say || !kbCheck(say).ok) continue;
      out.push({ id: Number(r.id), question: r.question, say });
      if (out.length >= KB_LIMITS.candidates) break;
    }
    return out;
  }
  const markUsed = (id) => q("UPDATE wa_kb_questions SET used = used + 1, last_used_at = NOW() WHERE id=$1 AND status='answered'", [id]);

  async function notes() {
    const r = await q("SELECT ar, en, updated_by, updated_at FROM wa_kb_notes WHERE id=1");
    if (r === null) return null;
    const x = r[0] || {};
    return { ar: x.ar || "", en: x.en || "", updatedBy: x.updated_by || null, updatedAt: iso(x.updated_at) };
  }
  /* الملاحظات كخلفية للمساعد: بتتراجع وقت القراءة برضه؛ لو فيها مشكلة مابتتبعتش. */
  async function notesFor(lang = "ar") {
    const n = await notes();
    if (!n) return null;
    const t = String((lang === "en" && n.en ? n.en : n.ar) || "").trim();
    return t && kbCheck(t).ok ? t : null;
  }

  const one = async (id) => { const r = await q("SELECT * FROM wa_kb_questions WHERE id=$1", [id]); return r === null ? null : (r[0] || false); };
  const fail = (error, status, extra = {}) => ({ ok: false, error, status, ...extra });
  function answerProblems(ar, en) {
    if (!ar) return fail("answer_required", 400, { message: "اكتب الإجابة بالعربي." });
    if ([...ar].length > KB_LIMITS.answer || [...en].length > KB_LIMITS.answer) return fail("too_long", 400, { message: `الإجابة أطول من ${KB_LIMITS.answer} حرف.` });
    const problems = [...kbCheck(ar).problems, ...kbCheck(en).problems];
    return problems.length ? fail("not_allowed", 400, { problems, message: messageOf(problems) }) : null;
  }
  async function list({ status = "open", limit = 50, before = null, q: text = "", keyOf = null } = {}) {
    const st = status === "all" ? null : KB_STATUSES.includes(status) ? status : "open";
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const where = [], p = [];
    if (st) { p.push(st); where.push(`status=$${p.length}`); }
    if (Number(before) > 0) { p.push(Number(before)); where.push(`id < $${p.length}`); }
    const needle = kbNorm(text);
    if (needle) { p.push(`%${String(text).trim().slice(0, 60)}%`); where.push(`(question ILIKE $${p.length} OR answer_ar ILIKE $${p.length} OR examples::text ILIKE $${p.length})`); }
    p.push(lim);
    const rows = await q(`SELECT * FROM wa_kb_questions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${st === "open" ? "asked DESC, last_at DESC" : "COALESCE(answered_at, last_at) DESC, id DESC"} LIMIT $${p.length}`, p);
    const cnt = await q("SELECT status, count(*)::int AS n FROM wa_kb_questions GROUP BY status");
    if (rows === null || cnt === null) return fail("unavailable", 503);
    const counts = { open: 0, answered: 0, disabled: 0, dismissed: 0 };
    for (const c of cnt) if (c.status in counts) counts[c.status] = Number(c.n);
    return { ok: true, questions: rows.map((r) => publicQuestion(r, { keyOf })), counts };
  }
  async function answer(id, body, who) {
    const ar = clean(body && body.ar, KB_LIMITS.answer), en = clean(body && body.en, KB_LIMITS.answer);
    const bad = answerProblems(ar, en); if (bad) return bad;
    const cur = await one(id);
    if (cur === null) return fail("unavailable", 503); if (!cur) return fail("not_found", 404);
    const r = await q(`UPDATE wa_kb_questions SET status='answered', answer_ar=$2, answer_en=$3, answered_by=$4, answered_at=NOW() WHERE id=$1 RETURNING *`, [id, ar, en || null, who ? String(who).slice(0, 80) : null]);
    if (!r || !r[0]) return fail("unavailable", 503);
    await note(who, cur.answer_ar ? "edit_answer" : "answer", id, { before: cur.answer_ar || null, after: ar });
    return { ok: true, question: publicQuestion(r[0]) };
  }
  async function setStatus(id, status, who) {
    if (!KB_STATUSES.includes(status)) return fail("bad_status", 400, { message: "الحالة لازم تكون: open أو answered أو disabled أو dismissed." });
    const cur = await one(id);
    if (cur === null) return fail("unavailable", 503); if (!cur) return fail("not_found", 404);
    if (status === "answered" && !cur.answer_ar) return fail("needs_answer", 400, { message: "السؤال ده مالوش إجابة لسه." });
    const r = await q("UPDATE wa_kb_questions SET status=$2 WHERE id=$1 RETURNING *", [id, status]);
    if (!r || !r[0]) return fail("unavailable", 503);
    await note(who, "status", id, { from: cur.status, to: status });
    return { ok: true, question: publicQuestion(r[0]) };
  }
  async function add(body, who) {
    const question = maskText(clean(body && body.question, KB_LIMITS.question)).slice(0, KB_LIMITS.question);
    const ar = clean(body && body.ar, KB_LIMITS.answer), en = clean(body && body.en, KB_LIMITS.answer);
    if (!question || !kbTokens(question).size) return fail("answer_required", 400, { message: "اكتب السؤال." });
    const bad = answerProblems(ar, en); if (bad) return bad;
    const r = await q(`INSERT INTO wa_kb_questions(status, question, norm, lang, source, answer_ar, answer_en, answered_by, answered_at) VALUES ('answered',$1,$2,$3,'manual',$4,$5,$6,NOW()) RETURNING *`,
      [question, tokKey(kbTokens(question)), langOf(question), ar, en || null, who ? String(who).slice(0, 80) : null]);
    if (!r || !r[0]) return fail("unavailable", 503);
    await note(who, "add", Number(r[0].id), { question });
    return { ok: true, question: publicQuestion(r[0]) };
  }
  async function setNotes(body, who) {
    const ar = clean(body && body.ar, KB_LIMITS.notes), en = clean(body && body.en, KB_LIMITS.notes);
    if ([...ar].length > KB_LIMITS.notes || [...en].length > KB_LIMITS.notes) return fail("too_long", 400, { message: `الملاحظات أطول من ${KB_LIMITS.notes} حرف.` });
    const problems = [...kbCheck(ar).problems, ...kbCheck(en).problems];
    if (problems.length) return fail("not_allowed", 400, { problems, message: messageOf(problems).replace("الإجابة ماتتحفظش", "الملاحظات ماتتحفظش") });
    const r = await q(`INSERT INTO wa_kb_notes(id, ar, en, updated_by, updated_at) VALUES (1,$1,$2,$3,NOW())
                       ON CONFLICT (id) DO UPDATE SET ar=$1, en=$2, updated_by=$3, updated_at=NOW() RETURNING ar`, [ar, en, who ? String(who).slice(0, 80) : null]);
    if (!r) return fail("unavailable", 503);
    await note(who, "notes", null, { chars: [...ar].length });
    return { ok: true, notes: await notes() };
  }
  return { ready, queue, search, markUsed, notes, notesFor, list, answer, setStatus, add, setNotes };
}

/* ── المسارات ───────────────────────────────────────────────────────────────
   deps: { requirePortal, broadcast, actor?(c) ⇒ اسم مستخدم اللوحة } */
export function register(app, ctx, deps = {}) {
  const kb = makeKb({ pool: ctx.pool, broadcast: deps.broadcast, log: deps.log });
  /* IBX1a: مفتاح المحادثة (نفس ملح wahub) — بيطلع مع السؤال للأدوار اللي بتشوف المحادثات بس */
  const SALT = String(deps.keySalt || tokenSecret(process.env) || "");
  const keyOf = SALT ? (pn) => crypto.createHash("md5").update(`${SALT}:${pn}`).digest("hex") : null;
  const send = (c, r) => { const { status, ...body } = r; return c.json(body, r.ok ? 200 : (status || 400)); };
  const bodyOf = async (c) => { try { const b = await c.req.json(); return b && typeof b === "object" ? b : {}; } catch { return {}; } };
  const idOf = (c) => { const n = Number(c.req.param("id")); return Number.isInteger(n) && n > 0 ? n : 0; };
  const notFound = { ok: false, error: "not_found", status: 404 };

  /* gate(c) ⇒ { res } أو { who } */
  function mount(prefix, gate) {
    app.get(`${prefix}/questions`, async (c) => { const a = await gate(c); if (a.res) return a.res;
      return send(c, await kb.list({ status: c.req.query("status") || "open", limit: c.req.query("limit"), before: c.req.query("before"), q: c.req.query("q") || "", keyOf: a.chatLinks ? keyOf : null })); });
    app.post(`${prefix}/questions`, async (c) => { const a = await gate(c); if (a.res) return a.res; return send(c, await kb.add(await bodyOf(c), a.who)); });
    app.post(`${prefix}/questions/:id/answer`, async (c) => { const a = await gate(c); if (a.res) return a.res; const id = idOf(c); return send(c, id ? await kb.answer(id, await bodyOf(c), a.who) : notFound); });
    app.post(`${prefix}/questions/:id/status`, async (c) => { const a = await gate(c); if (a.res) return a.res; const id = idOf(c); const b = await bodyOf(c); return send(c, id ? await kb.setStatus(id, String(b.status || ""), a.who) : notFound); });
    app.get(`${prefix}/notes`, async (c) => { const a = await gate(c); if (a.res) return a.res; const n = await kb.notes(); return n ? c.json({ ok: true, notes: n }) : c.json({ ok: false, error: "unavailable" }, 503); });
    app.put(`${prefix}/notes`, async (c) => { const a = await gate(c); if (a.res) return a.res; return send(c, await kb.setNotes(await bodyOf(c), a.who)); });
  }
  /* اللوحة: تحت ‎/api/cms/ops‎ ⇒ قسم «الطلبات» في صلاحيات الأدوار (نفس قاعدة كتم البوت) */
  mount("/api/cms/ops/wabot/kb", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return { res: err };
    let who = "اللوحة"; try { if (typeof deps.actor === "function") who = (await deps.actor(c)) || who; } catch { /* الاسم اختياري */ }
    /* روابط «افتح الرسالة»: لو الدور بيشوف المحادثات (settings.waHub.inboxRoles). مفيش دور معروف (مفتاح الأدمن) ⇒ مالك. */
    let chatLinks = false;
    try { const u = typeof deps.whoami === "function" ? await deps.whoami(c) : null; const role = (u && u.role) || "owner"; chatLinks = hubRoles((typeof ctx.getSettingsData === "function" ? await ctx.getSettingsData() : {}) || {}).inbox.includes(role); } catch { chatLinks = false; }
    return { who, chatLinks };
  });
  /* البورتال: المدير بس (وبيشوف المحادثات ⇒ الروابط كمان) */
  if (typeof deps.requirePortal === "function") {
    mount("/api/portal/wa-kb", async (c) => {
      const a = await deps.requirePortal(c, "manager"); if (a.res) return { res: a.res };
      return { who: `${a.user.name || "مدير"} (${a.user.role || "manager"})`, chatLinks: true };
    });
  }
  return kb;
}
