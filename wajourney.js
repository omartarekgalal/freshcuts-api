/* ═══════════════════════════════════════════════════════════════════════════
   wajourney.js — CJ1a (١٧/١٠/٢٠٢٦): رحلة العميل في النافذة — مفيش رسايل ورا بعض
   ملف صافي: الإعدادات + القرارات + نصوص الـSQL. مفيش قاعدة ولا إرسال هنا (التنفيذ في whatsapp.js guardSend،
   wabotrun.js runDueJobs/runPaidNote/reviewAsk، wasender.js sendCloudRow، courierops.js customerSms، carts.js sendStep).

   عمر (١٧/١٠ ٠٧:٠٠): «الرسايل بيجي منها شغل ودخل … ليه ٣ رسايل في دقيقتين». يعني: مش سقف على عدد الرسايل، المشكلة
   الدفعات (رسالتين وتلاتة في دقايق) والتكرار على نفس الطلب. تدقيق الإزعاج ١٦/١٠: «وصلنا طلبك» بعد fc_order_received_v2 في ٨ من ٢٢ طلب،
   SMS «مندوب بديل» مكررة مع واتساب ١٣/١٣، وطلبات خدت ٥–٦ رسايل.

   القواعد الأربع (كلها إعدادات في اللوحة — settings.waBot.<المفتاح>، مجموعة «رحلة العميل في النافذة»):
   ١) مفيش دفعات: بعد أي رسالة طالعة للعميل (واتساب أو SMS، من أي نظام) الرسايل **المبادِرة** بتستنى burstHoldMin دقيقة:
      حملة Cloud، متابعة اللي ردّ (FU1)، حارس النافذة، «أنا معك» (lead_nudge)، متابعة المحادثة (lead_followup)، تأكيد الطلب في المحادثة (paid_note)،
      طلب التقييم، SMS استرداد السلة. تحديثات حالة الطلب والرد على كلام العميل مستثناة. الانتظار = تأجيل مش إلغاء (الشغلة بترجع pending لحد ما الهدوء يخلص،
      وصف الحملة بياخد hold_until) — «ندمج بدل ما نكدّس».
   ٢) تأكيد الطلب مرة واحدة: paid_note مابيتبعتش لو قالب الاستلام (fc_order_received / _v2 أو رسالة المرحلة pos_created الحرة) طلع لنفس الطلب خلال paidNoteDedupeMin.
   ٣) SMS «مندوب بديل» / «بنرتّب مندوب» مابتطلعش لو نافذة واتساب العميل مفتوحة ووصله تحديث واتساب عن نفس الطلب خلال courierSmsWaMin — التحديث بيوصله هناك ببلاش.
   ٤) سقف رسايل الطلب الواحد على واتساب: orderMsgCap (٤). المراحل الخفيفة («بنجهّز»، تأكيد المحادثة، «اتعيّن مندوب») بتتشال أول ما يبقى الباقي
      للمراحل الأساسية (orderMsgTail = مع المندوب + وصل + التقييم). التوصيل/الاسترداد/«جاهز للاستلام» عمرهم ما يتشالوا (فلوس ووصول).
═══════════════════════════════════════════════════════════════════════════ */

export const JOURNEY_GROUP = "journey";
export const JOURNEY_GROUP_AR = "رحلة العميل في النافذة: مفيش رسايل ورا بعض";

