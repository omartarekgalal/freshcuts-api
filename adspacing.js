/* ═══════════════════════════════════════════════════════════════════════════
   🧠 مخ الإيقاع — «الأيام مختلفة وسلوكها مختلف» (عمر، ٢١/٩/٢٠٢٦)

   كلام عمر بالحرف:
     «الخميس والجمعة والسبت غير باقي الأسبوع · آخر الشهر غير نص الشهر ·
      من مصلحتنا يكون فيه دخل طول اليوم · ممكن نحسب تكلفة الحصول على الطلب في
      أوقات الذروة وغير الذروة، ودا هيخلينا نعمل scaling بتقدير طبيعي للأرقام ·
      لازم كل حاجة بتتغير تكون معمول حسابها باستمرار.»

   الملف ده بيعمل حاجتين:

   ١) المصفوفة (تحليل): تكلفة الطلب والدخل مقسّمين على
        • فترة اليوم: ذروة (١٨:٠٠←٠١:٠٠) / خارج الذروة (١٢:٠٠←١٨:٠٠) / متأخر
        • يوم الأسبوع (٧ أيام)
        • مرحلة الشهر: نافذة الرواتب (٢٧←٥) مقابل نص الشهر
      كل خانة بترجّع معاها حجم العيّنة ودرجة الثقة — ولو العيّنة صغيرة بتقول
      كده صريح بدل ما تدّي رقم يتبنى عليه قرار.

   ٢) خطة الإيقاع (تنفيذ): الأوزان اللي الحارس (fc96/guard.mjs) بيستعملها
      بتتحسب من الداتا نفسها كل يوم بدل ما عمر يعدّلها بإيده:
        • وزن اليوم = دخل اليوم ده ÷ متوسط الدخل اليومي (آخر ٨ أسابيع، مرجّحة
          للأحدث بنصف عمر ٢١ يوم) × عامل مرحلة الشهر
        • الفرملة النهارية (throttle) = أقصى نسبة من ميزانية اليوم يُسمح بصرفها
          قبل بداية الذروة — متحسبة من نصيب الفترة دي من الدخل × كفاءتها في
          تكلفة الطلب مقارنة بالذروة
        • سقف صلب ٣٠٠٠/يوم وأرضية مابننزلش تحتها
        • أي رقم عمر كاتبه بإيده (في الحارس أو من اللوحة) بيكسب على المحسوب

   ليه الأوزان من الدخل مش من تكلفة الطلب؟ لأن دخل نقطة البيع عنده ٥ شهور
   تاريخ (آلاف الطلبات) فالتوزيع بتاعه مستقر، لكن صرف الإعلانات الحقيقي بدأ
   ١٧/٩ — فتكلفة الطلب لسه عيّنتها صغيرة. فبنبني الأوزان على الدخل (قوي)
   وبنعدّلها بكفاءة تكلفة الطلب لما العيّنة تسمح بس (mixing بالثقة).

   Routes (admin):
     GET  /api/marketing/ad-efficiency/matrix?weeks=8
     GET  /api/marketing/pacing-plan?day=YYYY-MM-DD     ← الحارس بيقراها
     PUT  /api/marketing/pacing-plan                    ← تعديل المالك

   الإعدادات: settings.adsPacing (شوف DEFAULTS تحت).
═══════════════════════════════════════════════════════════════════════════ */

import { bizDay, bizDaySql, riyadhHourSql, bizStart, shiftDay, weekdayOf, DAY_RE } from "./bizday.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const r3 = (v) => Math.round(num(v) * 1000) / 1000;
const r4 = (v) => Math.round(num(v) * 10000) / 10000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const NOT_PAID = ["pending_payment", "expired", "rejected_refunded", "refunded", "refund_failed", "cancelled", "canceled", "payment_failed", "failed", "unpaid"];
const TEST_COUPONS = ["OMAR-9X4T"];

/* أرقام عربية في النصوص اللي عمر بيقراها — الواجهة RTL والخلط بيبوظ القراءة */
const AR_D = "٠١٢٣٤٥٦٧٨٩";
export const arn = (v, d = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(d).replace(/[0-9]/g, (x) => AR_D[+x]).replace(".", "٫");
};

