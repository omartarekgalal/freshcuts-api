/* ═══════════════════════════════════════════════════════════════════════════
   🔔 RG2 — طلب جديد ما اتشافش ⇒ تصعيد من السيرفر (عمر ١٨/١٠: «أوردر جه مارنّش عند الكاشير إلا بعد ١٦ دقيقة»)

   الحادثة: W1792354906756 اتدفع ٢٣:٢٢:٥٥ الرياض ⇒ إشعار البوابة «جديد» اتبعت لـ٦/٦ أجهزة (خدمة الـpush قبلته) ⇒ نزل نقطة البيع
   ٢٣:٢٢:٥٧ ⇒ محدش ضغط «شفته» والكاشير قبل على تاب سينس ٢٣:٣٨:٣٧ (١٦ دقيقة). اشتراك تابلت الكاشير اتسجّل من جديد ٢٣:٣٨:٣٢ —
   يعني صفحة البوابة على التابلت ماكانتش شغّالة، والإشعار ماررنّش بصوت (أندرويد doze / توفير البطارية / قناة صامتة).
   الرنّة اللي في الصفحة (RT3) بتشتغل بس والبوابة مفتوحة — فالتصعيد هنا من السيرفر ومايعتمدش على التابلت.

   السلّم (لكل طلب أونلاين مدفوع، سلسلة واحدة):
     ١) escalateAfterSec (٩٠ ث) من الدفع ومحدش شاف/قبل ⇒ إشعار بوابة تاني بـtag مختلف (order-W…-esc1) + renotify ⇒ بيظهر ويرنّ تاني.
     ٢) step2AfterSec (١٨٠ ث) ⇒ واتساب للكاشير والمدير من دليل الفريق (wateam.sendToStaff: رسالة حرة جوّه نافذة الـ٢٤ ساعة ⇒
        قالب الفريق الخدمي fc_staff_sla_alert (CR4 ١٩/١٠: بدل fc_staff_team_notice اللي ميتا صنّفته تسويق) ⇒ SMS). **مش** «إشعار بورتال بس» (TW1) — البوابة نفسها هي اللي واقعة. + إشعار بوابة تاني.
     ٣) step3AfterSec (٣٦٠ ث) ⇒ SMS للمدير والمالك (دليل الفريق) + أرقام الإنذارات الحرجة (settings.delivery.alertPhones، staffalerts.js). + إشعار بوابة.
   بيقف أول ما: «شفته» على البوابة (portal_ack_at) · القبول على نقطة البيع (accepted_at / الحالة اتحركت / آخر approval في tsp_webhooks
   أو pos_approval «accept…/preparing/ready») · الإلغاء/الرفض/الاسترجاع. وقفة بعد خطوة واحدة على الأقل بتتسجّل («اتقبل بعد X»).
   - المطعم مقفول بمواعيده (settings.hours عن طريق sendhours.isRestaurantOpenAt من غير «يقف قبل القفل») + quietWhenClosed ⇒ مفيش إرسال.
   - الطلب المسبق (scheduled_for بعد الدفع) والطلبات التجريبية مابتتصعّدش. طلب أقدم من maxAgeMin ⇒ مابيتصعّدش (سيرفر رجع بعد وقفة).
   - كل خطوة: حجز ذري في shop_ack_escalations (order_no PK + step) قبل الإرسال ⇒ حاويتين وقت الـrollover مايبعتوش مرتين.
   - كل خطوة ووقفة: حدث ack_escalation في shop_order_events ⇒ بيظهر في تايملاين الطلب (البوابة/اللوحة). الإشعار نفسه في portal_push_log (ack_esc:N).
   - الإعدادات كلها من اللوحة: settings.delivery.ackEscalation (لوحة التوصيل ← «تنبيهات ومسؤولين») — deliverycontrol.js.
═══════════════════════════════════════════════════════════════════════════ */
import { pushPayload } from "./portal-core.js";
import { teamConfig, PORTAL_URL, TPL_SLA } from "./wateam.js";
import { staffConfig, staffPhones, fitOneSms } from "./staffalerts.js";
import { isRestaurantOpenAt, hoursKnown } from "./sendhours.js";
import { PAID_AT, PAID_JOIN } from "./staffkpi.js";
import { emitOrder as emitOrderDefault } from "./order-events.js";

