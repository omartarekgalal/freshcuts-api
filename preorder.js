/* ═══════════════════════════════════════════════════════════════════════════
   الطلب المسبق — «اطلب النهارده لموعد بكرة».

   عمر (٢٢/٩، اليوم الوطني بكرة): الهدف ١٠ آلاف ريال في اليوم. الطريق مش
   طلبات صغيرة أكتر — الطريق سلة أكبر + نمسك طلب بكرة من الليلة. المطبخ
   جاهز لـ٣٠٠ طلب في اليوم، فالسقوف هنا **مش** فرملة على الحجم: هي بس
   توزيع عشان المطبخ يعرف كل شباك محتاج يجهّز كام.

   القواعد اللي بتحكم التصميم:
     • الطلب المسبق بيتدفع **دلوقتي** زي أي طلب (نفس MyFatoorah، نفس نقطة
       البيع) — إحنا بنأجّل التنفيذ، مش الفلوس.
     • بيعدّي حاجز «المطعم مقفول» — دي الفكرة كلها: نمسك الطلب بالليل.
     • المندوب **مايتطلبش** دلوقتي. shop.js بيستنى لحد
       (بداية الشباك − prepLeadMin) قبل ما ياخد الطلب في دورة الإرسال.
     • الشباك بيقفل للحجز قبل بدايته بـcutoffMin — عشان المطبخ يلحق.
     • كل القيم من اللوحة (settings.preorder). مفيش رقم مكتوب في الواجهة.

   مفتاح الشباك المخزّن في shop_orders.scheduled_slot:
       "YYYY-MM-DD#HH:MM-HH:MM"   (تاريخ الرياض # بداية-نهاية)
   والـscheduled_for = بداية الشباك بتوقيت UTC. الاتنين مع بعض بيخلّوا كل
   الشاشات (المطبخ، البوابة، نقطة البيع) تقرا نفس الموعد من غير ما تحسبه تاني.
═══════════════════════════════════════════════════════════════════════════ */

const AR_D = "٠١٢٣٤٥٦٧٨٩";
const arNum = (n) => String(n).replace(/\d/g, (d) => AR_D[Number(d)]);
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* الشبابيك الافتراضية — مقترح ٢٢/٩ لليوم الوطني. المتجر بيفتح ١٢ الضهر
   وبيقفل ٢ الفجر (٣ الخميس والجمعة)، فآخر شباك بينتهي ١ بعد نص الليل.
   المجموع ١٥٠ طلب مسبق في اليوم — نص طاقة المطبخ (٣٠٠)، والنص التاني سايب
   للطلبات الحيّة. عمر بيقدر يعدّلهم من اللوحة في ثانية. */
export const PREORDER_DEFAULT_SLOTS = Object.freeze([
  { id: "s1", start: "12:00", end: "14:00", cap: 25 },
  { id: "s2", start: "14:00", end: "17:00", cap: 30 },
  { id: "s3", start: "17:00", end: "20:00", cap: 40 },
  { id: "s4", start: "20:00", end: "23:00", cap: 40 },
  { id: "s5", start: "23:00", end: "01:00", cap: 15 },
]);

export const PREORDER_DEFAULTS = Object.freeze({
  enabled: true,
  daysAhead: 1,        // بكرة بس. ٣ = لآخر الأسبوع (قرار عمر)
  cutoffMin: 90,       // الشباك بيقفل للحجز قبل بدايته بساعة ونص
  prepLeadMin: 60,     // المطبخ والمندوب بيصحّوا قبل الشباك بساعة
  minTotal: 0,         // حد أدنى للطلب المسبق (٠ = مفيش)
  note: "نجهّزه ونوصّله في الموعد اللي تختاره",
  slots: PREORDER_DEFAULT_SLOTS,
});

const clampN = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/* ── الوقت: كل حاجة بتوقيت الرياض (+03:00 ثابتة، مفيش صيفي) ───────────── */
export const RIYADH_OFFSET_MS = 3 * 3600_000;

