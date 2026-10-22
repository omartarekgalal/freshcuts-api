/* ═══════════════════════════════════════════════════════════════════════════
   🧭 OPS1 — تقرير الوردية + كارت أداء الفريق + «قفل من غير رد» + checklist الوردية (عمر ٢٢/١٠:
   «عالجلي مشاكل التشغيل وقصور الموظفين المدير او الكاشير ضروري جداا … مش عايز اي اخطاء»)

   اللي القياس قاله (آخر ١٤ يوم، ٨/١٠ → ٢١/١٠ — التقرير: freshcuts invite/docs/designs-2026-10/ops/ops-review-2026-10-22.md):
     • قبول الطلب كويس (٩٦٪ خلال دقيقتين) — بس مفيش حد بيشوف «الصورة الكاملة» آخر الوردية: مين ساب تحويل واتساب من غير رد،
       مين قفل محادثة من غير ما يكتب حرف، كام كابتن استنّانا، كام طلب عدّى ٣٠ د، كام فاتورة كاشير من غير عميل.
     • ٣٥ من ٧١ «استلام» محادثة اتقفلت من غير ولا رسالة مكتوبة (لا من البوابة ولا من تطبيق واتساب على الجهاز)، ومفيش أي تنبيه
       بيطلع لما ده يحصل: تنبيه «استلم وسكت» (wabotrun) بيشتغل بس والمحادثة لسه مستلمة — «خلصت» بعد ٦ ثواني بيقفله.
     • حساب البوابة للكاشير واحد مشترك («الكاشير») — فحاجات الكاشير مابتتنسبش لشخص. (قرار للمالك: PIN لكل كاشير.)

   الملف ده (قراءة بس من الجداول الموجودة + ٣ جداول صغيرة جديدة، ومفيش أي إرسال إلا لو المالك فتحه من اللوحة):
     ١) buildReport(window): «تقرير الوردية» لأي فترة (وردية / يوم تشغيلي) — الطلبات، القبول، التحضير، الكابتن، تحويلات واتساب
        والرد عليها، «قفل من غير رد»، التقييمات الواطية، حضور البوابة، تنبيهات «البورتال مقفول»، فواتير الكاشير من غير عميل،
        الفويد/المرتجع، تنبيهات الفريق، نداءات الطاولات، مشاكل المندوب، checklist الوردية، والمفتوح دلوقتي. كل مصدر لوحده: مصدر وقع
        ⇒ «غير متاح» مش صفر. + «أهم الحاجات» (flags) بالأولوية.
     ٢) الجدولة (settings.opsReport.enabled — مقفولة افتراضياً): تقرير آخر كل وردية (shifts) + كارت اليوم (dailyAt) للأدوار اللي
        المالك يختارها من دليل الفريق (المدير والمالك افتراضياً): واتساب حر ببلاش لو النافذة مفتوحة ⇒ SMS قصيرة (نفس طريقة
        رسالة الدخل revpulse.js). حجز ذري لكل (يوم، ميعاد) في ops_report_log ⇒ حاويتين وقت النشر مايبعتوش مرتين؛ ميعاد فات عليه
        أكتر من graceMin (السيرفر كان واقف) مابيتبعتش متأخر.
     ٣) «قفل من غير رد» (silent close): كل دقيقة — محادثة اتعلّم عليها «خلصت» (wa_chat_owner_log done) أو تحويل اتعلّم عليه «تم»
        (wa_handovers.acked_by شخص) ومفيش ولا رسالة مكتوبة من الفريق (wa_staff_replies أو echo من تطبيق واتساب) من ساعة الاستلام/
        التحويل لحد القفل + silentGraceMin (ومفيش ملاحظة اتكتبت وهو بيقفل، زي «كلّمته تليفون») ⇒ يتسجّل في ops_silent_closes (يظهر في التقرير باسم اللي قفل). لو silentAlert شغّال ⇒
        إشعار لأجهزة دور المدير على البوابة (+ واتساب حر للأدوار المختارة لو silentAlertWa). «مش عميل» (outcome not_customer) وتحويلات
        التقييمات (ليها مسارها) مابتتحسبش. حد أقصى للتنبيهات في الساعة.
     ٤) checklist الوردية من البوابة: GET/POST /api/portal/shift (بداية/نهاية الوردية + بنود من اللوحة + فرق الكاش اختياري). السيرفر
        بيقارن اللي اتعلّم عليه بالحقيقة (تحويلات مفتوحة / طلبات أونلاين لسه ماخلصتش) ويسجّل «اتعلّم عليه وهو مش صح» — مايمنعش الحفظ.
   المسارات:
     GET  /api/cms/ops-report                 (اللوحة، قسم «الطلبات») ?day=YYYY-MM-DD&shift=<key> | from&to — التقرير + النص + الإعدادات + السجل
     POST /api/cms/ops-report/settings        (المالك) حفظ المفاتيح اللي اتبعتت بس
     POST /api/cms/ops-report/test            (المالك) تقرير دلوقتي لأرقام المالك بس (🧪) — مابيحجزش ميعاد
     GET  /api/portal/ops-report              (البوابة — المدير بس) تقرير الوردية الحالية
     GET/POST /api/portal/shift               (البوابة) checklist الوردية
   صافي قدر الإمكان: الحسابات والنصوص من غير قاعدة (متختبرة)، والـSQL معلّم بعلامة ops:… عشان القاعدة الوهمية في الاختبار.
═══════════════════════════════════════════════════════════════════════════ */
import { bizDay, bizStart, DAY_RE } from "./bizday.js";
import { smsInfo, staffPhones } from "./staffalerts.js";
import { kpiTargets, PAID_AT, PAID_JOIN, AUTO_BY } from "./staffkpi.js";

const MIN = 60_000;
const DAY_MIN = 24 * 60;
export const ROLL_HOUR = 4;                                      // قطع اليوم التشغيلي (bizday.js)
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const REPORT_ROLES = Object.freeze(["manager", "owner", "cashier"]);
export const PUSH_ROLES = Object.freeze(["manager", "cashier"]);   // أدوار ليها أجهزة بوابة
const ROLE_AR = Object.freeze({ manager: "المدير", owner: "المالك", cashier: "الكاشير", kitchen: "المطبخ" });

/* ── الإعدادات (settings.opsReport — اللوحة ← الطلبات ← «تقرير الوردية»، الحفظ للمالك) ───────────────── */
export const DEFAULT_SHIFTS = Object.freeze([
  Object.freeze({ key: "s1", name: "الوردية الأولى", from: "11:00", to: "19:00" }),
  Object.freeze({ key: "s2", name: "الوردية التانية", from: "19:00", to: "03:00" }),
]);
export const DEFAULT_CHECK_START = Object.freeze([
  Object.freeze({ key: "portal_open", label: "البوابة مفتوحة على التابلت والصوت شغّال" }),
  Object.freeze({ key: "pos_ok", label: "نقطة البيع والطابعة شغّالين وفيه ورق" }),
  Object.freeze({ key: "open_items", label: "راجعت التحويلات والتقييمات المفتوحة من الوردية اللي فاتت" }),
  Object.freeze({ key: "soldout", label: "حدّثت الأصناف الخلصانة على البوابة" }),
]);
export const DEFAULT_CHECK_END = Object.freeze([
  Object.freeze({ key: "no_open_handovers", label: "مفيش تحويل واتساب مفتوح من غير رد" }),
  Object.freeze({ key: "no_open_orders", label: "كل طلبات الأونلاين اتقفلت (جاهز / اتسلّم)" }),
  Object.freeze({ key: "cash_counted", label: "عدّيت الكاش وطابقته مع تقرير نقطة البيع" }),
  Object.freeze({ key: "handover_note", label: "سلّمت الوردية الجاية وكتبت الملاحظات" }),
]);
/* بنود ليها «حقيقة» عند السيرفر — لو اتعلّم عليها وهي مش صح ⇒ mismatch */
export const VERIFIED_ITEMS = Object.freeze({ no_open_handovers: "openHandovers", no_open_orders: "openOrders" });