export const ACK_ESC_DEFAULTS = Object.freeze({
  enabled: true,
  escalateAfterSec: 90,
  step2AfterSec: 180,
  step3AfterSec: 360,
  step2Cashier: true,
  step2Manager: true,
  step3Manager: true,
  step3Owner: true,
  step3AlertPhones: true,
  quietWhenClosed: true,
  maxAgeMin: 30,
});
export const ACK_ESC_LIMITS = Object.freeze({
  escalateAfterSec: [30, 900], step2AfterSec: [60, 1800], step3AfterSec: [90, 3600], maxAgeMin: [10, 180],
});
export const MIN_GAP_SEC = 30;                 // الخطوة الجاية بعد اللي قبلها بـ٣٠ ث على الأقل (لو اتكتبوا بالعكس في اللوحة)
export const TICK_MS = 15_000;
export const PRE_ACCEPT = Object.freeze(["paid", "pos_created", "paid_pos_failed"]);
const CANCEL_RE = /cancel|reject|refund|expired|void/i;
const ACCEPT_RE = /accept|pickup_ready|preparing|processing|ready|deliver|complet/i;

const intIn = (v, [lo, hi], def) => {
  if (v === "" || v === null || v === undefined || typeof v === "boolean") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};
const ms = (v) => (v == null ? NaN : v instanceof Date ? v.getTime() : new Date(v).getTime());
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export const arNum = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

/* settings ⇒ إعداد فعّال بحدود وترتيب (step1 < step2 < step3 بفرق MIN_GAP_SEC على الأقل) */
export function ackEscCfg(settings) {
  const d = (settings && settings.delivery) || {};
  const x = d.ackEscalation && typeof d.ackEscalation === "object" && !Array.isArray(d.ackEscalation) ? d.ackEscalation : {};
  const L = ACK_ESC_LIMITS, D = ACK_ESC_DEFAULTS;
  const bool = (k) => (typeof x[k] === "boolean" ? x[k] : D[k]);
  const s1 = intIn(x.escalateAfterSec, L.escalateAfterSec, D.escalateAfterSec);
  const s2 = Math.max(intIn(x.step2AfterSec, L.step2AfterSec, D.step2AfterSec), s1 + MIN_GAP_SEC);
  const s3 = Math.max(intIn(x.step3AfterSec, L.step3AfterSec, D.step3AfterSec), s2 + MIN_GAP_SEC);
  const out = {
    enabled: bool("enabled"), escalateAfterSec: s1, step2AfterSec: s2, step3AfterSec: s3,
    step2Cashier: bool("step2Cashier"), step2Manager: bool("step2Manager"),
    step3Manager: bool("step3Manager"), step3Owner: bool("step3Owner"), step3AlertPhones: bool("step3AlertPhones"),
    quietWhenClosed: bool("quietWhenClosed"), maxAgeMin: intIn(x.maxAgeMin, L.maxAgeMin, D.maxAgeMin),
  };
  out.step2Roles = [out.step2Cashier && "cashier", out.step2Manager && "manager"].filter(Boolean);
  out.step3Roles = [out.step3Manager && "manager", out.step3Owner && "owner"].filter(Boolean);
  out.delays = [s1, s2, s3];
  return out;
}

/* المطعم مقفول بمواعيده؟ true/false — والمواعيد مش متعرّفة ⇒ false (مانسكتش على الأعمى). نفس isRestaurantOpenAt بتاع sendhours.js
   من غير «يقف قبل القفل بـ٣٠ د» ومن غير ما يعتمد على مفتاح «واتساب الآلي بمواعيد المطعم» (ده طلب مدفوع، مش رسالة تسويق). */
export function restaurantClosed(now, settings) {
  const hours = settings && settings.hours;
  if (!hoursKnown(hours)) return false;
  return isRestaurantOpenAt(now, { enabled: true, stopBeforeCloseMin: 0, hours, active: true }) === false;
}

