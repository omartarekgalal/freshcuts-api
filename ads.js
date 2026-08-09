/* ═══════════════════════════════════════════════════════════════════════════
   ADS — paid-ads integration layer (Meta / TikTok / Snapchat / Google Ads).

   Registered by index.js via `register(app, ctx)`. Two jobs:

   1. CONVERSIONS OUT. Push real restaurant sales back to the ad platforms as
      server-side Purchase events so their optimisers learn from money, not
      clicks. Every platform gets the SAME event, keyed on the TabSense order
      id, and `ads_events` has UNIQUE(order_id, platform, event_name) so an
      order can physically never be reported twice to the same platform.

   2. CAMPAIGN CONTROL IN. List ad accounts / campaigns / insights, and
      (behind a hard guard) pause-resume a campaign or change its daily budget
      from our own dashboard.

   ── Rules that shape this file ────────────────────────────────────────────
   A. MONEY IS `ts_orders.total`, WHICH IS VAT-INCLUSIVE. That is the number
      the customer actually paid and the number the ad platform should
      optimise against. Never `gross`/`net` (those exclude VAT).
   B. VOID / REFUND ORDERS ARE NOT SALES. Same ILIKE '%void%' / '%refund%'
      exclusion analytics.js uses.
   C. NO RAW IDENTIFIER EVER LEAVES THIS PROCESS. Email and phone are
      SHA-256'd before they are put in a payload — and each platform gets its
      OWN normalisation, because they disagree (see PHONE NORMALISATION).
   D. A PLATFORM BEING DOWN IS NOT AN ERROR OF OURS. Every outbound call has
      a timeout and one retry on 5xx; failures land in `ads_events.response`
      as structured JSON and the route still answers 200.
   E. TOKENS ARE NEVER LOGGED OR ECHOED. `redact()` scrubs every payload we
      return (dryRun included) and every request we persist.

   ── PHONE NORMALISATION (they really are different) ───────────────────────
   Our `normPhone()` yields the Saudi subscriber number, 9 digits, e.g.
   "560503169". From there:
     Meta      digits only, country code included, no '+', no leading zeros
               → "966560503169"                            (sha256 of that)
     TikTok    E.164 *with* the plus sign
               → "+966560503169"                           (sha256 of that)
     Snapchat  digits only, country code included, no '+'
               → "966560503169"                            (sha256 of that)
     Google    E.164 with the plus sign
               → "+966560503169"                           (sha256 of that)
   Email is the same everywhere: trim → lowercase → sha256.

   ── HONEST LIMITATION ─────────────────────────────────────────────────────
   Delivery-aggregator orders reach us with NO customer identity at all
   (HungerStation/Keeta/Ninja do not hand over the diner's phone). Those
   events carry only event_id + value + timestamp, which platforms treat as
   near-unmatchable — useful for a value signal, useless for attribution.
   In-house orders that TabSense attached a customer to DO have a phone and
   are the ones that will actually match. See /api/ads/sync-orders response:
   every event reports `matchKeys` so the owner can see the split.
═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { menuRows } from "./catalog.js";

/* ─────────────────────────────────────────────────────────────────────────
   CONFIG — every environment variable this module reads.

   Conversions (server → platform, the easy half):
     META_PIXEL_ID           Meta dataset / pixel id (Events Manager)
     META_CAPI_TOKEN         Conversions API access token for that dataset
     META_TEST_EVENT_CODE    optional; routes events to the Test Events tab
     META_API_VERSION        optional; default v25.0
     TIKTOK_PIXEL_ID         TikTok pixel code / offline event set id
     TIKTOK_ACCESS_TOKEN     Events API 2.0 access token
     TIKTOK_EVENT_SOURCE     optional; web|app|offline|crm  (default offline)
     TIKTOK_TEST_EVENT_CODE  optional
     SNAP_PIXEL_ID           Snap Pixel id (or Snap App id)
     SNAP_ACCESS_TOKEN       Conversions API token
     GOOGLE_ADS_*            see the google adapter — mostly not usable here

   Campaign management (platform ← us, the hard half):
     META_AD_ACCOUNT_ID      act_xxxxxxxxx (the act_ prefix is optional)
     TIKTOK_ADVERTISER_ID    advertiser id the token is scoped to
     SNAP_AD_ACCOUNT_ID      Snap ad account uuid
     SNAP_CLIENT_ID / SNAP_CLIENT_SECRET / SNAP_REFRESH_TOKEN
                             Snap Marketing API OAuth (separate from CAPI)
     SNAP_MARKETING_TOKEN    optional short-lived bearer, skips the OAuth dance

   Safety:
     ADS_ALLOW_WRITE=1       REQUIRED before any state/budget change is sent.
                             Off ⇒ the route returns the exact call it WOULD
                             have made and changes nothing. Money is involved.
     ADS_MAX_DAILY_BUDGET    optional ceiling (account currency, default 5000)
     ADS_DEFAULT_COUNTRY_CODE  default 966
     ADS_HTTP_TIMEOUT_MS     default 15000
   ───────────────────────────────────────────────────────────────────────── */

const HTTP_TIMEOUT_MS = Number(process.env.ADS_HTTP_TIMEOUT_MS || 15000);
const COUNTRY_CODE = String(process.env.ADS_DEFAULT_COUNTRY_CODE || "966");
const MAX_DAILY_BUDGET = Number(process.env.ADS_MAX_DAILY_BUDGET || 5000);
const DEFAULT_CURRENCY = process.env.ADS_CURRENCY || "SAR";
const BATCH_SIZE = 500;

const env = (k) => (process.env[k] || "").trim();
const writeAllowed = () => process.env.ADS_ALLOW_WRITE === "1";

/* ─── crypto / normalisation ──────────────────────────────────────────── */

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

function hashEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  return sha256(e);
}

// `digits` is whatever normPhone() gave us (Saudi subscriber number, no CC).
// Returns the full international number as digits only, no '+'.
function phoneDigits(raw, normPhone) {
  const local = normPhone ? normPhone(raw) : String(raw || "").replace(/\D/g, "");
  if (!local) return null;
  if (local.length < 6) return null;
  // normPhone already stripped 966/0/00, so re-attach the country code unless
  // the caller handed us a number that clearly carries its own.
  const d = local.startsWith(COUNTRY_CODE) && local.length > 10 ? local : COUNTRY_CODE + local;
  return d;
}

const hashPhoneDigits = (d) => (d ? sha256(d) : null);          // Meta, Snapchat
const hashPhonePlus = (d) => (d ? sha256("+" + d) : null);      // TikTok, Google

/* ─── redaction — nothing secret ever leaves this module ──────────────── */

const SECRET_KEY = /(access[_-]?token|^token$|secret|refresh[_-]?token|authorization|developer[_-]?token|api[_-]?key|password)/i;

function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "***redacted***" : redact(v);
    }
    return out;
  }
  return value;
}

function redactUrl(u) {
  return String(u || "").replace(/([?&](?:access_token|token|key)=)[^&]*/gi, "$1***redacted***");
}

// Everything we persist or return goes through this.
function safeRequest(req) {
  if (!req) return null;
  return {
    url: redactUrl(req.url),
    method: req.method || "POST",
    headers: redact(req.headers || {}),
    body: redact(req.body ?? null),
  };
}

/* ─── HTTP: timeout + one retry on 5xx, never throws ──────────────────── */

async function httpJson(url, { method = "GET", headers = {}, body = null, timeout = HTTP_TIMEOUT_MS } = {}) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === null || body === undefined ? undefined
          : typeof body === "string" ? body : JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (res.status >= 500 && attempt === 0) {
        last = { ok: false, status: res.status, json, text: json ? undefined : text.slice(0, 1000), retried: true };
        continue;
      }
      return { ok: res.ok, status: res.status, json, text: json ? undefined : text.slice(0, 1000) };
    } catch (e) {
      const msg = e && e.name === "AbortError" ? `timeout after ${timeout}ms` : String((e && e.message) || e);
      last = { ok: false, status: 0, error: msg };
      if (attempt === 0) continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return last || { ok: false, status: 0, error: "unknown transport failure" };
}

/* ═══════════════════════════════════════════════════════════════════════
   ADAPTERS

   Every platform is the same shape, so a fourth (Twitter/X, Google DV360…)
   is one object literal and one line in PLATFORMS:

     id, label
     conversionEnv[]   env vars needed to SEND events
     manageEnv[]       env vars needed to READ/WRITE campaigns
     buildBatch(events)      -> { url, method, headers, body }   (or null)
     readBatchResult(res, n) -> { ok, accepted, error }
     accounts()   campaigns()   insights({from,to})
     setState(id, state)   setBudget(id, dailyBudget)
       ...the last two return a DESCRIPTOR when writes are disabled.

   A normalised event looks like:
     { eventId, eventName, eventTime: Date, value, currency,
       phoneDigits: "966xxxxxxxxx"|null, email: "a@b.c"|null,
       orderId, actionSource }
   ═══════════════════════════════════════════════════════════════════════ */

const missingOf = (names) => names.filter((n) => !env(n));

/* ─── Meta (Facebook / Instagram) ─────────────────────────────────────────
   Conversions API
     POST https://graph.facebook.com/{ver}/{PIXEL_ID}/events
     body { data:[ {event_name, event_time(sec), event_id, action_source,
                    user_data:{em:[sha256], ph:[sha256]},
                    custom_data:{value, currency, order_id}} ],
            test_event_code?, access_token }
     docs https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api
   Marketing API — campaigns live under act_{AD_ACCOUNT_ID}; budgets are in
   MINOR units of the account currency (SAR halalas), status is ACTIVE|PAUSED.
   Note Meta does not cascade a pause down to ad sets/ads; pausing the campaign
   stops delivery, which is what the owner means by "stop this campaign".      */