export const OPS_DEFAULTS = Object.freeze({
  enabled: false,              // الإرسال المجدول كله (تقرير الوردية + كارت اليوم). مقفول لحد ما المالك يفتحه — الشاشة شغّالة من غيره
  shiftReport: true,           // تقرير آخر كل وردية
  dailyReport: true,           // كارت اليوم كله
  dailyAt: "03:30",            // ميعاد كارت اليوم (من ٠٤:٠٠ لـ١٠:٥٩ ⇒ عن امبارح، غير كده ⇒ عن اليوم التشغيلي الحالي)
  sendDelayMin: 10,            // تقرير الوردية بعد نهايتها بالدقايق دي (عشان آخر طلب يتقفل)
  roles: ["manager", "owner"], // مين يستلم (من دليل الفريق waTeam.members)
  wa: true,                    // واتساب حر ببلاش لو نافذة الرقم مفتوحة
  sms: true,                   // SMS لو النافذة مقفولة
  smsMaxParts: 3,
  graceMin: 60,                // ميعاد فات عليه أكتر من كده (السيرفر كان واقف) مابيتبعتش
  shifts: DEFAULT_SHIFTS,
  captainWaitMin: 10,          // «الكابتن استنّانا» أكتر من كده = مشكلة (العقد: التسليم خلال ١٠ د من الإسناد)
  presenceMinPerShift: 240,    // دقايق البوابة «الظاهرة» المتوقعة لكل وردية — أقل ⇒ سطر في «أهم الحاجات» (كارت اليوم)
  silentEnabled: true,         // رصد «قفل من غير رد» وتسجيله (من غير إرسال)
  silentGraceMin: 3,           // مهلة بعد القفل لأول رسالة مكتوبة قبل ما يتحسب «من غير رد»
  silentAlert: false,          // إشعار لأجهزة البوابة بتاعة silentAlertRoles لما يحصل
  silentAlertWa: false,        // + واتساب حر (من غير SMS) لنفس الأدوار من دليل الفريق
  silentAlertRoles: ["manager"],
  silentMaxPerHour: 6,
  checklistEnabled: true,      // checklist الوردية على البوابة
  checklistStart: DEFAULT_CHECK_START,
  checklistEnd: DEFAULT_CHECK_END,
  cashDiffAsk: true,           // خانة «فرق الكاش» عند نهاية الوردية (اختيارية)
});
export const OPS_KEYS = Object.freeze(Object.keys(OPS_DEFAULTS));
export const OPS_LIMITS = Object.freeze({
  sendDelayMin: [0, 90], smsMaxParts: [1, 6], graceMin: [15, 180], captainWaitMin: [5, 60], presenceMinPerShift: [0, 720],
  silentGraceMin: [1, 30], silentMaxPerHour: [1, 30],
});
export const LIMITS = Object.freeze({ shifts: 4, checklist: 10, label: 90, name: 40, note: 500, cashDiff: 100000 });
export const LABELS = Object.freeze({
  enabled: "إرسال التقارير المجدول", shiftReport: "تقرير آخر كل وردية", dailyReport: "كارت اليوم", dailyAt: "ميعاد كارت اليوم",
  sendDelayMin: "بعد نهاية الوردية بـ", roles: "المستلمين", wa: "واتساب ببلاش لو النافذة مفتوحة", sms: "SMS لو النافذة مقفولة",
  smsMaxParts: "أقصى أجزاء الـSMS", graceMin: "أقصى تأخير للميعاد", shifts: "الورديات", captainWaitMin: "الكابتن استنّانا أكتر من",
  presenceMinPerShift: "دقايق البوابة المتوقعة لكل وردية", silentEnabled: "رصد «قفل من غير رد»", silentGraceMin: "مهلة أول رسالة بعد القفل",
  silentAlert: "إشعار البوابة عند «قفل من غير رد»", silentAlertWa: "+ واتساب للمستلمين", silentAlertRoles: "مين يتنبّه",
  silentMaxPerHour: "أقصى تنبيهات «قفل من غير رد» في الساعة", checklistEnabled: "checklist الوردية", checklistStart: "بنود بداية الوردية",
  checklistEnd: "بنود نهاية الوردية", cashDiffAsk: "خانة فرق الكاش",
});

const clampN = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" && typeof v !== "boolean" ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const normHHMM = (s, d) => { const m = HHMM_RE.exec(String(s ?? "").trim()); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : d; };
export const bizIdx = (h) => ((Number(h) - ROLL_HOUR) % 24 + 24) % 24;              // ٤ الفجر = ٠ … ٣ الفجر = ٢٣
export const bizMinOfHHMM = (s) => { const [h, m] = String(s).split(":").map(Number); return bizIdx(h) * 60 + m; };
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const keyOk = (k) => /^[a-z0-9_]{1,30}$/.test(String(k || ""));
const bool = (v, d) => (typeof v === "boolean" ? v : d);

function normItems(list, def) {
  if (!Array.isArray(list)) return def.map((x) => ({ ...x }));
  const seen = new Set(), out = [];
  for (const it of list.slice(0, LIMITS.checklist)) {
    const label = clip(it && it.label, LIMITS.label);
    let key = it && keyOk(it.key) ? it.key : null;
    if (!label) continue;
    if (!key) key = `i${out.length + 1}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ key, label });
  }
  return out;
}
function normShifts(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_SHIFTS.map((x) => ({ ...x }));
  const out = [], seen = new Set();
  for (const s of list.slice(0, LIMITS.shifts)) {
    const from = normHHMM(s && s.from, null), to = normHHMM(s && s.to, null);
    if (!from || !to) continue;
    const key = s && keyOk(s.key) ? s.key : `s${out.length + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: clip(s.name, LIMITS.name) || `الوردية ${out.length + 1}`, from, to });
  }
  return out.length ? out : DEFAULT_SHIFTS.map((x) => ({ ...x }));
}
export function opsCfg(settings) {
  const raw = settings && settings.opsReport && typeof settings.opsReport === "object" && !Array.isArray(settings.opsReport) ? settings.opsReport : {};
  const D = OPS_DEFAULTS, L = OPS_LIMITS;
  const roles = (arr, allowed, def) => { const r = Array.isArray(arr) ? [...new Set(arr.filter((x) => allowed.includes(x)))] : def; return r; };
  return {
    enabled: bool(raw.enabled, D.enabled), shiftReport: bool(raw.shiftReport, D.shiftReport), dailyReport: bool(raw.dailyReport, D.dailyReport),
    dailyAt: normHHMM(raw.dailyAt, D.dailyAt), sendDelayMin: clampN(raw.sendDelayMin, L.sendDelayMin, D.sendDelayMin),
    roles: roles(raw.roles, REPORT_ROLES, [...D.roles]), wa: bool(raw.wa, D.wa), sms: bool(raw.sms, D.sms),
    smsMaxParts: clampN(raw.smsMaxParts, L.smsMaxParts, D.smsMaxParts), graceMin: clampN(raw.graceMin, L.graceMin, D.graceMin),
    shifts: normShifts(raw.shifts), captainWaitMin: clampN(raw.captainWaitMin, L.captainWaitMin, D.captainWaitMin),
    presenceMinPerShift: clampN(raw.presenceMinPerShift, L.presenceMinPerShift, D.presenceMinPerShift),
    silentEnabled: bool(raw.silentEnabled, D.silentEnabled), silentGraceMin: clampN(raw.silentGraceMin, L.silentGraceMin, D.silentGraceMin),
    silentAlert: bool(raw.silentAlert, D.silentAlert), silentAlertWa: bool(raw.silentAlertWa, D.silentAlertWa),
    silentAlertRoles: roles(raw.silentAlertRoles, REPORT_ROLES, [...D.silentAlertRoles]),
    silentMaxPerHour: clampN(raw.silentMaxPerHour, L.silentMaxPerHour, D.silentMaxPerHour),
    checklistEnabled: bool(raw.checklistEnabled, D.checklistEnabled),
    checklistStart: normItems(raw.checklistStart, D.checklistStart), checklistEnd: normItems(raw.checklistEnd, D.checklistEnd),
    cashDiffAsk: bool(raw.cashDiffAsk, D.cashDiffAsk),
  };
}

/* فحص الحفظ ⇒ رسالة عربي أو null. b = المفاتيح اللي اتبعتت بس. */
export function settingsProblem(b) {
  for (const k of Object.keys(OPS_LIMITS)) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]); const [lo, hi] = OPS_LIMITS[k];
    if (!(Number.isInteger(n) && n >= lo && n <= hi) || typeof b[k] === "boolean" || b[k] === "") return `«${LABELS[k]}» لازم رقم صحيح من ${lo} لـ${hi}`;
  }
  for (const k of ["enabled", "shiftReport", "dailyReport", "wa", "sms", "silentEnabled", "silentAlert", "silentAlertWa", "checklistEnabled", "cashDiffAsk"]) {
    if (b[k] !== undefined && typeof b[k] !== "boolean") return `«${LABELS[k]}» لازم تشغيل/إيقاف`;
  }
  if (b.dailyAt !== undefined && !HHMM_RE.test(String(b.dailyAt || "").trim())) return "ميعاد كارت اليوم لازم ساعة:دقيقة (مثلاً 03:30)";
  for (const k of ["roles", "silentAlertRoles"]) {
    if (b[k] === undefined) continue;
    if (!Array.isArray(b[k]) || b[k].some((r) => !REPORT_ROLES.includes(r))) return `«${LABELS[k]}»: اختار من المدير / المالك / الكاشير`;
  }
  if (b.shifts !== undefined) {
    if (!Array.isArray(b.shifts) || !b.shifts.length) return "لازم وردية واحدة على الأقل";
    if (b.shifts.length > LIMITS.shifts) return `أقصى ${LIMITS.shifts} ورديات`;
    const spans = [];
    for (const [i, s] of b.shifts.entries()) {
      const from = normHHMM(s && s.from, null), to = normHHMM(s && s.to, null);
      if (!from || !to) return `الوردية ${i + 1}: البداية والنهاية لازم ساعة:دقيقة`;
      const a = bizMinOfHHMM(from), z = bizMinOfHHMM(to);
      if (z <= a) return `الوردية ${i + 1} (${from} ← ${to}): النهاية لازم بعد البداية في نفس اليوم التشغيلي (من ٤ الفجر لـ٤ الفجر)`;
      spans.push([a, z, i]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) return `الورديتين ${spans[i - 1][2] + 1} و${spans[i][2] + 1} داخلين في بعض`;
  }
  for (const k of ["checklistStart", "checklistEnd"]) {
    if (b[k] === undefined) continue;
    if (!Array.isArray(b[k])) return `«${LABELS[k]}» لازم قايمة`;
    if (b[k].length > LIMITS.checklist) return `«${LABELS[k]}»: أقصى ${LIMITS.checklist} بنود`;
    if (b[k].some((it) => !clip(it && it.label, LIMITS.label))) return `«${LABELS[k]}»: كل بند لازم له نص`;
  }
  return null;
}