/* حالة الطلب من ناحية «حد شافه؟» ⇒ null (لسه مستني) | "acked" | "accepted" | "cancelled" | "test" | "scheduled" */
export function ackStateOf(o, approval = null) {
  if (!o) return "cancelled";
  if (o.is_test === true) return "test";
  if (o.portal_ack_at) return "acked";
  if (o.accepted_at) return "accepted";
  const st = String(o.status || "");
  if (CANCEL_RE.test(st)) return "cancelled";
  if (!PRE_ACCEPT.includes(st)) return "accepted";            // الحالة اتحركت (accepted / ready / courier… / delivered)
  const a = String(approval || o.pos_approval || "").toLowerCase();
  if (a && CANCEL_RE.test(a)) return "cancelled";
  if (a && ACCEPT_RE.test(a)) return "accepted";
  const sched = ms(o.scheduled_for), created = ms(o.created_at);
  if (Number.isFinite(sched) && (!Number.isFinite(created) || sched > created + 5 * 60_000)) return "scheduled";
  return null;
}

/* القرار (صافي): { action: "stop", reason } | { action: "steps", steps: [n…] } | { action: "wait", why } */
export function decide({ order, approval = null, chain = null, cfg, now, closed = false }) {
  const open = chain && Number(chain.step) > 0 && !chain.stopped_at;
  const st = ackStateOf(order, approval);
  if (st) return open ? { action: "stop", reason: st } : { action: "wait", why: st };
  if (!cfg.enabled) return open ? { action: "stop", reason: "disabled" } : { action: "wait", why: "disabled" };
  const elapsed = Math.floor((ms(now) - ms(order.paid_at || order.created_at)) / 1000);
  if (!Number.isFinite(elapsed)) return { action: "wait", why: "no_time" };
  if (elapsed > cfg.maxAgeMin * 60) return open ? { action: "stop", reason: "too_old" } : { action: "wait", why: "too_old" };
  const cur = chain && !chain.stopped_at ? Number(chain.step) || 0 : chain && chain.stopped_at ? 3 : 0;
  const steps = [1, 2, 3].filter((n) => n > cur && elapsed >= cfg.delays[n - 1]);
  if (!steps.length) return { action: "wait", why: cur >= 3 ? "done" : "not_yet" };
  if (closed && cfg.quietWhenClosed) return { action: "wait", why: "closed" };
  return { action: "steps", steps, elapsed };
}

/* ── النصوص ──────────────────────────────────────────────────────────────── */
export const waitAr = (sec) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m === 1 ? "دقيقة" : m === 2 ? "دقيقتين" : m <= 10 ? `${arNum(m)} دقايق` : `${arNum(m)} دقيقة`;
};
const optAr = (o) => (o === "pickup" ? "استلام" : "توصيل");
const sar = (v) => `${Math.round((Number(v) || 0) * 100) / 100} ر.س`;
/* واتساب الفريق (حر): السطر الأول بنص المالك */
export function staffWaText(o, sec) {
  return [`🔔 طلب جديد ${o.order_no} ما اتقبلش من ${waitAr(sec)} — افتح البورتال/الكاشير`,
    `${Number(o.table_no) > 0 ? `طاولة ${o.table_no}` : optAr(o.option)} · ${sar(o.total)} · مدفوع`,
    "المطلوب: اضغط «شفته» على البورتال واقبل الطلب على نقطة البيع (تاب سينس).",
    `البورتال ↗ ${PORTAL_URL}`].join("\n");
}
/* سطر القالب (≤١٢٠ من غير سطر جديد ولا إيموجي) */
export const staffTplLine = (o, sec) => `طلب جديد ${o.order_no} ما اتقبلش من ${waitAr(sec)} - افتح البورتال/الكاشير`.slice(0, 120);
/* CR4 (١٩/١٠): متغيّر {{2}} في قالب fc_staff_sla_alert (UTILITY معتمد) بلغة الفريق (staffSmsLanguage) — {{1}} = رقم الطلب.
   عربي: «الطلب W… يحتاج تدخل الحين: طلب جديد ما اتقبلش من ٣ دقايق. افتح البورتال وتابعه.» */
