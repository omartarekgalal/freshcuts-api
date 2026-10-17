/* ═══════════════════════════════════════════════════════════════════════════
   🏅 أداء الفريق (KP1 — عمر ١٧/١٠: «لازم يبان أداء المدير والكاشير في كل حاجة بيعملوها ويتحطلهم KPIs كاملة»)

   لكل موظف في دليل الفريق (settings.portal.staff: كاشير / مدير / مطبخ + المالك) ولكل يوم تشغيلي (٠٤:٠٠ → ٠٤:٠٠ الرياض، bizday.js):
     • الطلبات: «شفته» (portal_ack_by/at) وزمنه من الدفع · «سلّمت للمندوب» (handed_by/at) وزمنه من «جاهز» · طلب/إلغاء مندوب من البوابة
       (portal_audit) · المندوب الخارجي (dl_ext_runs.created_by) · حل مشاكل المندوب (dl_courier_incidents.resolved_by).
     • واتساب: تحويلات اتعلّم عليها «تم» (wa_handovers.acked_by) وزمن «تم» · أول رد على التحويل (wa_staff_replies) وزمنه · الردود · استلام
       وقفل المحادثات (wa_chat_owner_log) ونتايج القفل (wa_flow.last_close).
     • التقييمات الواطية (review_actions / reviews.resolved_by) وأول إجراء وزمنه · تنبيهات الفريق «تمام» (wa_team_notices.acked_by) ·
       نداءات الطاولات (table_calls.done_by) · ملاحظات العملاء على طلب شغّال (MJ1: wa_handovers.reason=order_note) · الشكاوى.
     • حضور البوابة: دفتر يومي جديد (portal_presence_day) بيتكتب مع كل كتابة حضور (wahandover.js) — دقايق «متوصّلة» ودقايق «ظاهرة».
       الأيام اللي قبل النشر «غير متاح» (portal_presence القديم بيحتفظ بآخر ظهور بس).
     • مستوى الفريق (مش لشخص): قبول نقطة البيع (من لحظة الدفع)، «جاهز» قصاد الهدف ووعد الوقت المتوقع (eta_shown)، طلب المندوب من «جاهز»، الاستلام،
       تنبيهات «البورتال مقفول» بالدور (wa_team_log)، المفتوح من كل حاجة، ونقطة البيع باسم كاشير تاب سينس (ts_orders.staff_name).
   القواعد: قراءة بس · كل مصدر لوحده (مصدر وقع ⇒ «غير متاح» للي بيعتمد عليه، مش صفر) · مفيش تخمين: اللي مالوش مصدر بيتقال صراحة
   (إقفال الكاش، ضغطات المطبخ على الـKDS) · الأهداف من اللوحة (settings.staffKpi.targets — المالك بس).
   المسارات: GET /api/cms/staff-kpis (اللوحة، قسم «الطلبات») · GET/POST /api/cms/staff-kpis/settings (الأهداف — القراءة للكل، الكتابة للمالك) ·
   GET /api/portal/kpis (البوابة: المدير يشوف الكل، الكاشير يشوف نفسه بس).
═══════════════════════════════════════════════════════════════════════════ */
import { bizRange, bizDay, bizDaySql, DAY_RE, DEFAULT_WEEK_START, daysBetween, spanDays, shiftDay } from "./bizday.js";
import { normStaffList } from "./portal-core.js";

const MIN = 60_000;
export const MAX_DAYS = 120;
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const pctOf = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/* ── الأهداف (settings.staffKpi.targets) ─────────────────────────────────────
   كلها بالدقايق. اللوحة بتعرض label وhint، والسيرفر بيقصّ القيم على [min, max]. */
export const TARGET_DEFS = Object.freeze([
  { key: "ackMin", def: 2, min: 1, max: 60, label: "«شفته» خلال", hint: "من لحظة دفع العميل (مش من فتح الدفع) لحد ما حد يضغط «شفته» على البوابة" },
  { key: "readyMin", def: 30, min: 5, max: 180, label: "«جاهز» خلال", hint: "من قبول نقطة البيع لحد «جاهز» (مستوى الفريق — الـKDS مابيسجّلش مين)" },
  { key: "handedMin", def: 5, min: 1, max: 60, label: "التسليم للمندوب خلال", hint: "من «جاهز» لحد «سلّمت الطلب للمندوب»" },
  { key: "courierMin", def: 5, min: 1, max: 60, label: "طلب المندوب خلال", hint: "من «جاهز» لحد أول شحنة اتطلبت (تلقائي أو من البوابة)" },
  { key: "handoverMin", def: 3, min: 1, max: 60, label: "الرد على تحويل واتساب خلال", hint: "من تحويل البوت لحد أول رد موظف، ولحد «تم»" },
  { key: "reviewMin", def: 60, min: 5, max: 1440, label: "أول إجراء على تقييم واطي خلال", hint: "من وصول التقييم لحد أول ملاحظة/اتصال/نتيجة" },
  { key: "noticeMin", def: 10, min: 1, max: 180, label: "«تمام» على تنبيه الفريق خلال", hint: "من ظهور التنبيه على البوابة لحد «تمام»" },
  { key: "tableCallMin", def: 3, min: 1, max: 30, label: "الرد على نداء الطاولة خلال", hint: "من ضغط العميل لحد «تم» في البوابة" },
  { key: "noteMin", def: 5, min: 1, max: 60, label: "ملاحظة العميل على طلبه خلال", hint: "MJ1: كارت «ملاحظة على طلب شغّال» لحد «تم»" },
]);
export function kpiTargets(settings) {
  const raw = (settings && settings.staffKpi && settings.staffKpi.targets) || {};
  const out = {};
  for (const d of TARGET_DEFS) {
    const v = Number(raw[d.key]);
    out[d.key] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, Math.round(v))) : d.def;
  }
  return out;
}
/* تحقق جسم POST الأهداف ⇒ { ok, targets } أو { ok:false, error, message } */
export function parseTargets(body, cur) {
  const next = { ...cur };
  for (const d of TARGET_DEFS) {
    if (body == null || body[d.key] === undefined) continue;
    const v = Number(body[d.key]);
    if (!Number.isFinite(v)) return { ok: false, error: "bad_target", message: `${d.label}: لازم رقم بالدقايق` };
    if (v < d.min || v > d.max) return { ok: false, error: "out_of_range", message: `${d.label}: بين ${d.min} و${d.max} دقيقة` };
    next[d.key] = Math.round(v);
  }
  return { ok: true, targets: next };
}

