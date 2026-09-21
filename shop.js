/* ═══════════════════════════════════════════════════════════════════════════
   SHOP — the online-order lifecycle on OUR OWN payment rail.

   One row in shop_orders is the truth for one online order, from cart to
   doorstep:

     pending_payment → paid → pos_created → accepted
       → (delivery) courier_requested → courier_assigned → on_the_way → delivered
       → (pickup)   ready is signalled by the staff panel, not the POS API
     failure exits: expired, paid_pos_failed (sweep retries), rejected_refunded,
     courier_cancelled.

   Money model (matters for the reconciliation screen): the POS order carries
   the FOOD total only — TabSense's calculate-order knows nothing about our
   delivery fee. MyFatoorah charges food + delivery + tip. So:
     MyFatoorah settlement  = Σ shop_orders.total
     POS (TabSense)         = Σ shop_orders.subtotal
     the gap                = Σ delivery_fee + tip   ← BY DESIGN, not a leak.
   (Task #6 probes whether adjustments.charges can carry the fee into the POS
   total; if yes we can fold it in later.)

   Payment trust: confirmOrder() is the ONLY door to "paid", and it always
   re-checks GetPaymentStatus — the webhook, the returning browser, and the
   sweep all funnel through it, so a forged callback can't mint an order.

   Omar's rule (2026-08-11): cashier rejects a paid order → refund runs
   AUTOMATICALLY, no approval. The sweep does it exactly once per order
   (refund_id guards the retry loop).
═══════════════════════════════════════════════════════════════════════════ */

import * as tsstore from "./tsstore.js";
import { msisdn, readableAddress, leaveAtDoor, farZoneOfRow, deliveryNotesOf, courierNotes } from "./couriers.js";
import { districtOfRow } from "./districts.js";
import { checkPersonName, NAME_MSG, NAME_MAX } from "./person-name.js";
import { plausibleName } from "./posnames.js";
// ضريبة سطور الباقة — نفس الثابت اللي التوزيع اتعمل بيه، عشان الإجمالي يرجع للسعر بالظبط
import { VAT_RATE as BUNDLE_VAT } from "./bundles.js";
import { MULTIPLY as MONEY_MULTIPLY, rescaleItems, stampMf, scaleOf } from "./money.js";
import { isOpenNow } from "./carts.js";
import { soldOutOf, soldOutLines, soldOutMessage } from "./soldout.js";
import { dispatchDue, dispatchDelayOf } from "./delivery.js";
import { makeStaffNotifier, slaAlertText, posFailedText, tabsenseDownText } from "./staffalerts.js";
import { sendSms as sendStaffSms } from "./accounts.js";
import {
  parseCheckoutMeta, fireServerPurchase,
  classifySource, mergeSessionAttribution, SESSION_ATTR_SQL,
} from "./checkout-meta.js";
import { resumeKey } from "./resume-key.js";
import { recordCheckoutConsent } from "./consent.js";
import { makeNameResolver } from "./product-names.js";

/* ناقل أحداث الطلب (W1-01) وترحيل أعمدة shop_orders — تحميل كسول ودفاعي (W1-02):
   لو الملفات مش موجودة أو الـimport وقع، shop.js بيشتغل عادي والأحداث بتتجاهل.
   الإطلاق fire-and-forget وعمره ما يرمي في وش المنادي. */
let _orderEvents = null;
const _orderEventsReady = import("./order-events.js")
  .then((m) => { _orderEvents = m; return m; })
  .catch((e) => { console.error("[shop] order-events unavailable:", e.message); return null; });
const _ordersSchemaReady = import("./orders-schema.js")
  .catch((e) => { console.error("[shop] orders-schema unavailable:", e.message); return null; });

export function makeOrderEmitter(override) {
  return function emitOrderEvent(name, opts) {
    try {
      if (typeof override === "function") {
        const p = override(name, opts);
        if (p && typeof p.catch === "function") p.catch(() => {});
        return;
      }
      if (_orderEvents) { _orderEvents.emitOrder?.(name, opts); return; }
      _orderEventsReady.then((m) => { try { m?.emitOrder?.(name, opts); } catch {} }).catch(() => {});
    } catch { /* الأحداث عمرها ما توقّع الطلب */ }
  };
}

/* فشل الشريك بعد كل المحاولات (مفيش مسار احتياطي). الاسم partner_failed لو
   ORDER_EVENTS بيعرفه، وإلا null ومابيطلعش حدث منفصل (pos_push outcome:"failed"
   + order_status→paid_pos_failed كفاية). ماينفعش نستعير partner_fallback: معناه
   «مسار بديل» اللي مابقاش موجود، وفحص الصحة (٠٧) بيعدّه كرجوع للمسار القديم. */
export const PARTNER_FAILED_EVENT = () => {
  try { return _orderEvents?.isOrderEvent?.("partner_failed") ? "partner_failed" : null; }
  catch { return null; }
};

/* آخر approval_status في ويب هوك تاب سينس (order-updated / order-paid …).
   المسار: resource.statuses_slugs.approval_status. دالة صافية: بترجع القيمة
   زي ما هي (نص مقصوص) أو null لو المسار مش موجود/اتغيّر — مابترميش. */
export function approvalFromWebhook(payload) {
  try {
    let p = payload;
    if (typeof p === "string") { try { p = JSON.parse(p); } catch { return null; } }
    const v = p?.resource?.statuses_slugs?.approval_status;
    if (v == null || typeof v === "object") return null;
    const s = String(v).trim();
    return s || null;
  } catch {
    return null;
  }
}

const env = (k, d) => (process.env[k] || d || "").toString().trim();
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const OPTION_ID = { pickup: 2, delivery: 3 };

// Customer-facing stages, in order, with Arabic labels for the tracking page.
export const STAGES = {
  pending_payment: { label: "بانتظار الدفع", step: 0 },
  paid: { label: "تم الدفع", step: 1 },
  pos_created: { label: "وصل المطعم", step: 1 },
  accepted: { label: "المطعم قبل طلبك وبدأ التجهيز", step: 2 },
  courier_requested: { label: "بنطلب لك مندوب", step: 3 },
  courier_assigned: { label: "المندوب في الطريق للمطعم", step: 3 },
  on_the_way: { label: "طلبك في الطريق إليك", step: 4 },
  delivered: { label: "تم التوصيل — بالهنا والشفا", step: 5 },
  rejected_refunded: { label: "اعتذر المطعم عن الطلب — تم استرجاع المبلغ", step: -1 },
  /* ما نقولش «تم الاسترجاع» والاسترجاع فشل.
     كان في الكود القديم مسار بيحط الطلب على rejected_refunded حتى لما
     MakeRefund بترمي — يعني العميل ياخد رسالة «تم استرجاع المبلغ كاملاً
     لبطاقتك» وفلوسه لسه معانا. ده أسوأ من عطل تقني: ده وعد كاذب بفلوس.
     الحالة دي بتفصل الحقيقة، وبتفضل ظاهرة كإنذار أحمر في اللوحة لحد ما
     حد يسترجع بإيده. */
  refund_failed: { label: "جاري استرجاع مبلغك — فريقنا بيتابع معك", step: -1 },
  courier_cancelled: { label: "تعثر التوصيل — جاري المتابعة", step: -1 },
  paid_pos_failed: { label: "تم الدفع — جاري تأكيد الطلب", step: 1 },
  expired: { label: "انتهت صلاحية الطلب", step: -1 },
};

/* ═══════════════════════════════════════════════════════════════════════════
   الاسترجاع — القرار متفصّل عن التنفيذ

   قاعدة عمر (2026-08-11): الكاشير يرفض طلب مدفوع ⇒ استرجاع تلقائي من غير
   موافقة. والفلوس دي فلوس عملاء حقيقيين، فالمنطق لازم يتجرّب أوفلاين من
   غير MyFatoorah ولا قاعدة بيانات — عشان كده القرار دالة صافية.

   القواعد:
     • مرة واحدة بس. refund_id موجود ⇒ خلاص. (MakeRefund مش idempotent —
       نداءان معناهم فلوس مرتين.)
     • من غير mf_payment_id مفيش حاجة تترجع: الطلب ما وصلش لدفع أصلاً.
     • المبلغ = `total` (أكل + توصيل + بقشيش) — اللي العميل دفعه بالظبط،
       مش `subtotal`. غلطة هنا معناها إن العميل بيدفع تمن التوصيلة على
       طلب اعتذرنا عنه.                                                     */
/* ═══════════════════════════════════════════════════════════════════════════
   صفوف الطلب → أصناف طلب الشريك. دالة صافية عشان تتجرّب أوفلاين.

   الباج (اتصلّح 2026-09-12): العميل يختار «كيلو» على المتجر، الفلوس تطلع
   صح، لكن **سطر نقطة البيع بينزل من غير وزن** والمطبخ مايعرفش يشوي كام.
   السبب إن الدالة دي كانت بترمي `variant_option_id` وهي بتحوّل الصفوف.

   الاختيار متخزّن أصلاً في `shop_orders.items` (اتأكدنا من الداتابيز: طلبات
   حقيقية مقبولة فيها variant_option_id = ٤٤/٤٥/٤٨/٥١/٥٦)، فهو بيعيش عبر
   إعادة المحاولات وبيظهر في اللوحة — كان بيضيع في آخر خطوة بس.

   `variant_name` و`bundle_name` بيتخزّنوا كمان عشان الكاشير والتقارير
   يقروا كلام مفهوم من غير ما يرجعوا يسألوا القايمة تاني.
═══════════════════════════════════════════════════════════════════════════ */
/* وسوم الباقة (bundle*) بيكتبها السيرفر وهو بيوسّع الباقة — أي صنف عادي
   جاي من المتصفح بتتشال منه، فالتقارير مايتزوّرش فيها عدد الباقات. */
export function stripBundleTags(it) {
  if (!it || typeof it !== "object") return it;
  const { bundle, bundle_name, bundle_slot, bundle_line, bundle_qty, ...rest } = it;
  if (rest.variant_name != null) rest.variant_name = String(rest.variant_name).slice(0, 40);
  if (rest.name != null) rest.name = String(rest.name).slice(0, 120);
  return rest;
}

/* الخصم لازم يوصل نقطة البيع (16 سبتمبر). قبل كده طلب الشريك كان بينزل بالسعر
   الكامل حتى لو العميل دفع بخصم (خصم دائم لرقم معيّن أو كوبون نسبة) — فإجمالي
   تاب سينس يطلع أكبر من اللي اتدفع والتسوية تبوظ. الشريك بيقبل أسعار السطور
   اللي بنحددها (زي الباقات)، فبنطبّق نفس النسبة اللي checkout طبّقها على
   الأصناف العادية بس — الباقات سعرها محسوب أصلاً ومابيتخصمش عليها. */
export function partnerItemsOf(row) {
  const pct = Math.max(0, Math.min(100, Number(row?.discount_percent) || 0));
  return (row?.items || []).map((it) => {
    const vo = Number(it.variant_option_id);
    const discounted = pct > 0 && !it.bundle;
    /* ملاحظة السطر في تذكرة المطبخ = اللي العميل كتبه بنفسه بس (16 سبتمبر). عمر
       بعت صورة التذكرة: «ضمن: بوكس اليوم الوطني ٩٦» تحت كل صنف — «الملاحظة نفسها
       تحت كل صنف مش مهمة طالما مش العميل الى كتبها». الخصم بيفضل مرة واحدة في
       ملاحظات الطلب فوق للكاشير. */
    const note = String(it.note || it.customer_note || "").trim().slice(0, 100) || null;
    // ريال صافي قبل الضريبة — الوحدة من وسم السطر نفسه (`mf`)، فالطلبات
    // القديمة المتخزّنة بالنانو تفضل تتقرا صح بعد النزول للميكرو.
    const base = Number(it.unit_amount) / scaleOf(it);
    return {
      productId: it.product_id,
      quantity: Number(it.quantity) || 1,
      unitPrice: discounted ? Math.round(base * (1 - pct / 100) * 1e6) / 1e6 : base,
      ...(Number.isInteger(vo) && vo > 0 ? { variantOptionId: vo } : {}),
      ...(it.variant_name ? { variantName: it.variant_name } : {}),
      ...(note ? { lineNote: note } : {}),
    };
  });
}

/* ملاحظات طلب نقطة البيع (الكاشير + المطبخ). عمر 2026-08-13: وقت الطلب ووقت
   الاستلام إجباري (بتوقيت الرياض). withFee = مسار الشريك (رسوم التوصيل كنص).
   الخصم مابيتكتبش (عمر 16 سبتمبر). «اتركه عند الباب🚪» لو العميل اختارها
   (عمر 18 سبتمبر) — قصيرة وجنب «توصيل» عشان تتشاف. */
export function posNotesOf(row, { withFee = false, now = Date.now() } = {}) {
  const hm = (t) => new Date(new Date(t).getTime() + 3 * 3600_000).toISOString().slice(11, 16);
  const delivery = row.option === "delivery";
  const feeNote = withFee && Number(row.delivery_fee) > 0 ? `توصيل ${Number(row.delivery_fee)}ر` : "";
  const far = farZoneOfRow(row);
  const dd = districtOfRow(row);
  return [
    delivery ? "توصيل" : "استلام",
    // «التوصيل بالحي»: مندوب بره لاجلك بيستلم الطلب — الكاشير لازم يعرف
    // إن مفيش كابتن جاي من الشركة، والمدير هو اللي هيرتّب من البوابة.
    dd ? `${dd.mode === "dispatch" ? "مندوب حي" : "توصيل بالحي"} ${dd.district}${dd.provider ? ` (${dd.provider.name})` : ""}🛵` : "",
    // المطبخ والكاشير لازم يعرفوا إن المشوار أطول من المعتاد (العميل وافق ودفع
    // رسوم مسافة إضافية) — بيأثر على وقت التجهيز وعلى طلب المندوب.
    far ? `مشوار بعيد ${far.km} كم🛵` : "",
    delivery && leaveAtDoor(row.address) ? "اتركه عند الباب🚪" : "",
    `طُلب ${hm(row.created_at)}`,
    row.option === "pickup" ? `استلام ${hm(now + 40 * 60_000)}` : "",
    feeNote,
    "مدفوع أونلاين✅",
    // ملاحظات الأكل بس (بتاعة الطلب) — ملاحظات التوصيل بتروح قسم التوصيل/المندوب (عمر ١٩/٩)
    String(row.notes || "").trim() ? `📝 ${String(row.notes).trim()}` : "",
  ].filter(Boolean).join(" - ");
}

/* سطر عنوان التوصيل في نقطة البيع: نفس نص المندوب من غير الإحداثيات
   (الحي، الشارع، المبنى، الدور، الشقة، العلامة، «اترك الطلب عند الباب»). */
export function posAddressLine(row) {
  const addr = row.address || {};
  if (row.option !== "delivery") return "استلام";
  const hasText = ["area", "street", "building"].some((k) => String(addr[k] || "").trim());
  return hasText ? readableAddress(addr).slice(0, 250) : "توصيل";
}

/* عنوان الطلب كما يتخزّن: «ملاحظات التوصيل» بتاعة العنوان (delivery_notes)
   بتتنضّف وبتتخزّن جوّه العنوان نفسه — المندوب والبوابة بيقروها من هناك.
   المفتاح بيفضل موجود لو المتجر بعته (حتى فاضي): ده اللي بيقول إن الطلب
   اتعمل بعد فصل الملاحظات (couriers.notesSplit). */
export function orderAddress(raw, option = "delivery") {
  if (!raw || typeof raw !== "object") return null;
  const a = { ...raw };
  if (option !== "delivery") delete a.delivery_notes;
  else if (a.delivery_notes !== undefined) {
    a.delivery_notes = String(a.delivery_notes == null ? "" : a.delivery_notes)
      .replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 150);
  }
  return a;
}

export function refundDecision(row, { maxAttempts = 3 } = {}) {
  if (!row) return { act: false, reason: "no_order" };
  if (row.refund_id) return { act: false, reason: "already_refunded", refundId: row.refund_id };
  if (!row.mf_payment_id) return { act: false, reason: "never_paid" };
  const amount = Number(row.total) || 0;
  if (!(amount > 0)) return { act: false, reason: "zero_amount" };
  /* بعد محاولات فاشلة متكررة بنبطّل نجرّب: كل محاولة فيها احتمال إن
     الاسترجاع نجح عندهم والرد ضاع في الطريق. بعد الحد ده الطلب بيفضل
     أحمر في اللوحة عشان بني آدم يشوفه ويسترجع بإيده. */
  if (Number(row.refund_attempts || 0) >= maxAttempts) {
    return { act: false, reason: "max_attempts", attempts: Number(row.refund_attempts) };
  }
  return { act: true, paymentId: String(row.mf_payment_id), amount };
}

