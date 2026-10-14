/* ═══════════════════════════════════════════════════════════════════════════
   صفحة تتبّع العميل — مراحل الطلب بأوقاتها + «يوصلك تقريباً» (عمر ١٤/١٠: «صفحة تتبع زي التطبيقات الكبيرة، والوقت يظهر لما المندوب يستلم»)

   القاعدة الأولى: **مفيش وقت دقيق مزيّف**.
     • قبل ما المندوب يستلم: نطاق بس («بين ٨:٤٠ و٨:٥٥») من إعدادات التحضير (courierSla.prepMin / arriveTypMin / handoverMin)
       + مشوار الطلب نفسه. الأساس basis = "prep".
     • بعد الاستلام: وقت واحد («٨:٤٥ م — خلال ~١٨ د»)، بيتحسب من جديد مع كل نقطة للمندوب:
         مسافة الطريق من المندوب للعميل ≈ الخط المستقيم × نسبة الطريق للطلب ده (routeKm ÷ الخط المستقيم من المطعم — نفس المسافة اللي اتسعّر
         عليها التوصيل، جوجل لو المفتاح موجود)، ولو النسبة مش معقولة أو مش موجودة ⇒ معامل الطريق من اللوحة (١٫٣٥). ÷ السرعة من اللوحة (٢٥ كم/س)
         + دقايق التسليم عند الباب. basis = "position".
       موقع المندوب قديم (أقدم من staleMin) أو مش موجود ⇒ من وقت الاستلام + مدة المشوار كله. basis = "route".
     • عمر الوقت ما يبقى قبل دلوقتي: لو فات ⇒ soon:true و«قريب جداً» — مش رقم بالسالب.
   مفيش أي طلب لجوجل هنا: كل حاجة من بيانات عندنا (routeKm محفوظ مع الطلب وقت التسعير، وموقع المندوب من استعلام delivery.js).
   مفيش إحداثيات العميل ولا المسافة الفاضلة في الرد (رقم الطلب بس هو المفتاح على صفحة عامة).
═══════════════════════════════════════════════════════════════════════════ */
import { courierSlaCfg } from "./courierops.js";
import { routeKmOfRow } from "./delivery.js";
import { STORE_LAT, STORE_LNG } from "./tsstore.js";

export const TRACK_ETA_DEFAULTS = Object.freeze({
  enabled: true,        // «يوصلك تقريباً» على صفحة التتبع
  roadFactor: 1.35,     // الخط المستقيم × ده = مسافة الطريق (لو مفيش مسافة طريق محفوظة للطلب)
  speedKmh: 25,         // سرعة المندوب جوّه المدينة
  doorMin: 2,           // التسليم عند الباب
  rangeMin: 15,         // عرض النطاق قبل الاستلام
  staleMin: 8,          // موقع المندوب أقدم من كده ⇒ نحسب من وقت الاستلام بدل موقعه
  useRouteRatio: true,  // نسبة الطريق من مسافة الطلب المحفوظة (جوجل) بدل المعامل الثابت
});
const LIMITS = { roadFactor: [1, 3], speedKmh: [5, 80], doorMin: [0, 20], rangeMin: [5, 60], staleMin: [2, 30] };

