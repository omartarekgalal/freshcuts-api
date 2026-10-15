/* ═══════════════════════════════════════════════════════════════════════════
   wafollow.js — FU1 (١٥/١٠/٢٠٢٦): متابعة واحدة جوّه نافذة الـ٢٤ ساعة للي ردّ على حملة (أو ضغط زر) وماطلبش
   ملف صافي: القواعد والحسابات والـSQL — مفيش إرسال ولا قاعدة هنا (التشغيل في wabotrun.js: sweeps ⇒ wa_bot_jobs ⇒ runReplyFollowUp).

   عمر (١٥/١٠): «ليه البوت مش بيرجع يبعت رسالة تانية للناس اللي ردّت ويلحقهم في النافذة». المثال الحي: عميل ضغط «ورّني المنيو» على رسالة
   «طبقك المفضل» الساعة ١:١٦، البوت رد بقايمة الأقسام، وسكت — ومحدش تابعه مع إن النافذة فضلت مفتوحة لحد ١:١٦ الليلة اللي بعدها.

   مين: آخر رسالة للعميل جت بعد رسالة حملة/تسويق (القالب اتبعت من أقل من replyFollowUpCampaignHours) أو فيها ضغطة زر بيع (منيو، قسم، صنف،
        بوكس، عروض…) في آخر replyFollowUpTapHours، وإحنا رديّنا بعدها وهو سكت. النافذة لسه مفتوحة، مفيش طلب مدفوع من ساعتها (الموقع أو نقطة البيع)،
        مفيش تحويل مفتوح، ماقالش «لا» / «إيقاف» / شكوى، والمحادثة مش عند موظف (صدى موظف أو كتم).
   امتى: مرة واحدة بعد replyFollowUpMin دقيقة سكوت من آخر رد لنا، جوّه الساعات المسموحة بس (الافتراضي ١٢:٠٠–١:٣٠ الرياض)؛ لو الوقت عدّى
        بالليل بتستنى بداية الساعات المسموحة طول ما النافذة هتفضل مفتوحة. مرة في النافذة (٢٤ ساعة)، ومفيش خالص لو فيه متابعتين (من أي نوع)
        ماحدش رد عليهم في آخر ٧ أيام، ولا لمدة ٧ أيام بعد «لا شكراً».
   إيه: سطرين قصيرين بالكتير + «أبغى أطلب» / «لا شكراً». الترتيب: عرض الحملة المخزّن للرقم ده (FD1 vars.fav) بنفس سعره وتوصيله بالظبط
        (أي اختلاف ⇒ سطر محايد من غير أرقام) ⇒ سلة جاهزة اتعملت في المحادثة ⇒ اللي شافه (صنف / بوكس / قسم) ⇒ طبقه المفضل ⇒ سطر محايد.
   الأمان: الإرسال من الحارس الواحد (wa.sendFreeform ⇒ guardSend)، ودفتر wa_followups بيحجز قبل الإرسال (مفيش اتنين لنفس النافذة)،
        والفرامل: «إيقاف» أو حظر (رسالة المتابعة فشلت) فوق replyFollowUpBrakePct٪ من متابعات اليوم ⇒ وقوف لوحده + تنبيه للمالك لحد ما يفكّها.
═══════════════════════════════════════════════════════════════════════════ */
import { FAV_SQL } from "./wafavpick.js";      // «طلب من ساعتها» = نفس تعريف الحملة (الموقع + نقطة البيع)

export const FU_KIND = "reply_followup";        // wa_bot_jobs.kind + wa_bot_log.reply_key للمتابعة نفسها
export const FU_GROUP = "followUp";
export const FU_GROUP_AR = "متابعة اللي ردّ وماطلبش (جوّه النافذة)";

/* ضغطات بتقول «بيفكّر يطلب» (المفتاح النهائي في wa_bot_log.reply_key لرسالة نوعها interactive / button). ضغطات الطلب الموجود والتقييم
   والإيقاف والموافقات والموظف مش منهم (العميل ده يا عنده طلب يا مش بيشتري). */
