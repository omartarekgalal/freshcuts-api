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
  assignMin: 12,          // عمر: كابتن يتعيّن خلال ١٢ د من طلب المندوب
  arriveMin: 20,          // العقد م٣: الكابتن في الفرع خلال ٢٠ د من إسناد الطلب لنظامهم
  deliverGraceMin: 2,     // عمر: بعد الاستلام = المدة المتوقعة + ٢ د سماح
  baseMin: 5,             // المدة المتوقعة لو مفيش مدة من جوجل: ٥ + ٢٫٥ د/كم
  minPerKm: 2.5,          //   (متوسط طلباتنا الحقيقية ١٧–١٩ سبتمبر)
  prepMin: 19,            // تقدير التحضير لحساب الـETA قبل «جاهز» (وسيط ٤٧ طلب)
  assignTypMin: 1,        // المعتاد: لاجلك بتعيّن خلال ~دقيقة
  arriveTypMin: 14,       // المعتاد: الكابتن في المطعم بعد ~١٤ د من الطلب
  handoverMin: 2,         // تسليم الشنطة
  claimMinOverMin: 2,     // المخالفة «قابلة للمطالبة» لو التأخير ≥ ده (الاستطلاع كل دقيقة ± ١)
  alertStaff: true,       // SMS للإدارة عند كل مخالفة/رفض
  customerSms: true,      // رسالة للعميل لما المدير يغيّر طريقة التوصيل
  farGuard: { enabled: true, fromKm: 10, mode: "confirm" }, // confirm | suggest | off
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
  fg.mode = ["confirm", "suggest", "off"].includes(fg.mode) ? fg.mode : "confirm";
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
  const k = Number(km);
  const model = Number.isFinite(k) && k > 0 ? cfg.baseMin + cfg.minPerKm * k : null;
  const g = Number(durationSec) > 0 ? Number(durationSec) / 60 : null;
  const v = Math.max(model || 0, g || 0);
  return v > 0 ? Math.ceil(v) : null;
}

