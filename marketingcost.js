/* ═══════════════════════════════════════════════════════════════════════════
   marketingcost.js — MC1 (١٧/١٠/٢٠٢٦): تكلفة التسويق كلها في نافذة زمنية واحدة

   سؤال عمر بعد مطابقة الدخل (١٦/١٠): «الإعلانات» في اللوحة ٥٢٦ ر — طيب وقوالب واتساب التسويقية ورسايل الـSMS؟
   الدالة الوحيدة هنا marketingCostInWindow(startUtc, endUtc) بتجمع كل مصروف تسويقي/تشغيلي من مصدره الأصلي
   في نفس نافذة الطلبات (اليوم التشغيلي ٤ الفجر → ٤ الفجر) — من غير ما تعدّ أي حاجة مرتين:

     • الإعلانات   = adspend.spendInWindow (ad_spend_hourly: ميتا/سناب/جوجل/تيك توك ساعة بساعة).
                     صرف mk_entries اليدوي (مركز التسويق) مش محسوب عمداً — هو نفس الصرف متسجّل باليد.
     • واتساب      = wa_messages (direction out، قالب غير فاضي، الحالة مش failed/skipped):
                     السعر من JSON تسعير ميتا لما يكون موجود (billable=false ⇒ ٠، وفئة ميتا هي اللي بتتحسب)،
                     وإلا فئة القالب × بطاقة الأسعار من الإعدادات (waBot.waRates — waaicost.js) ⇒ «unpriced» (تقديري).
                     تسويقي = فئة marketing · خدمي = utility + authentication (+ فئة مجهولة بسعر الخدمي).
                     الردود الحرة (من غير قالب): billable = اللي ميتا قالت عليه billable بس × waBot.replyRateSar.
     • SMS         = نفس UNION «سجل الرسايل» في customer360.js (sms_log + cms_campaign_sends من غير holdout)،
                     الحالة sent بس. تسويقي = campaign/flow/cart_recovery/loyalty/waitlist/review_invite،
                     والباقي تشغيلي (otp/order_status/staff/…). التكلفة الفعلية من تقنيات؛ لو null ⇒ الأجزاء × ٠٫٠٧٥ (معلّم تقديري).
     • الذكاء      = ai_calls.cost_sar (كل نداءات الموديل: تصنيف + مساعد + صور). wa_assist_turns.cost_sar هو
                     مجموع نفس النداءات للمحادثة ⇒ بيتعرض للمطابقة بس ومش بيتجمع (وإلا عدّ مزدوج).

   marketingTotal = إعلانات + واتساب تسويقي + SMS تسويقي.   operationalTotal = واتساب خدمي + ردود + SMS تشغيلي + ذكاء.
   حد الـ١٣٪ (adsGuard.revenueCap) قاعدة عمر على الإعلانات بس — الملف ده مابيغيّرهاش؛ اللي بيعرض بيعرض الرقمين.
   أي مصدر وقع (جدول مش موجود/داتابيز) ⇒ null لجزئه + اسمه في errors، والباقي بيكمّل. pure helpers متختبرة.
═══════════════════════════════════════════════════════════════════════════ */
import { waRatesOf } from "./waaicost.js";
import { SMS_PART_PRICE } from "./smslog.js";

export const MARKETING_SMS_KINDS = Object.freeze(["campaign", "flow", "cart_recovery", "loyalty", "waitlist", "review_invite"]);
export const isMarketingSms = (kind) => MARKETING_SMS_KINDS.includes(String(kind || "").toLowerCase());
export const REPLY_RATE_DEFAULT = 0.0401;   // نفس DEFAULTS.replyRateSar في wabotrun.js (تسعيرة ميتا ١/١٠/٢٠٢٦)
const WA_CATS = ["marketing", "utility", "authentication"];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const r4 = (v) => Math.round(num(v) * 10000) / 10000;
const cnt = (v) => Math.max(0, Math.round(num(v)));
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null && n >= lo && n <= hi ? n : d; };
const flag = (b) => (b == null || b === "" ? null : String(b) === "true" || b === true);

