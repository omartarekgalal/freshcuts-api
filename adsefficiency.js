/* ═══════════════════════════════════════════════════════════════════════════
   ⚖️ كفاءة الإعلان — «عايز الإعلانات تفضل أقل من ١٥٪ من الدخل» (عمر، ٢١/٩/٢٠٢٦)

   عمر عايز يفضل شغّال طول اليوم بشكل سهل: يصرف ١٥٠٠ ويبيع ١٠ آلاف. الشاشة دي
   هي «العدّاد» اللي بيقوله دلوقتي إحنا فين من النسبة دي — مش تقرير آخر اليوم.

   بترجّع لليوم التشغيلي (٤ الفجر ← ٤ الفجر بتوقيت الرياض) وحيّة دلوقتي:
     • الصرف: إجمالي + لكل منصة + لكل حملة (من ad_spend_hourly، متظبّط على
       اليوم التشغيلي — مش يوم ميتا اللي على توقيت لوس أنجلوس)
     • الدخل: إجمالي + صالة/تطبيقات توصيل/متجر (POS + shop_orders)
     • الطلبات: كلها / المتجر / اللي جاية من إعلان (نفس قاعدة adsreport.js)
     • تكلفة الطلب (CPO/CPA) ونسبة الإعلان من الدخل والعائد (ROAS)
     • الإيقاع: مقارنة بالهدف (١٥٪ افتراضياً) — إنت مصروف كام وكان المفروض كام
     • ساعة بساعة: صرف × دخل × نسبة
     • قرارات الحارس النهارده (ads_guard_log) وحالته (ads_guard_state)

   الطريقة في حساب «الإيقاع»: الدخل مابيجيش بالتساوي على اليوم — الليل أكبر من
   الظهر. فبنبني منحنى توزيع الدخل بالساعة من آخر ١٤ يوم تشغيلي فعلي، وبنقارن
   الصرف الحالي بـ(الدخل المتوقع لآخر اليوم × الهدف × نسبة اليوم اللي عدّت).
   من غير المنحنى ده أي مقارنة الساعة ٤ العصر هتقول «إنت بره الهدف» غلط.

   Routes (admin):
     GET /api/marketing/ad-efficiency?day=YYYY-MM-DD&target=0.15
     GET /api/marketing/ad-efficiency/history?days=14

   مصادر الأرقام (مفيش نسخة تانية من أي قاعدة):
     - الصرف: ad_spend_hourly (adspend.js بيملاه كل ٣٠ دقيقة)
     - الدخل من نقطة البيع: ts_orders (نفس فلتر void/refund بتاع adsreport.js)
     - المتجر: shop_orders (is_test + كوبون الاختبار مستبعدين)
     - «الطلب ده من إعلان؟»: adSourceOf من adsreport.js نفسها
═══════════════════════════════════════════════════════════════════════════ */

import { adSourceOf } from "./adsreport.js";
import { bizDay, bizStart, bizEnd, shiftDay, DAY_RE } from "./bizday.js";

const TZ = "Asia/Riyadh";
const NOT_PAID = ["pending_payment", "expired", "rejected_refunded", "refunded", "refund_failed", "cancelled", "canceled", "payment_failed", "failed", "unpaid"];
const TEST_COUPONS = ["OMAR-9X4T"];
const DEFAULT_TARGET = 0.15;          // قرار عمر: الإعلان ≤ ١٥٪ من الدخل
const CURVE_DAYS = 14;                // كام يوم بنبني منهم منحنى الدخل بالساعة
const CACHE_MS = 60_000;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const r4 = (v) => Math.round(num(v) * 10000) / 10000;

/* ساعات اليوم التشغيلي بالترتيب: ٤ الصبح ← ٣ الفجر اللي بعده (٢٤ خانة) */
export const BIZ_HOURS = Array.from({ length: 24 }, (_, i) => (i + 4) % 24);

