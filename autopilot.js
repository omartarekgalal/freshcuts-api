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
   • kill rule: CPA > killMultiple × targetCpa (with real spend) → pause.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import {
  PLATFORMS, byId, canSend, canManage, missingOf,
  redact, safeRequest, httpJson, writeAllowed, MAX_DAILY_BUDGET, DEFAULT_CURRENCY,
} from "./ads.js";
// قاعدة "العميل الجديد" الواحدة في الـ API كلها. الاقتصاديات تحت مبنية عليها
// بالحرف — لو حسبنا العملاء الجداد هنا بطريقة تانية هنقول للمالك رقمين
// مختلفين لنفس السؤال من نفس الداتا.
import { FIRST_ORDER_DAY_CTE } from "./analytics.js";

/* ── LLM (same provider chain as ai.js — Anthropic direct, else LiteLLM) ──── */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const LITELLM_BASE = (process.env.LITELLM_BASE || "https://llm.o2m8.me/v1").replace(/\/+$/, "");
const AI_MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const LLM_TIMEOUT_MS = 180000;

function llmProvider() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: AI_MODEL };
  }
  if (process.env.LITELLM_KEY) {
    const model = AI_MODEL.includes("/") ? AI_MODEL : `anthropic/${AI_MODEL}`;
    return { kind: "litellm", key: process.env.LITELLM_KEY, model };
  }
  return null;
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
    if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

async function llmTool(provider, { system, user, tool, maxTokens = 8000 }) {
  const post = llmPost;
  if (provider.kind === "anthropic") {
    const data = await post(ANTHROPIC_URL,
      { "x-api-key": provider.key, "anthropic-version": ANTHROPIC_VERSION },
      {
        model: provider.model, max_tokens: maxTokens, system,
        messages: [{ role: "user", content: user }],
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
        tool_choice: { type: "tool", name: tool.name },
      });
    const block = (data.content || []).find((b) => b.type === "tool_use");
    if (!block) throw new Error("model returned no tool_use block");
    return block.input;
  }
  const data = await post(`${LITELLM_BASE}/chat/completions`,
    { authorization: `Bearer ${provider.key}` },
    {
      model: provider.model, max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    });
  const call = ((data.choices || [])[0]?.message?.tool_calls || [])[0];
  if (!call) throw new Error("model returned no tool call");
  return JSON.parse(call.function.arguments || "{}");
}

/* ── دورة محادثة واحدة بأدوات حقيقية ────────────────────────────────────────
   نفس سلسلة المزوّدين، بس بدل ما نجبر الموديل على أداة واحدة، بنديله عدة
   أدوات وبنسيبه يقرر — وبنرجّع الرد بشكل موحّد مهما كان المزوّد.
   `native` هو رسالة المساعد بصيغة المزوّد نفسه عشان تترجّع في المحادثة زي
   ما هي (مينفعش نعيد تركيبها بإيدينا — هنكسر تسلسل الـ tool ids).          */
function toolSpecs(provider, tools) {
  return provider.kind === "anthropic"
    ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))
    : tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
}

async function llmTurn(provider, { system, messages, tools, maxTokens = 4000 }) {
  if (provider.kind === "anthropic") {
    const data = await llmPost(ANTHROPIC_URL,
      { "x-api-key": provider.key, "anthropic-version": ANTHROPIC_VERSION },
      { model: provider.model, max_tokens: maxTokens, system, messages, tools: toolSpecs(provider, tools) });
    const blocks = data.content || [];
    return {
      native: { role: "assistant", content: blocks },
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
      calls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
      stop: data.stop_reason || null,
      usage: data.usage || null,
    };
  }
  const data = await llmPost(`${LITELLM_BASE}/chat/completions`,
    { authorization: `Bearer ${provider.key}` },
    {
      model: provider.model, max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
      tools: toolSpecs(provider, tools),
    });
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
  targetCpa: 12,              // SAR per purchase the ads should hit
  targetRoas: 4,              // revenue / spend the ads should hit
  minSpend: 50,               // SAR spent in the window before we judge at all
  minAgeDays: 2,              // campaign must be at least this old
  scaleStepPct: 25,           // budget increase step for winners
  cutStepPct: 30,             // budget decrease step for underperformers
  maxChangePct: 30,           // hard cap on any single budget change
  killMultiple: 3,            // CPA > killMultiple × targetCpa → pause
  maxCampaignBudget: 500,     // SAR/day ceiling per campaign
  maxTotalBudget: 1000,       // احتياطي بس — السقف الحقيقي بيتحسب من المبيعات
                              // (شوف movingCeiling تحت). الرقم ده بيُستعمل لما
                              // المبيعات مش متقروءة أصلاً.
  budgetCooldownHours: 24,    // min hours between budget changes per campaign
  syncConversions: true,      // push CAPI events each cycle
  syncAudiences: true,        // refresh retargeting audiences nightly
  useLlm: true,               // creative briefs + strategy notes
  agent: true,                // الوكيل الذكي (تفكير + أدوات) — غير قواعد التشغيل
  agentMaxTurns: 8,           // سقف دورات المحادثة في الجولة الواحدة
  emergencyCooldownHours: 6,  // نفس الطوارئ ما تتفتحش تاني قبل كده
  platforms: { meta: true, tiktok: true, snapchat: true },
};

/* أقصى عدد دورات مهما قال الإعداد — سياج أخير ضد لوب لا نهائي بيحرق توكنز. */
const AGENT_TURN_CEILING = 12;