/* ── الفترات ───────────────────────────────────────────────────────────── */
export const bizMinNow = (t) => Math.floor((Number(t) - bizStart(bizDay(t)).getTime()) / MIN);
/* فترة وردية في يوم تشغيلي ⇒ { start, end } (ISO) */
export function shiftWindow(day, shift) {
  const s0 = bizStart(day).getTime();
  return { start: new Date(s0 + bizMinOfHHMM(shift.from) * MIN).toISOString(), end: new Date(s0 + bizMinOfHHMM(shift.to) * MIN).toISOString() };
}
export function dayWindow(day) {
  const s0 = bizStart(day).getTime();
  return { start: new Date(s0).toISOString(), end: new Date(s0 + DAY_MIN * MIN).toISOString() };
}
/* الوردية اللي فيها لحظة t (أو null) */
export function shiftAt(t, cfg) {
  const m = bizMinNow(t);
  return cfg.shifts.find((s) => m >= bizMinOfHHMM(s.from) && m < bizMinOfHHMM(s.to)) || null;
}
const prevDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
/* مواعيد الإرسال لليوم التشغيلي الحالي: [{ key, kind: shift|daily, dueMin, target: day, shift? }] */
export function slotsOf(t, cfg) {
  const day = bizDay(t), out = [];
  if (cfg.shiftReport) for (const s of cfg.shifts) out.push({ key: `shift:${s.key}`, kind: "shift", dueMin: Math.min(DAY_MIN - 1, bizMinOfHHMM(s.to) + cfg.sendDelayMin), target: day, shift: s });
  if (cfg.dailyReport) {
    const m = bizMinOfHHMM(cfg.dailyAt);
    /* ٠٤:٠٠–١٠:٥٩ ⇒ اليوم اللي فات (الصبح بدري قبل الفتح) — غير كده ⇒ اليوم الحالي لحد الميعاد */
    out.push({ key: "daily", kind: "daily", dueMin: m, target: m < bizIdx(11) * 60 ? prevDay(day) : day });
  }
  return out.sort((a, b) => a.dueMin - b.dueMin);
}
/* الميعاد اللي عليه الدور: عدّى ولسه جوّه graceMin ومش متسجّل (done = Set من `${target}|${key}`) */
export function dueSlots(t, cfg, done = new Set()) {
  const m = bizMinNow(t);
  return slotsOf(t, cfg).filter((s) => s.dueMin <= m && m - s.dueMin <= cfg.graceMin && !done.has(`${s.target}|${s.key}`));
}
export function nextSlot(t, cfg) {
  const m = bizMinNow(t);
  const s = slotsOf(t, cfg).find((x) => x.dueMin > m);
  if (!s) return null;
  return { key: s.key, kind: s.kind, target: s.target, at: new Date(bizStart(bizDay(t)).getTime() + s.dueMin * MIN).toISOString() };
}

/* ── SQL (قراية بس) ── $1 = البداية · $2 = النهاية (حصرية) ─────────────────── */
const HUMAN_ECHO = `m.direction = 'out' AND m.source = 'echo' AND COALESCE(m.echo_kind, 'staff') <> 'auto'`;
export const SQL = Object.freeze({
  orders: `/*ops:orders*/ SELECT o.order_no, o.option, o.status, o.total, ${PAID_AT} AS paid_at, o.accepted_at, o.portal_ack_at, o.portal_ack_by,
      o.pos_ready_at, o.collected_at, o.handed_at, o.scheduled_for, o.created_at
    FROM shop_orders o ${PAID_JOIN}
    WHERE NOT COALESCE(o.is_test, false) AND o.status NOT IN ('pending_payment','expired') AND o.created_at >= $1 AND o.created_at < $2
    ORDER BY o.created_at LIMIT 600`,
  escalations: `/*ops:escalations*/ SELECT order_no, step, stop_reason, stopped_after_sec FROM shop_ack_escalations WHERE step > 0 AND started_at >= $1 AND started_at < $2`,
  breaches: `/*ops:breaches*/ SELECT order_no, code, over_min::float AS over_min, claimable FROM dl_sla_breaches
    WHERE NOT COALESCE(is_test, false) AND started_at >= $1 AND started_at < $2`,
  handovers: `/*ops:handovers*/ SELECT h.id, h.reason, h.at, h.acked_at, h.acked_by, right(h.phone_norm, 4) AS ref4,
      LEAST((SELECT min(x.at) FROM wa_staff_replies x WHERE x.phone_norm = h.phone_norm AND NOT x.test AND x.at > h.at),
            (SELECT min(m.created_at) FROM wa_messages m WHERE m.phone_norm = h.phone_norm AND ${HUMAN_ECHO} AND m.created_at > h.at)) AS first_reply_at
    FROM wa_handovers h WHERE NOT h.test AND h.at >= $1 AND h.at < $2 ORDER BY h.at LIMIT 400`,
  /* «قفل من غير رد»: $3 = المهلة بالدقايق. since = آخر «استلم» قبل القفل (١٢ س) وإلا آخر تحويل (٢٤ س) وإلا القفل − ٣٠ د.
     human = رسايل الفريق المكتوبة (البوابة/اللوحة + تطبيق واتساب على الجهاز) من since − ٢ د لحد القفل + المهلة. */
  silentDone: `/*ops:silentDone*/ SELECT l.id, l.at, l.by_name, l.role, l.phone_norm, w.since,
      (SELECT f.last_close->>'outcome' FROM wa_flow f WHERE f.phone_norm = l.phone_norm AND f.last_close IS NOT NULL
         AND (f.last_close->>'at') ~ '^[0-9]{4}-' AND abs(EXTRACT(EPOCH FROM ((f.last_close->>'at')::timestamptz - l.at))) < 300 LIMIT 1) AS outcome,
      (SELECT f.last_close->>'note' FROM wa_flow f WHERE f.phone_norm = l.phone_norm AND f.last_close IS NOT NULL
         AND (f.last_close->>'at') ~ '^[0-9]{4}-' AND abs(EXTRACT(EPOCH FROM ((f.last_close->>'at')::timestamptz - l.at))) < 300 LIMIT 1) AS close_note,
      (SELECT h.reason FROM wa_handovers h WHERE h.phone_norm = l.phone_norm AND NOT h.test AND h.at <= l.at AND h.at > l.at - interval '24 hours' ORDER BY h.at DESC LIMIT 1) AS reason,
      ((SELECT count(*) FROM wa_staff_replies x WHERE x.phone_norm = l.phone_norm AND NOT x.test AND x.at >= w.since - interval '2 minutes' AND x.at <= l.at + make_interval(mins => $3::int))
       + (SELECT count(*) FROM wa_messages m WHERE m.phone_norm = l.phone_norm AND ${HUMAN_ECHO} AND m.created_at >= w.since - interval '2 minutes' AND m.created_at <= l.at + make_interval(mins => $3::int)))::int AS human
    FROM wa_chat_owner_log l
    CROSS JOIN LATERAL (SELECT COALESCE(
        (SELECT max(t.at) FROM wa_chat_owner_log t WHERE t.phone_norm = l.phone_norm AND t.action = 'take' AND t.at <= l.at AND t.at > l.at - interval '12 hours'),
        (SELECT max(h.at) FROM wa_handovers h WHERE h.phone_norm = l.phone_norm AND NOT h.test AND h.at <= l.at AND h.at > l.at - interval '24 hours'),
        l.at - interval '30 minutes') AS since) w
    WHERE l.action = 'done' AND l.by_name IS NOT NULL AND l.at >= $1 AND l.at < $2 ORDER BY l.at LIMIT 300`,
  silentAck: `/*ops:silentAck*/ SELECT h.id, h.acked_at AS at, h.acked_by AS by_name, NULL::text AS role, h.phone_norm, h.at AS since, h.reason,
      (SELECT f.last_close->>'outcome' FROM wa_flow f WHERE f.phone_norm = h.phone_norm AND f.last_close IS NOT NULL
         AND (f.last_close->>'at') ~ '^[0-9]{4}-' AND abs(EXTRACT(EPOCH FROM ((f.last_close->>'at')::timestamptz - h.acked_at))) < 300 LIMIT 1) AS outcome,
      (SELECT f.last_close->>'note' FROM wa_flow f WHERE f.phone_norm = h.phone_norm AND f.last_close IS NOT NULL
         AND (f.last_close->>'at') ~ '^[0-9]{4}-' AND abs(EXTRACT(EPOCH FROM ((f.last_close->>'at')::timestamptz - h.acked_at))) < 300 LIMIT 1) AS close_note,
      ((SELECT count(*) FROM wa_staff_replies x WHERE x.phone_norm = h.phone_norm AND NOT x.test AND x.at >= h.at - interval '2 minutes' AND x.at <= h.acked_at + make_interval(mins => $3::int))
       + (SELECT count(*) FROM wa_messages m WHERE m.phone_norm = h.phone_norm AND ${HUMAN_ECHO} AND m.created_at >= h.at - interval '2 minutes' AND m.created_at <= h.acked_at + make_interval(mins => $3::int)))::int AS human
    FROM wa_handovers h WHERE NOT h.test AND h.acked_at IS NOT NULL AND h.acked_by IS NOT NULL AND h.acked_at >= $1 AND h.acked_at < $2 ORDER BY h.acked_at LIMIT 300`,
  reviews: `/*ops:reviews*/ SELECT r.id, r.rating, r.created_at, r.resolved, r.resolved_at, r.portal_seen_at,
      (SELECT min(a.at) FROM review_actions a WHERE a.review_id = r.id) AS first_action_at,
      (SELECT a.by_name FROM review_actions a WHERE a.review_id = r.id ORDER BY a.at LIMIT 1) AS first_by
    FROM reviews r WHERE r.rating < 4 AND NOT COALESCE(r.is_test, false) AND r.hidden_at IS NULL AND r.created_at >= $1 AND r.created_at < $2 ORDER BY r.created_at LIMIT 200`,
  presence: `/*ops:presence*/ SELECT staff_id, staff_name, role, minutes, visible_minutes FROM portal_presence_day WHERE day = $1::date`,
  offline: `/*ops:offline*/ SELECT kind, count(*)::int AS n FROM wa_team_log WHERE topic = 'portal_offline' AND ok AND kind IN ('cashier','manager','back')
    AND at >= $1 AND at < $2 GROUP BY kind`,
  pos: `/*ops:pos*/ SELECT staff_name, order_type, order_option, customer_id IS NOT NULL AS has_cust, total::float AS total
    FROM ts_orders WHERE order_date >= $1 AND order_date < $2 LIMIT 3000`,
  notices: `/*ops:notices*/ SELECT role, count(*)::int AS n, count(acked_at)::int AS acked,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (acked_at - at)) / 60.0)::float AS med
    FROM wa_team_notices WHERE at >= $1 AND at < $2 GROUP BY role`,
  tableCalls: `/*ops:tableCalls*/ SELECT count(*)::int AS n, count(done_at)::int AS done,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (done_at - created_at)) / 60.0)::float AS med
    FROM table_calls WHERE created_at >= $1 AND created_at < $2`,
  incidents: `/*ops:incidents*/ SELECT kind, resolution, resolved_by, resolved_at IS NULL AS open FROM dl_courier_incidents WHERE detected_at >= $1 AND detected_at < $2`,
  shiftLog: `/*ops:shiftLog*/ SELECT id, at, staff_id, staff_name, role, action, shift_key, missing, mismatch, cash_diff::float AS cash_diff, note
    FROM portal_shift_log WHERE at >= $1 AND at < $2 ORDER BY at`,
  openNow: `/*ops:openNow*/ SELECT
      (SELECT count(*) FROM wa_handovers WHERE NOT test AND acked_at IS NULL AND at > NOW() - interval '24 hours')::int AS handovers,
      (SELECT count(*) FROM reviews WHERE rating < 4 AND NOT COALESCE(is_test, false) AND hidden_at IS NULL AND NOT resolved AND created_at > NOW() - interval '7 days')::int AS reviews,
      (SELECT count(*) FROM dl_courier_incidents WHERE resolved_at IS NULL AND detected_at > NOW() - interval '24 hours')::int AS incidents,
      (SELECT count(*) FROM shop_orders WHERE NOT COALESCE(is_test, false) AND status IN ('paid','pos_created','paid_pos_failed','accepted')
         AND created_at > NOW() - interval '6 hours' AND pos_ready_at IS NULL AND collected_at IS NULL)::int AS orders`,
});
export const SOURCE_AR = Object.freeze({
  orders: "طلبات الأونلاين", escalations: "تصعيد «الطلب ما اتشافش»", breaches: "مخالفات المندوب", handovers: "تحويلات واتساب",
  silentDone: "«قفل من غير رد» (المحادثات)", silentAck: "«قفل من غير رد» (التحويلات)", reviews: "التقييمات الواطية", presence: "حضور البوابة",
  offline: "تنبيهات «البورتال مقفول»", pos: "فواتير نقطة البيع", notices: "تنبيهات الفريق", tableCalls: "نداءات الطاولات", incidents: "مشاكل المندوب",
  shiftLog: "checklist الوردية", openNow: "المفتوح دلوقتي",
});