export const JOURNEY_DEFAULTS = Object.freeze({
  journeyBursts: true,        // المفتاح الرئيسي للقواعد الأربع
  burstHoldMin: 10,           // (١) بعد أي رسالة طالعة للعميل: الرسايل المبادِرة تستنى كام دقيقة
  burstHoldMaxMin: 120,       // (١) الشغلة المؤجّلة بتتلغي لو فضلت مستنية أكتر من كده من أول تأجيل
  paidNoteDedupeMin: 30,      // (٢) تأكيد الاستلام طلع خلال المدة دي ⇒ مفيش «وصلنا طلبك» تاني. صفر = مقفول
  courierSmsWaMin: 30,        // (٣) تحديث واتساب عن الطلب خلال المدة دي + النافذة مفتوحة ⇒ مفيش SMS «مندوب بديل». صفر = مقفول
  orderMsgCap: 4,             // (٤) أقصى رسايل واتساب للطلب الواحد. صفر = من غير سقف
  orderMsgTail: 3,            // (٤) المراحل الأساسية اللي بنحجز لها مكان (مع المندوب، وصل، التقييم)
});
export const JOURNEY_NUMS = Object.freeze({
  burstHoldMin: [0, 120], burstHoldMaxMin: [10, 720], paidNoteDedupeMin: [0, 240], courierSmsWaMin: [0, 240], orderMsgCap: [0, 12], orderMsgTail: [0, 6],
});
export const JOURNEY_BOOLS = Object.freeze(["journeyBursts"]);
const clamp = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, n)) : d; };
/* settings.waBot ⇒ القيم النهائية (الغلط ⇒ الافتراضي، بره الحدود ⇒ للحد). المفاتيح مسطّحة زي FU1. */
export function journeyCfg(x = {}) {
  const src = x && typeof x === "object" ? x : {};
  const out = {};
  for (const k of JOURNEY_BOOLS) out[k] = src[k] !== false;
  for (const [k, lim] of Object.entries(JOURNEY_NUMS)) out[k] = Math.round(clamp(src[k], lim, JOURNEY_DEFAULTS[k]));
  if (out.orderMsgTail > out.orderMsgCap) out.orderMsgTail = out.orderMsgCap;
  return out;
}
const S = (type, ar, help, extra = {}) => Object.freeze({ group: JOURNEY_GROUP, type, ar, help, ...extra });
const N = (k, ar, help, unit) => S("number", ar, help, { min: JOURNEY_NUMS[k][0], max: JOURNEY_NUMS[k][1], unit });
export const JOURNEY_SCHEMA = Object.freeze({
  journeyBursts: S("boolean", "مفيش رسايل ورا بعض (القواعد الأربع)",
    "بعد أي رسالة للعميل الرسايل المبادِرة (حملة / متابعة / حارس النافذة / «أنا معك» / تأكيد المحادثة / طلب التقييم / SMS السلة) بتستنى شوية بدل ما تيجي ورا بعض — بتتأجّل مش بتتلغي. وتأكيد الطلب مرة واحدة، ومفيش SMS «مندوب بديل» لو واتساب بيوصّل، وسقف لرسايل الطلب الواحد. تحديثات الطلب والرد على كلام العميل مش بيتأثروا."),
  burstHoldMin: N("burstHoldMin", "بعد أي رسالة للعميل: الرسايل المبادِرة تستنى", "من آخر رسالة طالعة له (واتساب أو SMS، من أي نظام). ٣ رسايل في دقيقتين كانت المشكلة — ١٠ دقايق بتفكّها من غير ما تمنع رسالة. صفر = مقفول.", "دقيقة"),
  burstHoldMaxMin: N("burstHoldMaxMin", "…وتتلغي لو فضلت مستنية أكتر من", "من أول تأجيل. عميل بيكلّمنا طول الوقت = مش محتاج رسالة مبادِرة أصلاً.", "دقيقة"),
  paidNoteDedupeMin: N("paidNoteDedupeMin", "تأكيد الطلب في المحادثة: مش لو قالب الاستلام طلع خلال", "«وصلنا طلبك رقم … نبدأ نجهّزه» كانت بتيجي بعد «استلمنا طلبك وتم الدفع» بدقايق (٨ من ٢٢ طلب يوم ١٦/١٠). صفر = مقفول.", "دقيقة"),
  courierSmsWaMin: N("courierSmsWaMin", "SMS «مندوب بديل»: مش لو واتساب وصّل تحديث عن الطلب خلال", "ولازم نافذة واتساب العميل تكون مفتوحة (كلّمنا آخر ٢٤ ساعة) — ساعتها تحديثات الطلب بتوصله هناك ببلاش. ١٣ من ١٣ يوم ١٦/١٠ كانت مكررة. صفر = مقفول.", "دقيقة"),
  orderMsgCap: N("orderMsgCap", "أقصى رسايل واتساب للطلب الواحد", "كل رسايل الطلب (قوالب وحرة): استلمنا، بنجهّز، مع المندوب، وصل، التقييم… التوصيل والاسترداد و«جاهز للاستلام» عمرهم ما يتشالوا. صفر = من غير سقف.", "رسالة"),
  orderMsgTail: N("orderMsgTail", "…منهم محجوز للمراحل الأساسية", "مع المندوب + وصل + التقييم = ٣. المراحل الخفيفة («بنجهّز»، «اتعيّن مندوب»، تأكيد المحادثة) بتتشال أول ما الباقي يبقى بالعدد ده.", "رسالة"),
});

