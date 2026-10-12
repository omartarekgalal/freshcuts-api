/* ═══════════════════════════════════════════════════════════════════════════
   تكلفة الذكاء الاصطناعي في بوت واتساب — مراقبة وسقف (١٢/١٠/٢٠٢٦)

   طلب عمر: «شغله بس عايز اكون مراقب تكلفته كويس جدا».
     • كل نداء للموديل صف في ai_calls: الوقت، الغرض، الموديل، المزوّد، التوكنز (داخل/خارج/كاش)، التكلفة بالريال
       محسوبة من جدول أسعار في الإعدادات (بتاريخه)، الزمن، المحادثة (بصمة مش الرقم)، النتيجة، والنص اللي اتبعت فعلاً.
     • سقف يومي وسقف شهري بالريال: أول ما واحد يتوصل له، البوت يكمل بالقواعد بس، وSMS واحد للمالك.
     • تكلفة واتساب نفسها على نفس الكارت: الردود الحرة مقابل المجاني، والقوالب بالفئة بسعر البطاقة المخزّنة.
   مفيش أي إرسال لعميل من الملف ده.
═══════════════════════════════════════════════════════════════════════════ */
import { createHmac } from "node:crypto";

/* أسعار الموديلات بالدولار لكل مليون توكن. cached = سعر قراءة الكاش. المصدر: مرجع Claude API (نسخة ٦/١٠/٢٠٢٦).
   سعر الكاش مؤكد لـsonnet بس؛ haiku و opus متحطّين بسعر الإدخال العادي (تقدير للأعلى) لحد ما يتأكدوا. كله يتعدّل من اللوحة. */
export const PRICE_DEFAULTS = Object.freeze({
  date: "2026-10-06", usdSar: 3.75,
  models: Object.freeze({
    "claude-haiku-5-5": Object.freeze({ in: 0.10, out: 0.50, cached: 0.10 }),
    "claude-sonnet-5-5": Object.freeze({ in: 2, out: 10, cached: 0.20 }),
    "claude-opus-5-5": Object.freeze({ in: 4, out: 20, cached: 4 }),
  }),
});
/* بطاقة أسعار واتساب للسعودية بالريال للرسالة (ميتا، سارية من ١/١٠/٢٠٢٦). */
export const WA_RATE_DEFAULTS = Object.freeze({ date: "2026-10-01", marketing: 0.2159, utility: 0.0401, authentication: 0.0401 });
export const BUDGET_DEFAULTS = Object.freeze({ budgetMonthSar: 30, budgetDaySar: 3 });

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null && n >= lo && n <= hi ? n : d; };
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const bareModel = (m) => String(m || "").split("/").pop();

