/* ═══════════════════════════════════════════════════════════════════════════
   COURIERS — طبقة مزوّدي التوصيل.

   طلب عمر (2026-08-24): «في احتمال ما نكملش مع Flying Arrow ونشتغل مع شركة
   تانية — عايزين نكون جاهزين في الحالتين».

   فالمزوّد بقى قطعة قابلة للتبديل، مش كود مدفون. كل مزوّد بيقدّم نفس
   الأربع عمليات، والباقي في السيستم ما يعرفش ولا يهمّه إحنا مع مين:

     dispatch(order, cfg)     → { ref, orderNumber, cost, driver, status, raw }
     track(shipment)          → { status, driver, cost, raw }
     cancel(shipment, reason) → { fee, refund, raw }
     parseWebhook(body)       → { orderNo, status, driver, cost }  أو null

   الـ`status` الراجع من هنا **موحّد** مش بلغة المزوّد:
     pending → assigned → picked → delivered | cancelled
   الترجمة من مصطلحات كل شركة بتحصل جوّه المزوّد نفسه، فلو بدّلنا شركة
   الحالات اللي بيشوفها العميل ما تتغيّرش ولا حرف.

   الفروق الحقيقية بين الاتنين — وهي سبب وجود الطبقة دي أصلاً:
     • Flying Arrow: مفتاح ثابت، نقطة الاستلام إحداثيات مع كل طلب، التتبع
       برقمهم هم، ولازم city_id و service_vehicle_id.
     • Leajlak (4U): Bearer token، نقطة الاستلام محل مسجّل عندهم (shop_id)،
       والتتبع والإلغاء **برقم طلبنا إحنا**، ومفيش مدينة ولا نوع مركبة.
═══════════════════════════════════════════════════════════════════════════ */

import { feeFromApi } from "./leajlakrecon.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();

/* رقم سعودي بصيغة E.164 — Flying Arrow بتطلبها كده. */
export const e164 = (v) => {
  const d = String(v || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? `+966${d}` : String(v || "");
};
/* Leajlak بتكتب الأرقام من غير + في أمثلتها (9663361163). */
export const msisdn = (v) => {
  const d = String(v || "").replace(/\D/g, "").replace(/^966/, "").replace(/^0/, "");
  return /^5\d{8}$/.test(d) ? `966${d}` : String(v || "").replace(/\D/g, "");
};

/* الحالات الموحّدة اللي السيستم كله بيتكلم بيها */
export const STAGES = ["pending", "assigned", "picked", "delivered", "cancelled"];

/* ═══════════════════════════════════════════════════════════════════════════
   محطّات المندوب (١٧ سبتمبر ٢٠٢٦ — طلب عمر: «لازم في التتبع يتسجّل إن المندوب
   وصل المطعم وإن المندوب أخد الطلب — الاتنين دول ناقصين عشان نقيس أداء
   الشركة»).

   الحالات الموحّدة الخمسة مش كفاية هنا: «وصل المطعم» و«لسه في الطريق
   للمطعم» الاتنين assigned، فالفرق بينهم — وهو بالظبط اللي بنقيسه — كان
   بيضيع. فبنقرا الحالة الخام من المزوّد مرة تانية ونطلّع منها «محطة»:

     arrived → المندوب واقف في المطعم        picked → استلم الطلب وخرج

   لاجلك (المزوّد الشغّال): «Reached Shop» = وصل، و«Order Picked / Shipped»
   = استلم — الاتنين متأكدين من طلبات حقيقية (١٦ سبتمبر).
   Flying Arrow: عندهم استلام (`pickup_completed`) لكن **مالهمش** حالة معلنة
   لـ«وصل نقطة الاستلام» في التوثيق اللي شفناه. بنقبل الأسماء المتوقّعة لو
   ظهرت، ولو ماظهرتش المحطة الأولى بتفضل فاضية والشاشة بتقولها صراحة.
═══════════════════════════════════════════════════════════════════════════ */
const normStatus = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

const MILESTONES = {
  leajlak: {
    reachedshop: "arrived", arrivedshop: "arrived", arrivedatshop: "arrived",
    reachedpickup: "arrived", reachedrestaurant: "arrived", arrivedatrestaurant: "arrived",
    orderpicked: "picked", picked: "picked", pickedup: "picked", ordershipped: "picked",
    shipped: "picked", intransit: "picked", ontheway: "picked", ordertransit: "picked",
    reachedcustomer: "picked", arrivedcustomer: "picked", reacheddropoff: "picked",
    outfordelivery: "picked",
  },
  flyingarrow: {
    // مش موثّقة عندهم — مقبولة لو ظهرت يوم ما يضيفوها
    arrivedpickup: "arrived", atpickup: "arrived", arrivedatpickup: "arrived",
    reachedpickup: "arrived", driverarrived: "arrived",
    pickupcompleted: "picked", pickedup: "picked", intransit: "picked", onthewa: "picked",
    ontheway: "picked", outfordelivery: "picked",
  },
};
/* هل المزوّد ده بيقول لنا «وصل المطعم» أصلاً؟ الشاشة بتستعمل ده عشان تفرّق
   بين «لسه ما وصلش» و«الشركة مابتبعتش الإشارة دي». */
export const PROVIDER_REPORTS_ARRIVAL = Object.freeze({ leajlak: true, flyingarrow: false, manual: false, external: false });

/* الحالة الخام → محطة ("arrived" | "picked" | null) */
export function courierMilestone(providerId, rawStatus) {
  const map = MILESTONES[String(providerId || "")] || {};
  return map[normStatus(rawStatus)] || null;
}

async function httpJson(url, { method = "GET", headers = {}, body, label = "courier" } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } finally { clearTimeout(t); }
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  if (!resp.ok) {
    throw Object.assign(new Error(`${label}: ${data.message || data.error || resp.status}`),
      { code: "COURIER_ERROR", status: resp.status, resp: data });
  }
  return data;
}

