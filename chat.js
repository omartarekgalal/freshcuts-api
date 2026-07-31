/* ═══════════════════════════════════════════════════════════════════════════
   CHAT — ask the restaurant anything, get the real number back.

   Registered by index.js via `register(app, ctx)`.

     POST /api/chat              { message, history?, mode? } → { ok, reply, usedTools, data, elapsedMs }
     GET  /api/chat/suggestions  → 6–8 Arabic starter questions the data supports

   ── Why tool use and not a stuffed prompt ─────────────────────────────────
   A facts-pack prompt can only answer the questions its author anticipated,
   and the moment the owner asks something outside the pack the model has two
   choices: say "I don't know" or invent. So this module gives the model a set
   of tools, each backed by a real parameterised SQL aggregate in this file,
   and runs the standard agentic loop. Every number in the reply came out of
   Postgres a second earlier; the model's job is wording, not arithmetic.

   ── Business rules every query here obeys (same as analytics.js) ──────────
   1. MONEY IS VAT-INCLUSIVE. TabSense reports gross/discount/net EXCLUDING
      VAT; the receipt the owner holds is inclusive. We only read `total`,
      `gross_incl`, `discount_incl`. Never `gross`/`discount`/`net`.
   2. VOID AND REFUND ORDERS ARE NOT SALES (order_type ILIKE '%void%' /
      '%refund%'). A void never happened; a refund reverses a day already
      counted.
   3. THE BUSINESS DAY ROLLS AT 04:00 RIYADH. The kitchen runs past midnight,
      so a 01:30 order belongs to the previous `calendar_day`. TabSense owns
      that column — we never recompute a day from a timestamp. Hour-of-day
      reporting still uses the real Riyadh wall clock, so a Friday-night
      shift reads as Friday 12:00 → 03:00.
   4. Every ratio is null (not 0, not Infinity) when its denominator is empty,
      so the model can tell "no data" apart from "genuinely zero".
═══════════════════════════════════════════════════════════════════════════ */

/* ── LLM provider config (same convention as ai.js) ───────────────────────────
   1. ANTHROPIC_API_KEY → api.anthropic.com/v1/messages (native tool use)
   2. LITELLM_KEY       → the team's LiteLLM proxy (OpenAI-compatible shape).
      The proxy routes Anthropic models under an "anthropic/" prefix.        */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.AI_MODEL || "claude-sonnet-5";

const MAX_ROUNDS = 5;            // agentic loop cap — then one forced final answer
const LLM_TIMEOUT_MS = 90000;    // a chat turn should never hang the UI for longer
const MAX_HISTORY_TURNS = 10;    // bounded context; older turns are dropped
const MAX_MESSAGE_CHARS = 2000;
const MAX_TOKENS_SHORT = 3000;
const MAX_TOKENS_FULL = 8000;

/* ── SQL fragments. All assume the orders table is aliased `o`. ───────────── */
const TZ = "Asia/Riyadh";
const BIZ_DAY_START_HOUR = 4;
const LOCAL_TS = `(o.order_date AT TIME ZONE '${TZ}')`;
const LOCAL_HOUR = `(extract(hour from ${LOCAL_TS})::int)`;
const LOCAL_DOW = `(extract(dow from ${LOCAL_TS})::int)`;
// Business rule 2.
const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

// An order is a delivery-aggregator order when TabSense typed it 'External'
// (true from creation) OR when one of its payment methods is an aggregator
// wallet (only lands once paid). Both signals are needed — the POS logs some
// aggregator orders as Dine-in, so order_option lies.
const deliverySql = (appsParam) =>
  `(o.order_type ILIKE '%external%' OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY(${appsParam})))`;

// Which app an order came through. order_sources.source_note is the truth
// (FeedUs connector or cashier); the aggregator payment method is the
// fallback; 'external' means "delivery, app unknown".
const channelSql = (appsParam) => `
  CASE WHEN ${deliverySql(appsParam)} THEN
    lower(COALESCE(
      NULLIF(s.source_note, ''),
      (SELECT k FROM jsonb_object_keys(o.payments) k WHERE lower(k) = ANY(${appsParam}) LIMIT 1),
      'external'))
  ELSE 'inhouse' END`;

// First time we ever saw each phone, across BOTH identity sources: the
// TabSense directory and the cashier station's typed phone.
const FIRSTS_CTE = `
  firsts AS (
    SELECT pn, min(first_at) AS first_at FROM (
      SELECT phone_norm AS pn, min(filled_at) AS first_at
        FROM order_sources WHERE phone_norm <> '' GROUP BY 1
      UNION ALL
      SELECT phone_norm AS pn, min(COALESCE(first_order_at, registered_at)) AS first_at
        FROM ts_customers WHERE phone_norm IS NOT NULL AND phone_norm <> '' GROUP BY 1
    ) u GROUP BY 1
  )`;
// Identity of the human behind an order; the cashier's typed phone wins.
const IDENT_SQL = `COALESCE(NULLIF(s.phone_norm, ''), NULLIF(tc.phone_norm, ''))`;

const DEFAULT_DELIVERY_APPS = ["ninja", "feedus", "keeta", "hungerstation", "jahez", "toyou", "mrsool", "careem"];

const CHANNEL_LABELS = {
  inhouse: "داخل المطعم",
  keeta: "كيتا",
  hungerstation: "هنقرستيشن",
  ninja: "نينجا",
  jahez: "جاهز",
  toyou: "تو يو",
  mrsool: "مرسول",
  careem: "كريم",
  feedus: "تطبيقات التوصيل (فيدأس)",
  external: "توصيل — تطبيق غير محدد",
};
const chLabel = (id) => CHANNEL_LABELS[String(id || "").toLowerCase()] || id || "غير معروف";

// Postgres extract(dow): 0 = Sunday.
const DOW_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/* ── numeric helpers ──────────────────────────────────────────────────────── */
// pg returns NUMERIC / BIGINT as strings; everything user-facing goes through
// these so the JSON the model reads is made of real numbers.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => Math.round(num(v) * 100) / 100;      // TabSense totals carry float noise
const qtyN = (v) => Math.round(num(v) * 1000) / 1000;
// Ratio with an explicit "undefined" answer — see business rule 4.
const ratio = (a, b) => (num(b) === 0 ? null : Math.round((num(a) / num(b)) * 10000) / 10000);
// Percentage change, null when there is nothing to compare against.
const pct = (cur, base) =>
  (base === null || base === undefined || num(base) === 0
    ? null
    : Math.round(((num(cur) - num(base)) / num(base)) * 1000) / 10);

/* ── date helpers ─────────────────────────────────────────────────────────── */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const dayArg = (v, fallback) => (typeof v === "string" && DAY_RE.test(v) ? v : fallback);
const shiftDay = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);
const monthStart = (iso) => iso.slice(0, 8) + "01";
const dowOf = (iso) => new Date(iso + "T00:00:00Z").getUTCDay(); // 0 = Sunday

