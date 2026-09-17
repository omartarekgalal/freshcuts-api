/* ═══════════════════════════════════════════════════════════════════════════
   خطة الإعلانات المدفوعة (مسار ٠٩ — P1، وحدة W1-07)

   الخطة نفسها (خطوط M1–M4 / G1 / TT + مصفوفة الإعلانات) بقت داتا في
   ads_plan_lines وads_plan_creatives بدل ما تعيش في ملف Markdown، عشان
   اللوحة تقارن المخطط بالفعلي وتحسب بوابة ٢٤ سبتمبر من نفس المصدر.

   قواعد مش بتتكسر:
     • **مفيش ولا نداء كتابة على أي منصة.** الإنشاء والميزانية بيتعملوا يدوي
       في Ads Manager. الجدول مرآة للخطة والقياس: الميزانية بتتخزّن هنا بس،
       عمرها ما بتتبعت.
     • القراءة اللي فشلت = null، مش صفر. CPA على صرف غير مقروء = null.
     • الحكم من shop_orders المربوطة (attribution->>'fc_link' أو click id)،
       مش من عمود المنصة. والطلبات الاختبارية (is_test) مستبعدة لو العمود موجود.
     • الإعلان مايتعلّمش «approved» غير لو حارس النص عدّاه (وإلا 409).

   register(app, ctx, deps) — deps كلها اختيارية وممكن تبقى late-bound (دالة):
     ads        → { dailySpendData(from,to) }   (صرف يوم بيوم، null للمنصة الواقعة)
     scorecard  → { buildLedger(from,to) }      (مبيعات ٧ أيام لبوابة ٢٤)
     platforms  → نفس PLATFORMS بتاع ads.js (قراءة insights/adsetInsights بس)
     catalogStatus → async () => ({ stillMissingImage: [...] })
   التسجيل في index.js في W1-09 (مش هنا).
═══════════════════════════════════════════════════════════════════════════ */

import {
  PLATFORMS as ADS_PLATFORMS, canManage as adsCanManage, dailySpendData as adsDailySpend, SALES_ONLY,
} from "./ads.js";
import { BOT_SQL } from "./botfilter.js";

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (v == null || v === "" ? 0 : Number(v) || 0);
const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const spanDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
export const riyadhToday = (now = Date.now()) => new Date(now + 3 * 3600000).toISOString().slice(0, 10);
const late = (d) => (typeof d === "function" ? d() : d) || null;

/* ── ثوابت الخطة (٠٩ §2.1 / §3.4 / §3.6) ─────────────────────────────────── */
export const LINE_STATUSES = ["planned", "live", "paused", "killed"];
export const CREATIVE_STATUSES = ["draft", "approved", "live", "killed"];
export const GUARDED_STATUSES = ["approved", "live"];     // الحالتين دول محتاجين حارس ok
export const GATES = ["x5_google_oauth", "x6_tiktok", "gate_0924", "pdpl"];
export const CONTRIBUTION_PER_ORDER = 30;                  // خط التعادل: صرف ÷ 30
export const EXCLUDED_COUPONS = ["OMAR-9X4T"];
/* الحالات اللي معناها «الفلوس اتدفعت والطلب ماتلغاش». courier_cancelled
   مستبعدة زي ما المواصفة قالت؛ collected جاية في W3-01 ومحسوبة من دلوقتي. */
export const PAID_STATUSES = ["paid", "pos_created", "accepted", "courier_requested", "courier_assigned",
  "on_the_way", "delivered", "paid_pos_failed", "collected"];
export const GATE_0924 = { from: "2026-09-17", attributedOrders: 5, cpa: 60, sales7d: 17500, signal: 0.9 };
export const RULES = { killSpend: 240, killAtc: 10, killCpa: 80, cutCpa: 45, scaleCpa: 30, scaleOrders: 3, scaleRoas: 3, minDaysForCpa: 3 };

/* افتراضيات autopilot.js (DEFAULT_SETTINGS/ECON_DEFAULTS) — getSettings بيدمجها
   فوق الصف المخزّن، فالمفتاح الغايب من ap_settings = القيمة دي. */
const AP_DEFAULTS = { mode: "suggest", absoluteMaxTotalBudget: 2000, syncAudiences: true };

const JEDDAH = { lat: 21.588068, lng: 39.153128 };
const W1 = { from: "2026-09-17", to: "2026-09-23" };
const W2 = { from: "2026-09-24", to: "2026-09-30" };

export const PLAN_LINES = [
  {
    id: "M1", platform: "meta", name: "fc-wa-orders", objective: "OUTCOME_ENGAGEMENT",
    optimisation_event: "whatsapp_conversation", geo: { ...JEDDAH, radiusKm: 7 },
    budget_plan: [
      { from: "2026-09-14", to: W1.to, daily: 150, path: "base" },
      { ...W2, daily: 150, path: "base" },
      { ...W2, daily: 170, path: "gate", requires: ["gate_0924"] },
    ],
    gate: null, target_cpa: 22, kill_cpa: 66, status: "live",
    notes: "حملة قائمة — نفس المجموعة JED7KM-BROAD-v96 (تبديل الإعلانات بس). 18–55، بدون اهتمامات. استبعاد recent14 + web:converters7.",
  },
  {
    id: "M2", platform: "meta", name: "FC-96-WEB-ABO", objective: "OUTCOME_SALES",
    optimisation_event: "AddToCart", geo: { ...JEDDAH, radiusKm: 7 },
    budget_plan: [
      { ...W1, daily: 90, path: "base" },
      { ...W2, daily: 90, path: "base" },
      { ...W2, daily: 140, path: "gate", requires: ["gate_0924"] },
    ],
    gate: null, target_cpa: 40, kill_cpa: 80, status: "planned",
    notes: "JED7KM-BROAD-ATC-v1 — Advantage+ placements، روابط /l/96-m2-*. استبعاد recent14 + converters7 + all. ينتقل لـPurchase بعد ≥50 شراء/أسبوع.",
  },
  {
    id: "M3", platform: "meta", name: "FC-96-RMK-ABO", objective: "OUTCOME_SALES",
    optimisation_event: "AddToCart", geo: { ...JEDDAH, radiusKm: 25 },
    budget_plan: [
      { ...W2, daily: 30, path: "base" },
      { ...W2, daily: 60, path: "gate", requires: ["gate_0924"] },
    ],
    gate: "pdpl", target_cpa: 15, kill_cpa: 80, status: "planned",
    notes: "RMK-HOT14-v1 + RMK-WARM30-v1. شريحة lapsed30 مشروطة بقرار PDPL — من غيره جماهير سلوكية بس.",
  },
  {
    id: "M4", platform: "meta", name: "FC-96-APP2DIRECT", objective: "OUTCOME_SALES",
    optimisation_event: "AddToCart", geo: { ...JEDDAH, radiusKm: 25 },
    budget_plan: [
      { ...W2, daily: 30, path: "gate", requires: ["gate_0924", "pdpl"] },
    ],
    gate: "pdpl", target_cpa: 15, kill_cpa: 80, status: "planned",
    notes: "APP-DELIVERY-v1 (شريحة delivery). صفر لو قرار PDPL/شروط Keeta منع — والبديل كروت bag-keeta.",
  },
  {
    id: "G1", platform: "google", name: "FC-96-SEARCH-LOCAL", objective: "SEARCH",
    optimisation_event: "clicks", geo: { ...JEDDAH, radiusKm: 7 },
    budget_plan: [
      { from: W1.from, to: W2.to, daily: 50, path: "base", requires: ["x5_google_oauth"] },
    ],
    gate: "x5_google_oauth", target_cpa: 40, kill_cpa: 80, status: "planned",
    notes: "Max Clicks بسقف CPC 4 أول 7 أيام ثم Max Conversions لو ≥15 تحويل. ممنوع المزايدة على أسماء التطبيقات. الفلوس ماتتنقلش لمنصة تانية لو OAuth ما اتجددش.",
  },
  {
    id: "TT", platform: "tiktok", name: "FC-96-TT-LAB", objective: "WEBSITE_CONVERSIONS",
    optimisation_event: "AddToCart", geo: { ...JEDDAH, radiusKm: 7 },
    budget_plan: [
      { ...W2, daily: 70, path: "gate", requires: ["gate_0924", "x6_tiktok"] },
    ],
    gate: "x6_tiktok", target_cpa: 40, kill_cpa: 80, status: "planned",
    notes: "معمل مشروط: Spark Ads، 18–44، 70×7 = 490 أقصى. بس لو بوابة تيك توك (X6) عدّت.",
  },
];