/* عنوان مقروء لسائق: الحي → الشارع → المبنى → علامة مميزة.

   الحي الأول لأن السائق بيوجّه نفسه بيه قبل أي حاجة.

   ودي مش تجميعة نصوص ساذجة: من طلب حقيقي وصل السائق بـ«مبنى المبتى والدور،
   🏠 بيت، بجوار علامة مميزة» — لأن العميل ساب الحقول فاضية والواجهة بعتت
   نص الـplaceholder نفسه، وحقل «الدور» أصلاً بيحمل نوع السكن مش رقم دور.
   فبنرمي أي قيمة شكلها placeholder، وبنشيل الإيموجي، ونوع المكان («بيت/شقة») اللي في خانة الدور مابيوصلش —
   عنوان قصير صح أنفع للسائق من عنوان طويل نصه كلام فاضي. */
const ADDR_PLACEHOLDERS = /^(المبن?ى|المبتى)?\s*(و?الدور)?$|^علامة مميزة$|^رقم المبنى$|^اسم الشارع$|^الحي$|^بيت$|^شقة$|^عنواني$|^-+$/;
// الواجهة القديمة (ورقة العنوان في app.js) بتحط «نوع المكان» في خانة الدور
const PLACE_TYPES = /^(بيت|شقة|مكتب|أخرى|اخرى|فيلا)$/;
const cleanBit = (v) => {
  const t = String(v || "").replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").trim();
  if (!t || ADDR_PLACEHOLDERS.test(t)) return "";
  return t;
};
const isDigits = (v) => /^[0-9٠-٩]+$/.test(v);

/* «اترك الطلب عند الباب» — اختيار العميل في الشيك أوت (عمر 18 سبتمبر).
   بيوصل للمندوب (العنوان + الملاحظات) وللكاشير/المطبخ (ملاحظات نقطة البيع). */
export const DOOR_NOTE = "اترك الطلب عند الباب";
export const leaveAtDoor = (addr) => {
  const v = addr && addr.leave_at_door;
  return v === true || v === 1 || v === "1" || v === "true";
};

/* الدور والشقة كخانتين منفصلتين (عمر 18 سبتمبر). رقم لوحده بياخد «الدور»/«شقة»
   قبله؛ نص (قديم: «الدور ٣ شقة ٧» في خانة واحدة) بيتكتب زي ما هو. */
export function floorAptText(addr = {}) {
  const f = cleanBit(addr.floor), ap = cleanBit(addr.apartment);
  // عنوان قديم (قبل ما الشقة تبقى خانة) رقمه ممكن يكون دور أو شقة
  const fl = addr.apartment === undefined ? "الدور/الشقة" : "الدور";
  const floor = f && !PLACE_TYPES.test(f) ? (isDigits(f) ? `${fl} ${f}` : f) : "";
  const apt = ap ? (isDigits(ap) ? `شقة ${ap}` : ap) : "";
  return [floor, apt].filter(Boolean).join("، ");
}

/* «حي حي السلامة» / «بجوار قبل الصيدلية» — العميل ساعات بيكتب الكلمة بنفسه */
const areaText = (a) => (a ? (/^حي\s/.test(a) ? a : `حي ${a}`) : "");
const landmarkText = (l) => (l ? (/^(جنب|بجوار|بجانب|قدام|أمام|امام|مقابل|خلف|ورا|قبل|بعد|عند|قريب|بالقرب|على|مع)\s/.test(l) ? l : `بجوار ${l}`) : "");

