// chef.js — the AI chef for Fresh Cuts (Jeddah): a grill-and-crepe kitchen advisor.
//
// What makes this different from the other advisors in this codebase is that it is
// allowed to say "I don't know yet, and here is exactly what I need from you".
//
//   evaluate → (advice it can ground) + (questions it genuinely needs answered)
//   Omar answers a question → the answer becomes a stored FACT, attributed to an
//   item / batch / material → the next evaluation of that subject is handed those
//   facts and is forbidden from asking again.
//
// So the unit of memory is not a chat transcript, it is a row in `chef_facts`
// keyed by (scope, subject). That is what makes the knowledge reusable by the
// costing screens and what makes "never ask the same thing twice" enforceable in
// the database rather than merely requested in a prompt.
//
// Routes (all admin-only), under /api/chef/:
//   POST /evaluate/item          — one product, its recipe, its real costs and sales
//   POST /evaluate/menu          — the whole menu + channel margins
//   POST /ask                    — a free-text question to the chef
//   GET  /questions              — open (or answered / dismissed) questions
//   POST /questions/:id/answer   — answer one; writes the fact
//   POST /questions/:id/dismiss  — retire a question that does not apply
//   GET  /knowledge              — the accumulated facts
//   POST /knowledge              — add a fact without being asked
//   DELETE /knowledge/:id        — retire a wrong fact
//   GET  /last                   — last stored evaluation, free and instant
//
// Every response carries the evidence pack the model was given, so a recommendation
// can be audited against the numbers that produced it.

import crypto from "node:crypto";

/* ── LLM provider ─────────────────────────────────────────────────────────────
   Same convention as ai.js / keeta_reports.js. The LiteLLM proxy routes Anthropic
   models under an "anthropic/" prefix, so a bare model id gets it added. */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.CHEF_MODEL || process.env.AI_MODEL || "claude-sonnet-5";

const MAX_TOKENS = 12000;
const LLM_TIMEOUT_MS = 180000;
const CACHE_HOURS = 6;            // matches finance.js `fin_advice`
const EVIDENCE_CHAR_BUDGET = 26000;
const MAX_QUESTIONS_PER_RUN = 5;  // a flood of questions is not an answer

/* ── House rules ──────────────────────────────────────────────────────────────
   Facts already established about this kitchen. They are given to the model as
   STRUCTURED numbers (not prose) so the evidence guard can recognise them when a
   recommendation cites them — a fact buried in a sentence is invisible to the
   numeric pool. These are context, not gospel: where a recipe disagrees with a
   house rule, that disagreement is itself worth surfacing, so we state both and
   let the chef notice. */
const HOUSE_RULES = {
  wajba: {
    standardCookedRiceG: 350,
    alsoIncludes: ["طحينة", "سلطة"],
    note: "الوجبة القياسية: ٣٥٠ جرام أرز مطبوخ + طحينة + سلطة. لو وصفة معيّنة مختلفة عن كده، دي ملاحظة تستاهل تتقال مش خطأ مؤكد.",
  },
  grills: {
    soldByWeight: true,
    accompanimentScale: { thulth: 1, nus: 2, kilo: 3 },
    note: "المشاوي بتتباع بالوزن، والمقبّلات بتتدرّج ١ / ٢ / ٣ لـ ثلث / نص / كيلو.",
  },
  pizza: { mediumOnly: true, note: "البيتزا عمليًا بتتباع وسط بس." },
  channels: {
    contributionPerUnitDeliverySAR: 12.83,
    contributionPerUnitInHouseSAR: 7.96,
    deliveryCommissionPct: 19.5,
    note: "التوصيل بيساهم أكتر لكل وحدة (١٢٫٨٣ مقابل ٧٫٩٦ ريال) لأن سعر المنصة أعلى من العمولة ~١٩٫٥٪. يعني التوصيل مش خسران بالضرورة.",
  },
  softDrinks: {
    foodCostPct: 1.03,
    note: "المشروبات الغازية بتشتغل على ١٠٣٪ تكلفة — بتخسر على كل علبة.",
  },
  knownGaps: [
    "زيت القلي مش ظاهر في أي وصفة رغم إن فيه ٣٠ صنف مقلي — ده نقص معروف في البيانات.",
    "أربع طاسات مسجّل فيها البطاطس ٠ جرام رغم إن الطبق بيتقدّم على بطاطس.",
    "١٦ تشغيلة من الـ٢٠ تتبيل نيء (٥ كجم داخل / ٥ كجم خارج، بتتقسّم نيّة) — ده صح مش غلط، ماينفعش يتقال عليه خطأ.",
  ],
};

/* ── Schema ───────────────────────────────────────────────────────────────────
   Three tables:
     chef_questions — what the chef asked, and whether it has been answered.
     chef_facts     — the knowledge base. Owner answers land here as standalone
                      statements attributable to a subject; the costing screens can
                      read them straight out via GET /api/chef/knowledge.
     chef_reports   — cached evaluations (same shape as finance.js `fin_advice`). */
