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
import { createGoogleAdapter } from "./google.js";

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
     GOOGLE_ADS_CONVERSION_ACTION_ID
                             numeric id of the conversion action till sales are
                             filed against. Without it we know the account but
                             not the conversion, so nothing is uploaded.

   Campaign management (platform ← us, the hard half):
     META_AD_ACCOUNT_ID      act_xxxxxxxxx (the act_ prefix is optional)
     TIKTOK_ADVERTISER_ID    advertiser id the token is scoped to
     SNAP_AD_ACCOUNT_ID      Snap ad account uuid
     SNAP_CLIENT_ID / SNAP_CLIENT_SECRET / SNAP_REFRESH_TOKEN
                             Snap Marketing API OAuth (separate from CAPI)
     SNAP_MARKETING_TOKEN    optional short-lived bearer, skips the OAuth dance
     GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN
                             OAuth2 installed-app credentials (Google Cloud)
     GOOGLE_ADS_DEVELOPER_TOKEN
                             from the Google Ads API Center; a test-access
                             token can only reach test accounts
     GOOGLE_ADS_CUSTOMER_ID  the ad account, digits only (878-265-9560 is fine)
     GOOGLE_ADS_LOGIN_CUSTOMER_ID
                             optional; the MCC id when access is via a manager
     GOOGLE_ADS_API_VERSION  optional; default lives in google.js (currently
                             v25). Google sunsets a major version a year after
                             release — v21 died 2026-08-05 and every query
                             started answering UNSUPPORTED_VERSION while auth
                             kept working. Bumping this env var is the whole
                             migration; no deploy needed.

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

/* توقيت حساب ميتا الإعلاني. اليوم عنده بيلف ٠٠:٠٠ بتوقيت لوس أنجلوس — اللي
   هي ١٠ صباحاً بتوقيت جدة، مش نص الليل. أي رقم بيخلط صرف بمبيعات لازم يقول
   الحد ده بصوت عالي. التعريف عايش هنا (الموديول الأدنى) و autopilot.js
   بيعيد تصديره — تعريف واحد بس في الـ API كلها. */
export const ADS_ACCOUNT_TZ = process.env.ADS_ACCOUNT_TZ || "America/Los_Angeles";

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

/* The few response headers worth keeping. Meta's rate-limit budget lives in
   one of them and nowhere in the body, so a refusal is unreadable without it. */
const KEEP_HEADERS = ["x-business-use-case-usage", "x-app-usage", "x-ad-account-usage", "retry-after"];
function pickHeaders(h) {
  const out = {};
  if (!h) return out;
  for (const k of KEEP_HEADERS) { const v = h.get(k); if (v) out[k] = v; }
  return out;
}

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
        last = { ok: false, status: res.status, json, text: json ? undefined : text.slice(0, 1000), retried: true, headers: pickHeaders(res.headers) };
        continue;
      }
      return { ok: res.ok, status: res.status, json, text: json ? undefined : text.slice(0, 1000), headers: pickHeaders(res.headers) };
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
   WHY THE PLATFORM SAID NO — and for how long

   Meta does not always say "you are over your quota". On 2026-08-11 the ads
   window tried to pause four campaigns every five minutes from 00:00 to 07:00
   UTC and Meta answered 337 times with

     OAuthException 200 · error_subcode 4841013
     "Permissions error" / "The user does not have permission for this action."

   The token was never the problem: it is a SYSTEM_USER token with
   ads_management + business_management, MANAGE on act_210662083554074, and it
   does not expire. What the account carries is
   `ads_api_access_tier: development_access` — the smallest Marketing API
   quota Meta issues — and the SAME calls succeeded the moment the hourly
   bucket rolled over at 07:00:37. Two of the rejections in that window came
   back honestly as `(#613) Calls to this api have exceeded the rate limit`
   with subcode 4841018, one digit away from 4841013. It is the same wall
   wearing two different labels.

   That mislabelling cost real money: a "permission" error looks permanent, so
   nothing backed off, so the retries kept eating the very quota the pause
   needed — and the ads ran all night with the kitchen shut. Everything in the
   4841xxx family is therefore read as a THROTTLE, and a throttle closes the
   gate below until the bucket resets instead of retrying into it.
   ═══════════════════════════════════════════════════════════════════════ */

/* One sentence, one place. It is what the owner reads on the status tile, in
   the reports page, in the autopilot health line and in the skipped-event
   rows — and it says what is true (an app awaiting review), not what the API
   said (a missing scope, which sounds like a credential someone forgot). */
const TIKTOK_PENDING_AR =
  "تيك توك لسه بتراجع تطبيقنا (Pending review) — التوكن مش واخد صلاحيات لحد ما المراجعة تخلص. " +
  "يعني مش بنقدر نقرا أرقام تيك توك ولا نرفع عليها جماهير. الصرف والإيقاف والتشغيل شغّالين عادي. " +
  "مفيش حاجة تتعمل من عندنا — المراجعة عند تيك توك نفسها.";

const META_THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80014]);

/* An unclassified refusal is still a refusal. Snap answered 87 pause commands
   with an empty reason and the old reading — `rejected`, retryAfterMs 0 — put
   it straight back in the queue five minutes later, forever. Anything we
   cannot name backs off on a doubling ladder instead, so a reason we have
   never seen before costs a handful of calls a night rather than 288.       */
const UNKNOWN_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 45 * 60_000, 90 * 60_000];

function msToTopOfNextHour(now = Date.now()) {
  const d = new Date(now);
  d.setUTCMinutes(60, 30, 0);          // half a minute past, so we do not race the reset
  return Math.max(60_000, d.getTime() - now);
}

// Meta hands the remaining budget back in a header, never in the body.
function metaRegainMs(res) {
  const raw = res?.headers?.["x-business-use-case-usage"];
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    let minutes = 0;
    for (const entries of Object.values(parsed)) {
      for (const e of entries || []) {
        minutes = Math.max(minutes, Number(e.estimated_time_to_regain_access) || 0);
      }
    }
    return minutes > 0 ? minutes * 60_000 : 0;
  } catch { return 0; }
}

// What tier is this account on? Purely informational, but it is the single
// fact that explains the whole incident, so it is worth surfacing.
export function metaAccessTier(res) {
  const raw = res?.headers?.["x-business-use-case-usage"];
  if (!raw) return null;
  try {
    for (const entries of Object.values(JSON.parse(raw))) {
      for (const e of entries || []) if (e.ads_api_access_tier) return e.ads_api_access_tier;
    }
  } catch { /* header shape changed */ }
  return null;
}

/* Three destinies, and every refusal has exactly one of them:

     transient   — retry with backoff. Throttles, timeouts, 5xx.
     needs-owner — a human must click something. Say it once, loudly, with the
                   screen and the button. Retrying cannot help.
     unavailable — the door is shut and not by us. Stop trying, say so, and
                   stop counting it as a failure of ours.

   `kind` stays the fine-grained label; `destiny` is the thing the rest of the
   system branches on, so a new platform code cannot accidentally land in the
   retry-forever bucket by omission.

   kind: throttled | auth | permission | unavailable | rejected | transport */
const DESTINY = {
  throttled: "transient",
  transport: "transient",
  rejected: "transient",      // unknown → back off, never hammer
  auth: "needs-owner",
  permission: "needs-owner",
  unavailable: "unavailable",
};

export function destinyOf(kind) { return DESTINY[kind] || "transient"; }

export function classifyRefusal(platformId, res, attempt = 0) {
  const j = res?.json;
  const status = res?.status ?? 0;
  const unknown = () => ({
    kind: "rejected",
    retryAfterMs: UNKNOWN_BACKOFF_MS[Math.min(attempt, UNKNOWN_BACKOFF_MS.length - 1)],
  });
  if (!status) return { kind: "transport", retryAfterMs: 60_000 };
  if (status === 429) return { kind: "throttled", retryAfterMs: Number(res?.headers?.["retry-after"] || 0) * 1000 || 15 * 60_000 };

  if (platformId === "meta") {
    const e = j?.error || {};
    const code = Number(e.code);
    const sub = Number(e.error_subcode);
    const family4841 = Number.isFinite(sub) && String(sub).startsWith("4841");
    if (META_THROTTLE_CODES.has(code) || family4841) {
      return {
        kind: "throttled",
        retryAfterMs: metaRegainMs(res) || msToTopOfNextHour(),
        tier: metaAccessTier(res),
        subcode: Number.isFinite(sub) ? sub : null,
      };
    }
    /* 190 is the one Meta error a machine can sometimes undo by itself, so it
       is auth (needs-owner) only after a refresh has been tried and failed.
       The rest of this family cannot be fixed from here at all.             */
    if (code === 190 || code === 102 || code === 463 || code === 467) return { kind: "auth", retryAfterMs: 0 };
    if (code === 200 || code === 10 || code === 3 || code === 294) return { kind: "permission", retryAfterMs: 0 };
    return unknown();
  }

  if (platformId === "tiktok") {
    const code = Number(j?.code);
    const msg = String(j?.message || "");
    if (code === 40100 || code === 51021) return { kind: "throttled", retryAfterMs: 10 * 60_000 };
    /* 40001 + "lacks the required scope" is not a broken token and not a
       mistake we can correct: the developer app is submitted and Pending, so
       TikTok grants no scope at all until a human at TikTok approves it. It
       is retried once every six hours purely so approval is noticed, and it
       is never counted as the platform refusing our commands.               */
    if (code === 40001 && /scope|permission/i.test(msg)) {
      return { kind: "unavailable", retryAfterMs: 6 * 60 * 60_000, reviewPending: true };
    }
    if (code === 40001 || code === 40105 || code === 40002) return { kind: "auth", retryAfterMs: 0 };
    return status === 403 ? { kind: "permission", retryAfterMs: 0 } : unknown();
  }

  if (platformId === "snapchat") {
    if (status === 401) return { kind: "auth", retryAfterMs: 0 };
    if (status === 403) return { kind: "permission", retryAfterMs: 0 };
    return unknown();
  }

  if (status === 401 || status === 403) return { kind: status === 401 ? "auth" : "permission", retryAfterMs: 0 };
  return unknown();
}

/* ─── The gate ─────────────────────────────────────────────────────────
   One in-memory door per platform. A throttle shuts it; the first success
   after it reopens clears it. It exists so a refusal costs ONE call instead
   of one every five minutes — on a development-tier quota the retries are
   what keep the quota exhausted.

   In memory on purpose: a deploy should reopen every door and re-learn the
   truth from the platform rather than inherit a stale block. The durable
   record of what failed and how often already lives in ap_decisions.        */
const gates = new Map();

