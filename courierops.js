/* ═══════════════════════════════════════════════════════════════════════════
   COURIER OPS — لما المندوب مايجيش، أو ييجي متأخر (١٩ سبتمبر ٢٠٢٦).

   بلاغ عمر: لاجلك **رفضت** طلب ١٣ كم (عقدهم بيدّي الـOperations حق الرفض
   فوق ١٠ كم) — العميل دافع والأكل جاهز، والفريق بعته مع مندوب من بره،
   ومفيش حاجة في السيستم بتعرف تتعامل مع ده. وطلب تاني اتأخر جداً ومحدش
   عارف المفروض يحصل إيه.

   اللي حصل فعلاً (من dl_shipments):
     • W1789825687099 (13.47 كم): New Order → «Order Accept» بعد دقيقة →
       «Canceled» بعد دقيقتين. لاجلك مابتبعتش سبب ولا ويبهوك — الإشارة
       الوحيدة إن الشحنة بقت cancelled **من غير ما احنا نلغيها**.
     • W1789826771169 (0.32 كم): نفس الكابتن اتعيّن على طلب ٧٫٣ كم في نفس
       اللحظة، وصّل البعيد الأول وساب القريب في الطريق ٣٥+ دقيقة.

   الموديول ده:
     ١) بيكشف: إلغاء/رفض من الشركة، ومفيش كابتن في المهلة، ومخالفات الـSLA
        (التعيين، الوصول للمطعم حسب العقد، التوصيل بعد الاستلام).
     ٢) بينبّه: SMS للإدارة (staffalerts) + إشعار البوابة (sla_alert مستوى ٢)
        — مرة واحدة لكل مشكلة لكل شحنة.
     ٣) بيدّي المدير في البوابة ٤ اختيارات: إعادة لاجلك، شركة تانية، «مندوب
        خارجي» (اسم/جوال/تكلفة/ملاحظات + استلم/وصّل يدوي)، أو تحويل لاستلام.
     ٤) بيحرس الطلبات البعيدة (>١٠ كم) قبل ما تتبعت: تأكيد المدير أو اقتراح
        مندوب خارجي.
     ٥) بيسجّل كل مخالفة في dl_sla_breaches → تقرير «مخالفات لاجلك» للمطالبات.

   مفيش فلوس هنا: لا استرجاع ولا خصم (قاعدة البوابة). التحويل لاستلام بيعلّم
   «راجع استرجاع رسوم التوصيل» ويسيب القرار لبني آدم.
═══════════════════════════════════════════════════════════════════════════ */

import { STORE_LAT, STORE_LNG } from "./tsstore.js";
import { cacheKey } from "./drivedist.js";
import { PROVIDERS, API_PROVIDER_IDS } from "./couriers.js";
import { driverKey, dispatchDelayOf } from "./delivery.js";
import { fitOneSms, makeStaffNotifier } from "./staffalerts.js";
import { emitOrder } from "./order-events.js";
import { sendSms as sendStaffSms } from "./accounts.js";

/* ── الإعدادات (settings.delivery.courierSla — بتتعدّل من «مطابقة لاجلك») ── */
export const DEFAULT_COURIER_SLA = Object.freeze({
  /* عمر (١٩ سبتمبر، بعد أول نسخة):
     • الكابتن يتعيّن خلال ١–٢ د من طلبنا (أكتر من ٢ = مخالفة)
     • بعد التعيين يوصل المطعم في ١٠–١٥ د (الهدف)، وأقصى حد ٢٠ د (العقد م٣ — من الطلب)
     • من الاستلام للتوصيل = مدة المشوار (جوجل/المسافة) + ٢ د سماح */
  assignMin: 2,
  arriveTargetMin: 15,    // من التعيين — هدف داخلي (١٠–١٥)
  arriveWarnMin: 10,      //   بداية الأصفر
  arriveMin: 20,          // العقد م٣: الكابتن في الفرع خلال ٢٠ د من إسناد الطلب لنظامهم
  deliverGraceMin: 2,
  handoverMaxMin: 10,     // العقد م٣ (علينا): نسلّم خلال ١٠ د من الإسناد — للأمانة في التقرير
  baseMin: 4,             // لو مفيش مدة من جوجل: ٤ + ٢ د/كم
  minPerKm: 2,
  prepMin: 19,            // تقدير التحضير لحساب الـETA قبل «جاهز» (وسيط ٤٧ طلب)
  arriveTypMin: 12,       // المعتاد: الكابتن في المطعم بعد ~١٢ د من الطلب
  handoverMin: 2,         // تسليم الشنطة
  claimMinOverMin: 2,     // المخالفة «قابلة للمطالبة» لو التأخير ≥ ده (الاستطلاع كل دقيقة ± ١)
  alertOverMin: 1,        // SMS بس لو التأخير ≥ ده (دقة الاستطلاع دقيقة)
  nearKm: 0.4,            // «قريب»: ≤ ٥ د مشي (~٨٠ م/د) خط مستقيم
  alertStaff: true,       // SMS للإدارة عند كل مخالفة/رفض
  customerSms: true,      // رسالة للعميل لما المدير يغيّر طريقة التوصيل
  // عمر: «كل حاجة تفضل شغالة زي النهارده» — لاجلك بتتطلب عادي، والبعيد تنبيه بس
  farGuard: { enabled: true, fromKm: 10, mode: "suggest" }, // confirm | suggest | off
});

export function courierSlaCfg(settings = {}) {
  const raw = ((settings || {}).delivery || {}).courierSla || {};
  const out = { ...DEFAULT_COURIER_SLA };
  for (const k of Object.keys(DEFAULT_COURIER_SLA)) {
    if (k === "farGuard" || raw[k] === undefined || raw[k] === null || raw[k] === "") continue;
    if (typeof DEFAULT_COURIER_SLA[k] === "boolean") out[k] = raw[k] !== false && raw[k] !== "false";
    else {
      const n = Number(raw[k]);
      if (Number.isFinite(n) && n >= 0 && n <= 240) out[k] = n;
    }
  }
  const fg = { ...DEFAULT_COURIER_SLA.farGuard, ...(raw.farGuard || {}) };
  fg.enabled = fg.enabled !== false;
  fg.fromKm = Number.isFinite(Number(fg.fromKm)) && Number(fg.fromKm) > 0 ? Number(fg.fromKm) : 10;
  fg.mode = ["confirm", "suggest", "off"].includes(fg.mode) ? fg.mode : "suggest";
  out.farGuard = fg;
  return out;
}

/* ── أوقات الشحنة من سجل أحداثها ─────────────────────────────────────────
   الاستطلاع بيكتب {event:"poll", status}، والويبهوك {event:<خام>}، واليدوي/
   الخارجي {event:<مرحلة>}. بنطلّع أول وقت لكل مرحلة + هل الإلغاء كان منّا. */
const RAW_STATUS = {
  orderaccept: "assigned", driverassigned: "assigned", assigned: "assigned", accepted: "assigned", startride: "assigned",
  reachedshop: "assigned", pickupcompleted: "picked", orderpicked: "picked", shipped: "picked", pickedup: "picked",
  intransit: "picked", ontheway: "picked", delivered: "delivered", completed: "delivered",
  canceled: "cancelled", cancelled: "cancelled", rejected: "cancelled", ordercancelled: "cancelled",
};
const STAGE_STATUS = { handoff: "pending", assigned: "assigned", picked: "picked", delivered: "delivered", cancelled: "cancelled" };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const isoOf = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const ms = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };
const addMin = (iso, m) => { const t = ms(iso); return t == null || !Number.isFinite(Number(m)) ? null : new Date(t + Number(m) * 60_000).toISOString(); };
const r1 = (n) => Math.round(Number(n) * 10) / 10;

export function eventStatus(e, provider) {
  if (!e || typeof e !== "object") return null;
  if (e.status) return String(e.status);
  const ev = String(e.event || "");
  if (provider === "manual" || provider === "external" || e.provider === "manual" || e.provider === "external") {
    if (STAGE_STATUS[ev]) return STAGE_STATUS[ev];
  }
  if (ev === "created") return "pending";
  return RAW_STATUS[norm(ev)] || RAW_STATUS[norm(e.raw)] || null;
}

export function shipmentTimes(sh = {}) {
  const evs = Array.isArray(sh.events) ? sh.events : [];
  const t = {
    requestedAt: isoOf(sh.created_at),
    assignedAt: isoOf(sh.assigned_at),
    arrivedAt: isoOf(sh.arrived_at),
    pickedAt: isoOf(sh.picked_at),
    deliveredAt: isoOf(sh.delivered_at),
    cancelledAt: null,
    ourCancel: false,
  };
  const RANK = { assigned: 1, picked: 2, delivered: 3 };
  for (const e of evs) {
    const at = isoOf(e && e.at);
    if (!at) continue;
    const ev = String((e && e.event) || "");
    if (ev === "cancel" || ev === "cancel_failed" || (ev === "cancelled" && e.by)) t.ourCancel = true;
    const st = eventStatus(e, sh.provider);
    if (!st) continue;
    // أي مرحلة بعد التعيين معناها إن التعيين حصل قبلها أو ساعتها
    if (RANK[st] && !t.assignedAt) t.assignedAt = at;
    if (st === "picked" && !t.pickedAt) t.pickedAt = at;
    if (st === "delivered" && !t.deliveredAt) t.deliveredAt = at;
    if (st === "cancelled" && !t.cancelledAt) t.cancelledAt = at;
  }
  return t;
}

/* الشركة لغت/رفضت من عندها: الشحنة cancelled ومفيش أي إلغاء صادر منّا. */
export function providerCancelled(sh = {}, times = shipmentTimes(sh)) {
  if (String(sh.status) !== "cancelled") return false;
  if (!API_PROVIDER_IDS.includes(String(sh.provider || ""))) return false;
  return !times.ourCancel;
}

/* ── المدة المتوقعة للمشوار ─────────────────────────────────────────────
   لاجلك مابتدّيش ETA خالص (الـAPI فيه id/status/driver بس). فبناخد مدة
   جوجل المخزّنة وقت التسعير (geo_drive_cache) — وبما إن جوجل من غير زحمة
   بيقلّل، بناخد الأكبر بينه وبين نموذج من طلباتنا الحقيقية. */
