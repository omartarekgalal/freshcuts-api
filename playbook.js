/* ═══════════════════════════════════════════════════════════════════════════
   PLAYBOOK — what we learned running ads for the store, as DATA the autopilot
   reads (strategist + agent prompts, rules notes) and the dashboard shows.

   Omar, 19/9: «بعد ما جمعنا معلومات كتير اوي نظمها وغذي بيها الطيار عشان
   يشتغل مظبوط باستراتيجيات كويسة لان اليوم محتاج يشتغل من اوله».

   Sources (docs/growth-2026-09 in the dashboard repo): 00 plan, 01 paid ads,
   03 CRO funnel, 06 audit, 09 creative+CRO (the ad-judging table), the ads
   guard (/home/omar/apps/fc96/guard.mjs) and the daily reports 17–18/9.

   ⚠️ The GUARD stays the executor of hours/cap/pacing/scale. The autopilot is
   in SUGGEST mode: everything derived here becomes a note or a proposed
   decision in the approval queue — never a direct platform write.
   Change a number here → redeploy; the prompt and the rules follow.
═══════════════════════════════════════════════════════════════════════════ */

export const PLAYBOOK_VERSION = "2026-09-19";

export const PLAYBOOK = {
  business: {
    goal: "٢٠٠ طلب موقع في اليوم (freshcuts.sa) — العميل الجديد هو عنق الزجاجة، التشغيل جاهز",
    store: "متجر أونلاين حقيقي بدفع إلكتروني (MyFatoorah: مدى/فيزا/Apple Pay) + توصيل ≤١٠٫٩ كم أو استلام من حي السلامة",
    hours: "المطعم ١٢:٠٠→٠٢:٠٠ (ليلة الخميس والجمعة →٠٣:٠٠). يوم المطعم بيلف ٠٤:٠٠ (طلب ١:٠٠ بليل تبع اليوم اللي فات).",
    offers: "عروض اليوم الوطني ٩٦ لحد ٣٠/٩: كيلو مشاوي ٩٦ + طبق أرز هدية، وبوكس ٩٦ (٦ أصناف، من الموقع بس). FIRST = توصيل مجاني لأول طلب أونلاين (بيتطبّق تلقائي من روابط الإعلانات).",
    economics: "المندوب بيكلّف ~٢٠ ر.س ثابت من أول كيلو → ممنوع توصيل مجاني لسلة صغيرة؛ ارفع متوسط الطلب بدل ما تنافس كيتا. خط التعادل ≈ ٣٠ ر.س مساهمة لكل طلب.",
  },
  budget: {
    hardCapDaily: 3000,
    shareOfRevenue: { target: 0.25, max: 0.30, cut: 0.35 },
    cpa: { scaleMax: 60, cutAbove: 90, winnerMax: 45 },
    rule: "كبّر +٢٥٪ في اليوم بحد أقصى لما: طلبات الإعلانات (عندنا) زادت أو ثبتت + الصرف ≤٣٠٪ من دخل اليوم كله + تكلفة الطلب ≤٦٠. قلّل ٣٠٪ لو الصرف >٣٥٪ أو التكلفة >٩٠ يومين ورا بعض. مفيش نزول تحت الميزانيات الأولية من غير قرار عمر.",
    decision0921: "عمر قال «كمّل لحد الاتنين ٢١/٩» على ~٧٠٠–٩٠٠/يوم (≈٥٠٪ من الدخل الحالي). يوم ٢١: لو CPA ≤٦٠ والدخل طالع → كبّر، غير كده → ~٤٥٠/يوم على أحسن إعلانين.",
    freeze: ["2026-09-22", "2026-09-23", "2026-09-24"],
  },
  /* ── ساعات التشغيل والإيقاع ────────────────────────────────────────────
     الإعلانات بتشتغل ١٢:٣٠→٠١:٣٠ (ليلة الخميس/الجمعة →٠٢:٣٠) — الحارس
     بيوقف المجموعات اليومية وسناب، والمجموعات lifetime ماشية بجدول ميتا
     ١٣:٠٠→٠١:٠٠ (→٠٢:٠٠). ميتا بتسمح بساعات كاملة بس.
     وزن الساعة = حصتها من دخل المطعم آخر ٢٨ يوم (ts_orders، ١٩/٩):
       ١٢–١٥ ≈ ١٧٪ · ١٦–٢٠ ≈ ٤٦٪ · ٢١–٠٠ ≈ ٢٤٪ · ٠٠–٠٢ ≈ ١٣٪
     يعني الغدا خفيف والعشا هو اليوم. أول ساعة (١٣:٠٠) فيها أكبر عدد جلسات
     إعلانات (ميتا بتحرق أول الميزانية) وأقل شرا — ده اللي قتل ١٧/٩. */
  hours: {
    adsStart: "12:30", adsEnd: "01:30", adsEndLate: "02:30", lateNights: ["الخميس", "الجمعة"],
    metaScheduleLifetime: "13:00→01:00 (الخميس/الجمعة →02:00)",
    hourWeights: { 12: 0.5, 13: 0.6, 14: 0.7, 15: 0.9, 16: 1.1, 17: 1.3, 18: 1.5, 19: 1.5, 20: 1.4, 21: 1.2, 22: 1.1, 23: 1.3, 0: 1.1, 1: 0.7, 2: 0.3 },
    dayWeights: { الخميس: 1.5, الجمعة: 1.5, السبت: 1.2, "٢٢–٢٣/٩ (اليوم الوطني)": 1.6 },
    frontloadAlert: "لو ≥٦٠٪ من خطة اليوم اتصرفت قبل ١٦:٠٠ → الصرف مقدَّم؛ متزودش، وخلي الزيادة (BOOST) للعشا ١٧:٠٠–٢٢:٠٠ بس.",
  },
  optimization: {
    now: "ATC (إضافة للسلة) — الحساب مالوش تاريخ شرا كفاية؛ Purchase على مجموعة جديدة اتقفل ١٧/٩ (ميتا بتمنع تغيير الحدث على مجموعة منشورة).",
    switchToPurchaseAt: 10, // paid online orders per day, sustained 3 days (~50 conv/week → learning)
    switchRule: "حوّل لتحسين Purchase لما طلبات الموقع المدفوعة توصل ~١٠/يوم ٣ أيام ورا بعض (≈٥٠ تحويل/أسبوع = خروج من التعلّم). التحويل = مجموعة جديدة بنفس الإعلانات، مش تعديل الموجودة.",
  },
  /* جدول الحكم على الإعلان (09 §٣-٣) — الإسناد بـ utm_term={{ad.name}} */
  adRules: [
    { when: "بعد ١٬٥٠٠ ظهور والـCTR < ١٫٢٪ (فيديو: مشاهدة ٣ث/ظهور < ٢٥٪)", then: "إيقاف — الـhook فشل", minImpressions: 1500, ctrBelow: 1.2 },
    { when: "صرف ≥ ٦٠ ر.س و٠ إضافة للسلة", then: "إيقاف", spend: 60, atc: 0 },
    { when: "صرف ≥ ١٥٠ ر.س و٠ طلب مدفوع **عندنا**", then: "إيقاف", spend: 150, ourOrders: 0 },
    { when: "≥ ٣ طلبات مدفوعة عندنا وتكلفة الطلب ≤ ٤٥", then: "فائز — hook جديد على نفس العرض + زوّد المجموعة", ourOrders: 3, cpaMax: 45 },
    { when: "التكرار > ٢٫٥ في ٧ أيام (جمهور ٨ كم صغير)", then: "تجديد الكرياتيف", frequencyAbove: 2.5 },
  ],
  creative: {
    perAdset: "٣–٥ إعلانات في كل مجموعة. كل اتنين وخميس: أضعف ٢ يطلعوا و٢ جداد يدخلوا (مش أكتر — كل إعلان جديد بيرجّع المجموعة للتعلّم).",
    winners: "KILO-A (شبكة ٤ مشاوي «اختار كيلوك»: CTR ٦٫٤٪) و BOX-B (٦ أصناف بأساميهم: أعلى ATC). الدليل ⭐٤٫٨ على جوجل (١٨١ تقييم) بيتحط في النص.",
    losers: "صور «مود»/شعار، KILO-B («عزّنا بكرمنا» CTR ١٫٥٪)، فيديوهات Runway/AI (عمر رفضها — صور حقيقية + UGC بس).",
    matrix: "٣ hooks (الفحم / رد فعل حقيقي / الميزان والوفرة) × ٢ عرض (كيلو / بوكس) = ٦ خانات أسبوعياً، 9:16 أولاً، ١٢–٢٠ ث، كابشن محروق باللهجة السعودية.",
    banned: ["وفّر", "خصم", "%/٪", "ستيك", "بطبعنا/طبعنا/كرمنا", "FIRST على الصورة (في النص بس)", "سي فود في البوكس", "لقطات AI"],
  },
  /* القرار على الفلوس = طلباتنا المدفوعة (shop_orders.attrib_source + utm)،
     مش «شرا» المنصة — ميتا بتنسب لنفسها أي شرا بعد مشاهدة. */
  judgeOn: "طلبات مدفوعة عندنا (shop_orders مربوطة بـ utm_term/utm_campaign/جلسة الرحلة) — رقم المنصة للمقارنة بس. أيام قبل ١٧/٩ مش مقارنة عادلة (الحملات وقتها كانت مكالمات/واتساب).",
  platformRoles: [
    { platform: "meta", role: "المحرّك الأساسي للطلبات: ATC→Purchase في ٨ كم، + ريتارجت الموقع (زوار/سلة/دفع ٧–٣٠ يوم ماشتروش) + كتالوج ديناميكي." },
    { platform: "whatsapp", role: "إعلانات رسائل (ميتا) — بتجيب عملاء صالة/مكالمات مش متتبعين أونلاين. متتحكمش عليها بطلبات الموقع؛ القياس = محادثات + روابط 96-wa-* + «من وين عرفتنا؟» عند الكاشير." },
    { platform: "snapchat", role: "اختبار لجمهور أصغر سناً لحد ٢٢/٩ (١٠٠ ر.س/يوم، الحساب بالدولار). الحكم بطلباتنا بس؛ الإيقاف على مستوى الحملة (سناب بترفض تعديل المجموعات placement_v2)." },
    { platform: "tiktok", role: "أورجانيك + Spark على الفيديوهات اللي نجحت؛ الإدارة بالـAPI لسه مقفولة (طلب تطبيق المطوّر اترفض). البيكسل وCAPI شغالين." },
    { platform: "google", role: "نية بحث/خرائط (تقييم ٤٫٨) — الإعلانات مش شغالة؛ البحث المجاني بيجيب أعلى معدل تحويل." },
    { platform: "sms", role: "قناة مملوكة للعملاء اللي عندنا: موجات بقواعد الامتثال (إيقاف، ساعات هدوء، فاصل ٧ أيام) + استرجاع السلات." },
  ],
  funnel: {
    facts: "١٧–١٨/٩: CTR ٣٫٦–٦٫٤٪ و CPC ٠٫٤–٠٫٦ → الكرياتيف مش المشكلة. الخسارة في: شاشة الاختيار (١٠٢→٢٠)، العنوان (١٠→٤)، الدفع. جلسات جوّه تطبيقات السوشال ١١٩ ومدفوع ٠ يوم ١٧.",
    rule: "إصلاح CRO واحد في اليوم على أكبر خطوة نزلت >٢٠٪ عن متوسط ٣ أيام (/api/journey/report?range=yesterday).",
  },
  calendar: [
    { date: "2026-09-21", what: "مراجعة «كمّل لحد الاتنين» — كبّر أو اقصر على أحسن إعلانين" },
    { date: "2026-09-22", what: "تجميد التكبير ٢٢–٢٤/٩ (اليوم الوطني) — وزن اليوم ×١٫٦" },
    { date: "2026-09-23", what: "اليوم الوطني ٩٦" },
    { date: "2026-09-27", what: "يوم الرواتب — جمهور أوسع/عرض بوكس للعيلة" },
    { date: "2026-09-30", what: "آخر يوم عروض ٩٦ (الحملات FC96 بتخلص)" },
  ],
};

