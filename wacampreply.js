/* ═══════════════════════════════════════════════════════════════════════════
   📣 CR2 (١٦/١٠) — «أبغى أطلب» على رسالة حملة واتساب ⇒ العرض اللي وصلها هي، مش رد «أبي أطلب» العام

   الحالة الحقيقية (١٦/١٠ 17:18، جوال 59•••58): وصلتها حملة باقات التجمّع ١٥/١٠ (fc_frame_limited_img، رابط wa-1015-packs-a)،
   وضغطت زر «أبغى أطلب» تحت الرسالة ⇒ البوت رد بالرد العام (how_to_order) ورابط البوكسات wab-boxes — العرض اللي ردّت عليه ماتذكرش،
   والضغطة اتحسبت على رابط البوت مش على الحملة.

   دلوقتي: ضغطة «أبغى أطلب» (context.id = wamid رسالة الحملة) أو نية طلب مكتوبة (تصنيف «order») ورسالة حملة Cloud وصلت للرقم في
   آخر campaignReplyHours ⇒ سطر قصير بالعرض (اسمه + سعره + آخر يوم لو فيه) + رابط الحملة نفسها لنفس المستلم (‎/l/<slug>-<code>‎ ⇒
   الضغطة بتتعد على الحملة وعلى المستلم زي زر القالب بالظبط) + «تبي نجهزه لك هنا؟».

   مابيلمسش:
     • حملة «طبقك المفضل» (fc_frame_ask_* بقيم لكل مستلم + vars.fav) ⇒ FD1 (سلة جاهزة بالسعر محسوب تاني). FD1 رفض (العرض اتغيّر) ⇒ الرد العام
       زي قبل كده — مانرجعش لحملة أقدم.
     • «متابعة اللي ردّ» (FU1: rf:yes / followup_yes)، نجوم التقييم، تابع طلبك، التحويلات — مش مفتاح «order» أصلاً أو ليها طريقها.
   العرض بيتسقط (⇒ الرد العام) لو: آخر يوم عدّى، الرابط موقوف/مش موجود، البوكس المربوط اتشال، قيمة فيها {token} ماتبدّلتش، مفيش اسم عرض.
   البوكس المربوط سعره الحي غير سعر الرسالة (أو البوكسات ماتحمّلتش) ⇒ العرض من غير رقم (عمرنا ما بنقول سعر غير الحقيقي).
═══════════════════════════════════════════════════════════════════════════ */
import { riyadhDay, latinDigits } from "./wafavpick.js";

const nz = (v) => (v == null ? "" : String(v));
export const CR_DEFAULTS = Object.freeze({ campaignReply: true, campaignReplyHours: 72 });

/* آخر صف حملة Cloud اتبعت للرقم (أو صف الرسالة اللي اتضغط زرها بالظبط: $3 = context.id). أي حملة — حتى «طبقك المفضل» — عشان
   الأحدث هو اللي بيتقرا (لو هو «طبقك المفضل» ⇒ FD1 بتاعته، مش حملة أقدم). فشل الإرسال عند ميتا (cloud_status failed) مايتحسبش. */
export const CR_SQL = Object.freeze({
  lastRow: `SELECT q.id, q.job_id, q.sent_at, q.wamid, q.vars, q.link_code, j.cloud_template, j.cloud_vars, j.link_slug, j.name AS job_name,
                   l.target_type, l.target_id, l.active AS link_active
              FROM wa_send_queue q JOIN wa_send_jobs j ON j.id = q.job_id LEFT JOIN cms_links l ON l.slug = j.link_slug
             WHERE q.phone_norm = $1 AND q.status = 'sent' AND COALESCE(q.cloud_status,'') <> 'failed' AND q.wamid IS NOT NULL
               AND COALESCE(j.channel,'wa_cloud') = 'wa_cloud' AND q.sent_at > NOW() - make_interval(hours => $2::int)
               AND ($3::text IS NULL OR q.wamid = $3::text)
             ORDER BY q.sent_at DESC, q.id DESC LIMIT 1`,
  /* نية مكتوبة: طلبت بعد الحملة (موقع) ⇒ مش رد على العرض */
  orderedSince: `SELECT 1 FROM shop_orders WHERE phone_norm = $1 AND created_at > $2::timestamptz AND status NOT IN ('expired','pending_payment') AND NOT COALESCE(is_test,false) LIMIT 1`,
});