/* ── Rules engine — pure function, unit-testable, no I/O ───────────────────────
   Input rows: { platform, id, name, status, dailyBudget, ageDays,
                 w3: {spend, results, revenue}, w7: {spend, results, revenue} }
   Output: decisions [{kind, platform, campaignId, campaignName, detail, reason}]
   The 3-day window decides; the 7-day window is context in the reason text.  */
export function decide(rows, s, recentBudgetChanges = new Set()) {
  const out = [];
  const activeBudget = rows
    .filter((r) => r.status === "ACTIVE" && r.dailyBudget != null)
    .reduce((a, r) => a + r.dailyBudget, 0);

  for (const r of rows) {
    const w = r.w3 || { spend: 0, results: 0, revenue: 0 };
    const w7 = r.w7 || { spend: 0, results: 0, revenue: 0 };
    const cpa = w.results > 0 ? w.spend / w.results : null;
    const roas = w.spend > 0 ? w.revenue / w.spend : null;
    const fmt = (n) => (n == null ? "—" : Math.round(n * 100) / 100);
    const ctx = `آخر ٣ أيام: صرف ${fmt(w.spend)} ر.س، ${w.results ?? 0} نتيجة` +
      (cpa != null ? `، تكلفة النتيجة ${fmt(cpa)} ر.س` : "") +
      (roas != null ? `، العائد ${fmt(roas)}x` : "") +
      ` · آخر ٧ أيام: صرف ${fmt(w7.spend)} ر.س، ${w7.results ?? 0} نتيجة`;

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

    // ── KILL: burning money with no or terrible results ──────────────────
    const killing = (w.results === 0 && w.spend >= s.minSpend * 2)
      || (cpa != null && cpa > s.killMultiple * s.targetCpa);
    if (killing) {
      out.push({ kind: "pause", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: { state: "PAUSED" },
        reason: w.results === 0
          ? `صرفت ${fmt(w.spend)} ر.س في ٣ أيام بدون أي نتيجة — قاعدة القتل. ${ctx}`
          : `تكلفة النتيجة ${fmt(cpa)} ر.س أكتر من ${s.killMultiple}× المستهدف (${s.targetCpa} ر.س) — قاعدة القتل. ${ctx}` });
      continue;
    }

    if (r.dailyBudget == null) {
      out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
        detail: {}, reason: `الميزانية متظبطة على مستوى المجموعة الإعلانية مش الحملة — الوكيل بيدير ميزانيات الحملات بس، فدي إدارتها يدوي. ${ctx}` });
      continue;
    }
    if (recentBudgetChanges.has(`${r.platform}:${r.id}`)) continue; // cooldown

    // ── SCALE: beating target → step the budget up, capped twice over ─────
    const winning = (cpa != null && cpa <= s.targetCpa) || (roas != null && roas >= s.targetRoas);
    if (winning) {
      const stepPct = Math.min(s.scaleStepPct, s.maxChangePct);
      let next = Math.round(r.dailyBudget * (1 + stepPct / 100));
      next = Math.min(next, s.maxCampaignBudget);
      const headroom = s.maxTotalBudget - activeBudget;
      if (next - r.dailyBudget > headroom) next = r.dailyBudget + Math.max(0, Math.floor(headroom));
      if (next > r.dailyBudget) {
        out.push({ kind: "budget", platform: r.platform, campaignId: r.id, campaignName: r.name,
          detail: { from: r.dailyBudget, to: next },
          reason: `أداء أحسن من المستهدف${cpa != null ? ` (تكلفة النتيجة ${fmt(cpa)} ≤ ${s.targetCpa} ر.س)` : ` (عائد ${fmt(roas)}x ≥ ${s.targetRoas}x)`} — تكبير تدريجي ${stepPct}٪ عشان الخوارزمية ما تتكسرش. ${ctx}` });
      } else if (r.dailyBudget >= s.maxCampaignBudget) {
        out.push({ kind: "note", platform: r.platform, campaignId: r.id, campaignName: r.name,
          detail: {}, reason: `الحملة كاسبة بس وصلت سقف الميزانية (${s.maxCampaignBudget} ر.س/يوم). لو عايز توسّع أكتر ارفع السقف من الإعدادات — أو الأحسن: انسخ الحملة بجمهور جديد. ${ctx}` });
      }
      continue;
    }

    // ── CUT: worse than 1.5× target but not kill-worthy → step down ───────
    if (cpa != null && cpa > 1.5 * s.targetCpa) {
      const stepPct = Math.min(s.cutStepPct, s.maxChangePct);
      const next = Math.max(20, Math.round(r.dailyBudget * (1 - stepPct / 100)));
      if (next < r.dailyBudget) {
        out.push({ kind: "budget", platform: r.platform, campaignId: r.id, campaignName: r.name,
          detail: { from: r.dailyBudget, to: next },
          reason: `تكلفة النتيجة ${fmt(cpa)} ر.س أعلى من 1.5× المستهدف (${s.targetCpa} ر.س) — تقليل الميزانية ${stepPct}٪ لحد ما الأداء يتحسن. ${ctx}` });
      }
    }
  }
  return out;
}

/* ── الأسوار كدوال نقية ────────────────────────────────────────────────────
   نفس معاملة decide(): مفيش I/O، فتتجرّب من غير سيرفر ولا قاعدة بيانات.
   بترجّع نص الرفض بالعربي، أو null لو الطلب جوه الحدود. الوكيل بيمر عليها
   قبل أي كتابة، وكل رفض بيترجع للموديل وبيتسجّل في ap_decisions.

   `rows` = لقطة الحملات: { platform, id, name, status, dailyBudget, spend,
                            results, cpa, roas }                              */

