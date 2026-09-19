/* ═══════════════════════════════════════════════════════════════════════════
   MKHUB — «الحملات كلها في مكان واحد» (Omar, 19 Sep 2026)

   «حاول تخلي الحملات كلها بشكل مفصل… افصل بين كل منصة والتانية… اشوف
    الحملات بسهولة من مكان واحد، وتجيبلي النتايج اكثر غير الى بنشوفها في
    المنصة»

   One read-only report: platform/channel → campaign → ad set → ad, with the
   PLATFORM's own numbers (spend, impressions, clicks, its purchases) next to
   OUR numbers from first-party data (journey sessions, adds, checkouts, paid
   online orders, revenue, new vs returning) — never one replacing the other.

   Channels (families): meta · snapchat · tiktok · google · whatsapp · sms ·
   organic (unpaid social: bio/post/story) · offline (stickers/QR/POS display
   /print) · links (other /l/ campaign links) · direct.
   Hall orders the cashier tagged («من وين عرفتنا؟», order_sources) are
   attached per family too — WhatsApp/Instagram walk-ins never touch the site.

   Routes (admin, section growth):
     GET /api/mkhub/campaigns?range=today|yesterday|7d|14d|30d | from=&to=
     GET /api/mkhub/carts?range=…          abandoned-cart report (per cart)

   Spend alignment: when the reports-core module exposes a business-day aligned
   spend table (deps.alignedSpend(from,to) → {days:[{day, meta, snapchat,…}]})
   the platform TOTALS come from it and `spendSource` says so. Otherwise the
   platform read is used as-is: Meta's account day (America/Los_Angeles =
   10:00→10:00 Riyadh) equals our business day because ads only deliver
   12:30→02:30; Snap reads a Riyadh calendar day, so after-midnight spend of a
   single day lands on the next date (range totals are unaffected).

   Nothing here writes to any platform.
═══════════════════════════════════════════════════════════════════════════ */

import { PLAYBOOK, PLAYBOOK_VERSION, playbookPrompt, judgeAd, optimizationAdvice } from "./playbook.js";

const TZ = "Asia/Riyadh";
const NOT_PAID = ["pending_payment", "expired", "rejected_refunded", "refunded", "refund_failed", "cancelled", "canceled", "payment_failed", "failed", "unpaid"];
const TEST_COUPONS = ["OMAR-9X4T"];
const SNAP_FX = Number(process.env.SNAP_FX_SAR || 3.75); // Snap account bills in USD
const CACHE_MS = 5 * 60_000;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const lc = (s) => String(s ?? "").trim().toLowerCase();

export const FAMILIES = [
  { id: "meta", label: "ميتا (فيسبوك/انستجرام)", icon: "🟦", kind: "paid" },
  { id: "snapchat", label: "سناب شات", icon: "🟨", kind: "paid" },
  { id: "tiktok", label: "تيك توك", icon: "⬛", kind: "paid" },
  { id: "google", label: "جوجل (إعلانات + بحث وخرائط)", icon: "🟩", kind: "paid" },
  { id: "whatsapp", label: "واتساب", icon: "💬", kind: "paid" },
  { id: "sms", label: "رسايل SMS", icon: "✉️", kind: "owned" },
  { id: "organic", label: "سوشال مجاني (بايو/بوستات/ستوري)", icon: "📱", kind: "organic" },
  { id: "offline", label: "ستيكرات وQR وشاشة الكاشير", icon: "🏷", kind: "offline" },
  { id: "links", label: "روابط حملات تانية", icon: "🔗", kind: "owned" },
  { id: "direct", label: "مباشر / غير معروف", icon: "🧭", kind: "direct" },
];
const FAMILY_IDS = new Set(FAMILIES.map((f) => f.id));

/* ── business-day ranges (TabSense rolls at 04:00 Riyadh) ─────────────────── */
export function bizToday(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now.getTime() - 4 * 3600e3)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export function rangeOf(q = {}, now = new Date()) {
  if (DAY_RE.test(q.from || "") && DAY_RE.test(q.to || "") && q.from <= q.to) return { from: q.from, to: q.to, label: "custom" };
  const t = bizToday(now);
  const r = String(q.range || "7d");
  if (r === "today") return { from: t, to: t, label: r };
  if (r === "yesterday") return { from: shift(t, -1), to: shift(t, -1), label: r };
  const n = { "3d": 3, "7d": 7, "14d": 14, "30d": 30 }[r] || 7;
  return { from: shift(t, -(n - 1)), to: t, label: `${n}d` };
}

/* ── channel classification (pure; unit-tested) ───────────────────────────
   input: { utm_source, utm_medium, utm_campaign, utm_content, utm_term, channel, link_slug, attrib_source } */
