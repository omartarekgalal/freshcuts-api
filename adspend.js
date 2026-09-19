/* ═══════════════════════════════════════════════════════════════════════════
   ADSPEND — صرف الإعلانات بالساعة، متقسّم على اليوم التشغيلي بتاعنا.

   المشكلة (عمر، ١٩/٩): حساب ميتا على توقيت لوس أنجلوس، فـ«يوم ميتا» = من
   ١٠ الصبح لـ١٠ الصبح بتوقيت الرياض (٧ الصبح وقت الشتا)، ويومنا التشغيلي
   = من ٤ الفجر لـ٤ الفجر. مقارنة صرف يوم ميتا بدخل يومنا بتلخبط الأرقام كل
   ما الإعلانات تصرف بدري أو متأخر.

   الحل: بنسحب الصرف ساعة بساعة (ميتا: breakdown
   hourly_stats_aggregated_by_advertiser_time_zone على مستوى الحملة، سناب:
   granularity=HOUR على الحساب)، وكل ساعة بتتحوّل للحظة UTC حقيقية وبتتخزّن في
   ad_spend_hourly. أي تقرير بعد كده بيجمع الصرف جوّه نفس نافذة الطلبات
   بالظبط [startUtc, cutUtc) — يوم كامل أو نص يوم أو ٩٠ يوم، من غير نداء API.

   - حملات الواتساب (ميتا click-to-WhatsApp) بتتعلّم kind='whatsapp' بنفس
     قاعدة adsreport.js، فالتقارير بتفصلها عن صرف الموقع.
   - سناب بيفوتر بالدولار → ريال بسعر الربط ٣٫٧٥. ميتا بالريال.
   - المزامنة: كل ٣٠ دقيقة لآخر يومين، و POST /api/reports/biz/spend/sync {days}
     للتاريخ القديم.

   الدوال الصافية (تحويل التوقيت، تفكيك الساعة) متختبرة في adspend.test.mjs.
═══════════════════════════════════════════════════════════════════════════ */

import { ttMktToken, ttAdvertiserId } from "./ttconnect.js";
import { bizDay, bizDaySql, bizStart, bizEnd, shiftDay, DAY_RE } from "./bizday.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
export const SNAP_USD_SAR = 3.75;
export const PLATFORM_LABELS = { meta: "ميتا (فيسبوك/انستقرام)", meta_whatsapp: "ميتا — واتساب", snapchat: "سناب شات", tiktok: "تيك توك", google: "جوجل" };

/* نفس قاعدة adsreport.js: حملة واتساب = اسمها/هدفها فيه whatsapp/wa-/engagement ومش SALES. */
export const campaignKind = (name, objective) =>
  (/whatsapp|wa-|engagement/i.test(`${name || ""} ${objective || ""}`) && !/SALES/.test(objective || "") ? "whatsapp" : "web");

