/* ═══════════════════════════════════════════════════════════════════════════
   🎛 التحكم في الإعلانات من اللوحة — «أي حاجة عملتها بالكود عايزها تبقى
   إعدادات في لوحة التحكم» (عمر، ليلة ٢٣/٩ اللي المشاوي خلصت فيها)

   الليلة دي اتعمل كله بالإيد على السيرفر: تسعة حملات اتقفلت واتفتحت، تمن
   إعلانات ميتا اتوقفوا واحد واحد، وأربع مؤقتات systemd اتكتبوا عشان يقفلوا
   الإعلانات في ميعاد ويرجّعوها قبل الفتح. الملف ده بيحوّل الحتة الإعلانية من
   ده لإعدادات — من غير SSH ولا مهندس.

   اللي جوه:
     ١) الجدولة: قواعد «اقفل الساعة كذا» / «افتح الساعة كذا» بأيام الأسبوع،
        وعامل بيدور كل دقايق معدودة بدل مؤقتات السيرفر.
     ٢) السقف: أقصى مجموع ميزانيات يومية عبر المنصات الأربعة. الجدولة
        مابتعدّيهوش أبداً — بتشغّل اللي يوسّع تحت السقف وتسيب الباقي موقوف
        وتكتب السبب.
     ٣) الدفتر (ads_ctl_book): اللي إحنا وقّفناه بيتسجّل، فالرجوع بيرجّع
        اللي إحنا قفلناه بس — مش أي حاجة موقوفة من قبلنا بإيد المالك.
     ٤) السجل (ads_ctl_log): كل أمر راح لمنصة، مين عمله، ورد المنصة نفسه.

   القواعد اللي مابتتكسرش (دي بتصرف فلوس حقيقية):
     • مابنفتحش إعلان والخدمة موقوفة أو المطعم قافل — بنقرا /api/service
       وحالة المواعيد قبل أي «شغّل».
     • القاعدة بتشتغل مرة واحدة في اليوم التجاري (fired[ruleId] = اليوم) —
       فدورة العامل كل ٥ دقايق مابتعملش نفس الأمر مرتين.
     • لو السيرفر كان نايم ساعة، القاعدة بتلحق نفسها جوّه مهلة graceMinutes
        بس — قاعدة فاتت من إمبارح مابتتنفّذش النهارده.
     • كل أمر بيتقري من المنصة تاني بعد الكتابة (الشاشة بتعيد التحميل) —
       مافيش نسخة متفائلة محلية.

   اليوم التجاري بيلف ٤ الفجر (نفس قاعدة analytics.js/autopilot.js) — عشان
   «اقفل ٢:٠٠ بالليل» تبقى آخر النهارده مش أول بكرة.

   ملاحظة عن نافذة الطيار (autopilot daypart): دي حاجة تانية وبتشتغل من
   مواعيد المطعم، ودلوقتي **مقفولة** (daypart.enabled=false) — عشان كده عمر
   احتاج مؤقتات systemd أصلاً. الاتنين مابيتخانقوش: كل واحد بيرجّع اللي هو
   وقّفه من دفتره هو.
═══════════════════════════════════════════════════════════════════════════ */

import {
  PLATFORMS, byId, canManage, missingOf, writeAllowed,
  MAX_DAILY_BUDGET, DEFAULT_CURRENCY,
  applyEntityState, applyEntityBudget, entityWriteSupport,
} from "./ads.js";

const TZ = "Asia/Riyadh";
const BIZ_DAY_START_HOUR = 4;          // اليوم التجاري بيلف ٤ الفجر
export const TICK_MINUTES = Math.max(1, Number(process.env.ADS_CTL_MINUTES || 5));

const DOW_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
export const ACTION_AR = { off: "اقفل الإعلانات", on: "شغّل الإعلانات" };

/* ═══ ساعة الرياض واليوم التجاري — دوال صافية، بتتجرّب من غير سيرفر ═══ */

export function riyadhClock(at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(at instanceof Date ? at : new Date(at)).map((x) => [x.type, x.value]));
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

const shiftIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** اليوم التجاري (بيلف ٤ الفجر بتوقيت الرياض). */
export function bizDayOf(at = new Date()) {
  const c = riyadhClock(at);
  return c.hour >= BIZ_DAY_START_HOUR ? c.day : shiftIso(c.day, -1);
}

/** يوم الأسبوع بتاع اليوم التجاري (٠ = الأحد). */
export const bizDowOf = (at = new Date()) => new Date(`${bizDayOf(at)}T00:00:00Z`).getUTCDay();

/** "HH:MM" → دقيقة من بداية اليوم (٠..١٤٣٩). null لو الصيغة غلط. */
export function hhmmToMin(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mm >= 0 && mm <= 59)) return null;
  return h * 60 + mm;
}
export const minToHhmm = (n) =>
  `${String(Math.floor(((n % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((n % 1440) + 1440) % 1440 % 60).padStart(2, "0")}`;

/** دقيقة على محور اليوم التجاري: ٠ = ٤ الفجر، ١٤٣٩ = ٣:٥٩ فجر تاني يوم.
    كده «٠٢:٠٠» بتبقى ١٣٢٠ (آخر النهارده) مش ١٢٠ (أول النهارده) — وده بالظبط
    اللي بيمنع «اقفل الساعة اتنين بالليل» إنها تتنفّذ الصبح. */
export const bizMinuteOf = (dayMin) => (((dayMin - BIZ_DAY_START_HOUR * 60) % 1440) + 1440) % 1440;

/* ═══ الإعدادات ═══════════════════════════════════════════════════════ */

export const CTL_DEFAULTS = Object.freeze({
  enabled: false,             // الجدولة شغّالة؟ (الافتراضي: مقفولة)
  dailyCeiling: 1500,         // أقصى مجموع ميزانيات يومية عبر كل المنصات (ر.س)
  confirmAbove: 200,          // رفع ميزانية فوق كده محتاج تأكيد من المالك
  respectService: true,       // ماتشغّلش والتوصيل/الاستلام موقوف
  respectHours: true,         // ماتشغّلش والمطعم قافل
  graceMinutes: 90,           // مهلة اللحاق لو السيرفر كان نايم
  rules: [],
  fired: {},                  // ruleId → اليوم التجاري اللي اتنفّذت فيه
  lastTick: null,
});