export const FU_TAP_KEYS = Object.freeze(["main", "menu", "cats", "cat", "item", "items", "boxes", "tier", "box", "best", "spicy", "offers", "packs", "delivery", "pickup", "payment", "order", "reorder", "weight", "rf_yes"]);
/* آخر رسالة للعميل بتقفل الكلام ⇒ مفيش متابعة (شكر، «لا»، إيقاف، شكوى، مشكلة، تعديل/إلغاء، موظف، ملاحظة تقييم، سؤال وصفة) */
export const FU_CLOSING_KEYS = Object.freeze(["thanks", "nack", "rf_no", "stop", "stop_updates", "complaint", "problem", "change", "cancel_what", "human", "staff", "review_note", "optin_no", "secret", "custom_offer"]);
/* رسايلنا المبادِرة اللي بتتحسب «متابعة» في قاعدة «متابعتين ماحدش رد عليهم في ٧ أيام» (wa_bot_log.reply_key، msg_type = followup) */
export const FU_PROACTIVE_KEYS = Object.freeze(["assist_followup", "lead_followup", "lead_nudge", "window_keep", FU_KIND]);
/* متابعات تانية في نفس النافذة (wa_bot_jobs.kind) ⇒ مفيش متابعة تانية فوقها */
export const FU_OTHER_JOBS = Object.freeze(["assist_followup", "assist_nudge", "lead_followup", "window_keep"]);

/* ── الإعدادات (كلها في اللوحة: settings.waBot.<المفتاح>) ─────────────────────── */
export const FU_DEFAULTS = Object.freeze({
  replyFollowUp: true,               // المفتاح الرئيسي
  replyFollowUpMin: 40,              // بعد سكوت كام دقيقة من آخر رد لنا
  replyFollowUpFromHour: 12, replyFollowUpFromMinute: 0,      // الساعات المسموحة (الرياض): من…
  replyFollowUpToHour: 1, replyFollowUpToMinute: 30,          // …لحد (بعد نص الليل = ساعة صغيرة)
  replyFollowUpCampaignHours: 72,    // الرد بيتحسب «رد على حملة» لو القالب التسويقي اتبعت من أقل من كده
  replyFollowUpTapHours: 3,          // ضغطة زر بيع في آخر كام ساعة قبل آخر رسالة للعميل
  replyFollowUpOffer: true,          // عرض الحملة المخزّن («طبقك المفضل») بنفس سعره وتوصيله + سلة جاهزة
  replyFollowUpLooked: true,         // سطر من اللي شافه (صنف / بوكس / قسم) بسلة أو رابط
  replyFollowUpFav: true,            // طبقه المفضل من طلباته بسلة جاهزة
  replyFollowUpDeclineDays: 7,       // «لا شكراً» ⇒ مفيش متابعات المدة دي
  replyFollowUpIgnoredMax: 2,        // متابعات ماحدش رد عليها (من أي نوع)…
  replyFollowUpIgnoredDays: 7,       // …خلال المدة دي ⇒ مفيش متابعة تانية
  replyFollowUpDailyCap: 100,        // أقصى عدد في يوم الشغل (صفر = مقفول)
  replyFollowUpBrakePct: 2,          // الفرامل: «إيقاف» أو حظر فوق النسبة دي من متابعات اليوم ⇒ وقوف + تنبيه المالك
});
export const FU_NUMS = Object.freeze({
  replyFollowUpMin: [10, 600], replyFollowUpFromHour: [0, 23], replyFollowUpFromMinute: [0, 59], replyFollowUpToHour: [0, 23], replyFollowUpToMinute: [0, 59],
  replyFollowUpCampaignHours: [1, 168], replyFollowUpTapHours: [1, 24], replyFollowUpDeclineDays: [1, 60], replyFollowUpIgnoredMax: [1, 10], replyFollowUpIgnoredDays: [1, 60],
  replyFollowUpDailyCap: [0, 1000], replyFollowUpBrakePct: [1, 50],
});
export const FU_BOOLS = Object.freeze(["replyFollowUp", "replyFollowUpOffer", "replyFollowUpLooked", "replyFollowUpFav"]);
const clamp = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, n)) : d; };
/* settings.waBot ⇒ القيم النهائية (الغلط ⇒ الافتراضي، بره الحدود ⇒ للحد). المفاتيح مسطّحة زي باقي إعدادات البوت. */
export function fuConfig(x = {}) {
  const src = x && typeof x === "object" ? x : {};
  const out = {};
  for (const k of FU_BOOLS) out[k] = src[k] !== false;
  for (const [k, lim] of Object.entries(FU_NUMS)) out[k] = Math.round(clamp(src[k], lim, FU_DEFAULTS[k]));
  return out;
}
const S = (type, ar, help, extra = {}) => Object.freeze({ group: FU_GROUP, type, ar, help, ...extra });
const N = (k, ar, help, unit) => S("number", ar, help, { min: FU_NUMS[k][0], max: FU_NUMS[k][1], unit });
export const FU_SCHEMA = Object.freeze({
  replyFollowUp: S("boolean", "متابعة واحدة للي ردّ على حملة أو ضغط زر وماطلبش",
    "عميل ردّ على رسالة حملة (أو ضغط زر منيو / قسم / صنف / بوكس) وإحنا رديّنا وهو سكت ⇒ رسالة حرة واحدة ببلاش جوّه النافذة بعد مدة السكوت: سطرين بالكتير + «أبغى أطلب» / «لا شكراً». مرة في النافذة، وفي الساعات المسموحة بس. مابتتبعتش لو طلب (الموقع أو الفرع)، أو فيه تحويل مفتوح، أو قال «لا» / «إيقاف» / اشتكى، أو موظف دخل المحادثة أو كتمها."),
  replyFollowUpMin: N("replyFollowUpMin", "المتابعة بعد سكوت", "من آخر رد لنا (البوت أو المساعد) والعميل ماكتبش بعده.", "دقيقة"),
  replyFollowUpFromHour: N("replyFollowUpFromHour", "الساعات المسموحة: من الساعة", "بتوقيت الرياض. لو مدة السكوت خلصت بره الساعات دي، المتابعة بتستنى بدايتها طول ما نافذة العميل هتفضل مفتوحة.", "س"),
  replyFollowUpFromMinute: N("replyFollowUpFromMinute", "…والدقيقة", "", "د"),
  replyFollowUpToHour: N("replyFollowUpToHour", "الساعات المسموحة: لحد الساعة", "بعد نص الليل = ساعة صغيرة (١ = الواحدة بالليل). نفس البداية والنهاية = مفيش متابعات.", "س"),
  replyFollowUpToMinute: N("replyFollowUpToMinute", "…والدقيقة", "", "د"),
  replyFollowUpCampaignHours: N("replyFollowUpCampaignHours", "الرد بيتحسب «رد على حملة» لو الحملة اتبعتت من أقل من", "", "ساعة"),
  replyFollowUpTapHours: N("replyFollowUpTapHours", "ضغطة زر بيع بتتحسب لو كانت في آخر", "قبل آخر رسالة للعميل.", "ساعة"),
  replyFollowUpOffer: S("boolean", "المتابعة تعيد عرض الحملة («طبقك المفضل») بسلة جاهزة", "بنفس السعر وسطر التوصيل اللي في رسالة الحملة بالظبط (محسوبين تاني الحين). أي اختلاف ⇒ سطر محايد من غير أرقام."),
  replyFollowUpLooked: S("boolean", "المتابعة من اللي شافه (صنف / بوكس / قسم)", "الصنف بسلة جاهزة، البوكس برابطه، القسم برابط المنيو."),
  replyFollowUpFav: S("boolean", "المتابعة بطبقه المفضل (من طلباته) بسلة جاهزة", "لو مفيش عرض ولا حاجة معيّنة شافها."),
  replyFollowUpDeclineDays: N("replyFollowUpDeclineDays", "بعد «لا شكراً»: مفيش متابعات لمدة", "", "يوم"),
  replyFollowUpIgnoredMax: N("replyFollowUpIgnoredMax", "مفيش متابعة بعد عدد متابعات ماحدش رد عليها", "من أي نوع (المتابعة دي، متابعة السلة، متابعة المساعد، رسالة قبل قفل النافذة…).", "متابعة"),
  replyFollowUpIgnoredDays: N("replyFollowUpIgnoredDays", "…خلال آخر", "", "يوم"),
  replyFollowUpDailyCap: N("replyFollowUpDailyCap", "أقصى عدد متابعات في اليوم", "يوم الشغل (٤ الفجر لـ٤ الفجر). صفر = مقفول.", "رسالة"),
  replyFollowUpBrakePct: N("replyFollowUpBrakePct", "الفرامل: «إيقاف» أو حظر فوق", "من متابعات اليوم (المتابعة اتبعتت وبعدها العميل كتب «إيقاف»، أو رسالتها ماوصلتش). فوق النسبة ⇒ المتابعات تقف لوحدها ويوصل تنبيه للمالك، ومابترجعش غير لما المالك يفكّ الفرامل من اللوحة.", "٪"),
});