export function expectedDriveMin({ km, durationSec } = {}, cfg = DEFAULT_COURIER_SLA) {
  /* عمر: «مدة المشوار (جوجل/المسافة)». مدة جوجل المخزّنة وقت التسعير لو
     موجودة، وإلا نموذج المسافة. */
  const g = Number(durationSec) > 0 ? Number(durationSec) / 60 : null;
  if (g) return Math.max(1, Math.ceil(g));
  const k = Number(km);
  return Number.isFinite(k) && k > 0 ? Math.ceil(cfg.baseMin + cfg.minPerKm * k) : null;
}

/* ── تقييم الشحنة: المهل + المخالفات + الـETA ───────────────────────────
   كل مهلة = {start, at, done, target}. المؤقتات الحية بتتحسب في المتصفح
   من start/target — السيرفر مابيبعتش «فاضل كام» عشان بصمة الطلب ماتتغيرش. */
export function evalCourierSla({ sh, times, km = null, expectedMin = null, readyAt = null, acceptedAt = null, cfg = DEFAULT_COURIER_SLA, now = Date.now() } = {}) {
  const t = times || shipmentTimes(sh || {});
  const provider = String((sh && sh.provider) || "");
  const api = API_PROVIDER_IDS.includes(provider);
  const status = String((sh && sh.status) || "");
  const cancelled = status === "cancelled";
  const deadlines = {};
  const breaches = [];
  const over = (deadline, actual) => {
    const d = ms(deadline), a = actual ? ms(actual) : now;
    return d == null || a == null ? null : r1((a - d) / 60_000);
  };
  const add = (code, startedAt, deadlineAt, actualAt, basis) => {
    const o = over(deadlineAt, actualAt);
    if (o == null || o <= 0) return;
    const v = VIOLATIONS[code] || {};
    breaches.push({ code, startedAt, deadlineAt, actualAt: actualAt || null, overMin: o, basis: basis || null, open: !actualAt,
      claimable: api && v.side === "leajlak" && Boolean(v.contract) && o >= (Number(cfg.claimMinOverMin) || 0) });
  };
  const arrivedOrPicked = t.arrivedAt || t.pickedAt || null;

  // ١) التعيين ≤ assignMin من طلبنا (عمر)
  if (t.requestedAt) {
    const dl = addMin(t.requestedAt, cfg.assignMin);
    deadlines.assign = { start: t.requestedAt, at: dl, done: t.assignedAt || null, target: cfg.assignMin };
    if (api) {
      if (t.assignedAt) add("assign_late", t.requestedAt, dl, t.assignedAt, "assigned");
      else if (!cancelled) add("assign_late", t.requestedAt, dl, null, "still_pending");
    }
  }
  // ٢أ) الوصول بعد التعيين — الهدف الداخلي (١٠–١٥ د)
  if (t.assignedAt) {
    const dl = addMin(t.assignedAt, cfg.arriveTargetMin);
    deadlines.arrive = { start: t.assignedAt, at: dl, done: arrivedOrPicked, target: cfg.arriveTargetMin, warn: cfg.arriveWarnMin,
      basis: t.arrivedAt ? "arrived" : t.pickedAt ? "picked" : null };
    if (api && !(cancelled && !arrivedOrPicked)) add("arrive_slow", t.assignedAt, dl, arrivedOrPicked, t.arrivedAt ? "arrived" : arrivedOrPicked ? "picked_no_arrival_signal" : "not_arrived");
  }
  // ٢ب) الوصول — حد العقد م٣: ≤ ٢٠ د من إسناد الطلب لنظامهم (= طلبنا)
  if (t.requestedAt) {
    const dl = addMin(t.requestedAt, cfg.arriveMin);
    deadlines.arriveMax = { start: t.requestedAt, at: dl, done: arrivedOrPicked, target: cfg.arriveMin, basis: t.arrivedAt ? "arrived" : t.pickedAt ? "picked" : null };
    if (api && !(cancelled && !arrivedOrPicked)) {
      add("arrive_late", t.requestedAt, dl, arrivedOrPicked, t.arrivedAt ? "arrived" : arrivedOrPicked ? "picked_no_arrival_signal" : "not_arrived");
    }
  }
  // ٣) التوصيل = مدة المشوار + سماح بعد الاستلام
  if (t.pickedAt && expectedMin) {
    const target = expectedMin + (Number(cfg.deliverGraceMin) || 0);
    const dl = addMin(t.pickedAt, target);
    deadlines.deliver = { start: t.pickedAt, at: dl, done: t.deliveredAt || null, target, expectedMin };
    if (api && !cancelled) add("deliver_late", t.pickedAt, dl, t.deliveredAt || null, t.deliveredAt ? "delivered" : "not_delivered");
  }
  // ٤) علينا (العقد م٣ ثانياً): التسليم خلال ١٠ د من الإسناد — لو الكابتن استنّانا.
  //    مش قابلة للمطالبة، بس لازم تبان: لاجلك هتحتج بيها.
  if (api && t.requestedAt && t.pickedAt && t.arrivedAt) {
    const dl = addMin(t.requestedAt, cfg.handoverMaxMin);
    const from = ms(t.arrivedAt) > ms(dl) ? t.arrivedAt : dl;   // التأخير اللي علينا بيبدأ من وصوله أو الـ١٠ د، أيهما أبعد
    const o = over(from, t.pickedAt);
    if (o != null && o > 5) breaches.push({ code: "our_handover_late", startedAt: t.requestedAt, deadlineAt: from, actualAt: t.pickedAt,
      overMin: o, basis: "captain_waited", open: false, claimable: false });
  }

  // الـETA (تقديري — الشركة مابتدّيش واحد)
  let eta = null, etaBasis = null;
  if (t.deliveredAt) { eta = t.deliveredAt; etaBasis = "delivered"; }
  else if (!cancelled && expectedMin) {
    if (t.pickedAt) { eta = addMin(t.pickedAt, expectedMin); etaBasis = "picked"; }
    else {
      const readyEst = readyAt || (acceptedAt ? addMin(acceptedAt, cfg.prepMin) : null);
      const atShop = t.arrivedAt || (t.assignedAt ? addMin(t.assignedAt, cfg.arriveTargetMin)
        : t.requestedAt ? addMin(t.requestedAt, cfg.arriveTypMin) : null);
      const base = [readyEst, atShop].filter(Boolean).map(ms).reduce((a, b) => Math.max(a, b), 0);
      if (base) { eta = addMin(new Date(base).toISOString(), cfg.handoverMin + expectedMin); etaBasis = t.arrivedAt ? "arrived" : t.assignedAt ? "assigned" : "requested"; }
    }
  }
  return { times: t, deadlines, breaches, eta, etaBasis, km: km != null ? r1(km) : null, expectedMin };
}

/* ETA لطلب لسه مالوش مندوب (مقبول، بيتجهّز): المندوب بيتطلب عند «جاهز» أو
   بعد مهلة التحضير، وبيوصل المطعم بعد arriveTypMin، والأكل جاهز عند readyEst. */
export function preDispatchEta({ acceptedAt, readyAt, expectedMin, dispatchDelayMin = 15, cfg = DEFAULT_COURIER_SLA } = {}) {
  if (!expectedMin || !(acceptedAt || readyAt)) return null;
  const readyEst = readyAt || addMin(acceptedAt, cfg.prepMin);
  const dispatchAt = readyAt || addMin(acceptedAt, dispatchDelayMin);
  const atShop = addMin(dispatchAt, cfg.arriveTypMin);
  const base = Math.max(ms(readyEst), ms(atShop));
  return addMin(new Date(base).toISOString(), cfg.handoverMin + expectedMin);
}

/* ── حارس المشاوير البعيدة ───────────────────────────────────────────────
   العقد م٣: «يحق للطرف الأول رفض أي طلب يتجاوز ١٠ كم أو تحصيل ٢ ر.س/كم —
   القرار النهائي لإدارة العمليات». يعني أي طلب فوق ١٠ كم معرّض للرفض. */
export function routeKmOf(row = {}) {
  let q = row.delivery_quote;
  if (typeof q === "string") { try { q = JSON.parse(q); } catch { q = null; } }
  const cand = [row.route_km, q && q.routeKm, q && q.farZone && q.farZone.km, q && q.distanceKm];
  for (const v of cand) { const n = Number(v); if (v != null && v !== "" && Number.isFinite(n) && n > 0) return n; }
  return null;
}
/* «قريب» = ≤ ٥ د مشي: المسافة المستقيمة من التسعيرة (straightKm) */
export function straightKmOf(row = {}) {
  let q = row.delivery_quote;
  if (typeof q === "string") { try { q = JSON.parse(q); } catch { q = null; } }
  const n = Number(row.straight_km ?? (q && q.straightKm));
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function distanceBadge(row = {}, cfg = DEFAULT_COURIER_SLA) {
  const km = routeKmOf(row), st = straightKmOf(row);
  const fromKm = (cfg.farGuard && cfg.farGuard.fromKm) || 10;
  if (km != null && km > fromKm) return { kind: "far", km: r1(km) };
  if (st != null && st <= cfg.nearKm) return { kind: "near", km: r1(km ?? st), walkMin: Math.max(1, Math.round(st * 1000 / 80)) };
  return null;
}
/* «توصيل بموظف»: أسماء فريق البورتال (من غير المطبخ ولا أرقام سرية) عشان
   المدير يختار من قايمة بدل ما يكتب الاسم. */
export function staffCourierNames(settings = {}) {
  const list = ((settings || {}).portal || {}).staff;
  if (!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  for (const s of list) {
    if (!s || typeof s !== "object" || s.active === false || s.role === "kitchen") continue;
    const name = String(s.name || "").trim().slice(0, 60);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: String(s.id || name).slice(0, 40), name, role: s.role === "manager" ? "manager" : "cashier" });
  }
  return out;
}
export function farGuardDecision(row = {}, cfg = DEFAULT_COURIER_SLA) {
  const km = routeKmOf(row);
  const fg = cfg.farGuard || DEFAULT_COURIER_SLA.farGuard;
  const far = Boolean(fg.enabled) && fg.mode !== "off" && km != null && km > fg.fromKm;
  return { far, km: km != null ? r1(km) : null, fromKm: fg.fromKm, mode: fg.mode, hold: far && fg.mode === "confirm" };
}