const clampN = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const PLATFORM_IDS = new Set(PLATFORMS.map((p) => p.id));
let _ruleSeq = 0;
const newRuleId = () => `r${Date.now().toString(36)}${(_ruleSeq = (_ruleSeq + 1) % 1296).toString(36).padStart(2, "0")}`;

/** قاعدة واحدة، متحقَّق منها. بترجّع null لو الميعاد مش مفهوم — قاعدة
    بميعاد غلط مابتتخزّنش، لأنها هتفضل ساكتة والمالك فاكرها شغّالة. */
export function normRule(raw = {}) {
  const at = hhmmToMin(raw.at);
  if (at == null) return null;
  const action = raw.action === "on" ? "on" : raw.action === "off" ? "off" : null;
  if (!action) return null;
  let days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  if (!days.length) days = [0, 1, 2, 3, 4, 5, 6];          // فاضي = كل يوم
  const platforms = Array.isArray(raw.platforms)
    ? [...new Set(raw.platforms.map(String).filter((p) => PLATFORM_IDS.has(p)))]
    : [];
  return {
    id: String(raw.id || "").trim() || newRuleId(),
    enabled: raw.enabled !== false,
    action,
    at: minToHhmm(at),
    days,
    platforms,                                             // فاضي = كل المنصات
    note: String(raw.note || "").slice(0, 160),
  };
}

export function ctlCfg(settings) {
  const raw = ((settings || {}).adsControl) || {};
  const rules = (Array.isArray(raw.rules) ? raw.rules : []).map(normRule).filter(Boolean).slice(0, 40);
  const ids = new Set(rules.map((r) => r.id));
  const fired = {};
  for (const [k, v] of Object.entries(raw.fired || {})) if (ids.has(k)) fired[k] = String(v);
  return {
    enabled: raw.enabled === true,
    dailyCeiling: clampN(raw.dailyCeiling, 0, MAX_DAILY_BUDGET * 10, CTL_DEFAULTS.dailyCeiling),
    confirmAbove: clampN(raw.confirmAbove, 1, MAX_DAILY_BUDGET, CTL_DEFAULTS.confirmAbove),
    respectService: raw.respectService !== false,
    respectHours: raw.respectHours !== false,
    graceMinutes: Math.round(clampN(raw.graceMinutes, 5, 720, CTL_DEFAULTS.graceMinutes)),
    rules,
    fired,
    lastTick: raw.lastTick || null,
  };
}

/** وصف عربي للقاعدة — نفس النص في اللوحة وفي السجل. */
export function ruleLabel(r) {
  const days = r.days.length === 7 ? "كل يوم" : r.days.map((d) => DOW_AR[d]).join("، ");
  const where = r.platforms.length
    ? r.platforms.map((p) => byId(p)?.label || p).join("، ")
    : "كل المنصات";
  return `${ACTION_AR[r.action]} الساعة ${r.at} · ${days} · ${where}`;
}

/* ═══ القرار: مين القواعد اللي ميعادها جه؟ (صافية) ═══════════════════════ */

/**
 * @param {{cfg:object, nowBizMin:number, bizDay:string, bizDow:number}} x
 * @returns {{due:Array, skipped:Array}}
 *  due     = قواعد لازم تتنفّذ دلوقتي
 *  skipped = اللي ميعادها جه وماتنفّذتش، ومعاها السبب (عشان الشاشة تقوله)
 */
export function dueRules({ cfg, nowBizMin, bizDay, bizDow }) {
  const due = [], skipped = [];
  if (!cfg.enabled) return { due, skipped: cfg.rules.map((r) => ({ rule: r, why: "الجدولة مقفولة" })) };
  for (const r of cfg.rules) {
    if (!r.enabled) { skipped.push({ rule: r, why: "القاعدة مقفولة" }); continue; }
    if (!r.days.includes(bizDow)) { skipped.push({ rule: r, why: `مش من أيام ${DOW_AR[bizDow]}` }); continue; }
    const rm = bizMinuteOf(hhmmToMin(r.at));
    if (nowBizMin < rm) { skipped.push({ rule: r, why: `لسه بدري — فاضل ${rm - nowBizMin} دقيقة` }); continue; }
    if (nowBizMin - rm > cfg.graceMinutes) {
      skipped.push({ rule: r, why: `الميعاد عدّى بأكتر من ${cfg.graceMinutes} دقيقة — مش هننفّذها متأخرة` });
      continue;
    }
    if (cfg.fired[r.id] === bizDay) { skipped.push({ rule: r, why: "اتنفّذت النهارده خلاص" }); continue; }
    due.push(r);
  }
  // الأقدم الأول: لو «اقفل ٠٢:٠٠» و«افتح ١١:٠٠» اتجمّعوا بعد انقطاع، الترتيب
  // الزمني بيخلّي النتيجة النهائية صح بدل ما تبقى على مزاج ترتيب القايمة.
  due.sort((a, b) => bizMinuteOf(hhmmToMin(a.at)) - bizMinuteOf(hhmmToMin(b.at)));
  return { due, skipped };
}

/* ═══ السقف اليومي ═══════════════════════════════════════════════════════ */

/* ⚠️ عملة الحساب مش ر.س في كل المنصات. حساب **سناب بيفوتر بالدولار** —
   mkhub.js بيضرب صرف سناب في SNAP_FX_SAR (٣٫٧٥) عشان يقارنه بالباقي، لكن
   ads.js بيتعامل مع كل الأرقام على إنها ر.س (DEFAULT_CURRENCY=SAR).
   يعني ميزانية سناب اللي بترجع «٢٠٠» هي في الحقيقة ٧٥٠ ر.س. لو السقف حسبها
   ٢٠٠ يبقى السقف بيكدب بـ٣٫٧٥ ضعف على المنصة دي. بنحوّلها هنا عشان السقف
   يقيس نفس الوحدة لكل المنصات. */
