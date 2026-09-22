/* ═══════════════════════════════════════════════════════════════════════════
   CHECKOUT WATCH — حارس «في ناس واصلة للدفع ومحدش بيدفع»

   ليه اتبنى (٢٢ سبتمبر ٢٠٢٦): شاشة العرض قبل الدفع اتنشرت ٤:٣٣ العصر
   وكسرت إتمام الطلب في صمت. الطلبات المدفوعة بقت صفر، والعملاء فضلوا
   واصلين لحد «جاهز يدفع» وبيقعوا هناك. محدش خد باله ساعتين و١٧ دقيقة —
   المالك هو اللي اكتشفها بنفسه. الداتا كانت بتقول الحكاية من أول دقيقة.

   الإشارة الصح — مش «صفر طلبات»:
     المتجر بيعمل ٨–١٦ طلب مدفوع في اليوم على ١٤ ساعة شغل = أقل من طلب
     في الساعة. يعني «صفر طلبات في ٤٥ دقيقة» هي الحالة الطبيعية معظم
     الوقت، وأي إنذار مبني عليها لوحدها بيرن كل يوم ويتجاهله الكل.

     وكمان «وصل للسلة» (max_step>=2) إشارة ضعيفة: ٧١٠ جلسة سلة مقابل ٦٨
     طلب = جلسة من كل ١٠ بتدفع، فـ٦ جلسات سلة من غير طلب حاجة عادية جداً.
     الـbacktest: قاعدة السلة دي كانت هترن ٢٠–٤٠ مرة في ٥ أيام. مرفوضة.

     اللي حصل فعلاً يوم ٢٢/٩: ١٤ جلسة وقفت عند خطوة ٥ (العنوان اتقبل =
     جاهز يدفع) و**صفر** وصلوا لصفحة الدفع (خطوة ٦). الطبيعي في نفس
     الساعات: ٦ جلسات بس وقفت عند ٥ على مدى أيام. الكسر كان بالظبط بين
     خطوة ٥ وخطوة ٦ — وده اللي الشاشة الجديدة قعدت فيه.

   فالقاعدة بتتقاس عند آخر خطوة قبل الدفع، مش عند السلة:
     في ساعات الشغل، لو (جلسات وصلت خطوة ≥٥ في آخر نافذة) ≥ الحد
     و(طلبات مدفوعة حقيقية في نفس النافذة) = صفر ⇒ إنذار.

   ليه خطوة ٥ مش خطوة ٦؟ خطوة ٥ بتشمل اللي وصلوا ٦ و٧ كمان (max_step
   تراكمي)، فالقاعدة بتمسك الاتنين: الكسر قبل صفحة الدفع (زي النهاردة)
   والكسر جوّه بوابة الدفع نفسها. شرط «وصل لصفحة الدفع = صفر» اتجرب
   وبيقلّل التأخير ٥ دقايق بس، ومقابلها بيعمي الحارس عن عطل ماي فاتورة —
   فاتشال، وفضل رقم payPage في الرسالة كدليل تشخيصي بس.

   الحدود اتظبطت على الداتا الحقيقية (١٧–٢٢ سبتمبر — رحلة العميل نفسها
   مابدأتش تتسجّل قبل ١٧/٩، فمفيش ٣٠ يوم أصلاً). شوف التقرير.

   تفاصيل مهمة:
     • «مدفوع حقيقي» = mf_payment_id موجود + مش is_test + الحالة مش من
       حالات الفشل (نفس PAID_SQL بتاع carts.js) + الإجمالي ≥ ٢٠ ريال.
       طلب الـ١ ريال اللي اتعمل وسط العطل النهاردة كان تجربة واترفض —
       لو حسبناه كان سكّت الإنذار. التجارب الصغيرة ماتسكتش الحارس.
     • بنعدّ من journey_events بوقت الحدث نفسه (أول لحظة الجلسة وصلت
       خطوة ٥)، مش من last_seen_at بتاع الجلسة. الجلسة اللي التاب بتاعها
       فاضل مفتوح بيتأخّر last_seen_at بتاعها ويأخّر الاكتشاف؛ وقت الحدث
       حقيقة ثابتة. ده وفّر ٧ دقايق في اختبار عطل النهاردة وشال الحاجة
       لأي مهلة «تهدئة» صناعية.
     • المواعيد مصدرها الوحيد settings.hours عن طريق isOpenNow (نفس
       اللي المتجر بيستعمله) — مفيش ساعات متكتوبة في الكود.
     • إنذار واحد للحادثة. الرجوع بيتبعت **بس** لما تنزل طلبات فعلاً؛
       لو الدنيا هديت من غير طلبات بنرجع نسلّح في صمت (ما نقولش «تمام»
       والدفع لسه واقف).

   الإرسال عن طريق staffalerts.js (critical) — نفس قناة إنذارات المدير،
   بالإنجليزي، والأرقام واللغة من اللوحة. مفيش قناة جديدة.
═══════════════════════════════════════════════════════════════════════════ */
import { isOpenNow } from "./carts.js";
import { fitOneSms } from "./staffalerts.js";
import { bizDay } from "./bizday.js";

