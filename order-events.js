/* ═══════════════════════════════════════════════════════════════════════════
   ORDER EVENTS — ناقل أحداث الطلب وتصنيف واحد (الخطة الرئيسية §٤-١، W1-01).

   - ORDER_EVENTS: الأسماء المسموحة بس (نفس أسماء ٠٢) — أي اسم تاني بيترفض.
   - bus: EventEmitter واحد في العملية. كل حدث بيتبعت على قناة "order_event"
     وكمان على قناة باسمه (مثلاً "order_paid").
   - emitOrder(): **عمرها ما ترمي** — لا sync ولا async. بترجع الحدث المنظّف
     أو null لو اترفض. الشكلين مقبولين:
       emitOrder("order_paid", { orderNo, source, actor, channel, ok, summary, data })
       emitOrder(orderNo, "order_paid", data)
   - المخزن: مشترك واحد (startEventStore) بيكتب في shop_order_events
     fire-and-forget. data بتتنضف: مفيش جوال كامل (5XXXXXXXX) ولا عنوان ولا أسرار.
   - مفيش أي side effect وقت الـimport — التشغيل من register() (W1-09).

   وقت rollover في Coolify الحدث ممكن يروح للحاوية القديمة، فأي مستهلك لازم
   يكون عنده استطلاع احتياطي بـsince من الجدول.
═══════════════════════════════════════════════════════════════════════════ */

import { EventEmitter } from "node:events";
import { ensureOrderColumns } from "./orders-schema.js";

export const ORDER_EVENTS = Object.freeze([
  "order_status",      // {from,to,note}            shop.setStatus
  "payment_execute",   //                            shop.js / pay.js
  "payment_check",     // {via,is_paid,mf_tx_status,mf_error_code}
  "order_paid",
  "order_expired",     // {executed}
  "pos_push",          // {ok,attempt,error,fallback} shop.createPosOrder
  "partner_fallback",
  "pos_ready",         // {source: pos/portal/timer, by}
  "portal_ack",        // {by}
  "courier_dispatch",  //                            delivery.js
  "courier_update",    // {status,driver_changed}
  // محطّتا المندوب (١٧ سبتمبر) — وقت واحد لكل طلب، بيتقاسوا لأداء الشركة
  "courier_arrived",   // {provider,raw_status,via}   delivery.js
  "courier_picked",    // {provider,raw_status,via}   delivery.js
  "courier_cancel",
  "courier_manual",
  "sla_alert",         // {code,level,notified}      shop.watchdog
  "notify_sent",       // {stage,channel,ok}         notify.orderStatusChanged
  "refund",            // {ok,amount}                orders_hub.js
  "staff_note",
  "staff_call",        // {outcome}
  "staff_action",      // {action}
]);
const EVENT_SET = new Set(ORDER_EVENTS);
export const isOrderEvent = (name) => typeof name === "string" && EVENT_SET.has(name);

/* سطر عربي افتراضي لو المُطلِق مابعتش summary */
export const DEFAULT_SUMMARY = Object.freeze({
  order_status: "تغيّرت حالة الطلب",
  payment_execute: "بدء الدفع",
  payment_check: "فحص حالة الدفع",
  order_paid: "تم الدفع",
  order_expired: "انتهت مهلة الدفع",
  pos_push: "إرسال الطلب لنقطة البيع",
  partner_fallback: "مسار بديل لنقطة البيع",
  pos_ready: "الطلب جاهز",
  portal_ack: "المطعم استلم الطلب",
  courier_dispatch: "طلب مندوب",
  courier_update: "تحديث المندوب",
  courier_arrived: "المندوب وصل المطعم",
  courier_picked: "المندوب استلم الطلب",
  courier_cancel: "إلغاء المندوب",
  courier_manual: "تحديث يدوي للمندوب",
  sla_alert: "تنبيه تأخير",
  notify_sent: "إشعار للعميل",
  refund: "استرجاع",
  staff_note: "ملاحظة من الفريق",
  staff_call: "مكالمة للعميل",
  staff_action: "إجراء من الفريق",
});

export const CHANNEL = "order_event";

export const bus = new EventEmitter();
bus.setMaxListeners(50);

/* ── التنظيف ─────────────────────────────────────────────────────────────── */