export const PLAN_CREATIVES = [
  { id: "K-V1", offer_id: "nd96_kilo", format: "video_9x16", lines: ["M1", "M2", "TT"],
    hook: "صوت الأسياخ على الفحم + «كيلو… بـ٩٦»",
    copy: "كيلو مشاوي على الفحم بـ٩٦ ريال — كفتة، طرب، أو شيش طاووق… وطبق الأرز علينا 🔥" },
  { id: "K-S1", offer_id: "nd96_kilo", format: "static_4x5", lines: ["M1", "M2"],
    hook: "صينية الكيلو + رقم ٩٦ كبير",
    copy: "اختار كيلوك، والأرز مجاناً. ٩٦ ريال — صالة، سفري، أو توصيل من freshcuts.sa" },
  { id: "K-ST1", offer_id: "nd96_kilo", format: "story", lines: ["M1", "M2"],
    hook: "«كيلو + أرز = ٩٦»",
    copy: "اسحب واطلب كيلوك الحين" },
  { id: "B-V1", offer_id: "nd96_box", format: "video_9x16", lines: ["M2", "TT"],
    hook: "يد بتفتح البوكس: بيتزا ← باستا ← كريب ← حواوشي",
    copy: "بوكس اليوم الوطني: بيتزا + باستا + كريب من اختيارك + حواوشي، والبطاطس والكلوسلو هدية — ٩٦ ريال. حصري من الموقع" },
  { id: "B-S1", offer_id: "nd96_box", format: "static_4x5", lines: ["M2", "M3"],
    hook: "البوكس مفتوح من فوق + «٩٦ · أونلاين بس»",
    copy: "٤ أصناف تختارها + هدية، بـ٩٦. اطلبه توصيل أو استلام من freshcuts.sa" },
  { id: "B-C1", offer_id: "nd96_box", format: "carousel", lines: ["M2"],
    hook: "كارت لكل صنف",
    copy: "اختار البيتزا… الباستا… الكريب… والحواوشي والهدية علينا — ٩٦" },
  { id: "D-V1", offer_id: null, format: "video_9x16", lines: ["M1"],
    hook: "«عندنا عرضين بـ٩٦ بس»",
    copy: "كيلو مشاوي + أرز مجاناً، أو بوكس ٤ أصناف أونلاين. راسلنا واتساب نساعدك تختار" },
  { id: "R-S1", offer_id: null, format: "static_4x5", lines: ["M3"],
    hook: "«سلتك لسه مستنياك»",
    copy: "عروض ٩٦ مستمرة لحد نهاية سبتمبر — كمّل طلبك من freshcuts.sa" },
  { id: "A-S1", offer_id: null, format: "static_4x5", lines: ["M4"],
    hook: "«اطلب من فريش كاتس مباشرة»",
    copy: "أول طلب توصيل من الموقع مجاناً — والبوكس ٩٦ موجود على الموقع بس" },
  { id: "G-RSA", offer_id: null, format: "rsa", lines: ["G1"],
    hook: "كيلو مشاوي بـ٩٦ ريال · فريش كاتس – اطلب أونلاين · مشويات على الفحم بجدة · بوكس ٩٦ حصري أونلاين · طبق أرز مجاناً مع الكيلو · حي السلامة – دوار رامي",
    copy: "كيلو كفتة أو طرب أو شيش طاووق + طبق أرز مجاناً بـ٩٦. توصيل أو استلام. · بوكس بيتزا وباستا وكريب وحواوشي بـ٩٦، حصري على freshcuts.sa." },
  { id: "O-ND", offer_id: null, format: "video_9x16", lines: [],
    hook: "«عزّنا بكرمنا» — دلة/ضيافة/طاقم المطعم",
    copy: "كل عام ووطننا بخير 💚 من فريش كاتس" },
];

/* ═══ حارس نص الإعلان (٠٩ §3.0-6 و§3.9) ═══════════════════════════════════
   ممنوع: ادعاء توفير/نسبة («وفّر»، «خصم»، «٪»، «بدل ٩٠»، «كان/صار» + سعر،
   «أرخص»)، إيموجي علم، «داخل الصالة» على البوكس (البوكس أونلاين بس)، ستيك،
   بيبسي مع الكيلو، سي فود مع البوكس. التشكيل والتطويل بيتشالوا قبل الفحص عشان
   «وفّر» و«وفــر» مايعدّوش.                                                */
const AR = "\\u0621-\\u064A";
export function normArabic(s) {
  return String(s || "")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي");
}
const SAVINGS_WORD = new RegExp(`(^|[^${AR}])(ال|و|ب|ف|ل|ك){0,3}(وفر|توفير|خصم|تخفيض|ارخص)`, "u");
const PERCENT = /[٪%]/u;
const INSTEAD_PRICE = new RegExp(`(^|[^${AR}])بدل(ا)?\\s*(من\\s*)?[\\d٠-٩]`, "u");
const WAS_NOW = new RegExp(`(^|[^${AR}])(كان|صار)(ت)?\\s*(ب)?\\s*[\\d٠-٩]`, "u");
const EN_SAVINGS = /\b(save|saving|savings|discount)\b|\boff\s*\d|\d+\s*[%٪]?\s*off\b/i;
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F3F3}\u{1F3F4}\u{1F6A9}\u{1F38C}]/u;
const DINE_IN = /داخل\s*الصال[هة]/u;
const STEAK = /ستيك|steak/iu;
const PEPSI = /بيبسي|pepsi/iu;
const SEAFOOD = /سي\s*فود|seafood/iu;
const BOX_WORD = /بوكس|box/iu;
const ONLINE_WORD = /اونلاين|الموقع|freshcuts\.sa|online/iu;

export function guardCopy({ offer_id = null, hook = "", copy = "" } = {}, now = new Date()) {
  const raw = `${hook || ""}\n${copy || ""}`;
  const text = normArabic(raw);
  const problems = [];
  const add = (code, msg) => problems.push({ code, msg });
  const isBox = offer_id === "nd96_box";
  const isKilo = offer_id === "nd96_kilo";
  if (SAVINGS_WORD.test(text) || EN_SAVINGS.test(text)) add("savings", "ادعاء توفير/خصم — «٩٦» رقم مش خصم");
  if (PERCENT.test(text)) add("percent", "نسبة مئوية ممنوعة في نص الإعلان");
  if (INSTEAD_PRICE.test(text)) add("instead_of_price", "«بدل» + سعر = سعر قديم ممنوع");
  if (WAS_NOW.test(text)) add("was_now", "«كان/صار» + سعر = سعر قديم ممنوع");
  if (FLAG.test(raw)) add("flag", "مفيش علم على إعلان فيه أكل أو سعر");
  if (STEAK.test(text)) add("steak", "مفيش ستيك في إعلانات ٩٦");
  if ((isBox || (!offer_id && BOX_WORD.test(text))) && DINE_IN.test(text)) {
    add("box_dine_in", "البوكس حصري أونلاين — «داخل الصالة» ممنوعة");
  }
  if (isBox && SEAFOOD.test(text)) add("box_seafood", "مفيش سي فود في البوكس");
  if (isKilo && PEPSI.test(text)) add("kilo_pepsi", "مفيش بيبسي مع الكيلو");
  const warnings = [];
  if (isBox && !ONLINE_WORD.test(text)) warnings.push({ code: "box_online_missing", msg: "نسخة البوكس مفيهاش «أونلاين/الموقع» — راجع التصميم" });
  if (isKilo && !/ارز/u.test(text)) warnings.push({ code: "kilo_rice_missing", msg: "نسخة الكيلو مفيهاش «الأرز» — راجع التصميم" });
  return { ok: problems.length === 0, problems, warnings, checkedAt: now.toISOString() };
}