/* قوالب واتساب: صفوف مجمّعة { category (فئة ميتا وإلا فئة القالب، lower)، billable ('true'|'false'|null)، n } */
export function waTemplateCost(groups, rates) {
  const R = waRatesOf(rates);
  const mk = { n: 0, cost: 0, free: 0, unpriced: 0 };
  const ut = { n: 0, cost: 0, free: 0, unpriced: 0, authentication: 0, unknownCategory: 0 };
  for (const g of groups || []) {
    const n = cnt(g && g.n); if (!n) continue;
    const cat = String((g && g.category) || "").toLowerCase();
    const b = flag(g && g.billable);
    const bucket = cat === "marketing" ? mk : ut;
    bucket.n += n;
    if (cat === "authentication") ut.authentication += n;
    if (!WA_CATS.includes(cat)) ut.unknownCategory += n;
    if (b === false) { bucket.free += n; continue; }          // ميتا قالت مجانية (نافذة خدمة مفتوحة / نقطة دخول مجانية)
    if (b == null) bucket.unpriced += n;                        // لسه مفيش حالة من ميتا ⇒ بطاقة الأسعار (تقديري)
    bucket.cost += n * (cat === "marketing" ? R.marketing : cat === "authentication" ? R.authentication : R.utility);
  }
  mk.cost = r4(mk.cost); ut.cost = r4(ut.cost);
  return { marketing: mk, utility: ut, rateDate: R.date, rates: { marketing: R.marketing, utility: R.utility, authentication: R.authentication } };
}

/* الردود الحرة (من غير قالب): billable = اللي ميتا علّمته billable بس. */
export function waRepliesCost(groups, replyRateSar = REPLY_RATE_DEFAULT) {
  const rate = clamp(replyRateSar, 0, 5, REPLY_RATE_DEFAULT);
  let n = 0, billable = 0, unpriced = 0;
  for (const g of groups || []) {
    const k = cnt(g && g.n); if (!k) continue;
    n += k;
    const b = flag(g && g.billable);
    if (b === true) billable += k; else if (b == null) unpriced += k;
  }
  return { n, billable, unpriced, rateSar: rate, cost: r4(billable * rate) };
}

/* SMS: صفوف مجمّعة بالنوع { kind, n, cost (الفعلي المعروف), est_n (cost null), est_parts (أجزاء اللي cost null) } */
export function smsSplit(rows, partPrice = SMS_PART_PRICE) {
  const mk = { n: 0, cost: 0, estimatedN: 0, estimatedCost: 0, byKind: {} };
  const op = { n: 0, cost: 0, estimatedN: 0, estimatedCost: 0, byKind: {} };
  for (const r of rows || []) {
    const n = cnt(r && r.n); if (!n) continue;
    const kind = String((r && r.kind) || "other").toLowerCase();
    const b = isMarketingSms(kind) ? mk : op;
    const est = cnt(r.est_parts) * partPrice;
    b.n += n; b.cost += num(r.cost) + est; b.estimatedN += cnt(r.est_n); b.estimatedCost += est;
    b.byKind[kind] = { n: (b.byKind[kind]?.n || 0) + n, cost: r2((b.byKind[kind]?.cost || 0) + num(r.cost) + est) };
  }
  for (const b of [mk, op]) { b.cost = r2(b.cost); b.estimatedCost = r2(b.estimatedCost); }
  return { marketing: mk, operational: op, total: r2(mk.cost + op.cost), estimated: mk.estimatedN + op.estimatedN > 0, partPrice };
}

/* الذكاء: ai_calls هو الدفتر؛ wa_assist_turns للمطابقة بس (نفس النداءات). */
export function llmOf(ai, assist) {
  const a = ai && ai[0] ? ai[0] : null;
  const t = assist && assist[0] ? assist[0] : null;
  return {
    known: a !== null,
    calls: a ? cnt(a.calls) : 0, cost: a ? r4(a.cost) : 0, estimatedCalls: a ? cnt(a.estimated) : 0,
    assistTurns: t ? { n: cnt(t.n), cost: r4(t.cost), includedInCalls: true } : null,
    total: a ? r4(a.cost) : 0,
  };
}

