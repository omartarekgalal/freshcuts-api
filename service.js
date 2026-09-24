/* ⏸️ إيقاف الخدمة مؤقتاً (٢٣/٩) — «المطبخ مضغوط، وقّف التوصيل نص ساعة».
   ──────────────────────────────────────────────────────────────────────
   المشكلة اللي بيحلّها: قبل كده مكانش فيه غير حيلتين — تقفل المطعم كله من
   المواعيد، أو تنزّل نطاق التوصيل لصفر. التانية بتقول للعميل «عنوانك خارج
   نطاق التوصيل» — كلام مش صحيح، وشكله دايم مش مؤقت، وبيلوّث تقارير التغطية.

   الفكرة: مفتاح لكل قناة على حدة (توصيل / استلام) بوقت رجوع اختياري، والرجوع
   بيحصل **من نفسه** لما الوقت يعدّي — مفيش كرون ولا حاجة تفتكر. الحالة
   بتتحسب وقت القراية، فمستحيل تفضل مقفولة بالغلط.

   وبيعيد استخدام ماكينة «نبّهني لما تفتحوا» (openwait.js) زي ما هي: اللي
   حاول يطلب والخدمة موقوفة بيسيب رقمه وسلته، وأول ما نرجع بتوصله رسالة
   برابط سلته. مفيش طابور جديد ولا رسايل جديدة.

   ملاحظة مهمة: ده **مش** بديل لمواعيد العمل. المواعيد بتقفل المطعم كله،
   وده بيوقف قناة واحدة لفترة قصيرة والباقي شغّال.                       */

import { bizDay, bizHourIndex, riyadhHour, RIYADH_OFFSET_H } from "./bizday.js";
import { APP_LABELS } from "./bizreports.js";

export const SERVICE_DEFAULTS = Object.freeze({
  delivery: { paused: false, until: null, reason: "" },
  pickup: { paused: false, until: null, reason: "" },
  note: "",
  resumedAt: null,          // آخر مرة رجعت فيها قناة — openwait بيبعت بعدها
});

export const CHANNELS = ["delivery", "pickup"];

/* الرسالة اللي العميل بيشوفها. صادقة ومؤقتة — مش «عنوانك بره النطاق». */
export const pausedText = (ch, until, reason, lang = "ar") => {
  const back = untilText(until, lang);
  if (lang === "en") {
    const what = ch === "pickup" ? "Pickup" : "Delivery";
    return `${what} is paused for a short while${back ? ` — back ${back}` : ""}.${reason ? ` ${reason}` : ""}`;
  }
  const what = ch === "pickup" ? "الاستلام من المطعم متوقف" : "التوصيل متوقف";
  return `${what} مؤقتاً${back ? ` — نرجع ${back}` : ""}.${reason ? ` ${reason}` : ""}`;
};

function untilText(until, lang = "ar") {
  if (!until) return "";
  const t = new Date(until);
  if (!Number.isFinite(t.getTime())) return "";
  const hhmm = t.toLocaleTimeString(lang === "en" ? "en-GB" : "ar-SA", {
    hour: "2-digit", minute: "2-digit", hour12: lang !== "en", timeZone: "Asia/Riyadh",
  });
  return lang === "en" ? `at ${hhmm}` : `الساعة ${hhmm}`;
}

const chanIn = (v) => {
  const o = v && typeof v === "object" ? v : {};
  const until = o.until ? new Date(o.until) : null;
  return {
    paused: o.paused === true,
    until: until && Number.isFinite(until.getTime()) ? until.toISOString() : null,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 120) : "",
  };
};

/* serviceCfg(settings) → الشكل المخزّن، متحقَّق منه. */
export function serviceCfg(settings) {
  const raw = ((settings || {}).service) || {};
  return {
    delivery: chanIn(raw.delivery),
    pickup: chanIn(raw.pickup),
    note: typeof raw.note === "string" ? raw.note.slice(0, 200) : "",
    resumedAt: raw.resumedAt || null,
  };
}

/* serviceState(settings, now) → الحالة **الفعلية** دلوقتي.
   `until` اللي عدّى = القناة رجعت، من غير ما حد يعمل حاجة. `expired` بيقول
   للمتصل إن المخزّن بقى قديم ويستاهل تنضيف (تنضيف كسول، مش شرط).        */
export function serviceState(settings, now = new Date()) {
  const cfg = serviceCfg(settings);
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = { note: cfg.note, expired: [], anyPaused: false };
  for (const ch of CHANNELS) {
    const c = cfg[ch];
    const lapsed = Boolean(c.paused && c.until && new Date(c.until).getTime() <= t);
    const paused = Boolean(c.paused && !lapsed);
    if (lapsed) out.expired.push(ch);
    if (paused) out.anyPaused = true;
    out[ch] = { open: !paused, paused, until: paused ? c.until : null, reason: paused ? c.reason : "" };
  }
  out.allPaused = CHANNELS.every((ch) => out[ch].paused);
  return out;
}