/* ═══ التحقق من الـbody ═════════════════════════════════════════════════ */
const PLATFORM_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
const strOrNull = (v, max) => (v == null || v === "" ? null : String(v).slice(0, max));

export function validateBudgetPlan(v) {
  if (!Array.isArray(v) || v.length > 20) return { ok: false, error: "budget_plan لازم array (≤20)" };
  const out = [];
  for (const e of v) {
    if (!e || typeof e !== "object") return { ok: false, error: "budget_plan: عنصر غير صالح" };
    if (!isDay(e.from) || !isDay(e.to) || e.from > e.to) return { ok: false, error: "budget_plan: from/to لازم YYYY-MM-DD وfrom ≤ to" };
    const daily = Number(e.daily);
    if (!Number.isFinite(daily) || daily < 0 || daily > 5000) return { ok: false, error: "budget_plan: daily بين 0 و5000" };
    const path = e.path == null ? "base" : String(e.path);
    if (!["base", "gate"].includes(path)) return { ok: false, error: "budget_plan: path = base|gate" };
    const item = { from: e.from, to: e.to, daily: r2(daily), path };
    if (e.requires != null) {
      if (!Array.isArray(e.requires) || e.requires.some((g) => !GATES.includes(g))) {
        return { ok: false, error: `budget_plan: requires من ${GATES.join("|")}` };
      }
      item.requires = [...new Set(e.requires)];
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

export function validateLinePatch(b = {}) {
  const patch = {};
  if (!b || typeof b !== "object") return { ok: false, error: "body غير صالح" };
  if (b.status !== undefined) {
    if (!LINE_STATUSES.includes(b.status)) return { ok: false, error: `status من ${LINE_STATUSES.join("|")}` };
    patch.status = b.status;
  }
  for (const k of ["platform_campaign_id", "platform_adset_id"]) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") { patch[k] = null; continue; }
    const s = String(b[k]).trim();
    if (!PLATFORM_ID_RE.test(s)) return { ok: false, error: `${k} غير صالح` };
    patch[k] = s;
  }
  if (b.budget_plan !== undefined) {
    const v = validateBudgetPlan(b.budget_plan);
    if (!v.ok) return v;
    patch.budget_plan = v.value;
  }
  if (b.notes !== undefined) patch.notes = strOrNull(b.notes, 2000);
  if (!Object.keys(patch).length) return { ok: false, error: "مفيش حقول للتعديل" };
  return { ok: true, patch };
}

export function validateCreativePatch(b = {}) {
  const patch = {};
  if (!b || typeof b !== "object") return { ok: false, error: "body غير صالح" };
  if (b.status !== undefined) {
    if (!CREATIVE_STATUSES.includes(b.status)) return { ok: false, error: `status من ${CREATIVE_STATUSES.join("|")}` };
    patch.status = b.status;
  }
  if (b.media_ids !== undefined) {
    if (!Array.isArray(b.media_ids) || b.media_ids.length > 20) return { ok: false, error: "media_ids لازم array (≤20)" };
    patch.media_ids = b.media_ids.map((x) => String(x).slice(0, 100)).filter(Boolean);
  }
  if (b.copy !== undefined) patch.copy = String(b.copy ?? "").slice(0, 2000);
  if (b.hook !== undefined) patch.hook = String(b.hook ?? "").slice(0, 500);
  if (!Object.keys(patch).length) return { ok: false, error: "مفيش حقول للتعديل" };
  return { ok: true, patch };
}

/* ═══ الميزانية المخططة ═════════════════════════════════════════════════
   path=base: المسار الأساسي. path=gate: لو بوابة ٢٤ عدّت — سطر gate بيحل
   محل base لنفس اليوم لو موجود.                                            */
export function plannedDaily(line, day, path = "base") {
  const plan = Array.isArray(line?.budget_plan) ? line.budget_plan
    : (typeof line?.budget_plan === "string" ? JSON.parse(line.budget_plan) : []);
  const covers = (e) => e.from <= day && day <= e.to;
  const base = plan.filter((e) => (e.path || "base") === "base" && covers(e)).reduce((a, e) => a + num(e.daily), 0);
  if (path === "gate") {
    const g = plan.filter((e) => e.path === "gate" && covers(e));
    if (g.length) return g.reduce((a, e) => a + num(e.daily), 0);
  }
  return base;
}
export function plannedSpend(line, from, to, path = "base") {
  let s = 0;
  for (let d = from; d <= to; d = shiftDay(d, 1)) s += plannedDaily(line, d, path);
  return r2(s);
}

/* slug → خط الخطة. `96-<منصة>-<خط>-<عرض>` (٠٩ §3.8). عمود cms_links.line
   لو موجود بيكسب؛ ده fallback للروابط اللي اتعملت قبل الأعمدة.          */
export function lineOfSlug(slug) {
  const s = String(slug || "").toLowerCase();
  if (s.startsWith("bag-")) return "bag";
  if (s === "96-counter") return "counter";
  let m = s.match(/^96-(m[1-4])-/);
  if (m) return m[1].toUpperCase();
  if (/^96-wa-/.test(s)) return "M1";
  if (/^96-g-/.test(s)) return "G1";
  if (/^96-tt-/.test(s)) return "TT";
  if (s === "96-gbp") return "gbp";
  return null;
}
const isMovedSlug = (slug) => /^bag-/i.test(String(slug || "")) || String(slug || "").toLowerCase() === "96-counter";

/* ═══ الحكم (نسخة عرض — القرار الحقيقي في autopilot.decideStoreAdset) ═══ */
export function verdictOf(row, days) {
  if (row.key === "M1") return { kind: "none", reason: "خط محادثة — بيتحكم بـdecide() في الطيار" };
  if (row.spend == null) return { kind: "none", reason: "الصرف غير مقروء — مفيش حكم" };
  if (row.spend >= RULES.killSpend && row.orders === 0 && num(row.atc) < RULES.killAtc) {
    return { kind: "kill", reason: `صرف ${r2(row.spend)} ≥ ${RULES.killSpend} من غير طلب مربوط وATC أقل من ${RULES.killAtc}` };
  }
  if (row.cpa == null) return { kind: "none", reason: "مفيش طلبات مربوطة كفاية للحكم" };
  if (days < RULES.minDaysForCpa) return { kind: "none", reason: `المدى أقل من ${RULES.minDaysForCpa} أيام` };
  if (row.cpa > RULES.killCpa) return { kind: "kill", reason: `CPA ${row.cpa} فوق ${RULES.killCpa} على ${days} أيام` };
  if (row.cpa >= RULES.cutCpa) return { kind: "cut", reason: `CPA ${row.cpa} بين ${RULES.cutCpa} و${RULES.killCpa} على ${days} أيام` };
  if (row.cpa <= RULES.scaleCpa && row.orders >= RULES.scaleOrders && row.roas != null && row.roas >= RULES.scaleRoas) {
    return { kind: "scale", reason: `CPA ${row.cpa} ≤ ${RULES.scaleCpa} على ${row.orders} طلبات وROAS ${row.roas}` };
  }
  return { kind: "hold", reason: "جوّه الحدود" };
}

const ratio = (n, d) => (d > 0 ? Math.round((n / d) * 100) / 100 : null);

/* ═══ الأداء — دالة صافية فوق الداتا المقروءة ════════════════════════════
   input = { from, to, by, lines, links, clicks, funnel, orders, spend }
     links:  [{ slug, line, platform, creative_id }]
     clicks: Map slug → { clicks, withClickId } | null (null = مش مقروء)
     funnel: [{ slug, term, sessions, atc, checkout }]
     orders: [{ order_no, slug, term, total, attributed, kind, purchases, withContents, websiteClaims, fbc }]
     spend:  { platforms: {meta: number|null…}, lines: {M2: {spend, source}|undefined},
               unavailable: [{platform, why}] }                                        */
export function buildPerformance(input) {
  const { from, to, by = "line" } = input;
  const days = spanDays(from, to);
  const lines = input.lines || [];
  const links = input.links || [];
  const linkBySlug = new Map(links.map((l) => [l.slug, l]));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const creativeIds = new Set((input.creatives || []).map((c) => c.id));
  const spend = input.spend || { platforms: {}, lines: {}, unavailable: [] };
  const unavailable = [...new Set((spend.unavailable || []).map((u) => u.platform))];
  const notes = [];

  const lineOf = (slug) => linkBySlug.get(slug)?.line || lineOfSlug(slug) || "other";
  const creativeOf = (slug, term) => (term && creativeIds.has(term) ? term : linkBySlug.get(slug)?.creative_id || "unknown");
  const keyOf = (slug, term) => (by === "link" ? slug : by === "creative" ? creativeOf(slug, term) : lineOf(slug));
  const platformOfKey = (key, slug) => {
    if (by === "line") return lineById.get(key)?.platform || linkBySlug.get(slug)?.platform || null;
    return linkBySlug.get(slug)?.platform || lineById.get(lineOf(slug))?.platform || null;
  };

  const rows = new Map();
  const rowFor = (key, platform) => {
    if (!rows.has(key)) {
      rows.set(key, { key, platform: platform || null, clicks: null, sessions: 0, atc: 0, checkout: 0,
        orders: 0, revenue: 0, newConfirmed: 0, existing: 0, moved: 0,
        _sig: { n: 0, once: 0, contents: 0, fbc: 0 } });
    }
    const r = rows.get(key);
    if (!r.platform && platform) r.platform = platform;
    return r;
  };
  if (by === "line") for (const l of lines) rowFor(l.id, l.platform);

  // النقرات: من cms_link_clicks_daily لو موجود للمدى، وإلا null («غير مقروء»)
  if (input.clicks) {
    for (const l of links) {
      const cl = input.clicks.get(l.slug);
      if (!cl) continue;
      const r = rowFor(keyOf(l.slug, null), platformOfKey(keyOf(l.slug, null), l.slug));
      r.clicks = (r.clicks || 0) + num(cl.clicks);
    }
  } else {
    notes.push("نقرات الروابط اليومية غير مقروءة (cms_link_clicks_daily مش موجود) — clicks=null");
  }

  for (const f of input.funnel || []) {
    const key = keyOf(f.slug, f.term);
    const r = rowFor(key, platformOfKey(key, f.slug));
    r.sessions += num(f.sessions); r.atc += num(f.atc); r.checkout += num(f.checkout);
  }

  let clickFallback = 0;
  for (const o of input.orders || []) {
    if (!o.attributed || !o.slug) continue;
    if (o.via === "click") clickFallback++;
    const key = keyOf(o.slug, o.term);
    const r = rowFor(key, platformOfKey(key, o.slug));
    r.orders++; r.revenue += num(o.total);
    if (isMovedSlug(o.slug)) r.moved++;
    else if (o.kind === "new") r.newConfirmed++;
    else if (o.kind === "existing") r.existing++;
    r._sig.n++;
    if (num(o.purchases) <= 1 && num(o.purchases) + num(o.websiteClaims) > 0) r._sig.once++;
    if (o.withContents) r._sig.contents++;
    if (o.fbc) r._sig.fbc++;
  }
  if (clickFallback) notes.push(`${clickFallback} طلب اتربط بالـclick id عن طريق funnel_events (مفيش fc_link)`);

  const out = [];
  for (const r of rows.values()) {
    let s = null, source = null;
    if (by === "line") {
      const ls = spend.lines?.[r.key];
      if (ls && ls.spend != null && !unavailable.includes(r.platform)) { s = r2(ls.spend); source = ls.source; }
    }
    const row = {
      key: r.key, platform: r.platform,
      spend: s, spendSource: source,
      clicks: r.clicks, sessions: r.sessions, atc: r.atc, checkout: r.checkout,
      orders: r.orders, revenue: r2(r.revenue),
      newConfirmed: r.newConfirmed, existing: r.existing, moved: r.moved,
      cpa: s != null && r.orders > 0 ? r2(s / r.orders) : null,
      roas: s != null && s > 0 ? r2(r.revenue / s) : null,
      breakevenOrders: s != null ? r2(s / CONTRIBUTION_PER_ORDER) : null,
      signal: {
        purchaseOnce: ratio(r._sig.once, r._sig.n),
        withContents: ratio(r._sig.contents, r._sig.n),
        withFbc: ratio(r._sig.fbc, r._sig.n),
      },
    };
    if (by === "line" && lineById.has(r.key)) {
      const line = lineById.get(r.key);
      row.planned = { base: plannedSpend(line, from, to, "base"), gate: plannedSpend(line, from, to, "gate") };
      row.status = line.status;
    }
    row.verdict = by === "line" && lineById.has(r.key) ? verdictOf(row, days) : null;
    out.push(row);
  }
  if (by !== "line") notes.push("الصرف متاح على مستوى الخط بس — spend=null هنا");

  const platformSpend = {};
  let spendTotal = 0, anyRead = false;
  for (const [p, v] of Object.entries(spend.platforms || {})) {
    platformSpend[p] = unavailable.includes(p) || v == null ? null : r2(v);
    if (platformSpend[p] != null) { spendTotal += platformSpend[p]; anyRead = true; }
  }
  for (const p of unavailable) platformSpend[p] = null;
  const sum = (k) => out.reduce((a, x) => a + num(x[k]), 0);
  const totalSpend = anyRead ? r2(spendTotal) : null;
  const totals = {
    spend: totalSpend, spendComplete: anyRead && unavailable.length === 0, platformSpend,
    clicks: out.some((x) => x.clicks != null) ? sum("clicks") : null,
    sessions: sum("sessions"), atc: sum("atc"), checkout: sum("checkout"),
    orders: sum("orders"), revenue: r2(sum("revenue")),
    newConfirmed: sum("newConfirmed"), existing: sum("existing"), moved: sum("moved"),
    cpa: totalSpend != null && sum("orders") > 0 ? r2(totalSpend / sum("orders")) : null,
    roas: totalSpend != null && totalSpend > 0 ? r2(sum("revenue") / totalSpend) : null,
    breakevenOrders: totalSpend != null ? r2(totalSpend / CONTRIBUTION_PER_ORDER) : null,
  };
  for (const u of spend.unavailable || []) notes.push(`صرف ${u.platform} غير مقروء: ${u.why || "—"}`);
  return { ok: true, range: { from, to }, by, rows: out, totals, unavailable, notes };
}

/* ═══ بوابة ٢٤ سبتمبر — دالة صافية ═════════════════════════════════════ */
export function buildGate({ attributedOrders = 0, spend = null, sales7d = null, signal = null } = {}) {
  const cpa = spend != null && attributedOrders > 0 ? r2(spend / attributedOrders) : null;
  const checks = [
    { id: "attributedOrders", value: attributedOrders, need: GATE_0924.attributedOrders, ok: attributedOrders >= GATE_0924.attributedOrders },
    { id: "cpa", value: cpa, need: GATE_0924.cpa, ok: cpa != null && cpa <= GATE_0924.cpa },
    { id: "sales7d", value: sales7d == null ? null : r2(sales7d), need: GATE_0924.sales7d, ok: sales7d != null && sales7d >= GATE_0924.sales7d },
    { id: "signal", value: signal, need: GATE_0924.signal, ok: signal != null && signal >= GATE_0924.signal },
  ];
  return { ok: true, pass: checks.every((c) => c.ok), checks };
}

/* signal للبوابة: أقل نسبة بين «Purchase واحد لكل طلب» و«فيه contents». */
export function signalOf(orders) {
  const n = orders.length;
  if (!n) return null;
  const once = orders.filter((o) => num(o.purchases) <= 1 && num(o.purchases) + num(o.websiteClaims) > 0).length;
  const withC = orders.filter((o) => o.withContents).length;
  return Math.min(ratio(once, n), ratio(withC, n));
}

/* _fbc كوكي بيعيش ٩٠ يوم — لوحده (من غير fc_link/click id) مايتحسبش ربط غير
   لو اتعمل خلال ٧ أيام قبل الطلب (نافذة النقر بتاعة ميتا). fb.<n>.<ms>.<fbclid> */
export const FBC_WINDOW_MS = 7 * 86400000;
export function fbcFresh(fbc, createdAt) {
  const m = /^fb\.\d+\.(\d{10,13})\./.exec(String(fbc || ""));
  if (!m) return false;
  const ts = m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000;
  const at = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(ts)) return false;
  return ts <= at + 3600000 && at - ts <= FBC_WINDOW_MS;
}

/* ═══ الـschema + البذرة ═══════════════════════════════════════════════ */
export async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_plan_lines (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      objective TEXT,
      optimisation_event TEXT,
      platform_campaign_id TEXT,
      platform_adset_id TEXT,
      geo JSONB,
      budget_plan JSONB NOT NULL DEFAULT '[]'::jsonb,
      gate TEXT,
      target_cpa NUMERIC,
      kill_cpa NUMERIC,
      status TEXT NOT NULL DEFAULT 'planned',
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS ads_plan_creatives (
      id TEXT PRIMARY KEY,
      offer_id TEXT,
      format TEXT,
      hook TEXT,
      copy TEXT,
      lines TEXT[],
      media_ids TEXT[],
      guard JSONB,
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  for (const l of PLAN_LINES) {
    await pool.query(
      `INSERT INTO ads_plan_lines (id, platform, name, objective, optimisation_event, geo, budget_plan, gate,
                                   target_cpa, kill_cpa, status, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,'seed')
       ON CONFLICT (id) DO NOTHING`,
      [l.id, l.platform, l.name, l.objective, l.optimisation_event, JSON.stringify(l.geo),
       JSON.stringify(l.budget_plan), l.gate, l.target_cpa, l.kill_cpa, l.status, l.notes]);
  }
  for (const cr of PLAN_CREATIVES) {
    await pool.query(
      `INSERT INTO ads_plan_creatives (id, offer_id, format, hook, copy, lines, media_ids, guard, status)
       VALUES ($1,$2,$3,$4,$5,$6::text[],'{}'::text[],NULL,'draft')
       ON CONFLICT (id) DO NOTHING`,
      [cr.id, cr.offer_id, cr.format, cr.hook, cr.copy, cr.lines]);
  }
}

const parseJson = (v, d) => {
  if (v == null) return d;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return d; } }
  return v;
};
export function lineRow(r) {
  if (!r) return null;
  return {
    id: r.id, platform: r.platform, name: r.name, objective: r.objective || null,
    optimisation_event: r.optimisation_event || null,
    platform_campaign_id: r.platform_campaign_id || null, platform_adset_id: r.platform_adset_id || null,
    geo: parseJson(r.geo, null), budget_plan: parseJson(r.budget_plan, []), gate: r.gate || null,
    target_cpa: r.target_cpa == null ? null : Number(r.target_cpa),
    kill_cpa: r.kill_cpa == null ? null : Number(r.kill_cpa),
    status: r.status, notes: r.notes || null, updated_at: r.updated_at || null, updated_by: r.updated_by || null,
  };
}
export function creativeRow(r) {
  if (!r) return null;
  return {
    id: r.id, offer_id: r.offer_id || null, format: r.format || null, hook: r.hook || "", copy: r.copy || "",
    lines: Array.isArray(r.lines) ? r.lines : [], media_ids: Array.isArray(r.media_ids) ? r.media_ids : [],
    guard: parseJson(r.guard, null), status: r.status, updated_at: r.updated_at || null,
  };
}