export const PLATFORM_FX = Object.freeze({ snapchat: Number(process.env.SNAP_FX_SAR || 3.75) });
export const fxOf = (platform) => {
  const f = PLATFORM_FX[String(platform || "").toLowerCase()];
  return Number.isFinite(f) && f > 0 ? f : 1;
};

/** ميزانية الحملة اليومية بالريال: لو الحملة CBO في ميتا الميزانية على
    المجموعات، ولو المنصة بتفوتر بعملة تانية بنحوّلها. */
export const budgetOf = (cam, byCampaign = {}) => {
  const raw = (cam.dailyBudget != null ? Number(cam.dailyBudget) : Number(byCampaign[String(cam.id)] || 0)) || 0;
  return Math.round(raw * fxOf(cam.platform) * 100) / 100;
};

/**
 * السقف: مجموع الميزانيات اليومية للحملات الشغّالة + اللي هنشغّلها مايعدّيش
 * `ceiling`. بنرتّب اللي هنشغّله من الأرخص للأغلى فبنشغّل أكبر عدد ممكن تحت
 * السقف بدل ما نرفض الكل.
 * @returns {{allowed:Array, blocked:Array, committed:number, ceiling:number, after:number}}
 */
export function applyCeiling({ candidates = [], activeBudget = 0, ceiling }) {
  const cap = Number(ceiling);
  const out = { allowed: [], blocked: [], committed: Number(activeBudget) || 0, ceiling: cap, after: Number(activeBudget) || 0 };
  if (!Number.isFinite(cap) || cap <= 0) { out.allowed = [...candidates]; out.ceiling = null; return out; }
  const sorted = [...candidates].sort((a, b) => (a.budget || 0) - (b.budget || 0));
  for (const x of sorted) {
    const b = Number(x.budget) || 0;
    if (out.after + b <= cap) { out.allowed.push(x); out.after += b; }
    else {
      out.blocked.push({
        ...x,
        why: `السقف اليومي ${cap} ر.س — الشغّال دلوقتي ${Math.round(out.after)} ر.س، و«${x.name}» بـ${b} ر.س هيعدّيه.`,
      });
    }
  }
  return out;
}

/**
 * حكم على تغيير ميزانية واحدة قبل ما تروح للمنصة.
 * بيرجّع `needsConfirm` بدل ما يرفض — الشاشة بتسأل المالك وبتبعت confirm:true.
 */
export function budgetVerdict({ current, next, othersBudget = 0, cfg, confirmed = false }) {
  const cur = Number(current) || 0;
  const amt = Number(next);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, error: "الميزانية لازم تكون رقم أكبر من صفر." };
  }
  if (amt > MAX_DAILY_BUDGET) {
    return { ok: false, error: `${amt} ر.س أعلى من السقف الصلب للمنصة (${MAX_DAILY_BUDGET} ر.س). ده حاجز في السيرفر — مش بيتغيّر من اللوحة.` };
  }
  const after = (Number(othersBudget) || 0) + amt;
  if (cfg.dailyCeiling > 0 && after > cfg.dailyCeiling) {
    return {
      ok: false,
      error: `السقف اليومي ${cfg.dailyCeiling} ر.س. باقي الحملات الشغّالة ${Math.round(othersBudget)} ر.س، فـ${amt} ر.س هيوصّل المجموع لـ${Math.round(after)} ر.س. ارفع السقف من فوق لو ده مقصود.`,
      ceiling: { ceiling: cfg.dailyCeiling, after: Math.round(after) },
    };
  }
  const raise = amt - cur;
  if (raise > 0 && amt > cfg.confirmAbove && !confirmed) {
    return {
      ok: false, needsConfirm: true,
      error: `رفع الميزانية من ${cur} لـ${amt} ر.س فوق حد التأكيد (${cfg.confirmAbove} ر.س). أكّد عشان نبعتها.`,
    };
  }
  return { ok: true, after: Math.round(after), raise };
}

/* ═══ تنفيذ قاعدة: مين يتقفل/يتفتح (صافية) ═══════════════════════════════ */

/**
 * @param {{rule:object, campaigns:Array, book:Map, byCampaign:object, cfg:object}} x
 *   campaigns = لقطة حيّة { platform, id, name, status, dailyBudget }
 *   book      = Map "platform:id" → صف مفتوح في ads_ctl_book (اللي إحنا وقّفناه)
 * @returns {{action:string, targets:Array, skipped:Array, ceiling:object|null}}
 *
 * الـidempotency هنا: حملة موقوفة خلاص مابتتحطّش في targets لقاعدة «اقفل»،
 * وحملة شغّالة خلاص مابتتحطّش لقاعدة «افتح». فلو الدورة اتكررت، القايمة
 * بتطلع فاضية ومفيش أي نداء بيروح للمنصة.
 */
export function planRule({ rule, campaigns = [], book = new Map(), byCampaign = {}, cfg = CTL_DEFAULTS, activeBudget = null }) {
  const onlyP = rule.platforms.length ? new Set(rule.platforms) : null;
  const mine = campaigns.filter((c) => !onlyP || onlyP.has(c.platform));
  const skipped = [];

  if (rule.action === "off") {
    const targets = [];
    for (const c of mine) {
      if (c.status !== "ACTIVE") { skipped.push({ id: c.id, platform: c.platform, name: c.name, why: "موقوفة خلاص" }); continue; }
      targets.push({ platform: c.platform, id: String(c.id), name: c.name, budget: budgetOf(c, byCampaign) });
    }
    return { action: "off", targets, skipped, ceiling: null };
  }

  // «افتح» = رجّع اللي إحنا وقّفناه بس. حملة المالك وقّفها بإيده مابنلمسهاش —
  // ده الفرق اللي خلّى سكريبت الرجوع بتاع الليلة دي خطر.
  const candidates = [];
  for (const c of mine) {
    const key = `${c.platform}:${c.id}`;
    if (c.status === "ACTIVE") { skipped.push({ id: c.id, platform: c.platform, name: c.name, why: "شغّالة خلاص" }); continue; }
    if (!book.has(key)) { skipped.push({ id: c.id, platform: c.platform, name: c.name, why: "مش إحنا اللي وقّفناها — سايبينها زي ما هي" }); continue; }
    candidates.push({ platform: c.platform, id: String(c.id), name: c.name, budget: budgetOf(c, byCampaign) });
  }
  const live = activeBudget != null ? activeBudget
    : mine.reduce((a, c) => a + (c.status === "ACTIVE" ? budgetOf(c, byCampaign) : 0), 0);
  const ceiling = applyCeiling({ candidates, activeBudget: live, ceiling: cfg.dailyCeiling });
  for (const b of ceiling.blocked) skipped.push({ id: b.id, platform: b.platform, name: b.name, why: b.why });
  return { action: "on", targets: ceiling.allowed, skipped, ceiling };
}

