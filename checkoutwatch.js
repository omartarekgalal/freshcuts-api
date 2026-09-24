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

   ─── القاعدة التانية: «الطابور واقف» (٢٤ سبتمبر ٢٠٢٦) ────────────────────
   العمى اللي القاعدة الأولى مش شايفاه: هي بتقيس عند خطوة ٥ (العنوان)، لكن
   الشيك أوت بقى «الدخول الأول» من ١٩/٩ — خطوة ٤ (الدخول بالجوال/OTP) قبلها
   على الطريق. يعني لو تقنيات وقعت الساعة ٨، محدش هيقدر يعدّي الـOTP، محدش
   هيوصل خطوة ٥ أصلاً ⇒ ready = 0 ⇒ **الإنذار عمره ما هيرن**. نفس العمى
   لو الـbundle اتكسر أو /api/journey/batch وقعت أو CSP منعت السكريبت؛
   ومراقب التشغيل بيشوف ٢٠٠ من صفحة ميتة فمابيقولش حاجة.

   فالقاعدة التانية بتقيس أبكر، وبتسأل سؤال تاني خالص: **حد بيتحرك في
   الطابور أصلاً؟**
     في ساعات الشغل (ومفيش إيقاف خدمة)، جوّه نافذة أطول:
       • صفر جلسة وصلت خطوة ≥٤ (دخول/عنوان) **و** صفر طلب مدفوع، و
       • إما ≥ stallEntry جلسة وصلت السلة (خطوة ≥٢) — ناس بتحاول وواقفة،
       • أو ولا سلة واحدة مع ≥ stallLanded زائر — يبقى الصفحة نفسها ميتة.

   ليه نافذة أطول (١٢٠ د) والحد على السلة مش على الزوار؟ لإن الأرقام هنا
   نادرة بطبعها: الوسيط ٤ سلال و**١ دخول** بس في ٤٥ دقيقة، و«صفر دخول في
   ٤٥ دقيقة» حالة طبيعية في ٣٠٪ من النوافذ — أي إنذار مبني عليها بيرن كل
   يوم ويتجاهله الكل. الهبوط لوحده أسوأ: ٧٥ زائر مقابل ٤ سلال في ساعتين،
   فـ«زوار كتير وصفر دخول» بيحصل عادي.

   الـbacktest (١٩/٩ مسا → ٢٤/٩ — قبل كده الدخول-الأول مكانش موجود
   فالداتا مش قابلة للمقارنة؛ ١٣٠ نافذة كل نص ساعة، ساعات الشغل بس،
   والإيقاف مستبعد):
     • نافذة ١٢٠ د: **صفر** نافذة كانت هتحقّق القاعدة. وأقرب حالة كان
       فيها ٢ دخول (يعني كانت ناقصة اتنين عشان ترن).
     • نافذة ٩٠ د: برضه صفر، بس أقرب حالة كانت ١ دخول — هامش أضيق،
       فاخترنا ١٢٠.
     • نافذة ٦٠ د كانت هترن مرة (٢٢/٩ ٨ مسا، يوم العطل نفسه).
     • «ولا سلة واحدة مع ≥٦٠ زائر»: صفر نافذة في الاتنين.
   والقياس ده بيقرا الدخول من جلسات **بدأت** جوّه النافذة (اللي الـAPI
   بيسمح بقراءته)، والقاعدة نفسها بتعدّ بوقت الحدث — فالأرقام الحقيقية
   أكبر من الـbacktest، يعني القاعدة أهدى مما هو مكتوب هنا مش أعلى.

   التكلفة: الاكتشاف بياخد طول النافذة (١٢٠ دقيقة) — أبطأ بكتير من
   القاعدة الأولى، بس البديل الحالي هو «محدش يعرف خالص» (يوم ٢٢/٩ المالك
   نفسه اكتشفها بعد ساعتين و١٧ دقيقة). والحدود كلها في اللوحة
   (settings.checkoutWatch) فتقدر تضيّقها بعد ما تتفرّج على الأرقام في
   اللوج شهر.

   الحراسات: مقفول، أو خدمة موقوفة بإيد المدير (service.js) أو رجعت جوّه
   النافذة ⇒ سكوت تام. البوتات/الموظفين/الـQA مستبعدين زي القاعدة الأولى.
   نقطة عمياء معروفة ومقبولة: عميل قديم داخل بتوكنه مش محتاج OTP، فعطل
   رسايل يضرب العملاء الجداد بس مش هيوصل «صفر» — القاعدة دي للعطل الكامل.
