/* ═══════════════════════════════════════════════════════════════════════════
   REPORTS — «عايز كمان تقارير شاملة»

   صاحب المطعم مش محلل بيانات. بيفتح الموبايل، عايز يعرف في دقيقة: بعنا كام،
   ليه، وأعمل إيه. الملف ده مش بيحسب رقم جديد — بيجمّع الأرقام اللي محسوبة
   أصلاً في باقي الموديولات، بيوفّق بينها، وبيقولها بلغة بني آدم.

   ── القاعدة الأولى: مفيش رقم مخترع ولا مصنفر ──────────────────────────────
   أي حاجة مش قادرين نحسبها بتترجع «غير متاح» ومعاها السبب. رقم غلط شكله
   معقول أخطر بكتير من فراغ مكتوب عليه إنه فراغ. الحاجات اللي فعلاً مش
   متاحة دلوقتي (وبتتقال بصوت عالي في `unavailable`):
     • تيك توك — التوكن ناقصه صلاحية /report/integrated/get، يعني مفيش صرف
       ولا انطباعات ولا نقرات منها. مش صفر — مش معروف.
     • جوجل — مش مربوطة أصلاً (ناقص developer token وباقي بيانات OAuth).
     • تحويلات المنصات على البيع اللي بيتقفل على الكاشير — المنصة نفسها
       مش بتنسبه لحملة، فبيرجع صفر عندها وده متوقّع مش عطل.

   ── القاعدة التانية: قول حدود اليوم ─────────────────────────────────────
   في أربع ساعات مختلفة بيلف عندها اليوم في المنظومة دي:
     • TabSense (كل أرقام المبيعات والعملاء) — يوم المطعم بيلف ٤ الفجر بجدة.
     • حساب ميتا الإعلاني — America/Los_Angeles، يعني يومه بيلف ١٠ صباحاً بجدة.
     • تيك توك وجوجل — GMT+3، نفس يوم جدة تقريباً.
   يعني «صرفنا ١٬٩٠٠ ر.س الأسبوع ده» و«بعنا ١٥٬٠٠٠ ر.س الأسبوع ده» مش
   مقصوصين على نفس اللحظة بالظبط. الفرق صغير على مدى أسبوع وكبير على مدى
   يوم واحد — عشان كده كل تقرير بيرجع `boundaries` وبيقولها بالنص، وتقرير
   اليوم الواحد بيحذّر إن أرقام الإعلانات ممكن تبقى ليوم ميتا مش يوم المطعم.

   ── القاعدة التالتة: مفيش كوبونات ─────────────────────────────────────────
   المالك شال أكواد العروض خالص. مفيش أي رقم كوبون في التقرير ده، ومفيش
   استخدام promo.* من الإسناد حتى لو الحقل لسه راجع.

   ENDPOINTS
     GET /api/reports/summary?period=day|week|month&date=YYYY-MM-DD
     GET /api/reports/weekly?date=YYYY-MM-DD        (نفس التقرير بشكل أسبوعي)
     GET /api/reports/summary.csv?…                 (نفس الأرقام مسطّحة)
═══════════════════════════════════════════════════════════════════════════ */

const RIYADH_TZ = "Asia/Riyadh";
const BIZ_DAY_START_HOUR = 4;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const pct1 = (v) => (v == null ? null : Math.round(num(v) * 1000) / 10);
const ar = (n) => new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(Math.round(num(n)));
const ar1 = (n) => new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 1 }).format(num(n));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => typeof v === "string" && DAY_RE.test(v);
const shiftDay = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const spanDays = (from, to) =>
  Math.max(1, Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1);

const DOW_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const dowOf = (iso) => DOW_AR[new Date(iso + "T00:00:00Z").getUTCDay()];

/* اليوم الحالي بقاعدة يوم المطعم (٤ الفجر بجدة) — محسوب في JS عشان الدالة
   دي بتتنده قبل أي استعلام. Riyadh = UTC+3 ثابت، مفيش توقيت صيفي. */
function bizToday() {
  const t = Date.now() + 3 * 3600_000 - BIZ_DAY_START_HOUR * 3600_000;
  return new Date(t).toISOString().slice(0, 10);
}

const PERIOD_AR = { day: "يوم", week: "أسبوع", month: "شهر" };

/* ── الشباك والمقارنة ─────────────────────────────────────────────────────
   • يوم   → اليوم نفسه، والمقارنة بنفس يوم الأسبوع الفات (مش بامبارح: مبيعات
             المطعم بتتغير بالأسبوع، ومقارنة الجمعة بالخميس بتكذب).
   • أسبوع → ٧ أيام منتهية في `date`، والمقارنة بالـ ٧ اللي قبلها.
   • شهر   → ٣٠ يوم منتهية في `date`، والمقارنة بالـ ٣٠ اللي قبلها.        */
function resolveRange(period, date) {
  const end = isDay(date) ? date : bizToday();
  const len = period === "day" ? 1 : period === "month" ? 30 : 7;
  const from = shiftDay(end, -(len - 1));
  const cmp = period === "day"
    ? { from: shiftDay(from, -7), to: shiftDay(end, -7), label: `نفس اليوم الأسبوع اللي فات (${dowOf(shiftDay(end, -7))})` }
    : { from: shiftDay(from, -len), to: shiftDay(from, -1), label: period === "month" ? "الـ ٣٠ يوم اللي قبلها" : "الأسبوع اللي قبله" };
  return {
    period, from, to: end, days: len,
    label: period === "day" ? `${dowOf(end)} ${end}` : `${from} → ${end}`,
    partial: end >= bizToday(),
    compare: cmp,
  };
}