export function trackEtaCfg(settings = {}) {
  const raw = (((settings || {}).delivery || {}).trackEta) || {};
  const out = { ...TRACK_ETA_DEFAULTS };
  out.enabled = raw.enabled !== false && raw.enabled !== "false";
  out.useRouteRatio = raw.useRouteRatio !== false && raw.useRouteRatio !== "false";
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") continue;
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n >= lo && n <= hi) out[k] = n;
  }
  return out;
}
export const TRACK_ETA_LIMITS = LIMITS;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const ms = (v) => { if (v == null || v === "") return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
const iso = (t) => (t == null ? null : new Date(t).toISOString());
export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null || a.lng == null || b.lng == null) return null;
  const R = 6371, r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function customerOf(row) {
  let a = row && row.address;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== "object") return null;
  const lat = num(a.latitude ?? a.lat), lng = num(a.longitude ?? a.lng);
  return lat != null && lng != null && (lat || lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
/* نفس portal-core.driverLatLng (منسوخة هنا عشان portal-core بيستورد shop.js — shop.js بيستورد الملف ده) */
export function driverLatLng(driver) {
  if (!driver || typeof driver !== "object") return { lat: null, lng: null };
  for (const c of [driver.location, driver.position, driver.coords, driver.current_location, driver]) {
    if (c == null) continue;
    let lat = null, lng = null;
    if (Array.isArray(c) && c.length >= 2) { lat = num(c[0]); lng = num(c[1]); }
    else if (typeof c === "string" && /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(c.trim())) { const [a, b] = c.split(","); lat = num(a); lng = num(b); }
    else if (typeof c === "object") { lat = num(c.lat ?? c.latitude); lng = num(c.lng ?? c.lon ?? c.long ?? c.longitude); }
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) return { lat, lng };
  }
  return { lat: null, lng: null };
}
function driverOf(sh) {
  let d = sh && sh.driver;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { d = null; } }
  return d && typeof d === "object" ? d : null;
}
function historyAt(row, status) {
  let h = row && row.history;
  if (typeof h === "string") { try { h = JSON.parse(h); } catch { h = null; } }
  if (!Array.isArray(h)) return null;
  for (const e of h) if (e && e.status === status && ms(e.at) != null) return ms(e.at);
  return null;
}
const floor5 = (t) => Math.floor(t / 300_000) * 300_000;
const ceil5 = (t) => Math.ceil(t / 300_000) * 300_000;

/* وقت استلام المندوب: محطة الشركة، وإلا تسليم الكاشير، وإلا لحظة «في الطريق» من سجل الطلب */
export function pickedAtOf(row = {}, sh = null) {
  return ms(sh && sh.picked_at) ?? ms(row.handed_at) ?? (["on_the_way", "delivered"].includes(String(row.status)) ? (historyAt(row, "on_the_way") ?? null) : null);
}
const PRE_PICKUP = new Set(["paid", "pos_created", "accepted", "courier_requested", "courier_assigned"]);

/* مسافة الطريق لكيلو خط مستقيم: نسبة الطلب ده (لو معقولة) وإلا معامل اللوحة */
function roadRatio(row, cust, cfg) {
  if (cfg.useRouteRatio) {
    const rk = (() => { try { return routeKmOfRow(row); } catch { return null; } })();
    const st = haversineKm({ lat: STORE_LAT(), lng: STORE_LNG() }, cust);
    if (rk > 0 && st > 0.3) { const r = rk / st; if (r >= 1 && r <= 2.5) return { ratio: r, source: "route" }; }
  }
  return { ratio: cfg.roadFactor, source: "setting" };
}
function tripKm(row, cust, cfg) {
  const rk = (() => { try { return routeKmOfRow(row); } catch { return null; } })();
  if (rk > 0) return rk;
  const st = cust ? haversineKm({ lat: STORE_LAT(), lng: STORE_LNG() }, cust) : null;
  return st > 0 ? st * cfg.roadFactor : null;
}
const driveMin = (km, cfg) => (km / cfg.speedKmh) * 60;

/* ⇒ null (مفيش وقت يتقال) أو { at, minutes, basis, soon, range? }
     basis: "prep" (نطاق قبل الاستلام) | "position" (من موقع المندوب) | "route" (من وقت الاستلام + المشوار) */