/** الحارس قبل أي «شغّل»: مانصرفش والمطبخ قافل أو الخدمة موقوفة. */
export function openGate({ rule, cfg, service, windowOpen }) {
  if (rule.action !== "on") return { ok: true };
  if (cfg.respectService && service && service.allPaused) {
    return { ok: false, why: "الخدمة موقوفة (التوصيل والاستلام) — مانشغّلش إعلانات على مطعم مش بيستقبل طلبات." };
  }
  if (cfg.respectHours && windowOpen === false) {
    return { ok: false, why: "المطعم قافل دلوقتي حسب المواعيد — الإعلانات هتفضل موقوفة لحد الفتح." };
  }
  return { ok: true };
}

/* ═══ الجداول ═══════════════════════════════════════════════════════════ */

export const CTL_DDL = `
  CREATE TABLE IF NOT EXISTS ads_ctl_log (
    id           BIGSERIAL PRIMARY KEY,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source       TEXT NOT NULL,
    actor        TEXT,
    rule_id      TEXT,
    platform     TEXT,
    level        TEXT,
    object_id    TEXT,
    object_name  TEXT,
    action       TEXT,
    from_value   TEXT,
    to_value     TEXT,
    ok           BOOLEAN,
    error        TEXT,
    detail       JSONB
  );
  CREATE INDEX IF NOT EXISTS ads_ctl_log_at_idx ON ads_ctl_log(at DESC);
  CREATE TABLE IF NOT EXISTS ads_ctl_book (
    id           BIGSERIAL PRIMARY KEY,
    paused_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    restored_at  TIMESTAMPTZ,
    source       TEXT,
    rule_id      TEXT,
    biz_day      TEXT,
    platform     TEXT NOT NULL,
    level        TEXT NOT NULL DEFAULT 'campaign',
    object_id    TEXT NOT NULL,
    object_name  TEXT,
    prev_budget  NUMERIC
  );
  CREATE INDEX IF NOT EXISTS ads_ctl_book_open_idx ON ads_ctl_book(platform, object_id) WHERE restored_at IS NULL;
`;