/* ── النصوص ─────────────────────────────────────────────────────────────── */
/* ═══ كتالوج المخالفات — كل التزام قابل للقياس في العقد ببنده ═══════════
   العقد: Logistics Services Agreement بتاريخ 24/8/2026 (On Demand Contract - Standard).
   side: leajlak = التزام عليهم (قابل للمطالبة) · ours = التزام علينا (للأمانة —
   هيحتجوا بيه) · internal = معيار عمر مش مكتوب في العقد.
   auto: السيستم بيكشفها لوحده · manual: المدير بيبلّغ عنها من البوابة. */
export const VIOLATIONS = Object.freeze({
  arrive_late: { label: "الكابتن ما وصلش الفرع خلال ٢٠ د", clause: "م٣ أولاً: الوصول للفرع خلال ٢٠ د من إسناد الطلب لنظام الطرف الأول", side: "leajlak", contract: true, auto: true },
  no_assignment: { label: "مفيش كابتن خالص", clause: "م٣ أولاً (٢٠ د للوصول) + م٥ (استلام الطلبات حسب المحدد في النظام)", side: "leajlak", contract: true, auto: true },
  provider_cancelled: { label: "لغوا طلب داخل نطاق ١٠ كم", clause: "م٣ أولاً: التوصيل داخل ١٠ كم + نسبة الإلغاء ≤ ٥٪", side: "leajlak", contract: true, auto: true },
  refused_far: { label: "رفض طلب فوق ١٠ كم", clause: "م٣ أولاً: حق الرفض فوق ١٠ كم مسموح — بس بيتحسب في نسبة الإلغاء ≤ ٥٪", side: "leajlak", contract: true, auto: true, rateOnly: true },
  cancel_rate: { label: "نسبة الإلغاء عدّت ٥٪ في الشهر", clause: "م٣ أولاً: نسبة الإلغاء ≤ ٥٪ من الطلبات المسندة", side: "leajlak", contract: true, auto: true },
  deliver_late: { label: "التوصيل اتأخر بعد الاستلام", clause: "م٥: خدمة توصيل دقيقة وفي الوقت + م٧: تعويض ٤٠٪ عند خطأ/إهمال (سقف ٣٪ من فاتورة الشهر)", side: "leajlak", contract: true, auto: true },
  damaged: { label: "الطلب وصل تالف/متغيّر", clause: "م٣ أولاً: التسليم بحالة ممتازة كما استُلم بدون تلف أو تغيير + م٧: المسؤولية عن التلف", side: "leajlak", contract: true, manual: true },
  lost_theft: { label: "ضياع/سرقة الطلب", clause: "م٧: مسؤولية الطرف الأول عن قيمة الطلب عند الفقد/التلف/السرقة (تحقيق مشترك)", side: "leajlak", contract: true, manual: true },
  customer_refused_driver: { label: "العميل رفض الاستلام بسبب الكابتن", clause: "م٧: قيمة الطلب المرفوض لأسباب تخص سائق الطرف الأول", side: "leajlak", contract: true, manual: true },
  wrong_location: { label: "وصّل لمكان غلط/ما التزمش بالخريطة", clause: "م٥: التحقق من توفر الخريطة المطلوبة لضمان التوصيل للموقع المحدد", side: "leajlak", contract: true, manual: true },
  not_verified: { label: "الكابتن ماراجعش الطلب قبل ما يمشي", clause: "م٥: التحقق المشترك من الطلبات قبل مغادرة الفرع", side: "leajlak", contract: true, manual: true },
  not_per_instructions: { label: "ماالتزمش بتعليمات الطلب/المطعم", clause: "م٥: الاستلام وفق تعليمات الطرف الثاني", side: "leajlak", contract: true, manual: true },
  driver_unreachable: { label: "الكابتن مابيردش/مالوش جوال شغال", clause: "م٣ أولاً: جوال مخصص بشريحة وإنترنت للتواصل والتتبع", side: "leajlak", contract: true, manual: true },
  driver_conduct: { label: "الزي/النظافة/السلامة", clause: "م٣ أولاً: الزي الرسمي والنظافة الشخصية ومعدات السلامة", side: "leajlak", contract: true, manual: true },
  vehicle_noncompliant: { label: "المركبة مش مطابقة", clause: "م٣ أولاً: مطابقة المركبة للاشتراطات النظامية", side: "leajlak", contract: true, manual: true },
  no_tracking_updates: { label: "مفيش تتبع/تحديث للعميل بالوقت المتوقع", clause: "م٤: نظام تتبع لحظي + تحديث العملاء بوقت الوصول المتوقع", side: "leajlak", contract: true, manual: true },
  refused_return_late: { label: "المرفوض ما رجعش خلال ٦٠ د", clause: "م٧: إرجاع الطلب المرفوض خلال ٦٠ د", side: "leajlak", contract: true, manual: true },
  cod_not_remitted: { label: "مبلغ كاش ما اتسلّمش للفرع", clause: "م٦: تحصيل الدفع عند الاستلام وتسليمه للفرع مباشرة", side: "leajlak", contract: true, manual: true },
  overcharge: { label: "سعر أعلى من العقد", clause: "م١٢: ١٧ ر.س + ضريبة لحد ١٠ كم، ٢ ر.س/كم بعدها (شوف «مطابقة الفاتورة»)", side: "leajlak", contract: true, manual: true },
  assign_late: { label: "تعيين الكابتن اتأخر (> ٢ د)", clause: "معيار داخلي (عمر: ١–٢ د) — مش بند صريح في العقد", side: "internal", contract: false, auto: true },
  arrive_slow: { label: "الوصول بعد التعيين عدّى الهدف (١٥ د)", clause: "معيار داخلي (عمر: ١٠–١٥ د من التعيين) — حد العقد ٢٠ د", side: "internal", contract: false, auto: true },
  our_handover_late: { label: "الكابتن استنّانا (علينا)", clause: "م٣ ثانياً (علينا): تجهيز وتسليم الطلب خلال ١٠ د من الإسناد", side: "ours", contract: true, auto: true },
  other: { label: "مخالفة تانية", clause: "—", side: "leajlak", contract: false, manual: true },
});
export const MANUAL_VIOLATIONS = Object.freeze(Object.keys(VIOLATIONS).filter((k) => VIOLATIONS[k].manual));
export const CODE_AR = Object.freeze({
  ...Object.fromEntries(Object.entries(VIOLATIONS).map(([k, v]) => [k, v.label])),
  far_hold: "مشوار بعيد — مستني قرار المدير",
  far_risk: "مشوار بعيد — ممكن الشركة ترفضه",
  held: "المدير وقّف طلب لاجلك",
  asked_leajlak: "سألنا لاجلك",
});
const EN = {
  provider_cancelled: (x) => `courier company CANCELLED the order${x.km ? ` (${x.km}km)` : ""}. Portal: retry/other/external`,
  refused_far: (x) => `courier REFUSED far order ${x.km}km. Portal: retry/other/external courier`,
  no_assignment: (x) => `no captain assigned after ${x.min}min. Portal: retry/other/external`,
  far_hold: (x) => `far order ${x.km}km HELD (courier may refuse). Portal: confirm courier or external`,
  far_risk: (x) => `far order ${x.km}km sent to courier - they may refuse. Have a backup courier ready`,
  assign_late: (x) => `no captain ${x.target}min after request (+${x.over}min)`,
  arrive_slow: (x) => `captain not at shop ${x.target}min after assignment (+${x.over}min)`,
  arrive_late: (x) => `captain not at shop ${x.target}min after request - CONTRACT (+${x.over}min)`,
  deliver_late: (x) => `delivery late +${x.over}min after pickup (route ${x.target}min)`,
};
const AR = {
  provider_cancelled: () => "شركة التوصيل لغت - افتح البوابة",
  refused_far: (x) => `المندوب رفض مشوار ${x.km}كم - افتح البوابة`,
  no_assignment: (x) => `مفيش كابتن بعد ${x.min}د - افتح البوابة`,
  far_hold: (x) => `مشوار ${x.km}كم مستني قرارك في البوابة`,
  far_risk: (x) => `مشوار ${x.km}كم - لاجلك ممكن ترفض`,
  assign_late: (x) => `مفيش كابتن بعد ${x.target}د`,
  arrive_slow: (x) => `الكابتن اتأخر عن المطعم ${x.over}د`,
  arrive_late: (x) => `الكابتن عدّى ٢٠د ومش في المطعم`,
  deliver_late: (x) => `التوصيل متأخر ${x.over}د`,
};
export function courierAlertText(orderNo, code, x = {}, lang = "en") {
  const X = { ...x, over: x.over != null ? Math.round(x.over) : "?", km: x.km != null ? r1(x.km) : null };
  if (lang === "ar") return fitOneSms(`فريش كاتس ${orderNo}: ${(AR[code] || (() => CODE_AR[code] || code))(X)}`);
  return fitOneSms(`Fresh Cuts ALERT ${orderNo}: ${(EN[code] || (() => code))(X)}`);
}
/* للعميل — معاملاتية بس، جزء UCS-2 واحد (≤٧٠)، من غير عروض ولا روابط تسويق */
export const CUSTOMER_TEXT = Object.freeze({
  external: (no) => `فريش كاتس: رتّبنا مندوب بديل لطلبك ${no} 🛵`,
  switched: (no) => `فريش كاتس: بنرتّب مندوب لطلبك ${no} - نعتذر عن التأخير`,
});

