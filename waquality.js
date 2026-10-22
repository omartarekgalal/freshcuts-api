/* ═══════════════════════════════════════════════════════════════════════════
   🛡 waquality.js — QP1 (١٣/١٠): حماية جودة رقم واتساب في حملات Cloud (M7 من مراجعة الخبير).

   دوال صافية بس (متجرّبة في waquality.test.mjs) — مفيش قاعدة بيانات ولا شبكة هنا. اللي بيستعملها:
     wacloud.js   cloudCfg (حدود الإعدادات) · wasender.js  cloudTick (البوابة، السلّم، الفرامل) · whatsapp.js  guardSend (سقف العميل)

   ١) بوابة الجودة (qualityVerdict): جودة الرقم لازم GREEN، مفيش نزول في حد الرقم/المحفظة، مفيش حدث حساب/جودة من الويب هوك،
      وقوالب الحملات الشغّالة GREEN/UNKNOWN. لو مش قادرين نقرا ⇒ hold (مفيش إرسال الدورة دي + السبب)، مش «تمام».
   ٢) سلّم التسخين (warmup*): ٣٠/يوم أول ٣ أيام · ٥٠ لحد يوم ٧ · ١٠٠ لحد يوم ١٤ · بعدها السقف اليومي. الطلوع درجة محتاج
      نسبة «إيقاف» الدرجة اللي فاتت < ١٪ وجودة GREEN — وإلا بنفضل على نفس الدرجة ونقول ليه.
   ٣) سقف العميل (custCapOf): قالب تسويقي واحد كل ٧ أيام و٣ كل ٣٠ يوم، من أي حملة أو أتمتة (العدّ من wa_messages).
═══════════════════════════════════════════════════════════════════════════ */

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const clampF = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : d; };
const up = (v) => String(v ?? "").trim().toUpperCase();
const r1 = (x) => Math.round(x * 10) / 10;

/* كود ميتا 131049 = ميتا نفسها حدّت رسايل التسويق للعميل ده (مش عطل عندنا) */
export const META_CAPPED_CODE = 131049;
/* الفاصل بين رسالتين واتساب لنفس العميل على قناة Cloud (الـSMS بيفضل ٣) */
export const CLOUD_MIN_GAP_DAYS = 7;
/* WK2210 (عمر ٢٢/١٠ «ابعت عادي متشغلش بالك بموضوع الاسبوع دا»): الفاصل ده بقى إعداد للمالك settings.waCloud.custGapDays (٣–٧، الافتراضي ٧).
   أقل من ٣ مش مسموح: فاصل waSender.gapDays (٣) بيفضل تحت منه. */
export const CLOUD_GAP_RANGE = Object.freeze([3, 7]);
export function cloudGapOf(settings) {
  const x = ((settings || {}).waCloud) || {};
  return clampN(x.custGapDays, CLOUD_GAP_RANGE[0], CLOUD_GAP_RANGE[1], CLOUD_MIN_GAP_DAYS);
}

/* ── سقف العميل ─────────────────────────────────────────────────────────── */
export const CUST_CAP_DEFAULTS = Object.freeze({ custCap7d: 1, custCap30d: 3 });
export function custCapOf(settings) {
  const x = ((settings || {}).waCloud) || {};
  const d7 = clampN(x.custCap7d, 1, 3, CUST_CAP_DEFAULTS.custCap7d);
  return { d7, d30: Math.max(d7, clampN(x.custCap30d, 1, 10, CUST_CAP_DEFAULTS.custCap30d)) };
}
/* n = { d7, d30 } عدد القوالب التسويقية اللي اتقبلت للعميل. بترجع سبب المنع أو null */
export function custCapReason(n, cap) {
  if ((Number(n?.d7) || 0) >= cap.d7) return "marketing_cap_7d";
  if ((Number(n?.d30) || 0) >= cap.d30) return "marketing_cap_30d";
  return null;
}

