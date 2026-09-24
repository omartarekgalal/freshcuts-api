/* ═══════════════════════════════════════════════════════════════════════════
   ETA — «معاد الوصول» اللي بنقوله للعميل وقت الطلب.

   طلب عمر (٢٤ سبتمبر ٢٠٢٦): «عايزين نوصل لطريقة ثابتة في تحديد زمن الوصول
   المتوقع بناءً على كل التاريخ اللي معانا للطلبات اللي فاتت كلها (مع لاجلك)
   عشان نحاول نعرّف العميل إن وقت الوصول المتوقع نديله معاد بدل ما يفضل
   مستني كتير».

   ده مش `etaMinutes` اللي في courierlive.js. ده وعد **قبل** الطلب (مفيش
   مندوب ولا موقع لسه)، وده تقدير **وهو طاير** من موقع الكابتن على الخريطة.
   الاتنين محتاجين يعيشوا مع بعض ومابيحسبوش نفس الحاجة.

   ── ليه الشكل ده بالظبط ─────────────────────────────────────────────────

   ١) **نطاق مش رقم واحد.** التوزيع اللي قسناه مالوش قمّة واحدة ضيّقة
      (الوسيط ٦٠ دقيقة، وp90 ٩٩ دقيقة، والأقصى ١٤٣). رقم واحد يبقى كذب في
      نص الحالات. فبنقول [حد أدنى، حد أقصى] والوعد الحقيقي هو **الحد
      الأقصى** — العميل بيحكم علينا بيه، مش بالوسيط.

   ٢) **الكم (المسافة) هو العامل الوحيد اللي بنبني عليه.** قسنا العوامل
      اللي عمر شكّ فيها كلها على نفس الـ٧٠ طلب:
        المسافة  r=+0.46 على الرحلة كلها، و+0.57 على مشوار التوصيل نفسه ✅
        الزحمة في المطبخ  R²=0.11 (بس n=9 في خانة الزحمة) — اتجاه مش دليل
        الساعة   R²=0.07 — ضوضاء
        حجم السلة R²=0.01 — **ولا حاجة**
        اليوم من الأسبوع — مش قابل للفصل عن «اليوم الفلاني» أصلاً (٨ أيام بس)
      فالموديل بياخد المسافة وبس. أي عامل تاني بالأرقام اللي معانا هيبقى
      تزويق على ضوضاء.

   ٣) **الاستقرار = «طريقة ثابتة»** — تلات قرارات مع بعض:
      • المدخلات **مقسّمة لخانات** (bands): عميل على ٦٫٩ كم وعميل على ٧٫١ كم
        بياخدوا نفس الرد. من غير ده، متر واحد فرق بيغيّر الوعد.
      • الموديل **لقطة محفوظة** (snapshot) بتتبنى كل ساعة، والطلبات كلها
        بتقرا من نفس اللقطة — مش من استعلام لحظي. فعميلين بفارق دقيقة
        مستحيل يشوفوا رقمين مختلفين.
      • الوعد **بيتجمّد على الطلب**: `promiseKey` بيتخزّن مع الطلب وقت
        الشيك أوت، و`renderPromise` بترجّع نفس النص من المفتاح ده من غير أي
        حساب تاني. فالرقم مايتحركش وهو الطلب لسه حيّ.

   ٤) **التدهور بأمان.** خانة فيها أقل من MIN_BAND_SAMPLES طلب مابتخترعش
      دقّة: بتقع على التوزيع المجمّع + هامش أمان، و`thin:true` بيبان في
      الرد. ولو التاريخ كله أقل من MIN_TOTAL_SAMPLES، `showToCustomer`
      بيرجع false — بنقول «مانعرفش» بدل ما نقول رقم غلط.

   ٥) **البوابة.** `showToCustomer` مابيبقاش true غير لما التقييم الخارجي
      (اختبار على أيام ماشفهاش الموديل) يعدّي TARGET_HIT_RATE **و** النطاق
      يبقى أضيق من MAX_WINDOW_MIN. النهارده (٧٠ طلب في ٨ أيام) الشرطين
      الاتنين ساقطين، فالافتراضي إن الرقم يتعرض في اللوحة للمالك بس.
      ده مقصود: الموديل جاهز، البيانات لأ.

   الملف صافي (من غير DB) في الجزء الحاسبي كله، ومتختبر في eta.test.mjs.
   `register` بيضيف الراوتات ولقطة الموديل بس.
═══════════════════════════════════════════════════════════════════════════ */