/* إعدادات مخزّنة ⇒ جدول أسعار سليم (أي قيمة غلط ترجع للافتراضي). */
export function pricesOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const models = {};
  for (const [id, d] of Object.entries(PRICE_DEFAULTS.models)) models[id] = { ...d };
  for (const [id, v] of Object.entries(r.models && typeof r.models === "object" ? r.models : {})) {
    if (!/^[a-z0-9.-]{3,60}$/.test(id) || !v || typeof v !== "object") continue;
    const base = models[id] || { in: 0, out: 0, cached: 0 };
    const p = { in: num(v.in, 0, 1000, base.in), out: num(v.out, 0, 1000, base.out), cached: num(v.cached, 0, 1000, base.cached) };
    if (p.in > 0 || p.out > 0) models[id] = p;
  }
  return { date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? String(r.date) : PRICE_DEFAULTS.date, usdSar: num(r.usdSar, 1, 10, PRICE_DEFAULTS.usdSar), models };
}
export function waRatesOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return { date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? String(r.date) : WA_RATE_DEFAULTS.date,
    marketing: num(r.marketing, 0, 5, WA_RATE_DEFAULTS.marketing), utility: num(r.utility, 0, 5, WA_RATE_DEFAULTS.utility), authentication: num(r.authentication, 0, 5, WA_RATE_DEFAULTS.authentication) };
}
/* للحفظ من اللوحة: يرجّع { ok, value } أو { ok:false, errors }. */
export function pricesFromBody(src, prev) {
  const errors = [], cur = pricesOf(prev), s = src && typeof src === "object" ? src : {};
  if ("date" in s) { if (/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) cur.date = String(s.date); else errors.push("llm.prices.date"); }
  if ("usdSar" in s) { const n = Number(s.usdSar); if (Number.isFinite(n) && n >= 1 && n <= 10) cur.usdSar = n; else errors.push("llm.prices.usdSar"); }
  for (const [id, v] of Object.entries(s.models && typeof s.models === "object" ? s.models : {})) {
    if (!/^[a-z0-9.-]{3,60}$/.test(id) || !v || typeof v !== "object") { errors.push(`llm.prices.models.${id}`); continue; }
    const p = { ...(cur.models[id] || { in: 0, out: 0, cached: 0 }) };
    for (const k of ["in", "out", "cached"]) if (k in v) { const n = Number(v[k]); if (Number.isFinite(n) && v[k] !== "" && n >= 0 && n <= 1000) p[k] = n; else errors.push(`llm.prices.models.${id}.${k}`); }
    cur.models[id] = p;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: cur };
}
export function waRatesFromBody(src, prev) {
  const errors = [], cur = waRatesOf(prev), s = src && typeof src === "object" ? src : {};
  if ("date" in s) { if (/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) cur.date = String(s.date); else errors.push("waRates.date"); }
  for (const k of ["marketing", "utility", "authentication"]) if (k in s) { const n = Number(s[k]); if (Number.isFinite(n) && s[k] !== "" && n >= 0 && n <= 5) cur[k] = n; else errors.push(`waRates.${k}`); }
  return errors.length ? { ok: false, errors } : { ok: true, value: cur };
}

/* usage من أي مزوّد ⇒ { in (من غير الكاش), out, cached }.
   Anthropic: input_tokens مافيهاش الكاش. OpenAI/LiteLLM: prompt_tokens فيها الكاش، فبنطرحه. */
export function normUsage(u, kind) {
  const x = u && typeof u === "object" ? u : {};
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  if (kind === "anthropic" || "input_tokens" in x) return { in: n(x.input_tokens) + n(x.cache_creation_input_tokens), out: n(x.output_tokens), cached: n(x.cache_read_input_tokens) };
  const cached = n((x.prompt_tokens_details || {}).cached_tokens ?? x.cache_read_input_tokens);
  return { in: Math.max(0, n(x.prompt_tokens) - cached), out: n(x.completion_tokens), cached };
}
/* نداء من غير usage (انتهت المهلة/خطأ): المزوّد ممكن يكون حسبه. بنقدّر الإدخال من طول النص ونعلّم الصف «تقديري». */
export const estimateTokens = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) / 2);

/* التكلفة بالريال. موديل مش في الجدول ⇒ أغلى سعر في الجدول (مانقللش التكلفة أبداً) + priced:false. */
export function costSar(usage, model, prices) {
  const P = pricesOf(prices), id = bareModel(model);
  let p = P.models[id], priced = true;
  if (!p) { priced = false; p = Object.values(P.models).reduce((a, b) => (b.in + b.out > a.in + a.out ? b : a)); }
  const usd = ((usage.in || 0) * p.in + (usage.out || 0) * p.out + (usage.cached || 0) * p.cached) / 1e6;
  return { sar: round6(usd * P.usdSar), priced, priceDate: P.date };
}

export const chatHash = (phone, secret = process.env.ADMIN_TOKEN || "fc-wabot") => createHmac("sha256", String(secret)).update(String(phone || "")).digest("hex").slice(0, 16);

