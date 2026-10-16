/* ═══════════════════════════════════════════════════════════════════════════
   📲 revpulse.js — RP2 (عمر ١٦/١٠ ١٧:٣٨): «عايز رسالة دورية بالدخل»

   رسالة للمالك وقت الشغل كل ساعتين (١ الضهر → ١ بالليل بتوقيت الرياض) + ملخص القفلة ٣:١٥ الفجر (قبل قطع اليوم
   التشغيلي ٤:٠٠). كل حاجة من اللوحة (settings.revenuePulse، المالك بس): التشغيل، المواعيد، الأرقام، القنوات.

   ── الأرقام: من مكان واحد ─────────────────────────────────────────────────
   الدخل والطلبات والتقسيم والمقارنة والصرف = bizreports.salesData(bizRange({preset:"today"})) نفسها — نفس رقم
   GET /api/reports/biz/sales?preset=today (totals.revenue شامل الضريبة). مفيش حساب دخل تاني هنا.
     • التقسيم: totals.groups (store = الموقع · apps = التطبيقات قبل العمولة · restaurant = الصالة + السفري + تليفون الكاشير)
     • المقارنة: totals.compare.lastWeek = نفس اليوم الأسبوع اللي فات متقطوع عند نفس الساعة
     • الإعلانات: ads.total و ads.shareOfRevenue قصاد حد adsGuard.revenueCap.pct (الافتراضي ١٣٪ — قاعدة عمر ١٥/١٠)
     • طلبات الموقع: كارت store (توصيل/استلام) قصاد هدف اليوم (cms.dailyTarget — نفس هدف «نبض اليوم»)
   سطر التنبيه (واحد بس، الأهم): مشكلة خطيرة في صحة واتساب (wa_health_state) ⇒ وإلا أهم تنبيه إدارة اتبعت في آخر
   ساعتين (sms_log kind=staff، بنفس كتالوج staffcontrol: الحرج ⇒ المندوب ⇒ التأخير ⇒ الباقي).

   ── القناة: عمرها ما بتكون قالب مدفوع ─────────────────────────────────────
   لكل رقم: رسالة واتساب حرة (ببلاش) عن طريق wa.sendFreeform — الحارس المركزي نفسه بيرفض لو نافذة الـ٢٤ ساعة مقفولة
   أو واتساب مقفول ⇒ SMS قصيرة من المرسل الخدمي (accounts.sendSms kind=staff، نفس رسايل الإدارة؛ بتعدّي على بوابة
   staffcontrol بنوع «revenue_pulse»). الـSMS متقصّرة لحد smsMaxParts جزء (عربي = ٦٧ حرف للجزء).

   ── التكرار ──────────────────────────────────────────────────────────────
   • ميعاد اتبعت/اتخطّى مرة واحدة: صف لكل (يوم تشغيلي، ميعاد) في revenue_pulse_log بفهرس unique — حاويتين وقت النشر
     مايبعتوش نفس الميعاد مرتين.
   • ميعاد فات عليه أكتر من graceMin دقيقة (السيرفر كان واقف) مابيتبعتش متأخر.
   • «مفيش جديد» (٠ طلبات جديدة من آخر رسالة اتبعتت النهارده) ⇒ مابيتبعتش ويتسجّل «اتخطّى» — إلا ملخص القفلة.

   المسارات (admin؛ التعديل والتجربة للمالك بس، والأرقام كاملة للمالك بس). كل الردود HTTP 200 مع ok:false عند الفشل:
     GET  /api/cms/revenue-pulse            الإعدادات + المواعيد + الجاي + المستلمين + السجل + معاينة الرسالة دلوقتي
     POST /api/cms/revenue-pulse/settings   حفظ (المفاتيح اللي اتبعتت بس) — المالك
     POST /api/cms/revenue-pulse/test       رسالة تجربة بأرقام دلوقتي لنفس المستلمين بنفس القنوات — المالك
═══════════════════════════════════════════════════════════════════════════ */
import { bizDay, bizStart, bizRange, weekdayOf, DEFAULT_WEEK_START } from "./bizday.js";
import { smsInfo, staffPhones, normStaffPhone } from "./staffalerts.js";
import { recipientsOf as healthRecipients, SOURCE_AR } from "./wahealth.js";
import { typeOfRef, ALERT_TYPES } from "./staffcontrol.js";

