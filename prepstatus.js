/* ═══════════════════════════════════════════════════════════════════════════
   PREP STATUS — معنى ضغطات الكاشير، في مكان واحد (عمر، ١٠/١٠/٢٠٢٦).

   تعريفات المالك (المرجع):
     • الكاشير يضغط «جاهز»           ⇒ المطبخ خلّص التحضير.
     • الكاشير يضغط «تم التوصيل»     ⇒ على طلب التوصيل: **سلّم الطلب للمندوب**
                                        (مش إن العميل استلم).
                                       على طلب الاستلام/الطاولة: العميل استلم /
                                        الطلب اتقدّم.
     • وقت التحضير = من لحظة **قبول** الطلب لحد «جاهز». الحد ٣٠ دقيقة،
       وتنبيه عند ٢٥.
     • «وصل للعميل» في التوصيل = حالة المندوب (الشركة / رابط المندوب الخارجي)،
       مش ضغطة الكاشير.

   اللي لقيناه في الداتا (آخر ١٤ يوم، ٨١ طلب):
     • الكاشير بيضغط «جاهز» و«تم التوصيل» على نقطة البيع **ورا بعض في نفس
       الثواني** (٦٤ من ٦٥ طلب توصيل الفرق أقل من دقيقة). الكنس كان بيقرا
       **آخر** ويبهوك بس، فبيلاقي «delivered» ومايلاقيش «ready» ⇒ وقت الجهوزية
       اتسجّل في ٦ من ٦٦ طلب توصيل بس، ووقت التسليم للمندوب ماكانش بيتسجّل خالص.
     • accepted_at كان بيتملى من backfill وقت الإقلاع بس — طلبات اليوم NULL.

   الموديول ده صافي (من غير قاعدة بيانات): بيطلّع محطات نقطة البيع من **كل**
   الويبهوكات بوقت وصولها الحقيقي، وبيحكم على مهلة التحضير.
═══════════════════════════════════════════════════════════════════════════ */

const ms = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };
const isoOf = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const r1 = (n) => Math.round(Number(n) * 10) / 10;

export const PREP_DEFAULTS = Object.freeze({ prepMinutes: 25, prepBreachMinutes: 30 });

/* settings.delivery.sla.prepMinutes / prepBreachMinutes — بيتعدّلوا من لوحة
   «التوصيل» مع باقي مهل الطلب (deliverycontrol.js ORDER_SLA_FIELDS). */
export function prepCfg(sla = {}) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 1 && x <= 240 ? x : d; };
  const max = n(sla.prepBreachMinutes, PREP_DEFAULTS.prepBreachMinutes);
  let warn = n(sla.prepMinutes, PREP_DEFAULTS.prepMinutes);
  if (warn >= max) warn = Math.max(1, max - 5);   // التنبيه لازم يسبق الحد
  return { warnMin: warn, maxMin: max };
}

/* قرار عمر (١٠/١٠ مساءً): مخالفة التحضير **مش SMS** — إشعار في البوابة بتفاصيل
   الطلب وبصوت. الـSMS للإدارة مقفول افتراضياً، وبيتفتح من اللوحة
   (settings.delivery.prepBreachSms = true). */
export const prepSmsEnabled = (settings = {}) => (((settings || {}).delivery || {}).prepBreachSms === true);

/* ملخص أصناف قصير للإشعار: «٢× مشاوي مشكل، رز بخاري +٢» */
export function itemsSummary(items = [], max = 3) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && x.name && x.kind !== "component");
  const txt = list.slice(0, max).map((x) => `${Number(x.qty) > 1 ? `${Number(x.qty)}× ` : ""}${String(x.name).slice(0, 28)}`).join("، ");
  return list.length > max ? `${txt} +${list.length - max}` : txt;
}

/* ── محطات نقطة البيع من الويبهوكات ──────────────────────────────────────
   rows = [{received_at, approval, order_status}] بأي ترتيب.
   acceptedAt = أول ويبهوك «مقبول» (أو أي حالة بعده — القبول حصل قبلها أكيد)
   readyAt    = أول ويبهوك فيه ready؛ ولو الكاشير قفل الطلب من غير «جاهز»
                يبقى وقت القفل (الأكل كان جاهز وقتها بالتعريف) — readyBasis
                بيقول أنهي واحد.
   closedAt   = أول order_status=completed («تم التوصيل» على نقطة البيع).
   rejected   = الكاشير رفض/لغى. */
