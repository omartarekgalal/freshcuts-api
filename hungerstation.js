/* ═══════════════════════════════════════════════════════════════════════════
   HUNGERSTATION — the platform that isn't working yet.

   Fresh Cuts has FOUR HungerStation orders in the whole cache. This module
   exists to answer three questions honestly:
     1. What is HungerStation actually costing / paying us right now?
     2. What has to change to reach 30 orders/day?
     3. What does a platform that DOES work look like (Keeta) — and what is
        different about it?

   ── Rules that shape every number here ────────────────────────────────────
   1. MONEY IS VAT-INCLUSIVE. TabSense's `gross`/`discount`/`net`/`tax` EXCLUDE
      VAT; `total`/`gross_incl`/`discount_incl` INCLUDE it. Only the *_incl /
      total columns are read, because that is the number the owner quotes.
   2. VOIDS AND REFUNDS ARE NOT SALES. Same ILIKE guard as analytics.js.
   3. THE BUSINESS DAY IS `calendar_day`. TabSense already rolls it at 04:00
      Riyadh; it is never re-derived from order_date. Hour-of-day reporting
      still uses the real Riyadh wall clock.
   4. FOUR ORDERS IS NOT A TREND. Every response carries a `sample` block
      ({ orders, days, tooSmallForRate, minOrdersForRate }) and the SQL never
      hands back a "rate" the UI could mistake for a trend. The daily rows are
      the four real days, not a smoothed series.
   5. COMMISSION IS CHOSEN BY THE ORDER'S OWN DATE, never a flat rate. The
      HungerStation delivery fee is time-banded and jumps 10% → 18% on
      2026-10-01; a flat rate would understate the coming cost by 80%.

   ── HungerStation data facts (verified against the live cache 2026-08-01) ──
   - HungerStation orders are identified ONLY by `order_sources.source_note`
     = 'Hungerstation'. Their POS rows read order_option 'Dine in' and their
     payment method is `Feedus` (the middleware), so neither order_option nor
     the payment key can be used to find them.
   - All 4 orders carry `customer_name` = '********** **********' and an empty
     phone: HungerStation masks the customer at source. Nothing in this module
     may promise per-customer retargeting for this platform.
   - The 4 orders sit on 2 days (2026-07-29, 2026-07-30) — one of them is a
     SAR 1.40 order, which is why the median is reported next to the mean.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const TZ = "Asia/Riyadh";
const BIZ_DAY_START_HOUR = 4;

const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;
const LOCAL_HOUR = `(extract(hour from (o.order_date AT TIME ZONE '${TZ}'))::int)`;

// The two platforms this page compares. Matched on source_note with ILIKE
// because the connector has written both 'Keeta' and 'keeta' historically.
const HS_NOTE = "Hungerstation";
const KEETA_NOTE = "Keeta";

/* ═══════════════════════════════════════════════════════════════════════════
   THE CONTRACT — quotation OQ-0010703967, dated 01/07/2026.

   These are DEFAULTS. Anything here can be overridden from
   `settings.data.hungerstation` without a deploy, because a commercial
   agreement changes faster than this file does.

   The delivery fee is BANDED BY DATE. The 10% band is a promotional rate that
   expires 2026-09-30; on 2026-10-01 it becomes 18%, and on 2027-07-01, 21%.
   Every commission figure in this module is computed by looking up the band
   that covers the order's own business day.
═══════════════════════════════════════════════════════════════════════════ */
export const DEFAULT_CONTRACT = {
  reference: "OQ-0010703967",
  signedOn: "2026-07-01",
  // الاستلام من المتجر — flat since 01/07/2026, not banded.
  pickupFee: 0.21,
  // التوصيل — banded. `to` is inclusive; a null `to` means "open ended".
  deliveryBands: [
    { from: "2026-07-01", to: "2026-09-30", rate: 0.10, label: "سعر ترويجي" },
    { from: "2026-10-01", to: "2027-06-30", rate: 0.18, label: "السعر العادي" },
    { from: "2027-07-01", to: null, rate: 0.21, label: "بعد أول سنة" },
  ],
  // عمولة الدفع الإلكتروني
  paymentFee: 0.025,
  // اشتراك شهري ثابت 01/07/2026 → 01/07/2027
  monthlySubscription: 200,
  subscriptionFrom: "2026-07-01",
  subscriptionTo: "2027-07-01",
  // عرض الاستلام: العميل بياخد خصم ٢٠٪ على الأقل، والمطعم بيتحمّل حتى ٢.٥ ريال
  // للطلب (لو الخصم أقل من ٢.٥ المطعم بيتحمّله كله).
  pickupPromo: { minCustomerDiscount: 0.20, merchantCapPerOrder: 2.5 },
  // On WHAT amount the percentages are charged. We hold VAT-inclusive totals,
  // so that is the default and it is shipped in every response rather than
  // being a silent assumption. Override with "gross_incl" (pre-discount) if
  // the settlement statement turns out to be charged on menu price.
  feeBasis: "total",
  targetOrdersPerDay: 30,
};

// The single most important date on this page.
export const BAND_SWITCH_DAY = "2026-10-01";