/* ── مين «مبادِر» ─────────────────────────────────────────────────────────── */
/* مفاتيح رسايل البوت المبادِرة (wabotrun sendOwnX key) ⇒ guardSend proactive:true */
export const PROACTIVE_KEYS = Object.freeze(new Set(["paid_note", "window_keep", "lead_followup", "reply_followup", "lead_nudge", "review_ask", "review_stars_ask"]));
/* شغلات wa_bot_jobs اللي بتتأجّل (مش بتتلغي) طول ما الهدوء شغّال */
export const PROACTIVE_JOB_KINDS = Object.freeze(["paid_note", "window_keep", "lead_followup", "reply_followup", "assist_nudge"]);
/* مصادر guardSend اللي سقف الطلب مابيلمسهاش (رد على كلام العميل / الفريق / تجربة) */
export const CAP_EXEMPT_SOURCES = Object.freeze(new Set(["reply", "team", "test"]));

/* ── القرارات (صافية) ─────────────────────────────────────────────────────── */
/* (١) هدوء بعد آخر رسالة طالعة: ⇒ { hold, until } */
export function holdDecision({ lastOut, now = Date.now(), holdMin }) {
  const h = Number(holdMin) || 0;
  if (!(h > 0) || !lastOut) return { hold: false, until: null };
  const t = lastOut instanceof Date ? lastOut.getTime() : Date.parse(String(lastOut));
  if (!Number.isFinite(t)) return { hold: false, until: null };
  const until = t + h * 60_000;
  return until > now ? { hold: true, until: new Date(until) } : { hold: false, until: null };
}
/* (١) شغلة مؤجّلة: لسه ينفع تتأجّل تاني ولا خلاص؟ firstHold = أول مرة اتأجّلت (ISO أو ms) */
export function deferDecision({ until, firstHold, now = Date.now(), maxMin }) {
  const u = until instanceof Date ? until.getTime() : Date.parse(String(until));
  const f0 = firstHold == null ? now : (firstHold instanceof Date ? firstHold.getTime() : Number.isFinite(Number(firstHold)) ? Number(firstHold) : Date.parse(String(firstHold)));
  const f = Number.isFinite(f0) ? f0 : now;
  if (!Number.isFinite(u)) return { defer: false, expired: false };
  if (u - f > (Number(maxMin) || 0) * 60_000) return { defer: false, expired: true, firstHold: new Date(f) };
  return { defer: true, expired: false, until: new Date(u), firstHold: new Date(f) };
}
/* (٤) سقف رسايل الطلب — المراحل زي ما whatsapp.js/notify.js بيسمّوها (stage) */
export const ORDER_ALWAYS_STAGES = Object.freeze(new Set(["delivered", "rejected_refunded", "refund_failed", "ready", "pickup_ready", "table_ready", "cancelled", "loyalty_status"]));
export const ORDER_LOW_STAGES = Object.freeze(new Set(["accepted", "paid_note", "courier_assigned", "courier_requested", "handed"]));
export function orderCapDecision({ sent, stage, cap, tail }) {
  const c = Number(cap) || 0;
  if (!(c > 0)) return { ok: true };
  const n = Math.max(0, Number(sent) || 0), st = String(stage || "");
  if (ORDER_ALWAYS_STAGES.has(st)) return { ok: true };
  if (ORDER_LOW_STAGES.has(st) && n >= Math.max(0, c - (Number(tail) || 0))) return { ok: false, reason: "order_cap_low" };
  if (n >= c) return { ok: false, reason: "order_cap" };
  return { ok: true };
}