/* ── سلّم التسخين ───────────────────────────────────────────────────────── */
export const WARMUP_DEFAULTS = Object.freeze({ steps: Object.freeze([{ days: 3, cap: 30 }, { days: 4, cap: 50 }, { days: 7, cap: 100 }]), stepUpStopPct: 1, minStepSends: 20 });
/* الحدود: لحد ٦ درجات، كل درجة ١–٣٠ يوم وسقفها ١–١٠٠٠، والسقوف مابتنزلش من درجة للي بعدها. السلّم مالوش مفتاح إلغاء. */
export function warmupCfg(w) {
  const o = w && typeof w === "object" ? w : {};
  let steps = (Array.isArray(o.steps) ? o.steps : []).slice(0, 6)
    .map((s) => ({ days: clampN(s && s.days, 1, 30, null), cap: clampN(s && s.cap, 1, 1000, null) })).filter((s) => s.days && s.cap);
  if (!steps.length) steps = WARMUP_DEFAULTS.steps.map((s) => ({ ...s }));
  let prev = 0;
  steps = steps.map((s) => { const cap = Math.max(s.cap, prev); prev = cap; return { days: s.days, cap }; });
  return { steps, stepUpStopPct: clampF(o.stepUpStopPct, 0.1, 5, WARMUP_DEFAULTS.stepUpStopPct), minStepSends: clampN(o.minStepSends, 1, 1000, WARMUP_DEFAULTS.minStepSends) };
}
/* يوم الرياض (UTC+3 ثابت) بصيغة YYYY-MM-DD */
export const riyadhDay = (ms) => new Date(Number(ms) + 3 * 3600_000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000);
const okDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
export function warmupClean(state) {
  const s = state && typeof state === "object" ? state : {};
  if (!okDay(s.since)) return null;
  return { step: clampN(s.step, 0, 6, 0), since: String(s.since), startedAt: okDay(s.startedAt) ? String(s.startedAt) : String(s.since),
    refused: s.refused && typeof s.refused === "object" ? { at: String(s.refused.at || ""), why: String(s.refused.why || "").slice(0, 40), stopPct: Number(s.refused.stopPct) || 0, sent: Number(s.refused.sent) || 0 } : null,
    history: (Array.isArray(s.history) ? s.history : []).slice(-12) };
}
export const warmupStart = (today) => ({ step: 0, since: today, startedAt: today, refused: null, history: [] });
/* الحالة ⇒ اللي اللوحة بتعرضه. cap = السقف المطبّق النهارده (عمره ما يعدّي dailyCap). */
export function warmupView(state, wc, { today, dailyCap }) {
  const st = warmupClean(state), n = wc.steps.length;
  const steps = wc.steps.map((s, i) => ({ step: i + 1, days: s.days, cap: Math.min(s.cap, dailyCap) }));
  if (!st) return { started: false, step: 1, stepsTotal: n, cap: Math.min(wc.steps[0].cap, dailyCap), day: 0, dayInStep: 0, stepDays: wc.steps[0].days, finished: false, due: false, startedAt: null, since: null, refused: null, steps, dailyCap };
  const finished = st.step >= n;
  const dayInStep = Math.max(1, dayDiff(today, st.since) + 1);
  return { started: true, step: Math.min(st.step, n) + 1, stepsTotal: n, cap: finished ? dailyCap : Math.min(wc.steps[st.step].cap, dailyCap),
    day: Math.max(1, dayDiff(today, st.startedAt) + 1), dayInStep, stepDays: finished ? null : wc.steps[st.step].days, finished,
    due: !finished && dayInStep > wc.steps[st.step].days, startedAt: st.startedAt, since: st.since, refused: finished ? null : st.refused, steps, dailyCap };
}
/* مرة في الدورة: لو مدة الدرجة خلصت، نطلع درجة واحدة بس بشرطين — وإلا نسجّل سبب الرفض.
   stats = { sent, stopped } لرسايل الدرجة الحالية (من since). quality = جودة الرقم الحالية (GREEN شرط). */
export function warmupAdvance(state, wc, { today, stats, quality }) {
  const st = warmupClean(state);
  if (!st || st.step >= wc.steps.length) return { state: st, changed: false };
  const dayInStep = dayDiff(today, st.since) + 1;
  if (dayInStep <= wc.steps[st.step].days) return { state: st, changed: false };
  const sent = Number(stats?.sent) || 0, stopped = Number(stats?.stopped) || 0;
  const stopPct = sent ? r1((stopped / sent) * 100) : 0;
  const q = up(quality);
  const why = q !== "GREEN" ? `quality_${q || "unreadable"}` : sent < wc.minStepSends ? "not_enough_sends" : stopPct >= wc.stepUpStopPct ? "stop_rate" : null;
  if (why) {
    const refused = { at: today, why, stopPct, sent };
    const same = st.refused && st.refused.why === why && st.refused.at === today && st.refused.sent === sent && st.refused.stopPct === stopPct;
    return { state: { ...st, refused }, changed: !same, refused };
  }
  return { state: { ...st, step: st.step + 1, since: today, refused: null, history: [...st.history, { at: today, from: st.step + 1, to: st.step + 2, sent, stopPct }].slice(-12) }, changed: true, steppedUp: true };
}

