/* ═══════════════════════════════════════════════════════════════════════════
   «🎯 إيه اللي نعمله دلوقتي» — لقطة لحظية لمركز النمو (#store/grow/center)

   GET /api/cms/growth/now   (القسم «growth» عبر PATH_SECTIONS: /api/cms/growth)

   ليه ملف لوحده: الشاشة القديمة كانت بتحسب توصياتها من أرقام ٣٠ يوم، فكانت
   بتقول نفس الكلام كل يوم ومش بتشوف اللي بيحصل النهارده. هنا كل رقم لحظي
   ومن مصدر موجود أصلاً — مفيش حساب جديد لحاجة محسوبة في مكان تاني:
     • يوم الشغل: offers.riyadhDay (تدوير ٤ الفجر زي تاب سينس).
     • طلبات الموقع: shop_orders بحالات adsplan.PAID_STATUSES، من غير is_test
       ولا كوبون OMAR-9X4T (نفس قاعدة التقرير اليومي).
     • الصالة+التطبيقات: ts_orders بنفس تقسيمة adsreport.posPart (طلب QR/External
       اللي مش تطبيق = الموقع نفسه في نقطة البيع، فمش بيتعدّ مرتين).
     • صرف ميتا: آخر دورة للحارس (ads_guard_state k='guard' → lastRun.acctToday).
       الحساب على توقيت لوس أنجلوس (يومه = ١٠ الصبح ← ١٠ الصبح الرياض)، فمن ٤
       لـ١٠ الصبح الرقم ده بتاع يوم الشغل اللي فات — بنعتبر النهارده صفر.
     • السلات: shop_carts آخر ٢٤ ساعة + cart_recovery.
     • SMS: settings.cms.campaigns.brake + cms_campaigns (scheduled/held).
     • «خلص»: settings.catalog.soldOut (soldout.js).
     • الموافقات: approvals (مراجعة التسويق) + ap_decisions proposed (الطيار).
     • الطابور: content_posts origin='queue'.
   الإجراءات قواعد عتبة صريحة (buildActions) — لو مفيش حاجة غلط بنقول كده
   بدل ما نخترع شغل. متجرّبة أوفلاين في growthnow.test.mjs.
═══════════════════════════════════════════════════════════════════════════ */
import { OFFERS, offerState, riyadhDay as bizDayOf } from "./offers.js";
import { PAID_STATUSES, EXCLUDED_COUPONS } from "./adsplan.js";
import { soldOutOf } from "./soldout.js";
import { cartCfg } from "./carts.js";