/* ═══ register ══════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const normPhone = ctx.normPhone || ((s) => String(s || "").replace(/\D/g, ""));
  const platforms = deps.platforms || ADS_PLATFORMS;
  const canManage = deps.canManage || (deps.platforms ? () => true : adsCanManage);
  const nowFn = deps.now || (() => Date.now());

  const ready = ensureSchema(pool)
    .then(() => { console.log("[adsplan] schema ready"); return true; })
    .catch((e) => { console.error("[adsplan] schema failed:", e.message); return false; });

  const actorOf = (c) => {
    const h = c.req.header("Authorization") || "";
    return h.startsWith("Bearer cms:") ? "cms" : "admin";
  };

  let isTestKnown = false;
  async function hasIsTest() {
    if (isTestKnown) return true;
    try {
      const r = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='shop_orders' AND column_name='is_test' LIMIT 1`);
      if (r.rows.length) isTestKnown = true;
    } catch { /* مش مقروء = نفترض مش موجود */ }
    return isTestKnown;
  }

  async function staffPhonesList() {
    try {
      const d = ctx.getSettingsData ? await ctx.getSettingsData() : null;
      const list = Array.isArray(d?.cms?.staffPhones) ? d.cms.staffPhones : [];
      return list.map((p) => normPhone(p)).filter(Boolean);
    } catch { return []; }
  }

  async function loadLines() {
    return (await pool.query(`SELECT * FROM ads_plan_lines ORDER BY id`)).rows.map(lineRow);
  }
  async function loadCreatives() {
    return (await pool.query(`SELECT * FROM ads_plan_creatives ORDER BY id`)).rows.map(creativeRow);
  }
  /* to_jsonb عشان أعمدة platform/line/offer_id/creative_id جاية في W2-09 —
     الاستعلام مايقعش لو لسه مش موجودة. */
  async function loadLinks() {
    const rows = (await pool.query(`SELECT to_jsonb(l) AS j FROM cms_links l ORDER BY l.id`)).rows;
    return rows.map(({ j }) => {
      const x = parseJson(j, {});
      return {
        id: x.id, slug: x.slug, label: x.label || null, active: x.active !== false,
        target_type: x.target_type || null, target_id: x.target_id || null, coupon: x.coupon || null,
        utm_source: x.utm_source || null, utm_campaign: x.utm_campaign || null,
        clicksTotal: num(x.clicks),
        platform: x.platform || null, offer_id: x.offer_id || null, creative_id: x.creative_id || null,
        line: x.line || lineOfSlug(x.slug), lineDerived: !x.line,
      };
    });
  }
  async function loadClicks(from, to) {
    try {
      const r = await pool.query(
        `SELECT slug, COALESCE(sum(clicks),0)::int AS clicks, COALESCE(sum(with_click_id),0)::int AS with_id
           FROM cms_link_clicks_daily WHERE day BETWEEN $1::date AND $2::date GROUP BY slug`, [from, to]);
      return new Map(r.rows.map((x) => [x.slug, { clicks: num(x.clicks), withClickId: num(x.with_id) }]));
    } catch { return null; }
  }
  async function loadFunnel(from, to) {
    const r = await pool.query(
      `SELECT utm->>'utm_content' AS slug, NULLIF(utm->>'utm_term','') AS term,
              count(DISTINCT COALESCE(ip,'') || '|' || COALESCE(ua,'')) FILTER (WHERE event_name='PageView')::int AS sessions,
              count(DISTINCT COALESCE(event_id, id)) FILTER (WHERE event_name='AddToCart')::int AS atc,
              count(DISTINCT COALESCE(event_id, id)) FILTER (WHERE event_name='InitiateCheckout')::int AS checkout
         FROM funnel_events
        WHERE (created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date
          AND COALESCE(utm->>'utm_content','') <> ''
          AND NOT ${BOT_SQL()}   -- زاحف مراجعة ميتا مش «جلسة» (١٧ سبتمبر)
        GROUP BY 1, 2`, [from, to]);
    return r.rows;
  }

  /* الطلبات المدفوعة الحقيقية في المدى، مع الربط والإشارة وتصنيف الجديد. */
  async function loadOrders(from, to) {
    const isTest = await hasIsTest();
    const staff = await staffPhonesList();
    const r = await pool.query(
      `SELECT o.order_no, o.total, o.pos_order_id, o.created_at,
              NULLIF(o.attribution->>'fc_link','') AS fc_link,
              NULLIF(o.attribution->'utm'->>'utm_term','') AS utm_term,
              NULLIF(o.attribution->'click'->>'fbc','') AS fbc,
              COALESCE(NULLIF(o.attribution->'click'->>'fbclid',''), NULLIF(o.attribution->'click'->>'ttclid',''),
                       NULLIF(o.attribution->'click'->>'gclid',''), NULLIF(o.attribution->'click'->>'ScCid',''),
                       NULLIF(o.attribution->'click'->>'gbraid',''), NULLIF(o.attribution->'click'->>'wbraid','')) AS click_id,
              fe.slug AS click_slug, fe.term AS click_term,
              (SELECT count(*) FROM funnel_events f
                WHERE f.event_name='Purchase' AND f.order_id IN (o.order_no, o.pos_order_id))::int AS purchases,
              EXISTS (SELECT 1 FROM funnel_events f
                WHERE f.event_name='Purchase' AND f.order_id IN (o.order_no, o.pos_order_id)
                  AND CASE WHEN jsonb_typeof(f.contents)='array' THEN jsonb_array_length(f.contents) > 0 ELSE FALSE END) AS with_contents,
              (SELECT count(*) FROM ads_events a
                WHERE a.event_name='Purchase' AND a.order_id IN (o.order_no, o.pos_order_id)
                  AND a.request->>'source'='website')::int AS website_claims,
              CASE WHEN COALESCE(o.phone_norm,'') = '' THEN NULL ELSE (
                EXISTS (SELECT 1 FROM shop_orders p WHERE p.phone_norm = o.phone_norm
                          AND p.created_at < o.created_at AND p.status = ANY($3::text[]))
                OR EXISTS (SELECT 1 FROM ts_customers tc WHERE tc.phone_norm = o.phone_norm
                          AND COALESCE(tc.first_order_at, tc.registered_at) < o.created_at)
                OR EXISTS (SELECT 1 FROM order_sources s WHERE s.phone_norm = o.phone_norm
                          AND s.filled_at < o.created_at)
              ) END AS seen_before
         FROM shop_orders o
         LEFT JOIN LATERAL (
           SELECT f.utm->>'utm_content' AS slug, NULLIF(f.utm->>'utm_term','') AS term
             FROM funnel_events f
            WHERE NULLIF(o.attribution->>'fc_link','') IS NULL
              AND COALESCE(f.utm->>'utm_content','') <> ''
              AND ( (NULLIF(o.attribution->'click'->>'fbclid','') IS NOT NULL AND f.click_ids->>'fbclid' = o.attribution->'click'->>'fbclid')
                 OR (NULLIF(o.attribution->'click'->>'ttclid','') IS NOT NULL AND f.click_ids->>'ttclid' = o.attribution->'click'->>'ttclid')
                 OR (NULLIF(o.attribution->'click'->>'gclid','')  IS NOT NULL AND f.click_ids->>'gclid'  = o.attribution->'click'->>'gclid')
                 OR (NULLIF(o.attribution->'click'->>'ScCid','')  IS NOT NULL AND f.click_ids->>'ScCid'  = o.attribution->'click'->>'ScCid') )
            ORDER BY f.created_at DESC LIMIT 1
         ) fe ON TRUE
        WHERE (o.created_at AT TIME ZONE 'Asia/Riyadh')::date BETWEEN $1::date AND $2::date
          AND o.status = ANY($3::text[])
          AND upper(COALESCE(o.coupon,'')) <> ALL($4::text[])
          AND NOT (COALESCE(o.phone_norm,'') = ANY($5::text[]))
          ${isTest ? "AND NOT o.is_test" : ""}
        ORDER BY o.created_at`,
      [from, to, PAID_STATUSES, EXCLUDED_COUPONS, staff]);
    return r.rows.map((x) => {
      const slug = x.fc_link || x.click_slug || null;
      return {
        order_no: x.order_no, total: num(x.total),
        slug, term: x.utm_term || x.click_term || null,
        via: x.fc_link ? "fc_link" : x.click_slug ? "click" : null,
        attributed: Boolean(x.fc_link || x.click_id || fbcFresh(x.fbc, x.created_at)),
        kind: x.seen_before == null ? "unknown" : x.seen_before ? "existing" : "new",
        purchases: num(x.purchases), withContents: Boolean(x.with_contents),
        websiteClaims: num(x.website_claims), fbc: Boolean(x.fbc),
      };
    });
  }

  /* الصرف: إجمالي المنصة من dailySpendData، ولكل خط من insights (قراءة بس)
     بمعرّف الحملة/المجموعة المسجّل يدوياً. */
  async function loadSpend(from, to, lines) {
    const out = { platforms: {}, lines: {}, unavailable: [] };
    const adsApi = late(deps.ads);
    const spendFn = adsApi?.dailySpendData || deps.dailySpendData || adsDailySpend;
    try {
      const d = await spendFn(from, to);
      for (const u of d?.unavailable || []) out.unavailable.push({ platform: u.platform, why: u.why || null });
      for (const p of d?.platformsRead || []) {
        out.platforms[p] = r2((d.days || []).reduce((a, x) => a + num(x[p]), 0));
      }
    } catch (e) {
      for (const p of [...new Set(lines.map((l) => l.platform))]) out.unavailable.push({ platform: p, why: String(e?.message || e) });
    }
    const down = new Set(out.unavailable.map((u) => u.platform));

    const cache = new Map();
    const read = async (p, kind) => {
      const k = `${p.id}:${kind}`;
      if (!cache.has(k)) {
        cache.set(k, (async () => {
          if (typeof p[kind] !== "function") return { ok: false, reason: `${kind} غير مدعوم` };
          try { return await p[kind]({ from, to }); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
        })());
      }
      return cache.get(k);
    };
    for (const line of lines) {
      if (down.has(line.platform)) continue;
      const p = platforms.find((x) => x.id === line.platform);
      const idKind = line.platform_adset_id ? "adsetInsights" : line.platform_campaign_id ? "insights" : null;
      if (typeof deps.lineSpend === "function") {
        try {
          const v = await deps.lineSpend({ line, from, to });
          if (v && v.spend !== undefined) { out.lines[line.id] = { spend: v.spend, source: v.source || "custom" }; continue; }
        } catch { /* يكمل على القراءة العادية */ }
      }
      if (idKind && p && canManage(p)) {
        const r = await read(p, idKind);
        if (!r?.ok) { out.lines[line.id] = { spend: null, source: null, why: r?.reason || "فشل القراءة" }; continue; }
        const match = (r.rows || []).filter((x) => (idKind === "adsetInsights"
          ? String(x.adsetId) === String(line.platform_adset_id)
          : String(x.campaignId) === String(line.platform_campaign_id)));
        out.lines[line.id] = { spend: r2(match.reduce((a, x) => a + num(x.spend), 0)), source: `${line.platform}_insights` };
        continue;
      }
      /* من غير معرّف: لو الخط ده هو الوحيد على منصته اللي ليه ميزانية في
         المدى، صرف المنصة كله بيتحسب عليه (ومكتوب مصدره). غير كده null. */
      const peers = lines.filter((l) => l.platform === line.platform
        && (l.status === "live" || plannedSpend(l, from, to, "base") > 0));
      if (peers.length === 1 && peers[0].id === line.id && out.platforms[line.platform] != null) {
        out.lines[line.id] = { spend: out.platforms[line.platform], source: "platform_total" };
      }
    }
    return out;
  }

  function rangeOf(c, defDays = 7) {
    const today = riyadhToday(nowFn());
    let to = isDay(c.req.query("to")) ? c.req.query("to") : today;
    let from = isDay(c.req.query("from")) ? c.req.query("from") : shiftDay(to, -(defDays - 1));
    if (from > to) { const t = from; from = to; to = t; }
    if (spanDays(from, to) > 92) from = shiftDay(to, -91);
    return { from, to };
  }

  async function performance({ from, to, by = "line" }) {
    await ready;
    const [lines, creatives, links, clicks, funnel, orders] = await Promise.all([
      loadLines(), loadCreatives(), loadLinks(), loadClicks(from, to), loadFunnel(from, to), loadOrders(from, to),
    ]);
    const spend = await loadSpend(from, to, lines);
    return buildPerformance({ from, to, by, lines, creatives, links, clicks, funnel, orders, spend });
  }

  /* ── الجاهزية (٠٩ §3.13) — كل بند مستقل؛ بند فشلت قراءته ok:null ── */
  async function readiness() {
    await ready;
    const items = [];
    const item = async (id, title, fix, fn) => {
      try { items.push({ id, title, ...(await fn()), fix }); }
      catch (e) { items.push({ id, title, ok: null, detail: `تعذّرت القراءة: ${String(e?.message || e).slice(0, 200)}`, fix }); }
    };
    const plat = (id) => platforms.find((p) => p.id === id) || null;

    await item("X1", "الطيار على «اقتراح» بسقوف ٩٦",
      "#store/marketing/auto → الإعدادات → الوضع «اقتراح» · السقف الكلي 320 · المطلق 550 · سقف الحملة 180 · رفع الإيقاع 0", async () => {
        const r = await pool.query(`SELECT data FROM ap_settings WHERE id=1`);
        const d = { ...AP_DEFAULTS, ...(parseJson(r.rows[0]?.data, {}) || {}) };
        const abs = Number(d.absoluteMaxTotalBudget);
        const ok = d.mode === "suggest" && Number.isFinite(abs) && abs <= 550;
        return { ok, detail: `mode=${d.mode || "?"} · absoluteMaxTotalBudget=${abs ?? "—"} · maxTotalBudget=${d.maxTotalBudget ?? "—"}` };
      });
    await item("X2", "آخر طلب مدفوع محفوظ معاه المصدر", "شغل هندسي (W0-03) — مفيش خطوة مالك", async () => {
      const r = await pool.query(
        `SELECT order_no, attribution IS NOT NULL AS has_attr FROM shop_orders
          WHERE status = ANY($1::text[]) ORDER BY created_at DESC LIMIT 1`, [PAID_STATUSES]);
      if (!r.rows.length) return { ok: null, detail: "مفيش طلبات مدفوعة لسه" };
      return { ok: Boolean(r.rows[0].has_attr), detail: `آخر طلب ${r.rows[0].order_no}: attribution ${r.rows[0].has_attr ? "موجود" : "فاضي"}` };
    });
    await item("X3", "Purchase الويب بيوصل السيرفر كـwebsite", "شغل هندسي (W0-02) — مفيش خطوة مالك", async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n, max(created_at) AS last FROM ads_events
          WHERE event_name='Purchase' AND request->>'source'='website' AND created_at > NOW() - interval '7 days'`);
      const n = num(r.rows[0]?.n);
      return { ok: n > 0, detail: n ? `${n} حجز website آخر ٧ أيام` : "مفيش Purchase website آخر ٧ أيام" };
    });
    await item("X4", "كوبون OMAR-9X4T مقفول", "#store/discounts/coupons → OMAR-9X4T → إيقاف", async () => {
      const r = await pool.query(`SELECT code, active FROM shop_coupons WHERE upper(code) = ANY($1::text[])`, [EXCLUDED_COUPONS]);
      const active = r.rows.filter((x) => x.active).map((x) => x.code);
      return { ok: active.length === 0, detail: active.length ? `مفعّل: ${active.join(", ")}` : "مقفول/مش موجود" };
    });
    await item("X5", "جوجل: OAuth شغّال", "#store/marketing/auto → دليل الإعداد → جوجل → إعادة الربط", async () => {
      const p = plat("google");
      if (!p) return { ok: false, detail: "المنصة مش متعرّفة" };
      if (!canManage(p)) return { ok: false, detail: "غير مربوطة" };
      const rd = p.lastReadiness?.();
      if (rd && rd.ok === false) return { ok: false, detail: String(rd.reason || rd.code || "blocked").slice(0, 200) };
      return { ok: rd ? true : null, detail: rd ? "جاهزة" : "لسه ماتفحصتش (مفيش حكم مخزّن)" };
    });
    await item("X6", "تيك توك: ttclid بيتسجّل + قراءة الحملات", "اختبار متصفح تيك توك على freshcuts.sa/l/96-tt-box + تأكيد الرصيد", async () => {
      const p = plat("tiktok");
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM funnel_events
          WHERE COALESCE(click_ids->>'ttclid','') <> '' AND created_at > NOW() - interval '14 days'`);
      const n = num(r.rows[0]?.n);
      const manage = p ? canManage(p) : false;
      return { ok: n > 0 && manage, detail: `ttclid آخر ١٤ يوم: ${n} · قراءة الحملات: ${manage ? "متاحة" : "مقفولة"}` };
    });
    await item("X7", "سناب CAPI سليم", "شغل هندسي (P2) — لا صرف على سناب في ٩٦", async () => {
      const r = await pool.query(
        `SELECT count(*) FILTER (WHERE status='failed' AND created_at > NOW() - interval '24 hours')::int AS failed,
                count(*) FILTER (WHERE status='sent' AND created_at > NOW() - interval '24 hours')::int AS sent
           FROM ads_events WHERE platform='snapchat'`);
      const f = num(r.rows[0]?.failed), s = num(r.rows[0]?.sent);
      return { ok: f === 0 && s > 0, detail: `آخر ٢٤س: ${s} مرسل · ${f} فشل` };
    });
    await item("X8", "صور عروض ٩٦ في الكتالوج", "#store/products/offers → كل عرض → رفع الصورة", async () => {
      if (typeof deps.catalogStatus !== "function") return { ok: null, detail: "حالة الكتالوج مش مربوطة هنا" };
      const st = await deps.catalogStatus();
      const missing = (st?.stillMissingImage || []).filter((t) => /96|٩٦/.test(String(t)));
      return { ok: missing.length === 0, detail: missing.length ? `من غير صورة: ${missing.join("، ")}` : "كل صفوف ٩٦ ليها صورة" };
    });
    await item("X9", "قرار PDPL لرفع قوايم الجوال", "قرار مالك §8-1 — وقف syncAudiences لحد الرأي القانوني", async () => {
      const r = await pool.query(`SELECT data FROM ap_settings WHERE id=1`);
      const d = { ...AP_DEFAULTS, ...(parseJson(r.rows[0]?.data, {}) || {}) };
      return { ok: d.syncAudiences === false, detail: `syncAudiences=${d.syncAudiences}` };
    });
    await item("X10", "كروت HungerStation/Ninja بـFIRST", "#store/marketing/links → bag-hungerstation وbag-ninja → إيقاف", async () => {
      const r = await pool.query(`SELECT slug, active FROM cms_links WHERE slug IN ('bag-hungerstation','bag-ninja')`);
      const active = r.rows.filter((x) => x.active).map((x) => x.slug);
      return { ok: active.length === 0, detail: active.length ? `نشطة: ${active.join(", ")}` : "موقوفة" };
    });
    await item("X11", "daypart مابيفشلش", "الهندسة تقرا ap_decisions.result (قراءة)", async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM ap_decisions
          WHERE kind='daypart' AND status='failed' AND created_at > NOW() - interval '24 hours'`);
      const n = num(r.rows[0]?.n);
      return { ok: n === 0, detail: `فشل daypart آخر ٢٤س: ${n}` };
    });
    return { ok: true, ready: items.every((i) => i.ok !== false), items };
  }

  async function gate0924({ asOf } = {}) {
    await ready;
    const day = isDay(asOf) ? asOf : riyadhToday(nowFn());
    const from = GATE_0924.from;
    const to = day < from ? from : day;
    const lines = await loadLines();
    const orders = await loadOrders(from, to);
    const attributed = orders.filter((o) => o.attributed);

    let spend = null;
    const notes = [];
    try {
      const adsApi = late(deps.ads);
      const spendFn = adsApi?.dailySpendData || deps.dailySpendData || adsDailySpend;
      const d = await spendFn(from, to);
      const needed = new Set(["meta", ...lines.filter((l) => ["live", "paused", "killed"].includes(l.status)).map((l) => l.platform)]);
      const down = (d?.unavailable || []).filter((u) => needed.has(u.platform));
      if (down.length) notes.push(`صرف غير مقروء: ${down.map((u) => u.platform).join(", ")} — CPA=null`);
      else {
        spend = r2((d?.days || []).reduce((a, x) => a + (d.platformsRead || []).reduce((s, p) => s + num(x[p]), 0), 0));
      }
    } catch (e) { notes.push(`الصرف: ${String(e?.message || e)}`); }

    let sales7d = null;
    const sFrom = shiftDay(day, -7), sTo = shiftDay(day, -1);
    try {
      const sc = late(deps.scorecard);
      if (sc?.buildLedger) {
        const led = await sc.buildLedger(sFrom, sTo);
        sales7d = led?.totals?.revenue == null ? null : num(led.totals.revenue);
      } else {
        const r = await pool.query(
          `SELECT COALESCE(sum(o.total),0) AS revenue FROM ts_orders o
            WHERE o.calendar_day BETWEEN $1::date AND $2::date AND ${SALES_ONLY}`, [sFrom, sTo]);
        sales7d = num(r.rows[0]?.revenue);
      }
    } catch (e) { notes.push(`مبيعات ٧ أيام: ${String(e?.message || e)}`); }

    const g = buildGate({ attributedOrders: attributed.length, spend, sales7d, signal: signalOf(orders) });
    return { ...g, asOf: day, range: { from, to }, sales7dRange: { from: sFrom, to: sTo }, spend, notes };
  }

  /* ═══ ROUTES ═══ (القسم في PATH_SECTIONS: /api/ads/* = growth) */
  app.get("/api/ads/plan", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      await ready;
      const [lines, creatives, links] = await Promise.all([loadLines(), loadCreatives(), loadLinks()]);
      const today = riyadhToday(nowFn());
      return c.json({
        ok: true, today,
        lines: lines.map((l) => ({ ...l, plannedToday: { base: plannedDaily(l, today, "base"), gate: plannedDaily(l, today, "gate") } })),
        creatives,
        links: links.filter((l) => l.line),
        writesPlatforms: false,
      });
    } catch (e) {
      console.error("[adsplan] plan failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) });
    }
  });

  app.put("/api/ads/plan/lines/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "JSON غير صالح" }, 400); }
    const v = validateLinePatch(b);
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
    try {
      await ready;
      const keys = Object.keys(v.patch);
      const sets = keys.map((k, i) => (k === "budget_plan" ? `${k}=$${i + 2}::jsonb` : `${k}=$${i + 2}`));
      const vals = keys.map((k) => (k === "budget_plan" ? JSON.stringify(v.patch[k]) : v.patch[k]));
      const r = await pool.query(
        `UPDATE ads_plan_lines SET ${sets.join(", ")}, updated_at=NOW(), updated_by=$${keys.length + 2}
          WHERE id=$1 RETURNING *`, [c.req.param("id"), ...vals, actorOf(c)]);
      if (!r.rows.length) return c.json({ ok: false, error: "not_found" }, 404);
      return c.json({ ok: true, line: lineRow(r.rows[0]) });
    } catch (e) {
      console.error("[adsplan] line update failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) });
    }
  });

  app.put("/api/ads/plan/creatives/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "JSON غير صالح" }, 400); }
    const v = validateCreativePatch(b);
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
    try {
      await ready;
      const id = c.req.param("id");
      const cur = creativeRow((await pool.query(`SELECT * FROM ads_plan_creatives WHERE id=$1`, [id])).rows[0]);
      if (!cur) return c.json({ ok: false, error: "not_found" }, 404);
      const next = { ...cur, ...v.patch };
      const guard = guardCopy(next);
      if (GUARDED_STATUSES.includes(next.status) && !guard.ok) {
        return c.json({ ok: false, error: "guard_required", guard }, 409);
      }
      const r = await pool.query(
        `UPDATE ads_plan_creatives SET status=$2, media_ids=$3::text[], copy=$4, hook=$5, guard=$6::jsonb, updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [id, next.status, next.media_ids, next.copy, next.hook, JSON.stringify(guard)]);
      return c.json({ ok: true, creative: creativeRow(r.rows[0]) });
    } catch (e) {
      console.error("[adsplan] creative update failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get("/api/ads/plan/performance", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const by = ["line", "link", "creative"].includes(c.req.query("by")) ? c.req.query("by") : "line";
    try {
      return c.json(await performance({ ...rangeOf(c), by }));
    } catch (e) {
      console.error("[adsplan] performance failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get("/api/ads/plan/readiness", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json(await readiness()); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e) }); }
  });

  app.get("/api/ads/plan/gate-0924", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json(await gate0924({ asOf: c.req.query("asOf") })); }
    catch (e) {
      console.error("[adsplan] gate failed:", e.message);
      return c.json({ ok: false, pass: false, error: String(e.message || e) });
    }
  });

  console.log("[adsplan] routes ready (read-only — no platform writes)");
  return { performance, readiness, gate0924, ensureSchema: () => ensureSchema(pool), ready };
}

export default { register };
