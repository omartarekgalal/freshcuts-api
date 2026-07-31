// keeta.js — Keeta (Meituan/Sankuai "Sailor") merchant-portal connector.
//
// WHY THIS EXISTS
// Keeta is ~96% of this restaurant's delivery volume, and the single biggest
// blind spot in our stack: Keeta runs a **CPC ad campaign** (تعزيز الزيارات)
// whose impressions, clicks, CTR, ad-attributed orders/revenue and ROAS exist
// NOWHERE in FeedUs or TabSense. Same for the الأداء analytics (conversion
// funnel, commission, new-vs-repeat customers) and the الخدمات SLA block.
// This module is the read surface for all of that, plus a small set of
// deliberately-fenced write levers.
//
// ── TRANSPORT NOTES (learned the hard way, do not "fix" these) ──────────────
// 1. Every business call is a JSON POST on merchant.mykeeta.com, EXCEPT a
//    handful that are GET with query params (marked per endpoint below).
// 2. DO NOT append `?yodaReady=h5&csecplatform=4&csecversion=3.5.1`. The
//    browser sends it, but it puts the request on the H5guard/csec path, which
//    demands an `mtgsig` signature blob we cannot produce — the edge answers a
//    bare `403 Forbidden` (openresty) before the app ever sees it. Verified:
//    identical request with the suffix = 403, without = 200/code 0.
// 3. Auth = the portal session cookie PLUS the Meituan bookkeeping headers
//    (m-appkey, shopid, loginaccountid, region, cityid …). Cookie alone gets
//    HTTP 200 with `{"code":101000918,"message":"system error"}`. So: a
//    non-zero `code` is a failure REGARDLESS of HTTP status.
// 4. Their login is captcha/risk-scored, so nothing can log in headlessly. The
//    cookie is refreshed by a human. Every route therefore separates
//    "Keeta said no" from "our cookie lapsed" and says so in Arabic.
//
// Registered by index.js via `register(app, ctx)`; owns no tables.

const BASE = (process.env.KEETA_BASE || "https://merchant.mykeeta.com").replace(/\/$/, "");
const SHOP_ID = process.env.KEETA_SHOP_ID || "1430391221";
const COOKIE = process.env.KEETA_COOKIE || "";
const HEADERS_RAW = process.env.KEETA_HEADERS || "";
// The ads BFF addresses the *account*, not the shop. Same value the portal
// puts in `targetAcctId`/`uid`.
const ACCT_ID = process.env.KEETA_ACCT_ID || "4611686018430691085";

// Writes are off unless explicitly armed, and the ad budget has a hard ceiling
// on top of that — a fat-fingered request must not be able to spend the shop
// into the ground.
const ALLOW_WRITE = process.env.KEETA_ALLOW_WRITE === "1";
const MAX_AD_BUDGET = Number(process.env.KEETA_MAX_AD_BUDGET || 3000);
const CACHE_MS = Number(process.env.KEETA_CACHE_MS || 300000);   // 5 min

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const MSG_EXPIRED = "الجلسة انتهت — جدّد KEETA_COOKIE";

/* ═══════════════════════════════════════════════════════════════════════
   TRANSPORT
   ═══════════════════════════════════════════════════════════════════════ */

function configured() {
  return !!(SHOP_ID && COOKIE);
}

function missingEnv() {
  const out = [];
  if (!COOKIE) out.push("KEETA_COOKIE");
  if (!SHOP_ID) out.push("KEETA_SHOP_ID");
  if (!HEADERS_RAW) out.push("KEETA_HEADERS");   // works without, but only until the gateway notices
  return out;
}

function bizHeaders() {
  let extra = {};
  try { extra = HEADERS_RAW ? JSON.parse(HEADERS_RAW) : {}; } catch { extra = {}; }
  return {
    "User-Agent": UA,
    Accept: "application/json",
    Cookie: COOKIE,
    ...extra,
  };
}

// Two failure kinds, because the owner's fix differs: `expired` means "go log
// in and paste a fresh cookie", anything else means "Keeta itself is unhappy".
class KeetaError extends Error {
  constructor(message, { expired = false, code = null, http = null } = {}) {
    super(message);
    this.name = "KeetaError";
    this.expired = expired;
    this.code = code;
    this.http = http;
  }
}

// Codes that mean the credential pair is no longer good. Getting this list
// right is the whole point: a misfiled auth error becomes a dashboard full of
// zeros instead of "go refresh the cookie", which is the one failure the owner
// will actually hit.
//   101000918 — gateway rejects the bookkeeping headers ("invalid length"),
//               i.e. our identity is not being accepted at all.
//   50103     — `passport鉴权错误` — the session cookie no longer resolves to a
//               logged-in user. Verified by replaying every route with a junk
//               cookie: this is what a dead session returns.
//   101000    — the passport error itself, which the data + ads BFF services
//               surface directly instead of wrapping in 50103. Its message is
//               the maddeningly generic "Server exception. Please try again",
//               but it is the inner code quoted inside every 50103 body, and
//               it never appeared once across a live-cookie sweep of every
//               endpoint here. Treat it as re-auth, not as a blip.
const AUTH_CODES = new Set([101000918, 101000, 50103, 401, 403]);
const AUTH_MSG = /未登录|登录已失效|请登录|鉴权|passport|not\s*log(ged)?\s*in|unauthor|forbidden/i;

/**
 * The single door to Keeta. Everything else in this file is three lines on top
 * of this: `const j = await keetaCall(path, body)` and a normaliser.
 *
 * @param {string} path   e.g. "/api/scm/shop/base/summary"
 * @param {object} body   JSON body (POST) — omit for GET
 * @param {object} opts   { method, query }
 */