/* منحنى افتراضي لو مفيش تاريخ كفاية: المطعم بيفتح ١٢، الذروة ١٨→٠١.
   الأرقام دي أوزان نسبية — بتتقسّم على مجموعها، فمش لازم تجمع ١. */
export const FALLBACK_CURVE = (() => {
  const w = { 12: 3, 13: 6, 14: 5, 15: 3, 16: 4, 17: 6, 18: 9, 19: 9, 20: 11, 21: 11, 22: 10, 23: 9, 0: 7, 1: 5, 2: 2 };
  return BIZ_HOURS.map((h) => w[h] || 0);
})();

/* نسبة الدخل اللي المفروض تكون دخلت لحد الساعة دي (تراكمي، ٠→١).
   curve = مصفوفة بترتيب BIZ_HOURS. bizHourIdx = كام ساعة عدّت من ٤ الصبح. */
export function elapsedShare(curve, bizHourIdx, minuteInHour = 0) {
  const c = Array.isArray(curve) && curve.length === 24 && curve.some((x) => x > 0) ? curve : FALLBACK_CURVE;
  const tot = c.reduce((s, x) => s + num(x), 0) || 1;
  let acc = 0;
  for (let i = 0; i < 24; i++) {
    if (i < bizHourIdx) acc += num(c[i]);
    else if (i === bizHourIdx) acc += num(c[i]) * Math.min(1, Math.max(0, minuteInHour / 60));
  }
  return Math.min(1, acc / tot);
}

/* القرار: إحنا في الهدف ولا بره؟ — منطق واحد بيستخدمه الـAPI والشاشة والحارس.
   بنقارن الصرف الحالي بـ«المسموح دلوقتي» = الدخل المتوقع آخر اليوم × الهدف ×
   نسبة اليوم اللي عدّت. بنسيب هامش ±١٥٪ عشان مانرقصش على كل ريال. */