import { bizDaySql } from "./bizday.js";

/* ── ثوابت الموديل ────────────────────────────────────────────────────────
   كل رقم هنا مقيس، مش مختار بالحس. المصدر جنبه. */

/** خانات المسافة (كم). حدود مش أرقام صحيحة عشان الاستقرار: أي كم بين ٤ و٧
    بياخد نفس الرد. الحدود اتاخدت من سلّم التسعيرة نفسه (baseKm=10،
    farZone من ١٠ لـ١٥) عشان الوعد والسعر يتكلموا نفس اللغة. */
export const KM_BANDS = Object.freeze([
  { id: "0-4", from: 0, to: 4, label: "قريب (أقل من 4 كم)" },
  { id: "4-7", from: 4, to: 7, label: "متوسط (4–7 كم)" },
  { id: "7-10", from: 7, to: 10, label: "بعيد (7–10 كم)" },
  { id: "10-15", from: 10, to: 15, label: "منطقة بعيدة (10–15 كم)" },
  { id: "15+", from: 15, to: Infinity, label: "خارج النطاق (فوق 15 كم)" },
]);

export const ETA_DEFAULTS = Object.freeze({
  /* الحد الأدنى = الوسيط. مش أقل: p40 كان بيخلّي ٢٦ طلب من ٧٠ يوصلوا
     **قبل** بداية النطاق، وده بيخلّي النطاق نفسه يبان متشائم بلا داعي. */
  lowQuantile: 0.5,
  /* الحد الأقصى = p90 + هامش. ليه p90 مش p80؟ التكلفة مش متساوية: وعد
     مكسور = استرجاع + تقييم وحش، ووعد متحفّظ = بيع ضايع. قسنا الاتنين:
       p80 خالص  → ٨٤٪ صح في LOO، و٧٠٪ بس على أيام ماشفهاش الموديل
       p90 + ١٠  → ٩١٪ في LOO، و٨٥٪ خارج العيّنة
       p95 + ١٠  → ٩٤٪ في LOO، و٩٣٪ خارج العيّنة — بس النطاق بيبقى ٥٦ دقيقة
     p90+١٠ هي أضيق نقطة بتعدّي ٨٥٪ خارج العيّنة. p95 أدق بس عرضه مش وعد. */
  highQuantile: 0.9,
  /* الهامش ده هو **تمن رقّة البيانات**، مش تمن الطريق. لما العيّنة تكبر
     (MIN_TOTAL_SAMPLES) المفروض ينزل — `safetyFor` بتصغّره لوحدها. */
  safetyMin: 10,
  /* خانة أقل من كده = مانقدرش نقيس p90 عليها. ١٢ لأن p90 على أقل من ١٠
      نقطة هو فعلياً «أكبر قيمة شفتها» — يعني ضوضاء، مش كمّية. */
  minBandSamples: 12,
  /* خانة رقيقة بتاخد التوزيع المجمّع + الهامش ده زيادة. */
  thinPadMin: 15,
  /* تحت الرقم ده مفيش وعد للعميل خالص. ٢٠٠ طلب ≈ شهر شغل بالمعدل الحالي،
     وهي أقل كمية تخلّي p90 لكل خانة يبقى له معنى (٤ خانات × ~٤٠). */
  minTotalSamples: 200,
  /* التقريب لأقرب ٥ دقايق: «55–80» بيبان وعد، «53–79» بيبان مقياس. */
  roundStepMin: 5,
  /* أقل عرض للنطاق. نطاق ١٠ دقايق بيوحي بدقّة مش موجودة. */
  minWindowMin: 20,
  /* أوسع نطاق يستحق يتعرض للعميل. فوق كده «45–120 دقيقة» = معلومة صفر. */
  maxWindowMin: 30,
  /* نسبة الوعود المحفوظة المطلوبة على أيام الموديل ماشفهاش. تحتها الرقم
     بيضرّ أكتر مما بينفع. */
  targetHitRate: 0.9,
  /* أيام الاختبار الخارجي (آخر N يوم تشغيلي بيتشالوا من التدريب). */
  holdoutDays: 2,
  /* فوق كده مش توصيلة، دي حادثة (طلب ضاع، المدير وقّف لاجلك بعد ساعتين…).
     بتتشال من حساب الأرقام، **بس بتتحسب متأخرة** في التقييم — إخفاءها من
     التقييم هو بالظبط إزاي بيتولد وعد كداب. */
  outlierMaxMin: 240,
  /* عمر التاريخ اللي بنقرا منه. أوسع من كده بيخلط عصر لاجلك بعصر
     Flying Arrow، والاتنين مش نفس الشركة ولا نفس الزمن. */
  historyDays: 120,
  /* كل قد إيه نبني اللقطة تاني. ساعة = مابيتحركش جوّه نفس الوردية. */
  refreshMin: 60,
});