/* الحارس اللي shop.js بيستخدمه قبل ما يفتح أي جلسة دفع. */
/* ═══ دقايق الإيقاف داخل نافذة (٢٣/٩) ══════════════════════════════════════
   عمر: «اعرف كل حاجة حصلت في الوقت دا». السؤال اللي بيسأله التقرير: التوصيل
   والاستلام كانوا واقفين كام دقيقة في المدى اللي اختاره.

   الأحداث جاية من portal_audit بترتيب تصاعدي: service_pause بيفتح فترة،
   service_resume بيقفلها، و«both» بيمسّ القناتين. حالتين لازم يتحسبوا صح:
     • أول حدث لقناة = resume ⇒ كانت واقفة من قبل بداية النافذة ⇒ من البداية.
     • آخر حدث = pause من غير resume ⇒ لسه واقفة ⇒ لحد نهاية النافذة.
   بنقصّ أي فترة على حدود النافذة عشان رقم مايزيدش عن طول النافذة نفسها.  */
export function pausedMinutesOf(events, range, hours, now = new Date()) {
  const end = range ? new Date(range[1]) : now;
  const start = range ? new Date(range[0]) : new Date(end.getTime() - hours * 3600_000);
  const s = start.getTime(), e = end.getTime();
  if (!(Number.isFinite(s) && Number.isFinite(e) && e > s)) return { delivery: 0, pickup: 0 };

  const out = { delivery: 0, pickup: 0 };
  for (const ch of CHANNELS) {
    const mine = (events || []).filter(
      (x) => x.channel === ch || x.channel === "both").map(
      (x) => ({ at: new Date(x.at).getTime(), pause: x.action === "service_pause" }))
      .filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);

    let openedAt = mine.length && !mine[0].pause ? s : null;  // كانت واقفة قبل البداية
    let total = 0;
    for (const ev of mine) {
      if (ev.pause) { if (openedAt == null) openedAt = ev.at; }
      else if (openedAt != null) {
        total += Math.max(0, Math.min(ev.at, e) - Math.max(openedAt, s));
        openedAt = null;
      }
    }
    if (openedAt != null) total += Math.max(0, e - Math.max(openedAt, s));
    out[ch] = Math.round(total / 60000);
  }
  return out;
}

/* ═══ ⏱ ساعة بساعة (٢٤/٩، طلب عمر) ═══════════════════════════════════════
   «اعرف بسهولة ايه كل حاجة حصلت في كل ساعة سواء في المطعم او المتجر او
   سلوك العميل على الموقع … مع اعتبار ان الساعة ١ و٢ و٣ صباحا يكونوا بعد ١٢
   مساءا وليس قبلهم في اي ترتيب».

   القاعدة اللي كل حاجة هنا مبنية عليها: اليوم التشغيلي بيبدأ ٤ الفجر بتوقيت
   الرياض (bizday.js)، فالساعة ١ الفجر ترتيبها **بعد** ٢٣ — `bizHourIndex`
   بيقول ده: ٤ ← 0 … ٢٣ ← 19 … ١ ← 21 … ٣ ← 23.

   الترتيب مضمون من مكانين بس، والاتنين هنا:
     • `hourSlots` — الخط الزمني: خانات ساعة بساعة من البداية للنهاية بترتيب
       الوقت الحقيقي. ٢٣ ← ٠٠ ← ٠١ لوحدها، لأن ده ترتيب اللحظات نفسها.
     • `hourProfile` — «ملف الساعات» على مدى أطول من يوم: مجموع كل ساعة من
       اليوم مرتّب بـ`bizHourIndex`، مش بالرقم الخام.
   الواجهة مابتعملش sort ولا مرة — بتعرض المصفوفة زي ما هي.

   ليه الساعة بمفتاح نصّي «YYYY-MM-DD HH» (بتوقيت الرياض)؟ عشان نفس المفتاح
   بالظبط يطلع من SQL (`to_char(col AT TIME ZONE 'Asia/Riyadh','YYYY-MM-DD
   HH24')`) ومن JS، فالربط بين مصادر البيانات مايحتاجش أي حساب مناطق زمنية
   تاني. الفخ اللي عضّ المشروع أكتر من مرة: جلسة بوستجريس UTC، فأي ساعة من
   غير `AT TIME ZONE 'Asia/Riyadh'` بتطلع غلط بـ٣ ساعات.                  */