/* How many times in a row this platform has refused without naming a wait.
   It is what turns the unknown-refusal ladder from a constant into a ramp,
   and the first success resets it. */
const streaks = new Map();
function refusalStreak(platformId) { return streaks.get(platformId) || 0; }
function noteRefusal(platformId) { streaks.set(platformId, refusalStreak(platformId) + 1); }
function clearRefusals(platformId) { streaks.delete(platformId); }

export function writeGate(platformId) {
  const g = gates.get(platformId);
  if (!g) return null;
  if (Date.now() >= g.until) { gates.delete(platformId); return null; }
  return { ...g, minutes: Math.ceil((g.until - Date.now()) / 60_000) };
}

export function closeWriteGate(platformId, { ms, reason, kind }) {
  const until = Date.now() + Math.max(60_000, ms || 0);
  const prev = gates.get(platformId);
  gates.set(platformId, {
    platform: platformId, kind, reason, until,
    since: prev?.since || Date.now(),
    hits: (prev?.hits || 0) + 1,
  });
}

export function openWriteGate(platformId) { gates.delete(platformId); }

export function writeGates() {
  return [...gates.keys()].map(writeGate).filter(Boolean);
}

/* ─── Reads spend the same quota as writes ──────────────────────────────
   The gate above stopped the retry storm on WRITES, and on the night of
   11 August that was only half the leak. Meta's development tier meters the
   whole Marketing API, not the write half of it, and the ads window read
   `campaigns() + insights()` for every platform on every five-minute tick
   plus one more read per platform to verify — about thirty-six Meta reads an
   hour, all night, while the four pause commands it actually needed sat
   behind a shut gate. The polling was eating the quota the pause was waiting
   for.

   So reads are ranked, and the rank decides who may spend during a throttle:

     owner     — a person is looking at the screen right now. Always allowed;
                 it happens a few times a day, not twelve times an hour.
     verify    — the read-back that proves an order landed. Suppressed while
                 the gate is shut, because a write that never left the
                 building has nothing to verify.
     telemetry — polling for numbers. First thing dropped, every time.

   The rule is one line: while a platform is throttled, nothing automatic
   reads from it. That is what reserves the next call in the bucket for the
   pause instead of for a chart.                                            */
const READ_RANK = { telemetry: 1, verify: 2, owner: 3 };

export function readGate(platformId, priority = "telemetry") {
  if ((READ_RANK[priority] || 1) >= READ_RANK.owner) return null;
  const g = writeGate(platformId);
  if (!g) return null;
  return {
    ...g,
    error: g.kind === "unavailable"
      ? `${platformId}: مش متاحة دلوقتي — ${g.reason}`
      : `${platformId}: مقفول مؤقتًا (${g.kind}) — الحصة محجوزة لأوامر الإيقاف والتشغيل، مش للقراءة. بعد ${g.minutes} دقيقة.`,
  };
}

/* Every automatic read of a platform goes through here so the priority is
   declared at the call site and cannot be forgotten. A suppressed read
   returns the same `{ok:false, reason}` shape the adapters already return,
   so callers that already handle "could not read" need no new branch.      */
export async function platformRead(p, fn, { priority = "telemetry", empty = {} } = {}) {
  const blocked = readGate(p.id, priority);
  if (blocked) {
    return { ok: false, reason: blocked.error, gated: true, kind: blocked.kind,
             retryInMinutes: blocked.minutes, ...empty };
  }
  try {
    return await fn();
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), ...empty };
  }
}

/* ─── The one place a campaign write actually leaves the building ──────
   Both the dashboard buttons (guardedWrite) and the autopilot's own
   executeDecision go through here, so the gate, the classification and the
   wording of a refusal cannot drift apart between the two paths.           */