export function computeTrackEta({ row, sh = null, settings = {}, now = Date.now() } = {}) {
  if (!row || row.option !== "delivery" || Number(row.table_no) > 0) return null;
  const cfg = trackEtaCfg(settings);
  if (!cfg.enabled) return null;
  const status = String(row.status || "");
  if (status === "delivered" || (sh && ["delivered", "cancelled"].includes(String(sh.status)))) return null;
  const cust = customerOf(row);
  const picked = pickedAtOf(row, sh);
  const sla = courierSlaCfg(settings);
  if (picked != null || status === "on_the_way") {
    const drv = driverOf(sh);
    const pos = drv ? driverLatLng(drv) : { lat: null, lng: null };
    const posAt = ms(sh && sh.updated_at);
    const fresh = pos.lat != null && posAt != null && now - posAt <= cfg.staleMin * 60_000;
    if (fresh && cust) {
      const straight = haversineKm(pos, cust);
      const { ratio, source } = roadRatio(row, cust, cfg);
      if (straight != null && straight <= (Number(sla.nearKm) || 0.4)) return { at: null, minutes: 0, basis: "position", soon: true, ratio: source };
      const raw = driveMin(straight * ratio, cfg) + cfg.doorMin;
      const minutes = Math.max(1, Math.ceil(raw));
      return { at: iso(Math.ceil((now + minutes * 60_000) / 60_000) * 60_000), minutes, basis: "position", soon: minutes <= 2, ratio: source };
    }
    const km = tripKm(row, cust, cfg);
    if (km == null) return null;
    const start = picked ?? now;
    const end = start + (driveMin(km, cfg) + cfg.doorMin) * 60_000;
    const left = (end - now) / 60_000;
    if (left <= 1) return { at: null, minutes: 0, basis: "route", soon: true };
    const minutes = Math.ceil(left);
    return { at: iso(Math.ceil((now + minutes * 60_000) / 60_000) * 60_000), minutes, basis: "route", soon: minutes <= 2 };
  }
  if (!PRE_PICKUP.has(status)) return null;
  const km = tripKm(row, cust, cfg);
  if (km == null) return null;
  const readyAt = ms(row.pos_ready_at), acceptedAt = ms(row.accepted_at) ?? ms(row.created_at) ?? now;
  const kitchen = readyAt != null ? Math.max(readyAt, now) : Math.max(acceptedAt + sla.prepMin * 60_000, now);
  const assignedAt = ms(sh && sh.assigned_at), arrivedAt = ms(sh && sh.arrived_at);
  const courier = arrivedAt != null ? now : Math.max((assignedAt ?? now) + sla.arriveTypMin * 60_000, now);
  const pickup = Math.max(kitchen, courier) + sla.handoverMin * 60_000;
  const low = floor5(pickup + (driveMin(km, cfg) + cfg.doorMin) * 60_000);
  const high = Math.max(ceil5(low + cfg.rangeMin * 60_000), low + 10 * 60_000);
  const from = Math.max(low, ceil5(now + 5 * 60_000));
  const to = Math.max(high, from + 10 * 60_000);
  return { at: null, minutes: null, basis: "prep", soon: false,
    range: { from: iso(from), to: iso(to), fromMin: Math.max(1, Math.round((from - now) / 60_000)), toMin: Math.max(1, Math.round((to - now) / 60_000)) } };
}

/* المراحل الخمسة بأوقاتها (توصيل بس، مش طاولة):
     received ← preparing ← courier_to_store ← picked ← delivered
   current = أبعد مرحلة وصلناها. الأوقات من الطلب والشحنة نفسها، ولو المحطة مالهاش وقت ⇒ null (الصفحة مابتخترعش وقت). */
export function trackStages({ row, sh = null } = {}) {
  if (!row || row.option !== "delivery" || Number(row.table_no) > 0) return null;
  const status = String(row.status || "");
  const deliveredAt = ms(sh && sh.delivered_at) ?? historyAt(row, "delivered");
  const picked = pickedAtOf(row, sh);
  const assignedAt = ms(sh && sh.assigned_at) ?? (["courier_assigned", "on_the_way", "delivered"].includes(status) ? historyAt(row, "courier_assigned") : null);
  const acceptedAt = ms(row.accepted_at) ?? historyAt(row, "accepted");
  const receivedAt = historyAt(row, "paid") ?? historyAt(row, "pos_created") ?? ms(row.created_at);
  const shipAssigned = Boolean(sh && (sh.assigned_at || ["assigned", "picked", "delivered"].includes(String(sh.status))));
  const idx = status === "delivered" ? 4
    : (picked != null || status === "on_the_way") ? 3
      : (status === "courier_assigned" || shipAssigned) ? 2
        : ["accepted", "courier_requested"].includes(status) || acceptedAt != null ? 1 : 0;
  const steps = [
    { key: "received", at: iso(receivedAt) },
    { key: "preparing", at: iso(acceptedAt) },
    { key: "courier_to_store", at: iso(assignedAt), arrivedAt: iso(ms(sh && sh.arrived_at)) },
    { key: "picked", at: iso(picked) },
    { key: "delivered", at: iso(deliveredAt) },
  ];
  return {
    current: idx,
    steps: steps.map((s, i) => ({ ...s, state: i < idx || (idx === 4 && i === 4) ? "done" : i === idx ? "active" : "pending", ...(i > idx ? { at: null } : {}) })),
  };
}
