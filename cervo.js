/* ═══════════════════════════════════════════════════════════════════════════
   CERVO DELIVERY — Partner API v3  (٢٢ سبتمبر ٢٠٢٦)

   المزوّد التالت في طبقة `couriers.js` جنب لاجلك و Flying Arrow. نية عمر من
   الربط ده: لاجلك بتغطي ≤١٠ كم بسعر ثابت وبعقد فيه التزامات، وفوق كده
   بترفض (العقد م٣) — فبقى فيه فجوة بين ١٠ و١٢ كم مالهاش مزوّد. Cervo
   بتملاها.

   ── حاجات اكتشفناها بنفسنا (مش في وثيقتهم أو بتخالفها) ────────────────────
   • **العنوان الأساسي مش api.cervodelivery.com** — ده استضافة الوثيقة بس،
     وكل مسار عليه بيرد 404. الـAPI الحقيقي:
       https://partners.cervodelivery.com/api/partners/v3     (اتأكدنا، 200)
       https://partners.cervodelivery.com/apis/v3             (نفس الرد)
   • **GET /health محتاج توكن.** وثيقتهم مابتقولش كده؛ من غير هيدر بيرد
     401 {"message":"Authorization header is missing"}. يعني /health مش فحص
     اتصال — هو كمان فحص للتوكن، وده أنفع.
   • **رد قايمة الطلبات المجدولة مغلّف في `data` + `pagination`**، مش
     `items`/`page`/`total_count` زي ما الوثيقة بتقول.
   • **رد إنشاء الطلب نصّ JSON مجرّد** (GUID بين علامتين) مش كائن — فالـ
     parse بيرجّع string. أي كود بيعمل `.data` عليه بياخد undefined، وعشان
     كده ليهم دالة HTTP خاصة تحت.
   • **`customer` أقصاه ٥٠ حرف** — مش مكتوب في الوثيقة. طلع من طلب حقيقي:
     400 «The field customer must be a string with a maximum length of 50».
     فكل الحقول النصّية بتتقصّ هنا قبل ما تتبعت.
   • **رد GET /order بـcamelCase مش PascalCase**: `driverName` / `driverMobile`
     / `status` / `orderStatus` — الوثيقة كاتباهم `DriverName` / `Status` /
     `OrderStatus`. `normalizeCervoOrder` بتقبل الشكلين عشان لو رجعوا
     للشكل الموثّق مايحصلش حاجة.
   • **رابط التتبع على `dashboard.cervodelivery.com/tracking/{uid}`**، مش
     `track.cervodelivery.com` زي الوثيقة.
   • **نفس الـid بيرجّع نفس الـUUID — متأكدين منها حيّ** (٢٢/٩: POST مرتين
     بنفس الـid رجّع نفس المرجع ونفس `db_id`). دي أساس الاسترجاع عندنا.
   • **مفيش أي حقل سعر/أجرة** في أي رد — لا عند الإنشاء ولا في GET.
   • العربي: بنبعت سطر إنجليزي مختصر في الأول (نفس التأمين اللي عملناه
     للاجلك) لأن **ردودهم عمرها ما بترجّع الملاحظات ولا العنوان**، يعني
     مفيش طريقة نتأكد بيها إن العربي وصل سليم للكابتن من غير ما نسألهم.
     يتقفل من `settings.delivery.cervoAsciiLine = false`.

   ── القاعدة اللي مايصحش تتكسر أبداً ──────────────────────────────────────
   كل طلبات الموقع مدفوعة أونلاين. المندوب **مايحصّلش ولا هللة**. يعني:
       payment = "ONLINE"   ·   ispaid = true   ·   price = 0
   دي مش قيم افتراضية ينفع حد يعدّلها من الإعدادات — هي ثوابت، و
   `assertPrepaid()` بترمي قبل أي نداء شبكة لو واحدة منهم اتغيّرت. غلطة هنا
   معناها إن المندوب يقف على باب العميل ويطلب فلوس اتدفعت خلاص.

   ── الحالات ─────────────────────────────────────────────────────────────
   أرقام مش نصوص (عكس لاجلك). أهم مكسب: **٢٠ = «وصل المطعم»** — أول إشارة
   وصول حقيقية من مزوّد عندنا (لاجلك بتقولها نصاً، Flying Arrow مابتقولهاش
   أصلاً)، وبيها مهلة «الكابتن وصل الفرع» بتتقاس بدقة.
═══════════════════════════════════════════════════════════════════════════ */

import {
  e164, readableAddress, mapPoint, locationText, fullAddressText, deliveryNotesOf,
  leaveAtDoor, DOOR_NOTE, PREPAID_NOTE, farZoneOfRow, notesSplit,
} from "./couriers.js";
import { districtOfRow } from "./districts.js";

const env = (k, d) => (process.env[k] || d || "").toString().trim();

/* الوثيقة بتدّي عنوانين شغالين — بناخد الأطول وضوحاً، والمتغيّر البيئي
   بيغلب عشان لو غيّروه بكرة مانحتاجش نشر. */
