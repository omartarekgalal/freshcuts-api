/* ═══════════════════════════════════════════════════════════════════════════
   GOOGLE ADS — the fourth platform adapter.

   Same shape as meta / tiktok / snapchat in ads.js: an object with
     id, label, conversionEnv[], manageEnv[], usable(e),
     buildBatch(events), readBatchResult(res, n),
     accounts(), campaigns(), insights({from,to}),
     stateCall(id, state), budgetCall(id, dailyBudget), authorize(call)
   …plus two Google-only extras the others have no equivalent for:
     adGroups()   — Google puts budget and bidding one level above the ad
     diagnose()   — "why is this account not serving?", answered from the API

   It is built by a FACTORY rather than declared as a literal so that google.js
   imports nothing from ads.js: ads.js already imports us, and a cycle between
   the two would leave the hashing helpers in the temporal dead zone. ads.js
   hands its own helpers in, so the hashing and redaction rules still live in
   exactly one place — the rule stated at the top of ads.js.

   ── WHAT MAKES GOOGLE DIFFERENT FROM THE OTHER THREE ──────────────────────
   1. There is no REST "get campaigns" endpoint. Everything is read with GAQL
      through googleAds:searchStream, whose response is a JSON ARRAY of chunks,
      each with its own `results`. Parse accordingly.
   2. Money is MICROS (1 SAR = 1_000_000). int64 fields arrive as STRINGS.
   3. The budget is not on the campaign. It is a separate CampaignBudget
      resource, possibly SHARED with other campaigns. Changing a shared budget
      moves money on campaigns nobody asked us to touch, so we refuse it.
      Because the budget's resource name has to be looked up, budgetCall()
      returns a descriptor with a placeholder and authorize() resolves it at
      send time — the same hook Snapchat already uses for its bearer token.
   4. Status vocabulary is ENABLED|PAUSED|REMOVED. We translate to the
      ACTIVE|PAUSED the rest of the system speaks, exactly like TikTok's
      ENABLE|DISABLE translation.
   5. Every write is a `:mutate` with an explicit `updateMask`. Omit the mask
      and Google ignores the field instead of erroring.

   ── THE OFFLINE CONVERSION HONESTY RULE ───────────────────────────────────
   UploadClickConversions wants EXACTLY ONE of gclid / gbraid / wbraid, or —
   for "enhanced conversions for leads" — hashed first-party identifiers on a
   conversion action whose type accepts uploads. Fresh Cuts has no online
   payment, so a web Purchase never fires; what we do have is the WhatsApp
   click and the till. We therefore send ONLY rows that genuinely carry a
   click id (captured by the storefront pixel into funnel_events) or a hashed
   phone/email. A row with neither is not claimed and not sent — it stays
   eligible for a later sync once an identity is attached. Nothing is ever
   fabricated to make a number appear.

   docs https://developers.google.com/google-ads/api/rest/overview
        https://developers.google.com/google-ads/api/docs/query/overview
        https://developers.google.com/google-ads/api/docs/conversions/upload-clicks
═══════════════════════════════════════════════════════════════════════════ */

const env = (k) => (process.env[k] || "").trim();
const digitsOnly = (s) => String(s || "").replace(/\D/g, "");
const micros = (v) => String(Math.round(Number(v) * 1e6));
const fromMicros = (m) => (m == null ? null : Number(m) / 1e6);
const num = (v) => (v == null ? 0 : Number(v) || 0);

/* Google reports failures in three nested shapes and only the innermost one
   names the actual problem. `error.message` on its own says "Request contains
   an invalid argument", which tells the owner nothing. */
function googleError(res) {
  const j = res.json;
  // searchStream can answer with an ARRAY that carries the error in a chunk.
  const box = Array.isArray(j) ? j.find((x) => x && (x.error || x.partialFailureError)) : j;
  const inner = (e) => e?.details?.find((d) => Array.isArray(d?.errors))?.errors?.[0];

  const partial = box?.partialFailureError;
  if (partial) {
    const pi = inner(partial);
    const code = pi?.errorCode ? Object.values(pi.errorCode)[0] : null;
    return `partial failure${code ? ` (${code})` : ""}: ${pi?.message || partial.message || ""}`.trim();
  }
  const e = box?.error;
  if (e) {
    const ei = inner(e);
    const code = ei?.errorCode ? Object.values(ei.errorCode)[0] : null;
    return `${e.status || e.code || "error"}${code ? ` (${code})` : ""}: ${ei?.message || e.message || ""}`.trim();
  }
  if (!res.ok) return res.error || `HTTP ${res.status}`;
  return null;
}

/* Arabic labels for the campaign primary-status reasons. These ARE the answer
   to "why is nothing serving?", so they are translated rather than passed
   through as SCREAMING_SNAKE — the owner reads this screen, not an engineer. */
