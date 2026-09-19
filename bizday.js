/* ═══════════════════════════════════════════════════════════════════════════
   BIZDAY — اليوم التشغيلي. تعريف واحد للـAPI كله (عمر، ١٩ سبتمبر ٢٠٢٦).

   قاعدة المالك: اليوم بيبدأ ١١ الصبح وبيخلص ٣ الفجر بتوقيت الرياض — طلب
   الساعة ١ بالليل يوم ١٩/٩ بيتحسب على ١٨/٩.

   التنفيذ: اليوم التشغيلي D = [D 04:00 الرياض ، D+1 04:00 الرياض).
   ليه ٤ مش ٣؟ الخميس والجمعة بنقفل ٣ الفجر وآخر طلبات بتتسجّل ٣:٠٥–٣:٥٠؛
   لو القطع ٣:٠٠ كانت هتروح على يوم الجمعة/السبت اللي لسه مافتحش. وبين ٤ و١١
   مفيش طلبات (٣ طلبات من ٤١٤٣ في الكاش كله)، فأي ساعة بين ٤ و١١ تدّي نفس
   النتيجة — واخترنا ٤ لأنها بالظبط اللي تاب سينس بيقفل عليها `calendar_day`،
   فأرقامنا بتطابق تقارير نقطة البيع. الإعلانات بتصرف أحياناً ٤–١١ الصبح:
   الصرف ده بيتحسب على اليوم اللي جاي (هو اللي بيجيب طلباته).

   الرياض UTC+3 طول السنة (مفيش توقيت صيفي)، فكل الحسابات هنا عدد ساعات ثابت:
     بداية اليوم D = D 01:00Z      نهايته = D+1 01:00Z
     bizDay(ts)   = تاريخ (ts − 1 ساعة) بتوقيت UTC

   الملف صافي (من غير DB) ومتختبر في bizday.test.mjs.
═══════════════════════════════════════════════════════════════════════════ */

export const BIZ_TZ = "Asia/Riyadh";
export const RIYADH_OFFSET_H = 3;
export const BIZ_ROLL_HOUR = 4;   // الساعة (الرياض) اللي اليوم بيتقفل عندها تقنياً
export const BIZ_OPEN_HOUR = 11;  // للعرض: «من ١١ الصبح»
export const BIZ_CLOSE_HOUR = 3;  // للعرض: «لـ٣ الفجر»
const SHIFT_MS = (BIZ_ROLL_HOUR - RIYADH_OFFSET_H) * 3600e3; // ١ ساعة
const DAY_MS = 86400e3;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* SQL: اليوم التشغيلي لعمود timestamptz. نفس القاعدة بالظبط. */
export const bizDaySql = (col) => `((${col} AT TIME ZONE '${BIZ_TZ}') - interval '${BIZ_ROLL_HOUR} hours')::date`;
/* SQL: ساعة الرياض (0–23) */
export const riyadhHourSql = (col) => `(extract(hour from (${col} AT TIME ZONE '${BIZ_TZ}'))::int)`;

const toMs = (ts) => (ts instanceof Date ? ts.getTime() : typeof ts === "number" ? ts : Date.parse(ts));

/** اليوم التشغيلي (YYYY-MM-DD) للحظة زمنية. */
export function bizDay(ts) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - SHIFT_MS).toISOString().slice(0, 10);
}
/** بداية اليوم التشغيلي كلحظة UTC (Date). */
export const bizStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + SHIFT_MS);
/** نهاية اليوم التشغيلي (حصرية). */
export const bizEnd = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + SHIFT_MS + DAY_MS);
/** ساعة الرياض 0–23 للحظة. */
export const riyadhHour = (ts) => new Date(toMs(ts) + RIYADH_OFFSET_H * 3600e3).getUTCHours();
/** ترتيب الساعة جوّه اليوم التشغيلي (٤ الفجر = 0 … ٣ الفجر = 23). */
export const bizHourIndex = (h) => (h - BIZ_ROLL_HOUR + 24) % 24;
/** كام ساعة عدّت من اليوم التشغيلي الحالي. */
export const bizElapsedH = (now = new Date()) => (toMs(now) - bizStart(bizDay(now)).getTime()) / 3600e3;

export function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const spanDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = الأحد
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 800; d = shiftDay(d, 1)) out.push(d);
  return out;
}

/* ── الفترات الجاهزة ─────────────────────────────────────────────────────── */
export const PRESETS = [
  { id: "today", label: "اليوم" },
  { id: "yesterday", label: "أمس" },
  { id: "last7", label: "آخر ٧ أيام" },
  { id: "last30", label: "آخر ٣٠ يوم" },
  { id: "last90", label: "آخر ٩٠ يوم" },
  { id: "mtd", label: "من أول الشهر" },
  { id: "wtd", label: "من أول الأسبوع" },
  { id: "thisWeek", label: "الأسبوع الحالي" },
  { id: "lastWeek", label: "الأسبوع الماضي" },
  { id: "lastMonth", label: "الشهر الماضي" },
];
const PRESET_IDS = new Set(PRESETS.map((p) => p.id));
// الأسبوع بيبدأ الأحد افتراضياً (أسبوع العمل في السعودية) — settings.reportWeekStart يغيّره (0=الأحد … 6=السبت)
export const DEFAULT_WEEK_START = 0;

function weekStartOf(day, weekStart) {
  const back = (weekdayOf(day) - weekStart + 7) % 7;
  return shiftDay(day, -back);
}

