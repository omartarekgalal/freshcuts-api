/* ═══════════════════════════════════════════════════════════════════════════
   AUDIENCES — the retargeting spine (Meta / TikTok / Snapchat).

   Two halves that must not be confused with each other:

   ┌─ HALF ONE — first-party customer lists (the original module) ───────────
   │  Segments built from the restaurant's OWN order data, SHA-256 hashed and
   │  pushed to each platform as CUSTOM audiences.
   │  Sizes: 604 / 92 / 141 / 310 / 155 phones (2026-08-13).
   │  These are TOO SMALL TO TARGET. They are exclusions and lookalike seeds.
   │
   └─ HALF TWO — platform-side behaviour audiences (added 2026-08-14) ───────
      WEBSITE audiences built off the pixel, ENGAGEMENT/IG audiences built off
      the page, and LOOKALIKEs seeded from half one. These are the ones with
      real reach, and they are what a retargeting campaign actually targets.

   ── THE MEASUREMENT BUG THAT COST THIS ACCOUNT A QUARTER ──────────────────
   `approximate_count_lower_bound` is NOT the size of a WEBSITE audience.
   Meta returns the sentinel **20** for every pixel-rule audience regardless
   of how many people are in it, and **1000** as the floor for every CUSTOM
   audience. On 2026-08-13 an agent read 20, concluded the website pool held
   twenty people, and paused `fc-retarget-web14-eng30` as "structurally
   impossible". It held ~2,000. The campaign's real problem was that it cost
   64.45 SAR per result — an offer and optimisation-event problem.

   So this module NEVER reads a size off that field. It calls
   `/act_x/delivery_estimate` with the real Jeddah geo and stores the
   lower/upper monthly-reach bounds, which is the only number Meta will tell
   the truth on. `sizeMethod` records which method produced every number so a
   sentinel can never be mistaken for a measurement again.

   ── AN API ERROR IS NOT A ZERO ────────────────────────────────────────────
   Every size is `{ value, ok, method }`. A failed call stores ok:false and
   value:null and the UI prints "مقدرناش نقيس" — never 0, never a stale number
   presented as fresh. This has been the same bug four times in this account.

   Builds customer segments from the restaurant's OWN first-party data and
   pushes them (SHA-256 hashed, never raw) to each platform as custom
   audiences, so campaigns can retarget real customers and exclude recent
   buyers.

   Phone sources (both already normalised to the 9-digit Saudi subscriber):
     • ts_customers.phone_norm    — POS-registered customers
     • order_sources.phone_norm   — cashier captures + FeedUs Keeta phones
                                    (~96% of delivery volume carries a phone)

   Segments (recomputed fresh on every sync):
     all        كل العملاء المعروفين
     vip        صرف ≥ 300 ر.س أو ≥ 4 طلبات
     lapsed30   آخر طلب من أكتر من 30 يوم (win-back)
     recent14   طلبوا خلال 14 يوم (استبعاد من حملات الاكتساب + ريتارجيت ساخن)
     delivery   عملاء تطبيقات التوصيل (مصدر الطلب delivery_app)

   V1 is APPEND-only: platforms de-dupe hashed members, so re-sending the full
   list nightly is idempotent. The recency segments therefore go stale slowly
   (someone who ordered yesterday stays in lapsed30 until the platforms age
   them out) — acceptable for v1 and called out in the UI.

   Credentials reuse ads.js env vars: META_CAPI_TOKEN + META_AD_ACCOUNT_ID,
   TIKTOK_ACCESS_TOKEN + TIKTOK_ADVERTISER_ID, Snap OAuth set.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import {
  byId, canManage, missingOf, hashPhoneDigits, hashPhonePlus,
  httpJson, redact, classifyRefusal, closeWriteGate, openWriteGate, readGate,
  readMetaResult,
} from "./ads.js";

const META_VER = () => (process.env.META_API_VERSION || "v25.0").trim();
const TT_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const SNAP_BASE = "https://adsapi.snapchat.com/v1";
const env = (k) => (process.env[k] || "").trim();

/* ── the account's fixed ids ──────────────────────────────────────────────
   Read from env when present, otherwise the values verified live against
   act_210662083554074 on 2026-08-14. They are ids, not secrets — the pixel
   id is publicly readable out of the storefront's HTML by anyone.          */
const metaAct = () => {
  const a = env("META_AD_ACCOUNT_ID");
  return a ? (a.startsWith("act_") ? a : `act_${a}`) : "";
};
const metaPixelId = () => env("META_WEB_PIXEL_ID") || env("META_PIXEL_ID") || "2281193882627660";
const metaPageId = () => env("META_PAGE_ID") || "1193489887177708";
const metaIgId = () => env("META_IG_ID") || "17841414510113806";
const metaBase = () => `https://graph.facebook.com/${META_VER()}`;

/* المطعم في جدة. كل قياس حجم بيتقاس على نفس الدايرة اللي بنعلن جواها فعلاً
   — قياس على السعودية كلها بيدّي رقم كبير ومالوش لازمة، لإن اللي في الرياض
   مش هيطلب من هنا. الدايرة دي هي نفس نقطة الحملات الشغالة. */
const JEDDAH = { lat: 21.588068, lng: 39.153128, radiusKm: 25 };
const geoSpec = (radiusKm = JEDDAH.radiusKm) => ({
  custom_locations: [{
    latitude: JEDDAH.lat, longitude: JEDDAH.lng,
    radius: radiusKm, distance_unit: "kilometer", country: "SA",
  }],
  location_types: ["frequently_in", "home", "recent"],
});

const DAYS = (n) => n * 86400;

/* ── Meta audience rule builders ──────────────────────────────────────────
   The rule JSON Meta wants is verbose and easy to get subtly wrong, so it is
   built in exactly one place. `inclusions` is an OR of event rules;
   `exclusions` is the same shape and is what turns "people who added to
   cart" into "people who added to cart AND NEVER CAME BACK TO US" — the
   difference between a retargeting audience and a receipt.                 */
const pixelRules = (events, days) => events.map((ev) => ({
  event_sources: [{ id: metaPixelId(), type: "pixel" }],
  retention_seconds: DAYS(days),
  filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: ev }] },
}));

const pageRules = (events, days, source = "page") => events.map((ev) => ({
  event_sources: [{ id: source === "page" ? metaPageId() : metaIgId(), type: source }],
  retention_seconds: DAYS(days),
  filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: ev }] },
}));

const websiteRule = (events, days, excludeEvents = null, excludeDays = days) => {
  const rule = { inclusions: { operator: "or", rules: pixelRules(events, days) } };
  if (excludeEvents?.length) {
    rule.exclusions = { operator: "or", rules: pixelRules(excludeEvents, excludeDays) };
  }
  return rule;
};
const engagementRule = (events, days, source = "page") =>
  ({ inclusions: { operator: "or", rules: pageRules(events, days, source) } });

/* الأحداث اللي معناها «العميل كلّمنا خلاص» — لو دخلت في جمهور ريتارجيت
   يبقى إحنا بندفع عشان نوصل لواحد جالنا أصلاً. بتستخدم كاستبعاد جوّه
   قواعد سلة المتروكة والشيك أوت المتروك. */
const CONVERTED_EVENTS = ["Purchase", "Lead", "Contact"];

