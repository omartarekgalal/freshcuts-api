/* ═══════════════════════════════════════════════════════════════════════════
   surge.js — بروتوكول «ضاعف ثم رجّع» جوّه اليوم

   ده مش بديل للـ pacer اللي في autopilot.js — ده الطبقة اللي فوقه. الـ pacer
   بيمشي بخطوة ١٥٪ عشان ميصفّرش تعلّم ميتا. الحساب بتاع المالك بيقول إن خطوة
   ١٥٪ متأخر اليوم مش بتحرّك فلوس أصلاً، والقياس أثبت إنه على حق:

   ── الدليل (٨ أغسطس ١٢ / ١٣ / ١٤ ٢٠٢٦، act_210662083554074) ──────────────

   ١) ١٢ أغسطس — تسع خطوات ١٥٪ على fc-prospect-asc من ٥٠ لـ١١٥ ر.س/يوم
      (١٥:٠٠ → ٢٢:٤٨ بتوقيت جدة)، كل خطوة معاها pause/resume.
      الصرف بالساعة: 3.52 4.42 4.29 4.70 4.04 3.94 4.27 4.20 5.32
      الميزانية ×٢٫٣ → الصرف ×١٫٠. صفر استجابة.

   ٢) ١٣ أغسطس — أربع خطوات ١٥٪ من ٨٠ لـ١٥٩، كل ساعة، كل واحدة بـ pause/resume.
      الصرف بالساعة: 3.64 0.60 4.44 4.61 5.90 5.45 7.19 9.49
      الميزانية ×٢٫٠ → الصرف ×١٫٥ بعد ٦ ساعات. استجابة ضعيفة ومتأخرة.

   ٣) ١٤ أغسطس — قفزة واحدة ٨٠ → ٣٥٠ (×٤٫٤) الساعة ١٢:١٣، وبعدين إيد مرفوعة.
      الصرف بالساعة: 5.49 | 10.21 27.18 16.96 14.13 12.06 12.09 10.68
      وبعيّنة كل ١٥ دقيقة (ر.س/ساعة):
        ١٢:١٣–١٢:٣٤   1.7   ← الهبوط: −٦٩٪، مدته ~٢١ دقيقة
        ١٢:٣٤–١٢:٤٩   7.6   ← عدّى خط الأساس خلاص (T+٣٦ دقيقة)
        ١٢:٤٩–١٣:٣٤  21.6 → 28.2  ← ×٤ إلى ×٥
        بعد الخفض لـ٢٤٥:  11–15 ثابت  ← ×٢٫٢ من خط الأساس

      تكلفة الهبوط ≈ ٢٫١ ر.س صرف ضايع. مكسب أول ساعة بعده ≈ +٢١٫٧ ر.س.
      يعني البروتوكول بيسدّد نفسه ١٠:١ في ٩٠ دقيقة.

   ── القانون اللي طلع من الداتا ────────────────────────────────────────────

   الاستجابة مش نسبة مئوية — هي **مقدار الزيادة مقسوم على ساعات يوم الحساب
   الفاضلة**، مضروبة في معامل تعجيل قِسناه على الحساب ده:

       Δ(صرف/ساعة) ≈ SURGE_K × Δ(ميزانية) ÷ (ساعات يوم الحساب الفاضلة)

   تحقّق القانون على الحالتين:
     • ١٢ أغسطس ٢١:٤٣ — Δ=١٣ ر.س، فاضل ١٢٫٣ ساعة → متوقّع +١٫٤ ر.س/ساعة.
       ودي تحت مستوى الضوضاء، وفعلاً محدش شافها. الخطوة الصغيرة **مش فشلت،
       هي اشتغلت بالظبط بمقدارها — والمقدار كان تافه**.
     • ١٤ أغسطس ١٢:١٣ — Δ=٢٧٠ ر.س، فاضل ٢١٫٨ ساعة → متوقّع +١٦٫١ ر.س/ساعة.
       المقيس بعد ما استقرّ: +١٤٫٥ إلى +١٦٫٥. مطابق.

   يعني الخلاف كله كان سوء فهم: مفيش "خطوة صغيرة مابتسحبش" ولا "قفزة كبيرة
   بتسحب". فيه **ريالات مطلقة على ساعات فاضلة**. والنسبة المئوية مقياس غلط
   لإنها بتخفي المقام.

   ── ومرحلة التعلّم اللي بنحميها؟ ──────────────────────────────────────────

   قِسناها من learning_stage_info مباشرة (١٤ أغسطس ١٩:١٥):
     fc-sales-broad-8km   LEARNING · ٠ تحويل · آخر تعديل جوهري ٧ أغسطس ١٢:٣٦
     → سبع أيام وسبع ساعات من غير ما حد يلمسها، وصرفت ٣٦٨ ر.س، ولسه في
       التعلّم عند صفر من خمسين. **دي مرحلة تعلّم مقفولة مش مرحلة بتتحمى.**
     fc-prospect-asc-broad-12km  LEARNING · ٢    fc-leads-broad-8km  LEARNING · ١
     fc-prospect-lal-3pct        LEARNING · ٠    fc-sales-ic-broad-8km LEARNING · ٢
     fc-rt-warm-30d              LEARNING · ٩  ← أقربهم، ولسه بعيد
     fc-wa-walkin-5km            مفيش learning_stage_info أصلاً (CONVERSATIONS)

   ست من سبع مجموعات نشطة مش هتخرج من التعلّم بالميزانية دي. الحاجة اللي
   بنحميها بخطوة الـ١٩٪ **مش موجودة عندهم**. اللي بندفعه فعلاً مقابل التعديل
   هو إعادة التوزيع المؤقتة بس — وقِسناها: ~٢١ دقيقة و~٢ ر.س.
═══════════════════════════════════════════════════════════════════════════ */