/* ── حد الرقم / المحفظة ─────────────────────────────────────────────────── */
/* TIER_250 / TIER_1K / TIER_2K / TIER_10K / TIER_100K / TIER_UNLIMITED ⇒ رقم للمقارنة؛ أي صيغة تانية = null (مانقارنش) */
export function tierRank(v) {
  const s = up(v);
  if (!s) return null;
  if (/UNLIMITED/.test(s)) return Infinity;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(K|M)?$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "K" ? 1000 : m[2] === "M" ? 1e6 : 1);
}
export const tierDown = (prev, cur) => { const a = tierRank(prev), b = tierRank(cur); return a != null && b != null && b < a; };

/* ── أحداث الويب هوك ────────────────────────────────────────────────────── */
/* أحداث الحساب اللي بتوقّف الحملات (account_update.event) */
export const ACCOUNT_STOP_EVENTS = Object.freeze(["ACCOUNT_VIOLATION", "ACCOUNT_RESTRICTION", "DISABLED_UPDATE", "ACCOUNT_DISABLED", "BUSINESS_VIOLATION", "MESSAGING_LIMIT_DECREASE"]);
/* حالات قالب معناها «ميتا وقّفته بسبب الجودة». المرفوض/غير المقدَّم مش هنا: إرساله بيفشل بكوده ومساره القديم زي ما هو. */
const TEMPLATE_BAD_STATUS = ["PAUSED", "DISABLED", "FLAGGED"];
/* حدث خام من parseWebhook ⇒ صف يتخزّن (wa_quality_events)، أو null لو مايهمّناش */
export function qualityEventRow(e) {
  if (!e || !e.kind) return null;
  const ev = up(e.event), state = up(e.state);
  if (e.kind === "phone") return ev ? { kind: "phone", event: ev, state: null, name: null, language: null, tier: e.tier ? up(e.tier) : null } : null;
  if (e.kind === "template") return (state || ev) && e.name ? { kind: "template", event: ev || null, state: state || null, name: String(e.name).slice(0, 120), language: e.language ? String(e.language).slice(0, 12) : null, tier: null } : null;
  if (e.kind === "account") return ev ? { kind: "account", event: ev, state: null, name: null, language: null, tier: null } : null;
  return null;
}
/* آخر حدث لكل موضوع هو اللي بيتحسب (FLAGGED وبعده UNFLAGGED = تمام). بترجع أول سبب إيقاف أو null.
   events = صفوف wa_quality_events بترتيب الوصول (الأقدم أولاً). templates = أسماء قوالب الحملات الشغّالة. */
export function eventsVerdict(events, templates = []) {
  let phone = null, account = null; const tpl = new Map();
  for (const e of events || []) {
    if (e.kind === "phone") phone = e;
    else if (e.kind === "account") { if (ACCOUNT_STOP_EVENTS.includes(up(e.event))) account = e; }
    else if (e.kind === "template" && e.name) tpl.set(e.name, { ...(tpl.get(e.name) || {}), ...(e.state ? { state: up(e.state) } : {}), ...(e.event ? { event: up(e.event) } : {}) });
  }
  if (account) return { reason: "quality_account", detail: up(account.event) };
  if (phone && up(phone.event) === "FLAGGED") return { reason: "quality_flagged", detail: "FLAGGED" };
  if (phone && up(phone.event) === "DOWNGRADE") return { reason: "quality_tier_down", detail: phone.tier || "DOWNGRADE" };
  for (const name of templates) {
    const t = tpl.get(name);
    if (!t) continue;
    if (t.state && !["GREEN", "UNKNOWN"].includes(t.state)) return { reason: `quality_template_${t.state}`, detail: name };
    if (t.event && TEMPLATE_BAD_STATUS.includes(t.event)) return { reason: `quality_template_${t.event}`, detail: name };
  }
  return null;
}

/* ── الحكم ──────────────────────────────────────────────────────────────────
   phone      رد wacloud.phoneInfo: { ok, quality, tier, portfolio:{ok,limit}, health, checkedAt }
   prev       آخر حد شفناه: { tier, portfolio }
   events     أحداث الويب هوك اللي لسه مااتعالجتش
   templates  [{ name, status, quality }] لقوالب الحملات الشغّالة (من ميتا)؛ tplOk=false ⇒ ماقدرناش نقراها
   بترجع { ok:true, state, tier, portfolio } | { ok:false, hold:true, reason:"quality_unreadable", detail } | { ok:false, stop:true, reason, detail } */