/* ═══════════════════════════════════════════════════════════════════════════
   مراقب المهل (SLA) — شبكة الأمان للمرحلة اليدوية

   المرحلة الأولى فيها بني آدم في النص: الكاشير لازم يفتح لوحة شركة التوصيل
   ويكتب الطلب. والكاشير في عز الخدمة ممكن ينسى، أو ما يشوفش الشاشة، أو
   يكون واقف على الكاسة. **والفلوس اتاخدت خلاص** — فطلب بيقع هنا مش
   إزعاج، ده استرجاع وعميل ضايع.

   الدالة صافية عن قصد: بتاخد صورة الطلب وترجّع درجة الخطورة والخطوة
   المطلوبة، من غير قاعدة بيانات — فكل حالة اتفحصت في الاختبارات.

   الدرجات:
     1 = متأخر، الشاشة تولّع أحمر
     2 = تجاوز، رسالة للمدير على جواله
     3 = انتهى الوقت، تدخّل مالي (استرجاع)

   ليه الاسترجاع التلقائي بيحصل في حالة واحدة بس؟
   لو المطعم **ما قبلش** الطلب أصلاً، يبقى مفيش أكل اتعمل ومفيش كابتن
   اتبعت — العميل قاعد مستني على الفاضي، والاسترجاع هو الحل الصح والآمن.
   لكن لو المطعم قبل وجهّز الأكل، الاسترجاع التلقائي ممكن يرجّع فلوس طلب
   الكابتن ماسكه في إيده. الحالة دي بتروح لبني آدم، مش لكود.               */
export const DEFAULT_SLA = {
  posFailMinutes: 5,          // مدفوع وما وصلش النظام
  acceptMinutes: 8,           // في صندوق الطلبات الخارجية ومحدش قبله
  acceptBreachMinutes: 15,
  autoRefundNoAcceptMinutes: 25,  // ما اتقبلش خالص ⇒ استرجاع تلقائي
  handoffMinutes: 10,         // اتقبل، والكاشير ما دخّلوش على لوحة الشركة
  handoffBreachMinutes: 20,
  pickupMinutes: 25,          // اتدخّل على اللوحة، والكابتن ما جاش
  pickupBreachMinutes: 45,
  deliverMinutes: 45,         // خرج للعميل وما وصلش
  deliverBreachMinutes: 75,
};

export function slaCheck(o, cfg = {}, now = Date.now()) {
  const s = { ...DEFAULT_SLA, ...(cfg || {}) };
  const mins = (t) => (t ? Math.floor((now - new Date(t).getTime()) / 60000) : 0);
  const age = mins(o.created_at);
  const inStatus = mins(o.updated_at || o.created_at);
  const none = { level: 0, code: null, minutes: age };

  const at = (level, code, message, minutes, action) => ({ level, code, message, minutes, action: action || null });

  switch (o.status) {
    case "paid":
    case "paid_pos_failed":
      if (age >= s.posFailMinutes) {
        return at(2, "pos_stuck", `مدفوع من ${age} دقيقة ولسه ما وصلش النظام`, age, "retry_pos");
      }
      return none;

    case "pos_created":
      if (age >= s.autoRefundNoAcceptMinutes) {
        return at(3, "never_accepted",
          `${age} دقيقة والطلب ما اتقبلش — استرجاع تلقائي`, age, "auto_refund");
      }
      if (age >= s.acceptBreachMinutes) {
        return at(2, "accept_breach", `${age} دقيقة ومحدش قبل الطلب`, age, "accept_now");
      }
      if (age >= s.acceptMinutes) {
        return at(1, "accept_late", `${age} دقيقة في انتظار القبول`, age, "accept_now");
      }
      return none;

    case "accepted": {
      if (o.option !== "delivery") return none;
      // مهلة التحضير مش تأخير: الطلب مستني «جاهز» أو المهلة قبل ما نطلب الكابتن
      const hold = o.pos_ready_at ? 0 : Math.max(0, Number(s.dispatchDelayMin) || 0);
      const late = inStatus - hold;
      if (late >= s.handoffBreachMinutes) {
        return at(2, "handoff_breach",
          `${inStatus} دقيقة من القبول والطلب لسه ما اتدخّلش على لوحة شركة التوصيل`, inStatus, "manual_handoff");
      }
      if (late >= s.handoffMinutes) {
        return at(1, "handoff_late",
          `${inStatus} دقيقة — ادخّل الطلب على لوحة شركة التوصيل`, inStatus, "manual_handoff");
      }
      return none;
    }

    case "courier_requested":
    case "courier_assigned":
      if (inStatus >= s.pickupBreachMinutes) {
        return at(2, "pickup_breach", `${inStatus} دقيقة والكابتن ما استلمش الطلب`, inStatus, "chase_courier");
      }
      if (inStatus >= s.pickupMinutes) {
        return at(1, "pickup_late", `${inStatus} دقيقة في انتظار الكابتن`, inStatus, "chase_courier");
      }
      return none;

    case "on_the_way":
      if (inStatus >= s.deliverBreachMinutes) {
        return at(2, "deliver_breach", `${inStatus} دقيقة والطلب لسه ما وصلش العميل`, inStatus, "chase_courier");
      }
      if (inStatus >= s.deliverMinutes) {
        return at(1, "deliver_late", `${inStatus} دقيقة في الطريق`, inStatus, "chase_courier");
      }
      return none;

    case "refund_failed":
      return at(3, "refund_failed", "فشل استرجاع مبلغ العميل — استرجع يدوياً من لوحة ماي فاتورة", inStatus, "manual_refund");

    case "courier_cancelled":
      return at(2, "delivery_failed", "تعثّر التوصيل — قرّر: إعادة إرسال ولا استرجاع", inStatus, "decide");

    default:
      return none;
  }
}