export function readableAddress(addr, { withPin = false } = {}) {
  const area = cleanBit(addr.area), street = cleanBit(addr.street);
  const building = cleanBit(addr.building), landmark = cleanBit(addr.landmark);
  const text = [
    areaText(area),
    street,
    building && `مبنى ${building}`,
    floorAptText(addr),
    // «جنب النهدي» مايبقاش «بجوار جنب النهدي»
    landmarkText(landmark),
    leaveAtDoor(addr) && DOOR_NOTE,
  ].filter(Boolean).join("، ");

  /* ملاحظة عمر من طلب حقيقي (2026-08-30): تطبيق المندوب بيفتح جوجل ماب
     و**يبحث بنص العنوان** بدل ما يفتح الدبوس — فالسائق بيلف على عنوان
     تقريبي. الحل إن الإحداثيات تبقى جزء من النص نفسه: جوجل ماب بيفهم
     "21.592080,39.143515" كنقطة بالظبط، فسواء التطبيق فتح الدبوس أو بحث
     بالنص، الاتنين بيوصلوا نفس المكان.
     ٦ خانات عشرية ≈ ١١ سم — أدق من أي عنوان مكتوب. */
  const lat = Number(addr.latitude), lng = Number(addr.longitude);
  const pin = withPin && isFinite(lat) && isFinite(lng) && lat && lng
    ? `${lat.toFixed(6)},${lng.toFixed(6)}` : "";
  if (!text) return pin || "موقع العميل — اتبع الإحداثيات";
  return pin ? `${text} — ${pin}` : text;
}

const PREPAID_NOTE = "الطلب مدفوع مسبقاً — لا يُحصَّل من العميل";

/* ── لاجلك: العنوان = النقطة بس، وكل الباقي في order.notes ───────────────
   ١٩/٩ (أول مرة): لاجلك قالت إن العربي في delivery_details.address بيوصل
   مكسّر، فالتفاصيل اتنقلت لـorder.notes والعنوان بقى «الحي + الشارع + النقطة».
   ١٩/٩ (عمر، تاني مرة): تطبيق الكابتن بيفتح جوجل ماب **بنص حقل العنوان** على
   طول — فأي كلام قبل الإحداثيات بيخلّي جوجل يدوّر على نص بدل ما يفتح النقطة.
   فالحقل بقى النقطة بس «lat,lng» (٦ خانات ≈ ١١ سم). ده الشكل اللي جوجل ماب
   بيفهمه كنقطة سواء اتبحث بيه في التطبيق، أو اتحط في رابط ‎?q=‎ أو geo:‎ —
   رابط كامل جوّه الحقل كان هيبوظ لو تطبيقهم بيعمل بحث بالنص. ولو حبّينا
   الرابط: settings.delivery.ljAddressFormat = "link".
   العنوان المكتوب كامل (حي/شارع/مبنى/دور/شقة/علامة/«اترك عند الباب») +
   «ملاحظات التوصيل» بتاعة العنوان بيروحوا order.notes. ملاحظات الأكل لأ.
   Flying Arrow مالهاش دعوة — لسه بتاخد readableAddress كاملة. */
export function mapPoint(addr = {}, format = "coords") {
  const lat = Number(addr.latitude), lng = Number(addr.longitude);
  if (!(isFinite(lat) && isFinite(lng) && lat && lng)) return "";
  const p = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  return format === "link" ? `https://maps.google.com/?q=${p}` : p;
}
export function locationText(addr = {}, { withPin = true } = {}) {
  const area = cleanBit(addr.area), street = cleanBit(addr.street);
  const text = [areaText(area), street].filter(Boolean).join("، ");
  const pin = withPin ? mapPoint(addr) : "";
  if (!text) return pin || "موقع العميل — اتبع الإحداثيات";
  return pin ? `${text} — ${pin}` : text;
}
/* العنوان المكتوب كامل من غير «اترك عند الباب» (بتتكتب لوحدها أول الملاحظات) */
export function fullAddressText(addr = {}) {
  const area = cleanBit(addr.area), street = cleanBit(addr.street);
  const building = cleanBit(addr.building), landmark = cleanBit(addr.landmark);
  return [
    areaText(area), street, building && `مبنى ${building}`, floorAptText(addr), landmarkText(landmark),
  ].filter(Boolean).join("، ");
}
export function deliveryDetailsText(addr = {}) {
  const building = cleanBit(addr.building), landmark = cleanBit(addr.landmark);
  return [
    leaveAtDoor(addr) && DOOR_NOTE,
    building && `مبنى ${building}`,
    floorAptText(addr),
    landmarkText(landmark),
  ].filter(Boolean).join("، ");
}

/* ── «ملاحظات التوصيل» ≠ «ملاحظات الأكل» (عمر ١٩/٩) ──────────────────────
   ملاحظات التوصيل بتاعة العنوان (address.delivery_notes — محفوظة في دفتر
   العناوين وبتتنقل مع الطلب): للمندوب والبوابة بس.
   ملاحظات الأكل بتاعة الطلب (shop_orders.notes): لنقطة البيع والمطبخ بس.
   طلب قديم (قبل الفصل — العنوان مافيهوش المفتاح delivery_notes أصلاً) كانت
   ملاحظته الوحيدة بتروح للاتنين، فبيفضل ياخدها المندوب زي الأول عشان
   تعليمات توصيل مكتوبة هناك ماتضيعش. */