/* معامل التعجيل: ميتا بتصرف أسرع من التوزيع المسطّح (١/٢٤ في الساعة) لإنها
   بتقدّم الصرف قدّام وبتسمح لحد ١٢٥٪ من اليومي مع تسوية أسبوعية. القيمة دي
   متقاسة على الحساب ده مش مفترضة: asc عند ٣٥٠ صرفت ٢٠٫٥ ر.س/ساعة مستقرّة
   (المسطّح ١٤٫٦) = ١٫٤٠ · وعند ٢٤٥ صرفت ١٣٫٣ (المسطّح ١٠٫٢) = ١٫٣٠ ·
   leads-broad عند ٩٠ صرفت ٦٫٠ (المسطّح ٣٫٧٥) = ١٫٦٠. */
export const SURGE_K = 1.35;

export const SURGE_DEFAULTS = {
  enabled: true,

  /* ── إمتى نضاعف ──────────────────────────────────────────────────────
     مش بدري: قبل ما الدخل يتجمّع السقف المستحق بيمنع أي مضاعفة أصلاً.
     ومش متأخر: أي ريال بعد ١:٠٠ بيقع في ساعات مفيهاش بيع. */
  firstSurgeHour: 17,          // أول ساعة رياض مسموح فيها بمضاعفة
  lastSurgeHour: 23,           // آخر ساعة — بعدها الاسترجاع بس
  restoreHour: 3,              // نرجّع الأساس هنا (المطبخ بيقفل ٤)

  /* ── قد إيه نضاعف ────────────────────────────────────────────────── */
  minMultiple: 2.0,            // أقل من كده مش مضاعفة، ده تدرّج مموّه
  maxMultiple: 3.0,            // فوق كده بنشتري نفس المزاد أغلى مش ناس جداد
  maxConcurrentSurges: 2,      // مجموعتين بالكتير — التركيز هو الميزة كلها
  minDeliveryEfficiencyPct: 45,// أقل نسبة من الزيادة لازم تقع في ساعات بيع

  /* ── مين نضاعف: عتبات نسبة الامتلاء ───────────────────────────────
     fill = (صرف الساعة) ÷ (الميزانية اليومية ÷ ٢٤).
     مقيسة على الحساب: asc 1.30 · leads-broad 1.60 · wa-walkin 1.85
     (كلهم مخنوقين بالميزانية) مقابل rt-warm 0.75 و rt-hot 0.20
     (مخنوقين بالجمهور — دول مش هيصرفوا زيادة مهما رفعت). */
  pinnedFill: 1.15,            // ≥ كده = مخنوق بالميزانية → مرشّح للمضاعفة
  throttledFill: 0.60,         // < كده = مخنوق بالعرض → المضاعفة هتضيع
  minSamples: 2,               // لازم عيّنتين متتاليتين، مش لقطة واحدة

  /* ── الحكم بعد المضاعفة ───────────────────────────────────────────── */
  graceMinutes: 75,            // مفيش حكم قبل كده — الهبوط بيسبق المكسب
  verdictMinutes: 150,         // أول حكم حقيقي (٢٫٥ ساعة مش ساعتين)
  badCostMultiple: 2.0,        // تكلفة الحدث > ٢× المستهدف = وحش
  badDeliveryFill: 0.70,       // ولا حتى ملى ٧٠٪ من الميزانية الجديدة = فشل توصيل
};

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const r2 = (x) => Math.round(num(x) * 100) / 100;