/* naive per-IP limiter, same shape as funnel.js — checkout is not a hot path */
const rl = new Map();
function rateLimited(ip, max = 60) {
  const now = Date.now();
  const slot = rl.get(ip);
  if (!slot || now - slot.start > 3600_000) { rl.set(ip, { start: now, n: 1 }); return false; }
  slot.n++;
  if (rl.size > 5000) rl.clear();
  return slot.n > max;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, requireCashierOrAdmin, getSettingsData, jb, normPhone } = ctx;
  const pay = deps.pay;
  const delivery = deps.delivery;
  const notify = deps.notify || null;
  const accounts = deps.accounts || (() => null); // late-bound — accounts registers after us
  const carts = deps.carts || (() => null);       // late-bound — abandoned-cart tracker
  const tsp = deps.tsp || (() => null);           // late-bound — TabSense partner (paid orders)
  const posNames = deps.posNames || (() => null); // late-bound — أسماء عملاء نقطة البيع + ربط المرايا
  const journey = typeof deps.journey === "function" ? deps.journey : () => null; // late-bound — ٠٢
  const wa = typeof deps.wa === "function" ? deps.wa : () => null; // واتساب: موافقة الشيك أوت
  const emitOrder = makeOrderEmitter(deps.emitOrder);
  /* أسماء الأصناف (بلاغ عمر ١٧ سبتمبر ٢٠٢٦): السلة الجاية من المتصفح فيها
     product_id وكمية وسعر بس — من غير اسم. الاسم بيتحل هنا من قايمة تاب
     سينس وبيتخزّن مع الطلب، فالكاشير والمطبخ والتقارير يشوفوا «كفتة مشوية
     بالوزن — كيلو» مش «منتج ١٠٥». حقل عرض بحت: مافيش أي رقم فلوس بيتلمس،
     والفشل بيعدّي في صمت (البورتال بيحلّ الاسم وقت القراية كمان). */
  const productNames = deps.productNames || makeNameResolver({ pool, log: console });
  const NAMES_TIMEOUT_MS = Number(process.env.ITEM_NAMES_TIMEOUT_MS || 2000);
  const namedItems = async (items) => {
    try {
      /* الشيك أوت ماينتظرش تاب سينس. لو القايمة بطيئة بنكمّل من غير أسماء —
         الـbackfill والبورتال بيصلّحوا السطر بعدين، والطلب نفسه مايتأخرش. */
      const r = await Promise.race([
        productNames.fillNames(items),
        new Promise((res) => setTimeout(() => res(null), NAMES_TIMEOUT_MS).unref?.()),
      ]);
      return r ? r.items : items;
    } catch (e) { console.error("[shop] item names failed:", e.message); return items; }
  };
  // checkout_result لرحلة العميل (٠٢) — fire-and-forget، مابيغيّرش أي رد
  const journeyEmit = (name, props) => {
    try {
      const p = journey()?.emit?.(name, props);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* ignore */ }
  };

  /* رسايل الإدارة (16 سبتمبر) — مباشرة لتقنيات، مستقلة عن رسايل العملاء.
     الأرقام واللغة من اللوحة (settings.delivery). شوف staffalerts.js. */
  const staff = makeStaffNotifier({ getSettingsData, sendSms: sendStaffSms });
  let _tspDownAlertAt = 0;
  // كل رسالة لكل طلب مرة واحدة بس — الحجز ذري في عمود alerts
  async function claimAlert(orderNo, key) {
    const r = await pool.query(
      `UPDATE shop_orders SET alerts = COALESCE(alerts,'{}'::jsonb) || $2::jsonb
        WHERE order_no=$1 AND NOT (COALESCE(alerts,'{}'::jsonb) ? $3) RETURNING order_no`,
      [String(orderNo), jb({ [key]: new Date().toISOString() }), key]);
    return r.rowCount > 0;
  }
  const bundles = deps.bundles || (() => null);   // late-bound — «باقة بخيارات» (cms.js)

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_orders (
        order_no TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending_payment',
        option TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT '1',
        customer JSONB,
        phone_norm TEXT,
        address JSONB,
        items JSONB,
        pos_calc JSONB,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        delivery_fee NUMERIC NOT NULL DEFAULT 0,
        tip NUMERIC NOT NULL DEFAULT 0,
        total NUMERIC NOT NULL DEFAULT 0,
        delivery_quote JSONB,
        mf_session_id TEXT,
        mf_invoice_id TEXT,
        mf_payment_id TEXT,
        refund_id TEXT,
        refund JSONB,
        pos_order_id TEXT,
        pos_approval TEXT,
        notes TEXT,
        history JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS shop_orders_status_idx ON shop_orders(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS shop_orders_phone_idx ON shop_orders(phone_norm, created_at DESC);
      CREATE INDEX IF NOT EXISTS shop_orders_invoice_idx ON shop_orders(mf_invoice_id);
      -- Coupons (2026-08-12): a percentage flows into the POS invoice itself
      -- (adjustments.discount {id:null, percentage_value} — probed live), so
      -- what MyFatoorah charges IS what TabSense books.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS coupon TEXT;
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC NOT NULL DEFAULT 0;
      -- POS-push audit (2026-08-13, after a paid order stalled with a
      -- swallowed error): every attempt counts itself and keeps TabSense's
      -- actual answer, so "وقف ومش عارفين ليه" cannot happen again.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS pos_attempts INT NOT NULL DEFAULT 0;
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS last_pos_error TEXT;
      -- الاسترجاع (2026-08-26): عدّاد المحاولات عشان ما نفضلش نضرب على
      -- MyFatoorah لما ترفض — MakeRefund مش idempotent، ومحاولة زيادة
      -- ممكن ترجّع فلوس مرتين لو الرد الأول ضاع في الطريق بس نجح عندهم.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS refund_attempts INT NOT NULL DEFAULT 0;
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS pay_gateway TEXT;
      -- «الأكل جاهز» (2026-09-11): وقت ما الكاشير يسجّل الطلب جاهز للاستلام
      -- (approval_status=pickup_ready من الشريك). التتبع بيفضل «بيجهّز» لحد ما
      -- يتسجّل، وبعدها بس بنعرض حالة المندوب — «المطعم أولاً».
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS pos_ready_at TIMESTAMPTZ;
      -- حجز طلب المندوب (13 سبتمبر): المندوب بقى بيتطلب بعد «جاهز» أو بعد مهلة،
      -- مش لحظة القبول. العمود بيضمن إن كل طلب يتبعت لشركة التوصيل مرة واحدة.
      -- أول مرة بس: كل طلب عدّى مرحلة القبول بيتعلّم محجوز، عشان النشر ده
      -- ما يبعتش كابتن لطلبات قديمة اتعاملت يدوي.
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name='shop_orders' AND column_name='dispatch_claimed_at') THEN
          ALTER TABLE shop_orders ADD COLUMN dispatch_claimed_at TIMESTAMPTZ;
          UPDATE shop_orders SET dispatch_claimed_at = updated_at
           WHERE status NOT IN ('pending_payment','paid','paid_pos_failed','pos_created');
        END IF;
      END $$;
      -- سجل الإنذارات: كل درجة تصعيد تتبعت مرة واحدة لكل طلب، عشان المدير
      -- ما يصحاش على عشرين رسالة عن نفس الطلب.
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS alerts JSONB NOT NULL DEFAULT '{}'::jsonb;
      CREATE TABLE IF NOT EXISTS shop_coupons (
        code TEXT PRIMARY KEY,
        percent NUMERIC NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        min_total NUMERIC NOT NULL DEFAULT 0,
        max_uses INT,
        used_count INT NOT NULL DEFAULT 0,
        expires_at DATE,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- «مرة واحدة لكل عميل»: نفس الكود ينفع لمئات العملاء لكن كل رقم جوال
      -- مرة واحدة بس (بيتحسب من الطلبات المدفوعة فعلاً).
      ALTER TABLE shop_coupons ADD COLUMN IF NOT EXISTS once_per_customer BOOLEAN NOT NULL DEFAULT FALSE;
      -- «توصيل مجاني بالكوبون» (2026-09-11): الكوبون يتنازل عن رسم التوصيل
      -- كامل بدل (أو مع) خصم النسبة. كوبون أول طلب = free_delivery + once_per_customer.
      ALTER TABLE shop_coupons ADD COLUMN IF NOT EXISTS free_delivery BOOLEAN NOT NULL DEFAULT FALSE;
      -- مصدر الطلب (W0-03، checkout-meta.js): رابط الحملة/UTM/click ids + ip/ua
      -- من الهيدر، بيتسجّل وقت الـcheckout. الفهرس عشان خطة الإعلانات بتربط
      -- الطلبات بالروابط (attribution->>'fc_link').
      ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS attribution JSONB;
      CREATE INDEX IF NOT EXISTS shop_orders_attr_link_idx ON shop_orders ((attribution->>'fc_link'));
    `);
  }
  ensureSchema()
    .then(() => console.log("[shop] schema ready"))
    // أعمدة §٤-٢ (W1-01) بعد جدول shop_orders — كلها IF NOT EXISTS ومابتوقفش الإقلاع
    .then(() => _ordersSchemaReady)
    .then((m) => (m && typeof m.ensureOrderColumns === "function" ? m.ensureOrderColumns(pool) : null))
    .catch((e) => console.error("[shop] schema failed:", e.message));

  async function getOrderRow(orderNo) {
    const r = await pool.query("SELECT * FROM shop_orders WHERE order_no=$1", [String(orderNo)]);
    return r.rows[0] || null;
  }

  async function setStatus(orderNo, status, extra = {}) {
    const sets = ["status=$2", "history = history || $3::jsonb", "updated_at=NOW()"];
    const vals = [String(orderNo), status, jb([{ at: new Date().toISOString(), status, ...extra.note ? { note: extra.note } : {} }])];
    for (const [col, v] of Object.entries(extra.cols || {})) {
      vals.push(v);
      sets.push(`${col}=$${vals.length}`);
    }
    await pool.query(`UPDATE shop_orders SET ${sets.join(", ")} WHERE order_no=$1`, vals);
    // حدث واحد لكل تغيير حالة (§٤-١). from اختياري: المنادي اللي معاه الصف بيبعته.
    emitOrder("order_status", {
      orderNo: String(orderNo), source: extra.source || "shop",
      data: { from: extra.from ?? null, to: status, note: extra.note || null },
    });
    // notify.js decides which stages the customer hears about; a notification
    // failure must never fail the state change it describes.
    if (notify) notify.orderStatusChanged(String(orderNo), status).catch((e) =>
      console.error(`[shop] notify failed for ${orderNo}:`, e.message));
    if (status === "paid_pos_failed") {
      claimAlert(orderNo, "staff:pos_failed").then(async (ok) => {
        if (!ok) return;
        const row = await getOrderRow(orderNo);
        if (row) await staff.critical((lang) => posFailedText(row, lang), `pos-failed ${orderNo}`);
      }).catch((e) => console.error(`[shop] staff pos-failed sms ${orderNo}:`, e.message));
    }
  }

  /* ── coupons ──
     Two pools answer to the same field: shop_coupons (dashboard-made) first,
     then the AMBASSADOR codes (the invite system) — Omar asked that the codes
     already living in the system work on the store too. An ambassador code
     carries its batch's percentage, burns once (redeemed=true at payment),
     and the attribution to its ambassador stays intact for free.
     Caveat (told to Omar): online redemption marks it used HERE — the POS
     cashier flow has its own promotion check and cannot see ours. */
  async function checkCoupon(codeRaw, subtotal, phoneNorm) {
    const code = String(codeRaw || "").trim().toUpperCase();
    if (!code) return null;
    const r = await pool.query("SELECT * FROM shop_coupons WHERE upper(code)=$1", [code]);
    const cp = r.rows[0];
    if (cp) {
      if (!cp.active) return { ok: false, error: "not_found" };
      if (cp.expires_at && new Date(cp.expires_at) < new Date(new Date().toDateString())) return { ok: false, error: "expired" };
      if (cp.max_uses != null && cp.used_count >= cp.max_uses) return { ok: false, error: "maxed" };
      if (Number(subtotal) < Number(cp.min_total)) return { ok: false, error: "min_total", minTotal: Number(cp.min_total) };
      if (cp.once_per_customer && phoneNorm) {
        const used = await pool.query(
          `SELECT 1 FROM shop_orders
            WHERE coupon=$1 AND phone_norm=$2 AND status NOT IN ('pending_payment','expired') LIMIT 1`,
          [cp.code, phoneNorm]);
        if (used.rowCount) return { ok: false, error: "already_used" };
      }
      return { ok: true, code: cp.code, percent: Number(cp.percent) || 0, freeDelivery: cp.free_delivery === true, kind: "coupon" };
    }
    // أكواد السفراء: قابلة للإيقاف من اللوحة لو قلق الاستخدام المزدوج
    // (أونلاين + كاشير) رجّح كفة الفصل الكامل بين القناتين.
    if (((await getSettingsData()).shop || {}).acceptAmbassadorCodes === false) {
      return { ok: false, error: "not_found" };
    }
    const amb = (await pool.query(
      `SELECT c.code, c.redeemed, b.discount_percent, b.validity_date
         FROM codes c JOIN batches b ON b.id = c.batch_id
        WHERE upper(c.code)=$1`, [code])).rows[0];
    if (!amb) return { ok: false, error: "not_found" };
    if (amb.redeemed) return { ok: false, error: "maxed" };
    if (amb.validity_date && new Date(amb.validity_date) < new Date(new Date().toDateString())) {
      return { ok: false, error: "expired" };
    }
    return { ok: true, code: amb.code, percent: Number(amb.discount_percent), freeDelivery: false, kind: "ambassador" };
  }

  // PUBLIC — the cart asks before checkout so the customer sees the discount live.
  app.post("/api/shop/validate-coupon", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 120)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const res = await checkCoupon(b.code, Number(b.subtotal) || 0, b.phone ? normPhone(b.phone) : null);
    if (!res) return c.json({ ok: false, error: "empty" }, 400);
    return c.json(res, res.ok ? 200 : 404);
  });

  // Admin CRUD — the dashboard's coupons pane.
  app.get("/api/shop/coupons", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query("SELECT * FROM shop_coupons ORDER BY created_at DESC")).rows;
    return c.json({ ok: true, coupons: rows });
  });
  app.post("/api/shop/coupons", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json();
    const code = String(b.code || "").trim().toUpperCase();
    const freeDelivery = b.free_delivery === true;
    // كوبون لازم يعمل حاجة: يا خصم نسبة يا توصيل مجاني (أو الاتنين).
    if (!code || !(Number(b.percent) > 0 || freeDelivery))
      return c.json({ ok: false, error: "code and (percent or free_delivery) required" }, 400);
    const r = await pool.query(
      `INSERT INTO shop_coupons(code, percent, active, min_total, max_uses, expires_at, note, once_per_customer, free_delivery)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO UPDATE SET percent=$2, active=$3, min_total=$4, max_uses=$5, expires_at=$6, note=$7, once_per_customer=$8, free_delivery=$9
       RETURNING *`,
      [code, Math.min(100, Number(b.percent) || 0), b.active !== false, Number(b.min_total) || 0,
       b.max_uses != null && b.max_uses !== "" ? Number(b.max_uses) : null,
       b.expires_at || null, String(b.note || "").slice(0, 120), b.once_per_customer === true, freeDelivery]);
    return c.json({ ok: true, coupon: r.rows[0] });
  });
  app.delete("/api/shop/coupons/:code", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await pool.query("DELETE FROM shop_coupons WHERE code=$1", [String(c.req.param("code")).toUpperCase()]);
    return c.json({ ok: true });
  });

  /* ── storefront appearance + behavior (PUBLIC) — edited from the dashboard.
     Colors/texts live in settings.storefront so a rebrand (or the coming
     freshcuts.sa / SaaS skinning) is a settings edit, not a deploy. */
  app.get("/api/shop/storefront", async (c) => {
    const s = await getSettingsData();
    const sf = s.storefront || {};
    const cat = s.catalog || {};
    return c.json({
      ok: true,
      theme: sf.theme || {},           // {brand, deep, bg, ink, ...} CSS vars
      texts: sf.texts || {},           // {title, subtitle}
      // الفوتر: {line1, line2, links:[{label,url}]} — من اللوحة، من غير أي
      // ذكر لمزوّد خارجي (طلب عمر 2026-08-16: TabSense ما يظهرش)
      footer: sf.footer || {},
      // بانرات العروض: [{title, desc, emoji, color, target_item?, active}] —
      // بتترسم في شريط العروض قبل عروض TabSense، وبتتعدل من اللوحة فوراً.
      banners: (sf.banners || []).filter((x) => x && x.active !== false),
      // نافذة ترويجية: بتظهر مرة كل X ساعة لكل جهاز، وبتتقفل من اللوحة
      // بضغطة. {enabled,title,body,image,ctaLabel,ctaTarget,everyHours,
      //          delaySeconds,firstVisitOnly,couponCode}
      popup: (sf.popup && sf.popup.enabled) ? {
        id: String(sf.popup.id || "p1"),           // تغييره بيرجّع العرض للكل
        title: sf.popup.title || "", body: sf.popup.body || "",
        image: sf.popup.image || "", couponCode: sf.popup.couponCode || "",
        ctaLabel: sf.popup.ctaLabel || "", ctaTarget: sf.popup.ctaTarget || "",
        everyHours: Number(sf.popup.everyHours) || 24,
        delaySeconds: Number(sf.popup.delaySeconds) || 3,
        firstVisitOnly: sf.popup.firstVisitOnly === true,
      } : null,
      // أصناف مخفية من العرض (غير نشطة أو تكرارات الأوزان): بتختفي من
      // القايمة والبحث لكن بتفضل في البيانات — عشان منتقي الوزن يلاقيها.
      hiddenIds: (cat.hiddenIds || []).map(String),
      // مواعيد العمل من اللوحة: {enabled, days:{sat..fri:{open,close}}, note}
      // «close» أصغر من «open» معناها بعد منتصف الليل (12:00 → 02:00).
      // المتجر بيمنع الطلب بره المواعيد (وTabSense كمان بتقول pos_available).
      hours: s.hours || null,
      // مجموعات الأوزان: الصنف الأصل بيفتح منتقي (⅓/½/كيلو) وكل اختيار
      // بيطلب صنف TabSense الحقيقي بتاعه — المطبخ يشوف الوزن الصح دايماً.
      variantGroups: cat.variantGroups || [],
      allowCash: (s.shop || {}).allowCash === true, // Omar 2026-08-12: online-only by default
      // تجربة الطلب الجديدة لكل العملاء (مفتاح في شاشة الاقتراحات باللوحة)؛ الافتراضي مقفولة
      checkout2Default: (s.shop || {}).checkout2Default === true,
      // نصوص وروابط صفحات الـSEO في المتجر (/menu, /about, /faq, الرئيسية):
      // {home:{h1,intro,h1_en,intro_en,showIntro}, rating, links:{maps,review,
      //  instagram,tiktok,snapchat,facebook,hungerstation,keeta,ninja},
      //  menu:{intro,intro_en}, about:{text,text_en}, faq:[{q,a,q_en,a_en}],
      //  categories:{slug:{title,h1,meta,intro,…_en}}} — أي حقل فاضي بياخد
      // الافتراضي المكتوب في المتجر (storefront/seo.py).
      seo: sf.seo || {},
      /* ⏰ «نبّهني لما تفتحوا» شغّال؟ المتجر مابيوريش الزرار وهو مقفول
         (openwait.js بيرفض التسجيل برضه — ده عشان الواجهة تبقى صادقة). */
      openWaitEnabled: (s.openWait || {}).enabled !== false,
      /* ⭐ تقييم جوجل الحقيقي (reviews.js بيحدّثه كل ١٢ ساعة من Places API).
         الشارة على المتجر وschema.org بيقروا من هنا — **رقم حقيقي أو ولا
         حاجة**، عمرنا ما نكتب تقييم من دماغنا. */
      googleRating: (() => {
        const g = s.googlePlace;
        const on = (s.reviews || {}).showBadge !== false;
        if (!on || !g || !(Number(g.rating) > 0) || !(Number(g.count) >= 1)) return null;
        return {
          rating: Number(g.rating), count: Number(g.count),
          url: g.mapsUrl || "", at: g.at || null,
          reviewUrl: (s.reviews || {}).googleUrl || "",
        };
      })(),
      /* 🎟️ كوبون «أول طلب» (FIRST) — الحد الأدنى كان مكتوب ٤٠ في app.js.
         دلوقتي من shop_coupons نفسه: تعديل الكوبون من اللوحة بيوصل المتجر. */
      firstCoupon: await (async () => {
        try {
          const r = await pool.query(
            `SELECT code, min_total, free_delivery, active, expires_at FROM shop_coupons WHERE upper(code)='FIRST' LIMIT 1`);
          const x = r.rows[0];
          if (!x) return null;
          const live = x.active !== false && (!x.expires_at || new Date(x.expires_at) > new Date());
          return { code: "FIRST", active: live, minTotal: Number(x.min_total) || 0, freeDelivery: x.free_delivery === true };
        } catch { return null; }
      })(),
    });
  });

  /* ── checkout: cart → locked POS prices → delivery quote → MF session ── */
  app.post("/api/shop/checkout", async (c) => {
    const t0 = Date.now();
    let b = {};
    // fail(): نفس الـJSON والـstatus بالظبط زي قبل W1-02، + checkout_result لرحلة العميل (٠٢)
    const fail = (code, status, extra = {}) => {
      try {
        let meta = null;
        try { meta = parseCheckoutMeta(b || {}, (n) => c.req.header(n)); } catch { /* ignore */ }
        journeyEmit("checkout_result", {
          ok: false, error_code: String(code).replace(/\s+/g, "_"), http_status: status,
          option: b && b.option === "pickup" ? "pickup" : (b && b.option ? "delivery" : null),
          items_count: Array.isArray(b?.items) ? b.items.length : 0,
          has_bundle: Array.isArray(b?.items) && b.items.some((it) => it && it.bundle),
          journey_sid: meta?.journey_sid || null, client: meta?.client || null,
          ms: Date.now() - t0,
        });
      } catch { /* ignore */ }
      return c.json({ ok: false, error: code, ...extra }, status);
    };
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return fail("rate_limited", 429);
    if (!pay.configured()) return fail("payments_not_configured", 503);
    // المطعم مقفول؟ الواجهة بتمنع قبل الدفع، بس لازم السيرفر يمنع كمان: صفحة
    // قديمة مفتوحة، أو شارة كانت غلط، كانت بتخلّي العميل يدفع والمطبخ مقفول.
    // المواعيد من اللوحة (settings.hours) — نفس مصدر الواجهة بالظبط.
    if (!isOpenNow((await getSettingsData()).hours)) {
      return fail("store_closed", 409,
        { message: "المطعم مغلق حالياً 🌙 — تقدر تجهّز سلتك وتطلب أول ما نفتح." });
    }

    try { b = await c.req.json(); } catch { b = {}; return fail("bad json", 400); }
    const option = b.option === "pickup" ? "pickup" : "delivery";
    const branchId = String(b.branch_id || "1");
    let items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return fail("empty_cart", 400);
    /* وحدة الفلوس اللي المتصفح سعّر بيها. من ١٧ سبتمبر ٢٠٢٦ احنا على
       الميكرو-ريال (money.js)، لكن ممكن يكون في المتصفح نسخة قديمة مكاشّة
       لسه بتبعت بالنانو — فبنحوّل بدل ما نرفض (ولو ماقالش، النانو القديم هو
       الافتراضي). من غير ده تاب سينس بترد «system price must match». */
    items = rescaleItems(items, b.multiply_factor, MONEY_MULTIPLY);

    /* ── الباقات: بنوسّعها **هنا على السيرفر** لمنتجاتها الحقيقية ──────────
       سطر الباقة في السلة بيوصل كـ{bundle, quantity, choices} — من غير أي
       سعر. السيرفر بيجيب التعريف من الداتابيز، يتأكد إن الاختيارات مسموحة،
       ويوزّع السعر بالقواعد الصافية في bundles.js. يعني العميل يقدر يختار
       المكوّنات بس، مايقدرش يحدد سعرها — لو بعت سعر بنتجاهله تماماً.
       أي فشل بيرجع ٤٢٢ واضحة **قبل** ما يتعمل أي جلسة دفع. */
    if (items.some((it) => it && it.bundle)) {
      const cms = bundles();
      if (!cms || !cms.expandBundle) return fail("bundles_unavailable", 503);
      const expanded = [];
      for (const it of items) {
        // وسوم الباقة بيحطّها السيرفر بس. لو المتصفح بعتها على صنف عادي
        // بنشيلها، عشان حد مايقدرش يزوّر تقارير «كام باقة اتباعت».
        if (!it || !it.bundle) { expanded.push(stripBundleTags(it)); continue; }
        let r;
        try {
          r = await cms.expandBundle(String(it.bundle), it.choices || {}, it.quantity || 1, option);
        } catch (e) {
          console.error(`[shop] bundle expand threw for ${it.bundle}:`, e.message);
          return fail("bundle_expand_failed", 422, { bundle: it.bundle });
        }
        if (!r.ok && r.error === "sold_out") {
          return fail("item_sold_out", 409, { bundle: it.bundle, items: r.items || [], message: r.message });
        }
        if (!r.ok) return fail("bundle_" + r.error, 422, { bundle: it.bundle, detail: r });
        expanded.push(...r.lines);
      }
      items = expanded;
    }
    /* وسم الوحدة على كل سطر قبل أي حساب أو تخزين: من دلوقت أي قارئ
       (partnerItemsOf، التقارير، بكسل الشراء) بيعرف وحدة السطر من السطر نفسه
       بدل ما يفترض وحدة ثابتة — فتغيير الوحدة تاني مابيكسرش التاريخ. */
    items = stampMf(items, MONEY_MULTIPLY);
    /* «خلص النهارده» (soldout.js): المدير قفل الصنف من البورتال. بنرفض قبل
       الـOTP وقبل أي جلسة دفع — ومن غير ما نشيله من السلة بصمت: المتجر
       بيعلّم السطر ويطلب من العميل يشيله. */
    {
      let act = {};
      try { act = soldOutOf(await getSettingsData()); } catch { /* fail-open */ }
      const bad = soldOutLines(items, act);
      if (bad.length) {
        return fail("item_sold_out", 409, { items: bad, message: soldOutMessage(bad.map((x) => x.name)) });
      }
    }
    // dine-in-only offers (صينية اللمة …) cannot be delivered/picked up: refuse
    // BEFORE a payment session exists. Same list the storefront + catalog use.
    {
      const s0 = await getSettingsData();
      const dine = new Set([
        ...String(process.env.CATALOG_DINE_IN_IDS ?? "121").split(","),
        ...((s0.catalog || {}).dineInIds || []).map(String),
      ].map((x) => String(x).trim()).filter(Boolean));
      const bad = items.filter((it) => dine.has(String(it.product_id)));
      if (bad.length) return fail("dine_in_only", 422, { items: bad.map((x) => x.product_id) });
    }
    const cust = b.customer || {};
    const phoneNorm = normPhone(cust.phone);
    if (!/^5\d{8}$/.test(phoneNorm)) return fail("invalid_phone", 400);
    /* الاسم الثنائي إجباري تاني (عمر ١٩/٩ — رجوع عن «عميل» الافتراضي). detail =
       نفس الرسالة، عشان نسخة متجر قديمة في الكاش بتعرض detail تحت زرار الدفع. */
    const nameChk = checkPersonName(cust.name);
    /* ٢١/٩ — النص المؤقت مش اسم. «عميل» / «عميل أونلاين» كانوا بيتسجّلوا
       على الطلب وبيمشوا لدفتر نقطة البيع، وبعدين بيبقوا اسم العميل الدائم
       على كل فاتورة. المتجر بيمسحهم، بس نسخة قديمة في كاش الجهاز ممكن
       تبعتهم، فالسيرفر هو الحَكَم. */
    if (!nameChk.ok || !plausibleName(nameChk.name)) {
      return fail("invalid_name", 400, { reason: nameChk.error || "name_placeholder", message: NAME_MSG.ar, message_en: NAME_MSG.en, detail: NAME_MSG.ar });
    }
    if (option === "delivery" && !(b.address?.latitude && b.address?.longitude)) {
      return fail("address_required", 400);
    }
    // OTP إجباري لتأكيد الطلب: لازم نفس الجوال يكون متأكّد بجلسة حساب سارية.
    // العميل بيبعت Authorization: Bearer cust:<token> بعد ما يتحقق برمز الجوال.
    // لو غير متأكّد (أو التوكن لرقم تاني) → otp_required، والستورفرونت يعرض التحقق.
    {
      const verified = await (accounts()?.customerOf?.(c) ?? null);
      if (!verified || String(verified.phone_norm) !== String(phoneNorm)) {
        return fail("otp_required", 401);
      }
      // الاسم الثنائي الصح بيتحفظ على الحساب — المرة الجاية بيتملى لوحده
      if (verified.name !== nameChk.name) {
        pool.query("UPDATE acct_customers SET name=$2 WHERE phone_norm=$1", [phoneNorm, nameChk.name.slice(0, 60)])
          .catch((e) => console.error("[shop] account name save failed:", e.message));
      }
      /* ونفس الاسم يمشي لدفتر نقطة البيع: هو اللي بيبان على شاشة الكاشير
         والفاتورة وتذكرة المطبخ — تاب سينس بتتجاهل الاسم اللي جوه الطلب
         وبتعرض اسم الدفتر (اتأكدنا ٢١/٩). fire-and-forget. */
      accounts()?.syncPosIdentity?.(phoneNorm, nameChk.name);
    }

    // Coupon first — the discount changes every number after it.
    let coupon = null;
    if (b.coupon) {
      // subtotal check happens against the raw cart estimate; the authoritative
      // re-check against real totals comes right after the first calc.
      coupon = await checkCoupon(b.coupon, Number.MAX_SAFE_INTEGER, phoneNorm);
      if (coupon && !coupon.ok) return fail("coupon_" + coupon.error, 422, { coupon });
    }
    // Standing per-customer discount (الملاك): auto-applies by phone alone.
    // Never stacks with a coupon — the customer gets whichever is bigger.
    const standing = await (accounts()?.customerDiscount?.(phoneNorm) ?? null);
    let discountPercent = coupon?.percent || 0;
    let discountSource = coupon?.ok ? { kind: coupon.kind, code: coupon.code } : null;
    if (standing && standing.percent > discountPercent) {
      discountPercent = standing.percent;
      discountSource = { kind: "customer", label: standing.label };
      // الخصم الثابت بيغلب نسبة الكوبون، لكن لو الكوبون بيديك توصيل مجاني
      // بنسيبه شغّال عشان التنازل يتطبّق (وبيتحرق عادي). كوبون النسبة الصِّرف
      // بيفضل غير محروق لما الخصم الثابت يكسب.
      if (coupon && !coupon.freeDelivery) coupon = null;
    }

    /* ── الباقات بتتسعّر عندنا، مش على حساب المتجر ────────────────────────
       تاب سينس **بترفض** أي unit_amount مختلف عن سعر النظام
       («The purchases.N.unit_amount and purchases.N.system price must match»
        — اتأكدنا بالمجسّ 2026-09-12). وده بالظبط اللي الباقة محتاجاه: أسعار
       احنا بنحددها. فبنفصل المسارين:
         • الأصناف العادية  → حساب تاب سينس زي ما هو (هو اللي بيتحقق من السعر)
         • سطور الباقة      → سعرها سعر الباقة، واحنا اللي بنحسبه (بالظبط)
       الإجمالي المحصّل = الاتنين. الخصومات والكوبونات بتتطبّق على الأصناف
       العادية بس — الباقة سعرها مخفّض أصلاً فمابنخصمش عليها تاني. */
    const bundleItems = items.filter((it) => it && it.bundle);
    const plainItems = items.filter((it) => !(it && it.bundle));
    // إجمالي الباقات شامل الضريبة — من التعريف نفسه، مش من أي حساب خارجي
    let bundleTotal = 0;
    if (bundleItems.length) {
      const seen = new Set();
      for (const it of bundleItems) {
        if (seen.has(it.bundle_line)) continue;
        seen.add(it.bundle_line);
        const ex = bundleItems.filter((x) => x.bundle_line === it.bundle_line)
          .reduce((a, x) => a + (Number(x.unit_amount) / scaleOf(x)) * Number(x.quantity), 0);
        bundleTotal += ex * (1 + BUNDLE_VAT);
      }
      bundleTotal = r2(bundleTotal);
    }

    // Pass 1: food only, discounted — this is the subtotal the delivery quote
    // (free-over / minimum rules) judges against.
    let calc = null;
    if (plainItems.length) {
      try {
        calc = await tsstore.calculateOrder({
          branchId, orderOptionId: OPTION_ID[option], purchases: plainItems,
          tipAmount: Number(b.tip) || 0, discountPercent,
        });
      } catch (e) {
        return fail("calc_failed", 422, { detail: e.message });
      }
    }
    let totals = (calc && calc.totals) || {};
    // وحدة الحساب من الرد نفسه — حزام الأمان في tsstore ممكن يكون نزل درجة.
    const calcMf = tsstore.calcMultiply(calc);
    const plainTotal = r2((totals.tendered_amount || totals.total_amount || 0) / calcMf);
    const foodTotal = r2(plainTotal + bundleTotal);
    // إعادة التحقق ضد الإجمالي الحقيقي — لأي كوبون فعّال (مش بس كوبون النسبة):
    // كوبون التوصيل المجاني كمان له حد أدنى و«مرة لكل عميل» لازم يتأكدوا هنا.
    if (coupon?.ok) {
      const recheck = await checkCoupon(b.coupon, foodTotal, phoneNorm);
      if (!recheck.ok) return fail("coupon_" + recheck.error, 422, { coupon: recheck });
    }

    let deliveryFee = 0, dq = null, freeDeliveryByCoupon = false;
    if (option === "delivery") {
      /* «المنطقة البعيدة»: العميل اللي عنوانه بره النطاق شاف العرض ووافق
         على رسوم المسافة الإضافية. من غير الموافقة دي التسعيرة بترفض زي
         الأول — يعني مستحيل حد يتحاسب على رسم إضافي ما وافقش عليه. */
      const farOk = b.address.far_zone_accepted === true || b.farZoneAccepted === true;
      /* «التوصيل بالحي»: نفس الحي اللي العميل شاف عليه السعر — بنبعته
         للتسعيرة تاني هنا عشان الرقم اللي بيتحاسب عليه يطلع من نفس
         المصدر، مش من التسعيرة اللي الواجهة شايفاها. */
      dq = await delivery.quote({
        lat: b.address.latitude, lng: b.address.longitude, orderTotal: foodTotal,
        farZoneAccepted: farOk,
        district: b.address.district || b.address.area || null,
      });
      if (!dq.deliverable) return fail("not_deliverable", 422, { quote: dq });
      deliveryFee = dq.fee;
      // كوبون توصيل مجاني: بنتنازل عن الرسم كامل (المطعم بيتحمّل الكابتن —
      // تكلفة اكتساب العميل). الطلب بيتسجّل والكوبون بيتحرق زي أي كوبون.
      // **بس** رسوم المسافة الإضافية مش داخلة في التنازل: دي تكلفة كابتن
      // حقيقية فوق المشوار العادي، والعميل وافق عليها لوحدها.
      // ورسم «التوصيل بالحي» زيّه بالظبط: ده سعر مندوب حقيقي من جدول
      // الأحياء، مش رسم ربح — كوبون مجاني مايلغيهوش.
      if (coupon?.ok && coupon.freeDelivery && deliveryFee > 0) {
        const keep = dq.districtDelivery ? Number(dq.districtDelivery.fee) || 0
          : dq.farZone ? Number(dq.farZone.surcharge) || 0 : 0;
        if (deliveryFee > keep) {
          freeDeliveryByCoupon = true;
          deliveryFee = keep;
        }
      }
    }

    // Pass 2 (Omar's rule: «إجمالي المدفوع يتسجل كله في TabSense بالشكل
    // المظبوط»): the fee rides INTO the POS invoice as quantity×(1-SAR
    // delivery product) — TabSense ignores charge adjustments and rejects
    // free-form prices, so the quantity trick is the one exact channel.
    // Needs settings.shop.deliveryFeeProductId (a 1.00-SAR menu product);
    // without it we fall back to charging the fee outside the POS invoice.
    const feeProductId = ((await getSettingsData()).shop || {}).deliveryFeeProductId;
    let feeInPos = false;
    if (deliveryFee > 0 && feeProductId) {
      const prod = await tsstore.findProduct(feeProductId, branchId).catch(() => null);
      if (prod) {
        // The discount percentage applies order-wide, fee line included. To
        // keep the CUSTOMER's fee equal to the quote, inflate the quantity so
        // the discounted line lands back on the quoted fee (integer SAR).
        const qty = discountPercent > 0
          ? Math.round(deliveryFee / (1 - discountPercent / 100))
          : deliveryFee;
        const feeLine = {
          product_id: Number(feeProductId), quantity: qty,
          tax_id: prod.tax_id ?? 1,
          // `price` is the pre-VAT system price — the field calculate-order
          // validates against (retail_price is the VAT-inclusive display one).
          unit_amount: Math.round(Number(prod.price) * tsstore.MULTIPLY),
        };
        try {
          calc = await tsstore.calculateOrder({
            branchId, orderOptionId: OPTION_ID[option], purchases: [...plainItems, feeLine],
            tipAmount: Number(b.tip) || 0, discountPercent,
          });
          totals = calc.totals || {};
          feeInPos = true;
        } catch (e) {
          console.error("[shop] fee-product calc failed, falling back:", e.message);
        }
      }
    }

    const tip = r2(b.tip);
    // إجمالي نقطة البيع = حساب تاب سينس للأصناف العادية + سعر الباقات بتاعنا.
    // سلة باقات بس (من غير أصناف عادية ولا سطر توصيل) مالهاش حساب تاب سينس،
    // فالبقشيش اللي كان بيتضاف جوّه الحساب لازم يتضاف هنا بإيدنا.
    const tipOutsideCalc = !calc && tip > 0 ? tip : 0;
    const calcMf2 = tsstore.calcMultiply(calc);
    const posTotal = r2((totals.tendered_amount || totals.total_amount || 0) / calcMf2 + bundleTotal + tipOutsideCalc);
    // When the fee is booked in the POS, the charge == the POS invoice exactly;
    // otherwise the fee is collected on top (the old designed gap).
    const total = feeInPos ? posTotal : r2(posTotal + deliveryFee);
    const discountAmount = r2(((totals.total_amount_discount_excluded || 0) - (totals.total_amount || 0)) / calcMf2);

    const orderNo = "W" + Date.now();
    let session;
    try {
      session = await pay.initiateSession(phoneNorm);
    } catch (e) {
      return fail("payment_init_failed", 502, { detail: e.message });
    }

    // مصدر الطلب — قايمة مفاتيح مسموحة، وip/ua من الهيدر بس. عمره ما يوقّع الطلب.
    let attribution = null, meta = null;
    try { meta = parseCheckoutMeta(b, (n) => c.req.header(n)); attribution = meta.attribution; }
    catch (e) { console.error(`[shop] ${orderNo}: checkout meta parse failed: ${e.message}`); }

    const inserted = await pool.query(
      `INSERT INTO shop_orders(order_no, status, option, branch_id, customer, phone_norm,
         address, items, pos_calc, subtotal, delivery_fee, tip, total, delivery_quote,
         mf_session_id, notes, coupon, discount_percent, discount_amount, history, attribution)
       VALUES ($1,'pending_payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING created_at`,
      [orderNo, option, branchId,
       jb({ name: nameChk.name.slice(0, NAME_MAX), phone: "+966" + phoneNorm, deviceId: b.deviceId ? String(b.deviceId).slice(0, 64) : null }), phoneNorm,
       jb(orderAddress(b.address, option)), jb(await namedItems(items)), jb(calc),
       // subtotal = the food part of what was charged (fee booked separately
       // whether inside or outside the POS invoice).
       r2(total - deliveryFee), deliveryFee, tip, total, jb(dq ? { ...dq, feeInPos, freeDeliveryByCoupon } : null),
       session.SessionId || null, (b.notes || "").slice(0, 200),
       coupon?.ok ? coupon.code : null, discountPercent, discountAmount,
       jb([{ at: new Date().toISOString(), status: "pending_payment" }]), jb(attribution)]
    );
    // journey_sid/client/app_version (W1-02) + attrib_source (W4-02) — تحديث
    // منفصل fire-and-forget: لو الأعمدة لسه ماتضافتش (ensureOrderColumns) الطلب
    // نفسه مايتأثرش. وهنا كمان بنكمّل الـutm الناقص من جلسة الرحلة: المتصفّح
    // الداخلي بتاع فيسبوك بيمسح الـlocalStorage، فطلبات جاية من إعلان كانت
    // بتتسجّل "direct". الجلسة اتسجّلت على السيرفر ساعة الهبوط، فهي المصدر.
    if (meta) {
      (async () => {
        let attr = meta.attribution || {};
        const utmEmpty = !attr.utm || Object.keys(attr.utm).length === 0;
        if (meta.journey_sid && (utmEmpty || !attr.fc_link)) {
          const s = await pool.query(SESSION_ATTR_SQL, [meta.journey_sid]).catch(() => null);
          const merged = mergeSessionAttribution(attr, s?.rows?.[0] || null);
          if (merged.enriched) attr = merged.attribution;
        }
        await pool.query(
          `UPDATE shop_orders SET journey_sid=$2, client=$3, app_version=$4,
             attrib_source=$5, attribution=COALESCE($6::jsonb, attribution) WHERE order_no=$1`,
          [orderNo, meta.journey_sid || null, meta.client || null, meta.app_version || null,
           classifySource(attr), attr === meta.attribution ? null : jb(attr)]);
      })().catch((e) => console.error(`[shop] ${orderNo}: checkout meta save failed: ${e.message}`));
    }
    // موافقة الإعلانات (PDPL — consent.js): خانة اختيارية في الشيك أوت. fire-and-forget،
    // عمرها ما توقّع الطلب، والرقم هنا متأكد بالـOTP.
    if (b && b.marketing_consent) {
      recordCheckoutConsent(pool, {
        phoneNorm, orderNo, raw: b.marketing_consent,
        ip: c.req.header("cf-connecting-ip") || null, ua: c.req.header("user-agent") || null,
      }).catch(() => {});
    }
    // موافقة واتساب من الشيك أوت («وصّلني تحديثات الطلب على واتساب») — fire-and-forget.
    // بتتسجّل بس لو المتجر بعت الحقل صراحةً؛ غيابه مايغيّرش موافقة قديمة.
    if (wa() && (typeof b.waUpdates === "boolean" || typeof b.waMarketing === "boolean")) {
      Promise.resolve().then(() => wa().recordOptIn({ phone: phoneNorm,
        updates: typeof b.waUpdates === "boolean" ? b.waUpdates : undefined,
        marketing: typeof b.waMarketing === "boolean" ? b.waMarketing : undefined,
        source: "checkout", orderNo }))
        .catch((e) => console.error(`[shop] ${orderNo}: wa opt-in save failed: ${e.message}`));
    }
    // مفتاح الاستكمال/التتبع (٠٣ A3/A9) — null لو SHOP_RESUME_SECRET مش متظبط
    const k = resumeKey({ orderNo, createdAt: inserted?.rows?.[0]?.created_at });
    journeyEmit("checkout_result", {
      ok: true, error_code: null, http_status: 200, order_no: orderNo,
      total, subtotal: r2(total - deliveryFee), delivery_fee: deliveryFee, discount: discountAmount,
      coupon: coupon?.ok ? coupon.code : null, option, items_count: items.length,
      has_bundle: bundleItems.length > 0, journey_sid: meta?.journey_sid || null, client: meta?.client || null,
      ms: Date.now() - t0,
    });
    return c.json({
      ok: true, orderNo, total, subtotal: r2(total - deliveryFee), deliveryFee, tip,
      discount: discountAmount, coupon: coupon?.ok ? coupon.code : null,
      discountSource, feeInPos, currency: "SAR",
      sessionId: session.SessionId, countryCode: session.CountryCode || "SAU",
      resumeKey: k, trackKey: k,
    });
  });

  /* ── execute: embedded form collected the method → 3DS redirect URL ── */
  app.post("/api/shop/execute", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const row = await getOrderRow(b.orderNo);
    if (!row) return c.json({ ok: false, error: "order_not_found" }, 404);
    if (row.status !== "pending_payment") return c.json({ ok: false, error: "already_processed" }, 409);

    const publicUrl = env("STOREFRONT_PUBLIC_URL", "https://freshcuts.sa");
    let res;
    try {
      res = await pay.executePayment({
        sessionId: b.sessionId || row.mf_session_id,
        amount: Number(row.total),
        orderNo: row.order_no,
        customerName: row.customer?.name,
        customerMobile: row.customer?.phone,
        callbackUrl: `${publicUrl}/pay/success?on=${row.order_no}`,
        errorUrl: `${publicUrl}/pay/error?on=${row.order_no}`,
      });
    } catch (e) {
      return c.json({ ok: false, error: "execute_failed", detail: e.message }, 502);
    }
    await pool.query(
      "UPDATE shop_orders SET mf_invoice_id=$2, updated_at=NOW() WHERE order_no=$1",
      [row.order_no, res.InvoiceId != null ? String(res.InvoiceId) : null]
    );
    return c.json({ ok: true, paymentUrl: res.PaymentURL || res.InvoiceURL || null, invoiceId: res.InvoiceId });
  });

  /* ── confirmOrder — the one door to "paid" (webhook / browser / sweep) ── */
  async function confirmOrder({ orderNo, invoiceId, via = null }) {
    let row = orderNo ? await getOrderRow(orderNo) : null;
    if (!row && invoiceId) {
      const r = await pool.query("SELECT * FROM shop_orders WHERE mf_invoice_id=$1", [String(invoiceId)]);
      row = r.rows[0] || null;
    }
    if (!row) return { ok: false, error: "order_not_found" };
    if (row.status !== "pending_payment") {
      // paid already (or beyond) — idempotent success so retries are harmless
      return { ok: true, status: row.status, orderNo: row.order_no };
    }
    const key = row.mf_invoice_id || String(invoiceId || "");
    if (!key) return { ok: false, error: "no_invoice" };

    let st;
    try {
      st = await pay.paymentStatus({ key, keyType: "InvoiceId" });
    } catch (e) {
      emitOrder("payment_check", { orderNo: row.order_no, source: "shop", ok: false,
        data: { via, is_paid: null, error: String(e?.message || e).slice(0, 200) } });
      throw e;
    }
    {
      // آخر معاملة (أسماء الحقول من رد ماي فاتورة — TransactionStatus/ErrorCode لسه مش متأكدة من رد حقيقي)
      const txs = Array.isArray(st?.raw?.InvoiceTransactions) ? st.raw.InvoiceTransactions : [];
      const last = txs.length ? txs[txs.length - 1] : null;
      emitOrder("payment_check", { orderNo: row.order_no, source: "shop", ok: Boolean(st.isPaid),
        data: { via, is_paid: Boolean(st.isPaid), invoice_status: st.invoiceStatus ?? null,
                mf_tx_status: last?.TransactionStatus ?? null, mf_error_code: last?.ErrorCode ?? null } });
    }
    if (!st.isPaid) return { ok: false, status: "unpaid", invoiceStatus: st.invoiceStatus };
    // Belt-and-braces: the invoice must be OUR order's invoice for OUR amount.
    if (st.orderNo && st.orderNo !== row.order_no) {
      return { ok: false, error: "reference_mismatch" };
    }
    // انتقال ذري: بس المنادي اللي يكسب pending_payment→paid يكمّل. من غير ده
    // الـwebhook والمتصفح ممكن يعدّوا الشرط مع بعض ويعملوا طلبين في نقطة البيع.
    // بوابة ماي فاتورة الفعلية (ap/md/vm…) بتتسجّل هنا عشان وسيلة الدفع الصح.
    const won = await pool.query(
      `UPDATE shop_orders SET status='paid', updated_at=NOW(),
          history = history || $2::jsonb, mf_payment_id=$3, pay_gateway=$4
        WHERE order_no=$1 AND status='pending_payment'
        RETURNING order_no`,
      [row.order_no, jb([{ at: new Date().toISOString(), status: "paid" }]),
       st.paymentId != null ? String(st.paymentId) : null, st.gateway || null]);
    if (!won.rowCount) {
      // منادي تاني كسب السباق — نجاح idempotent من غير ما نكرّر أي شغل
      const after = await getOrderRow(row.order_no);
      return { ok: true, status: after ? after.status : "paid", orderNo: row.order_no };
    }
    emitOrder("order_paid", { orderNo: row.order_no, source: "shop", ok: true,
      data: { via, total: Number(row.total) || 0, gateway: st.gateway || null, option: row.option || null } });
    if (notify) notify.orderStatusChanged(String(row.order_no), "paid").catch((e) =>
      console.error(`[shop] notify failed for ${row.order_no}:`, e.message));
    // رسالة لمدير المطعم مع كل طلب مدفوع (مرة واحدة لكل طلب)
    claimAlert(row.order_no, "staff:new_order").then(async (ok) => {
      if (!ok) return;
      const fresh = await getOrderRow(row.order_no);
      if (fresh) await staff.newOrder(fresh);
    }).catch((e) => console.error(`[shop] staff new-order sms ${row.order_no}:`, e.message));
    // The coupon burns exactly when money moved, not at checkout — an
    // abandoned payment must not eat a limited-use code. Ambassador codes
    // (not in shop_coupons) mark redeemed instead, keeping their attribution.
    if (row.coupon) {
      pool.query("UPDATE shop_coupons SET used_count = used_count + 1 WHERE code=$1", [row.coupon])
        .then((up) => up.rowCount ? null : pool.query(
          "UPDATE codes SET redeemed=true, redeemed_at=NOW(), updated_at=NOW() WHERE upper(code)=upper($1)", [row.coupon]))
        .catch((e) => console.error("[shop] coupon burn failed:", e.message));
    }
    // العنوان يتحفظ في دفتر العميل بمجرد ما الفلوس تتحرك — بغض النظر عن كونه
    // مسجل دخول وقت الطلب أو لأ. من غير ده، اللي طلب كضيف النهاردة وسجّل
    // دخول بكرة يلاقي دفتر عناوين فاضي، ويبقى وعدنا ليه بالدخول كلام فاضي.
    if (row.option === "delivery" && row.address) {
      Promise.resolve(accounts()?.saveAddressFor?.(row.phone_norm, row.address))
        .catch((e) => console.error("[shop] address autosave failed:", e.message));
    }
    // السلة المتروكة اتقفلت: الطلب اتم فعلاً
    const cartsApi = carts();
    if (cartsApi) cartsApi.markOrdered({
      phoneNorm: row.phone_norm, deviceId: (row.customer || {}).deviceId, orderNo: row.order_no,
    }).catch(() => {});
    await createPosOrder(row.order_no);
    const after = await getOrderRow(row.order_no);
    return { ok: true, status: after.status, orderNo: row.order_no, posOrderId: after.pos_order_id };
  }

  /* Create the POS external order from the locked calc. Failure is a STATE
     (paid_pos_failed), not an exception — the sweep retries and the dashboard
     shows it; the customer's money is never in limbo silently. */
  /* المسار الجديد المدفوع مسبقاً: يبني طلب الشريك من صفوف الأوردر.
     الأصناف بأسعارها الصافية (unit_amount ÷ وحدة السطر mf = ريال قبل الضريبة، زي
     ما تاب سينس بيخزّنها)، والشريك بيعيد حساب الضريبة من tax_id بتاع المنتج.
     رسوم التوصيل بتتحط في الملاحظات (الطلب already_paid فالكاشير مش بيحصّل).
     TODO الإنتاج: بعد وصول مفاتيح الإنتاج، تأكّد إن إجمالي طلب الشريك بيطابق
     اللي العميل دفعه (خصوصاً الخصومات ورسوم التوصيل) قبل تشغيل TSP_AUTO_ORDER. */
  /* اسم العميل اللي بيروح لنقطة البيع وللمندوب: اسم الطلب لو اسم حقيقي، وإلا
     الاسم اللي على الحساب (الاسم المؤقت مابيتحسبش خالص). row.acct_name بيجي
     من createPosOrder اللي بيقراه مع الصف. */
  function bestOrderName(row) {
    for (const cand of [row.customer?.name, row.acct_name]) {
      if (plausibleName(cand)) return String(cand).trim().slice(0, NAME_MAX);
    }
    return null;
  }

  function buildPartnerOrder(row, settings) {
    const addr = row.address || {};
    // الخصم مابيتكتبش للكاشير/المطبخ (عمر 16 سبتمبر) — سعر السطور بعد الخصم كفاية
    const notes = posNotesOf(row, { withFee: true });
    const items = partnerItemsOf(row);
    // رسوم التوصيل تنزل في الفاتورة كسطر منتج «رسوم التوصيل» (فئة رسوم، ضريبة 15%).
    // بنبعت الرقم صافي (fee/1.15) عشان الإجمالي في تاب سينس يطلع شامل الضريبة =
    // اللي العميل دفعه بالظبط. أي سياسة (مجاني/مخصوم/حسب المسافة) بتنعكس تلقائياً
    // لأننا بنبعت delivery_fee الفعلي؛ لو صفر مفيش سطر. تكلفة لاجلك بتتسجّل منفصلة.
    const feeProductId = settings.deliveryFeeProductId;
    const fee = Number(row.delivery_fee) || 0;
    if (fee > 0 && feeProductId) {
      items.push({ productId: feeProductId, quantity: 1, unitPrice: fee / 1.15 });
    }
    return {
      externalOrderNo: row.order_no,
      orderOption: row.option, // delivery→توصيل · pickup→سفري (Take away) للتقارير
      paymentMethod: posPaymentMethodFor(row.pay_gateway, settings),
      notes,
      customer: {
        /* الاسم اللي بيتبعت هنا بيظهر في ملاحظات الطلب بس — نقطة البيع بتعرض
           اسم دفتر العملاء للرقم ده على الشاشة والفاتورة (اتأكدنا ٢١/٩)،
           وده اللي ensurePosName بيصلّحه قبل الإنشاء. بنبعت الاسم الحقيقي
           برضه عشان الملاحظات تبقى مقروءة للكاشير مهما حصل. */
        name: bestOrderName(row),
        phone: row.customer?.phone || null,
        address: { city: null, area: addr.area || null, street: addr.street || null },
      },
      deliveryAddress: {
        line: posAddressLine(row),
        city: null,
        // «ملاحظات التوصيل» بتاعة العنوان في قسم التوصيل — مش مع ملاحظات الأكل (عمر ١٩/٩)
        extra: row.option === "delivery" ? (deliveryNotesOf(row).slice(0, 200) || null) : null,
      },
      items,
    };
  }

  async function createPosOrder(orderNo) {
    const row = await getOrderRow(orderNo);
    if (!row || row.pos_order_id) return;
    const settings = (await getSettingsData()).shop || {};
    const addr = row.address || {};

    /* ── الاسم اللي هيتشاف على شاشة الكاشير ─────────────────────────────
       نقطة البيع بتعرض اسم **دفتر العملاء** للرقم، مش الاسم اللي جوه الطلب.
       فقبل ما ننشئ الطلب بنتأكد إن صف الدفتر عليه الاسم الحقيقي — ده اللي
       بيمنع «عميل أونلاين» من أول لحظة. عمره ما يعطّل الطلب: أي فشل أو بطء
       بنعدّيه (الكنس الدوري بيصلّحه بعدين). */
    row.acct_name = (await pool.query(
      "SELECT name FROM acct_customers WHERE phone_norm=$1", [row.phone_norm]
    ).catch(() => ({ rows: [] }))).rows[0]?.name || null;
    const pn = posNames();
    if (pn && row.phone_norm) {
      await Promise.race([
        pn.ensurePosName(row.phone_norm, bestOrderName(row)).catch(() => null),
        new Promise((r) => setTimeout(r, 6000)),
      ]).catch(() => {});
    }

    // المسار المفضّل: طلب مدفوع مسبقاً عبر API الشريك (يلغي تحصيل الكاشير).
    // بيتفعّل فقط لما TSP_AUTO_ORDER=1 والربط شغّال. أي فشل بيرجع للمسار القديم
    // (المتجر) فالطلب مايتعطّلش أبداً.
    if (process.env.TSP_AUTO_ORDER === "1" && (row.items || []).length) {
      /* ممنوع الرجوع لمسار المتجر العادي (16 سبتمبر 2026). طلب W1789555412320
         (124 ر.س مدفوع Apple Pay) نزل منه كطلب QR «غير مدفوع» من غير عميل ولا
         عنوان ولا رسوم التوصيل — الكاشير اتلخبط والتتبع اتلخبط. عمر: «المشكلة دي
         مينفعش تتكرر». دلوقتي: لحد ٣ محاولات على الشريك (بس لو العطل قبل إنشاء
         الطلب: توكن/اتصال)، ولو فشلوا الطلب بيفضل paid_pos_failed — أحمر وبصوت
         في البورتال + إنذار المهل — والكنس بيعيد على الشريك كل دورة. */
      const partner = tsp();
      let lastErr = null;
      // الكنس بيعيد كل دقيقتين لمدة ٢٤ ساعة: فشل بنفس الخطأ المسجّل مايتكررش كحدث
      const sameFailure = (msg) => row.status === "paid_pos_failed"
        && String(row.last_pos_error || "") === String(msg || "").slice(0, 500);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (!partner || !(await partner.status()).connected) {
            throw Object.assign(new Error("partner not connected"), { retryable: true });
          }
          const out = await partner.createExternalOrder(buildPartnerOrder(row, settings));
          emitOrder("pos_push", { orderNo: String(orderNo), source: "shop", ok: true,
            data: { ok: true, path: "partner", attempt, outcome: "pos_created", fallback: false, pos_order_id: String(out.id) } });
          await setStatus(orderNo, "pos_created", { cols: { pos_order_id: String(out.id) }, from: row.status });
          await pool.query(
            "UPDATE shop_orders SET pos_attempts=pos_attempts+1, last_pos_error=NULL WHERE order_no=$1", [orderNo]);
          /* رقم الطلب الرقمي في تاب سينس + ربط المرآة بالعميل الحقيقي.
             من غير ده الطلب بيتعد في التقارير كطلب نقطة بيع بلا صاحب،
             و«جديد ولا راجع» وملف العميل بيطلعوا غلط. كله fire-and-forget. */
          if (out.tenantOrderId) {
            pool.query("UPDATE shop_orders SET pos_tenant_order_id=$2 WHERE order_no=$1",
              [orderNo, String(out.tenantOrderId)]).catch(() => {});
          }
          if (pn) pn.linkPosOrders({ limit: 5 }).catch(() => {});
          console.log(`[shop] ${orderNo}: partner paid order ${out.id} (linkedCustomer=${out.linkedCustomer}, attempt ${attempt})`);
          // Purchase من السيرفر (W0-03) — من غير انتظار، وفشله مايلمسش الطلب
          fireServerPurchase(deps.funnel, orderNo);
          // شبكة أمان: إجمالي نقطة البيع لازم يساوي اللي العميل دفعه (فرق > ١ ر.س = إنذار)
          const posTotal = Number(out.total), paid = Number(row.total) - (Number(row.tip) || 0);
          if (Number.isFinite(posTotal) && posTotal > 0 && Math.abs(posTotal - paid) > 1) {
            console.error(`[shop] ${orderNo}: POS TOTAL MISMATCH pos=${posTotal} paid=${paid}`);
            if (await claimAlert(orderNo, "staff:total_mismatch")) {
              staff.critical((lang) => lang === "ar"
                ? `فريش كاتس مراجعة ${orderNo}: نقطة البيع ${Math.round(posTotal * 100) / 100} والمدفوع ${paid}`
                : `Fresh Cuts CHECK ${orderNo}: POS total ${Math.round(posTotal * 100) / 100} SAR but customer paid ${paid} SAR. Fix the POS order.`,
                `total-mismatch ${orderNo}`).catch(() => {});
            }
          }
          return;
        } catch (e) {
          lastErr = e;
          const detail = e.resp ? " | " + JSON.stringify(e.resp).slice(0, 300) : "";
          console.error(`[shop] partner order attempt ${attempt}/3 failed for ${orderNo}: ${e.message}${detail}`);
          // إعادة فورية بس لأعطال قبل الإنشاء (توكن/اتصال) — غير كده ممكن الطلب
          // يكون اتعمل فعلاً والإعادة تعمل طلب مكرر؛ دي بتستنى الكنس + عين بني آدم.
          const early = e.retryable || e.status === 401
            || /Unauthenticated|not connected|fetch failed|EAI_AGAIN|ECONN|ETIMEDOUT|socket/i.test(String(e.message));
          if (!sameFailure(e?.message)) {
            emitOrder("pos_push", { orderNo: String(orderNo), source: "shop", ok: false,
              data: { ok: false, path: "partner", attempt, error: String(e?.message || e).slice(0, 300),
                      retryable: Boolean(early), outcome: early && attempt < 3 ? "retry" : "failed", fallback: false } });
          }
          if (!early || attempt === 3) break;
          await new Promise((r) => setTimeout(r, attempt * 2500));
        }
      }
      await pool.query(
        "UPDATE shop_orders SET pos_attempts=pos_attempts+1, last_pos_error=$2, updated_at=NOW() WHERE order_no=$1",
        [orderNo, String((lastErr && lastErr.message) || "partner order failed").slice(0, 500)]);
      // مفيش رجوع لمسار المتجر (16 سبتمبر) — بدل partner_fallback في الخطة بنسجّل إن الشريك فشل
      // مرة واحدة عند الانتقال لـpaid_pos_failed، مش كل دورة كنس
      const failedEvt = row.status !== "paid_pos_failed" ? PARTNER_FAILED_EVENT() : null;
      if (failedEvt) {
        emitOrder(failedEvt, { orderNo: String(orderNo), source: "shop", ok: false,
          data: { partner_failed: true, fallback: false, outcome: "paid_pos_failed",
                  error: String((lastErr && lastErr.message) || "partner order failed").slice(0, 300) } });
      }
      if (row.status !== "paid_pos_failed") {
        await setStatus(orderNo, "paid_pos_failed", { note: "نقطة البيع رفضت/مش متاحة — بنعيد تلقائي على الشريك", from: row.status });
      }
      return;
    }

    // المسار القديم (API المتجر) بيبعت pos_calc زي ما هو — وده مافيهوش سطور
    // الباقة (تاب سينس بترفض أسعارها على المتجر). لو كملنا، الطلب هينزل من
    // غير أكل الباقة والعميل دافع تمنها. فبنوقف بصوت عالي: الطلب يفضل
    // paid_pos_failed ظاهر في اللوحة، والكاشير يدخّله يدوي — أحسن من أكل ناقص.
    if ((row.items || []).some((it) => it && it.bundle)) {
      const errText = "bundle order needs the partner path (TSP_AUTO_ORDER=1 + connected); store path cannot carry bundle prices";
      console.error(`[shop] ${orderNo}: ${errText}`);
      await pool.query(
        "UPDATE shop_orders SET pos_attempts=pos_attempts+1, last_pos_error=$2, updated_at=NOW() WHERE order_no=$1",
        [orderNo, errText]);
      if (row.status !== "paid_pos_failed" || String(row.last_pos_error || "") !== errText) {
        emitOrder("pos_push", { orderNo: String(orderNo), source: "shop", ok: false,
          data: { ok: false, path: "store", attempt: (Number(row.pos_attempts) || 0) + 1, error: "bundle_needs_partner",
                  outcome: "paid_pos_failed", fallback: false } });
      }
      if (row.status !== "paid_pos_failed") await setStatus(orderNo, "paid_pos_failed", { note: "باقة — محتاجة مسار الشريك", from: row.status });
      return;
    }

    try {
      const created = await tsstore.createPosOrder({
        branchId: row.branch_id,
        orderOptionId: OPTION_ID[row.option] || 3,
        calcData: row.pos_calc,
        orderNo: row.order_no,
        customer: {
          id: null,
          first_name: row.customer?.name || null,
          phone_number: row.customer?.phone || null,
          email: null,
          address: { city: null, area: addr.area || null, country_code: null, street: addr.street || null },
        },
        // Omar's rule (2026-08-13): وقت الطلب ووقت الاستلام في الملاحظات
        // إجباري. Riyadh clock — the cashier reads this, not a machine.
        notes: posNotesOf(row),
        paymentMethod: posPaymentMethodFor(row.pay_gateway, settings),
        deliveryAddress: addr.street || addr.area || (row.option === "delivery" ? "Delivery" : "Pickup"),
        latitude: addr.latitude, longitude: addr.longitude,
      });
      emitOrder("pos_push", { orderNo: String(orderNo), source: "shop", ok: true,
        data: { ok: true, path: "store", attempt: (Number(row.pos_attempts) || 0) + 1, outcome: "pos_created",
                fallback: false, pos_order_id: String(created.id) } });
      await setStatus(orderNo, "pos_created", {
        cols: { pos_order_id: String(created.id) }, from: row.status,
      });
      await pool.query(
        "UPDATE shop_orders SET pos_attempts=pos_attempts+1, last_pos_error=NULL WHERE order_no=$1", [orderNo]);
      fireServerPurchase(deps.funnel, orderNo); // Purchase من السيرفر (W0-03) — fire-and-forget
    } catch (e) {
      // TabSense's actual answer is the diagnosis — "order creation failed"
      // alone cost us a stalled paid order on 2026-08-13.
      const detail = e.resp ? JSON.stringify(e.resp).slice(0, 600) : "";
      const errText = `${e.message}${detail ? " | " + detail : ""}`;
      console.error(`[shop] POS create failed for ${orderNo}: ${errText}`);
      await pool.query(
        "UPDATE shop_orders SET pos_attempts=pos_attempts+1, last_pos_error=$2, updated_at=NOW() WHERE order_no=$1",
        [orderNo, errText.slice(0, 800)]);
      // history gets ONE entry per state change, not one per 2-minute retry
      if (row.status !== "paid_pos_failed" || String(row.last_pos_error || "") !== errText.slice(0, 800)) {
        emitOrder("pos_push", { orderNo: String(orderNo), source: "shop", ok: false,
          data: { ok: false, path: "store", attempt: (Number(row.pos_attempts) || 0) + 1, error: String(e?.message || e).slice(0, 300),
                  outcome: "paid_pos_failed", fallback: false } });
      }
      if (row.status !== "paid_pos_failed") {
        await setStatus(orderNo, "paid_pos_failed", { note: errText.slice(0, 300), from: row.status });
      }
    }
  }

  /* Browser lands back from 3DS → the storefront polls this. Public. */
  app.post("/api/shop/payment-status", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "?";
    if (rateLimited(ip, 240)) return c.json({ ok: false, error: "rate_limited" }, 429);
    let b = {};
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    if (!b.orderNo) return c.json({ ok: false, error: "orderNo required" }, 400);
    const res = await confirmOrder({ orderNo: String(b.orderNo), invoiceId: b.invoiceId, via: "browser" });
    return c.json(res, res.ok ? 200 : 402);
  });

  /* Customer tracking — delivery-app style stages + courier driver info. */
  app.get("/api/shop/track/:orderNo", async (c) => {
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, found: false }, 404);
    const stage = STAGES[row.status] || { label: row.status, step: 0 };
    let label = stage.label, step = stage.step;
    let courier = null;
    const ready = Boolean(row.pos_ready_at);

    if (row.option === "pickup" && row.status === "delivered") {
      label = "استلمت طلبك — بالهنا والشفا 🌟"; step = 5;
    } else if (row.option === "pickup") {
      // الاستلام (سفري): «جاهز» بتيجي من الكاشير (pos_ready_at)؛ لو ماوصلتش،
      // بنقدّرها بالوقت بعد القبول عشان العميل مايفضلش على «بيجهّز» للأبد.
      if (row.status === "accepted" || row.status === "pos_created") {
        const acceptedAt = new Date(row.updated_at || row.created_at).getTime();
        const readyAfterMin = Number(((await getSettingsData()).shop || {}).pickupReadyMinutes) || 20;
        if (ready || Date.now() - acceptedAt >= readyAfterMin * 60_000) {
          label = "جاهز للاستلام من الفرع 📍"; step = 4;
        } else {
          label = "جاري تجهيز طلبك — جاهز للاستلام قريباً"; step = 2;
        }
      }
    } else if (row.option === "delivery") {
      /* «المطعم أولاً» (قرار عمر): مانعرضش أي كلام عن المندوب لحد ما الكاشير
         يسجّل الطلب جاهز (pos_ready_at). قبلها التتبع بيفضل «المطعم بيجهّز»
         حتى لو المندوب اتعيّن فعلاً — عشان العميل مايفتكرش إن الأكل جاهز
         واحنا بندوّر على مندوب. */
      if (row.status === "delivered") {
        label = "تم توصيل طلبك — بالهنا والشفا 🌟"; step = 5;
      } else if (row.status === "on_the_way") {
        label = "طلبك في الطريق إليك الآن 🛵💨"; step = 4;
      } else if (ready) {
        label = "طلبك جاهز وبنسلّمه للمندوب 🛵"; step = 3;
      } else if (["paid", "pos_created"].includes(row.status)) {
        label = "تم الدفع واستلمنا طلبك ✅"; step = 1;
      } else if (row.status === "courier_assigned") {
        // 16 سبتمبر: الكابتن كان واصل المطعم والعميل شايف «بيجهّز» من غير أي أثر
        // للمندوب. الأكل لسه بيتجهّز، بس المندوب اتعيّن فعلاً — فبنقول الاتنين.
        label = "المطعم بيجهّز طلبك — والمندوب في الطريق للمطعم 🛵"; step = 2;
      } else {
        // accepted / courier_requested والأكل لسه بيتجهّز
        label = "المطعم بيجهّز طلبك 👨‍🍳"; step = 2;
      }
      // المندوب بيظهر أول ما يتعيّن (مش بس بعد «جاهز»)
      if (ready || ["courier_assigned", "on_the_way", "delivered"].includes(row.status)) {
        const sh = await delivery.shipmentOf(row.order_no);
        if (sh) {
          courier = {
            status: sh.status, driver: sh.driver || null,
            // محطّتا المندوب (١٧ سبتمبر) — العميل بيشوف إن الكابتن واصل فعلاً
            arrivedAt: sh.arrived_at || null, pickedAt: sh.picked_at || null,
          };
          /* «الكابتن في المطعم» أوضح بكتير من «بيجهّز» وهو واقف عندنا فعلاً.
             بيتعرض بس لما الشركة تقول وصل ولسه ما استلمش. */
          if (sh.arrived_at && !sh.picked_at && !["on_the_way", "delivered"].includes(row.status)) {
            label = ready ? "المندوب في المطعم وبيستلم طلبك 🛵" : "المندوب وصل المطعم — طلبك بيتجهّز 👨‍🍳";
            step = ready ? 3 : 2;
          }
        }
      }
    }
    return c.json({
      ok: true, found: true, orderNo: row.order_no, status: row.status,
      label, step, option: row.option,
      total: Number(row.total), subtotal: Number(row.subtotal),
      deliveryFee: Number(row.delivery_fee), courier,
      /* «توصيل بعيد»: العميل وافق على رسوم مسافة إضافية — بيشوفها في صفحة
         التتبع زي ما شافها في الدفع بالظبط، مش رقم بيختفي بعد الطلب. */
      farZone: farZoneOfRow(row),
      // the id the ad pixels must use for Purchase — same id the offline POS
      // sync reports, so the platforms de-dupe instead of double counting
      posOrderId: row.pos_order_id || null,
      createdAt: row.created_at,
    });
  });

  /* Dashboard monitor + reconciliation feed. */
  /* ── بورتال الكاشير ────────────────────────────────────────────────────
     شاشة الطلبات الحية اللي بتفتح على تابلت في المطبخ. بتستخدم نفس دخول
     الكاشير (رقم سري) — مش توكن الأدمن، عشان ما نديش موظف الكاشير مفتاح
     اللوحة كلها.

     اللي بترجعه مقصود ومحدود: اللي الكاشير محتاجه عشان يشتغل، ومفيش أرقام
     فلوس اللوحة ولا بيانات تانية. */
  // زرار «ابعت رسالة تجربة» في اللوحة
  app.post("/api/shop/staff-sms/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json({ ok: true, ...(await staff.test()) }); }
    catch (e) { return c.json({ ok: false, error: e.message }); }
  });

  app.get("/api/shop/board", async (c) => {
    const err = await requireCashierOrAdmin(c); if (err) return err;
    const hours = Math.min(48, Math.max(1, Number(c.req.query("hours")) || 12));
    const rows = (await pool.query(
      `SELECT o.order_no, o.status, o.option, o.customer, o.phone_norm, o.address,
              o.items, o.subtotal, o.delivery_fee, o.tip, o.total, o.coupon,
              o.pos_order_id, o.notes, o.created_at, o.updated_at, o.last_pos_error,
              o.alerts, o.refund_attempts,
              s.status AS ship_status, s.driver AS ship_driver, s.fa_order_number, s.dispatch,
              s.provider AS ship_provider, s.provider_ref AS ship_ref, s.cost AS ship_cost
         FROM shop_orders o
         LEFT JOIN LATERAL (
           SELECT status, driver, fa_order_number, dispatch, provider, provider_ref, cost
             FROM dl_shipments
            WHERE shop_order_no = o.order_no ORDER BY id DESC LIMIT 1) s ON TRUE
        WHERE o.status NOT IN ('pending_payment','expired')
          AND o.created_at > NOW() - ($1 || ' hours')::interval
        ORDER BY o.created_at DESC LIMIT 80`, [String(hours)])).rows;

    /* الوضع + مهل التصعيد بيرجعوا مع كل تحديث: الشاشة لازم تعرف إحنا في
       المرحلة اليدوية ولا الآلية عشان تعرض الأزرار الصح — مش تفترض. */
    const settings = await getSettingsData();
    const gate = await delivery.dispatchGate();
    const sla = { ...((settings.delivery || {}).sla || {}),
      dispatchDelayMin: (await delivery.dispatchGate()).mode === "auto" ? dispatchDelayOf(settings) : 0 };

    return c.json({
      ok: true, at: new Date().toISOString(),
      mode: gate.mode, modeForced: gate.forced, modeSource: gate.source,
      /* بيانات المرحلة اليدوية اللي الكاشير محتاجها في اللوحة الخارجية */
      manualTarget: {
        provider: (settings.delivery || {}).manualProviderLabel || "أجلك (4U)",
        dashboardUrl: (settings.delivery || {}).manualDashboardUrl || null,
        pickup: {
          name: (settings.delivery || {}).pickupContactName || "فريش كاتس",
          phone: msisdn((settings.delivery || {}).pickupContactPhone || ""),
          address: (settings.delivery || {}).pickupAddress || "فريش كاتس — حي السلامة، دوار رامي، جدة",
          lat: Number(process.env.TABSENSE_STORE_LAT || 21.5881404),
          lng: Number(process.env.TABSENSE_STORE_LNG || 39.1521236),
        },
      },
      orders: rows.map((r) => ({
        orderNo: r.order_no, status: r.status, option: r.option,
        name: (r.customer || {}).name || null, phone: r.phone_norm,
        address: r.address || null, items: r.items || [],
        subtotal: Number(r.subtotal), deliveryFee: Number(r.delivery_fee),
        tip: Number(r.tip), total: Number(r.total), coupon: r.coupon,
        posOrderId: r.pos_order_id, notes: r.notes,
        createdAt: r.created_at, updatedAt: r.updated_at,
        posError: r.last_pos_error,
        refundAttempts: Number(r.refund_attempts) || 0,

        /* درجة التأخير — الشاشة بتلوّن وترتّب بيها، والرسالة مكتوبة
           للكاشير مش للمبرمج. */
        sla: slaCheck(r, sla),

        /* ── حزمة النقل اليدوي ───────────────────────────────────────
           كل حاجة الكاشير محتاج ينقلها للوحة «أجلك»، **بصيغتها النهائية**،
           عشان ما يقعدش يحوّل أرقام في دماغه وهو واقف في عز الخدمة:
             • الجوال بصيغة أجلك بالظبط: 9665XXXXXXXX من غير +
             • الجوال المحلي للاتصال بالعميل
             • العنوان سطر واحد جاهز للّصق
             • الإحداثيات «lat,lng» — نسخة واحدة تتلزق في خانة الموقع
           كل واحدة فيهم حقل مستقل عشان زرار «انسخ» ينسخ الحاجة لوحدها. */
        handoff: r.option !== "delivery" ? null : {
          name: (r.customer || {}).name || "عميل فريش كاتس",
          phone: msisdn(r.phone_norm),                    // 9665XXXXXXXX
          phoneLocal: r.phone_norm ? "0" + r.phone_norm : null,
          address: readableAddress(r.address || {}),
          coords: (r.address || {}).latitude && (r.address || {}).longitude
            ? `${(r.address).latitude},${(r.address).longitude}` : null,
          mapsUrl: (r.address || {}).latitude && (r.address || {}).longitude
            ? `https://www.google.com/maps/dir/?api=1&destination=${(r.address).latitude},${(r.address).longitude}`
            : null,
          total: Number(r.total),
          // الكابتن ما بيحصّلش — الطلب مدفوع. أهم سطر في الشاشة كلها.
          paid: true,
          payNote: "مدفوع أونلاين — لا يُحصَّل من العميل",
          // للمندوب: الباب + ملاحظات التوصيل بتاعة العنوان — مش ملاحظات الأكل (عمر ١٩/٩)
          notes: courierNotes(r),
          orderNo: r.order_no,
        },

        courier: r.ship_status ? {
          status: r.ship_status, driver: r.ship_driver || null,
          orderNumber: r.fa_order_number || null,
          // «اتقبل الطلب» مش معناها «في كابتن» — الشاشة لازم تفرّق
          assigned: Boolean((r.dispatch || {}).assigned),
          note: (r.dispatch || {}).message || null,
          provider: r.ship_provider || null,
          manual: r.ship_provider === "manual",
          ref: r.ship_ref || null,                 // رقم الطلب في لوحة الشركة
          cost: r.ship_cost != null ? Number(r.ship_cost) : null,
        } : null,
      })),
    });
  });

  /* الكاشير بيطلب مندوب بنفسه — لما التلقائي يكون مقفول، أو التوزيع فشل
     لأن مفيش كباتن ساعتها وبقى في كباتن دلوقتي. */
  app.post("/api/shop/board/:orderNo/courier", async (c) => {
    const err = await requireCashierOrAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (row.option !== "delivery") return c.json({ ok: false, error: "not_delivery" }, 400);
    if (!["accepted", "pos_created", "courier_requested"].includes(row.status)) {
      return c.json({ ok: false, error: "not_ready", status: row.status }, 409);
    }
    /* في المرحلة اليدوية الزرار ده مقفول. delivery.dispatch() بترمي برضه
       (البوابة الحقيقية)، بس بنرد رد واضح هنا عشان الشاشة تعرف تقول
       للكاشير «ادخّل الطلب على لوحة الشركة» بدل رسالة خطأ عامة. */
    const gate = await delivery.dispatchGate();
    if (gate.mode !== "auto") {
      return c.json({
        ok: false, error: "manual_mode", mode: gate.mode, source: gate.source,
        message: "المرحلة اليدوية: ادخّل الطلب على لوحة شركة التوصيل، وبعدين سجّله من زرار «سجّلت الطلب»",
      }, 409);
    }
    try {
      await pool.query("UPDATE shop_orders SET dispatch_claimed_at = COALESCE(dispatch_claimed_at, NOW()) WHERE order_no=$1", [row.order_no]);
      const res = await delivery.dispatch(row);
      if (row.status !== "courier_requested") await setStatus(row.order_no, "courier_requested");
      return c.json({ ok: true, assigned: res.assigned, orderNumber: res.orderNumber, note: res.dispatch?.message || null });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  /* ═══ المرحلة الأولى: الكاشير بيقول للسيستم عمل إيه ═══════════════════
     الكاشير بيفتح لوحة «أجلك»، يكتب الطلب، وبعدين يرجع هنا يسجّل الخطوة.
     كل خطوة بتحرّك حالة الطلب اللي العميل شايفها — والقاعدة اللي محكومين
     بيها: **ما نقولش للعميل حاجة ما حصلتش**.

       handoff   → courier_requested  «بنطلب لك مندوب»  (صح: طلبنا فعلاً)
       assigned  → courier_assigned   «المندوب في الطريق للمطعم»
                   الزرار ده بيتضغط لما الكاشير يشوف الكابتن اتعيّن في
                   لوحتهم — مش بيتحط تلقائي. عمر كان واضح إن ما ينفعش
                   نقول «اتعيّن مندوب» ومحدش اتعيّن.
       picked    → on_the_way         «طلبك في الطريق إليك»
       delivered → delivered
       failed    → courier_cancelled  + الطلب بيبان أحمر للإدارة

     مفيش أي خطوة فيهم بتتحرك لوحدها. الوقت وحده ما بيرقّيش حالة. */
  const MANUAL_TO_ORDER = {
    handoff: "courier_requested",
    assigned: "courier_assigned",
    picked: "on_the_way",
    delivered: "delivered",
    cancelled: "courier_cancelled",
  };

  app.post("/api/shop/board/:orderNo/manual/:stage", async (c) => {
    const err = await requireCashierOrAdmin(c); if (err) return err;
    const stage = String(c.req.param("stage"));
    const next = MANUAL_TO_ORDER[stage];
    if (!next) return c.json({ ok: false, error: "bad_stage" }, 400);

    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (row.option !== "delivery") return c.json({ ok: false, error: "not_delivery" }, 400);

    /* الطلب لازم يكون المطعم قبله قبل ما ندخّله على شركة التوصيل — الكابتن
       ما يجيش لطلب لسه ما اتعملش. (بنسمح بـ pos_created عشان الكاشير
       اللي بيقبل من شاشة الـPOS وبيسجّل هنا قبل ما الكنس يلحق يشوف.) */
    const OK_FROM = {
      handoff: ["pos_created", "accepted", "courier_requested"],
      assigned: ["courier_requested", "courier_assigned"],
      picked: ["courier_requested", "courier_assigned", "on_the_way"],
      delivered: ["courier_requested", "courier_assigned", "on_the_way"],
      cancelled: ["pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way"],
    };
    if (!OK_FROM[stage].includes(row.status)) {
      return c.json({ ok: false, error: "wrong_stage", status: row.status }, 409);
    }

    const b = await c.req.json().catch(() => ({}));
    let shipment;
    try {
      shipment = await delivery.manualEvent(row.order_no, stage, {
        ref: b.ref ? String(b.ref).slice(0, 64) : null,       // رقم الطلب في لوحتهم
        cost: b.cost != null && b.cost !== "" ? Number(b.cost) : null,
        driverName: b.driverName ? String(b.driverName).slice(0, 80) : null,
        driverPhone: b.driverPhone ? String(b.driverPhone).slice(0, 20) : null,
        note: b.note ? String(b.note).slice(0, 200) : null,
        by: "cashier",
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
    if (row.status !== next) await setStatus(row.order_no, next, { note: `يدوي: ${stage}`, from: row.status });
    return c.json({ ok: true, status: next, shipment: { status: shipment.status, ref: shipment.provider_ref } });
  });

  /* استرجاع بضغطة من اللوحة — لما التوصيل يتعثّر والقرار يبقى «رجّع فلوسه».
     أدمن بس: دي فلوس بتخرج، مش خطوة تشغيلية. */
  app.post("/api/shop/orders/:orderNo/refund", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const res = await refundOrder(row, String(b.reason || "refunded from dashboard").slice(0, 120));
    return c.json(res, res.ok ? 200 : 502);
  });

  /* أداء أكواد التحويل — قياس كارت «اطلب مباشرة» اللي بيتحط في طلبات
     تطبيقات التوصيل. طلبات التطبيقات بتوصل من غير رقم عميل، فالكود ده هو
     الجسر الوحيد بين عميل التطبيق والعميل المباشر. من غير الشاشة دي
     الكارت بيبقى صرف تاني من غير قياس. */
  app.get("/api/shop/coupons/performance", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const rows = (await pool.query(
      `WITH used AS (
         SELECT coupon, phone_norm, total, created_at
           FROM shop_orders
          WHERE coupon IS NOT NULL AND status NOT IN ('pending_payment','expired')
       )
       SELECT u.coupon,
              count(*)::int                        AS redemptions,
              count(DISTINCT u.phone_norm)::int    AS customers,
              COALESCE(sum(u.total),0)::numeric    AS revenue,
              COALESCE(avg(u.total),0)::numeric    AS avg_order,
              min(u.created_at)                    AS first_use,
              max(u.created_at)                    AS last_use,
              -- عملاء رجعوا وطلبوا تاني من غير الكود = التحويل نجح فعلاً
              (SELECT count(DISTINCT o2.phone_norm)::int FROM shop_orders o2
                WHERE o2.phone_norm IN (SELECT phone_norm FROM used WHERE coupon = u.coupon)
                  AND (o2.coupon IS DISTINCT FROM u.coupon)
                  AND o2.status NOT IN ('pending_payment','expired')) AS repeat_customers
         FROM used u GROUP BY u.coupon ORDER BY redemptions DESC`)).rows;
    return c.json({
      ok: true,
      coupons: rows.map((r) => ({
        code: r.coupon, redemptions: r.redemptions, customers: r.customers,
        revenue: Number(r.revenue), avgOrder: Number(r.avg_order),
        repeatCustomers: r.repeat_customers,
        repeatRate: r.customers ? Math.round((r.repeat_customers / r.customers) * 100) : 0,
        firstUse: r.first_use, lastUse: r.last_use,
      })),
    });
  });

  app.get("/api/shop/orders", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const status = c.req.query("status");
    const p = [];
    let where = "";
    if (status) { p.push(status); where = `WHERE status=$1`; }
    p.push(Math.min(500, Number(c.req.query("limit")) || 100));
    const rows = (await pool.query(
      `SELECT order_no, status, option, customer, phone_norm, subtotal, delivery_fee, tip, total,
              coupon, discount_amount, mf_invoice_id, mf_payment_id, refund_id, pos_order_id,
              pos_approval, pos_attempts, last_pos_error, created_at, updated_at
         FROM shop_orders ${where} ORDER BY created_at DESC LIMIT $${p.length}`, p)).rows;
    return c.json({ ok: true, orders: rows });
  });

  /* Full audit of one order: the lifecycle history, the POS-push record, the
     items — «تراكينج كامل» for the dashboard's order drill-down. */
  app.get("/api/shop/orders/:orderNo", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    const shipment = row.option === "delivery" ? await delivery.shipmentOf(row.order_no) : null;
    const { pos_calc, ...rest } = row;
    return c.json({ ok: true, order: rest, shipment });
  });

  /* Manual retry from the dashboard — no waiting for the 2-minute sweep. */
  app.post("/api/shop/orders/:orderNo/retry-pos", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (!["paid", "paid_pos_failed"].includes(row.status)) {
      return c.json({ ok: false, error: "not_retryable", status: row.status }, 409);
    }
    // السلة المتروكة اتقفلت: الطلب اتم فعلاً
    const cartsApi = carts();
    if (cartsApi) cartsApi.markOrdered({
      phoneNorm: row.phone_norm, deviceId: (row.customer || {}).deviceId, orderNo: row.order_no,
    }).catch(() => {});
    await createPosOrder(row.order_no);
    const after = await getOrderRow(row.order_no);
    return c.json({ ok: true, status: after.status, posOrderId: after.pos_order_id, lastError: after.last_pos_error });
  });

  /* اطلب مندوب يدوياً — احتياطي للتلقائي: لو الإرسال التلقائي فشل (لاجلك
     وقعت لحظة القبول، أو الطلب قديم من قبل ما نفعّل التلقائي)، الكاشير
     يبعت المندوب بضغطة بدل ما الطلب يفضل معلّق. */
  app.post("/api/shop/orders/:orderNo/dispatch", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const row = await getOrderRow(c.req.param("orderNo"));
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    if (row.option !== "delivery") return c.json({ ok: false, error: "not_delivery" }, 409);
    if (!["accepted", "pos_created", "paid"].includes(row.status)) {
      return c.json({ ok: false, error: "not_dispatchable", status: row.status }, 409);
    }
    const existing = await delivery.shipmentOf(row.order_no);
    if (existing && !["cancelled"].includes(String(existing.status))) {
      return c.json({ ok: false, error: "already_dispatched", ref: existing.provider_ref }, 409);
    }
    try {
      await pool.query("UPDATE shop_orders SET dispatch_claimed_at = COALESCE(dispatch_claimed_at, NOW()) WHERE order_no=$1", [row.order_no]);
      const res = await delivery.dispatch(row);
      await setStatus(row.order_no, "courier_requested");
      return c.json({ ok: true, provider: res.provider, ref: res.faOrderId, assigned: res.assigned });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 502);
    }
  });

  /* Reconciliation feed: MyFatoorah collected vs what the POS knows about.
     The gap (delivery fees + tips) is BY DESIGN — the POS order carries the
     food total only — so the screen states it instead of hiding it. */
  app.get("/api/shop/summary", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const from = c.req.query("from") || null, to = c.req.query("to") || null;
    const r = (await pool.query(
      `SELECT
         count(*) FILTER (WHERE status NOT IN ('pending_payment','expired'))::int AS paid_orders,
         COALESCE(sum(total) FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS gateway_total,
         -- Once the fee rides inside the POS invoice (feeInPos), the POS books
         -- food + fee; before that it books food only.
         COALESCE(sum(subtotal + CASE WHEN (delivery_quote->>'feeInPos')::boolean THEN delivery_fee ELSE 0 END)
           FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS pos_total,
         COALESCE(sum(delivery_fee) FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS delivery_fees,
         COALESCE(sum(tip) FILTER (WHERE status NOT IN ('pending_payment','expired')),0)::numeric AS tips,
         count(*) FILTER (WHERE status='rejected_refunded')::int AS refunds,
         COALESCE(sum(total) FILTER (WHERE status='rejected_refunded'),0)::numeric AS refunded_total,
         count(*) FILTER (WHERE status='paid_pos_failed')::int AS stuck_orders,
         count(*) FILTER (WHERE status='pending_payment')::int AS awaiting_payment,
         count(*) FILTER (WHERE status='delivered')::int AS delivered
       FROM shop_orders
       WHERE ($1::date IS NULL OR created_at >= $1::date)
         AND ($2::date IS NULL OR created_at < ($2::date + 1))`,
      [from, to])).rows[0];
    const n = (v) => Number(v) || 0;
    return c.json({
      ok: true, from, to,
      paidOrders: n(r.paid_orders),
      gatewayTotal: n(r.gateway_total),   // what MyFatoorah collected
      posTotal: n(r.pos_total),           // what TabSense shows (food only)
      deliveryFees: n(r.delivery_fees),   // the designed gap, part 1
      tips: n(r.tips),                    // the designed gap, part 2
      refunds: n(r.refunds), refundedTotal: n(r.refunded_total),
      stuckOrders: n(r.stuck_orders),     // paid but not in the POS — needs eyes NOW
      awaitingPayment: n(r.awaiting_payment),
      delivered: n(r.delivered),
    });
  });

  /* Shipment webhook events → order stage. Called by delivery.js. */
  /* المفاتيح دي بتغطي مصدرين: أسماء أحداث الويبهوك (driver_assigned…) وقيم
     الحالة اللي بترجع من GET /orders/{id} وقت الاستطلاع (in_transit…). */
  /* الحالات دي **موحّدة** جاية من طبقة المزوّدين (couriers.js)، مش بلغة
     شركة بعينها. ترجمة مصطلحات كل شركة بتحصل جوّاها، فلو بدّلنا من Flying
     Arrow لـ Leajlak الجدول ده ما يتغيّرش ولا العميل يحس بفرق.
     ولسه بنقبل الأسماء القديمة عشان ويبهوك متأخر من شحنة قديمة ما يضيعش. */
  const SHIP_STAGE = {
    // الموحّدة
    pending: null,                      // اتسجّل عندهم، لسه مفيش كابتن
    assigned: "courier_assigned",
    picked: "on_the_way",
    delivered: "delivered",
    cancelled: "courier_cancelled",
    // أسماء قديمة (Flying Arrow خام) — للتوافق مع صفوف قبل التوحيد
    created: null,
    confirmed: null,
    driver_assigned: "courier_assigned",
    accepted: "courier_assigned",
    pickup_completed: "on_the_way",
    picked_up: "on_the_way",
    in_transit: "on_the_way",
    on_the_way: "on_the_way",
    completed: "delivered",
    canceled: "courier_cancelled",
  };
  async function onShipmentEvent(orderNo, event, _payload) {
    const next = SHIP_STAGE[event];
    if (!next) return;
    const row = await getOrderRow(orderNo);
    if (!row) return;
    // never let a late webhook drag a delivered order backwards
    const order = ["courier_requested", "courier_assigned", "on_the_way", "delivered"];
    if (next !== "courier_cancelled" &&
        order.indexOf(next) <= order.indexOf(row.status)) return;
    await setStatus(orderNo, next, { from: row.status });
  }

  /* ── تنفيذ الاسترجاع ──────────────────────────────────────────────────
     القرار في refundDecision (صافي ومُختبر)، والتنفيذ هنا. الفرق المهم عن
     النسخة القديمة: فشل الاسترجاع بيروح لحالة `refund_failed` مش
     `rejected_refunded`. الحالة القديمة كانت بتبعت للعميل رسالة «تم
     استرجاع المبلغ كاملاً لبطاقتك» وفلوسه لسه معانا. */
  async function refundOrder(row, reason) {
    if (!row) return { ok: false, error: "no_order" };
    const d = refundDecision(row);
    if (!d.act) {
      if (d.reason === "already_refunded") return { ok: true, skipped: d.reason };
      if (d.reason === "max_attempts") return { ok: false, error: "max_attempts" };
      // مفيش دفعة نسترجعها — الطلب بيتقفل من غير ما نوعد بفلوس
      await setStatus(row.order_no, "rejected_refunded", { note: `لا يوجد مبلغ للاسترجاع (${d.reason})` });
      return { ok: true, skipped: d.reason };
    }
    await pool.query("UPDATE shop_orders SET refund_attempts = refund_attempts + 1 WHERE order_no=$1",
      [row.order_no]);
    try {
      const ref = await pay.makeRefund({
        paymentId: d.paymentId, amount: d.amount,
        comment: `FreshCuts ${row.order_no} ${reason || "refund"}`,
      });
      await setStatus(row.order_no, "rejected_refunded", {
        cols: { refund_id: String(ref.RefundId ?? ref.RefundReference ?? "requested"), refund: jb(ref) },
      });
      return { ok: true, refundId: String(ref.RefundId ?? ref.RefundReference ?? "requested") };
    } catch (e) {
      console.error(`[shop] AUTO-REFUND FAILED for ${row.order_no}:`, e.message);
      await setStatus(row.order_no, "refund_failed", {
        note: `REFUND FAILED: ${e.message}`.slice(0, 300),
        cols: { refund: jb({ error: e.message, at: new Date().toISOString(), amount: d.amount }) },
      });
      return { ok: false, error: e.message };
    }
  }

  /* ── مراقب المهل: الطلبات اللي وقعت من إيد بني آدم ────────────────────
     بيلف على كل طلب حي، يسأل slaCheck عن درجته، وبيصعّد **مرة واحدة** لكل
     درجة (العمود alerts بيفتكر مين اتبعت). درجة 3 بتعمل تدخّل مالي. */
  async function watchdog() {
    const settings = await getSettingsData();
    const sla = { ...((settings.delivery || {}).sla || {}),
      dispatchDelayMin: (await delivery.dispatchGate()).mode === "auto" ? dispatchDelayOf(settings) : 0 };
    const autoRefundOn = (settings.delivery || {}).autoRefundOnNoAccept !== false;

    const rows = (await pool.query(
      `SELECT order_no, status, option, total, mf_payment_id, refund_id, refund_attempts,
              customer, alerts, created_at, updated_at, pos_ready_at
         FROM shop_orders
        WHERE status NOT IN ('pending_payment','expired','delivered','rejected_refunded')
          AND created_at > NOW() - INTERVAL '24 hours'`)).rows;

    for (const row of rows) {
      const v = slaCheck(row, sla);
      if (!v.level) continue;
      const seen = row.alerts || {};
      const key = `${v.code}:${v.level}`;
      if (seen[key]) continue;

      // نسجّل الإنذار الأول قبل أي تصعيد — لو التصعيد نفسه وقع، ما نكررش
      await pool.query(
        "UPDATE shop_orders SET alerts = COALESCE(alerts,'{}'::jsonb) || $2::jsonb WHERE order_no=$1",
        [row.order_no, jb({ [key]: new Date().toISOString() })]);
      emitOrder("sla_alert", { orderNo: row.order_no, source: "shop", ok: null,
        data: { code: v.code, level: v.level, notified: v.level >= 2, action: v.action || null,
                minutes: v.minutes ?? null, status: row.status } });

      if (v.level >= 2) {
        console.error(`[shop] SLA ${v.level} — ${row.order_no}: ${v.message}`);
        staff.critical((lang) => slaAlertText(row.order_no, v, lang), `sla ${row.order_no} ${v.code}`)
          .catch((e) => console.error("[shop] SLA sms failed:", e.message));
      }
      if (v.level >= 3 && v.action === "auto_refund" && autoRefundOn) {
        /* المطعم ما قبلش الطلب خالص: مفيش أكل اتعمل ومفيش كابتن اتبعت،
           والعميل قاعد مستني على الفاضي. الاسترجاع هنا هو الصح.
           بنلغي الطلب من الـPOS الأول لو ينفع، وبعدين نسترجع. */
        console.error(`[shop] AUTO-REFUND (never accepted) — ${row.order_no}`);
        if (row.option === "delivery" && delivery.cancelShipment) {
          delivery.cancelShipment(row.order_no, `order ${row.order_no} never accepted`).catch(() => {});
        }
        await refundOrder(await getOrderRow(row.order_no), "never accepted by restaurant");
      }
    }
  }

  /* ── وسيلة الدفع اللي تتسجّل في تاب سينس ────────────────────────────────
     الأسماء دي مش مخترعة — دي اللي تاب سينس نفسه بيسجّل بيها، مستخرجة من
     طلبات حقيقية في ts_orders:
       TABsense Pay · Cash · Feedus · Mada · Visa · Mastercard
       e-Credit Card · e-Apple Pay Credit · e-Apple Pay Mada
     الـ«e-» معناها إلكتروني (مدفوع أونلاين)، وهي اللي تخصّنا.

     كنا بنبعت "cash" لكل طلب أونلاين — يعني فاتورة المطعم بتقول إن العميل
     دفع كاش في حين إنه دفع بالبطاقة، والتسوية اليومية بتطلع غلط.

     البوابة الحقيقية بتيجي من ماي فاتورة في GetPaymentStatus.PaymentGateway،
     فبنترجمها بدل ما نحزر. */
  // بنطابق بوابة ماي فاتورة بوسيلة تاب سينس الإلكترونية الصح (كلها «e-» —
  // دي وسائل الدفع الأونلاين الموجودة في تاب سينس إنتاج). الترتيب مهم:
  // الأكثر تحديداً الأول (أبل+مدى قبل أبل، مدى قبل الافتراضي).
  const POS_PAY_BY_GATEWAY = [
    [/apple.*mada|mada.*apple/i,  "e-Apple Pay Mada"],
    [/apple/i,                    "e-Apple Pay Credit"],
    [/google|g[-\s]?pay/i,        "e-Google Pay"],
    [/stc/i,                      "e-STC Pay"],
    [/amex|american\s*express/i,  "e-Amex"],
    [/mada|md\b/i,                "e-Mada"],
    [/visa|master|credit|vm|cc/i, "e-Credit Card"],
  ];
  function posPaymentMethodFor(gateway, settings) {
    // إعداد صريح من اللوحة بيكسب على أي استنتاج
    if (settings.posPaymentMethod) return settings.posPaymentMethod;
    const g = String(gateway || "");
    for (const [re, name] of POS_PAY_BY_GATEWAY) if (re.test(g)) return name;
    return "e-Credit Card"; // مدفوع أونلاين مهما كانت الوسيلة — مش كاش أبداً
  }

  /* ── the sweep: retries, acceptance watch, auto-refund, dispatch ── */
  async function sweep() {
    // 0) ربط تاب سينس للطلبات الخارجية سليم؟ لو واقع، الطلبات الجاية مش هتوصل
    // نقطة البيع — الإدارة تعرف دلوقتي، مش لما عميل يستنى (مرة كل ساعة بالكتير).
    if (process.env.TSP_AUTO_ORDER === "1") {
      try {
        const partner = tsp();
        const st = partner ? await partner.status() : { connected: false };
        const expired = st.expiresAt && new Date(st.expiresAt).getTime() < Date.now() - 5 * 60_000;
        const down = !partner ? "partner module missing" : !st.connected ? "not connected" : expired ? "token expired and refresh failing" : null;
        if (down && Date.now() - _tspDownAlertAt > 60 * 60_000) {
          _tspDownAlertAt = Date.now();
          console.error(`[shop] TABSENSE DOWN: ${down}`);
          staff.critical((lang) => tabsenseDownText(down, lang), "tabsense-down")
            .catch((e) => console.error("[shop] tabsense-down sms:", e.message));
          // بوابة المطعم (portal.js): Web Push لأجهزة الفريق — fire-and-forget
          try { deps.portal?.()?.tabsenseDown?.(down); } catch { /* ignore */ }
        }
      } catch (e) { console.error("[shop] tabsense health check:", e.message); }
    }

    // 1) paid but the POS never got the order — retry the create.
    const failed = (await pool.query(
      `SELECT order_no FROM shop_orders
        WHERE status='paid_pos_failed' AND created_at > NOW() - INTERVAL '24 hours'`)).rows;
    for (const r of failed) await createPosOrder(r.order_no);

    // 1b) «جاهز» بعد القبول. الكنس اللي تحت بيراقب pos_created بس، وأول ما
    // الطلب يتقبل (ويتطلب له مندوب) بيخرج من المراقبة — فتسجيل الكاشير «جاهز»
    // بعدها كان بيضيع، والتتبع يفضل «المطعم بيجهّز» للأبد (طلب 13 سبتمبر:
    // التنبيه pickup_ready وصل 12:44 ومحدش قراه). هنا بنقرا آخر approval_status
    // من تنبيهات تاب سينس للطلبات المقبولة اللي لسه مالهاش pos_ready_at —
    // من غير أي تغيير في الحالة ولا طلب مندوب تاني.
    const awaitingReady = (await pool.query(
      `SELECT order_no, pos_order_id, branch_id FROM shop_orders
        WHERE pos_order_id IS NOT NULL AND pos_ready_at IS NULL
          AND status IN ('accepted','courier_requested','courier_assigned')
          AND created_at > NOW() - INTERVAL '24 hours'`)).rows;
    for (const r of awaitingReady) {
      try {
        const wh = await pool.query(
          `SELECT jsonb_build_object('resource', jsonb_build_object('statuses_slugs',
                    payload->'resource'->'statuses_slugs')) AS payload
             FROM tsp_webhooks
            WHERE payload->'resource'->'order'->>'id' = $1
            ORDER BY received_at DESC LIMIT 1`, [r.pos_order_id]);
        let a = String(approvalFromWebhook(wh.rows[0]?.payload) || "").toLowerCase();
        // طلب نزل من مسار المتجر العادي (الاحتياطي لما الشريك يفشل) مالوش webhooks
        // شريك — «جاهز» بتاعه بيتقرا من getOrder زي الكنس الأصلي (16 سبتمبر).
        if (!a) {
          try { a = String(tsstore.approvalOf(await tsstore.getOrder(r.pos_order_id, r.branch_id)) || "").toLowerCase(); }
          catch { /* مش متاح — الدورة الجاية */ }
        }
        if (a.includes("ready")) {
          await pool.query(
            `UPDATE shop_orders SET pos_approval=$2, pos_ready_at = COALESCE(pos_ready_at, NOW()),
                    updated_at=NOW() WHERE order_no=$1`, [r.order_no, a]);
          emitOrder("pos_ready", { orderNo: r.order_no, source: "shop", data: { source: "pos", by: null, approval: a } });
        }
      } catch { /* tsp_webhooks مش متاح — نجرّب الدورة الجاية */ }
    }

    // 1c) طلبات الاستلام اللي الكاشير سلّمها على تاب سينس (17 سبتمبر): تاب سينس
    // بيبعت approval_status=delivered / order_status=completed لما الطلب يتقفل،
    // واحنا ماكناش بنقراهم — فالطلب W1789590376537 فضل «مقبول» في شاشة المتابعة
    // بعد ما العميل استلمه. التوصيل مش هنا: الطلب بيتقفل بتحديثات المندوب.
    const pickupOpen = (await pool.query(
      `SELECT order_no, pos_order_id FROM shop_orders
        WHERE option='pickup' AND pos_order_id IS NOT NULL
          AND status IN ('pos_created','accepted')
          AND created_at > NOW() - INTERVAL '48 hours'`)).rows;
    for (const r of pickupOpen) {
      try {
        const wh = await pool.query(
          `SELECT payload->'resource'->'statuses_slugs'->>'approval_status' AS a,
                  payload->'resource'->'statuses_slugs'->>'order_status' AS o,
                  payload->'resource'->'statuses_slugs'->>'payment_status' AS pay,
                  event
             FROM tsp_webhooks
            WHERE payload->'resource'->'order'->>'id' = $1
            ORDER BY received_at DESC LIMIT 1`, [r.pos_order_id]);
        const a = String(wh.rows[0]?.a || "").toLowerCase();
        const o = String(wh.rows[0]?.o || "").toLowerCase();
        const pay = String(wh.rows[0]?.pay || "").toLowerCase();
        /* عمر (17 سبتمبر): «استلمت طلبك» تظهر بعد ما الطلب يتدفع على نقطة البيع —
           ده دليل إن العميل استلم (الكاشير بيقفل الفاتورة وقت التسليم) — مش مجرد
           «جاهز». فالإشارة هي payment_status=fully_paid (حدث order-paid) أو
           order_status=completed؛ approval «delivered» لوحده مابيكفيش. */
        /* ١٩/٩ مساءً: طلبات الموقع بتنزل تاب سينس «مدفوعة مسبقاً» (already_paid)
           فـfully_paid/order-paid بيوصلوا لحظة إنشاء الطلب — الطلب W1789839510561
           اتعلّم «استلم» بعد دقيقتين من الدفع ورسالة التقييم وصلت قبل ما العميل
           يستلم. الإشارة الوحيدة الصح دلوقتي: الكاشير قفل الطلب (completed). */
        void pay;
        if (o === "completed") {
          await pool.query(
            "UPDATE shop_orders SET pos_approval=$2, pos_ready_at = COALESCE(pos_ready_at, NOW()) WHERE order_no=$1",
            [r.order_no, a || o]);
          await setStatus(r.order_no, "delivered", { note: "الكاشير سلّم الطلب (تاب سينس)" });
        }
      } catch { /* الدورة الجاية */ }
    }

    // 2) orders sitting in the POS inbox — did the cashier accept or reject?
    const watching = (await pool.query(
      `SELECT order_no, branch_id, pos_order_id, option, total, mf_payment_id, refund_id, pos_ready_at
         FROM shop_orders
        WHERE status='pos_created' AND pos_order_id IS NOT NULL
          AND created_at > NOW() - INTERVAL '24 hours'`)).rows;
    for (const r of watching) {
      let approval = null;
      try {
        const posOrder = await tsstore.getOrder(r.pos_order_id, r.branch_id);
        approval = tsstore.approvalOf(posOrder);
      } catch { /* طلبات API الشريك (مدفوعة مسبقاً) مالهاش getOrder — بنقرا من الـwebhook تحت */ }
      // طلبات الشريك (already_paid) بتبلّغ حالتها عبر webhook مش عبر getOrder،
      // فبنقرا آخر approval_status اتسجّل لنفس رقم طلب الـPOS من tsp_webhooks.
      if (!approval) {
        try {
          const wh = await pool.query(
            `SELECT jsonb_build_object('resource', jsonb_build_object('statuses_slugs',
                      payload->'resource'->'statuses_slugs')) AS payload
               FROM tsp_webhooks
              WHERE payload->'resource'->'order'->>'id' = $1
              ORDER BY received_at DESC LIMIT 1`, [r.pos_order_id]);
          approval = approvalFromWebhook(wh.rows[0]?.payload);
        } catch { /* tsp_webhooks لسه ماتعملتش */ }
      }
      if (!approval) continue;
      await pool.query("UPDATE shop_orders SET pos_approval=$2, updated_at=NOW() WHERE order_no=$1",
        [r.order_no, approval]);
      const a = String(approval || "").toLowerCase();
      // «مقبول» عند الشريك بيمر بمراحل: accepted → pickup_ready → …؛ كلها
      // معناها إن الكاشير قَبِل الطلب، فنطلب الكابتن. «rejected/cancelled» رفض.
      const acceptedLike = a.includes("accept") || a.includes("pickup_ready")
        || a.includes("preparing") || a.includes("processing") || a.includes("ready");
      const rejectedLike = a.includes("reject") || a.includes("cancel");
      // «جاهز للاستلام»: أول ما الكاشير يسجّلها، بنثبّت وقت الجهوزية مرة واحدة.
      // ("pickup_ready" وأي "ready" تدخل؛ accepted/preparing/processing مش منها.)
      if (a.includes("ready")) {
        await pool.query(
          "UPDATE shop_orders SET pos_ready_at = COALESCE(pos_ready_at, NOW()), updated_at=NOW() WHERE order_no=$1",
          [r.order_no]);
        if (!r.pos_ready_at) emitOrder("pos_ready", { orderNo: r.order_no, source: "shop", data: { source: "pos", by: null, approval: a } });
      }
      if (acceptedLike) {
        await setStatus(r.order_no, "accepted", { from: "pos_created" });
        // طلب الكابتن اتنقل للخطوة 2b تحت: بعد «جاهز» أو بعد مهلة التحضير.
      } else if (rejectedLike) {
        // لو كنا طلبنا كابتن قبل الرفض, نلغي عندهم — رسوم الإلغاء أرخص من
        // توصيلة كاملة لطلب المطعم اعتذر عنه.
        if (r.option === "delivery" && delivery.cancelShipment) {
          delivery.cancelShipment(r.order_no, `order ${r.order_no} rejected by restaurant`)
            .catch((e) => console.error(`[shop] courier cancel failed for ${r.order_no}:`, e.message));
        }
        // Omar's rule: automatic refund, exactly once.
        await refundOrder(await getOrderRow(r.order_no), `rejected by cashier`);
      }
    }

    // 2b) طلب المندوب في وقته — بعد ما الكاشير يسجّل «جاهز» (الخطوة 1b بتقراها)
    // أو بعد مهلة التحضير من القبول، أيهما أسبق. الحجز الذري بيمنع التكرار.
    try {
      const allSettings = await getSettingsData();
      if ((allSettings.shop || {}).autoDispatch !== false && await delivery.canAutoDispatch()) {
        const delayMin = dispatchDelayOf(allSettings);
        const waiting = (await pool.query(
          `SELECT order_no, pos_ready_at, history, delivery_quote, is_test FROM shop_orders
            WHERE status='accepted' AND option='delivery' AND dispatch_claimed_at IS NULL
              AND created_at > NOW() - INTERVAL '24 hours'`)).rows;
        for (const r of waiting) {
          const acceptedAt = (r.history || []).find((h) => h.status === "accepted")?.at || null;
          const v = dispatchDue({ delayMin, acceptedAt, readyAt: r.pos_ready_at });
          if (!v.due) continue;
          /* حارس المشوار البعيد (١٩ سبتمبر — لاجلك رفضت طلب ١٣ كم): فوق ١٠ كم
             عقدهم بيدّيهم حق الرفض. في وضع «تأكيد» الطلب بيستنى قرار المدير
             في البوابة (اطلب لاجلك برضه / مندوب خارجي) بدل ما يتبعت ويترفض.
             الحارس نفسه لو وقع مابيوقفش التوصيل (farCheck بترجّع hold:false). */
          const fg = await deps.courierOps?.()?.farCheck?.(r).catch?.(() => null);
          if (fg && fg.hold) continue;
          const claim = await pool.query(
            `UPDATE shop_orders SET dispatch_claimed_at=NOW()
              WHERE order_no=$1 AND dispatch_claimed_at IS NULL AND status='accepted'
              RETURNING order_no`, [r.order_no]);
          if (!claim.rowCount) continue;
          try {
            await delivery.dispatch(await getOrderRow(r.order_no));
            await setStatus(r.order_no, "courier_requested",
              { note: v.reason === "ready" ? "المطبخ سجّل جاهز" : `مهلة التحضير (${delayMin} د)` });
          } catch (e) {
            console.error(`[shop] courier dispatch failed for ${r.order_no}:`, e.message);
            // مش بنعيد تلقائي — فشل الإرسال محتاج عين، واللوحة بتبيّن الوقفة.
          }
        }
      }
    } catch (e) {
      console.error("[shop] timed dispatch failed:", e.message);
    }

    // 2.5) شبكة أمان للدفع: طلب معلّق وله فاتورة وعدّى عليه كذا دقيقة — نراجع
    // ماي فاتورة بنفسنا (GetPaymentStatus عبر confirmOrder) قبل ما ننهيه. من غير
    // ده، لو الـwebhook ضاع والعميل قفل صفحة العودة، طلب مدفوع فعلاً بيتلغى
    // والفلوس تعلّق. confirmOrder idempotent وذري، فآمن نناديه كل دورة.
    const stalePending = (await pool.query(
      `SELECT order_no FROM shop_orders
        WHERE status='pending_payment' AND mf_invoice_id IS NOT NULL
          AND created_at < NOW() - INTERVAL '8 minutes'
          AND created_at > NOW() - INTERVAL '7 hours'`)).rows;
    for (const r of stalePending) {
      await confirmOrder({ orderNo: r.order_no, via: "sweep" }).catch((e) =>
        console.error(`[shop] payment reconcile failed for ${r.order_no}: ${e.message}`));
    }

    // 3) housekeeping: a payment session nobody completed (بعد مراجعة الدفع فوق).
    const expiredRows = await pool.query(
      `UPDATE shop_orders SET status='expired', updated_at=NOW()
        WHERE status='pending_payment' AND created_at < NOW() - INTERVAL '6 hours'
        RETURNING order_no, mf_invoice_id`);
    for (const x of (expiredRows?.rows || [])) {
      emitOrder("order_expired", { orderNo: x.order_no, source: "shop", data: { executed: Boolean(x.mf_invoice_id) } });
    }

    // 4) إعادة محاولة الاسترجاعات الفاشلة — لحد سقف المحاولات، وبعدين بشر.
    const stuckRefunds = (await pool.query(
      `SELECT * FROM shop_orders
        WHERE status='refund_failed' AND refund_attempts < 3
          AND created_at > NOW() - INTERVAL '48 hours'`)).rows;
    for (const row of stuckRefunds) await refundOrder(row, "retry after failure");

    // 5) شبكة الأمان: الطلبات اللي بني آدم اتأخر عليها.
    await watchdog().catch((e) => console.error("[shop] watchdog failed:", e.message));
  }

  const sweepSec = Number(env("SHOP_SWEEP_SECONDS", "120"));
  if (sweepSec > 0) {
    setInterval(() => sweep().catch((e) => console.error("[shop] sweep failed:", e.message)), sweepSec * 1000);
  }

  return { confirmOrder, onShipmentEvent, sweep, refundOrder, watchdog, setStatus, getOrderRow, createPosOrder };
}