/* ── الفترة ─────────────────────────────────────────────────────────────── */
export function kpiRange(q = {}, now = new Date(), weekStart = DEFAULT_WEEK_START) {
  const r = bizRange({ preset: q.preset, from: q.from, to: q.to, now, weekStart });
  let from = r.from, to = r.to;
  if (spanDays(from, to) > MAX_DAYS) from = shiftDay(to, -(MAX_DAYS - 1));
  const r2 = from === r.from ? r : bizRange({ from, to, now, weekStart });
  return { preset: r.preset || "custom", label: r.label, from, to, days: spanDays(from, to), startUtc: r2.startUtc.toISOString(), endUtc: r2.endUtc.toISOString(), partial: r2.partial === true };
}

/* ── الدليل ─────────────────────────────────────────────────────────────── */
export const ROLE_ORDER = Object.freeze({ owner: 0, manager: 1, cashier: 2, kitchen: 3 });
export function directoryOf(settings) {
  const staff = normStaffList(settings && settings.portal && settings.portal.staff).map(({ id, name, role }) => ({ id, name, role, inDirectory: true }));
  return [{ id: "admin", name: "المالك", role: "owner", inDirectory: true }, ...staff];
}
/* قيم «مين» اللي مش أشخاص (السيرفر كتبها) — بتتجمّع على مستوى الفريق مش على حد */
export const AUTO_BY = Object.freeze(new Set(["استلمها موظف", "اترد على العميل", "closed", "البورتال اتفتح", "portal", "cashier", "manager", "dashboard", "تحويل أحدث"]));
export function makeIndex(directory) {
  const byId = new Map(directory.map((s) => [s.id, s])), byName = new Map(directory.map((s) => [s.name, s]));
  const extra = new Map();
  const of = ({ id = null, name = null } = {}) => {
    const n = name == null ? null : String(name).trim();
    if (id && byId.has(String(id))) return byId.get(String(id));
    if (n && byName.has(n)) return byName.get(n);
    if (!n || AUTO_BY.has(n)) return null;
    if (!extra.has(n)) extra.set(n, { id: `x:${n}`, name: n, role: null, inDirectory: false });
    return extra.get(n);
  };
  return { of, all: () => [...directory, ...extra.values()] };
}

/* ── SQL (قراية بس — كل استعلام معلّم عشان الاختبار يعرفه) ─────────────────
   $1 = بداية الفترة (UTC) · $2 = نهايتها (حصرية) · $3 = الهدف بالدقايق لو فيه. GROUPING SETS: الصف اللي day = NULL هو إجمالي الفترة
   (الوسيط على الفترة كلها، مش وسيط الوسيطات). */
const minsOf = (a, b) => `(EXTRACT(EPOCH FROM (${a} - ${b})) / 60.0)::float`;
const med = (expr) => `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expr})::float`;
const p90 = (expr) => `percentile_cont(0.9) WITHIN GROUP (ORDER BY ${expr})::float`;
const within = (a, b, p = "$3") => `count(*) FILTER (WHERE ${a} <= ${b} + make_interval(mins => ${p}::int))::int`;
const D = (col) => `${bizDaySql(col)}::text`;
const sets = (name, day) => `GROUP BY GROUPING SETS ((${name}), (${name}, ${day}))`;
/* لحظة الدفع = أول صف status='paid' في history (نفس ما بيعمله تقرير البوابة portal-reports.js) — مش created_at اللي بيتكتب عند الـcheckout
   قبل OTP وماي فاتورة (مراجعة ١٧/١٠: الفرق وسيطه ٠٫٨ د وبيوصل ٢١ د، وكان بيتحسب على الموظف). لو مفيش صف «paid» (مسار من غير دفع أونلاين) ⇒ created_at.
   الـregex بيحمي الـcast من صف at مش تاريخ. اليوم التشغيلي والنافذة ($1/$2) لسه على created_at عشان الطلب يفضل في يومه. */
const TS_OK = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'`;
const PAID_JOIN = `LEFT JOIN LATERAL (SELECT min((h->>'at')::timestamptz) AS paid_at
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.history)='array' THEN o.history ELSE '[]'::jsonb END) h
      WHERE h->>'status'='paid' AND (h->>'at') ~ ${TS_OK}) pd ON TRUE`;
export const PAID_AT = `COALESCE(pd.paid_at, o.created_at)`;

export const HO_KIND = `CASE WHEN reason = 'order_note' THEN 'note' WHEN reason IN ('review_low','review_note') THEN 'review'
  WHEN reason IN ('complaint','order_late','order_issue','problem','order_change','allergy_severe') THEN 'complaint' ELSE 'other' END`;
