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

/* ═══════════════════════════════════════════════════════════════════════════
   API VERSION — ONE constant, overridable by env, and nothing else.

   Google sunsets a major version about a year after it ships, and since
   January 2026 it ships a major roughly every quarter. v21 died on
   2026-08-05: every GAQL call started answering
     INVALID_ARGUMENT (UNSUPPORTED_VERSION): Version v21 is deprecated.
   while OAuth and the developer token kept working perfectly — so the account
   read fine and every query failed, which is the most confusing possible
   failure mode.

   The version now lives HERE and only here (mirroring META_API_VERSION in
   ads.js). The next bump is `GOOGLE_ADS_API_VERSION=v26` in Coolify — a config
   change that needs no deploy — and this default is the floor, not the truth.
   googleError() below also recognises the sunset error by name and says what
   to do about it, so the next time it happens the message is the fix.
   ═══════════════════════════════════════════════════════════════════════════ */
const DEFAULT_API_VERSION = "v25";        // released 2026-07-22, supported to ~2026-07

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

/* A sunset version is not a query bug and must not read like one. Google says
   "Version v21 is deprecated" and stops there; the owner needs the next step,
   which is one env var. Wrapping it here means every reader — diagnose, the
   scorecard, the autopilot — repeats the same instruction. */
function withVersionHint(reason, version) {
  if (!reason) return reason;
  if (!/UNSUPPORTED_VERSION|is deprecated|Version v\d+/i.test(reason)) return reason;
  return `${reason} — نسخة Google Ads API «${version}» انتهت صلاحيتها. غيّر GOOGLE_ADS_API_VERSION في إعدادات التطبيق لأحدث نسخة (${DEFAULT_API_VERSION} أو أعلى) من غير ما تعدّل كود.`;
}

/* ─── refusals that will never come good on a retry ───────────────────────
   Google closed ConversionUploadService to new integrations: an account that
   was not already uploading gets

     CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE — "New integrations for
     uploading click conversions should use the Data Manager API."

   however correct the payload, however right the conversion action's type.
   That is a shut door, not a bad row, and retrying it is precisely how 61
   identical failures a day happen. We latch it, refuse to send, and say so
   once — while leaving a long expiry so the day the account IS allowlisted
   (or the Data Manager integration lands) it costs one batch to find out. */
const PERMANENT_REFUSAL = /CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE|DEVELOPER_TOKEN_NOT_APPROVED|CUSTOMER_NOT_ENABLED|NOT_ADS_USER|OPERATION_ACCESS_DENIED/i;
const REFUSAL_TTL_MS = 12 * 60 * 60 * 1000;

/* ─── policy text ─────────────────────────────────────────────────────────
   PolicyTopicEntry is where Google writes, in its own words, WHY a keyword or
   an ad is blocked — and it is nested three levels deep in
   evidences[].textList.texts[]. Flattening it is the difference between
   "Disapproved" and "Disapproved: Sensitive events — «فريش كاتس»".
   Everything is passed through verbatim; nothing is paraphrased, because the
   whole value of this field is that it is Google's sentence and not ours. */
const POLICY_TYPE_AR = {
  PROHIBITED: "ممنوع تمامًا — الإعلان/الكلمة مش هتشتغل",
  LIMITED: "مسموح بحدود — بيظهر في أماكن أقل",
  FULLY_LIMITED: "محظور في كل الدول المستهدفة",
  DESCRIPTIVE: "وصف فقط — مش مانع",
  BROADENING: "بيوسّع الوصول",
  AREA_OF_INTEREST_ONLY: "بيظهر بس لناس مهتمّة بالمنطقة",
  UNKNOWN: "غير معروف",
};

function policyEvidenceTexts(ev = {}) {
  const out = [];
  const push = (v) => { if (v != null && v !== "") out.push(String(v)); };
  for (const t of ev.textList?.texts || []) push(t);
  for (const t of ev.destinationTextList?.destinationTexts || []) push(t);
  for (const w of ev.websiteList?.websites || []) push(w);
  if (ev.languageCode) push(`language=${ev.languageCode}`);
  if (ev.destinationNotWorking?.expandedUrl) push(ev.destinationNotWorking.expandedUrl);
  if (ev.destinationMismatch?.urlTypes?.length) push(`url mismatch: ${ev.destinationMismatch.urlTypes.join(", ")}`);
  return out;
}

function policyEntries(list) {
  return (list || []).map((t) => ({
    topic: t.topic || null,                       // Google's own topic name, verbatim
    type: t.type || null,
    typeAr: POLICY_TYPE_AR[t.type] || t.type || null,
    // The exact strings Google objected to — usually the keyword itself.
    evidence: (t.evidences || []).flatMap(policyEvidenceTexts),
    // Country-level restrictions, when the topic is limited rather than banned.
    constraints: (t.constraints || []).map((c) => ({
      countriesTargeted: c.countryConstraintList?.totalTargetedCountries ?? null,
      countriesBlocked: (c.countryConstraintList?.countries || []).length || null,
      resellerConstraint: !!c.resellerConstraint,
    })).filter((c) => c.countriesTargeted != null || c.countriesBlocked != null || c.resellerConstraint),
  }));
}

// One human line per blocked entry: «topic» (type) — evidence, evidence…
const policyLine = (e) =>
  `«${e.topic || "?"}» ${e.typeAr || e.type || ""}${e.evidence.length ? ` — ${e.evidence.join(" / ")}` : ""}`.trim();

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

/* Reasons that describe a normal phase or a soft limit rather than something
   broken. They are worth saying, but they must not outrank a real blocker in
   `verdict` — which is simply the first blocker in the list. */
const SOFT_REASONS = new Set([
  "BUDGET_CONSTRAINED", "BIDDING_STRATEGY_LEARNING", "BIDDING_STRATEGY_LIMITED",
  "BIDDING_STRATEGY_CONSTRAINED", "SEARCH_VOLUME_LIMITED", "MOST_ADS_UNDER_REVIEW",
  "MOST_ASSET_GROUPS_UNDER_REVIEW",
]);