export const CERVO_BASE = () =>
  env("CERVO_BASE", "https://partners.cervodelivery.com/api/partners/v3").replace(/\/+$/, "");
export const CERVO_TOKEN = () => env("CERVO_TOKEN", "");
/* سرّ اختياري بنطلبه منهم (لسه مش موجود في الـAPI). لو اتسجّل عندنا، أي
   ويبهوك مالوش السرّ بيترفض. من غيره بنعتمد على التحقق من عندهم بالـGET. */
export const CERVO_WH_SECRET = () => env("CERVO_WEBHOOK_SECRET", "");

/* ═══ الحالات ═══════════════════════════════════════════════════════════ */
export const CERVO_STATUS = Object.freeze({
  0: "cancelled",   // ملغي (عام)
  1: "pending",     // طلب جديد — لسه مفيش كابتن
  2: "assigned",    // الكابتن قبل
  3: "picked",      // استلم من المطعم (On Hand)
  4: "delivered",
  5: "cancelled",   // الكابتن لغى
  6: "cancelled",   // المطعم لغى
  7: "cancelled",   // الإدارة لغت
  20: "assigned",   // وصل المطعم — الحالة الموحّدة لسه assigned، والمحطة arrived
});
export const CERVO_STATUS_AR = Object.freeze({
  0: "ملغي", 1: "طلب جديد", 2: "الكابتن قبل الطلب", 3: "الكابتن استلم الطلب",
  4: "تم التوصيل", 5: "الكابتن لغى", 6: "المطعم لغى", 7: "الإدارة لغت",
  20: "الكابتن وصل المطعم",
});
/* مين من الأكواد دي معناه «الشركة/الكابتن هما اللي لغوا» — بيدخل في حساب
   نسبة الإلغاء زي ما بنعمل مع لاجلك. */
export const CERVO_CANCEL_BY = Object.freeze({ 0: "unknown", 5: "driver", 6: "store", 7: "admin" });

const _seenUnknown = new Set();
/* كود → حالة موحّدة. أي كود جديد بيتكتب في اللوج مرة واحدة بدل ما يضيع في
   صمت والعميل يقعد على شاشة واقفة. */
export function cervoStage(code) {
  if (code === null || code === undefined || code === "") return null;
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  const s = CERVO_STATUS[n];
  if (!s && !_seenUnknown.has(n)) {
    _seenUnknown.add(n);
    console.error(`[cervo] كود حالة غير معروف: ${n} — محتاج يتضاف للخريطة`);
  }
  return s || null;
}
export const isCervoStatus = (code) =>
  Object.prototype.hasOwnProperty.call(CERVO_STATUS, Number(code));
export const cervoStatusAr = (code) => CERVO_STATUS_AR[Number(code)] || null;

/* ═══ الـid الرقمي ══════════════════════════════════════════════════════
   بيطلبوا `id` **رقم** (مفتاح الطلب عندهم؛ نفس الرقم بيحدّث بدل ما ينسخ)،
   بينما `order_id` نص للعرض. أرقام طلباتنا شكلها W1789825687099 = حرف +
   وقت بالملّي — فبناخد الأرقام بس. ١٣ خانة جوّه MAX_SAFE_INTEGER بأمان.

   لو رقم أطول من ١٥ خانة ظهر يوم (مش شكل أرقامنا الحالي) بناخد آخر ١٥ —
   وده احتمال تصادم نظري، بس البديل (رمية) كان هيوقف طلب حقيقي. */
export function cervoNumericId(orderNo) {
  const raw = String(orderNo == null ? "" : orderNo);
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) {
    throw Object.assign(new Error(`Cervo: رقم الطلب «${raw}» مافيهوش أرقام — مايتحوّلش لـid رقمي`),
      { code: "CERVO_BAD_ORDER_NO" });
  }
  const n = Number(digits.length > 15 ? digits.slice(-15) : digits);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw Object.assign(new Error(`Cervo: رقم الطلب «${raw}» مايتحوّلش لـid رقمي آمن`),
      { code: "CERVO_BAD_ORDER_NO" });
  }
  return n;
}

/* ═══ الملاحظات ═════════════════════════════════════════════════════════
   نفس تقسيمة لاجلك بالظبط: ملاحظات **التوصيل** بس للمندوب، وملاحظات الأكل
   لنقطة البيع والمطبخ. مصدر واحد للعنوان، فأي تعديل في couriers.js بيتبع
   هنا لوحده. */
export const CERVO_NOTES_MAX = 300;
/* حدود حقولهم النصّية. الـ٥٠ دي اتأكدت من ٤٠٠ حقيقي؛ الباقي تقدير محافظ
   لحد ما يدّونا الأرقام. القصّ هنا أأمن من ٤٠٠ وقت طلب حقيقي. */
