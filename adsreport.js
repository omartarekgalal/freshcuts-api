/* ═══════════════════════════════════════════════════════════════════════════
   ADS DAILY REVENUE REPORT — «عايز اشوف الدخل» (Omar, 17 Sep 2026)

   Omar approved spending up to 3,000 SAR/day on ads as long as revenue holds
   (guide: ~25–30% of total daily revenue, sustained). This module is the one
   number sheet that decision is taken on, every day:

     • total revenue of the business day, split hall / delivery apps /
       online delivery / online pickup
     • online orders, AOV, how many came from ads (ours + Meta's own count)
     • Meta spend per campaign, CPA, online ROAS, spend as % of revenue
     • a one-line recommendation (SCALE / HOLD / CUT)

   Stored in mk_daily_reports (one row per business day) and sent to Omar as
   ONE English SMS (GSM-7, ≤160 chars — same one-segment rule as
   staffalerts.js) through Taqnyat's transactional sender.

   Routes (admin):
     GET  /api/marketing/daily-report?day=YYYY-MM-DD   stored report (live=1 → compute now, not stored)
     GET  /api/marketing/daily-report?days=14          last N stored reports (for the dashboard table)
     POST /api/marketing/daily-report/run  {day?, send?, force?}   compute + store (+ SMS)
     GET/PUT /api/marketing/daily-report/config        {enabled, phones, at}

   The ads guard (VPS cron, /home/omar/apps/fc96/guard.mjs) reads yesterday's
   stored report to decide budget scaling — so the numbers here ARE the gate.

   Business rules (same as dayreport.js):
   - Business day rolls at 04:00 Riyadh (TabSense calendar_day). Meta's ad
     account is on America/Los_Angeles, whose day = Riyadh 10:00→10:00, and ads
     only deliver 12:30→02:30 — so the LA date's spend == our business day.
   - Money is VAT-inclusive (`total`). Void/refund excluded.
   - Online orders are counted from shop_orders (they also land in ts_orders
     as External orders without an aggregator payment — those are excluded
     from the POS side so nothing is counted twice).
═══════════════════════════════════════════════════════════════════════════ */

import { smsInfo, fitOneSms, staffPhones } from "./staffalerts.js";

const TZ = "Asia/Riyadh";
const DEFAULT_CFG = { enabled: true, phones: ["0544775082"], at: "03:40" };
const NOT_PAID = ["pending_payment", "expired", "rejected_refunded", "refunded", "refund_failed", "cancelled", "canceled", "payment_failed", "failed", "unpaid"];
const TEST_COUPONS = ["OMAR-9X4T"];
const THRESH = { upMaxShare: 0.30, upMaxCpa: 60, cutShare: 0.35, cutCpa: 90 };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r0 = (v) => Math.round(num(v));
const r2 = (v) => Math.round(num(v) * 100) / 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Which business day should the scheduled run report on at `now`?
   From the configured time (default 03:40) until 12:00 → the day that just
   ended (now − 12h). Outside that window → null (nothing to do). */
export function reportDayAt(now = new Date(), at = DEFAULT_CFG.at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const mins = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const [ah, am] = String(at || DEFAULT_CFG.at).split(":").map(Number);
  const start = (ah || 0) * 60 + (am || 0);
  if (mins < start || mins >= 12 * 60) return null;
  const q = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now.getTime() - 12 * 3600e3)).map((x) => [x.type, x.value]));
  return `${q.year}-${q.month}-${q.day}`;
}

/* The business day that ended most recently (TabSense rolls at 04:00 Riyadh):
   Riyadh date of (now − 4h) minus one day. */
export function previousBizDay(now = new Date()) {
  const q = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now.getTime() - 28 * 3600e3)).map((x) => [x.type, x.value]));
  return `${q.year}-${q.month}-${q.day}`;
}

