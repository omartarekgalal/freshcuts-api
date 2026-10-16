/* ═══════════════════════════════════════════════════════════════════════════
   🩺 wahealth.js — WH1 (١٦/١٠): مراقب صحة توصيل واتساب + تنبيه المالك قبل ما الإرسال يقف

   طلب عمر (١٦/١٠): «شوفلي لو في مشكلة في وصول الواتس بسبب الرصيد عشان نزوده مع تنبيه على رقمي أنا لو في أي حاجة
   من دي قبل ما تحصل وقبلها علامة مميزة».

   اللي اتقرا من ميتا ٠٥:٣٠ (١٦/١٠): رصيد/تمويل الـWABA مش مقروء بتوكننا (محتاج BSP)؛ health_status = LIMITED لأن
   الاسم المعروض PENDING_REVIEW؛ حد الرقم TIER_250 والمحفظة TIER_2K؛ الجودة GREEN؛ {WABA} pricing_analytics شغّال
   (يومي حسب نوع الرسالة). فالرصيد نفسه مش هنعرفه — اللي بنعرفه: الصرف (من ميتا) قصاد ميزانية المالك، أو رصيد
   مشحون مقدماً قصاد الصرف من يوم الشحن، وأول غلطة دفع (131042) من إرسالنا.

   كل N دقيقة (settings.waHealth.everyMin) — وفوراً (بعد دقيقة) لما ويب هوك ييجي بغلطة خطيرة أو حدث جودة/حساب:
     ١) حالة الرقم (نفس قراءة wacloud.phoneInfo): health_status + أسبابه، الجودة، حالة الرقم، الحد، حد المحفظة، الاسم المعروض.
     ٢) الصرف من pricing_analytics: النهارده والشهر + المتوسط اليومي + التوقّع لآخر الشهر، قصاد ميزانية المالك الشهرية،
        و(اختياري) رصيد مشحون مقدماً ⇒ كام يوم فاضل.
     ٣) أكواد فشل إرسالنا في آخر errorWindowMin دقيقة (wa_messages + wa_send_queue): دفع 131042، حساب مقفول 131031،
        سياسة 368، إزعاج 131048، رقم مش متسجّل، توكن/صلاحية، سرعة 130429/131056، وقفزة 131049 (حد ميتا للتسويق).
     ٤) أحداث الحساب/الجودة من الويب هوك (wa_quality_events) في آخر ٤٨ ساعة.
   الحكم: قايمة مشاكل، كل واحدة { key, level: crit|warn|info, title, todo, link, sms }.
   التنبيه: SMS لأرقام waHealth.phones (فاضي ⇒ المالك اللي رقمه في دليل الفريق وفي تنبيهات الإدارة ⇒ المالكين ⇒ تنبيهات الإدارة)
   أوله العلامة «‼️ واتساب فريش كاتس:»، مرة لكل تغيير حالة، وتكرار هادي: الخطير كل repeatHours والتحذير كل ٢٤ ساعة على الأقل،
   ورسالة «رجع تمام» لما المشكلة تروح. info عمرها ما بتبعت SMS (بتظهر في الكارت بس).
   مفيش أي كتابة عند ميتا ولا إرسال لعميل. الحالة في wa_health_state (صف واحد)؛ والحجز بـupdated_at عشان حاويتين وقت النشر
   مايبعتوش نفس التنبيه مرتين. كل ردود المسارات HTTP 200 مع ok:false عند الفشل (Cloudflare بيبلع الـ5xx).
═══════════════════════════════════════════════════════════════════════════ */
import { smsInfo, normStaffPhone, staffPhones } from "./staffalerts.js";
import { tierDown, ACCOUNT_STOP_EVENTS } from "./waquality.js";

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" && typeof v !== "boolean" ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const clampF = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" && typeof v !== "boolean" ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : d; };
const up = (v) => String(v ?? "").trim().toUpperCase();
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const DAY = 86400_000;

/* ── الإعدادات (settings.waHealth) — كلها من اللوحة ─────────────────────── */
export const MARKER_DEFAULT = "‼️ واتساب فريش كاتس:";
export const HEALTH_DEFAULTS = Object.freeze({
  enabled: true,          // المراقبة شغّالة (القراية من ميتا + الكارت)
  sms: true,              // تنبيه SMS للأرقام
  everyMin: 15,           // كل كام دقيقة نقرا ميتا
  monthBudgetSar: 0,      // ميزانية واتساب الشهرية عند ميتا — صفر = مش متحددة (مفيش تنبيه ميزانية)
  warnPct: 80,            // نبّه لما صرف الشهر يوصل النسبة دي من الميزانية
  prepaidSar: 0,          // رصيد اتشحن مقدماً عند ميتا (لو الحساب بالشحن) — صفر = مش مستعمل
  prepaidSince: "",       // يوم الشحن YYYY-MM-DD — الصرف من اليوم ده بيتخصم من الرصيد
  lowDays: 3,             // نبّه لما الرصيد يكفي أقل من كام يوم بمعدّل الصرف الحالي
  errorWindowMin: 120,    // نافذة عدّ أكواد الفشل (دقايق)
  rateLimitMin: 20,       // كام فشل سرعة (130429/131056) في النافذة يبقى مشكلة
  capSpikePct: 25,        // نسبة 131049 من رسايل التسويق في ٢٤ ساعة تبقى «قفزة»
  repeatHours: 6,         // تكرار تنبيه المشكلة الخطيرة لو لسه موجودة (التحذير: كل ٢٤ ساعة على الأقل)
  recovery: true,         // رسالة «رجع تمام» لما المشكلة تروح
  phones: [],             // أرقام التنبيه — فاضي = تلقائي (شوف recipientsOf)
  marker: MARKER_DEFAULT, // العلامة اللي أول الرسالة
  /* PH1 (١٦/١٠ بعد حادثة 131042): وقت مشكلة دفع/قفل/توكن مش متحلّة — الحملات والقوالب بتستنى بدل ما تفشل */
  payHold: true,          // وقّف الحملات والقوالب المدفوعة لحد ما المشكلة تتحل (الرسايل الحرة جوّه النافذة بتكمّل)
  probeMin: 10,           // وقت الإيقاف: قالب خدمي واحد كل كام دقيقة بيتبعت كتجربة — أول واحد ينجح بيرجّع كله لوحده
  holdMaxHours: 6,        // حملة مجدولة استنّت أكتر من كده بعد ميعادها ⇒ مابتبدأش لوحدها لما الإيقاف يتشال (تتبدأ بإيدك)
  ownerWa: true,          // ابعت التنبيه كمان رسالة واتساب ببلاش لو نافذة رقمك مفتوحة (الـSMS يفضل الأساسي)
});
export const HEALTH_KEYS = Object.freeze(Object.keys(HEALTH_DEFAULTS));
export const HEALTH_LIMITS = Object.freeze({
  everyMin: [5, 180], monthBudgetSar: [0, 1000000], warnPct: [10, 99], prepaidSar: [0, 1000000], lowDays: [1, 30],
  errorWindowMin: [15, 1440], rateLimitMin: [1, 10000], capSpikePct: [1, 100], repeatHours: [1, 72],
  probeMin: [2, 120], holdMaxHours: [1, 48],
});
const okDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