export const activeBudgetOf = (rows) => rows
  .filter((r) => r.status === "ACTIVE" && r.dailyBudget != null)
  .reduce((a, r) => a + r.dailyBudget, 0);

export function guardPause({ platform, campaignId }, s, rows, { writeOk }) {
  if (!writeOk) return "ADS_ALLOW_WRITE مش مساوي 1 — الكتابة على المنصات مقفولة من أصلها.";
  const row = rows.find((r) => r.platform === platform && r.id === String(campaignId));
  if (!row) return `مفيش حملة بالرقم ${campaignId} على ${platform} في اللقطة الحالية — راجع get_performance الأول.`;
  if (row.status !== "ACTIVE") return `الحملة "${row.name}" أصلاً ${row.status} — مفيش حاجة تتوقف.`;
  // قاعدة القتل بتحدد إمتى الإيقاف مبرر. حملة بتضرب المستهدف مش بتتقفل.
  if (row.spend >= s.minSpend && row.cpa != null && row.cpa <= s.targetCpa) {
    return `مرفوض: "${row.name}" تكلفة نتيجتها ${row.cpa} ر.س وهي أقل من المستهدف (${s.targetCpa} ر.س) — دي حملة كاسبة والقواعد بتقول ما توقفش الكاسب. قاعدة القتل بتشتغل عند تكلفة أعلى من ${s.killMultiple}× المستهدف. لو عايز تقلل صرفها استخدم set_budget.`;
  }
  return null;
}