const REASON_AR = {
  CAMPAIGN_REMOVED: "الحملة محذوفة.",
  CAMPAIGN_PAUSED: "الحملة موقوفة يدويًا.",
  CAMPAIGN_PENDING: "الحملة لسه ما بدأتش — تاريخ البداية في المستقبل.",
  CAMPAIGN_ENDED: "الحملة خلصت — تاريخ النهاية عدّى.",
  CAMPAIGN_DRAFT: "الحملة لسه مسوّدة ومتنشرتش.",
  BIDDING_STRATEGY_MISCONFIGURED: "استراتيجية العروض متظبطة غلط.",
  BIDDING_STRATEGY_LIMITED: "استراتيجية العروض بتحدّ الظهور.",
  BIDDING_STRATEGY_LEARNING: "استراتيجية العروض لسه في مرحلة التعلّم.",
  BIDDING_STRATEGY_CONSTRAINED: "استراتيجية العروض مقيّدة — الهدف صعب على الميزانية دي.",
  BUDGET_CONSTRAINED: "الميزانية اليومية بتحدّ الظهور — بتخلص بدري.",
  BUDGET_MISCONFIGURED: "الميزانية متظبطة غلط.",
  SEARCH_VOLUME_LIMITED: "مفيش بحث كفاية على الكلمات دي.",
  AD_GROUPS_PAUSED: "كل المجموعات الإعلانية موقوفة.",
  NO_AD_GROUPS: "مفيش مجموعات إعلانية في الحملة.",
  KEYWORDS_PAUSED: "كل الكلمات المفتاحية موقوفة.",
  NO_KEYWORDS: "مفيش كلمات مفتاحية.",
  AD_GROUP_ADS_PAUSED: "كل الإعلانات موقوفة.",
  NO_AD_GROUP_ADS: "مفيش إعلانات في المجموعة.",
  HAS_ADS_LIMITED_BY_POLICY: "فيه إعلانات محدودة بسبب سياسة جوجل.",
  HAS_ADS_DISAPPROVED: "فيه إعلانات مرفوضة من مراجعة جوجل.",
  MOST_ADS_UNDER_REVIEW: "أغلب الإعلانات لسه تحت المراجعة.",
  MISSING_LEAD_FORM_EXTENSION: "ناقص إضافة نموذج العملاء المحتملين.",
  MISSING_CALL_EXTENSION: "ناقصة إضافة الاتصال.",
  AD_GROUP_REMOVED: "المجموعة الإعلانية محذوفة.",
  AD_GROUP_PAUSED: "المجموعة الإعلانية موقوفة.",
  APP_NOT_RELEASED: "التطبيق مش منشور.",
  APP_PARTIALLY_RELEASED: "التطبيق منشور جزئيًا.",
  HAS_ASSET_GROUPS_DISAPPROVED: "فيه مجموعات أصول مرفوضة.",
  HAS_ASSET_GROUPS_LIMITED_BY_POLICY: "فيه مجموعات أصول محدودة بسياسة.",
  MOST_ASSET_GROUPS_UNDER_REVIEW: "أغلب مجموعات الأصول تحت المراجعة.",
  NO_ASSET_GROUPS: "مفيش مجموعات أصول.",
  ASSET_GROUPS_PAUSED: "مجموعات الأصول موقوفة.",
};
const reasonAr = (r) => REASON_AR[r] || r;

const PRIMARY_STATUS_AR = {
  ELIGIBLE: "مؤهّلة وبتظهر",
  PAUSED: "موقوفة",
  REMOVED: "محذوفة",
  ENDED: "منتهية",
  PENDING: "لسه ما بدأتش",
  MISCONFIGURED: "فيها إعداد ناقص أو غلط",
  LIMITED: "بتظهر بشكل محدود",
  LEARNING: "في مرحلة التعلّم",
  NOT_ELIGIBLE: "مش مؤهّلة للظهور",
  UNKNOWN: "غير معروف",
};

/* ═══════════════════════════════════════════════════════════════════════
   FACTORY
   `helpers` comes from ads.js: { httpJson, hashEmail, hashPhonePlus,
   googleDateTime }. Nothing here re-implements them.
   ═══════════════════════════════════════════════════════════════════════ */