/* ── تقييم الشحنة: المهل + المخالفات + الـETA ───────────────────────────
   مفيش `now` في أي حاجة بترجع للبوابة غير breach.open — عشان بصمة الطلب
   ماتتغيرش كل دقيقة. المؤقتات الحية بتتحسب في المتصفح من المواعيد. */
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
    breaches.push({ code, startedAt, deadlineAt, actualAt: actualAt || null, overMin: o, basis: basis || null, open: !actualAt,
      claimable: api && o >= (Number(cfg.claimMinOverMin) || 0) });
  };

  // ١) التعيين — عمر: ≤ assignMin من طلب المندوب
  if (t.requestedAt) {
    const dl = addMin(t.requestedAt, cfg.assignMin);
    deadlines.assign = { at: dl, done: t.assignedAt || null, target: cfg.assignMin };
    if (api) {
      if (t.assignedAt) add("assign_late", t.requestedAt, dl, t.assignedAt, "assigned");
      else if (!cancelled) add("assign_late", t.requestedAt, dl, null, "still_pending");
    }
  }
  // ٢) الوصول للمطعم — العقد م٣: ≤ ٢٠ د من إسناد الطلب لنظامهم
  if (t.requestedAt) {
    const dl = addMin(t.requestedAt, cfg.arriveMin);
    const done = t.arrivedAt || t.pickedAt || null;
    deadlines.arrive = { at: dl, done, target: cfg.arriveMin, basis: t.arrivedAt ? "arrived" : t.pickedAt ? "picked" : null };
    if (api && !(cancelled && !done)) {
      // مفيش إشارة «وصل» (Flying Arrow مثلاً): وقت الاستلام حد أقصى للوصول
      if (done) add("arrive_late", t.requestedAt, dl, done, t.arrivedAt ? "arrived" : "picked_no_arrival_signal");
      else add("arrive_late", t.requestedAt, dl, null, "not_arrived");
    }
  }
  // ٣) التوصيل — عمر: المدة المتوقعة + سماح بعد الاستلام
  if (t.pickedAt && expectedMin) {
    const target = expectedMin + (Number(cfg.deliverGraceMin) || 0);
    const dl = addMin(t.pickedAt, target);
    deadlines.deliver = { at: dl, done: t.deliveredAt || null, target, expectedMin };
    if (api && !cancelled) add("deliver_late", t.pickedAt, dl, t.deliveredAt || null, t.deliveredAt ? "delivered" : "not_delivered");
  }

  // الـETA (تقديري — الشركة مابتدّيش واحد)
  let eta = null, etaBasis = null;
  if (t.deliveredAt) { eta = t.deliveredAt; etaBasis = "delivered"; }
  else if (!cancelled && expectedMin) {
    if (t.pickedAt) { eta = addMin(t.pickedAt, expectedMin); etaBasis = "picked"; }
    else {
      const readyEst = readyAt || (acceptedAt ? addMin(acceptedAt, cfg.prepMin) : null);
      const atShop = t.arrivedAt || (t.assignedAt ? addMin(t.assignedAt, Math.max(0, cfg.arriveTypMin - cfg.assignTypMin))
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
export function farGuardDecision(row = {}, cfg = DEFAULT_COURIER_SLA) {
  const km = routeKmOf(row);
  const fg = cfg.farGuard || DEFAULT_COURIER_SLA.farGuard;
  const far = Boolean(fg.enabled) && fg.mode !== "off" && km != null && km > fg.fromKm;
  return { far, km: km != null ? r1(km) : null, fromKm: fg.fromKm, mode: fg.mode, hold: far && fg.mode === "confirm" };
}

/* ── النصوص ─────────────────────────────────────────────────────────────── */
export const CODE_AR = Object.freeze({
  provider_cancelled: "شركة التوصيل لغت الطلب",
  refused_far: "شركة التوصيل رفضت (مشوار بعيد)",
  no_assignment: "مفيش كابتن اتعيّن",
  far_hold: "مشوار بعيد — مستني قرار المدير",
  far_risk: "مشوار بعيد — ممكن الشركة ترفضه",
  assign_late: "تأخير تعيين الكابتن",
  arrive_late: "الكابتن اتأخر يوصل المطعم (العقد ٢٠ د)",
  deliver_late: "التوصيل اتأخر بعد الاستلام",
});
const EN = {
  provider_cancelled: (x) => `courier company CANCELLED the order${x.km ? ` (${x.km}km)` : ""}. Portal: retry/other/external/pickup`,
  refused_far: (x) => `courier REFUSED far order ${x.km}km. Portal: retry/other/external courier/pickup`,
  no_assignment: (x) => `no captain assigned after ${x.min}min. Portal: retry/other/external`,
  far_hold: (x) => `far order ${x.km}km HELD (courier may refuse). Portal: confirm courier or external`,
  assign_late: (x) => `captain assigned late (+${x.over}min)`,
  arrive_late: (x) => `captain not at shop ${x.target}min after request (+${x.over}min)`,
  deliver_late: (x) => `delivery late +${x.over}min after pickup (expected ${x.target}min)`,
};
const AR = {
  provider_cancelled: () => "شركة التوصيل لغت - افتح البوابة",
  refused_far: (x) => `المندوب رفض مشوار ${x.km}كم - افتح البوابة`,
  no_assignment: (x) => `مفيش كابتن بعد ${x.min}د - افتح البوابة`,
  far_hold: (x) => `مشوار ${x.km}كم مستني قرارك في البوابة`,
  assign_late: (x) => `تعيين الكابتن اتأخر ${x.over}د`,
  arrive_late: (x) => `الكابتن اتأخر عن المطعم ${x.over}د`,
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
  pickup: (no) => `فريش كاتس: طلبك ${no} جاهز للاستلام من المطعم`,
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
  ["km", "المسافة كم"], ["driver", "الكابتن"], ["contractRef", "مرجع العقد"], ["claimStatus", "حالة المطالبة"], ["note", "ملاحظات"],
];
export const CONTRACT_REF = Object.freeze({
  arrive_late: "م٣ أولاً: الوصول للفرع خلال ٢٠ د من الإسناد",
  provider_cancelled: "م٣ أولاً: نسبة الإلغاء ≤ ٥٪ من الطلبات المسندة",
  refused_far: "م٣ أولاً: حق رفض ما فوق ١٠ كم (بس بيتحسب في نسبة الإلغاء)",
  deliver_late: "م٥: توصيل دقيق وفي الوقت + م٧: تعويض ٤٠٪ عند خطأ/إهمال",
  assign_late: "معيار داخلي (١٢ د) — مش بند صريح في العقد",
  no_assignment: "م٣ أولاً: الوصول للفرع خلال ٢٠ د",
});
export function violationsCsv(rows = []) {
  const head = VIOLATION_COLS.map(([, h]) => csvCell(h)).join(",");
  const body = rows.map((r) => VIOLATION_COLS.map(([k]) => {
    let v = r[k];
    if (k === "type") v = CODE_AR[r.code] || r.code;
    if (["startedAt", "deadlineAt", "actualAt"].includes(k)) v = riyadh(v);
    if (k === "contractRef") v = CONTRACT_REF[r.code] || "";
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
const RESOLUTIONS = new Set(["retry", "switch", "external", "pickup", "dismissed", "auto"]);
// تنبيه «حي» بس: مانبعتش SMS لمخالفة قديمة اتكشفت أول مرة بعد نشر
const FRESH_MS = 45 * 60_000;

export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData, requireAdmin, jb } = ctx;
  const log = ctx.log || console;
  const shop = typeof deps.shop === "function" ? deps.shop : () => deps.shop || null;
  const delivery = typeof deps.delivery === "function" ? deps.delivery : () => deps.delivery || null;
  const portal = typeof deps.portal === "function" ? deps.portal : () => deps.portal || null;
  const notify = typeof deps.notify === "function" ? deps.notify : () => deps.notify || null;
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
  async function openIncident(orderNo, kind, { shipmentId = 0, provider = null, reason = null, detail = {}, alert = true } = {}) {
    await ensureSchema();
    const ins = await pool.query(
      `INSERT INTO dl_courier_incidents(order_no, shipment_id, provider, kind, reason, detail)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (order_no, shipment_id, kind) DO NOTHING RETURNING id`,
      [String(orderNo), Number(shipmentId) || 0, provider, kind, reason, J(detail || {})]);
    if (!ins.rowCount) return null;
    const id = ins.rows[0].id;
    if (alert && kind !== "far_risk") {
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
          const detail = { expectedMin, km: km != null ? r1(km) : null, target: (ev.deadlines[b.code.split("_")[0]] || {}).target ?? null,
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
          if (!row.alerted_at && fresh && !sh.is_test) {
            const claim = await pool.query("UPDATE dl_sla_breaches SET alerted_at=NOW() WHERE id=$1 AND alerted_at IS NULL RETURNING id", [row.id]);
            if (claim.rowCount) {
              sendStaff(sh.shop_order_no, b.code, { over: b.overMin, target: detail.target, km: detail.km }, `courier ${b.code} ${sh.shop_order_no}`);
              slaEvent(sh.shop_order_no, b.code, 2, { over: b.overMin });
            }
          }
          // مفيش كابتن = مشكلة بتحتاج قرار، مش بس رقم في تقرير
          if (b.code === "assign_late" && b.open && !sh.is_test) {
            await openIncident(sh.shop_order_no, "no_assignment", { shipmentId: sh.id, provider: sh.provider,
              reason: `مفيش كابتن بعد ${cfg.assignMin} د`, detail: { km: detail.km, min: cfg.assignMin }, alert: false });
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
      await openIncident(row.order_no, d.hold ? "far_hold" : "far_risk", {
        reason: d.hold ? `مشوار ${d.km} كم > ${d.fromKm} — مستني تأكيد المدير قبل طلب المندوب`
          : `مشوار ${d.km} كم > ${d.fromKm} — لاجلك ممكن ترفض؛ جهّز مندوب خارجي احتياطي`,
        detail: { km: d.km, fromKm: d.fromKm, mode: d.mode }, alert: d.hold && !row.is_test,
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
      const t = now();
      for (const r of rows) {
        if (r.option !== "delivery") continue;
        const sh = shBy.get(r.order_no) || null;
        const km = routeKmOf({ delivery_quote: r.delivery_quote, route_km: r.route_km });
        const expectedMin = expectedDriveMin({ km, durationSec: await durationSecOf(r.address) }, cfg);
        const i = incBy.get(r.order_no) || null;
        const fg = farGuardDecision({ delivery_quote: r.delivery_quote, route_km: r.route_km }, cfg);
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
          external: sh && sh.provider === "external" ? { cost: sh.cost != null ? Number(sh.cost) : null } : null,
          far: fg.far ? { km: fg.km, fromKm: fg.fromKm, mode: fg.mode } : null,
          incident: i ? {
            id: Number(i.id), kind: i.kind, label: CODE_AR[i.kind] || i.kind, reason: i.reason || null, provider: i.provider || null,
            at: isoOf(i.detected_at), open: !i.resolved_at, resolution: i.resolution || null, resolvedBy: i.resolved_by || null,
            resolvedAt: isoOf(i.resolved_at), needsCost: Boolean(i.detail && i.detail.needsCost),
          } : null,
          sla: { assignMin: cfg.assignMin, arriveMin: cfg.arriveMin, graceMin: cfg.deliverGraceMin },
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
    const cost = num(b.cost);
    if (cost != null && (cost < 0 || cost > 500)) return c.json({ ok: false, error: "bad_cost", message: "التكلفة لازم بين ٠ و٥٠٠" }, 400);
    const stage = ["picked", "delivered"].includes(b.stage) ? b.stage : "assigned";
    const at = new Date(now()).toISOString();
    const ins = await pool.query(
      `INSERT INTO dl_shipments(shop_order_no, provider, provider_ref, status, driver, cost, cost_basis, dispatch, events,
                                assigned_at, picked_at, delivered_at)
       VALUES ($1,'external',NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [orderNo, stage, name || phone ? J({ name, phone, source: "external" }) : null, cost, cost != null ? "manual" : null,
       J({ status: "external", assigned: true, by: user.name, reason, notes, retro: Boolean(b.retro) }),
       J([{ at, provider: "external", event: stage === "assigned" ? "assigned" : stage, by: `portal:${user.name}`, note: notes || reason }]),
       at, stage !== "assigned" && !b.retro ? at : null, stage === "delivered" && !b.retro ? at : null]);
    await pool.query("UPDATE shop_orders SET dispatch_claimed_at = COALESCE(dispatch_claimed_at, NOW()) WHERE order_no=$1", [orderNo]);
    const next = stage === "delivered" ? "delivered" : stage === "picked" ? "on_the_way" : "courier_assigned";
    const note = `مندوب خارجي — ${user.name}${reason ? ` — ${reason}` : ""}`;
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
    await resolveIncidents(orderNo, "external", user.name, { externalShipmentId: Number(ins.rows[0].id), needsCost, cost });
    // لو مفيش حادثة مفتوحة (المدير اختار خارجي من الأول) بنسجّل واحدة محلولة للأثر
    await pool.query(
      `INSERT INTO dl_courier_incidents(order_no, shipment_id, provider, kind, reason, resolved_at, resolution, resolved_by, detail)
       SELECT $1, $2, 'external', 'provider_cancelled', $3, NOW(), 'external', $4, $5::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM dl_courier_incidents WHERE order_no=$1)`,
      [orderNo, Number(ins.rows[0].id), reason || "المدير اختار مندوب خارجي", user.name, J({ needsCost, cost, manualChoice: true })]).catch(() => {});
    if (!b.retro) customerSms(orderNo, "external");
    audit(user, "courier_external", orderNo, true, { cost, stage, reason, retro: Boolean(b.retro) }, c);
    return c.json({ ok: true, shipmentId: Number(ins.rows[0].id), status: next, needsCost });
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

  // ٣) تحويل لاستلام من المطعم (بعد ما المدير يتفق مع العميل)
  app.post("/api/portal/orders/:orderNo/courier/pickup", (c) => withOrder(c, async ({ user, row, b, dl, orderNo }) => {
    if (!["accepted", "courier_requested", "courier_assigned", "courier_cancelled"].includes(row.status)) {
      return c.json({ ok: false, error: "wrong_stage", message: "التحويل لاستلام قبل ما الكابتن يستلم بس" }, 409);
    }
    const rel = await releaseActive(dl, orderNo, `converted to pickup by ${user.name}`);
    if (!rel.ok) return c.json({ ok: false, error: rel.error, message: rel.message }, 409);
    const reason = clean(b.reason, 160);
    const fee = Number(row.delivery_fee) || 0;
    const at = new Date(now()).toISOString();
    const note = `اتحوّل لاستلام من المطعم — ${user.name}${reason ? ` — ${reason}` : ""}${fee ? ` — راجع استرجاع رسوم التوصيل ${fee} ر.س` : ""}`;
    await pool.query(
      `UPDATE shop_orders SET option='pickup', status='accepted', dispatch_claimed_at = COALESCE(dispatch_claimed_at, NOW()),
              history = history || $2::jsonb, updated_at=NOW() WHERE order_no=$1`,
      [orderNo, J([{ at, status: "accepted", note }])]);
    try { emit("order_status", { orderNo, source: "portal", data: { from: row.status, to: "accepted", note } }); } catch {}
    await resolveIncidents(orderNo, "pickup", user.name, { refundDeliveryFee: fee || 0 });
    await pool.query(
      `INSERT INTO dl_courier_incidents(order_no, shipment_id, provider, kind, reason, resolved_at, resolution, resolved_by, detail)
       SELECT $1, 0, NULL, 'provider_cancelled', $2, NOW(), 'pickup', $3, $4::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM dl_courier_incidents WHERE order_no=$1)`,
      [orderNo, reason || "اتحوّل لاستلام", user.name, J({ refundDeliveryFee: fee || 0, manualChoice: true })]).catch(() => {});
    if (b.notifyCustomer !== false) customerSms(orderNo, "pickup");
    audit(user, "courier_to_pickup", orderNo, true, { reason, refundDeliveryFee: fee }, c);
    return c.json({ ok: true, refundDeliveryFee: fee, message: fee ? `راجع استرجاع رسوم التوصيل ${fee} ر.س من ماي فاتورة لو اتفقت مع العميل` : null });
  }));

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
    let iw = "i.provider = $1 AND i.kind IN ('provider_cancelled','refused_far')";
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
        overMin: null, basis: null, claimable: true, open: false, km: i.detail && i.detail.km != null ? Number(i.detail.km) : null,
        driver: null, claimStatus: (i.detail && i.detail.claimStatus) || "open",
        note: [i.reason, i.resolution ? `الحل: ${i.resolution}${i.resolved_by ? ` (${i.resolved_by})` : ""}` : null].filter(Boolean).join(" — "),
      })),
    ].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
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
    return c.json({ ok: true, month, provider, cfg: await cfgOf(), ...r });
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