async function ensureChefSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chef_questions (
      id           TEXT PRIMARY KEY,
      scope        TEXT NOT NULL DEFAULT 'general',  -- item | batch | material | menu | general
      subject_key  TEXT NOT NULL DEFAULT '',
      subject_name TEXT NOT NULL DEFAULT '',
      qkey         TEXT NOT NULL,                    -- normalised text; the dedupe key
      question     TEXT NOT NULL,
      why          TEXT NOT NULL DEFAULT '',
      blocks       TEXT NOT NULL DEFAULT '',         -- the advice this answer unlocks
      status       TEXT NOT NULL DEFAULT 'open',     -- open | answered | dismissed
      answer       TEXT NOT NULL DEFAULT '',
      answered_at  TIMESTAMPTZ,
      answered_by  TEXT NOT NULL DEFAULT '',
      asked_in     TEXT NOT NULL DEFAULT '',         -- report id that raised it
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- THE "never ask twice" GUARANTEE. It is a unique index, not a prompt
    -- instruction: an answered question still occupies its (scope, subject, qkey)
    -- slot, so a re-ask simply cannot create a second row.
    CREATE UNIQUE INDEX IF NOT EXISTS chef_questions_dedupe_idx
      ON chef_questions(scope, subject_key, qkey);
    CREATE INDEX IF NOT EXISTS chef_questions_status_idx
      ON chef_questions(status, scope, subject_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS chef_facts (
      id           TEXT PRIMARY KEY,
      scope        TEXT NOT NULL DEFAULT 'general',
      subject_key  TEXT NOT NULL DEFAULT '',
      subject_name TEXT NOT NULL DEFAULT '',
      topic        TEXT NOT NULL DEFAULT '',
      fact         TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT 'owner',    -- owner | seed
      question_id  TEXT,
      active       BOOLEAN NOT NULL DEFAULT TRUE,    -- soft delete; see seed note
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chef_facts_subject_idx
      ON chef_facts(scope, subject_key, active);
    CREATE INDEX IF NOT EXISTS chef_facts_updated_idx ON chef_facts(updated_at DESC);

    CREATE TABLE IF NOT EXISTS chef_reports (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,                     -- item | menu | ask
      subject_key TEXT NOT NULL DEFAULT '',
      cache_key   TEXT NOT NULL DEFAULT '',          -- hash of the free question, for kind='ask'
      model       TEXT NOT NULL DEFAULT '',
      evidence    JSONB NOT NULL DEFAULT '{}',
      result      JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chef_reports_lookup_idx
      ON chef_reports(kind, subject_key, cache_key, created_at DESC);
  `);
}

/* The gaps we already know about are seeded as facts so they are visible and
   editable next to everything Omar himself answers, instead of being invisible
   prompt text. Soft delete (active=false) is why re-seeding on every boot cannot
   resurrect something he deliberately retired. */
const SEED_FACTS = [
  ["seed:frying-oil", "general", "", "زيت القلي",
    "زيت القلي مش داخل في أي وصفة رغم إن فيه حوالي ٣٠ صنف مقلي. يعني تكلفة كل صنف مقلي أقل من الحقيقة بمقدار نصيبه من الزيت."],
  ["seed:tasat-potato", "general", "", "بطاطس الطاسات",
    "أربع طاسات مسجّل فيها البطاطس بصفر جرام رغم إن الطبق بيتقدّم على سرير بطاطس. الوزن ناقص مش الصنف."],
  ["seed:raw-marination", "general", "", "تشغيلات التتبيل",
    "١٦ تشغيلة من الـ٢٠ عبارة عن تتبيل نيء: ٥ كجم داخل و٥ كجم خارج وبتتقسّم وهي نيّة. ده سلوك صحيح ومقصود، مش خطأ في الفاقد."],
  ["seed:wajba-standard", "general", "", "مكوّنات الوجبة",
    "الوجبة القياسية فيها ٣٥٠ جرام أرز مطبوخ مع طحينة وسلطة."],
  ["seed:grill-scaling", "general", "", "تدرّج المشاوي",
    "المشاوي بتتباع بالوزن والمقبّلات بتتدرّج ١ و٢ و٣ لـ ثلث ونص وكيلو."],
  ["seed:pizza-medium", "general", "", "مقاس البيتزا",
    "البيتزا عمليًا بتتباع بمقاس وسط بس."],
  ["seed:soft-drinks", "general", "", "المشروبات الغازية",
    "المشروبات الغازية بتشتغل على ١٠٣٪ نسبة تكلفة، يعني بتخسر على كل علبة تتباع."],
  ["seed:channel-contribution", "general", "", "مساهمة القنوات",
    "التوصيل بيساهم ١٢٫٨٣ ريال لكل وحدة مقابل ٧٫٩٦ ريال داخل المطعم، لأن سعر المنصة الأعلى بيغطي عمولة الـ١٩٫٥٪ وزيادة."],
];

async function seedFacts(pool) {
  for (const [id, scope, subjectKey, topic, fact] of SEED_FACTS) {
    await pool.query(
      `INSERT INTO chef_facts (id, scope, subject_key, subject_name, topic, fact, source)
       VALUES ($1,$2,$3,'',$4,$5,'seed') ON CONFLICT (id) DO NOTHING`,
      [id, scope, subjectKey, topic, fact]);
  }
}

/* ── The evidence guard ───────────────────────────────────────────────────────
   Lifted from keeta_reports.js, where it earned its keep. A recommendation whose
   `evidence` quotes no number that actually exists in the pack does not reach the
   screen: an unsupported number is worse than no advice at all. */
function addNumber(n, out) {
  if (!Number.isFinite(n)) return;
  out.add(n);
  out.add(Math.round(n));
  out.add(Math.round(n * 10) / 10);
  out.add(Math.round(n * 100) / 100);
  const p = n * 100;                    // a fraction the model renders as a percent
  if (Math.abs(p) < 1e12) {
    out.add(p); out.add(Math.round(p)); out.add(Math.round(p * 10) / 10);
  }
}

function collectNumbers(node, out = new Set()) {
  if (node === null || node === undefined) return out;
  if (typeof node === "number") { addNumber(node, out); return out; }
  if (Array.isArray(node)) { for (const x of node) collectNumbers(x, out); return out; }
  if (typeof node === "object") { for (const k of Object.keys(node)) collectNumbers(node[k], out); return out; }
  return out;
}

/* An Arabic-speaking model writes its numbers in Arabic-Indic digits — "٢٠٠٠
   ريال", not "2000". Caught live in keeta_reports.js: the moment the prompt asked
   for Arabic prose in `evidence`, an ASCII-only regex stopped matching ANYTHING
   and the guard threw away a perfectly well-grounded plan. Every candidate string
   is folded to ASCII digits before it is checked:
     ٠-٩ (U+0660..0669) · ۰-۹ (U+06F0..06F9) · ٫ decimal · ٬ ، thousands. */
function foldDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, ".")
    .replace(/[٬،]/g, ",");
}

const NUM_TOKEN = /-?\d[\d,]*(?:\.\d+)?/g;

/* Owner-supplied knowledge is prose, so its numbers are invisible to
   collectNumbers (which only walks numeric leaves). If Omar answers "الحصة ٢٠٠
   جرام", 200 is a REAL measurement and the chef must be allowed to cite it — so
   designated text fields are mined for numbers too. Deliberately narrow: only
   facts, answers and measurement notes, never arbitrary prose in the pack. */
function collectNumbersFromText(text, out) {
  const tokens = foldDigits(text || "").match(NUM_TOKEN);
  if (!tokens) return out;
  for (const raw of tokens) addNumber(Number(raw.replace(/,/g, "")), out);
  return out;
}

function citesRealNumber(text, pool) {
  const tokens = foldDigits(text || "").match(NUM_TOKEN);
  if (!tokens) return false;
  for (const raw of tokens) {
    const v = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    // A bare year or tiny integer is not evidence on its own, but it is not a lie
    // either — only reject when NOTHING in the string matches the pack.
    for (const p of pool) {
      const tol = Math.max(0.01, Math.abs(p) * 0.005);
      if (Math.abs(v - p) <= tol) return true;
    }
  }
  return false;
}

/* ── Question identity ────────────────────────────────────────────────────────
   Two questions are "the same" when they ask the same thing about the same
   subject. Arabic orthography varies freely (أ/إ/آ, ى/ي, ة/ه, diacritics), so the
   key is normalised hard before it is compared. */
function qKey(question) {
  return foldDigits(question || "")
    .replace(/[ً-ْٰـ]/g, "")   // diacritics + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[ةه]/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/* The unique index catches an EXACT repeat. It does not catch a rephrase — caught
   live: the item review asked «إيه سبب ارتفاع التكلفة من ١٠٫٢٤٤ ريال في الوركبوك
   القديم…» and the menu review asked the same sentence with the «في» dropped and
   brackets added. Two different keys, two rows, one question. Since the promise
   to Omar is that he answers a thing once, a new question is also compared
   token-wise against everything already on file for the same subject.

   Containment (over the SHORTER set), not Jaccard: a longer restatement of a
   question already asked is still the same question, and Jaccard would let it
   through purely for being wordier. */
const SIM_THRESHOLD = 0.8;
const SIM_MIN_TOKENS = 4;

/* Light Arabic stemming: drop the definite article and the و/ب/ل/ك proclitics,
   then a trailing ه. It is the difference between «سعر الوحدة الفعلي» and
   «تكلفة الوحدة الفعلية» scoring 0.78 (missed) and 0.89 (caught), while the
   genuinely different «وزن حصة الكفتة» / «وزن حصة الشيش طاووق» stays at 0.75.
   Widening that margin is the honest fix; lowering the threshold to 0.75 would
   have caught the duplicate by also starting to swallow real questions. */
function stem(w) {
  let x = w.replace(/^(وال|بال|كال|فال|ال)/, "").replace(/^[ولبك](?=..)/, "");
  if (x.length > 3) x = x.replace(/ه$/, "");
  return x;
}

function tokenSet(s) {
  // Single-character tokens are Arabic particles (في، من، ده) carrying no
  // meaning here — and a stray «في» was exactly the difference in the collision.
  return new Set(qKey(s).split(" ").filter((w) => w.length > 1).map(stem).filter((w) => w.length > 1));
}

/** Containment over the SHORTER set, so a wordier restatement of an existing
 *  question still counts as the same one. */
function similarity(a, b) {
  // Short questions share too much of their vocabulary by accident; below the
  // floor only the exact-key unique index applies. The asymmetry is deliberate:
  // a surplus question costs Omar one tap to dismiss, whereas wrongly swallowing
  // a real one means the chef silently never gets an answer it needs.
  if (a.size < SIM_MIN_TOKENS || b.size < SIM_MIN_TOKENS) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits / Math.min(a.size, b.size);
}

/* ── Small helpers ────────────────────────────────────────────────────────────*/
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const round = (v, p = 2) => { const m = 10 ** p; return Math.round(num(v) * m) / m; };
const div = (a, b, p = 3) => (num(b) === 0 ? null : round(num(a) / num(b), p));
const str = (v) => (typeof v === "string" ? v.trim() : "");
const oneOf = (v, list, fb) => (list.includes(str(v)) ? str(v) : fb);
const SCOPES = ["item", "batch", "material", "menu", "general"];

/* ── Reading the costing data ─────────────────────────────────────────────────
   Dispatched in-process through Hono's own router rather than re-querying the
   cost_* tables. The costing module's derivation (yields, aliases, trim loss,
   packaging rules) is intricate and still moving; re-implementing it here would
   guarantee the chef eventually advises on numbers that differ from the ones on
   Omar's screen. The caller's Authorization header is forwarded so the same
   admin check applies. */
async function costingGet(app, c, path) {
  const res = await app.request(path, {
    headers: { authorization: c.req.header("authorization") || "" },
  });
  if (!res.ok) throw new Error(`internal GET ${path} → ${res.status}`);
  return res.json();
}

/* ── Knowledge lookups ────────────────────────────────────────────────────────*/
async function loadFacts(pool, scope, subjectKey) {
  // Subject-specific facts plus everything global — a rule about frying oil
  // matters when evaluating a fried item even though it is filed under 'general'.
  const r = await pool.query(
    `SELECT id, scope, subject_key, subject_name, topic, fact, source, updated_at
       FROM chef_facts
      WHERE active
        AND (scope='general' OR (scope=$1 AND subject_key=$2))
      ORDER BY scope='general', updated_at DESC
      LIMIT 200`, [scope || "general", String(subjectKey ?? "")]);
  return r.rows;
}

async function loadQuestions(pool, scope, subjectKey, status = "open") {
  const params = [status];
  let where = `status=$1`;
  if (scope) { params.push(scope); where += ` AND scope=$${params.length}`; }
  if (subjectKey !== undefined && subjectKey !== null && subjectKey !== "") {
    params.push(String(subjectKey)); where += ` AND subject_key=$${params.length}`;
  }
  const r = await pool.query(
    `SELECT id, scope, subject_key, subject_name, question, why, blocks, status,
            answer, answered_at, answered_by, created_at
       FROM chef_questions WHERE ${where}
      ORDER BY created_at DESC LIMIT 200`, params);
  return r.rows;
}

const factLine = (f) => (f.topic ? `${f.topic}: ${f.fact}` : f.fact);

/** One shape for a question everywhere it crosses the wire — the DB rows are
 *  snake_case and the UI must not have to know that in two different places. */
const questionOut = (q) => ({
  id: q.id, scope: q.scope, subjectKey: q.subject_key, subjectName: q.subject_name,
  question: q.question, why: q.why, blocks: q.blocks, status: q.status,
  answer: q.answer, answeredAt: q.answered_at, answeredBy: q.answered_by,
  createdAt: q.created_at,
});

/* ── Evidence packs ───────────────────────────────────────────────────────────*/

/** One product: its recipe, every line's cost and where that cost came from, the
 *  raw materials behind it, its place in the menu, and everything already known
 *  or already asked about it. */
async function buildItemEvidence(app, c, pool, itemId) {
  const [detail, list, materialsRes] = await Promise.all([
    costingGet(app, c, `/api/costing/items/${encodeURIComponent(itemId)}`),
    costingGet(app, c, `/api/costing/items`),
    costingGet(app, c, `/api/costing/materials`),
  ]);
  const it = detail?.item;
  if (!it) throw new Error("item_not_found");

  const items = Array.isArray(list?.items) ? list.items : [];
  const materials = Array.isArray(materialsRes?.materials) ? materialsRes.materials : [];
  const byMaterial = new Map(materials.map((m) => [m.nameAr || m.id, m]));

  const recipe = (detail.recipe || []).map((l) => ({
    ingredient: l.ingredientAr || l.ingredientEn || l.canonical,
    type: l.type,
    qty: num(l.qty),
    unit: l.unit,
    qtyG: l.qtyG === null || l.qtyG === undefined ? null : num(l.qtyG),
    lineCostSAR: round(l.cost, 3),
    unitCost: round(l.unitCost, 3),
    unitCostBasis: l.unitCostBasis,
    costSource: l.costSourceAr || l.costSource,
    verified: !!l.verified,
    trimLossPct: l.trimLossPct === null || l.trimLossPct === undefined ? null : num(l.trimLossPct),
    note: str(l.note) || undefined,
    batchYieldPct: l.batchRef ? (l.batchRef.yieldPct ?? null) : undefined,
    batchYieldAssumed: l.batchRef ? !!l.batchRef.yieldAssumed : undefined,
  }));

  const totalG = recipe.reduce((a, l) => a + (l.qtyG || 0), 0);

  // Only the materials this recipe actually touches — the other 120 are noise.
  const used = [];
  for (const l of recipe) {
    const m = byMaterial.get(l.ingredient);
    if (!m) continue;
    used.push({
      material: m.nameAr, supplier: m.supplier || null,
      purchaseSarPerKg: m.purchaseSarPerKg === null ? null : round(m.purchaseSarPerKg, 3),
      effectiveSarPerKg: m.effectiveSarPerKg === null ? null : round(m.effectiveSarPerKg, 3),
      trimLossPct: m.trimLossPct === null ? null : num(m.trimLossPct),
      priceSource: m.priceSource, verified: !!m.verified, effectiveFrom: m.effectiveFrom,
    });
  }

  const peers = items
    .filter((x) => x.category === it.category && x.id !== it.id)
    .sort((a, b) => num(b.salesValue) - num(a.salesValue))
    .slice(0, 10)
    .map((x) => ({
      name: x.nameAr, foodCostPct: x.foodCostPct, priceRestaurantIncl: x.priceRestaurantIncl,
      pricePlatformIncl: x.pricePlatformIncl, salesUnits: x.salesUnits, salesValue: round(x.salesValue),
    }));

  const ranked = [...items].sort((a, b) => num(b.salesValue) - num(a.salesValue));
  const rank = ranked.findIndex((x) => x.id === it.id) + 1;

  const facts = await loadFacts(pool, "item", String(itemId));
  const open = await loadQuestions(pool, "item", String(itemId), "open");

  const evidence = {
    meta: {
      currency: "SAR", city: "جدة، السعودية",
      subject: { scope: "item", key: String(it.id), name: it.nameAr },
      note: "كل الأسعار شاملة الضريبة. التكاليف مشتقّة من نفس محرك التكاليف اللي بيظهر لصاحب المطعم.",
    },
    houseRules: HOUSE_RULES,
    item: {
      id: it.id, nameAr: it.nameAr, nameEn: it.nameEn, category: it.category, sku: it.sku,
      totalCostSAR: round(it.cost, 3),
      foodCostSAR: round(it.foodCost, 3),
      foodCostAfterYieldSAR: it.foodCostAfterYield === undefined ? null : round(it.foodCostAfterYield, 3),
      packagingCostSAR: it.packagingCost === null ? null : round(it.packagingCost, 3),
      packagingStatus: it.packagingStatusAr || it.packagingStatus,
      packagingUnpriced: it.packagingUnpriced || [],
      costComplete: !!it.costComplete,
      costSource: it.costSourceAr || it.costSource,
      confidence: it.confidence,
      foodCostPct: it.foodCostPct,
      foodCostPctBasis: it.foodCostPctBasis,
      priceRestaurantIncl: it.priceRestaurantIncl,
      pricePlatformIncl: it.pricePlatformIncl,
      salesUnits: it.salesUnits,
      salesValueSAR: round(it.salesValue),
      ingredientCount: it.ingredientCount,
      reviewStatus: it.reviewStatusAr || it.reviewStatus,
      reviewNote: str(it.reviewNote) || null,
      storedWorkbookCost: it.storedWorkbookCost === undefined ? null : round(it.storedWorkbookCost, 3),
      driftFromWorkbook: it.driftFromWorkbook === undefined ? null : round(it.driftFromWorkbook, 3),
      rankBySalesValue: rank || null,
      menuSize: items.length,
    },
    recipe,
    recipeTotals: {
      lines: recipe.length,
      totalWeightG: round(totalG, 1),
      sumOfLineCostsSAR: round(recipe.reduce((a, l) => a + l.lineCostSAR, 0), 3),
      linesWithoutWeight: recipe.filter((l) => !l.qtyG).map((l) => l.ingredient),
      unverifiedLines: recipe.filter((l) => !l.verified).length,
    },
    yieldInfo: detail.yield || null,
    packaging: detail.packaging || null,
    materialsUsed: used,
    categoryPeers: peers,
    knownFacts: facts.map(factLine),
    openQuestions: open.map((q) => q.question),
  };

  // Owner-supplied measurements are legitimate evidence — mine their numbers.
  const citableText = [
    ...facts.map(factLine),
    ...open.map((q) => q.answer).filter(Boolean),
    str(it.reviewNote),
    ...(detail.yield ? [JSON.stringify(detail.yield)] : []),
  ];
  return { evidence, citableText, subjectName: it.nameAr };
}

/** The whole menu: cost coverage, the worst and best food-cost outliers, the prep
 *  batches, and channel margins from the P&L. */
async function buildMenuEvidence(app, c, pool, { from, to }) {
  const [list, batchesRes, materialsRes] = await Promise.all([
    costingGet(app, c, `/api/costing/items`),
    costingGet(app, c, `/api/costing/batches`),
    costingGet(app, c, `/api/costing/materials`),
  ]);
  let pnl = null;
  try {
    pnl = await costingGet(app, c, `/api/finance/pnl?from=${from}&to=${to}`);
  } catch { /* the P&L is a bonus here, not a precondition */ }

  const items = Array.isArray(list?.items) ? list.items : [];
  const batches = Array.isArray(batchesRes?.batches) ? batchesRes.batches : [];
  const materials = Array.isArray(materialsRes?.materials) ? materialsRes.materials : [];

  const compact = (x) => ({
    id: x.id, name: x.nameAr, category: x.category,
    costSAR: round(x.cost, 3), foodCostPct: x.foodCostPct,
    priceRestaurantIncl: x.priceRestaurantIncl, pricePlatformIncl: x.pricePlatformIncl,
    salesUnits: x.salesUnits, salesValueSAR: round(x.salesValue),
    costSource: x.costSource, reviewStatus: x.reviewStatus, costComplete: !!x.costComplete,
  });

  const withPct = items.filter((x) => Number.isFinite(Number(x.foodCostPct)));
  const totalSales = items.reduce((a, x) => a + num(x.salesValue), 0);
  const recipeSales = items.filter((x) => x.costSource === "recipe")
    .reduce((a, x) => a + num(x.salesValue), 0);

  // Category rollup — where the money and the margin actually sit.
  const cats = new Map();
  for (const x of items) {
    const k = x.category || "(بدون تصنيف)";
    const e = cats.get(k) || { category: k, items: 0, salesUnits: 0, salesValueSAR: 0, costWeighted: 0 };
    e.items++; e.salesUnits += num(x.salesUnits); e.salesValueSAR += num(x.salesValue);
    e.costWeighted += num(x.cost) * num(x.salesUnits);
    cats.set(k, e);
  }
  const categories = [...cats.values()].map((e) => ({
    category: e.category, items: e.items, salesUnits: e.salesUnits,
    salesValueSAR: round(e.salesValueSAR),
    totalCostSAR: round(e.costWeighted),
    foodCostPctOfSales: div(e.costWeighted, e.salesValueSAR),
  })).sort((a, b) => b.salesValueSAR - a.salesValueSAR);

  const facts = await loadFacts(pool, "menu", "");
  const open = await loadQuestions(pool, null, null, "open");

  const evidence = {
    meta: {
      currency: "SAR", city: "جدة، السعودية", window: { from, to },
      subject: { scope: "menu", key: "", name: "المنيو كامل" },
      note: "كل الأسعار شاملة الضريبة.",
    },
    houseRules: HOUSE_RULES,
    menuTotals: {
      items: items.length,
      salesValueSAR: round(totalSales),
      salesUnits: items.reduce((a, x) => a + num(x.salesUnits), 0),
      recipeBasedShareOfSalesValue: div(recipeSales, totalSales),
      itemsCostComplete: items.filter((x) => x.costComplete).length,
      statusCounts: list?.statusCounts || null,
    },
    categories,
    topBySalesValue: [...items].sort((a, b) => num(b.salesValue) - num(a.salesValue)).slice(0, 20).map(compact),
    worstFoodCostPct: [...withPct].sort((a, b) => num(b.foodCostPct) - num(a.foodCostPct)).slice(0, 15).map(compact),
    bestFoodCostPct: [...withPct].sort((a, b) => num(a.foodCostPct) - num(b.foodCostPct)).slice(0, 8).map(compact),
    batches: batches.map((b) => ({
      name: b.nameAr, hasRecipe: b.hasRecipe, lines: b.lineCount,
      inputG: b.inputG, outputG: b.outputG, outputMeasured: !!b.outputMeasured,
      yieldPct: b.yieldPct, yieldAssumed: !!b.yieldAssumed,
      cookedBeforePortioning: !!b.cookedBeforePortioning,
      sarPerKg: round(b.sarPerKg, 3), sarPerKgBeforeYield: round(b.sarPerKgBeforeYield, 3),
      dependents: b.dependents, salesValueSAR: round(b.salesValue),
      yieldNote: str(b.yieldNote) || undefined,
    })),
    materialsFlagged: materials
      .filter((m) => m.flaggedReview || !m.verified || m.priceSource !== "invoice")
      .slice(0, 30)
      .map((m) => ({
        material: m.nameAr, supplier: m.supplier || null,
        effectiveSarPerKg: m.effectiveSarPerKg === null ? null : round(m.effectiveSarPerKg, 3),
        trimLossPct: m.trimLossPct, priceSource: m.priceSource, verified: !!m.verified,
        flaggedReview: !!m.flaggedReview,
      })),
    channelEconomics: pnl ? {
      window: { from: pnl.from, to: pnl.to, days: pnl.days },
      overall: {
        orders: pnl.overall?.orders, revenueInclSAR: round(pnl.overall?.revenueIncl),
        foodCostSAR: round(pnl.overall?.foodCost),
        foodCostPctOfRevenue: pnl.overall?.foodCostPctOfRevenue,
        contributionSAR: round(pnl.overall?.contribution),
        contributionMarginPct: pnl.overall?.contributionMarginPct,
        netProfitSAR: round(pnl.overall?.netProfit),
      },
      channels: (pnl.channels || []).map((ch) => ({
        channel: ch.label, orders: ch.orders, revenueInclSAR: round(ch.revenueIncl),
        foodCostPctOfRevenue: ch.foodCostPctOfRevenue,
        platformCostPctOfRevenue: ch.platformCostPctOfRevenue,
        contributionSAR: round(ch.contribution), contributionMarginPct: ch.contributionMarginPct,
        contributionPerOrderSAR: div(ch.contribution, ch.orders, 2),
        losingOrders: ch.losingOrders,
      })),
    } : null,
    knownFacts: facts.map(factLine),
    openQuestions: open.map((q) => `[${q.subject_name || q.scope}] ${q.question}`),
  };

  const citableText = [
    ...facts.map(factLine),
    ...batches.map((b) => str(b.yieldNote)).filter(Boolean),
  ];
  return { evidence, citableText, subjectName: "المنيو كامل" };
}

/** Trim the widest arrays until the pack fits the budget. The pack is the bulk of
 *  every prompt, so an unusually wide menu must not become an unbounded bill. */
function capEvidence(ev) {
  const trims = [
    () => { if (ev.materialsFlagged) ev.materialsFlagged = ev.materialsFlagged.slice(0, 12); },
    () => { if (ev.topBySalesValue) ev.topBySalesValue = ev.topBySalesValue.slice(0, 12); },
    () => { if (ev.worstFoodCostPct) ev.worstFoodCostPct = ev.worstFoodCostPct.slice(0, 10); },
    () => { if (ev.categoryPeers) ev.categoryPeers = ev.categoryPeers.slice(0, 5); },
    () => { if (ev.bestFoodCostPct) ev.bestFoodCostPct = ev.bestFoodCostPct.slice(0, 4); },
    () => { if (ev.batches) ev.batches = ev.batches.slice(0, 12); },
    () => { if (ev.knownFacts) ev.knownFacts = ev.knownFacts.slice(0, 40); },
  ];
  for (const trim of trims) {
    if (JSON.stringify(ev).length <= EVIDENCE_CHAR_BUDGET) break;
    trim();
  }
  return ev;
}

/* ── LLM client ───────────────────────────────────────────────────────────────*/
function resolveProvider() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: DEFAULT_MODEL };
  }
  if (process.env.LITELLM_KEY) {
    const model = DEFAULT_MODEL.includes("/") ? DEFAULT_MODEL : `anthropic/${DEFAULT_MODEL}`;
    return { kind: "litellm", key: process.env.LITELLM_KEY, model };
  }
  return null;
}

async function postJSON(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    // Never echo credentials — only the provider's own message body.
    if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function callTool(provider, { system, user, tool }) {
  if (provider.kind === "anthropic") {
    const data = await postJSON(ANTHROPIC_URL, {
      "x-api-key": provider.key, "anthropic-version": ANTHROPIC_VERSION,
    }, {
      model: provider.model, max_tokens: MAX_TOKENS, system,
      messages: [{ role: "user", content: user }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
      tool_choice: { type: "tool", name: tool.name },
    });
    const block = (data.content || []).find((b) => b.type === "tool_use");
    if (!block) throw new Error("model returned no tool_use block");
    return block.input;
  }
  // LiteLLM speaks OpenAI's function-calling shape.
  const data = await postJSON(`${LITELLM_BASE}/chat/completions`, {
    authorization: `Bearer ${provider.key}`,
  }, {
    model: provider.model, max_tokens: MAX_TOKENS,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
    tool_choice: { type: "function", function: { name: tool.name } },
  });
  const call = ((data.choices || [])[0]?.message?.tool_calls || [])[0];
  if (!call) throw new Error("model returned no tool call");
  return JSON.parse(call.function.arguments || "{}");
}

/* ── Prompt ───────────────────────────────────────────────────────────────────
   Rule 5 is the honesty contract and rule 6 is the whole point of the feature. */
const CHEF_SYSTEM = `أنت شيف تنفيذي محترف، خبرة طويلة في مطابخ المشاوي والكريب، وبتراجع دلوقتي منيو مطعم "فريش كتس" في جدة بالسعودية.

قواعد صارمة ماينفعش تكسرها:
1. بتتكلم عربي باللهجة المصرية العامية — كلام شيف عملي ومباشر، كأنك واقف في المطبخ مع صاحب المطعم. من غير رطانة ولا كلام كتب.
2. كل ملاحظة في findings لازم يكون في حقل evidence بتاعها رقم حقيقي منقول بالظبط من حزمة الأدلة اللي هتستلمها، مكتوب بالعربي مع اسمه. مثال: «تكلفة الصنف ١٢٫١١ ريال وسعره في المطعم ٣٧ ريال، يعني نسبة تكلفة ٣٨٫٧٪».
3. ممنوع تمامًا تخترع رقم. أي رقم مش في الحزمة ما تذكرهوش.
4. ممنوع الكلام العام اللي ينفع أي مطعم. كل ملاحظة لازم تكون مربوطة بمكوّن أو سطر وصفة أو تشغيلة أو صنف موجود فعلًا في البيانات دي.
5. الأمانة في الفرق بين القياس والرأي:
   - confidence = "measured" يعني الاستنتاج طالع من رقم مقاس موجود في الحزمة.
   - confidence = "judgement" يعني ده رأيك المهني كشيف، مش قياس من بيانات المطعم.
   - أي معيار صناعي أو رقم من خبرتك (زي "نسبة التكلفة المعقولة للمشاوي") يتحط في حقل benchmark لوحده ويتعتبر رأي. ممنوع منعًا باتًا تقدّم معيار من خبرتك كأنه رقم مقاس من بيانات المطعم دي.
6. لو محتاج معلومة عشان تنصح صح وهي مش موجودة في الحزمة — اسأل، ما تخمّنش. حط السؤال في questions بصيغة سؤال واحد محدد يتجاوب عليه برقم أو بجملة قصيرة. مثال كويس: «ما هو وزن الحصة المقدَّمة فعليًا من الصنف ده بالجرام؟» أو «هل الصنف ده بيتقلي في نفس زيت السمك؟».
7. ممنوع تسأل سؤال إجابته موجودة في knownFacts، وممنوع تسأل سؤال موجود بالفعل في openQuestions ولو بصيغة تانية.
8. الأسئلة مش بديل عن الشغل. انصح بكل اللي تقدر تنصح بيه من الأرقام الموجودة، واسأل بس عن اللي فعلًا مانع نصيحة معيّنة — واكتب في blocks النصيحة اللي هتقدر تقولها لما تتجاوب.
9. حقل honesty لازم يقول بصراحة حدود البيانات: إيه اللي مش مقدر تتأكد منه، وأي رقم مفترض مش مقاس.
10. العملة ريال سعودي شامل الضريبة. رتّب: priority = 1 هي الأهم والأسرع تنفيذًا.`;

function itemUser(ev) {
  return `دي حزمة الأدلة الحقيقية لصنف واحد من منيو فريش كتس (JSON):

${JSON.stringify(ev, null, 1)}

راجع الصنف ده كشيف تنفيذي: الوصفة والمقادير، منطق التكلفة، نسبة التكلفة مقابل السعر في المطعم وعلى المنصات، الفاقد والتجهيز، التغليف، وموقعه من باقي أصناف نفس التصنيف.

طلّع الملاحظات اللي الأرقام تسندها، واسأل بس عن اللي فعلًا ناقص ومانعك من نصيحة محددة. استخدم أداة submit_chef_review.`;
}

function menuUser(ev, focus) {
  return `دي حزمة الأدلة الحقيقية لمنيو فريش كتس كله (JSON):

${JSON.stringify(ev, null, 1)}

${focus ? `تركيز خاص طلبه صاحب المطعم: ${focus}\n\n` : ""}راجع المنيو كشيف تنفيذي: التصنيفات اللي بتاكل الهامش، الأصناف اللي نسبة تكلفتها غلط، التشغيلات والفاقد، المواد الخام اللي أسعارها مش مؤكدة، والفرق بين قنوات البيع.

طلّع الملاحظات اللي الأرقام تسندها، واسأل بس عن اللي فعلًا ناقص ومانعك من نصيحة محددة. استخدم أداة submit_chef_review.`;
}

function askUser(ev, question) {
  return `دي حزمة الأدلة الحقيقية من مطعم فريش كتس (JSON):

${JSON.stringify(ev, null, 1)}

صاحب المطعم بيسألك السؤال ده:

«${question}»

جاوبه كشيف تنفيذي، وخلّي كل نقطة مربوطة برقم من الحزمة. لو السؤال محتاج معلومة مش موجودة عندك، اسأله عنها في questions بدل ما تخمّن. استخدم أداة submit_chef_review.`;
}

/* ── Tool schema ──────────────────────────────────────────────────────────────
   `findings` and `questions` are both allowed to be empty because a review that
   is honestly blocked should return questions only — forcing a minimum number of
   findings is exactly how you get invented ones. Validity is checked in code:
   findings + questions must total at least one. */
const AREAS = ["recipe", "portion", "cost", "pricing", "yield", "waste", "packaging", "quality", "prep", "menu"];
const SEVERITIES = ["high", "medium", "low"];
const CONFIDENCE = ["measured", "judgement"];

const CHEF_TOOL = {
  name: "submit_chef_review",
  description: "سلّم مراجعة الشيف النهائية: الملاحظات المسنودة بأرقام + الأسئلة اللي محتاج إجابتها.",
  schema: {
    type: "object",
    properties: {
      assessment: { type: "string", description: "٣ إلى ٥ جمل: الوضع بالأرقام بلهجة شيف." },
      honesty: { type: "string", description: "حدود البيانات صراحةً: إيه المفترض وإيه المقاس وإيه اللي مش مقدر تتأكد منه." },
      findings: {
        type: "array", minItems: 0, maxItems: 8,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "معرّف قصير بالإنجليزي، مثل portion-weight-drift" },
            title: { type: "string" },
            area: { type: "string", enum: AREAS },
            severity: { type: "string", enum: SEVERITIES },
            finding: { type: "string", description: "الملاحظة نفسها بلهجة شيف عملية." },
            evidence: { type: "string", description: "جملة عربية قصيرة فيها رقم حقيقي منقول بالظبط من حزمة الأدلة مع اسمه بالعربي — مش مسار JSON." },
            confidence: { type: "string", enum: CONFIDENCE, description: "measured = من رقم مقاس. judgement = رأي مهني." },
            benchmark: { type: "string", description: "اختياري: أي معيار صناعي من خبرتك. بيتعرض كرأي مهني مش كقياس. سيبه فاضي لو مفيش." },
            actions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
            expectedImpact: { type: "string", description: "أثر واقعي مربوط برقم من غير مبالغة." },
            priority: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["id", "title", "area", "severity", "finding", "evidence", "confidence", "actions", "expectedImpact", "priority"],
          additionalProperties: false,
        },
      },
      questions: {
        type: "array", minItems: 0, maxItems: 5,
        items: {
          type: "object",
          properties: {
            scope: { type: "string", enum: SCOPES, description: "السؤال ده عن إيه: صنف / تشغيلة / مادة خام / المنيو / عام." },
            subjectKey: { type: "string", description: "معرّف الصنف أو اسم التشغيلة/المادة. سيبه فاضي للأسئلة العامة." },
            subjectName: { type: "string" },
            question: { type: "string", description: "سؤال واحد محدد، إجابته رقم أو جملة قصيرة." },
            why: { type: "string", description: "ليه محتاج الإجابة دي." },
            blocks: { type: "string", description: "النصيحة اللي هتقدر تقولها بمجرد ما تتجاوب." },
          },
          required: ["scope", "subjectKey", "subjectName", "question", "why", "blocks"],
          additionalProperties: false,
        },
      },
    },
    required: ["assessment", "honesty", "findings", "questions"],
    additionalProperties: false,
  },
};

/* ── Repairing a leaked tool call ─────────────────────────────────────────────
   Caught live on the LiteLLM path with claude-sonnet-5: instead of emitting each
   tool argument separately, the model occasionally serialises the REST of its
   arguments as pseudo-XML *inside the first string field* —

     assessment: "…الوصفة.</assessment>\n<parameter name=\"honesty\">الأرقام دي…"
     honesty:    ""

   The damage is silent and specific: `honesty` is the field that discloses what
   the chef is NOT sure about, and it arrived empty while its text sat buried in
   the assessment. An empty-string check would have passed it. So the payload is
   un-mangled before validation: the head of the string stays with its own field,
   and each leaked block is moved to the field it names — but only where that
   field is still empty, so a correctly-returned value can never be clobbered. */
function repairLeakedParams(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const OPEN = '<parameter name="';
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (typeof v !== "string" || !v.includes(OPEN)) continue;
    const idx = v.indexOf(OPEN);
    // Everything before the first leaked tag is the genuine value of `key`,
    // minus the stray closing tag the model wrote for it.
    raw[key] = v.slice(0, idx).replace(/<\/[A-Za-z_][\w-]*>\s*$/, "").trim();
    const re = /<parameter name="([^"]+)">([\s\S]*?)(?=<parameter name="|$)/g;
    const tail = v.slice(idx);
    let m;
    while ((m = re.exec(tail)) !== null) {
      const field = m[1];
      const body = m[2].replace(/<\/[A-Za-z_][\w-]*>\s*$/, "").trim();
      // Never overwrite a populated field, and never stomp findings/questions
      // (arrays) with a string.
      if (!body || typeof raw[field] === "object") continue;
      if (raw[field] === undefined || raw[field] === null || String(raw[field]).trim() === "") {
        raw[field] = body;
      }
    }
  }
  return raw;
}

/* ── Validation ───────────────────────────────────────────────────────────────
   `strict` applies on the first attempt only. `honesty` is a required field in
   the tool schema, and a response that arrives without it is a partial response
   — seen live: one menu run came back with no honesty AND zero findings where
   the same call had produced seven. Retrying costs one call and usually fixes
   it. On the retry we accept whatever comes back, because losing a good review
   to a missing disclosure line would be a worse outcome than showing it. */
function validateReview(raw, numberPool, defaultSubject, strict = false) {
  repairLeakedParams(raw);
  if (strict && !str(raw?.honesty)) {
    return { ok: false, error: "missing honesty field (partial response)" };
  }
  const rawFindings = Array.isArray(raw?.findings) ? raw.findings : [];
  const rawQuestions = Array.isArray(raw?.questions) ? raw.questions : [];

  const findings = [];
  let droppedEmpty = 0, droppedUnsupported = 0;
  for (const [i, x] of rawFindings.entries()) {
    const actions = Array.isArray(x?.actions) ? x.actions.map(str).filter(Boolean) : [];
    const evidence = str(x?.evidence);
    if (!str(x?.title) || !evidence || !actions.length) { droppedEmpty++; continue; }
    // THE GUARD: a confident sentence around an invented number is the failure
    // mode that matters, and an empty-evidence check does not catch it.
    if (!citesRealNumber(evidence, numberPool)) { droppedUnsupported++; continue; }
    findings.push({
      id: str(x.id) || `finding-${i + 1}`,
      title: str(x.title),
      area: oneOf(x.area, AREAS, "menu"),
      severity: oneOf(x.severity, SEVERITIES, "medium"),
      finding: str(x.finding),
      evidence,
      confidence: oneOf(x.confidence, CONFIDENCE, "judgement"),
      benchmark: str(x.benchmark) || "",
      actions,
      expectedImpact: str(x.expectedImpact),
      priority: Number.isFinite(Number(x.priority)) ? Math.max(1, Math.min(10, Math.round(Number(x.priority)))) : i + 1,
    });
  }
  findings.sort((a, b) => a.priority - b.priority);

  const questions = [];
  for (const x of rawQuestions) {
    const question = str(x?.question);
    if (!question) continue;
    const scope = oneOf(x.scope, SCOPES, defaultSubject.scope);
    // A question about "this item" that forgot to name it still belongs to it.
    const sameScope = scope === defaultSubject.scope;
    questions.push({
      scope,
      subjectKey: str(x.subjectKey) || (sameScope ? defaultSubject.key : ""),
      subjectName: str(x.subjectName) || (sameScope ? defaultSubject.name : ""),
      question,
      why: str(x.why),
      blocks: str(x.blocks),
    });
    if (questions.length >= MAX_QUESTIONS_PER_RUN) break;
  }

  // An honestly blocked review returns questions and no findings — that is a
  // valid outcome, not a failure. Only a review with neither is empty.
  if (!findings.length && !questions.length) {
    return { ok: false, error: `no grounded findings and no questions (dropped ${droppedEmpty} empty, ${droppedUnsupported} unsupported)` };
  }
  return {
    ok: true,
    value: {
      assessment: str(raw.assessment),
      honesty: str(raw.honesty),
      findings,
      questions,
      dropped: { empty: droppedEmpty, unsupported: droppedUnsupported },
    },
  };
}

/* ── Generation (one retry on a malformed or ungrounded response) ─────────────*/
async function generate(provider, { system, user, tool, validate }) {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? user
      : `${user}\n\nملاحظة: المحاولة السابقة رجعت إجابة مرفوضة (${lastError}). التزم حرفيًا بمخطط الأداة، وتأكد إن حقل evidence في كل ملاحظة فيه رقم حقيقي منقول بالظبط من حزمة الأدلة. لو مش لاقي رقم يسند ملاحظة، شيلها واسأل سؤال بدالها.`;
    try {
      const raw = await callTool(provider, { system, user: prompt, tool });
      const v = validate(raw, attempt === 0);
      if (v.ok) return v.value;
      lastError = v.error;
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(`model response invalid after retry: ${lastError}`);
}

/* ── Routes ───────────────────────────────────────────────────────────────────*/
export function register(app, ctx) {
  const { pool, requireAdmin, jb, todayISO, daysAgoISO } = ctx;

  // Fired once at boot; a failure must not take the API down with it.
  ensureChefSchema(pool)
    .then(() => seedFacts(pool))
    .then(() => console.log("[chef] schema ready"))
    .catch((e) => console.error("[chef] ensureChefSchema failed:", e.message));

  /* Persist the questions this run raised. ON CONFLICT DO NOTHING against the
     (scope, subject_key, qkey) unique index is what makes "never twice" true even
     if the model ignores rule 7 — an already-answered question keeps its slot, so
     a rephrased re-ask lands on the same key and is silently discarded. */
  async function saveQuestions(questions, reportId) {
    let inserted = 0, skipped = 0;
    for (const q of questions) {
      const key = qKey(q.question);
      if (!key) continue;
      const subjectKey = String(q.subjectKey || "");

      // Everything ever asked about this subject, whatever its status — an
      // ANSWERED question must block a rephrase just as firmly as an open one,
      // otherwise Omar answers the same thing every week.
      const prior = await pool.query(
        `SELECT question FROM chef_questions WHERE subject_key=$1 LIMIT 200`, [subjectKey]);
      const set = tokenSet(q.question);
      const dup = prior.rows.some((p) => similarity(set, tokenSet(p.question)) >= SIM_THRESHOLD);
      if (dup) { skipped++; continue; }

      const r = await pool.query(
        `INSERT INTO chef_questions (id, scope, subject_key, subject_name, qkey, question, why, blocks, asked_in)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (scope, subject_key, qkey) DO NOTHING
         RETURNING id`,
        [crypto.randomUUID(), q.scope, subjectKey, q.subjectName || "",
          key, q.question, q.why, q.blocks, reportId]);
      inserted += r.rowCount;
    }
    return { inserted, skipped };
  }

  /** The chef's memory changes what the chef would say, so a cached report is only
   *  valid while it is NEWER than the newest fact it could have consulted.
   *  Without this, answering a question would appear to change nothing for 6h —
   *  which would make the entire ask-and-answer loop feel broken. */
  async function knowledgeStamp(scope, subjectKey) {
    const r = await pool.query(
      `SELECT max(updated_at) AS t FROM chef_facts
        WHERE active AND (scope='general' OR (scope=$1 AND subject_key=$2))`,
      [scope || "general", String(subjectKey ?? "")]);
    return r.rows[0]?.t || null;
  }

  async function cachedReport(kind, subjectKey, cacheKey, stamp) {
    const r = await pool.query(
      `SELECT * FROM chef_reports
        WHERE kind=$1 AND subject_key=$2 AND cache_key=$3
          AND created_at > NOW() - INTERVAL '${CACHE_HOURS} hours'
        ORDER BY created_at DESC LIMIT 1`, [kind, String(subjectKey), String(cacheKey)]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    if (stamp && new Date(row.created_at) < new Date(stamp)) return null; // stale vs knowledge
    return row;
  }

  function envelope(row, questions, cached) {
    const result = row.result || {};
    return {
      ok: true,
      cached: !!cached,
      reportId: row.id,
      kind: row.kind,
      model: row.model,
      generatedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      answer: {
        assessment: result.assessment || "",
        honesty: result.honesty || "",
        findings: result.findings || [],
        dropped: result.dropped || { empty: 0, unsupported: 0 },
      },
      evidence: row.evidence,
      questions: (questions || []).map(questionOut),
    };
  }

  /** Shared body for all three kinds — they differ only in the pack and prompt. */
  async function run(c, { kind, subjectKey, cacheKey, buildPack, buildUser, force }) {
    const stampScope = kind === "item" ? "item" : kind === "menu" ? "menu" : "general";
    const stamp = await knowledgeStamp(stampScope, subjectKey);

    // An item review shows only that item's open questions; a menu-wide or free
    // question shows everything still outstanding.
    const openForSubject = () => (kind === "item"
      ? loadQuestions(pool, "item", String(subjectKey), "open")
      : loadQuestions(pool, null, null, "open"));

    if (!force) {
      const hit = await cachedReport(kind, subjectKey, cacheKey, stamp);
      if (hit) return c.json(envelope(hit, await openForSubject(), true));
    }

    const provider = resolveProvider();
    if (!provider) {
      return c.json({
        ok: false, error: "no_llm_provider",
        hint: "set ANTHROPIC_API_KEY, or LITELLM_KEY for the https://llm.o2m8.me/v1 proxy",
      }, 503);
    }

    const { evidence, citableText, subjectName } = await buildPack();
    capEvidence(evidence);

    // The pool the guard checks against: every numeric leaf of the pack, plus the
    // numbers inside owner-supplied facts and measurement notes.
    const numberPool = collectNumbers(evidence);
    for (const t of citableText || []) collectNumbersFromText(t, numberPool);

    const defaultSubject = {
      scope: stampScope, key: String(subjectKey || ""), name: subjectName || "",
    };
    const result = await generate(provider, {
      system: CHEF_SYSTEM,
      user: buildUser(evidence),
      tool: CHEF_TOOL,
      validate: (raw, strict) => validateReview(raw, numberPool, defaultSubject, strict),
    });

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO chef_reports (id, kind, subject_key, cache_key, model, evidence, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, kind, String(subjectKey || ""), String(cacheKey || ""), provider.model,
        jb(evidence), jb(result)]);

    await saveQuestions(result.questions || [], id);

    // The live open list — which may also carry earlier unanswered questions,
    // not just the ones this run produced.
    const row = { id, kind, model: provider.model, evidence, result, created_at: new Date() };
    return c.json(envelope(row, await openForSubject(), false));
  }

  /* ── Evaluate one item ────────────────────────────────────────────────────*/
  app.post("/api/chef/evaluate/item", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const body = await c.req.json().catch(() => ({}));
      const itemId = str(body?.itemId) || String(body?.itemId ?? "");
      if (!itemId) return c.json({ ok: false, error: "itemId required" }, 400);
      return await run(c, {
        kind: "item", subjectKey: itemId, cacheKey: "", force: body?.force === true,
        buildPack: () => buildItemEvidence(app, c, pool, itemId),
        buildUser: (ev) => itemUser(ev),
      });
    } catch (e) {
      if (e.message === "item_not_found") return c.json({ ok: false, error: "item_not_found" }, 404);
      console.error("[chef] evaluate/item failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ── Evaluate the menu ────────────────────────────────────────────────────*/
  app.post("/api/chef/evaluate/menu", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const body = await c.req.json().catch(() => ({}));
      const from = str(body?.from) || daysAgoISO(29);
      const to = str(body?.to) || todayISO();
      const focus = str(body?.focus);
      return await run(c, {
        kind: "menu", subjectKey: "", cacheKey: `${from}:${to}:${qKey(focus).slice(0, 60)}`,
        force: body?.force === true,
        buildPack: () => buildMenuEvidence(app, c, pool, { from, to }),
        buildUser: (ev) => menuUser(ev, focus),
      });
    } catch (e) {
      console.error("[chef] evaluate/menu failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ── Free question ────────────────────────────────────────────────────────*/
  app.post("/api/chef/ask", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const body = await c.req.json().catch(() => ({}));
      const question = str(body?.question);
      if (!question) return c.json({ ok: false, error: "question required" }, 400);
      const itemId = str(body?.itemId) || (body?.itemId != null ? String(body.itemId) : "");
      const from = str(body?.from) || daysAgoISO(29);
      const to = str(body?.to) || todayISO();
      // Identical wording inside the TTL reuses the answer; a rephrase pays again.
      const cacheKey = crypto.createHash("sha1")
        .update(`${itemId}|${qKey(question)}`).digest("hex").slice(0, 32);
      return await run(c, {
        kind: "ask", subjectKey: itemId, cacheKey, force: body?.force === true,
        buildPack: () => (itemId
          ? buildItemEvidence(app, c, pool, itemId)
          : buildMenuEvidence(app, c, pool, { from, to })),
        buildUser: (ev) => askUser(ev, question),
      });
    } catch (e) {
      if (e.message === "item_not_found") return c.json({ ok: false, error: "item_not_found" }, 404);
      console.error("[chef] ask failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ── Questions ────────────────────────────────────────────────────────────*/
  app.get("/api/chef/questions", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const status = oneOf(c.req.query("status"), ["open", "answered", "dismissed"], "open");
      const scope = SCOPES.includes(c.req.query("scope") || "") ? c.req.query("scope") : null;
      const subject = c.req.query("subject");
      const rows = await loadQuestions(pool, scope, subject, status);
      const counts = await pool.query(
        `SELECT status, count(*)::int AS n FROM chef_questions GROUP BY status`);
      return c.json({
        ok: true, status, count: rows.length,
        questions: rows.map(questionOut),
        counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* Answering is the hinge of the whole feature: the answer is written back onto
     the question AND promoted to a standalone fact keyed by subject, so the next
     evaluation consults it as knowledge rather than as conversation history. */
  app.post("/api/chef/questions/:id/answer", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const id = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      const answer = str(body?.answer);
      if (!answer) return c.json({ ok: false, error: "answer required" }, 400);
      const by = str(body?.answeredBy) || "صاحب المطعم";

      const q = (await pool.query(`SELECT * FROM chef_questions WHERE id=$1`, [id])).rows[0];
      if (!q) return c.json({ ok: false, error: "not_found" }, 404);

      await pool.query(
        `UPDATE chef_questions
            SET answer=$2, status='answered', answered_at=NOW(), answered_by=$3
          WHERE id=$1`, [id, answer, by]);

      // The fact is a standalone statement: question + answer read together, so it
      // still makes sense months later on a costing screen with no context.
      const topic = str(body?.topic) || q.question.slice(0, 80);
      const fact = `${q.question} — ${answer}`;
      const factId = `q:${id}`;
      await pool.query(
        `INSERT INTO chef_facts (id, scope, subject_key, subject_name, topic, fact, source, question_id)
         VALUES ($1,$2,$3,$4,$5,$6,'owner',$7)
         ON CONFLICT (id) DO UPDATE
           SET fact=EXCLUDED.fact, topic=EXCLUDED.topic, active=TRUE, updated_at=NOW()`,
        [factId, q.scope, q.subject_key, q.subject_name, topic, fact, id]);

      return c.json({ ok: true, questionId: id, factId, fact });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/api/chef/questions/:id/dismiss", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const id = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      const r = await pool.query(
        `UPDATE chef_questions SET status='dismissed', answer=$2, answered_at=NOW()
          WHERE id=$1 RETURNING id`, [id, str(body?.reason)]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      // The row survives dismissal on purpose — it keeps its (scope, subject, qkey)
      // slot, so a dismissed question does not come back on the next evaluation.
      return c.json({ ok: true, questionId: id });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ── Knowledge ────────────────────────────────────────────────────────────*/
  app.get("/api/chef/knowledge", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const scope = SCOPES.includes(c.req.query("scope") || "") ? c.req.query("scope") : null;
      const subject = c.req.query("subject");
      const params = [];
      let where = `active`;
      if (scope) { params.push(scope); where += ` AND scope=$${params.length}`; }
      if (subject) { params.push(String(subject)); where += ` AND subject_key=$${params.length}`; }
      const r = await pool.query(
        `SELECT id, scope, subject_key, subject_name, topic, fact, source, question_id,
                created_at, updated_at
           FROM chef_facts WHERE ${where}
          ORDER BY updated_at DESC LIMIT 300`, params);
      return c.json({
        ok: true, count: r.rowCount,
        knowledge: r.rows.map((f) => ({
          id: f.id, scope: f.scope, subjectKey: f.subject_key, subjectName: f.subject_name,
          topic: f.topic, fact: f.fact, source: f.source, questionId: f.question_id,
          createdAt: f.created_at, updatedAt: f.updated_at,
        })),
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // Omar can record something the chef has not thought to ask about yet.
  app.post("/api/chef/knowledge", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const body = await c.req.json().catch(() => ({}));
      const fact = str(body?.fact);
      if (!fact) return c.json({ ok: false, error: "fact required" }, 400);
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO chef_facts (id, scope, subject_key, subject_name, topic, fact, source)
         VALUES ($1,$2,$3,$4,$5,$6,'owner')`,
        [id, oneOf(body?.scope, SCOPES, "general"), String(body?.subjectKey ?? ""),
          str(body?.subjectName), str(body?.topic), fact]);
      return c.json({ ok: true, id });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // Soft delete: a retired seed must not reappear at the next boot.
  app.delete("/api/chef/knowledge/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const r = await pool.query(
        `UPDATE chef_facts SET active=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id`,
        [c.req.param("id")]);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found" }, 404);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ── Last stored evaluation (free, instant UI load) ───────────────────────*/
  app.get("/api/chef/last", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const kind = oneOf(c.req.query("kind"), ["item", "menu", "ask"], "menu");
      const subject = String(c.req.query("subject") ?? "");
      const params = [kind];
      let where = `kind=$1`;
      if (subject) { params.push(subject); where += ` AND subject_key=$${params.length}`; }
      const r = await pool.query(
        `SELECT * FROM chef_reports WHERE ${where} ORDER BY created_at DESC LIMIT 1`, params);
      if (!r.rowCount) return c.json({ ok: false, error: "not_found", kind }, 404);
      const open = kind === "item" && subject
        ? await loadQuestions(pool, "item", subject, "open")
        : await loadQuestions(pool, null, null, "open");
      return c.json(envelope(r.rows[0], open, true));
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
}