export function createGoogleAdapter({ httpJson, hashEmail, hashPhonePlus, googleDateTime }) {
  return {
    id: "google",
    label: "Google Ads",

    /* Six values to send conversions, five to read and manage campaigns. The
       conversion action id is the deliberate switch: without it we know which
       account to talk to but not which conversion to file the sale against,
       so nothing is uploaded. */
    conversionEnv: [
      "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_CONVERSION_ACTION_ID",
    ],
    manageEnv: [
      "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID",
    ],
    eventName: "Purchase",
    note: "المطعم مفيهوش دفع أونلاين، فالشراء عمره ما بيحصل على الويب. اللي بيترفع لجوجل هو الطلبات اللي معاها معرّف حقيقي: gclid من ضغطة إعلان على المتجر، أو رقم جوال/إيميل مشفّر (Enhanced Conversions for Leads). الطلب اللي مامعهوش أي معرّف مابيتبعتش أصلاً.",

    ver: () => env("GOOGLE_ADS_API_VERSION") || "v21",
    apiBase() { return `https://googleads.googleapis.com/${this.ver()}`; },
    cust: () => digitsOnly(env("GOOGLE_ADS_CUSTOMER_ID")),
    loginCust: () => digitsOnly(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),

    /* Every request carries the developer token; `redact()` in ads.js scrubs
       it on the way out because SECRET_KEY matches developer-token. */
    hdr() {
      const login = this.loginCust();
      return {
        "Content-Type": "application/json",
        "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN"),
        ...(login ? { "login-customer-id": login } : {}),
        Authorization: "Bearer ***resolved-at-send***",
      };
    },

    /* ─── OAuth2: refresh token → access token, cached ────────────────────
       Google's access tokens live 3600s. 25 minutes of cache is the same
       margin the Snapchat adapter uses; keeping them identical means one
       rule to remember, not two. */
    _tok: null,
    _tokAt: 0,
    async token() {
      const id = env("GOOGLE_ADS_CLIENT_ID");
      const secret = env("GOOGLE_ADS_CLIENT_SECRET");
      const refresh = env("GOOGLE_ADS_REFRESH_TOKEN");
      if (!id || !secret || !refresh) return null;
      if (this._tok && Date.now() - this._tokAt < 25 * 60 * 1000) return this._tok;
      const res = await httpJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token",
        }).toString(),
      });
      if (!res.ok || !res.json?.access_token) {
        this._tokErr = res.json?.error_description || res.json?.error || res.error || `HTTP ${res.status}`;
        return null;
      }
      this._tokErr = null;
      this._tok = res.json.access_token;
      this._tokAt = Date.now();
      return this._tok;
    },

    /* authorize() is the send-time hook. Two jobs here:
         1. stamp the bearer token
         2. resolve `_resolveBudgetFor` — the campaign whose budget resource we
            could not know when the descriptor was built
       On failure it returns { error } instead of null so the caller can repeat
       Google's own words instead of guessing "token exchange failed". */
    async authorize(call) {
      const t = await this.token();
      if (!t) return { error: `Google OAuth refused: ${this._tokErr || "missing client id / secret / refresh token"}` };
      const out = { ...call, headers: { ...call.headers, Authorization: `Bearer ${t}` } };
      delete out._resolveBudgetFor;
      delete out._targetMicros;

      if (call._resolveBudgetFor) {
        const b = await this.budgetOf(call._resolveBudgetFor);
        if (!b.ok) return { error: b.reason };
        // A shared budget belongs to more campaigns than the one we were asked
        // about. Moving it would change spend nobody approved.
        if (b.explicitlyShared) {
          return { error: `ميزانية الحملة ${call._resolveBudgetFor} مشتركة (campaign_budget.explicitly_shared) — تغييرها بيحرّك صرف حملات تانية، فاترفض. غيّرها من واجهة جوجل أو اعمل للحملة ميزانية خاصة بيها.` };
        }
        out.body = {
          operations: [{
            update: { resourceName: b.resourceName, amountMicros: call._targetMicros },
            updateMask: "amount_micros",
          }],
        };
      }
      return out;
    },

    /* ─── GAQL ────────────────────────────────────────────────────────────
       searchStream answers with a JSON array of chunks. One helper flattens
       them and never throws; every reader below goes through it. */
    async search(query, { customerId = null } = {}) {
      const t = await this.token();
      if (!t) return { ok: false, reason: `Google OAuth refused: ${this._tokErr || "missing client id / secret / refresh token"}`, results: [] };
      const cid = customerId || this.cust();
      if (!cid) return { ok: false, reason: "GOOGLE_ADS_CUSTOMER_ID missing", results: [] };
      const res = await httpJson(`${this.apiBase()}/customers/${cid}/googleAds:searchStream`, {
        method: "POST",
        headers: { ...this.hdr(), Authorization: `Bearer ${t}` },
        body: { query },
      });
      const err = googleError(res);
      if (err) return { ok: false, reason: err, results: [] };
      const chunks = Array.isArray(res.json) ? res.json : res.json ? [res.json] : [];
      return { ok: true, results: chunks.flatMap((ch) => ch?.results || []) };
    },

    /* ─── READ: accounts ─────────────────────────────────────────────────
       customer_client lists everything under the login customer; on a plain
       (non-manager) account it returns the account itself, which is exactly
       what we want. If the account is not permitted to run that query we fall
       back to `customer`, which always works for the id in the path. */
    async accounts() {
      const miss = this.missing("manageEnv");
      if (miss) return { ok: false, reason: miss, accounts: [] };
      const map = (c, self) => ({
        platform: "google",
        id: String(c.id),
        accountId: String(c.id),
        name: c.descriptiveName || null,
        currency: c.currencyCode || null,
        timeZone: c.timeZone || null,
        manager: !!c.manager,
        testAccount: !!c.testAccount,
        status: c.status || (self ? "ENABLED" : null),
      });
      const r = await this.search(
        `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code,
                customer_client.time_zone, customer_client.manager, customer_client.test_account,
                customer_client.status, customer_client.level
           FROM customer_client WHERE customer_client.status != 'CLOSED'`);
      if (r.ok && r.results.length) {
        return { ok: true, accounts: r.results.map((x) => map(x.customerClient || {}, false)) };
      }
      const self = await this.search(
        `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone,
                customer.manager, customer.test_account, customer.status
           FROM customer LIMIT 1`);
      if (!self.ok) return { ok: false, reason: self.reason || r.reason, accounts: [] };
      return { ok: true, accounts: self.results.map((x) => map(x.customer || {}, true)) };
    },

    /* ─── READ: campaigns (+ budget, + why it is or is not serving) ─────── */
    async campaigns() {
      const miss = this.missing("manageEnv");
      if (miss) return { ok: false, reason: miss, campaigns: [] };
      const r = await this.search(
        `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
                campaign.primary_status_reasons, campaign.advertising_channel_type,
                campaign.bidding_strategy_type, campaign.start_date, campaign.end_date,
                campaign_budget.id, campaign_budget.resource_name, campaign_budget.amount_micros,
                campaign_budget.total_amount_micros, campaign_budget.explicitly_shared,
                campaign_budget.delivery_method
           FROM campaign WHERE campaign.status != 'REMOVED'
          ORDER BY campaign.id`);
      if (!r.ok) return { ok: false, reason: r.reason, campaigns: [] };
      return {
        ok: true,
        campaigns: r.results.map((x) => {
          const c = x.campaign || {}, b = x.campaignBudget || {};
          return {
            platform: "google",
            id: String(c.id),
            name: c.name || "",
            // ENABLED|PAUSED → the ACTIVE|PAUSED the rest of the system speaks.
            status: c.status === "ENABLED" ? "ACTIVE" : "PAUSED",
            rawStatus: c.status || null,
            // primaryStatus is Google's own "is it actually serving" verdict —
            // far more useful than status, which only says what we set.
            effectiveStatus: c.primaryStatus || null,
            effectiveStatusAr: PRIMARY_STATUS_AR[c.primaryStatus] || c.primaryStatus || null,
            statusReasons: (c.primaryStatusReasons || []).map((x2) => ({ code: x2, ar: reasonAr(x2) })),
            objective: c.advertisingChannelType || null,
            biddingStrategy: c.biddingStrategyType || null,
            dailyBudget: fromMicros(b.amountMicros),
            lifetimeBudget: fromMicros(b.totalAmountMicros),
            budgetResource: b.resourceName || null,
            budgetShared: !!b.explicitlyShared,
            budgetDelivery: b.deliveryMethod || null,
            startTime: c.startDate || null,
            stopTime: c.endDate || null,
          };
        }),
      };
    },

    /* ─── READ: ad groups ────────────────────────────────────────────────
       Google is the only one of the four where the level below the campaign
       carries its own bid, so the autopilot's "what can I actually turn?"
       question needs it. Not used by the shared routes; read by diagnose and
       available to anything that asks. */
    async adGroups() {
      const miss = this.missing("manageEnv");
      if (miss) return { ok: false, reason: miss, adGroups: [] };
      const r = await this.search(
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
                ad_group.cpc_bid_micros, campaign.id, campaign.name
           FROM ad_group WHERE ad_group.status != 'REMOVED' ORDER BY ad_group.id`);
      if (!r.ok) return { ok: false, reason: r.reason, adGroups: [] };
      return {
        ok: true,
        adGroups: r.results.map((x) => ({
          platform: "google",
          id: String(x.adGroup?.id),
          name: x.adGroup?.name || "",
          status: x.adGroup?.status === "ENABLED" ? "ACTIVE" : "PAUSED",
          type: x.adGroup?.type || null,
          cpcBid: fromMicros(x.adGroup?.cpcBidMicros),
          campaignId: String(x.campaign?.id ?? ""),
          campaignName: x.campaign?.name || "",
        })),
      };
    },

    /* ─── READ: insights ─────────────────────────────────────────────────
       Same row shape every other adapter returns, so the scorecard, the
       autopilot snapshot and attribution.js all read it without knowing it
       is Google. Extra fields (ctr, cpc) ride along for the diagnose view. */
    async insights({ from, to }) {
      const miss = this.missing("manageEnv");
      if (miss) return { ok: false, reason: miss, rows: [] };
      const r = await this.search(
        `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks,
                metrics.cost_micros, metrics.conversions, metrics.conversions_value,
                metrics.ctr, metrics.average_cpc
           FROM campaign
          WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'
            AND campaign.status != 'REMOVED'`);
      if (!r.ok) return { ok: false, reason: r.reason, rows: [] };
      /* GAQL returns one row per (campaign × segment). We asked for no
         segments beyond the date filter, so Google already rolls the range up
         into a single row per campaign — but sum defensively anyway, because
         adding a segment to this query later must not silently double-count. */
      const by = new Map();
      for (const x of r.results) {
        const id = String(x.campaign?.id ?? "");
        const m = x.metrics || {};
        const cur = by.get(id) || {
          platform: "google", campaignId: id, campaignName: x.campaign?.name || "",
          spend: 0, impressions: 0, clicks: 0, results: 0, resultValue: 0,
        };
        cur.spend += num(m.costMicros) / 1e6;
        cur.impressions += num(m.impressions);
        cur.clicks += num(m.clicks);
        cur.results += num(m.conversions);
        cur.resultValue += num(m.conversionsValue);
        by.set(id, cur);
      }
      return {
        ok: true,
        rows: [...by.values()].map((x) => ({
          ...x,
          spend: Math.round(x.spend * 100) / 100,
          results: Math.round(x.results * 100) / 100,
          resultValue: Math.round(x.resultValue * 100) / 100,
          ctr: x.impressions > 0 ? Math.round((x.clicks / x.impressions) * 10000) / 100 : null,
          cpc: x.clicks > 0 ? Math.round((x.spend / x.clicks) * 100) / 100 : null,
        })),
      };
    },

    /* Which CampaignBudget does this campaign use, and is it shared? */
    async budgetOf(campaignId) {
      const r = await this.search(
        `SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros,
                campaign_budget.explicitly_shared, campaign_budget.reference_count
           FROM campaign WHERE campaign.id = ${digitsOnly(campaignId) || 0}`);
      if (!r.ok) return { ok: false, reason: r.reason };
      const b = r.results[0]?.campaignBudget;
      if (!b?.resourceName) return { ok: false, reason: `مالقيتش ميزانية للحملة ${campaignId} في الحساب ${this.cust()}.` };
      return {
        ok: true,
        resourceName: b.resourceName,
        amount: fromMicros(b.amountMicros),
        explicitlyShared: !!b.explicitlyShared,
        referenceCount: b.referenceCount != null ? Number(b.referenceCount) : null,
      };
    },

    /* ─── WRITE: pause / resume ───────────────────────────────────────────
       Guarded upstream by ADS_ALLOW_WRITE in ads.js — same gate, same
       dry-run descriptor, no Google exception. */
    stateCall(id, state) {
      const cust = this.cust();
      return {
        url: `${this.apiBase()}/customers/${cust}/campaigns:mutate`,
        method: "POST",
        headers: this.hdr(),
        body: {
          operations: [{
            update: {
              resourceName: `customers/${cust}/campaigns/${digitsOnly(id)}`,
              status: state === "ACTIVE" ? "ENABLED" : "PAUSED",
            },
            updateMask: "status",
          }],
        },
      };
    },

    /* ─── WRITE: daily budget ─────────────────────────────────────────────
       The resource we must PATCH is the CampaignBudget, not the campaign, and
       its id is not derivable from the campaign id. The placeholder below is
       what the dry-run shows; authorize() replaces the whole body once it has
       looked the budget up (and refuses if it turns out to be shared).
       `_resolveBudgetFor` sits OUTSIDE body/url/headers so safeRequest() —
       which only reads those three — never echoes it. */
    budgetCall(id, dailyBudget) {
      const cust = this.cust();
      const amountMicros = micros(dailyBudget);
      return {
        url: `${this.apiBase()}/customers/${cust}/campaignBudgets:mutate`,
        method: "POST",
        headers: this.hdr(),
        body: {
          operations: [{
            update: {
              resourceName: `customers/${cust}/campaignBudgets/‹resolved from campaign ${id} at send time›`,
              amountMicros,
            },
            updateMask: "amount_micros",
          }],
        },
        _resolveBudgetFor: String(id),
        _targetMicros: amountMicros,
      };
    },

    /* ─── SEND: offline conversions ──────────────────────────────────────
       usable() runs BEFORE the dedup claim in ads.js, so an order with no
       identity is never claimed and stays eligible for a later sync once the
       linking sweeps attach a phone to it. That is the whole no-op story:
       zero rows in, zero requests out, an honest `skipped` count — not an
       error, and not an invented conversion. */
    usable(e) {
      return !!(e.gclid || e.gbraid || e.wbraid || e.phoneDigits || e.email);
    },

    buildBatch(events) {
      const cust = this.cust();
      const action = digitsOnly(env("GOOGLE_ADS_CONVERSION_ACTION_ID"));
      if (!cust || !action) return null;
      const rows = events.filter((e) => this.usable(e));
      if (!rows.length) return null;
      return {
        url: `${this.apiBase()}/customers/${cust}:uploadClickConversions`,
        method: "POST",
        headers: this.hdr(),
        body: {
          conversions: rows.map((e) => {
            const ident = [];
            const em = hashEmail(e.email);
            const ph = hashPhonePlus(e.phoneDigits);   // Google wants the '+' hashed in
            if (em) ident.push({ hashedEmail: em });
            if (ph) ident.push({ hashedPhoneNumber: ph });
            return {
              conversionAction: `customers/${cust}/conversionActions/${action}`,
              conversionDateTime: googleDateTime(e.eventTime),
              conversionValue: e.value,
              currencyCode: e.currency,
              ...(e.orderId ? { orderId: String(e.orderId) } : {}),
              /* EXACTLY ONE click id, or none at all. Sending two is an
                 outright rejection, and inventing one is a lie. */
              ...(e.gclid ? { gclid: e.gclid }
                : e.gbraid ? { gbraid: e.gbraid }
                : e.wbraid ? { wbraid: e.wbraid } : {}),
              ...(ident.length ? { userIdentifiers: ident } : {}),
            };
          }),
          // Google grades each row on its own; one bad phone must not throw
          // away the other 499.
          partialFailure: true,
        },
      };
    },

    readBatchResult(res, n) {
      const err = googleError(res);
      if (!err && res.ok) {
        const j = Array.isArray(res.json) ? res.json[0] : res.json;
        const accepted = Array.isArray(j?.results) ? j.results.length : n;
        return { ok: true, accepted, raw: j ?? null };
      }
      return {
        ok: false,
        error: err || res.error || `HTTP ${res.status}`,
        raw: res.json ?? res.text ?? null,
      };
    },

    /* Uniform "what is still missing" sentence, so every read below refuses
       for the same reason in the same words. */
    missing(which) {
      const need = which === "conversionEnv" ? this.conversionEnv : this.manageEnv;
      const gone = need.filter((k) => !env(k));
      return gone.length ? `Google Ads مش مربوط — ناقص ${gone.join(", ")}` : null;
    },

    /* ═══════════════════════════════════════════════════════════════════
       DIAGNOSE — "ليه جوجل مش بيعرض؟" مجاوَب من الـ API

       Every section runs its own query and records its own failure, because
       one unsupported field must not take the whole answer down. The point of
       this endpoint is to replace a browser session, so it reports what it
       could NOT read just as loudly as what it could.
       ═══════════════════════════════════════════════════════════════════ */
    async diagnose({ days = 14 } = {}) {
      const miss = this.missing("manageEnv");
      if (miss) {
        return {
          ok: false,
          connected: false,
          reason: miss,
          findings: [{ level: "blocker", ar: miss }],
        };
      }
      const out = { ok: true, connected: true, customerId: this.cust(), days, errors: {} };
      const run = async (key, query) => {
        const r = await this.search(query);
        if (!r.ok) { out.errors[key] = r.reason; return []; }
        return r.results;
      };

      /* 1. the account itself */
      const acct = await run("account",
        `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone,
                customer.status, customer.manager, customer.test_account, customer.auto_tagging_enabled,
                customer.conversion_tracking_setting.conversion_tracking_id,
                customer.conversion_tracking_setting.conversion_tracking_status
           FROM customer LIMIT 1`);
      const cu = acct[0]?.customer || {};
      out.account = {
        id: cu.id ? String(cu.id) : this.cust(),
        name: cu.descriptiveName || null,
        currency: cu.currencyCode || null,
        timeZone: cu.timeZone || null,
        status: cu.status || null,
        manager: !!cu.manager,
        testAccount: !!cu.testAccount,
        // Without auto-tagging Google never stamps a gclid on the click, so
        // offline uploads can never match. It is one boolean and it matters.
        autoTagging: cu.autoTaggingEnabled === true,
        conversionTrackingId: cu.conversionTrackingSetting?.conversionTrackingId
          ? String(cu.conversionTrackingSetting.conversionTrackingId) : null,
        conversionTrackingStatus: cu.conversionTrackingSetting?.conversionTrackingStatus || null,
      };

      /* 2. campaigns, with Google's own verdict on why they are/aren't serving */
      const camps = await run("campaigns",
        `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
                campaign.primary_status_reasons, campaign.serving_status,
                campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
                campaign.bidding_strategy_type, campaign.start_date, campaign.end_date,
                campaign_budget.amount_micros, campaign_budget.explicitly_shared,
                campaign_budget.delivery_method
           FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id`);

      /* 3. what those campaigns actually did over the window */
      const to = new Date();
      const from = new Date(to.getTime() - (days - 1) * 86400000);
      const perf = await run("metrics",
        `SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc
           FROM campaign
          WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'
            AND campaign.status != 'REMOVED'`);
      const perfBy = new Map();
      for (const x of perf) {
        const id = String(x.campaign?.id ?? ""), m = x.metrics || {};
        const c = perfBy.get(id) || { impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0 };
        c.impressions += num(m.impressions); c.clicks += num(m.clicks);
        c.spend += num(m.costMicros) / 1e6; c.conversions += num(m.conversions);
        c.value += num(m.conversionsValue);
        perfBy.set(id, c);
      }

      /* 3b. impression share lost — the single clearest "budget or rank?"
         answer. Split off so an unsupported metric on a non-Search campaign
         cannot kill section 3. */
      const share = await run("impressionShare",
        `SELECT campaign.id, metrics.search_impression_share,
                metrics.search_budget_lost_impression_share,
                metrics.search_rank_lost_impression_share
           FROM campaign
          WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'
            AND campaign.status != 'REMOVED'`);
      const shareBy = new Map(share.map((x) => [String(x.campaign?.id ?? ""), x.metrics || {}]));

      out.campaigns = camps.map((x) => {
        const c = x.campaign || {}, b = x.campaignBudget || {};
        const id = String(c.id);
        const p = perfBy.get(id) || { impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0 };
        const s = shareBy.get(id) || {};
        return {
          id, name: c.name || "",
          status: c.status || null,
          statusAr: c.status === "ENABLED" ? "شغالة" : c.status === "PAUSED" ? "موقوفة" : c.status,
          primaryStatus: c.primaryStatus || null,
          primaryStatusAr: PRIMARY_STATUS_AR[c.primaryStatus] || c.primaryStatus || null,
          // THIS is the field the owner is looking for.
          reasons: (c.primaryStatusReasons || []).map((r) => ({ code: r, ar: reasonAr(r) })),
          servingStatus: c.servingStatus || null,
          channel: c.advertisingChannelType || null,
          channelSub: c.advertisingChannelSubType || null,
          biddingStrategy: c.biddingStrategyType || null,
          startDate: c.startDate || null,
          endDate: c.endDate || null,
          dailyBudget: fromMicros(b.amountMicros),
          budgetShared: !!b.explicitlyShared,
          budgetDelivery: b.deliveryMethod || null,
          impressions: p.impressions,
          clicks: p.clicks,
          spend: Math.round(p.spend * 100) / 100,
          conversions: Math.round(p.conversions * 100) / 100,
          conversionValue: Math.round(p.value * 100) / 100,
          lostImprShareBudget: s.searchBudgetLostImpressionShare != null
            ? Math.round(Number(s.searchBudgetLostImpressionShare) * 10000) / 100 : null,
          lostImprShareRank: s.searchRankLostImpressionShare != null
            ? Math.round(Number(s.searchRankLostImpressionShare) * 10000) / 100 : null,
        };
      });

      /* 4. ad groups + ads, with the policy verdict on each ad */
      const ads = await run("ads",
        `SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status,
                ad_group_ad.ad.id, ad_group_ad.status,
                ad_group_ad.policy_summary.approval_status,
                ad_group_ad.policy_summary.review_status,
                ad_group_ad.policy_summary.policy_topic_entries
           FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'`);
      out.ads = ads.map((x) => {
        const ps = x.adGroupAd?.policySummary || {};
        return {
          campaignId: String(x.campaign?.id ?? ""),
          adGroupId: String(x.adGroup?.id ?? ""),
          adGroupName: x.adGroup?.name || "",
          adGroupStatus: x.adGroup?.status || null,
          adId: String(x.adGroupAd?.ad?.id ?? ""),
          status: x.adGroupAd?.status || null,
          approvalStatus: ps.approvalStatus || null,
          reviewStatus: ps.reviewStatus || null,
          policyTopics: (ps.policyTopicEntries || []).map((t) => ({
            topic: t.topic || null, type: t.type || null,
          })),
        };
      });

      /* 5. keywords — a Search campaign with none of them cannot serve */
      const kws = await run("keywords",
        `SELECT campaign.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                ad_group_criterion.status, ad_group_criterion.approval_status,
                ad_group_criterion.system_serving_status
           FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED'`);
      out.keywords = kws.map((x) => ({
        campaignId: String(x.campaign?.id ?? ""),
        text: x.adGroupCriterion?.keyword?.text || "",
        status: x.adGroupCriterion?.status || null,
        approvalStatus: x.adGroupCriterion?.approvalStatus || null,
        servingStatus: x.adGroupCriterion?.systemServingStatus || null,
      }));

      /* 6. conversion actions and what they actually recorded */
      const actions = await run("conversionActions",
        `SELECT conversion_action.id, conversion_action.name, conversion_action.status,
                conversion_action.type, conversion_action.category,
                conversion_action.primary_for_goal, conversion_action.counting_type,
                conversion_action.include_in_conversions_metric
           FROM conversion_action WHERE conversion_action.status != 'REMOVED'`);
      const counts = await run("conversionCounts",
        `SELECT conversion_action.id, metrics.all_conversions
           FROM conversion_action
          WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'`);
      const countBy = new Map();
      for (const x of counts) {
        const id = String(x.conversionAction?.id ?? "");
        countBy.set(id, (countBy.get(id) || 0) + num(x.metrics?.allConversions));
      }
      const wantedAction = digitsOnly(env("GOOGLE_ADS_CONVERSION_ACTION_ID"));
      out.conversionActions = actions.map((x) => {
        const a = x.conversionAction || {};
        const id = String(a.id);
        return {
          id, name: a.name || "",
          status: a.status || null,
          type: a.type || null,
          category: a.category || null,
          primaryForGoal: a.primaryForGoal !== false,
          countingType: a.countingType || null,
          countedInConversions: a.includeInConversionsMetric !== false,
          conversionsInWindow: Math.round((countBy.get(id) || 0) * 100) / 100,
          // Can we upload till sales against this one?
          uploadable: a.type === "UPLOAD_CLICKS" || a.type === "UPLOAD_CALLS",
          isOurUploadTarget: !!wantedAction && id === wantedAction,
        };
      });

      /* ─── findings: the paragraph the owner actually reads ───────────── */
      const f = [];
      const add = (level, ar) => f.push({ level, ar });

      if (out.account.testAccount) add("blocker", "الحساب ده حساب تجريبي (test account) — الإعلانات فيه عمرها ما بتظهر لحد.");
      if (out.account.status && out.account.status !== "ENABLED") add("blocker", `حالة الحساب ${out.account.status} — مش ENABLED.`);
      if (!out.account.autoTagging) add("warn", "الوسم التلقائي (auto-tagging) مقفول. من غيره جوجل مبيحطّش gclid على الضغطة، ورفع الطلبات من الكاشير لجوجل مش هيلاقي حاجة يطابقها.");

      if (!out.campaigns.length && !out.errors.campaigns) add("blocker", "مفيش أي حملة في الحساب (غير المحذوفة).");
      const enabled = out.campaigns.filter((c) => c.status === "ENABLED");
      if (out.campaigns.length && !enabled.length) add("blocker", "كل الحملات موقوفة — مفيش حملة واحدة شغالة.");

      for (const c of enabled) {
        for (const r of c.reasons) add(r.code === "BUDGET_CONSTRAINED" ? "warn" : "blocker", `«${c.name}»: ${r.ar}`);
        if (c.primaryStatus && !["ELIGIBLE", "LEARNING", "LIMITED"].includes(c.primaryStatus) && !c.reasons.length) {
          add("blocker", `«${c.name}»: جوجل بيقول حالتها ${c.primaryStatusAr} من غير سبب مفصّل.`);
        }
        if (!c.dailyBudget) add("blocker", `«${c.name}»: مفيش ميزانية يومية متقروءة على الحملة.`);
        if (c.impressions === 0) {
          add("blocker", `«${c.name}»: صفر انطباع خلال آخر ${days} يوم — يعني الإعلان مش بيتعرض أصلاً، مش إنه بيتعرض وما حدش بيضغط.`);
        }
        if (c.lostImprShareBudget != null && c.lostImprShareBudget > 20) {
          add("warn", `«${c.name}»: ضايع منها ${c.lostImprShareBudget}% من الظهور بسبب الميزانية.`);
        }
        if (c.lostImprShareRank != null && c.lostImprShareRank > 50) {
          add("warn", `«${c.name}»: ضايع منها ${c.lostImprShareRank}% من الظهور بسبب ترتيب الإعلان (العرض/الجودة) مش الميزانية.`);
        }
        const mine = out.ads.filter((a) => a.campaignId === c.id);
        if (!mine.length && !out.errors.ads) add("blocker", `«${c.name}»: مفيش إعلانات جوّه الحملة.`);
        const disapproved = mine.filter((a) => a.approvalStatus === "DISAPPROVED");
        if (disapproved.length) add("blocker", `«${c.name}»: ${disapproved.length} إعلان مرفوض من مراجعة جوجل.`);
        const underReview = mine.filter((a) => a.reviewStatus === "UNDER_REVIEW" || a.reviewStatus === "REVIEW_IN_PROGRESS");
        if (underReview.length && !c.impressions) add("warn", `«${c.name}»: ${underReview.length} إعلان لسه تحت المراجعة — ده بياخد لحد يوم شغل.`);
        const kw = out.keywords.filter((k) => k.campaignId === c.id);
        if (c.channel === "SEARCH" && !kw.length && !out.errors.keywords) add("blocker", `«${c.name}»: حملة بحث من غير كلمات مفتاحية.`);
      }

      const conv = out.conversionActions;
      if (conv.length && !conv.some((a) => a.conversionsInWindow > 0)) {
        add("warn", `مفيش أي تحويل مسجّل على أي إجراء تحويل خلال آخر ${days} يوم.`);
      }
      if (wantedAction && !conv.some((a) => a.isOurUploadTarget)) {
        add("blocker", `GOOGLE_ADS_CONVERSION_ACTION_ID=${wantedAction} مش موجود في الحساب — الرفع هيترفض.`);
      }
      const target = conv.find((a) => a.isOurUploadTarget);
      if (target && !target.uploadable) {
        add("warn", `إجراء التحويل «${target.name}» نوعه ${target.type} — الرفع من السيرفر (UploadClickConversions) بيحتاج إجراء نوعه UPLOAD_CLICKS، أو تفعيل Enhanced Conversions for Leads عليه.`);
      }
      if (!wantedAction) {
        add("info", "GOOGLE_ADS_CONVERSION_ACTION_ID مش متحطّط — القراءة والتحكم شغالين، لكن مفيش رفع للطلبات من الكاشير لجوجل.");
      }
      for (const [k, v] of Object.entries(out.errors)) add("warn", `مقدرتش أقرا «${k}» من جوجل: ${v}`);
      if (!f.length) add("info", "مفيش أي مانع ظاهر — الحساب والحملات مؤهّلين وبيصرفوا.");

      out.findings = f;
      out.verdict = f.some((x) => x.level === "blocker")
        ? f.filter((x) => x.level === "blocker")[0].ar
        : f.some((x) => x.level === "warn") ? f.filter((x) => x.level === "warn")[0].ar
          : "مفيش مانع ظاهر.";
      return out;
    },
  };
}

/* GAQL takes a bare YYYY-MM-DD. Accept an ISO string or a Date either way. */
function isoDate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d || "").slice(0, 10);
}

export { googleError, REASON_AR, PRIMARY_STATUS_AR };
