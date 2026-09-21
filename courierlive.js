/* ═══════════════════════════════════════════════════════════════════════════
   COURIER LIVE — تتبّع حيّ على الخريطة (٢١ سبتمبر ٢٠٢٦، طلب عمر).

   ثلاث حاجات في ملف واحد لأنهم نفس الشغلة: «فين المندوب دلوقتي؟»

   ١) لاجلك — فيه إحداثيات فعلاً. اتأكدنا على اللايف (٢١/٩):
        GET /orders/<dsp_order_id> →
        {id, status, dsp_order_id, driver:{name, phone, location:{latitude, longitude}}}
      الموقع ده **حي** — بيتغيّر مع كل نداء وبيفضل بيتحرك حتى بعد التسليم
      (جرّبنا: شحنة متوصّلة رجّعت موقع غير اللي اتسجّل وقت التسليم). فبنقف
      عند delivered/cancelled ونثبّت آخر نقطة، وإلا هنرسم كابتن بيلف في
      المدينة على طلب خلص من ساعة.
      **مفيش ETA ومفيش رابط تتبع عندهم** — الاتنين بنحسبهم/بنعملهم إحنا.

   ٢) الأثر (breadcrumbs). الاستطلاع الأساسي (delivery.js، كل دقيقة) بيحفظ
      آخر موقع بس في dl_shipments.driver — يعني نقطة واحدة، مالهاش خط.
      هنا بنقرا نفس العمود كل ٢٠ ثانية ونسجّل النقطة لو اتغيّرت → خط المشوار
      من غير ولا نداء زيادة على API الشركة.
      ولما المدير يفتح الخريطة بنسأل الشركة مباشرة (position-only، مخنوقة
      بـ١٢ ثانية لكل شحنة) — فالنقطة بتبقى أحدث وهو بيتفرّج، والحالة تفضل
      مسؤولية الاستطلاع الأساسي (مصدر واحد للمراحل والأحداث).

   ٣) المندوب الخارجي (واحد ممكن نستعمله مرة واحدة في العمر): مفيش تطبيق
      ومفيش حساب. المدير بيبعتله واتساب فيه **بالظبط** اللي بنبعته للاجلك،
      وجوّاه رابط موقّع لمرة واحدة https://freshcuts.sa/d/<token> بيفتح صفحة
      خفيفة: «ابدأ التوصيل» (بتطلب إذن الموقع وتبعت نبضات وإحنا بنرسمه على
      نفس الخريطة)، «وصلت للعميل»، و«تم التسليم». التوكن لشحنة واحدة وبينتهي.

   خصوصية: صفحة المندوب مافيهاش غير الطلب ده — مفيش طلبات تانية ولا تاريخ
   ولا أسعار أصناف. جوال العميل بيتعرض مقنّع والاتصال بزرار.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { STORE_LAT, STORE_LNG } from "./tsstore.js";
import { PROVIDERS, readableAddress, courierNotes, leaveAtDoor, DOOR_NOTE, PREPAID_NOTE, msisdn } from "./couriers.js";
import { driverLatLng } from "./portal-core.js";
import { districtOfRow } from "./districts.js";
import { dispatchDelayOf } from "./delivery.js";
import { emitOrder } from "./order-events.js";

/* ── ثوابت التشغيل ─────────────────────────────────────────────────────── */
export const TRAIL_TICK_MS = 20_000;      // كنس الأثر من العمود المحفوظ
export const LIVE_REFRESH_MS = 12_000;    // أقل فاصل بين نداءين للشركة لنفس الشحنة
export const PING_MIN_MS = 8_000;         // أقل فاصل بين نبضتين من صفحة المندوب
export const PING_MIN_M = 8;              // أقل مسافة (متر) عشان النقطة تتسجّل
export const PING_MAX_ACC_M = 500;        // نبضة بدقة أوحش من كده = ضوضاء
export const TRAIL_MAX = 400;             // أقصى نقاط بترجع للخريطة
export const DEFAULT_LINK_HOURS = 6;      // عمر رابط المندوب الخارجي
export const EXT_PAGE_BASE = "https://freshcuts.sa";

const R_EARTH = 6371;
const rad = (d) => (Number(d) * Math.PI) / 180;
export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* نقطة جديدة تستاهل تتسجّل؟ الـGPS بيرجّع نفس المكان ±٣ متر وهو واقف،
   فمن غير الشرط ده الأثر بيبقى ألف نقطة فوق بعضها على إشارة مرور. */