/** تاريخ الرياض (YYYY-MM-DD) للحظة معيّنة، + إزاحة أيام اختيارية. */
export function riyadhDay(now = Date.now(), plusDays = 0) {
  const t = new Date(new Date(now).getTime() + RIYADH_OFFSET_MS + plusDays * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** لحظة UTC لـ«يوم رياض + HH:MM». */
export function riyadhAt(day, hhmm) {
  return new Date(`${day}T${hhmm}:00+03:00`);
}

/** "١٢:٠٠ظ" بالعربي من "HH:MM". */
export function ar12(hhmm) {
  const m = HHMM_RE.exec(String(hhmm || ""));
  if (!m) return String(hhmm || "");
  const h = Number(m[1]);
  const ap = h >= 12 ? "م" : "ص";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${arNum(h12)}:${arNum(m[2])}${ap}`;
}

/** «النهارده» / «بكرة» / اسم اليوم. */
const AR_WEEK = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
export function dayLabel(day, now = Date.now()) {
  if (day === riyadhDay(now, 0)) return "النهارده";
  if (day === riyadhDay(now, 1)) return "بكرة";
  const d = new Date(`${day}T12:00:00+03:00`);
  return AR_WEEK[d.getUTCDay()] || day;
}

/* ── الإعدادات ─────────────────────────────────────────────────────────── */
function normSlots(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const s of list.slice(0, 12)) {
    if (!s) continue;
    const start = String(s.start || "").trim();
    const end = String(s.end || "").trim();
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end) || start === end) continue;
    let id = String(s.id || "").trim().slice(0, 12) || `s${out.length + 1}`;
    while (seen.has(id)) id += "x";
    seen.add(id);
    out.push({ id, start, end, cap: Math.round(clampN(s.cap, 0, 500, 25)) });
  }
  return out.length ? out : PREORDER_DEFAULT_SLOTS.map((s) => ({ ...s }));
}

export function preorderCfg(settings) {
  const x = { ...PREORDER_DEFAULTS, ...(((settings || {}).preorder) || {}) };
  return {
    enabled: typeof x.enabled === "boolean" ? x.enabled : true,
    daysAhead: Math.round(clampN(x.daysAhead, 0, 7, 1)),
    cutoffMin: Math.round(clampN(x.cutoffMin, 0, 720, 90)),
    prepLeadMin: Math.round(clampN(x.prepLeadMin, 0, 240, 60)),
    minTotal: Math.round(clampN(x.minTotal, 0, 5000, 0)),
    note: String(x.note ?? PREORDER_DEFAULTS.note).slice(0, 160),
    slots: normSlots(x.slots),
  };
}

/* ── المفتاح ───────────────────────────────────────────────────────────── */
export const slotKey = (day, slot) => `${day}#${slot.start}-${slot.end}`;

export function parseSlotKey(key) {
  const m = /^(\d{4}-\d{2}-\d{2})#([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(key || ""));
  if (!m) return null;
  return { day: m[1], start: `${m[2]}:${m[3]}`, end: `${m[4]}:${m[5]}` };
}

/** بداية/نهاية الشباك بتوقيت UTC. النهاية اللي «قبل» البداية = بعد نص الليل. */
export function slotWindow(day, start, end) {
  const s = riyadhAt(day, start);
  let e = riyadhAt(day, end);
  if (e <= s) e = new Date(e.getTime() + 86_400_000);
  return { start: s, end: e };
}

/** «بكرة ٧:٠٠م – ١٠:٠٠م» — النص الوحيد اللي كل الشاشات بتستخدمه. */
export function slotLabel(key, now = Date.now()) {
  const p = parseSlotKey(key);
  if (!p) return "";
  return `${dayLabel(p.day, now)} ${ar12(p.start)} – ${ar12(p.end)}`;
}

/* ── عدّ المحجوز ───────────────────────────────────────────────────────── */
/* الطلب اللي لسه بيدفع بيحجز مكانه ٢٠ دقيقة بس — بعد كده لو مادفعش بيسيب
   الشباك لغيره. المرفوض/المنتهي عمره ما بيتعد. */
export const SLOT_COUNT_SQL = `
  SELECT scheduled_slot AS key, count(*)::int AS n
    FROM shop_orders
   WHERE scheduled_slot IS NOT NULL
     AND scheduled_for > NOW() - INTERVAL '1 day'
     AND status NOT IN ('expired','rejected_refunded','refund_failed')
     AND (status <> 'pending_payment' OR created_at > NOW() - INTERVAL '20 minutes')
   GROUP BY 1`;

export async function slotCounts(pool) {
  try {
    const r = await pool.query(SLOT_COUNT_SQL);
    const m = new Map();
    for (const row of r.rows) m.set(row.key, Number(row.n) || 0);
    return m;
  } catch {
    return new Map(); // العمود لسه ماتضافش؟ مانكسرش المتجر
  }
}

/* ── قايمة الشبابيك المعروضة للعميل ────────────────────────────────────── */
/**
 * @returns [{key, day, dayLabel, start, end, label, cap, taken, left, full,
 *            closed, startsAt, endsAt}]
 *   closed = عدّى وقت القفل (cutoff). full = اتحجز بالكامل.
 *   المتجر بيوري المقفول/الممتلئ معطّل، مش بيخفيه — العميل يفهم ليه.
 */
export function slotsFor(cfg, counts = new Map(), now = Date.now()) {
  const out = [];
  const t = new Date(now).getTime();
  for (let d = 0; d <= cfg.daysAhead; d++) {
    const day = riyadhDay(t, d);
    for (const s of cfg.slots) {
      const { start, end } = slotWindow(day, s.start, s.end);
      // شباك خلص أصلاً؟ مالوش لازمة في القايمة
      if (end.getTime() <= t) continue;
      const key = slotKey(day, s);
      const cap = s.cap;
      const taken = counts.get(key) || 0;
      const closed = start.getTime() - cfg.cutoffMin * 60_000 <= t;
      out.push({
        key, day, dayLabel: dayLabel(day, t), start: s.start, end: s.end,
        label: `${ar12(s.start)} – ${ar12(s.end)}`,
        fullLabel: slotLabel(key, t),
        cap, taken, left: Math.max(0, cap - taken),
        full: cap > 0 && taken >= cap,
        closed,
        startsAt: start.toISOString(), endsAt: end.toISOString(),
      });
    }
  }
  return out.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
}

/* ── التحقق وقت الدفع ──────────────────────────────────────────────────── */
/**
 * @returns {ok:true, key, startsAt:Date, endsAt:Date, label} | {ok:false, error, message}
 */
export function validateSlot(key, cfg, counts = new Map(), now = Date.now()) {
  if (!cfg.enabled) return { ok: false, error: "preorder_disabled", message: "الطلب المسبق مقفول حالياً." };
  const p = parseSlotKey(key);
  if (!p || !DAY_RE.test(p.day)) return { ok: false, error: "bad_slot", message: "الموعد ده مش مفهوم — اختار موعد من القايمة." };
  const match = cfg.slots.find((s) => s.start === p.start && s.end === p.end);
  if (!match) return { ok: false, error: "unknown_slot", message: "الموعد ده اتغيّر — اختار موعد تاني." };
  const t = new Date(now).getTime();
  const maxDay = riyadhDay(t, cfg.daysAhead);
  if (p.day < riyadhDay(t, 0) || p.day > maxDay) {
    return { ok: false, error: "slot_out_of_range", message: "الموعد ده بعيد أوي — اختار موعد من القايمة." };
  }
  const { start, end } = slotWindow(p.day, p.start, p.end);
  if (start.getTime() - cfg.cutoffMin * 60_000 <= t) {
    return { ok: false, error: "slot_closed", message: "الموعد ده قفل للحجز — اختار موعد بعده." };
  }
  const taken = counts.get(key) || 0;
  if (match.cap > 0 && taken >= match.cap) {
    return { ok: false, error: "slot_full", message: "الموعد ده كمل — اختار موعد تاني." };
  }
  return { ok: true, key, startsAt: start, endsAt: end, label: slotLabel(key, t) };
}

/** الطلب المسبق دخل وقت التنفيذ؟ (المطبخ والمندوب بيصحّوا هنا) */
export function isDueNow(scheduledFor, cfg, now = Date.now()) {
  if (!scheduledFor) return true;                       // طلب عادي
  const s = new Date(scheduledFor).getTime();
  if (!Number.isFinite(s)) return true;
  return s - cfg.prepLeadMin * 60_000 <= new Date(now).getTime();
}

/* ── التسجيل: مسار عام للمتجر + إعدادات للوحة ──────────────────────────── */
export function register(app, ctx) {
  const { pool, requireAdmin, getSettingsData, jb } = ctx;
  const bad = (c, error, status = 400, extra = {}) => c.json({ ok: false, error, ...extra }, status);

  /* المتجر بيسأل: أقدر أطلب لإمتى، وإيه الفاضي؟ */
  app.get("/api/shop/preorder/slots", async (c) => {
    const cfg = preorderCfg(await getSettingsData());
    if (!cfg.enabled) return c.json({ ok: true, enabled: false, slots: [] });
    const counts = await slotCounts(pool);
    const slots = slotsFor(cfg, counts, Date.now()).map((s) => ({
      // الأرقام الداخلية (cap/taken) مالهاش لازمة عند العميل — «فاضل ٣» بس
      key: s.key, day: s.day, dayLabel: s.dayLabel, label: s.label,
      fullLabel: s.fullLabel, startsAt: s.startsAt, endsAt: s.endsAt,
      left: s.cap > 0 ? s.left : null, full: s.full, closed: s.closed,
    }));
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ ok: true, enabled: true, note: cfg.note, minTotal: cfg.minTotal, slots });
  });

  /* اللوحة: الشبابيك والسقوف والمحجوز فيها */
  app.get("/api/cms/preorder", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const cfg = preorderCfg(await getSettingsData());
    const counts = await slotCounts(pool);
    let upcoming = [];
    try {
      upcoming = (await pool.query(
        `SELECT order_no, option, total, scheduled_slot, scheduled_for, status, customer->>'name' AS name
           FROM shop_orders
          WHERE scheduled_for IS NOT NULL AND scheduled_for > NOW() - INTERVAL '6 hours'
            AND status NOT IN ('pending_payment','expired','rejected_refunded')
          ORDER BY scheduled_for ASC LIMIT 200`)).rows;
    } catch { upcoming = []; }
    return c.json({
      ok: true, config: cfg, defaults: PREORDER_DEFAULTS,
      slots: slotsFor(cfg, counts, Date.now()), upcoming,
    });
  });

  app.put("/api/cms/preorder", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return bad(c, "bad json"); }
    const val = preorderCfg({ preorder: b });
    await pool.query(`UPDATE settings SET data = jsonb_set(data, '{preorder}', $1::jsonb, true) WHERE id=1`, [jb(val)]);
    return c.json({ ok: true, config: val });
  });

  return { preorderCfg, slotsFor, slotCounts, validateSlot, isDueNow, slotLabel };
}