export const SQL = Object.freeze({
  audit: `/*kpi:audit*/ SELECT staff_id, staff_name, role, action, ${D("at")} AS day,
      count(*)::int AS n, count(*) FILTER (WHERE ok IS DISTINCT FROM false)::int AS ok
    FROM portal_audit WHERE at >= $1 AND at < $2 GROUP BY 1,2,3,4,5`,
  ack: `/*kpi:ack*/ SELECT o.portal_ack_by AS name, ${D("o.created_at")} AS day, count(*)::int AS n,
      ${med(minsOf("o.portal_ack_at", PAID_AT))} AS med, ${p90(minsOf("o.portal_ack_at", PAID_AT))} AS p90, ${within("o.portal_ack_at", PAID_AT)} AS within
    FROM shop_orders o ${PAID_JOIN}
    WHERE o.portal_ack_at IS NOT NULL AND o.portal_ack_by IS NOT NULL AND NOT COALESCE(o.is_test, false)
      AND o.status NOT IN ('pending_payment','expired') AND o.created_at >= $1 AND o.created_at < $2 ${sets("o.portal_ack_by", D("o.created_at"))}`,
  handed: `/*kpi:handed*/ SELECT handed_by AS name, ${D("created_at")} AS day, count(*)::int AS n,
      count(pos_ready_at)::int AS timed, ${med(minsOf("handed_at", "pos_ready_at"))} AS med, ${within("handed_at", "pos_ready_at")} AS within
    FROM shop_orders WHERE handed_at IS NOT NULL AND handed_by IS NOT NULL AND COALESCE(handed_source,'portal') = 'portal' AND NOT COALESCE(is_test, false)
      AND created_at >= $1 AND created_at < $2 ${sets("handed_by", D("created_at"))}`,
  ext: `/*kpi:ext*/ SELECT created_by AS name, ${D("created_at")} AS day, count(*)::int AS n, count(delivered_at)::int AS delivered,
      ${med(minsOf("delivered_at", "created_at"))} AS med
    FROM dl_ext_runs WHERE created_at >= $1 AND created_at < $2 ${sets("created_by", D("created_at"))}`,
  incidents: `/*kpi:incidents*/ SELECT resolved_by AS name, ${D("resolved_at")} AS day, resolution, count(*)::int AS n
    FROM dl_courier_incidents WHERE resolved_at IS NOT NULL AND resolved_at >= $1 AND resolved_at < $2 GROUP BY 1,2,3`,
  incidentsOpen: `/*kpi:incidentsOpen*/ SELECT count(*)::int AS n, count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
    FROM dl_courier_incidents WHERE detected_at >= $1 AND detected_at < $2`,
  handovers: `/*kpi:handovers*/ SELECT acked_by AS name, ${D("at")} AS day,
      ${HO_KIND} AS kind,
      count(*)::int AS n, count(acked_at)::int AS acked, ${med(minsOf("acked_at", "at"))} AS med, ${within("acked_at", "at")} AS within
    FROM wa_handovers WHERE NOT test AND at >= $1 AND at < $2 GROUP BY GROUPING SETS ((acked_by, ${HO_KIND}), (acked_by, ${D("at")}, ${HO_KIND}))`,
  firstReply: `/*kpi:firstReply*/ SELECT r.by_name AS name, ${D("h.at")} AS day, count(*)::int AS n,
      ${med(minsOf("r.at", "h.at"))} AS med, ${within("r.at", "h.at")} AS within
    FROM wa_handovers h JOIN LATERAL (SELECT x.at, x.by_name FROM wa_staff_replies x WHERE x.phone_norm = h.phone_norm AND x.at > h.at AND NOT x.test ORDER BY x.at LIMIT 1) r ON TRUE
    WHERE NOT h.test AND h.reason NOT IN ('review_low','review_note') AND h.at >= $1 AND h.at < $2 ${sets("r.by_name", D("h.at"))}`,
  replies: `/*kpi:replies*/ SELECT by_name AS name, ${D("at")} AS day, count(*)::int AS n, count(DISTINCT phone_norm)::int AS chats
    FROM wa_staff_replies WHERE NOT test AND at >= $1 AND at < $2 ${sets("by_name", D("at"))}`,
  chats: `/*kpi:chats*/ SELECT by_name AS name, ${D("at")} AS day, action, count(*)::int AS n
    FROM wa_chat_owner_log WHERE at >= $1 AND at < $2 GROUP BY 1,2,3`,
  closes: `/*kpi:closes*/ SELECT last_close->>'by' AS name, last_close->>'outcome' AS outcome, count(*)::int AS n
    FROM wa_flow WHERE last_close IS NOT NULL AND (last_close->>'at')::timestamptz >= $1 AND (last_close->>'at')::timestamptz < $2 GROUP BY 1,2`,
  reviewActions: `/*kpi:reviewActions*/ SELECT by_name AS name, ${D("at")} AS day, action, count(*)::int AS n
    FROM review_actions WHERE at >= $1 AND at < $2 GROUP BY 1,2,3`,
  reviewFirst: `/*kpi:reviewFirst*/ SELECT a.by_name AS name, ${D("r.created_at")} AS day, count(*)::int AS n,
      ${med(minsOf("a.at", "r.created_at"))} AS med, ${within("a.at", "r.created_at")} AS within
    FROM reviews r JOIN LATERAL (SELECT x.at, x.by_name FROM review_actions x WHERE x.review_id = r.id ORDER BY x.at LIMIT 1) a ON TRUE
    WHERE r.rating < 4 AND NOT COALESCE(r.is_test, false) AND r.hidden_at IS NULL AND r.created_at >= $1 AND r.created_at < $2 ${sets("a.by_name", D("r.created_at"))}`,
  reviewClosed: `/*kpi:reviewClosed*/ SELECT resolved_by AS name, ${D("resolved_at")} AS day, count(*)::int AS n,
      ${med(minsOf("resolved_at", "created_at"))} AS med
    FROM reviews WHERE resolved AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND NOT COALESCE(is_test, false) AND resolved_at >= $1 AND resolved_at < $2 ${sets("resolved_by", D("resolved_at"))}`,
  reviewsOpen: `/*kpi:reviewsOpen*/ SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT resolved)::int AS open
    FROM reviews WHERE rating < 4 AND NOT COALESCE(is_test, false) AND hidden_at IS NULL AND created_at >= $1 AND created_at < $2`,
  notices: `/*kpi:notices*/ SELECT acked_by AS name, ${D("at")} AS day, role, count(*)::int AS n, count(acked_at)::int AS acked,
      ${med(minsOf("acked_at", "at"))} AS med, ${within("acked_at", "at")} AS within
    FROM wa_team_notices WHERE at >= $1 AND at < $2 GROUP BY GROUPING SETS ((acked_by, role), (acked_by, ${D("at")}, role))`,
  tableCalls: `/*kpi:tableCalls*/ SELECT done_by AS name, ${D("created_at")} AS day, count(*)::int AS n, count(done_at)::int AS done,
      ${med(minsOf("done_at", "created_at"))} AS med, ${within("done_at", "created_at")} AS within
    FROM table_calls WHERE created_at >= $1 AND created_at < $2 ${sets("done_by", D("created_at"))}`,
  presence: `/*kpi:presence*/ SELECT staff_id, staff_name, role, day::text AS day, minutes, visible_minutes, first_at, last_at
    FROM portal_presence_day WHERE day >= $1::date AND day <= $2::date`,
  offline: `/*kpi:offline*/ SELECT ${D("at")} AS day, kind, count(*)::int AS n
    FROM wa_team_log WHERE topic = 'portal_offline' AND ok AND kind IN ('cashier','manager','back') AND at >= $1 AND at < $2 GROUP BY 1,2`,
  orders: `/*kpi:orders*/ SELECT ${D("o.created_at")} AS day, count(*)::int AS n,
      count(o.accepted_at)::int AS accepted, ${med(minsOf("o.accepted_at", PAID_AT))} AS accept_med,
      count(o.pos_ready_at) FILTER (WHERE o.accepted_at IS NOT NULL)::int AS ready, ${med(minsOf("o.pos_ready_at", "o.accepted_at"))} AS ready_med,
      ${p90(minsOf("o.pos_ready_at", "o.accepted_at"))} AS ready_p90, ${within("o.pos_ready_at", "o.accepted_at")} AS ready_within,
      count(o.portal_ack_at)::int AS acked, count(o.collected_at)::int AS collected,
      count(e.first_high)::int AS promised,
      count(*) FILTER (WHERE e.first_high IS NOT NULL AND COALESCE(s.delivered_at, o.collected_at, o.pos_ready_at) IS NOT NULL
                         AND COALESCE(s.delivered_at, o.collected_at, o.pos_ready_at) <= e.first_high)::int AS promise_kept,
      count(*) FILTER (WHERE o.option = 'delivery' AND o.pos_ready_at IS NOT NULL AND s.first_at IS NOT NULL)::int AS courier_timed,
      ${med(minsOf("s.first_at", "o.pos_ready_at"))} AS courier_med,
      count(*) FILTER (WHERE s.first_at - o.pos_ready_at <= make_interval(mins => $4::int))::int AS courier_within
    FROM shop_orders o ${PAID_JOIN}
    LEFT JOIN eta_shown e ON e.order_no = o.order_no
    LEFT JOIN LATERAL (SELECT min(created_at) AS first_at, max(delivered_at) AS delivered_at FROM dl_shipments d WHERE d.shop_order_no = o.order_no) s ON TRUE
    WHERE NOT COALESCE(o.is_test, false) AND o.status NOT IN ('pending_payment','expired') AND o.created_at >= $1 AND o.created_at < $2
    GROUP BY GROUPING SETS ((), (${D("o.created_at")}))`,
  notes: `/*kpi:notes*/ SELECT ${D("at")} AS day, count(*)::int AS n FROM shop_order_events WHERE name = 'customer_note' AND at >= $1 AND at < $2 GROUP BY 1`,
  pos: `/*kpi:pos*/ SELECT staff_name AS name, calendar_day::text AS day, count(*)::int AS n,
      count(*) FILTER (WHERE COALESCE(order_type,'') NOT ILIKE '%void%' AND COALESCE(order_type,'') NOT ILIKE '%refund%')::int AS sold,
      COALESCE(sum(total) FILTER (WHERE COALESCE(order_type,'') NOT ILIKE '%void%' AND COALESCE(order_type,'') NOT ILIKE '%refund%'), 0)::float AS revenue,
      count(*) FILTER (WHERE COALESCE(order_type,'') ILIKE '%void%')::int AS voids,
      count(*) FILTER (WHERE COALESCE(order_type,'') ILIKE '%refund%')::int AS refunds
    FROM ts_orders WHERE staff_name IS NOT NULL AND calendar_day >= $1::date AND calendar_day <= $2::date GROUP BY GROUPING SETS ((staff_name), (staff_name, calendar_day))`,
});
/* المصادر بالعربي — للتقرير ولـ«غير متاح» */
export const SOURCE_AR = Object.freeze({
  audit: "سجل البوابة", ack: "«شفته» على الطلبات", handed: "التسليم للمندوب", ext: "المندوب الخارجي", incidents: "مشاكل المندوب", incidentsOpen: "مشاكل المندوب المفتوحة",
  handovers: "تحويلات واتساب", firstReply: "أول رد على التحويل", replies: "ردود واتساب", chats: "استلام/قفل المحادثات", closes: "نتايج القفل",
  reviewActions: "إجراءات التقييمات", reviewFirst: "أول إجراء على التقييم", reviewClosed: "التقييمات المقفولة", reviewsOpen: "التقييمات الواطية",
  notices: "تنبيهات الفريق", tableCalls: "نداءات الطاولات", presence: "حضور البوابة", offline: "تنبيهات «البورتال مقفول»", orders: "أزمنة الطلبات", notes: "ملاحظات العملاء", pos: "نقطة البيع",
});
/* اللي مالوش مصدر خالص — بيتقال صراحة بدل ما يتخمّن */
export const UNAVAILABLE = Object.freeze([
  { key: "cashClose", label: "دقة إقفال الكاش (نقطة البيع قصاد اللوحة)", why: "تاب سينس مابيدّيناش إقفال الوردية بالموظف — بس الفواتير باسمه (تحت: «نقطة البيع»)" },
  { key: "kitchen", label: "ضغطات المطبخ (KDS)", why: "شاشة المطبخ بتقدّم المرحلة على الجهاز نفسه من غير ما تسجّل مين" },
  { key: "posAcceptBy", label: "مين قبل الطلب على نقطة البيع", why: "القبول بييجي من تاب سينس من غير اسم — بيتحسب على مستوى الفريق" },
]);