export const CERVO_LIMITS = Object.freeze({ customer: 50, address: 200, storeName: 50, storeAddress: 100 });
const cut = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const digitsOnly = (v) => {
  const t = String(v == null ? "" : v).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).trim();
  return /^[0-9]{1,6}$/.test(t) ? t : "";
};
export function cervoAsciiLine(order = {}) {
  const addr = order.address || {};
  const far = farZoneOfRow(order);
  const b = digitsOnly(addr.building), f = digitsOnly(addr.floor), ap = digitsOnly(addr.apartment);
  return [
    "PREPAID - collect nothing",
    far ? `FAR TRIP ${far.km} km` : "",
    b && `Bldg ${b}`, f && `Floor ${f}`, ap && `Apt ${ap}`,
    leaveAtDoor(addr) ? "LEAVE AT DOOR" : "",
    "Call customer on arrival",
  ].filter(Boolean).join(" | ");
}
export function cervoNotes(order = {}, { ascii = true } = {}) {
  const addr = order.address || {};
  const far = farZoneOfRow(order);
  const dd = districtOfRow(order);
  const full = fullAddressText(addr);
  const dn = deliveryNotesOf(order);
  /* طلب قديم (قبل ما ملاحظات التوصيل تتفصل عن ملاحظات الأكل) ملاحظته
     الوحيدة بتفضل توصل المندوب — تعليمات توصيل مكتوبة هناك ماتضيعش. */
  const legacy = notesSplit(order) ? "" : String(order.notes || "").trim();
  const ar = [
    far ? `مشوار بعيد ${far.km} كم` : "",
    dd ? `توصيل حي ${dd.district}` : "",
    leaveAtDoor(addr) ? DOOR_NOTE : "",
    full && `العنوان: ${full}`,
    dn && `ملاحظات التوصيل: ${dn}`,
    legacy && `ملاحظة العميل: ${legacy}`,
  ].filter(Boolean).join(" — ");
  const body = ar || PREPAID_NOTE;
  return (ascii ? `${cervoAsciiLine(order)} || ${body}` : body).slice(0, CERVO_NOTES_MAX);
}

/* العنوان: عندهم حقول إحداثيات منفصلة (customerlat/lng) فالنقطة واصلة
   مضمونة — يعني النص هنا **إضافة** مش بديل، عكس لاجلك اللي العنوان فيها
   هو النقطة نفسها. الافتراضي: العنوان المقروء + النقطة في آخره، عشان لو
   تطبيق الكابتن بيبحث بالنص برضه يلاقي المكان.
   settings.delivery.cervoAddressFormat = "coords" بيخلّيه النقطة بس. */
export function cervoAddress(addr = {}, format = "full") {
  if (format === "coords") return mapPoint(addr) || locationText(addr, { withPin: false });
  return readableAddress(addr, { withPin: true });
}

/* ═══ الحارس: الطلب مدفوع، المندوب مايحصّلش ═══════════════════════════════ */
export const CERVO_PAYMENT = "ONLINE";
export function assertPrepaid(p) {
  const bad = [];
  if (p.payment !== CERVO_PAYMENT) bad.push(`payment=${JSON.stringify(p.payment)} (لازم "ONLINE")`);
  if (p.ispaid !== true) bad.push(`ispaid=${JSON.stringify(p.ispaid)} (لازم true)`);
  if (Number(p.price) !== 0) bad.push(`price=${JSON.stringify(p.price)} (لازم 0)`);
  if (bad.length) {
    throw Object.assign(
      new Error(`Cervo: الطلب مدفوع أونلاين والمندوب مايحصّلش — ${bad.join("، ")}`),
      { code: "CERVO_UNSAFE_PAYMENT", detail: bad });
  }
  return p;
}
/* تحقق قبل الشبكة: إحداثيات، جوال، id. فشل هنا رسالته واضحة بالعربي بدل
   400 مبهمة منهم. */
export function assertCervoPayload(p) {
  const bad = [];
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  if (!Number.isSafeInteger(Number(p.id)) || Number(p.id) <= 0) bad.push("id");
  if (!String(p.order_id || "")) bad.push("order_id");
  const cla = num(p.customerlat), clo = num(p.customerlng);
  if (!Number.isFinite(cla) || cla < -90 || cla > 90 || cla === 0) bad.push("customerlat");
  if (!Number.isFinite(clo) || clo < -180 || clo > 180 || clo === 0) bad.push("customerlng");
  const sla = num(p.storelat), slo = num(p.storelng);
  if (!Number.isFinite(sla) || sla === 0) bad.push("storelat");
  if (!Number.isFinite(slo) || slo === 0) bad.push("storelng");
  if (!/^\+9665\d{8}$/.test(String(p.mobile || ""))) bad.push("mobile");
  if (bad.length) {
    throw Object.assign(new Error(`Cervo: بيانات ناقصة/غلط في الطلب — ${bad.join("، ")}`),
      { code: "CERVO_BAD_PAYLOAD", detail: bad });
  }
  return assertPrepaid(p);
}

/* جسم POST /order — دالة صافية عشان تتجرّب من غير شبكة (ودي اللي بنطبعها
   في اللوج قبل أول إرسال حقيقي). */
