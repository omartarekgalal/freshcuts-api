/* ═══════════════════════════════════════════════════════════════════════════
   AUTOPILOT — the ads agent. Runs on a schedule, reads every configured
   platform, joins ad spend with the restaurant's REAL sales, and then either
   proposes or (in auto mode) executes campaign actions inside hard guardrails.

   The loop each cycle:
     1. push conversions (CAPI) for the last 48h            → ads.syncOrders()
     2. pull campaigns + insights (3d and 7d windows)       → platform adapters
     3. join with real revenue (ts_orders + order_sources)  → true CPA/ROAS
     4. rules engine → decisions (pause / budget up / budget down / notes)
     5. LLM strategist (optional) → creative briefs + offer ideas, grounded
     6. mode=auto → execute within guardrails; mode=suggest → approval queue
     7. record the run + decisions; track progress toward the sales goal

   ── MONEY GUARDRAILS (all of them, in one place) ──────────────────────────
   • ADS_ALLOW_WRITE=1 must be set or nothing is ever sent (ads.js rule).
   • mode must be 'auto' for unattended writes; 'suggest' queues for approval.
   • budget changes are capped at settings.maxChangePct per step (default 30%).
   • a campaign's daily budget can never exceed settings.maxCampaignBudget.
   • the SUM of all daily budgets can never exceed settings.maxTotalBudget.
   • at most ONE budget change per campaign per 24h (learning-phase respect).
   • campaigns are only judged after settings.minSpend SAR of spend in the
     window — no verdicts on statistical noise.
   • kill rule: CPA > max(killMultiple × targetCpa, killCpa) with real spend → pause,
     أو صفر نية طلب مع صرف حقيقي. «النتيجة» معرّفة في ads.js/META_RESULT_MODEL.
   • the total ceiling is 20% of the revenue ALREADY IN THE TILL today,
     floored at 20% of the trailing-7 average so ads can run before sales
     arrive. Since revenue-so-far ≤ final revenue at every moment, the
     earned part can never breach the owner's 20% rule (see earnedCeiling).
     The intraday forecast still exists but is display-only — it never
     moves a riyal (movingCeiling.outlook).
   • no budget raise once delivery efficiency drops below 35% — money that
     lands after the kitchen closes is waste, not patience (deliveryEfficiency).
   • per-platform steps override the global step downward, never upward:
     Meta stays under 20% so the learning phase is not reset (PLATFORM_SCALING).
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import {
  PLATFORMS, byId, canSend, canManage, missingOf,
  redact, safeRequest, httpJson, writeAllowed, MAX_DAILY_BUDGET, DEFAULT_CURRENCY,
  sendPlatformWrite, writeGates, platformRead, readGate,
} from "./ads.js";
// قاعدة "العميل الجديد" الواحدة في الـ API كلها. الاقتصاديات تحت مبنية عليها
// بالحرف — لو حسبنا العملاء الجداد هنا بطريقة تانية هنقول للمالك رقمين
// مختلفين لنفس السؤال من نفس الداتا.
import { FIRST_ORDER_DAY_CTE } from "./analytics.js";

/* ═══════════════════════════════════════════════════════════════════════════
   LLM — نفس سلسلة المزوّدين بتاعة ai.js (أنثروبيك مباشر، وإلا LiteLLM)

   ── ليه الملف ده اتغيّر يوم ٢٤ أغسطس ─────────────────────────────────────
   المالك شاف الفاتورة: ~١٫٥ مليون توكن في اليوم، و٢ مليون يوم ١٣ أغسطس.
   الحساب اللي طلع من ap_decisions:
     • الجولة الكاملة كل ساعة، وكل جولة كانت بتنده الموديل مرتين:
       المستشار (runStrategist) + الوكيل (runAgent) بأدواته.
     • ٢٤–٤٦ نداء مستشار و٥٠–١٠٠ **دورة** وكيل في اليوم (١٢–١٣ أغسطس).
     • كل دورة وكيل بتبعت المحادثة **من أولها**: الـ system + الأدوات +
       نتايج كل الأدوات اللي فاتت. نتيجة get_performance لوحدها كانت
       مقصوصة عند ٢٤٬٠٠٠ حرف. يعني الدورة التانية بتدفع تمن الأولى تاني،
       والتالتة تمن الاتنين، وهكذا.
     • ومفيش أي prompt caching، فالجزء الثابت (الـ system والأدوات) كان
       بيتحاسب بالكامل في كل نداء.

   الإصلاح تلات طبقات، من الأرخص للأغلى:
     ١. **مانندهش أصلاً.** القواعد الصمّاء بتتصرّف لوحدها؛ الموديل بينده بس
        لما الوضع يتغيّر فعلاً (بصمة) أو يبقى فيه حاجة ملتبسة. شوف llmGate.
     ٢. **نبعت ملخّص مش كومة.** الحمولات اتقصّت (شوف TOOL_RESULT_MAX و
        compactPerf).
     ٣. **اللي بنبعته تاني يتخزّن.** cache_control على الجزء الثابت.
   وفوق ده كله ميزانية توكنز يومية بمفتاح قفل (tokenBudget) عشان الفاتورة
   ما تجريش في الضلمة تاني.
═══════════════════════════════════════════════════════════════════════════ */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
const AI_MODEL = process.env.AI_MODEL || "claude-sonnet-5";
/* الموديل الرخيص للشغل الروتيني. الوكيل بيقرا أرقام وبينفّذ قرار محسوم
   بالقواعد — ده تصنيف مش استراتيجية، وهايكو بيعمله بخُمس التمن
   (١$/٥$ للمليون مقابل ٣$/١٥$ لسونيت). المستشار (الكرياتيف والعروض) هو
   الوحيد اللي فعلاً محتاج الموديل الكبير، وهو بينده مرة في اليوم دلوقتي. */
const AI_MODEL_FAST = process.env.AI_MODEL_FAST || "claude-haiku-4-5";
const LLM_TIMEOUT_MS = 180000;

/* الكاش بيتقفل لوحده لو المزوّد رفض الشكل — مرة واحدة للعملية كلها، مش
   محاولة تانية في كل نداء. */
let cacheSupported = process.env.AI_PROMPT_CACHE !== "0";
const CACHE_MARK = { type: "ephemeral" };

/* عدّاد التوكنز. بيتكتب في ap_llm_usage عشان يعيش بعد كل نشرة، والنسخة
   اللي في الذاكرة عشان البوابة تقرا من غير ما تضرب الداتابيز كل نداء. */
const usageMem = { day: null, total: 0 };
let usageSink = null;    // بيتظبط من register() — (purpose, model, usage) => void

function llmProvider({ tier = "smart" } = {}) {
  const wanted = tier === "fast" ? AI_MODEL_FAST : AI_MODEL;
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: wanted, tier };
  }
  if (process.env.LITELLM_KEY) {
    const model = wanted.includes("/") ? wanted : `anthropic/${wanted}`;
    return { kind: "litellm", key: process.env.LITELLM_KEY, model, tier };
  }
  return null;
}

/* الاستخدام بيرجع بشكلين حسب المزوّد. بنوحّده هنا مرة واحدة عشان كل
   الحسابات فوق تقرا نفس الأسماء. */
export function normaliseUsage(raw, kind) {
  const u = raw || {};
  if (kind === "anthropic") {
    return {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheWrite: Number(u.cache_creation_input_tokens) || 0,
    };
  }
  const cached = Number(u.prompt_tokens_details?.cached_tokens) || 0;
  return {
    input: Math.max(0, (Number(u.prompt_tokens) || 0) - cached),
    output: Number(u.completion_tokens) || 0,
    cacheRead: cached,
    cacheWrite: Number(u.cache_creation_input_tokens) || 0,
  };
}

/* التوكنز اللي بتتحاسب فعلاً: الكاش بيتقرا بعُشر التمن والكتابة بـ ١٫٢٥،
   بس الميزانية اليومية بتعدّ **التوكنز** مش الفلوس عشان تفضل بسيطة
   ومقروءة. الوزن بيخلّي النداء المكاشّي ما ياكلش الميزانية بالغلط. */
export const billableTokens = (u) =>
  (u.input || 0) + (u.output || 0) + Math.round((u.cacheRead || 0) * 0.1) + Math.round((u.cacheWrite || 0) * 1.25);

function recordUsage(purpose, provider, raw) {
  const u = normaliseUsage(raw, provider.kind);
  const billed = billableTokens(u);
  const day = new Date().toISOString().slice(0, 10);
  if (usageMem.day !== day) { usageMem.day = day; usageMem.total = 0; }
  usageMem.total += billed;
  if (usageSink) { try { usageSink(purpose, provider, u, billed, day); } catch { /* المحاسبة عمرها ما توقّف الشغل */ } }
  return u;
}

async function llmPost(url, headers, body) {
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
    if (!res.ok) {
      const err = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
      err.httpStatus = res.status;
      throw err;
    }
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

/* رفض بسبب **شكل** الكاش، مش أي رفض. الفرق ده مهم: أول نسخة من الكود ده
   كانت بتعيد المحاولة على أي 400، فرسالة «رصيدك خلص» (وهي 400 برضه) كانت
   بتتقري «الكاش مرفوض» — يعني نداءين بدل واحد، والكاش بيتقفل غلط لباقي
   عمر العملية. بندوّر على اسم الحقل نفسه في الرسالة. */
export const isCacheShapeError = (msg = "") =>
  /cache_control|cache-control|ephemeral|prompt.?cach/i.test(String(msg));

/* نداء واحد مع إمكانية إطفاء الكاش لو المزوّد رفض شكله. المحاولة التانية
   بتحصل **مرة واحدة للعملية كلها**: أول رفض بيقفل الكاش لكل النداءات
   اللي بعده، فمفيش مضاعفة نداءات مستمرة. */
async function llmPostCached(url, headers, build) {
  const useCache = cacheSupported;
  try {
    return await llmPost(url, headers, build(useCache));
  } catch (e) {
    if (!useCache || e.httpStatus !== 400 || !isCacheShapeError(e.message)) throw e;
    cacheSupported = false;
    console.warn("[autopilot] prompt caching rejected by the provider — turned off for this process:", e.message);
    return llmPost(url, headers, build(false));
  }
}

/* الـ system بيترسل كبلوك واحد عليه علامة كاش. أنثروبيك بتقبل مصفوفة
   بلوكات في `system`، و LiteLLM بتمرّر نفس الشكل جوّه رسالة الـ system.
   الحد الأدنى للكاش ~١٠٢٤ توكن — الـ system بتاعنا فوقها بكتير. */
const cachedSystem = (system, on) =>
  on ? [{ type: "text", text: system, cache_control: CACHE_MARK }] : system;
const cachedSystemMsg = (system, on) => ({
  role: "system",
  content: on ? [{ type: "text", text: system, cache_control: CACHE_MARK }] : system,
});

async function llmTool(provider, { system, user, tool, maxTokens = 8000, purpose = "tool" }) {
  if (provider.kind === "anthropic") {
    const data = await llmPostCached(ANTHROPIC_URL,
      { "x-api-key": provider.key, "anthropic-version": ANTHROPIC_VERSION },
      (on) => ({
        model: provider.model, max_tokens: maxTokens, system: cachedSystem(system, on),
        messages: [{ role: "user", content: user }],
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
        tool_choice: { type: "tool", name: tool.name },
      }));
    recordUsage(purpose, provider, data.usage);
    const block = (data.content || []).find((b) => b.type === "tool_use");
    if (!block) throw new Error("model returned no tool_use block");
    return block.input;
  }
  const data = await llmPostCached(`${LITELLM_BASE}/chat/completions`,
    { authorization: `Bearer ${provider.key}` },
    (on) => ({
      model: provider.model, max_tokens: maxTokens,
      messages: [cachedSystemMsg(system, on), { role: "user", content: user }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    }));
  recordUsage(purpose, provider, data.usage);
  const call = ((data.choices || [])[0]?.message?.tool_calls || [])[0];
  if (!call) throw new Error("model returned no tool call");
  return JSON.parse(call.function.arguments || "{}");
}

/* ── دورة محادثة واحدة بأدوات حقيقية ────────────────────────────────────────
   نفس سلسلة المزوّدين، بس بدل ما نجبر الموديل على أداة واحدة، بنديله عدة
   أدوات وبنسيبه يقرر — وبنرجّع الرد بشكل موحّد مهما كان المزوّد.
   `native` هو رسالة المساعد بصيغة المزوّد نفسه عشان تترجّع في المحادثة زي
   ما هي (مينفعش نعيد تركيبها بإيدينا — هنكسر تسلسل الـ tool ids).          */
/* الأدوات ثابتة في كل نداء، فهي أول حاجة تستاهل تتخزّن. ترتيب الرندر عند
   أنثروبيك هو tools → system → messages، فعلامة الكاش بتتحط على **آخر**
   أداة عشان تغطّي اللستة كلها. */
function toolSpecs(provider, tools, cache = false) {
  const out = provider.kind === "anthropic"
    ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))
    : tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  if (cache && out.length) out[out.length - 1] = { ...out[out.length - 1], cache_control: CACHE_MARK };
  return out;
}

async function llmTurn(provider, { system, messages, tools, maxTokens = 4000, purpose = "agent" }) {
  if (provider.kind === "anthropic") {
    const data = await llmPostCached(ANTHROPIC_URL,
      { "x-api-key": provider.key, "anthropic-version": ANTHROPIC_VERSION },
      (on) => ({ model: provider.model, max_tokens: maxTokens, system: cachedSystem(system, on),
                 messages, tools: toolSpecs(provider, tools, on) }));
    recordUsage(purpose, provider, data.usage);
    const blocks = data.content || [];
    return {
      native: { role: "assistant", content: blocks },
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
      calls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
      stop: data.stop_reason || null,
      usage: data.usage || null,
    };
  }
  const data = await llmPostCached(`${LITELLM_BASE}/chat/completions`,
    { authorization: `Bearer ${provider.key}` },
    (on) => ({
      model: provider.model, max_tokens: maxTokens,
      messages: [cachedSystemMsg(system, on), ...messages],
      tools: toolSpecs(provider, tools, on),
    }));
  recordUsage(purpose, provider, data.usage);
  const msg = (data.choices || [])[0]?.message || {};
  return {
    native: msg,
    text: String(msg.content || "").trim(),
    calls: (msg.tool_calls || []).map((tc) => {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = { __parseError: tc.function?.arguments }; }
      return { id: tc.id, name: tc.function?.name, input };
    }),
    stop: (data.choices || [])[0]?.finish_reason || null,
    usage: data.usage || null,
  };
}

/* نتائج الأدوات بترجع للموديل بصيغة المزوّد. */
function toolResultMessages(provider, results) {
  if (provider.kind === "anthropic") {
    return [{ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text })) }];
  }
  return results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.text }));
}

/* ── Settings (single JSONB row, editable from the UI) ─────────────────────── */
const DEFAULT_SETTINGS = {
  mode: "suggest",            // off | suggest | auto
  goalDailySales: 10000,      // SAR/day — the "سوق جدة كله" target
  /* ── تكلفة النتيجة المستهدفة — الحساب بالكامل ─────────────────────────
     «النتيجة» بقت نية طلب (دوسة واتساب أو محادثة)، مش عميل. فمينفعش نحط
     هنا أقصى تكلفة للعميل الجديد زي ما كان متظبط (٢٢ ر.س) — ده ضمناً
     بيفترض إن ٨٦٪ من النوايا بتبقى عملاء، ومفيش أي رقم بيقول كده.

     ١. أقصى تكلفة مسموحة للعميل الجديد = قاعدة المالك:
          القيمة العمرية ١٢٩٫٠٤ ر.س × ٢٠٪ = **٢٥٫٨١ ر.س/عميل**
          (من /api/autopilot/economics يوم ٢٠٢٦-٠٨-١٣، متأكد منه لايف.
           الرقم بيتحرك كل يوم مع الأفواج: ٢٥٫٥٤ يوم ١٢، ٢٥٫٧٤ يوم ١١.
           التلاتة بيدوروا حوالين ٢٥٫٧ فالاشتقاق تحت مش حسّاس للفرق.)

     ٢. النية → عميل: قياسين، وبينهم فرق ٢٠ ضعف:
          • القاع (المتطابق بالجوال بس، ٣٠ يوم، /api/attribution/campaigns):
              ٢٠٩ نية ← ١٣ طلب ← ١٠ عملاء جدد = **٤٫٨٪**
              → المسموح = ٢٥٫٨١ × ٠٫٠٤٨ = **١٫٢٣ ر.س/نتيجة**
          • السقف (لو نسبنا كل عميل جديد دخل المطعم للإعلان):
              ٣٦١ عميل جديد ÷ ٣٢٩ نتيجة = **١٠٩٪** (يعني ≥ ١٠٠٪)
              → المسموح = **٢٥٫٨ ر.س/نتيجة** (سقف قاعدة المالك نفسها)

     ٣. القاع ده **مش نسبة تحويل، ده معدل تطابق**. صفحة الطلب ابتدت تبعت
        الجوال مع Contact/Lead يوم ٢٠٢٦-٠٨-٠٩ بس؛ قبلها ميتا شافت الـ Lead
        من غير أي معرّف نربط بيه. وكمان محادثات واتساب (٢٣٠ منهم!) مبتعديش
        على الموقع أصلاً فمالهاش utm نمسكه — عشان كده fc-wa-orders بتقرا
        صفر طلب مربوط رغم إنها أرخص حملة عندنا. يعني الـ ٤٫٨٪ دي أثر من نفس
        عمى القياس اللي بنصلّحه هنا، مش حكم على الحملات.

     فالبيانات **مش كفاية** نشتق منها الرقم — الفرق بين القاع والسقف ٢٠ ضعف،
     واللي بينهم مسألة قياس مش مسألة أداء. فبنختار عن قصد، والاختيار
     **محافظ** ومكتوب صراحة عشان محدش يفتكره مشتق:

       targetCpa = ١٢ ر.س/نتيجة  ← اختيار محافظ، مش رقم مشتق

     يعني بنراهن إن ٤٧٪ من النوايا بتبقى عميل جديد (١٢ ÷ ٢٥٫٨١). وأهم من كده:
       • أقسى ٢٫١ ضعف من الحد المتفائل (٢٥٫٨).
       • أقسى من الرقم اللي كان شغال (٢٢) — يعني بنضيّق مش بنوسّع.
       • بيفرّق فعلاً: على لقطة ٣ أيام، ٢ من ٥ حملات بس تحت الـ ١٢
         (fc-wa-orders ١٫٨٢ و fc-prospect-asc ١١٫١٩)، والتلاتة التانية فوقه
         وبتتقص. القاعدة رجعت تعرف تقول لأ.

     ٤. وأهم نقطة في الملف ده كله: **الرقم ده مش هو اللي بيحمي الفلوس**.
        حتى لو طلع متفائل، السقف الكلي بيقف على ٢٠٪ من الإيراد اللي دخل
        الدرج فعلاً النهارده (movingCeiling) + ٢٬٠٠٠ ر.س حد مطلق. يعني
        أسوأ حالة إن الوكيل يوزّع الـ ٢٠٪ غلط، مش إنه يعدّيها.
        اختبار «يوم كل الحملات فيه كاسبة» في results.test.mjs بيثبت ده. */
  targetCpa: 12,              // SAR per RESULT (نية طلب) — الاشتقاق فوق
  targetRoas: 4,              // revenue / spend the ads should hit
  minSpend: 50,               // SAR spent in the window before we judge at all
  minAgeDays: 2,              // campaign must be at least this old
  scaleStepPct: 25,           // budget increase step for winners
  cutStepPct: 30,             // budget decrease step for underperformers
  maxChangePct: 30,           // hard cap on any single budget change
  killMultiple: 3,            // CPA > killMultiple × targetCpa → pause
  /* ── أرضية خط القتل ──────────────────────────────────────────────────
     الإيقاف هو الفعل الوحيد اللي بيوقّف فلوس ومحدش بيرجّعه. وخط القتل كان
     مربوط بـ killMultiple × targetCpa، يعني تنزيل المستهدف من ٢٢ لـ ١٢
     كان هينزّل خط القتل من ٦٦ لـ ٣٦ **كأثر جانبي** ويقتل حملات كانت عايشة
     امبارح. تضييق خط الإيقاف قرار مالك، مش نتيجة إعادة معايرة هدف التوسّع.
     فالخط = الأكبر من (killMultiple × targetCpa) و killCpa. والقيمة
     الافتراضية ٦٦ = بالظبط الخط اللي كان شغال (٣ × ٢٢) — يعني سلوك القتل
     مبيتغيرش بالتغيير ده ولا خطوة. */
  killCpa: 66,                // SAR/نتيجة — أرضية خط القتل، مش بتتحرك مع targetCpa
  /* ── أقل عدد نتائج نحكم على تكلفتها ──────────────────────────────────
     تكلفة النتيجة محسوبة على نتيجة واحدة مش قياس، دي ضوضاء. والمنصات
     بتبلّغ النتائج متأخرة: في ليلة زحمة الصرف بيتسجّل فوراً والنتايج
     بتوصل بعد ساعات. يعني حملة عندها نتيجة واحدة في ٣ أيام ممكن يطلع
     عليها cpa فوق خط القتل من غير ما يكون حصل أي حاجة غير إن الليلة
     لسه بتتحسب — وتتقفل في عزّ الذروة.

     فالمسار المبني على التكلفة محتاج قياس حقيقي تحته. تحت الرقم ده
     بنطلع ملاحظة للمالك بدل أمر إيقاف.

     المسار التاني (صفر نتائج + صرف كبير) مش متأثر: «صفر» مش عيّنة صغيرة،
     دي المنصة بتقول مفيش ولا نية طلب واحدة. */
  minKillResults: 3,          // أقل نتائج في نافذة الـ ٣ أيام قبل ما تكلفتها توقّف حملة
  /* ── حملات النقرات: النتيجة هي النقرة ────────────────────────────────
     حملة هدفها TRAFFIC/CLICK/SWIPES بتشتري **نقرة**. عدّاد التحويلات
     بتاعها بيفضل صفر للأبد لإن البيكسل ملهوش تاريخ تحويلات أصلاً — يعني
     الصفر ده مش أداء وحش، ده عدّاد مستحيل يزيد. الحكم عليها بـ killCpa
     (٦٦ ر.س = سقف تكلفة **شرا**) غلط بمقدار مئتين ضعف: نقرة تيك توك
     كانت بـ ٠.٢٠ ر.س وسناب ٠.٤٥ ر.س، والقاعدة قفلت الاتنين.

     فحملة النقرات ليها خط بتاعها: تكلفة النقرة مقابل killCpc. */
  targetCpc: 1.0,             // ر.س/نقرة — تحت كده حملة النقرات كاسبة
  killCpc: 3.0,               // ر.س/نقرة — فوق كده تستاهل الإيقاف
  maxCampaignBudget: 500,     // SAR/day ceiling per campaign
  maxTotalBudget: 1000,       // احتياطي بس — السقف الحقيقي بيتحسب من المبيعات
                              // (شوف movingCeiling تحت). الرقم ده بيُستعمل لما
                              // المبيعات مش متقروءة أصلاً.
  budgetCooldownHours: 24,    // min hours between budget changes per campaign
  syncConversions: true,      // push CAPI events each cycle
  syncAudiences: true,        // refresh retargeting audiences nightly
  useLlm: true,               // creative briefs + strategy notes
  agent: true,                // الوكيل الذكي (تفكير + أدوات) — غير قواعد التشغيل
  agentMaxTurns: 6,           // سقف دورات المحادثة في الجولة الواحدة
  /* ── سياج الفاتورة ────────────────────────────────────────────────────
     الأرقام دي مش تجميل، دي اللي بتخلّي الفرق بين ~١٫٥ مليون توكن في اليوم
     و~٦٠ ألف. الاشتقاق:
       • الوكيل كان بينده كل ساعة (٢٤ جولة) + كل طوارئ. دلوقتي بينده لما
         يكون فيه **سبب**: قرار من القواعد، أو طوارئ، أو الوضع اتغيّر
         وعدّى `agentMinHours` من آخر جولة. اليوم الهادي = صفر نداء.
       • المستشار (كرياتيف وعروض) كان بينده كل ساعة برضه، وهو بيطلع نفس
         نوع الخطة. مرة في اليوم كفاية — `strategyEveryHours`.
       • الميزانية اليومية قفل نهائي: لو اتعدّت، أي نداء بيترفض ويتسجّل.
         الرقم الافتراضي (٣٠٠ ألف) أعلى من الاستهلاك المتوقّع (~٦٠ ألف)
         بخمس مرات، فهو سقف أمان مش خنّاق. */
  llmDailyTokenBudget: 300000, // توكنز/يوم (محسوبة) — فوقها كل النداءات بتتقفل
  agentMinHours: 6,            // أقل فاصل بين جولتين وكيل لما مفيش سبب جديد
  strategyEveryHours: 24,      // المستشار بينده كل كام ساعة على الأكتر
  agentAlwaysOnDecision: true, // قرار جديد من القواعد الصمّاء = سبب كافي ينده الوكيل
  emergencyCooldownHours: 6,  // نفس الطوارئ ما تتفتحش تاني قبل كده
  dayLog: true,               // نسأل «ليه اليوم ده كان كده؟» على الأيام الشاذة
  dayLogDeviationPct: 25,     // الانحراف عن وسيط نفس يوم الأسبوع اللي يستاهل سؤال
  platforms: { meta: true, tiktok: true, snapchat: true },
};

/* أقصى عدد دورات مهما قال الإعداد — سياج أخير ضد لوب لا نهائي بيحرق توكنز. */
const AGENT_TURN_CEILING = 12;

/* ── أقصى حجم نتيجة أداة بترجع للموديل ───────────────────────────────────
   كان ٢٤٬٠٠٠ حرف. ده مش سقف حماية، ده كان **الحجم الفعلي** للقطة الأداء:
   والمحادثة بتتبعت من أولها كل دورة، فنتيجة واحدة بحجم ده بتتحاسب مرة في
   كل دورة بعدها. ٦٬٠٠٠ حرف كفاية بعد ضغط اللقطة (compactPerf) — أي حاجة
   أكبر من كده الموديل مش بيقراها بجد، بيقرا أول شوية ويستنتج. */
const TOOL_RESULT_MAX = Math.max(2000, Number(process.env.AUTOPILOT_TOOL_RESULT_MAX) || 6000);

/* خط القتل بالريال للنتيجة الواحدة. أرضية `killCpa` بتمنع إن إعادة معايرة
   هدف التوسّع تضيّق خط الإيقاف كأثر جانبي — شوف DEFAULT_SETTINGS.killCpa. */
export const killLineOf = (s) =>
  Math.max(Number(s.killMultiple || 3) * Number(s.targetCpa || 0),
           Number(s.killCpa ?? DEFAULT_SETTINGS.killCpa) || 0);

/* ═══ إيه هي «النتيجة»؟ الهدف هو اللي بيقرّر ═══════════════════════════════
   ليلة ١٥ أغسطس قاعدة القتل قفلت تيك توك وسناب لإنها قرت `results = 0`.
   الحملتين هدفهم نقرات (تيك توك TRAFFIC/CLICK، سناب SWIPES) على بيكسل
   ملوش أي تاريخ تحويلات — يعني عدّاد النتايج بتاعهم **مستحيل هندسياً**
   يبقى غير صفر. الصفر ده قياس ناقص مش أداء وحش.

   والدليل: تيك توك جابت ٣٧٩ نقرة بـ ٧٤.٣٠ ر.س = ٠.٢٠ ر.س للنقرة على نسبة
   نقر ٠.٩١٪ (أحسن رقم تاريخي للحساب ٠.١٢٪)، وسناب ١٧٧ نقرة بـ ٠.٤٥ ر.س.
   دول أحسن حاجة في الحساب، والقاعدة سمّتهم «حملة ميتة فعلاً».

   ده نفس نوع الباج اللي اتصلح لميتا يوم ١٣ أغسطس (القارئ كان بيعدّ
   `purchase` بس، واللي عمره ما هيولّع لإن الدفع بيحصل في الكاشير) — بس
   الإصلاح ساعتها اتعمل في قارئ ميتا لوحده وما اتمدّش للهدف نفسه.        */
const CLICK_OBJECTIVES = {
  meta: ["OUTCOME_TRAFFIC", "LINK_CLICKS", "TRAFFIC"],
  tiktok: ["TRAFFIC", "CLICK"],
  /* سناب: AWARENESS_AND_ENGAGEMENT مع تحسين SWIPES. الهدف عندها واسع
     فبنقبله كهدف نقرات — أسوأ حالة إننا منقتلش حملة كان المفروض تتقتل،
     وده أرخص بكتير من إننا نقتل الكاسب. */
  snapchat: ["AWARENESS_AND_ENGAGEMENT", "SWIPES", "TRAFFIC", "WEB_VIEW", "WEB_CONVERSION_TRAFFIC"],
  google: [],
};

export function isClickObjective(platform, objective) {
  if (!objective) return false;
  const o = String(objective).toUpperCase();
  return (CLICK_OBJECTIVES[platform] || []).some((x) => o === x);
}

/* الموديل الموحّد للحكم على صف واحد. دالة نقية — مفيش I/O، تتجرّب على
   اللقطة المسجّلة.

   بترجّع:
     kind        "click" | "conversion"
     count       عدد النتايج بالمعنى الصحيح للهدف (نقرات للحملات النقرات)
     cost        تكلفة النتيجة الواحدة — أو **null** لو مفيش إشارة نحكم بيها
     killLine    الخط اللي فوقه الحملة تستاهل الإيقاف، بوحدة `cost` نفسها
     target      الخط اللي تحته الحملة كاسبة
     blind       مفيش قياس أصلاً → ممنوع أي قرار إيقاف مبني على التكلفة
     unit        نص عربي للوحدة، عشان الأسباب تتقري صح

   القاعدة اللي اتكسرت: **ممنوع نحسب تكلفة نتيجة لما مفيش إشارة تحويل
   موصولة**. الحساب ساعتها بيدّي صفر أو ما لا نهاية، والاتنين كذب.        */
export function resultModelOf(row, s = {}) {
  const click = isClickObjective(row.platform, row.objective);
  const w = row.w3 || row;
  const spend = Number(w.spend) || 0;

  if (click) {
    /* النقرة هي النتيجة. `null` = المنصة ما رجّعتش عدد نقرات خالص. */
    const clicks = w.clicks == null ? null : Number(w.clicks);
    const killLine = Number(s.killCpc ?? DEFAULT_SETTINGS.killCpc) || 0;
    const target = Number(s.targetCpc ?? DEFAULT_SETTINGS.targetCpc) || 0;
    return {
      kind: "click", count: clicks,
      cost: clicks != null && clicks > 0 ? spend / clicks : null,
      killLine, target, blind: clicks == null, unit: "نقرة",
      note: "حملة نقرات — النتيجة هي النقرة، والحكم بتكلفة النقرة مش بسقف تكلفة الشرا.",
    };
  }

  const results = w.results == null ? null : Number(w.results);
  return {
    kind: "conversion", count: results,
    cost: results != null && results > 0 ? spend / results : null,
    killLine: killLineOf(s), target: Number(s.targetCpa) || 0,
    blind: results == null, unit: "نتيجة", note: null,
  };
}

/* الميزانية اليومية الفعلية للحملة: بتاعتها لو هي شايلاها، وإلا مجموع
   ميزانيات مجموعاتها الإعلانية. الوكيل **بيدير** الأولى بس — لكنه لازم
   **يعدّ** الاتنين، وإلا السقف الكلي بيبقى كذبة. عندنا ٣ من ٥ حملات
   ميزانيتها على مستوى المجموعة (١٨٠ من ٢٩٠ ر.س/يوم كانت خفيّة تماماً). */
/* كل مجموعة شغّالة، بميزانية أو من غير. في حملة CBO المجموعات **مالهاش**
   ميزانية أصلاً (الرقم على الحملة) — فأي حاجة بتقرا حالة التعلّم لازم
   تستعمل دي، مش اللي تحتها. */
export const activeChildrenOf = (r) =>
  (r.adsets || []).filter((a) => a.status === "ACTIVE");

/* المجموعات **الشايلة ميزانيتها** — دول بس اللي ينفع يبقوا أهداف في ABO. */
export const activeAdsetsOf = (r) =>
  (r.adsets || []).filter((a) => a.status === "ACTIVE" && a.dailyBudget != null);

export const effectiveBudgetOf = (r) => {
  if (r.dailyBudget != null) return Number(r.dailyBudget);
  const kids = activeAdsetsOf(r);
  if (kids.length) return kids.reduce((a, x) => a + Number(x.dailyBudget), 0);
  return r.adsetBudget != null ? Number(r.adsetBudget) : 0;
};

/* ═══════════════════════════════════════════════════════════════════════════
   فين الميزانية أصلاً؟ — «الهدف» هو الوحدة اللي بنكتب عليها

   ميتا بتحط الميزانية في مكان من اتنين:
     • CBO — الرقم على الحملة، والمجموعات بتتقاسمه. الهدف = الحملة.
     • ABO — كل مجموعة شايلة رقمها، والحملة `daily_budget` بتاعها null.
             الهدف = كل مجموعة شغّالة لوحدها.

   الإيقاع كان بيشتغل على `r.dailyBudget != null` وبس، يعني الحملات ABO كانت
   **مالهاش وجود** عنده — لا بيرفعها ولا بيرجّعها. وده مش تفصيلة: أحسن
   مجموعتين في الحساب كله (fc-wa-walkin-5km و fc-wa-delivery-10km، ١٠٦
   محادثة على ٣ أيام بـ ١٫٧٢ ر.س للمحادثة) عايشين جوّه حملة ABO. يعني الأداة
   كانت بتشدّ في الحبال المش متوصّلة بحاجة.

   بنرجّع «أهداف» مسطّحة عشان باقي المنطق (رفع، تراجع، استرجاع، أسوار) يشتغل
   على وحدة واحدة مش على نوعين.                                             */
export function paceTargetsOf(rows = []) {
  const out = [];
  for (const r of rows) {
    if (r.status !== "ACTIVE") continue;
    const common = {
      platform: r.platform, campaignId: String(r.id), campaignName: r.name,
      proven: r.proven ?? null,
    };
    if (r.dailyBudget != null) {
      /* حملة CBO: الميزانية عليها، بس **التعلّم عند مجموعاتها**. وده بالظبط
         اللي وقع ليلة ١٢ أغسطس — كبّرنا ٣ حملات CBO والصرف الإضافي طلع صفر
         لإن مجموعاتها كلها لسه بتتعلّم. فبنجمّع حالة الأولاد على الحملة:
         تقدر تستوعب لو **أي** مجموعة خلصت تعلّمها، ومتخنقة لو **كلهم**
         متخنقين. */
      /* `activeChildrenOf` مش `activeAdsetsOf`: في CBO المجموعات مالهاش
         ميزانية، فلو فلترنا على الميزانية مكناش هنلاقي ولا واحدة — وهي
         بالظبط الحالة اللي التوريث ده اتعمل عشانها. */
      const kids = activeChildrenOf(r);
      const known = kids.filter((a) => a.learning);
      const L = known.length ? {
        done: known.some((a) => a.learning.done),
        limited: known.every((a) => a.learning.limited),
        learning: known.some((a) => a.learning.learning) && !known.some((a) => a.learning.done),
        status: null,
      } : (r.learning || null);
      const hasKidSpend = kids.some((x) => x.spendToday != null);
      const kidSpend = kids.reduce((a, x) => a + (Number(x.spendToday) || 0), 0);
      out.push({
        ...common, level: "campaign", id: String(r.id), name: r.name,
        dailyBudget: Number(r.dailyBudget),
        spend: Number(r.spend) || 0, results: r.results ?? null,
        spendToday: r.spendToday != null ? Number(r.spendToday) : (hasKidSpend ? kidSpend : undefined),
        learning: L, siblings: 1,
      });
      continue;
    }
    const kids = activeAdsetsOf(r);
    for (const a of kids) {
      out.push({
        ...common, level: "adset", id: String(a.id), name: a.name || String(a.id),
        dailyBudget: Number(a.dailyBudget),
        spend: Number(a.spend) || 0, results: a.results ?? null,
        spendToday: a.spendToday != null ? Number(a.spendToday) : undefined,
        learning: a.learning || null, siblings: kids.length,
      });
    }
  }
  return out;
}

/* مفتاح الهدف. المستوى جزء منه عن قصد: رقم المجموعة ورقم الحملة مش بيتلخبطوا
   عند ميتا، بس المفتاح الصريح بيمنع أي التباس في الدفتر وفي التبريد.       */
export const targetKeyOf = (t) => `${t.platform}:${t.level}:${t.id}`;

/* ── هل الهدف ده يقدر يبلع الفلوس أصلاً؟ ─────────────────────────────────
   ليلة ١٢ أغسطس أثبتت النقطة دي بالطريقة الوحشة: تكبير ٣ حملات CBO طلّع
   **صفر** صرف إضافي، لإن مجموعاتها كلها لسه في التعلّم — والصرف اليومي فضل
   ثابت مقابل ٥٠٠ ر.س ميزانية. يعني الميزانية مش القيد، الاستيعاب هو القيد.

   بنحكم بحاجتين مع بعض:
     ١. مرحلة التعلّم من ميتا نفسها (ads.js/readLearning).
     ٢. بيصرف قد إيه من ميزانيته فعلاً (fill) — الدليل العملي.

   والترتيب ده مش تجميل: لو رفعنا اللي متخنق بدل اللي شغّال، بنكون زوّدنا
   الرقم على الورق وبس.                                                     */
/* `dayFraction` = قد إيه عدّى من **يوم الحساب الإعلاني** (٠ → ١).
   من غيره المقارنة غلط: الساعة ٥ العصر مجموعة بتوزّع ميزانيتها مظبوط بتكون
   صارفة نص الميزانية، فمقارنتها بميزانية يوم كامل بتقول «٥٠٪ — متخنقة»
   وتقفل البوابة على كل حاجة الصبح. بنقارن باللي **المفروض** يكون اتصرف
   لحد دلوقتي.                                                              */
export function absorptionOf(t, { minFillPct = 60, dayFraction = 1 } = {}) {
  const budget = Number(t.dailyBudget) || 0;
  /* `Number(null)` = صفر مش NaN — فلازم نتشيّك على null بإيدنا، وإلا «مفيش
     قراءة» بتتقري «صرف صفر» وتقفل البوابة على مجموعة إحنا أصلاً عميانين
     عنها. نفس تفرقة null/0 بتاعة قارئ النتايج بالظبط. */
  const spent = t.spendToday == null ? NaN : Number(t.spendToday);
  const frac = Math.min(1, Math.max(0.05, Number(dayFraction) || 1));
  const expected = budget * frac;
  const fill = expected > 0 && Number.isFinite(spent) ? (spent / expected) * 100 : null;
  const L = t.learning || {};
  const fillTxt = fill == null ? "مفيش قراءة صرف لليوم"
    : `صرف ${ar(Math.round(spent))} من ${ar(Math.round(expected))} ر.س المفروض يكونوا اتصرفوا لحد دلوقتي (${ar(Math.round(fill))}٪)`;

  if (L.limited) {
    return { absorbs: false, rank: 0,
      why: `«${t.name}» متخنقة في التعلّم (LEARNING_LIMITED) — ${fillTxt}. زيادة الميزانية عليها بتكبّر الرقم على الورق ومبتزوّدش صرف حقيقي، فسبناها.` };
  }
  if (fill != null && fill < minFillPct) {
    return { absorbs: false, rank: 1,
      why: `«${t.name}» ${fillTxt} — لسه مش بتاكل اللي معاها، فزيادتها مش هتتصرف. سبناها لحد ما تملى ميزانيتها الحالية.` };
  }
  if (L.done) {
    return { absorbs: true, rank: 3,
      why: `«${t.name}» خارجة من التعلّم (SUCCESS) و${fillTxt} — دي اللي الريال الزيادة فيها بيتصرف فعلاً، فرفعناها هي.` };
  }
  if (L.learning) {
    return { absorbs: true, rank: 2,
      why: `«${t.name}» لسه في التعلّم بس ${fillTxt} — بناخد خطوة صغيرة عشان ما نصفّرش التعلّم.` };
  }
  return { absorbs: true, rank: 2,
    why: `«${t.name}» ${fillTxt} ومفيش قراءة لمرحلة التعلّم — بنمشي بالخطوة العادية.` };
}

/* ميتا بتصفّر التعلّم لو الميزانية نطّت. المجموعتين الوحيدتين اللي خلصوا
   تعلّم في الحساب كله هما بالظبط اللي بنفتح عليهم دلوقتي — فتصفير تعلّمهم
   معناه إننا كسّرنا الحاجة الوحيدة الشغّالة. الخطوة على المجموعة مسقوفة
   عند ١٩٪ مهما قالت الإعدادات. */
export const ADSET_MAX_STEP_PCT = 19;

/* ── Rules engine — pure function, unit-testable, no I/O ───────────────────────
   Input rows: { platform, id, name, status, dailyBudget, adsetBudget, ageDays,
                 w3: {spend, results, revenue}, w7: {spend, results, revenue} }
   Output: decisions [{kind, platform, campaignId, campaignName, detail, reason}]
   The 3-day window decides; the 7-day window is context in the reason text.

   `results` هنا = نية الطلب زي ما المنصة بتشوفها (دوسة «اطلب على واتساب»
   أو محادثة واتساب ابتدت من الإعلان)، مش الشرا. الشرا بيحصل جوّه المطعم
   وبيتبعت physical_store فالمنصة عمرها ما هتشوفه. التعريف الكامل وسبب
   استبعاد `purchase` في ads.js/META_RESULT_MODEL.                          */
export function decide(rows, s, recentBudgetChanges = new Set()) {
  const out = [];
  const killLine = killLineOf(s);
  let activeBudget = rows
    .filter((r) => r.status === "ACTIVE")
    .reduce((a, r) => a + effectiveBudgetOf(r), 0);

  for (const r of rows) {
    const w = r.w3 || { spend: 0, results: 0, revenue: 0 };
    const w7 = r.w7 || { spend: 0, results: 0, revenue: 0 };
    /* الهدف هو اللي بيقرّر إيه هي «النتيجة» — شوف resultModelOf فوق. */
    const rm = resultModelOf(r, s);
    const cpa = rm.cost;
    const killLineHere = rm.killLine;
    const roas = w.spend > 0 ? w.revenue / w.spend : null;
    const fmt = (n) => (n == null ? "—" : Math.round(n * 100) / 100);
    const ctx = `آخر ٣ أيام: صرف ${fmt(w.spend)} ر.س، ${rm.count ?? 0} ${rm.unit}` +
      (cpa != null ? `، تكلفة الـ${rm.unit} ${fmt(cpa)} ر.س` : "") +
      (roas != null ? `، العائد ${fmt(roas)}x` : "") +
      ` · آخر ٧ أيام: صرف ${fmt(w7.spend)} ر.س، ` +
      `${(rm.kind === "click" ? w7.clicks : w7.results) ?? 0} ${rm.unit}`;

    if (r.status !== "ACTIVE") continue;                       // paused → not ours to judge
    if ((r.ageDays ?? 99) < s.minAgeDays) {
      out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: {}, reason: `حملة جديدة (${r.ageDays} يوم) — لسه في فترة التعلّم، مفيش حكم قبل ${s.minAgeDays} أيام. ${ctx}` });
      continue;
    }
    if (w.spend < s.minSpend) {
      // Not enough signal — but flag a zombie that spends nothing at all.
      if (w.spend === 0 && w7.spend === 0) {
        out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
          detail: {}, reason: `حملة نشطة لكن مفيش أي صرف ٧ أيام — يا موقوفة من المنصة يا في مشكلة إعلان مرفوض. راجعها من مدير الإعلانات.` });
      }
      continue;
    }

    /* ── KILL: burning money with no or terrible results ──────────────────
       فرق `null` عن `0` هو بيت القصيد. `0` = المنصة ردّت وقالت صفر نية
       طلب، ودي إشارة حقيقية تستاهل الإيقاف. `null` = القارئ ما لقاش ولا نوع
       من أنواعنا في الصف أصلاً (المنصة عمياها أو الحقل مش راجع) — والإيقاف
       على قياس مش موجود هو بالظبط الباج اللي كان هيقفل الحساب كله يوم ١٤
       أغسطس. فالحالة دي بتطلع ملاحظة للمالك، مش أمر إيقاف. */
    if (rm.blind && w.spend >= s.minSpend * 2) {
      out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: {}, reason: `صرفت ${fmt(w.spend)} ر.س في ٣ أيام والمنصة مرجّعتش ولا ${rm.unit} نعرف نقراها — ده عمى قياس مش فشل حملة، فمش هنوقّفها عليه. راجع ربط البيكسل/الأحداث. ${ctx}` });
      continue;
    }
    /* ── الأرقام لسه بتستقر ────────────────────────────────────────────
       يوم الحساب الإعلاني بيلف بتوقيت America/Los_Angeles (حوالي ١٠ص
       بتوقيت جدة)، والقتل بيحصل في ساعات الفجر — يعني في نص اليوم
       المحاسبي. ليلة ١٥ أغسطس القرار اتاخد على صرف ٥٤.٦٧ ر.س والرقم
       النهائي طلع ٧٤.٣٠ — فرق ٣٦٪ جاي من تأخير التبليغ وبس.

       الإيقاف مالوش رجعة، فما بيتاخدش على رقم لسه بيتحرك. الملاحظة
       بتطلع للمالك والقرار بيستنى الأرقام المستقرة.                   */
    if (r.settling) {
      out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: {}, reason: `الأرقام دي لسه بتستقر (يوم الحساب الإعلاني ما لفّش) — مش هناخد قرار إيقاف عليها. ${ctx}` });
      continue;
    }
    /* عيّنة رفيعة: نتيجة أو اتنين في ٣ أيام. التكلفة المحسوبة عليها مش
       قياس — ونص الليلة الزحمة بيوصل متأخر، فالبسط ناقص والمقام كامل.
       الإيقاف هنا بيبقى على تأخير تبليغ مش على أداء. */
    const minResults = Math.max(1, Number(s.minKillResults ?? DEFAULT_SETTINGS.minKillResults) || 1);
    /* العيّنة الرفيعة قاعدة تحويلات: النقرات بتيجي بالمئات فمفيش «عيّنة
       رفيعة» فيها أصلاً. */
    const thinSample = rm.kind === "conversion"
      && rm.count != null && rm.count > 0 && rm.count < minResults;
    if (thinSample && cpa != null && cpa > killLineHere) {
      out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: {}, reason: `تكلفة النتيجة ${fmt(cpa)} ر.س فوق خط القتل (${fmt(killLineHere)}) — بس دي محسوبة على ${rm.count} نتيجة بس في ٣ أيام، وده أقل من ${minResults}. عيّنة زي دي بتتقلب برقم واحد، والمنصات بتبلّغ النتايج متأخر فالليلة اللي لسه شغالة بتطلع أغلى من حقيقتها. مش هنوقّفها على كده — راجعها بنفسك لو فضلت كده بكرة. ${ctx}` });
      continue;
    }
    /* صفر بالمعنى الصحيح للهدف: صفر **نقرة** لحملة نقرات، صفر **نية طلب**
       لحملة تحويلات. حملة نقرات جابت ٣٧٩ نقرة مش بتوصل هنا خالص. */
    const killing = (rm.count === 0 && w.spend >= s.minSpend * 2)
      || (cpa != null && cpa > killLineHere);
    if (killing) {
      out.push({ kind: "pause", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: { state: "PAUSED" },
        reason: rm.count === 0
          ? (rm.kind === "click"
            ? `صرفت ${fmt(w.spend)} ر.س في ٣ أيام من غير ولا نقرة واحدة — قاعدة القتل. ${ctx}`
            : `صرفت ${fmt(w.spend)} ر.س في ٣ أيام من غير ولا نية طلب واحدة (ولا دوسة «اطلب على واتساب» ولا محادثة) — قاعدة القتل. ${ctx}`)
          : `تكلفة الـ${rm.unit} ${fmt(cpa)} ر.س أعلى من خط القتل (${fmt(killLineHere)} ر.س/${rm.unit}) — قاعدة القتل. ${ctx}` });
      continue;
    }

    if (r.dailyBudget == null) {
      out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: {}, reason: `الميزانية متظبطة على مستوى المجموعة الإعلانية مش الحملة — الوكيل بيدير ميزانيات الحملات بس، فدي إدارتها يدوي. ${ctx}` });
      continue;
    }
    if (recentBudgetChanges.has(`${r.platform}:${r.id}`)) continue; // cooldown

    // ── SCALE: beating target → step the budget up, capped twice over ─────
    const winning = (cpa != null && cpa <= rm.target) || (roas != null && roas >= s.targetRoas);
    /* حملة نقرات كاسبة مبتتكبّرش أوتوماتيك. النقرة الرخيصة بتقول إن
       الكرياتيف شغّال، مش إن الريال الزيادة هيرجع طلبات — التحويل من
       نقرة لطلب لسه مش مقيس أصلاً (ده سبب الباج من أوله). فالتكبير هنا
       قرار مالك، والوكيل بيقول الرقم وبس. */
    if (winning && rm.kind === "click") {
      out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: {}, reason: `حملة نقرات بتجيب النقرة بـ ${fmt(cpa)} ر.س (تحت المستهدف ${rm.target} ر.س) — دي حملة كويسة ومش هنوقّفها. بس مش هنكبّرها أوتوماتيك كمان: النقرة الرخيصة مش دليل على طلبات لحد ما التحويل يتقاس. لو عايز تكبّرها زوّدها بنفسك. ${ctx}` });
      continue;
    }
    if (winning) {
      const stepPct = Math.min(s.scaleStepPct, s.maxChangePct);
      let next = Math.round(r.dailyBudget * (1 + stepPct / 100));
      next = Math.min(next, s.maxCampaignBudget);
      /* المساحة بتتحسب من `activeBudget` الجاري — والرقم ده بيتحدّث بعد كل
         قرار تحت. من غير التحديث ده كل حملة كاسبة كانت بتشوف نفس المساحة
         الأصلية، فيوم كل الحملات فيه كويسة كانوا بيعدّوا السقف مع بعض
         (كل واحدة لوحدها جوّه الحد، ومجموعهم بره). */
      const headroom = s.maxTotalBudget - activeBudget;
      if (next - r.dailyBudget > headroom) next = r.dailyBudget + Math.max(0, Math.floor(headroom));
      if (next > r.dailyBudget) {
        activeBudget += next - r.dailyBudget;
        out.push({ kind: "budget", platform: r.platform, campaignId: r.id, campaignName: r.name,
          detail: { from: r.dailyBudget, to: next },
          reason: `أداء أحسن من المستهدف${cpa != null ? ` (تكلفة النتيجة ${fmt(cpa)} ≤ ${rm.target} ر.س)` : ` (عائد ${fmt(roas)}x ≥ ${s.targetRoas}x)`} — تكبير تدريجي ${stepPct}٪ عشان الخوارزمية ما تتكسرش. ${ctx}` });
      } else if (r.dailyBudget >= s.maxCampaignBudget) {
        out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
          detail: {}, reason: `الحملة كاسبة بس وصلت سقف الميزانية (${s.maxCampaignBudget} ر.س/يوم). لو عايز توسّع أكتر ارفع السقف من الإعدادات — أو الأحسن: انسخ الحملة بجمهور جديد. ${ctx}` });
      }
      continue;
    }

    // ── CUT: worse than 1.5× target but not kill-worthy → step down ───────
    if (cpa != null && cpa > 1.5 * rm.target) {
      const stepPct = Math.min(s.cutStepPct, s.maxChangePct);
      const next = Math.max(20, Math.round(r.dailyBudget * (1 - stepPct / 100)));
      if (next < r.dailyBudget) {
        activeBudget -= r.dailyBudget - next;
        out.push({ kind: "budget", platform: r.platform, campaignId: r.id, campaignName: r.name,
          detail: { from: r.dailyBudget, to: next },
          reason: `تكلفة الـ${rm.unit} ${fmt(cpa)} ر.س أعلى من 1.5× المستهدف (${rm.target} ر.س) — تقليل الميزانية ${stepPct}٪ لحد ما الأداء يتحسن. ${ctx}` });
      }
    }
  }
  return out;
}

/* ── الأسوار كدوال نقية ────────────────────────────────────────────────────
   نفس معاملة decide(): مفيش I/O، فتتجرّب من غير سيرفر ولا قاعدة بيانات.
   بترجّع نص الرفض بالعربي، أو null لو الطلب جوه الحدود. الوكيل بيمر عليها
   قبل أي كتابة، وكل رفض بيترجع للموديل وبيتسجّل في ap_decisions.

   `rows` = لقطة الحملات: { platform, id, name, status, dailyBudget,
                            adsetBudget, spend, results, cpa, roas }          */

/* بيعدّ الميزانيات اللي بندبرها **و** اللي على مستوى المجموعة الإعلانية.
   لو عدّينا الأولى بس، السقف الكلي بيبقى بيحمي ٣٨٪ من الصرف الحقيقي. */
export const activeBudgetOf = (rows) => rows
  .filter((r) => r.status === "ACTIVE")
  .reduce((a, r) => a + effectiveBudgetOf(r), 0);

export function guardPause({ platform, campaignId }, s, rows, { writeOk }) {
  if (!writeOk) return "ADS_ALLOW_WRITE مش مساوي 1 — الكتابة على المنصات مقفولة من أصلها.";
  const row = rows.find((r) => r.platform === platform && r.id === String(campaignId));
  if (!row) return `مفيش حملة بالرقم ${campaignId} على ${platform} في اللقطة الحالية — راجع get_performance الأول.`;
  if (row.status !== "ACTIVE") return `الحملة "${row.name}" أصلاً ${row.status} — مفيش حاجة تتوقف.`;

  /* السور ده هو اللي **ما اشتغلش** ليلة ١٥ أغسطس. الوكيل (مش قواعد
     التشغيل) هو اللي قفل تيك توك وسناب، والسور سابه يعدّي لإن الشرط كان
     `row.cpa != null` — وحملة النقرات cpa بتاعها null بحكم التعريف، لإن
     المقام (عدّاد التحويلات) صفر مستحيل يزيد. يعني السور كان بيحمي
     الحملات اللي القياس شايفها بس، وبيسيب اللي القياس أعماها.

     دلوقتي السور بيتكلم بلغة الهدف: حملة نقرات بتتحاكم بتكلفة النقرة. */
  const rm = resultModelOf(row, s);
  if (row.spend >= s.minSpend && rm.cost != null && rm.cost <= rm.target) {
    return `مرفوض: "${row.name}" تكلفة الـ${rm.unit} ${Math.round(rm.cost * 100) / 100} ر.س وهي أقل من المستهدف (${rm.target} ر.س) — دي حملة كاسبة والقواعد بتقول ما توقفش الكاسب. قاعدة القتل بتشتغل عند تكلفة أعلى من ${rm.killLine} ر.س/${rm.unit}. لو عايز تقلل صرفها استخدم set_budget.`;
  }
  /* حملة نقرات شغّالة وبتجيب نقرات: ممنوع تتقفل بحجة «صفر تحويلات».
     ده بالظبط نص قرار ليلة ١٥ أغسطس. */
  if (rm.kind === "click" && row.spend >= s.minSpend && rm.count > 0 && rm.cost != null && rm.cost <= rm.killLine) {
    return `مرفوض: "${row.name}" حملة نقرات جابت ${rm.count} نقرة بتكلفة ${Math.round(rm.cost * 100) / 100} ر.س للنقرة — تحت خط القتل (${rm.killLine} ر.س/نقرة). عدّاد التحويلات بتاعها صفر لإن البيكسل ملوش تاريخ تحويلات، مش لإن الحملة فاشلة. ما توقفش حملة على قياس مش موصول.`;
  }
  return null;
}

/* الأسوار بقت بتفهم المستويين. القاعدة اللي مشينا عليها: **كل سور يفضل
   يعني نفس الحاجة**، وأي سور مش بيتقال على مستوى المجموعة بيتقال على
   **مجموع** مجموعات الحملة — مكتوب صراحة تحت عند كل واحد.

   `campaignId` في التوقيع هو رقم **الهدف** (حملة أو مجموعة). سايبين الاسم
   زي ما هو عشان ما نكسرش النداءات القديمة (أدوات الوكيل، مسار الإيقاع). */
export function guardBudget({ platform, campaignId, amount, level = null }, s, rows, { writeOk, cooldown, hardCap }) {
  if (!writeOk) return "ADS_ALLOW_WRITE مش مساوي 1 — الكتابة على المنصات مقفولة من أصلها.";
  const id = String(campaignId);
  const row = rows.find((r) => r.platform === platform && r.id === id);
  /* الهدف ممكن يكون مجموعة إعلانية جوّه حملة ABO — مش موجودة في `rows`
     كصف مستقل، فبندوّر عليها جوّه حملتها. */
  let parent = null, adset = null;
  if (!row) {
    for (const r of rows) {
      const hit = (r.adsets || []).find((a) => String(a.id) === id);
      if (hit) { parent = r; adset = hit; break; }
    }
  }
  if (!row && !adset) return `مفيش حملة ولا مجموعة إعلانية بالرقم ${campaignId} على ${platform} في اللقطة الحالية — راجع get_performance الأول.`;

  const to = Number(amount);
  if (!Number.isFinite(to) || to <= 0) return "المبلغ لازم يكون رقم موجب بالريال.";

  const isAdset = !!adset;
  const name = isAdset ? (adset.name || id) : row.name;
  const current = isAdset ? Number(adset.dailyBudget) : row.dailyBudget;

  if (level && ((level === "adset") !== isAdset)) {
    return `مرفوض: الطلب بيقول المستوى "${level}" و"${name}" مستواها "${isAdset ? "adset" : "campaign"}" — الرقم والمستوى لازم يتفقوا.`;
  }
  if (!isAdset && current == null) {
    /* حملة ABO نفسها مش هدف صالح: ميزانيتها مش موجودة أصلاً، والكتابة
       عليها بترجع خطأ من ميتا. الهدف الصح هو مجموعاتها. */
    const kids = activeAdsetsOf(row);
    return `مرفوض: "${row.name}" ميزانيتها على مستوى المجموعة الإعلانية مش الحملة — اكتب على المجموعة نفسها. `
      + (kids.length ? `المجموعات الشغالة: ${kids.map((a) => `${a.name} (${a.id})`).join("، ")}.` : "مفيش مجموعات شغالة فيها دلوقتي.");
  }
  if (isAdset && adset.dailyBudget == null) {
    return `مرفوض: "${name}" مش شايلة ميزانيتها (حملتها CBO) — الميزانية بتتظبط على الحملة.`;
  }

  /* سقف الحملة الواحدة. على مستوى المجموعة مفيش معنى نطبّقه على مجموعة
     لوحدها — فبنطبّقه على **مجموع** مجموعات الحملة بعد التغيير، وده بالظبط
     نفس المعنى اللي كان له على CBO: أقصى صرف يومي للحملة الواحدة. */
  const cap = Math.min(s.maxCampaignBudget, hardCap);
  if (isAdset) {
    const kids = activeAdsetsOf(parent);
    const sumAfter = kids.reduce((a, x) => a + (String(x.id) === id ? to : Number(x.dailyBudget)), 0);
    if (sumAfter > cap) {
      return `مرفوض: مجموع مجموعات "${parent.name}" هيبقى ${Math.round(sumAfter)} ر.س/يوم وده فوق سقف الحملة الواحدة (${cap} ر.س). السقف بيتقاس على الحملة كلها مش على المجموعة لوحدها.`;
    }
  } else if (to > cap) {
    return `مرفوض: ${to} ر.س/يوم فوق سقف الحملة الواحدة (${cap} ر.س). السقف ده إعداد المالك — لو عايز تعدّيه لازم هو يرفعه من الإعدادات، مش انت.`;
  }

  /* أقصى تغيير في الخطوة الواحدة. على المجموعة السقف أضيق (١٩٪) لإن ميتا
     بتصفّر التعلّم لو الميزانية نطّت — والمجموعتين اللي بنفتح عليهم دول هما
     الوحيدين اللي خلصوا تعلّم في الحساب. */
  const stepCap = isAdset ? Math.min(Number(s.maxChangePct) || 30, ADSET_MAX_STEP_PCT)
    : Number(s.maxChangePct) || 30;
  const changePct = Math.abs(to - current) / current * 100;
  if (changePct > stepCap + 0.001) {
    return `مرفوض: التغيير من ${current} لـ ${to} ر.س يعني ${Math.round(changePct)}٪ وده فوق أقصى تغيير مسموح في الخطوة الواحدة (${stepCap}٪${isAdset ? " على المجموعة الإعلانية — ميتا بتصفّر التعلّم لو الميزانية نطّت" : ""}). كبّر على خطوات.`;
  }

  /* السقف الكلي بيتقاس على الحساب كله بنفس الحسبة اللي بيتحسب بيها
     `activeBudgetOf` — وهي بقت بتعدّ الميزانيات على المستويين. */
  const after = activeBudgetOf(rows) - current + to;
  if (after > s.maxTotalBudget) {
    return `مرفوض: مجموع الميزانيات الشغالة هيبقى ${Math.round(after)} ر.س/يوم وده فوق السقف الكلي (${s.maxTotalBudget} ر.س). وقّف أو قلّل حاجة تانية الأول.`;
  }
  /* التبريد بيتشاف بمفتاح الهدف وبالمفتاح القديم مع بعض — عشان تبريد
     اتسجّل قبل التغيير ده ما يضيعش. */
  if (cooldown.has(`${platform}:${id}`)
    || cooldown.has(`${platform}:${isAdset ? "adset" : "campaign"}:${id}`)) {
    return `مرفوض: "${name}" ميزانيتها اتغيّرت خلال آخر ${s.budgetCooldownHours} ساعة — فترة تعلّم لازم تعدّي قبل أي تغيير تاني.`;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   الإيقاع اليومي (INTRADAY PACING) — الجزء النقي

   ليه ده موجود أصلاً. decide() فوق بيحكم على الحملة بـ `results` اللي المنصة
   بتقولها — ولحد ٢٠٢٦-٠٨-١٢ القارئ كان بيعدّ `purchase` وبس، والشرا عندنا
   بيحصل جوّه المطعم وبيتبعت CAPI بـ action_source = physical_store فميتا
   عمرها ما هترجّعه. يعني كل حملة كانت بتقرا صفر للأبد: cpa = null → شرط
   "winning" عمره ما يتحقق → عمر الوكيل ما هيكبّر حملة، وقاعدة القتل كانت
   هتوقّف الحساب كله يوم ١٤ أغسطس. القارئ اتصلّح (ads.js/META_RESULT_MODEL)
   وبقى يعدّ نية الطلب: دوسة «اطلب على واتساب» + محادثة واتساب من الإعلان.

   بس ده **ما بيلغيش السبب اللي الإيقاع اتعمل عشانه**. نية الطلب إشارة
   مبكّرة، مش فلوس. والتسريع جوّه اليوم بيصرف فلوس النهارده، فلازم يتعلّق
   بالفلوس اللي دخلت الدرج فعلاً: ts_orders بتتزامن كل ٥ دقايق. فرقم المنصة
   فضل سياق في نص السبب، والقرار فضل مبني على الكاشير.

   ── تلات ساعات مختلفة، وخلطهم بيكسر كل حاجة ──────────────────────────────
   ١. يوم المطعم بيلف الساعة ٤ فجراً بتوقيت الرياض (طلب ١:٣٠ بليل بيتحسب على
      اليوم اللي فات) — نفس القاعدة اللي في analytics.js.
   ٢. يوم الحساب الإعلاني بتوقيت America/Los_Angeles، يعني بيلف الساعة ١٠
      صباحاً بتوقيت جدة في التوقيت الصيفي و١١ في الشتوي.
   ٣. ساعة الحائط اللي بنكلّم بيها المالك = الرياض.

   الاسترجاع آخر اليوم لازم يتعلّق برقم (٢) — ميزانية اترفعت ١٠ مساءً بتوقيت
   جدة بتبقى تبع يوم الحساب اللي ابتدا ١٠ صباح نفس اليوم وبيقفل ١٠ صباح بكرة.
   لو رجّعناها قبل منتصف ليل جدة نكون رمينا عشر ساعات صرف على الأرض، ولو
   علّقنا الاسترجاع على يوم المطعم هيضرب في ساعة غلط أصلاً.

   كل اللي تحت دوال نقية: مفيش I/O، فبتتجرّب من غير سيرفر ولا قاعدة بيانات.
═══════════════════════════════════════════════════════════════════════════ */

/* تعريف ADS_ACCOUNT_TZ اتنقل لـ ads.js (الموديول الأدنى) عشان ads.js نفسه
   بقى محتاجه في dailySpend()، وما ينفعش يستورده من هنا — ده هيعمل دايرة
   استيراد (autopilot بيستورد من ads أصلاً). بنعيد تصديره عشان كل اللي
   بيستورده من autopilot.js يفضل شغّال، ويفضل تعريف واحد بس في الـ API كلها. */
export { ADS_ACCOUNT_TZ } from "./ads.js";
import { ADS_ACCOUNT_TZ } from "./ads.js";
export const RIYADH_TZ = "Asia/Riyadh";
export const BIZ_DAY_START_HOUR = 4;      // نفس رقم analytics.js — يوم المطعم

const tzFormatters = new Map();
function fmtFor(tz) {
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      // h23 مقصودة: hour12:false لوحدها بترجّع "24" لمنتصف الليل في بعض نسخ
      // ICU، وده بيخلي حساب "كام فاضل على نهاية اليوم" يطلع يوم كامل بالغلط.
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    tzFormatters.set(tz, f);
  }
  return f;
}

/* ساعة الحائط ليوم/ساعة أي منطقة زمنية — من غير مكتبات ومن غير حساب فروق
   يدوي (التوقيت الصيفي بيتظبط لوحده لإن Intl هي اللي بتترجم اللحظة). */
export function tzClock(at, tz) {
  const p = {};
  for (const part of fmtFor(tz).formatToParts(at)) if (part.type !== "literal") p[part.type] = part.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/* يوم الحساب الإعلاني (مش يوم جدة ولا يوم المطعم). */
export const accountDayOf = (at = new Date(), tz = ADS_ACCOUNT_TZ) => tzClock(at, tz).day;

/* كام مللي ثانية فاضلة على ما يوم الحساب الإعلاني يلف. */
export function msToAccountRoll(at = new Date(), tz = ADS_ACCOUNT_TZ) {
  const c = tzClock(at, tz);
  const elapsed = ((c.hour * 60 + c.minute) * 60 + c.second) * 1000 + Math.max(0, at.getTime() % 1000);
  return 86_400_000 - elapsed;
}

/* ── الأرقام لسه بتستقر؟ ──────────────────────────────────────────────────
   ليلة ١٥ أغسطس الطيار قفل تيك توك الساعة ٠١:٤٣ على قراية صرف ٥٤.٦٧ ر.س،
   والرقم النهائي بعد ما التقارير استقرت طلع ٧٤.٣٠ — فرق ٣٦٪ تأخير تبليغ
   وبس. وسناب اتقفلت ٠٠:٥٦، يعني في عزّ أحسن ساعة ونص في نافذتها.

   الإيقاف هو الفعل الوحيد اللي مالوش رجعة. فما بيتاخدش وإحنا جوّه
   النافذة والفلوس لسه بتتحرك والتقارير لسه بتلحق — الحملة الميتة فعلاً
   هتفضل ميتة بعد ما المطعم يقفل، والقرار ساعتها بيتاخد على أرقام مستقرة.

   يعني: القتل بيحصل والمطعم قافل، مش في نص الخدمة.                     */
export function numbersSettling(at = new Date(), s = {}) {
  return adsWindow(at, s).open;
}

/* ── اليوم اللي بنطلب بيه صرف "النهارده" من المنصات ─────────────────────
   ميتا بتفسّر time_range بتوقيت الحساب الإعلاني (America/Los_Angeles) —
   مش UTC ومش جدة. و todayISO() بترجّع تاريخ UTC، وتاريخ UTC بيسبق يوم
   حساب ميتا من ٠٠:٠٠ UTC (٣ الفجر بجدة) لحد ٠٠:٠٠ في لوس أنجلوس (١٠
   الصبح بجدة) — سبع ساعات كل يوم (تمانية في الشتا).

   في الساعات السبعة دي كنا بنطلب من ميتا يوم حساب لسه ما ابتداش. وميتا
   في الحالة دي مبترجّعش خطأ — بترجّع HTTP 200 و data فاضية، وإحنا بنجمع
   صفر ونقول "صرفنا صفر". ده اللي خلّى سطر التسوية يقول كل يوم إننا سبنا
   المستحق كله على الأرض.

   والرقم الصح هو يوم الحساب نفسه. وده كمان أنضف لسناب وجوجل في نفس
   الشباك: نافذة الإعلانات (١١ص → ٣ف بتوقيت جدة) بتقع جوّه يوم الحساب
   الإعلاني ويوم المطعم بنفس التاريخ، فالتلاتة بيوصفوا نفس ساعات الإعلان. */
export const spendDayNow = (at = new Date()) => accountDayOf(at);

/* الوسيط — مش المتوسط. يوم واحد شاذ (حفلة، عطلة، عطل في الكاشير) بيلوي
   المتوسط ومبيلويش الوسيط، وإحنا بنقارن بأربع أيام بس. */
export function medianOf(list) {
  const xs = (list || []).filter((v) => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const ar = (n) => new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));

/* ── النبض: النهارده لحد دلوقتي مقابل خط أساس نفس اليوم من الأسبوع ────────
   `comparables` = نفس يوم الأسبوع في آخر ٤ أسابيع، كل واحد مقصوص عند نفس
   عدد الساعات اللي عدّت من يوم النهارده. `operated` معناها إن المطعم اشتغل
   اليوم ده أصلاً — يوم مقفول بصفر مبيعات مش خط أساس، ده غياب بيانات.       */
export function shapePulse({ day, elapsedH, riyadhHour, riyadhMinute = 0, today, comparables = [] }) {
  const usable = comparables.filter((c) => c.operated);
  const baseOrders = medianOf(usable.map((c) => c.orders));
  const baseRevenue = medianOf(usable.map((c) => c.revenue));
  const paceRevenue = baseRevenue > 0 ? today.revenue / baseRevenue - 1 : null;
  const paceOrders = baseOrders > 0 ? today.orders / baseOrders - 1 : null;

  let level = "عالي", note = `خط الأساس مبني على ${usable.length} أيام مقارنة كاملة.`;
  if (usable.length < 2) {
    level = "ضعيف";
    note = usable.length === 0
      ? "مفيش ولا يوم مقارنة من نفس يوم الأسبوع في الكاش — الرقم ده مش خط أساس، ومينفعش يتبني عليه قرار ميزانية."
      : "يوم مقارنة واحد بس — ده مش وسيط، ده يوم. أي نسبة هنا ممكن تكون صدفة، فالتسريع مقفول.";
  } else if (usable.length < 3) {
    level = "متوسط";
    note = "يومين مقارنة بس — الوسيط هنا هو متوسط اليومين، فالنسبة تحتمل خطأ أوسع من المعتاد.";
  }

  return {
    day, elapsedH: r2(elapsedH), riyadhHour, riyadhMinute,
    // يوم الأسبوع بيوم المطعم (بيلف ٤ فجراً) — الساعة ٢ بالليل لسه ليلة امبارح.
    dow: new Date(String(day) + "T00:00:00Z").getUTCDay(),
    today: { orders: today.orders, revenue: r2(today.revenue) },
    baseline: {
      orders: baseOrders == null ? null : r2(baseOrders),
      revenue: baseRevenue == null ? null : r2(baseRevenue),
      days: usable.length,
      sample: comparables,
    },
    pace: paceRevenue,
    pacePct: paceRevenue == null ? null : Math.round(paceRevenue * 1000) / 10,
    paceOrders,
    paceOrdersPct: paceOrders == null ? null : Math.round(paceOrders * 1000) / 10,
    confidence: { level, note },
  };
}

/* الإعدادات الخاصة بالإيقاع — منفصلة عن إعدادات الجولة البطيئة عن قصد.
   الساعات هنا بتوقيت الرياض لإن دي الساعة اللي المالك بيفكر بيها. */
export const PACE_DEFAULTS = {
  pacing: true,                // شغّال؟
  paceStartHour: 13,           // أول ساعة رياض نبص فيها (المطبخ فاتح)
  paceLastRaiseHour: 1,        // آخر ساعة رياض نرفع فيها (بعد نص الليل بساعة)
  paceUpThresholdPct: 20,      // أسرع من خط الأساس بالنسبة دي → تسريع
  paceDownThresholdPct: -15,   // أبطأ منه بالنسبة دي → تراجع للأساس
  /* ── ليه ١٩٪ مش ١٥٪، وليه ٣ خطوات مش تسعة ─────────────────────────────
     الدليل من الدفتر نفسه (ap_pacing + ap_decisions + سجل الصرف):
       • ١١ أغسطس: ٦ خطوات، صرف ميتا ٣١٢٫٢١ ر.س.
       • ١٢ أغسطس: ٨ خطوات، الميزانية اتحركت من ١٦٠ لـ ٢٤٠ ر.س، صرف ميتا
         **٣٠٤٫٣٩** ر.س.
       • ١٣ أغسطس: ٥ خطوات، الميزانية وصلت ٢٨٠ ر.س، صرف ميتا **٣٠٦٫٩١** ر.س.
     تلات أيام، تسعة عشر رفعة، والصرف واقف عند ٣٠٥–٣١٢ ر.س. يعني الرفعات
     دي **ما حرّكتش ولا ريال**. اللي حرّك الصرف فعلاً كان يوم ١٤: إيقاف ٤
     مجموعات ميتة (١٣ أغسطس ٧:١٩ م) + رجوع حملة الريتارجيت + رفعة واحدة
     كبيرة — الصرف طلع ٥٩٤٫٢٨.

     الاستنتاج: الخطوة الصغيرة المتكرّرة مش «حذر»، دي **مجهود من غير أثر**
     بتكلفة حقيقية — كل لمسة على ad set في ميتا فيها خطر تصفير تعلّم.
     فالخطوة بقت ١٩٪ (أكبر رقم ميتا لسه بتعتبره «مش جوهري»، وهو نفس سقف
     PLATFORM_SCALING.meta.maxStepPct — يعني السقف مابيتخرقش)، والتبريد
     اتوسّع، وفيه سقف صريح لعدد اللمسات في اليوم.                          */
  paceStepPct: 19,             // خطوة الرفع/الخفض جوّه اليوم (تحت عتبة ٢٠٪ بتاعة ميتا)
  paceMaxUpliftPct: 60,        // أقصى زيادة تراكمية فوق ميزانية المالك
  paceCooldownMinutes: 90,     // أقل فاصل بين حركتين على نفس الحملة
  paceMaxStepsPerDay: 3,       // أقصى عدد رفعات على نفس الهدف في يوم الحساب الواحد
  paceMinBaselineDays: 2,      // أقل عدد أيام مقارنة نقبل نحكم بيها
  paceMinOrders: 6,            // أقل عدد طلبات النهارده قبل ما نصدّق الإيقاع
  paceRestoreBeforeMin: 45,    // نرجّع الميزانية قبل قفل يوم الحساب بكام دقيقة
  /* ── اليوم الشغّال: خطوة أكبر ────────────────────────────────────────
     «لما الدخل يزيد أو نتايج الإعلانات تتحسن يقدر يعمل scaling سريع
     ويستغل اليوم.» يوم بيجري ٤٥٪ فوق المعتاد مش نفس يوم بيجري ٢٢٪ — الخطوة
     الصغيرة في اليوم ده معناها إننا بنتفرج على فرصة بتعدي. الخطوة الكبيرة
     مشروطة بحاجتين مع بعض: النبض عالي فعلاً، وفيه مساحة تحت سقف الـ ٢٠٪. */
  paceHotThresholdPct: 40,     // النبض فوق كده = اليوم شغّال بجد
  paceHotStepPct: 25,          // الخطوة ساعتها (وبرضه محكومة بـ maxChangePct)
  paceHotMaxUpliftPct: 100,    // وسقف الزيادة التراكمية بيتوسّع في اليوم ده
  paceHotHeadroomPct: 20,      // لازم يفضل ٢٠٪ على الأقل من السقف الكلي فاضي
};

/* ═══════════════════════════════════════════════════════════════════════════
   قواعد التوسّع لكل منصة — الميديا باير مش بيعامل المنصات زي بعض

   كل قاعدة هنا معاها سببها، والسبب بيتكتب في اللوج مع القرار عشان المالك
   يقرا "ليه ميتا خطوتها ١٥٪ وجوجل ٣٠٪" من غير ما يسأل حد.

   ── ميتا: الخطوة محكومة بمرحلة التعلّم مش بالفلوس ────────────────────
   كل الـ ad sets عندنا لسه في LEARNING (١٧، ٢، ٢، ٢، ١، ٠ تحويل في الأسبوع
   مقابل عتبة ٥٠). تعديل جوهري على الميزانية بيصفّر التعلّم ويرجّع الـ ad set
   لأول السطر — وده أغلى بكتير من أي فرصة يوم واحد. عشان كده السقف ١٩٪
   (تحت عتبة الـ ٢٠٪ اللي ميتا بتعتبرها تعديل جوهري) والخطوة الافتراضية ١٥٪.

   وميتا فيها تفصيلة تانية: fc-leads-contact بيتحسّن على Contact وبيجيب ~١١٠
   حدث كل ٤ أيام — دي الحملة الوحيدة اللي ليها طريق حقيقي تخرج من التعلّم.
   الحملات اللي بتتحسّن على OFFSITE_CONVERSIONS بتجيب تحويلين في الأسبوع؛
   رفع ميزانيتها معناه إننا بنشتري تعلّم أغلى مش نتايج أكتر.

   ── سناب: القياس هو المشكلة مش الميزانية ─────────────────────────────
   ٣٣٣ حدث من ٨٨٥ رجعوا failed (٣٨٪) في أول أيام الربط. مانرفعش ميزانية
   منصة إحنا مش شايفين نتايجها — الفلوس الزيادة هتتصرف والقياس هيفضل أعمى.

   ── تيك توك: التوكن ناقص صلاحية ───────────────────────────────────────
   بيرجّع «Permission error … /campaign/get». يعني إحنا مش بنقرا حملاته أصلاً،
   فأي رفع هيبقى في الضلمة. مقفول لحد ما التوكن يتصلّح.

   ── جوجل: أسرع منصة استجابة ───────────────────────────────────────────
   البحث بيصرف على الطلب مش على التوزيع، وجوجل نفسها بتسمح للحملة تصرف لحد
   ٢× الميزانية اليومية وبتعوّض على مدار الشهر. مفيش مرحلة تعلّم بتتصفّر من
   تغيير ميزانية. فالخطوة أكبر (٣٠٪) والتبريد أقصر — بس بسقف مطلق صغير لحد
   ما يجيب داتا (٦١ رفعة تحويل فشلت أول يوم).
═══════════════════════════════════════════════════════════════════════════ */

export const PLATFORM_SCALING = {
  meta: {
    /* ٢٤ أغسطس — الخطوة اتوسّعت من ١٥٪ لـ ١٩٪ والتبريد من ٦٠ لـ ٩٠ دقيقة.
       الدليل من الدفتر: ١١–١٣ أغسطس أخدت ١٩ رفعة بـ ١٥٪ على ميتا وصرف
       ميتا فضل ٣١٢٫٢١ / ٣٠٤٫٣٩ / ٣٠٦٫٩١ ر.س — تلات أيام على نفس الرقم.
       الخطوة الصغيرة المتكرّرة مانقلتش فلوس، وكل لمسة فيها خطر تصفير
       تعلّم. ١٩٪ هي أكبر خطوة ميتا **لسه** مابتعتبرهاش تعديل جوهري، فإحنا
       بنكبّر الأثر من غير ما نلمس السور. ومع سقف ٣ لمسات في اليوم
       (paceMaxStepsPerDay) الزيادة التراكمية بتفضل تحت نفس سقف
       paceMaxUpliftPct زي ما كانت — يعني الفلوس مازادتش، اللمس هو اللي قلّ.
       الرقمين دول في الكود مش في الإعدادات عن قصد: صف الإعدادات المخزّن
       مثبّت على ١٥/٤٥ من قبل التغيير، والقاعدة دي مبنية على قياس مش على
       تفضيل، فمكانها هنا مع سببها. */
    stepPct: 19, maxStepPct: 19, cooldownMinutes: 90, allowed: true,
    why: "ميتا بتعتبر أي تعديل ميزانية ٢٠٪ أو أكتر «تعديل جوهري» وبتصفّر مرحلة التعلّم. كل الـ ad sets عندنا لسه في التعلّم، فالخطوة بتفضل تحت ٢٠٪ عشان نكبّر من غير ما نرجّع الحملة لأول السطر.",
    duplicateAtUpliftPct: 100,
    duplicateWhy: "لما الميزانية توصل ضعف رقم المالك، التوسّع الصح بيبقى نسخة جديدة من الـ ad set بجمهور مختلف مش ضغط أكتر على نفس المزاد — الضغط الزيادة على نفس الجمهور بيرفع الـ CPM من غير ما يجيب ناس جداد.",
  },
  snapchat: {
    stepPct: 10, maxStepPct: 20, cooldownMinutes: 90, allowed: false,
    why: "٣٨٪ من أحداث سناب رجعت failed، يعني إحنا مش شايفين نتايج المنصة دي أصلاً. مانرفعش ميزانية على منصة قياسها أعمى — أول حاجة نصلّح الربط، وبعدين نتكلم في التوسّع.",
  },
  tiktok: {
    stepPct: 0, maxStepPct: 0, cooldownMinutes: 120, allowed: false,
    why: "توكن تيك توك ناقصه صلاحية قراءة الحملات (Permission error على /campaign/get)، فإحنا مش قادرين نقرا حالة الحملة ولا صرفها. رفع ميزانية في الضلمة مش توسّع، ده رهان.",
  },
  google: {
    stepPct: 30, maxStepPct: 40, cooldownMinutes: 30, allowed: true,
    why: "إعلانات البحث بتصرف على طلب فعلي مش على توزيع، ومفيش مرحلة تعلّم بتتصفّر من تغيير الميزانية — فجوجل بتستجيب لأي زيادة في نص ساعة تقريباً. دي أسرع منصة نحوّل لها ريال زيادة.",
    unprovenCap: 100,
    unprovenWhy: "لسه جديدة ومفيش منها تحويل مؤكّد لحد دلوقتي، فمسقوفة عند ١٠٠ ر.س/يوم لحد ما تجيب أول عملاء نقدر نقيسهم.",
  },
};

/* الخطوة والسقف لمنصة معيّنة. `s` بتسمح للمالك يتحكم من الإعدادات، والقيم
   دي بتقص فوقها مش تحتها — يعني الإعدادات مش بتقدر توسّع خطوة ميتا فوق ١٩٪. */
export function platformScaling(platform, { s = {}, proven = null } = {}) {
  const p = PLATFORM_SCALING[String(platform || "").toLowerCase()];
  const globalStep = Number(s.paceStepPct) || 15;
  if (!p) {
    return { allowed: true, stepPct: globalStep, cooldownMinutes: Number(s.paceCooldownMinutes) || 45,
      cap: null, why: `مفيش قاعدة توسّع مخصّصة للمنصة دي، فبنمشي بالخطوة العامة ${globalStep}٪.` };
  }
  const step = Math.min(Number(p.stepPct) || 0, Number(p.maxStepPct) || 0,
    Math.max(globalStep, Number(p.stepPct) || 0), Number(s.maxChangePct) || 30);
  return {
    allowed: p.allowed !== false,
    stepPct: p.allowed === false ? 0 : step,
    cooldownMinutes: Math.max(Number(p.cooldownMinutes) || 45, Number(s.paceCooldownMinutes) || 45),
    cap: proven === false && p.unprovenCap ? Number(p.unprovenCap) : null,
    duplicateAtUpliftPct: p.duplicateAtUpliftPct || null,
    duplicateWhy: p.duplicateWhy || null,
    why: p.why + (proven === false && p.unprovenWhy ? ` ${p.unprovenWhy}` : ""),
  };
}

/* ── القرار ──────────────────────────────────────────────────────────────
   input:
     rows        لقطة الحملات: { platform, id, name, status, dailyBudget, spend, results }
     state       Map "platform:id" → { accountDay, baseBudget, currentBudget, lastActionAt, ... }
     s           الإعدادات (الجولة البطيئة + PACE_DEFAULTS)
     now         Date
     accountDay  يوم الحساب الإعلاني دلوقتي
     msToRoll    كام فاضل على ما يلف
     pulse       ناتج shapePulse (أو null)
     confirmed   { redemptions, linkedOrders } — دليلنا إحنا، مش دليل المنصة
   output: { phase, actions[], notes[], gate }                              */
export function decidePace(input) {
  const {
    rows = [], state = new Map(), now = new Date(),
    accountDay, msToRoll = Infinity, pulse = null,
    confirmed = { redemptions: 0, linkedOrders: 0 },
    hardCap = Infinity,
  } = input;
  const s = { ...PACE_DEFAULTS, ...(input.s || {}) };
  const nowMs = now.getTime();
  const actions = [], notes = [];
  const keyOf = (p, id) => `${p}:${id}`;

  /* ── ١. الاسترجاع. بييجي قبل أي حاجة تانية عشان ما نرفعش ميزانية في نفس
        الدقيقة اللي المفروض نرجّعها فيها. سببين للاسترجاع:
        (أ) يوم الحساب على وشك يقفل → القرار اللي المالك طلبه بالنص.
        (ب) الزيادة مسجّلة على يوم حساب قديم خلص خلاص → استرجاع متأخر.
        (ب) هي شبكة الأمان: لو الخدمة كانت واقعة وقت النافذة، أول تشغيلة
        بعدها بترجّع الفلوس بدل ما تفضل الزيادة شغالة يوم كامل زيادة.      */
  const restoreWindowMs = Math.max(5, Number(s.paceRestoreBeforeMin) || 45) * 60_000;
  const preRoll = msToRoll <= restoreWindowMs;
  const touched = new Set();

  for (const [key, st] of state) {
    const stale = st.accountDay !== accountDay;
    if (!stale && !preRoll) continue;
    const base = Number(st.baseBudget);
    if (!Number.isFinite(base) || base <= 0) continue;
    /* الاسترجاع لازم يبقى **متماثل** مع الرفع: أي حاجة رفعناها لازم ترجع
       بنفس المستوى اللي اترفعت بيه. الزيادة على مجموعة إعلانية مبترجعش
       لوحدها = بتبقى أساس اليوم اللي بعده من غير ما حد ياخد باله — وده
       بالظبط اللي كان هيحصل الليلة اللي فاتت مع ٤١/١٧.
       بندوّر على الهدف بمستواه: حملة في `rows`، أو مجموعة جوّه حملتها.   */
    const lvl = st.level || "campaign";
    const row = lvl === "adset" ? null : rows.find((r) => keyOf(r.platform, r.id) === key || targetKeyOf({ platform: r.platform, level: "campaign", id: r.id }) === key);
    const adset = lvl === "adset"
      ? rows.flatMap((r) => r.adsets || []).find((a) => String(a.id) === String(st.campaignId))
      : null;
    const liveNow = adset ? adset.dailyBudget : (row && row.dailyBudget != null ? row.dailyBudget : null);
    const cur = liveNow != null ? Number(liveNow) : Number(st.currentBudget);
    touched.add(key);
    const label = adset?.name || row?.name || st.campaignName || key;
    if (!Number.isFinite(cur) || cur <= base + 0.5) {
      notes.push({ key, op: "restore-noop", text: `"${label}" ميزانيتها ${ar(cur)} ر.س وهي مش أعلى من الأساس (${ar(base)}) — مفيش حاجة ترجع.` });
      continue;
    }
    actions.push({
      op: "restore", platform: st.platform, campaignId: st.campaignId,
      level: lvl, parentId: st.parentId || null,
      campaignName: label,
      from: r2(cur), to: r2(base), base: r2(base), accountDay: st.accountDay,
      reason: stale
        ? `استرجاع متأخر: الزيادة دي كانت على يوم الحساب الإعلاني ${st.accountDay} بتوقيت ${ADS_ACCOUNT_TZ} وهو قفل خلاص (إحنا دلوقتي في ${accountDay}). رجّعنا الميزانية من ${ar(cur)} لـ ${ar(base)} ر.س/يوم زي ما كانت قبل التسريع.`
        : `يوم الحساب الإعلاني ${st.accountDay} (بتوقيت ${ADS_ACCOUNT_TZ}) بيقفل بعد ${Math.round(msToRoll / 60000)} دقيقة — ده الساعة ١٠ صباحاً بتوقيت جدة مش نص الليل. رجّعنا الميزانية من ${ar(cur)} لـ ${ar(base)} ر.س/يوم زي ما اتفقنا: نسرّع النهارده ونرجّع الميزانية قبل ما اليوم يخلص.`,
    });
  }

  /* في نافذة الاسترجاع مفيش أي رفع — النافذة دي للتنضيف بس. */
  if (preRoll) return { phase: "restore", accountDay, msToRoll, actions, notes, gate: null };

  /* ── ٢. البوابات. كل رفض هنا بيترد بجملة بالعربي عشان تتسجّل وتتقري،
        مش بـ false صامتة تخلّي المالك يسأل "طب ليه ما عملش حاجة؟"          */
  const done = (gate, phase = "hold") => ({ phase, accountDay, msToRoll, actions, notes, gate });
  if (s.pacing === false) return done("التسريع اليومي مقفول من الإعدادات (pacing=false).");
  if (!pulse) return done("مفيش نبض مبيعات — مقدرناش نقرا ts_orders.");
  if (pulse.pace == null) return done("مفيش خط أساس بقيمة أكبر من صفر لنفس يوم الأسبوع — مفيش نسبة نقارن بيها.");

  const offsetOf = (h) => ((Number(h) - BIZ_DAY_START_HOUR) + 24) % 24;
  const startOffset = offsetOf(s.paceStartHour);
  const endOffset = offsetOf(s.paceLastRaiseHour);
  if (pulse.elapsedH < startOffset) {
    return done(`لسه بدري — الساعة ${pulse.riyadhHour}:00 بتوقيت الرياض والتسريع بيبدأ من ${s.paceStartHour}:00 لما المطبخ يبقى شغال ومبيعات الساعة تبقى معبّرة.`);
  }
  if (pulse.elapsedH > endOffset) {
    return done(`الوقت عدّى ${s.paceLastRaiseHour}:00 بتوقيت الرياض — المطبخ بيقفل، ورفع ميزانية دلوقتي هيصرف على ساعات مفيش فيها بيع.`);
  }
  if (pulse.baseline.days < Number(s.paceMinBaselineDays)) {
    return done(`خط الأساس مبني على ${ar(pulse.baseline.days)} يوم بس (المطلوب ${ar(s.paceMinBaselineDays)}) — ${pulse.confidence.note}`);
  }
  if (pulse.today.orders < Number(s.paceMinOrders)) {
    return done(`${ar(pulse.today.orders)} طلب بس لحد دلوقتي (المطلوب ${ar(s.paceMinOrders)} قبل ما نصدّق الإيقاع) — العيّنة صغيرة أوي وطلب واحد بيقلب النسبة.`);
  }

  const pacePct = pulse.pacePct;
  /* اللي بنرفعه بقى «الأهداف»: الحملة لو هي شايلة ميزانيتها (CBO)، أو كل
     مجموعة إعلانية شغّالة لو الحملة ABO. قبل كده كان الفلتر
     `dailyBudget != null` وبس، يعني حملتين من أهم اللي عندنا كانوا خارج
     متناول الإيقاع تماماً. واللي بنقيس السقف عليه = مجموع الأهداف كلها. */
  const activeRows0 = paceTargetsOf(rows);
  const budgetNow = activeBudgetOf(rows);

  /* حملة ABO شغّالة ومقدرناش نقرا مجموعاتها = جزء من الصرف الحقيقي **مش
     محسوب** في `budgetNow`. الرفع في الحالة دي بيتبني على مساحة وهمية تحت
     السقف. بنقف عن الرفع ونقول ليه — التراجع والاسترجاع بيفضلوا شغّالين
     لإنهم بيقلّلوا الصرف مش بيزوّدوه. */
  const blindAbo = rows.filter((r) => r.status === "ACTIVE" && r.dailyBudget == null
    && r.adsetsOk === false);
  const totalCap0 = Number(s.maxTotalBudget) || 1000;

  /* ── ٢ب. خرق السقف. السقف الحيّ بينزل لما اليوم يطلع أقل من المتوقّع، وساعتها
     الميزانية اللي رفعناها الصبح ممكن تبقى فوق السقف الجديد. ده مش «إيقاع
     بطيء» — ده قرار قديم بقى غلط، ولازم يترجع حتى لو النبض لسه جوّه المنطقة
     الطبيعية. المالك وصف الجزء اللي بيطلع بس؛ ده الجزء اللي بيحميه.        */
  const breach = budgetNow > totalCap0 + 0.5;
  const up0 = pacePct >= Number(s.paceUpThresholdPct);
  const down0 = pacePct <= Number(s.paceDownThresholdPct);
  if (!up0 && !down0 && !breach) {
    return done(`الإيقاع ${pacePct >= 0 ? "+" : ""}${pacePct}٪ مقابل خط الأساس — جوّه المنطقة الطبيعية (${s.paceDownThresholdPct}٪ إلى ${s.paceUpThresholdPct}٪)، فمفيش داعي نلمس أي ميزانية.`);
  }
  if (up0 && !breach && blindAbo.length) {
    return done(`مقدرناش نقرا المجموعات الإعلانية لـ ${blindAbo.map((r) => `"${r.name}"`).join("، ")} — `
      + `دي حملات ميزانيتها على مستوى المجموعة، فجزء من الصرف الشغّال دلوقتي مش داخل في الحسبة `
      + `(${ar(budgetNow)} ر.س اللي شايفينها ناقصة). مش هنرفع على مساحة مش متأكدين إنها موجودة — `
      + `التراجع والاسترجاع شغّالين عادي. غالباً حد ملط ميتا (User request limit)، والدورة الجاية هتقرا تاني.`);
  }
  const up = up0 && !breach;
  const down = down0 || breach;
  const breachNote = breach
    ? ` السقف الحيّ نزل لـ ${ar(totalCap0)} ر.س/يوم والميزانية الشغالة ${ar(budgetNow)} ر.س — اليوم طلع أقل من التوقّع، فبنسحب الزيادة بدل ما نكمّل صرف على يوم مش مستحمل.`
    : "";

  /* ── ٢ج. حرس آخر الليل. الميزانية اليومية عند المنصات بتتوزّع على يوم
     الحساب الإعلاني (بيلف ١٠ صباحاً بتوقيت جدة)، لكن الإعلانات بتتقفل ٣
     الفجر. يعني كل ما الوقت يتأخر، الجزء اللي ممكن يتصرف والمطعم فاتح
     يقلّ. رفع الساعة ١ بالليل معناه إن ٢٢٪ بس من الزيادة ليها فرصة تشتغل.  */
  const eff = deliveryEfficiency({
    riyadhHour: pulse.riyadhHour, riyadhMinute: pulse.riyadhMinute || 0,
    adsCloseHour: (s.adsLateNightDows || DAYPART_DEFAULTS.adsLateNightDows).map(Number).includes(pulse.dow)
      ? Number(s.adsLateCloseHour ?? DAYPART_DEFAULTS.adsLateCloseHour)
      : Number(s.adsCloseHour ?? DAYPART_DEFAULTS.adsCloseHour),
    accountRollHourRiyadh: Number(s.accountRollHourRiyadh ?? 10),
  });
  const minEff = Number(s.minDeliveryEfficiencyPct ?? INTRADAY_DEFAULTS.minDeliveryEfficiencyPct);
  if (up && eff.pct < minEff) {
    return done(`${eff.reason} أقل من ${minEff}٪ فمابنرفعش — الفلوس اللي بتتصرف بعد ما المطبخ يقفل مش بطيئة، هي ضايعة.`);
  }

  /* ── ٣. الحملات. الأكتر صرفاً الأول: لو السقف الكلي هيخلص، يخلص على
        الحملة اللي الفلوس شغالة فيها فعلاً مش على أول واحدة في اللستة.     */
  const activeRows = activeRows0;
  let totalActive = budgetNow;
  const cooldownMs = Math.max(5, Number(s.paceCooldownMinutes) || 45) * 60_000;
  const perCap = Math.min(Number(s.maxCampaignBudget) || 500, hardCap);
  const totalCap = totalCap0;

  /* اليوم الشغّال. الشرطين لازم يتحققوا مع بعض: نبض عالي + مساحة تحت السقف.
     لو المساحة خلصت، الخطوة الكبيرة معناها إننا هنطلع رفع بيتقصّ على السقف
     في نفس السطر — ضجيج في اللوج من غير أي فلوس زيادة توصل للحملة. */
  const headroomPct = totalCap > 0 ? ((totalCap - totalActive) / totalCap) * 100 : 0;
  const hot = up && pacePct >= Number(s.paceHotThresholdPct ?? 40)
    && headroomPct >= Number(s.paceHotHeadroomPct ?? 20);
  const step = Math.min(
    Number(hot ? (s.paceHotStepPct ?? 25) : (s.paceStepPct ?? 15)) || 15,
    Number(s.maxChangePct) || 30);
  const upliftPct = Number(hot ? (s.paceHotMaxUpliftPct ?? 100) : (s.paceMaxUpliftPct ?? 60)) || 60;

  const ctx = `مبيعات النهارده لحد الساعة ${pulse.riyadhHour}:00: ${ar(pulse.today.orders)} طلب و${ar(pulse.today.revenue)} ر.س، ` +
    `مقابل خط أساس ${ar(pulse.baseline.orders)} طلب و${ar(pulse.baseline.revenue)} ر.س (وسيط ${pulse.baseline.days} أيام من نفس يوم الأسبوع، مقصوصين عند نفس عدد الساعات) — ` +
    `يعني ${pacePct >= 0 ? "أسرع" : "أبطأ"} بـ ${Math.abs(pacePct)}٪.`;
  const evidence = `الدليل اللي بنينا عليه غير المبيعات: ${ar(confirmed.linkedOrders)} طلب اتربط برقم جوال جاي من الإعلان.`;
  const hotNote = hot ? ` اليوم ده شغّال فوق المعتاد بـ ${Math.abs(pacePct)}٪ وفيه مساحة تحت سقف اليوم، فالخطوة اتوسّعت لـ ${step}٪ بدل ${s.paceStepPct}٪ — ده يوم يستاهل نستغله مش نتفرج عليه.` : "";

  /* الترتيب بقى بالاستيعاب الأول وبعدين بالصرف. ليه: الفلوس لازم تروح
     للي **بيصرفها فعلاً**. ليلة ١٢ أغسطس كبّرنا ٣ حملات CBO والصرف الإضافي
     طلع صفر لإن مجموعاتها كلها لسه في التعلّم. الترتيب ده هو اللي بيمنع
     تكرار ده. */
  /* الجزء اللي عدّى من يوم الحساب الإعلاني. `msToRoll` هو الفاضل عليه. */
  const dayFraction = Number.isFinite(msToRoll)
    ? Math.min(1, Math.max(0.05, 1 - (msToRoll / 86_400_000))) : 1;
  /* ── والأرخص قبل الأغلى ────────────────────────────────────────────────
     الترتيب كان: استيعاب، وبعدين **الأكتر صرفاً**. والنتيجة في الدفتر إن
     كل زيادات ١١–١٣ أغسطس راحت لـ fc-prospect-asc و fc-prospect-lal و
     fc-retarget-engagers — تكلفة النتيجة عندهم ١٦٫١٤ و٣٣٫٧٦ و٣٣٫١٢ ر.س.
     وفي نفس الشهر fc-wa-orders كانت بتجيب النتيجة بـ **٢٫٧٥** ر.س
     (٩٩٣ نتيجة من ١٬١٤٠ في الحساب كله على ٤١٪ من الصرف) ومخدتش ولا رفعة.
     «الأكتر صرفاً» بيوصف اللي بيصرف، مش اللي بيكسب — والسقف الكلي لما
     يخلص بيخلص على أول واحد في اللستة. فالترتيب بقى بتكلفة النتيجة
     الأرخص الأول، والصرف بقى فاصل التعادل بس.

     الهدف اللي لسه ملوش نتايج (results null أو صفر) بيتحط بعد اللي ليه
     رقم — مش لإنه وحش، لإننا مش عارفين، ومعرفتش ≠ رخيص.                  */
  const cprOf = (t) => (Number(t.results) > 0 && Number(t.spend) > 0)
    ? Number(t.spend) / Number(t.results) : Infinity;
  const ranked = activeRows.slice().map((t) => ({ t, abs: absorptionOf(t, {
    minFillPct: Number(s.paceMinFillPct ?? 60), dayFraction }) }))
    .sort((a, b) => (b.abs.rank - a.abs.rank)
      || (cprOf(a.t) - cprOf(b.t))
      || ((Number(b.t.spend) || 0) - (Number(a.t.spend) || 0)));

  for (const { t: r, abs } of ranked) {
    const key = targetKeyOf(r);
    /* المفتاح القديم (من غير المستوى) لسه بيتقرا عشان الزيادات المفتوحة
       اللي اتسجّلت قبل التغيير ده ما تضيعش. */
    const legacyKey = keyOf(r.platform, r.id);
    if (touched.has(key) || touched.has(legacyKey)) continue;   // اترجّعت الجولة دي
    const st = state.get(key) || state.get(legacyKey);
    const mine = st && st.accountDay === accountDay;        // زيادة من عندنا على نفس يوم الحساب
    const base = mine ? Number(st.baseBudget) : Number(r.dailyBudget);
    const cur = Number(r.dailyBudget);

    /* قاعدة المنصة. الخطوة العامة (أو خطوة اليوم الشغّال) بتتقص عليها مش
       العكس: يوم شغّال مش سبب نصفّر تعلّم ad set على ميتا.                 */
    const ps = platformScaling(r.platform, { s, proven: r.proven ?? null });
    const pCooldownMs = Math.max(cooldownMs, Number(ps.cooldownMinutes) * 60_000);

    /* الهدف اللي مش هيبلع الزيادة بنسيبه ونقول ليه بالعربي. ده بيتقال في
       الرفع بس — التراجع بيلمس اللي رفعناه إحنا مهما كانت مرحلة تعلّمه. */
    if (up && !abs.absorbs) {
      notes.push({ key, op: "cant-absorb", text: abs.why });
      continue;
    }

    /* سقف اللمسات اليومي. تسعة رفعات ١٥٪ يوم ١٢ أغسطس طلّعت صفر صرف
       إضافي؛ كل لمسة زيادة على ميتا خطر تصفير تعلّم من غير مقابل. تلات
       رفعات بـ ١٩٪ بتوصل لنفس السقف التراكمي (١٫١٩³ = +٦٨٪) بتلت اللمس. */
    const maxSteps = Math.max(1, Number(s.paceMaxStepsPerDay) || 3);
    if (up && mine && Number(st.steps) >= maxSteps) {
      notes.push({ key, op: "step-budget", text: `"${r.name}" خدت ${ar(st.steps)} رفعات النهارده وده سقف اليوم (${ar(maxSteps)}). الرفعات الصغيرة المتكرّرة مابتحرّكش صرف — يوم ١٢ أغسطس ٨ رفعات طلّعوا صفر ريال زيادة. لو الحملة مستحقة أكتر من كده، ده قرار ميزانية أساسية مش تسريع.` });
      continue;
    }

    if (mine && nowMs - st.lastActionAt < pCooldownMs) {
      notes.push({ key, op: "cooldown", text: `"${r.name}" اتغيّرت من ${Math.round((nowMs - st.lastActionAt) / 60000)} دقيقة — فترة تبريد ${Math.round(pCooldownMs / 60000)} دقيقة على ${r.platform} عشان المنصة تاخد وقتها تصرف الزيادة قبل ما نحكم عليها تاني.` });
      continue;
    }
    if (up && !ps.allowed) {
      notes.push({ key, op: "platform-blocked", text: `"${r.name}" على ${r.platform} — مقفولة للتوسّع. ${ps.why}` });
      continue;
    }

    /* «نتيجة» = نية طلب (دوسة «اطلب على واتساب» أو محادثة واتساب من
       الإعلان)، مش شرا — الشرا بيتبعت physical_store والمنصة مبتنسبهوش
       لحملة. شوف ads.js/META_RESULT_MODEL. */
    const zero = r.results == null
      ? ` المنصة مرجّعتش نوع نتيجة نعرف نقراه للحملة دي النهارده — عمى قياس، فمابنحكمش بيه لا بالسلب ولا بالإيجاب.`
      : !Number(r.results)
        ? ` المنصة مسجّلة صفر نية طلب للحملة دي النهارده. الرقم ده حقيقي دلوقتي (بنعدّ دوسات واتساب والمحادثات، مش الشرا) بس اليوم لسه بيمشي — فسياق، مش حكم. القرار مبني على مبيعات الكاشير.`
        : ` المنصة مسجّلة ${ar(r.results)} نية طلب النهارده — رقم مساعد، بس القرار مبني على مبيعات الكاشير.`;

    if (up) {
      /* الخطوة على المجموعة الإعلانية مسقوفة عند ١٩٪ مهما قالت الإعدادات:
         ميتا بتصفّر التعلّم لو الميزانية نطّت، والمجموعتين اللي بنفتح عليهم
         دول هما الوحيدين اللي **خلصوا** تعلّم في الحساب كله — فتصفير
         تعلّمهم معناه إننا كسّرنا الحاجة الوحيدة الشغّالة عندنا. */
      const levelStepCap = r.level === "adset" ? ADSET_MAX_STEP_PCT : Infinity;
      const pStep = Math.min(step, Number(ps.stepPct) || step, levelStepCap);
      const upliftCap = Math.floor(base * (1 + upliftPct / 100));
      /* التقريب لتحت مش لأقرب رقم. الفرق ده كان تفصيلة وهي الخطوة ١٥٪،
         وبقى فرق حقيقي وهي ١٩٪: ٣٥ × ١٫١٩ = ٤١٫٦٥، والتقريب لأقرب رقم
         بيطلّعها ٤٢ — يعني **٢٠٪** بالظبط، وهي العتبة اللي ميتا بتصفّر
         عندها التعلّم. يعني كنا هنكسر السور بالتقريب. floor بيضمن إن
         الخطوة المتنفّذة عمرها ما تعدّي الخطوة المسموحة. */
      let next = Math.floor(cur * (1 + pStep / 100));
      let capped = null;
      if (next > upliftCap) { next = upliftCap; capped = `سقف الزيادة اليومية ${upliftPct}٪ فوق أساس ${ar(base)}`; }
      if (ps.cap != null && next > ps.cap) { next = ps.cap; capped = `سقف المنصة غير المثبتة ${ar(ps.cap)} ر.س`; }
      /* سقف الحملة الواحدة على مستوى المجموعة معناه **مجموع** مجموعات
         الحملة — نفس معناه بالظبط لما كان على CBO. */
      if (r.level === "adset") {
        const sibs = activeRows.filter((x) => x.level === "adset" && x.campaignId === r.campaignId);
        const others = sibs.reduce((a, x) => a + (x.id === r.id ? 0 : Number(x.dailyBudget)), 0);
        if (others + next > perCap) {
          next = Math.floor(perCap - others);
          capped = `سقف الحملة الواحدة ${ar(perCap)} ر.س على مجموع مجموعات "${r.campaignName}"`;
        }
      } else if (next > perCap) { next = perCap; capped = `سقف الحملة الواحدة ${ar(perCap)} ر.س`; }
      const headroom = totalCap - totalActive;
      if (next - cur > headroom) { next = cur + Math.max(0, Math.floor(headroom)); capped = `السقف الكلي ${ar(totalCap)} ر.س/يوم`; }
      if (next <= cur) {
        notes.push({ key, op: "capped", text: `"${r.name}" تستاهل تسريع بس وصلت ${capped || "السقف"} — الميزانية واقفة عند ${ar(cur)} ر.س. لو عايز توسّع أكتر، ارفع السقف من الإعدادات بإيدك.` });
        continue;
      }
      /* التكرار بدل التكبير: لما الميزانية توصل ضعف رقم المالك، الضغط الزيادة
         على نفس الجمهور بيرفع الـ CPM من غير ناس جداد. بنقول الاقتراح في
         اللوج ومابنعملهوش لوحدنا — إنشاء ad set جديد قرار المالك.          */
      if (ps.duplicateAtUpliftPct && cur >= base * (1 + Number(ps.duplicateAtUpliftPct) / 100) - 0.5) {
        notes.push({ key, op: "duplicate-hint", text: `"${r.name}" وصلت ${ar(cur)} ر.س — ضعف رقم المالك (${ar(base)}). ${ps.duplicateWhy} الخطوة الجاية المفروض تبقى نسخة جديدة بجمهور تاني، مش رفع تاني على نفس الـ ad set.` });
      }
      totalActive += next - cur;
      actions.push({
        op: "up", platform: r.platform, campaignId: r.id, campaignName: r.name,
        level: r.level, parentId: r.level === "adset" ? r.campaignId : null,
        parentName: r.level === "adset" ? r.campaignName : null,
        from: r2(cur), to: r2(next), base: r2(base), accountDay, stepPct: pStep,
        reason: `${ctx} رفعنا ${r.level === "adset" ? `المجموعة الإعلانية "${r.name}" (جوّه حملة "${r.campaignName}")` : `"${r.name}"`} من ${ar(cur)} لـ ${ar(next)} ر.س/يوم (خطوة ${pStep}٪ على ${r.platform}${capped ? `، متقصوصة على ${capped}` : ""}). ${abs.why} ${ps.why}${hotNote}${zero} ${evidence} ${eff.reason} الزيادة دي هترجع لـ ${ar(base)} ر.س قبل ما يوم الحساب الإعلاني ${accountDay} (${ADS_ACCOUNT_TZ}) يقفل — يعني حوالي ١٠ صباحاً بتوقيت جدة.`,
      });
    } else {
      /* التراجع بيلمس زيادتنا إحنا بس. الخفض تحت ميزانية المالك شغلانة
         الجولة البطيئة بتبريدها ٢٤ ساعة — لو الاتنين خفّضوا هنكون قصّينا
         الحملة مرتين على نفس السبب. */
      if (!mine || cur <= base + 0.5) continue;
      /* خرق السقف بينزل خطوة أكبر عن قصد: السقف نزل خلاص، والزحف بـ ١٥٪ كل
         ٤٥ دقيقة معناه إننا هنفضل فوق السقف ساعتين. */
      const downStep = breach ? Math.max(step, 25) : step;
      let next = Math.round(cur * (1 - downStep / 100));
      next = Math.max(next, base);
      if (next >= cur) continue;
      totalActive += next - cur;
      actions.push({
        op: "down", platform: r.platform, campaignId: r.id, campaignName: r.name,
        level: r.level, parentId: r.level === "adset" ? r.campaignId : null,
        parentName: r.level === "adset" ? r.campaignName : null,
        from: r2(cur), to: r2(next), base: r2(base), accountDay, stepPct: downStep, breach,
        reason: `${ctx}${breachNote} فسحبنا التسريع على ${r.level === "adset" ? `المجموعة الإعلانية "${r.name}"` : `"${r.name}"`} من ${ar(cur)} لـ ${ar(next)} ر.س/يوم (خطوة ${downStep}٪، ومش بننزل تحت ميزانية المالك ${ar(base)} ر.س — الخفض تحتها شغل الجولة اليومية مش الإيقاع).${zero}`,
      });
    }
  }

  /* ── خرق سقف مش قادرين نصلّحه بنفسنا ────────────────────────────────────
     التراجع فوق بيلمس **زيادتنا إحنا** بس (شرط `mine`). النزول تحت ميزانية
     المالك مش شغل الإيقاع عن قصد: ده قرار الجولة اليومية بتبريدها ٢٤ ساعة،
     ولو الاتنين نزّلوا كنا هنقصّ نفس الحملة مرتين على نفس السبب.

     بس ده بيسيب حالة كانت بتعدّي في صمت تام: الشغّال فوق السقف، ومفيش ولا
     زيادة من عندنا نسحبها — يعني الفرق كله ميزانيات أساسية. قبل كده كانت
     decidePace بترجع صفر أكشن وصفر ملاحظة، فالمالك ميعرفش إن سقف يومه
     مخروق أصلاً. والحالة دي بقت أظهر بعد ما بقينا نعدّ الميزانيات اللي على
     مستوى المجموعة الإعلانية (١٨٠ من ٢٩٠ ر.س عندنا كانت خفيّة تماماً عن
     الحسبة).

     ملاحظة للعرض وبس — مفيش أي كتابة على المنصة، والصلاحيات زي ما هي.     */
  if (breach && !actions.some((a) => a.op === "down")) {
    const hidden = rows
      .filter((r) => r.status === "ACTIVE" && r.dailyBudget == null)
      .reduce((a, r) => a + (Number(r.adsetBudget) || 0), 0);
    notes.push({
      key: "ceiling", op: "breach-needs-owner",
      text: `الميزانية الشغالة ${ar(budgetNow)} ر.س/يوم وسقف النهارده ${ar(totalCap0)} ر.س — `
        + `يعني فوق السقف بـ ${ar(r2(budgetNow - totalCap0))} ر.س، ومفيش أي تسريع من الإيقاع نقدر نسحبه: `
        + `الفرق كله ميزانيات أساسية${hidden > 0 ? ` (منها ${ar(hidden)} ر.س على مستوى المجموعات الإعلانية، مش على الحملة)` : ""}. `
        + `تخفيض الميزانية الأساسية قرار المالك مش قرار الإيقاع — محتاج تدخّل بإيدك.`,
    });
  }

  return { phase: up ? "up" : "down", accountDay, msToRoll, pacePct, hot, step,
           breach, delivery: eff, actions, notes, gate: null };
}

/* ═══════════════════════════════════════════════════════════════════════════
   نافذة الإعلانات (DAYPARTING) — مانصرفش والمطبخ قافل

   كلام المالك: «المطعم بيكون قافل من ٢ الفجر لحد ١٢ الظهر… نوقف الإعلانات
   بعد ما المطعم يقفل بساعة ونفتح الإعلانات قبل ما يفتح بساعة.»
   يعني نافذة الإعلانات ١١ صباحاً → ٣ الفجر. والخميس والجمعة المطبخ بيقفل
   ٣ الفجر مش ٢، فالنافذة بتمتد لـ ٤ الفجر في الليلتين دول.

   ── ليلة مين؟ ──────────────────────────────────────────────────────────
   الساعة ٣:٣٠ فجر الجمعة هي آخر «ليلة الخميس»، مش أول يوم الجمعة. عشان كده
   يوم الأسبوع اللي بنقرر بيه هو يوم المطعم (اللي بيلف ٤ فجراً) مش يوم
   التقويم. لو اتحسب بيوم التقويم كنا هنقفل ليلة الخميس بدري ساعة ونفتح ليلة
   الجمعة ساعة زيادة — الغلطتين على طرفين مختلفين ومحدش هيلاحظهم بسهولة.

   ── ليه في قاعدة بيانات مش في الذاكرة ─────────────────────────────────
   الحملات اللي بنوقفها بتتسجّل في ap_daypart. لو الخدمة وقعت الساعة ٥ الفجر
   ورجعت ١ الضهر، أول تشغيلة بتلاقي في الدفتر حملات موقوفة والنافذة مفتوحة
   → بتشغّلها فوراً. من غير الدفتر ده الحملات كانت هتفضل موقوفة لحد ما حد
   يلاحظ — يعني يوم مبيعات كامل من غير إعلانات.

   كله دوال نقية هنا: مفيش I/O، فبتتجرّب من غير سيرفر ولا قاعدة بيانات.
═══════════════════════════════════════════════════════════════════════════ */

export const DAYPART_DEFAULTS = {
  daypart: true,              // شغّال؟
  adsOpenHour: 11,            // نفتح الإعلانات (المطبخ بيفتح ١٢)
  adsCloseHour: 3,            // نقفلها (المطبخ بيقفل ٢)
  adsLateCloseHour: 4,        // ليالي الخميس والجمعة (المطبخ بيقفل ٣)
  adsLateNightDows: [4, 5],   // يوم المطعم: ٤ = الخميس، ٥ = الجمعة
};

const DOW_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const shiftIso = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* يوم المطعم بتوقيت الرياض — نفس قاعدة analytics.js: بيلف ٤ فجراً، فطلب
   ١:٣٠ بليل بيتحسب على اليوم اللي فات. */
export function bizDayOf(at = new Date()) {
  const c = tzClock(at, RIYADH_TZ);
  return c.hour >= BIZ_DAY_START_HOUR ? c.day : shiftIso(c.day, -1);
}

/* هل الإعلانات المفروض تكون شغالة دلوقتي؟ بترجّع كل اللي محتاجينه للسبب
   المكتوب كمان — عشان السطر اللي بيتسجّل في اللوج يقول الساعة كام والنافذة
   إيه، مش «برّه النافذة» وخلاص. */
export function adsWindow(at = new Date(), s = {}) {
  const cfg = { ...DAYPART_DEFAULTS, ...s };
  const c = tzClock(at, RIYADH_TZ);
  const bizDay = bizDayOf(at);
  const dow = new Date(bizDay + "T00:00:00Z").getUTCDay();
  const late = (cfg.adsLateNightDows || []).map(Number).includes(dow);
  const openHour = Math.max(0, Math.min(23, Number(cfg.adsOpenHour)));
  const closeHour = Math.max(0, Math.min(23, Number(late ? cfg.adsLateCloseHour : cfg.adsCloseHour)));

  // النافذة الطبيعية بتعدّي نص الليل (١١ص → ٣ف). لو حد ظبط إعدادات نافذة
  // مابتعديش نص الليل، الشرط بيتقلب — من غير الفرع ده النافذة القصيرة
  // هتتقري كإنها مفتوحة ٢٤ ساعة.
  const wraps = closeHour <= openHour;
  const open = wraps ? (c.hour >= openHour || c.hour < closeHour)
                     : (c.hour >= openHour && c.hour < closeHour);

  const nowMin = c.hour * 60 + c.minute;
  const untilHour = (h) => { const d = h * 60 - nowMin; return d > 0 ? d : d + 1440; };

  return {
    open, bizDay, dow, dowLabel: DOW_AR[dow], late,
    openHour, closeHour,
    riyadhHour: c.hour, riyadhMinute: c.minute,
    clock: `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`,
    minutesToChange: open ? untilHour(closeHour) : untilHour(openHour),
    label: `${openHour}:00 → ${closeHour}:00 بتوقيت جدة`,
    why: open
      ? `الساعة ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} بتوقيت جدة — جوّه نافذة الإعلانات (${openHour}:00 → ${closeHour}:00${late ? "، ليلة " + DOW_AR[dow] + " المطبخ بيقفل متأخر ساعة" : ""}).`
      : `الساعة ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} بتوقيت جدة — المطعم قافل. الإعلانات بتشتغل من ${openHour}:00 لحد ${closeHour}:00${late ? " (ليلة " + DOW_AR[dow] + " بتمتد ساعة زيادة)" : ""}.`,
  };
}

/* ── القرار ──────────────────────────────────────────────────────────────
   input:
     rows    لقطة الحملات: { platform, id, name, status, dailyBudget }
     book    Map "platform:id" → { platform, campaignId, campaignName,
                                   baseBudget, bizDay } — اللي إحنا وقفناه ولسه
                                   ما شغّلناهوش
     pacing  Map زي بتاعة decidePace — عشان نعرف ميزانية المالك الحقيقية لو
             كان في تسريع مفتوح وقت الإيقاف
     w       ناتج adsWindow
   output: { phase, actions[], notes[], gate }                              */
export function decideDaypart({ rows = [], book = new Map(), pacing = new Map(), window: w, s = {} }) {
  const cfg = { ...DAYPART_DEFAULTS, ...s };
  const actions = [], notes = [];
  const keyOf = (p, id) => `${p}:${id}`;
  if (cfg.daypart === false) {
    return { phase: "off", window: w, actions, notes, gate: "نافذة الإعلانات مقفولة من الإعدادات — الحملات بتفضل شغالة ٢٤ ساعة." };
  }

  /* ── مقفول: نوقف كل حملة شغالة مش مسجّلة عندنا خلاص ─────────────────── */
  if (!w.open) {
    for (const r of rows) {
      if (r.status !== "ACTIVE") continue;
      const key = keyOf(r.platform, r.id);
      if (book.has(key)) continue;                       // موقوفة من عندنا أصلاً
      /* ميزانية المالك مش بالضرورة اللي على الشاشة دلوقتي: لو التسريع
         اليومي رافعها والاسترجاع لسه ما جاش (بيحصل ١٠ صباحاً بتوقيت جدة،
         يعني جوّه ساعات القفل)، الرقم اللي قدامنا مؤقت. بنسجّل الأساس
         الحقيقي عشان التشغيل ١١ يرجّعها لرقم المالك مش لرقم التسريع. */
      const up = pacing.get(key);
      const base = up && Number.isFinite(Number(up.baseBudget)) ? Number(up.baseBudget)
        : (r.dailyBudget == null ? null : Number(r.dailyBudget));
      actions.push({
        op: "pause", platform: r.platform, campaignId: r.id, campaignName: r.name,
        base, bizDay: w.bizDay, window: w.label,
        reason: `${w.why} وقّفنا "${r.name}" عشان مانصرفش على ساعات المطبخ فيها قافل — الإعلان اللي بيشتغل الساعة ٦ الصبح بيدفع فيه فلوس ومحدش يقدر يطلب.` +
          (base != null ? ` هترجع تشتغل الساعة ${w.openHour}:00 على ميزانية ${ar(base)} ر.س/يوم.` : ` هترجع تشتغل الساعة ${w.openHour}:00.`),
      });
    }
    return { phase: "closed", window: w, actions, notes, gate: null };
  }

  /* ── مفتوح: نرجّع كل اللي وقفناه ────────────────────────────────────── */
  for (const [key, e] of book) {
    const row = rows.find((r) => keyOf(r.platform, r.id) === key);
    if (!row) {
      actions.push({
        op: "forget", platform: e.platform, campaignId: e.campaignId, campaignName: e.campaignName,
        bizDay: e.bizDay,
        reason: `"${e.campaignName || key}" مابقتش موجودة على المنصة — شيلناها من دفتر الإيقاف اليومي من غير ما نبعت أي أمر.`,
      });
      notes.push({ key, op: "gone", text: `حملة موقوفة في الدفتر مش موجودة في لقطة المنصة.` });
      continue;
    }
    const base = Number.isFinite(Number(e.baseBudget)) ? Number(e.baseBudget) : null;
    const cur = row.dailyBudget == null ? null : Number(row.dailyBudget);
    const needsBudget = base != null && cur != null && Math.abs(cur - base) > 0.5 ? base : null;

    if (row.status === "ACTIVE") {
      // المالك (أو حد تاني) شغّلها بإيده قبلنا — نقفل القيد ونصلّح الميزانية بس.
      actions.push({
        op: "forget", platform: row.platform, campaignId: row.id, campaignName: row.name,
        bizDay: e.bizDay, restoreTo: needsBudget,
        reason: `"${row.name}" لقيناها شغالة خلاص قبل ما نشغّلها — قفلنا قيد الإيقاف اليومي من غير أمر تشغيل.` +
          (needsBudget != null ? ` بس رجّعنا ميزانيتها لـ ${ar(base)} ر.س/يوم زي ما كانت قبل القفل.` : ""),
      });
      continue;
    }
    actions.push({
      op: "resume", platform: row.platform, campaignId: row.id, campaignName: row.name,
      bizDay: e.bizDay, restoreTo: needsBudget, base,
      reason: `${w.why} شغّلنا "${row.name}" تاني قبل ما المطبخ يفتح بساعة عشان الإعلان يكون واخد وقته يوزّع لما أول طلب ييجي.` +
        (needsBudget != null ? ` والميزانية رجعت لـ ${ar(base)} ر.س/يوم — ده رقم المالك، مش رقم التسريع بتاع امبارح.` : base != null ? ` الميزانية زي ما هي ${ar(base)} ر.س/يوم.` : ""),
    });
  }
  return { phase: "open", window: w, actions, notes, gate: null };
}

/* ═══════════════════════════════════════════════════════════════════════════
   قاعدة الـ ٢٠٪ كسقف حيّ — السقف بيتحرك مع المبيعات

   كلام المالك: «انا مستعد لدفع اعلانات ممولة على كل المنصات بنسبة ٢٠٪ من
   المبيعات… ٢٠٠٠ ريال إعلانات مقابل ١٠ آلاف مبيعات.»

   يعني السقف مش رقم ثابت (١٠٠٠) بيتكتب في الإعدادات ويتنسي. هو نسبة من
   المبيعات الفعلية: كل ما المبيعات تكبر، مسموح نصرف أكتر — وده بالظبط اللي
   بيخلي التوسّع ممكن من غير ما المالك يقعد يعدّل رقم بإيده كل أسبوع.

   ── تلات نسخ للقاعدة دي، والتالتة هي الصح ─────────────────────────────
   (١) متوسط آخر ٧ أيام: رقم بيتحسب أول اليوم ويقعد ثابت. في يوم بيجري ضعف
       المعتاد الوكيل مقدرش يصرف فيه. ده اللي المالك اشتكى منه.
   (٢) توقّع مبيعات النهارده: بنى سقف على تخمين. الفكرة كانت شكلها أذكى، بس
       التخمين ده الساعة ٥ العصر بيغلط ٥١٪ — يعني سقف مربوط بفلوس متخيّلة.
   (٣) *الدخل اللي دخل فعلاً* — وده اللي المالك كان قاصده من الأول:
       «مش قصدي إن الصرف بيزوّد النتايج. قصدي إنه بيدّينا فرصة نصرف أكتر في
       نفس اليوم اللي فيه دخل كبير.» هو مش بيتكلم عن تنبّؤ، هو بيتكلم عن
       *قدرة على الدفع*: الفلوس دي في الدرج خلاص، وحقّه يصرف نسبتها النهارده
       مش الأسبوع الجاي. وطول ما مفيش دفع أونلاين ولا توصيل، مفيش ROAS لكل
       طلب نحسّن عليه أصلاً — فالقاعدة دي هي كل القاعدة.

   السقف دلوقتي = أعلى من (الأرضية، ٢٠٪ × دخل النهارده لحد دلوقتي).
   شوف earnedCeiling تحت — ومعاه الخاصية اللي بتخليه آمن رياضياً.

   منحنى اليوم (buildDayShape) والتوقّع (projectDayRevenue) لسه موجودين،
   بس بقوا للعرض بس: بيقولوا للمالك «اليوم رايح على كام» وعمرهم ما بيحرّكوا
   ريال. سيبناهم لإن السياق ده مفيد وهو بيقرا، وقفلنا عليهم باب الفلوس لإن
   خطأ ٥١٪ مالوش مكان في سقف المالك فاكره مربوط بدخل حقيقي.

   وفوق كل ده سقف مطلق بيحطه المالك (٢٠٠٠ افتراضياً) مفيش أي حساب بيعدّيه،
   وأرضية مطلقة (١٥٠) عشان يوم واطي مايطفّيش الإعلانات خالص.
═══════════════════════════════════════════════════════════════════════════ */

export const ECON_DEFAULTS = {
  adsShareOfSalesPct: 20,       // قاعدة المالك
  adsShareStretchPct: 25,       // لما اليوم شغّال فوق خط الأساس
  absoluteMaxTotalBudget: 2000, // السقف المطلق — رقم المالك، مفيش حساب بيعدّيه
  minTotalBudget: 150,          // أرضية: يوم مبيعات واطي مايطفّيش الإعلانات خالص
  grossMarginPct: 65,           // هامش المطعم التقديري — بيحدد أقصى CAC نظري
  ltvHorizonDays: 90,           // شباك القيمة العمرية اللي بنقيس عنده
};

/* ═══════════════════════════════════════════════════════════════════════════
   منحنى اليوم — شكل مبيعات فريش كاتس ساعة بساعة

   ده أهم رقم في الملف كله، ومن غيره جملة «الساعة ٥ العصر عندنا ١٠٠٠ ريال»
   مالهاش معنى. اتحسب من ts_orders على ٥٩ يوم شغل (يونيو → ١٠ أغسطس ٢٠٢٦):

     الساعة ١٥:٠٠ → عدّى ٤٫٥٪ بس من مبيعات اليوم (وسيط)
     الساعة ١٧:٠٠ → ١٥٫٨٪
     الساعة ١٩:٠٠ → ٤٢٫٣٪
     الساعة ٢٠:٠٠ → ٥١٫٠٪
     الساعة ٢٢:٠٠ → ٦٧٫٢٪
     الساعة ٠٠:٠٠ → ٨٦٫٢٪

   يعني فريش كاتس مطعم ليلي: نص اليوم بيحصل بعد الساعة ٨ بالليل. والنتيجة
   المباشرة إن التوقّع بدري بيتضرب في رقم كبير — الساعة ٥ العصر بنقسم على
   ٠٫١٥٨، يعني بنضرب في ٦٫٣. طلب واحد بـ ٢٠٠ ر.س الساعة ٤ بيزوّد التوقّع
   ١٬٢٦٠ ر.س. عشان كده التوقّع بدري مش «متفائل»، هو مضخّم.

   ── الشكل بيتبني ليه من أيام سابقة بس ─────────────────────────────────
   لو حسبنا الحصة من نفس اليوم اللي بنتوقّعه كنا هنقرا المستقبل. الدالة
   بتاخد أيام كاملة انتهت خلاص، وبتاخد نفس يوم الأسبوع لو فيه ٣ أيام على
   الأقل (الخميس شكله مختلف عن الأحد)، وإلا بترجع للمنحنى المجمّع.
═══════════════════════════════════════════════════════════════════════════ */

export const INTRADAY_DEFAULTS = {
  earnedCeiling: true,          // السقف = ٢٠٪ من دخل النهارده الفعلي (قاعدة المالك)
  earnedFloorPct: 100,          // الأرضية = كام ٪ من سقف المتوسط (١٠٠ = زي ما كان)
  showOutlook: true,            // نحسب التوقّع للعرض؟ (مبيحركش فلوس أبداً)
  shapeLookbackDays: 56,        // كام يوم بنبني منهم منحنى اليوم
  shapeMinDowDays: 3,           // أقل عدد أيام من نفس يوم الأسبوع نصدّق منحناه
  projMinSharePct: 25,          // ما نعرضش توقّع قبل ما ٢٥٪ من اليوم يعدّي
  projMinOrders: 6,             // ولا قبل ٦ طلبات النهارده
  minDeliveryEfficiencyPct: 35, // أقل نسبة من الزيادة ممكن تتصرف في ساعات بيع
};

/* منحنى اليوم من صفوف تاريخية. كل صف: { day, dow, total, orders, cum[24] } —
   cum[i] = الإيراد المتراكم لحد آخر الساعة رقم i من يوم المطعم (٠ = ٤ صباحاً). */
export function buildDayShape(rows = [], { lookbackDays = 56, minDowDays = 3 } = {}) {
  const usable = (rows || [])
    .filter((d) => Number(d.total) > 0 && Number(d.orders || 0) >= 5 && Array.isArray(d.cum))
    .slice(-Math.max(7, Number(lookbackDays) || 56));
  const shareRow = (ds, i) => medianOf(ds.map((d) => Number(d.cum[i]) / Number(d.total)));

  const pooled = usable.length >= 5 ? Array.from({ length: 24 }, (_, i) => shareRow(usable, i)) : null;
  const dow = {};
  for (let w = 0; w < 7; w++) {
    const ds = usable.filter((d) => Number(d.dow) === w);
    dow[w] = ds.length >= Math.max(2, Number(minDowDays) || 3)
      ? { curve: Array.from({ length: 24 }, (_, i) => shareRow(ds, i)), days: ds.length }
      : null;
  }
  return { pooled, dow, days: usable.length, lookbackDays, minDowDays };
}

/* الحصة المتوقّعة من اليوم عند عدد ساعات كسري. بنملّس بين ساعتين عشان الساعة
   ١٩:٤٠ ما تتقريش زي ١٩:٠٠ — الفرق بينهم في ساعة الذروة يوصل ١٠٪ من اليوم. */
export function shareAt(shape, dow, elapsedH) {
  if (!shape) return null;
  const c = (shape.dow && shape.dow[dow] && shape.dow[dow].curve) || shape.pooled;
  if (!c) return null;
  const e = Math.max(0, Math.min(24, Number(elapsedH) || 0));
  const i = Math.floor(e) - 1;                       // الحصة اللي خلصت آخر الساعة i
  const lo = i < 0 ? 0 : (Number(c[i]) || 0);
  const hi = i + 1 < 24 ? (c[i + 1] == null ? lo : Number(c[i + 1])) : 1;
  const v = lo + (hi - lo) * (e - Math.floor(e));
  return Math.max(0, Math.min(1, v));
}

/* ── التوقّع ────────────────────────────────────────────────────────────
   projected = w × (المبيعات لحد دلوقتي ÷ حصة اليوم اللي عدّت) + (1−w) × متوسط ٧ أيام

   و w = نفس الحصة. يعني: نصدّق النهارده بالظبط بقد ما النهارده حصل فعلاً.
   الساعة ٦ المسا عدّى ٢٨٪ من اليوم → بناخد ٢٨٪ من التوقّع و٧٢٪ من المتوسط.
   الساعة ١١ بالليل عدّى ٧٧٪ → بناخد ٧٧٪ من التوقّع. الرقم ده مش مخترع:
   جرّبناه على ٥٨ يوم بأوزان من ٠ لـ ١، والوزن = الحصة طلع الأقرب في كل ساعة
   (خطأ الوسيط ١٢٪ الساعة ٧ مقابل ٢٤٪ للمتوسط لوحده).

   وقبل ما ٢٥٪ من اليوم يعدّي التوقّع بيتقفل تماماً ونرجع للمتوسط: قبل كده
   الارتباط بين اللي حصل واللي هيحصل ٠٫٤٤ بس، والخطأ أسوأ من مجرد استعمال
   المتوسط. ده الرد الأمين على «الساعة ٥ العصر» — مش رفض للفكرة، رفض للساعة.
   ═══════════════════════════════════════════════════════════════════════ */
export function projectDayRevenue({
  shape = null, dow = null, elapsedH = 0, revSoFar = 0, ordersSoFar = 0,
  trailingAvg = null, minSharePct = 25, minOrders = 6,
} = {}) {
  const baseline = Number(trailingAvg);
  const hasBaseline = Number.isFinite(baseline) && baseline > 0;
  const share = shareAt(shape, dow, elapsedH);
  const rev = Math.max(0, Number(revSoFar) || 0);
  const orders = Math.max(0, Number(ordersSoFar) || 0);
  const minShare = Math.max(0, Math.min(1, (Number(minSharePct) || 25) / 100));
  const raw = share > 0.005 ? rev / share : null;

  const shell = (source, reason) => ({
    usable: false, projected: hasBaseline ? r2(baseline) : null,
    share: share == null ? null : Math.round(share * 1000) / 10,
    weight: 0, raw: raw == null ? null : Math.round(raw),
    revSoFar: r2(rev), ordersSoFar: orders, trailingAvg: hasBaseline ? r2(baseline) : null,
    source, reason,
  });

  if (!hasBaseline) {
    return shell("no-baseline",
      "مفيش متوسط مبيعات لآخر ٧ أيام نخلط بيه، فمينفعش نتوقّع اليوم — التوقّع من غير خط أساس بيبقى رقم واحد شايل كل الخطأ.");
  }
  if (share == null) {
    return shell("no-shape",
      "مفيش منحنى ساعات كفاية في التاريخ عشان نعرف اليوم عدّى منه قد إيه — رجعنا لمتوسط آخر ٧ أيام.");
  }
  if (share < minShare) {
    return shell("too-early",
      `الساعة دي عدّى ${Math.round(share * 100)}٪ بس من مبيعات اليوم المعتاد (المطلوب ${Math.round(minShare * 100)}٪ قبل ما نصدّق التوقّع). ` +
      `فريش كاتس مطعم ليلي: نص المبيعات بتحصل بعد ٨ بالليل، فالقسمة دلوقتي بتضرب أي رقم في ${(1 / Math.max(share, 0.01)).toFixed(1)} — طلب واحد كبير كان هيقلب التوقّع. ` +
      `السقف فاضل على متوسط آخر ٧ أيام (${ar(baseline)} ر.س/يوم) لحد ما اليوم يثبت نفسه.`);
  }
  if (orders < Number(minOrders)) {
    return shell("too-few-orders",
      `${ar(orders)} طلب بس النهارده لحد دلوقتي (المطلوب ${ar(minOrders)}) — العيّنة صغيرة أوي والتوقّع عليها هيبقى رأي مش قياس.`);
  }

  const w = share;                                    // نصدّق اليوم بقد ما حصل
  const projected = w * raw + (1 - w) * baseline;
  return {
    usable: true, projected: r2(projected),
    share: Math.round(share * 1000) / 10, weight: Math.round(w * 1000) / 10,
    raw: Math.round(raw), revSoFar: r2(rev), ordersSoFar: orders, trailingAvg: r2(baseline),
    source: "live",
    reason: `عدّى ${Math.round(share * 100)}٪ من اليوم و${ar(rev)} ر.س دخلوا فعلاً من ${ar(orders)} طلب. ` +
      `القسمة على الحصة بتدّي ${ar(raw)} ر.س لليوم كله، والمتوسط بيقول ${ar(baseline)} ر.س. ` +
      `بنصدّق النهارده بقد ما حصل (${Math.round(w * 100)}٪) فالتوقّع ${ar(projected)} ر.س.`,
  };
}

/* ── كفاءة التوصيل: الزيادة دي هتلحق تتصرف في ساعات بيع ولا لأ؟ ─────────
   الميزانية اليومية عند ميتا بتتوزّع على *يوم الحساب الإعلاني* اللي بيلف
   ١٠ صباحاً بتوقيت جدة. لكن الإعلانات بتتقفل ٣ الفجر لما المطبخ يقفل. يعني
   لو رفعنا الساعة ١١ بالليل، المنصة قدامها ١١ ساعة توزّع فيهم، إحنا هنستفيد
   بـ ٤ منهم بس — والباقي يا بيتصرف والمطعم قافل يا مبيتصرفش أصلاً.

   الرقم ده اتشاف في الداتا: يوم ٩ أغسطس رفعنا الميزانية ٦٠٪ الساعة ٨ المسا
   والصرف الفعلي زاد ١٨٪ بس (٤٦١ بدل ٣٩١ ر.س). ويوم ١٠ أغسطس ضاعفناها ١٠٠٪
   والصرف طلع ٣٦٤ — أقل من يوم عادي. الرافعة موجودة بس ضعيفة، وبتضعف كل ما
   الوقت يتأخر.                                                             */
export function deliveryEfficiency({
  riyadhHour = 0, riyadhMinute = 0, adsCloseHour = 3, accountRollHourRiyadh = 10,
} = {}) {
  const now = Number(riyadhHour) * 60 + Number(riyadhMinute);
  const ahead = (h) => { const d = Number(h) * 60 - now; return d > 0 ? d : d + 1440; };
  const sellingMin = ahead(adsCloseHour);
  const accountMin = ahead(accountRollHourRiyadh);
  const pct = accountMin > 0 ? Math.round((Math.min(sellingMin, accountMin) / accountMin) * 100) : 0;
  return {
    pct, sellingMinutes: sellingMin, accountMinutes: accountMin,
    reason: `فاضل ${Math.round(sellingMin / 60)} ساعة بيع قبل ما الإعلانات تقفل ${adsCloseHour}:00، و${Math.round(accountMin / 60)} ساعة قبل ما يوم الحساب الإعلاني يلف (${accountRollHourRiyadh}:00 بتوقيت جدة). ` +
      `يعني ${pct}٪ بس من أي زيادة دلوقتي ممكن تتصرف والمطعم فاتح — الباقي بيروح على ساعات مفيش فيها بيع.`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   السقف المكتسب — قاعدة المالك بالحرف، من غير أي توقّع

   المالك صحّح الفهم: «انا مش قصدي إن الصرف بيزوّد النتايج. قصدي إنه بيدّينا
   فرصة إننا نسكيل بشكل أكبر ونصرف أكتر في نفس اليوم اللي فيه دخل كبير —
   لحد ما نشغّل الدفع الأونلاين والتوصيل.»

   يعني السؤال مش «اليوم ده هيجيب كام؟» — ده سؤال توقّع وإجابته الساعة ٥
   العصر بتغلط ٥١٪. السؤال هو «أنا استحقيت أصرف كام لحد دلوقتي؟» — وده
   سؤال حسابي، إجابته الفلوس اللي في الدرج، ومفيهاش خطأ تقدير خالص.

     المسموح دلوقتي = ٢٠٪ × الدخل اللي دخل فعلاً لحد دلوقتي

   ── الخاصية اللي بتخلي القاعدة دي آمنة رياضياً ─────────────────────────
   دخل النهارده لحد دلوقتي دايماً ≤ دخل النهارده كله. يعني ٢٠٪ من الأول
   دايماً ≤ ٢٠٪ من التاني. فالصرف المتراكم *مستحيل* يكسر قاعدة الـ ٢٠٪ على
   اليوم اللي قفل، مهما حصل. السقف بيطلع لوحده مع كل طلب بيدخل، وعمره ما
   بيتخطى المستحق. صفر مخاطرة تنبّؤ.

   ── الأرضية: ليه مش صفر أول اليوم ────────────────────────────────────
   الساعة ١١ الصبح الدخل صفر، والإعلان لازم يشتغل *قبل* ما البيع ييجي.
   فالسقف عمره ما بينزل تحت أرضية = سقف المتوسط القديم (٢٠٪ من متوسط ٧
   أيام). المكتسب بيرفع بس، عمره ما بينزّل. والأرضية دي هي المكان الوحيد
   اللي ممكن نصرف فيه فوق الـ ٢٠٪ — ومكتوبة صراحة عشان تتحاسب في التسوية.

   ── الترباس (ratchet) ────────────────────────────────────────────────
   الدخل جوّه اليوم بيزيد بس، إنما مرتجع أو إلغاء على الكاشير ممكن ينزّله.
   لو سبنا السقف ينزل معاه كنا هنقصّ ميزانية على فلوس اتصرفت خلاص. فبنمسك
   أعلى رقم شفناه النهارده (high water) وبنحسب عليه — السقف بيثبت ولا يرجع.
═══════════════════════════════════════════════════════════════════════════ */
export function earnedCeiling({
  revenueSoFar = 0, highWaterRevenue = null, sharePct = 20,
  floorCeiling = 0, hardMax = 2000, absoluteFloor = 150,
} = {}) {
  const seen = Math.max(0, Number(revenueSoFar) || 0);
  const hw = Math.max(seen, Math.max(0, Number(highWaterRevenue) || 0));
  const cap = Math.max(0, Number(hardMax) || 0);
  const earned = Math.round(hw * (Number(sharePct) || 0) / 100);
  const floorC = Math.max(Math.round(Number(floorCeiling) || 0), Math.max(0, Number(absoluteFloor) || 0));

  let ceiling = Math.max(floorC, earned);
  let capped = null;
  if (ceiling > cap) { ceiling = cap; capped = "السقف المطلق"; }

  const binding = earned >= floorC ? "earned" : "floor";
  const ratcheted = hw > seen + 0.5;
  return {
    ceiling, earned, highWater: r2(hw), revenueSoFar: r2(seen), floorCeiling: floorC,
    binding, capped, ratcheted, sharePct, hardMax: cap,
    reason: binding === "earned"
      ? `دخل النهارده لحد دلوقتي ${ar(hw)} ر.س × ${sharePct}٪ = ${ar(earned)} ر.س مسموح تتصرف على الإعلانات — دي فلوس دخلت الدرج فعلاً مش توقّع.` +
        (ratcheted ? ` (فيه مرتجع نزّل الدخل لـ ${ar(seen)} ر.س، بس السقف مبيرجعش لورا جوّه اليوم عشان ما نقصّش ميزانية على فلوس اتصرفت خلاص.)` : "") +
        (capped ? ` متقصوص على ${capped} ${ar(ceiling)} ر.س.` : "")
      : `دخل النهارده لحد دلوقتي ${ar(hw)} ر.س، يعني المستحق بقاعدة الـ ${sharePct}٪ ${ar(earned)} ر.س بس. ` +
        `السقف واقف على الأرضية ${ar(floorC)} ر.س لإن الإعلان لازم يشتغل قبل ما البيع ييجي — أول ما الدخل يعدّي ${ar(Math.round(floorC * 100 / (Number(sharePct) || 20)))} ر.س السقف يبتدي يطلع لوحده مع كل طلب.`,
  };
}

/* ── سقف اليوم ──────────────────────────────────────────────────────────
   الأرضية (٢٠٪ من متوسط ٧ أيام) + المكتسب فوقها. والتوقّع (projection)
   بيترجع معاه كـ `outlook` — رقم للعرض بس، عمره ما بيحرّك ريال: خطأه
   الساعة ٥ العصر ٥١٪، وقاعدة المالك مربوطة بفلوس حقيقية مش بتخمين.       */
export function movingCeiling({
  trailing7Avg = null, sharePct = 20, stretchPct = 25, pacePct = null,
  hotThresholdPct = 20, hardMax = 2000, floor = 150, fallback = 1000,
  projection = null, earned = null, floorPct = 100,
} = {}) {
  const cap = Math.max(0, Number(hardMax) || 0);
  const avg = Number(trailing7Avg);
  const hasAvg = Number.isFinite(avg) && avg > 0;
  const outlook = projection && projection.usable ? projection : null;

  /* الأرضية: سقف المتوسط القديم. لو المبيعات مش مقروءة بنرجع للرقم اليدوي. */
  const baseline = hasAvg ? Math.round(avg * (Number(sharePct) || 0) / 100) : Math.min(Number(fallback) || 0, cap);
  const floorCeiling = Math.max(
    Math.round(baseline * Math.max(0, Math.min(100, Number(floorPct) ?? 100)) / 100),
    Math.max(0, Number(floor) || 0));

  const e = earnedCeiling({
    revenueSoFar: earned?.revenueSoFar ?? 0,
    highWaterRevenue: earned?.highWater ?? null,
    sharePct, floorCeiling, hardMax: cap, absoluteFloor: floor,
  });

  const known = earned != null;
  const source = !hasAvg && !known ? "fallback" : e.binding === "earned" ? "earned" : "floor";
  const head = !known
    ? (hasAvg
      ? `متوسط مبيعات آخر ٧ أيام ${ar(avg)} ر.س/يوم × ${sharePct}٪ = ${ar(baseline)} ر.س — ده سقف الأرضية. (مبيعات النهارده لسه مش مقروءة، فالمكتسب ما اتحسبش.)`
      : `مفيش مبيعات محسوبة لآخر ٧ أيام، فقاعدة الـ ${sharePct}٪ مالهاش أساس تتحسب عليه. السقف رجع للرقم الاحتياطي ${ar(floorCeiling)} ر.س/يوم.`)
    : e.reason + (e.binding === "floor" && hasAvg
      ? ` (الأرضية = ٢٠٪ من متوسط آخر ٧ أيام ${ar(avg)} ر.س.)` : "");

  return {
    ceiling: e.ceiling,
    earned: known ? e.earned : null,
    revenueSoFar: known ? e.revenueSoFar : null,
    highWater: known ? e.highWater : null,
    ratcheted: known ? e.ratcheted : false,
    binding: known ? e.binding : "floor",
    floorCeiling, floorPct,
    base: baseline, trailing7Avg: hasAvg ? r2(avg) : null,
    sharePct, hardMax: cap, floor, capped: e.capped, source,
    /* التوقّع باقي كإشارة مساعدة وبس — واضح إنه منفصل، ومش داخل في أي حسبة
       فلوس. لو رجع يشيل السقف تاني نكون رجّعنا خطأ ٥١٪ من الشباك. */
    outlook: outlook ? { projected: outlook.projected, share: outlook.share, reason: outlook.reason } : null,
    projection,
    reason: head + ` — السقف دلوقتي ${ar(e.ceiling)} ر.س.`,
  };
}

/* ── تسوية آخر اليوم ────────────────────────────────────────────────────
   السقف والمستحق بقوا نفس العملة دلوقتي، فالتسوية بقت أوضح: صرفنا كام
   مقابل الـ ٢٠٪ اللي اليوم استحقّها فعلاً.

   والمهم: الجزء المكتسب من السقف *مستحيل* يعدّي المستحق (لإن الدخل لحد
   دلوقتي دايماً أقل من دخل اليوم كله). فأي زيادة في التسوية مصدرها واحد
   وبس — أرضية السقف، اللي إحنا حاطينها عن قصد عشان الإعلان يشتغل قبل ما
   البيع ييجي. يعني السطر ده بقى بيقيس تكلفة الأرضية بالظبط، مش دقة توقّع. */
export function reconcileDay({ realisedRevenue = 0, spend = 0, sharePct = 20, ceilingUsed = null } = {}) {
  const rev = Math.max(0, Number(realisedRevenue) || 0);
  const spent = Math.max(0, Number(spend) || 0);
  const entitled = Math.round(rev * (Number(sharePct) || 20) / 100);
  const variance = spent - entitled;
  const pctOfSales = rev > 0 ? Math.round((spent / rev) * 1000) / 10 : null;
  const band = Math.max(20, entitled * 0.15);
  const tone = variance > band ? "over" : variance < -band ? "under" : "on";
  return {
    realisedRevenue: r2(rev), spend: r2(spent), entitled, variance: r2(variance),
    pctOfSales, ceilingUsed, tone,
    reason: `اليوم قفل على ${ar(rev)} ر.س مبيعات، يعني قاعدة الـ ${sharePct}٪ كانت بتسمح بـ ${ar(entitled)} ر.س إعلانات. ` +
      `صرفنا ${ar(spent)} ر.س${pctOfSales == null ? "" : ` (${pctOfSales}٪ من المبيعات)`} — ` +
      (tone === "over" ? `يعني زيادة ${ar(Math.abs(variance))} ر.س فوق المستحق — ودي كلها جاية من أرضية السقف، مش من حساب غلط: اليوم طلع أقل من المتوسط والإعلانات كانت شغالة قبل ما يبان. لو الأرضية دي غالية عليك، نزّلها من الإعدادات (earnedFloorPct).`
        : tone === "under" ? `يعني أقل بـ ${ar(Math.abs(variance))} ر.س من المستحق — سبنا فرصة على الأرض.`
          : `يعني في حدود المستحق.`),
  };
}

/* ── اقتصاديات العميل — الحساب النقي ────────────────────────────────────
   كل الأرقام اللي جوّه بتيجي من الاستعلامات تحت. الدالة دي بتعمل الحسبة
   وبتكتب خطواتها بالعربي عشان المالك يقرا العملية مش النتيجة بس — لو رقم
   منهم غلط في دماغه، يعرف يقول غلط فين.                                   */
export function shapeEconomics(input) {
  const {
    customers = 0, lifetimeRevenue = 0, lifetimeOrders = 0, repeaters = 0,
    goalDailySales = 10000, sharePct = 20, grossMarginPct = 65,
    windowDays = 1, newCustomersInWindow = 0, returningRevenueInWindow = 0,
    salesInWindow = 0, adSpendInWindow = null, attributedNewCustomers = null,
    allowedSpendToday = null,
  } = input;

  const ltv = customers > 0 ? lifetimeRevenue / customers : null;
  const aov = lifetimeOrders > 0 ? lifetimeRevenue / lifetimeOrders : null;
  const ordersPerCustomer = customers > 0 ? lifetimeOrders / customers : null;
  const repeatRate = customers > 0 ? repeaters / customers : null;

  const days = Math.max(1, Number(windowDays) || 1);
  const newPerDayNow = newCustomersInWindow / days;
  const returningPerDay = returningRevenueInWindow / days;
  const salesPerDay = salesInWindow / days;

  /* (١) الاستقرار: لو بنكسب N عميل جديد كل يوم، وكل عميل بيدّي LTV على عمره،
        فبعد ما الدورة تستقر إيراد اليوم = N × LTV. (كل يوم عندك كل الأفواج
        اللي لسه حيّة، ومجموع اللي بيصرفوه في اليوم بيساوي فوج واحد كامل.)
        فعشان ١٠ آلاف في اليوم: N = الهدف ÷ القيمة العمرية.                */
  const neededSteady = ltv > 0 ? goalDailySales / ltv : null;

  /* (٢) النهارده: العملاء الراجعين بيجيبوا رقم شبه ثابت كل يوم. الفرق بين
        ده وبين الهدف لازم ييجي من عملاء جداد بمتوسط الفاتورة.             */
  const neededToday = aov > 0 ? Math.max(0, goalDailySales - returningPerDay) / aov : null;

  /* (٣) أقصى تكلفة مسموحة للعميل الجديد. طريقتين، والملزم هو الأصغر:
        • قاعدة المالك: الإعلانات = ٢٠٪ من المبيعات. في الاستقرار مبيعات
          العميل الواحد على عمره = LTV، فحصته من الإعلانات = ٢٠٪ × LTV.
        • السقف النظري: أكتر من هامش العميل يبقى إحنا بنشتري خسارة.        */
  const cacRule = ltv != null ? ltv * (Number(sharePct) || 0) / 100 : null;
  const cacMargin = ltv != null ? ltv * (Number(grossMarginPct) || 0) / 100 : null;
  const allowedCac = cacRule != null && cacMargin != null ? Math.min(cacRule, cacMargin) : cacRule;

  const measuredCac = adSpendInWindow > 0 && attributedNewCustomers > 0
    ? adSpendInWindow / attributedNewCustomers : null;
  const blendedCac = adSpendInWindow > 0 && newCustomersInWindow > 0
    ? adSpendInWindow / newCustomersInWindow : null;
  const affordableToday = allowedSpendToday > 0 && neededSteady > 0
    ? allowedSpendToday / neededSteady : null;

  const math = [
    ltv != null && {
      label: "القيمة العمرية للعميل (LTV)",
      expr: `${ar(lifetimeRevenue)} ر.س إيراد ÷ ${ar(customers)} عميل معروف`,
      value: r2(ltv), unit: "ر.س",
    },
    aov != null && {
      label: "متوسط الفاتورة (AOV)",
      expr: `${ar(lifetimeRevenue)} ر.س ÷ ${ar(lifetimeOrders)} طلب`,
      value: r2(aov), unit: "ر.س",
    },
    neededSteady != null && {
      label: "عملاء جدد مطلوبين كل يوم (عند الاستقرار)",
      expr: `${ar(goalDailySales)} ر.س هدف يومي ÷ ${r2(ltv)} ر.س قيمة عمرية`,
      value: Math.ceil(neededSteady), unit: "عميل/يوم",
    },
    neededToday != null && {
      label: "عملاء جدد مطلوبين النهارده (لو الراجعين ثابتين)",
      expr: `(${ar(goalDailySales)} − ${ar(returningPerDay)} ر.س من العملاء الراجعين) ÷ ${r2(aov)} ر.س متوسط فاتورة`,
      value: Math.ceil(neededToday), unit: "عميل/يوم",
    },
    {
      label: "عملاء جدد بنكسبهم فعلاً دلوقتي",
      expr: `${ar(newCustomersInWindow)} عميل جديد ÷ ${ar(days)} يوم`,
      value: r2(newPerDayNow), unit: "عميل/يوم",
    },
    cacRule != null && {
      label: "أقصى تكلفة للعميل الجديد — قاعدة الـ ٢٠٪",
      expr: `${r2(ltv)} ر.س قيمة عمرية × ${sharePct}٪ (نسبة المالك للإعلانات)`,
      value: r2(cacRule), unit: "ر.س",
    },
    cacMargin != null && {
      label: "السقف النظري للتكلفة — حد الهامش",
      expr: `${r2(ltv)} ر.س × ${grossMarginPct}٪ هامش تقديري`,
      value: r2(cacMargin), unit: "ر.س",
    },
    measuredCac != null && {
      label: "أقصى تقدير للتكلفة — العملاء اللي أثبتنا إن الإعلان جابهم",
      expr: `${ar(adSpendInWindow)} ر.س صرف إعلانات ÷ ${ar(attributedNewCustomers)} عميل جديد مسند لقناة مدفوعة`,
      value: r2(measuredCac), unit: "ر.س",
    },
    blendedCac != null && {
      label: "أقل تقدير للتكلفة — كل عميل جديد في المطعم",
      expr: `${ar(adSpendInWindow)} ر.س صرف إعلانات ÷ ${ar(newCustomersInWindow)} عميل جديد (مهما جه منين)`,
      value: r2(blendedCac), unit: "ر.س",
    },
  ].filter(Boolean);

  /* التكلفة الحقيقية بين الرقمين، مش واحد منهم. الأعلى بيحسب بس اللي قدرنا
     نثبته برقم جوال (وده أقل بكتير من الحقيقة لأن أغلب البيع كاش على
     الكاشير)، والأقل بينسب للإعلان كل عميل جديد دخل المطعم (وده أكرم من
     اللازم). عرض واحد منهم لوحده على إنه «التكلفة» كذب في اتجاه أو التاني. */
  const cacRange = measuredCac != null && blendedCac != null
    ? { low: r2(Math.min(measuredCac, blendedCac)), high: r2(Math.max(measuredCac, blendedCac)),
        note: "التكلفة الحقيقية للعميل الجديد بين الرقمين: الأقل بينسب للإعلان كل عميل جديد دخل المطعم، والأعلى بيحسب بس العملاء اللي قدرنا نثبت بالجوال إنهم جم من قناة مدفوعة." }
    : null;

  return {
    ltv: ltv == null ? null : r2(ltv),
    aov: aov == null ? null : r2(aov),
    ordersPerCustomer: ordersPerCustomer == null ? null : r2(ordersPerCustomer),
    repeatRate: repeatRate == null ? null : Math.round(repeatRate * 1000) / 10,
    customers, lifetimeOrders, lifetimeRevenue: r2(lifetimeRevenue),
    newPerDayNow: r2(newPerDayNow),
    neededPerDaySteady: neededSteady == null ? null : Math.ceil(neededSteady),
    neededPerDayToday: neededToday == null ? null : Math.ceil(neededToday),
    gapPerDay: neededSteady == null ? null : Math.max(0, Math.ceil(neededSteady - newPerDayNow)),
    allowedCac: allowedCac == null ? null : r2(allowedCac),
    allowedCacByRule: cacRule == null ? null : r2(cacRule),
    allowedCacByMargin: cacMargin == null ? null : r2(cacMargin),
    measuredCac: measuredCac == null ? null : r2(measuredCac),
    blendedCac: blendedCac == null ? null : r2(blendedCac),
    attributedNewCustomers: attributedNewCustomers ?? null,
    newCustomersInWindow,
    cacRange,
    affordableCacToday: affordableToday == null ? null : r2(affordableToday),
    salesPerDay: r2(salesPerDay),
    returningRevenuePerDay: r2(returningPerDay),
    goalDailySales,
    goalProgressPct: goalDailySales > 0 ? Math.round((salesPerDay / goalDailySales) * 100) : null,
    math,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   اللوج البسيط — «عايز لوج بسيط بيبين كل القرارات وسببها بطريقة سهلة»

   الشاشة بتقرا زي شريط واتساب: سطر واحد بيقول حصل إيه، سطر تحته بالأرقام
   اللي خلّته يحصل، وكلمة واحدة بتقول النتيجة. مفيش JSON ومفيش أرقام حملات
   ولا معرّفات — لو رقم مالوش معنى للمالك، مالوش مكان في السطر.
═══════════════════════════════════════════════════════════════════════════ */

/* من غير مفتاح `id` عن قصد: الناتج بيتفرد جوّه سطر اللوج، ولو كان فيه id
   كان هيدوس على id الصف الحقيقي — والواجهة بتستعمله كمفتاح في القايمة. */
export const LOG_TYPES = {
  raise:   { label: "رفع ميزانية", icon: "📈", tone: "up" },
  cut:     { label: "خفض ميزانية", icon: "📉", tone: "down" },
  restore: { label: "رجوع للأساس", icon: "↩️", tone: "neutral" },
  pause:   { label: "إيقاف",       icon: "⏸️", tone: "stop" },
  resume:  { label: "تشغيل",       icon: "▶️", tone: "go" },
  alert:   { label: "تنبيه",       icon: "🚨", tone: "alert" },
  note:    { label: "ملاحظة",      icon: "📝", tone: "note" },
  error:   { label: "خطأ",         icon: "⚠️", tone: "error" },
  settle:  { label: "تسوية اليوم",  icon: "🧾", tone: "note" },
};

const OUTCOME = {
  executed: "تم", auto_executed: "تم", approved: "تم",
  proposed: "مستني موافقتك", rejected: "اترفض", refused: "اترفض",
  failed: "فشل", info: "للعلم",
  /* مؤجّل ≠ فشل. المنصة كانت مخنوقة فما بعتناش الأمر أصلاً عشان ما ناكلش
     الحصة اللي الأمر نفسه مستنيها — وهيترجع لوحده. المالك لازم يقرا الفرق
     ده، لإن «فشل» بتخوّف و«مؤجّل» بتوصف الطيار وهو بيتصرّف صح. */
  deferred: "مؤجّل — هيترجع لوحده",
};

/* أي معرّف طويل (UUID أو رقم حملة من ١٥ رقم) مالوش لازمة في جملة بيقراها
   بني آدم — بيتشال من النص قبل ما يتعرض. */
const stripIds = (t) => String(t || "")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
  .replace(/\b\d{12,}\b/g, "")
  .replace(/\s{2,}/g, " ")
  .trim();

const clip = (t, n) => {
  const s = stripIds(t);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const dot = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("۔"), cut.lastIndexOf("—"));
  return (dot > n * 0.5 ? cut.slice(0, dot + 1) : cut) + "…";
};

/* صف واحد من ap_decisions → سطر واحد في الشريط. بترجّع null للصفوف اللي
   مالهاش لازمة في شاشة المالك (دورات تفكير الوكيل الخام مثلاً). */
/* الحُكم على دعوى واحدة، من غير قاعدة بيانات ولا شبكة — عشان يتختبر.

   ثلاث حقائق بتتحط مع بعض: اللي أمرنا بيه، اللي المنصة بتقوله دلوقتي، وعُمر
   الأمر. العمر مهم: المنصات بتاخد لحد دقيقة عشان الحالة تستقر، فقراءة بدري
   بتقول «مختلف» وهي في الحقيقة «لسه». وبعد ساعتين مابنفضلش نقول «مختلف»
   للأبد — بنقول «مش عارفين»، وده أصدق.

   الميزانية بتتقارن بهامش ريال لإن المنصات بتخزّنها بالسنت وبتقرّب.        */
export const CLAIM_BUDGET_TOLERANCE = 1;
export const CLAIM_SETTLE_GRACE_MS = 90_000;
export const CLAIM_STALE_MS = 2 * 60 * 60_000;

export function claimVerdict({ field, expected, campaign, ageMs = Infinity } = {}) {
  if (!campaign) return { verdict: "gone", actual: null, wait: false };

  let actual, ok;
  if (field === "budget") {
    actual = campaign.dailyBudget == null ? null : String(campaign.dailyBudget);
    ok = actual != null && Math.abs(Number(actual) - Number(expected)) <= CLAIM_BUDGET_TOLERANCE;
  } else {
    actual = String(campaign.status || "").toUpperCase();
    ok = actual === String(expected).toUpperCase();
  }
  if (ok) return { verdict: "confirmed", actual, wait: false };
  if (ageMs < CLAIM_SETTLE_GRACE_MS) return { verdict: "mismatch", actual, wait: true };
  return { verdict: ageMs > CLAIM_STALE_MS ? "stale" : "mismatch", actual, wait: false };
}

export function logLine(row) {
  const kind = String(row.kind || "");
  const status = String(row.status || "");
  const d = row.detail || {};
  const name = row.campaign_name || row.campaignName || null;
  const q = name ? `"${name}"` : "الحملة";
  const outcome = OUTCOME[status] || status;

  // دورات تفكير الوكيل: بتتعرض في شاشة الوكيل التفصيلية، مش هنا. بنستثني
  // بس الرفض — إن الوكيل حاول يعمل حاجة واتمنع ده حدث المالك لازم يشوفه.
  if (kind === "agent" && status !== "refused" && status !== "failed") return null;

  /* «مانديناش الموديل» مش قرار إعلاني — ده محاسبة. بيتسجّل في ap_decisions
     عشان يكون فيه أثر، وبيتقرا من /api/autopilot/llm-usage، بس مالوش مكان
     في شريط المالك: هو بيتكرّر كل ساعة وهيغرق القرارات الحقيقية. */
  if (kind === "llm_skip") return null;

  let type = "note", title = "", why = "";

  if (kind === "daypart") {
    const op = d.op || "";
    type = op === "pause" ? "pause" : op === "resume" ? "resume" : "note";
    title = op === "pause" ? `وقّفنا إعلانات ${q} — المطعم قفل`
      : op === "resume" ? `شغّلنا إعلانات ${q} تاني — المطعم على وشك يفتح`
      : `قفلنا قيد الإيقاف اليومي على ${q}`;
    if (d.restoreTo != null) title += ` على ميزانية ${ar(d.restoreTo)} ر.س`;
    why = d.window ? `نافذة الإعلانات ${d.window}${d.clock ? ` · الساعة دلوقتي ${d.clock} بتوقيت جدة` : ""}` : clip(row.reason, 200);
  } else if (kind === "pace") {
    const op = d.op || "";
    const from = d.from, to = d.to;
    if (op === "restore") {
      type = "restore";
      title = `رجّعنا ميزانية ${q} لـ ${ar(to)} ر.س زي ما كانت`;
      why = "يوم الحساب الإعلاني على وشك يقفل — التسريع بتاع النهارده بيرجع لرقمه الأصلي.";
    } else if (op === "up") {
      type = "raise";
      title = `رفعنا ميزانية ${q} من ${ar(from)} لـ ${ar(to)} ر.س في اليوم`;
    } else if (op === "down") {
      type = "cut";
      title = `سحبنا تسريع ${q} من ${ar(from)} لـ ${ar(to)} ر.س في اليوم`;
    } else {
      type = "note";
      title = `الإيقاع اليومي شاف حركة يعملها على ${q}`;
    }
    if (!why) {
      const t = d.today || {}, b = d.baseline || {};
      why = d.pacePct != null
        ? `مبيعات النهارده ${Number(d.pacePct) >= 0 ? "أسرع" : "أبطأ"} من المعتاد بـ ${Math.abs(Math.round(Number(d.pacePct)))}٪` +
          (t.orders != null && b.orders != null ? ` (${ar(t.orders)} طلب و${ar(t.revenue)} ر.س مقابل ${ar(b.orders)} طلب و${ar(b.revenue)} ر.س في نفس اليوم من الأسابيع اللي فاتت).` : ".")
        : clip(row.reason, 200);
    }
  } else if (kind === "reconcile") {
    /* سطر آخر اليوم: صرفنا كام مقابل اللي اليوم استحقّه فعلاً. ده السطر اللي
       بيخلي المالك يحكم على الوكيل بدل ما يصدّقه. */
    type = "settle";
    const varAbs = ar(Math.abs(Number(d.variance) || 0));
    title = d.tone === "over" ? `صرفنا ${ar(d.spend)} ر.س والمستحق كان ${ar(d.entitled)} — زيادة ${varAbs} ر.س`
      : d.tone === "under" ? `صرفنا ${ar(d.spend)} ر.س والمستحق كان ${ar(d.entitled)} — سبنا ${varAbs} ر.س على الأرض`
      : `صرفنا ${ar(d.spend)} ر.س والمستحق ${ar(d.entitled)} ر.س — في الحدود`;
    why = clip(row.reason, 300);
  } else if (kind === "budget") {
    const from = Number(d.from), to = Number(d.to);
    type = Number.isFinite(from) && Number.isFinite(to) && to < from ? "cut" : "raise";
    title = Number.isFinite(from)
      ? `${type === "cut" ? "خفّضنا" : "رفعنا"} ميزانية ${q} من ${ar(from)} لـ ${ar(to)} ر.س في اليوم`
      : `ظبطنا ميزانية ${q} على ${ar(to)} ر.س في اليوم`;
    why = clip(row.reason, 240);
  } else if (kind === "pause") {
    type = "pause";
    title = `وقّفنا ${q}`;
    why = clip(row.reason, 240);
  } else if (kind === "resume") {
    type = "resume";
    title = `شغّلنا ${q}`;
    why = clip(row.reason, 240);
  } else if (kind === "emergency") {
    type = "alert";
    title = clip(row.reason, 160) || "الفحص السريع لقى حاجة غلط";
    why = "فحص كل بضع دقائق بيدوّر على صرف بيضيع أو حملة بتتكلف أكتر من اللازم.";
  } else if (kind === "strategy") {
    type = "note";
    title = "الوكيل كتب قراءة للوضع وأفكار كرياتيف جديدة";
    why = clip(row.reason || d.summary, 240);
  } else if (kind === "agent") {
    type = status === "failed" ? "error" : "note";
    title = status === "refused"
      ? `الوكيل حاول يعمل حركة على ${q} والأسوار منعته`
      : "الوكيل وقع في الجولة دي";
    why = clip(d.refusal || row.reason || d.error, 260);
  } else {
    /* note وأي حاجة تانية. نصوص القواعد الصمّاء مكتوبة كجملة حكم بعدها
       شرطة بعدها الأرقام — فبنقصّها عند الشرطة: الجملة تبقى العنوان
       والأرقام تبقى السبب. لو مفيش شرطة، بنقصّ عند أول نقطة. */
    type = "note";
    const full = stripIds(row.reason || "");
    const cutAt = (() => {
      const dash = full.indexOf(" — ");
      if (dash > 10) return { head: full.slice(0, dash), tail: full.slice(dash + 3) };
      const dot = full.indexOf(". ");
      if (dot > 10) return { head: full.slice(0, dot + 1), tail: full.slice(dot + 2) };
      return { head: full, tail: "" };
    })();
    /* الملاحظة بتتكتب عن حملة بعينها بس نصّها مبيسمّهاش — ست حملات في
       فترة التعلّم بيطلعوا ست سطور متطابقة. الاسم بيتحط قدام. */
    title = clip(cutAt.head, 120) || "ملاحظة";
    if (name && !title.includes(name)) title = `${q}: ${title}`;
    why = clip(cutAt.tail, 220);
  }

  if (status === "failed" && type !== "error") {
    why = `${why} (المنصة رفضت التنفيذ${row.result?.error ? ": " + clip(row.result.error, 120) : ""})`.trim();
  }

  return {
    id: row.id,
    at: row.created_at || row.at || null,
    type, ...LOG_TYPES[type],
    title: stripIds(title),
    why: stripIds(why),
    outcome,
    pending: status === "proposed",
    campaign: name,
    platform: row.platform || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, jb, todayISO, daysAgoISO } = ctx;
  const adsSync = deps.adsSync || null;          // ads.register() return value
  const audiencesSync = deps.audiencesSync || null;
  const attribution = deps.attribution || null;  // attribution.register() return value

  // حالة الدورات — معرّفة هنا عشان الوكيل والدورة الكاملة يشوفوا نفس الأقفال.
  let running = false;
  let emergencyRunning = false;
  let lastNightlyAudienceDay = null;
  let lastDayLogDay = null;
  const platformFails = {};

  /* ── schema ── */
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ap_settings (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ap_runs (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running',   -- running|done|error
        summary JSONB NOT NULL DEFAULT '{}',
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS ap_runs_time_idx ON ap_runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS ap_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        platform TEXT,
        campaign_id TEXT,
        campaign_name TEXT,
        kind TEXT NOT NULL,          -- pause|budget|note|creative|offer|strategy
        detail JSONB NOT NULL DEFAULT '{}',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|rejected|executed|auto_executed|failed|info
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        executed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ap_decisions_status_idx ON ap_decisions(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS ap_decisions_campaign_idx ON ap_decisions(platform, campaign_id, created_at DESC);
      -- دفتر الإيقاع اليومي. المفتاح فيه account_day (يوم الحساب الإعلاني
      -- بتوقيت لوس أنجلوس) مش يوم جدة — لإن ده اليوم اللي المنصة بتحاسب
      -- عليه، وهو اللي الاسترجاع بيتعلّق بيه. base_budget = ميزانية المالك
      -- قبل أول لمسة في اليوم ده، وهي الرقم اللي بنرجّع له مهما حصل.
      CREATE TABLE IF NOT EXISTS ap_pacing (
        platform TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        account_day DATE NOT NULL,
        base_budget NUMERIC NOT NULL,
        current_budget NUMERIC NOT NULL,
        steps INT NOT NULL DEFAULT 0,
        last_action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        restored_at TIMESTAMPTZ,
        PRIMARY KEY (platform, campaign_id, account_day)
      );
      CREATE INDEX IF NOT EXISTS ap_pacing_open_idx ON ap_pacing(restored_at, account_day);
      -- campaign_id بقى رقم الهدف: حملة (CBO) أو مجموعة إعلانية (ABO).
      -- من غير level الاسترجاع مبيعرفش يرجّع إيه بأي مستوى، والزيادة على
      -- مجموعة كانت هتفضل شغالة وتبقى أساس اليوم اللي بعده في صمت.
      ALTER TABLE ap_pacing ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'campaign';
      ALTER TABLE ap_pacing ADD COLUMN IF NOT EXISTS parent_id TEXT;
      -- دفتر نافذة الإعلانات. كل حملة إحنا وقفناها لما المطعم قفل بتتسجّل
      -- هنا لحد ما نشغّلها تاني. الدفتر في قاعدة البيانات مش في الذاكرة عن
      -- قصد: لو الخدمة اترستَرتت وهي مقفولة، أول تشغيلة بعد ١١ صباحاً
      -- بتلاقي القيود دي مفتوحة وبتشغّل الحملات. من غير كده الحملات ممكن
      -- تفضل موقوفة يوم كامل ومحدش يعرف ليه.
      -- base_budget = ميزانية المالك وقت الإيقاف (مش ميزانية التسريع لو كان
      -- في تسريع مفتوح) — عشان التشغيل يرجّعها على رقمها الصح.
      CREATE TABLE IF NOT EXISTS ap_daypart (
        platform TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        biz_day DATE NOT NULL,
        base_budget NUMERIC,
        paused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resumed_at TIMESTAMPTZ,
        PRIMARY KEY (platform, campaign_id, biz_day)
      );
      CREATE INDEX IF NOT EXISTS ap_daypart_open_idx ON ap_daypart(resumed_at, biz_day);
      -- ترباس السقف المكتسب. الدخل جوّه اليوم بيزيد بس، إنما مرتجع على
      -- الكاشير ممكن ينزّله — ولو السقف نزل معاه كنا هنقصّ ميزانية على فلوس
      -- اتصرفت خلاص. بنمسك أعلى رقم شفناه في يوم المطعم ده وبنحسب عليه.
      -- في قاعدة البيانات مش في الذاكرة عشان إعادة تشغيل نص اليوم ما تفقدش
      -- الترباس وترجّع السقف لورا.
      CREATE TABLE IF NOT EXISTS ap_earned (
        biz_day DATE PRIMARY KEY,
        high_water NUMERIC NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- دفتر الدعاوى: كل حاجة الطيار *فاكر* إنه عملها على المنصة.
      --
      -- «النداء رجع ٢٠٠» مش «الحملة وقفت». الفرق ده أغلى نوع باج عندنا
      -- وكلّفنا فلوس فعلاً. التحقق بتاع النافذة كان بيغطّي الإيقاف والتشغيل
      -- بس؛ الدفتر ده بيعمّم نفس الفكرة على أي أمر — الميزانية والتسريع
      -- كمان. كل كتابة ناجحة بتسجّل دعوى، وقراءة واحدة لكل منصة بتقفل كل
      -- الدعاوى المفتوحة مرة واحدة، فالتكلفة نداء واحد للمنصة مهما كان عدد
      -- الأوامر — مش نداء لكل أمر.
      CREATE TABLE IF NOT EXISTS ap_claims (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        field TEXT NOT NULL,                      -- status | budget
        expected TEXT NOT NULL,
        decision_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checked_at TIMESTAMPTZ,
        settled_at TIMESTAMPTZ,
        verdict TEXT,                             -- confirmed | mismatch | gone | stale | superseded
        actual TEXT
      );
      CREATE INDEX IF NOT EXISTS ap_claims_open_idx ON ap_claims(settled_at, platform);
      /* دفتر التوكنز. صف لكل (يوم، غرض، موديل) — بيخلّي السؤال «راحت فين؟»
         سؤال SQL مش تخمين. عمود billed_tokens هو التوكنز الموزونة (الكاش بعُشر التمن)
         وهي اللي الميزانية اليومية بتتقاس بيها. */
      CREATE TABLE IF NOT EXISTS ap_llm_usage (
        day DATE NOT NULL,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        calls INT NOT NULL DEFAULT 0,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        cache_read_tokens BIGINT NOT NULL DEFAULT 0,
        cache_write_tokens BIGINT NOT NULL DEFAULT 0,
        billed_tokens BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (day, purpose, model)
      );
      /* دفتر «ليه اليوم ده كان كويس». النظام كله بيسجّل «كام» و«إمتى»
         ومحدش بيسجّل «ليه» — يوم ١٣ و١٤ أغسطس عملوا ٤٬١٩٧ و٤٬٦٣٧ ر.س على
         صرف عادي ومحدش يعرف السبب. الجدول ده هو أصغر حاجة مفيدة تمسك ده. */
      CREATE TABLE IF NOT EXISTS ap_daylog (
        biz_day DATE PRIMARY KEY,
        revenue NUMERIC,
        orders INT,
        avg_ticket NUMERIC,
        items_per_order NUMERIC,
        spend NUMERIC,
        dev_pct NUMERIC,                          -- انحراف الإيراد عن وسيط نفس يوم الأسبوع
        driver TEXT,                              -- الرقم اللي اتحرك: ticket | traffic | both | none
        tags TEXT[] NOT NULL DEFAULT '{}',         -- عرض / بندل / مؤثّر / كرياتيف جديد / مناسبة / ...
        note TEXT,
        answered_by TEXT,
        asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        answered_at TIMESTAMPTZ
      );
    `);

    /* دورات ماتت في نُصّها. النشر بيقتل العملية جوّه الدورة، فالصف بيفضل
       `running` للأبد — وكل نشرة بتزوّد واحدة. القفل نفسه في الذاكرة مش في
       الداتابيز، فدول مش بيقفلوا حاجة؛ بس أي شاشة بتقرا «في دورة شغالة
       دلوقتي» بتفضل تكدب، والعدّاد بيكبر لحد ما يبقى ضوضاء.

       التنضيف وقت التشغيل هو المكان الصح: إحنا لسه بندأ، فأي صف مكتوب
       `running` من عملية قديمة هو بالتعريف صف اتقطع. بنسميه `interrupted`
       مش `error` — العملية ماتت، الدورة مافشلتش. */
    const r = await pool.query(
      `UPDATE ap_runs SET status='interrupted', finished_at=COALESCE(finished_at, NOW())
        WHERE status='running' AND started_at < NOW() - interval '30 minutes'`);
    if (r.rowCount) console.log(`[autopilot] closed ${r.rowCount} interrupted run(s) from a previous process`);
  }
  ensureSchema()
    .then(() => console.log("[autopilot] schema ready"))
    .catch((e) => console.error("[autopilot] schema failed:", e.message));

  /* ═══ محاسبة التوكنز ═══════════════════════════════════════════════════
     كل نداء بيكتب صفه. الكتابة fire-and-forget عن قصد: المحاسبة عمرها ما
     توقّف قرار إعلاني، ولو الصف ضاع الرقم بيبان في الجولة اللي بعدها. */
  usageSink = (purpose, provider, u, billed, day) => {
    pool.query(
      `INSERT INTO ap_llm_usage (day, purpose, model, calls, input_tokens, output_tokens,
                                 cache_read_tokens, cache_write_tokens, billed_tokens, updated_at)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (day, purpose, model) DO UPDATE SET
         calls = ap_llm_usage.calls + 1,
         input_tokens = ap_llm_usage.input_tokens + $4,
         output_tokens = ap_llm_usage.output_tokens + $5,
         cache_read_tokens = ap_llm_usage.cache_read_tokens + $6,
         cache_write_tokens = ap_llm_usage.cache_write_tokens + $7,
         billed_tokens = ap_llm_usage.billed_tokens + $8,
         updated_at = NOW()`,
      [day, purpose, provider.model, u.input, u.output, u.cacheRead, u.cacheWrite, billed]
    ).catch((e) => console.error("[autopilot] llm usage log failed:", e.message));
  };

  /* استهلاك النهارده. بنقرا من الداتابيز مش من الذاكرة عشان النشرة
     (اللي بتقتل العملية) ما تصفّرش العدّاد وتفتح الميزانية من أول وجديد. */
  async function tokensUsedToday() {
    const day = new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `SELECT COALESCE(sum(billed_tokens),0)::bigint AS n FROM ap_llm_usage WHERE day=$1`, [day])
      .catch(() => null);
    const db = r ? Number(r.rows[0].n) : 0;
    if (usageMem.day !== day) { usageMem.day = day; usageMem.total = 0; }
    return Math.max(db, usageMem.total);
  }

  /* البوابة اللي بتتنده قبل **أي** نداء موديل. بترجّع سبب مكتوب لما تقفل،
     عشان اللوج يقول للمالك «مانديناش الموديل لإن كذا» بدل صمت. */
  async function tokenBudget(s) {
    const cap = Math.max(0, Number(s.llmDailyTokenBudget) || 0);
    const used = await tokensUsedToday();
    const left = cap > 0 ? cap - used : Infinity;
    return {
      cap, used, left: Number.isFinite(left) ? left : null,
      pct: cap > 0 ? Math.round((used / cap) * 100) : null,
      blocked: cap > 0 && used >= cap,
      why: cap > 0 && used >= cap
        ? `ميزانية التوكنز اليومية خلصت (${used.toLocaleString("en")} من ${cap.toLocaleString("en")}). الموديل مقفول لحد بكرة — القواعد الصمّاء شغّالة عادي.`
        : null,
    };
  }

  /* ── بصمة الوضع ────────────────────────────────────────────────────────
     السؤال اللي البوابة بتجاوب عليه: «اتغيّر إيه من آخر مرة ندهنا فيها؟»
     البصمة بتاخد اللي بيهم قرار بس — الحملات الشغّالة وحالتها وميزانيتها
     وشريحة تكلفة النتيجة بتاعتها، وقرارات القواعد الصمّاء، وشريحة التقدّم
     ناحية الهدف. الأرقام بتتقرّب لشرايح عن قصد: تكلفة نتيجة اتحركت من
     ١٦٫١٤ لـ ١٦٫٢١ مش «وضع جديد»، دي نفس اللقطة بضوضاء.                  */
  const cpaBand = (v) => v == null ? "?" : v < 3 ? "a" : v < 8 ? "b" : v < 15 ? "c" : v < 30 ? "d" : "e";
  function situationFingerprint(facts, decisions, s) {
    const camps = (facts.campaigns || [])
      .map((c) => [c.platform, c.id, c.status, Math.round(Number(effectiveBudgetOf(c)) || 0),
                   cpaBand(c.w3?.spend > 0 && c.w3?.results > 0 ? c.w3.spend / c.w3.results : null)].join(":"))
      .sort();
    const kinds = (decisions || []).filter((d) => d.kind !== "note")
      .map((d) => `${d.kind}:${d.platform}:${d.campaignId}`).sort();
    const goal = Math.round((Number(facts.sales?.progressPct) || 0) / 10);
    const blocked = Object.keys(facts.reasons || {}).sort().join(",");
    return crypto.createHash("sha1")
      .update(JSON.stringify([camps, kinds, goal, blocked, s.mode, s.targetCpa]))
      .digest("hex").slice(0, 16);
  }

  /* آخر مرة ندهنا فيها الموديل لغرض معيّن، وبأي بصمة. بيتقرا من
     ap_decisions عشان يعيش بعد النشرة. */
  async function lastLlmRun(kind) {
    const r = await pool.query(
      `SELECT created_at, detail->>'fingerprint' AS fp FROM ap_decisions
        WHERE kind=$1 AND status <> 'failed' ORDER BY created_at DESC LIMIT 1`, [kind])
      .catch(() => ({ rows: [] }));
    const row = r.rows[0];
    return row ? { at: new Date(row.created_at), fp: row.fp || null } : { at: null, fp: null };
  }

  /* ── القرار: نندهه ولا لأ؟ ────────────────────────────────────────────
     الترتيب مقصود — الأرخص الأول:
       ١. الميزانية خلصت → لأ، مهما كان السبب.
       ٢. المالك دوس بإيده (manual/force) → أيوه دايماً.
       ٣. القواعد الصمّاء خدت قرار، أو فيه طوارئ → أيوه، ده الموقف الملتبس
          اللي الموديل موجود عشانه.
       ٤. البصمة زي ما هي **و** لسه ما عدّاش الفاصل الأدنى → لأ.
     أي «لأ» بترجع بسبب مكتوب بيتسجّل في اللوج.                            */
  async function llmGate({ kind, s, fingerprint, force = false, reason = null }) {
    const budget = await tokenBudget(s);
    if (budget.blocked) return { run: false, why: budget.why, budget };
    if (force) return { run: true, why: reason || "نداء يدوي", budget };
    const minHours = kind === "strategy"
      ? Math.max(1, Number(s.strategyEveryHours) || 24)
      : Math.max(0, Number(s.agentMinHours) || 6);
    const last = await lastLlmRun(kind === "strategy" ? "strategy" : "agent");
    const hoursSince = last.at ? (Date.now() - last.at.getTime()) / 3_600_000 : Infinity;
    if (reason && kind !== "strategy") {
      /* سبب حقيقي (قرار جديد / طوارئ) بيعدّي الفاصل — بس مش الميزانية.
         وبرضه بنمنع الرشّ: نص ساعة على الأقل بين جولتين. */
      if (hoursSince < 0.5) {
        return { run: false, why: `فيه سبب (${reason}) بس آخر جولة بقالها ${Math.round(hoursSince * 60)} دقيقة — بنستنى نص ساعة على الأقل.`, budget };
      }
      return { run: true, why: reason, budget };
    }
    if (hoursSince < minHours) {
      return { run: false, why: `آخر ${kind === "strategy" ? "خطة" : "جولة وكيل"} بقالها ${hoursSince.toFixed(1)} ساعة والفاصل الأدنى ${minHours} — مفيش داعي نسأل الموديل تاني.`, budget };
    }
    if (fingerprint && last.fp && last.fp === fingerprint) {
      return { run: false, why: `الوضع زي ما هو بالظبط من آخر نداء (نفس الحملات، نفس الحالات، نفس شرايح التكلفة) — مفيش سؤال جديد نسأله.`, budget };
    }
    return { run: true, why: last.at ? "الوضع اتغيّر وعدّى الفاصل الأدنى" : "أول جولة", budget };
  }

  /* «مانديناش الموديل» لازم تتكتب زي ما القرار بيتكتب — من غير كده المالك
     بيشوف صمت ويفتكر إن الأوتوبايلوت واقف. */
  async function logLlmSkip(runId, kind, gate) {
    await pool.query(
      `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
       VALUES ($1,$2,NULL,NULL,NULL,'llm_skip',$3,$4,'info')`,
      [crypto.randomUUID(), runId, jb({ target: kind, budget: gate.budget }), String(gate.why || "").slice(0, 2000)]
    ).catch(() => {});
  }

  async function getSettings() {
    const r = await pool.query(`SELECT data FROM ap_settings WHERE id=1`);
    const stored = { ...(r.rows[0]?.data || {}) };
    // الحقول المحسوبة عمرها ما بتتخزن — لو صف قديم فيه واحد منهم بيتشال هنا
    // عشان ما يتثبّتش سقف اتحسب من مبيعات أسبوع فات.
    delete stored.ceiling;
    return { ...DEFAULT_SETTINGS, ...PACE_DEFAULTS, ...DAYPART_DEFAULTS, ...ECON_DEFAULTS, ...INTRADAY_DEFAULTS, ...stored };
  }
  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...patch };
    delete next.ceiling;
    // Never let the UI push the ceilings above the ads.js hard cap.
    next.maxCampaignBudget = Math.min(Number(next.maxCampaignBudget) || DEFAULT_SETTINGS.maxCampaignBudget, MAX_DAILY_BUDGET);
    next.absoluteMaxTotalBudget = Math.min(
      Math.max(0, Number(next.absoluteMaxTotalBudget) || ECON_DEFAULTS.absoluteMaxTotalBudget),
      MAX_DAILY_BUDGET);
    await pool.query(
      `INSERT INTO ap_settings (id, data, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=NOW()`, [jb(next)]);
    return next;
  }

  /* متوسط مبيعات آخر ٧ أيام — أساس سقف الـ ٢٠٪. النهارده مستبعد عن قصد:
     يوم لسه ما خلصش بيقلّل المتوسط ويقفّل السقف من غير سبب حقيقي. */
  async function trailingDailySales(days = 7) {
    const r = await pool.query(
      `SELECT COALESCE(sum(total),0) AS rev, count(DISTINCT calendar_day)::int AS days
         FROM ts_orders
        WHERE calendar_day BETWEEN
                ((now() AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date - $1::int
            AND ((now() AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date - 1
          AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))`,
      [days]);
    const n = Number(r.rows[0]?.days) || 0;
    return { avg: n > 0 ? Number(r.rows[0].rev) / n : null, days: n };
  }

  /* ── السقف الحيّ ────────────────────────────────────────────────────────
     كل حاجة بتصرف فلوس بتقرا maxTotalBudget. القاعدة الصمّاء، الأسوار،
     الإيقاع اليومي، وكشف الطوارئ. عشان كده السقف بيتحسب مرة في أول كل جولة
     وبيتحقن في نفس كائن الإعدادات اللي بيتمرّر لكل حتة — بدل ما نعدّل خمس
     أماكن ونسيب واحدة بالرقم القديم.
     الإعداد المخزّن (maxTotalBudget) بيفضل موجود كاحتياطي بس. */
  /* ── منحنى اليوم من قاعدة البيانات ──────────────────────────────────────
     استعلام واحد بيرجّع لكل يوم شغل سابق الإيراد المتراكم ساعة بساعة بترتيب
     يوم المطعم. الناتج بيتكاش نص ساعة: الشكل ده بيتغيّر على مدار أسابيع مش
     دقايق، والدورة السريعة بتجري كل ٥ دقايق — من غير الكاش كنا هنقرا كل
     الطلبات ٢٨٨ مرة في اليوم عشان نفس الرقم.                              */
  let shapeCache = { at: 0, shape: null };
  const SHAPE_TTL_MS = 30 * 60_000;

  async function dayShape(force = false) {
    if (!force && shapeCache.shape && Date.now() - shapeCache.at < SHAPE_TTL_MS) return shapeCache.shape;
    const lookback = Number((await getSettings()).shapeLookbackDays) || INTRADAY_DEFAULTS.shapeLookbackDays;
    const r = await pool.query(
      `SELECT o.calendar_day AS day,
              extract(dow from o.calendar_day)::int AS dow,
              floor(${BIZ_ELAPSED_SQL})::int AS off,
              count(*)::int AS orders,
              COALESCE(sum(o.total),0)::numeric AS revenue
         FROM ts_orders o
        WHERE o.calendar_day >= ((now() AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date - $1::int
          AND o.calendar_day <  ((now() AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date
          AND ${SALES_ONLY_SQL}
        GROUP BY 1,2,3`, [lookback]);

    const byDay = new Map();
    for (const row of r.rows) {
      const iso = isoDay(row.day);
      let d = byDay.get(iso);
      if (!d) { d = { day: iso, dow: Number(row.dow), rev: new Array(24).fill(0), orders: 0 }; byDay.set(iso, d); }
      const off = Math.max(0, Math.min(23, Number(row.off)));
      d.rev[off] += Number(row.revenue);
      d.orders += Number(row.orders);
    }
    const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => {
      const cum = []; let c = 0;
      for (let i = 0; i < 24; i++) { c += d.rev[i]; cum.push(c); }
      return { day: d.day, dow: d.dow, orders: d.orders, total: c, cum };
    });
    const s = await getSettings();
    const shape = buildDayShape(rows, {
      lookbackDays: lookback,
      minDowDays: Number(s.shapeMinDowDays) || INTRADAY_DEFAULTS.shapeMinDowDays,
    });
    shapeCache = { at: Date.now(), shape };
    return shape;
  }

  /* ── ترباس الدخل المكتسب ────────────────────────────────────────────────
     بيرجّع أعلى دخل شفناه في يوم المطعم ده. الكتابة upsert بـ GREATEST عشان
     تفضل صح حتى لو دورتين اشتغلوا في نفس اللحظة. مرتجع على الكاشير بينزّل
     الرقم الجاي من ts_orders — الترباس بيمنع السقف إنه ينزل معاه.
     ملاحظة: ده مش تجاهل للمرتجع. اليوم اللي بعده بيدخل في متوسط الـ ٧ أيام
     بقيمته الحقيقية، والتسوية آخر اليوم بتحسب على الرقم النهائي مش على
     الترباس — فالمرتجع بيتحاسب، بس مش بقطع ميزانية اتصرفت خلاص.           */
  async function earnedWaterMark(bizDay, revenueSoFar) {
    const rev = Math.max(0, Number(revenueSoFar) || 0);
    try {
      const r = await pool.query(
        `INSERT INTO ap_earned (biz_day, high_water, updated_at) VALUES ($1::date, $2, NOW())
         ON CONFLICT (biz_day) DO UPDATE
           SET high_water = GREATEST(ap_earned.high_water, EXCLUDED.high_water), updated_at = NOW()
         RETURNING high_water`, [bizDay, rev]);
      return Number(r.rows[0]?.high_water) || rev;
    } catch (e) {
      // الجدول لسه ما اتعملش أو القاعدة مش رادّة — الرقم الحيّ أأمن من صفر
      console.error("[autopilot] earned water mark failed:", e.message);
      return rev;
    }
  }

  /* المتصل يقدر يبعت النبض لو هو قاراه أصلاً (عشان ما نقراهوش مرتين)، وإلا
     بنقراه إحنا. مهم إن كل اللي بيصرف فلوس يشوف *نفس* السقف: لو الجولة
     البطيئة اشتغلت على سقف المتوسط والإيقاع على السقف المكتسب، اليوم الشغّال
     كان هيتفتح من ناحية ويتقفل من التانية. `pulse: false` بيقفل القراءة. */
  async function settingsNow({ pacePct = null, base = null, pulse = null } = {}) {
    const s = base || await getSettings();
    if (pulse === null && s.liveCeiling !== false && s.moveCeilingWithSales !== false) {
      try { pulse = await pulseData(); } catch { pulse = false; }
    }
    if (s.moveCeilingWithSales === false) {
      return { ...s, ceiling: { ceiling: s.maxTotalBudget, source: "manual", trailing7Avg: null,
        reason: `سقف يدوي ثابت ${ar(s.maxTotalBudget)} ر.س/يوم — قاعدة الـ ٢٠٪ متقفولة من الإعدادات.` } };
    }
    let trailing = { avg: null, days: 0 };
    try { trailing = await trailingDailySales(7); } catch { /* المبيعات مش مقروءة → fallback */ }

    /* ── المكتسب: الرقم الوحيد اللي بيحرّك فلوس ────────────────────────
       دخل النهارده لحد دلوقتي، مع الترباس. من غير نبض مبنعرفش الدخل، فبنسيب
       السقف على الأرضية — أأمن من إننا نخمّن.                              */
    let earned = null;
    if (s.earnedCeiling !== false && pulse && pulse.today) {
      const rev = Number(pulse.today.revenue) || 0;
      earned = { revenueSoFar: rev, highWater: await earnedWaterMark(pulse.day, rev) };
    }

    /* ── التوقّع: إشارة عرض بس ─────────────────────────────────────────
       بيتحسب عشان الشاشة تقول «اليوم رايح على كام»، ومبيدخلش في حسبة السقف
       خالص. خطأه الساعة ٥ العصر ٥١٪، وقاعدة المالك مربوطة بفلوس في الدرج. */
    let projection = null;
    if (s.showOutlook !== false && pulse && pulse.today) {
      try {
        projection = projectDayRevenue({
          shape: await dayShape(),
          dow: pulse.dow, elapsedH: pulse.elapsedH,
          revSoFar: pulse.today.revenue, ordersSoFar: pulse.today.orders,
          trailingAvg: trailing.avg,
          minSharePct: s.projMinSharePct ?? INTRADAY_DEFAULTS.projMinSharePct,
          minOrders: s.projMinOrders ?? INTRADAY_DEFAULTS.projMinOrders,
        });
      } catch (e) { projection = null; console.error("[autopilot] outlook failed:", e.message); }
    }

    const ceiling = movingCeiling({
      trailing7Avg: trailing.avg,
      sharePct: s.adsShareOfSalesPct,
      hardMax: Math.min(Number(s.absoluteMaxTotalBudget) || ECON_DEFAULTS.absoluteMaxTotalBudget, MAX_DAILY_BUDGET),
      floor: s.minTotalBudget,
      fallback: s.maxTotalBudget,
      floorPct: s.earnedFloorPct ?? INTRADAY_DEFAULTS.earnedFloorPct,
      earned, projection,
    });
    return { ...s, maxTotalBudget: ceiling.ceiling, ceiling: { ...ceiling, sampleDays: trailing.days } };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     نبض المبيعات — الإشارة اللي المنصات مش بتديهالنا

     كل الأرقام هنا بتوقيت الرياض وبقاعدة يوم المطعم (بيلف ٤ فجراً)، نفس
     اللي analytics.js شغالة بيه بالظبط. المقارنة بتتقص عند نفس عدد الساعات
     اللي عدّت النهارده — لإن مقارنة يوم نص خلصان بيوم كامل بتقول "المبيعات
     وقعت" كل يوم بعد الضهر.
     ═══════════════════════════════════════════════════════════════════════ */

  const SALES_ONLY_SQL = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;
  const BIZ_TS_SQL = `((o.order_date AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')`;
  const BIZ_ELAPSED_SQL = `(extract(epoch from (${BIZ_TS_SQL} - ${BIZ_TS_SQL}::date::timestamp)) / 3600.0)`;
  const LOCAL_HOUR_SQL = `(extract(hour from (o.order_date AT TIME ZONE '${RIYADH_TZ}'))::int)`;
  const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || "").slice(0, 10));

  async function bizNow() {
    const r = await pool.query(
      `SELECT ((now() AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date AS day,
              extract(epoch from (
                ((now() AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')
                - ((now() AT TIME ZONE '${RIYADH_TZ}') - interval '${BIZ_DAY_START_HOUR} hours')::date::timestamp
              )) / 3600.0 AS elapsed_h,
              extract(hour from (now() AT TIME ZONE '${RIYADH_TZ}'))::int AS riyadh_hour,
              extract(minute from (now() AT TIME ZONE '${RIYADH_TZ}'))::int AS riyadh_minute`);
    return {
      day: isoDay(r.rows[0].day),
      elapsedH: Math.min(24, Math.max(0, Number(r.rows[0].elapsed_h) || 0)),
      riyadhHour: Number(r.rows[0].riyadh_hour) || 0,
      riyadhMinute: Number(r.rows[0].riyadh_minute) || 0,
    };
  }

  /* دليلنا إحنا على إن الإعلان بيجيب ناس: كود عرض اتنطق على الكاشير، أو طلب
     اتطابق برقم جوال مع lead من الفنل. الاتنين مستقلين تماماً عن أي رقم
     بترجّعه المنصة — وده بالظبط سبب وجودهم. */
  async function confirmedToday(day) {
    const out = { redemptions: 0, linkedOrders: 0 };
    try {
      const r = await pool.query(
        `SELECT (SELECT count(*)::int FROM promo_redemptions WHERE day = $1::date) AS redemptions`, [day]);
      out.redemptions = Number(r.rows[0]?.redemptions) || 0;
    } catch { /* promo مش متسطّب في النسخة دي — صفر مش كذب هنا */ }
    try {
      const r = await pool.query(
        `SELECT count(DISTINCT l.order_id)::int AS n
           FROM attrib_links l JOIN ts_orders o ON o.order_id = l.order_id
          WHERE o.calendar_day = $1::date`, [day]);
      out.linkedOrders = Number(r.rows[0]?.n) || 0;
    } catch { /* نفس الكلام */ }
    return out;
  }

  async function pulseData() {
    const { day, elapsedH, riyadhHour, riyadhMinute } = await bizNow();

    // النهارده + نفس يوم الأسبوع في آخر ٤ أسابيع، كلهم مقصوصين عند elapsedH.
    const per = (await pool.query(
      `WITH scoped AS (
         SELECT o.calendar_day, o.total, ${BIZ_ELAPSED_SQL} AS eh
           FROM ts_orders o
          WHERE o.calendar_day = ANY (ARRAY[$1::date, $1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28])
            AND ${SALES_ONLY_SQL}
       )
       SELECT calendar_day AS day, count(*)::int AS orders, COALESCE(sum(total),0) AS revenue
         FROM scoped WHERE eh <= $2::numeric GROUP BY 1`,
      [day, elapsedH])).rows;
    const byDay = new Map(per.map((r) => [isoDay(r.day), r]));
    const get = (iso) => byDay.get(iso) || { orders: 0, revenue: 0 };

    /* "اشتغل اليوم ده" = فيه طلبات في اليوم كله، مش في الشباك المقصوص. يوم
       مقفول (عطلة، عطل في الكاشير، الكاش لسه مش راجع لحد هناك) لو اتحسب
       كصفر هيخلي خط الأساس واطي ويخلينا نسرّع على وهم. */
    const operated = new Set((await pool.query(
      `SELECT DISTINCT o.calendar_day AS day FROM ts_orders o
        WHERE o.calendar_day = ANY (ARRAY[$1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28])
          AND ${SALES_ONLY_SQL}`, [day])).rows.map((r) => isoDay(r.day)));

    const shift = (iso, n) => {
      const d = new Date(iso + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const DOW = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    const comparables = [7, 14, 21, 28].map((n) => {
      const iso = shift(day, -n);
      const row = get(iso);
      return {
        day: iso, weeksAgo: n / 7, dow: DOW[new Date(iso + "T00:00:00Z").getUTCDay()],
        orders: Number(row.orders) || 0, revenue: Number(row.revenue) || 0,
        operated: operated.has(iso),
      };
    });

    const today = get(day);
    const pulse = shapePulse({
      day, elapsedH, riyadhHour, riyadhMinute,
      today: { orders: Number(today.orders) || 0, revenue: Number(today.revenue) || 0 },
      comparables,
    });

    // ساعة بساعة: النهارده مقابل متوسط نفس الساعة في أيام المقارنة الشغالة.
    const hourRows = (await pool.query(
      `SELECT ${LOCAL_HOUR_SQL} AS hour,
              count(*) FILTER (WHERE o.calendar_day = $1::date)::int AS today_orders,
              COALESCE(sum(o.total) FILTER (WHERE o.calendar_day = $1::date),0) AS today_revenue,
              count(*) FILTER (WHERE o.calendar_day <> $1::date)::int AS base_orders,
              COALESCE(sum(o.total) FILTER (WHERE o.calendar_day <> $1::date),0) AS base_revenue
         FROM ts_orders o
        WHERE o.calendar_day = ANY (ARRAY[$1::date, $1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28])
          AND ${SALES_ONLY_SQL}
        GROUP BY 1`, [day])).rows;
    const hourMap = new Map(hourRows.map((r) => [Number(r.hour), r]));
    const baseDays = comparables.filter((c) => c.operated).length;
    const hourly = [];
    for (let i = 0; i < 24; i++) {
      const h = (BIZ_DAY_START_HOUR + i) % 24;             // بنعرض بترتيب يوم المطعم: ٤ص → ٣ص
      const row = hourMap.get(h) || {};
      hourly.push({
        hour: h, offset: i, elapsed: i < elapsedH,
        orders: Number(row.today_orders) || 0,
        revenue: Math.round((Number(row.today_revenue) || 0) * 100) / 100,
        baselineOrders: baseDays ? Math.round(((Number(row.base_orders) || 0) / baseDays) * 10) / 10 : null,
        baselineRevenue: baseDays ? Math.round(((Number(row.base_revenue) || 0) / baseDays) * 100) / 100 : null,
      });
    }

    const now = new Date();
    return {
      ...pulse,
      hourly,
      confirmed: await confirmedToday(day),
      clock: {
        riyadh: `${String(tzClock(now, RIYADH_TZ).hour).padStart(2, "0")}:${String(tzClock(now, RIYADH_TZ).minute).padStart(2, "0")}`,
        businessDay: day,
        businessDayStartsAt: `${String(BIZ_DAY_START_HOUR).padStart(2, "0")}:00 ${RIYADH_TZ}`,
        accountDay: accountDayOf(now),
        accountTz: ADS_ACCOUNT_TZ,
        minutesToAccountRoll: Math.round(msToAccountRoll(now) / 60000),
        note: `يوم الحساب الإعلاني بيلف الساعة ٠٠:٠٠ بتوقيت ${ADS_ACCOUNT_TZ} — اللي هي حوالي ١٠ صباحاً بتوقيت جدة، مش نص الليل. الاسترجاع بيتعلّق بالتوقيت ده.`,
      },
    };
  }

  /* ── سباق الرقم القياسي ──────────────────────────────────────────────────
     المالك واقف في المطعم وعايز يعرف حاجة واحدة: إحنا هنكسر الرقم ولا لأ؟

     بنجاوب بمقياسين مختلفين عن قصد، عشان محدش يخلط بينهم:
       • «لحد دلوقتي» — دخل النهارده مقابل *نفس الساعة* من أحسن يوم زي
         النهارده. الاتنين مقصوصين عند نفس elapsedH، فالمقارنة أمينة:
         مبنقارنش يوم لسه في نصه بيوم كامل.
       • «الترشيح لآخر اليوم» — التوقّع مقابل الرقم القياسي الكامل. ده اللي
         بيدّي كلمة «متقدّم/متأخّر»، وبيتقال إنه توقّع مش فلوس في الدرج.

     الرقمين القياسيين (أحسن يوم على الإطلاق، وأحسن يوم بنفس اسم اليوم)
     بيتقروا من قاعدة البيانات مش مكتوبين في الكود — أول ما الرقم يتكسر
     بكرة يبقى هو الأساس الجديد من غير ما حد يعدّل سطر واحد.               */
  async function recordWatch({ day, elapsedH, today, projected }) {
    const rows = (await pool.query(
      `WITH scoped AS (
         SELECT o.calendar_day AS day, o.total, ${BIZ_ELAPSED_SQL} AS eh
           FROM ts_orders o
          WHERE o.calendar_day < $1::date AND ${SALES_ONLY_SQL}
       )
       SELECT day,
              count(*)::int AS orders,
              COALESCE(sum(total),0) AS revenue,
              count(*) FILTER (WHERE eh <= $2::numeric)::int AS orders_sofar,
              COALESCE(sum(total) FILTER (WHERE eh <= $2::numeric),0) AS revenue_sofar
         FROM scoped GROUP BY 1`,
      [day, elapsedH])).rows.map((r) => ({
        day: isoDay(r.day),
        dow: new Date(isoDay(r.day) + "T00:00:00Z").getUTCDay(),
        orders: Number(r.orders) || 0,
        revenue: r2(Number(r.revenue) || 0),
        ordersSoFar: Number(r.orders_sofar) || 0,
        revenueSoFar: r2(Number(r.revenue_sofar) || 0),
      }));
    if (!rows.length) return null;

    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    const best = (list) => list.reduce((a, b) => (b.revenue > a.revenue ? b : a));
    const allTime = best(rows);
    const sameDowRows = rows.filter((r) => r.dow === dow);
    const dowRecord = sameDowRows.length ? best(sameDowRows) : null;

    /* المقارنة الأمينة: نفس الساعة من أحسن يوم زي النهارده. لو مفيش يوم
       زيه خالص بنقع على الرقم القياسي العام بدل ما نرجّع null ونسيب
       الشاشة فاضية. */
    const pacer = dowRecord || allTime;
    const pacerIsSameDow = pacer.dow === dow;
    const aheadNow = today.revenue - pacer.revenueSoFar;

    /* الترتيب مهم: بنتحقق من الأصعب للأسهل عشان اليوم اللي هيكسر الاتنين
       يتقال عليه «قياسي» مش «أحسن جمعة». */
    const p = Number(projected) || 0;
    let tone, verdict;
    if (p >= allTime.revenue) {
      tone = "record"; verdict = "مترشّح لرقم قياسي في تاريخ المطعم";
    } else if (dowRecord && p >= dowRecord.revenue) {
      tone = "good"; verdict = `مترشّح لأحسن ${DOW_AR[dow]} على الإطلاق`;
    } else if (dowRecord && p >= dowRecord.revenue * 0.9) {
      tone = "ok"; verdict = `على بُعد خطوة من أحسن ${DOW_AR[dow]}`;
    } else {
      tone = "warn"; verdict = `أقل من أحسن ${DOW_AR[dow]}`;
    }

    const sign = (n) => (n >= 0 ? "+" : "−");
    return {
      dow, dowLabel: DOW_AR[dow], tone, verdict,
      allTime: { day: allTime.day, revenue: allTime.revenue, orders: allTime.orders },
      dowRecord: dowRecord
        ? { day: dowRecord.day, revenue: dowRecord.revenue, orders: dowRecord.orders }
        : null,
      pacer: {
        day: pacer.day, revenueSoFar: pacer.revenueSoFar, ordersSoFar: pacer.ordersSoFar,
        isSameDow: pacerIsSameDow,
      },
      aheadNow: r2(aheadNow),
      aheadNowPct: pacer.revenueSoFar > 0
        ? Math.round((today.revenue / pacer.revenueSoFar - 1) * 1000) / 10 : null,
      projected: p || null,
      /* السطر اللي يتقرا في خمس ثواني وحد واقف. */
      line: `${ar(today.revenue)} ر.س من ${ar(today.orders)} طلب — ` +
        `${sign(aheadNow)}${ar(Math.abs(r2(aheadNow)))} ر.س عن أحسن ${pacerIsSameDow ? DOW_AR[dow] : "يوم"} في نفس الساعة` +
        `${p ? ` · الترشيح لآخر اليوم ${ar(r2(p))} ر.س` : ""}`,
      note: `الرقم القياسي العام ${ar(allTime.revenue)} ر.س (${allTime.day})` +
        `${dowRecord ? ` · أحسن ${DOW_AR[dow]} ${ar(dowRecord.revenue)} ر.س (${dowRecord.day})` : ""}` +
        ` — المقارنة «لحد دلوقتي» مقصوصة عند نفس الساعة من اليومين، والترشيح توقّع مش فلوس دخلت.`,
    };
  }

  /* الزيادات المفتوحة (اللي لسه ماترجعتش) — دي حالة الإيقاع كلها. */
  async function pacingState() {
    const r = await pool.query(
      `SELECT platform, campaign_id, campaign_name, account_day::text AS account_day,
              base_budget, current_budget, steps, last_action_at,
              COALESCE(level,'campaign') AS level, parent_id
         FROM ap_pacing WHERE restored_at IS NULL`);
    const m = new Map();
    for (const x of r.rows) {
      const e = {
        platform: x.platform, campaignId: x.campaign_id, campaignName: x.campaign_name,
        level: x.level || "campaign", parentId: x.parent_id || null,
        accountDay: isoDay(x.account_day),
        baseBudget: Number(x.base_budget), currentBudget: Number(x.current_budget),
        steps: Number(x.steps) || 0, lastActionAt: new Date(x.last_action_at).getTime(),
      };
      /* بالمفتاح الجديد (فيه المستوى) وبالقديم كمان — عشان أي زيادة اتسجّلت
         قبل عمود `level` تفضل تترجع عادي بدل ما تتوه ويبقى فيه فلوس شغّالة
         محدش بيرجّعها. */
      m.set(`${x.platform}:${e.level}:${x.campaign_id}`, e);
      m.set(`${x.platform}:${x.campaign_id}`, e);
    }
    return m;
  }

  /* الحملات اللي وقفناها عشان المطعم قافل ولسه ما شغّلناهاش. */
  async function daypartBook() {
    const r = await pool.query(
      `SELECT platform, campaign_id, campaign_name, biz_day::text AS biz_day, base_budget, paused_at
         FROM ap_daypart WHERE resumed_at IS NULL`);
    const m = new Map();
    for (const x of r.rows) {
      m.set(`${x.platform}:${x.campaign_id}`, {
        platform: x.platform, campaignId: x.campaign_id, campaignName: x.campaign_name,
        bizDay: isoDay(x.biz_day),
        baseBudget: x.base_budget == null ? null : Number(x.base_budget),
        pausedAt: x.paused_at,
      });
    }
    return m;
  }

  /* ── facts: campaigns × insights × real sales ─────────────────────────── */
  async function gatherFacts(s) {
    const today = todayISO();
    const d3 = daysAgoISO(2), d7 = daysAgoISO(6);
    const rows = [];
    const reasons = {};
    for (const p of PLATFORMS) {
      /* جوجل كان مستثنى بالاسم هنا لإن الأدابتر بتاعه كان قشرة فاضية. بقى
         أدابتر كامل (google.js) فالاستثناء اتشال — ولو مش مربوط بيقع في نفس
         سطر canManage تحت زي أي منصة تانية بنفس رسالة «ناقص كذا». */
      if (s.platforms && s.platforms[p.id] === false) continue;
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ")}`; continue; }
      /* تلات نداءات قراءة للمنصة الواحدة. لو بابها مقفول دي تلاتة بتتاكل من
         نفس الحصة اللي أمر الإيقاف مستنيها — والجولة البطيئة بتاخد قرارات
         على أرقام، فأرقام ناقصة أحسن من إيقاف مايعديش. */
      const shut = readGate(p.id, "telemetry");
      if (shut) { reasons[p.id] = shut.error; continue; }
      try {
        const [camps, i3, i7, ads] = await Promise.all([
          p.campaigns(),
          p.insights({ from: d3, to: today }),
          p.insights({ from: d7, to: today }),
          /* الميزانيات على مستوى المجموعة الإعلانية. مش كل أدابتر بيوفّرها؛
             اللي مبيوفّرهاش بترجع {} والحملة بتتحسب بصفر زي الأول. */
          typeof p.adsetBudgets === "function" ? p.adsetBudgets().catch(() => ({ ok: false, byCampaign: {} }))
            : Promise.resolve({ ok: false, byCampaign: {} }),
        ]);
        if (!camps.ok) { reasons[p.id] = camps.reason; continue; }
        const m3 = new Map((i3.ok ? i3.rows : []).map((x) => [String(x.campaignId), x]));
        const m7 = new Map((i7.ok ? i7.rows : []).map((x) => [String(x.campaignId), x]));
        const adsetBy = (ads && ads.ok ? ads.byCampaign : null) || {};
        for (const c of camps.campaigns) {
          const a = m3.get(String(c.id)), b = m7.get(String(c.id));
          const started = c.startTime ? new Date(c.startTime) : null;
          rows.push({
            platform: p.id, id: String(c.id), name: c.name, status: c.status,
            effectiveStatus: c.effectiveStatus || null,
            /* الهدف بيقرّر إيه هي «النتيجة» — من غيره قاعدة القتل بتحكم
               على حملة نقرات بعدّاد تحويلات. شوف resultModelOf. */
            objective: c.objective || null,
            dailyBudget: c.dailyBudget,
            /* مش بندبرها — بنعدّها في السقف الكلي وبس. */
            adsetBudget: c.dailyBudget == null ? (adsetBy[String(c.id)] ?? null) : null,
            ageDays: started && !isNaN(started) ? Math.floor((Date.now() - started.getTime()) / 86400000) : null,
            /* `?? null` مش `|| 0`: فرق «المنصة قالت صفر» عن «المنصة ما
               ردّتش بحاجة نعرف نقراها» هو اللي قاعدة القتل واقفة عليه. */
            w3: { spend: a?.spend || 0, results: a?.results ?? null, revenue: a?.resultValue || 0,
                  clicks: a?.clicks ?? null },
            w7: { spend: b?.spend || 0, results: b?.results ?? null, revenue: b?.resultValue || 0,
                  clicks: b?.clicks ?? null },
            /* يوم الحساب الإعلاني بيلف بتوقيت America/Los_Angeles، يعني
               قبل ما يلف الأرقام لسه بتتحرك — وقرار الإيقاف مالوش رجعة.
               شوف قاعدة `settling` في decide(). */
            settling: numbersSettling(new Date(), s),
          });
        }
      } catch (e) { reasons[p.id] = String(e.message || e); }
    }

    // Real sales — the goal tracker and the LLM's grounding.
    const sales = await pool.query(
      `SELECT calendar_day::text AS day, count(*)::int AS orders, COALESCE(sum(total),0) AS revenue
         FROM ts_orders
        WHERE calendar_day >= $1::date
          AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))
        GROUP BY 1 ORDER BY 1`, [d7]);
    const days = sales.rows;
    const avgDaily = days.length ? days.reduce((a, r) => a + Number(r.revenue), 0) / days.length : 0;

    // Attributed source mix (cashier + auto tagging) for the same window.
    const sources = await pool.query(
      `SELECT COALESCE(NULLIF(s.source,''),'unknown') AS source,
              count(*)::int AS orders, COALESCE(sum(o.total),0) AS revenue
         FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
        WHERE o.calendar_day >= $1::date
        GROUP BY 1 ORDER BY revenue DESC LIMIT 12`, [d7]);

    return {
      campaigns: rows, reasons,
      sales: { days, avgDaily: Math.round(avgDaily), goal: s.goalDailySales,
               progressPct: s.goalDailySales > 0 ? Math.round((avgDaily / s.goalDailySales) * 100) : null },
      sources: sources.rows,
    };
  }

  /* «اترفض» و«ما اتبعتش» مش نفس الحاجة. الأمر اللي الباب المقفول منعه من
     إنه يخرج أصلاً مش رفض من المنصة — لو سجّلناه رفض هنعدّ ٣٦٤ رفض والمنصة
     ماشافتش منهم غير أربعة، وإنذار «المنصة بترفض أوامرنا» يبقى بيعدّ سكوتنا
     إحنا. status='deferred' بيفصل الاتنين: العدّاد بيقول الحقيقة، والإنذار
     بيتكلّم عن رفض حقيقي بس. الأمر المؤجّل بيترجع لوحده الدورة الجاية. */
  const statusOf = (res) => (res.ok ? "auto_executed" : res.gated ? "deferred" : "failed");

  /* الدعوى بتتسجّل ساعة ما الكتابة تنجح — يعني ساعة ما نبدأ *نفتكر* حاجة.
     مبتتقفلش من ردّ المنصة على نفس النداء، بتتقفل من قراءة مستقلة بعد كده
     (settleClaims جوّه verifyDaypart). قيد واحد مفتوح لكل حملة+حقل: أمر
     أحدث بيلغي اللي قبله، فمابنطاردش نية قديمة اتغيّرت. */
  async function recordClaim({ platform, campaignId, campaignName, field, expected, decisionId = null }) {
    if (!platform || !campaignId || expected == null) return;
    await pool.query(
      `UPDATE ap_claims SET settled_at=NOW(), verdict='superseded'
        WHERE platform=$1 AND campaign_id=$2 AND field=$3 AND settled_at IS NULL`,
      [platform, String(campaignId), field]).catch(() => {});
    await pool.query(
      `INSERT INTO ap_claims (id, platform, campaign_id, campaign_name, field, expected, decision_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), platform, String(campaignId), campaignName || null,
       field, String(expected), decisionId]).catch(() => {});
  }

  /* ── execution of a single decision (shared by auto mode and approvals) ── */
  async function executeDecision(dec, s) {
    const p = byId(dec.platform);
    if (!p) return { ok: false, error: `unknown platform ${dec.platform}` };
    if (!canManage(p)) return { ok: false, error: `platform not configured — missing ${missingOf(p.manageEnv).join(", ")}` };
    if (!writeAllowed()) return { ok: false, error: "ADS_ALLOW_WRITE is not '1' — writes are locked" };

    let call;
    if (dec.kind === "pause") call = p.stateCall(dec.campaign_id, "PAUSED");
    else if (dec.kind === "resume") call = p.stateCall(dec.campaign_id, "ACTIVE");
    // `pace` هو تغيير ميزانية جوّه اليوم — نفس النداء بالظبط، الفرق في
    // السبب وفي الدفتر اللي بيتسجّل فيه، مش في الحاجة اللي بتتبعت للمنصة.
    else if (dec.kind === "budget" || dec.kind === "pace") {
      const to = Number(dec.detail?.to);
      if (!Number.isFinite(to) || to <= 0) return { ok: false, error: "budget decision has no target amount" };
      if (to > Math.min(s.maxCampaignBudget, MAX_DAILY_BUDGET)) {
        return { ok: false, error: `target ${to} exceeds maxCampaignBudget (${s.maxCampaignBudget})` };
      }
      call = p.budgetCall(dec.campaign_id, to);
    } else return { ok: false, error: `kind ${dec.kind} is not executable` };

    /* نفس المسار اللي أزرار اللوحة بتمشي فيه (ads.sendPlatformWrite): بيحطّ
       التوكن، وفي حالة جوجل بيحلّ مورد الميزانية وفي حالة سناب بيقرا الحملة
       عشان الـ PUT بتاعها استبدال كامل مش تعديل جزئي. وبيقفل باب المنصة لو
       ردّت بإننا تخطينا حد النداءات — إعادة المحاولة كل ٥ دقايق على حد
       متخطّي هي اللي بتاكل الحد اللي محتاجينه أصلاً عشان نوقف الحملة. */
    const r = await sendPlatformWrite(p, call);
    /* من هنا وطالع إحنا "فاكرين" إن حاجة اتغيّرت على المنصة. الدعوى بتتكتب
       دلوقتي عشان القراءة الجاية تقفلها أو تكشفها — من غيرها الاعتقاد ده
       عمره ما بيتقاس بالواقع. */
    if (r.ok) {
      const field = dec.kind === "budget" || dec.kind === "pace" ? "budget" : "status";
      await recordClaim({
        platform: p.id, campaignId: dec.campaign_id, campaignName: dec.campaign_name || null,
        field,
        expected: field === "budget" ? Number(dec.detail?.to) : (dec.kind === "pause" ? "PAUSED" : "ACTIVE"),
        decisionId: dec.id || null,
      });
    }
    return r.ok
      ? { ok: true, httpStatus: r.httpStatus, platform: redact(r.raw ?? null) }
      : {
          ok: false, httpStatus: r.httpStatus ?? null, error: r.error,
          failureKind: r.kind || null,
          ...(r.gated ? { gated: true } : {}),
          ...(r.retryInMinutes ? { retryInMinutes: r.retryInMinutes } : {}),
          ...(r.accessTier ? { accessTier: r.accessTier } : {}),
          platform: redact(r.raw ?? null),
        };
  }

  /* ── LLM strategist — creative briefs and offers, grounded in the facts ── */
  const STRATEGIST_TOOL = {
    name: "submit_ads_strategy",
    description: "سلّم خطة الإعلانات والكرياتيف بصيغة منظمة.",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "تقييم الوضع الحالي في ٣-٤ جمل مبنية على الأرقام" },
        creatives: {
          type: "array", maxItems: 6,
          items: {
            type: "object",
            properties: {
              platform: { type: "string", enum: ["tiktok", "meta", "snapchat"] },
              hook: { type: "string", description: "أول ٣ ثواني من الفيديو — الجملة/المشهد" },
              script: { type: "string", description: "سكريبت الإعلان كامل (١٥-٣٠ ثانية)" },
              cta: { type: "string" },
              why: { type: "string", description: "ليه الكرياتيف ده — مربوط برقم من البيانات" },
            },
            required: ["platform", "hook", "script", "cta", "why"],
          },
        },
        offers: {
          type: "array", maxItems: 4,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              mechanics: { type: "string", description: "تفاصيل العرض بالضبط" },
              audience: { type: "string", description: "لمين — جمهور جديد / ريتارجيت / عملاء نايمين" },
              why: { type: "string" },
            },
            required: ["title", "mechanics", "audience", "why"],
          },
        },
        nextSteps: { type: "array", maxItems: 5, items: { type: "string" } },
      },
      required: ["summary", "creatives", "offers", "nextSteps"],
    },
  };

  const STRATEGIST_SYSTEM = `أنت مدير إعلانات مطعم "فريش كتس" في جدة (برجر وستيك، السوق سعودي، العملة ريال).
هدف المطعم المعلن: الوصول للمبيعات اليومية المذكورة في goalDailySales داخل البيانات.
قواعد صارمة:
1. كل توصية لازم تكون مبنية على رقم حقيقي من البيانات المرفقة — ممنوع اختراع أرقام.
2. الكرياتيف لازم يكون قابل للتصوير بموبايل داخل المطعم (مفيش إنتاج ضخم).
3. العروض لازم تكون قابلة للتنفيذ في نظام الكاشير (خصم نسبة/مبلغ أو وجبة مجمعة).
4. اتكلم عربي واضح بلهجة بيزنس مباشرة.`;

  async function runStrategist(facts, decisions, s) {
    /* المستشار هو النداء الاستراتيجي الوحيد — كرياتيف وعروض — فبياخد
       الموديل الكبير. وهو بينده مرة في اليوم دلوقتي مش ٢٤–٤٦ مرة، فالتمن
       الأعلى للنداء الواحد بيفضل أرخص بكتير من اللي كان. */
    const provider = llmProvider({ tier: "smart" });
    if (!provider || !s.useLlm) return null;
    /* الحملات اللي مصرفتش ولا ريال مالهاش رأي في خطة كرياتيف — بتاكل توكنز
       وبس. والباقي بيتقال بالعدد بدل ما يتعدّد صف صف. */
    const live = facts.campaigns.filter((c) => c.status === "ACTIVE" || Number(c.w7?.spend) > 0);
    const compact = {
      goalDailySales: s.goalDailySales,
      salesLast7d: facts.sales,
      sourceMix7d: facts.sources,
      campaigns: live.map((c) => ({
        platform: c.platform, name: c.name, status: c.status, dailyBudget: c.dailyBudget,
        objective: c.objective || null,
        /* ملخّص مش كومة: الصرف والنتايج وتكلفة النتيجة — ده اللي بيتبني
           عليه قرار كرياتيف، والباقي كان بيتبعت من غير ما حد يقراه. */
        d7: { spend: r2(c.w7?.spend || 0), results: c.w7?.results ?? null,
              cpa: c.w7?.results > 0 ? r2(c.w7.spend / c.w7.results) : null },
        d3: { spend: r2(c.w3?.spend || 0), results: c.w3?.results ?? null,
              cpa: c.w3?.results > 0 ? r2(c.w3.spend / c.w3.results) : null },
      })),
      idleCampaigns: facts.campaigns.length - live.length,
      platformIssues: facts.reasons,
      ruleDecisions: decisions.filter((d) => d.kind !== "note")
        .map((d) => ({ kind: d.kind, campaign: d.campaignName })),
      targets: { cpa: s.targetCpa, roas: s.targetRoas },
    };
    return llmTool(provider, {
      system: STRATEGIST_SYSTEM,
      user: `دي البيانات الحقيقية (JSON):\n\n${JSON.stringify(compact)}\n\nحلّل الوضع واطلع: كرياتيفات جديدة للمنصات اللي محتاجة، عروض مقترحة، وخطوات الأسبوع الجاي. استخدم أداة submit_ads_strategy.`,
      tool: STRATEGIST_TOOL,
      purpose: "strategy",
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     الوكيل — LLM بأدوات حقيقية، محبوس جوه نفس الأسوار

     الفرق بينه وبين المستشار (runStrategist) إنه بيشوف ويعمل، مش بس بيقترح:
     بيسأل عن الأرقام بأدوات قراءة، وبيقدر يوقف حملة أو يغيّر ميزانية.

     كل أداة كتابة بتعدي على نفس الأسوار اللي القواعد الصمّاء بتعدي عليها:
       writeAllowed() · maxCampaignBudget · maxChangePct · maxTotalBudget ·
       budgetCooldownHours · وقاعدة القتل (مايوقفش حملة كاسبة).
     الوكيل ميقدرش يعدّيها. لو حاول، الأداة بترجّعله رفض مكتوب بالسبب،
     والرفض نفسه بيتسجّل في ap_decisions عشان المالك يشوف الوكيل حاول يعمل
     إيه — مش بس اللي نفّذه.

     في mode=suggest الأدوات مش بتنفّذ: بتحط القرار في طابور الموافقة وبتقول
     للموديل كده صراحة، فهو ميفتكرش إن الحاجة اتعملت.
     ═══════════════════════════════════════════════════════════════════════ */

  async function budgetCooldownSet(s) {
    const cd = await pool.query(
      `SELECT DISTINCT platform, campaign_id FROM ap_decisions
        WHERE kind='budget' AND status IN ('executed','auto_executed')
          AND executed_at > NOW() - ($1 || ' hours')::interval`,
      [String(Number(s.budgetCooldownHours) || 24)]);
    const set = new Set(cd.rows.map((r) => `${r.platform}:${r.campaign_id}`));
    /* حملة عليها زيادة إيقاع مفتوحة = الميزانية اللي الجولة البطيئة شايفاها
       مش ميزانية المالك، دي ميزانية مؤقتة هترجع خلال ساعات. لو الجولة
       البطيئة بنت عليها قرار هتضاعف الزيادة (أو تقفل عليها) وهي مش بتعرف
       ده أصلاً. فبتستنى لحد ما الإيقاع يرجّع الأصل. */
    try {
      const open = await pool.query(
        `SELECT DISTINCT platform, campaign_id FROM ap_pacing WHERE restored_at IS NULL`);
      for (const r of open.rows) set.add(`${r.platform}:${r.campaign_id}`);
    } catch { /* الجدول لسه ما اتعملش — مفيش زيادات مفتوحة أصلاً */ }
    return set;
  }

  /* لقطة الحملات + أرقام آخر ٣ أيام. بتتاخد مرة في أول الجولة وبتُستعمل في
     كل قرارات الأسوار — عشان ما نضربش المنصات عند كل نداء أداة. */
  /* `priority` هو بيت القصيد في التوقيع ده. القراءة عشان الأرقام "تليمتري"
     وبتتشال أول ما المنصة تتخنق، لإن على حصة ميتا التطويرية الرسم البياني
     وأمر الإيقاف بيشربوا من نفس الكوباية. المالك الواقف قدام الشاشة بيبعت
     "owner" وعمره ما بيتشال — القراءة دي بتحصل مرات في اليوم مش ١٢ مرة في
     الساعة. الشرح الكامل في ads.js/readGate. */
  async function perfSnapshot({ from, to, platform = null, priority = "telemetry" } = {}) {
    const today = todayISO();
    const f = from || daysAgoISO(2), t = to || today;
    const rows = [], reasons = {};
    for (const p of PLATFORMS) {
      if (platform && p.id !== platform) continue;
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ")}`; continue; }
      const shut = readGate(p.id, priority);
      if (shut) { reasons[p.id] = shut.error; continue; }
      try {
        const [camps, ins, ads, aIns, aToday] = await Promise.all([
          p.campaigns(), p.insights({ from: f, to: t }),
          typeof p.adsetBudgets === "function" ? p.adsetBudgets().catch(() => ({ ok: false, byCampaign: {}, rows: [] }))
            : Promise.resolve({ ok: false, byCampaign: {}, rows: [] }),
          /* أرقام المجموعات — محتاجينها عشان نعرف مين بيصرف ميزانيته فعلاً
             (absorptionOf). لو الأدابتر مبيوفّرهاش بنكمّل من غيرها. */
          typeof p.adsetInsights === "function" ? p.adsetInsights({ from: f, to: t }).catch(() => ({ ok: false, rows: [] }))
            : Promise.resolve({ ok: false, rows: [] }),
          /* وصرف **النهارده** لوحده. نداء منفصل عن قصد: نسبة الامتلاء
             بتقارن صرف بميزانية **يومية**، فلو حطينا مجموع شباك ٣ أيام
             جنب ميزانية يوم واحد الرقم بيطلع ٣ أضعاف الحقيقة — ومجموعة
             متخنقة بتبان مليانة وتعدّي البوابة. */
          typeof p.adsetInsights === "function" ? p.adsetInsights({ from: today, to: today }).catch(() => ({ ok: false, rows: [] }))
            : Promise.resolve({ ok: false, rows: [] }),
        ]);
        if (!camps.ok) { reasons[p.id] = camps.reason; continue; }
        if (!ins.ok) reasons[p.id] = ins.reason;
        const m = new Map((ins.ok ? ins.rows : []).map((x) => [String(x.campaignId), x]));
        const adsetBy = (ads && ads.ok ? ads.byCampaign : null) || {};
        const aIn = new Map((aIns && aIns.ok ? aIns.rows : []).map((x) => [String(x.adsetId), x]));
        const aTd = new Map((aToday && aToday.ok ? aToday.rows : []).map((x) => [String(x.adsetId), x]));
        const adsetsByCampaign = {};
        for (const a of (ads && ads.ok ? ads.rows : []) || []) {
          const x = aIn.get(String(a.id));
          const td = aTd.get(String(a.id));
          (adsetsByCampaign[a.campaignId] ||= []).push({
            ...a, spend: x?.spend ?? 0, results: x?.results ?? null,
            /* null = مقدرناش نقرا صرف النهارده (مش صفر). absorptionOf
               بتفرّق بين الاتنين — الصفر بيقفل البوابة والـ null بيسيبها. */
            spendToday: aToday && aToday.ok ? (td?.spend ?? 0) : null,
          });
        }
        for (const c of camps.campaigns) {
          const a = m.get(String(c.id));
          const spend = a?.spend || 0, results = a?.results ?? null, revenue = a?.resultValue || 0;
          rows.push({
            platform: p.id, id: String(c.id), name: c.name, status: c.status,
            objective: c.objective || null,
            dailyBudget: c.dailyBudget,
            adsetBudget: c.dailyBudget == null ? (adsetBy[String(c.id)] ?? null) : null,
            /* المجموعات الإعلانية بتفاصيلها — دي اللي paceTargetsOf بتبني
               عليها أهداف الـ ABO. */
            adsets: adsetsByCampaign[String(c.id)] || [],
            /* قرينا المجموعات فعلاً ولا النداء وقع؟ ميتا بترمي
               «User request limit reached» بسهولة، وساعتها اللستة بترجع
               فاضية — واللستة الفاضية على حملة ABO معناها «ميزانيتها صفر»
               وده كذب بيفتح مساحة تحت السقف مش موجودة. */
            adsetsOk: !!(ads && ads.ok),
            spend, results, revenue,
            /* من إيه اتجمعت النتيجة (نية من الموقع / محادثة / شرا) — عشان
               الشاشة والموديل يقولوا رقم واحد بنفس المعنى. */
            resultBasis: a?.resultBasis || null,
            impressions: a?.impressions || 0, clicks: a?.clicks || 0,
            cpa: results > 0 ? Math.round((spend / results) * 100) / 100 : null,
            roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
          });
        }
      } catch (e) { reasons[p.id] = String(e.message || e); }
    }
    return { range: { from: f, to: t }, rows, reasons };
  }

  /* ── لقطة مضغوطة للموديل ──────────────────────────────────────────────
     `perfSnapshot` بترجّع كل حقل قرأناه من المنصة عشان الأسوار تشتغل
     عليه — وده صح للكود. بس إحنا كنا بنرمي **نفس الكومة دي** للموديل في
     كل دورة محادثة، والنتيجة اتقصّت عند ٢٤٬٠٠٠ حرف. مقاس اللقطة الحقيقي
     كان بين ١٢ و١٨ ألف حرف (قِسناها من /api/ads/campaigns + /adsets)،
     يعني ~٥–٧ آلاف توكن **متكرّرين في كل دورة**.

     الموديل مش محتاج كل ده. محتاج: مين شغّال، بكام، جاب إيه، وبتكلفة كام.
     المجموعات الموقوفة مالهاش لازمة خالص، والحملات اللي مصرفتش ولا ريال
     برضه. اللي بيتشال بيتقال بالعدد في السطر الأخير عشان الموديل يعرف إن
     فيه حاجة اتشالت — مش يفتكر إنها مش موجودة.                            */
  function compactPerf(r) {
    const rows = (r.rows || []).filter((x) => x.status === "ACTIVE" || Number(x.spend) > 0);
    const dropped = (r.rows || []).length - rows.length;
    return {
      range: r.range,
      campaigns: rows.map((x) => {
        const o = {
          p: x.platform, id: x.id, name: x.name, status: x.status,
          budget: x.dailyBudget != null ? x.dailyBudget : (x.adsetBudget ?? null),
          spend: r2(x.spend), results: x.results, cpa: x.cpa, roas: x.roas, clicks: x.clicks,
        };
        if (x.objective) o.objective = x.objective;
        const kids = (x.adsets || []).filter((a) => a.status === "ACTIVE");
        if (kids.length) {
          o.adsets = kids.map((a) => ({
            id: String(a.id), name: a.name, budget: a.dailyBudget ?? null,
            spend: r2(a.spend), results: a.results ?? null,
          }));
        }
        return o;
      }),
      blocked: r.reasons && Object.keys(r.reasons).length ? r.reasons : undefined,
      omitted: dropped > 0
        ? `${dropped} حملة موقوفة ومصرفتش في المدى ده — اتشالت من اللستة عشان توفير، مش لإنها مش موجودة.`
        : undefined,
    };
  }

  /* ── تعريفات الأدوات ──────────────────────────────────────────────────── */
  const AGENT_TOOLS = [
    {
      name: "get_performance",
      description: "أرقام الحملات من المنصات (صرف، نتايج، تكلفة النتيجة، العائد، الميزانية اليومية، الحالة). سيب التواريخ فاضية وهتاخد آخر ٧ أيام تلقائي — ده أأمن من إنك تحزر التاريخ.",
      schema: {
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD — اختياري، الافتراضي آخر ٧ أيام" },
          to: { type: "string", description: "YYYY-MM-DD — اختياري، الافتراضي النهارده" },
          platform: { type: "string", enum: ["meta", "tiktok", "snapchat"], description: "اختياري — منصة واحدة بس" },
        },
      },
    },
    {
      name: "get_attribution",
      description: "مردود كل قناة: صرف ← عملاء محتملين ← طلبات ← إيراد ← عملاء جداد/راجعين، مع درجة ثقة لكل صف (مؤكد/مرجّح/تقديري). ده المصدر الوحيد اللي بيربط الإعلان بمبيعات الكاشير الحقيقية. سيب التواريخ فاضية وهتاخد آخر ٣٠ يوم.",
      schema: {
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD — اختياري، الافتراضي آخر ٣٠ يوم" },
          to: { type: "string", description: "YYYY-MM-DD — اختياري، الافتراضي النهارده" },
        },
      },
    },
    {
      name: "get_sales",
      description: "مبيعات المطعم الحقيقية من نظام الكاشير يوم بيوم، ومقارنتها بهدف المبيعات اليومي. سيب التواريخ فاضية وهتاخد آخر ٧ أيام.",
      schema: {
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD — اختياري، الافتراضي آخر ٧ أيام" },
          to: { type: "string", description: "YYYY-MM-DD — اختياري، الافتراضي النهارده" },
        },
      },
    },
    {
      name: "pause_campaign",
      description: "إيقاف حملة. بيمر على الأسوار — لو الحملة كاسبة أو الكتابة مقفولة هترجعلك رفض بالسبب.",
      schema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["meta", "tiktok", "snapchat"] },
          id: { type: "string", description: "رقم الحملة على المنصة" },
          reason: { type: "string", description: "السبب بالعربي، مبني على رقم من البيانات" },
        },
        required: ["platform", "id", "reason"],
      },
    },
    {
      name: "set_budget",
      description: "تغيير الميزانية اليومية لحملة (بالريال). بيمر على أسوار: سقف الحملة، أقصى نسبة تغيير في الخطوة، السقف الكلي، وفترة التبريد.",
      schema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["meta", "tiktok", "snapchat"] },
          id: { type: "string" },
          amount: { type: "number", description: "الميزانية اليومية الجديدة بالريال" },
          reason: { type: "string", description: "السبب بالعربي، مبني على رقم من البيانات" },
        },
        required: ["platform", "id", "amount", "reason"],
      },
    },
    {
      name: "create_note",
      description: "تسجيل ملاحظة أو توصية للمالك تظهر في لوحة القرارات. استخدمها لأي حاجة انت شايفها مهمة ومش من صلاحياتك تنفّذها.",
      schema: {
        type: "object",
        properties: { text: { type: "string", description: "الملاحظة بالعربي" } },
        required: ["text"],
      },
    },
  ];

  /* الموديل مبيعرفش النهارده إيه — وقت تدريبه بيخليه يفتكر تاريخ قديم بسنة.
     لو سابناه يمرّر التاريخ اللي في دماغه، هيسأل عن شباك فاضي ويستنتج إن
     المطعم مبيبيعش. فبنصحّح: أي تاريخ بره آخر سنة بيترد بتصحيح فيه تاريخ
     النهارده بدل ما يترد بصفوف فاضية تتقري كحقيقة. */
  function resolveRange(input, defaultDays) {
    const today = todayISO();
    const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    let from = ok(input.from) ? String(input.from) : daysAgoISO(defaultDays);
    let to = ok(input.to) ? String(input.to) : today;
    if (from > to) { const t = from; from = to; to = t; }
    if (to > today) to = today;                       // مفيش أرقام من المستقبل
    if (to < daysAgoISO(365)) {
      return { error: `التاريخ اللي طلبته (${input.to || input.from}) أقدم من سنة كاملة، وده غالباً غلط في التاريخ مش سؤال حقيقي. النهارده ${today}. سيب from و to فاضيين وهاجيبلك الافتراضي الصح، أو استخدم تواريخ قريبة من ${today}.` };
    }
    return { from, to, clamped: to !== (ok(input.to) ? String(input.to) : today) };
  }

  /* ── تنفيذ الأدوات ────────────────────────────────────────────────────── */
  async function runAgentTool(name, input, agentCtx) {
    const { s, snap, cooldown, runId } = agentCtx;

    if (name === "get_performance") {
      const rg = resolveRange(input, 6);
      if (rg.error) return { ok: false, error: rg.error };
      const { from, to } = rg;
      const only = ["meta", "tiktok", "snapchat"].includes(input.platform) ? input.platform : null;
      const r = await perfSnapshot({ from, to, platform: only });
      return { ok: true, ...compactPerf(r) };
    }

    if (name === "get_sales") {
      const rg = resolveRange(input, 6);
      if (rg.error) return { ok: false, error: rg.error };
      const { from, to } = rg;
      const days = await pool.query(
        `SELECT calendar_day::text AS day, count(*)::int AS orders, COALESCE(sum(total),0)::numeric(12,2) AS revenue
           FROM ts_orders
          WHERE calendar_day BETWEEN $1::date AND $2::date
            AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))
          GROUP BY 1 ORDER BY 1`, [from, to]);
      const total = days.rows.reduce((a, r) => a + Number(r.revenue), 0);
      const avg = days.rows.length ? total / days.rows.length : 0;
      return {
        ok: true, range: { from, to }, days: days.rows,
        totalRevenue: Math.round(total * 100) / 100,
        avgDailySales: Math.round(avg),
        goalDailySales: s.goalDailySales,
        goalProgressPct: s.goalDailySales > 0 ? Math.round((avg / s.goalDailySales) * 100) : null,
      };
    }

    if (name === "get_attribution") {
      if (!attribution?.overviewData) {
        return { ok: false, error: "موديول الإسناد مش مربوط في النسخة دي — مفيش أرقام إسناد أقدر أوريهالك. متخترعش أرقام بدالها." };
      }
      const rg = resolveRange(input, 29);
      if (rg.error) return { ok: false, error: rg.error };
      const { from, to } = rg;
      const r = await attribution.overviewData(from, to);
      // بنبعت الصفوف اللي فيها حياة بس — الباقي أصفار وبتاكل توكنز من غير فايدة.
      return {
        ok: true, range: r.range,
        channels: r.rows.filter((x) => x.orders > 0 || x.spend.total > 0 || x.leadsTotal > 0),
        totals: r.totals, coverage: r.coverage, reasons: r.reasons, notes: r.notes,
      };
    }

    if (name === "create_note") {
      const text = String(input.text || "").slice(0, 4000);
      if (!text) return { ok: false, error: "الملاحظة فاضية." };
      await pool.query(
        `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
         VALUES ($1,$2,NULL,NULL,NULL,'note',$3,$4,'info')`,
        [crypto.randomUUID(), runId, jb({ by: "agent" }), text]);
      return { ok: true, saved: true };
    }

    if (name === "pause_campaign" || name === "set_budget") {
      const platform = String(input.platform || "");
      const campaignId = String(input.id || "");
      const reason = String(input.reason || "").slice(0, 2000);
      const kind = name === "pause_campaign" ? "pause" : "budget";
      const row = snap.rows.find((r) => r.platform === platform && r.id === campaignId);

      const refusal = kind === "pause"
        ? guardPause({ platform, campaignId }, s, snap.rows, { writeOk: writeAllowed() })
        : guardBudget({ platform, campaignId, amount: input.amount }, s, snap.rows,
            { writeOk: writeAllowed(), cooldown, hardCap: MAX_DAILY_BUDGET });

      if (refusal) {
        // الرفض نفسه حدث يستاهل التسجيل — المالك لازم يشوف الوكيل حاول إيه.
        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
           VALUES ($1,$2,$3,$4,$5,'agent',$6,$7,'refused')`,
          [crypto.randomUUID(), runId, platform, campaignId, row?.name || null,
           jb({ tool: name, input, refusal }), refusal]);
        agentCtx.refusals.push({ tool: name, input, refusal });
        return { ok: false, refused: true, error: refusal };
      }

      const detail = kind === "pause"
        ? { state: "PAUSED", by: "agent" }
        : { from: row.dailyBudget, to: Number(input.amount), by: "agent" };

      // suggest: مبنكتبش على المنصة، بنحط في الطابور وبنقول للموديل الحقيقة.
      if (s.mode !== "auto") {
        const id = crypto.randomUUID();
        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'proposed')`,
          [id, runId, platform, campaignId, row.name, kind, jb(detail), reason]);
        agentCtx.queued++;
        return { ok: true, executed: false, queued: true, decisionId: id,
          note: `الوضع الحالي "${s.mode}" مش "auto" — القرار اتحط في طابور موافقة المالك ومااتنفّذش على المنصة. متفترضش إنه اتنفّذ.` };
      }

      const res = await executeDecision({ platform, campaign_id: campaignId, kind, detail }, s);
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, executed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, runId, platform, campaignId, row.name, kind, jb(detail), reason,
         res.ok ? "auto_executed" : "failed", jb(res), res.ok ? new Date() : null]);
      if (res.ok) {
        agentCtx.executed++;
        // اللقطة لازم تتحدّث جوه نفس الجولة، وإلا السور الكلي هيحسب برقم قديم.
        if (kind === "budget") row.dailyBudget = Number(input.amount);
        if (kind === "pause") row.status = "PAUSED";
        cooldown.add(`${platform}:${campaignId}`);
      }
      return res.ok
        ? { ok: true, executed: true, decisionId: id, applied: detail }
        : { ok: false, executed: false, error: res.error || "المنصة رفضت التنفيذ", platform: res.platform ?? null };
    }

    return { ok: false, error: `أداة غير معروفة: ${name}` };
  }

  /* ── الـ system prompt ────────────────────────────────────────────────── */
  function agentSystem(s, baseline, focus) {
    const today = todayISO();
    return `أنت وكيل إدارة إعلانات مطعم "فريش كتس" في جدة (برجر وستيك). السوق سعودي والعملة ريال.

⚠️ التاريخ: النهارده ${today}.
إحساسك الداخلي بالتاريخ غلط — انت مدرّب على بيانات أقدم من كده بكتير. اعتمد على السطر اللي فوق ده بس.
  • آخر ٧ أيام = من ${daysAgoISO(6)} لـ ${today}
  • آخر ٣٠ يوم = من ${daysAgoISO(29)} لـ ${today}
  • الشهر ده لحد النهارده = من ${today.slice(0, 8)}01 لـ ${today}
الأأمن إنك تسيب from و to فاضيين خالص في أدوات القراءة، وهي هتاخد المدى الصح لوحدها. لو سألت عن تاريخ قديم بسنة هترجعلك أرقام فاضية، والفاضي ده مش معناه إن المطعم مبيعش — معناه إنك سألت السؤال الغلط.

الهدف: مبيعات ${s.goalDailySales} ريال في اليوم.
خط الأساس دلوقتي: متوسط ${baseline.avgDaily} ريال/يوم على آخر ٧ أيام${baseline.progressPct != null ? ` (${baseline.progressPct}٪ من الهدف)` : ""}.
المستهدف من الإعلانات: تكلفة النتيجة ≤ ${s.targetCpa} ريال، والعائد ≥ ${s.targetRoas}×.

⚠️ «النتيجة» في كل الأرقام اللي بتشوفها معناها **نية طلب**، مش شرا:
  • دوسة «اطلب على واتساب» من صفحة المتجر (حدث Contact/Lead على البيكسل)، أو
  • محادثة واتساب ابتدت من الإعلان نفسه، أو
  • شرا أونلاين لو حصل (مبيحصلش دلوقتي — مفيش دفع أونلاين).
ميتا **مستحيل** ترجّع لنا purchase: الطلب بيتقفل جوّه المطعم وبيتبعت CAPI بـ
action_source=physical_store، وميتا شالت أنواع الأوفلاين في v20. حتى حملة
fc-sales-purchase المحسّنة على PURCHASE بالنص صرفت ٤٠٥ ريال وسجّلت ١٩ lead
وصفر purchase. فلو شفت صفر شرا ده **مش** دليل فشل ولا تبني عليه أي قرار.
والعكس كمان: نية الطلب مش فلوس. عشان كده تكلفة النتيجة المستهدفة (${s.targetCpa} ريال)
أقل بكتير من أقصى تكلفة مسموحة للعميل الجديد — الدليل الحقيقي على الفلوس هو
get_attribution (طلبات اتطابقت برقم جوال) ومبيعات الكاشير، مش رقم المنصة.

العميل بيوصلنا بخمس طرق، وكل واحدة بتتقاس بشكل مختلف:
  ١. مكالمة تليفون — مفيش أثر رقمي، العد يدوي.
  ٢. ضغطة واتساب من صفحة المتجر — بتتسجل كحدث Contact.
  ٣. طلب من المتجر الأونلاين — الفنل كامل من المشاهدة للشراء.
  ٤. زيارة داخل المحل (صالة).
  ٥. تيك أواي.
٣ و٤ و٥ بيتسجّلوا في نظام الكاشير، وتصنيف مصدرهم بيعتمد على إن الكاشير يسأل العميل — يعني كلام عميل مش دليل تقني.

صلاحياتك وحدودها:
• التكبير مسموح لحد السقوف لما تكلفة النتيجة تكون تحت المستهدف — ده بالظبط اللي المفروض تعمله لما تلاقي حملة كاسبة.
• سقف الحملة الواحدة ${s.maxCampaignBudget} ريال/يوم، والسقف الكلي ${s.maxTotalBudget} ريال/يوم، وأقصى تغيير في الخطوة الواحدة ${s.maxChangePct}٪، وفترة تبريد ${s.budgetCooldownHours} ساعة بين تغييرين لنفس الحملة.
• السقوف دي مش قابلة للتفاوض. لو طلبت حاجة بره الحدود الأداة هترجعلك رفض — اقرا الرفض واشتغل جوه الحد، متحاولش تلف حواليه.
• قاعدة القتل: حملة تكلفة نتيجتها أعلى من ${killLineOf(s)} ر.س/نتيجة مع صرف حقيقي تستاهل الإيقاف. حملة تحت المستهدف ممنوع توقفها.
• مفيش حكم على حملة صرفت أقل من ${s.minSpend} ريال في الشباك — ده ضجيج مش أداء.

قواعد الصدق (الأهم):
• ممنوع تخترع رقم. أي رقم تقوله لازم يكون جاي من أداة نديتها في نفس الجولة.
• لو الأداة رجعت خطأ أو داتا ناقصة، قول كده بصراحة. "مش عارف" إجابة مقبولة، الرقم المخترع لأ.
• أرقام الإسناد ليها درجة ثقة: مؤكد (مطابقة رقم جوال) / مرجّح (تصنيف الكاشير) / تقديري (استنتاج). لما تبني قرار على "تقديري" قول كده في السبب.
• متقولش إن حاجة اتنفّذت غير لما الأداة ترجعلك executed:true.

${focus}

اشتغل كده: نده أدوات القراءة الأول لحد ما تفهم الوضع، بعدين نفّذ اللي يستاهل، وفي الآخر اكتب خلاصة قصيرة بالعربي: شفت إيه، عملت إيه، وليه. لو مفيش حاجة تستاهل التدخل، قول كده وخلاص — عدم التدخل قرار محترم.`;
  }

  const FOCUS_FULL = `دي جولة كاملة (كل ساعة). راجع الوضع العام: أداء الحملات، مردود القنوات، والمسافة من هدف المبيعات.`;
  const FOCUS_EMERGENCY = `دي جولة طوارئ سريعة (كل ربع ساعة) — مش مراجعة عامة. ركّز على المشكلة المذكورة تحت بس واتصرف فيها لو مستاهلة، وسيب أي حاجة تانية للجولة الكاملة. لو اتضح إن مفيش مشكلة حقيقية، قول كده وما تعملش أي كتابة.`;

  /* ── الجولة ───────────────────────────────────────────────────────────── */
  async function runAgent({ runId, s, trigger = "cycle", task, focus = FOCUS_FULL, snap = null, fingerprint = null }) {
    /* الوكيل بيقرا أرقام وبيطبّق قرار محسوم بالقواعد والأسوار — ده تصنيف
       مش تأليف استراتيجية، فبيمشي على الموديل الرخيص. المستشار
       (runStrategist) هو اللي بياخد الموديل الكبير، وهو بينده مرة في اليوم. */
    const provider = llmProvider({ tier: s.agentModelTier === "smart" ? "smart" : "fast" });
    if (!provider) return { ok: false, skipped: "مفيش مزوّد LLM مضبوط (ANTHROPIC_API_KEY أو LITELLM_KEY)" };
    if (!s.agent) return { ok: false, skipped: "الوكيل مقفول من الإعدادات" };

    const sales = await pool.query(
      `SELECT COALESCE(sum(total),0) AS rev, count(DISTINCT calendar_day)::int AS days
         FROM ts_orders
        WHERE calendar_day >= (NOW() AT TIME ZONE 'utc')::date - 6
          AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))`);
    const avgDaily = sales.rows[0].days > 0 ? Math.round(Number(sales.rows[0].rev) / sales.rows[0].days) : 0;
    const baseline = { avgDaily, progressPct: s.goalDailySales > 0 ? Math.round((avgDaily / s.goalDailySales) * 100) : null };

    const agentCtx = {
      s,
      snap: snap || await perfSnapshot({}),
      cooldown: await budgetCooldownSet(s),
      runId,
      executed: 0, queued: 0, refusals: [],
    };

    const system = agentSystem(s, baseline, focus);
    const messages = [{ role: "user", content: task }];
    const maxTurns = Math.min(Number(s.agentMaxTurns) || 8, AGENT_TURN_CEILING);
    const turns = [];
    let final = "";

    for (let turn = 1; turn <= maxTurns; turn++) {
      let reply;
      try {
        reply = await llmTurn(provider, { system, messages, tools: AGENT_TOOLS, purpose: `agent:${trigger}` });
      } catch (e) {
        // الموديل مش موجود → الوكيل بس هو اللي بيقف. القواعد الصمّاء خلصت خلاص.
        await logAgentTurn(runId, trigger, turn, { error: String(e.message || e), fingerprint }, "failed");
        return { ok: false, error: String(e.message || e), turns: turns.length,
                 executed: agentCtx.executed, queued: agentCtx.queued, refusals: agentCtx.refusals.length };
      }
      messages.push(reply.native);

      if (!reply.calls.length) {
        final = reply.text || final;
        turns.push({ turn, text: reply.text, tools: [] });
        await logAgentTurn(runId, trigger, turn, { text: reply.text, tools: [], stop: reply.stop, final: true, fingerprint }, "info");
        break;
      }

      const results = [];
      const logged = [];
      for (const call of reply.calls) {
        let output;
        try { output = await runAgentTool(call.name, call.input, agentCtx); }
        catch (e) { output = { ok: false, error: String(e.message || e) }; }
        const text = JSON.stringify(output).slice(0, TOOL_RESULT_MAX);
        results.push({ id: call.id, text });
        logged.push({ name: call.name, input: call.input, output: trim(output) });
      }
      turns.push({ turn, text: reply.text, tools: logged });
      await logAgentTurn(runId, trigger, turn, { text: reply.text, tools: logged, stop: reply.stop, fingerprint }, "info");
      messages.push(...toolResultMessages(provider, results));
      final = reply.text || final;
    }

    return {
      ok: true, turns: turns.length, final,
      executed: agentCtx.executed, queued: agentCtx.queued,
      refusals: agentCtx.refusals.length, refusalDetail: agentCtx.refusals,
    };
  }

  // نتيجة الأداة ممكن تكون ضخمة — بنسجّل نسخة مقصوصة عشان الجدول ما يتخمش.
  function trim(v) {
    const s2 = JSON.stringify(v);
    return s2.length <= 6000 ? v : { truncated: true, preview: s2.slice(0, 6000) };
  }

  async function logAgentTurn(runId, trigger, turn, detail, status) {
    await pool.query(
      `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
       VALUES ($1,$2,NULL,NULL,NULL,'agent',$3,$4,$5)`,
      [crypto.randomUUID(), runId, jb({ trigger, turn, ...detail }),
       String(detail.text || detail.error || "").slice(0, 4000), status]
    ).catch((e) => console.error("[autopilot] agent log failed:", e.message));
  }

  /* ═══ الطوارئ — كشف رخيص من غير LLM، والـ LLM بينده بس لما يبقى فيه سبب ═══ */

  async function detectEmergencies(s) {
    const today = todayISO();
    const found = [];
    const snap = await perfSnapshot({ from: today, to: today });

    for (const r of snap.rows) {
      if (r.status !== "ACTIVE") continue;
      /* (١) حملة بتحرق فلوس النهارده من غير أي نية طلب.
         `results == null` (المنصة عمياها) مش صفر — نفس تفرقة decide(). */
      /* بلغة الهدف: حملة نقرات بتجيب نقرات مش «بتحرق فلوس». الإشارة دي
         هي اللي كانت بتنده الوكيل، والوكيل هو اللي قفل الحملتين. */
      const rm = resultModelOf(r, s);
      if (r.spend >= s.minSpend * 2 && rm.count === 0) {
        found.push({ key: `burn:${r.platform}:${r.id}:${today}`, kind: "burn", platform: r.platform,
          campaignId: r.id, campaignName: r.name,
          text: rm.kind === "click"
            ? `"${r.name}" (${r.platform}) صرفت ${Math.round(r.spend)} ر.س النهارده من غير ولا نقرة واحدة.`
            : `"${r.name}" (${r.platform}) صرفت ${Math.round(r.spend)} ر.س النهارده من غير ولا نية طلب واحدة (ولا دوسة واتساب ولا محادثة).` });
      }
      // (٢) تكلفة النتيجة النهارده فوق حد القتل — بوحدة الهدف
      if (r.spend >= s.minSpend && rm.cost != null && rm.cost > rm.killLine) {
        found.push({ key: `cpa:${r.platform}:${r.id}:${today}`, kind: "cpa", platform: r.platform,
          campaignId: r.id, campaignName: r.name,
          text: `"${r.name}" (${r.platform}) تكلفة الـ${rm.unit} النهارده ${Math.round(rm.cost * 100) / 100} ر.س — أعلى من خط القتل (${rm.killLine} ر.س/${rm.unit}).` });
      }
    }

    // (٣) مجموع الميزانيات فوق السقف الكلي
    const active = activeBudgetOf(snap.rows);
    if (active > s.maxTotalBudget) {
      found.push({ key: `pacing:${today}`, kind: "pacing",
        text: `مجموع ميزانيات الحملات الشغالة ${Math.round(active)} ر.س/يوم وده فوق السقف الكلي (${s.maxTotalBudget} ر.س).` });
    }

    // (٤) منصة بتضرب خطأ — بس بعد ٣ مرات ورا بعض، عشان خطأ عابر ما يدقّش جرس
    for (const [pid, reason] of Object.entries(snap.reasons)) {
      platformFails[pid] = (platformFails[pid] || 0) + 1;
      if (platformFails[pid] === 3) {
        found.push({ key: `platform:${pid}:${today}`, kind: "platform", platform: pid,
          text: `منصة ${pid} رجعت خطأ ٣ مرات ورا بعض: ${String(reason).slice(0, 300)}` });
      }
    }
    for (const p of PLATFORMS) {
      if (!snap.reasons[p.id]) platformFails[p.id] = 0;
    }

    // نفس المشكلة ما تتفتحش تاني قبل فترة التبريد
    const fresh = [];
    for (const e of found) {
      const seen = await pool.query(
        `SELECT 1 FROM ap_decisions WHERE kind='emergency' AND detail->>'key' = $1
           AND created_at > NOW() - ($2 || ' hours')::interval LIMIT 1`,
        [e.key, String(Number(s.emergencyCooldownHours) || 6)]);
      if (!seen.rowCount) fresh.push(e);
    }
    return { snap, all: found, fresh };
  }

  async function runEmergencyCheck({ trigger = "fast" } = {}) {
    if (emergencyRunning || running) return { ok: false, skipped: "already running" };
    const s = await settingsNow();
    if (s.mode === "off") return { ok: false, skipped: "mode=off" };

    emergencyRunning = true;
    const runId = crypto.randomUUID();
    try {
      const { snap, fresh } = await detectEmergencies(s);
      if (!fresh.length) return { ok: true, emergencies: 0 };

      await pool.query(`INSERT INTO ap_runs (id, status, summary) VALUES ($1,'running',$2)`,
        [runId, jb({ trigger, mode: s.mode, kind: "emergency" })]);
      for (const e of fresh) {
        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
           VALUES ($1,$2,$3,$4,$5,'emergency',$6,$7,'info')`,
          [crypto.randomUUID(), runId, e.platform || null, e.campaignId || null, e.campaignName || null,
           jb(e), e.text]);
      }

      const task = `طوارئ. الفحص السريع لقى المشاكل دي النهارده:\n\n${fresh.map((e, i) => `${i + 1}. [${e.kind}] ${e.text}`).join("\n")}\n\nاتأكد بالأرقام الأول (get_performance على النهارده وعلى آخر ٣ أيام) قبل ما تتصرف — ممكن تكون الحملة لسه بتتعلم أو النتايج متأخرة في التسجيل. بعدين اتصرف في اللي يستاهل بس.`;
      /* الطوارئ سبب حقيقي — بتعدّي الفاصل الزمني، بس مش الميزانية اليومية.
         لو الميزانية خلصت بنسجّل المشاكل من غير ما نستشير الموديل: القواعد
         الصمّاء والكشف الرخيص شغّالين، واللي ناقص هو الرأي بس. */
      const gate = await llmGate({ kind: "agent", s, fingerprint: null,
        reason: `طوارئ: ${fresh.length} مشكلة (${fresh.map((e) => e.kind).join("، ")})` });
      if (!gate.run) {
        await logLlmSkip(runId, "agent", gate);
        const summary0 = { trigger, mode: s.mode, kind: "emergency", emergencies: fresh.length, agent: { skipped: gate.why } };
        await pool.query(`UPDATE ap_runs SET status='done', finished_at=NOW(), summary=$2 WHERE id=$1`, [runId, jb(summary0)]);
        return { ok: true, runId, emergencies: fresh.length, agent: { skipped: gate.why } };
      }
      const agent = await runAgent({ runId, s, trigger: "emergency", task, focus: FOCUS_EMERGENCY, snap });

      const summary = { trigger, mode: s.mode, kind: "emergency", emergencies: fresh.length, agent };
      await pool.query(`UPDATE ap_runs SET status='done', finished_at=NOW(), summary=$2 WHERE id=$1`, [runId, jb(summary)]);
      return { ok: true, runId, emergencies: fresh.length, agent };
    } catch (e) {
      await pool.query(`UPDATE ap_runs SET status='error', finished_at=NOW(), error=$2 WHERE id=$1`,
        [runId, String(e.message || e)]).catch(() => {});
      console.error("[autopilot] emergency check error:", e.message);
      return { ok: false, error: String(e.message || e) };
    } finally {
      emergencyRunning = false;
    }
  }

  /* ═══ نافذة الإعلانات — الدورة السريعة ══════════════════════════════════
     بتجري مع الدورة السريعة. رخيصة في الحالة الطبيعية: النافذة مفتوحة
     والدفتر فاضي → استعلام SQL واحد وخلاص، من غير ما نلمس أي منصة.

     الإيقاف بيتنفّذ في وضع auto بس، بنفس منطق التسريع بالظبط: الموافقة
     ممكن تيجي بعد ساعات، وإيقاف حملة الساعة ٣ الفجر لما يتوافق عليه الساعة
     ٢ الضهر معناه إننا وقفنا الإعلانات في عزّ الشغل. أما التشغيل فبيمشي في
     أي وضع — إحنا اللي وقفنا الحملة، فرجوعها إتمام لقرار خلاص اتاخد مش
     قرار جديد محتاج إذن.                                                   */

  let daypartRunning = false;
  let lastClosedProbeAt = 0;
  const CLOSED_PROBE_MS = 25 * 60_000;   // وإحنا مقفولين، نبص على المنصات كل ٢٥ دقيقة بس

  async function runDaypartCheck({ trigger = "fast", force = false } = {}) {
    if (daypartRunning) return { ok: false, skipped: "already running" };
    const s = await settingsNow();
    if (s.mode === "off" && !force) return { ok: false, skipped: "mode=off" };
    if (s.daypart === false && !force) return { ok: false, skipped: "daypart disabled" };

    daypartRunning = true;
    const now = new Date();
    const w = adsWindow(now, s);
    try {
      const book = await daypartBook();

      // مفتوحة ومفيش حاجة موقوفة من عندنا = الحالة الطبيعية طول اليوم.
      if (w.open && book.size === 0 && !force) {
        return { ok: true, phase: "open", window: w, actions: 0 };
      }
      /* مقفولة وحاولنا من شوية — مش محتاجين نضرب المنصات كل ٥ دقايق بالليل.
         الشرط بيقيس «آخر مرة حاولنا فيها» مش «الدفتر فيه حاجة»: ليلة ١١
         أغسطس أوامر الإيقاف كلها اترفضت، فالدفتر فضل فاضي، فالشرط ده
         مااشتغلش ولا مرة ورجعنا نقرا ونحاول كل ٥ دقايق طول الليل. المحاولة
         الفاشلة محاولة برضه — لازم تتحسب. */
      if (!w.open && !force && Date.now() - lastClosedProbeAt < CLOSED_PROBE_MS) {
        return { ok: true, phase: "closed", window: w, skipped: "throttled", paused: book.size };
      }

      /* الباب المقفول بيتشال من الدورة كلها — مش بس من الكتابة. القراءة تحت
         (campaigns + insights) بتاكل من نفس حصة النداءات اللي الإيقاف
         مستنيها، وده اللي خلّى ليلة ١١ أغسطس تكمّل لآخرها: الكتابة كانت
         بتترد من غير ما تخرج، لكن التليمتري فضلت تضرب ميتا ٣٦ نداء في
         الساعة وتاكل الحصة. لو كل منصة نقدر نكتب عليها بابها مقفول، مفيش
         دورة أصلاً.

         الشرط بقى «مفيش ولا منصة مفتوحة» بدل «كل المنصات مقفولة بالعدد»:
         الشرط القديم كان بيقارن طول القايمتين، وتيك توك وجوجل عمرهم
         مادخلوا القايمة، فالمخرج ده ماكانش بيشتغل ولا مرة. */
      const managed = PLATFORMS.filter((p) => canManage(p));
      const gated = writeGates();
      const openPlatforms = managed.filter((p) => !gated.some((g) => g.platform === p.id));
      if (managed.length && !force && !openPlatforms.length) {
        const soonest = Math.min(...gated.map((g) => g.minutes));
        if (!w.open) lastClosedProbeAt = Date.now();
        return { ok: true, phase: w.open ? "open" : "closed", window: w, skipped: "platforms rate-limited",
                 retryInMinutes: soonest,
                 gates: gated.map((g) => ({ platform: g.platform, minutes: g.minutes, kind: g.kind })) };
      }

      if (!w.open) lastClosedProbeAt = Date.now();

      const snap = await perfSnapshot({ from: todayISO(), to: todayISO() });
      const pacing = await pacingState().catch(() => new Map());
      const decision = decideDaypart({ rows: snap.rows, book, pacing, window: w, s });
      if (!decision.actions.length) {
        return { ok: true, phase: decision.phase, window: w, actions: 0, gate: decision.gate };
      }

      const pauses = decision.actions.filter((a) => a.op === "pause");
      const rest = decision.actions.filter((a) => a.op !== "pause");
      const canPause = s.mode === "auto" || force;

      /* في وضع الاقتراح بنسجّل ملاحظة واحدة في اليوم بتشرح اللي مش بيحصل —
         من غير الفلتر ده الشاشة هتغرق بنفس الجملة كل ٢٥ دقيقة طول الليل. */
      if (!canPause && pauses.length) {
        const seen = await pool.query(
          `SELECT 1 FROM ap_decisions WHERE kind='daypart' AND status='info'
             AND created_at > NOW() - interval '6 hours' LIMIT 1`);
        if (!seen.rowCount) {
          await pool.query(
            `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
             VALUES ($1,NULL,NULL,NULL,NULL,'daypart',$2,$3,'info')`,
            [crypto.randomUUID(),
             jb({ op: "would-pause", mode: s.mode, window: w.label, clock: w.clock, count: pauses.length }),
             `${w.why} كان المفروض نوقف ${ar(pauses.length)} حملة دلوقتي (${pauses.map((a) => a.campaignName).join("، ")}) عشان مانصرفش والمطبخ قافل — بس الوضع "${s.mode}" مش "auto". ` +
             `إيقاف ساعات القفل مش بيتحط في طابور الموافقة عن قصد: لو الموافقة جت الساعة ٢ الضهر هتوقف الإعلانات في عزّ الشغل. حوّل الوضع لـ "تلقائي" عشان يشتغل.`]);
        }
      }

      const todo = canPause ? decision.actions : rest;
      if (!todo.length) {
        return { ok: true, phase: decision.phase, window: w, mode: s.mode, executed: 0, wouldPause: pauses.length };
      }

      const runId = crypto.randomUUID();
      await pool.query(`INSERT INTO ap_runs (id, status, summary) VALUES ($1,'running',$2)`,
        [runId, jb({ trigger, mode: s.mode, kind: "daypart", phase: decision.phase, window: w.label })]);

      const results = [];
      for (const a of todo) {
        let status = "info", result = null, executedAt = null;

        if (a.op === "forget") {
          // مفيش أمر بيتبعت للمنصة — بنقفل القيد بس (ومع إن الحملة شغالة
          // بإيد المالك، بنرجّع ميزانيته لو التسريع سابها على رقم مؤقت).
          if (a.restoreTo != null) {
            const res = await executeDecision(
              { platform: a.platform, campaign_id: a.campaignId, kind: "budget", detail: { to: a.restoreTo } }, s);
            result = res;
            status = statusOf(res);
            executedAt = res.ok ? new Date() : null;
          } else { status = "auto_executed"; executedAt = new Date(); }
          await pool.query(
            `UPDATE ap_daypart SET resumed_at=NOW()
              WHERE platform=$1 AND campaign_id=$2 AND resumed_at IS NULL`,
            [a.platform, a.campaignId]);
        } else if (a.op === "pause") {
          /* مابيعديش على guardPause عن قصد: السور ده بيمنع إيقاف حملة كاسبة
             لإن قاعدة القتل مش منطبقة عليها — وده صح لما السبب هو الأداء.
             هنا السبب إن المطبخ قافل، والحملة الكاسبة أول واحدة المفروض
             تتوقف عشان بتصرف أكتر على ساعات مفيهاش بيع. الإيقاف كمان
             مبيصرفش فلوس، هو بيوفّرها. */
          const res = await executeDecision(
            { platform: a.platform, campaign_id: a.campaignId, kind: "pause", detail: { state: "PAUSED" } }, s);
          result = res;
          status = statusOf(res);
          executedAt = res.ok ? new Date() : null;
          if (res.ok) {
            await pool.query(
              `INSERT INTO ap_daypart (platform, campaign_id, campaign_name, biz_day, base_budget)
               VALUES ($1,$2,$3,$4::date,$5)
               ON CONFLICT (platform, campaign_id, biz_day) DO UPDATE
                 SET campaign_name=EXCLUDED.campaign_name, base_budget=EXCLUDED.base_budget,
                     paused_at=NOW(), resumed_at=NULL`,
              [a.platform, a.campaignId, a.campaignName, a.bizDay, a.base]);
          }
        } else {   // resume
          const res = await executeDecision(
            { platform: a.platform, campaign_id: a.campaignId, kind: "resume", detail: { state: "ACTIVE" } }, s);
          result = res;
          status = statusOf(res);
          executedAt = res.ok ? new Date() : null;
          if (res.ok) {
            if (a.restoreTo != null) {
              const b = await executeDecision(
                { platform: a.platform, campaign_id: a.campaignId, kind: "budget", detail: { to: a.restoreTo } }, s);
              result = { ...res, budget: b };
              if (!b.ok) status = "failed";
            }
            /* القيد بيتقفل حتى لو تصحيح الميزانية فشل: الحملة رجعت تشتغل
               وهي الحاجة اللي كانت بتوقف الفلوس. الميزانية الغلط هتتصلّح في
               الجولة البطيئة، لكن لو سبنا القيد مفتوح هنبعت أمر تشغيل تاني
               كل ٥ دقايق على حملة شغالة أصلاً. */
            await pool.query(
              `UPDATE ap_daypart SET resumed_at=NOW()
                WHERE platform=$1 AND campaign_id=$2 AND resumed_at IS NULL`,
              [a.platform, a.campaignId]);
          }
        }

        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, executed_at)
           VALUES ($1,$2,$3,$4,$5,'daypart',$6,$7,$8,$9,$10)`,
          [crypto.randomUUID(), runId, a.platform, a.campaignId, a.campaignName,
           jb({ op: a.op, window: w.label, clock: w.clock, bizDay: a.bizDay, dow: w.dowLabel,
                late: w.late, base: a.base ?? null, restoreTo: a.restoreTo ?? null, trigger }),
           a.reason, status, jb(result), executedAt]);
        results.push({ op: a.op, campaign: a.campaignName, status });
      }

      /* «النداء رجع ok» مش نفس «الحملة وقفت». بنقرا الحالة من المنصة نفسها
         بعد كل دفعة أوامر — ده الفرق بين إننا نعرف إن المطبخ قافل
         والإعلانات واقفة، وبين إننا نفتكر كده. */
      const verdict = await verifyDaypart({ force: true }).catch(() => null);

      const summary = { trigger, mode: s.mode, kind: "daypart", phase: decision.phase,
                        window: w.label, clock: w.clock, actions: results,
                        ...(verdict ? { verified: verdict.tone, verdict: verdict.line } : {}) };
      await pool.query(`UPDATE ap_runs SET status='done', finished_at=NOW(), summary=$2 WHERE id=$1`,
        [runId, jb(summary)]);
      return { ok: true, runId, window: w, ...summary };
    } catch (e) {
      console.error("[autopilot] daypart check error:", e.message);
      return { ok: false, error: String(e.message || e) };
    } finally {
      daypartRunning = false;
    }
  }

  /* ═══ التحقق: النافذة اتنفّذت فعلاً ولا إحنا بس فاكرين؟ ═════════════════
     الدفتر (ap_daypart) بيقول اللي إحنا *أمرنا* بيه. المنصة بتقول اللي
     *حاصل*. الفرق بين الاتنين هو بالظبط اللي كان بيضيع فلوس: يوم ١١ أغسطس
     ميتا رفضت ٣٣٧ أمر إيقاف والإعلانات فضلت شغالة من ٣ الفجر لـ ١٠ الصبح،
     والشاشة مكانتش بتقول غير إن في «قرارات فشلت» في سجل طويل محدش بيقراه.

     فالتحقق ده بيقرا حالة كل حملة من المنصة نفسها — مش من جدولنا — ويقارنها
     باللي النافذة بتفرضه دلوقتي، ويطلّع سطر واحد صادق. لو الحقيقة تخالف
     النية، بيتسجّل قرار في اللوج كمان عشان يبان في الشاشة وفي التقرير.

     بيتكلّف نداء قراءة واحد لكل منصة، فبيتخزّن في الذاكرة دقايق قبل ما
     يتحسب تاني — على حصة تطوير عند ميتا كل نداء بيتحسب.                    */

  /* بتقفل كل الدعاوى المفتوحة لمنصة واحدة من قراءة اتعملت خلاص. الدعوى
     بتتقارن بالحقل بتاعها بس — الحالة بالحالة والميزانية بالميزانية —
     والفرق في الميزانية بيتقاس بهامش ريال لإن المنصات بتخزّنها بالسنت
     وبتقرّب.

     الحملة اللي اختفت من القراءة (اتمسحت أو اتأرشفت) دعواها بتتقفل 'gone'
     مش 'mismatch': مفيش حاجة نصلّحها ومفيش داعي نفضل نعدّها.

     وعدم التطابق مابيتحكمش عليه من أول قراءة: المنصات بتاخد لحد دقيقة عشان
     الحالة تستقر، وقراءة بدري بتقول «مختلف» وهي في الحقيقة «لسه». */
  async function settleClaims(platformId, campaigns) {
    const open = await pool.query(
      `SELECT * FROM ap_claims WHERE platform=$1 AND settled_at IS NULL ORDER BY created_at`,
      [platformId]).catch(() => ({ rows: [] }));
    if (!open.rows.length) return [];

    const live = new Map((campaigns || []).map((c) => [String(c.id), c]));
    const broken = [];
    for (const cl of open.rows) {
      const { verdict, actual, wait } = claimVerdict({
        field: cl.field, expected: cl.expected,
        campaign: live.get(String(cl.campaign_id)) || null,
        ageMs: Date.now() - new Date(cl.created_at).getTime(),
      });
      if (wait) {
        await pool.query(`UPDATE ap_claims SET checked_at=NOW(), actual=$2 WHERE id=$1`,
          [cl.id, actual]).catch(() => {});
        continue;
      }
      await pool.query(
        `UPDATE ap_claims SET settled_at=NOW(), checked_at=NOW(), verdict=$2, actual=$3 WHERE id=$1`,
        [cl.id, verdict, actual]).catch(() => {});
      if (verdict === "mismatch") {
        broken.push({ platform: platformId, campaignId: cl.campaign_id, name: cl.campaign_name,
                      field: cl.field, expected: cl.expected, actual });
      }
    }
    return broken;
  }

  let lastVerify = null;
  const VERIFY_TTL_MS = 4 * 60_000;

  async function verifyDaypart({ force = false, priority = "verify" } = {}) {
    if (!force && lastVerify && Date.now() - lastVerify.at < VERIFY_TTL_MS) return lastVerify.value;

    const s = await settingsNow();
    const w = adsWindow(new Date(), s);
    const book = await daypartBook().catch(() => new Map());

    const platforms = [];
    for (const p of PLATFORMS) {
      if (!canManage(p)) continue;
      /* منصة بابها مقفول مابنقراش منها تلقائيًا: الأمر ما خرجش أصلاً فمفيش
         حاجة نتأكد منها، والقراءة هتاكل من الحصة اللي الأمر مستنيها.
         المالك لما يدوس «افحص تاني» بيعدّي (priority=owner). */
      const live = await platformRead(p, () => p.campaigns(), { priority, empty: { campaigns: [] } });
      if (!live.ok) {
        /* لو المنصة نفسها عارفة إنها مقفولة، سببها هو اللي يتعرض — مش نص
           الخطأ الإنجليزي. «التطبيق تحت المراجعة» جملة المالك يقدر يعمل
           بيها حاجة؛ «code 40001: The access token lacks the required
           scope» بتخلّيه يفتكر إن في توكن محتاج تظبيط وهو مش كده. */
        const known = p.lastReadiness?.();
        platforms.push({ id: p.id, label: p.label, readable: false,
                         reason: known?.reason || live.reason,
                         ...(known?.code ? { code: known.code } : {}),
                         mismatches: [] });
        continue;
      }
      /* اللي بيهمنا: الحملات اللي المفروض تكون موقوفة دلوقتي. وقت القفل دي
         كل حملة شغالة على المنصة (حتى لو مش في دفترنا — حملة اشتغلت بإيد
         المالك أو ما وقفناهاش أصلاً برضه بتصرف). وقت الفتح دي اللي إحنا
         وقفناها ولسه ما رجعناهاش. */
      /* نفس القراءة دي بتقفل كل الدعاوى المفتوحة على المنصة — الميزانية
         والتسريع كمان، مش بس الإيقاف والتشغيل. مفيش نداء زيادة. */
      const brokenClaims = await settleClaims(p.id, live.campaigns);

      const running = live.campaigns.filter((c) => String(c.status).toUpperCase() === "ACTIVE");
      const mismatches = [];
      if (!w.open) {
        for (const c of running) {
          mismatches.push({ id: c.id, name: c.name, expected: "PAUSED", actual: c.status });
        }
      } else {
        for (const [, b] of book) {
          if (b.platform !== p.id) continue;
          const c = live.campaigns.find((x) => String(x.id) === String(b.campaignId));
          if (c && String(c.status).toUpperCase() !== "ACTIVE") {
            mismatches.push({ id: c.id, name: c.name, expected: "ACTIVE", actual: c.status });
          }
        }
      }
      /* الأمر اللي المنصة قالت عليه «تمام» وبعدين القراءة لقيته ما اتنفّذش
         بيتحسب مخالفة زي أي مخالفة — ده بالظبط الاعتقاد الغلط اللي بندوّر
         عليه. */
      for (const b of brokenClaims) {
        mismatches.push({
          id: b.campaignId, name: b.name || b.campaignId,
          expected: b.field === "budget" ? `ميزانية ${b.expected}` : b.expected,
          actual: b.field === "budget" ? `ميزانية ${b.actual ?? "؟"}` : (b.actual ?? "؟"),
          claim: b.field,
        });
      }
      platforms.push({
        id: p.id, label: p.label, readable: true,
        total: live.campaigns.length, running: running.length,
        mismatches,
        unconfirmed: brokenClaims.length,
        ok: mismatches.length === 0,
      });
    }

    const readable = platforms.filter((x) => x.readable);
    const broken = readable.filter((x) => !x.ok);
    const unreadable = platforms.filter((x) => !x.readable);
    const gates = writeGates();

    /* السطر. صادق يعني: لو مقدرناش نقرا منصة مابنقولش إنها سليمة. */
    let line, tone;
    if (!readable.length) {
      tone = "unknown";
      line = "مقدرناش نقرا حالة الحملات من أي منصة دلوقتي — يعني مش عارفين الإعلانات واقفة ولا شغالة.";
    } else if (broken.length) {
      tone = "bad";
      const who = broken.map((x) => `${x.label}: ${ar(x.mismatches.length)} حملة`).join("، ");
      const why = gates.length
        ? ` السبب: ${gates.map((g) => g.reason).join(" · ")}`
        : (broken[0].mismatches[0] ? ` (${broken[0].mismatches.map((m) => m.name).slice(0, 3).join("، ")})` : "");
      line = w.open
        ? `⚠️ المطعم فاتح والإعلانات لسه موقوفة على ${who}.${why}`
        : `🚨 المطبخ قافل والإعلانات لسه شغالة على ${who} — بنصرف على ساعات مفيهاش بيع.${why}`;
    } else {
      tone = "good";
      const names = readable.map((x) => x.label.split(" ")[0]).join(" و");
      line = w.open
        ? `الإعلانات شغالة فعلاً على ${names} — زي ما النافذة بتقول.`
        : `الإعلانات موقوفة فعلاً على ${names} — اتأكدنا من المنصة نفسها مش من جدولنا.`;
    }
    if (unreadable.length) {
      line += ` (${unreadable.map((x) => x.label).join("، ")}: مقدرناش نقرا — ${unreadable[0].reason})`;
    }

    const value = {
      at: new Date().toISOString(),
      window: { open: w.open, label: w.label, clock: w.clock },
      tone, line, platforms, gates,
      mismatchCount: broken.reduce((a, x) => a + x.mismatches.length, 0),
    };

    /* المخالفة بتتسجّل في اللوج مرة كل ساعة بالكتير — عشان تبان في الشاشة
       وفي التقرير، من غير ما تغرق السجل بنفس الجملة كل ٥ دقايق. */
    if (tone === "bad") {
      const seen = await pool.query(
        `SELECT 1 FROM ap_decisions WHERE kind='daypart' AND status='info'
           AND detail->>'op' = 'verify-mismatch' AND created_at > NOW() - interval '55 minutes' LIMIT 1`)
        .catch(() => ({ rowCount: 1 }));
      if (!seen.rowCount) {
        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
           VALUES ($1,NULL,$2,NULL,NULL,'daypart',$3,$4,'info')`,
          [crypto.randomUUID(), broken[0]?.id || null,
           jb({ op: "verify-mismatch", window: w.label, clock: w.clock, open: w.open,
                mismatches: value.mismatchCount, platforms: broken.map((x) => x.id) }),
           line]).catch(() => {});
      }
    }

    lastVerify = { at: Date.now(), value };
    return value;
  }

  /* ═══ الإنذار: المنصة بترفض الكتابة وإحنا ساكتين ═════════════════════════
     ٣٦١ رفض من ميتا و٨٧ من سناب في أسبوع ماطلعوش على أي شاشة — كانوا بيتكوّموا
     في سجل القرارات وخلاص. الدالة دي بتحوّل التكرار ده لإنذار صريح.        */

  async function writeFailureAlerts() {
    const r = await pool.query(
      `SELECT platform,
              count(*)::int AS n,
              max(created_at) AS last_at,
              (array_agg(result->>'error' ORDER BY created_at DESC))[1] AS last_error,
              count(*) FILTER (WHERE kind='daypart')::int AS daypart_n
         FROM ap_decisions
        WHERE status='failed' AND platform IS NOT NULL
          AND created_at > NOW() - interval '24 hours'
        GROUP BY platform
        HAVING count(*) >= 3
        ORDER BY n DESC`).catch(() => ({ rows: [] }));

    const gates = writeGates();
    return r.rows.map((x) => {
      const g = gates.find((y) => y.platform === x.platform);
      const label = byId(x.platform)?.label || x.platform;
      return {
        platform: x.platform,
        label,
        count: x.n,
        daypartCount: x.daypart_n,
        lastError: x.last_error,
        lastAt: x.last_at,
        blockedForMinutes: g ? g.minutes : 0,
        severity: x.daypart_n >= 3 ? "bad" : "warn",
        title: x.daypart_n >= 3
          ? `${label} بترفض أوامر إيقاف الإعلانات`
          : `${label} بترفض أوامر الطيار`,
        text: x.daypart_n >= 3
          ? `${ar(x.n)} أمر اترفض في آخر ٢٤ ساعة، منهم ${ar(x.daypart_n)} أمر إيقاف وقت ما المطبخ كان قافل — يعني كنا بندفع إعلانات على ساعات مفيهاش بيع. آخر رد من المنصة: «${x.last_error || "بدون سبب"}».`
          : `${ar(x.n)} أمر اترفض في آخر ٢٤ ساعة. آخر رد من المنصة: «${x.last_error || "بدون سبب"}».`,
      };
    });
  }

  /* ═══ الإيقاع اليومي — الدورة السريعة ═══════════════════════════════════
     بتجري كل ١٥ دقيقة جنب فحص الطوارئ. رخيصة عن قصد: بتسأل قاعدة البيانات
     الأول (نداء واحد على ts_orders)، ومبتضربش المنصات غير لما يكون فيه سبب
     فعلي — يا حاجة تترجّع يا إيقاع خارج المنطقة الطبيعية. ساعات الفجر
     والصبح بتكلّف استعلام SQL واحد وخلاص.                                  */

  let pacingRunning = false;

  async function runPaceCheck({ trigger = "fast", force = false } = {}) {
    if (pacingRunning) return { ok: false, skipped: "already running" };
    const stored = await getSettings();
    if (stored.mode === "off" && !force) return { ok: false, skipped: "mode=off" };
    if (stored.pacing === false && !force) return { ok: false, skipped: "pacing disabled" };

    pacingRunning = true;
    const now = new Date();
    const accountDay = accountDayOf(now);
    const msToRoll = msToAccountRoll(now);
    try {
      const state = await pacingState();
      const preRoll = msToRoll <= Math.max(5, Number(stored.paceRestoreBeforeMin) || 45) * 60_000;
      const hasStale = [...state.values()].some((v) => v.accountDay !== accountDay);
      const mustSettle = preRoll || hasStale;

      /* هل إحنا جوّه نافذة الرفع أصلاً؟ لو لأ ومفيش حاجة تترجّع، نخرج من
         غير ما نلمس أي منصة. ده اللي بيخلي الدورة دي مجانية بالليل. */
      const pulse = await pulseData();
      // السقف بيتحسب هنا عشان النبض يدخل في الحسبة: يوم شغّال بيفتح سقف
      // التوسّع، ومن غير كده كنا هنقيس اليوم الشغّال بسقف اليوم العادي.
      const s = await settingsNow({ pacePct: pulse.pacePct, base: stored, pulse });
      const offsetOf = (h) => ((Number(h) - BIZ_DAY_START_HOUR) + 24) % 24;
      const inWindow = pulse.elapsedH >= offsetOf(s.paceStartHour) && pulse.elapsedH <= offsetOf(s.paceLastRaiseHour);
      if (!mustSettle && !inWindow && !force) {
        return { ok: true, phase: "asleep", accountDay, pace: pulse.pacePct,
          gate: `برّه نافذة التسريع (${s.paceStartHour}:00 → ${s.paceLastRaiseHour}:00 بتوقيت الرياض) ومفيش زيادات مفتوحة تترجّع.` };
      }

      /* الحملات موقوفة أصلاً عشان المطعم قافل — رفع ميزانية دلوقتي بيغيّر رقم
         على حملة مش بتصرف، وبيخلّي التشغيل الساعة ١١ يرجّعها لرقم غلط. */
      const w = adsWindow(now, s);
      if (!mustSettle && !w.open && s.daypart !== false && !force) {
        return { ok: true, phase: "asleep", accountDay, pace: pulse.pacePct,
          gate: `${w.why} الحملات موقوفة، فمفيش ميزانية تتسرّع دلوقتي.` };
      }

      /* البوابة الرخيصة: النبض جوّه المنطقة الطبيعية ومفيش حاجة تترجّع →
         مفيش أي قرار ممكن يطلع، فمش هنضرب المنصات. الدورة بقت كل ٥ دقايق،
         ومن غير الفرع ده كنا هنعمل ١٢ نداء على المنصات كل ٥ دقايق طول اليوم
         عشان نطلع بـ "مفيش داعي نلمس أي ميزانية". */
      if (!mustSettle && !force && pulse.pacePct != null
        && pulse.pacePct < Number(s.paceUpThresholdPct) && pulse.pacePct > Number(s.paceDownThresholdPct)) {
        return { ok: true, phase: "hold", accountDay, pace: pulse.pacePct,
          gate: `الإيقاع ${pulse.pacePct >= 0 ? "+" : ""}${pulse.pacePct}٪ مقابل خط الأساس — جوّه المنطقة الطبيعية (${s.paceDownThresholdPct}٪ إلى ${s.paceUpThresholdPct}٪)، فمفيش داعي نلمس أي ميزانية.` };
      }

      const snap = await perfSnapshot({ from: todayISO(), to: todayISO() });

      /* ── منصة "مثبتة" يعني إيه ──────────────────────────────────────────
         قواعد التوسّع بتحطّ سقف صغير على منصة لسه ما جابتش نتيجة نقدر نعدّها
         (جوجل دلوقتي: صفر تحويل و٦١ رفعة فشلت أول يوم). السقف ده كان مكتوب
         في القاعدة بس مكانش موصّل — فجوجل خدت رفع لـ ١٢٥ ر.س وهي المفروض
         مسقوفة عند ١٠٠. الدليل المتاح هو نتايج المنصة على شباك أوسع من
         النهارده: يوم واحد بصفر نتايج مش دليل، أسبوع بصفر نتايج دليل.     */
      let proven = {};
      try {
        const wide = await perfSnapshot({ from: daysAgoISO(7), to: todayISO() });
        for (const r of wide.rows) {
          proven[r.platform] = (proven[r.platform] || 0) + (Number(r.results) || 0);
        }
        proven = Object.fromEntries(Object.entries(proven).map(([k, v]) => [k, v > 0]));
      } catch { proven = {}; }

      const decision = decidePace({
        rows: snap.rows.map((r) => ({ ...r, proven: proven[r.platform] ?? null })),
        state, s, now, accountDay, msToRoll, pulse,
        confirmed: pulse.confirmed, hardCap: MAX_DAILY_BUDGET,
      });

      if (!decision.actions.length) {
        return { ok: true, phase: decision.phase, accountDay, pace: pulse.pacePct,
                 gate: decision.gate, notes: decision.notes.length };
      }

      /* الوضع بيتحكم في الرفع والخفض بس. الاسترجاع بيتنفّذ في أي وضع:
         الزيادة اتعملت وإحنا في auto، ولو المالك حوّل لـ suggest بعدها
         تفضل الزيادة شغالة على حسابه لحد ما حد ياخد باله. رجوع الفلوس مش
         قرار محتاج موافقة — ده إتمام لقرار اتاخد خلاص. */
      const restores = decision.actions.filter((a) => a.op === "restore");
      const moves = decision.actions.filter((a) => a.op !== "restore");
      const canMove = s.mode === "auto" || force;

      /* في mode=suggest بنسجّل ملاحظة واحدة بتلخّص اللي كنا هنعمله. الدورة
         بتجري كل ١٥ دقيقة، فمن غير الفلتر ده هتكتب نفس الملاحظة أربع مرات
         في الساعة وتغرق شاشة القرارات. */
      if (!canMove && moves.length) {
        const recent = await pool.query(
          `SELECT 1 FROM ap_decisions WHERE kind='pace' AND status='info'
             AND created_at > NOW() - interval '1 hour' LIMIT 1`);
        if (!recent.rowCount) {
          await pool.query(
            `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
             VALUES ($1,NULL,NULL,NULL,NULL,'pace',$2,$3,'info')`,
            [crypto.randomUUID(),
             jb({ mode: s.mode, phase: decision.phase, pacePct: pulse.pacePct, wouldDo: moves }),
             `الإيقاع كان هيعمل ${moves.length} حركة دلوقتي (${moves.map((a) => `${a.campaignName}: ${a.from}→${a.to}`).join("، ")}) — بس الوضع "${s.mode}" مش "auto". ` +
             `التسريع اليومي مش بيتحط في طابور الموافقة عن قصد: الموافقة ممكن تيجي بعد ساعات وساعتها الزيادة هتترفع من غير أساس مسجّل ومحدش هيرجّعها. ` +
             `لو عايز التسريع يشتغل، حوّل الوضع لـ auto.`]);
        }
      }

      const todo = canMove ? decision.actions : restores;
      if (!todo.length) {
        return { ok: true, phase: decision.phase, accountDay, pace: pulse.pacePct,
                 mode: s.mode, executed: 0, wouldDo: moves.length };
      }

      const runId = crypto.randomUUID();
      await pool.query(`INSERT INTO ap_runs (id, status, summary) VALUES ($1,'running',$2)`,
        [runId, jb({ trigger, mode: s.mode, kind: "pace", phase: decision.phase, pace: pulse.pacePct })]);

      const results = [];
      for (const a of todo) {
        /* الأسوار مطلقة — نفس الدالة اللي الوكيل والقواعد الصمّاء بيعدّوا
           عليها. استثناءان مكتوبين بصوت عالي:
           • فترة التبريد اليومية (٢٤ ساعة) مش بتنطبق هنا: الإيقاع عنده
             تبريده بتاعه (٦٠ دقيقة) في ap_pacing.last_action_at، وسجله
             منفصل في ap_decisions بـ kind='pace'.
           • الاسترجاع بيتعدّى maxChangePct: السور ده موجود عشان الخوارزمية
             ما تتكسرش من نطة ميزانية، وإحنا في آخر يوم الحساب والتعلّم خلص.
             وفوق كده الاسترجاع دايماً بينزل بالميزانية لرقم المالك نفسه —
             منع رجوع الفلوس للمالك مش حماية، ده عطل. */
        const forGuard = a.op === "restore" ? { ...s, maxChangePct: 100 } : s;
        const refusal = guardBudget(
          { platform: a.platform, campaignId: a.campaignId, amount: a.to, level: a.level || null },
          forGuard, snap.rows, { writeOk: writeAllowed(), cooldown: new Set(), hardCap: MAX_DAILY_BUDGET });

        let status = "proposed", result = null, executedAt = null;
        if (refusal) {
          status = "refused";
          result = { ok: false, error: refusal };
        } else {
          /* وصلنا هنا يعني إما الوضع auto، أو دي عملية استرجاع — والاسترجاع
             بيعدّي في أي وضع (todo مفلترة فوق). القرارات اللي الوضع منعها
             خلاص اتسجّلت كملاحظة واحدة ومش بتوصل للّوب ده أصلاً. */
          const res = await executeDecision(
            { platform: a.platform, campaign_id: a.campaignId, kind: "pace", detail: { to: a.to } }, s);
          result = res;
          status = statusOf(res);
          executedAt = res.ok ? new Date() : null;
          if (res.ok) {
            if (a.op === "restore") {
              await pool.query(
                `UPDATE ap_pacing SET restored_at=NOW(), current_budget=$4
                  WHERE platform=$1 AND campaign_id=$2 AND account_day=$3::date`,
                [a.platform, a.campaignId, a.accountDay, a.to]);
            } else {
              /* `level` و`parent_id` بيتسجّلوا مع الزيادة عشان الاسترجاع
                 يرجّع بنفس المستوى. من غيرهم الزيادة على مجموعة إعلانية
                 مبترجعش، وبتبقى أساس اليوم اللي بعده من غير ما حد يلاحظ. */
              await pool.query(
                `INSERT INTO ap_pacing (platform, campaign_id, campaign_name, account_day,
                                        base_budget, current_budget, steps, last_action_at,
                                        level, parent_id)
                 VALUES ($1,$2,$3,$4::date,$5,$6,1,NOW(),$7,$8)
                 ON CONFLICT (platform, campaign_id, account_day) DO UPDATE
                   SET current_budget=EXCLUDED.current_budget, campaign_name=EXCLUDED.campaign_name,
                       steps=ap_pacing.steps+1, last_action_at=NOW(),
                       level=EXCLUDED.level, parent_id=EXCLUDED.parent_id`,
                [a.platform, a.campaignId, a.campaignName, a.accountDay, a.base, a.to,
                 a.level || "campaign", a.parentId || null]);
            }
          }
          /* لو الاسترجاع فشل بنسيب restored_at فاضية عن قصد — الدورة اللي
             بعدها هتشوفها كزيادة على يوم حساب قديم وتعيد المحاولة. */
        }

        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, executed_at)
           VALUES ($1,$2,$3,$4,$5,'pace',$6,$7,$8,$9,$10)`,
          [crypto.randomUUID(), runId, a.platform, a.campaignId, a.campaignName,
           jb({ op: a.op, from: a.from, to: a.to, base: a.base, accountDay: a.accountDay,
                accountTz: ADS_ACCOUNT_TZ, pacePct: pulse.pacePct, trigger,
                baseline: pulse.baseline, today: pulse.today, confirmed: pulse.confirmed }),
           a.reason, status, jb(result), executedAt]);
        results.push({ op: a.op, campaign: a.campaignName, from: a.from, to: a.to, status });
      }

      /* ── التسوية: الاسترجاع خلص، نكتب الحساب الحقيقي ────────────────────
         السقف كان توقّع. دلوقتي اليوم اللي صرفنا عليه قفل خلاص وبقى عندنا
         رقمه الحقيقي، فبنسجّل سطر واحد بيقول: اليوم استحق كام، صرفنا كام،
         والفرق. من غيره الوكيل بيسرّع كل يوم ومحدش بيعرف كان محق ولا لأ.

         ⚠️ الصرف لازم يتقرا لليوم اللي بنسوّيه هو بالظبط — مش لـ"النهارده".
         الحسبة دي بتشتغل حوالي ٩ الصبح بتوقيت جدة، يعني جوّه يوم الحساب
         الإعلاني اللي على وشك يقفل (بيلف ١٠ صباحاً). و`snap` فوق اتقرا بـ
         todayISO() اللي هو تاريخ UTC — وتاريخ UTC بيسبق يوم حساب ميتا
         (America/Los_Angeles) من ٣ الفجر لحد ١٠ الصبح بتوقيت جدة. يعني كنا
         بنطلب من ميتا يوم حساب لسه ما ابتداش، وميتا بترجّع صفر صفوف بـ
         HTTP 200 من غير أي خطأ — وإحنا كنا بنقراها "صرفنا صفر". النتيجة
         سطر بيقول للمالك "سبنا كل المستحق على الأرض" كل يوم، وهو كذب.
         (اتأكدنا من ميتا: يوم ٢٠٢٦-٠٨-١١ صرفه الحقيقي ٣١١٫١٢ ر.س، والسطر
         القديم قال صفر.)

         فبنقرا لقطة مخصوصة لليوم اللي بنسوّيه. وبنقراها بأولوية "owner"
         عشان خنقة المنصات ما تشيلهاش وتسيبنا نقرا صفر تاني.                */
      const restoredOk = results.filter((x) => x.op === "restore" && x.status === "auto_executed");
      if (restoredOk.length) {
        try {
          const settledDay = decision.actions.find((x) => x.op === "restore")?.accountDay || accountDay;
          const rev = await pool.query(
            `SELECT COALESCE(sum(total),0) AS rev FROM ts_orders
               WHERE calendar_day = $1::date
                 AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))`,
            [settledDay]);
          const paid = await perfSnapshot({ from: settledDay, to: settledDay, priority: "owner" });
          const spent = paid.rows.reduce((a2, r2r) => a2 + (Number(r2r.spend) || 0), 0);

          /* ولو مقدرناش نقرا الصرف أصلاً — منصة وقعت، توكن باظ، خنقة —
             الجمع بيطلع صفر وهو مش صفر، هو "مش عارفين". سطر بيقول "سبنا
             ٥٣٦ ر.س على الأرض" وإحنا أصلاً عميان أسوأ من مفيش سطر: المالك
             هيتصرف عليه. فبنكتب اللي حصل بالظبط بدل رقم مخترع.            */
          const blind = Object.entries(paid.reasons || {});
          if (!paid.rows.length) {
            await pool.query(
              `INSERT INTO ap_decisions (id, run_id, kind, detail, reason, status)
               VALUES ($1,$2,'reconcile',$3,$4,'info')`,
              [crypto.randomUUID(), runId,
               jb({ accountDay: settledDay, bizDay: settledDay, spend: null, unreadable: true,
                    reasons: paid.reasons || {} }),
               `تسوية يوم ${settledDay}: مقدرناش نقرا الصرف من أي منصة، فمش هنكتب رقم. `
               + (blind.length ? `السبب: ${blind.map(([p, why]) => `${p} — ${why}`).join(" · ")}. ` : "")
               + `الفرق بين "صرفنا صفر" و"مش عارفين صرفنا كام" هو الفرق بين تقرير وكذبة — فسبناها فاضية عن قصد.`]);
          } else {
            const rec = reconcileDay({
              realisedRevenue: Number(rev.rows[0]?.rev) || 0, spend: spent,
              sharePct: s.adsShareOfSalesPct, ceilingUsed: s.ceiling?.ceiling ?? null,
            });
            await pool.query(
              `INSERT INTO ap_decisions (id, run_id, kind, detail, reason, status)
               VALUES ($1,$2,'reconcile',$3,$4,'info')`,
              [crypto.randomUUID(), runId,
               jb({ ...rec, accountDay: settledDay, bizDay: settledDay, spendReadFor: settledDay,
                    accountTz: ADS_ACCOUNT_TZ, platformsRead: [...new Set(paid.rows.map((x) => x.platform))],
                    platformsBlind: paid.reasons || {} }),
               rec.reason
               + (blind.length
                 ? ` (ملحوظة: ${blind.map(([p]) => p).join("، ")} مش داخلة في رقم الصرف ده — ${blind.map(([p, why]) => `${p}: ${why}`).join(" · ")}.)`
                 : "")]);
          }
        } catch (e) { console.error("[autopilot] reconcile failed:", e.message); }
      }

      const summary = { trigger, mode: s.mode, kind: "pace", phase: decision.phase,
                        pace: pulse.pacePct, accountDay, breach: decision.breach || false,
                        delivery: decision.delivery?.pct ?? null, actions: results };
      await pool.query(`UPDATE ap_runs SET status='done', finished_at=NOW(), summary=$2 WHERE id=$1`,
        [runId, jb(summary)]);
      return { ok: true, runId, ...summary };
    } catch (e) {
      console.error("[autopilot] pace check error:", e.message);
      return { ok: false, error: String(e.message || e) };
    } finally {
      pacingRunning = false;
    }
  }

  /* ── THE CYCLE ─────────────────────────────────────────────────────────── */

  async function runCycle({ force = false, trigger = "cron" } = {}) {
    if (running) return { ok: false, error: "already running" };
    const s = await settingsNow();
    if (s.mode === "off" && !force) return { ok: false, skipped: "mode=off" };

    running = true;
    const runId = crypto.randomUUID();
    await pool.query(`INSERT INTO ap_runs (id, status) VALUES ($1,'running')`, [runId]);
    const summary = { trigger, mode: s.mode, capi: null, facts: null, decisions: 0, executed: 0, llm: null, audiences: null };
    try {
      // 1. conversions out (CAPI) — the optimisers must keep learning from money
      if (s.syncConversions && adsSync) {
        try {
          const r = await adsSync.syncOrders({ from: daysAgoISO(2), to: todayISO() });
          summary.capi = Object.fromEntries(Object.entries(r.platforms).map(([k, v]) => [k, { sent: v.sent || 0, skipped: v.skipped || 0, failed: v.failed || 0 }]));
        } catch (e) { summary.capi = { error: e.message }; }
      }

      // 2-3. facts
      const facts = await gatherFacts(s);
      summary.facts = {
        campaigns: facts.campaigns.length,
        platforms: Object.fromEntries(PLATFORMS.map((p) => [p.id, facts.reasons[p.id] ? "blocked" : "ok"])),
        avgDailySales: facts.sales.avgDaily,
        goalProgressPct: facts.sales.progressPct,
      };

      // budget-change cooldown set
      const cooldown = await budgetCooldownSet(s);

      // 4. rules
      const decisions = decide(facts.campaigns, s, cooldown);

      // Skip proposals that already sit unactioned in the queue for the same campaign+kind.
      const open = await pool.query(
        `SELECT platform, campaign_id, kind FROM ap_decisions WHERE status='proposed'`);
      const openSet = new Set(open.rows.map((r) => `${r.platform}:${r.campaign_id}:${r.kind}`));

      for (const d of decisions) {
        if (d.kind !== "note" && openSet.has(`${d.platform}:${d.campaignId}:${d.kind}`)) continue;
        const id = crypto.randomUUID();
        const executable = d.kind === "pause" || d.kind === "budget";
        let status = d.kind === "note" ? "info" : "proposed";
        let result = null, executedAt = null;

        // 6. auto mode executes inside the guardrails
        if (executable && s.mode === "auto") {
          const res = await executeDecision(
            { platform: d.platform, campaign_id: d.campaignId, kind: d.kind, detail: d.detail }, s);
          result = res;
          status = statusOf(res);
          executedAt = res.ok ? new Date() : null;
          if (res.ok) summary.executed++;
        }
        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, executed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, runId, d.platform, d.campaignId, d.campaignName, d.kind, jb(d.detail), d.reason, status, jb(result), executedAt]);
        summary.decisions++;
      }

      /* بصمة الوضع — بتتحسب مرة وبيستعملها المستشار والوكيل. */
      const fingerprint = situationFingerprint(facts, decisions, s);

      // 5. المستشار — خطة كرياتيف وعروض. مرة في اليوم، مش كل ساعة.
      if (s.useLlm && (facts.campaigns.length > 0 || Object.keys(facts.reasons).length < 3)) {
        const gate = await llmGate({ kind: "strategy", s, fingerprint, force });
        if (!gate.run) {
          summary.llm = { skipped: gate.why, tokensToday: gate.budget.used };
          await logLlmSkip(runId, "strategy", gate);
        } else try {
          const plan = await runStrategist(facts, decisions, s);
          if (plan) {
            summary.llm = { creatives: plan.creatives?.length || 0, offers: plan.offers?.length || 0 };
            await pool.query(
              `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
               VALUES ($1,$2,NULL,NULL,NULL,'strategy',$3,$4,'info')`,
              [crypto.randomUUID(), runId, jb({ ...plan, fingerprint }), plan.summary || ""]);
          }
        } catch (e) { summary.llm = { error: e.message }; }
      }

      // 6. الإسناد — بنربط أي طلب جديد بالـ leads بتاعته ونعيد بناء آخر أسبوع
      //    قبل ما الوكيل يقرا، عشان get_attribution يشوف أحدث أرقام.
      if (attribution?.sweepAndRoll) {
        try { summary.attribution = await attribution.sweepAndRoll({ days: 14 }); }
        catch (e) { summary.attribution = { error: e.message }; }
      }

      // 7. الوكيل — بيجري بعد القواعد الصمّاء عمداً: لو وقع، القرارات
      //    الحتمية تكون خلاص اتسجّلت واتنفّذت. مفيش اعتماد عليه.
      if (s.agent) {
        /* السبب اللي يستاهل ندهة: القواعد الصمّاء خدت قرار حقيقي (مش
           ملاحظة). ده بالظبط الموقف الملتبس اللي الوكيل موجود عشانه —
           «القواعد قررت كذا، شوف لو ده صح». اليوم اللي مفيهوش قرار مفيش
           فيه سؤال، والقواعد شغّالة فيه لوحدها زي ما هي. */
        const realDecisions = decisions.filter((d) => d.kind !== "note");
        const cause = (s.agentAlwaysOnDecision !== false && realDecisions.length)
          ? `القواعد الصمّاء خدت ${realDecisions.length} قرار الجولة دي — محتاج مراجعة`
          : null;
        const gate = await llmGate({ kind: "agent", s, fingerprint, force, reason: cause });
        if (!gate.run) {
          summary.agent = { skipped: gate.why, tokensToday: gate.budget.used };
          await logLlmSkip(runId, "agent", gate);
        } else try {
          const task = `جولة كاملة. الوضع باختصار: ${facts.campaigns.length} حملة على المنصات، ` +
            `متوسط المبيعات ${facts.sales.avgDaily} ر.س/يوم (الهدف ${s.goalDailySales}). ` +
            (decisions.length
              ? `محرك القواعد الصمّاء خد ${decisions.length} قرار في الجولة دي: ${decisions.map((d) => `${d.kind}/${d.campaignName || "—"}`).join("، ")}. متعيدش نفس القرارات.`
              : `محرك القواعد الصمّاء ماخدش أي قرار الجولة دي.`) +
            `\n\nراجع الوضع بنفسك بالأدوات: أداء الحملات، مردود القنوات (get_attribution) والمبيعات. ` +
            `دوّر على حاجتين بالذات: (أ) حملة كاسبة تستاهل تكبير جوه السقوف، (ب) صرف بيروح على قناة مردودها ضعيف. ` +
            `نفّذ اللي يستاهل، وسجّل بـ create_note أي حاجة مهمة مش من صلاحياتك.`;
          summary.agent = await runAgent({ runId, s, trigger, task, focus: FOCUS_FULL, fingerprint });
        } catch (e) { summary.agent = { error: e.message }; }
      }

      // 8. nightly audience refresh (once per calendar day, after midnight Riyadh)
      const riyadhDay = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
      /* سؤال «ليه اليوم اللي فات كان كده؟» — مرة في اليوم، ولمّا اليوم
         يكون شاذ فعلاً. مفيش نداء موديل هنا خالص: الحسبة SQL والسؤال نص
         جاهز، والرد بييجي من إنسان. */
      if (s.dayLog !== false && lastDayLogDay !== riyadhDay) {
        try { summary.dayLog = await askDayLog({}); lastDayLogDay = riyadhDay; }
        catch (e) { summary.dayLog = { error: e.message }; }
      }
      if (s.syncAudiences && audiencesSync && lastNightlyAudienceDay !== riyadhDay) {
        try {
          summary.audiences = await audiencesSync.syncAll({ trigger: "autopilot" });
          lastNightlyAudienceDay = riyadhDay;
        } catch (e) { summary.audiences = { error: e.message }; }
      }

      await pool.query(`UPDATE ap_runs SET status='done', finished_at=NOW(), summary=$2 WHERE id=$1`,
        [runId, jb(summary)]);
      return { ok: true, runId, summary };
    } catch (e) {
      await pool.query(`UPDATE ap_runs SET status='error', finished_at=NOW(), error=$2, summary=$3 WHERE id=$1`,
        [runId, String(e.message || e), jb(summary)]).catch(() => {});
      console.error("[autopilot] cycle error:", e.message);
      return { ok: false, error: e.message };
    } finally {
      running = false;
    }
  }

  /* ═══ ROUTES ═══════════════════════════════════════════════════════════ */

  app.get("/api/autopilot/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await getSettings();
    const lastRun = await pool.query(`SELECT * FROM ap_runs ORDER BY started_at DESC LIMIT 1`);
    const pending = await pool.query(`SELECT count(*)::int AS n FROM ap_decisions WHERE status='proposed'`);
    const sales = await pool.query(
      `SELECT COALESCE(sum(total),0) AS rev, count(DISTINCT calendar_day)::int AS days
         FROM ts_orders
        WHERE calendar_day >= (NOW() AT TIME ZONE 'utc')::date - 6
          AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))`);
    const avgDaily = sales.rows[0].days > 0 ? Number(sales.rows[0].rev) / sales.rows[0].days : 0;

    /* السطر اللي المالك بيقراه في عشر ثواني: صرفنا كام النهارده من المسموح.
       الصرف بيتقرا من المنصات نفسها (لقطة النهارده) — لو منصة مش مربوطة
       بترجّع سبب بدل صفر كذّاب. النبض بيدخل في حساب السقف عشان اليوم
       الشغّال يفتح سقف التوسّع في نفس السطر. */
    let pacePct = null, statusPulse = null;
    try { statusPulse = await pulseData(); pacePct = statusPulse.pacePct; } catch { /* المبيعات مش مقروءة */ }
    const eff = await settingsNow({ pacePct, base: s, pulse: statusPulse });
    let todaySpend = null, spendReasons = {};
    try {
      // يوم الحساب الإعلاني مش تاريخ UTC — شوف spendDayNow فوق.
      const snapToday = await perfSnapshot({ from: spendDayNow(), to: spendDayNow() });
      todaySpend = r2(snapToday.rows.reduce((a, r) => a + (Number(r.spend) || 0), 0));
      spendReasons = snapToday.reasons;
    } catch (e) { spendReasons = { _: String(e.message || e) }; }

    const w = adsWindow(new Date(), eff);
    const pausedByWindow = (await pool.query(
      `SELECT count(*)::int AS n FROM ap_daypart WHERE resumed_at IS NULL`)
      .catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;

    return c.json({
      ok: true,
      // الإعدادات المخزّنة زي ما هي — الفورم بيحفظ عليها. السقف المحسوب
      // بيترجع لوحده في `ceiling` عشان حفظ الفورم ما يثبّتهوش بالغلط.
      settings: s,
      ceiling: eff.ceiling,
      spendToday: todaySpend,
      spendReasons,
      pacePct,
      daypart: {
        enabled: s.daypart !== false,
        ...w,
        pausedCampaigns: pausedByWindow,
        running: daypartRunning,
        // الحقيقة من المنصة نفسها، مش من جدولنا. مخزّنة دقايق عشان القراءة
        // نفسها بتتحسب من حصة النداءات.
        verified: s.daypart === false ? null : await verifyDaypart().catch((e) => ({
          tone: "unknown", line: `مقدرناش نتأكد من المنصات: ${String(e.message || e)}`, platforms: [], mismatchCount: 0,
        })),
      },
      // المنصة بترفض والطيار بيعيد المحاولة — ده لازم يبقى صوت عالي مش سطر
      // في سجل. فاضية = مفيش رفض متكرر في آخر ٢٤ ساعة.
      alerts: await writeFailureAlerts().catch(() => []),
      writeEnabled: writeAllowed(),
      llmConfigured: !!llmProvider(),
      agentEnabled: !!(s.agent && llmProvider()),
      attributionWired: !!attribution,
      running,
      emergencyRunning,
      pacing: {
        enabled: s.pacing !== false,
        running: pacingRunning,
        accountDay: accountDayOf(),
        accountTz: ADS_ACCOUNT_TZ,
        minutesToAccountRoll: Math.round(msToAccountRoll() / 60000),
        openUplifts: (await pool.query(
          `SELECT count(*)::int AS n FROM ap_pacing WHERE restored_at IS NULL`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n,
      },
      lastRun: lastRun.rows[0] || null,
      pendingApprovals: pending.rows[0].n,
      goal: {
        dailySales: s.goalDailySales,
        avgDaily: Math.round(avgDaily),
        progressPct: s.goalDailySales > 0 ? Math.round((avgDaily / s.goalDailySales) * 100) : null,
      },
      platforms: PLATFORMS.map((p) => ({
        id: p.id, label: p.label,
        capi: canSend(p), manage: canManage(p),
        missingCapi: missingOf(p.conversionEnv),
        missingManage: missingOf(p.manageEnv),
      })),
    });
  });

  app.put("/api/autopilot/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
    if (b.mode && !["off", "suggest", "auto"].includes(b.mode)) {
      return c.json({ ok: false, error: "mode must be off|suggest|auto" }, 400);
    }
    const next = await saveSettings(b);
    return c.json({ ok: true, settings: next });
  });

  app.post("/api/autopilot/run-now", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await runCycle({ force: true, trigger: "manual" });
    return c.json(r, r.ok ? 200 : 409);
  });

  app.get("/api/autopilot/decisions", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") || 50), 300);
    const params = [];
    let where = "";
    if (status) { params.push(status); where = `WHERE status = $1`; }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM ap_decisions ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return c.json({ ok: true, decisions: r.rows });
  });

  app.post("/api/autopilot/decisions/:id/approve", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const r = await pool.query(`SELECT * FROM ap_decisions WHERE id=$1`, [id]);
    const dec = r.rows[0];
    if (!dec) return c.json({ ok: false, error: "not found" }, 404);
    if (dec.status !== "proposed") return c.json({ ok: false, error: `already ${dec.status}` }, 409);
    const s = await settingsNow();
    const res = await executeDecision(dec, s);
    await pool.query(
      `UPDATE ap_decisions SET status=$2, result=$3, executed_at=$4 WHERE id=$1`,
      [id, res.ok ? "executed" : "failed", jb(res), res.ok ? new Date() : null]);
    return c.json({ ok: res.ok, result: res }, res.ok ? 200 : 502);
  });

  app.post("/api/autopilot/decisions/:id/reject", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const r = await pool.query(
      `UPDATE ap_decisions SET status='rejected' WHERE id=$1 AND status='proposed' RETURNING id`, [id]);
    if (!r.rowCount) return c.json({ ok: false, error: "not found or not proposed" }, 404);
    return c.json({ ok: true });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     تسجيل حدث تم بره الدورة — الطريقة الوحيدة المسموحة

     في تغييرات بتحصل على الحساب الإعلاني وإحنا مش اللي عملناها في دورة:
     المالك عدّل بإيده، أو حد شغّل تغيير من الطرفية، أو المنصة رفضت حركة
     وإحنا محتاجين الرفض ده يبان في شريط المالك. من غير الباب ده الحل
     الوحيد بيبقى INSERT يدوي على قاعدة الإنتاج — وده بيتخطّى كل عقود
     الموديل: توليد الـ id، شكل الـ detail، ومفردات kind/status اللي
     logLine() بتقرا بيها. فالباب موجود، ومقفول بـ requireAdmin.

     status الافتراضي 'info' («للعلم») لإن الحدث حصل خلاص — مش اقتراح
     مستني موافقة. kind لازم يكون من مفردات logLine() عشان السطر يتقرا. */
  const NOTE_KINDS = new Set(["note", "pause", "resume", "budget", "strategy", "emergency"]);
  const NOTE_STATUSES = new Set(["info", "executed", "failed", "rejected", "refused"]);

  app.post("/api/autopilot/note", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const reason = String(b.reason || "").trim();
    if (!reason) return c.json({ ok: false, error: "reason required", message: "اكتب سبب الحدث — ده اللي المالك بيقراه" }, 400);
    const kind = String(b.kind || "note");
    if (!NOTE_KINDS.has(kind)) return c.json({ ok: false, error: `kind must be one of ${[...NOTE_KINDS].join("|")}` }, 400);
    const status = String(b.status || "info");
    if (!NOTE_STATUSES.has(status)) return c.json({ ok: false, error: `status must be one of ${[...NOTE_STATUSES].join("|")}` }, 400);

    const detail = { ...(b.detail && typeof b.detail === "object" ? b.detail : {}), manual: true, source: String(b.source || "operator") };
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, executed_at)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, b.platform ? String(b.platform) : null, b.campaignId ? String(b.campaignId) : null,
        b.campaignName ? String(b.campaignName) : null, kind, jb(detail), reason, status,
        status === "info" ? null : new Date()]);
    const row = await pool.query(`SELECT * FROM ap_decisions WHERE id=$1`, [id]);
    return c.json({ ok: true, id, line: logLine(row.rows[0]) });
  });

  /* ── تصليح السجل ────────────────────────────────────────────────────────
     ملاحظة اتكتبت من شل بترميز غلط بتتخزن حروف مكسّرة (؟؟؟؟ بدل عربي).
     الصف ده مش بيتصلّح بـ UPDATE بالإيد على الداتابيز — ده سجل قرارات،
     والتعديل عليه من برّه الموديول بيكسر أي افتراض جوّاه. فبنعدّي من هنا.

     والحارس مقصود: مسموح نمسح أو نصلّح **الملاحظات اليدوية** بس (اللي
     detail.manual = true)، أو صف حروفه مكسّرة فعلاً. قرار اتنفّذ على منصة
     — رفع ميزانية، إيقاف حملة — ده أثر مالي، وميتمسحش أبداً مهما كان.

     الكشف بيدوّر على U+FFFD (الحرف اللي بيطلع لما الترميز يضيع) وعلى
     علامات الموجيباكي المعروفة، مش على «فيه عربي غريب» — عشان ملاحظة
     سليمة متتشالش بالغلط. */
  const CORRUPT_RE = /�|[ØÙ][-¿]|â€/;
  const isCorrupt = (row) =>
    CORRUPT_RE.test(String(row?.reason || "")) ||
    CORRUPT_RE.test(String(row?.campaign_name || ""));
  const isManualNote = (row) => {
    const d = row?.detail;
    return !!(d && typeof d === "object" && d.manual === true);
  };

  /* بيرجّع الصفوف المكسّرة كلها — عبر التاريخ كله، مش آخر ٣٠٠. */
  app.get("/api/autopilot/decisions/corrupt", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    // الفلترة في JS مش في SQL عن قصد: تعبير U+FFFD جوّه SQL بيعتمد على
    // إعدادات ترميز الخادم، والحاجة اللي بندوّر عليها أصلاً هي ترميز باظ —
    // فمش هنبني الكشف على نفس الطبقة اللي وقعت.
    const r = await pool.query(
      `SELECT * FROM ap_decisions WHERE reason IS NOT NULL
        ORDER BY created_at DESC LIMIT 5000`);
    const rows = r.rows.filter(isCorrupt).map((row) => ({
      id: row.id, at: row.created_at, kind: row.kind, status: row.status,
      manual: isManualNote(row), reason: row.reason,
      deletable: isManualNote(row) || isCorrupt(row),
    }));
    return c.json({ ok: true, count: rows.length, rows });
  });

  app.patch("/api/autopilot/decisions/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    const reason = String(b.reason || "").trim();
    if (!reason) return c.json({ ok: false, error: "reason required" }, 400);
    const cur = await pool.query(`SELECT * FROM ap_decisions WHERE id=$1`, [id]);
    const row = cur.rows[0];
    if (!row) return c.json({ ok: false, error: "not found" }, 404);
    if (!isManualNote(row) && !isCorrupt(row)) {
      return c.json({
        ok: false, error: "refused",
        message: "ده قرار اتنفّذ على منصة، مش ملاحظة يدوية — نصّه مابيتغيّرش.",
      }, 409);
    }
    const r = await pool.query(
      `UPDATE ap_decisions SET reason=$2 WHERE id=$1 RETURNING *`, [id, reason]);
    return c.json({ ok: true, id, line: logLine(r.rows[0]) });
  });

  app.delete("/api/autopilot/decisions/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = c.req.param("id");
    const cur = await pool.query(`SELECT * FROM ap_decisions WHERE id=$1`, [id]);
    const row = cur.rows[0];
    if (!row) return c.json({ ok: false, error: "not found" }, 404);
    if (!isManualNote(row) && !isCorrupt(row)) {
      return c.json({
        ok: false, error: "refused",
        message: "ده قرار اتنفّذ على منصة — بيفضل في السجل. المسح للملاحظات اليدوية والصفوف المكسّرة بس.",
      }, 409);
    }
    await pool.query(`DELETE FROM ap_decisions WHERE id=$1`, [id]);
    return c.json({ ok: true, id, deleted: true, wasCorrupt: isCorrupt(row) });
  });

  /* سجل الوكيل — كل دورة تفكير: قال إيه، نده أنهي أداة، رجعله إيه، واتنفّذ
     ولا اترفض. ده اللي بيخلّي المالك يقرا "ليه" مش بس "إيه". */
  app.get("/api/autopilot/agent-log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(Number(c.req.query("limit") || 50), 300);
    const r = await pool.query(
      `SELECT id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, created_at
         FROM ap_decisions
        WHERE kind IN ('agent','emergency')
        ORDER BY created_at DESC LIMIT $1`, [limit]);
    const entries = r.rows.map((x) => ({
      id: x.id, runId: x.run_id, kind: x.kind, status: x.status, at: x.created_at,
      trigger: x.detail?.trigger || null,
      turn: x.detail?.turn ?? null,
      thinking: x.reason || "",
      tools: (x.detail?.tools || []).map((t) => ({
        name: t.name, input: t.input,
        ok: t.output?.ok !== false,
        refused: !!t.output?.refused,
        summary: t.output?.error
          || (t.output?.executed ? "اتنفّذ"
            : t.output?.queued ? "في طابور الموافقة"
            : t.output?.saved ? "ملاحظة اتسجّلت"
            : t.output?.range ? `قراءة ${t.output.range.from} → ${t.output.range.to}`
            : "قراءة"),
      })),
      refusal: x.status === "refused" ? x.detail?.refusal || x.reason : null,
      campaign: x.campaign_name || null,
      platform: x.platform || null,
      error: x.detail?.error || null,
      final: !!x.detail?.final,
    }));
    return c.json({
      ok: true,
      llmConfigured: !!llmProvider(),
      entries,
    });
  });

  /* تشغيل جولة الوكيل يدوياً — للاختبار وللمالك لما يكون مستعجل. */
  app.post("/api/autopilot/agent-run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await settingsNow();
    if (!llmProvider()) return c.json({ ok: false, error: "مفيش مزوّد LLM مضبوط" }, 503);
    /* الزرار اليدوي بيعدّي البوابة الزمنية والبصمة — المالك واقف قدام
       الشاشة وعايز رأي دلوقتي. بس الميزانية اليومية سقف مطلق حتى عليه:
       الرقم ده هو اللي بيمنع الفاتورة تجري تاني. */
    const budget0 = await tokenBudget(s);
    if (budget0.blocked) return c.json({ ok: false, error: budget0.why, budget: budget0 }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const runId = crypto.randomUUID();
    await pool.query(`INSERT INTO ap_runs (id, status, summary) VALUES ($1,'running',$2)`,
      [runId, jb({ trigger: "manual-agent", mode: s.mode })]);
    const task = String(b.task || "").slice(0, 4000) ||
      "جولة يدوية. راجع أداء الحملات ومردود القنوات والمبيعات، ونفّذ اللي يستاهل جوه الحدود.";
    const agent = await runAgent({ runId, s, trigger: "manual", task, focus: FOCUS_FULL });
    await pool.query(`UPDATE ap_runs SET status=$2, finished_at=NOW(), summary=$3 WHERE id=$1`,
      [runId, agent.ok ? "done" : "error", jb({ trigger: "manual-agent", mode: s.mode, agent })]);
    return c.json({ ok: agent.ok, runId, agent }, agent.ok ? 200 : 502);
  });

  /* فحص الطوارئ يدوياً. */
  app.post("/api/autopilot/emergency-check", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await runEmergencyCheck({ trigger: "manual" });
    return c.json(r, r.ok ? 200 : 409);
  });

  /* نبض المبيعات لايف — النهارده لحد دلوقتي مقابل نفس يوم الأسبوع. ده
     الرقم اللي كل قرارات الإيقاع بتتبني عليه، فبيترجع كامل بعيّنته وبدرجة
     ثقته عشان المالك يقدر يشكّك في القرار من نفس الشاشة. */
  app.get("/api/autopilot/pulse", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const pulse = await pulseData();
      const s = await settingsNow({ pacePct: pulse.pacePct, pulse });
      const open = await pacingState();
      const w = adsWindow(new Date(), s);

      /* ── السطر اللي المالك بيبصله وهو واقف ─────────────────────────────
         صرفنا كام، السقف كام دلوقتي، وفاضل كام. الصرف بيتقرا من المنصات —
         لو منصة مش مربوطة بيرجع سببها بدل صفر كذّاب. ولو كل المنصات وقعت
         بنقول مش عارفين بدل ما نقول فاضل السقف كله.                        */
      let spendToday = null, spendReasons = {};
      try {
        // يوم الحساب الإعلاني مش تاريخ UTC — شوف spendDayNow فوق. من غير
        // كده الرقم ده بيقرا صفر كل يوم من ٣ الفجر لحد ١٠ الصبح بتوقيت جدة،
        // والمالك بيشوف "فاضل السقف كله" وهو مش فاضل.
        const snapToday = await perfSnapshot({ from: spendDayNow(), to: spendDayNow() });
        spendReasons = snapToday.reasons;
        if (snapToday.rows.length) spendToday = r2(snapToday.rows.reduce((a, r) => a + (Number(r.spend) || 0), 0));
      } catch (e) { spendReasons = { _: String(e.message || e) }; }

      const eff = deliveryEfficiency({
        riyadhHour: pulse.riyadhHour, riyadhMinute: pulse.riyadhMinute || 0,
        adsCloseHour: w.closeHour, accountRollHourRiyadh: Number(s.accountRollHourRiyadh ?? 10),
      });
      const minEff = Number(s.minDeliveryEfficiencyPct ?? INTRADAY_DEFAULTS.minDeliveryEfficiencyPct);
      const cl = s.ceiling || {};
      const ceilingNow = Number(cl.ceiling) || 0;
      const headroom = spendToday == null ? null : r2(Math.max(0, ceilingNow - spendToday));
      /* المساحة اللي فاضلة بس الوقت مش سامح نصرفها — دي حقيقة لازم تتقال
         بدل ما نرفع ميزانية عارفين إنها مش هتتصرف. */
      const strandedHeadroom = headroom != null && eff.pct < minEff ? headroom : 0;

      /* سباق الرقم القياسي — للعرض بس، زيه زي التوقّع: عمره ما بيدخل في
         حساب سقف ولا في قرار ميزانية. لو الاستعلام وقع الشاشة بتكمل من
         غيره بدل ما النبض كله يرجع 500. */
      const record = await recordWatch({
        day: pulse.day, elapsedH: pulse.elapsedH, today: pulse.today,
        projected: cl.projection?.usable ? cl.projection.projected : null,
      }).catch((e) => {
        console.error("[autopilot] recordWatch failed:", e.message);
        return null;
      });

      return c.json({
        ok: true,
        ...pulse,
        ceiling: cl,
        record,
        /* كل الأرقام اللي الشاشة محتاجاها في مكان واحد — الواجهة مبتحسبش
           حاجة، عشان الرقم اللي المالك بيشوفه يبقى هو نفسه الرقم اللي
           القرار اتاخد بيه. والسطر اللي بيلخّص الموديل كله:
             دخل النهارده X → مسموح Y (٢٠٪) → صرفنا Z → فاضل W          */
        budget: {
          // ١) دخل النهارده — الرقم اللي كل حاجة بتتحسب منه
          revenueToday: pulse.today.revenue,
          revenueHighWater: cl.highWater ?? null,
          ratcheted: !!cl.ratcheted,
          ordersToday: pulse.today.orders,
          // ٢) المسموح = ٢٠٪ منه، بأرضية
          sharePct: s.adsShareOfSalesPct,
          earned: cl.earned ?? null,
          floorCeiling: cl.floorCeiling ?? null,
          ceiling: ceilingNow,
          binding: cl.binding ?? null,          // "earned" يعني الدخل هو اللي بيحكم
          trailingAvg: cl.trailing7Avg ?? null,
          // ٣) صرفنا كام  ٤) فاضل كام
          spendToday, spendReasons,
          headroom,
          headroomPct: spendToday == null || ceilingNow <= 0 ? null
            : Math.max(0, Math.round(((ceilingNow - spendToday) / ceilingNow) * 100)),
          pctOfRevenueSpent: spendToday != null && pulse.today.revenue > 0
            ? Math.round((spendToday / pulse.today.revenue) * 1000) / 10 : null,
          // السطر الواحد اللي المالك يقدر يراجع حسابه بعينه
          line: `دخل النهارده ${ar(pulse.today.revenue)} ر.س → مسموح تصرف ${ar(ceilingNow)} ر.س` +
            `${cl.binding === "floor" ? ` (أرضية — المستحق لسه ${ar(cl.earned ?? 0)})` : ` (${s.adsShareOfSalesPct}٪)`}` +
            `${spendToday == null ? "" : ` → صرفنا ${ar(spendToday)} → فاضل ${ar(headroom)}`}`,
          // التوصيل: هل الزيادة دلوقتي هتلحق تشتغل أصلاً
          delivery: eff, minDeliveryEfficiencyPct: minEff,
          strandedHeadroom,
          canRaiseNow: eff.pct >= minEff && w.open && (headroom == null || headroom > 0),
          why: eff.pct < minEff
            ? `${eff.reason} فالـ ${ar(headroom ?? 0)} ر.س الفاضلين دول مستحقين فعلاً، بس رفعهم دلوقتي مش هيتصرف — بنسيبهم.`
            : !w.open ? w.why
              : headroom != null && headroom <= 0
                ? `صرفنا ${ar(spendToday)} ر.س والسقف ${ar(ceilingNow)} — مفيش مساحة زيادة لحد ما يدخل دخل جديد.`
                : `${cl.reason || ""}`,
          /* التوقّع: للعرض بس. مفصول عن كل اللي فوق عن قصد — عمره ما بيدخل
             في السقف، عشان رقم خطأه ٥١٪ ما يوسّعش سقف المالك فاكره مربوط
             بفلوس حقيقية. */
          outlook: cl.outlook
            ? { ...cl.outlook, binding: false,
                note: "ده تقدير لشكل اليوم، مش أساس أي قرار ميزانية — السقف بيتحسب من الدخل اللي دخل فعلاً وبس." }
            : null,
          reconcileNote: `آخر اليوم بنقارن اللي صرفناه بـ ${s.adsShareOfSalesPct}٪ من الدخل النهائي وبنسجّل الفرق. الفرق الوحيد الممكن ييجي من الأرضية (${ar(cl.floorCeiling ?? 0)} ر.س) — اللي فوقها مستحيل يعدّي الـ ${s.adsShareOfSalesPct}٪.`,
        },
        adsWindow: w,
        pacing: {
          enabled: s.pacing !== false && s.mode !== "off",
          mode: s.mode,
          window: `${s.paceStartHour}:00 → ${s.paceLastRaiseHour}:00 بتوقيت الرياض`,
          thresholds: { up: s.paceUpThresholdPct, down: s.paceDownThresholdPct },
          step: s.paceStepPct, maxUplift: s.paceMaxUpliftPct,
          cooldownMinutes: s.paceCooldownMinutes,
          restoreBeforeMin: s.paceRestoreBeforeMin,
          openUplifts: [...open.values()].map((v) => ({
            platform: v.platform, campaignId: v.campaignId, campaignName: v.campaignName,
            accountDay: v.accountDay, base: v.baseBudget, current: v.currentBudget, steps: v.steps,
          })),
        },
      });
    } catch (e) {
      console.error("[autopilot] pulse failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* تشغيل دورة الإيقاع بإيد المالك — بيتخطى البوابة الزمنية بس، مش الأسوار. */
  app.post("/api/autopilot/pace-now", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const r = await runPaceCheck({ trigger: "manual", force: b.force === true });
    return c.json(r, r.ok ? 200 : 409);
  });

  /* ═══════════════════════════════════════════════════════════════════════
     اللوج البسيط — «كل القرارات وسببها بطريقة سهلة»

     شريط واحد مسطّح، الأحدث فوق. مفيش فلاتر ومفيش تبويبات — الفلترة الوحيدة
     هي إننا بنشيل دورات تفكير الوكيل الخام (بتتعرض في الشاشة التفصيلية).
     ═══════════════════════════════════════════════════════════════════════ */
  /* الصيغة اللي المالك بيقراها. اتفصلت عن الـ route عشان تقرير الأسبوع في
     reports.js يعرض نفس السطور بالحرف بدل ما يعيد صياغة القرارات من تاني.
     من غير from/to بتشتغل بشباك متدحرج زي ما كانت؛ مع from/to بتقص على
     يوم العمل بتاع TabSense (٤ الفجر بتوقيت جدة) — نفس حدود المبيعات. */
  async function logData({ days = 7, limit = 60, from = null, to = null } = {}) {
    const ranged = !!(from && to);
    const r = await pool.query(
      ranged
        ? `SELECT id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, created_at
             FROM ap_decisions
            WHERE (((created_at AT TIME ZONE '${RIYADH_TZ}') - interval '4 hours')::date)
                  BETWEEN $1::date AND $2::date
            ORDER BY created_at DESC LIMIT $3`
        : `SELECT id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, created_at
             FROM ap_decisions
            WHERE created_at > NOW() - ($1 || ' days')::interval
            ORDER BY created_at DESC LIMIT $2`,
      ranged ? [from, to, limit * 3] : [String(days), limit * 3]);

    /* ── الملاحظات المكرّرة بتتلمّ في سطر واحد ─────────────────────────
       القواعد الصمّاء بتعيد نفس الملاحظة لكل حملة في كل جولة — «لسه في
       فترة التعلّم» بتتكتب ٦ مرات كل ساعة. من غير اللمّة دي أول شاشة
       المالك بتبقى نفس الجملة اتكتبت ٢٤ مرة، والقرار الحقيقي اللي فوقها
       مش هيشوفه.

       بنلمّ الملاحظات بس (اللي نتيجتها «للعلم»). أي حاجة اتنفّذت أو
       اترفضت أو مستنية موافقة بتفضل سطر لوحدها مهما اتكررت — إن الوكيل
       رفع نفس الميزانية مرتين مش تكرار، ده حدثين. */
    const entries = [];
    const seen = new Map();
    for (const row of r.rows) {
      const line = logLine(row);
      if (!line) continue;
      // الساعة بتوقيت جدة — المالك بيقرا بيها، ومفيش سبب يشوف UTC.
      const at = line.at ? new Date(line.at) : null;
      if (at && !isNaN(at)) {
        const cl = tzClock(at, RIYADH_TZ);
        const dow = DOW_AR[new Date(bizDayOf(at) + "T00:00:00Z").getUTCDay()];
        line.clock = `${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")}`;
        line.day = cl.day;
        line.dayLabel = dow;
      }
      if (line.outcome === "للعلم") {
        const sig = `${line.type}|${line.campaign || ""}|${line.title}`;
        const hit = seen.get(sig);
        if (hit) { hit.repeats = (hit.repeats || 1) + 1; continue; }
        line.repeats = 1;
        seen.set(sig, line);
      }
      entries.push(line);
      if (entries.length >= limit) break;
    }
    return { tz: RIYADH_TZ, days: ranged ? null : days, from, to, types: LOG_TYPES, entries };
  }

  app.get("/api/autopilot/log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 60), 1), 300);
    const days = Math.min(Math.max(Number(c.req.query("days") || 7), 1), 90);
    return c.json({ ok: true, ...(await logData({ days, limit })) });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     اقتصاديات الاكتساب — الأرقام اللي المالك طلبها بالحرف

     «بشرط تحديد قيمة للعميل على المدى الطويل وتحديد عدد العملاء الجدد
      المفروض أكتسبهم كل يوم وعدد العملاء اللي بيتم إعادة استهدافهم.»

     كل رقم هنا محسوب من ts_orders و ts_customers و order_sources — مفيش
     رقم صناعة، ومفيش تقدير سوق. والصدق الأهم في الملف ده: مطعم عمره شهور
     قليلة، فالقيمة العمرية المقاسة هي أرضية مش توقّع — العميل اللي جالنا
     الشهر ده لسه قدامه سنين يطلب فيها ما اتحسبتش. بنقول ده صراحة مع الرقم.
     ═══════════════════════════════════════════════════════════════════════ */

  const ECON_IDENT = `COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,''))`;
  const ECON_CTE = `
    ${FIRST_ORDER_DAY_CTE},
    known AS (
      SELECT ${ECON_IDENT} AS ident, o.order_id, o.calendar_day, o.total
        FROM ts_orders o
        LEFT JOIN order_sources s ON s.order_id = o.order_id
        LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
       WHERE ${SALES_ONLY_SQL} AND ${ECON_IDENT} IS NOT NULL
    ),
    lifetime AS (
      SELECT k.ident, f.first_day, max(k.calendar_day) AS last_day,
             count(*)::int AS orders, sum(k.total) AS revenue
        FROM known k LEFT JOIN firsts f ON f.pn = k.ident
       GROUP BY 1, 2
    )`;

  async function economicsData(from, to) {
    const s = await settingsNow();
    const bizToday = bizDayOf();
    const days = Math.max(1,
      Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);

    /* (١) العمر الكامل لكل عميل معروف — مش الشباك. القيمة العمرية بتتقاس
           على كل تاريخه، وقصّها على شباك بتخليها متوسط فاتورة مش LTV. */
    const life = (await pool.query(
      `WITH ${ECON_CTE}
       SELECT count(*)::int AS customers,
              COALESCE(sum(revenue),0) AS revenue,
              COALESCE(sum(orders),0)::int AS orders,
              count(*) FILTER (WHERE orders >= 2)::int AS repeaters,
              count(*) FILTER (WHERE orders >= 3)::int AS loyal,
              min(first_day)::text AS first_day,
              max(last_day)::text AS last_day
         FROM lifetime`)).rows[0];

    /* (٢) القيمة التراكمية ٣٠/٦٠/٩٠ يوم — بس للأفواج اللي عدّى عليها المدة
           دي فعلاً. فوج عمره أسبوعين مالوش رقم ٩٠ يوم، وعرضه كصفر كذب. */
    const cum = (await pool.query(
      `WITH ${ECON_CTE},
       cum AS (
         SELECT l.ident, l.first_day,
                COALESCE(sum(k.total) FILTER (WHERE k.calendar_day <= l.first_day + 30),0) AS v30,
                COALESCE(sum(k.total) FILTER (WHERE k.calendar_day <= l.first_day + 60),0) AS v60,
                COALESCE(sum(k.total) FILTER (WHERE k.calendar_day <= l.first_day + 90),0) AS v90
           FROM lifetime l JOIN known k ON k.ident = l.ident
          WHERE l.first_day IS NOT NULL
          GROUP BY 1, 2
       )
       SELECT count(*) FILTER (WHERE first_day + 30 <= $1::date)::int AS n30,
              COALESCE(avg(v30) FILTER (WHERE first_day + 30 <= $1::date),0) AS avg30,
              count(*) FILTER (WHERE first_day + 60 <= $1::date)::int AS n60,
              COALESCE(avg(v60) FILTER (WHERE first_day + 60 <= $1::date),0) AS avg60,
              count(*) FILTER (WHERE first_day + 90 <= $1::date)::int AS n90,
              COALESCE(avg(v90) FILTER (WHERE first_day + 90 <= $1::date),0) AS avg90
         FROM cum`, [bizToday])).rows[0];

    /* (٣) الشباك: جديد مقابل راجع بنفس قاعدة الـ API كلها. */
    const win = (await pool.query(
      `WITH ${ECON_CTE}
       SELECT count(DISTINCT k.ident)::int AS customers,
              count(DISTINCT k.ident) FILTER (WHERE f.first_day BETWEEN $1::date AND $2::date)::int AS new_customers,
              count(DISTINCT k.ident) FILTER (WHERE f.first_day < $1::date)::int AS returning_customers,
              COALESCE(sum(k.total),0) AS revenue,
              COALESCE(sum(k.total) FILTER (WHERE f.first_day < k.calendar_day),0) AS returning_revenue,
              COALESCE(sum(k.total) FILTER (WHERE f.first_day >= k.calendar_day OR f.first_day IS NULL),0) AS new_revenue,
              count(*)::int AS orders
         FROM known k LEFT JOIN firsts f ON f.pn = k.ident
        WHERE k.calendar_day BETWEEN $1::date AND $2::date`, [from, to])).rows[0];

    const daily = (await pool.query(
      `WITH ${ECON_CTE}
       SELECT k.calendar_day::text AS day,
              count(DISTINCT k.ident) FILTER (WHERE f.first_day = k.calendar_day)::int AS new_customers,
              count(DISTINCT k.ident)::int AS customers,
              COALESCE(sum(k.total),0) AS revenue
         FROM known k LEFT JOIN firsts f ON f.pn = k.ident
        WHERE k.calendar_day BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 1`, [from, to])).rows;

    /* (٤) المبيعات الكاملة (بما فيها الطلبات اللي مالهاش هوية) — عشان نقول
           التغطية بصراحة: أي رقم عميل هنا مبني على الطلبات اللي عرفنا صاحبها. */
    const all = (await pool.query(
      `SELECT count(*)::int AS orders, COALESCE(sum(total),0) AS revenue,
              count(DISTINCT calendar_day)::int AS days
         FROM ts_orders
        WHERE calendar_day BETWEEN $1::date AND $2::date
          AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))`,
      [from, to])).rows[0];

    /* (٥) صرف الإعلانات والعملاء الجداد المسندين — من موديول الإسناد.

       «مسند» هنا معناها: عميل جديد وقع على قناة فيها صرف إعلاني
       (totals.paid.newCustomers). كان الرقم ده بيتقرا من totals.newCustomers
       — اللي هو كل عميل جديد في المطعم مهما جه منين — فكانت «التكلفة اللي
       بندفعها فعلاً (مسندة)» بتطلع نفس الرقم المخلوط بالظبط وبتقول عن نفسها
       إنها مسندة. رقم مخلوط بيلبس اسم رقم مسند أخطر من إنه ما يكونش موجود. */
    let spend = null, attributedNew = null, attributionNote = null;
    if (attribution?.overviewData) {
      try {
        const ov = await attribution.overviewData(from, to);
        spend = Number(ov?.totals?.paid?.spend) || 0;
        attributedNew = Number(ov?.totals?.paid?.newCustomers) || 0;
      } catch (e) { attributionNote = `مقدرناش نقرا الإسناد: ${String(e.message || e)}`; }
    } else {
      attributionNote = "موديول الإسناد مش مربوط — مفيش صرف إعلانات ولا عملاء مسندين في الحسبة.";
    }

    /* (٦) الريتارجيت: كام واحد في الجماهير، وكام اتبعت فعلاً لكل منصة. */
    const retarget = { segments: [], lastSyncs: [], wired: !!audiencesSync?.segmentSizes };
    if (audiencesSync?.segmentSizes) {
      try { retarget.segments = await audiencesSync.segmentSizes(); }
      catch (e) { retarget.error = String(e.message || e); }
    }
    try {
      retarget.lastSyncs = (await pool.query(
        `SELECT DISTINCT ON (platform, segment) platform, segment, size, status, created_at
           FROM aud_syncs ORDER BY platform, segment, created_at DESC`)).rows;
    } catch { retarget.lastSyncs = []; }
    retarget.reached = retarget.lastSyncs
      .filter((x) => x.status === "sent")
      .reduce((a, x) => a + (Number(x.size) || 0), 0);
    retarget.returningCustomers = Number(win.returning_customers) || 0;
    retarget.returningRevenue = r2(win.returning_revenue);

    const econ = shapeEconomics({
      customers: Number(life.customers) || 0,
      lifetimeRevenue: Number(life.revenue) || 0,
      lifetimeOrders: Number(life.orders) || 0,
      repeaters: Number(life.repeaters) || 0,
      goalDailySales: Number(s.goalDailySales) || 10000,
      sharePct: Number(s.adsShareOfSalesPct) || 20,
      grossMarginPct: Number(s.grossMarginPct) || 65,
      windowDays: days,
      newCustomersInWindow: Number(win.new_customers) || 0,
      returningRevenueInWindow: Number(win.returning_revenue) || 0,
      salesInWindow: Number(all.revenue) || 0,
      adSpendInWindow: spend,
      attributedNewCustomers: attributedNew,
      allowedSpendToday: s.ceiling?.ceiling ?? null,
    });

    const obsDays = life.first_day
      ? Math.max(1, Math.round((Date.parse(bizToday + "T00:00:00Z") - Date.parse(life.first_day + "T00:00:00Z")) / 86400000))
      : 0;
    const coverage = Number(all.orders) > 0 ? Math.round((Number(win.orders) / Number(all.orders)) * 1000) / 10 : null;

    return {
      range: { from, to, days },
      economics: econ,
      ltvWindows: {
        d30: { customers: Number(cum.n30) || 0, avg: r2(cum.avg30) },
        d60: { customers: Number(cum.n60) || 0, avg: r2(cum.avg60) },
        d90: { customers: Number(cum.n90) || 0, avg: r2(cum.avg90) },
        note: "كل رقم محسوب على الأفواج اللي عدّى عليها المدة دي فعلاً. الفوج اللي لسه ما كملش المدة مش داخل في الحسبة أصلاً — مش بيتحسب صفر.",
      },
      observation: {
        firstOrderDay: life.first_day, lastOrderDay: life.last_day, days: obsDays,
        note: obsDays < 180
          ? `أقدم عميل معروف عندنا أول طلب ليه من ${ar(obsDays)} يوم. يعني القيمة العمرية اللي فوق دي **أرضية مقاسة مش توقّع**: العميل اللي جه الشهر ده لسه قدامه شهور هيطلب فيها ما اتحسبتش. الرقم الحقيقي أعلى، وبيكبر لوحده كل ما الوقت يعدّي — فأي قرار مبني عليه بيبقى في الجانب الآمن.`
          : `فترة الملاحظة ${ar(obsDays)} يوم — طويلة كفاية إن القيمة العمرية تبقى قريبة من الحقيقة.`,
      },
      window: {
        orders: Number(all.orders) || 0, revenue: r2(all.revenue),
        identifiedOrders: Number(win.orders) || 0,
        identifiedRevenue: r2(win.revenue),
        customers: Number(win.customers) || 0,
        newCustomers: Number(win.new_customers) || 0,
        returningCustomers: Number(win.returning_customers) || 0,
        newRevenue: r2(win.new_revenue),
        returningRevenue: r2(win.returning_revenue),
        coveragePct: coverage,
        coverageNote: coverage == null ? "مفيش طلبات في الشباك."
          : `${coverage}٪ من طلبات الشباك عرفنا صاحبها برقم جوال. الباقي (زيارات كاش من غير تسجيل) مش داخل في عدّ العملاء — يعني عدد العملاء الحقيقي أعلى من اللي فوق.`,
      },
      daily: daily.map((d) => ({
        day: d.day, newCustomers: Number(d.new_customers) || 0,
        customers: Number(d.customers) || 0, revenue: r2(d.revenue),
      })),
      spend: { total: spend, attributedNewCustomers: attributedNew, note: attributionNote },
      budgetRule: {
        ...(s.ceiling || {}),
        sharePct: s.adsShareOfSalesPct,
        absoluteMax: s.absoluteMaxTotalBudget,
        spentTodayNote: "السقف ده هو اللي كل قرارات الميزانية بتتقاس عليه — القاعدة الصمّاء والتسريع اليومي والوكيل، كلهم بيقروا نفس الرقم.",
      },
      retarget,
      notes: [
        "الإيراد شامل الضريبة (نفس رقم الفاتورة)، والملغي والمرتجع مستبعدين.",
        "«عميل جديد» = طلب داخل الشباك وعمره ما طلب قبله — نفس التعريف المستعمل في كل تقارير النظام.",
        "القيمة العمرية بتتقاس على كل تاريخ العميل مش على الشباك المختار — قصّها على شباك بيخليها متوسط فاتورة.",
        "العملاء اللي بيدفعوا كاش من غير ما يسيبوا رقم مش محسوبين — التغطية مكتوبة فوق بالنسبة.",
      ],
    };
  }

  app.get("/api/autopilot/economics", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    let from = isDay(c.req.query("from")) ? c.req.query("from") : daysAgoISO(29);
    let to = isDay(c.req.query("to")) ? c.req.query("to") : todayISO();
    if (from > to) { const t = from; from = to; to = t; }
    try {
      return c.json({ ok: true, ...(await economicsData(from, to)) });
    } catch (e) {
      console.error("[autopilot] economics failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* تشغيل فحص نافذة الإعلانات بإيد المالك. */
  app.post("/api/autopilot/daypart-now", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const r = await runDaypartCheck({ trigger: "manual", force: b.force === true });
    return c.json(r, r.ok ? 200 : 409);
  });

  /* GET /api/autopilot/daypart-verify?force=1
     «الإعلانات موقوفة فعلاً ولا لأ؟» — بيسأل المنصات نفسها. */
  /* ═══ سطر الصحة الواحد ═══════════════════════════════════════════════════
     المالك مش هيقف يراجع مع الوكيل. فالسؤال اللي الشاشة لازم تجاوب عليه
     واحد: «كل حاجة شغالة؟» — والإجابة سطر واحد، مش أربعين عدّاد.

     ولو السطر أحمر لازم يقول تلات حاجات مع بعض: إيه اللي باظ، وإيه اللي مش
     بيحصل بسببه، ومين اللي يقدر يصلّحه. «تيك توك بترجّع 40001» مش سطر صحة.
     «تيك توك مش بتقرا أرقامها، وده مش بيوقف صرف ولا بيع، ومستني موافقة تيك
     توك نفسها مش موافقتك» — ده سطر الصحة.

     الترتيب بالتكلفة مش بعدد الأسطر في اللوج: حاجة بتخلّي فلوس تتصرف غلط
     دلوقتي بتيجي فوق أي حاجة تانية مهما كانت بتطبع رسايل أكتر منها.        */

  const OWNER_ACTIONS = {
    metaTier: {
      what: "ميتا مدّياها أصغر حصة نداءات (development access)، فأوامر الإيقاف ساعات القفل بتستنّى دورها في الطابور.",
      screen: "Meta → Business Settings → Accounts → Apps → اختار التطبيق → App Review → Permissions and Features",
      button: "زرار «Request Advanced Access» جنب ads_management",
      why: "بالحصة الحالية الطيار بيوقف الإعلانات على مهل. بالحصة الكبيرة بيوقفها فوراً.",
    },
    tiktokReview: {
      what: "تيك توك لسه بتراجع التطبيق بتاعنا، فمابنقدرش نقرا أرقامها ولا نرفع عليها جماهير.",
      screen: "TikTok for Business → Developers → My Apps",
      button: "مفيش زرار تدوسه — المراجعة عند تيك توك نفسها. الحالة لازم تبقى Approved.",
      why: "ده بيأثّر على القراءة والجماهير بس. الصرف والإيقاف والتشغيل على تيك توك شغّالين عادي.",
    },
  };

  async function healthNow({ priority = "verify" } = {}) {
    const s = await settingsNow();
    const w = adsWindow(new Date(), s);
    const gates = writeGates();

    /* الرفض الحقيقي بس. الأمر اللي إحنا اللي أجّلناه (deferred) مش رفض من
       المنصة — لو عددناه هنا هنقيس سكوتنا إحنا ونقول إن المنصة بترفض. */
    const refusals = await pool.query(
      `SELECT platform, count(*)::int n,
              (array_agg(result->>'error' ORDER BY created_at DESC))[1] last_error,
              count(*) FILTER (WHERE kind='daypart')::int daypart_n
         FROM ap_decisions
        WHERE status='failed' AND platform IS NOT NULL
          AND COALESCE(result->>'failureKind','') <> 'unavailable'
          AND created_at > NOW() - interval '24 hours'
        GROUP BY platform HAVING count(*) >= 3`).catch(() => ({ rows: [] }));

    const verdict = await verifyDaypart({ priority }).catch(() => null);
    const problems = [];

    /* أوامر إيقاف اتأجّلت والمطبخ قافل = إعلانات شغالة على ساعات مفيهاش بيع.
       بنقولها صريحة من غير ما نقرا المنصة، عشان في الحالة دي بالظبط إحنا
       مش بنقرا (الحصة محجوزة للأمر نفسه) — والسكوت هنا هيبقى أسوأ من
       القراءة: إحنا *عارفين* إن الأمر ماخرجش، مش بنخمّن. */
    const deferred = await pool.query(
      `SELECT count(*)::int n, count(DISTINCT campaign_id)::int camps
         FROM ap_decisions
        WHERE kind='daypart' AND status='deferred'
          AND detail->>'op' = 'pause'
          AND created_at > NOW() - interval '90 minutes'`).catch(() => ({ rows: [{ n: 0 }] }));
    const defN = deferred.rows[0]?.n || 0;
    if (!w.open && defN > 0) {
      const mins = gates.length ? Math.min(...gates.map((g) => g.minutes)) : null;
      problems.push({
        rank: 1, tone: "bad", who: "agent",
        line: `🚨 المطبخ قافل و${ar(deferred.rows[0]?.camps || 0)} حملة لسه شغالة — أمر الإيقاف اتأجّل عشان المنصة مخنوقة`
          + (mins ? ` (بنعيد بعد ${ar(mins)} دقيقة).` : "."),
        prevents: "بنصرف على ساعات مفيهاش بيع دلوقتي.",
      });
    }

    /* ١ — أغلى حاجة ممكنة: بندفع والمطبخ قافل، أو موقوفين والمطعم فاتح. */
    if (verdict && verdict.tone === "bad") {
      problems.push({
        rank: 1, tone: "bad", who: "agent",
        line: verdict.line,
        prevents: w.open
          ? "الإعلانات موقوفة والمطعم فاتح — بنخسر طلبات دلوقتي."
          : "بنصرف على ساعات المطبخ فيها قافل — فلوس بتضيع دلوقتي.",
      });
    }

    /* ٢ — الطيار متقفل بإيدنا: مايقدرش يعمل حاجة أصلاً. */
    if (!writeAllowed()) {
      problems.push({
        rank: 2, tone: "bad", who: "owner",
        line: "الكتابة على المنصات مقفولة (ADS_ALLOW_WRITE مش '1') — الطيار بيقرا ويقترح بس.",
        prevents: "مفيش إيقاف ولا تشغيل ولا تعديل ميزانية. ساعات القفل هتفضل بتصرف.",
        action: { what: "افتح الكتابة على المنصات", screen: "Coolify → freshcuts-api → Environment Variables", button: "ADS_ALLOW_WRITE = 1 وبعدين Redeploy" },
      });
    } else if (s.mode === "off") {
      problems.push({
        rank: 2, tone: "warn", who: "owner",
        line: "الطيار متوقف (الوضع «off») — مش بياخد أي قرار.",
        prevents: "مفيش إيقاف ساعات القفل ولا تسريع ولا خفض.",
        action: { what: "شغّل الطيار", screen: "شاشة الطيار الآلي → التحكم", button: "زرار «تلقائي»" },
      });
    }

    /* ٣ — المنصة بترفض أوامرنا فعلاً (مش تأجيل مننا). */
    for (const r of refusals.rows) {
      const g = gates.find((x) => x.platform === r.platform);
      if (g && g.kind === "unavailable") continue;
      const isMeta = r.platform === "meta";
      problems.push({
        rank: r.daypart_n >= 3 ? 3 : 6,
        tone: r.daypart_n >= 3 ? "bad" : "warn",
        who: isMeta ? "owner" : "agent",
        line: `${byId(r.platform)?.label || r.platform}: ${ar(r.n)} أمر اترفض في ٢٤ ساعة. آخر رد: «${r.last_error || "بدون سبب"}».`,
        prevents: r.daypart_n >= 3
          ? "أوامر إيقاف ساعات القفل بتتأخّر — يعني صرف على ساعات مفيهاش بيع."
          : "بعض تعديلات الميزانية مش بتوصل.",
        ...(isMeta ? { action: OWNER_ACTIONS.metaTier } : {}),
      });
    }

    /* ٤ — أبواب مقفولة مش من عندنا. المؤقّت منها مش مشكلة أصلاً — ده الطيار
       بيتصرّف صح — فاللي بيتعرض هنا هو الدايم بس.

       بنسأل المنصة نفسها (lastReadiness) مش الباب بتاع الكتابة: تيك توك
       بتترفض في القراءة أكتر بكتير مما بتترفض في الكتابة، فلو استنينا
       أمر كتابة عشان نعرف إنها مش متاحة ممكن نستنى أيام. */
    const seenUnavailable = new Set();
    for (const p of PLATFORMS) {
      const r = p.lastReadiness?.();
      const g = gates.find((x) => x.platform === p.id && x.kind === "unavailable");
      if (!r && !g) continue;
      if (seenUnavailable.has(p.id)) continue;
      seenUnavailable.add(p.id);
      const isTikTok = p.id === "tiktok";
      /* السبب ممكن ميكونش موجود: الاستعداد اتسجّل من غير `reason`. قبل كده
         كان الجمع بيطلع `undefined` والمالك كان بيقرا حرفياً «Google Ads:
         undefined» على شاشة الحالة. سبب مش معروف مش سبب — فبنقول إننا مش
         عارفين، ونخفّض النبرة، بدل ما نأكّد عطل مش متأكدين منه. */
      const reason = r?.reason || g?.reason || null;
      problems.push({
        rank: reason ? 8 : 12,
        tone: "warn",
        who: reason ? "owner" : "us",
        line: reason
          ? `${p.label}: ${reason}`
          : `${p.label}: الباب مقفول من المنصة من غير ما تقول السبب — مش متأكدين إيه اللي ناقص.`,
        prevents: isTikTok
          ? "قراءة أرقام تيك توك ورفع الجماهير عليها. الصرف والإيقاف شغّالين."
          : "رفع الطلبات للمنصة دي. القراءة والتحكم في الحملات شغّالين.",
        ...(isTikTok && reason ? { action: OWNER_ACTIONS.tiktokReview } : {}),
      });
    }

    /* ٥ — منصة مش مربوطة أصلاً. */
    for (const p of PLATFORMS) {
      const miss = missingOf(p.manageEnv);
      if (!miss.length) continue;
      problems.push({
        rank: 9, tone: "warn", who: "owner",
        line: `${p.label}: مش مربوطة — ناقص ${miss.join("، ")}.`,
        prevents: `الطيار مش بيشوف ${p.label} خالص.`,
        action: { what: `اربط ${p.label}`, screen: "Coolify → freshcuts-api → Environment Variables", button: `ضيف ${miss.join("، ")} وبعدين Redeploy` },
      });
    }

    problems.sort((a, b) => a.rank - b.rank);
    const worst = problems[0] || null;
    const bad = problems.filter((x) => x.tone === "bad");

    /* السطر نفسه. لو مفيش مشاكل بيقول كده بالبلدي؛ ولو فيه بيقول أخطرها
       واحدة — مش كلها، عشان السطر يفضل سطر. الباقي تحته في `problems`. */
    let line, tone;
    if (!problems.length) {
      tone = "good";
      line = w.open
        ? "كل حاجة شغالة — الإعلانات شغالة والمطعم فاتح، والطيار بيتابع."
        : "كل حاجة شغالة — المطبخ قافل والإعلانات موقوفة زي ما المفروض.";
    } else {
      tone = bad.length ? "bad" : "warn";
      const rest = problems.length - 1;
      const act = worst.who === "owner" && worst.action
        ? ` محتاج منك: ${worst.action.button ? `${worst.action.screen} ← ${worst.action.button}` : worst.action.screen}`
        : " الطيار بيتصرّف لوحده، مش محتاج حاجة منك.";
      line = `${bad.length ? "🚨" : "⚠️"} ${worst.line} ${worst.prevents}${act}`
        + (rest > 0 ? ` (وكمان ${ar(rest)} حاجة أقل خطورة تحت)` : "");
    }

    /* استهلاك الموديل النهارده — بيطلع في نفس السطر اللي المالك بيقراه.
       ده اللي مانعه يجري في الضلمة تاني: الرقم قدام عينه كل ما يفتح. */
    let llm = null;
    try {
      const b = await tokenBudget(await getSettings());
      llm = { usedToday: b.used, cap: b.cap, pct: b.pct, blocked: b.blocked };
    } catch { /* المحاسبة مش سبب يوقّع السطر */ }

    return {
      at: new Date().toISOString(),
      tone, line,
      llm,
      needsOwner: problems.filter((x) => x.who === "owner").length,
      window: { open: w.open, label: w.label, clock: w.clock },
      problems,
      gates: gates.map((g) => ({ platform: g.platform, kind: g.kind, minutes: g.minutes, reason: g.reason })),
      verified: verdict ? { tone: verdict.tone, line: verdict.line, mismatchCount: verdict.mismatchCount } : null,
    };
  }

  /* GET /api/autopilot/health — السطر الواحد. */
  app.get("/api/autopilot/health", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const owner = c.req.query("owner") === "1";
    return c.json({ ok: true, ...(await healthNow({ priority: owner ? "owner" : "verify" })) });
  });

  app.get("/api/autopilot/daypart-verify", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    /* ?force=1 هو زرار «افحص تاني» اللي المالك بيدوسه بإيده وهو قدام
       الشاشة — ده بيعدّي الباب المقفول عن قصد. أما القراءة الدورية اللي
       الصفحة بتعملها كل دقيقتين فبتفضل تليمتري وبتتأجّل لو المنصة مخنوقة. */
    const forced = c.req.query("force") === "1";
    const v = await verifyDaypart({ force: forced, priority: forced ? "owner" : "verify" });
    return c.json({ ok: true, ...v, alerts: await writeFailureAlerts().catch(() => []) });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     «ليه اليوم ده كان كويس؟» — أصغر حاجة مفيدة

     المشكلة اللي المالك حطّ إيده عليها: النظام بيسجّل «كام» و«إمتى» بدقة،
     ومحدش بيسجّل **«ليه»**. يوم ١٣ و١٤ أغسطس عملوا ٤٬١٩٧ و٤٬٦٣٧ ر.س على
     صرف عادي (٣٠٩ و٦٠٨ ر.س) ومحدش يعرف السبب.

     ── الداتا لوحدها بتقول نص الجواب ────────────────────────────────────
     قِسنا الأيام الكويسة من ts_order_items، والنمط واضح:
       ٧ أغسطس:  ٤٫٠٤ صنف/طلب، متوسط الفاتورة ٨٥٫٢ ر.س، إيراد ٣٬٩١٧
       ١٣ أغسطس: ٣٫٨٢ صنف/طلب، متوسط الفاتورة ٨٥٫٧ ر.س، إيراد ٤٬١٩٧
       ١٤ أغسطس: ٣٫١٢ صنف/طلب، متوسط الفاتورة ٧٨٫٦ ر.س، إيراد ٤٬٦٣٧
       اليوم العادي: ٢٫٤–٢٫٩ صنف/طلب، متوسط الفاتورة ٥٥–٦٣ ر.س
     وسعر الصنف الواحد فضل ثابت (٢٠–٢٥ ر.س) في كل الأيام. يعني الأيام
     الكويسة **مش أيام زحمة، دي أيام سلّة أكبر**. الإعلانات بتجيب طلبات؛
     السلّة الأكبر بتيجي من حاجة تانية خالص — عرض، بندل، مؤثّر، مناسبة.

     ── والنص التاني لازم إنسان يقوله ────────────────────────────────────
     فالتصميم: النظام بيحسب الانحراف والسبب **الرقمي** لوحده (سلّة ولا
     زحمة)، وبيسأل سؤال واحد بس، ولمّا يكون فيه سبب يسأله — يوم شاذ فعلاً.
     الرد اختيار من لستة قصيرة ثابتة (عشان يتحوّل لقاعدة بعدين) + سطر حر.
     يوم عادي مبيتسألش أصلاً؛ من غير الشرط ده السؤال بيبقى ضجيج والرد
     بيبقى فاضي.                                                          */
  const DAYLOG_TAGS = [
    "عرض/خصم شغّال", "بندل أو كومبو جديد", "منشور مؤثّر/كرياتيف اشتغل",
    "مناسبة أو إجازة", "عرض على تطبيق توصيل", "طلب كبير/مناسبة خاصة",
    "الطقس", "صنف جديد في المنيو", "تغيير سعر", "زحمة المنطقة", "مش عارف",
  ];

  /* أرقام يوم واحد + خط أساس من نفس يوم الأسبوع. نفس منطق النبض بالظبط
     (وسيط نفس يوم الأسبوع) عشان الرقمين يتكلموا نفس اللغة. */
  async function dayShapeOf(day) {
    const r = await pool.query(
      `WITH o AS (
         SELECT order_id, calendar_day, total FROM ts_orders
          WHERE calendar_day <= $1::date AND calendar_day > $1::date - 42
            AND (order_type IS NULL OR (order_type NOT ILIKE '%void%' AND order_type NOT ILIKE '%refund%'))
       ), it AS (SELECT order_id, sum(qty) AS q FROM ts_order_items GROUP BY 1)
       SELECT o.calendar_day::text AS day, count(*)::int AS orders,
              round(sum(o.total),2)::float8 AS revenue,
              round(avg(o.total),2)::float8 AS avg_ticket,
              round(sum(COALESCE(it.q,0))::numeric / NULLIF(count(*),0), 2)::float8 AS items_per_order
         FROM o LEFT JOIN it ON it.order_id = o.order_id
        GROUP BY 1 ORDER BY 1`, [day]);
    const rows = r.rows;
    const today = rows.find((x) => x.day === day);
    if (!today) return null;
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const same = rows.filter((x) => x.day !== day
      && new Date(`${x.day}T00:00:00Z`).getUTCDay() === dow).slice(-4);
    const base = {
      revenue: medianOf(same.map((x) => x.revenue)),
      orders: medianOf(same.map((x) => x.orders)),
      avgTicket: medianOf(same.map((x) => x.avg_ticket)),
      itemsPerOrder: medianOf(same.map((x) => x.items_per_order)),
      days: same.length,
    };
    const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    const devRev = pct(today.revenue, base.revenue);
    const devTicket = pct(today.avg_ticket, base.avgTicket);
    const devOrders = pct(today.orders, base.orders);
    /* أي رقم اتحرك؟ ده الجزء اللي الداتا بتجاوبه لوحدها، والسؤال اللي
       بنسأله للإنسان بيتبني عليه. */
    const driver = devTicket == null || devOrders == null ? "none"
      : Math.abs(devTicket) >= 12 && Math.abs(devOrders) >= 12 ? "both"
      : Math.abs(devTicket) > Math.abs(devOrders) ? "ticket"
      : Math.abs(devOrders) > 12 ? "traffic" : "none";
    return { day, today, base, devRev, devTicket, devOrders, driver };
  }

  /* بيتنده مرة في اليوم. بيسأل عن اليوم اللي فات لما يكون شاذ فعلاً. */
  async function askDayLog({ day = null, force = false } = {}) {
    const target = day || new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    const already = await pool.query(`SELECT biz_day FROM ap_daylog WHERE biz_day=$1::date`, [target]);
    if (already.rows.length && !force) return { ok: true, skipped: "اليوم ده مسجّل خلاص" };
    const sh = await dayShapeOf(target);
    if (!sh) return { ok: false, error: `مفيش طلبات ليوم ${target}` };
    if (sh.base.days < 2 && !force) return { ok: true, skipped: "مفيش خط أساس كفاية لنفس يوم الأسبوع" };
    const s = await getSettings();
    const th = Math.max(10, Number(s.dayLogDeviationPct) || 25);
    if (Math.abs(Number(sh.devRev) || 0) < th && !force) {
      return { ok: true, skipped: `يوم عادي (${sh.devRev}٪ عن الوسيط) — مفيش سؤال يستاهل` };
    }
    let spend = null;
    try {
      const snap = await perfSnapshot({ from: target, to: target });
      spend = r2(snap.rows.reduce((a, x) => a + (Number(x.spend) || 0), 0));
    } catch { /* الصرف مش شرط عشان نسأل */ }
    await pool.query(
      `INSERT INTO ap_daylog (biz_day, revenue, orders, avg_ticket, items_per_order, spend, dev_pct, driver)
       VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (biz_day) DO UPDATE SET revenue=$2, orders=$3, avg_ticket=$4,
         items_per_order=$5, spend=$6, dev_pct=$7, driver=$8`,
      [target, sh.today.revenue, sh.today.orders, sh.today.avg_ticket,
       sh.today.items_per_order, spend, sh.devRev, sh.driver]);
    return { ok: true, asked: target, ...sh, spend };
  }

  /* السؤال بالعربي — الشاشة بتعرضه زي ما هو. الصياغة بتقول للمالك اللي
     إحنا عارفينه بالفعل، فهو بيكمّل الناقص بس مش بيعيد الحسبة. */
  function dayLogQuestion(row) {
    const up = Number(row.dev_pct) >= 0;
    const head = `${row.biz_day}: ${Math.round(Number(row.revenue)).toLocaleString("en")} ر.س — ${up ? "أعلى" : "أقل"} من المعتاد بـ ${Math.abs(Math.round(Number(row.dev_pct)))}٪.`;
    const why = row.driver === "ticket"
      ? `عدد الطلبات عادي بس متوسط الفاتورة ${Number(row.avg_ticket).toFixed(0)} ر.س و${Number(row.items_per_order).toFixed(1)} صنف في الطلب — يعني الناس اشترت أكتر، مش إن ناس أكتر جت.`
      : row.driver === "traffic"
        ? `متوسط الفاتورة عادي بس عدد الطلبات ${row.orders} — يعني ناس أكتر جت، والسلّة زي ما هي.`
        : row.driver === "both"
          ? `الاتنين اتحركوا: ${row.orders} طلب ومتوسط فاتورة ${Number(row.avg_ticket).toFixed(0)} ر.س.`
          : `الأرقام اتحركت من غير نمط واضح في السلّة ولا عدد الطلبات.`;
    return `${head} ${why} كان فيه إيه اليوم ده؟`;
  }

  /* GET /api/autopilot/daylog — الأيام الشاذة وردودها. */
  app.get("/api/autopilot/daylog", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(Math.max(Number(c.req.query("days") || 60), 1), 365);
    const r = await pool.query(
      `SELECT biz_day::text AS biz_day, revenue, orders, avg_ticket, items_per_order, spend,
              dev_pct, driver, tags, note, answered_by, asked_at, answered_at
         FROM ap_daylog WHERE biz_day > (NOW() AT TIME ZONE 'utc')::date - $1::int
        ORDER BY biz_day DESC`, [days]);
    return c.json({
      ok: true, tags: DAYLOG_TAGS,
      rows: r.rows.map((x) => ({ ...x, question: dayLogQuestion(x), answered: !!x.answered_at })),
      pending: r.rows.filter((x) => !x.answered_at).length,
    });
  });

  /* POST /api/autopilot/daylog — الرد. {day, tags[], note, by} */
  app.post("/api/autopilot/daylog", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const day = String(b.day || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ ok: false, error: "day لازم يكون YYYY-MM-DD" }, 400);
    const tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).slice(0, 60)).slice(0, 6) : [];
    const note = String(b.note || "").slice(0, 2000);
    if (!tags.length && !note) return c.json({ ok: false, error: "محتاجين على الأقل تصنيف واحد أو سطر شرح" }, 400);
    /* الصف ممكن ما يكونش موجود لو المالك قرر يشرح يوم النظام ماسألش عنه —
       ده مسموح، وبنملّي الأرقام من نفس الحسبة عشان الصف يفضل مقروء. */
    const sh = await dayShapeOf(day).catch(() => null);
    await pool.query(
      `INSERT INTO ap_daylog (biz_day, revenue, orders, avg_ticket, items_per_order, dev_pct, driver, tags, note, answered_by, answered_at)
       VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (biz_day) DO UPDATE SET tags=$8, note=$9, answered_by=$10, answered_at=NOW()`,
      [day, sh?.today.revenue ?? null, sh?.today.orders ?? null, sh?.today.avg_ticket ?? null,
       sh?.today.items_per_order ?? null, sh?.devRev ?? null, sh?.driver ?? null,
       tags, note, String(b.by || "owner").slice(0, 60)]);
    return c.json({ ok: true, day, tags, note });
  });

  /* POST /api/autopilot/daylog/ask — تشغيل الفحص بإيدك (force=true يسأل عن أي يوم). */
  app.post("/api/autopilot/daylog/ask", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    return c.json(await askDayLog({ day: b.day || null, force: b.force === true }));
  });

  /* GET /api/autopilot/llm-usage — «التوكنز راحت فين؟» جواب بالأرقام.
     بيرجّع كل يوم مقسوم على الغرض والموديل، عشان السؤال ما يفضلش تخمين. */
  app.get("/api/autopilot/llm-usage", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(Math.max(Number(c.req.query("days") || 14), 1), 90);
    const rows = await pool.query(
      `SELECT day::text AS day, purpose, model, calls,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, billed_tokens
         FROM ap_llm_usage WHERE day > (NOW() AT TIME ZONE 'utc')::date - $1::int
        ORDER BY day DESC, billed_tokens DESC`, [days]);
    const byDay = {};
    for (const r of rows.rows) {
      const d = (byDay[r.day] ||= { day: r.day, calls: 0, billed: 0, purposes: {} });
      d.calls += Number(r.calls); d.billed += Number(r.billed_tokens);
      d.purposes[r.purpose] = (d.purposes[r.purpose] || 0) + Number(r.billed_tokens);
    }
    const s0 = await getSettings();
    return c.json({ ok: true, budget: await tokenBudget(s0),
      days: Object.values(byDay), rows: rows.rows });
  });

  app.get("/api/autopilot/runs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(Number(c.req.query("limit") || 20), 100);
    const r = await pool.query(`SELECT * FROM ap_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
    return c.json({ ok: true, runs: r.rows });
  });

  console.log("[autopilot] routes ready");
  return { runCycle, runEmergencyCheck, runAgent, runPaceCheck, runDaypartCheck, pulseData, economicsData, logData,
           verifyDaypart, writeFailureAlerts, askDayLog, dayShapeOf, tokenBudget };
}
