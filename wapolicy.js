/* ═══════════════════════════════════════════════════════════════════════════
   سياسة رسايل الطلب على واتساب — «مانبعتش قالب بفلوس لكل مرحلة» (عمر ١٤/١٠)

   الواقع اللي بدأ منه (١٤/١٠): أول طلب بعد قوالب v2 (…1663) خد ٤ قوالب بفلوس (استلام، تجهيز، مع المندوب، توصيل) + طلب تقييم،
   ومادسش ولا زر. الرسايل الحرة جوّه نافذة الـ٢٤ ساعة ببلاش (whatsapp.sendOrderUpdate)، فالهدف حاجتين:
     ١) العميل يدخل النافذة بنفسه: زر «📲 تابع طلبك على واتساب» في صفحة الشكر/التتبع ⇒ wa.me برسالة جاهزة «تابع طلبي W…».
        البوت بيرد بالحالة، ورسالة العميل نفسها بتفتح النافذة ⇒ كل المراحل بعدها ببلاش.
     ٢) لما النافذة مقفولة: القالب الأول (استلمنا) بس، «بنجهّز» بتتشال، «مع المندوب» قالب، والتوصيل + التقييم رسالة واحدة
        (التوصيل v2 أو الحر فيه «تمام 👍 / عندي ملاحظة» = نفس سؤال التقييم ⇒ مفيش قالب تقييم تاني للطلب ده). ولو التوصيل اتبعت من غير الزرارين
        ⇒ التقييم يفضل، بس عمر ما يطلع قالبين بفلوس لنفس الطلب في أقل من reviewPaidGapMin دقيقة (بيتأجل مش بيتلغي).
   النافذة مفتوحة (العميل كتب أو ضغط) ⇒ كل المراحل ببلاش زي النهارده — السياسة دي مابتلمسهاش.
   كل قاعدة إعداد في waBot (لوحة البوت)، والافتراضي شغّال.
═══════════════════════════════════════════════════════════════════════════ */

export const KNOWN_WA_NUMBER = "966546715683";     // نفس wacloud.KNOWN_NUMBER (الرقم المعروض)

export const WA_POLICY_DEFAULTS = Object.freeze({
  followLink: true,              // زر «تابع طلبك على واتساب» في صفحة الشكر والتتبع (بيظهر بس والبوت شغّال للعملاء)
  followNumber: KNOWN_WA_NUMBER, // الرقم اللي الزر بيفتحه (دولي من غير +)
  closedPolicy: true,            // النافذة مقفولة ⇒ القواعد اللي تحت (مقفول = كل مرحلة قالب زي الأول)
  closedSkipPreparing: true,     // …«بنجهّز» مابتطلعش قالب
  mergeDeliveredReview: true,    // …التوصيل فيه زرّين التقييم ⇒ مفيش قالب تقييم منفصل لنفس الطلب
  reviewPaidGapMin: 30,          // …ومفيش قالبين بفلوس لنفس الطلب في أقل من كده (التقييم بيتأجل)
});

export function waPolicyCfg(settings = {}) {
  const x = ((settings || {}).waBot) || {};
  const n = Number(x.reviewPaidGapMin);
  let num = String(x.followNumber == null ? "" : x.followNumber).replace(/\D/g, "");
  if (/^05\d{8}$/.test(num)) num = `966${num.slice(1)}`; else if (/^5\d{8}$/.test(num)) num = `966${num}`; else if (/^00/.test(num)) num = num.slice(2);
  return {
    followLink: x.followLink !== false,
    followNumber: /^\d{9,15}$/.test(num) ? num : KNOWN_WA_NUMBER,
    closedPolicy: x.closedPolicy !== false,
    closedSkipPreparing: x.closedSkipPreparing !== false,
    mergeDeliveredReview: x.mergeDeliveredReview !== false,
    reviewPaidGapMin: Number.isFinite(n) && x.reviewPaidGapMin !== "" && x.reviewPaidGapMin !== null && n >= 0 && n <= 240 ? n : WA_POLICY_DEFAULTS.reviewPaidGapMin,
  };
}