/* ── the audience catalogue ───────────────────────────────────────────────
   `name` is the join key with what already exists in the ad account, so the
   names of the ten audiences created on 13 Aug are reproduced here EXACTLY.
   A typo would create a duplicate audience with zero history instead of
   adopting the one that has been warming for a day.

   `tier` is not decoration. It is what stops the mistake a prior audit found
   in this account: a 365-day video viewer and a 14-day cart abandoner stacked
   into one ad set. Someone who watched a video ten months ago is prospecting;
   pricing him as retargeting is what produced the highest CPM in the account.

     hot     — showed purchase intent in the last 14 days
     warm    — visited or engaged in the last 30 days
     cool    — 90 days; the edge of usefulness for a restaurant
     prospect— 365 days; NOT retargeting. Lookalike seed / cheap reach only.
     exclude — never targeted; only ever subtracted
     seed    — only ever used as a lookalike origin
*/
const META_AUDIENCES = [
  /* ── website behaviour ───────────────────────────────────────────────── */
  { key: "web:visitors7", name: "FreshCuts Web Visitors 7d", subtype: "WEBSITE", tier: "hot",
    ar: "زار الموقع آخر ٧ أيام", rule: () => websiteRule(["PageView"], 7) },
  { key: "web:visitors14", name: "FreshCuts Web Visitors 14d", subtype: "WEBSITE", tier: "warm",
    ar: "زار الموقع آخر ١٤ يوم", rule: () => websiteRule(["PageView"], 14) },
  { key: "web:visitors30", name: "FreshCuts Web Visitors 30d", subtype: "WEBSITE", tier: "warm",
    ar: "زار الموقع آخر ٣٠ يوم", rule: () => websiteRule(["PageView"], 30) },
  { key: "web:visitors90", name: "FreshCuts Web Visitors 90d", subtype: "WEBSITE", tier: "cool",
    ar: "زار الموقع آخر ٩٠ يوم", rule: () => websiteRule(["PageView"], 90) },

  { key: "web:viewers14", name: "FreshCuts Product Viewers 14d", subtype: "WEBSITE", tier: "hot",
    ar: "بصّ على صنف معيّن آخر ١٤ يوم — أقوى جمهور للكتالوج",
    rule: () => websiteRule(["ViewContent", "AddToCart"], 14) },
  { key: "web:viewers30", name: "FreshCuts Product Viewers 30d", subtype: "WEBSITE", tier: "warm",
    ar: "بصّ على صنف معيّن آخر ٣٠ يوم",
    rule: () => websiteRule(["ViewContent", "AddToCart"], 30) },

  /* «متروكة» الحقيقية: حط في السلة ولا كلّمنا. الجمهور اللي اسمه
     Cart Abandoners 14d الموجود من ١٣ أغسطس مالوش استبعاد أصلاً، يعني
     بيضم اللي طلب فعلاً — فبنسيبه مكانه (بيتقاس وبيتراقب) وبنعمل النسخة
     الصح جنبه بدل ما نغيّر قاعدة جمهور بيتعبّى من يومين. */
  { key: "web:cart14", name: "FreshCuts Cart Abandoners 14d", subtype: "WEBSITE", tier: "hot",
    ar: "حط في السلة أو بدأ الشيك أوت آخر ١٤ يوم (من غير استبعاد — النسخة القديمة)",
    rule: () => websiteRule(["AddToCart", "InitiateCheckout"], 14) },
  { key: "web:cart-abandon14", name: "FreshCuts Cart Abandon (net) 14d", subtype: "WEBSITE", tier: "hot",
    ar: "حط في السلة ولا اشترى ولا كلّمنا — سلة متروكة بجد",
    rule: () => websiteRule(["AddToCart"], 14, CONVERTED_EVENTS, 14) },
  { key: "web:checkout-abandon14", name: "FreshCuts Checkout Abandon (net) 14d", subtype: "WEBSITE", tier: "hot",
    ar: "بدأ الشيك أوت ولا كمّل ولا كلّمنا — أعلى نية في الموقع كله",
    rule: () => websiteRule(["InitiateCheckout"], 14, CONVERTED_EVENTS, 14) },

  { key: "web:contact30", name: "FreshCuts Contact Clickers 30d", subtype: "WEBSITE", tier: "warm",
    ar: "دَاس واتساب/اتصال آخر ٣٠ يوم — كلّمنا، والسؤال بقى: طلب ولا لأ",
    rule: () => websiteRule(["Contact", "Lead"], 30) },
  { key: "web:converters7", name: "FreshCuts Converters 7d (Lead+Purchase)", subtype: "WEBSITE", tier: "exclude",
    ar: "اشترى أو ساب بياناته آخر ٧ أيام — بيتستبعد من كل حاجة",
    rule: () => websiteRule(["Purchase", "Lead"], 7) },

  /* ── page / IG / video engagement ────────────────────────────────────── */
  { key: "eng:page30", name: "FreshCuts Page Engagers 30d", subtype: "ENGAGEMENT", tier: "warm",
    ar: "تفاعل مع صفحة فيسبوك آخر ٣٠ يوم", rule: () => engagementRule(["page_engaged"], 30) },
  { key: "eng:page365", name: "FreshCuts FB Page Engagers 365d", subtype: "ENGAGEMENT", tier: "prospect",
    ar: "تفاعل مع الصفحة خلال سنة — ده اكتساب رخيص مش ريتارجيت",
    rule: () => engagementRule(["page_engaged"], 365) },
  { key: "eng:ig30", name: "FreshCuts IG Engagers 30d", subtype: "IG_BUSINESS", tier: "warm",
    ar: "تفاعل مع إنستجرام آخر ٣٠ يوم", rule: () => engagementRule(["ig_business_profile_engaged"], 30, "ig_business") },
  { key: "eng:ig90", name: "FreshCuts IG Engagers 90d", subtype: "IG_BUSINESS", tier: "cool",
    ar: "تفاعل مع إنستجرام آخر ٩٠ يوم", rule: () => engagementRule(["ig_business_profile_engaged"], 90, "ig_business") },
  { key: "eng:ig365", name: "FreshCuts IG Engagers 365d", subtype: "IG_BUSINESS", tier: "prospect",
    ar: "تفاعل مع إنستجرام خلال سنة — اكتساب مش ريتارجيت",
    rule: () => engagementRule(["ig_business_profile_engaged"], 365, "ig_business") },
  { key: "eng:video30", name: "FreshCuts Video Viewers 30d", subtype: "ENGAGEMENT", tier: "warm",
    ar: "اتفرّج على فيديو آخر ٣٠ يوم", rule: () => engagementRule(["page_video_view"], 30) },
  { key: "eng:video365", name: "FreshCuts Video Viewers 365d", subtype: "ENGAGEMENT", tier: "prospect",
    ar: "اتفرّج على فيديو خلال سنة — اكتساب مش ريتارجيت",
    rule: () => engagementRule(["page_video_view"], 365) },

  /* ── lookalikes ──────────────────────────────────────────────────────────
     قوايم العملاء صغيرة (٦٠٤ / ٩٢ / ١٤١) — دي مش أجمهرة تتستهدف، دي بذور.
     ميتا مش بتقبل بذرة أقل من ١٠٠ صف، فـ `minSeed` بيخلّي جمهور الـ VIP
     يفضل مؤجّل لحد ما القايمة تكبر بدل ما يفضل يفشل كل ليلة ويطلّع خطأ. */
  { key: "lal:buyers1", name: "FreshCuts LAL 1% SA (seed: buyers)", subtype: "LOOKALIKE", tier: "seed",
    ar: "شبيه ١٪ من كل عملائنا — أضيق شبيه، أقرب ناس", seed: "all", ratio: 0.01, minSeed: 100 },
  { key: "lal:buyers3", name: "FreshCuts LAL 3% SA (seed: all)", subtype: "LOOKALIKE", tier: "seed",
    ar: "شبيه ٣٪ من كل عملائنا", seed: "all", ratio: 0.03, minSeed: 100 },
  { key: "lal:vip1", name: "FreshCuts LAL 1% SA (seed: VIP)", subtype: "LOOKALIKE", tier: "seed",
    ar: "شبيه ١٪ من عملاء الـ VIP — أغلى بذرة عندنا", seed: "vip", ratio: 0.01, minSeed: 100 },
];