/* ── SQL (المنفّذين بيمرّروها لـpool.query / q) ──────────────────────────── */
/* آخر رسالة طالعة للعميل من أي نظام (واتساب اتقبلت + SMS اتبعتت) في آخر ٦ ساعات. $1 = الجوال */
export const LAST_OUT_SQL = `SELECT max(t) AS last_out FROM (
    SELECT max(created_at) AS t FROM wa_messages WHERE phone_norm=$1 AND direction='out' AND COALESCE(status,'') NOT IN ('failed','skipped') AND COALESCE(source,'api') <> 'history' AND created_at > NOW() - INTERVAL '6 hours'
    UNION ALL
    SELECT max(at) FROM sms_log WHERE phone_norm=$1 AND status='sent' AND at > NOW() - INTERVAL '6 hours') x`;
/* (٤) رسايل واتساب الطالعة عن الطلب ده (قوالب + حرة، اللي ميتا قبلتها). $1 = رقم الطلب */
export const ORDER_SENT_SQL = `SELECT count(*)::int AS n FROM wa_messages WHERE order_no=$1 AND direction='out' AND COALESCE(status,'') NOT IN ('failed','skipped')`;
/* (٢) قالب الاستلام (أو رسالته الحرة) طلع لنفس الطلب خلال $2 دقيقة؟ $1 = رقم الطلب */
export const PAID_CONFIRM_SQL = `SELECT 1 FROM wa_messages WHERE order_no=$1 AND direction='out' AND COALESCE(status,'') NOT IN ('failed','skipped')
    AND (template LIKE 'fc_order_received%' OR stage IN ('pos_created','paid')) AND created_at > NOW() - make_interval(mins => $2::int) LIMIT 1`;
/* (٣) نافذة واتساب مفتوحة + تحديث واتساب عن الطلب خلال $3 دقيقة. $1 = رقم الطلب، $2 = الجوال */
export const WA_COVERS_ORDER_SQL = `SELECT 1 WHERE EXISTS (SELECT 1 FROM wa_messages WHERE phone_norm=$2 AND direction='in' AND COALESCE(source,'api') <> 'history' AND created_at > NOW() - INTERVAL '24 hours')
    AND EXISTS (SELECT 1 FROM wa_messages WHERE order_no=$1 AND direction='out' AND COALESCE(status,'') NOT IN ('failed','skipped') AND created_at > NOW() - make_interval(mins => $3::int))`;
/* عمود الطابور: الصف المحجوز بالهدوء (wasender.js) */
export const QUEUE_HOLD_DDL = "ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ";

/* قراءة واحدة مشتركة: ⇒ Date (لحد إمتى) أو null. query = (sql, params) ⇒ rows[] | null. قراءة فشلت ⇒ hold دقيقة واحدة (الرسالة المبادِرة مش مستعجلة). */
export async function holdUntil(query, { phone, cfg, now = Date.now() }) {
  const jc = journeyCfg(cfg);
  if (!jc.journeyBursts || !(jc.burstHoldMin > 0)) return null;
  let rows = null;
  try { rows = await query(LAST_OUT_SQL, [String(phone || "")]); } catch { rows = null; }
  if (rows === null) return new Date(now + 60_000);
  const d = holdDecision({ lastOut: rows && rows[0] ? rows[0].last_out : null, now, holdMin: jc.burstHoldMin });
  return d.hold ? d.until : null;
}