/* ── التشكيل (صافي — متختبر من غير قاعدة) ───────────────────────────────── */
const timed = (n, m, p9, w, target) => ({ n: Number(n) || 0, medianMin: r1(num(m)), p90Min: r1(num(p9)), within: w == null ? null : Number(w) || 0, targetMin: target, pct: pctOf(Number(w) || 0, Number(n) || 0) });
const emptyMetrics = (T) => ({
  logins: 0,
  ack: { ...timed(0, null, null, 0, T.ackMin) },
  handed: { ...timed(0, null, null, 0, T.handedMin), timed: 0 },
  courierRequests: { n: 0, ok: 0, cancels: 0 },
  extCourier: { n: 0, delivered: 0, medianMin: null },
  incidents: { n: 0, byResolution: {} },
  handovers: { acked: 0, medianMin: null, within: 0, targetMin: T.handoverMin, pct: null, complaints: 0, notes: 0, reviews: 0, notesMedianMin: null, notesWithin: 0, notesTargetMin: T.noteMin },
  replies: { n: 0, chats: 0, firstReply: { ...timed(0, null, null, 0, T.handoverMin) } },
  chats: { taken: 0, closed: 0, released: 0, byOutcome: {} },
  reviews: { actions: 0, byAction: {}, closed: 0, medianCloseMin: null, firstAction: { ...timed(0, null, null, 0, T.reviewMin) } },
  notices: { ...timed(0, null, null, 0, T.noticeMin) },
  tableCalls: { ...timed(0, null, null, 0, T.tableCallMin), done: 0 },
  presence: null,
  smsOptouts: 0,
});
const dayRow = (day) => ({ day, ack: 0, handed: 0, courier: 0, handovers: 0, replies: 0, reviews: 0, notices: 0, tableCalls: 0, presenceMin: null, visibleMin: null, logins: 0, chatsClosed: 0 });