/* ── الوقت (الرياض) ──────────────────────────────────────────────────────────── */
const RIYADH_MS = 3 * 3600_000;
export const riyadhMin = (now) => { const r = new Date(now.getTime() + RIYADH_MS); return r.getUTCHours() * 60 + r.getUTCMinutes(); };
const fromMin = (c) => c.replyFollowUpFromHour * 60 + c.replyFollowUpFromMinute;
const toMin = (c) => c.replyFollowUpToHour * 60 + c.replyFollowUpToMinute;
/* جوّه الساعات المسموحة؟ البداية داخلة والنهاية لأ. بتعدّي نص الليل (١٢:٠٠ ⇒ ١:٣٠). نفس البداية والنهاية = ولا مرة (مفيش «طول اليوم» بالغلط). */
export function inFollowHours(now, c) {
  const m = riyadhMin(now), a = fromMin(c), b = toMin(c);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}
/* أول بداية للساعات المسموحة بعد اللحظة دي (لو إحنا جوّاها دلوقتي: بداية بكرة) */
export function nextFollowStart(now, c) {
  const r = new Date(now.getTime() + RIYADH_MS);
  let t = Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate()) + fromMin(c) * 60_000 - RIYADH_MS;
  while (t <= now.getTime()) t += 86400_000;
  return new Date(t);
}
/* بداية يوم الشغل (٤ الفجر بتوقيت الرياض) — نفس يوم «تقرير ماجد» */
export function bizDayStart(now) {
  const d = new Date(now.getTime() + RIYADH_MS - 4 * 3600_000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${d}T00:00:00Z`) - RIYADH_MS + 4 * 3600_000);
}

/* ── الفرامل ──────────────────────────────────────────────────────────────────── */
/* bad = متابعات اليوم اللي بعدها العميل وقّف الرسايل أو رسالتها فشلت. «فوق» الحد بالظبط (١ من ٥٠ = ٢٪ ⇒ لأ؛ ١ من ٤٩ ⇒ آه). */
export function brakeVerdict({ sent = 0, bad = 0 } = {}, pct = FU_DEFAULTS.replyFollowUpBrakePct) {
  const s = Number(sent) || 0, b = Number(bad) || 0;
  if (!(s > 0) || !(b > 0)) return { trip: false, pct: 0 };
  const p = Math.round((b * 1000) / s) / 10;
  return { trip: (b * 100) / s > Number(pct), pct: p };
}

/* ── الزناد: حملة ولا ضغطة ─────────────────────────────────────────────────────── */
export function followTrigger({ campAt = null, tapAt = null } = {}) {
  const c = campAt ? new Date(campAt).toISOString() : null, t = tapAt ? new Date(tapAt).toISOString() : null;
  if (c) return { trigger: "campaign", at: c };
  if (t) return { trigger: "tap", at: t };
  return null;
}

/* ── المحادثة من سجل البوت (صفوف FU_SQL.conv: الأحدث أولاً) ─────────────────────────
   صف رسالة عميل = له wamid. ⇒ آخر مفتاح للعميل، لغته، قال «لا»، والكروت اللي البوت عرضها (صنف / بوكس / قسم / وزن) من الأحدث. */
export function convFacts(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const cust = list.filter((r) => r && r.wamid);
  const last = cust[0] || null;
  return {
    lastKey: last ? String(last.reply_key || "") : null,
    lang: last && last.lang === "en" ? "en" : "ar",
    saidNo: cust.some((r) => ["nack", "rf_no"].includes(String(r.reply_key || ""))),
    looked: list.filter((r) => r && ["replied", "dry"].includes(String(r.decision || "")) && ["item", "box", "cat", "weight"].includes(String(r.reply_key || "")))
      .map((r) => ({ key: String(r.reply_key), arg: r.reply_arg == null ? "" : String(r.reply_arg) })),
  };
}
const SIDE_CATS = new Set(["Sides & Drinks", "Best Sellers", "Offers"]);
/* أحدث حاجة شافها لسه متاحة الحين: صنف (مش خلص، مش إضافات) / بوكس (له قسم وسعر) / قسم أكل. الوزن ⇒ الصنف نفسه.
   menu = wabot.indexMenu · bundles = /api/shop/bundles ⇒ { kind: "item"|"box"|"section", … } أو null */
export function pickLooked(looked = [], { menu = null, bundles = [] } = {}) {
  const items = menu && Array.isArray(menu.items) ? menu.items : [];
  const cats = menu && Array.isArray(menu.categories) ? menu.categories : [];
  for (const x of Array.isArray(looked) ? looked : []) {
    if (x.key === "item" || x.key === "weight") {
      const id = x.key === "item" ? x.arg : ((/"id":"?(\d+)/.exec(x.arg) || [])[1] || "");
      const it = items.find((i) => String(i.id) === String(id));
      if (!it || it.soldOut || SIDE_CATS.has(it.category) || !(Number(it.price) > 0)) continue;
      return { kind: "item", id: String(it.id), name: it.name, nameEn: it.nameEn || it.name, price: Number(it.price), byWeight: Boolean(it.byWeight) };
    }
    if (x.key === "box") {
      const b = (Array.isArray(bundles) ? bundles : []).find((y) => String(y.slug) === x.arg && String(y.section || "").trim() && Number(y.price) > 0);
      /* from = فيه اختيار بزيادة ⇒ «بسعر يبدأ من» (زي الحملة) — مانقولش سعر البوكس كأنه نهائي */
      const from = Boolean(b) && (Array.isArray(b.slots) ? b.slots : []).some((s) => s && s.type === "choice" && (Array.isArray(s.choices) ? s.choices : []).some((c) => Number(c && c.surcharge) > 0));
      if (b) return { kind: "box", slug: String(b.slug), name: String(b.name || b.slug), nameEn: String(b.name_en || b.name || b.slug), price: Number(b.price), from };
      continue;
    }
    if (x.key === "cat") {
      const c = cats.find((y) => String(y.id) === x.arg);
      if (c && !SIDE_CATS.has(c.title) && !c.merch) return { kind: "section", id: String(c.id), name: c.titleAr || c.title, nameEn: c.title };
    }
  }
  return null;
}
/* سطر عرض الحملة القصير (t = نتيجة wafavpick.tapOffer): «الاسم بـX ر.س» + سطر التوصيل زي ما اتقال في الحملة بالظبط لو كان رسم مؤكد لعنوانه
   أو «استلام بس» (عنوانه بره النطاق: السلة نفسها استلام) — سطور «من غير عنوان» (FIRST بشرطه…) طويلة وصفحة الدفع بتقولها، فمابتتعادش */
export function offerPhrase(t) {
  if (!t || !t.shortMain) return null;
  return ["fee", "out_of_range"].includes(t.delivery) && t.dlText ? `${t.shortMain}، ${t.dlText}` : t.shortMain;
}

/* ── الـSQL (كل جملة بعلامة /*fu:…*\/ في أولها: للتشخيص وللاختبارات) ───────────────── */
const MKT = "c.direction = 'out' AND c.template IS NOT NULL AND (c.category = 'MARKETING' OR c.source = 'campaign')";
export const FU_SQL = Object.freeze({
  /* المرشّحين كل دقيقة: نافذة مفتوحة، رديّنا بعد آخر رسالة ليه وسكت N دقيقة، مفيش قالب تسويقي بعد رسالته، مفيش شغلة لنفس النافذة ولا متابعة في ٢٤ ساعة، وفيه زناد.
     $1 السكوت (دقيقة) · $2 أقدم آخر-رسالة مقبولة (دقيقة من الحين) · $3 ساعات الحملة · $4 مفاتيح الضغطات · $5 ساعات الضغطة · $6 أرقام التجربة (أو null) · $7 الحد */
  candidates: `/*fu:candidates*/ WITH w AS (
      SELECT phone_norm,
             max(created_at) FILTER (WHERE direction = 'in' AND COALESCE(source,'api') <> 'history') AS last_in,
             max(created_at) FILTER (WHERE direction = 'out' AND COALESCE(source,'api') <> 'echo' AND COALESCE(status,'') NOT IN ('failed','skipped')) AS last_out
        FROM wa_messages WHERE created_at > NOW() - INTERVAL '25 hours' AND phone_norm ~ '^5[0-9]{8}$' GROUP BY phone_norm)
    SELECT w.phone_norm, w.last_in, w.last_out FROM w
     WHERE w.last_in > NOW() - make_interval(mins => $2::int)
       AND w.last_out >= w.last_in AND w.last_out <= NOW() - make_interval(mins => $1::int)
       AND ($6::text[] IS NULL OR w.phone_norm = ANY($6::text[]))
       AND NOT EXISTS (SELECT 1 FROM wa_bot_jobs j WHERE j.phone_norm = w.phone_norm AND j.kind = '${FU_KIND}' AND j.created_at >= w.last_in)
       AND NOT EXISTS (SELECT 1 FROM wa_followups f WHERE f.phone_norm = w.phone_norm AND f.status <> 'failed' AND f.sent_at > NOW() - INTERVAL '24 hours')
       AND NOT EXISTS (SELECT 1 FROM wa_messages c WHERE c.phone_norm = w.phone_norm AND ${MKT} AND c.created_at > w.last_in)
       AND (EXISTS (SELECT 1 FROM wa_messages c WHERE c.phone_norm = w.phone_norm AND ${MKT} AND COALESCE(c.status,'') NOT IN ('failed','skipped')
                     AND c.created_at > NOW() - make_interval(hours => $3::int) AND c.created_at < w.last_in)
            OR EXISTS (SELECT 1 FROM wa_bot_log l WHERE l.phone_norm = w.phone_norm AND l.msg_type IN ('interactive','button') AND l.reply_key = ANY($4::text[])
                     AND l.at > w.last_in - make_interval(hours => $5::int) AND l.at <= w.last_in + INTERVAL '2 minutes'))
     ORDER BY w.last_out LIMIT $7::int`,
  /* آخر رد لنا بعد رسالته ($2) + هل اتبعتله قالب تسويقي بعدها */
  lastOut: `/*fu:last_out*/ SELECT max(c.created_at) AS at, count(*) FILTER (WHERE ${MKT})::int AS mkt FROM wa_messages c
     WHERE c.phone_norm = $1 AND c.direction = 'out' AND COALESCE(c.source,'api') <> 'echo' AND COALESCE(c.status,'') NOT IN ('failed','skipped') AND c.created_at >= $2::timestamptz`,
  /* الزناد: آخر قالب تسويقي قبل رسالته ($2) جوّه ساعات الحملة ($3)، وأول ضغطة بيع ($4) في ساعات الضغطة ($5) قبلها */
  trigger: `/*fu:trigger*/ SELECT
      (SELECT max(c.created_at) FROM wa_messages c WHERE c.phone_norm = $1 AND ${MKT} AND COALESCE(c.status,'') NOT IN ('failed','skipped')
          AND c.created_at > NOW() - make_interval(hours => $3::int) AND c.created_at < $2::timestamptz) AS camp_at,
      (SELECT min(l.at) FROM wa_bot_log l WHERE l.phone_norm = $1 AND l.msg_type IN ('interactive','button') AND l.reply_key = ANY($4::text[])
          AND l.at > $2::timestamptz - make_interval(hours => $5::int) AND l.at <= $2::timestamptz + INTERVAL '2 minutes') AS tap_at`,
  /* سجل المحادثة من الزناد ($2): رسايل العميل (لها wamid) والكروت اللي رديّنا بيها — الأحدث أولاً */
  conv: `/*fu:conv*/ SELECT reply_key, reply_arg, msg_type, decision, lang, wamid, at FROM wa_bot_log WHERE phone_norm = $1 AND at >= $2::timestamptz ORDER BY at DESC, id DESC LIMIT 60`,
  /* مرة في النافذة: متابعة دي في آخر ٢٤ ساعة · متابعة تانية اتبعتت بعد رسالته ($2) · متابعة تانية مستنية ميعادها ($3 = الأنواع) */
  recent: `/*fu:recent*/ SELECT
      (SELECT count(*) FROM wa_followups WHERE phone_norm = $1 AND status <> 'failed' AND sent_at > NOW() - INTERVAL '24 hours')::int AS mine,
      (SELECT count(*) FROM wa_bot_jobs WHERE phone_norm = $1 AND kind = ANY($3::text[]) AND status = 'done' AND done_at > $2::timestamptz)::int AS others,
      (SELECT count(*) FROM wa_bot_jobs WHERE phone_norm = $1 AND kind = ANY($3::text[]) AND status = 'pending')::int AS pending`,
  /* متابعات مبادِرة (أي نوع، $2) في آخر $3 يوم ماجالهاش أي رسالة من العميل خلال ٢٤ ساعة */
  ignored: `/*fu:ignored*/ SELECT count(*)::int AS n FROM wa_bot_log l
     WHERE l.phone_norm = $1 AND l.msg_type = 'followup' AND l.decision = 'replied' AND l.reply_key = ANY($2::text[]) AND l.at > NOW() - make_interval(days => $3::int)
       AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm = l.phone_norm AND m.direction = 'in' AND COALESCE(m.source,'api') <> 'history'
                         AND m.created_at > l.at AND m.created_at < l.at + INTERVAL '24 hours')`,
  optedOut: "/*fu:opted_out*/ SELECT 1 FROM cms_contacts WHERE phone_norm = $1 AND opted_out_at IS NOT NULL LIMIT 1",
  /* موظف كلّمه في المحادثة (من الزناد $2): رسالة حرة طلعت من غير البوت ولا تحديث الطلب — رد من الصندوق أو البورتال القديم (wainbox.replyText ⇒ sendText
     بيتسجّل source «api» مش «echo»). صدى الموبايل والرد من اللوحة (source echo) بيتقروا من lastEcho في wabotrun. */
  manual: `/*fu:manual*/ SELECT count(*)::int AS n FROM wa_messages WHERE phone_norm = $1 AND direction = 'out' AND template IS NULL
     AND COALESCE(source,'api') NOT IN ('bot','window','echo') AND COALESCE(status,'') NOT IN ('failed','skipped') AND created_at > $2::timestamptz`,
  /* طلب (الموقع أو نقطة البيع) من $2 — نفس جملة حملة «طبقك المفضل» (wafavpick.FAV_SQL.orderedSince) */
  ordered: `/*fu:ordered*/ ${FAV_SQL.orderedSince}`,
  /* سلة جاهزة اتعملت في المحادثة (بعد الزناد) ولسه صالحة */
  cartLive: "/*fu:cart_live*/ SELECT code FROM wa_bot_carts WHERE phone_norm = $1 AND created_at > $2::timestamptz AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
  cartOk: "/*fu:cart_ok*/ SELECT 1 FROM wa_bot_carts WHERE code = $1 AND phone_norm = $2 AND expires_at > NOW() LIMIT 1",
  dayCount: "/*fu:day_count*/ SELECT count(*)::int AS n FROM wa_followups WHERE status <> 'failed' AND sent_at >= $1::timestamptz",
  /* الفرامل: متابعات من $1 — وقّف بعدها (إيقاف العروض أو كل الرسايل) أو رسالتها فشلت (حظر / ماوصلتش) */
  dayStats: `/*fu:day_stats*/ SELECT count(*)::int AS sent,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_optins o WHERE o.phone_norm = f.phone_norm AND (o.stopped_at >= f.sent_at OR o.marketing_off_at >= f.sent_at)))::int AS stopped,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_messages m WHERE m.wamid = f.wamid AND m.status = 'failed'))::int AS blocked,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_optins o WHERE o.phone_norm = f.phone_norm AND (o.stopped_at >= f.sent_at OR o.marketing_off_at >= f.sent_at))
                          OR EXISTS (SELECT 1 FROM wa_messages m WHERE m.wamid = f.wamid AND m.status = 'failed'))::int AS bad
     FROM wa_followups f WHERE f.status = 'sent' AND f.sent_at >= $1::timestamptz`,
  brakeGet: "/*fu:brake_get*/ SELECT on_at, cleared_at, cleared_by, sent, bad, pct, detail FROM wa_followup_brake WHERE id = 1",
  /* بيشدّ الفرامل بس لو مش مشدودة (أو اتفكّت بعد آخر شدّة) ⇒ صف = إحنا اللي شدّيناها (التنبيه مرة واحدة) */
  brakeSet: `/*fu:brake_set*/ INSERT INTO wa_followup_brake(id, on_at, sent, bad, pct, detail) VALUES (1, NOW(), $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET on_at = NOW(), sent = $1, bad = $2, pct = $3, detail = $4, cleared_at = NULL, cleared_by = NULL
      WHERE wa_followup_brake.on_at IS NULL OR (wa_followup_brake.cleared_at IS NOT NULL AND wa_followup_brake.cleared_at >= wa_followup_brake.on_at) RETURNING id`,
  brakeClear: "/*fu:brake_clear*/ UPDATE wa_followup_brake SET cleared_at = NOW(), cleared_by = $1 WHERE id = 1 AND on_at IS NOT NULL AND (cleared_at IS NULL OR cleared_at < on_at) RETURNING on_at",
  /* الحجز قبل الإرسال: صف واحد لكل نافذة (job_key) — مفيش متابعتين لنفس النافذة حتى لو اتنفّذوا مع بعض */
  reserve: `/*fu:reserve*/ INSERT INTO wa_followups(job_key, phone_norm, trigger, trigger_at, last_in, via, ref, lang, cart_code, cart_total, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sending') ON CONFLICT (job_key) DO NOTHING RETURNING id`,
  mark: "/*fu:mark*/ UPDATE wa_followups SET status = $2, wamid = $3, error = $4, sent_at = NOW() WHERE id = $1",
  /* الشغلة بتستنى (لسه في وقت السكوت / بره الساعات / المطعم مقفول / سقف اليوم) ⇒ ميعاد جديد */
  defer: "/*fu:defer*/ UPDATE wa_bot_jobs SET status = 'pending', due_at = $2, reason = $3, done_at = NULL WHERE id = $1",
  /* الفرامل اتشدّت ⇒ كل شغلات المتابعة المستنية تتلغي بسببها ($1) */
  cancelPending: `/*fu:cancel_pending*/ UPDATE wa_bot_jobs SET status = 'cancelled', reason = $1, done_at = NOW() WHERE kind = '${FU_KIND}' AND status = 'pending'`,
  /* آخر متابعة اتبعتت للرقم في ٢٤ ساعة (للرد عليها) */
  latest: "/*fu:latest*/ SELECT id, cart_code, sent_at, answered_at, via FROM wa_followups WHERE phone_norm = $1 AND status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours' ORDER BY sent_at DESC LIMIT 1",
  /* فيه رسالة تانية من العميل بعد المتابعة ($3) غير دي ($2)؟ ⇒ «نعم / لا» المكتوبة مش رد على المتابعة */
  otherReply: "/*fu:other_reply*/ SELECT 1 FROM wa_bot_log WHERE phone_norm = $1 AND wamid IS NOT NULL AND id <> $2 AND at > $3::timestamptz LIMIT 1",
  answer: `/*fu:answer*/ UPDATE wa_followups SET answered_at = NOW(), answer = $2
     WHERE id = (SELECT id FROM wa_followups WHERE phone_norm = $1 AND status = 'sent' AND answered_at IS NULL AND sent_at > NOW() - INTERVAL '24 hours' ORDER BY sent_at DESC LIMIT 1) RETURNING id`,
  decline: "/*fu:decline*/ INSERT INTO wa_bot_chats(phone_norm, follow_declined_at) VALUES ($1, NOW()) ON CONFLICT (phone_norm) DO UPDATE SET follow_declined_at = NOW(), updated_at = NOW()",
  /* «تقرير ماجد»: متابعات يوم الشغل [$1, $2) ونتيجتها خلال ٢٤ ساعة */
  report: `/*fu:report*/ SELECT count(*)::int AS sent,
      count(*) FILTER (WHERE f.answered_at IS NOT NULL OR EXISTS (SELECT 1 FROM wa_messages m WHERE m.phone_norm = f.phone_norm AND m.direction = 'in' AND COALESCE(m.source,'api') <> 'history'
                         AND m.created_at > f.sent_at AND m.created_at < f.sent_at + INTERVAL '24 hours'))::int AS replied,
      count(*) FILTER (WHERE f.answer = 'yes')::int AS said_yes,
      count(*) FILTER (WHERE f.answer = 'no')::int AS said_no,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_optins o WHERE o.phone_norm = f.phone_norm AND (o.stopped_at >= f.sent_at OR o.marketing_off_at >= f.sent_at)))::int AS stopped,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_messages m WHERE m.wamid = f.wamid AND m.status = 'failed'))::int AS blocked,
      count(*) FILTER (WHERE f.cart_code IS NOT NULL)::int AS carts,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_bot_carts b WHERE b.code = f.cart_code AND b.opens > 0))::int AS carts_opened,
      count(*) FILTER (WHERE o.n > 0)::int AS ordered,
      COALESCE(sum(o.n), 0)::int AS paid_orders,
      COALESCE(sum(o.sar), 0)::float AS paid_sar,
      COALESCE(sum(o.via_link), 0)::int AS paid_via_link
     FROM wa_followups f
     LEFT JOIN LATERAL (SELECT count(*)::int AS n, COALESCE(sum(s.total), 0)::float AS sar, count(*) FILTER (WHERE s.attribution->>'fc_link' = 'wa-followup')::int AS via_link
                          FROM shop_orders s WHERE s.phone_norm = f.phone_norm AND NOT COALESCE(s.is_test,false) AND s.created_at > f.sent_at AND s.created_at < f.sent_at + INTERVAL '24 hours'
                           AND s.status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')) o ON TRUE
    WHERE f.status = 'sent' AND f.sent_at >= $1::timestamptz AND f.sent_at < $2::timestamptz`,
  reportVia: "/*fu:report_via*/ SELECT COALESCE(via,'-') AS via, count(*)::int AS n FROM wa_followups WHERE status = 'sent' AND sent_at >= $1::timestamptz AND sent_at < $2::timestamptz GROUP BY 1",
});
/* الجداول (بتتعمل مع جداول البوت وقت التشغيل) */
export const FU_DDL = `
  CREATE TABLE IF NOT EXISTS wa_followups (
    id BIGSERIAL PRIMARY KEY,
    job_key TEXT UNIQUE,                   -- rf:<الرقم>:<وقت آخر رسالة للعميل> — صف واحد للنافذة
    phone_norm TEXT NOT NULL,
    trigger TEXT, trigger_at TIMESTAMPTZ, last_in TIMESTAMPTZ,      -- campaign | tap
    via TEXT, ref TEXT, lang TEXT,         -- offer | offer_box | cart | item | item_page | box | section | fav | neutral
    status TEXT NOT NULL DEFAULT 'sending',      -- sending | sent | failed
    wamid TEXT, error TEXT,
    cart_code TEXT, cart_total NUMERIC,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answer TEXT, answered_at TIMESTAMPTZ   -- yes | no | stop | text
  );
  CREATE INDEX IF NOT EXISTS wa_followups_phone_idx ON wa_followups(phone_norm, sent_at DESC);
  CREATE INDEX IF NOT EXISTS wa_followups_sent_idx ON wa_followups(sent_at DESC);
  CREATE TABLE IF NOT EXISTS wa_followup_brake (id INT PRIMARY KEY, on_at TIMESTAMPTZ, sent INT, bad INT, pct REAL, detail TEXT, cleared_at TIMESTAMPTZ, cleared_by TEXT);
  ALTER TABLE wa_bot_chats ADD COLUMN IF NOT EXISTS follow_declined_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS wa_bot_jobs_phone_kind_idx ON wa_bot_jobs(phone_norm, kind, created_at DESC);
`;
