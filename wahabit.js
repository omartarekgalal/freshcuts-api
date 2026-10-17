/* ═══════════════════════════════════════════════════════════════════════════
   wahabit.js — CJ1b (١٧/١٠/٢٠٢٦): الإرسال على عادة العميل — «نشغّل اليوم كله»
   ملف صافي: الإعدادات + ساعة العادة من هيستوجرام الساعات + خطة إرسال الحملة. مفيش قاعدة ولا إرسال هنا
   (التنفيذ في wasender.js: إنشاء الحملة / startDueJobs بيحطّوا send_at لكل صف في wa_send_queue، والـclaim مابياخدش صف ميعاده
   لسه ماجاش؛ وcustprofile.js بيحسب best_hour / hour_hist لكل جوال مع باقي الملف).

   عمر (١٧/١٠): «نشغّل اليوم كله» — كل مستلم في الحملة يوصله في الساعة اللي هو متعوّد يطلب فيها (قبلها بمهلة)، والساعات
   الهادية تتملي باللي مالهمش عادة، بدل دفعة واحدة الساعة ١:٠٠ الضهر. بعد ١٠ بالليل عادي؛ إحنا بنقفل ٢–٣ الفجر.

   الوقت كله بتوقيت الرياض (+٣ ثابتة، مفيش توقيت صيفي). «نافذة النهارده» = من fromHour لحد nightCutoffHour (بعد نص الليل):
   لو إحنا بعد نص الليل وقبل القفل ⇒ إحنا في ديل نافذة إمبارح؛ لو قبل fromHour ⇒ النافذة بتبدأ النهارده fromHour والصفوف بتستنى.
   الصف اللي ساعته فاتت النهارده مابيتأجّلش لبكرة (الحملة بتشتغل نفس اليوم) — بيروح للهدوء زي اللي مالوش ساعة.
   الحدود القديمة كلها فوق الخطة (بتتطبّق بعد ما send_at يجي): hourCap/dailyCap، custCap، pay_hold، الفرامل، وCJ1a (burst_hold ⇒ hold_until).
═══════════════════════════════════════════════════════════════════════════ */
import { BIZ_DAY_START_HOUR } from "./identity.js";

export const HABIT_GROUP = "rhythm";
export const HABIT_GROUP_AR = "الإيقاع: الإرسال على عادة العميل";

/* settings.waSender.byHabit — الافتراضيات (المالك ١٧/١٠: مقفول لحد ما يشغّله، ٩٠ دقيقة قبل ساعته، القفل ٢ الفجر) */
export const HABIT_DEFAULTS = Object.freeze({
  enabled: false,          // المفتاح الرئيسي — مقفول افتراضياً
  leadMin: 90,             // الرسالة توصل قبل ساعة طلبه المعتادة بالمدة دي
  fromHour: 12,            // أول ساعة إرسال في النافذة (الرياض)
  nightCutoffHour: 2,      // آخر حد بالليل (٢ = ٢ الفجر؛ المالك: بعد ١٠ بالليل تمام)
  spreadQuiet: true,       // اللي مالوش ساعة معتادة: يتوزّع على الساعات الهادية (بدل ما يروحوا كلهم ساعة واحدة)
  fallbackHour: 17,        // ولو التوزيع مقفول: ساعة الاحتياط للي مالوش ساعة
  maxPerHour: 0,           // سعة الساعة في التوزيع — صفر = يورث سقف الساعة بتاع القناة (waCloud.hourCap / waSender.hourCap)
});
export const HABIT_NUMS = Object.freeze({ leadMin: [0, 240], fromHour: [0, 23], nightCutoffHour: [0, 23], fallbackHour: [0, 23], maxPerHour: [0, 1000] });
export const HABIT_BOOLS = Object.freeze(["enabled", "spreadQuiet"]);
/* ليه الصف اتحط في ميعاده (wa_send_queue.send_why) — للوحة */
export const HABIT_WHY_AR = Object.freeze({
  habit: "على عادته (قبل ساعته بالمهلة)", quiet: "مالوش ساعة معتادة — اتحط في الهدوء", passed: "ساعته فاتت النهارده — اتحط في الهدوء",
  outside: "ساعته بره نافذة الإرسال — اتحط في الهدوء",
});