export function paceVerdict({ spend, revenue, target = DEFAULT_TARGET, share, band = 0.15 }) {
  const sh = Math.min(1, Math.max(0.01, num(share)));
  const projectedRevenue = revenue > 0 ? r2(revenue / sh) : 0;
  const allowedNow = r2(projectedRevenue * target * sh);   // = revenue * target
  const ratio = revenue > 0 ? r4(spend / revenue) : null;
  const projectedSpend = r2(spend / sh);
  const projectedRatio = projectedRevenue > 0 ? r4(projectedSpend / projectedRevenue) : null;
  let status = "ok", why = "";
  if (!revenue) { status = spend > 0 ? "no_revenue" : "idle"; why = spend > 0 ? "صرفنا ولسه مفيش دخل مسجّل" : "اليوم لسه مابدأش"; }
  else if (ratio > target * (1 + band)) { status = "over"; why = `النسبة ${Math.round(ratio * 100)}٪ فوق الهدف ${Math.round(target * 100)}٪`; }
  else if (ratio < target * (1 - band)) { status = "under"; why = `النسبة ${Math.round(ratio * 100)}٪ تحت الهدف — فيه مساحة نصرف`; }
  else { why = `النسبة ${Math.round(ratio * 100)}٪ في نطاق الهدف`; }
  return {
    target, elapsedShare: r4(sh), ratio, status, why,
    allowedSpendNow: allowedNow,
    headroom: r2(allowedNow - spend),
    projected: { revenue: projectedRevenue, spend: projectedSpend, ratio: projectedRatio },
    // «عشان النسبة تطلع صح آخر اليوم لازم الدخل يوصل لكام» — الرقم اللي عمر بيسأل عليه
    revenueNeededForTarget: target > 0 ? r2(projectedSpend / target) : null,
  };
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, DEFAULT_DELIVERY_APPS } = ctx;
  /* طلب تطبيق توصيل؟ نفس قاعدة adsreport.js: محفظة تطبيق في الدفع
     أو تاج order_sources.source = delivery_app. الـPOS بيسجّلهم Dine-in فالـorder_option
     مابينفعش دليل. واللي مش تطبيق وExternal/QR = انعكاس طلب متجر — بيتشال. */
  const appsList = async () => {
    try {
      const s = await getSettingsData();
      const list = Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length ? s.deliveryAppMethods : (DEFAULT_DELIVERY_APPS || []);
      return list.map((x) => String(x).toLowerCase());
    } catch { return (DEFAULT_DELIVERY_APPS || []).map((x) => String(x).toLowerCase()); }
  };
  const APP_PAY = `EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(o.payments,'{}'::jsonb)) k WHERE lower(k) = ANY($3::text[]))`;
  const APP_SRC = `EXISTS (SELECT 1 FROM order_sources x WHERE x.order_id = o.order_id AND x.source = 'delivery_app')`;
  const POS_LIVE = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;
  const cache = new Map();
  const cached = async (key, fn, ms = CACHE_MS) => {
    const h = cache.get(key);
    if (h && Date.now() - h.at < ms) return h.val;
    const val = await fn();
    cache.set(key, { at: Date.now(), val });
    if (cache.size > 40) cache.clear();
    return val;
  };
  const q = async (sql, args) => { try { return (await pool.query(sql, args)).rows; } catch (e) { console.error("[adsefficiency]", e.message); return []; } };

  async function target() {
    try {
      const s = (await getSettingsData()) || {};
      const t = Number(s.adsTargetShare);
      return Number.isFinite(t) && t > 0.02 && t < 0.8 ? t : DEFAULT_TARGET;
    } catch { return DEFAULT_TARGET; }
  }

  /* الصرف ساعة بساعة داخل اليوم التشغيلي (من ad_spend_hourly). */
  async function spendPart(day) {
    const rows = await q(`
      SELECT platform, campaign_id, campaign_name, kind,
             (extract(hour from (hour_start AT TIME ZONE '${TZ}'))::int) AS h,
             sum(spend) AS spend, sum(impressions) AS imp, sum(clicks) AS clk
        FROM ad_spend_hourly
       WHERE hour_start >= $1 AND hour_start < $2
       GROUP BY 1,2,3,4,5`, [bizStart(day).toISOString(), bizEnd(day).toISOString()]);
    const byPlatform = {}, byCampaign = new Map(), byHour = {};
    let total = 0, whatsapp = 0;
    for (const r of rows) {
      const s = num(r.spend);
      total += s;
      byPlatform[r.platform] = r2(num(byPlatform[r.platform]) + s);
      if (r.kind === "whatsapp") whatsapp += s;
      const k = `${r.platform}|${r.campaign_id}`;
      const c = byCampaign.get(k) || { platform: r.platform, id: r.campaign_id, name: r.campaign_name, kind: r.kind, spend: 0, impressions: 0, clicks: 0 };
      c.spend += s; c.impressions += num(r.imp); c.clicks += num(r.clk);
      byCampaign.set(k, c);
      byHour[r.h] = r2(num(byHour[r.h]) + s);
    }
    return {
      total: r2(total), whatsapp: r2(whatsapp), byPlatform, byHour,
      byCampaign: [...byCampaign.values()].map((c) => ({ ...c, spend: r2(c.spend), cpc: c.clicks ? r2(c.spend / c.clicks) : null })).sort((a, b) => b.spend - a.spend),
    };
  }

  /* الدخل ساعة بساعة: نقطة البيع (صالة + تطبيقات) + المتجر.
     طلبات المتجر بتنزل POS كـExternal من غير محفظة تطبيق — بنستبعدها من ناحية
     الـPOS عشان مانعدّهاش مرتين (نفس قاعدة adsreport.js). */
  async function revenuePart(day) {
    const apps = await appsList();
    const [pos, shop] = await Promise.all([
      q(`
        SELECT (extract(hour from (o.order_date AT TIME ZONE '${TZ}'))::int) AS h,
               (o.order_type ILIKE '%external%' OR o.order_type ILIKE '%qr-menu%') AS mirror,
               (${APP_PAY} OR ${APP_SRC}) AS app_src,
               count(*)::int AS n, COALESCE(sum(o.total),0) AS rev
          FROM ts_orders o
         WHERE o.order_date >= $1 AND o.order_date < $2 AND ${POS_LIVE}
         GROUP BY 1,2,3`, [bizStart(day).toISOString(), bizEnd(day).toISOString(), apps]),
      q(`
        SELECT order_no, total, option, coupon, is_test, attribution, attrib_source, created_at,
               (extract(hour from (created_at AT TIME ZONE '${TZ}'))::int) AS h
          FROM shop_orders
         WHERE created_at >= $1 AND created_at < $2 AND status <> ALL($3::text[])`,
        [bizStart(day).toISOString(), bizEnd(day).toISOString(), NOT_PAID]),
    ]);

    const byHour = {};
    const bump = (h, key, n, rev) => {
      const b = (byHour[h] ||= { revenue: 0, orders: 0, hall: 0, apps: 0, online: 0, adsOrders: 0, adsRevenue: 0 });
      b[key] = r2(b[key] + rev); b.revenue = r2(b.revenue + rev); b.orders += n;
    };
    const tot = { hall: { orders: 0, revenue: 0 }, apps: { orders: 0, revenue: 0 }, online: { orders: 0, revenue: 0 }, mirrors: 0 };
    for (const r of pos) {
      if (r.mirror && !r.app_src) { tot.mirrors += r.n; continue; }   // انعكاس طلب المتجر — بييجي من shop_orders
      const t = r.app_src ? tot.apps : tot.hall;
      t.orders += r.n; t.revenue = r2(t.revenue + num(r.rev));
      bump(r.h, r.app_src ? "apps" : "hall", r.n, num(r.rev));
    }
    let adsOrders = 0, adsRevenue = 0, testOrders = 0;
    const bySource = {};
    for (const o of shop) {
      if (o.is_test || TEST_COUPONS.includes(String(o.coupon || "").toUpperCase())) { testOrders++; continue; }
      tot.online.orders++; tot.online.revenue = r2(tot.online.revenue + num(o.total));
      bump(o.h, "online", 1, num(o.total));
      const src = adSourceOf(o.attribution, o.attrib_source);
      const key = src || String(o.attrib_source || "").toLowerCase() || "direct";
      const bs = (bySource[key] ||= { orders: 0, revenue: 0, paid: 0 });
      bs.orders++; bs.revenue = r2(bs.revenue + num(o.total));
      if (src) {
        bs.paid++; adsOrders++; adsRevenue = r2(adsRevenue + num(o.total));
        const b = (byHour[o.h] ||= { revenue: 0, orders: 0, hall: 0, apps: 0, online: 0, adsOrders: 0, adsRevenue: 0 });
        b.adsOrders++; b.adsRevenue = r2(b.adsRevenue + num(o.total));
      }
    }
    const total = r2(tot.hall.revenue + tot.apps.revenue + tot.online.revenue);
    const orders = tot.hall.orders + tot.apps.orders + tot.online.orders;
    return { total, orders, ...tot, adsOrders, adsRevenue, testOrders, bySource, byHour };
  }

  /* منحنى توزيع الدخل بالساعة من آخر CURVE_DAYS يوم تشغيلي مكتمل. */
  async function revenueCurve(day) {
    return cached(`curve|${day}`, async () => {
      const from = shiftDay(day, -CURVE_DAYS), to = shiftDay(day, -1);
      const rows = await q(`
        SELECT (extract(hour from (o.order_date AT TIME ZONE '${TZ}'))::int) AS h, COALESCE(sum(o.total),0) AS rev
          FROM ts_orders o
         WHERE o.order_date >= $1 AND o.order_date < $2
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
         GROUP BY 1`, [bizStart(from).toISOString(), bizEnd(to).toISOString()]);
      if (!rows.length) return { curve: FALLBACK_CURVE, source: "fallback", days: 0 };
      const byH = Object.fromEntries(rows.map((r) => [r.h, num(r.rev)]));
      const curve = BIZ_HOURS.map((h) => byH[h] || 0);
      const tot = curve.reduce((s, x) => s + x, 0);
      if (tot <= 0) return { curve: FALLBACK_CURVE, source: "fallback", days: 0 };
      return { curve, source: "history", days: CURVE_DAYS, from, to };
    }, 15 * 60_000);
  }

  async function guardPart(day) {
    const [log, state] = await Promise.all([
      q(`SELECT at, object_id, label, action, detail FROM ads_guard_log WHERE bizday = $1::date AND action NOT LIKE 'dry:%' ORDER BY at DESC LIMIT 80`, [day]),
      q(`SELECT v FROM ads_guard_state WHERE k = 'guard'`),
    ]);
    const st = state[0]?.v || null;
    return {
      log,
      scale: st?.scale ?? null,
      lastRun: st?.lastRun ?? null,
      throttled: st?.throttle ? Object.keys(st.throttle) : [],
      ratio: st?.ratio ?? null,
    };
  }

  async function compute(day, tgt) {
    const [spend, revenue, curveInfo, guard] = await Promise.all([spendPart(day), revenuePart(day), revenueCurve(day), guardPart(day)]);
    const now = new Date();
    const isToday = bizDay(now) === day;
    const elapsedMs = now.getTime() - bizStart(day).getTime();
    const bizHourIdx = isToday ? Math.min(23, Math.max(0, Math.floor(elapsedMs / 3600e3))) : 24;
    const minuteInHour = isToday ? Math.floor((elapsedMs % 3600e3) / 60e3) : 0;
    const share = isToday ? elapsedShare(curveInfo.curve, bizHourIdx, minuteInHour) : 1;
    const pace = paceVerdict({ spend: spend.total, revenue: revenue.total, target: tgt, share });

    const hourly = BIZ_HOURS.map((h) => {
      const r = revenue.byHour[h] || {};
      const s = num(spend.byHour[h]);
      const rev = num(r.revenue);
      return {
        hour: h, label: `${String(h).padStart(2, "0")}:00`,
        spend: r2(s), revenue: r2(rev), orders: r.orders || 0,
        adsOrders: r.adsOrders || 0, online: r2(r.online), hall: r2(r.hall), apps: r2(r.apps),
        ratio: rev > 0 ? r4(s / rev) : null,
      };
    });

    const spendWeb = r2(spend.total - spend.whatsapp);
    return {
      day, generatedAt: now.toISOString(), isToday,
      window: `${day} 04:00 → ${shiftDay(day, 1)} 04:00 (الرياض)`,
      clock: isToday ? { bizHourIdx, riyadhHour: BIZ_HOURS[bizHourIdx] ?? null, minuteInHour } : null,
      spend,
      revenue: {
        total: revenue.total, orders: revenue.orders,
        hall: revenue.hall, deliveryApps: revenue.apps, online: revenue.online,
        aovOnline: revenue.online.orders ? r2(revenue.online.revenue / revenue.online.orders) : null,
        mirrorsExcluded: revenue.mirrors, testOrdersExcluded: revenue.testOrders,
        bySource: revenue.bySource,
      },
      ads: {
        ordersFromAds: revenue.adsOrders, revenueFromAds: revenue.adsRevenue,
        cpoAll: revenue.orders ? r2(spend.total / revenue.orders) : null,              // كل طلبات المحل
        cpaOnline: revenue.online.orders ? r2(spendWeb / revenue.online.orders) : null, // كل طلبات المتجر
        cpaAds: revenue.adsOrders ? r2(spendWeb / revenue.adsOrders) : null,            // المنسوب للإعلان بس
        roasOnline: spendWeb ? r2(revenue.online.revenue / spendWeb) : null,
        roasTotal: spend.total ? r2(revenue.total / spend.total) : null,
        spendWeb, spendWhatsapp: spend.whatsapp,
      },
      pace,
      curve: { source: curveInfo.source, days: curveInfo.days, weights: curveInfo.curve.map((x, i) => ({ hour: BIZ_HOURS[i], w: r2(x) })) },
      hourly,
      guard,
      notes: [
        "اليوم التشغيلي من ٤ الفجر لـ٤ الفجر — طلب الساعة ١ بالليل بيتحسب على اليوم اللي فات.",
        "الصرف متظبّط ساعة بساعة على اليوم التشغيلي، مش على يوم حساب ميتا (لوس أنجلوس).",
        "«الإيقاع» بيقارن بمنحنى دخل آخر ١٤ يوم — عشان ٤ العصر مايتحسبش زي نص الليل.",
        "الواتساب متشال من CPA المتجر (العميل بيكلّم ويجي المحل) وموجود في إجمالي الصرف.",
      ],
    };
  }

  app.get("/api/marketing/ad-efficiency", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const day = c.req.query("day");
    if (day && !DAY_RE.test(day)) return c.json({ ok: false, error: "bad day" }, 400);
    const tq = Number(c.req.query("target"));
    const tgt = Number.isFinite(tq) && tq > 0.02 && tq < 0.8 ? tq : await target();
    try {
      return c.json({ ok: true, report: await compute(day || bizDay(new Date()), tgt) });
    } catch (e) {
      console.error("[adsefficiency] compute:", e);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* آخر N يوم: صرف × دخل × نسبة — للجدول تحت الشاشة والاتجاه */
  app.get("/api/marketing/ad-efficiency/history", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(60, Math.max(2, Number(c.req.query("days")) || 14));
    const to = bizDay(new Date()), from = shiftDay(to, -(days - 1));
    const tgt = await target();
    const [sp, pos, shop] = await Promise.all([
      q(`SELECT ((hour_start AT TIME ZONE '${TZ}') - interval '4 hours')::date::text AS day, sum(spend) AS spend
           FROM ad_spend_hourly WHERE hour_start >= $1 AND hour_start < $2 GROUP BY 1`, [bizStart(from).toISOString(), bizEnd(to).toISOString()]),
      q(`SELECT ((o.order_date AT TIME ZONE '${TZ}') - interval '4 hours')::date::text AS day,
                count(*)::int AS n, COALESCE(sum(o.total),0) AS rev
           FROM ts_orders o WHERE o.order_date >= $1 AND o.order_date < $2 AND ${POS_LIVE}
             AND NOT ((o.order_type ILIKE '%external%' OR o.order_type ILIKE '%qr-menu%') AND NOT (${APP_PAY} OR ${APP_SRC}))
          GROUP BY 1`, [bizStart(from).toISOString(), bizEnd(to).toISOString(), await appsList()]),
      q(`SELECT ((created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date::text AS day, count(*)::int AS n, COALESCE(sum(total),0) AS rev
           FROM shop_orders WHERE created_at >= $1 AND created_at < $2 AND status <> ALL($3::text[])
             AND NOT COALESCE(is_test,false) AND COALESCE(upper(coupon),'') <> ALL($4::text[])
          GROUP BY 1`, [bizStart(from).toISOString(), bizEnd(to).toISOString(), NOT_PAID, TEST_COUPONS]),
    ]);
    const m = new Map();
    const row = (d) => m.get(d) || (m.set(d, { day: d, spend: 0, revenue: 0, orders: 0, onlineOrders: 0 }), m.get(d));
    for (const r of sp) row(r.day).spend = r2(r.spend);
    for (const r of pos) { const x = row(r.day); x.revenue = r2(x.revenue + num(r.rev)); x.orders += r.n; }
    for (const r of shop) { const x = row(r.day); x.revenue = r2(x.revenue + num(r.rev)); x.orders += r.n; x.onlineOrders = r.n; }
    const rows = [...m.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map((x) => ({
      ...x, ratio: x.revenue > 0 ? r4(x.spend / x.revenue) : null,
      cpo: x.orders ? r2(x.spend / x.orders) : null,
      onTarget: x.revenue > 0 ? x.spend / x.revenue <= tgt : null,
    }));
    return c.json({ ok: true, target: tgt, from, to, rows });
  });

  return { compute, target };
}

export default { register };