export function register(app, ctx, deps = {}) {
  const { requireAdmin } = ctx;
  const analytics = deps.analytics || null;         // { periodKpis, channelsData, deliveryApps }
  const attribution = deps.attribution || null;     // { overviewData }
  const autopilot = deps.autopilot || null;         // { economicsData, logData }
  // `adsApi` مش `ads`: جوّه buildReport فيه كتلة اسمها `ads` بتتبني للتقرير،
  // والاسمين لو اتساوا الـ const الجوّاني بيعمل TDZ على الخارجاني — وكشف
  // المنصات بيرجع «Cannot access 'ads' before initialization» بدل الأرقام.
  const adsApi = deps.ads || null;                  // { scorecardData }
  const trackingApi = deps.tracking || null;        // { healthData }
  const funnelApi = deps.funnel || null;            // { funnelStats }

  /* لو موديول وقع، التقرير بيكمّل والقسم بتاعه بيتكتب «غير متاح» بالسبب.
     تقرير ناقص قسم أحسن من تقرير مبيوظ كله عشان منصة رجّعت خطأ. */
  const soft = async (label, fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, error: String(e?.message || e), label }; }
  };

  /* ═══ الفنل ════════════════════════════════════════════════════════════
     الخطوات بالترتيب، وكل خطوة بتقول كام واحد وصل ليها وكام ضاع قبلها.
     الشراء بييجي من أحداث الموقع بس — البيع اللي بيتقفل على الكاشير مش
     جزء من الفنل ده وبيتقال صراحة عشان محدش يقرا الصفر غلط. */
  const FUNNEL_STEPS = [
    { id: "PageView", label: "فتح الموقع" },
    { id: "ViewContent", label: "بصّ على صنف" },
    { id: "AddToCart", label: "حطّ في السلة" },
    { id: "InitiateCheckout", label: "بدأ يطلب" },
    { id: "Purchase", label: "كمّل الطلب" },
  ];

  function shapeFunnel(stats) {
    const by = Object.fromEntries((stats?.events || []).map((e) => [e.event_name, num(e.n)]));
    const contact = num(by.Contact);
    const lead = num(by.Lead);
    let prev = null;
    const steps = FUNNEL_STEPS.map((s) => {
      const n = num(by[s.id]);
      const lost = prev == null ? 0 : Math.max(0, prev - n);
      const dropPct = prev > 0 ? Math.round((lost / prev) * 1000) / 10 : null;
      const row = { id: s.id, label: s.label, count: n, lost, dropPct };
      prev = n;
      return row;
    });
    /* اختيار «أكبر تسريب» فيه حكم، والحكم ده مكتوب:
       • الأساس: أكتر خطوة ضاع فيها ناس بالعدد — ٩٠٪ من عشرة مش مشكلة.
       • الاستثناء: خطوة ضاع فيها **الكل** (١٠٠٪) ومعاها عدد معتبر، دي مش
         تسريب — دي خطوة مكسورة. حد ما كمّلش ولا مرة واحدة معناه إن الخطوة
         مش شغالة أصلاً، وده كلام مختلف عن «الناس بتزهق». فبتكسب الترشيح. */
    const rest = steps.slice(1);
    const dead = rest.find((s) => s.dropPct === 100 && s.lost >= 20);
    const leak = dead || rest.reduce((best, s) => (best == null || s.lost > best.lost ? s : best), null);
    const from = steps[steps.findIndex((s) => s.id === leak?.id) - 1] || null;
    return {
      basis: stats?.basis || null,
      firstEventAt: stats?.firstEventAt || null,
      // pg بيرجّع timestamptz كـ Date، و String(Date) بيطلع "Thu Aug 06 …" —
      // فالقص على ١٠ حروف كان بيدّي "Thu Aug 06" بدل التاريخ.
      coverageNote: stats?.firstEventAt
        ? `تتبع الموقع بدأ يسجّل يوم ${new Date(stats.firstEventAt).toISOString().slice(0, 10)} — أي فترة قبل التاريخ ده مالهاش أرقام فنل، ومش صفر.`
        : null,
      broken: dead ? {
        step: dead.label, entered: dead.lost,
        sentence: `${ar(dead.lost)} شخص وصلوا لخطوة «${dead.label}» وولا واحد كمّلها. صفر مش نسبة ضعيفة — الخطوة نفسها مش شغالة.`,
      } : null,
      steps,
      sideExits: [
        { id: "Contact", label: "ضغط واتساب/اتصال بدل ما يكمّل أونلاين", count: contact },
        { id: "Lead", label: "ساب بياناته", count: lead },
      ],
      biggestLeak: leak && from ? {
        from: from.label, to: leak.label, lost: leak.lost, dropPct: leak.dropPct,
        sentence: `أكبر تسريب بين «${from.label}» و«${leak.label}»: ${ar(leak.lost)} شخص وقفوا هناك (${ar1(leak.dropPct)}٪).`,
      } : null,
      note: "دي أحداث الموقع (order.o2m8.me) بس. البيع اللي بيتقفل على الكاشير جوّه المطعم مالوش أثر في الفنل ده — فصفر «كمّل الطلب» معناه صفر طلب أونلاين، مش صفر مبيعات.",
    };
  }

  /* ═══ الأولويات ════════════════════════════════════════════════════════
     مش انطباعات. كل بند تحت له حد رقمي مكتوب، ولو الحد ما اتعداش البند مش
     بيتولد أصلاً. ولو مفيش ولا بند اتولد، التقرير بيقول «مفيش حاجة محتاجة
     تدخّلك» بدل ما يخترع تلاتة عشان الخانة ما تفضلش فاضية. */
  const T = {
    adsShareSlack: 1.15,     // الصرف يتعدى قاعدة المالك بـ ١٥٪ قبل ما يتحول لأولوية
    paidRoasFloor: 1.0,      // عائد أقل من ١x = بنشتري خسارة
    paidRoasMinSpend: 300,   // تحت كده الرقم ضجيج مش حكم
    newCustomerGap: 0.6,     // بنجيب أقل من ٦٠٪ من المطلوب يومياً
    revenueDrop: -0.10,      // المبيعات نزلت ١٠٪ أو أكتر
    apFailures: 10,          // عدد القرارات اللي المنصة رفضت تنفيذها
    trackRejectPct: 5,       // نسبة أحداث الويب المرفوضة
    funnelLeakPeople: 50,    // أقل عدد ناس يخلي التسريب يستاهل الكلام
    funnelLeakPct: 60,
  };

  function buildPriorities(d) {
    const out = [];
    const push = (p) => out.push(p);

    /* ٠) المطبخ قافل والإعلانات شغالة — أغلى سطر في الصفحة
       ده الرقم الوحيد اللي بيتقرا من المنصة نفسها مش من جدولنا. يوم ١١
       أغسطس فضلت أربع حملات على ميتا شغالة من ٣ الفجر لـ ١٠ الصبح لإن
       ٣٣٧ أمر إيقاف اترفض، ومحدش عرف غير لما حد فتح السجل بإيده. */
    const dp = d.daypart;
    if (dp && dp.tone === "bad" && num(dp.mismatchCount) > 0) {
      const closed = dp.window && dp.window.open === false;
      push({
        severity: closed ? 99 : 72,
        tone: "bad",
        title: closed ? "المطبخ قافل والإعلانات لسه شغالة" : "المطعم فاتح والإعلانات لسه موقوفة",
        number: `${ar(dp.mismatchCount)} حملة حالتها على المنصة مش زي ما النافذة بتقول`,
        why: dp.line,
        action: closed
          ? "الإعلان اللي بيشتغل والمطبخ قافل بيتحوّل لطلب محدش هيرد عليه — الصرف بيروح والعميل بيتضايق. صلّح سبب الرفض اللي فوق الأول، وبعدين اضغط «افحص النافذة دلوقتي» في صفحة الطيار عشان تتأكد بنفسك."
          : "الحملات مش راجعة مع فتح المطعم — يعني بنخسر ساعات البيع الحقيقية. افحص النافذة من صفحة الطيار.",
        source: "autopilot/daypart-verify",
      });
    }

    /* ٠ب) منصة بترفض الكتابة بشكل متكرر — السبب اللي بيخلي اللي فوق يحصل */
    for (const a of d.writeAlerts || []) {
      push({
        severity: a.severity === "bad" ? 88 : 58,
        tone: a.severity === "bad" ? "bad" : "warn",
        title: a.title,
        number: `${ar(a.count)} أمر مرفوض في ٢٤ ساعة`,
        why: a.text,
        action: a.blockedForMinutes
          ? `الطيار قافل الباب على المنصة دي ${ar(a.blockedForMinutes)} دقيقة عشان مايستهلكش الحد اللي محتاجه. لو الرفض بيتكرر كل يوم فالمشكلة في صلاحية الحساب مش في الطيار.`
          : "افتح صفحة الطيار — نص رد المنصة بالحرف موجود هناك، وهو اللي بيقول إذا كانت مشكلة صلاحيات ولا حد نداءات.",
        source: "ap_decisions/24h",
      });
    }

    /* ١) الإعلانات كنسبة من المبيعات — الرقم اللي المالك بيسوق بيه */
    const share = d.ads?.shareOfSalesPct;
    const rule = d.ads?.rulePct;
    if (share != null && rule > 0 && share > rule * T.adsShareSlack) {
      push({
        severity: Math.min(100, 60 + Math.round((share - rule) * 2)),
        tone: "bad",
        title: "الإعلانات بتاكل من المبيعات أكتر من قاعدتك",
        number: `${ar1(share)}٪ من المبيعات — قاعدتك ${ar(rule)}٪`,
        why: `صرفنا ${ar(d.ads.spend)} ر.س على الإعلانات مقابل ${ar(d.sales.revenue)} ر.س مبيعات في نفس الفترة.`,
        action: `نزّل السقف اليومي لحد ${ar((d.sales.revenue / d.range.days) * (rule / 100))} ر.س، أو وقّف الحملة الأضعف لحد ما المبيعات تلحق.`,
        source: "attribution + analytics",
      });
    }

    /* ٢) عائد الإعلانات المدفوعة الحقيقي (paid.roas — مش المخلوط) */
    const roas = d.attribution?.paid?.roas;
    const paidSpend = num(d.attribution?.paid?.spend);
    if (roas != null && paidSpend >= T.paidRoasMinSpend && roas < T.paidRoasFloor) {
      push({
        severity: Math.min(100, 55 + Math.round((T.paidRoasFloor - roas) * 30)),
        tone: "bad",
        title: "الإعلانات المدفوعة بترجّع أقل مما بتاخد",
        number: `كل ريال إعلان رجّع ${ar1(roas)} ريال مبيعات مؤكدة`,
        why: `${ar(paidSpend)} ر.س صرف على القنوات المدفوعة قابله ${ar(d.attribution.paid.revenue)} ر.س إيراد قدرنا نثبت إنه جاي منها. الرقم ده أرضية مش سقف — البيع اللي بيتقفل كاش على الكاشير من غير رقم جوال مش داخل فيه.`,
        action: "قبل ما تزوّد أي ميزانية: خلّي الكاشير يسأل «عرفتنا منين؟» على كل طلب. من غير ده مش هنعرف الرقم الحقيقي أبداً.",
        source: "attribution.totals.paid",
      });
    }

    /* ٣) العملاء الجدد مقابل المطلوب يومياً */
    const now = d.customers?.newPerDay, need = d.customers?.neededPerDaySteady;
    if (now != null && need > 0 && now < need * T.newCustomerGap) {
      push({
        severity: Math.min(100, 50 + Math.round((1 - now / need) * 40)),
        tone: "warn",
        title: "العملاء الجدد أقل من اللي الهدف محتاجه",
        number: `${ar1(now)} عميل جديد في اليوم — المطلوب ${ar(need)}`,
        why: `عشان توصل ${ar(d.customers.goalDailySales)} ر.س في اليوم بقيمة عميل ${ar(d.customers.ltv)} ر.س، محتاج ${ar(need)} عميل جديد كل يوم. بنجيب ${ar1(now)}.`,
        action: `الفرق ${ar(Math.max(0, Math.ceil(need - now)))} عميل في اليوم. ده مش هيتقفل بميزانية أكبر لوحدها — لازم عرض يخلي الزيارة الأولى أسهل، وسبب يخلي العميل يرجع تاني.`,
        source: "autopilot/economics",
      });
    }

    /* ٤) المبيعات نزلت مقارنة بالفترة اللي قبلها */
    const dRev = d.sales?.delta?.revenue;
    if (dRev != null && dRev <= T.revenueDrop) {
      push({
        severity: Math.min(100, 45 + Math.round(Math.abs(dRev) * 100)),
        tone: "bad",
        title: "المبيعات نزلت عن الفترة اللي قبلها",
        number: `${ar1(Math.abs(dRev * 100))}٪ نزول`,
        why: `${ar(d.sales.revenue)} ر.س مقابل ${ar(d.sales.previous.revenue)} ر.س في ${d.range.compare.label}.`,
        action: "بصّ على تفصيل القنوات تحت — لو النزول من تطبيق توصيل بعينه فالمشكلة عنده مش في المطعم.",
        source: "analytics/compare",
      });
    }

    /* ٥) الطيار بيحاول والمنصة بترفض */
    const failed = num(d.autopilot?.counts?.failed);
    if (failed >= T.apFailures) {
      push({
        severity: Math.min(100, 50 + Math.round(failed / 4)),
        tone: "bad",
        title: "الطيار الآلي بيصدر أوامر والمنصة بترفضها",
        number: `${ar(failed)} أمر اترفض في الفترة دي`,
        why: d.autopilot.topFailure
          ? `أكتر سبب متكرر: ${d.autopilot.topFailure}`
          : "المنصة بترفض تنفيذ أوامر الإيقاف/التشغيل.",
        action: "ده معناه إن الإعلانات ممكن تفضل شغالة والمطعم قافل. جدّد صلاحيات التوكن للمنصة المرفوضة، والطيار هيرجع يشتغل من غير أي تغيير تاني.",
        source: "ap_decisions",
      });
    }

    /* ٦) التتبع — النسبة بتتقاس لكل منصة على حدة. منصة بترفض ١٠٪ من
          أحداثها بتختفي جوّه متوسط عام لو حسبناها كلها مع بعض. */
    const worst = d.tracking?.worstPlatform;
    if (worst && worst.rejectPct >= T.trackRejectPct && worst.sent >= 50) {
      push({
        severity: Math.min(100, 40 + Math.round(worst.rejectPct)),
        tone: "warn",
        title: `${worst.label}: جزء من الأحداث بيترفض`,
        number: `${ar1(worst.rejectPct)}٪ من أحداث ${worst.label} اترفضت (${ar(worst.rejected)} من ${ar(worst.sent)})`,
        why: worst.lastError ? `آخر رد من المنصة: ${worst.lastError}` : "المنصة بترفض جزء من الأحداث المرسلة.",
        action: "كل حدث مرفوض معناه إن المنصة مش شايفة عميل — والحملة بتتعلم على داتا ناقصة. صفحة 📡 التتبع فيها نص الخطأ بالحرف.",
        source: "tracking/health",
      });
    }

    /* ٧) خطوة مكسورة على الموقع — الكل وصل ومحدش كمّل */
    const broken = d.funnel?.broken;
    if (broken) {
      push({
        severity: 88,
        tone: "bad",
        title: `مفيش ولا طلب اكتمل على الموقع`,
        number: `${ar(broken.entered)} شخص وصلوا لـ«${broken.step}» وصفر كمّلوا`,
        why: broken.sentence,
        action: "افتح order.o2m8.me من موبايلك واطلب طلب حقيقي لحد آخر خطوة. لو الطلب اتم يبقى التتبع هو المكسور؛ لو ما اتمّش يبقى الموقع — وفي الحالتين كل ريال بيتصرف على إعلانات بتودّي هناك ضايع.",
        source: "funnel/stats",
      });
    }

    /* ٨) تسريب عادي — بالعدد الحقيقي مش بالنسبة لوحدها */
    const leak = d.funnel?.biggestLeak;
    if (!broken && leak && leak.lost >= T.funnelLeakPeople && num(leak.dropPct) >= T.funnelLeakPct) {
      push({
        severity: Math.min(100, 35 + Math.round(leak.dropPct / 3)),
        tone: "warn",
        title: "ناس كتير بتقف في نفس الخطوة على الموقع",
        number: `${ar(leak.lost)} شخص وقفوا عند «${leak.to}»`,
        why: leak.sentence,
        action: `افتح «${leak.to}» من موبايلك وجرّبها بنفسك مرة واحدة. أغلب التسريبات في الخطوة دي بتبان من أول تجربة.`,
        source: "funnel/stats",
      });
    }

    out.sort((a, b) => b.severity - a.severity);
    const top = out.slice(0, 3).map((p, i) => ({ rank: i + 1, ...p }));
    return {
      items: top,
      considered: out.length,
      empty: top.length === 0,
      emptyNote: "مفيش حاجة عدّت حدود التنبيه في الفترة دي. مش معناها إن كل حاجة ممتازة — معناها إن مفيش رقم اتخطى الحد اللي يستاهل يقطع يومك.",
      thresholds: T,
    };
  }

  /* ═══ التجميعة ═════════════════════════════════════════════════════════ */
  async function buildReport(period, date) {
    const range = resolveRange(period, date);
    const { from, to } = range;
    const cmp = range.compare;
    const unavailable = [];

    // قايمة وسائل دفع تطبيقات التوصيل بتتجاب مرة واحدة وبتتشارك على
    // الاستعلامين — نفس القايمة بالظبط، عشان الفترة والمقارنة يتقاسوا بنفس
    // المسطرة.
    const need = (mod, name, label) => {
      const fn = mod && mod[name];
      if (typeof fn !== "function") throw new Error(`${label} مش مربوط في هذه النسخة`);
      return fn;
    };
    const apps = await (analytics?.deliveryApps ? analytics.deliveryApps() : []);

    const [kpisR, prevKpisR, chanR, econR, attR, scoreR, trackR, funR, logR] = await Promise.all([
      soft("مبيعات الفترة", () => need(analytics, "periodKpis", "التحليلات")(from, to, apps)),
      soft("مبيعات الفترة السابقة", () => need(analytics, "periodKpis", "التحليلات")(cmp.from, cmp.to, apps)),
      soft("تفصيل القنوات", () => need(analytics, "channelsData", "التحليلات")(from, to, period === "day" ? "lastweek" : "prev")),
      soft("اقتصاديات العميل", () => need(autopilot, "economicsData", "الطيار")(from, to)),
      soft("الإسناد", () => need(attribution, "overviewData", "الإسناد")(from, to)),
      soft("كشف المنصات", () => need(adsApi, "scorecardData", "الإعلانات")(from, to)),
      soft("صحة التتبع", () => need(trackingApi, "healthData", "التتبع")(Math.min(90, Math.max(1, range.days)))),
      soft("الفنل", () => need(funnelApi, "funnelStats", "الفنل")({ from, to })),
      soft("سجل الطيار", () => need(autopilot, "logData", "الطيار")({ from, to, limit: 120 })),
    ]);

    /* هل نافذة الإعلانات متنفّذة فعلاً على المنصات، وهل في رفض متكرر؟
       بره الـ Promise.all اللي فوق عن قصد: دول بيضربوا المنصات، ولو فشلوا
       مايصحّش يمنعوا باقي التقرير. */
    const [dpR, alertsR] = await Promise.all([
      soft("تنفيذ نافذة الإعلانات", () => need(autopilot, "verifyDaypart", "الطيار")({})),
      soft("رفض المنصات لأوامر الطيار", () => need(autopilot, "writeFailureAlerts", "الطيار")()),
    ]);
    const daypartVerdict = dpR.value || null;
    const writeAlerts = alertsR.value || [];

    const kpis = kpisR.value || null;
    const prevKpis = prevKpisR.value || null;
    const chan = chanR.value || null;
    const econ = econR.value || null;
    const att = attR.value || null;
    const score = scoreR.value || null;
    const track = trackR.value || null;
    const fun = funR.value || null;
    const log = logR.value || null;

    for (const r of [kpisR, prevKpisR, chanR, econR, attR, scoreR, trackR, funR, logR, dpR, alertsR]) {
      if (!r.ok) unavailable.push({ what: r.label, why: r.error });
    }

    /* ── المبيعات ─────────────────────────────────────────────────────── */
    const delta = (cur, base) => (base == null || num(base) === 0 ? null : r2((num(cur) - num(base)) / num(base)));
    const daily = kpis?.daily || [];
    const trend = (() => {
      if (daily.length < 4) return null;
      const half = Math.floor(daily.length / 2);
      const a = daily.slice(0, half).reduce((s, x) => s + num(x.revenue), 0) / half;
      const b = daily.slice(-half).reduce((s, x) => s + num(x.revenue), 0) / half;
      if (a === 0) return null;
      const ch = (b - a) / a;
      return {
        changePct: r2(ch * 100),
        direction: ch > 0.05 ? "up" : ch < -0.05 ? "down" : "flat",
        sentence: ch > 0.05 ? "آخر أيام الفترة أحسن من أولها"
          : ch < -0.05 ? "آخر أيام الفترة أضعف من أولها"
          : "المبيعات ماشية على نفس المستوى داخل الفترة",
      };
    })();

    const best = daily.length ? daily.reduce((m, x) => (num(x.revenue) > num(m.revenue) ? x : m)) : null;
    const worst = daily.length ? daily.reduce((m, x) => (num(x.revenue) < num(m.revenue) ? x : m)) : null;

    const deliveryApps = (chan?.channels || []).filter((c) => c.isDelivery);
    const sales = kpis ? {
      revenue: r2(kpis.revenue),
      orders: num(kpis.orders),
      avgTicket: r2(kpis.avgOrder),
      inhouse: { orders: num(kpis.inhouseOrders), revenue: r2(kpis.inhouseRevenue) },
      deliveryApps: {
        orders: num(kpis.deliveryOrders), revenue: r2(kpis.deliveryRevenue),
        share: kpis.deliveryShare,
        byApp: deliveryApps.map((c) => ({
          id: c.id, label: c.label, orders: c.orders, revenue: c.revenue,
          avgTicket: c.avgOrder, deltaRevenue: c.delta?.revenue ?? null,
        })),
      },
      discount: r2(kpis.discount),
      previous: prevKpis ? {
        revenue: r2(prevKpis.revenue), orders: num(prevKpis.orders), avgTicket: r2(prevKpis.avgOrder),
        inhouseRevenue: r2(prevKpis.inhouseRevenue), deliveryRevenue: r2(prevKpis.deliveryRevenue),
      } : null,
      delta: prevKpis ? {
        revenue: delta(kpis.revenue, prevKpis.revenue),
        orders: delta(kpis.orders, prevKpis.orders),
        avgTicket: delta(kpis.avgOrder, prevKpis.avgOrder),
        inhouseRevenue: delta(kpis.inhouseRevenue, prevKpis.inhouseRevenue),
        deliveryRevenue: delta(kpis.deliveryRevenue, prevKpis.deliveryRevenue),
      } : null,
      daily, trend,
      bestDay: best ? { day: best.day, dow: dowOf(best.day), revenue: r2(best.revenue) } : null,
      worstDay: worst ? { day: worst.day, dow: dowOf(worst.day), revenue: r2(worst.revenue) } : null,
      note: "«تطبيقات التوصيل» = طلبات External أو مدفوعة بمحفظة تطبيق. توصيل المطعم بسواقه محسوب مع «داخل المطعم» — مفيش عمولة عليه ولا تطبيق وراه.",
    } : null;

    /* ── العملاء ──────────────────────────────────────────────────────── */
    const e = econ?.economics || null;
    const customers = e ? {
      newCustomers: num(econ.window?.newCustomers),
      returningCustomers: num(econ.window?.returningCustomers),
      totalCustomers: num(econ.window?.customers),
      newPerDay: e.newPerDayNow,
      neededPerDaySteady: e.neededPerDaySteady,
      gapPerDay: e.gapPerDay,
      goalDailySales: e.goalDailySales,
      ltv: e.ltv,
      ltvNote: econ.observation?.note || null,
      ltvWindows: econ.ltvWindows || null,
      repeatRate: e.repeatRate,
      repeatRateNote: "نسبة العملاء المعروفين اللي طلبوا مرتين أو أكتر على مدى عمرهم كله — مش داخل الفترة دي بس.",
      avgTicketLifetime: e.aov,
      identifiedCoveragePct: econ.window?.coveragePct ?? null,
      coverageNote: econ.window?.coverageNote || null,
      newVsPrevious: prevKpis ? delta(kpis?.newCustomers, prevKpis.newCustomers) : null,
      retargeting: {
        segments: (econ.retarget?.segments || []).map((s) => ({ id: s.id, label: s.label, size: s.size })),
        totalHeld: (econ.retarget?.segments || []).find((s) => s.id === "all")?.size ?? null,
        reachedOnPlatforms: num(econ.retarget?.reached) || 0,
        note: "«محفوظين عندنا» غير «وصلوا للمنصة». المنصة بتطابق الأرقام عندها وبترفض اللي مالهاش حساب، فالرقم اللي بيوصل دايماً أقل.",
      },
    } : null;

    /* ── الإعلانات ────────────────────────────────────────────────────── */
    const scoreRows = score?.rows || [];
    const spendTotal = num(score?.totals?.spend ?? att?.totals?.paid?.spend);
    const salesRev = num(kpis?.revenue);
    const rulePct = num(econ?.budgetRule?.sharePct) || 20;
    const shareOfSales = salesRev > 0 ? r2((spendTotal / salesRev) * 100) : null;

    // كل منصة مش راجعة برقم بتتكتب هنا بالسبب بالحرف بتاع المنصة نفسها.
    const blocked = { ...(score?.reasons || {}), ...(att?.reasons || {}) };
    for (const [pid, why] of Object.entries(blocked)) {
      unavailable.push({
        what: pid === "tiktok" ? "أرقام تيك توك (صرف/انطباعات/نقرات)"
          : pid === "google" ? "أرقام جوجل"
          : `أرقام ${pid}`,
        why,
      });
    }

    const paidNew = num(att?.totals?.paid?.newCustomers);
    const ads = {
      spend: r2(spendTotal),
      spendPerDay: r2(spendTotal / range.days),
      shareOfSalesPct: shareOfSales,
      rulePct,
      withinRule: shareOfSales == null ? null : shareOfSales <= rulePct,
      allowedTodayCeiling: econ?.budgetRule?.ceiling ?? null,
      ceilingReason: econ?.budgetRule?.reason || null,
      impressions: num(score?.totals?.impressions),
      clicks: num(score?.totals?.clicks),
      platforms: scoreRows.map((r) => ({
        id: r.platform, label: r.label,
        spend: r.spend, impressions: r.impressions, clicks: r.clicks,
        ctr: r.ctr, cpc: r.cpc, campaigns: r.campaigns,
        platformConversions: r.platformConversions,
        platformNote: r.platformNote,
        confirmedConversions: r.confirmedConversions,
        confirmedRevenue: r.confirmedRevenue,
        newCustomers: r.newCustomers,
        costPerConfirmed: r.costPerConfirmed,
        confidence: r.confidence,
      })),
      // «تكلفة العميل الجديد» ليها رقمين وبينهم الحقيقة. عرض واحد لوحده كذب.
      costPerNewCustomer: {
        attributed: e?.measuredCac ?? null,
        attributedCount: paidNew,
        blended: e?.blendedCac ?? null,
        blendedCount: num(kpis?.newCustomers),
        allowed: e?.allowedCac ?? null,
        range: e?.cacRange ?? null,
        note: "الرقم المسند بيقسم الصرف على العملاء اللي أثبتنا بالجوال إنهم جم من قناة مدفوعة — وهو أعلى من الحقيقة لأن أغلب البيع كاش بلا رقم. الرقم المخلوط بيقسمه على كل عميل جديد دخل المطعم — وهو أقل من الحقيقة. الحد المسموح محسوب من قاعدة الـ ٢٠٪ على قيمة العميل.",
      },
      lead: {
        total: num(att?.totals?.paid?.leads),
        note: "«عميل محتمل» هنا = ضغطة واتساب أو نموذج على الموقع جاية من إعلان. مش طلب.",
      },
    };

    /* ── الإسناد ──────────────────────────────────────────────────────── */
    const attrib = att ? {
      rows: (att.rows || []).map((r) => ({
        channel: r.channel, label: r.label, kind: r.kind,
        spend: r.spend?.total ?? 0, spendSource: r.spend?.source || "مفيش",
        leads: r.leadsTotal, orders: r.orders, revenue: r.revenue,
        newCustomers: r.newCustomers, returningCustomers: r.returningCustomers,
        roas: r.roas, cpa: r.cpa, avgOrder: r.avgOrder,
        confidence: r.confidence, confidenceNote: r.confidenceNote,
        breakdown: {
          linked: r.confidenceBreakdown?.linked ?? 0,
          pos: r.confidenceBreakdown?.pos ?? 0,
          tagged: r.confidenceBreakdown?.tagged ?? 0,
          guessed: r.confidenceBreakdown?.guessed ?? 0,
        },
      })),
      paid: {
        spend: att.totals?.paid?.spend ?? 0,
        revenue: att.totals?.paid?.revenue ?? 0,
        orders: att.totals?.paid?.orders ?? 0,
        newCustomers: paidNew,
        roas: att.totals?.paid?.roas ?? null,
        cpa: att.totals?.paid?.cpa ?? null,
        label: "عائد الإعلانات الحقيقي — ده الرقم اللي يتبني عليه قرار.",
      },
      blended: {
        roas: att.totals?.blendedRoas ?? null,
        cpa: att.totals?.blendedCpa ?? null,
        label: "مبيعات المطعم كلها ÷ صرف الإعلانات. رقم متابعة إداري بس — أغلب الإيراد ده جاي من قنوات مالهاش صرف، فممنوع يتقري كعائد إعلان.",
      },
      tiers: [
        { id: "مؤكد", meaning: "مطابقة رقم جوال أو تصنيف النظام نفسه (زي طلب تطبيق توصيل)." },
        { id: "مرجّح", meaning: "الكاشير صنّف الطلب بإيده — معتمد على ذاكرة العميل." },
        { id: "تقديري", meaning: "محسوب بالاستبعاد. مفيش دليل، ده أحسن تخمين." },
      ],
      coverage: att.coverage || null,
      instoreTruth: "الشراء اللي بيتقفل على الكاشير بيتبعت للمنصات بـ action_source = physical_store. ده الوصف الصح للبيع، ونتيجته إن المنصة بتقبل الحدث بس **مبتنسبهوش لحملة بعينها** زي ما بتعمل مع شراء على الموقع. عشان كده «تحويلات المنصة» بتقرا صفر رغم الصرف — ده متوقّع مش عطل، والعمود اللي جنبه (التحويلات المؤكدة) هو دليلنا إحنا.",
    } : null;

    /* ── التتبع ───────────────────────────────────────────────────────── */
    let tr = null;
    if (track) {
      const cells = track.web?.cells || [];
      const sent = cells.reduce((a, c) => a + num(c.sent7d), 0);
      const rejected = cells.reduce((a, c) => a + num(c.rejected7d), 0);
      const byPlat = {};
      for (const c of cells) {
        const p = (byPlat[c.platform] ||= { id: c.platform, label: c.platformAr || c.platform, sent: 0, accepted: 0, rejected: 0, lastError: null });
        p.sent += num(c.sent7d); p.accepted += num(c.accepted7d); p.rejected += num(c.rejected7d);
        if (c.lastError && !p.lastError) p.lastError = c.lastError;
      }
      for (const c of track.offline?.cells || []) {
        const p = (byPlat[c.platform] ||= { id: c.platform, label: c.platformAr || c.platform, sent: 0, accepted: 0, rejected: 0, lastError: null });
        p.offlineSent = (p.offlineSent || 0) + num(c.sent7d);
        p.offlineRejected = (p.offlineRejected || 0) + num(c.rejected7d);
        if (c.lastError && !p.lastError) p.lastError = c.lastError;
      }
      const ident = track.web?.identity || null;
      /* نسبة الرفض لكل منصة على حدة، وبتحسب الويب والأوفلاين مع بعض: منصة
         بتقبل كل أحداث الويب وبترفض تلت الشراء الأوفلاين مش «سليمة». */
      const plats = Object.values(byPlat).map((p) => {
        const allSent = p.sent + (p.offlineSent || 0);
        const allRej = p.rejected + (p.offlineRejected || 0);
        return {
          ...p,
          totalSent: allSent, totalRejected: allRej,
          rejectPct: allSent > 0 ? r2((allRej / allSent) * 100) : null,
          verdict: allSent === 0 ? "مفيش داتا"
            : allRej > 0 ? "بيوصل بس فيه مرفوض"
            : "بيوصل سليم",
        };
      });
      const worst = plats
        .filter((p) => p.totalSent >= 50 && p.rejectPct != null)
        .sort((a, b) => b.rejectPct - a.rejectPct)[0] || null;
      tr = {
        healthy: !!track.healthy,
        problems: track.problems || [],
        firstProblem: (track.problems || [])[0] || null,
        rejectPct: sent > 0 ? r2((rejected / sent) * 100) : null,
        worstPlatform: worst ? {
          id: worst.id, label: worst.label, rejectPct: worst.rejectPct,
          rejected: worst.totalRejected, sent: worst.totalSent, lastError: worst.lastError,
        } : null,
        platforms: plats,
        matchQuality: ident ? {
          events: ident.total, withPhone: ident.withPhone,
          withPhonePct: ident.total > 0 ? r2((ident.withPhone / ident.total) * 100) : null,
          note: "من غير رقم جوال المنصة مش بتقدر تربط الحدث بعميل — وده اللي بيخلي الإسناد ضعيف مش الحملة.",
        } : null,
        metaAcknowledgement: track.metaAcknowledgement || null,
        catalog: track.catalog ? {
          items: track.catalog.items, matchRate: track.catalog.matchRate,
          metaProductCount: track.catalog.meta?.productCount ?? null,
        } : null,
      };
    }

    /* ── الطيار ───────────────────────────────────────────────────────── */
    let apc = null;
    if (log) {
      const entries = log.entries || [];
      const counts = { total: entries.length, done: 0, failed: 0, pending: 0, info: 0 };
      const failReasons = new Map();
      for (const x of entries) {
        if (x.outcome === "تم") counts.done++;
        else if (x.outcome === "فشل" || x.outcome === "اترفض") {
          counts.failed++;
          const m = /المنصة رفضت التنفيذ:\s*([^)]*)/.exec(x.why || "");
          const key = (m ? m[1] : x.why || "").trim().slice(0, 80);
          if (key) failReasons.set(key, (failReasons.get(key) || 0) + 1);
        } else if (x.pending) counts.pending++;
        else counts.info++;
      }
      const top = [...failReasons.entries()].sort((a, b) => b[1] - a[1])[0] || null;
      apc = {
        counts,
        topFailure: top ? `${top[0]} (${ar(top[1])} مرة)` : null,
        // القرارات اللي فعلاً حصلت — الملاحظات المكرّرة مش قرارات.
        decisions: entries.filter((x) => x.outcome !== "للعلم").slice(0, 25),
        notes: entries.filter((x) => x.outcome === "للعلم").slice(0, 8),
        types: log.types || null,
        tz: log.tz || RIYADH_TZ,
      };
    }

    /* ── الفنل ────────────────────────────────────────────────────────── */
    const funnelOut = fun ? shapeFunnel(fun) : null;

    const draft = {
      range, sales, customers, ads, attribution: attrib, funnel: funnelOut,
      tracking: tr, autopilot: apc,
      // حالة نافذة الإعلانات زي ما المنصات قالتها، مش زي ما جدولنا فاكر.
      daypart: daypartVerdict,
      writeAlerts,
    };
    const priorities = buildPriorities({
      range,
      sales: sales || { revenue: 0, previous: {}, delta: null },
      customers: customers || {},
      ads,
      attribution: attrib || {},
      tracking: tr || {},
      autopilot: apc || {},
      funnel: funnelOut || {},
      daypart: daypartVerdict || {},
      writeAlerts,
    });

    return {
      generatedAt: new Date().toISOString(),
      period: range.period,
      periodLabel: PERIOD_AR[range.period],
      ...draft,
      priorities,
      unavailable,
      boundaries: {
        sales: `يوم المطعم في TabSense بيلف الساعة ${BIZ_DAY_START_HOUR}:00 صباحاً بتوقيت جدة — طلب الساعة ١:٣٠ بالليل محسوب على اليوم اللي قبله. كل أرقام المبيعات والعملاء فوق مقصوصة على الحد ده.`,
        meta: "حساب ميتا الإعلاني بتوقيت America/Los_Angeles — يومه بيلف الساعة ١٠ صباحاً بتوقيت جدة. يعني «صرف ميتا» في الفترة دي مقصوص على يوم ميتا مش يوم المطعم.",
        others: "تيك توك وجوجل بتوقيت GMT+3 — نفس يوم جدة تقريباً (بيلف ١٢ بالليل مش ٤ الفجر).",
        crossPlatform: range.period === "day"
          ? "⚠️ ده تقرير يوم واحد: فرق حدود اليوم بين المطعم وميتا (٦ ساعات) ممكن ينقل صرف من يوم للتاني. النسبة المئوية للصرف من المبيعات على مستوى اليوم تقريبية — على مستوى الأسبوع الفرق بيختفي."
          : "على مدى أسبوع أو شهر فرق حدود اليوم بين المنصات بيتلاشى، فمقارنة الصرف بالمبيعات هنا سليمة.",
      },
      notes: [
        "كل مبلغ شامل الضريبة — نفس الرقم اللي على الفاتورة.",
        "الطلبات الملغية والمرتجعة مستبعدة من كل رقم.",
        "«عميل جديد» = طلب داخل الفترة وعمره ما طلب قبلها. تعريف واحد مستعمل في كل شاشات النظام.",
        "مفيش أكواد خصم في التقرير ده — الكوبونات اتشالت من التسويق خالص.",
      ],
    };
  }

  /* ═══ ROUTES ═══════════════════════════════════════════════════════════ */
  const PERIODS = new Set(["day", "week", "month"]);

  app.get("/api/reports/summary", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const p = String(c.req.query("period") || "week").toLowerCase();
    const period = PERIODS.has(p) ? p : "week";
    try {
      return c.json({ ok: true, ...(await buildReport(period, c.req.query("date"))) });
    } catch (ex) {
      console.error("[reports] summary failed:", ex.message);
      return c.json({ ok: false, error: String(ex.message || ex) }, 500);
    }
  });

  /* نفس التقرير، مقفول على أسبوع، ومعاه سطر افتتاحي جاهز للقراءة بصوت عالي. */
  app.get("/api/reports/weekly", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const rep = await buildReport("week", c.req.query("date"));
      const s = rep.sales, d = s?.delta?.revenue;
      const dir = d == null ? null : d > 0.02 ? "فوق" : d < -0.02 ? "تحت" : "زي";
      rep.headline = s ? {
        sentence: `الأسبوع من ${rep.range.from} لـ ${rep.range.to}: ${ar(s.revenue)} ر.س من ${ar(s.orders)} طلب، متوسط الفاتورة ${ar(s.avgTicket)} ر.س`
          + (dir ? ` — ${dir === "زي" ? "زي الأسبوع اللي فات تقريباً" : `${ar1(Math.abs(d * 100))}٪ ${dir} الأسبوع اللي فات`}.` : "."),
        revenue: s.revenue, orders: s.orders, avgTicket: s.avgTicket,
        newCustomers: rep.customers?.newCustomers ?? null,
        adSpend: rep.ads?.spend ?? null,
        adsShareOfSalesPct: rep.ads?.shareOfSalesPct ?? null,
      } : null;
      return c.json({ ok: true, ...rep });
    } catch (ex) {
      console.error("[reports] weekly failed:", ex.message);
      return c.json({ ok: false, error: String(ex.message || ex) }, 500);
    }
  });

  /* CSV — عمر بيحوّل الحاجات لناس. صف لكل رقم، مفيش تداخل جداول، و BOM في
     الأول عشان إكسل يقرا العربي صح بدل ما يطلّعه رموز. */
  app.get("/api/reports/summary.csv", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const p = String(c.req.query("period") || "week").toLowerCase();
    const period = PERIODS.has(p) ? p : "week";
    const rep = await buildReport(period, c.req.query("date"));
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [["القسم", "البند", "القيمة", "ملاحظة"]];
    const add = (sec, k, v, n = "") => rows.push([sec, k, v == null ? "غير متاح" : v, n]);

    add("الفترة", "من", rep.range.from);
    add("الفترة", "إلى", rep.range.to);
    add("الفترة", "المقارنة", `${rep.range.compare.from} → ${rep.range.compare.to}`, rep.range.compare.label);
    if (rep.sales) {
      add("المبيعات", "الإيراد (ر.س)", rep.sales.revenue);
      add("المبيعات", "عدد الطلبات", rep.sales.orders);
      add("المبيعات", "متوسط الفاتورة (ر.س)", rep.sales.avgTicket);
      add("المبيعات", "داخل المطعم (ر.س)", rep.sales.inhouse.revenue);
      add("المبيعات", "تطبيقات التوصيل (ر.س)", rep.sales.deliveryApps.revenue);
      for (const a of rep.sales.deliveryApps.byApp) add("المبيعات", `تطبيق: ${a.label} (ر.س)`, a.revenue, `${a.orders} طلب`);
      add("المبيعات", "التغيّر عن الفترة السابقة", rep.sales.delta?.revenue == null ? null : `${r2(rep.sales.delta.revenue * 100)}%`);
    }
    if (rep.customers) {
      add("العملاء", "عملاء جدد", rep.customers.newCustomers);
      add("العملاء", "عملاء راجعين", rep.customers.returningCustomers);
      add("العملاء", "جدد في اليوم", rep.customers.newPerDay);
      add("العملاء", "المطلوب في اليوم", rep.customers.neededPerDaySteady);
      add("العملاء", "قيمة العميل (ر.س)", rep.customers.ltv);
      add("العملاء", "نسبة التكرار %", rep.customers.repeatRate);
      add("العملاء", "محفوظين في الريتارجتنج", rep.customers.retargeting?.totalHeld);
    }
    add("الإعلانات", "الصرف (ر.س)", rep.ads?.spend);
    add("الإعلانات", "٪ من المبيعات", rep.ads?.shareOfSalesPct, `القاعدة ${rep.ads?.rulePct}%`);
    for (const pl of rep.ads?.platforms || []) {
      add("الإعلانات", `${pl.label} — صرف`, pl.spend);
      add("الإعلانات", `${pl.label} — انطباعات`, pl.impressions);
      add("الإعلانات", `${pl.label} — نقرات`, pl.clicks);
      add("الإعلانات", `${pl.label} — تحويلات مؤكدة`, pl.confirmedConversions, pl.confidence);
    }
    add("الإسناد", "عائد الإعلانات المدفوعة (x)", rep.attribution?.paid?.roas);
    add("الإسناد", "العائد المخلوط (x)", rep.attribution?.blended?.roas, "رقم إداري — مش عائد إعلان");
    for (const s of rep.funnel?.steps || []) add("الفنل", s.label, s.count, s.dropPct == null ? "" : `تسرّب ${s.dropPct}%`);
    add("التتبع", "الحالة", rep.tracking?.healthy ? "سليم" : "فيه مشاكل", `${rep.tracking?.problems?.length || 0} مشكلة`);
    for (const pr of rep.priorities?.items || []) add("الأولويات", `${pr.rank}. ${pr.title}`, pr.number, pr.action);
    for (const u of rep.unavailable || []) add("غير متاح", u.what, "غير متاح", u.why);

    const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="freshcuts-report-${rep.range.from}_${rep.range.to}.csv"`,
      },
    });
  });

  console.log("[reports] routes ready");
  return { buildReport };
}

export default { register };