/* اليوم والشهر بتوقيت الرياض (UTC+3 ثابت) */
export function riyadhKeys(now = new Date()) {
  const d = new Date(now.getTime() + 3 * 3600_000);
  const day = d.toISOString().slice(0, 10);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return { day, month: day.slice(0, 7), dayOfMonth: d.getUTCDate(), daysInMonth: dim, hourFrac: (d.getUTCHours() * 60 + d.getUTCMinutes()) / 1440 };
}
/* توقّع الشهر: مصروف الشهر ÷ الأيام اللي فاتت (بكسر اليوم الحالي) × أيام الشهر. أقل من يوم بيانات ⇒ null (مانخترعش توقّع). */
export function projectMonth(monthSar, now = new Date()) {
  const k = riyadhKeys(now), elapsed = k.dayOfMonth - 1 + k.hourFrac;
  if (!(monthSar > 0) || elapsed < 1) return null;
  return round2((monthSar / elapsed) * k.daysInMonth);
}
/* السقف: يرجّع null لو مسموح، أو "budget_day" / "budget_month". سقف صفر = مقفول. */
export function budgetStop(spent, budget) {
  if (Number(spent.month) >= Number(budget.budgetMonthSar)) return "budget_month";
  if (Number(spent.day) >= Number(budget.budgetDaySar)) return "budget_day";
  return null;
}
export function budgetSms(stop, spent, budget, lang = "en") {
  const used = stop === "budget_day" ? `${round2(spent.day)}/${budget.budgetDaySar}` : `${round2(spent.month)}/${budget.budgetMonthSar}`;
  if (lang === "ar") return stop === "budget_day"
    ? `بوت واتساب: سقف الذكاء اليومي اتوصل (${used} ر.س). البوت مكمل بالقواعد لحد بكرة.`
    : `بوت واتساب: ميزانية الذكاء الشهرية خلصت (${used} ر.س). البوت مكمل بالقواعد لآخر الشهر.`;
  return stop === "budget_day"
    ? `WhatsApp bot: AI daily ceiling reached (${used} SAR). Rules-only until tomorrow.`
    : `WhatsApp bot: AI monthly budget used (${used} SAR). Rules-only until next month.`;
}

const MONTH_START = `(date_trunc('month', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')`;
const DAY_START = `(date_trunc('day', NOW() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')`;