/**
 * rows = { audit, ack, handed, ext, incidents, incidentsOpen, handovers, firstReply, replies, chats, closes, reviewActions, reviewFirst, reviewClosed,
 *          reviewsOpen, notices, tableCalls, presence, offline, orders, notes, pos } — كل مفتاح: مصفوفة صفوف أو null (المصدر وقع/مش موجود).
 */
export function shapeKpis({ directory, targets, range, rows = {}, failed = [] }) {
  const T = targets;
  const idx = makeIndex(directory);
  const per = new Map();           // staff.id ⇒ { metrics, days: Map }
  const days = daysBetween(range.from, range.to);
  const slot = (s) => {
    if (!s) return null;
    if (!per.has(s.id)) per.set(s.id, { metrics: emptyMetrics(T), days: new Map(days.map((d) => [d, dayRow(d)])) });
    return per.get(s.id);
  };
  const dayOf = (p, day) => { if (!day) return null; if (!p.days.has(day)) p.days.set(day, dayRow(day)); return p.days.get(day); };
  const has = (k) => Array.isArray(rows[k]);
  const team = { orders: null, daily: [], handovers: { n: 0, acked: 0, auto: 0, open: 0, medianMin: null, byKind: {} }, offline: { cashier: 0, manager: 0, back: 0, byDay: {} },
    notices: { n: 0, acked: 0, auto: 0, open: 0, byRole: {} }, tableCalls: { n: 0, done: 0, open: 0 }, reviews: null, incidents: null, notes: null, closes: { byOutcome: {} }, pos: null };
  const auto = { handovers: 0, notices: 0 };

  if (has("audit")) for (const r of rows.audit) {
    const s = idx.of({ id: r.staff_id, name: r.staff_name }); const p = slot(s); if (!p) continue;
    const n = Number(r.n) || 0, d = dayOf(p, r.day);
    if (r.action === "login") { p.metrics.logins += n; if (d) d.logins += n; }
    else if (r.action === "courier_request") { p.metrics.courierRequests.n += n; p.metrics.courierRequests.ok += Number(r.ok) || 0; if (d) d.courier += n; }
    else if (r.action === "courier_cancel") p.metrics.courierRequests.cancels += n;
    else if (r.action === "ack" && d) d.ack += n;
    else if (r.action === "handed_to_courier" && d) d.handed += n;
    else if (/^sms_optout/.test(String(r.action))) p.metrics.smsOptouts += n;
  }
  if (has("ack")) for (const r of rows.ack) {
    const p = slot(idx.of({ name: r.name })); if (!p) continue;
    if (r.day == null) p.metrics.ack = timed(r.n, r.med, r.p90, r.within, T.ackMin);
    else { const d = dayOf(p, r.day); if (d && !d.ack) d.ack = Number(r.n) || 0; }
  }
  if (has("handed")) for (const r of rows.handed) {
    const p = slot(idx.of({ name: r.name })); if (!p) continue;
    if (r.day == null) p.metrics.handed = { ...timed(r.timed, r.med, null, r.within, T.handedMin), n: Number(r.n) || 0, timed: Number(r.timed) || 0 };
    else { const d = dayOf(p, r.day); if (d && !d.handed) d.handed = Number(r.n) || 0; }
  }
  if (has("ext")) for (const r of rows.ext) {
    const p = slot(idx.of({ name: r.name })); if (!p || r.day != null) continue;
    p.metrics.extCourier = { n: Number(r.n) || 0, delivered: Number(r.delivered) || 0, medianMin: r1(num(r.med)) };
  }
  if (has("incidents")) for (const r of rows.incidents) {
    const p = slot(idx.of({ name: r.name })); if (!p) continue;
    p.metrics.incidents.n += Number(r.n) || 0; p.metrics.incidents.byResolution[r.resolution || "?"] = (p.metrics.incidents.byResolution[r.resolution || "?"] || 0) + (Number(r.n) || 0);
  }
  if (has("incidentsOpen") && rows.incidentsOpen[0]) team.incidents = { n: Number(rows.incidentsOpen[0].n) || 0, open: Number(rows.incidentsOpen[0].open) || 0 };
  if (has("handovers")) {
    let tot = 0, ack = 0; const meds = [];
    for (const r of rows.handovers) {
      const n = Number(r.n) || 0, a = Number(r.acked) || 0;
      if (r.day == null) { tot += n; ack += a; team.handovers.byKind[r.kind] = (team.handovers.byKind[r.kind] || 0) + n; if (num(r.med) != null) meds.push([num(r.med), a]); }
      const s = idx.of({ name: r.name });
      if (!s) { if (r.day == null && r.name != null) auto.handovers += a; continue; }
      const p = slot(s);
      if (r.day == null) {
        const m = p.metrics.handovers;
        m.acked += a; m.within += Number(r.within) || 0;
        if (r.kind === "complaint") m.complaints += a; else if (r.kind === "review") m.reviews += a;
        else if (r.kind === "note") { m.notes += a; m.notesMedianMin = r1(num(r.med)); m.notesWithin = Number(r.within) || 0; }
        m._w = (m._w || []).concat([[num(r.med), a]]);
      } else { const d = dayOf(p, r.day); if (d) d.handovers += a; }
    }
    team.handovers.n = tot; team.handovers.acked = ack; team.handovers.auto = auto.handovers; team.handovers.open = Math.max(0, tot - ack);
    team.handovers.medianMin = weightedMedian(meds);
    for (const p of per.values()) { const m = p.metrics.handovers; m.medianMin = weightedMedian(m._w || []); m.pct = pctOf(m.within, m.acked); delete m._w; }
  }
  if (has("firstReply")) for (const r of rows.firstReply) {
    const p = slot(idx.of({ name: r.name })); if (!p || r.day != null) continue;
    p.metrics.replies.firstReply = timed(r.n, r.med, null, r.within, T.handoverMin);
  }
  if (has("replies")) for (const r of rows.replies) {
    const p = slot(idx.of({ name: r.name })); if (!p) continue;
    if (r.day == null) { p.metrics.replies.n = Number(r.n) || 0; p.metrics.replies.chats = Number(r.chats) || 0; }
    else { const d = dayOf(p, r.day); if (d) d.replies = Number(r.n) || 0; }
  }
  if (has("chats")) for (const r of rows.chats) {
    const p = slot(idx.of({ name: r.name })); if (!p) continue;
    const n = Number(r.n) || 0;
    if (r.action === "take") p.metrics.chats.taken += n; else if (r.action === "done") { p.metrics.chats.closed += n; const d = dayOf(p, r.day); if (d) d.chatsClosed += n; } else if (r.action === "release") p.metrics.chats.released += n;
  }
  if (has("closes")) for (const r of rows.closes) {
    const n = Number(r.n) || 0, oc = r.outcome || "?";
    team.closes.byOutcome[oc] = (team.closes.byOutcome[oc] || 0) + n;
    const p = slot(idx.of({ name: r.name })); if (p) p.metrics.chats.byOutcome[oc] = (p.metrics.chats.byOutcome[oc] || 0) + n;
  }
  if (has("reviewActions")) for (const r of rows.reviewActions) {
    const p = slot(idx.of({ name: r.name })); if (!p) continue;
    const n = Number(r.n) || 0, m = p.metrics.reviews;
    m.actions += n; m.byAction[r.action || "?"] = (m.byAction[r.action || "?"] || 0) + n;
    const d = dayOf(p, r.day); if (d) d.reviews += n;
  }
  if (has("reviewFirst")) for (const r of rows.reviewFirst) {
    const p = slot(idx.of({ name: r.name })); if (!p || r.day != null) continue;
    p.metrics.reviews.firstAction = timed(r.n, r.med, null, r.within, T.reviewMin);
  }
  if (has("reviewClosed")) for (const r of rows.reviewClosed) {
    const p = slot(idx.of({ name: r.name })); if (!p || r.day != null) continue;
    p.metrics.reviews.closed = Number(r.n) || 0; p.metrics.reviews.medianCloseMin = r1(num(r.med));
  }
  if (has("reviewsOpen") && rows.reviewsOpen[0]) team.reviews = { n: Number(rows.reviewsOpen[0].n) || 0, open: Number(rows.reviewsOpen[0].open) || 0 };
  if (has("notices")) {
    for (const r of rows.notices) {
      const n = Number(r.n) || 0, a = Number(r.acked) || 0;
      if (r.day == null) { team.notices.n += n; team.notices.acked += a; team.notices.byRole[r.role || "?"] = (team.notices.byRole[r.role || "?"] || 0) + n; }
      const s = idx.of({ name: r.name });
      if (!s) { if (r.day == null && r.name != null) auto.notices += a; continue; }
      const p = slot(s);
      if (r.day == null) { const m = p.metrics.notices; m.n += a; m.within += Number(r.within) || 0; m._w = (m._w || []).concat([[num(r.med), a]]); }
      else { const d = dayOf(p, r.day); if (d) d.notices += a; }
    }
    team.notices.auto = auto.notices; team.notices.open = Math.max(0, team.notices.n - team.notices.acked);
    for (const p of per.values()) { const m = p.metrics.notices; m.medianMin = weightedMedian(m._w || []); m.pct = pctOf(m.within, m.n); delete m._w; }
  }
  if (has("tableCalls")) for (const r of rows.tableCalls) {
    const n = Number(r.n) || 0, dn = Number(r.done) || 0;
    if (r.day == null && r.name == null) { /* النداءات اللي لسه مفتوحة (done_by NULL) */ team.tableCalls.open += n - dn; }
    if (r.day == null) { team.tableCalls.n += n; team.tableCalls.done += dn; }
    const p = slot(idx.of({ name: r.name })); if (!p) continue;
    if (r.day == null) p.metrics.tableCalls = { ...timed(dn, r.med, null, r.within, T.tableCallMin), done: dn };
    else { const d = dayOf(p, r.day); if (d) d.tableCalls = dn; }
  }
  if (has("presence")) for (const r of rows.presence) {
    const p = slot(idx.of({ id: r.staff_id, name: r.staff_name })); if (!p) continue;
    const m = p.metrics.presence || (p.metrics.presence = { minutes: 0, visibleMinutes: 0, days: 0, firstAt: null, lastAt: null });
    m.minutes += Number(r.minutes) || 0; m.visibleMinutes += Number(r.visible_minutes) || 0; m.days += 1;
    if (!m.firstAt || (r.first_at && iso(r.first_at) < m.firstAt)) m.firstAt = iso(r.first_at);
    if (!m.lastAt || (r.last_at && iso(r.last_at) > m.lastAt)) m.lastAt = iso(r.last_at);
    const d = dayOf(p, r.day); if (d) { d.presenceMin = Number(r.minutes) || 0; d.visibleMin = Number(r.visible_minutes) || 0; }
  }
  if (has("offline")) for (const r of rows.offline) {
    const n = Number(r.n) || 0;
    if (r.kind in team.offline && typeof team.offline[r.kind] === "number") team.offline[r.kind] += n;
    if (r.day) { const o = team.offline.byDay[r.day] || (team.offline.byDay[r.day] = { cashier: 0, manager: 0, back: 0 }); o[r.kind] = (o[r.kind] || 0) + n; }
  }
  if (has("orders")) {
    const tot = rows.orders.find((r) => r.day == null);
    const sh = (r) => ({ n: Number(r.n) || 0, accepted: Number(r.accepted) || 0, acceptMedianMin: r1(num(r.accept_med)),
      ready: { n: Number(r.ready) || 0, medianMin: r1(num(r.ready_med)), p90Min: r1(num(r.ready_p90)), within: Number(r.ready_within) || 0, targetMin: T.readyMin, pct: pctOf(Number(r.ready_within) || 0, Number(r.ready) || 0) },
      acked: Number(r.acked) || 0, collected: Number(r.collected) || 0,
      promise: { n: Number(r.promised) || 0, kept: Number(r.promise_kept) || 0, pct: pctOf(Number(r.promise_kept) || 0, Number(r.promised) || 0) },
      courier: { n: Number(r.courier_timed) || 0, medianMin: r1(num(r.courier_med)), within: Number(r.courier_within) || 0, targetMin: T.courierMin, pct: pctOf(Number(r.courier_within) || 0, Number(r.courier_timed) || 0) } });
    team.orders = tot ? sh(tot) : sh({});
    team.daily = days.map((day) => { const r = rows.orders.find((x) => x.day === day); return { day, ...(r ? sh(r) : sh({})) }; });
  }
  if (has("notes")) team.notes = { n: rows.notes.reduce((a, r) => a + (Number(r.n) || 0), 0), byDay: Object.fromEntries(rows.notes.map((r) => [r.day, Number(r.n) || 0])) };
  if (has("pos")) {
    const byStaff = rows.pos.filter((r) => r.day == null).map((r) => ({ name: r.name, invoices: Number(r.n) || 0, sold: Number(r.sold) || 0, revenue: Math.round((Number(r.revenue) || 0) * 100) / 100, voids: Number(r.voids) || 0, refunds: Number(r.refunds) || 0 }))
      .sort((a, b) => b.sold - a.sold);
    team.pos = { byStaff, note: "بأسماء كاشير تاب سينس زي ما هي على الفاتورة (مش دليل البوابة) · الفواتير الملغية والمرتجعة متعدودة لوحدها · «إقفال الكاش» مش متاح" };
  }

  const staff = idx.all().map((s) => {
    const p = per.get(s.id) || { metrics: emptyMetrics(T), days: new Map(days.map((d) => [d, dayRow(d)])) };
    return { id: s.id, name: s.name, role: s.role, inDirectory: s.inDirectory !== false, metrics: p.metrics, daily: [...p.days.values()].filter((d) => d.day >= range.from && d.day <= range.to).sort((a, b) => (a.day < b.day ? -1 : 1)) };
  }).sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || String(a.name).localeCompare(String(b.name), "ar"));
  const unavailable = UNAVAILABLE.map((u) => ({ ...u }));
  if (!has("presence")) unavailable.push({ key: "presence", label: "حضور البوابة (دقايق)", why: "دفتر الحضور اليومي بيبدأ من يوم نشر KP1 — الأيام اللي قبله مالهاش سجل" });
  return { staff, team, targets: T, unavailable, partial: failed.map((k) => SOURCE_AR[k] || k) };
}
/* وسيط مرجّح بالعدد من وسيطات أجزاء (تقريب مُعلَن: وسيط الفئات مرجّح بعددها) */
function weightedMedian(pairs) {
  const xs = pairs.filter(([m, w]) => m != null && Number.isFinite(m) && w > 0).sort((a, b) => a[0] - b[0]);
  if (!xs.length) return null;
  const total = xs.reduce((a, [, w]) => a + w, 0);
  let acc = 0;
  for (const [m, w] of xs) { acc += w; if (acc >= total / 2) return r1(m); }
  return r1(xs[xs.length - 1][0]);
}