const clamp = (v, [lo, hi], d) => { const n = Number(v); return v !== "" && v !== null && v !== undefined && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
/* settings.waSender.byHabit ⇒ القيم النهائية (الغلط ⇒ الافتراضي، بره الحدود ⇒ للحد). */
export function habitCfg(x = {}) {
  const src = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = { enabled: src.enabled === true, spreadQuiet: src.spreadQuiet !== false };
  for (const [k, lim] of Object.entries(HABIT_NUMS)) out[k] = clamp(src[k], lim, HABIT_DEFAULTS[k]);
  return out;
}
const S = (type, ar, help, extra = {}) => Object.freeze({ group: HABIT_GROUP, type, ar, help, ...extra });
const N = (k, ar, help, unit) => S("number", ar, help, { min: HABIT_NUMS[k][0], max: HABIT_NUMS[k][1], unit });
/* نفس شكل مخطط إعدادات البوت (wabotrun.js SCHEMA / wajourney.js JOURNEY_SCHEMA): group/type/ar/help/min/max/unit — واللوحة بتعرضه من habitSchemaRows */
export const HABIT_SCHEMA = Object.freeze({
  enabled: S("boolean", "ابعت على عادة كل عميل (اليوم كله)",
    "كل مستلم في الحملة ياخد رسالته قبل الساعة اللي هو متعوّد يطلب فيها، واللي مالوش ساعة معتادة يتوزّع على الساعات الهادية — بدل ما الحملة كلها تطلع دفعة واحدة من أول دقيقة. الحملة بتفضل «شغّالة» طول اليوم. كل الحدود التانية (سقف الساعة واليوم، سقف العميل، الهدوء بعد أي رسالة) لسه شغّالة فوقها."),
  leadMin: N("leadMin", "الرسالة توصل قبل ساعة طلبه المعتادة بـ", "ساعته = ذروة ساعات طلباته (الرياض) من ملفه. ٩٠ دقيقة = قبل ما يفكّر يطلب بشوية. صفر = في ساعته بالظبط.", "دقيقة"),
  fromHour: N("fromHour", "أول ساعة إرسال في اليوم (الرياض)", "اللي ساعته أبكر من كده (أو الحملة اتعملت قبلها) بياخد أول النافذة.", "ساعة"),
  nightCutoffHour: N("nightCutoffHour", "آخر حد بالليل (الرياض)", "٢ = ٢ الفجر. اللي ساعته بعد كده (أو فاتت النهارده) مابيتأجّلش لبكرة — بيتحط في الساعات الهادية من دلوقتي. لازم «ساعات الإرسال» في الإرسال الآلي تغطّي النافذة دي وإلا الرسالة تستنى لساعات الإرسال.", "ساعة"),
  spreadQuiet: S("boolean", "اللي مالوش ساعة معتادة: وزّعه على الساعات الهادية", "أقل من ٣ طلبات (إعداد «ملف العميل») = مفيش ساعة معتادة. بيتوزّع بالتساوي على الساعات اللي فيها أقل حمولة من الحملة. مقفول = كلهم في ساعة الاحتياط."),
  fallbackHour: N("fallbackHour", "…ولو التوزيع مقفول: ساعة الاحتياط", "بتتقص على النافذة؛ لو فاتت النهارده ⇒ من أول ما الحملة تبدأ.", "ساعة"),
  maxPerHour: N("maxPerHour", "سعة الساعة في التوزيع", "التوزيع مابيحطش في ساعة وصلت السعة دي طول ما فيه ساعة أفضى. صفر = سقف الساعة بتاع القناة (Cloud: waCloud.hourCap، واتساب ويب: hourCap). الإرسال الفعلي لسه محكوم بسقف الساعة الحقيقي.", "رسالة"),
});
export function habitSchemaRows(cfg) {
  const c = habitCfg(cfg);
  return Object.entries(HABIT_SCHEMA).map(([key, s]) => ({ key, ...s, groupAr: HABIT_GROUP_AR, default: HABIT_DEFAULTS[key], value: c[key] }));
}

/* ── ساعة العادة (custprofile.js بيستعملها) ───────────────────────────────── */
export const H_MS = 3600_000;
export const RIYADH_MS = 3 * H_MS;
/* هيستوجرام ٢٤ خانة من ساعات (الرياض) */
export function hourHistOf(hours) {
  const hist = new Array(24).fill(0);
  for (const h of hours || []) { const n = Number(h); if (Number.isInteger(n) && n >= 0 && n < 24) hist[n]++; }
  return hist;
}
/* ساعة الذروة بعد تنعيم ±١ ساعة (دايري: ٢×الساعة + اللي قبلها + اللي بعدها). أقل من minOrders طلب ⇒ null.
   التعادل: الأعلى خام، وبعدين الأبكر بترتيب يوم العمل (من ٤ الفجر) — عشان نفس الهيستوجرام يطلّع نفس الساعة دايماً. */
export function bestHourOf(hist, minOrders = 3) {
  if (!Array.isArray(hist) || hist.length !== 24) return null;
  const v = hist.map((x) => Math.max(0, Number(x) || 0));
  const total = v.reduce((a, b) => a + b, 0);
  if (total < Math.max(1, Number(minOrders) || 3)) return null;
  let best = null, bs = -1, br = -1;
  for (let i = 0; i < 24; i++) {
    const h = (BIZ_DAY_START_HOUR + i) % 24;
    const s = 2 * v[h] + v[(h + 23) % 24] + v[(h + 1) % 24];
    if (s > bs || (s === bs && v[h] > br)) { best = h; bs = s; br = v[h]; }
  }
  return best;
}

/* ── النافذة والخطة (صافي) ──────────────────────────────────────────────── */
export function riyadhParts(t) { const d = new Date(Number(t) + RIYADH_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes() }; }
/* لحظة نص الليل بالرياض (ms حقيقية) لليوم اللي فيه t */
export const riyadhMidnight = (t) => { const p = riyadhParts(t); return Date.UTC(p.y, p.m, p.d) - RIYADH_MS; };
export const riyadhHHMM = (t) => new Date(Number(t) + RIYADH_MS).toISOString().slice(11, 16);
export const riyadhStamp = (t) => new Date(Number(t) + RIYADH_MS).toISOString().slice(0, 16).replace("T", " ");

/* نافذة «النهارده» من لحظة now: { start, end, day, from, hours[] } — start = أكبر من (دلوقتي، fromHour)، end = القفل (حصري).
   اللف (القفل ≤ البداية، الافتراضي ١٢ → ٢): بعد نص الليل وقبل القفل ⇒ ديل نافذة إمبارح. من غير لف وخلصت النهارده ⇒ بكرة (إعداد نادر). */
export function habitWindow(cfg, now = Date.now()) {
  const c = habitCfg(cfg);
  const wraps = c.nightCutoffHour <= c.fromHour;
  const hR = riyadhParts(now).hour;
  let day = riyadhMidnight(now);
  if (wraps && hR < c.nightCutoffHour) day -= 24 * H_MS;
  let end = day + (wraps ? 24 : 0) * H_MS + c.nightCutoffHour * H_MS;
  if (!wraps && now >= end) { day += 24 * H_MS; end += 24 * H_MS; }
  const from = day + c.fromHour * H_MS;
  const start = Math.max(now, from);
  const hours = [];
  for (let t = start - ((start - day) % H_MS); t < end; t += H_MS) hours.push(riyadhParts(t).hour);
  return { start, end, day, from, hours, cfg: c };
}
/* لحظة الساعة h جوّه يوم النافذة (بيوم العمل — بيقلب ٤ الفجر زي باقي النظام): الساعات بعد نص الليل (h < ٤) تبع يوم النافذة ⇒ اليوم اللي بعده
   (ولو طلعت بعد القفل ⇒ planSendAt بيقول «بره»)؛ ساعات الصبح قبل النافذة (٤ → fromHour) ⇒ نفس اليوم (وبتتقص على أول النافذة). */
export function hourSlot(win, h) {
  const next = h < win.cfg.fromHour && h < BIZ_DAY_START_HOUR;
  return win.day + (next ? 24 : 0) * H_MS + h * H_MS;
}
export const windowView = (win) => ({ start: new Date(win.start).toISOString(), end: new Date(win.end).toISOString(), startRiyadh: riyadhStamp(win.start), endRiyadh: riyadhStamp(win.end),
  fromHour: win.cfg.fromHour, nightCutoffHour: win.cfg.nightCutoffHour, leadMin: win.cfg.leadMin, spreadQuiet: win.cfg.spreadQuiet, hours: win.hours });

/* صف واحد: ساعة عادته − المهلة، مقصوصة على [بداية النافذة، القفل) ⇒ { at (ms) | null, why }.
   at=null = «للهدوء» (why: quiet = مالوش ساعة، passed = ساعته فاتت النهارده، outside = ساعته بره النافذة) — planJob بيوزّعهم. */
export function planSendAt({ profileRow, cfg, now = Date.now(), window = null }) {
  const win = window || habitWindow(cfg, now);
  const raw = profileRow ? profileRow.best_hour : null;
  const h = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (!Number.isInteger(h) || h < 0 || h > 23) return { at: null, why: "quiet" };
  const slot = Math.max(hourSlot(win, h) - win.cfg.leadMin * 60_000, win.from);      // أبكر من أول النافذة ⇒ أول النافذة (زباين الغدا الأول)
  if (slot >= win.end) return { at: null, why: "outside" };
  if (slot < win.start) return { at: null, why: "passed" };                             // فاتت النهارده ⇒ مش بكرة — للهدوء من دلوقتي
  return { at: slot, why: "habit" };
}

/* الحملة كلها: rows = [{ pn, best_hour }] ⇒ { byPn: Map(pn → { at: ISO, why }), hours: [{ hour, n, byHabit, fallback }], noHour, passed, outside, window }.
   الهدوء: كل صف من غير ساعة بيروح لأقل ساعة حمولة في النافذة (الأبكر عند التعادل) طول ما فيها أقل من السعة — فبيملا الساعات الفاضية
   الأول وبالتساوي؛ والدقايق جوّه الساعة متوزّعة. spreadQuiet مقفول ⇒ كلهم في fallbackHour (مقصوصة على النافذة). */
export function planJob({ rows = [], cfg, now = Date.now(), hourCap = 0 }) {
  const win = habitWindow(cfg, now);
  const c = win.cfg;
  const cap = c.maxPerHour > 0 ? c.maxPerHour : Number(hourCap) > 0 ? Number(hourCap) : Infinity;
  const load = new Map(win.hours.map((h) => [h, { n: 0, byHabit: 0, fallback: 0 }]));
  const byPn = new Map();
  const pool = [];
  const counts = { quiet: 0, passed: 0, outside: 0 };
  for (const r of rows) {
    const d = planSendAt({ profileRow: r, cfg: c, now, window: win });
    if (d.at != null) {
      byPn.set(r.pn, { at: new Date(d.at).toISOString(), why: "habit" });
      const b = load.get(riyadhParts(d.at).hour); if (b) { b.n++; b.byHabit++; }
    } else { counts[d.why]++; pool.push({ pn: r.pn, why: d.why }); }
  }
  const placed = new Map();
  for (const p of pool) {
    let at;
    if (!c.spreadQuiet) {
      at = Math.max(hourSlot(win, c.fallbackHour), win.start);
      if (at >= win.end) at = win.start;
    } else {
      let bestH = null, bestN = Infinity;
      for (const h of win.hours) { const n = load.get(h).n; if (n < cap && n < bestN) { bestN = n; bestH = h; } }
      if (bestH == null) for (const h of win.hours) { const n = load.get(h).n; if (n < bestN) { bestN = n; bestH = h; } }
      const k = placed.get(bestH) || 0; placed.set(bestH, k + 1);
      at = Math.max(win.start, hourSlot(win, bestH) + Math.floor(((k * 0.6180339887) % 1) * 60) * 60_000);
      if (at >= win.end) at = win.end - 60_000;
    }
    const b = load.get(riyadhParts(at).hour); if (b) { b.n++; b.fallback++; }
    byPn.set(p.pn, { at: new Date(at).toISOString(), why: p.why });
  }
  return { byPn, hours: win.hours.map((h) => ({ hour: h, ...load.get(h) })), total: rows.length, byHabit: rows.length - pool.length,
    noHour: counts.quiet, passed: counts.passed, outside: counts.outside, window: windowView(win) };
}

/* صفوف طابور متخزّنة (send_at/send_why) ⇒ نفس شكل الشريط: ساعات متتالية من أول ميعاد لآخر ميعاد */
export function storedPlanHours(rows) {
  const ts = (rows || []).map((r) => (r.send_at instanceof Date ? r.send_at.getTime() : Date.parse(String(r.send_at || "")))).filter(Number.isFinite);
  if (!ts.length) return [];
  const lo = Math.min(...ts), hi = Math.max(...ts);
  const first = lo - ((lo - riyadhMidnight(lo)) % H_MS);
  const out = [];
  for (let t = first; t <= hi && out.length < 48; t += H_MS) out.push({ hour: riyadhParts(t).hour, n: 0, byHabit: 0, fallback: 0 });
  for (const r of rows || []) {
    const t = r.send_at instanceof Date ? r.send_at.getTime() : Date.parse(String(r.send_at || ""));
    if (!Number.isFinite(t)) continue;
    const i = Math.floor((t - first) / H_MS);
    const b = out[i]; if (!b) continue;
    b.n++; if (r.send_why === "habit") b.byHabit++; else b.fallback++;
  }
  return out;
}
/* عمود الطابور (wasender.js) */
export const QUEUE_SEND_AT_DDL = Object.freeze([
  "ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS send_at TIMESTAMPTZ",      // CJ1b: ميعاد الصف على عادة العميل (NULL = زي الأول)
  "ALTER TABLE wa_send_queue ADD COLUMN IF NOT EXISTS send_why TEXT",            // CJ1b: habit | quiet | passed | outside
]);