export function shouldRecordPing(last, next, { minMs = PING_MIN_MS, minM = PING_MIN_M } = {}) {
  if (!next || !Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return false;
  if (Math.abs(next.lat) > 90 || Math.abs(next.lng) > 180 || (!next.lat && !next.lng)) return false;
  if (!last) return true;
  const dtMs = new Date(next.at || Date.now()).getTime() - new Date(last.at).getTime();
  const dM = (haversineKm({ lat: last.lat, lng: last.lng }, { lat: next.lat, lng: next.lng }) || 0) * 1000;
  if (dM >= minM) return true;
  // واقف في مكانه: بنسجّل نقطة كل دقيقتين بس عشان يبان إنه لسه حي
  return dtMs >= Math.max(minMs, 120_000);
}

/* ETA من مكان المندوب للعميل. لاجلك مابتديش ETA، فبنحسبه بنفس منطق
   courierops (خط مستقيم × معامل الطريق ÷ سرعة) — وبنقوله «تقديري» بصوت عالي
   في الواجهة بدل ما نبيعه كرقم من الشركة. */
export function etaMinutes({ from, to, routeFactor = 1.3, kmh = 24, minMin = 2 }) {
  const km = haversineKm(from, to);
  if (km == null) return null;
  const mins = (km * routeFactor) / kmh * 60;
  return Math.max(minMin, Math.round(mins));
}

/* ٠٥٥١٢٣٤٥٦٧ → ٠٥٥•••٤٥٦٧ — بيبان منه أول وآخر، والاتصال بزرار tel: */
export function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length < 7) return d ? "•".repeat(d.length) : "";
  return `${d.slice(0, 3)}${"•".repeat(Math.max(0, d.length - 7))}${d.slice(-4)}`;
}
export function localPhone(p) {
  const d = String(p || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? `0${d}` : String(p || "").replace(/\D/g, "");
}

/* ═══ رسالة الواتساب ═══════════════════════════════════════════════════════
   القاعدة: **نفس** اللي الـAPI بيبعته للاجلك، مش نص تاني بنكتبه من جديد —
   عشان لو غيّرنا صيغة العنوان بكرة، المندوب الخارجي يشوف نفس التغيير.
   readableAddress و courierNotes و DOOR_NOTE و PREPAID_NOTE كلهم من
   couriers.js نفسه. */
export function handoffText(order, { link, storeName = "فريش كاتس", pinFormat = "link" } = {}) {
  const addr = (order && order.address) || {};
  const lat = Number(addr.latitude ?? addr.lat), lng = Number(addr.longitude ?? addr.lng);
  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng);
  const pair = hasPin ? `${lat.toFixed(6)},${lng.toFixed(6)}` : "";
  const pin = hasPin ? (pinFormat === "pair" ? pair : `https://maps.google.com/?q=${pair}`) : "";
  const text = readableAddress({ ...addr, leave_at_door: false }, { withPin: false });
  const dnotes = String(addr.delivery_notes || addr.deliveryNotes || "").trim();
  const total = Number(order && order.total);
  const L = [
    `🛵 ${storeName} — توصيل طلب ${order.order_no}`,
    "",
    `العميل: ${(order.customer && order.customer.name) || "العميل"}`,
    `جواله: ${localPhone((order.customer && order.customer.phone) || order.phone_norm)}`,
  ];
  if (pin) L.push(`📍 الموقع على الخريطة: ${pin}`);
  if (text && text !== "موقع العميل — اتبع الإحداثيات") L.push(`العنوان: ${text}`);
  if (dnotes) L.push(`ملاحظات التوصيل: ${dnotes}`);
  if (leaveAtDoor(addr)) L.push(`🚪 ${DOOR_NOTE}`);
  L.push("");
  if (Number.isFinite(total)) L.push(`المبلغ: ${total.toFixed(2)} ر.س`);
  L.push(`💳 ${PREPAID_NOTE}`);
  if (link) {
    L.push("");
    L.push("ابدأ التوصيل وسجّل التسليم من هنا:");
    L.push(link);
    L.push("(الرابط لهذا الطلب فقط وينتهي بعد انتهاء التوصيل)");
  }
  return L.join("\n");
}

export function waUrl(phone, text) {
  const d = msisdn(phone || "");
  const q = `?text=${encodeURIComponent(text || "")}`;
  return /^9665\d{8}$/.test(d) ? `https://wa.me/${d}${q}` : `https://wa.me/${q}`;
}

/* ═══ رسالة الجروب — «طلباتك» (عمر ٢١/٩) ═══════════════════════════════════
   الواقع اللي عمر وصفه: المدير **مابيكلّمش رقم**، بينشر الطلب في جروب
   واتساب بتاعهم. اللي يقبله بيكلّم المدير، ييجي المطعم، يستلم، ويوصّل.
   يعني وقت الإرسال إحنا **مانعرفش** مين المندوب ولا جواله — بييجوا بعدين.

   وعشان كده الرسالة مختلفة عن رسالة المندوب الشخصي:
     • مفيش «يا فلان» — دي منشور عام في جروب.
     • الحي بيتكتب أول حاجة (ده اللي بيسعّروا بيه وبيقرّروا بيه يقبلوا ولا لأ).
     • وقت الاستلام صريح («جاهز دلوقتي» / «جاهز خلال ١٥ د»).
     • المبلغ + «مدفوع مسبقاً — لا يُحصَّل» عشان محدش يحصّل من العميل.
     • رابط التتبع بيشتغل لأول واحد يفتحه — هو ده اللي أخد الطلب.

   ⚠️ روابط جروبات الواتساب (chat.whatsapp.com/...) **مابتقبلش ?text=** —
   مفيش طريقة تفتح جروب معيّن والرسالة مكتوبة فيه. الحل اللي بيشتغل فعلاً:
     ١) ننسخ النص للحافظة (clipboard)،
     ٢) نفتح `https://wa.me/?text=…` — ده بيفتح الواتساب على **منتقي
        المحادثات** والرسالة جاهزة، فالمدير يختار الجروب ويبعت. ده المسار
        الأساسي لأنه بيوفّر اللصق أصلاً.
     ٣) ولو حب يفتح الجروب نفسه، زرار تاني بيفتح رابط الدعوة والنص متنسوخ
        فيلزقه بإيده.                                                       */
export function groupHandoffText(order, { link, district, cost, storeName = "فريش كاتس", pickup = null, providerName = null } = {}) {
  const addr = (order && order.address) || {};
  const lat = Number(addr.latitude ?? addr.lat), lng = Number(addr.longitude ?? addr.lng);
  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng);
  const pin = hasPin ? `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}` : "";
  const text = readableAddress({ ...addr, leave_at_door: false }, { withPin: false });
  const dnotes = String(addr.delivery_notes || addr.deliveryNotes || "").trim();
  const total = Number(order && order.total);
  const L = [`🛵 ${storeName} — طلب توصيل${district ? ` — حي ${district}` : ""}`, ""];
  L.push(`رقم الطلب: ${order.order_no}`);
  if (district) L.push(`الحي: ${district}`);
  if (cost != null && Number.isFinite(Number(cost))) L.push(`أجرة التوصيل: ${Number(cost)} ر.س`);
  L.push(`الاستلام من المطعم: ${pickup || "جاهز الآن"}`);
  if (pin) L.push(`📍 موقع العميل: ${pin}`);
  if (text && text !== "موقع العميل — اتبع الإحداثيات") L.push(`العنوان: ${text}`);
  if (dnotes) L.push(`ملاحظات التوصيل: ${dnotes}`);
  if (leaveAtDoor(addr)) L.push(`🚪 ${DOOR_NOTE}`);
  L.push("");
  if (Number.isFinite(total)) L.push(`مبلغ الطلب: ${total.toFixed(2)} ر.س`);
  L.push(`💳 ${PREPAID_NOTE}`);
  if (link) {
    L.push("");
    L.push("اللي هياخد الطلب يفتح الرابط ده ويسجّل منه التسليم:");
    L.push(link);
    L.push("(الرابط لهذا الطلب فقط — أول واحد يفتحه هو اللي استلمه)");
  }
  L.push("");
  L.push(`يا ريت اللي هيستلم يكلّمنا${providerName ? "" : ""} ويبعت اسمه ورقمه.`);
  return L.join("\n");
}