/* ── دفتر الحضور اليومي (بيتكتب من wahandover.js مع كل كتابة حضور) ───────── */
export const PRESENCE_DAY_DDL = `
  CREATE TABLE IF NOT EXISTS portal_presence_day (
    day DATE NOT NULL, staff_id TEXT NOT NULL, staff_name TEXT, role TEXT,
    minutes INT NOT NULL DEFAULT 0, visible_minutes INT NOT NULL DEFAULT 0,
    last_bucket BIGINT, last_visible_bucket BIGINT,
    first_at TIMESTAMPTZ, last_at TIMESTAMPTZ,
    PRIMARY KEY (day, staff_id)
  );`;
/* دقيقة = «سلّة» (floor(ms/60000)). جهازين في نفس الدقيقة = دقيقة واحدة؛ كتابة متأخرة من جهاز قديم مابتزوّدش. */
export const PRESENCE_DAY_UPSERT = `INSERT INTO portal_presence_day(day, staff_id, staff_name, role, minutes, visible_minutes, last_bucket, last_visible_bucket, first_at, last_at)
  VALUES ($1::date, $2, $3, $4, 1, CASE WHEN $6::bigint IS NULL THEN 0 ELSE 1 END, $5::bigint, $6::bigint, $7::timestamptz, $7::timestamptz)
  ON CONFLICT (day, staff_id) DO UPDATE SET
    staff_name = COALESCE(EXCLUDED.staff_name, portal_presence_day.staff_name), role = COALESCE(EXCLUDED.role, portal_presence_day.role),
    minutes = portal_presence_day.minutes + CASE WHEN EXCLUDED.last_bucket > COALESCE(portal_presence_day.last_bucket, 0) THEN 1 ELSE 0 END,
    visible_minutes = portal_presence_day.visible_minutes + CASE WHEN EXCLUDED.last_visible_bucket IS NOT NULL AND EXCLUDED.last_visible_bucket > COALESCE(portal_presence_day.last_visible_bucket, 0) THEN 1 ELSE 0 END,
    last_bucket = GREATEST(COALESCE(portal_presence_day.last_bucket, 0), EXCLUDED.last_bucket),
    last_visible_bucket = GREATEST(COALESCE(portal_presence_day.last_visible_bucket, 0), COALESCE(EXCLUDED.last_visible_bucket, 0)),
    last_at = GREATEST(portal_presence_day.last_at, EXCLUDED.last_at)`;