export function healthCfg(settings) {
  const x = { ...HEALTH_DEFAULTS, ...((((settings || {}).waHealth) && typeof settings.waHealth === "object") ? settings.waHealth : {}) };
  const L = HEALTH_LIMITS, D = HEALTH_DEFAULTS;
  const marker = String(x.marker ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
  return {
    enabled: x.enabled !== false,
    sms: x.sms !== false,
    everyMin: clampN(x.everyMin, ...L.everyMin, D.everyMin),
    monthBudgetSar: clampF(x.monthBudgetSar, ...L.monthBudgetSar, D.monthBudgetSar),
    warnPct: clampN(x.warnPct, ...L.warnPct, D.warnPct),
    prepaidSar: clampF(x.prepaidSar, ...L.prepaidSar, D.prepaidSar),
    prepaidSince: okDay(x.prepaidSince) ? String(x.prepaidSince) : "",
    lowDays: clampN(x.lowDays, ...L.lowDays, D.lowDays),
    errorWindowMin: clampN(x.errorWindowMin, ...L.errorWindowMin, D.errorWindowMin),
    rateLimitMin: clampN(x.rateLimitMin, ...L.rateLimitMin, D.rateLimitMin),
    capSpikePct: clampN(x.capSpikePct, ...L.capSpikePct, D.capSpikePct),
    repeatHours: clampN(x.repeatHours, ...L.repeatHours, D.repeatHours),
    recovery: x.recovery !== false,
    phones: staffPhones(x.phones).slice(0, 5),
    marker: marker || MARKER_DEFAULT,
    payHold: x.payHold !== false,
    probeMin: clampN(x.probeMin, ...L.probeMin, D.probeMin),
    holdMaxHours: clampN(x.holdMaxHours, ...L.holdMaxHours, D.holdMaxHours),
    ownerWa: x.ownerWa !== false,
  };
}

/* مين بياخد التنبيه: الأرقام المكتوبة ⇒ المالك اللي رقمه في دليل الفريق وفي «أرقام الإنذارات الحرجة» ⇒ كل المالكين في دليل
   الفريق ⇒ أرقام الإنذارات الحرجة. بترجع { phones, source }. */
export function recipientsOf(settings, cfg = healthCfg(settings)) {
  if (cfg.phones.length) return { phones: cfg.phones, source: "custom" };
  const s = settings || {};
  const owners = staffPhones(((s.waTeam && Array.isArray(s.waTeam.members)) ? s.waTeam.members : []).filter((m) => m && m.role === "owner").map((m) => m.phone));
  const alert = staffPhones((s.delivery || {}).alertPhones);
  const both = owners.filter((p) => alert.includes(p));
  if (both.length) return { phones: both, source: "owner_alert" };
  if (owners.length) return { phones: owners, source: "team_owners" };
  if (alert.length) return { phones: alert, source: "alert_phones" };
  return { phones: [], source: "none" };
}
export const SOURCE_AR = Object.freeze({
  custom: "الأرقام اللي اتكتبت هنا",
  owner_alert: "المالك (في دليل الفريق وفي أرقام الإنذارات الحرجة)",
  team_owners: "المالكين في دليل الفريق",
  alert_phones: "أرقام الإنذارات الحرجة",
  none: "مفيش رقم — التنبيه مش هيتبعت",
});

/* ── الصرف من ميتا (pricing_analytics) ──────────────────────────────────────
   raw = d.pricing_analytics (حقل على الـWABA) أو رد الـedge نفسه: { data: [ { data_points: [ {start, end, volume, cost, pricing_category} ] } ] }.
   الأيام بيوم ميتا (UTC = من ٣ الفجر بتوقيت الرياض). بترجع { days: [{day, cost, volume, byCat}], ok } مرتّبة. */
export const utcDay = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);
export function parsePricing(raw) {
  const blocks = raw && Array.isArray(raw.data) ? raw.data : [];
  const m = new Map();
  for (const b of blocks) {
    for (const p of (b && Array.isArray(b.data_points) ? b.data_points : [])) {
      const st = Number(p && p.start);
      if (!Number.isFinite(st)) continue;
      const day = utcDay(st * 1000);
      const cost = Number(p.cost) || 0, vol = Number(p.volume) || 0;
      const cat = up(p.pricing_category) || "OTHER";
      const cur = m.get(day) || { day, cost: 0, volume: 0, byCat: {} };
      cur.cost += cost; cur.volume += vol;
      const c = cur.byCat[cat] || { cost: 0, volume: 0 };
      c.cost += cost; c.volume += vol; cur.byCat[cat] = c;
      m.set(day, cur);
    }
  }
  const days = [...m.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, cost: r2(d.cost),
    byCat: Object.fromEntries(Object.entries(d.byCat).map(([k, v]) => [k, { cost: r2(v.cost), volume: v.volume }])) }));
  return { days };
}
/* الأرقام اللي بيتحكم عليها: النهارده، الشهر، المتوسط اليومي (الأيام الكاملة من آخر ٧)، التوقّع لآخر الشهر، والرصيد المشحون */
export function spendView(days, { now = Date.now(), prepaidSince = "" } = {}) {
  const today = utcDay(now);
  const month = today.slice(0, 7);
  const list = Array.isArray(days) ? days : [];
  const sum = (arr) => r2(arr.reduce((a, d) => a + (Number(d.cost) || 0), 0));
  const inMonth = list.filter((d) => d.day.slice(0, 7) === month);
  const todayRow = list.find((d) => d.day === today) || null;
  const full = list.filter((d) => d.day < today && d.day >= utcDay(now - 7 * DAY));
  const avgDaily = full.length ? r2(sum(full) / full.length) : todayRow ? r2(todayRow.cost / Math.max(1 / 24, ((now % DAY) / DAY))) : 0;
  const mStart = Date.parse(`${month}-01T00:00:00Z`);
  const next = new Date(mStart); next.setUTCMonth(next.getUTCMonth() + 1);
  const daysLeft = Math.max(0, (next.getTime() - now) / DAY);
  const monthSpend = sum(inMonth);
  const byCat = {};
  for (const d of inMonth) for (const [k, v] of Object.entries(d.byCat || {})) { const c = byCat[k] || { cost: 0, volume: 0 }; c.cost = r2(c.cost + v.cost); c.volume += v.volume; byCat[k] = c; }
  const since = okDay(prepaidSince) ? String(prepaidSince) : "";
  return { today: todayRow ? todayRow.cost : 0, todayVolume: todayRow ? todayRow.volume : 0, month: monthSpend, monthKey: month, byCat,
    avgDaily, avgDays: full.length, daysLeft: r2(daysLeft), projected: r2(monthSpend + avgDaily * daysLeft), monthEnd: utcDay(next.getTime() - 1),
    spentSincePrepaid: since ? sum(list.filter((d) => d.day >= since)) : null, prepaidSince: since || null,
    days: list.slice(-14).map((d) => ({ day: d.day, cost: d.cost, volume: d.volume })) };
}

/* ── كتالوج المشاكل ─────────────────────────────────────────────────────────
   level: crit = الإرسال واقف أو هيقف حالاً · warn = هيقف أو بيتأثر قريب · info = للعلم (من غير SMS).
   sms: سطر قصير (عربي ⇒ الرسالة UCS-2، ٦٧ حرف للجزء) — العلامة بتتحط قبله. */
export const LINKS = Object.freeze({
  billing: "https://business.facebook.com/billing_hub/payment_settings/",
  waManager: "https://business.facebook.com/wa/manage/home/",
  phones: "https://business.facebook.com/wa/manage/phone-numbers/",
  insights: "https://business.facebook.com/wa/manage/insights/",
  quality: "https://business.facebook.com/wa/manage/phone-numbers/",
  templates: "https://business.facebook.com/wa/manage/message-templates/",
});
const CODE_ISSUES = {
  131042: { key: "pay_error", level: "crit", title: "ميتا رفضت رسايل بسبب الدفع (131042)", sms: "الدفع عند ميتا فشل والرسايل مش بتوصل — حدّث الكارت أو زوّد الرصيد",
    todo: "افتح إعدادات الدفع في Meta Business وحدّث الكارت أو زوّد الرصيد/حد الائتمان لحساب واتساب. بعد ما الدفع ينجح الإرسال بيرجع لوحده: الحملات والقوالب بتستنى وقت المشكلة وبتكمّل لوحدها أول ما قالب ينجح (ابعت رسالة تجربة عشان تتأكد).", link: "billing" },
  131031: { key: "account_locked", level: "crit", title: "حساب واتساب مقفول عند ميتا (131031)", sms: "حساب واتساب اتقفل عند ميتا — مفيش رسايل خارجة",
    todo: "افتح WhatsApp Manager وشوف التنبيه اللي فوق (سبب القفل + طلب مراجعة). مفيش حاجة تتعمل من السيرفر.", link: "waManager" },
  368: { key: "policy_block", level: "crit", title: "ميتا منعت الإرسال بسبب مخالفة سياسة (368)", sms: "ميتا منعت الإرسال بسبب مخالفة سياسة",
    todo: "افتح WhatsApp Manager ← Account quality، اقرا المخالفة وقدّم طلب مراجعة لو غلط. وقّف الحملات لحد ما تتحل.", link: "waManager" },
  131048: { key: "spam_limit", level: "crit", title: "ميتا حدّت رقمنا بسبب بلاغات إزعاج (131048)", sms: "ميتا حدّت رقمنا بسبب بلاغات إزعاج — وقّف الحملات",
    todo: "وقّف حملات التسويق لحد ما الجودة ترجع خضرا، وراجع آخر حملة (نسبة «إيقاف» والجمهور). رسايل الطلبات بتكمّل.", link: "quality" },
  131045: { key: "not_registered", level: "crit", title: "رقم المطعم مش متسجّل على واتساب API", sms: "رقم المطعم مش متسجّل على واتساب API — الرسايل واقفة",
    todo: "افتح «الربط» في قسم واتساب في اللوحة وشوف حالة الرقم، أو WhatsApp Manager ← Phone numbers.", link: "phones" },
  190: { key: "token", level: "crit", title: "توكن واتساب مش صالح (190)", sms: "توكن واتساب مش صالح — الرسايل مش بتتبعت",
    todo: "التوكن بتاع مستخدم النظام انتهى أو اتلغى — محتاج توكن جديد في إعدادات السيرفر (Coolify).", link: null },
  10: { key: "permission", level: "crit", title: "صلاحية واتساب ناقصة (10/200)", sms: "صلاحية واتساب ناقصة — الرسايل مش بتتبعت",
    todo: "مستخدم النظام محتاج صلاحية whatsapp_business_messaging على الحساب — من Business Settings ← System users.", link: null },
};
CODE_ISSUES[133010] = CODE_ISSUES[131045];
CODE_ISSUES[200] = CODE_ISSUES[10];
export const CRIT_CODES = Object.freeze(Object.keys(CODE_ISSUES).map(Number));
export const RATE_CODES = Object.freeze([130429, 131056, 80007, 4]);
export const CAPPED_CODE = 131049;