export const notesSplit = (order = {}) => {
  const a = order.address;
  return Boolean(a && typeof a === "object" && Object.prototype.hasOwnProperty.call(a, "delivery_notes"));
};
export function deliveryNotesOf(order = {}) {
  const a = order.address || {};
  return String(a.delivery_notes || "").replace(/\s+/g, " ").trim();
}
/* ملاحظة الطلب القديمة اللي لسه بتوصل المندوب (قبل الفصل بس) */
const legacyCourierNote = (order) => (notesSplit(order) ? "" : String(order.notes || "").trim());

/* order.notes لاجلك: مشوار بعيد ← اترك عند الباب ← العنوان كامل ← ملاحظات التوصيل */
export const LJ_NOTES_MAX = 300;
export function leajlakNotes(order = {}) {
  const addr = order.address || {};
  const far = farZoneOfRow(order);
  const full = fullAddressText(addr);
  const dn = deliveryNotesOf(order);
  const old = legacyCourierNote(order);
  const n = [
    far ? `مشوار بعيد ${far.km} كم` : "",
    leaveAtDoor(addr) ? DOOR_NOTE : "",
    full && `العنوان: ${full}`,
    dn && `ملاحظات التوصيل: ${dn}`,
    old && `ملاحظة العميل: ${old}`,
  ].filter(Boolean).join(" — ");
  return n.slice(0, LJ_NOTES_MAX) || PREPAID_NOTE;
}
/* جسم POST /orders لاجلك — دالة صافية عشان يتجرّب من غير شبكة */
export function leajlakPayload(order = {}, shopId = "", { addressFormat = "coords" } = {}) {
  const addr = order.address || {};
  return {
    id: String(order.order_no),
    shop_id: String(shopId),
    delivery_details: {
      name: order.customer?.name || "العميل",
      phone: msisdn(order.customer?.phone || order.phone_norm || ""),
      coordinate: { latitude: Number(addr.latitude), longitude: Number(addr.longitude) },
      // النقطة بس — ولو (مستحيل في توصيل) مفيش إحداثيات، الحي والشارع
      address: mapPoint(addr, addressFormat === "link" ? "link" : "coords") || locationText(addr, { withPin: false }),
    },
    order: {
      // 0 = مدفوع مسبقاً (1 = كاش عند الاستلام، 10 = مكينة شبكة). كل طلبات الموقع مدفوعة أونلاين.
      payment_type: 0,
      total: Number(order.total) || 0,
      notes: leajlakNotes(order),
    },
  };
}

/* ── «المنطقة البعيدة» على صفّ الطلب ─────────────────────────────────────
   العميل وافق على رسوم مسافة إضافية (delivery.js). التفاصيل محفوظة جوّه
   `delivery_quote.farZone` — مفيش عمود جديد، عشان مصدر الرقم يفضل واحد:
   نفس التسعيرة اللي العميل شافها ودفعها.

   لعجلك بتحاسبنا +٢٫٣٠ ر.س شامل لكل كيلو فوق ١٠ (بالكسر)، واحنا بناخد ٣ — فالمندوب
   والكاشير لازم يشوفوا إن ده مشوار طويل، والتقرير يقارن الفرق. */
export function farZoneOfRow(order = {}) {
  let q = order && order.delivery_quote;
  if (typeof q === "string") { try { q = JSON.parse(q); } catch { q = null; } }
  const f = q && q.farZone;
  if (!f || !(Number(f.extraKm) > 0)) return null;
  return {
    km: Number(f.km) || null,
    extraKm: Number(f.extraKm) || 0,
    surcharge: Number(f.surcharge) || 0,
  };
}

/* ملاحظات المندوب (Flying Arrow): «اترك الطلب عند الباب» أولاً، بعدها
   «ملاحظات التوصيل» بتاعة العنوان — ملاحظات الأكل مابتوصلش المندوب (عمر ١٩/٩).
   ٢٠٠ حرف حد الشركتين. */
export function courierNotes(order = {}) {
  const far = farZoneOfRow(order);
  const n = [
    // المندوب لازم يعرف إن ده مشوار بعيد قبل ما يقبل — والمسافة بتفرق في أجره
    far ? `مشوار بعيد ${far.km} كم` : "",
    leaveAtDoor(order.address) ? DOOR_NOTE : "",
    deliveryNotesOf(order),
    legacyCourierNote(order),
  ].filter(Boolean).join(" — ");
  return n.slice(0, 200) || PREPAID_NOTE;
}

/* ═══ Flying Arrow ═══════════════════════════════════════════════════════ */
const FA_BASE = () => env("FLYINGARROW_BASE", "https://flyingarrow-backend.com/api/v1/integration").replace(/\/+$/, "");
const FA_KEY = () => env("FLYINGARROW_API_KEY", "");

const FA_STATUS = {
  created: "pending", pending: "pending", confirmed: "pending",
  driver_assigned: "assigned", assigned: "assigned", accepted: "assigned",
  pickup_completed: "picked", picked_up: "picked", in_transit: "picked", on_the_way: "picked",
  delivered: "delivered", completed: "delivered",
  cancelled: "cancelled", canceled: "cancelled",
};