export function qualityVerdict({ phone, prev = null, events = [], templates = [], tplOk = true, running = [], allowUnknown = false, maxAgeMs = 10 * 60_000, now = Date.now() } = {}) {
  const hold = (detail) => ({ ok: false, hold: true, reason: "quality_unreadable", detail });
  const stop = (reason, detail = null) => ({ ok: false, stop: true, reason, detail });
  const ev = eventsVerdict(events, running);
  if (ev) return stop(ev.reason, ev.detail);
  if (!phone || phone.ok !== true) return hold(phone && phone.error ? `phone:${String(phone.error).slice(0, 60)}` : "phone_not_read");
  const at = phone.checkedAt ? Date.parse(phone.checkedAt) : NaN;
  if (!Number.isFinite(at) || now - at > maxAgeMs) return hold("phone_read_stale");
  const q = up(phone.quality);
  if (!q) return hold("quality_missing");
  if (q !== "GREEN" && !(q === "UNKNOWN" && allowUnknown)) return stop(`quality_${q}`.slice(0, 40), null);
  if (up(phone.health) === "BLOCKED") return stop("quality_blocked", null);
  const portfolio = phone.portfolio && phone.portfolio.ok ? phone.portfolio.limit : null;
  if (prev && tierDown(prev.tier, phone.tier)) return stop("quality_tier_down", `${up(prev.tier)}>${up(phone.tier)}`);
  if (prev && tierDown(prev.portfolio, portfolio)) return stop("quality_tier_down", `${up(prev.portfolio)}>${up(portfolio)}`);
  if (running.length) {
    if (!tplOk) return hold("templates_not_read");
    for (const name of running) {
      for (const t of templates.filter((x) => x.name === name)) {
        const tq = up(t.quality);
        if (tq && !["GREEN", "UNKNOWN"].includes(tq)) return stop(`quality_template_${tq}`.slice(0, 40), name);
        if (TEMPLATE_BAD_STATUS.includes(up(t.status))) return stop(`quality_template_${up(t.status)}`.slice(0, 40), name);
      }
    }
  }
  return { ok: true, state: q, tier: phone.tier || null, portfolio: portfolio || null };
}

/* ── فرامل الحملة الجديدة ───────────────────────────────────────────────── */
/* تحذير ١٪: الحملة تكمّل بنص السرعة والمالك ياخد تنبيه واحد. n = { sent, failed, stopped } */
export function brakeWarn(n, cc) {
  const sent = Number(n?.sent) || 0, failed = Number(n?.failed) || 0, stopped = Number(n?.stopped) || 0;
  if (sent + failed < cc.brakeMinSends || !sent) return null;
  const pct = (stopped / sent) * 100;
  return pct >= cc.brakeWarnPct && pct < cc.brakeStopPct ? { reason: "stop_warn", pct: r1(pct), limit: cc.brakeWarnPct } : null;
}
/* قراءة ضعيفة: بعد lowReadMinDelivered رسالة وصلت و lowReadHours ساعة من أول إرسال، لو المقروء أقل من lowReadPct٪ ⇒ الحملة تقف.
   n = { delivered, read, firstSentAt } (من بعد آخر «كمّل» من المالك) */
export function lowReadCheck(n, cc, now = Date.now()) {
  const delivered = Number(n?.delivered) || 0, read = Number(n?.read) || 0;
  const first = n?.firstSentAt ? new Date(n.firstSentAt).getTime() : NaN;
  if (delivered < cc.lowReadMinDelivered || !Number.isFinite(first) || now - first < cc.lowReadHours * 3600_000) return null;
  const pct = (read / delivered) * 100;
  return pct < cc.lowReadPct ? { reason: "low_read", pct: r1(pct), limit: cc.lowReadPct } : null;
}

/* إعدادات الجودة داخل settings.waCloud (بتتنادى من cloudCfg). stopPct = حد الإيقاف بعد التنضيف. */
export const QUALITY_DEFAULTS = Object.freeze({ brakeWarnPct: 1, lowReadMinDelivered: 50, lowReadHours: 6, lowReadPct: 40, cappedFallbackSms: false,
  allowUnknownQuality: false, qualityMaxAgeMin: 10, custCap7d: 1, custCap30d: 3, custGapDays: CLOUD_MIN_GAP_DAYS });
