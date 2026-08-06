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

async function llmTool(provider, { system, user, tool, maxTokens = 8000 }) {
  const post = async (url, headers, body) => {
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
  };
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
  maxTotalBudget: 1000,       // SAR/day ceiling across ALL platforms
  budgetCooldownHours: 24,    // min hours between budget changes per campaign
  syncConversions: true,      // push CAPI events each cycle
  syncAudiences: true,        // refresh retargeting audiences nightly
  useLlm: true,               // creative briefs + strategy notes
  platforms: { meta: true, tiktok: true, snapchat: true },
};

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

/* ═══════════════════════════════════════════════════════════════════════════ */

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, jb, todayISO, daysAgoISO } = ctx;
  const adsSync = deps.adsSync || null;          // ads.register() return value
  const audiencesSync = deps.audiencesSync || null;

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
    `);
  }
  ensureSchema()
    .then(() => console.log("[autopilot] schema ready"))
    .catch((e) => console.error("[autopilot] schema failed:", e.message));

  async function getSettings() {
    const r = await pool.query(`SELECT data FROM ap_settings WHERE id=1`);
    return { ...DEFAULT_SETTINGS, ...(r.rows[0]?.data || {}) };
  }
  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...patch };
    // Never let the UI push the ceilings above the ads.js hard cap.
    next.maxCampaignBudget = Math.min(Number(next.maxCampaignBudget) || DEFAULT_SETTINGS.maxCampaignBudget, MAX_DAILY_BUDGET);
    await pool.query(
      `INSERT INTO ap_settings (id, data, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=NOW()`, [jb(next)]);
    return next;
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
    else if (dec.kind === "budget") {
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

  /* ── THE CYCLE ─────────────────────────────────────────────────────────── */
  let running = false;
  let lastNightlyAudienceDay = null;

  async function runCycle({ force = false, trigger = "cron" } = {}) {
    if (running) return { ok: false, error: "already running" };
    const s = await getSettings();
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
      const cd = await pool.query(
        `SELECT DISTINCT platform, campaign_id FROM ap_decisions
          WHERE kind='budget' AND status IN ('executed','auto_executed')
            AND executed_at > NOW() - ($1 || ' hours')::interval`,
        [String(Number(s.budgetCooldownHours) || 24)]);
      const cooldown = new Set(cd.rows.map((r) => `${r.platform}:${r.campaign_id}`));

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

      // 7. nightly audience refresh (once per calendar day, after midnight Riyadh)
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
    return c.json({
      ok: true,
      settings: s,
      writeEnabled: writeAllowed(),
      llmConfigured: !!llmProvider(),
      running,
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
    const s = await getSettings();
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

  app.get("/api/autopilot/runs", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(Number(c.req.query("limit") || 20), 100);
    const r = await pool.query(`SELECT * FROM ap_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
    return c.json({ ok: true, runs: r.rows });
  });

  console.log("[autopilot] routes ready");
  return { runCycle };
}