const PAID_MEDIUM = /^(paid|paid_social|cpc|ppc|ads?|display|paidsocial)$/;
const ORGANIC_MEDIUM = /^(bio|post|story|stories|organic|social|reel|reels|profile|highlight)$/;
const OFFLINE_MEDIUM = /^(print|qr|sticker|pos|table|flyer|offline|display_screen|screen|menu)$/;
export function classify(x = {}) {
  const src = lc(x.utm_source), med = lc(x.utm_medium), ch = lc(x.channel), cont = lc(x.utm_content);
  const term = String(x.utm_term || "");
  const cls = lc(x.attrib_source);
  const plat = (s) => (["meta", "facebook", "instagram", "fb", "ig", "messenger"].includes(s) ? "meta"
    : ["snapchat", "snap", "sc"].includes(s) ? "snapchat"
    : ["tiktok", "tt"].includes(s) ? "tiktok"
    : ["google", "gads", "youtube", "adwords"].includes(s) ? "google" : null);
  // WhatsApp first: its ads are Meta money but its outcome is a chat/walk-in.
  if (src === "whatsapp" || ch === "whatsapp" || /^96-wa-/.test(cont) || /^fc-wa/.test(lc(x.utm_campaign))) return { family: "whatsapp", paid: med === "paid" };
  if (src === "sms" || ch === "sms" || med === "crm" || med === "sms" || cls === "sms") return { family: "sms", paid: false };
  if (OFFLINE_MEDIUM.test(med) || ["sticker", "qr", "pos", "print", "table"].includes(src) || /^sticker-|^qr-|^pos-/.test(cont) || cls === "offline") return { family: "offline", paid: false };
  const p = plat(src);
  if (p && ORGANIC_MEDIUM.test(med)) return { family: "organic", paid: false, platform: p };
  if (p && (PAID_MEDIUM.test(med) || /_ads$/.test(ch))) return { family: p, paid: true };
  if (/_ads$/.test(ch) && !ORGANIC_MEDIUM.test(med)) {
    const f = { meta: "meta", snap: "snapchat", snapchat: "snapchat", tiktok: "tiktok", google: "google" }[ch.replace(/_ads$/, "")];
    if (f) return { family: f, paid: true };
  }
  // in-app browser visits that lost their utm but kept Meta's {{ad.name}} tag
  if (!src && /^fc/i.test(term) && ["facebook", "instagram", "meta_ads", ""].includes(ch)) return { family: "meta", paid: true };
  if (["facebook", "instagram", "tiktok", "snapchat"].includes(ch) && !src) return { family: "organic", paid: false, platform: plat(ch) };
  if (p === "google" || ch === "google") return { family: "google", paid: false };
  if (p) return { family: "organic", paid: false, platform: p };
  if (ch === "campaign_link" || x.link_slug) return { family: "links", paid: false };
  if (["meta", "snapchat", "tiktok", "google"].includes(cls)) return { family: cls, paid: true };
  return { family: "direct", paid: false };
}

/* the key we match to a platform ad: Meta tags every link with
   utm_term={{ad.name}}, Snap puts its own BGID macro there (useless). */
export function adKeyOf(x = {}) {
  const term = String(x.utm_term || "").trim();
  if (term && !/^BGID_/i.test(term) && !/^\d{6,}$/.test(term)) return `ad:${term}`;
  const c = String(x.utm_content || "").trim();
  if (c && !/^\d{6,}$/.test(c)) return `content:${c}`;
  return null;
}
export function campaignKeyOf(x = {}) {
  const c = String(x.utm_campaign || "").trim();
  return c ? lc(c) : null;
}

/* match our utm_campaign to a platform campaign name/id */
export function campaignMatches(ourKey, camp) {
  if (!ourKey || !camp) return false;
  const n = lc(camp.name);
  if (ourKey === lc(camp.id) || ourKey === `id:${lc(camp.id)}`) return true;
  return n === ourKey || n.startsWith(ourKey) || n.replace(/-\d{4}-\d{2}$/, "") === ourKey;
}