async function keetaCall(path, body, { method, query } = {}) {
  if (!configured()) {
    throw new KeetaError(`كيتا غير مربوطة — الناقص: ${missingEnv().join(", ")}`, { expired: true });
  }
  const verb = method || (body === undefined ? "GET" : "POST");
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const init = { method: verb, headers: bizHeaders() };
  if (verb !== "GET" && verb !== "HEAD") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body || {});
  }

  let res;
  try {
    res = await fetch(BASE + path + qs, init);
  } catch (e) {
    throw new KeetaError(`تعذر الوصول إلى كيتا: ${e.message}`);
  }
  const text = await res.text();

  // 401/403 never reach the app layer — that is the edge (or a dead session)
  // slamming the door. Both mean "re-auth", never "the shop has no data".
  if (res.status === 401 || res.status === 403) {
    throw new KeetaError(MSG_EXPIRED, { expired: true, http: res.status });
  }

  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (!json) {
    // A login bounce serves HTML. Anything non-JSON here is not a data answer.
    throw new KeetaError(MSG_EXPIRED, { expired: true, http: res.status });
  }

  // HTTP 200 + non-zero code is their normal way of saying no.
  const code = json.code;
  if (code !== 0 && code !== undefined) {
    const msg = String(json.message || json.msg || "");
    const expired = AUTH_CODES.has(code) || AUTH_MSG.test(msg);
    throw new KeetaError(
      expired ? MSG_EXPIRED : `كيتا رفضت الطلب (code ${code}): ${msg || "بدون رسالة"}`,
      { expired, code, http: res.status }
    );
  }
  return json.data !== undefined ? json.data : json;
}

/* ═══════════════════════════════════════════════════════════════════════
   PARSING — Keeta hands back display strings, not numbers
   ═══════════════════════════════════════════════════════════════════════
   Real samples: "10,754" · "‏1,272.20 $" · "‏105.24 ر.س.‏" · "%5.82" · "5.3"
   (leading RTL marks, thousands separators, a currency glyph that is sometimes
   "$" even though the money is SAR, and a LEADING percent sign).            */

const RTL = /[‎‏؜‪-‮]/g;

/** Display string → Number, or null. Never 0-as-a-guess, never NaN.
    Grab the first numeric token rather than stripping non-digits: the Arabic
    riyal suffix "ر.س." carries DOTS, so a strip-and-parse turns "105.24 ر.س."
    into "105.24.." → NaN. The sign can also sit outside the token ("-%6.48"). */
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(RTL, "");
  const m = s.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return /-/.test(s.slice(0, m.index)) ? -n : n;
}

/** "%5.82" → 0.0582 (a fraction, so callers can format however they like).
    Rounded because /100 on a float leaves 0.9640000000000001-style noise. */
function pct(v) {
  const n = num(v);
  return n === null ? null : Math.round((n / 100) * 1e8) / 1e8;
}

/** Keeta money fields on the ads BFF are integer minor units: 200000 → 2000.00 */
const minor = (v) => (v === null || v === undefined ? null : num(v) === null ? null : num(v) / 100);

/** a/b, but null when the answer would be meaningless rather than 0 or Infinity. */
function ratio(a, b) {
  if (a === null || b === null || !b) return null;
  return a / b;
}