/* «الجمعة 16 أكتوبر» / «اليوم الجمعة ١٦ أكتوبر» / «حتى 15 أكتوبر» ⇒ "YYYY-MM-DD" (سنة الرياض الحالية؛ يناير وإحنا في ديسمبر = السنة الجاية). مش مفهوم ⇒ null */
const MONTHS = [["يناير"], ["فبراير"], ["مارس"], ["أبريل", "ابريل", "إبريل"], ["مايو"], ["يونيو"], ["يوليو"], ["أغسطس", "اغسطس"], ["سبتمبر"], ["أكتوبر", "اكتوبر"], ["نوفمبر"], ["ديسمبر"]];
export function untilDay(text, now = Date.now()) {
  const s = latinDigits(nz(text));
  let mi = -1, d = 0;
  for (const m of s.matchAll(/(\d{1,2})\s*(?:من\s+)?(\S+)/g)) {      // أول «رقم + شهر» في النص
    const word = m[2].replace(/[^\p{L}]/gu, ""), k = MONTHS.findIndex((names) => names.includes(word));
    if (k >= 0 && Number(m[1]) >= 1 && Number(m[1]) <= 31) { mi = k; d = Number(m[1]); break; }
  }
  if (mi < 0) return null;
  const today = riyadhDay(Number(now));
  let y = Number(today.slice(0, 4));
  const curM = Number(today.slice(5, 7)) - 1;
  if (mi < curM - 6) y += 1;           // «5 يناير» في ديسمبر
  else if (mi > curM + 6) y -= 1;      // «28 ديسمبر» في يناير (عدّى)
  return `${y}-${String(mi + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const cleanLine = (v) => nz(v).replace(/\s+/g, " ").replace(/[.،,:؛\s]+$/, "").trim();
const TOKEN_RE = /\{[a-z_.]+\}|\{\{\d+\}\}/;

/* صف الحملة ⇒ العرض اللي هيتقال. row = صف CR_SQL.lastRow · bundles = ‎/api/shop/bundles‎ الحي (للبوكس المربوط) · store = أصل الروابط
   ⇒ { ok:true, title, price|null, until|null, untilDay, slug, url, jobId, queueId, sentAt, priceDropped? } أو { ok:false, why } */
export function campaignReplyOffer(row, { now = Date.now(), bundles = null, store = "https://freshcuts.sa" } = {}) {
  if (!row) return { ok: false, why: "no_campaign" };
  const cv = row.cloud_vars && typeof row.cloud_vars === "object" ? row.cloud_vars : {};
  const rv = row.vars && typeof row.vars === "object" ? row.vars : {};
  const tpl = nz(row.cloud_template);
  /* «طبقك المفضل» ⇒ FD1 (العرض لكل مستلم بسعره وتوصيله محسوب تاني) — هنا لأ */
  if (/^fc_frame_ask_/.test(tpl) && cv.perRecipient === true && rv.fav) return { ok: false, why: "fav_campaign" };
  const perRow = cv.perRecipient === true || cv.profileVars === true;
  const values = { ...(cv.values && typeof cv.values === "object" ? cv.values : {}), ...(perRow && rv.cloud && rv.cloud.values && typeof rv.cloud.values === "object" ? rv.cloud.values : {}) };
  const title = cleanLine(values["offer.title"]);
  if (!title) return { ok: false, why: "no_title" };
  if (TOKEN_RE.test(title) || TOKEN_RE.test(nz(values["offer.price"])) || TOKEN_RE.test(nz(values["offer.untilText"]))) return { ok: false, why: "token" };
  const slug = nz(row.link_slug).trim();
  if (!slug) return { ok: false, why: "no_link" };
  if (row.link_active !== true) return { ok: false, why: "link_off" };
  const untilText = cleanLine(values["offer.untilText"]);
  const uDay = untilText ? untilDay(untilText, now) : null;
  if (uDay && riyadhDay(Number(now)) > uDay) return { ok: false, why: "expired" };
  const p = Number(latinDigits(nz(values["offer.price"])).replace(/[^\d.]/g, ""));
  let price = Number.isFinite(p) && p > 0 ? p : null, priceDropped = false;
  /* رابط بيفتح بوكس بعينه: لازم يكون لسه في البوكسات الحيّة، وسعره = سعر الرسالة (غير كده/مانعرفش ⇒ من غير رقم) */
  if (row.target_type === "box" && row.target_id) {
    const list = Array.isArray(bundles) ? bundles : [];
    const b = list.find((x) => x && (nz(x.slug) === nz(row.target_id) || nz(x.id) === nz(row.target_id)));
    if (list.length && (!b || b.active === false || b.available === false)) return { ok: false, why: "box_gone" };
    if (price != null && (!b || !(Math.abs(Number(b.price) - price) < 0.01))) { price = null; priceDropped = true; }
  }
  const code = nz(row.link_code).trim();
  const url = `${nz(store).replace(/\/+$/, "")}/l/${slug}${code ? `-${code}` : ""}`;
  const sentAt = row.sent_at instanceof Date ? row.sent_at.toISOString() : nz(row.sent_at) || null;
  return { ok: true, title, price, until: untilText || null, untilDay: uDay, slug, url, jobId: Number(row.job_id) || null, queueId: Number(row.id) || null,
    wamid: row.wamid || null, sentAt, ...(priceDropped ? { priceDropped: true } : {}) };
}

/* القراءة من القاعدة: ⇒ { row, offer } أو { offer: {ok:false, why} } — أي خطأ ⇒ why "db" (الرد العام) */
export function makeCampaignReply({ pool }) {
  async function lastCampaign(phone, { hours = 72, wamid = null, typed = false, now = Date.now(), bundles = null, store } = {}) {
    if (!/^5\d{8}$/.test(nz(phone))) return { offer: { ok: false, why: "bad_phone" } };
    let row = null;
    try { row = ((await pool.query(CR_SQL.lastRow, [phone, Math.max(1, Math.min(168, Math.round(Number(hours) || 72))), wamid ? nz(wamid).slice(0, 200) : null])).rows || [])[0] || null; }
    catch (e) { console.error("[wabot] campaign reply:", e.message); return { offer: { ok: false, why: "db" } }; }
    if (!row) return { offer: { ok: false, why: wamid ? "not_campaign_msg" : "no_campaign" } };
    const offer = campaignReplyOffer(row, { now, bundles, store });
    if (offer.ok && typed && offer.sentAt) {
      try { if (((await pool.query(CR_SQL.orderedSince, [phone, offer.sentAt])).rows || []).length) return { row, offer: { ok: false, why: "ordered_since" } }; }
      catch (e) { console.error("[wabot] campaign reply ordered:", e.message); return { row, offer: { ok: false, why: "db" } }; }
    }
    return { row, offer };
  }
  return { lastCampaign };
}