/* نفس تعريف carts.js للطلب المدفوع فعلاً */
export const PAID_SQL = "status NOT IN ('pending_payment','expired','rejected_refunded','refund_failed','paid_pos_failed')";
/* جلسة «حقيقية» — من غير البوتات ولا الاختبار ولا الموظفين. `a` = اسم الجدول. */
export const realSessionSql = (a = "") => {
  const p = a ? `${a}.` : "";
  return `COALESCE(${p}is_bot,false)=false AND COALESCE(${p}is_qa,false)=false AND COALESCE(${p}is_staff,false)=false`;
};

/* خطوة ٥ = «حدّد عنوان مقبول (أو استلام)» — آخر خطوة قبل صفحة الدفع.
   خطوة ٦ = «وصل لصفحة الدفع». journey.js هو مرجع الأرقام. */
export const READY_STEP = 5;
export const PAY_PAGE_STEP = 6;

/* الحدود من الـbacktest (١٧–٢٢ سبتمبر، تقييم كل ٥ دقايق، ساعات الشغل بس):
     ٤٥ دقيقة × ٥ جلسات ⇒ رنّة واحدة بس في كل الفترة، وهي عطل النهاردة،
     وصفر إنذار كاذب. تقليل الحد لـ٣ بيدّي ٢ إنذار كاذب في ٥ أيام
     (~١٢ في الشهر) مقابل ١٠ دقايق أسرع — مش مستاهل. */
export const WATCH_DEFAULTS = Object.freeze({
  enabled: true,
  windowMin: 45,      // النافذة المتحركة
  threshold: 5,       // كام جلسة «جاهزة للدفع» تخلّي الصمت مريب
  minTotal: 20,       // أقل من كده = تجربة، مش طلب
  everyMin: 5,        // كل قد إيه بنقيس
  maxAlertsPerDay: 4, // حزام أمان: مهما حصل ماتغرقش المدير برسايل
});

const clampN = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** الإعدادات من اللوحة (settings.checkoutWatch) فوق الافتراضي. صافية. */
export function watchCfg(settings) {
  const x = { ...WATCH_DEFAULTS, ...(((settings || {}).checkoutWatch) || {}) };
  return {
    enabled: x.enabled !== false,
    windowMin: Math.round(clampN(x.windowMin, 15, 180, 45)),
    threshold: Math.round(clampN(x.threshold, 2, 50, 5)),
    minTotal: clampN(x.minTotal, 0, 500, 20),
    everyMin: Math.round(clampN(x.everyMin, 1, 60, 5)),
    maxAlertsPerDay: Math.round(clampN(x.maxAlertsPerDay, 1, 20, 4)),
  };
}

export const WATCH_DDL = `
  CREATE TABLE IF NOT EXISTS checkout_watch (
    id            smallint PRIMARY KEY,
    state         text NOT NULL DEFAULT 'ok',
    incident_at   timestamptz,
    alerted_at    timestamptz,
    recovered_at  timestamptz,
    last_run_at   timestamptz,
    alerts_day    date,
    alerts_count  integer NOT NULL DEFAULT 0,
    last_metrics  jsonb
  )`;