/* النص الجاهز اللي البوت بيتعرّف عليه (wabotrun FOLLOW_RE) — عربي أو إنجليزي حسب لغة الصفحة */
export const followText = (orderNo, lang = "ar") => (lang === "en" ? `Track my order ${orderNo}` : `تابع طلبي ${orderNo}`);
export const FOLLOW_RE = /^\s*(?:📲\s*)?(?:تابع طلبي|تابع طلبى|track my order)\s*(?:رقم|no\.?|#)?\s*#?\s*(W\d{10,15})\s*[.!؟?]?\s*$/i;

/* زر صفحة التتبع ⇒ { url, urlEn, text, textEn } أو null.
   بيظهر بس لو: المفتاح شغّال، والبوت شغّال للعملاء (live) — غير كده العميل يكتب ومحدش يرد عليه آلياً — والطلب لسه ماتسلّمش ولا اتلغى. */
const FOLLOW_STATUSES = new Set(["paid", "pos_created", "accepted", "courier_requested", "courier_assigned", "on_the_way", "paid_pos_failed"]);
export function followLinkOf({ settings = {}, orderNo, status } = {}) {
  const cfg = waPolicyCfg(settings);
  const bot = ((settings || {}).waBot) || {};
  if (!cfg.followLink || bot.mode !== "live") return null;
  if (!/^W\d{10,15}$/.test(String(orderNo || "")) || !FOLLOW_STATUSES.has(String(status || ""))) return null;
  const mk = (t) => `https://wa.me/${cfg.followNumber}?text=${encodeURIComponent(t)}`;
  return { url: mk(followText(orderNo, "ar")), urlEn: mk(followText(orderNo, "en")), text: followText(orderNo, "ar"), textEn: followText(orderNo, "en") };
}

/* النافذة مقفولة: المرحلة دي تتبعت قالب؟ ⇒ { send:true } أو { send:false, reason } */
export function closedWindowStage(stage, cfg) {
  if (!cfg || !cfg.closedPolicy) return { send: true };
  if (stage === "accepted" && cfg.closedSkipPreparing) return { send: false, reason: "skip_preparing" };
  return { send: true };
}

/* طلب التقييم والنافذة مقفولة. sent = رسايل الطلب ده اللي اتقبلت [{template, source, stage, at}] (الأحدث في الآخر أو بأي ترتيب).
   ⇒ { send:true } | { send:false, reason:"merged_delivered" } | { send:false, defer:true, until, reason:"paid_gap" } */
const DELIVERED_WITH_BUTTONS = new Set(["fc_order_delivered_v2"]);
export function reviewDecision({ sent = [], cfg, now = Date.now() } = {}) {
  if (!cfg || !cfg.closedPolicy) return { send: true };
  const rows = (Array.isArray(sent) ? sent : []).filter(Boolean);
  if (cfg.mergeDeliveredReview && rows.some((m) => DELIVERED_WITH_BUTTONS.has(String(m.template || "")) || (!m.template && m.stage === "delivered" && m.source === "window"))) {
    return { send: false, reason: "merged_delivered" };
  }
  const paid = rows.filter((m) => m.template).map((m) => new Date(m.at).getTime()).filter(Number.isFinite);
  const last = paid.length ? Math.max(...paid) : null;
  const gap = Number(cfg.reviewPaidGapMin) || 0;
  if (gap > 0 && last != null && now - last < gap * 60_000) return { send: false, defer: true, reason: "paid_gap", until: new Date(last + gap * 60_000).toISOString() };
  return { send: true };
}

/* تقرير اليوم — رسايل الطلبات: لكل طلب كام قالب بفلوس وكام ببلاش وكام اتشال بالسياسة.
   msgs: [{order_no, stage, template, source}] (الصادر المقبول، اللي ليه طلب ومرحلة) · skips: [{order_no, stage, reason}] · rate = سعر القالب الخدمي */
export function orderMessagesReport(msgs = [], skips = [], rate = 0.0401) {
  const by = new Map();
  const row = (no) => { if (!by.has(no)) by.set(no, { order_no: no, paid: 0, free: 0, skipped: 0, stages: [] }); return by.get(no); };
  for (const m of msgs || []) {
    if (!m || !m.order_no || !m.stage) continue;
    const r = row(String(m.order_no));
    if (m.template) r.paid++; else r.free++;
    r.stages.push({ stage: m.stage, kind: m.template ? "paid" : "free" });
  }
  for (const s of skips || []) {
    if (!s || !s.order_no) continue;
    const r = row(String(s.order_no));
    r.skipped++;
    r.stages.push({ stage: s.stage || null, kind: "skipped", reason: s.reason || null });
  }
  const orders = [...by.values()];
  const t = orders.reduce((a, o) => ({ paid: a.paid + o.paid, free: a.free + o.free, skipped: a.skipped + o.skipped }), { paid: 0, free: 0, skipped: 0 });
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return {
    orders: orders.length,
    paid: t.paid, free: t.free, policy_skipped: t.skipped,
    paid_per_order: orders.length ? Math.round((t.paid / orders.length) * 100) / 100 : 0,
    paid_sar: r4(t.paid * rate),
    saved_sar: r4((t.free + t.skipped) * rate),
    list: orders.slice(0, 200),
    note: "per order: paid = templates (billed), free = in-window messages, skipped = left out by the closed-window policy (preparing / review merged into delivered). saved_sar = (free + skipped) × the utility rate",
  };
}