/* ═══ التسجيل ═══════════════════════════════════════════════════════════ */

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const whoami = deps.whoami || (async () => null);
  const serviceState = deps.serviceState || null;      // service.js — نفس المصدر
  const adsWindow = deps.adsWindow || null;            // autopilot.js adsWindow

  let ready = pool.query(CTL_DDL)
    .then(() => console.log("[ads-ctl] tables ready"))
    .catch((e) => { console.error("[ads-ctl] init failed:", e.message); });

  /* ── مين بيعمل ده؟ السجل من غير اسم مش سجل ──────────────────────────── */
  async function actorOf(c) {
    try {
      const u = await whoami(c);
      if (u && (u.name || u.role)) return `${u.name || "—"} (${u.role || "—"})`;
    } catch { /* مفتاح الأدمن مش جلسة فريق */ }
    return "المالك (مفتاح الأدمن)";
  }

  async function logRow(row) {
    await ready;
    return pool.query(
      `INSERT INTO ads_ctl_log(source, actor, rule_id, platform, level, object_id, object_name,
                               action, from_value, to_value, ok, error, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [row.source, row.actor || null, row.ruleId || null, row.platform || null, row.level || "campaign",
        row.objectId || null, row.objectName || null, row.action || null,
        row.from == null ? null : String(row.from), row.to == null ? null : String(row.to),
        typeof row.ok === "boolean" ? row.ok : null,
        row.error ? String(row.error).slice(0, 900) : null, JSON.stringify(row.detail || {})]
    ).catch((e) => { console.error("[ads-ctl] log failed:", e.message); });
  }

  /* ونفس السطر بيتكتب كمان في سجل اللوحة (cms_audit) عشان «مين غيّر إيه»
     يفضل في مكان واحد للوحة كلها، مش سجل لكل شاشة. */
  async function cmsAudit(actor, note) {
    await pool.query(
      `INSERT INTO cms_audit(actor_id, actor_name, role, method, path, section, note)
       VALUES (NULL,$1,NULL,'POST','/api/ads/control','growth',$2)`,
      [String(actor || "").slice(0, 120), String(note || "").slice(0, 500)]
    ).catch(() => { /* السجل مايوقعش الأمر */ });
  }

  /* ── الدفتر ─────────────────────────────────────────────────────────── */
  async function openBook() {
    await ready;
    const r = await pool.query(
      `SELECT platform, level, object_id, object_name, prev_budget, rule_id, biz_day, paused_at
         FROM ads_ctl_book WHERE restored_at IS NULL`);
    return new Map(r.rows.map((x) => [`${x.platform}:${x.object_id}`, x]));
  }
  const bookPause = (rows, { source, ruleId, bizDay }) => {
    if (!rows.length) return Promise.resolve();
    const vals = rows.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`).join(",");
    const args = rows.flatMap((x) => [source, ruleId || null, bizDay, x.platform, x.level || "campaign", String(x.id), x.name || null]);
    return pool.query(
      `INSERT INTO ads_ctl_book(source, rule_id, biz_day, platform, level, object_id, object_name) VALUES ${vals}`,
      args).catch((e) => console.error("[ads-ctl] book failed:", e.message));
  };
  const bookRestore = (platform, id) => pool.query(
    `UPDATE ads_ctl_book SET restored_at=NOW() WHERE restored_at IS NULL AND platform=$1 AND object_id=$2`,
    [platform, String(id)]).catch(() => {});

  /* ── الإعدادات ──────────────────────────────────────────────────────── */
  const loadCfg = async () => ctlCfg(await getSettingsData());
  const saveCfg = async (next) => {
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{adsControl}', $1::jsonb, true), updated_at = NOW() WHERE id=1`,
      [jb(next)]);
    return next;
  };

  /* ── لقطة حيّة من المنصات ───────────────────────────────────────────── */
  async function snapshot({ platforms = null, stats = false, from = null, to = null } = {}) {
    const targets = PLATFORMS.filter((p) => (!platforms || platforms.includes(p.id)));
    const campaigns = [], reasons = {};
    for (const p of targets) {
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join("، ") || "صلاحيات"}`; continue; }
      try {
        const r = await p.campaigns();
        if (!r.ok) { reasons[p.id] = r.reason; continue; }
        /* أرقام آخر ٧ أيام جنب الصف — الصرف من غير نتيجة رقم مالوش معنى،
           والمالك بيقرر «أقفل ولا لأ» من تكلفة النتيجة مش من الاسم. القراية
           دي إضافة: لو وقعت الصف بيرجع بأرقام null مش أصفار. */
        let byId2 = {};
        if (stats) {
          try {
            const ins = await p.insights({ from, to });
            if (ins.ok) byId2 = Object.fromEntries(ins.rows.map((x) => [String(x.campaignId), x]));
          } catch { /* الأرقام إضافة، مش شرط */ }
        }
        for (const cam of r.campaigns) {
          const s = byId2[String(cam.id)];
          campaigns.push({
            ...cam, platform: p.id,
            recent: s
              ? { from, to, spend: s.spend, impressions: s.impressions, clicks: s.clicks, results: s.results, resultValue: s.resultValue }
              : (stats ? { from, to, spend: null, impressions: null, clicks: null, results: null, resultValue: null } : null),
          });
        }
      } catch (e) { reasons[p.id] = String(e.message || e); }
    }
    // ميزانيات مجموعات ميتا: حملة CBO ميزانيتها null على مستوى الحملة، واللي
    // بيحسب السقف لازم يشوف الرقم الحقيقي مش صفر.
    let byCampaign = {};
    const meta = byId("meta");
    if (meta && canManage(meta) && (!platforms || platforms.includes("meta"))) {
      try { const a = await meta.adsets(); if (a.ok) byCampaign = a.byCampaign || {}; } catch { /* إضافة */ }
    }
    const activeBudget = campaigns.reduce((s, c) => s + (c.status === "ACTIVE" ? budgetOf(c, byCampaign) : 0), 0);
    return { campaigns, reasons, byCampaign, activeBudget: Math.round(activeBudget * 100) / 100 };
  }

  /* ── حالة المطعم: الخدمة + نافذة المواعيد ───────────────────────────── */
  async function storeGate() {
    let service = null, windowOpen = null, windowWhy = null;
    try {
      if (serviceState) {
        const s = await getSettingsData();
        service = serviceState(s);
        if (adsWindow) {
          const w = adsWindow(new Date(), { storeHours: (s || {}).hours });
          windowOpen = w.open; windowWhy = w.why;
        }
      }
    } catch (e) { windowWhy = `مقدرناش نقرا حالة المطعم: ${e.message || e}`; }
    return { service, windowOpen, windowWhy };
  }

  /* ── تنفيذ قاعدة واحدة ──────────────────────────────────────────────── */
  async function runRule(rule, { source = "schedule", actor = "الجدولة", dry = false, cfg, snap, gate, bizDay }) {
    const book = await openBook();
    const plan = planRule({ rule, campaigns: snap.campaigns, book, byCampaign: snap.byCampaign, cfg, activeBudget: snap.activeBudget });
    const g = openGate({ rule, cfg, service: gate.service, windowOpen: gate.windowOpen });
    if (!g.ok) {
      if (!dry) await logRow({ source, actor, ruleId: rule.id, action: `rule_${rule.action}`, ok: false, error: g.why, detail: { rule: ruleLabel(rule), blocked: plan.targets.length } });
      return { rule: rule.id, label: ruleLabel(rule), blocked: g.why, applied: [], failed: [], skipped: plan.skipped, plan };
    }
    if (dry) return { rule: rule.id, label: ruleLabel(rule), dry: true, plan, applied: [], failed: [], skipped: plan.skipped };

    /* قاعدة اتقيّمت وماعملتش حاجة **لسبب**: السقف منعها، أو كل حاجة في حالتها
       خلاص. لو ماكتبناش السطر ده، المالك بيبص على السجل ويلاقيه فاضي ويفتكر
       إن الجدولة مابتشتغلش. الفرق بين «مافيش حاجة تتعمل» و«ماشتغلتش» مهم. */
    if (!plan.targets.length) {
      const ceilBlocked = plan.skipped.filter((s) => /السقف اليومي/.test(s.why || ""));
      await logRow({
        source, actor, ruleId: rule.id, action: `rule_${rule.action}`, ok: true,
        error: ceilBlocked.length
          ? `السقف منع ${ceilBlocked.length} حملة: ${ceilBlocked.map((s) => s.name).join("، ").slice(0, 300)}`
          : null,
        detail: { rule: ruleLabel(rule), targets: 0, skipped: plan.skipped.length, reason: ceilBlocked.length ? "ceiling" : "already_in_state" },
      });
      return { rule: rule.id, label: ruleLabel(rule), applied: [], failed: [], skipped: plan.skipped, ceiling: plan.ceiling };
    }

    const applied = [], failed = [];
    const state = rule.action === "off" ? "PAUSED" : "ACTIVE";
    for (const t of plan.targets) {
      const r = await applyEntityState({ platform: t.platform, level: "campaign", id: t.id, state });
      await logRow({
        source, actor, ruleId: rule.id, platform: t.platform, level: "campaign", objectId: t.id,
        objectName: t.name, action: rule.action === "off" ? "state_off" : "state_on",
        from: rule.action === "off" ? "ACTIVE" : "PAUSED", to: state,
        ok: r.ok, error: r.ok ? null : r.error, detail: { budget: t.budget, applied: r.applied !== false },
      });
      if (r.ok) {
        applied.push(t);
        if (rule.action === "on") await bookRestore(t.platform, t.id);
      } else failed.push({ ...t, error: r.error });
    }
    if (rule.action === "off" && applied.length) {
      await bookPause(applied.map((x) => ({ ...x, level: "campaign" })), { source, ruleId: rule.id, bizDay });
    }
    await cmsAudit(actor, `${ruleLabel(rule)} — نفّذت على ${applied.length} حملة${failed.length ? ` وفشلت ${failed.length}` : ""}`);
    return { rule: rule.id, label: ruleLabel(rule), applied, failed, skipped: plan.skipped, ceiling: plan.ceiling };
  }

  /* ── دورة العامل ────────────────────────────────────────────────────── */
  let running = false;
  async function tick({ trigger = "cron", force = false, onlyRule = null, dry = false, actor = "الجدولة", source = "schedule" } = {}) {
    if (running) return { ok: false, skipped: "الدورة شغّالة دلوقتي" };
    running = true;
    try {
      await ready;
      const cfg = await loadCfg();
      const now = new Date();
      const c = riyadhClock(now);
      const bizDay = bizDayOf(now), bizDow = bizDowOf(now);
      const nowBizMin = bizMinuteOf(c.hour * 60 + c.minute);

      let due, skipped;
      if (onlyRule) {
        const r = cfg.rules.find((x) => x.id === onlyRule);
        if (!r) return { ok: false, error: "القاعدة مش موجودة" };
        due = [r]; skipped = [];
      } else if (force) {
        due = cfg.rules.filter((r) => r.enabled); skipped = [];
      } else {
        ({ due, skipped } = dueRules({ cfg, nowBizMin, bizDay, bizDow }));
      }
      if (!due.length) return { ok: true, trigger, bizDay, clock: `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`, ran: [], skipped };

      if (!writeAllowed()) {
        return { ok: false, guard: "ADS_ALLOW_WRITE مش مفعّل على السيرفر — مفيش أي أمر بيروح للمنصات.", due: due.map(ruleLabel), skipped };
      }

      const platforms = [...new Set(due.flatMap((r) => r.platforms))];
      const snap = await snapshot({ platforms: platforms.length ? platforms : null });
      const gate = await storeGate();

      const ran = [];
      for (const rule of due) {
        const res = await runRule(rule, { source, actor, dry, cfg, snap, gate, bizDay });
        ran.push(res);
        // علامة «اتنفّذت» بتتكتب حتى لو الحارس منعها: القاعدة اتقيّمت النهارده
        // خلاص، والدورة الجاية مالهاش لازمة تعيد نفس التقييم كل ٥ دقايق.
        if (!dry) cfg.fired[rule.id] = bizDay;
        // اللقطة بقت قديمة بعد أول قاعدة — بنحدّث الحالة محلياً عشان القاعدة
        // اللي بعدها ماتعيدش نفس الأمر (idempotency جوّه نفس الدورة).
        for (const t of (res.applied || [])) {
          const hit = snap.campaigns.find((x) => x.platform === t.platform && String(x.id) === String(t.id));
          if (hit) hit.status = rule.action === "off" ? "PAUSED" : "ACTIVE";
        }
        snap.activeBudget = snap.campaigns.reduce((s, x) => s + (x.status === "ACTIVE" ? budgetOf(x, snap.byCampaign) : 0), 0);
      }
      if (!dry) {
        cfg.lastTick = { at: now.toISOString(), trigger, bizDay, ran: ran.length };
        await saveCfg(cfg);
      }
      return { ok: true, trigger, bizDay, ran, skipped, gate: { windowOpen: gate.windowOpen, service: gate.service?.allPaused ? "موقوفة" : "شغّالة" } };
    } catch (e) {
      console.error("[ads-ctl] tick error:", e.message);
      return { ok: false, error: String(e.message || e) };
    } finally { running = false; }
  }

  /* ═══ المسارات — requireAdmin بيتنادى **جوه** المعالِج (مش وسيط Hono):
       كوسيط بيرجّع «Context is not finalized» ٥٠٠ للتوكن الصح. ══════════ */

  /* الحالة الكاملة للشاشة — من غير قراية المنصات (سريعة). */
  app.get("/api/ads/control/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await loadCfg();
    const gate = await storeGate();
    const now = new Date();
    const cl = riyadhClock(now);
    const nowBizMin = bizMinuteOf(cl.hour * 60 + cl.minute);
    const bizDay = bizDayOf(now), bizDow = bizDowOf(now);
    const { due, skipped } = dueRules({ cfg, nowBizMin, bizDay, bizDow });
    const book = await openBook();
    return c.json({
      ok: true,
      cfg: { ...cfg, rules: cfg.rules.map((r) => ({ ...r, label: ruleLabel(r), firedToday: cfg.fired[r.id] === bizDay })) },
      defaults: CTL_DEFAULTS,
      writeEnabled: writeAllowed(),
      maxDailyBudget: MAX_DAILY_BUDGET,
      currency: DEFAULT_CURRENCY,
      tickMinutes: TICK_MINUTES,
      now: { bizDay, bizDow, dowLabel: DOW_AR[bizDow], clock: `${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")}`, tz: TZ },
      store: {
        windowOpen: gate.windowOpen, windowWhy: gate.windowWhy,
        servicePaused: gate.service ? gate.service.allPaused : null,
        serviceNote: gate.service ? gate.service.note : "",
      },
      due: due.map((r) => ({ id: r.id, label: ruleLabel(r) })),
      skipped: skipped.map((s) => ({ id: s.rule.id, label: ruleLabel(s.rule), why: s.why })),
      pausedByUs: [...book.values()].map((b) => ({
        platform: b.platform, id: b.object_id, name: b.object_name, at: b.paused_at, ruleId: b.rule_id, source: b.source,
      })),
      platforms: PLATFORMS.map((p) => ({
        id: p.id, label: p.label, canManage: canManage(p),
        missing: missingOf(p.manageEnv),
        entityWrite: entityWriteSupport(p.id),
      })),
    });
  });

  app.put("/api/ads/control/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const before = await loadCfg();
    const rules = Array.isArray(b.rules) ? b.rules : before.rules;
    const bad = (Array.isArray(b.rules) ? b.rules : []).filter((r) => !normRule(r));
    if (bad.length) {
      return c.json({ ok: false, error: `فيه ${bad.length} قاعدة ميعادها أو نوعها غلط — الميعاد لازم يكون HH:MM والنوع «اقفل» أو «شغّل».` }, 400);
    }
    const next = ctlCfg({
      adsControl: {
        ...before,
        ...(b.enabled === undefined ? {} : { enabled: b.enabled === true }),
        ...(b.dailyCeiling === undefined ? {} : { dailyCeiling: b.dailyCeiling }),
        ...(b.confirmAbove === undefined ? {} : { confirmAbove: b.confirmAbove }),
        ...(b.respectService === undefined ? {} : { respectService: b.respectService }),
        ...(b.respectHours === undefined ? {} : { respectHours: b.respectHours }),
        ...(b.graceMinutes === undefined ? {} : { graceMinutes: b.graceMinutes }),
        rules,
        fired: before.fired,
      },
    });
    await saveCfg(next);
    const actor = await actorOf(c);
    const changed = [];
    if (before.enabled !== next.enabled) changed.push(next.enabled ? "الجدولة اتفتحت" : "الجدولة اتقفلت");
    if (before.dailyCeiling !== next.dailyCeiling) changed.push(`السقف اليومي ${before.dailyCeiling} ← ${next.dailyCeiling} ر.س`);
    if (before.confirmAbove !== next.confirmAbove) changed.push(`حد التأكيد ${before.confirmAbove} ← ${next.confirmAbove} ر.س`);
    if (before.rules.length !== next.rules.length) changed.push(`القواعد ${before.rules.length} ← ${next.rules.length}`);
    await logRow({ source: "manual", actor, action: "settings", ok: true, detail: { changed, rules: next.rules.map(ruleLabel) } });
    await cmsAudit(actor, `إعدادات التحكم في الإعلانات: ${changed.join("، ") || "تعديل قواعد"}`);
    return c.json({ ok: true, cfg: { ...next, rules: next.rules.map((r) => ({ ...r, label: ruleLabel(r) })) }, changed });
  });

  /* لقطة حيّة: الحملات + السقف + الميزانيات. الشاشة بتنادي دي بعد **كل**
     كتابة — مافيش نسخة متفائلة محلية. */
  app.get("/api/ads/control/live", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = await loadCfg();
    const only = c.req.query("platform");
    const days = Math.min(30, Math.max(1, Number(c.req.query("days")) || 7));
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const snap = await snapshot({ platforms: only ? [only] : null, stats: c.req.query("stats") !== "0", from, to });
    const book = await openBook();
    return c.json({
      ok: true,
      writeEnabled: writeAllowed(),
      range: { from, to, days },
      campaigns: snap.campaigns.map((x) => ({
        ...x,
        effectiveBudget: budgetOf(x, snap.byCampaign),      // بالريال دايماً
        fx: fxOf(x.platform),
        budgetLevel: x.dailyBudget != null ? "campaign" : (snap.byCampaign[String(x.id)] ? "adset" : "none"),
        /* تعديل الميزانية من هنا ممنوع في حالتين: الحملة CBO (الميزانية على
           المجموعات) أو حساب المنصة بعملة تانية (سناب/دولار). */
        budgetEditable: x.dailyBudget != null && fxOf(x.platform) === 1,
        pausedByUs: book.has(`${x.platform}:${x.id}`),
      })),
      reasons: snap.reasons,
      ceiling: {
        ceiling: cfg.dailyCeiling,
        active: snap.activeBudget,
        left: Math.round((cfg.dailyCeiling - snap.activeBudget) * 100) / 100,
        over: snap.activeBudget > cfg.dailyCeiling,
      },
      confirmAbove: cfg.confirmAbove,
    });
  });

  /* تشغيل قاعدة دلوقتي (أو معاينة من غير تنفيذ: dry=1). */
  app.post("/api/ads/control/run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const actor = await actorOf(c);
    /* من غير ruleId = «شوف لو فيه حاجة ميعادها جه» — نفس تقييم العامل بالظبط.
       عمداً **مش** «نفّذ كل القواعد»: ده كان هيشغّل «اقفل ٠٢:٠٠» و«افتح ١١:٠٠»
       مع بعض في نفس اللحظة، والنتيجة على مزاج الترتيب. */
    const r = await tick({
      trigger: "manual", onlyRule: b.ruleId || null,
      dry: b.dry === true, actor, source: b.dry === true ? "preview" : "manual",
    });
    return c.json(r, r.ok === false && r.error ? 500 : 200);
  });

  /* 🔴 «وقّف كل الإعلانات دلوقتي» / «رجّع اللي وقّفناه» — الزرار اللي كان
     ناقص الليلة اللي المشاوي خلصت فيها. */
  app.post("/api/ads/control/all", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const want = b.state === "on" ? "on" : "off";
    if (!writeAllowed()) {
      return c.json({ ok: false, guard: "ADS_ALLOW_WRITE مش مفعّل على السيرفر — مفيش أي أمر بيروح للمنصات." }, 409);
    }
    const actor = await actorOf(c);
    const cfg = await loadCfg();
    const platforms = Array.isArray(b.platforms) && b.platforms.length ? b.platforms.filter((p) => PLATFORM_IDS.has(p)) : null;
    const snap = await snapshot({ platforms });
    const gate = await storeGate();
    const rule = normRule({
      id: `manual_${want}`, action: want, at: "00:00", platforms: platforms || [],
      note: String(b.reason || "").slice(0, 160),
    });
    const res = await runRule(rule, { source: "panic", actor, cfg, snap, gate, bizDay: bizDayOf() });
    return c.json({ ok: !res.blocked, ...res, reason: b.reason || null });
  });

  /* تغيير ميزانية حملة/مجموعة — بالسقف وبالتأكيد وبفحص التعلّم. */
  app.post("/api/ads/control/budget/:platform/:level/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const platform = c.req.param("platform");
    const level = c.req.param("level");
    const id = c.req.param("id");
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const cfg = await loadCfg();
    const snap = await snapshot({ platforms: [platform] });

    // ميزانية باقي الشغّال = الشغّال كله ناقص اللي بنعدّله (لو هو حملة شغّالة)
    const mine = snap.campaigns.find((x) => String(x.id) === String(id));
    const current = Number(b.current ?? (mine ? budgetOf(mine, snap.byCampaign) : 0)) || 0;
    const others = Math.max(0, snap.activeBudget - (mine && mine.status === "ACTIVE" ? budgetOf(mine, snap.byCampaign) : 0));

    /* ⚠️ سناب بيفوتر بالدولار و`budgetCall` بيبعت الرقم زي ما هو كـmicros من
       عملة الحساب — يعني «٢٠٠» هتتقري ٢٠٠ دولار (≈٧٥٠ ر.س). لحد ما ده
       يتصلّح في ads.js نفسه (والطيار بيستخدم نفس النداء)، الشاشة دي مابتكتبش
       ميزانية سناب أصلاً بدل ما تصرف ٣٫٧٥ ضعف اللي المالك كتبه. */
    if (fxOf(platform) !== 1) {
      return c.json({
        ok: false, applied: false,
        error: `حساب ${byId(platform)?.label || platform} بيفوتر بعملة غير الريال (×${fxOf(platform)}). الرقم اللي بيتبعت للمنصة بيتقري بعملتها، فالمبلغ هيطلع أكبر من اللي كتبته. غيّر ميزانية المنصة دي من لوحتها لحد ما التحويل يتظبط في السيرفر — التشغيل والإيقاف شغّالين عادي.`,
      }, 400);
    }
    const v = budgetVerdict({ current, next: b.dailyBudget, othersBudget: others, cfg, confirmed: b.confirm === true });
    if (!v.ok) {
      await logRow({ source: "manual", actor: await actorOf(c), platform, level, objectId: id, objectName: b.name || null,
        action: "budget", from: current, to: b.dailyBudget, ok: false, error: v.error, detail: { needsConfirm: !!v.needsConfirm } });
      return c.json({ ok: false, ...v }, v.needsConfirm ? 409 : 400);
    }
    const r = await applyEntityBudget({
      platform, level, id, amount: Number(b.dailyBudget),
      costPerResult: b.costPerResult, force: b.force === true, name: b.name,
    });
    const actor = await actorOf(c);
    await logRow({ source: "manual", actor, platform, level, objectId: id, objectName: b.name || null,
      action: "budget", from: current, to: b.dailyBudget, ok: r.ok, error: r.ok ? null : r.error,
      detail: { learning: r.learning || null, ceilingAfter: v.after } });
    if (r.ok) await cmsAudit(actor, `ميزانية ${platform} ${level} ${b.name || id}: ${current} ← ${b.dailyBudget} ر.س`);
    return c.json({ ok: r.ok, ...r, ceiling: { ceiling: cfg.dailyCeiling, after: v.after } }, r.ok ? 200 : (r.status || 502));
  });

  /* تشغيل/إيقاف أي كيان: حملة أو مجموعة أو إعلان واحد.
     الإعلان الواحد هو بالظبط اللي مكانش ينفع يتقفل الليلة دي. */
  app.post("/api/ads/control/state/:platform/:level/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const platform = c.req.param("platform"), level = c.req.param("level"), id = c.req.param("id");
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const state = String(b.state || "").toUpperCase();
    if (state !== "ACTIVE" && state !== "PAUSED") return c.json({ ok: false, error: 'state لازم تكون "ACTIVE" أو "PAUSED"' }, 400);

    // تشغيل = صرف. نفس حارس المطعم بتاع الجدولة بيتطبّق على الزرار اليدوي.
    if (state === "ACTIVE") {
      const cfg = await loadCfg();
      const gate = await storeGate();
      const g = openGate({ rule: { action: "on" }, cfg, service: gate.service, windowOpen: gate.windowOpen });
      if (!g.ok && b.anyway !== true) {
        return c.json({ ok: false, needsOverride: true, error: g.why }, 409);
      }
    }
    const r = await applyEntityState({ platform, level, id, state });
    const actor = await actorOf(c);
    await logRow({ source: "manual", actor, platform, level, objectId: id, objectName: b.name || null,
      action: state === "ACTIVE" ? "state_on" : "state_off", to: state, ok: r.ok, error: r.ok ? null : r.error,
      detail: { anyway: b.anyway === true, applied: r.applied !== false } });
    if (r.ok) {
      if (level === "campaign") {
        if (state === "PAUSED") await bookPause([{ platform, id, name: b.name, level }], { source: "manual", ruleId: null, bizDay: bizDayOf() });
        else await bookRestore(platform, id);
      }
      await cmsAudit(actor, `${state === "ACTIVE" ? "تشغيل" : "إيقاف"} ${level === "ad" ? "إعلان" : level === "adset" ? "مجموعة" : "حملة"} ${platform}: ${b.name || id}`);
    }
    return c.json({ ok: r.ok, ...r }, r.ok ? 200 : (r.status || 502));
  });

  /* السجل — «إيه اللي حصل وإمتى ومين عمله». */
  app.get("/api/ads/control/log", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ready;
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 120));
    const r = await pool.query(
      `SELECT id, at, source, actor, rule_id, platform, level, object_id, object_name,
              action, from_value, to_value, ok, error, detail
         FROM ads_ctl_log ORDER BY at DESC LIMIT $1`, [limit]);
    return c.json({ ok: true, rows: r.rows });
  });

  console.log(`[ads-ctl] routes ready (tick ${TICK_MINUTES}m · write ${writeAllowed() ? "ARMED" : "locked"})`);
  return { tick, snapshot, loadCfg, runRule };
}