/* ── نسبة الامتلاء ────────────────────────────────────────────────────
   الرقم الوحيد اللي بيفرّق بين مجموعة مخنوقة بالميزانية (المضاعفة هتشتغل)
   ومجموعة مخنوقة بالجمهور أو بحدث نادر (المضاعفة هتتبخّر). */
export function fillRatio({ hourlySpend, dailyBudget }) {
  const b = num(dailyBudget);
  if (b <= 0) return null;
  return r2(num(hourlySpend) / (b / 24));
}

/* ── تصنيف المجموعة في الوقت الحقيقي ──────────────────────────────────
   `samples` = عيّنات الصرف التراكمي بترتيب زمني: [{ atMin, cum }]
   (بالظبط اللي المسجّل بيكتبه كل ١٥ دقيقة في spend-log.tsv).

   بيرجّع class:
     "pinned"    → مخنوق بالميزانية، ضاعفه
     "pacing"    → ماشي طبيعي، الزيادة هتاخد جزء منها بس
     "throttled" → مخنوق بالعرض، أي زيادة هتفضل ورق
     "cold"      → مفيش صرف يُذكر، مش مرشّح لأي حاجة */
export function classifyAdset({ samples = [], dailyBudget, s = SURGE_DEFAULTS } = {}) {
  const cfg = { ...SURGE_DEFAULTS, ...s };
  const pts = samples.filter((p) => Number.isFinite(num(p.atMin, NaN)) && Number.isFinite(num(p.cum, NaN)));
  if (pts.length < cfg.minSamples + 1) {
    return { class: "unknown", fill: null, trend: null,
      why: `محتاجين ${cfg.minSamples + 1} عيّنات على الأقل، عندنا ${pts.length}.` };
  }
  const rates = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = (num(pts[i].atMin) - num(pts[i - 1].atMin)) / 60;
    if (dt <= 0) continue;
    rates.push(r2((num(pts[i].cum) - num(pts[i - 1].cum)) / dt));
  }
  if (!rates.length) return { class: "unknown", fill: null, trend: null, why: "مفيش فترات صالحة بين العيّنات." };

  const recent = rates.slice(-cfg.minSamples);
  const hourly = r2(recent.reduce((a, b) => a + b, 0) / recent.length);
  const fill = fillRatio({ hourlySpend: hourly, dailyBudget });
  const trend = rates.length >= 2 ? r2(rates[rates.length - 1] - rates[0]) : 0;

  if (fill == null) return { class: "unknown", fill: null, trend, hourly, why: "الميزانية اليومية مش معروفة." };
  if (hourly < 0.5) {
    return { class: "cold", fill, trend, hourly,
      why: `بتصرف ${hourly} ر.س/ساعة بس — دي مش مخنوقة، دي واقفة. المضاعفة مش هتصحّيها.` };
  }
  if (fill >= cfg.pinnedFill) {
    return { class: "pinned", fill, trend, hourly,
      why: `بتصرف ${hourly} ر.س/ساعة مقابل ${r2(num(dailyBudget) / 24)} توزيع مسطّح — نسبة امتلاء ${fill}. دي ملزوقة في سقف ميزانيتها، الزيادة هتتصرف.` };
  }
  if (fill < cfg.throttledFill) {
    return { class: "throttled", fill, trend, hourly,
      why: `نسبة الامتلاء ${fill} — المجموعة دي مش لاقية مزاد تصرف فيه ميزانيتها الحالية أصلاً (جمهور صغير أو حدث نادر). زيادة الميزانية هتفضل رقم على الورق.` };
  }
  return { class: "pacing", fill, trend, hourly,
    why: `نسبة الامتلاء ${fill} — ماشية في حدود التوزيع الطبيعي. الزيادة هتاخد منها جزء مش كلها.` };
}