const audByKey = (k) => META_AUDIENCES.find((a) => a.key === k) || null;

const SEGMENTS = [
  { id: "all",      label: "كل العملاء",            desc: "كل رقم جوال معروف لينا" },
  { id: "vip",      label: "عملاء VIP",             desc: "صرف ≥ 300 ر.س أو ≥ 4 طلبات" },
  { id: "lapsed30", label: "عملاء نايمين (30+ يوم)", desc: "آخر طلب من أكتر من شهر — حملات الرجوع" },
  { id: "recent14", label: "طلبوا آخر 14 يوم",       desc: "ريتارجيت ساخن + استبعاد من الاكتساب" },
  { id: "delivery", label: "عملاء تطبيقات التوصيل",  desc: "جالنا منهم رقم عن طريق FeedUs/الكاشير" },
];

export function register(app, ctx) {
  const { pool, requireAdmin, jb } = ctx;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aud_audiences (
        platform TEXT NOT NULL,
        segment TEXT NOT NULL,
        audience_id TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (platform, segment)
      );
      CREATE TABLE IF NOT EXISTS aud_syncs (
        id TEXT PRIMARY KEY,
        platform TEXT,
        segment TEXT,
        size INT,
        status TEXT,                -- sent|failed|skipped
        response JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS aud_syncs_time_idx ON aud_syncs(created_at DESC);

      /* المقاس الحقيقي لكل جمهور على المنصة. مفصول عن aud_audiences عن قصد:
         ده رقم بيتقاس وبيقدم، مش هوية الجمهور. وعمود ok منفصل عن عمود low
         عشان خطأ في النداء ما ينفعش يتقرا كصفر — الغلطة دي حصلت أربع مرات. */
      CREATE TABLE IF NOT EXISTS aud_sizes (
        platform TEXT NOT NULL,
        key TEXT NOT NULL,
        audience_id TEXT,
        low INT, high INT, dau INT,
        method TEXT,                 -- delivery_estimate | member_count | none
        ok BOOLEAN NOT NULL DEFAULT FALSE,
        error TEXT,
        measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (platform, key)
      );

      /* حالة كل مهمة: بتفشل من إمتى، وقلنا للمالك ولا لسه. ده اللي بيمنع
         إن العطل يتعاد كل ساعة في السجل من غير ما حد ياخد باله، وبيمنع
         بردو إن غلطة عابرة تصحّي المالك من النوم. */
      CREATE TABLE IF NOT EXISTS aud_health (
        task TEXT PRIMARY KEY,
        fails INT NOT NULL DEFAULT 0,
        last_error TEXT,
        first_failed_at TIMESTAMPTZ,
        last_ok_at TIMESTAMPTZ,
        noted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      /* آخر مرة اشتغلت فيها كل مهمة بنجاح — ده جدول المواعيد نفسه. في
         الداتابيز مش في الذاكرة عشان الـ deploy ما يعملش refresh كامل
         لكل حاجة كل مرة، والحصة عند ميتا محدودة. */
      CREATE TABLE IF NOT EXISTS aud_jobs (
        job TEXT PRIMARY KEY,
        last_run_at TIMESTAMPTZ,
        last_ok_at TIMESTAMPTZ,
        last_result JSONB
      );
    `);
  }
  ensureSchema()
    .then(() => console.log("[audiences] schema ready"))
    .catch((e) => console.error("[audiences] schema failed:", e.message));

  /* ── segment membership (phone_norm list per segment) ─────────────────── */
  const BASE_CTE = `
    WITH ph AS (
      SELECT pn, max(day) AS last_day, count(*)::int AS orders, COALESCE(sum(total),0) AS spend,
             bool_or(is_delivery) AS is_delivery
        FROM (
          SELECT s.phone_norm AS pn, o.calendar_day AS day, o.total,
                 (s.source = 'delivery_app') AS is_delivery
            FROM order_sources s JOIN ts_orders o ON o.order_id = s.order_id
           WHERE s.phone_norm <> ''
          UNION ALL
          SELECT tc.phone_norm, o.calendar_day, o.total, false
            FROM ts_orders o JOIN ts_customers tc ON tc.customer_id = o.customer_id
           WHERE tc.phone_norm <> ''
        ) u
       WHERE length(pn) = 9
       GROUP BY pn
    )`;

  const SEGMENT_SQL = {
    all:      `${BASE_CTE} SELECT pn FROM ph`,
    vip:      `${BASE_CTE} SELECT pn FROM ph WHERE spend >= 300 OR orders >= 4`,
    lapsed30: `${BASE_CTE} SELECT pn FROM ph WHERE last_day < (NOW() AT TIME ZONE 'utc')::date - 30`,
    recent14: `${BASE_CTE} SELECT pn FROM ph WHERE last_day >= (NOW() AT TIME ZONE 'utc')::date - 14`,
    delivery: `${BASE_CTE} SELECT pn FROM ph WHERE is_delivery`,
  };

  async function segmentPhones(segId) {
    const sql = SEGMENT_SQL[segId];
    if (!sql) throw new Error(`unknown segment ${segId}`);
    const r = await pool.query(sql);
    // 9-digit subscriber → full international digits.
    return r.rows.map((x) => "966" + x.pn);
  }

  /* ── platform senders — create-or-reuse audience, then append hashes ──── */

  async function audienceIdFor(platform, segment, createFn) {
    const r = await pool.query(
      `SELECT audience_id FROM aud_audiences WHERE platform=$1 AND segment=$2`, [platform, segment]);
    if (r.rows[0]) return { id: r.rows[0].audience_id, created: false };
    const created = await createFn();
    if (!created.ok) return created;
    await pool.query(
      `INSERT INTO aud_audiences (platform, segment, audience_id, name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (platform, segment) DO UPDATE SET audience_id=EXCLUDED.audience_id, name=EXCLUDED.name`,
      [platform, segment, created.id, created.name]);
    return { id: created.id, created: true };
  }

  const segName = (segId) => `FreshCuts ${SEGMENTS.find((s) => s.id === segId)?.label || segId}`;

  /* Meta: POST /act_x/customaudiences → POST /{aud}/users (batches of 10k). */
  async function syncMeta(segId, phones) {
    const token = env("META_CAPI_TOKEN");
    const actRaw = env("META_AD_ACCOUNT_ID");
    if (!token || !actRaw) return { ok: false, error: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing" };
    const act = actRaw.startsWith("act_") ? actRaw : `act_${actRaw}`;
    const base = `https://graph.facebook.com/${META_VER()}`;

    const aud = await audienceIdFor("meta", segId, async () => {
      const res = await httpJson(`${base}/${act}/customaudiences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          name: segName(segId),
          subtype: "CUSTOM",
          description: SEGMENTS.find((s) => s.id === segId)?.desc || "",
          customer_file_source: "USER_PROVIDED_ONLY",
          access_token: token,
        },
      });
      if (!res.ok || !res.json?.id) {
        return { ok: false, error: res.json?.error?.message || res.error || `HTTP ${res.status}` };
      }
      return { ok: true, id: String(res.json.id), name: segName(segId) };
    });
    if (!aud.id) return aud;

    let added = 0;
    for (let i = 0; i < phones.length; i += 10000) {
      const chunk = phones.slice(i, i + 10000);
      const res = await httpJson(`${base}/${aud.id}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          payload: { schema: ["PHONE_SHA256"], data: chunk.map((d) => [hashPhoneDigits(d)]) },
          access_token: token,
        },
      });
      if (!res.ok) {
        return { ok: false, error: res.json?.error?.message || res.error || `HTTP ${res.status}`, added };
      }
      added += res.json?.num_received ?? chunk.length;
    }
    return { ok: true, audienceId: aud.id, added };
  }

  /* TikTok: multipart file upload → create or APPEND update.

     The timeout is the entire point of this wrapper. This was the one HTTP
     call in the whole service made with a bare `fetch` and no deadline, and
     it sits inside the nightly audience sweep, which sits inside the hourly
     autopilot cycle. A TCP connection that hangs here hangs runCycle; the
     `running` latch is released in a `finally` that never runs; every
     subsequent hourly tick returns "already running" — and the autopilot is
     dead, silently, until somebody restarts the container. An audience
     upload failing is a small thing. It must never be able to take the agent
     down with it. */
  const AUD_TIMEOUT_MS = Number(process.env.ADS_HTTP_TIMEOUT_MS || 15000);

  async function ttMultipart(url, fields, fileField, fileName, fileContent) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    fd.append(fileField, new Blob([fileContent], { type: "text/csv" }), fileName);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), AUD_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Access-Token": env("TIKTOK_ACCESS_TOKEN") },
        body: fd,
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { ok: res.ok && json?.code === 0, json, status: res.status, text: json ? undefined : text.slice(0, 400) };
    } catch (e) {
      const msg = e && e.name === "AbortError" ? `timeout after ${AUD_TIMEOUT_MS}ms` : String((e && e.message) || e);
      return { ok: false, json: null, status: 0, text: msg, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async function syncTiktok(segId, phones) {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = env("TIKTOK_ADVERTISER_ID");
    if (!token || !adv) return { ok: false, error: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing" };

    // TikTok wants the '+' inside the hash for phones.
    const fileContent = phones.map((d) => hashPhonePlus(d)).join("\n");
    /* `file_signature` is the MD5 of the exact bytes we upload, and TikTok
       treats it as REQUIRED: without it every upload comes back
       "file_signature: Missing data for required field." and no TikTok
       audience is ever created. It is their integrity check — they hash what
       arrived and compare — so it must be computed from `fileContent`
       itself, never from the phone list or the file name. */
    const fileSignature = crypto.createHash("md5").update(fileContent, "utf8").digest("hex");
    const up = await ttMultipart(`${TT_BASE}/dmp/custom_audience/file/upload/`, {
      advertiser_id: adv,
      calculate_type: "PHONE_SHA256",
      file_signature: fileSignature,
    }, "file", `freshcuts_${segId}.csv`, fileContent);
    if (!up.ok) return { ok: false, error: up.json?.message || up.text || `HTTP ${up.status}` };
    const filePath = up.json?.data?.file_path;
    if (!filePath) return { ok: false, error: "upload returned no file_path" };

    const existing = await pool.query(
      `SELECT audience_id FROM aud_audiences WHERE platform='tiktok' AND segment=$1`, [segId]);
    if (existing.rows[0]) {
      const res = await httpJson(`${TT_BASE}/dmp/custom_audience/update/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Access-Token": token },
        body: {
          advertiser_id: adv,
          custom_audience_id: existing.rows[0].audience_id,
          action: "APPEND",
          file_paths: [filePath],
        },
      });
      if (!(res.ok && res.json?.code === 0)) {
        return { ok: false, error: res.json?.message || res.error || `HTTP ${res.status}` };
      }
      return { ok: true, audienceId: existing.rows[0].audience_id, added: phones.length };
    }
    const res = await httpJson(`${TT_BASE}/dmp/custom_audience/create/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body: {
        advertiser_id: adv,
        custom_audience_name: segName(segId),
        calculate_type: "PHONE_SHA256",
        file_paths: [filePath],
      },
    });
    if (!(res.ok && res.json?.code === 0) || !res.json?.data?.custom_audience_id) {
      return { ok: false, error: res.json?.message || res.error || `HTTP ${res.status}` };
    }
    const id = String(res.json.data.custom_audience_id);
    await pool.query(
      `INSERT INTO aud_audiences (platform, segment, audience_id, name) VALUES ('tiktok',$1,$2,$3)
       ON CONFLICT (platform, segment) DO UPDATE SET audience_id=EXCLUDED.audience_id`,
      [segId, id, segName(segId)]);
    return { ok: true, audienceId: id, added: phones.length, created: true };
  }

  /* Snap: POST /adaccounts/{id}/segments → POST /segments/{id}/users. */
  async function syncSnap(segId, phones) {
    const snap = byId("snapchat");
    const acct = env("SNAP_AD_ACCOUNT_ID");
    const t = await snap.token();
    if (!t || !acct) return { ok: false, error: "SNAP_AD_ACCOUNT_ID / Snap OAuth credentials missing" };
    const hdr = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };

    const aud = await audienceIdFor("snapchat", segId, async () => {
      const res = await httpJson(`${SNAP_BASE}/adaccounts/${acct}/segments`, {
        method: "POST", headers: hdr,
        body: {
          segments: [{
            name: segName(segId),
            description: SEGMENTS.find((s) => s.id === segId)?.desc || "",
            source_type: "FIRST_PARTY",
            retention_in_days: 180,
            ad_account_id: acct,
          }],
        },
      });
      const seg = res.json?.segments?.[0]?.segment;
      if (!res.ok || !seg?.id) {
        return { ok: false, error: res.json?.debug_message || res.error || `HTTP ${res.status}` };
      }
      return { ok: true, id: seg.id, name: segName(segId) };
    });
    if (!aud.id) return aud;

    let added = 0;
    for (let i = 0; i < phones.length; i += 10000) {
      const chunk = phones.slice(i, i + 10000);
      const res = await httpJson(`${SNAP_BASE}/segments/${aud.id}/users`, {
        method: "POST", headers: hdr,
        body: { users: [{ schema: ["PHONE_SHA256"], data: chunk.map((d) => [hashPhoneDigits(d)]) }] },
      });
      if (!res.ok) {
        return { ok: false, error: res.json?.debug_message || res.error || `HTTP ${res.status}`, added };
      }
      added += res.json?.users?.[0]?.user?.number_uploaded_users ?? chunk.length;
    }
    return { ok: true, audienceId: aud.id, added };
  }

  const SENDERS = { meta: syncMeta, tiktok: syncTiktok, snapchat: syncSnap };

  /* ── the sync driver — every (platform × segment) pair, never throws ──── */
  async function syncAll({ platforms, segments, trigger = "manual" } = {}) {
    const wantP = platforms?.length ? platforms : Object.keys(SENDERS);
    const wantS = segments?.length ? segments : SEGMENTS.map((s) => s.id);
    const out = { trigger, results: {} };
    // Compute each segment once, reuse across platforms.
    const phonesBySeg = {};
    for (const segId of wantS) {
      try { phonesBySeg[segId] = await segmentPhones(segId); }
      catch (e) { phonesBySeg[segId] = { error: e.message }; }
    }
    for (const pid of wantP) {
      const sender = SENDERS[pid];
      if (!sender) continue;
      out.results[pid] = {};
      for (const segId of wantS) {
        const phones = phonesBySeg[segId];
        let r;
        if (phones?.error) r = { ok: false, error: phones.error };
        else if (!phones.length) r = { ok: true, skipped: "empty segment", added: 0 };
        else {
          try { r = await sender(segId, phones); }
          catch (e) { r = { ok: false, error: String(e.message || e) }; }
        }
        out.results[pid][segId] = r;
        await pool.query(
          `INSERT INTO aud_syncs (id, platform, segment, size, status, response)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [crypto.randomUUID(), pid, segId, Array.isArray(phones) ? phones.length : 0,
           r.ok ? (r.skipped ? "skipped" : "sent") : "failed", jb(redact(r))]).catch(() => {});
      }
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     THE META RETARGETING SPINE

     Everything below builds and measures the PLATFORM-side audiences — the
     ones with real reach — and keeps them alive without anybody remembering.
  ═══════════════════════════════════════════════════════════════════════ */

  /* كل نداء على ميتا بيعدّي من هنا: بيحترم الباب المقفول، وبيصنّف الرفض
     بنفس قواعد ads.js، وبيقفل الباب لو المنصة قالت إحنا خلاص كتّرنا. الحساب
     على development access — يعني الحصة صغيرة والقراءة بتاكل من نفس
     الحصة اللي أوامر الإيقاف مستنياها. */
  async function metaCall(path, { method = "GET", params = {}, body = null, priority = "telemetry" } = {}) {
    const token = env("META_CAPI_TOKEN");
    const act = metaAct();
    if (!token || !act) return { ok: false, error: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing", kind: "config" };

    const blocked = readGate("meta", priority);
    if (blocked) return { ok: false, error: blocked.error, gated: true, kind: blocked.kind };

    const url = new URL(`${metaBase()}/${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    if (method === "GET") url.searchParams.set("access_token", token);

    const res = await httpJson(url.toString(), {
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      body: method === "GET" ? null : { ...(body || {}), access_token: token },
    });

    if (res.ok && !res.json?.error) { openWriteGate("meta"); return { ok: true, json: res.json }; }

    const cls = classifyRefusal("meta", res);
    if (cls.kind === "throttled" || cls.kind === "unavailable") {
      closeWriteGate("meta", {
        ms: cls.retryAfterMs,
        kind: cls.kind,
        reason: res.json?.error?.message || `HTTP ${res.status}`,
      });
    }
    /* `message` بتاعة ميتا ساعات بتبقى «Failed to create custom audience» وبس
       — جملة مالهاش أي معنى. السبب الحقيقي بيبقى في `error_user_msg`
       ("The parameter subtype is not supported in the current API version").
       ده كلّفنا جولة كاملة يوم ١٤ أغسطس، فالرسالتين بيتقروا مع بعض. */
    const e = res.json?.error || {};
    const detail = e.error_user_msg || e.error_user_title;
    return {
      ok: false,
      kind: cls.kind,
      error: [e.message || res.error || `HTTP ${res.status}`, detail].filter(Boolean).join(" — "),
      code: e.code ?? null,
      subcode: e.error_subcode ?? null,
    };
  }

  /* قايمة الجماهير اللي موجودة فعلاً على الحساب. بنستخدمها للتبنّي بالاسم:
     عشرة جماهير اتعملت يوم ١٣ أغسطس ومش مسجّلة عندنا في الداتابيز — لو
     عملناهم تاني هيبقى عندنا نسختين، واحدة بتتعبّى من يومين والتانية
     فاضية، والحملة هتشتغل على الفاضية. */
  let remoteCache = { at: 0, byName: null };
  async function metaRemoteAudiences({ force = false, priority = "telemetry" } = {}) {
    if (!force && remoteCache.byName && Date.now() - remoteCache.at < 10 * 60_000) {
      return { ok: true, byName: remoteCache.byName, cached: true };
    }
    const r = await metaCall(`${metaAct()}/customaudiences`, {
      priority,
      params: { fields: "id,name,subtype,operation_status,delivery_status", limit: 200 },
    });
    if (!r.ok) return r;
    const byName = new Map();
    for (const a of r.json?.data || []) byName.set(String(a.name || "").trim(), a);
    remoteCache = { at: Date.now(), byName };
    return { ok: true, byName };
  }

  const savedId = async (key) => (await pool.query(
    `SELECT audience_id FROM aud_audiences WHERE platform='meta' AND segment=$1`, [key])).rows[0]?.audience_id || null;

  const saveId = (key, id, name) => pool.query(
    `INSERT INTO aud_audiences (platform, segment, audience_id, name) VALUES ('meta',$1,$2,$3)
     ON CONFLICT (platform, segment) DO UPDATE SET audience_id=EXCLUDED.audience_id, name=EXCLUDED.name`,
    [key, String(id), name]);

  /* ── ensure: كل جمهور في الكتالوج موجود على ميتا ───────────────────────
     تلات حالات لكل واحد: عندنا (ok)، موجود على الحساب بالاسم فبنتبنّاه
     (adopted)، مش موجود فبنعمله (created). ورابعة: بذرة الشبيه لسه صغيرة
     فبنأجّله بسبب مكتوب (deferred) — مش خطأ ومش هيتعاد كل ساعة كإنه عطل. */
  async function ensureMetaAudiences({ priority = "telemetry" } = {}) {
    const out = { ok: true, created: [], adopted: [], existing: [], deferred: [], failed: [] };
    const remote = await metaRemoteAudiences({ force: true, priority });
    if (!remote.ok) return { ...out, ok: false, error: remote.error, kind: remote.kind };

    // أحجام الشرايح الأولية — محتاجينها عشان نعرف البذرة كبرت ولا لأ.
    const seedSizes = {};
    for (const s of SEGMENTS) {
      try { seedSizes[s.id] = (await segmentPhones(s.id)).length; } catch { seedSizes[s.id] = null; }
    }

    for (const spec of META_AUDIENCES) {
      const have = await savedId(spec.key);
      if (have) { out.existing.push(spec.key); continue; }

      const found = remote.byName.get(spec.name);
      if (found) {
        await saveId(spec.key, found.id, spec.name);
        out.adopted.push({ key: spec.key, id: String(found.id) });
        continue;
      }

      let body;
      if (spec.subtype === "LOOKALIKE") {
        const originKey = spec.seed;
        const originId = await savedId(originKey);
        const seedSize = seedSizes[originKey];
        if (!originId) {
          out.deferred.push({ key: spec.key, why: `البذرة «${originKey}» لسه ما اترفعتش على ميتا` });
          continue;
        }
        if (seedSize != null && seedSize < (spec.minSeed || 100)) {
          out.deferred.push({
            key: spec.key,
            why: `البذرة «${originKey}» فيها ${seedSize} رقم، وميتا مش بتعمل شبيه من أقل من ${spec.minSeed || 100}. هيتعمل لوحده أول ما القايمة تكبر.`,
          });
          continue;
        }
        body = {
          name: spec.name,
          subtype: "LOOKALIKE",
          origin_audience_id: originId,
          // ميتا بتقبل الـ spec كنص JSON بس على الـ endpoint ده.
          lookalike_spec: JSON.stringify({ type: "custom_ratio", ratio: spec.ratio, country: "SA" }),
        };
      } else {
        /* من غير `subtype` عن قصد. من v25 ميتا بترفض الباراميتر ده مع أي
           جمهور مبني على قاعدة وبتقول:
             "The parameter subtype is not supported in the current API version"
           وبتستنتج النوع من الـ rule نفسها (بيكسل → WEBSITE، صفحة →
           ENGAGEMENT، حساب إنستجرام → IG_BUSINESS). `spec.subtype` فضل
           موجود في الكتالوج لإنه بيوصف الجمهور للبني آدم اللي بيقرا. */
        body = {
          name: spec.name,
          description: spec.ar,
          rule: JSON.stringify(spec.rule()),
          prefill: true,      // اعبّي بأثر رجعي من بيانات البيكسل الموجودة
        };
      }

      const r = await metaCall(`${metaAct()}/customaudiences`, { method: "POST", body, priority });
      if (!r.ok || !r.json?.id) {
        out.failed.push({ key: spec.key, error: r.error || "no id returned", kind: r.kind || null });
        out.ok = false;
        if (r.kind === "throttled" || r.kind === "unavailable") break;   // مفيش فايدة من الباقي
        continue;
      }
      await saveId(spec.key, r.json.id, spec.name);
      out.created.push({ key: spec.key, id: String(r.json.id) });
      await sleep(900);
    }
    remoteCache = { at: 0, byName: null };
    return out;
  }

  /* ── measure: الحجم الحقيقي، من delivery_estimate بس ───────────────────
     مش من approximate_count_lower_bound. الفرق بين الاتنين هو الفرق بين
     «الجمهور ده فيه ٢٠ واحد» و«فيه ألفين». */
  async function metaDeliveryEstimate(audienceId, { priority = "telemetry" } = {}) {
    const r = await metaCall(`${metaAct()}/delivery_estimate`, {
      priority,
      params: {
        optimization_goal: "REACH",
        targeting_spec: {
          geo_locations: geoSpec(),
          age_min: 18, age_max: 65,
          custom_audiences: [{ id: String(audienceId) }],
        },
      },
    });
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind || null };
    const d = r.json?.data?.[0];
    if (!d) return { ok: false, error: "delivery_estimate رجع من غير بيانات" };
    const low = Number(d.estimate_mau_lower_bound ?? d.estimate_mau);
    const high = Number(d.estimate_mau_upper_bound ?? d.estimate_mau);
    if (!Number.isFinite(low)) return { ok: false, error: "delivery_estimate من غير estimate_mau" };
    return {
      ok: true, low, high: Number.isFinite(high) ? high : low,
      dau: Number.isFinite(Number(d.estimate_dau)) ? Number(d.estimate_dau) : null,
      ready: d.estimate_ready !== false,
    };
  }

  async function measureMetaAudiences({ keys = null, priority = "telemetry" } = {}) {
    const want = keys?.length ? META_AUDIENCES.filter((a) => keys.includes(a.key)) : META_AUDIENCES;
    const out = { ok: true, measured: 0, failed: 0, rows: [] };
    for (const spec of want) {
      const id = await savedId(spec.key);
      if (!id) {
        out.rows.push({ key: spec.key, name: spec.name, ok: false, error: "لسه ما اتعملش على ميتا" });
        continue;
      }
      const est = await metaDeliveryEstimate(id, { priority });
      await pool.query(
        `INSERT INTO aud_sizes (platform, key, audience_id, low, high, dau, method, ok, error, measured_at)
         VALUES ('meta',$1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (platform, key) DO UPDATE SET
           audience_id=EXCLUDED.audience_id, low=EXCLUDED.low, high=EXCLUDED.high, dau=EXCLUDED.dau,
           method=EXCLUDED.method, ok=EXCLUDED.ok, error=EXCLUDED.error, measured_at=NOW()`,
        [spec.key, id, est.ok ? est.low : null, est.ok ? est.high : null, est.ok ? est.dau : null,
         est.ok ? "delivery_estimate" : "none", !!est.ok, est.ok ? null : String(est.error || "").slice(0, 300)]
      ).catch(() => {});
      out.rows.push({ key: spec.key, name: spec.name, tier: spec.tier, id, ...est });
      if (est.ok) out.measured++;
      else {
        out.failed++;
        /* الاختناق بيوقف الجولة كلها. لو كمّلنا هنحرق باقي الحصة على
           نداءات كلها هترجع نفس الرفض، والحصة دي أوامر الإيقاف محتاجاها. */
        if (est.kind === "throttled" || est.kind === "unavailable") { out.ok = false; out.stoppedEarly = true; break; }
      }
      await sleep(1100);
    }
    return out;
  }

  async function sizesFromDb() {
    const r = await pool.query(`SELECT * FROM aud_sizes WHERE platform='meta'`);
    const m = {};
    for (const x of r.rows) m[x.key] = x;
    return m;
  }

  /* ═══ الاستبعادات ═══════════════════════════════════════════════════════
     الاستبعاد هو نص الريتارجيت. من غيره إحنا بندفع عشان نوصل لواحد طلب
     امبارح، وبنعدّ الطلب اللي كان هيجي أصلاً على إنه نتيجة إعلان.

       اكتساب  ← استبعد: اللي طلب آخر ١٤ يوم + اللي حوّل على الموقع آخر ٧
       ريتارجيت ← استبعد: نفسهم (اللي حوّل خلاص مالوش لازمة نطارده)
       كل طبقة ← استبعد الطبقة الأسخن منها، عشان الواحد ما يتحاسبش مرتين
                 وما يشوفش تلات إعلانات مختلفة في نفس اليوم.
  */
  const EXCLUSION_SETS = {
    acquisition: ["recent14", "web:converters7"],
    retargeting: ["recent14", "web:converters7"],
  };

  async function exclusionIds(setName) {
    const keys = EXCLUSION_SETS[setName] || [];
    const ids = [];
    for (const k of keys) {
      const id = await savedId(k);
      if (id) ids.push({ id: String(id), key: k });
    }
    return ids;
  }

  /* ═══ الجدولة ═══════════════════════════════════════════════════════════
     الطيار بينده syncAll مرة كل ليلة. ده كان كفاية لقوايم العملاء وهو مش
     كفاية للعمود الفقري كله، فالموديول بقى بيجدول نفسه:

       lists    كل ٦ ساعات — رفع أرقام العملاء (٣ منصات × ٥ شرايح)
       ensure   كل ٢٤ ساعة — إنشاء أي جمهور ناقص + تبنّي القديم
       measure  كل ٢٤ ساعة — قياس الحجم الحقيقي بـ delivery_estimate

     المواعيد في الداتابيز مش في الذاكرة، عشان كل deploy ما يعملش دورة
     كاملة على حساب حصة ميتا. */
  const JOB_EVERY = {
    lists: Number(env("AUD_LISTS_HOURS") || 6) * 3600_000,
    ensure: Number(env("AUD_ENSURE_HOURS") || 24) * 3600_000,
    measure: Number(env("AUD_MEASURE_HOURS") || 24) * 3600_000,
  };

  async function jobDue(job) {
    const r = await pool.query(`SELECT last_run_at FROM aud_jobs WHERE job=$1`, [job]).catch(() => ({ rows: [] }));
    const last = r.rows[0]?.last_run_at ? Date.parse(r.rows[0].last_run_at) : 0;
    return Date.now() - last >= (JOB_EVERY[job] || 24 * 3600_000);
  }
  const jobDone = (job, ok, result) => pool.query(
    `INSERT INTO aud_jobs (job, last_run_at, last_ok_at, last_result)
     VALUES ($1, NOW(), CASE WHEN $2 THEN NOW() ELSE NULL END, $3)
     ON CONFLICT (job) DO UPDATE SET
       last_run_at = NOW(),
       last_ok_at  = CASE WHEN $2 THEN NOW() ELSE aud_jobs.last_ok_at END,
       last_result = $3`,
    [job, !!ok, jb(redact(result))]).catch(() => {});

  /* ═══ الصحة: تظهر مرة، بصوت عالي، وبعدين تسكت ═══════════════════════════
     العطل بيتسجّل في ap_decisions بنفس شكل الملاحظة اللي بيكتبها المشغّل،
     فبيظهر في سطر الصحة الواحد بتاع الطيار وفي سجل القرارات — مش في لوج
     الكونسول اللي محدش بيقراه.

     بس مش من أول مرة: عطل مرة واحدة ممكن يكون خنقة عابرة، والمالك مش
     المفروض يتصحّى عشان نداء واحد اترفض. بيتقال بعد تلات مرات ورا بعض،
     وبعدين مرة كل ٢٤ ساعة بحد أقصى، وبيتقال تاني لما يتصلّح. */
  const HEALTH_FAIL_THRESHOLD = 3;
  const HEALTH_RENOTE_MS = 24 * 3600_000;

  async function note({ platform, reason, status = "info", detail = {} }) {
    await pool.query(
      `INSERT INTO ap_decisions (id, run_id, platform, campaign_id, campaign_name, kind, detail, reason, status, executed_at)
       VALUES ($1,NULL,$2,NULL,NULL,'note',$3,$4,$5,$6)`,
      [crypto.randomUUID(), platform || null, jb({ ...detail, source: "audiences", manual: false }),
       reason, status, status === "info" ? null : new Date()]
    ).catch((e) => console.error("[audiences] note failed:", e.message));
  }

  async function markTask(task, ok, { error = null, platform = null, line = null, action = null } = {}) {
    const cur = (await pool.query(`SELECT * FROM aud_health WHERE task=$1`, [task]).catch(() => ({ rows: [] }))).rows[0];
    if (ok) {
      await pool.query(
        `INSERT INTO aud_health (task, fails, last_error, first_failed_at, last_ok_at, updated_at)
         VALUES ($1,0,NULL,NULL,NOW(),NOW())
         ON CONFLICT (task) DO UPDATE SET fails=0, last_error=NULL, first_failed_at=NULL, last_ok_at=NOW(), updated_at=NOW()`,
        [task]).catch(() => {});
      if (cur && cur.noted_at && cur.fails >= HEALTH_FAIL_THRESHOLD) {
        await note({ platform, status: "executed", reason: `✅ ${task}: رجعت تشتغل لوحدها بعد ${cur.fails} محاولة فاشلة.` });
        await pool.query(`UPDATE aud_health SET noted_at=NULL WHERE task=$1`, [task]).catch(() => {});
      }
      return;
    }
    const fails = (cur?.fails || 0) + 1;
    await pool.query(
      `INSERT INTO aud_health (task, fails, last_error, first_failed_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW())
       ON CONFLICT (task) DO UPDATE SET fails=$2, last_error=$3,
         first_failed_at=COALESCE(aud_health.first_failed_at, NOW()), updated_at=NOW()`,
      [task, fails, String(error || "").slice(0, 400)]).catch(() => {});

    const noted = cur?.noted_at ? Date.parse(cur.noted_at) : 0;
    if (fails >= HEALTH_FAIL_THRESHOLD && Date.now() - noted > HEALTH_RENOTE_MS) {
      await note({
        platform, status: "failed",
        reason: line || `${task}: فشل ${fails} مرة ورا بعض — آخر رد: «${String(error || "").slice(0, 160)}»`,
        detail: { task, fails, action },
      });
      await pool.query(`UPDATE aud_health SET noted_at=NOW() WHERE task=$1`, [task]).catch(() => {});
    }
  }

  /* ── the one refresh everything goes through ─────────────────────────── */
  let refreshing = false;
  async function refresh({ trigger = "cron", force = null } = {}) {
    if (refreshing) return { ok: true, skipped: "already running" };
    refreshing = true;
    const out = { trigger, at: new Date().toISOString(), ran: [] };
    try {
      if (force === "lists" || (force == null && await jobDue("lists"))) {
        const r = await syncAll({ trigger });
        const failures = [];
        for (const [p, segs] of Object.entries(r.results || {})) {
          for (const [s, v] of Object.entries(segs)) if (!v.ok) failures.push(`${p}/${s}: ${v.error}`);
        }
        /* منصة بترفض كل شرايحها ≠ شريحة واحدة وقعت. بنحاسب كل منصة لوحدها
           عشان تيك توك (لسه تحت المراجعة) ما تخفيش عطل حقيقي في ميتا. */
        for (const p of Object.keys(r.results || {})) {
          const segs = Object.values(r.results[p] || {});
          const bad = segs.filter((v) => !v.ok);
          await markTask(`lists:${p}`, bad.length === 0, {
            platform: p, error: bad[0]?.error,
            line: `رفع قوايم العملاء على ${byId(p)?.label || p} فشل — «${String(bad[0]?.error || "").slice(0, 140)}». يعني الاستبعادات على المنصة دي بتقدم، وممكن ندفع عشان نوصل لناس طلبت خلاص.`,
          });
        }
        await jobDone("lists", failures.length === 0, r);
        out.ran.push({ job: "lists", failures: failures.length });
        out.lists = r;
      }

      if (force === "ensure" || (force == null && await jobDue("ensure"))) {
        const r = await ensureMetaAudiences({ priority: trigger === "manual" ? "owner" : "telemetry" });
        await markTask("ensure:meta", r.ok, {
          platform: "meta", error: r.error || r.failed?.[0]?.error,
          line: `مقدرناش نعمل/نتأكد من جماهير الريتارجيت على ميتا — «${String(r.error || r.failed?.[0]?.error || "").slice(0, 140)}». يعني الحملة ممكن تشتغل على جمهور ناقص.`,
        });
        await jobDone("ensure", r.ok, r);
        out.ran.push({ job: "ensure", created: r.created?.length || 0, adopted: r.adopted?.length || 0 });
        out.ensure = r;
        if (r.created?.length) {
          await note({
            platform: "meta", status: "executed",
            reason: `اتعمل ${r.created.length} جمهور ريتارجيت جديد على ميتا: ${r.created.map((x) => x.key).join("، ")}.`,
            detail: { created: r.created },
          });
        }
      }

      if (force === "measure" || (force == null && await jobDue("measure"))) {
        const r = await measureMetaAudiences({ priority: trigger === "manual" ? "owner" : "telemetry" });
        await markTask("measure:meta", r.measured > 0 && !r.stoppedEarly, {
          platform: "meta", error: r.rows?.find((x) => !x.ok)?.error,
          line: "مقدرناش نقيس أحجام الجماهير على ميتا — الأرقام اللي في الشاشة قديمة. مش بنعرضها كأنها جديدة.",
        });
        await jobDone("measure", r.measured > 0, { measured: r.measured, failed: r.failed });
        out.ran.push({ job: "measure", measured: r.measured, failed: r.failed });
        out.measure = { measured: r.measured, failed: r.failed, stoppedEarly: !!r.stoppedEarly };
      }
      return { ok: true, ...out };
    } catch (e) {
      await markTask("refresh", false, { error: e.message });
      return { ok: false, error: String(e.message || e), ...out };
    } finally {
      refreshing = false;
    }
  }

  /* المؤقّت. بيصحى كل ١٥ دقيقة ويسأل «فيه حاجة مستحقة؟» — مش بيعمل حاجة
     غير لو موعدها جه فعلاً، فالتكلفة الحقيقية استعلام واحد على الداتابيز.
     أول دورة بعد دقيقتين من الإقلاع عشان ما تزاحمش بدايات باقي الموديولات. */
  const TICK_MIN = Number(env("AUD_TICK_MINUTES") || 15);
  if (env("AUD_SCHEDULER") !== "0") {
    setTimeout(() => { refresh({ trigger: "boot" }).catch(() => {}); }, 120_000).unref?.();
    setInterval(() => { refresh({ trigger: "cron" }).catch(() => {}); }, TICK_MIN * 60_000).unref?.();
    console.log(`[audiences] scheduler on — tick ${TICK_MIN}m, lists/${JOB_EVERY.lists / 3600_000}h ensure/${JOB_EVERY.ensure / 3600_000}h measure/${JOB_EVERY.measure / 3600_000}h`);
  } else {
    console.log("[audiences] scheduler off (AUD_SCHEDULER=0)");
  }

  /* ═══ السطر اللي المالك بيقراه ═══════════════════════════════════════════
     سؤال واحد: «الريتارجيت شغال ولا لأ، وبيكلّف كام مقارنة بالاكتساب؟»
     والإجابة سطر واحد فوق الجدول. الجدول تحته لمن عايز يدقّق.            */
  async function retargetEconomics(days = 7) {
    /* بنقرا أرقام الحملات من ميتا مرة واحدة ونقسمها بالاسم: أي حملة اسمها
       fc-rt-* أو فيها retarget/dpa = ريتارجيت، الباقي اكتساب. الاسم هو
       العقد — لو حد سمّى حملة ريتارجيت باسم تاني هتتحسب اكتساب، وده
       مكتوب هنا عشان يبقى معروف مش مفاجأة. */
    const r = await metaCall(`${metaAct()}/insights`, {
      priority: "telemetry",
      params: {
        level: "campaign", date_preset: days <= 7 ? "last_7d" : "last_14d", limit: 100,
        fields: "campaign_name,spend,impressions,reach,actions,conversions,action_values",
      },
    });
    if (!r.ok) return { ok: false, error: r.error, gated: !!r.gated };

    const isRetarget = (n) => /(^|-)rt-|retarget|dpa|winback|vip-bundle/i.test(String(n || ""));
    const bucket = { retargeting: { spend: 0, results: 0, blind: 0 }, acquisition: { spend: 0, results: 0, blind: 0 } };
    const rows = [];
    for (const row of r.json?.data || []) {
      const b = isRetarget(row.campaign_name) ? "retargeting" : "acquisition";
      const res = readMetaResult(row);
      const spend = Number(row.spend) || 0;
      bucket[b].spend += spend;
      if (res.results == null) bucket[b].blind += spend; else bucket[b].results += res.results;
      rows.push({ name: row.campaign_name, bucket: b, spend: r2(spend), results: res.results });
    }
    const cpr = (b) => (b.results > 0 ? Math.round((b.spend / b.results) * 100) / 100 : null);
    return {
      ok: true, days,
      retargeting: { ...bucket.retargeting, spend: r2(bucket.retargeting.spend), costPerResult: cpr(bucket.retargeting) },
      acquisition: { ...bucket.acquisition, spend: r2(bucket.acquisition.spend), costPerResult: cpr(bucket.acquisition) },
      rows: rows.sort((a, b) => b.spend - a.spend),
      note: "«النتيجة» = نية طلب (واتساب أو كونتاكت أو ليد) — مش طلب متحصّل. الشرا الأونلاين لسه رقمين في ٣٠ يوم.",
    };
  }

  async function statusLine() {
    const sizes = await sizesFromDb();
    const jobs = Object.fromEntries((await pool.query(`SELECT * FROM aud_jobs`).catch(() => ({ rows: [] }))).rows.map((x) => [x.job, x]));
    const health = (await pool.query(`SELECT * FROM aud_health WHERE fails >= $1`, [HEALTH_FAIL_THRESHOLD]).catch(() => ({ rows: [] }))).rows;

    const live = META_AUDIENCES.filter((a) => sizes[a.key]?.ok);
    const unmeasured = META_AUDIENCES.filter((a) => !sizes[a.key]?.ok);
    const targetable = live.filter((a) => ["hot", "warm", "cool"].includes(a.tier));
    const reach = targetable.reduce((m, a) => Math.max(m, Number(sizes[a.key].low) || 0), 0);

    const measuredAt = Object.values(sizes).map((x) => x.measured_at).filter(Boolean).sort().pop() || null;
    const staleH = measuredAt ? Math.round((Date.now() - Date.parse(measuredAt)) / 3600_000) : null;

    let tone = "good", line;
    if (health.length) {
      tone = "bad";
      line = `🚨 ${health[0].task}: فشل ${health[0].fails} مرة ورا بعض — «${String(health[0].last_error || "").slice(0, 120)}».`;
    } else if (!live.length) {
      tone = "bad";
      line = "🚨 مفيش ولا جمهور ريتارجيت متقاس على ميتا — يعني إحنا بنعلن على العميان.";
    } else if (staleH != null && staleH > 48) {
      tone = "warn";
      line = `⚠️ آخر قياس لأحجام الجماهير من ${staleH} ساعة — الأرقام دي قديمة.`;
    } else {
      line = `${live.length} جمهور ريتارجيت شغّال ومتقاس، أكبرهم ${reach.toLocaleString("en")} شخص في دايرة ${JEDDAH.radiusKm} كم.`
        + (unmeasured.length ? ` (${unmeasured.length} لسه ما اتقاسش)` : "");
    }
    return {
      tone, line,
      audiences: META_AUDIENCES.map((a) => {
        const s = sizes[a.key];
        return {
          key: a.key, name: a.name, tier: a.tier, ar: a.ar, subtype: a.subtype,
          id: s?.audience_id || null,
          size: s?.ok ? { low: s.low, high: s.high, method: s.method } : null,
          /* مش صفر. مش رقم قديم. «مقدرناش نقيس» — وده اللي بيمنع الغلطة. */
          sizeNote: s?.ok ? null : (s?.error ? `مقدرناش نقيس: ${s.error}` : "لسه ما اتقاسش"),
          measuredAt: s?.measured_at || null,
        };
      }),
      jobs: Object.fromEntries(Object.keys(JOB_EVERY).map((j) => [j, {
        everyHours: JOB_EVERY[j] / 3600_000,
        lastRun: jobs[j]?.last_run_at || null,
        lastOk: jobs[j]?.last_ok_at || null,
      }])),
      problems: health.map((h) => ({ task: h.task, fails: h.fails, error: h.last_error, since: h.first_failed_at })),
    };
  }

  /* ═══ ROUTES ═══════════════════════════════════════════════════════════ */

  app.get("/api/audiences/retargeting", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const s = await statusLine();
    const econ = await retargetEconomics(7);
    return c.json({ ok: true, ...s, economics: econ, exclusions: EXCLUSION_SETS });
  });

  app.post("/api/audiences/ensure", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    return c.json(await refresh({ trigger: "manual", force: "ensure" }));
  });

  app.post("/api/audiences/measure", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    const r = await measureMetaAudiences({ keys: b.keys || null, priority: "owner" });
    await jobDone("measure", r.measured > 0, { measured: r.measured, failed: r.failed });
    return c.json({ ok: r.ok, ...r });
  });

  app.post("/api/audiences/refresh", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {}; try { b = await c.req.json(); } catch { b = {}; }
    return c.json(await refresh({ trigger: "manual", force: b.job || null }));
  });

  app.get("/api/audiences/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const sizes = {};
    for (const s of SEGMENTS) {
      try { sizes[s.id] = (await segmentPhones(s.id)).length; }
      catch (e) { sizes[s.id] = null; }
    }
    const auds = await pool.query(`SELECT * FROM aud_audiences ORDER BY platform, segment`);
    const last = await pool.query(
      `SELECT DISTINCT ON (platform, segment) platform, segment, size, status, created_at
         FROM aud_syncs ORDER BY platform, segment, created_at DESC`);
    const plats = ["meta", "tiktok", "snapchat"].map((id) => {
      const p = byId(id);
      return { id, configured: id === "meta"
        ? !!(env("META_CAPI_TOKEN") && env("META_AD_ACCOUNT_ID"))
        : canManage(p), missing: missingOf(p.manageEnv) };
    });
    return c.json({
      ok: true,
      segments: SEGMENTS.map((s) => ({ ...s, size: sizes[s.id] })),
      platforms: plats,
      audiences: auds.rows,
      lastSyncs: last.rows,
    });
  });

  app.post("/api/audiences/sync", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const r = await syncAll({ platforms: b.platforms, segments: b.segments, trigger: "manual" });
    return c.json({ ok: true, ...r });
  });

  /* حجم كل شريحة من غير ما ننده أي منصة — الطيار بيقرا منها «كام عميل
     بنعيد استهدافه» في شاشة الاقتصاديات، فالحساب لازم يكون متاح جوّه
     العملية من غير طلب HTTP على نفسنا. */
  async function segmentSizes() {
    const out = [];
    for (const s of SEGMENTS) {
      try { out.push({ ...s, size: (await segmentPhones(s.id)).length }); }
      catch (e) { out.push({ ...s, size: null, error: String(e.message || e) }); }
    }
    return out;
  }

  console.log(`[audiences] routes ready — ${META_AUDIENCES.length} platform audiences in the catalogue`);
  return {
    syncAll, segmentSizes, SEGMENTS,
    // العمود الفقري — الطيار وأي موديول تاني بيقرا منها بدل ما يعيد كتابتها.
    META_AUDIENCES, refresh, ensureMetaAudiences, measureMetaAudiences,
    statusLine, retargetEconomics, exclusionIds, audienceId: savedId,
  };
}