/* المجاميع — من غير أي عدّ مزدوج */
export function marketingSummary({ ads = null, whatsapp = null, sms = null, llm = null } = {}) {
  const adsTotal = ads && !ads.error ? r2(ads.total) : 0;
  const waMk = whatsapp ? num(whatsapp.marketing?.cost) : 0;
  const waOp = whatsapp ? num(whatsapp.utility?.cost) + num(whatsapp.replies?.cost) : 0;
  const smsMk = sms ? num(sms.marketing?.cost) : 0;
  const smsOp = sms ? num(sms.operational?.cost) : 0;
  const ai = llm ? num(llm.total) : 0;
  const estimatedParts = [];
  if (whatsapp && (num(whatsapp.marketing?.unpriced) + num(whatsapp.utility?.unpriced)) > 0) estimatedParts.push("wa_unpriced");
  if (sms && sms.estimated) estimatedParts.push("sms_parts");
  if (llm && num(llm.estimatedCalls) > 0) estimatedParts.push("llm_tokens");
  return {
    marketingTotal: r2(adsTotal + waMk + smsMk),
    operationalTotal: r2(waOp + smsOp + ai),
    total: r2(adsTotal + waMk + smsMk + waOp + smsOp + ai),
    breakdown: { ads: adsTotal, whatsapp: r2(waMk), sms: r2(smsMk), waOperational: r2(waOp), smsOperational: r2(smsOp), llm: r2(ai) },
    estimated: estimatedParts.length > 0, estimatedParts,
  };
}

/* ── الاستعلامات (كلها قراءة، نفس نافذة [start, end)) ───────────────────── */
export const SQL = Object.freeze({
  waTemplates: `SELECT lower(COALESCE(NULLIF(pricing->>'category',''), category, '')) AS category, pricing->>'billable' AS billable, count(*)::int AS n
                  FROM wa_messages
                 WHERE direction = 'out' AND template IS NOT NULL AND template <> ''
                   AND COALESCE(status,'') NOT IN ('failed','skipped')
                   AND created_at >= $1 AND created_at < $2
                 GROUP BY 1, 2`,
  waReplies: `SELECT pricing->>'billable' AS billable, count(*)::int AS n
                FROM wa_messages
               WHERE direction = 'out' AND (template IS NULL OR template = '')
                 AND COALESCE(status,'') NOT IN ('failed','skipped') AND COALESCE(source,'') <> 'history'
                 AND created_at >= $1 AND created_at < $2
               GROUP BY 1`,
  // نفس UNION «سجل الرسايل» (customer360.js /api/cms/customers/sms-log): sms_log + إرسالات الحملات من غير holdout
  sms: `WITH u AS (
          SELECT l.at, l.kind, COALESCE(l.parts, 1) AS parts, l.cost, l.status FROM sms_log l
          UNION ALL
          SELECT cs.created_at, 'campaign', COALESCE(cs.parts, 1), cs.cost, CASE WHEN cs.status = 'sent' THEN 'sent' ELSE 'failed' END
            FROM cms_campaign_sends cs WHERE cs.status <> 'holdout')
        SELECT kind, count(*)::int AS n,
               COALESCE(sum(cost) FILTER (WHERE cost IS NOT NULL), 0)::float AS cost,
               count(*) FILTER (WHERE cost IS NULL)::int AS est_n,
               COALESCE(sum(parts) FILTER (WHERE cost IS NULL), 0)::int AS est_parts
          FROM u WHERE status = 'sent' AND at >= $1 AND at < $2 GROUP BY 1`,
  aiCalls: `SELECT count(*)::int AS calls, COALESCE(sum(cost_sar), 0)::float AS cost, count(*) FILTER (WHERE estimated)::int AS estimated
              FROM ai_calls WHERE at >= $1 AND at < $2`,
  assistTurns: `SELECT count(*) FILTER (WHERE handled_by = 'assistant')::int AS n, COALESCE(sum(cost_sar), 0)::float AS cost
                  FROM wa_assist_turns WHERE at >= $1 AND at < $2`,
});