/* Did this online order come from a paid ad? Returns "meta" | "snapchat" | null. */
export function adSourceOf(attr, attribSource = null) {
  const a = attr || {};
  const utm = a.utm || {};
  const src = String(utm.utm_source || "").toLowerCase();
  const med = String(utm.utm_medium || "").toLowerCase();
  const link = String(a.fc_link || utm.utm_content || "").toLowerCase();
  const click = a.click || {};
  if (/^96-(m2|m3|meta)-/.test(link) || click.fbc || click.fbclid) return "meta";
  if (/^96-snap-/.test(link) || click.ScCid || click.sccid) return "snapchat";
  if (med === "paid") {
    if (["meta", "facebook", "instagram", "fb", "ig"].includes(src)) return "meta";
    if (src === "snapchat") return "snapchat";
  }
  // classifySource() (checkout-meta.js) writes shop_orders.attrib_source from the SAME
  // attribution blob plus the server-side journey session, so it catches the in-app-browser
  // orders whose localStorage was wiped. Platform + a paid medium/link is still required.
  const cls = String(attribSource || "").toLowerCase();
  if ((cls === "meta" || cls === "snapchat") && (med === "paid" || /^96-(m2|m3|meta|snap)-/.test(link))) return cls;
  return null;
}

/* Where did every paid-for online order come from, by OUR own data (attrib_source
   first, attribution blob second). Reported next to Meta's own count, never replaced
   by it — Meta counts a purchase it merely thinks it caused. */
export function sourceOf(o) {
  const cls = String(o.attrib_source || "").toLowerCase();
  if (cls) return cls;
  const a = o.attribution || {};
  const src = String(a.utm?.utm_source || "").toLowerCase();
  return src || (a.fc_link ? "link" : "direct");
}

/* Reading notes that belong ON the report, not in someone's head:
   - campaigns before 17/9 optimised for calls / WhatsApp chats / menu views, never for a
     store purchase, so their "0 purchases" is not comparable with the store campaigns
   - WhatsApp orders arrive by walking in or calling, so only the quick-reply link slugs
     and the cashier's «من وين عرفتنا؟» can attribute them
   - online orders from the owner's own phone are flagged is_test and excluded */
export const COMPARE_FROM = "2026-09-17";
export function NOTES(day) {
  const n = [];
  if (day < COMPARE_FROM) n.push(`الحملات قبل ${COMPARE_FROM} كانت متحسّنة على مكالمات/محادثات واتساب/مشاهدة منيو، مش على شراء من المتجر — «صفر شراء» فيها مش مقارنة عادلة.`);
  else n.push(`المقارنة بتبدأ من ${COMPARE_FROM}: قبل كده الحملات كانت على مكالمات ومحادثات واتساب، مش على طلبات المتجر.`);
  n.push("الواتساب: العميل بيكلّم ويجي المحل أو يتصل، فالمنسوب ليه = زيارات روابط 96-wa-* والطلبات اللي عليها الـslug + سؤال الكاشير «من وين عرفتنا؟».");
  n.push("طلبات المالك التجريبية متعلّمة is_test ومتشالة من الأرقام.");
  return n;
}

export function recommend(ads) {
  const { spendTotal, spendShareOfRevenue: share, cpaOnline: cpa, ordersFromAds } = ads;
  if (!spendTotal) return { code: "NO_SPEND", en: "NO SPEND", ar: "مفيش صرف إعلانات" };
  if ((share != null && share > THRESH.cutShare) || (cpa == null ? ordersFromAds === 0 && spendTotal > 50 : cpa > THRESH.cutCpa)) {
    return { code: "CUT", en: "CUT 30% if repeats", ar: `قلّل ٣٠٪ لو اتكرر بكرة (الصرف ${share == null ? "—" : Math.round(share * 100) + "٪"} من الدخل، تكلفة الطلب ${cpa == null ? "—" : Math.round(cpa)})` };
  }
  if (ordersFromAds >= 1 && share != null && share <= THRESH.upMaxShare && cpa != null && cpa <= THRESH.upMaxCpa) {
    return { code: "SCALE", en: "SCALE +25%", ar: "كبّر ٢٥٪ (الصرف تحت ٣٠٪ من الدخل وتكلفة الطلب ≤ ٦٠)" };
  }
  return { code: "HOLD", en: "HOLD", ar: "ثبّت الميزانية" };
}