/* ── pure helpers (unit-tested) ─────────────────────────────────────────── */
export function hourWeight(riyadhHour) {
  const w = PLAYBOOK.hours.hourWeights[Number(riyadhHour) % 24];
  return w == null ? 0 : w;
}

/* ATC → Purchase switch advice from the last N days of OUR paid orders */
export function optimizationAdvice(dailyPaidOrders = []) {
  const at = PLAYBOOK.optimization.switchToPurchaseAt;
  const last3 = dailyPaidOrders.slice(-3).map(Number);
  const ready = last3.length === 3 && last3.every((n) => n >= at);
  const avg = last3.length ? Math.round((last3.reduce((a, b) => a + b, 0) / last3.length) * 10) / 10 : 0;
  return {
    ready, avg, threshold: at,
    text: ready
      ? `طلبات الموقع المدفوعة ${last3.join("/")} آخر ٣ أيام (≥${at}) → وقت إننا نفتح مجموعة Purchase جديدة بنفس الإعلانات ونقفل ATC بعد ما تصرف ٥٠.`
      : `لسه على ATC: متوسط طلبات الموقع المدفوعة ${avg}/يوم (التحويل لـPurchase عند ${at}/يوم ٣ أيام ورا بعض).`,
  };
}

/* judge one ad by the 09 §3-3 table. input: {name, spend, impressions, clicks, atc, frequency, ourOrders, ourRevenue} */
export function judgeAd(a = {}) {
  const spend = Number(a.spend) || 0, imp = Number(a.impressions) || 0, clicks = Number(a.clicks) || 0;
  const ctr = imp ? (clicks / imp) * 100 : null;
  const orders = Number(a.ourOrders) || 0;
  const cpa = orders ? spend / orders : null;
  if (orders >= 3 && cpa != null && cpa <= PLAYBOOK.budget.cpa.winnerMax) return { verdict: "winner", text: `فائز: ${orders} طلب مدفوع عندنا بتكلفة ${Math.round(cpa)} ر.س — اعمل hook جديد على نفس العرض وزوّد المجموعة.` };
  if (imp >= 1500 && ctr != null && ctr < 1.2) return { verdict: "kill", text: `الـhook فشل: CTR ${ctr.toFixed(2)}٪ بعد ${imp} ظهور (< ١٫٢٪).` };
  if (spend >= 150 && orders === 0) return { verdict: "kill", text: `صرف ${Math.round(spend)} ر.س و٠ طلب مدفوع عندنا.` };
  if (spend >= 60 && Number(a.atc || 0) === 0 && orders === 0) return { verdict: "kill", text: `صرف ${Math.round(spend)} ر.س و٠ إضافة للسلة.` };
  if (Number(a.frequency) > 2.5) return { verdict: "refresh", text: `التكرار ${Number(a.frequency).toFixed(1)} > ٢٫٥ — الجمهور زهق، جدّد الكرياتيف.` };
  return { verdict: "keep", text: "كمّل — لسه مفيش قاعدة اتحققت." };
}