/* ── «قفل من غير رد» (صافي) ─────────────────────────────────────────────── */
const REVIEW_REASONS = new Set(["review_low", "review_note"]);
/* rows = silentDone + silentAck (نفس الشكل) ⇒ قايمة مرتّبة بعد الاستبعاد ومن غير تكرار لنفس الرقم خلال ٣٠ د */
export function pickSilent(rows = []) {
  const out = [];
  const lastByPhone = new Map();
  const ok = (r) => r && r.by_name && !AUTO_BY.has(String(r.by_name).trim()) && Number(r.human) === 0
    && r.outcome !== "not_customer" && !REVIEW_REASONS.has(r.reason)
    && String(r.close_note || "").trim().length < 3;      // كتب ملاحظة وهو بيقفل (مثلاً «كلّمته تليفون») ⇒ متوثّق، مش سكوت
  const list = [...rows].filter(ok).sort((a, b) => new Date(a.at) - new Date(b.at));
  for (const r of list) {
    const t = new Date(r.at).getTime(), prev = lastByPhone.get(r.phone_norm);
    if (prev != null && t - prev < 30 * MIN) continue;
    lastByPhone.set(r.phone_norm, t);
    out.push({ ref: `${r.kind || "d"}:${r.id}`, kind: r.kind || "done", at: new Date(r.at).toISOString(), by: String(r.by_name).trim(), role: r.role || null,
      ref4: String(r.phone_norm || "").slice(-4), reason: r.reason || null, phone_norm: r.phone_norm || null, since: r.since ? new Date(r.since).toISOString() : null });
  }
  return out;
}

/* ── التشكيل (صافي) ──────────────────────────────────────────────────────── */
const minsBetween = (a, b) => (a && b ? (new Date(a).getTime() - new Date(b).getTime()) / MIN : null);
const median = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);
const OWN_TYPES = new Set(["Created", "Table", "Parked"]);       // فواتير اتعملت على الكاشير نفسه (مش External = تطبيقات/أونلاين)

/**
 * rows: { orders, escalations, breaches, handovers, silent (بعد pickSilent), reviews, presence, offline, pos, notices, tableCalls, incidents, shiftLog, openNow }
 *       — كل مفتاح مصفوفة أو null (المصدر وقع ⇒ «غير متاح»).
 * opts: { targets (kpiTargets), cfg (opsCfg), kind: shift|daily|custom, label, day, now }
 */
