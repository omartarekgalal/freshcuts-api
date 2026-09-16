/* ═══════════════════════════════════════════════════════════════════════════
   رسايل الإدارة (SMS) — مدير المطعم وعمر

   طلب عمر (16 سبتمبر 2026، بعد طلب W1789555412320 اللي اتأخر والعميل زعل):
     «ابعتله بالانجليزي رسالة لو في اي طلب اتعمل عشان يتابعه»
     «خلي اي حاجة بندخلها ينفع يتم تعديلها من لوحة التحكم»
     «مش عايز يحصل اي مشكلة تاني لاي سبب من الاسباب»
     «الانذارات متعديش عدد الحروف المسموح بيها عشان ميكونش التكلفة اكثر من 1 رسالة»

   حدود الرسالة الواحدة:
     • إنجليزي (GSM-7): ١٦٠ حرف — والرموز | ^ { } [ ] ~ \ € بتتحسب حرفين
     • أي حرف عربي أو إيموجي بيقلب الرسالة كلها UCS-2: ٧٠ حرف بس
   عشان كده: القوالب قصيرة، مفيش اسم العميل (غالباً عربي ⇒ ٧٠ حرف)، مفيش
   إيموجي ولا «—»، وfitOneSms حارس أخير قبل الإرسال بيقص أي رسالة زيادة.

   قبل كده الإنذارات كانت بتروح عن طريق notify.sendSmsTo، وده بيشتغل بس لو
   رسايل «العملاء» مفعّلة — فإنذار المدير كان ممكن مايخرجش خالص في صمت. هنا
   الإرسال مباشر لتقنيات ومستقل عن إعدادات رسايل العملاء.

   كل الإعدادات من اللوحة (settings.delivery):
     alertPhones      أرقام الإنذارات الحرجة
     newOrderPhones   أرقام بتاخد رسالة مع كل طلب أونلاين جديد مدفوع
     newOrderSms      تشغيل/إيقاف رسالة الطلب الجديد (الافتراضي: شغّال)
     staffSmsLanguage "en" (الافتراضي) أو "ar"
═══════════════════════════════════════════════════════════════════════════ */

const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "\f^{}\\[~]|€";

export function smsInfo(text) {
  const t = String(text || "");
  let gsmLen = 0, gsm = true;
  for (const ch of t) {
    if (GSM7_BASIC.includes(ch)) gsmLen += 1;
    else if (GSM7_EXT.includes(ch)) gsmLen += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { encoding: "GSM-7", length: gsmLen, limit: 160, segments: gsmLen <= 160 ? 1 : Math.ceil(gsmLen / 153) };
  const u = t.length; // UTF-16 code units = اللي بيتحسب في UCS-2
  return { encoding: "UCS-2", length: u, limit: 70, segments: u <= 70 ? 1 : Math.ceil(u / 67) };
}

/* الحارس الأخير: أي رسالة أطول من رسالة واحدة بتتقص (من الآخر) لحد ما تبقى
   رسالة واحدة. القوالب مصممة إنها ماتوصلش هنا أصلاً. */
export function fitOneSms(text) {
  let t = String(text || "");
  if (smsInfo(t).segments <= 1) return t;
  const chars = Array.from(t);
  while (chars.length && smsInfo(chars.join("")).segments > 1) chars.pop();
  return chars.join("");
}

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

const rs = (n) => `${Math.round(Number(n) * 100) / 100}`;
const itemCount = (items) => (items || []).reduce((a, it) => a + (Number(it && it.quantity) || 1), 0);
// وسيلة الدفع من البوابة ممكن تيجي بحروف مش GSM — نسيب الإنجليزي والأرقام بس
const asciiOnly = (s, max = 14) => String(s || "").replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, max);
const localPhone = (row) => {
  const n = normStaffPhone((row.customer && row.customer.phone) || row.phone_norm);
  return n ? `0${n}` : "";
};