/* بارامترات الكتابة من صف الحضور { user, t (ms), vis (ms|null) } */
export function presenceDayParams(r) {
  const t = Number(r.t), vis = r.vis == null ? null : Number(r.vis);
  return [bizDay(t), String(r.user.id).slice(0, 60), r.user.name ? String(r.user.name).slice(0, 60) : null, r.user.role ? String(r.user.role) : null,
    Math.floor(t / MIN), vis == null ? null : Math.floor(vis / MIN), new Date(t).toISOString()];
}

/* ── التجميع من القاعدة ──────────────────────────────────────────────────── */
export async function collect(pool, range, targets, { log = console, only = null } = {}) {
  const p12 = [range.startUtc, range.endUtc];
  const plan = {
    audit: p12, ack: [...p12, targets.ackMin], handed: [...p12, targets.handedMin], ext: p12, incidents: p12, incidentsOpen: p12,
    handovers: [...p12, targets.handoverMin], firstReply: [...p12, targets.handoverMin], replies: p12, chats: p12, closes: p12,
    reviewActions: p12, reviewFirst: [...p12, targets.reviewMin], reviewClosed: p12, reviewsOpen: p12,
    notices: [...p12, targets.noticeMin], tableCalls: [...p12, targets.tableCallMin], presence: [range.from, range.to], offline: p12,
    orders: [...p12, targets.readyMin, targets.courierMin], notes: p12, pos: [range.from, range.to],
  };
  const rows = {}, failed = [];
  for (const [k, params] of Object.entries(plan)) {
    if (only && !only.includes(k)) continue;
    try { rows[k] = (await pool.query(SQL[k], params)).rows || []; }
    catch (e) { rows[k] = null; failed.push(k); try { log.error(`[staff-kpi] ${k}: ${e && e.message}`); } catch { /* */ } }
  }
  return { rows, failed };
}