export function cervoPayload(order = {}, cfg = {}) {
  const addr = order.address || {};
  const p = {
    id: cervoNumericId(order.order_no),
    order_id: String(order.order_no || ""),
    customer: cut((order.customer && order.customer.name) || "العميل", CERVO_LIMITS.customer) || "العميل",
    mobile: e164((order.customer && order.customer.phone) || order.phone_norm || ""),
    address: cut(cervoAddress(addr, cfg.cervoAddressFormat === "coords" ? "coords" : "full"), CERVO_LIMITS.address),
    customerlat: Number(addr.latitude),
    customerlng: Number(addr.longitude),
    storelat: Number(cfg.storeLat),
    storelng: Number(cfg.storeLng),
    /* ثوابت — مش إعدادات. شوف assertPrepaid. */
    price: 0,
    payment: CERVO_PAYMENT,
    ispaid: true,
    notes: cervoNotes(order, { ascii: cfg.cervoAsciiLine !== false }),
    storeName: cut(cfg.cervoStoreName || cfg.pickupContactName || "فريش كاتس", CERVO_LIMITS.storeName),
    storeAddress: cut(cfg.cervoStoreAddress || cfg.pickupAddress || "فريش كاتس — السلامة، جدة", CERVO_LIMITS.storeAddress),
  };
  if (cfg.cervoWebhookUrl) p.callback = String(cfg.cervoWebhookUrl);
  const km = Number(cfg.routeKm);
  if (Number.isFinite(km) && km > 0) p.distance = Math.round(km * 1000);   // عندهم بالمتر
  const exp = Number(cfg.cervoExpireMin);
  if (Number.isFinite(exp) && exp > 0) p.ExpireDate = Math.round(exp);
  const rad = Number(cfg.cervoDriverRadiusM);
  if (Number.isFinite(rad) && rad > 0) p.DriverRemoteDistance = Math.round(rad);
  return assertCervoPayload(p);
}

/* نسخة للعرض في اللوج/اللوحة: الجوال مقنّع. */
export function maskedPayload(p) {
  const m = String(p && p.mobile || "");
  return { ...p, mobile: m ? `${m.slice(0, 6)}***${m.slice(-2)}` : m };
}

/* ═══ التكلفة ═══════════════════════════════════════════════════════════
   مافيش تسعيرة قبل الإرسال في الـAPI بتاعهم (ولا حتى بعد التوصيل) — يعني
   التكلفة بتيجي من فاتورتهم بس. فبنسيب خانة تقدير قابلة للتعديل من اللوحة،
   ولو مش متملّية بنسيب التكلفة **فاضية** بدل ما نخترع رقم: صفر مزيّف كان
   هيوري عمر ربح مش موجود. الشحنة من غير تكلفة بتتعدّ في تقرير المطابقة
   (shipments_without_cost) زي أي شحنة خارجية. */
export const DEFAULT_CERVO_CONTRACT = Object.freeze({
  /* known = «عمر أكّد الأسعار دي معاهم». افتراضياً **false** — والرقم اللي
     تحته تقدير، مش حقيقة.

     الافتراضي = نفس تسعيرة لاجلك (١٩٫٥٥ شامل الضريبة لحد ١٠ كم، و٢٫٣٠/كم
     بعدها). عمر اختاره عشان خانة التكلفة في الحسابات ماتفضلش فاضية طول
     التجربة — بس كل شحنة بالرقم ده بتتعلّم `costAssumed` وبتتعدّ في
     «شحنات من غير تكلفة مؤكدة» لحد ما تسعيرتهم الحقيقية تيجي. */
  known: false,          // عمر لسه ما أكّدش الأسعار معاهم
  baseFee: 19.55,        // شامل الضريبة — تقدير: نفس لاجلك
  includedKm: 10,
  perKm: 2.30,           // شامل الضريبة، لكل كم بعد includedKm — تقدير: نفس لاجلك
  minFare: null,
  vatPct: 15,
  vatIncluded: true,     // هل الأرقام فوق شاملة الضريبة؟
  assumedNote: "تقديري — مش مؤكد (نفس تسعيرة لاجلك لحد ما Cervo تبعت تسعيرتها)",
});
export function cervoContract(deliverySettings = {}) {
  const raw = (deliverySettings || {}).cervoContract;
  const c = { ...DEFAULT_CERVO_CONTRACT, ...(raw && typeof raw === "object" ? raw : {}) };
  const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const out = {
    known: Boolean(c.known),
    baseFee: n(c.baseFee), includedKm: Number(c.includedKm) || 0,
    perKm: n(c.perKm), minFare: n(c.minFare),
    vatPct: Number.isFinite(Number(c.vatPct)) ? Number(c.vatPct) : 15,
    vatIncluded: c.vatIncluded !== false,
    assumedNote: String(c.assumedNote || DEFAULT_CERVO_CONTRACT.assumedNote),
  };
  if (out.baseFee === null || !Number.isFinite(out.baseFee)) out.known = false;
  return out;
}
const r2 = (n) => Math.round(Number(n) * 100) / 100;
/* بترجّع {cost, known, assumed}.

   تلات حالات، مش اتنين:
     • فيه رقم و`known` ⇒ تكلفة مؤكدة (assumed=false) — بتتحسب في الأرباح عادي.
     • فيه رقم من غير `known` ⇒ **تقدير** (assumed=true) — الرقم بيتخزّن عشان
       الحسابات ماتبقاش فاضية، بس الشحنة بتتعلّم وبتتعدّ في «من غير تكلفة
       مؤكدة» في المطابقة. ده الوضع طول تجربة Cervo.
     • مفيش رقم أصلاً ⇒ null — أحسن من صفر بيوري ربح مش موجود. */