const flyingarrow = {
  id: "flyingarrow",
  label: "Flying Arrow",
  configured: () => Boolean(FA_KEY()),
  missing: () => (FA_KEY() ? [] : ["FLYINGARROW_API_KEY"]),
  needsRef: true,   // اللوحة بتعرض قوايم المدينة والمركبة

  call(path, opts = {}) {
    return httpJson(`${FA_BASE()}${path}`, {
      ...opts, headers: { "X-API-Key": FA_KEY() }, label: `FlyingArrow ${path}`,
    });
  },

  async reference() {
    const [cities, vehicles] = await Promise.all([
      this.call("/cities"), this.call("/service-vehicles"),
    ]);
    return {
      cities: (cities?.data?.cities || []).map((c) => ({ id: c.id, name: c.name_ar || c.name_en })),
      vehicles: (vehicles?.data?.service_vehicles || []).map((v) => ({
        id: v.id, name: v.name_ar || v.name_en,
        basePrice: v.base_price != null ? Number(v.base_price) : null,
        perKm: v.price_per_km != null ? Number(v.price_per_km) : null,
      })),
    };
  },

  async dispatch(order, cfg) {
    const addr = order.address || {};
    const created = await this.call("/orders", {
      method: "POST",
      body: {
        // 8 = «التوصيل المبرد والساخن» (سيدان). الدباب (3) بيترفض على حسابنا
        // بـ VEHICLE_TYPE_NOT_ALLOWED — الحساب مخصص للسيدان.
        service_vehicle_id: Number(cfg.faVehicleId || 8),
        city_id: Number(cfg.faCityId || 20),
        payment_method: cfg.faPaymentMethod || "wallet",
        external_order_id: order.order_no,
        webhook_url: cfg.webhookUrl,
        notes: courierNotes(order),
        locations: [
          {
            type: "pickup",
            address: cfg.pickupAddress || "فريش كاتس — جدة",
            lat: cfg.storeLat, lng: cfg.storeLng,
            contact_name: cfg.pickupContactName || "فريش كاتس",
            contact_phone: e164(cfg.pickupContactPhone || ""),
          },
          {
            type: "dropoff",
            address: readableAddress(addr, { withPin: true }),
            lat: Number(addr.latitude), lng: Number(addr.longitude),
            contact_name: order.customer?.name || "العميل",
            contact_phone: e164(order.customer?.phone || ""),
          },
        ],
      },
    });
    const o = created?.data?.order || {};
    return {
      ref: o.id != null ? String(o.id) : null,
      orderNumber: o.order_number || null,
      cost: o.pricing?.total != null ? Number(o.pricing.total) : null,
      driver: o.driver || null,
      status: FA_STATUS[(o.status && o.status.value) || "created"] || "pending",
      raw: created,
    };
  },

  async track(sh) {
    if (!sh.provider_ref) return null;
    const r = await this.call(`/orders/${encodeURIComponent(sh.provider_ref)}`);
    const o = r?.data?.order;
    if (!o) return null;
    return {
      status: FA_STATUS[(o.status && o.status.value) || ""] || null,
      // الحالة الخام كمان: محطّات المندوب (وصل/استلم) بتتقرا منها
      rawStatus: (o.status && o.status.value) != null ? String(o.status.value) : null,
      driver: o.driver || null,
      cost: o.total_amount != null ? Number(o.total_amount) : null,
      raw: o,
    };
  },

  async cancel(sh, reason) {
    const r = await this.call(`/orders/${encodeURIComponent(sh.provider_ref)}/cancel`, {
      method: "POST", body: { reason: String(reason || "cancelled by restaurant").slice(0, 200) },
    });
    return {
      fee: r?.data?.cancellation_fee != null ? Number(r.data.cancellation_fee) : null,
      refund: r?.data?.refund_amount != null ? Number(r.data.refund_amount) : null,
      raw: r,
    };
  },

  parseWebhook(b) {
    const ev = String(b.event || b.status || "").replace(/^order\./, "");
    if (!ev) return null;
    const inner = (b.data && b.data.order) || {};
    /* مهم: GET /orders/{id} عندهم بيرجّع external_order_id = null حتى لما
       نبعته — يعني مش مضمون إن الويبهوك هيحمل رقمنا. فبنرجع لرقمهم
       (order_id / data.order.id) كمفتاح احتياطي، وdelivery.js بيدوّر بيه
       في provider_ref. من غير ده، ويبهوك من غير رقمنا كان هيتضاع بالكامل
       والعميل يفضل شايف حالة قديمة. */
    const orderNo = b.external_order_id || inner.external_order_id || null;
    const ref = b.order_id ?? inner.id ?? null;
    if (!orderNo && ref == null) return null;
    return {
      orderNo: orderNo != null ? String(orderNo) : null,
      ref: ref != null ? String(ref) : null,
      status: FA_STATUS[ev] || null,
      rawStatus: ev,
      driver: b.driver || inner.driver || null,
      cost: inner.total_amount != null ? Number(inner.total_amount) : null,
    };
  },
};