/* ── القرار (صافي — متختبر من غير داتابيز) ────────────────────────────── */
/**
 * @param {{ready:number, payPage:number, paid:number}} m  قياسات النافذة
 * @param {{state:string}} prev  الحالة السابقة (ok | alerting)
 * @param {{threshold:number}} cfg
 * @param {boolean} open  المطعم مفتوح؟
 * @returns {{bad:boolean, action:"none"|"alert"|"recover"|"rearm", state:string}}
 */
export function decide(m, prev, cfg, open) {
  const state = (prev && prev.state) === "alerting" ? "alerting" : "ok";
  // مقفول: نسلّح من غير أي رسالة. السكوت وإحنا قافلين مش عطل.
  if (!open) return { bad: false, action: state === "alerting" ? "rearm" : "none", state: "ok" };

  const bad = m.ready >= cfg.threshold && m.paid === 0;
  if (bad) return { bad, action: state === "alerting" ? "none" : "alert", state: "alerting" };
  if (state !== "alerting") return { bad, action: "none", state: "ok" };
  // كنا في إنذار وخرجنا منه: «رجع» بس لو فيه طلبات فعلاً نزلت.
  return { bad, action: m.paid > 0 ? "recover" : "rearm", state: "ok" };
}

/* ── نص الرسايل (رسالة واحدة، الإنجليزي هو الافتراضي) ─────────────────── */
export function downText(m, cfg, lang = "en") {
  if (lang === "ar") {
    return fitOneSms(`فريش كاتس عاجل: الدفع واقف - ${m.ready} جاهز للدفع و0 طلب في ${cfg.windowMin} دقيقة`);
  }
  return fitOneSms(
    `Fresh Cuts ALERT: checkout looks DOWN. ${m.ready} customers ready to pay in last ${cfg.windowMin}min, 0 paid${
      m.payPage === 0 ? ", 0 reached payment page" : ""}. Test the site now.`);
}

export function upText(minutes, lang = "en") {
  if (lang === "ar") return fitOneSms(`فريش كاتس: الدفع رجع شغال والطلبات مشت بعد ${minutes} دقيقة`);
  return fitOneSms(`Fresh Cuts OK: checkout recovered, paid orders resumed after ${minutes}min.`);
}

/* ── دورة واحدة ───────────────────────────────────────────────────────── */
/**
 * @param {{pool, getSettingsData, staff, log}} ctx
 *   staff = makeStaffNotifier(...) — بنستعمل critical() بس.
 */