/* One GSM-7 segment, English only. Example (≈130 chars):
   FC 17/09 Rev 2150 (Hall 900, Apps 850, Web 400). Web 5 ord AOV 80, ads 3. Meta 520 = 24% rev, CPA 104, ROAS 0.8. HOLD */
export function smsText(rep) {
  const d = String(rep.day || "").slice(5).split("-").reverse().join("/");
  const R = rep.revenue || {}, O = rep.online || {}, A = rep.ads || {};
  const pct = A.spendShareOfRevenue == null ? "-" : `${Math.round(A.spendShareOfRevenue * 100)}%`;
  const cpa = A.cpaOnline == null ? "-" : r0(A.cpaOnline);
  const roas = A.roasOnline == null ? "-" : (Math.round(A.roasOnline * 10) / 10).toFixed(1);
  const web = r0((R.onlineDelivery?.revenue || 0) + (R.onlinePickup?.revenue || 0));
  const full = `FC ${d} Rev ${r0(R.total)} (Hall ${r0(R.hall?.revenue)}, Apps ${r0(R.deliveryApps?.revenue)}, Web ${web}). Web ${O.orders || 0} ord AOV ${r0(O.aov)}, ads ${A.ordersFromAds || 0}. Ads ${r0(A.spendTotal)} = ${pct} rev, CPA ${cpa}, ROAS ${roas}. ${rep.recommendation?.en || ""}`.trim();
  if (smsInfo(full).segments <= 1) return full;
  const short = `FC ${d} Rev ${r0(R.total)} Web ${O.orders || 0}/${web} Ads ${r0(A.spendTotal)} ${pct} CPA ${cpa} ROAS ${roas} ${rep.recommendation?.code || ""}`;
  return fitOneSms(short);
}

/* The daily ADS line (18/9, CRO review): a SECOND one-segment English SMS right after
   the revenue one, so the owner sees in one glance where the orders came from, what an
   order cost and what the guard changed yesterday. Example (≈140 chars):
   FC ADS 17/09 Ord M2 S0 SMS1 D5 | CPA 24 (ads 104) | Spend M220 S0 WA74 | Chg: pace ATC 435, boost WA 125, 2 alerts */
const SRC_ABBR = { meta: "M", snapchat: "S", snap: "S", sms: "SMS", whatsapp: "WA", direct: "D", google: "G", tiktok: "T", link: "L", instagram: "IG", facebook: "FB" };
const CHANGE_ACTIONS = {
  pace_lifetime_budget: (d, l) => `pace ${short(l)} ${r0(d.pace ?? d.to)}`,
  boost_evening: (d, l) => `boost ${short(l)} ${r0(d.to)}`,
  scale_up: (d) => `scale x${d.to}`,
  scale_cut: (d) => `cut x${d.to}`,
  retired: (d, l) => `retired ${short(l)}`,
  hard_cap_hit: () => "HIT 3000 CAP",
  needs_decision: () => "NEEDS DECISION",
};
function short(label) {
  const l = String(label || "");
  if (/WA|whatsapp/i.test(l)) return "WA";
  if (/RT/i.test(l)) return "RT";
  if (/SNAP/i.test(l)) return "Snap";
  if (/ATC|PUR|SALES/i.test(l)) return "ATC";
  return l.replace(/[^ -~]/g, "").slice(0, 8);
}
export function changesText(guard = []) {
  const out = [];
  let alerts = 0, errors = 0, edits = 0, vids = 0;
  const add = (t) => { if (t && !out.includes(t)) out.push(t); };
  for (const g of guard || []) {
    const d = g.detail || {};
    const f = CHANGE_ACTIONS[g.action];
    if (f) add(f(d, g.label));
    else if (g.action === "health_alert") alerts++;
    else if (g.action === "error") errors++;
    else if (g.action === "pause_ad_ai_video") vids++;
    else if (g.action === "pause_whatsapp") add("WA off");
    else if (/^reenable/.test(g.action || "")) add(`${short(g.label)} on`);
    else if (g.action === "budget_up_from_whatsapp") add(`RT ${r0(d.toDaily)}`);
    else if (/^(setup_|switch_|budget_|pause_)/.test(g.action || "")) edits++;
  }
  if (vids) add(`${vids} AI vids off`);
  if (alerts) add(`${alerts} alert${alerts > 1 ? "s" : ""}`);
  if (errors) add(`${errors} err`);
  if (edits) add(`+${edits} edits`);
  return out.length ? out.join(", ") : "none";
}
export function smsAdsText(rep) {
  const d = String(rep.day || "").slice(5).split("-").reverse().join("/");
  const O = rep.online || {}, A = rep.ads || {};
  const src = Object.entries(O.bySource || {}).sort((a, b) => (b[1].orders || 0) - (a[1].orders || 0))
    .map(([k, v]) => `${SRC_ABBR[k] || k.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}${v.orders || 0}`);
  // ad orders are always shown, even when zero — the point of the line
  if (!src.some((x) => /^M\d/.test(x))) src.unshift(`M${A.ordersFromAdsOursMeta || 0}`);
  if (A.spendSnap && !src.some((x) => /^S\d/.test(x))) src.splice(1, 0, `S${A.ordersFromAdsOursSnap || 0}`);
  const cpa = A.cpaOnline == null ? "-" : r0(A.cpaOnline);
  const cpaAds = A.cpaAds == null ? "-" : r0(A.cpaAds);
  const spend = `M${r0(A.spendMeta - (A.spendWhatsapp || 0))} S${r0(A.spendSnap)} WA${r0(A.spendWhatsapp)}`;
  const chg = changesText(rep.guard);
  const full = `FC ADS ${d} Ord ${src.join(" ")} | CPA ${cpa} (ads ${cpaAds}) | Spend ${spend} | Chg: ${chg}`;
  return fitOneSms(full);
}

