/* ═══════════════════════════════════════════════════════════════════════════
   PORTAL CORE — منطق بوابة المطعم الصافي (كاشير + مدير). مفيش قاعدة بيانات
   ولا شبكة هنا، فكل قاعدة بتتجرّب أوفلاين في portal*.test.mjs.

   - PIN: scrypt بملح لكل موظف (s1$salt$hash). الـPIN نفسه مابيتخزّنش.
   - التوكن: موقّع HMAC-SHA256، مدته ١٢ ساعة، وفيه بصمة (pv) من الـPIN/الدور
     الحاليين — تغيير الـPIN أو الدور أو حذف الموظف بيقفل التوكن القديم فوراً.
   - قفل المحاولات: ٥ غلطات من نفس الـIP ← قفل ١٠ دقايق.
   - تحويل صف الطلب لشكل العقد المشترك (orders feed) + الخط الزمني المدموج.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { STAGES, slaCheck } from "./shop.js";
import { leaveAtDoor } from "./couriers.js";

/* kitchen (١٩ سبتمبر) = شاشة المطبخ (/kitchen/) بس — قراية + «تقديم» محلي للمرحلة.
   ممنوع من كل مسارات البورتال (requirePortal بيرفضه إلا لو المسار قال kitchen). */
export const ROLES = Object.freeze(["cashier", "manager", "kitchen"]);
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/* شاشة المطبخ جهاز ثابت على الحيطة — ١٢ ساعة كانت هتطلّعها كل يوم وسط الشغل.
   التوكن برضه بيتقفل فوراً لو الرقم/الدور اتغيّر أو الموظف اتشال (البصمة). */
export const KITCHEN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOKEN_PREFIX = "portal:";

/* ── PIN ─────────────────────────────────────────────────────────────────── */