═══════════════════════════════════════════════════════════════════════════ */
import { isOpenNow } from "./carts.js";
import { fitOneSms } from "./staffalerts.js";
import { bizDay } from "./bizday.js";
import { serviceState, serviceCfg } from "./service.js";

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
/* خطوة ٢ = «أضاف للسلة» — أول إشارة نيّة حقيقية (الهبوط لوحده إعلانات).
   خطوة ٤ = «سجّل دخوله بالجوال» — أول خطوة على طريق الشيك أوت من ١٩/٩. */
export const ENTRY_STEP = 2;
export const LOGIN_STEP = 4;

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
  /* قاعدة «الطابور واقف» — أرقامها من backtest تاني (شوف الرأس). */
  stallWindowMin: 120, // نافذتها أطول: «صفر دخول» في ٤٥ دقيقة حاجة عادية
  stallEntry: 8,       // كام واحد وصل السلة يخلّي «صفر دخول» غريب فعلاً
  stallLanded: 60,     // ولا سلة واحدة؟ كام زائر يخلّيها عطل مش هدوء
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
    stallWindowMin: Math.round(clampN(x.stallWindowMin, 30, 240, 120)),
    stallEntry: Math.round(clampN(x.stallEntry, 2, 100, 8)),
    stallLanded: Math.round(clampN(x.stallLanded, 10, 2000, 60)),
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

/* الخدمة موقوفة بإيدينا؟ (service.js) الإيقاف قرار مش عطل. وكمان: نافذة
   جوّاها دقايق إيقاف أرقامها مش قابلة للمقارنة، فلو الخدمة رجعت جوّه
   النافذة بنسكت لحد ما النافذة تنضف. `from` = بداية أطول نافذة بنقيسها. */
export function serviceQuiet(settings, from, now = new Date()) {
  const st = serviceState(settings, now);
  if (st.anyPaused) return true;
  const f = new Date(from).getTime();
  const cfg = serviceCfg(settings);
  /* إيقاف خلص لوحده (`until` عدّى) والتنضيف الكسول لسه ماحصلش — الدقايق
     دي جوّه نافذتنا برضه، فساكتين لحد ما تنضف. */
  for (const ch of ["delivery", "pickup"]) {
    const c = cfg[ch];
    if (c.paused && c.until && new Date(c.until).getTime() >= f) return true;
  }
  const back = cfg.resumedAt ? new Date(cfg.resumedAt).getTime() : NaN;
  return Number.isFinite(back) && back >= f;
}

/* القاعدة التانية: «الطابور واقف قبل الدخول» — شوف الرأس.
   شرط «ولا طلب مدفوع» مجاني تقريباً (الوسيط صفر) بس بيمنع أغبى إنذار
   ممكن: نقول «الشيك أوت واقف» والفلوس داخلة. */
export function stalled(m, cfg) {
  if (m.advanced !== 0 || m.paidLong !== 0) return false;
  if (m.entered >= cfg.stallEntry) return true;            // ناس في السلة ومحدش دخل
  return m.entered === 0 && m.landed >= cfg.stallLanded;   // ولا سلة واحدة = الصفحة ميتة
}

/**
 * @param {{ready:number, payPage:number, paid:number,
 *          landed?:number, entered?:number, advanced?:number, paidLong?:number}} m
 * @param {{state:string}} prev  الحالة السابقة (ok | alerting)
 * @param {{threshold:number, stallEntry:number, stallLanded:number}} cfg
 * @param {boolean} open  المطعم مفتوح؟
 * @param {boolean} quiet الخدمة موقوفة بإيدينا؟ (إيقاف مؤقت = مش عطل)
 * @returns {{bad:boolean, reason:"pay"|"stall"|null, action:"none"|"alert"|"recover"|"rearm", state:string}}
 */