export function shapeReport(rows, { targets, cfg, kind = "custom", label = "", day = null, now = Date.now(), window = null } = {}) {
  const has = (k) => Array.isArray(rows[k]);
  const T = targets, out = { kind, label, day, window, unavailable: [], flags: [], people: {} };
  const person = (name, role = null) => {
    const n = String(name || "").trim(); if (!n || AUTO_BY.has(n)) return null;
    if (!out.people[n]) out.people[n] = { name: n, role, acks: 0, handoversAcked: 0, silent: 0, reviewActions: 0, presenceMin: null, visibleMin: null, shiftStart: 0, shiftEnd: 0, checklistMissing: 0, mismatch: 0 };
    if (role && !out.people[n].role) out.people[n].role = role;
    return out.people[n];
  };
  for (const k of Object.keys(SOURCE_AR)) if (k !== "silentAck" && k !== "silentDone" && k in rows && !has(k)) out.unavailable.push(SOURCE_AR[k]);
  if (rows.silent === null) out.unavailable.push("«قفل من غير رد»");

  /* الطلبات + القبول + التحضير */
  if (has("orders")) {
    const os = rows.orders;
    const acks = [], slow = [], preps = [], over = [];
    for (const o of os) {
      const first = [o.portal_ack_at, o.accepted_at].filter(Boolean).map((x) => new Date(x).getTime()).sort((a, b) => a - b)[0];
      const sched = o.scheduled_for && new Date(o.scheduled_for).getTime() > new Date(o.created_at).getTime() + 5 * MIN;
      if (first && !sched) {
        const sec = Math.max(0, (first - new Date(o.paid_at || o.created_at).getTime()) / 1000);
        acks.push(sec);
        if (sec > T.ackMin * 60) slow.push({ ref: String(o.order_no).slice(-4), min: r1(sec / 60) });
      }
      if (o.portal_ack_by) { const p = person(o.portal_ack_by); if (p) p.acks++; }
      const pm = minsBetween(o.pos_ready_at, o.accepted_at);
      if (pm != null && pm >= 0) { preps.push(pm); if (pm > T.readyMin) over.push({ ref: String(o.order_no).slice(-4), min: r1(pm) }); }
    }
    out.orders = {
      n: os.length, delivery: os.filter((o) => o.option === "delivery").length, pickup: os.filter((o) => o.option === "pickup").length,
      ack: { n: acks.length, medianSec: acks.length ? Math.round(median(acks)) : null, maxSec: acks.length ? Math.round(Math.max(...acks)) : null,
        within: acks.filter((s) => s <= T.ackMin * 60).length, pct: pct(acks.filter((s) => s <= T.ackMin * 60).length, acks.length), targetMin: T.ackMin,
        slow: slow.sort((a, b) => b.min - a.min).slice(0, 5), slowN: slow.length },
      prep: { n: preps.length, medianMin: r1(median(preps)), targetMin: T.readyMin, overN: over.length, over: over.sort((a, b) => b.min - a.min).slice(0, 5) },
      escalated: has("escalations") ? rows.escalations.length : null,
      escalatedStep2: has("escalations") ? rows.escalations.filter((e) => Number(e.step) >= 2).length : null,
    };
  }
  /* المندوب: علينا (الكابتن استنّانا) وعليهم */
  if (has("breaches")) {
    const ours = rows.breaches.filter((b) => b.code === "our_handover_late");
    const waits = ours.map((b) => Number(b.over_min) || 0);
    out.courier = { captainWaited: ours.length, captainWaitedOver: ours.filter((b) => (Number(b.over_min) || 0) >= cfg.captainWaitMin).length, thresholdMin: cfg.captainWaitMin,
      avgOverMin: r1(waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null),
      theirLate: rows.breaches.filter((b) => b.claimable === true).length };
  }
  if (has("incidents")) out.incidents = { n: rows.incidents.length, open: rows.incidents.filter((r) => r.open).length,
    external: rows.incidents.filter((r) => r.resolution === "external").length };

  /* تحويلات واتساب: أول رد مكتوب (بوابة / تطبيق واتساب) */
  if (has("handovers")) {
    const hs = rows.handovers.filter((h) => !REVIEW_REASONS.has(h.reason));
    const t = hs.map((h) => minsBetween(h.first_reply_at, h.at));
    const nowMs = Number(now);
    const noReply = hs.filter((h, i) => t[i] == null && nowMs - new Date(h.at).getTime() > T.handoverMin * MIN);      // لسه جوّه المهلة ⇒ مش «من غير رد»
    for (const h of rows.handovers) { const p = person(h.acked_by); if (p) p.handoversAcked++; }
    out.handovers = { n: hs.length, replied: t.filter((x) => x != null && x <= T.handoverMin).length, late: t.filter((x) => x != null && x > 15).length,
      noReply: noReply.length, medianMin: r1(median(t)), targetMin: T.handoverMin, pct: pct(t.filter((x) => x != null && x <= T.handoverMin).length, hs.length),
      worst: hs.map((h, i) => ({ ref4: h.ref4, reason: h.reason, min: t[i] == null ? null : Math.round(t[i]) }))
        .filter((x) => x.min == null || x.min > 15).slice(0, 5) };
  }
  /* «قفل من غير رد» */
  if (Array.isArray(rows.silent)) {
    const by = {};
    for (const s of rows.silent) { by[s.by] = (by[s.by] || 0) + 1; const p = person(s.by, s.role); if (p) p.silent++; }
    out.silent = { n: rows.silent.length, by, items: rows.silent.slice(-5).map((s) => ({ at: s.at, by: s.by, ref4: s.ref4, kind: s.kind })) };
  }
  /* التقييمات الواطية */
  if (has("reviews")) {
    const rs = rows.reviews;
    const first = rs.map((r) => minsBetween(r.first_action_at, r.created_at));
    for (const r of rs) { const p = person(r.first_by); if (p) p.reviewActions++; }
    out.reviews = { n: rs.length, handled: first.filter((x) => x != null && x <= T.reviewMin).length, noAction: first.filter((x) => x == null).length,
      open: rs.filter((r) => !r.resolved).length, targetMin: T.reviewMin, slowestMin: first.filter((x) => x != null).length ? Math.round(Math.max(...first.filter((x) => x != null))) : null };
  }
  /* حضور البوابة (اليوم التشغيلي كله — الدفتر يومي) */
  if (has("presence")) {
    out.presence = rows.presence.map((r) => ({ name: r.staff_name, role: r.role, minutes: Number(r.minutes) || 0, visible: Number(r.visible_minutes) || 0 }));
    for (const r of out.presence) { const p = person(r.name, r.role); if (p) { p.presenceMin = r.minutes; p.visibleMin = r.visible; } }
  }
  if (has("offline")) {
    const g = (k) => Number((rows.offline.find((r) => r.kind === k) || {}).n) || 0;
    out.offline = { cashier: g("cashier"), manager: g("manager"), back: g("back") };
  }
  /* نقطة البيع: فواتير الكاشير نفسه + من غير عميل + فويد/مرتجع (بأسماء كاشير تاب سينس) */
  if (has("pos")) {
    const by = {};
    for (const r of rows.pos) {
      const n = String(r.staff_name || "—").trim() || "—";
      const b = by[n] || (by[n] = { name: n, invoices: 0, own: 0, noCustomer: 0, voids: 0, refunds: 0 });
      b.invoices++;
      const ty = String(r.order_type || "");
      if (/void/i.test(ty)) b.voids++;
      else if (/refund/i.test(ty)) b.refunds++;
      else if (OWN_TYPES.has(ty)) { b.own++; if (!r.has_cust) b.noCustomer++; }
    }
    const list = Object.values(by).sort((a, b) => b.invoices - a.invoices);
    const own = list.reduce((a, b) => a + b.own, 0), noC = list.reduce((a, b) => a + b.noCustomer, 0);
    out.pos = { byStaff: list, own, noCustomer: noC, coveragePct: pct(own - noC, own), voids: list.reduce((a, b) => a + b.voids, 0), refunds: list.reduce((a, b) => a + b.refunds, 0) };
  }
  if (has("notices")) {
    const n = rows.notices.reduce((a, r) => a + (Number(r.n) || 0), 0), ac = rows.notices.reduce((a, r) => a + (Number(r.acked) || 0), 0);
    const meds = rows.notices.filter((r) => r.med != null).map((r) => Number(r.med));
    out.notices = { n, acked: ac, open: n - ac, medianMin: r1(median(meds)), targetMin: T.noticeMin };
  }
  if (has("tableCalls") && rows.tableCalls[0]) {
    const r = rows.tableCalls[0];
    out.tableCalls = { n: Number(r.n) || 0, done: Number(r.done) || 0, medianMin: r1(r.med == null ? null : Number(r.med)), targetMin: T.tableCallMin };
  }
  if (has("shiftLog")) {
    const starts = rows.shiftLog.filter((r) => r.action === "start"), ends = rows.shiftLog.filter((r) => r.action === "end");
    const missing = [], mism = [], cash = [];
    for (const r of rows.shiftLog) {
      const p = person(r.staff_name, r.role);
      const ms = Array.isArray(r.missing) ? r.missing : [], mm = Array.isArray(r.mismatch) ? r.mismatch : [];
      if (p) { if (r.action === "start") p.shiftStart++; else p.shiftEnd++; p.checklistMissing += ms.length; p.mismatch += mm.length; }
      for (const x of ms) missing.push({ by: r.staff_name, item: x });
      for (const x of mm) mism.push({ by: r.staff_name, item: x });
      if (r.action === "end" && r.cash_diff != null && Number.isFinite(Number(r.cash_diff))) cash.push({ by: r.staff_name, diff: Number(r.cash_diff) });
    }
    out.checklist = { starts: starts.length, ends: ends.length, missing, mismatch: mism, cash };
  }
  if (has("openNow") && rows.openNow[0]) {
    const r = rows.openNow[0];
    out.openNow = { handovers: Number(r.handovers) || 0, reviews: Number(r.reviews) || 0, incidents: Number(r.incidents) || 0, orders: Number(r.orders) || 0 };
  }
  out.flags = flagsOf(out, { targets: T, cfg, kind });
  return out;
}

/* «أهم الحاجات» بالأولوية — كل سطر = رقم + مين لو معروف. مفيش سطر من غير مصدر. */
export function flagsOf(r, { targets: T, cfg, kind }) {
  const f = [];
  const add = (level, text) => f.push({ level, text });
  const o = r.orders;
  if (o && o.ack.slowN) add(o.ack.slowN >= 3 ? "crit" : "warn", `${o.ack.slowN} طلب اتقبل بعد أكتر من ${T.ackMin} د (أسوأ ${o.ack.slow[0].min} د)`);
  if (r.handovers && (r.handovers.noReply + r.handovers.late) > 0) add("crit", `${r.handovers.noReply} تحويل واتساب من غير رد مكتوب + ${r.handovers.late} اترد بعد ربع ساعة (من ${r.handovers.n})`);
  if (r.silent && r.silent.n) add("crit", `${r.silent.n} محادثة اتقفلت من غير ولا رسالة مكتوبة: ${Object.entries(r.silent.by).map(([k, v]) => `${k} ${v}`).join("، ")}`);
  if (r.reviews && (r.reviews.noAction || r.reviews.open)) add("crit", `تقييمات واطية: ${r.reviews.n} — من غير إجراء ${r.reviews.noAction}، لسه مفتوحة ${r.reviews.open}`);
  else if (r.reviews && r.reviews.n > r.reviews.handled) add("warn", `${r.reviews.n - r.reviews.handled} تقييم واطي أول إجراء عليه اتأخر عن ${r.reviews.targetMin} د (أبطأ واحد ${Math.round(r.reviews.slowestMin / 60)} س)`);
  if (o && o.prep.overN) add("warn", `${o.prep.overN} طلب «جاهز» بعد أكتر من ${T.readyMin} د (وسيط التحضير ${o.prep.medianMin} د)`);
  if (r.courier && r.courier.captainWaitedOver) add("warn", `الكابتن استنّانا بعد مهلة العقد ${r.courier.captainWaited} مرة — منهم ${r.courier.captainWaitedOver} أكتر من ${cfg.captainWaitMin} د (علينا في عقد لاجلك)`);
  if (r.openNow && r.openNow.handovers) add("crit", `دلوقتي: ${r.openNow.handovers} تحويل واتساب مفتوح محدش قال «تم»`);
  if (r.openNow && r.openNow.orders) add("warn", `دلوقتي: ${r.openNow.orders} طلب أونلاين لسه ماتعلّمش «جاهز»`);
  if (r.pos && r.pos.noCustomer) add("info", `فواتير كاشير من غير جوال العميل: ${r.pos.byStaff.filter((b) => b.noCustomer).map((b) => `${b.name} ${b.noCustomer}`).join("، ")}`);
  if (r.notices && r.notices.open) add("warn", `${r.notices.open} تنبيه فريق محدش ضغط عليه «تمام»`);
  if (r.checklist) {
    if (kind !== "custom" && r.checklist.ends === 0) add("warn", "محدش قفل الوردية على البوابة (checklist)");
    if (r.checklist.mismatch.length) add("crit", `checklist: ${r.checklist.mismatch.length} بند اتعلّم عليه وهو مش صح (${r.checklist.mismatch.map((m) => m.by).join("، ")})`);
    const big = r.checklist.cash.filter((c) => Math.abs(c.diff) >= 1);
    if (big.length) add("crit", `فرق كاش: ${big.map((c) => `${c.by} ${c.diff > 0 ? "+" : ""}${c.diff} ر`).join("، ")}`);
  }
  if (kind === "daily" && r.presence && cfg.presenceMinPerShift > 0) {
    const low = r.presence.filter((p) => (p.role === "cashier" || p.role === "manager") && p.visible < cfg.presenceMinPerShift);
    if (low.length) add("warn", `البوابة كانت مفتوحة قدام: ${low.map((p) => `${p.name} ${p.visible} د`).join("، ")} (المتوقع ${cfg.presenceMinPerShift} د على الأقل)`);
  }
  const rank = { crit: 0, warn: 1, info: 2 };
  return f.sort((a, b) => rank[a.level] - rank[b.level]);
}