/* ── هل مرحلة التعلّم أصلاً قابلة للخروج؟ ──────────────────────────────
   ميتا بتطلب ٥٠ حدث تحسين في ٧ أيام. يعني أرضية الميزانية لأي مجموعة =
   تكلفة الحدث × ٥٠ ÷ ٧. لو الأرضية دي فوق اللي المطعم يقدر يدفعه، يبقى
   مفيش تعلّم بنحميه، وتكلفة التصفير = تكلفة إعادة التوزيع بس. */
export function learningViability({ costPerEvent, eventsPer7d = null, affordableDaily = null }) {
  const c = num(costPerEvent, NaN);
  const need = 50 / 7; // ٧٫١٤ حدث في اليوم
  if (!Number.isFinite(c) || c <= 0) {
    return { exitable: false, floorBudget: null, needPerDay: r2(need),
      why: "مفيش حدث واحد اتسجّل، فتكلفة الحدث لا نهائية — الخروج من التعلّم مستحيل عند أي ميزانية." };
  }
  const floorBudget = Math.ceil(c * need);
  const observed = eventsPer7d == null ? null : r2(num(eventsPer7d) / 7);
  const affordable = affordableDaily == null ? true : floorBudget <= num(affordableDaily);
  const exitable = affordable && (observed == null || observed >= need * 0.8);
  return {
    exitable, floorBudget, needPerDay: r2(need), observedPerDay: observed,
    why: exitable
      ? `تكلفة الحدث ${r2(c)} ر.س → أرضية ${floorBudget} ر.س/يوم عشان تجيب ٥٠ حدث في ٧ أيام. الخروج ممكن، فتصفير التعلّم هنا ليه تمن حقيقي.`
      : `تكلفة الحدث ${r2(c)} ر.س → محتاج ${floorBudget} ر.س/يوم للمجموعة الواحدة عشان تخرج من التعلّم${observed != null ? `، والمقيس ${observed} حدث/يوم مقابل ${r2(need)} مطلوب` : ""}. مفيش تعلّم بنحميه هنا — التصفير مجاني عملياً.`,
  };
}

/* ── التوقّع: قد إيه الزيادة دي هتحرّك فعلاً؟ ───────────────────────────
   ده القانون اللي قِسناه، ومكتوب هنا عشان أي مضاعفة تتحاسب قبل ما تتنفّذ.
   `sellingHoursLeft` = ساعات المطبخ الفاضلة (لحد ٤:٠٠)، و`accountHoursLeft`
   = ساعات يوم الحساب الإعلاني الفاضلة (لحد ١٠:٠٠ بتوقيت جدة). */