// The comparison window for compare_periods.
function comparisonWindow(from, to, vs) {
  const n = spanDays(from, to);
  if (vs === "lastweek") return { from: shiftDay(from, -7), to: shiftDay(to, -7) };
  if (vs === "lastyear") return { from: shiftDay(from, -365), to: shiftDay(to, -365) };
  const prevTo = shiftDay(from, -1);
  return { from: shiftDay(prevTo, -(n - 1)), to: prevTo };
}

const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");

// Arabic-Indic digits → Western, so "آخر ٧ أيام" parses like "آخر 7 أيام".
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const westernise = (s) => String(s || "").replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

/* ─────────────────────────────────────────────────────────────────────────────
   RELATIVE DATE RESOLUTION

   The model never computes a date. We resolve every window the owner might
   mean off the CURRENT BUSINESS DAY (rolls at 04:00 Riyadh — so at 01:00 the
   "today" he means is still yesterday's calendar date) and hand the whole
   calendar to the model as literal ISO strings. Detecting which phrase he
   used only picks the default; the rest stay available for follow-ups.
───────────────────────────────────────────────────────────────────────────── */
function buildCalendar(bizToday) {
  const thisMonthFrom = monthStart(bizToday);
  const lastMonthTo = shiftDay(thisMonthFrom, -1);
  // Saudi calendar week runs Sunday → Saturday.
  const weekFrom = shiftDay(bizToday, -dowOf(bizToday));
  return {
    today: { from: bizToday, to: bizToday, label: "النهاردة" },
    yesterday: { from: shiftDay(bizToday, -1), to: shiftDay(bizToday, -1), label: "أمس" },
    last7: { from: shiftDay(bizToday, -6), to: bizToday, label: "آخر ٧ أيام" },
    last14: { from: shiftDay(bizToday, -13), to: bizToday, label: "آخر ١٤ يوم" },
    last30: { from: shiftDay(bizToday, -29), to: bizToday, label: "آخر ٣٠ يوم" },
    thisWeek: { from: weekFrom, to: bizToday, label: "الأسبوع ده (من الأحد)" },
    lastWeek: { from: shiftDay(weekFrom, -7), to: shiftDay(weekFrom, -1), label: "الأسبوع اللي فات" },
    thisMonth: { from: thisMonthFrom, to: bizToday, label: "الشهر ده" },
    lastMonth: { from: monthStart(lastMonthTo), to: lastMonthTo, label: "الشهر اللي فات" },
  };
}

/** Which calendar key the owner's wording points at, plus any "آخر N يوم". */
function detectWindow(message, calendar, bizToday) {
  const t = westernise(message);
  const has = (...needles) => needles.some((n) => t.includes(n));

  const nDays = t.match(/آخر\s*(\d{1,3})\s*(?:يوم|أيام|ايام)/);
  if (nDays) {
    const n = Math.min(365, Math.max(1, parseInt(nDays[1], 10)));
    return { key: `last${n}`, from: shiftDay(bizToday, -(n - 1)), to: bizToday, label: `آخر ${n} يوم` };
  }
  const nWeeks = t.match(/آخر\s*(\d{1,2})\s*(?:أسبوع|اسبوع|أسابيع|اسابيع)/);
  if (nWeeks) {
    const n = Math.min(52, Math.max(1, parseInt(nWeeks[1], 10)));
    const d = n * 7;
    return { key: `last${d}`, from: shiftDay(bizToday, -(d - 1)), to: bizToday, label: `آخر ${n} أسبوع` };
  }

  if (has("الشهر اللي فات", "الشهر الماضي", "الشهر السابق")) return { key: "lastMonth", ...calendar.lastMonth };
  if (has("الشهر ده", "هذا الشهر", "الشهر الحالي", "الشهر دا")) return { key: "thisMonth", ...calendar.thisMonth };
  if (has("الأسبوع اللي فات", "الاسبوع اللي فات", "الأسبوع الماضي", "الاسبوع الماضي")) return { key: "lastWeek", ...calendar.lastWeek };
  if (has("الأسبوع ده", "الاسبوع ده", "هذا الأسبوع", "هذا الاسبوع", "الأسبوع دا")) return { key: "thisWeek", ...calendar.thisWeek };
  if (has("امبارح", "إمبارح", "أمس", "امس", "البارحة")) return { key: "yesterday", ...calendar.yesterday };
  if (has("النهاردة", "النهارده", "انهاردة", "اليوم", "النهارده")) return { key: "today", ...calendar.today };
  if (has("آخر اسبوع", "آخر أسبوع", "اخر اسبوع", "آخر 7", "اخر 7")) return { key: "last7", ...calendar.last7 };
  if (has("آخر شهر", "اخر شهر", "آخر 30", "اخر 30")) return { key: "last30", ...calendar.last30 };
  // Loose fallback — "اعملي تقييم للشهر" names no window but plainly means this
  // month. Checked last so it can never shadow the explicit phrases above.
  if (has("شهر")) return { key: "thisMonth", ...calendar.thisMonth };
  if (has("أسبوع", "اسبوع")) return { key: "thisWeek", ...calendar.thisWeek };
  return null;
}

/** "full" answers are for why/how/report/evaluate questions; everything else is one line. */
function detectMode(message, explicit) {
  if (explicit === "short" || explicit === "full") return explicit;
  const t = String(message || "");
  const FULL = ["ليه", "لماذا", "ليش", "إزاي", "ازاي", "كيف", "تقرير", "تقييم", "قيّم", "قيم ", "حلل", "تحليل",
    "اشرح", "شرح", "فسر", "وضح", "محتاج أصلح", "محتاج اصلح", "إيه اللي", "ايه اللي", "مقارنة", "قارن", "استراتيجية"];
  return FULL.some((k) => t.includes(k)) ? "full" : "short";
}

/* ═════════════════════════════════════════════════════════════════════════════
   TOOL DEFINITIONS — provider-neutral. Each has a matching SQL runner below.
═════════════════════════════════════════════════════════════════════════════ */
const DATE_PROPS = {
  from: { type: "string", description: "بداية الفترة بصيغة YYYY-MM-DD (استخدم التواريخ الجاهزة في التعليمات)" },
  to: { type: "string", description: "نهاية الفترة بصيغة YYYY-MM-DD (شاملة)" },
};