export async function sendPlatformWrite(p, call) {
  const gate = writeGate(p.id);
  if (gate) {
    return {
      ok: false, gated: true, kind: gate.kind, retryInMinutes: gate.minutes,
      error: `${p.label}: مقفول مؤقتًا (${gate.kind === "throttled" ? "تخطينا حد النداءات" : gate.kind}) — ${gate.reason}. هنعيد المحاولة بعد ${gate.minutes} دقيقة.`,
    };
  }
  let authed = call;
  if (p.authorize) {
    authed = await p.authorize(call);
    if (!authed || !authed.url) {
      return { ok: false, kind: "auth", error: authed?.error || "could not obtain an access token" };
    }
  }
  const res = await httpJson(authed.url, { method: authed.method, headers: authed.headers, body: authed.body });
  const parsed = p.readBatchResult(res, 1);
  if (parsed.ok) {
    openWriteGate(p.id);
    clearRefusals(p.id);
    return { ok: true, httpStatus: res.status, raw: parsed.raw ?? null };
  }
  const cls = classifyRefusal(p.id, res, refusalStreak(p.id));
  /* Any refusal that named a wait closes the door for that long. Reading only
     `throttled` here was the leak that made the classification cosmetic: a
     `rejected` with a backoff, or TikTok's `unavailable` with six hours on it,
     computed a delay and then went straight back into the queue on the next
     five-minute tick. If the classifier says "not before T", nothing asks
     again before T. */
  if (cls.retryAfterMs > 0) {
    closeWriteGate(p.id, { ms: cls.retryAfterMs, kind: cls.kind, reason: parsed.reason || parsed.error });
  } else {
    noteRefusal(p.id);
  }
  return {
    ok: false, httpStatus: res.status, error: parsed.error, kind: cls.kind,
    ...(cls.tier ? { accessTier: cls.tier } : {}),
    retryInMinutes: cls.retryAfterMs ? Math.ceil(cls.retryAfterMs / 60_000) : 0,
    raw: parsed.raw ?? null,
  };
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

/* ═══════════════════════════════════════════════════════════════════════════
   ما هي «النتيجة» أصلاً؟ — التعريف الوحيد اللي كل الملفات بتقرا منه

   ده كان أخطر باج في النظام كله، وكان صامت. القارئ القديم كان بيعدّ
   `purchase` وبس:

       actions.find(a => a.action_type === "purchase")

   وميتا **عمرها ما هتقول purchase عندنا**، لأسباب مثبتة مش متوقّعة:
     • الطلب بيتقفل جوّه المطعم، وبنبعته CAPI بـ action_source=physical_store.
     • ميتا شالت أنواع الأكشن بتاعة offline conversions في v20.
     • وحتى حملة OUTCOME_SALES اللي اسمها `fc-sales-purchase` والمُحسّنة على
       PURCHASE بالنص (promoted_object.custom_event_type = "PURCHASE") صرفت
       ٤٠٥ ر.س و٢٨٬٣٧٨ ظهور وسجّلت **١٩ lead و صفر purchase**.

   يعني كل حملة بتقرا صفر نتيجة، للأبد. والنتيجة إن قاعدة القتل (صفر نتيجة +
   صرف ٣ أيام ≥ ١٠٠ ر.س) كانت هتوقّف كل حملات ميتا يوم ١٤ أغسطس ٢٠٢٦ أول ما
   الحملات تعدّي minAgeDays — مش لإنها فشلت، لكن لإن العدّاد بيقيس حاجة
   مستحيلة تحصل.

   ── إيه اللي بنعدّه دلوقتي، وليه ─────────────────────────────────────────
   مفيش دفع أونلاين. فالتحويل الحقيقي عندنا هو **نية الطلب**: العميل يدوس
   «اطلب على واتساب» أو يفتح محادثة واتساب من الإعلان. ده مش تحايل على
   الرقم — دي هي الحاجة الوحيدة اللي الإعلان بيقدر يعملها فعلاً، وهي اللي
   المُحسّن (optimizer) نفسه بيتعلّم عليها.

   الأنواع اللي بنعدّها (اتقررت من لقطة حقيقية للحساب يوم ٢٠٢٦-٠٨-١٢،
   محفوظة في fixtures/meta-insights.json):

     ١. `offsite_conversion.fb_pixel_custom` = حدث **Contact** من البيكسل.
        إزاي عرفنا إنه Contact مش أي حدث كاستوم تاني؟ حقل `conversions` في
        نفس الصف بيرجّع `contact_website` و`contact_total` بنفس الأرقام
        بالظبط (٤٧/٤٧، ١١/١١، ١٠/١٠، ٢١/٢١، ٨/٨). وحملة `fc-leads-contact`
        مجموعاتها الإعلانية مُحسّنة على CONTACT بالنص
        (promoted_object.custom_event_type = "CONTACT") — فلازم نتيجتها
        تتعدّ، وإلا بنحكم على حملة بمقياس مش مقياسها.

     ٢. `lead` — حدث Lead القياسي.

     ٣. `onsite_conversion.messaging_conversation_started_7d` — محادثة واتساب
        ابتدت من الإعلان. دي نتيجة `fc-wa-orders` (OUTCOME_ENGAGEMENT،
        optimization_goal = CONVERSATIONS): ٢٣٠ محادثة في ٣٠ يوم.

     ٤. `purchase` — سايبينها في اللستة لو يوم جه الدفع الأونلاين. النهارده
        بترجع صفر دايماً، وده متوقّع ومكتوب هنا عشان اللي جاي ما يفتكرش إنها
        اتنسيت.

   ── ليه مش بنجمعهم ببساطة: الجمع بيعدّ نفس الشخص مرتين ─────────────────
   صفحة الطلب (tabsense-integration/storefront/static/app.js) بتولّع
   **Contact و Lead مع بعض في نفس الدالة** على نفس الدوسة على زرار واتساب:

       window.fcTrack("Contact", {...});
       window.fcTrack("Lead",    {...});

   فالجمع كان هيدّي ضعف الرقم. والأرقام الحقيقية بتأكد ده: Contact دايماً ≥
   Lead في كل حملة (٤٧ مقابل ٣٧، ١١ مقابل ٦، ١٠ مقابل ٥، ٨ مقابل ٦) — الفرق
   هو دوسات زرار «اتصل» اللي بتولّع Contact لوحده. يعني Lead ⊆ Contact.

   وكمان ميتا نفسها بترجّع نفس الحدث تحت أكتر من اسم: `lead` و
   `offsite_conversion.fb_pixel_lead` و `onsite_web_lead` كلهم ٣٧ في نفس
   الصف. تلات أسامي لحدث واحد.

   فالموديل هو **مجموعات**: جوّه المجموعة بناخد الأكبر (لإنهم أسامي/طبقات
   لنفس الفعل)، وبين المجموعات بنجمع (لإنهم أسطح مختلفة خالص — اللي بيفتح
   واتساب من الإعلان عمره ما لمس الموقع، واللي بيدفع أونلاين مش بيدوس زرار
   واتساب).
═══════════════════════════════════════════════════════════════════════════ */
export const META_RESULT_MODEL = [
  {
    key: "web_intent",
    label: "نية طلب من الموقع (Contact / Lead)",
    /* نفس الدوسة بتولّع الاتنين، وميتا بترجّع الحدث الواحد تحت كذا اسم →
       الأكبر، مش المجموع. */
    actions: ["offsite_conversion.fb_pixel_custom", "lead",
      "offsite_conversion.fb_pixel_lead", "onsite_web_lead"],
    /* `conversions` بيرجّع الحدث الكاستوم بالاسم بدل ما نفترض إن
       fb_pixel_custom = Contact. لو موجود بنصدّقه هو الأول. */
    conversions: ["contact_total", "contact_website"],
  },
  {
    key: "messaging",
    label: "محادثة واتساب ابتدت من الإعلان",
    actions: ["onsite_conversion.messaging_conversation_started_7d"],
    conversions: [],
  },
  {
    key: "purchase",
    label: "شرا أونلاين",
    /* فاضية دلوقتي وهتفضل فاضية لحد ما يبقى فيه دفع أونلاين. مش غلطة. */
    actions: ["purchase", "offsite_conversion.fb_pixel_purchase"],
    conversions: [],
  },
];

/* الإيراد المحقّق. `action_values` بترجّع قيمة لـ lead/Contact كمان، بس دي
   قيمة **السلة اللي في نية العميل** مش فلوس دخلت الدرج — الطلب ممكن ما
   يتمّش أصلاً. لو حطيناها في resultValue كان ROAS هيبقى مبني على أمنيات،
   وشرط "winning" في decide() بيتحقق من ROAS كمان. فالإيراد = الشرا وبس،
   ونية السلة بترجع منفصلة كـ resultValueIntent للعرض. */
const META_REVENUE_ACTIONS = ["purchase", "offsite_conversion.fb_pixel_purchase"];

const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pickMax = (list, names) => {
  let best = null;
  for (const a of list || []) {
    if (!names.includes(a.action_type)) continue;
    const v = numOf(a.value);
    if (best == null || v > best) best = v;
  }
  return best;
};

/* صف insights خام من ميتا → { results, resultValue, resultValueIntent,
   basis } . دالة نقية عشان تتجرّب على اللقطة المسجّلة من غير شبكة.       */
export function readMetaResult(row = {}) {
  const acts = row.actions || [];
  const convs = row.conversions || [];
  const basis = {};
  let results = 0, any = false;

  for (const g of META_RESULT_MODEL) {
    // الاسم الصريح من `conversions` بيسبق الاستنتاج من fb_pixel_custom.
    const fromConv = g.conversions.length ? pickMax(convs, g.conversions) : null;
    const fromAct = pickMax(acts, g.actions);
    const v = fromConv != null ? Math.max(fromConv, fromAct ?? 0) : fromAct;
    if (v == null) continue;
    any = true;
    basis[g.key] = v;
    results += v;
  }

  const rev = pickMax(row.action_values || [], META_REVENUE_ACTIONS);
  const intent = pickMax(row.action_values || [],
    META_RESULT_MODEL.find((g) => g.key === "web_intent").actions);

  return {
    /* null = المنصة ما رجّعتش ولا نوع من أنواعنا خالص (صف من غير أي أكشن).
       صفر = رجّعت وفعلاً صفر. الفرق ده هو اللي قاعدة القتل بتقف عليه. */
    results: any ? results : null,
    resultValue: rev,                 // إيراد محقّق فقط (= صفر عندنا النهارده)
    resultValueIntent: intent,        // قيمة السلة وقت النية — للعرض بس
    resultBasis: any ? basis : null,
  };
}

/* ── مرحلة التعلّم ────────────────────────────────────────────────────────
   ميتا بترجّع `learning_stage_info.status` بواحدة من تلاتة:
     LEARNING           لسه بتتعلّم — أي تغيير كبير في الميزانية بيصفّر التعلّم.
     SUCCESS            خلصت التعلّم. دي اللي الريال الزيادة فيها بيتصرف فعلاً.
     LEARNING_LIMITED   وقفت في التعلّم من غير ما تخلص (مفيش تحويلات كفاية).
                        دي **متخنقة**: زيادة الميزانية عليها بتزوّد الرقم على
                        الورق ومبتزوّدش صرف حقيقي.

   ليه الرقم ده مهم عندنا بالذات: تكبير ٣ حملات CBO ليلة ١٢ أغسطس طلّع صفر
   صرف إضافي لإن مجموعاتها كلها LEARNING، والصرف اليومي فضل ثابت مقابل
   ٥٠٠ ر.س ميزانية. يعني «رفعنا الميزانية» مش معناها «صرفنا أكتر».          */
export function readLearning(info) {
  const st = String(info?.status || "").toUpperCase() || null;
  return {
    status: st,
    done: st === "SUCCESS",                 // خلصت التعلّم — تقدر تستوعب زيادة
    learning: st === "LEARNING",            // لسه بتتعلّم — التغيير بيصفّرها
    limited: st === "LEARNING_LIMITED",     // متخنقة — الزيادة مش هتتصرف
    conversions: info?.conversions == null ? null : Number(info.conversions),
  };
}

/* نص الشرح اللي بيروح لشاشة المالك جنب رقم كل منصة. تلات حالات مختلفة
   تماماً، وخلطهم هو اللي كان بيغلّط القارئ:

     ١. عمى (`blind`) — المنصة مرجّعتش ولا نوع نتيجة نعرفه على أي حملة.
        مينفعش نقول «صفر»، ولا بنبني عليه حكم.
     ٢. صفر حقيقي — المنصة ردّت وقالت صفر نية طلب مع صرف. دي إشارة تستاهل
        القراءة، ودي المرة الأولى اللي الجملة دي بتبقى صح فيها.
     ٣. رقم عادي — بنشرح إن «النتيجة» = نية طلب مش شرا.

   ودايماً بنقول لو فيه حملات عميانة جوّه منصة شايفة — عشان الرقم ما يتقريش
   على إنه شامل الكل.                                                        */
function platformNoteFor(p, t, campaignCount, blindPlatform) {
  const tail = t.blind > 0 && !blindPlatform
    ? ` (${t.blind} من ${campaignCount} حملة مرجّعتش نوع نتيجة نعرفه، فمش داخلة في الرقم ده.)`
    : "";
  if (blindPlatform) {
    return `${p.label} مرجّعتش ولا نوع نتيجة نعرف نقراه على ${campaignCount} حملة رغم صرف `
      + `${Math.round(t.spend)} ر.س — ده عمى قياس مش صفر أداء، ومفيش أي حكم بيتبني عليه. `
      + `راجع ربط البيكسل/الأحداث على ${p.label}.`;
  }
  if (t.results === 0 && t.spend > 0) {
    return `${p.label} مسجّلة صفر نتيجة رغم الصرف — ودي المرة دي إشارة حقيقية مش عمى قياس: `
      + `بنعدّ دلوقتي دوسات «اطلب على واتساب» والمحادثات اللي بتبتدي من الإعلان، مش الشرا. `
      + `لو الرقم صفر يبقى الإعلان مش بيوصّل حد لخطوة الطلب. (الشرا نفسه بيتقفل جوّه المطعم `
      + `وبيتبعت بـ action_source=physical_store، فالمنصة عمرها ما هتنسبه لحملة — عشان كده `
      + `مش بنحكم بيه.)` + tail;
  }
  return `«النتيجة» هنا = نية الطلب: دوسة «اطلب على واتساب» أو محادثة واتساب ابتدت من الإعلان. `
    + `مفيش دفع أونلاين، فالشرا مش رقم المنصة بتقدر تشوفه — قارن بعمود التحويلات المؤكدة جنبه.`
    + tail;
}

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
    /* The subcode is the whole story and it used to be thrown away. Both of
       these are the same development-tier quota wall:
         200/4841013  "Permissions error"
         613/4841018  "Calls to this api have exceeded the rate limit"
       Printing only "OAuthException 200: Permissions error" sent everyone
       hunting a token that was never broken. */
    const err = j?.error;
    if (!err) return { ok: false, error: res.error || `HTTP ${res.status}`, raw: j ?? res.text ?? null };
    const sub = err.error_subcode != null ? `/${err.error_subcode}` : "";
    const extra = err.error_user_msg && err.error_user_msg !== err.message ? ` — ${err.error_user_msg}` : "";
    return {
      ok: false,
      error: `${err.type || "error"} ${err.code ?? ""}${sub}: ${err.message || ""}${extra}`.trim(),
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
    /* `conversions` مضاف عن قصد: هو اللي بيسمّي الحدث الكاستوم
       (contact_website) بدل ما نفترض إن fb_pixel_custom = Contact.
       شوف META_RESULT_MODEL فوق. */
    const fields = "campaign_id,campaign_name,objective,spend,impressions,clicks,ctr,cpc,"
      + "actions,action_values,conversions,conversion_values";
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
        const g = readMetaResult(r);
        return {
          platform: "meta",
          campaignId: r.campaign_id,
          campaignName: r.campaign_name,
          objective: r.objective || null,
          spend: Number(r.spend || 0),
          impressions: Number(r.impressions || 0),
          clicks: Number(r.clicks || 0),
          results: g.results,
          resultValue: g.resultValue,
          resultValueIntent: g.resultValueIntent,
          resultBasis: g.resultBasis,
        };
      }),
    };
  },

  /* نفس الاستعلام بس مقطّع يوم بيوم: `time_increment=1` بيخلي ميتا ترجّع صف
     لكل حملة لكل يوم ومعاه `date_start`. اليوم ده **يوم الحساب الإعلاني**
     (America/Los_Angeles) مش يوم المطعم — الفرق مكتوب في dailySpend() تحت. */
  async dailySpend({ from, to }) {
    const token = env("META_CAPI_TOKEN");
    const act = this.actId();
    if (!token || !act) return { ok: false, reason: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing", rows: [] };
    const fields = "campaign_id,campaign_name,spend,impressions,clicks";
    const tr = encodeURIComponent(JSON.stringify({ since: from, until: to }));
    const res = await httpJson(
      `${this.base()}/${act}/insights?level=campaign&fields=${fields}&time_range=${tr}`
      + `&time_increment=1&limit=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { ok: false, reason: this.readBatchResult(res).error, rows: [] };
    return {
      ok: true,
      accountTz: ADS_ACCOUNT_TZ,
      rows: (res.json?.data || []).map((r) => ({
        platform: "meta",
        day: String(r.date_start || "").slice(0, 10),
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        spend: Number(r.spend || 0),
        impressions: Number(r.impressions || 0),
        clicks: Number(r.clicks || 0),
      })),
    };
  },

  /* المجموعات الإعلانية بتفاصيلها + الميزانيات مجمّعة على مستوى الحملة.

     ليه دي موجودة: ٣ من ٥ حملات شغّالة عندنا ميزانيتها على مستوى المجموعة
     مش الحملة (fc-wa-orders و fc-leads-contact و fc-sales-purchase)، يعني
     `campaigns()` بترجّع لهم dailyBudget = null. والسقف الكلي في decide()
     كان بيجمع الحملات اللي ليها dailyBudget بس — فكان بيشوف ١١٠ ر.س/يوم
     والحقيقة ٢٩٠.

     ومش بس السقف: الإيقاع كان **مش قادر يوصلهم أصلاً** — بيرفع اللي عنده
     dailyBudget وبس، فأحسن مجموعتين في الحساب (fc-wa-walkin-5km و
     fc-wa-delivery-10km، ١٠٦ محادثة بـ ١٫٧٢ ر.س للواحدة) كانوا خارج
     متناوله تماماً. عشان كده بنرجّع الصفوف كاملة دلوقتي مش مجرد مجموع.

     `learning_stage_info` و`effective_status` مطلوبين بالتحديد: الريال
     الزيادة على مجموعة لسه في التعلّم أو متخنقة مش بيتصرف — ثبت ده بالتجربة
     لما تكبير ٣ حملات CBO طلّع صفر صرف إضافي. شوف absorptionOf في
     autopilot.js.                                                          */
  async adsets() {
    const token = env("META_CAPI_TOKEN");
    const act = this.actId();
    const empty = { rows: [], byCampaign: {} };
    if (!token || !act) return { ok: false, reason: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing", ...empty };
    const fields = "id,name,campaign_id,status,effective_status,daily_budget,learning_stage_info";
    const res = await httpJson(
      `${this.base()}/${act}/adsets?fields=${fields}&limit=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { ok: false, reason: this.readBatchResult(res).error, ...empty };
    const rows = (res.json?.data || []).map((a) => ({
      platform: "meta",
      id: String(a.id),
      name: a.name || "",
      campaignId: String(a.campaign_id),
      status: a.status,
      effectiveStatus: a.effective_status || null,
      // halalas → SAR. null = المجموعة مش شايلة ميزانيتها (الحملة CBO).
      dailyBudget: a.daily_budget == null ? null : Number(a.daily_budget) / 100,
      learning: readLearning(a.learning_stage_info),
    }));
    const byCampaign = {};
    for (const a of rows) {
      if (a.status !== "ACTIVE" || a.dailyBudget == null) continue;
      byCampaign[a.campaignId] = (byCampaign[a.campaignId] || 0) + a.dailyBudget;
    }
    return { ok: true, rows, byCampaign };
  },

  /* الاسم القديم — لسه متندَه من gatherFacts/perfSnapshot. نفس النداء. */
  adsetBudgets() { return this.adsets(); },

  /* أرقام المجموعات الإعلانية. نفس قارئ النتيجة بالظبط (readMetaResult) —
     مفيش تعريف تاني لـ«النتيجة» على مستوى المجموعة، وإلا كنا رجعنا لنفس
     المرض اللي بنصلّحه. */
  async adsetInsights({ from, to }) {
    const token = env("META_CAPI_TOKEN");
    const act = this.actId();
    if (!token || !act) return { ok: false, reason: "META_AD_ACCOUNT_ID / META_CAPI_TOKEN missing", rows: [] };
    const fields = "adset_id,adset_name,campaign_id,spend,impressions,clicks,"
      + "actions,action_values,conversions,conversion_values";
    const tr = encodeURIComponent(JSON.stringify({ since: from, until: to }));
    const res = await httpJson(
      `${this.base()}/${act}/insights?level=adset&fields=${fields}&time_range=${tr}&limit=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { ok: false, reason: this.readBatchResult(res).error, rows: [] };
    return {
      ok: true,
      rows: (res.json?.data || []).map((r) => {
        const g = readMetaResult(r);
        return {
          platform: "meta",
          adsetId: String(r.adset_id),
          adsetName: r.adset_name || "",
          campaignId: String(r.campaign_id),
          spend: Number(r.spend || 0),
          impressions: Number(r.impressions || 0),
          clicks: Number(r.clicks || 0),
          results: g.results,
          resultValue: g.resultValue,
          resultBasis: g.resultBasis,
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

  /* TikTok answers HTTP 200 for everything; the verdict is in `code`.

     `code 40001` with "lacks the required scope" is not a bad batch and not a
     credential we can fix — the developer app is submitted and Pending, so
     TikTok grants no scope at all until a human there approves it. Filing
     that as a plain failure was costing us a permanent drip: failed rows are
     put back to `pending` by claim() on the next sync, so every order in the
     window was re-sent every hour into a door that cannot open. Marking it
     `permanent` routes it to the `skipped` branch instead — the orders stay
     eligible for the day the review clears, and nothing is retried until
     then. Same treatment Google's closed service already gets. */
  readBatchResult(res, n) {
    const j = res.json;
    if (res.ok && j && j.code === 0) return { ok: true, accepted: n, raw: j };
    const code = Number(j?.code);
    const msg = String(j?.message || "");
    if (code === 40001 && /scope|permission/i.test(msg)) {
      this._refusal = { at: Date.now(), code: "APP_REVIEW_PENDING", reason: TIKTOK_PENDING_AR };
      return { ok: false, permanent: true, code: "APP_REVIEW_PENDING", reason: TIKTOK_PENDING_AR,
               error: `code ${code}: ${msg}`, raw: j ?? null };
    }
    return {
      ok: false,
      error: j ? `code ${j.code}: ${j.message || ""}` : res.error || `HTTP ${res.status}`,
      raw: j ?? res.text ?? null,
    };
  },

  /* `reason` is preferred over `error` by every read above: when the adapter
     already knows the door is shut, the surfaces get the Arabic sentence a
     restaurant owner can act on rather than TikTok's English one about a
     missing scope, which reads like a credential somebody forgot to paste.

     The pre-flight the sender consults before claiming any order. Once the
     refusal is latched nothing is claimed at all, so a shut door costs zero
     rows and zero calls. Re-tested every six hours so approval is noticed
     without anyone having to redeploy. */
  lastReadiness() {
    if (!this._refusal) return null;
    if (Date.now() - this._refusal.at > 6 * 60 * 60_000) { this._refusal = null; return null; }
    return { ok: false, code: this._refusal.code, reason: this._refusal.reason };
  },
  async preflight() { return this.lastReadiness() || { ok: true }; },

  hdr() { return { "Content-Type": "application/json", "Access-Token": env("TIKTOK_ACCESS_TOKEN") }; },
  advId() { return env("TIKTOK_ADVERTISER_ID"); },

  async accounts() {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = this.advId();
    if (!token || !adv) return { ok: false, reason: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing", accounts: [] };
    const q = `advertiser_ids=${encodeURIComponent(JSON.stringify(adv.split(",").map((s) => s.trim())))}`;
    const res = await httpJson(`${this.base}/advertiser/info/?${q}`, { headers: this.hdr() });
    const r = this.readBatchResult(res, 0);
    if (!r.ok) return { ok: false, reason: r.reason || r.error, accounts: [] };
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
    if (!r.ok) return { ok: false, reason: r.reason || r.error, campaigns: [] };
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
      /* تيك توك سليمة من عمى ميتا بالصدفة: `conversion` عندها = عدد أحداث
         **هدف التحسين** بتاع الحملة، مش الشرا. يعني لو الحملة محسّنة على
         SubmitForm (اللي هو Lead عندنا — شوف TT_NAME في funnel.js) الرقم ده
         هو نفسه اللي إحنا عايزينه. مبنغيّرهاش.
         `total_purchase_value` سايبينه إيراد محقّق وبس، زي ميتا بالظبط —
         عشان ROAS ما يتبنيش على قيمة سلة العميل ناويها. */
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", "conversion", "total_purchase_value"]),
      start_date: from,
      end_date: to,
      page_size: "200",
    });
    const res = await httpJson(`${this.base}/report/integrated/get/?${params}`, { headers: this.hdr() });
    const r = this.readBatchResult(res, 0);
    if (!r.ok) return { ok: false, reason: r.reason || r.error, rows: [] };
    return {
      ok: true,
      rows: (res.json?.data?.list || []).map((row) => ({
        platform: "tiktok",
        campaignId: String(row.dimensions?.campaign_id ?? ""),
        campaignName: row.metrics?.campaign_name || "",
        spend: Number(row.metrics?.spend || 0),
        impressions: Number(row.metrics?.impressions || 0),
        clicks: Number(row.metrics?.clicks || 0),
        /* `conversion` عند تيك توك = أحداث **هدف تحسين** الحملة (شوف
           التعليق فوق عند طلب الميتريكس). بس لو الحقل نفسه مش راجع خالص
           (تقرير ناقص / ميتريك مش متاح للحساب) `Number(undefined||0)` كان
           بيدّي **صفر واثق** — وده اللي قاعدة القتل بتوقّف عليه. الحقل
           الناقص = عمى قياس = null، زي ميتا وسناب بالظبط. */
        results: row.metrics?.conversion == null ? null : Number(row.metrics.conversion),
        resultBasis: row.metrics?.conversion == null
          ? null
          : { optimisation_event: Number(row.metrics.conversion) },
        resultValue: Number(row.metrics?.total_purchase_value || 0),
      })),
    };
  },

  /* نفس التقرير بس بُعد `stat_time_day` زيادة — تيك توك بترجّع وقتها صف لكل
     حملة لكل يوم. اليوم بتوقيت المعلن (توقيت الحساب على تيك توك). */
  async dailySpend({ from, to }) {
    const token = env("TIKTOK_ACCESS_TOKEN");
    const adv = this.advId();
    if (!token || !adv) return { ok: false, reason: "TIKTOK_ADVERTISER_ID / TIKTOK_ACCESS_TOKEN missing", rows: [] };
    const params = new URLSearchParams({
      advertiser_id: adv,
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks"]),
      start_date: from,
      end_date: to,
      page_size: "1000",
    });
    const res = await httpJson(`${this.base}/report/integrated/get/?${params}`, { headers: this.hdr() });
    const r = this.readBatchResult(res, 0);
    if (!r.ok) return { ok: false, reason: r.reason || r.error, rows: [] };
    return {
      ok: true,
      rows: (res.json?.data?.list || []).map((row) => ({
        platform: "tiktok",
        day: String(row.dimensions?.stat_time_day || "").slice(0, 10),
        campaignId: String(row.dimensions?.campaign_id ?? ""),
        campaignName: row.metrics?.campaign_name || "",
        spend: Number(row.metrics?.spend || 0),
        impressions: Number(row.metrics?.impressions || 0),
        clicks: Number(row.metrics?.clicks || 0),
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

  /* Snap speaks TWO dialects and this reads both, because the same function
     judges a CAPI batch and a campaign write:

       CAPI (tr.snapchat.com)   { status: "VALID" | "INVALID", reason }
       Marketing (adsapi…)      { request_status: "SUCCESS" | "ERROR",
                                  debug_message, campaigns:[{sub_request_status,
                                  sub_request_error_reason}] }

     It only knew the first one. A Marketing reply has no `status` field at
     all, so every campaign write — including the successful ones — fell into
     the error branch and was logged as `error: ` with nothing after the
     colon. 87 rejections in a week whose reason was literally the empty
     string, which is why the 415 below went unread for so long.

     The sub-requests matter as much as the envelope: Snap answers HTTP 200
     with request_status ERROR when the batch itself was fine but the object
     was not (`E2006 … startTime is a required field`). Calling that a success
     would be worse than the old bug. */
  readBatchResult(res, n) {
    const j = res.json;
    const isMarketing = !!(j && (j.request_status || j.campaigns || j.segments || j.adaccounts));
    if (isMarketing) {
      const subs = [].concat(j.campaigns || [], j.segments || [], j.adaccounts || []);
      const bad = subs.find((s) => s && s.sub_request_status && s.sub_request_status !== "SUCCESS");
      if (res.ok && j.request_status === "SUCCESS" && !bad) return { ok: true, accepted: n, raw: j };
      return {
        ok: false,
        error: bad?.sub_request_error_reason || j.debug_message || j.display_message
          || res.error || `HTTP ${res.status}`,
        raw: j,
      };
    }
    if (res.ok && (!j || j.status === "VALID" || j.status === "SUCCESS")) return { ok: true, accepted: n, raw: j };
    const said = j ? `${j.status || "error"}: ${j.reason || j.message || ""}`.trim() : "";
    return {
      // A colon with nothing after it is not a reason. Fall back to the status.
      ok: false,
      error: said && !/^\w+:$/.test(said) ? said : (res.error || `HTTP ${res.status}`),
      raw: j ?? res.text ?? null,
    };
  },

  /* Marketing API bearer. SNAP_MARKETING_TOKEN short-circuits the OAuth dance.
     Snap's access tokens live one hour and it says so in `expires_in`; the
     old code assumed 25 minutes and ignored what it was told. */
  async token() {
    const direct = env("SNAP_MARKETING_TOKEN");
    if (direct) return direct;
    const id = env("SNAP_CLIENT_ID"), secret = env("SNAP_CLIENT_SECRET"), refresh = env("SNAP_REFRESH_TOKEN");
    if (!id || !secret || !refresh) return null;
    if (this._tok && Date.now() < this._tokExp) return this._tok;
    const res = await httpJson("https://accounts.snapchat.com/login/oauth2/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
    });
    if (!res.ok || !res.json?.access_token) {
      this._tokErr = res.json?.error_description || res.json?.error || res.error || `HTTP ${res.status}`;
      return null;
    }
    this._tokErr = null;
    this._tok = res.json.access_token;
    this._tokAt = Date.now();
    // Renew five minutes early so a batch that starts at minute 59 still lands.
    this._tokExp = Date.now() + Math.max(60, (Number(res.json.expires_in) || 1800) - 300) * 1000;
    return this._tok;
  },

  /* The CAPI uses SNAP_ACCESS_TOKEN — a long-lived token pasted into the
     environment by hand. Between 2026-08-06 23:56 and 2026-08-07 05:15 that
     token was not valid and Snap answered 401 to 590 events, which were
     silently written off as failures and never resent. A token we cannot
     renew will do that again the day it lapses.

     We already hold OAuth credentials that can mint a fresh token on demand,
     so a 401 from the CAPI is now recoverable rather than fatal: drop the
     static token for this send and retry once with a minted one. */
  async recoverAndRetry(call, res) {
    if (!res || res.status !== 401) return null;
    if (!String(call.url || "").includes("tr.snapchat.com")) return null;
    const t = await this.token();
    if (!t) return null;
    this._capiFellBackAt = Date.now();
    return { ...call, url: String(call.url).replace(/access_token=[^&]*/, `access_token=${encodeURIComponent(t)}`) };
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
      /* نفس عمى ميتا كان هنا بالظبط: `conversion_purchases` وبس، والشرا
         الأونلاين مش موجود عندنا أصلاً. سناب بتسمّي أحداثنا كده (شوف
         SNAP_NAME في funnel.js): Lead → SIGN_UP، Contact → CUSTOM_EVENT_1.
         فـ `conversion_sign_ups` هو نفس دوسة «اطلب على واتساب» — وهو اللي
         بنعدّه دلوقتي.

         تحذير مقصود: سناب **مبتطلّعش حقل إحصائي لـ CUSTOM_EVENT_1** — جرّبناه
         على الحساب الحقيقي ورجع 400 «Unknown Field, conversion_custom_event_1».
         يعني دوسة «اتصل» (Contact من غير Lead) مش مرئية على سناب. ومعنى ده إن
         رقم سناب أقل من الحقيقة دايماً بمقدار غير معروف، مش إنه صفر كاذب:
         الـ SIGN_UP بيتولّع مع كل دوسة واتساب فالغطاء الأساسي موجود. */
      const params = new URLSearchParams({
        granularity: "TOTAL",
        fields: "spend,impressions,swipes,conversion_purchases,conversion_purchases_value,conversion_sign_ups",
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
        /* نفس منطق ميتا: أسطح مختلفة بتتجمع. SIGN_UP و PURCHASE مش نفس
           الفعل (اللي بيدفع أونلاين مش بيدوس زرار واتساب).

           و`res.ok` شرط في العدّ مش في نص الخطأ بس: لو سناب ردّت 4xx، الـ
           stats بترجع {} والعدّ كان بيطلع **صفر واثق**. وصفر واثق مع صرف
           حقيقي = بالظبط الحالة اللي قاعدة القتل بتوقّف عليها الحملة. يعني
           عطل في الـ API كان ممكن يقفل حملة شغّالة. الخطأ = null (عمى قياس)
           مش صفر — نفس تفرقة readMetaResult بالظبط. */
        results: res.ok
          ? Number(s.conversion_sign_ups || 0) + Number(s.conversion_purchases || 0)
          : null,
        resultBasis: res.ok
          ? { web_intent: Number(s.conversion_sign_ups || 0),
              purchase: Number(s.conversion_purchases || 0) }
          : null,
        // الإيراد المحقّق فقط — سناب مبترجّعش قيمة لـ SIGN_UP أصلاً.
        resultValue: s.conversion_purchases_value != null ? Number(s.conversion_purchases_value) / 1e6 : 0,
        ...(res.ok ? {} : { error: res.json?.debug_message || res.error || `HTTP ${res.status}` }),
      });
    }
    return { ok: true, rows };
  },

  /* الصرف يوم بيوم. سناب بتفرض حاجتين هنا اتعلمناهم من ردودها الحقيقية:
     ١) على مستوى الحساب مسموح بحقل `spend` وبس — أي حقل زيادة بيرجع
        E1008 «Only field 'spend' should be used when querying AdAccount stats».
     ٢) مع granularity=DAY لازم البداية تكون نص الليل **بتوقيت الحساب**، مش
        UTC: «must have a start time that is the start of day (00:00:00) for
        the account's timezone». فبنقرا توقيت الحساب من سناب نفسها بدل ما
        نفترضه، وبنبني الإزاحة منه.
     ملحوظة على الحدود: يوم سناب بيلف نص الليل بتوقيت الحساب (الرياض عندنا)،
     ويوم المطعم بيلف ٤ الفجر — يعني ساعات ٠٠:٠٠–٠٤:٠٠ بتقع على يوم سناب
     التالي وعلى يوم المطعم السابق. الفرق ده مكتوب في الكشف. */
  async dailySpend({ from, to }) {
    const t = await this.token();
    const acct = env("SNAP_AD_ACCOUNT_ID");
    if (!t || !acct) return { ok: false, reason: "SNAP_AD_ACCOUNT_ID / Snap OAuth credentials missing", rows: [] };
    const hdr = { headers: { Authorization: `Bearer ${t}` } };
    const meta = await httpJson(`${this.apiBase}/adaccounts/${acct}`, hdr);
    const tz = meta.json?.adaccounts?.[0]?.adaccount?.timezone || "Asia/Riyadh";
    // إزاحة التوقيت بصيغة ±HH:MM زي ما سناب عايزاها.
    const offset = (() => {
      try {
        const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
          .formatToParts(new Date(`${from}T12:00:00Z`))
          .find((x) => x.type === "timeZoneName")?.value || "GMT+03:00";
        const m = /GMT([+-])(\d{2}):(\d{2})/.exec(p);
        return m ? `${m[1]}${m[2]}:${m[3]}` : "+03:00";
      } catch { return "+03:00"; }
    })();
    const endExclusive = (() => {
      const d = new Date(`${to}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const params = new URLSearchParams({
      granularity: "DAY",
      fields: "spend",
      start_time: `${from}T00:00:00.000${offset}`,
      end_time: `${endExclusive}T00:00:00.000${offset}`,
    });
    const res = await httpJson(`${this.apiBase}/adaccounts/${acct}/stats?${params}`, hdr);
    if (!res.ok) {
      return { ok: false, reason: res.json?.debug_message || res.error || `HTTP ${res.status}`, rows: [] };
    }
    const series = res.json?.timeseries_stats?.[0]?.timeseries_stat?.timeseries || [];
    return {
      ok: true,
      accountTz: tz,
      rows: series.map((x) => ({
        platform: "snapchat",
        day: String(x.start_time || "").slice(0, 10),
        campaignId: null,
        campaignName: null,                       // مستوى الحساب — سناب مبتسمحش بتفصيل هنا
        spend: x.stats?.spend != null ? Number(x.stats.spend) / 1e6 : 0,
        impressions: null,
        clicks: null,
      })),
    };
  },

  /* ─── WRITE: campaign state / budget ───────────────────────────────────
     There is no PATCH on a Snap campaign. The old code sent
       PATCH /adaccounts/{acct}/campaigns/{id}
     and Snap answered every single time with

       HTTP 415 · E0002
       "Content type requested by client is not supported: [application/json]"

     — a content-type complaint that is really "this verb does not exist
     here", which is why it read as a header bug and was never fixed. 87
     pause/resume orders a week died there, so the 11:00→03:00 window was
     never enforced on Snap at all.

     The update is PUT on the COLLECTION, body { campaigns: [ … ] }. And it is
     a FULL replace, not a merge: send only { id, status } and Snap refuses
     with `E2006 … startTime is a required field`. Send only the fields we
     care about and it would wipe the rest — the old comment's fear was
     right about PUT, just wrong about PATCH being available instead.

     So the descriptor below carries the intent, and authorize() reads the
     campaign back and replays it whole with that one field changed.
     `_hydrate` sits OUTSIDE url/method/headers/body, which is all
     safeRequest() ever reads, so the dry-run preview never echoes it. */
  _campaignWrite(id, patch) {
    const acct = env("SNAP_AD_ACCOUNT_ID");
    return {
      url: `${this.apiBase}/adaccounts/${acct}/campaigns`,
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ***resolved-at-send***" },
      // What a dry run shows. The real body is built at send time from the
      // campaign as it stands, so nothing we did not name gets reset.
      body: { campaigns: [{ id: String(id), ...patch, "…": "بقية حقول الحملة بتترجع زي ما هي وقت الإرسال" }] },
      _hydrate: { id: String(id), patch },
    };
  },
  stateCall(id, state) { return this._campaignWrite(id, { status: state }); },
  budgetCall(id, dailyBudget) {
    return this._campaignWrite(id, { daily_budget_micro: Math.round(dailyBudget * 1e6) });
  },

  // Fields Snap writes itself. Replaying them is either refused or meaningless;
  // everything NOT on this list is preserved verbatim, which is the point.
  readOnlyFields: [
    "created_at", "updated_at", "delivery_status", "sub_request_status",
    "created_by_app_id", "created_by_user", "last_updated_by_app_id", "last_updated_by_user",
  ],

  async campaignRaw(id, t) {
    const res = await httpJson(`${this.apiBase}/campaigns/${id}`, { headers: { Authorization: `Bearer ${t}` } });
    const parsed = this.readBatchResult(res, 1);
    if (!parsed.ok) return { ok: false, reason: `مقدرناش نقرا حملة سناب ${id}: ${parsed.error}` };
    const c = res.json?.campaigns?.[0]?.campaign;
    if (!c) return { ok: false, reason: `سناب رجّع الحملة ${id} فاضية` };
    return { ok: true, campaign: c };
  },

  async authorize(call) {
    const t = await this.token();
    if (!t) {
      return { error: `Snap OAuth refused: ${this._tokErr || "SNAP_CLIENT_ID / SNAP_CLIENT_SECRET / SNAP_REFRESH_TOKEN missing"}` };
    }
    const out = { ...call, headers: { ...call.headers, Authorization: `Bearer ${t}` } };
    delete out._hydrate;
    if (call._hydrate) {
      const cur = await this.campaignRaw(call._hydrate.id, t);
      if (!cur.ok) return { error: cur.reason };
      const whole = { ...cur.campaign };
      for (const k of this.readOnlyFields) delete whole[k];
      out.body = { campaigns: [{ ...whole, ...call._hydrate.patch }] };
    }
    return out;
  },
};

/* ─── Google Ads ──────────────────────────────────────────────────────────
   Lives in google.js, because it is the only one of the four that needs a
   query language (GAQL), a second resource to write a budget (CampaignBudget)
   and a diagnostic of its own. It is built here, from this file's helpers, so
   the hashing and redaction rules still have exactly one home.

   What it can do is the same list as the other three — read campaigns/ad
   groups/budgets/insights, pause-resume, move a daily budget, push offline
   conversions — under the same ADS_ALLOW_WRITE gate and the same budget
   ceiling. No Google exception anywhere.

   The one honest caveat: an offline conversion needs a real identifier. The
   adapter's usable() demands a gclid/gbraid/wbraid or a hashed phone/email,
   and ads.js does not even CLAIM an event that fails it — so an order with no
   identity is a reported skip, not a failure and never an invented row.

   docs https://developers.google.com/google-ads/api/rest/overview
        https://developers.google.com/google-ads/api/docs/conversions/upload-clicks */
const google = createGoogleAdapter({ httpJson, hashEmail, hashPhonePlus, googleDateTime });

function googleDateTime(d) {
  // Google wants "yyyy-mm-dd hh:mm:ss+|-hh:mm". We are Asia/Riyadh, UTC+03:00.
  const t = new Date(d.getTime() + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+03:00`;
}

const PLATFORMS = [meta, tiktok, snapchat, google];
const byId = (id) => PLATFORMS.find((p) => p.id === String(id || "").toLowerCase());

/* One rule for four platforms: you can send if you hold the credentials to
   send, and you can manage if you hold the credentials to manage. Google used
   to be excluded from `canManage` by name because its adapter was a stub; the
   stub is gone, so the exception is gone with it. An unconfigured platform now
   degrades identically whichever one it is — the missing env vars ARE the
   "not connected" message. */
const canSend = (p) => missingOf(p.conversionEnv).length === 0;
const canManage = (p) => missingOf(p.manageEnv).length === 0;

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

  /* The till writes a VARIANT name; the catalog holds the BASE product.
     Measured 2026-08-09 over 30 days: exact lowercase matching mapped only
     81% of order lines onto a catalog id, and every miss was one of three
     shapes, never a genuinely absent product:
       "بيتزا تشيكن رانش - وسط"                   size suffix after " - "
       "بيتزا تشيكن رانش 1.0 حشو اطراف كيري"      modifier tail
       "مشكل مخصوص بالوزن - ثلث كيلو"             weight suffix
       "مشروبات غازية - كان"                       packaging suffix
     Meta keys a catalog product by `id`; a line that carries `n:<name>`
     instead is invisible to product ads and adds nothing to the optimiser.
     So: normalise Arabic orthography, then peel the variant tails off in
     order and retry, longest form first, so "كفتة نصف كيلو" (a real catalog
     row of its own) still wins over the base "كفتة مشوية بالوزن". */
  const arNorm = (s) => String(s || "")
    .replace(/[ً-ْـ]/g, "")               // harakat + tatweel
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/[ىئ]/g, "ي").replace(/ؤ/g, "و")
    // The hyphen SURVIVES here on purpose: it is the variant separator the
    // till uses ("… - وسط"), and stripping it as punctuation is what made the
    // first version of this matcher silently do nothing.
    .replace(/[^\p{L}\p{N}\s.\-]/gu, " ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const normName = (s) => arNorm(s);

  // Lines that are not products at all. Sending a delivery fee to a catalog
  // as if it were a dish teaches the optimiser nothing and pollutes DPA.
  const NOT_A_PRODUCT = /^(توصيل|رسوم توصيل|رسوم|خدمة|ضريبه|ضريبة|تيك اوي|delivery|service|tax)$/;

  // Progressively shorter candidates for one till name, longest first.
  function nameCandidates(raw) {
    const base = arNorm(raw);
    const out = [base];
    // "… 1.0 حشو اطراف كيري" / "… 1.0 بدون حشو اطراف"  → drop the modifier tail
    const noMod = base.replace(/\s\d+(\.\d+)?\s+(حشو|بدون|مع|اضافه|اضافات).*$/, "").trim();
    if (noMod && noMod !== base) out.push(noMod);
    // "… - وسط" / "… - ثلث كيلو" / "… - كان"  → drop the variant after the dash
    for (const c of [...out]) {
      const i = c.lastIndexOf(" - ");
      if (i > 0) { const cut = c.slice(0, i).trim(); if (cut && !out.includes(cut)) out.push(cut); }
    }
    return out;
  }

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

  /** till item name → catalog product id, or null. Handed back by register()
   *  so the tracking health check reports the real match rate, not a guess. */
  async function matchToCatalog(name) {
    if (NOT_A_PRODUCT.test(arNorm(name))) return "__fee__";
    const idx = await menuIndex();
    for (const cand of nameCandidates(name)) {
      const hit = idx.get(cand);
      if (hit) return hit;
    }
    return null;
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
      const norm = normName(row.name);
      if (NOT_A_PRODUCT.test(norm)) continue;            // fees are not basket contents
      let id = null;
      for (const cand of nameCandidates(row.name)) { id = idx.get(cand) || null; if (id) break; }
      if (!out.has(row.order_id)) out.set(row.order_id, []);
      out.get(row.order_id).push({
        id: id || `n:${norm.slice(0, 60)}`,   // اسم كبديل لو الصنف مش في الكاتالوج
        matched: !!id,
        name: String(row.name || "").trim(),
        quantity: qty,
        unitPrice: Math.round((total / qty) * 100) / 100,
      });
    }
    return out;
  }

  /* ─── Google click ids ───────────────────────────────────────────────
     The ONLY thing that can key a Google offline conversion to a real ad
     click. The storefront pixel stores gclid/gbraid/wbraid in
     funnel_events.click_ids when the customer lands from a Google ad; if
     that order later shows up at the till, the two halves meet here.

     Read in its own query, the same way basket items are, so a missing or
     empty funnel_events can never take /api/ads/sync-orders down with it —
     the click id is a bonus that improves matching, never a precondition. */
  async function loadClickIds(orderIds) {
    const out = new Map();
    if (!orderIds.length) return out;
    const r = await pool.query(
      `SELECT DISTINCT ON (order_id) order_id,
              click_ids->>'gclid'  AS gclid,
              click_ids->>'gbraid' AS gbraid,
              click_ids->>'wbraid' AS wbraid
         FROM funnel_events
        WHERE order_id = ANY($1::text[])
          AND (click_ids->>'gclid' IS NOT NULL
            OR click_ids->>'gbraid' IS NOT NULL
            OR click_ids->>'wbraid' IS NOT NULL)
        ORDER BY order_id, created_at DESC`, [orderIds]);
    for (const row of r.rows) {
      out.set(String(row.order_id), {
        gclid: row.gclid || null, gbraid: row.gbraid || null, wbraid: row.wbraid || null,
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
  function toEvent(row, eventName = "Purchase", items = null, click = null) {
    const digits = row.phone_norm ? phoneDigits(row.phone_norm, normPhone) : null;
    return {
      // Google only. Exactly one of the three is ever set on a click, and the
      // adapter sends whichever is present — never a substitute.
      gclid: click?.gclid || null,
      gbraid: click?.gbraid || null,
      wbraid: click?.wbraid || null,
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
      matchKeys: [digits ? "phone" : null, row.email ? "email" : null, row.customer_id ? "customer_id" : null,
        click?.gclid || click?.gbraid || click?.wbraid ? "google_click" : null]
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
      // Only ever what the caller genuinely handed us — a click id is not
      // something this route may invent to make a conversion look matchable.
      gclid: body.gclid || null,
      gbraid: body.gbraid || null,
      wbraid: body.wbraid || null,
      actionSource: body.actionSource || "physical_store",
      matchKeys: [digits ? "phone" : null, body.email ? "email" : null,
        body.gclid || body.gbraid || body.wbraid ? "google_click" : null].filter(Boolean),
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
      out.errors.push(`not configured — missing ${missingOf(p.conversionEnv).join(", ")}`);
      return out;
    }

    /* ─── pre-flight: fail closed, once, instead of open, per row ────────
       Having every env var is not the same as being able to upload. Google
       will take the credentials, take the batch, and reject every row because
       the conversion action is the wrong TYPE — and because ads.js retries
       `failed` rows, that becomes the same error written down dozens of times
       a day with no way to act on it from the dashboard.

       An adapter that can know in advance says so here. Nothing is claimed and
       nothing is marked failed: the orders stay eligible, so the day the
       account is fixed they upload with their real timestamps. One reason
       line, surfaced on /api/ads/status, replaces the error counter.        */
    if (p.preflight) {
      let pre;
      try { pre = await p.preflight(); }
      catch (e) { pre = { ok: true, note: `preflight itself failed: ${e.message}` }; }  // never let the check block a working send
      if (pre && pre.ok === false) {
        out.attempted = 0;
        out.skipped = events.length;
        out.notReady = pre.reason;
        out.notReadyCode = pre.code || null;
        out.errors.push(pre.reason);
        return out;
      }
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
        /* authorize() is the send-time hook: it stamps the bearer token and,
           for Google, resolves the budget resource it could not know when the
           descriptor was built. It may refuse — and a refusal that says WHY
           (refresh token revoked, budget is shared) beats a blanket "token
           exchange failed", so a call that comes back with no url is read for
           its `error` instead. */
        const authed = await p.authorize(call);
        if (!authed || !authed.url) {
          const why = authed?.error || "could not obtain an access token";
          out.failed += chunk.length;
          out.errors.push(`${p.id}: ${why}`);
          await finish(ids, "failed", { error: why });
          continue;
        }
        call = authed;
      }
      let res = await httpJson(call.url, { method: call.method, headers: call.headers, body: call.body });
      let parsed = p.readBatchResult(res, chunk.length);
      /* One second chance, and only for a credential the adapter can replace
         by itself. Snap's CAPI token is pasted in by hand and cannot be
         renewed — when it lapsed on 2026-08-07 it took 590 events with it,
         because a 401 was recorded as a permanent failure and the batch was
         never retried. The adapter can mint a fresh token from OAuth, so it
         gets to try exactly once before we write the loss down. */
      if (!parsed.ok && p.recoverAndRetry) {
        const retry = await p.recoverAndRetry(call, res);
        if (retry) {
          res = await httpJson(retry.url, { method: retry.method, headers: retry.headers, body: retry.body });
          parsed = p.readBatchResult(res, chunk.length);
          if (parsed.ok) out.recoveredAfterAuthFailure = (out.recoveredAfterAuthFailure || 0) + chunk.length;
        }
      }
      if (parsed.ok) {
        out.sent += chunk.length;
        await finish(ids, "sent", { httpStatus: res.status, platform: parsed.raw ?? null, sentAt: new Date().toISOString() });
      } else if (parsed.permanent) {
        /* The platform refused the whole service, not these rows — an account
           that is not allowlisted, a developer token that was never approved.
           Filing that as `failed` is wrong twice over: it reads as if the
           orders were bad, and `failed` rows are retried, which turns one shut
           door into a daily error stream. `skipped` is the truth, and it keeps
           the orders eligible for the day the door opens.                    */
        out.skipped += chunk.length;
        out.notReady = parsed.reason || parsed.error;
        if (!out.errors.includes(out.notReady)) out.errors.push(out.notReady);
        await finish(ids, "skipped", { httpStatus: res.status, reason: parsed.reason || parsed.error, permanent: true });
        break;                                   // no point sending batch two
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
    // Google-only: an order that can be tied to an actual ad click. Reported
    // separately because it is the one thing that makes a Google offline
    // conversion strong rather than best-effort.
    const withGoogleClick = events.filter((e) => e.gclid || e.gbraid || e.wbraid).length;
    const withItems = events.filter((e) => e.contents && e.contents.length).length;
    const lines = events.flatMap((e) => e.contents || []);
    const matchedLines = lines.filter((i) => i.matched).length;
    return {
      total: events.length,
      withPhone,
      withEmail,
      withGoogleClick,
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

  /* An adapter that pre-flights caches its verdict; we only ever read that
     cache here so /api/ads/status never waits on a platform round-trip. Null
     until the first sync (or the first diagnose) asked. */
  const readinessOf = (p) => {
    const r = p.lastReadiness?.();
    return r && r.ok === false ? r : null;
  };

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
                count(*) FILTER (WHERE status='sent')::int AS sent_total,
                /* Sixty-one failures that all say the same thing are one
                   problem, not sixty-one. Show the newest reason next to the
                   count so the tile is readable without opening the table. */
                (ARRAY_AGG(response->>'error' ORDER BY created_at DESC)
                   FILTER (WHERE status='failed' AND response ? 'error'))[1] AS last_error
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
          /* ONE reason line, not a counter of the same error repeated.
             `blockedReason` is the adapter's own pre-flight verdict — why we
             are deliberately not sending — and it is read from cache, never
             from the network, so this tile stays instant. `lastFailure` is the
             last thing the platform actually said when we did send. */
          ...(readinessOf(p) ? { blocked: true, blockedReason: readinessOf(p).reason, blockedCode: readinessOf(p).code } : {}),
          ...(s.last_error ? { lastFailure: s.last_error } : {}),
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
    const ids = rows.map((r) => String(r.order_id));
    let itemsByOrder = new Map();
    try { itemsByOrder = await loadItems(ids); }
    catch (e) { console.error("[ads] items load failed:", e.message); }  // basket is a bonus, never a blocker
    let clickByOrder = new Map();
    try { clickByOrder = await loadClickIds(ids); }
    catch (e) { console.error("[ads] click ids load failed:", e.message); }
    const events = rows.map((r) => toEvent(r, b.eventName || "Purchase",
      itemsByOrder.get(String(r.order_id)) || null, clickByOrder.get(String(r.order_id)) || null));

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

  /* GET /api/ads/adsets?platform=meta&from=&to=
     قراءة فقط. المجموعات الإعلانية بميزانيتها ومرحلة تعلّمها وصرفها —
     دي الوحدة اللي الإيقاع بيشتغل عليها في حملات ABO، فلازم تبقى مقروءة
     من بره زي الحملات بالظبط. */
  app.get("/api/ads/adsets", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const q = c.req.query();
    const to = q.to || todayISO();
    const from = q.from || daysAgoISO(2);
    const rows = [], reasons = {};
    for (const p of PLATFORMS) {
      if (q.platform && p.id !== q.platform) continue;
      if (typeof p.adsets !== "function") continue;
      if (!canManage(p)) { reasons[p.id] = `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ") || "صلاحيات"}`; continue; }
      try {
        const r = await p.adsets();
        if (!r.ok) { reasons[p.id] = r.reason; continue; }
        let stats = {};
        try {
          const ins = await p.adsetInsights({ from, to });
          if (ins.ok) stats = Object.fromEntries(ins.rows.map((x) => [String(x.adsetId), x]));
        } catch { /* الأرقام إضافة، مش شرط */ }
        for (const a of r.rows) {
          const s = stats[a.id];
          rows.push({
            ...a,
            recent: s
              ? { from, to, spend: s.spend, impressions: s.impressions, clicks: s.clicks, results: s.results, resultBasis: s.resultBasis }
              : { from, to, spend: null, impressions: null, clicks: null, results: null, resultBasis: null },
          });
        }
      } catch (e) { reasons[p.id] = String(e.message || e); }
    }
    return c.json({ ok: true, range: { from, to }, adsets: rows, reasons });
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
    /* One shared send path with the autopilot's executeDecision — same gate,
       same classification, same words for a refusal. A button and a robot
       pressing the same platform should not disagree about what happened. */
    const r = await sendPlatformWrite(p, call);
    return c.json({
      ok: r.ok,
      applied: r.ok,
      did: describe,
      httpStatus: r.httpStatus ?? null,
      ...(r.ok ? { platform: redact(r.raw ?? null) } : {
        error: r.error,
        failureKind: r.kind || null,
        ...(r.gated ? { gated: true } : {}),
        ...(r.retryInMinutes ? { retryInMinutes: r.retryInMinutes } : {}),
        ...(r.accessTier ? { accessTier: r.accessTier } : {}),
        platform: redact(r.raw ?? null),
      }),
    }, r.ok ? 200 : 502);
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

  /* GET /api/ads/google/fields?prefix=ad_group_criterion&selectable=1
     أسماء الأعمدة زي ما جوجل نفسها بتقولها في النسخة المربوطة دلوقتي. لما
     تيجي نسخة جديدة وتغيّر اسم عمود (v24 غيّرت campaign.start_date لـ
     start_date_time)، ده المكان اللي بيقول الاسم الجديد من غير تخمين. */
  app.get("/api/ads/google/fields", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const g = byId("google");
    if (!canManage(g)) return c.json({ ok: false, error: `missing ${missingOf(g.manageEnv).join(", ")}` }, 400);
    const r = await g.fields(c.req.query("prefix") || "");
    const onlySelectable = c.req.query("selectable") === "1";
    return c.json({ ...r, fields: onlySelectable ? (r.fields || []).filter((f) => f.selectable) : r.fields });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     POST /api/ads/google/conversion-action {name?, category?}

     بيعمل إجراء تحويل جديد نوعه UPLOAD_CLICKS عشان طلبات الكاشير.

     ليه إجراء جديد ومش تعديل الموجود: «WhatsApp Order Click» نوعه WEBPAGE
     وبيقيس فعلاً ضغطات واتساب على الموقع — ده قياس صحيح وشغّال، وتغيير نوعه
     بيلغي التاريخ ويكسر القياس ده. الرفع من السيرفر محتاج نوع تاني، فالحل
     إجراء منفصل جنبه مش مكانه.

     بيمشي على نفس بوابة ADS_ALLOW_WRITE زي أي تعديل تاني: لو مقفولة بيرجع
     النداء اللي كان هيتبعت من غير ما يبعته. مش بيلمس ولا حملة ولا ميزانية
     ولا فوترة، وبيتعمل primary_for_goal=false عشان مايدخلش في حسابات
     Smart Bidding من غير ما حد يقرر ده.

     بعد النجاح: خُد الـ id من الرد وحطّه في GOOGLE_ADS_CONVERSION_ACTION_ID.
     ═══════════════════════════════════════════════════════════════════════ */
  app.post("/api/ads/google/conversion-action", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    let b = {};
    try { b = await c.req.json(); } catch { b = {}; }
    const name = String(b.name || "Fresh Cuts - Till Orders (Import)").slice(0, 120);
    const category = String(b.category || "PURCHASE").toUpperCase();
    const id = b.id ? String(b.id) : null;      // pass an id to rename one, nothing else
    return guardedWrite(c, "google", (p) => {
      if (!p.createUploadActionCall) throw new Error("this adapter cannot create conversion actions");
      return p.createUploadActionCall({ name, category, currency: DEFAULT_CURRENCY, id });
    }, id ? `rename Google Ads conversion action ${id} to "${name}"`
      : `create a UPLOAD_CLICKS conversion action named "${name}" (category ${category}) in the Google Ads account`);
  });

  /* ═══════════════════════════════════════════════════════════════════════
     GET /api/ads/google/diagnose?days=14 — "ليه جوجل مش بيعرض؟"

     نداء واحد بيرجع كل اللي كان بيتطلب فتح واجهة جوجل عشانه: حالة الحساب،
     كل حملة وحالتها الحقيقية عند جوجل (primary_status) وأسبابها المفصّلة،
     الميزانية، الانطباعات والنقرات في المدى، الإعلانات وحالة مراجعتها،
     الكلمات المفتاحية، وإجراءات التحويل وكام تحويل اتسجّل على كل واحد.

     كل قسم بيتقرا باستعلام لوحده وبيسجّل فشله لوحده — عمود واحد مش مدعوم
     في نسخة الـ API مايصحّش يودّي الإجابة كلها. اللي مقدرناش نقراه بيترجع
     في `errors` بنفس وضوح اللي قدرنا نقراه، و`findings` هي الفقرة اللي
     المالك بيقراها فعلاً: كل مانع بالعربي مرتّب من الأخطر.
     ═══════════════════════════════════════════════════════════════════════ */
  app.get("/api/ads/google/diagnose", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const days = Math.min(Math.max(Number(c.req.query("days") || 14), 1), 90);
    const g = byId("google");
    try {
      const out = await g.diagnose({ days });
      // 200 even when Google is not connected: "مش مربوط" is an answer, not a
      // server fault — same contract every other read route here keeps. The
      // caller reads `connected`, not the HTTP status.
      return c.json({ ...out, ok: true });
    } catch (e) {
      console.error("[ads] google diagnose failed:", e.message);
      return c.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════
     GET /api/ads/scorecard?from&to — "كل منصة صرفت كام وجابتلنا كام"

     صف واحد لكل منصة. الصرف والانطباعات والنقرات لايف من insights بتاعة
     المنصة نفسها. أما التحويلات فبعمودين مختلفين عن قصد:

       platformConversions — الرقم اللي المنصة بتقوله، وهو دلوقتي **نية
         الطلب** مش الشرا: دوسة «اطلب على واتساب» (Contact/Lead) + محادثة
         واتساب ابتدت من الإعلان + أي شرا أونلاين لو حصل. كان بيعدّ الشرا
         وبس، وده رقم مستحيل يطلع عندنا (physical_store) — فكان صفر أبدي،
         وقاعدة القتل في autopilot.js كانت هتوقّف الحساب كله عليه.
         التعريف الواحد لـ«النتيجة» عايش في META_RESULT_MODEL فوق.
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

      /* الجمع بيفرّق بين «صفر» و«عمى». `readable` بيعدّ الصفوف اللي المنصة
         رجّعت لها نوع نتيجة نعرف نقراه. لو مفيش ولا صف مقروء، المجموع
         بيرجع null مش صفر — وإلا كنا هنطبع على شاشة المالك «صفر نتيجة، ودي
         إشارة حقيقية» في نفس الحالة اللي إحنا فيها عميان. ده بالظبط نفس
         الباج اللي بنصلّحه، بس على مستوى المنصة بدل الحملة. */
      const t = ins.rows.reduce((a, r) => {
        for (const [k, v] of Object.entries(r.resultBasis || {})) a.basis[k] = (a.basis[k] || 0) + (Number(v) || 0);
        return {
          spend: a.spend + (Number(r.spend) || 0),
          impressions: a.impressions + (Number(r.impressions) || 0),
          clicks: a.clicks + (Number(r.clicks) || 0),
          results: a.results + (r.results == null ? 0 : Number(r.results) || 0),
          readable: a.readable + (r.results == null ? 0 : 1),
          blind: a.blind + (r.results == null ? 1 : 0),
          resultValue: a.resultValue + (Number(r.resultValue) || 0),
          basis: a.basis,
        };
      }, { spend: 0, impressions: 0, clicks: 0, results: 0, readable: 0, blind: 0, resultValue: 0, basis: {} });
      /* مفيش ولا حملة رجّعت نوع نعرفه → المنصة عمياها علينا، مش صفر. */
      const blindPlatform = t.readable === 0 && ins.rows.length > 0;
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
        platformConversions: blindPlatform ? null : t.results,
        platformConversionValue: Math.round(t.resultValue * 100) / 100,
        /* «نتيجة» = نية الطلب زي ما المنصة بتشوفها: دوسة «اطلب على واتساب»
           (Contact/Lead) + محادثة واتساب ابتدت من الإعلان + أي شرا أونلاين.
           مش الشرا وحده — الشرا بيحصل جوّه المطعم وبيتبعت physical_store
           فالمنصة عمرها ما هتشوفه. شوف META_RESULT_MODEL.
           null = المنصة مرجّعتش نوع نعرفه (عمى)، مش صفر. */
        platformResults: blindPlatform ? null : t.results,
        platformResultBasis: blindPlatform ? null : t.basis,
        platformResultsBlind: t.blind,
        platformCostPerResult: !blindPlatform && t.results > 0
          ? Math.round((t.spend / t.results) * 100) / 100 : null,
        platformNote: platformNoteFor(p, t, ins.rows.length, blindPlatform),
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
    // Google buries the useful sentence two levels down; `error.message` on
    // its own only ever says "Request contains an invalid argument".
    const gInner = (e) => e?.details?.find((d) => Array.isArray(d?.errors))?.errors?.[0]?.message;
    return gInner(j?.error) || gInner(j?.partialFailureError)  // Google Ads
      || j?.error?.message                                     // Meta
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
      const ids = rows.map((r) => String(r.order_id));
      let itemsByOrder = new Map();
      try { itemsByOrder = await loadItems(ids); } catch { /* bonus */ }
      let clickByOrder = new Map();
      try { clickByOrder = await loadClickIds(ids); } catch { /* bonus */ }
      const events = rows.map((r) => toEvent(r, "Purchase",
        itemsByOrder.get(String(r.order_id)) || null, clickByOrder.get(String(r.order_id)) || null));
      const results = {};
      for (const p of PLATFORMS) {
        if (!canSend(p)) continue;
        try { results[p.id] = await sendToPlatform(p, events); }
        catch (e) { results[p.id] = { platform: p.id, failed: events.length, errors: [String(e.message || e)] }; }
      }
      return { from: f, to: t, orders: events.length, platforms: results };
    },
    // tracking.js asks "does this till name reach a catalog id?" — same code
    // path the real Purchase payload uses, so the reported rate is the truth.
    matchToCatalog,
    // reports.js reads the same per-platform scorecard the screen reads. One
    // function → the report and the screen can never quote two different
    // spends for the same week.
    scorecardData,
    // الصرف يوم بيوم لكل منصة — الكشف اليومي في scorecard.js بيقراها.
    dailySpendData,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   الصرف يوم بيوم عبر المنصات الأربعة.

   ليه دي منفصلة عن scorecardData: دي بترجّع **صف لكل يوم**، وscorecardData
   بترجّع مجموع المدى كله. المدى بيداري فرق حدود اليوم، واليوم لأ — فكل
   منصة بترجّع معاها التوقيت اللي يومها بيلف عليه، والكشف بيكتبه على الشاشة
   بدل ما يسكت عنه.

   القاعدة اللي مش بتتكسر: **منصة وقعت ≠ صرف صفر**. لو قراءة منصة فشلت
   بترجع في `unavailable` بالسبب ويومها بيرجع null — عشان ما نطبعش «صرفنا
   صفر» في نفس الحالة اللي إحنا فيها عميان. صفر معناه قرينا ولقينا صفر.
═══════════════════════════════════════════════════════════════════════════ */
export async function dailySpendData(from, to) {
  const byDay = new Map();        // day → { meta, tiktok, snapchat, google }
  const unavailable = [];
  const accountTz = {};
  const readOk = [];

  const add = (day, platform, spend) => {
    if (!day) return;
    const cur = byDay.get(day) || {};
    cur[platform] = (cur[platform] || 0) + (Number(spend) || 0);
    byDay.set(day, cur);
  };

  for (const p of PLATFORMS) {
    if (!canManage(p)) {
      unavailable.push({ platform: p.id, why: `غير مربوطة — ناقص ${missingOf(p.manageEnv).join(", ") || "صلاحيات"}` });
      continue;
    }
    if (typeof p.dailySpend !== "function") {
      unavailable.push({ platform: p.id, why: "الموصل بتاع المنصة دي مش بيدعم تقطيع يوم بيوم" });
      continue;
    }
    let r;
    try { r = await p.dailySpend({ from, to }); }
    catch (e) { unavailable.push({ platform: p.id, why: String(e?.message || e) }); continue; }
    if (!r?.ok) { unavailable.push({ platform: p.id, why: r?.reason || "المنصة رجّعت خطأ" }); continue; }
    readOk.push(p.id);
    if (r.accountTz) accountTz[p.id] = r.accountTz;
    for (const row of r.rows || []) add(row.day, p.id, row.spend);
  }

  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, v]) => {
      const per = {};
      for (const p of PLATFORMS) per[p.id] = readOk.includes(p.id) ? Math.round((v[p.id] || 0) * 100) / 100 : null;
      const total = readOk.reduce((a, id) => a + (v[id] || 0), 0);
      return { day, ...per, total: Math.round(total * 100) / 100 };
    });

  return {
    range: { from, to }, days, unavailable,
    platformsRead: readOk,
    accountTz,
    // كل منصة بتقطع يومها على توقيت حسابها هي — مش على يوم المطعم.
    partial: readOk.length > 0 && readOk.length < PLATFORMS.length,
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