/* ── مساعدات صافية ────────────────────────────────────────────────────── */

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** الخانة اللي الكم ده بيقع فيها. null (مش "unknown") لما مفيش مسافة أصلاً —
    الفرق مهم: «مش عارفين المسافة» مش زي «المسافة صفر». */
export function bandOf(km) {
  const k = num(km);
  if (k == null || k < 0) return null;
  return KM_BANDS.find((b) => k >= b.from && k < b.to) || KM_BANDS[KM_BANDS.length - 1];
}

/** كوانتايل بالتداخل الخطي. على مصفوفة **مرتّبة**. */
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const k = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(k), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

/** وصف توزيع: العدد والوسيط والأطراف والتشتت. الـmean موجود للمقارنة بس —
    الوعد قرار كوانتايل، مش متوسط، والفرق بينهم هنا ٦ دقايق. */
export function summarise(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: null, p50: null, p80: null, p90: null, p95: null, max: null, mean: null, sd: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  return {
    n: v.length, min: r1(v[0]), max: r1(v[v.length - 1]),
    p50: r1(quantile(v, 0.5)), p80: r1(quantile(v, 0.8)),
    p90: r1(quantile(v, 0.9)), p95: r1(quantile(v, 0.95)),
    mean: r1(mean), sd: r1(sd),
  };
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** تقريب النطاق لشبكة الـ٥ دقايق: الأدنى لتحت والأقصى لفوق — التقريب
    دايماً في اتجاه الأمان، عشان التقريب نفسه مايكسرش وعد. */
export function roundWindow(low, high, cfg = ETA_DEFAULTS) {
  const s = Math.max(1, cfg.roundStepMin);
  let lo = Math.max(s, Math.floor(low / s) * s);
  let hi = Math.ceil(high / s) * s;
  if (hi - lo < cfg.minWindowMin) hi = lo + cfg.minWindowMin;
  if (lo >= hi) lo = Math.max(s, hi - cfg.minWindowMin);
  return { lowMin: lo, highMin: hi };
}

/** النص اللي العميل بيشوفه. أرقام لاتينية زي باقي نصوص السيستم
    (`${age} دقيقة` في shop.js) — عربي-هندي بيتكسر في بعض الخطوط. */
export function windowText(lowMin, highMin) {
  return `${lowMin}–${highMin} دقيقة`;
}
/** النص الأهم فعلياً: الوعد. الحد الأقصى لوحده — ده اللي العميل بيقيس بيه. */
export function promiseText(highMin) {
  return `نوصلك خلال ${highMin} دقيقة`;
}

/** الهامش بيصغر لما العيّنة تكبر: الهامش تمن الشك، مش تمن الطريق.
    عند MIN_TOTAL_SAMPLES بيبقى نصّه، وعند تلات أضعافها بيختفي. */
export function safetyFor(n, cfg = ETA_DEFAULTS) {
  if (!n || n < cfg.minTotalSamples) return cfg.safetyMin;
  if (n >= cfg.minTotalSamples * 3) return 0;
  return Math.round(cfg.safetyMin / 2);
}

/* ── بناء الموديل ─────────────────────────────────────────────────────────
   الموديل = جدول صغير: لكل خانة مسافة، الحد الأدنى والأقصى بالدقايق.
   مفيش أوزان ولا انحدار — جدول كوانتايلات على خانات. ده مقصود: عمر لازم
   يقدر يقرا الموديل كله في عشر ثواني ويقول «الرقم ده جابه منين». */

/** samples: [{ totalMin, km, bizDay, provider, orderNo }] */
export function buildModel(samples, opts = {}) {
  const cfg = { ...ETA_DEFAULTS, ...(opts.cfg || {}) };
  const builtAt = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();

  /* الحوادث بتتشال من الأرقام بس بتتعدّ. لو شلناها وسكتنا، «٩٥٪ في الوعد»
     هيبقى صحيح على بيانات منتقاة وغلط على الواقع. */
  const usable = [], incidents = [];
  for (const s of samples || []) {
    const t = num(s.totalMin);
    if (t == null || t <= 0) continue;
    (t > cfg.outlierMaxMin ? incidents : usable).push({ ...s, totalMin: t });
  }

  const pool = usable.map((s) => s.totalMin);
  const poolStats = summarise(pool);
  const safety = safetyFor(pool.length, cfg);
  const poolLow = quantile([...pool].sort((a, b) => a - b), cfg.lowQuantile);
  const poolHigh = quantile([...pool].sort((a, b) => a - b), cfg.highQuantile);

  const bands = {};
  for (const b of KM_BANDS) {
    const vals = usable.filter((s) => bandOf(s.km)?.id === b.id).map((s) => s.totalMin).sort((a, b2) => a - b2);
    const thin = vals.length < cfg.minBandSamples;
    /* خانة رقيقة: بناخد **الأوسع** بين اللي شفناه في الخانة والتوزيع
       المجمّع، وبنزوّد. ليه الأوسع مش المجمّع وبس؟ ٣ طلبات على ١٧ كم
       كلهم ساعتين مش معلومة نرميها — هي أقل معلومة، بس هي أصدق حاجة
       عندنا عن الخانة دي. */
    const low = thin ? Math.min(poolLow ?? 0, vals.length ? quantile(vals, cfg.lowQuantile) : Infinity) : quantile(vals, cfg.lowQuantile);
    const high = thin
      ? Math.max(poolHigh ?? 0, vals.length ? quantile(vals, cfg.highQuantile) : 0) + cfg.thinPadMin
      : quantile(vals, cfg.highQuantile);
    bands[b.id] = {
      band: b.id, label: b.label, n: vals.length, thin,
      stats: summarise(vals),
      rawLowMin: r1(low), rawHighMin: r1(high + safety),
      ...roundWindow(low, high + safety, cfg),
      source: thin ? (vals.length ? "band+pool+pad" : "pool+pad") : "band",
    };
  }

  /* الرد لما المسافة مش معروفة خالص (العميل لسه ما حددش موقعه). أوسع من
     أي خانة عن قصد — «مانعرفش فين» لازم يكلّف عرض، مش يتخبّى. */
  const unknown = {
    band: null, label: "مسافة غير معروفة", n: pool.length, thin: true,
    stats: poolStats,
    rawLowMin: r1(poolLow), rawHighMin: r1((poolHigh ?? 0) + safety + cfg.thinPadMin),
    ...roundWindow(poolLow ?? 0, (poolHigh ?? 0) + safety + cfg.thinPadMin, cfg),
    source: "pool+pad",
  };

  const days = [...new Set(usable.map((s) => s.bizDay).filter(Boolean))].sort();
  const model = {
    version: null,
    builtAt,
    cfg,
    samples: { total: pool.length, incidents: incidents.length, bizDays: days.length, from: days[0] || null, to: days[days.length - 1] || null },
    pool: poolStats,
    safetyMin: safety,
    bands, unknown,
    /* مصادر الأرقام بالاسم — عشان حد يقدر يراجع من غير ما يقرا الكود. */
    inputs: ["km (dl_shipments.our_km ← delivery_quote.distanceKm)"],
    /* الأرقام اللي بتقرر تظهر للعميل ولا لأ — بتتحسب في `evaluate`. */
    quality: null, showToCustomer: false, reasons: [],
  };
  model.version = modelVersion(model);
  return model;
}

/** بصمة مختصرة للموديل. مش تعمية — الغرض إن الوعد المخزّن على الطلب يعرف
    إنه اتولد من أي لقطة، فلو الأرقام اتغيّرت بعد كده نعرف نفسّر الفرق. */
export function modelVersion(model) {
  const key = JSON.stringify([
    model.builtAt?.slice(0, 13) || "",
    model.samples?.total || 0,
    Object.values(model.bands || {}).map((b) => [b.band, b.n, b.lowMin, b.highMin]),
  ]);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `v1-${(h >>> 0).toString(36)}`;
}

/* ── التقدير ──────────────────────────────────────────────────────────── */

/**
 * التقدير لطلب واحد. دالة صافية على اللقطة — نفس المدخلات = نفس المخرجات
 * دايماً، وده نص معنى «طريقة ثابتة».
 *
 * input: { km }  — المسافة وبس. أي حاجة تانية بتترمي عن قصد (شوف ٢ فوق).
 */
export function estimate(model, input = {}) {
  const b = bandOf(input.km);
  const row = (b && model?.bands?.[b.id]) || model?.unknown;
  if (!row) {
    return { ok: false, reason: "no_model", showToCustomer: false };
  }
  const km = num(input.km);
  return {
    ok: true,
    lowMin: row.lowMin, highMin: row.highMin,
    text: windowText(row.lowMin, row.highMin),
    promise: promiseText(row.highMin),
    /* الوعد بيُعرض ولا لأ — قرار الموديل كله، مش قرار كل طلب. */
    showToCustomer: model.showToCustomer === true && (row.highMin - row.lowMin) <= model.cfg.maxWindowMin && !row.thin,
    confidence: row.thin ? "low" : row.n >= model.cfg.minBandSamples * 3 ? "high" : "medium",
    /* المفتاح اللي بيتخزّن مع الطلب. منه بس بيتعاد نفس النص بالحرف. */
    promiseKey: `${model.version}|${row.band || "unknown"}|${row.lowMin}-${row.highMin}`,
    /* «ليه الرقم ده» — بيروح للوحة، والعميل مايشوفهوش. */
    why: {
      km: km, band: row.band, bandLabel: row.label,
      basedOn: row.n, source: row.source, thin: row.thin,
      quantiles: { low: model.cfg.lowQuantile, high: model.cfg.highQuantile },
      safetyMin: model.safetyMin,
      bandStats: row.stats,
      modelVersion: model.version, modelBuiltAt: model.builtAt,
      sampleWindow: { bizDays: model.samples.bizDays, from: model.samples.from, to: model.samples.to, incidentsExcluded: model.samples.incidents },
    },
  };
}

/** إعادة عرض وعد مخزّن من مفتاحه. الطلب اللي طلع بوعد «55–80» يفضل «55–80»
    لو الموديل اتغير جوّه نفس الطلب — ده اللي يمنع الرقم يرقص وهو حيّ. */
export function renderPromise(promiseKey) {
  const m = /^(v1-[a-z0-9]+)\|([^|]*)\|(\d+)-(\d+)$/.exec(String(promiseKey || ""));
  if (!m) return null;
  const lowMin = Number(m[3]), highMin = Number(m[4]);
  return { ok: true, modelVersion: m[1], band: m[2] === "unknown" ? null : m[2], lowMin, highMin,
           text: windowText(lowMin, highMin), promise: promiseText(highMin) };
}

/* ── التقييم (backtest) ───────────────────────────────────────────────────
   الرقم الوحيد اللي بيهم: على أيام الموديل **ماشفهاش**، كام وعد اتحفظ؟
   التقييم داخل العيّنة بيكدب دايماً لفوق، فاللي بيفتح البوابة هو الخارجي. */

/** تقييم موديل جاهز على عيّنة. بيرجع نسبة الحفظ والذيل. */
export function scoreModel(model, samples, cfg = ETA_DEFAULTS) {
  let kept = 0, early = 0;
  const lateBy = [], widths = [];
  for (const s of samples || []) {
    const t = num(s.totalMin);
    if (t == null || t <= 0) continue;
    const e = estimate(model, { km: s.km });
    if (!e.ok) continue;
    widths.push(e.highMin - e.lowMin);
    if (t <= e.highMin) kept += 1; else lateBy.push(t - e.highMin);
    if (t < e.lowMin) early += 1;
  }
  const n = kept + lateBy.length;
  const late = lateBy.sort((a, b) => a - b);
  return {
    n, kept, late: late.length,
    hitRate: n ? kept / n : null,
    /* «متأخر بكام» أهم من «كام مرة متأخر»: وعد بيتكسر بعشر دقايق مشكلة
       صغيرة، ووعد بيتكسر بساعة هو اللي بيجيب التقييم الوحش. */
    lateMedianMin: r1(quantile(late, 0.5)), lateP90Min: r1(quantile(late, 0.9)),
    worstLateMin: late.length ? r1(late[late.length - 1]) : 0,
    /* اللي وصل قبل بداية النطاق: تحفّظ زيادة، بيضيّع بيع. */
    earlierThanLow: early,
    avgWindowMin: widths.length ? r1(widths.reduce((a, b) => a + b, 0) / widths.length) : null,
  };
}

/**
 * التقييم الخارجي: بنشيل آخر `holdoutDays` يوم تشغيلي، نبني على الباقي،
 * ونحكم على المشيل. ده أقرب حاجة للواقع: الموديل دايماً بيتنبّأ ببكرة.
 * بيرجع كمان `inSample` عشان الفرق بين الاتنين يبان — الفرق ده نفسه
 * مقياس لرقّة البيانات.
 */
export function evaluate(samples, opts = {}) {
  const cfg = { ...ETA_DEFAULTS, ...(opts.cfg || {}) };
  const usable = (samples || []).filter((s) => num(s.totalMin) != null && num(s.totalMin) > 0);
  const days = [...new Set(usable.map((s) => s.bizDay).filter(Boolean))].sort();
  const full = buildModel(usable, { cfg, now: opts.now });
  const inSample = scoreModel(full, usable, cfg);

  let holdout = null;
  if (days.length > cfg.holdoutDays + 1) {
    const cut = days[days.length - cfg.holdoutDays];
    const train = usable.filter((s) => s.bizDay < cut);
    const test = usable.filter((s) => s.bizDay >= cut);
    if (train.length >= cfg.minBandSamples && test.length) {
      holdout = { ...scoreModel(buildModel(train, { cfg, now: opts.now }), test, cfg), trainN: train.length, cutBizDay: cut, days: cfg.holdoutDays };
    }
  }

  /* البوابة: تلات شروط، وكلها لازم تعدّي. */
  const reasons = [];
  const widths = Object.values(full.bands).filter((b) => !b.thin).map((b) => b.highMin - b.lowMin);
  const widest = widths.length ? Math.max(...widths) : null;
  if (full.samples.total < cfg.minTotalSamples) {
    /* بنعدّ اللي صالح للقياس، مش كل اللي اتسلّم — الحادثة مش نقطة بيانات. */
    reasons.push(`العيّنة ${full.samples.total} طلب صالح للقياس (+${full.samples.incidents} حادثة)`
      + ` — المطلوب ${cfg.minTotalSamples} قبل أي وعد للعميل`);
  }
  if (!holdout) {
    reasons.push(`مفيش أيام كفاية لتقييم خارجي (${days.length} يوم تشغيلي)`);
  } else if (holdout.hitRate < cfg.targetHitRate) {
    reasons.push(`الوعد بيتحفظ ${Math.round(holdout.hitRate * 100)}٪ بس على أيام جديدة — المطلوب ${Math.round(cfg.targetHitRate * 100)}٪`);
  }
  if (widest != null && widest > cfg.maxWindowMin) {
    reasons.push(`أوسع نطاق ${widest} دقيقة — فوق حد ${cfg.maxWindowMin} اللي بعده الرقم مابيفيدش العميل`);
  }
  full.quality = { inSample, holdout, widestBandWindowMin: widest };
  full.showToCustomer = reasons.length === 0;
  full.reasons = reasons;
  full.version = modelVersion(full);
  return full;
}

/* ── حصّاد البيانات ───────────────────────────────────────────────────────
   قراية بس. مفيش UPDATE ولا CREATE في الملف ده كله.

   تحذيرات لازم تتقرا مع كل رقم بيطلع من الاستعلام ده:
     • `delivered_at` على الشحنة هو وقت **اكتشافنا** إن الطلب اتسلّم، مش
       وقت تسليمه. لاجلك عمرها ما بعتت ويبهوك واحد، فكل حالة جاية من
       استطلاع كل دقيقة → كل الأوقات دي فيها تأخير ٠–٢ دقيقة مبني في.
     • `paid_at` من `history` مش من عمود: الدفع محطة في السجل، والـbackfill
       الموجود (orders-schema.js) بيغطّي `accepted_at` بس.
     • `our_km` هي مسافتنا المحسوبة (جوجل)، مش مسافة المندوب الفعلية.
       المندوب بياخد طريق تاني وبيعمل أكتر من طلب في المشوار.
     • الشحنة اليدوية (`provider='manual'`) مستثناة: مرجعها رقم كتبه
       الكاشير، ومحطّاتها بتتسجّل لما حد يفتكر — مش وقت الحدث. */
export const SAMPLES_SQL = `
WITH o AS (
  SELECT s.order_no,
         s.created_at,
         s.subtotal,
         /* الكاست بعد فحص الشكل: قيمة نصّية غريبة في التسعيرة القديمة
            بتوقّع الاستعلام كله، وساعتها الموديل بيفضل فاضي من غير سبب باين. */
         CASE WHEN (s.delivery_quote->>'distanceKm') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (s.delivery_quote->>'distanceKm')::numeric END AS quote_km,
         (SELECT min((h->>'at')::timestamptz)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.history)='array' THEN s.history ELSE '[]'::jsonb END) h
           WHERE h->>'status' = 'paid'
             AND (h->>'at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}') AS paid_at
    FROM shop_orders s
   WHERE s.option = 'delivery'
     AND NOT COALESCE(s.is_test, false)
     AND s.created_at > NOW() - make_interval(days => $1::int)
),
/* شحنة واحدة لكل طلب. الطلب اللي اتبعت تاني (لاجلك رفضت، المدير بعت مندوب من
   بره) بيبقى له صفّين — من غير DISTINCT ON الطلب ده كان هيتحسب مرتين
   ويوزن نفسه، وهو بالظبط الطلب البطيء. بناخد آخر تسليم = اللي العميل عاشه. */
sh AS (
  SELECT DISTINCT ON (x.shop_order_no) x.shop_order_no, x.provider, x.our_km, x.delivered_at
    FROM dl_shipments x
   WHERE x.delivered_at IS NOT NULL AND x.provider <> 'manual'
   ORDER BY x.shop_order_no, x.delivered_at DESC
)
SELECT o.order_no,
       sh.provider,
       COALESCE(sh.our_km, o.quote_km)::float8 AS km,
       o.subtotal::float8 AS subtotal,
       (EXTRACT(EPOCH FROM (sh.delivered_at - o.paid_at)) / 60)::float8 AS total_min,
       ${bizDaySql("o.paid_at")}::text AS biz_day
  FROM o
  JOIN sh ON sh.shop_order_no = o.order_no
 WHERE o.paid_at IS NOT NULL
 ORDER BY sh.delivered_at`;

export function rowsToSamples(rows) {
  return (rows || []).map((r) => ({
    orderNo: r.order_no, provider: r.provider,
    km: num(r.km), subtotal: num(r.subtotal),
    totalMin: num(r.total_min), bizDay: r.biz_day || null,
  })).filter((s) => s.totalMin != null && s.totalMin > 0);
}

/* ── الراوتات ─────────────────────────────────────────────────────────── */

export function register(app, ctx = {}) {
  const { pool, requireAdmin } = ctx;
  const log = ctx.log || console;
  const cfg = { ...ETA_DEFAULTS, ...(ctx.etaCfg || {}) };

  /* اللقطة. كل الطلبات بتقرا منها — مش من استعلام لحظي. من غير ده عميلين
     بفارق دقيقة ممكن يشوفوا رقمين مختلفين لو طلب خلص بينهم. */
  let snapshot = null, building = null, lastError = null;

  async function rebuild() {
    const { rows } = await pool.query(SAMPLES_SQL, [cfg.historyDays]);
    const m = evaluate(rowsToSamples(rows), { cfg });
    snapshot = m; lastError = null;
    log.log?.(`[eta] موديل ${m.version}: ${m.samples.total} طلب على ${m.samples.bizDays} يوم — `
      + (m.showToCustomer ? "جاهز للعرض للعميل" : `مش للعرض (${m.reasons[0]})`));
    return m;
  }
  const ready = () => {
    if (snapshot && Date.now() - Date.parse(snapshot.builtAt) < cfg.refreshMin * 60_000) return Promise.resolve(snapshot);
    building ||= rebuild()
      .catch((e) => { lastError = e.message; log.error?.(`[eta] بناء الموديل فشل: ${e.message}`); return snapshot; })
      .finally(() => { building = null; });
    return snapshot ? Promise.resolve(snapshot) : building;
  };
  ready().catch(() => {});
  if (cfg.refreshMin > 0) {
    const t = setInterval(() => { ready().catch(() => {}); }, cfg.refreshMin * 60_000);
    if (t.unref) t.unref();
  }

  /* عام — السلة بتسأل قبل الشيك أوت. بيرجع الرقم **دايماً** مع
     `showToCustomer` — الواجهة هي اللي تقرر تعرضه ولا تعرض «من ٤٥ لـ٩٠
     دقيقة حسب موقعك». من غير الفصل ده كنا هنضطر نكتب الحكم في مكانين. */
  app.get("/api/delivery/eta", async (c) => {
    const m = await ready();
    if (!m) return c.json({ ok: false, error: "model_unavailable", detail: lastError }, 503);
    const e = estimate(m, { km: c.req.query("km") });
    /* العميل مايحتاجش يعرف عدد العيّنة ولا رقم اللقطة — `why` للوحة بس. */
    const { why, ...pub } = e;
    return c.json({ ...pub, modelVersion: m.version });
  });

  /* إدارة — الموديل كله مكشوف: الجدول، العيّنة، التقييم الداخلي والخارجي،
     وأسباب منع العرض. ده اللي عمر بيفتحه عشان يقول «الرقم ده جابه منين». */
  app.get("/api/delivery/eta/model", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (c.req.query("refresh") === "1") { try { await rebuild(); } catch (e) { lastError = e.message; } }
    const m = await ready();
    if (!m) return c.json({ ok: false, error: "model_unavailable", detail: lastError }, 503);
    return c.json({ ok: true, model: m, lastError });
  });

  /* إدارة — «لو العميل ده طلب دلوقتي، هيشوف إيه ولـيه». صف واحد لكل خانة
     عشان المالك يشوف السلّم كله في نظرة، مش رقم واحد معزول. */
  app.get("/api/delivery/eta/explain", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const m = await ready();
    if (!m) return c.json({ ok: false, error: "model_unavailable", detail: lastError }, 503);
    const km = c.req.query("km");
    return c.json({
      ok: true, modelVersion: m.version, showToCustomer: m.showToCustomer, reasons: m.reasons,
      asked: km != null ? estimate(m, { km }) : null,
      ladder: KM_BANDS.map((b) => ({ band: b.id, label: b.label, ...estimate(m, { km: (b.from + Math.min(b.to, b.from + 4)) / 2 }) })),
      unknownLocation: estimate(m, {}),
    });
  });

  return { ready, rebuild, estimate: (input) => (snapshot ? estimate(snapshot, input) : null), renderPromise, model: () => snapshot };
}