const TOOLS = [
  {
    name: "sales_summary",
    description: "إجمالي المبيعات لفترة: عدد الطلبات، الإيراد شامل الضريبة، متوسط الفاتورة، الخصومات، وتقسيم توصيل/داخل المطعم، ومتوسط اليوم. استخدمها لأي سؤال عن المبيعات أو الطلبات.",
    schema: { type: "object", properties: { ...DATE_PROPS }, required: ["from", "to"] },
  },
  {
    name: "compare_periods",
    description: "يقارن فترة بفترة أخرى (السابقة المماثلة، أو نفس الفترة الأسبوع الماضي، أو السنة الماضية) ويرجّع نسب التغيّر. استخدمها لأي سؤال فيه مقارنة أو 'عن أمس' أو 'ليه'.",
    schema: {
      type: "object",
      properties: {
        ...DATE_PROPS,
        vs: { type: "string", enum: ["prev", "lastweek", "lastyear"], description: "prev = الفترة السابقة المماثلة (الافتراضي)" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "top_items",
    description: "أعلى/أقل الأصناف مبيعًا في فترة، بالكمية أو بالإيراد، مع مقارنة بالفترة السابقة المماثلة لمعرفة الصاعد والهابط.",
    schema: {
      type: "object",
      properties: {
        ...DATE_PROPS,
        by: { type: "string", enum: ["revenue", "qty"], description: "الترتيب: بالإيراد (الافتراضي) أو بالكمية" },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "عدد الأصناف (افتراضي 10)" },
        direction: { type: "string", enum: ["top", "bottom"], description: "top = الأعلى (الافتراضي)، bottom = الأضعف" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "channel_breakdown",
    description: "توزيع الطلبات والإيراد على القنوات: داخل المطعم، كيتا، هنقرستيشن، نينجا وغيرها، مع النسبة من الإجمالي ومتوسط الفاتورة والتغيّر عن الفترة السابقة. استخدمها لأي سؤال عن تطبيق توصيل معيّن.",
    schema: { type: "object", properties: { ...DATE_PROPS }, required: ["from", "to"] },
  },
  {
    name: "hourly_pattern",
    description: "توزيع الطلبات والإيراد على ساعات اليوم (بتوقيت الرياض) وعلى أيام الأسبوع، مع أعلى وأضعف الساعات. استخدمها لأسئلة الذروة والجدولة والأوقات الميتة.",
    schema: { type: "object", properties: { ...DATE_PROPS }, required: ["from", "to"] },
  },
  {
    name: "customer_stats",
    description: "العملاء في فترة: عدد العملاء المعروفين، العملاء الجدد (أول طلب لهم)، العائدون، نسبة التكرار، ومتوسط إنفاق العميل، وأعلى العملاء.",
    schema: { type: "object", properties: { ...DATE_PROPS }, required: ["from", "to"] },
  },
  {
    name: "staff_performance",
    description: "أداء الكاشيرية/الموظفين في فترة: عدد الطلبات، الإيراد، متوسط الفاتورة، والخصومات لكل موظف. استخدمها لأي سؤال عن أحسن كاشير أو أداء الفريق.",
    schema: { type: "object", properties: { ...DATE_PROPS }, required: ["from", "to"] },
  },
  {
    name: "ad_spend",
    description: "صرف الإعلانات المدفوعة في فترة (تيك توك/ميتا/سناب): الإجمالي، التوزيع على المنصات والحملات، الليدز، وقيمة المبيعات مقسومة على الصرف.",
    schema: { type: "object", properties: { ...DATE_PROPS }, required: ["from", "to"] },
  },
  {
    name: "order_lookup",
    description: "يجيب فاتورة واحدة برقم الإيصال أو معرّف الطلب: التاريخ، الإجمالي، الخصم، طريقة الدفع، الأصناف، والمصدر.",
    schema: {
      type: "object",
      properties: { receiptOrId: { type: "string", description: "رقم الإيصال أو order_id" } },
      required: ["receiptOrId"],
    },
  },
  {
    name: "search_items",
    description: "يبحث عن أسماء الأصناف اللي فيها كلمة معيّنة، مع إجمالي الكمية والإيراد وآخر يوم اتباعت فيه. استخدمها أول لو صاحب المطعم ذكر اسم صنف مش متأكد من كتابته بالضبط.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "جزء من اسم الصنف" },
        ...DATE_PROPS,
      },
      required: ["query"],
    },
  },
];

/* ═════════════════════════════════════════════════════════════════════════════
   SYSTEM PROMPT (Arabic — the owner reads these answers)
═════════════════════════════════════════════════════════════════════════════ */
function systemPrompt({ calendar, bizToday, defaultWindow, mode }) {
  const cal = Object.entries(calendar)
    .map(([k, v]) => `- ${v.label}: ${v.from} → ${v.to}`)
    .join("\n");

  return `أنت مساعد صاحب مطعم "فريش كتس" في جدة بالسعودية. بتجاوب عن أي سؤال عن مطعمه بالأرقام الحقيقية.

## قواعد لا تُكسر
1. **ممنوع تمامًا اختراع أي رقم.** كل رقم بتقوله لازم يكون طالع من أداة نفّذتها في نفس الرسالة. لو ما نفّذتش أداة، ما تذكرش أرقام.
2. **قبل أي رقم، نادِ أداة.** حتى لو فاكر الرقم من رسالة سابقة — البيانات بتتحدّث، نفّذ الأداة تاني.
3. لو الأداة رجعت فاضي أو صفر، قول كده بصراحة: "مفيش بيانات للفترة دي" أو "صفر طلبات". ما تخمّنش وما تعوّضش برقم من فترة تانية من غير ما توضّح.
4. لو السؤال مالوش علاقة بالمطعم أو ببياناته (سياسة، أخبار، معلومات عامة، حاجة مش موجودة في الأدوات)، قول باختصار إنك بتجاوب بس عن بيانات المطعم — من غير ما تخترع.
5. لو السؤال غامض أو الصنف مش واضح، استخدم search_items أو اسأل سؤال توضيحي قصير بدل التخمين.

## أسلوب الرد
- بالعربية فقط، لهجة أعمال مصرية/خليجية واضحة ومباشرة — كأنك بتكلم صاحب المطعم شخصيًا.
- **الافتراضي: سطر واحد قصير** فيه الرقم الأساسي + المقارنة. مثال: "٣٬٢٤٠ ر.س من ٦٢ طلب · +١٢٪ عن أمس".
- **توسّع بس لما يسأل "ليه" أو "إزاي" أو يطلب "تقرير" أو "تقييم" أو "حلل"** — ساعتها اشرح الأسباب من أرقام حقيقية (قنوات، أصناف، ساعات، عملاء، خصومات) في ٣ إلى ٨ نقاط قصيرة، وكل نقطة معاها رقمها.
- الفلوس بالأرقام العربية-الهندية مع الفاصل: "١٬٢٣٤ ر.س". النِسب بعلامة ٪ (مثال: "+١٢٪" أو "−٩٪"). الأعداد كمان بالأرقام العربية-الهندية.
- كل المبالغ شاملة ضريبة القيمة المضافة. العملة ريال سعودي.
- ما تكتبش JSON ولا أسماء أعمدة ولا اسم الأداة في الرد. تكلم زي محاسب شاطر مش زي تقرير آلي.
- ما تبدأش بمقدمات زي "طبعًا" أو "حسب البيانات". ادخل في الرقم على طول.

## اليوم والتواريخ (محسوبة سلفًا — استخدمها كما هي)
اليوم التشغيلي الحالي: **${bizToday}** (يوم العمل بيبدأ ٤ الفجر بتوقيت الرياض، فطلب الساعة ١:٣٠ بالليل بيتحسب على اليوم اللي قبله).
${cal}

الفترة الافتراضية لهذا السؤال: **${defaultWindow.from} → ${defaultWindow.to}** (${defaultWindow.label}). لو صاحب المطعم ما حددش فترة، استخدمها.
كل أداة بتاخد from و to بصيغة YYYY-MM-DD — انقل التواريخ من فوق حرفيًا، ما تحسبش تواريخ بنفسك.

## ملاحظات على البيانات
- "توصيل" = طلبات تطبيقات التوصيل (كيتا، هنقرستيشن، نينجا...). "داخل المطعم" = الباقي.
- الطلبات الملغية والمرتجعة مستبعدة من المبيعات أصلًا.
- بيانات العملاء بتغطي بس الطلبات اللي اتسجّل معاها رقم تليفون — فنِسب العملاء الجدد/العائدين محسوبة من الطلبات المعروفة مش من كل الطلبات. وضّح ده لو كانت النسبة صغيرة.

${mode === "full"
      ? "صاحب المطعم طالب شرح/تقرير — وسّع في الرد بالنقاط، وكل نقطة معاها رقمها، واختم بأهم إجراء واحد ينفّذه."
      : "خلي الرد سطر واحد أو سطرين على الأكثر. لو عندك ملاحظة إضافية مهمة، ضيفها في نص جملة واحدة بس."}`;
}

/* ═════════════════════════════════════════════════════════════════════════════
   LLM CLIENT
═════════════════════════════════════════════════════════════════════════════ */
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

/**
 * One model turn. Returns a provider-neutral
 * { text, calls: [{ id, name, args }], raw } so the loop below never has to
 * know which wire format it is on.
 *
 * `withTools = false` is the forced-final-answer turn: the model must answer
 * from what it already fetched instead of asking for another round.
 */
async function modelTurn(provider, { system, messages, maxTokens, withTools }) {
  if (provider.kind === "anthropic") {
    const body = {
      model: provider.model,
      max_tokens: maxTokens,
      system,
      messages: messages.map(toAnthropicMessage),
    };
    if (withTools) {
      body.tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
    }
    const data = await postJSON(ANTHROPIC_URL, {
      "x-api-key": provider.key,
      "anthropic-version": ANTHROPIC_VERSION,
    }, body);

    const blocks = data.content || [];
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim(),
      calls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
      raw: blocks,
    };
  }

  // LiteLLM speaks OpenAI's function-calling shape.
  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, ...messages.map(toOpenAIMessage)].flat(),
  };
  if (withTools) {
    body.tools = TOOLS.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }
  const data = await postJSON(`${LITELLM_BASE}/chat/completions`, {
    authorization: `Bearer ${provider.key}`,
  }, body);

  const msg = (data.choices || [])[0]?.message || {};
  const calls = (msg.tool_calls || []).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }
    return { id: tc.id, name: tc.function?.name, args };
  });
  return { text: String(msg.content || "").trim(), calls, raw: msg };
}