/* system_serving_status on a keyword: ELIGIBLE is the healthy value. These are
   the ones that mean "enabled, approved, and still not entering auctions". */
const SLOW_KEYWORD = new Set([
  "RARELY_SERVED", "LOW_SEARCH_VOLUME", "LOW_QUALITY_SCORE",
  "BELOW_FIRST_PAGE_BID", "BELOW_TOP_OF_PAGE_BID", "PAUSED", "REMOVED",
]);

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
    note: "المطعم مفيهوش دفع أونلاين، فالشراء عمره ما بيحصل على الويب. اللي بيترفع لجوجل هو الطلبات اللي معاها معرّف حقيقي: gclid من ضغطة إعلان على المتجر، أو رقم جوال/إيميل مشفّر. الطلب اللي مامعهوش أي معرّف مابيتبعتش أصلاً. ⚠️ جوجل قفلت ConversionUploadService على التكاملات الجديدة (لازم Data Manager API)، فالرفع نفسه متوقّف حاليًا. القراءة والتحكم في الحملات بيمشوا على توكن OAuth منفصل تمامًا، فلو السطر اللي فوق بيقول إن التوكن مرفوض يبقى دول واقفين هما كمان — مش بس الرفع.",

    ver: () => env("GOOGLE_ADS_API_VERSION") || DEFAULT_API_VERSION,
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
      if (err) return { ok: false, reason: withVersionHint(err, this.ver()), results: [] };
      const chunks = Array.isArray(res.json) ? res.json : res.json ? [res.json] : [];
      return { ok: true, results: chunks.flatMap((ch) => ch?.results || []) };
    },

    /* Same query, minus the columns a newer/older version may not know.
       `search()` is all-or-nothing by design — one bad column loses the row set
       — so a reader that has optional columns asks for them first and falls
       back to the mandatory ones rather than returning nothing at all. This is
       the other half of "a version bump must not be a code change". */
    async searchWithFallback(fullQuery, leanQuery) {
      const r = await this.search(fullQuery);
      if (r.ok || !/UNRECOGNIZED_FIELD|unrecognized field|not found in resource|FIELD_DOES_NOT_EXIST|invalid field|Error in.*SELECT/i.test(r.reason || "")) return r;
      const lean = await this.search(leanQuery);
      if (lean.ok) return { ...lean, degraded: r.reason };
      return r;
    },

    /* ─── GoogleAdsFieldService — ask Google what the columns are CALLED ──
       The v21→v25 jump renamed campaign.start_date to start_date_time and
       moved the keyword policy summary. Guessing that from a blog post is how
       the next bump goes wrong too, so the account can be asked directly:
       googleAdsFields:search is version-scoped, not customer-scoped, and it
       answers with the exact selectable field list for whatever version this
       adapter is pinned to. Read-only, and the answer IS the migration note. */
    async fields(prefix) {
      const t = await this.token();
      if (!t) return { ok: false, reason: `Google OAuth refused: ${this._tokErr || "missing credentials"}`, fields: [] };
      const safe = String(prefix || "").replace(/[^a-z0-9_.]/gi, "");
      if (!safe) return { ok: false, reason: "prefix is required, e.g. 'ad_group_criterion'", fields: [] };
      const res = await httpJson(`${this.apiBase()}/googleAdsFields:search`, {
        method: "POST",
        headers: { ...this.hdr(), Authorization: `Bearer ${t}` },
        body: {
          /* No FROM clause: GoogleAdsFieldService rejects one outright
             (UNEXPECTED_FROM_CLAUSE). It is the one query in the whole API
             that names no resource, because the fields ARE the resource. */
          query: `SELECT name, category, selectable, filterable, sortable, data_type, is_repeated
                   WHERE name LIKE '${safe}%' ORDER BY name`,
          pageSize: 1000,
        },
      });
      const err = googleError(res);
      if (err) return { ok: false, reason: withVersionHint(err, this.ver()), fields: [] };
      return {
        ok: true,
        version: this.ver(),
        fields: (res.json?.results || []).map((f) => ({
          name: f.name, category: f.category || null, dataType: f.dataType || null,
          selectable: f.selectable === true, repeated: f.isRepeated === true,
        })),
      };
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
      const CAMP = (dates) =>
        `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
                campaign.primary_status_reasons, campaign.advertising_channel_type,
                campaign.bidding_strategy_type, ${dates},
                campaign_budget.id, campaign_budget.resource_name, campaign_budget.amount_micros,
                campaign_budget.total_amount_micros, campaign_budget.explicitly_shared,
                campaign_budget.delivery_method
           FROM campaign WHERE campaign.status != 'REMOVED'
          ORDER BY campaign.id`;
      /* v24 renamed campaign.start_date → campaign.start_date_time (same for
         end_date). Ask for the current names, fall back to the old ones so a
         pinned older GOOGLE_ADS_API_VERSION still reads. */
      const r = await this.searchWithFallback(
        CAMP("campaign.start_date_time, campaign.end_date_time"),
        CAMP("campaign.start_date, campaign.end_date"));
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
            startTime: c.startDateTime || c.startDate || null,
            stopTime: c.endDateTime || c.endDate || null,
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

    /* Daily spend. `segments.date` moves from the WHERE clause into the SELECT
       list — that is the whole difference. GAQL then returns one row per
       (campaign × day) instead of rolling the range into one row per campaign.
       The day is in the Google Ads CUSTOMER's time zone (readable via
       `customer.time_zone`, surfaced by diagnose()), not UTC. */
    async dailySpend({ from, to }) {
      const miss = this.missing("manageEnv");
      if (miss) return { ok: false, reason: miss, rows: [] };
      const r = await this.search(
        `SELECT campaign.id, campaign.name, segments.date,
                metrics.impressions, metrics.clicks, metrics.cost_micros
           FROM campaign
          WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'
            AND campaign.status != 'REMOVED'`);
      if (!r.ok) return { ok: false, reason: r.reason, rows: [] };
      return {
        ok: true,
        rows: r.results.map((x) => ({
          platform: "google",
          day: String(x.segments?.date || "").slice(0, 10),
          campaignId: String(x.campaign?.id ?? ""),
          campaignName: x.campaign?.name || "",
          spend: Math.round((num(x.metrics?.costMicros) / 1e6) * 100) / 100,
          impressions: num(x.metrics?.impressions),
          clicks: num(x.metrics?.clicks),
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
        this._refusal = null;               // it worked; forget any old latch
        return { ok: true, accepted, raw: j ?? null };
      }
      const message = err || res.error || `HTTP ${res.status}`;
      // `permanent` tells ads.js to file these rows as skipped, not failed:
      // they were never judged on their merits, the service refused wholesale.
      const permanent = this.noteRefusal(message);
      return {
        ok: false,
        permanent,
        reason: permanent ? this._refusal.reason : null,
        error: withVersionHint(message, this.ver()),
        raw: res.json ?? res.text ?? null,
      };
    },

    /* Recognise a refusal that a retry cannot fix, and remember it. Returns
       true when the caller should stop rather than try the next batch. */
    _refusal: null,
    noteRefusal(err) {
      if (!err || !PERMANENT_REFUSAL.test(err)) return false;
      const closed = /Data Manager API/i.test(err);
      this._refusal = {
        at: Date.now(),
        code: closed ? "SERVICE_CLOSED_TO_NEW_INTEGRATIONS" : "NOT_ALLOWLISTED",
        reason: closed
          ? `جوجل قفلت ConversionUploadService على أي تكامل جديد. ردّها بالنص: «CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE — New integrations for uploading click conversions should use the Data Manager API». يعني رفع طلبات الكاشير لجوجل بقى محتاج Data Manager API، وده تكامل تاني بالكامل مش نفس النداء ده. الرفع متوقّف عن قصد لحد ما يتعمل — مش بيحاول ويفشل كل ساعة. (القراءة والتشخيص والتحكم في الحملات شغّالين عادي.)`
          : `جوجل رفضت الرفع رفض دائم على مستوى الحساب: ${err}`,
        google: err,
      };
      /* Publish it as the readiness verdict straight away rather than waiting
         for the cache to lapse. Otherwise the ten minutes after a refusal
         still cost one rejected batch per sync — the exact drip this whole
         change exists to stop — and /api/ads/status would keep saying READY
         while every upload was being turned away. */
      this._ready = { ok: false, code: this._refusal.code, reason: this._refusal.reason, googleSaid: err, checkedAt: new Date().toISOString() };
      this._readyAt = Date.now();
      return true;
    },

    /* Uniform "what is still missing" sentence, so every read below refuses
       for the same reason in the same words. */
    missing(which) {
      const need = which === "conversionEnv" ? this.conversionEnv : this.manageEnv;
      const gone = need.filter((k) => !env(k));
      return gone.length ? `Google Ads مش مربوط — ناقص ${gone.join(", ")}` : null;
    },

    /* ═══════════════════════════════════════════════════════════════════
       UPLOAD READINESS — the pre-flight that turns 61 identical errors a
       day into one sentence.

       UploadClickConversions only accepts a conversion action whose TYPE is
       UPLOAD_CLICKS (or UPLOAD_CALLS for calls). Point it at a WEBPAGE action
       and every single row is rejected with INVALID_CONVERSION_ACTION_TYPE —
       per row, per batch, per hour, forever, because ads.js retries `failed`
       rows on the next sync. Sixty-one error rows a day, all saying the same
       thing, none of them actionable from the dashboard.

       So we ask the account ONCE (cached) whether the configured action can
       actually receive an upload, and if it cannot we refuse to claim or send
       anything and hand back one reason. Nothing is marked failed, so the
       orders stay eligible: the day a valid action exists they upload with
       their real timestamps instead of having been burned as failures.
       ═══════════════════════════════════════════════════════════════════ */
    _ready: null,
    _readyAt: 0,
    // Synchronous peek for /api/ads/status — never makes a network call, so
    // the dashboard tile stays fast and simply says nothing until a sync ran.
    lastReadiness() { return this._ready; },

    async readiness({ force = false, ttlMs = 10 * 60 * 1000 } = {}) {
      if (!force && this._ready && Date.now() - this._readyAt < ttlMs) return this._ready;
      const settle = (v) => { this._ready = { ...v, checkedAt: new Date().toISOString() }; this._readyAt = Date.now(); return this._ready; };

      const miss = this.missing("conversionEnv");
      if (miss) return settle({ ok: false, code: "NOT_CONFIGURED", reason: miss });

      /* A door Google shut outranks anything a query can tell us: the
         conversion action can be perfect and the upload still refused. */
      if (this._refusal && Date.now() - this._refusal.at < REFUSAL_TTL_MS) {
        return settle({ ok: false, code: this._refusal.code, reason: this._refusal.reason, googleSaid: this._refusal.google });
      }

      const wanted = digitsOnly(env("GOOGLE_ADS_CONVERSION_ACTION_ID"));
      const r = await this.search(
        `SELECT conversion_action.id, conversion_action.name, conversion_action.type,
                conversion_action.status, conversion_action.category
           FROM conversion_action WHERE conversion_action.id = ${wanted || 0}`);
      /* Could not ask (token, version, network). One blip is NOT
         "misconfigured" — refusing to send on a transient read failure would
         silently stop a working upload, so the first few let the send proceed
         and report the doubt.

         But doubt cached for ten minutes is how a PERMANENT read failure — a
         sunset API version, a dead token, exactly the scenario this adapter
         was rewritten for — turns into a stream of `failed` rows: every cycle
         claims orders on the strength of an `ok:true` that only ever meant
         "we could not check". So the benefit of the doubt is counted, and it
         runs out. After three consecutive unverified checks we stop claiming
         and say plainly that we cannot see the conversion action; and the
         doubt is cached for one minute, not ten, so recovery is quick. */
      if (!r.ok) {
        this._unverified = (this._unverified || 0) + 1;
        if (this._unverified >= 3) {
          return settle({
            ok: false, code: "UNVERIFIABLE",
            reason: `مقدرناش نقرا إجراء التحويل من جوجل ${this._unverified} مرات ورا بعض (${r.reason}). ` +
                    `وقّفنا الرفع مؤقتًا بدل ما نبعت طلبات لباب مش عارفين هو مفتوح ولا لأ — الطلبات محفوظة وهترفع لما القراءة ترجع.`,
          });
        }
        const v = settle({ ok: true, code: "UNVERIFIED", reason: `مقدرتش أتأكد من إجراء التحويل: ${r.reason}` });
        this._readyAt = Date.now() - (10 * 60 * 1000) + 60 * 1000;   // doubt lives one minute, not ten
        return v;
      }
      this._unverified = 0;

      const a = r.results[0]?.conversionAction;
      if (!a) {
        return settle({
          ok: false, code: "ACTION_NOT_FOUND",
          reason: `إجراء التحويل رقم ${wanted} مش موجود في حساب Google Ads ${this.cust()} — الرفع متوقّف لحد ما يتظبط GOOGLE_ADS_CONVERSION_ACTION_ID.`,
        });
      }
      if (a.status && a.status !== "ENABLED") {
        return settle({
          ok: false, code: "ACTION_DISABLED",
          reason: `إجراء التحويل «${a.name}» حالته ${a.status} مش ENABLED — الرفع متوقّف.`,
        });
      }
      if (a.type !== "UPLOAD_CLICKS" && a.type !== "UPLOAD_CALLS") {
        return settle({
          ok: false, code: "WRONG_ACTION_TYPE",
          actionId: String(a.id), actionName: a.name || null, actionType: a.type || null,
          reason: `إجراء التحويل «${a.name}» نوعه ${a.type}، ورفع الطلبات من الكاشير (UploadClickConversions) بيقبل بس إجراء نوعه UPLOAD_CLICKS. الرفع متوقّف عن قصد لحد ما يتعمل إجراء «Import» جديد — الإجراء الحالي بيقيس ضغطات واتساب على الموقع وميصحّش نغيّر نوعه.`,
        });
      }
      return settle({ ok: true, code: "READY", actionId: String(a.id), actionName: a.name || null, actionType: a.type });
    },

    // ads.js calls this before claiming anything. Contract: { ok, reason }.
    async preflight() {
      const r = await this.readiness();
      return r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason };
    },

    /* ─── WRITE: create the UPLOAD_CLICKS conversion action ───────────────
       A descriptor, exactly like stateCall/budgetCall, so it goes through the
       SAME ADS_ALLOW_WRITE gate, the same dry-run preview and the same
       redaction. Two deliberate choices:
         • primaryForGoal:false — a new PRIMARY action joins Smart Bidding's
           optimisation target the moment it exists. Creating a measurement
           row must not quietly change what the campaign bids toward; the
           owner can promote it in the UI when they mean to.
         • MANY_PER_CLICK — every till order is its own sale, and orderId
           already dedups them.
       Nothing here touches a campaign, a budget or billing. */
    createUploadActionCall({ name = "Fresh Cuts - Till Orders (Import)", category = "PURCHASE", currency = "SAR", id = null } = {}) {
      const cust = this.cust();
      // Rename an existing action: the only field this route may touch, and
      // the only reason it exists is that a name can arrive mangled from a
      // shell. Type, status and category are never updated from here.
      if (id) {
        return {
          url: `${this.apiBase()}/customers/${cust}/conversionActions:mutate`,
          method: "POST",
          headers: this.hdr(),
          body: {
            operations: [{
              update: { resourceName: `customers/${cust}/conversionActions/${digitsOnly(id)}`, name },
              updateMask: "name",
            }],
          },
        };
      }
      return {
        url: `${this.apiBase()}/customers/${cust}/conversionActions:mutate`,
        method: "POST",
        headers: this.hdr(),
        body: {
          operations: [{
            create: {
              name,
              type: "UPLOAD_CLICKS",
              category,
              status: "ENABLED",
              primaryForGoal: false,
              countingType: "MANY_PER_CLICK",
              clickThroughLookbackWindowDays: 90,
              viewThroughLookbackWindowDays: 1,
              attributionModelSettings: { attributionModel: "GOOGLE_ADS_LAST_CLICK" },
              valueSettings: { defaultValue: 0, defaultCurrencyCode: currency, alwaysUseDefaultValue: false },
            },
          }],
        },
      };
    },

    /* ═══════════════════════════════════════════════════════════════════
       KEYWORDS — the level below the ad group, and the only level at which
       "the restaurant's own name" exists as a thing you can add or block.

       Two descriptors, same shape as stateCall/budgetCall so they ride the
       SAME ADS_ALLOW_WRITE gate, the same dry-run preview and the same
       redaction. Neither creates a campaign or an ad group; both refuse to
       invent one, because a mutate with a bad parent resource makes a NEW
       empty thing rather than erroring in any way the caller would notice.

       Why partialFailure on both: a keyword that already exists comes back
       as RESOURCE_ALREADY_EXISTS for that ONE operation. Without the flag
       that single duplicate throws away the other nineteen, so re-running a
       negatives list after adding two more would add nothing at all.
       ═══════════════════════════════════════════════════════════════════ */

    /* Google's own limits: 80 characters, 10 words, no line breaks. A text
       that breaks them is rejected per-row (KeywordError.KEYWORD_TOO_LONG),
       so they are checked here where the reason can still name the keyword. */
    normalizeKeyword(text) {
      const t = String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
      if (!t) return { ok: false, reason: "كلمة فاضية" };
      if (t.length > 80) return { ok: false, reason: `«${t.slice(0, 30)}…» أطول من 80 حرف` };
      if (t.split(" ").length > 10) return { ok: false, reason: `«${t}» أكتر من 10 كلمات` };
      // Google reads these as match-type syntax, not as text. Passing them
      // through silently changes the match type the caller asked for.
      if (/["\[\]]/.test(t)) return { ok: false, reason: `«${t}» فيها علامات (" [ ]) — نوع المطابقة بيتحدّد بـ matchType مش بالعلامات` };
      return { ok: true, text: t };
    },

    MATCH_TYPES: ["EXACT", "PHRASE", "BROAD"],

    /* Positive keywords into ONE existing ad group.
       `keywords` = [{ text, matchType, cpcBid? }] or plain strings with a
       default match type. Returns a descriptor, or throws with the reason —
       the caller (a route or a script) shows that sentence verbatim. */
    keywordCall(adGroupId, keywords, { defaultMatchType = "PHRASE" } = {}) {
      const cust = this.cust();
      const ag = digitsOnly(adGroupId);
      if (!ag) throw new Error("adGroupId مطلوب — الكلمات بتتحط جوّه مجموعة إعلانية موجودة، والدالة دي معملهاش مجموعة جديدة.");
      const rows = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean);
      if (!rows.length) throw new Error("مفيش كلمات مبعوتة.");
      const ops = rows.map((r) => {
        const raw = typeof r === "string" ? { text: r } : r;
        const norm = this.normalizeKeyword(raw.text);
        if (!norm.ok) throw new Error(norm.reason);
        const mt = String(raw.matchType || defaultMatchType).toUpperCase();
        if (!this.MATCH_TYPES.includes(mt)) throw new Error(`نوع مطابقة غير معروف «${mt}» — المسموح: ${this.MATCH_TYPES.join(", ")}`);
        return {
          create: {
            adGroup: `customers/${cust}/adGroups/${ag}`,
            status: "ENABLED",
            keyword: { text: norm.text, matchType: mt },
            ...(raw.cpcBid != null ? { cpcBidMicros: micros(raw.cpcBid) } : {}),
          },
          /* THE SECOND HALF OF A REJECTED KEYWORD.
             A brand keyword can be refused at CREATE time with POLICY_ERROR —
             «فريش كاتس» was refused under SENSITIVE_EVENTS, because Google's
             classifier reads "cuts" as an injury rather than a cut of meat.
             The refusal carries `isExemptible: true`, which means the API is
             willing to accept the same keyword if we assert the policy does
             not apply. That assertion is this field, and it is the API
             equivalent of the UI's "request review" — the same thing Google
             Support asked for and the previous agent could not click.
             It is only ever set from a key Google itself returned (see
             `exemptionKeys()` below), never invented, and only for a
             violation Google marked exemptible. */
          ...(raw.exempt?.length ? { exemptPolicyViolationKeys: raw.exempt } : {}),
        };
      });
      return {
        url: `${this.apiBase()}/customers/${cust}/adGroupCriteria:mutate`,
        method: "POST",
        headers: this.hdr(),
        body: { operations: ops, partialFailure: true, responseContentType: "MUTABLE_RESOURCE" },
      };
    },

    /* Campaign-level NEGATIVE keywords — the ones that stop money going to a
       competitor's brand. Campaign level, not ad group, so one entry covers
       every ad group in the campaign and there is one list to maintain.

       Match type matters more here than anywhere else:
         BROAD negative  — blocks the words in any order, with anything else
                           around them. Right for a competitor's brand name.
         PHRASE negative — blocks only that sequence. Right for a term that
                           could legitimately overlap our own traffic.
       Negative keywords never match close variants, so the exact spelling
       observed in the search-terms report is the spelling that must go in. */
    negativeKeywordCall(campaignId, negatives, { defaultMatchType = "BROAD" } = {}) {
      const cust = this.cust();
      const camp = digitsOnly(campaignId);
      if (!camp) throw new Error("campaignId مطلوب.");
      const rows = (Array.isArray(negatives) ? negatives : [negatives]).filter(Boolean);
      if (!rows.length) throw new Error("مفيش كلمات سلبية مبعوتة.");
      const ops = rows.map((r) => {
        const raw = typeof r === "string" ? { text: r } : r;
        const norm = this.normalizeKeyword(raw.text);
        if (!norm.ok) throw new Error(norm.reason);
        const mt = String(raw.matchType || defaultMatchType).toUpperCase();
        if (!this.MATCH_TYPES.includes(mt)) throw new Error(`نوع مطابقة غير معروف «${mt}»`);
        return {
          create: {
            campaign: `customers/${cust}/campaigns/${camp}`,
            negative: true,
            keyword: { text: norm.text, matchType: mt },
          },
        };
      });
      return {
        url: `${this.apiBase()}/customers/${cust}/campaignCriteria:mutate`,
        method: "POST",
        headers: this.hdr(),
        body: { operations: ops, partialFailure: true, responseContentType: "MUTABLE_RESOURCE" },
      };
    },

    /* ─── READ: keyword quality, in Google's own three components ─────────
       `diagnose()` already answers "is anything blocked". This answers the
       different question the owner asks once things ARE running: "why is a
       keyword that is approved and enabled still barely shown?"

       Quality Score is one number out of ten, and on its own it is useless —
       the fix depends entirely on WHICH of the three components is below
       average. expected CTR → the ad text does not match the query; ad
       relevance → the ad group is too broad; landing page experience → the
       page the click lands on. So all three are returned next to the score,
       plus the impressions that make the score worth acting on at all. */

    /* Pull the exemptible policy keys out of a rejected mutate response.
       Returns one entry per refused operation, so the caller can re-send ONLY
       the exemptible ones with `exempt` set from the key verbatim. Reading the
       key out of Google's own answer instead of hardcoding "SENSITIVE_EVENTS"
       is the point: the next refusal will name a different policy and the same
       code has to carry it. */
    exemptionKeys(raw) {
      const box = Array.isArray(raw) ? raw.find((x) => x?.partialFailureError || x?.error) : raw;
      const pf = box?.partialFailureError || box?.error;
      const errs = pf?.details?.find((d) => Array.isArray(d?.errors))?.errors || [];
      return errs.map((e) => {
        const d = e.details?.policyViolationDetails;
        const idx = e.location?.fieldPathElements?.find((p) => p.fieldName === "operations")?.index;
        return {
          index: idx != null ? Number(idx) : null,
          text: e.trigger?.stringValue || d?.key?.violatingText || null,
          policyName: d?.key?.policyName || null,
          externalPolicyName: d?.externalPolicyName || null,
          description: d?.externalPolicyDescription || null,
          exemptible: d?.isExemptible === true,
          key: d?.key || null,
        };
      }).filter((x) => x.key);
    },

    async keywordQuality({ days = 30 } = {}) {
      const miss = this.missing("manageEnv");
      if (miss) return { ok: false, reason: miss, keywords: [] };
      const to = new Date();
      const from = new Date(to.getTime() - (days - 1) * 86400000);

      const KW = (extra) =>
        `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
                ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type, ad_group_criterion.status,
                ad_group_criterion.system_serving_status,
                ad_group_criterion.approval_status,
                ad_group_criterion.disapproval_reasons,
                ad_group_criterion.effective_cpc_bid_micros${extra}
           FROM keyword_view
          WHERE ad_group_criterion.status != 'REMOVED'
            AND ad_group_criterion.negative = false`;
      const meta = await this.searchWithFallback(
        KW(`, ad_group_criterion.quality_info.quality_score,
             ad_group_criterion.quality_info.creative_quality_score,
             ad_group_criterion.quality_info.post_click_quality_score,
             ad_group_criterion.quality_info.search_predicted_ctr`),
        KW(""));

      if (!meta.ok) return { ok: false, reason: meta.reason, keywords: [] };

      /* Metrics ride a second query on purpose: joining them onto the first
         adds segments.date, which turns one row per keyword into one row per
         keyword per day and quietly makes the status columns repeat. */
      const perf = await this.search(
        `SELECT ad_group_criterion.criterion_id, ad_group.id,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.average_cpc, metrics.ctr
           FROM keyword_view
          WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'
            AND ad_group_criterion.status != 'REMOVED'`);
      const perfBy = new Map();
      for (const x of perf.results || []) {
        const key = `${x.adGroup?.id}~${x.adGroupCriterion?.criterionId}`;
        const m = x.metrics || {};
        const c = perfBy.get(key) || { impressions: 0, clicks: 0, spend: 0, conversions: 0 };
        c.impressions += num(m.impressions);
        c.clicks += num(m.clicks);
        c.spend += num(m.costMicros) / 1e6;
        c.conversions += num(m.conversions);
        perfBy.set(key, c);
      }

      return {
        ok: true,
        days,
        degraded: meta.degraded || null,
        metricsError: perf.ok ? null : perf.reason,
        keywords: (meta.results || []).map((x) => {
          const k = x.adGroupCriterion || {}, qi = k.qualityInfo || {};
          const key = `${x.adGroup?.id}~${k.criterionId}`;
          const p = perfBy.get(key) || { impressions: 0, clicks: 0, spend: 0, conversions: 0 };
          return {
            campaignId: String(x.campaign?.id ?? ""),
            campaignName: x.campaign?.name || "",
            adGroupId: String(x.adGroup?.id ?? ""),
            adGroupName: x.adGroup?.name || "",
            criterionId: String(k.criterionId ?? ""),
            text: k.keyword?.text || "",
            matchType: k.keyword?.matchType || null,
            status: k.status || null,
            servingStatus: k.systemServingStatus || null,
            approvalStatus: k.approvalStatus || null,
            disapprovalReasons: k.disapprovalReasons || [],
            cpcBid: fromMicros(k.effectiveCpcBidMicros),
            qualityScore: qi.qualityScore ?? null,
            // The three components, named the way Google's UI names them so
            // the owner can match this line to the column they are looking at.
            adRelevance: qi.creativeQualityScore || null,          // "Ad relevance"
            landingPage: qi.postClickQualityScore || null,         // "Landing page experience"
            expectedCtr: qi.searchPredictedCtr || null,            // "Expected CTR"
            impressions: p.impressions,
            clicks: p.clicks,
            spend: Math.round(p.spend * 100) / 100,
            conversions: Math.round(p.conversions * 100) / 100,
            ctr: p.impressions > 0 ? Math.round((p.clicks / p.impressions) * 10000) / 100 : null,
          };
        }),
      };
    },

    /* ─── READ: search terms — what people ACTUALLY typed ─────────────────
       The keyword is what we bid on; the search term is what the auction was
       for. On a Phrase/Broad account the two are not the same thing, and the
       gap between them is where a restaurant pays for a competitor's brand.
       This is the evidence a negative-keyword list must be built from. */
    async searchTerms({ days = 30, minImpressions = 1 } = {}) {
      const miss = this.missing("manageEnv");
      if (miss) return { ok: false, reason: miss, terms: [] };
      const to = new Date();
      const from = new Date(to.getTime() - (days - 1) * 86400000);
      const r = await this.search(
        `SELECT search_term_view.search_term, search_term_view.status,
                campaign.id, campaign.name, ad_group.id, ad_group.name,
                segments.keyword.info.text, segments.keyword.info.match_type,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions
           FROM search_term_view
          WHERE segments.date BETWEEN '${isoDate(from)}' AND '${isoDate(to)}'`);
      if (!r.ok) return { ok: false, reason: r.reason, terms: [] };
      const by = new Map();
      for (const x of r.results) {
        const term = x.searchTermView?.searchTerm || "";
        const m = x.metrics || {};
        const cur = by.get(term) || {
          term,
          campaignId: String(x.campaign?.id ?? ""),
          adGroupName: x.adGroup?.name || "",
          matchedKeyword: x.segments?.keyword?.info?.text || null,
          matchedKeywordType: x.segments?.keyword?.info?.matchType || null,
          status: x.searchTermView?.status || null,
          impressions: 0, clicks: 0, spend: 0, conversions: 0,
        };
        cur.impressions += num(m.impressions);
        cur.clicks += num(m.clicks);
        cur.spend += num(m.costMicros) / 1e6;
        cur.conversions += num(m.conversions);
        by.set(term, cur);
      }
      return {
        ok: true, days,
        terms: [...by.values()]
          .filter((t) => t.impressions >= minImpressions)
          .map((t) => ({ ...t, spend: Math.round(t.spend * 100) / 100 }))
          .sort((a, b) => b.spend - a.spend || b.impressions - a.impressions),
      };
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
      const out = { ok: true, connected: true, customerId: this.cust(), apiVersion: this.ver(), days, errors: {} };
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

      /* 2. campaigns, with Google's own verdict on why they are/aren't serving.
         v24 renamed start_date/end_date to start_date_time/end_date_time; the
         fallback keeps an older pinned version readable. */
      const CAMP = (dates) =>
        `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
                campaign.primary_status_reasons, campaign.serving_status,
                campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
                campaign.bidding_strategy_type, ${dates},
                campaign_budget.amount_micros, campaign_budget.explicitly_shared,
                campaign_budget.delivery_method
           FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id`;
      const campRes = await this.searchWithFallback(
        CAMP("campaign.start_date_time, campaign.end_date_time"),
        CAMP("campaign.start_date, campaign.end_date"));
      if (!campRes.ok) out.errors.campaigns = campRes.reason;
      if (campRes.degraded) out.errors.campaignDates = campRes.degraded;
      const camps = campRes.results || [];

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
          startDate: c.startDateTime || c.startDate || null,
          endDate: c.endDateTime || c.endDate || null,
          dailyBudget: fromMicros(b.amountMicros),
          budgetShared: !!b.explicitlyShared,
          budgetDelivery: b.deliveryMethod || null,
          impressions: p.impressions,
          clicks: p.clicks,
          spend: Math.round(p.spend * 100) / 100,
          conversions: Math.round(p.conversions * 100) / 100,
          conversionValue: Math.round(p.value * 100) / 100,
          imprShare: s.searchImpressionShare != null
            ? Math.round(Number(s.searchImpressionShare) * 10000) / 100 : null,
          lostImprShareBudget: s.searchBudgetLostImpressionShare != null
            ? Math.round(Number(s.searchBudgetLostImpressionShare) * 10000) / 100 : null,
          lostImprShareRank: s.searchRankLostImpressionShare != null
            ? Math.round(Number(s.searchRankLostImpressionShare) * 10000) / 100 : null,
        };
      });

      /* 4. ad groups + ads, with the policy verdict on each ad — and, when
         the verdict is bad, Google's own sentence for why. */
      const ads = await run("ads",
        `SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status,
                ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status,
                ad_group_ad.policy_summary.approval_status,
                ad_group_ad.policy_summary.review_status,
                ad_group_ad.policy_summary.policy_topic_entries
           FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'`);
      out.ads = ads.map((x) => {
        const ps = x.adGroupAd?.policySummary || {};
        const topics = policyEntries(ps.policyTopicEntries);
        return {
          campaignId: String(x.campaign?.id ?? ""),
          adGroupId: String(x.adGroup?.id ?? ""),
          adGroupName: x.adGroup?.name || "",
          adGroupStatus: x.adGroup?.status || null,
          adId: String(x.adGroupAd?.ad?.id ?? ""),
          adType: x.adGroupAd?.ad?.type || null,
          status: x.adGroupAd?.status || null,
          approvalStatus: ps.approvalStatus || null,
          reviewStatus: ps.reviewStatus || null,
          policyTopics: topics,
          policyText: topics.map(policyLine),
        };
      });

      /* 5. keywords — a Search campaign with none of them cannot serve, and a
         keyword can be DISAPPROVED while every ad above it is APPROVED. That
         case is invisible at the ad level and is exactly what killed delivery
         here, so the policy summary is read at the criterion level too and
         Google's topic + the offending text are carried out verbatim.
         `ad_group_criterion.policy_summary` is the optional half: if a future
         version drops or renames it, the fallback still answers "are there
         keywords and are they enabled". */
      const KW_LEAN = `SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.criterion_id,
                ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                ad_group_criterion.status, ad_group_criterion.negative,
                ad_group_criterion.system_serving_status
           FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED'`;
      const kwRes = await this.searchWithFallback(
        `SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.criterion_id,
                ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                ad_group_criterion.status, ad_group_criterion.negative,
                ad_group_criterion.approval_status,
                ad_group_criterion.disapproval_reasons,
                ad_group_criterion.system_serving_status,
                ad_group_criterion.quality_info.quality_score
           FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED'`,
        KW_LEAN);
      if (!kwRes.ok) out.errors.keywords = kwRes.reason;
      if (kwRes.degraded) out.errors.keywordPolicyDetail = kwRes.degraded;
      out.keywords = (kwRes.results || []).map((x) => {
        const k = x.adGroupCriterion || {};
        /* Unlike an ad, a keyword carries no PolicyTopicEntry list — Google
           gives `disapproval_reasons`, a flat array of policy-topic names
           ("Sensitive events"). That IS Google's wording, so it is passed
           through untouched and shaped like the ad-level topics so the two
           read the same downstream. */
        const topics = (k.disapprovalReasons || []).map((t) => ({
          topic: t, type: null, typeAr: null, evidence: [], constraints: [],
        }));
        return {
          campaignId: String(x.campaign?.id ?? ""),
          adGroupId: String(x.adGroup?.id ?? ""),
          adGroupName: x.adGroup?.name || "",
          criterionId: String(k.criterionId ?? ""),
          text: k.keyword?.text || "",
          matchType: k.keyword?.matchType || null,
          negative: !!k.negative,
          status: k.status || null,
          approvalStatus: k.approvalStatus || null,
          servingStatus: k.systemServingStatus || null,
          qualityScore: k.qualityInfo?.qualityScore ?? null,
          policyTopics: topics,
          // Verbatim, so the owner reads Google's label and not our gloss.
          disapprovalReasons: k.disapprovalReasons || [],
          policyText: topics.map((t) => `«${t.topic}»`),
        };
      });

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
        /* Not every reason Google gives is a fault. A campaign four days old
           on TARGET_SPEND is SUPPOSED to say LEARNING; calling that a blocker
           buries the actual blocker under it and makes the verdict — which is
           just the first blocker — point at the wrong thing. */
        for (const r of c.reasons) add(SOFT_REASONS.has(r.code) ? "warn" : "blocker", `«${c.name}»: ${r.ar}`);
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
        for (const a of disapproved) {
          for (const line of a.policyText) add("blocker", `«${c.name}» إعلان ${a.adId} مرفوض: ${line}`);
        }
        const kw = out.keywords.filter((k) => k.campaignId === c.id && !k.negative);
        if (c.channel === "SEARCH" && !kw.length && !out.errors.keywords) add("blocker", `«${c.name}»: حملة بحث من غير كلمات مفتاحية.`);

        /* A DISAPPROVED keyword under an APPROVED ad is the failure mode that
           looks like nothing is wrong: the ads pass review, the campaign says
           ELIGIBLE, and the queries the restaurant is actually named for never
           enter the auction. Say it per keyword, with Google's own topic. */
        const badKw = kw.filter((k) => k.approvalStatus === "DISAPPROVED" || (k.disapprovalReasons || []).length);
        for (const k of badKw) {
          const why = k.disapprovalReasons?.length ? k.disapprovalReasons.map((t) => `«${t}»`).join(" · ") : (k.approvalStatus || "مرفوضة من غير سبب مذكور");
          add("blocker", `«${c.name}» / ${k.adGroupName} — الكلمة «${k.text}» مرفوضة من جوجل، والسبب بنص جوجل: ${why}`);
        }
        /* One line for all of them. Twelve warnings that each name a keyword
           is not twelve problems, it is one sentence. */
        const idleKw = kw.filter((k) => !badKw.includes(k) && SLOW_KEYWORD.has(k.servingStatus));
        if (idleKw.length) {
          add("warn", `«${c.name}»: ${idleKw.length} كلمة مقبولة بس جوجل بيقول إنها نادرًا ما بتظهر (${[...new Set(idleKw.map((k) => k.servingStatus))].join(", ")}) — ${idleKw.map((k) => `«${k.text}»`).join(" · ")}. غالبًا حجم بحث قليل جدًا على الصياغة دي.`);
        }
        if (kw.length && badKw.length === kw.length) {
          add("blocker", `«${c.name}»: كل الكلمات المفتاحية (${kw.length}) مرفوضة — الحملة مؤهّلة على الورق بس مفيش استعلام واحد ممكن تدخل مزاده.`);
        }
        /* Brand keywords are a special case worth naming: if the ones that
           carry the restaurant's own name are blocked, nobody searching for
           Fresh Cuts by name can be shown a Fresh Cuts ad, however healthy
           everything else looks. */
        const brandBlocked = badKw.filter((k) => /فريش|fresh\s*cut/i.test(k.text));
        if (brandBlocked.length) {
          add("blocker", `«${c.name}»: اسم المطعم نفسه محجوب — ${brandBlocked.map((k) => `«${k.text}»`).join(" · ")} مرفوضة، يعني اللي بيدوّر على «فريش كاتس» بالاسم مش ممكن يشوف إعلانك. قدّم اعتراض (Appeal) على الكلمات دي من شاشة الكلمات المفتاحية في جوجل.`);
        }
        /* Enabled, approved, funded, and still effectively invisible. Zero is
           already covered; this is the "one impression in two weeks" case. */
        if (c.impressions > 0 && c.impressions < 10 && !c.spend) {
          add("warn", `«${c.name}»: ${c.impressions} انطباع بس في ${days} يوم وصفر صرف من ميزانية ${c.dailyBudget} — الحملة عمليًا مش داخلة مزادات، مش إنها بتصرف من غير نتيجة.`);
        }
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
        add("blocker", `إجراء التحويل «${target.name}» نوعه ${target.type} — الرفع من السيرفر (UploadClickConversions) بيقبل بس نوع UPLOAD_CLICKS. الرفع متوقّف عن قصد (مش بيحاول ويفشل)؛ اعمل إجراء استيراد جديد بـ POST /api/ads/google/conversion-action وحطّ رقمه في GOOGLE_ADS_CONVERSION_ACTION_ID.`);
        // The one already in the account that WOULD work, if there is one.
        const ok = conv.filter((a) => a.uploadable && a.status === "ENABLED");
        if (ok.length) add("info", `فيه إجراء رفع صالح جاهز في الحساب: ${ok.map((a) => `«${a.name}» (${a.id})`).join(" · ")}.`);
      }
      if (!wantedAction) {
        add("info", "GOOGLE_ADS_CONVERSION_ACTION_ID مش متحطّط — القراءة والتحكم شغالين، لكن مفيش رفع للطلبات من الكاشير لجوجل.");
      }
      /* The upload gate, stated once. This is the same object /api/ads/status
         shows, so the dashboard and this screen never disagree. */
      try { out.uploadReadiness = await this.readiness({ force: true }); }
      catch (e) { out.uploadReadiness = { ok: true, code: "UNVERIFIED", reason: String(e.message || e) }; }
      if (out.uploadReadiness?.ok === false && !f.some((x) => x.ar === out.uploadReadiness.reason)) {
        add("blocker", out.uploadReadiness.reason);
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