export const staffSlaLine = (sec, lang = "ar") => {
  const m = Math.max(1, Math.round(sec / 60));
  return lang === "en" ? `new order not accepted for ${m} min` : `طلب جديد ما اتقبلش من ${waitAr(sec)}`;
};
export function staffSms(o, sec, lang = "en", step = 2) {
  const m = Math.max(1, Math.round(sec / 60));
  if (lang === "ar") return fitOneSms(step >= 3 ? `فريش كاتس عاجل: طلب ${o.order_no} ماتقبلش من ${m}د - كلم الكاشير` : `فريش كاتس: طلب ${o.order_no} ماتقبلش من ${m}د - افتح البورتال/الكاشير`);
  return fitOneSms(step >= 3
    ? `Fresh Cuts URGENT: order ${o.order_no} PAID ${m} min ago, NOT accepted yet. Call the cashier now.`
    : `Fresh Cuts: NEW ORDER ${o.order_no} not accepted for ${m} min. Open the portal / POS now.`);
}
export function pushFor(o, step, sec, baseUrl = PORTAL_URL) {
  const base = pushPayload("new", { orderNo: o.order_no, option: o.option, total: o.total, itemsCount: Array.isArray(o.items) ? o.items.length : null }, baseUrl);
  return { ...base, tag: `order-${o.order_no}-esc${step}`, renotify: true, requireInteraction: true, urgency: "high", ttl: 600,
    title: `🔔 ${waitAr(sec)} ومحدش شاف الطلب ${o.order_no}`, body: `${base.body}\nاضغط «شفته» واقبل الطلب على الكاشير` };
}
const ROLE_LIST_AR = { cashier: "الكاشير", manager: "المدير", owner: "المالك" };
const rolesAr = (roles) => roles.map((r) => ROLE_LIST_AR[r] || r).join(" و") || "—";
export const STOP_AR = Object.freeze({ acked: "حد ضغط «شفته»", accepted: "اتقبل على نقطة البيع", cancelled: "اتلغى/اترفض", test: "طلب تجريبي",
  scheduled: "طلب مسبق", disabled: "التصعيد اتقفل من اللوحة", too_old: "عدّى أقصى مدة للتصعيد" });
const durAr = (sec) => { const m = Math.floor(sec / 60), s = sec % 60; return m ? `${arNum(m)} د${s ? ` ${arNum(s)} ث` : ""}` : `${arNum(s)} ث`; };
export function stepSummary(step, sec, r, cfg) {
  const push = r.push ? ` · إشعار البوابة ${arNum(r.push.sent)}/${arNum(r.push.of)}` : "";
  if (step === 1) return `🔔 تصعيد ١: الطلب ما اتشافش من ${durAr(sec)} — إشعار تاني للبوابة${push}`;
  if (step === 2) return `🔔 تصعيد ٢: واتساب لـ${rolesAr(cfg.step2Roles)} (وصل ${arNum(r.wa.sent)} من ${arNum(r.wa.to)}${r.wa.sms ? ` · منهم ${arNum(r.wa.sms)} SMS` : ""})${push}`;
  return `🚨 تصعيد ٣: SMS لـ${rolesAr(cfg.step3Roles)}${cfg.step3AlertPhones ? " وأرقام الإنذارات" : ""} (اتبعت ${arNum(r.sms.sent)} من ${arNum(r.sms.to)})${push}`;
}