export const WEEKDAY_AR = ["الأحد", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت"];

/* الإعدادات الافتراضية — كلها قابلة للتعديل من settings.adsPacing */
export const DEFAULTS = {
  auto: true,               // الأوزان بتتحسب من الداتا؟ false = الحارس يفضل على أرقامه
  weeks: 8,                 // نافذة التعلّم
  halfLifeDays: 21,         // ترجيح الأحدث: وزن اليوم = ٠٫٥^(عمره/ده)
  hardCapDaily: 3000,       // قرار عمر ١٧/٩ — سقف صلب
  floorDaily: 250,          // أرضية: مابنوقفش الإعلان خالص
  peakFromHour: 18,         // بداية الذروة (ساعة الرياض)
  peakToHour: 1,            // آخر ساعة ذروة (شاملة) — ٠١:٠٠
  offpeakFromHour: 12,      // المطعم بيفتح ١٢
  salaryFrom: 27, salaryTo: 5,   // نافذة الرواتب: ٢٧ ← ٥
  weightMin: 0.6, weightMax: 1.8,
  phaseMin: 0.85, phaseMax: 1.25,
  shrinkDays: 3,            // كل ما العيّنة تصغر، الوزن بيقرب من ١
  offpeak: { mode: "min", minShare: 0.10, manualShare: null },  // off | min | follow | always_on | manual
  throttle: { shareMin: 0.05, shareMax: 0.45, safety: 0.9 },
  overrides: { weekday: {}, dates: {}, throttle: null, hardCapDaily: null, floorDaily: null },
};

/* دمج إعدادات المالك فوق الافتراضي (عميق لمستوى واحد). */
export function mergeCfg(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  const out = { ...DEFAULTS, ...s };
  out.offpeak = { ...DEFAULTS.offpeak, ...(s.offpeak || {}) };
  out.throttle = { ...DEFAULTS.throttle, ...(s.throttle || {}) };
  out.overrides = { ...DEFAULTS.overrides, ...(s.overrides || {}) };
  out.overrides.weekday = { ...(s.overrides?.weekday || {}) };
  out.overrides.dates = { ...(s.overrides?.dates || {}) };
  out.weeks = clamp(Math.round(num(out.weeks) || 8), 2, 26);
  out.halfLifeDays = clamp(num(out.halfLifeDays) || 21, 3, 120);
  out.hardCapDaily = clamp(num(out.overrides.hardCapDaily) || num(out.hardCapDaily) || 3000, 100, 3000);
  out.floorDaily = clamp(num(out.overrides.floorDaily) || num(out.floorDaily) || 250, 0, out.hardCapDaily);
  return out;
}

/* ── فترة اليوم من ساعة الرياض ───────────────────────────────────────────── */
export function hourBucket(h, cfg = DEFAULTS) {
  const x = ((num(h) % 24) + 24) % 24;
  const inPeak = cfg.peakFromHour <= cfg.peakToHour
    ? x >= cfg.peakFromHour && x <= cfg.peakToHour
    : x >= cfg.peakFromHour || x <= cfg.peakToHour;
  if (inPeak) return "peak";
  if (x >= cfg.offpeakFromHour && x < cfg.peakFromHour) return "offpeak";
  return "late";
}
export const BUCKET_AR = { peak: "الذروة ١٨←٠١", offpeak: "خارج الذروة ١٢←١٨", late: "متأخر ٠١←٠٤ والصبح" };

/* مرحلة الشهر من يوم تشغيلي YYYY-MM-DD */
export function monthPhase(day, cfg = DEFAULTS) {
  const d = Number(String(day).slice(8, 10));
  return d >= cfg.salaryFrom || d <= cfg.salaryTo ? "salary" : "mid";
}
export const PHASE_AR = { salary: `نافذة الرواتب (٢٧←٥)`, mid: "نص الشهر (٦←٢٦)" };

/* ── الثقة ───────────────────────────────────────────────────────────────────
   n = عدد الطلبات اللي الرقم مبني عليها. الخطأ النسبي التقريبي لعدّ بواسون
   = ١/√n. يعني ٤ طلبات → ٥٠٪ خطأ (مايتقالش عليه رقم)، ٢٥ طلب → ٢٠٪.
   بنطلب كمان حد أدنى صرف عشان مانحكمش على خانة صرفت ٣٠ ريال.        */
export function confidenceOf(n, spend = 0, days = 0) {
  const N = Math.max(0, Math.round(num(n)));
  if (!N) return { level: "none", rse: null, label: "مفيش عيّنة", trust: false, ar: "مفيش طلبات في الخانة دي" };
  const rse = 1 / Math.sqrt(N);
  if (N >= 30 && spend >= 300 && days >= 7) return { level: "high", rse: r3(rse), label: "ثقة عالية", trust: true, ar: `${arn(N)} طلب — الرقم ده يتبنى عليه` };
  if (N >= 12 && spend >= 120) return { level: "medium", rse: r3(rse), label: "ثقة متوسطة", trust: true, ar: `${arn(N)} طلب — الاتجاه واضح، الرقم نفسه ±${arn(rse * 100)}٪` };
  if (N >= 4) return { level: "low", rse: r3(rse), label: "ثقة ضعيفة", trust: false, ar: `${arn(N)} طلب بس — اتجاه مبدئي، ±${arn(rse * 100)}٪` };
  return { level: "tiny", rse: r3(rse), label: "العيّنة صغيرة", trust: false, ar: `${arn(N)} طلب — مش كفاية لأي قرار` };
}

/* خانة فاضية */
const emptyCell = () => ({
  spend: 0, spendWeb: 0, spendWa: 0,
  orders: 0, revenue: 0, hall: 0, apps: 0, online: 0,
  onlineOrders: 0, adsOrders: 0, adsRevenue: 0, days: new Set(),
});

function finishCell(c, key, label) {
  const days = c.days instanceof Set ? c.days.size : num(c.days);
  const cpa = c.onlineOrders ? r2(c.spendWeb / c.onlineOrders) : null;
  const conf = confidenceOf(c.onlineOrders, c.spendWeb, days);
  const cpaAds = c.adsOrders ? r2(c.spendWeb / c.adsOrders) : null;
  return {
    key, label, days,
    spend: r2(c.spend), spendWeb: r2(c.spendWeb), spendWhatsapp: r2(c.spendWa),
    revenue: r2(c.revenue), hall: r2(c.hall), apps: r2(c.apps), online: r2(c.online),
    orders: c.orders, onlineOrders: c.onlineOrders, adsOrders: c.adsOrders,
    aovOnline: c.onlineOrders ? r2(c.online / c.onlineOrders) : null,
    cpa, cpaAds,
    cpaLow: cpa != null && conf.rse ? r2(cpa * (1 - conf.rse)) : null,
    cpaHigh: cpa != null && conf.rse ? r2(cpa * (1 + conf.rse)) : null,
    cpo: c.orders ? r2(c.spend / c.orders) : null,
    ratio: c.revenue > 0 ? r4(c.spend / c.revenue) : null,
    roas: c.spendWeb > 0 ? r2(c.online / c.spendWeb) : null,
    spendPerDay: days ? r2(c.spend / days) : null,
    revenuePerDay: days ? r2(c.revenue / days) : null,
    confidence: conf,
  };
}

/* ترجيح الأحدث */
export const recencyWeight = (day, today, halfLife) => {
  const age = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400e3));
  return Math.pow(0.5, age / halfLife);
};