/* ═══ Leajlak (4U Logistic) ══════════════════════════════════════════════
   حاجتان في تصميمهم بتغيّرا شكل الربط:
   • نقطة الاستلام مش في الطلب — هي محل مسجّل عندهم بـ shop_id، فلازم
     المحل يتسجّل مرة واحدة من لوحتهم (أو POST /api/partner/shops).
   • التتبع والإلغاء **برقم طلبنا إحنا**، فمش مستنيين رقم منهم عشان نعرف
     نتتبع — وده فعلياً أمتن من Flying Arrow. */
/* وثيقتهم بتقول «Base_URL/orders» وده مضلّل: المسار الحقيقي تحت
   /api/partner. الدليل — /api/partner/orders بيقرا التوكن ويرد برسالة
   الحساب، بينما /orders على الجذر بيرد «Unauthenticated» يعني التوكن ما
   وصلوش أصلاً. */
const LJ_BASE = () => env("LEAJLAK_BASE", "https://app.leajlak.com/api/partner").replace(/\/+$/, "");
const LJ_TOKEN = () => env("LEAJLAK_TOKEN", "");
const LJ_SHOP = () => env("LEAJLAK_SHOP_ID", "");
const LJ_WH_SECRET = () => env("LEAJLAK_WEBHOOK_SECRET", "");

/* حالاتهم نصية زي ما هي في وثيقتهم («New Order» / «Order Accept»)، فبنطبّع
   أي صيغة (مسافات/شرط سفلي/حالة أحرف) قبل المقارنة. */
const LJ_STATUS = {
  neworder: "pending", new: "pending", pending: "pending", created: "pending",
  orderaccept: "assigned", orderaccepted: "assigned", accepted: "assigned",
  assigned: "assigned", riderassigned: "assigned", driverassigned: "assigned",
  // «Start Ride» (16 سبتمبر، طلب حقيقي): الكابتن اتحرك بعد القبول ولسه ما استلمش —
  // ماكانتش في الخريطة، فالحالة اتجاهلت وبيانات الكابتن مابانتش.
  startride: "assigned", ridestarted: "assigned",
  // «Reached Shop» (16 سبتمبر): الكابتن وصل المطعم ولسه ما استلمش.
  reachedshop: "assigned", arrivedshop: "assigned", arrivedatshop: "assigned", reachedpickup: "assigned",
  // الكابتن وصل للعميل = لسه معاه الأكل.
  reachedcustomer: "picked", arrivedcustomer: "picked", reacheddropoff: "picked",
  orderpicked: "picked", picked: "picked", pickedup: "picked",
  intransit: "picked", ontheway: "picked", ordertransit: "picked",
  // «Shipped» رجعت من طلب حقيقي والكابتن كان ماسك الأكل فعلاً — وما كانتش
  // في الخريطة، فالحارس فضل يتجاهلها والعميل قاعد على «جاري إسناد مندوب».
  shipped: "picked", ordershipped: "picked", outfordelivery: "picked",
  delivered: "delivered", completed: "delivered", ordercompleted: "delivered", orderdelivered: "delivered",
  cancelled: "cancelled", canceled: "cancelled", ordercancelled: "cancelled", rejected: "cancelled",
};
const ljNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
/* حالة مش في الخريطة = العميل هيقف على شاشة قديمة من غير ما حد يعرف ليه.
   بنقولها في اللوج مرة واحدة لكل قيمة بدل ما تختفي في صمت. */
const _seenUnknown = new Set();
function ljStage(raw) {
  const k = ljNorm(raw);
  const mapped = LJ_STATUS[k];
  if (!mapped && k && !_seenUnknown.has(k)) {
    _seenUnknown.add(k);
    console.error(`[couriers] Leajlak حالة غير معروفة: "${raw}" — محتاجة تتضاف للخريطة`);
  }
  return mapped || null;
}