/* ── المسارات ─────────────────────────────────────────────────────────────── */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const log = ctx.log || console;
  const isOwner = ctx.isOwner || (async () => true);
  const now = deps.now || (() => new Date());
  const J = (v) => JSON.stringify(v);
  const okDay = (v) => v == null || v === "" || DAY_RE.test(String(v));

  async function build(q, { scope = "all", self = null } = {}) {
    const s = (await getSettingsData().catch(() => ({}))) || {};
    const targets = kpiTargets(s);
    const ws = Number.isInteger(Number(s.reportWeekStart)) ? Number(s.reportWeekStart) : DEFAULT_WEEK_START;
    if (!okDay(q.from) || !okDay(q.to)) return { status: 400, body: { ok: false, error: "bad_date", message: "التاريخ لازم YYYY-MM-DD" } };
    const range = kpiRange(q, now(), ws);
    const directory = directoryOf(s);
    const only = scope === "self" ? ["audit", "ack", "handed", "ext", "incidents", "handovers", "firstReply", "replies", "chats", "closes", "reviewActions", "reviewFirst", "reviewClosed", "notices", "tableCalls", "presence"] : null;
    const { rows, failed } = await collect(pool, range, targets, { log, only });
    const out = shapeKpis({ directory, targets, range, rows, failed });
    if (scope === "self") {
      const me = out.staff.filter((x) => (self.id && x.id === self.id) || (self.name && x.name === self.name));
      return { status: 200, body: { ok: true, scope: "self", range, targets, targetDefs: TARGET_DEFS, staff: me, team: null, unavailable: out.unavailable, partial: out.partial, generatedAt: now().toISOString() } };
    }
    /* targetDefs مع الرد نفسه: اللوحة بتعرض الأهداف بأسمائها لأي دور من غير ما تنادي /settings (اللي قسمها «إعدادات» ⇒ 403 لغير المالك) */
    return { status: 200, body: { ok: true, scope: "all", range, ...out, targetDefs: TARGET_DEFS, generatedAt: now().toISOString() } };
  }
  const qOf = (c) => ({ preset: c.req.query("preset") || undefined, from: c.req.query("from") || undefined, to: c.req.query("to") || undefined });

  app.get("/api/cms/staff-kpis", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { const r = await build(qOf(c)); return c.json(r.body, r.status); }
    catch (e) { log.error("[staff-kpi] cms:", e && e.message); return c.json({ ok: false, error: "failed" }, 500); }
  });
  app.get("/api/cms/staff-kpis/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = (await getSettingsData().catch(() => ({}))) || {};
    return c.json({ ok: true, targets: kpiTargets(s), defs: TARGET_DEFS, owner: Boolean(await isOwner(c)) });
  });
  app.post("/api/cms/staff-kpis/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "أهداف أداء الفريق للمالك بس" }, 403);
    const b = await c.req.json().catch(() => ({}));
    const s = (await getSettingsData().catch(() => ({}))) || {};
    const r = parseTargets(b && b.targets ? b.targets : b, kpiTargets(s));
    if (!r.ok) return c.json(r, 400);
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{staffKpi}', COALESCE(data->'staffKpi','{}'::jsonb) || $1::jsonb, true) WHERE id=1`, [J({ targets: r.targets })]);
    try { await ctx.auditNote?.(c, `أهداف أداء الفريق: ${Object.entries(r.targets).map(([k, v]) => `${k}=${v}`).join(" ")}`); } catch { /* */ }
    return c.json({ ok: true, targets: r.targets, defs: TARGET_DEFS, owner: true });
  });
  if (deps.requirePortal) {
    app.get("/api/portal/kpis", async (c) => {
      const a = await deps.requirePortal(c); if (a.res) return a.res;
      const u = a.user || {};
      const mgr = u.role === "manager" || u.admin === true;
      try { const r = await build(qOf(c), mgr ? {} : { scope: "self", self: { id: u.id, name: u.name } }); return c.json(r.body, r.status); }
      catch (e) { log.error("[staff-kpi] portal:", e && e.message); return c.json({ ok: false, error: "failed" }, 500); }
    });
  }
  return { build, kpiTargets, collect };
}