const SCRYPT = { N: 4096, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const b64u = (buf) => Buffer.from(buf).toString("base64url");

export const validPin = (pin) => /^\d{4,8}$/.test(String(pin ?? ""));

export function hashPin(pin, salt = crypto.randomBytes(12)) {
  const h = crypto.scryptSync(String(pin), salt, 32, SCRYPT);
  return `s1$${b64u(salt)}$${b64u(h)}`;
}

export function verifyPin(pin, stored) {
  try {
    const [v, s, h] = String(stored || "").split("$");
    if (v !== "s1" || !s || !h) return false;
    const want = Buffer.from(h, "base64url");
    const got = crypto.scryptSync(String(pin ?? ""), Buffer.from(s, "base64url"), want.length, SCRYPT);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/* مقارنة نصين بزمن ثابت (عن طريق sha256 عشان الطول مايسرّبش) */
export function safeEqual(a, b) {
  if (a == null || b == null) return false;
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* بصمة قصيرة: بتتغيّر لو الـPIN/الدور/الاسم اتغيّروا */
export const fingerprint = (...parts) =>
  crypto.createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|")).digest("base64url").slice(0, 12);

/* ── قائمة الموظفين (settings.portal.staff) ─────────────────────────────── */

export function normStaffList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const id = String(s.id || "").trim().slice(0, 40);
    const name = String(s.name || "").trim().slice(0, 60);
    const role = ROLES.includes(s.role) ? s.role : null;
    if (!id || !name || !role || ids.has(id) || s.active === false) continue;
    if (!String(s.pinHash || "").startsWith("s1$")) continue;
    ids.add(id);
    out.push({ id, name, role, pinHash: String(s.pinHash) });
  }
  return out;
}

/* الهويات اللي ينفع تدخل البوابة دلوقتي:
     - موظفين settings.portal.staff (كل واحد باسمه ودوره)
     - لو القائمة فاضية: الرقم المشترك (settings.shop.cashierPin) = كاشير
     - مفتاح الأدمن (ADMIN_PASSWORD/ADMIN_TOKEN) = مدير دايماً
   بترجّع {staff, sharedPin, adminKeys} — للمطابقة والتحقق من بصمة التوكن. */
export function identitiesFrom(settings = {}, env = {}) {
  const staff = normStaffList(settings?.portal?.staff);
  let sharedPin = null;
  if (!staff.length) {
    const p = settings?.shop?.cashierPin ?? settings?.cashierPin;
    if (p != null && String(p).trim()) sharedPin = String(p).trim();
    else if (env.PORTAL_REQUIRE_PIN !== "1") sharedPin = "1111"; // نفس افتراضي #delivery الحالي
  }
  const adminKeys = [env.ADMIN_PASSWORD, env.ADMIN_TOKEN].filter((k) => k && String(k).length >= 6);
  return { staff, sharedPin, adminKeys };
}

/* PIN → هوية (أو null). staffId اختياري لتحديد الموظف. */
export function matchLogin(ids, pin, staffId = null) {
  const p = String(pin ?? "").trim();
  if (!p) return null;
  for (const k of ids.adminKeys) {
    if (safeEqual(p, k)) return { id: "admin", name: "المالك", role: "manager", pv: fingerprint("admin", k) };
  }
  if (!validPin(p)) return null;
  const list = staffId ? ids.staff.filter((s) => s.id === String(staffId)) : ids.staff;
  for (const s of list) {
    if (verifyPin(p, s.pinHash)) return { id: s.id, name: s.name, role: s.role, pv: fingerprint(s.id, s.role, s.pinHash) };
  }
  if (!staffId && ids.sharedPin && safeEqual(p, ids.sharedPin)) {
    return { id: "cashier", name: "الكاشير", role: "cashier", pv: fingerprint("shared", ids.sharedPin) };
  }
  return null;
}

/* بصمة الهوية الحالية لتوكن (أو null لو الهوية ماعادتش موجودة) */
export function currentFingerprint(ids, sid, role) {
  if (sid === "admin") return role === "manager" && ids.adminKeys.length ? ids.adminKeys.map((k) => fingerprint("admin", k)) : [];
  if (sid === "cashier") return ids.sharedPin && role === "cashier" ? [fingerprint("shared", ids.sharedPin)] : [];
  const s = ids.staff.find((x) => x.id === sid);
  return s && s.role === role ? [fingerprint(s.id, s.role, s.pinHash)] : [];
}

/* ── التوكن ──────────────────────────────────────────────────────────────── */

export function signToken(user, secret, now = Date.now(), ttl = TOKEN_TTL_MS) {
  if (!secret) throw new Error("no_secret");
  const payload = { v: 1, sid: user.id, r: user.role, n: user.name, pv: user.pv, iat: now, exp: now + ttl };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/* بيرجّع payload أو null — مابيرميش */
export function verifyToken(token, secret, now = Date.now()) {
  try {
    if (!secret) return null;
    let t = String(token || "").trim();
    if (t.startsWith(TOKEN_PREFIX)) t = t.slice(TOKEN_PREFIX.length);
    const [body, sig, extra] = t.split(".");
    if (!body || !sig || extra !== undefined) return null;
    const want = crypto.createHmac("sha256", secret).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p?.v !== 1 || !p.sid || !ROLES.includes(p.r)) return null;
    if (!Number.isFinite(p.exp) || p.exp <= now) return null;
    return p;
  } catch {
    return null;
  }
}

export function tokenSecret(env = {}) {
  if (env.PORTAL_TOKEN_SECRET && String(env.PORTAL_TOKEN_SECRET).length >= 16) return String(env.PORTAL_TOKEN_SECRET);
  if (env.ADMIN_TOKEN) return crypto.createHmac("sha256", String(env.ADMIN_TOKEN)).update("fc-portal-token-v1").digest("base64url");
  return null;
}

/* ── قفل محاولات الدخول (في الذاكرة، لكل IP) ────────────────────────────── */

export function makeLoginLimiter({ maxFails = 5, lockMs = 10 * 60_000, windowMs = 15 * 60_000, maxKeys = 5000 } = {}) {
  const m = new Map();
  const slot = (key, now) => {
    let s = m.get(key);
    if (!s || (now - s.first > windowMs && !(s.lockedUntil > now))) {
      s = { fails: 0, first: now, lockedUntil: 0 };
      if (m.size >= maxKeys) m.clear();
      m.set(key, s);
    }
    return s;
  };
  return {
    check(key, now = Date.now()) {
      const s = m.get(key);
      if (s && s.lockedUntil > now) return { locked: true, retryAfterSec: Math.ceil((s.lockedUntil - now) / 1000) };
      return { locked: false };
    },
    fail(key, now = Date.now()) {
      const s = slot(key, now);
      s.fails++;
      if (s.fails >= maxFails) { s.lockedUntil = now + lockMs; s.fails = 0; s.first = now; }
      return { locked: s.lockedUntil > now, remaining: Math.max(0, maxFails - s.fails) };
    },
    success(key) { m.delete(key); },
    size: () => m.size,
  };
}

export function clientIp(header) {
  const cf = header("cf-connecting-ip");
  if (cf) return String(cf).trim().slice(0, 64);
  const xff = header("x-forwarded-for");
  if (xff) return String(xff).split(",")[0].trim().slice(0, 64);
  return header("x-real-ip") || "unknown";
}

/* ── الطلب → شكل العقد ───────────────────────────────────────────────────── */

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/* delivery_quote->'farZone' زي ما التسعيرة سجّلته → {km, extraKm, surcharge}
   أو null. مصدر واحد للرقم: اللي العميل شافه ودفعه. */
export function farZoneOf(v) {
  let f = v;
  if (typeof f === "string") { try { f = JSON.parse(f); } catch { f = null; } }
  if (!f || typeof f !== "object" || !(Number(f.extraKm) > 0)) return null;
  return { km: num(f.km), extraKm: Number(f.extraKm), surcharge: Number(f.surcharge) || 0 };
}
const iso = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/* أول وقت لحالة معيّنة في history */
export function historyAt(history, status) {
  if (!Array.isArray(history)) return null;
  let best = null;
  for (const h of history) {
    if (!h || h.status !== status) continue;
    const t = iso(h.at);
    if (t && (!best || t < best)) best = t;
  }
  return best;
}

/* مكان الكابتن: الشكل جوّه driver.location مش متحقق منه، فبنقبل كل الأشكال المعقولة */
export function driverLatLng(driver) {
  if (!driver || typeof driver !== "object") return { lat: null, lng: null };
  const cands = [driver.location, driver.position, driver.coords, driver.current_location, driver];
  for (const c of cands) {
    if (c == null) continue;
    let lat = null, lng = null;
    if (Array.isArray(c) && c.length >= 2) { lat = num(c[0]); lng = num(c[1]); }
    else if (typeof c === "string" && /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(c.trim())) {
      const [a, b] = c.split(","); lat = num(a); lng = num(b);
    } else if (typeof c === "object") {
      lat = num(c.lat ?? c.latitude);
      lng = num(c.lng ?? c.lon ?? c.long ?? c.longitude);
    }
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) return { lat, lng };
  }
  return { lat: null, lng: null };
}

export function localPhone(v) {
  const d = String(v || "").replace(/\D/g, "").replace(/^00966/, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? `0${d}` : (d ? String(v) : null);
}

/* اسم مرحلة للفريق (مش للعميل) */
export function stageLabel(row) {
  const ready = Boolean(row.pos_ready_at);
  const delivery = row.option === "delivery";
  switch (row.status) {
    case "paid": return "مدفوع — بيتبعت لنقطة البيع";
    case "pos_created": return "طلب جديد — اقبله من نقطة البيع";
    case "accepted":
      if (!ready) return "بيتجهّز";
      return delivery ? "جاهز — مستني المندوب" : "جاهز — مستني العميل يستلم";
    case "courier_requested": return ready ? "جاهز — بندوّر على كابتن" : "بندوّر على كابتن";
    case "courier_assigned": return "الكابتن جاي للمطعم";
    case "on_the_way": return "مع الكابتن في الطريق للعميل";
    case "delivered": return "تم التوصيل";
    case "collected": return "العميل استلم";
    case "paid_pos_failed": return "مدفوع — فشل الإرسال لنقطة البيع";
    case "rejected_refunded": return "مرفوض — المبلغ اترجع";
    case "refund_failed": return "فشل الاسترجاع — للإدارة";
    case "courier_cancelled": return "تعثّر التوصيل";
    case "expired": return "انتهت مهلة الدفع";
    default: return STAGES[row.status]?.label || String(row.status || "");
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   أسماء الأصناف في الشاشة (١٧ سبتمبر ٢٠٢٦ — بلاغ عمر: «بعضها بيظهر برقم»).

   السلة اللي جاية من المتصفح فيها product_id وكمية وسعر بس — الاسم مابيوصلش.
   قبل كده الشاشة كانت بتكتب «منتج ١٠٥»، وده رقم مالوش أي معنى للكاشير.
   الحل بيشتغل على ٣ طبقات:
     ١) الاسم بيتحل **وقت الشيك أوت** من قايمة تاب سينس ويتخزّن في الطلب
        (product-names.js) — فالتقارير والمطبخ والبورتال يشوفوه من غير شبكة.
     ٢) الطلبات القديمة اتعمل لها backfill بنفس المحلّل.
     ٣) والبورتال بيحلّ أي اسم ناقص وقت القراية كمان (حزام وحمّالة).
   ولو الصنف فعلاً مجهول (اتشال من القايمة مثلاً) بيظهر «صنف #١٠٥» — واضح
   إنه مرجع داخلي، مش اسم أكل.

   الباقة: سطورها في الداتابيز أصناف حقيقية متوسّعة. الشاشة بتلمّهم تحت
   عنوان واحد باسم الباقة، ومكوّناتها متزاحة تحته (level = 1).
═══════════════════════════════════════════════════════════════════════════ */
export const UNKNOWN_ITEM = (id) => (id == null || id === "" ? "صنف غير معروف" : `صنف #${id}`);

/* اسم سطر واحد: الاسم + الوزن/الحجم («كفتة مشوية بالوزن — كيلو») */
export function lineName(it) {
  const raw = String(it?.name ?? it?.product_name ?? "").trim();
  const base = (raw || UNKNOWN_ITEM(it?.product_id ?? null)).slice(0, 120);
  const variant = String(it?.variant_name ?? "").trim();
  return variant ? `${base} — ${variant.slice(0, 40)}` : base;
}

/* سطر باسم حقيقي؟ (عكسه = لسه محتاج يتحل من القايمة) */
export const hasRealName = (it) =>
  Boolean(String(it?.name ?? it?.product_name ?? "").trim());

const lineNote = (it) => {
  const raw = it?.note ?? it?.notes ?? it?.comment ?? it?.customer_note ?? null;
  return raw ? String(raw).slice(0, 200) : null;
};

export function itemsOf(items) {
  if (!Array.isArray(items)) return [];
  const list = items.slice(0, 100);
  const out = [];
  const doneBundles = new Set();
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const bl = it.bundle_line != null ? String(it.bundle_line) : null;
    /* سطور الباقة: عنوان واحد + المكوّنات تحته. المفتاح bundle_line (سطر
       السلة)، ولو مش موجود بنرجع لـ bundle (اسم الباقة) عشان طلبات قديمة. */
    if (it.bundle || it.bundle_name) {
      const key = bl || `b:${it.bundle || it.bundle_name}`;
      if (doneBundles.has(key)) continue;
      doneBundles.add(key);
      const parts = list.filter((x) => x && (bl ? String(x.bundle_line) === bl
        : (x.bundle || x.bundle_name) && String(x.bundle || x.bundle_name) === String(it.bundle || it.bundle_name)));
      const qty = num(it.bundle_qty) ?? 1;
      out.push({
        name: String(it.bundle_name || it.bundle || "باقة").slice(0, 120),
        qty, note: null, kind: "bundle", level: 0,
      });
      for (const p of parts) {
        const raw = num(p.qty ?? p.quantity) ?? 1;
        // كمية السطر متخزّنة مضروبة في عدد الباقات — بنرجّعها «لكل باقة»
        const per = qty > 1 && raw % qty === 0 ? raw / qty : raw;
        out.push({ name: lineName(p), qty: per, note: lineNote(p), kind: "component", level: 1 });
      }
      continue;
    }
    out.push({ name: lineName(it), qty: num(it.qty ?? it.quantity) ?? 1, note: lineNote(it), kind: "item", level: 0 });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   محطّات المندوب (١٧ سبتمبر ٢٠٢٦ — طلب عمر: «لازم يتسجّل إن المندوب وصل
   المطعم وإنه أخد الطلب — الاتنين ناقصين عشان نقيس أداء الشركة»).

   لاجلك بتبعت الحالتين فعلاً: «Reached Shop» = وصل المطعم، و«Order Picked /
   Shipped» = استلم. قبل كده الاتنين كانوا بيتلموا في حالة واحدة موحّدة
   (assigned/picked) فالفرق بينهم كان بيضيع. دلوقتي الوقتين متخزّنين في
   dl_shipments.arrived_at / picked_at وبيتحسب منهم:
     الأكل جاهز → المندوب وصل   (سالب = وصل قبل ما الأكل يجهز — ده استنّى علينا)
     وصل        → استلم         (كام دقيقة قعد في المطعم)
     استلم      → اتوصّل        (الطريق للعميل)
═══════════════════════════════════════════════════════════════════════════ */
const minsBetween = (a, b) => {
  const t1 = a ? new Date(a).getTime() : NaN, t2 = b ? new Date(b).getTime() : NaN;
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  const m = (t2 - t1) / 60_000;
  return Math.abs(m) > 720 ? null : Math.round(m * 10) / 10;
};
export function courierDurations(r = {}) {
  const readyAt = r.pos_ready_at || null;
  const arrived = r.ship_arrived_at || null;
  const picked = r.ship_picked_at || null;
  const delivered = r.ship_status === "delivered" ? (r.ship_updated_at || null) : null;
  return {
    readyToArrivedMin: minsBetween(readyAt, arrived),
    arrivedToPickedMin: minsBetween(arrived, picked),
    pickedToDeliveredMin: minsBetween(picked, delivered),
    // وصل قبل ما الأكل يجهز؟ (المندوب استنّى المطعم، مش العكس)
    arrivedBeforeReady: readyAt && arrived ? new Date(arrived) < new Date(readyAt) : null,
  };
}

/* صف (shop_orders + آخر شحنة) → طلب البوابة */
export function toPortalOrder(r, slaCfg = {}, now = Date.now()) {
  const addr = r.address && typeof r.address === "object" ? r.address : null;
  const cust = r.customer && typeof r.customer === "object" ? r.customer : {};
  const sla = slaCheck(r, slaCfg, now);
  const drv = r.ship_driver && typeof r.ship_driver === "object" ? r.ship_driver : null;
  const pos = driverLatLng(drv);
  const items = itemsOf(r.items);
  return {
    orderNo: r.order_no,
    status: r.status,
    stageLabel: stageLabel(r),
    option: r.option,
    total: num(r.total) ?? 0,
    subtotal: num(r.subtotal) ?? 0,
    deliveryFee: num(r.delivery_fee) ?? 0,
    /* «توصيل بعيد»: العميل بره النطاق العادي ووافق على رسوم مسافة إضافية.
       الكاشير لازم يشوفها على الكارت — المشوار أطول والمندوب هياخد وقت. */
    farZone: farZoneOf(r.far_zone),
    // عنوان الباقة مش صنف — المكوّنات تحته هي الأكل الحقيقي
    itemsCount: items.reduce((a, x) => a + (x.kind === "bundle" ? 0 : Number(x.qty) || 0), 0),
    items,
    notes: r.notes || null,
    customer: { name: cust.name || null, phone: localPhone(r.phone_norm || cust.phone) },
    address: r.option === "delivery" && addr ? {
      area: addr.area || null, street: addr.street || null, building: addr.building || null,
      floor: addr.floor || null, apartment: addr.apartment || null, landmark: addr.landmark || null,
      leaveAtDoor: leaveAtDoor(addr),
      lat: num(addr.latitude ?? addr.lat), lng: num(addr.longitude ?? addr.lng),
    } : null,
    paidWith: r.pay_gateway || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    paidAt: historyAt(r.history, "paid"),
    acceptedAt: iso(r.accepted_at) || historyAt(r.history, "accepted"),
    readyAt: iso(r.pos_ready_at),
    ackAt: iso(r.portal_ack_at),
    ackBy: r.portal_ack_by || null,
    courier: r.ship_status ? {
      status: r.ship_status,
      name: drv?.name || null,
      phone: drv?.phone ? localPhone(drv.phone) : null,
      lat: pos.lat, lng: pos.lng,
      updatedAt: iso(r.ship_updated_at),
      provider: r.ship_provider || null,
      ref: r.ship_ref || null,
      assigned: Boolean(r.ship_dispatch?.assigned) || Boolean(drv?.name),
      /* محطتا المندوب (١٧ سبتمبر — طلب عمر عشان نقيس أداء الشركة) */
      arrivedAt: iso(r.ship_arrived_at),
      pickedAt: iso(r.ship_picked_at),
      ...courierDurations(r),
    } : null,
    sla: { level: sla.level || 0, code: sla.code || null, message: sla.message || null },
    posOrderId: r.pos_order_id || null,
    isTest: r.is_test === true,
  };
}

/* بصمة التغيير: الدقايق جوّه رسالة الـSLA بتتغيّر كل دقيقة، فمش جزء من البصمة */
export function orderSignature(o) {
  const { sla, ...rest } = o || {};
  return JSON.stringify([rest, sla?.level || 0, sla?.code || null]);
}

/* ── SSE ─────────────────────────────────────────────────────────────────── */

export function sseFrame(event, data, id) {
  const lines = [];
  if (id != null) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const l of String(payload).split(/\r?\n/)) lines.push(`data: ${l}`);
  return lines.join("\n") + "\n\n";
}

export const SSE_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  "Connection": "keep-alive",
});