/* Provider-neutral conversation entries:
     { role: "user"|"assistant", text }                 — plain turn
     { role: "assistant", calls, raw }                  — the model asked for tools
     { role: "tool", results: [{ id, name, output }] }  — what the tools returned  */
function toAnthropicMessage(m) {
  if (m.role === "tool") {
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: JSON.stringify(r.output),
      })),
    };
  }
  if (m.role === "assistant" && m.raw) return { role: "assistant", content: m.raw };
  return { role: m.role, content: m.text || "" };
}

function toOpenAIMessage(m) {
  if (m.role === "tool") {
    return m.results.map((r) => ({
      role: "tool",
      tool_call_id: r.id,
      name: r.name,
      content: JSON.stringify(r.output),
    }));
  }
  if (m.role === "assistant" && m.raw) {
    // Echo the assistant turn back exactly as the proxy produced it.
    return [{ role: "assistant", content: m.raw.content ?? "", tool_calls: m.raw.tool_calls || [] }];
  }
  return [{ role: m.role, content: m.text || "" }];
}

/* ═════════════════════════════════════════════════════════════════════════════
   REGISTER
═════════════════════════════════════════════════════════════════════════════ */
export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData } = ctx;

  /** Payment-method names that mean "delivery aggregator", overridable in settings. */
  async function deliveryApps() {
    let list = DEFAULT_DELIVERY_APPS;
    try {
      const s = await getSettingsData();
      if (Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length) list = s.deliveryAppMethods;
    } catch { /* settings are optional — the defaults are correct for this branch */ }
    return list.map((x) => String(x).toLowerCase());
  }

  /** The business day the restaurant is currently inside (rolls at 04:00 Riyadh). */
  async function bizToday() {
    const r = await pool.query(
      `SELECT ((now() AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date AS day`);
    return isoDay(r.rows[0].day);
  }

  /* ── Window sanitiser: every tool argument passes through here ───────────
     The model is told to copy dates verbatim, but a tool call is untrusted
     input like any other — anything that is not YYYY-MM-DD falls back to a
     safe default, and reversed ranges are swapped rather than returning an
     empty result the model would then have to explain. */
  function windowOf(args, fallback) {
    let from = dayArg(args?.from, fallback.from);
    let to = dayArg(args?.to, fallback.to);
    if (from > to) [from, to] = [to, from];
    // Cost guard: never let one question scan more than two years.
    if (spanDays(from, to) > 731) from = shiftDay(to, -730);
    return { from, to };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     TOOL RUNNERS — every aggregate is done by Postgres, parameterised.
  ═══════════════════════════════════════════════════════════════════════ */

  async function toolSalesSummary(from, to) {
    const apps = await deliveryApps();
    const r = (await pool.query(
      `SELECT count(*)::int AS orders,
              COALESCE(sum(o.total), 0)                                        AS revenue,
              COALESCE(sum(o.gross_incl), 0)                                   AS gross_incl,
              COALESCE(sum(o.discount_incl), 0)                                AS discount,
              count(*) FILTER (WHERE ${deliverySql("$3::text[]")})::int         AS delivery_orders,
              COALESCE(sum(o.total) FILTER (WHERE ${deliverySql("$3::text[]")}), 0) AS delivery_revenue,
              count(DISTINCT o.calendar_day)::int                              AS active_days
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`,
      [from, to, apps]
    )).rows[0];

    const orders = num(r.orders);
    const revenue = money(r.revenue);
    const deliveryOrders = num(r.delivery_orders);
    const deliveryRevenue = money(r.delivery_revenue);
    const days = spanDays(from, to);
    return {
      window: { from, to, days },
      orders,
      revenue,
      avgTicket: orders ? money(revenue / orders) : null,
      discount: money(r.discount),
      discountRateOfGross: ratio(r.discount, r.gross_incl),
      delivery: {
        orders: deliveryOrders,
        revenue: deliveryRevenue,
        shareOfOrders: ratio(deliveryOrders, orders),
        shareOfRevenue: ratio(deliveryRevenue, revenue),
      },
      inhouse: { orders: orders - deliveryOrders, revenue: money(revenue - deliveryRevenue) },
      perDay: { orders: money(orders / days), revenue: money(revenue / days) },
      activeDays: num(r.active_days),
      note: orders === 0 ? "مفيش أي طلبات مسجّلة في الفترة دي" : null,
    };
  }

  async function toolComparePeriods(from, to, vs) {
    const base = comparisonWindow(from, to, vs);
    const [cur, prev] = await Promise.all([toolSalesSummary(from, to), toolSalesSummary(base.from, base.to)]);
    return {
      current: cur,
      comparison: { ...prev, basis: vs },
      change: {
        orders: pct(cur.orders, prev.orders),
        revenue: pct(cur.revenue, prev.revenue),
        avgTicket: pct(cur.avgTicket, prev.avgTicket),
        deliveryOrders: pct(cur.delivery.orders, prev.delivery.orders),
        deliveryRevenue: pct(cur.delivery.revenue, prev.delivery.revenue),
        inhouseOrders: pct(cur.inhouse.orders, prev.inhouse.orders),
        inhouseRevenue: pct(cur.inhouse.revenue, prev.inhouse.revenue),
        discount: pct(cur.discount, prev.discount),
      },
      unit: "التغيّر بالنسبة المئوية، و null معناها مفيش أساس للمقارنة (الفترة السابقة صفر)",
    };
  }

  async function toolTopItems(from, to, by, limit, direction) {
    const orderBy = by === "qty" ? "qty_cur" : "rev_cur";
    const dir = direction === "bottom" ? "ASC" : "DESC";
    const prev = comparisonWindow(from, to, "prev");
    const rows = (await pool.query(
      `WITH o AS (
         SELECT o.order_id, o.calendar_day FROM ts_orders o
          WHERE o.calendar_day BETWEEN $3::date AND $2::date AND ${SALES_ONLY}
       )
       SELECT it.name,
              COALESCE(sum(it.qty)    FILTER (WHERE o.calendar_day >= $1::date), 0) AS qty_cur,
              COALESCE(sum(it.amount) FILTER (WHERE o.calendar_day >= $1::date), 0) AS rev_cur,
              COALESCE(sum(it.qty)    FILTER (WHERE o.calendar_day <  $1::date), 0) AS qty_prev,
              COALESCE(sum(it.amount) FILTER (WHERE o.calendar_day <  $1::date), 0) AS rev_prev,
              count(DISTINCT it.order_id) FILTER (WHERE o.calendar_day >= $1::date)::int AS orders_cur
         FROM ts_order_items it JOIN o ON o.order_id = it.order_id
        GROUP BY it.name
       HAVING COALESCE(sum(it.qty) FILTER (WHERE o.calendar_day >= $1::date), 0) > 0
        ORDER BY ${orderBy} ${dir}
        LIMIT $4::int`,
      [from, to, prev.from, limit]
    )).rows;

    const total = (await pool.query(
      `SELECT COALESCE(sum(it.amount), 0) AS rev, COALESCE(sum(it.qty), 0) AS qty
         FROM ts_order_items it JOIN ts_orders o ON o.order_id = it.order_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`,
      [from, to]
    )).rows[0];

    return {
      window: { from, to },
      comparedWith: prev,
      sortedBy: by === "qty" ? "qty" : "revenue",
      direction: direction === "bottom" ? "bottom" : "top",
      totals: { itemsRevenue: money(total.rev), itemsQty: qtyN(total.qty) },
      items: rows.map((x) => ({
        name: x.name,
        qty: qtyN(x.qty_cur),
        revenue: money(x.rev_cur),
        orders: num(x.orders_cur),
        shareOfItemsRevenue: ratio(x.rev_cur, total.rev),
        prevQty: qtyN(x.qty_prev),
        prevRevenue: money(x.rev_prev),
        qtyChangePct: pct(x.qty_cur, x.qty_prev),
        revenueChangePct: pct(x.rev_cur, x.rev_prev),
      })),
      note: rows.length ? null : "مفيش أصناف مسجّلة في الفترة دي",
    };
  }

  async function toolChannelBreakdown(from, to) {
    const apps = await deliveryApps();
    const prev = comparisonWindow(from, to, "prev");
    const rows = (await pool.query(
      `WITH scoped AS (
         SELECT o.calendar_day, o.total, ${channelSql("$4::text[]")} AS ch
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
          WHERE o.calendar_day BETWEEN $3::date AND $2::date AND ${SALES_ONLY}
       )
       SELECT ch,
              count(*) FILTER (WHERE calendar_day >= $1::date)::int              AS orders,
              COALESCE(sum(total) FILTER (WHERE calendar_day >= $1::date), 0)    AS revenue,
              count(*) FILTER (WHERE calendar_day <  $1::date)::int              AS prev_orders,
              COALESCE(sum(total) FILTER (WHERE calendar_day <  $1::date), 0)    AS prev_revenue
         FROM scoped GROUP BY 1 ORDER BY 3 DESC`,
      [from, to, prev.from, apps]
    )).rows;

    const totOrders = rows.reduce((a, r) => a + num(r.orders), 0);
    const totRevenue = rows.reduce((a, r) => a + num(r.revenue), 0);
    return {
      window: { from, to },
      comparedWith: prev,
      totals: { orders: totOrders, revenue: money(totRevenue) },
      channels: rows
        .filter((r) => num(r.orders) > 0 || num(r.prev_orders) > 0)
        .map((r) => ({
          id: r.ch,
          label: chLabel(r.ch),
          orders: num(r.orders),
          revenue: money(r.revenue),
          avgTicket: num(r.orders) ? money(num(r.revenue) / num(r.orders)) : null,
          shareOfOrders: ratio(r.orders, totOrders),
          shareOfRevenue: ratio(r.revenue, totRevenue),
          ordersChangePct: pct(r.orders, r.prev_orders),
          revenueChangePct: pct(r.revenue, r.prev_revenue),
        })),
      note: totOrders ? null : "مفيش طلبات في الفترة دي",
    };
  }

  async function toolHourlyPattern(from, to) {
    const [hourRows, dowRows, daysRow] = await Promise.all([
      pool.query(
        `SELECT ${LOCAL_HOUR} AS hour, count(*)::int AS orders, COALESCE(sum(o.total), 0) AS revenue
           FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
            AND o.order_date IS NOT NULL
          GROUP BY 1 ORDER BY 1`, [from, to]),
      pool.query(
        `SELECT ${LOCAL_DOW} AS dow, count(*)::int AS orders, COALESCE(sum(o.total), 0) AS revenue,
                count(DISTINCT o.calendar_day)::int AS days
           FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
            AND o.order_date IS NOT NULL
          GROUP BY 1 ORDER BY 1`, [from, to]),
      pool.query(
        `SELECT count(DISTINCT o.calendar_day)::int AS n FROM ts_orders o
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`, [from, to]),
    ]);

    const operatingDays = num(daysRow.rows[0].n);
    const byHour = new Map(hourRows.rows.map((r) => [num(r.hour), r]));
    // Ordered along the BUSINESS day (04:00 → 03:00) so "الذروة" reads as a shift.
    const hours = [];
    for (let i = 0; i < 24; i++) {
      const h = (BIZ_DAY_START_HOUR + i) % 24;
      const r = byHour.get(h) || {};
      hours.push({
        hour: h,
        orders: num(r.orders),
        revenue: money(r.revenue),
        avgOrdersPerDay: operatingDays ? money(num(r.orders) / operatingDays) : null,
      });
    }
    const active = hours.filter((h) => h.orders > 0);
    const sorted = [...active].sort((a, b) => b.orders - a.orders);

    return {
      window: { from, to },
      operatingDays,
      timezone: "Asia/Riyadh (ساعة الحائط الحقيقية)",
      hours,
      peakHours: sorted.slice(0, 3),
      weakestHours: sorted.slice(-3).reverse(),
      byDayOfWeek: dowRows.rows.map((r) => ({
        dow: num(r.dow),
        label: DOW_AR[num(r.dow)] || String(r.dow),
        orders: num(r.orders),
        revenue: money(r.revenue),
        days: num(r.days),
        avgRevenuePerDay: num(r.days) ? money(num(r.revenue) / num(r.days)) : null,
      })),
      note: active.length ? null : "مفيش طلبات بتوقيت مسجّل في الفترة دي",
    };
  }

  async function toolCustomerStats(from, to) {
    // "Known" = we have a phone from either identity source. Everything below is
    // a share of KNOWN orders, never of all orders — see the system prompt note.
    const agg = (await pool.query(
      `WITH ${FIRSTS_CTE},
       scoped AS (
         SELECT o.order_id, o.total, ${IDENT_SQL} AS pn
           FROM ts_orders o
           LEFT JOIN order_sources s ON s.order_id = o.order_id
           LEFT JOIN ts_customers  tc ON tc.customer_id = o.customer_id
          WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
       )
       -- pn exists on BOTH scoped and firsts, so every reference below must be
       -- qualified; an unqualified one is an ambiguity error, not a guess.
       SELECT count(*)::int                                                     AS all_orders,
              count(*) FILTER (WHERE scoped.pn IS NOT NULL)::int                AS known_orders,
              COALESCE(sum(scoped.total) FILTER (WHERE scoped.pn IS NOT NULL), 0) AS known_revenue,
              count(DISTINCT scoped.pn)::int                                    AS customers,
              count(DISTINCT scoped.pn) FILTER (
                WHERE f.first_at IS NOT NULL
                  AND ((f.first_at AT TIME ZONE '${TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date
                      BETWEEN $1::date AND $2::date)::int                       AS new_customers
         FROM scoped LEFT JOIN firsts f ON f.pn = scoped.pn`,
      [from, to]
    )).rows[0];

    const top = (await pool.query(
      `SELECT ${IDENT_SQL} AS pn, count(*)::int AS orders, COALESCE(sum(o.total), 0) AS revenue
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
         LEFT JOIN ts_customers  tc ON tc.customer_id = o.customer_id
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
          AND ${IDENT_SQL} IS NOT NULL
        GROUP BY 1 ORDER BY revenue DESC LIMIT 5`,
      [from, to]
    )).rows;

    const customers = num(agg.customers);
    const newC = num(agg.new_customers);
    const knownOrders = num(agg.known_orders);
    return {
      window: { from, to },
      allOrders: num(agg.all_orders),
      identifiedOrders: knownOrders,
      identificationRate: ratio(knownOrders, agg.all_orders),
      customers,
      newCustomers: newC,
      returningCustomers: customers - newC,
      newCustomerShare: ratio(newC, customers),
      ordersPerCustomer: ratio(knownOrders, customers),
      revenuePerCustomer: customers ? money(num(agg.known_revenue) / customers) : null,
      // A repeat order is any order beyond a customer's first inside this window.
      repeatOrderRate: customers ? ratio(knownOrders - customers, knownOrders) : null,
      topCustomers: top.map((r) => ({
        // Last 4 digits only — the full phone never needs to reach the model.
        phoneTail: String(r.pn).slice(-4),
        orders: num(r.orders),
        revenue: money(r.revenue),
      })),
      note: knownOrders === 0
        ? "مفيش أي طلب معاه رقم تليفون في الفترة دي — مؤشرات العملاء مش متاحة"
        : "كل نِسب العملاء محسوبة من الطلبات اللي معاها رقم تليفون فقط",
    };
  }

  async function toolStaffPerformance(from, to) {
    const rows = (await pool.query(
      `SELECT COALESCE(NULLIF(trim(o.staff_name), ''), '(غير مسجّل)') AS staff,
              count(*)::int AS orders,
              COALESCE(sum(o.total), 0)         AS revenue,
              COALESCE(sum(o.discount_incl), 0) AS discount,
              COALESCE(sum(o.gross_incl), 0)    AS gross_incl,
              count(DISTINCT o.calendar_day)::int AS days
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}
        GROUP BY 1 ORDER BY revenue DESC LIMIT 30`,
      [from, to]
    )).rows;

    const totOrders = rows.reduce((a, r) => a + num(r.orders), 0);
    const totRevenue = rows.reduce((a, r) => a + num(r.revenue), 0);
    return {
      window: { from, to },
      totals: { orders: totOrders, revenue: money(totRevenue) },
      staff: rows.map((r) => ({
        name: r.staff,
        orders: num(r.orders),
        revenue: money(r.revenue),
        avgTicket: num(r.orders) ? money(num(r.revenue) / num(r.orders)) : null,
        discount: money(r.discount),
        discountRate: ratio(r.discount, r.gross_incl),
        shiftDays: num(r.days),
        ordersPerDay: num(r.days) ? money(num(r.orders) / num(r.days)) : null,
        shareOfRevenue: ratio(r.revenue, totRevenue),
      })),
      note: rows.length === 0
        ? "مفيش طلبات في الفترة دي"
        : (rows.length === 1 && rows[0].staff === "(غير مسجّل)"
          ? "اسم الموظف مش مسجّل على الطلبات في الفترة دي"
          : null),
    };
  }

  async function toolAdSpend(from, to) {
    const rows = (await pool.query(
      `SELECT c.id, c.name, COALESCE(NULLIF(c.platform, ''), 'unknown') AS platform, c.status,
              COALESCE(sum(e.spend), 0)          AS spend,
              COALESCE(sum(e.impressions), 0)    AS impressions,
              COALESCE(sum(e.clicks), 0)         AS clicks,
              COALESCE(sum(e.results), 0)        AS results,
              COALESCE(sum(e.leads_whatsapp + e.leads_calls + e.leads_visits
                         + e.leads_delivery + e.leads_apps), 0) AS leads,
              count(*)::int AS logged_days
         FROM mk_entries e JOIN mk_campaigns c ON c.id = e.campaign_id
        WHERE e.day BETWEEN $1::date AND $2::date
        GROUP BY c.id, c.name, c.platform, c.status
        ORDER BY spend DESC LIMIT 30`,
      [from, to]
    )).rows;

    const sales = (await pool.query(
      `SELECT COALESCE(sum(o.total), 0) AS revenue, count(*)::int AS orders
         FROM ts_orders o
        WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`,
      [from, to]
    )).rows[0];

    const totalSpend = rows.reduce((a, r) => a + num(r.spend), 0);
    const totalLeads = rows.reduce((a, r) => a + num(r.leads), 0);
    const byPlatform = new Map();
    for (const r of rows) {
      const p = byPlatform.get(r.platform) || { platform: r.platform, spend: 0, leads: 0, campaigns: 0 };
      p.spend += num(r.spend); p.leads += num(r.leads); p.campaigns += 1;
      byPlatform.set(r.platform, p);
    }

    return {
      window: { from, to },
      totalSpend: money(totalSpend),
      totalLeads,
      costPerLead: totalLeads ? money(totalSpend / totalLeads) : null,
      byPlatform: [...byPlatform.values()].map((p) => ({
        platform: p.platform,
        spend: money(p.spend),
        leads: p.leads,
        costPerLead: p.leads ? money(p.spend / p.leads) : null,
        shareOfSpend: ratio(p.spend, totalSpend),
        campaigns: p.campaigns,
      })).sort((a, b) => b.spend - a.spend),
      campaigns: rows.map((r) => ({
        name: r.name,
        platform: r.platform,
        status: r.status,
        spend: money(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        results: money(r.results),
        leads: num(r.leads),
        costPerLead: num(r.leads) ? money(num(r.spend) / num(r.leads)) : null,
        loggedDays: num(r.logged_days),
      })),
      salesInSameWindow: { revenue: money(sales.revenue), orders: num(sales.orders) },
      // NOT a real ROAS — nothing attributes these sales to the ads. Labelled
      // so the model quotes it as the crude ratio it is.
      revenuePerSpendRiyal: totalSpend ? money(num(sales.revenue) / totalSpend) : null,
      note: rows.length
        ? "نسبة المبيعات إلى الصرف مؤشر خام — مفيش ربط مباشر بين الإعلان والفاتورة"
        : "مفيش صرف إعلانات مسجّل في الفترة دي",
    };
  }

  async function toolOrderLookup(needle) {
    const apps = await deliveryApps();
    const r = (await pool.query(
      `SELECT o.order_id, o.receipt, o.order_date, o.calendar_day, o.order_option, o.order_type,
              o.total, o.gross_incl, o.discount_incl, o.payments, o.staff_name, o.branch,
              ${channelSql("$2::text[]")} AS channel,
              s.source, s.source_note, s.customer_name
         FROM ts_orders o
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE o.receipt = $1 OR o.order_id = $1
        ORDER BY o.order_date DESC NULLS LAST LIMIT 1`,
      [needle, apps]
    )).rows[0];

    if (!r) return { found: false, query: needle, note: "مفيش فاتورة بالرقم ده" };

    const items = (await pool.query(
      `SELECT name, qty, amount, note FROM ts_order_items WHERE order_id = $1 ORDER BY idx`,
      [r.order_id]
    )).rows;

    return {
      found: true,
      order: {
        receipt: r.receipt,
        orderId: r.order_id,
        businessDay: isoDay(r.calendar_day),
        at: r.order_date instanceof Date ? r.order_date.toISOString() : r.order_date,
        type: r.order_type,
        option: r.order_option,
        channel: chLabel(r.channel),
        staff: r.staff_name || null,
        branch: r.branch || null,
        total: money(r.total),
        grossIncl: money(r.gross_incl),
        discount: money(r.discount_incl),
        paymentMethods: Object.keys(r.payments || {}),
        source: r.source || null,
        sourceNote: r.source_note || null,
        customerName: r.customer_name || null,
      },
      items: items.map((i) => ({ name: i.name, qty: qtyN(i.qty), amount: money(i.amount), note: i.note || null })),
    };
  }

  async function toolSearchItems(query, from, to) {
    const like = `%${String(query).replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    const scoped = !!(from && to);
    const params = scoped ? [like, from, to] : [like];
    const rows = (await pool.query(
      `SELECT it.name,
              COALESCE(sum(it.qty), 0)    AS qty,
              COALESCE(sum(it.amount), 0) AS revenue,
              count(DISTINCT it.order_id)::int AS orders,
              max(o.calendar_day) AS last_day
         FROM ts_order_items it JOIN ts_orders o ON o.order_id = it.order_id
        WHERE it.name ILIKE $1 ESCAPE '\\' AND ${SALES_ONLY}
          ${scoped ? "AND o.calendar_day BETWEEN $2::date AND $3::date" : ""}
        GROUP BY it.name ORDER BY revenue DESC LIMIT 20`,
      params
    )).rows;

    return {
      query,
      window: scoped ? { from, to } : "كل التاريخ المتاح",
      matches: rows.map((r) => ({
        name: r.name,
        qty: qtyN(r.qty),
        revenue: money(r.revenue),
        orders: num(r.orders),
        lastSoldDay: isoDay(r.last_day),
      })),
      note: rows.length ? null : "مفيش صنف اسمه فيه الكلمة دي",
    };
  }

  /** Dispatch one model-requested tool call. Never throws to the loop. */
  async function runTool(name, args, fallbackWindow) {
    try {
      switch (name) {
        case "sales_summary": {
          const w = windowOf(args, fallbackWindow);
          return await toolSalesSummary(w.from, w.to);
        }
        case "compare_periods": {
          const w = windowOf(args, fallbackWindow);
          const vs = ["prev", "lastweek", "lastyear"].includes(args?.vs) ? args.vs : "prev";
          return await toolComparePeriods(w.from, w.to, vs);
        }
        case "top_items": {
          const w = windowOf(args, fallbackWindow);
          const by = args?.by === "qty" ? "qty" : "revenue";
          const limit = Math.min(25, Math.max(1, parseInt(args?.limit, 10) || 10));
          const direction = args?.direction === "bottom" ? "bottom" : "top";
          return await toolTopItems(w.from, w.to, by, limit, direction);
        }
        case "channel_breakdown": {
          const w = windowOf(args, fallbackWindow);
          return await toolChannelBreakdown(w.from, w.to);
        }
        case "hourly_pattern": {
          const w = windowOf(args, fallbackWindow);
          return await toolHourlyPattern(w.from, w.to);
        }
        case "customer_stats": {
          const w = windowOf(args, fallbackWindow);
          return await toolCustomerStats(w.from, w.to);
        }
        case "staff_performance": {
          const w = windowOf(args, fallbackWindow);
          return await toolStaffPerformance(w.from, w.to);
        }
        case "ad_spend": {
          const w = windowOf(args, fallbackWindow);
          return await toolAdSpend(w.from, w.to);
        }
        case "order_lookup": {
          const needle = str(args?.receiptOrId, 80).trim();
          if (!needle) return { error: "لازم رقم إيصال أو معرّف طلب" };
          return await toolOrderLookup(needle);
        }
        case "search_items": {
          const q = str(args?.query, 80).trim();
          if (!q) return { error: "لازم كلمة للبحث" };
          const from = dayArg(args?.from, null);
          const to = dayArg(args?.to, null);
          return await toolSearchItems(q, from, to);
        }
        default:
          return { error: `أداة غير معروفة: ${name}` };
      }
    } catch (e) {
      // A failed tool is data, not a crash — the model is told to say so.
      console.error(`[chat] tool ${name} failed:`, e.message);
      return { error: "فشل تنفيذ الاستعلام", detail: e.message };
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     POST /api/chat
  ═══════════════════════════════════════════════════════════════════════ */
  app.post("/api/chat", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const startedAt = Date.now();

    try {
      const body = await c.req.json().catch(() => ({}));
      const message = str(body?.message, MAX_MESSAGE_CHARS).trim();
      if (!message) return c.json({ ok: false, error: "empty_message" }, 400);

      const provider = resolveProvider();
      if (!provider) {
        return c.json({
          ok: false,
          error: "no_llm_provider",
          hint: "set ANTHROPIC_API_KEY, or LITELLM_KEY for the https://llm.o2m8.me/v1 proxy",
        }, 503);
      }

      const today = await bizToday();
      const calendar = buildCalendar(today);
      const detected = detectWindow(message, calendar, today);
      // Default when he names no period: today for a "how are we doing" question.
      const defaultWindow = detected || { key: "today", ...calendar.today };
      const mode = detectMode(message, body?.mode);
      const maxTokens = mode === "full" ? MAX_TOKENS_FULL : MAX_TOKENS_SHORT;

      const system = systemPrompt({ calendar, bizToday: today, defaultWindow, mode });

      // Bounded history: last ~10 turns, text only. Tool traffic from earlier
      // turns is deliberately dropped — the model re-queries rather than
      // quoting a stale number, which is exactly rule 2.
      const history = Array.isArray(body?.history) ? body.history : [];
      const messages = history
        .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
        .slice(-MAX_HISTORY_TURNS)
        .map((h) => ({ role: h.role, text: str(h.content, MAX_MESSAGE_CHARS) }));
      messages.push({ role: "user", text: message });

      const usedTools = [];
      const data = {};
      let reply = "";

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const turn = await modelTurn(provider, { system, messages, maxTokens, withTools: true });

        if (!turn.calls.length) { reply = turn.text; break; }

        messages.push({ role: "assistant", text: turn.text, calls: turn.calls, raw: turn.raw });

        // Parallel tool calls in one turn are normal — run them together and
        // return every result in a single tool message.
        const results = await Promise.all(turn.calls.map(async (call) => {
          const out = await runTool(call.name, call.args, defaultWindow);
          usedTools.push({ name: call.name, args: call.args });
          // Keyed so a UI can render a chart next to the sentence; later calls
          // to the same tool win, which is what a follow-up question means.
          data[call.name] = out;
          return { id: call.id, name: call.name, output: out };
        }));
        messages.push({ role: "tool", results });

        // Out of rounds: force a text answer from what we already have.
        if (round === MAX_ROUNDS - 1) {
          messages.push({
            role: "user",
            text: "خلاص، جاوب دلوقتي من الأرقام اللي معاك بالفعل. ما تنادش أدوات تانية.",
          });
          const final = await modelTurn(provider, { system, messages, maxTokens, withTools: false });
          reply = final.text;
        }
      }

      if (!reply) reply = "ما قدرتش أطلع بإجابة من البيانات دلوقتي — جرّب تسأل بصيغة تانية.";

      return c.json({
        ok: true,
        reply,
        usedTools,
        data: Object.keys(data).length ? data : undefined,
        window: { from: defaultWindow.from, to: defaultWindow.to, label: defaultWindow.label },
        mode,
        model: provider.model,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (e) {
      console.error("[chat] failed:", e.message);
      return c.json({ ok: false, error: e.message, elapsedMs: Date.now() - startedAt }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════
     GET /api/chat/suggestions — chips the UI shows above the input.

     Only offers questions the data can actually answer: no point suggesting
     "أحسن كاشير" when staff_name was never filled, or an ads question when
     nothing was ever logged. Ordered most-useful-first, capped at 8.
  ═══════════════════════════════════════════════════════════════════════ */
  app.get("/api/chat/suggestions", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const today = await bizToday();
      const last30 = shiftDay(today, -29);

      const probe = (await pool.query(
        `SELECT
           (SELECT count(*) FROM ts_orders o
             WHERE o.calendar_day = $1::date AND ${SALES_ONLY})::int              AS today_orders,
           (SELECT count(*) FROM ts_orders o
             WHERE o.calendar_day BETWEEN $2::date AND $1::date AND ${SALES_ONLY})::int AS recent_orders,
           (SELECT count(*) FROM ts_order_items it JOIN ts_orders o ON o.order_id = it.order_id
             WHERE o.calendar_day BETWEEN $2::date AND $1::date AND ${SALES_ONLY})::int AS recent_items,
           (SELECT count(*) FROM ts_orders o
             WHERE o.calendar_day BETWEEN $2::date AND $1::date AND ${SALES_ONLY}
               AND COALESCE(trim(o.staff_name), '') <> '')::int                   AS staffed_orders,
           (SELECT count(DISTINCT o.staff_name) FROM ts_orders o
             WHERE o.calendar_day BETWEEN $2::date AND $1::date AND ${SALES_ONLY}
               AND COALESCE(trim(o.staff_name), '') <> '')::int                   AS staff_count,
           (SELECT count(*) FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
             WHERE o.calendar_day BETWEEN $2::date AND $1::date
               AND COALESCE(NULLIF(s.source_note, ''), '') <> '')::int            AS tagged_orders,
           (SELECT count(*) FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
             WHERE o.calendar_day BETWEEN $2::date AND $1::date AND s.phone_norm <> '')::int AS phoned_orders,
           (SELECT count(*) FROM mk_entries e
             WHERE e.day BETWEEN $2::date AND $1::date AND COALESCE(e.spend, 0) > 0)::int    AS ad_days`,
        [today, last30]
      )).rows[0];

      const s = [];
      if (num(probe.today_orders) > 0) s.push("مبيعات النهاردة كام؟");
      if (num(probe.recent_orders) > 0) {
        s.push("مبيعات الأسبوع ده مقارنة باللي فات؟");
        s.push("إيه اللي محتاج أصلحه في المطعم؟");
      }
      if (num(probe.recent_items) > 0) {
        s.push("أحسن صنف الأسبوع ده؟");
        s.push("أنهي أصناف نازلة عن الشهر اللي فات؟");
      }
      if (num(probe.tagged_orders) > 0) s.push("كيتا عاملة إيه الشهر ده؟");
      if (num(probe.staffed_orders) > 0 && num(probe.staff_count) > 1) s.push("مين أحسن كاشير الشهر ده؟");
      if (num(probe.recent_orders) > 0) s.push("إيه ساعات الذروة وإيه الساعات الميتة؟");
      if (num(probe.phoned_orders) > 0) s.push("كام عميل جديد الشهر ده؟");
      if (num(probe.ad_days) > 0) s.push("صرفت كام على الإعلانات الشهر ده؟");
      if (num(probe.recent_orders) > 0) s.push("اعملي تقييم للشهر");

      // Nothing in the cache yet — still return something honest to click.
      if (!s.length) s.push("مبيعات آخر ٣٠ يوم كام؟", "فيه بيانات مسجّلة من إمتى؟");

      return c.json({
        ok: true,
        businessDay: today,
        suggestions: [...new Set(s)].slice(0, 8),
      });
    } catch (e) {
      console.error("[chat] suggestions failed:", e.message);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
}