/* ── date / number helpers ──────────────────────────────────────────────── */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayArg = (v, fallback) => (typeof v === "string" && DAY_RE.test(v) ? v : fallback);
const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const shiftDay = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
// Signed day distance — negative once the target date is in the past.
const daysUntil = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(num(v) * 100) / 100;
const qty = (v) => Math.round(num(v) * 1000) / 1000;
const rate4 = (v) => (v === null || v === undefined ? null : Math.round(num(v) * 10000) / 10000);
// Explicitly null (not 0, not Infinity) when there is nothing to divide by, so
// the UI can render "—" instead of a fabricated zero.
const ratio = (a, b) => (num(b) === 0 ? null : rate4(num(a) / num(b)));
const median = (list) => {
  const s = list.map(num).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return money(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

/* ── contract resolution ────────────────────────────────────────────────── */

/** Merge the owner's settings over the shipped defaults. Only keys that are
 *  actually present and well-typed win, so a half-filled settings blob can
 *  never blank out a rate. */
export function resolveContract(settingsData) {
  const s = settingsData?.hungerstation;
  const c = { ...DEFAULT_CONTRACT, pickupPromo: { ...DEFAULT_CONTRACT.pickupPromo } };
  if (!s || typeof s !== "object") return c;

  const numKeys = ["pickupFee", "paymentFee", "monthlySubscription", "targetOrdersPerDay"];
  for (const k of numKeys) {
    if (Number.isFinite(Number(s[k]))) c[k] = Number(s[k]);
  }
  if (typeof s.feeBasis === "string" && ["total", "gross_incl"].includes(s.feeBasis)) {
    c.feeBasis = s.feeBasis;
  }
  if (Array.isArray(s.deliveryBands) && s.deliveryBands.length) {
    const bands = s.deliveryBands
      .filter((b) => b && DAY_RE.test(String(b.from)) && Number.isFinite(Number(b.rate)))
      .map((b) => ({
        from: String(b.from),
        to: DAY_RE.test(String(b.to)) ? String(b.to) : null,
        rate: Number(b.rate),
        label: typeof b.label === "string" ? b.label : "",
      }))
      .sort((a, b) => (a.from < b.from ? -1 : 1));
    if (bands.length) c.deliveryBands = bands;
  }
  if (s.pickupPromo && typeof s.pickupPromo === "object") {
    if (Number.isFinite(Number(s.pickupPromo.minCustomerDiscount))) {
      c.pickupPromo.minCustomerDiscount = Number(s.pickupPromo.minCustomerDiscount);
    }
    if (Number.isFinite(Number(s.pickupPromo.merchantCapPerOrder))) {
      c.pickupPromo.merchantCapPerOrder = Number(s.pickupPromo.merchantCapPerOrder);
    }
  }
  return c;
}

/** The delivery band covering `day`. Returns null for a day before the first
 *  band starts — an order predating the contract is NOT silently charged the
 *  first band's rate. */
export function bandOn(contract, day) {
  for (const b of contract.deliveryBands) {
    if (day >= b.from && (b.to === null || day <= b.to)) return b;
  }
  return null;
}

/** The band that follows `day`'s band, i.e. what the rate becomes next. */
function nextBandAfter(contract, day) {
  const cur = bandOn(contract, day);
  const idx = contract.deliveryBands.indexOf(cur);
  if (idx < 0) return contract.deliveryBands[0] || null;
  return contract.deliveryBands[idx + 1] || null;
}

/**
 * What HungerStation keeps out of `amount` on `day`, and what lands in the
 * bank. Service fee + electronic-payment commission are both charged on the
 * same basis; the monthly subscription is NOT included here because it is a
 * fixed cost per month, not per order — it is applied separately, once, so a
 * single order never carries SAR 200.
 */
function orderEconomics(contract, day, amount, rateOverride = null) {
  const band = bandOn(contract, day);
  const serviceRate = rateOverride !== null ? rateOverride : (band ? band.rate : null);
  if (serviceRate === null) {
    return { rate: null, serviceFee: null, paymentFee: null, totalFees: null, net: null, band: null };
  }
  const serviceFee = num(amount) * serviceRate;
  const paymentFee = num(amount) * contract.paymentFee;
  const totalFees = serviceFee + paymentFee;
  return {
    rate: rate4(serviceRate),
    bandLabel: band?.label || "",
    serviceFee: money(serviceFee),
    paymentFee: money(paymentFee),
    totalFees: money(totalFees),
    net: money(num(amount) - totalFees),
    takeRate: ratio(totalFees, amount),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   LLM plumbing — same provider order and evidence discipline as ai.js.
   The proxy routes Anthropic models under an `anthropic/` prefix.
═══════════════════════════════════════════════════════════════════════════ */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const MAX_TOKENS = 12000;
const LLM_TIMEOUT_MS = 180000;
const CACHE_HOURS = 6;
const PLAN_KIND = "hungerstation_plan";

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

/** One forced tool call → parsed arguments. Structured output via a tool schema
 *  is what makes the shape reliable enough to hand straight to the UI. */
async function callTool(provider, { system, user, tool }) {
  if (provider.kind === "anthropic") {
    const data = await postJSON(ANTHROPIC_URL, {
      "x-api-key": provider.key,
      "anthropic-version": ANTHROPIC_VERSION,
    }, {
      model: provider.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
      tool_choice: { type: "tool", name: tool.name },
    });
    const block = (data.content || []).find((b) => b.type === "tool_use");
    if (!block) throw new Error("model returned no tool_use block");
    return block.input;
  }
  const data = await postJSON(`${LITELLM_BASE}/chat/completions`, {
    authorization: `Bearer ${provider.key}`,
  }, {
    model: provider.model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
    tool_choice: { type: "function", function: { name: tool.name } },
  });
  const call = ((data.choices || [])[0]?.message?.tool_calls || [])[0];
  if (!call) throw new Error("model returned no tool call");
  return JSON.parse(call.function.arguments || "{}");
}

/* ── the evidence guard ──────────────────────────────────────────────────────
   ai.js drops any recommendation whose `evidence` field is empty. With four
   orders of history the failure mode here is worse than vagueness: it is a
   confident invented number. So this guard goes one step further — it walks
   every numeric literal in the facts pack into a set, and a recommendation
   survives only if its evidence quotes a number that is actually IN that set
   (within 2%, so 33.71 → "حوالي 34 ريال" still passes).

   Small integers are matched exactly: with tolerance, "4 orders" would match
   any figure between 3.92 and 4.08 and the check would mean nothing.
   Dropped recommendations are counted in the response so the filtering is
   auditable rather than silent.                                             */
function collectFactNumbers(node, out = new Set()) {
  if (node === null || node === undefined) return out;
  if (typeof node === "number") {
    if (Number.isFinite(node)) out.add(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectFactNumbers(v, out);
    return out;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) collectFactNumbers(v, out);
  }
  return out;
}

const NUM_TOKEN_RE = /-?\d+(?:[.,]\d+)?/g;
function evidenceIsGrounded(evidence, factNums) {
  const tokens = String(evidence || "").match(NUM_TOKEN_RE) || [];
  if (!tokens.length) return false;
  for (const t of tokens) {
    const v = Number(String(t).replace(",", "."));
    if (!Number.isFinite(v)) continue;
    for (const f of factNums) {
      if (v === f) return true;
      // Percentages are quoted either as 10 or as 0.10 — accept both readings.
      if (Math.abs(v / 100 - f) < 1e-9) return true;
      if (Math.abs(v - f * 100) < 1e-9) return true;
      // Small integers must match exactly (see note above).
      if (Math.abs(v) < 10 && Number.isInteger(v)) continue;
      if (f !== 0 && Math.abs(v - f) / Math.abs(f) <= 0.02) return true;
    }
  }
  return false;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const oneOf = (v, list, fallback) => (list.includes(str(v)) ? str(v) : fallback);
const LEVERS = ["pricing", "menu", "promotions", "ads", "operations", "content", "platform_settings", "service"];
const EFFORTS = ["low", "medium", "high"];

const PLAN_TOOL = {
  name: "submit_hungerstation_plan",
  description: "سلّم خطة نمو هنقرستيشن النهائية بصيغة منظمة.",
  schema: {
    type: "object",
    properties: {
      headline: { type: "string", description: "جملة واحدة تلخّص الوضع بالأرقام" },
      unknowns: {
        type: "array", minItems: 1, maxItems: 8,
        items: { type: "string" },
        description: "الحاجات اللي البيانات مش كفاية تجاوب عليها — لازم تتقال صراحة",
      },
      steps: {
        type: "array", minItems: 4, maxItems: 12,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "معرّف قصير بالإنجليزي، مثل fix-menu-photos" },
            title: { type: "string" },
            why: { type: "string" },
            how: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
            evidence: { type: "string", description: "رقم حقيقي منقول حرفيًا من حزمة البيانات" },
            lever: { type: "string", enum: LEVERS },
            effort: { type: "string", enum: EFFORTS },
            expectedOrdersPerDay: { type: "number", description: "كام طلب/يوم متوقع تضيفهم الخطوة دي — تقدير، مش وعد" },
            priority: { type: "integer", minimum: 1, maximum: 12 },
          },
          required: ["id", "title", "why", "how", "evidence", "lever", "effort", "priority"],
          additionalProperties: false,
        },
      },
    },
    required: ["headline", "unknowns", "steps"],
    additionalProperties: false,
  },
};

const PLAN_SYSTEM = `أنت مستشار نمو لمطعم "فريش كتس" في جدة بالسعودية، متخصص في منصات التوصيل.

قواعد صارمة ما تتكسرش:
1. اتكلم بالعربي باللهجة المصرية العامية، مباشر وعملي — كأنك قاعد مع صاحب المطعم.
2. كل خطوة لازم تكون مبنية على رقم حقيقي موجود في حزمة البيانات (facts) اللي هتستلمها، والرقم ده يتكتب حرفيًا في حقل evidence.
3. ممنوع منعًا باتًا اختراع رقم. مفيش توقّعات إيراد مبنية على هوا.
4. تاريخ هنقرستيشن عند المطعم ده صغير جدًا (طلبات معدودة على أصابع اليد). ده معناه إنك ماينفعش تحسب منه معدلات أو تعمل منه اتجاه. لو حاجة مش معروفة، اكتبها في unknowns بدل ما تخمّنها.
5. كيتا منصة تانية مختلفة (عمولة مختلفة، عملاء مختلفين، مطبخ واحد). استعملها كدليل إن المطبخ قادر ينتج، مش كدليل إن هنقرستيشن هتعمل نفس الأرقام.
6. أهم رقم في الملف ده هو قفزة عمولة التوصيل من ١٠٪ لـ ١٨٪ يوم ٢٠٢٦-١٠-٠١. أي خطة لازم تاخد بالها منه.
7. العملة ريال سعودي شامل الضريبة. التوقيت توقيت الرياض.
8. رتّب الخطوات priority = 1 للأعلى أثرًا وأسرعها تنفيذًا. الخطوات لازم تكون حاجات المطعم يقدر ينفذها بنفسه على لوحة تحكم هنقرستيشن أو في المطبخ — مش نصايح عامة تنفع أي مطعم.`;

function planUser(facts, focus) {
  return `دي أرقام المطعم الحقيقية (JSON) — دي كل اللي عندنا، مفيش غيرها:

${JSON.stringify(facts, null, 1)}

${focus ? `تركيز خاص طلبه صاحب المطعم: ${focus}\n\n` : ""}المطلوب: خطة مرتّبة توصّل هنقرستيشن لـ ${facts.target.ordersPerDay} طلب في اليوم.

قبل ما تقترح أي حاجة: قول في headline الوضع الحقيقي بالأرقام.

وبعدين — ده شرط، مش اختياري — املا حقل unknowns بحاجتين على الأقل من اللي البيانات دي ما تقدرش تجاوب عليها خالص (أمثلة: ترتيب المطعم في نتايج بحث هنقرستيشن، عدد مرات الظهور، نسبة التحويل، تقييم المطعم، سبب إن الطلبات وقفت بعد ٣٠ يوليو، حالة المتجر مفتوح ولا مقفول). لو رجّعت unknowns فاضية الإجابة هتترفض كلها. ماتخترعش أرقام مكان اللي مش معروف.

كل خطوة: عنوان واضح، السبب، خطوات تنفيذ عملية (٢ لـ ٥)، والرقم اللي يثبتها في evidence، ولو تقدر قدّر كام طلب/يوم ممكن تضيف — وقول إنه تقدير. استخدم أداة submit_hungerstation_plan.`;
}

async function ensurePlanSchema(pool) {
  // Same table ai.js owns; the DDL is idempotent so registration order does not
  // matter and neither module depends on the other having booted first.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      facts JSONB NOT NULL DEFAULT '{}',
      result JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ai_reports_lookup_idx
      ON ai_reports(kind, from_date, to_date, created_at DESC);
  `);
}

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb, todayISO, daysAgoISO } = ctx;

  ensurePlanSchema(pool).catch((e) => console.error("[hungerstation] ensurePlanSchema failed:", e.message));

  /** Today's BUSINESS day in Riyadh (04:00 rollover), straight from Postgres so
   *  the API container's clock/timezone can never shift it by a day. */
  async function bizToday() {
    try {
      const r = await pool.query(
        `SELECT ((now() AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date AS day`
      );
      return isoDay(r.rows[0].day);
    } catch {
      return todayISO();
    }
  }

  const range = (c) => {
    const from = dayArg(c.req.query("from"), daysAgoISO(29));
    const to = dayArg(c.req.query("to"), todayISO());
    return from <= to ? { from, to } : { from: to, to: from };
  };

  /** Per-day HungerStation rows in a window. Band selection happens per DAY,
   *  which is exactly per-order because the bands are date-keyed. */
  async function hsDaily(from, to) {
    return (await pool.query(
      `SELECT o.calendar_day AS day,
              count(*)::int AS orders,
              COALESCE(sum(o.total), 0) AS revenue,
              COALESCE(sum(o.gross_incl), 0) AS gross_incl,
              COALESCE(sum(o.discount_incl), 0) AS discount_incl
         FROM ts_orders o
         JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $3
          AND o.calendar_day BETWEEN $1::date AND $2::date
          AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY 1`,
      [from, to, HS_NOTE]
    )).rows.map((r) => ({
      day: isoDay(r.day),
      orders: num(r.orders),
      revenue: money(r.revenue),
      grossIncl: money(r.gross_incl),
      discount: money(r.discount_incl),
    }));
  }

  /** Every HungerStation order ever, one row each. Four rows today — small
   *  enough to ship whole, which is the honest alternative to a chart. */
  async function hsOrders(from, to) {
    return (await pool.query(
      `SELECT o.order_id, o.receipt, o.calendar_day AS day, o.order_date,
              ${LOCAL_HOUR} AS hour,
              o.total, o.gross_incl, o.discount_incl, o.order_option, o.staff_name
         FROM ts_orders o
         JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $3
          AND o.calendar_day BETWEEN $1::date AND $2::date
          AND ${SALES_ONLY}
        ORDER BY o.order_date`,
      [from, to, HS_NOTE]
    )).rows.map((r) => ({
      orderId: r.order_id,
      receipt: r.receipt,
      day: isoDay(r.day),
      hour: num(r.hour),
      total: money(r.total),
      grossIncl: money(r.gross_incl),
      discount: money(r.discount_incl),
      orderOption: r.order_option,
      staff: r.staff_name,
    }));
  }

  /** Lifetime HungerStation footprint, ignoring the date filter. The window is
   *  for the UI; the truth about "how much HungerStation have we ever done" is
   *  not allowed to change because someone picked last 7 days. */
  async function hsLifetime() {
    const r = (await pool.query(
      `SELECT count(*)::int AS orders,
              count(DISTINCT o.calendar_day)::int AS days,
              COALESCE(sum(o.total), 0) AS revenue,
              min(o.calendar_day) AS first_day,
              max(o.calendar_day) AS last_day
         FROM ts_orders o
         JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $1 AND ${SALES_ONLY}`,
      [HS_NOTE]
    )).rows[0];
    return {
      orders: num(r.orders),
      activeDays: num(r.days),
      revenue: money(r.revenue),
      firstDay: isoDay(r.first_day),
      lastDay: isoDay(r.last_day),
    };
  }

  /* The sample-size verdict, attached to every response. `minOrdersForRate` is
     the line under which this module refuses to present per-day rates as
     anything but arithmetic on a handful of orders. */
  const MIN_ORDERS_FOR_RATE = 30;
  const sampleBlock = (orders, activeDays) => ({
    orders,
    activeDays,
    minOrdersForRate: MIN_ORDERS_FOR_RATE,
    tooSmallForRate: orders < MIN_ORDERS_FOR_RATE,
    note: orders < MIN_ORDERS_FOR_RATE
      ? `عندنا ${orders} طلب هنقرستيشن بس على ${activeDays} يوم — الرقم ده صغير جدًا، أي "معدل" أو "اتجاه" مبني عليه مش معناه حاجة. الأرقام دي بتتعرض كأرقام خام، مش كمؤشر.`
      : "",
  });

  /* Customer identity on this platform — a standing caveat, not a computation.
     Verified: all HungerStation rows carry a masked name and an empty phone. */
  async function identityCaveat(from, to) {
    const r = (await pool.query(
      `SELECT count(*)::int AS orders,
              count(*) FILTER (WHERE COALESCE(s.phone_norm, '') <> '')::int AS with_phone
         FROM ts_orders o
         JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $3
          AND o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`,
      [from, to, HS_NOTE]
    )).rows[0];
    return {
      orders: num(r.orders),
      ordersWithPhone: num(r.with_phone),
      masked: true,
      note: "هنقرستيشن بتخفي اسم العميل ورقمه من المصدر — مفيش ولا رقم تليفون واحد في طلباتهم، يعني إعادة الاستهداف الشخصية (واتساب/رسائل) مستحيلة على المنصة دي. الاحتفاظ بالعميل لازم يحصل جوه المنصة نفسها أو بورقة في الكيس.",
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/hungerstation/overview?from&to
     Where we stand, what the fee is today, and what today's volume costs once
     the promotional band ends.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/hungerstation/overview", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const { from, to } = range(c);
      const contract = resolveContract(await getSettingsData());
      const today = await bizToday();

      const [daily, orders, lifetime, identity] = await Promise.all([
        hsDaily(from, to), hsOrders(from, to), hsLifetime(), identityCaveat(from, to),
      ]);

      const windowOrders = daily.reduce((a, d) => a + d.orders, 0);
      const windowRevenue = money(daily.reduce((a, d) => a + d.revenue, 0));
      const windowGross = money(daily.reduce((a, d) => a + d.grossIncl, 0));
      const windowDiscount = money(daily.reduce((a, d) => a + d.discount, 0));
      const days = spanDays(from, to);

      // Commission on what we ACTUALLY sold, priced day by day at that day's
      // own band — this is the only figure here that is a real cost, not a model.
      let serviceFee = 0, paymentFee = 0, unpriced = 0;
      for (const d of daily) {
        const basis = contract.feeBasis === "gross_incl" ? d.grossIncl : d.revenue;
        const e = orderEconomics(contract, d.day, basis);
        if (e.rate === null) { unpriced += d.orders; continue; }
        serviceFee += num(e.serviceFee);
        paymentFee += num(e.paymentFee);
      }
      const totalFees = money(serviceFee + paymentFee);

      const band = bandOn(contract, today);
      const next = nextBandAfter(contract, today);
      const switchDay = band?.to ? shiftDay(band.to, 1) : BAND_SWITCH_DAY;
      const daysLeft = daysUntil(today, switchDay);

      // "What would today's volume cost at each band?" — the daily run rate of
      // the window, repriced. Explicitly a MODEL, and labelled as one, because
      // the run rate itself comes from four orders.
      const revenuePerDay = windowRevenue / days;
      const atRate = (r) => {
        const svc = revenuePerDay * r;
        const pay = revenuePerDay * contract.paymentFee;
        return {
          rate: rate4(r),
          serviceFeePerDay: money(svc),
          paymentFeePerDay: money(pay),
          feesPerDay: money(svc + pay),
          netPerDay: money(revenuePerDay - svc - pay),
          feesPerMonth: money((svc + pay) * 30),
          // The subscription is a fixed monthly line, so it only shows up here.
          netPerMonth: money((revenuePerDay - svc - pay) * 30 - contract.monthlySubscription),
        };
      };

      return c.json({
        ok: true,
        from, to, days, today,
        window: {
          orders: windowOrders,
          revenue: windowRevenue,
          grossIncl: windowGross,
          discount: windowDiscount,
          discountRatio: ratio(windowDiscount, windowGross),
          avgOrder: windowOrders > 0 ? money(windowRevenue / windowOrders) : null,
          // The mean of four orders one of which is SAR 1.40 is not a basket
          // size; the median next to it is what makes that visible.
          medianOrder: median(orders.map((o) => o.total)),
          activeDays: daily.length,
          ordersPerDay: windowOrders > 0 ? Math.round((windowOrders / days) * 100) / 100 : 0,
        },
        lifetime,
        // The real days, not a smoothed series — see rule 4.
        daily,
        orders,
        sample: sampleBlock(lifetime.orders, lifetime.activeDays),
        identity,
        contract: {
          reference: contract.reference,
          feeBasis: contract.feeBasis,
          feeBasisNote: contract.feeBasis === "total"
            ? "النِسَب بتتحسب على إجمالي الفاتورة شامل الضريبة (اللي العميل دفعه)."
            : "النِسَب بتتحسب على سعر المنيو قبل الخصم شامل الضريبة.",
          pickupFee: contract.pickupFee,
          paymentFee: contract.paymentFee,
          monthlySubscription: contract.monthlySubscription,
          pickupPromo: contract.pickupPromo,
          deliveryBands: contract.deliveryBands,
        },
        currentBand: band
          ? { rate: band.rate, label: band.label, from: band.from, to: band.to }
          : null,
        countdown: {
          switchDay,
          daysLeft,
          passed: daysLeft < 0,
          fromRate: band ? band.rate : null,
          toRate: next ? next.rate : null,
          // How much more, per month, the SAME volume costs after the switch.
          extraFeesPerMonthAtCurrentVolume: band && next
            ? money(revenuePerDay * (next.rate - band.rate) * 30)
            : null,
        },
        // Every number in this block is a model, not an observation.
        modelled: {
          basis: "متوسط إيراد اليوم في المدى المختار",
          revenuePerDay: money(revenuePerDay),
          bands: contract.deliveryBands.map((b) => ({ ...b, ...atRate(b.rate) })),
          pickup: atRate(contract.pickupFee),
        },
        actualFees: {
          serviceFee: money(serviceFee),
          paymentFee: money(paymentFee),
          totalFees,
          netAfterFees: money(windowRevenue - totalFees),
          takeRate: ratio(totalFees, windowRevenue),
          // Orders on a day no band covers are reported, never silently priced.
          unpricedOrders: unpriced,
          subscriptionNote: `الاشتراك الشهري ${contract.monthlySubscription} ريال ثابت مش داخل في الحساب ده — بيتدفع سواء جه طلب أو ما جاش.`,
        },
      });
    } catch (e) {
      console.error("[hungerstation] overview failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/hungerstation/gap?from&to&target=30
     The distance to 30 orders/day, and what 30/day is worth under each band.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/hungerstation/gap", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const { from, to } = range(c);
      const contract = resolveContract(await getSettingsData());
      const today = await bizToday();
      const qTarget = Number(c.req.query("target"));
      const target = Number.isFinite(qTarget) && qTarget > 0
        ? Math.min(500, qTarget)
        : contract.targetOrdersPerDay;

      const [daily, orders, lifetime] = await Promise.all([
        hsDaily(from, to), hsOrders(from, to), hsLifetime(),
      ]);
      const days = spanDays(from, to);
      const windowOrders = daily.reduce((a, d) => a + d.orders, 0);
      const windowRevenue = money(daily.reduce((a, d) => a + d.revenue, 0));

      // Three different denominators, all shipped, because they disagree and
      // the disagreement IS the finding: 4 orders over 2 active days reads as
      // 2/day, but over the 30-day window it reads as 0.13/day. Neither is a
      // forecast; the UI must show which denominator it is quoting.
      const perDayWindow = days > 0 ? windowOrders / days : 0;
      const perDayActive = daily.length > 0 ? windowOrders / daily.length : 0;
      const sinceFirst = lifetime.firstDay ? spanDays(lifetime.firstDay, today) : 0;
      const perDaySinceFirst = sinceFirst > 0 ? lifetime.orders / sinceFirst : 0;

      // The basket we model 30 orders/day with. Median, not mean: one SAR 1.40
      // order drags the mean of four down by a quarter.
      const aovMean = windowOrders > 0 ? money(windowRevenue / windowOrders) : null;
      const aovMedian = median(orders.map((o) => o.total));
      const keeta = (await pool.query(
        `SELECT count(*)::int AS orders, COALESCE(sum(o.total), 0) AS revenue
           FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
          WHERE s.source_note ILIKE $1 AND ${SALES_ONLY}`,
        [KEETA_NOTE]
      )).rows[0];
      const keetaAov = num(keeta.orders) > 0 ? money(num(keeta.revenue) / num(keeta.orders)) : null;

      // Three explicit basket scenarios rather than one silent choice.
      const baskets = [
        { id: "hs_median", label: "متوسط الطلب الحالي على هنقرستيشن (الوسيط)", value: aovMedian },
        { id: "hs_mean", label: "متوسط الطلب الحالي على هنقرستيشن (المتوسط الحسابي)", value: aovMean },
        { id: "keeta", label: "متوسط الطلب على كيتا (منصة تانية — للمقارنة بس)", value: keetaAov },
      ].filter((b) => b.value !== null && b.value > 0);

      const modelFor = (basket) => contract.deliveryBands.map((b) => {
        const revPerDay = target * basket.value;
        const svc = revPerDay * b.rate;
        const pay = revPerDay * contract.paymentFee;
        const netPerDay = revPerDay - svc - pay;
        return {
          bandFrom: b.from, bandTo: b.to, label: b.label, rate: b.rate,
          revenuePerDay: money(revPerDay),
          feesPerDay: money(svc + pay),
          netPerDay: money(netPerDay),
          revenuePerMonth: money(revPerDay * 30),
          feesPerMonth: money((svc + pay) * 30),
          // Subscription applied once per month, never per order.
          netPerMonth: money(netPerDay * 30 - contract.monthlySubscription),
        };
      });

      const band = bandOn(contract, today);
      const next = nextBandAfter(contract, today);
      const switchDay = band?.to ? shiftDay(band.to, 1) : BAND_SWITCH_DAY;

      return c.json({
        ok: true,
        from, to, days, today, target,
        current: {
          windowOrders,
          windowRevenue,
          activeDays: daily.length,
          // All three, labelled. See the note above.
          ordersPerDayOverWindow: Math.round(perDayWindow * 100) / 100,
          ordersPerDayOverActiveDays: Math.round(perDayActive * 100) / 100,
          ordersPerDaySinceFirstOrder: Math.round(perDaySinceFirst * 100) / 100,
          daysSinceFirstOrder: sinceFirst,
          lifetimeOrders: lifetime.orders,
          lastOrderDay: lifetime.lastDay,
          daysSinceLastOrder: lifetime.lastDay ? daysUntil(lifetime.lastDay, today) : null,
        },
        gap: {
          // Multiples off a base this small are arithmetic, not a growth plan —
          // shipped because the SIZE of the number is the point, and flagged.
          missingPerDay: Math.max(0, Math.round((target - perDaySinceFirst) * 100) / 100),
          multipleNeeded: perDaySinceFirst > 0
            ? Math.round((target / perDaySinceFirst) * 10) / 10
            : null,
          multipleNote: perDaySinceFirst > 0
            ? `المضاعف ده متحسب على ${lifetime.orders} طلب فقط على مدى ${sinceFirst} يوم — رقم للتوضيح مش هدف قابل للقياس.`
            : "مفيش طلبات كفاية نحسب منها مضاعف.",
          ordersPerMonthAtTarget: target * 30,
        },
        baskets,
        scenarios: baskets.map((b) => ({ basket: b, bands: modelFor(b) })),
        countdown: {
          switchDay,
          daysLeft: daysUntil(today, switchDay),
          fromRate: band ? band.rate : null,
          toRate: next ? next.rate : null,
          // What the 30/day target costs extra, per month, after the jump.
          extraFeesPerMonthAtTarget: band && next && baskets.length
            ? money(target * baskets[0].value * (next.rate - band.rate) * 30)
            : null,
        },
        contract: {
          paymentFee: contract.paymentFee,
          pickupFee: contract.pickupFee,
          monthlySubscription: contract.monthlySubscription,
          deliveryBands: contract.deliveryBands,
        },
        sample: sampleBlock(lifetime.orders, lifetime.activeDays),
      });
    } catch (e) {
      console.error("[hungerstation] gap failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     GET /api/hungerstation/benchmark?from&to
     Keeta beside HungerStation. Keeta is a DIFFERENT platform with a different
     commission, a different customer base and its own promo history — it is
     evidence that the kitchen can produce, not a forecast for HungerStation.
     Lifetime (not windowed) figures are used for the headline because the
     HungerStation side has two active days in total.
  ───────────────────────────────────────────────────────────────────────── */
  app.get("/api/hungerstation/benchmark", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const { from, to } = range(c);
      const today = await bizToday();

      const totals = (await pool.query(
        `SELECT lower(s.source_note) AS platform,
                count(*)::int AS orders,
                count(DISTINCT o.calendar_day)::int AS active_days,
                COALESCE(sum(o.total), 0) AS revenue,
                COALESCE(sum(o.gross_incl), 0) AS gross_incl,
                COALESCE(sum(o.discount_incl), 0) AS discount_incl,
                min(o.calendar_day) AS first_day,
                max(o.calendar_day) AS last_day
           FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
          WHERE s.source_note ILIKE ANY($1::text[]) AND ${SALES_ONLY}
          GROUP BY 1`,
        [[HS_NOTE, KEETA_NOTE]]
      )).rows;

      const hoursRows = (await pool.query(
        `SELECT lower(s.source_note) AS platform, ${LOCAL_HOUR} AS hr, count(*)::int AS orders
           FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
          WHERE s.source_note ILIKE ANY($1::text[]) AND ${SALES_ONLY}
            AND o.order_date IS NOT NULL
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [[HS_NOTE, KEETA_NOTE]]
      )).rows;

      const itemRows = (await pool.query(
        `SELECT lower(s.source_note) AS platform, i.name,
                sum(i.qty) AS qty, sum(i.amount) AS revenue
           FROM ts_order_items i
           JOIN ts_orders o ON o.order_id = i.order_id
           JOIN order_sources s ON s.order_id = o.order_id
          WHERE s.source_note ILIKE ANY($1::text[]) AND ${SALES_ONLY}
          GROUP BY 1, 2 ORDER BY qty DESC`,
        [[HS_NOTE, KEETA_NOTE]]
      )).rows;

      // Coverage of the item cache, so a thin item list is never read as a thin
      // menu. ts_order_items is only filled for orders somebody pulled.
      const covRows = (await pool.query(
        `SELECT lower(s.source_note) AS platform,
                count(*)::int AS orders,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM ts_order_items i WHERE i.order_id = o.order_id))::int AS with_items
           FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
          WHERE s.source_note ILIKE ANY($1::text[]) AND ${SALES_ONLY}
          GROUP BY 1`,
        [[HS_NOTE, KEETA_NOTE]]
      )).rows;

      const windowRows = (await pool.query(
        `SELECT lower(s.source_note) AS platform,
                count(*)::int AS orders, COALESCE(sum(o.total), 0) AS revenue
           FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
          WHERE s.source_note ILIKE ANY($3::text[])
            AND o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          GROUP BY 1`,
        [from, to, [HS_NOTE, KEETA_NOTE]]
      )).rows;

      const pick = (rows, p) => rows.filter((r) => r.platform === p.toLowerCase());
      const one = (rows, p) => pick(rows, p)[0] || {};

      const shape = (noteId, label) => {
        const t = one(totals, noteId);
        const w = one(windowRows, noteId);
        const cov = one(covRows, noteId);
        const orders = num(t.orders);
        const revenue = money(t.revenue);
        const activeDays = num(t.active_days);
        const firstDay = isoDay(t.first_day);
        const lastDay = isoDay(t.last_day);
        // Elapsed days since the platform's first order — the honest
        // denominator for "orders per day", not the days it happened to sell on.
        const elapsed = firstDay ? spanDays(firstDay, today) : 0;
        const hrs = pick(hoursRows, noteId)
          .map((r) => ({ hour: num(r.hr), orders: num(r.orders) }))
          .sort((a, b) => b.orders - a.orders);
        const items = pick(itemRows, noteId)
          .map((r) => ({ name: r.name, qty: qty(r.qty), revenue: money(r.revenue) }))
          .slice(0, 10);
        return {
          id: noteId.toLowerCase(),
          label,
          orders,
          revenue,
          activeDays,
          firstDay,
          lastDay,
          daysSinceFirstOrder: elapsed,
          ordersPerDaySinceFirstOrder: elapsed > 0 ? Math.round((orders / elapsed) * 100) / 100 : null,
          ordersPerActiveDay: activeDays > 0 ? Math.round((orders / activeDays) * 100) / 100 : null,
          avgOrder: orders > 0 ? money(revenue / orders) : null,
          discount: money(t.discount_incl),
          discountRatio: ratio(t.discount_incl, t.gross_incl),
          window: { from, to, orders: num(w.orders), revenue: money(w.revenue) },
          peakHours: hrs.slice(0, 4),
          hourly: hrs.sort((a, b) => a.hour - b.hour),
          topItems: items,
          itemCoverage: {
            orders: num(cov.orders),
            withItems: num(cov.with_items),
            pct: ratio(cov.with_items, cov.orders),
          },
          sample: sampleBlock(orders, activeDays),
        };
      };

      const hs = shape(HS_NOTE, "هنقرستيشن");
      const kt = shape(KEETA_NOTE, "كيتا");

      return c.json({
        ok: true,
        from, to, today,
        hungerstation: hs,
        keeta: kt,
        // The comparison, with the caveat welded to it rather than in a footnote.
        comparison: {
          ordersRatio: kt.orders > 0 ? ratio(hs.orders, kt.orders) : null,
          aovGap: hs.avgOrder !== null && kt.avgOrder !== null
            ? money(kt.avgOrder - hs.avgOrder) : null,
          sharedItems: hs.topItems
            .filter((i) => kt.topItems.some((k) => k.name === i.name))
            .map((i) => i.name),
          caveat: "كيتا منصة مختلفة: عمولة مختلفة، عملاء مختلفين، وتاريخ عروض مختلف. المقارنة دي بتثبت إن المطبخ والمنيو قادرين ينتجوا طلبات توصيل — مش إن هنقرستيشن هتوصل لنفس الأرقام.",
        },
      });
    } catch (e) {
      console.error("[hungerstation] benchmark failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     Facts pack for the AI plan. Built from the same helpers the read endpoints
     use, so the model can never see a number the screen disagrees with.
  ───────────────────────────────────────────────────────────────────────── */
  async function buildPlanFacts(from, to, target) {
    const contract = resolveContract(await getSettingsData());
    const today = await bizToday();

    const [daily, orders, lifetime, identity] = await Promise.all([
      hsDaily(from, to), hsOrders(from, to), hsLifetime(), identityCaveat(from, to),
    ]);

    const keetaTotals = (await pool.query(
      `SELECT count(*)::int AS orders, count(DISTINCT o.calendar_day)::int AS active_days,
              COALESCE(sum(o.total), 0) AS revenue,
              min(o.calendar_day) AS first_day, max(o.calendar_day) AS last_day
         FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $1 AND ${SALES_ONLY}`,
      [KEETA_NOTE]
    )).rows[0];

    const keetaHours = (await pool.query(
      `SELECT ${LOCAL_HOUR} AS hr, count(*)::int AS orders
         FROM ts_orders o JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $1 AND ${SALES_ONLY} AND o.order_date IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      [KEETA_NOTE]
    )).rows.map((r) => ({ hour: num(r.hr), orders: num(r.orders) }));

    const keetaItems = (await pool.query(
      `SELECT i.name, sum(i.qty) AS qty, sum(i.amount) AS revenue
         FROM ts_order_items i
         JOIN ts_orders o ON o.order_id = i.order_id
         JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $1 AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY qty DESC LIMIT 10`,
      [KEETA_NOTE]
    )).rows.map((r) => ({ name: r.name, qty: qty(r.qty), revenue: money(r.revenue) }));

    const hsItems = (await pool.query(
      `SELECT i.name, sum(i.qty) AS qty, sum(i.amount) AS revenue
         FROM ts_order_items i
         JOIN ts_orders o ON o.order_id = i.order_id
         JOIN order_sources s ON s.order_id = o.order_id
        WHERE s.source_note ILIKE $1 AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY qty DESC LIMIT 20`,
      [HS_NOTE]
    )).rows.map((r) => ({ name: r.name, qty: qty(r.qty), revenue: money(r.revenue) }));

    // The whole restaurant, for scale — 30 HungerStation orders/day has to be
    // read against what the kitchen already ships in a day.
    const house = (await pool.query(
      `SELECT count(*)::int AS orders, count(DISTINCT o.calendar_day)::int AS days,
              COALESCE(sum(o.total), 0) AS revenue
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`,
      [from, to]
    )).rows[0];

    const kOrders = num(keetaTotals.orders);
    const kRevenue = money(keetaTotals.revenue);
    const kFirst = isoDay(keetaTotals.first_day);
    const kElapsed = kFirst ? spanDays(kFirst, today) : 0;
    const hsElapsed = lifetime.firstDay ? spanDays(lifetime.firstDay, today) : 0;
    const aovMedian = median(orders.map((o) => o.total));
    const aovMean = lifetime.orders > 0 ? money(lifetime.revenue / lifetime.orders) : null;
    const basket = aovMedian || aovMean || (kOrders > 0 ? money(kRevenue / kOrders) : 0);

    const band = bandOn(contract, today);
    const next = nextBandAfter(contract, today);
    const switchDay = band?.to ? shiftDay(band.to, 1) : BAND_SWITCH_DAY;

    const houseOrders = num(house.orders);
    const houseDays = spanDays(from, to);

    return {
      meta: {
        currency: "SAR",
        city: "جدة، السعودية",
        timezone: "Asia/Riyadh (UTC+3)",
        today,
        window: { from, to, days: houseDays },
        note: "كل المبالغ شاملة ضريبة القيمة المضافة. الطلبات الملغاة والمرتجعة مستبعدة.",
      },
      hungerstation: {
        lifetimeOrders: lifetime.orders,
        lifetimeRevenue: lifetime.revenue,
        activeDays: lifetime.activeDays,
        firstOrderDay: lifetime.firstDay,
        lastOrderDay: lifetime.lastDay,
        daysSinceFirstOrder: hsElapsed,
        daysSinceLastOrder: lifetime.lastDay ? daysUntil(lifetime.lastDay, today) : null,
        avgOrderMean: aovMean,
        avgOrderMedian: aovMedian,
        ordersByDay: daily,
        everyOrder: orders,
        items: hsItems,
        customerIdentity: identity.note,
        warning: `دي ${lifetime.orders} طلبات بس على ${lifetime.activeDays} يوم. ممنوع تحسب منها معدل أو نسبة نمو أو توقّع.`,
      },
      keeta: {
        orders: kOrders,
        revenue: kRevenue,
        activeDays: num(keetaTotals.active_days),
        firstOrderDay: kFirst,
        lastOrderDay: isoDay(keetaTotals.last_day),
        daysSinceFirstOrder: kElapsed,
        ordersPerDaySinceFirstOrder: kElapsed > 0 ? Math.round((kOrders / kElapsed) * 100) / 100 : null,
        avgOrder: kOrders > 0 ? money(kRevenue / kOrders) : null,
        peakHours: keetaHours,
        topItems: keetaItems,
        caveat: "كيتا منصة تانية بعمولة وعملاء مختلفين — دليل على قدرة المطبخ، مش توقّع لهنقرستيشن.",
      },
      house: {
        orders: houseOrders,
        revenue: money(house.revenue),
        days: houseDays,
        ordersPerDay: houseDays > 0 ? Math.round((houseOrders / houseDays) * 100) / 100 : null,
        avgOrder: houseOrders > 0 ? money(num(house.revenue) / houseOrders) : null,
      },
      contract: {
        reference: contract.reference,
        currentDeliveryRate: band ? band.rate : null,
        currentBandEnds: band ? band.to : null,
        nextDeliveryRate: next ? next.rate : null,
        rateSwitchDay: switchDay,
        daysUntilRateSwitch: daysUntil(today, switchDay),
        pickupFee: contract.pickupFee,
        paymentFee: contract.paymentFee,
        monthlySubscription: contract.monthlySubscription,
        pickupPromoMerchantCapPerOrder: contract.pickupPromo.merchantCapPerOrder,
        pickupPromoMinCustomerDiscount: contract.pickupPromo.minCustomerDiscount,
        deliveryBands: contract.deliveryBands,
      },
      target: {
        ordersPerDay: target,
        ordersPerMonth: target * 30,
        basketUsed: basket,
        revenuePerDayAtTarget: money(target * basket),
        revenuePerMonthAtTarget: money(target * basket * 30),
        feesPerMonthAtCurrentRate: band
          ? money(target * basket * 30 * (band.rate + contract.paymentFee) + contract.monthlySubscription)
          : null,
        feesPerMonthAtNextRate: next
          ? money(target * basket * 30 * (next.rate + contract.paymentFee) + contract.monthlySubscription)
          : null,
        netPerMonthAtCurrentRate: band
          ? money(target * basket * 30 * (1 - band.rate - contract.paymentFee) - contract.monthlySubscription)
          : null,
        netPerMonthAtNextRate: next
          ? money(target * basket * 30 * (1 - next.rate - contract.paymentFee) - contract.monthlySubscription)
          : null,
      },
    };
  }

  function validatePlan(raw, factNums) {
    const list = Array.isArray(raw?.steps) ? raw.steps : null;
    if (!list || !list.length) return { ok: false, error: "no steps array" };

    const steps = [];
    let droppedNoEvidence = 0, droppedUngrounded = 0;
    for (const [i, x] of list.entries()) {
      const how = Array.isArray(x?.how) ? x.how.map(str).filter(Boolean) : [];
      if (!str(x?.title) || !how.length) { droppedNoEvidence++; continue; }
      const evidence = str(x?.evidence);
      // The contract of this endpoint: a step with no cited figure is exactly
      // the generic advice we are trying not to ship.
      if (!evidence) { droppedNoEvidence++; continue; }
      if (!evidenceIsGrounded(evidence, factNums)) { droppedUngrounded++; continue; }
      steps.push({
        id: str(x.id) || `step-${i + 1}`,
        title: str(x.title),
        why: str(x.why),
        how,
        evidence,
        lever: oneOf(x.lever, LEVERS, "operations"),
        effort: oneOf(x.effort, EFFORTS, "medium"),
        expectedOrdersPerDay: Number.isFinite(Number(x.expectedOrdersPerDay))
          ? Math.round(Number(x.expectedOrdersPerDay) * 10) / 10
          : null,
        priority: Number.isFinite(Number(x.priority))
          ? Math.max(1, Math.min(12, Math.round(Number(x.priority))))
          : i + 1,
      });
    }
    if (steps.length < 3) {
      return { ok: false, error: `too few grounded steps (${steps.length}; dropped ${droppedNoEvidence} without evidence, ${droppedUngrounded} whose numbers are not in the data)` };
    }
    steps.sort((a, b) => a.priority - b.priority);
    // Renumber after sorting AND after the guard has removed steps: a list that
    // reads 1, 2, 3, 4, 6 makes the owner hunt for a step 5 that was dropped on
    // purpose. The count of dropped steps is reported separately in `guard`.
    steps.forEach((s, i) => { s.priority = i + 1; });

    const unknowns = Array.isArray(raw?.unknowns) ? raw.unknowns.map(str).filter(Boolean) : [];
    // Non-negotiable with four orders of history. A plan that lists no unknowns
    // is implicitly claiming this sample was enough to reason from, which is the
    // exact failure this endpoint exists to prevent — so it is rejected and the
    // retry is told why, rather than shipped with an empty section.
    if (!unknowns.length) {
      return { ok: false, error: "no unknowns listed — with 4 orders the model must state what it cannot know" };
    }
    return {
      ok: true,
      value: {
        plan: {
          headline: str(raw?.headline),
          // With this little history, "what we do not know" is a required part
          // of the answer, not a disclaimer.
          unknowns,
          steps,
        },
        guard: { droppedNoEvidence, droppedUngrounded, kept: steps.length },
      },
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     POST /api/hungerstation/plan  { from, to, target, focus, force, cachedOnly }

     Real numbers first, then a ranked plan in Egyptian Arabic.

     Three modes, because generating costs real money and merely OPENING a tab
     must never spend it:
       cachedOnly:true → return the stored plan or 404. Never calls the model.
       (default)       → stored plan if it is fresh, otherwise generate.
       force:true      → always generate.
  ───────────────────────────────────────────────────────────────────────── */
  app.post("/api/hungerstation/plan", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const body = await c.req.json().catch(() => ({}));
      const contract = resolveContract(await getSettingsData());
      const from = dayArg(body?.from, daysAgoISO(29));
      const to = dayArg(body?.to, todayISO());
      const tRaw = Number(body?.target);
      const target = Number.isFinite(tRaw) && tRaw > 0 ? Math.min(500, tRaw) : contract.targetOrdersPerDay;
      const focus = str(body?.focus);
      const force = body?.force === true;
      const cachedOnly = body?.cachedOnly === true;

      if (!force) {
        // cachedOnly ignores the freshness window: an older plan is still worth
        // showing instantly, and the UI labels it with its own timestamp.
        const hit = await pool.query(
          `SELECT * FROM ai_reports
            WHERE kind = $1 AND from_date = $2::date AND to_date = $3::date
              ${cachedOnly ? "" : `AND created_at > NOW() - INTERVAL '${CACHE_HOURS} hours'`}
            ORDER BY created_at DESC LIMIT 1`,
          [PLAN_KIND, from, to]
        );
        if (!hit.rowCount && cachedOnly) {
          return c.json({ ok: false, error: "not_found", dataWindow: { from, to } }, 404);
        }
        if (hit.rowCount) {
          const row = hit.rows[0];
          return c.json({
            ok: true, cached: true,
            generatedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
            model: row.model,
            dataWindow: { from, to },
            evidence: row.facts,
            ...row.result,
          });
        }
      }

      const provider = resolveProvider();
      if (!provider) {
        return c.json({
          ok: false,
          error: "no_llm_provider",
          hint: "set ANTHROPIC_API_KEY, or LITELLM_KEY for the https://llm.o2m8.me/v1 proxy",
        }, 503);
      }

      const facts = await buildPlanFacts(from, to, target);
      const factNums = collectFactNumbers(facts);
      const user = planUser(facts, focus);

      // One retry, with the validator's own complaint fed back in.
      let value = null, lastError = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt = attempt === 0
          ? user
          : `${user}\n\nملاحظة: المحاولة السابقة رجعت إجابة مرفوضة (${lastError}). التزم بمخطط الأداة، واملأ كل الحقول، والأهم: حقل evidence في كل خطوة لازم يحتوي رقم منقول حرفيًا من الـ JSON اللي فوق — مش رقم من عندك.`;
        try {
          const raw = await callTool(provider, { system: PLAN_SYSTEM, user: prompt, tool: PLAN_TOOL });
          const v = validatePlan(raw, factNums);
          if (v.ok) { value = v.value; break; }
          lastError = v.error;
        } catch (e) {
          lastError = e.message;
        }
      }
      if (!value) return c.json({ ok: false, error: `model response invalid after retry: ${lastError}`, evidence: facts }, 502);

      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO ai_reports (id, kind, from_date, to_date, model, facts, result)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,$7)`,
        [id, PLAN_KIND, from, to, provider.model, jb(facts), jb(value)]
      );

      return c.json({
        ok: true,
        cached: false,
        generatedAt: new Date().toISOString(),
        model: provider.model,
        dataWindow: { from, to },
        target,
        // The pack every `evidence` string was checked against.
        evidence: facts,
        ...value,
      });
    } catch (e) {
      console.error("[hungerstation] plan failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
}

export default { register };