/* ── الإعدادات (settings.revenuePulse) ───────────────────────────────────── */
export const PULSE_DEFAULTS = Object.freeze({
  enabled: true,         // الرسالة الدورية شغّالة
  fromHour: 13,          // أول رسالة (ساعة الرياض)
  toHour: 1,             // آخر رسالة دورية (١ بالليل = نفس اليوم التشغيلي)
  everyH: 2,             // كل كام ساعة
  close: true,           // ملخص القفلة
  closeAt: "03:15",      // ميعاد ملخص القفلة (قبل قطع اليوم ٤:٠٠)
  phones: [],            // أرقام الاستلام — فاضي = المالك تلقائياً (نفس قاعدة تنبيه صحة واتساب)
  wa: true,              // واتساب حر ببلاش لو نافذة الرقم مفتوحة
  sms: true,             // SMS لو النافذة مقفولة
  skipNoChange: true,    // مفيش طلبات جديدة من آخر رسالة ⇒ ماتبعتش (القفلة بتتبعت دايماً)
  smsMaxParts: 3,        // أقصى عدد أجزاء للـSMS
  graceMin: 40,          // الميعاد اللي فات عليه أكتر من كده (السيرفر كان واقف) مابيتبعتش متأخر
  alertLine: true,       // سطر أهم تنبيه
});
export const PULSE_KEYS = Object.freeze(Object.keys(PULSE_DEFAULTS));
export const PULSE_LIMITS = Object.freeze({ fromHour: [0, 23], toHour: [0, 23], everyH: [1, 6], smsMaxParts: [1, 6], graceMin: [10, 110] });
export const ROLL_HOUR = 4;            // قطع اليوم التشغيلي (bizday.js)
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" && typeof v !== "boolean" ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const normHHMM = (s, d) => { const m = HHMM_RE.exec(String(s ?? "").trim()); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : d; };
export const bizIdx = (h) => ((Number(h) - ROLL_HOUR) % 24 + 24) % 24;          // ٤ الفجر = ٠ … ٣ الفجر = ٢٣
const bizMinOfHHMM = (s) => { const [h, m] = s.split(":").map(Number); return bizIdx(h) * 60 + m; };

export function pulseCfg(settings) {
  const raw = settings && settings.revenuePulse && typeof settings.revenuePulse === "object" ? settings.revenuePulse : {};
  const x = { ...PULSE_DEFAULTS, ...raw };
  const L = PULSE_LIMITS, D = PULSE_DEFAULTS;
  return {
    enabled: x.enabled !== false,
    fromHour: clampN(x.fromHour, ...L.fromHour, D.fromHour),
    toHour: clampN(x.toHour, ...L.toHour, D.toHour),
    everyH: clampN(x.everyH, ...L.everyH, D.everyH),
    close: x.close !== false,
    closeAt: normHHMM(x.closeAt, D.closeAt),
    phones: staffPhones(x.phones).slice(0, 5),
    wa: x.wa !== false,
    sms: x.sms !== false,
    skipNoChange: x.skipNoChange !== false,
    smsMaxParts: clampN(x.smsMaxParts, ...L.smsMaxParts, D.smsMaxParts),
    graceMin: clampN(x.graceMin, ...L.graceMin, D.graceMin),
    alertLine: x.alertLine !== false,
  };
}