export const QUALITY_KEYS = Object.freeze(["brakeWarnPct", "lowReadMinDelivered", "lowReadHours", "lowReadPct", "cappedFallbackSms", "allowUnknownQuality", "qualityMaxAgeMin", "custCap7d", "custCap30d", "custGapDays", "warmup"]);
export function qualityCfg(x = {}, stopPct = 2) {
  const cap = custCapOf({ waCloud: x });
  return {
    brakeWarnPct: Math.min(stopPct, clampF(x.brakeWarnPct, 0.1, 100, QUALITY_DEFAULTS.brakeWarnPct)),
    lowReadMinDelivered: clampN(x.lowReadMinDelivered, 10, 1000, QUALITY_DEFAULTS.lowReadMinDelivered),
    lowReadHours: clampN(x.lowReadHours, 1, 72, QUALITY_DEFAULTS.lowReadHours),
    lowReadPct: clampF(x.lowReadPct, 0, 100, QUALITY_DEFAULTS.lowReadPct),            // صفر = الفرملة دي مقفولة
    cappedFallbackSms: x.cappedFallbackSms === true,
    allowUnknownQuality: x.allowUnknownQuality === true,
    qualityMaxAgeMin: clampN(x.qualityMaxAgeMin, 1, 10, QUALITY_DEFAULTS.qualityMaxAgeMin),
    custCap7d: cap.d7, custCap30d: cap.d30,
    custGapDays: cloudGapOf({ waCloud: x }),      // WK2210
    warmup: warmupCfg(x.warmup),
  };
}

/* ترحيل مرة واحدة: القيم القديمة الافتراضية (٥٪ بعد ٢٠) اتخزّنت مع أي حفظ من اللوحة، فالافتراضي الجديد (٢٪ بعد ٣٠) مايوصلش لوحده.
   بنشدّد بس (عمرنا ما بنرخّي)، ومرة واحدة (rev=2) — بعدها أي رقم المالك يكتبه يفضل. */
export function migrateQuality(waCloud) {
  const w = waCloud && typeof waCloud === "object" ? waCloud : null;
  if (!w || Number(w.rev) >= 2) return { changed: false, next: w };
  const next = { ...w, rev: 2 };
  if (Number(w.brakeStopPct) === 5) next.brakeStopPct = 2;
  if (Number(w.brakeMinSends) === 20) next.brakeMinSends = 30;
  return { changed: true, next, from: { brakeStopPct: w.brakeStopPct ?? null, brakeMinSends: w.brakeMinSends ?? null } };
}

/* نص التنبيه للمالك (SMS واحد + حدث للبورتال). مفيش أرقام عملاء ولا أسرار.
   العربي لازم يفضل رسالة واحدة (٧٠ حرف) — الاختبار بيتأكد. */
const WHY_AR = { quality_YELLOW: "جودة الرقم نزلت", quality_RED: "جودة الرقم ضعيفة", quality_UNKNOWN: "مفيش تقييم جودة",
  quality_flagged: "ميتا علّمت على الرقم", quality_tier_down: "حد الرسايل نزل", quality_account: "تنبيه على الحساب", quality_blocked: "الإرسال ممنوع" };
const WHY_EN = { quality_YELLOW: "number quality dropped to MEDIUM", quality_RED: "number quality is LOW", quality_UNKNOWN: "Meta gives the number no quality rating",
  quality_flagged: "Meta flagged the number", quality_tier_down: "Meta lowered the messaging limit", quality_account: "Meta raised an account alert", quality_blocked: "Meta blocked sending from the number" };
export const QUALITY_REASONS = Object.freeze(Object.keys(WHY_AR));
export function qualityAlertText(reason, detail = null, lang = "ar") {
  const tpl = /^quality_template_/.test(String(reason));
  if (lang === "ar") return `فريش كاتس: حملات واتساب اتوقفت (${tpl ? "قالب جودته نزلت" : WHY_AR[reason] || "مشكلة جودة"}). راجع اللوحة.`;
  const why = tpl ? `template ${String(detail || "?").slice(0, 40)} lost quality at Meta` : WHY_EN[reason] || "a quality problem at Meta";
  return `Fresh Cuts: all WhatsApp campaigns paused - ${why}. Only the owner can resume from the dashboard.`;
}
export function warnAlertText(pct, lang = "ar") {
  return lang === "ar" ? `فريش كاتس: حملة واتساب نسبة الإيقاف فيها ${pct}% - مكمّلة بنص السرعة.`
    : `Fresh Cuts: a WhatsApp campaign has a ${pct}% stop rate - it continues at half speed. Review it in the dashboard.`;
}