const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// جوال سعودي بأي شكل: 5XXXXXXXX / 05… / 9665… / +966 5… / 00966… (مع مسافات أو شرط)
const PHONE_RE = /(?<!\d)(?:(?:\+|00)?966[\s-]?|0)?5(?:[\s-]?\d){8}(?!\d)/g;
// أي مفتاح اسمه كده بيتشال بالكامل (جوال، عنوان، موقع، أسرار)
const DROP_KEY_RE = /phone|mobile|msisdn|whatsapp|address|addr|street|district|building|apartment|landmark|location|^lat$|^lng$|^lon$|latitude|longitude|coords?|email|password|passwd|secret|token|authorization|cookie|otp|card|cvv|iban/i;

export const MAX_SUMMARY = 300;
const MAX_STRING = 500;
const MAX_ARRAY = 50;
const MAX_KEYS = 40;
const MAX_DEPTH = 5;
const MAX_DATA_JSON = 8000;

// أرقام عربية/فارسية (٠-٩ / ۰-۹) → ASCII بنفس الطول (حرف بحرف) عشان المواضع تفضل زي ما هي
const toAsciiDigits = (s) => s.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 0xf));

export function maskPhones(s) {
  const src = String(s);
  const norm = toAsciiDigits(src);
  if (norm === src) {
    return src.replace(PHONE_RE, (m) => `***${m.replace(/\D/g, "").slice(-3)}`);
  }
  // فيه أرقام عربية: ندوّر على النسخة الـASCII ونستبدل في الأصل بنفس المواضع
  let out = "", last = 0;
  norm.replace(PHONE_RE, (m, offset) => {
    out += src.slice(last, offset) + `***${m.replace(/\D/g, "").slice(-3)}`;
    last = offset + m.length;
    return m;
  });
  return out + src.slice(last);
}

function cleanString(v, n = MAX_STRING) {
  let s = String(v).replace(CTRL_RE, "").replace(LONE_SURROGATE_RE, "");
  s = maskPhones(s);
  if (s.length > n) {
    s = s.slice(0, n);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  }
  return s;
}

function cleanValue(v, depth) {
  if (v == null) return null;
  if (typeof v === "string") return cleanString(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // رقم جوال متخزن كرقم (512345678 / 966512345678)
    const s = String(v);
    const m = maskPhones(s);
    return m === s ? v : m;
  }
  if (typeof v === "bigint") return cleanString(v.toString());
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v.slice(0, MAX_ARRAY)) {
      const c = cleanValue(x, depth + 1);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  if (typeof v === "object") {
    const out = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (n >= MAX_KEYS) break;
      if (DROP_KEY_RE.test(k)) continue;
      const c = cleanValue(x, depth + 1);
      if (c === undefined) continue;
      out[cleanString(k, 60)] = c;
      n++;
    }
    return out;
  }
  return undefined; // functions, symbols
}

/* data منظّفة وجاهزة لـJSONB (object دايماً، أو {} ) */
export function sanitizeData(data) {
  try {
    let d = data;
    if (d == null) return {};
    if (typeof d !== "object" || Array.isArray(d)) d = { value: d };
    const out = cleanValue(d, 0) || {};
    const json = JSON.stringify(out);
    if (json.length > MAX_DATA_JSON) return { truncated: true, size: json.length };
    return out;
  } catch {
    return { unserializable: true };
  }
}

function cleanShort(v, n) {
  if (v == null) return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = cleanString(v, n).trim();
  return s || null;
}

function normActor(actor) {
  if (!actor || typeof actor !== "object") return { id: null, name: null, role: null, ref: null };
  const raw = actor.id;
  const idNum = typeof raw === "number" ? raw : /^\d{1,9}$/.test(String(raw ?? "")) ? Number(raw) : null;
  return {
    id: Number.isInteger(idNum) && idNum >= 0 && idNum <= 2147483647 ? idNum : null,
    name: cleanShort(actor.name, 80),
    role: cleanShort(actor.role, 40),
    ref: idNum == null && raw != null ? cleanShort(raw, 60) : null,
  };
}