export function makeAiCost({ pool, sendSms = null, alertPhonesOf = () => [], smsLang = () => "en", log = console.error, now = () => new Date() }) {
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { log("[ai-cost] db:", e.message); return null; } };
  let schemaP = null;
  const ensure = () => (schemaP ||= pool.query(`
      CREATE TABLE IF NOT EXISTS ai_calls (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        purpose TEXT NOT NULL,              -- classify | assistant
        provider TEXT, model TEXT,
        in_tokens INT NOT NULL DEFAULT 0, out_tokens INT NOT NULL DEFAULT 0, cached_tokens INT NOT NULL DEFAULT 0,
        estimated BOOLEAN NOT NULL DEFAULT FALSE,   -- المزوّد مارجّعش usage: التوكنز متقدّرة من طول النص
        cost_sar NUMERIC(12,6) NOT NULL DEFAULT 0, priced BOOLEAN NOT NULL DEFAULT TRUE, price_date TEXT,
        ms INT, chat_hash TEXT, outcome TEXT, detail TEXT,
        sent_text TEXT,                     -- نص العميل بعد الإخفاء، بالظبط زي ما اتبعت
        prompt_chars INT, prompt_hash TEXT, -- تعليماتنا (قايمة المنيو والنوايا): طولها وبصمتها
        log_id BIGINT
      );
      CREATE INDEX IF NOT EXISTS ai_calls_at_idx ON ai_calls(at DESC);
      CREATE TABLE IF NOT EXISTS ai_budget_alerts (key TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sms TEXT);
    `).catch((e) => { schemaP = null; throw e; }));

  /* مصروف اليوم والشهر. الداتابيز واقعة ⇒ null ⇒ المتصل يقفل الموديل (مانصرفش من غير ما نعدّ). */
  async function spent(purpose = null) {
    const r = await q(`SELECT COALESCE(sum(cost_sar) FILTER (WHERE at >= ${DAY_START}), 0)::float AS day, COALESCE(sum(cost_sar), 0)::float AS month
                         FROM ai_calls WHERE at >= ${MONTH_START} AND ($1::text IS NULL OR purpose = $1)`, [purpose]);
    return r ? { day: Number(r[0]?.day) || 0, month: Number(r[0]?.month) || 0 } : null;
  }
  /* قبل النداء: null = مسموح؛ وإلا سبب الإيقاف. أول مرة السقف يتوصل (لليوم/للشهر) بيتبعت SMS واحد. */
  async function gate({ purpose = "classify", budget, alert = true, phones = null, lang = null }) {
    const s = await spent(purpose);
    if (!s) return "cost_db_down";
    const stop = budgetStop(s, budget);
    if (stop && alert) await alertOnce(stop, s, budget, purpose, phones, lang);
    return stop;
  }
  async function alertOnce(stop, s, budget, purpose, phones, lang) {
    const k = riyadhKeys(now()), key = `${purpose}:${stop === "budget_day" ? k.day : k.month}`;
    const ins = await q("INSERT INTO ai_budget_alerts(key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key", [key]);
    if (!ins || !ins.length || !sendSms) return false;
    const body = budgetSms(stop, s, budget, lang || smsLang());
    let sent = 0;
    for (const p of (phones && phones.length ? phones : alertPhonesOf())) { try { const r = await sendSms({ phoneNorm: p, body, kind: "staff", ref: `ai ${stop}` }); if (!(r && r.suppressed)) sent++; } catch (e) { log("[ai-cost] sms:", e.message); } }
    await q("UPDATE ai_budget_alerts SET sms=$2 WHERE key=$1", [key, sent ? "sent" : "failed"]);
    return sent > 0;
  }
  /* تسجيل نداء. meta: { purpose, provider, model, usage, usageKind, ms, phone, outcome, detail, sent, promptChars, promptHash, logId } */
  async function record(meta, prices) {
    const has = meta.usage && typeof meta.usage === "object" && Object.keys(meta.usage).length > 0;
    const u = has ? normUsage(meta.usage, meta.usageKind) : { in: estimateTokens((meta.promptChars || 0) + String(meta.sent || "").length), out: 0, cached: 0 };
    const c = costSar(u, meta.model, prices);
    await q(`INSERT INTO ai_calls(purpose, provider, model, in_tokens, out_tokens, cached_tokens, estimated, cost_sar, priced, price_date, ms, chat_hash, outcome, detail, sent_text, prompt_chars, prompt_hash, log_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [meta.purpose || "classify", meta.provider || null, bareModel(meta.model) || null, u.in, u.out, u.cached, !has, c.sar, c.priced, c.priceDate, Math.round(Number(meta.ms) || 0),
        meta.phone ? chatHash(meta.phone) : null, meta.outcome || null, meta.detail ? String(meta.detail).slice(0, 200) : null, meta.sent == null ? null : String(meta.sent).slice(0, 2000),
        meta.promptChars || null, meta.promptHash || null, meta.logId || null]);
    return { ...u, costSar: c.sar, estimated: !has };
  }
  const win = (from) => `SELECT count(*)::int AS calls, COALESCE(sum(cost_sar),0)::float AS cost, COALESCE(avg(ms),0)::float AS ms, COALESCE(sum(in_tokens),0)::int AS tin, COALESCE(sum(out_tokens),0)::int AS tout,
      COALESCE(sum(cached_tokens),0)::int AS tcached, count(DISTINCT chat_hash)::int AS chats, count(*) FILTER (WHERE estimated)::int AS estimated, count(*) FILTER (WHERE outcome='accepted')::int AS accepted
      FROM ai_calls WHERE at >= ${from} AND ($1::text IS NULL OR purpose = $1)`;
  const shape = (r) => { const x = (r && r[0]) || {}, calls = Number(x.calls) || 0, cost = Number(x.cost) || 0, chats = Number(x.chats) || 0;
    return { calls, costSar: round6(cost), avgMs: Math.round(Number(x.ms) || 0), inTokens: Number(x.tin) || 0, outTokens: Number(x.tout) || 0, cachedTokens: Number(x.tcached) || 0, chats, estimated: Number(x.estimated) || 0,
      accepted: Number(x.accepted) || 0, perCallSar: calls ? round6(cost / calls) : null, perChatSar: chats ? round6(cost / chats) : null }; };
  /* ملخص الكارت. purpose=null ⇒ كل الأغراض. */
  async function summary({ purpose = null, budget, prices }) {
    const [d, w, m, msgs, byOutcome, alerts] = await Promise.all([
      q(win(DAY_START), [purpose]), q(win("NOW() - INTERVAL '7 days'"), [purpose]), q(win(MONTH_START), [purpose]),
      q(`SELECT count(*)::int AS n FROM wa_bot_log WHERE at >= ${MONTH_START}`, []),
      q(`SELECT COALESCE(outcome,'-') AS outcome, count(*)::int AS n FROM ai_calls WHERE at >= ${MONTH_START} AND ($1::text IS NULL OR purpose = $1) GROUP BY 1 ORDER BY 2 DESC`, [purpose]),
      q(`SELECT key, at, sms FROM ai_budget_alerts ORDER BY at DESC LIMIT 5`, []),
    ]);
    if (!d || !w || !m) return null;
    const month = shape(m), today = shape(d), messages = Number(msgs && msgs[0]?.n) || 0;
    const stop = budgetStop({ day: today.costSar, month: month.costSar }, budget);
    return { today, week: shape(w), month, byOutcome: byOutcome || [],
      share: { messages, modelCalls: month.calls, pct: messages ? Math.round((month.calls / messages) * 1000) / 10 : null, perMessageSar: messages ? round6(month.costSar / messages) : null },
      projectionSar: projectMonth(month.costSar, now()),
      budget: { ...budget, dayUsedPct: budget.budgetDaySar > 0 ? Math.round((today.costSar / budget.budgetDaySar) * 100) : null, monthUsedPct: budget.budgetMonthSar > 0 ? Math.round((month.costSar / budget.budgetMonthSar) * 100) : null, stop },
      alerts: alerts || [], prices: pricesOf(prices) };
  }
  /* تكلفة واتساب نفسها هذا الشهر: الردود الحرة (البوت) مقابل المجاني + القوالب بالفئة بسعر البطاقة. */
  async function waSide({ freeReplies, replyRateSar, rates }) {
    const R = waRatesOf(rates);
    const rep = await q(`SELECT count(*)::int AS n FROM wa_bot_log WHERE decision='replied' AND at >= ${MONTH_START}`, []);
    const tpl = await q(`SELECT lower(COALESCE(category,'')) AS category, count(*)::int AS n FROM wa_messages
                          WHERE direction='out' AND template IS NOT NULL AND template <> '' AND COALESCE(status,'') NOT IN ('failed','skipped') AND created_at >= ${MONTH_START} GROUP BY 1`, []);
    if (!rep) return null;
    const replies = Number(rep[0]?.n) || 0, billable = Math.max(0, replies - freeReplies);
    const templates = ["marketing", "utility", "authentication"].map((cat) => { const n = Number((tpl || []).find((x) => x.category === cat)?.n) || 0; return { category: cat, sent: n, rateSar: R[cat], costSar: round2(n * R[cat]) }; });
    const other = (tpl || []).filter((x) => !["marketing", "utility", "authentication"].includes(x.category)).reduce((a, x) => a + Number(x.n), 0);
    const repliesCost = round2(billable * replyRateSar);
    return { rateDate: R.date, replies: { used: replies, free: freeReplies, left: Math.max(0, freeReplies - replies), billable, rateSar: replyRateSar, costSar: repliesCost },
      templates, templatesUnknownCategory: other, templatesKnown: tpl !== null, totalSar: round2(repliesCost + templates.reduce((a, t) => a + t.costSar, 0)) };
  }
  async function calls({ limit = 100, purpose = null } = {}) {
    return (await q(`SELECT id, at, purpose, provider, model, in_tokens, out_tokens, cached_tokens, estimated, cost_sar::float AS cost_sar, priced, price_date, ms, chat_hash, outcome, detail, sent_text, prompt_chars, prompt_hash
                       FROM ai_calls WHERE ($2::text IS NULL OR purpose = $2) ORDER BY id DESC LIMIT $1`, [Math.min(500, Math.max(1, Number(limit) || 100)), purpose])) || [];
  }
  return { ensure, spent, gate, record, summary, waSide, calls };
}