const meta = {
  id: "meta",
  label: "Meta (Facebook / Instagram)",
  conversionEnv: ["META_PIXEL_ID", "META_CAPI_TOKEN"],
  manageEnv: ["META_AD_ACCOUNT_ID", "META_CAPI_TOKEN"],
  eventName: "Purchase",

  // Meta rejects the ENTIRE batch if any single event has empty user_data
  // (error_subcode 2804050, verified live 2026-08-07). An identityless order
  // is skipped rather than sent — if a later sync learns its phone (FeedUs
  // linking runs behind the orders), the unclaimed row goes out then.
  usable(e) { return !!(e.phoneDigits || e.email || e.externalId); },

  ver: () => env("META_API_VERSION") || "v25.0",
  base() { return `https://graph.facebook.com/${this.ver()}`; },
  actId() {
    const a = env("META_AD_ACCOUNT_ID");
    return a ? (a.startsWith("act_") ? a : `act_${a}`) : "";
  },

  buildBatch(events) {
    const pixel = env("META_PIXEL_ID");
    const token = env("META_CAPI_TOKEN");
    if (!pixel || !token) return null;
    const data = events.map((e) => {
      const user_data = {};
      const ph = hashPhoneDigits(e.phoneDigits);
      const em = hashEmail(e.email);
      if (em) user_data.em = [em];
      if (ph) user_data.ph = [ph];
      // external_id is "hashing recommended" and is the only identity most of
      // our delivery orders can offer. It is stable per customer, not per order.
      if (e.externalId) user_data.external_id = [sha256(String(e.externalId))];
      const ev = {
        event_name: e.eventName || "Purchase",
        event_time: Math.floor(e.eventTime.getTime() / 1000),
        event_id: String(e.eventId),
        action_source: e.actionSource || "physical_store",
        user_data,
        custom_data: {
          value: e.value,
          currency: e.currency,
          ...(e.orderId ? { order_id: String(e.orderId) } : {}),
          ...(e.contentCategory ? { content_category: e.contentCategory } : {}),
          ...(e.contents ? {
            content_type: "product",
            contents: e.contents.map((i) => ({
              id: String(i.id), quantity: i.quantity, item_price: i.unitPrice,
            })),
            num_items: e.numItems,
          } : {}),
        },
      };
      return ev;
    });
    const body = { data, access_token: token };
    const testCode = env("META_TEST_EVENT_CODE");
    if (testCode) body.test_event_code = testCode;
    return {
      url: `${this.base()}/${pixel}/events`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };
  },

  /* Meta answers in three different shapes and this has to read all of them,
     because the same function judges a CAPI batch AND a campaign write:
       CAPI events    → { events_received: N, … }
       update a field → { success: true }            ← state / budget calls
       create         → { id: "…" }
     It used to require `events_received`, so every campaign write fell into
     the error branch and was recorded as failed while Meta had in fact
     applied it. That is worse than a plain failure: the budget moves and our
     books say it did not, so nothing ever moves it back. An `error` object in
     the body still loses, whatever the HTTP status says. */
  readBatchResult(res) {
    const j = res.json;
    if (res.ok && !j?.error) {
      if (typeof j?.events_received === "number") return { ok: true, accepted: j.events_received, raw: j };
      if (j?.success === true || j?.id != null) return { ok: true, accepted: 1, raw: j };
    }
    const err = j?.error;
    return {
      ok: false,
      error: err ? `${err.type || "error"} ${err.code ?? ""}: ${err.message || ""}`.trim()
        : res.error || `HTTP ${res.status}`,
      raw: j ?? res.text ?? null,
    };
  },

  async accounts() {
    const token = env("META_CAPI_TOKEN");
    if (!token) return { ok: false, reason: "META_CAPI_TOKEN missing", accounts: [] };
    const res = await httpJson(
      `${this.base()}/me/adaccounts?fields=id,account_id,name,currency,account_status&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { ok: false, reason: this.readBatchResult(res).error, accounts: [] };
    return {
      ok: true,
      accounts: (res.json?.data || []).map((a) => ({
        platform: "meta", id: a.id, accountId: a.account_id, name: a.name,
        currency: a.currency, status: a.account_status === 1 ? "active" : "inactive",
      })),
    };
  },

  async campaigns() {
    const token = env("META_CAPI_TOKEN");
    const act = this.actId();
    if (!token || !act) return { ok: false, reason: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing", campaigns: [] };
    const fields = "id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time";
    const res = await httpJson(`${this.base()}/${act}/campaigns?fields=${fields}&limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, reason: this.readBatchResult(res).error, campaigns: [] };
    return {
      ok: true,
      campaigns: (res.json?.data || []).map((c) => ({
        platform: "meta",
        id: c.id,
        name: c.name,
        status: c.status,                       // ACTIVE | PAUSED | ARCHIVED
        effectiveStatus: c.effective_status,
        objective: c.objective,
        // Meta returns money in MINOR units, as a string.
        dailyBudget: c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
        lifetimeBudget: c.lifetime_budget != null ? Number(c.lifetime_budget) / 100 : null,
        startTime: c.start_time || null,
        stopTime: c.stop_time || null,
      })),
    };
  },

  async insights({ from, to }) {
    const token = env("META_CAPI_TOKEN");
    const act = this.actId();
    if (!token || !act) return { ok: false, reason: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing", rows: [] };
    const fields = "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions,action_values";
    const tr = encodeURIComponent(JSON.stringify({ since: from, until: to }));
    const res = await httpJson(
      `${this.base()}/${act}/insights?level=campaign&fields=${fields}&time_range=${tr}&limit=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { ok: false, reason: this.readBatchResult(res).error, rows: [] };
    return {
      ok: true,
      // Meta insights return every metric as a STRING. Parse before use.
      rows: (res.json?.data || []).map((r) => {
        const purchases = (r.actions || []).find((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
        const value = (r.action_values || []).find((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
        return {
          platform: "meta",
          campaignId: r.campaign_id,
          campaignName: r.campaign_name,
          spend: Number(r.spend || 0),
          impressions: Number(r.impressions || 0),
          clicks: Number(r.clicks || 0),
          results: purchases ? Number(purchases.value || 0) : null,
          resultValue: value ? Number(value.value || 0) : null,
        };
      }),
    };
  },

  // POST /{campaign_id}  status=ACTIVE|PAUSED
  stateCall(id, state) {
    return {
      url: `${this.base()}/${id}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { status: state, access_token: env("META_CAPI_TOKEN") },
    };
  },
  // POST /{campaign_id}  daily_budget=<minor units of account currency>
  budgetCall(id, dailyBudget) {
    return {
      url: `${this.base()}/${id}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { daily_budget: Math.round(dailyBudget * 100), access_token: env("META_CAPI_TOKEN") },
    };
  },
};

/* ─── TikTok ──────────────────────────────────────────────────────────────
   Events API 2.0 (v1.3)
     POST https://business-api.tiktok.com/open_api/v1.3/event/track/
     header Access-Token: <token>
     body { event_source, event_source_id, data:[{ event, event_time(sec),
            event_id, user:{email,phone,external_id}, properties:{value,
            currency,order_id,content_type} }], test_event_code? }
     Response is HTTP 200 even on failure — the truth is `code` (0 = success).
     docs https://business-api.tiktok.com/portal/docs/events-api-2.0/v1.3
   Marketing (same v1.3 base):
     campaign/get/, campaign/status/update/ (ENABLE|DISABLE),
     campaign/update/ (budget), report/integrated/get/                        */
const tiktok = {
  id: "tiktok",
  label: "TikTok",
  conversionEnv: ["TIKTOK_PIXEL_ID", "TIKTOK_ACCESS_TOKEN"],
  manageEnv: ["TIKTOK_ADVERTISER_ID", "TIKTOK_ACCESS_TOKEN"],
  eventName: "Purchase",
  base: "https://business-api.tiktok.com/open_api/v1.3",

  buildBatch(events) {
    const pixel = env("TIKTOK_PIXEL_ID");
    const token = env("TIKTOK_ACCESS_TOKEN");
    if (!pixel || !token) return null;
    const data = events.map((e) => {
      const user = {};
      const em = hashEmail(e.email);
      const ph = hashPhonePlus(e.phoneDigits);   // TikTok wants the '+' hashed in
      if (em) user.email = em;
      if (ph) user.phone = ph;
      if (e.externalId) user.external_id = sha256(String(e.externalId));
      return {
        event: e.eventName || "Purchase",
        event_time: Math.floor(e.eventTime.getTime() / 1000),
        event_id: String(e.eventId),
        user,
        properties: {
          value: e.value,
          currency: e.currency,
          content_type: "product",
          ...(e.orderId ? { order_id: String(e.orderId) } : {}),
          ...(e.contentCategory ? { description: e.contentCategory } : {}),
          ...(e.contents ? {
            contents: e.contents.map((i) => ({
              content_id: String(i.id), content_name: i.name,
              quantity: i.quantity, price: i.unitPrice,
            })),
          } : {}),
        },
      };
    });
    const body = {
      // 'offline' is the honest source for a restaurant till. Override with
      // TIKTOK_EVENT_SOURCE=web only if the pixel id is a web pixel.
      // NB: no partner_name — TikTok 40002-rejects it for non-registered
      // partners (verified live 2026-08-07).
      event_source: env("TIKTOK_EVENT_SOURCE") || "offline",
      event_source_id: pixel,
      data,
    };
    const testCode = env("TIKTOK_TEST_EVENT_CODE");
    if (testCode) body.test_event_code = testCode;
    return {
      url: `${this.base}/event/track/`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body,
    };
  },

  readBatchResult(res, n) {
    const j = res.json;
    if (res.ok && j && j.code === 0) return { ok: true, accepted: n, raw: j };
    return {
      ok: false,
      error: j ? `code ${j.code}: ${j.message || ""}` : res.error || `HTTP ${res.status}`,
      raw: j ?? res.text ?? null,
    };
  },

  hdr() { return { "Content-Type": "application/json", "Access-Token": env("TIKTOK_ACCESS_TOKEN") }; },
  advId() { return env("TIKTOK_ADVERTISER_ID"); },

  async accounts() {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = this.advId();
    if (!token || !adv) return { ok: false, reason: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing", accounts: [] };
    const q = `advertiser_ids=${encodeURIComponent(JSON.stringify(adv.split(",").map((s) => s.trim())))}`;
    const res = await httpJson(`${this.base}/advertiser/info/?${q}`, { headers: this.hdr() });
    const r = this.readBatchResult(res, 0);
    if (!r.ok) return { ok: false, reason: r.error, accounts: [] };
    return {
      ok: true,
      accounts: (res.json?.data?.list || []).map((a) => ({
        platform: "tiktok", id: String(a.advertiser_id), accountId: String(a.advertiser_id),
        name: a.name || a.advertiser_name, currency: a.currency, status: a.status,
      })),
    };
  },

  async campaigns() {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = this.advId();
    if (!token || !adv) return { ok: false, reason: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing", campaigns: [] };
    const res = await httpJson(`${this.base}/campaign/get/?advertiser_id=${encodeURIComponent(adv)}&page_size=100`, {
      headers: this.hdr(),
    });
    const r = this.readBatchResult(res, 0);
    if (!r.ok) return { ok: false, reason: r.error, campaigns: [] };
    return {
      ok: true,
      campaigns: (res.json?.data?.list || []).map((c) => ({
        platform: "tiktok",
        id: String(c.campaign_id),
        name: c.campaign_name,
        // TikTok's own vocabulary: operation_status ENABLE|DISABLE is the
        // on/off switch; secondary_status is why it is (or is not) running.
        status: c.operation_status === "ENABLE" ? "ACTIVE" : "PAUSED",
        rawStatus: c.operation_status,
        effectiveStatus: c.secondary_status,
        objective: c.objective_type,
        dailyBudget: c.budget_mode === "BUDGET_MODE_DAY" ? Number(c.budget || 0) : null,
        lifetimeBudget: c.budget_mode === "BUDGET_MODE_TOTAL" ? Number(c.budget || 0) : null,
        startTime: c.create_time || null,
        stopTime: null,
      })),
    };
  },

  async insights({ from, to }) {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = this.advId();
    if (!token || !adv) return { ok: false, reason: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing", rows: [] };
    const params = new URLSearchParams({
      advertiser_id: adv,
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", "conversion", "total_purchase_value"]),
      start_date: from,
      end_date: to,
      page_size: "200",
    });
    const res = await httpJson(`${this.base}/report/integrated/get/?${params}`, { headers: this.hdr() });
    const r = this.readBatchResult(res, 0);
    if (!r.ok) return { ok: false, reason: r.error, rows: [] };
    return {
      ok: true,
      rows: (res.json?.data?.list || []).map((row) => ({
        platform: "tiktok",
        campaignId: String(row.dimensions?.campaign_id ?? ""),
        campaignName: row.metrics?.campaign_name || "",
        spend: Number(row.metrics?.spend || 0),
        impressions: Number(row.metrics?.impressions || 0),
        clicks: Number(row.metrics?.clicks || 0),
        results: Number(row.metrics?.conversion || 0),
        resultValue: Number(row.metrics?.total_purchase_value || 0),
      })),
    };
  },

  stateCall(id, state) {
    return {
      url: `${this.base}/campaign/status/update/`,
      method: "POST",
      headers: this.hdr(),
      body: {
        advertiser_id: this.advId(),
        campaign_ids: [String(id)],
        operation_status: state === "ACTIVE" ? "ENABLE" : "DISABLE",
      },
    };
  },
  budgetCall(id, dailyBudget) {
    return {
      url: `${this.base}/campaign/update/`,
      method: "POST",
      headers: this.hdr(),
      body: {
        advertiser_id: this.advId(),
        campaign_id: String(id),
        // TikTok budgets are in whole account-currency units, not minor units.
        budget: Number(dailyBudget),
        budget_mode: "BUDGET_MODE_DAY",
      },
    };
  },
};

/* ─── Snapchat ────────────────────────────────────────────────────────────
   Conversions API v3
     POST https://tr.snapchat.com/v3/{PIXEL_ID}/events?access_token=…
     body { data:[{ event_name:"PURCHASE", event_time(sec), event_id,
            action_source:"OFFLINE", user_data:{em:[..],ph:[..]},
            custom_data:{currency,value,order_id} }] }
     There is a twin /events/validate endpoint that checks a payload without
     recording it — that is what `dryRun` should be pointed at first.
     docs https://developers.snap.com/marketing-api/Conversions-API/UsingTheAPI
   Marketing API (adsapi.snapchat.com/v1) is a DIFFERENT credential: OAuth2
   client id/secret + refresh token. Budgets are `daily_budget_micro`.          */
const snapchat = {
  id: "snapchat",
  label: "Snapchat",
  conversionEnv: ["SNAP_PIXEL_ID", "SNAP_ACCESS_TOKEN"],
  manageEnv: ["SNAP_AD_ACCOUNT_ID", "SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET", "SNAP_REFRESH_TOKEN"],
  eventName: "PURCHASE",

  // Snap rejects an identityless event with code 507 — same rule as Meta's
  // 2804050 (verified live 2026-08-07). Skip rather than burn the batch.
  usable(e) { return !!(e.phoneDigits || e.email || e.externalId); },
  capiBase: "https://tr.snapchat.com/v3",
  apiBase: "https://adsapi.snapchat.com/v1",
  _tok: null,
  _tokAt: 0,

  buildBatch(events, { validate = false } = {}) {
    const pixel = env("SNAP_PIXEL_ID");
    const token = env("SNAP_ACCESS_TOKEN");
    if (!pixel || !token) return null;
    const data = events.map((e) => {
      const user_data = {};
      const em = hashEmail(e.email);
      const ph = hashPhoneDigits(e.phoneDigits);   // digits only, no '+'
      if (em) user_data.em = [em];
      if (ph) user_data.ph = [ph];
      if (e.externalId) user_data.external_id = [sha256(String(e.externalId))];
      return {
        event_name: (e.snapEventName || "PURCHASE"),
        event_time: Math.floor(e.eventTime.getTime() / 1000),
        event_id: String(e.eventId),
        action_source: "OFFLINE",
        user_data,
        custom_data: {
          currency: e.currency,
          value: String(e.value),
          ...(e.orderId ? { order_id: String(e.orderId) } : {}),
          ...(e.contentCategory ? { content_category: [e.contentCategory] } : {}),
          ...(e.contents ? {
            content_ids: e.contents.map((i) => String(i.id)),
            number_items: String(e.numItems),
          } : {}),
        },
      };
    });
    return {
      url: `${this.capiBase}/${pixel}/events${validate ? "/validate" : ""}?access_token=${token}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { data },
    };
  },

  readBatchResult(res, n) {
    const j = res.json;
    // Snap answers { status: "VALID" | "INVALID", reason: "…" }
    if (res.ok && (!j || j.status === "VALID" || j.status === "SUCCESS")) return { ok: true, accepted: n, raw: j };
    return {
      ok: false,
      error: j ? `${j.status || "error"}: ${j.reason || j.message || ""}` : res.error || `HTTP ${res.status}`,
      raw: j ?? res.text ?? null,
    };
  },

  // Marketing API bearer. SNAP_MARKETING_TOKEN short-circuits the OAuth dance.
  async token() {
    const direct = env("SNAP_MARKETING_TOKEN");
    if (direct) return direct;
    const id = env("SNAP_CLIENT_ID"), secret = env("SNAP_CLIENT_SECRET"), refresh = env("SNAP_REFRESH_TOKEN");
    if (!id || !secret || !refresh) return null;
    if (this._tok && Date.now() - this._tokAt < 25 * 60 * 1000) return this._tok;
    const res = await httpJson("https://accounts.snapchat.com/login/oauth2/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
    });
    if (!res.ok || !res.json?.access_token) return null;
    this._tok = res.json.access_token;
    this._tokAt = Date.now();
    return this._tok;
  },

  async accounts() {
    const t = await this.token();
    if (!t) return { ok: false, reason: "SNAP_CLIENT_ID / SNAP_CLIENT_SECRET / SNAP_REFRESH_TOKEN missing or refused", accounts: [] };
    const res = await httpJson(`${this.apiBase}/me/organizations?with_ad_accounts=true`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!res.ok) return { ok: false, reason: res.json?.debug_message || res.error || `HTTP ${res.status}`, accounts: [] };
    const out = [];
    for (const o of res.json?.organizations || []) {
      for (const a of o.organization?.ad_accounts || []) {
        out.push({
          platform: "snapchat", id: a.id, accountId: a.id, name: a.name,
          currency: a.currency, status: a.status,
          organizationId: o.organization?.id,
        });
      }
    }
    return { ok: true, accounts: out };
  },

  async campaigns() {
    const t = await this.token();
    const acct = env("SNAP_AD_ACCOUNT_ID");
    if (!t || !acct) return { ok: false, reason: "SNAP_AD_ACCOUNT_ID / Snap OAuth credentials missing", campaigns: [] };
    const res = await httpJson(`${this.apiBase}/adaccounts/${acct}/campaigns?limit=200`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!res.ok) return { ok: false, reason: res.json?.debug_message || res.error || `HTTP ${res.status}`, campaigns: [] };
    return {
      ok: true,
      campaigns: (res.json?.campaigns || []).map((w) => {
        const c = w.campaign || w;
        return {
          platform: "snapchat",
          id: c.id,
          name: c.name,
          status: c.status,                         // ACTIVE | PAUSED
          effectiveStatus: c.delivery_status ? String(c.delivery_status) : null,
          objective: c.objective_v2_properties?.objective_v2_type || c.objective || null,
          dailyBudget: c.daily_budget_micro != null ? Number(c.daily_budget_micro) / 1e6 : null,
          lifetimeBudget: c.lifetime_spend_cap_micro != null ? Number(c.lifetime_spend_cap_micro) / 1e6 : null,
          startTime: c.start_time || null,
          stopTime: c.end_time || null,
        };
      }),
    };
  },

  async insights({ from, to }) {
    const t = await this.token();
    const acct = env("SNAP_AD_ACCOUNT_ID");
    if (!t || !acct) return { ok: false, reason: "SNAP_AD_ACCOUNT_ID / Snap OAuth credentials missing", rows: [] };
    const list = await this.campaigns();
    if (!list.ok) return { ok: false, reason: list.reason, rows: [] };
    const rows = [];
    /* Snap rejects any stats window that does not land on an hour boundary:
       "Unsupported Stats Query: End time should end at the beginning of an
       hour." A T23:59:59 end is therefore not "the end of `to`", it is an
       error — and the row came back as a clean zero, so Snap spend read as
       0.00 everywhere (scorecard, attribution, the autopilot's own snapshot)
       with nothing to say it had failed. The end is exclusive, so the day
       AFTER `to` at 00:00:00 is the window that actually means "through the
       end of `to`". */
    const endExclusive = (() => {
      const d = new Date(`${to}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    for (const c of list.campaigns) {
      const params = new URLSearchParams({
        granularity: "TOTAL",
        fields: "spend,impressions,swipes,conversion_purchases,conversion_purchases_value",
        start_time: `${from}T00:00:00.000-00:00`,
        end_time: `${endExclusive}T00:00:00.000-00:00`,
      });
      const res = await httpJson(`${this.apiBase}/campaigns/${c.id}/stats?${params}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      const s = res.json?.total_stats?.[0]?.total_stat?.stats || {};
      rows.push({
        platform: "snapchat",
        campaignId: c.id,
        campaignName: c.name,
        // Snap reports spend in micros of the account currency.
        spend: s.spend != null ? Number(s.spend) / 1e6 : 0,
        impressions: Number(s.impressions || 0),
        clicks: Number(s.swipes || 0),
        results: Number(s.conversion_purchases || 0),
        resultValue: s.conversion_purchases_value != null ? Number(s.conversion_purchases_value) / 1e6 : 0,
        ...(res.ok ? {} : { error: res.json?.debug_message || res.error || `HTTP ${res.status}` }),
      });
    }
    return { ok: true, rows };
  },

  // PATCH is the partial update. A PUT here would reset every attribute we
  // omitted back to its default — Snap says so explicitly. Never PUT.
  stateCall(id, state) {
    const acct = env("SNAP_AD_ACCOUNT_ID");
    return {
      url: `${this.apiBase}/adaccounts/${acct}/campaigns/${id}`,
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ***resolved-at-send***" },
      body: { campaigns: [{ id: String(id), status: state }] },
    };
  },
  budgetCall(id, dailyBudget) {
    const acct = env("SNAP_AD_ACCOUNT_ID");
    return {
      url: `${this.apiBase}/adaccounts/${acct}/campaigns/${id}`,
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ***resolved-at-send***" },
      body: { campaigns: [{ id: String(id), daily_budget_micro: Math.round(dailyBudget * 1e6) }] },
    };
  },
  async authorize(call) {
    const t = await this.token();
    if (!t) return null;
    return { ...call, headers: { ...call.headers, Authorization: `Bearer ${t}` } };
  },
};

/* ─── Google Ads ──────────────────────────────────────────────────────────
   BE HONEST: this one mostly does not apply to us.

   Offline conversion import (ConversionUploadService.UploadClickConversions)
   requires, per conversion, EXACTLY ONE of gclid / gbraid / wbraid — the click
   id Google stamps on a click through to YOUR website. Fresh Cuts has no
   online checkout and no landing page that captures a gclid, so there is
   simply nothing to key a click conversion on.

   The escape hatch is "Enhanced conversions for leads": upload a ClickConversion
   carrying hashed first-party identifiers (email / phone) instead of a gclid.
   Google then matches on the identifier. That only works if (a) the conversion
   action is a *lead* type created for this purpose and (b) we actually hold an
   identifier — which for our delivery orders we do not, and for in-house orders
   we hold a phone for roughly a third of tickets.

   So: the adapter is wired and will build a correct request, but it stays OFF
   unless GOOGLE_ADS_ENABLE=1 is set deliberately, and even then it skips every
   event with no identifier rather than sending an unmatched row.

   docs https://developers.google.com/google-ads/api/docs/conversions/upload-offline
        https://developers.google.com/google-ads/api/docs/conversions/legacy_oci_guide
   Note: from 15 June 2026 an UploadClickConversion request fails outright if
   the developer token has never previously been used for offline conversion
   uploads — i.e. there is a Google-side enablement step, not just a token.     */
const google = {
  id: "google",
  label: "Google Ads",
  conversionEnv: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_CONVERSION_ACTION_ID"],
  manageEnv: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"],
  eventName: "Purchase",
  ver: () => env("GOOGLE_ADS_API_VERSION") || "v21",
  enabled: () => process.env.GOOGLE_ADS_ENABLE === "1",
  note: "Needs a gclid (we never capture one — no online checkout) or Enhanced Conversions for Leads with a hashed phone/email. Off unless GOOGLE_ADS_ENABLE=1.",
  _tok: null,
  _tokAt: 0,

  buildBatch(events) {
    if (!this.enabled()) return null;
    const cust = env("GOOGLE_ADS_CUSTOMER_ID").replace(/\D/g, "");
    const action = env("GOOGLE_ADS_CONVERSION_ACTION_ID");
    if (!cust || !action) return null;
    // Only events that carry an identifier are worth uploading. A conversion
    // with neither gclid nor user identifier is rejected outright.
    const usable = events.filter((e) => e.phoneDigits || e.email || e.gclid);
    if (!usable.length) return null;
    return {
      url: `https://googleads.googleapis.com/${this.ver()}/customers/${cust}:uploadClickConversions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ***resolved-at-send***",
        "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN"),
        ...(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID") ? { "login-customer-id": env("GOOGLE_ADS_LOGIN_CUSTOMER_ID").replace(/\D/g, "") } : {}),
      },
      body: {
        conversions: usable.map((e) => ({
          conversionAction: `customers/${cust}/conversionActions/${action}`,
          conversionDateTime: googleDateTime(e.eventTime),
          conversionValue: e.value,
          currencyCode: e.currency,
          orderId: e.orderId ? String(e.orderId) : undefined,
          ...(e.gclid ? { gclid: e.gclid } : {}),
          userIdentifiers: [
            ...(e.email ? [{ hashedEmail: hashEmail(e.email) }] : []),
            ...(e.phoneDigits ? [{ hashedPhoneNumber: hashPhonePlus(e.phoneDigits) }] : []),
          ],
        })),
        partialFailure: true,
      },
    };
  },

  readBatchResult(res, n) {
    if (res.ok && res.json && !res.json.partialFailureError) return { ok: true, accepted: n, raw: res.json };
    return {
      ok: false,
      error: res.json?.error?.message || res.json?.partialFailureError?.message || res.error || `HTTP ${res.status}`,
      raw: res.json ?? res.text ?? null,
    };
  },

  async token() {
    const id = env("GOOGLE_ADS_CLIENT_ID"), secret = env("GOOGLE_ADS_CLIENT_SECRET"), refresh = env("GOOGLE_ADS_REFRESH_TOKEN");
    if (!id || !secret || !refresh) return null;
    if (this._tok && Date.now() - this._tokAt < 25 * 60 * 1000) return this._tok;
    const res = await httpJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
    });
    if (!res.ok || !res.json?.access_token) return null;
    this._tok = res.json.access_token;
    this._tokAt = Date.now();
    return this._tok;
  },
  async authorize(call) {
    const t = await this.token();
    if (!t) return null;
    return { ...call, headers: { ...call.headers, Authorization: `Bearer ${t}` } };
  },

  async accounts() {
    return { ok: false, reason: `not wired: ${this.note}`, accounts: [] };
  },
  async campaigns() {
    return { ok: false, reason: `not wired: ${this.note} Campaign listing needs a GAQL search call and an approved developer token.`, campaigns: [] };
  },
  async insights() {
    return { ok: false, reason: `not wired: ${this.note}`, rows: [] };
  },
  stateCall(id, state) {
    return { url: `https://googleads.googleapis.com/${this.ver()}/customers/.../campaigns:mutate`, method: "POST", headers: {}, body: { note: "Google campaign mutate is not implemented — needs an approved developer token (basic access) first.", id, state } };
  },
  budgetCall(id, dailyBudget) {
    return { url: `https://googleads.googleapis.com/${this.ver()}/customers/.../campaignBudgets:mutate`, method: "POST", headers: {}, body: { note: "Google budget mutate is not implemented — campaign budgets are separate CampaignBudget resources.", id, dailyBudget } };
  },
};

function googleDateTime(d) {
  // Google wants "yyyy-mm-dd hh:mm:ss+|-hh:mm". We are Asia/Riyadh, UTC+03:00.
  const t = new Date(d.getTime() + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+03:00`;
}

const PLATFORMS = [meta, tiktok, snapchat, google];
const byId = (id) => PLATFORMS.find((p) => p.id === String(id || "").toLowerCase());

const canSend = (p) => missingOf(p.conversionEnv).length === 0 && (p.id !== "google" || p.enabled());
const canManage = (p) => missingOf(p.manageEnv).length === 0 && p.id !== "google";

/* ═══════════════════════════════════════════════════════════════════════
   REGISTER
   ═══════════════════════════════════════════════════════════════════════ */

export function register(app, ctx, deps = {}) {
  const { pool, requireAdmin, jb, todayISO, daysAgoISO, normPhone } = ctx;
  /* attribution.register بتتنده بعدنا (محتاجة تقرا PLATFORMS مننا)، فالمرجع
     بيوصل كدالة بدل قيمة — نفس حيلة promo. مفيش دور استيراد ومفيش ترتيب
     تسجيل هش، والمرجع بيتحل وقت الطلب مش وقت الإقلاع. */
  const attributionOf = typeof deps.attribution === "function" ? deps.attribution : () => deps.attribution || null;

  /* ─── schema ─────────────────────────────────────────────────────────
     UNIQUE(order_id, platform, event_name) IS the deduplication guarantee.
     order_id is nullable on purpose: ad-hoc events fired through
     /api/ads/event have no order behind them, and Postgres treats NULLs in
     a unique index as distinct, so they never collide with each other.    */
  async function ensureAdsSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ads_events (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        event_name TEXT,
        event_time TIMESTAMPTZ,
        value NUMERIC,
        currency TEXT DEFAULT 'SAR',
        platform TEXT,
        status TEXT,                              -- pending|sent|failed|skipped
        request JSONB,
        response JSONB,
        attempts INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(order_id, platform, event_name)
      );
      CREATE INDEX IF NOT EXISTS ads_events_platform_idx ON ads_events(platform, status);
      CREATE INDEX IF NOT EXISTS ads_events_time_idx ON ads_events(event_time);
      CREATE TABLE IF NOT EXISTS ads_accounts (
        id TEXT PRIMARY KEY,
        platform TEXT,
        account_id TEXT,
        name TEXT,
        config JSONB,
        active BOOL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  ensureAdsSchema()
    .then(() => console.log("[ads] schema ready"))
    .catch((e) => console.error("[ads] schema failed:", e.message));

  /* ─── order → normalised event ───────────────────────────────────────
     Same exclusions analytics.js uses (rule B) and `total` for money
     (rule A). Identity comes from ts_customers first (POS customer record)
     and the cashier station second (order_sources.phone_norm), which is the
     only identity our aggregator orders could ever gain.                  */
  const SALES_ONLY = `(o.order_type IS NULL OR (o.order_type NOT ILIKE '%void%' AND o.order_type NOT ILIKE '%refund%'))`;

  async function loadOrders(from, to, limit = 5000) {
    const r = await pool.query(
      `SELECT o.order_id, o.order_date, o.calendar_day, o.order_type, o.order_option,
              o.total, o.customer_id, o.branch,
              COALESCE(NULLIF(s.phone_norm,''), NULLIF(tc.phone_norm,'')) AS phone_norm,
              NULLIF(tc.email,'') AS email,
              s.source AS src, s.source_note AS src_note
         FROM ts_orders o
         LEFT JOIN ts_customers tc ON tc.customer_id = o.customer_id
         LEFT JOIN order_sources s ON s.order_id = o.order_id
        WHERE ${SALES_ONLY}
          AND o.calendar_day >= $1::date AND o.calendar_day <= $2::date
          AND COALESCE(o.total, 0) > 0
        ORDER BY o.order_date ASC
        LIMIT $3`,
      [from, to, limit]
    );
    return r.rows;
  }

  /* ─── basket contents ────────────────────────────────────────────────
     "What did they buy" is the half of a Purchase the optimisers use to
     find look-alike buyers and to power catalog ads. TabSense gives us the
     item NAME, so we map it onto the catalog product id — a purchase that
     carries the same id as the feed is one the platform can act on.       */
  let menuIdx = { at: 0, byName: new Map() };
  const normName = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

  async function menuIndex() {
    if (menuIdx.byName.size && Date.now() - menuIdx.at < 15 * 60_000) return menuIdx.byName;
    try {
      const rows = await menuRows();
      const m = new Map();
      for (const r of rows) m.set(normName(r.title), r.id);
      menuIdx = { at: Date.now(), byName: m };
    } catch (e) {
      console.error("[ads] menu index failed:", e.message);   // fall back to names
    }
    return menuIdx.byName;
  }

  async function loadItems(orderIds) {
    if (!orderIds.length) return new Map();
    const r = await pool.query(
      `SELECT order_id, name, qty, amount FROM ts_order_items
        WHERE order_id = ANY($1::text[]) ORDER BY order_id, idx`, [orderIds]);
    const idx = await menuIndex();
    const out = new Map();
    for (const row of r.rows) {
      const qty = Math.max(1, Math.round(Number(row.qty) || 1));
      const total = Number(row.amount) || 0;
      const id = idx.get(normName(row.name)) || null;
      if (!out.has(row.order_id)) out.set(row.order_id, []);
      out.get(row.order_id).push({
        id: id || `n:${normName(row.name).slice(0, 60)}`,   // اسم كبديل لو الصنف مش في الكاتالوج
        matched: !!id,
        name: String(row.name || "").trim(),
        quantity: qty,
        unitPrice: Math.round((total / qty) * 100) / 100,
      });
    }
    return out;
  }

  // Channel label the platforms can slice on: "delivery:keeta" / "delivery"
  // for aggregator orders, "instore" for everything punched at the till.
  // External order_type is the POS truth; the cashier/FeedUs tag adds the app.
  function channelOf(row) {
    const isDelivery = row.src === "delivery_app" || /external/i.test(row.order_type || "");
    if (!isDelivery) return "instore";
    const app = (row.src_note || "").trim().toLowerCase();
    return app ? `delivery:${app}` : "delivery";
  }

  // A restaurant sale, expressed the same way for every platform.
  function toEvent(row, eventName = "Purchase", items = null) {
    const digits = row.phone_norm ? phoneDigits(row.phone_norm, normPhone) : null;
    return {
      eventId: String(row.order_id),          // TabSense order id IS the dedup key
      orderId: String(row.order_id),
      eventName,
      snapEventName: eventName === "Purchase" ? "PURCHASE" : eventName.toUpperCase(),
      eventTime: new Date(row.order_date),
      // TabSense stores float noise (57.999999991). Round to halalas.
      value: Math.round(Number(row.total || 0) * 100) / 100,
      currency: DEFAULT_CURRENCY,
      phoneDigits: digits,
      email: row.email || null,
      externalId: row.customer_id || null,
      contentCategory: channelOf(row),
      contents: items && items.length ? items : null,
      numItems: items ? items.reduce((a, i) => a + i.quantity, 0) : null,
      // A till sale in Jeddah is not a website conversion. Saying so is both
      // truthful and what unlocks offline/store optimisation on each platform.
      actionSource: "physical_store",
      matchKeys: [digits ? "phone" : null, row.email ? "email" : null, row.customer_id ? "customer_id" : null]
        .filter(Boolean),
    };
  }

  function adHocEvent(body) {
    const digits = body.phone ? phoneDigits(body.phone, normPhone) : null;
    const name = body.eventName || "Purchase";
    const when = body.eventTime ? new Date(body.eventTime) : new Date();
    return {
      eventId: String(body.orderId || body.eventId || crypto.randomUUID()),
      orderId: body.orderId ? String(body.orderId) : null,
      eventName: name,
      snapEventName: name === "Purchase" ? "PURCHASE" : name.toUpperCase(),
      eventTime: Number.isFinite(when.getTime()) ? when : new Date(),
      value: Math.round(Number(body.value || 0) * 100) / 100,
      currency: body.currency || DEFAULT_CURRENCY,
      phoneDigits: digits,
      email: body.email || null,
      externalId: body.externalId || null,
      actionSource: body.actionSource || "physical_store",
      matchKeys: [digits ? "phone" : null, body.email ? "email" : null].filter(Boolean),
    };
  }

  /* ─── dedup claim ────────────────────────────────────────────────────
     Insert a `pending` row per (order, platform, event). If the row already
     exists we DO NOT send again — unless the previous attempt failed, in
     which case a retry is the whole point. This is the single place that
     decides "has this order already been reported to this platform".      */
  async function claim(ev, platform, requestSummary) {
    const id = ev.orderId
      ? `${platform}:${ev.eventName}:${ev.orderId}`
      : `${platform}:${ev.eventName}:${crypto.randomUUID()}`;
    const ins = await pool.query(
      `INSERT INTO ads_events (id, order_id, event_name, event_time, value, currency, platform, status, request, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,1)
       ON CONFLICT (order_id, platform, event_name) DO NOTHING
       RETURNING id`,
      [id, ev.orderId, ev.eventName, ev.eventTime, ev.value, ev.currency, platform, jb(requestSummary)]
    );
    if (ins.rowCount) return { id, fresh: true };

    const cur = await pool.query(
      `SELECT id, status, attempts FROM ads_events WHERE order_id=$1 AND platform=$2 AND event_name=$3`,
      [ev.orderId, platform, ev.eventName]
    );
    const row = cur.rows[0];
    if (!row) return { id: null, fresh: false, reason: "conflict without row" };
    if (row.status === "failed") {
      await pool.query(
        `UPDATE ads_events SET status='pending', attempts=attempts+1, request=$2 WHERE id=$1`,
        [row.id, jb(requestSummary)]
      );
      return { id: row.id, fresh: true, retry: true };
    }
    return { id: row.id, fresh: false, reason: `already ${row.status}` };
  }

  async function finish(ids, status, response) {
    if (!ids.length) return;
    await pool.query(`UPDATE ads_events SET status=$2, response=$3 WHERE id = ANY($1::text[])`,
      [ids, status, jb(response)]);
  }

  /* ─── the sender: build → claim → chunk → POST → record ──────────────
     Never throws. A dead platform produces { failed: n, errors: [...] }.  */
  async function sendToPlatform(p, events, { dryRun = false } = {}) {
    const out = { platform: p.id, label: p.label, attempted: events.length, sent: 0, skipped: 0, failed: 0, errors: [] };

    if (!canSend(p)) {
      out.attempted = 0;
      out.skipped = events.length;
      out.errors.push(`not configured — missing ${missingOf(p.conversionEnv).join(", ") || "GOOGLE_ADS_ENABLE=1"}`);
      return out;
    }

    // Platform-specific eligibility (e.g. Meta refuses empty user_data).
    // Unusable events are NOT claimed, so they remain eligible for a later
    // sync once the linking sweeps attach an identity to them.
    if (p.usable) {
      const eligible = events.filter((e) => p.usable(e));
      out.skipped += events.length - eligible.length;
      events = eligible;
    }

    if (dryRun) {
      const preview = p.buildBatch(events.slice(0, 3));
      out.dryRun = true;
      out.sent = 0;
      out.wouldSend = events.length;
      out.samplePayload = safeRequest(preview);
      out.matchQuality = matchQuality(events);
      return out;
    }

    // Claim first so two overlapping sync calls cannot double-report.
    const claimed = [];
    for (const ev of events) {
      let c;
      try {
        c = await claim(ev, p.id, { eventId: ev.eventId, value: ev.value, matchKeys: ev.matchKeys });
      } catch (e) {
        out.failed++;
        out.errors.push(`claim ${ev.eventId}: ${e.message}`);
        continue;
      }
      if (c.fresh) claimed.push({ ev, rowId: c.id });
      else out.skipped++;
    }
    if (!claimed.length) return out;

    for (let i = 0; i < claimed.length; i += BATCH_SIZE) {
      const chunk = claimed.slice(i, i + BATCH_SIZE);
      const ids = chunk.map((c) => c.rowId);
      let call = p.buildBatch(chunk.map((c) => c.ev));
      if (!call) {
        out.skipped += chunk.length;
        await finish(ids, "skipped", { reason: "adapter produced no payload (nothing usable in this batch)" });
        continue;
      }
      if (p.authorize) {
        const authed = await p.authorize(call);
        if (!authed) {
          out.failed += chunk.length;
          out.errors.push(`${p.id}: could not obtain an access token`);
          await finish(ids, "failed", { error: "token exchange failed" });
          continue;
        }
        call = authed;
      }
      const res = await httpJson(call.url, { method: call.method, headers: call.headers, body: call.body });
      const parsed = p.readBatchResult(res, chunk.length);
      if (parsed.ok) {
        out.sent += chunk.length;
        await finish(ids, "sent", { httpStatus: res.status, platform: parsed.raw ?? null, sentAt: new Date().toISOString() });
      } else {
        out.failed += chunk.length;
        out.errors.push(parsed.error);
        await finish(ids, "failed", { httpStatus: res.status, error: parsed.error, platform: redact(parsed.raw ?? null) });
      }
    }
    out.matchQuality = matchQuality(events);
    return out;
  }

  // How well can these events actually be attributed? The owner deserves the
  // number, not a green tick.
  function matchQuality(events) {
    const withPhone = events.filter((e) => e.phoneDigits).length;
    const withEmail = events.filter((e) => e.email).length;
    const withItems = events.filter((e) => e.contents && e.contents.length).length;
    const lines = events.flatMap((e) => e.contents || []);
    const matchedLines = lines.filter((i) => i.matched).length;
    return {
      total: events.length,
      withPhone,
      withEmail,
      identityless: events.filter((e) => !e.phoneDigits && !e.email).length,
      pctMatchable: events.length ? Math.round((withPhone / events.length) * 100) : 0,
      // Basket depth: an order with items teaches the optimiser far more than
      // a bare total, and a line matched to a catalog id can drive product ads.
      withItems,
      pctWithItems: events.length ? Math.round((withItems / events.length) * 100) : 0,
      itemLines: lines.length,
      itemLinesMatchedToCatalog: matchedLines,
      pctItemsInCatalog: lines.length ? Math.round((matchedLines / lines.length) * 100) : 0,
    };
  }

  function pickPlatforms(list) {
    if (!list || !list.length) return PLATFORMS;
    const want = list.map((s) => String(s).toLowerCase());
    return PLATFORMS.filter((p) => want.includes(p.id));
  }

  /* ═══ ROUTES ══════════════════════════════════════════════════════════ */

  /* GET /api/ads/status — what the owner's dashboard tile reads. */
  app.get("/api/ads/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let agg = { rows: [] };
    try {
      agg = await pool.query(
        `SELECT platform,
                max(created_at) FILTER (WHERE status='sent') AS last_sent_at,
                count(*) FILTER (WHERE status='sent'   AND created_at > NOW() - interval '24 hours')::int AS sent24h,
                count(*) FILTER (WHERE status='failed' AND created_at > NOW() - interval '24 hours')::int AS failed24h,
                count(*) FILTER (WHERE status='pending')::int AS pending,
                count(*) FILTER (WHERE status='sent')::int AS sent_total
           FROM ads_events GROUP BY platform`
      );
    } catch (e) {
      agg = { rows: [], error: e.message };
    }
    const stats = Object.fromEntries((agg.rows || []).map((r) => [r.platform, r]));
    return c.json({
      ok: true,
      writeEnabled: writeAllowed(),
      maxDailyBudget: MAX_DAILY_BUDGET,
      platforms: PLATFORMS.map((p) => {
        const s = stats[p.id] || {};
        const missConv = missingOf(p.conversionEnv);
        const missMan = missingOf(p.manageEnv);
        return {
          id: p.id,
          label: p.label,
          configured: canSend(p),
          canManageCampaigns: canManage(p),
          missing: missConv,                       // exact env vars still needed
          missingForCampaigns: missMan,
          lastSentAt: s.last_sent_at || null,
          sent24h: s.sent24h || 0,
          failed24h: s.failed24h || 0,
          pending: s.pending || 0,
          sentTotal: s.sent_total || 0,
          ...(p.note ? { note: p.note } : {}),
        };
      }),
    });
  });

  /* POST /api/ads/sync-orders {from, to, platforms?, dryRun?} */
  app.post("/api/ads/sync-orders", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const to = b.to || todayISO();
    const from = b.from || daysAgoISO(7);
    const dryRun = b.dryRun === true || b.dryRun === "1";
    const targets = pickPlatforms(b.platforms);

    let rows;
    try {
      rows = await loadOrders(from, to, Number(b.limit) || 5000);
    } catch (e) {
      return c.json({ ok: false, error: `could not read ts_orders: ${e.message}` }, 500);
    }
    let itemsByOrder = new Map();
    try { itemsByOrder = await loadItems(rows.map((r) => String(r.order_id))); }
    catch (e) { console.error("[ads] items load failed:", e.message); }  // basket is a bonus, never a blocker
    const events = rows.map((r) => toEvent(r, b.eventName || "Purchase", itemsByOrder.get(String(r.order_id)) || null));

    const results = {};
    for (const p of targets) {
      try {
        results[p.id] = await sendToPlatform(p, events, { dryRun });
      } catch (e) {
        // Rule D: a platform can never take the route down with it.
        results[p.id] = { platform: p.id, label: p.label, attempted: events.length, sent: 0, skipped: 0, failed: events.length, errors: [String(e.message || e)] };
      }
    }
    return c.json({
      ok: true,
      range: { from, to },
      orders: events.length,
      dryRun,
      matchQuality: matchQuality(events),
      ...(dryRun ? { samplePayloads: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.samplePayload || null])) } : {}),
      platforms: results,
    });
  });

  /* POST /api/ads/event — one event, for firing in real time later. */
  app.post("/api/ads/event", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    if (!b.eventName) return c.json({ ok: false, error: "eventName is required" }, 400);
    if (b.value == null) return c.json({ ok: false, error: "value is required" }, 400);
    const ev = adHocEvent(b);
    const targets = pickPlatforms(b.platforms);
    const results = {};
    for (const p of targets) {
      try {
        results[p.id] = await sendToPlatform(p, [ev], { dryRun: b.dryRun === true });
      } catch (e) {
        results[p.id] = { platform: p.id, attempted: 1, sent: 0, skipped: 0, failed: 1, errors: [String(e.message || e)] };
      }
    }
    return c.json({ ok: true, event: { ...ev, eventTime: ev.eventTime.toISOString(), phoneDigits: ev.phoneDigits ? "***" : null, email: ev.email ? "***" : null }, platforms: results });
  });

  /* GET /api/ads/accounts — live from each platform, or [] with the reason. */
  app.get("/api/ads/accounts", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const only = c.req.query("platform");
    const targets = only ? pickPlatforms([only]) : PLATFORMS;
    const accounts = [];
    const reasons = {};
    for (const p of targets) {
      try {
        const r = await p.accounts();
        if (r.ok) accounts.push(...r.accounts); else reasons[p.id] = r.reason;
      } catch (e) {
        reasons[p.id] = String(e.message || e);
      }
    }
    return c.json({ ok: true, accounts, reasons });
  });

  /* GET /api/ads/campaigns?platform= */
  app.get("/api/ads/campaigns", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const only = c.req.query("platform");
    const targets = only ? pickPlatforms([only]) : PLATFORMS;
    const from = c.req.query("from") || daysAgoISO(7);
    const to = c.req.query("to") || todayISO();
    const campaigns = [];
    const reasons = {};
    for (const p of targets) {
      try {
        const r = await p.campaigns();
        if (!r.ok) { reasons[p.id] = r.reason; continue; }
        // Fold in recent spend/results so the dashboard row is self-contained.
        let stats = {};
        try {
          const ins = await p.insights({ from, to });
          if (ins.ok) stats = Object.fromEntries(ins.rows.map((x) => [String(x.campaignId), x]));
        } catch { /* insights are a bonus, never a blocker */ }
        for (const cam of r.campaigns) {
          const s = stats[String(cam.id)];
          campaigns.push({
            ...cam,
            recent: s
              ? { from, to, spend: s.spend, impressions: s.impressions, clicks: s.clicks, results: s.results, resultValue: s.resultValue }
              : { from, to, spend: null, impressions: null, clicks: null, results: null, resultValue: null },
          });
        }
      } catch (e) {
        reasons[p.id] = String(e.message || e);
      }
    }
    return c.json({ ok: true, range: { from, to }, campaigns, reasons, writeEnabled: writeAllowed() });
  });

  /* GET /api/ads/insights?platform=&from=&to= */
  app.get("/api/ads/insights", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const only = c.req.query("platform");
    const targets = only ? pickPlatforms([only]) : PLATFORMS;
    const from = c.req.query("from") || daysAgoISO(7);
    const to = c.req.query("to") || todayISO();
    const rows = [];
    const reasons = {};
    for (const p of targets) {
      try {
        const r = await p.insights({ from, to });
        if (r.ok) rows.push(...r.rows); else reasons[p.id] = r.reason;
      } catch (e) {
        reasons[p.id] = String(e.message || e);
      }
    }
    const totals = rows.reduce((a, r) => ({
      spend: a.spend + (r.spend || 0),
      impressions: a.impressions + (r.impressions || 0),
      clicks: a.clicks + (r.clicks || 0),
      results: a.results + (r.results || 0),
    }), { spend: 0, impressions: 0, clicks: 0, results: 0 });
    return c.json({ ok: true, range: { from, to }, rows, totals, reasons });
  });

  /* ─── the two one-press controls ──────────────────────────────────────
     THESE SPEND MONEY. Both refuse to act unless ADS_ALLOW_WRITE=1, and in
     both cases they answer with the exact call they would have made, so the
     dashboard can show the owner what the button does before it is armed.  */
  async function guardedWrite(c, platformId, buildCall, describe) {
    const p = byId(platformId);
    if (!p) return c.json({ ok: false, error: `unknown platform '${platformId}'` }, 400);
    if (!canManage(p)) {
      return c.json({
        ok: false, applied: false,
        error: `platform not configured for campaign management — missing ${missingOf(p.manageEnv).join(", ") || "an approved Marketing API app"}`,
        wouldDo: describe,
      }, 400);
    }
    let call;
    try { call = buildCall(p); } catch (e) { return c.json({ ok: false, error: String(e.message || e) }, 400); }

    if (!writeAllowed()) {
      return c.json({
        ok: true,
        applied: false,
        guard: "ADS_ALLOW_WRITE is not '1' — nothing was sent",
        wouldDo: describe,
        wouldCall: safeRequest(call),
      });
    }
    let authed = call;
    if (p.authorize) {
      authed = await p.authorize(call);
      if (!authed) return c.json({ ok: false, applied: false, error: "could not obtain an access token", wouldDo: describe }, 502);
    }
    const res = await httpJson(authed.url, { method: authed.method, headers: authed.headers, body: authed.body });
    const parsed = p.readBatchResult(res, 1);
    return c.json({
      ok: parsed.ok,
      applied: parsed.ok,
      did: describe,
      httpStatus: res.status,
      ...(parsed.ok ? { platform: redact(parsed.raw ?? null) } : { error: parsed.error, platform: redact(parsed.raw ?? null) }),
    }, parsed.ok ? 200 : 502);
  }

  app.post("/api/ads/campaign/:platform/:id/state", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const platform = c.req.param("platform");
    const id = c.req.param("id");
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const state = String(b.state || "").toUpperCase();
    if (state !== "ACTIVE" && state !== "PAUSED") {
      return c.json({ ok: false, error: 'state must be "ACTIVE" or "PAUSED"' }, 400);
    }
    return guardedWrite(c, platform, (p) => p.stateCall(id, state), `set ${platform} campaign ${id} to ${state}`);
  });

  app.post("/api/ads/campaign/:platform/:id/budget", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const platform = c.req.param("platform");
    const id = c.req.param("id");
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const amount = Number(b.dailyBudget);
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ ok: false, error: "dailyBudget must be a positive number (account currency, e.g. SAR)" }, 400);
    }
    // A fat finger here is a real bill. Refuse anything absurd outright.
    if (amount > MAX_DAILY_BUDGET) {
      return c.json({
        ok: false, applied: false,
        error: `dailyBudget ${amount} exceeds ADS_MAX_DAILY_BUDGET (${MAX_DAILY_BUDGET}). Raise the ceiling deliberately if this is intended.`,
      }, 400);
    }
    return guardedWrite(c, platform, (p) => p.budgetCall(id, amount),
      `set ${platform} campaign ${id} daily budget to ${amount} ${DEFAULT_CURRENCY}`);
  });

  /* ═══════════════════════════════════════════════════════════════════════
     GET /api/ads/scorecard?from&to — "كل منصة صرفت كام وجابتلنا كام"

     صف واحد لكل منصة. الصرف والانطباعات والنقرات لايف من insights بتاعة
     المنصة نفسها. أما التحويلات فبعمودين مختلفين عن قصد:

       platformConversions — الرقم اللي المنصة بتقوله. عندنا ده صفر على
         طول تقريباً، لإن الشرا بيحصل جوّه المطعم وبيتبعت CAPI بـ
         action_source=physical_store فميتا مبتنسبهوش لحملة. الرقم ده
         بيترجع زي ما هو ومعاه تحذير، ومش بيتبني عليه أي حكم.
       confirmedConversions — دليلنا إحنا من attribution.js: أكواد عروض
         اتنطقت على الكاشير + طلبات اتطابقت برقم جوال. ده الرقم اللي
         costPerConfirmed بيتقسم عليه.

     الفرق بين العمودين هو نفسه رسالة الشاشة: منصة "مجيباش" بلغة المنصة
     ممكن تكون جايبة، والعكس مش بيحصل.
     ═══════════════════════════════════════════════════════════════════════ */
  const scoreCache = new Map();
  const SCORE_TTL_MS = 3 * 60_000;

  async function scorecardData(from, to) {
    const attribution = attributionOf();
    let overview = null, attribError = null;
    if (attribution?.overviewData) {
      try { overview = await attribution.overviewData(from, to); }
      catch (e) { attribError = String(e.message || e); }
    } else {
      attribError = "موديول الإسناد مش مربوط — مفيش تحويلات مؤكدة أقدر أقارن بيها.";
    }
    const attribBy = Object.fromEntries((overview?.rows || []).map((r) => [r.channel, r]));

    const rows = [];
    const reasons = {};
    for (const p of PLATFORMS) {
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ") || "صلاحيات"}`; continue; }
      let ins = null;
      try { ins = await p.insights({ from, to }); }
      catch (e) { reasons[p.id] = String(e.message || e); continue; }
      if (!ins.ok) { reasons[p.id] = ins.reason || "insights رجعت خطأ"; continue; }

      const t = ins.rows.reduce((a, r) => ({
        spend: a.spend + (Number(r.spend) || 0),
        impressions: a.impressions + (Number(r.impressions) || 0),
        clicks: a.clicks + (Number(r.clicks) || 0),
        results: a.results + (Number(r.results) || 0),
        resultValue: a.resultValue + (Number(r.resultValue) || 0),
      }), { spend: 0, impressions: 0, clicks: 0, results: 0, resultValue: 0 });
      for (const r of ins.rows) if (r.error) reasons[p.id] = r.error;

      const a = attribBy[p.id] || null;
      /* التحويلات المؤكدة = طلبات مربوطة برقم جوال + طلبات صنّفها النظام
         نفسه + أكواد عروض لسه متربطتش بطلب (اللي اتربط بقى جوّه linked،
         وعدّه تاني بيبقى تكرار لنفس الدليل). نفس حساب confidenceOf. */
      const b = a?.confidenceBreakdown || {};
      const confirmed = a
        ? Math.min(Number(a.orders) || 0,
            (Number(b.linked) || 0) + (Number(b.pos) || 0) + Math.max(0, Number(a.promo?.unlinked) || 0))
        : null;

      rows.push({
        platform: p.id, label: p.label,
        spend: Math.round(t.spend * 100) / 100,
        impressions: t.impressions,
        clicks: t.clicks,
        cpc: t.clicks > 0 ? Math.round((t.spend / t.clicks) * 100) / 100 : null,
        cpm: t.impressions > 0 ? Math.round((t.spend / t.impressions) * 1000 * 100) / 100 : null,
        ctr: t.impressions > 0 ? Math.round((t.clicks / t.impressions) * 10000) / 100 : null,
        campaigns: ins.rows.length,
        platformConversions: t.results,
        platformConversionValue: Math.round(t.resultValue * 100) / 100,
        platformNote: t.results === 0 && t.spend > 0
          ? `${p.label} مسجّلة صفر تحويل رغم الصرف. ده متوقّع عندنا مش مؤشر فشل: الطلب بيتقفل جوّه المطعم و CAPI بيبعته بـ action_source=physical_store، والمنصة مبتنسبش الحدث ده لحملة بعينها. اتفرّج على عمود التحويلات المؤكدة جنبه.`
          : null,
        confirmedConversions: confirmed,
        confirmedRevenue: a ? a.revenue : null,
        codeRedemptions: a?.promo?.redemptions ?? null,
        phoneMatched: Number(b.linked) || 0,
        newCustomers: a ? a.newCustomers : null,
        costPerConfirmed: confirmed > 0 && t.spend > 0 ? Math.round((t.spend / confirmed) * 100) / 100 : null,
        confirmedRoas: a && t.spend > 0 ? Math.round((Number(a.revenue) / t.spend) * 100) / 100 : null,
        confidence: a?.confidence ?? "تقديري",
        confidenceNote: a?.confidenceNote
          ?? (attribError || "مفيش صف إسناد للمنصة دي في المدى المطلوب."),
      });
    }

    const totals = rows.reduce((acc, r) => ({
      spend: acc.spend + r.spend,
      impressions: acc.impressions + r.impressions,
      clicks: acc.clicks + r.clicks,
      platformConversions: acc.platformConversions + (r.platformConversions || 0),
      confirmedConversions: acc.confirmedConversions + (r.confirmedConversions || 0),
      confirmedRevenue: acc.confirmedRevenue + (Number(r.confirmedRevenue) || 0),
    }), { spend: 0, impressions: 0, clicks: 0, platformConversions: 0, confirmedConversions: 0, confirmedRevenue: 0 });
    totals.spend = Math.round(totals.spend * 100) / 100;
    totals.confirmedRevenue = Math.round(totals.confirmedRevenue * 100) / 100;
    totals.costPerConfirmed = totals.confirmedConversions > 0 && totals.spend > 0
      ? Math.round((totals.spend / totals.confirmedConversions) * 100) / 100 : null;

    return {
      range: { from, to }, rows, totals, reasons,
      ...(attribError ? { attributionError: attribError } : {}),
      coverage: overview?.coverage || null,
      notes: [
        "الصرف والانطباعات والنقرات لايف من كل منصة على حدة وقت الطلب.",
        "platformConversions = رقم المنصة. confirmedConversions = دليلنا إحنا (كود عرض على الكاشير أو طلب متطابق برقم جوال). الاتنين مش نفس الحاجة ومينفعش يتجمعوا.",
        "costPerConfirmed = الصرف ÷ التحويلات المؤكدة. لو التحويلات المؤكدة صفر بيرجع null — مش رقم كبير، لأ محصلش قياس أصلاً.",
        "درجة الثقة جاية من attribution.js: مؤكد = مطابقة رقم جوال أو تصنيف النظام، مرجّح = تصنيف الكاشير اليدوي، تقديري = محسوب بالاستبعاد.",
      ],
    };
  }

  app.get("/api/ads/scorecard", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const to = c.req.query("to") || todayISO();
    const from = c.req.query("from") || daysAgoISO(29);
    const key = `${from}|${to}`;
    const hit = scoreCache.get(key);
    if (hit && Date.now() - hit.at < SCORE_TTL_MS && c.req.query("refresh") !== "1") {
      return c.json({ ok: true, cached: true, cachedAgeSec: Math.round((Date.now() - hit.at) / 1000), ...hit.val });
    }
    try {
      const val = await scorecardData(from, to);
      if (scoreCache.size > 30) scoreCache.clear();
      scoreCache.set(key, { at: Date.now(), val });
      return c.json({ ok: true, cached: false, ...val });
    } catch (e) {
      console.error("[ads] scorecard failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* GET /api/ads/events-feed?limit=&hours=&platform=
     نفس جدول ads_events بس مقروء: إيه اللي اتبعت، لأنهي منصة، اتقبل ولا
     اترفض، والرفض بنص المنصة نفسها. الفرق عن /api/ads/events إن ده مقصوص
     ومترجم — المالك عايز يتفرّج على التحويلات وهي ماشية، مش يقرا JSON خام. */
  const errorTextOf = (resp) => {
    if (!resp || typeof resp !== "object") return null;
    const j = resp.json || resp;
    return j?.error?.message                                   // Meta
      || j?.error?.error_user_msg
      || (j?.message && j?.code ? `[${j.code}] ${j.message}` : null)  // TikTok
      || j?.debug_message                                      // Snap
      || j?.request_status
      || resp.error
      || (resp.status ? `HTTP ${resp.status}` : null);
  };

  app.get("/api/ads/events-feed", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const limit = Math.min(Number(c.req.query("limit") || 50), 500);
    const hours = Math.min(Number(c.req.query("hours") || 48), 24 * 30);
    const platform = c.req.query("platform");
    const params = [String(hours)];
    let where = `WHERE created_at > NOW() - ($1 || ' hours')::interval`;
    if (platform) { params.push(platform); where += ` AND platform = $${params.length}`; }
    params.push(limit);

    const r = await pool.query(
      `SELECT id, order_id, event_name, event_time, value, currency, platform, status,
              response, attempts, created_at
         FROM ads_events ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);

    const agg = await pool.query(
      `SELECT platform, status, count(*)::int AS n
         FROM ads_events WHERE created_at > NOW() - ($1 || ' hours')::interval
        GROUP BY 1,2`, [String(hours)]);
    const summary = {};
    for (const x of agg.rows) {
      summary[x.platform] = summary[x.platform] || { sent: 0, failed: 0, skipped: 0, pending: 0 };
      if (summary[x.platform][x.status] != null) summary[x.platform][x.status] = x.n;
    }

    return c.json({
      ok: true,
      window: { hours, limit },
      summary,
      events: r.rows.map((x) => ({
        at: x.created_at,
        eventTime: x.event_time,
        event: x.event_name,
        orderId: x.order_id,
        value: x.value == null ? null : Number(x.value),
        currency: x.currency,
        platform: x.platform,
        accepted: x.status === "sent",
        status: x.status,
        attempts: x.attempts,
        // نص الخطأ بتاع المنصة نفسها — مش ترجمة ولا تلخيص، عشان يتبحث عنه.
        error: x.status === "sent" ? null : errorTextOf(redact(x.response)),
      })),
    });
  });

  /* GET /api/ads/events — the audit trail behind everything above. */
  app.get("/api/ads/events", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const platform = c.req.query("platform");
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") || 100), 1000);
    const where = [];
    const params = [];
    if (platform) { params.push(platform); where.push(`platform = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT id, order_id, event_name, event_time, value, currency, platform, status,
              request, response, attempts, created_at
         FROM ads_events
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return c.json({ ok: true, events: r.rows.map((x) => ({ ...x, request: redact(x.request), response: redact(x.response) })) });
  });

  console.log(`[ads] routes ready (send: ${PLATFORMS.filter(canSend).map((p) => p.id).join(",") || "none"} · manage: ${PLATFORMS.filter(canManage).map((p) => p.id).join(",") || "none"} · write ${writeAllowed() ? "ARMED" : "locked"})`);

  // Handed back to index.js so the worker/autopilot can push conversions on a
  // schedule without going through HTTP + admin auth against ourselves.
  return {
    async syncOrders({ from, to, limit = 5000 } = {}) {
      const f = from || daysAgoISO(2);
      const t = to || todayISO();
      const rows = await loadOrders(f, t, limit);
      let itemsByOrder = new Map();
      try { itemsByOrder = await loadItems(rows.map((r) => String(r.order_id))); } catch { /* bonus */ }
      const events = rows.map((r) => toEvent(r, "Purchase", itemsByOrder.get(String(r.order_id)) || null));
      const results = {};
      for (const p of PLATFORMS) {
        if (!canSend(p)) continue;
        try { results[p.id] = await sendToPlatform(p, events); }
        catch (e) { results[p.id] = { platform: p.id, failed: events.length, errors: [String(e.message || e)] }; }
      }
      return { from: f, to: t, orders: events.length, platforms: results };
    },
  };
}

// Exported for offline tests of the payload builders (no network, no DB).
export const __test = { PLATFORMS, sha256, hashEmail, hashPhoneDigits, hashPhonePlus, phoneDigits, redact, safeRequest, googleDateTime };

// Shared with sibling modules (autopilot.js / audiences.js / funnel.js) so the
// platform adapters, hashing rules and redaction live in exactly one place.
export {
  PLATFORMS, byId, canSend, canManage, missingOf,
  sha256, hashEmail, hashPhoneDigits, hashPhonePlus, phoneDigits,
  redact, safeRequest, httpJson, writeAllowed, MAX_DAILY_BUDGET, DEFAULT_CURRENCY,
};