const leajlak = {
  id: "leajlak",
  label: "Leajlak (4U)",
  configured: () => Boolean(LJ_TOKEN() && LJ_SHOP()),
  missing: () => [!LJ_TOKEN() && "LEAJLAK_TOKEN", !LJ_SHOP() && "LEAJLAK_SHOP_ID"].filter(Boolean),
  needsRef: false,

  call(path, opts = {}) {
    return httpJson(`${LJ_BASE()}${path}`, {
      ...opts, headers: { Authorization: `Bearer ${LJ_TOKEN()}` }, label: `Leajlak ${path}`,
    });
  },

  /* مالهمش قوايم مدن ولا مركبات. بنتأكد من التوكن بسؤال عن طلب مش موجود:
     ٤٠٤ = التوكن سليم والمسار شغال؛ ٤٠١ = التوكن غلط. */
  async reference() {
    /* مالهمش قوايم مدن ولا مركبات، فبنسأل عن طلب مش موجود ونقرا الرد:
         404  → التوكن سليم والمسار سليم (دي الحالة الصحية)
         401 «Client is not active…» → التوكن سليم بس الحساب لسه مش مفعّل
         401 «Unauthenticated»       → التوكن مرفوض أو المسار غلط
       التفرقة دي مهمة: «فعّلوا حسابنا» شغل مختلف تماماً عن «التوكن غلط». */
    try {
      await this.call(`/orders/${encodeURIComponent("healthcheck-000")}`);
    } catch (e) {
      const msg = String((e.resp && e.resp.message) || e.message || "");
      if (e.status === 401 && /not active|suspended/i.test(msg)) {
        throw Object.assign(new Error("الحساب عند لاجلك لسه غير مفعّل — كلّمهم يفعّلوه"),
          { status: 401, resp: e.resp, code: "CLIENT_INACTIVE" });
      }
      if (e.status && e.status !== 404) throw e;
    }
    return {
      cities: [], vehicles: [],
      note: "Leajlak ما بيوفّرش قوائم مدن أو مركبات — الاستلام من المحل المسجّل بـ shop_id.",
    };
  },

  /* سرّ الويبهوك: لوحتهم بتطلب مفتاح سرّي مع الرابط. مش موثّق فين بيحطوه
     بالظبط، فبندوّر عليه في الأماكن المعتادة ونقبل أي واحد يطابق. لو
     ما حددناش سرّ أصلاً بنعدّي — عشان تفعيل التحقق ما يكسرش الاستقبال. */
  verifyWebhook(headers, body) {
    const secret = LJ_WH_SECRET();
    if (!secret) return true;
    const h = (k) => String(headers[k] || headers[k.toLowerCase()] || "");
    const candidates = [
      h("x-webhook-secret"), h("x-secret"), h("x-api-key"),
      h("authorization").replace(/^Bearer\s+/i, ""),
      String(body.secret || ""), String(body.webhook_secret || ""), String(body.key || ""),
    ];
    return candidates.some((v) => v && v === secret);
  },

  async dispatch(order, cfg) {
    const created = await this.call("/orders", {
      method: "POST",
      body: leajlakPayload(order, cfg.ljShopId || LJ_SHOP(), { addressFormat: cfg.ljAddressFormat }),
    });
    const d = created?.data || created || {};
    /* وثيقتهم بتقول إن التتبع برقم طلبنا — وده **غلط**، مجرّب على اللايف:
       GET /orders/<رقمنا> بيرد «There is no order with this order id»، بينما
       GET /orders/<dsp_order_id> بيرد الطلب كامل. فالمرجع التشغيلي هو
       الـUUID بتاعهم، ورقمنا بيفضل في shop_order_no وبيرجع في حقل `id`
       بتاع ردهم (وده اللي بنطابق بيه الويبهوك). */
    return {
      ref: String(d.dsp_order_id || order.order_no),
      orderNumber: d.dsp_order_id != null ? String(d.dsp_order_id) : null,
      // `total` في ردّهم (لو رجع) = إجمالي طلبنا اللي باعتينه، مش أجرة المندوب.
      // رسوم لاجلك مش في الـAPI أصلاً (١٩/٩) — بتتلقط هنا لو ضافوها.
      cost: feeFromApi(d).fee,
      driver: d.driver || null,
      status: ljStage(d.status) || "pending",
      raw: created,
    };
  },

  async track(sh) {
    // ردهم مسطّح: {id, status, dsp_order_id, driver?} — مش متعشّش تحت data
    const r = await this.call(`/orders/${encodeURIComponent(sh.provider_ref || sh.shop_order_no)}`);
    const d = (r && r.data) || r || {};
    if (!d.status && !d.driver) return null;
    return {
      status: ljStage(d.status),
      // «Reached Shop» بتتلمّ في assigned، فالحالة الخام هي الطريق الوحيد
      // اللي نعرف بيه إن المندوب واقف في المطعم فعلاً
      rawStatus: d.status != null ? String(d.status) : null,
      driver: d.driver || null,
      cost: feeFromApi(d).fee,
      raw: d,
    };
  },

  async cancel(sh, reason) {
    /* مجرّب على اللايف: DELETE /orders/<dsp_order_id> بيرد 202 بجسم فاضي —
       وده اللي وثيقتهم بتسمّيه «CANCEL» وصفحتها اسمها DeleteOrder. مفيش
       مسار /cancel عندهم أصلاً (بيرد route not found)، ومفيش رسوم إلغاء
       ولا مبلغ مسترد في الرد. */
    const path = `/orders/${encodeURIComponent(sh.provider_ref || sh.shop_order_no)}`;
    const body = { reason: String(reason || "cancelled by restaurant").slice(0, 200) };
    return { fee: null, refund: null, raw: await this.call(path, { method: "DELETE", body }) };
  },

  parseWebhook(b) {
    // ويبهوكهم بيرجّع رقم طلبنا في `id`، ومرجعهم في dsp_order_id.
    const orderNo = b.id || b.client_order_id || b.external_order_id || null;
    const ref = b.dsp_order_id ?? null;
    if (!orderNo && ref == null) return null;
    const raw = b.status || b.event || "";
    return {
      orderNo: orderNo != null ? String(orderNo) : null,
      ref: ref != null ? String(ref) : null,
      status: ljStage(raw),
      rawStatus: String(raw),
      driver: b.driver || null,
      cost: feeFromApi(b).fee,
    };
  },
};