export function newOrderText(row, lang = "en") {
  const items = itemCount(row.items);
  const phone = localPhone(row);
  if (lang === "ar") {
    // UCS-2: لازم ≤ ٧٠ — من غير اسم ولا جوال
    return fitOneSms(`فريش كاتس طلب جديد ${row.order_no} ${row.option === "pickup" ? "استلام" : "توصيل"} ${rs(row.total)}ر مدفوع`);
  }
  const pay = asciiOnly(row.pay_gateway) || "online";
  return fitOneSms([
    `Fresh Cuts NEW ORDER ${row.order_no}`,
    `${row.option === "pickup" ? "Pickup" : "Delivery"} ${rs(row.total)} SAR PAID ${pay}`,
    `${items} item${items === 1 ? "" : "s"}${phone ? `, cust ${phone}` : ""}`,
    "Follow on delivery portal",
  ].join("\n"));
}

// نفس أكواد slaCheck في shop.js
const SLA_EN = {
  pos_stuck: (m) => `paid ${m}min, NOT in POS. Enter it manually now.`,
  never_accepted: (m) => `${m}min not accepted. Auto refund.`,
  accept_breach: (m) => `${m}min not accepted in POS. Accept now.`,
  accept_late: (m) => `${m}min waiting for acceptance.`,
  handoff_breach: (m) => `${m}min since acceptance, no courier requested.`,
  handoff_late: (m) => `${m}min since acceptance, request courier.`,
  pickup_breach: (m) => `${m}min, courier has NOT picked up. Call courier.`,
  pickup_late: (m) => `${m}min waiting for courier.`,
  deliver_breach: (m) => `${m}min on the way, NOT delivered. Call courier.`,
  deliver_late: (m) => `${m}min on the way.`,
};
const SLA_AR = {
  pos_stuck: (m) => `مدفوع من ${m}د ومش في نقطة البيع`,
  never_accepted: (m) => `${m}د ماتقبلش - استرجاع`,
  accept_breach: (m) => `${m}د محدش قبله`,
  accept_late: (m) => `${m}د مستني القبول`,
  handoff_breach: (m) => `${m}د من القبول ومفيش مندوب`,
  handoff_late: (m) => `${m}د اطلب مندوب`,
  pickup_breach: (m) => `${m}د المندوب مااستلمش`,
  pickup_late: (m) => `${m}د مستني المندوب`,
  deliver_breach: (m) => `${m}د في الطريق ومااتوصلش`,
  deliver_late: (m) => `${m}د في الطريق`,
};

export function slaAlertText(orderNo, v, lang = "en") {
  if (lang === "ar") {
    const f = SLA_AR[v.code];
    return fitOneSms(`فريش كاتس تنبيه ${orderNo}: ${f ? f(v.minutes) : "تأخير"}`);
  }
  const f = SLA_EN[v.code];
  return fitOneSms(`Fresh Cuts ALERT ${orderNo}: ${f ? f(v.minutes) : "order delayed"}`);
}

export function posFailedText(row, lang = "en") {
  if (lang === "ar") return fitOneSms(`فريش كاتس عاجل ${row.order_no} مدفوع ومش في نقطة البيع - دخله يدوي`);
  return fitOneSms(`Fresh Cuts URGENT ${row.order_no} ${rs(row.total)} SAR PAID, NOT in POS. Auto-retrying. If not there in 2min enter it manually as PAID external order.`);
}

export function tabsenseDownText(detail, lang = "en") {
  if (lang === "ar") return fitOneSms("فريش كاتس عاجل: ربط تاب سينس واقف - الطلبات مش هتوصل");
  return fitOneSms(`Fresh Cuts URGENT: TabSense external orders link DOWN (${asciiOnly(detail, 40)}). Online orders will not reach POS.`);
}

export function testText(lang = "en") {
  return lang === "ar" ? "فريش كاتس: رسالة تجربة - رسايل الإدارة شغالة" : "Fresh Cuts test: staff SMS alerts are working.";
}

/* الإرسال. sendSms بيتحقن (من accounts.js) عشان الاختبارات. كل رسالة بتتبعت
   لكل رقم لوحده؛ فشل رقم مايوقفش الباقي. fitOneSms مرة أخيرة قبل الإرسال. */
export function makeStaffNotifier({ getSettingsData, sendSms, log = console.error }) {
  async function sendAll(phones, body, tag) {
    const text = fitOneSms(body);
    let sent = 0;
    for (const phoneNorm of phones) {
      try { await sendSms({ phoneNorm, body: text }); sent++; }
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
      return { phones: phones.map((p) => `***${p.slice(-4)}`), sent: await sendAll(phones, testText(cfg.lang), "test") };
    },
  };
}