export function posMilestones(rows = []) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((w) => ({ t: ms(w && w.received_at), a: String((w && w.approval) || "").toLowerCase(), o: String((w && w.order_status) || "").toLowerCase() }))
    .filter((w) => w.t != null)
    .sort((x, y) => x.t - y.t);
  const first = (f) => { const w = list.find(f); return w ? new Date(w.t).toISOString() : null; };
  const acceptLike = (w) => w.a.includes("accept") || w.a.includes("ready") || w.a.includes("preparing") || w.a.includes("processing")
    || (w.a.includes("deliver") && !w.a.includes("reject"));
  const closedAt = first((w) => w.o === "completed");
  const readySignal = first((w) => w.a.includes("ready"));
  const readyAt = readySignal || closedAt;
  return {
    acceptedAt: first(acceptLike),
    readyAt,
    readyBasis: readySignal ? "pos_ready" : closedAt ? "pos_closed" : null,
    closedAt,
    rejected: list.some((w) => w.a.includes("reject") || w.a.includes("cancel")),
  };
}

/* ── نهاية التحضير لطلب ─────────────────────────────────────────────────
   «جاهز» لو اتسجّلت؛ وإلا أول دليل إن الأكل خرج: تسليم للمندوب / المندوب
   استلم / العميل استلم. من غير أي دليل = التحضير لسه شغّال. */
export function prepEnd(o = {}) {
  const c = [
    ["ready", o.pos_ready_at ?? o.readyAt],
    ["handed", o.handed_at ?? o.handedAt],
    ["picked", o.picked_at ?? o.pickedAt],
    ["collected", o.collected_at ?? o.collectedAt],
  ].map(([basis, v]) => ({ basis, t: ms(v) })).filter((x) => x.t != null);
  if (!c.length) return null;
  const ready = c.find((x) => x.basis === "ready");
  const best = ready || c.sort((a, b) => a.t - b.t)[0];
  return { at: new Date(best.t).toISOString(), basis: best.basis };
}

const CLOSED = new Set(["delivered", "collected", "rejected_refunded", "refund_failed", "expired", "cancelled"]);

/* ── الحكم على مهلة التحضير ──────────────────────────────────────────────
   level 0 = تمام · 1 = تنبيه (≥ warnMin) · 2 = مخالفة علينا (≥ maxMin).
   الطلب المسبق: المهلة من موعده (المطبخ مايبدأش قبله) لو الموعد بعد القبول. */
export function prepCheck(o = {}, cfg = {}, now = Date.now()) {
  const c = { warnMin: PREP_DEFAULTS.prepMinutes, maxMin: PREP_DEFAULTS.prepBreachMinutes, ...cfg };
  let start = ms(o.accepted_at ?? o.acceptedAt);
  const none = { level: 0, code: null, minutes: null, startAt: null, deadlineAt: null, endAt: null, basis: null, overMin: 0, open: false };
  if (start == null) return none;
  const sched = ms(o.scheduled_for ?? o.scheduledFor);
  if (sched != null && sched > start) start = sched;
  const end = prepEnd(o);
  const closed = CLOSED.has(String(o.status || ""));
  if (!end && closed) return { ...none, startAt: new Date(start).toISOString() };   // اتقفل من غير أي إشارة — مانخترعش رقم
  const endT = end ? ms(end.at) : now;
  if (endT < start) return { ...none, startAt: new Date(start).toISOString(), endAt: end ? end.at : null, basis: end ? end.basis : null };
  const minutes = (endT - start) / 60_000;
  const deadlineAt = new Date(start + c.maxMin * 60_000).toISOString();
  const level = minutes >= c.maxMin ? 2 : minutes >= c.warnMin ? 1 : 0;
  return {
    level, code: level === 2 ? "prep_breach" : level === 1 ? "prep_late" : null,
    minutes: Math.floor(minutes), exactMin: r1(minutes),
    startAt: new Date(start).toISOString(), deadlineAt,
    endAt: end ? end.at : null, basis: end ? end.basis : null,
    overMin: level === 2 ? r1(minutes - c.maxMin) : 0,
    open: !end,
    message: level === 2 ? `التحضير عدّى ${c.maxMin} دقيقة من القبول (${Math.floor(minutes)} د)${end ? "" : " ولسه ما اتسجّلش «جاهز»"}`
      : level === 1 ? `التحضير وصل ${Math.floor(minutes)} دقيقة — الحد ${c.maxMin}` : null,
    action: level ? "mark_ready" : null,
  };
}

/* اللي البوابة بتعرضه على الكارت: بداية التحضير + الحدّين. المؤقت الحي بيتحسب
   في المتصفح من startAt (السيرفر مابيبعتش «فاضل كام» عشان بصمة الطلب ماتتغيرش). */
export function prepState(o = {}, cfg = {}) {
  const c = { warnMin: PREP_DEFAULTS.prepMinutes, maxMin: PREP_DEFAULTS.prepBreachMinutes, ...cfg };
  let start = ms(o.accepted_at ?? o.acceptedAt);
  if (start == null) return null;
  const sched = ms(o.scheduled_for ?? o.scheduledFor);
  if (sched != null && sched > start) start = sched;
  const end = prepEnd(o);
  const mins = end ? r1((ms(end.at) - start) / 60_000) : null;
  return {
    startAt: new Date(start).toISOString(),
    endAt: end ? end.at : null,
    basis: end ? end.basis : null,
    minutes: mins != null && mins >= 0 ? mins : null,
    warnMin: c.warnMin, maxMin: c.maxMin,
    late: mins != null && mins >= c.maxMin,
  };
}