/* ── التقرير: CSV بنفس ترتيب الشاشة ─────────────────────────────────────── */
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const riyadh = (iso) => {
  const t = ms(iso);
  if (t == null) return "";
  return new Date(t + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
};
export const VIOLATION_COLS = [
  ["orderNo", "رقم الطلب (AWB)"], ["providerRef", "مرجع لاجلك"], ["provider", "الشركة"], ["type", "المخالفة"],
  ["startedAt", "بداية المهلة"], ["deadlineAt", "آخر موعد"], ["actualAt", "الوقت الفعلي"], ["overMin", "دقايق التأخير"],
  ["km", "المسافة كم"], ["driver", "الكابتن"], ["side", "على مين"], ["contractRef", "مرجع العقد"], ["claimable", "قابلة للمطالبة"],
  ["claimStatus", "حالة المطالبة"], ["note", "ملاحظات"],
];
export const CONTRACT_REF = Object.freeze(Object.fromEntries(Object.entries(VIOLATIONS).map(([k, v]) => [k, v.clause])));
const SIDE_AR = { leajlak: "على لاجلك", ours: "علينا", internal: "معيار داخلي" };
export function violationsCsv(rows = []) {
  const head = VIOLATION_COLS.map(([, h]) => csvCell(h)).join(",");
  const body = rows.map((r) => VIOLATION_COLS.map(([k]) => {
    let v = r[k];
    if (k === "type") v = CODE_AR[r.code] || r.code;
    if (["startedAt", "deadlineAt", "actualAt"].includes(k)) v = riyadh(v);
    if (k === "contractRef") v = CONTRACT_REF[r.code] || "";
    if (k === "side") v = SIDE_AR[(VIOLATIONS[r.code] || {}).side] || "";
    if (k === "claimable") v = r.claimable ? "نعم" : "لا";
    return csvCell(v);
  }).join(","));
  return "﻿" + [head, ...body].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════ */
export const OPS_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS dl_courier_incidents (
    id BIGSERIAL PRIMARY KEY,
    order_no TEXT NOT NULL,
    shipment_id BIGINT NOT NULL DEFAULT 0,
    provider TEXT,
    kind TEXT NOT NULL,
    reason TEXT,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    alerted_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    resolution TEXT,
    resolved_by TEXT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (order_no, shipment_id, kind)
  )`,
  `CREATE INDEX IF NOT EXISTS dl_courier_incidents_open_idx ON dl_courier_incidents(order_no) WHERE resolved_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS dl_sla_breaches (
    id BIGSERIAL PRIMARY KEY,
    order_no TEXT NOT NULL,
    shipment_id BIGINT NOT NULL,
    provider TEXT,
    code TEXT NOT NULL,
    basis TEXT,
    started_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ,
    actual_at TIMESTAMPTZ,
    over_min NUMERIC,
    claimable BOOLEAN NOT NULL DEFAULT FALSE,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    alerted_at TIMESTAMPTZ,
    claim_status TEXT NOT NULL DEFAULT 'open',
    note TEXT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (shipment_id, code)
  )`,
  `CREATE INDEX IF NOT EXISTS dl_sla_breaches_time_idx ON dl_sla_breaches(deadline_at DESC)`,
  `CREATE INDEX IF NOT EXISTS dl_sla_breaches_order_idx ON dl_sla_breaches(order_no)`,
]);

const INCIDENT_KINDS = new Set(["provider_cancelled", "refused_far", "no_assignment", "far_hold", "far_risk"]);
const RESOLUTIONS = new Set(["retry", "switch", "external", "staff", "dismissed", "auto"]);
// تنبيه «حي» بس: مانبعتش SMS لمخالفة قديمة اتكشفت أول مرة بعد نشر
const FRESH_MS = 45 * 60_000;
const NO_ASSIGN_INCIDENT_MIN = 8;

export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData, requireAdmin, jb } = ctx;
  const log = ctx.log || console;
  const shop = typeof deps.shop === "function" ? deps.shop : () => deps.shop || null;
  const delivery = typeof deps.delivery === "function" ? deps.delivery : () => deps.delivery || null;
  const portal = typeof deps.portal === "function" ? deps.portal : () => deps.portal || null;
  const notify = typeof deps.notify === "function" ? deps.notify : () => deps.notify || null;
  // التتبّع الحي (٢١ سبتمبر): رابط المندوب الخارجي بيتعمل في نفس الطلبة
  const courierLive = typeof deps.courierLive === "function" ? deps.courierLive : () => deps.courierLive || null;
  const emit = deps.emitOrder || emitOrder;
  const now = deps.now || (() => Date.now());
  const J = jb || ((v) => JSON.stringify(v));
  const staff = deps.staff || makeStaffNotifier({
    getSettingsData,
    sendSms: deps.sendSms || sendStaffSms,
  });

  let ready = null;
  function ensureSchema() {
    if (!ready) {
      ready = (async () => { for (const sql of OPS_DDL) await pool.query(sql); return true; })()
        .catch((e) => { ready = null; try { log.error(`[courierops] schema failed: ${e?.message || e}`); } catch {} return false; });
    }
    return ready;
  }
  if (deps.ensureSchema !== false) ensureSchema();

  const cfgOf = async () => courierSlaCfg(await getSettingsData());

  /* مدة جوجل المخزّنة للعنوان — من الكاش بس، عمرنا ما نضرب جوجل هنا */
  const durCache = new Map();
  async function durationSecOf(addr) {
    const lat = Number(addr && (addr.latitude ?? addr.lat)), lng = Number(addr && (addr.longitude ?? addr.lng));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat || !lng) return null;
    const k = cacheKey(lat, lng);
    if (durCache.has(k)) return durCache.get(k);
    let v = null;
    try {
      const r = await pool.query("SELECT duration_sec FROM geo_drive_cache WHERE dest_key=$1", [k]);
      v = r.rows[0] && r.rows[0].duration_sec != null ? Number(r.rows[0].duration_sec) : null;
    } catch { v = null; }
    if (durCache.size > 2000) durCache.clear();
    durCache.set(k, v);
    return v;
  }

  async function sendStaff(orderNo, code, x, tag) {
    try {
      const c = await cfgOf();
      if (!c.alertStaff) return 0;
      return await staff.critical((lang) => courierAlertText(orderNo, code, x, lang), tag);
    } catch (e) {
      try { log.error(`[courierops] staff sms ${tag} failed: ${e?.message || e}`); } catch {}
      return 0;
    }
  }
  function slaEvent(orderNo, code, level, extra = {}) {
    try {
      emit("sla_alert", { orderNo: String(orderNo), source: "courierops", ok: null,
        data: { code: `courier_${code}`, level, notified: level >= 2, action: "courier_ops", ...extra } });
    } catch { /* never */ }
  }

  /* ── الحوادث ── */
  async function openIncident(orderNo, kind, { shipmentId = 0, provider = null, reason = null, detail = {}, alert = true, resolved = null, by = null } = {}) {
    await ensureSchema();
    const ins = await pool.query(
      `INSERT INTO dl_courier_incidents(order_no, shipment_id, provider, kind, reason, detail, resolved_at, resolution, resolved_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb, CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() END, $7, $8)
       ON CONFLICT (order_no, shipment_id, kind) DO NOTHING RETURNING id`,
      [String(orderNo), Number(shipmentId) || 0, provider, kind, reason, J(detail || {}), resolved, by]);
    if (!ins.rowCount) return null;
    const id = ins.rows[0].id;
    if (alert) {
      await pool.query("UPDATE dl_courier_incidents SET alerted_at=NOW() WHERE id=$1", [id]);
      sendStaff(orderNo, kind, detail, `courier ${kind} ${orderNo}`);
      slaEvent(orderNo, kind, 2, { km: detail.km ?? null, provider });
    } else {
      slaEvent(orderNo, kind, 1, { km: detail.km ?? null, provider });
    }
    return id;
  }
  async function resolveIncidents(orderNo, resolution, by, extra = {}) {
    await ensureSchema();
    const r = await pool.query(
      `UPDATE dl_courier_incidents SET resolved_at=NOW(), resolution=$2, resolved_by=$3,
              detail = detail || $4::jsonb
        WHERE order_no=$1 AND resolved_at IS NULL RETURNING id`,
      [String(orderNo), resolution, by || null, J(extra || {})]);
    return r.rowCount;
  }

  /* ── المراقب: كل دقيقة ── */
  let scanning = false;
  async function scan() {
    if (scanning) return { skipped: true };
    scanning = true;
    const out = { shipments: 0, breaches: 0, incidents: 0 };
    try {
      if (!(await ensureSchema())) return out;
      const cfg = await cfgOf();
      const rows = (await pool.query(
        `SELECT sh.*, s.status AS order_status, s.option, s.is_test, s.address, s.delivery_quote,
                s.pos_ready_at, s.accepted_at, s.history
           FROM dl_shipments sh JOIN shop_orders s ON s.order_no = sh.shop_order_no
          WHERE sh.created_at > NOW() - INTERVAL '36 hours'
          ORDER BY sh.id`)).rows;
      const t = now();
      for (const sh of rows) {
        out.shipments++;
        const times = shipmentTimes(sh);
        if ((times.assignedAt && !sh.assigned_at) || (times.deliveredAt && !sh.delivered_at)) {
          await pool.query(
            `UPDATE dl_shipments SET assigned_at = COALESCE(assigned_at, $2), delivered_at = COALESCE(delivered_at, $3) WHERE id=$1`,
            [sh.id, times.assignedAt, times.deliveredAt]).catch(() => {});
        }
        const km = routeKmOf(sh);
        const expectedMin = expectedDriveMin({ km, durationSec: await durationSecOf(sh.address) }, cfg);
        const ev = evalCourierSla({ sh, times, km, expectedMin, readyAt: sh.pos_ready_at, cfg, now: t });
        const drv = driverKey(sh.driver);
        for (const b of ev.breaches) {
          const dkey = { assign_late: "assign", arrive_slow: "arrive", arrive_late: "arriveMax", deliver_late: "deliver" }[b.code];
          const detail = { expectedMin, km: km != null ? r1(km) : null, target: dkey ? (ev.deadlines[dkey] || {}).target ?? null : null,
            driver: sh.driver && sh.driver.name ? String(sh.driver.name).slice(0, 80) : null, driverKey: drv };
          // «الكابتن كان شايل طلب تاني» — دليل للمطالبة (زي W1789826771169)
          if (b.code === "deliver_late" && drv) {
            const others = rows.filter((o) => o.id !== sh.id && driverKey(o.driver) === drv && o.picked_at && sh.picked_at
              && Math.abs(ms(o.picked_at) - ms(sh.picked_at)) < 30 * 60_000).map((o) => o.shop_order_no);
            if (others.length) detail.sharedDriverWith = others;
          }
          const up = await pool.query(
            `INSERT INTO dl_sla_breaches(order_no, shipment_id, provider, code, basis, started_at, deadline_at, actual_at,
                                         over_min, claimable, is_test, detail)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
             ON CONFLICT (shipment_id, code) DO UPDATE SET
               actual_at = EXCLUDED.actual_at, over_min = EXCLUDED.over_min, basis = EXCLUDED.basis,
               claimable = EXCLUDED.claimable, deadline_at = EXCLUDED.deadline_at,
               detail = dl_sla_breaches.detail || EXCLUDED.detail
             WHERE dl_sla_breaches.actual_at IS NULL
             RETURNING id, (xmax = 0) AS inserted, alerted_at`,
            [sh.shop_order_no, sh.id, sh.provider, b.code, b.basis, b.startedAt, b.deadlineAt, b.actualAt,
             b.overMin, b.claimable, Boolean(sh.is_test), J(detail)]);
          const row = up.rows[0];
          if (!row) continue;
          if (row.inserted) out.breaches++;
          const fresh = t - ms(b.deadlineAt) < FRESH_MS;
          const alertable = (VIOLATIONS[b.code] || {}).side !== "ours" && b.overMin >= (Number(cfg.alertOverMin) || 0);
          if (!row.alerted_at && fresh && alertable && !sh.is_test) {
            const claim = await pool.query("UPDATE dl_sla_breaches SET alerted_at=NOW() WHERE id=$1 AND alerted_at IS NULL RETURNING id", [row.id]);
            if (claim.rowCount) {
              sendStaff(sh.shop_order_no, b.code, { over: b.overMin, target: detail.target, km: detail.km }, `courier ${b.code} ${sh.shop_order_no}`);
              slaEvent(sh.shop_order_no, b.code, 2, { over: b.overMin });
            }
          }
          // مفيش كابتن = مشكلة بتحتاج قرار، مش بس رقم في تقرير
          // (بعد ٨ د من غير كابتن — التعيين الطبيعي دقيقة، والمخالفة نفسها بتتسجّل من ٢ د)
          if (b.code === "assign_late" && b.open && !sh.is_test && b.overMin + cfg.assignMin >= NO_ASSIGN_INCIDENT_MIN) {
            await openIncident(sh.shop_order_no, "no_assignment", { shipmentId: sh.id, provider: sh.provider,
              reason: `مفيش كابتن بعد ${NO_ASSIGN_INCIDENT_MIN} د من الطلب`, detail: { km: detail.km, min: NO_ASSIGN_INCIDENT_MIN }, alert: false });
          }
        }
        // الشركة لغت/رفضت
        if (providerCancelled(sh, times)) {
          const farCut = (cfg.farGuard && cfg.farGuard.fromKm) || 10;
          const kind = km != null && km > farCut ? "refused_far" : "provider_cancelled";
          // الحادثة بتتفتح بس لو الطلب لسه محتاج توصيل (مش اتلغى/اترجع/اتوصّل بمندوب تاني)
          const stillNeeds = ["courier_cancelled", "accepted", "courier_requested"].includes(String(sh.order_status));
          const latest = rows.filter((o) => o.shop_order_no === sh.shop_order_no).every((o) => o.id <= sh.id);
          if (stillNeeds && latest) {
            const fresh = t - ms(times.cancelledAt || sh.updated_at) < FRESH_MS;
            const id = await openIncident(sh.shop_order_no, kind, { shipmentId: sh.id, provider: sh.provider,
              reason: kind === "refused_far" ? `رفض مشوار ${r1(km)} كم (العقد م٣: حق الرفض فوق ١٠ كم)` : "الشركة لغت الطلب من عندها — مفيش سبب في الـAPI",
              detail: { km: km != null ? r1(km) : null, cancelledAt: times.cancelledAt, assignedAt: times.assignedAt }, alert: fresh && !sh.is_test });
            if (id) out.incidents++;
          }
        }
      }
      // حوادث «مفيش كابتن» اللي اتحلّت لوحدها (اتعيّن كابتن بعد التأخير)
      await pool.query(
        `UPDATE dl_courier_incidents i SET resolved_at=NOW(), resolution='auto', resolved_by='system'
           FROM dl_shipments sh
          WHERE i.resolved_at IS NULL AND i.kind='no_assignment' AND sh.id = i.shipment_id
            AND sh.status IN ('assigned','picked','delivered')`).catch(() => {});
      return out;
    } catch (e) {
      try { log.error(`[courierops] scan failed: ${e?.message || e}`); } catch {}
      return out;
    } finally {
      scanning = false;
    }
  }
  if (deps.timers !== false) {
    const t = setInterval(() => { scan(); }, 60_000);
    t.unref?.();
    const t0 = setTimeout(() => { scan(); }, 20_000);
    t0.unref?.();
  }

  /* ── حارس البعيد: shop.js بيسأل قبل الإرسال التلقائي ── */
  async function farCheck(row) {
    try {
      const cfg = await cfgOf();
      const d = farGuardDecision(row, cfg);
      if (!d.far) return d;
      /* «تنبيه بس» (الافتراضي — عمر: «كل حاجة تفضل شغالة زي النهارده»): لاجلك
         بتتطلب عادي، والإدارة بتاخد SMS + علامة «بعيد» على الكارت. الحادثة
         بتتسجّل مقفولة عشان ماتقعدش في شريط المشاكل من غير سبب. */
      await openIncident(row.order_no, d.hold ? "far_hold" : "far_risk", {
        reason: d.hold ? `مشوار ${d.km} كم > ${d.fromKm} — مستني تأكيد المدير قبل طلب المندوب`
          : `مشوار ${d.km} كم > ${d.fromKm} — لاجلك ممكن ترفض؛ جهّز مندوب خارجي احتياطي`,
        detail: { km: d.km, fromKm: d.fromKm, mode: d.mode }, alert: !row.is_test,
        resolved: d.hold ? null : "auto", by: d.hold ? null : "system",
      });
      return d;
    } catch (e) {
      try { log.error(`[courierops] farCheck ${row?.order_no} failed: ${e?.message || e}`); } catch {}
      return { far: false, hold: false };   // عطل في الحارس ما يوقفش التوصيل
    }
  }

  /* ── تزيين طلبات البوابة: الحوادث + المهل + ETA ── */
  async function decorate(rows) {
    try {
      if (!rows || !rows.length || !(await ensureSchema())) return rows;
      const all = await getSettingsData();
      const cfg = courierSlaCfg(all);
      const delayMin = dispatchDelayOf(all);
      const nos = [...new Set(rows.map((r) => r.order_no))];
      const inc = (await pool.query(
        `SELECT DISTINCT ON (order_no) id, order_no, kind, reason, provider, detected_at, resolved_at, resolution, resolved_by, detail
           FROM dl_courier_incidents WHERE order_no = ANY($1::text[])
          ORDER BY order_no, (resolved_at IS NULL) DESC, id DESC`, [nos])).rows;
      const incBy = new Map(inc.map((i) => [i.order_no, i]));
      const shRows = (await pool.query(
        `SELECT DISTINCT ON (shop_order_no) id, shop_order_no, provider, status, events, created_at, assigned_at, arrived_at,
                picked_at, delivered_at, cost, driver
           FROM dl_shipments WHERE shop_order_no = ANY($1::text[]) ORDER BY shop_order_no, id DESC`, [nos])).rows;
      const shBy = new Map(shRows.map((s) => [s.shop_order_no, s]));
      const asked = (await pool.query(
        `SELECT DISTINCT ON (order_no) order_no, detected_at, resolved_by, detail FROM dl_courier_incidents
          WHERE order_no = ANY($1::text[]) AND kind='asked_leajlak' ORDER BY order_no, id DESC`, [nos])).rows;
      const askedBy = new Map(asked.map((a) => [a.order_no, a]));
      /* رابط المندوب الخارجي (courierlive): الكارت لازم يقول «الرابط اتفتح /
         بدأ / وصل» — من غيره المدير مش عارف هو بعت في الفراغ ولا لأ. */
      let runBy = new Map();
      try {
        const runs = (await pool.query(
          `SELECT r.order_no, r.opened_at, r.started_at, r.arrived_at, r.delivered_at, r.expires_at, r.revoked_at, r.pings, r.last_at, r.courier_name
             FROM dl_ext_runs r WHERE r.order_no = ANY($1::text[])`, [nos])).rows;
        runBy = new Map(runs.map((x) => [x.order_no, x]));
      } catch { /* الجدول لسه ما اتعملش — الشاشة بتشتغل من غيره */ }
      const t = now();
      for (const r of rows) {
        if (r.option !== "delivery") continue;
        const sh = shBy.get(r.order_no) || null;
        const km = routeKmOf({ delivery_quote: r.delivery_quote, route_km: r.route_km });
        const expectedMin = expectedDriveMin({ km, durationSec: await durationSecOf(r.address) }, cfg);
        const i = incBy.get(r.order_no) || null;
        const fg = farGuardDecision({ delivery_quote: r.delivery_quote, route_km: r.route_km }, cfg);
        const badge = distanceBadge({ delivery_quote: r.delivery_quote, route_km: r.route_km, straight_km: r.straight_km }, cfg);
        const ak = askedBy.get(r.order_no);
        let ev = null;
        if (sh) ev = evalCourierSla({ sh, km, expectedMin, readyAt: r.pos_ready_at, acceptedAt: r.accepted_at, cfg, now: t });
        const acceptedAt = r.accepted_at || null;
        r.courier_ops = {
          km: km != null ? r1(km) : null,
          expectedMin,
          eta: ev ? ev.eta : preDispatchEta({ acceptedAt, readyAt: r.pos_ready_at, expectedMin, dispatchDelayMin: delayMin, cfg }),
          etaBasis: ev ? ev.etaBasis : "prep",
          times: ev ? { requestedAt: ev.times.requestedAt, assignedAt: ev.times.assignedAt, arrivedAt: ev.times.arrivedAt,
            pickedAt: ev.times.pickedAt, deliveredAt: ev.times.deliveredAt, cancelledAt: ev.times.cancelledAt } : null,
          deadlines: ev ? ev.deadlines : null,
          breaches: ev ? ev.breaches.map((b) => b.code) : [],
          provider: sh ? sh.provider : null,
          external: sh && sh.provider === "external" ? (() => {
            const rn = runBy.get(r.order_no) || null;
            return {
              cost: sh.cost != null ? Number(sh.cost) : null,
              link: rn ? {
                name: rn.courier_name || null,
                openedAt: isoOf(rn.opened_at), startedAt: isoOf(rn.started_at), arrivedAt: isoOf(rn.arrived_at),
                deliveredAt: isoOf(rn.delivered_at), lastAt: isoOf(rn.last_at), pings: Number(rn.pings) || 0,
                live: !rn.delivered_at && !rn.revoked_at && new Date(rn.expires_at).getTime() > t,
                expiresAt: isoOf(rn.expires_at),
              } : null,
            };
          })() : null,
          far: fg.far ? { km: fg.km, fromKm: fg.fromKm, mode: fg.mode } : null,
          badge,
          askedLeajlak: ak ? { at: isoOf(ak.detected_at), by: ak.resolved_by || null, note: (ak.detail && ak.detail.note) || null } : null,
          staffCourier: sh && sh.provider === "external" && sh.driver && sh.driver.source === "staff" ? (sh.driver.name || "موظف") : null,
          incident: i ? {
            id: Number(i.id), kind: i.kind, label: CODE_AR[i.kind] || i.kind, reason: i.reason || null, provider: i.provider || null,
            at: isoOf(i.detected_at), open: !i.resolved_at, resolution: i.resolution || null, resolvedBy: i.resolved_by || null,
            resolvedAt: isoOf(i.resolved_at), needsCost: Boolean(i.detail && i.detail.needsCost),
          } : null,
          sla: { assignMin: cfg.assignMin, arriveTargetMin: cfg.arriveTargetMin, arriveMin: cfg.arriveMin, graceMin: cfg.deliverGraceMin },
        };
      }
    } catch (e) {
      try { log.error(`[courierops] decorate failed: ${e?.message || e}`); } catch {}
    }
    return rows;
  }

  /* ═══ مسارات البوابة (مدير) ══════════════════════════════════════════ */
  const inflight = new Set();
  const P = () => portal();
  async function mgr(c) {
    const p = P();
    if (!p || !p.requirePortal) return { res: c.json({ ok: false, error: "unavailable" }, 503) };
    return p.requirePortal(c, "manager");
  }
  const ipOf = (c) => c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || null;
  const audit = (user, action, orderNo, ok, detail, c) => { try { P()?.audit?.(user, action, orderNo, ok, detail, ipOf(c)); } catch {} };
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const clean = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

  async function customerSms(orderNo, kind) {
    try {
      const cfg = await cfgOf();
      if (!cfg.customerSms) return false;
      const n = notify();
      if (!n || !n.sendSmsTo) return false;
      // «رتّبنا لك مندوب» بتتبعت أصلاً من notify لو المرحلة دي متفعّلة — مانكررش
      if (kind === "external") {
        const st = ((await getSettingsData()).notifications || {}).smsStages;
        if (Array.isArray(st) && st.includes("courier_assigned")) return false;
      }
      const r = await pool.query("SELECT phone_norm, is_test FROM shop_orders WHERE order_no=$1", [orderNo]);
      const o = r.rows[0];
      if (!o || !/^5\d{8}$/.test(o.phone_norm || "")) return false;
      const ok = await n.sendSmsTo(o.phone_norm, CUSTOMER_TEXT[kind](orderNo), { kind: "order_status", ref: `${orderNo}:courier_${kind}` });
      try { emit("notify_sent", { orderNo, source: "notify", channel: "sms", ok: Boolean(ok), data: { stage: `courier_${kind}`, channel: "sms", ok: Boolean(ok) } }); } catch {}
      return ok;
    } catch (e) {
      try { log.error(`[courierops] customer sms ${orderNo} failed: ${e?.message || e}`); } catch {}
      return false;
    }
  }

  async function withOrder(c, fn) {
    const a = await mgr(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    const sh = shop(), dl = delivery();
    if (!sh || !dl) return c.json({ ok: false, error: "unavailable" }, 503);
    if (inflight.has(orderNo)) return c.json({ ok: false, error: "in_progress", message: "في إجراء شغّال على الطلب ده" }, 409);
    inflight.add(orderNo);
    try {
      const row = await sh.getOrderRow(orderNo);
      if (!row) return c.json({ ok: false, error: "not_found" }, 404);
      if (row.option !== "delivery" && !c.req.path.endsWith("/incident/dismiss")) {
        return c.json({ ok: false, error: "not_delivery", message: "الطلب مش توصيل" }, 400);
      }
      const b = await c.req.json().catch(() => ({}));
      return await fn({ user: a.user, row, b: b || {}, sh, dl, orderNo });
    } catch (e) {
      try { log.error(`[courierops] ${c.req.path} failed: ${e?.message || e}`); } catch {}
      return c.json({ ok: false, error: "failed", message: String(e?.message || "").slice(0, 200) }, 500);
    } finally {
      inflight.delete(orderNo);
      try { P()?.scheduleRefresh?.(orderNo); } catch {}
    }
  }

  /* شحنة API حية (مش متلغية/متوصّلة): لازم تتلغي قبل ما نبعت مع حد تاني —
     وإلا كابتنين على نفس الطلب. بعد الاستلام مفيش إلغاء. */
  async function releaseActive(dl, orderNo, why) {
    const cur = await dl.shipmentOf(orderNo);
    if (!cur || ["cancelled", "delivered"].includes(String(cur.status))) return { ok: true, cur };
    if (String(cur.status) === "picked") return { ok: false, error: "already_picked", message: "الكابتن استلم الطلب — مفيش تغيير دلوقتي" };
    if (cur.provider === "external" || cur.provider === "manual") {
      await pool.query(`UPDATE dl_shipments SET status='cancelled', events = events || $2::jsonb, updated_at=NOW() WHERE id=$1`,
        [cur.id, J([{ at: new Date(now()).toISOString(), event: "cancelled", provider: cur.provider, by: "portal", note: why }])]);
      return { ok: true, cur };
    }
    const r = await dl.cancelShipment(orderNo, why);
    if (!r) return { ok: false, error: "cancel_failed", message: "شركة التوصيل رفضت إلغاء المندوب الحالي — كلّمهم الأول" };
    return { ok: true, cur };
  }

  // ١) مندوب خارجي
  app.post("/api/portal/orders/:orderNo/courier/external", (c) => withOrder(c, async ({ user, row, b, sh, dl, orderNo }) => {
    if (["delivered", "rejected_refunded", "refund_failed", "expired", "pending_payment"].includes(row.status)) {
      return c.json({ ok: false, error: "wrong_stage", message: "الطلب في مرحلة ماتسمحش" }, 409);
    }
    const cur = await dl.shipmentOf(orderNo);
    if (cur && cur.provider === "external" && !["cancelled", "delivered"].includes(String(cur.status))) {
      return c.json({ ok: false, error: "already_external", message: "فيه مندوب خارجي متسجّل بالفعل" }, 409);
    }
    const rel = await releaseActive(dl, orderNo, `switched to external courier by ${user.name}`);
    if (!rel.ok) return c.json({ ok: false, error: rel.error, message: rel.message }, 409);
    const name = clean(b.name, 80), phone = clean(b.phone, 20), notes = clean(b.notes, 300), reason = clean(b.reason, 160);
    // «موظف من عندنا» بدل مندوب من بره: نفس الشحنة اليدوية، والتكلفة صفر لو ماتكتبتش
    const staffRun = b.kind === "staff";
    const cost = num(b.cost) ?? (staffRun ? 0 : null);
    if (cost != null && (cost < 0 || cost > 500)) return c.json({ ok: false, error: "bad_cost", message: "التكلفة لازم بين ٠ و٥٠٠" }, 400);
    const stage = ["picked", "delivered"].includes(b.stage) ? b.stage : "assigned";
    const at = new Date(now()).toISOString();
    const ins = await pool.query(
      `INSERT INTO dl_shipments(shop_order_no, provider, provider_ref, status, driver, cost, cost_basis, dispatch, events,
                                assigned_at, picked_at, delivered_at)
       VALUES ($1,'external',NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [orderNo, stage, name || phone || staffRun ? J({ name: name || (staffRun ? "موظف" : null), phone, source: staffRun ? "staff" : "external" }) : null, cost, cost != null ? "manual" : null,
       J({ status: "external", assigned: true, by: user.name, reason, notes, retro: Boolean(b.retro) }),
       J([{ at, provider: "external", event: stage === "assigned" ? "assigned" : stage, by: `portal:${user.name}`, note: notes || reason }]),
       at, stage !== "assigned" && !b.retro ? at : null, stage === "delivered" && !b.retro ? at : null]);
    await pool.query("UPDATE shop_orders SET dispatch_claimed_at = COALESCE(dispatch_claimed_at, NOW()) WHERE order_no=$1", [orderNo]);
    const next = stage === "delivered" ? "delivered" : stage === "picked" ? "on_the_way" : "courier_assigned";
    const note = `${staffRun ? `توصيل بموظف (${name || "موظف"})` : "مندوب خارجي"} — ${user.name}${reason ? ` — ${reason}` : ""}`;
    if (b.retro) {
      // تسجيل بأثر رجعي: من غير أي رسالة للعميل ولا دعوة تقييم
      await pool.query(
        `UPDATE shop_orders SET status=$2, history = history || $3::jsonb, updated_at=NOW() WHERE order_no=$1`,
        [orderNo, next, J([{ at, status: next, note: `${note} (تسجيل بأثر رجعي)` }])]);
      if (next === "delivered") {
        await pool.query(
          `INSERT INTO review_invites(order_no, code, phone_norm, option, due_at, skip_reason)
           VALUES ($1, $2, NULL, 'delivery', NOW(), 'courier_incident') ON CONFLICT (order_no) DO NOTHING`,
          [orderNo, `ci${String(Date.now()).slice(-6)}`]).catch(() => {});
      }
      try { emit("order_status", { orderNo, source: "portal", data: { from: row.status, to: next, note } }); } catch {}
    } else if (row.status !== next) {
      await sh.setStatus(orderNo, next, { note, from: row.status, source: "portal" });
    }
    try {
      emit("courier_manual", { orderNo, source: "staff", ok: true, actor: { name: user.name },
        data: { stage, status: stage, provider: "external", cost, reason, note: notes } });
    } catch {}
    const needsCost = cost == null;
    await resolveIncidents(orderNo, staffRun ? "staff" : "external", user.name, { externalShipmentId: Number(ins.rows[0].id), needsCost, cost });
    // لو مفيش حادثة مفتوحة (المدير اختار خارجي من الأول) بنسجّل واحدة محلولة للأثر
    await pool.query(
      `INSERT INTO dl_courier_incidents(order_no, shipment_id, provider, kind, reason, resolved_at, resolution, resolved_by, detail)
       SELECT $1, $2, 'external', 'provider_cancelled', $3, NOW(), 'external', $4, $5::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM dl_courier_incidents WHERE order_no=$1)`,
      [orderNo, Number(ins.rows[0].id), reason || "المدير اختار مندوب خارجي", user.name, J({ needsCost, cost, manualChoice: true })]).catch(() => {});
    if (!b.retro) customerSms(orderNo, "external");
    audit(user, staffRun ? "courier_staff" : "courier_external", orderNo, true, { cost, stage, reason, retro: Boolean(b.retro) }, c);
    /* ضغطة واحدة (عمر ٢١/٩): التسجيل بيرجّع معاه رسالة الواتساب الجاهزة
       ورابط المندوب لمرة واحدة، فالمدير مايعملش خطوة تانية. فشل التحضير
       ما يوقّعش التسجيل — الشحنة اتسجّلت فعلاً والرابط له زرار لوحده. */
    let handoff = null;
    if (b.handoff !== false && !b.retro && stage !== "delivered") {
      try {
        const h = await courierLive()?.makeHandoff?.(orderNo, { name, phone, by: user.name });
        if (h && h.ok) handoff = h;
      } catch (e) { try { log.error(`[courierops] handoff ${orderNo}: ${e?.message || e}`); } catch {} }
    }
    return c.json({ ok: true, shipmentId: Number(ins.rows[0].id), status: next, needsCost, handoff });
  }));

  // ٢) حالات المندوب الخارجي + التكلفة
  app.post("/api/portal/orders/:orderNo/courier/external/:stage", (c) => withOrder(c, async ({ user, row, b, sh, dl, orderNo }) => {
    const stage = String(c.req.param("stage"));
    if (!["picked", "delivered", "cost"].includes(stage)) return c.json({ ok: false, error: "bad_stage" }, 400);
    const cur = await dl.shipmentOf(orderNo);
    if (!cur || cur.provider !== "external") return c.json({ ok: false, error: "no_external", message: "مفيش مندوب خارجي على الطلب" }, 409);
    const cost = num(b.cost);
    if (cost != null && (cost < 0 || cost > 500)) return c.json({ ok: false, error: "bad_cost", message: "التكلفة لازم بين ٠ و٥٠٠" }, 400);
    const at = new Date(now()).toISOString();
    if (stage === "cost") {
      if (cost == null) return c.json({ ok: false, error: "bad_cost", message: "اكتب التكلفة" }, 400);
      await pool.query(`UPDATE dl_shipments SET cost=$2, cost_basis='manual', events = events || $3::jsonb, updated_at=NOW() WHERE id=$1`,
        [cur.id, cost, J([{ at, provider: "external", event: "cost", by: `portal:${user.name}`, note: `التكلفة ${cost} ر.س` }])]);
      await pool.query(`UPDATE dl_courier_incidents SET detail = detail || '{"needsCost":false}'::jsonb || $2::jsonb WHERE order_no=$1`,
        [orderNo, J({ cost })]).catch(() => {});
      audit(user, "courier_external_cost", orderNo, true, { cost }, c);
      return c.json({ ok: true, cost });
    }
    if (String(cur.status) === "cancelled") return c.json({ ok: false, error: "cancelled" }, 409);
    if (stage === "picked" && ["picked", "delivered"].includes(String(cur.status))) return c.json({ ok: true, already: true });
    await pool.query(
      `UPDATE dl_shipments SET status=$2, picked_at = COALESCE(picked_at, $3), delivered_at = CASE WHEN $2='delivered' THEN COALESCE(delivered_at, $3) ELSE delivered_at END,
              cost = COALESCE($4, cost), cost_basis = CASE WHEN $4 IS NULL THEN cost_basis ELSE 'manual' END,
              events = events || $5::jsonb, updated_at=NOW() WHERE id=$1`,
      [cur.id, stage, at, cost, J([{ at, provider: "external", event: stage, by: `portal:${user.name}` }])]);
    const next = stage === "delivered" ? "delivered" : "on_the_way";
    const order = ["courier_requested", "courier_assigned", "on_the_way", "delivered"];
    if (row.status === "courier_cancelled" || order.indexOf(next) > order.indexOf(row.status)) {
      await sh.setStatus(orderNo, next, { note: `مندوب خارجي: ${stage === "picked" ? "استلم" : "وصّل"} — ${user.name}`, from: row.status, source: "portal" });
    }
    try { emit("courier_manual", { orderNo, source: "staff", ok: true, actor: { name: user.name }, data: { stage, status: stage, provider: "external", cost } }); } catch {}
    audit(user, `courier_external_${stage}`, orderNo, true, { cost }, c);
    return c.json({ ok: true, status: next });
  }));

  /* ٣) «أوقف لاجلك» (عمر ١٩ سبتمبر): المدير يوقف طلب لاجلك لأي طلب قبل ما
     الكابتن يوصلنا — يلغيه عندهم لو اتطلب، أو يمنع الطلب التلقائي لو لسه.
     بعدها يختار: موظف / مندوب خارجي / يطلب لاجلك تاني (بعد ما يسأل). */
  app.post("/api/portal/orders/:orderNo/courier/hold", (c) => withOrder(c, async ({ user, row, b, dl, orderNo }) => {
    if (!["accepted", "courier_requested", "courier_assigned", "courier_cancelled", "pos_created"].includes(row.status)) {
      return c.json({ ok: false, error: "wrong_stage", message: "الإيقاف قبل ما الكابتن يستلم بس" }, 409);
    }
    const cur = await dl.shipmentOf(orderNo);
    if (cur && API_PROVIDER_IDS.includes(cur.provider) && !["cancelled", "delivered"].includes(String(cur.status))) {
      if (cur.arrived_at || String(cur.status) === "picked") {
        return c.json({ ok: false, error: "captain_here", message: "الكابتن وصل المطعم خلاص — كلّمه أو كلّم لاجلك" }, 409);
      }
    }
    const reason = clean(b.reason, 160);
    const rel = await releaseActive(dl, orderNo, `held by ${user.name}${reason ? `: ${reason}` : ""}`);
    if (!rel.ok) return c.json({ ok: false, error: rel.error, message: rel.message }, 409);
    // الحجز بيمنع الكنس من طلب مندوب لوحده؛ «اطلب لاجلك» من البوابة بتعدّيه
    await pool.query("UPDATE shop_orders SET dispatch_claimed_at = NOW() - INTERVAL '5 minutes' WHERE order_no=$1", [orderNo]);
    const at = new Date(now()).toISOString();
    if (["courier_requested", "courier_assigned"].includes(row.status)) {
      const note = `المدير ${user.name} وقّف لاجلك${reason ? ` — ${reason}` : ""}`;
      const u = await pool.query(
        `UPDATE shop_orders SET status='accepted', history = history || $2::jsonb, updated_at=NOW()
          WHERE order_no=$1 AND status IN ('courier_requested','courier_assigned') RETURNING order_no`,
        [orderNo, J([{ at, status: "accepted", note }])]);
      if (u.rowCount) { try { emit("order_status", { orderNo, source: "portal", data: { from: row.status, to: "accepted", note } }); } catch {} }
    }
    await openIncident(orderNo, "held", { shipmentId: rel.cur ? Number(rel.cur.id) : 0, provider: rel.cur ? rel.cur.provider : null,
      reason: reason || "المدير وقّف لاجلك", detail: { by: user.name }, alert: false });
    audit(user, "courier_hold", orderNo, true, { reason, cancelled: Boolean(rel.cur && API_PROVIDER_IDS.includes(rel.cur.provider)) }, c);
    return c.json({ ok: true, cancelledShipment: Boolean(rel.cur && !["cancelled", "delivered"].includes(String(rel.cur.status))) });
  }));

  // «سألنا لاجلك» — علامة على الطلب (مثلاً قبل مشوار بعيد) + ملاحظة
  app.post("/api/portal/orders/:orderNo/courier/asked", (c) => withOrder(c, async ({ user, b, orderNo }) => {
    const note = clean(b.note, 200);
    await pool.query(
      `INSERT INTO dl_courier_incidents(order_no, shipment_id, provider, kind, reason, resolved_at, resolution, resolved_by, detail)
       VALUES ($1, $2, 'leajlak', 'asked_leajlak', $3, NOW(), 'dismissed', $4, $5::jsonb)`,
      [orderNo, -Date.now() % 2147483647, note || "سألنا لاجلك", user.name, J({ note })]);
    audit(user, "courier_asked_leajlak", orderNo, true, { note }, c);
    return c.json({ ok: true });
  }));

  // بلاغ مخالفة يدوي (تلف/ضياع/مكان غلط/مابيردش/…) — ببند العقد، للمطالبة
  app.post("/api/portal/orders/:orderNo/courier/violation", (c) => withOrder(c, async ({ user, b, dl, orderNo }) => {
    const code = String(b.code || "");
    if (!MANUAL_VIOLATIONS.includes(code)) return c.json({ ok: false, error: "bad_code", message: "نوع مخالفة غير معروف" }, 400);
    const note = clean(b.note, 300);
    const all = (await pool.query("SELECT id, provider, created_at FROM dl_shipments WHERE shop_order_no=$1 ORDER BY id DESC", [orderNo])).rows;
    const sh = all.find((x) => API_PROVIDER_IDS.includes(x.provider)) || null;
    if (!sh) return c.json({ ok: false, error: "no_shipment", message: "مفيش شحنة شركة توصيل على الطلب" }, 409);
    const v = VIOLATIONS[code];
    const r = await pool.query(
      `INSERT INTO dl_sla_breaches(order_no, shipment_id, provider, code, basis, started_at, actual_at, claimable, note, detail)
       VALUES ($1,$2,$3,$4,'manual',$5,NOW(),$6,$7,$8::jsonb)
       ON CONFLICT (shipment_id, code) DO UPDATE SET note = EXCLUDED.note, detail = dl_sla_breaches.detail || EXCLUDED.detail
       RETURNING id`,
      [orderNo, sh.id, sh.provider, code, sh.created_at, Boolean(v.contract && v.side === "leajlak"), note, J({ by: user.name, clause: v.clause })]);
    audit(user, "courier_violation", orderNo, true, { code, note }, c);
    return c.json({ ok: true, id: Number(r.rows[0].id) });
  }));

  app.get("/api/portal/courier/violation-types", async (c) => {
    const a = await mgr(c); if (a.res) return a.res;
    return c.json({ ok: true, types: MANUAL_VIOLATIONS.map((k) => ({ code: k, label: VIOLATIONS[k].label, clause: VIOLATIONS[k].clause })) });
  });

  app.get("/api/portal/courier/staff", async (c) => {
    const a = await mgr(c); if (a.res) return a.res;
    return c.json({ ok: true, staff: staffCourierNames(await getSettingsData()) });
  });

  // ٤) قفل الحادثة من غير إجراء (مثلاً اتحلّت بالتليفون)
  app.post("/api/portal/orders/:orderNo/courier/incident/dismiss", (c) => withOrder(c, async ({ user, b, orderNo }) => {
    const n = await resolveIncidents(orderNo, "dismissed", user.name, { note: clean(b.note, 200) });
    audit(user, "courier_incident_dismiss", orderNo, true, { note: clean(b.note, 200) }, c);
    return c.json({ ok: true, resolved: n });
  }));

  // الإعادة/التبديل بتعدّي على مسار طلب المندوب في portal.js — ده بيسجّل الحل
  async function onRedispatch(orderNo, { provider, by, switched }) {
    try {
      const n = await resolveIncidents(orderNo, switched ? "switch" : "retry", by, { provider });
      if (switched && n) customerSms(orderNo, "switched");
      return n;
    } catch { return 0; }
  }

  // خيارات المدير لطلب: المزوّدين المتظبطين غير الفعّال
  app.get("/api/portal/courier/providers", async (c) => {
    const a = await mgr(c); if (a.res) return a.res;
    let active = null;
    try { active = await delivery()?.activeProviderId?.(); } catch {}
    return c.json({ ok: true, active, providers: API_PROVIDER_IDS.map((id) => ({
      id, label: id === "leajlak" ? "لاجلك" : PROVIDERS[id].label, configured: PROVIDERS[id].configured(),
    })) });
  });

  /* ═══ اللوحة: مخالفات لاجلك (ops/recon) ═════════════════════════════ */
  async function violations({ month, provider = "leajlak", includeTest = false } = {}) {
    await ensureSchema();
    const vals = [provider];
    let where = "b.provider = $1";
    if (month) { vals.push(month); where += ` AND to_char(b.started_at AT TIME ZONE 'Asia/Riyadh','YYYY-MM') = $${vals.length}`; }
    if (!includeTest) where += " AND NOT b.is_test";
    const rows = (await pool.query(
      `SELECT b.*, sh.provider_ref, sh.driver->>'name' AS driver_name
         FROM dl_sla_breaches b LEFT JOIN dl_shipments sh ON sh.id = b.shipment_id
        WHERE ${where} ORDER BY b.started_at DESC LIMIT 2000`, vals)).rows;
    const iv = [provider];
    let iw = "i.provider = $1 AND i.kind IN ('provider_cancelled','refused_far','no_assignment')";
    if (month) { iv.push(month); iw += ` AND to_char(i.detected_at AT TIME ZONE 'Asia/Riyadh','YYYY-MM') = $${iv.length}`; }
    const incs = (await pool.query(
      `SELECT i.*, sh.provider_ref, sh.created_at AS requested_at, s.is_test
         FROM dl_courier_incidents i LEFT JOIN dl_shipments sh ON sh.id = i.shipment_id
         LEFT JOIN shop_orders s ON s.order_no = i.order_no
        WHERE ${iw} ORDER BY i.detected_at DESC LIMIT 500`, iv)).rows.filter((r) => includeTest || !r.is_test);
    const list = [
      ...rows.map((r) => ({
        id: Number(r.id), kind: "breach", orderNo: r.order_no, providerRef: r.provider_ref || null, provider: r.provider,
        code: r.code, startedAt: isoOf(r.started_at), deadlineAt: isoOf(r.deadline_at), actualAt: isoOf(r.actual_at),
        overMin: r.over_min != null ? Number(r.over_min) : null, basis: r.basis, claimable: r.claimable, open: !r.actual_at,
        km: r.detail && r.detail.km != null ? Number(r.detail.km) : null, driver: r.driver_name || (r.detail && r.detail.driver) || null,
        sharedDriverWith: (r.detail && r.detail.sharedDriverWith) || null,
        claimStatus: r.claim_status, note: r.note || null, isTest: r.is_test,
      })),
      ...incs.map((i) => ({
        id: Number(i.id), kind: "incident", orderNo: i.order_no, providerRef: i.provider_ref || null, provider: i.provider,
        code: i.kind, startedAt: isoOf(i.requested_at), deadlineAt: null, actualAt: isoOf((i.detail && i.detail.cancelledAt) || i.detected_at),
        overMin: null, basis: null, claimable: !(VIOLATIONS[i.kind] || {}).rateOnly, open: false, km: i.detail && i.detail.km != null ? Number(i.detail.km) : null,
        driver: null, claimStatus: (i.detail && i.detail.claimStatus) || "open",
        note: [i.reason, i.resolution ? `الحل: ${i.resolution}${i.resolved_by ? ` (${i.resolved_by})` : ""}` : null].filter(Boolean).join(" — "),
      })),
    ].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
    // ساعات الخدمة في العقد (م١٢): ١٠ ص – ٣ الفجر. بره كده مفيش التزام عليهم.
    for (const x of list) {
      const h = x.startedAt ? new Date(ms(x.startedAt) + 3 * 3600_000).getUTCHours() : null;
      if (h != null && h >= 3 && h < 10 && (VIOLATIONS[x.code] || {}).side === "leajlak") {
        x.claimable = false;
        x.note = [x.note, "خارج ساعات الخدمة في العقد (١٠ ص–٣ الفجر)"].filter(Boolean).join(" — ");
      }
      x.side = (VIOLATIONS[x.code] || {}).side || null;
      x.clause = CONTRACT_REF[x.code] || null;
    }
    // نسبة الإلغاء (العقد: ≤ ٥٪ من الطلبات المسندة)
    const sv = [provider];
    let sw = "sh.provider = $1 AND NOT COALESCE(s.is_test,false)";
    if (month) { sv.push(month); sw += ` AND to_char(sh.created_at AT TIME ZONE 'Asia/Riyadh','YYYY-MM') = $${sv.length}`; }
    const tot = (await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE sh.status='delivered')::int AS delivered
         FROM dl_shipments sh LEFT JOIN shop_orders s ON s.order_no = sh.shop_order_no WHERE ${sw}`, sv)).rows[0] || {};
    const provCancels = list.filter((x) => x.kind === "incident").length;
    const summary = {
      shipments: tot.n || 0, delivered: tot.delivered || 0,
      providerCancels: provCancels,
      cancelRatePct: tot.n ? r1((provCancels / tot.n) * 100) : 0,
      byCode: list.reduce((m, x) => { m[x.code] = (m[x.code] || 0) + 1; return m; }, {}),
      claimable: list.filter((x) => x.claimable).length,
    };
    // نسبة الإلغاء كسطر في التصدير لو عدّت الحد (م٣ ≤ ٥٪)
    if (summary.cancelRatePct > 5) {
      list.unshift({ id: 0, kind: "summary", orderNo: month || "—", providerRef: null, provider, code: "cancel_rate",
        startedAt: null, deadlineAt: null, actualAt: null, overMin: null, claimable: true, open: false, km: null, driver: null,
        side: "leajlak", clause: CONTRACT_REF.cancel_rate, claimStatus: "open",
        note: `${provCancels} إلغاء/رفض من ${summary.shipments} شحنة = ${summary.cancelRatePct}٪ (الحد ٥٪)` });
    }
    return { list, summary };
  }

  app.get("/api/delivery/courier-sla/violations", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const month = /^\d{4}-\d{2}$/.test(c.req.query("month") || "") ? c.req.query("month") : null;
    const provider = API_PROVIDER_IDS.includes(c.req.query("provider")) ? c.req.query("provider") : "leajlak";
    const r = await violations({ month, provider, includeTest: c.req.query("test") === "1" });
    if (c.req.query("format") === "csv") {
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="leajlak-violations-${month || "all"}.csv"`);
      return c.body(violationsCsv(r.list));
    }
    return c.json({ ok: true, month, provider, cfg: await cfgOf(), catalog: VIOLATIONS, ...r });
  });

  app.put("/api/delivery/courier-sla/:kind/:id", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const kind = c.req.param("kind"), id = Number(c.req.param("id"));
    const b = await c.req.json().catch(() => ({}));
    const st = ["open", "claimed", "accepted", "rejected", "ignored"].includes(b.claimStatus) ? b.claimStatus : null;
    const note = b.note != null ? String(b.note).slice(0, 300) : null;
    if (kind === "breach") {
      await pool.query("UPDATE dl_sla_breaches SET claim_status = COALESCE($2, claim_status), note = COALESCE($3, note) WHERE id=$1", [id, st, note]);
    } else if (kind === "incident") {
      await pool.query("UPDATE dl_courier_incidents SET detail = detail || $2::jsonb WHERE id=$1",
        [id, J({ ...(st ? { claimStatus: st } : {}), ...(note != null ? { claimNote: note } : {}) })]);
    } else return c.json({ ok: false, error: "bad_kind" }, 400);
    return c.json({ ok: true });
  });

  app.post("/api/delivery/courier-sla/scan", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, ...(await scan()) });
  });

  return { scan, farCheck, decorate, openIncident, resolveIncidents, onRedispatch, violations, ensureSchema, cfg: cfgOf };
}

export { INCIDENT_KINDS, RESOLUTIONS };