/* ── النص ──────────────────────────────────────────────────────────────── */
const pad2 = (n) => String(n).padStart(2, "0");
export const hhmm = (iso) => { const d = new Date(new Date(iso).getTime() + 3 * 3600_000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const ddmm = (day) => (day ? `${Number(day.slice(8, 10))}/${Number(day.slice(5, 7))}` : "");
const secTxt = (s) => (s == null ? "—" : s < 90 ? `${s} ث` : `${Math.round(s / 60)} د`);
export function reportText(r, { maxParts = 3 } = {}) {
  const o = r.orders, h = r.handovers;
  const head = r.kind === "daily" ? `🧭 كارت فريق فريش كاتس — يوم ${ddmm(r.day)}` : r.kind === "shift" ? `🧭 تقرير ${r.label} — ${ddmm(r.day)}` : `🧭 تقرير التشغيل — ${r.label}`;
  const lines = [head];
  if (r.flags.length) { lines.push("⚠️ أهم الحاجات:"); for (const x of r.flags.slice(0, 6)) lines.push(`• ${x.text}`); }
  else lines.push("✅ مفيش مشاكل مسجّلة في الفترة دي");
  if (o) lines.push(`🛒 أونلاين ${o.n} (توصيل ${o.delivery} · استلام ${o.pickup}) · القبول: وسيط ${secTxt(o.ack.medianSec)}${o.ack.pct == null ? "" : ` · ${o.ack.pct}% خلال ${o.ack.targetMin} د`}${o.escalated ? ` · اتصعّد ${o.escalated}` : ""}`);
  if (o && o.prep.n) lines.push(`🍳 التحضير: وسيط ${o.prep.medianMin} د · فوق ${o.prep.targetMin} د: ${o.prep.overN}`);
  if (r.courier) lines.push(`🛵 الكابتن استنّانا بعد مهلة العقد ${r.courier.captainWaited} (أكتر من ${r.courier.thresholdMin} د: ${r.courier.captainWaitedOver}) · تأخير على شركة التوصيل ${r.courier.theirLate}`);
  if (h) lines.push(`💬 تحويلات ${h.n}: اترد خلال ${h.targetMin} د ${h.replied} · بعد ربع ساعة ${h.late} · من غير رد ${h.noReply}`);
  if (r.reviews && r.reviews.n) lines.push(`⭐ تقييمات واطية ${r.reviews.n}: اتعمل إجراء خلال ${Math.round(r.reviews.targetMin)} د ${r.reviews.handled} · مفتوحة ${r.reviews.open}`);
  if (r.pos) lines.push(`🧾 نقطة البيع: ${r.pos.byStaff.filter((b) => b.name !== "—").map((b) => `${b.name} ${b.invoices}${b.noCustomer ? ` (من غير عميل ${b.noCustomer})` : ""}${b.voids + b.refunds ? ` · فويد/مرتجع ${b.voids + b.refunds}` : ""}`).join(" · ") || "—"}`);
  const ppl = Object.values(r.people).filter((p) => p.acks || p.handoversAcked || p.silent || p.reviewActions || p.visibleMin != null || p.shiftEnd || p.shiftStart);
  for (const p of ppl) {
    const bits = [];
    if (p.acks) bits.push(`شفته ${p.acks}`);
    if (p.handoversAcked) bits.push(`تحويلات ${p.handoversAcked}`);
    if (p.silent) bits.push(`قفل من غير رد ${p.silent}`);
    if (p.reviewActions) bits.push(`تقييمات ${p.reviewActions}`);
    if (p.visibleMin != null) bits.push(`البوابة ${p.visibleMin} د`);
    if (p.shiftStart || p.shiftEnd) bits.push(`checklist ${p.shiftStart ? "✓بداية" : "✗بداية"} ${p.shiftEnd ? "✓نهاية" : "✗نهاية"}`);
    lines.push(`👤 ${p.name}${p.role ? ` (${ROLE_AR[p.role] || p.role})` : ""}: ${bits.join(" · ")}`);
  }
  if (r.unavailable.length) lines.push(`ℹ️ غير متاح: ${r.unavailable.join("، ")}`);
  const wa = lines.join("\n");
  /* SMS: العنوان + أهم الحاجات بالترتيب لحد maxParts، من غير إيموجي */
  const strip = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
  let sms = strip(head.replace("فريش كاتس", "FC"));
  const smsLines = r.flags.length ? r.flags.map((x) => strip(x.text)) : ["مفيش مشاكل مسجلة"];
  if (o) smsLines.push(`اونلاين ${o.n} قبول ${secTxt(o.ack.medianSec)}`);
  for (const l of smsLines) { const t = `${sms}\n${l}`; if (smsInfo(t).segments <= maxParts) sms = t; }
  while (smsInfo(sms).segments > maxParts && sms.length > 10) sms = sms.slice(0, -1);
  return { wa, sms, parts: smsInfo(sms).segments };
}

/* ── التجميع من القاعدة ──────────────────────────────────────────────────── */
export async function collectReport(pool, { start, end, day, graceMin = OPS_DEFAULTS.silentGraceMin, withOpenNow = false, log = console } = {}) {
  const rows = {};
  const run = async (k, params) => {
    try { rows[k] = (await pool.query(SQL[k], params)).rows || []; }
    catch (e) { rows[k] = null; try { log.error(`[ops-report] ${k}: ${e && e.message}`); } catch { /* */ } }
  };
  const p = [start, end];
  for (const k of ["orders", "escalations", "breaches", "handovers", "reviews", "offline", "pos", "notices", "tableCalls", "incidents", "shiftLog"]) await run(k, p);
  await run("presence", [day]);
  await run("silentDone", [...p, graceMin]);
  await run("silentAck", [...p, graceMin]);
  rows.silent = rows.silentDone && rows.silentAck
    ? pickSilent([...rows.silentDone.map((r) => ({ ...r, kind: "done" })), ...rows.silentAck.map((r) => ({ ...r, kind: "ack" }))])
    : null;
  delete rows.silentDone; delete rows.silentAck;
  if (withOpenNow) await run("openNow", []);
  return rows;
}

/* ── checklist الوردية (صافي) ─────────────────────────────────────────────── */
/* body = { action, answers: {key: bool}, note, cashDiff } · facts = { openHandovers, openOrders } ⇒ { ok, row } | { ok:false, message } */
export function shiftEntry(body, cfg, facts = {}) {
  const action = body && body.action;
  if (action !== "start" && action !== "end") return { ok: false, error: "bad_action", message: "الإجراء لازم «بداية» أو «نهاية» الوردية" };
  const items = action === "start" ? cfg.checklistStart : cfg.checklistEnd;
  const ans = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? body.answers : {};
  const checked = items.filter((it) => ans[it.key] === true).map((it) => it.key);
  const missing = items.filter((it) => ans[it.key] !== true).map((it) => it.label);
  const mismatch = [];
  for (const it of items) {
    const fk = VERIFIED_ITEMS[it.key];
    if (fk && ans[it.key] === true && Number(facts[fk]) > 0) mismatch.push(`${it.label} (الحقيقة: ${facts[fk]} مفتوح)`);
  }
  let cashDiff = null;
  if (action === "end" && body.cashDiff !== undefined && body.cashDiff !== null && body.cashDiff !== "") {
    const n = Number(body.cashDiff);
    if (!Number.isFinite(n) || Math.abs(n) > LIMITS.cashDiff) return { ok: false, error: "bad_cash", message: "فرق الكاش لازم رقم بالريال (سالب = ناقص)" };
    cashDiff = Math.round(n * 100) / 100;
  }
  return { ok: true, row: { action, checked, missing, mismatch, cashDiff, note: clip(body.note, LIMITS.note) || null } };
}

const mask = (p) => `***${String(p || "").slice(-4)}`;
export const SKIP_AR = Object.freeze({ disabled: "التقارير مقفولة", no_phones: "مفيش رقم في دليل الفريق للأدوار المختارة", no_channel: "واتساب والـSMS الاتنين مقفولين", data_error: "الأرقام ماتقرتش" });

/* ═══════════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const isOwner = ctx.isOwner || (async () => false);
  const log = ctx.log || console;
  const lazy = (f) => { try { return (typeof f === "function" ? f() : f) || null; } catch { return null; } };
  const sendSms = typeof deps.sendSms === "function" ? deps.sendSms : null;
  const now = deps.now || (() => Date.now());
  const J = (v) => JSON.stringify(v);
  const settingsOf = async () => (await getSettingsData().catch(() => ({}))) || {};

  const ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS ops_report_log (
        id BIGSERIAL PRIMARY KEY, day DATE NOT NULL, slot TEXT NOT NULL, kind TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'claimed', reason TEXT, text TEXT, sms_text TEXT, via JSONB, flags JSONB)`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS ops_report_slot_uq ON ops_report_log(day, slot) WHERE kind <> 'test'");
    await pool.query(`CREATE TABLE IF NOT EXISTS ops_silent_closes (
        ref TEXT PRIMARY KEY, kind TEXT, at TIMESTAMPTZ NOT NULL, by_name TEXT, role TEXT, phone_norm TEXT, reason TEXT, since TIMESTAMPTZ,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), alerted_at TIMESTAMPTZ, alert JSONB)`);
    await pool.query("CREATE INDEX IF NOT EXISTS ops_silent_closes_at_idx ON ops_silent_closes(at)");
    await pool.query(`CREATE TABLE IF NOT EXISTS portal_shift_log (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), day DATE NOT NULL, staff_id TEXT, staff_name TEXT, role TEXT,
        action TEXT NOT NULL, shift_key TEXT, answers JSONB, missing JSONB, mismatch JSONB, cash_diff NUMERIC, note TEXT)`);
    await pool.query("CREATE INDEX IF NOT EXISTS portal_shift_log_at_idx ON portal_shift_log(at)");
    return true;
  })().catch((e) => { try { log.error("[ops-report] schema:", e.message); } catch { /* */ } return false; });

  /* الفترة من الطلب: day + shift | from/to (أيام) | الافتراضي = الوردية الحالية وإلا اليوم التشغيلي الحالي */
  function windowOf(q, cfg, t) {
    const day = q.day && DAY_RE.test(q.day) ? q.day : bizDay(t);
    if (q.shift) {
      const s = cfg.shifts.find((x) => x.key === q.shift);
      if (!s) return { error: "bad_shift" };
      return { kind: "shift", day, label: s.name, ...shiftWindow(day, s), shift: s };
    }
    if (q.scope === "day" || q.day) return { kind: "daily", day, label: `يوم ${ddmm(day)}`, ...dayWindow(day) };
    const cur = shiftAt(t, cfg);
    if (cur) return { kind: "shift", day, label: cur.name, ...shiftWindow(day, cur), shift: cur };
    return { kind: "daily", day, label: `يوم ${ddmm(day)}`, ...dayWindow(day) };
  }
  async function build(w, { openNow = false } = {}) {
    await ready;
    const s = await settingsOf();
    const cfg = opsCfg(s), targets = kpiTargets(s);
    const rows = await collectReport(pool, { start: w.start, end: w.end, day: w.day, graceMin: cfg.silentGraceMin, withOpenNow: openNow, log });
    const report = shapeReport(rows, { targets, cfg, kind: w.kind, label: w.label, day: w.day, now: now(), window: { start: w.start, end: w.end } });
    return { report, text: reportText(report, { maxParts: cfg.smsMaxParts }), cfg, targets, settings: s };
  }

  /* المستلمين: دليل الفريق (waTeam.members) للأدوار المختارة */
  function phonesFor(s, roles) {
    const members = (s.waTeam && Array.isArray(s.waTeam.members)) ? s.waTeam.members : [];
    return staffPhones(members.filter((m) => m && m.active !== false && roles.includes(m.role)).map((m) => m.phone));
  }
  async function sendToPhones(cfg, phones, msg, ref, { smsAllowed = true } = {}) {
    const via = [], w = lazy(deps.wa);
    for (const p of phones) {
      let row = { to: mask(p), ch: null, ok: false, why: null };
      if (cfg.wa && w && typeof w.sendFreeform === "function") {
        try {
          const r = await w.sendFreeform({ phoneNorm: p, payload: { type: "text", text: { body: msg.wa, preview_url: false } }, source: "team", preview: msg.wa.slice(0, 200) });
          if (r && r.ok) row = { to: mask(p), ch: "wa", ok: true, why: null };
          else row.why = String((r && (r.skipped || r.error)) || "wa_failed").slice(0, 40);
        } catch (e) { row.why = "wa_error"; try { log.error(`[ops-report] wa → ${mask(p)}: ${e.message}`); } catch { /* */ } }
      } else row.why = cfg.wa ? "no_wa_sender" : "wa_off";
      if (!row.ok && smsAllowed && cfg.sms && sendSms && msg.sms) {
        try {
          const r = await sendSms({ phoneNorm: p, body: msg.sms, kind: "staff", ref });
          row = r && r.suppressed ? { ...row, ch: "sms", ok: false, why: `${row.why || ""}→suppressed`.slice(0, 60) } : { ...row, ch: "sms", ok: true, waWhy: row.why, why: null };
        } catch (e) { row = { ...row, ch: "sms", ok: false, why: `${row.why || ""}→sms_failed`.slice(0, 60) }; }
      }
      via.push(row);
    }
    return via;
  }

  /* ── الجدولة: تقرير الوردية + كارت اليوم ── */
  let running = null;
  async function tick({ at = null } = {}) {
    if (running) return running;
    running = (async () => {
      if (!(await ready)) return { ok: false, error: "schema" };
      const t = at == null ? Number(now()) : Number(at);
      const s = await settingsOf();
      const cfg = opsCfg(s);
      if (!cfg.enabled) return { ok: true, skipped: "disabled" };
      const day = bizDay(t);
      const done = new Set(((await pool.query("SELECT day::text AS day, slot FROM ops_report_log WHERE day >= $1::date AND kind <> 'test'", [prevDay(day)])).rows || []).map((r) => `${r.day}|${r.slot}`));
      const due = dueSlots(t, cfg, done);
      const results = [];
      for (const slot of due) {
        const claim = await pool.query("INSERT INTO ops_report_log(day, slot, kind) VALUES ($1::date, $2, $3) ON CONFLICT (day, slot) WHERE kind <> 'test' DO NOTHING RETURNING id",
          [slot.target, slot.key, slot.kind]);
        if (!claim.rows || !claim.rows.length) { results.push({ slot: slot.key, skipped: "claimed_elsewhere" }); continue; }
        const id = claim.rows[0].id;
        const fin = (status, reason, x = {}) => pool.query("UPDATE ops_report_log SET status=$2, reason=$3, text=$4, sms_text=$5, via=$6::jsonb, flags=$7::jsonb, at=NOW() WHERE id=$1",
          [id, status, reason, x.wa ?? null, x.sms ?? null, J(x.via || []), J(x.flags || [])]).catch(() => {});
        const w = slot.kind === "shift" ? { kind: "shift", day: slot.target, label: slot.shift.name, ...shiftWindow(slot.target, slot.shift) }
          : { kind: "daily", day: slot.target, label: `يوم ${ddmm(slot.target)}`, ...dayWindow(slot.target) };
        let b;
        try { b = await build(w, { openNow: true }); } catch (e) { await fin("failed", "data_error"); results.push({ slot: slot.key, error: "data_error" }); continue; }
        const phones = phonesFor(s, cfg.roles);
        if (!phones.length) { await fin("skipped", "no_phones", { ...b.text, flags: b.report.flags }); results.push({ slot: slot.key, skipped: "no_phones" }); continue; }
        if (!cfg.wa && !cfg.sms) { await fin("skipped", "no_channel", { ...b.text, flags: b.report.flags }); results.push({ slot: slot.key, skipped: "no_channel" }); continue; }
        const via = await sendToPhones(cfg, phones, b.text, `ops-report ${slot.key}`);
        const okN = via.filter((v) => v.ok).length;
        await fin(okN ? "sent" : "failed", okN ? null : (via[0] && via[0].why) || "failed", { ...b.text, via, flags: b.report.flags });
        results.push({ slot: slot.key, sent: okN, via });
      }
      return { ok: true, due: due.length, results };
    })().catch((e) => { try { log.error("[ops-report] tick:", e.message); } catch { /* */ } return { ok: false, error: String(e.message || e).slice(0, 200) }; })
      .finally(() => { running = null; });
    return running;
  }

  /* ── «قفل من غير رد»: رصد كل دقيقة + تنبيه اختياري ── */
  const silentStats = { ticks: 0, found: 0, alerted: 0, lastAt: null, lastError: null };
  let silentRunning = false;
  async function silentTick({ at = null } = {}) {
    if (silentRunning) return { skipped: "running" };
    silentRunning = true;
    try {
      if (!(await ready)) return { ok: false, error: "schema" };
      const t = at == null ? Number(now()) : Number(at);
      const s = await settingsOf();
      const cfg = opsCfg(s);
      silentStats.ticks++; silentStats.lastAt = new Date(t).toISOString();
      if (!cfg.silentEnabled) return { ok: true, skipped: "disabled" };
      const end = new Date(t - cfg.silentGraceMin * MIN).toISOString(), start = new Date(t - (cfg.silentGraceMin + 60) * MIN).toISOString();
      const a = (await pool.query(SQL.silentDone, [start, end, cfg.silentGraceMin])).rows || [];
      const b = (await pool.query(SQL.silentAck, [start, end, cfg.silentGraceMin])).rows || [];
      const found = pickSilent([...a.map((r) => ({ ...r, kind: "done" })), ...b.map((r) => ({ ...r, kind: "ack" }))]);
      let added = 0, alerted = 0;
      for (const x of found) {
        /* نفس الرقم اتسجّل خلال ٣٠ د (من الناحية التانية: تحويل ⇄ محادثة) ⇒ مرة واحدة */
        const dup = await pool.query("SELECT 1 FROM ops_silent_closes WHERE phone_norm=$1 AND abs(EXTRACT(EPOCH FROM (at - $2::timestamptz))) < 1800 LIMIT 1", [x.phone_norm, x.at]);
        if (dup.rows && dup.rows.length) continue;
        const ins = await pool.query(`INSERT INTO ops_silent_closes(ref, kind, at, by_name, role, phone_norm, reason, since) VALUES ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8::timestamptz)
          ON CONFLICT (ref) DO NOTHING RETURNING ref`, [x.ref, x.kind, x.at, x.by, x.role, x.phone_norm, x.reason, x.since]);
        if (!ins.rows || !ins.rows.length) continue;
        added++;
        if (!cfg.silentAlert) continue;
        const hour = (await pool.query("SELECT count(*)::int AS n FROM ops_silent_closes WHERE alerted_at > $1::timestamptz", [new Date(t - 60 * MIN).toISOString()])).rows[0];
        if (Number(hour && hour.n) >= cfg.silentMaxPerHour) continue;
        const res = await alertSilent(x, cfg, s);
        await pool.query("UPDATE ops_silent_closes SET alerted_at=NOW(), alert=$2::jsonb WHERE ref=$1", [x.ref, J(res)]).catch(() => {});
        alerted++;
      }
      silentStats.found += added; silentStats.alerted += alerted;
      return { ok: true, found: found.length, added, alerted };
    } catch (e) {
      silentStats.lastError = String(e && e.message || e).slice(0, 200);
      try { log.error("[ops-report] silent:", e.message); } catch { /* */ }
      return { ok: false, error: "silent" };
    } finally { silentRunning = false; }
  }
  async function alertSilent(x, cfg, s) {
    const out = { push: null, wa: null };
    const title = `🔕 محادثة اتقفلت من غير رد — …${x.ref4}`;
    const body = `${x.by} قفل المحادثة ${hhmm(x.at)} ومفيش ولا رسالة اتكتبت للعميل. افتحها ورد عليه أو كلّمه.`;
    const p = lazy(deps.push);
    if (p && typeof p.sendToSubs === "function") {
      out.push = [];
      for (const role of cfg.silentAlertRoles.filter((r) => PUSH_ROLES.includes(r))) {
        try {
          const r = await p.sendToSubs({ title, body, tag: `silent-${x.ref}`, url: (p.PORTAL_URL || "") + "#wa", renotify: true, requireInteraction: true, urgency: "high", ttl: 900, kind: "silent_close" }, { role });
          out.push.push({ role, sent: r && r.sent || 0, of: r && r.of || 0 });
        } catch { out.push.push({ role, error: true }); }
      }
    }
    if (cfg.silentAlertWa) {
      const phones = phonesFor(s, cfg.silentAlertRoles);
      out.wa = await sendToPhones({ ...cfg, sms: false }, phones, { wa: `${title}\n${body}`, sms: null }, `ops-silent ${x.ref}`, { smsAllowed: false });
    }
    return out;
  }

  /* ── المسارات ── */
  const qOf = (c) => ({ day: c.req.query("day") || undefined, shift: c.req.query("shift") || undefined, scope: c.req.query("scope") || undefined });
  async function view(c, owner) {
    const t = Number(now());
    const s = await settingsOf();
    const cfg = opsCfg(s);
    const w = windowOf(qOf(c), cfg, t);
    if (w.error) return { status: 400, body: { ok: false, error: w.error, message: "الوردية دي مش موجودة في الإعدادات" } };
    const b = await build(w, { openNow: true });
    const logRows = ((await pool.query("SELECT id, day::text AS day, slot, kind, at, status, reason, flags, via FROM ops_report_log ORDER BY id DESC LIMIT 20").catch(() => ({ rows: [] }))).rows || [])
      .map((r) => ({ ...r, at: r.at ? new Date(r.at).toISOString() : null, reasonAr: r.reason ? (SKIP_AR[r.reason] || r.reason) : null }));
    const phones = phonesFor(s, cfg.roles);
    return { status: 200, body: { ok: true, owner, window: w, report: b.report, text: b.text, cfg, defaults: OPS_DEFAULTS, limits: OPS_LIMITS, labels: LABELS,
      targets: b.targets, recipients: { n: phones.length, masked: phones.map(mask), roles: cfg.roles }, next: cfg.enabled ? nextSlot(t, cfg) : null,
      slots: slotsOf(t, cfg).map((x) => ({ key: x.key, kind: x.kind, target: x.target, at: new Date(bizStart(bizDay(t)).getTime() + x.dueMin * MIN).toISOString() })),
      log: logRows, silentStats, skipAr: SKIP_AR, generatedAt: new Date(t).toISOString() } };
  }
  app.get("/api/cms/ops-report", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { const r = await view(c, Boolean(await isOwner(c))); return c.json(r.body, r.status); }
    catch (e) { try { log.error("[ops-report] view:", e.message); } catch { /* */ } return c.json({ ok: false, error: "failed" }, 500); }
  });
  app.post("/api/cms/ops-report/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "إعدادات تقرير الوردية للمالك بس" }, 403);
    try {
      const b = await c.req.json().catch(() => null);
      if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ ok: false, error: "bad_json", message: "الطلب مش مفهوم" }, 400);
      const bad = settingsProblem(b);
      if (bad) return c.json({ ok: false, error: "invalid", message: bad }, 400);
      const s = await settingsOf();
      const cur = s.opsReport && typeof s.opsReport === "object" && !Array.isArray(s.opsReport) ? s.opsReport : {};
      const nx = { ...cur };
      for (const k of OPS_KEYS) if (b[k] !== undefined) nx[k] = b[k];
      const clean = { ...opsCfg({ opsReport: nx }), updatedAt: new Date(Number(now())).toISOString() };
      await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{opsReport}', $1::jsonb, true) WHERE id=1", [J(clean)]);
      try { await ctx.auditNote?.(c, `تقرير الوردية: ${Object.keys(b).filter((k) => OPS_KEYS.includes(k)).join(" ")}`); } catch { /* */ }
      return c.json({ ok: true, cfg: opsCfg({ opsReport: clean }) });
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }, 500); }
  });
  /* تجربة: تقرير الفترة المطلوبة لأرقام المالك بس (🧪) — مابيحجزش ميعاد. «test» بيعدّي بوابة رسايل الإدارة. */
  app.post("/api/cms/ops-report/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "المالك بس" }, 403);
    try {
      const t = Number(now());
      const s = await settingsOf();
      const cfg = opsCfg(s);
      const phones = phonesFor(s, ["owner"]);
      if (!phones.length) return c.json({ ok: false, error: "no_phones", message: "ضيف رقم المالك في دليل الفريق الأول" });
      if (!cfg.wa && !cfg.sms) return c.json({ ok: false, error: "no_channel", message: "واتساب والـSMS الاتنين مقفولين" });
      const w = windowOf(qOf(c), cfg, t);
      if (w.error) return c.json({ ok: false, error: w.error, message: "الوردية دي مش موجودة في الإعدادات" }, 400);
      const b = await build(w, { openNow: true });
      const msg = { wa: `🧪 تجربة\n${b.text.wa}`, sms: b.text.sms };
      const via = await sendToPhones(cfg, phones, msg, "test");
      const okN = via.filter((v) => v.ok).length;
      await pool.query("INSERT INTO ops_report_log(day, slot, kind, status, reason, text, sms_text, via, flags) VALUES ($1::date, $2, 'test', $3, $4, $5, $6, $7::jsonb, $8::jsonb)",
        [w.day, `test:${hhmm(new Date(t).toISOString())}`, okN ? "sent" : "failed", okN ? null : (via[0] && via[0].why) || "failed", msg.wa, msg.sms, J(via), J(b.report.flags)]).catch(() => {});
      return c.json({ ok: okN > 0, sent: okN, via, text: msg.wa, sms: msg.sms });
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }, 500); }
  });

  if (typeof deps.requirePortal === "function") {
    /* المدير: تقرير الوردية الحالية (أو ?day&shift) على البوابة */
    app.get("/api/portal/ops-report", async (c) => {
      const a = await deps.requirePortal(c, "manager"); if (a.res) return a.res;
      try { const r = await view(c, false); const { log: _l, recipients: _r, ...rest } = r.body; return c.json(r.status === 200 ? rest : r.body, r.status); }
      catch (e) { return c.json({ ok: false, error: "failed" }, 500); }
    });
    /* checklist الوردية */
    async function openFacts() {
      try {
        const r = (await pool.query(SQL.openNow)).rows[0] || {};
        return { openHandovers: Number(r.handovers) || 0, openOrders: Number(r.orders) || 0 };
      } catch { return {}; }
    }
    app.get("/api/portal/shift", async (c) => {
      const a = await deps.requirePortal(c); if (a.res) return a.res;
      try {
        await ready;
        const t = Number(now()), s = await settingsOf(), cfg = opsCfg(s), day = bizDay(t), u = a.user || {};
        const mine = (await pool.query("SELECT id, at, action, shift_key, missing, mismatch, cash_diff::float AS cash_diff FROM portal_shift_log WHERE day=$1::date AND staff_id=$2 ORDER BY at", [day, String(u.id || "")])).rows || [];
        const last = mine[mine.length - 1] || null;
        return c.json({ ok: true, enabled: cfg.checklistEnabled, day, shift: shiftAt(t, cfg), shifts: cfg.shifts, start: cfg.checklistStart, end: cfg.checklistEnd,
          cashDiffAsk: cfg.cashDiffAsk, open: Boolean(last && last.action === "start"), today: mine, facts: await openFacts() });
      } catch (e) { return c.json({ ok: false, error: "failed" }, 500); }
    });
    app.post("/api/portal/shift", async (c) => {
      const a = await deps.requirePortal(c); if (a.res) return a.res;
      try {
        await ready;
        const t = Number(now()), s = await settingsOf(), cfg = opsCfg(s), u = a.user || {};
        if (!cfg.checklistEnabled) return c.json({ ok: false, error: "disabled", message: "checklist الوردية مقفول من اللوحة" }, 409);
        const b = await c.req.json().catch(() => null);
        const facts = b && b.action === "end" ? await openFacts() : {};
        const e = shiftEntry(b, cfg, facts);
        if (!e.ok) return c.json(e, 400);
        const sh = shiftAt(t, cfg);
        const ins = await pool.query(`INSERT INTO portal_shift_log(at, day, staff_id, staff_name, role, action, shift_key, answers, missing, mismatch, cash_diff, note)
            VALUES ($1::timestamptz, $2::date, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12) RETURNING id`,
          [new Date(t).toISOString(), bizDay(t), String(u.id || ""), u.name ? String(u.name).slice(0, 60) : null, u.role || null, e.row.action, sh ? sh.key : null,
            J(e.row.checked), J(e.row.missing), J(e.row.mismatch), e.row.cashDiff, e.row.note]);
        return c.json({ ok: true, id: ins.rows && ins.rows[0] ? ins.rows[0].id : null, action: e.row.action, missing: e.row.missing, mismatch: e.row.mismatch, facts });
      } catch (err2) { try { log.error("[ops-report] shift:", err2.message); } catch { /* */ } return c.json({ ok: false, error: "failed" }, 500); }
    });
  }

  /* الجدولة: كل دقيقة (أول مرة بعد دقيقة). OPS_REPORT_SCHEDULER=0 بيقفلها (اختبارات/طوارئ). */
  if (deps.schedule !== false && process.env.OPS_REPORT_SCHEDULER !== "0") {
    const t0 = setTimeout(() => {
      const go = () => { tick().catch(() => {}); silentTick().catch(() => {}); };
      go();
      const iv = setInterval(go, 60_000);
      if (iv.unref) iv.unref();
    }, 60_000);
    if (t0.unref) t0.unref();
  }
  return { tick, silentTick, build, view, silentStats, ready };
}

export default { register };