export function guardBudget({ platform, campaignId, amount }, s, rows, { writeOk, cooldown, hardCap }) {
  if (!writeOk) return "ADS_ALLOW_WRITE مش مساوي 1 — الكتابة على المنصات مقفولة من أصلها.";
  const row = rows.find((r) => r.platform === platform && r.id === String(campaignId));
  if (!row) return `مفيش حملة بالرقم ${campaignId} على ${platform} في اللقطة الحالية — راجع get_performance الأول.`;
  const to = Number(amount);
  if (!Number.isFinite(to) || to <= 0) return "المبلغ لازم يكون رقم موجب بالريال.";
  if (row.dailyBudget == null) {
    return `مرفوض: "${row.name}" ميزانيتها متظبطة على مستوى المجموعة الإعلانية مش الحملة — الوكيل بيدير ميزانيات الحملات بس.`;
  }
  const cap = Math.min(s.maxCampaignBudget, hardCap);
  if (to > cap) {
    return `مرفوض: ${to} ر.س/يوم فوق سقف الحملة الواحدة (${cap} ر.س). السقف ده إعداد المالك — لو عايز تعدّيه لازم هو يرفعه من الإعدادات، مش انت.`;
  }
  const changePct = Math.abs(to - row.dailyBudget) / row.dailyBudget * 100;
  if (changePct > s.maxChangePct) {
    return `مرفوض: التغيير من ${row.dailyBudget} لـ ${to} ر.س يعني ${Math.round(changePct)}٪ وده فوق أقصى تغيير مسموح في الخطوة الواحدة (${s.maxChangePct}٪). الخوارزمية بتتكسر لو الميزانية نطّت مرة واحدة — كبّر على خطوات.`;
  }
  const after = activeBudgetOf(rows) - row.dailyBudget + to;
  if (after > s.maxTotalBudget) {
    return `مرفوض: مجموع ميزانيات الحملات الشغالة هيبقى ${Math.round(after)} ر.س/يوم وده فوق السقف الكلي (${s.maxTotalBudget} ر.س). وقّف أو قلّل حملة تانية الأول.`;
  }
  if (cooldown.has(`${platform}:${campaignId}`)) {
    return `مرفوض: "${row.name}" ميزانيتها اتغيّرت خلال آخر ${s.budgetCooldownHours} ساعة — فترة تعلّم لازم تعدّي قبل أي تغيير تاني.`;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   الإيقاع اليومي (INTRADAY PACING) — الجزء النقي

   ليه ده موجود أصلاً. decide() فوق بيحكم على الحملة بـ `results` اللي المنصة
   بتقولها. وميتا بتقول صفر لكل حملة عندنا — مش لإن الحملة فاشلة، لكن لإن
   الشرا الحقيقي بيحصل جوّه المطعم وبيتبعت CAPI بـ action_source =
   physical_store، وده مبيرجعش في actions.purchase بتاعة insights. النتيجة:
   results = 0 → cpa = null → شرط "winning" عمره ما يتحقق → عمر الوكيل ما
   هيكبّر حملة. كل ساعة بيطلع ٦ ملاحظات وصفر تنفيذ.

   الإشارة الحقيقية الوحيدة اللي عندنا لايف هي مبيعات الكاشير نفسها:
   ts_orders بتتزامن كل ٥ دقايق. فالتسريع جوّه اليوم بيتبني عليها هي، مش على
   رقم المنصة. ورقم المنصة الصفر ده بيتقال صراحة في نص السبب عشان اللي بيقرا
   ما يفتكرش إننا اتجاهلنا إشارة سلبية.

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

export const ADS_ACCOUNT_TZ = process.env.ADS_ACCOUNT_TZ || "America/Los_Angeles";
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
export function shapePulse({ day, elapsedH, riyadhHour, today, comparables = [] }) {
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
    day, elapsedH: r2(elapsedH), riyadhHour,
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
  paceStepPct: 15,             // خطوة الرفع/الخفض جوّه اليوم
  paceMaxUpliftPct: 60,        // أقصى زيادة تراكمية فوق ميزانية المالك
  paceCooldownMinutes: 45,     // أقل فاصل بين حركتين على نفس الحملة
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
    const row = rows.find((r) => keyOf(r.platform, r.id) === key);
    const cur = row && row.dailyBudget != null ? Number(row.dailyBudget) : Number(st.currentBudget);
    touched.add(key);
    if (!Number.isFinite(cur) || cur <= base + 0.5) {
      notes.push({ key, op: "restore-noop", text: `"${row?.name || st.campaignName || key}" ميزانيتها ${ar(cur)} ر.س وهي مش أعلى من الأساس (${ar(base)}) — مفيش حاجة ترجع.` });
      continue;
    }
    actions.push({
      op: "restore", platform: st.platform, campaignId: st.campaignId,
      campaignName: row?.name || st.campaignName || null,
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
  const up = pacePct >= Number(s.paceUpThresholdPct);
  const down = pacePct <= Number(s.paceDownThresholdPct);
  if (!up && !down) {
    return done(`الإيقاع ${pacePct >= 0 ? "+" : ""}${pacePct}٪ مقابل خط الأساس — جوّه المنطقة الطبيعية (${s.paceDownThresholdPct}٪ إلى ${s.paceUpThresholdPct}٪)، فمفيش داعي نلمس أي ميزانية.`);
  }

  /* ── ٣. الحملات. الأكتر صرفاً الأول: لو السقف الكلي هيخلص، يخلص على
        الحملة اللي الفلوس شغالة فيها فعلاً مش على أول واحدة في اللستة.     */
  const activeRows = rows.filter((r) => r.status === "ACTIVE" && r.dailyBudget != null);
  let totalActive = activeRows.reduce((a, r) => a + Number(r.dailyBudget), 0);
  const cooldownMs = Math.max(5, Number(s.paceCooldownMinutes) || 45) * 60_000;
  const perCap = Math.min(Number(s.maxCampaignBudget) || 500, hardCap);
  const totalCap = Number(s.maxTotalBudget) || 1000;

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

  for (const r of activeRows.slice().sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0))) {
    const key = keyOf(r.platform, r.id);
    if (touched.has(key)) continue;                        // اترجّعت الجولة دي
    const st = state.get(key);
    const mine = st && st.accountDay === accountDay;        // زيادة من عندنا على نفس يوم الحساب
    const base = mine ? Number(st.baseBudget) : Number(r.dailyBudget);
    const cur = Number(r.dailyBudget);

    if (mine && nowMs - st.lastActionAt < cooldownMs) {
      notes.push({ key, op: "cooldown", text: `"${r.name}" اتغيّرت من ${Math.round((nowMs - st.lastActionAt) / 60000)} دقيقة — فترة تبريد الإيقاع ${s.paceCooldownMinutes} دقيقة عشان المنصة تاخد وقتها تصرف الزيادة قبل ما نحكم عليها تاني.` });
      continue;
    }

    const zero = !Number(r.results)
      ? ` المنصة مسجّلة ${Number(r.results) || 0} نتيجة للحملة دي النهارده — وده مش دليل فشل: الشرا بيحصل جوّه المطعم وبيتبعت CAPI بـ action_source=physical_store، فمبيرجعش في أرقام المنصة أصلاً. فمابنحكمش بيه لا بالسلب ولا بالإيجاب.`
      : ` المنصة مسجّلة ${ar(r.results)} نتيجة النهارده — رقم مساعد، بس القرار مبني على مبيعات الكاشير.`;

    if (up) {
      const upliftCap = Math.floor(base * (1 + upliftPct / 100));
      let next = Math.round(cur * (1 + step / 100));
      let capped = null;
      if (next > upliftCap) { next = upliftCap; capped = `سقف الزيادة اليومية ${upliftPct}٪ فوق أساس ${ar(base)}`; }
      if (next > perCap) { next = perCap; capped = `سقف الحملة الواحدة ${ar(perCap)} ر.س`; }
      const headroom = totalCap - totalActive;
      if (next - cur > headroom) { next = cur + Math.max(0, Math.floor(headroom)); capped = `السقف الكلي ${ar(totalCap)} ر.س/يوم`; }
      if (next <= cur) {
        notes.push({ key, op: "capped", text: `"${r.name}" تستاهل تسريع بس وصلت ${capped || "السقف"} — الميزانية واقفة عند ${ar(cur)} ر.س. لو عايز توسّع أكتر، ارفع السقف من الإعدادات بإيدك.` });
        continue;
      }
      totalActive += next - cur;
      actions.push({
        op: "up", platform: r.platform, campaignId: r.id, campaignName: r.name,
        from: r2(cur), to: r2(next), base: r2(base), accountDay,
        reason: `${ctx} رفعنا "${r.name}" من ${ar(cur)} لـ ${ar(next)} ر.س/يوم (خطوة ${step}٪${capped ? `، متقصوصة على ${capped}` : ""}).${hotNote}${zero} ${evidence} الزيادة دي هترجع لـ ${ar(base)} ر.س قبل ما يوم الحساب الإعلاني ${accountDay} (${ADS_ACCOUNT_TZ}) يقفل — يعني حوالي ١٠ صباحاً بتوقيت جدة.`,
      });
    } else {
      /* التراجع بيلمس زيادتنا إحنا بس. الخفض تحت ميزانية المالك شغلانة
         الجولة البطيئة بتبريدها ٢٤ ساعة — لو الاتنين خفّضوا هنكون قصّينا
         الحملة مرتين على نفس السبب. */
      if (!mine || cur <= base + 0.5) continue;
      let next = Math.round(cur * (1 - step / 100));
      next = Math.max(next, base);
      if (next >= cur) continue;
      totalActive += next - cur;
      actions.push({
        op: "down", platform: r.platform, campaignId: r.id, campaignName: r.name,
        from: r2(cur), to: r2(next), base: r2(base), accountDay,
        reason: `${ctx} فسحبنا التسريع على "${r.name}" من ${ar(cur)} لـ ${ar(next)} ر.س/يوم (خطوة ${step}٪، ومش بننزل تحت ميزانية المالك ${ar(base)} ر.س — الخفض تحتها شغل الجولة اليومية مش الإيقاع).${zero}`,
      });
    }
  }

  return { phase: up ? "up" : "down", accountDay, msToRoll, pacePct, hot, step, actions, notes, gate: null };
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

   الأساس هو متوسط آخر ٧ أيام مش مبيعات النهارده: النهارده لسه ما خلصش،
   والصرف بيتحدد أول اليوم. والـ stretch (نسبة أعلى شوية) بيتفتح بس لما نبض
   المبيعات يكون فوق خط الأساس فعلاً — يوم شغّال يستاهل فلوس زيادة.

   وفوق كل ده سقف مطلق بيحطه المالك (٢٠٠٠ افتراضياً) مفيش أي حساب بيعدّيه.
═══════════════════════════════════════════════════════════════════════════ */

export const ECON_DEFAULTS = {
  adsShareOfSalesPct: 20,       // قاعدة المالك
  adsShareStretchPct: 25,       // لما اليوم شغّال فوق خط الأساس
  absoluteMaxTotalBudget: 2000, // السقف المطلق — رقم المالك، مفيش حساب بيعدّيه
  minTotalBudget: 150,          // أرضية: يوم مبيعات واطي مايطفّيش الإعلانات خالص
  grossMarginPct: 65,           // هامش المطعم التقديري — بيحدد أقصى CAC نظري
  ltvHorizonDays: 90,           // شباك القيمة العمرية اللي بنقيس عنده
};

export function movingCeiling({
  trailing7Avg = null, sharePct = 20, stretchPct = 25, pacePct = null,
  hotThresholdPct = 20, hardMax = 2000, floor = 150, fallback = 1000,
} = {}) {
  const cap = Math.max(0, Number(hardMax) || 0);
  const hot = pacePct != null && Number.isFinite(Number(pacePct)) && Number(pacePct) >= Number(hotThresholdPct);
  const avg = Number(trailing7Avg);

  if (!Number.isFinite(avg) || avg <= 0) {
    const ceiling = Math.min(Number(fallback) || 0, cap);
    return {
      ceiling, base: null, stretch: null, hot: false, trailing7Avg: null,
      sharePct, stretchPct, hardMax: cap, floor, source: "fallback",
      reason: `مفيش مبيعات محسوبة لآخر ٧ أيام، فقاعدة الـ ${sharePct}٪ مالهاش أساس تتحسب عليه. السقف رجع للرقم الاحتياطي ${ar(ceiling)} ر.س/يوم لحد ما المبيعات تبقى مقروءة.`,
    };
  }

  const base = Math.round(avg * (Number(sharePct) || 0) / 100);
  const stretch = Math.round(avg * (Number(stretchPct) || 0) / 100);
  let ceiling = hot ? stretch : base;
  let capped = null;
  if (ceiling > cap) { ceiling = cap; capped = "السقف المطلق"; }
  if (ceiling < Number(floor)) { ceiling = Math.min(Number(floor) || 0, cap); capped = "أرضية السقف"; }

  return {
    ceiling, base, stretch, hot, trailing7Avg: r2(avg),
    sharePct, stretchPct, hardMax: cap, floor, capped, source: hot ? "stretch" : "base",
    reason: `متوسط مبيعات آخر ٧ أيام ${ar(avg)} ر.س/يوم × ${sharePct}٪ = ${ar(base)} ر.س مسموح للإعلانات النهارده` +
      (hot ? `، والنبض فوق خط الأساس بـ ${Math.round(Number(pacePct))}٪ فاتفتح سقف التوسّع ${stretchPct}٪ = ${ar(stretch)} ر.س` : "") +
      (capped ? ` — متقصوص على ${capped} (${ar(ceiling)} ر.س).` : ` — السقف النهارده ${ar(ceiling)} ر.س.`),
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
      label: "التكلفة اللي بندفعها فعلاً (مسندة)",
      expr: `${ar(adSpendInWindow)} ر.س صرف إعلانات ÷ ${ar(attributedNewCustomers)} عميل جديد مسند للإعلان`,
      value: r2(measuredCac), unit: "ر.س",
    },
  ].filter(Boolean);

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
};

const OUTCOME = {
  executed: "تم", auto_executed: "تم", approved: "تم",
  proposed: "مستني موافقتك", rejected: "اترفض", refused: "اترفض",
  failed: "فشل", info: "للعلم",
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
    // note وأي حاجة تانية
    type = "note";
    title = clip(row.reason, 180) || "ملاحظة";
    why = "";
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
    `);
  }
  ensureSchema()
    .then(() => console.log("[autopilot] schema ready"))
    .catch((e) => console.error("[autopilot] schema failed:", e.message));

  async function getSettings() {
    const r = await pool.query(`SELECT data FROM ap_settings WHERE id=1`);
    const stored = { ...(r.rows[0]?.data || {}) };
    // الحقول المحسوبة عمرها ما بتتخزن — لو صف قديم فيه واحد منهم بيتشال هنا
    // عشان ما يتثبّتش سقف اتحسب من مبيعات أسبوع فات.
    delete stored.ceiling;
    return { ...DEFAULT_SETTINGS, ...PACE_DEFAULTS, ...DAYPART_DEFAULTS, ...ECON_DEFAULTS, ...stored };
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
  async function settingsNow({ pacePct = null, base = null } = {}) {
    const s = base || await getSettings();
    if (s.moveCeilingWithSales === false) {
      return { ...s, ceiling: { ceiling: s.maxTotalBudget, source: "manual", trailing7Avg: null,
        reason: `سقف يدوي ثابت ${ar(s.maxTotalBudget)} ر.س/يوم — قاعدة الـ ٢٠٪ متقفولة من الإعدادات.` } };
    }
    let trailing = { avg: null, days: 0 };
    try { trailing = await trailingDailySales(7); } catch { /* المبيعات مش مقروءة → fallback */ }
    const ceiling = movingCeiling({
      trailing7Avg: trailing.avg,
      sharePct: s.adsShareOfSalesPct,
      stretchPct: s.adsShareStretchPct,
      pacePct,
      hotThresholdPct: s.paceUpThresholdPct,
      hardMax: Math.min(Number(s.absoluteMaxTotalBudget) || ECON_DEFAULTS.absoluteMaxTotalBudget, MAX_DAILY_BUDGET),
      floor: s.minTotalBudget,
      fallback: s.maxTotalBudget,
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
              extract(hour from (now() AT TIME ZONE '${RIYADH_TZ}'))::int AS riyadh_hour`);
    return {
      day: isoDay(r.rows[0].day),
      elapsedH: Math.min(24, Math.max(0, Number(r.rows[0].elapsed_h) || 0)),
      riyadhHour: Number(r.rows[0].riyadh_hour) || 0,
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
    const { day, elapsedH, riyadhHour } = await bizNow();

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
      day, elapsedH, riyadhHour,
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

  /* الزيادات المفتوحة (اللي لسه ماترجعتش) — دي حالة الإيقاع كلها. */
  async function pacingState() {
    const r = await pool.query(
      `SELECT platform, campaign_id, campaign_name, account_day::text AS account_day,
              base_budget, current_budget, steps, last_action_at
         FROM ap_pacing WHERE restored_at IS NULL`);
    const m = new Map();
    for (const x of r.rows) {
      m.set(`${x.platform}:${x.campaign_id}`, {
        platform: x.platform, campaignId: x.campaign_id, campaignName: x.campaign_name,
        accountDay: isoDay(x.account_day),
        baseBudget: Number(x.base_budget), currentBudget: Number(x.current_budget),
        steps: Number(x.steps) || 0, lastActionAt: new Date(x.last_action_at).getTime(),
      });
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
      if (p.id === "google") continue;
      if (s.platforms && s.platforms[p.id] === false) continue;
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ")}`; continue; }
      try {
        const [camps, i3, i7] = await Promise.all([
          p.campaigns(),
          p.insights({ from: d3, to: today }),
          p.insights({ from: d7, to: today }),
        ]);
        if (!camps.ok) { reasons[p.id] = camps.reason; continue; }
        const m3 = new Map((i3.ok ? i3.rows : []).map((x) => [String(x.campaignId), x]));
        const m7 = new Map((i7.ok ? i7.rows : []).map((x) => [String(x.campaignId), x]));
        for (const c of camps.campaigns) {
          const a = m3.get(String(c.id)), b = m7.get(String(c.id));
          const started = c.startTime ? new Date(c.startTime) : null;
          rows.push({
            platform: p.id, id: String(c.id), name: c.name, status: c.status,
            effectiveStatus: c.effectiveStatus || null,
            dailyBudget: c.dailyBudget,
            ageDays: started && !isNaN(started) ? Math.floor((Date.now() - started.getTime()) / 86400000) : null,
            w3: { spend: a?.spend || 0, results: a?.results || 0, revenue: a?.resultValue || 0 },
            w7: { spend: b?.spend || 0, results: b?.results || 0, revenue: b?.resultValue || 0 },
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

    if (p.authorize) {
      const authed = await p.authorize(call);
      if (!authed) return { ok: false, error: "could not obtain an access token" };
      call = authed;
    }
    const res = await httpJson(call.url, { method: call.method, headers: call.headers, body: call.body });
    const parsed = p.readBatchResult(res, 1);
    return parsed.ok
      ? { ok: true, httpStatus: res.status, platform: redact(parsed.raw ?? null) }
      : { ok: false, httpStatus: res.status, error: parsed.error, platform: redact(parsed.raw ?? null) };
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
    const provider = llmProvider();
    if (!provider || !s.useLlm) return null;
    const compact = {
      goalDailySales: s.goalDailySales,
      salesLast7d: facts.sales,
      sourceMix7d: facts.sources,
      campaigns: facts.campaigns.map((c) => ({
        platform: c.platform, name: c.name, status: c.status, dailyBudget: c.dailyBudget,
        last3d: c.w3, last7d: c.w7,
      })),
      platformIssues: facts.reasons,
      ruleDecisions: decisions.map((d) => ({ kind: d.kind, campaign: d.campaignName, reason: d.reason })),
      targets: { cpa: s.targetCpa, roas: s.targetRoas },
    };
    return llmTool(provider, {
      system: STRATEGIST_SYSTEM,
      user: `دي البيانات الحقيقية (JSON):\n\n${JSON.stringify(compact, null, 1)}\n\nحلّل الوضع واطلع: كرياتيفات جديدة للمنصات اللي محتاجة، عروض مقترحة، وخطوات الأسبوع الجاي. استخدم أداة submit_ads_strategy.`,
      tool: STRATEGIST_TOOL,
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
  async function perfSnapshot({ from, to, platform = null } = {}) {
    const today = todayISO();
    const f = from || daysAgoISO(2), t = to || today;
    const rows = [], reasons = {};
    for (const p of PLATFORMS) {
      if (p.id === "google") continue;
      if (platform && p.id !== platform) continue;
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ")}`; continue; }
      try {
        const [camps, ins] = await Promise.all([p.campaigns(), p.insights({ from: f, to: t })]);
        if (!camps.ok) { reasons[p.id] = camps.reason; continue; }
        if (!ins.ok) reasons[p.id] = ins.reason;
        const m = new Map((ins.ok ? ins.rows : []).map((x) => [String(x.campaignId), x]));
        for (const c of camps.campaigns) {
          const a = m.get(String(c.id));
          const spend = a?.spend || 0, results = a?.results || 0, revenue = a?.resultValue || 0;
          rows.push({
            platform: p.id, id: String(c.id), name: c.name, status: c.status,
            dailyBudget: c.dailyBudget,
            spend, results, revenue,
            impressions: a?.impressions || 0, clicks: a?.clicks || 0,
            cpa: results > 0 ? Math.round((spend / results) * 100) / 100 : null,
            roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
          });
        }
      } catch (e) { reasons[p.id] = String(e.message || e); }
    }
    return { range: { from: f, to: t }, rows, reasons };
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
      return { ok: true, ...r };
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
• قاعدة القتل: حملة تكلفة نتيجتها أعلى من ${s.killMultiple}× المستهدف مع صرف حقيقي تستاهل الإيقاف. حملة تحت المستهدف ممنوع توقفها.
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
  async function runAgent({ runId, s, trigger = "cycle", task, focus = FOCUS_FULL, snap = null }) {
    const provider = llmProvider();
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
        reply = await llmTurn(provider, { system, messages, tools: AGENT_TOOLS });
      } catch (e) {
        // الموديل مش موجود → الوكيل بس هو اللي بيقف. القواعد الصمّاء خلصت خلاص.
        await logAgentTurn(runId, trigger, turn, { error: String(e.message || e) }, "failed");
        return { ok: false, error: String(e.message || e), turns: turns.length,
                 executed: agentCtx.executed, queued: agentCtx.queued, refusals: agentCtx.refusals.length };
      }
      messages.push(reply.native);

      if (!reply.calls.length) {
        final = reply.text || final;
        turns.push({ turn, text: reply.text, tools: [] });
        await logAgentTurn(runId, trigger, turn, { text: reply.text, tools: [], stop: reply.stop, final: true }, "info");
        break;
      }

      const results = [];
      const logged = [];
      for (const call of reply.calls) {
        let output;
        try { output = await runAgentTool(call.name, call.input, agentCtx); }
        catch (e) { output = { ok: false, error: String(e.message || e) }; }
        const text = JSON.stringify(output).slice(0, 24000);
        results.push({ id: call.id, text });
        logged.push({ name: call.name, input: call.input, output: trim(output) });
      }
      turns.push({ turn, text: reply.text, tools: logged });
      await logAgentTurn(runId, trigger, turn, { text: reply.text, tools: logged, stop: reply.stop }, "info");
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
      // (١) حملة بتحرق فلوس النهارده من غير أي نتيجة
      if (r.spend >= s.minSpend * 2 && (r.results || 0) === 0) {
        found.push({ key: `burn:${r.platform}:${r.id}:${today}`, kind: "burn", platform: r.platform,
          campaignId: r.id, campaignName: r.name,
          text: `"${r.name}" (${r.platform}) صرفت ${Math.round(r.spend)} ر.س النهارده من غير أي نتيجة.` });
      }
      // (٢) تكلفة النتيجة النهارده فوق حد القتل
      if (r.spend >= s.minSpend && r.cpa != null && r.cpa > s.killMultiple * s.targetCpa) {
        found.push({ key: `cpa:${r.platform}:${r.id}:${today}`, kind: "cpa", platform: r.platform,
          campaignId: r.id, campaignName: r.name,
          text: `"${r.name}" (${r.platform}) تكلفة النتيجة النهارده ${r.cpa} ر.س — أعلى من ${s.killMultiple}× المستهدف (${s.targetCpa} ر.س).` });
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
      if (p.id !== "google" && !snap.reasons[p.id]) platformFails[p.id] = 0;
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
      // مقفولة وكل حاجة موقوفة خلاص — مش محتاجين نضرب المنصات كل ٥ دقايق
      // بالليل. بنبص كل ٢٥ دقيقة عشان لو حملة جديدة اشتغلت نوقفها.
      if (!w.open && book.size > 0 && !force && Date.now() - lastClosedProbeAt < CLOSED_PROBE_MS) {
        return { ok: true, phase: "closed", window: w, skipped: "throttled", paused: book.size };
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
            status = res.ok ? "auto_executed" : "failed";
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
          status = res.ok ? "auto_executed" : "failed";
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
          status = res.ok ? "auto_executed" : "failed";
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

      const summary = { trigger, mode: s.mode, kind: "daypart", phase: decision.phase,
                        window: w.label, clock: w.clock, actions: results };
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
      const s = await settingsNow({ pacePct: pulse.pacePct, base: stored });
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
      const decision = decidePace({
        rows: snap.rows, state, s, now, accountDay, msToRoll, pulse,
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
          { platform: a.platform, campaignId: a.campaignId, amount: a.to },
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
          status = res.ok ? "auto_executed" : "failed";
          executedAt = res.ok ? new Date() : null;
          if (res.ok) {
            if (a.op === "restore") {
              await pool.query(
                `UPDATE ap_pacing SET restored_at=NOW(), current_budget=$4
                  WHERE platform=$1 AND campaign_id=$2 AND account_day=$3::date`,
                [a.platform, a.campaignId, a.accountDay, a.to]);
            } else {
              await pool.query(
                `INSERT INTO ap_pacing (platform, campaign_id, campaign_name, account_day,
                                        base_budget, current_budget, steps, last_action_at)
                 VALUES ($1,$2,$3,$4::date,$5,$6,1,NOW())
                 ON CONFLICT (platform, campaign_id, account_day) DO UPDATE
                   SET current_budget=EXCLUDED.current_budget, campaign_name=EXCLUDED.campaign_name,
                       steps=ap_pacing.steps+1, last_action_at=NOW()`,
                [a.platform, a.campaignId, a.campaignName, a.accountDay, a.base, a.to]);
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

      const summary = { trigger, mode: s.mode, kind: "pace", phase: decision.phase,
                        pace: pulse.pacePct, accountDay, actions: results };
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
        platforms: Object.fromEntries(PLATFORMS.filter((p) => p.id !== "google").map((p) => [p.id, facts.reasons[p.id] ? "blocked" : "ok"])),
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
          status = res.ok ? "auto_executed" : "failed";
          executedAt = res.ok ? new Date() : null;
          if (res.ok) summary.executed++;
        }
        await pool.query(
          `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, executed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, runId, d.platform, d.campaignId, d.campaignName, d.kind, jb(d.detail), d.reason, status, jb(result), executedAt]);
        summary.decisions++;
      }

      // 5. LLM strategist — at most once per cycle, only when there is signal
      if (s.useLlm && (facts.campaigns.length > 0 || Object.keys(facts.reasons).length < 3)) {
        try {
          const plan = await runStrategist(facts, decisions, s);
          if (plan) {
            summary.llm = { creatives: plan.creatives?.length || 0, offers: plan.offers?.length || 0 };
            await pool.query(
              `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status)
               VALUES ($1,$2,NULL,NULL,NULL,'strategy',$3,$4,'info')`,
              [crypto.randomUUID(), runId, jb(plan), plan.summary || ""]);
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
        try {
          const task = `جولة كاملة. الوضع باختصار: ${facts.campaigns.length} حملة على المنصات، ` +
            `متوسط المبيعات ${facts.sales.avgDaily} ر.س/يوم (الهدف ${s.goalDailySales}). ` +
            (decisions.length
              ? `محرك القواعد الصمّاء خد ${decisions.length} قرار في الجولة دي: ${decisions.map((d) => `${d.kind}/${d.campaignName || "—"}`).join("، ")}. متعيدش نفس القرارات.`
              : `محرك القواعد الصمّاء ماخدش أي قرار الجولة دي.`) +
            `\n\nراجع الوضع بنفسك بالأدوات: أداء الحملات، مردود القنوات (get_attribution) والمبيعات. ` +
            `دوّر على حاجتين بالذات: (أ) حملة كاسبة تستاهل تكبير جوه السقوف، (ب) صرف بيروح على قناة مردودها ضعيف. ` +
            `نفّذ اللي يستاهل، وسجّل بـ create_note أي حاجة مهمة مش من صلاحياتك.`;
          summary.agent = await runAgent({ runId, s, trigger, task, focus: FOCUS_FULL });
        } catch (e) { summary.agent = { error: e.message }; }
      }

      // 8. nightly audience refresh (once per calendar day, after midnight Riyadh)
      const riyadhDay = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
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
    let pacePct = null;
    try { pacePct = (await pulseData()).pacePct; } catch { /* المبيعات مش مقروءة */ }
    const eff = await settingsNow({ pacePct, base: s });
    let todaySpend = null, spendReasons = {};
    try {
      const snapToday = await perfSnapshot({ from: todayISO(), to: todayISO() });
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
      },
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
      platforms: PLATFORMS.filter((p) => p.id !== "google").map((p) => ({
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
      const s = await settingsNow({ pacePct: pulse.pacePct });
      const open = await pacingState();
      return c.json({
        ok: true,
        ...pulse,
        ceiling: s.ceiling,
        adsWindow: adsWindow(new Date(), s),
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
  app.get("/api/autopilot/log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 60), 1), 300);
    const days = Math.min(Math.max(Number(c.req.query("days") || 7), 1), 90);
    const r = await pool.query(
      `SELECT id, platform, campaign_id, campaign_name, kind, detail, reason, status, result, created_at
         FROM ap_decisions
        WHERE created_at > NOW() - ($1 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT $2`, [String(days), limit * 3]);

    const entries = [];
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
      entries.push(line);
      if (entries.length >= limit) break;
    }
    return c.json({ ok: true, tz: RIYADH_TZ, days, types: LOG_TYPES, entries });
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

    /* (٥) صرف الإعلانات والعملاء الجداد المسندين — من موديول الإسناد. */
    let spend = null, attributedNew = null, attributionNote = null;
    if (attribution?.overviewData) {
      try {
        const ov = await attribution.overviewData(from, to);
        spend = Number(ov?.totals?.paid?.spend) || 0;
        attributedNew = Number(ov?.totals?.newCustomers) || 0;
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

  app.get("/api/autopilot/runs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(Number(c.req.query("limit") || 20), 100);
    const r = await pool.query(`SELECT * FROM ap_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
    return c.json({ ok: true, runs: r.rows });
  });

  console.log("[autopilot] routes ready");
  return { runCycle, runEmergencyCheck, runAgent, runPaceCheck, runDaypartCheck, pulseData, economicsData };
}