/* ═══ MANUAL — المرحلة الأولى: المزوّد هو الكاشير ═══════════════════════════
   قرار عمر (2026-08-26): «العميل هيدخل يطلب ويدفع، ويرجع الكاشير يدخل الأوردر
   بشكل يدوي على الداشبورد عشان المندوب يجي المطعم ويوصل الطلب».

   فالمرحلة دي مفيهاش API توصيل خالص. بنسجّل المزوّد ده عشان حاجتين:

   1) `dispatch` بترمي دايماً. مفيش أي طريق في الكود يقدر يبعت طلب لشركة
      توصيل وإحنا في الوضع اليدوي — حتى لو حد غلط في الإعدادات.
   2) الرجوع الافتراضي في delivery.js هو `PROVIDERS[sh.provider] ||
      PROVIDERS.flyingarrow`. من غير المزوّد ده، شحنة يدوية (والمرجع فيها
      رقم كتبه الكاشير بإيده من لوحة «أجلك») كانت هتتتبّع وتتلغى على API
      Flying Arrow برقم مش بتاعهم أصلاً. دلوقتي بترجع null بهدوء.           */
const manual = {
  id: "manual",
  label: "يدوي (الكاشير)",
  configured: () => true,      // مفيش مفاتيح تنقص — الكاشير موجود
  missing: () => [],
  needsRef: false,
  manual: true,
  async dispatch() {
    throw Object.assign(
      new Error("الوضع اليدوي: الكاشير هو اللي بيدخّل الطلب على لوحة شركة التوصيل — مفيش إرسال آلي"),
      { code: "MANUAL_DISPATCH_ONLY" });
  },
  async track() { return null; },   // مفيش عندهم API نسأله
  async cancel() { return { fee: null, refund: null, raw: { manual: true } }; },
  parseWebhook() { return null; },  // مفيش ويبهوك ييجي لشحنة يدوية
  async reference() {
    return { cities: [], vehicles: [], note: "الوضع اليدوي — مفيش تكامل مع شركة توصيل." };
  },
};

/* ═══ EXTERNAL — «مندوب خارجي» (١٩ سبتمبر ٢٠٢٦) ════════════════════════════
   لاجلك رفضت طلب ١٣ كم والفريق بعته مع مندوب من بره، ومفيش حاجة في السيستم
   كانت بتسجّل ده. الشحنة دي بيدخلها المدير من البوابة (courierops.js):
   اسم/جوال اختياري، تكلفة، ملاحظات، والحالات (استلم/وصّل) بإيده. مفيش API،
   فالمزوّد هنا زي «اليدوي»: الإرسال بيرمي، والتتبع/الويبهوك null، والإلغاء
   محلي — ومن غيره الرجوع الافتراضي `PROVIDERS[sh.provider] || flyingarrow`
   كان هيسأل Flying Arrow عن شحنة مش بتاعتها. */
const external = {
  ...manual,
  id: "external",
  label: "مندوب خارجي",
  async dispatch() {
    throw Object.assign(new Error("المندوب الخارجي بيتسجّل من البوابة — مفيش إرسال آلي"),
      { code: "MANUAL_DISPATCH_ONLY" });
  },
  async cancel() { return { fee: null, refund: null, raw: { external: true } }; },
  async reference() { return { cities: [], vehicles: [], note: "مندوب خارجي — بيتسجّل يدوي من البوابة." }; },
};

export const PROVIDERS = { flyingarrow, leajlak, manual, external };
/* مزوّدين بـAPI حقيقي (ينفع «بدّل الشركة» يبعت لهم) */
export const API_PROVIDER_IDS = Object.freeze(["leajlak", "flyingarrow"]);

/* المزوّد الفعّال. الإعدادات هي المرجع والمتغيّر البيئي احتياطي.

   لو المختار ناقص مفاتيحه بنرجّعه برضه بدل ما نبدّل لغيره: التبديل الصامت
   معناه إننا نبعت طلب حقيقي لشركة عمر مش مختارها. الشاشة بتقول ناقصه إيه،
   والإرسال بيقف بخطأ واضح — وده أأمن بكتير من نجاح في المكان الغلط. */
export function activeProvider(settings) {
  const want = String((settings && settings.delivery && settings.delivery.provider)
    || env("COURIER_PROVIDER", "flyingarrow")).toLowerCase();
  return PROVIDERS[want] || PROVIDERS.flyingarrow;
}