/* ── الخط الزمني ─────────────────────────────────────────────────────────── */

const SHIP_LABEL = {
  created: "اتطلب مندوب من شركة التوصيل",
  poll: "تحديث حالة المندوب",
  webhook: "تحديث من شركة التوصيل",
  cancel: "اتلغى المندوب",
  cancel_failed: "فشل إلغاء المندوب",
  handoff: "اتدخّل الطلب يدوياً على لوحة الشركة",
  assigned: "اتعيّن كابتن (يدوي)",
  picked: "الكابتن استلم (يدوي)",
  delivered: "اتوصّل (يدوي)",
  cancelled: "اتلغى التوصيل (يدوي)",
};
const COURIER_STATUS_AR = {
  pending: "لسه مفيش كابتن", assigned: "اتعيّن كابتن", picked: "الكابتن استلم الطلب",
  delivered: "اتوصّل", cancelled: "اتلغى",
};
const APPROVAL_AR = {
  accepted: "الكاشير قبل الطلب", pickup_ready: "الكاشير سجّل «جاهز»", delivered: "نقطة البيع: تم التوصيل",
  rejected: "الكاشير رفض الطلب", cancelled: "الطلب اتلغى في نقطة البيع",
};
const ALERT_AR = {
  "staff:new_order": "رسالة للإدارة: طلب جديد",
  "staff:pos_failed": "رسالة للإدارة: فشل إرسال الطلب لنقطة البيع",
};
const SLA_CODE_AR = {
  pos_stuck: "ما وصلش نقطة البيع", never_accepted: "ما اتقبلش — استرجاع تلقائي", accept_breach: "محدش قبل الطلب",
  accept_late: "القبول متأخر", handoff_breach: "ما اتدخّلش لشركة التوصيل", handoff_late: "إدخال التوصيل متأخر",
  pickup_breach: "الكابتن ما استلمش", pickup_late: "الكابتن متأخر", deliver_breach: "ما وصلش العميل",
  deliver_late: "التوصيل متأخر", refund_failed: "فشل الاسترجاع", delivery_failed: "تعثّر التوصيل",
};
const PUSH_KIND_AR = {
  new: "إشعار للبوابة: طلب جديد", pos_failed: "إشعار للبوابة: فشل نقطة البيع",
  courier_assigned: "إشعار للبوابة: اتعيّن كابتن", courier_picked: "إشعار للبوابة: الكابتن استلم",
  courier_arrived: "إشعار للبوابة: المندوب وصل المطعم",
  delivered: "إشعار للبوابة: اتوصّل",
};
const ACTION_AR = {
  courier_request: "طلب مندوب من البوابة", courier_cancel: "إلغاء المندوب من البوابة",
  ack: "شاف الطلب في البوابة", handed_to_courier: "سلّم الطلب للمندوب",
  kitchen_prep: "المطبخ: بدأ التحضير", kitchen_ready: "المطبخ: الطلب جاهز ✅",
};