/* فحص الحفظ — بيرجّع رسالة عربي أو null. b = المفاتيح اللي اتبعتت بس، next = الإعدادات بعد الدمج (قبل التنضيف). */
export function settingsProblem(b, next) {
  const intIn = (k) => {
    if (b[k] === undefined) return null;
    const n = Number(b[k]); const [lo, hi] = PULSE_LIMITS[k];
    return Number.isInteger(n) && n >= lo && n <= hi && typeof b[k] !== "boolean" && b[k] !== "" ? null : `«${LABELS[k]}» لازم رقم صحيح من ${lo} لـ${hi}`;
  };
  for (const k of Object.keys(PULSE_LIMITS)) { const e = intIn(k); if (e) return e; }
  for (const k of ["enabled", "close", "wa", "sms", "skipNoChange", "alertLine"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return `«${LABELS[k]}» لازم تشغيل/إيقاف`;
  if (b.closeAt !== undefined && !HHMM_RE.test(String(b.closeAt || "").trim())) return "ميعاد ملخص القفلة لازم ساعة:دقيقة (مثلاً 03:15)";
  if (b.phones !== undefined) {
    const arr = Array.isArray(b.phones) ? b.phones : String(b.phones || "").split(/[\s,،;]+/).filter(Boolean);
    const bad = arr.filter((p) => !normStaffPhone(p));
    if (bad.length) return `رقم مش سعودي صحيح (05XXXXXXXX): …${bad.slice(0, 3).map((p) => String(p).slice(-4)).join("، …")}`;
    if (arr.length > 5) return "أقصى ٥ أرقام";
  }
  const c = pulseCfg({ revenuePulse: next });
  if (bizIdx(c.fromHour) > bizIdx(c.toHour)) return `أول رسالة (${c.fromHour}:00) لازم تكون قبل آخر رسالة (${c.toHour}:00) في نفس اليوم التشغيلي (من ٤ الفجر لـ٤ الفجر)`;
  if (c.close && bizMinOfHHMM(c.closeAt) <= bizIdx(c.toHour) * 60) return `ملخص القفلة (${c.closeAt}) لازم يكون بعد آخر رسالة دورية (${c.toHour}:00) وقبل ٤:٠٠ الفجر`;
  return null;
}
export const LABELS = Object.freeze({
  enabled: "رسالة الدخل الدورية", fromHour: "أول رسالة", toHour: "آخر رسالة", everyH: "كل كام ساعة", close: "ملخص القفلة",
  closeAt: "ميعاد ملخص القفلة", phones: "الأرقام", wa: "واتساب ببلاش لو النافذة مفتوحة", sms: "SMS لو النافذة مقفولة",
  skipNoChange: "ماتبعتش لو مفيش طلبات جديدة", smsMaxParts: "أقصى أجزاء الـSMS", graceMin: "أقصى تأخير للميعاد", alertLine: "سطر أهم تنبيه",
});

/* ── المواعيد ──────────────────────────────────────────────────────────────
   [{ key:"HH:MM", min: دقيقة من بداية اليوم التشغيلي (٤:٠٠)، kind: slot|close }] مرتّبة. القفلة لو وقعت على ميعاد دوري بتاخد مكانه. */
const pad2 = (n) => String(n).padStart(2, "0");
export function slotsOf(cfg) {
  const out = [];
  const a = bizIdx(cfg.fromHour), b = bizIdx(cfg.toHour);
  for (let i = a; i <= b; i += Math.max(1, cfg.everyH)) out.push({ key: `${pad2((i + ROLL_HOUR) % 24)}:00`, min: i * 60, kind: "slot" });
  if (cfg.close) {
    const min = bizMinOfHHMM(cfg.closeAt);
    const i = out.findIndex((s) => s.key === cfg.closeAt);
    if (i >= 0) out.splice(i, 1);
    out.push({ key: cfg.closeAt, min, kind: "close" });
  }
  return out.sort((x, y) => x.min - y.min);
}
export const bizMinNow = (now) => Math.floor((Number(now) - bizStart(bizDay(now)).getTime()) / 60_000);

/* الميعاد اللي عليه الدور دلوقتي: آخر ميعاد عدّى (≤ دلوقتي) ولسه في حدود graceMin ومش متسجّل النهارده. null = مفيش. */
export function dueSlot(now, cfg, done = new Set()) {
  const m = bizMinNow(now);
  const c = slotsOf(cfg).filter((s) => s.min <= m && m - s.min <= cfg.graceMin && !done.has(s.key));
  return c.length ? c[c.length - 1] : null;
}
/* الميعاد الجاي (للوحة): أول ميعاد بعد دلوقتي النهارده، وإلا أول ميعاد بكرة. */
export function nextSlot(now, cfg) {
  const slots = slotsOf(cfg);
  if (!slots.length) return null;
  const m = bizMinNow(now);
  const s = slots.find((x) => x.min > m);
  const day = bizDay(now);
  if (s) return { ...s, day, at: new Date(bizStart(day).getTime() + s.min * 60_000).toISOString() };
  const d2 = bizDay(new Date(bizStart(day).getTime() + 36 * 3600_000));
  return { ...slots[0], day: d2, at: new Date(bizStart(d2).getTime() + slots[0].min * 60_000).toISOString() };
}

/* ── النص ──────────────────────────────────────────────────────────────── */
const DAY_AR = ["الأحد", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت"];
const num0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");
export const hm12 = (ms) => {
  const d = new Date(Number(ms) + 3 * 3600_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${h % 12 || 12}:${pad2(m)} ${h < 12 ? "ص" : "م"}`;
};
const ddmm = (day) => `${Number(day.slice(8, 10))}/${Number(day.slice(5, 7))}`;
const pctTxt = (fr) => `${Math.round(Math.abs(fr) * 100)}%`;

/* d = نتيجة salesData؛ بيرجّع { wa, sms, parts, facts }. pure (متختبرة). */
export function pulseText({ d, range, now, kind = "slot", adsLimitPct = 13, target = null, alert = null, maxParts = 3 }) {
  const t = (d && d.totals) || {};
  const g = t.groups || {};
  const G = (k) => ({ orders: Number(g[k] && g[k].orders) || 0, revenue: Number(g[k] && g[k].revenue) || 0 });
  const st = G("store"), ap = G("apps"), rs = G("restaurant");
  const store = ((d && d.cards) || []).find((c) => c.id === "store") || {};
  const sp = store.split || null;
  const lw = t.compare && t.compare.lastWeek ? t.compare.lastWeek : null;
  const day = range.from;
  const wd = weekdayOf(day);
  const lwDay = `${DAY_AR[wd]} اللي ${wd === 5 ? "فاتت" : "فات"}`;
  const dl = lw && lw.deltaRevenue != null ? Number(lw.deltaRevenue) : null;
  const ads = d && d.ads && !d.ads.error ? d.ads : null;
  const adsPct = ads && ads.shareOfRevenue != null ? Number(ads.shareOfRevenue) * 100 : null;
  const adsOver = adsPct != null && adsPct > adsLimitPct;
  const close = kind === "close";
  const at = hm12(now);
  const facts = {
    revenue: Number(t.revenue) || 0, orders: Number(t.orders) || 0, store: st, apps: ap, restaurant: rs,
    lastWeek: lw ? { revenue: Number(lw.revenue) || 0, orders: Number(lw.orders) || 0, delta: dl } : null,
    ads: ads ? { total: Number(ads.total) || 0, pct: adsPct == null ? null : Math.round(adsPct * 10) / 10, limit: adsLimitPct, over: adsOver } : null,
    web: { orders: st.orders, delivery: sp ? Number(sp.delivery && sp.delivery.orders) || 0 : null, pickup: sp ? Number(sp.pickup && sp.pickup.orders) || 0 : null, target },
    alert: alert || null, day, kind,
  };
  /* واتساب (للمالك — عامية مصري) */
  const cmpWa = dl == null ? (lw ? `${lwDay}: ${num0(lw.revenue)} ر` : "") : `${dl >= 0 ? "⬆️ +" : "⬇️ -"}${pctTxt(dl)} عن ${lwDay} (${num0(lw.revenue)} ر)`;
  const wa = [
    close ? `🧾 قفلة يوم ${DAY_AR[wd]} ${ddmm(day)} — فريش كاتس` : `📊 دخل فريش كاتس لحد ${at} — ${DAY_AR[wd]} ${ddmm(day)}`,
    `💰 ${num0(t.revenue)} ر · ${num0(t.orders)} طلب${cmpWa ? ` · ${cmpWa}` : ""}`,
    `🛒 الموقع ${num0(st.revenue)} ر (${st.orders}) · 📱 التطبيقات ${num0(ap.revenue)} ر (${ap.orders}) · 🍽 الصالة والسفري ${num0(rs.revenue)} ر (${rs.orders})`,
    ads ? `📣 الإعلانات ${num0(ads.total)} ر${adsPct == null ? "" : ` = ${Math.round(adsPct)}% من الدخل`} (الحد ${adsLimitPct}%)${adsOver ? " ⚠️ فوق الحد" : ""}` : null,
    `🌐 طلبات الموقع ${st.orders}${target ? ` من ${target}` : ""}${sp ? ` (توصيل ${facts.web.delivery} · استلام ${facts.web.pickup})` : ""}`,
    alert ? `⚠️ ${alert}` : null,
  ].filter(Boolean).join("\n");
  /* SMS: نفس الأرقام أقصر، من غير إيموجي، والسطور بالأولوية لحد ما تكمّل maxParts */
  const lines = [
    close ? `فريش كاتس قفلة ${ddmm(day)}` : `فريش كاتس لحد ${at}`,
    `الدخل ${num0(t.revenue)}ر ${num0(t.orders)} طلب${dl == null ? "" : ` ${dl >= 0 ? "+" : "-"}${pctTxt(dl)} عن ${lwDay}`}`,
    `موقع ${num0(st.revenue)}/${st.orders} تطبيقات ${num0(ap.revenue)}/${ap.orders} صالة+سفري ${num0(rs.revenue)}/${rs.orders}`,
    ads ? `اعلانات ${num0(ads.total)}ر${adsPct == null ? "" : ` ${Math.round(adsPct)}%`} الحد ${adsLimitPct}%${adsOver ? " فوق الحد" : ""}` : null,
    alert ? `تنبيه: ${alert}` : null,
    `طلبات الموقع ${st.orders}${target ? ` من ${target}` : ""}`,
  ].filter(Boolean);
  let sms = lines.slice(0, 2).join("\n");
  for (const l of lines.slice(2)) { const tryT = `${sms}\n${l}`; if (smsInfo(tryT).segments <= maxParts) sms = tryT; }
  while (smsInfo(sms).segments > maxParts && sms.length > 10) sms = sms.slice(0, -1);
  return { wa, sms, parts: smsInfo(sms).segments, facts };
}

/* ── سطر أهم تنبيه ───────────────────────────────────────────────────────── */
const ALERT_RANK = ["pos_failed", "total_mismatch", "tabsense_down", "checkout", "optout_brake", "courier", "sla", "adconnect", "review", "content_alert"];
const SKIP_REFS = /^(test$|daily_report$|revenue-pulse|wa-health)/;
/* health = آخر حالة صحة واتساب (wa_health_state.data.last)؛ staffRows = [{ref, n}] من sms_log آخر ساعتين. */
export function alertLineOf({ health = null, staffRows = [] } = {}) {
  const issues = health && Array.isArray(health.issues) ? health.issues : [];
  const crit = issues.find((i) => i && i.level === "crit");
  if (crit) return `واتساب: ${String(crit.sms || crit.title || "مشكلة خطيرة").slice(0, 90)}`;
  const byType = new Map();
  for (const r of staffRows || []) {
    if (!r || SKIP_REFS.test(String(r.ref || ""))) continue;
    const { type } = typeOfRef(r.ref);
    if (type === "other" || type === "test" || type === "new_order") continue;
    byType.set(type, (byType.get(type) || 0) + 1);
  }
  const best = [...byType.entries()].sort((a, b) => ((ALERT_RANK.indexOf(a[0]) + 1 || 99) - (ALERT_RANK.indexOf(b[0]) + 1 || 99)) || b[1] - a[1])[0];
  if (best) {
    const label = (ALERT_TYPES.find((x) => x.id === best[0]) || {}).label || best[0];
    return `آخر ساعتين: ${best[1]} تنبيه «${label}»`;
  }
  /* تحذيرات واتساب (warn) مش هنا عن قصد: «الاسم المعروض في المراجعة» قايم من أيام وكان هيبقى سطر كل رسالة — الكارت بيعرضها */
  return null;
}

const mask = (p) => `***${String(p || "").slice(-4)}`;
export const SKIP_AR = Object.freeze({
  no_change: "مفيش طلبات جديدة من آخر رسالة", no_phones: "مفيش رقم استلام", disabled: "الرسالة مقفولة", no_channel: "واتساب والـSMS الاتنين مقفولين",
  data_error: "الأرقام ماتقرتش", window_closed: "نافذة واتساب مقفولة", suppressed: "اتقفلت من «رسايل الإدارة»",
});

/* ═══════════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const isOwner = ctx.isOwner || (async () => true);
  const biz = typeof deps.biz === "function" ? deps.biz : () => deps.biz || null;
  const wa = typeof deps.wa === "function" ? deps.wa : () => deps.wa || null;
  const health = typeof deps.health === "function" ? deps.health : () => deps.health || null;
  const sendSms = typeof deps.sendSms === "function" ? deps.sendSms : null;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console.error;
  const J = (v) => JSON.stringify(v);

  const ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS revenue_pulse_log (
        id BIGSERIAL PRIMARY KEY, day DATE NOT NULL, slot TEXT NOT NULL, kind TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT NOT NULL DEFAULT 'claimed', reason TEXT,
        orders INT, revenue NUMERIC, text TEXT, sms_text TEXT, via JSONB, by_user TEXT)`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS revenue_pulse_slot_uq ON revenue_pulse_log(day, slot) WHERE kind <> 'test'");
  })().catch((e) => log("[rev-pulse] schema:", e.message));

  /* الأرقام من bizreports نفسها */
  async function build(kind, t) {
    const b = biz();
    if (!b || typeof b.salesData !== "function") throw new Error("reports_unavailable");
    const bcfg = await b.settings();
    const range = bizRange({ preset: "today", now: new Date(t), weekStart: bcfg.weekStart ?? DEFAULT_WEEK_START });
    const d = await b.salesData(range, bcfg);
    const s = (await getSettingsData()) || {};
    const cfg = pulseCfg(s);
    const rc = s.adsGuard && s.adsGuard.revenueCap && typeof s.adsGuard.revenueCap === "object" ? s.adsGuard.revenueCap : {};
    const adsLimitPct = Number.isFinite(Number(rc.pct)) && Number(rc.pct) > 0 ? Number(rc.pct) : 13;
    let alert = null;
    if (cfg.alertLine) {
      let h = null, rows = [];
      try { const hs = health(); h = hs && typeof hs.readState === "function" ? ((await hs.readState()).data || {}).last || null : null; } catch { h = null; }
      try {
        /* تنبيه واحد لرقمين = نفس المرجع (ref) ⇒ GROUP BY ref = تنبيه واحد */
        rows = (await pool.query(`SELECT ref FROM sms_log WHERE kind='staff' AND status='sent' AND at > NOW() - INTERVAL '2 hours'
            GROUP BY ref ORDER BY max(at) DESC LIMIT 200`)).rows || [];
      } catch { rows = []; }
      alert = alertLineOf({ health: h, staffRows: rows });
    }
    return { ...pulseText({ d, range, now: t, kind, adsLimitPct, target: bcfg.dailyTarget || null, alert, maxParts: cfg.smsMaxParts }), range };
  }

  /* الإرسال لكل رقم: واتساب حر (الحارس بيرفض لو النافذة مقفولة) ⇒ SMS. مابيرميش. */
  async function deliver(cfg, phones, msg, ref) {
    const via = [];
    const w = wa();
    for (const p of phones) {
      let row = { to: mask(p), ch: null, ok: false, why: null };
      if (cfg.wa && w && typeof w.sendFreeform === "function") {
        try {
          const r = await w.sendFreeform({ phoneNorm: p, payload: { type: "text", text: { body: msg.wa, preview_url: false } }, source: "pulse", preview: msg.wa });
          if (r && r.ok) row = { to: mask(p), ch: "wa", ok: true, why: null };
          else row.why = String((r && (r.skipped || r.error)) || "wa_failed").slice(0, 40);
        } catch (e) { row.why = "wa_error"; log(`[rev-pulse] wa → ${mask(p)}: ${e.message}`); }
      } else row.why = cfg.wa ? "no_wa_sender" : "wa_off";
      if (!row.ok && cfg.sms && sendSms) {
        try {
          const r = await sendSms({ phoneNorm: p, body: msg.sms, kind: "staff", ref });
          if (r && r.suppressed) row = { ...row, ch: "sms", ok: false, why: `${row.why || ""}→suppressed`.slice(0, 60) };
          else row = { ...row, ch: "sms", ok: true, waWhy: row.why, why: null };
        } catch (e) { row = { ...row, ch: "sms", ok: false, why: `${row.why || ""}→sms_failed`.slice(0, 60) }; log(`[rev-pulse] sms → ${mask(p)}: ${e.message}`); }
      } else if (!row.ok && !cfg.sms) row.why = `${row.why || ""}→sms_off`.slice(0, 60);
      via.push(row);
    }
    return via;
  }

  async function recipients(s, cfg) {
    const r = healthRecipients(s, { phones: cfg.phones });
    return { phones: r.phones, source: r.source };
  }

  let running = null;
  /* دورة واحدة: لو فيه ميعاد عليه الدور ⇒ احجزه ⇒ ابني ⇒ ابعت أو اتخطّى ⇒ سجّل. */
  async function tick({ at = null } = {}) {
    if (running) return running;
    running = (async () => {
      await ready;
      const t = at == null ? now() : Number(at);
      const s = (await getSettingsData()) || {};
      const cfg = pulseCfg(s);
      if (!cfg.enabled) return { ok: true, skipped: "disabled" };
      const day = bizDay(t);
      const doneRows = (await pool.query("SELECT slot FROM revenue_pulse_log WHERE day=$1::date AND kind <> 'test'", [day])).rows || [];
      const slot = dueSlot(t, cfg, new Set(doneRows.map((r) => r.slot)));
      if (!slot) return { ok: true, skipped: "not_due" };
      const claim = await pool.query(
        "INSERT INTO revenue_pulse_log(day, slot, kind) VALUES ($1::date, $2, $3) ON CONFLICT (day, slot) WHERE kind <> 'test' DO NOTHING RETURNING id",
        [day, slot.key, slot.kind]);
      if (!claim.rows || !claim.rows.length) return { ok: true, skipped: "claimed_elsewhere", slot: slot.key };
      const id = claim.rows[0].id;
      const fin = (status, reason, extra = {}) => pool.query(
        "UPDATE revenue_pulse_log SET status=$2, reason=$3, orders=$4, revenue=$5, text=$6, sms_text=$7, via=$8::jsonb, at=NOW() WHERE id=$1",
        [id, status, reason, extra.orders ?? null, extra.revenue ?? null, extra.text ?? null, extra.sms ?? null, J(extra.via || [])]).catch((e) => log("[rev-pulse] log:", e.message));
      let msg;
      try { msg = await build(slot.kind, t); }
      catch (e) { await fin("failed", "data_error"); log("[rev-pulse] build:", e.message); return { ok: false, error: "data_error", slot: slot.key }; }
      const base = { orders: msg.facts.orders, revenue: msg.facts.revenue, text: msg.wa, sms: msg.sms };
      if (cfg.skipNoChange && slot.kind !== "close") {
        const last = (await pool.query(
          "SELECT orders FROM revenue_pulse_log WHERE day=$1::date AND kind <> 'test' AND status='sent' AND id <> $2 ORDER BY at DESC LIMIT 1", [day, id])).rows[0];
        const lastOrders = last ? Number(last.orders) || 0 : 0;
        if (msg.facts.orders - lastOrders <= 0) { await fin("skipped", "no_change", base); return { ok: true, skipped: "no_change", slot: slot.key }; }
      }
      const rec = await recipients(s, cfg);
      if (!rec.phones.length) { await fin("skipped", "no_phones", base); return { ok: true, skipped: "no_phones", slot: slot.key }; }
      if (!cfg.wa && !cfg.sms) { await fin("skipped", "no_channel", base); return { ok: true, skipped: "no_channel", slot: slot.key }; }
      const via = await deliver(cfg, rec.phones, msg, `revenue-pulse ${slot.key} ${slot.kind}`);
      const okN = via.filter((v) => v.ok).length;
      await fin(okN ? "sent" : "failed", okN ? null : (via[0] && via[0].why) || "failed", { ...base, via });
      return { ok: true, sent: okN, slot: slot.key, kind: slot.kind, via };
    })().catch((e) => { log("[rev-pulse] tick:", e.message); return { ok: false, error: String(e.message || e).slice(0, 200) }; })
      .finally(() => { running = null; });
    return running;
  }

  async function view(owner) {
    await ready;
    const s = (await getSettingsData()) || {};
    const cfg = pulseCfg(s);
    const rec = await recipients(s, cfg);
    const t = now();
    const rows = (await pool.query(
      "SELECT id, day::text AS day, slot, kind, at, status, reason, orders, revenue::float AS revenue, text, sms_text, via FROM revenue_pulse_log ORDER BY id DESC LIMIT 20")).rows || [];
    let preview = null;
    try { const m = await build("slot", t); preview = { wa: m.wa, sms: m.sms, parts: m.parts, facts: m.facts }; }
    catch (e) { preview = { error: String(e.message || e).slice(0, 120) }; }
    const nx = cfg.enabled ? nextSlot(t, cfg) : null;
    return {
      ok: true, owner, cfg: owner ? cfg : { ...cfg, phones: cfg.phones.map(mask) }, defaults: PULSE_DEFAULTS, limits: PULSE_LIMITS, labels: LABELS,
      slots: slotsOf(cfg).map((x) => ({ key: x.key, kind: x.kind })),
      next: nx ? { key: nx.key, kind: nx.kind, day: nx.day, at: nx.at } : null,
      recipients: { phones: owner ? rec.phones : rec.phones.map(mask), masked: rec.phones.map(mask), source: rec.source, sourceAr: SOURCE_AR[rec.source] || rec.source },
      log: rows.map((r) => ({ ...r, at: r.at ? new Date(r.at).toISOString() : null, reasonAr: r.reason ? (SKIP_AR[r.reason] || r.reason) : null })),
      preview, skipAr: SKIP_AR,
    };
  }

  app.get("/api/cms/revenue-pulse", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try { return c.json(await view(Boolean(await isOwner(c)))); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  app.post("/api/cms/revenue-pulse/settings", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "إعدادات رسالة الدخل للمالك بس" }, 403);
    try {
      const b = await c.req.json().catch(() => ({}));
      if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ ok: false, error: "bad_json", message: "الطلب مش مفهوم" });
      const s = (await getSettingsData()) || {};
      const cur = s.revenuePulse && typeof s.revenuePulse === "object" ? s.revenuePulse : {};
      const nx = { ...pulseCfg(s), ...cur };
      for (const k of PULSE_KEYS) if (b[k] !== undefined) nx[k] = b[k];
      const bad = settingsProblem(b, nx);
      if (bad) return c.json({ ok: false, error: "invalid", message: bad });
      const clean = { ...pulseCfg({ revenuePulse: nx }), updatedAt: new Date(now()).toISOString() };
      await pool.query("UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{revenuePulse}', $1::jsonb, true) WHERE id=1", [J(clean)]);
      return c.json(await view(true));
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  /* رسالة تجربة: أرقام دلوقتي بنفس النص والقنوات — مابتحجزش ميعاد ومابتأثرش على «مفيش جديد». «test» بيعدّي بوابة رسايل الإدارة. */
  app.post("/api/cms/revenue-pulse/test", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!(await isOwner(c))) return c.json({ ok: false, error: "owner_only", message: "المالك بس" }, 403);
    try {
      await ready;
      const s = (await getSettingsData()) || {};
      const cfg = pulseCfg(s);
      const rec = await recipients(s, cfg);
      if (!rec.phones.length) return c.json({ ok: false, error: "no_phones", message: "مفيش رقم استلام — اكتب رقمك أو ضيف المالك في دليل الفريق" });
      if (!cfg.wa && !cfg.sms) return c.json({ ok: false, error: "no_channel", message: "واتساب والـSMS الاتنين مقفولين" });
      const t = now();
      const msg = await build("slot", t);
      const tagged = { ...msg, wa: `🧪 تجربة\n${msg.wa}`, sms: msg.sms };
      const via = await deliver(cfg, rec.phones, tagged, "test");
      const okN = via.filter((v) => v.ok).length;
      await pool.query(
        "INSERT INTO revenue_pulse_log(day, slot, kind, status, reason, orders, revenue, text, sms_text, via) VALUES ($1::date, $2, 'test', $3, $4, $5, $6, $7, $8, $9::jsonb)",
        [bizDay(t), hm12(t), okN ? "sent" : "failed", okN ? null : (via[0] && via[0].why) || "failed", msg.facts.orders, msg.facts.revenue, tagged.wa, tagged.sms, J(via)]).catch((e) => log("[rev-pulse] test log:", e.message));
      return c.json({ ok: okN > 0, sent: okN, via, text: tagged.wa, sms: tagged.sms, parts: msg.parts });
    } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  });

  /* الجدولة: كل دقيقة (أول مرة بعد دقيقة من التشغيل). REVENUE_PULSE_SCHEDULER=0 بيقفلها (للاختبارات/الطوارئ). */
  if (deps.schedule !== false && process.env.REVENUE_PULSE_SCHEDULER !== "0") {
    const t0 = setTimeout(() => {
      tick().catch(() => {});
      const iv = setInterval(() => { tick().catch(() => {}); }, 60_000);
      if (iv.unref) iv.unref();
    }, 60_000);
    if (t0.unref) t0.unref();
  }
  return { tick, view, build };
}

export default { register };