const round = (n, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** "20260714" → "2026-07-14" (their date keys), passthrough if already ISO. */
function isoDay(v) {
  const s = String(v || "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}
/** "2026-07-14" → "20260714" (what their date filters want). */
const compact = (iso) => String(iso || "").replace(/-/g, "").slice(0, 8);

/** Epoch seconds OR millis → ISO date. Their promo rows use seconds. */
function epochISO(v) {
  const n = num(v);
  if (!n) return null;
  const ms = n > 1e11 ? n : n * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* ═══════════════════════════════════════════════════════════════════════
   CACHE — the manager dashboard polls; Keeta must not feel it
   ═══════════════════════════════════════════════════════════════════════ */

const _cache = new Map();          // key -> { at, value }
const _inflight = new Map();       // key -> Promise (collapse concurrent misses)

async function cached(key, fn, ttl = CACHE_MS) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    const value = await fn();
    _cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

/* ═══════════════════════════════════════════════════════════════════════
   ANALYTICS (الأداء) — /api/data/shop/chart/query
   ═══════════════════════════════════════════════════════════════════════
   Shape reverse-engineered from the portal's own bizdata bundle:

     POST /api/data/shop/chart/query?code=<CODE>
     { code, form: { filters: [[]], dateFilters: [ {code:"dt", values:["20260701~20260730"]},
                                                   {code:"dt", values:["20260601~20260630"]} ] },
       ext: { locale, shopId, isRealTime:false } }

   The 2nd dateFilters entry is the comparison window; some codes echo it back
   as `popValue`, most return null. We therefore never rely on popValue for the
   previous period — we simply run the whole set twice with shifted windows.
   That is one extra round trip and zero guesswork.                          */

const CHART = {
  businessProfit: "business_analysis_measure_card_profit_v2",
  businessTrend: "business_analysis_line_chart_profit_v2",
  marketing: "marketing_analysis_measure_card_overview",
  marketingCard: "marketing_analysis_measure_card",
  customers: "customer_analysis_measure_card_pay",
  funnelCard: "flow_analysis_measure_card",
  funnelShape: "flow_analysis_mirror_funnel",
  // Carries the per-stage HEAD COUNTS (visitors, cart-adders, checkout) that
  // flow_analysis_measure_card omits — it only has impressions/order-customers.
  conversion: "customer_analysis_measure_card_conversion",
  svcHours: "service_analysis_measure_card_opening_time",
  svcCancel: "service_analysis_measure_card_order_cancel",
  svcGuide: "service_analysis_measure_card_business_guide",
  svcPrep: "service_analysis_measure_card_prepare_time",
  // Known-broken upstream as of 2026-08: answers `code -1 System error` /
  // `500 mtthrift remote` on every attempt. It is the only chart carrying the
  // العمولة المقدرة (Keeta commission) breakdown, so commission stays null and
  // the route reports it in `unavailable` rather than inventing a number.
  businessBreakdown: "business_analysis_column_chart",
};

function dateFilters(from, to, prevFrom, prevTo) {
  return [
    { code: "dt", values: [`${compact(from)}~${compact(to)}`] },
    { code: "dt", values: [`${compact(prevFrom)}~${compact(prevTo)}`] },
  ];
}

async function chartQuery(code, from, to, prevFrom, prevTo) {
  return keetaCall("/api/data/shop/chart/query", {
    code,
    form: { filters: [[]], dateFilters: dateFilters(from, to, prevFrom, prevTo) },
    ext: { locale: "ar", shopId: Number(SHOP_ID), isRealTime: false },
  }, { query: { code } });
}

/** MeasureCard / MeasureCardGroup → { metricCode: {value, raw, name} }. */
function seriesMap(data) {
  const out = {};
  const flat = (data?.series || []).flat();
  for (const s of flat) {
    if (!s || !s.code) continue;
    const isPercent = s.showType === "PERCENT" || /^%/.test(String(s.value || ""));
    out[s.code] = {
      name: s.name || null,
      raw: s.value ?? null,
      value: isPercent ? pct(s.value) : num(s.value),
      isPercent,
    };
  }
  return out;
}
const mv = (m, code) => (m[code] ? m[code].value : null);

/** Run several chart codes for one window; never let one bad code kill the set. */
async function chartSet(codes, from, to, prevFrom, prevTo) {
  const entries = await Promise.all(
    Object.entries(codes).map(async ([key, code]) => {
      try {
        return [key, { ok: true, code, data: await chartQuery(code, from, to, prevFrom, prevTo) }];
      } catch (e) {
        if (e instanceof KeetaError && e.expired) throw e;   // re-auth beats partial data
        return [key, { ok: false, code, error: e.message }];
      }
    })
  );
  return Object.fromEntries(entries);
}

/* ═══════════════════════════════════════════════════════════════════════
   NORMALISERS
   ═══════════════════════════════════════════════════════════════════════ */

// ── ads ─────────────────────────────────────────────────────────────────
// budgetMode / bidType are Meituan enums; the portal renders them as
// "تشغيل أسبوعي" and "عرض الأسعار التلقائي" for the values we actually see.
const BUDGET_MODE = { 1: "DAILY", 2: "TOTAL", 3: "WEEKLY" };
const BUDGET_MODE_AR = { DAILY: "ميزانية يومية", TOTAL: "ميزانية إجمالية", WEEKLY: "تشغيل أسبوعي" };
const BID_TYPE = { 1: "MANUAL", 2: "AUTO" };
const BID_TYPE_AR = { MANUAL: "مزايدة يدوية", AUTO: "عرض الأسعار التلقائي" };

function normalisePlan(plan) {
  const unit = (plan?.unitList || [])[0] || {};
  const bidMode = BID_TYPE[unit.bidType] || (unit.showIntelligentBid ? "AUTO" : null);
  const schedule = BUDGET_MODE[plan?.budgetMode] || null;
  const budget = minor(plan?.budget);
  const spent = minor(plan?.budgetUsed);
  return {
    planId: plan?.planId ?? null,
    // status 0 = the plan is running (the portal badge read نشط with status 0).
    // Anything else we surface raw rather than guess a label for.
    active: plan?.status === 0,
    statusRaw: plan?.status ?? null,
    budget,
    spent,                                   // spend inside the CURRENT budget period
    remaining: budget === null || spent === null ? null : round(budget - spent),
    remainingPercent: plan?.budgetRemainingPercent ?? null,
    bidMode,
    bidModeLabel: bidMode ? BID_TYPE_AR[bidMode] : null,
    bid: minor(unit.bid) === null ? null : num(unit.bid),
    targetRoi: unit.targetRoi ?? null,
    schedule,
    scheduleLabel: schedule ? BUDGET_MODE_AR[schedule] : null,
    createdAt: plan?.planCreateTime ? new Date(plan.planCreateTime).toISOString() : null,
  };
}

function normaliseAdDaily(rows) {
  return (rows || []).map((r) => ({
    date: isoDay(r.time),
    impressions: num(r.showCount),
    clicks: num(r.clickCount),
    orders: num(r.orders),
    revenue: num(r.adrevenue),
    spend: num(r.debit),
  }));
}

function normaliseAdTotals(t) {
  const impressions = num(t?.showCount);
  const clicks = num(t?.clickCount);
  const orders = num(t?.orders);
  const revenue = num(t?.adrevenue);
  const spend = num(t?.debit);
  return {
    impressions,
    clicks,
    ctr: round(ratio(clicks, impressions), 6),
    orders,
    revenue,
    spend,
    // Keeta reports its own ROAS; prefer it, fall back to the arithmetic.
    roas: num(t?.roas) ?? round(ratio(revenue, spend), 2),
    cpc: round(ratio(spend, clicks), 4),
    conversionRate: round(ratio(orders, clicks), 6),
  };
}

// ── promotions ──────────────────────────────────────────────────────────
// actAggregateType and status are Chinese-labelled in the API; the portal
// shows Arabic. Map both so the UI never renders 满减活动 at the owner.
const ACT_TYPE = {
  1: { key: "ORDER_DISCOUNT", ar: "خصم على الطلب" },
  2: { key: "DELIVERY_FEE", ar: "خصم رسوم التوصيل" },
  3: { key: "ITEM_DISCOUNT", ar: "صنف ترويجي" },
  4: { key: "FIXED_PRICE", ar: "سعر ثابت" },
  5: { key: "ITEM_DELIVERY_FEE", ar: "رسوم توصيل على الصنف" },
};
const ACT_STATUS = {
  0: { key: "SCHEDULED", ar: "لم يبدأ" },
  1: { key: "RUNNING", ar: "مستمر" },
  2: { key: "ENDED", ar: "منتهية" },
  3: { key: "OFFLINE", ar: "تم إنهاؤها" },
  4: { key: "PAUSED", ar: "موقوفة" },
  5: { key: "PENDING", ar: "سيُعمل به" },
  6: { key: "TERMINATED", ar: "ملغاة" },
  7: { key: "CONTROLLED", ar: "قيد المراجعة" },
};

function normalisePromotion(r) {
  const type = ACT_TYPE[r.actAggregateType] || null;
  const st = ACT_STATUS[r.status] || null;
  const policy = (r.policy || [])[0] || {};
  const autoDelay = r.actCtrl?.autoDelayType;
  return {
    id: r.id,
    name: r.actName || null,
    type: type?.key || `TYPE_${r.actAggregateType}`,
    typeLabel: type?.ar || null,
    channel: r.userGetMode || null,                       // delivery | pickup
    channelLabel: r.userGetMode === "pickup" ? "استلام شخصي" : "توصيل",
    audience: r.userTypeDesc || null,                     // "جميع العملاء"
    rules: r.benefitInfoDtoList || [],                    // already Arabic sentences
    status: st?.key || `STATUS_${r.status}`,
    statusLabel: st?.ar || null,
    from: epochISO(r.startTime),
    to: epochISO(r.endTime),
    period: r.period || null,                             // "00:00-23:59"
    weekdays: r.weeksTime || null,
    autoRenew: autoDelay ? autoDelay !== "NO_AUTO_DELAY" : r.autoDelayType !== 0,
    merchantShare: pct(policy.poiChargeValue),            // إعانة التاجر
    platformShare: pct(policy.mtChargeValue),             // إعانة المنصة
    source: r.actCreateSource === 1 ? "أدوات العروض الترويجية" : (r.platformActName || "عروض Keeta الترويجية"),
    canEnd: (r.activityOperations || []).some((o) => o.type === 2 && o.isAllowed === 1),
  };
}

// ── menu ────────────────────────────────────────────────────────────────
// Keeta keeps a SEPARATE delivery price and pickup price per SKU, and any
// running item discount lives in `onSaleDetail`. `priceAmount` is minor units
// and is the trustworthy field; `price` is a display string.
function normaliseMenuItem(spu, categoryNames) {
  const sku = (spu.skuList || [])[0] || {};
  const sale = spu.onSaleDetail || {};
  const catIds = spu.shopCategoryIdList || [];
  const discountPct = sale.minDeliveryDiscount != null ? sale.minDeliveryDiscount / 100 : null;
  return {
    id: spu.id,
    name: spu.name || null,
    category: catIds.map((id) => categoryNames.get(id) || String(id)).join(" / ") || null,
    categoryIds: catIds,
    available: spu.status === 1,
    deliveryPrice: sku.priceAmount != null ? sku.priceAmount / 100 : num(sku.price),
    pickupPrice: sku.pickPriceAmount != null ? sku.pickPriceAmount / 100 : num(sku.pickPrice),
    channels: spu.userGetModeList || [],
    discount: sale.deliveryOnSaleStatus === 1 || sale.pickupOnSaleStatus === 1
      ? {
          deliveryPercent: discountPct,
          pickupPercent: sale.minPickupDiscount != null ? sale.minPickupDiscount / 100 : null,
          deliveryPriceOnSale: num(sale.minPriceOnSale),
          pickupPriceOnSale: num(sale.minPickPriceOnSale),
          from: sale.deliveryOnSaleStartTime ? new Date(sale.deliveryOnSaleStartTime).toISOString().slice(0, 10) : null,
          to: sale.deliveryOnSaleEndTime ? new Date(sale.deliveryOnSaleEndTime).toISOString().slice(0, 10) : null,
        }
      : null,
    sku: sku.id ?? null,
    code: spu.openItemCode || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   WRITE GUARD
   ═══════════════════════════════════════════════════════════════════════
   Refused writes are not silent: we hand back the exact request we WOULD have
   sent so the owner can eyeball it (and, if they like it, arm the flag and try
   again). Nothing here ever leaves the process while the guard is closed.

   DELIBERATELY NOT IMPLEMENTED: /api/ad/billing/account/fund/allocate.
   That endpoint moves real money into the Keeta ad account. Automating a funds
   transfer is not a thing this server should be able to do at 3am on a cron —
   it stays a human action in the portal, on purpose.                        */

function guardWrite(url, method, body, extraGuard = null) {
  if (extraGuard) {
    return { applied: false, guard: extraGuard, wouldCall: { url: BASE + url, method, body } };
  }
  if (!ALLOW_WRITE) {
    return {
      applied: false,
      guard: "الكتابة معطّلة — فعّل KEETA_ALLOW_WRITE=1 للسماح بالتنفيذ",
      wouldCall: { url: BASE + url, method, body },
    };
  }
  return null;   // cleared to send
}

/* ═══════════════════════════════════════════════════════════════════════
   REGISTER
   ═══════════════════════════════════════════════════════════════════════ */

export function register(app, ctx) {
  const { requireAdmin, todayISO, daysAgoISO } = ctx;

  // Every route funnels its failures through here so "cookie died" always
  // reads the same, in Arabic, with an HTTP status the UI can branch on.
  const fail = (c, e) => {
    if (e instanceof KeetaError) {
      return c.json(
        { ok: false, expired: e.expired, error: e.message, code: e.code ?? null },
        e.expired ? 401 : 502
      );
    }
    return c.json({ ok: false, expired: false, error: e.message }, 500);
  };

  // from/to default to the last 30 complete days (yesterday backwards), which
  // is the window the portal itself defaults to for the ad report.
  const range = (c) => {
    const to = c.req.query("to") || daysAgoISO(1);
    const from = c.req.query("from") || daysAgoISO(30);
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
    const prevTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
    const prevFrom = new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10);
    return { from, to, days, prevFrom, prevTo };
  };

  /* ─── STATUS ─────────────────────────────────────────────────────────
     GET /api/scm/shop/base/summary?shopId= (one of the few GET endpoints). */
  app.get("/api/keeta/status", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    if (!configured()) {
      return c.json({
        ok: true, configured: false, state: "unconfigured",
        missing: missingEnv(),
        detail: `كيتا غير مربوطة — الناقص: ${missingEnv().join(", ")}`,
      });
    }
    try {
      const d = await cached("status", () =>
        keetaCall("/api/scm/shop/base/summary", undefined, { query: { shopId: SHOP_ID } })
      , 60000);
      const open = d.businessStatus === 1 && d.duringBusinessHour !== false;
      // "busy" is a pause on top of open: either the pause timestamp is set or
      // delivery is resting while the shop is nominally open.
      const busy = open && (d.busyStatusChangeTime != null ||
        (d.deliveryRestStatus != null && d.deliveryRestStatus !== 1));
      const state = !open ? "closed" : busy ? "busy" : "open";
      return c.json({
        ok: true,
        configured: true,
        missing: missingEnv(),
        shopId: SHOP_ID,
        shopName: d.name || d.i18nName || null,
        state,
        detail: state === "open" ? "المتجر مفتوح"
          : state === "busy" ? "مشغول — التوصيل موقوف مؤقتاً"
          : d.duringBusinessHour === false ? "خارج ساعات العمل" : "المتجر مقفول",
        duringBusinessHour: d.duringBusinessHour ?? null,
        resumeAt: d.resumeBusinessTime ? new Date(d.resumeBusinessTime).toISOString() : null,
        writeEnabled: ALLOW_WRITE,
        maxAdBudget: MAX_AD_BUDGET,
        raw: {
          status: d.status, businessStatus: d.businessStatus,
          deliveryRestStatus: d.deliveryRestStatus, pickupRestStatus: d.pickupRestStatus,
        },
      });
    } catch (e) { return fail(c, e); }
  });

  /* ─── ADS ────────────────────────────────────────────────────────────
     The most valuable route in this file. Two calls:
       GET  /api/bff/ad/poi/v1/sspcpc/plan/query?targetAcctId=&shopId=
            → budget / spend / bid mode / schedule / active state
       POST /api/bff/ad/poi/v1/sspcpc/data/query/his
            body {targetAcctId, startDate:"YYYYMMDD", endDate:"YYYYMMDD"}
            → totals + daily impressions/clicks/orders/revenue/spend
     Note the two spend figures mean different things and both are kept:
       `spent`        = used inside the current budget period (weekly run)
       `totals.spend` = spend across the requested from..to window            */
  app.get("/api/keeta/ads", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to } = range(c);
    try {
      const out = await cached(`ads:${from}:${to}`, async () => {
        const [planR, hisR] = await Promise.allSettled([
          keetaCall("/api/bff/ad/poi/v1/sspcpc/plan/query", undefined, {
            query: { targetAcctId: ACCT_ID, shopId: SHOP_ID },
          }),
          keetaCall("/api/bff/ad/poi/v1/sspcpc/data/query/his", {
            targetAcctId: ACCT_ID,
            startDate: compact(from),
            endDate: compact(to),
          }),
        ]);
        for (const r of [planR, hisR]) {
          if (r.status === "rejected" && r.reason instanceof KeetaError && r.reason.expired) throw r.reason;
        }
        const plan = planR.status === "fulfilled" ? normalisePlan(planR.value) : null;
        const his = hisR.status === "fulfilled" ? hisR.value : null;
        const totals = normaliseAdTotals(his?.total?.selfData);
        const daily = normaliseAdDaily(his?.details?.selfData);
        return {
          ok: true,
          from, to,
          active: plan ? plan.active : null,
          planId: plan?.planId ?? null,
          budget: plan?.budget ?? null,
          spent: plan?.spent ?? null,
          remaining: plan?.remaining ?? null,
          remainingPercent: plan?.remainingPercent ?? null,
          bidMode: plan?.bidMode ?? null,
          bidModeLabel: plan?.bidModeLabel ?? null,
          bid: plan?.bid ?? null,
          targetRoi: plan?.targetRoi ?? null,
          schedule: plan?.schedule ?? null,
          scheduleLabel: plan?.scheduleLabel ?? null,
          totals,
          daily,
          errors: [
            planR.status === "rejected" ? `plan: ${planR.reason.message}` : null,
            hisR.status === "rejected" ? `data: ${hisR.reason.message}` : null,
          ].filter(Boolean),
        };
      });
      return c.json(out);
    } catch (e) { return fail(c, e); }
  });

  /* ─── PROMOTIONS ─────────────────────────────────────────────────────
     act-statistics gives the status counts, act-list the rows. The list is
     paginated by ACTIVITY GROUPS (totalNum) not activities (totalItemNum), so
     walk pages until the rows run out rather than trusting a single count.  */
  app.get("/api/keeta/promotions", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const status = c.req.query("status");
    try {
      const out = await cached(`promos:${status || "all"}`, async () => {
        const stats = await keetaCall("/api/marketing/promotion/shop/act-statistics", {
          shopId: Number(SHOP_ID),
          status: status ? Number(status) : -1,
          actAggregateType: -1,
          configChannel: "shopPc",
        });
        const rows = [];
        for (let page = 1; page <= 20; page++) {
          const d = await keetaCall("/api/marketing/promotion/shop/act-list", {
            actAggregateType: -1,
            shopId: Number(SHOP_ID),
            status: status ? Number(status) : -1,
            actName: "",
            pageNum: page,
            pageSize: 50,
            configChannel: "shopPc",
            transferCnDiscount: false,
          });
          const list = d?.list || [];
          rows.push(...list);
          if (list.length < 50) break;
        }
        const statusCounts = {};
        for (const s of stats?.stateStatistics || []) {
          if (s.state === -1) continue;
          const m = ACT_STATUS[s.state];
          statusCounts[m?.key || `STATUS_${s.state}`] = { count: s.count, label: m?.ar || s.stateName };
        }
        const typeCounts = {};
        for (const t of stats?.aggregateTypeStatistics || []) {
          if (t.aggregateType === -1) continue;
          const m = ACT_TYPE[t.aggregateType];
          typeCounts[m?.key || `TYPE_${t.aggregateType}`] = { count: t.count, label: m?.ar || t.aggregateTypeName };
        }
        const total = (stats?.stateStatistics || []).find((s) => s.state === -1)?.count ?? rows.length;
        return {
          ok: true,
          total,
          running: statusCounts.RUNNING?.count ?? null,
          statusCounts,
          typeCounts,
          promotions: rows.map(normalisePromotion),
        };
      });
      return c.json(out);
    } catch (e) { return fail(c, e); }
  });

  /* ─── PERFORMANCE (الأداء) ───────────────────────────────────────────
     Current window and the equally-long window immediately before it, each
     fetched independently. `unavailable` names the metric codes Keeta refused
     so a blank tile is explainable instead of mysterious.                   */
  app.get("/api/keeta/performance", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to, days, prevFrom, prevTo } = range(c);
    try {
      const out = await cached(`perf:${from}:${to}`, async () => {
        const codes = {
          profit: CHART.businessProfit,
          marketing: CHART.marketing,
          customers: CHART.customers,
          funnel: CHART.funnelCard,
          conversion: CHART.conversion,
          commission: CHART.businessBreakdown,
        };
        const [cur, prev] = await Promise.all([
          chartSet(codes, from, to, prevFrom, prevTo),
          // Shift both windows back by `days` so "previous" is measured the
          // same way the current one is, not read off a popValue we cannot
          // trust (most codes return null there).
          chartSet(codes, prevFrom, prevTo,
            new Date(Date.parse(prevFrom) - days * 86400000).toISOString().slice(0, 10), prevFrom),
        ]);

        const shape = (set) => {
          const mk = set.marketing.ok ? seriesMap(set.marketing.data) : {};
          const cu = set.customers.ok ? seriesMap(set.customers.data) : {};
          const pf = set.profit.ok ? seriesMap(set.profit.data) : {};
          const fn = set.funnel.ok ? seriesMap(set.funnel.data) : {};
          const cv = set.conversion.ok ? seriesMap(set.conversion.data) : {};
          const cm = set.commission.ok ? seriesMap(set.commission.data) : {};
          const allCustomers = mv(cu, "shop_merchant_txn_user_num");
          const newCustomers = mv(cu, "shop_merchant_new_user_num");
          const repeatCustomers = mv(cu, "shop_merchant_regular_user_num");
          return {
            revenue: {
              estimated: mv(mk, "shop_income_no_low_price"),        // الإيرادات المقدرة
              promoAttributed: mv(mk, "shop_marketing_income"),      // مبيعات ترويج الصنف
              promoShare: mv(mk, "shop_marketing_income_ratio"),
              shippingFee: mv(mk, "shop_shipping_fee"),
              netIncome: mv(pf, "shop_profit_general"),              // صافي الدخل
            },
            promo: {
              merchantSpend: mv(mk, "shop_shop_activity_subsidy_amt"),   // نفقات ترويج التاجر
              platformSpend: mv(mk, "shop_platform_activity_subsidy_amt"),
              perOrder: mv(mk, "shop_ordavg_act_subsidy"),
              intensity: mv(mk, "shop_act_intensity_no_low"),            // مستوى الخصم
              roi: mv(mk, "shop_roi"),
              promoOrders: mv(mk, "shop_marketing_order_num"),
              validOrders: mv(mk, "shop_valid_order_num"),
              promoOrderShare: mv(mk, "shop_marketing_order_num_ratio"),
            },
            // العمولة المقدرة — only lives on business_analysis_column_chart,
            // which Keeta's own backend is currently failing. null, not 0.
            commission: mv(cm, "shop_commission") ?? mv(cm, "shop_commission_general") ?? null,
            customers: {
              all: allCustomers,
              new: newCustomers,
              repeat: repeatCustomers,
              repeatShare: ratio(repeatCustomers, allCustomers),
            },
            funnel: {
              impressions: mv(fn, "shop_expose_user_num") ?? mv(cv, "shop_expose_user_num"),
              visitors: mv(cv, "shop_entry_user_num"),
              cartCustomers: mv(cv, "shop_cartadd_user_num"),
              checkoutCustomers: mv(cv, "shop_submit_user_num"),
              orderCustomers: mv(fn, "shop_order_user_num"),
              visitToCart: mv(fn, "shop_entry_cartadd_cvr") ?? mv(cv, "shop_entry_cartadd_cvr") ?? mv(mk, "shop_entry_cartadd_cvr"),
              cartToCheckout: mv(mk, "shop_cartadd_submit_cvr"),
              checkoutToPlaced: mv(mk, "shop_submit_pay_cvr"),
              visitToOrder: mv(mk, "shop_entry_pay_cvr"),
              impressionToVisit: mv(fn, "shop_expose_entry_cvr"),
              impressionToOrder: mv(fn, "shop_expose_order_user_ratio"),
            },
          };
        };

        const unavailable = Object.values(cur)
          .filter((v) => !v.ok)
          .map((v) => ({ code: v.code, error: v.error }));

        return {
          ok: true,
          period: { from, to, days },
          previousPeriod: { from: prevFrom, to: prevTo },
          current: shape(cur),
          previous: shape(prev),
          unavailable,
        };
      });
      return c.json(out);
    } catch (e) { return fail(c, e); }
  });

  /* ─── MENU ───────────────────────────────────────────────────────────
     /api/sailorProduct/* is the menu micro-frontend's own API (NOT the
     marketing promotion/spu endpoints, which want a promo context and reject
     a bare shopId with "المعلمة غير صحيحة").                                */
  app.get("/api/keeta/menu", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    try {
      const out = await cached("menu", async () => {
        const cats = await keetaCall("/api/sailorProduct/shopCategory/r/listShopCategory", {
          shopId: Number(SHOP_ID),
        });
        const categoryNames = new Map((cats || []).map((x) => [x.id, x.name]));
        // listSpu IGNORES pageNum — it answers with the whole menu every time.
        // So dedupe by spu id and stop the moment a page adds nothing new,
        // otherwise you "paginate" the same 76 items into 1,520 rows.
        const seen = new Map();
        for (let page = 1; page <= 20; page++) {
          const d = await keetaCall("/api/sailorProduct/spu/r/listSpu", {
            shopId: Number(SHOP_ID), pageNum: page, pageSize: 200,
          });
          const list = d?.spuList || [];
          const before = seen.size;
          for (const s of list) if (s?.id != null && !seen.has(s.id)) seen.set(s.id, s);
          if (!list.length || seen.size === before) break;
        }
        const items = [...seen.values()];
        const normalised = items.map((s) => normaliseMenuItem(s, categoryNames));
        return {
          ok: true,
          categories: (cats || []).map((x) => ({ id: x.id, name: x.name, itemCount: x.spuCount })),
          itemCount: normalised.length,
          unavailableCount: normalised.filter((i) => !i.available).length,
          discountedCount: normalised.filter((i) => i.discount).length,
          items: normalised,
        };
      });
      return c.json(out);
    } catch (e) { return fail(c, e); }
  });

  /* ─── SERVICE / SLA (الخدمات) ────────────────────────────────────────
     Downtime, valid operating hours, avoidable cancellations and unaccepted
     orders — each with the SAR the shop lost. This is the block that quietly
     costs money and that nobody in the store ever looks at.                 */
  app.get("/api/keeta/service", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const { from, to, prevFrom, prevTo } = range(c);
    try {
      const out = await cached(`svc:${from}:${to}`, async () => {
        const set = await chartSet({
          hours: CHART.svcHours,
          cancel: CHART.svcCancel,
          guide: CHART.svcGuide,
          prep: CHART.svcPrep,
        }, from, to, prevFrom, prevTo);
        const h = set.hours.ok ? seriesMap(set.hours.data) : {};
        const x = set.cancel.ok ? seriesMap(set.cancel.data) : {};
        const g = set.guide.ok ? seriesMap(set.guide.data) : {};
        const p = set.prep.ok ? seriesMap(set.prep.data) : {};
        return {
          ok: true,
          period: { from, to },
          hours: {
            dailyDowntime: mv(h, "shop_avg_closing_duration"),          // فترة التوقف اليومية (h)
            validOperatingHours: mv(h, "shop_daily_average_opening_duration"),
            closedByShop: mv(h, "shop_avg_manual_closing_duration"),
            closedByKeeta: mv(h, "shop_avg_platform_closing_duration"),
            closedOther: mv(h, "shop_avg_exception_closing_duration"),
            downtimeRate: mv(g, "shop_closing_duration_rate"),
            peerAverageHours: mv(g, "shop_daily_average_opening_duration_sametype"),
          },
          cancellations: {
            avoidable: mv(x, "shop_avoidable_cancel_order_num"),
            avoidableLoss: mv(x, "shop_avoidable_cancel_order_loss"),
            unaccepted: mv(x, "shop_missed_order_num"),
            unacceptedLoss: mv(x, "shop_missed_order_loss"),
            cancelledAfterAccept: mv(x, "shop_active_cancel_order_num"),
            cancelledAfterAcceptLoss: mv(x, "shop_active_cancel_order_loss"),
            rejected: mv(g, "shop_reject_order_num"),
            timedOut: mv(g, "shop_timeout_missed_order_num"),
          },
          prep: {
            avgCookingMinutes: mv(p, "shop_average_cooking_duration"),
            readyReportRate: mv(g, "shop_readied_report_rate"),
          },
          unavailable: Object.values(set).filter((v) => !v.ok).map((v) => ({ code: v.code, error: v.error })),
        };
      });
      return c.json(out);
    } catch (e) { return fail(c, e); }
  });

  /* ═════════════════════════════════════════════════════════════════════
     WRITE ROUTES — all fenced behind KEETA_ALLOW_WRITE=1
     ═════════════════════════════════════════════════════════════════════ */

  // Store open / busy / closed. Three different endpoints, one for each state,
  // because Keeta models "busy" on the order service and open/rest on SCM.
  const STORE_STATE = {
    open:   { url: "/api/scm/shop/status/set-open",   body: () => ({ shopId: Number(SHOP_ID) }) },
    closed: { url: "/api/scm/shop/status/set-rest",   body: () => ({ shopId: Number(SHOP_ID) }) },
    busy:   { url: "/api/order/setShopPauseStatus",   body: () => ({ shopId: Number(SHOP_ID), pauseStatus: 1 }) },
  };

  app.post("/api/keeta/store/state", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const state = String(b.state || "").toLowerCase();
    const target = STORE_STATE[state];
    if (!target) return c.json({ ok: false, error: "state لازم تكون open أو busy أو closed" }, 400);

    const body = target.body();
    const blocked = guardWrite(target.url, "POST", body);
    if (blocked) return c.json({ ok: true, state, ...blocked });
    try {
      const data = await keetaCall(target.url, body);
      _cache.delete("status");
      return c.json({ ok: true, applied: true, state, data });
    } catch (e) { return fail(c, e); }
  });

  // Extend prep time (يبقى المطعم يحضّر) — minutes the kitchen needs beyond
  // the default before Keeta starts chasing the order.
  app.post("/api/keeta/prep-time", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const minutes = Number(b.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120) {
      return c.json({ ok: false, error: "minutes لازم تكون رقم بين 0 و 120" }, 400);
    }
    const url = "/api/order/setKeepPreparing";
    const body = { shopId: Number(SHOP_ID), keepPreparingTime: minutes };
    const blocked = guardWrite(url, "POST", body);
    if (blocked) return c.json({ ok: true, minutes, ...blocked });
    try {
      return c.json({ ok: true, applied: true, minutes, data: await keetaCall(url, body) });
    } catch (e) { return fail(c, e); }
  });

  // Pause / resume the CPC campaign.
  app.post("/api/keeta/ads/state", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const state = String(b.state || "").toUpperCase();
    if (state !== "ACTIVE" && state !== "PAUSED") {
      return c.json({ ok: false, error: "state لازم تكون ACTIVE أو PAUSED" }, 400);
    }
    const url = "/api/bff/ad/poi/v1/sspcpc/plan/update/status";
    const body = {
      targetAcctId: ACCT_ID,
      shopId: Number(SHOP_ID),
      planId: b.planId ?? null,
      status: state === "ACTIVE" ? 0 : 1,     // mirrors plan/query's `status`
    };
    const blocked = guardWrite(url, "POST", body);
    if (blocked) return c.json({ ok: true, state, ...blocked });
    try {
      const data = await keetaCall(url, body);
      for (const k of _cache.keys()) if (k.startsWith("ads:")) _cache.delete(k);
      return c.json({ ok: true, applied: true, state, data });
    } catch (e) { return fail(c, e); }
  });

  // Change the campaign budget. Two independent fences: the write flag AND a
  // SAR ceiling, because this is the one lever that can burn money fast.
  app.post("/api/keeta/ads/budget", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const b = await c.req.json().catch(() => ({}));
    const budget = Number(b.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      return c.json({ ok: false, error: "budget لازم يكون رقم أكبر من صفر" }, 400);
    }
    const url = "/api/bff/ad/poi/v1/sspcpc/operation/update";
    // The BFF speaks minor units — 2,000.00 SAR is 200000 on the wire.
    const body = {
      targetAcctId: ACCT_ID,
      shopId: Number(SHOP_ID),
      planId: b.planId ?? null,
      budget: Math.round(budget * 100),
    };
    const overCap = budget > MAX_AD_BUDGET
      ? `الميزانية ${budget} ر.س تتجاوز الحد المسموح ${MAX_AD_BUDGET} ر.س (KEETA_MAX_AD_BUDGET)`
      : null;
    const blocked = guardWrite(url, "POST", body, overCap);
    if (blocked) return c.json({ ok: true, budget, cap: MAX_AD_BUDGET, ...blocked });
    try {
      const data = await keetaCall(url, body);
      for (const k of _cache.keys()) if (k.startsWith("ads:")) _cache.delete(k);
      return c.json({ ok: true, applied: true, budget, data });
    } catch (e) { return fail(c, e); }
  });

  // End a running promotion (إنهاء). Irreversible on Keeta's side — there is
  // no "un-end", the shop would have to recreate the activity.
  app.post("/api/keeta/promotion/:id/end", async (c) => {
    const err = await requireAdmin(c); if (err) return err;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.json({ ok: false, error: "معرّف العرض غير صحيح" }, 400);
    const url = "/api/marketing/promotion/common/offline-act";
    const body = { shopId: Number(SHOP_ID), actId: id, configChannel: "shopPc" };
    const blocked = guardWrite(url, "POST", body);
    if (blocked) return c.json({ ok: true, id, ...blocked });
    try {
      const data = await keetaCall(url, body);
      for (const k of _cache.keys()) if (k.startsWith("promos:")) _cache.delete(k);
      return c.json({ ok: true, applied: true, id, data });
    } catch (e) { return fail(c, e); }
  });

  console.log(
    `[keeta] routes ready (shop ${SHOP_ID || "—"}, ` +
    `${configured() ? "configured" : "NOT CONFIGURED: " + missingEnv().join(",")}, ` +
    `writes ${ALLOW_WRITE ? "ARMED" : "locked"})`
  );

  // Unused-but-real helpers from ctx, kept destructured for the next endpoint
  // that needs them (todayISO is the natural default for a "today" range).
  void todayISO;
}

export { keetaCall, KeetaError, num, pct, ratio, normaliseAdTotals, normalisePromotion, normaliseMenuItem, configured };