/* فرق التوقيت (دقايق) لمنطقة زمنية عند لحظة معيّنة — من Intl، فبيحترم التوقيت الصيفي. */
export function tzOffsetMin(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** ساعة محلية (يوم + ساعة) في منطقة زمنية → لحظة UTC (Date). */
export function zonedHourToUtc(day, hour, tz) {
  const guess = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  let off = tzOffsetMin(guess, tz);
  let utc = guess - off * 60000;
  const off2 = tzOffsetMin(utc, tz);
  if (off2 !== off) utc = guess - off2 * 60000;
  return new Date(utc);
}

/** صف ميتا بالساعة → صف جدول. "03:00:00 - 03:59:59" بتوقيت الحساب. */
export function metaRowToHour(r, tz) {
  const h = Number(String(r.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2));
  if (!Number.isFinite(h) || !DAY_RE.test(String(r.date_start || ""))) return null;
  const act1 = (arr, types) => { for (const t of types) { const a = (arr || []).find((x) => x.action_type === t); if (a) return num(a.value); } return 0; };
  const hourStart = zonedHourToUtc(r.date_start, h, tz);
  return {
    platform: "meta",
    campaign_id: String(r.campaign_id || "_account"),
    campaign_name: r.campaign_name || "",
    kind: campaignKind(r.campaign_name, r.objective),
    hour_start: hourStart,
    biz_day: bizDay(hourStart),
    spend: r2(r.spend),
    impressions: Math.round(num(r.impressions)),
    clicks: Math.round(num(r.inline_link_clicks)),
    purchases: act1(r.actions, ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"]),
    conversations: act1(r.actions, ["onsite_conversion.messaging_conversation_started_7d"]),
    currency: "SAR",
    src_tz: tz, src_day: r.date_start, src_hour: h,
  };
}

/** نقطة سناب بالساعة → صف جدول. start_time فيها الـoffset، فالتحويل مباشر. */
export function snapPointToHour(t, { rate = SNAP_USD_SAR, tz = "Asia/Riyadh", campaignId = "_account", name = "Snapchat (الحساب)" } = {}) {
  const ms = Date.parse(t.start_time);
  if (!Number.isFinite(ms)) return null;
  const hourStart = new Date(ms);
  return {
    platform: "snapchat", campaign_id: campaignId, campaign_name: name, kind: "web",
    hour_start: hourStart, biz_day: bizDay(hourStart),
    spend: r2((num(t.stats?.spend) / 1e6) * rate),
    impressions: Math.round(num(t.stats?.impressions)), clicks: Math.round(num(t.stats?.swipes)),
    purchases: 0, conversations: 0, currency: "USD→SAR",
    src_tz: tz, src_day: String(t.start_time).slice(0, 10), src_hour: Number(String(t.start_time).slice(11, 13)),
  };
}

/** أيام ميتا (بتوقيت الحساب) اللي بتغطي أيام تشغيلية معيّنة. */
export function metaDaysFor(fromBiz, toBiz, tz) {
  const a = bizStart(fromBiz), b = new Date(bizEnd(toBiz).getTime() - 1);
  const loc = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return { since: loc(a), until: loc(b) };
}

/** تجميع صفوف الساعات في أيام تشغيلية × منصة. */
export function bucketByBizDay(rows) {
  const out = {};
  for (const r of rows) {
    const d = r.biz_day || bizDay(r.hour_start);
    const k = r.platform === "meta" && r.kind === "whatsapp" ? "meta_whatsapp" : r.platform;
    out[d] = out[d] || { day: d, total: 0 };
    out[d][k] = r2((out[d][k] || 0) + num(r.spend));
    out[d].total = r2(out[d].total + num(r.spend));
  }
  return Object.values(out).sort((x, y) => (x.day < y.day ? -1 : 1));
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));

  let ready = null;
  const ensure = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS ad_spend_hourly (
      platform TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      hour_start TIMESTAMPTZ NOT NULL,
      campaign_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'web',
      spend NUMERIC NOT NULL DEFAULT 0,
      impressions INT NOT NULL DEFAULT 0,
      clicks INT NOT NULL DEFAULT 0,
      purchases NUMERIC NOT NULL DEFAULT 0,
      conversations NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      src_tz TEXT NOT NULL DEFAULT '',
      src_day DATE,
      src_hour INT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (platform, campaign_id, hour_start)
    );
    CREATE INDEX IF NOT EXISTS ad_spend_hourly_hour_idx ON ad_spend_hourly(hour_start);
    CREATE TABLE IF NOT EXISTS ad_spend_sync (
      platform TEXT NOT NULL,
      src_day DATE NOT NULL,
      ok BOOLEAN NOT NULL,
      rows INT NOT NULL DEFAULT 0,
      spend NUMERIC NOT NULL DEFAULT 0,
      error TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (platform, src_day)
    );`).catch((e) => { ready = null; throw e; }));

  async function getJson(url, opts = {}, tries = 3) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
      try { return await (await fetchImpl(url, { ...opts, signal: ctl.signal })).json(); }
      catch (e) { last = e; await new Promise((r) => setTimeout(r, 1200 * (i + 1))); }
      finally { clearTimeout(t); }
    }
    throw new Error(String(last?.cause?.code || last?.message || last));
  }

  /* ── ميتا ───────────────────────────────────────────────────────────── */
  let metaTz = null;
  async function metaAccount() {
    const token = process.env.META_CAPI_TOKEN, acct = process.env.META_AD_ACCOUNT_ID;
    if (!token || !acct) return null;
    const act = String(acct).startsWith("act_") ? acct : `act_${acct}`;
    if (!metaTz) {
      try {
        const u = new URL(`https://graph.facebook.com/v25.0/${act}`);
        u.searchParams.set("fields", "timezone_name"); u.searchParams.set("access_token", token);
        metaTz = (await getJson(u)).timezone_name || "America/Los_Angeles";
      } catch { metaTz = "America/Los_Angeles"; }
    }
    return { token, act, tz: metaTz };
  }

  async function saveRows(platform, srcDays, rows, matchCol = "src_day") {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (srcDays.length) await c.query(`DELETE FROM ad_spend_hourly WHERE platform=$1 AND ${matchCol} = ANY($2::date[])`, [platform, srcDays]);
      for (const r of rows) {
        await c.query(
          `INSERT INTO ad_spend_hourly(platform,campaign_id,hour_start,campaign_name,kind,spend,impressions,clicks,purchases,conversations,currency,src_tz,src_day,src_hour,fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
           ON CONFLICT (platform,campaign_id,hour_start) DO UPDATE SET
             campaign_name=EXCLUDED.campaign_name, kind=EXCLUDED.kind, spend=ad_spend_hourly.spend + EXCLUDED.spend,
             impressions=ad_spend_hourly.impressions + EXCLUDED.impressions, clicks=ad_spend_hourly.clicks + EXCLUDED.clicks,
             purchases=ad_spend_hourly.purchases + EXCLUDED.purchases, conversations=ad_spend_hourly.conversations + EXCLUDED.conversations,
             fetched_at=now()`,
          [r.platform, r.campaign_id, r.hour_start, r.campaign_name, r.kind, r.spend, r.impressions, r.clicks, r.purchases, r.conversations, r.currency, r.src_tz, r.src_day, r.src_hour]);
      }
      for (const d of srcDays) {
        const sp = r2(rows.filter((r) => r.src_day === d).reduce((s, r) => s + num(r.spend), 0));
        await c.query(`INSERT INTO ad_spend_sync(platform,src_day,ok,rows,spend,error,fetched_at) VALUES ($1,$2,true,$3,$4,NULL,now())
                       ON CONFLICT (platform,src_day) DO UPDATE SET ok=true, rows=EXCLUDED.rows, spend=EXCLUDED.spend, error=NULL, fetched_at=now()`,
        [platform, d, rows.filter((r) => r.src_day === d).length, sp]);
      }
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async function logFail(platform, days, error) {
    for (const d of days) {
      await pool.query(`INSERT INTO ad_spend_sync(platform,src_day,ok,error,fetched_at) VALUES ($1,$2,false,$3,now())
                        ON CONFLICT (platform,src_day) DO UPDATE SET ok=false, error=EXCLUDED.error, fetched_at=now()`,
      [platform, d, String(error).slice(0, 300)]).catch(() => {});
    }
  }

  /** يسحب أيام ميتا (بتوقيت الحساب) since..until ويستبدلها في الجدول. */
  async function syncMeta(since, until) {
    const acc = await metaAccount();
    if (!acc) return { platform: "meta", skipped: "not configured" };
    const days = [];
    for (let d = since; d <= until; d = shiftDay(d, 1)) days.push(d);
    try {
      const rows = [];
      // شرائح ٧ أيام عشان حجم الرد
      for (let i = 0; i < days.length; i += 7) {
        const chunk = days.slice(i, i + 7);
        let u = new URL(`https://graph.facebook.com/v25.0/${acc.act}/insights`);
        u.searchParams.set("level", "campaign");
        u.searchParams.set("time_range", JSON.stringify({ since: chunk[0], until: chunk[chunk.length - 1] }));
        u.searchParams.set("time_increment", "1");
        u.searchParams.set("breakdowns", "hourly_stats_aggregated_by_advertiser_time_zone");
        u.searchParams.set("fields", "campaign_id,campaign_name,objective,spend,impressions,inline_link_clicks,actions");
        u.searchParams.set("limit", "500");
        u.searchParams.set("access_token", acc.token);
        let guard = 0;
        while (u && guard++ < 40) {
          const j = await getJson(u);
          if (j.error) throw new Error(`meta: ${j.error.message}`);
          for (const r of j.data || []) { const x = metaRowToHour(r, acc.tz); if (x) rows.push(x); }
          u = j.paging?.next ? new URL(j.paging.next) : null;
        }
      }
      await saveRows("meta", days, rows);
      return { platform: "meta", tz: acc.tz, days: days.length, rows: rows.length, spend: r2(rows.reduce((s, r) => s + r.spend, 0)) };
    } catch (e) {
      await logFail("meta", days, e.message);
      return { platform: "meta", error: e.message };
    }
  }

  /** سناب: الأيام التشغيلية from..to (الحساب على توقيت الرياض). */
  async function syncSnap(fromBiz, toBiz) {
    const E = process.env;
    if (!E.SNAP_AD_ACCOUNT_ID || !E.SNAP_REFRESH_TOKEN || !E.SNAP_CLIENT_ID) return { platform: "snapchat", skipped: "not configured" };
    const days = [];
    for (let d = fromBiz; d <= toBiz; d = shiftDay(d, 1)) days.push(d);
    try {
      const b = new URLSearchParams({ grant_type: "refresh_token", client_id: E.SNAP_CLIENT_ID, client_secret: E.SNAP_CLIENT_SECRET || "", refresh_token: E.SNAP_REFRESH_TOKEN });
      const tok = (await getJson("https://accounts.snapchat.com/login/oauth2/access_token", { method: "POST", body: b }, 2)).access_token;
      if (!tok) throw new Error("snap token");
      const rows = [];
      const iso = (d) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 19) + ".000%2B03:00";
      for (let i = 0; i < days.length; i += 5) {
        const chunk = days.slice(i, i + 5);
        const s = bizStart(chunk[0]);
        // ماينفعش نطلب ساعات في المستقبل — سناب بيرفض end_time بعد الساعة الحالية
        const nowHour = new Date(Math.floor(Date.now() / 3600e3) * 3600e3 + 3600e3);
        const e = new Date(Math.min(bizEnd(chunk[chunk.length - 1]).getTime(), nowHour.getTime()));
        if (e <= s) continue;
        const u = `https://adsapi.snapchat.com/v1/adaccounts/${E.SNAP_AD_ACCOUNT_ID}/stats?granularity=HOUR&fields=spend&start_time=${iso(s)}&end_time=${iso(e)}`;
        const j = await getJson(u, { headers: { Authorization: `Bearer ${tok}` } });
        if (j.request_status !== "SUCCESS") throw new Error(`snap: ${j.debug_message || j.request_status}`);
        for (const t of j.timeseries_stats?.[0]?.timeseries_stat?.timeseries || []) {
          const x = snapPointToHour(t); if (x) { x.src_day = x.biz_day; rows.push(x); }
        }
      }
      // سناب بنخزّنه بمفتاح اليوم التشغيلي (src_day = biz_day) عشان الاستبدال يبقى نظيف
      await saveRows("snapchat", days, rows);
      return { platform: "snapchat", days: days.length, rows: rows.length, spend: r2(rows.reduce((s, r) => s + r.spend, 0)) };
    } catch (e) {
      await logFail("snapchat", days, e.message);
      return { platform: "snapchat", error: e.message };
    }
  }

  /* ── جوجل (١٩/٩): GAQL بالساعة (segments.date + segments.hour) بتوقيت العميل ── */
  let gTz = null, gCur = null;
  async function syncGoogle(fromBiz, toBiz) {
    let p;
    try { p = (await import("./ads.js")).byId("google"); } catch { p = null; }
    if (!p || typeof p.search !== "function" || p.missing?.("manageEnv")) return { platform: "google", skipped: "not configured" };
    try {
      if (!gTz) {
        const c = await p.search("SELECT customer.time_zone, customer.currency_code FROM customer LIMIT 1");
        if (!c.ok) throw new Error(`google: ${c.reason}`);
        gTz = c.results[0]?.customer?.timeZone || "Asia/Riyadh"; gCur = c.results[0]?.customer?.currencyCode || "SAR";
      }
      const m = metaDaysFor(fromBiz, toBiz, gTz);
      const days = []; for (let d = m.since; d <= m.until; d = shiftDay(d, 1)) days.push(d);
      const r = await p.search(`SELECT campaign.id, campaign.name, segments.date, segments.hour, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
          FROM campaign WHERE segments.date BETWEEN '${m.since}' AND '${m.until}' AND metrics.impressions > 0`);
      if (!r.ok) throw new Error(`google: ${r.reason}`);
      const fx = gCur === "USD" ? SNAP_USD_SAR : 1;
      const rows = [];
      for (const x of r.results) {
        const day = String(x.segments?.date || "").slice(0, 10), h = Number(x.segments?.hour);
        if (!DAY_RE.test(day) || !Number.isFinite(h)) continue;
        const hs = zonedHourToUtc(day, h, gTz);
        rows.push({ platform: "google", campaign_id: String(x.campaign?.id ?? "_account"), campaign_name: x.campaign?.name || "", kind: "web",
          hour_start: hs, biz_day: bizDay(hs), spend: r2((num(x.metrics?.costMicros) / 1e6) * fx), impressions: Math.round(num(x.metrics?.impressions)),
          clicks: Math.round(num(x.metrics?.clicks)), purchases: num(x.metrics?.conversions), conversations: 0, currency: gCur, src_tz: gTz, src_day: day, src_hour: h });
      }
      await saveRows("google", days, rows);
      return { platform: "google", tz: gTz, days: days.length, rows: rows.length, spend: r2(rows.reduce((a, b) => a + b.spend, 0)) };
    } catch (e) { return { platform: "google", error: String(e.message || e).slice(0, 300) }; }
  }

  /* ── تيك توك (١٩/٩): report/integrated/get بالساعة (يوم واحد لكل نداء) ──
     الإدارة/التقارير محتاجة توكن Marketing API (TIKTOK_MARKETING_TOKEN)؛ توكن
     الأحداث (TIKTOK_ACCESS_TOKEN) بيتجرّب كاحتياطي ولو اترفض بنقول كده. */
  let ttInfo = null;
  async function syncTiktok(fromBiz, toBiz) {
    const E = process.env;
    const token = ttMktToken(), adv = ttAdvertiserId();
    if (!token || !adv) return { platform: "tiktok", skipped: "not configured" };
    const base = "https://business-api.tiktok.com/open_api/v1.3";
    const H = { headers: { "Access-Token": token } };
    try {
      if (!ttInfo) {
        const j = await getJson(`${base}/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([adv]))}&fields=${encodeURIComponent(JSON.stringify(["timezone", "display_timezone", "currency"]))}`, H, 2);
        if (j.code !== 0) throw new Error(`tiktok: ${j.message || j.code}`);
        const a = j.data?.list?.[0] || {};
        ttInfo = { tz: a.display_timezone || (/^Etc|^[A-Z][a-z]+\//.test(a.timezone || "") ? a.timezone : null) || "Asia/Riyadh", currency: a.currency || "SAR" };
      }
      const m = metaDaysFor(fromBiz, toBiz, ttInfo.tz);
      const days = []; for (let d = m.since; d <= m.until; d = shiftDay(d, 1)) days.push(d);
      const fx = ttInfo.currency === "USD" ? SNAP_USD_SAR : 1;
      const rows = [];
      for (const d of days) {
        const q = new URLSearchParams({ advertiser_id: adv, report_type: "BASIC", data_level: "AUCTION_CAMPAIGN",
          dimensions: JSON.stringify(["campaign_id", "stat_time_hour"]), metrics: JSON.stringify(["spend", "impressions", "clicks", "campaign_name", "complete_payment"]),
          start_date: d, end_date: d, page_size: "1000" });
        const j = await getJson(`${base}/report/integrated/get/?${q}`, H, 2);
        if (j.code !== 0) throw new Error(`tiktok: ${j.message || j.code}`);
        for (const x of j.data?.list || []) {
          const t = String(x.dimensions?.stat_time_hour || ""); const h = Number(t.slice(11, 13));
          if (!DAY_RE.test(t.slice(0, 10)) || !Number.isFinite(h)) continue;
          const hs = zonedHourToUtc(t.slice(0, 10), h, ttInfo.tz);
          const sp = num(x.metrics?.spend);
          if (!sp && !num(x.metrics?.impressions)) continue;
          rows.push({ platform: "tiktok", campaign_id: String(x.dimensions?.campaign_id || "_account"), campaign_name: x.metrics?.campaign_name || "", kind: "web",
            hour_start: hs, biz_day: bizDay(hs), spend: r2(sp * fx), impressions: Math.round(num(x.metrics?.impressions)), clicks: Math.round(num(x.metrics?.clicks)),
            purchases: num(x.metrics?.complete_payment), conversations: 0, currency: ttInfo.currency, src_tz: ttInfo.tz, src_day: d, src_hour: h });
        }
      }
      await saveRows("tiktok", days, rows);
      return { platform: "tiktok", tz: ttInfo.tz, days: days.length, rows: rows.length, spend: r2(rows.reduce((a, b) => a + b.spend, 0)) };
    } catch (e) { return { platform: "tiktok", error: String(e.message || e).slice(0, 300) }; }
  }

  /** يزامن الأيام التشغيلية from..to لكل المنصات. */
  async function syncBizDays(fromBiz, toBiz) {
    await ensure();
    const acc = await metaAccount();
    const tz = acc?.tz || "America/Los_Angeles";
    const m = metaDaysFor(fromBiz, toBiz, tz);
    const [meta, snap, google, tiktok] = await Promise.all([syncMeta(m.since, m.until), syncSnap(fromBiz, toBiz), syncGoogle(fromBiz, toBiz), syncTiktok(fromBiz, toBiz)]);
    return { from: fromBiz, to: toBiz, meta, snap, google, tiktok };
  }

  /* ── القراءة ─────────────────────────────────────────────────────────── */

  /** الصرف جوّه نافذة زمنية [start, end). الساعة بتدخل لو بدايتها جوّه النافذة. */
  async function spendInWindow(startUtc, endUtc) {
    await ensure();
    const rows = (await pool.query(
      `SELECT platform, kind, COALESCE(sum(spend),0) AS spend, COALESCE(sum(purchases),0) AS purchases,
              COALESCE(sum(conversations),0) AS conversations, COALESCE(sum(clicks),0) AS clicks, COALESCE(sum(impressions),0) AS impressions
         FROM ad_spend_hourly WHERE hour_start >= $1 AND hour_start < $2
        GROUP BY 1,2`, [startUtc, endUtc])).rows;
    const out = { total: 0, meta: 0, metaWeb: 0, metaWhatsapp: 0, snapchat: 0, tiktok: 0, google: 0, metaPurchases: 0, whatsappConversations: 0, clicks: 0, impressions: 0 };
    for (const r of rows) {
      const s = num(r.spend);
      out.total += s;
      if (r.platform === "meta") { out.meta += s; if (r.kind === "whatsapp") out.metaWhatsapp += s; else out.metaWeb += s; }
      else if (r.platform === "snapchat") out.snapchat += s;
      else if (r.platform === "tiktok") out.tiktok += s;
      else if (r.platform === "google") out.google = (out.google || 0) + s;
      out.metaPurchases += num(r.purchases); out.whatsappConversations += num(r.conversations);
      out.clicks += num(r.clicks); out.impressions += num(r.impressions);
    }
    for (const k of Object.keys(out)) out[k] = r2(out[k]);
    out.web = r2(out.total - out.metaWhatsapp);
    return out;
  }

  /** الصرف لكل يوم تشغيلي في الفترة (للجداول والرسوم). */
  async function spendByBizDay(fromBiz, toBiz) {
    await ensure();
    const rows = (await pool.query(
      `SELECT platform, kind, hour_start, spend FROM ad_spend_hourly
        WHERE hour_start >= $1 AND hour_start < $2`, [bizStart(fromBiz), bizEnd(toBiz)])).rows;
    return bucketByBizDay(rows);
  }

  /** حملة بحملة جوّه نافذة (للتقرير اليومي). */
  async function campaignsInWindow(startUtc, endUtc) {
    await ensure();
    return (await pool.query(
      `SELECT platform, campaign_id AS id, max(campaign_name) AS name, max(kind) AS kind,
              sum(spend)::float AS spend, sum(purchases)::float AS purchases, sum(conversations)::float AS conversations,
              sum(clicks)::int AS clicks, sum(impressions)::int AS impressions
         FROM ad_spend_hourly WHERE hour_start >= $1 AND hour_start < $2
        GROUP BY 1,2 ORDER BY spend DESC`, [startUtc, endUtc])).rows.map((r) => ({ ...r, spend: r2(r.spend) }));
  }

  async function freshness() {
    await ensure();
    return (await pool.query(
      `SELECT platform, max(fetched_at) AS last_ok, count(*) FILTER (WHERE NOT ok)::int AS failing,
              (array_agg(error ORDER BY fetched_at DESC) FILTER (WHERE NOT ok))[1] AS last_error
         FROM ad_spend_sync WHERE src_day >= current_date - 3 GROUP BY 1`)).rows;
  }

  /* ── المسارات ────────────────────────────────────────────────────────── */
  app.post("/api/reports/biz/spend/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const today = bizDay(new Date());
    const to = DAY_RE.test(String(b.to || "")) ? b.to : today;
    const days = Math.min(120, Math.max(1, Number(b.days) || 2));
    const from = DAY_RE.test(String(b.from || "")) ? b.from : shiftDay(to, -(days - 1));
    return c.json({ ok: true, ...(await syncBizDays(from, to)) });
  });

  /* ── المزامنة الدورية ─────────────────────────────────────────────────
     كل ٣٠ دقيقة: امبارح + النهارده (التشغيلي). ميتا بيعدّل أرقام الساعات
     الأخيرة لحد ما تستقر، فإعادة سحب يومين كاملين هي الأمان. */
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const today = bizDay(new Date());
      const r = await syncBizDays(shiftDay(today, -1), today);
      if (r.meta?.error || r.snap?.error || r.google?.error || r.tiktok?.error) console.error("[adspend] sync:", r.meta?.error || "", r.snap?.error || "", r.google?.error || "", r.tiktok?.error || "");
    } catch (e) { console.error("[adspend] tick:", e.message); }
    finally { busy = false; }
  }
  if (process.env.AD_SPEND_SYNC !== "0") {
    setTimeout(() => { tick(); setInterval(tick, 30 * 60_000); }, 60_000);
  }

  return { ensure, syncBizDays, spendInWindow, spendByBizDay, campaignsInWindow, freshness, tick };
}

export default { register };