/* ── SQL ─────────────────────────────────────────────────────────────────── */
export const ESC_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS shop_ack_escalations (
    order_no TEXT PRIMARY KEY,
    paid_at TIMESTAMPTZ,
    step INT NOT NULL DEFAULT 0,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    stop_reason TEXT,
    stopped_after_sec INT
  )`,
  `CREATE INDEX IF NOT EXISTS shop_ack_escalations_open_idx ON shop_ack_escalations(started_at) WHERE stopped_at IS NULL`,
]);
export const SQL = Object.freeze({
  candidates: `/*rg2:candidates*/ SELECT o.order_no, o.status, o.option, o.total, o.items, o.table_no, o.created_at, o.scheduled_for,
      o.portal_ack_at, o.accepted_at, o.pos_approval, o.pos_order_id, COALESCE(o.is_test, false) AS is_test, ${PAID_AT} AS paid_at,
      e.step AS esc_step, e.stopped_at AS esc_stopped_at
    FROM shop_orders o ${PAID_JOIN}
    LEFT JOIN shop_ack_escalations e ON e.order_no = o.order_no
    WHERE o.created_at > $1::timestamptz
      AND ((o.status IN ('paid','pos_created','paid_pos_failed') AND o.portal_ack_at IS NULL AND o.accepted_at IS NULL AND NOT COALESCE(o.is_test, false))
           OR (e.order_no IS NOT NULL AND e.stopped_at IS NULL AND e.step > 0))
    ORDER BY o.created_at LIMIT 60`,
  approval: `/*rg2:approval*/ SELECT payload->'resource'->'statuses_slugs'->>'approval_status' AS a FROM tsp_webhooks
    WHERE payload->'resource'->'order'->>'id' = $1 ORDER BY received_at DESC LIMIT 1`,
  claim: `/*rg2:claim*/ INSERT INTO shop_ack_escalations(order_no, paid_at, step, started_at, updated_at) VALUES ($1, $2::timestamptz, $3, $4::timestamptz, $4::timestamptz)
    ON CONFLICT (order_no) DO UPDATE SET step = EXCLUDED.step, updated_at = EXCLUDED.updated_at
      WHERE shop_ack_escalations.step < EXCLUDED.step AND shop_ack_escalations.stopped_at IS NULL
    RETURNING order_no`,
  record: `/*rg2:record*/ UPDATE shop_ack_escalations SET steps = steps || $2::jsonb WHERE order_no = $1`,
  stop: `/*rg2:stop*/ UPDATE shop_ack_escalations SET stopped_at = $2::timestamptz, stop_reason = $3, stopped_after_sec = $4
    WHERE order_no = $1 AND stopped_at IS NULL RETURNING step`,
  stale: `/*rg2:stale*/ UPDATE shop_ack_escalations SET stopped_at = $1::timestamptz, stop_reason = 'too_old'
    WHERE stopped_at IS NULL AND started_at < $2::timestamptz`,
  recent: `/*rg2:recent*/ SELECT order_no, paid_at, step, steps, started_at, stopped_at, stop_reason, stopped_after_sec
    FROM shop_ack_escalations ORDER BY started_at DESC LIMIT $1`,
});

/* ── المحرّك ─────────────────────────────────────────────────────────────── */
export function makeAckEscalator({ pool, getSettingsData, push = () => null, team = () => null, sendSms = null, emit = emitOrderDefault, now = () => new Date(), log = console } = {}) {
  const lazy = (f) => { try { return (typeof f === "function" ? f() : f) || null; } catch { return null; } };
  const stats = { ticks: 0, steps: { 1: 0, 2: 0, 3: 0 }, stops: 0, errors: 0, lastTickAt: null, lastError: null };
  let ready = null, running = false;
  function ensureSchema() {
    if (!ready) {
      ready = (async () => { for (const s of ESC_DDL) await pool.query(s); return true; })()
        .catch((e) => { ready = null; try { log.error(`[ack-esc] schema: ${e?.message || e}`); } catch {} return false; });
    }
    return ready;
  }
  const iso = (d) => new Date(d).toISOString();
  async function approvalOf(o) {
    if (!o.pos_order_id) return null;
    try { const r = await pool.query(SQL.approval, [String(o.pos_order_id)]); return (r.rows && r.rows[0] && r.rows[0].a) || null; } catch { return null; }
  }
  const fire = (o, summary, data) => { try { emit("ack_escalation", { orderNo: o.order_no, source: "system", channel: "staff", summary, data }); } catch {} };

  async function doPush(o, step, sec) {
    const p = lazy(push);
    if (!p || typeof p.sendToSubs !== "function") return { sent: 0, of: 0, note: "no_push" };
    const key = `ack_esc:${step}`;
    try { if (typeof p.claim === "function" && !(await p.claim(o.order_no, key))) return { sent: 0, of: 0, note: "already_sent" }; } catch { /* نكمّل — الحجز الأساسي في shop_ack_escalations */ }
    const res = await p.sendToSubs(pushFor(o, step, sec, p.PORTAL_URL || PORTAL_URL));
    pool.query("UPDATE portal_push_log SET sent=$3, targets=$4 WHERE order_no=$1 AND kind=$2", [o.order_no, key, res.sent || 0, res.of || 0]).catch(() => {});
    return { sent: res.sent || 0, of: res.of || 0, ...(res.reason ? { note: res.reason } : {}) };
  }
  async function doWa(o, sec, cfg, settings) {
    const t = lazy(team), tc = teamConfig(settings);
    const members = tc.members.filter((m) => m.active && cfg.step2Roles.includes(m.role));
    const out = { to: members.length, sent: 0, wa: 0, sms: 0, failed: 0 };
    if (!members.length) return { ...out, note: "no_members" };
    if (!t || typeof t.sendToStaff !== "function") return { ...out, failed: members.length, note: "no_team" };
    /* outsideWindow "template": البوابة واقعة أصلاً، فبرّه النافذة ⇒ القالب المعتمد ثم SMS (مش إشعار بورتال بس) */
    const forced = { ...tc, outsideWindow: "template" };
    const lang = staffConfig(settings).lang;
    const msg = { topic: "ack_escalation", kind: "step2", body: staffWaText(o, sec), button: false, urgent: true, ref4: String(o.order_no).slice(-4),
      templates: [{ name: TPL_SLA, lang, data: { order: { order_no: String(o.order_no) }, sla: { text: staffSlaLine(sec, lang) } } }],
      sms: staffSms(o, sec, lang, 2), smsRef: `ack-esc2 ${o.order_no}` };
    for (const m of members) {
      let r;
      try { r = await t.sendToStaff(forced, m, msg); } catch (e) { r = { ok: false, error: e?.message }; }
      if (r && r.ok) { out.sent++; if (r.via === "sms") out.sms++; else out.wa++; } else out.failed++;
    }
    return out;
  }
  async function doSms(o, sec, cfg, settings) {
    const tc = teamConfig(settings), sc = staffConfig(settings);
    const phones = staffPhones([...tc.members.filter((m) => m.active && cfg.step3Roles.includes(m.role)).map((m) => m.phone), ...(cfg.step3AlertPhones ? sc.alertPhones : [])]);
    const out = { to: phones.length, sent: 0, failed: 0 };
    if (!phones.length) return { ...out, note: "no_phones" };
    if (typeof sendSms !== "function") return { ...out, failed: phones.length, note: "no_sms" };
    const body = staffSms(o, sec, sc.lang, 3);
    for (const phoneNorm of phones) {
      try { const r = await sendSms({ phoneNorm, body, kind: "staff", ref: `ack-esc3 ${o.order_no}` }); if (r && r.suppressed) out.failed++; else out.sent++; }
      catch (e) { out.failed++; try { log.error(`[ack-esc] sms …${phoneNorm.slice(-4)} failed: ${e?.message}`); } catch {} }
    }
    return out;
  }

  async function runSteps(o, steps, elapsed, cfg, settings) {
    const t = now();
    let done = 0;
    for (const step of steps) {
      const c = await pool.query(SQL.claim, [o.order_no, o.paid_at ? iso(o.paid_at) : null, step, iso(t)]);
      if (!c.rowCount) return done;                       // حاوية تانية سبقتنا / السلسلة وقفت
      const r = {};
      /* إشعار البوابة: مع كل خطوة، بس مرة واحدة في الدورة (لو اتعمل أكتر من خطوة سوا بعد وقفة ⇒ مع آخر واحدة) */
      if (step === steps[steps.length - 1]) r.push = await doPush(o, step, elapsed);
      if (step === 2) r.wa = await doWa(o, elapsed, cfg, settings);
      if (step === 3) r.sms = await doSms(o, elapsed, cfg, settings);
      const summary = stepSummary(step, elapsed, r, cfg);
      const flat = { step, afterSec: elapsed, pushSent: r.push ? r.push.sent : null, pushOf: r.push ? r.push.of : null,
        waTo: r.wa ? r.wa.to : null, waSent: r.wa ? r.wa.sent : null, waViaSms: r.wa ? r.wa.sms : null,
        smsTo: r.sms ? r.sms.to : null, smsSent: r.sms ? r.sms.sent : null, note: (r.wa && r.wa.note) || (r.sms && r.sms.note) || (r.push && r.push.note) || null };
      await pool.query(SQL.record, [o.order_no, JSON.stringify([{ at: iso(now()), ...flat }])]).catch(() => {});
      fire(o, summary, flat);
      stats.steps[step]++;
      done++;
    }
    return done;
  }
  async function stopChain(o, reason) {
    const t = now();
    const after = Math.max(0, Math.floor((ms(t) - ms(o.paid_at || o.created_at)) / 1000));
    const r = await pool.query(SQL.stop, [o.order_no, iso(t), reason, Number.isFinite(after) ? after : null]);
    if (!r.rowCount) return false;
    stats.stops++;
    const step = Number(r.rows && r.rows[0] && r.rows[0].step) || null;
    fire(o, `✅ التصعيد وقف: ${STOP_AR[reason] || reason} بعد ${durAr(after)} من الدفع${step ? ` (بعد خطوة ${arNum(step)})` : ""}`, { step: "stop", reason, afterSec: after, lastStep: step });
    return true;
  }

  /* دورة واحدة. بترجّع { checked, steps, stopped, quiet } — مابترميش. */
  async function tick() {
    if (running) return { skipped: "running" };
    running = true;
    const out = { checked: 0, steps: 0, stopped: 0, quiet: false };
    try {
      stats.ticks++; stats.lastTickAt = iso(now());
      if (!(await ensureSchema())) return { ...out, error: "schema" };
      const settings = (await getSettingsData()) || {};
      const cfg = ackEscCfg(settings);
      const t = now();
      const closed = restaurantClosed(t, settings);
      out.quiet = closed && cfg.quietWhenClosed;
      const since = new Date(ms(t) - (cfg.maxAgeMin + 60) * 60_000);
      await pool.query(SQL.stale, [iso(t), iso(since)]).catch(() => {});
      const rows = (await pool.query(SQL.candidates, [iso(since)])).rows || [];
      for (const o of rows) {
        out.checked++;
        try {
          const chain = o.esc_step != null ? { step: Number(o.esc_step), stopped_at: o.esc_stopped_at || null } : null;
          let d = decide({ order: o, chain, cfg, now: t, closed });
          const open = chain && chain.step > 0 && !chain.stopped_at;
          if (d.action === "steps" || (open && d.action !== "stop")) {
            const a = await approvalOf(o);                 // آخر approval من ويبهوك نقطة البيع (ممكن يسبق الكنس)
            if (a) d = decide({ order: o, approval: a, chain, cfg, now: t, closed });
          }
          if (d.action === "stop") { if (await stopChain(o, d.reason)) out.stopped++; }
          else if (d.action === "steps") out.steps += await runSteps(o, d.steps, d.elapsed, cfg, settings);
        } catch (e) {
          stats.errors++; stats.lastError = String(e?.message || e).slice(0, 200);
          try { log.error(`[ack-esc] ${o.order_no}: ${e?.message || e}`); } catch {}
        }
      }
      return out;
    } catch (e) {
      stats.errors++; stats.lastError = String(e?.message || e).slice(0, 200);
      try { log.error(`[ack-esc] tick: ${e?.message || e}`); } catch {}
      return { ...out, error: "tick" };
    } finally {
      running = false;
    }
  }
  async function recent(limit = 50) {
    await ensureSchema();
    return (await pool.query(SQL.recent, [Math.min(200, Math.max(1, Number(limit) || 50))])).rows || [];
  }
  return { tick, recent, ensureSchema, stats };
}

/* index.js: register(app, moduleCtx, { push: () => portalApi.push, team: () => waTeamApi, sendSms }) */
export function register(app, ctx, deps = {}) {
  const log = ctx.log || console;
  const esc = makeAckEscalator({ pool: ctx.pool, getSettingsData: ctx.getSettingsData, push: deps.push, team: deps.team, sendSms: deps.sendSms,
    emit: deps.emit, now: deps.now, log });
  let timer = null;
  if (deps.timers !== false) {
    esc.ensureSchema();
    timer = setInterval(() => { esc.tick(); }, deps.tickMs || TICK_MS);
    timer.unref?.();
  }
  /* قراية بس: آخر سلاسل التصعيد + الإعداد الفعّال (للوحة وverify) */
  app.get("/api/cms/ack-escalations", async (c) => {
    const err = await ctx.requireAdmin(c); if (err) return err;
    try {
      const s = (await ctx.getSettingsData()) || {};
      return c.json({ ok: true, config: ackEscCfg(s), defaults: ACK_ESC_DEFAULTS, limits: ACK_ESC_LIMITS, stats: esc.stats, rows: await esc.recent(c.req.query("limit")) });
    } catch (e) { log.error("[ack-esc] recent:", e?.message); return c.json({ ok: false, error: "failed" }, 500); }
  });
  return { ...esc, stop: () => { if (timer) clearInterval(timer); } };
}