/* بيشيل أي بيانات خام/حساسة من data قبل ما توصل الشاشة */
const DROP_DATA = /resp|raw|payload|phone|mobile|address|location|lat|lng|token|secret|authorization|headers/i;
function safeData(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(d)) {
    if (n >= 20 || DROP_DATA.test(k)) continue;
    if (v == null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
    else continue;
    n++;
  }
  return out;
}

function evLabel(e) {
  const d = e.data || {};
  switch (e.name) {
    case "order_status": return `الحالة: ${d.to ? stageLabel({ status: d.to }) : "—"}`; // صياغة الفريق، مش رسالة العميل
    case "pos_push": return e.ok === false ? "فشل إرسال الطلب لنقطة البيع" : e.ok ? "الطلب نزل نقطة البيع" : (e.summary || "إرسال لنقطة البيع");
    case "pos_ready": return d.source === "portal" ? "اتسجّل «جاهز» من البوابة" : "الطلب جاهز (نقطة البيع)";
    case "sla_alert": return `تنبيه تأخير (${d.level ?? "?"}): ${SLA_CODE_AR[d.code] || d.code || ""}`.trim();
    case "notify_sent": return `إشعار للعميل (${d.channel || e.channel || "—"})${e.ok === false ? " — ما وصلش" : ""}`;
    case "courier_update": return d.status ? `المندوب: ${COURIER_STATUS_AR[d.status] || d.status}` : (e.summary || "تحديث المندوب");
    case "courier_arrived": return "🏪 المندوب وصل المطعم";
    case "courier_picked": return "📦 المندوب استلم الطلب";
    case "staff_action": return ACTION_AR[d.action] ? `${ACTION_AR[d.action]}${e.actor_name ? ` — ${e.actor_name}` : ""}` : (e.summary || "إجراء من الفريق");
    default: return e.summary || e.name;
  }
}