export function cervoCostFor(km, deliverySettings = {}) {
  const c = cervoContract(deliverySettings);
  if (c.baseFee === null || !Number.isFinite(c.baseFee)) {
    return { cost: null, known: false, assumed: false, contract: c };
  }
  const extra = Math.max(0, (Number(km) || 0) - c.includedKm);
  let v = c.baseFee + (c.perKm || 0) * extra;
  if (c.minFare != null) v = Math.max(v, c.minFare);
  if (!c.vatIncluded) v *= 1 + c.vatPct / 100;
  return { cost: r2(v), known: c.known, assumed: !c.known, contract: c };
}

/* ═══ HTTP ══════════════════════════════════════════════════════════════
   دالة خاصة بيهم لأن ردودهم مش دايماً كائن JSON:
     • إنشاء طلب ناجح → نص GUID بين علامتين تنصيص ("a1b2…") = JSON string.
     • خطأ 400 → جملة إنجليزية عادية، أحياناً من غير علامات = مش JSON أصلاً.
   الدالة العامة في couriers.js بتفترض كائن فيه .message، فكانت هتبلع
   الرسالة الحقيقية وتسيبنا مع رقم حالة. */
async function cervoHttp(path, { method = "GET", body, timeoutMs = 25000 } = {}) {
  const token = CERVO_TOKEN();
  if (!token) {
    throw Object.assign(new Error("Cervo: CERVO_TOKEN ناقص"), { code: "COURIER_UNCONFIGURED" });
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${CERVO_BASE()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    throw Object.assign(new Error(`Cervo ${path}: ${e.name === "AbortError" ? "انتهت المهلة" : e.message}`),
      { code: "COURIER_ERROR", status: null });
  } finally { clearTimeout(t); }

  const text = await resp.text();
  let data = null, isString = false;
  try { data = JSON.parse(text); } catch { data = null; }
  if (typeof data === "string") { isString = true; }
  if (data === null && text) { data = text.trim(); isString = true; }

  if (!resp.ok) {
    const msg = isString ? String(data)
      : (data && (data.message || data.error || data.title)) || `HTTP ${resp.status}`;
    throw Object.assign(new Error(`Cervo ${path}: ${String(msg).slice(0, 300)}`),
      { code: "COURIER_ERROR", status: resp.status, resp: isString ? { message: String(data).slice(0, 300) } : data,
        providerMessage: String(msg).slice(0, 300) });
  }
  return { data, text, isString, status: resp.status };
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* رد الإنشاء: نص GUID عادةً، بس بنقبل كائن فيه id/uid لو غيّروا الشكل. */
export function pickCervoUid(data) {
  if (typeof data === "string") {
    const s = data.trim().replace(/^"|"$/g, "");
    return GUID_RE.test(s) ? s : (s && s.length <= 64 && !/\s/.test(s) ? s : null);
  }
  if (data && typeof data === "object") {
    for (const k of ["id", "uid", "order_uid", "orderId", "data"]) {
      const v = data[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/* GET /order/{uid} → شكل موحّد.
   بيتنادى من التتبع ومن **التحقق من الويبهوك**.
   الرد الحقيقي (٢٢/٩) camelCase: {id, db_id, driverName, driverMobile, status,
   orderStatus[], tracking} — الوثيقة كاتباهم PascalCase. بنقبل الشكلين. */
export function normalizeCervoOrder(o, offsetHours = CERVO_TZ_OFFSET_DEFAULT) {
  if (!o || typeof o !== "object") return null;
  const code = o.Status ?? o.status ?? null;
  const hist = Array.isArray(o.OrderStatus) ? o.OrderStatus : (Array.isArray(o.orderStatus) ? o.orderStatus : []);
  const name = o.DriverName ?? o.driver_name ?? o.driverName ?? null;
  const phone = o.DriverMobile ?? o.driver_mobile ?? o.driverMobile ?? null;
  return {
    uid: o.id != null ? String(o.id) : null,
    dbId: o.db_id != null ? String(o.db_id) : null,
    statusCode: code != null ? Number(code) : null,
    status: cervoStage(code),
    rawStatus: code != null ? String(code) : null,
    driver: (name || phone) ? { name: name || null, phone: phone || null, source: "cervo" } : null,
    tracking: typeof o.tracking === "string" && o.tracking ? o.tracking : null,
    history: hist.map((h) => ({
      code: Number(h.Status ?? h.status),
      status: cervoStage(h.Status ?? h.status),
      at: cervoTimeToIso(h.Date ?? h.date, offsetHours),
    })).filter((h) => Number.isFinite(h.code)),
    raw: o,
  };
}

/* ── الوقت: قاسناه، مش صدّقنا اللي اتقال ────────────────────────────────
   المورّد قال «التوقيت رياض». **القياس بيقول UTC.**
   ٢٢/٩، طلب حقيقي على الساندبوكس: إحنا أنشأناه الساعة 10:18:34 UTC
   (= 13:18 بتوقيت الرياض)، وهم سجّلوا المحطة `"2026-09-22 10:18"`.
   يعني تواريخهم UTC حرفياً، مش رياض.

   لو صدّقنا كلامهم وطرحنا ٣ ساعات، كل محطة كانت هتتسجّل **متأخرة ٣ ساعات
   عن الحقيقة** — والكابتن يبان إنه وصل المطعم قبل ما الطلب يتعمل أصلاً.

   `cervoTimeOffsetHours` في الإعدادات موجود عشان لو غيّروها بكرة نظبّطها
   من غير نشر: 0 = UTC (المقاس)، 3 = رياض (اللي قالوه). */
export const CERVO_TZ_OFFSET_DEFAULT = 0;
export function cervoTimeToIso(s, offsetHours = CERVO_TZ_OFFSET_DEFAULT) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || "").trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  const off = Number.isFinite(Number(offsetHours)) ? Number(offsetHours) : CERVO_TZ_OFFSET_DEFAULT;
  return new Date(Date.UTC(+Y, +Mo - 1, +D, +H - off, +Mi, +(S || 0))).toISOString();
}
/* الاسم القديم فضل عشان ما نكسرش حاجة — بس هو دلوقتي UTC زي المقاس. */
export const riyadhToIso = (s) => cervoTimeToIso(s, CERVO_TZ_OFFSET_DEFAULT);
/* العكس — للطلبات المجدولة. بنفس الإزاحة المقاسة (UTC)، عشان الطلب
   المجدول ما يتحجزش ٣ ساعات في غير وقته. */
export function isoToCervoTime(iso, offsetHours = CERVO_TZ_OFFSET_DEFAULT) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return null;
  const off = Number.isFinite(Number(offsetHours)) ? Number(offsetHours) : CERVO_TZ_OFFSET_DEFAULT;
  const r = new Date(d.getTime() + off * 3600_000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${r.getUTCFullYear()}-${p(r.getUTCMonth() + 1)}-${p(r.getUTCDate())} ${p(r.getUTCHours())}:${p(r.getUTCMinutes())}:${p(r.getUTCSeconds())}`;
}
export const isoToRiyadh = (iso) => isoToCervoTime(iso, CERVO_TZ_OFFSET_DEFAULT);

/* ═══ تحليل الويبهوك ════════════════════════════════════════════════════
   جسمهم: {order_id (الـGUID بتاعهم), partner_ref (اللي بعتناه), driver_name,
   driver_mobile, order_status, store_distance, customer_distance, cancel,
   tracking}.

   الجسم الحقيقي (٢٢/٩، ويبهوك وصل فعلاً) فيه حقول **مش في الوثيقة**:
     store_id: 3017        ← عندهم معرّف محل لينا، رغم إنهم قالوا مفيش
     member, isRiderChange ← isRiderChange = الكابتن اتغيّر
   و`partner_ref` بيرجع **الـid الرقمي** (1790072314698) مش رقم طلبنا النصّي.

   **مفيش توقيع ولا سرّ** — يعني أي حد يعرف الرابط يقدر يبعت رسالة تحرّك
   حالة طلب. فالراوت بتاعهم في delivery.js **مابياخدش الجسم على ذمّته**:
   بيستعمله كإشارة بس، وبيسأل GET /order/{uid} ويصدّق الرد ده.
   الدالة دي بتقرا الشكل وبس. */
export function parseCervoWebhook(b) {
  if (!b || typeof b !== "object") return null;
  const uid = b.order_id ?? b.orderId ?? b.uid ?? null;
  const ref = b.partner_ref ?? b.partnerRef ?? b.order_ref ?? null;
  const code = b.order_status ?? b.orderStatus ?? b.status ?? null;
  if (uid == null && ref == null) return null;
  /* partner_ref ممكن يرجع بشكل الـid الرقمي (1789…) أو رقم طلبنا كامل
     (W1789…). بنرجّع الاتنين والمطابقة في delivery.js بتجرّبهم. */
  const refStr = ref != null ? String(ref).trim() : null;
  const name = b.driver_name ?? b.driverName ?? null;
  const phone = b.driver_mobile ?? b.driverMobile ?? null;
  return {
    provider: "cervo",
    ref: uid != null ? String(uid) : null,          // مرجعهم (provider_ref عندنا)
    orderNo: refStr && /[A-Za-z]/.test(refStr) ? refStr : null,  // رقمنا لو رجع كامل
    numericRef: refStr && /^\d+$/.test(refStr) ? refStr : null,  // الـid الرقمي
    status: cervoStage(code),
    statusCode: code != null && Number.isFinite(Number(code)) ? Number(code) : null,
    rawStatus: code != null ? String(code) : null,
    driver: (name || phone) ? { name: name || null, phone: phone || null, source: "cervo" } : null,
    tracking: typeof b.tracking === "string" && b.tracking ? b.tracking : null,
    cancelReason: b.cancel ? String(b.cancel).slice(0, 200) : null,
    /* حقول اتكشفت من ويبهوك حقيقي — مش في وثيقتهم */
    storeId: b.store_id != null ? String(b.store_id) : null,
    riderChanged: b.isRiderChange === true,
    storeDistance: b.store_distance != null ? Number(b.store_distance) : null,
    customerDistance: b.customer_distance != null ? Number(b.customer_distance) : null,
    cost: null,     // مفيش تكلفة في أي رد من ردودهم
  };
}

/* ═══ المزوّد ═══════════════════════════════════════════════════════════ */
export const cervo = {
  id: "cervo",
  label: "Cervo Delivery",
  configured: () => Boolean(CERVO_TOKEN()),
  missing: () => (CERVO_TOKEN() ? [] : ["CERVO_TOKEN"]),
  needsRef: false,
  /* نفس الـid بيحدّث الطلب بدل ما ينسخه (موثّق عندهم) — فإعادة الإرسال
     بعد محاولة ضايعة **مش** بتعمل مندوبين. delivery.js بيستعمل العلم ده
     عشان يفك القفل بدل ما يستنى قرار بني آدم. */
  idempotentCreate: true,

  async reference() {
    /* /health عندهم بيقرا التوكن كمان (اكتشفناه — من غير هيدر بيرد 401)،
       فهو فحص صحة واعتماد في نداء واحد. */
    const r = await cervoHttp("/health");
    const d = r.data && typeof r.data === "object" ? r.data : {};
    return {
      cities: [], vehicles: [],
      health: { status: d.status || null, version: d.version || null, message: d.message || null },
      note: "Cervo مابتوفّرش قوايم مدن ولا مركبات — نقطة الاستلام إحداثيات مع كل طلب.",
    };
  },

  /* GET /health لوحده — الشاشة بتستعمله كفحص اتصال سريع. */
  async health() {
    const r = await cervoHttp("/health");
    return r.data && typeof r.data === "object" ? r.data : { status: String(r.data || "") };
  },

  async dispatch(order, cfg = {}) {
    const payload = cervoPayload(order, cfg);
    const created = await cervoHttp("/order", { method: "POST", body: payload });
    const uid = pickCervoUid(created.data);
    if (!uid) {
      throw Object.assign(new Error(`Cervo: مارجعش مرجع للطلب — ${String(created.text || "").slice(0, 200)}`),
        { code: "COURIER_ERROR", status: created.status, resp: { message: String(created.text || "").slice(0, 300) } });
    }
    /* الإنشاء بيرجّع الـGUID وبس — لا حالة ولا كابتن ولا رابط تتبع. سؤال
       واحد بعده بيجيب التلاتة، وكمان بيأكّد إن الطلب اتسجّل فعلاً عندهم.
       فشله مايوقعش الإرسال: الطلب اتسجّل، والاستطلاع بعد دقيقة هيكمّل. */
    let look = null;
    try { look = normalizeCervoOrder((await cervoHttp(`/order/${encodeURIComponent(uid)}`)).data); }
    catch (e) { console.error(`[cervo] تأكيد ${order.order_no} بعد الإنشاء فشل: ${e.message}`); }

    /* التكلفة: `assumed` معناها إن الرقم من تقدير اللوحة مش من عندهم —
       بيتخزّن على الشحنة وشاشة المطابقة بتعدّها «من غير تكلفة مؤكدة». */
    const { cost, assumed } = cervoCostFor(cfg.routeKm, cfg);
    return {
      ref: uid,
      orderNumber: (look && look.dbId) || String(payload.id),
      cost,
      costAssumed: assumed,
      driver: (look && look.driver) || null,
      status: (look && look.status) || "pending",
      rawStatus: (look && look.rawStatus) || null,
      tracking: (look && look.tracking) || null,
      raw: { uid, payload: maskedPayload(payload), order: look ? look.raw : null },
    };
  },

  async track(sh) {
    const ref = sh && (sh.provider_ref || sh.fa_order_id);
    if (!ref) return null;
    const o = normalizeCervoOrder((await cervoHttp(`/order/${encodeURIComponent(ref)}`)).data);
    if (!o) return null;
    return {
      status: o.status,
      rawStatus: o.rawStatus,
      driver: o.driver,
      cost: null,          // مفيش تكلفة في الـAPI — بتيجي من الفاتورة
      tracking: o.tracking,
      history: o.history,
      raw: o.raw,
    };
  },

  /* ── الاسترجاع ────────────────────────────────────────────────────────
     مفيش عندهم بحث بمرجعنا (مافيش GET /orders خالص — بيرد 404)، فالطريق
     الوحيد هو اللي وثيقتهم نفسها بتقوله: **إعادة POST بنفس الـid بتحدّث
     الطلب وترجّع نفس الـGUID**. يعني الاسترجاع = إعادة إرسال آمنة.
     محتاجة صفّ الطلب، فلو اتنادت من غيره (المسار القديم) بترجّع
     unsupported بدل ما تخمّن. */
  async lookup(orderNo, cfg = {}, order = null) {
    if (!order || !order.order_no) {
      return { found: false, unsupported: true, tried: [],
        note: "Cervo مافيهاش بحث برقمنا — الاسترجاع بإعادة POST /order بنفس الـid" };
    }
    try {
      const created = await cervoHttp("/order", { method: "POST", body: cervoPayload(order, cfg) });
      const uid = pickCervoUid(created.data);
      if (!uid) return { found: false, tried: [{ path: "/order", status: created.status, matched: false }] };
      let look = null;
      try { look = normalizeCervoOrder((await cervoHttp(`/order/${encodeURIComponent(uid)}`)).data); } catch {}
      return {
        found: true, ref: uid, via: "POST /order (نفس الـid بيحدّث)",
        status: (look && look.status) || "pending",
        rawStatus: (look && look.rawStatus) || null,
        driver: (look && look.driver) || null,
        tracking: (look && look.tracking) || null,
        raw: look ? look.raw : { uid },
        tried: [{ path: "/order", status: created.status, matched: true }],
      };
    } catch (e) {
      return { found: false, error: String(e.message || e).slice(0, 200),
        tried: [{ path: "/order", status: (e && e.status) || null }] };
    }
  },

  async cancel(sh, reason) {
    const ref = sh && (sh.provider_ref || sh.fa_order_id);
    if (!ref) throw Object.assign(new Error("Cervo: مفيش مرجع للشحنة عشان تتلغي"), { code: "COURIER_ERROR" });
    const path = `/cancelorder/${encodeURIComponent(ref)}`;
    /* وثيقتهم بتقول POST و DELETE الاتنين. بنبدأ بـPOST، ولو رد 404/405
       بنجرّب DELETE — نفس الحارس اللي عملناه للاجلك لما مسارها اتغيّر. */
    let raw;
    try {
      raw = (await cervoHttp(path, { method: "POST", body: { reason: String(reason || "cancelled by restaurant").slice(0, 200) } })).data;
    } catch (e) {
      if (![404, 405].includes(Number(e && e.status))) throw e;
      raw = (await cervoHttp(path, { method: "DELETE" })).data;
    }
    /* مفيش رسوم إلغاء ولا مبلغ مسترد في أي رد — نفس حكاية لاجلك. */
    return { fee: null, refund: null, raw: typeof raw === "string" ? { message: raw } : raw };
  },

  /* ── ليه السرّ الناقص مش رفض (٢٢/٩، من ويبهوك حقيقي) ──────────────────
     ظبّطنا CERVO_WEBHOOK_SECRET، وأول ويبهوك حقيقي منهم **اترفض ٤٠١** —
     وحاولوا ٣ مرات وفشلوا ٣ مرات. السبب: هيدرزهم مافيهاش أي سرّ خالص
     (بيبعتوا `delivery-company` بس)، فالسرّ عندنا كان بيقفل الباب في وشّ
     الرسايل الحقيقية بدل ما يحميه.

     فبقى ٣ حالات بدل اتنين:
       pass   → السرّ اتبعت وصح
       absent → مفيش سرّ في الرسالة (ده وضعهم الطبيعي) ⇒ نكمّل
       fail   → سرّ اتبعت وغلط ⇒ ٤٠١

     ومش ضعف: الأمان الحقيقي مش السرّ أصلاً — إحنا مابناخدش حالة من جسم
     الرسالة خالص، بنسأل GET /order/{uid} ونطبّق ردّهم. يعني حتى رسالة
     مزوّرة تماماً مابتقدرش تحرّك طلب. */
  verifyWebhook(headers = {}, body = {}) {
    const secret = CERVO_WH_SECRET();
    if (!secret) return "absent";
    const h = (k) => String(headers[k] || headers[String(k).toLowerCase()] || "");
    const sent = [
      h("x-cervo-signature"), h("x-webhook-secret"), h("x-secret"), h("x-api-key"),
      h("authorization").replace(/^Bearer\s+/i, ""),
      String((body && body.secret) || ""), String((body && body.webhook_secret) || ""),
    ].filter(Boolean);
    if (!sent.length) return "absent";
    return sent.some((v) => v === secret) ? "pass" : "fail";
  },

  parseWebhook: parseCervoWebhook,
};

export default cervo;