const HEALTH_ERR_AR = (e) => String(e && (e.text || e.code) || "").slice(0, 160);
/* حالة الرقم ⇒ مشاكل. phone = wacloud.phoneInfo(); prev = { tier, portfolio } من آخر قراءة ناجحة */
export function phoneIssues(phone, prev = {}) {
  const out = [];
  if (!phone || phone.ok !== true) {
    /* قراية فاشلة مرة = للعلم بس (ميتا بتقع دقيقة وترجع)؛ ٣ مرات ورا بعض (~٤٥ دقيقة) = تحذير. prev.readFails = عدد الفشل قبل الفحص ده */
    out.push({ key: "read_failed", level: (Number(prev && prev.readFails) || 0) >= 2 ? "warn" : "info", title: "ماقدرناش نقرا حالة رقم واتساب من ميتا", sms: "ماقدرناش نقرا حالة رقم واتساب من ميتا",
      detail: phone ? String(phone.error || phone.code || "").slice(0, 120) : null,
      todo: "لو استمرت أكتر من ساعة: التوكن أو الصلاحية فيها مشكلة — شوف «الربط» في قسم واتساب.", link: null });
    return out;
  }
  const h = up(phone.health);
  const errs = Array.isArray(phone.healthErrors) ? phone.healthErrors : [];
  const why = errs.map(HEALTH_ERR_AR).filter(Boolean).slice(0, 2).join(" · ");
  const nameStatus = up(phone.nameStatus);
  if (h === "BLOCKED") out.push({ key: "health_blocked", level: "crit", title: "ميتا موقّفة الإرسال من الرقم (BLOCKED)", sms: "ميتا وقّفت الإرسال من رقم واتساب (BLOCKED)",
    detail: why || null, todo: "افتح WhatsApp Manager وشوف سبب الإيقاف (دفع، اسم، سياسة). " + (errs[0] && errs[0].fix ? `ميتا بتقول: ${String(errs[0].fix).slice(0, 160)}` : ""), link: "waManager" });
  else if (h === "LIMITED") {
    const byName = nameStatus === "PENDING_REVIEW" || /display name/i.test(why);
    out.push({ key: "health_limited", level: "warn", title: byName ? "الإرسال محدود لحد ما ميتا توافق على الاسم المعروض" : "ميتا حاطة الرقم على «محدود» (LIMITED)",
      sms: byName ? "الإرسال محدود لحد ما ميتا توافق على اسم الرقم" : "ميتا حاطة رقم واتساب على محدود (LIMITED)",
      detail: why || null, todo: byName ? "الحد هيزيد بعد اعتماد الاسم. تابع المراجعة في WhatsApp Manager ← Phone numbers ← Name، ولو اترفض عدّل الاسم ليطابق اسم المحل الرسمي."
        : "افتح WhatsApp Manager وشوف السبب اللي ميتا كاتباه." + (errs[0] && errs[0].fix ? ` ميتا بتقول: ${String(errs[0].fix).slice(0, 160)}` : ""), link: "phones" });
  }
  const q = up(phone.quality);
  if (q === "RED") out.push({ key: "quality_red", level: "crit", title: "جودة الرقم حمرا عند ميتا", sms: "جودة رقم واتساب بقت حمرا — وقّف الحملات فوراً",
    todo: "وقّف كل حملات التسويق. لو فضلت حمرا ميتا بتنزّل حد الرقم أو توقّفه. راجع آخر حملة.", link: "quality" });
  else if (q === "YELLOW") out.push({ key: "quality_yellow", level: "warn", title: "جودة الرقم صفرا عند ميتا", sms: "جودة رقم واتساب بقت صفرا — خفّف الحملات",
    todo: "خفّف الحملات (أقل عدد، جمهور أدفى، رسالة أوضح) لحد ما ترجع خضرا. لو بقت حمرا الإرسال هيتحد.", link: "quality" });
  if (nameStatus === "DECLINED" || nameStatus === "REJECTED") out.push({ key: "name_rejected", level: "crit", title: "ميتا رفضت الاسم المعروض", sms: "ميتا رفضت اسم رقم واتساب — الإرسال هيفضل محدود",
    todo: "عدّل الاسم في WhatsApp Manager ← Phone numbers ← Name ليطابق اسم المحل الرسمي (السجل التجاري/الموقع) وقدّمه تاني.", link: "phones" });
  else if (nameStatus === "PENDING_REVIEW" && !(h === "LIMITED" && out.some((i) => i.key === "health_limited" && /الاسم/.test(i.title)))) out.push({ key: "name_pending", level: "warn", title: "الاسم المعروض لسه في مراجعة ميتا", sms: "اسم رقم واتساب لسه في مراجعة ميتا — الحد محدود",
    todo: "مفيش حاجة تتعمل غير المتابعة. لو طوّلت أكتر من يومين أو اترفضت: عدّل الاسم ليطابق اسم المحل الرسمي.", link: "phones" });
  const st = up(phone.status);
  if (["BANNED", "RESTRICTED", "DISCONNECTED", "RATE_LIMITED", "DELETED"].includes(st)) out.push({ key: "phone_status", level: "crit", title: `حالة الرقم عند ميتا: ${st}`, sms: `حالة رقم واتساب عند ميتا بقت ${st}`,
    todo: "افتح WhatsApp Manager ← Phone numbers وشوف السبب.", link: "phones" });
  else if (st === "FLAGGED") out.push({ key: "phone_status", level: "warn", title: "ميتا علّمت الرقم (FLAGGED) — الجودة نازلة", sms: "ميتا علّمت رقم واتساب (FLAGGED) — خفّف الحملات",
    todo: "خفّف الحملات لحد ما العلامة تتشال، وإلا الحد هينزل.", link: "quality" });
  if (prev && prev.tier && phone.tier && tierDown(prev.tier, phone.tier)) out.push({ key: "tier_drop", level: "crit", title: `حد الرقم نزل من ${prev.tier} لـ${phone.tier}`, sms: `حد رقم واتساب نزل لـ${phone.tier}`,
    from: prev.tier, to: phone.tier, todo: "قلّل سقف الحملات اليومي في «السقوف» ليناسب الحد الجديد، وراجع الجودة.", link: "quality" });
  const pf = phone.portfolio && phone.portfolio.ok ? phone.portfolio.limit : null;
  if (prev && prev.portfolio && pf && tierDown(prev.portfolio, pf)) out.push({ key: "portfolio_drop", level: "crit", title: `حد المحفظة نزل من ${prev.portfolio} لـ${pf}`, sms: `حد محفظة واتساب نزل لـ${pf}`,
    from: prev.portfolio, to: pf, todo: "قلّل سقف الحملات اليومي ليناسب الحد الجديد، وراجع الجودة.", link: "quality" });
  return out;
}

/* أكواد الفشل ⇒ مشاكل. codes = [{ code, n, last }] في النافذة؛ m24 = { marketing, capped } في ٢٤ ساعة */
export function errorIssues(codes, m24, cfg) {
  const out = [], seen = new Set();
  const list = (Array.isArray(codes) ? codes : []).map((x) => ({ code: Number(x.code), n: Number(x.n) || 0, last: x.last || null })).filter((x) => Number.isFinite(x.code) && x.n > 0);
  for (const x of list.sort((a, b) => b.n - a.n)) {
    const d = CODE_ISSUES[x.code];
    if (!d || seen.has(d.key)) continue;
    seen.add(d.key);
    const n = list.filter((y) => CODE_ISSUES[y.code] && CODE_ISSUES[y.code].key === d.key).reduce((a, y) => a + y.n, 0);
    out.push({ key: d.key, level: d.level, title: d.title, sms: d.sms, todo: d.todo, link: d.link, detail: `${n} رسالة في آخر ${cfg.errorWindowMin} دقيقة`, n, last: x.last });
  }
  const rate = list.filter((x) => RATE_CODES.includes(x.code)).reduce((a, x) => a + x.n, 0);
  if (rate >= cfg.rateLimitMin) out.push({ key: "rate_limit", level: "warn", title: "ميتا بتطلب نبطّأ الإرسال (130429/131056)", sms: "ميتا بتبطّأ رسايلنا — قلّل سرعة الحملات",
    detail: `${rate} رسالة في آخر ${cfg.errorWindowMin} دقيقة`, todo: "قلّل «في الساعة» و«في الدورة» في سقوف الحملات. الرسايل دي بتتعاد لوحدها.", link: null, n: rate });
  const mk = Number(m24 && m24.marketing) || 0, cp = Number(m24 && m24.capped) || 0;
  if (mk >= 30 && cp > 0 && (cp / mk) * 100 >= cfg.capSpikePct) {
    const pct = Math.round((cp / mk) * 100);
    out.push({ key: "cap_spike", level: "warn", title: `ميتا حدّت تسويق ${pct}٪ من المستلمين (131049)`, sms: `ميتا رافضة ${pct}٪ من رسايل التسويق (131049)`,
      detail: `${cp} من ${mk} في ٢٤ ساعة`, todo: "ميتا بتحدّ عدد رسايل التسويق اللي العميل بيستلمها من كل البزنسات. وجّه الحملات لعملاء متفاعلين أكتر وباعد بينها. مش عطل عندنا.", link: "insights", n: cp });
  }
  return out;
}