export async function runOnce(ctx, { now = new Date(), dryRun = false } = {}) {
  const { pool, getSettingsData, staff, log = console.log } = ctx;
  const settings = await getSettingsData();
  const cfg = watchCfg(settings);
  if (!cfg.enabled) return { skipped: "disabled" };

  const open = isOpenNow(settings && settings.hours, now);
  const from = new Date(now.getTime() - cfg.windowMin * 60e3);

  const [s, o] = await Promise.all([
    /* عدد الجلسات الحقيقية اللي وصلت خطوة ٥ (وخطوة ٦) جوّه النافذة —
       بوقت الحدث نفسه من journey_events. */
    pool.query(
      `SELECT count(DISTINCT e.session_id) FILTER (WHERE e.step >= ${READY_STEP})::int    AS ready,
              count(DISTINCT e.session_id) FILTER (WHERE e.step >= ${PAY_PAGE_STEP})::int AS pay_page
         FROM journey_events e
         JOIN journey_sessions s USING (session_id)
        WHERE e.step IS NOT NULL AND e.at >= $1 AND e.at < $2
          AND ${realSessionSql("s")}`, [from, now]),
    pool.query(
      `SELECT count(*)::int AS paid, max(created_at) AS last_paid
         FROM shop_orders
        WHERE mf_payment_id IS NOT NULL AND COALESCE(is_test,false)=false
          AND ${PAID_SQL} AND total >= $3
          AND created_at >= $1 AND created_at < $2`, [from, now, cfg.minTotal]),
  ]);

  const m = {
    ready: s.rows[0].ready, payPage: s.rows[0].pay_page,
    paid: o.rows[0].paid, lastPaid: o.rows[0].last_paid || null,
  };

  await pool.query(WATCH_DDL);
  const prev = (await pool.query(`SELECT * FROM checkout_watch WHERE id=1`)).rows[0] || { state: "ok" };
  const d = decide(m, prev, cfg, open);

  /* سقف يومي — لو حاجة اتكسرت في القاعدة نفسها، المدير ما يغرقش. اليوم
     التشغيلي (بيلف ٤ الفجر) عشان ليلة واحدة تتعدّ ليلة واحدة. */
  const day = bizDay(now);
  const usedToday = prev.alerts_day && String(prev.alerts_day).slice(0, 10) === day ? (prev.alerts_count || 0) : 0;
  const capped = d.action === "alert" && usedToday >= cfg.maxAlertsPerDay;
  const action = capped ? "capped" : d.action;

  const cfgLang = ((settings && settings.delivery) || {}).staffSmsLanguage === "ar" ? "ar" : "en";
  let sent = 0, text = null;
  if (action === "alert") {
    text = downText(m, cfg, cfgLang);
    if (!dryRun) sent = await staff.critical(() => text, "checkout-down");
  } else if (action === "recover") {
    const mins = prev.incident_at ? Math.round((now - new Date(prev.incident_at)) / 60e3) : 0;
    text = upText(mins, cfgLang);
    if (!dryRun) sent = await staff.critical(() => text, "checkout-up");
  }

  if (!dryRun) {
    await pool.query(
      `INSERT INTO checkout_watch (id, state, incident_at, alerted_at, recovered_at, last_run_at,
                                   alerts_day, alerts_count, last_metrics)
       VALUES (1, $1, $2, $3, $4, $5, $6::date, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET state=$1, incident_at=$2, alerted_at=$3, recovered_at=$4,
         last_run_at=$5, alerts_day=$6::date, alerts_count=$7, last_metrics=$8::jsonb`,
      [d.state,
        action === "alert" ? now : (d.state === "alerting" ? prev.incident_at : null),
        action === "alert" ? now : prev.alerted_at,
        action === "recover" ? now : prev.recovered_at,
        now, day, usedToday + (action === "alert" ? 1 : 0),
        JSON.stringify({ ...m, open, cfg, action, capped })]);
  }

  const line = `open=${open} ready=${m.ready} payPage=${m.payPage} paid=${m.paid} -> ${action}${sent ? ` (sms:${sent})` : ""}`;
  log(`[checkout-watch] ${line}`);
  return { ...d, action, capped, metrics: m, cfg, open, sent, text, line };
}

/* ── تركيب في التطبيق (لما ينزل نشر) ──────────────────────────────────── */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData } = ctx;
  const staff = deps.staff;
  const cfg0 = () => watchCfg(null);

  pool.query(WATCH_DDL).then(() => console.log("[checkout-watch] ready"))
    .catch((e) => console.error("[checkout-watch] init failed:", e.message));

  if (deps.schedule !== false) {
    const every = cfg0().everyMin * 60_000;
    setInterval(() => runOnce({ pool, getSettingsData, staff })
      .catch((e) => console.error("[checkout-watch] failed:", e.message)), every);
  }

  /* حالة الحارس + تشغيل يدوي بدون إرسال (للوحة) */
  app.get("/api/system/checkout-watch", async (c) => {
    if (requireAdmin && (await requireAdmin(c)) === false) return c.json({ ok: false }, 403);
    const row = (await pool.query(`SELECT * FROM checkout_watch WHERE id=1`)).rows[0] || null;
    const dry = await runOnce({ pool, getSettingsData, staff }, { dryRun: true });
    return c.json({ ok: true, state: row, now: dry });
  });

  return { runOnce: (opts) => runOnce({ pool, getSettingsData, staff }, opts) };
}