export function projectLift({ fromBudget, toBudget, accountHoursLeft, sellingHoursLeft, k = SURGE_K }) {
  const d = num(toBudget) - num(fromBudget);
  const ah = Math.max(0.25, num(accountHoursLeft));
  const sh = Math.max(0, num(sellingHoursLeft));
  const perHour = r2((k * d) / ah);
  const efficiency = ah > 0 ? Math.round((Math.min(sh, ah) / ah) * 100) : 0;
  return {
    deltaBudget: r2(d),
    liftPerHour: perHour,
    totalExtraSpend: r2(perHour * ah),
    sellingExtraSpend: r2(perHour * Math.min(sh, ah)),
    deliveryEfficiencyPct: efficiency,
    why: `زيادة ${r2(d)} ر.س على ${r2(ah)} ساعة يوم حساب فاضلة → +${perHour} ر.س/ساعة. منها ${efficiency}٪ بس بتقع والمطعم فاتح (${r2(sh)} ساعة بيع)، يعني ${r2(perHour * Math.min(sh, ah))} ر.س صرف مفيد و${r2(perHour * Math.max(0, ah - sh))} ر.س بتتصرف على ساعات مفيهاش طلبات.`,
  };
}

/* ── القرار: نضاعف ولا لأ ─────────────────────────────────────────────
   بيرجّع { ok, multiple, to, projection, why }. لو ok=false السبب مكتوب. */
export function planSurge({
  name, dailyBudget, baseBudget = null, classification,
  riyadhHour, accountHoursLeft, sellingHoursLeft,
  ceilingHeadroom, openSurges = 0, learning = null, s = SURGE_DEFAULTS,
}) {
  const cfg = { ...SURGE_DEFAULTS, ...s };
  const base = num(baseBudget ?? dailyBudget);
  const cur = num(dailyBudget);
  const deny = (why) => ({ ok: false, name, multiple: null, to: null, projection: null, why });

  if (!cfg.enabled) return deny("البروتوكول مقفول من الإعدادات.");
  if (riyadhHour < cfg.firstSurgeHour && !(riyadhHour <= cfg.restoreHour))
    return deny(`الساعة ${riyadhHour} بدري على المضاعفة — قبل ${cfg.firstSurgeHour} الدخل لسه ما تجمّعش والسقف المستحق مش هيسمح.`);
  if (riyadhHour > cfg.lastSurgeHour && riyadhHour > cfg.restoreHour)
    return deny(`الساعة ${riyadhHour} متأخرة — أي زيادة دلوقتي هتقع في ساعات مفيهاش بيع.`);
  if (openSurges >= cfg.maxConcurrentSurges)
    return deny(`فيه ${openSurges} مضاعفة مفتوحة خلاص — التركيز هو الميزة، والمضاعفة التالتة بتوزّع نفس الفلوس تاني.`);
  if (cur > base * 1.05)
    return deny(`"${name}" ميزانيتها ${r2(cur)} فوق أساسها ${r2(base)} — دي مرفوعة خلاص، رجّعها الأول.`);
  if (!classification || classification.class !== "pinned")
    return deny(`"${name}" تصنيفها "${classification?.class || "غير معروف"}" مش "pinned". ${classification?.why || ""}`);

  /* أقصى مضاعفة يسمح بيها السقف المستحق */
  const head = num(ceilingHeadroom, 0);
  if (head <= base * (cfg.minMultiple - 1))
    return deny(`المساحة تحت السقف ${r2(head)} ر.س، والمضاعفة ×${cfg.minMultiple} محتاجة ${r2(base * (cfg.minMultiple - 1))} ر.س. السقف هو اللي بيمنع مش القاعدة.`);

  const byCeiling = 1 + head / Math.max(1, base);
  const multiple = Math.min(cfg.maxMultiple, Math.max(cfg.minMultiple, Math.floor(byCeiling * 10) / 10));
  const to = Math.round(base * multiple);
  const projection = projectLift({ fromBudget: base, toBudget: to, accountHoursLeft, sellingHoursLeft });

  if (projection.deliveryEfficiencyPct < cfg.minDeliveryEfficiencyPct)
    return deny(`${projection.deliveryEfficiencyPct}٪ بس من الزيادة هتقع في ساعات بيع (الحد ${cfg.minDeliveryEfficiencyPct}٪). ${projection.why}`);

  const learnNote = learning && learning.exitable
    ? ` تحذير: دي المجموعة الوحيدة اللي ليها طريق حقيقي للخروج من التعلّم (أرضية ${learning.floorBudget} ر.س/يوم) — التصفير هنا ليه تمن، فمتضاعفهاش غير لو المكسب المتوقّع فوق ٣× التمن ده.`
    : learning ? ` ${learning.why}` : "";

  return {
    ok: true, name, multiple: r2(multiple), from: r2(base), to, projection,
    why: `"${name}" ${classification.why} ${projection.why}${learnNote}`,
  };
}

