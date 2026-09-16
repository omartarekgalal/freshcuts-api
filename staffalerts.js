/* ═══════════════════════════════════════════════════════════════════════════
   رسايل الإدارة (SMS) — مدير المطعم وعمر

   طلب عمر (16 سبتمبر 2026، بعد طلب W1789555412320 اللي اتأخر والعميل زعل):
     «ابعتله بالانجليزي رسالة لو في اي طلب اتعمل عشان يتابعه»
     «خلي اي حاجة بندخلها ينفع يتم تعديلها من لوحة التحكم»
     «مش عايز يحصل اي مشكلة تاني لاي سبب من الاسباب»

   قبل كده الإنذارات كانت بتروح عن طريق notify.sendSmsTo، وده بيشتغل بس لو
   رسايل «العملاء» مفعّلة — فإنذار المدير كان ممكن مايخرجش خالص في صمت. هنا
   الإرسال مباشر لتقنيات ومستقل عن إعدادات رسايل العملاء.

   كل الإعدادات من اللوحة (settings.delivery):
     alertPhones      أرقام الإنذارات الحرجة (طلب مش واصل نقطة البيع، تأخير،
                      ربط تاب سينس واقع)
     newOrderPhones   أرقام بتاخد رسالة مع كل طلب أونلاين جديد مدفوع
     newOrderSms      تشغيل/إيقاف رسالة الطلب الجديد (الافتراضي: شغّال)
     staffSmsLanguage "en" (الافتراضي) أو "ar"
═══════════════════════════════════════════════════════════════════════════ */

export function normStaffPhone(p) {
  let d = String(p || "").replace(/[^\d]/g, "");
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? d : null;
}

export function staffPhones(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(/[\s,،;]+/);
  return [...new Set(arr.map(normStaffPhone).filter(Boolean))];
}

export function staffConfig(settings) {
  const d = (settings && settings.delivery) || {};
  return {
    alertPhones: staffPhones(d.alertPhones),
    newOrderPhones: staffPhones(d.newOrderPhones),
    newOrderSms: d.newOrderSms !== false,
    lang: d.staffSmsLanguage === "ar" ? "ar" : "en",
  };
}

const OPTION = { en: { delivery: "Delivery", pickup: "Pickup" }, ar: { delivery: "توصيل", pickup: "استلام" } };
const rs = (n) => `${Math.round(Number(n) * 100) / 100}`;
const itemCount = (items) => (items || []).reduce((a, it) => a + (Number(it && it.quantity) || 1), 0);

export function newOrderText(row, lang = "en") {
  const c = row.customer || {};
  const phone = c.phone || (row.phone_norm ? `0${row.phone_norm}` : "");
  const items = itemCount(row.items);
  if (lang === "ar") {
    return [
      `فريش كاتس — طلب أونلاين جديد ${row.order_no}`,
      `${OPTION.ar[row.option] || row.option} | ${rs(row.total)} ر.س | مدفوع ${row.pay_gateway || "أونلاين"}`,
      `${items} صنف${c.name ? ` | ${c.name}` : ""}${phone ? ` ${phone}` : ""}`,
      "تابع الطلب من بورتال التوصيل",
    ].join("\n");
  }
  return [
    `Fresh Cuts - NEW ONLINE ORDER ${row.order_no}`,
    `${OPTION.en[row.option] || row.option} | ${rs(row.total)} SAR | PAID (${row.pay_gateway || "online"})`,
    `${items} item${items === 1 ? "" : "s"}${c.name ? ` | ${c.name}` : ""}${phone ? ` ${phone}` : ""}`,
    "Please follow it on the delivery portal.",
  ].join("\n");
}

// نفس أكواد slaCheck في shop.js — النص الإنجليزي للمدير
const SLA_EN = {
  pos_stuck: (m) => `paid ${m} min ago and NOT in the POS yet. Enter it manually now.`,
  never_accepted: (m) => `${m} min and nobody accepted it - auto refund.`,
  accept_breach: (m) => `${m} min and nobody accepted it in the POS. Accept now.`,
  accept_late: (m) => `${m} min waiting for acceptance.`,
  handoff_breach: (m) => `${m} min since acceptance and no courier requested.`,
  handoff_late: (m) => `${m} min since acceptance - request the courier.`,
  pickup_breach: (m) => `${m} min and the courier has NOT picked it up. Call the courier.`,
  pickup_late: (m) => `${m} min waiting for the courier.`,
  deliver_breach: (m) => `${m} min on the way and NOT delivered. Call the courier.`,
  deliver_late: (m) => `${m} min on the way.`,
};

export function slaAlertText(orderNo, v, lang = "en") {
  if (lang === "ar") return `فريش كاتس ⚠️ الطلب ${orderNo}: ${v.message}`;
  const f = SLA_EN[v.code];
  return `Fresh Cuts ALERT - order ${orderNo}: ${f ? f(v.minutes) : v.message}`;
}

export function posFailedText(row, lang = "en") {
  if (lang === "ar") {
    return `فريش كاتس 🚨 الطلب ${row.order_no} (${rs(row.total)} ر.س مدفوع) ماوصلش نقطة البيع. بنعيد تلقائياً — لو ماظهرش خلال دقيقتين دخّله يدوي كطلب خارجي مدفوع.`;
  }
  return `Fresh Cuts URGENT - order ${row.order_no} (${rs(row.total)} SAR, PAID) did NOT reach the POS. Retrying automatically - if it does not appear in 2 min, enter it manually as a PAID external order.`;
}

export function tabsenseDownText(detail, lang = "en") {
  if (lang === "ar") return `فريش كاتس 🚨 ربط تاب سينس للطلبات الخارجية واقف (${detail}). الطلبات الأونلاين مش هتوصل نقطة البيع لحد ما يتصلح.`;
  return `Fresh Cuts URGENT - TabSense external-orders connection is DOWN (${detail}). Online orders will not reach the POS until it is fixed.`;
}

/* الإرسال. sendSms بيتحقن (من accounts.js) عشان الاختبارات. كل رسالة بتتبعت
   لكل رقم لوحده؛ فشل رقم مايوقفش الباقي. */
export function makeStaffNotifier({ getSettingsData, sendSms, log = console.error }) {
  async function sendAll(phones, body, tag) {
    let sent = 0;
    for (const phoneNorm of phones) {
      try { await sendSms({ phoneNorm, body }); sent++; }
      catch (e) { log(`[staff-sms] ${tag} → ${phoneNorm.slice(-4)} failed: ${e.message}`); }
    }
    return sent;
  }
  return {
    async newOrder(row) {
      const cfg = staffConfig(await getSettingsData());
      if (!cfg.newOrderSms || !cfg.newOrderPhones.length) return 0;
      return sendAll(cfg.newOrderPhones, newOrderText(row, cfg.lang), `new-order ${row.order_no}`);
    },
    async critical(buildText, tag) {
      const cfg = staffConfig(await getSettingsData());
      if (!cfg.alertPhones.length) { log(`[staff-sms] ${tag}: NO alert phones configured`); return 0; }
      return sendAll(cfg.alertPhones, buildText(cfg.lang), tag);
    },
    async test() {
      const cfg = staffConfig(await getSettingsData());
      const phones = [...new Set([...cfg.alertPhones, ...cfg.newOrderPhones])];
      const body = cfg.lang === "ar"
        ? "فريش كاتس — رسالة تجربة: رسايل الإدارة شغّالة ✅"
        : "Fresh Cuts - test message: staff SMS alerts are working.";
      return { phones: phones.map((p) => `***${p.slice(-4)}`), sent: await sendAll(phones, body, "test") };
    },
  };
}