/* الدمج: كل مصدر بيتحوّل لـ{at,type,label_ar,source,data}، ترتيب زمني تصاعدي.
   srcs = { order, events, shipments, webhooks, pushLog, audit } */
export function buildTimeline(srcs = {}) {
  const out = [];
  const push = (at, type, label_ar, source, data = {}) => {
    const t = iso(at);
    if (t) out.push({ at: t, type, label_ar, source, data });
  };
  const o = srcs.order || {};
  const events = Array.isArray(srcs.events) ? srcs.events : [];

  if (o.created_at) push(o.created_at, "created", "العميل بدأ الطلب", "shop", { option: o.option || null });

  // تغييرات الحالة: من الحدث لو موجود، ومن history لو الحدث ضاع (من غير تكرار)
  const statusEvents = events.filter((e) => e.name === "order_status");
  const hist = Array.isArray(o.history) ? o.history : [];
  for (const h of hist) {
    if (!h || !h.status || h.status === "pending_payment") continue;
    const t = iso(h.at);
    if (!t) continue;
    const dup = statusEvents.some((e) => e.data?.to === h.status && Math.abs(new Date(iso(e.at)).getTime() - new Date(t).getTime()) <= 10_000);
    if (dup) continue;
    push(t, "status", `الحالة: ${stageLabel({ status: h.status, option: o.option })}`, "shop", { to: h.status, note: h.note ? String(h.note).slice(0, 200) : null });
  }

  // تحديث المندوب بيتسجّل مرتين: حدث courier_update + سطر في dl_shipments.events — نسيب سطر الشحنة
  const shipStatusAt = [];
  for (const sh of srcs.shipments || []) {
    for (const x of Array.isArray(sh.events) ? sh.events : []) {
      const t = x && x.status ? iso(x.at) : null;
      if (t) shipStatusAt.push([String(x.status), new Date(t).getTime()]);
    }
  }
  for (const e of events) {
    const portalDup = (e.name === "staff_action" && e.data?.via === "portal") || e.name === "portal_ack";
    if (portalDup && (srcs.audit || []).length) continue; // سجل البوابة أدق (فيه الاسم والدور)
    if (e.name === "courier_update" && e.data?.status) {
      const t = new Date(iso(e.at) || 0).getTime();
      if (shipStatusAt.some(([st, at]) => st === String(e.data.status) && Math.abs(at - t) <= 60_000)) continue;
    }
    push(e.at, e.name, evLabel(e), e.source || "system", {
      ...safeData(e.data), ok: e.ok ?? null, actor: e.actor_name || null,
    });
  }

  for (const sh of srcs.shipments || []) {
    const evs = Array.isArray(sh.events) ? sh.events : [];
    for (const x of evs) {
      if (!x) continue;
      const kind = String(x.event || "event");
      let label = SHIP_LABEL[kind] || `شركة التوصيل: ${kind}`;
      if ((kind === "poll" || kind === "webhook") && x.status) label = `المندوب: ${COURIER_STATUS_AR[x.status] || x.status}`;
      push(x.at, `courier_${kind}`, label, sh.provider === "manual" ? "staff" : "courier", {
        provider: x.provider || sh.provider || null, status: x.status || null, by: x.by || null,
        ref: x.ref || null, fee: x.fee ?? null, refund: x.refund ?? null,
        error: x.error ? String(x.error).slice(0, 200) : null,
      });
    }
  }

  let lastApproval = null;
  for (const w of srcs.webhooks || []) {
    const a = w.approval ? String(w.approval) : null;
    if (!a || a === lastApproval) continue; // نفس الحالة متكررة من order-paid/order-updated
    lastApproval = a;
    push(w.received_at, "pos_webhook", APPROVAL_AR[a] || `نقطة البيع: ${a}`, "tabsense", { approval: a, event: w.event || null });
  }

  const alerts = o.alerts && typeof o.alerts === "object" ? o.alerts : {};
  for (const [k, at] of Object.entries(alerts)) {
    let label = ALERT_AR[k];
    if (!label) {
      const m = /^(.+):(\d)$/.exec(k);
      if (m) label = `تنبيه تأخير (${m[2]}): ${SLA_CODE_AR[m[1]] || m[1]}${Number(m[2]) >= 2 ? " — رسالة للإدارة" : ""}`;
    }
    push(at, "staff_alert", label || `تنبيه: ${k}`, "alerts", { key: k });
  }

  for (const p of srcs.pushLog || []) {
    const kind = String(p.kind || "");
    const label = PUSH_KIND_AR[kind] || (kind.startsWith("sla:") ? `إشعار للبوابة: تأخير (${kind.split(":").slice(1).join(":")})` : `إشعار للبوابة: ${kind}`);
    push(p.at, "portal_push", label, "portal", { kind, sent: p.sent ?? null, of: p.of ?? null });
  }

  for (const a of srcs.audit || []) {
    push(a.at, `portal_${a.action}`, `${ACTION_AR[a.action] || a.action} — ${a.staff_name || a.staff_id || "؟"}${a.ok === false ? " (فشل)" : ""}`,
      "portal", { staffId: a.staff_id || null, role: a.role || null, ok: a.ok ?? null, ...safeData(a.detail) });
  }

  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

/* ── حمولة الإشعارات ─────────────────────────────────────────────────────── */

const sar = (v) => `${(Math.round((Number(v) || 0) * 100) / 100).toString()} ر.س`;
const optAr = (o) => (o === "pickup" ? "استلام 🏬" : "توصيل 🛵");

export function pushPayload(kind, info = {}, baseUrl = "") {
  const no = info.orderNo || "";
  const url = no ? `${baseUrl}#order=${encodeURIComponent(no)}` : baseUrl;
  const common = { kind, orderNo: no || null, url, tag: no ? `order-${no}` : `portal-${kind}`, renotify: true };
  switch (kind) {
    case "new":
      return { ...common, urgency: "high", ttl: 600, requireInteraction: true,
        title: `طلب جديد ${no}`, body: `${optAr(info.option)} · ${sar(info.total)}${info.itemsCount ? ` · ${info.itemsCount} صنف` : ""}` };
    case "pos_failed":
      return { ...common, urgency: "high", ttl: 1800, requireInteraction: true,
        title: `⚠️ ${no} ما نزلش نقطة البيع`, body: "الطلب مدفوع ولسه ما وصلش تاب سينس — بنعيد المحاولة، تابع" };
    case "courier_assigned":
      return { ...common, urgency: "normal", ttl: 900, title: `🛵 اتعيّن كابتن — ${no}`,
        body: info.driverName ? `الكابتن ${info.driverName} جاي للمطعم` : "الكابتن جاي للمطعم — جهّز الشنطة" };
    case "courier_picked":
      return { ...common, urgency: "normal", ttl: 900, title: `📦 الكابتن استلم ${no}`, body: "الطلب في الطريق للعميل" };
    case "courier_arrived":
      return { ...common, urgency: "high", ttl: 600, title: `🏪 المندوب وصل المطعم — ${no}`,
        body: "الكابتن مستني الطلب — سلّمه لما يجهز" };
    case "delivered":
      return { ...common, urgency: "low", ttl: 900, title: `✅ اتوصّل ${no}`, body: "تم توصيل الطلب للعميل" };
    case "sla":
      return { ...common, urgency: "high", ttl: 1800, requireInteraction: true,
        title: `⏰ تأخير ${no}`, body: info.message || SLA_CODE_AR[info.code] || "طلب متأخر — راجعه" };
    case "tabsense_down":
      return { ...common, tag: "portal-tabsense-down", urgency: "high", ttl: 3600, requireInteraction: true,
        title: "⚠️ الربط مع تاب سينس واقع", body: `الطلبات الأونلاين مش هتنزل نقطة البيع${info.detail ? ` (${String(info.detail).slice(0, 80)})` : ""}` };
    case "test":
      return { ...common, tag: "portal-test", urgency: "high", ttl: 120, title: "🔔 تجربة إشعار البوابة",
        body: `الإشعارات شغّالة على الجهاز ده${info.name ? ` — ${info.name}` : ""}` };
    default:
      return { ...common, urgency: "normal", ttl: 600, title: info.title || "فريش كاتس", body: info.body || "" };
  }
}

/* حدث من الناقل → نوع إشعار (أو null) */
export function pushKindForEvent(evt) {
  if (!evt || !evt.orderNo) return null;
  const d = evt.data || {};
  if (evt.name === "order_paid") return { kind: "new", key: "new" };
  if (evt.name === "order_status") {
    if (d.to === "paid_pos_failed") return { kind: "pos_failed", key: "pos_failed" };
    if (d.to === "courier_assigned") return { kind: "courier_assigned", key: "courier_assigned" };
    if (d.to === "on_the_way") return { kind: "courier_picked", key: "courier_picked" };
    if (d.to === "delivered") return { kind: "delivered", key: "delivered" };
    return null;
  }
  /* «المندوب وصل المطعم» — أهم إشعار للكاشير: الكابتن واقف بيستنى.
     بيتبعت من حدثه الخاص مش من تغيّر الحالة، لأن الحالة مابتتغيّرش أصلاً. */
  if (evt.name === "courier_arrived") return { kind: "courier_arrived", key: "courier_arrived" };
  if (evt.name === "sla_alert" && Number(d.level) >= 2) {
    return { kind: "sla", key: `sla:${String(d.code || "x").slice(0, 30)}:${Number(d.level)}` };
  }
  return null;
}