/* ── الحكم بعد المضاعفة ────────────────────────────────────────────────
   المالك قال «لو وحشة ننزّلها بعد ساعتين». ساعتين قصيرة: الهبوط المقيس
   بياخد ~٢١ دقيقة، والاستقرار بياخد ~٣ ساعات. الحكم قبل ٧٥ دقيقة بيقيس
   الهبوط مش النتيجة. عشان كده في مرحلتين. */
export function judgeSurge({
  minutesSince, hourlySpendNow, newBudget, costPerEvent = null, targetCpa = null,
  events = 0, s = SURGE_DEFAULTS,
}) {
  const cfg = { ...SURGE_DEFAULTS, ...s };
  const fill = fillRatio({ hourlySpend: hourlySpendNow, dailyBudget: newBudget });
  const m = num(minutesSince);

  if (m < cfg.graceMinutes) {
    return { verdict: "hold", fill,
      why: `عدّى ${Math.round(m)} دقيقة بس من المضاعفة. الهبوط المقيس على الحساب ده بياخد ~٢١ دقيقة والتعافي لحد ~٤٥ دقيقة — أي حكم قبل ${cfg.graceMinutes} دقيقة بيقيس الهبوط نفسه مش نتيجة القرار.` };
  }

  /* فشل توصيل: الفلوس مانزلتش أصلاً. ده أوضح سبب للرجوع. */
  if (fill != null && fill < cfg.badDeliveryFill) {
    return { verdict: "revert", reason: "delivery", fill,
      why: `بعد ${Math.round(m)} دقيقة نسبة الامتلاء ${fill} — الميزانية الجديدة مش بتتصرف أصلاً. المضاعفة دي رقم على الورق، رجّع الأساس واقفل الموضوع.` };
  }

  if (m < cfg.verdictMinutes) {
    return { verdict: "hold", fill,
      why: `التوصيل شغّال (امتلاء ${fill}) بس لسه بدري على حكم التكلفة — مستنيين ${cfg.verdictMinutes} دقيقة عشان الأحداث تتجمّع.` };
  }

  /* حكم التكلفة */
  const cpa = num(costPerEvent, NaN);
  const tgt = num(targetCpa, NaN);
  if (Number.isFinite(cpa) && Number.isFinite(tgt) && tgt > 0) {
    if (cpa > tgt * cfg.badCostMultiple) {
      return { verdict: "revert", reason: "cost", fill, cpa: r2(cpa),
        why: `بعد ${Math.round(m)} دقيقة تكلفة الحدث ${r2(cpa)} ر.س مقابل مستهدف ${r2(tgt)} — فوق ${cfg.badCostMultiple}× المسموح. التوصيل اشتغل بس بسعر وحش، رجّع الأساس.` };
    }
    return { verdict: "keep", fill, cpa: r2(cpa),
      why: `تكلفة الحدث ${r2(cpa)} ر.س تحت ${cfg.badCostMultiple}× المستهدف والامتلاء ${fill} — سيبها لحد ساعة الاسترجاع.` };
  }

  /* مفيش تكلفة نحكم بيها — نحكم بالتوصيل بس، وبنقولها صريح */
  if (events <= 0) {
    return { verdict: "revert", reason: "no-events", fill,
      why: `بعد ${Math.round(m)} دقيقة الفلوس اتصرفت (امتلاء ${fill}) ومفيش حدث واحد اتسجّل. صرف من غير إشارة مش توسّع، رجّع الأساس.` };
  }
  return { verdict: "keep", fill,
    why: `التوصيل شغّال (امتلاء ${fill}) و${events} حدث اتسجّل، بس مفيش تكلفة مستهدفة نقارن بيها — الحكم ده على التوصيل بس مش على الربح.` };
}