/* ── اشتقاق وزن من متوسطات مرجّحة، مع تقريب ناحية ١ حسب حجم العيّنة ────────
   raw = متوسط المجموعة ÷ المتوسط العام. shrink = 1 + (raw-1)×n/(n+k).
   يعني يوم عندنا منه يومين بس مش هياخد وزن ١٫٥ — هياخد حوالي ١٫٢.        */
export function shrinkWeight(raw, n, k, lo, hi) {
  if (!Number.isFinite(raw) || raw <= 0 || !n) return 1;
  const w = 1 + (raw - 1) * (n / (n + Math.max(0.5, k)));
  return r3(clamp(w, lo, hi));
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, DEFAULT_DELIVERY_APPS, jb } = ctx;
  const cache = new Map();
  const cached = async (key, ms, fn) => {
    const h = cache.get(key);
    if (h && Date.now() - h.at < ms) return h.val;
    const val = await fn();
    cache.set(key, { at: Date.now(), val });
    if (cache.size > 20) cache.clear();
    return val;
  };
  const q = async (sql, args = []) => {
    try { return (await pool.query(sql, args)).rows; }
    catch (e) { console.error("[adspacing]", e.message); return []; }
  };

  async function cfg() {
    try { return mergeCfg((await getSettingsData())?.adsPacing); }
    catch { return mergeCfg(null); }
  }
  async function appsList() {
    try {
      const s = await getSettingsData();
      const list = Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length ? s.deliveryAppMethods : (DEFAULT_DELIVERY_APPS || []);
      return list.map((x) => String(x).toLowerCase());
    } catch { return (DEFAULT_DELIVERY_APPS || []).map((x) => String(x).toLowerCase()); }
  }

  /* الداتا الخام: صف لكل (يوم تشغيلي × ساعة) من ٣ مصادر. بنجمّعها في JS
     عشان نقدر نقسّمها بأي طريقة من غير ٣ استعلامات لكل تقسيمة. */
  async function rawWindow(from, to) {
    const startUtc = bizStart(from).toISOString();
    const endUtc = bizStart(shiftDay(to, 1)).toISOString();
    const apps = await appsList();
    const [spend, shop, pos] = await Promise.all([
      q(`SELECT ${bizDaySql("hour_start")}::text AS d, ${riyadhHourSql("hour_start")} AS h,
                kind, COALESCE(sum(spend),0) AS spend
           FROM ad_spend_hourly WHERE hour_start >= $1 AND hour_start < $2
          GROUP BY 1,2,3`, [startUtc, endUtc]),
      q(`SELECT ${bizDaySql("created_at")}::text AS d, ${riyadhHourSql("created_at")} AS h,
                COALESCE(total,0) AS total, coupon, is_test, attrib_source, attribution
           FROM shop_orders
          WHERE created_at >= $1 AND created_at < $2 AND status <> ALL($3::text[])`, [startUtc, endUtc, NOT_PAID]),
      q(`SELECT ${bizDaySql("o.order_date")}::text AS d, ${riyadhHourSql("o.order_date")} AS h,
                (o.order_type ILIKE '%external%' OR o.order_type ILIKE '%qr-menu%') AS mirror,
                (EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(o.payments,'{}'::jsonb)) k WHERE lower(k) = ANY($3::text[]))
                 OR EXISTS (SELECT 1 FROM order_sources x WHERE x.order_id = o.order_id AND x.source = 'delivery_app')) AS app_src,
                count(*)::int AS n, COALESCE(sum(o.total),0) AS rev
           FROM ts_orders o
          WHERE o.order_date >= $1 AND o.order_date < $2
            AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
          GROUP BY 1,2,3,4`, [startUtc, endUtc, apps]),
    ]);
    return { spend, shop, pos };
  }

  /* بنى المصفوفة: كل التقسيمات من نفس الداتا الخام = مستحيل رقمين يختلفوا. */
  async function buildMatrix(weeks) {
    const c = await cfg();
    const W = clamp(Math.round(num(weeks) || c.weeks), 2, 26);
    return cached(`matrix|${W}`, 10 * 60_000, async () => {
      const today = bizDay(new Date());
      const to = shiftDay(today, -1);                 // آخر يوم مكتمل
      const from = shiftDay(to, -(W * 7 - 1));
      const { spend, shop, pos } = await rawWindow(from, to);

      const dims = {
        bucket: new Map(), weekday: new Map(), phase: new Map(),
        matrix: new Map(),        // weekday|bucket
        phaseBucket: new Map(),   // phase|bucket
        day: new Map(),           // يوم تشغيلي (للأوزان)
        hour: new Map(),          // ساعة الرياض (لمنحنى اليوم)
        all: emptyCell(),
      };
      const cell = (m, k) => { let x = m.get(k); if (!x) { x = emptyCell(); m.set(k, x); } return x; };
      const touch = (d, h, fn) => {
        const b = hourBucket(h, c), wd = weekdayOf(d), ph = monthPhase(d, c);
        const targets = [
          cell(dims.bucket, b), cell(dims.weekday, String(wd)), cell(dims.phase, ph),
          cell(dims.matrix, `${wd}|${b}`), cell(dims.phaseBucket, `${ph}|${b}`),
          cell(dims.day, d), cell(dims.hour, String(h)), dims.all,
        ];
        for (const t of targets) { t.days.add(d); fn(t); }
      };

      for (const r of spend) {
        const s = num(r.spend), wa = r.kind === "whatsapp";
        touch(r.d, r.h, (t) => { t.spend += s; if (wa) t.spendWa += s; else t.spendWeb += s; });
      }
      for (const r of pos) {
        if (r.mirror && !r.app_src) continue;         // انعكاس طلب المتجر — بييجي من shop_orders
        const rev = num(r.rev), n = num(r.n), isApp = !!r.app_src;
        touch(r.d, r.h, (t) => {
          t.revenue += rev; t.orders += n;
          if (isApp) t.apps += rev; else t.hall += rev;
        });
      }
      for (const o of shop) {
        if (o.is_test || TEST_COUPONS.includes(String(o.coupon || "").toUpperCase())) continue;
        const rev = num(o.total);
        const fromAd = !!(o.attrib_source || (o.attribution && Object.keys(o.attribution).length));
        touch(o.d, o.h, (t) => {
          t.revenue += rev; t.orders += 1; t.online += rev; t.onlineOrders += 1;
          if (fromAd) { t.adsOrders += 1; t.adsRevenue += rev; }
        });
      }

      const list = (m, labeller) => [...m.entries()].map(([k, v]) => finishCell(v, k, labeller(k)));
      const byBucket = list(dims.bucket, (k) => BUCKET_AR[k] || k).sort((a, b) => b.revenue - a.revenue);
      const byWeekday = list(dims.weekday, (k) => WEEKDAY_AR[Number(k)]).sort((a, b) => Number(a.key) - Number(b.key));
      const byPhase = list(dims.phase, (k) => PHASE_AR[k] || k);
      const matrix = list(dims.matrix, (k) => `${WEEKDAY_AR[Number(k.split("|")[0])]} — ${BUCKET_AR[k.split("|")[1]]}`);
      const phaseBucket = list(dims.phaseBucket, (k) => `${PHASE_AR[k.split("|")[0]]} — ${BUCKET_AR[k.split("|")[1]]}`);
      const all = finishCell(dims.all, "all", "كل الفترة");
      const hourCurve = [...dims.hour.entries()]
        .map(([k, v]) => ({ hour: Number(k), revenue: r2(v.revenue), orders: v.orders, spend: r2(v.spend), onlineOrders: v.onlineOrders }))
        .sort((a, b) => a.hour - b.hour);

      // أيام تشغيلية كاملة بدخلها (لاشتقاق الأوزان)
      const days = [...dims.day.entries()].map(([d, v]) => ({
        day: d, weekday: weekdayOf(d), phase: monthPhase(d, c),
        revenue: r2(v.revenue), orders: v.orders, spend: r2(v.spend), onlineOrders: v.onlineOrders,
      })).sort((a, b) => (a.day < b.day ? -1 : 1));

      return { weeks: W, from, to, generatedAt: new Date().toISOString(), all, byBucket, byWeekday, byPhase, matrix, phaseBucket, hourCurve, days, cfg: c };
    });
  }

  /* ── اشتقاق الأوزان ─────────────────────────────────────────────────────── */
  function deriveWeights(m) {
    const c = m.cfg, today = bizDay(new Date());
    const hl = c.halfLifeDays;
    const acc = (rows) => {
      let w = 0, rev = 0, n = 0;
      for (const d of rows) { const k = recencyWeight(d.day, today, hl); w += k; rev += k * d.revenue; n += 1; }
      return { mean: w > 0 ? rev / w : 0, n, wsum: r3(w) };
    };
    const base = acc(m.days);
    const weekday = {}, weekdayInfo = [];
    for (let wd = 0; wd < 7; wd++) {
      const rows = m.days.filter((d) => d.weekday === wd);
      const a = acc(rows);
      const raw = base.mean > 0 ? a.mean / base.mean : 1;
      const w = shrinkWeight(raw, a.n, c.shrinkDays, c.weightMin, c.weightMax);
      weekday[wd] = w;
      weekdayInfo.push({
        weekday: wd, label: WEEKDAY_AR[wd], days: a.n, revenuePerDay: r2(a.mean), raw: r3(raw), weight: w,
        // ثقة الوزن بتتقاس بعدد الأيام اللي شفناها لليوم ده، مش بعدد الطلبات
        confidence: a.n >= 6 ? { level: "high", label: "ثقة عالية", trust: true, ar: `${arn(a.n)} ${WEEKDAY_AR[wd]} في النافذة` }
          : a.n >= 3 ? { level: "medium", label: "ثقة متوسطة", trust: true, ar: `${arn(a.n)} أيام بس — الوزن مقرّب ناحية ١` }
            : { level: "low", label: "ثقة ضعيفة", trust: false, ar: `${arn(a.n)} يوم — الوزن شبه ١` },
      });
    }
    const phase = {}, phaseInfo = [];
    for (const ph of ["salary", "mid"]) {
      const rows = m.days.filter((d) => d.phase === ph);
      const a = acc(rows);
      const raw = base.mean > 0 ? a.mean / base.mean : 1;
      const w = shrinkWeight(raw, a.n, c.shrinkDays * 2, c.phaseMin, c.phaseMax);
      phase[ph] = w;
      phaseInfo.push({ phase: ph, label: PHASE_AR[ph], days: a.n, revenuePerDay: r2(a.mean), raw: r3(raw), weight: w });
    }
    return { weekday, weekdayInfo, phase, phaseInfo, baseRevenuePerDay: r2(base.mean), days: base.n };
  }

  /* ── الفرملة النهارية: أقصى نسبة من ميزانية اليوم تتصرف قبل الذروة ─────────
     نصيب ما قبل الذروة من الدخل × (تكلفة طلب الذروة ÷ تكلفة طلب خارج الذروة).
     لو خارج الذروة أغلى في تكلفة الطلب، النسبة بتقل — وده بالظبط اللي عايزينه:
     نسيب فلوس أكتر لليل اللي بيجيب أرخص. والعكس لو لقينا الظهر أرخص. */
  function deriveThrottle(m) {
    const c = m.cfg;
    const cur = (b) => m.byBucket.find((x) => x.key === b) || null;
    const peak = cur("peak"), off = cur("offpeak"), late = cur("late");
    const totalRev = m.all.revenue || 1;
    const offShare = off ? r4(off.revenue / totalRev) : 0;
    const peakShare = peak ? r4(peak.revenue / totalRev) : 0;
    const lateShare = late ? r4(late.revenue / totalRev) : 0;

    // كفاءة: نسبة تكلفة طلب الذروة لخارج الذروة (١ = زي بعض، أقل من ١ = الظهر أغلى)
    const bothTrust = peak?.cpa != null && off?.cpa != null;
    const eff = bothTrust && off.cpa > 0 ? r3(clamp(peak.cpa / off.cpa, 0.25, 2)) : null;
    const effConf = bothTrust ? (peak.confidence.trust && off.confidence.trust ? "ok" : "weak") : "none";

    /* بداية الذروة المشتقّة: آخر ساعة (بين ١٥ و٢١) لسه الباقي منها ≥٦٠٪ من
       دخل اليوم. يعني «الساعة اللي بعدها الليل بيبقى معظم الشغل» — لو أخدنا
       أبكر ساعة بدل آخر واحدة هترجع ١٥ دايماً (الباقي من ١٥ طبعاً أكبر). */
    const order = Array.from({ length: 24 }, (_, i) => (i + 4) % 24);   // اليوم التشغيلي ٤←٣
    const revAt = Object.fromEntries(m.hourCurve.map((x) => [x.hour, x.revenue]));
    let peakStart = c.peakFromHour;
    for (let i = 0; i < order.length; i++) {
      const h = order[i];
      if (h < 15 || h > 21) continue;
      const rest = order.slice(i).reduce((s, x) => s + num(revAt[x]), 0);
      if (rest / totalRev >= 0.6) peakStart = h;
    }
    const untilMin = peakStart * 60;   // bizMin في الحارس = الساعة×٦٠ (قبل منتصف الليل)

    let share = offShare * (eff != null ? eff : c.throttle.safety);
    const mode = c.offpeak.mode;
    if (mode === "off") share = 0.02;
    else if (mode === "manual" && Number.isFinite(num(c.offpeak.manualShare)) && num(c.offpeak.manualShare) > 0) share = num(c.offpeak.manualShare);
    else if (mode === "min") share = Math.max(share, num(c.offpeak.minShare) || 0.10);
    else if (mode === "always_on") share = Math.max(share, offShare * 0.9);
    share = r3(clamp(share, c.throttle.shareMin, c.throttle.shareMax));

    return {
      untilMin, untilHour: peakStart, share, mode,
      derived: { offShare, peakShare, lateShare, efficiency: eff, efficiencyConfidence: effConf,
                 cpaPeak: peak?.cpa ?? null, cpaOffpeak: off?.cpa ?? null, cpaLate: late?.cpa ?? null },
    };
  }

  /* ── توصية خارج الذروة (عمر عايز دخل طول اليوم) ─────────────────────────── */
  function offpeakAdvice(m, th) {
    const d = th.derived;
    const off = m.byBucket.find((x) => x.key === "offpeak");
    const peak = m.byBucket.find((x) => x.key === "peak");
    const conf = off && peak ? (off.confidence.trust && peak.confidence.trust ? "ok" : off.confidence.level === "low" || peak.confidence.level === "low" ? "weak" : "none") : "none";
    const ratio = d.cpaPeak && d.cpaOffpeak ? r2(d.cpaOffpeak / d.cpaPeak) : null;
    const lines = [];
    let verdict = "unknown", recommend = "min";

    lines.push(`خارج الذروة (١٢←١٨) بيجيب ${arn(d.offShare * 100)}٪ من دخل المحل، والذروة (١٨←٠١) ${arn(d.peakShare * 100)}٪.`);
    if (ratio == null) {
      verdict = "unknown";
      lines.push("لسه مافيش تكلفة طلب موثوقة للفترتين — الصرف الحقيقي على الموقع بدأ ١٧/٩، فالعيّنة صغيرة.");
      lines.push("القرار دلوقتي: نسيب ميزانية صغيرة شغّالة خارج الذروة (مش صفر) لحد ما العيّنة تكبر، والمخ ده بيعيد الحساب كل يوم لوحده.");
    } else if (ratio >= 1.5) {
      verdict = "worse";
      recommend = conf === "ok" ? "min" : "min";
      lines.push(`طلب خارج الذروة بيكلّفنا ${arn(d.cpaOffpeak)} ر.س مقابل ${arn(d.cpaPeak)} ر.س في الذروة — يعني ${arn(ratio, 1)}× أغلى${conf === "ok" ? "" : " (عيّنة صغيرة، الاتجاه أوضح من الرقم)"}.`);
      lines.push(`الفرق ده هيكلي مش صدفة: الظهر الناس في الشغل، والنية أضعف — فنفس الريال بيجيب طلبات أقل.`);
      lines.push(`التوصية: مانقفلش الظهر (عمر عايز دخل طول اليوم) لكن ميزانية صغيرة دايمة بدل ما يفضل يحرق الميزانية بدري — سقف ${arn(th.share * 100)}٪ من صرف اليوم قبل ${arn(th.untilHour)}:٠٠، والباقي لليل.`);
      lines.push("والطريقة الصح لتحسين الظهر مش ميزانية أكتر: عرض غدا مخصوص + إبداع مختلف (وجبة سريعة/سعر غدا) + دفعة استلام من المحل — الاستلام بيشيل تكلفة المندوب ٢٠ ر.س من كل طلب صغير.");
    } else if (ratio <= 1.2) {
      verdict = "similar";
      recommend = "follow";
      lines.push(`تكلفة الطلب قريبة في الفترتين (${arn(d.cpaOffpeak)} مقابل ${arn(d.cpaPeak)} ر.س) — يعني مفيش سبب نحرم الظهر من الميزانية.`);
      lines.push("التوصية: الصرف يتوزّع بنفس نسبة الدخل — الفرملة النهارية تبقى على نصيب الظهر الطبيعي.");
    } else {
      verdict = "slightly_worse";
      recommend = "min";
      lines.push(`الظهر أغلى شوية (${arn(d.cpaOffpeak)} مقابل ${arn(d.cpaPeak)} ر.س = ${arn(ratio, 1)}×) — فرق بسيط، مش سبب نقفله.`);
      lines.push("التوصية: ميزانية ظهر صغيرة دايمة + تركيز الزيادة على الليل.");
    }
    if (m.byBucket.find((x) => x.key === "late")?.revenue) {
      lines.push(`المتأخر (بعد ٠١:٠٠) ${arn(d.lateShare * 100)}٪ من الدخل — صغير، فبنسيبه من غير ميزانية مستقلة.`);
    }
    return { verdict, recommend, ratio, confidence: conf, cpaPeak: d.cpaPeak, cpaOffpeak: d.cpaOffpeak, lines };
  }

  /* ── الخطة اللي الحارس بيقراها ──────────────────────────────────────────── */
  async function plan(day) {
    const c = await cfg();
    const m = await buildMatrix(c.weeks);
    const w = deriveWeights(m);
    const th = deriveThrottle(m);
    const advice = offpeakAdvice(m, th);
    const today = day && DAY_RE.test(day) ? day : bizDay(new Date());

    // أوزان التواريخ الجاية (١٤ يوم): وزن اليوم × عامل مرحلة الشهر
    const dates = {};
    for (let i = -1; i <= 14; i++) {
      const d = shiftDay(today, i);
      const ph = monthPhase(d, c);
      dates[d] = r3(clamp((w.weekday[weekdayOf(d)] ?? 1) * (w.phase[ph] ?? 1), c.weightMin, c.weightMax));
    }
    // أرقام المالك بتكسب المحسوب
    const manualDates = c.overrides.dates || {}, manualWeekday = c.overrides.weekday || {};
    const weekday = { ...w.weekday };
    for (const [k, v] of Object.entries(manualWeekday)) if (Number.isFinite(num(v)) && num(v) > 0) weekday[k] = r3(clamp(num(v), 0.2, 3));
    for (const [k, v] of Object.entries(manualDates)) if (DAY_RE.test(k) && Number.isFinite(num(v)) && num(v) > 0) dates[k] = r3(clamp(num(v), 0.2, 3));

    const throttle = c.overrides.throttle && Number.isFinite(num(c.overrides.throttle.share))
      ? { untilMin: Math.round(num(c.overrides.throttle.untilMin) || th.untilMin), share: r3(clamp(num(c.overrides.throttle.share), 0.01, 0.9)), mode: "manual", derived: th.derived }
      : th;

    const out = {
      ok: true, day: today, auto: c.auto !== false,
      generatedAt: new Date().toISOString(),
      source: c.auto === false ? "manual" : (Object.keys(manualDates).length || Object.keys(manualWeekday).length ? "mixed" : "derived"),
      learnedFrom: { weeks: m.weeks, from: m.from, to: m.to, days: w.days, halfLifeDays: c.halfLifeDays },
      hardCapDaily: c.hardCapDaily, floorDaily: c.floorDaily,
      weekday, dates,
      weightToday: dates[today] ?? 1,
      phase: monthPhase(today, c), phaseWeights: w.phase,
      throttle,
      offpeak: advice,
      manual: { weekday: manualWeekday, dates: manualDates, throttle: c.overrides.throttle || null },
      detail: { weekdayInfo: w.weekdayInfo, phaseInfo: w.phaseInfo, baseRevenuePerDay: w.baseRevenuePerDay },
    };
    // سجل يومي للمراجعة: الحارس شغّال على إيه فعلاً
    if (c.auto !== false) {
      await q(`INSERT INTO ads_pacing_plan (day, plan, at) VALUES ($1::date, $2::jsonb, now())
               ON CONFLICT (day) DO UPDATE SET plan = EXCLUDED.plan, at = now()`, [today, jb ? jb(out) : JSON.stringify(out)]);
    }
    return out;
  }

  pool.query(`CREATE TABLE IF NOT EXISTS ads_pacing_plan (day DATE PRIMARY KEY, plan JSONB, at TIMESTAMPTZ DEFAULT now())`).catch(() => {});

  /* ── Routes ─────────────────────────────────────────────────────────────── */
  app.get("/api/marketing/ad-efficiency/matrix", async (c2) => {
    const err = await requireAdmin(c2); if (err) return err;
    try {
      const m = await buildMatrix(Number(c2.req.query("weeks")));
      const w = deriveWeights(m);
      const th = deriveThrottle(m);
      return c2.json({
        ok: true,
        window: { weeks: m.weeks, from: m.from, to: m.to, days: m.days.length },
        generatedAt: m.generatedAt,
        all: m.all, byBucket: m.byBucket, byWeekday: m.byWeekday, byPhase: m.byPhase,
        matrix: m.matrix, phaseBucket: m.phaseBucket, hourCurve: m.hourCurve,
        weights: { weekday: w.weekdayInfo, phase: w.phaseInfo, baseRevenuePerDay: w.baseRevenuePerDay },
        throttle: th, offpeak: offpeakAdvice(m, th),
        notes: [
          "كل الأرقام على اليوم التشغيلي (٤ الفجر ← ٤ الفجر) وبتتحسب من نفس الداتا الخام — مفيش نسختين من أي قاعدة.",
          "تكلفة الطلب = صرف الويب (من غير الواتساب) ÷ طلبات الموقع المدفوعة في نفس الخانة.",
          "الدخل بيشمل الصالة والتطبيقات والموقع؛ انعكاسات طلبات الموقع في نقطة البيع مستبعدة.",
          "الخانة اللي عيّنتها صغيرة مكتوب عليها كده — متاخدش منها قرار.",
        ],
      });
    } catch (e) {
      console.error("[adspacing] matrix:", e);
      return c2.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  app.get("/api/marketing/pacing-plan", async (c2) => {
    const err = await requireAdmin(c2); if (err) return err;
    try { return c2.json(await plan(c2.req.query("day"))); }
    catch (e) {
      console.error("[adspacing] plan:", e);
      return c2.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  app.put("/api/marketing/pacing-plan", async (c2) => {
    const err = await requireAdmin(c2); if (err) return err;
    const b = await c2.req.json().catch(() => ({}));
    const cur = await cfg();
    const next = { ...cur };
    if (typeof b.auto === "boolean") next.auto = b.auto;
    if (Number.isFinite(num(b.weeks)) && num(b.weeks) >= 2) next.weeks = clamp(Math.round(num(b.weeks)), 2, 26);
    if (Number.isFinite(num(b.halfLifeDays)) && num(b.halfLifeDays) > 0) next.halfLifeDays = clamp(num(b.halfLifeDays), 3, 120);
    if (b.offpeak && typeof b.offpeak === "object") {
      const mode = String(b.offpeak.mode || "");
      if (["off", "min", "follow", "always_on", "manual"].includes(mode)) next.offpeak = { ...next.offpeak, mode };
      if (Number.isFinite(num(b.offpeak.minShare))) next.offpeak.minShare = clamp(num(b.offpeak.minShare), 0, 0.5);
      if (b.offpeak.manualShare === null) next.offpeak.manualShare = null;
      else if (Number.isFinite(num(b.offpeak.manualShare))) next.offpeak.manualShare = clamp(num(b.offpeak.manualShare), 0, 0.9);
    }
    const ov = { ...next.overrides };
    if (b.overrides && typeof b.overrides === "object") {
      if (b.overrides.weekday && typeof b.overrides.weekday === "object") {
        ov.weekday = {};
        for (const [k, v] of Object.entries(b.overrides.weekday)) {
          if (/^[0-6]$/.test(String(k)) && Number.isFinite(num(v)) && num(v) > 0) ov.weekday[k] = r3(clamp(num(v), 0.2, 3));
        }
      }
      if (b.overrides.dates && typeof b.overrides.dates === "object") {
        ov.dates = {};
        for (const [k, v] of Object.entries(b.overrides.dates)) {
          if (DAY_RE.test(k) && Number.isFinite(num(v)) && num(v) > 0) ov.dates[k] = r3(clamp(num(v), 0.2, 3));
        }
      }
      if (b.overrides.throttle === null) ov.throttle = null;
      else if (b.overrides.throttle && Number.isFinite(num(b.overrides.throttle.share))) {
        ov.throttle = { share: r3(clamp(num(b.overrides.throttle.share), 0.01, 0.9)), untilMin: Math.round(clamp(num(b.overrides.throttle.untilMin) || 1080, 720, 1380)) };
      }
      if (b.overrides.hardCapDaily === null) ov.hardCapDaily = null;
      else if (Number.isFinite(num(b.overrides.hardCapDaily))) ov.hardCapDaily = clamp(num(b.overrides.hardCapDaily), 100, 3000);
      if (b.overrides.floorDaily === null) ov.floorDaily = null;
      else if (Number.isFinite(num(b.overrides.floorDaily))) ov.floorDaily = clamp(num(b.overrides.floorDaily), 0, 3000);
    }
    next.overrides = ov;
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{adsPacing}', $1::jsonb, true), updated_at = NOW() WHERE id=1`,
      [jb ? jb(next) : JSON.stringify(next)]
    );
    cache.clear();
    return c2.json(await plan(null));
  });

  return { buildMatrix, plan, cfg };
}

export default { register };