/* يبني الحدث المنظّف أو null لو مرفوض — مابترميش */
export function buildOrderEvent(name, opts = {}) {
  try {
    if (!isOrderEvent(name)) return null;
    const o = opts && typeof opts === "object" ? opts : {};
    const orderNo = cleanShort(o.orderNo, 64);
    if (!orderNo) return null;
    const actor = normActor(o.actor);
    const data = sanitizeData(o.data);
    if (actor.ref) data.actor_ref = actor.ref;
    const at = o.at instanceof Date && !Number.isNaN(o.at.getTime()) ? o.at : new Date();
    const auditRaw = Number(o.auditId ?? o.audit_id);
    return {
      orderNo,
      name,
      at: at.toISOString(),
      source: cleanShort(o.source, 40) || "system",
      channel: cleanShort(o.channel, 20),
      ok: typeof o.ok === "boolean" ? o.ok : null,
      actor: { id: actor.id, name: actor.name, role: actor.role },
      summary: cleanShort(o.summary, MAX_SUMMARY) || DEFAULT_SUMMARY[name],
      data,
      auditId: Number.isSafeInteger(auditRaw) && auditRaw > 0 ? auditRaw : null,
    };
  } catch {
    return null;
  }
}

/* ── الإطلاق ─────────────────────────────────────────────────────────────── */

let rejected = 0;
const warnedNames = new Set();

/* emitOrder(name, {orderNo, source, actor?, channel?, ok?, summary?, data})
   أو emitOrder(orderNo, name, data). مابترميش أبداً. */
export function emitOrder(a, b, c) {
  try {
    let name, opts;
    if (isOrderEvent(a)) {
      name = a;
      opts = b && typeof b === "object" ? b : {};
    } else if (isOrderEvent(b)) {
      name = b;
      const extra = c && typeof c === "object" && !Array.isArray(c) ? c : {};
      // لو data فيها مفاتيح الغلاف (source/ok/channel/actor) بنرفعها
      // ok/channel بيفضلوا جوّه data كمان (زي notify_sent {stage,channel,ok})
      const { source, actor, summary, auditId, data, ...rest } = extra;
      opts = {
        orderNo: a, source, ok: extra.ok, channel: extra.channel, actor, summary, auditId,
        data: data && typeof data === "object" ? { ...rest, ...data } : rest,
      };
    } else {
      rejected++;
      const bad = maskPhones(String(typeof b === "string" ? b : a)).slice(0, 40);
      if (!warnedNames.has(bad) && warnedNames.size < 50) {
        warnedNames.add(bad);
        try { console.error(`[order-events] unknown event name rejected: ${bad}`); } catch {}
      }
      return null;
    }
    const evt = buildOrderEvent(name, opts);
    if (!evt) { rejected++; return null; }
    safeDispatch(CHANNEL, evt);
    safeDispatch(name, evt);
    return evt;
  } catch {
    return null;
  }
}

function logListenerError(e) {
  try { console.error(`[order-events] listener threw: ${e?.message || e}`); } catch {}
}

/* بدل bus.emit: كل مستمع لوحده — مستمع خام (bus.on) بيرمي sync مايمنعش اللي بعده
   (زي المخزن)، ومستمع async بيرفض مايعملش unhandledRejection يوقّع العملية. */
function safeDispatch(channel, evt) {
  let fns;
  try { fns = bus.rawListeners(channel); } catch (e) { logListenerError(e); return; }
  for (const fn of fns) {
    try {
      const p = fn.call(bus, evt);
      if (p && typeof p.then === "function") p.then(undefined, logListenerError);
    } catch (e) {
      logListenerError(e);
    }
  }
}

/* اشتراك آمن: أي خطأ sync أو async في المستمع مابيوصلش للي أطلق الحدث
   ومابيوقفش باقي المستمعين. بيرجّع دالة إلغاء الاشتراك. */
export function subscribe(fn, name = CHANNEL) {
  if (typeof fn !== "function") return () => {};
  const wrapped = (evt) => {
    try {
      const p = fn(evt);
      if (p && typeof p.catch === "function") p.catch(logListenerError);
    } catch (e) {
      logListenerError(e);
    }
  };
  bus.on(name, wrapped);
  return () => bus.off(name, wrapped);
}

/* ── المخزن (shop_order_events) ─────────────────────────────────────────── */