export function decide(m, prev, cfg, open, quiet = false) {
  const state = (prev && prev.state) === "alerting" ? "alerting" : "ok";
  /* مقفول: نسلّح من غير أي رسالة. السكوت وإحنا قافلين مش عطل.
     ونفس الكلام للإيقاف المؤقت — المدير هو اللي وقّفها بإيده. */
  if (!open || quiet) return { bad: false, reason: null, action: state === "alerting" ? "rearm" : "none", state: "ok" };

  const badPay = m.ready >= cfg.threshold && m.paid === 0;
  const badStall = !badPay && stalled(m, cfg);
  const bad = badPay || badStall;
  const reason = badPay ? "pay" : (badStall ? "stall" : null);
  if (bad) return { bad, reason, action: state === "alerting" ? "none" : "alert", state: "alerting" };
  if (state !== "alerting") return { bad, reason, action: "none", state: "ok" };
  // كنا في إنذار وخرجنا منه: «رجع» بس لو فيه طلبات فعلاً نزلت.
  return { bad, reason, action: m.paid > 0 ? "recover" : "rearm", state: "ok" };
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

/* رسالة «الطابور واقف». بتقول الرقم اللي المدير يقدر يتصرّف بيه: كام واحد
   واقف، وإن مفيش ولا دخول واحد — وبتقوله يجرّب الدخول بنفسه، لإن ده بالظبط
   المكان اللي بيتكسر. حالة «ولا سلة واحدة» رسالتها مختلفة: الصفحة نفسها. */
export function stallText(m, cfg, lang = "ar") {
  const dead = m.entered === 0;
  if (lang === "ar") {
    return fitOneSms(dead
      ? `فريش كاتس عاجل: الموقع مايشتغلش - ${m.landed} زائر و0 سلة في ${cfg.stallWindowMin} دقيقة`
      : `فريش كاتس عاجل: الشيك أوت واقف - ${m.entered} سلة و0 دخول و0 طلب في ${cfg.stallWindowMin} دقيقة`);
  }
  return fitOneSms(dead
    ? `Fresh Cuts ALERT: site looks BROKEN. ${m.landed} visitors, 0 added to cart in last ${cfg.stallWindowMin}min. Open freshcuts.sa now.`
    : `Fresh Cuts ALERT: checkout STALLED. ${m.entered} carts but 0 logged in and 0 paid in last ${cfg.stallWindowMin}min. Try the phone login now.`);
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
  /* نافذة القاعدة التانية أطول، فهي اللي بتحدّد كام دقيقة لازمة تكون
     «نضيفة» من أي إيقاف خدمة. */
  const stallFrom = new Date(now.getTime() - cfg.stallWindowMin * 60e3);
  const quiet = serviceQuiet(settings, stallFrom, now);

  /* journey_events مالهاش index على `at` لوحده، فالاستعلام ده بيمشي على
     الجدول. عشان كده القاعدتين بيتقاسوا في **مرّة واحدة** على أوسع نافذة،
     وكل رقم بيتفلتر بوقته — مسحة واحدة كل ٥ دقايق زي الأول مش اتنين. */
  const scanFrom = new Date(Math.min(from.getTime(), stallFrom.getTime()));

  const [s, o, land] = await Promise.all([
    /* جلسات حقيقية وصلت خطوة ٥/٦ جوّه النافذة القصيرة (القاعدة الأولى)،
       وخطوة ٢/٤ جوّه النافذة الطويلة (القاعدة التانية) — كله بوقت الحدث
       نفسه، مش بـlast_seen_at بتاع الجلسة. */
    pool.query(
      `SELECT count(DISTINCT e.session_id) FILTER (WHERE e.step >= ${READY_STEP}    AND e.at >= $3)::int AS ready,
              count(DISTINCT e.session_id) FILTER (WHERE e.step >= ${PAY_PAGE_STEP} AND e.at >= $3)::int AS pay_page,
              count(DISTINCT e.session_id) FILTER (WHERE e.step >= ${ENTRY_STEP}    AND e.at >= $4)::int AS entered,
              count(DISTINCT e.session_id) FILTER (WHERE e.step >= ${LOGIN_STEP}    AND e.at >= $4)::int AS advanced
         FROM journey_events e
         JOIN journey_sessions s USING (session_id)
        WHERE e.step IS NOT NULL AND e.at >= $1 AND e.at < $2
          AND ${realSessionSql("s")}`, [scanFrom, now, from, stallFrom]),
    pool.query(
      `SELECT count(*) FILTER (WHERE created_at >= $4)::int AS paid,
              max(created_at)  FILTER (WHERE created_at >= $4) AS last_paid,
              count(*) FILTER (WHERE created_at >= $5)::int AS paid_long
         FROM shop_orders
        WHERE mf_payment_id IS NOT NULL AND COALESCE(is_test,false)=false
          AND ${PAID_SQL} AND total >= $3
          AND created_at >= $1 AND created_at < $2`, [scanFrom, now, cfg.minTotal, from, stallFrom]),
    /* الهبوط = جلسات حقيقية **بدأت** جوّه النافذة الطويلة (نفس التعريف
       اللي الـbacktest اتعمل بيه: journey_sessions.started_at). */
    pool.query(
      `SELECT count(*)::int AS landed FROM journey_sessions s
        WHERE s.started_at >= $1 AND s.started_at < $2 AND ${realSessionSql("s")}`, [stallFrom, now]),
  ]);

  const m = {
    ready: s.rows[0].ready, payPage: s.rows[0].pay_page,
    paid: o.rows[0].paid, lastPaid: o.rows[0].last_paid || null,
    landed: land.rows[0].landed, entered: s.rows[0].entered,
    advanced: s.rows[0].advanced, paidLong: o.rows[0].paid_long,
  };

  await pool.query(WATCH_DDL);
  const prev = (await pool.query(`SELECT * FROM checkout_watch WHERE id=1`)).rows[0] || { state: "ok" };
  const d = decide(m, prev, cfg, open, quiet);

  /* سقف يومي — لو حاجة اتكسرت في القاعدة نفسها، المدير ما يغرقش. اليوم
     التشغيلي (بيلف ٤ الفجر) عشان ليلة واحدة تتعدّ ليلة واحدة. */
  const day = bizDay(now);
  const usedToday = prev.alerts_day && String(prev.alerts_day).slice(0, 10) === day ? (prev.alerts_count || 0) : 0;
  const capped = d.action === "alert" && usedToday >= cfg.maxAlertsPerDay;
  const action = capped ? "capped" : d.action;

  const cfgLang = ((settings && settings.delivery) || {}).staffSmsLanguage === "ar" ? "ar" : "en";
  let sent = 0, text = null;
  if (action === "alert") {
    text = d.reason === "stall" ? stallText(m, cfg, cfgLang) : downText(m, cfg, cfgLang);
    if (!dryRun) sent = await staff.critical(() => text, d.reason === "stall" ? "checkout-stalled" : "checkout-down");
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
        JSON.stringify({ ...m, open, quiet, reason: d.reason, cfg, action, capped })]);
  }

  const line = `open=${open}${quiet ? " paused" : ""} ready=${m.ready} payPage=${m.payPage} paid=${m.paid}`
    + ` | ${cfg.stallWindowMin}m: landed=${m.landed} cart=${m.entered} login=${m.advanced} paid=${m.paidLong}`
    + ` -> ${action}${d.reason ? `(${d.reason})` : ""}${sent ? ` (sms:${sent})` : ""}`;
  log(`[checkout-watch] ${line}`);
  return { ...d, action, capped, metrics: m, cfg, open, quiet, sent, text, line };
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