export const HOUR_MS = 3600_000;
/* أقصى عدد خانات في الخط الزمني — بعد كده الجدول مايتقراش، فبنعرض آخر ٨ أيام
   ونقول للواجهة إن فيه حاجة اتقصّت. ملف الساعات بيفضل على المدى كله. */
export const MAX_HOUR_SLOTS = 192;

const msOf = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));

/** مفتاح ساعة الرياض للحظة: «YYYY-MM-DD HH». نفس اللي to_char بيرجّعه. */
export function riyadhHourKey(ts) {
  const ms = msOf(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + RIYADH_OFFSET_H * HOUR_MS); // حقول UTC = ساعة الرياض
  return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, "0")}`;
}

/**
 * خانات الساعات بين لحظتين، **بترتيب الوقت الحقيقي**.
 * كل خانة: { key, hour (0–23 الرياض), bizDay, bizHourIndex, hourStartUtc,
 *            fromUtc, toUtc (مقصوصين على حدود النافذة), minutes, partial }
 * الرياض UTC+3 بالظبط وفرقها ساعات كاملة، فبداية الساعة واحدة في UTC وفي
 * الرياض — عشان كده المحاذاة بـfloor على الساعة كفاية.
 */
export function hourSlots(startUtc, endUtc, { max = MAX_HOUR_SLOTS } = {}) {
  const s0 = msOf(startUtc), s1 = msOf(endUtc);
  if (!(Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0)) return { slots: [], total: 0, truncated: false };
  const first = Math.floor(s0 / HOUR_MS) * HOUR_MS;
  const total = Math.ceil((s1 - first) / HOUR_MS);
  // لو النافذة أطول من المسموح بنعرض آخر `max` ساعة (اللي بتهم دلوقتي)
  const from = total > max ? first + (total - max) * HOUR_MS : first;
  const slots = [];
  for (let t = from; t < s1; t += HOUR_MS) {
    const h = riyadhHour(t);
    const fromUtc = Math.max(t, s0), toUtc = Math.min(t + HOUR_MS, s1);
    slots.push({
      key: riyadhHourKey(t), hour: h, bizDay: bizDay(t), bizHourIndex: bizHourIndex(h),
      hourStartUtc: new Date(t).toISOString(),
      fromUtc: new Date(fromUtc).toISOString(), toUtc: new Date(toUtc).toISOString(),
      minutes: Math.round((toUtc - fromUtc) / 60000),
      partial: fromUtc !== t || toUtc !== t + HOUR_MS,
    });
  }
  return { slots, total, truncated: total > max };
}

/* دلاء القنوات: نفس تعريف bizreports.js بالحرف (classifyPos) — بنجمّع بس
   التطبيقات كلها في دلو واحد للعرض، وبنسيب تفصيل كل تطبيق جنبه. */
export const HOUR_CHANNELS = ["hall", "takeaway", "own_delivery", "store", "apps"];
export const hourChannelOf = (ch) => (String(ch || "").startsWith("app:") ? "apps" : HOUR_CHANNELS.includes(ch) ? ch : "other");

const zeroCh = () => Object.fromEntries([...HOUR_CHANNELS, "other"].map((k) => [k, { n: 0, sar: 0 }]));
const bumpCh = (o, n, sar) => { o.n += n; o.sar += sar; };
const r0 = (v) => Math.round(Number(v) || 0);
const r2sar = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * يركّب الخط الزمني: خانات الساعات + الطلبات + الزوار + الصرف + دقايق
 * الإيقاف + إشارات «إيه اللي أثّر». مافيش DB هنا — دالة صافية متختبرة.
 *
 * orders:   صفوف bizreports الموحّدة { ch, ts, total }  (مبيعات بس)
 * visitors: [{ hkey, sessions, cart, paid, known }]     (journey_sessions)
 * stuck:    [{ hkey, n }]                               (طلبات موقع وقفت على الدفع)
 * spend:    [{ hkey, sar }]                             (ad_spend_hourly)
 * flags:    [{ hkey, kind }]                            («خلص»/رجع/وقف باقة)
 * pauses:   أحداث portal_audit كاملة للنافذة (pausedMinutesOf بيقصّها لكل ساعة)
 */
export function buildHourly({ slots = [], orders = [], visitors = [], stuck = [], spend = [], flags = [], pauses = [] } = {}) {
  const byKey = new Map();
  const apps = new Map();
  for (const s of slots) {
    byKey.set(s.key, {
      ...s,
      orders: { n: 0, sar: 0 }, ch: zeroCh(), apps: {},
      visitors: { sessions: 0, cart: 0, paid: 0, known: 0 },
      stuck: 0, spend: 0, soldOut: 0, reopened: 0,
      pausedMin: { delivery: 0, pickup: 0 },
    });
  }
  for (const o of orders) {
    const row = byKey.get(riyadhHourKey(o.ts));
    if (!row) continue;                       // برّه الخانات المعروضة (مدى مقصوص)
    const s = Number(o.total) || 0;
    bumpCh(row.orders, 1, s);
    bumpCh(row.ch[hourChannelOf(o.ch)], 1, s);
    if (String(o.ch || "").startsWith("app:")) {
      const a = o.ch.slice(4);
      row.apps[a] = row.apps[a] || { n: 0, sar: 0 };
      bumpCh(row.apps[a], 1, s);
      apps.set(a, (apps.get(a) || 0) + 1);
    }
  }
  for (const v of visitors) {
    const row = byKey.get(v.hkey); if (!row) continue;
    row.visitors = { sessions: r0(v.sessions), cart: r0(v.cart), paid: r0(v.paid), known: r0(v.known) };
  }
  for (const s of stuck) { const row = byKey.get(s.hkey); if (row) row.stuck = r0(s.n); }
  for (const s of spend) { const row = byKey.get(s.hkey); if (row) row.spend = r2sar(s.sar); }
  for (const f of flags) {
    const row = byKey.get(f.hkey); if (!row) continue;
    if (f.kind === "closed") row.soldOut += 1; else row.reopened += 1;
  }
  const hours = slots.map((s) => byKey.get(s.key));
  // دقايق الإيقاف لكل ساعة — نفس الدالة المتختبرة، مقصوصة على حدود الساعة
  for (const h of hours) {
    h.pausedMin = pausedMinutesOf(pauses, [h.fromUtc, h.toUtc]);
    h.orders.sar = r2sar(h.orders.sar);
    for (const k of Object.keys(h.ch)) h.ch[k].sar = r2sar(h.ch[k].sar);
  }
  return {
    hours,
    apps: [...apps.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
    hasOwnDelivery: hours.some((h) => h.ch.own_delivery.n > 0),
    hasOther: hours.some((h) => h.ch.other.n > 0),
    totals: hourTotals(hours),
  };
}

/** مجموع الخط الزمني — عشان الواجهة ماتجمعش بنفسها وتختلف عن الكروت. */
export function hourTotals(hours = []) {
  const t = {
    orders: { n: 0, sar: 0 }, ch: zeroCh(),
    visitors: { sessions: 0, cart: 0, paid: 0, known: 0 },
    stuck: 0, spend: 0, soldOut: 0, pausedMin: { delivery: 0, pickup: 0 },
  };
  for (const h of hours) {
    bumpCh(t.orders, h.orders.n, h.orders.sar);
    for (const k of Object.keys(t.ch)) bumpCh(t.ch[k], h.ch[k].n, h.ch[k].sar);
    for (const k of Object.keys(t.visitors)) t.visitors[k] += h.visitors[k];
    t.stuck += h.stuck; t.spend += h.spend; t.soldOut += h.soldOut;
    t.pausedMin.delivery += h.pausedMin.delivery; t.pausedMin.pickup += h.pausedMin.pickup;
  }
  t.orders.sar = r2sar(t.orders.sar);
  t.spend = r2sar(t.spend);
  for (const k of Object.keys(t.ch)) t.ch[k].sar = r2sar(t.ch[k].sar);
  return t;
}

/**
 * ملف الساعات: كل ساعة من اليوم مجمّعة على أيام المدى، **مرتّبة بترتيب اليوم
 * التشغيلي** (٤ الفجر أول حاجة، ٣ الفجر آخر حاجة) — فـ١ الفجر بعد ٢٣ دايماً.
 * `days` = كام يوم تشغيلي فيه الساعة دي فعلاً في المدى (عشان المتوسط).
 */
export function hourProfile(hours = []) {
  const by = new Map();
  for (const h of hours) {
    let p = by.get(h.hour);
    if (!p) {
      p = { hour: h.hour, bizHourIndex: h.bizHourIndex, days: new Set(), orders: 0, sar: 0, sessions: 0, cart: 0, paid: 0, spend: 0, pausedMin: 0 };
      by.set(h.hour, p);
    }
    p.days.add(h.bizDay);
    p.orders += h.orders.n; p.sar += h.orders.sar;
    p.sessions += h.visitors.sessions; p.cart += h.visitors.cart; p.paid += h.visitors.paid;
    p.spend += h.spend; p.pausedMin += h.pausedMin.delivery;
  }
  return [...by.values()]
    .sort((a, b) => a.bizHourIndex - b.bizHourIndex)
    .map((p) => ({
      hour: p.hour, bizHourIndex: p.bizHourIndex, days: p.days.size,
      orders: p.orders, sar: r2sar(p.sar),
      ordersPerDay: p.days.size ? Math.round((p.orders / p.days.size) * 100) / 100 : null,
      sessions: p.sessions, cart: p.cart, paid: p.paid,
      spend: r2sar(p.spend), pausedMin: p.pausedMin,
    }));
}

/** حل نافذة التقرير من الـquery: hours= أو from=&to= (ISO). */
export function resolveWindow({ hours, from, to } = {}, now = new Date()) {
  const nowMs = msOf(now);
  const h = Math.min(24 * 30, Math.max(1, Number(hours) || 24));
  const a = from ? Date.parse(from) : NaN, b = to ? Date.parse(to) : NaN;
  const custom = Number.isFinite(a) && Number.isFinite(b) && b > a;
  let start = custom ? a : nowMs - h * HOUR_MS;
  const end = custom ? b : nowMs;
  if (end - start > 31 * 864e5) start = end - 31 * 864e5;   // سقف شهر
  // مافيش بيانات في المستقبل — القراية بتتقطع عند دلوقتي، بس المدى المطلوب
  // بيفضل معروض زي ما هو عشان محدش يفتكر إن الشاشة غيّرت اختياره.
  const cut = Math.min(end, nowMs);
  return {
    custom, hours: h,
    start: new Date(start), end: new Date(end), cut: new Date(Math.max(start + 1, cut)),
    partial: end > nowMs,
  };
}

export function serviceBlock(settings, option, now = new Date(), lang = "ar") {
  const ch = option === "pickup" ? "pickup" : "delivery";
  const st = serviceState(settings, now);
  if (!st[ch].paused) return null;
  const other = ch === "delivery" ? "pickup" : "delivery";
  return {
    error: "service_paused",
    channel: ch,
    until: st[ch].until,
    otherOpen: st[other].open,
    message: pausedText(ch, st[ch].until, st[ch].reason || st.note, lang),
  };
}

/* التغيير نفسه، متاح للوحة وللبوابة (كل واحدة بصلاحيتها). مفيش نسخة تانية
   من القواعد — الاتنين بينادوا على ده.                                    */
export async function applyService(ctx, b = {}) {
  const { pool, getSettingsData, jb } = ctx;
  const now = new Date();
  const s = await getSettingsData();
  const cfg = serviceCfg(s);
  const chans = b.channel === "both" ? CHANNELS : [b.channel === "pickup" ? "pickup" : "delivery"];
  const paused = b.paused === true;
  let until = null;
  if (paused) {
    if (b.until) { const d = new Date(b.until); if (Number.isFinite(d.getTime())) until = d.toISOString(); }
    else if (Number(b.minutes) > 0) until = new Date(now.getTime() + Math.min(24 * 60, Number(b.minutes)) * 60000).toISOString();
  }
  let resumedAny = false;
  for (const ch of chans) {
    if (!paused && cfg[ch].paused) resumedAny = true;
    cfg[ch] = { paused, until, reason: paused ? String(b.reason || "").slice(0, 120) : "" };
  }
  if (typeof b.note === "string") cfg.note = b.note.slice(0, 200);
  if (resumedAny) cfg.resumedAt = now.toISOString();
  await pool.query(
    `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{service}', $1::jsonb, true), updated_at = NOW() WHERE id=1`,
    [jb(cfg)]);
  return serviceState({ service: cfg }, now);
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  /* getter متأخر: index.js بيسجّل service قبل bizreports، فبناخد المقبض وقت
     الطلب مش وقت التسجيل. نفس الشكل اللي adsreport بيستعمله. */
  const bizOf = () => (typeof deps.biz === "function" ? deps.biz() : deps.biz) || null;
  /* «دلوقتي» قابلة للحقن عشان الاختبارات تثبّت النافذة — في الإنتاج الساعة الحقيقية. */
  const nowOf = () => (typeof deps.now === "function" ? new Date(deps.now()) : new Date());

  const save = async (next) => {
    await pool.query(
      `UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{service}', $1::jsonb, true), updated_at = NOW() WHERE id=1`,
      [jb(next)]);
    return next;
  };

  /* لو وقت الرجوع عدّى بنمسح الإيقاف من التخزين كمان — عشان اللوحة تبان
     نضيفة، وعشان openwait يعرف إن فيه قناة رجعت دلوقتي. */
  async function settle(now = new Date()) {
    const s = await getSettingsData();
    const st = serviceState(s, now);
    if (!st.expired.length) return { s, st, changed: false };
    const cfg = serviceCfg(s);
    for (const ch of st.expired) cfg[ch] = { paused: false, until: null, reason: "" };
    cfg.resumedAt = new Date(now).toISOString();
    await save(cfg);
    return { s, st, changed: true, resumed: st.expired };
  }

  /* ── عام: المتجر بيقرا منها قبل ما يعرض أي حاجة ─────────────────────── */
  app.get("/api/service", async (c) => {
    const { st } = await settle();
    const lang = String(c.req.query("lang") || "ar") === "en" ? "en" : "ar";
    const body = { ok: true, note: st.note, anyPaused: st.anyPaused, allPaused: st.allPaused };
    for (const ch of CHANNELS) {
      body[ch] = { ...st[ch], text: st[ch].paused ? pausedText(ch, st[ch].until, st[ch].reason || st.note, lang) : "" };
    }
    return c.json(body);
  });

  /* ── إدارة: اللوحة والبوابة ──────────────────────────────────────────
     body: { channel:"delivery"|"pickup"|"both", paused:true|false,
             minutes?:30, until?:ISO, reason?:"" , note?:"" }            */
  const apply = (b) => applyService(ctx, b);

  /* ملاحظة: requireAdmin في المشروع ده **بيتنادى جوه** المعالِج ويرجّع
     Response أو null — مش وسيط Hono. لو اتحطّ كوسيط بيرجع «Context is not
     finalized» ٥٠٠ للتوكن الصح ويعدّي ٤٠١ للغلط، وده أسوأ شكل للعطل. */
  /* ── 📊 تقرير الإيقاف: إيه اللي حصل، ومين ضاع، ومين رجع ──────────────
     السؤال اللي عمر عايز يرد عليه في أي وقت: «قفلت الساعة كام، وكام واحد
     جه وأنا مقفول، وكام واحد سبنا رقمه، ووصلته الرسالة، ورجع طلب؟»
     المدى بالساعات (hours) أو from/to بتوقيت الرياض.                    */
  /* ⏱ ٢٤/٩ — «اعرف كل حاجة حصلت في كل ساعة … واختار الساعة او المدة او الوقت».
     النافذة بقت محسوبة في JS دايماً (resolveWindow) بدل `NOW() - INTERVAL`،
     عشان كل استعلام يشوف نفس الحدود بالظبط واللي الخط الزمني مبني عليها. */
  app.get("/api/service/report", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const win = resolveWindow({
      hours: c.req.query("hours"), from: c.req.query("from"), to: c.req.query("to"),
    }, nowOf());
    const hours = win.hours;
    const range = win.custom ? [win.start.toISOString(), win.end.toISOString()] : null;
    const W = { args: [win.start, win.cut] };
    /* حدود النافذة على عمود: البداية داخلة والنهاية برّه — عشان ساعة ماتتحسبش
       مرتين لو عمر اختار «من ٢٢ لـ٢٣» بعدها «من ٢٣ لـ٠٠». */
    const fence = (col) => `${col} >= $1::timestamptz AND ${col} < $2::timestamptz`;
    /* مفتاح ساعة الرياض — نفس شكل riyadhHourKey في JS. لازم AT TIME ZONE:
       جلسة بوستجريس UTC، وبدونها الساعة بتطلع غلط بـ٣ ساعات. */
    const HK = (col) => `to_char(${col} AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24')`;
    /* استعلام واقع بيرجّع [] عشان الشاشة كلها ماتقعش — بس بيتكتب في اللوج،
       لأن «أصفار في كل الساعات» شكلها زي ليلة فاضية بالظبط. */
    const q = (s, a = W.args) => pool.query(s, a).then((r) => r.rows).catch((e) => {
      const msg = `[service/report] ${String(e?.message || e).slice(0, 160)} :: ${s.replace(/\s+/g, " ").slice(0, 120)}`;
      try { (ctx.log?.error || console.error)(msg); } catch {}
      return [];
    });

    const [events, visitors, wait, sms, orders, sales, pos, paused,
           visitorsByHour, stuckByHour, spendByHour, flagRows] = await Promise.all([
      /* مين قفل/فتح، إمتى، وأي قناة */
      q(`SELECT at, staff_name, role, action, order_no AS channel, detail
           FROM portal_audit WHERE action LIKE 'service\\_%' AND ${fence('at')}
          ORDER BY at DESC LIMIT 200`),
      /* الزوار في نفس المدى — دي اللي بتقول «ضاع مني كام» */
      q(`SELECT count(*)::int AS sessions,
                count(*) FILTER (WHERE cart_max > 0)::int AS reached_cart,
                count(*) FILTER (WHERE phone_norm IS NOT NULL)::int AS known,
                count(*) FILTER (WHERE paid)::int AS paid,
                COALESCE(round(sum(cart_max) FILTER (WHERE cart_max > 0))::int, 0) AS cart_value
           FROM journey_sessions WHERE ${fence('started_at')}
            AND NOT COALESCE(is_bot,false) AND NOT COALESCE(is_qa,false) AND NOT COALESCE(is_staff,false)`),
      /* اللي سابوا رقمهم */
      q(`SELECT id, created_at, phone_norm, item_count, subtotal, option, source,
                notified_at, channel, skip_reason, order_no, order_total
           FROM open_waitlist WHERE ${fence('created_at')} ORDER BY created_at DESC LIMIT 200`),
      /* الرسايل اللي اتبعتت فعلاً — من سجل الرسايل مش من نيّتنا */
      q(`SELECT at, phone_norm, status, parts, cost, error
           FROM sms_log WHERE kind='waitlist' AND ${fence('at')} ORDER BY at DESC LIMIT 200`),
      /* ورجعوا طلبوا؟ */
      q(`SELECT count(*)::int AS n, COALESCE(round(sum(order_total))::int,0) AS sar
           FROM open_waitlist WHERE order_no IS NOT NULL AND ${fence('created_at')}`),
      /* ٢٣/٩ — طلب عمر «اعرف كل حاجة حصلت في الوقت دا»: طلبات المتجر نفسها،
         مش بس اللي جم من قايمة الانتظار. ساعة الرياض عشان الجدول يتقرا. */
      q(`SELECT count(*)::int AS n,
                COALESCE(round(sum(total))::int,0) AS sar,
                count(*) FILTER (WHERE option='delivery')::int AS delivery,
                count(*) FILTER (WHERE option='pickup')::int AS pickup,
                count(*) FILTER (WHERE status IN ('pending_payment','payment_failed'))::int AS unpaid
           FROM shop_orders WHERE ${fence('created_at')}`),
      /* ونقطة البيع كلها (صالة/سفري/تطبيقات) — دي اللي بتقول إيه اللي فات.
         الترتيب هنا **مش** بالساعة الخام: ١ الفجر لازم تيجي بعد ٢٣، فبنرتّب
         في JS بـbizHourIndex تحت. */
      q(`SELECT count(*)::int AS n, COALESCE(round(sum(total))::int,0) AS sar,
                to_char(date_trunc('hour', order_date AT TIME ZONE 'Asia/Riyadh'),'HH24') AS hh
           FROM ts_orders WHERE ${fence('order_date')}
          GROUP BY 3`),
      /* وكام دقيقة كانت الخدمة موقوفة في المدى ده */
      q(`SELECT action, at, order_no AS channel FROM portal_audit
          WHERE action LIKE 'service\_%' AND ${fence('at')} ORDER BY at ASC`),
      /* ── ⏱ مكوّنات الخط الزمني: كلها بمفتاح ساعة الرياض عشان تتلمّ في JS ──
         سلوك العميل على الموقع ساعة بساعة. «وصل للسلة» = cart_max > 0 —
         نفس تعريف كرت الزوار فوق بالظبط، فمجموع الساعات = رقم الكرت. */
      q(`SELECT ${HK("started_at")} AS hkey,
                count(*)::int AS sessions,
                count(*) FILTER (WHERE cart_max > 0)::int AS cart,
                count(*) FILTER (WHERE paid)::int AS paid,
                count(*) FILTER (WHERE phone_norm IS NOT NULL)::int AS known
           FROM journey_sessions WHERE ${fence('started_at')}
            AND NOT COALESCE(is_bot,false) AND NOT COALESCE(is_qa,false) AND NOT COALESCE(is_staff,false)
          GROUP BY 1`),
      /* اللي بدأ يدفع ومكمّلش — ساعة فيها الرقم ده عالي = الشيك أوت واقع */
      q(`SELECT ${HK("created_at")} AS hkey, count(*)::int AS n
           FROM shop_orders
          WHERE ${fence('created_at')} AND status IN ('pending_payment','payment_failed')
          GROUP BY 1`),
      /* الصرف الإعلاني بالساعة (ad_spend_hourly جاهز بساعات كاملة) */
      q(`SELECT ${HK("hour_start")} AS hkey, COALESCE(sum(spend),0) AS sar
           FROM ad_spend_hourly WHERE ${fence('hour_start')} GROUP BY 1`),
      /* «خلص النهارده» ووقف الباقات — ده اللي بيفسّر ساعة مبيعاتها وقعت */
      q(`SELECT ${HK("at")} AS hkey, at, action, detail
           FROM portal_audit
          WHERE action IN ('item_sold_out','item_reopened','offer_paused','offer_resumed')
            AND ${fence('at')}
          ORDER BY at DESC LIMIT 300`),
    ]);

    /* ── الطلبات الموحّدة بالقنوات الحقيقية ──────────────────────────────
       مافيش SQL مبيعات جديد هنا: bizreports.loadWindow هو نفسه اللي
       /api/reports/biz/sales بيستعمله — نفس استبعاد الفويد/الريفند، نفس
       مطابقة «المرايا» (طلب المتجر اللي بينزل نقطة البيع External)، ونفس
       تصنيف التطبيقات. فمستحيل الشاشتين يقولوا رقمين مختلفين.            */
    const biz = bizOf();
    let unified = null, hourlyError = null;
    if (!biz) hourlyError = "biz_unavailable";
    else {
      try {
        const cfg = await biz.settings();
        unified = await biz.loadWindow(win.start, win.cut, cfg);
      } catch (e) { hourlyError = String(e?.message || e).slice(0, 200); }
    }

    const { slots, total: slotTotal, truncated } = hourSlots(win.start, win.cut);
    const flags = flagRows.map((r) => ({
      hkey: r.hkey, at: r.at, action: r.action,
      kind: r.action === "item_sold_out" || r.action === "offer_paused" ? "closed" : "open",
      name: (r.detail && (r.detail.name || r.detail.offerId || r.detail.productId)) || null,
    }));
    const hourly = buildHourly({
      slots, orders: unified?.rows || [], visitors: visitorsByHour,
      stuck: stuckByHour, spend: spendByHour, flags, pauses: paused,
    });

    const v = visitors[0] || {};
    const sent = sms.filter((r) => r.status === "sent").length;
    /* ١ الفجر بعد ٢٣ — نفس القاعدة على الجدول القديم كمان، مش على الجديد بس */
    const posRows = [...pos].sort((a, b) => bizHourIndex(Number(a.hh)) - bizHourIndex(Number(b.hh)));
    return c.json({
      ok: true,
      range: {
        ...(range ? { from: range[0], to: range[1] } : { hours }),
        startUtc: win.start.toISOString(), endUtc: win.end.toISOString(), cutUtc: win.cut.toISOString(),
        hoursSpan: slotTotal, partial: win.partial,
        bizDays: [...new Set(slots.map((s) => s.bizDay))],
      },
      /* ⏱ الخط الزمني: صف لكل ساعة، بترتيب الوقت الحقيقي (١ الفجر بعد ٢٣) */
      hourly: {
        ...hourly, truncated, slotTotal, error: hourlyError,
        stats: unified?.stats || null,
        appLabels: Object.fromEntries(hourly.apps.map((a) => [a, APP_LABELS[a] || a])),
        flags,
      },
      /* ملف الساعات: نفس الساعة مجمّعة على أيام المدى، مرتّبة بترتيب اليوم
         التشغيلي — الجدول اللي بيقول «ساعة ١١ عندنا ٣ طلبات في المتوسط» */
      hourProfile: hourProfile(hourly.hours),
      now: serviceState(await getSettingsData()),
      events,
      visitors: { sessions: v.sessions || 0, reachedCart: v.reached_cart || 0, known: v.known || 0, paid: v.paid || 0, cartValue: v.cart_value || 0 },
      waitlist: {
        rows: wait,
        captured: wait.length,
        waiting: wait.filter((r) => !r.notified_at && !r.skip_reason).length,
        notified: wait.filter((r) => r.notified_at).length,
        skipped: wait.filter((r) => r.skip_reason).length,
        value: wait.filter((r) => !r.notified_at && !r.skip_reason).reduce((n, r) => n + (Number(r.subtotal) || 0), 0),
      },
      sms: { rows: sms, sent, failed: sms.length - sent, cost: sms.reduce((n, r) => n + (Number(r.cost) || 0), 0) },
      returned: orders[0] || { n: 0, sar: 0 },
      /* «إيه اللي حصل» — الطلبات نفسها في نفس النافذة */
      orders: sales[0] || { n: 0, sar: 0, delivery: 0, pickup: 0, unpaid: 0 },
      pos: { rows: posRows, n: pos.reduce((a, r) => a + Number(r.n || 0), 0),
             sar: pos.reduce((a, r) => a + Number(r.sar || 0), 0) },
      pausedMinutes: pausedMinutesOf(paused, [win.start, win.cut]),
    });
  });

  app.put("/api/service", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    if (!["delivery", "pickup", "both"].includes(String(b.channel))) {
      return c.json({ ok: false, error: "bad_channel" }, 400);
    }
    return c.json({ ok: true, state: await apply(b) });
  });

  return { serviceState: async (now) => (await settle(now)).st, apply, settle };
}