export function makeMarketingCost({ pool, getSettingsData = async () => ({}), adspend = null, log = console.error } = {}) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const spendApi = () => (typeof adspend === "function" ? adspend() : adspend) || null;

  /** { ads, whatsapp, sms, llm, marketingTotal, operationalTotal, total, breakdown, estimated, estimatedParts, errors, notes }
      opts.ads: نتيجة spendInWindow جاهزة (bizreports بيبعتها عشان مايتسحبش الصرف مرتين)؛ null = مفيش صرف؛ undefined = اسحبه هنا. */
  async function marketingCostInWindow(startUtc, endUtc, { ads } = {}) {
    const s0 = new Date(startUtc), s1 = new Date(endUtc);
    const settings = (await Promise.resolve().then(getSettingsData).catch(() => ({}))) || {};
    const wb = settings.waBot && typeof settings.waBot === "object" ? settings.waBot : {};
    const errors = [];
    const guard = async (name, fn, fallback = null) => { try { return await fn(); } catch (e) { errors.push(name); log(`[mkt-cost] ${name}:`, e && e.message); return fallback; } };
    let adsOut = ads;
    if (adsOut === undefined) { const sp = spendApi(); adsOut = sp ? await guard("ads", () => sp.spendInWindow(s0, s1)) : null; }
    const [tpl, rep, sms, ai, assist] = await Promise.all([
      guard("wa_templates", () => q(SQL.waTemplates, [s0, s1])),
      guard("wa_replies", () => q(SQL.waReplies, [s0, s1])),
      guard("sms", () => q(SQL.sms, [s0, s1])),
      guard("llm", () => q(SQL.aiCalls, [s0, s1])),
      guard("llm_assist", () => q(SQL.assistTurns, [s0, s1])),
    ]);
    const whatsapp = { ...waTemplateCost(tpl || [], wb.waRates), replies: waRepliesCost(rep || [], wb.replyRateSar), known: tpl !== null && rep !== null };
    whatsapp.total = r2(whatsapp.marketing.cost + whatsapp.utility.cost + whatsapp.replies.cost);
    const smsOut = { ...smsSplit(sms || []), known: sms !== null };
    const llm = llmOf(ai, assist);
    const sum = marketingSummary({ ads: adsOut, whatsapp, sms: smsOut, llm });
    return {
      window: { startUtc: s0.toISOString(), endUtc: s1.toISOString() },
      ads: adsOut, whatsapp, sms: smsOut, llm, ...sum, errors,
      notes: [
        "التسويق = الإعلانات (ad_spend_hourly) + قوالب واتساب التسويقية + SMS التسويقية (حملات/أتمتة/استرداد سلة/ولاء/منتظرين/دعوة تقييم) في نفس نافذة الطلبات.",
        "التشغيلي = قوالب واتساب الخدمية + الردود المدفوعة + SMS التشغيلية (رمز تحقق/حالة الطلب/الإدارة) + ذكاء البوت (ai_calls). مش داخل في «التسويق».",
        "واتساب بسعر ميتا لما تبعته (billable=false ⇒ ٠)، وإلا ببطاقة الأسعار من إعدادات البوت (تقديري). SMS بالتكلفة الفعلية من تقنيات، ولو مش معروفة الأجزاء × " + SMS_PART_PRICE + " (تقديري).",
        "صرف mk_entries اليدوي مش محسوب عشان مايتعدّش مرتين. حد الـ١٣٪ قاعدة على الإعلانات بس — مش على التسويق كله.",
      ],
    };
  }
  return { marketingCostInWindow };
}

export default { makeMarketingCost };