/* أحداث الحساب/الجودة من الويب هوك (آخر حدث لكل موضوع) */
export function eventIssues(events) {
  const out = [];
  let account = null, phone = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (e.kind === "account" && ACCOUNT_STOP_EVENTS.includes(up(e.event))) account = e;
    if (e.kind === "phone") phone = e;
  }
  if (account) out.push({ key: "account_event", level: "crit", title: `ميتا بعتت حدث على الحساب: ${up(account.event)}`, sms: `ميتا بعتت تنبيه على حساب واتساب (${up(account.event).slice(0, 24)})`,
    detail: account.at ? new Date(account.at).toISOString() : null, todo: "افتح WhatsApp Manager واقرا التنبيه — غالباً قيد على الحساب أو نزول في الحد.", link: "waManager" });
  if (phone && up(phone.event) === "DOWNGRADE") out.push({ key: "tier_drop", level: "crit", title: `ميتا نزّلت حد الرقم${phone.tier ? ` لـ${up(phone.tier)}` : ""}`, sms: "ميتا نزّلت حد رقم واتساب",
    todo: "قلّل سقف الحملات اليومي ليناسب الحد الجديد، وراجع الجودة.", link: "quality" });
  return out;
}

/* الصرف ⇒ مشاكل. sp = spendView؛ pricingOk = القراية من ميتا نجحت */
export function spendIssues(sp, cfg, { pricingOk = true, now = Date.now() } = {}) {
  const out = [];
  if (!pricingOk) { out.push({ key: "spend_unread", level: "info", title: "ماقدرناش نقرا الصرف من ميتا دلوقتي", todo: "هنحاول تاني في الدورة الجاية.", link: "insights" }); return out; }
  if (!sp) return out;
  const fmt = (v) => `${Math.round(Number(v) || 0).toLocaleString("en-US")}`;
  if (cfg.monthBudgetSar > 0) {
    const pct = Math.round((sp.month / cfg.monthBudgetSar) * 100);
    if (sp.month >= cfg.monthBudgetSar) out.push({ key: "budget_over", level: "crit", title: `صرف واتساب الشهر ده ${fmt(sp.month)} — عدّى الميزانية (${fmt(cfg.monthBudgetSar)})`,
      sms: `صرف الشهر ${fmt(sp.month)} عدّى الميزانية ${fmt(cfg.monthBudgetSar)} — زوّد الرصيد`, todo: "زوّد الرصيد/حد الدفع عند ميتا لو عايز الحملات تكمّل، وعدّل الميزانية هنا. لو الدفع وقع الرسايل كلها هتقف (حتى تحديثات الطلبات).", link: "billing", pct });
    else if (pct >= cfg.warnPct) out.push({ key: "budget_warn", level: "warn", title: `صرف واتساب الشهر ده ${pct}٪ من الميزانية (${fmt(sp.month)} من ${fmt(cfg.monthBudgetSar)})`,
      sms: `صرف واتساب ${pct}٪ من ميزانية الشهر — جهّز زيادة الرصيد`, todo: "جهّز زيادة الرصيد أو حد الدفع عند ميتا قبل ما يخلص، أو خفّف الحملات.", link: "billing", pct });
    else if (sp.avgDaily > 0 && sp.projected > cfg.monthBudgetSar) {
      const left = (cfg.monthBudgetSar - sp.month) / sp.avgDaily;
      const day = utcDay(now + left * DAY);
      out.push({ key: "budget_pace", level: "warn", title: `بالمعدّل ده (${fmt(sp.avgDaily)}/يوم) الميزانية هتخلص يوم ${day}`, sms: `بمعدّل الصرف ده ميزانية واتساب هتخلص يوم ${day.slice(5)}`,
        todo: "يا تزوّد الميزانية/الرصيد قبل اليوم ده، يا تخفّف الحملات.", link: "billing", pct });
    }
  } else out.push({ key: "no_budget", level: "info", title: "مفيش ميزانية شهرية متحددة لواتساب", todo: "اكتب ميزانية الشهر هنا عشان ننبّهك قبل ما تخلص (مثلاً ٨٠٪).", link: null });
  if (cfg.prepaidSar > 0 && cfg.prepaidSince) {
    const remaining = r2(cfg.prepaidSar - (Number(sp.spentSincePrepaid) || 0));
    const days = sp.avgDaily > 0 ? remaining / sp.avgDaily : null;
    if (remaining <= 0) out.push({ key: "prepaid_out", level: "crit", title: `الرصيد المشحون خلص (اتصرف ${fmt(sp.spentSincePrepaid)} من ${fmt(cfg.prepaidSar)})`, sms: "رصيد واتساب المشحون خلص — اشحن فوراً",
      todo: "اشحن الرصيد عند ميتا دلوقتي، وبعدها اكتب المبلغ الجديد ويوم الشحن هنا.", link: "billing", remaining });
    else if (days != null && days <= cfg.lowDays) out.push({ key: "prepaid_low", level: "warn", title: `الرصيد المشحون فاضل ${fmt(remaining)} — يكفي حوالي ${Math.max(0, Math.round(days * 10) / 10)} يوم`,
      sms: `رصيد واتساب فاضل ${fmt(remaining)} — يكفي ${Math.max(1, Math.round(days))} يوم تقريباً، اشحن`, todo: "اشحن الرصيد عند ميتا قبل ما يخلص، وبعدها حدّث المبلغ ويوم الشحن هنا.", link: "billing", remaining });
  }
  return out;
}

const RANK = { crit: 3, warn: 2, info: 1 };
export function levelOf(issues) {
  let best = 0;
  for (const i of issues || []) best = Math.max(best, RANK[i.level] || 0);
  return best >= 3 ? "crit" : best === 2 ? "warn" : "ok";
}
/* دمج: نفس المفتاح مرة واحدة (الأخطر يكسب) والأخطر الأول */
export function mergeIssues(...lists) {
  const m = new Map();
  for (const i of lists.flat()) { if (!i || !i.key) continue; const cur = m.get(i.key); if (!cur || (RANK[i.level] || 0) > (RANK[cur.level] || 0)) m.set(i.key, i); }
  return [...m.values()].sort((a, b) => (RANK[b.level] || 0) - (RANK[a.level] || 0));
}

/* ── المشاكل المحمولة (مراجعة WH1، ١٦/١٠) ──────────────────────────────────
   غياب المشكلة في الدورة دي مش معناه إنها اتحلّت لو إحنا ماشفناش:
     • قراية الرقم وقعت ⇒ مشاكل الرقم (الحالة/الجودة/الاسم/الحد) من آخر قراية ناجحة.
     • قراية الصرف وقعت ⇒ مشاكل الميزانية/الرصيد من آخر قراية ناجحة (نفس الشهر، والإعداد لسه شغّال).
     • غلطة إرسال (131042، 131031، 131048، توكن…) خرجت من النافذة من غير ما رسالة تنجح بعدها ⇒ لسه قايمة
       (الدفع: لازم قالب ينجح — رسايل خدمة العميل ببلاش فمش دليل).
     • «الحد نزل» بيفضل ظاهر ٤٨ ساعة طول ما الحد لسه تحت اللي كان عليه.
   المحمولة carried:true: بتظهر في الكارت والبانر بنفس مستواها ومعاها «آخر مرة اتشافت»، مابتتبعتش تاني (مفيش دليل جديد)،
   ومابتتحسبش «رجع تمام». وأحداث EVENT_KEYS (حصلت مرة) اختفاؤها مش «رجع تمام» أصلاً. */