/**
 * يحوّل ?preset= أو ?from=&to= لفترة كاملة جاهزة للاستعلام.
 * بيرجّع:
 *   from/to (أيام تشغيلية)، startUtc/endUtc (حدود زمنية، النهاية حصرية)،
 *   cutUtc = min(النهاية، دلوقتي) — اللي بيتقرا فعلاً،
 *   partial = الفترة فيها اليوم الحالي (لسه ماخلصش)،
 *   prev = الفترة اللي قبلها بنفس الطول، lastWeek = نفس أيام الأسبوع قبلها بأسابيع كاملة.
 *   المقارنات بتتقطع عند نفس اللحظة النسبية (يوم ناقص قدام يوم ناقص).
 */
export function bizRange({ preset, from, to, now = new Date(), weekStart = DEFAULT_WEEK_START } = {}) {
  const today = bizDay(now);
  let id = PRESET_IDS.has(preset) ? preset : null;
  let f, t;
  if (!id && DAY_RE.test(String(from || "")) && DAY_RE.test(String(to || ""))) {
    id = "custom"; f = from <= to ? from : to; t = from <= to ? to : from;
  } else if (!id && DAY_RE.test(String(from || ""))) {
    id = "custom"; f = from; t = from;
  } else {
    id = id || "today";
    const ws = weekStartOf(today, weekStart);
    const m0 = `${today.slice(0, 7)}-01`;
    switch (id) {
      case "yesterday": f = t = shiftDay(today, -1); break;
      case "last7": f = shiftDay(today, -6); t = today; break;
      case "last30": f = shiftDay(today, -29); t = today; break;
      case "last90": f = shiftDay(today, -89); t = today; break;
      case "mtd": f = m0; t = today; break;
      case "wtd": f = ws; t = today; break;
      case "thisWeek": f = ws; t = shiftDay(ws, 6); break;
      case "lastWeek": f = shiftDay(ws, -7); t = shiftDay(ws, -1); break;
      case "lastMonth": {
        const lastDayPrev = shiftDay(m0, -1);
        f = `${lastDayPrev.slice(0, 7)}-01`; t = lastDayPrev; break;
      }
      default: f = t = today;
    }
  }
  // ماينفعش فترة أطول من ٤٠٠ يوم (حماية للاستعلامات)
  if (spanDays(f, t) > 400) f = shiftDay(t, -399);
  const days = spanDays(f, t);
  const startUtc = bizStart(f), endUtc = bizEnd(t);
  const nowMs = toMs(now);
  const cutUtc = new Date(Math.max(startUtc.getTime(), Math.min(endUtc.getTime(), nowMs)));
  const partial = endUtc.getTime() > nowMs && startUtc.getTime() <= nowMs;
  const future = startUtc.getTime() > nowMs;

  const mk = (shift, label, key) => {
    const ff = shiftDay(f, -shift), tt = shiftDay(t, -shift);
    return {
      key, label, from: ff, to: tt, shiftDays: shift,
      startUtc: new Date(startUtc.getTime() - shift * DAY_MS),
      // نفس اللحظة النسبية: لو إحنا في نص اليوم، المقارنة بتتقطع عند نفس الساعة
      cutUtc: new Date(cutUtc.getTime() - shift * DAY_MS),
      endUtc: new Date(endUtc.getTime() - shift * DAY_MS),
    };
  };
  const weekShift = 7 * Math.max(1, Math.ceil(days / 7));
  const prevLabel = days === 1 ? (id === "today" ? "أمس" : "اليوم اللي قبله") : `الـ${days} يوم اللي قبلها`;
  const lwLabel = days === 1 ? "نفس اليوم الأسبوع اللي فات"
    : weekShift === 7 ? "نفس الأيام الأسبوع اللي فات" : `نفس الأيام قبل ${weekShift / 7} أسابيع`;
  return {
    preset: id,
    label: id === "custom" ? (f === t ? f : `${f} ← ${t}`) : PRESETS.find((p) => p.id === id).label,
    from: f, to: t, days, today, weekStart,
    startUtc, endUtc, cutUtc, partial, future,
    elapsedH: partial ? Math.round(((nowMs - bizStart(today).getTime()) / 3600e3) * 100) / 100 : null,
    window: `من ${BIZ_OPEN_HOUR} الصبح لـ${BIZ_CLOSE_HOUR} الفجر (بتوقيت الرياض)`,
    prev: mk(days, prevLabel, "prev"),
    lastWeek: mk(weekShift, lwLabel, "lastWeek"),
  };
}

/** نسخة JSON من الفترة (للرد على الواجهة). */
export function rangeJson(r) {
  const iso = (d) => (d instanceof Date ? d.toISOString() : d);
  const side = (x) => ({ key: x.key, label: x.label, from: x.from, to: x.to, shiftDays: x.shiftDays });
  return {
    preset: r.preset, label: r.label, from: r.from, to: r.to, days: r.days, today: r.today,
    partial: r.partial, elapsedH: r.elapsedH, startUtc: iso(r.startUtc), endUtc: iso(r.endUtc), cutUtc: iso(r.cutUtc),
    window: r.window, prev: side(r.prev), lastWeek: side(r.lastWeek),
  };
}

/** قراءة الفترة من query string لأي route. */
export function rangeFromQuery(q, { now, weekStart } = {}) {
  return bizRange({ preset: q("preset"), from: q("from"), to: q("to"), now, weekStart });
}