export const EVENTS_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS shop_order_events (
    id          BIGSERIAL PRIMARY KEY,
    order_no    TEXT NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    name        TEXT NOT NULL,
    source      TEXT,
    channel     TEXT,
    ok          BOOLEAN,
    actor_id    INT,
    actor_name  TEXT,
    actor_role  TEXT,
    summary     TEXT,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    audit_id    BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS shop_order_events_order_idx ON shop_order_events(order_no, at DESC)`,
  `CREATE INDEX IF NOT EXISTS shop_order_events_name_idx ON shop_order_events(name, at DESC)`,
]);

export async function ensureEventsSchema(pool, log = console) {
  try {
    for (const sql of EVENTS_DDL) await pool.query(sql);
    return true;
  } catch (e) {
    try { log.error(`[order-events] ensure schema failed: ${e?.message || e}`); } catch {}
    return false;
  }
}

export const INSERT_SQL = `INSERT INTO shop_order_events
  (order_no, at, name, source, channel, ok, actor_id, actor_name, actor_role, summary, data, audit_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`;

export function insertParams(evt) {
  return [
    evt.orderNo, evt.at, evt.name, evt.source, evt.channel, evt.ok,
    evt.actor?.id ?? null, evt.actor?.name ?? null, evt.actor?.role ?? null,
    evt.summary, JSON.stringify(evt.data || {}), evt.auditId ?? null,
  ];
}

const MAX_INFLIGHT = 200;
const store = { pool: null, unsub: null, ready: null, inflight: 0, written: 0, failed: 0, dropped: 0 };

/* مشترك الحفظ: idempotent (نداء تاني بيرجّع نفس الاشتراك). مابيرميش. */
export function startEventStore(pool, { log = console, ensure = true } = {}) {
  try {
    if (!pool || typeof pool.query !== "function") return null;
    if (store.unsub && store.pool === pool) return store.ready;
    if (store.unsub) store.unsub();
    store.pool = pool;
    store.ready = ensure ? ensureEventsSchema(pool, log) : Promise.resolve(true);
    store.unsub = subscribe((evt) => persist(evt, log));
    return store.ready;
  } catch {
    return null;
  }
}

export function stopEventStore() {
  try { store.unsub?.(); } catch {}
  store.unsub = null;
  store.pool = null;
  store.ready = null;
}

export function eventStoreStats() {
  return { active: Boolean(store.unsub), inflight: store.inflight, written: store.written, failed: store.failed, dropped: store.dropped, rejected };
}

function persist(evt, log) {
  const pool = store.pool;
  if (!pool) return;
  if (store.inflight >= MAX_INFLIGHT) { store.dropped++; return; }
  store.inflight++;
  // فحص أخير: لو فضل أي رقم جوال بعد التنظيف (مستحيل نظرياً) مانخزنش data
  const params = insertParams(evt);
  if (/(?<!\d)5\d{8}(?!\d)/.test(toAsciiDigits(params[10]))) params[10] = "{}";
  // ضمان: الحدث بيتكتب بعد ما الـcaller يرجع (مش جوّه الـtick بتاعه)
  const run = async () => {
    try {
      await store.ready;
      await pool.query(INSERT_SQL, params);
      store.written++;
    } catch (e) {
      store.failed++;
      try { log.error(`[order-events] persist ${evt.name} ${evt.orderNo} failed: ${e?.message || e}`); } catch {}
    } finally {
      store.inflight--;
    }
  };
  setImmediate(() => { run().catch(() => {}); });
}

/* ── التسجيل (بيتربط في index.js في W1-09) ──────────────────────────────── */

export function register(app, ctx = {}, { migrateOrders = true } = {}) {
  const pool = ctx?.pool;
  const log = ctx?.log || console;
  try {
    const ready = startEventStore(pool, { log });
    // أعمدة shop_orders (§٤-٢) — بعد ensureSchema بتاع shop.js، ومابتوقفش الإقلاع
    if (migrateOrders && pool) {
      Promise.resolve(ready)
        .then(() => ensureOrderColumns(pool, { log }))
        .catch(() => {});
    }
  } catch (e) {
    try { log.error(`[order-events] register failed: ${e?.message || e}`); } catch {}
  }
  return { bus, emitOrder, subscribe, ORDER_EVENTS, stats: eventStoreStats };
}