/* ── الاسترجاع ────────────────────────────────────────────────────────
   دي أهم دالة في الملف. مضاعفة يدوية ما اترجّعتش بتبقى أساس بكرة من غير ما
   حد ياخد باله — وده قرّب يحصل هنا فعلاً. القاعدة: الاسترجاع مش حدث،
   الاسترجاع **حالة**. أي ميزانية أعلى من أساسها بعد ساعة الاسترجاع = دَين. */
export function dueRestores({ surges = [], riyadhHour, minutesToAccountRoll, s = SURGE_DEFAULTS }) {
  const cfg = { ...SURGE_DEFAULTS, ...s };
  const out = [];
  const preRoll = num(minutesToAccountRoll, 1e9) <= 45;
  const pastRestoreHour = riyadhHour >= cfg.restoreHour && riyadhHour < cfg.firstSurgeHour;

  for (const x of surges) {
    const cur = num(x.currentBudget);
    const base = num(x.baseBudget);
    if (cur <= base * 1.02) continue; // مرجّعة خلاص
    const overdue = pastRestoreHour || preRoll;
    out.push({
      name: x.name, platform: x.platform, campaignId: x.campaignId, level: x.level || "campaign",
      from: r2(cur), to: r2(base), overdue,
      why: overdue
        ? `"${x.name}" لسه على ${r2(cur)} ر.س وأساسها ${r2(base)} — ${preRoll ? "يوم الحساب هيلف خلال ٤٥ دقيقة" : `عدّينا ساعة الاسترجاع ${cfg.restoreHour}:٠٠`}. لو مارجعتش دلوقتي الرقم ده بيبقى أساس بكرة من غير ما حد قرّره.`
        : `"${x.name}" مرفوعة لـ${r2(cur)} فوق أساس ${r2(base)} — الاسترجاع مستحق الساعة ${cfg.restoreHour}:٠٠.`,
    });
  }
  return out;
}

/* ── أرضية الميزانية لهيكل من الصفر ──────────────────────────────────
   تكلفة الحدث × ٥٠ ÷ ٧. الدالة دي هي اللي بتقول لك كام مجموعة إعلانية
   تقدر تشيلهم بميزانيتك — مش الذوق. */
export function structureFloor({ dailyBudget, events = [] }) {
  const rows = events.map((e) => {
    const v = learningViability({ costPerEvent: e.costPerEvent, eventsPer7d: e.eventsPer7d, affordableDaily: dailyBudget });
    return { event: e.name, costPerEvent: r2(e.costPerEvent), floorBudget: v.floorBudget, exitable: v.exitable, why: v.why };
  });
  const viable = rows.filter((r) => r.exitable && r.floorBudget);
  const cheapest = viable.length ? Math.min(...viable.map((r) => r.floorBudget)) : null;
  const maxAdsets = cheapest ? Math.floor(num(dailyBudget) / cheapest) : 0;
  return {
    rows, cheapestFloor: cheapest, maxViableAdsets: maxAdsets,
    why: cheapest
      ? `أرخص حدث قابل للخروج من التعلّم محتاج ${cheapest} ر.س/يوم للمجموعة. بميزانية ${r2(dailyBudget)} ر.س ده معناه ${maxAdsets} مجموعة إعلانية بالكتير — أي مجموعة زيادة بتاخد من نصيب اللي قبلها وبتخلّيهم كلهم عالقين في التعلّم.`
      : `مفيش حدث واحد في القايمة دي ليه أرضية يقدر عليها الحساب — أي هيكل هيفضل في التعلّم بالكامل.`,
  };
}