export const ADS_DAILY_CAP = 3000;        // سقف الحارس اليومي (قرار عمر ١٧/٩)
export const SPEND_SHARE_MAX = 0.30;      // الصرف ≈ ٢٥–٣٠٪ من الدخل (قرار عمر)
const GUARD_STALE_MIN = 20;               // الحارس بيشتغل كل ٥ دقايق
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const H3 = 3 * 3600_000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const hhmm = (s) => { const [h, m] = String(s || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

/* الساعة المحلية في الرياض */
export function riyadhClock(now = new Date()) {
  const l = new Date(now.getTime() + H3);
  return { bizDay: bizDayOf(now), hour: l.getUTCHours(), minute: l.getUTCMinutes(), dow: l.getUTCDay() };
}

const DEFAULT_HOURS = { enabled: true, days: Object.fromEntries(DAYS.map((d) => [d, { open: "12:00", close: d === "thu" || d === "fri" ? "03:00" : "02:00" }])) };

/* مفتوح دلوقتي؟ + بقالنا فاتحين كام دقيقة في وردية النهارده (لحساب «نفس الساعة»).
   الوردية اللي بتعدّي نص الليل بتتحسب من يوم فتحها. */
export function shiftState(hours, now = new Date()) {
  const h = hours && hours.enabled !== false && hours.days ? hours : DEFAULT_HOURS;
  const l = new Date(now.getTime() + H3);
  const min = l.getUTCHours() * 60 + l.getUTCMinutes();
  const dow = l.getUTCDay();
  const win = (d) => {
    const x = h.days[DAYS[d]];
    if (!x || x.closed || !x.open) return null;
    const o = hhmm(x.open); let c = hhmm(x.close || "02:00");
    if (c <= o) c += 1440;
    return [o, c];
  };
  const t = win(dow);
  if (t && min >= t[0] && min < t[1]) return { open: true, minutesOpen: min - t[0], closesAt: t[1] % 1440 };
  const y = win((dow + 6) % 7);
  if (y && min + 1440 >= y[0] && min + 1440 < y[1]) return { open: true, minutesOpen: min + 1440 - y[0], closesAt: y[1] % 1440 };
  return { open: false, minutesOpen: null, opensAt: t ? t[0] : null };
}

/* صرف ميتا النهارده من آخر دورة للحارس. */
export function metaSpendToday(guard, now = new Date()) {
  const lr = guard && guard.lastRun;
  if (!lr || !lr.at) return { spend: null, at: null, ageMin: null, stale: true, isOpen: null, capped: false };
  const at = new Date(lr.at);
  const ageMin = Math.round((now.getTime() - at.getTime()) / 60000);
  const sameDay = bizDayOf(at) === bizDayOf(now);
  const atHour = new Date(at.getTime() + H3).getUTCHours();
  // ٤→١٠ الصبح: يوم لوس أنجلوس لسه يوم الشغل اللي فات
  const spend = !sameDay ? null : atHour >= 4 && atHour < 10 ? 0 : r2(lr.acctToday);
  return { spend, at: at.toISOString(), ageMin, stale: ageMin > GUARD_STALE_MIN, isOpen: lr.isOpen ?? null, capped: !!lr.capped };
}

const LV = { bad: 0, warn: 1, info: 2 };
const ar = (n) => Math.round(num(n)).toLocaleString("ar-SA");
const sarT = (n) => `${ar(n)} ر.س`;

/* القواعد. كل إجراء: level + t (اللي بيحصل بالرقم) + a (المطلوب) + go [مجموعة، شاشة]. */
export function buildActions(s) {
  const out = [];
  const add = (level, t, a, go, key) => out.push({ level, t, a, go, key });
  const { clock = {}, shift = {}, online = {}, ads = {}, carts = {}, sms = {}, soldOut = [], approvals = {}, content = {}, offers = [], revenue = {} } = s;

  // ── الإعلانات
  if (ads.guard?.stale && shift.open) {
    add("bad", `حارس الإعلانات آخر مرة اشتغل من ${ar(ads.guard.ageMin ?? 0)} دقيقة (المفروض كل ٥).`,
      "من غيره الإعلانات مش بتقف برّه ساعات الفتح ولا عند سقف الـ٣٬٠٠٠ — لازم حد يشيّك على كرون السيرفر.", ["overview", "daily"], "guard_stale");
  }
  if (num(ads.spend) >= 0.9 * ADS_DAILY_CAP) {
    add("bad", `صرف ميتا النهارده ${sarT(ads.spend)} — قرّب من السقف ${sarT(ADS_DAILY_CAP)}.`,
      "راجع الحملات فوراً؛ الحارس هيقفل عند السقف، بس الوصول له معناه إن فيه مجموعة بتحرق.", ["grow", "ads"], "cap");
  }
  const late = clock.hour >= 22 || clock.hour < 4;
  if (late && num(ads.spend) >= 150 && num(revenue.total) > 0 && ads.spend / revenue.total > SPEND_SHARE_MAX) {
    add("warn", `الصرف النهارده ${sarT(ads.spend)} = ${ar((ads.spend / revenue.total) * 100)}٪ من دخل اليوم (${sarT(revenue.total)}).`,
      "قاعدة عمر ٢٥–٣٠٪. لو التقرير اليومي الصبح طلع نفس النسبة، الحارس هيقترح تقليل — مازوّدش ميزانية النهارده.", ["overview", "daily"], "share_live");
  }
  const rep = ads.lastReport;
  if (rep && rep.rec?.code === "CUT") {
    add("warn", `تقرير ${rep.day}: ${rep.rec.ar}.`, "افتح الدخل اليومي وشوف أنهي حملة تكلفة طلبها عالية قبل ما الحارس يقلّل.", ["overview", "daily"], "report_cut");
  }

  // ── المتجر
  if (shift.open && num(shift.minutesOpen) >= 180 && num(online.today) === 0) {
    add("bad", `مفيش ولا طلب مدفوع من الموقع من ساعة الفتح (${ar(shift.minutesOpen / 60)} ساعة).`,
      "افحص المتجر (الدفع/الـOTP/المنيو) — غالباً فيه حاجة واقفة مش قلة زيارات.", ["menu", "health"], "no_orders");
  } else if (shift.open && num(online.ySame) >= 3 && num(online.today) < num(online.ySame) * 0.5) {
    add("warn", `طلبات الموقع لحد دلوقتي ${ar(online.today)} مقابل ${ar(online.ySame)} امبارح في نفس الساعة.`,
      "شوف رحلة العميل النهارده: الزيارات قلّت ولا الناس بتقع في خطوة معيّنة؟", ["grow", "journey"], "slow_day");
  }

  // ── الرسايل
  if (sms.brake) {
    add("bad", `فرامل الـSMS شغّالة من ${sms.brake.at ? String(sms.brake.at).slice(0, 16).replace("T", " ") : "—"} — كل الموجات المجدولة واقفة.`,
      "راجع الإلغاءات في «مش عايز رسايل» وبعدين فكّ الفرامل من الحملات لو السبب اتفهم.", ["grow", "campaigns"], "brake");
  }
  if ((sms.held || []).length) {
    add("warn", `${ar(sms.held.length)} حملة SMS متوقفة («held»): ${sms.held.map((h) => h.name).slice(0, 2).join(" · ")}.`,
      "الحملة بتقف لما الجمهور يكبر أكتر من ٢٠٪ قبل الإرسال أو الفرامل تشتغل — أكّد العدد وأعد الجدولة أو الغيها.", ["grow", "campaigns"], "held");
  }

  // ── السلات
  if (num(carts.open) >= 10 && num(carts.reachable) / Math.max(1, num(carts.open)) < 0.1) {
    add("warn", `${ar(carts.open)} سلة اتسابت آخر ٢٤ ساعة بقيمة ${sarT(carts.openValue)} — ${ar(carts.reachable)} بس ليهم جوال نقدر نرجّعهم بيه.`,
      "الجوال بيتسجّل عند الـOTP في آخر الشيك أوت، فأغلب اللي بيسيبوا بدري مالهمش رقم — الحل إعلان ريتارجت (FC-RT-WEB-96) مش SMS.", ["grow", "carts"], "carts_unreachable");
  }
  if (carts.enabled && !carts.smsEnabled && num(carts.reachable) > 0) {
    add("warn", `${ar(carts.reachable)} سلة ليها جوال ورسايل الاسترداد SMS مقفولة.`, "شغّلها من إعدادات السلات (بتحترم ساعات الهدوء وفاصل ٧ أيام).", ["grow", "carts"], "carts_sms_off");
  }

  // ── التشغيل
  const oldSold = soldOut.filter((x) => !x.until && num(x.hoursAgo) >= 12);
  if (oldSold.length) {
    add("warn", `${oldSold.map((x) => x.name || `#${x.id}`).slice(0, 3).join("، ")} مقفول «خلص» من ${ar(oldSold[0].hoursAgo)} ساعة ومن غير ميعاد رجوع.`,
      "لو الصنف رجع، المدير يفتحه من البورتال (تبويب الأصناف) — وإلا العميل بيشوفه «خلص» طول اليوم.", ["ops", "portal"], "soldout_old");
  }

  // ── العروض
  for (const o of offers) {
    if (o.status === "live" && o.daysLeft != null && o.daysLeft <= 3) {
      add("warn", `«${o.title}» آخره ${o.until} (فاضل ${ar(o.daysLeft)} يوم)${o.provisional ? " — والتاريخ لسه مؤقت" : ""}.`,
        "قرّر: تمديد ولا العرض الجاي؟ لازم الكرياتيف والرسايل تتغيّر قبل آخر يوم.", ["menu", "offers"], `offer_${o.id}`);
    }
  }

  // ── المحتوى
  if (content.failed > 0) {
    add("warn", `${ar(content.failed)} بوست فشل في طابور النشر.`, "افتح الطابور وشوف الخطأ — البوست الفاشل مابيتعادش لوحده بعد آخر محاولة.", ["grow", "queue"], "queue_failed");
  }
  if (content.next24 === 0) {
    add("warn", "مفيش ولا بوست مجدول في الـ٢٤ ساعة الجاية.", "حط بوست/ستوري واحد على الأقل — العرض شغّال والإعلانات بتودّي الناس على الصفحة.", ["grow", "queue"], "queue_empty");
  }

  // ── موافقات
  if (num(approvals.hub) > 0) {
    add("info", `${ar(approvals.hub)} طلب موافقة مستني قرارك في مراجعة التسويق.`, "قرار سريع بيفك شغل الفريق.", ["grow", "hub"], "approvals");
  }
  if (num(approvals.autopilot) > 0) {
    add("info", `${ar(approvals.autopilot)} اقتراح من الطيار الآلي مستني موافقة.`, "الطيار في وضع «اقتراح» — مابينفّذش حاجة من غيرك.", ["grow", "ads"], "autopilot");
  }

  out.sort((a, b) => LV[a.level] - LV[b.level]);
  const actions = out.slice(0, 5);
  return { actions, more: Math.max(0, out.length - actions.length), allGood: !out.some((x) => x.level !== "info") };
}

/* ═══ الداتا ═══════════════════════════════════════════════════════════════ */
const BIZ_SQL = `((o.created_at AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date`;

export async function snapshot({ pool, getSettingsData, DEFAULT_DELIVERY_APPS = [] }, now = new Date()) {
  const settings = (await getSettingsData()) || {};
  const clock = riyadhClock(now);
  const shift = shiftState(settings.hours, now);
  const today = clock.bizDay;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const apps = (Array.isArray(settings.deliveryAppMethods) && settings.deliveryAppMethods.length ? settings.deliveryAppMethods : DEFAULT_DELIVERY_APPS)
    .map((x) => String(x).toLowerCase());
  const safe = (p, fb) => p.then((r) => r).catch((e) => { console.error("[growthnow]", e.message); return fb; });

  const [onl, pos, guardRow, repRow, cart24, rec, camps, appr, apProp, queue] = await Promise.all([
    safe(pool.query(
      `SELECT count(*) FILTER (WHERE ${BIZ_SQL} = $1::date)::int AS today,
              COALESCE(sum(total) FILTER (WHERE ${BIZ_SQL} = $1::date),0)::float AS today_rev,
              count(*) FILTER (WHERE ${BIZ_SQL} = $2::date AND o.created_at <= NOW() - interval '24 hours')::int AS y_same,
              count(*) FILTER (WHERE ${BIZ_SQL} = $2::date)::int AS y_total,
              count(*) FILTER (WHERE ${BIZ_SQL} = $1::date AND o.option = 'pickup')::int AS today_pickup
         FROM shop_orders o
        WHERE o.created_at > NOW() - interval '3 days'
          AND o.status = ANY($3::text[]) AND NOT COALESCE(o.is_test,false)
          AND upper(COALESCE(o.coupon,'')) <> ALL($4::text[])`,
      [today, yesterday, PAID_STATUSES, EXCLUDED_COUPONS]), { rows: [{}] }),
    safe(pool.query(
      `SELECT COALESCE(sum(total) FILTER (WHERE NOT (ext OR qr) OR app_pay),0)::float AS rev,
              count(*) FILTER (WHERE NOT (ext OR qr) OR app_pay)::int AS n
         FROM (SELECT o.total, (o.order_type ILIKE '%external%') AS ext, (o.order_type ILIKE '%qr-menu%') AS qr,
                      (EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(o.payments,'{}'::jsonb)) k WHERE lower(k) = ANY($2::text[]))
                        OR s.source = 'delivery_app') AS app_pay
                 FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id
                WHERE o.calendar_day = $1::date
                  AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))) x`,
      [today, apps]), { rows: [{}] }),
    safe(pool.query(`SELECT v FROM ads_guard_state WHERE k='guard'`), { rows: [] }),
    safe(pool.query(`SELECT day, data FROM mk_daily_reports ORDER BY day DESC LIMIT 1`), { rows: [] }),
    safe(pool.query(
      `SELECT count(*)::int AS carts,
              count(*) FILTER (WHERE recovered_order IS NULL AND item_count > 0)::int AS open,
              -- subtotal < 5000: فيه سلات بقيم مضروبة ×١٠٠٠ من العميل (٩٦٠٠٠ لسلة ٩٦) — مانخليهاش تبوّظ المجموع
              COALESCE(sum(subtotal) FILTER (WHERE recovered_order IS NULL AND item_count > 0 AND subtotal < 5000),0)::float AS open_value,
              count(*) FILTER (WHERE recovered_order IS NULL AND item_count > 0 AND phone_norm IS NOT NULL)::int AS reachable,
              count(*) FILTER (WHERE recovered_order IS NOT NULL)::int AS ordered
         FROM shop_carts WHERE updated_at > NOW() - interval '24 hours'`), { rows: [{}] }),
    safe(pool.query(
      `SELECT count(*) FILTER (WHERE started_at > NOW() - interval '24 hours')::int AS started24,
              count(*) FILTER (WHERE step1_at > NOW() - interval '24 hours')::int AS sent24,
              count(*) FILTER (WHERE started_at > NOW() - interval '7 days' AND order_no IS NOT NULL)::int AS recovered7,
              count(*) FILTER (WHERE started_at > NOW() - interval '7 days')::int AS flows7
         FROM cart_recovery`), { rows: [{}] }),
    safe(pool.query(
      `SELECT id, name, status, scheduled_at FROM cms_campaigns
        WHERE status IN ('scheduled','held') ORDER BY scheduled_at NULLS LAST LIMIT 20`), { rows: [] }),
    safe(pool.query(`SELECT count(*)::int AS n FROM approvals WHERE status='pending'`), { rows: [{ n: 0 }] }),
    safe(pool.query(`SELECT count(*)::int AS n FROM ap_decisions WHERE status='proposed'`), { rows: [{ n: 0 }] }),
    safe(pool.query(
      `SELECT count(*) FILTER (WHERE status='scheduled' AND scheduled_at BETWEEN NOW() AND NOW() + interval '24 hours')::int AS next24,
              count(*) FILTER (WHERE status='failed')::int AS failed,
              min(scheduled_at) FILTER (WHERE status='scheduled' AND scheduled_at > NOW()) AS next_at
         FROM content_posts WHERE origin='queue'`), { rows: [{}] }),
  ]);

  const o = onl.rows[0] || {};
  const posRev = num(pos.rows[0]?.rev);
  const onlineRev = r2(o.today_rev);
  const revenue = { pos: r2(posRev), online: onlineRev, total: r2(posRev + onlineRev), posOrders: num(pos.rows[0]?.n) };
  const guard = metaSpendToday(guardRow.rows[0]?.v, now);
  const rr = repRow.rows[0];
  const rd = rr?.data || null;
  const lastReport = rd ? {
    day: rd.day || (rr.day instanceof Date ? rr.day.toISOString().slice(0, 10) : String(rr.day)),
    revenue: num(rd.revenue?.total), onlineOrders: num(rd.online?.orders), onlineRevenue: num(rd.online?.revenue),
    spend: num(rd.ads?.spendTotal), share: rd.ads?.spendShareOfRevenue ?? null,
    cpaOnline: rd.ads?.cpaOnline ?? null, roasOnline: rd.ads?.roasOnline ?? null,
    ordersFromAds: num(rd.ads?.ordersFromAds), rec: rd.recommendation || null,
  } : null;
  const cfg = cartCfg(settings);
  const c24 = cart24.rows[0] || {};
  const r7 = rec.rows[0] || {};
  const brake = settings?.cms?.campaigns?.brake || null;
  const campRows = camps.rows || [];
  const nextWave = campRows.find((x) => x.status === "scheduled" && x.scheduled_at && new Date(x.scheduled_at) > now) || null;
  const nowMs = now.getTime();
  const sold = Object.entries(soldOutOf(settings, nowMs)).map(([id, e]) => ({
    id, name: e.name, by: e.by, until: e.until, at: e.at,
    hoursAgo: e.at ? Math.round((nowMs - Date.parse(e.at)) / 3600_000) : null,
  }));
  const offers = OFFERS.map((x) => {
    const st = offerState(x, now);
    return { id: x.id, title: x.title, from: x.from || null, until: x.until || null, provisional: !!x.untilProvisional, status: st.status, daysLeft: st.daysLeft, price: x.price ?? null };
  }).filter((x) => x.status === "live" || x.status === "upcoming");
  const q = queue.rows[0] || {};
  const target = Number(settings?.cms?.dailyTarget) || 200;

  const s = {
    now: now.toISOString(), clock, shift,
    target: { daily: target, pct: target ? num(o.today) / target : null },
    online: { today: num(o.today), revenue: onlineRev, pickup: num(o.today_pickup), ySame: num(o.y_same), yTotal: num(o.y_total) },
    revenue,
    ads: {
      spend: guard.spend, cap: ADS_DAILY_CAP, shareMax: SPEND_SHARE_MAX,
      share: guard.spend != null && revenue.total > 0 ? r2(guard.spend / revenue.total) : null,
      guard, lastReport,
    },
    carts: {
      enabled: cfg.enabled, smsEnabled: cfg.smsEnabled,
      carts: num(c24.carts), open: num(c24.open), openValue: r2(c24.open_value), reachable: num(c24.reachable), ordered: num(c24.ordered),
      flowsStarted24: num(r7.started24), sent24: num(r7.sent24), recovered7: num(r7.recovered7), flows7: num(r7.flows7),
    },
    sms: {
      brake, held: campRows.filter((x) => x.status === "held").map((x) => ({ id: x.id, name: x.name })),
      nextWave: nextWave ? { id: nextWave.id, name: nextWave.name, at: new Date(nextWave.scheduled_at).toISOString() } : null,
      smsEnabled: settings?.cms?.campaigns?.smsEnabled === true,
    },
    soldOut: sold,
    approvals: { hub: num(appr.rows[0]?.n), autopilot: num(apProp.rows[0]?.n) },
    content: { next24: q.next24 == null ? null : num(q.next24), failed: num(q.failed), nextAt: q.next_at ? new Date(q.next_at).toISOString() : null },
    offers,
  };
  return { ...s, ...buildActions(s) };
}

/* ٦٠ ثانية كاش — الشاشة بتتفتح كتير والأرقام بتتحرك بالدقايق مش بالثواني.
   «الجاهزية» (readiness.js) بتقرا من نفس الكاش عشان علامات «✓ تلقائي». */
let _cache = null;
export async function cachedSnapshot(ctx, { fresh = false } = {}) {
  if (fresh || !_cache || Date.now() - _cache.at > 60_000) {
    _cache = { at: Date.now(), data: await snapshot(ctx) };
  }
  return _cache.data;
}

export function register(app, ctx) {
  const { requireAdmin } = ctx;
  app.get("/api/cms/growth/now", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const data = await cachedSnapshot(ctx, { fresh: c.req.query("fresh") === "1" });
      return c.json({ ok: true, ...data });
    } catch (e) {
      console.error("[growthnow] failed:", e.message);
      // ٢٠٠ مع ok:false — كلاودفلير بيبلع أي 5xx
      return c.json({ ok: false, error: e.message });
    }
  });
  console.log("[growthnow] routes ready");
}