/* Pure assembly — unit-tested. */
export function buildReport({ day, pos, shop, meta, snap = null, guardLog = [], whatsapp = null, now = new Date() }) {
  const onlineDelivery = { orders: 0, revenue: 0 }, onlinePickup = { orders: 0, revenue: 0 };
  let testOrders = 0, ours = 0, oursMeta = 0, oursSnap = 0, adsRevenue = 0;
  const byLink = {}, bySource = {};
  for (const o of shop) {
    if (o.is_test || TEST_COUPONS.includes(String(o.coupon || "").toUpperCase())) { testOrders++; continue; }
    const bucket = o.option === "pickup" ? onlinePickup : onlineDelivery;
    bucket.orders++; bucket.revenue += num(o.total);
    const src = adSourceOf(o.attribution, o.attrib_source);
    if (src) { ours++; adsRevenue += num(o.total); if (src === "meta") oursMeta++; else oursSnap++; }
    const s = sourceOf(o);
    bySource[s] = bySource[s] || { orders: 0, revenue: 0, paid: 0 };
    bySource[s].orders++; bySource[s].revenue = r2(bySource[s].revenue + num(o.total)); if (src) bySource[s].paid++;
    const link = o.attribution?.fc_link;
    if (link) byLink[link] = (byLink[link] || 0) + 1;
  }
  onlineDelivery.revenue = r2(onlineDelivery.revenue); onlinePickup.revenue = r2(onlinePickup.revenue);
  const onlineOrders = onlineDelivery.orders + onlinePickup.orders;
  const onlineRevenue = r2(onlineDelivery.revenue + onlinePickup.revenue);
  const total = r2(num(pos.hall.revenue) + num(pos.deliveryApps.revenue) + onlineRevenue);

  const camps = (meta?.campaigns || []).map((c) => ({ ...c, spend: r2(c.spend) }));
  const spendMeta = r2(camps.reduce((s, c) => s + num(c.spend), 0));
  const spendWhatsapp = r2(camps.filter((c) => c.kind === "whatsapp").reduce((s, c) => s + num(c.spend), 0));
  const spendSnap = r2(snap?.spend || 0);
  const spendTotal = r2(spendMeta + spendSnap);
  const spendWeb = r2(spendTotal - spendWhatsapp);
  const metaPurchases = camps.reduce((s, c) => s + num(c.purchases), 0);
  // OUR paid orders decide, not Meta's. Since the storefront attribution fix (17/9) the
  // utm/fbclid/session survive checkout, so `ours` is the honest number; Meta's own count
  // stays visible beside it (metaPurchases) but never drives a budget decision.
  const ordersFromAds = ours;
  const ads = {
    spendTotal, spendMeta, spendSnap, spendWeb, spendWhatsapp,
    byCampaign: camps.sort((a, b) => b.spend - a.spend),
    metaPurchases, metaPurchaseValue: r2(camps.reduce((s, c) => s + num(c.purchaseValue), 0)),
    whatsappConversations: camps.reduce((s, c) => s + num(c.conversations), 0),
    ordersFromAds, ordersFromAdsOurs: ours, ordersFromAdsOursMeta: oursMeta, ordersFromAdsOursSnap: oursSnap, adsRevenueOurs: r2(adsRevenue),
    // blended: web ad spend ÷ ALL online orders (attribution loses in-app-browser orders, so this is the honest gate)
    cpaOnline: onlineOrders ? r2(spendWeb / onlineOrders) : null,
    cpaAds: ordersFromAds ? r2(spendWeb / ordersFromAds) : null,
    roasOnline: spendWeb ? r2(onlineRevenue / spendWeb) : null,
    spendShareOfRevenue: total ? Math.round((spendTotal / total) * 10000) / 10000 : null,
    metaError: meta?.error || null,
  };
  const rep = {
    day, generatedAt: now.toISOString(),
    revenue: {
      total, hall: pos.hall, deliveryApps: pos.deliveryApps, onlineDelivery, onlinePickup,
      onlineInPos: pos.onlineInPos, // reconciliation only — not added to total
    },
    online: { orders: onlineOrders, revenue: onlineRevenue, aov: onlineOrders ? r2(onlineRevenue / onlineOrders) : null, testOrdersExcluded: testOrders, byLink, bySource },
    ads,
    whatsapp: {
      spend: spendWhatsapp,
      conversations: ads.whatsappConversations,
      costPerConversation: ads.whatsappConversations ? r2(spendWhatsapp / ads.whatsappConversations) : null,
      ...(whatsapp || { linkLandings: 0, ordersFromLinks: 0, revenueFromLinks: 0 }),
    },
    thresholds: THRESH,
    guard: guardLog,
    notes: NOTES(day),
  };
  rep.recommendation = recommend(ads);
  rep.sms = smsText(rep);
  rep.smsAds = smsAdsText(rep);
  return rep;
}

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, getSettingsData, DEFAULT_DELIVERY_APPS } = ctx;
  const sendSms = deps.sendSms || null;
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));

  let schemaReady = null;
  const ensureSchema = () => (schemaReady ||= pool.query(`
    CREATE TABLE IF NOT EXISTS mk_daily_reports (
      day DATE PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sms_text TEXT,
      sms_to TEXT,
      sms_sent_at TIMESTAMPTZ,
      sms_error TEXT
    )`).catch((e) => { schemaReady = null; throw e; }));

  async function config() {
    const s = (await getSettingsData()) || {};
    const c = { ...DEFAULT_CFG, ...(s.adsReport || {}) };
    c.phones = staffPhones(c.phones).map((p) => `0${p}`);
    if (!/^\d{1,2}:\d{2}$/.test(String(c.at))) c.at = DEFAULT_CFG.at;
    c.enabled = c.enabled !== false;
    return c;
  }

  async function deliveryApps() {
    const s = await getSettingsData();
    const list = Array.isArray(s?.deliveryAppMethods) && s.deliveryAppMethods.length ? s.deliveryAppMethods : DEFAULT_DELIVERY_APPS;
    return list.map((x) => String(x).toLowerCase());
  }

  async function posPart(day) {
    const apps = await deliveryApps();
    const rows = (await pool.query(`
      WITH o AS (
        SELECT o.total,
               EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(o.payments,'{}'::jsonb)) k WHERE lower(k) = ANY($2::text[])) AS app_pay,
               (o.order_type ILIKE '%external%') AS ext,
               (o.order_type ILIKE '%qr-menu%') AS qr,
               s.source, s.source_note,
               (SELECT k FROM jsonb_object_keys(COALESCE(o.payments,'{}'::jsonb)) k WHERE lower(k) = ANY($2::text[]) LIMIT 1) AS app_key
          FROM ts_orders o LEFT JOIN order_sources s ON s.order_id = o.order_id
         WHERE o.calendar_day = $1::date
           AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
      ), c AS (
        SELECT total,
          CASE WHEN app_pay OR source = 'delivery_app' THEN 'apps'
               WHEN ext OR qr THEN 'online'
               ELSE 'hall' END AS bucket,
          lower(COALESCE(NULLIF(source_note,''), app_key, 'external')) AS app
          FROM o
      )
      SELECT bucket, CASE WHEN bucket='apps' THEN app END AS app, count(*)::int AS n, COALESCE(sum(total),0) AS rev
        FROM c GROUP BY 1,2`, [day, apps])).rows;
    const part = { hall: { orders: 0, revenue: 0 }, deliveryApps: { orders: 0, revenue: 0, byApp: {} }, onlineInPos: { orders: 0, revenue: 0 } };
    for (const r of rows) {
      const tgt = r.bucket === "apps" ? part.deliveryApps : r.bucket === "online" ? part.onlineInPos : part.hall;
      tgt.orders += r.n; tgt.revenue = r2(tgt.revenue + num(r.rev));
      if (r.bucket === "apps") part.deliveryApps.byApp[r.app || "external"] = { orders: r.n, revenue: r2(r.rev) };
    }
    return part;
  }

  async function shopPart(day) {
    return (await pool.query(`
      SELECT order_no, option, total, coupon, is_test, attribution, attrib_source, status
        FROM shop_orders
       WHERE ((created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date = $1::date
         AND status <> ALL($2::text[])`, [day, NOT_PAID])).rows;
  }

  async function metaPart(day) {
    const token = process.env.META_CAPI_TOKEN, acct = process.env.META_AD_ACCOUNT_ID;
    if (!token || !acct) return { campaigns: [], error: "META not configured" };
    const act = String(acct).startsWith("act_") ? acct : `act_${acct}`;
    const u = new URL(`https://graph.facebook.com/v25.0/${act}/insights`);
    u.searchParams.set("level", "campaign");
    u.searchParams.set("time_range", JSON.stringify({ since: day, until: day }));
    u.searchParams.set("fields", "campaign_id,campaign_name,objective,spend,actions,action_values,inline_link_clicks,impressions");
    u.searchParams.set("limit", "100");
    u.searchParams.set("access_token", token);
    let j = null, lastErr = null;
    for (let i = 0; i < 3 && !j; i++) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
        try { j = await (await fetchImpl(u, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
      } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    }
    if (!j) return { campaigns: [], error: `meta fetch failed: ${String(lastErr?.cause?.code || lastErr?.message || lastErr)}` };
    if (j.error) return { campaigns: [], error: `meta: ${j.error.message}` };
    const act1 = (arr, types) => { for (const t of types) { const a = (arr || []).find((x) => x.action_type === t); if (a) return num(a.value); } return 0; };
    return {
      campaigns: (j.data || []).map((r) => ({
        id: r.campaign_id, name: r.campaign_name, objective: r.objective,
        kind: /whatsapp|wa-|engagement/i.test(`${r.campaign_name} ${r.objective}`) && !/SALES/.test(r.objective) ? "whatsapp" : "web",
        spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.inline_link_clicks),
        purchases: act1(r.actions, ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"]),
        purchaseValue: act1(r.action_values, ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"]),
        conversations: act1(r.actions, ["onsite_conversion.messaging_conversation_started_7d"]),
      })),
    };
  }

  /* Snapchat spend for the Riyadh calendar day (the Snap account runs on Asia/Riyadh and
     bills in USD → SAR at the 3.75 peg). Before 18/9 the report never asked Snap, so its
     spend was silently 0 in the share-of-revenue and CPA gates. */
  async function snapPart(day) {
    const E = process.env;
    if (!E.SNAP_AD_ACCOUNT_ID || !E.SNAP_REFRESH_TOKEN || !E.SNAP_CLIENT_ID) return null;
    try {
      const b = new URLSearchParams({ grant_type: "refresh_token", client_id: E.SNAP_CLIENT_ID, client_secret: E.SNAP_CLIENT_SECRET || "", refresh_token: E.SNAP_REFRESH_TOKEN });
      const tok = (await (await fetchImpl("https://accounts.snapchat.com/login/oauth2/access_token", { method: "POST", body: b })).json()).access_token;
      if (!tok) return { spend: 0, error: "snap token" };
      const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      const u = `https://adsapi.snapchat.com/v1/adaccounts/${E.SNAP_AD_ACCOUNT_ID}/stats?granularity=DAY&fields=spend`
        + `&start_time=${day}T00:00:00.000%2B03:00&end_time=${next.toISOString().slice(0, 10)}T00:00:00.000%2B03:00`;
      const j = await (await fetchImpl(u, { headers: { Authorization: `Bearer ${tok}` } })).json();
      if (j.request_status !== "SUCCESS") return { spend: 0, error: `snap: ${j.debug_message || j.request_status}` };
      const micro = (j.timeseries_stats?.[0]?.timeseries_stat?.timeseries || []).reduce((s, t) => s + num(t.stats?.spend), 0);
      return { spend: r2((micro / 1e6) * 3.75) };
    } catch (e) { return { spend: 0, error: `snap: ${e.message}` }; }
  }

  async function guardPart(day) {
    try {
      return (await pool.query(`SELECT at, object_id, label, action, detail FROM ads_guard_log WHERE bizday = $1::date AND action NOT LIKE 'dry:%' ORDER BY at`, [day])).rows;
    } catch { return []; } // table is created by the guard job
  }

  /* WhatsApp ads can't be attributed by a pixel: the customer chats, then walks in or
     calls. So we measure what we CAN — conversations (Meta), landings on the WhatsApp
     quick-reply links (96-wa-*), and orders that carry one of those slugs. */
  async function whatsappPart(day) {
    const q = async (sql, args) => { try { return (await pool.query(sql, args)).rows; } catch { return []; } };
    const landings = await q(
      `SELECT count(*)::int n FROM funnel_events
        WHERE event_name = 'PageView'
          AND ((created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date = $1::date
          AND COALESCE(utm->>'utm_content', '') LIKE '96-wa-%'`, [day]);
    const orders = await q(
      `SELECT count(*)::int n, COALESCE(sum(total),0) rev FROM shop_orders
        WHERE ((created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date = $1::date
          AND is_test IS NOT TRUE AND status <> ALL($2::text[])
          AND COALESCE(attribution->>'fc_link', '') LIKE '96-wa-%'`, [day, NOT_PAID]);
    return { linkLandings: landings[0]?.n || 0, ordersFromLinks: orders[0]?.n || 0, revenueFromLinks: r2(orders[0]?.rev) };
  }

  async function compute(day) {
    const [pos, shop, meta, guardLog, whatsapp, snap] = await Promise.all([posPart(day), shopPart(day), metaPart(day), guardPart(day), whatsappPart(day), snapPart(day)]);
    return buildReport({ day, pos, shop, meta, snap, guardLog, whatsapp });
  }

  async function store(rep) {
    await ensureSchema();
    await pool.query(`
      INSERT INTO mk_daily_reports(day, data, sms_text) VALUES ($1,$2,$3)
      ON CONFLICT (day) DO UPDATE SET data=EXCLUDED.data, sms_text=EXCLUDED.sms_text, updated_at=now()`,
    [rep.day, JSON.stringify(rep), rep.sms]);
  }

  /* SMS exactly once per day: the row is claimed atomically, so two containers
     during a Coolify rollover can't both send. force=true re-sends. */
  async function sendOnce(day, { force = false } = {}) {
    await ensureSchema();
    const cfg = await config();
    if (!sendSms) return { ok: false, error: "sms not wired" };
    if (!cfg.phones.length) return { ok: false, error: "no phones" };
    const claim = await pool.query(
      `UPDATE mk_daily_reports SET sms_sent_at=now(), sms_to=$2, sms_error=NULL
        WHERE day=$1::date ${force ? "" : "AND sms_sent_at IS NULL"} RETURNING sms_text, data->>'smsAds' AS sms_ads`, [day, cfg.phones.join(",")]);
    if (!claim.rowCount) return { ok: false, skipped: "already sent" };
    const text = fitOneSms(claim.rows[0].sms_text || "");
    const errors = [];
    for (const p of staffPhones(cfg.phones)) {
      try { await sendSms({ phoneNorm: p, body: text }); } catch (e) { errors.push(`${p}: ${e.message}`); }
      // second segment-sized SMS: orders by source, CPA, what the guard changed
      const adsLine = fitOneSms(claim.rows[0].sms_ads || "");
      if (adsLine) { try { await sendSms({ phoneNorm: p, body: adsLine }); } catch (e) { errors.push(`${p} ads: ${e.message}`); } }
    }
    if (errors.length) await pool.query(`UPDATE mk_daily_reports SET sms_error=$2 WHERE day=$1::date`, [day, errors.join("; ").slice(0, 500)]);
    return { ok: !errors.length, text, info: smsInfo(text), to: cfg.phones, errors };
  }

  let running = false;
  async function tick(now = new Date()) {
    if (running) return;
    running = true;
    try {
      const cfg = await config();
      if (!cfg.enabled) return;
      const day = reportDayAt(now, cfg.at);
      if (!day) return;
      await ensureSchema();
      const ex = (await pool.query(`SELECT sms_sent_at FROM mk_daily_reports WHERE day=$1::date`, [day])).rows[0];
      if (ex && ex.sms_sent_at) return;
      if (!ex) await store(await compute(day));
      const r = await sendOnce(day);
      console.log(`[adsreport] ${day} stored; sms ${r.ok ? "sent" : JSON.stringify(r.skipped || r.error || r.errors)}`);
    } catch (e) {
      console.error("[adsreport] tick error:", e.message);
    } finally { running = false; }
  }

  app.get("/api/marketing/daily-report/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json({ ok: true, config: await config() });
  });
  app.put("/api/marketing/daily-report/config", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "bad json" }, 400); }
    const next = {
      enabled: b.enabled !== false,
      phones: staffPhones(b.phones).map((p) => `0${p}`),
      at: /^\d{1,2}:\d{2}$/.test(String(b.at)) ? String(b.at) : DEFAULT_CFG.at,
    };
    await pool.query(`UPDATE settings SET data = jsonb_set(COALESCE(data,'{}'::jsonb), '{adsReport}', $1::jsonb, true) WHERE id=1`, [JSON.stringify(next)]);
    return c.json({ ok: true, config: await config() });
  });

  app.get("/api/marketing/daily-report", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    await ensureSchema();
    const day = c.req.query("day");
    if (day) {
      if (!DAY_RE.test(day)) return c.json({ ok: false, error: "bad day" }, 400);
      if (c.req.query("live") === "1") return c.json({ ok: true, live: true, report: await compute(day) });
      const row = (await pool.query(`SELECT data, sms_sent_at, sms_to, sms_error FROM mk_daily_reports WHERE day=$1::date`, [day])).rows[0];
      return c.json({ ok: true, report: row ? row.data : null, sms: row ? { sentAt: row.sms_sent_at, to: row.sms_to, error: row.sms_error } : null });
    }
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 14));
    const rows = (await pool.query(`SELECT day, data, sms_sent_at, sms_error FROM mk_daily_reports ORDER BY day DESC LIMIT $1`, [days])).rows;
    return c.json({ ok: true, config: await config(), reports: rows.map((r) => ({ ...r.data, smsSentAt: r.sms_sent_at, smsError: r.sms_error })) });
  });

  app.post("/api/marketing/daily-report/run", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const day = DAY_RE.test(String(b.day || "")) ? b.day : previousBizDay();
    if (!day) return c.json({ ok: false, error: "bad day" }, 400);
    const rep = await compute(day);
    await store(rep);
    const sms = b.send ? await sendOnce(day, { force: b.force === true }) : null;
    return c.json({ ok: true, report: rep, sms });
  });

  if (process.env.ADS_REPORT_SCHEDULER !== "0") {
    setTimeout(() => { tick(); setInterval(() => tick(), 5 * 60_000); }, 90_000);
  }
  return { compute, store, sendOnce, tick, config };
}