/* ── نصوص العميل (لهجة بيضاء) ────────────────────────────────────────── */
export const READY_TEXT = Object.freeze({
  pickup: (o) => `فريش كاتس: طلبك ${o.order_no} جاهز للاستلام من الفرع 📍`,
  table: (o) => `فريش كاتس: طلبك جاهز وسيُقدَّم لك على الطاولة ${o.table_no} 🍽`,
});
export const orderKind = (o = {}) => (Number(o.table_no) > 0 ? "table" : o.option === "delivery" ? "delivery" : "pickup");
/* «delivered» عندنا حالة واحدة لثلاث نهايات مختلفة — النص لازم يقول اللي حصل فعلاً. */
export function closedText(o = {}, reviewUrl = "") {
  const tail = reviewUrl ? ` قيّم تجربتك: ${reviewUrl}` : "";
  const k = orderKind(o);
  if (k === "table") return `فريش كاتس: تم تقديم طلبك — بالهنا والشفا 🌟${tail}`;
  if (k === "pickup") return `فريش كاتس: تم استلام طلبك — بالهنا والشفا 🌟${tail}`;
  return `فريش كاتس: تم توصيل طلبك — بالهنا والشفا 🌟${tail}`;
}

/* ── المندوب الخارجي: «العميل استلم» بدري قوي؟ ──────────────────────────
   مفيش شركة بتأكّد، فالضغطة هي المصدر الوحيد. لو اتضغطت بعد الاستلام بدقايق
   أقل من نص مدة المشوار (وأقل حاجة ٥ د) بنطلب تأكيد صريح — عشان «استلم»
   و«وصّل» مايتضغطوش ورا بعض وقت التسليم للمندوب (حصل في ٢ من ٣). */
export function externalTooSoon({ pickedAt, expectedMin = null, now = Date.now() } = {}) {
  const p = ms(pickedAt);
  if (p == null) return { tooSoon: false, minGap: 0, sincePickedMin: null };
  const minGap = Math.max(5, Math.round((Number(expectedMin) || 0) / 2));
  const since = (now - p) / 60_000;
  return { tooSoon: since < minGap, minGap, sincePickedMin: r1(since) };
}

/* ── دعوة التقييم: «بعد ما العميل يستلم بنص ساعة» ───────────────────────
   deliveredAt = وقت الحالة delivered. لو التوصيل **مش مؤكّد من المندوب نفسه**
   (خارجي من غير رابطه) بنفترض إن المشوار خد على الأقل rideFloorMin من
   الاستلام — فالرسالة ماتوصلش والعميل لسه مستني. */
export function reviewDueAt({ deliveredAt, askAfterMin = 30, option = "delivery", createdAt = null,
  pickedAt = null, courierConfirmed = true, rideFloorMin = 30 } = {}) {
  const d = ms(deliveredAt) ?? Date.now();
  const mins = Math.min(720, Math.max(1, Number(askAfterMin) || 30));
  let due = d + mins * 60_000;
  if (option === "pickup" && ms(createdAt) != null) due = Math.max(due, ms(createdAt) + Math.max(60, mins) * 60_000);
  if (option === "delivery" && !courierConfirmed && ms(pickedAt) != null) {
    due = Math.max(due, ms(pickedAt) + (Number(rideFloorMin) + mins) * 60_000);
  }
  return new Date(due);
}

/* ── SQL: ويبهوكات طلب واحد ── */
export const WEBHOOKS_SQL = `SELECT received_at,
         payload->'resource'->'statuses_slugs'->>'approval_status' AS approval,
         payload->'resource'->'statuses_slugs'->>'order_status' AS order_status
    FROM tsp_webhooks
   WHERE payload->'resource'->'order'->>'id' = $1
   ORDER BY received_at`;

/* سجل مخالفات التحضير (علينا): صف لكل طلب عدّى الحد. */
export const PREP_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS shop_prep_breaches (
    order_no TEXT PRIMARY KEY,
    option TEXT,
    accepted_at TIMESTAMPTZ NOT NULL,
    deadline_at TIMESTAMPTZ NOT NULL,
    ready_at TIMESTAMPTZ,
    ready_basis TEXT,
    prep_min NUMERIC,
    over_min NUMERIC,
    max_min NUMERIC NOT NULL DEFAULT 30,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL DEFAULT 'live',
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    alerted_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS shop_prep_breaches_time_idx ON shop_prep_breaches(accepted_at DESC)`,
]);

export { isoOf as _isoOf };