export const PHONE_KEYS = Object.freeze(["health_blocked", "health_limited", "quality_red", "quality_yellow", "name_rejected", "name_pending", "phone_status", "tier_drop", "portfolio_drop"]);
export const SPEND_KEYS = Object.freeze(["budget_over", "budget_warn", "budget_pace", "prepaid_out", "prepaid_low"]);
export const CODE_KEYS = Object.freeze([...new Set(Object.values(CODE_ISSUES).map((d) => d.key))]);
export const EVENT_KEYS = Object.freeze(["tier_drop", "portfolio_drop", "account_event"]);
const STICKY_DROP_MS = 48 * 3600_000;
export const riyadhStamp = (ms) => { const d = new Date(Number(ms) + 3 * 3600_000); const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
/* prevLast = snap الدورة اللي فاتت؛ present = مشاكل الدورة دي؛ okSince = { any, tpl } آخر رسالة نجحت (null = مش معروف ⇒ مانمسكش أكواد) */
export function carryIssues(prevLast, { phoneOk = true, pricingOk = true, phone = null, okSince = null, cfg = HEALTH_DEFAULTS, now = Date.now(), present = [] } = {}) {
  const last = prevLast && Array.isArray(prevLast.issues) ? prevLast.issues : [];
  const lastAt = Date.parse((prevLast && prevLast.checkedAt) || "") || now;
  const have = new Set((present || []).map((i) => i && i.key));
  const out = [];
  const carry = (i, detail) => {
    const freshAt = i.carried ? (Date.parse(i.freshAt || "") || lastAt) : lastAt;
    const base = i.carried ? (i.baseDetail ?? null) : (i.detail ?? null);
    out.push({ ...i, carried: true, freshAt: new Date(freshAt).toISOString(), baseDetail: base, detail: detail(base, freshAt) });
    have.add(i.key);
  };
  const join = (...a) => a.filter(Boolean).join(" · ");
  const month = utcDay(now).slice(0, 7);
  const pf = phone && phone.ok && phone.portfolio && phone.portfolio.ok ? phone.portfolio.limit : null;
  for (const i of last) {
    if (!i || !i.key || have.has(i.key) || (i.level !== "crit" && i.level !== "warn")) continue;
    if (PHONE_KEYS.includes(i.key) && !phoneOk) { carry(i, (b, t) => join(b, `آخر قراية ناجحة ${riyadhStamp(t)} — ميتا مابتردّش دلوقتي`)); continue; }
    if ((i.key === "tier_drop" || i.key === "portfolio_drop") && i.from && phoneOk) {
      const t0 = i.carried ? (Date.parse(i.freshAt || "") || lastAt) : lastAt;
      const cur = i.key === "tier_drop" ? (phone && phone.tier) : pf;
      if (cur && tierDown(i.from, cur) && now - t0 < STICKY_DROP_MS) carry(i, (b, t) => join(b, `من ${riyadhStamp(t)}`));
      continue;
    }
    if (SPEND_KEYS.includes(i.key) && !pricingOk) {
      const t0 = i.carried ? (Date.parse(i.freshAt || "") || lastAt) : lastAt;
      const applies = i.key.startsWith("budget_") ? cfg.monthBudgetSar > 0 : cfg.prepaidSar > 0 && Boolean(cfg.prepaidSince);
      if (applies && utcDay(t0).slice(0, 7) === month) carry(i, (b, t) => join(b, `من آخر قراية ناجحة للصرف ${riyadhStamp(t)}`));
      continue;
    }
    if (CODE_KEYS.includes(i.key) && okSince) {
      const lastErr = Date.parse(i.last || "") || (i.carried ? Date.parse(i.freshAt || "") : lastAt) || lastAt;
      const okAt = Date.parse((i.key === "pay_error" ? okSince.tpl : okSince.any) || "") || 0;
      if (okAt <= lastErr) carry(i, () => `آخر غلطة ${riyadhStamp(lastErr)} — لسه مفيش رسالة ${i.key === "pay_error" ? "قالب " : ""}نجحت بعدها`);
    }
  }
  return out;
}

/* ── PH1: إيقاف الإرسال المدفوع وقت مشكلة دفع/قفل/توكن (١٦/١٠) ────────────────
   الحادثة: فاتورة واتساب Cloud ماكانتش مدفوعة ⇒ 131042 على ٨٣ رسالة (٠٠:١٥–١٣:٤١)، والمراقب بعت SMS ١٢:١٢ بس حملات ١٣:٠٠
   بدأت وفشلت. القاعدة: لو في آخر فحص للمراقب مشكلة من HOLD_KEYS (crit) ولسه مفيش رسالة نجحت **بعد** آخر غلطة منها
   (قالب للدفع — نفس قاعدة carryIssues، رسالة الخدمة ببلاش مش دليل) ⇒ الإيقاف قايم: الحملات مابتبعتش، البدء المجدول بيستنى
   (start_at مابيتحرقش)، والقوالب (تحديثات الطلب/التقييم/الفريق) بتتخطّى بسبب «pay_hold» بدل ما تفشل. الرسايل الحرة جوّه
   النافذة بتكمّل. الرجوع لوحده: قالب «تجربة» واحد كل probeMin دقيقة (خدمي، مش تسويق) — أول ما ينجح الإيقاف بيتشال.
   last = snap آخر فحص (wa_health_state.data.last)؛ okSince = { any, tpl } أو null (ماقدرناش نقرا ⇒ الإيقاف بيفضل). */
export const HOLD_KEYS = Object.freeze(["pay_error", "account_locked", "token", "permission"]);
export const HOLD_AR = Object.freeze({
  pay_error: "موقوفة لحد ما مشكلة الدفع عند ميتا تتحل",
  account_locked: "موقوفة لحد ما ميتا تفك قفل حساب واتساب",
  token: "موقوفة لحد ما توكن واتساب يتصلّح",
  permission: "موقوفة لحد ما صلاحية واتساب تتصلّح",
});
export const HOLD_NONE = Object.freeze({ held: false, key: null, keys: [], lastErr: null, reasonAr: null });
export function holdVerdict(last, okSince) {
  if (!last || !Array.isArray(last.issues)) return { ...HOLD_NONE };
  const checkedAt = Date.parse(last.checkedAt || "") || 0;
  const act = [];
  for (const i of last.issues) {
    if (!i || !HOLD_KEYS.includes(i.key) || i.level !== "crit") continue;
    const lastErr = Date.parse(i.last || "") || Date.parse(i.freshAt || "") || checkedAt;
    if (okSince) {
      const okAt = Date.parse((i.key === "pay_error" ? okSince.tpl : okSince.any) || "") || 0;
      if (okAt > lastErr) continue;            // رسالة (قالب للدفع) نجحت بعد آخر غلطة ⇒ اتحلّت
    }
    act.push({ key: i.key, lastErr });
  }
  if (!act.length) return { ...HOLD_NONE };
  const top = act.find((a) => a.key === "pay_error") || act[0];
  const lastErr = Math.max(...act.map((a) => a.lastErr || 0));
  return { held: true, key: top.key, keys: act.map((a) => a.key), lastErr: lastErr ? new Date(lastErr).toISOString() : null,
    lastErrRiyadh: lastErr ? riyadhStamp(lastErr) : null, reasonAr: HOLD_AR[top.key] };
}
/* قالب يعدّي كـ«تجربة» وقت الإيقاف؟ خدمي بس (مش تسويق/حملة ولا كود تحقق)، ومرة كل probeMin دقيقة */
export function probeAllowed({ marketing = false, category = null } = {}, lastProbeAt, probeMin, now = Date.now()) {
  if (marketing || category !== "UTILITY") return false;
  return !(now - (Number(lastProbeAt) || 0) < probeMin * 60_000);
}
/* واتساب نفسه شغّال كفاية إن المالك ياخد التنبيه رسالة حرة؟ الدفع لوحده مابيمنعش الرسايل الحرة؛ القفل/التوكن/الصلاحية/الحظر بيمنعوا كله */
export const WA_DEAD_KEYS = Object.freeze(["account_locked", "token", "permission", "not_registered", "policy_block", "health_blocked", "phone_status"]);
export const waUsable = (issues) => !(issues || []).some((i) => i && i.level === "crit" && WA_DEAD_KEYS.includes(i.key));

/* ── خطة التنبيه (دالة صافية) ───────────────────────────────────────────────
   prev = { key: { level, at } } المشاكل اللي اتبعت عنها. بترجع { announce: [مشاكل], recovered: [keys], next }.
   بتتبعت: مشكلة جديدة، أو اتصعّدت (warn ⇒ crit)، أو لسه موجودة وعدّى عليها repeatHours (crit) / max(repeatHours, 24) (warn).
   info مابتتبعتش أبداً. المحمولة (carried) بتحتفظ بحالتها من غير تكرار. اللي اتبعت عنها وراحت ⇒ recovered (لو cfg.recovery)،
   إلا أحداث EVENT_KEYS (اختفاؤها مش معناه إنها اترجعت). */
export function alertPlan(issues, prev, cfg, now = Date.now()) {
  const p = prev && typeof prev === "object" ? prev : {};
  const next = {}, announce = [], recovered = [];
  for (const i of issues || []) {
    if (i.level !== "crit" && i.level !== "warn") continue;
    const old = p[i.key];
    if (i.carried) { if (old) next[i.key] = old; continue; }
    const every = (i.level === "crit" ? cfg.repeatHours : Math.max(cfg.repeatHours, 24)) * 3600_000;
    const due = !old || (RANK[i.level] || 0) > (RANK[old.level] || 0) || !(now - Date.parse(old.at || 0) < every);
    if (due) { announce.push(i); next[i.key] = { level: i.level, at: new Date(now).toISOString() }; }
    else next[i.key] = { level: (RANK[i.level] || 0) >= (RANK[old.level] || 0) ? i.level : old.level, at: old.at };
  }
  for (const k of Object.keys(p)) if (!next[k] && !EVENT_KEYS.includes(k)) recovered.push(k);
  return { announce, recovered: cfg.recovery ? recovered : [], next };
}

/* نص الرسالة: العلامة + أخطر مشكلة (+ عدد الباقي)، أو «رجع تمام». لحد جزئين SMS (UCS-2 = ١٣٤ حرف). */
export function fitSms(text, maxSeg = 2) {
  const t = String(text || "");
  if (smsInfo(t).segments <= maxSeg) return t;
  const chars = Array.from(t);
  while (chars.length && smsInfo(chars.join("") + "…").segments > maxSeg) chars.pop();
  return chars.join("").trimEnd() + "…";
}
export const RECOVER_AR = Object.freeze({
  pay_error: "الدفع", account_locked: "قفل الحساب", policy_block: "منع السياسة", spam_limit: "حد الإزعاج", not_registered: "تسجيل الرقم", token: "التوكن", permission: "الصلاحية",
  rate_limit: "تبطيء ميتا", cap_spike: "حد التسويق", health_blocked: "إيقاف الرقم", health_limited: "حد الرقم", quality_red: "الجودة", quality_yellow: "الجودة",
  name_rejected: "الاسم", name_pending: "مراجعة الاسم", phone_status: "حالة الرقم", tier_drop: "الحد", portfolio_drop: "حد المحفظة", account_event: "تنبيه الحساب",
  budget_over: "الميزانية", budget_warn: "الميزانية", budget_pace: "معدّل الصرف", prepaid_out: "الرصيد", prepaid_low: "الرصيد", read_failed: "قراية الحالة",
});
export function alertText({ marker = MARKER_DEFAULT, announce = [], recovered = [], activeCrit = 0 } = {}) {
  const mk = String(marker || MARKER_DEFAULT).trim();
  if (announce.length) {
    const top = announce[0];
    const more = announce.length - 1;
    return fitSms(`${mk} ${top.sms || top.title}${more > 0 ? ` (+${more} تانيين في اللوحة)` : ""}`);
  }
  if (recovered.length) {
    const names = [...new Set(recovered.map((k) => RECOVER_AR[k] || k))].slice(0, 3).join("، ");
    return fitSms(`${mk} رجع تمام: ${names}${activeCrit ? " — لسه فيه مشكلة تانية في اللوحة" : ""}`);
  }
  return "";
}
export function testText(marker = MARKER_DEFAULT) {
  return fitSms(`${String(marker || MARKER_DEFAULT).trim()} رسالة تجربة — تنبيهات صحة واتساب هتوصل على الرقم ده`);
}

/* ── التشغيل ─────────────────────────────────────────────────────────────── */
const mask = (p) => `***${String(p || "").slice(-4)}`;
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const isOwner = ctx.isOwner || (async () => true);
  const cloud = typeof deps.cloud === "function" ? deps.cloud : () => deps.cloud || null;
  const now = deps.now || (() => Date.now());
  const sendSms = typeof deps.sendSms === "function" ? deps.sendSms : null;
  const log = deps.log || console.error;
  const J = (v) => JSON.stringify(v);

  const schemaReady = (async () => {
    /* ver = عدّاد الحجز (مش updated_at: pg بيخزّن ميكروثانية وDate في JS مللي — المقارنة كانت هتفشل دايماً) */
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_health_state (
        id INT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, ver BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ)`);
    await pool.query("INSERT INTO wa_health_state(id, data, ver, updated_at) VALUES (1, '{}'::jsonb, 0, NULL) ON CONFLICT (id) DO NOTHING");
    /* PH1: القوالب اللي اتخطّت وقت الإيقاف (للكارت: كام رسالة ماتبعتتش وليه) */
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_hold_skips (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), hold_key TEXT,
        template TEXT, source TEXT, order_no TEXT, phone_norm TEXT);
      CREATE INDEX IF NOT EXISTS wa_hold_skips_at_idx ON wa_hold_skips(at)`);
  })().catch((e) => { log("[wa-health] schema:", e.message); });

  async function readState() {
    await schemaReady;
    const r = await pool.query("SELECT data, ver::text AS ver, updated_at FROM wa_health_state WHERE id=1");
    const row = r.rows[0] || {};
    return { data: row.data && typeof row.data === "object" ? row.data : {}, ver: String(row.ver ?? "0"), updatedAt: row.updated_at || null };
  }

  async function errorCodes(windowMin) {
    const out = new Map();
    const add = (rows) => { for (const x of rows || []) { const code = Number(x.code); if (!Number.isFinite(code)) continue; const cur = out.get(code) || { code, n: 0, last: null };
      cur.n = Math.max(cur.n, Number(x.n) || 0); const l = x.last ? new Date(x.last).toISOString() : null; if (l && (!cur.last || l > cur.last)) cur.last = l; out.set(code, cur); } };
    try {
      add((await pool.query(`SELECT substring(error from '^([0-9]{1,9})')::int AS code, count(*)::int AS n, max(updated_at) AS last FROM wa_messages
          WHERE direction='out' AND status='failed' AND updated_at > NOW() - ($1::int * INTERVAL '1 minute') AND error ~ '^[0-9]{1,9}(:|$)' GROUP BY 1`, [windowMin])).rows);
    } catch (e) { log("[wa-health] codes(wa_messages):", e.message); }
    try {
      add((await pool.query(`SELECT error_code AS code, count(*)::int AS n, max(COALESCE(tried_at, claimed_at)) AS last FROM wa_send_queue
          WHERE error_code IS NOT NULL AND COALESCE(tried_at, claimed_at) > NOW() - ($1::int * INTERVAL '1 minute') GROUP BY 1`, [windowMin])).rows);
    } catch { /* الجدول/العمود مش موجود على سيرفر قديم */ }
    return [...out.values()];
  }
  async function marketing24() {
    try {
      const r = (await pool.query(`SELECT count(*) FILTER (WHERE status IN ('sent','failed'))::int AS marketing,
              count(*) FILTER (WHERE error_code = ${CAPPED_CODE})::int AS capped FROM wa_send_queue
          WHERE channel='wa_cloud' AND COALESCE(tried_at, claimed_at) > NOW() - INTERVAL '24 hours'`)).rows[0] || {};
      return { marketing: r.marketing || 0, capped: r.capped || 0 };
    } catch { return { marketing: 0, capped: 0 }; }
  }
  /* آخر رسالة طالعة نجحت (ميتا قالت sent/delivered/read) — any: أي رسالة من السيرفر، tpl: قالب (مدفوع). صدى الموبايل والتاريخ مش داخلين.
     بالـcreated_at (إمتى بعتناها) مش updated_at — «اتقرت» لرسالة قديمة مش دليل إن الإرسال رجع. فشل القراية ⇒ null (مانمسكش أكواد) */
  async function okSince() {
    try {
      const r = (await pool.query(`SELECT max(created_at) AS any_at, max(created_at) FILTER (WHERE template IS NOT NULL) AS tpl_at FROM wa_messages
          WHERE direction='out' AND status IN ('sent','delivered','read') AND COALESCE(source,'api') NOT IN ('echo','history') AND created_at > NOW() - INTERVAL '7 days'`)).rows[0] || {};
      const iso = (v) => (v ? new Date(v).toISOString() : null);
      return { any: iso(r.any_at), tpl: iso(r.tpl_at) };
    } catch (e) { log("[wa-health] okSince:", e.message); return null; }
  }
  async function recentEvents() {
    try {
      return (await pool.query(`SELECT kind, event, state, tier, at FROM wa_quality_events WHERE at > NOW() - INTERVAL '48 hours' AND kind IN ('account','phone') ORDER BY id LIMIT 200`)).rows || [];
    } catch { return []; }
  }
  async function pricing(cfg) {
    const cl = cloud();
    if (!cl || typeof cl.graphGet !== "function") return { ok: false, error: "no_reader" };
    const t = now();
    const mStart = Date.parse(`${utcDay(t).slice(0, 7)}-01T00:00:00Z`);
    let start = Math.min(mStart, t - 8 * DAY);
    if (cfg.prepaidSince) start = Math.max(t - 62 * DAY, Math.min(start, Date.parse(`${cfg.prepaidSince}T00:00:00Z`)));
    const end = Date.parse(`${utcDay(t + DAY)}T00:00:00Z`);
    const S = Math.floor(start / 1000), E = Math.floor(end / 1000);
    const field = `pricing_analytics.start(${S}).end(${E}).granularity(DAILY).dimensions(["PRICING_CATEGORY"])`;
    const waba = typeof cl.wabaId === "function" ? cl.wabaId() : null;
    if (!waba) return { ok: false, error: "no_waba" };
    let raw = null, first = null;
    /* الشكل الموثّق: حقل على الـWABA بالـfield expansion؛ ولو اترفض، نفس الطلب كـedge ({waba}/pricing_analytics) — الاتنين بيرجعوا data[].data_points[] */
    try { const d = await cl.graphGet(waba, { fields: field }); raw = d && d.pricing_analytics ? d.pricing_analytics : { data: [] }; }      // مفيش مفتاح = مفيش صرف في الفترة
    catch (e) { first = e; }
    if (!raw) {
      try { raw = await cl.graphGet(`${waba}/pricing_analytics`, { start: String(S), end: String(E), granularity: "DAILY", dimensions: '["PRICING_CATEGORY"]' }); }
      catch { return { ok: false, error: String(first && first.message || first || "pricing_failed").slice(0, 160), code: first && first.code != null ? first.code : null }; }
    }
    /* عملة الحساب (الأسعار بتيجي بيها) — مرة كل ٦ ساعات؛ لو الحقل مش مقروء بنفترض ريال (بطاقة الأسعار عندنا بالريال) */
    if (!curCache.at || t - curCache.at > 6 * 3600_000) {
      try { const c = await cl.graphGet(waba, { fields: "currency" }); curCache = { at: t, cur: /^[A-Z]{3}$/.test(String(c && c.currency || "")) ? c.currency : null }; }
      catch { curCache = { at: t, cur: null }; }
    }
    return { ok: true, currency: curCache.cur, ...parsePricing(raw) };
  }
  let curCache = { at: 0, cur: null };

  async function evaluate(cfg) {
    const st = await readState();
    const prev = st.data || {};
    const cl = cloud();
    let phone = null;
    try { phone = cl && typeof cl.phoneInfo === "function" ? await cl.phoneInfo({ fresh: true }) : { ok: false, error: "no_reader" }; }
    catch (e) { phone = { ok: false, error: String(e.message || e).slice(0, 120) }; }
    const [pr, codes, m24, events] = await Promise.all([pricing(cfg), errorCodes(cfg.errorWindowMin), marketing24(), recentEvents()]);
    const spend = pr.ok ? { ...spendView(pr.days, { now: now(), prepaidSince: cfg.prepaidSince }), currency: pr.currency || null } : null;
    const seen = { tier: prev.tier || null, portfolio: prev.portfolio || null, readFails: Number(prev.readFails) || 0 };
    const fresh = mergeIssues(
      errorIssues(codes, m24, cfg),
      phoneIssues(phone, seen),
      eventIssues(events),
      spendIssues(spend, cfg, { pricingOk: pr.ok, now: now() }),
    );
    /* مراجعة WH1: اللي ماقدرناش نحكم عليه الدورة دي بيفضل زي ما هو (مش «رجع تمام») — شوف carryIssues */
    const prevLast = prev.last && typeof prev.last === "object" ? prev.last : null;
    const freshKeys = new Set(fresh.map((i) => i.key));
    const needOk = Boolean(prevLast && Array.isArray(prevLast.issues) && prevLast.issues.some((i) => i && CODE_KEYS.includes(i.key) && !freshKeys.has(i.key)));
    const issues = mergeIssues(fresh, carryIssues(prevLast, { phoneOk: Boolean(phone && phone.ok), pricingOk: pr.ok, phone, cfg, now: now(), present: fresh,
      okSince: needOk ? await okSince() : null }));
    const pf = phone && phone.ok && phone.portfolio && phone.portfolio.ok ? phone.portfolio.limit : null;
    const snap = {
      level: levelOf(issues), issues, checkedAt: new Date(now()).toISOString(),
      phone: phone && phone.ok ? { health: phone.health || null, healthErrors: phone.healthErrors || [], quality: phone.quality || null, status: phone.status || null,
        tier: phone.tier || null, portfolio: pf, nameStatus: phone.nameStatus || null, name: phone.name || null, number: phone.number || null, throughput: phone.throughput || null }
        : { error: phone ? String(phone.error || phone.code || "unknown").slice(0, 120) : "unknown" },
      spend, spendError: pr.ok ? null : pr.error, codes: codes.sort((a, b) => b.n - a.n).slice(0, 12), marketing24: m24,
    };
    return { snap, prev, st, phone, pf };
  }

  /* ── PH1: حالة الإيقاف (كاش ٢٠ ثانية — الحارس بيسأل مع كل قالب) ── */
  let holdCache = { at: 0, v: null };
  let lastProbeAt = 0;
  async function holdState({ fresh = false } = {}) {
    const t = now();
    if (!fresh && holdCache.v && t - holdCache.at < 20_000) return holdCache.v;
    const cfg = healthCfg(await getSettingsData());
    let v = { ...HOLD_NONE };
    if (cfg.enabled && cfg.payHold) {
      const last = (await readState()).data.last;
      const cand = Boolean(last && Array.isArray(last.issues) && last.issues.some((i) => i && HOLD_KEYS.includes(i.key) && i.level === "crit"));
      if (cand) v = holdVerdict(last, await okSince());
    }
    v = { ...v, on: cfg.enabled && cfg.payHold, probeMin: cfg.probeMin, holdMaxHours: cfg.holdMaxHours, lastProbeAt: lastProbeAt ? new Date(lastProbeAt).toISOString() : null };
    holdCache = { at: t, v };
    return v;
  }
  /* الحارس المركزي (whatsapp.js guardSend) بيسأل قبل أي قالب مش تجربة: null = ابعت · غير كده = اتخطّى بسبب pay_hold (ويتسجّل).
     أي خطأ هنا ⇒ null (الإيقاف تحسين، مش قفل أمان — مايوقّفش الإرسال لو الداتابيز اتلخبطت). */
  async function templateHold({ template = null, category = null, marketing = false, source = null, orderNo = null, phoneNorm = null } = {}) {
    try {
      const v = await holdState();
      if (!v.held) return null;
      if (probeAllowed({ marketing, category }, lastProbeAt, v.probeMin, now())) {
        lastProbeAt = now(); holdCache.at = 0;      // التجربة دي هتحسم: نقرا تاني بدري
        log(`[wa-health] pay hold (${v.key}): probe ${template || "?"}`);
        return null;
      }
      pool.query("INSERT INTO wa_hold_skips(hold_key, template, source, order_no, phone_norm) VALUES ($1,$2,$3,$4,$5)",
        [v.key, template ? String(template).slice(0, 80) : null, source ? String(source).slice(0, 40) : null, orderNo ? String(orderNo).slice(0, 40) : null,
          phoneNorm ? String(phoneNorm).slice(0, 20) : null]).catch(() => {});
      return v;
    } catch (e) { log("[wa-health] hold check:", e.message); return null; }
  }
  async function holdSkips() {
    try {
      const r = await pool.query(`SELECT COALESCE(template,'') AS template, count(*)::int AS n, max(at) AS last FROM wa_hold_skips
          WHERE at > NOW() - INTERVAL '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
      const rows = (r.rows || []).map((x) => ({ template: x.template || null, n: Number(x.n) || 0, last: x.last ? new Date(x.last).toISOString() : null }));
      return { n: rows.reduce((a, x) => a + x.n, 0), byTemplate: rows };
    } catch { return { n: 0, byTemplate: [] }; }
  }

  let running = null;
  async function check({ reason = "timer", force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const s = await getSettingsData();
      const cfg = healthCfg(s);
      if (!cfg.enabled && !force) return { ok: true, skipped: "disabled" };
      const { snap, prev, st, phone, pf } = await evaluate(cfg);
      /* فحص يدوي والمراقبة مقفولة: بنعرض الحالة بس — مفيش تنبيه ولا بنعلّم إنه اتبعت */
      const plan = cfg.enabled ? alertPlan(snap.issues, prev.alerts, cfg, now()) : { announce: [], recovered: [], next: prev.alerts || {} };
      const text = alertText({ marker: cfg.marker, announce: plan.announce, recovered: plan.recovered, activeCrit: snap.issues.filter((i) => i.level === "crit").length });
      const rec = recipientsOf(s, cfg);
      const next = { ...prev, last: snap, alerts: plan.next,
        tier: phone && phone.ok && phone.tier ? phone.tier : prev.tier || null, portfolio: pf || prev.portfolio || null, reason,
        readFails: phone && phone.ok ? 0 : (Number(prev.readFails) || 0) + 1 };
      const willSend = Boolean(text) && cfg.enabled && cfg.sms && rec.phones.length > 0 && Boolean(sendSms);
      /* PH1: قناة تانية للمالك — نفس النص رسالة واتساب حرة (ببلاش) لو نافذته مفتوحة وواتساب نفسه مش هو اللي واقع. الـSMS يفضل الأساسي. */
      const waApi = deps.wa && typeof deps.wa.sendFreeform === "function" ? deps.wa : null;
      const waState = !text ? null : !cfg.enabled ? "watch_off" : !cfg.ownerWa ? "off" : !rec.phones.length ? "no_phones" : !waApi ? "no_sender" : !waUsable(snap.issues) ? "wa_down" : null;
      const willWa = Boolean(text) && !waState;
      if (text) {
        const entry = { at: snap.checkedAt, text, keys: plan.announce.map((i) => i.key), recovered: plan.recovered, to: rec.phones.map(mask), sent: 0,
          skipped: !cfg.enabled ? "watch_off" : !cfg.sms ? "sms_off" : !rec.phones.length ? "no_phones" : !sendSms ? "no_sender" : null,
          wa: { sent: 0, skipped: willWa ? [] : [waState] } };
        next.log = [entry, ...(Array.isArray(prev.log) ? prev.log : [])].slice(0, 30);
      }
      /* الحجز: لو حاوية تانية كتبت بعد ما قرينا ⇒ مانبعتش (هي بعتت أو هتبعت) */
      const claim = await pool.query("UPDATE wa_health_state SET data=$1::jsonb, ver=ver+1, updated_at=NOW() WHERE id=1 AND ver=$2::bigint RETURNING id",
        [J(next), st.ver]);
      if (!claim.rowCount) return { ok: true, skipped: "claimed_elsewhere", state: snap };
      let sent = 0, failed = 0, waSent = 0;
      const waSkip = [];
      if (willSend) {
        for (const p of rec.phones) {
          try { const r = await sendSms({ phoneNorm: p, body: text, kind: "staff", ref: `wa-health ${plan.announce.map((i) => i.key).join(",") || "recovered"}`.slice(0, 80) }); if (!(r && r.suppressed)) sent++; }
          catch (e) { failed++; log(`[wa-health] sms → ${mask(p)} failed: ${e.message}`); }
        }
      }
      if (willWa) {
        for (const p of rec.phones) {
          try {
            const r = await waApi.sendFreeform({ phoneNorm: p, payload: { type: "text", text: { body: text, preview_url: false } }, source: "health", preview: text });
            if (r && r.ok) waSent++; else waSkip.push(String((r && (r.skipped || r.error)) || "failed").slice(0, 40));
          } catch (e) { waSkip.push("error"); log(`[wa-health] wa → ${mask(p)} failed: ${e.message}`); }
        }
      }
      if ((willSend || willWa) && next.log && next.log[0]) {
        if (willSend) { next.log[0].sent = sent; if (failed) next.log[0].failed = failed; }
        if (willWa) next.log[0].wa = { sent: waSent, skipped: [...new Set(waSkip)] };
        /* الـSMS وقع لكل الأرقام (تقنيات واقفة مثلاً) والواتساب ماوصّلش ⇒ نرجّع «اتبعت عن إيه» زي ما كان، فالدورة الجاية تحاول تاني بدل ما التنبيه يضيع ٦ ساعات */
        const revert = willSend && failed === rec.phones.length && waSent === 0;
        await pool.query(`UPDATE wa_health_state SET data = jsonb_set(${revert ? "jsonb_set(data, '{alerts}', $2::jsonb, true)" : "data"}, '{log}', $1::jsonb, true) WHERE id=1`,
          revert ? [J(next.log), J(prev.alerts || {})] : [J(next.log)]).catch(() => {});
      }
      holdCache.at = 0;      // PH1: حالة جديدة ⇒ الحارس يقرا الإيقاف من جديد
      return { ok: true, state: snap, alerted: plan.announce.map((i) => i.key), recovered: plan.recovered, sent, waSent };
    })().catch((e) => { log("[wa-health] check:", e.message); return { ok: false, error: String(e.message || e).slice(0, 200) }; })
      .finally(() => { running = null; });
    return running;
  }

  /* ── المسارات ── */
  async function view(owner) {
    const s = await getSettingsData();
    const cfg = healthCfg(s);
    const st = await readState();
    const rec = recipientsOf(s, cfg);
    const hold = await holdState({ fresh: true }).catch(() => ({ ...HOLD_NONE }));
    return { ok: true, cfg: owner ? cfg : { ...cfg, phones: cfg.phones.map(mask) }, defaults: HEALTH_DEFAULTS, limits: HEALTH_LIMITS, links: LINKS,
      recipients: { phones: rec.phones.map(mask), source: rec.source, sourceAr: SOURCE_AR[rec.source] || rec.source },
      state: st.data.last || null, log: (Array.isArray(st.data.log) ? st.data.log : []).slice(0, 10), alerts: st.data.alerts || {}, owner,
      hold: { ...hold, skipped24h: await holdSkips() } };
  }
  app.get("/api/cms/wa-health", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json(await view(Boolean(await isOwner(c)))); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });
  /* «افحص دلوقتي»: قراية من ميتا + نفس قواعد التنبيه (مابيبعتش حاجة اتبعتت قبل كده) */
  app.post("/api/cms/wa-health/check", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const r = await check({ reason: "manual", force: true });
    if (!r.ok) return c.json(r);
    return c.json({ ...(await view(Boolean(await isOwner(c)))), alerted: r.alerted || [], recovered: r.recovered || [], sent: r.sent || 0, skipped: r.skipped || null });
  });
  app.post("/api/cms/wa-health/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "إعدادات تنبيه واتساب للمالك بس" }, 403);
    const b = await c.req.json().catch(() => ({}));
    const s = await getSettingsData();
    const cur = s.waHealth && typeof s.waHealth === "object" ? s.waHealth : {};
    const nx = { ...cur };
    for (const k of HEALTH_KEYS) if (b[k] !== undefined) nx[k] = b[k];
    if (b.phones !== undefined) {
      const raw = Array.isArray(b.phones) ? b.phones : String(b.phones || "").split(/[\s,،;]+/).filter(Boolean);
      const bad = raw.filter((p) => !normStaffPhone(p));
      if (bad.length) return c.json({ ok: false, error: "bad_phone", message: `رقم مش سعودي صحيح (05XXXXXXXX): ${bad.slice(0, 3).map((p) => String(p).slice(-4)).join("، ")}` });
      if (raw.length > 5) return c.json({ ok: false, error: "too_many_phones", message: "أقصى ٥ أرقام" });
    }
    if (b.prepaidSince !== undefined && b.prepaidSince !== "" && !okDay(b.prepaidSince)) return c.json({ ok: false, error: "bad_date", message: "يوم الشحن لازم YYYY-MM-DD" });
    const clean = healthCfg({ waHealth: nx });
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{waHealth}', $1::jsonb, true) WHERE id=1`, [J(clean)]);
    return c.json(await view(true));
  });
  /* رسالة تجربة لأرقام التنبيه — المالك بس */
  app.post("/api/cms/wa-health/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "المالك بس" }, 403);
    if (!sendSms) return c.json({ ok: false, error: "no_sender" });
    const s = await getSettingsData();
    const cfg = healthCfg(s);
    const rec = recipientsOf(s, cfg);
    if (!rec.phones.length) return c.json({ ok: false, error: "no_phones", message: "مفيش رقم تنبيه — اكتب رقمك" });
    let sent = 0;
    for (const p of rec.phones) {
      /* «test» بيعدّي بوابة رسايل الإدارة دايماً (staffcontrol) — التجربة توصل حتى لو النوع مقفول */
      try { const r = await sendSms({ phoneNorm: p, body: testText(cfg.marker), kind: "staff", ref: "test" }); if (!(r && r.suppressed)) sent++; }
      catch (e) { log(`[wa-health] test → ${mask(p)}: ${e.message}`); }
    }
    /* PH1: نفس التجربة على واتساب (رسالة حرة) لو «التنبيه على واتساب» شغّال — بتوصل بس لو نافذة الرقم مفتوحة */
    const wa = { sent: 0, skipped: [] };
    if (cfg.ownerWa && deps.wa && typeof deps.wa.sendFreeform === "function") {
      for (const p of rec.phones) {
        try { const r = await deps.wa.sendFreeform({ phoneNorm: p, payload: { type: "text", text: { body: testText(cfg.marker), preview_url: false } }, source: "health", preview: testText(cfg.marker) });
          if (r && r.ok) wa.sent++; else wa.skipped.push(String((r && (r.skipped || r.error)) || "failed").slice(0, 40)); }
        catch { wa.skipped.push("error"); }
      }
      wa.skipped = [...new Set(wa.skipped)];
    } else wa.skipped = [cfg.ownerWa ? "no_sender" : "off"];
    return c.json({ ok: sent > 0 || wa.sent > 0, sent, wa, to: rec.phones.map(mask), text: testText(cfg.marker) });
  });

  /* ── الجدولة: كل everyMin دقيقة، وفحص سريع (بعد دقيقة) لما ويب هوك ييجي بغلطة خطيرة أو حدث حساب/جودة ── */
  /* فحص سريع بعد دقيقة من أول غلطة خطيرة — ومرة كل ٥ دقايق بالكتير وقت عاصفة أخطاء (كل حالة فاشلة بتيجي ويب هوك) */
  let soon = null, lastKick = 0;
  const kick = (why) => {
    if (soon || now() - lastKick < 5 * 60_000) return;
    lastKick = now();
    soon = setTimeout(() => { soon = null; check({ reason: why }).catch(() => {}); }, 60_000); if (soon.unref) soon.unref();
  };
  const wa = deps.wa || null;
  if (wa && typeof wa.on === "function") {
    wa.on("status", (s) => { const code = Number(s && s.code); if (Number.isFinite(code) && (CRIT_CODES.includes(code))) kick(`webhook ${code}`); });
    wa.on("quality", (ev) => { if (ev && (ev.kind === "account" || ev.kind === "phone")) kick(`webhook ${ev.kind}`); });
  }
  if (deps.schedule !== false && process.env.WA_HEALTH_SCHEDULER !== "0") {
    let lastRun = 0;
    const tick = async () => {
      try {
        const cfg = healthCfg(await getSettingsData());
        if (cfg.enabled && now() - lastRun >= cfg.everyMin * 60_000 - 5_000) { lastRun = now(); await check({ reason: "timer" }); }
      } catch (e) { log("[wa-health] tick:", e.message); }
    };
    const t0 = setTimeout(() => { tick(); const iv = setInterval(tick, 60_000); if (iv.unref) iv.unref(); }, 90_000);
    if (t0.unref) t0.unref();
  }
  return { check, view, evaluate, readState, holdState, templateHold };
}