const emptyOurs = () => ({ sessions: 0, adds: 0, checkouts: 0, payStarted: 0, orders: 0, revenue: 0, newCustomers: 0, returning: 0, hallOrders: 0, hallRevenue: 0 });
function addOurs(a, b) { for (const k of Object.keys(emptyOurs())) a[k] = r2(num(a[k]) + num(b[k])); return a; }
export function ratios(row) {
  const o = row.ours || emptyOurs();
  const spend = row.spend == null ? null : num(row.spend);
  return {
    cpa: spend != null && o.orders > 0 ? r2(spend / o.orders) : null,
    roas: spend ? r2(o.revenue / spend) : null,
    cpSession: spend != null && o.sessions > 0 ? r2(spend / o.sessions) : null,
    addRate: o.sessions ? r2((o.adds / o.sessions) * 100) : null,
    convRate: o.sessions ? r2((o.orders / o.sessions) * 100) : null,
    newShare: o.orders ? r2((o.newCustomers / o.orders) * 100) : null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════ */
export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin } = ctx;
  const late = (d) => (typeof d === "function" ? d() : d) || null;
  const cache = new Map();
  const cached = async (key, fn) => {
    const h = cache.get(key);
    if (h && Date.now() - h.at < CACHE_MS) return h.val;
    const val = await fn();
    cache.set(key, { at: Date.now(), val });
    if (cache.size > 60) cache.clear();
    return val;
  };
  const q = async (sql, args) => { try { return (await pool.query(sql, args)).rows; } catch (e) { console.error("[mkhub]", e.message); return null; } };

  /* ── OUR side ──────────────────────────────────────────────────────── */
  async function ourData(from, to) {
    const sessions = await q(`
      SELECT session_id, anon_id, biz_day::text AS day, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
             link_slug, channel, max_step, paid, order_no, cart_max
        FROM journey_sessions
       WHERE biz_day BETWEEN $1::date AND $2::date
         AND NOT COALESCE(is_bot,false) AND NOT COALESCE(is_qa,false) AND NOT COALESCE(is_staff,false)`, [from, to]) || [];
    const orders = await q(`
      SELECT o.order_no, o.total, o.phone_norm, o.created_at, o.attrib_source, o.attribution, o.coupon,
             s.utm_source s_src, s.utm_medium s_med, s.utm_campaign s_camp, s.utm_content s_cont, s.utm_term s_term,
             s.channel s_ch, s.link_slug s_slug,
             EXISTS (SELECT 1 FROM shop_orders p WHERE p.phone_norm = o.phone_norm AND p.created_at < o.created_at
                       AND NOT COALESCE(p.is_test,false) AND p.status <> ALL($3::text[])) AS prior_online,
             EXISTS (SELECT 1 FROM ts_customers c WHERE c.phone_norm = o.phone_norm AND c.first_order_at < o.created_at - interval '2 hours') AS prior_hall
        FROM shop_orders o LEFT JOIN journey_sessions s ON s.session_id = o.journey_sid
       WHERE ((o.created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date BETWEEN $1::date AND $2::date
         AND NOT COALESCE(o.is_test,false) AND o.status <> ALL($3::text[])
         AND COALESCE(upper(o.coupon),'') <> ALL($4::text[])`, [from, to, NOT_PAID, TEST_COUPONS]) || [];
    // hall/cashier «من وين عرفتنا؟» (walk-ins/calls never touch the site)
    const hall = await q(`
      SELECT lower(COALESCE(s.source,'')) AS source, count(*)::int n, COALESCE(sum(o.total),0) rev
        FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
       WHERE o.calendar_day BETWEEN $1::date AND $2::date
         AND s.source IS NOT NULL AND s.source NOT IN ('delivery_app','walkin','old_customer','friend','other','')
         AND (o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))
       GROUP BY 1`, [from, to]) || [];
    return { sessions, orders, hall };
  }

  function orderUtm(o) {
    const u = (o.attribution && o.attribution.utm) || {};
    return {
      utm_source: u.utm_source || o.s_src, utm_medium: u.utm_medium || o.s_med,
      utm_campaign: u.utm_campaign || o.s_camp, utm_content: u.utm_content || o.attribution?.fc_link || o.s_cont,
      utm_term: u.utm_term || o.s_term, utm_id: u.utm_id || null,
      channel: o.s_ch, link_slug: o.attribution?.fc_link || o.s_slug, attrib_source: o.attrib_source,
    };
  }

  /* bucket → family → campKey → adKey → ours */
  function aggregateOurs({ sessions, orders, hall }) {
    const tree = {};
    const node = (fam, camp, ad) => {
      tree[fam] ||= { ours: emptyOurs(), camps: {} };
      const f = tree[fam];
      const ck = camp || "_none";
      f.camps[ck] ||= { ours: emptyOurs(), ads: {}, utmIds: new Set() };
      const c = f.camps[ck];
      const ak = ad || "_none";
      c.ads[ak] ||= emptyOurs();
      return [f.ours, c.ours, c.ads[ak], c];
    };
    for (const s of sessions) {
      const { family } = classify(s);
      const d = { ...emptyOurs(), sessions: 1, adds: s.max_step >= 2 ? 1 : 0, checkouts: s.max_step >= 3 ? 1 : 0, payStarted: s.max_step >= 6 ? 1 : 0 };
      for (const t of node(family, campaignKeyOf(s), adKeyOf(s)).slice(0, 3)) addOurs(t, d);
    }
    for (const o of orders) {
      const u = orderUtm(o);
      const { family } = classify(u);
      const isNew = !o.prior_online && !o.prior_hall;
      const d = { ...emptyOurs(), orders: 1, revenue: num(o.total), newCustomers: isNew ? 1 : 0, returning: isNew ? 0 : 1 };
      const n = node(family, campaignKeyOf(u), adKeyOf(u));
      for (const t of n.slice(0, 3)) addOurs(t, d);
      if (u.utm_id) n[3].utmIds.add(String(u.utm_id));
    }
    const HALL_MAP = { facebook: "meta", instagram: "meta", meta: "meta", tiktok: "tiktok", snapchat: "snapchat", google_maps: "google", google: "google", whatsapp: "whatsapp", influencer: "organic", sms: "sms", qr: "offline", sticker: "offline" };
    for (const h of hall) {
      const fam = HALL_MAP[h.source] || null;
      if (!fam) continue;
      tree[fam] ||= { ours: emptyOurs(), camps: {} };
      tree[fam].ours.hallOrders += h.n; tree[fam].ours.hallRevenue = r2(tree[fam].ours.hallRevenue + num(h.rev));
      tree[fam].hallBySource = { ...(tree[fam].hallBySource || {}), [h.source]: { orders: h.n, revenue: r2(h.rev) } };
    }
    return tree;
  }

  /* ── PLATFORM side ─────────────────────────────────────────────────── */
  async function metaRead(from, to) {
    return cached(`meta|${from}|${to}`, async () => {
      const out = { ok: false, reason: null, ads: [], campaigns: [], adsets: [] };
      try {
        const ads = await import("./ads.js");
        const p = ads.byId ? ads.byId("meta") : null;
        if (!p || !ads.canManage(p)) { out.reason = "ميتا مش مربوطة"; return out; }
        const token = (process.env.META_CAPI_TOKEN || "").trim();
        const act = p.actId();
        const H = { headers: { Authorization: `Bearer ${token}` } };
        const rd = (url) => (typeof ads.platformRead === "function" ? ads.platformRead(p, () => ads.httpJson(url, H), { priority: "owner" }) : ads.httpJson(url, H));
        const tr = encodeURIComponent(JSON.stringify({ since: from, until: to }));
        const f = "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,objective,spend,impressions,reach,frequency,inline_link_clicks,actions,action_values";
        const [ins, camps, sets] = await Promise.all([
          rd(`${p.base()}/${act}/insights?level=ad&fields=${f}&time_range=${tr}&limit=500`),
          rd(`${p.base()}/${act}/campaigns?fields=id,name,effective_status,objective,daily_budget,lifetime_budget&limit=200`),
          rd(`${p.base()}/${act}/adsets?fields=id,name,campaign_id,effective_status,daily_budget,lifetime_budget,optimization_goal,end_time&limit=300`),
        ]);
        if (!ins || ins.ok === false || !ins.json) { out.reason = ins?.reason || ins?.error || ins?.json?.error?.message || "قراءة ميتا فشلت"; return out; }
        const act1 = (arr, types) => { for (const t of types) { const a = (arr || []).find((x) => x.action_type === t); if (a) return num(a.value); } return 0; };
        out.ads = (ins.json.data || []).map((r) => ({
          adId: r.ad_id, ad: r.ad_name, adsetId: r.adset_id, adset: r.adset_name, campaignId: r.campaign_id, campaign: r.campaign_name, objective: r.objective,
          spend: r2(r.spend), impressions: num(r.impressions), reach: num(r.reach), frequency: r2(r.frequency), clicks: num(r.inline_link_clicks),
          atc: act1(r.actions, ["offsite_conversion.fb_pixel_add_to_cart", "add_to_cart", "omni_add_to_cart"]),
          checkouts: act1(r.actions, ["offsite_conversion.fb_pixel_initiate_checkout", "initiate_checkout", "omni_initiated_checkout"]),
          purchases: act1(r.actions, ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"]),
          purchaseValue: act1(r.action_values, ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"]),
          conversations: act1(r.actions, ["onsite_conversion.messaging_conversation_started_7d"]),
        }));
        out.campaigns = camps?.json?.data || [];
        out.adsets = sets?.json?.data || [];
        out.ok = true;
      } catch (e) { out.reason = String(e.message || e).slice(0, 200); }
      return out;
    });
  }

  async function adapterRead(platformId, from, to) {
    return cached(`${platformId}|${from}|${to}`, async () => {
      try {
        const ads = await import("./ads.js");
        const p = ads.byId ? ads.byId(platformId) : null;
        if (!p) return { ok: false, reason: "مش مدعومة" };
        if (!ads.canManage(p)) return { ok: false, reason: `غير مربوطة — ناقص ${ads.missingOf(p.manageEnv).join(", ") || "صلاحيات"}` };
        const [camps, ins] = await Promise.all([p.campaigns().catch((e) => ({ ok: false, reason: e.message })), p.insights({ from, to }).catch((e) => ({ ok: false, reason: e.message }))]);
        if (!ins?.ok && !camps?.ok) return { ok: false, reason: ins?.reason || camps?.reason || "قراءة فشلت" };
        return { ok: true, campaigns: camps?.ok ? camps.campaigns : [], rows: ins?.ok ? ins.rows : [], reason: ins?.ok ? null : ins?.reason };
      } catch (e) { return { ok: false, reason: String(e.message || e).slice(0, 200) }; }
    });
  }

  async function smsCosts(from, to) {
    const rows = await q(`
      SELECT c.id, c.name, c.message, c.status, count(s.*)::int sent_all, COALESCE(sum(s.cost),0) cost_all,
             count(s.*) FILTER (WHERE ((s.created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date BETWEEN $1::date AND $2::date)::int sent,
             COALESCE(sum(s.cost) FILTER (WHERE ((s.created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date BETWEEN $1::date AND $2::date),0) cost
        FROM cms_campaigns c LEFT JOIN cms_campaign_sends s ON s.campaign_id = c.id AND s.status NOT IN ('failed','error','holdout','skipped')
       WHERE c.channel = 'sms' AND COALESCE(c.sent_at, c.scheduled_at, c.created_at) >= ($1::date - 3)
         AND COALESCE(c.sent_at, c.scheduled_at, c.created_at) < ($2::date + 2)
       GROUP BY 1,2,3,4 ORDER BY 1`, [from, to]);
    return (rows || []).map((r) => ({ id: r.id, name: r.name, status: r.status, sent: r.sent, cost: r2(r.cost), sentAll: r.sent_all, costAll: r2(r.cost_all), slugs: [...String(r.message || "").matchAll(/\/l\/([a-z0-9-]+)/gi)].map((m) => lc(m[1])) }));
  }

  /* ── assemble ──────────────────────────────────────────────────────── */
  async function campaignsReport(range) {
    const { from, to } = range;
    const [ourRaw, meta, snap, tiktok, google, sms, aligned] = await Promise.all([
      ourData(from, to), metaRead(from, to), adapterRead("snapchat", from, to), adapterRead("tiktok", from, to), adapterRead("google", from, to), smsCosts(from, to),
      (async () => { try { const f = late(deps.alignedSpend); return f ? await f(from, to) : null; } catch { return null; } })(),
    ]);
    const ours = aggregateOurs(ourRaw);
    /* in-app visits that kept only Meta's {{ad.name}} (no utm_campaign): move
       them under the campaign that owns that ad name, so they are not orphans */
    if (meta.ok) {
      const adCamp = new Map(meta.ads.map((a) => [a.ad, String(a.campaignId)]));
      for (const fam of ["meta", "whatsapp"]) {
        const none = ours[fam]?.camps?._none;
        if (!none) continue;
        for (const [ak, v] of Object.entries(none.ads)) {
          const cid = ak.startsWith("ad:") ? adCamp.get(ak.slice(3)) : null;
          if (!cid) continue;
          const key = `id:${cid}`;
          const dst = (ours[fam].camps[key] ||= { ours: emptyOurs(), ads: {}, utmIds: new Set() });
          dst.ads[ak] = addOurs(dst.ads[ak] || emptyOurs(), v);
          addOurs(dst.ours, v);
          for (const k of Object.keys(none.ours)) none.ours[k] = r2(num(none.ours[k]) - num(v[k]));
          delete none.ads[ak];
        }
        if (!Object.keys(none.ads).length) delete ours[fam].camps._none;
      }
    }
    const takeOurs = (fam) => ours[fam] || { ours: emptyOurs(), camps: {} };
    const used = new Set(); // `${fam}|${campKey}` consumed by a platform campaign
    const families = [];

    /* META (+ WhatsApp campaigns split out) */
    const metaFam = { id: "meta", spend: 0, platform: { impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0, atc: 0 }, campaigns: [], reason: meta.ok ? null : meta.reason };
    const waFam = { id: "whatsapp", spend: 0, platform: { impressions: 0, clicks: 0, conversations: 0 }, campaigns: [], reason: null };
    if (meta.ok) {
      const campInfo = new Map(meta.campaigns.map((c) => [String(c.id), c]));
      const setInfo = new Map(meta.adsets.map((s) => [String(s.id), s]));
      const byCamp = new Map();
      for (const a of meta.ads) {
        const c = byCamp.get(a.campaignId) || { id: a.campaignId, name: a.campaign, objective: a.objective, ads: [] };
        c.ads.push(a); byCamp.set(a.campaignId, c);
      }
      // live campaigns with no delivery in range still deserve a row
      for (const c of meta.campaigns) if (c.effective_status === "ACTIVE" && !byCamp.has(String(c.id))) byCamp.set(String(c.id), { id: String(c.id), name: c.name, objective: c.objective, ads: [] });
      const isWaCamp = (c) => /whatsapp|wa-|walkin/i.test(c.name) || (/ENGAGEMENT|MESSAGES/.test(c.objective || "") && !/SALES/.test(c.objective || ""));
      const waCount = [...byCamp.values()].filter((c) => isWaCamp(c) && c.ads.some((a) => a.spend > 0)).length;
      for (const c of byCamp.values()) {
        const info = campInfo.get(String(c.id)) || {};
        const isWa = isWaCamp(c);
        const fam = isWa ? "whatsapp" : "meta";
        const O = takeOurs(fam);
        let campKeys = Object.keys(O.camps).filter((k) => campaignMatches(k, c) || O.camps[k].utmIds?.has(String(c.id)));
        /* WhatsApp links carry our own tag (fc-wa-walkin / 96-wa-*), not the Meta
           campaign name. With one WhatsApp campaign running they are its visits. */
        if (isWa && waCount === 1 && c.ads.some((a) => a.spend > 0)) campKeys = [...new Set([...campKeys, ...Object.keys(O.camps).filter((k) => k !== "_none" && !used.has(`whatsapp|${k}`))])];
        const campOurs = emptyOurs();
        for (const k of campKeys) { addOurs(campOurs, O.camps[k].ours); used.add(`${fam}|${k}`); }
        const adsetMap = new Map();
        for (const a of c.ads) {
          const s = adsetMap.get(a.adsetId) || { id: a.adsetId, name: a.adset, ads: [], spend: 0 };
          s.ads.push(a); s.spend = r2(s.spend + a.spend); adsetMap.set(a.adsetId, s);
        }
        // assign our ad-level buckets inside the matched campaigns
        const adOurs = new Map(); const claimed = new Set();
        for (const k of campKeys) for (const [ak, v] of Object.entries(O.camps[k].ads)) {
          if (ak === "_none") continue;
          const [kind, val] = [ak.slice(0, ak.indexOf(":")), ak.slice(ak.indexOf(":") + 1)];
          const hit = kind === "ad" ? c.ads.filter((a) => a.ad === val)
            : c.ads.filter((a) => lc(a.ad).endsWith(lc(val)));
          if (hit.length === 1) { const cur = adOurs.get(hit[0].adId) || emptyOurs(); adOurs.set(hit[0].adId, addOurs(cur, v)); claimed.add(`${k}|${ak}`); }
        }
        const unassigned = emptyOurs();
        for (const k of campKeys) for (const [ak, v] of Object.entries(O.camps[k].ads)) if (!claimed.has(`${k}|${ak}`)) addOurs(unassigned, v);
        const adsets = [...adsetMap.values()].map((s) => {
          const si = setInfo.get(String(s.id)) || {};
          const sOurs = emptyOurs();
          const adsRows = s.ads.map((a) => {
            const o = adOurs.get(a.adId) || emptyOurs(); addOurs(sOurs, o);
            const row = { id: a.adId, name: a.ad, spend: a.spend, platform: { impressions: a.impressions, reach: a.reach, frequency: a.frequency, clicks: a.clicks, ctr: a.impressions ? r2((a.clicks / a.impressions) * 100) : null, cpc: a.clicks ? r2(a.spend / a.clicks) : null, atc: a.atc, checkouts: a.checkouts, purchases: a.purchases, purchaseValue: a.purchaseValue, conversations: a.conversations }, ours: o };
            return { ...row, ...ratios(row) };
          }).sort((x, y) => y.spend - x.spend);
          const row = { id: s.id, name: s.name, status: si.effective_status || null, optimization: si.optimization_goal || null,
            budget: si.daily_budget ? { daily: num(si.daily_budget) / 100 } : si.lifetime_budget ? { lifetime: num(si.lifetime_budget) / 100, endTime: si.end_time || null } : null,
            spend: s.spend, ours: sOurs, ads: adsRows,
            platform: adsRows.reduce((acc, a) => { for (const k of ["impressions", "clicks", "atc", "checkouts", "purchases", "purchaseValue", "conversations"]) acc[k] = r2(num(acc[k]) + num(a.platform[k])); return acc; }, {}) };
          return { ...row, ...ratios(row) };
        }).sort((x, y) => y.spend - x.spend);
        const spend = r2(c.ads.reduce((s0, a) => s0 + a.spend, 0));
        const platform = adsets.reduce((acc, a) => { for (const k of Object.keys(a.platform)) acc[k] = r2(num(acc[k]) + num(a.platform[k])); return acc; }, {});
        const row = { id: c.id, name: c.name, status: info.effective_status || null, objective: c.objective || info.objective || null,
          budget: info.daily_budget ? { daily: num(info.daily_budget) / 100 } : info.lifetime_budget ? { lifetime: num(info.lifetime_budget) / 100 } : null,
          spend, platform, ours: campOurs, unassignedOurs: unassigned, adsets, ourKeys: campKeys };
        const F = isWa ? waFam : metaFam;
        F.campaigns.push({ ...row, ...ratios(row) });
        F.spend = r2(F.spend + spend);
        for (const k of Object.keys(platform)) F.platform[k] = r2(num(F.platform[k]) + num(platform[k]));
      }
    }
    families.push(metaFam, waFam);

    /* SNAP / TIKTOK / GOOGLE — campaign level via the shared adapters */
    const adapterFam = (id, read, fx = 1) => {
      const F = { id, spend: 0, platform: { impressions: 0, clicks: 0, purchases: 0 }, campaigns: [], reason: read.ok ? read.reason || null : read.reason };
      if (!read.ok) return F;
      const stats = new Map((read.rows || []).map((r) => [String(r.campaignId), r]));
      const O = takeOurs(id);
      const list = new Map();
      for (const c of read.campaigns || []) list.set(String(c.id), { id: String(c.id), name: c.name, status: c.effectiveStatus || c.status, budget: c.dailyBudget != null ? { daily: r2(num(c.dailyBudget) * fx) } : null });
      for (const r of read.rows || []) if (!list.has(String(r.campaignId))) list.set(String(r.campaignId), { id: String(r.campaignId), name: r.campaignName, status: null, budget: null });
      for (const c of list.values()) {
        const s = stats.get(c.id);
        const spend = s ? r2(num(s.spend) * fx) : 0;
        if (!spend && !/ACTIVE/i.test(String(c.status || ""))) continue;
        const campKeys = Object.keys(O.camps).filter((k) => campaignMatches(k, c));
        const campOurs = emptyOurs();
        const byContent = [];
        for (const k of campKeys) {
          addOurs(campOurs, O.camps[k].ours); used.add(`${id}|${k}`);
          for (const [ak, v] of Object.entries(O.camps[k].ads)) byContent.push({ key: ak === "_none" ? "(بدون وسم)" : ak.replace(/^(ad|content):/, ""), ours: v });
        }
        const row = { id: c.id, name: c.name, status: c.status, budget: c.budget, spend,
          platform: s ? { impressions: num(s.impressions), clicks: num(s.clicks), purchases: num(s.resultBasis?.purchase ?? s.results ?? 0), purchaseValue: r2(num(s.resultValue) * fx) } : {},
          ours: campOurs, adsets: [], byContent, ourKeys: campKeys };
        F.campaigns.push({ ...row, ...ratios(row) });
        F.spend = r2(F.spend + spend);
        for (const k of ["impressions", "clicks", "purchases"]) F.platform[k] = r2(num(F.platform[k]) + num(row.platform[k]));
      }
      return F;
    };
    families.push(adapterFam("snapchat", snap, SNAP_FX), adapterFam("tiktok", tiktok), adapterFam("google", google));

    /* every family: leftover OUR campaigns that no platform campaign claimed */
    const smsBySlug = new Map();
    for (const c of sms) for (const s of c.slugs) smsBySlug.set(s, c);
    for (const f of FAMILIES) {
      let F = families.find((x) => x.id === f.id);
      if (!F) { F = { id: f.id, spend: null, platform: null, campaigns: [], reason: null }; families.push(F); }
      const O = takeOurs(f.id);
      for (const [k, v] of Object.entries(O.camps)) {
        if (used.has(`${f.id}|${k}`)) continue;
        const byContent = Object.entries(v.ads).map(([ak, o]) => ({ key: ak === "_none" ? "(بدون وسم)" : ak.replace(/^(ad|content):/, ""), ours: o })).sort((a, b) => b.ours.sessions - a.ours.sessions);
        let spend = null, extra = null;
        if (f.id === "sms") {
          const hits = [...new Set(byContent.map((b) => smsBySlug.get(lc(b.key))).filter(Boolean))];
          if (hits.length) { spend = r2(hits.reduce((s0, h) => s0 + h.cost, 0)); extra = { smsCampaigns: hits.map((h) => ({ id: h.id, name: h.name, sent: h.sent, cost: h.cost, sentAll: h.sentAll, costAll: h.costAll, status: h.status })), costNote: "الصرف = تكلفة الرسايل اللي اتبعتت جوّه الفترة؛ الإجمالي من أول الحملة في costAll" }; }
        }
        const row = { id: `ours:${k}`, name: k === "_none" ? "(من غير اسم حملة)" : k, status: null, spend, platform: null, ours: v.ours, adsets: [], byContent, ourOnly: true, ...(extra || {}) };
        F.campaigns.push({ ...row, ...ratios(row) });
        if (spend != null) F.spend = r2(num(F.spend) + spend);
      }
      F.ours = O.ours; if (O.hallBySource) F.hallBySource = O.hallBySource;
      F.campaigns.sort((a, b) => num(b.spend) - num(a.spend) || b.ours.sessions - a.ours.sessions);
    }

    /* aligned spend (reports-core) overrides platform totals when present */
    let spendSource = "platform";
    if (aligned && Array.isArray(aligned.days)) {
      spendSource = "aligned";
      for (const F of families) {
        const tot = aligned.days.reduce((s0, d) => s0 + (d[F.id] == null ? 0 : num(d[F.id])), 0);
        if (aligned.days.some((d) => d[F.id] != null) && F.id !== "whatsapp") F.alignedSpend = r2(F.id === "meta" ? tot - num(waFam.spend) : tot);
      }
    }

    const out = families.map((F) => {
      const def = FAMILIES.find((f) => f.id === F.id) || {};
      const row = { ...def, ...F, spend: F.alignedSpend ?? F.spend };
      return { ...row, ...ratios(row) };
    }).sort((a, b) => FAMILIES.findIndex((f) => f.id === a.id) - FAMILIES.findIndex((f) => f.id === b.id));
    const totals = out.reduce((acc, F) => { acc.spend = r2(acc.spend + num(F.spend)); addOurs(acc.ours, F.ours || emptyOurs()); return acc; }, { spend: 0, ours: emptyOurs() });
    const paidOurs = out.filter((F) => F.kind === "paid").reduce((acc, F) => addOurs(acc, F.ours || emptyOurs()), emptyOurs());
    return {
      ok: true, range, generatedAt: new Date().toISOString(), spendSource,
      spendNote: spendSource === "aligned" ? "الصرف من جدول الصرف المتطابق مع يوم المطعم (١١:٠٠ → ٠٣:٠٠)."
        : "ميتا: يوم الحساب (لوس أنجلوس = ١٠:٠٠→١٠:٠٠ الرياض) = يوم المطعم لأن الإعلانات بتشتغل ١٢:٣٠→٠٢:٣٠ بس. سناب: يوم الرياض الميلادي (صرف بعد نص الليل بيروح لليوم اللي بعده). سناب بالدولار × " + SNAP_FX + ".",
      totals: { ...totals, ...ratios(totals), paid: { spend: r2(out.filter((F) => F.kind === "paid").reduce((s0, F) => s0 + num(F.spend), 0)), ours: paidOurs } },
      families: out,
      notes: [
        "«منصتهم» = اللي المنصة بتقوله عن نفسها (بتنسب لنفسها أي شرا بعد مشاهدة/نقرة). «عندنا» = طلبات مدفوعة فعلاً في المتجر اتربطت بالرابط/الجلسة.",
        "جديد = أول طلب ليه معانا خالص (لا أونلاين قبل كده ولا عميل صالة مسجّل). راجع = اشترى قبل كده.",
        "طلبات الصالة = اللي الكاشير سجّلها في «من وين عرفتنا؟» — مالهاش جلسة على الموقع.",
        "الطلبات التجريبية (is_test وكوبون المالك) والموظفين والزحّافات وجلسات QA متشالة.",
      ],
    };
  }

  /* ═══ ABANDONED CARTS — every cart, what happened to it ═══════════════
     A "cart" = one visitor (anon id) on one business day who added at least
     one item and did not pay that day. We follow it: the furthest step, the
     cart value, the recovery flow (SMS/push sent → link opened → order), a
     later purchase within 72h by the same device or phone, and retargeting
     exposure (came back through a paid retargeting link afterwards). */
  const STEP_LABEL = { 2: "أضاف للسلة", 3: "فتح الدفع/السلة", 4: "حط العنوان", 5: "أكّد الجوال (OTP)", 6: "وصل لصفحة الدفع", 7: "دفع" };
  async function cartsReport(range) {
    const { from, to } = range;
    const rows = await q(`
      WITH s AS (
        SELECT anon_id, biz_day, min(started_at) AS first_at, max(last_seen_at) AS last_at, max(max_step) AS step,
               max(cart_max) AS cart, bool_or(paid) AS paid_same_day,
               (array_agg(channel ORDER BY started_at))[1] AS channel,
               (array_agg(utm_campaign ORDER BY started_at))[1] AS campaign,
               (array_agg(utm_content ORDER BY started_at))[1] AS content,
               max(phone_norm) AS phone, bool_or(in_app IS NOT NULL AND in_app <> '') AS in_app,
               max(device) AS device
          FROM journey_sessions
         WHERE biz_day BETWEEN $1::date AND $2::date AND anon_id IS NOT NULL
           AND NOT COALESCE(is_bot,false) AND NOT COALESCE(is_qa,false) AND NOT COALESCE(is_staff,false)
         GROUP BY anon_id, biz_day
      )
      SELECT s.*,
        (SELECT row_to_json(r) FROM (
           SELECT cr.code, cr.step1_channel, cr.step1_at, cr.step2_channel, cr.step2_at, cr.opened_at, cr.open_count, cr.order_no, cr.order_total, cr.step1_cost, cr.step2_cost
             FROM cart_recovery cr
            WHERE (cr.device_id = s.anon_id OR (s.phone IS NOT NULL AND cr.phone_norm = s.phone))
              AND cr.started_at BETWEEN s.first_at - interval '1 hour' AND s.last_at + interval '2 days'
            ORDER BY cr.started_at LIMIT 1) r) AS recovery,
        (SELECT c.rec_note FROM shop_carts c WHERE c.device_id = s.anon_id ORDER BY c.updated_at DESC LIMIT 1) AS rec_note,
        (SELECT row_to_json(x) FROM (
           SELECT j.order_no, j.revenue, j.started_at, j.channel, j.utm_campaign
             FROM journey_sessions j
            WHERE j.anon_id = s.anon_id AND j.paid AND j.started_at > s.last_at AND j.started_at < s.last_at + interval '72 hours'
            ORDER BY j.started_at LIMIT 1) x) AS later_paid_device,
        (SELECT row_to_json(y) FROM (
           SELECT o.order_no, o.total, o.created_at
             FROM shop_orders o
            WHERE s.phone IS NOT NULL AND o.phone_norm = s.phone AND NOT COALESCE(o.is_test,false) AND o.status <> ALL($3::text[])
              AND o.created_at > s.last_at AND o.created_at < s.last_at + interval '72 hours'
            ORDER BY o.created_at LIMIT 1) y) AS later_paid_phone,
        (SELECT count(*)::int FROM journey_sessions j
          WHERE j.anon_id = s.anon_id AND j.started_at > s.last_at AND j.started_at < s.last_at + interval '7 days'
            AND (lower(COALESCE(j.utm_campaign,'')) LIKE '%rt%' OR lower(COALESCE(j.utm_campaign,'')) LIKE '%retarget%')) AS rt_returns,
        (SELECT count(*)::int FROM journey_sessions j
          WHERE j.anon_id = s.anon_id AND j.started_at > s.last_at AND j.started_at < s.last_at + interval '7 days') AS returns
        FROM s
       WHERE s.step >= 2 AND NOT COALESCE(s.paid_same_day,false)
       ORDER BY s.first_at DESC
       LIMIT 1500`, [from, to, NOT_PAID]);
    if (!rows) return { ok: false, error: "قراءة السلات فشلت" };
    const carts = rows.map((r) => {
      const rec = r.recovery || null;
      const later = r.later_paid_phone ? { orderNo: r.later_paid_phone.order_no, total: r2(r.later_paid_phone.total), via: "phone" }
        : r.later_paid_device ? { orderNo: r.later_paid_device.order_no, total: r2(r.later_paid_device.revenue), via: "device", channel: r.later_paid_device.channel, campaign: r.later_paid_device.utm_campaign } : null;
      const recoveredBy = rec?.order_no ? "sms" : later && r.rt_returns > 0 && later.via === "device" && /rt/i.test(later.campaign || "") ? "retargeting" : later ? "came_back" : null;
      const why = !r.phone ? "مفيش جوال (ما وصلش لخطوة OTP) — الاسترجاع بالرسايل مستحيل، الريتارجت بس"
        : rec ? null : r.rec_note === "step1_window_missed" ? "فات ميعاد الخطوة الأولى" : "مادخلش فلو الاسترجاع (شروط: جوال متأكّد + مفيش فلو خلال ٧ أيام + ساعات الهدوء)";
      return {
        day: r.biz_day?.toISOString ? r.biz_day.toISOString().slice(0, 10) : String(r.biz_day).slice(0, 10),
        at: r.first_at, step: r.step, stepLabel: STEP_LABEL[r.step] || String(r.step), cart: r2(r.cart),
        channel: r.channel, campaign: r.campaign, content: r.content, family: classify({ channel: r.channel, utm_campaign: r.campaign, utm_content: r.content }).family,
        device: r.device, inApp: r.in_app, hasPhone: Boolean(r.phone),
        recovery: rec ? { step1: rec.step1_at ? { channel: rec.step1_channel, at: rec.step1_at } : null, step2: rec.step2_at ? { channel: rec.step2_channel, at: rec.step2_at } : null,
          opened: Boolean(rec.opened_at), opens: rec.open_count || 0, orderNo: rec.order_no || null, orderTotal: r2(rec.order_total), cost: r2(num(rec.step1_cost) + num(rec.step2_cost)) } : null,
        noRecoveryWhy: why, returns: r.returns, rtReturns: r.rt_returns, laterPaid: later, recoveredBy,
      };
    });
    const T = { carts: carts.length, value: 0, byStep: {}, withPhone: 0, smsSent: 0, smsOpened: 0, smsOrdered: 0, smsRevenue: 0, smsCost: 0, cameBack: 0, rtReturned: 0, recovered: 0, recoveredRevenue: 0, byFamily: {} };
    for (const c of carts) {
      T.value = r2(T.value + c.cart);
      T.byStep[c.step] = (T.byStep[c.step] || 0) + 1;
      if (c.hasPhone) T.withPhone++;
      if (c.recovery?.step1 || c.recovery?.step2) T.smsSent++;
      if (c.recovery?.opened) T.smsOpened++;
      if (c.recovery?.orderNo) { T.smsOrdered++; T.smsRevenue = r2(T.smsRevenue + c.recovery.orderTotal); }
      if (c.recovery) T.smsCost = r2(T.smsCost + c.recovery.cost);
      if (c.returns > 0) T.cameBack++;
      if (c.rtReturns > 0) T.rtReturned++;
      if (c.laterPaid || c.recovery?.orderNo) { T.recovered++; T.recoveredRevenue = r2(T.recoveredRevenue + (c.recovery?.orderNo ? c.recovery.orderTotal : c.laterPaid.total)); }
      const f = (T.byFamily[c.family] ||= { carts: 0, value: 0, recovered: 0 });
      f.carts++; f.value = r2(f.value + c.cart); if (c.laterPaid || c.recovery?.orderNo) f.recovered++;
    }
    return { ok: true, range, totals: T, stepLabels: STEP_LABEL, carts: carts.slice(0, 400),
      notes: [
        "السلة = زائر واحد في يوم عمل واحد ضاف صنف ومادفعش نفس اليوم.",
        "«رجع ودفع» = نفس الجهاز أو نفس الجوال دفع خلال ٧٢ ساعة. «من الريتارجت» = رجع من رابط حملة ريتارجت (fc-rt…).",
        "الجهاز بيتعرف بـ fc_dev: لو العميل غيّر المتصفح (من جوّه انستجرام لسفاري مثلاً) مش هنعرف إنه نفس الشخص إلا لو أكّد جواله.",
      ] };
  }

  /* ── playbook verdicts: every live ad judged on OUR paid orders ─────── */
  async function dailyPaidOrders(days = 7) {
    const rows = await q(`
      SELECT ((created_at AT TIME ZONE '${TZ}') - interval '4 hours')::date::text d, count(*)::int n
        FROM shop_orders WHERE NOT COALESCE(is_test,false) AND status <> ALL($1::text[])
         AND COALESCE(upper(coupon),'') <> ALL($2::text[])
         AND created_at > now() - ($3 || ' days')::interval
       GROUP BY 1 ORDER BY 1`, [NOT_PAID, TEST_COUPONS, String(days + 1)]) || [];
    const today = bizToday();
    return rows.filter((r) => r.d < today); // finished days only
  }
  async function adVerdicts(rangeQ = { range: "3d" }) {
    const range = rangeOf(rangeQ);
    const rep = await cached(`rep|${range.from}|${range.to}`, () => campaignsReport(range));
    const ads = [];
    for (const F of rep.families) {
      for (const c of F.campaigns || []) {
        if (c.ourOnly) continue;
        const leaves = (c.adsets || []).flatMap((s) => s.ads.map((a) => ({ ...a, adset: s.name, adsetStatus: s.status })));
        const rows = leaves.length ? leaves : [{ id: c.id, name: c.name, spend: c.spend, platform: c.platform || {}, ours: c.ours, level: "campaign" }];
        for (const a of rows) {
          if (!num(a.spend) && !a.ours?.sessions) continue;
          const j = judgeAd({ spend: a.spend, impressions: a.platform?.impressions, clicks: a.platform?.clicks, atc: a.platform?.atc ?? a.ours?.adds, frequency: a.platform?.frequency, ourOrders: a.ours?.orders });
          // WhatsApp ads bring walk-ins the site never sees - never "kill" them on online orders
          const verdict = F.id === "whatsapp" && j.verdict === "kill" ? { verdict: "keep", text: "واتساب: الحكم بالمحادثات و«من وين عرفتنا؟» مش بطلبات الموقع." } : j;
          ads.push({ family: F.id, campaign: c.name, adset: a.adset || null, ad: a.name, level: a.level || "ad", spend: r2(a.spend), impressions: a.platform?.impressions ?? null,
            ctr: a.platform?.impressions ? r2((num(a.platform.clicks) / num(a.platform.impressions)) * 100) : null, frequency: a.platform?.frequency ?? null,
            platformPurchases: a.platform?.purchases ?? null, ourSessions: a.ours?.sessions || 0, ourAdds: a.ours?.adds || 0, ourOrders: a.ours?.orders || 0, ourRevenue: a.ours?.revenue || 0,
            cpa: a.ours?.orders ? r2(num(a.spend) / a.ours.orders) : null, ...verdict });
        }
      }
    }
    const daily = await dailyPaidOrders(7);
    return { range, ads: ads.sort((x, y) => y.spend - x.spend), optimization: optimizationAdvice(daily.map((d) => d.n)), dailyPaidOrders: daily, spendSource: rep.spendSource };
  }

  app.get("/api/mkhub/playbook", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let live = null;
    try { live = await adVerdicts({ range: c.req.query("range") || "3d" }); } catch (e) { live = { error: String(e.message || e) }; }
    return c.json({ ok: true, version: PLAYBOOK_VERSION, playbook: PLAYBOOK, prompt: playbookPrompt(), live });
  });

  app.get("/api/mkhub/campaigns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const range = rangeOf(c.req.query());
    try { return c.json(await cached(`rep|${range.from}|${range.to}`, () => campaignsReport(range))); }
    catch (e) { console.error("[mkhub] campaigns", e); return c.json({ ok: false, error: String(e.message || e) }); }
  });
  app.get("/api/mkhub/carts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const range = rangeOf({ range: "7d", ...c.req.query() });
    try { return c.json(await cached(`carts|${range.from}|${range.to}`, () => cartsReport(range))); }
    catch (e) { console.error("[mkhub] carts", e); return c.json({ ok: false, error: String(e.message || e) }); }
  });

  return { campaignsReport, cartsReport, rangeOf, adVerdicts, dailyPaidOrders };
}