/* the Arabic block injected into the strategist + agent system prompts */
export function playbookPrompt() {
  const P = PLAYBOOK;
  const L = [];
  L.push(`📘 كتاب قواعد الإعلانات (نسخة ${PLAYBOOK_VERSION}) — ده اتعلّمناه من التشغيل الحقيقي، امشي عليه:`);
  L.push(`• الهدف: ${P.business.goal}. ${P.business.store}.`);
  L.push(`• ${P.business.hours}`);
  L.push(`• العروض: ${P.business.offers}`);
  L.push(`• الاقتصاد: ${P.business.economics}`);
  L.push(`• الميزانية: سقف مطلق ${P.budget.hardCapDaily} ر.س/يوم. ${P.budget.rule} ${P.budget.decision0921} تجميد التكبير: ${P.budget.freeze.join("، ")}.`);
  L.push(`• الساعات: الإعلانات ${P.hours.adsStart}→${P.hours.adsEnd} (ليلة ${P.hours.lateNights.join("/")} →${P.hours.adsEndLate}). الحارس (guard.mjs كل ٥ دقايق) هو اللي بيشغّل ويوقف ويوزّع — انت متلمسش الساعات.`);
  L.push(`• توزيع اليوم: الغدا خفيف (١٢–١٥ ≈ ١٧٪ من الدخل) والعشا هو اليوم (١٦–٢٠ ≈ ٤٦٪، ٢١–٠٠ ≈ ٢٤٪، بعد نص الليل ≈ ١٣٪). ${P.hours.frontloadAlert}`);
  L.push(`• التحسين: ${P.optimization.now} ${P.optimization.switchRule}`);
  L.push(`• الحكم على الفلوس: ${P.judgeOn}`);
  L.push(`• قواعد الإعلان الواحد: ${P.adRules.map((r) => `${r.when} ← ${r.then}`).join(" | ")}`);
  L.push(`• الكرياتيف: ${P.creative.perAdset} الكسبانين: ${P.creative.winners} الخسرانين: ${P.creative.losers} المصفوفة: ${P.creative.matrix}`);
  L.push(`• ممنوع في أي نص/صورة إعلان: ${P.creative.banned.join("، ")}.`);
  L.push(`• أدوار المنصات: ${P.platformRoles.map((r) => `${r.platform}: ${r.role}`).join(" | ")}`);
  L.push(`• القمع: ${P.funnel.facts} ${P.funnel.rule}`);
  L.push(`• التقويم: ${P.calendar.map((c) => `${c.date} ${c.what}`).join(" | ")}`);
  L.push(`• انت في وضع «اقتراح»: أي إيقاف/تغيير ميزانية بيروح طابور موافقة عمر. الحارس هو المنفّذ الوحيد للساعات والسقف والإيقاع.`);
  return L.join("\n");
}