/* «جاهز دلوقتي» / «جاهز خلال ١٥ دقيقة» — الجروب محتاج يعرف يستنى قد إيه */
export function pickupLabel({ readyAt = null, delayMin = 0, at = Date.now() } = {}) {
  if (readyAt) {
    const t = new Date(readyAt).getTime();
    if (Number.isFinite(t) && t <= at) return "جاهز الآن";
  }
  const m = Math.max(0, Math.round(Number(delayMin) || 0));
  return m > 0 ? `جاهز خلال ${m} دقيقة تقريباً` : "جاهز الآن";
}

/* ═══════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, getSettingsData, jb } = ctx;
  const log = ctx.log || console;
  const shop = typeof deps.shop === "function" ? deps.shop : () => deps.shop || null;
  const delivery = typeof deps.delivery === "function" ? deps.delivery : () => deps.delivery || null;
  const portal = typeof deps.portal === "function" ? deps.portal : () => deps.portal || null;
  const emit = deps.emitOrder || emitOrder;
  const now = deps.now || (() => Date.now());
  const J = jb || ((v) => JSON.stringify(v));

  let schemaOk = null;
  async function ensureSchema() {
    if (schemaOk !== null) return schemaOk;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS dl_courier_pings (
          id BIGSERIAL PRIMARY KEY,
          shipment_id BIGINT NOT NULL,
          order_no TEXT NOT NULL,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          lat DOUBLE PRECISION NOT NULL,
          lng DOUBLE PRECISION NOT NULL,
          acc REAL,
          source TEXT NOT NULL DEFAULT 'provider'
        );
        CREATE INDEX IF NOT EXISTS dl_pings_sh_idx ON dl_courier_pings(shipment_id, at DESC);
        /* رحلة مندوب خارجي: توكن واحد لشحنة واحدة، مخزّن مهشّم (اللي في
           الجدول مايفتحش الصفحة). revoked_at أو expires_at = الرابط مات. */
        CREATE TABLE IF NOT EXISTS dl_ext_runs (
          id BIGSERIAL PRIMARY KEY,
          shipment_id BIGINT NOT NULL UNIQUE,
          order_no TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          courier_name TEXT,
          courier_phone TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          opened_at TIMESTAMPTZ,
          started_at TIMESTAMPTZ,
          arrived_at TIMESTAMPTZ,
          delivered_at TIMESTAMPTZ,
          received_by TEXT,
          note TEXT,
          pings INT NOT NULL DEFAULT 0,
          last_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS dl_ext_runs_order_idx ON dl_ext_runs(order_no);
      `);
      schemaOk = true;
    } catch (e) {
      log.error(`[courierlive] schema failed: ${e?.message || e}`);
      schemaOk = false;
    }
    return schemaOk;
  }
  ensureSchema();

  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const clean = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  const isActive = (s) => !["delivered", "cancelled"].includes(String(s || ""));

  /* ── تسجيل نقطة ─────────────────────────────────────────────────────── */
  const lastPing = new Map();   // shipmentId → {at, lat, lng}  (ذاكرة، بتقلّل قراءات)
  async function lastPointOf(shipmentId) {
    if (lastPing.has(shipmentId)) return lastPing.get(shipmentId);
    const r = await pool.query(
      "SELECT at, lat, lng FROM dl_courier_pings WHERE shipment_id=$1 ORDER BY at DESC LIMIT 1", [shipmentId]);
    const p = r.rows[0] ? { at: iso(r.rows[0].at), lat: Number(r.rows[0].lat), lng: Number(r.rows[0].lng) } : null;
    lastPing.set(shipmentId, p);
    return p;
  }
  async function recordPing(shipmentId, orderNo, { lat, lng, acc = null, source = "provider", at = null }) {
    if (!(await ensureSchema()) || !shipmentId) return false;
    const next = { lat: Number(lat), lng: Number(lng), at: at || new Date(now()).toISOString() };
    const last = await lastPointOf(shipmentId);
    if (!shouldRecordPing(last, next)) return false;
    await pool.query(
      "INSERT INTO dl_courier_pings(shipment_id, order_no, at, lat, lng, acc, source) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [shipmentId, String(orderNo), next.at, next.lat, next.lng, acc == null ? null : Number(acc), source]);
    lastPing.set(shipmentId, next);
    // الكاش ده اختصار قراءات، مش مخزن — بنقصّه عشان مايكبرش مع الشهور
    if (lastPing.size > 300) for (const k of [...lastPing.keys()].slice(0, 150)) lastPing.delete(k);
    return true;
  }

  /* ── الأثر: بيتلقط من العمود اللي الاستطلاع الأساسي بيكتبه ─────────────
     مفيش أي نداء للشركة هنا. الشحنة المتوصّلة/الملغية مستثناة عشان الموقع
     بيفضل يتحرك عندهم بعد التسليم. */
  let sweeping = false;
  async function sweepTrails() {
    if (sweeping || !(await ensureSchema())) return 0;
    sweeping = true;
    let n = 0;
    try {
      const rows = (await pool.query(
        `SELECT id, shop_order_no, driver, updated_at FROM dl_shipments
          WHERE provider <> 'external' AND driver IS NOT NULL
            AND status NOT IN ('delivered','cancelled')
            AND created_at > NOW() - INTERVAL '6 hours'
          LIMIT 40`)).rows;
      for (const r of rows) {
        const p = driverLatLng(r.driver);
        if (p.lat == null) continue;
        if (await recordPing(r.id, r.shop_order_no, { lat: p.lat, lng: p.lng, source: "provider", at: iso(r.updated_at) })) n++;
      }
    } catch (e) {
      log.error(`[courierlive] trail sweep failed: ${e?.message || e}`);
    } finally { sweeping = false; }
    return n;
  }
  if (deps.timers !== false) {
    const t = setInterval(() => { sweepTrails(); }, TRAIL_TICK_MS);
    t.unref?.();
  }

  /* ── تحديث فوري من الشركة (موقع بس) ───────────────────────────────────
     الحالة مش شغلنا: الاستطلاع في delivery.js هو اللي بيكتب المراحل
     والأحداث وبينادي shop.onShipmentEvent. لو لقينا حالة اتغيّرت بنوقّظه
     هو بدل ما ننسخ منطقه هنا — مصدر واحد للمراحل. */
  const refreshedAt = new Map();
  let lastWake = 0;
  async function refreshPosition(sh) {
    if (!sh || !sh.provider_ref || !isActive(sh.status)) return null;
    const p = PROVIDERS[sh.provider];
    if (!p || !p.configured || !p.configured() || p.manual) return null;
    const t = now();
    if (t - (refreshedAt.get(sh.id) || 0) < LIVE_REFRESH_MS) return null;
    refreshedAt.set(sh.id, t);
    let o = null;
    try { o = await p.track(sh); } catch (e) {
      log.error?.(`[courierlive] refresh ${sh.shop_order_no} failed: ${e?.message || e}`);
      return null;
    }
    if (!o) return null;
    if (o.driver) {
      // الموقع بس — updated_at مابنلمسهاش عشان مانأجّلش دور الاستطلاع الأساسي
      await pool.query("UPDATE dl_shipments SET driver=$2 WHERE id=$1", [sh.id, J(o.driver)]).catch(() => {});
      const pos = driverLatLng(o.driver);
      if (pos.lat != null) await recordPing(sh.id, sh.shop_order_no, { lat: pos.lat, lng: pos.lng, source: "provider" });
    }
    if (o.status && o.status !== sh.status && t - lastWake > 30_000) {
      lastWake = t;
      try { delivery()?.pollInFlight?.().catch(() => {}); } catch {}
    }
    return o;
  }

  /* ── تجميع صورة الخريطة ────────────────────────────────────────────── */
  async function trailOf(shipmentId) {
    const r = await pool.query(
      `SELECT at, lat, lng, acc, source FROM dl_courier_pings
        WHERE shipment_id=$1 ORDER BY at ASC LIMIT ${TRAIL_MAX}`, [shipmentId]);
    return r.rows.map((x) => ({ at: iso(x.at), lat: Number(x.lat), lng: Number(x.lng), acc: x.acc == null ? null : Number(x.acc), source: x.source }));
  }

  async function liveOf(orderNo, { refresh = true } = {}) {
    if (!(await ensureSchema())) return { ok: false, error: "unavailable" };
    const dl = delivery(), sp = shop();
    if (!dl || !sp) return { ok: false, error: "unavailable" };
    const row = await sp.getOrderRow(orderNo);
    if (!row) return { ok: false, error: "not_found" };
    let sh = await dl.shipmentOf(orderNo);
    if (sh && refresh && sh.provider !== "external") {
      const o = await refreshPosition(sh);
      if (o) sh = (await dl.shipmentOf(orderNo)) || sh;
    }
    const addr = (row.address && typeof row.address === "object") ? row.address : {};
    const cust = { lat: num(addr.latitude ?? addr.lat), lng: num(addr.longitude ?? addr.lng) };
    const store = { lat: STORE_LAT(), lng: STORE_LNG() };
    if (!sh) {
      return { ok: true, orderNo: row.order_no, active: false, provider: null, status: null,
               store, customer: { ...cust, address: readableAddress(addr, { withPin: false }) }, points: [], last: null, eta: null, ext: null };
    }
    const points = await trailOf(sh.id);
    const pos = driverLatLng(sh.driver);
    const lastPt = points.length ? points[points.length - 1] : (pos.lat != null ? { at: iso(sh.updated_at), lat: pos.lat, lng: pos.lng, source: "provider" } : null);
    const active = isActive(sh.status);
    const drv = sh.driver && typeof sh.driver === "object" ? sh.driver : null;
    // بعد الاستلام الهدف هو العميل؛ قبله الكابتن جاي للمطعم
    const target = String(sh.status) === "picked" ? cust : store;
    const eta = active && lastPt && target.lat != null
      ? etaMinutes({ from: lastPt, to: target }) : null;
    const run = (await pool.query(
      `SELECT * FROM dl_ext_runs WHERE shipment_id=$1`, [sh.id])).rows[0] || null;
    return {
      ok: true,
      orderNo: row.order_no,
      active,
      provider: sh.provider,
      status: sh.status,
      driver: drv ? { name: drv.name || null, phone: drv.phone ? localPhone(drv.phone) : null, source: drv.source || null } : null,
      store, customer: { ...cust, address: readableAddress(addr, { withPin: false }), leaveAtDoor: leaveAtDoor(addr) },
      points, last: lastPt,
      /* المسافة اللي فاضلة خط مستقيم + الوقت التقديري — لاجلك مابتديش ETA
         أصلاً، فالرقم ده بتاعنا واللوحة بتقوله «تقديري». */
      eta: eta != null ? { minutes: eta, at: new Date(now() + eta * 60_000).toISOString(),
                           km: Math.round((haversineKm(lastPt, target) || 0) * 10) / 10,
                           toward: String(sh.status) === "picked" ? "customer" : "store", estimated: true } : null,
      times: { requestedAt: iso(sh.created_at), assignedAt: iso(sh.assigned_at), arrivedAt: iso(sh.arrived_at),
               pickedAt: iso(sh.picked_at), deliveredAt: iso(sh.delivered_at), updatedAt: iso(sh.updated_at) },
      ageSec: lastPt ? Math.max(0, Math.round((now() - new Date(lastPt.at).getTime()) / 1000)) : null,
      ext: run ? extRunView(run) : null,
      refreshSec: Math.round(LIVE_REFRESH_MS / 1000),
    };
  }

  const extRunView = (r) => ({
    id: Number(r.id), courierName: r.courier_name || null, courierPhone: r.courier_phone || null,
    createdBy: r.created_by || null, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
    openedAt: iso(r.opened_at), startedAt: iso(r.started_at), arrivedAt: iso(r.arrived_at),
    deliveredAt: iso(r.delivered_at), receivedBy: r.received_by || null, note: r.note || null,
    pings: Number(r.pings) || 0, lastAt: iso(r.last_at), revokedAt: iso(r.revoked_at),
    live: !r.delivered_at && !r.revoked_at && new Date(r.expires_at).getTime() > now(),
  });

  /* ═══ المسارات: المدير في البوابة ═══════════════════════════════════ */
  async function mgr(c) {
    const p = portal();
    if (!p || !p.requirePortal) return { res: c.json({ ok: false, error: "unavailable" }, 503) };
    return p.requirePortal(c, "manager");
  }
  const ipOf = (c) => c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || null;
  const audit = (user, action, orderNo, ok, detail, c) => {
    try { portal()?.audit?.(user, action, orderNo, ok, detail, ipOf(c)); } catch {}
  };

  app.get("/api/portal/orders/:orderNo/courier/live", async (c) => {
    const a = await mgr(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    try {
      const d = await liveOf(orderNo, { refresh: c.req.query("refresh") !== "0" });
      return c.json(d, d.ok ? 200 : d.error === "not_found" ? 404 : 503);
    } catch (e) {
      log.error(`[courierlive] live ${orderNo} failed: ${e?.message || e}`);
      return c.json({ ok: false, error: "failed" }, 500);
    }
  });

  /* رابط + رسالة واتساب للمندوب الخارجي. بيتعمل على الشحنة الخارجية الحالية.
     نفس التوكن بيرجع لو لسه عايش — المدير ممكن يبعت تاني لنفس الشخص من غير
     ما يفتح لينك جديد على نفس الشحنة. */
  app.post("/api/portal/orders/:orderNo/courier/handoff", async (c) => {
    const a = await mgr(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    const b = await c.req.json().catch(() => ({}));
    try {
      const r = await makeHandoff(orderNo, { name: clean(b.name, 80), phone: clean(b.phone, 20),
        by: a.user?.name || "manager", fresh: b.fresh === true,
        mode: b.mode === "group" || b.mode === "direct" ? b.mode : null });
      if (!r.ok) return c.json(r, r.status || 409);
      audit(a.user, "courier_handoff", orderNo, true, { to: r.courierPhone || r.courierName || null, fresh: Boolean(b.fresh) }, c);
      return c.json(r);
    } catch (e) {
      log.error(`[courierlive] handoff ${orderNo} failed: ${e?.message || e}`);
      return c.json({ ok: false, error: "failed", message: String(e?.message || "").slice(0, 200) }, 500);
    }
  });

  // إلغاء الرابط (بعت لواحد غلط / غيّر رأيه)
  app.post("/api/portal/orders/:orderNo/courier/handoff/revoke", async (c) => {
    const a = await mgr(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    if (!(await ensureSchema())) return c.json({ ok: false, error: "unavailable" }, 503);
    const r = await pool.query(
      "UPDATE dl_ext_runs SET revoked_at=NOW() WHERE order_no=$1 AND revoked_at IS NULL AND delivered_at IS NULL RETURNING id", [orderNo]);
    audit(a.user, "courier_handoff_revoke", orderNo, true, { n: r.rowCount }, c);
    return c.json({ ok: true, revoked: r.rowCount });
  });

  async function makeHandoff(orderNo, { name, phone, by, fresh = false, mode = null } = {}) {
    if (!(await ensureSchema())) return { ok: false, error: "unavailable", status: 503 };
    const dl = delivery(), sp = shop();
    if (!dl || !sp) return { ok: false, error: "unavailable", status: 503 };
    const row = await sp.getOrderRow(orderNo);
    if (!row) return { ok: false, error: "not_found", status: 404 };
    if (row.option !== "delivery") return { ok: false, error: "not_delivery", message: "الطلب مش توصيل", status: 400 };
    const sh = await dl.shipmentOf(orderNo);
    if (!sh || sh.provider !== "external") {
      return { ok: false, error: "no_external", message: "سجّل «مندوب خارجي» الأول، وبعدها ابعتله الرابط", status: 409 };
    }
    if (String(sh.status) === "delivered") return { ok: false, error: "delivered", message: "الطلب اتسلّم خلاص", status: 409 };
    const all = await getSettingsData().catch(() => ({}));
    const hours = Math.min(24, Math.max(1, Number(((all.delivery || {}).extLink || {}).hours) || DEFAULT_LINK_HOURS));
    const base = String(((all.delivery || {}).extLink || {}).base || EXT_PAGE_BASE).replace(/\/+$/, "");
    const drv = (sh.driver && typeof sh.driver === "object") ? sh.driver : {};
    const cName = name || drv.name || null, cPhone = phone || drv.phone || null;

    const cur = (await pool.query("SELECT * FROM dl_ext_runs WHERE shipment_id=$1", [sh.id])).rows[0] || null;
    let token = null, run = cur;
    if (!cur || fresh || cur.revoked_at || cur.delivered_at || new Date(cur.expires_at).getTime() <= now()) {
      token = crypto.randomBytes(18).toString("base64url");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      const exp = new Date(now() + hours * 3600_000).toISOString();
      const r = await pool.query(
        `INSERT INTO dl_ext_runs(shipment_id, order_no, token_hash, courier_name, courier_phone, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (shipment_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, courier_name=COALESCE(EXCLUDED.courier_name, dl_ext_runs.courier_name),
           courier_phone=COALESCE(EXCLUDED.courier_phone, dl_ext_runs.courier_phone), created_by=EXCLUDED.created_by,
           created_at=NOW(), expires_at=EXCLUDED.expires_at, revoked_at=NULL, opened_at=NULL, started_at=NULL,
           arrived_at=NULL, delivered_at=NULL, received_by=NULL, note=NULL, pings=0, last_at=NULL
         RETURNING *`,
        [sh.id, orderNo, hash, cName, cPhone, by || null, exp]);
      run = r.rows[0];
    } else if (cName || cPhone) {
      const r = await pool.query(
        "UPDATE dl_ext_runs SET courier_name=COALESCE($2,courier_name), courier_phone=COALESCE($3,courier_phone) WHERE id=$1 RETURNING *",
        [cur.id, cName, cPhone]);
      run = r.rows[0];
    }
    /* التوكن نفسه مابيتخزّنش — لو المدير قفل الشاشة قبل ما يبعت، بيعمل
       واحد جديد (زرار «رابط جديد»). ده مقصود: hash واحد في الجدول يعني
       مفيش نسخة من المفتاح عندنا تتسرّب. */
    const link = token ? `${base}/d/${token}` : null;
    /* ── نشر في جروب ولا رسالة لشخص؟ ──────────────────────────────────
       «طلباتك» = جروب (عمر ٢١/٩). بنقرّر تلقائياً: لو الطلب طلب حي ومفيش
       جوال مندوب لسه → وضع الجروب. والمدير يقدر يفرض الاتنين بـ`mode`. */
    const dd = districtOfRow(row);
    const grp = mode === "group" || (mode !== "direct" && Boolean(dd) && !cPhone);
    let text, groupUrl = null, providerName = null;
    if (grp) {
      const delayMin = dispatchDelayOf(all);
      providerName = (dd && dd.provider && dd.provider.name) || null;
      groupUrl = (dd && dd.provider && dd.provider.groupUrl) || null;
      text = groupHandoffText(row, {
        link: link || `${base}/d/…`,
        district: dd ? dd.district : null,
        cost: dd && dd.cost != null ? dd.cost : null,
        providerName,
        pickup: pickupLabel({ readyAt: row.pos_ready_at, delayMin }),
      });
    } else {
      text = handoffText(row, { link: link || `${base}/d/…` });
    }
    return {
      ok: true, orderNo, shipmentId: Number(sh.id),
      link, hasLink: Boolean(link),
      /* `mode:"group"` بيقول للبوابة: انسخ الأول وبعدين افتح — الجروب
         مابيتفتحش وجواه رسالة، ده قيد في الواتساب نفسه. */
      mode: grp ? "group" : "direct",
      text, waUrl: waUrl(cPhone, text),
      shareUrl: `https://wa.me/?text=${encodeURIComponent(text)}`,
      groupUrl, groupName: (dd && dd.provider && dd.provider.groupName) || null, providerName,
      district: dd ? dd.district : null,
      courierName: cName, courierPhone: cPhone ? localPhone(cPhone) : null,
      needsCourier: grp && !cPhone,
      expiresAt: iso(run.expires_at), run: extRunView(run),
      note: token ? null : "الرابط القديم لسه شغّال — اضغط «رابط جديد» لو محتاج واحد تاني",
    };
  }

  /* ── اسم/جوال المندوب بييجوا **بعدين** (عمر ٢١/٩) ───────────────────────
     وقت النشر في الجروب محدش عارف مين هياخده. لما يكلّم المدير، المدير
     بيكتب اسمه ورقمه من نفس اللوحة — وبيتحفظوا على الشحنة وعلى الرابط
     مع بعض، فالخريطة والتقارير بيشوفوا نفس الاسم. */
  app.post("/api/portal/orders/:orderNo/courier/driver", async (c) => {
    const a = await mgr(c); if (a.res) return a.res;
    const orderNo = String(c.req.param("orderNo") || "").slice(0, 64);
    const b = await c.req.json().catch(() => ({}));
    const name = clean(b.name, 80) || null;
    const phone = String(b.phone || "").replace(/\D/g, "").slice(0, 15) || null;
    if (!name && !phone) return c.json({ ok: false, error: "empty", message: "اكتب اسم المندوب أو جواله" }, 400);
    const dl = delivery();
    const sh = dl ? await dl.shipmentOf(orderNo) : null;
    if (!sh) return c.json({ ok: false, error: "no_shipment", message: "مفيش مندوب متسجّل على الطلب" }, 409);
    await pool.query(
      `UPDATE dl_shipments SET driver = COALESCE(driver,'{}'::jsonb) || $2::jsonb,
              events = events || $3::jsonb, updated_at=NOW() WHERE id=$1`,
      [sh.id, J({ ...(name ? { name } : {}), ...(phone ? { phone } : {}) }),
       J([{ at: new Date(now()).toISOString(), provider: sh.provider, event: "driver_named",
            by: `portal:${a.user?.name || "manager"}`, note: `${name || ""} ${phone || ""}`.trim() }])]);
    if (await ensureSchema()) {
      await pool.query(
        `UPDATE dl_ext_runs SET courier_name = COALESCE($2, courier_name), courier_phone = COALESCE($3, courier_phone)
          WHERE shipment_id=$1`, [sh.id, name, phone]).catch(() => {});
    }
    audit(a.user, "courier_driver", orderNo, true, { name, phone: phone ? "set" : null }, c);
    try { portal()?.scheduleRefresh?.(orderNo); } catch {}
    return c.json({ ok: true, name, phone: phone ? localPhone(phone) : null });
  });

  /* ═══ صفحة المندوب الخارجي — عام، بالتوكن بس ══════════════════════════ */
  const pingGate = new Map();   // runId → آخر نبضة (خنق قبل ما نلمس الداتابيز)

  async function runByToken(tok) {
    if (!(await ensureSchema())) return null;
    const t = String(tok || "");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) return null;
    const hash = crypto.createHash("sha256").update(t).digest("hex");
    const r = await pool.query(
      `SELECT r.*, sh.status AS ship_status, sh.provider, sh.shop_order_no
         FROM dl_ext_runs r JOIN dl_shipments sh ON sh.id = r.shipment_id
        WHERE r.token_hash=$1`, [hash]);
    return r.rows[0] || null;
  }
  const runState = (run) => {
    if (!run) return { ok: false, error: "bad_token" };
    if (run.revoked_at) return { ok: false, error: "revoked", message: "الرابط اتلغى من المطعم" };
    if (new Date(run.expires_at).getTime() <= now()) return { ok: false, error: "expired", message: "انتهت صلاحية الرابط — كلّم المطعم" };
    return { ok: true };
  };

  async function courierView(c, fn, { needLive = true } = {}) {
    const run = await runByToken(c.req.param("token"));
    if (!run) return c.json({ ok: false, error: "bad_token", message: "الرابط غير صالح" }, 404);
    /* الإلغاء بيقفل الباب على طول — المدير لغى الرابط يعني مش عايز الشخص ده
       يسجّل حاجة. أما الانتهاء بالوقت، «تم التسليم» بيعدّي منه: المندوب ممكن
       يكون اتأخر ساعة في الزحمة، ومنعه معناه إن الطلب يفضل «في الطريق» للأبد
       والعميل ياخد رسالة غلط. */
    if (run.revoked_at) return c.json({ ok: false, error: "revoked", message: "الرابط اتلغى من المطعم", done: false }, 410);
    /* بعد التسليم التوكن ميّت: من غير الشرط ده كان أي حد معاه الرابط يقدر
       يرجّع الطلب لـ«في الطريق» بعد ما اتسلّم (اتكشف في اختبار ٢١/٩). */
    if (needLive && run.delivered_at) {
      return c.json({ ok: false, error: "done", message: "الطلب اتسجّل متسلّم خلاص", done: true }, 410);
    }
    const st = runState(run);
    if (needLive && !st.ok) return c.json({ ...st, done: false }, 410);
    const b = await c.req.json().catch(() => ({}));
    return fn({ run, b: b || {} });
  }

  app.get("/api/d/:token", async (c) => {
    const run = await runByToken(c.req.param("token"));
    if (!run) return c.json({ ok: false, error: "bad_token", message: "الرابط غير صالح" }, 404);
    const st = runState(run);
    if (!st.ok && !run.delivered_at) return c.json({ ...st, done: false }, 410);
    const sp = shop();
    const row = sp ? await sp.getOrderRow(run.order_no) : null;
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (!run.opened_at) await pool.query("UPDATE dl_ext_runs SET opened_at=NOW() WHERE id=$1 AND opened_at IS NULL", [run.id]).catch(() => {});
    const addr = (row.address && typeof row.address === "object") ? row.address : {};
    const cust = row.customer && typeof row.customer === "object" ? row.customer : {};
    const phone = localPhone(row.phone_norm || cust.phone);
    const lat = num(addr.latitude ?? addr.lat), lng = num(addr.longitude ?? addr.lng);
    const stage = run.delivered_at ? "delivered" : run.arrived_at ? "arrived" : run.started_at ? "started" : "new";
    return c.json({
      ok: true, done: Boolean(run.delivered_at), stage,
      orderNo: row.order_no,
      total: Number(row.total) || 0,
      prepaid: true, prepaidNote: PREPAID_NOTE,
      /* الحد الأدنى من بيانات العميل: اسمه، جواله مقنّع + زرار اتصال، دبوسه،
         عنوانه، وملاحظات التوصيل. مفيش أصناف ولا أسعار ولا طلبات تانية. */
      customer: { name: cust.name || "العميل", phoneMasked: maskPhone(phone), phoneTel: phone || null },
      address: { text: readableAddress({ ...addr, leave_at_door: false }, { withPin: false }),
                 notes: clean(addr.delivery_notes, 300), leaveAtDoor: leaveAtDoor(addr), doorNote: DOOR_NOTE,
                 lat, lng },
      store: { name: "فريش كاتس", lat: STORE_LAT(), lng: STORE_LNG() },
      courierNotes: courierNotes(row),
      startedAt: iso(run.started_at), arrivedAt: iso(run.arrived_at), deliveredAt: iso(run.delivered_at),
      receivedBy: run.received_by || null,
      expiresAt: iso(run.expires_at),
      pingEverySec: 20,
    });
  });

  /* «ابدأ التوصيل» = مسك الطلب وتحرّك — يعني نفس معنى زرار المدير «المندوب
     الخارجي استلم». فبنحرّك الشحنة لـpicked والطلب لـon_the_way، وساعتها
     صفحة تتبّع العميل بتقول «طلبك في الطريق إليك» زي أي كابتن لاجلك بالظبط. */
  app.post("/api/d/:token/start", (c) => courierView(c, async ({ run, b }) => {
    const at = new Date(now()).toISOString();
    const lat = num(b.lat), lng = num(b.lng);
    if (lat != null && lng != null) await recordPing(run.shipment_id, run.order_no, { lat, lng, source: "ext" });
    await pool.query("UPDATE dl_ext_runs SET started_at = COALESCE(started_at, NOW()) WHERE id=$1", [run.id]);
    await pool.query(
      `UPDATE dl_shipments SET status = CASE WHEN status IN ('pending','assigned','created') THEN 'picked' ELSE status END,
              picked_at = COALESCE(picked_at, $2), events = events || $3::jsonb, updated_at=NOW() WHERE id=$1`,
      [run.shipment_id, at, J([{ at, provider: "external", event: "picked", by: run.courier_name || "مندوب خارجي",
                                 via: "ext_link", note: "ابدأ التوصيل من رابط المندوب" }])]).catch(() => {});
    try {
      const sp = shop();
      const row = sp ? await sp.getOrderRow(run.order_no) : null;
      if (row && ["courier_requested", "courier_assigned", "courier_cancelled", "accepted", "pos_created"].includes(row.status)) {
        await sp.setStatus(run.order_no, "on_the_way", {
          note: `مندوب خارجي${run.courier_name ? ` (${run.courier_name})` : ""} بدأ التوصيل من رابطه`,
          from: row.status, source: "portal" });
      }
    } catch (e) { log.error(`[courierlive] start ${run.order_no} status failed: ${e?.message || e}`); }
    try {
      emit("courier_manual", { orderNo: run.order_no, source: "staff", ok: true,
        summary: "المندوب الخارجي بدأ التوصيل", data: { stage: "picked", provider: "external", via: "ext_link" } });
    } catch {}
    try { portal()?.scheduleRefresh?.(run.order_no); } catch {}
    return c.json({ ok: true, stage: "started" });
  }));

  app.post("/api/d/:token/ping", (c) => courierView(c, async ({ run, b }) => {
    const lat = num(b.lat), lng = num(b.lng), acc = num(b.acc);
    if (lat == null || lng == null) return c.json({ ok: false, error: "bad_point" }, 400);
    if (acc != null && acc > PING_MAX_ACC_M) return c.json({ ok: true, skipped: "accuracy" });
    const t = now();
    if (t - (pingGate.get(run.id) || 0) < PING_MIN_MS) return c.json({ ok: true, skipped: "throttled" });
    pingGate.set(run.id, t);
    const saved = await recordPing(run.shipment_id, run.order_no, { lat, lng, acc, source: "ext" });
    if (saved) {
      await pool.query("UPDATE dl_ext_runs SET pings = pings + 1, last_at = NOW(), started_at = COALESCE(started_at, NOW()) WHERE id=$1", [run.id]);
      /* نفس العمود اللي البوابة والتتبع بيقرأوا منه — يعني المندوب الخارجي
         بيبان في كل مكان بيبان فيه كابتن لاجلك، من غير شاشة خاصة. */
      await pool.query(
        `UPDATE dl_shipments SET driver = COALESCE(driver,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
        [run.shipment_id, J({ location: { latitude: lat, longitude: lng }, source: "external",
                              name: run.courier_name || null, phone: run.courier_phone || null })]).catch(() => {});
    }
    return c.json({ ok: true, saved });
  }));

  app.post("/api/d/:token/arrived", (c) => courierView(c, async ({ run, b }) => {
    const lat = num(b.lat), lng = num(b.lng);
    if (lat != null && lng != null) await recordPing(run.shipment_id, run.order_no, { lat, lng, source: "ext" });
    await pool.query("UPDATE dl_ext_runs SET arrived_at = COALESCE(arrived_at, NOW()) WHERE id=$1", [run.id]);
    await pool.query(
      `UPDATE dl_shipments SET events = events || $2::jsonb, updated_at=NOW() WHERE id=$1`,
      [run.shipment_id, J([{ at: new Date(now()).toISOString(), provider: "external", event: "ext_at_customer",
                             by: run.courier_name || "مندوب خارجي" }])]).catch(() => {});
    try {
      emit("courier_manual", { orderNo: run.order_no, source: "staff", ok: true,
        summary: "المندوب الخارجي وصل للعميل", data: { stage: "at_customer", provider: "external", via: "ext_link" } });
    } catch {}
    try { portal()?.scheduleRefresh?.(run.order_no); } catch {}
    return c.json({ ok: true, stage: "arrived" });
  }));

  /* «تم التسليم» — نفس الأثر بالظبط بتاع زرار المدير في البوابة:
     الشحنة delivered + الطلب delivered + حدث على ناقل الطلب. الفرق الوحيد
     إن اللي ضغط هو المندوب، فالمصدر متسجّل ext_link والتوكن بيموت بعدها. */
  app.post("/api/d/:token/delivered", (c) => courierView(c, async ({ run, b }) => {
    const sp = shop(), dl = delivery();
    if (!sp || !dl) return c.json({ ok: false, error: "unavailable" }, 503);
    if (run.delivered_at) return c.json({ ok: true, already: true, stage: "delivered" });
    const lat = num(b.lat), lng = num(b.lng);
    if (lat != null && lng != null) await recordPing(run.shipment_id, run.order_no, { lat, lng, source: "ext" });
    const receivedBy = clean(b.receivedBy, 80), note = clean(b.note, 200);
    const at = new Date(now()).toISOString();
    await pool.query(
      `UPDATE dl_ext_runs SET delivered_at = NOW(), received_by = $2, note = $3, arrived_at = COALESCE(arrived_at, NOW()) WHERE id=$1`,
      [run.id, receivedBy, note]);
    await pool.query(
      `UPDATE dl_shipments SET status='delivered',
              picked_at = COALESCE(picked_at, $2), delivered_at = COALESCE(delivered_at, $2),
              events = events || $3::jsonb, updated_at=NOW() WHERE id=$1`,
      [run.shipment_id, at, J([{ at, provider: "external", event: "delivered", by: run.courier_name || "مندوب خارجي",
                                 via: "ext_link", note: receivedBy ? `استلمه ${receivedBy}` : note }])]);
    try {
      const row = await sp.getOrderRow(run.order_no);
      if (row && row.status !== "delivered") {
        await sp.setStatus(run.order_no, "delivered", {
          note: `مندوب خارجي${run.courier_name ? ` (${run.courier_name})` : ""} سجّل التسليم من رابطه${receivedBy ? ` — استلمه ${receivedBy}` : ""}`,
          from: row.status, source: "portal" });
      }
    } catch (e) { log.error(`[courierlive] delivered ${run.order_no} status failed: ${e?.message || e}`); }
    try {
      emit("courier_manual", { orderNo: run.order_no, source: "staff", ok: true,
        summary: "المندوب الخارجي سلّم الطلب", data: { stage: "delivered", provider: "external", via: "ext_link", note: receivedBy } });
    } catch {}
    try { portal()?.scheduleRefresh?.(run.order_no); } catch {}
    return c.json({ ok: true, stage: "delivered", deliveredAt: at });
  }, { needLive: false }));

  return { liveOf, recordPing, sweepTrails, refreshPosition, makeHandoff, handoffText, waUrl, ensureSchema };
}
